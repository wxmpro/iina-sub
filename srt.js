const { file, utils, console } = iina;

/**
 * SubRip (SRT) utilities: parsing, formatting and fingerprinting.
 *
 * Timestamps are kept as integer milliseconds internally so that merging
 * chunks never accumulates floating point drift.
 */

/**
 * Parse a timestamp of the form "00:00:01,234" or "00:00:01.234" into ms.
 * Returns -1 when the input cannot be parsed.
 */
function parseTimestamp(text) {
  const m = String(text).trim().match(/^(\d+):(\d{2}):(\d{2})[,.](\d{1,3})$/);
  if (!m) return -1;
  const [, h, mm, ss, ms] = m;
  return (
    Number(h) * 3600000 +
    Number(mm) * 60000 +
    Number(ss) * 1000 +
    Number(ms.padEnd(3, "0"))
  );
}

/**
 * Format milliseconds as a SubRip timestamp: "00:00:01,234".
 */
function formatTimestamp(ms) {
  if (!isFinite(ms) || ms < 0) ms = 0;
  const total = Math.round(ms);
  const h = Math.floor(total / 3600000);
  const m = Math.floor((total % 3600000) / 60000);
  const s = Math.floor((total % 60000) / 1000);
  const milli = total % 1000;
  const p = (n, w) => String(n).padStart(w, "0");
  return `${p(h, 2)}:${p(m, 2)}:${p(s, 2)},${p(milli, 3)}`;
}

/**
 * Parse an SRT document into an array of cues.
 * Each cue is { start: ms, end: ms, text: string }.
 * Malformed blocks are skipped rather than aborting the whole file.
 */
function parseSrt(content) {
  const cues = [];
  if (!content) return cues;
  const blocks = String(content).replace(/\r\n/g, "\n").split(/\n\s*\n/);
  for (const block of blocks) {
    const lines = block.split("\n").map((l) => l.trim()).filter((l) => l.length > 0);
    if (lines.length < 2) continue;
    // Find the timing line; the index line is optional.
    let timingIndex = -1;
    for (let i = 0; i < lines.length; i++) {
      if (lines[i].includes("-->")) {
        timingIndex = i;
        break;
      }
    }
    if (timingIndex === -1) continue;
    const parts = lines[timingIndex].split("-->");
    if (parts.length !== 2) continue;
    const start = parseTimestamp(parts[0]);
    const end = parseTimestamp(parts[1]);
    if (start < 0 || end < 0) continue;
    const text = lines.slice(timingIndex + 1).join("\n").trim();
    if (!text) continue;
    cues.push({ start, end, text });
  }
  return cues;
}

/**
 * Render cues back into a SubRip document.
 * Cues are sorted by start time and de-overlapped so that the result is
 * always playable: no cue may start before the previous one ends.
 */
function renderSrt(cues) {
  const sorted = cues
    .filter((c) => c && c.text && c.end > c.start)
    .slice()
    .sort((a, b) => a.start - b.start || a.end - b.end);
  const out = [];
  let previousEnd = 0;
  sorted.forEach((c) => {
    let start = Math.max(c.start, previousEnd);
    let end = Math.max(c.end, start + 200);
    previousEnd = end;
    out.push(
      `${out.length + 1}\n${formatTimestamp(start)} --> ${formatTimestamp(end)}\n${c.text}`
    );
  });
  return out.join("\n\n") + (out.length ? "\n" : "");
}

/**
 * Merge cue lists, dropping duplicates and resolving overlaps.
 * `offset` shifts every cue of `cues` by the given amount of milliseconds.
 */
function mergeCues(target, incoming, offset) {
  for (const cue of incoming) {
    target.push({
      start: cue.start + offset,
      end: cue.end + offset,
      text: cue.text,
    });
  }
  target.sort((a, b) => a.start - b.start || a.end - b.end);
  return target;
}

/**
 * A small, dependency free 64 bit FNV-1a hash rendered as hex.
 * Good enough for cache invalidation and stable across runs.
 */
function fnv1a(text) {
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    h1 ^= c;
    h1 = Math.imul(h1, 0x01000193) >>> 0;
    h2 ^= (c + i) & 0xff;
    h2 = Math.imul(h2, 0x85ebca6b) >>> 0;
  }
  return (h1 >>> 0).toString(16).padStart(8, "0") + (h2 >>> 0).toString(16).padStart(8, "0");
}

/**
 * Compute a stable fingerprint for a media file + model + language.
 *
 * The fingerprint invalidates the cache when any of these change:
 *  - the media file itself (size or modification time)
 *  - the model file (size or modification time)
 *  - the transcription language
 *  - the whisper binary (size or modification time)
 */
function fingerprint(parts) {
  const joined = parts
    .map((p) => (p === undefined || p === null ? "" : String(p)))
    .join(" ");
  return fnv1a(joined);
}

/**
 * Read size and modification time of a file using `stat`.
 * Returns null when the file cannot be inspected.
 */
async function statOf(path) {
  if (!path || !file.exists(path)) return null;
  try {
    const res = await utils.exec("/usr/bin/stat", ["-f", "%z|%m", path]);
    if (res.status !== 0 || !res.stdout) return null;
    const [size, mtime] = res.stdout.trim().split("|");
    return { size: Number(size), mtime: Number(mtime) };
  } catch (e) {
    console.warn("iina-sub: stat failed for " + path + ": " + e);
    return null;
  }
}

/**
 * Create a directory if it is not there yet.
 *
 * The plugin writes into several sub folders of its own data directory and
 * the file API of the player does not create them on its own.
 */
async function ensureDir(path) {
  if (!path) return false;
  try {
    const res = await utils.exec("/bin/mkdir", ["-p", path]);
    return res.status === 0;
  } catch (e) {
    console.warn("iina-sub: could not create the folder " + path + ": " + e);
    return false;
  }
}

/**
 * The subtitle file that belongs to a media file.
 *
 * The transcript is written next to the video and carries the same name with
 * a `.srt` extension, which is the convention every player understands. IINA
 * picks such a file up on its own the next time the video is opened.
 */
function subtitlePathFor(mediaPath) {
  if (!mediaPath) return null;
  if (mediaPath.indexOf("://") !== -1) return null;
  const lastDot = mediaPath.lastIndexOf(".");
  const base = lastDot !== -1 ? mediaPath.substring(0, lastDot) : mediaPath;
  // The transcript always stays in the folder of the video.
  const directory = mediaPath.substring(0, mediaPath.lastIndexOf("/"));
  const result = base + ".srt";
  if (result.substring(0, result.lastIndexOf("/")) !== directory) return null;
  return result;
}

/**
 * Where the transcript is kept while the plugin is working with it.
 *
 * It lives in the plugin folder. The folder of the video stays untouched
 * until the transcript is explicitly exported.
 */
function internalSubtitlePathFor(mediaPath) {
  if (!mediaPath) return null;
  // Only the hash is used, so a file name can never influence the path.
  const key = fnv1a(mediaPath);
  return utils.resolvePath("@data/subtitles/" + key + ".srt");
}

/**
 * The place where the fingerprint of a transcript is kept.
 *
 * It lives in the plugin folder so that the folder of the video only ever
 * contains the subtitle file itself.
 */
function stampPathFor(mediaPath) {
  if (!mediaPath) return null;
  const key = fnv1a(mediaPath);
  return utils.resolvePath("@data/fingerprints/" + key + ".fp");
}

module.exports = {
  parseTimestamp,
  formatTimestamp,
  parseSrt,
  renderSrt,
  mergeCues,
  fingerprint,
  fnv1a,
  statOf,
  ensureDir,
  subtitlePathFor,
  internalSubtitlePathFor,
  stampPathFor,
};

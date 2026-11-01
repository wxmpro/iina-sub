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
 * The text of a cue without the marks that carry no meaning.
 *
 * Two recognitions of the same words differ in their punctuation and their
 * spaces, and that is all.
 */
function plainText(text) {
  return String(text || "")
    .replace(/[\s\u3000]+/g, "")
    .replace(/[，。！？；：、,.!?;:~"'""''（）()《》【】\[\]…—\-]/g, "");
}

/**
 * Merge cue lists, dropping the repetitions that the overlap at the end of a
 * chunk brings along.
 *
 * `offset` shifts every cue of `cues` by the given amount of milliseconds.
 *
 * The last part of a chunk is heard twice: once by the chunk itself and once
 * by the chunk that follows it. The second time the words are the same, and
 * they would show up twice on the screen. A cue whose words are the tail of
 * the words of the cue before it is therefore left out.
 */
function mergeCues(target, incoming, offset) {
  for (const cue of incoming) {
    const text = String(cue.text || "");
    const plain = plainText(text);
    const previous = target.length > 0 ? target[target.length - 1] : null;
    if (previous && plain) {
      const before = plainText(previous.text);
      const repeated =
        plain === before ||
        (plain.length >= 2 &&
          before.length >= plain.length &&
          before.endsWith(plain)) ||
        (before.length >= 2 &&
          plain.length >= before.length &&
          plain.endsWith(before));
      if (repeated && cue.start + offset - previous.start < 3000) {
        continue;
      }
    }
    target.push({
      start: cue.start + offset,
      end: cue.end + offset,
      text: text,
    });
  }
  target.sort((a, b) => a.start - b.start || a.end - b.end);
  return target;
}

/**
 * The constants of the SHA-256 algorithm.
 *
 * They are the first thirty two bits of the fractional parts of the cube
 * roots of the first sixty four primes.
 */
const SHA256_K = [
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
];

/**
 * The text of a string as bytes of UTF-8.
 *
 * The player has no TextEncoder, so the bytes are made by hand. A pair of
 * surrogates is one character of four bytes, a lone one is written as it is.
 */
function utf8Bytes(text) {
  const out = [];
  for (let i = 0; i < text.length; i++) {
    let code = text.charCodeAt(i);
    if (code >= 0xd800 && code <= 0xdbff && i + 1 < text.length) {
      const next = text.charCodeAt(i + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        code = 0x10000 + ((code - 0xd800) << 10) + (next - 0xdc00);
        i++;
      }
    }
    if (code < 0x80) {
      out.push(code);
    } else if (code < 0x800) {
      out.push(0xc0 | (code >> 6), 0x80 | (code & 0x3f));
    } else if (code < 0x10000) {
      out.push(0xe0 | (code >> 12), 0x80 | ((code >> 6) & 0x3f), 0x80 | (code & 0x3f));
    } else {
      out.push(
        0xf0 | (code >> 18),
        0x80 | ((code >> 12) & 0x3f),
        0x80 | ((code >> 6) & 0x3f),
        0x80 | (code & 0x3f)
      );
    }
  }
  return out;
}

/**
 * The SHA-256 sum of a text, as a string of sixty four hex digits.
 *
 * The player has no cryptography of its own, so the algorithm is written
 * out here. It is used for every name that stands for a file of the user,
 * so that a name can never be forged into the name of another file.
 */
function sha256(text) {
  const bytes = utf8Bytes(String(text));
  const length = bytes.length;

  // The message is padded: a single one bit, then zeroes, then the length
  // of the message as a number of bits.
  const blocks = Math.floor((length + 8) / 64) + 1;
  const total = blocks * 64;
  const message = new Uint8Array(total);
  for (let i = 0; i < length; i++) message[i] = bytes[i];
  message[length] = 0x80;

  const high = Math.floor(length / 0x20000000);
  const low = (length * 8) >>> 0;
  message[total - 8] = (high >>> 24) & 0xff;
  message[total - 7] = (high >>> 16) & 0xff;
  message[total - 6] = (high >>> 8) & 0xff;
  message[total - 5] = high & 0xff;
  message[total - 4] = (low >>> 24) & 0xff;
  message[total - 3] = (low >>> 16) & 0xff;
  message[total - 2] = (low >>> 8) & 0xff;
  message[total - 1] = low & 0xff;

  let h0 = 0x6a09e667;
  let h1 = 0xbb67ae85;
  let h2 = 0x3c6ef372;
  let h3 = 0xa54ff53a;
  let h4 = 0x510e527f;
  let h5 = 0x9b05688c;
  let h6 = 0x1f83d9ab;
  let h7 = 0x5be0cd19;

  const w = new Uint32Array(64);
  const rotr = (value, bits) => (value >>> bits) | (value << (32 - bits));

  for (let offset = 0; offset < total; offset += 64) {
    for (let t = 0; t < 16; t++) {
      const i = offset + t * 4;
      w[t] =
        (message[i] << 24) | (message[i + 1] << 16) | (message[i + 2] << 8) | message[i + 3];
    }
    for (let t = 16; t < 64; t++) {
      const x = w[t - 15];
      const y = w[t - 2];
      const s0 = rotr(x, 7) ^ rotr(x, 18) ^ (x >>> 3);
      const s1 = rotr(y, 17) ^ rotr(y, 19) ^ (y >>> 10);
      w[t] = (w[t - 16] + s0 + w[t - 7] + s1) | 0;
    }

    let a = h0;
    let b = h1;
    let c = h2;
    let d = h3;
    let e = h4;
    let f = h5;
    let g = h6;
    let h = h7;

    for (let t = 0; t < 64; t++) {
      const s1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25);
      const ch = (e & f) ^ (~e & g);
      const temp1 = (h + s1 + ch + SHA256_K[t] + w[t]) | 0;
      const s0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22);
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) | 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) | 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) | 0;
    }

    h0 = (h0 + a) | 0;
    h1 = (h1 + b) | 0;
    h2 = (h2 + c) | 0;
    h3 = (h3 + d) | 0;
    h4 = (h4 + e) | 0;
    h5 = (h5 + f) | 0;
    h6 = (h6 + g) | 0;
    h7 = (h7 + h) | 0;
  }

  const hex = (value) => (value >>> 0).toString(16).padStart(8, "0");
  return hex(h0) + hex(h1) + hex(h2) + hex(h3) + hex(h4) + hex(h5) + hex(h6) + hex(h7);
}

/**
 * The version of the transcription logic.
 *
 * It is part of the fingerprint, so a change in the way the plugin cuts and
 * merges the audio invalidates the transcripts that were produced by the
 * older logic.
 */
const TRANSCRIPT_VERSION = "2";

/**
 * Compute a stable fingerprint for a media file + model + language.
 *
 * The fingerprint invalidates the cache when any of these change:
 *  - the media file itself (size, modification time and number)
 *  - the model file (size or modification time)
 *  - the transcription language
 *  - the whisper binary (size or modification time)
 */
function fingerprint(parts) {
  // The parts are joined with a mark that cannot appear in a path, so that
  // two different sets of parts can never lead to the same fingerprint.
  const joined = parts
    .map((p) => (p === undefined || p === null ? "" : String(p)))
    .join("\u0000");
  return sha256(joined);
}

/**
 * Read size and modification time of a file using `stat`.
 * Returns null when the file cannot be inspected.
 */
async function statOf(path) {
  if (!path || !file.exists(path)) return null;
  try {
    // The number of the file is read as well. A file that is replaced by
    // another one of the same size and the same time of change gets another
    // number, so the cache of the old file is not taken for the new one.
    // The name of the file may be one the user wrote, so the list of
    // options is closed before the name is given. A file whose name starts
    // with a dash is then a file and not an option.
    const res = await utils.exec("/usr/bin/stat", ["-f", "%z|%m|%i", "--", path]);
    if (res.status !== 0 || !res.stdout) return null;
    const [size, mtime, inode] = res.stdout.trim().split("|");
    return { size: Number(size), mtime: Number(mtime), inode: String(inode || "") };
  } catch (e) {
    console.warn("iina-sub: stat failed for " + path + ": " + e);
    return null;
  }
}

/**
 * The kind of a file: "regular file", "directory", "symbolic link", or an
 * empty string when the file cannot be inspected.
 *
 * A link is reported as a link and not as the thing it points at, so a link
 * that pretends to be a folder is recognised as a link.
 */
async function fileTypeOf(path) {
  if (!path) return "";
  try {
    const res = await utils.exec("/usr/bin/stat", ["-f", "%HT", "--", path]);
    if (res.status !== 0 || !res.stdout) return "";
    return String(res.stdout).trim().toLowerCase();
  } catch (e) {
    return "";
  }
}

/**
 * The SHA-256 sum of a file, in lower case.
 *
 * An empty string when the file cannot be read.
 */
async function sha256OfFile(path) {
  if (!path) return "";
  try {
    const res = await utils.exec("/usr/bin/shasum", ["-a", "256", "--", path]);
    if (res.status !== 0) return "";
    const digest = String(res.stdout || "").trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/i.test(digest) ? digest.toLowerCase() : "";
  } catch (e) {
    return "";
  }
}

/**
 * The permission bits of a file, as three octal digits ("644").
 *
 * Only the bits that decide who may read, write and look at the file are
 * kept. The set user id and the sticky bit are of no use for a subtitle
 * file, and the file is never made executable.
 *
 * An empty string when the file cannot be inspected.
 */
async function permissionBitsOf(path) {
  if (!path) return "";
  try {
    const res = await utils.exec("/usr/bin/stat", ["-f", "%Lp", "--", path]);
    if (res.status !== 0 || !res.stdout) return "";
    const bits = String(res.stdout).trim();
    if (!/^[0-7]{3,4}$/.test(bits)) return "";
    const value = parseInt(bits.slice(-3), 8) & 0o666;
    return value.toString(8).padStart(3, "0");
  } catch (e) {
    return "";
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
 * The fingerprint of the transcript of a media file.
 *
 * It covers everything that can change the result: the file, the model, the
 * engine, the language, the way the file is cut into chunks, the decoder and
 * the audio track that is used. When any of them changes, the transcript that
 * is on disk is not the one the settings ask for any more.
 */
async function transcriptFingerprint(mediaPath, config, decoderHash, audioTrackIndex) {
  const [mediaStat, modelStat, engineStat] = await Promise.all([
    statOf(mediaPath),
    statOf(config.modelPath),
    statOf(config.enginePath || config.whisperPath),
  ]);
  return fingerprint([
    TRANSCRIPT_VERSION,
    decoderHash || "",
    mediaPath,
    mediaStat ? mediaStat.size : "",
    mediaStat ? mediaStat.mtime : "",
    mediaStat ? mediaStat.inode : "",
    config.modelPath,
    modelStat ? modelStat.size : "",
    modelStat ? modelStat.mtime : "",
    config.engineId,
    config.enginePath || config.whisperPath,
    engineStat ? engineStat.size : "",
    engineStat ? engineStat.mtime : "",
    config.language,
    config.chunkSeconds,
    config.tailSeconds,
    typeof audioTrackIndex === "number" && audioTrackIndex >= 0
      ? String(audioTrackIndex)
      : "0",
  ]);
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

  // Only the name of the file is looked at. A dot in the name of the folder
  // has nothing to do with the name of the file, and a file without an
  // extension still gets a subtitle file.
  const slash = mediaPath.lastIndexOf("/");
  const directory = slash > 0 ? mediaPath.substring(0, slash) : "/";
  const name = mediaPath.substring(slash + 1);
  const dot = name.lastIndexOf(".");
  const base = dot > 0 ? mediaPath.substring(0, slash + 1 + dot) : mediaPath;

  // The transcript always stays in the folder of the video.
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
  const key = sha256(mediaPath).slice(0, 32);
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
  const key = sha256(mediaPath).slice(0, 32);
  return utils.resolvePath("@data/fingerprints/" + key + ".fp");
}

module.exports = {
  TRANSCRIPT_VERSION,
  transcriptFingerprint,
  parseTimestamp,
  formatTimestamp,
  parseSrt,
  renderSrt,
  mergeCues,
  plainText,
  fingerprint,
  sha256,
  utf8Bytes,
  statOf,
  fileTypeOf,
  permissionBitsOf,
  sha256OfFile,
  ensureDir,
  subtitlePathFor,
  internalSubtitlePathFor,
  stampPathFor,
};

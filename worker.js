const { utils, file, console } = iina;

const srt = require("./srt.js");
const decoder = require("./decoder.js");

/**
 * Chunked transcription worker.
 *
 * The video is transcribed in fixed length chunks. Each chunk is decoded and
 * recognised on its own, and the cues are merged into a growing list.
 *
 * Chunking buys two things:
 *  - subtitles appear while the video is still playing instead of only after
 *    the whole file has been transcribed;
 *  - a failed chunk only costs that chunk, not the whole run.
 *
 * A small tail of extra audio is decoded after every chunk so the model hears
 * the end of a sentence instead of a hard cut. Cues that begin inside that
 * tail are dropped, because the following chunk produces them properly.
 */

/**
 * The path the engine writes its raw SubRip output to.
 *
 * It lives in the plugin folder, so the folder of the video only ever holds
 * the final subtitle file.
 *
 * The name carries no extension: every engine appends its own suffix, the
 * whisper.cpp engine for instance writes `<base>.srt`.
 *
 * The name of the media is not part of it. A hash of the path is used
 * instead, so two jobs can never write over each other and no file name of
 * the user can influence where a file is written.
 */
function chunkOutputBase(mediaPath, chunk) {
  const key = srt.sha256(mediaPath || "").slice(0, 32);
  // The start of the chunk names the file, not its number: the plan can be
  // cut again while a run is going on, and a name that followed the number
  // would then point at another piece of audio than before.
  return utils.resolvePath("@data/chunks/" + key + "-" + chunk.startMs);
}

/**
 * The directory the chunk files live in.
 */
function chunkDirectory() {
  return utils.resolvePath("@data/chunks");
}

/**
 * Remove the files that earlier runs left in the chunk folder.
 *
 * Only the plugin's own folder is touched. The files are named after a hash,
 * so nothing of the user is ever in the way.
 */
async function clearChunkDirectory() {
  const dir = chunkDirectory();
  if (!dir) return;
  let entries = [];
  try {
    entries = file.list(dir, {}) || [];
  } catch (e) {
    return;
  }
  for (const entry of entries) {
    if (!entry || entry.isDir) continue;
    try {
      file.delete(dir + "/" + entry.filename);
    } catch (e) {
      /* best effort */
    }
  }
}

/**
 * Transcribe a single chunk and return its cues, already shifted into the
 * timeline of the whole media file.
 *
 * `context` carries the pieces of the job that the worker needs:
 *   { config, mediaPath, audioStreamIndex }
 */
async function transcribeChunk(context, engine, chunk, onProgress) {
  const outBase = chunkOutputBase(context.mediaPath, chunk);
  chunk.outBase = outBase;

  // The engine writes its output with a plain file call, so the directory has
  // to exist before the run starts.
  await srt.ensureDir(chunkDirectory());

  const cues = await engine.run(context, chunk, onProgress);

  // The engine may have left a file behind. It is of no use to anyone.
  try {
    if (file.exists(outBase + ".srt")) file.delete(outBase + ".srt");
    if (file.exists(outBase + ".wav")) file.delete(outBase + ".wav");
  } catch (e) {
    /* best effort */
  }

  // Drop cues that only exist because of the tail overlap and clamp cues
  // that run past the chunk boundary. Without this the exported SRT would
  // contain overlapping cues.
  const chunkEndMs = chunk.startMs + chunk.lengthMs;
  const kept = [];
  for (const cue of cues) {
    const start = cue.start;
    if (start >= chunk.lengthMs) continue; // belongs to the tail
    const end = Math.min(cue.end, chunk.lengthMs);
    if (end <= start) continue;
    kept.push({
      start: chunk.startMs + start,
      end: chunk.startMs + end,
      text: cue.text,
    });
  }
  return kept;
}

/**
 * Plan the chunk boundaries for a media file of the given duration.
 *
 * `tailSeconds` is the overlap added to every chunk; it is not a chunk of
 * its own and never produces cues on its own.
 *
 * `firstChunkSeconds` shortens the first chunk, so that the first subtitles
 * appear within a few seconds of opening the file. The first subtitle cannot
 * appear before the first chunk is recognised, and every run of the
 * recognition program starts with loading the model again — a first chunk of
 * the full length would hold the first subtitles back for many seconds. The
 * chunks after the first keep the full length, so the accuracy of the rest is
 * not touched.
 */
function planChunks(durationMs, chunkSeconds, tailSeconds, firstChunkSeconds) {
  const lengthMs = chunkSeconds * 1000;
  const tailMs = tailSeconds * 1000;
  const firstMs =
    firstChunkSeconds && firstChunkSeconds > 0 && firstChunkSeconds < chunkSeconds
      ? firstChunkSeconds * 1000
      : lengthMs;
  const chunks = [];
  if (!durationMs || durationMs <= 0) return chunks;
  let index = 0;
  let start = 0;
  while (start < durationMs) {
    const len = index === 0 ? firstMs : lengthMs;
    const remaining = durationMs - start;
    chunks.push({
      index: index++,
      startMs: start,
      lengthMs: Math.min(len, remaining),
      durationMs: Math.min(len + tailMs, remaining),
    });
    start += len;
  }
  return chunks;
}

/**
 * Cut the chunk the playhead is in around the playhead.
 *
 * A viewer who drags to a place that has no transcript yet waits for the
 * chunk under the playhead, and a full-length chunk holds the first
 * subtitles back for many seconds. The chunk is cut in three — the part
 * before the playhead, a short piece that starts at the playhead, and the
 * part after it — so that the piece the picking logic chooses first is a
 * short one that holds the words the viewer is about to hear.
 *
 * The plan is cut again every time the picking logic is asked for a chunk,
 * so a drag in the middle of a run is treated the same as a resume at the
 * start. A chunk that is already transcribed is never cut: its pieces would
 * be new ones and would be transcribed again for nothing.
 *
 * The pieces cover the chunk exactly, so the transcript keeps its coverage,
 * and the boundaries of the plan are not part of the fingerprint, so a
 * cached transcript stays valid. The start of a chunk identifies it — not a
 * number — because the pieces of a cut get places of their own.
 *
 * Returns the plan when a cut was made, or the plan as it was.
 */
function splitChunkAtPlayhead(chunks, positionMs, firstChunkSeconds, tailSeconds, done) {
  if (!positionMs || positionMs <= 0 || !chunks || chunks.length === 0) return chunks;
  const firstMs = (firstChunkSeconds > 0 ? firstChunkSeconds : 30) * 1000;
  const tailMs = (tailSeconds || 0) * 1000;

  const at = chunks.findIndex(
    (c) => positionMs >= c.startMs && positionMs < c.startMs + c.lengthMs
  );
  if (at < 0) return chunks;

  const full = chunks[at];
  if (full.lengthMs <= firstMs) return chunks; // short already
  if (done && done.has(full.startMs)) return chunks; // transcribed already

  const offsetMs = positionMs - full.startMs;
  // The piece that holds the playhead is as long as the first chunk, except
  // when the chunk ends before that: it then reaches back towards the start
  // of the chunk, so that the piece keeps a length worth recognising. The
  // playhead always sits inside it.
  const chunkEndMs = full.startMs + full.lengthMs;
  const hereEndMs = Math.min(positionMs + firstMs, chunkEndMs);
  const hereStartMs = Math.max(
    full.startMs,
    Math.min(positionMs, hereEndMs - firstMs)
  );
  const pieces = [];
  if (hereStartMs > full.startMs) {
    pieces.push({ startMs: full.startMs, lengthMs: hereStartMs - full.startMs });
  }
  pieces.push({ startMs: hereStartMs, lengthMs: hereEndMs - hereStartMs });
  if (chunkEndMs > hereEndMs) {
    pieces.push({ startMs: hereEndMs, lengthMs: chunkEndMs - hereEndMs });
  }

  const plan = chunks.slice();
  plan.splice(
    at,
    1,
    ...pieces.map((p) => ({
      index: 0,
      startMs: p.startMs,
      lengthMs: p.lengthMs,
      durationMs: p.lengthMs + tailMs,
    }))
  );
  return plan;
}

/**
 * Ask macOS for the duration of a media file.
 *
 * The duration is read with `mdls`, the metadata tool macOS ships with, so
 * that no external program is needed. It only knows the files that the search
 * index of the system knows, so a file that is not indexed has no duration
 * here and the decoder is asked instead.
 */
async function probeDuration(mediaPath) {
  try {
    const res = await utils.exec("/usr/bin/mdls", [
      "-name",
      "kMDItemDurationSeconds",
      "-raw",
      "--",
      mediaPath,
    ]);
    if (res.status !== 0 || !res.stdout) return 0;
    const text = String(res.stdout).trim();
    // An unknown duration is reported as "(null)".
    if (!text || text === "(null)" || text.startsWith("(")) return 0;
    const seconds = parseFloat(text);
    return isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
  } catch (e) {
    console.warn("iina-sub: could not read the duration of " + mediaPath + ": " + e);
    return 0;
  }
}

/**
 * The length of a media file, from whichever source can tell it.
 *
 * The player knows it while the file is playing, the metadata tool knows it
 * for the files that the system has indexed, and the decoder knows it for
 * every file.
 */
async function durationOf(mediaPath, knownMs) {
  if (knownMs && knownMs > 0) return knownMs;
  const indexed = await probeDuration(mediaPath);
  if (indexed > 0) return indexed;
  return decoder.durationOf(mediaPath);
}

module.exports = {
  chunkOutputBase,
  chunkDirectory,
  clearChunkDirectory,
  transcribeChunk,
  planChunks,
  splitChunkAtPlayhead,
  probeDuration,
  durationOf,
};

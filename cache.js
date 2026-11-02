const { core, file, console } = iina;

const { effectiveTrackIndex } = require("./state.js");
const player = require("./player.js");
const ui = require("./ui.js");
const srt = require("./srt.js");
const decoder = require("./decoder.js");


/**
 * Build a fingerprint that covers everything which can invalidate a cached
 * transcript: the media file, the model, the engine binary and the language.
 *
 * The decoder is part of it as well: a new way of reading the audio gives a
 * different result, so an old transcript is not valid any more.
 */
async function buildFingerprint(mediaPath, settings, audioTrackIndex) {
  return srt.transcriptFingerprint(
    mediaPath,
    settings,
    srt.sha256(decoder.SWIFT_SOURCE || "").slice(0, 32),
    audioTrackIndex
  );
}

/**
 * Decide where the transcript of a media file is stored.
 *
 * The transcript always lives inside the plugin folder. The folder of the
 * video only ever receives a subtitle file, and only when the export command
 * is used.
 */
function resolveCachePaths(mediaPath) {
  const subtitle = srt.internalSubtitlePathFor(mediaPath);
  const stamp = srt.stampPathFor(mediaPath);
  if (!subtitle || !stamp) return null;
  return { subtitle, stamp };
}

/**
 * Look for a transcript that is still valid for a media file.
 *
 * Returns the paths of the cached transcript, or null when there is none or
 * when the one that is there was produced with different settings.
 */
async function findValidCache(mediaPath, settings, audioTrackIndex) {
  const paths = resolveCachePaths(mediaPath);
  if (!paths) return null;
  if (!file.exists(paths.subtitle)) return null;
  if (!file.exists(paths.stamp)) return null;

  let stamp = null;
  try {
    stamp = file.read(paths.stamp, {});
  } catch (e) {
    stamp = null;
  }
  if (!stamp) return null;

  const expected = await buildFingerprint(
    mediaPath,
    settings,
    effectiveTrackIndex(audioTrackIndex)
  );
  if (String(stamp).trim() !== expected) return null;
  return paths;
}

/**
 * Load the cached transcript for a media file when one exists and is current.
 * Returns true when a cached subtitle was loaded.
 */
async function loadCachedSubtitle(mediaPath, settings, audioTrackIndex) {
  const paths = await findValidCache(mediaPath, settings, audioTrackIndex);
  if (!paths) return false;

  if (player.loadSubtitle(paths.subtitle, [srt.subtitlePathFor(mediaPath)])) {
    ui.osd("loaded cached subtitles");
    ui.pushStatus({
      phase: "cached",
      message: "Cached subtitles loaded",
      detail: paths.subtitle,
      percent: 100,
    });
    return true;
  }
  return false;
}

module.exports = { buildFingerprint, resolveCachePaths, findValidCache, loadCachedSubtitle };

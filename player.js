const { mpv, file, console } = iina;

const { state } = require("./state.js");
const ui = require("./ui.js");


/**
 * Path of the media that is currently playing, or null for network streams.
 */
function currentMediaPath() {
  const path = mpv.getString("path");
  if (!path || path.length === 0) return null;
  if (path.indexOf("://") !== -1) return null;
  return path;
}

function currentDurationMs() {
  const seconds = Number(mpv.getNumber("duration"));
  return isFinite(seconds) && seconds > 0 ? Math.round(seconds * 1000) : 0;
}

/**
 * The position of the audio track the user is listening to.
 *
 * The number is the position of the track among the audio tracks of the
 * file, counted from zero. The decoder picks its track from the list of
 * audio tracks only, so the position has to be counted among those as well.
 *
 * The stream index of the player cannot be used directly: it counts every
 * stream of the file, so the first audio track of a file that also carries a
 * video track would be number one there and number zero here.
 */
function currentAudioTrackIndex() {
  try {
    const tracks = mpv.getNative("track-list") || [];
    let seen = 0;
    for (const track of tracks) {
      if (!track || track.type !== "audio") continue;
      if (track.selected) return seen;
      seen++;
    }
  } catch (e) {
    console.warn("iina-sub: could not read the track list: " + e);
  }
  return null;
}

/**
 * Find the subtitle track of the player that holds one of these files.
 *
 * The whole path is compared. The name of the file alone is not enough: two
 * folders can hold a file with the same name, and the track of the wrong one
 * would be used. As a second step a file that the player reports under
 * another name — because the folder is behind a link, for instance — is
 * recognised when it sits in the same folder as the video.
 *
 * Returns { path, id } or null.
 */
function findSubtitleTrack(path, alternatives) {
  const wanted = [path].concat(alternatives || []).filter((p) => !!p);
  if (wanted.length === 0) return null;

  let tracks = [];
  try {
    tracks = mpv.getNative("track-list") || [];
  } catch (e) {
    console.warn("iina-sub: could not read the track list: " + e);
    return null;
  }

  for (const track of tracks) {
    if (!track || track.type !== "sub") continue;
    const file = track["external-filename"];
    if (!file) continue;
    for (const candidate of wanted) {
      if (file === candidate) return { path: file, id: track.id };
    }
  }

  for (const track of tracks) {
    if (!track || track.type !== "sub") continue;
    const file = track["external-filename"];
    if (!file) continue;
    for (const candidate of wanted) {
      if (ui.baseName(file) !== ui.baseName(candidate)) continue;
      if (ui.directoryOf(file) !== ui.directoryOf(candidate)) continue;
      return { path: file, id: track.id };
    }
  }

  return null;
}

/**
 * Load a subtitle file as a native IINA subtitle track.
 *
 * The player picks up a subtitle file that sits next to the video on its
 * own. When that file holds the very same transcript, a second track would
 * only confuse, so it is used instead of adding one.
 */
function loadSubtitle(path, alternatives) {
  const existing = findSubtitleTrack(path, alternatives);
  if (existing) {
    // The player has it already.
    state.subtitlePath = existing.path;
    state.subtitleId = existing.id;
    return true;
  }

  try {
    mpv.command("sub-add", [path, "select"]);
  } catch (e) {
    console.error("iina-sub: could not load " + path + ": " + e);
    return false;
  }

  // The player does not report a command that failed, so the track list is
  // asked whether the file is really there now. When the list has not caught
  // up yet, the file is remembered anyway and the reload is left to the
  // plain command.
  const added = findSubtitleTrack(path);
  if (added) {
    state.subtitlePath = added.path;
    state.subtitleId = added.id;
  } else {
    state.subtitlePath = path;
    state.subtitleId = null;
  }
  return true;
}

/**
 * Reload the subtitle track after the file on disk changed.
 *
 * mpv implements `sub-reload` by unloading and re-adding an external subtitle
 * file, so the freshly written cues show up immediately. The track is named
 * by its number, because a reload without one refreshes the track that
 * happens to be selected, which is not always the one of the plugin.
 */
function reloadSubtitle() {
  if (!state.subtitlePath) return false;
  try {
    if (state.subtitleId !== null && state.subtitleId !== undefined) {
      mpv.command("sub-reload", [String(state.subtitleId)]);
    } else {
      mpv.command("sub-reload", []);
    }
    return true;
  } catch (e) {
    console.warn("iina-sub: sub-reload failed: " + e);
    return false;
  }
}

module.exports = { currentMediaPath, currentDurationMs, currentAudioTrackIndex, findSubtitleTrack, loadSubtitle, reloadSubtitle };

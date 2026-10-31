const { core, mpv, utils, file, menu, preferences, event, sidebar, console } = iina;

const srt = require("./srt.js");
const worker = require("./worker.js");
const engines = require("./engines.js");
const models = require("./models.js");
const decoder = require("./decoder.js");

/**
 * iina-sub — local AI subtitles for IINA.
 *
 * The plugin transcribes local media with a locally installed speech
 * recognition engine, keeps the result next to the video as a SubRip file and
 * loads it as a native IINA subtitle track.
 *
 * Design goals:
 *  - zero cloud dependency, everything runs on the machine;
 *  - the transcript is cached, so a second visit costs nothing;
 *  - subtitles appear while the file is still being transcribed;
 *  - the engine is pluggable, whisper.cpp is only the default.
 */

// ---------------------------------------------------------------------------
// State
// ---------------------------------------------------------------------------

const VIDEO_EXTENSIONS = [
  ".mp4", ".mkv", ".mov", ".avi", ".m4v", ".mpg", ".mpeg", ".ts", ".flv", ".webm",
  ".wmv", ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus",
];

/** The transcription that is currently running, if any. */
let activeJob = null;

/** Path of the subtitle file that is currently loaded into the player. */
let loadedSubtitlePath = null;

/** The number of that subtitle track, so that it can be reloaded by name. */
let loadedSubtitleId = null;

/** Queue of files for a batch run. */
let batchQueue = [];
let batchRunning = false;

/** Small log shown in the sidebar. */
const activityLog = [];

/**
 * Whether a transcription is running or about to run.
 */
function isBusy() {
  return activeJob !== null;
}

/**
 * The audio track a transcription uses, counted among the audio tracks.
 *
 * A track that cannot be told apart from the others is the first one, which
 * is what the decoder falls back to as well.
 */
function effectiveTrackIndex(raw) {
  return typeof raw === "number" && raw >= 0 ? raw : 0;
}

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/**
 * The places where Homebrew puts the whisper binary.
 *
 * The binary of an Apple Silicon machine is in the first one, the one of an
 * Intel machine in the second.
 */
const WHISPER_CANDIDATES = [
  "/opt/homebrew/bin/whisper-cli",
  "/usr/local/bin/whisper-cli",
  "/opt/homebrew/bin/whisper-cpp",
  "/usr/local/bin/whisper-cpp",
];

function readConfig() {
  // A number that is out of range is brought back into it, so that a value
  // that was typed by hand cannot make the plugin do something absurd.
  const num = (key, fallback, min, max) => {
    const value = Number(preferences.get(key));
    if (!isFinite(value)) return fallback;
    return Math.min(max, Math.max(min, value));
  };
  const bool = (key, fallback) => {
    const value = preferences.get(key);
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true" || value === "1";
  };

  const configured = String(preferences.get("whisperPath") || "").trim();
  let whisperPath = configured;
  if (!whisperPath) {
    // Nothing was chosen yet, so the place where the binary usually is
    // looked at.
    whisperPath =
      WHISPER_CANDIDATES.find((candidate) => utils.fileInPath(candidate)) ||
      WHISPER_CANDIDATES[0];
  }

  return {
    engineId: String(preferences.get("engineId") || "whisper-cpp"),
    enginePath: String(preferences.get("enginePath") || ""),
    whisperPath: whisperPath,
    modelPath: String(preferences.get("modelPath") || ""),
    language: String(preferences.get("language") || "zh"),
    chunkSeconds: num("chunkSeconds", 30, 10, 300),
    tailSeconds: num("tailSeconds", 2, 0, 15),
    autoLoad: bool("autoLoad", true),
    autoTranscribe: bool("autoTranscribe", true),
  };
}

// ---------------------------------------------------------------------------
// Player helpers
// ---------------------------------------------------------------------------

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
      if (baseName(file) !== baseName(candidate)) continue;
      if (directoryOf(file) !== directoryOf(candidate)) continue;
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
    loadedSubtitlePath = existing.path;
    loadedSubtitleId = existing.id;
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
    loadedSubtitlePath = added.path;
    loadedSubtitleId = added.id;
  } else {
    loadedSubtitlePath = path;
    loadedSubtitleId = null;
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
  if (!loadedSubtitlePath) return false;
  try {
    if (loadedSubtitleId !== null && loadedSubtitleId !== undefined) {
      mpv.command("sub-reload", [String(loadedSubtitleId)]);
    } else {
      mpv.command("sub-reload", []);
    }
    return true;
  } catch (e) {
    console.warn("iina-sub: sub-reload failed: " + e);
    return false;
  }
}

// ---------------------------------------------------------------------------
// Cache
// ---------------------------------------------------------------------------

/**
 * Build a fingerprint that covers everything which can invalidate a cached
 * transcript: the media file, the model, the engine binary and the language.
 *
 * The decoder is part of it as well: a new way of reading the audio gives a
 * different result, so an old transcript is not valid any more.
 */
async function buildFingerprint(mediaPath, config, audioTrackIndex) {
  return srt.transcriptFingerprint(
    mediaPath,
    config,
    srt.fnv1a(decoder.SWIFT_SOURCE || ""),
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
async function findValidCache(mediaPath, config, audioTrackIndex) {
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
    config,
    effectiveTrackIndex(audioTrackIndex)
  );
  if (String(stamp).trim() !== expected) return null;
  return paths;
}

/**
 * Load the cached transcript for a media file when one exists and is current.
 * Returns true when a cached subtitle was loaded.
 */
async function loadCachedSubtitle(mediaPath, config, audioTrackIndex) {
  const paths = await findValidCache(mediaPath, config, audioTrackIndex);
  if (!paths) return false;

  if (loadSubtitle(paths.subtitle, [srt.subtitlePathFor(mediaPath)])) {
    core.osd("iina-sub: loaded cached subtitles");
    pushStatus({
      phase: "cached",
      message: "Cached subtitles loaded",
      detail: paths.subtitle,
      percent: 100,
    });
    return true;
  }
  return false;
}

// ---------------------------------------------------------------------------
// Transcription
// ---------------------------------------------------------------------------

/**
 * Validate that everything the engine needs is in place before a run starts.
 */
function validateConfig(config) {
  const engine = engines.getEngine(config.engineId);
  if (!engine) {
    throw new Error(
      'The engine "' +
        config.engineId +
        '" is not known. Pick one of the engines in the settings.'
    );
  }
  if (engine.requiresModel && !config.modelPath) {
    throw new Error("No model is selected. Pick one in the preferences first.");
  }
  if (engine.requiresModel && !utils.fileInPath(config.modelPath)) {
    throw new Error("The model was not found at " + config.modelPath + ".");
  }
  if (!engine.available(config)) {
    throw new Error(
      "The engine " +
        engine.label +
        " is not available. Check that the path in the preferences points at " +
        "an existing file and is an absolute path."
    );
  }
  return engine;
}

/**
 * Whether a path is absolute.
 *
 * A relative path would be looked up in the working folder of the player,
 * which is nowhere the user expects it to be.
 */
function isAbsolute(path) {
  return typeof path === "string" && path.startsWith("/");
}

/**
 * Pick the chunk that matters most for the viewer.
 *
 * Chunks that start just ahead of the playhead are preferred so that the
 * part of the video the user is watching is transcribed first. When the user
 * seeks, the next pick simply lands somewhere else — there is no queue to
 * rebuild.
 */
function pickNextChunk(chunks, done, positionMs) {
  let best = null;
  let bestScore = Infinity;
  for (const chunk of chunks) {
    if (done.has(chunk.index)) continue;
    const distance = Math.abs(chunk.startMs - positionMs);
    // Chunks behind the playhead are slightly penalised so that the viewer
    // does not have to wait for the part they are watching.
    const score = chunk.startMs < positionMs ? distance + 30000 : distance;
    if (score < bestScore) {
      bestScore = score;
      best = chunk;
    }
  }
  return best;
}

/**
 * Write the current cues to disk and refresh the player.
 *
 * The transcript lives inside the plugin folder, where the file API of the
 * player is allowed to overwrite a file that is already there.
 *
 * Only the transcript is written here. The mark that tells the plugin that
 * the transcript is complete is written when the whole file was
 * transcribed, so that a half finished transcript is never taken for a
 * finished one.
 */
async function publishCues(job) {
  const paths = job.paths;
  const content = srt.renderSrt(job.cues);
  try {
    file.write(paths.subtitle, content);
  } catch (e) {
    // A disk that is full shows up here. The run goes on, but the result
    // cannot be trusted, so it is not marked as complete.
    console.error("iina-sub: could not write the transcript: " + e);
    job.writeFailed = true;
    return;
  }
  showTranscript(job);
}

/**
 * Put the transcript on the screen.
 *
 * The file in the plugin folder is the one that follows the transcription.
 * When the player shows the exported copy instead — a snapshot that was
 * written next to the video earlier — the file in the plugin folder is added
 * and selected, so that the screen shows the current state again.
 */
function showTranscript(job) {
  // The viewer has moved on to another file. The subtitles of this one
  // belong to a video that is not on the screen any more, so the player is
  // left alone.
  if (job.mediaPath !== currentMediaPath()) return;

  const internal = job.paths.subtitle;
  const exported = srt.subtitlePathFor(job.mediaPath);

  if (loadedSubtitlePath === internal) {
    reloadSubtitle();
    return;
  }

  if (loadedSubtitlePath && exported && loadedSubtitlePath === exported) {
    // The copy next to the video is a snapshot of an earlier run.
    loadSubtitle(internal);
    return;
  }

  loadSubtitle(internal, exported ? [exported] : []);
}

/**
 * A text that is safe to hand over to the sidebar.
 *
 * The sidebar is a web page, and the player builds the call that reaches it
 * out of the text itself. A backtick in the name of a file would end the
 * text and the sidebar would stop listening.
 */
function safeText(value) {
  return String(value === undefined || value === null ? "" : value).replace(/[`\\]/g, "'");
}

/**
 * Report progress to the player and the sidebar.
 */
function pushStatus(state) {
  const given = state || {};
  const payload = {
    phase: String(given.phase || "idle"),
    message: safeText(given.message),
    detail: safeText(given.detail),
    percent: Number(given.percent) || 0,
    video: safeText(given.video),
    elapsed: Number(given.elapsed) || 0,
  };
  try {
    sidebar.postMessage("status", payload);
  } catch (e) {
    // The sidebar may not be loaded yet. This is not worth a message of its
    // own, but a real failure has to be visible.
    console.warn("iina-sub: the sidebar did not take the status: " + e);
  }
}

/**
 * Run a transcription job for one media file.
 */
async function runJob(job) {
  const { config, engine } = job;
  const chunks = worker.planChunks(job.durationMs, config.chunkSeconds, config.tailSeconds);
  if (chunks.length === 0) {
    throw new Error("The duration of this file is unknown, so it cannot be split into chunks.");
  }

  const done = new Set();
  const startedAt = Date.now();
  const failures = [];
  let attempted = 0;

  try {
    while (done.size < chunks.length) {
      if (job.cancelled) break;

      const chunk = pickNextChunk(chunks, done, job.positionMs());
      if (!chunk) break;
      done.add(chunk.index);
      attempted++;

      const base = ((done.size - 1) / chunks.length) * 100;
      const span = 100 / chunks.length;

      let cues = null;
      try {
        cues = await worker.transcribeChunk(
          job.context,
          engine,
          chunk,
          (percent) => {
            pushStatus({
              phase: "transcribing",
              message: "Transcribing",
              detail: "Chunk " + (chunk.index + 1) + " / " + chunks.length,
              percent: base + span * (percent / 100),
              video: job.mediaPath,
              elapsed: (Date.now() - startedAt) / 1000,
            });
          }
        );
      } catch (e) {
        const message = e && e.message ? e.message : String(e);
        // A chunk that fails costs that chunk and not the whole run. The
        // very first one is the exception: when it fails, the problem is
        // the setup and not the file, and running the rest would only
        // produce the same error over and over.
        if (attempted === 1) throw new Error(message);
        failures.push(message);
        console.warn("iina-sub: chunk " + chunk.index + " failed: " + message);
        pushStatus({
          phase: "transcribing",
          message: "Transcribing",
          detail: "Chunk " + done.size + " / " + chunks.length + " failed",
          percent: (done.size / chunks.length) * 100,
          video: job.mediaPath,
          elapsed: (Date.now() - startedAt) / 1000,
        });
        continue;
      }

      if (job.cancelled) break;

      srt.mergeCues(job.cues, cues, 0);
      await publishCues(job);

      pushStatus({
        phase: "transcribing",
        message: "Transcribing",
        detail: "Chunk " + (done.size) + " / " + chunks.length,
        percent: (done.size / chunks.length) * 100,
        video: job.mediaPath,
        elapsed: (Date.now() - startedAt) / 1000,
      });
    }

    if (job.cancelled) {
      pushStatus({
        phase: "cancelled",
        message: "Cancelled",
        detail: job.mediaPath,
        video: job.mediaPath,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      core.osd("iina-sub: transcription cancelled");
      return false;
    }

    if (job.writeFailed) {
      const message = "The transcript could not be written. The disk may be full.";
      console.error("iina-sub: " + message);
      pushStatus({
        phase: "error",
        message: "Failed",
        detail: message,
        video: job.mediaPath,
        elapsed: (Date.now() - startedAt) / 1000,
      });
      core.osd("iina-sub: " + message);
      logActivity("Failed: " + baseName(job.mediaPath) + " — " + message);
      return false;
    }

    // The mark that says the transcript is complete is written only now. A
    // transcript that is missing a part is not a valid cache, so the file
    // is transcribed again the next time it is opened.
    if (failures.length === 0) {
      try {
        file.write(job.paths.stamp, job.fingerprint);
      } catch (e) {
        console.error("iina-sub: could not write the mark of the transcript: " + e);
      }
    }

    pushStatus({
      phase: failures.length === 0 ? "done" : "partial",
      message: failures.length === 0 ? "Done" : "Done with gaps",
      detail:
        failures.length === 0
          ? job.paths.subtitle
          : failures.length + " of " + chunks.length + " chunks failed",
      percent: 100,
      video: job.mediaPath,
      elapsed: (Date.now() - startedAt) / 1000,
    });
    core.osd(
      failures.length === 0
        ? "iina-sub: subtitles ready"
        : "iina-sub: subtitles ready, but " + failures.length + " chunks failed"
    );
    logActivity("Transcribed " + baseName(job.mediaPath));
    return true;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    pushStatus({
      phase: "error",
      message: "Failed",
      detail: shortMessage(message),
      video: job.mediaPath,
      elapsed: (Date.now() - startedAt) / 1000,
    });
    core.osd("iina-sub: " + shortMessage(message));
    logActivity("Failed: " + baseName(job.mediaPath) + " — " + shortMessage(message));
    return false;
  } finally {
    if (activeJob === job) activeJob = null;
  }
}

/**
 * Build the job that transcribes one media file.
 *
 * The same shape is used for a single file and for a batch, so that the two
 * cannot drift apart. Nothing is waited for here, so that the job can be
 * put in place before the first wait.
 */
function createJob(mediaPath, durationMs, config, engine, options) {
  const opts = options || {};
  const paths = resolveCachePaths(mediaPath);
  if (!paths) return null;

  // A file that is not playing has no track of its own, so the first audio
  // track of the file is used.
  const audioTrackIndex =
    opts.audioTrackIndex === undefined ? currentAudioTrackIndex() : opts.audioTrackIndex;

  return {
    mediaPath: mediaPath,
    durationMs: durationMs,
    config: config,
    engine: engine,
    paths: paths,
    cues: [],
    cancelled: false,
    writeFailed: false,
    fingerprint: null,
    context: {
      config: config,
      mediaPath: mediaPath,
      audioTrackIndex: audioTrackIndex,
      decoder: null,
    },
    positionMs:
      opts.positionMs ||
      function () {
        return 0;
      },
  };
}

/**
 * Fill in the parts of a job that have to wait.
 *
 * The decoder is built here, so that a machine without a compiler says so
 * right away and not in the middle of the first chunk.
 */
async function prepareJob(job) {
  job.fingerprint = await buildFingerprint(
    job.mediaPath,
    job.config,
    effectiveTrackIndex(job.context.audioTrackIndex)
  );
  job.context.decoder = await decoder.ensureDecoder();
  return job;
}

/**
 * Start a transcription for a media file.
 */
async function startTranscription(mediaPath, durationMs, silent) {
  if (isBusy()) {
    core.osd("iina-sub: a transcription is already running");
    return;
  }

  // The job is put in place before the first wait, so that a second request
  // cannot slip in while this one is still being set up. There is one lock
  // only, and it is this one.
  const job = createJob(mediaPath, durationMs, readConfig(), null, {
    positionMs: function () {
      if (mediaPath !== currentMediaPath()) return 0;
      return currentDurationMs() ? Number(mpv.getNumber("time-pos") || 0) * 1000 : 0;
    },
  });
  if (!job) return;
  activeJob = job;

  try {
    await startTranscriptionNow(job, durationMs, silent);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    core.osd("iina-sub: " + shortMessage(message));
    pushStatus({ phase: "error", message: "Failed", detail: shortMessage(message) });
    if (!silent) utils.ask("iina-sub\n\n" + message);
    if (activeJob === job) activeJob = null;
  }
}

/**
 * A short form of a message, so that the screen of the player is not filled
 * with the help of a program that complained.
 */
function shortMessage(text) {
  const message = String(text || "").split("\n")[0].trim();
  return message.length > 200 ? message.slice(0, 200) + "…" : message;
}

async function startTranscriptionNow(job, durationMs, silent) {
  const mediaPath = job.mediaPath;
  const config = job.config;
  let engine;
  try {
    engine = validateConfig(config);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    core.osd("iina-sub: " + message);
    pushStatus({ phase: "error", message: "Failed", detail: message });
    // A run the user asked for deserves a dialog, one that started by itself
    // only deserves a note on the screen.
    if (!silent) utils.ask("iina-sub\n\n" + message);
    if (activeJob === job) activeJob = null;
    return;
  }

  job.engine = engine;

  // The player may not know the length of the file yet, for example right
  // after it was opened. The length is then read from the file itself.
  if (!durationMs) {
    durationMs = await worker.durationOf(mediaPath, 0);
  }
  if (!durationMs) {
    const message =
      "The length of this file could not be read, so it cannot be transcribed.";
    core.osd("iina-sub: " + message);
    pushStatus({ phase: "error", message: "Failed", detail: message });
    if (!silent) utils.ask("iina-sub\n\n" + message);
    if (activeJob === job) activeJob = null;
    return;
  }

  // The plugin writes the transcript and its fingerprint into folders of its
  // own data directory. They have to exist before the first write.
  await srt.ensureDir(utils.resolvePath("@data/subtitles"));
  await srt.ensureDir(utils.resolvePath("@data/fingerprints"));
  await srt.ensureDir(worker.chunkDirectory());

  job.durationMs = durationMs;
  await prepareJob(job);

  // A mark that is left over from an earlier run would say that a
  // transcript which is only half written is complete.
  try {
    if (file.exists(job.paths.stamp)) file.delete(job.paths.stamp);
  } catch (e) {
    /* ignore */
  }

  core.osd("iina-sub: starting transcription");
  pushStatus({
    phase: "starting",
    message: "Starting",
    detail: baseName(mediaPath),
    percent: 0,
    video: mediaPath,
  });

  await runJob(job);
}

// ---------------------------------------------------------------------------
// Commands
// ---------------------------------------------------------------------------

function baseName(path) {
  if (!path) return "";
  const parts = path.split("/");
  return parts[parts.length - 1];
}

function directoryOf(path) {
  if (!path) return "";
  const index = path.lastIndexOf("/");
  return index > 0 ? path.substring(0, index) : "/";
}

function logActivity(text) {
  activityLog.unshift({ time: new Date().toLocaleTimeString(), text: safeText(text) });
  while (activityLog.length > 50) activityLog.pop();
  try {
    sidebar.postMessage("activity", { entries: activityLog });
  } catch (e) {
    console.warn("iina-sub: the sidebar did not take the activity: " + e);
  }
}

async function commandGenerate() {
  const mediaPath = currentMediaPath();
  if (!mediaPath) {
    utils.ask("iina-sub\n\nOpen a local video first. Network streams are not supported.");
    return;
  }
  const config = readConfig();
  if (await loadCachedSubtitle(mediaPath, config, currentAudioTrackIndex())) return;
  await startTranscription(mediaPath, currentDurationMs());
}

async function commandRegenerate() {
  const mediaPath = currentMediaPath();
  if (!mediaPath) {
    utils.ask("iina-sub\n\nOpen a local video first.");
    return;
  }
  const paths = resolveCachePaths(mediaPath);
  if (paths) {
    try {
      if (file.exists(paths.subtitle)) file.delete(paths.subtitle);
      if (file.exists(paths.stamp)) file.delete(paths.stamp);
    } catch (e) {
      /* ignore */
    }
  }
  await startTranscription(mediaPath, currentDurationMs());
}

function commandCancel() {
  // A batch run is stopped as well, otherwise it would carry on with the
  // next file after the one that is running.
  if (batchRunning) {
    batchRunning = false;
    core.osd("iina-sub: batch stopped after the current file");
  }
  if (!activeJob) {
    if (!batchRunning) core.osd("iina-sub: nothing is running");
    return;
  }
  activeJob.cancelled = true;
  core.osd("iina-sub: cancelling after the current chunk");
}

/**
 * List the video files that sit next to the currently playing media.
 */
function siblingVideos(mediaPath) {
  const directory = directoryOf(mediaPath);
  if (!directory) return [];
  let entries = [];
  try {
    entries = file.list(directory, {}) || [];
  } catch (e) {
    return [];
  }
  const result = [];
  for (const entry of entries) {
    if (entry.isDir) continue;
    const name = entry.filename || "";
    const lower = name.toLowerCase();
    const isVideo = VIDEO_EXTENSIONS.some((ext) => lower.endsWith(ext));
    if (!isVideo) continue;
    result.push(directory + "/" + name);
  }
  result.sort();
  return result;
}

async function commandBatch() {
  if (batchRunning) {
    core.osd("iina-sub: a batch run is already in progress");
    return;
  }
  if (isBusy()) {
    core.osd("iina-sub: a transcription is already running");
    return;
  }
  const mediaPath = currentMediaPath();
  if (!mediaPath) {
    utils.ask("iina-sub\n\nOpen a local video first, then every video next to it can be transcribed in one go.");
    return;
  }

  const config = readConfig();
  let engine;
  try {
    engine = validateConfig(config);
  } catch (e) {
    utils.ask("iina-sub\n\n" + (e && e.message ? e.message : String(e)));
    return;
  }

  const files = siblingVideos(mediaPath);
  if (files.length === 0) {
    utils.ask("iina-sub\n\nNo video files were found next to this file.");
    return;
  }

  const confirmed = utils.ask(
    "iina-sub\n\nTranscribe " +
      files.length +
      " video file(s) in this folder?\n\n" +
      files.map(baseName).join("\n")
  );
  if (!confirmed) return;

  batchRunning = true;
  batchQueue = files.slice();
  core.osd("iina-sub: batch started (" + files.length + " files)");

  try {
    await runBatch(files, config, engine);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    core.osd("iina-sub: " + shortMessage(message));
    logActivity("Batch stopped: " + shortMessage(message));
  } finally {
    batchRunning = false;
    batchQueue = [];
    activeJob = null;
  }

  core.osd("iina-sub: batch finished");
  pushStatus({ phase: "idle", message: "Batch finished", percent: 100 });
}

/**
 * Transcribe every file of the folder, one after the other.
 */
async function runBatch(files, config, engine) {
  for (const path of files) {
    if (!batchRunning) break;

    // The files of an earlier run are not needed any more.
    await worker.clearChunkDirectory();

    const duration = await worker.durationOf(path, 0);
    if (!duration) {
      logActivity("Skipped " + baseName(path) + " — unknown duration");
      continue;
    }

    // Reuse a valid cache instead of transcribing again.
    const paths = resolveCachePaths(path);
    if (paths && file.exists(paths.subtitle) && file.exists(paths.stamp)) {
      let stamp = null;
      try {
        stamp = file.read(paths.stamp, {});
      } catch (e) {
        stamp = null;
      }
      if (
        stamp &&
        String(stamp).trim() === (await buildFingerprint(path, config, 0))
      ) {
        logActivity("Cached " + baseName(path));
        continue;
      }
    }

    const job = createJob(path, duration, config, engine, {
      // The file is not the one that is playing, so it has no track of its
      // own and the first audio track of the file is used.
      audioTrackIndex: null,
    });
    if (!job) continue;
    await prepareJob(job);

    try {
      if (file.exists(job.paths.stamp)) file.delete(job.paths.stamp);
    } catch (e) {
      /* ignore */
    }

    activeJob = job;
    await runJob(job);
  }
}

/**
 * Copy the transcript next to the video, using the same name with a `.srt`
 * extension. This is the naming convention every player understands, so IINA
 * picks the file up on its own the next time the video is opened.
 *
 * Nothing is written next to the video until this is asked for.
 */
async function commandExport() {
  const mediaPath = currentMediaPath();
  if (!mediaPath) {
    utils.ask("iina-sub\n\nOpen a local video first.");
    return;
  }
  const paths = resolveCachePaths(mediaPath);
  if (!paths) return;
  if (!file.exists(paths.subtitle)) {
    utils.ask(
      "iina-sub\n\nThere are no subtitles for this video yet.\n\n" +
        "Use Generate Subtitles Now first."
    );
    return;
  }

  // A transcript that is still being written is not the one the user wants
  // to keep.
  if (activeJob && activeJob.mediaPath === mediaPath) {
    utils.ask(
      "iina-sub\n\nThis video is still being transcribed.\n\n" +
        "Wait until it is done, then export the subtitles."
    );
    return;
  }

  const target = srt.subtitlePathFor(mediaPath);
  if (!target) {
    utils.ask(
      "iina-sub\n\nA subtitle file for this video cannot be placed next to it."
    );
    return;
  }

  // A folder cannot be written over. The copy would end up inside it, which
  // is never what the user meant.
  const kind = await srt.fileTypeOf(target);
  if (kind === "directory") {
    utils.ask(
      "iina-sub\n\nThere is a folder named " +
        baseName(target) +
        " in the way.\n\nRemove it and try again."
    );
    return;
  }

  // The file API of the player refuses to overwrite a file outside of the
  // plugin folder, so the copy is made by the system itself. The two paths
  // are handed over as separate values, never as text that a shell reads.
  try {
    // The copy is written under a name that nobody else can guess, so that
    // it cannot be a link to somewhere else. Only at the very end the file
    // is put into place, and that step is a rename, which replaces a link
    // instead of writing through it. A file that is already there is
    // therefore never touched before the new one is ready.
    const temporary = await makeTemporaryFile(directoryOf(target));
    if (!temporary) {
      throw new Error("The folder of the video could not be written to.");
    }

    let res = await utils.exec("/bin/cp", [paths.subtitle, temporary]);
    if (res.status !== 0) {
      await removeQuietly(temporary);
      throw new Error((res.stderr || "").trim() || "exit " + res.status);
    }

    // The temporary file is private to its owner, but a subtitle file next
    // to a video should be readable like any other file.
    try {
      await utils.exec("/bin/chmod", ["0644", temporary]);
    } catch (e) {
      /* the file is there, only its permissions are not what was asked for */
    }

    res = await utils.exec("/bin/mv", ["-f", temporary, target]);
    if (res.status !== 0) {
      await removeQuietly(temporary);
      throw new Error((res.stderr || "").trim() || "exit " + res.status);
    }

    core.osd("iina-sub: saved " + baseName(target));
    logActivity("Exported " + baseName(target));
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: could not write " + target + ": " + message);
    utils.ask("iina-sub\n\nThe subtitle file could not be written.\n\n" + message);
  }
}

/**
 * Create a file with a name that nobody else can guess in a folder.
 *
 * The file is created empty and with the permissions of its owner only, so
 * that nothing can be written through it while the copy is being made.
 */
async function makeTemporaryFile(directory) {
  try {
    const res = await utils.exec("/usr/bin/mktemp", [directory + "/.iina-sub.XXXXXX"]);
    if (res.status !== 0) return null;
    const path = String(res.stdout || "").trim();
    return path || null;
  } catch (e) {
    console.warn("iina-sub: could not create a temporary file: " + e);
    return null;
  }
}

/**
 * Remove a file that is not needed any more.
 */
async function removeQuietly(path) {
  if (!path) return;
  try {
    await utils.exec("/bin/rm", ["-f", path]);
  } catch (e) {
    /* best effort */
  }
}

/**
 * Download a model into the plugin folder.
 *
 * The dialog asks for the name of the model. An empty answer means the
 * recommended one, which is the one that gives the best result for the
 * effort it takes.
 */
async function commandDownloadModel() {
  try {
    const list = models.MODELS.map((m) => m.name + "  —  " + m.note).join("\n");
    const typed = utils.prompt(
      "iina-sub\n\nType the name of the model to download. Leave the field empty " +
        "for the recommended one.\n\n" +
        list
    );
    if (typed === null || typed === undefined) return;

    const wanted = String(typed).trim();
    const meta = wanted
      ? models.MODELS.find((m) => m.name === wanted)
      : models.MODELS.find((m) => m.recommended) || models.MODELS[0];

    if (!meta) {
      utils.ask("iina-sub\n\nThere is no model called \"" + wanted + "\".\n\n" + list);
      return;
    }

    core.osd("iina-sub: downloading " + meta.label);
    pushStatus({ phase: "download", message: "Downloading " + meta.label, percent: 0 });
    const path = await models.download(meta.name, (info) => pushStatus(info));
    preferences.set("modelPath", path);
    preferences.sync();
    core.osd("iina-sub: " + meta.label + " is ready");
    pushStatus({ phase: "done", message: meta.label + " is ready", percent: 100 });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    core.osd("iina-sub: " + message);
    utils.ask("iina-sub\n\nThe model could not be downloaded.\n\n" + message);
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

function buildMenu() {
  // The player only shows the first five entries of a plugin menu and puts
  // the rest behind a "More…" item, so the entries that are used most often
  // come first.
  // The actions hand their promise back, so that the player can wait for
  // them and a test can await them.
  menu.addItem(
    menu.item("Generate Subtitles Now", () => {
      return commandGenerate();
    }, { keyBinding: "Alt+s" })
  );
  menu.addItem(
    menu.item("Export Subtitles Next to the Video", () => {
      return commandExport();
    }, { keyBinding: "Alt+e" })
  );
  menu.addItem(
    menu.item("Transcribe All Videos in This Folder", () => {
      return commandBatch();
    })
  );
  menu.addItem(
    menu.item("Regenerate Subtitles (discard the cache)", () => {
      return commandRegenerate();
    })
  );
  menu.addItem(
    menu.item("Cancel Transcription (stop the current run)", () => {
      return commandCancel();
    }, { keyBinding: "Alt+Shift+s" })
  );
}

// ---------------------------------------------------------------------------
// Events
// ---------------------------------------------------------------------------

event.on("iina.window-loaded", () => {
  try {
    sidebar.loadFile("sidebar.html");
    // The button of the sidebar asks the plugin to fetch a model. The
    // listener has to be registered after the page was loaded, because
    // loading it clears the listeners.
    sidebar.onMessage("downloadModel", () => {
      commandDownloadModel();
    });
  } catch (e) {
    console.warn("iina-sub: could not load the sidebar: " + e);
  }
  pushStatus({ phase: "idle", message: "Ready", percent: 0 });

  // The audio decoder is built now, in the background, so that the first
  // transcription does not have to wait for the compiler.
  decoder.prepareDecoder();
});

event.on("iina.file-loaded", () => {
  const mediaPath = currentMediaPath();
  loadedSubtitlePath = null;
  loadedSubtitleId = null;

  // A transcription that belongs to another file is stopped. Its subtitles
  // would be shown on a video they do not belong to.
  if (activeJob && activeJob.mediaPath !== mediaPath) {
    activeJob.cancelled = true;
  }

  if (!mediaPath) {
    pushStatus({ phase: "idle", message: "Ready", percent: 0 });
    return;
  }

  const config = readConfig();

  handleFileLoaded(mediaPath, config).catch((e) => {
    console.error("iina-sub: " + (e && e.message ? e.message : String(e)));
  });
});

/**
 * Prepare the subtitles for a file that has just been opened.
 *
 * A transcript that is still valid is loaded straight away. When there is
 * none, the file is transcribed on its own, so the subtitles appear without
 * the user having to ask for them.
 */
async function handleFileLoaded(mediaPath, config) {
  const audioTrackIndex = currentAudioTrackIndex();
  const cached = await findValidCache(mediaPath, config, audioTrackIndex);

  if (cached && config.autoLoad) {
    loadSubtitle(cached.subtitle, [srt.subtitlePathFor(mediaPath)]);
    core.osd("iina-sub: loaded cached subtitles");
    pushStatus({
      phase: "cached",
      message: "Cached subtitles loaded",
      detail: cached.subtitle,
      percent: 100,
      video: mediaPath,
    });
    return;
  }

  pushStatus({
    phase: "idle",
    message: "No subtitles yet",
    detail: baseName(mediaPath),
    percent: 0,
    video: mediaPath,
  });

  // Nothing was cached, so start transcribing on its own. The subtitles
  // appear as soon as the first chunk is done.
  if (!config.autoTranscribe) return;
  if (batchRunning) return;
  if (isBusy()) return;

  const duration = await worker.durationOf(mediaPath, currentDurationMs());
  if (!duration) return;
  await startTranscription(mediaPath, duration, true);
}

event.on("mpv.end-file", () => {
  loadedSubtitlePath = null;
  loadedSubtitleId = null;
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

buildMenu();
console.log("iina-sub loaded");

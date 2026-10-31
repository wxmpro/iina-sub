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

/** Media that was loaded last, used to detect a change of file. */
let lastMediaPath = null;

/** Queue of files for a batch run. */
let batchQueue = [];
let batchRunning = false;

/** Small log shown in the sidebar. */
const activityLog = [];

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

function readConfig() {
  const num = (key, fallback) => {
    const value = Number(preferences.get(key));
    return isFinite(value) && value > 0 ? value : fallback;
  };
  const bool = (key, fallback) => {
    const value = preferences.get(key);
    if (value === undefined || value === null || value === "") return fallback;
    return value === true || value === "true" || value === "1";
  };

  return {
    engineId: String(preferences.get("engineId") || "whisper-cpp"),
    enginePath: String(preferences.get("enginePath") || ""),
    whisperPath: String(preferences.get("whisperPath") || "/opt/homebrew/bin/whisper-cli"),
    modelPath: String(preferences.get("modelPath") || ""),
    language: String(preferences.get("language") || "zh"),
    chunkSeconds: num("chunkSeconds", 30),
    tailSeconds: num("tailSeconds", 2),
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
 * Whether the player already holds a subtitle track for one of these files.
 *
 * The player picks up a subtitle file that sits next to the video on its
 * own. When the transcript has been exported, that file holds the very same
 * transcript, so a second track would only confuse.
 */
function isSubtitleLoaded(path, alternatives) {
  const wanted = [path].concat(alternatives || []).filter((p) => !!p);
  try {
    const tracks = mpv.getNative("track-list") || [];
    for (const track of tracks) {
      if (!track || track.type !== "sub") continue;
      const file = track["external-filename"];
      if (!file) continue;
      for (const candidate of wanted) {
        if (file === candidate) return true;
        if (baseName(file) === baseName(candidate)) return true;
      }
    }
  } catch (e) {
    console.warn("iina-sub: could not read the track list: " + e);
  }
  return false;
}

/**
 * Load a subtitle file as a native IINA subtitle track.
 */
function loadSubtitle(path, alternatives) {
  if (isSubtitleLoaded(path, alternatives)) {
    // The player has it already.
    loadedSubtitlePath = path;
    return true;
  }
  try {
    mpv.command("sub-add", [path, "select"]);
    loadedSubtitlePath = path;
    return true;
  } catch (e) {
    console.error("iina-sub: could not load " + path + ": " + e);
    return false;
  }
}

/**
 * Reload the subtitle track after the file on disk changed.
 *
 * mpv implements `sub-reload` by unloading and re-adding an external subtitle
 * file, so the freshly written cues show up immediately.
 */
function reloadSubtitle() {
  if (!loadedSubtitlePath) return false;
  try {
    mpv.command("sub-reload", []);
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
 * The version of the transcription logic.
 *
 * It is part of the fingerprint, so a change in the way the plugin cuts and
 * merges the audio invalidates the transcripts that were produced by the
 * older logic.
 */
const TRANSCRIPT_VERSION = "1";

/**
 * Build a fingerprint that covers everything which can invalidate a cached
 * transcript: the media file, the model, the engine binary and the language.
 */
async function buildFingerprint(mediaPath, config) {
  const mediaStat = await srt.statOf(mediaPath);
  const modelStat = await srt.statOf(config.modelPath);
  const engineStat = await srt.statOf(config.enginePath || config.whisperPath);
  return srt.fingerprint([
    TRANSCRIPT_VERSION,
    mediaPath,
    mediaStat ? mediaStat.size : "",
    mediaStat ? mediaStat.mtime : "",
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
  ]);
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
async function findValidCache(mediaPath, config) {
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

  const expected = await buildFingerprint(mediaPath, config);
  if (String(stamp).trim() !== expected) return null;
  return paths;
}

/**
 * Load the cached transcript for a media file when one exists and is current.
 * Returns true when a cached subtitle was loaded.
 */
async function loadCachedSubtitle(mediaPath, config) {
  const paths = await findValidCache(mediaPath, config);
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
 */
async function publishCues(job) {
  const paths = job.paths;
  const content = srt.renderSrt(job.cues);
  try {
    file.write(paths.subtitle, content);
    file.write(paths.stamp, job.fingerprint);
  } catch (e) {
    console.error("iina-sub: could not write the transcript: " + e);
    return;
  }

  if (loadedSubtitlePath === paths.subtitle) {
    reloadSubtitle();
  } else {
    loadSubtitle(paths.subtitle, [srt.subtitlePathFor(job.mediaPath)]);
  }
}

/**
 * Report progress to the player and the sidebar.
 */
function pushStatus(state) {
  const payload = Object.assign(
    {
      phase: "idle",
      message: "",
      detail: "",
      percent: 0,
      video: "",
      elapsed: 0,
    },
    state || {}
  );
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

  try {
    while (done.size < chunks.length) {
      if (job.cancelled) break;

      const chunk = pickNextChunk(chunks, done, job.positionMs());
      if (!chunk) break;
      done.add(chunk.index);

      const base = ((done.size - 1) / chunks.length) * 100;
      const span = 100 / chunks.length;

      const cues = await worker.transcribeChunk(
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

    pushStatus({
      phase: "done",
      message: "Done",
      detail: job.paths.subtitle,
      percent: 100,
      video: job.mediaPath,
      elapsed: (Date.now() - startedAt) / 1000,
    });
    core.osd("iina-sub: subtitles ready");
    logActivity("Transcribed " + baseName(job.mediaPath));
    return true;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
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
  } finally {
    if (activeJob === job) activeJob = null;
  }
}

/**
 * Start a transcription for a media file.
 */
async function startTranscription(mediaPath, durationMs, silent) {
  if (activeJob) {
    core.osd("iina-sub: a transcription is already running");
    return;
  }

  const config = readConfig();
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
    return;
  }

  const paths = resolveCachePaths(mediaPath);
  if (!paths) return;

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
    return;
  }

  // The plugin writes the transcript and its fingerprint into folders of its
  // own data directory. They have to exist before the first write.
  await srt.ensureDir(utils.resolvePath("@data/subtitles"));
  await srt.ensureDir(utils.resolvePath("@data/fingerprints"));
  await srt.ensureDir(worker.chunkDirectory());

  const job = {
    mediaPath,
    durationMs: durationMs,
    config,
    engine,
    paths,
    cues: [],
    cancelled: false,
    fingerprint: await buildFingerprint(mediaPath, config),
    context: {
      config,
      mediaPath,
      audioTrackIndex: currentAudioTrackIndex(),
      decoder: await decoder.ensureDecoder(),
    },
    positionMs: function () {
      if (mediaPath !== currentMediaPath()) return 0;
      return currentDurationMs() ? Number(mpv.getNumber("time-pos") || 0) * 1000 : 0;
    },
  };

  activeJob = job;
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
  activityLog.unshift({ time: new Date().toLocaleTimeString(), text });
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
  if (await loadCachedSubtitle(mediaPath, config)) return;
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
  if (!activeJob) {
    core.osd("iina-sub: nothing is running");
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

  for (const path of batchQueue) {
    if (!batchRunning) break;

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
      if (stamp && String(stamp).trim() === (await buildFingerprint(path, config))) {
        logActivity("Cached " + baseName(path));
        continue;
      }
    }

    const job = {
      mediaPath: path,
      durationMs: duration,
      config,
      engine,
      paths,
      cues: [],
      cancelled: false,
      fingerprint: await buildFingerprint(path, config),
      context: {
        config,
        mediaPath: path,
        audioTrackIndex: null,
        decoder: await decoder.ensureDecoder(),
      },
      positionMs: function () {
        return 0;
      },
    };
    activeJob = job;
    await runJob(job);
  }

  batchRunning = false;
  batchQueue = [];
  core.osd("iina-sub: batch finished");
  pushStatus({ phase: "idle", message: "Batch finished", percent: 100 });
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

  const target = srt.subtitlePathFor(mediaPath);
  if (!target) {
    utils.ask(
      "iina-sub\n\nA subtitle file for this video cannot be placed next to it."
    );
    return;
  }

  // The file API of the player refuses to overwrite a file outside of the
  // plugin folder, so the copy is made by the system itself. The two paths
  // are handed over as separate values, never as text that a shell reads.
  try {
    const res = await utils.exec("/bin/cp", ["-f", paths.subtitle, target]);
    if (res.status !== 0) {
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
  menu.addItem(
    menu.item("Generate Subtitles Now", () => {
      commandGenerate();
    }, { keyBinding: "Alt+s" })
  );
  menu.addItem(
    menu.item("Export Subtitles Next to the Video", () => {
      commandExport();
    }, { keyBinding: "Alt+e" })
  );
  menu.addItem(
    menu.item("Transcribe All Videos in This Folder", () => {
      commandBatch();
    })
  );
  menu.addItem(
    menu.item("Regenerate Subtitles (discard the cache)", () => {
      commandRegenerate();
    })
  );
  menu.addItem(
    menu.item("Cancel Transcription (stop the current run)", () => {
      commandCancel();
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
  lastMediaPath = mediaPath;
  loadedSubtitlePath = null;

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
  const cached = await findValidCache(mediaPath, config);

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
  if (activeJob) return;

  const duration = await worker.durationOf(mediaPath, currentDurationMs());
  if (!duration) return;
  await startTranscription(mediaPath, duration, true);
}

event.on("mpv.end-file", () => {
  loadedSubtitlePath = null;
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

buildMenu();
console.log("iina-sub loaded");

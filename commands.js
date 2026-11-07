const { core, utils, file, preferences, console } = iina;

const { state, isBusy } = require("./state.js");
const ui = require("./ui.js");
const config = require("./config.js");
const player = require("./player.js");
const cache = require("./cache.js");
const session = require("./session.js");
const setup = require("./setup.js");
const i18n = require("./i18n.js");
const srt = require("./srt.js");
const worker = require("./worker.js");
const engines = require("./engines.js");
const models = require("./models.js");

/**
 * The kinds of file the plugin is willing to transcribe.
 */
const VIDEO_EXTENSIONS = [
  ".mp4", ".mkv", ".mov", ".avi", ".m4v", ".mpg", ".mpeg", ".ts", ".flv", ".webm",
  ".wmv", ".mp3", ".m4a", ".aac", ".flac", ".wav", ".ogg", ".opus",
];


async function commandGenerate() {
  const mediaPath = player.currentMediaPath();
  if (!mediaPath) {
    ui.ask("Open a local video first. Network streams are not supported.");
    return;
  }
  const settings = config.readConfig();
  if (await cache.loadCachedSubtitle(mediaPath, settings, player.currentAudioTrackIndex())) return;
  await session.startTranscription(mediaPath, player.currentDurationMs());
}

async function commandRegenerate() {
  const mediaPath = player.currentMediaPath();
  if (!mediaPath) {
    ui.ask("Open a local video first.");
    return;
  }
  const paths = cache.resolveCachePaths(mediaPath);
  if (paths) {
    try {
      if (file.exists(paths.subtitle)) file.delete(paths.subtitle);
      if (file.exists(paths.stamp)) file.delete(paths.stamp);
    } catch (e) {
      /* ignore */
    }
  }
  await session.startTranscription(mediaPath, player.currentDurationMs());
}

function commandCancel() {
  // A batch run is stopped as well, otherwise it would carry on with the
  // next file after the one that is running.
  if (state.batchRunning) {
    state.batchRunning = false;
    ui.osd("batch stopped after the current file");
  }
  // A file that waits for the running transcription does not wait any more.
  if (state.pending.length > 0) {
    state.pending = [];
    ui.osd("the queued transcription was cancelled");
  }
  if (!state.job) {
    if (!state.batchRunning) ui.osd("nothing is running");
    return;
  }
  state.job.cancelled = true;
  ui.osd("cancelling after the current chunk");
}

/**
 * List the video files that sit next to the currently playing media.
 */
function siblingVideos(mediaPath) {
  const directory = ui.directoryOf(mediaPath);
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
  if (state.batchRunning) {
    ui.osd("a batch run is already in progress");
    return;
  }
  if (isBusy()) {
    ui.osd("a transcription is already running");
    return;
  }
  const mediaPath = player.currentMediaPath();
  if (!mediaPath) {
    ui.ask(
      "Open a local video first, then every video next to it can be transcribed in one go."
    );
    return;
  }

  const settings = config.readConfig();
  let engine;
  try {
    engine = config.validateConfig(settings);
  } catch (e) {
    ui.ask(e && e.message ? e.message : String(e));
    return;
  }

  const files = siblingVideos(mediaPath);
  if (files.length === 0) {
    ui.ask("No video files were found next to this file.");
    return;
  }

  const confirmed = ui.ask(
    "Transcribe {0} video file(s) in this folder?\n\n{1}",
    files.length,
    files.map(ui.baseName).join("\n")
  );
  if (!confirmed) return;

  state.batchRunning = true;
  state.batchQueue = files.slice();
  ui.osd("batch started ({0} files)", files.length);

  try {
    await runBatch(files, settings, engine);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(ui.shortMessage(message));
    ui.logActivity("Batch stopped: {0}", ui.shortMessage(message));
  } finally {
    state.batchRunning = false;
    state.batchQueue = [];
    state.job = null;
  }

  // A file that was opened while the batch was running starts now.
  if (state.pending.length > 0) {
    session.runPending().catch((e) => {
      console.error("iina-sub: the queued transcription failed: " + e);
    });
  }

  ui.osd("batch finished");
  ui.pushStatus({ phase: "idle", message: "Batch finished", percent: 100 });
}

/**
 * Transcribe every file of the folder, one after the other.
 */
async function runBatch(files, settings, engine) {
  for (const path of files) {
    if (!state.batchRunning) break;

    // The files of an earlier run are not needed any more.
    await worker.clearChunkDirectory();

    const duration = await worker.durationOf(path, 0);
    if (!duration) {
      ui.logActivity("Skipped {0} — unknown duration", ui.baseName(path));
      continue;
    }

    // Reuse a valid cache instead of transcribing again.
    const paths = cache.resolveCachePaths(path);
    if (paths && file.exists(paths.subtitle) && file.exists(paths.stamp)) {
      let stamp = null;
      try {
        stamp = file.read(paths.stamp, {});
      } catch (e) {
        stamp = null;
      }
      if (
        stamp &&
        String(stamp).trim() === (await cache.buildFingerprint(path, settings, 0))
      ) {
        ui.logActivity("Cached {0}", ui.baseName(path));
        continue;
      }
    }

    const job = session.createJob(path, duration, settings, engine, {
      // The file is not the one that is playing, so it has no track of its
      // own and the first audio track of the file is used.
      audioTrackIndex: null,
    });
    if (!job) continue;
    await session.prepareJob(job);

    try {
      if (file.exists(job.paths.stamp)) file.delete(job.paths.stamp);
    } catch (e) {
      /* ignore */
    }

    state.job = job;
    await session.runJob(job);
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
  const mediaPath = player.currentMediaPath();
  if (!mediaPath) {
    ui.ask("Open a local video first.");
    return;
  }
  const paths = cache.resolveCachePaths(mediaPath);
  if (!paths) return;
  if (!file.exists(paths.subtitle)) {
    ui.ask(
      "There are no subtitles for this video yet.\n\nUse Generate Subtitles Now first."
    );
    return;
  }

  // A transcript that is still being written is not the one the user wants
  // to keep.
  if (state.job && state.job.mediaPath === mediaPath) {
    ui.ask(
      "This video is still being transcribed.\n\nWait until it is done, then export the subtitles."
    );
    return;
  }

  // A transcript that lost a part of the file is not complete. The mark that
  // says so is written at the end of a run, so its absence means that
  // something went wrong. The file is still written when the user says so,
  // but the state is named first.
  if (!file.exists(paths.stamp)) {
    const answer = ui.ask(
      "The subtitles of this video are not complete. " +
        "Some parts of the file could not be transcribed.\n\n" +
        "Export them anyway?"
    );
    if (answer === false) return;
  }

  const target = srt.subtitlePathFor(mediaPath);
  if (!target) {
    ui.ask("A subtitle file for this video cannot be placed next to it.");
    return;
  }

  // A folder cannot be written over. The copy would end up inside it, which
  // is never what the user meant.
  const kind = await srt.fileTypeOf(target);
  if (kind === "directory") {
    ui.ask(
      "There is a folder named {0} in the way.\n\nRemove it and try again.",
      ui.baseName(target)
    );
    return;
  }

  // The file API of the player refuses to overwrite a file outside of the
  // plugin folder, so the copy is made by the system itself. The two paths
  // are handed over as separate values, never as text that a shell reads.
  //
  // The program that makes the copy puts the new file in place itself. It
  // does not write through a link that is already there: the link is
  // replaced, and the file it points at is left alone. Nothing is written
  // into the folder of the video but the subtitle file itself.
  //
  // The copy gets the same permissions as the video, so that a video only
  // its owner may read does not leave its dialogue behind in a file that
  // everybody on the machine can read.
  const mode = (await srt.permissionBitsOf(mediaPath)) || "644";
  try {
    const res = await utils.exec("/usr/bin/install", [
      "-m",
      mode,
      paths.subtitle,
      target,
    ]);
    if (res.status !== 0) {
      throw new Error((res.stderr || "").trim() || "exit " + res.status);
    }

    ui.osd("saved {0}", ui.baseName(target));
    ui.logActivity("Exported {0}", ui.baseName(target));
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: could not write " + target + ": " + message);
    ui.ask("The subtitle file could not be written.\n\n{0}", message);
  }
}

/**
 * Remove every transcript that the plugin has kept.
 *
 * The transcripts live in the plugin folder and are named after a hash of the
 * path of the video, so there is no way to tell from the name which one
 * belongs to which video. They are removed together.
 *
 * The videos are not touched, and the files next to them are not touched
 * either.
 */
async function commandClearTranscripts() {
  const confirmed = ui.ask(
    "Remove every transcript that the plugin has kept?\n\n" +
      "The videos themselves are not touched, and the subtitle files next " +
      "to them are not touched either."
  );
  if (!confirmed) return;

  const folders = [
    utils.resolvePath("@data/subtitles"),
    utils.resolvePath("@data/fingerprints"),
  ];
  let removed = 0;
  for (const folder of folders) {
    if (!folder) continue;
    let entries = [];
    try {
      entries = file.list(folder, {}) || [];
    } catch (e) {
      continue;
    }
    for (const entry of entries) {
      if (!entry || entry.isDir) continue;
      try {
        file.delete(folder + "/" + entry.filename);
        removed++;
      } catch (e) {
        /* best effort */
      }
    }
  }

  ui.osd("{0} files removed", removed);
  ui.logActivity("Removed the saved transcripts");
  ui.pushStatus({
    phase: "idle",
    message: "The saved transcripts were removed",
    percent: 0,
  });
}

/**
 * Remove the models that the plugin has downloaded.
 *
 * A model is a few hundred megabytes, and the player keeps the data folder
 * of a plugin when the plugin is removed. This command is the way to get
 * rid of them without looking for the folder by hand.
 *
 * The transcripts are not touched: they are small and they are the work of
 * the user.
 */
async function commandRemoveModels() {
  const folder = utils.resolvePath("@data/models");
  if (!folder) {
    ui.ask("There is no model folder to clean up.");
    return;
  }

  let entries = [];
  try {
    entries = file.list(folder, {}) || [];
  } catch (e) {
    entries = [];
  }
  const models = entries.filter(
    (entry) =>
      entry && !entry.isDir && String(entry.filename).endsWith(".bin")
  );
  const stamps = entries.filter(
    (entry) =>
      entry && !entry.isDir && String(entry.filename).endsWith(".verified")
  );
  if (models.length === 0) {
    for (const stamp of stamps) {
      try {
        file.delete(folder + "/" + stamp.filename);
      } catch (e) {
        /* best effort */
      }
    }
    ui.osd("there is no model to remove");
    return;
  }

  const confirmed = ui.ask(
    "Remove the {0} model(s) that the plugin has downloaded?\n\n" +
      "A model has to be downloaded again before the plugin can transcribe " +
      "anything, and the download is a few hundred megabytes.",
    models.length
  );
  if (!confirmed) return;

  let removed = 0;
  for (const model of models) {
    try {
      file.delete(folder + "/" + model.filename);
      removed++;
    } catch (e) {
      /* best effort */
    }
  }
  for (const stamp of stamps) {
    try {
      file.delete(folder + "/" + stamp.filename);
    } catch (e) {
      /* best effort */
    }
  }

  ui.osd("{0} models removed", removed);
  ui.logActivity("Removed {0} models", removed);
  setup.pushModels();
}

/**
 * Download a model into the plugin folder.
 *
 * The dialog asks for the name of the model. An empty answer means the
 * recommended one, which is the one that gives the best result for the
 * effort it takes.
 */
async function commandDownloadModel(name) {
  try {
    let meta = null;
    if (name) {
      // The sidebar names the model, so nothing has to be typed.
      meta = models.MODELS.find((m) => m.name === String(name));
      if (!meta) {
        ui.ask("There is no model called \"{0}\".", name);
        return;
      }
    } else {
      // The models that are already there are named, so that the user does
      // not fetch one twice.
      const installed = models.installedModels();
      const list = models.MODELS.map((m) => {
        const there = installed.some((i) => i.name === m.name) ? "  (already downloaded)" : "";
        return m.name + "  —  " + i18n.t(m.note) + there;
      }).join("\n");
      const typed = ui.prompt(
        "Type the name of the model to download. Leave the field empty " +
          "for the recommended one.\n\n{0}",
        list
      );
      if (typed === null || typed === undefined) return;

      const wanted = String(typed).trim();
      meta = wanted
        ? models.MODELS.find((m) => m.name === wanted)
        : models.MODELS.find((m) => m.recommended) || models.MODELS[0];

      if (!meta) {
        ui.ask("There is no model called \"{0}\".\n\n{1}", wanted, list);
        return;
      }
    }

    ui.osd("downloading {0}", meta.label);
    ui.pushStatus({ phase: "download", message: "Downloading {0}", percent: 0, detail: meta.label });
    const path = await models.download(meta.name, (info) => ui.pushStatus(info));
    preferences.set("modelPath", path);
    preferences.sync();
    ui.osd("{0} is ready", meta.label);
    ui.pushStatus({ phase: "done", message: "{0} is ready", percent: 100, detail: meta.label });
    setup.pushModels();
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(message);
    ui.ask("The model could not be downloaded.\n\n{0}", message);
  }
}

module.exports = {
  commandGenerate,
  commandRegenerate,
  commandCancel,
  siblingVideos,
  commandBatch,
  runBatch,
  commandExport,
  commandClearTranscripts,
  commandRemoveModels,
  commandDownloadModel,
};

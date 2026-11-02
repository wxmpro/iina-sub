/**
 * iina-sub — local AI subtitles for IINA.
 *
 * The plugin transcribes local media with a locally installed speech
 * recognition engine, keeps the result in its own folder and loads it as a
 * native IINA subtitle track.
 *
 * This file is the assembly of the plugin. Everything that does the work
 * lives in a module of its own:
 *
 *   state.js     the one object that holds what is going on at the moment
 *   config.js    the settings of the plugin, read and checked
 *   player.js    the talks with the player itself
 *   cache.js     the fingerprint of a file and the place of its transcript
 *   ui.js        the progress on the screen and in the sidebar
 *   session.js   the transcription itself, one chunk at a time
 *   setup.js     the first run: the program and the model
 *   commands.js  the actions of the menu
 *
 * Design goals:
 *  - zero cloud dependency, everything runs on the machine;
 *  - the transcript is cached, so a second visit costs nothing;
 *  - subtitles appear while the file is still being transcribed;
 *  - the engine is pluggable, whisper.cpp is only the default.
 */
const { core, menu, utils, event, sidebar, console } = iina;

// ---------------------------------------------------------------------------
// The loader of the modules
// ---------------------------------------------------------------------------

/**
 * Build every module of the plugin once, and only once.
 *
 * The `require` of the player keeps a cache that is written with the address
 * of the file and read with the name that was asked for. The two are never
 * the same, so a module that is asked for twice is built twice — and two
 * copies of a module share nothing at all. The state of the plugin would
 * then live in two places at once, and the second copy would not know about
 * the job that the first one is running.
 *
 * The loader below keeps the modules of the plugin in a cache of its own. It
 * is put in the place of the `require` of the player before the first module
 * is asked for, so that every module of the plugin is built once and every
 * one of them holds the same copy of the shared parts.
 */
function installLoader() {
  const globalObject = typeof globalThis !== "undefined" ? globalThis : this;
  const playerRequire = globalObject.require;
  if (typeof playerRequire !== "function") return;

  const built = {};
  globalObject.require = function (file) {
    const key = String(file);
    if (Object.prototype.hasOwnProperty.call(built, key)) return built[key];
    const loaded = playerRequire(key);
    built[key] = loaded;
    return loaded;
  };
}

installLoader();

const i18n = require("./i18n.js");
const { state, isBusy } = require("./state.js");
const ui = require("./ui.js");
const config = require("./config.js");
const player = require("./player.js");
const cache = require("./cache.js");
const session = require("./session.js");
const setup = require("./setup.js");
const commands = require("./commands.js");
const engines = require("./engines.js");
const decoder = require("./decoder.js");
const worker = require("./worker.js");
const srt = require("./srt.js");
const watchdog = require("./watchdog.js");

// ---------------------------------------------------------------------------
// The flow of a file that has been opened
// ---------------------------------------------------------------------------

/**
 * Prepare the subtitles for a file that has just been opened.
 *
 * A transcript that is still valid is loaded straight away. When there is
 * none, the file is transcribed on its own, so the subtitles appear without
 * the user having to ask for them.
 */
async function handleFileLoaded(mediaPath, settings) {
  const audioTrackIndex = player.currentAudioTrackIndex();
  const cached = await cache.findValidCache(mediaPath, settings, audioTrackIndex);

  if (cached && settings.autoLoad) {
    player.loadSubtitle(cached.subtitle, [srt.subtitlePathFor(mediaPath)]);
    ui.osd("loaded cached subtitles");
    ui.pushStatus({
      phase: "cached",
      message: "Cached subtitles loaded",
      detail: cached.subtitle,
      percent: 100,
      video: mediaPath,
    });
    return;
  }

  ui.pushStatus({
    phase: "idle",
    message: "No subtitles yet",
    detail: ui.baseName(mediaPath),
    percent: 0,
    video: mediaPath,
  });

  // Nothing was cached, so start transcribing on its own. The subtitles
  // appear as soon as the first chunk is done.
  if (!settings.autoTranscribe) return;
  if (state.batchRunning) return;
  if (isBusy()) return;

  // The setup is checked before the run starts, so that the first run of a
  // new user ends with subtitles and not with an error about a model.
  const engine = engines.getEngine(settings.engineId);
  if (!engine) return;

  // The program of the engine comes first: without it nothing can be
  // recognised, whatever model is there.
  if (!engine.available(settings)) {
    const ready = await setup.offerEngineSetup(mediaPath, settings);
    if (!ready) return;
  }

  if (engine.requiresModel && !(settings.modelPath && utils.fileInPath(settings.modelPath))) {
    await setup.offerModelDownload(mediaPath);
    return;
  }

  const duration = await worker.durationOf(mediaPath, player.currentDurationMs());
  if (!duration) return;
  await session.startTranscription(mediaPath, duration, true);
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
  // The menu is built again when the language of the system turns out to be
  // Chinese, so that the entries are in the language of the user.
  menu.addItem(
    menu.item(i18n.t("Generate Subtitles Now"), () => {
      return commands.commandGenerate();
    }, { keyBinding: "Alt+s" })
  );
  menu.addItem(
    menu.item(i18n.t("Export Subtitles Next to the Video"), () => {
      return commands.commandExport();
    }, { keyBinding: "Alt+e" })
  );
  menu.addItem(
    menu.item(i18n.t("Transcribe All Videos in This Folder"), () => {
      return commands.commandBatch();
    })
  );
  menu.addItem(
    menu.item(i18n.t("Regenerate Subtitles (discard the cache)"), () => {
      return commands.commandRegenerate();
    })
  );
  menu.addItem(
    menu.item(i18n.t("Cancel Transcription (stop the current run)"), () => {
      return commands.commandCancel();
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
    // The promise is handed back, so that a test can wait for the download
    // to be over. The player itself pays no attention to it.
    sidebar.onMessage("downloadModel", (data) => {
      return commands.commandDownloadModel(data && data.name);
    });
    sidebar.onMessage("clearTranscripts", () => {
      return commands.commandClearTranscripts();
    });
    sidebar.onMessage("removeModels", () => {
      return commands.commandRemoveModels();
    });
    // The page of the sidebar is ready and asks for the language. A
    // message that was sent before the page was there would have been lost,
    // so the page asks for it.
    sidebar.onMessage("ready", () => {
      sidebar.postMessage("locale", { locale: i18n.locale() });
    });
    sidebar.onMessage("fetchEngine", () => {
      return setup.commandFetchEngine();
    });
    setup.pushModels();
    // The page of the sidebar is written in both languages and is told which
    // one of them to show.
    sidebar.postMessage("locale", { locale: i18n.locale() });
  } catch (e) {
    console.warn("iina-sub: could not load the sidebar: " + e);
  }
  ui.pushStatus({ phase: "idle", message: "Ready", percent: 0 });

  // The audio decoder is built now, in the background, so that the first
  // transcription does not have to wait for the compiler.
  decoder.prepareDecoder();
});

event.on("iina.file-loaded", () => {
  const mediaPath = player.currentMediaPath();
  state.subtitlePath = null;
  state.subtitleId = null;

  // A transcription that belongs to another file is stopped. Its subtitles
  // would be shown on a video they do not belong to.
  if (state.job && state.job.mediaPath !== mediaPath) {
    state.job.cancelled = true;
  }

  if (!mediaPath) {
    ui.pushStatus({ phase: "idle", message: "Ready", percent: 0 });
    return;
  }

  const settings = config.readConfig();

  handleFileLoaded(mediaPath, settings).catch((e) => {
    console.error("iina-sub: " + (e && e.message ? e.message : String(e)));
  });
});

event.on("mpv.end-file", () => {
  state.subtitlePath = null;
  state.subtitleId = null;
});

// ---------------------------------------------------------------------------
// Entry point
// ---------------------------------------------------------------------------

buildMenu();

// The plugin watches its own folder. When the folder is gone, the plugin
// was removed, and the data of it goes with it: the models are hundreds of
// megabytes, and nobody removes them by hand.
watchdog.start();

// The language of the plugin is worked out now. The menu is built again
// when it is not the language that the menu was built with, so that the
// entries are in the language of the user.
i18n.init().then(() => {
  if (i18n.locale() === "zh") {
    menu.removeAllItems();
    buildMenu();
    menu.forceUpdate();
  }
  try {
    sidebar.postMessage("locale", { locale: i18n.locale() });
  } catch (e) {
    /* the sidebar may not be there yet */
  }
}).catch((e) => {
  console.warn("iina-sub: the language of the plugin is unknown: " + e);
});

console.log("iina-sub loaded");

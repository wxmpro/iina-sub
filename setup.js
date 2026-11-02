const { core, utils, file, preferences, sidebar, console } = iina;

const { state } = require("./state.js");
const ui = require("./ui.js");
const config = require("./config.js");
const i18n = require("./i18n.js");
const player = require("./player.js");
const session = require("./session.js");
const engines = require("./engines.js");
const models = require("./models.js");
const worker = require("./worker.js");


/**
 * Tell the sidebar which models the catalogue holds and which of them are
 * already on the disk. The sidebar shows one button per model, so nothing
 * has to be typed to fetch one.
 */
function pushModels() {
  let installed = [];
  try {
    installed = models.installedModels();
  } catch (e) {
    installed = [];
  }
  const payload = models.MODELS.map((m) => ({
    name: m.name,
    label: m.label,
    note: i18n.t(m.note),
    recommended: !!m.recommended,
    downloaded: installed.some((i) => i.name === m.name),
  }));
  try {
    sidebar.postMessage("models", { models: payload });
  } catch (e) {
    console.warn("iina-sub: the sidebar did not take the models: " + e);
  }
}

/**
 * Make sure the speech recognition program is ready.
 *
 * When Homebrew has whisper.cpp, that copy is used and nothing has to be
 * fetched. When it does not, the plugin offers to fetch its own copy — one
 * file, 4 MB, checked against a fixed sum before it is run.
 *
 * Returns true when a program is ready to run.
 */
async function offerEngineSetup(mediaPath, settings) {
  if (settings.engineId !== "whisper-cpp") {
    // Another engine was chosen on purpose. Its program is installed by the
    // user, so the settings have to say where it is.
    if (!state.engineOfferMade) {
      state.engineOfferMade = true;
      try {
        config.validateConfig(settings);
      } catch (e) {
        ui.ask(e && e.message ? e.message : String(e));
      }
    }
    ui.pushStatus({
      phase: "idle",
      message: "The engine is not ready",
      detail: ui.baseName(mediaPath),
      percent: 0,
      video: mediaPath,
    });
    return false;
  }

  // A copy that was fetched earlier is used without asking again.
  if (await engines.bundledIsValid()) {
    preferences.set("whisperPath", engines.bundledBinaryPath());
    preferences.sync();
    return true;
  }

  if (state.engineOfferMade) {
    ui.pushStatus({
      phase: "idle",
      message: "The speech recognition program is missing",
      detail: "Use the sidebar tab of the plugin to fetch it",
      percent: 0,
      video: mediaPath,
    });
    return false;
  }
  state.engineOfferMade = true;

  const confirmed = ui.ask(
    "Speech recognition needs a program. The plugin can fetch " +
      "its own copy (about 4 MB, once) and keep it in its folder.\n\n" +
      "Fetch it now?\n\n" +
      "Homebrew users can install whisper.cpp instead with:\n" +
      "brew install whisper.cpp"
  );
  if (!confirmed) {
    ui.pushStatus({
      phase: "idle",
      message: "The speech recognition program is missing",
      detail: "Use the sidebar tab of the plugin to fetch it",
      percent: 0,
      video: mediaPath,
    });
    ui.logActivity("No speech recognition program yet — the fetch was declined");
    return false;
  }

  try {
    const path = await engines.ensureBundledWhisper((info) => ui.pushStatus(info));
    preferences.set("whisperPath", path);
    preferences.sync();
    ui.osd("the speech recognition program is ready");
    ui.logActivity("Fetched the speech recognition program");
    return true;
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(ui.shortMessage(message));
    ui.pushStatus({ phase: "error", message: "Failed", detail: ui.shortMessage(message) });
    ui.ask("The speech recognition program could not be fetched.\n\n{0}", message);
    return false;
  }
}

/**
 * The first run of a user who has no model yet.
 *
 * The plugin cannot show subtitles without a model, and a model is fetched
 * once and kept. Instead of an error that sends the user hunting through
 * the settings, the recommended model is offered here, with one question.
 * When it is fetched, the video that was opened is transcribed right away.
 */
async function offerModelDownload(mediaPath) {
  if (state.modelOfferMade) {
    ui.pushStatus({
      phase: "idle",
      message: "No model yet",
      detail: "Use the sidebar tab of the plugin to fetch one",
      percent: 0,
      video: mediaPath,
    });
    return;
  }
  state.modelOfferMade = true;

  const recommended = models.MODELS.find((m) => m.recommended) || models.MODELS[0];
  const confirmed = ui.ask(
    "To show subtitles, a speech model is needed. It is downloaded " +
      "once ({0}), kept in the folder of the plugin, and works without network after " +
      "that.\n\nFetch {1} now?",
    recommended.label,
    recommended.label
  );
  if (!confirmed) {
    ui.pushStatus({
      phase: "idle",
      message: "No model yet",
      detail: "Use the sidebar tab of the plugin to fetch one",
      percent: 0,
      video: mediaPath,
    });
    ui.logActivity("No model yet — the fetch was declined");
    return;
  }

  try {
    ui.pushStatus({
      phase: "download",
      message: "Downloading {0}",
      percent: 0,
      detail: recommended.label,
    });
    const path = await models.download(recommended.name, (info) => ui.pushStatus(info));
    preferences.set("modelPath", path);
    preferences.sync();
    pushModels();
    ui.logActivity("Fetched {0}", recommended.label);

    // The video that was opened is transcribed now, so that the first run
    // ends with subtitles on the screen and not with a downloaded file.
    const duration = await worker.durationOf(mediaPath, player.currentDurationMs());
    if (duration) await session.startTranscription(mediaPath, duration, true);
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(ui.shortMessage(message));
    ui.pushStatus({ phase: "error", message: "Failed", detail: ui.shortMessage(message) });
    ui.ask("The model could not be downloaded.\n\n{0}", message);
  }
}

/**
 * Fetch the speech recognition program without being asked first.
 *
 * The sidebar has a button for it, and the answer to the question of the
 * first run is remembered, so a user who said no can still get it later.
 */
async function commandFetchEngine() {
  try {
    const path = await engines.ensureBundledWhisper((info) => ui.pushStatus(info));
    preferences.set("whisperPath", path);
    preferences.sync();
    ui.osd("the speech recognition program is ready");
    ui.logActivity("Fetched the speech recognition program");
    ui.pushStatus({
      phase: "done",
      message: "The speech recognition program is ready",
      percent: 100,
    });
  } catch (e) {
    const message = e && e.message ? e.message : String(e);
    console.error("iina-sub: " + message);
    ui.osd(ui.shortMessage(message));
    ui.ask("The speech recognition program could not be fetched.\n\n{0}", message);
  }
}

module.exports = { pushModels, offerEngineSetup, offerModelDownload, commandFetchEngine };

const { utils, preferences, console } = iina;

const engines = require("./engines.js");

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
    // looked at, and after that the copy that the plugin brings along.
    whisperPath =
      WHISPER_CANDIDATES.find((candidate) => utils.fileInPath(candidate)) ||
      engines.bundledBinaryPath();
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
    if (engine.id === "whisper-cpp") {
      throw new Error(
        "The speech recognition program is not installed. Install it once " +
          "with `brew install whisper.cpp` in the Terminal. It is then found " +
          "at /opt/homebrew/bin/whisper-cli (Apple Silicon) or " +
          "/usr/local/bin/whisper-cli (Intel) on its own."
      );
    }
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

module.exports = { readConfig, validateConfig, isAbsolute, WHISPER_CANDIDATES };

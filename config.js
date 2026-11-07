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


/**
 * The length of one chunk, in seconds.
 *
 * A chunk is decoded, recognised and merged into the transcript on its own,
 * so that the subtitles appear while the file is still being transcribed.
 *
 * The length is a trade-off. A short chunk is recognised faster, but the
 * model starts every chunk without knowing what was said before it, and a
 * sentence that is cut in two is recognised badly — on a course recording
 * the wrong term ("干预性分析" instead of "概念性分析") is worth more than the
 * seconds that are saved. A long chunk gives the model the context it needs
 * and costs fewer runs of the program, which matters because every run loads
 * the model again.
 *
 * A hundred and twenty seconds was measured against thirty: the terms came
 * out right, the number of runs fell by a factor of four, and the whole file
 * was transcribed three times faster.
 */
const DEFAULT_CHUNK_SECONDS = 120;

/**
 * The audio that is decoded after every chunk, in seconds.
 *
 * The model hears the end of a sentence instead of a hard cut. The cues that
 * begin inside this tail belong to the chunk that follows, and are dropped.
 */
const DEFAULT_TAIL_SECONDS = 5;

/**
 * The length of the first chunk, in seconds.
 *
 * The first subtitle of a file cannot appear before the first chunk is done,
 * and every run of the recognition program starts with loading the model
 * again, which takes about three and a half seconds on its own. A first chunk
 * of the full length would put the first subtitles ten seconds away; a short
 * one puts them within five. The chunks after the first are full length, so
 * the accuracy of the rest is not touched.
 */
const DEFAULT_FIRST_CHUNK_SECONDS = 30;


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

  const chunkSeconds = num("chunkSeconds", DEFAULT_CHUNK_SECONDS, 30, 600);

  return {
    engineId: String(preferences.get("engineId") || "whisper-cpp"),
    enginePath: String(preferences.get("enginePath") || ""),
    whisperPath: whisperPath,
    modelPath: String(preferences.get("modelPath") || ""),
    language: String(preferences.get("language") || "zh"),
    subtitleScript: String(preferences.get("subtitleScript") || "simplified"),
    chunkSeconds: chunkSeconds,
    // The first chunk is never longer than the others, and never longer than
    // the default first chunk. When the chunks are short anyway, the first is
    // the same as the rest.
    firstChunkSeconds: Math.min(DEFAULT_FIRST_CHUNK_SECONDS, chunkSeconds),
    tailSeconds: num("tailSeconds", DEFAULT_TAIL_SECONDS, 0, 30),
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

module.exports = {
  readConfig,
  validateConfig,
  isAbsolute,
  WHISPER_CANDIDATES,
  DEFAULT_CHUNK_SECONDS,
  DEFAULT_TAIL_SECONDS,
  DEFAULT_FIRST_CHUNK_SECONDS,
};

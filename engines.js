const { utils, file, console } = iina;

const srt = require("./srt.js");

/**
 * Engine adapters.
 *
 * An engine knows how to turn one chunk of audio into subtitle cues.
 * Every engine exposes the same contract:
 *
 *   run(context, chunk, onProgress): Promise<Array<cue>>
 *
 * `context` is { config, mediaPath, audioStreamIndex }.
 * `chunk` is { index, startMs, lengthMs, durationMs, outBase }.
 * `onProgress` receives a 0..100 number.
 *
 * Adding a new engine means implementing this contract and registering it in
 * ENGINES below — no other file has to change.
 */

/**
 * Quote a string so it can be safely embedded in a shell command.
 */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
}

/**
 * whisper.cpp — the default and best supported engine.
 *
 * The audio is decoded and recognised in one go: the decoder writes 16 kHz
 * mono PCM to its standard output and whisper.cpp reads it from its standard
 * input. No intermediate file is ever written, so a long run cannot be broken
 * by the system cleaning up a temporary directory.
 *
 * The decoder is a small helper built on the media framework that macOS
 * ships with. The speech recognition itself is done by the local whisper
 * model, which is the only part that needs a model file.
 */
const whisperCpp = {
  id: "whisper-cpp",
  label: "whisper.cpp",
  description:
    "C/C++ implementation of Whisper. Fast, offline, packaged by Homebrew " +
    "as `brew install whisper.cpp`.",
  requiresModel: true,

  available(config) {
    return utils.fileInPath(config.whisperPath);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;

    // The decoder turns the audio track of the video into the 16 kHz mono
    // PCM that the model expects and writes it to its standard output. The
    // model reads it from its standard input. Nothing is written to disk in
    // between.
    const decoder = context.decoder;
    const decodeArgs = [
      context.mediaPath,
      (chunk.startMs / 1000).toFixed(3),
      (chunk.durationMs / 1000).toFixed(3),
    ];
    // The player tells us which audio track the user is listening to. The
    // decoder counts its tracks among the audio tracks only, so the index
    // has to be counted the same way.
    if (typeof context.audioTrackIndex === "number" && context.audioTrackIndex >= 0) {
      decodeArgs.push(String(context.audioTrackIndex));
    }

    const whisperArgs = [
      "-m", config.modelPath,
      "-f", "-",
      "-l", config.language || "zh",
      "-osrt",
      "-of", chunk.outBase,
      "-np",
      "-pp",
    ];

    // whisper.cpp reports its progress on stderr as
    // "whisper_print_progress_callback: progress =  42%".
    const progressPattern = /progress\s*=\s*(\d{1,3})%/g;
    const onStderr = (text) => {
      let match;
      progressPattern.lastIndex = 0;
      while ((match = progressPattern.exec(text)) !== null) {
        const value = Number(match[1]);
        if (isFinite(value)) onProgress(Math.max(0, Math.min(100, value)));
      }
    };

    const command =
      shellQuote(decoder.command) +
      " " +
      decoder.args.concat(decodeArgs).map(shellQuote).join(" ") +
      " | " +
      shellQuote(config.whisperPath) +
      " " +
      whisperArgs.map(shellQuote).join(" ");

    const res = await utils.exec("/bin/sh", ["-c", command], undefined, undefined, onStderr);
    if (res.status !== 0) {
      throw new Error(
        "The transcription failed (exit " +
          res.status +
          "): " +
          (res.stderr || "").trim()
      );
    }
    onProgress(100);

    const produced = file.read(chunk.outBase + ".srt", {});
    return srt.parseSrt(produced || "");
  },
};

/**
 * mlx-whisper — Apple's MLX backend, runs the encoder on the Neural Engine.
 *
 * Produces a JSON transcript rather than SRT, so the cue extraction differs.
 */
const mlxWhisper = {
  id: "mlx-whisper",
  label: "mlx-whisper",
  description: "Apple MLX port of Whisper. Uses the Neural Engine on Apple Silicon.",
  requiresModel: true,

  available(config) {
    return utils.fileInPath(config.enginePath);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;
    const args = [
      "--model", config.modelPath,
      "--output_dir", chunk.outBase + ".dir",
      "--output_format", "json",
      "--language", config.language || "zh",
      "--file", context.mediaPath,
    ];
    const res = await utils.exec(config.enginePath, args);
    if (res.status !== 0) {
      throw new Error(
        "mlx-whisper exited with " + res.status + ": " + (res.stderr || "").trim()
      );
    }
    onProgress(100);

    const raw = file.read(chunk.outBase + ".json", {});
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    const cues = [];
    for (const seg of parsed.segments || []) {
      const text = String(seg.text || "").trim();
      if (!text) continue;
      cues.push({
        start: Math.round(Number(seg.start || 0) * 1000),
        end: Math.round(Number(seg.end || 0) * 1000),
        text,
      });
    }
    return cues;
  },
};

/**
 * A user supplied command template.
 *
 * The template may contain these placeholders:
 *   {input}   path of the media file
 *   {output}  path of the SRT file to write
 *   {model}   path of the model file
 *   {language} language code
 *
 * The command is run through /bin/sh, so pipes and redirections are allowed.
 * The placeholders expand to shell positional parameters, which means the
 * values are never interpreted as shell syntax.
 */
const customCommand = {
  id: "custom",
  label: "Custom command",
  description:
    "Run any local command that turns a media file into an SRT file. " +
    "Placeholders: {input} {output} {model} {language}.",
  requiresModel: false,

  available(config) {
    return !!(config.enginePath && config.enginePath.trim().length > 0);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;
    const outPath = chunk.outBase + ".srt";

    // The values are handed to the shell as positional parameters, so the
    // shell never parses them. A file name that contains a quote or a
    // semicolon cannot turn into another command this way.
    const values = [
      context.mediaPath,
      outPath,
      config.modelPath || "",
      config.language || "zh",
    ];

    const expand = (value) =>
      String(value)
        .replace(/\{input\}/g, '"$1"')
        .replace(/\{output\}/g, '"$2"')
        .replace(/\{model\}/g, '"$3"')
        .replace(/\{language\}/g, '"$4"');

    const res = await utils.exec(
      "/bin/sh",
      ["-c", expand(config.enginePath), "iina-sub"].concat(values)
    );
    if (res.status !== 0) {
      throw new Error(
        "Custom command exited with " + res.status + ": " + (res.stderr || "").trim()
      );
    }
    onProgress(100);

    const produced = file.read(outPath, {});
    return srt.parseSrt(produced || "");
  },
};

const ENGINES = {
  "whisper-cpp": whisperCpp,
  "mlx-whisper": mlxWhisper,
  custom: customCommand,
};

/**
 * Resolve an engine by id, falling back to whisper.cpp.
 */
function getEngine(id) {
  return ENGINES[id] || whisperCpp;
}

/**
 * List of engines for the preference page.
 */
function list() {
  return Object.keys(ENGINES).map((id) => ({
    id,
    label: ENGINES[id].label,
    description: ENGINES[id].description,
  }));
}

module.exports = { getEngine, list, ENGINES, shellQuote };

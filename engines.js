const { utils, file, console } = iina;

const srt = require("./srt.js");
const decoder = require("./decoder.js");

/**
 * Engine adapters.
 *
 * An engine knows how to turn one chunk of audio into subtitle cues.
 * Every engine exposes the same contract:
 *
 *   run(context, chunk, onProgress): Promise<Array<cue>>
 *
 * `context` is { config, mediaPath, audioTrackIndex }.
 * `chunk` is { index, startMs, lengthMs, durationMs, outBase }.
 * `onProgress` receives a 0..100 number.
 *
 * The times of the cues are relative to the beginning of the chunk. The
 * worker moves them into the timeline of the whole file and drops the ones
 * that belong to the overlap at the end of the chunk.
 *
 * Adding a new engine means implementing this contract and registering it in
 * ENGINES below — no other file has to change.
 */

/**
 * Quote a string so it can be safely embedded in a shell command.
 *
 * Only the custom engine needs this: it runs a command line that the user
 * wrote, and that one may hold pipes and redirections. The other engines
 * hand their arguments over as they are, so nothing has to be quoted.
 */
function shellQuote(value) {
  return "'" + String(value).replace(/'/g, "'\\''") + "'";
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
 * Remove a file or a folder that an engine left behind.
 *
 * Only the paths that the plugin itself handed out are removed. They live in
 * the plugin folder and carry the name of the chunk, so nothing outside of
 * it can be touched.
 */
async function remove(path) {
  if (!path) return;
  try {
    const res = await utils.exec("/bin/rm", ["-rf", path]);
    if (res.status !== 0) {
      console.warn("iina-sub: could not remove " + path);
    }
  } catch (e) {
    console.warn("iina-sub: could not remove " + path + ": " + e);
  }
}

/**
 * The JSON file that an engine wrote into a folder.
 *
 * The name of the file depends on the name of the input, so the folder is
 * looked at instead of guessing the name.
 */
function findJsonFile(directory) {
  if (!directory) return null;
  let entries = [];
  try {
    entries = file.list(directory, {}) || [];
  } catch (e) {
    return null;
  }
  for (const entry of entries) {
    if (!entry || entry.isDir) continue;
    const name = entry.filename || "";
    if (name.endsWith(".json")) return directory + "/" + name;
  }
  return null;
}

/**
 * A short form of the message of a failed program.
 *
 * The speech model prints its whole help when it is used wrongly, and that
 * does not belong on the screen of the player.
 */
function shortMessage(text) {
  const lines = String(text || "")
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  if (lines.length === 0) return "";
  const useful = lines.filter((line) => line.indexOf("error") !== -1 || lines.length <= 3);
  const chosen = useful.length > 0 ? useful : lines.slice(-3);
  const message = chosen.join(" ");
  return message.length > 300 ? message.slice(0, 300) + "…" : message;
}

/**
 * whisper.cpp — the default and best supported engine.
 *
 * The audio of the chunk is decoded into a file and the model reads that
 * file. Neither of the two programs is started through a shell, so a file
 * name can never be read as a command.
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
    return isAbsolute(config.whisperPath) && utils.fileInPath(config.whisperPath);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;
    const wavPath = chunk.outBase + ".wav";

    // The decoder turns the audio track of the video into the 16 kHz mono
    // PCM that the model expects. The player tells us which audio track the
    // user is listening to; the decoder counts its tracks among the audio
    // tracks only, so the index has to be counted the same way.
    const decoded = await decoder.writeWav(
      wavPath,
      context.mediaPath,
      chunk.startMs / 1000,
      chunk.durationMs / 1000,
      context.audioTrackIndex
    );

    if (decoded.silent) {
      // There is nothing to recognise in this part of the file.
      await remove(wavPath);
      onProgress(100);
      return [];
    }

    const whisperArgs = [
      "-m", config.modelPath,
      "-f", wavPath,
      "-l", config.language || "zh",
      "-osrt",
      "-of", chunk.outBase,
      "-np",
      "-pp",
    ];

    let res = null;
    try {
      res = await utils.exec(config.whisperPath, whisperArgs);
    } catch (e) {
      await remove(wavPath);
      throw new Error("The speech recognition model could not be started: " + e);
    }

    // The model writes its result next to the name it was given. The file
    // is read before the audio is removed, and a missing file is not an
    // error of its own.
    let produced = null;
    try {
      produced = file.read(chunk.outBase + ".srt", {});
    } catch (e) {
      produced = null;
    }
    await remove(wavPath);

    if (res.status !== 0) {
      throw new Error(
        "The transcription failed (exit " +
          res.status +
          "): " +
          shortMessage(res.stderr)
      );
    }
    onProgress(100);

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
    return isAbsolute(config.enginePath) && utils.fileInPath(config.enginePath);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;
    const wavPath = chunk.outBase + ".wav";
    const outputDir = chunk.outBase + ".dir";

    // The engine reads a file, so the audio of the chunk is written to disk
    // first. That file holds the chunk and nothing else, so the times the
    // engine reports belong to the chunk and to nothing else.
    const decoded = await decoder.writeWav(
      wavPath,
      context.mediaPath,
      chunk.startMs / 1000,
      chunk.durationMs / 1000,
      context.audioTrackIndex
    );

    if (decoded.silent) {
      await remove(wavPath);
      onProgress(100);
      return [];
    }

    // The audio is the last argument of mlx-whisper, the name of the file it
    // writes follows the name of the audio.
    const args = [
      "--model", config.modelPath,
      "--output_dir", outputDir,
      "--output_format", "json",
      "--language", config.language || "zh",
      wavPath,
    ];

    let res = null;
    try {
      res = await utils.exec(config.enginePath, args);
    } catch (e) {
      await remove(wavPath);
      throw new Error("mlx-whisper could not be started: " + e);
    }
    if (res.status !== 0) {
      await remove(wavPath);
      await remove(outputDir);
      throw new Error(
        "mlx-whisper exited with " + res.status + ": " + shortMessage(res.stderr)
      );
    }
    onProgress(100);

    // The name of the file it writes depends on the name of the input, so
    // the folder is looked at instead.
    const jsonPath = findJsonFile(outputDir);
    let raw = null;
    if (jsonPath) {
      try {
        raw = file.read(jsonPath, {});
      } catch (e) {
        raw = null;
      }
    }

    await remove(wavPath);
    await remove(outputDir);

    if (!raw) return [];

    let parsed = null;
    try {
      parsed = JSON.parse(raw);
    } catch (e) {
      throw new Error("mlx-whisper wrote a file that could not be read as JSON.");
    }

    const cues = [];
    for (const seg of (parsed && parsed.segments) || []) {
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
 *   {audio}   path of a WAV file that holds the chunk
 *   {output}  path of the SRT file to write
 *   {model}   path of the model file
 *   {language} language code
 *   {start}   start of the chunk in seconds
 *   {duration} length of the chunk in seconds
 *
 * The command is run through /bin/sh, so pipes and redirections are allowed.
 * The placeholders expand to shell positional parameters, which means the
 * values are never interpreted as shell syntax.
 *
 * The command is called once per chunk, so it has to transcribe the chunk and
 * write the times relative to the beginning of the chunk. Using {audio} is
 * the easiest way to do that: it holds the audio of the chunk and nothing
 * else.
 */
const customCommand = {
  id: "custom",
  label: "Custom command",
  description:
    "Run any local command that turns a media file into an SRT file. " +
    "Placeholders: {input} {audio} {output} {model} {language} {start} {duration}.",
  requiresModel: false,

  available(config) {
    return !!(config.enginePath && config.enginePath.trim().length > 0);
  },

  async run(context, chunk, onProgress) {
    const { config } = context;
    const outPath = chunk.outBase + ".srt";
    const startSeconds = chunk.startMs / 1000;
    const durationSeconds = chunk.durationMs / 1000;

    // The audio of the chunk is only decoded when the command asks for it.
    // Decoding it for nothing would cost time on every chunk.
    let wavPath = "";
    if (String(config.enginePath).indexOf("{audio}") !== -1) {
      wavPath = chunk.outBase + ".wav";
      const decoded = await decoder.writeWav(
        wavPath,
        context.mediaPath,
        startSeconds,
        durationSeconds,
        context.audioTrackIndex
      );
      if (decoded.silent) {
        await remove(wavPath);
        onProgress(100);
        return [];
      }
    }

    // The values are handed to the shell as positional parameters, so the
    // shell never parses them. A file name that contains a quote or a
    // semicolon cannot turn into another command this way.
    const values = [
      context.mediaPath,
      outPath,
      config.modelPath || "",
      config.language || "zh",
      wavPath,
      String(startSeconds),
      String(durationSeconds),
    ];

    const expand = (value) =>
      String(value)
        .replace(/\{input\}/g, '"$1"')
        .replace(/\{output\}/g, '"$2"')
        .replace(/\{model\}/g, '"$3"')
        .replace(/\{language\}/g, '"$4"')
        .replace(/\{audio\}/g, '"$5"')
        .replace(/\{start\}/g, '"$6"')
        .replace(/\{duration\}/g, '"$7"');

    let res = null;
    try {
      res = await utils.exec(
        "/bin/sh",
        ["-c", expand(config.enginePath), "iina-sub"].concat(values)
      );
    } catch (e) {
      await remove(wavPath);
      throw new Error("The custom command could not be started: " + e);
    }
    if (res.status !== 0) {
      await remove(wavPath);
      throw new Error(
        "Custom command exited with " + res.status + ": " + shortMessage(res.stderr)
      );
    }
    onProgress(100);

    let produced = null;
    try {
      produced = file.read(outPath, {});
    } catch (e) {
      produced = null;
    }

    await remove(wavPath);

    return srt.parseSrt(produced || "");
  },
};

const ENGINES = {
  "whisper-cpp": whisperCpp,
  "mlx-whisper": mlxWhisper,
  custom: customCommand,
};

/**
 * Resolve an engine by id.
 *
 * An engine that is not known returns nothing, so that a setting that does
 * not fit is reported instead of silently running another engine.
 */
function getEngine(id) {
  return ENGINES[id] || null;
}

/**
 * List of engines for the preference page.
 */
function list() {
  return Object.keys(ENGINES).map((id) => ({
    id: id,
    label: ENGINES[id].label,
    description: ENGINES[id].description,
  }));
}

module.exports = { getEngine, list, ENGINES, shellQuote };

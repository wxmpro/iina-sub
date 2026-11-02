const { utils, file, console, preferences } = iina;

const srt = require("./srt.js");
const decoder = require("./decoder.js");
const models = require("./models.js");
const script = require("./script.js");

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
 * The text of the shell that starts a program and writes down its number.
 *
 * The shell puts a number into a file and then replaces itself with the
 * program, so the number in the file is the number of the program itself and
 * not the number of the shell. Every value travels as a parameter of the
 * shell, so a name of a file can never become a command.
 */
const START_SCRIPT = 'echo $$ > "$1"; shift; exec "$@"';

/**
 * The longest time a program is given before it is stopped.
 */
const RUN_LIMIT_MS = 15 * 60 * 1000;

/**
 * A time written in a way that a person can read.
 */
function formatDuration(ms) {
  if (ms < 60000) return Math.round(ms / 1000) + " seconds";
  return Math.round(ms / 60000) + " minutes";
}

/**
 * Where the number of the running program is written down.
 */
function pidFilePath() {
  return utils.resolvePath("@tmp/iina-sub-" + Date.now() + "-" + Math.floor(Math.random() * 1000000) + ".pid");
}

/**
 * Stop a program that is running.
 *
 * The number is read from the file the shell wrote it into. Only a plain
 * number is used at all: `/bin/kill` reads a leading dash as the number of
 * a signal, and the wrong signal would stop something else entirely.
 *
 * The program that is running is compared with the one that was started. A
 * program that has finished in the meantime has given its number to another
 * program, and that other program is not ours to stop.
 */
async function stopProcess(pidFile, command) {
  let pid = "";
  try {
    pid = String(file.read(pidFile, {}) || "").trim();
  } catch (e) {
    return false;
  }
  if (!/^[1-9][0-9]{0,8}$/.test(pid)) return false;

  let line = "";
  try {
    const ps = await utils.exec("/bin/ps", ["-p", pid, "-o", "command="]);
    if (!ps || ps.status !== 0) return false;
    line = String(ps.stdout || "").trim();
  } catch (e) {
    return false;
  }
  if (!line) return false;
  if (line !== command && !line.startsWith(command + " ")) return false;

  try {
    const killed = await utils.exec("/bin/kill", ["-9", pid]);
    return !!killed && killed.status === 0;
  } catch (e) {
    return false;
  }
}

/**
 * Run a program once and stop it when it takes too long.
 *
 * Giving up on the wait is not enough: the program has to be stopped as
 * well. A speech recognition that hangs would keep the processor busy and
 * keep the model open, and the parts of the file that come after it would
 * wait for a machine that is already busy.
 *
 * Returns the same shape as `utils.exec`, with a `timedOut` flag on it.
 */
async function runOnce(command, args, limitMs) {
  const pidFile = pidFilePath();
  await remove(pidFile);

  const running = utils.exec(
    "/bin/sh",
    ["-c", START_SCRIPT, "iina-sub", pidFile, command].concat(args)
  );

  let timer = null;
  let stopping = null;
  const limit = new Promise((resolve) => {
    timer = setTimeout(() => {
      const message =
        "The program did not finish within " +
        formatDuration(limitMs) +
        " and was stopped.";
      resolve({ status: -1, stdout: "", stderr: message, timedOut: true });
      // The program is stopped behind the answer, and the wait for the
      // stop is kept: the file with the number of the program may not be
      // removed before the number has been read out of it.
      stopping = stopProcess(pidFile, command);
    }, limitMs);
  });

  try {
    return await Promise.race([running, limit]);
  } finally {
    if (timer !== null) clearTimeout(timer);
    if (stopping) {
      try {
        await stopping;
      } catch (e) {
        /* the program was not stopped, and there is nothing to do about it */
      }
    }
    await remove(pidFile);
  }
}

/**
 * Run a program and stop it when it takes too long.
 *
 * The player has no way of stopping a program that it started, so a program
 * that never returns would hold the plugin for ever and every later request
 * would be answered with "a transcription is already running". The wait is
 * given a limit instead: a part of a file that cannot be recognised within
 * that limit is a part that failed.
 *
 * A program that was stopped is tried a second time, with a shorter limit.
 * The first attempt can fail for a reason that has nothing to do with the
 * file — a program that was still being written, a machine that was busy —
 * and the second attempt is what saves the part of the file.
 */
async function runWithLimit(command, args, limitMs) {
  const first = await runOnce(command, args, limitMs);
  if (!first || !first.timedOut) return first;

  const retryLimit = Math.max(1000, Math.round(limitMs / 2));
  console.warn(
    "iina-sub: the program was stopped after " +
      formatDuration(limitMs) +
      ", it is tried again with " +
      formatDuration(retryLimit)
  );
  const second = await runOnce(command, args, retryLimit);
  if (second && !second.timedOut) return second;
  return second || first;
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

// ---------------------------------------------------------------------------
// The whisper.cpp engine and the program it brings along
// ---------------------------------------------------------------------------

/**
 * Where the program that the plugin brings along comes from.
 *
 * Homebrew is the way most people get whisper.cpp, and the plugin uses that
 * copy when it is there. A machine without Homebrew would have nothing, and
 * the plugin is meant to work after it was installed and nothing else.
 *
 * whisper.cpp publishes libraries for Apple platforms but no command line
 * program, so the plugin carries its own: the library of the release below
 * and a small program of its own, built against that very library. Both are
 * made once by the maintainers and published as one file next to the plugin,
 * and the file is checked against the sum below before anything is run.
 *
 * The sources of the program are in `tools/whisper-cli-src`, and the script
 * that builds the file is `scripts/build-whisper.sh`, so anyone can check
 * what is in it and build it again.
 */
const WHISPER_BUNDLE_URL =
  "https://github.com/wxmpro/iina-sub/releases/download/v2.1.0/" +
  "iina-sub-whisper-macos.zip";

/** The sum of that file. A file that does not match is thrown away. */
const WHISPER_BUNDLE_SHA256 =
  "e24b5aa06f1de5c83ce4a68079470894ce342250320e0a6abba1bd8074ac3c23";

/** The release of whisper.cpp that the library in that file belongs to. */
const WHISPER_RELEASE = "b5454";

/**
 * Where the program lives once it is unpacked.
 *
 * It sits in the folder of the plugin, like everything else the plugin
 * brings along. The folder of the user is never written to.
 */
function bundledDirectory() {
  return utils.resolvePath("@data/whisper");
}

function bundledBinaryPath() {
  return bundledDirectory() + "/whisper-cli";
}

function bundledLibraryPath() {
  return bundledDirectory() + "/whisper.framework/whisper";
}

function bundledStampPath() {
  return bundledDirectory() + "/.stamp";
}

/**
 * Whether the program is there and is still the one that was unpacked.
 *
 * The library is a program that is loaded and run, so it is checked again
 * every time it is about to be used. A library that was changed on the disk
 * is not used.
 */
async function bundledIsValid() {
  const binary = bundledBinaryPath();
  const library = bundledLibraryPath();
  if (!binary || !library) return false;
  if (!utils.fileInPath(binary) || !utils.fileInPath(library)) return false;

  let stamp = "";
  try {
    stamp = String(file.read(bundledStampPath(), {}) || "").trim();
  } catch (e) {
    return false;
  }
  if (stamp !== WHISPER_BUNDLE_SHA256) return false;

  const actual = await srt.sha256OfFile(library);
  return actual !== "";
}

/**
 * Fetch the program and unpack it.
 *
 * The file is downloaded under a temporary name, checked against the sum,
 * and only then unpacked. A file that does not match never reaches the
 * folder the program runs from.
 */
async function fetchBundledWhisper(onProgress) {
  const report = onProgress || function () {};
  const dir = bundledDirectory();
  if (!dir) throw new Error("The plugin folder could not be resolved.");
  await utils.exec("/bin/mkdir", ["-p", dir]);

  const archive = dir + "/whisper.zip";
  try {
    if (file.exists(archive)) file.delete(archive);
  } catch (e) {
    /* ignore */
  }

  report({ phase: "download", percent: 0, message: "Fetching the speech recognition program" });

  const curlArgs = [
    // The settings of the user are not read, and nothing but HTTPS is used.
    "-q",
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
  ];
  const proxy = String(preferences.get("proxy") || "").trim();
  if (proxy) curlArgs.push("--proxy", proxy);
  curlArgs.push("-o", archive, WHISPER_BUNDLE_URL);

  const res = await utils.exec("/usr/bin/curl", curlArgs);
  if (res.status !== 0) {
    try {
      file.delete(archive);
    } catch (e) {
      /* ignore */
    }
    // The same reading of a failed connection as the model download uses,
    // so that the way out is named the same way in both places.
    throw new Error(models.networkFailure(res.status, res.stderr, "program"));
  }

  report({ phase: "download", percent: 60, message: "Checking the speech recognition program" });

  const digest = await srt.sha256OfFile(archive);
  if (digest !== WHISPER_BUNDLE_SHA256) {
    try {
      file.delete(archive);
    } catch (e) {
      /* ignore */
    }
    throw new Error(
      "The downloaded speech recognition program does not match the sum " +
        "that this plugin knows, so it was discarded.\n\nExpected: " +
        WHISPER_BUNDLE_SHA256 +
        "\nGot:      " +
        (digest || "nothing")
    );
  }

  report({ phase: "download", percent: 80, message: "Unpacking the speech recognition program" });

  const unpack = await utils.exec("/usr/bin/ditto", ["-x", "-k", archive, dir]);
  try {
    file.delete(archive);
  } catch (e) {
    /* ignore */
  }
  if (unpack.status !== 0) {
    throw new Error("The program could not be unpacked: " + (unpack.stderr || "").trim());
  }

  // The two files have to be programs that can be run.
  const chmodBinary = await utils.exec("/bin/chmod", ["0755", bundledBinaryPath()]);
  await utils.exec("/bin/chmod", ["0644", bundledLibraryPath()]);
  if (chmodBinary.status !== 0) {
    throw new Error("The program could not be made runnable.");
  }

  try {
    file.write(bundledStampPath(), WHISPER_BUNDLE_SHA256 + "\n");
  } catch (e) {
    console.warn("iina-sub: could not write the stamp of the program: " + e);
  }

  report({ phase: "download", percent: 100, message: "The speech recognition program is ready" });
  return bundledBinaryPath();
}

/**
 * Make sure the program is ready and return its path.
 *
 * When it is already there and unchanged, nothing is fetched and nothing is
 * unpacked.
 */
async function ensureBundledWhisper(onProgress) {
  if (await bundledIsValid()) return bundledBinaryPath();
  return fetchBundledWhisper(onProgress);
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
    "C/C++ implementation of Whisper. Fast, offline, and uses the GPU of " +
    "the Mac. Homebrew is used when it is there; when it is not, the plugin " +
    "brings its own copy.",
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
    ];

    // The model is told which script to write in. It is a short text in that
    // script, and the model writes in the style of it from then on.
    const prompt = script.promptFor(config);
    if (prompt) {
      whisperArgs.push("--prompt", prompt);
    }

    let res = null;
    try {
      // A part of a file is a minute of audio at most, so a run that takes
      // longer than this is not making progress any more.
      res = await runWithLimit(config.whisperPath, whisperArgs, RUN_LIMIT_MS);
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
    ];

    // The model is told which script to write in, in the same way as with
    // whisper.cpp.
    const prompt = script.promptFor(config);
    if (prompt) {
      args.push("--initial_prompt", prompt);
    }

    args.push(wavPath);

    let res = null;
    try {
      // The program is stopped when it takes too long, in the same way as
      // the program of whisper.cpp.
      res = await runWithLimit(config.enginePath, args, RUN_LIMIT_MS);
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
 *   {prompt}  a short text in the script the subtitles should be in, empty
 *             when the script of the model is to be kept
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
      script.promptFor(config),
    ];

    const expand = (value) =>
      String(value)
        .replace(/\{input\}/g, '"$1"')
        .replace(/\{output\}/g, '"$2"')
        .replace(/\{model\}/g, '"$3"')
        .replace(/\{language\}/g, '"$4"')
        .replace(/\{audio\}/g, '"$5"')
        .replace(/\{start\}/g, '"$6"')
        .replace(/\{duration\}/g, '"$7"')
        .replace(/\{prompt\}/g, '"$8"');

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

module.exports = {
  getEngine,
  list,
  ENGINES,
  runWithLimit,
  WHISPER_RELEASE,
  WHISPER_BUNDLE_URL,
  WHISPER_BUNDLE_SHA256,
  bundledBinaryPath,
  bundledIsValid,
  ensureBundledWhisper,
};

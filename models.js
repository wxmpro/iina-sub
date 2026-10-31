const { utils, file, console } = iina;

/**
 * Catalogue of whisper.cpp ggml models that can be downloaded from inside the
 * plugin.
 *
 * The byte sizes are the ones published by the upstream repository and are
 * used to verify a download before it is put into place. A download that does
 * not match the expected size is discarded instead of being used.
 */

const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

const MODELS = [
  {
    name: "ggml-tiny.bin",
    label: "Tiny (74 MB)",
    bytes: 77691713,
    note: "Fastest. Low accuracy, mainly useful for testing.",
    recommended: false,
  },
  {
    name: "ggml-base.bin",
    label: "Base (141 MB)",
    bytes: 147951465,
    note: "Still very fast. Noticeably weaker than the larger models.",
    recommended: false,
  },
  {
    name: "ggml-small.bin",
    label: "Small (465 MB)",
    bytes: 487601967,
    note: "Good compromise for English. Chinese quality is limited.",
    recommended: false,
  },
  {
    name: "ggml-medium-q5_0.bin",
    label: "Medium q5_0 (514 MB)",
    bytes: 539212467,
    note: "Strong accuracy, moderate speed.",
    recommended: false,
  },
  {
    name: "ggml-large-v3-turbo-q5_0.bin",
    label: "Large v3 turbo q5_0 (547 MB)",
    bytes: 574041195,
    note: "Best speed to accuracy ratio. Recommended for Chinese.",
    recommended: true,
  },
  {
    name: "ggml-large-v3-q5_0.bin",
    label: "Large v3 q5_0 (1031 MB)",
    bytes: 1081140203,
    note: "Highest accuracy of the quantised models. About twice as slow as turbo.",
    recommended: false,
  },
];

const MODEL_DIR = "@data/models";

/**
 * Absolute path of the directory that holds downloaded models.
 */
function modelDirectory() {
  return utils.resolvePath(MODEL_DIR);
}

/**
 * List the models that are already present on disk.
 */
function installedModels() {
  const dir = modelDirectory();
  const result = [];
  if (!dir) return result;
  const entries = file.list(dir, {});
  if (!entries) return result;
  const known = new Set(MODELS.map((m) => m.name));
  for (const entry of entries) {
    if (entry.isDir) continue;
    const name = entry.filename;
    if (!name.endsWith(".bin")) continue;
    const meta = MODELS.find((m) => m.name === name);
    result.push({
      name,
      path: dir + "/" + name,
      label: meta ? meta.label : name,
      known: known.has(name),
    });
  }
  result.sort((a, b) => a.name.localeCompare(b.name));
  return result;
}

/**
 * Download a model into the plugin data directory.
 *
 * The file is written to a temporary name first and only moved into place
 * after its size has been verified, so an interrupted download can never be
 * mistaken for a usable model.
 */
async function download(modelName, onProgress) {
  const meta = MODELS.find((m) => m.name === modelName);
  if (!meta) throw new Error("Unknown model: " + modelName);

  const dir = modelDirectory();
  if (!dir) throw new Error("Cannot resolve the plugin data directory.");

  // The download writes into this folder, so it has to exist first.
  try {
    await utils.exec("/bin/mkdir", ["-p", dir]);
  } catch (e) {
    throw new Error("Cannot create the model folder: " + e);
  }

  const target = dir + "/" + meta.name;
  if (file.exists(target)) return target;

  const partial = target + ".part";
  if (file.exists(partial)) {
    try {
      file.delete(partial);
    } catch (e) {
      /* ignore */
    }
  }

  onProgress({ phase: "download", percent: 0, message: "Downloading " + meta.label });

  const res = await utils.exec("/usr/bin/curl", [
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    "-o",
    partial,
    BASE_URL + meta.name,
  ]);

  if (res.status !== 0) {
    try {
      file.delete(partial);
    } catch (e) {
      /* ignore */
    }
    throw new Error(
      "Download failed (exit " + res.status + "): " + (res.stderr || "").trim()
    );
  }

  const stat = await srtStat(partial);
  if (!stat || stat.size !== meta.bytes) {
    try {
      file.delete(partial);
    } catch (e) {
      /* ignore */
    }
    throw new Error(
      "Downloaded file has the wrong size (" +
        (stat ? stat.size : "unknown") +
        ", expected " +
        meta.bytes +
        "). It has been discarded."
    );
  }

  // The file is put into place only after its size has been checked. The
  // move is done by the system, because the file API of the player cannot
  // rename a file.
  try {
    const res = await utils.exec("/bin/mv", ["-f", partial, target]);
    if (res.status !== 0) {
      throw new Error((res.stderr || "").trim() || "exit " + res.status);
    }
  } catch (e) {
    try {
      file.delete(partial);
    } catch (ignored) {
      /* ignore */
    }
    throw new Error("The model could not be put into place: " + e);
  }

  onProgress({ phase: "done", percent: 100, message: meta.label + " is ready" });
  return target;
}

async function srtStat(path) {
  try {
    const res = await utils.exec("/usr/bin/stat", ["-f", "%z", path]);
    if (res.status !== 0) return null;
    return { size: Number(String(res.stdout).trim()) };
  } catch (e) {
    return null;
  }
}

module.exports = { MODELS, MODEL_DIR, modelDirectory, installedModels, download };

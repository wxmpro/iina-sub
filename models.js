const { utils, file, preferences, console } = iina;

/**
 * Catalogue of whisper.cpp ggml models that can be downloaded from inside the
 * plugin.
 *
 * Every model carries the size and the SHA-256 sum that the upstream
 * repository publishes. A download is checked against both before it is put
 * into place, and a file that does not match is discarded instead of being
 * used. A model is a program that the speech recognition engine loads, so a
 * model that was tampered with would run code on the machine of the user.
 */

const BASE_URL = "https://huggingface.co/ggerganov/whisper.cpp/resolve/main/";

const MODELS = [
  {
    name: "ggml-tiny.bin",
    label: "Tiny (74 MB)",
    bytes: 77691713,
    sha256: "be07e048e1e599ad46341c8d2a135645097a538221678b7acdd1b1919c6e1b21",
    note: "Fastest. Low accuracy, mainly useful for testing.",
    recommended: false,
  },
  {
    name: "ggml-base.bin",
    label: "Base (141 MB)",
    bytes: 147951465,
    sha256: "60ed5bc3dd14eea856493d334349b405782ddcaf0028d4b5df4088345fba2efe",
    note: "Still very fast. Noticeably weaker than the larger models.",
    recommended: false,
  },
  {
    name: "ggml-small.bin",
    label: "Small (465 MB)",
    bytes: 487601967,
    sha256: "1be3a9b2063867b937e64e2ec7483364a79917e157fa98c5d94b5c1fffea987b",
    note: "Good compromise for English. Chinese quality is limited.",
    recommended: false,
  },
  {
    name: "ggml-medium-q5_0.bin",
    label: "Medium q5_0 (514 MB)",
    bytes: 539212467,
    sha256: "19fea4b380c3a618ec4723c3eef2eb785ffba0d0538cf43f8f235e7b3b34220f",
    note: "Strong accuracy, moderate speed.",
    recommended: false,
  },
  {
    name: "ggml-large-v3-turbo-q5_0.bin",
    label: "Large v3 turbo q5_0 (547 MB)",
    bytes: 574041195,
    sha256: "394221709cd5ad1f40c46e6031ca61bce88931e6e088c188294c6d5a55ffa7e2",
    note: "Best speed to accuracy ratio. Recommended for Chinese.",
    recommended: true,
  },
  {
    name: "ggml-large-v3-q5_0.bin",
    label: "Large v3 q5_0 (1031 MB)",
    bytes: 1081140203,
    sha256: "d75795ecff3f83b5faa89d1900604ad8c780abd5739fae406de19f23ecd98ad1",
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
  let entries = [];
  try {
    entries = file.list(dir, {}) || [];
  } catch (e) {
    return result;
  }
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

  const curlArgs = [
    // The settings of the user are not read. The player starts a program
    // without the environment of the user, so curl would look for the file
    // in the folder the player was started in, which has nothing to do
    // with the user. The proxy is a setting of the plugin instead.
    // This has to be the first argument of the command.
    "-q",
    "-L",
    "--fail",
    "--silent",
    "--show-error",
    // Only HTTPS, for the address itself and for every address it points
    // to, so that a redirect cannot take the download down to plain HTTP.
    "--proto",
    "=https",
    "--proto-redir",
    "=https",
  ];

  // Some machines can only reach the internet through a proxy. The player
  // starts the program without the environment of the user, so the proxy
  // has to be named here.
  const proxy = String(preferences.get("proxy") || "").trim();
  if (proxy) {
    curlArgs.push("--proxy", proxy);
  }

  curlArgs.push("-o", partial, BASE_URL + meta.name);

  const res = await utils.exec("/usr/bin/curl", curlArgs);

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

  // The size is the cheap check, the sum is the one that means something. A
  // model is a program that the engine loads, so a file that was tampered
  // with on the way here would run on the machine of the user.
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

  const digest = await sha256Of(partial);
  if (!digest || digest.toLowerCase() !== meta.sha256.toLowerCase()) {
    try {
      file.delete(partial);
    } catch (e) {
      /* ignore */
    }
    throw new Error(
      "The downloaded file does not match the sum that the upstream " +
        "repository publishes, so it was discarded.\n\n" +
        "Expected: " +
        meta.sha256 +
        "\nGot:      " +
        (digest || "nothing") +
        "\n\n" +
        "The file on the server is not the one this plugin knows. Try a " +
        "later version of the plugin."
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
    const res = await utils.exec("/usr/bin/stat", ["-f", "%z", "--", path]);
    if (res.status !== 0) return null;
    return { size: Number(String(res.stdout).trim()) };
  } catch (e) {
    return null;
  }
}

/**
 * The SHA-256 sum of a file, in lower case.
 */
async function sha256Of(path) {
  try {
    const res = await utils.exec("/usr/bin/shasum", ["-a", "256", "--", path]);
    if (res.status !== 0) return null;
    const digest = String(res.stdout || "").trim().split(/\s+/)[0];
    return /^[0-9a-f]{64}$/i.test(digest) ? digest : null;
  } catch (e) {
    return null;
  }
}

module.exports = { MODELS, MODEL_DIR, modelDirectory, installedModels, download };

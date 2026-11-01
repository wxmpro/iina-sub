const { utils, file, preferences, console } = iina;

const srt = require("./srt.js");

const srtStat = srt.statOf;
const sha256Of = srt.sha256OfFile;

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

/**
 * A mirror that a machine in China can usually reach without a proxy.
 *
 * ModelScope mirrors the collection of whisper.cpp. Two repositories of it
 * hold the models of this catalogue; the files that were fetched from them
 * are byte-identical to the ones the upstream repository publishes, which is
 * what the sum check below is for. A mirror is only ever asked when the
 * upstream address cannot be reached.
 */
const MIRRORS = [
  {
    name: "ModelScope",
    url: (model) =>
      "https://www.modelscope.cn/models/" +
      (MIRROR_REPOS[model] || "cjc1887415157/whisper.cpp") +
      "/resolve/master/" +
      model,
  },
];

/**
 * Which mirror repository holds which model.
 *
 * Every model is checked against the same published sum whatever the source,
 * so a mirror that serves anything else is caught by the check that follows
 * and not by this table.
 */
const MIRROR_REPOS = {
  "ggml-large-v3-turbo-q5_0.bin": "OllmOne/whisper.cpp",
};

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
 * What is known about the models that were looked at.
 *
 * The sum of a model of a gigabyte takes a moment to compute, so the result
 * is kept for as long as the file stays the same.
 */
const modelChecks = new Map();

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

  // A file that is already there is only used when it is the model that the
  // upstream repository publishes. A file that was put there by something
  // else is not taken for the model: a model is a program that the engine
  // loads, so a file that does not match is fetched again.
  if (file.exists(target)) {
    const known = await verifyFile(target, meta);
    if (known) return target;
  }

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

  // The upstream address first, and the mirrors after it when it cannot be
  // reached. The first file that passes the check below is kept; everything
  // else is thrown away.
  const sources = [BASE_URL + meta.name].concat(MIRRORS.map((m) => m.url(meta.name)));
  let res = null;
  let lastError = null;
  for (const source of sources) {
    if (partial !== null && file.exists(partial)) {
      try {
        file.delete(partial);
      } catch (e) {
        /* ignore */
      }
    }
    onProgress({
      phase: "download",
      percent: 0,
      message: "Downloading " + meta.label + (source === sources[0] ? "" : " from a mirror"),
    });
    const attempt = curlArgs.concat(["-o", partial, source]);
    res = await utils.exec("/usr/bin/curl", attempt);
    if (res.status === 0) break;
    lastError = res;
  }

  if (!res || res.status !== 0) {
    try {
      file.delete(partial);
    } catch (e) {
      /* ignore */
    }
    throw new Error(networkFailure(res ? res.status : -1, lastError ? lastError.stderr : "", "model"));
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


/**
 * Turn the exit code of a failed download into something a user can act on.
 *
 * The codes 6, 7, 28, 35 and 60 all mean that the server could not be
 * reached: no name, no connection, no answer, or no trusted connection. In a
 * network where the release pages are blocked, that is what happens, and a
 * bare "exit 28" helps nobody. The proxy setting is named instead.
 */
function networkFailure(status, stderr, what) {
  const detail = String(stderr || "").trim();
  const unreachable = [6, 7, 28, 35, 60].indexOf(Number(status)) !== -1;
  if (!unreachable) {
    return "The " + what + " could not be downloaded (exit " + status + "): " + detail;
  }
  return (
    "The " +
    what +
    " could not be downloaded, because none of the servers could be reached.\n\n" +
    "This happens on a network that blocks the release pages. A mirror " +
    "inside China was tried as well. Either try again later, or open the " +
    "settings of the plugin (Preferences → Plugins → iina-sub) and type the " +
    "address of a proxy into the field Proxy — for example " +
    "http://127.0.0.1:7890.\n\n" +
    "The program tried: " +
    detail
  );
}

/**
 * Whether a file is the model that the upstream repository publishes.
 *
 * Both the size and the sum have to match. The file itself is not touched.
 */
async function verifyFile(path, meta) {
  const stat = await srtStat(path);
  if (!stat || stat.size !== meta.bytes) return false;
  const digest = await sha256Of(path);
  if (!digest) return false;
  return digest.toLowerCase() === meta.sha256.toLowerCase();
}

/**
 * Check a model file that the user chose.
 *
 * A file whose name is one of the models of the catalogue is compared with
 * the sum that the upstream repository publishes, because the engine loads
 * such a file as a program. A file of any other name is one the user brought
 * along, and nothing is known about it.
 *
 * Returns { known, ok, reason }.
 */
async function verifyModelFile(path) {
  if (!path) return { known: false, ok: true, reason: "" };
  const name = String(path).split("/").pop() || "";
  const meta = MODELS.find((m) => m.name === name);
  if (!meta) return { known: false, ok: true, reason: "" };

  const stat = await srtStat(path);
  if (!stat) {
    return { known: true, ok: false, reason: "The model file could not be read." };
  }
  if (stat.size !== meta.bytes) {
    return {
      known: true,
      ok: false,
      reason:
        "The model file has the wrong size (" +
        stat.size +
        ", expected " +
        meta.bytes +
        ").",
    };
  }
  // The sum of a model of a gigabyte takes a moment, so the result is kept
  // for as long as the file stays the same. A file that changed is looked
  // at again.
  const remembered = modelChecks.get(path);
  if (remembered && remembered.size === stat.size && remembered.mtime === stat.mtime) {
    return remembered.result;
  }

  const digest = await sha256Of(path);
  if (!digest) {
    return { known: true, ok: false, reason: "The sum of the model file could not be read." };
  }
  const result =
    digest.toLowerCase() === meta.sha256.toLowerCase()
      ? { known: true, ok: true, reason: "" }
      : {
          known: true,
          ok: false,
          reason:
            "The model file does not carry the sum that the upstream repository " +
            "publishes, so it was not used.\n\nExpected: " +
            meta.sha256 +
            "\nGot:      " +
            digest.toLowerCase(),
        };
  modelChecks.set(path, { size: stat.size, mtime: stat.mtime, result: result });
  return result;
}



module.exports = {
  MODELS,
  networkFailure,
  MODEL_DIR,
  modelDirectory,
  installedModels,
  download,
  verifyFile,
  verifyModelFile,
};

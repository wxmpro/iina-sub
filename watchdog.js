/**
 * Clean up after the plugin is removed.
 *
 * The player removes the folder of the code of a plugin and nothing else:
 * the folder of the data — the models, the transcripts and the audio of the
 * chunks — stays behind, and it holds hundreds of megabytes. The user is
 * told where it is and asked to remove it by hand, which nobody does.
 *
 * The plugin watches its own folder instead. When the folder is gone, the
 * plugin was removed, and the data goes with it.
 *
 * Two things keep this from deleting anything that does not belong to the
 * plugin:
 *
 *   - the folder of the data has to be the one of this plugin, and it is
 *     checked before anything is started;
 *   - nothing is removed unless the folder of the code was there when the
 *     plugin started, so a wrong answer can never lead to a deletion.
 */
const { utils, file, console } = iina;

/** How often the folder of the plugin is looked at, in milliseconds. */
const CHECK_INTERVAL_MS = 15000;

/**
 * The folder the code of the plugin is in.
 *
 * The player does not tell the plugin where it is, but the stack of an
 * error holds the address of the file that is being read, and this file is
 * part of the plugin. The address is read out of it and nothing else is
 * taken for it.
 */
function ownRoot() {
  const stack = String(new Error().stack || "");
  const match = stack.match(/(file:\/\/[^\s)]+?\.iinaplugin)\//);
  if (!match) return "";
  try {
    return decodeURIComponent(match[1]);
  } catch (e) {
    return "";
  }
}

/**
 * The name of the plugin, which is the name of the folder of its code.
 */
function identifierOf(root) {
  const name = String(root || "").split("/").pop() || "";
  return name.replace(/\.iinaplugin$/, "");
}

/**
 * The folder of the data of the plugin.
 *
 * The player gives it when a path in the folder is resolved, so the folder
 * is read out of a path that is known to be in it.
 */
function dataFolderOf() {
  const marker = "iina-sub-data-folder";
  const resolved = utils.resolvePath("@data/" + marker);
  if (!resolved) return "";
  const suffix = "/" + marker;
  if (resolved.length <= suffix.length) return "";
  return resolved.slice(0, resolved.length - suffix.length);
}

/**
 * Check that the folder of the data is the one of this plugin.
 *
 * The folder of the data of the player holds one folder per plugin, named
 * after it. The folder of the code of this plugin is named the same way,
 * with the suffix that the player adds. The two have to belong together,
 * or nothing is removed at all.
 */
function check(root, dataFolder) {
  const name = String(root || "").split("/").pop() || "";
  const identifier = name.replace(/\.iinaplugin$/, "");
  if (!identifier) {
    return { ok: false, reason: "the name of the plugin is not known" };
  }
  if (root.length <= name.length + 1) {
    return { ok: false, reason: "the folder of the plugin is not known" };
  }
  // The folder of the code is one folder in the folder of the plugins, and
  // the name of it is the name of the plugin with the suffix of the player.
  const pluginsFolder = root.slice(0, root.length - name.length - 1);
  const expected = pluginsFolder + "/.data/" + identifier;
  if (dataFolder !== expected) {
    return {
      ok: false,
      reason: "the folder of the data is not the one of this plugin",
      expected: expected,
    };
  }
  return { ok: true, reason: "", expected: expected };
}

/**
 * Start watching the folder of the plugin.
 *
 * Returns true when the watch was started.
 */
function start() {
  const root = ownRoot();
  if (!root) return false;

  const dataFolder = dataFolderOf();
  if (!dataFolder) return false;

  const verdict = check(root, dataFolder);
  if (!verdict.ok) {
    console.warn("iina-sub: the watch of the folder is not started: " + verdict.reason);
    return false;
  }

  // The folder of the plugin has to be there now. If it is not, something is
  // wrong, and nothing is removed at all.
  if (!file.exists(root + "/Info.json")) return false;

  let missing = 0;
  const timer = setInterval(() => {
    if (file.exists(root + "/Info.json")) {
      missing = 0;
      return;
    }

    // The folder is gone for one round. The plugin waits for a second one
    // before it removes anything, so that a plugin that is removed and
    // installed again right away keeps its data.
    missing++;
    if (missing < 2) return;

    clearInterval(timer);
    console.log("iina-sub: the plugin was removed, the data of it goes with it");
    utils.exec("/bin/rm", ["-rf", dataFolder]);
  }, CHECK_INTERVAL_MS);

  return true;
}

module.exports = { start, ownRoot, identifierOf, dataFolderOf, check };

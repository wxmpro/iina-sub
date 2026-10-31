/**
 * A minimal stand in for the `iina` global that IINA injects into plugin
 * scripts. It lets the plugin logic be exercised with plain Node, without a
 * running player.
 *
 * Every call the plugin makes against the player is recorded, so a test can
 * look at what the plugin did instead of how it looked at it.
 */
const fs = require("fs");
const os = require("os");
const path = require("path");

function makeMock(options) {
  const opts = options || {};

  const calls = {
    commands: [],
    osd: [],
    exec: [],
    errors: [],
  };

  const virtualFs = opts.virtualFs || {};

  // The plugin addresses its own files through @data and @tmp. Both are
  // mapped into a scratch folder so that a test never touches a real one.
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-mock-"));
  const dataRoot = path.join(root, "data");
  const tmpRoot = path.join(root, "tmp");
  fs.mkdirSync(dataRoot, { recursive: true });
  fs.mkdirSync(tmpRoot, { recursive: true });

  const api = {
    __calls: calls,
    __virtualFs: virtualFs,
    __root: root,
    __setExecHandler(handler) {
      api.__execHandler = handler;
    },
    __cleanup() {
      fs.rmSync(root, { recursive: true, force: true });
    },
  };

  api.core = {
    osd(message) {
      calls.osd.push(message);
    },
    error(message) {
      calls.errors.push(message);
    },
    status: {
      url: opts.url || "",
      title: opts.title || "",
      duration: opts.duration || 0,
      position: 0,
    },
  };

  api.mpv = {
    command(name, args) {
      calls.commands.push({ name, args });
      return true;
    },
    getString(prop) {
      if (prop === "path") return opts.path || "";
      return null;
    },
    getNumber(prop) {
      if (prop === "duration") return opts.duration || 0;
      if (prop === "time-pos") return opts.position || 0;
      return 0;
    },
    getNative(prop) {
      if (prop === "track-list") return opts.tracks || [];
      return null;
    },
  };

  api.utils = {
    resolvePath(p) {
      if (p.startsWith("@tmp/")) return path.join(tmpRoot, p.slice(5));
      if (p.startsWith("@data/")) return path.join(dataRoot, p.slice(6));
      return p.replace(/^~(?=\/)/, os.homedir());
    },
    fileInPath(p) {
      if (!p) return false;
      const resolved = api.utils.resolvePath(p);
      return fs.existsSync(resolved);
    },
    async exec(command, args, cwd, stdoutHook, stderrHook) {
      calls.exec.push({ command, args: args || [] });
      if (api.__execHandler) {
        const handled = await api.__execHandler(command, args || []);
        if (handled) return handled;
      }
      if (command === "/usr/bin/stat") {
        const target = args[args.length - 1];
        if (!fs.existsSync(target)) {
          return { status: 1, stdout: "", stderr: "no such file" };
        }
        const stat = fs.statSync(target);
        return {
          status: 0,
          stdout: stat.size + "|" + Math.floor(stat.mtimeMs / 1000),
          stderr: "",
        };
      }
      if (command === "/bin/mkdir") {
        try {
          fs.mkdirSync(args[args.length - 1], { recursive: true });
          return { status: 0, stdout: "", stderr: "" };
        } catch (e) {
          return { status: 1, stdout: "", stderr: String(e) };
        }
      }
      if (command === "/bin/cp" || command === "/bin/mv") {
        try {
          const flags = args.filter((a) => a.startsWith("-"));
          const operands = args.filter((a) => !a.startsWith("-"));
          const source = api.utils.resolvePath(operands[0]);
          const dest = api.utils.resolvePath(operands[1]);
          fs.mkdirSync(path.dirname(dest), { recursive: true });
          if (command === "/bin/cp") {
            fs.copyFileSync(source, dest);
          } else {
            fs.renameSync(source, dest);
          }
          return { status: 0, stdout: "", stderr: "" };
        } catch (e) {
          return { status: 1, stdout: "", stderr: String(e) };
        }
      }
      if (command === "/usr/bin/mdls") {
        const seconds = opts.metadataDuration;
        if (seconds === undefined) return { status: 1, stdout: "", stderr: "" };
        return { status: 0, stdout: String(seconds), stderr: "" };
      }
      return { status: 0, stdout: "", stderr: "" };
    },
    ask(message) {
      calls.osd.push("ask: " + message);
      return opts.confirm !== undefined ? opts.confirm : true;
    },
    prompt() {
      return null;
    },
    chooseFile() {
      return null;
    },
  };

  api.file = {
    exists(p) {
      const resolved = api.utils.resolvePath(p);
      if (Object.prototype.hasOwnProperty.call(virtualFs, resolved)) return true;
      return fs.existsSync(resolved);
    },
    read(p) {
      const resolved = api.utils.resolvePath(p);
      if (Object.prototype.hasOwnProperty.call(virtualFs, resolved)) {
        return virtualFs[resolved];
      }
      if (!fs.existsSync(resolved)) return null;
      return fs.readFileSync(resolved, "utf8");
    },
    write(p, content) {
      const resolved = api.utils.resolvePath(p);
      virtualFs[resolved] = content;
      const dir = path.dirname(resolved);
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(resolved, content, "utf8");
    },
    move(source, dest) {
      const s = api.utils.resolvePath(source);
      const d = api.utils.resolvePath(dest);
      if (Object.prototype.hasOwnProperty.call(virtualFs, s)) {
        virtualFs[d] = virtualFs[s];
        delete virtualFs[s];
      }
      if (fs.existsSync(s)) {
        fs.mkdirSync(path.dirname(d), { recursive: true });
        fs.renameSync(s, d);
      }
    },
    delete(p) {
      const resolved = api.utils.resolvePath(p);
      delete virtualFs[resolved];
      if (fs.existsSync(resolved)) fs.unlinkSync(resolved);
    },
    list(dir) {
      const resolved = api.utils.resolvePath(dir);
      if (!fs.existsSync(resolved)) return [];
      return fs.readdirSync(resolved).map((name) => {
        const full = path.join(resolved, name);
        return {
          filename: name,
          path: name,
          isDir: fs.statSync(full).isDirectory(),
        };
      });
    },
    showInFinder() {},
  };

  api.preferences = {
    defaultPreferences: Object.assign({}, opts.defaultPreferences || {}),
    store: Object.assign({}, opts.preferences || {}),
    get(key) {
      if (Object.prototype.hasOwnProperty.call(this.store, key)) return this.store[key];
      if (Object.prototype.hasOwnProperty.call(this.defaultPreferences, key)) {
        return this.defaultPreferences[key];
      }
      return undefined;
    },
    set(key, value) {
      this.store[key] = value;
    },
    sync() {},
  };

  api.menu = {
    items: [],
    item(title, action, options) {
      return { title, action, options: options || {}, selected: false };
    },
    separator() {
      return { separator: true };
    },
    addItem(item) {
      this.items.push(item);
    },
    removeAllItems() {
      this.items = [];
    },
  };

  api.event = {
    handlers: {},
    on(name, callback) {
      this.handlers[name] = callback;
      return name;
    },
    off(name) {
      delete this.handlers[name];
    },
    emit(name, payload) {
      if (this.handlers[name]) return this.handlers[name](payload);
    },
  };

  api.sidebar = {
    messages: [],
    listeners: {},
    loadFile() {},
    show() {},
    hide() {},
    postMessage(name, data) {
      this.messages.push({ name, data });
    },
    onMessage(name, callback) {
      this.listeners[name] = callback;
      return name;
    },
  };

  api.console = {
    log: (...a) => calls.log && calls.log.push(a.join(" ")),
    warn: (...a) => calls.warn && calls.warn.push(a.join(" ")),
    error: (...a) => calls.errors.push(a.join(" ")),
  };

  api.calls = calls;
  return api;
}

module.exports = { makeMock };

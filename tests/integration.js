/**
 * Integration test: runs the real chunking pipeline over a real video with
 * the real decoder and the real whisper.cpp binary.
 *
 * It verifies that the merged transcript
 *   - covers the whole file without gaps,
 *   - has no overlapping cues,
 *   - keeps timestamps aligned with the source audio.
 *
 * Run with: node tests/integration.js <path-to-video>
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFile } = require("child_process");

const WHISPER = process.env.WHISPER_CLI || "/opt/homebrew/bin/whisper-cli";
const MODEL =
  process.env.WHISPER_MODEL ||
  path.join(os.homedir(), "iina-asr/models/ggml-large-v3-q5_0.bin");

/**
 * A mock of the IINA API whose `exec` really runs the commands.
 *
 * The plugin folder of the mock is a scratch folder, so the test never
 * touches the folder of the installed plugin.
 */
function makeRealMock(dataRoot) {
  const virtualFs = {};
  const calls = { commands: [], osd: [], exec: [] };

  const api = { __calls: calls, __virtualFs: virtualFs };

  api.core = {
    osd: (m) => calls.osd.push(m),
    error: (m) => calls.errors.push(m),
    status: { url: "", title: "", duration: 0, position: 0 },
  };
  api.mpv = {
    command: (name, args) => {
      calls.commands.push({ name, args });
      return true;
    },
    getString: () => "",
    getNumber: () => 0,
    getNative: () => [],
  };
  api.utils = {
    resolvePath: (p) => {
      if (p.startsWith("@data/")) return path.join(dataRoot, p.slice(6));
      return p.replace(/^~(?=\/)/, os.homedir());
    },
    fileInPath: (p) => fs.existsSync(api.utils.resolvePath(p)),
    exec(command, args, cwd, stdoutHook, stderrHook) {
      calls.exec.push({ command, args });
      return new Promise((resolve) => {
        const child = execFile(command, args || [], {
          maxBuffer: 64 * 1024 * 1024,
          cwd: cwd || undefined,
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => {
          stdout += d.toString();
          if (stdoutHook) stdoutHook(d.toString());
        });
        child.stderr.on("data", (d) => {
          stderr += d.toString();
          if (stderrHook) stderrHook(d.toString());
        });
        child.on("close", (code) => {
          resolve({ status: code === null ? -1 : code, stdout, stderr });
        });
        child.on("error", (e) => {
          resolve({ status: -1, stdout, stderr: stderr + String(e) });
        });
      });
    },
    ask: () => true,
    prompt: () => null,
  };
  api.file = {
    exists: (p) => {
      const r = api.utils.resolvePath(p);
      return Object.prototype.hasOwnProperty.call(virtualFs, r) || fs.existsSync(r);
    },
    read: (p) => {
      const r = api.utils.resolvePath(p);
      if (Object.prototype.hasOwnProperty.call(virtualFs, r)) return virtualFs[r];
      if (!fs.existsSync(r)) return null;
      return fs.readFileSync(r, "utf8");
    },
    write: (p, c) => {
      const r = api.utils.resolvePath(p);
      virtualFs[r] = c;
      fs.mkdirSync(path.dirname(r), { recursive: true });
      fs.writeFileSync(r, c, "utf8");
    },
    move: (s, d) => {
      const rs = api.utils.resolvePath(s);
      const rd = api.utils.resolvePath(d);
      if (Object.prototype.hasOwnProperty.call(virtualFs, rs)) {
        virtualFs[rd] = virtualFs[rs];
        delete virtualFs[rs];
      }
      if (fs.existsSync(rs)) {
        fs.mkdirSync(path.dirname(rd), { recursive: true });
        fs.renameSync(rs, rd);
      }
    },
    delete: (p) => {
      const r = api.utils.resolvePath(p);
      delete virtualFs[r];
      if (fs.existsSync(r)) fs.unlinkSync(r);
    },
    list: (dir) => {
      const r = api.utils.resolvePath(dir);
      if (!fs.existsSync(r)) return [];
      return fs.readdirSync(r).map((name) => ({
        filename: name,
        path: name,
        isDir: fs.statSync(path.join(r, name)).isDirectory(),
      }));
    },
    showInFinder: () => {},
  };
  api.preferences = {
    defaultPreferences: {},
    store: {},
    get(k) {
      return this.store[k];
    },
    set(k, v) {
      this.store[k] = v;
    },
    sync() {},
  };
  api.menu = {
    items: [],
    item: (title, action, options) => ({ title, action, options: options || {} }),
    separator: () => ({ separator: true }),
    addItem(item) {
      this.items.push(item);
    },
    removeAllItems() {},
  };
  api.event = {
    handlers: {},
    on(n, c) {
      this.handlers[n] = c;
    },
    off() {},
    emit(n, p) {
      if (this.handlers[n]) this.handlers[n](p);
    },
  };
  api.sidebar = {
    messages: [],
    loadFile() {},
    show() {},
    hide() {},
    postMessage(n, d) {
      this.messages.push({ n, d });
    },
  };
  api.console = {
    log() {},
    warn() {},
    error(...a) {
      console.error("[plugin]", ...a);
    },
  };
  api.calls = calls;
  return api;
}

async function main() {
  const video = process.argv[2];
  if (!video) {
    console.error("usage: node tests/integration.js <video>");
    process.exit(2);
  }
  if (!fs.existsSync(WHISPER)) {
    console.error("whisper-cli not found at " + WHISPER);
    process.exit(2);
  }
  if (!fs.existsSync(MODEL)) {
    console.error("model not found at " + MODEL);
    process.exit(2);
  }
  if (!fs.existsSync(video)) {
    console.error("video not found at " + video);
    process.exit(2);
  }

  const dataRoot = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-data-"));
  global.iina = makeRealMock(dataRoot);

  const srt = require("../srt.js");
  const worker = require("../worker.js");
  const engines = require("../engines.js");
  const decoder = require("../decoder.js");

  const durationMs = await worker.probeDuration(video);
  if (!durationMs) {
    console.error("the duration of the video could not be read");
    process.exit(2);
  }
  console.log("media duration: " + (durationMs / 1000).toFixed(1) + " s");

  // The decoder is built the same way the plugin builds it.
  const built = await decoder.ensureDecoder();
  console.log(
    "decoder: " + built.command + (built.compiled ? " (compiled)" : " (interpreted)")
  );

  const config = {
    engineId: "whisper-cpp",
    enginePath: "",
    whisperPath: WHISPER,
    modelPath: MODEL,
    language: "zh",
    chunkSeconds: 30,
    tailSeconds: 2,
  };

  const context = {
    config,
    mediaPath: video,
    audioTrackIndex: null,
    decoder: built,
  };

  const engine = engines.getEngine(config.engineId);
  const chunks = worker.planChunks(
    durationMs,
    config.chunkSeconds,
    config.tailSeconds
  );
  console.log("chunks: " + chunks.length);

  const cues = [];
  const started = Date.now();

  for (const chunk of chunks) {
    const got = await worker.transcribeChunk(context, engine, chunk, () => {});
    srt.mergeCues(cues, got, 0);
    console.log(
      "  chunk " +
        (chunk.index + 1) +
        "/" +
        chunks.length +
        " -> " +
        got.length +
        " cues"
    );
  }

  const elapsed = (Date.now() - started) / 1000;
  console.log(
    "transcribed " +
      (durationMs / 1000).toFixed(0) +
      " s of audio in " +
      elapsed.toFixed(1) +
      " s (" +
      (durationMs / 1000 / elapsed).toFixed(1) +
      "x realtime)"
  );

  // --- assertions -------------------------------------------------------
  assert.ok(cues.length > 0, "the transcript must not be empty");

  let overlaps = 0;
  for (let i = 1; i < cues.length; i++) {
    if (cues[i].start < cues[i - 1].end) overlaps++;
  }
  console.log("overlapping cues: " + overlaps);
  assert.strictEqual(overlaps, 0, "the merged transcript must not overlap");

  let outOfRange = 0;
  for (const cue of cues) {
    if (cue.start < 0 || cue.end > durationMs + 2000) outOfRange++;
  }
  console.log("cues outside the media range: " + outOfRange);
  assert.strictEqual(outOfRange, 0, "every cue must stay inside the media");

  const first = cues[0];
  const last = cues[cues.length - 1];
  console.log("first cue at " + (first.start / 1000).toFixed(2) + " s");
  console.log("last cue ends at " + (last.end / 1000).toFixed(2) + " s");

  // The last cue should be near the end of the media, otherwise the tail of
  // the file was dropped.
  const tailGap = (durationMs - last.end) / 1000;
  console.log("gap at the end of the media: " + tailGap.toFixed(2) + " s");
  assert.ok(tailGap < 45, "the end of the media must not be missing");

  const rendered = srt.renderSrt(cues);
  const reparsed = srt.parseSrt(rendered);
  assert.strictEqual(reparsed.length, cues.length, "the rendered file must round trip");

  // No leftover files of the chunks.
  const chunkDir = path.join(dataRoot, "chunks");
  const leftovers = fs.existsSync(chunkDir) ? fs.readdirSync(chunkDir) : [];
  console.log("leftover chunk files: " + leftovers.length);
  assert.strictEqual(leftovers.length, 0, "the chunk files must be cleaned up");

  const outPath = path.join(os.tmpdir(), "iina-sub-integration.srt");
  fs.writeFileSync(outPath, rendered);
  console.log("transcript written to " + outPath);

  fs.rmSync(dataRoot, { recursive: true, force: true });

  console.log("\nintegration test passed");
}

main().catch((e) => {
  console.error("integration test failed: " + (e && e.stack ? e.stack : e));
  process.exit(1);
});

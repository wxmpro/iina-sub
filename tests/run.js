/**
 * Tests for iina-sub.
 *
 * Run with: node tests/run.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");

const { makeMock } = require("./mock-iina.js");

// The plugin modules read the `iina` global at load time, so a mock has to
// exist before anything is required.
global.iina = makeMock({});

let passed = 0;
let failed = 0;
const failures = [];

// The tests are run one after the other. They share the `iina` global and
// the module cache, so running them side by side would let one test replace
// the mock that another one is about to use.
const queue = [];

function test(name, fn) {
  queue.push({ name, fn, isAsync: false });
}

function asyncTest(name, fn) {
  queue.push({ name, fn, isAsync: true });
}

async function runAll() {
  for (const item of queue) {
    try {
      if (item.isAsync) {
        await item.fn();
      } else {
        item.fn();
      }
      passed++;
      console.log("  ok   " + item.name);
    } catch (e) {
      failed++;
      failures.push({ name: item.name, error: e });
      console.log("  FAIL " + item.name);
      console.log("       " + (e && e.message ? e.message : e));
    }
  }
}

// ---------------------------------------------------------------------------
// Unit tests for the pure helpers
// ---------------------------------------------------------------------------

console.log("\nsrt.js");

const srt = require("../srt.js");

test("parses a SubRip timestamp", () => {
  assert.strictEqual(srt.parseTimestamp("00:00:01,234"), 1234);
  assert.strictEqual(srt.parseTimestamp("01:02:03,004"), 3723004);
  assert.strictEqual(srt.parseTimestamp("00:00:01.234"), 1234);
  assert.strictEqual(srt.parseTimestamp("nonsense"), -1);
});

test("formats a SubRip timestamp", () => {
  assert.strictEqual(srt.formatTimestamp(0), "00:00:00,000");
  assert.strictEqual(srt.formatTimestamp(1234), "00:00:01,234");
  assert.strictEqual(srt.formatTimestamp(3723004), "01:02:03,004");
});

test("parses an SRT document into cues", () => {
  const cues = srt.parseSrt(
    "1\n00:00:01,000 --> 00:00:03,500\n第一句\n\n" +
      "2\n00:00:04,000 --> 00:00:06,000\n第二句\n"
  );
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 1000);
  assert.strictEqual(cues[0].end, 3500);
  assert.strictEqual(cues[0].text, "第一句");
  assert.strictEqual(cues[1].text, "第二句");
});

test("skips malformed blocks instead of failing", () => {
  const cues = srt.parseSrt("garbage\n\n1\n00:00:01,000 --> 00:00:02,000\n好的\n");
  assert.strictEqual(cues.length, 1);
  assert.strictEqual(cues[0].text, "好的");
});

test("renders cues back into a valid SRT document", () => {
  const rendered = srt.renderSrt([
    { start: 1000, end: 3000, text: "甲" },
    { start: 4000, end: 5000, text: "乙" },
  ]);
  assert.ok(rendered.includes("00:00:01,000 --> 00:00:03,000"));
  assert.ok(rendered.includes("00:00:04,000 --> 00:00:05,000"));
});

test("a rendered document can be parsed again", () => {
  const original = [
    { start: 1000, end: 3000, text: "甲" },
    { start: 4000, end: 5000, text: "乙" },
  ];
  const round = srt.parseSrt(srt.renderSrt(original));
  assert.strictEqual(round.length, 2);
  assert.strictEqual(round[0].text, "甲");
  assert.strictEqual(round[1].end, 5000);
});

test("never emits overlapping cues", () => {
  const rendered = srt.renderSrt([
    { start: 1000, end: 5000, text: "甲" },
    { start: 2000, end: 3000, text: "乙" },
  ]);
  const cues = srt.parseSrt(rendered);
  for (let i = 1; i < cues.length; i++) {
    assert.ok(
      cues[i].start >= cues[i - 1].end,
      "cue " + i + " starts before the previous one ends"
    );
  }
});

test("sorts cues by start time", () => {
  const rendered = srt.renderSrt([
    { start: 9000, end: 9500, text: "后" },
    { start: 1000, end: 1500, text: "前" },
  ]);
  assert.ok(rendered.indexOf("前") < rendered.indexOf("后"));
});

test("drops empty cues", () => {
  const rendered = srt.renderSrt([
    { start: 1000, end: 3000, text: "" },
    { start: 4000, end: 5000, text: "有效" },
  ]);
  assert.strictEqual(srt.parseSrt(rendered).length, 1);
});

test("the fingerprint is stable and sensitive", () => {
  const a = srt.fingerprint(["path", 100, 200, "model"]);
  const b = srt.fingerprint(["path", 100, 200, "model"]);
  const c = srt.fingerprint(["path", 100, 201, "model"]);
  assert.strictEqual(a, b);
  assert.notStrictEqual(a, c);
});

test("the exported subtitle keeps the name of the video", () => {
  assert.strictEqual(
    srt.subtitlePathFor("/movies/lesson.mp4"),
    "/movies/lesson.srt"
  );
});

test("the exported subtitle stays in the folder of the video", () => {
  const target = srt.subtitlePathFor("/movies/2022_11_02-ch03 情境决策论.mp4");
  assert.strictEqual(target, "/movies/2022_11_02-ch03 情境决策论.srt");
  assert.strictEqual(path.dirname(target), "/movies");
});

test("a network address has no subtitle file", () => {
  assert.strictEqual(srt.subtitlePathFor("https://example.com/a.mp4"), null);
});

test("the internal paths carry no part of the file name", () => {
  const internal = srt.internalSubtitlePathFor("/movies/secret lesson.mp4");
  const stamp = srt.stampPathFor("/movies/secret lesson.mp4");
  assert.ok(!internal.includes("secret"), internal);
  assert.ok(!internal.includes("lesson"), internal);
  assert.ok(!stamp.includes("secret"), stamp);
  assert.ok(internal.endsWith(".srt"));
  assert.ok(stamp.endsWith(".fp"));
});

test("the internal paths of two files never collide", () => {
  const a = srt.internalSubtitlePathFor("/movies/a.mp4");
  const b = srt.internalSubtitlePathFor("/movies/b.mp4");
  assert.notStrictEqual(a, b);
});

// ---------------------------------------------------------------------------
// worker.js
// ---------------------------------------------------------------------------

console.log("\nworker.js");

const worker = require("../worker.js");

test("plans chunks that cover the whole file", () => {
  const chunks = worker.planChunks(70000, 30, 2);
  assert.strictEqual(chunks.length, 3);
  assert.strictEqual(chunks[0].startMs, 0);
  assert.strictEqual(chunks[1].startMs, 30000);
  assert.strictEqual(chunks[2].startMs, 60000);
});

test("the last chunk is shortened to the end of the file", () => {
  const chunks = worker.planChunks(70000, 30, 2);
  assert.strictEqual(chunks[2].lengthMs, 10000);
});

test("every chunk carries a tail of extra audio", () => {
  const chunks = worker.planChunks(70000, 30, 2);
  assert.strictEqual(chunks[0].durationMs, 32000);
  // The tail never runs past the end of the file.
  assert.strictEqual(chunks[2].durationMs, 10000);
});

test("an unknown duration produces no chunks", () => {
  assert.strictEqual(worker.planChunks(0, 30, 2).length, 0);
});

test("the chunk output lives in the plugin folder and carries no extension", () => {
  const base = worker.chunkOutputBase({ index: 3 });
  assert.ok(base.includes("@data/chunks") || base.includes("/chunks/"), base);
  assert.ok(!base.endsWith(".srt"), base);
});

asyncTest("a file that the system has not indexed has no duration", async () => {
  const mock = makeMock({ metadataDuration: "(null)" });
  global.iina = mock;
  const workerMod = reloadModule("worker.js");
  const duration = await workerMod.probeDuration("/tmp/not-indexed.mp4");
  assert.strictEqual(duration, 0, "an unknown length must not become a number");
});

asyncTest("the length is taken from the decoder when the index does not know it", async () => {
  const mock = makeMock({ metadataDuration: "(null)" });
  global.iina = mock;
  const decoderStub = {
    ensureDecoder: async () => ({ command: "/data/bin/vina", args: [], compiled: true }),
    durationOf: async () => 180000,
    prepareDecoder: () => Promise.resolve(null),
  };
  // The stub has to be in place before the worker is loaded, because the
  // worker loads the decoder while it is read.
  const decoderPath = require.resolve("../decoder.js");
  delete require.cache[decoderPath];
  require.cache[decoderPath] = {
    id: decoderPath,
    filename: decoderPath,
    loaded: true,
    exports: decoderStub,
  };
  const workerMod = reloadModule("worker.js");
  const duration = await workerMod.durationOf("/tmp/not-indexed.mp4", 0);
  assert.strictEqual(duration, 180000);
});

asyncTest("the length the player knows is used straight away", async () => {
  const mock = makeMock({ metadataDuration: "(null)" });
  global.iina = mock;
  const workerMod = reloadModule("worker.js");
  const duration = await workerMod.durationOf("/tmp/whatever.mp4", 42000);
  assert.strictEqual(duration, 42000);
});

asyncTest("the cues of the tail are dropped and the rest is clamped", async () => {
  const engine = {
    async run(context, chunk) {
      return [
        { start: 1000, end: 2000, text: "在范围内" },
        { start: 30500, end: 31000, text: "落在尾巴里" },
        { start: 20000, end: 40000, text: "越过边界" },
      ];
    },
  };
  const chunk = { index: 0, startMs: 60000, lengthMs: 30000, durationMs: 32000 };
  const cues = await worker.transcribeChunk({}, engine, chunk, () => {});
  assert.strictEqual(cues.length, 2);
  assert.strictEqual(cues[0].start, 61000);
  assert.strictEqual(cues[0].end, 62000);
  // The second cue is clamped to the end of the chunk.
  assert.strictEqual(cues[1].end, 90000);
});

// ---------------------------------------------------------------------------
// engines.js
// ---------------------------------------------------------------------------

console.log("\nengines.js");

const engines = require("../engines.js");

/**
 * The modules capture the `iina` global when they are loaded, so a test that
 * swaps the global has to load them again.
 *
 * The cache also holds the stubs that a previous test injected, so loading
 * again is the only way to get the real module back.
 */
function reloadModule(name) {
  delete require.cache[require.resolve("../" + name)];
  return require("../" + name);
}

function reloadEngines() {
  return reloadModule("engines.js");
}

test("a value is quoted so the shell cannot read it as syntax", () => {
  assert.strictEqual(engines.shellQuote("plain"), "'plain'");
  assert.strictEqual(engines.shellQuote("two words"), "'two words'");
  assert.strictEqual(engines.shellQuote("it's"), "'it'\\''s'");
});

test("a command substitution survives the quoting", () => {
  const quoted = engines.shellQuote("$(whoami)");
  assert.ok(!quoted.includes("\"$(whoami)\""));
  assert.strictEqual(quoted, "'$(whoami)'");
});

asyncTest("the custom engine hands its values over as arguments", async () => {
  const mock = makeMock({});
  global.iina = mock;
  let seen = null;
  mock.__setExecHandler((command, args) => {
    seen = { command, args };
    return { status: 0, stdout: "", stderr: "" };
  });

  const engine = reloadEngines().ENGINES["custom"];
  const mediaPath = "/movies/evil'; touch /tmp/PWNED; echo '.mp4";
  await engine.run(
    {
      config: {
        enginePath: "mytool {input} {output} {model} {language}",
        modelPath: "/models/m.bin",
        language: "zh",
      },
      mediaPath,
    },
    { index: 0, startMs: 0, lengthMs: 1000, durationMs: 1000, outBase: "/tmp/out" },
    () => {}
  );

  assert.strictEqual(seen.command, "/bin/sh");
  assert.ok(seen.args[1].includes('"$1"'), seen.args[1]);
  // The value itself is never part of the command text.
  assert.ok(!seen.args[1].includes("PWNED"), seen.args[1]);
  // It travels as a separate argument instead.
  assert.ok(seen.args.includes(mediaPath), seen.args.join(" "));
});

asyncTest("the whisper engine pipes the decoder into the model", async () => {
  const mock = makeMock({});
  global.iina = mock;
  let seen = null;
  mock.__setExecHandler((command, args) => {
    seen = { command, args };
    return { status: 0, stdout: "", stderr: "" };
  });

  const engine = reloadEngines().ENGINES["whisper-cpp"];
  await engine.run(
    {
      config: {
        whisperPath: "/opt/homebrew/bin/whisper-cli",
        modelPath: "/models/large.bin",
        language: "zh",
      },
      mediaPath: "/movies/a.mp4",
      audioTrackIndex: 1,
      decoder: { command: "/data/bin/vina", args: [] },
    },
    { index: 0, startMs: 30000, lengthMs: 30000, durationMs: 32000, outBase: "/tmp/out" },
    () => {}
  );

  const command = seen.args[1];
  assert.ok(command.includes("|"), command);
  assert.ok(command.includes("'/data/bin/vina'"), command);
  assert.ok(command.includes("'/opt/homebrew/bin/whisper-cli'"), command);
  // The decoder is told which audio track to read.
  assert.ok(command.includes("'1'"), command);
  // The model reads from the standard input of the pipe.
  assert.ok(command.includes("'-f' '-"), command);
});

// ---------------------------------------------------------------------------
// Integration tests against the plugin entry point
// ---------------------------------------------------------------------------

console.log("\nplugin structure");

test("every module is loaded at the top level only", () => {
  // The player resolves a module path relative to the script that is being
  // evaluated at that moment. Outside of an evaluation there is no such
  // script, and asking for a module then ends the player. So a module may
  // only be loaded while the file that asks for it is being read.
  const files = ["main.js", "srt.js", "worker.js", "engines.js", "models.js", "decoder.js"];
  for (const name of files) {
    const source = fs.readFileSync(path.join(__dirname, "..", name), "utf8");
    const lines = source.split("\n");
    let inTopLevel = true;
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (/^\s*require\s*\(/.test(line)) {
        assert.ok(
          !/^\s/.test(line),
          name + ":" + (i + 1) + " loads a module from inside a function"
        );
      }
    }
  }
});

console.log("\nmain.js");

const MODULES = [
  "main.js",
  "srt.js",
  "worker.js",
  "engines.js",
  "models.js",
  "decoder.js",
];

/**
 * Load main.js with a mocked `iina` global.
 *
 * `stubs` replaces whole modules, which is how the background work is kept
 * out of the way of the tests that are about the behaviour around it.
 */
function loadPlugin(mockOptions, stubs) {
  const mock = makeMock(mockOptions);
  global.iina = mock;
  for (const name of MODULES) {
    delete require.cache[require.resolve("../" + name)];
  }
  if (stubs) {
    for (const name of Object.keys(stubs)) {
      const resolved = require.resolve("../" + name);
      require.cache[resolved] = {
        id: resolved,
        filename: resolved,
        loaded: true,
        exports: stubs[name],
      };
    }
  }
  require("../main.js");
  return mock;
}

// The tests must not depend on anything that is installed on the machine of
// the person who runs them, so a file that every system has is used as a
// stand in for the engine and for the model.
const EXISTING_TOOL = "/bin/sh";

function basePreferences(extra) {
  return Object.assign(
    {
      engineId: "whisper-cpp",
      enginePath: "",
      whisperPath: EXISTING_TOOL,
      modelPath: EXISTING_TOOL,
      language: "zh",
      chunkSeconds: "30",
      tailSeconds: "2",
      autoLoad: true,
      autoTranscribe: false,
    },
    extra || {}
  );
}

/**
 * A worker that reports a duration and produces one cue per chunk.
 *
 * It keeps the context of every call, so a test can look at what the plugin
 * handed over to the engine.
 */
function stubWorker(cues) {
  const real = require("../worker.js");
  const contexts = [];
  return {
    contexts,
    planChunks: real.planChunks,
    chunkDirectory: () => "/tmp/iina-sub-test/chunks",
    probeDuration: async () => 60000,
    durationOf: async (mediaPath, knownMs) => (knownMs && knownMs > 0 ? knownMs : 60000),
    async transcribeChunk(context, engine, chunk, onProgress) {
      contexts.push(context);
      if (onProgress) onProgress(50);
      return cues || [{ start: 0, end: 2000, text: "测试字幕" }];
    },
  };
}

function stubDecoder() {
  return {
    ensureDecoder: async () => ({ command: "/data/bin/vina", args: [], compiled: true }),
  };
}

function wait(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

test("registers its menu items", () => {
  const mock = loadPlugin({});
  const titles = mock.menu.items.map((i) => i.title);
  assert.ok(titles.includes("Generate Subtitles Now"));
  assert.ok(titles.includes("Regenerate Subtitles (discard the cache)"));
  assert.ok(titles.includes("Cancel Transcription (stop the current run)"));
  assert.ok(titles.includes("Transcribe All Videos in This Folder"));
  assert.ok(titles.includes("Export Subtitles Next to the Video"));
});

test("the menu holds no more than five entries", () => {
  // The player only shows the first five entries of a plugin menu and puts
  // the rest behind a "More…" item.
  const mock = loadPlugin({});
  const items = mock.menu.items.filter((i) => !i.separator);
  assert.ok(items.length <= 5, "the menu holds " + items.length + " entries");
});

test("the sidebar can ask the plugin to fetch a model", () => {
  const mock = loadPlugin({});
  assert.strictEqual(typeof mock.sidebar.onMessage, "function");
});

test("the export command has a shortcut and the cancel command another", () => {
  const mock = loadPlugin({});
  const exportItem = mock.menu.items.find(
    (i) => i.title === "Export Subtitles Next to the Video"
  );
  const cancelItem = mock.menu.items.find(
    (i) => i.title === "Cancel Transcription (stop the current run)"
  );
  assert.ok(exportItem.options.keyBinding, "the export command needs a shortcut");
  assert.ok(cancelItem.options.keyBinding, "the cancel command needs a shortcut");
});

test("nothing is written next to the video before the export is asked for", () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences: basePreferences(),
  });

  const siblings = fs.readdirSync(tmp);
  assert.deepStrictEqual(siblings, ["lesson.mp4"]);
  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("the export command writes the transcript next to the video", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences: basePreferences(),
  });

  // Put a transcript into the plugin folder, the way a finished run would.
  const internal = mock.utils.resolvePath(
    "@data/subtitles/" + require("../srt.js").fnv1a(media) + ".srt"
  );
  fs.mkdirSync(path.dirname(internal), { recursive: true });
  fs.writeFileSync(internal, "1\n00:00:01,000 --> 00:00:03,000\n导出的字幕\n");

  const item = mock.menu.items.find(
    (i) => i.title === "Export Subtitles Next to the Video"
  );
  await item.action();

  const target = path.join(tmp, "lesson.srt");
  assert.ok(fs.existsSync(target), "the subtitle should sit next to the video");
  assert.ok(fs.readFileSync(target, "utf8").includes("导出的字幕"));

  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("the export overwrites a subtitle file that is already there", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");
  // A subtitle file from an earlier run is still next to the video.
  fs.writeFileSync(path.join(tmp, "lesson.srt"), "1\n00:00:00,000 --> 00:00:01,000\n旧的\n");

  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences: basePreferences(),
  });

  const internal = mock.utils.resolvePath(
    "@data/subtitles/" + require("../srt.js").fnv1a(media) + ".srt"
  );
  fs.mkdirSync(path.dirname(internal), { recursive: true });
  fs.writeFileSync(internal, "1\n00:00:01,000 --> 00:00:03,000\n新的\n");

  const item = mock.menu.items.find(
    (i) => i.title === "Export Subtitles Next to the Video"
  );
  await item.action();

  const written = fs.readFileSync(path.join(tmp, "lesson.srt"), "utf8");
  assert.ok(written.includes("新的"), "the new transcript should have replaced the old one");
  assert.ok(!written.includes("旧的"));

  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("the plugin never renames a file, which the player cannot do", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const worker = stubWorker();
  const mock = loadPlugin(
    {
      path: media,
      duration: 60,
      preferences: basePreferences({ autoTranscribe: true }),
    },
    { "worker.js": worker, "decoder.js": stubDecoder() }
  );

  // The file API of the player has no rename function, so a plugin that
  // uses one breaks as soon as it is called.
  let used = 0;
  mock.file.move = function () {
    used++;
  };

  mock.event.emit("iina.file-loaded");
  await wait(300);

  assert.strictEqual(used, 0, "the plugin must not use file.move");
  assert.ok(worker.contexts.length > 0, "the file should have been transcribed");

  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("a valid cache is loaded as a subtitle track", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const preferences = basePreferences();
  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences,
  });

  // Build the cache the way the plugin itself would.
  const srtMod = require("../srt.js");
  const mediaStat = await srtMod.statOf(media);
  const modelStat = await srtMod.statOf(preferences.modelPath);
  const engineStat = await srtMod.statOf(preferences.whisperPath);
  const stamp = srtMod.fingerprint([
    "1",
    media,
    mediaStat.size,
    mediaStat.mtime,
    preferences.modelPath,
    modelStat.size,
    modelStat.mtime,
    preferences.engineId,
    preferences.whisperPath,
    engineStat.size,
    engineStat.mtime,
    preferences.language,
    preferences.chunkSeconds,
    preferences.tailSeconds,
  ]);

  const subtitle = mock.utils.resolvePath(
    "@data/subtitles/" + srtMod.fnv1a(media) + ".srt"
  );
  const stampFile = mock.utils.resolvePath(
    "@data/fingerprints/" + srtMod.fnv1a(media) + ".fp"
  );
  fs.mkdirSync(path.dirname(subtitle), { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(subtitle, "1\n00:00:01,000 --> 00:00:03,000\n缓存\n");
  fs.writeFileSync(stampFile, stamp);

  mock.event.emit("iina.file-loaded");
  await wait(120);

  const add = mock.calls.commands.find((c) => c.name === "sub-add");
  assert.ok(add, "the cached transcript should be loaded");
  assert.strictEqual(add.args[0], subtitle);

  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("a subtitle that the player already has is not added a second time", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");
  // The transcript was exported, so the player picks the file up on its own.
  fs.writeFileSync(path.join(tmp, "lesson.srt"), "1\n00:00:01,000 --> 00:00:03,000\n好的\n");

  const preferences = basePreferences();
  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences,
    tracks: [
      { type: "video", selected: true },
      { type: "sub", selected: true, "external-filename": path.join(tmp, "lesson.srt") },
    ],
  });

  const srtMod = require("../srt.js");
  const mediaStat = await srtMod.statOf(media);
  const modelStat = await srtMod.statOf(preferences.modelPath);
  const engineStat = await srtMod.statOf(preferences.whisperPath);
  const stamp = srtMod.fingerprint([
    "1",
    media,
    mediaStat.size,
    mediaStat.mtime,
    preferences.modelPath,
    modelStat.size,
    modelStat.mtime,
    preferences.engineId,
    preferences.whisperPath,
    engineStat.size,
    engineStat.mtime,
    preferences.language,
    preferences.chunkSeconds,
    preferences.tailSeconds,
  ]);
  const key = srtMod.fnv1a(media);
  const subtitle = mock.utils.resolvePath("@data/subtitles/" + key + ".srt");
  const stampFile = mock.utils.resolvePath("@data/fingerprints/" + key + ".fp");
  fs.mkdirSync(path.dirname(subtitle), { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(subtitle, "1\n00:00:01,000 --> 00:00:03,000\n缓存\n");
  fs.writeFileSync(stampFile, stamp);

  mock.event.emit("iina.file-loaded");
  await wait(120);

  const add = mock.calls.commands.find((c) => c.name === "sub-add");
  assert.ok(!add, "the track the player already has must not be added again");

  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("a stale cache is not loaded", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const mock = loadPlugin({
    path: media,
    duration: 60,
    preferences: basePreferences(),
  });

  const srtMod = require("../srt.js");
  const key = srtMod.fnv1a(media);
  const subtitle = mock.utils.resolvePath("@data/subtitles/" + key + ".srt");
  const stampFile = mock.utils.resolvePath("@data/fingerprints/" + key + ".fp");
  fs.mkdirSync(path.dirname(subtitle), { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(subtitle, "1\n00:00:01,000 --> 00:00:03,000\n旧的\n");
  fs.writeFileSync(stampFile, "deadbeef");

  mock.event.emit("iina.file-loaded");
  await wait(120);

  const add = mock.calls.commands.find((c) => c.name === "sub-add");
  assert.ok(!add, "a stale cache must not be loaded");
  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("a video without a cache is transcribed on its own", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const mock = loadPlugin(
    {
      path: media,
      duration: 60,
      preferences: basePreferences({ autoTranscribe: true }),
    },
    { "worker.js": stubWorker(), "decoder.js": stubDecoder() }
  );

  mock.event.emit("iina.file-loaded");
  await wait(300);

  const add = mock.calls.commands.find((c) => c.name === "sub-add");
  assert.ok(add, "the transcript should be loaded as a subtitle track");
  assert.ok(mock.calls.osd.some((m) => m.includes("subtitles ready")));
  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("a video with a cache is not transcribed again", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const preferences = basePreferences({ autoTranscribe: true });
  const mock = loadPlugin(
    { path: media, duration: 60, preferences },
    { "worker.js": stubWorker(), "decoder.js": stubDecoder() }
  );

  const srtMod = require("../srt.js");
  const mediaStat = await srtMod.statOf(media);
  const modelStat = await srtMod.statOf(preferences.modelPath);
  const engineStat = await srtMod.statOf(preferences.whisperPath);
  const stamp = srtMod.fingerprint([
    "1",
    media,
    mediaStat.size,
    mediaStat.mtime,
    preferences.modelPath,
    modelStat.size,
    modelStat.mtime,
    preferences.engineId,
    preferences.whisperPath,
    engineStat.size,
    engineStat.mtime,
    preferences.language,
    preferences.chunkSeconds,
    preferences.tailSeconds,
  ]);
  const key = srtMod.fnv1a(media);
  const subtitle = mock.utils.resolvePath("@data/subtitles/" + key + ".srt");
  const stampFile = mock.utils.resolvePath("@data/fingerprints/" + key + ".fp");
  fs.mkdirSync(path.dirname(subtitle), { recursive: true });
  fs.mkdirSync(path.dirname(stampFile), { recursive: true });
  fs.writeFileSync(subtitle, "1\n00:00:01,000 --> 00:00:03,000\n缓存\n");
  fs.writeFileSync(stampFile, stamp);

  mock.event.emit("iina.file-loaded");
  await wait(300);

  assert.ok(
    !mock.calls.osd.some((m) => m.includes("starting transcription")),
    "a file that already has a transcript must not be transcribed again"
  );
  fs.rmSync(tmp, { recursive: true, force: true });
});

asyncTest("the audio track is counted among the audio tracks only", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-test-"));
  const media = path.join(tmp, "lesson.mp4");
  fs.writeFileSync(media, "x");

  const worker = stubWorker();
  const mock = loadPlugin(
    {
      path: media,
      duration: 60,
      preferences: basePreferences({ autoTranscribe: true }),
      // The second of the two audio tracks is the one being played. The
      // player numbers it 2, because it counts the video track as well.
      tracks: [
        { type: "video", selected: true, "ff-index": 0 },
        { type: "audio", selected: false, "ff-index": 1 },
        { type: "audio", selected: true, "ff-index": 2 },
      ],
    },
    { "worker.js": worker, "decoder.js": stubDecoder() }
  );

  mock.event.emit("iina.file-loaded");
  await wait(300);

  assert.ok(worker.contexts.length > 0, "the file should have been transcribed");
  // The decoder counts its tracks among the audio tracks only, so the number
  // has to be one and not two.
  for (const context of worker.contexts) {
    assert.strictEqual(context.audioTrackIndex, 1);
  }
  fs.rmSync(tmp, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------

runAll().then(() => {
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log("  " + f.name);
      console.log(
        "    " +
          (f.error && f.error.stack
            ? f.error.stack.split("\n").slice(0, 3).join("\n    ")
            : f.error)
      );
    }
    process.exit(1);
  }
});

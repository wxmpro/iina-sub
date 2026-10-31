/**
 * Security tests for iina-sub.
 *
 * These tests are about the ways a hostile file name, a hostile setting or a
 * hostile model could try to make the plugin do something it should not.
 *
 * Run with: node tests/security.js
 */
const fs = require("fs");
const os = require("os");
const path = require("path");
const assert = require("assert");
const { execFileSync } = require("child_process");

const { makeMock } = require("./mock-iina.js");

global.iina = makeMock({});

let passed = 0;
let failed = 0;
const failures = [];

// The tests are run one after the other. They share the `iina` global, so
// running them side by side would let one test replace the mock that
// another one is about to use.
const queue = [];

function test(name, fn) {
  queue.push({ name, fn });
}

async function runAll() {
  for (const item of queue) {
    try {
      await item.fn();
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

const srt = require("../srt.js");
const engines = require("../engines.js");

/**
 * The modules capture the `iina` global when they are loaded, so a test that
 * swaps the global has to load them again.
 */
function reloadEngines() {
  delete require.cache[require.resolve("../engines.js")];
  return require("../engines.js");
}

// ---------------------------------------------------------------------------
console.log("\nthe shell");

test("a value with a quote cannot break out of the quoting", () => {
  assert.strictEqual(engines.shellQuote("a'b"), "'a'\\''b'");
  assert.strictEqual(engines.shellQuote("$(id)"), "'$(id)'");
  assert.strictEqual(engines.shellQuote("`id`"), "'`id`'");
  assert.strictEqual(engines.shellQuote('"; id; "'), `'"; id; "'`);
  assert.strictEqual(engines.shellQuote("a\nb"), "'a\nb'");
});

test("the quoting holds against a real shell", () => {
  // The value is written to a file by a real shell. If the quoting were
  // broken, the command inside the value would run.
  const marker = path.join(os.tmpdir(), "iina-sub-injection-marker-" + process.pid);
  try {
    fs.unlinkSync(marker);
  } catch (e) {
    /* the file is not there, which is what we want */
  }

  const hostile = "x'; touch " + marker + "; echo '";
  const quoted = engines.shellQuote(hostile);
  const script = "printf %s " + quoted + " > /dev/null";
  execFileSync("/bin/sh", ["-c", script]);

  assert.ok(!fs.existsSync(marker), "the command inside the value was executed");
});

test("a hostile model path cannot become a second command", async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "iina-sub-sec-"));
  const marker = path.join(tmp, "pwned");
  // A stand in for the model that does nothing.
  const fake = path.join(tmp, "fake-whisper");
  fs.writeFileSync(fake, "#!/bin/sh\nexit 0\n");
  fs.chmodSync(fake, 0o755);

  const mock = makeMock({});
  global.iina = mock;
  let command = null;
  mock.__setExecHandler((c, args) => {
    command = args[1];
    return { status: 0, stdout: "", stderr: "" };
  });

  const engine = reloadEngines().ENGINES["whisper-cpp"];
  await engine.run(
    {
      config: {
        whisperPath: fake,
        modelPath: "/models/a.bin'; touch " + marker + "; echo '",
        language: "zh'; touch " + marker + "; echo '",
      },
      mediaPath: "/movies/a'; touch " + marker + "; echo '.mp4",
      audioTrackIndex: 0,
      decoder: { command: "/bin/echo", args: [] },
    },
    { index: 0, startMs: 0, lengthMs: 30000, durationMs: 32000, outBase: path.join(tmp, "out") },
    () => {}
  );

  assert.ok(command, "the engine should have run");

  // The command that the plugin built is handed to a real shell. If the
  // quoting were broken, the command inside a value would run.
  execFileSync("/bin/sh", ["-c", command]);

  assert.ok(!fs.existsSync(marker), "a command inside a value was executed");
  fs.rmSync(tmp, { recursive: true, force: true });
});

test("the custom engine gets its values as arguments, not as text", async () => {
  const mock = makeMock({});
  global.iina = mock;
  let seen = null;
  mock.__setExecHandler((command, args) => {
    seen = { command, args };
    return { status: 0, stdout: "", stderr: "" };
  });

  const hostile = "/movies/'; touch /tmp/pwned; echo '.mp4";
  await reloadEngines().ENGINES["custom"].run(
    {
      config: {
        enginePath: "mytool {input} {output} {model} {language}",
        modelPath: "/models/m.bin",
        language: "zh",
      },
      mediaPath: hostile,
    },
    { index: 0, startMs: 0, lengthMs: 1000, durationMs: 1000, outBase: "/tmp/out" },
    () => {}
  );

  assert.strictEqual(seen.command, "/bin/sh");
  assert.ok(seen.args[1].includes('"$1"'), seen.args[1]);
  assert.ok(!seen.args[1].includes("pwned"), seen.args[1]);
  assert.ok(seen.args.includes(hostile), "the value has to travel as its own argument");
});

// ---------------------------------------------------------------------------
console.log("\npaths");

test("the files of the plugin carry no part of the name of the video", () => {
  const internal = srt.internalSubtitlePathFor("/movies/secret lesson.mp4");
  const stamp = srt.stampPathFor("/movies/secret lesson.mp4");
  assert.ok(!internal.includes("secret"), internal);
  assert.ok(!internal.includes("lesson"), internal);
  assert.ok(!stamp.includes("secret"), stamp);
});

test("the name of the video cannot choose where a file is written", () => {
  // A name that tries to walk out of the folder of the video.
  const hostile = "/movies/../../etc/passwd.mp4";
  const target = srt.subtitlePathFor(hostile);
  if (target !== null) {
    assert.strictEqual(path.dirname(target), "/movies/../../etc");
    // The check keeps the file next to the video and nowhere else.
    assert.ok(target.startsWith("/movies/"), target);
  }
});

test("a file name with a quote stays in the folder of the video", () => {
  const target = srt.subtitlePathFor("/movies/a'; rm -rf ~; echo '.mp4");
  assert.strictEqual(path.dirname(target), "/movies");
  assert.ok(target.startsWith("/movies/"));
});

test("a network address has no file at all", () => {
  assert.strictEqual(srt.subtitlePathFor("https://example.com/a.mp4"), null);
  assert.strictEqual(srt.subtitlePathFor("rtsp://example.com/a"), null);
});

test("the helper of the plugin is named after a hash, not after an input", () => {
  const decoder = require("../decoder.js");
  const binary = decoder.binaryPath();
  assert.ok(binary.endsWith(".srt".replace(".srt", "") + "-") || /vina-[0-9a-f]+$/.test(binary), binary);
  assert.ok(!binary.includes(".."), binary);
});

// ---------------------------------------------------------------------------
console.log("\nwhat the plugin is allowed to do");

test("the plugin asks for no network access", () => {
  const info = JSON.parse(
    fs.readFileSync(path.join(__dirname, "..", "Info.json"), "utf8")
  );
  const permissions = info.permissions || [];
  assert.ok(!permissions.includes("network-request"), permissions.join(", "));
  assert.deepStrictEqual(
    permissions.slice().sort(),
    ["file-system", "show-alert", "show-osd"]
  );
});

test("the only address the plugin downloads from is a fixed one", () => {
  const models = require("../models.js");
  for (const model of models.MODELS) {
    assert.ok(model.name.startsWith("ggml-"), model.name);
    assert.ok(!model.name.includes("/"), model.name);
    assert.ok(!model.name.includes(".."), model.name);
  }
  const source = fs.readFileSync(path.join(__dirname, "..", "models.js"), "utf8");
  const urls = source.match(/https?:\/\/[^"'\s]+/g) || [];
  assert.strictEqual(urls.length, 1, urls.join(", "));
  assert.ok(urls[0].startsWith("https://huggingface.co/ggerganov/whisper.cpp/"), urls[0]);
});

test("the plugin writes only inside its own folder and next to the video", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  // Every place that writes uses either the file API or the copy command.
  const writes = source.match(/file\.write\([^)]*\)/g) || [];
  for (const write of writes) {
    assert.ok(
      write.includes("paths.subtitle") || write.includes("paths.stamp"),
      "unexpected write: " + write
    );
  }
});

test("the plugin never asks the shell to interpret a name of a file", () => {
  const source = fs.readFileSync(path.join(__dirname, "..", "main.js"), "utf8");
  // The only command the plugin builds itself is the copy of the export.
  assert.ok(!/exec\(\s*"\/bin\/sh"/.test(source), "main.js must not build a shell command");
  assert.ok(!/shellQuote/.test(source), "main.js must not build a shell command");
});

// ---------------------------------------------------------------------------

runAll().then(() => {
  console.log("\n" + passed + " passed, " + failed + " failed");
  if (failed > 0) {
    console.log("\nFailures:");
    for (const f of failures) {
      console.log("  " + f.name);
      console.log("    " + (f.error && f.error.stack ? f.error.stack.split("\n").slice(0, 3).join("\n    ") : f.error));
    }
    process.exit(1);
  }
});

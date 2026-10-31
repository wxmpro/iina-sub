# Contributing to iina-sub

Thank you for taking the time to help. This document explains how the code
is put together and what a change should look like.

## Getting the code ready

```bash
git clone https://github.com/wxmpro/iina-sub.git
cd iina-sub
node tests/run.js
```

The tests need nothing but Node. They run the plugin logic against a small
stand in for the player, so they finish in a second.

To try the plugin without packaging it, build it and open the result:

```bash
bash scripts/package.sh
open dist/io.github.xinmin.iina-sub.iinaplgz
```

## The parts of the code

| File | What it does |
|---|---|
| `main.js` | The life cycle of the plugin: the events, the menu, the commands |
| `worker.js` | Cuts the file into chunks and merges the cues back together |
| `engines.js` | One adapter per speech recognition engine |
| `decoder.js` | Builds the helper that reads the audio out of a media file |
| `srt.js` | Parsing and writing SubRip files, and the paths of the cache |
| `models.js` | The catalogue of models and the download |
| `pref.html` | The settings page |
| `sidebar.html` | The tab of the sidebar |

## Two rules that are easy to break

**A module may only be loaded while the file that asks for it is being
read.** The player resolves a module path relative to the script that is
being evaluated at that moment. Outside of an evaluation there is no such
script, and asking for a module then ends the player. So `require()` belongs
at the top of a file and nowhere else. There is a test that checks this.

**A file name must never reach a shell command.** Values are passed to the
shell as separate arguments, and every path inside the plugin folder is
derived from a hash of the media path, so a file name cannot influence where
a file is written.

## Adding an engine

An engine turns one chunk of audio into cues. The contract is small:

```js
{
  id: "my-engine",
  label: "My engine",
  description: "What it does.",
  requiresModel: true,
  available(config) { /* ... */ },
  async run(context, chunk, onProgress) {
    // context is { config, mediaPath, audioTrackIndex, decoder }
    // chunk is { index, startMs, lengthMs, durationMs, outBase }
    return [{ start: 0, end: 1000, text: "…" }];
  },
}
```

Register it in `ENGINES` at the bottom of `engines.js` and it shows up in the
settings page.

## The tests

`tests/run.js` holds the unit tests. `tests/integration.js` runs the real
pipeline over a real file and needs whisper.cpp and a model:

```bash
node tests/integration.js /path/to/a/video.mp4
```

Please add a test with every change that can be tested without a player.

## Reporting a problem

Please tell us the version of IINA, the version of the plugin, the engine and
the model you use, and what happened instead of what you expected. A short
clip of the file that misbehaves helps more than anything else, but please
remember that the audio of it leaves your machine only if you attach it
yourself.

# Contributing to iina-sub

Thank you for taking the time to help. This document explains how the code
is put together and what a change should look like.

## Getting the code ready

```bash
git clone https://github.com/wxmpro/iina-sub.git
cd iina-sub
bash scripts/package.sh
open dist/io.github.xinmin.iina-sub.iinaplgz
```

The build produces the `.iinaplgz` file that IINA installs. The archive is a
plain ZIP file despite its name, and it holds the plugin files flat, without a
folder around them.

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
| `tools/vina.swift` | The helper that reads the audio, in a form that can be read |

The helper exists twice: `tools/vina.swift` is the copy that is read, and
`decoder.js` carries the same source so that the plugin stays a plain set of
scripts. The two have to be identical. The build checks that, and a change to
one of them without the other is the one mistake that is easiest to make.

## Six rules that are easy to break

**A module may only be loaded while the file that asks for it is being
read.** The player resolves a module path relative to the script that is
being evaluated at that moment. Outside of an evaluation there is no such
script, and asking for a module then ends the player. So `require()` belongs
at the top of a file and nowhere else.

**A file name must never reach a shell command.** The built in engines hand
their arguments over as they are, one value per argument, and no shell is
started at all. The custom engine is the one exception, and there the values
travel as positional parameters.

**The times an engine reports belong to its chunk.** The worker moves them
into the timeline of the whole file and drops the ones that belong to the
overlap at the end of the chunk. An engine that reports the times of the
whole file puts every subtitle in the wrong place.

**A transcript is only marked as complete when it is.** The mark that tells
the plugin that a transcript may be used is written at the end of a run, not
after every chunk. A transcript that was stopped half way, or that lost a
chunk, is transcribed again the next time the file is opened.

**A file name never reaches the sidebar as text.** The player builds the call
that reaches the sidebar out of the text it is given, and a name that holds a
mark of JavaScript would be carried out on that page. The name therefore
travels as the bytes of it, written out as hex, and the sidebar turns it back
into text on its own.

**A program is only used when it is the one that was built.** The helper that
reads the audio carries the sum that was written down when it was built, and
is built again when it does not. A model of the collection is compared with
the sum that the upstream repository publishes before it is used, because the
engine loads such a file as a program.

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
    // context is { config, mediaPath, audioTrackIndex }
    // chunk is { index, startMs, lengthMs, durationMs, outBase }
    // the times of the cues are relative to the start of the chunk
    return [{ start: 0, end: 1000, text: "…" }];
  },
}
```

Register it in `ENGINES` at the bottom of `engines.js` and it shows up in the
settings page. An engine that reads a file gets the audio of the chunk from
`decoder.writeWav()`, which also says whether the chunk holds any sound at
all — a silent chunk is better left alone.

## Checking a change

The plugin has to work on a machine that has nothing but macOS and IINA on
it, so please check a change in the places it can go wrong:

- a video that has no transcript yet is transcribed when it is opened, and the
  subtitles appear while it is still being transcribed;
- a video that has a transcript is loaded from the cache straight away;
- a run that is stopped half way is not taken for a finished one the next
  time the file is opened;
- opening another video while a run is going on does not put the subtitles of
  the first one on the screen of the second one;
- the export writes a file next to the video and leaves nothing else behind;
- the folder of the video is untouched until the export is asked for;
- an export over a file that is already there replaces it, and leaves the
  file it replaces alone;
- a file name with a quote, a semicolon or a space in it is handled;
- a file name that holds a mark of JavaScript shows up as a name in the
  sidebar, and nothing is carried out there;
- a model that was changed after it was fetched is not used;
- a file that the search index of the system does not know is transcribed just
  as well as one in your downloads folder;
- the engine can be changed in the settings, and the setting is remembered.

## Reporting a problem

Please tell us the version of IINA, the version of the plugin, the engine and
the model you use, and what happened instead of what you expected. A short
clip of the file that misbehaves helps more than anything else, but please
remember that the audio of it leaves your machine only if you attach it
yourself.

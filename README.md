# iina-sub

**Local AI subtitles for [IINA](https://iina.io/).**

Transcribe local videos with a speech recognition engine that runs entirely on
your machine. No cloud, no API key, no upload of your media.

[简体中文](README.zh-CN.md)

---

## Why another subtitle plugin?

The existing IINA subtitle plugins all solve the problem for a live stream:
they transcribe a little bit ahead of the playhead and paint the result over
the video. That works, but it leaves three things on the table.

**iina-sub treats a local file as what it is: a file whose audio is already on
your disk.**

| | live-stream plugins | iina-sub |
|---|---|---|
| Subtitle rendering | WebView overlay drawn on top of the video | A real IINA subtitle track, so every subtitle setting in IINA applies |
| Second visit | Transcribed again from scratch | Loaded from the cache instantly |
| Seeking | Waits for the next chunk to be transcribed | Instant, because the whole file is already transcribed |
| Whole folder | One file at a time | One command transcribes every video next to the current one |
| Extra programs | ffmpeg, or an installer script | Nothing. The decoder is part of the plugin |

---

## Features

- **Native subtitle tracks.** The transcript is loaded with `sub-add`, so it
  behaves exactly like a downloaded subtitle file: font, size, colour,
  position and background all work the way you expect in IINA.
- **Nothing is written to your folders unless you ask for it.** The transcript
  lives in the plugin folder. One command — or one shortcut — writes a
  `<name>.srt` next to the video, and only then.
- **Subtitles appear on their own.** A video that has no transcript yet is
  transcribed as soon as it is opened. The transcript is refreshed after every
  chunk, so you do not have to wait for a two hour lecture to be processed.
- **Smart caching.** The transcript is stored together with a fingerprint of
  the media file, the model, the engine and the language. Reopen the video and
  the subtitles are there immediately. Change the model and the cache is
  invalidated on its own.
- **Batch transcription.** One command transcribes every video file in the
  folder of the current one. Files that are already cached are skipped.
- **Pluggable engines.** whisper.cpp is the default, mlx-whisper runs on the
  Apple Neural Engine, and a custom command lets you plug in any local tool
  that turns a media file into an SRT file.
- **Progress you can see.** The on-screen display shows the progress, and the
  sidebar tab shows the current stage, the elapsed time and a log of recent
  runs.
- **Fully offline.** The audio never leaves the machine.

---

## Requirements

- macOS 13 or newer
- [IINA](https://iina.io/) 1.3 or newer
- A speech recognition engine and a model, see below
- The Xcode command line tools (`xcode-select --install`), so the plugin can
  build its own audio decoder on first use

### whisper.cpp (recommended)

```bash
brew install whisper.cpp
```

Then download a model, for example:

```bash
mkdir -p ~/iina-asr/models
curl -L -o ~/iina-asr/models/ggml-large-v3-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin
```

Or use the **Download Model…** button in the sidebar tab of the plugin.

#### Which model should I use?

| Model | Size | Notes |
|---|---|---|
| `ggml-large-v3-q5_0.bin` | 1031 MB | Highest accuracy of the quantised models. A good default for Chinese. |
| `ggml-large-v3-turbo-q5_0.bin` | 547 MB | About twice as fast as `large-v3-q5_0`, slightly less accurate. |
| `ggml-medium-q5_0.bin` | 514 MB | Good accuracy, moderate speed. |
| `ggml-small.bin` | 465 MB | Fast, but Chinese quality is limited. |
| `ggml-base.bin` | 141 MB | Only for testing. |

Models ending in `.en` are English only. They ignore the language setting and
transcribe anything as English, so they are not useful for other languages.

Measured on an M1 Pro with `large-v3-q5_0`: roughly 4.7 times faster than real
time, so a one hour lecture takes about thirteen minutes.

---

## Installation

### From a release

Download the latest `.iinaplgz` from the releases page and open it. IINA
installs the plugin.

### From source

```bash
git clone https://github.com/wxmpro/iina-sub.git
cd iina-sub
bash scripts/package.sh
open dist/io.github.xinmin.iina-sub.iinaplgz
```

---

## Usage

Open a local video. That is all.

If the video has been transcribed before, the subtitles are loaded
immediately. If not, the plugin starts transcribing it and the subtitles
appear as soon as the first chunk is done.

### The menu

| Item | Shortcut | What it does |
|---|---|---|
| Generate Subtitles Now | <kbd>Alt</kbd>+<kbd>S</kbd> | Transcribe the current video, or load the cached transcript |
| Regenerate Subtitles | | Discard the cached transcript and transcribe again |
| Cancel Transcription | <kbd>Alt</kbd>+<kbd>Shift</kbd>+<kbd>S</kbd> | Stop the current run after the chunk in progress |
| Transcribe All Videos in This Folder | | Transcribe every video next to the current one |
| Export Subtitles Next to the Video | <kbd>Alt</kbd>+<kbd>E</kbd> | Write `<name>.srt` next to the video |

The player shows five entries of a plugin menu at most and puts the rest
behind a "More…" item. The sidebar tab of the plugin shows the progress of the
run, the files that were transcribed and a short explanation of every menu
entry. It also has a button that fetches a model.

### Exporting

The transcript is kept inside the plugin folder, so your video folders stay
untouched. When you want a subtitle file next to the video, press
<kbd>Alt</kbd>+<kbd>E</kbd>. The file is named after the video, for example
`lesson.mp4` becomes `lesson.srt`, which every player understands.

The player picks that file up on its own the next time the video is opened,
so the plugin does not load a second copy of the same transcript.

### Settings

**Preferences → Plugins → iina-sub**, or the gear icon next to the plugin.

| Setting | Default | Meaning |
|---|---|---|
| Engine | `whisper.cpp` | Which speech recognition engine to use |
| whisper-cli path | `/opt/homebrew/bin/whisper-cli` | Where the binary lives |
| Engine path | *(empty)* | Path to the mlx-whisper binary, or the custom command |
| Model file | *(empty)* | Path to the `.bin` model |
| Language | `zh` | ISO code, or `auto` to detect it |
| Chunk length | `30` | Seconds per chunk. Longer chunks give the model more context |
| Overlap | `2` | Extra audio decoded after each chunk so sentences are not cut in half |
| Transcribe automatically when a video is opened | on | Turn this off to only transcribe when you ask for it |
| Load the cached subtitles when a video is opened | on | Load the transcript when a video is opened |

---

## Custom engines

Any local command that turns a media file into a SubRip file can be used. The
command may contain these placeholders:

| Placeholder | Replaced with |
|---|---|
| `{input}` | Path of the media file |
| `{output}` | Path of the SRT file to write |
| `{model}` | Path of the model file |
| `{language}` | The language code |

For example, to use a hypothetical tool:

```
my-asr --input {input} --output {output} --model {model} --lang {language}
```

The command runs through `/bin/sh`, so pipes and redirections are allowed.
The placeholders expand to shell positional parameters, which means a file
name that contains a quote or a semicolon can never turn into a second
command.

---

## How it works

1. The length of the file is read from the file itself, so a file that the
   search index of the system does not know is transcribed just as well as
   one in your downloads folder.
2. The audio track of the current file is decoded to 16 kHz mono PCM, one
   chunk at a time. The chunk that the viewer is about to reach is decoded
   first, so seeking is cheap.
3. The decoding is done by a small helper that is built on the media
   framework macOS ships with. It is compiled once, on first use, into the
   plugin folder. There is no ffmpeg and no other external program involved.
4. The decoded audio is piped straight into the speech recognition model. No
   temporary files are written, so a long run cannot be broken by the system
   cleaning up a temporary folder.
5. Every chunk is transcribed on its own. A couple of seconds of extra audio
   are decoded after each chunk so the model hears the end of a sentence
   instead of a hard cut. Cues that begin inside that overlap are dropped,
   because the next chunk produces them properly.
6. The cues are merged into a single SubRip file and reloaded into the player
   with `sub-reload`, so the subtitles on screen follow the transcription.
7. A fingerprint of the media file, the model, the engine and the language is
   stored alongside the transcript. When any of them changes, the cache is
   considered stale.

### A note on chunk boundaries

Every chunked speech recogniser can repeat a few words at a chunk boundary
when a word happens to straddle it. This is normal and harmless: the
timestamps never overlap and no part of the file is dropped. Raising the
chunk length in the settings reduces the number of boundaries.

---

## Security

The plugin only ever runs what the user has installed, and it treats the file
names of your media as untrusted input.

- The model is read from a path you chose. The plugin never downloads
  anything without being asked to.
- The names of your files never reach a shell command. Values are quoted, and
  the custom engine receives its arguments as separate values instead of as
  text that the shell has to parse.
- The transcript is kept under a name that is derived from a hash of the file
  path, so a file name cannot influence where a file is written.
- The export always writes into the folder of the video and never outside of
  it.
- The plugin asks for three permissions: `file-system` to read the video and
  write the transcript, `show-osd` for the progress messages and `show-alert`
  for the dialogs. It asks for no network access at all.

---

## Development

```bash
node tests/run.js                                   # unit tests
node tests/integration.js /path/to/a/video.mp4      # end to end, needs whisper
```

The integration test builds the real decoder, runs the real pipeline over a
real file and checks that the transcript has no overlapping cues, stays
inside the media, covers its end and leaves no files behind.

---

## License

MIT

# iina-sub

**Local AI subtitles for [IINA](https://iina.io/).**

Transcribe local videos with a speech recognition engine that runs entirely on
your machine. No cloud, no API key, no upload of your media.

[简体中文](README.zh-CN.md)

![Subtitles that the plugin made, on the video of a local file](docs/screenshot.png)

*The transcript is a real IINA subtitle track. It is loaded with `sub-add`, so
every subtitle setting of the player — the font, the size, the colour, the
position — works on it the way you expect.*

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
- **Fully offline.** The audio never leaves the machine. The only thing that
  ever reaches the network is the model download, and that happens only when
  you ask for it.
- **The script of the subtitles is yours to choose.** Whisper picks Simplified
  or Traditional Chinese by itself, and it may change its mind in the middle
  of a file. The setting "The script of the Chinese subtitles" tells the
  model which one to write in, and what it wrote anyway is brought over
  afterwards.
- **Speaks your language.** The menu, the messages and the sidebar are in
  Chinese when your system is, and in English otherwise. The setting
  "Language of the plugin" in the preferences has the last word.

---

## Requirements

- macOS 13 or newer
- [IINA](https://iina.io/) 1.3 or newer
- A speech recognition engine and a model. The plugin fetches both on the
  first run, see below
- The Xcode command line tools (`xcode-select --install`), so the plugin can
  build its own audio decoder on first use

### The engine

The plugin needs the `whisper-cli` program of whisper.cpp. There are two ways
to get it, and the plugin asks which one to use on the first run:

- **Let the plugin fetch it.** About 4 MB, once. The plugin downloads it from
  the release page of this repository, checks it against a fixed SHA-256 sum,
  and keeps it in its own folder. Nothing is downloaded when Homebrew has
  whisper.cpp already.
- **Install it with Homebrew**, which is what the button in the sidebar tab
  mentions:

  ```bash
  brew install whisper.cpp
  ```

A model is needed as well. The plugin offers to fetch the recommended one on
the first run, and every model of the collection is a button in the sidebar
tab.

The models are fetched from the repository of the upstream project. When that
address cannot be reached — which is the usual case for a machine in China —
two mirrors are tried: `hf-mirror.com`, a mirror of Hugging Face that has
been around for years, and the collection of ModelScope. Whatever the source
is, the file is checked against the SHA-256 sum that the upstream repository
publishes before it is put into place, so a mirror cannot hand over a file
that was changed on the way. The sidebar shows which source the file came
from.

No mirror can promise that it will be there tomorrow, and the repository of a
person on ModelScope is the least dependable of them. That is why there is
more than one, why the upstream address is always tried first, and why the
model can also be fetched by hand:

```bash
mkdir -p ~/iina-asr/models
curl -L -o ~/iina-asr/models/ggml-large-v3-q5_0.bin \
  https://huggingface.co/ggerganov/whisper.cpp/resolve/main/ggml-large-v3-q5_0.bin
```

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

#### Intel Macs

The plugin itself runs on an Intel Mac — it is plain JavaScript and the audio
decoder is built for both architectures. The speech recognition is a different
matter: whisper.cpp uses the GPU of the machine, and on an Intel Mac that GPU
is far weaker than the one of an Apple Silicon machine. Expect a transcript
that takes several times longer than the length of the video, and expect the
model `large-v3-turbo` to be the practical choice there.

The end-to-end run of this plugin was done on an Apple Silicon machine only.
Nothing in the code depends on the architecture — the program that comes with
the plugin is built for both `arm64` and `x86_64` — but the numbers above are
the numbers of an M1 Pro, and an Intel Mac has not been measured. If
something does not work on an Intel Mac, please open an issue and say which
machine you have.

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

The sidebar tab of the plugin has a button for each model of the collection,
a button that removes the transcripts the plugin has kept, and a button that
removes the models — a model is a few hundred megabytes, and the player
keeps the data folder of a plugin when the plugin is removed.

The player shows five entries of a plugin menu at most and puts the rest
behind a "More…" item. The sidebar tab of the plugin shows the progress of the
run, the files that were transcribed and a short explanation of every menu
entry.

### The first run

> **A note about the download speed, and about networks in China.** The
> plugin fetches two things from the internet: its own copy of the speech
> recognition program (about 4 MB, from this repository) and, when you pick
> one, a model (the recommended one is 547 MB).
>
> A model that cannot be fetched from the upstream address is fetched from a
> mirror in China on its own, so no proxy is needed for the models. The
> mirror is checked against the same published sums, so nothing it can serve
> is any different from what the upstream serves.
>
> The small program comes from GitHub, and on a network where GitHub itself
> is blocked the fetch can fail. When it does, the plugin names the proxy
> setting. `Preferences → Plugins → iina-sub → Proxy`, for example
> `http://127.0.0.1:7890`. Nothing else in the plugin needs the network:
> after the program and the model are there, transcription works offline.


The plugin needs two things that it does not carry: the speech recognition
program, and a model. When a video is opened and no model is set, the plugin
asks once whether to fetch the recommended model (547 MB). It is downloaded
once, kept in the folder of the plugin, and works without network after
that. When it is there, the video that was open is transcribed right away.

The program itself is not something the plugin can install. Install it once
with Homebrew:

```bash
brew install whisper.cpp
```

The plugin finds the binary on its own afterwards. Every model of the
collection is also shown as a button in the sidebar tab of the plugin, so
nothing has to be typed to fetch one.

### Exporting

The transcript is kept inside the plugin folder, so your video folders stay
untouched. When you want a subtitle file next to the video, press
<kbd>Alt</kbd>+<kbd>E</kbd>. The file is named after the video, for example
`lesson.mp4` becomes `lesson.srt`, which every player understands.

The player picks that file up on its own the next time the video is opened,
so the plugin does not load a second copy of the same transcript.

The file that is written gets the same permissions as the video, so a video
that only you may read does not leave its dialogue behind in a file that
everybody on the machine can read. A transcript that lost a part of the file
is not complete, and the plugin asks before it writes one.

### Settings

**Preferences → Plugins → iina-sub**, or the gear icon next to the plugin.

| Setting | Default | Meaning |
|---|---|---|
| Engine | `whisper.cpp` | Which speech recognition engine to use |
| whisper-cli path | `/opt/homebrew/bin/whisper-cli` | Where the binary lives |
| Engine path | *(empty)* | Path to the mlx-whisper binary, or the custom command |
| Model file | *(empty)* | Path to the `.bin` model |
| Proxy | *(empty)* | Proxy for the model download, for example `http://127.0.0.1:7890` |
| Language | `zh` | ISO code of the speech, or `auto` to detect it |
| The script of the Chinese subtitles | `Simplified Chinese` | `Simplified Chinese`, `Traditional Chinese`, or `As the model wrote it` — see below |
| Language of the plugin | `auto` | The language of the menu and the messages: the one of the system, `zh` or `en` |
| Chunk length | `30` | Seconds per chunk. Longer chunks give the model more context |
| Overlap | `2` | Extra audio decoded after each chunk so sentences are not cut in half |
| Transcribe automatically when a video is opened | on | Turn this off to only transcribe when you ask for it |
| Load the cached subtitles when a video is opened | on | Load the transcript when a video is opened |

### Simplified Chinese and Traditional Chinese

Whisper knows languages, not scripts. There is no `zh-Hans` and no `zh-Hant`
in its list of languages: Simplified Chinese and Traditional Chinese are the
same language to the model, and it picks one of them by itself — and it may
even change its mind in the middle of a file, so that one video comes out
half in one script and half in the other.

The setting *The script of the Chinese subtitles* settles it:

- **Simplified Chinese** (the default) — the model is given a short text in
  Simplified Chinese to start with, and it writes in that script by itself.
  Whatever it wrote in the other script is brought over afterwards.
- **Traditional Chinese** — the same, the other way round.
- **As the model wrote it** — nothing is changed and nothing is asked. The
  subtitles are exactly what the model said.

The setting is only used for Chinese. A text of Japanese is left alone,
because the tables that turn Traditional into Simplified would change the
Chinese characters of Japanese as well.

The program that comes with the plugin knows the prompt. A program of an
older build does not: the plugin sees that the option is not known, runs the
file again without it, and does not try it again. The transcript is then
written in the script the model chose, and the second half of the work still
brings it into the script that was asked for.

The script is part of the fingerprint of a transcript, so changing it
transcribes the file again. That is on purpose: the model writes another
text when it is told another script.

---

## Removing the plugin

The plugin itself lives in the folder of the player and goes away with it.
The data does not: the player keeps the data folder of a plugin when the
plugin is removed, and that folder holds the model — a few hundred
megabytes — and the transcripts.

The plugin watches its own folder while it runs. When the folder is gone, the
plugin was removed, and the data goes with it: the models, the transcripts
and the audio of the chunks are deleted, and the disk is free again. Nothing
of yours is in that folder, and the plugin only removes it when the folder of
the plugin was really gone.

The removal takes a moment. The plugin looks at its folder every fifteen
seconds and waits for a second look before it removes anything, so a plugin
that is removed and installed again right away keeps its data.

If you want to keep the transcripts, export them before you remove the plugin
— ⌥E writes them next to the video — or remove only the models from the
sidebar tab of the plugin: "Remove the Downloaded Models…" deletes the
hundreds of megabytes and keeps the transcripts.

Should the data still be there — because the plugin was removed while the
player was not running, for instance — it is in this folder:

```
~/Library/Application Support/com.colliderli.iina/plugins/.data/io.github.xinmin.iina-sub
```

and it goes with this command:

```bash
rm -rf ~/Library/Application\ Support/com.colliderli.iina/plugins/.data/io.github.xinmin.iina-sub
```

---

## Custom engines

Any local command that turns a piece of audio into a SubRip file can be used.
The command may contain these placeholders:

| Placeholder | Replaced with |
|---|---|
| `{input}` | Path of the media file |
| `{audio}` | Path of a WAV file that holds the part of the media that is being transcribed |
| `{output}` | Path of the SRT file to write |
| `{model}` | Path of the model file |
| `{language}` | The language code |
| `{start}` | Start of the part, in seconds |
| `{duration}` | Length of the part, in seconds |

For example, to use a hypothetical tool:

```
my-asr --input {audio} --output {output} --model {model} --lang {language}
```

The command is called once per part of the file, and the times it writes
have to be relative to the beginning of that part. Using `{audio}` is the
easiest way to get that right: the file holds the part and nothing else.

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
4. The decoded audio of a chunk is written to a WAV file in the plugin
   folder, and the speech recognition model reads that file. The file is
   removed as soon as the chunk is done. Neither program is started through
   a shell, so a file name can never be read as a command.
5. Every chunk is transcribed on its own. A couple of seconds of extra audio
   are decoded after each chunk so the model hears the end of a sentence
   instead of a hard cut. Cues that begin inside that overlap are dropped,
   because the next chunk produces them properly. A chunk that is silent is
   skipped: the model would only make something up out of it.
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
  anything without being asked to, and the one address it knows is the
  address of the model collection. A downloaded model is checked against the
  size and the SHA-256 sum that the upstream repository publishes, and a
  file that does not match is thrown away. A model of the collection is
  checked the same way before it is used, because the engine loads such a
  file as a program.
- The helper that reads the audio out of the video is built by the plugin
  and is only used when it still carries the sum that was written down when
  it was built. A file that was changed is built again.
- The name of a file never reaches the sidebar as text. It travels as the
  bytes of it, so a name that holds a mark of JavaScript cannot be carried
  out on that page.
- The download reads no settings of your own. The configuration of `curl`
  that belongs to your account is ignored, so a file of yours cannot send
  the download somewhere else.
- The names of your files never reach a shell command. The built in engines
  hand their arguments over as they are, and the custom engine receives its
  values as separate parameters instead of as text that the shell has to
  parse.
- The transcript is kept under a name that is derived from a hash of the file
  path, so a file name cannot influence where a file is written.
- The export always writes into the folder of the video and never outside of
  it. The file that is already there is replaced, not written through, so a
  link that points somewhere else is of no use to anyone. Nothing else is
  written into the folder of the video.
- The plugin asks for four permissions: `file-system` to read the video and
  write the transcript, `show-osd` for the progress messages, `show-alert`
  for the dialogs and `network-request` for the model download. The audio
  itself never leaves the machine.

---

## Development

```bash
bash scripts/package.sh
```

The build produces the `.iinaplgz` file that IINA installs. The archive is a
plain ZIP file despite its name, and it holds the plugin files flat, without a
folder around them.

The helper that reads the audio out of a media file lives in two places: in
`tools/vina.swift`, where it can be read, and inside `decoder.js`, where the
plugin carries it. The two have to be the same, and the build checks that.

See [CONTRIBUTING.md](CONTRIBUTING.md) for the way the code is put together
and for the list of things to try after a change.
[TESTING.md](TESTING.md) lists every test case and what it checks.

---

## License

MIT

The file `zh.js` carries the dictionary data of
[OpenCC](https://github.com/BYVoid/OpenCC), which is under the Apache
License 2.0. The copy of that licence and the notice of OpenCC are in
[docs/OPENCC-LICENSE.txt](docs/OPENCC-LICENSE.txt).

The speech recognition program that the plugin brings along uses the library
of [whisper.cpp](https://github.com/ggml-org/whisper.cpp), which is under
the MIT licence; the copy is in `tools/whisper.cpp-LICENSE`.

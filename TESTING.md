# Testing

This page is the inventory of the tests of the plugin: what every case
checks and why it is there. The test code itself is not part of the
repository — it is kept out of the release on purpose, so that the tests
cannot be mistaken for a part of the plugin that has to be installed.

The tests are plain Node scripts. They replace the `iina` global with a
stand-in that records everything the plugin does, so the whole plugin runs
without a player. Two files hold them:

| File | Cases | What it covers |
|---|---|---|
| `tests/run.js` | 92 | the behaviour of the plugin |
| `tests/security.js` | 24 | the ways a hostile file, a hostile setting or a hostile model could try to make the plugin do something it should not |

```bash
node tests/run.js
node tests/security.js
```

Both files have to end with `0 failed`. A case that fails prints the
message of the assertion and the place it came from.

## The behaviour of the plugin

### `srt.js` — the subtitle file and the fingerprint

| Case | What it checks |
|---|---|
| parses a SubRip timestamp | `00:00:01,500` becomes 1500 ms and back |
| formats a SubRip timestamp | the other way round, with the hours |
| parses an SRT document into cues | the cues of a real file |
| skips malformed blocks instead of failing | a file with a broken block still gives the other cues |
| renders cues back into a valid SRT document | the text that is written out |
| a rendered document can be parsed again | the round trip holds |
| never emits overlapping cues | two cues never cover the same moment |
| sorts cues by start time | the order of the cues |
| drops empty cues | a cue without a text is not written out |
| the fingerprint is stable and sensitive | the same file gives the same mark, a changed file does not |
| the exported subtitle keeps the name of the video | `lesson.mp4` becomes `lesson.srt` |
| the exported subtitle stays in the folder of the video | the export never writes outside of it |
| a network address has no subtitle file | `https://…` is not a file that can be written next to a video |
| a dot in the name of the folder is not the extension of the file | `Season 2.5/lesson` is not `lesson.5` |
| a file without an extension gets a subtitle file | a file without a name after the dot still gets one |
| the internal paths carry no part of the file name | the transcript is named after a hash |
| the internal paths of two files never collide | two videos never share a transcript |

### `worker.js` — the chunks of a file

| Case | What it checks |
|---|---|
| plans chunks that cover the whole file | no second of the file is left out |
| the last chunk is shortened to the end of the file | no audio past the end is decoded |
| every chunk carries a tail of extra audio | the model hears the end of a sentence |
| an unknown duration produces no chunks | a file of unknown length is not guessed at |
| the chunk output lives in the plugin folder and carries no extension | the audio of the user never leaves the plugin folder |
| the chunks of two files never share a name | two videos never write over each other |
| a file that the system has not indexed has no duration | the index of the system is not the only source |
| the length is taken from the decoder when the index does not know it | the file itself is the second source |
| the length the player knows is used straight away | the player is asked first |
| the cues of the tail are dropped and the rest is clamped | the overlap does not produce two cues for the same words |

### `engines.js` — the speech recognition

| Case | What it checks |
|---|---|
| a hostile name cannot become a command in the custom engine | `; touch …` in a name is not a command |
| the custom engine hands its values over as arguments | the values are parameters, not text |
| the whisper engine starts neither program through a shell | the decoder and the model are started directly |
| the whisper engine never asks a shell to read a file name | the shell that is used has a constant text |
| a program that takes too long is really stopped | the process is killed, not just the wait for it ended |
| the settings page offers the engines as a choice that is remembered | the engine can really be changed |
| the settings of the engine survive the round trip through the player | the player reads and writes them |
| no model of the machine of the author is the default | the settings of the repository carry no path of a person |
| the decoder in the plugin and the one in the repository are the same | the two copies of the helper cannot drift apart |

### The structure of the plugin

| Case | What it checks |
|---|---|
| every module is loaded at the top level only | no module is loaded from inside a function |

### `main.js` — the plugin as a whole

| Case | What it checks |
|---|---|
| a transcript that was stopped half way is not a valid cache | a partial transcript is transcribed again |
| a chunk that fails does not stop the whole run | one bad part does not cost the file |
| the subtitles of another file are not put on the screen | the subtitles belong to the file that is playing |
| registers its menu items | the five entries of the menu are there |
| the menu holds no more than five entries | the player only shows five |
| the sidebar can ask the plugin to fetch a model | the button of the sidebar works |
| the export command has a shortcut and the cancel command another | the two shortcuts are bound |
| nothing is written next to the video before the export is asked for | the folder of the video is untouched by default |
| the export command writes the transcript next to the video | the export writes what it should |
| the export leaves nothing else behind | the export writes one file and nothing more |
| the export overwrites a subtitle file that is already there | the old file is replaced |
| the export asks before it writes a transcript that is not complete | a gap is named before it is written |
| the exported subtitle has the permissions of the video | a private video leaves no readable file behind |
| the saved transcripts can be removed | the clean up works |
| the first run without the program offers to fetch it | the question is asked once |
| a fetched program is used without being fetched again | the second run does not ask again |
| a fetched program does not silence the question about the model | the two questions are separate |
| the first run without a model offers to fetch one | the question is asked once |
| answering yes to the offer fetches the model and transcribes | the video that was open is transcribed after the fetch |
| the sidebar can name the model to fetch | the button names the model |
| the plugin never renames a file, which the player cannot do | no file is renamed |
| a valid cache is loaded as a subtitle track | the second visit is instant |
| a subtitle that the player already has is not added a second time | the track is not duplicated |
| a stale cache is not loaded | a changed file is transcribed again |
| a video without a cache is transcribed on its own | the subtitles appear without a click |
| a video with a cache is not transcribed again | the cache is used |
| the audio track is counted among the audio tracks only | the number of the track is the one the decoder expects |

### The script of the Chinese subtitles

| Case | What it checks |
|---|---|
| Traditional Chinese is turned into Simplified Chinese | the tables of OpenCC do their work |
| a word of its own is protected from a shorter rule | 著名 stays 著名 and does not become 着名 |
| a text that is already in Simplified Chinese is left as it is | the conversion costs nothing when it is not needed |
| a word of Simplified Chinese is not turned into another word | 为什么 stays 为什么 and 序列 stays 序列 |
| the verb of 著 is written 着 | 接著 becomes 接着, and 著名 stays 著名 |
| Simplified Chinese is turned into Traditional Chinese | the other direction works as well |
| the model is told which script to write in | the engine is given the text of the script |
| the prompt holds no punctuation | a prompt that ends in a full stop makes the model write long sentences |
| no prompt is given when the script of the model is to be kept | the setting is obeyed |
| no prompt is given for a language that is not Chinese | a Chinese prompt would make a Japanese model write Chinese |
| the text of a language that is not Chinese is left as it is | the tables would change the Chinese characters of Japanese |
| the cues are brought into the script that was asked for | the transcript is in the script that was asked for |
| the cues are left as they are when the script of the model is kept | the setting is obeyed |
| the script is part of the fingerprint | a transcript of one script is not a transcript of the other |
| the whisper engine is told which script to write in | the program of the plugin is given the prompt |
| the whisper engine is told nothing when the script is to be kept | the program of the plugin is given nothing |
| the whisper engine runs again without the prompt when the program does not know it | a build of whisper.cpp that is older than the prompt does not stop the run |
| the complaint of a program that does not know an option is recognised | a failure that has nothing to do with the prompt is not one |

### The clean up after the plugin is removed

| Case | What it checks |
|---|---|
| the folder of the plugin is read out of the stack | the address of the file is a path on the disk, and not an address of the web |
| the name of the plugin is read out of the folder of its code | the folder of the data belongs to this plugin |
| the folder of the data has to be the one of this plugin | nothing else is ever removed |
| the watch is not started when the folder of the plugin is unknown | a wrong answer can never lead to a deletion |

### The language of the plugin

| Case | What it checks |
|---|---|
| every message of the plugin has a Chinese text | no text of the user is left without a translation |
| the language of the system is used when the setting says so | the system decides |
| the setting of the user wins over the language of the system | the user decides |
| a text that has no Chinese text is still shown | a forgotten text is shown and not swallowed |

### The way the player loads the plugin

| Case | What it checks |
|---|---|
| every module of the plugin is built once | the player builds a module again for every request of it, and the loader of the plugin stops that |
| the state of the plugin is one object | every module sees the same state |

## The security of the plugin

### The shell

| Case | What it checks |
|---|---|
| a value never becomes a command in the custom engine | the values travel as parameters |
| a hostile model path cannot become a second command | a model path of `; touch …` is not a command |
| the custom engine gets its values as arguments, not as text | the placeholders expand to positional parameters |

### The paths

| Case | What it checks |
|---|---|
| the files of the plugin carry no part of the name of the video | the transcript is named after a hash |
| the name of the video cannot choose where a file is written | the path of the transcript is derived from a hash |
| a file name with a quote stays in the folder of the video | the export does not run away |
| a network address has no file at all | `https://…` is never written to |
| the helper of the plugin is named after a hash, not after an input | the helper of the plugin is named by the plugin |

### The export

| Case | What it checks |
|---|---|
| the export does not write through a link that is already there | a link that points somewhere else is replaced, not written through |

### What the plugin is allowed to do

| Case | What it checks |
|---|---|
| the plugin asks for nothing it does not use | the four permissions are the ones that are needed |
| nothing of the user is sent to the network | the plugin knows no address that could carry something away |
| the only address the plugin downloads from is a fixed one | the collection of the models and the release of the plugin |
| the download refuses to leave HTTPS | the address of the download is checked |
| every model carries the sum that the upstream repository publishes | the models are checked before they are used |
| the download never reads the settings of the user | the configuration of `curl` of the user is ignored |
| the name of a file cannot carry code into the sidebar | the text of a file name travels as bytes |
| a helper that this plugin did not build is not used | the helper is built again when it was changed |
| a model that was put there by something else is fetched again | a model that was changed is not used |
| a mirror that serves anything else is caught by the same check | a mirror cannot serve anything else |
| the clean up removes the folder of the data of this plugin and nothing else | the folder that goes with the plugin is the one of this plugin, and no shell is used to remove it |
| a model whose sum does not match is thrown away | a model that is not the one it claims to be is removed |
| the plugin writes only inside its own folder and next to the video | every write of the plugin is looked at |
| the plugin never asks the shell to interpret a name of a file | the two shells that are used have a constant text |

## What is checked outside of the tests

| Where | What it checks |
|---|---|
| `.github/workflows/test.yml` | the package holds every file of the plugin and nothing else |
| `.github/workflows/test.yml` | the helper in `decoder.js` and the one in `tools/vina.swift` are the same |
| `.github/workflows/test.yml` | the speech recognition program still compiles and runs |
| `.github/workflows/test.yml` | the helper still compiles |
| `scripts/package.sh` | the archive is a plain ZIP file and holds the files flat |

## What is checked by hand

| What | How |
|---|---|
| a video is transcribed on a real machine | a video of a few minutes is opened, the subtitles appear while it plays |
| the cache is instant on a second visit | the same video is opened a second time |
| the export is a valid subtitle file | the file is opened in another player |
| the models are fetched without a proxy | the download is made with the network of the machine and no proxy |
| the bundle of the speech recognition program runs | the program is built and run on both an Apple Silicon and an Intel machine |
| the subtitles are in the script that was asked for | the whole transcript is counted, character by character: a text in Simplified Chinese holds no Traditional character, and the other way round |

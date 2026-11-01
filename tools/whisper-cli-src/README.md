# The speech recognition program

`whisper-cli.cpp` is the command line program that the plugin brings along
for the machines that have no Homebrew. It is written for this plugin and
uses the public interface of the whisper library only.

It reads one WAV file — the format the decoder of the plugin writes — hands
the samples to the library, and writes a SubRip file.

The library comes from [whisper.cpp](https://github.com/ggml-org/whisper.cpp),
release `b5454`, whose license (MIT) is in `../whisper.cpp-LICENSE`. The
library is the one the project publishes for Apple platforms; the project
publishes no command line program for macOS, which is why this file exists.

`scripts/build-whisper.sh` builds the two into the archive that the plugin
downloads, for Intel and Apple Silicon alike, and prints its SHA-256 sum. That
sum is written into `WHISPER_BUNDLE_SHA256` in `engines.js`, and nothing is
run before it matches.

#!/bin/bash
# Build the speech recognition program that the plugin brings along.
#
# whisper.cpp publishes libraries for Apple platforms but no command line
# program, so the program is built here: the library of a fixed release plus
# the small program in tools/whisper-cli-src, which is written for this
# plugin and uses the public interface of the library only.
#
# The result is one archive that holds the program and its library, for
# Intel and Apple Silicon alike. The plugin downloads it from the release
# page of this repository and checks it against a sum that is written into
# engines.js.
#
# Usage: scripts/build-whisper.sh [output-directory]
set -euo pipefail

cd "$(dirname "$0")/.."

RELEASE="b5454"
URL="https://github.com/ggml-org/whisper.cpp/releases/download/${RELEASE}/whisper-${RELEASE}-xcframework.zip"

OUT_DIR="${1:-$(pwd)/dist}"
WORK="$(mktemp -d)"
trap 'rm -rf "$WORK"' EXIT

echo "fetching the library of whisper.cpp ${RELEASE}"
# A copy that was fetched before can be handed over, so that the build does
# not have to reach the network again.
if [ -n "${WHISPER_XCFRAMEWORK:-}" ] && [ -f "$WHISPER_XCFRAMEWORK" ]; then
  cp "$WHISPER_XCFRAMEWORK" "$WORK/xcframework.zip"
else
  curl -q -L --fail --proto '=https' --proto-redir '=https' -o "$WORK/xcframework.zip" "$URL"
fi
echo "  sha256: $(shasum -a 256 "$WORK/xcframework.zip" | awk '{print $1}')"

echo "unpacking the macOS part"
# The whole macOS part is unpacked, so that the framework is complete: the
# linker needs its structure, not only the library itself.
unzip -q -o "$WORK/xcframework.zip" \
  "build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework/*" \
  -d "$WORK"

FRAMEWORK="$WORK/build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework/Versions/A"

echo "building the program for arm64 and x86_64"
mkdir -p "$WORK/bundle/whisper.framework"
cp "$FRAMEWORK/whisper" "$WORK/bundle/whisper.framework/whisper"

# The linker is given a folder that holds a framework of that name.
mkdir -p "$WORK/link"
rm -rf "$WORK/link/whisper.framework"
cp -R "$WORK/build-apple/whisper.xcframework/macos-arm64_x86_64/whisper.framework" "$WORK/link/"

clang++ -O2 -std=c++17 -arch arm64 -arch x86_64 \
  -I"$FRAMEWORK/Headers" \
  tools/whisper-cli-src/whisper-cli.cpp \
  -F"$WORK/link" -framework whisper \
  -framework Foundation -framework Metal -framework Accelerate -framework CoreML \
  -o "$WORK/bundle/whisper-cli"

# The program finds its library next to itself, not at the place where the
# library happened to sit while it was built.
install_name_tool -change \
  "@rpath/whisper.framework/Versions/Current/whisper" \
  "@executable_path/whisper.framework/whisper" \
  "$WORK/bundle/whisper-cli"

# Both files are signed in the ad hoc way, so that a machine that insists on
# a signature still runs them.
codesign --force --sign - "$WORK/bundle/whisper.framework/whisper"
codesign --force --sign - "$WORK/bundle/whisper-cli"

echo "packing"
mkdir -p "$OUT_DIR"
ARCHIVE="$OUT_DIR/iina-sub-whisper-macos.zip"
rm -f "$ARCHIVE"
find "$WORK/bundle" -name '._*' -delete
ditto -c -k --norsrc "$WORK/bundle" "$ARCHIVE"

echo
echo "built $ARCHIVE"
ls -lh "$ARCHIVE" | awk '{print "  size:   " $5}'
echo "  sha256: $(shasum -a 256 "$ARCHIVE" | awk '{print $1}')"
echo
echo "Put that sum into WHISPER_BUNDLE_SHA256 in engines.js, and upload the"
echo "archive as an asset of the release that WHISPER_BUNDLE_URL names."

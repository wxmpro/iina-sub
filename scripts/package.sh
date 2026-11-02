#!/bin/bash
# Package the plugin into an .iinaplgz archive, the format IINA installs.
#
# Despite the extension, IINA expects a plain ZIP archive, not a gzip tarball.
#
# The list of files is taken from the repository, so that a file that is
# added is packed without having to remember to add it here as well.
#
# Usage: scripts/package.sh [output-directory]
set -euo pipefail

cd "$(dirname "$0")/.."

OUT_DIR="${1:-$(pwd)/dist}"
NAME="$(python3 -c "import json;print(json.load(open('Info.json'))['identifier'])")"
VERSION="$(python3 -c "import json;print(json.load(open('Info.json'))['version'])")"
ARCHIVE="$OUT_DIR/${NAME}.iinaplgz"

mkdir -p "$OUT_DIR"
rm -f "$ARCHIVE"

# The files that make up the plugin. Everything else in the repository is
# either part of the development or belongs to the release notes.
FILES="Info.json
main.js
i18n.js
state.js
config.js
player.js
cache.js
ui.js
session.js
setup.js
commands.js
srt.js
zh.js
script.js
worker.js
engines.js
decoder.js
models.js
pref.html
sidebar.html
README.md
README.zh-CN.md
TESTING.md
docs/screenshot.png
docs/OPENCC-LICENSE.txt
LICENSE"

# The archive holds the plugin files flat, without a wrapping directory.
# shellcheck disable=SC2086
zip -q -r "$ARCHIVE" $FILES -x '*.DS_Store'

# Every file has to be in there, and nothing else may be.
NAMES="$(unzip -Z1 "$ARCHIVE")"
for file in $FILES; do
  if ! grep -qx "$file" <<< "$NAMES"; then
    echo "error: $file is missing from the package" >&2
    exit 1
  fi
done

COUNT="$(grep -c . <<< "$NAMES")"
if [ "$COUNT" -ne "$(echo "$FILES" | wc -w | tr -d ' ')" ]; then
  echo "error: the package holds $COUNT files, but $(echo "$FILES" | wc -w | tr -d ' ') were expected" >&2
  exit 1
fi

echo "packaged $ARCHIVE"
echo "  version: $VERSION"
echo "  files:   $COUNT"
echo "  format:  $(file -b "$ARCHIVE")"
ls -lh "$ARCHIVE" | awk '{print "  size:    " $5}'

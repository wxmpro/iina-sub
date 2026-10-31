#!/bin/bash
# Package the plugin into an .iinaplgz archive, the format IINA installs.
#
# Despite the extension, IINA expects a plain ZIP archive, not a gzip tarball.
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

# The archive holds the plugin files flat, without a wrapping directory.
zip -q -r "$ARCHIVE" \
  Info.json \
  main.js \
  srt.js \
  worker.js \
  engines.js \
  decoder.js \
  models.js \
  pref.html \
  sidebar.html \
  README.md \
  LICENSE \
  -x '*.DS_Store'

echo "packaged $ARCHIVE"
echo "  version: $VERSION"
echo "  format:  $(file -b "$ARCHIVE")"
ls -lh "$ARCHIVE" | awk '{print "  size:    " $5}'

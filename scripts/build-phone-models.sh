#!/bin/bash
# Assemble and verify the phone analysis models release (docs/PHONE-STANDALONE.md).
#
# The table in mobile/src/analysis/models.ts is the single source of truth:
# this script only checks real files against it and stages them for upload.
# The release itself is published BY A HUMAN — nothing here talks to GitHub
# unless you pass --upload, and the tag is immutable: a model revision ships
# as a NEW tag stamped into models.ts, never a rewrite of an old one (the
# desktop models-1 precedent).
#
# usage: scripts/build-phone-models.sh <dir holding the three .onnx> [--upload]
#
# Where to find the files:
#   htdemucs_6s_fp16weights.onnx — HF StemSplitio/htdemucs-6s-onnx (the ONNX
#     pack's model-cache snapshot holds it too; HF blobs are extension-less,
#     take the snapshot path, never glob the blobs dir)
#   beat_this.onnx + logmel.onnx — any built splitter pack (build-gpu-pack /
#     build-onnx-pack outputs), models/ inside the tar.
set -euo pipefail

SRC=${1:?usage: build-phone-models.sh <dir with the three .onnx> [--upload]}
UPLOAD=${2:-}
REPO_ROOT=$(cd "$(dirname "$0")/.." && pwd)
TABLE_TS="$REPO_ROOT/mobile/src/analysis/models.ts"
OUT="$REPO_ROOT/out/phone-models"

TAG=$(grep "PHONE_MODELS_TAG = " "$TABLE_TS" | sed "s/.*'\(.*\)'.*/\1/" || true)
[ -n "$TAG" ] || { echo "could not read PHONE_MODELS_TAG from $TABLE_TS"; exit 1; }

# file<TAB>bytes<TAB>sha256 rows straight out of the TS table
TABLE=$(node -e '
const t = require("fs").readFileSync(process.argv[1], "utf8")
const re = /file:\s*'\''([^'\'']+)'\''[\s\S]*?bytes:\s*(\d+)[\s\S]*?sha256:\s*'\''([0-9a-f]{64})'\''/g
let m
while ((m = re.exec(t))) console.log([m[1], m[2], m[3]].join("\t"))
' "$TABLE_TS")
[ -n "$TABLE" ] || { echo "could not parse the model table from $TABLE_TS"; exit 1; }

mkdir -p "$OUT"
FILES=()
while IFS=$'\t' read -r file bytes sha; do
  path="$SRC/$file"
  [ -f "$path" ] || { echo "MISSING $file (looked in $SRC)"; exit 1; }
  actual_bytes=$(stat -f%z "$path" 2>/dev/null || stat -c%s "$path")
  [ "$actual_bytes" = "$bytes" ] || {
    echo "SIZE MISMATCH $file: table says $bytes, file is $actual_bytes"
    echo "(a new model revision means a NEW tag + updated table, not a re-upload)"
    exit 1
  }
  actual_sha=$(shasum -a 256 "$path" | cut -d' ' -f1)
  [ "$actual_sha" = "$sha" ] || {
    echo "SHA MISMATCH $file: table says $sha, file is $actual_sha"
    exit 1
  }
  cp "$path" "$OUT/$file"
  echo "ok  $file  $bytes bytes  $sha"
  FILES+=("$OUT/$file")
done <<<"$TABLE"

echo
echo "Staged $(printf '%s\n' "${FILES[@]}" | wc -l | tr -d ' ') assets in $OUT for tag $TAG."
CMD=(gh release create "$TAG" --title "Phone analysis models ($TAG)" \
  --notes "Pinned model assets for on-phone splitting and beat analysis. Downloaded by the app on demand; see docs/PHONE-STANDALONE.md." \
  "${FILES[@]}")
if [ "$UPLOAD" = "--upload" ]; then
  echo "Running: ${CMD[*]}"
  "${CMD[@]}"
else
  echo "To publish (your call, releases must stay public):"
  printf '  %q' "${CMD[@]}"; echo
fi

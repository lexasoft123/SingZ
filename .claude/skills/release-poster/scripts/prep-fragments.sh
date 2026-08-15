#!/usr/bin/env bash
# Resize each captured fragment to the exact width the template displays it at.
#
# This is the whole sharpness trick. A 1206px phone screenshot dropped into a
# 264px slot is downscaled 4.6x by the renderer, and the app's own small text
# turns to mush. Doing the reduction here with lanczos + a mild unsharp, so the
# render resamples nothing, measurably holds detail the other way loses.
#
# Usage: prep-fragments.sh <shots-dir> <out-dir> [widths.json]
set -euo pipefail

SRC="${1:?usage: prep-fragments.sh <shots-dir> <out-dir> [widths.json]}"
OUT="${2:?out dir required}"
SKILL_DIR="$(cd "$(dirname "$0")/.." && pwd)"
WIDTHS="${3:-$SKILL_DIR/assets/fragment-widths.json}"

mkdir -p "$OUT"

# name<TAB>width, skipping the _comment key
python3 -c '
import json, sys
for k, v in json.load(open(sys.argv[1])).items():
    if not k.startswith("_"):
        print(f"{k}\t{v}")
' "$WIDTHS" | while IFS=$'\t' read -r name width; do
  src="$SRC/$name.png"
  if [ ! -f "$src" ]; then
    echo "skip $name (not captured)"
    continue
  fi
  have=$(/usr/bin/sips -g pixelWidth "$src" | awk '/pixelWidth/{print $2}')
  if [ "$have" = "$width" ]; then
    cp "$src" "$OUT/$name.png"
    echo "pass $name (already $width)"
  else
    ffmpeg -y -loglevel error -i "$src" \
      -vf "scale=$width:-1:flags=lanczos,unsharp=3:3:0.7:3:3:0.0" "$OUT/$name.png"
    echo "prep $name $have -> $width"
  fi
done

echo "FRAGMENTS READY in $OUT"

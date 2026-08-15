#!/usr/bin/env bash
# Turn raw simulator/emulator screenshots into the two files the template names.
#
# capture-phone.sh writes phone-ios-<timestamp>.png; the template and
# fragment-widths.json expect phone-cat-crop.png and phone-kar-crop.png. This
# is the step between, and it exists because doing it by hand invites two
# different answers on two different runs.
#
# The crops are proportional, not pixel counts, so they survive a different
# device size: the catalog keeps its top slice (tab row, "Add a song" and the
# first songs — the rest of a dev library is usually test junk), and the player
# keeps almost everything, trimming only the home indicator.
#
# Usage: make-phone-crops.sh <catalog.png> <player.png> <out-dir>
#                            [catalog-fraction] [player-fraction]
set -euo pipefail

CAT="${1:?usage: make-phone-crops.sh <catalog.png> <player.png> <out-dir> [catF] [playF]}"
PLAY="${2:?player screenshot required}"
OUT="${3:?out dir required}"
CAT_F="${4:-0.572}"
PLAY_F="${5:-0.980}"

mkdir -p "$OUT"

crop_top() { # crop_top <src> <fraction> <dst>
  local w h nh
  w=$(/usr/bin/sips -g pixelWidth "$1" | awk '/pixelWidth/{print $2}')
  h=$(/usr/bin/sips -g pixelHeight "$1" | awk '/pixelHeight/{print $2}')
  nh=$(python3 -c "print(int($h * $2))")
  ffmpeg -y -loglevel error -i "$1" -vf "crop=$w:$nh:0:0" "$3"
  echo "  $(basename "$3")  ${w}x${h} -> ${w}x${nh}"
}

echo "phone crops:"
crop_top "$CAT"  "$CAT_F"  "$OUT/phone-cat-crop.png"
crop_top "$PLAY" "$PLAY_F" "$OUT/phone-kar-crop.png"
echo "PHONE CROPS READY in $OUT"

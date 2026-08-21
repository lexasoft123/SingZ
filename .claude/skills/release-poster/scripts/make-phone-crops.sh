#!/usr/bin/env bash
# Turn raw simulator/emulator screenshots into the two files the template names.
#
# capture-phone.sh writes phone-ios-<timestamp>.png; the template and
# fragment-widths.json expect phone-cat-crop.png and phone-kar-crop.png. This
# is the step between, and it exists because doing it by hand invites two
# different answers on two different runs.
#
# THE DEFAULT IS NO CROP, and that is the whole point. A phone fragment is the
# whole screen: the device's aspect is what makes it read as a phone, and this
# script used to default to 0.572 for the catalog, which turns a 0.46 iPhone
# into a 0.80 rectangle — 74% too wide, and it stops looking like a device.
# That shipped once and the verdict was "posters are ugly, why phones are shot
# not in their original size". The fractions remain for trimming a home
# indicator or a stray row, not for fitting a fragment into a box: make it fit
# by choosing a display WIDTH in the template, never by cropping it shorter.
#
# Anything that moves the ratio more than 5% is refused rather than warned
# about, because the failure is purely visual and passes every other gate —
# check-widths.cjs measures width alone and prints ALL FRAGMENTS 1:1 over it.
#
# Usage: make-phone-crops.sh <catalog.png> <player.png> <out-dir>
#                            [catalog-fraction] [player-fraction]
set -euo pipefail

CAT="${1:?usage: make-phone-crops.sh <catalog.png> <player.png> <out-dir> [catF] [playF]}"
PLAY="${2:?player screenshot required}"
OUT="${3:?out dir required}"
CAT_F="${4:-1.0}"
PLAY_F="${5:-1.0}"

mkdir -p "$OUT"

crop_top() { # crop_top <src> <fraction> <dst>
  local w h nh
  w=$(/usr/bin/sips -g pixelWidth "$1" | awk '/pixelWidth/{print $2}')
  h=$(/usr/bin/sips -g pixelHeight "$1" | awk '/pixelHeight/{print $2}')
  nh=$(python3 -c "print(int($h * $2))")
  python3 - "$w" "$h" "$nh" "$(basename "$3")" <<'GUARD'
import sys
w, h, nh, name = int(sys.argv[1]), int(sys.argv[2]), int(sys.argv[3]), sys.argv[4]
if nh <= 0:
    sys.exit(f"make-phone-crops: refusing {name} — a fraction of {nh/h if h else 0} leaves no image.")
src, out = w / h, w / nh
if abs(out / src - 1) > 0.05:
    sys.exit(
        f"make-phone-crops: refusing {name} — {w}x{nh} is ratio {out:.4f} against "
        f"the device's {src:.4f} ({(out/src-1)*100:+.0f}%). A phone fragment keeps "
        f"its aspect; size it with a display WIDTH in the template instead."
    )
GUARD
  ffmpeg -y -loglevel error -i "$1" -vf "crop=$w:$nh:0:0" "$3"
  python3 -c "print('  %s  %sx%s -> %sx%s  (ratio %.4f)' % ('$(basename "$3")', $w, $h, $w, $nh, $w/$nh))"
}

echo "phone crops:"
crop_top "$CAT"  "$CAT_F"  "$OUT/phone-cat-crop.png"
crop_top "$PLAY" "$PLAY_F" "$OUT/phone-kar-crop.png"
echo "PHONE CROPS READY in $OUT"

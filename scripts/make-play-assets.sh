#!/usr/bin/env bash
# Store graphics for the Google Play listing, to Play's spec:
#   icon      512x512, PNG, no alpha
#   feature   1024x500, PNG, no alpha
#   phone     2-8 shots, PNG, no alpha, 320-3840px/side, longest side <= 2x shortest
#
# The icon and the feature graphic regenerate from sources in the repo. The
# screenshots cannot — they come off a running app — so this crops whatever raw
# captures are sitting in docs/play-assets/raw/. Capture them with:
#
#   adb -s <emulator> exec-out screencap -p > docs/play-assets/raw/<name>.png
#
# Use an emulator, never the phone plugged into the same Mac: `adb` with two
# devices attached picks neither, and `-s` is the only thing that makes the
# target unambiguous. Boot it with `-no-audio` (the app makes noise) and
# `-no-snapshot-load`, or a restored snapshot silently reverts the build you
# just installed to whatever was there before.
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=docs/play-assets
RAW=$OUT/raw
mkdir -p "$OUT" "$RAW"

need() { command -v "$1" >/dev/null || { echo "missing: $1" >&2; exit 1; }; }
need ffmpeg
need sips

# --- icon ------------------------------------------------------------------
# The iOS app icon is the only 1024px source in the tree, and it is already
# alpha-free, which is what Play wants.
ICON_SRC=mobile/ios/SingZPlayer/Images.xcassets/AppIcon.appiconset/AppIcon.png
sips -Z 512 -s format png "$ICON_SRC" --out "$OUT/icon-512.png" >/dev/null
echo "icon-512.png"

# --- feature graphic -------------------------------------------------------
# Rendered from feature.src.html so the copy and the palette stay editable and
# reviewable as text. Headless Chrome is the only renderer on a stock Mac that
# gets web fonts and gradients right.
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"
if [ -x "$CHROME" ]; then
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --screenshot="$OUT/feature-1024x500.png" --window-size=1024,500 \
    "file://$PWD/$OUT/feature.src.html" 2>/dev/null
  echo "feature-1024x500.png"
else
  echo "skipped feature graphic — Google Chrome not installed" >&2
fi

# --- hero poster (the first screenshot) ------------------------------------
# The first screenshot is the one people actually look at, so it is composed
# rather than captured: headline over a framed shot of the mixer. The template
# carries no image data — the capture is inlined here at run time so it lives
# in raw/ only.
HERO=$RAW/hero-mixer.png
if [ -x "$CHROME" ] && [ -f "$OUT/poster.tmpl.html" ] && [ -f "$HERO" ]; then
  TMP=$(mktemp -d)
  # Strip the status and navigation bars; a store poster showing an emulator
  # clock and debug icons looks like a screenshot of a development machine.
  ffmpeg -y -loglevel error -i "$HERO" -vf "crop=1080:2144:0:112" -pix_fmt rgb24 "$TMP/hero.png"
  node -e '
    const fs = require("fs")
    const [tmpl, shot, out] = process.argv.slice(1)
    fs.writeFileSync(out, fs.readFileSync(tmpl, "utf8")
      .replace("__SHOT_B64__", fs.readFileSync(shot).toString("base64")))
  ' "$OUT/poster.tmpl.html" "$TMP/hero.png" "$TMP/poster.html"
  "$CHROME" --headless --disable-gpu --hide-scrollbars \
    --screenshot="$OUT/screenshot-1-poster.png" --window-size=1206,2144 \
    "file://$TMP/poster.html" 2>/dev/null
  rm -rf "$TMP"
  echo "screenshot-1-poster.png"
elif [ ! -x "$CHROME" ]; then
  echo "skipped poster — Google Chrome not installed" >&2
fi

# --- screenshots -----------------------------------------------------------
# Two steps, because the console asks for two different things.
#
# Crop: a 1080x2400 phone is 2.22:1, past the "longest side <= 2x shortest"
# limit. Taking 112px off the top and the rest off the bottom lands at
# 1080x2144 and removes the status and navigation bars, which a store listing
# is better without.
#
# Pad: the upload form asks for 16:9 or 9:16 exactly, which 1080x2144 (1.985:1)
# is not, even though it satisfies the documented 2:1 rule. Widening to 1206
# (2144 * 9/16) makes it exactly 9:16 and crops nothing — the bars are the app's
# own background colour and invisible against its dark UI.
shopt -s nullglob
n=0
for src in "$RAW"/*.png; do
  name=$(basename "$src")
  # the hero is the poster's source, not a screenshot of its own
  [ "${name#hero-}" != "$name" ] && continue
  h=$(sips -g pixelHeight "$src" | awk '/pixelHeight/{print $2}')
  w=$(sips -g pixelWidth  "$src" | awk '/pixelWidth/{print $2}')
  if [ "$w" = "1080" ] && [ "$h" = "2400" ]; then
    ffmpeg -y -loglevel error -i "$src" \
      -vf "crop=1080:2144:0:112,pad=1206:2144:63:0:0x12100d" \
      -pix_fmt rgb24 "$OUT/screenshot-$name"
  else
    # Unknown geometry: strip alpha, leave framing alone, and say so.
    ffmpeg -y -loglevel error -i "$src" -pix_fmt rgb24 "$OUT/screenshot-$name"
    echo "  note: $name is ${w}x${h}, not cropped — check it is under 2:1" >&2
  fi
  echo "screenshot-$name"
  n=$((n + 1))
done
[ "$n" -ge 2 ] || echo "warning: Play needs at least 2 phone screenshots (have $n)" >&2

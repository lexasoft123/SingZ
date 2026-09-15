#!/usr/bin/env bash
# The first App Store screenshot, rendered: docs/ios-assets/poster.tmpl.html
# with the raw capture docs/ios-assets/raw/hero-lyrics.png inlined, at
# 1320x2868 (the 6.9" slot). The other screenshots in docs/ios-assets/ are
# captures used as they are. Push them all with scripts/push-ios-screenshots.rb.
#
# Capture the hero on an iPhone Pro Max simulator (1320x2868) running this
# tree's Debug build, with the status bar overridden and LogBox silenced:
#   xcrun simctl status_bar <udid> override --time 9:41 --batteryState discharging --batteryLevel 100
#   xcrun simctl io <udid> screenshot docs/ios-assets/raw/hero-lyrics.png
set -euo pipefail

cd "$(dirname "$0")/.."
OUT=docs/ios-assets
HERO=$OUT/raw/hero-lyrics.png
CHROME="/Applications/Google Chrome.app/Contents/MacOS/Google Chrome"

[ -x "$CHROME" ] || { echo "Google Chrome is needed to render the poster" >&2; exit 1; }
[ -f "$HERO" ] || { echo "missing $HERO — capture it first (see the header)" >&2; exit 1; }

TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
node -e '
  const fs = require("fs")
  const [tmpl, shot, out] = process.argv.slice(1)
  const marker = "__SHOT_B64__"
  const t = fs.readFileSync(tmpl, "utf8")
  // Exactly once, or the capture lands somewhere else and the phone renders
  // empty — which reads as a design choice rather than a failure.
  const hits = t.split(marker).length - 1
  if (hits !== 1) {
    console.error(`poster template: expected ${marker} exactly once, found ${hits}`)
    process.exit(1)
  }
  fs.writeFileSync(out, t.replace(marker, fs.readFileSync(shot).toString("base64")))
' "$OUT/poster.tmpl.html" "$HERO" "$TMP/poster.html"
# --virtual-time-budget: a data URI this large can otherwise miss the shot.
"$CHROME" --headless --disable-gpu --hide-scrollbars --force-device-scale-factor=1 \
  --virtual-time-budget=8000 --screenshot="$TMP/poster.png" --window-size=1320,2868 \
  "file://$TMP/poster.html" 2>/dev/null
# App Store Connect refuses an alpha channel.
sips -s format png -s formatOptions default "$TMP/poster.png" --out "$OUT/01-poster.png" >/dev/null
ffmpeg -y -loglevel error -i "$OUT/01-poster.png" -pix_fmt rgb24 "$TMP/flat.png" && mv "$TMP/flat.png" "$OUT/01-poster.png"
w=$(sips -g pixelWidth "$OUT/01-poster.png" | awk '/pixelWidth/{print $2}')
h=$(sips -g pixelHeight "$OUT/01-poster.png" | awk '/pixelHeight/{print $2}')
[ "$w" = 1320 ] && [ "$h" = 2868 ] || { echo "poster came out ${w}x${h}, not 1320x2868" >&2; exit 1; }
echo "$OUT/01-poster.png"

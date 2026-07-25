#!/usr/bin/env bash
# Build whisper.cpp's whisper-cli into vendor/<platform>-<arch>/ for bundling.
# Usage: scripts/vendor-whisper.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/.engines-src/whisper.cpp"

mkdir -p "$ROOT/.engines-src"
if [ ! -d "$SRC" ]; then
  git clone --depth 1 https://github.com/ggml-org/whisper.cpp "$SRC"
fi

EXTRA=""
case "$TARGET" in
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL_EMBED_LIBRARY=ON" ;;
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_NATIVE=OFF -DGGML_METAL=OFF" ;;
esac

BUILD="$SRC/build-$TARGET"
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF $EXTRA
cmake --build "$BUILD" -j --config Release --target whisper-cli

mkdir -p "$ROOT/vendor/$TARGET"
BIN="$BUILD/bin/whisper-cli"
[ -f "$BIN" ] || BIN="$BUILD/bin/Release/whisper-cli.exe"
cp "$BIN" "$ROOT/vendor/$TARGET/"
echo "vendored: $ROOT/vendor/$TARGET/$(basename "$BIN")"

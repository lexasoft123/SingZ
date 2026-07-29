#!/usr/bin/env bash
# Build whisper.cpp's whisper-cli into vendor/<platform>-<arch>/ for bundling.
# Usage: scripts/vendor-whisper.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/.engines-src/whisper.cpp"

# Compiler cache when the machine has one: repeat builds (fresh worktrees,
# wiped build dirs) hit ccache instead of clang. CMake >= 3.17 picks the
# launchers up from the environment — same mechanism the Android CI uses.
if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
fi

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
if [ -f "$ROOT/vendor/$TARGET/whisper-cli$EXT" ]; then
  echo "cached: vendor/$TARGET/whisper-cli$EXT"
  exit 0
fi

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
cp "$BIN" "$ROOT/vendor/$TARGET/whisper-cli$EXT"
echo "vendored: $ROOT/vendor/$TARGET/whisper-cli$EXT"

#!/usr/bin/env bash
# Build llama.cpp's llama-server into vendor/<platform>-<arch>/ for bundling.
# This is the Qwen3-ASR engine (audio in through mtmd); whisper-cli remains the
# default recogniser and is built by vendor-whisper.sh.
# Usage: scripts/vendor-llama.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/.engines-src/llama.cpp"
# Pinned: the audio path is young and moves week to week, so a fleet-wide
# rebuild must land the same engine everywhere rather than whatever master
# happened to be. Measured on b11026 (Mac arm64 Metal, Windows x64 CPU).
REF=${SINGZ_LLAMA_REF:-b11026}

if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
if [ -f "$ROOT/vendor/$TARGET/llama-server$EXT" ]; then
  echo "cached: vendor/$TARGET/llama-server$EXT"
  exit 0
fi

mkdir -p "$ROOT/.engines-src"
if [ ! -d "$SRC" ]; then
  git clone --depth 1 --branch "$REF" https://github.com/ggml-org/llama.cpp "$SRC"
fi

EXTRA=""
case "$TARGET" in
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL_EMBED_LIBRARY=ON" ;;
  # Intel Macs have no usable Metal path for this model; CPU only, and no
  # -march=native so the binary runs on every machine in the fleet.
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_NATIVE=OFF -DGGML_METAL=OFF" ;;
  # Windows stays CPU too: the field laptops' GPUs predate Vulkan 1.2, which
  # is what llama.cpp's Vulkan backend requires (measured 2026-09-18 — the
  # Vulkan build refuses to start there), and a CUDA build would only serve
  # the RTX machines while adding hundreds of MB to every installer.
  win32-*) EXTRA="-DGGML_NATIVE=OFF" ;;
esac

BUILD="$SRC/build-$TARGET"
# llama.cpp turns HTTPS on by default (LLAMA_OPENSSL, CMakeLists.txt:144) and
# links whatever OpenSSL it finds by absolute path — Homebrew's here. Useless
# for a server this app only ever reaches on 127.0.0.1, and fatal on a machine
# without that library: the assertion below caught exactly that binary.
# Turning the option off is what actually decides it. Ignoring the package
# manager's prefixes as well is belt and braces for everything else CMake
# might find there, and it is what the aligner's script does — but note the
# prefix list cannot be exhaustive (conda, nix and vcpkg are not in it), which
# is precisely why the option matters on win32, where no assertion runs.
IGNORE="/opt/homebrew;/usr/local;/opt/local"
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DBUILD_SHARED_LIBS=OFF \
  -DLLAMA_BUILD_TESTS=OFF -DLLAMA_BUILD_EXAMPLES=OFF -DLLAMA_CURL=OFF \
  -DLLAMA_OPENSSL=OFF \
  -DCMAKE_IGNORE_PREFIX_PATH="$IGNORE" -DCMAKE_IGNORE_PATH="$IGNORE" $EXTRA
cmake --build "$BUILD" -j --config Release --target llama-server

mkdir -p "$ROOT/vendor/$TARGET"
BIN="$BUILD/bin/llama-server"
[ -f "$BIN" ] || BIN="$BUILD/bin/Release/llama-server.exe"
cp "$BIN" "$ROOT/vendor/$TARGET/llama-server$EXT"

# BUILD_SHARED_LIBS=OFF above is the intention; this is the check. The sibling
# script shipped a machine-local engine while every flag looked right.
"$ROOT/scripts/assert-portable-binary.sh" "$TARGET" "$ROOT/vendor/$TARGET/llama-server$EXT" "$BUILD"
echo "vendored: $ROOT/vendor/$TARGET/llama-server$EXT"

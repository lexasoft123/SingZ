#!/usr/bin/env bash
# Build CrispASR's `crispasr` into vendor/<platform>-<arch>/ — the runtime for
# Qwen3-ForcedAligner, which gives Qwen3-ASR's words their times.
# llama.cpp does NOT carry the aligner (only the ASR model), which is why this
# is a second engine rather than another flag on vendor-llama.sh.
# Usage: scripts/vendor-crispasr.sh [target]   e.g. darwin-arm64, win32-x64
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/.engines-src/CrispASR"
# Pinned for the same reason as llama.cpp: one engine across the fleet, not
# whatever master was that week. This is the revision every number in
# docs/DEVELOPMENT.md and src/main/qwen-align.ts was measured on.
REF=${SINGZ_CRISPASR_REF:-4b937a91998b02cdf3083d5443923554c1981b19}

if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
if [ -f "$ROOT/vendor/$TARGET/crispasr$EXT" ]; then
  echo "cached: vendor/$TARGET/crispasr$EXT"
  exit 0
fi

mkdir -p "$ROOT/.engines-src"
if [ ! -d "$SRC" ]; then
  git clone --filter=blob:none https://github.com/CrispStrobe/CrispASR "$SRC"
fi
# Outside the clone guard on purpose: a tree left behind by an earlier run sits
# at whatever it was cloned at, and the binary skip-guard above hides that until
# somebody deletes the vendored engine to force a rebuild — which is exactly the
# person the pin is for. Checking out every time costs nothing and cannot drift.
git -C "$SRC" fetch --depth 1 origin "$REF"
git -C "$SRC" checkout --detach FETCH_HEAD
git -C "$SRC" submodule update --init --recursive --depth 1

EXTRA=""
case "$TARGET" in
  # EMBED_LIBRARY or the binary hunts for a default.metallib beside itself,
  # which a vendored copy does not have.
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON" ;;
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_NATIVE=OFF -DGGML_METAL=OFF" ;;
  win32-*) EXTRA="-DGGML_NATIVE=OFF" ;;
esac

BUILD="$SRC/build-$TARGET"
# Keep the build off the build machine's package manager entirely.
#
# Two things that cost a rebuild to learn, both invisible until the binary
# leaves this machine. CrispASR find_library()s lame and opus for optional MP3
# and Opus OUTPUT — which an aligner never writes — and links them by absolute
# Homebrew path, so the vendored engine died on any machine without Homebrew.
# The same prefix put /opt/homebrew/include ahead of CrispASR's own sources,
# where Homebrew's whisper.cpp keeps a parakeet.h that shadows CrispASR's and
# breaks the build outright. Ignoring the prefix removes both: no optional
# codecs found, no stray include path, and nothing to patch afterwards.
# /usr/local is the Intel Mac's Homebrew and MacPorts' neighbour.
IGNORE="/opt/homebrew;/usr/local;/opt/local"
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DCRISPASR_BUILD_TESTS=OFF \
  -DBUILD_SHARED_LIBS=OFF \
  -DCMAKE_IGNORE_PREFIX_PATH="$IGNORE" -DCMAKE_IGNORE_PATH="$IGNORE" $EXTRA

cmake --build "$BUILD" -j --config Release --target crispasr-cli

mkdir -p "$ROOT/vendor/$TARGET"
BIN="$BUILD/bin/crispasr"
[ -f "$BIN" ] || BIN="$BUILD/bin/Release/crispasr.exe"
cp "$BIN" "$ROOT/vendor/$TARGET/crispasr$EXT"

# Check the output, not just the flags — see the helper for what this caught.
"$ROOT/scripts/assert-portable-binary.sh" "$TARGET" "$ROOT/vendor/$TARGET/crispasr$EXT" "$BUILD"
echo "vendored: $ROOT/vendor/$TARGET/crispasr$EXT"

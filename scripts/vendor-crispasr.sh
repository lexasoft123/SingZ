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

# Check the output, not just the flags. This script shipped once producing a
# binary that ran here and nowhere else — GGML and CrispASR's own libraries by
# @rpath out of the build tree, lame and opus by absolute Homebrew path — and
# nothing noticed until the tree was moved away. The flags above prevent it;
# this proves it, which is not the same thing: CMake caches find_library
# results, so a build directory left by an earlier revision of this script
# keeps pointing at Homebrew however the prefix is ignored now.
# A failed check removes the engine, or the skip-guard at the top would hand
# the next run the very binary that just failed.
if [ "${TARGET#darwin-}" != "$TARGET" ]; then
  STRAY=$(otool -L "$ROOT/vendor/$TARGET/crispasr" | tail -n +2 |
    grep -v '^[[:space:]]*/usr/lib/\|^[[:space:]]*/System/' || true)
  if [ -n "$STRAY" ]; then
    rm -f "$ROOT/vendor/$TARGET/crispasr"
    echo "vendor-crispasr: the engine links libraries a user machine will not have:" >&2
    echo "$STRAY" >&2
    echo "delete $BUILD and run again — CMake caches its find_library answers" >&2
    exit 1
  fi
fi
echo "vendored: $ROOT/vendor/$TARGET/crispasr$EXT"

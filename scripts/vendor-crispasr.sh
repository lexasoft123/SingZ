#!/usr/bin/env bash
# Build CrispASR's `crispasr` into vendor/<platform>-<arch>/ — the runtime for
# Qwen3-ForcedAligner, which gives Qwen3-ASR's words their times.
# llama.cpp does NOT carry the aligner (only the ASR model), which is why this
# is a second engine rather than another flag on vendor-llama.sh.
# Usage: scripts/vendor-crispasr.sh [target]   e.g. darwin-arm64, win32-x64
set -euo pipefail

ROOT=$(cd "$(dirname "$0")/.." && pwd)
CHECK_CACHE=0
if [ "${1:-}" = "--check-cache" ]; then CHECK_CACHE=1; shift; fi
TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
case "$TARGET" in
  darwin-arm64|darwin-x64|win32-arm64|win32-x64|linux-arm64|linux-x64) ;;
  *) echo "Unsupported native target: $TARGET" >&2; exit 1 ;;
esac
SRC="$ROOT/.engines-src/CrispASR"
# Pinned for the same reason as llama.cpp: one engine across the fleet, not
# whatever master was that week. This is the revision every number in
# docs/DEVELOPMENT.md and src/main/qwen-align.ts was measured on.
REF=${SINGZ_CRISPASR_REF:-4b937a91998b02cdf3083d5443923554c1981b19}

# Read-only provisioning check: use this checkout's pin and producer inputs
# when deciding whether another checkout's artifact can be linked.
if [ "$CHECK_CACHE" = 1 ]; then
  exec node "$ROOT/scripts/engine-artifact.cjs" check "${2:-$ROOT}" crispasr "$TARGET" "$REF" "$ROOT"
fi
# These scripts have no cross-OS/non-Darwin cross-architecture toolchain.
node "$ROOT/scripts/engine-artifact.cjs" assert-build-target "$TARGET"
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$ROOT/scripts/with-native-build-lock.mjs" \
    --owner vendor-crispasr -- bash "$ROOT/scripts/vendor-crispasr.sh" "$@"
fi
node "$ROOT/scripts/assert-native-build-lock.cjs"
JOBS=${SINGZ_NATIVE_JOBS:-4}
case "$JOBS" in 1|2|3|4) ;; *) echo "SINGZ_NATIVE_JOBS must be an integer from 1 through 4" >&2; exit 1 ;; esac

if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
if node "$ROOT/scripts/engine-artifact.cjs" check "$ROOT" crispasr "$TARGET" "$REF"; then
  echo "cached: vendor/$TARGET/crispasr$EXT"
  exit 0
fi

PRODUCER_HASH=$(node "$ROOT/scripts/engine-artifact.cjs" producer-hash "$ROOT" crispasr)
mkdir -p "$ROOT/.engines-src"
if [ ! -d "$SRC" ]; then
  git clone --filter=blob:none https://github.com/CrispStrobe/CrispASR "$SRC"
fi
# Outside the clone guard on purpose: a tree left behind by an earlier run sits
# at whatever it was cloned at, and the binary skip-guard above hides that until
# somebody deletes the vendored engine to force a rebuild — which is exactly the
# person the pin is for. Checking out every time costs nothing and cannot drift.
if [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
  echo "Refusing to rebuild from a modified third-party source tree: $SRC" >&2
  exit 1
fi
git -C "$SRC" fetch --depth 1 origin "$REF"
git -C "$SRC" checkout --detach FETCH_HEAD
git -C "$SRC" submodule update --init --recursive --depth 1
COMMIT=$(git -C "$SRC" rev-parse HEAD)

EXTRA=""
case "$TARGET" in
  # EMBED_LIBRARY or the binary hunts for a default.metallib beside itself,
  # which a vendored copy does not have.
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON -DGGML_METAL_EMBED_LIBRARY=ON" ;;
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_NATIVE=OFF -DGGML_METAL=OFF" ;;
  win32-*) EXTRA="-DGGML_NATIVE=OFF" ;;
  linux-x64) EXTRA="-DGGML_NATIVE=OFF" ;;
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

cmake --build "$BUILD" --parallel "$JOBS" --config Release --target crispasr-cli

BIN="$BUILD/bin/crispasr"
[ -f "$BIN" ] || BIN="$BUILD/bin/Release/crispasr.exe"

# Check the output, not just the flags — see the helper for what this caught.
"$ROOT/scripts/assert-portable-binary.sh" "$TARGET" "$BIN" "$BUILD"
if [ "$(git -C "$SRC" rev-parse HEAD)" != "$COMMIT" ] ||
   [ -n "$(git -C "$SRC" status --porcelain --untracked-files=no)" ]; then
  echo "Third-party sources changed during the build; rerun it." >&2
  exit 1
fi
node "$ROOT/scripts/engine-artifact.cjs" publish "$ROOT" crispasr "$TARGET" "$REF" "$COMMIT" "$BIN" "$PRODUCER_HASH"
echo "vendored: $ROOT/vendor/$TARGET/crispasr$EXT"

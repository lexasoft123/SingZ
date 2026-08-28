#!/usr/bin/env bash
# Build singz-analyze into vendor/<platform>-<arch>/ for bundling — the core's
# detectors shipped beside whisper-cli, dark until main learns to spawn them
# (docs/PHONE-STANDALONE.md, Phase 4c). A source fingerprint guards the cache:
# an older helper may still run melody correctly while lacking newer commands
# such as input-devices, so existence alone is not proof that it is current.
#   scripts/vendor-analyze.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
#
# One build definition: mobile/native/core/CMakeLists.txt, shared with
# build-analyze-host.sh, run-core-host-tests.sh and the Core Windows workflow.
# One fingerprint definition too: scripts/analyze-source-hash.sh, which the
# desktop also runs to check the binary it spawns against the tree it has.
# darwin-x64 cross-compiles from an arm64 Mac via CMAKE_OSX_ARCHITECTURES —
# the tree is plain C/C++ with no arch-conditional sources.
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
OUT_DIR="$ROOT/vendor/$TARGET"
OUT="$OUT_DIR/singz-analyze$EXT"
STAMP="$OUT.source-hash"
# The fingerprint lives in scripts/analyze-source-hash.sh, not here: the
# running app recomputes it to check the binary it is about to spawn came
# from this tree (src/main/analyze-provenance.ts), and two copies of the
# algorithm would be two answers to one question.
SOURCE_HASH=$("$ROOT/scripts/analyze-source-hash.sh" "$ROOT")
if [ -f "$OUT" ] && [ -f "$STAMP" ] && [ "$(tr -d '\r\n' < "$STAMP")" = "$SOURCE_HASH" ]; then
  echo "cached: vendor/$TARGET/singz-analyze$EXT"
  exit 0
fi

# ccache when present — same launcher/base_dir/hash_dir story as
# vendor-whisper.sh, so sibling worktrees hit.
if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

# Keyed on the CHECKOUT, not just the target: every worktree builds its own
# singz-analyze now (scripts/worktree-setup.sh no longer shares ours), and one
# shared build dir would have two roots fighting over a CMakeCache that names
# a source directory.
BUILD="${TMPDIR:-/tmp}/singz-analyze-vendor-$TARGET-$(printf '%s' "$ROOT" | git hash-object --stdin | cut -c1-8)"
# The hash goes INTO the binary as well as beside it: `singz-analyze
# build-info` then answers for itself, which a sidecar cannot do for an
# $SINGZ_ANALYZE override or a hand-copied file. It lands in a generated TU
# in the build dir, so a changed hash recompiles one trivial file.
CONFIG_ARGS=(-DSINGZ_CORE_TESTS=OFF "-DSINGZ_SOURCE_HASH=$SOURCE_HASH")
case "$TARGET" in
  darwin-arm64) CONFIG_ARGS+=(-DCMAKE_OSX_ARCHITECTURES=arm64) ;;
  darwin-x64) CONFIG_ARGS+=(-DCMAKE_OSX_ARCHITECTURES=x86_64) ;;
esac

cmake -S "$ROOT/mobile/native/core" -B "$BUILD" "${CONFIG_ARGS[@]}"
cmake --build "$BUILD" --target singz-analyze --config Release -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

mkdir -p "$OUT_DIR"
# MSVC's multi-config generator nests the exe under Release/.
if [ -f "$BUILD/Release/singz-analyze$EXT" ]; then
  cp "$BUILD/Release/singz-analyze$EXT" "$OUT"
else
  cp "$BUILD/singz-analyze$EXT" "$OUT"
fi
printf '%s\n' "$SOURCE_HASH" > "$STAMP"
echo "built: vendor/$TARGET/singz-analyze$EXT"

#!/usr/bin/env bash
# Build singz-analyze into vendor/<platform>-<arch>/ for bundling — the core's
# detectors shipped beside whisper-cli, dark until main learns to spawn them
# (docs/PHONE-STANDALONE.md, Phase 4c). Same contract as vendor-whisper.sh:
# skip-guard on the existing output, delete vendor/… to force.
#   scripts/vendor-analyze.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
#
# One build definition: mobile/native/core/CMakeLists.txt, shared with
# build-analyze-host.sh, run-core-host-tests.sh and the Core Windows workflow.
# darwin-x64 cross-compiles from an arm64 Mac via CMAKE_OSX_ARCHITECTURES —
# the tree is plain C/C++ with no arch-conditional sources.
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
OUT_DIR="$ROOT/vendor/$TARGET"
OUT="$OUT_DIR/singz-analyze$EXT"
if [ -f "$OUT" ]; then
  echo "cached: vendor/$TARGET/singz-analyze$EXT"
  exit 0
fi

# ccache when present — same launcher/base_dir/hash_dir story as
# vendor-whisper.sh, so sibling worktrees hit.
if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

BUILD="${TMPDIR:-/tmp}/singz-analyze-vendor-$TARGET"
CONFIG_ARGS=(-DSINGZ_CORE_TESTS=OFF)
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
echo "built: vendor/$TARGET/singz-analyze$EXT"

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
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64 -DGGML_METAL=ON" ;;
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64 -DGGML_NATIVE=OFF -DGGML_METAL=OFF" ;;
  win32-*) EXTRA="-DGGML_NATIVE=OFF" ;;
esac

BUILD="$SRC/build-$TARGET"
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release -DCRISPASR_BUILD_TESTS=OFF $EXTRA

# CrispASR puts the system include directory AHEAD of its own sources, so on a
# machine with Homebrew's whisper.cpp installed (this repo's own build box)
# /opt/homebrew/include/parakeet.h shadows CrispASR's parakeet.h and the build
# dies on redefinitions. Removing that directory is not the fix — lame/lame.h
# is found through it — so the project's own includes are moved in front of it.
# Both Homebrew prefixes, since an Intel Mac keeps its at /usr/local; and only
# where a python3 exists, because this is a macOS collision and the Windows
# build box has no reason to carry one.
if command -v python3 >/dev/null 2>&1; then
  python3 - "$BUILD" <<'PY'
import glob, re, sys
SYS = ('-I/opt/homebrew/include', '-I/usr/local/include')
for f in glob.glob(sys.argv[1] + '/**/flags.make', recursive=True):
    s = open(f).read()
    def fix(m):
        toks = [t for t in m.group(2).split() if t not in SYS]
        tail = [t for t in SYS if t in m.group(2).split()]
        return m.group(1) + ' ' + ' '.join(toks + tail)
    out = re.sub(r'(CXX_INCLUDES =)(.*)', fix, s)
    if out != s:
        open(f, 'w').write(out)
PY
fi

cmake --build "$BUILD" -j --config Release --target crispasr-cli

mkdir -p "$ROOT/vendor/$TARGET"
BIN="$BUILD/bin/crispasr"
[ -f "$BIN" ] || BIN="$BUILD/bin/Release/crispasr.exe"
cp "$BIN" "$ROOT/vendor/$TARGET/crispasr$EXT"
echo "vendored: $ROOT/vendor/$TARGET/crispasr$EXT"

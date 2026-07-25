#!/usr/bin/env bash
# Build demucs.cpp's multithreaded CLI into vendor/<platform>-<arch>/demucs-cli
# and fetch the htdemucs ggml weights into vendor/models/ (bundled in the app).
# Usage: scripts/vendor-demucs.sh [target]
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
ROOT=$(cd "$(dirname "$0")/.." && pwd)
SRC="$ROOT/.engines-src/demucs.cpp"

DEXT=""
case "$TARGET" in win32-*) DEXT=".exe" ;; esac
if [ -f "$ROOT/vendor/$TARGET/demucs-cli$DEXT" ] && [ -f "$ROOT/vendor/models/ggml-model-htdemucs-4s-f16.bin" ]; then
  echo "cached: vendor/$TARGET/demucs-cli$DEXT + weights"
  exit 0
fi
MODEL_URL="https://huggingface.co/datasets/Retrobear/demucs.cpp/resolve/main/ggml-model-htdemucs-4s-f16.bin"

mkdir -p "$ROOT/.engines-src" "$ROOT/vendor/models"
if [ ! -d "$SRC" ]; then
  git clone --recurse-submodules --shallow-submodules --depth 1 \
    https://github.com/sevagh/demucs.cpp "$SRC"
fi

if [ ! -f "$ROOT/vendor/models/ggml-model-htdemucs-4s-f16.bin" ]; then
  AUTH=()
  [ -n "${HF_TOKEN:-}" ] && AUTH=(-H "Authorization: Bearer $HF_TOKEN")
  curl -L --fail "${AUTH[@]}" -o "$ROOT/vendor/models/ggml-model-htdemucs-4s-f16.bin" "$MODEL_URL"
fi

EXTRA=""
case "$TARGET" in
  darwin-arm64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=arm64" ;;
  darwin-x64) EXTRA="-DCMAKE_OSX_ARCHITECTURES=x86_64" ;;
  # upstream's flags are gcc-style (-Wextra …) which MSVC rejects — use the
  # MinGW gcc via Ninja, statically linked so no MinGW DLLs are needed.
  # BLAS comes from MSYS2's mingw-w64 OpenBLAS (see CI workflow).
  win32-x64)
    MINGW_PREFIX=${MINGW_PREFIX:-/c/msys64/mingw64}
    # wavpack uses the MSVC intrinsic _BitScanReverse; mingw-w64 has it too,
    # but only after including <intrin.h>
    WVH="$SRC/vendor/libnyquist/third_party/wavpack/src/wavpack_local.h"
    if [ -f "$WVH" ] && ! grep -q '<intrin.h>' "$WVH"; then
      sed -i '1i #include <intrin.h>' "$WVH"
    fi
    # fs::path → std::string needs an explicit .string() on Windows (wchar_t paths)
    for f in "$SRC"/cli-apps/*.cpp; do
      sed -i 's/, p_target)/, p_target.string())/' "$f"
    done
    # -march=native on the CI Xeon emits AVX-512 that crashes on user CPUs —
    # pin the distributable binary to the x86-64-v2 baseline
    sed -i 's/-march=native/-march=x86-64-v2/g' "$SRC/CMakeLists.txt"
    export CPATH="$(cygpath -w "$MINGW_PREFIX/include/openblas" 2>/dev/null || echo "$MINGW_PREFIX/include/openblas")"
    # -fopenmp: MSYS2's OpenBLAS is OpenMP-threaded; -static folds libgomp in
    export LDFLAGS="-static -fopenmp"
    EXTRA="-G Ninja -DCMAKE_C_COMPILER=gcc -DCMAKE_CXX_COMPILER=g++ \
      -DBLAS_LIBRARIES=$MINGW_PREFIX/lib/libopenblas.a"
    ;;
esac

BUILD="$SRC/build-$TARGET"
# shellcheck disable=SC2086
cmake -S "$SRC" -B "$BUILD" -DCMAKE_BUILD_TYPE=Release \
  -DCMAKE_POLICY_VERSION_MINIMUM=3.5 $EXTRA
cmake --build "$BUILD" -j --config Release

mkdir -p "$ROOT/vendor/$TARGET"
BIN=$(find "$BUILD" -name 'demucs_mt.cpp.main*' -type f | head -1)
if [ -z "$BIN" ]; then
  BIN=$(find "$BUILD" -name 'demucs.cpp.main*' -type f | head -1)
fi
[ -n "$BIN" ] || { echo "demucs binary not found in $BUILD"; exit 1; }
cp "$BIN" "$ROOT/vendor/$TARGET/demucs-cli$DEXT"
echo "vendored: $ROOT/vendor/$TARGET/demucs-cli$DEXT (from $(basename "$BIN"))"

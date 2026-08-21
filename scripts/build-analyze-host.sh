#!/bin/bash
# Build the singz-analyze CLI (mobile/native/core/tools) for THIS machine —
# the core's detectors as a command-line tool: the parity harness's oracle
# (eval/melody-parity.mjs) today, the desktop's own way into the core (spawned
# by main like whisper-cli) once every detector is in. Plain C++17, no NDK.
#   scripts/build-analyze-host.sh [out-path]     default: $TMPDIR/singz-analyze
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${1:-${TMPDIR:-/tmp}/singz-analyze}"
CXX=${CXX:-c++}
CC=${CC:-cc}

# wav.cpp dispatches FLAC to the vendored libFLAC now (Phase 5), so every
# consumer of the core links it. Compiled apart as C — a C++ compile of C99
# is the wrong language — and object-cached like run-core-host-tests.sh.
FLAC_DIR="$ROOT/mobile/native/third_party/flac"
FLAC_OBJ="${TMPDIR:-/tmp}/singz-flac-obj"
mkdir -p "$FLAC_OBJ"
for c in "$FLAC_DIR"/src/*.c; do
  o="$FLAC_OBJ/$(basename "${c%.c}").o"
  if [ ! -f "$o" ] || [ "$c" -nt "$o" ] || [ "$FLAC_DIR/config.h" -nt "$o" ]; then
    "$CC" -std=c99 -O2 -DHAVE_CONFIG_H \
      -I "$FLAC_DIR" -I "$FLAC_DIR/include" -I "$FLAC_DIR/src/include" -I "$FLAC_DIR/src" \
      -c "$c" -o "$o"
  fi
done

"$CXX" -std=c++17 -O2 -Wall \
  -I "$ROOT/mobile/native/core" \
  -I "$FLAC_DIR/include" \
  "$ROOT/mobile/native/core/tools/singz-analyze.cpp" \
  "$ROOT/mobile/native/core/analysis.cpp" \
  "$ROOT/mobile/native/core/beats.cpp" \
  "$ROOT/mobile/native/core/beat_this.cpp" \
  "$ROOT/mobile/native/core/courts.cpp" \
  "$ROOT/mobile/native/core/flac_io.cpp" \
  "$ROOT/mobile/native/core/melody.cpp" \
  "$ROOT/mobile/native/core/resample.cpp" \
  "$ROOT/mobile/native/core/wav.cpp" \
  "$FLAC_OBJ"/*.o \
  -o "$OUT"
echo "$OUT"

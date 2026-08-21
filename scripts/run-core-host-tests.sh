#!/bin/bash
# Compile and run the host-side checks for mobile/native/core's ORT-free
# pieces (resampler quality, WAV writer byte contract + reader, the melody
# tracker on a synthetic phrase, the key detector on a synthetic triad), then
# the vendored libFLAC's round trip. No NDK, no device — a plain C++17 (and
# C99) compiler is the whole toolchain, so the Android CI canary can afford it
# on every mobile push.
#
# beat_this.cpp is here for that reason and no other: its ONNX calls are
# injected rather than owned precisely so the whole runner compiles and its
# logic runs with no ONNX Runtime present. Leaving it out would have meant the
# canary proved nothing about the one file written to be provable cheaply.
# Its own gate is `node eval/mlgrid-parity.mjs`, run below.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${TMPDIR:-/tmp}/singz-core-host-tests"
CXX=${CXX:-c++}
CC=${CC:-cc}

# The vendored libFLAC compiles ONCE, as C, into objects both binaries link.
# It is C99 that a C++ compile would reject, and compiling it inside each
# binary's command would compile it as C++ — so this happens first, apart.
FLAC_DIR="$ROOT/mobile/native/third_party/flac"
FLAC_OBJ="${TMPDIR:-/tmp}/singz-flac-obj"
mkdir -p "$FLAC_OBJ"
for c in "$FLAC_DIR"/src/*.c; do
  o="$FLAC_OBJ/$(basename "${c%.c}").o"
  # Rebuild only when the source is newer — CI always rebuilds (fresh tmp),
  # a dev loop doesn't pay 15 compiles per run.
  if [ ! -f "$o" ] || [ "$c" -nt "$o" ] || [ "$FLAC_DIR/config.h" -nt "$o" ]; then
    "$CC" -std=c99 -O2 -DHAVE_CONFIG_H \
      -I "$FLAC_DIR" -I "$FLAC_DIR/include" -I "$FLAC_DIR/src/include" -I "$FLAC_DIR/src" \
      -c "$c" -o "$o"
  fi
done

"$CXX" -std=c++17 -O2 -Wall \
  -I "$ROOT/mobile/native/core" \
  -I "$FLAC_DIR/include" \
  "$ROOT/tests/native/core_host_tests.cpp" \
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
"$OUT"

# The vendored libFLAC (mobile/native/third_party/flac), which Phase 5's stem
# compression is built on. The point is not to test libFLAC — it is to prove
# the fifteen .c files taken from the tarball are a COMPLETE, linkable set on a
# toolchain other than the macOS/clang one they were selected on. Without this,
# a missing file would first surface as an NDK or Xcode build failure on a
# branch, a long way from its cause. C99, so it uses $CC rather than $CXX.
FLAC_OUT="${TMPDIR:-/tmp}/singz-flac-host-tests"
"$CC" -std=c99 -O2 -DHAVE_CONFIG_H \
  -I "$FLAC_DIR" -I "$FLAC_DIR/include" -I "$FLAC_DIR/src/include" -I "$FLAC_DIR/src" \
  "$ROOT/tests/native/flac_roundtrip.c" \
  "$FLAC_OBJ"/*.o \
  -lm -o "$FLAC_OUT"
# Run somewhere writable: the test writes and deletes two .flac files.
(cd "${TMPDIR:-/tmp}" && "$FLAC_OUT")

# The Beat This! postprocessor against the shipped python runner's own answer.
# Stage 1 only here — the full replay needs a recording made with the models,
# which CI does not carry; the harness says so itself rather than printing a
# bare pass.
node "$ROOT/eval/mlgrid-parity.mjs"

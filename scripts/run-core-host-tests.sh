#!/bin/bash
# Compile and run the host-side checks for mobile/native/core's ORT-free
# pieces (resampler quality, WAV writer byte contract + reader, the melody
# tracker on a synthetic phrase, the key detector on a synthetic triad). No NDK, no device —
# a plain C++17 compiler is the whole toolchain, so the Android CI canary
# can afford it on every mobile push.
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
"$CXX" -std=c++17 -O2 -Wall \
  -I "$ROOT/mobile/native/core" \
  "$ROOT/tests/native/core_host_tests.cpp" \
  "$ROOT/mobile/native/core/analysis.cpp" \
  "$ROOT/mobile/native/core/beats.cpp" \
  "$ROOT/mobile/native/core/beat_this.cpp" \
  "$ROOT/mobile/native/core/courts.cpp" \
  "$ROOT/mobile/native/core/melody.cpp" \
  "$ROOT/mobile/native/core/resample.cpp" \
  "$ROOT/mobile/native/core/wav.cpp" \
  -o "$OUT"
"$OUT"

# The Beat This! postprocessor against the shipped python runner's own answer.
# Stage 1 only here — the full replay needs a recording made with the models,
# which CI does not carry; the harness says so itself rather than printing a
# bare pass.
node "$ROOT/eval/mlgrid-parity.mjs"

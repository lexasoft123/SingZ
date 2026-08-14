#!/bin/bash
# Compile and run the host-side checks for mobile/native/core's ORT-free
# pieces (resampler quality, WAV writer byte contract). No NDK, no device —
# a plain C++17 compiler is the whole toolchain, so the Android CI canary
# can afford it on every mobile push.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
OUT="${TMPDIR:-/tmp}/singz-core-host-tests"
CXX=${CXX:-c++}
"$CXX" -std=c++17 -O2 -Wall \
  -I "$ROOT/mobile/native/core" \
  "$ROOT/tests/native/core_host_tests.cpp" \
  "$ROOT/mobile/native/core/resample.cpp" \
  "$ROOT/mobile/native/core/wav.cpp" \
  -o "$OUT"
"$OUT"

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
"$CXX" -std=c++17 -O2 -Wall \
  -I "$ROOT/mobile/native/core" \
  "$ROOT/mobile/native/core/tools/singz-analyze.cpp" \
  "$ROOT/mobile/native/core/analysis.cpp" \
  "$ROOT/mobile/native/core/beats.cpp" \
  "$ROOT/mobile/native/core/melody.cpp" \
  "$ROOT/mobile/native/core/wav.cpp" \
  -o "$OUT"
echo "$OUT"

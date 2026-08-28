#!/bin/bash
# The core's host test suite: core_host_tests (every detector against
# synthesized audio, framing and stamps included), the libFLAC roundtrip, and
# the Beat This! postprocessor parity gate. Run by the Android canary on every
# mobile/** push and by hand after touching the core.
#   scripts/run-core-host-tests.sh
#
# A thin wrapper over mobile/native/core/CMakeLists.txt — the ONE definition
# of the host build, shared with build-analyze-host.sh, the vendor step and
# the Windows workflow (which runs these same two binaries through ctest on
# MSVC). The binaries are run directly rather than through ctest here so
# their full PASS listing stays in the canary's log, the way it always has.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# Scratch paths are keyed on THIS CHECKOUT, not on $TMPDIR alone. Every
# worktree on a machine shared one build dir and one output binary, which is
# the same defect as the shared vendor/ slot: CMake catches its half loudly
# ("does not match the source used to generate cache" — it blocked the gates
# in a worktree the day this was written), and the shared OUTPUT binary
# catches nothing at all, since two trees' gates would simply overwrite each
# other's oracle.
checkout_key() { printf '%s' "$1" | git hash-object --stdin | cut -c1-8; }
KEY=$(checkout_key "$ROOT")
BUILD="${SINGZ_CORE_BUILD_DIR:-${TMPDIR:-/tmp}/singz-core-build-tests-$KEY}"

if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

cmake -S "$ROOT/mobile/native/core" -B "$BUILD"
cmake --build "$BUILD" --target core_host_tests flac_roundtrip -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

"$BUILD/core_host_tests"
# Run somewhere writable: the test writes and deletes two .flac files.
(cd "$BUILD" && ./flac_roundtrip)

# The Beat This! postprocessor against the shipped python runner's own answer.
# Stage 1 only here — the full replay needs a recording made with the models,
# which CI does not carry; the harness says so itself rather than printing a
# bare pass.
node "$ROOT/eval/mlgrid-parity.mjs"

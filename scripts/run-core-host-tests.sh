#!/bin/bash
# The core's host test suite: core_host_tests (every detector against
# synthesized audio, framing and stamps included), the libFLAC roundtrip, and
# the Beat This! postprocessor parity gate. Run by the Android canary on every
# mobile/** push and by hand after touching the core.
#   scripts/run-core-host-tests.sh
#
# A thin wrapper over the root CMakeLists.txt — the ONE definition
# of the host build, shared with build-analyze-host.sh, the vendor step and
# the Windows workflow (which runs these same two binaries through ctest on
# MSVC). The binaries are run directly rather than through ctest here so
# their full PASS listing stays in the canary's log, the way it always has.
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$ROOT/scripts/with-native-build-lock.mjs" \
    --owner core-host-tests -- bash "$ROOT/scripts/run-core-host-tests.sh" "$@"
fi
node "$ROOT/scripts/assert-native-build-lock.cjs"
# Scratch paths are keyed on THIS CHECKOUT, not on $TMPDIR alone. Every
# worktree on a machine shared one build dir and one output binary, which is
# the same defect as the shared vendor/ slot: CMake catches its half loudly
# ("does not match the source used to generate cache" — it blocked the gates
# in a worktree the day this was written), and the shared OUTPUT binary
# catches nothing at all, since two trees' gates would simply overwrite each
# other's oracle. Keep this default distinct from pre-relocation caches that
# were configured against mobile/native/core.
CHECKOUT_KEY=$(printf '%s' "$ROOT" | git -C "$ROOT" hash-object --stdin | cut -c1-12)
BUILD="${SINGZ_CORE_BUILD_DIR:-${TMPDIR:-/tmp}/singz-zcore-host-tests-$CHECKOUT_KEY}"

if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

cmake -S "$ROOT" -B "$BUILD"
# Four fixed edges is the measured ceiling for these ordinary CMake targets:
# never multiply by the machine's logical CPU count. The machine-wide lock
# prevents a sibling worktree from adding another compiler family beside it.
cmake --build "$BUILD" --target core_host_tests flac_roundtrip --parallel 4

"$BUILD/core_host_tests"
# Run somewhere writable: the test writes and deletes two .flac files.
(cd "$BUILD" && ./flac_roundtrip)

# The Beat This! postprocessor against the shipped python runner's own answer.
# Stage 1 only here — the full replay needs a recording made with the models,
# which CI does not carry; the harness says so itself rather than printing a
# bare pass.
node "$ROOT/eval/mlgrid-parity.mjs"

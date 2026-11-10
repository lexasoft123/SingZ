#!/bin/bash
# Build the singz-analyze CLI for THIS machine — the core's detectors as a
# command-line tool: the parity harness's oracle (eval/*-parity.mjs) and the
# desktop's way into the core (spawned by main like the lyrics engines) as the
# cutover lands. Prints the binary's path on stdout and NOTHING ELSE — the
# gates capture stdout as the path.
#   scripts/build-analyze-host.sh [out-path]  default: build/native/analyze-host/singz-analyze
#
# A thin wrapper over the root CMakeLists.txt — the ONE definition
# of the host build, shared with run-core-host-tests.sh, the vendor step and
# the Windows workflow. This script used to carry its own compiler line and
# object cache; two build definitions of one binary is the same trap as two
# answers to "do I have this file?", and the CMake tree was gated the day it
# landed (ctest 2/2, all six parity gates bit-identical against a
# script-built binary before the switch).
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$ROOT/scripts/with-native-build-lock.mjs" \
    --owner analyze-host -- bash "$ROOT/scripts/build-analyze-host.sh" "$@"
fi
node "$ROOT/scripts/assert-native-build-lock.cjs" 1>&2
# Keep both source and build paths under the same checkout so ccache can
# normalize command lines to identical relative paths in sibling worktrees.
BUILD="${SINGZ_CORE_BUILD_DIR:-$ROOT/build/native/analyze-host}"
OUT="${1:-$BUILD/singz-analyze}"
case "$BUILD" in
  "$ROOT"/*) ;;
  *) echo "Warning: external SINGZ_CORE_BUILD_DIR may prevent cross-worktree ccache hits: $BUILD" >&2 ;;
esac

# All cmake chatter to stderr; stdout stays the contract (the path). No
# -DSINGZ_CORE_TESTS=OFF here: the option would persist in the cmake cache,
# and run-core-host-tests.sh may share this build dir via SINGZ_CORE_BUILD_DIR
# — tests default ON and cost nothing when only the tool target is built.
cmake -S "$ROOT" -B "$BUILD" 1>&2
cmake --build "$BUILD" --target singz-analyze --parallel 4 1>&2

[ "$BUILD/singz-analyze" = "$OUT" ] || cp "$BUILD/singz-analyze" "$OUT"
echo "$OUT"

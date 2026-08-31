#!/bin/bash
# Build the singz-analyze CLI for THIS machine — the core's detectors as a
# command-line tool: the parity harness's oracle (eval/*-parity.mjs) and the
# desktop's way into the core (spawned by main like whisper-cli) as the
# cutover lands. Prints the binary's path on stdout and NOTHING ELSE — the
# gates capture stdout as the path.
#   scripts/build-analyze-host.sh [out-path]  default: $TMPDIR/singz-analyze-<checkout>
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
# Scratch paths are keyed on THIS CHECKOUT, not on $TMPDIR alone. Every
# worktree on a machine shared one build dir and one output binary, which is
# the same defect as the shared vendor/ slot: CMake catches its half loudly
# ("does not match the source used to generate cache" — it blocked the gates
# in a worktree the day this was written), and the shared OUTPUT binary
# catches nothing at all, since two trees' gates would simply overwrite each
# other's oracle. A basename is not unique (`/a/foo` and `/b/foo`), so use a
# hash of the absolute checkout path on every supported dev shell.
CHECKOUT_KEY=$(printf '%s' "$ROOT" | git -C "$ROOT" hash-object --stdin | cut -c1-12)
OUT="${1:-${TMPDIR:-/tmp}/singz-analyze-$CHECKOUT_KEY}"
BUILD="${SINGZ_CORE_BUILD_DIR:-${TMPDIR:-/tmp}/singz-zcore-analyze-host-$CHECKOUT_KEY}"

# Compiler cache when the machine has one — same launchers, base_dir and
# hash_dir story as vendor-whisper.sh (a sibling worktree hits only with
# BASEDIR + NOHASHDIR, because absolute paths and -g hash the CWD).
if command -v ccache >/dev/null 2>&1; then
  export CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
  export CCACHE_BASEDIR="$ROOT" CCACHE_NOHASHDIR=1 CCACHE_COMPILERCHECK=content
fi

# All cmake chatter to stderr; stdout stays the contract (the path). No
# -DSINGZ_CORE_TESTS=OFF here: the option would persist in the cmake cache,
# and run-core-host-tests.sh may share this build dir via SINGZ_CORE_BUILD_DIR
# — tests default ON and cost nothing when only the tool target is built.
cmake -S "$ROOT" -B "$BUILD" 1>&2
cmake --build "$BUILD" --target singz-analyze -j "$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)" 1>&2

cp "$BUILD/singz-analyze" "$OUT"
echo "$OUT"

#!/usr/bin/env bash
# Every TS-against-C++ parity gate, in one command.
#
#   scripts/run-parity-gates.sh [--bin <singz-analyze>] [gate ...]
#
# The detectors exist twice — the desktop's TypeScript in
# src/renderer/src/audio/ and the core's C++ in zcore/ — and the
# six harnesses under eval/ are the whole of what holds the two to the same
# answer. Now that the core is the source of truth, these ARE the contract: a
# divergence means the TypeScript has drifted off it.
#
# They existed before this script and nearly never ran, for two reasons this
# fixes. Each rebuilt singz-analyze for itself, so running all six compiled the
# core six times. And each needs mobile/src/gen/analysis-lib.js plus the
# generated sample song, which a desktop-only worktree has neither of and which
# failed with an instruction to go and `npm ci` somewhere else — enough friction,
# at exactly the wrong moment, to make "I'll run them later" the normal answer.
# Both are generated here if missing, and the binary is built once.
#
# What a green run means, and what it does not:
#   - It compares two implementations on the BUNDLED SAMPLE (40 s, synthesized
#     by make-sample.js). It is a drift canary, not a quality corpus — the
#     real-song runs (`--library`, a project dir) stay a deliberate act.
#   - beats-parity is STAGED: it compares the TS debug object field by field
#     and skips what the C++ does not emit yet, and its own summary reports the
#     branches this corpus never reached. Green means "no drift in what was
#     compared", not "the beat port is proven".
#   - A parity gate compares two implementations against each other. It cannot
#     see the two being fed DIFFERENT INPUTS — which is exactly how the melody
#     framing bug survived a year of green runs. That class needs the rate axis
#     inside melody-parity and tests/e2e/mac/melody-stem-rate-e2e.cjs.
#
# Needs: node, a C++ toolchain, cmake, ffmpeg. courts-parity and courts-decide-parity
# additionally need the platform's libm to agree with V8 on cos/sin/log2/log1p
# /hypot — see the header of eval/courts-parity.mjs, which lists what has been
# measured: macOS/arm64, the pinned CI runner, and Debian 12 on two
# architectures. On any of those a red means what it says. Anywhere else it may
# be the platform talking, and the run says so at the end.
set -uo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)

ALL=(melody-parity key-parity beats-parity courts-parity courts-decide-parity mlgrid-parity analyze-parity)
BIN=""
GATES=()
while [ $# -gt 0 ]; do
  case "$1" in
    --bin)
      # Without this, `set -u` kills the script on $2 with exit 1 — the same
      # code a failing gate uses, which is a bad way to learn about a typo.
      [ $# -ge 2 ] || { echo "parity: --bin needs a path" >&2; exit 2; }
      BIN="$2"; shift 2 ;;
    -h|--help) sed -n '2,4p' "$0"; exit 0 ;;
    *) GATES+=("$1"); shift ;;
  esac
done
[ ${#GATES[@]} -gt 0 ] || GATES=("${ALL[@]}")

# Names first: a typo should cost nothing, not a core build and a sample render.
for g in "${GATES[@]}"; do
  if [ ! -f "$ROOT/eval/$g.mjs" ]; then
    echo "parity: no such gate: $g (of: ${ALL[*]})" >&2
    exit 2
  fi
done

# ---- prerequisites, generated rather than demanded -------------------------

# ALWAYS regenerated, never checked for presence. Every gate imports this
# bundle as its TypeScript side, and a bootstrapped worktree already has one
# from mobile's postinstall — so a presence check would compare an
# install-time snapshot of the detectors against a freshly built core and
# report 6/6 PASS about code the run never saw. It costs 0.09 s.
# --lib-only: the worklet half needs babel out of mobile/node_modules, which
# no gate imports and a desktop checkout has no reason to install.
echo "parity: generating mobile/src/gen/analysis-lib.{js,d.ts}"
node "$ROOT/mobile/scripts/build-analysis.mjs" --lib-only || exit 1

# make-sample.js skip-guards itself against all seven of its outputs, so this is
# a no-op once the sample is whole — and unlike a one-file check here, it
# notices a render that was interrupted half way through.
node "$ROOT/mobile/scripts/make-sample.js" || exit 1

if [ -z "$BIN" ]; then
  echo "parity: building singz-analyze"
  BIN=$(bash "$ROOT/scripts/build-analyze-host.sh") || exit 1
fi
echo "parity: $BIN"

# ---- the gates -------------------------------------------------------------

FAILED=()
LIBM_SENSITIVE=" courts-parity courts-decide-parity "
for g in "${GATES[@]}"; do
  echo
  echo "=== $g ==============================================================="
  start=$(date +%s)
  node "$ROOT/eval/$g.mjs" --bin "$BIN"
  rc=$?
  echo "--- $g: $([ $rc -eq 0 ] && echo PASS || echo "FAIL (exit $rc)") in $(($(date +%s) - start))s"
  [ $rc -eq 0 ] || FAILED+=("$g")
done

echo
if [ ${#FAILED[@]} -eq 0 ]; then
  echo "PARITY GATES: ${#GATES[@]}/${#GATES[@]} PASS"
  exit 0
fi
echo "PARITY GATES: ${#FAILED[@]} FAILED — ${FAILED[*]}"
for g in "${FAILED[@]}"; do
  case "$LIBM_SENSITIVE" in
    *" $g "*)
      echo "  note: $g is libm-sensitive (see the header of eval/courts-parity.mjs)."
      echo "        On a platform that header lists as measured — macOS/arm64, the pinned CI"
      echo "        runner, Debian 12 — take this at face value. On any other, check the same"
      echo "        gate on a measured one before reading it as a regression in the port."
      ;;
  esac
done
exit 1

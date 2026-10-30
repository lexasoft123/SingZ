#!/usr/bin/env bash
# Build singz-analyze into vendor/<platform>-<arch>/ for bundling — the core's
# detectors shipped beside whisper-cli, dark until main learns to spawn them
# (docs/PHONE-STANDALONE.md, Phase 4c). A source fingerprint guards the cache:
# an older helper may still run melody correctly while lacking newer commands
# such as input-devices, so existence alone is not proof that it is current.
#   scripts/vendor-analyze.sh [target]   e.g. darwin-arm64, darwin-x64, win32-x64
#
# One build definition: the root CMakeLists.txt, shared with
# build-analyze-host.sh, run-core-host-tests.sh and the Core Windows workflow.
# One fingerprint definition too: scripts/analyze-source-hash.sh, which the
# desktop also runs to check the binary it spawns against the tree it has.
# darwin-x64 cross-compiles from an arm64 Mac via CMAKE_OSX_ARCHITECTURES —
# the tree is plain C/C++ with no arch-conditional sources.
set -euo pipefail

TARGET=${1:-"$(node -p 'process.platform + "-" + process.arch')"}
case "$TARGET" in
  darwin-arm64|darwin-x64|win32-arm64|win32-x64|linux-arm64|linux-x64) ;;
  *) echo "Unsupported native target: $TARGET" >&2; exit 1 ;;
esac
ROOT=$(cd "$(dirname "$0")/.." && pwd)
# These scripts have no cross-OS/non-Darwin cross-architecture toolchain.
node "$ROOT/scripts/engine-artifact.cjs" assert-build-target "$TARGET"
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$ROOT/scripts/with-native-build-lock.mjs" \
    --owner vendor-analyze -- bash "$ROOT/scripts/vendor-analyze.sh" "$@"
fi
node "$ROOT/scripts/assert-native-build-lock.cjs"
JOBS=${SINGZ_NATIVE_JOBS:-4}
case "$JOBS" in 1|2|3|4) ;; *) echo "SINGZ_NATIVE_JOBS must be an integer from 1 through 4" >&2; exit 1 ;; esac

EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
OUT_DIR="$ROOT/vendor/$TARGET"
OUT="$OUT_DIR/singz-analyze$EXT"
STAMP="$OUT.source-hash"
# The fingerprint lives in scripts/analyze-source-hash.sh, not here: the
# running app recomputes it to check the binary it is about to spawn came
# from this tree (src/main/analyze-provenance.ts), and two copies of the
# algorithm would be two answers to one question.
SOURCE_HASH=$("$ROOT/scripts/analyze-source-hash.sh" "$ROOT")
analyzer_matches_sources() {
  local info status=0
  [ ! -L "$ROOT/vendor" ] && [ ! -L "$OUT_DIR" ] && [ ! -L "$OUT" ] && [ ! -L "$STAMP" ] || return 1
  [ -f "$OUT" ] && [ -f "$STAMP" ] || return 1
  [ "$(tr -d '\r\n' < "$STAMP")" = "$SOURCE_HASH" ] || return 1
  info=$("$OUT" build-info 2>/dev/null) || status=$?
  # Return 2 only when the shell cannot execute this target (no emulator,
  # unsupported executable format, or unavailable target loader). A process
  # that ran but reported bad/malformed identity remains a definitive failure.
  case "$status" in 0) ;; 126|127) return 2 ;; *) return 1 ;; esac
  printf '%s' "$info" | node -e '
    let text = ""; process.stdin.on("data", data => text += data).on("end", () => {
      try { process.exit(JSON.parse(text).sourceHash === process.argv[1] ? 0 : 1) }
      catch { process.exit(1) }
    })' "$SOURCE_HASH"
}
if analyzer_matches_sources; then
  echo "cached: vendor/$TARGET/singz-analyze$EXT"
  exit 0
fi

# Default builds live beneath this checkout so source/include/build paths
# normalize identically in every worktree; do not share CMake state itself.
BUILD="${SINGZ_CORE_BUILD_DIR:-$ROOT/build/native/analyze-vendor-$TARGET}"
case "$BUILD" in
  "$ROOT"/*) ;;
  *) echo "Warning: external SINGZ_CORE_BUILD_DIR may prevent cross-worktree ccache hits: $BUILD" >&2 ;;
esac
# The hash goes INTO the binary as well as beside it: `singz-analyze
# build-info` then answers for itself, which a sidecar cannot do for an
# $SINGZ_ANALYZE override or a hand-copied file. It lands in a generated TU
# in the build dir, so a changed hash recompiles one trivial file.
CONFIG_ARGS=(-DSINGZ_CORE_TESTS=OFF "-DSINGZ_SOURCE_HASH=$SOURCE_HASH")
case "$TARGET" in
  darwin-arm64) CONFIG_ARGS+=(-DCMAKE_OSX_ARCHITECTURES=arm64) ;;
  darwin-x64) CONFIG_ARGS+=(-DCMAKE_OSX_ARCHITECTURES=x86_64) ;;
esac

cmake -S "$ROOT" -B "$BUILD" "${CONFIG_ARGS[@]}"
# SINGZ_NATIVE_JOBS caps the compile fan-out the way the other native build
# scripts do, so a rebuild beside other sessions' builds stays polite.
cmake --build "$BUILD" --target singz-analyze --config Release \
  --parallel "$JOBS"

# A concurrent source edit must not label the just-built binary as current.
[ "$("$ROOT/scripts/analyze-source-hash.sh" "$ROOT")" = "$SOURCE_HASH" ] || {
  echo "Analyzer sources changed during the build; rerun it." >&2; exit 1;
}
# MSVC's multi-config generator nests the exe under Release/.
if [ -f "$BUILD/Release/singz-analyze$EXT" ]; then
  BIN="$BUILD/Release/singz-analyze$EXT"
else
  BIN="$BUILD/singz-analyze$EXT"
fi
node "$ROOT/scripts/engine-artifact.cjs" publish-file "$ROOT" "$TARGET" "singz-analyze$EXT" "$BIN"
printf '%s\n' "$SOURCE_HASH" > "$STAMP.partial-$$"
mv -f "$STAMP.partial-$$" "$STAMP"
IDENTITY_STATUS=0
analyzer_matches_sources || IDENTITY_STATUS=$?
if [ "$IDENTITY_STATUS" != 0 ]; then
  HOST_TARGET=$(node -p 'process.platform + "-" + process.arch')
  if [ "$TARGET" = "$HOST_TARGET" ] || [ "$IDENTITY_STATUS" != 2 ]; then
    rm -f "$STAMP"
    echo "Published analyzer does not report the expected source fingerprint." >&2
    exit 1
  fi
  # Cross-compilation is supported without a target emulator (e.g. Rosetta).
  # Fresh compilation above embeds SOURCE_HASH, but an unexecutable target's
  # sidecar can never authorize the cached fast path on the next invocation.
  echo "Cross-target analyzer built; verify build-info on $TARGET before release." >&2
fi
echo "built: vendor/$TARGET/singz-analyze$EXT"

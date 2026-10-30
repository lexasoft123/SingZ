#!/usr/bin/env bash
# Fail unless a vendored engine can run on a machine that did not build it.
# Usage: scripts/assert-portable-binary.sh <target> <binary> [build-dir]
#
# Why this exists: vendor-crispasr.sh shipped once producing a binary that
# linked GGML and its own library by @rpath out of the build tree, plus lame
# and opus by absolute Homebrew path. It built, it passed --help, it aligned a
# song correctly, and every measurement taken with it was green — because the
# build tree was still sitting where the linker left it. Moving that tree away
# killed it with SIGABRT.
#
# Build flags are an intention; this is the check. They can also be defeated
# silently: CMake caches find_library answers, so a build directory left by an
# older revision of a vendor script keeps pointing at a package manager
# however the prefix is ignored now.
#
# macOS only for the moment. The Windows equivalent wants dumpbin or
# llvm-readobj from the VS toolchain, and neither vendor script's win32 leg
# has ever been built — a check whose first real exercise is its first test is
# not worth writing blind.
set -euo pipefail

TARGET=$1
BIN=$2
BUILD=${3:-}

if [[ "$TARGET" == linux-* ]]; then
  # Linux helpers are static with respect to GGML and the engine itself.
  # Only the distribution runtime libraries declared by the Debian package
  # may remain dynamic; build-tree runpaths would hide a missing payload.
  if ! command -v readelf >/dev/null 2>&1; then
    rm -f "$BIN"
    echo "assert-portable-binary: readelf is required to check $BIN" >&2
    exit 1
  fi
  if ! DYNAMIC=$(readelf -d "$BIN"); then
    rm -f "$BIN"
    echo "assert-portable-binary: could not inspect $BIN" >&2
    exit 1
  fi
  STRAY=$(printf '%s\n' "$DYNAMIC" | sed -n 's/.*(NEEDED).*\[\(.*\)\].*/\1/p' |
    grep -Ev '^(lib(c|m|pthread|dl|rt)\.so\.[0-9]+|libstdc\+\+\.so\.6|libgcc_s\.so\.1|libgomp\.so\.1|libatomic\.so\.1|libasound\.so\.2|libudev\.so\.1|ld-linux-x86-64\.so\.2|ld-linux-aarch64\.so\.1)$' || true)
  if [ -n "$STRAY" ] || printf '%s\n' "$DYNAMIC" | grep -Eq '\((RPATH|RUNPATH)\).*\[[^]]+\]'; then
    rm -f "$BIN"
    echo "$(basename "$BIN"): undeclared runtime libraries or build-tree search paths:" >&2
    printf '%s\n' "$DYNAMIC" >&2
    exit 1
  fi
  exit 0
fi
case "$TARGET" in darwin-*) ;; *) exit 0 ;; esac
# A darwin target that just produced a Mach-O and has no otool is not a
# machine to skip the check on — this whole check exists because something
# could not fire, so it does not get to no-op quietly.
if ! command -v otool >/dev/null 2>&1; then
  # Remove it for the same reason the stray branch below does: the cp has
  # already happened, so leaving it lets the vendor script's skip-guard print
  # "cached: …" forever after. This is the branch that could not judge the
  # binary at all, so it is the last one that should leave it lying about.
  rm -f "$BIN"
  echo "assert-portable-binary: otool is missing, so $BIN cannot be checked" >&2
  exit 1
fi

STRAY=$(otool -L "$BIN" | tail -n +2 |
  grep -v '^[[:space:]]*/usr/lib/\|^[[:space:]]*/System/' || true)
if [ -n "$STRAY" ]; then
  rm -f "$BIN"
  echo "$(basename "$BIN"): links libraries a user machine will not have:" >&2
  echo "$STRAY" >&2
  [ -n "$BUILD" ] && echo "delete $BUILD and run again — CMake caches its find_library answers" >&2
  exit 1
fi

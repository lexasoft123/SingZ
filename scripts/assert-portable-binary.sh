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

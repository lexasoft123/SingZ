#!/usr/bin/env bash
# The ONE definition of "which sources a singz-analyze was built from".
#
#   scripts/analyze-source-hash.sh [repo-root]   -> one hex line on stdout
#
# Two callers, and they must never disagree: vendor-analyze.sh records this
# beside the binary (and compiles it INTO the binary, via SINGZ_SOURCE_HASH),
# and src/main/analyze-provenance.ts recomputes it at runtime to ask whether
# the binary it is about to spawn came from the tree in front of it. Living in
# one file is the point — a second implementation of the hash is a second
# answer to the same question, which is how the drift it detects happens in
# the first place.
#
# The fingerprint covers everything compiled into the binary plus everything
# that decides how: the verified zCore gitlink, SingZ's product-owned zcore and
# zdsp files, the native third-party tree, host tools, root CMake, and the
# verifier. The vendored libFLAC matters: zcore_media links it into
# singz-analyze, and flac_io.cpp is how the CLI reads v2 project stems.
#
# Untracked files under source directories are hashed too — deliberately. A local edit that
# was never committed is exactly the state a stale binary hides.
#
# Known limit, inherited and kept on purpose so the value stays comparable
# with stamps already on disk: a source path containing a newline would split
# a line. The core has never had one.
set -euo pipefail

ROOT=${1:-"$(cd "$(dirname "$0")/.." && pwd)"}
if command -v python3 >/dev/null 2>&1; then
  ZCORE_PYTHON=python3
elif command -v python >/dev/null 2>&1; then
  ZCORE_PYTHON=python
else
  echo "analyze-source-hash: Python 3 is required to verify the zCore submodule" >&2
  exit 1
fi
ZCORE_REVISION=$("$ZCORE_PYTHON" "$ROOT/scripts/verify-zcore-submodule.py" \
  --root "$ROOT" --path third_party/zcore --print-revision)
if [[ ! "$ZCORE_REVISION" =~ ^[0-9a-f]{40,64}$ ]]; then
  echo "analyze-source-hash: verifier returned an invalid zCore revision" >&2
  exit 1
fi
SOURCE_DIRS=(
  "$ROOT/third_party/zcore"
  "$ROOT/zcore"
  "$ROOT/zdsp"
  "$ROOT/third_party/native"
  "$ROOT/tools/native"
  "$ROOT/cmake"
)
SOURCE_FILES=(
  "$ROOT/CMakeLists.txt"
  "$ROOT/.gitmodules"
  "$ROOT/scripts/verify-zcore-submodule.py"
  "$ROOT/scripts/zcore-gitlink.cjs"
  "$ROOT/scripts/vendor-analyze.sh"
  "$ROOT/scripts/engine-artifact.cjs"
  "$ROOT/scripts/ccache-launcher.sh"
  "$ROOT/scripts/ccache-launcher.ps1"
  "$ROOT/scripts/analyze-source-hash.sh"
)

for required in "${SOURCE_DIRS[@]}"; do
  if [ ! -d "$required" ]; then
    echo "analyze-source-hash: no sources at $required" >&2
    exit 1
  fi
done
for required in "${SOURCE_FILES[@]}"; do
  if [ ! -f "$required" ]; then
    echo "analyze-source-hash: missing build input $required" >&2
    exit 1
  fi
done

# One git per RUN, not one per file: the loop this replaced spent ~0.5 s on
# ~50 spawns, and the app pays this cost at launch. The stream it feeds is
# byte-identical — "<path relative to root> <blob sha>\n" per file, in
# LC_ALL=C order of the absolute paths (every path shares the $ROOT/ prefix,
# so that ordering is the relative one).
#
# Every step below is a PLAIN command whose status `set -e` can see. Nothing
# that builds the file list may run inside a process substitution or a brace
# group: `{ find …; printf …; } | sort` takes its status from the printf, so a
# find that hit an unreadable directory would print its complaint to stderr
# and hand back a shorter list with rc=0 — a confident hash of a file set that
# is not the file set. Measured: chmod 000 on one subdirectory yields a
# different 40-hex hash and exit 0. The build side then stamps that hash and
# reports "cached" forever after; the runtime side accuses an innocent binary.
list=$(mktemp) sorted=$(mktemp) records=$(mktemp)
trap 'rm -f "$list" "$sorted" "$records"' EXIT

find "${SOURCE_DIRS[@]}" -type d -name .git -prune -o \
  -type f ! -name .git -print > "$list"
printf '%s\n' "${SOURCE_FILES[@]}" >> "$list"
LC_ALL=C sort "$list" > "$sorted"

files=()
while IFS= read -r source; do files+=("$source"); done < "$sorted"
if [ "${#files[@]}" -eq 0 ]; then
  echo "analyze-source-hash: no native build inputs to hash under $ROOT" >&2
  exit 1
fi

# Assigned, never piped: inside a process substitution a failing git would
# leave the outer pipeline exit 0 and this script would print a CONFIDENT
# hash of a short file list — the same failure as the brace group above, at
# the other end of the pipe.
shas=$(git -C "$ROOT" hash-object -- "${files[@]}")
rels=""
for source in "${files[@]}"; do rels+="${source#"$ROOT/"}"$'\n'; done

if [ "$(printf '%s\n' "$shas" | grep -c '')" -ne "${#files[@]}" ]; then
  echo "analyze-source-hash: git hashed $(printf '%s\n' "$shas" | grep -c '') of ${#files[@]} files" >&2
  exit 1
fi

paste -d' ' <(printf '%s' "$rels") <(printf '%s\n' "$shas") > "$records"
# Gitlinks are not files, so bind the checked-out revision explicitly. The
# relative path keeps the digest stable across fresh clones and linked worktrees.
printf 'third_party/zcore.gitlink %s\n' "$ZCORE_REVISION" >> "$records"
LC_ALL=C sort "$records" | git -C "$ROOT" hash-object --stdin

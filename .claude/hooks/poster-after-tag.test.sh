#!/usr/bin/env bash
# Truth table for the post-after-tag reminder.
#
# The hook asks git what is true, so these cases are repo STATES, not command
# spellings — the previous version parsed command text and needed 54 cases to
# pin the parser it no longer has.
HOOK="$(cd "$(dirname "$0")" && pwd)/poster-after-tag.sh"
TMP=$(mktemp -d); REPO="$TMP/poster-test"
FAILED=0

git init -q "$REPO" 2>/dev/null || { mkdir -p "$REPO"; git init -q "$REPO"; }
cd "$REPO" || exit 1
git config user.email t@t; git config user.name t
mkdir -p docs/release-notes
echo x > f.txt; git add f.txt; git commit -qm initial

DEFAULT='{"tool_input":{"command":"git tag v1"}}'
fires() { printf '%s' "${1:-$DEFAULT}" | CLAUDE_PROJECT_DIR="$REPO" "$HOOK" 2>/dev/null; }
# The hook announces once per version; clear the marker when a case needs a fire.
reset() { rm -f "$REPO/.git/poster-reminded"; }

check() { local want=$1 what=$2 out; out=$(fires "${3:-}")
  local got=no; [ -n "$out" ] && got=yes
  if [ "$got" = "$want" ]; then printf 'ok   %-4s %s\n' "$got" "$what"
  else printf 'FAIL want=%-4s got=%-4s %s\n' "$want" "$got" "$what"; FAILED=1; fi; }

check no  'untagged HEAD'
git tag v0.17.0
reset; check yes 'release tag, no poster'
reset; out=$(fires)
case "$out" in *v0.17.0*) echo 'ok   names the tag';; *) echo "FAIL version missing: $out"; FAILED=1;; esac
case "$out" in *docs/release-notes/v0.17.0-poster.png*) echo 'ok   names the poster path';; *) echo 'FAIL path missing'; FAILED=1;; esac

# The condition is a standing state and the filter is loose ("tag" sits inside
# "staged"), so without once-per-version a routine git status repeats the ask.
echo '-- says it once, not on every command'
reset; fires >/dev/null
check no 'a second call for the same version'
check no 'a git status payload after the ask' '{"tool_input":{"command":"git status"},"tool_response":{"stdout":"Changes not staged for commit"}}'

# Every other case runs with cwd == CLAUDE_PROJECT_DIR, which hides anything
# that resolves a path against cwd instead of the project. It hid exactly that:
# `rev-parse --git-dir` under `-C` answers a bare `.git`, so the marker landed
# beside the caller and the once-per-version guard silently did nothing.
echo '-- cwd is not the project, and must not matter'
reset
( cd / && fires >/dev/null 2>&1 )
if [ -f "$REPO/.git/poster-reminded" ]; then echo 'ok        marker lands in the project .git'
else echo 'FAIL marker not written when run from another cwd'; FAILED=1; fi
out=$( cd / && fires 2>/dev/null )
if [ -z "$out" ]; then echo 'ok   no   second call from another cwd stays silent'
else echo 'FAIL nagged again from another cwd'; FAILED=1; fi

# A tag's tree never contains its own poster (the poster is committed after the
# tag), so revisiting a tag would otherwise nag for work already done.
echo '-- checking out a tag is not making one'
BR=$(git symbolic-ref --short HEAD)
git checkout -q v0.17.0; reset
check no 'detached HEAD on a release tag'
git checkout -q "$BR"

echo '-- everything else that must stay quiet'
reset; check no 'a payload that never mentions a tag' '{"tool_input":{"command":"npm run build"}}'
touch docs/release-notes/v0.17.0-poster.png
reset; check no 'poster already committed'
rm docs/release-notes/v0.17.0-poster.png
git tag -d v0.17.0 >/dev/null; git tag v0.17.0-rc.1
reset; check no 'prerelease goes to one tester'
# Hyphen-free on purpose: a name like release-2026 is caught by the prerelease
# rule instead, which leaves the release-version filter untested.
git tag -d v0.17.0-rc.1 >/dev/null; git tag checkpoint
reset; check no 'a tag that is not a release version'
git tag -d checkpoint >/dev/null; git tag v0.17.0
reset; check yes 'still fires after the noise above'

# Not independent assertions — the hook never reads the command, which is the
# whole point. Kept as documentation that the spelling cannot matter any more.
echo '-- spellings the old parser got wrong or gave up on'
for c in 'git tag -d v0.17.0 && git tag -a v0.17.0 -m fix' '(git tag v0.17.0)' 'time git tag v0.17.0'; do
  reset
  out=$(fires "$(printf '{"tool_input":{"command":%s}}' "$(printf '%s' "$c" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')")")
  case "$out" in *v0.17.0*) printf 'ok   yes  %s\n' "$c" ;;
    *) printf 'FAIL silent or wrong version: %s\n' "$c"; FAILED=1 ;; esac
done

cd /; rm -rf "$TMP"
exit $FAILED

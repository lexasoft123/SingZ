#!/usr/bin/env bash
# Truth table for the post-after-tag reminder.
#
# The failure modes worth guarding are both silent: firing on a command that
# tagged nothing (noise on every `git tag -l`), and staying quiet on a real
# release tag (the thing it exists to catch).
HOOK="$(cd "$(dirname "$0")" && pwd)/poster-after-tag.sh"
FAILED=0

fires() { # fires <command> -> yes | no
  local out
  out=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
        "$(printf '%s' "$1" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
        | "$HOOK" 2>/dev/null)
  [ -n "$out" ] && echo yes || echo no
}

check() { local want=$1 cmd=$2 got; got=$(fires "$cmd")
  if [ "$got" = "$want" ]; then printf 'ok   %-4s %s\n' "$got" "$cmd"
  else printf 'FAIL want=%-4s got=%-4s %s\n' "$want" "$got" "$cmd"; FAILED=1; fi; }

echo "-- a real release tag: must fire"
check yes 'git tag v0.17.0'
check yes 'git tag -a v0.17.0 -m "release"'
check yes 'git tag -s v1.0.0 -m signed'
check yes 'git tag -a v0.17.0 -m "notes" && git push origin v0.17.0'

echo "-- tags that announce nothing: must stay quiet"
check no 'git tag -d v0.17.0'
check no 'git tag --delete v0.17.0'
check no 'git tag -l "v0.*"'
check no 'git tag --list'
check no 'git tag -v v0.17.0'

echo "-- prereleases go to one tester, never the channel"
check no 'git tag v0.14.1-test1'
check no 'git tag -a v0.17.0-rc.1 -m rc'

echo "-- read-only tag queries create nothing"
check no 'git tag --contains v0.17.0'
check no 'git tag --points-at v0.17.0'
check no 'git tag --merged v0.17.0'

echo "-- a flag inside a MESSAGE is not a flag"
check yes 'git tag -a v0.17.0 -m "faster -d handling"'
check yes "git tag -a v0.17.0 -m 'now with --list support'"

echo "-- not a tag command at all"
check no 'git commit -m "v0.17.0 notes"'
check no 'git log --oneline v0.16.0..HEAD'
check no 'npm run build'
check no 'git push origin main'

echo "-- no version in the command"
check no 'git tag'
check no 'git tag some-branch-marker'

echo "-- already has a poster: no nagging on a re-tag"
ROOT=$(git rev-parse --show-toplevel 2>/dev/null || pwd)
if [ -f "$ROOT/docs/release-notes/v0.16.0-poster.png" ]; then
  check no 'git tag -a v0.16.0 -m "re-tag"'
else
  echo "skip (no v0.16.0 poster committed yet)"
fi

echo "-- the payload carries usable context"
out=$(printf '{"tool_name":"Bash","tool_input":{"command":"git tag v0.17.0"}}' | "$HOOK" 2>/dev/null)
for want in 'v0.17.0' 'release-poster' 'docs/release-notes/v0.17.0-poster.png'; do
  case "$out" in
    *"$want"*) printf 'ok   mentions %s\n' "$want" ;;
    *) printf 'FAIL context missing %s\n' "$want"; FAILED=1 ;;
  esac
done
if printf '%s' "$out" | (command -v jq >/dev/null && jq -e '.hookSpecificOutput.additionalContext' >/dev/null 2>&1 || node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{process.exit(JSON.parse(s).hookSpecificOutput?.additionalContext?0:1)})'); then
  echo 'ok   emits valid JSON with additionalContext'
else
  echo 'FAIL output is not valid JSON carrying additionalContext'; FAILED=1
fi

exit $FAILED

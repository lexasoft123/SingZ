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

echo "-- a MENTION is not a command (this fired on review's own test harness)"
check no 'echo "run git tag v0.17.0 when ready"'
check no "echo 'git tag v0.17.0'"
check no 'grep -rn "git tag" docs/'
check no 'echo git tag v0.17.0'
check no 'git log --grep tag v0.17.0'
check no 'cat notes.md | grep "git tag v0.17.0"'

echo "-- but a real command in any segment still counts"
check yes 'npm run build; git tag v0.17.0'
check yes 'npm test && git tag -a v0.17.0 -m ok'
check yes 'git -C /Users/x/repo tag v0.17.0'
check yes '  git tag v0.17.0'

echo "-- a neighbour's flags are not this command's (the release one-liner)"
check yes 'git tag -a v0.17.0 -m "notes" && git push -v origin v0.17.0'
check yes 'git tag -a v0.17.0 -m "notes" && gh release create v0.17.0 -d --notes-file n.md'
check yes 'git tag v0.17.0 && git branch -d old-feature'
check yes 'git tag v0.17.0 | tee -a log.txt'
# …but the tag command's OWN flags still count
check no 'git push -v origin main && git tag -d v0.17.0'

echo "-- the version comes from the tag, not from a neighbour"
out=$(printf '{"tool_name":"Bash","tool_input":{"command":"git push origin v0.16.0 && git tag v0.17.0"}}' | "$HOOK" 2>/dev/null)
case "$out" in
  *v0.17.0*) echo 'ok   picks the tagged version, not the pushed one' ;;
  *) echo "FAIL took the wrong version: $out"; FAILED=1 ;;
esac

echo "-- delete-then-recreate: the ordinary way to fix a bad tag"
check yes 'git tag -d v0.17.0 && git tag -a v0.17.0 -m "corrected"'
check yes 'git tag -d v0.16.9 && git tag v0.17.0'
check yes 'git tag -l "v0.16*" && git tag v0.17.0'
check yes 'git tag v0.17.0 && git tag -d v0.16.9'
check no  'git tag -d v0.17.0 && git tag -l "v0.1*"'   # nothing created anywhere

echo "-- a version named in the MESSAGE is not the tag"
for pair in \
  'git tag -a "v0.17.0" -m "replaces tag v0.16.9 entirely"|v0.17.0' \
  'git tag -a "v0.17.0" -m "supersedes the tag v0.16.0"|v0.17.0' \
  'git tag -a "v0.17.0" -m "notes" && git tag -l "v0.16.0"|v0.17.0'; do
  c=${pair%|*}; want=${pair#*|}
  out=$(printf '{"tool_name":"Bash","tool_input":{"command":%s}}' \
        "$(printf '%s' "$c" | python3 -c 'import json,sys; print(json.dumps(sys.stdin.read()))')" \
        | "$HOOK" 2>/dev/null)
  got=$(printf '%s' "$out" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+' | head -1)
  if [ "$got" = "$want" ]; then printf 'ok   announces %-8s %s\n' "$got" "$c"
  else printf 'FAIL want=%s got=%s  %s\n' "$want" "${got:-<silent>}" "$c"; FAILED=1; fi
done

# A bare `git … tag` is a listing. These matter because the version lives ONLY
# in the path and there is nothing after `tag` — the end-of-string branch of
# after_tag, which two rounds of provenance cases never reached, since all of
# them had a version after the word.
echo "-- a listing whose PATH carries a version announces nothing"
check no 'git -C /Users/x/worktrees/v1.2.3 tag'
check no 'git --git-dir=/repos/v1.2.3/.git tag'

echo "-- a version in git's own -C path is not the tag"
out=$(printf '{"tool_name":"Bash","tool_input":{"command":"git -C /Users/x/worktrees/v1.2.3 tag v0.17.0"}}' | "$HOOK" 2>/dev/null)
case "$out" in
  *v0.17.0*) echo 'ok   announces the tag, not the path' ;;
  *) echo "FAIL took a version from the -C path: $out"; FAILED=1 ;;
esac

echo "-- not a tag command at all"
# Every case here must name a version with NO committed poster, or the poster
# gate silences it and the case passes without ever testing the anchoring.
# `git log --oneline v0.16.0..HEAD` did exactly that: v0.16.0 has a poster in
# this repo, so it stayed green even with the anchoring regex neutered.
check no 'git commit -m "v0.17.0 notes"'
check no 'git log --oneline v0.17.0..HEAD'
check no 'npm run build v0.17.0'
check no 'git push origin main v0.17.0'

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

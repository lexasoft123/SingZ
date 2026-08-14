#!/usr/bin/env bash
# Truth table for the commit review gate.
#
# The point of the scratch repo: every case runs with a VALID marker, so the
# gate would otherwise allow. Any denial is therefore a real refusal, not a
# fallthrough to "not reviewed yet" — the previous version of this harness
# could not tell those apart and passed `-am` while `-am` was wide open.
HOOK="$(cd "$(dirname "$0")" && pwd)/require-review.sh"
REPO=$(mktemp -d)/gate-test
FAILED=0

git init -q "$REPO" 2>/dev/null || { mkdir -p "$REPO"; git init -q "$REPO"; }
cd "$REPO" || exit 1
git config user.email t@t; git config user.name t
echo one > file.txt; git add file.txt; git commit -qm initial
echo two >> file.txt; git add file.txt          # something staged
git write-tree > "$(git rev-parse --git-dir)/singz-reviewed"   # …and approved

verdict() { # verdict <command-text> -> allow | a short reason tag
  local out
  out=$(jq -nc --arg c "$1" '{tool_name:"Bash",tool_input:{command:$c}}' | "$HOOK" 2>/dev/null)
  [ -z "$out" ] && { echo allow; return; }
  local r; r=$(printf '%s' "$out" | jq -r '.hookSpecificOutput.permissionDecisionReason')
  case "$r" in
    *"different working directory"*) echo refused-elsewhere ;;
    *"stages and then commits"*) echo refused-staging ;;
    *"--all"*)            echo refused-flags ;;
    *pathspec*)           echo refused-pathspec ;;
    *"aimed elsewhere"*)  echo refused-target ;;
    *"Not reviewed yet"*) echo not-reviewed ;;
    *"staged tree changed"*) echo stale ;;
    *"could not read its input"*) echo unreadable ;;
    *) echo "deny-other" ;;
  esac
}

check() { local want=$1 cmd=$2 got; got=$(verdict "$cmd")
  if [ "$got" = "$want" ]; then printf 'ok   %-16s %s\n' "$got" "$cmd"
  else printf 'FAIL want=%-16s got=%-16s %s\n' "$want" "$got" "$cmd"; FAILED=1; fi; }

echo "-- approved tree: ordinary commits go through"
check allow 'git commit -m x'
check allow 'git commit --amend --no-edit'
check allow 'git commit -m "msg" --no-verify'
check allow 'git commit -C HEAD~1'                     # reuse a message; tree is still the index
check allow 'git commit -s -q -m x'

echo "-- the blocker: forms that commit something other than the index"
check refused-flags 'git commit -am "the ordinary spelling"'
check refused-flags 'git commit -a -m x'
check refused-flags 'git commit --all -m x'
check refused-flags 'git commit -asm x'
check refused-flags 'git commit -avm x'
check refused-flags 'git commit -i file.txt -m x'
check refused-flags 'git commit --only path -m x'
check refused-flags 'git commit -p -m x'
check refused-flags 'git commit --patch -m x'
check refused-pathspec 'git commit -- src/main/index.ts'
check refused-pathspec 'git commit -m x b.txt'          # git's -- is optional
check refused-pathspec 'git commit b.txt -m x'
check refused-pathspec 'git commit --amend --no-edit b.txt'
check refused-pathspec 'git commit -sm msg src/main/index.ts'
# a QUOTED message must not swallow the path that follows it
check refused-pathspec 'git commit -m "ship it" b.txt'
check refused-pathspec "git commit -m 'ship it' b.txt"
check refused-pathspec 'git commit -sm "ship it" b.txt'
check refused-pathspec 'git commit --message="ship it" b.txt'
check refused-pathspec 'git commit "b.txt"'             # quoted pathspec is still one
check refused-pathspec 'git commit -m "x" -- src/main/index.ts'
check refused-target   'git -C /other/repo commit -m x'
check refused-target   'git --git-dir=/x/.git commit -m x'

echo "-- false denies the reviewer found: must NOT be refused"
check allow 'git commit -m "The gate refuses -a and pathspec forms"'
check allow 'git commit -m "add -C support to the hook"'
check allow 'git commit -m x && ls -la out/'
check allow 'git commit -m x && npm test -- --run'
check allow 'git commit -m x && make -C build'

echo "-- staging in the same call changes the tree AFTER this hook reads it"
check refused-staging 'git add -A && git commit -m x'
check refused-staging 'git add . && git commit -m x'
check refused-staging 'git add -u; git commit -m x'
check refused-staging 'git add src/main/index.ts && git commit -m "part"'
check refused-staging 'git reset HEAD~1 && git commit -m x'
check refused-staging 'git add -A && git rebase --continue'
check refused-staging 'git switch main && git commit -m x'       # rewrites the index
check refused-staging 'git switch -c feature && git commit -m x'
check refused-staging 'git merge --no-commit other && git commit -m x'
check refused-staging 'git cherry-pick -n abc123 && git commit -m x'
check refused-staging 'git revert -n HEAD && git commit -m x'
check allow 'git status && git commit -m x'            # reads the index, never writes it
check allow 'npm test && git commit -m x'

echo "-- ordinary option shapes must survive the operand walk"
check allow 'git commit -m msg'                        # unquoted value is not an operand
check allow 'git commit -sm msg'
check allow 'git commit -F /tmp/msg.txt'
check allow 'git commit --author=x --date=y -m z'
check allow 'git commit --fixup HEAD~1'
check allow 'git commit -S -m x'                       # -S attaches its value
check allow 'git commit -m "a real message with -a and -- in it"'
check allow 'git commit -sm "signed and quoted"'
check refused-pathspec 'git commit -m x *.md'          # glob must not be expanded


echo "-- committing somewhere else, in the spelling people actually use"
check refused-elsewhere 'cd .claude/worktrees/feature && git commit -m x'
check refused-elsewhere 'cd /other/repo; git commit -m x'
check refused-elsewhere 'pushd /other/repo && git commit -m x'
check refused-elsewhere 'GIT_DIR=/other/.git git commit -m x'
check refused-elsewhere 'GIT_WORK_TREE=/other git commit -m x'
check refused-elsewhere 'GIT_INDEX_FILE=/tmp/idx git commit -m x'
check refused-elsewhere 'cd /other/repo && git rebase --continue'

echo "-- revert/am finish conflicts the same way rebase does"
check allow 'git revert --continue'                    # marker valid here
check allow 'git am --continue'

echo "-- every segment is inspected, not just the first"
check refused-flags 'git commit -m first && git commit -am second'
check refused-target 'git commit -m x && git -C /other commit -m y'
check refused-pathspec 'git commit -m x && git commit -- src/main/index.ts'

echo "-- a quoted mention is not a command (these are read-only)"
check allow 'grep -n "&& git commit -m" docs/DEVELOPMENT.md'
check allow 'rg "; git commit " CLAUDE.md'
check allow 'echo "; git commit -am x"'
check allow "echo 'git add -u; git commit -m x'"

echo "-- an earlier word containing \"commit\" must not shift the inspected segment"
check refused-flags 'npm run precommit && git commit -am x'
check refused-flags 'git log --grep commit -1 && git commit -am x'
check refused-flags 'echo commit; git commit -am x'
check refused-pathspec 'echo commit; git commit -- src/main/index.ts'
check refused-target 'echo commit; git -C /other/repo commit -m x'
check allow '.git/hooks/pre-commit && git commit -m x'

echo "-- mentions only: never gated"
check allow 'ls -la'
check allow 'grep -rn "git commit" docs/'
check allow 'git log --grep commit'
check allow 'git status --porcelain'

echo "-- --continue finishes a hand-resolved conflict: gated like a commit"
check allow 'git rebase --continue'                    # marker valid here
check allow 'git merge --continue'
check refused-target 'git -C /other rebase --continue' # -C aims it elsewhere

echo "-- an unreadable payload fails closed only when it could be a commit"
raw() { printf '%s' "$1" | "$HOOK" 2>/dev/null | sed -n 's/.*permissionDecision":"\([a-z]*\)".*/\1/p'; }
for p in '{"tool_name":"BashOutput","tool_input":{"bash_id":"b1"}}' \
         '{"tool_name":"Bash","tool_input":{}}' \
         'not json at all'; do
  got=$(raw "$p"); got=${got:-allow}
  if [ "$got" = allow ]; then printf 'ok   %-16s payload: %s\n' "$got" "$p"
  else printf 'FAIL want=allow got=%s  payload: %s\n' "$got" "$p"; FAILED=1; fi
done
got=$(raw '{"tool_name":"Bash","tool_input":{"command":"git commit -m x"'); got=${got:-allow}
if [ "$got" = deny ]; then printf 'ok   %-16s payload: truncated JSON naming a commit\n' "$got"
else printf 'FAIL want=deny got=%s  truncated JSON naming a commit\n' "$got"; FAILED=1; fi

echo "-- unapproved / stale trees"
rm -f "$(git rev-parse --git-dir)/singz-reviewed"
check not-reviewed 'git commit -m x'
check not-reviewed 'git rebase --continue'
check refused-flags 'git commit -am x'                 # refusal outranks the marker check
git write-tree > "$(git rev-parse --git-dir)/singz-reviewed"
echo three >> file.txt; git add file.txt               # tree moves after approval
check stale 'git commit -m x'

echo "-- the escape hatch, and only as a leading assignment"
check allow 'SINGZ_SKIP_REVIEW=1 git commit -m x'
check stale 'git commit -m "documents SINGZ_SKIP_REVIEW=1 in the message"'

cd /; rm -rf "$REPO"
exit $FAILED

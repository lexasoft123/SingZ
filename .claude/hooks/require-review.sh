#!/usr/bin/env bash
# PreToolUse/Bash gate: a commit only goes through when the code-reviewer
# agent has approved THAT EXACT staged tree.
#
# The marker is `<git-dir>/singz-reviewed` and holds a tree hash. Only the
# agent writes it, and only on a "safe to commit" verdict — so the gate is
# not "someone says they reviewed", it is "the reviewer approved this tree".
# Staging one more hunk changes the tree hash and the marker stops matching,
# which is the behaviour we want: what was reviewed is what gets committed.
#
# The one deliberate way through, and it is visible in the transcript:
#   SINGZ_SKIP_REVIEW=1 git commit …
# There is NO exemption for a merge or rebase: a clean merge never runs `git
# commit` at all, so anything reaching here mid-merge is a hand-resolved
# conflict, which is code worth reading like any other.
#
# stdin: the PreToolUse hook payload. Silence = allow.
# Edited this file? Run ./require-review.test.sh — every case in it is there
# because this gate got it wrong once.
set -uo pipefail

# Emitting the verdict needs no JSON tool at all: the reasons here are
# single-line, and the two characters that could break the literal are
# escaped. One less thing that can be missing at the moment it matters.
deny() {
  esc=$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')
  printf '{"hookSpecificOutput":{"hookEventName":"PreToolUse","permissionDecision":"deny","permissionDecisionReason":"%s"}}\n' "$esc"
  exit 0
}

payload=$(cat)

# Reading the payload must not depend on one particular binary. jq ships with
# macOS 15+ but is absent from plenty of Linux CI images and from git-bash on
# the Windows box; node is guaranteed, since this repo cannot be built without
# it. Try jq, fall back to node, and if the command still cannot be read,
# refuse anything commit-shaped — a gate that quietly vanishes when a tool is
# missing is worse than no gate, because nobody notices it went. Measured
# before this: a PATH without jq, and equally a jq that merely errors, allowed
# an unreviewed commit and printed nothing at all.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
fi
if [ -z "$cmd" ] && command -v node >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch(e){}})' 2>/dev/null || true)
fi
if [ -z "$cmd" ]; then
  # Fail closed, but only over payloads that could BE a commit. Denying every
  # unparseable payload also denies the shapes that legitimately carry no
  # command, and the skip it advertises is unreachable — the escape lives in
  # command text this branch just failed to read, so the only way out would be
  # editing settings.json with a non-Bash tool.
  case "$payload" in
    *commit*) deny "The commit review gate could not read its input (no working jq or node on PATH) and this payload looks like a commit. Refusing rather than letting an unreviewed commit through — install jq or node." ;;
    *) exit 0 ;;
  esac
fi

# ONE stripped view of the command, used by every check below. Quoted runs
# stop being readable as syntax: reading them was a false-deny machine in
# both directions — as flags (a commit refused for the words in its own
# message) and as commands (a grep whose pattern contained a chained commit,
# then denied "not reviewed"). Both bit real, read-only commands in this repo.
#
# They are REPLACED, not deleted, because deleting one changes the shape of
# the command: `commit -m "msg" path` collapsed to `commit -m  path`, so the
# operand walk below handed the path to -m as its message and let a
# working-tree commit through. A placeholder keeps the token count honest.
stripped=$(printf '%s' "$cmd" | sed -E "s/'[^']*'/Q/g; s/\"[^\"]*\"/Q/g")

# A commit only counts at a command boundary, behind git's own options at
# most. A plain substring test fires on everything that merely mentions the
# words — a grep over the docs, a test payload, this file's own comments.
# Requiring the subcommand to be the first non-option token is what keeps
# `git log --grep commit` out; `then`, `do` and `{` introduce commands too.
BOUNDARY='(^|[;&|({]|&&|\|\||\bthen\b|\bdo\b)[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]+[[:space:]]+)*git[[:space:]]+'
GIT_OPTS='((-[Cc][[:space:]]+[^[:space:]]+|--(git-dir|work-tree|namespace)([=[:space:]])[^[:space:]]+|-[^[:space:]]+)[[:space:]]+)*'
COMMIT_RE="${BOUNDARY}${GIT_OPTS}commit([[:space:]]|\$)"
# `merge|rebase|cherry-pick --continue` writes a commit without ever saying
# the word — the standard way to finish the hand-resolved conflict this gate
# claims to cover.
CONT_RE="${BOUNDARY}${GIT_OPTS}(merge|rebase|cherry-pick|revert|am)[[:space:]]+--continue([[:space:]]|\$)"
# Changing directory first is the SPELLING PEOPLE USE for "commit somewhere
# else" — this repo keeps 21 worktrees and CLAUDE.md mandates them — and it
# defeats the gate in both directions: the hook hashes the index where IT
# stands, so a worktree commit rode in on the main checkout's approval, and a
# properly reviewed worktree commit was refused while quoting hashes from a
# repository it was not touching. The shell's cwd resets to the project
# directory after every call, so this cannot be fixed by cd-ing in an earlier
# one: the commit has to come from a session whose own directory is that
# repository (EnterWorktree), and then the hook reads the right index.
CD_RE='(^|[;&|({]|&&|\|\|)[[:space:]]*(cd|pushd|popd)([[:space:]]|$)'
GITENV_RE='(^|[[:space:]])GIT_(DIR|WORK_TREE|INDEX_FILE)='
ELSEWHERE="Refused: this call points the commit at a different working directory (cd/pushd, or a GIT_DIR/GIT_WORK_TREE/GIT_INDEX_FILE prefix), and this gate can only vouch for the index where it runs — the tree it approved is not the tree that would be committed. Commit from a session whose own working directory is that repository (EnterWorktree for a worktree); the shell's cwd resets between calls, so cd-ing first does not carry."
# Anything that moves the index. Run before a commit in the SAME call it
# changes the tree after this hook has already read it — see STAGE_FIRST.
# `switch` earns its place twice over: it rewrites the index to the target
# branch's tree, and it is the first thing anyone reaches for when the
# `checkout` below is refused, so leaving it out would point straight at the
# hole. The over-match (`git stash list`, `git apply --check` and friends are
# read-only yet refused) is deliberate: an over-refusal costs one extra call
# and announces itself, a missing verb costs an unreviewed commit and never does.
INDEX_RE="${BOUNDARY}([^[:space:]]+[[:space:]]+)*(add|rm|mv|restore|reset|stash|apply|checkout|switch)([[:space:]]|\$)"
# …and the no-commit forms, which stage a merge for someone else to commit.
NOCOMMIT_RE="${BOUNDARY}([^[:space:]]+[[:space:]]+)*(merge|cherry-pick|revert)[[:space:]]+.*(-n([[:space:]]|\$)|--no-commit)"

printf '%s' "$stripped" | grep -Eq "$COMMIT_RE|$CONT_RE" || exit 0

# Explicit opt-out — a leading env assignment, never merely quoted text.
printf '%s' "$stripped" | grep -Eq '(^|[;&|({]|&&|\|\|)[[:space:]]*SINGZ_SKIP_REVIEW=1[[:space:]]' && exit 0

# A git-dir override rides on the commit itself, so it needs no segment walk.
printf '%s' "$stripped" | grep -Eq "$GITENV_RE" && deny "$ELSEWHERE"

STAGE_FIRST="Refused: this call stages and then commits, so the tree it ships is not the tree this gate can read — the hook runs before the command, and the index it sees is the one from before the staging. Stage in its own call, let the code-reviewer agent approve THAT tree, then commit."

# Every matching segment, not only the first. A chained second commit used to
# skip every refusal, and a `commit … && commit -am …` pair put an unreviewed
# line in HEAD that way. Fed by a heredoc rather than a pipe, so `deny` can
# exit the script from inside the loop.
staged_here=no
moved_here=no
while IFS= read -r seg; do
  [ -z "$seg" ] && continue

  # Commit-shaped segments are classified FIRST. The other order let a commit
  # whose last token happened to be one of the index verbs (a path named
  # `add`) take the staging branch and skip every check below it.
  if printf '%s' "$seg" | grep -Eq "$COMMIT_RE"; then
    [ "$moved_here" = yes ] && deny "$ELSEWHERE"
    [ "$staged_here" = yes ] && deny "$STAGE_FIRST"
    args=${seg#*commit}
    # Options BEFORE the subcommand belong to git itself; -C after it means
    # "reuse that commit's message", whose tree is still the index, so it is
    # fine.
    head=${seg%%commit*}

    # THE INDEX MUST BE THE COMMIT. -a sweeps up every modified tracked file,
    # -i/-o and a `--` pathspec compose their own tree, -p picks hunks out of
    # the working tree — none of them is the tree the reviewer read. Refused
    # rather than gated: their tree cannot be known before they run. The
    # cluster may continue past the letter, because the two-letter spelling
    # is the ordinary one and anchoring straight after it let it through
    # entirely (verified: an unreviewed line reached HEAD). Long options are
    # skipped, so --amend — which commits the index like any other — is fine.
    if printf '%s' "$args" | grep -Eq '(^|[[:space:]])(-[^-[:space:]]*[aiop][^-[:space:]]*|--(all|include|only|patch))([[:space:]]|=|$)'; then
      deny "Refused: -a/--all, -i/--include, -o/--only and -p/--patch all commit something other than the staged tree, so a review of the index cannot vouch for it. Stage what you mean to ship, have the code-reviewer agent approve it, then commit without those flags."
    fi
    # A pathspec, with or without the separator. git's `--` is OPTIONAL, and
    # refusing only the spelling that has it left the shorter one wide open —
    # `git commit -m x path` put a line in HEAD that was never staged and
    # never read, the same relationship `-am` had to `-a`. So the test is for
    # an OPERAND: walk the tokens, skip options and the one value that
    # follows a value-taking option, and refuse anything bare that is left.
    # Quoted text is already gone, so an ordinary `-m "…"` leaves nothing.
    skip_next=no
    set -f   # an operand like *.md would otherwise be glob-expanded against
             # the hook's own cwd, and the refusal would name a file nobody typed
    for tok in $args; do
      if [ "$skip_next" = yes ]; then skip_next=no; continue; fi
      case "$tok" in
        --) deny "Refused: a pathspec takes working-tree contents for those paths, overriding the staged tree the review approved (CLAUDE.md warns about exactly this). Stage the paths instead, re-review, then commit." ;;
        --*=*) ;;
        --author|--date|--cleanup|--fixup|--squash|--template|--trailer|--pathspec-from-file|--message|--file|--reuse-message|--reedit-message)
          skip_next=yes ;;
        --*) ;;
        # A short cluster ending in one of these takes the next token as its
        # value (`-m msg`, `-sm msg`). -S and -u attach their values instead,
        # so they are left out: skipping a token they never claimed would
        # swallow a real pathspec.
        -*[mFCct]) skip_next=yes ;;
        -*) ;;
        *) deny "Refused: \`$tok\` is a pathspec operand, and a commit with a pathspec takes working-tree contents for those paths instead of the staged tree the review approved. Stage it, re-review, then commit." ;;
      esac
    done
    set +f
  elif printf '%s' "$seg" | grep -Eq "$CONT_RE"; then
    [ "$moved_here" = yes ] && deny "$ELSEWHERE"
    [ "$staged_here" = yes ] && deny "$STAGE_FIRST"
    head=${seg%%--continue*}
  elif printf '%s' "$seg" | grep -Eq "$CD_RE"; then
    moved_here=yes
    continue
  elif printf '%s' "$seg" | grep -Eq "$INDEX_RE|$NOCOMMIT_RE"; then
    staged_here=yes
    continue
  else
    continue
  fi

  # Git's own -C sits before the subcommand, so it aims a --continue
  # somewhere else just as readily as a commit: this belongs to both.
  if printf '%s' "$head" | grep -Eq '(^|[[:space:]])(-C([[:space:]]|$)|--git-dir|--work-tree)'; then
    deny "Refused: this gate reads the repository the command runs in, so it cannot vouch for a commit aimed elsewhere with -C/--git-dir. Run it from that directory."
  fi
done <<SEGMENTS
$(printf '%s' "$stripped" | sed -E 's/(&&|\|\||;)/\n/g')
SEGMENTS

git_dir=$(git rev-parse --git-dir 2>/dev/null) || exit 0   # not a repo: not ours to gate

# The tree as staged right now. It fails only when the index still holds
# unmerged entries — a state git itself refuses to commit from — so getting
# out of the way there costs nothing. There is deliberately NO exemption for
# "a merge/rebase is in progress": a clean merge never runs `git commit` at
# all (merge commits itself), so reaching here mid-merge means conflicts were
# resolved BY HAND, and hand-written conflict resolutions are exactly the code
# most worth reading.
staged=$(git write-tree 2>/dev/null) || exit 0
[ -n "$staged" ] || exit 0

reviewed=$(cat "$git_dir/singz-reviewed" 2>/dev/null || true)

if [ "$staged" = "$reviewed" ]; then
  exit 0
fi

if [ -z "$reviewed" ]; then
  deny "Not reviewed yet. CLAUDE.md: every commit is reviewed first — launch the code-reviewer agent (Agent tool, subagent_type code-reviewer) on the staged diff, act on what it reports, and it will mark this tree approved. Deliberate skip: prefix the command with SINGZ_SKIP_REVIEW=1."
fi

deny "The staged tree changed since the review (reviewed ${reviewed:0:8}, staged ${staged:0:8}) — what would be committed is not what was reviewed. Re-run the code-reviewer agent on the staged diff. Deliberate skip: prefix the command with SINGZ_SKIP_REVIEW=1."

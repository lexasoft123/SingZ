#!/usr/bin/env bash
# PostToolUse/Bash: after a release tag is created, ask for the channel post.
#
# Cutting a release and telling people about it are two different habits, and
# only one of them is enforced by anything. The release workflow builds and
# attaches artifacts on a v* tag; nothing anywhere reminds you the Telegram
# channel still has no post. This closes that gap at the moment the tag is
# made, while the version is still on screen.
#
# It cannot generate the poster by itself, and deliberately does not pretend
# to: the poster is a collage of REAL app screenshots, so it needs the built
# desktop app, a booted simulator with this build installed, and the song
# library — none of which exist on a CI runner. What it does is hand the
# session the task with the version already filled in.
#
# Note on ordering: this fires AFTER the tag exists, so the poster lands in a
# commit after the tagged one. That is fine — the poster is for the channel,
# not a build input, and nothing in the release workflow reads it.
#
# Prereleases (hyphenated, e.g. v0.14.1-test1) are skipped: per CLAUDE.md they
# exist to hand one tester a build, and they are never "latest", so there is
# no channel announcement to make.
#
# stdin: the PostToolUse hook payload. Silence = say nothing.
set -uo pipefail

payload=$(cat)

# Same parse as require-review.sh: jq if present, else node. Unlike that gate,
# an unreadable payload here is harmless — the worst case is a missed reminder,
# so this stays quiet rather than guessing.
cmd=""
if command -v jq >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | jq -r '.tool_input.command // ""' 2>/dev/null || true)
fi
if [ -z "$cmd" ] && command -v node >/dev/null 2>&1; then
  cmd=$(printf '%s' "$payload" | node -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{try{process.stdout.write(JSON.parse(s).tool_input?.command??"")}catch(e){}})' 2>/dev/null || true)
fi
[ -n "$cmd" ] || exit 0

# Flags must be read from the command, not from a commit/tag MESSAGE. Without
# this, `git tag -a v1.2.3 -m "faster -d handling"` matched the delete pattern
# and said nothing about a real release. Replace quoted runs with Q first, the
# same trick require-review.sh uses. NOTE: this view feeds flag and command
# matching only — the version is still read from the raw command below, since
# `git tag -a "v1.2.3"` would lose it here.
flags=$(printf '%s' "$cmd" | sed -e "s/'[^']*'/Q/g" -e 's/"[^"]*"/Q/g')

# `git tag` must be a COMMAND, not a mention. A plain substring test fired on
# anything whose text contained the words — including, during review, a harness
# that was only testing this hook, which produced a live reminder for a tag
# nobody made. Split on the shell separators and require a segment that starts
# with git (optionally behind env assignments and git's own pre-command flags).
segments=$(printf '%s' "$flags" | awk '{gsub(/&&|\|\||;|\|/, "\n"); print}')
matching=$(printf '%s\n' "$segments" | grep -E \
  '^[[:space:]]*([A-Za-z_][A-Za-z0-9_]*=[^[:space:]]*[[:space:]]+)*git[[:space:]]+((-C[[:space:]]+[^[:space:]]+|--git-dir=[^[:space:]]+|-c[[:space:]]+[^[:space:]]+|--no-pager)[[:space:]]+)*tag([[:space:]]|$)')
[ -n "$matching" ] || exit 0

# Take the first segment that CREATES something, not merely the first that
# looks like a tag command. Listing, deleting, verifying and querying announce
# nothing, and they routinely share a chain with the create that does:
# `git tag -d v1 && git tag -a v1 -m corrected` is the ordinary way to fix a
# bad tag — and precisely the moment no poster exists. Choosing the segment
# before asking whether it announces anything made that chain silent.
tagseg=""
while IFS= read -r seg; do
  [ -n "$seg" ] || continue
  case " $seg " in
    *" -d "*|*" --delete "*|*" -l "*|*" --list "*|*" -v "*|*" --verify "*|\
    *" --contains "*|*" --points-at "*|*" --merged "*|*" --no-merged "*) continue ;;
  esac
  tagseg="$seg"
  break
done <<MATCHING
$matching
MATCHING
[ -n "$tagseg" ] || exit 0

# (The skip list is applied per segment in the loop above. It reads flags from
# the segment, never the whole command: a neighbour's flags are not this
# command's. Against the flat string, `git tag -a v1 -m notes && git push -v
# origin v1` read `-v` as --verify and said nothing — which is how a release
# actually gets cut.)

# Prefer the version from the tag segment itself — in a chain like
# `git push origin v0.16.0 && git tag v0.17.0` the first version in the whole
# command belongs to the push, not the tag. Fall back to the raw command when
# the segment has none, which happens when the tag name was quoted and the
# quote-stripping above replaced it with Q.
# Read the version from what comes AFTER ` tag `, where the tag name is. The
# whole segment also contains git's own `-C <path>`, and this repo keeps
# worktrees on disk — `git -C /repos/worktrees/v1.2.3 tag v0.17.0` announced
# v1.2.3, a version nobody tagged, and sent the session hunting for its notes.
# Trim through the FIRST ` tag `, not the last. A greedy match skipped past the
# word inside a MESSAGE — `git tag -a "v0.17.0" -m "replaces tag v0.16.9"`
# announced v0.16.9 — while first-match keeps the -C win above.
VERSION_RE='v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?'
# The haystack is padded so a segment ENDING in ` tag` still matches: without
# the pad, `git -C /repos/worktrees/v1.2.3 tag` found no ` tag ` and fell
# through to the whole string, letting the -C path supply a version nobody
# tagged. `i` stays a valid index into the unpadded $0.
after_tag() {
  printf '%s' "$1" | awk '{i = index($0 " ", " tag "); if (i) print substr($0, i + 4); else print $0}'
}

version=$(after_tag "$tagseg" | grep -oE "$VERSION_RE" | head -1)
# Falling back to the raw command covers a quoted tag name, which the
# quote-stripping above replaced with Q. Same `after tag` trim, so the -C path
# stays excluded there too.
[ -n "$version" ] || version=$(after_tag "$cmd" | grep -oE "$VERSION_RE" | head -1)
[ -n "$version" ] || exit 0

case "$version" in
  *-*) exit 0 ;;   # prerelease: handed to one tester, never announced
esac

# Say nothing if the poster for this version is already committed — re-tagging
# or a corrected tag should not nag.
root=$(git rev-parse --show-toplevel 2>/dev/null || printf '%s' "${CLAUDE_PROJECT_DIR:-.}")
if [ -f "$root/docs/release-notes/$version-poster.png" ]; then
  exit 0
fi

read -r -d '' context <<EOF || true
$version was just tagged and has no channel post yet.

Invoke the release-poster skill for $version now: it builds the 4:5 poster from
real app screenshots and writes the English and Russian Telegram captions, then
hands over a post kit page with copy buttons.

It needs the desktop app built (npm run build) and a simulator booted with this
build installed, because every fragment is a screenshot of the running app. If
either is missing, say so rather than substituting a mockup.

The poster belongs at docs/release-notes/$version-poster.png.
EOF

esc=$(printf '%s' "$context" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g' | awk '{printf "%s\\n", $0}')
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s"}}\n' "$esc"
exit 0

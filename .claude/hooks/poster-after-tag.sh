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

case "$cmd" in
  *"git tag"*) ;;
  *) exit 0 ;;
esac

# Flags must be read from the command, not from a commit/tag MESSAGE. Without
# this, `git tag -a v1.2.3 -m "faster -d handling"` matched the delete pattern
# and said nothing about a real release. Replace quoted runs with Q first, the
# same trick require-review.sh uses.
flags=$(printf '%s' "$cmd" | sed -e "s/'[^']*'/Q/g" -e 's/"[^"]*"/Q/g')

# Listing, deleting, verifying or querying a tag creates nothing to announce.
case " $flags " in
  *" -d "*|*" --delete "*|*" -l "*|*" --list "*|*" -v "*|*" --verify "*|\
  *" --contains "*|*" --points-at "*|*" --merged "*|*" --no-merged "*) exit 0 ;;
esac

# The first vX.Y.Z in the command is the tag being made. Hyphenated
# prereleases are matched separately below so they can be skipped.
version=$(printf '%s' "$cmd" | grep -oE 'v[0-9]+\.[0-9]+\.[0-9]+(-[0-9A-Za-z.]+)?' | head -1)
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

#!/usr/bin/env bash
# PostToolUse/Bash: when HEAD carries a release tag with no poster, ask for the
# channel post. Runs after the command did, so it asks git what happened rather
# than predicting it from the command text — which is why there is no parser
# here, and why quoting, chains, heredocs and subshells cannot fool it.
# Tests: ./poster-after-tag.test.sh
set -uo pipefail
R="${CLAUDE_PROJECT_DIR:-.}"; G=(git -C "$R")
grep -q tag || exit 0                                             # cheap filter: stdin payload
"${G[@]}" symbolic-ref -q HEAD >/dev/null || exit 0               # detached = revisiting a tag, not making one
v=$("${G[@]}" describe --exact-match --tags HEAD 2>/dev/null) || exit 0
case "$v" in v*.*.*) ;; *) exit 0 ;; esac                         # release tags only
case "$v" in *-*) exit 0 ;; esac                                  # prereleases go to one tester
p="docs/release-notes/$v-poster.png"
[ -f "$R/$p" ] && exit 0
# Say it ONCE per version. The condition is a standing state, not an event, and
# the filter above is loose — "tag" sits inside "staged", so a plain git status
# would otherwise repeat the ask, including all through the poster build itself.
# --absolute-git-dir, not --git-dir: with `-C` git chdirs first and answers a
# bare `.git`, which the shell would then resolve against ITS cwd — so from any
# directory but the project root the append failed and the nag came back.
m="$("${G[@]}" rev-parse --absolute-git-dir)/poster-reminded"
grep -qxF "$v" "$m" 2>/dev/null && exit 0
printf '%s\n' "$v" >> "$m"
printf '{"hookSpecificOutput":{"hookEventName":"PostToolUse","additionalContext":"%s is tagged and has no channel post yet. Invoke the release-poster skill for %s — it builds the poster and the EN/RU captions. Every fragment is a screenshot of the running app, so it needs the desktop app built and a simulator booted; say so rather than substituting a mockup. The poster belongs at %s."}}\n' "$v" "$v" "$p"

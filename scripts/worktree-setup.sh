#!/usr/bin/env bash
# Bootstrap a fresh git worktree: symlink the machine-local, gitignored
# artifacts from the main checkout, install deps, bake configs. Idempotent —
# safe to re-run after linking more things or pulling. Run from anywhere
# inside the worktree:
#
#   scripts/worktree-setup.sh                 # desktop + mobile (pods on a Mac)
#   scripts/worktree-setup.sh --desktop-only  # skip mobile deps + pods
#
# Build products (out/, mobile/ios/Pods+build, mobile/android/.gradle) stay
# per-worktree on purpose — that isolation is why worktrees exist. Speed
# comes from the global caches instead: npm cache, CocoaPods cache, ccache.
set -euo pipefail

WT="$(cd "$(dirname "$0")/.." && pwd)"
MAIN="$(git -C "$WT" worktree list --porcelain | head -1 | sed 's/^worktree //')"
MODE="${1:-}"

# `-e` FOLLOWS symlinks, so a link whose target moved (the main checkout
# renamed or relocated) reads as absent here and as "File exists" to ln, which
# under set -e kills the whole setup before npm ci with an opaque ln: line.
#
# But merely skipping it would trade a loud failure for a quiet wrong state —
# the link stays broken, re-running setup never repairs it, and nothing says
# so. So a DANGLING link is repointed and reported, while a real file the
# worktree built still wins over any link. Returns 0 when the caller should
# leave the path alone.
# $2 must EXIST before we claim to have repaired anything: repointing at a
# path that is also missing prints "repointed" over a link that is still
# broken, and suppresses the one line that was the real diagnosis. Callers
# check this too — the reorder in link() below — but a lying log line is the
# exact failure this whole change exists to stop, so it is refused here as
# well rather than left to every future caller to remember.
present() {
  if [ -L "$1" ] && [ ! -e "$1" ] && [ -e "$2" ]; then
    ln -sfn "$2" "$1"
    echo "  repointed $(basename "$1") (its target had moved)"
    return 0
  fi
  [ -e "$1" ] || [ -L "$1" ]
}

link() { # link <relpath> — symlink main's copy when the worktree lacks it
  local rel="$1"
  # "main has not got it either" is asked FIRST, so a dangling link here still
  # reports the true reason instead of a repair that could not have happened.
  # It matters most for gdrive.config.json, whose absence bakes an EMPTY
  # gdrive-config at postinstall — a failure worth naming accurately.
  if [ ! -e "$MAIN/$rel" ]; then
    echo "  skip  $rel (absent in main checkout too)"
    return 0
  fi
  present "$WT/$rel" "$MAIN/$rel" && return 0
  ln -s "$MAIN/$rel" "$WT/$rel"
  echo "  linked $rel"
}

# vendor/ holds two different KINDS of artifact and they cannot be shared on
# the same terms.
#
#   third-party engine builds (whisper-cli, demucs-cli, the splitter packs)
#     come from .engines-src/ and downloads. No branch of ours changes them,
#     they cost minutes to rebuild, and every worktree wants the same copy.
#
#   our own engine builds (singz-analyze, singz-capture.node) come from
#     mobile/native/core — which is exactly what a feature branch edits.
#
# Linking the whole directory shared the second kind too, and that is not a
# theoretical hazard: during the v0.19.0 cut a sibling worktree ran
# vendor-analyze.sh, wrote THROUGH this symlink into the main checkout's slot,
# and the desktop spawned that branch's core — live-input adapter included —
# for hours. On the machine where this was written, nine worktrees held nine
# different states of mobile/native/core and one shared binary matching none
# of them.
#
# So the directory is mirrored instead of linked: third-party artifacts are
# symlinks to main's copies, ours are absent until this worktree builds its
# own. Only singz-analyze is built below — singz-capture.node has no producer
# on this tree yet (it arrives with the dsp-graph branch), so its slot is
# simply left empty rather than pointing at another branch's addon, which is
# the whole point. src/main/analyze-provenance.ts is the safety net for what
# this cannot reach (a packaged app, a hand-copied binary); this is the fix.
REPO_BUILT='singz-analyze singz-analyze.exe singz-analyze.source-hash
            singz-analyze.exe.source-hash singz-capture.node
            singz-capture.node.source-hash'

is_repo_built() {
  local name="$1" candidate
  for candidate in $REPO_BUILT; do [ "$name" = "$candidate" ] && return 0; done
  return 1
}

mirror_vendor() {
  if [ ! -d "$MAIN/vendor" ]; then
    echo "  skip  vendor (absent in main checkout too)"
    return 0
  fi
  # Migrate the old whole-directory symlink. Only ever a symlink is removed —
  # never a real directory, which in the main checkout is the actual engines.
  if [ -L "$WT/vendor" ]; then
    rm "$WT/vendor"
    echo "  vendor was a symlink to the shared slot — replacing it with a mirror"
  fi
  mkdir -p "$WT/vendor"
  local entry name inner iname
  for entry in "$MAIN"/vendor/*; do
    [ -e "$entry" ] || continue
    name=$(basename "$entry")
    # An engine target dir (darwin-arm64, win32-x64, ...) is the mixed one:
    # go in and link per file. Everything else at this level is third-party.
    if [ -d "$entry" ] && [ "$name" != "packs" ]; then
      mkdir -p "$WT/vendor/$name"
      for inner in "$entry"/*; do
        [ -e "$inner" ] || continue
        iname=$(basename "$inner")
        is_repo_built "$iname" && continue
        present "$WT/vendor/$name/$iname" "$inner" || ln -s "$inner" "$WT/vendor/$name/$iname"
      done
      echo "  mirrored vendor/$name (ours stay per-worktree)"
      continue
    fi
    if ! present "$WT/vendor/$name" "$entry"; then
      ln -s "$entry" "$WT/vendor/$name"
      echo "  linked vendor/$name"
    fi
  done
}

if [ "$WT" = "$MAIN" ]; then
  echo "Main checkout — nothing to link, running installs only."
else
  echo "Linking machine-local artifacts from $MAIN:"
  mirror_vendor                        # third-party engines shared, ours not
  link mobile/gdrive.config.json       # OAuth client -> configs bake FILLED
  link mobile/android/local.properties # Android SDK path
fi

# The links are FILES (symlinks). Register them in the repo-wide exclude —
# shared by every worktree, whatever its checkout's .gitignore vintage — so
# a `git add -A` can never commit them: a committed vendor symlink once
# merged into main and silently CLOBBERED the real vendor/ on checkout.
EXCLUDE="$(git -C "$WT" rev-parse --path-format=absolute --git-common-dir)/info/exclude"
if ! grep -qs 'worktree-setup provisioning' "$EXCLUDE"; then
  mkdir -p "$(dirname "$EXCLUDE")"
  printf '%s\n' '# worktree-setup provisioning links (machine-local, every worktree)' \
    'vendor' 'gdrive.config.json' 'local.properties' >>"$EXCLUDE"
  echo "Registered provisioning links in $(basename "$(dirname "$(dirname "$EXCLUDE")")")/info/exclude"
fi
for rel in vendor mobile/gdrive.config.json mobile/android/local.properties; do
  if [ -e "$WT/$rel" ] && ! git -C "$WT" check-ignore -q "$rel"; then
    echo "FATAL: $rel is NOT gitignored here — a git add -A would commit it (and a" >&2
    echo "committed vendor symlink clobbers the real vendor/ when merged). Aborting." >&2
    exit 1
  fi
done

# ccache needs no setup here: every worktree already shares one cache dir
# (it is per-user, not per-checkout), and what makes a SIBLING worktree
# actually hit — base_dir + hash_dir, against absolute paths and -g — is
# passed per build by vendor-whisper.sh, run-with-ccache.js and, for Xcode,
# mobile/scripts/ccache-xcode-conf.js at postinstall. Nothing outside the
# project is written; see docs/DEVELOPMENT.md.

echo "Desktop deps (npm ci; postinstall bakes gdrive-config + checks patches):"
(cd "$WT" && npm ci)
# npm sometimes restores electron from cache without running its postinstall;
# the app then dies with "Electron failed to install correctly".
if [ ! -f "$WT/node_modules/electron/path.txt" ]; then
  echo "electron binary missing — running its install script"
  (cd "$WT/node_modules/electron" && node install.js)
fi

if [ "$MODE" != "--desktop-only" ]; then
  echo "Mobile deps:"
  (cd "$WT/mobile" && npm ci)
  if [ "$(uname)" = "Darwin" ] && command -v pod >/dev/null 2>&1; then
    echo "iOS pods (CocoaPods global cache + ccache make repeats quick):"
    # LANG: CocoaPods crashes in non-interactive shells (agent sessions)
    # with "Unicode Normalization not appropriate for ASCII-8BIT" otherwise
    (cd "$WT/mobile/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)
  fi
fi

# This worktree's OWN singz-analyze — one of the slots mirror_vendor
# deliberately left empty. Without it the desktop finds no core and silently
# falls back to the TS detectors, which is a quieter wrong answer than the
# shared binary was. singz-capture.node is left to whoever adds its build
# script; an empty slot is the correct state until then.
# Non-fatal: a machine with no cmake still gets a working checkout, and
# analyze-provenance.ts says so at launch either way.
if command -v cmake >/dev/null 2>&1; then
  echo "This worktree's singz-analyze (ccache makes a sibling's build cheap):"
  if ! "$WT/scripts/vendor-analyze.sh"; then
    echo "  singz-analyze did not build — run scripts/vendor-analyze.sh when you need the core" >&2
  fi
else
  echo "No cmake: run scripts/vendor-analyze.sh once you have one, or the core stays absent."
fi

echo "Worktree ready: npm run dev / typecheck / test all work here."

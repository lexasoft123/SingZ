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

link() { # link <relpath> — symlink main's copy when the worktree lacks it
  local rel="$1"
  [ -e "$WT/$rel" ] && return 0
  if [ ! -e "$MAIN/$rel" ]; then
    echo "  skip  $rel (absent in main checkout too)"
    return 0
  fi
  ln -s "$MAIN/$rel" "$WT/$rel"
  echo "  linked $rel"
}

if [ "$WT" = "$MAIN" ]; then
  echo "Main checkout — nothing to link, running installs only."
else
  echo "Linking machine-local artifacts from $MAIN:"
  link vendor                          # whisper-cli + pack build outputs
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

echo "Worktree ready: npm run dev / typecheck / test all work here."

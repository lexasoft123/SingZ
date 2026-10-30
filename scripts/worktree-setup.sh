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
MODE="${1:-}"
if [ "$#" -gt 1 ] || { [ -n "$MODE" ] && [ "$MODE" != "--desktop-only" ]; }; then
  echo "Usage: scripts/worktree-setup.sh [--desktop-only]" >&2
  exit 2
fi
# Fail before deleting dependencies or changing provisioning links.
for tool in node npm cmake git python3; do
  command -v "$tool" >/dev/null 2>&1 || { echo "FATAL: required tool missing: $tool" >&2; exit 1; }
done
if [ "$MODE" != "--desktop-only" ] && [ "$(uname)" = Darwin ]; then
  command -v pod >/dev/null 2>&1 || {
    echo "FATAL: CocoaPods is required for mobile setup on macOS. Install it or use --desktop-only." >&2
    exit 1
  }
fi
if [ -z "${SINGZ_NATIVE_BUILD_LOCK_HELD:-}" ]; then
  exec node "$WT/scripts/with-native-build-lock.mjs" --owner worktree-setup -- bash "$WT/scripts/worktree-setup.sh" "$@"
fi
node "$WT/scripts/assert-native-build-lock.cjs"

# The audio engine is a public, pinned git submodule. Initialize it before any
# dependency checks, fingerprints or native mirror generation. Refuse a flat
# payload or a dirty child rather than letting Git replace user work.
initialize_zcore_submodule() {
  local relative=third_party/zcore child="$WT/third_party/zcore" entries count
  entries=$(git -C "$WT" ls-files --stage -- "$relative")
  count=$(printf '%s\n' "$entries" | awk '$1 == "160000" && $3 == "0" { n++ } END { print n+0 }')
  if [ "$count" -ne 1 ]; then
    echo "FATAL: $relative must be one stage-0 git submodule entry before setup." >&2
    echo "       Initialize the declared submodule in a real Git checkout; setup will not replace a flat payload." >&2
    exit 1
  fi
  if [ -e "$child/.git" ]; then
    if [ -n "$(git -C "$child" status --porcelain --untracked-files=all)" ]; then
      echo "FATAL: $relative has tracked, staged, or untracked changes; preserve them before updating the submodule." >&2
      exit 1
    fi
  elif [ -d "$child" ] && find "$child" -mindepth 1 -maxdepth 1 -print -quit | grep -q .; then
    echo "FATAL: $relative contains files but is not an initialized Git submodule; setup will not overwrite this directory." >&2
    exit 1
  fi
  git -C "$WT" submodule sync --recursive -- "$relative"
  git -C "$WT" submodule update --init --recursive -- "$relative"
  python3 "$WT/scripts/verify-zcore-submodule.py" --root "$WT" --path "$relative" >/dev/null
}
initialize_zcore_submodule
node "$WT/scripts/install-git-hooks.cjs"
MAIN="$(git -C "$WT" worktree list --porcelain | sed -n '1s/^worktree //p')"

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
#   third-party engines can be copied only when their receipts match this
#     checkout's requested revision, producer inputs, target and binary bytes.
#
#   our own engine builds (singz-analyze, singz-capture.node) come from the
#     shared zcore/zdsp tree — which is exactly what a feature branch edits.
#
# Linking the whole directory shared the second kind too, and that is not a
# theoretical hazard: during the v0.19.0 cut a sibling worktree ran
# vendor-analyze.sh, wrote THROUGH this symlink into the main checkout's slot,
# and the desktop spawned that branch's core — live-input adapter included —
# for hours. On the machine where this was written, nine worktrees held nine
# different states of the native core and one shared binary matching none of
# them.
#
# So the directory is mirrored instead of linked: third-party artifacts are
# validated local snapshots of main's copies; ours are absent until this worktree builds its
# own. Only singz-analyze is built below; `npm run capture:addon` publishes
# immutable artifacts under this checkout's build/capture-runtime instead.
# src/main/analyze-provenance.ts is the safety net for what this cannot reach
# (a packaged app, a hand-copied binary); this is the fix.
mirror_vendor() {
  # Migrate whole-directory/individual links without touching their targets.
  if [ -L "$WT/vendor" ]; then rm "$WT/vendor"; fi
  mkdir -p "$WT/vendor"
  local entry inner target engine binary producer
  for entry in "$WT"/vendor/*; do
    if [ -L "$entry" ]; then
      rm "$entry"
    elif [ -d "$entry" ]; then
      for inner in "$entry"/*; do [ ! -L "$inner" ] || rm "$inner"; done
    fi
  done
  for target in darwin-arm64 darwin-x64 win32-arm64 win32-x64 linux-arm64 linux-x64; do
    [ -d "$MAIN/vendor/$target" ] || [ -d "$WT/vendor/$target" ] || continue
    mkdir -p "$WT/vendor/$target"
    for engine in llama crispasr; do
      producer="$WT/scripts/vendor-$engine.sh"
      if [ "$engine" = llama ]; then binary=llama-server; else binary=crispasr; fi
      case "$target" in win32-*) binary="$binary.exe" ;; esac
      # Preserve a valid local build; discard receiptless/stale generated output.
      if "$producer" --check-cache "$target" "$WT"; then continue; fi
      rm -f "$WT/vendor/$target/$binary" "$WT/vendor/$target/$binary.receipt.json"
      if ! "$producer" --check-cache "$target" "$MAIN"; then
        echo "  skip $target/$binary (no matching validated cache; build locally when needed)"
        continue
      fi
      # Snapshot BOTH files. Mutable main-slot symlinks would silently change
      # revisions on a later main build. The shared lock protects this copy.
      for inner in "$binary" "$binary.receipt.json"; do
        cp -p "$MAIN/vendor/$target/$inner" "$WT/vendor/$target/$inner.provision-$$"
        mv -f "$WT/vendor/$target/$inner.provision-$$" "$WT/vendor/$target/$inner"
      done
      "$producer" --check-cache "$target" "$WT" || {
        rm -f "$WT/vendor/$target/$binary" "$WT/vendor/$target/$binary.receipt.json"
        echo "FATAL: copied engine failed validation: $target/$binary" >&2
        exit 1
      }
      echo "  snapshotted vendor/$target/$binary"
    done
  done
  # Unknown artifacts and packs need their own validators/producers; never
  # link arbitrary directories from main into a checkout.
}

if [ "$WT" = "$MAIN" ]; then
  echo "Main checkout — validating local engines, running installs."
  mirror_vendor
else
  echo "Provisioning machine-local artifacts from $MAIN:"
  mirror_vendor
  link mobile/gdrive.config.json
  link mobile/android/local.properties
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
# passed per build by vendor-llama.sh and vendor-crispasr.sh, Android's one env-carrying all-project
# CMake launcher/run-with-ccache.js and, for Xcode,
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

  # npm ci DELETES react-native-audio-api's prebuilt static libs and nothing
  # puts them back on its own. They are not in the npm tarball: the podspec's
  # prepare_command fetches them, and CocoaPods runs that only when it
  # integrates the pod for the FIRST time. So a brand-new worktree is fine and
  # a RE-RUN of this script is not — which is exactly the case that matters,
  # because re-running is how a worktree catches up after a rebase. The
  # archive then fails with "Build input files cannot be found:
  # .../external/iphoneos/libogg.a" and five siblings, naming neither npm nor
  # the cause.
  #
  # THE ORDER BELOW IS LOAD-BEARING, and getting it wrong fails at the LINKER
  # rather than here. The same tarball carries the ffmpeg xcframeworks, which
  # the podspec declares as vendored_frameworks — and CocoaPods records only
  # the ones that exist AT POD-INSTALL TIME. A pod install that ran while
  # ffmpeg_ios/ was absent produces a Pods project that never links them,
  # compiles cleanly all the way through, and dies in ld with a wall of
  # undefined _av_* symbols that reads like a broken audio-api release.
  # Download first, pod install second.
  AUDIO_API="$WT/mobile/node_modules/react-native-audio-api"
  EXTERNAL="$AUDIO_API/common/cpp/audioapi/external"
  # All three directories must exist before CocoaPods discovers frameworks.
  # The shared restorer validates ZIPs and fails on incomplete downloads.
  if [ "$(uname)" = Darwin ] && [ -d "$AUDIO_API" ] && { [ ! -d "$EXTERNAL/ffmpeg_ios" ] || [ ! -d "$EXTERNAL/iphoneos" ] || [ ! -d "$EXTERNAL/iphonesimulator" ]; }; then
    echo "  restoring react-native-audio-api prebuilt binaries (npm ci removes them)"
    node "$WT/scripts/restore-audio-api-prebuilts.cjs" ios
    # Keep a concrete postcondition before pod integration too.
    for d in ffmpeg_ios iphoneos iphonesimulator; do
      [ -d "$EXTERNAL/$d" ] || {
        echo "FATAL: react-native-audio-api prebuilts are still missing ($d)." >&2
        echo "       Re-run the verified cache restorer (network needed only on a cold cache):" >&2
        echo "         node scripts/restore-audio-api-prebuilts.cjs ios" >&2
        exit 1
      }
    done
  fi
  # npm ci resets the patched sources too. Idempotent — says "already applied"
  # when there is nothing to do.
  (cd "$WT/mobile" && node scripts/patch-audio-api.js)

  # mobile's postinstall (run by the npm ci above) materializes
  # ios/SingzCore/core as a filtered COPY of top-level zcore, because CocoaPods drops
  # source_files globs that reach above the podspec dir AND skips directory
  # symlinks. Assert it landed BEFORE pod install globs it: a worktree whose
  # tree moved without a re-install keeps building the stale mirror, and the
  # failure names a missing header rather than a stale copy.
  # Compares CONTENT, not just presence: a file that exists but is a version
  # behind is the case that actually ships a stale core, and it is invisible
  # to a name check. Extensions track sync-singzcore.js's own filter — it
  # copies .h/.hpp/.cpp/.mm, and an earlier version of this check omitted
  # .hpp, so a header could go out of date without anything asking.
  stale=$(cd "$WT" && node -e '
    const fs = require("fs")
    const path = require("path")
    const dst = "mobile/ios/SingzCore/core"
    if (!fs.existsSync(dst)) { console.log("it does not exist"); process.exit(0) }
    const { iosAudioHostCallbackFiles, zcoreDeviceCallbackFiles } =
      require("./mobile/scripts/native-component-sources")
    const callbackDefinitions = new Set(
      [...zcoreDeviceCallbackFiles, ...iosAudioHostCallbackFiles]
        .filter((file) => file.endsWith(".cpp")))
    const bad = []
    const compare = (from, to, prefix, accept) => {
      for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
        const relative = prefix ? `${prefix}/${entry.name}` : entry.name
        const source = path.join(from, entry.name)
        const target = path.join(to, entry.name)
        if (entry.isDirectory()) compare(source, target, relative, accept)
        else if (accept(entry.name, relative) &&
                 (!fs.existsSync(target) ||
                  !fs.readFileSync(source).equals(fs.readFileSync(target))))
          bad.push(relative)
      }
    }
    const sourceFile = (name, relative) => /\.(cpp|mm|h|hpp)$/.test(name) &&
      relative !== "src/media/audio_export.cpp" &&
      !callbackDefinitions.has(relative)
    const iosFile = (name, relative) => /\.(cpp|mm|h|hpp)$/.test(name) &&
      !callbackDefinitions.has(relative)
    compare("third_party/zcore/zcore/include", `${dst}/include`, "include",
            (name) => /\.(h|hpp)$/.test(name))
    compare("third_party/zcore/zcore/src", `${dst}/src`, "src", sourceFile)
    compare("third_party/zcore/zcore/platform/ios", `${dst}/platform/ios`, "platform/ios", iosFile)
    // Retained product detectors and ML adapters are mirrored beside zCore.
    // They must receive the same content check after the package extraction.
    if (fs.existsSync("zcore/include"))
      compare("zcore/include", `${dst}/include`, "include",
              (name) => /\.(h|hpp)$/.test(name))
    if (fs.existsSync("zcore/src"))
      compare("zcore/src", `${dst}/src`, "src", sourceFile)
    if (fs.existsSync("zcore/platform/ios"))
      compare("zcore/platform/ios", `${dst}/platform/ios`, "platform/ios", iosFile)
    if (bad.length) console.log(bad.slice(0, 3).join(", ") +
      (bad.length > 3 ? ` +${bad.length - 3} more` : ""))
  ')
  if [ -n "$stale" ]; then
    echo "FATAL: mobile/ios/SingzCore/core does not match zCore and retained SingZ sources ($stale)." >&2
    echo "       Expected mobile's postinstall to sync it. Run:" >&2
    echo "         (cd mobile && npm run postinstall)" >&2
    exit 1
  fi

  if [ "$(uname)" = "Darwin" ] && command -v pod >/dev/null 2>&1; then
    echo "iOS pods (CocoaPods global cache + ccache make repeats quick):"
    # LANG: CocoaPods crashes in non-interactive shells (agent sessions)
    # with "Unicode Normalization not appropriate for ASCII-8BIT" otherwise.
    # Bare `pod`, never `bundle exec pod`: from mobile/ios bundler resolves
    # the fastlane-only Gemfile and dies with "can't find executable pod for
    # gem cocoapods".
    (cd "$WT/mobile/ios" && LANG=en_US.UTF-8 LC_ALL=en_US.UTF-8 pod install)

    # The sandbox and the lockfile have to agree, or the next archive stops
    # with "The sandbox is not in sync with the Podfile.lock" — which is what
    # a worktree whose tree moved under its Pods looks like from xcodebuild.
    if ! diff -q "$WT/mobile/ios/Podfile.lock" "$WT/mobile/ios/Pods/Manifest.lock" >/dev/null 2>&1; then
      echo "FATAL: Pods sandbox is still out of sync with Podfile.lock after pod install." >&2
      exit 1
    fi
    echo "  pods integrated and in sync with Podfile.lock"
  fi
fi

# A ready worktree must have a local analyzer matching its current sources.
# Check the executable itself: a stale binary can have a misleading sidecar.
TARGET=$(node -p 'process.platform + "-" + process.arch')
EXT=""
case "$TARGET" in win32-*) EXT=".exe" ;; esac
if [ -L "$WT/vendor/$TARGET" ]; then
  rm "$WT/vendor/$TARGET"
fi
mkdir -p "$WT/vendor/$TARGET"
ANALYZER="$WT/vendor/$TARGET/singz-analyze$EXT"
STAMP="$ANALYZER.source-hash"
EXPECTED_HASH=$("$WT/scripts/analyze-source-hash.sh" "$WT")

# Migrate individual analyzer links left by older provisioning too. Never
# write through them into another checkout's artifact or stamp.
for artifact in "$ANALYZER" "$STAMP"; do
  if [ -L "$artifact" ]; then
    rm "$artifact"
    echo "  detached shared $(basename "$artifact")"
  fi
done

analyzer_matches_sources() {
  local info
  [ -f "$ANALYZER" ] || return 1
  info=$("$ANALYZER" build-info 2>/dev/null) || return 1
  printf '%s' "$info" | node -e '
    let text = "";
    process.stdin.on("data", chunk => text += chunk);
    process.stdin.on("end", () => {
      try { process.exit(JSON.parse(text).sourceHash === process.argv[1] ? 0 : 1); }
      catch { process.exit(1); }
    });
  ' "$EXPECTED_HASH"
}

if ! analyzer_matches_sources; then
  # Force the producer past its sidecar cache when the executable disagrees.
  rm -f "$STAMP"
fi

echo "This worktree's singz-analyze (ccache makes a sibling's build cheap):"
if ! "$WT/scripts/vendor-analyze.sh" "$TARGET"; then
  echo "FATAL: analyzer build failed. Install CMake and a C++ toolchain, then rerun scripts/worktree-setup.sh." >&2
  exit 1
fi
if ! analyzer_matches_sources; then
  echo "FATAL: $ANALYZER does not match this checkout ($EXPECTED_HASH). Worktree setup is incomplete." >&2
  exit 1
fi
echo "  analyzer verified: $EXPECTED_HASH"

if [ "$MODE" = --desktop-only ]; then
  echo "Worktree ready: desktop dependencies, Git review hook, and host analyzer verified. Mobile was not provisioned."
elif [ "$(uname)" = Darwin ]; then
  echo "Worktree ready: desktop/mobile dependencies, Git review hook, host analyzer, and iOS Pods verified."
else
  echo "Worktree ready: desktop/mobile dependencies, Git review hook, and host analyzer verified. iOS Pods require macOS."
fi
echo "Optional lyrics engines, splitter packs, and capture addon must be built/validated separately when needed."

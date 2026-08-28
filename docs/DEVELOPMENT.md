# Developing SingZ

## Setup

```bash
npm install
scripts/vendor-whisper.sh      # once per machine (needs cmake)
scripts/build-onnx-pack.sh     # splitter pack for win32-x64 / darwin-x64
npm run dev
```

Local clang builds pick up **ccache** automatically when it is installed
(`brew install ccache`): `vendor-whisper.sh` and `npm run android` export
CMake's compiler-launcher env (the mechanism the Android CI uses), and the
iOS Podfile turns on React Native's `ccache_enabled` wrappers at pod install.
No setup step — the settings ride with the build, never with the machine.

**Sharing the cache across worktrees takes more than one cache dir.** The dir
already is shared (`cache_dir` is per-user, nothing to pass), but CMake and
Xcode compile with absolute paths, and `-g` hashes the working directory too,
so a second checkout hits *nothing* in it — measured 0% of a real CMake Debug
build, and 5.6% overall on this machine before the fix. Two settings fix it,
and both are needed for Debug builds (`base_dir` alone was still 0%):

| Setting | Why |
|---|---|
| `base_dir` = this checkout's root | hashes paths under it relative, so worktrees agree |
| `hash_dir = false` | drops the CWD from `-g` compilations |
| `compiler_check = content` | survives an Xcode/CLT update re-stamping clang (unrelated to worktrees, cheap) |

They are passed **per build, never written to the machine's ccache config**:
`vendor-whisper.sh` exports them, `run-with-ccache.js` puts them in the child
env, and `mobile/scripts/ccache-xcode-conf.js` appends them to react-native's
`scripts/xcode/ccache.conf` at postinstall — that last one because RN's
`ccache-clang.sh` sets `CCACHE_CONFIGPATH` to that file, which *replaces* the
machine's config (so `ccache --set-config` never reaches a pod build), and a
build started from Xcode.app inherits no shell env either. It lives in
`node_modules`, so it is disposable and re-applied by every `npm ci`.

The cost of `hash_dir = false`: a reused object carries the debug info of
whichever worktree compiled it first, so lldb may open a sibling's copy of a
source file — invisible while they agree, confusing when they differ. Drop
`CCACHE_NOHASHDIR` (or the conf line) if you are stepping through native code
in two diverged worktrees at once.

Running `mobile/android/gradlew` directly instead of `npm run android`? Prefix
`CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache
CCACHE_BASEDIR=$PWD/../.. CCACHE_NOHASHDIR=1`.

A system `demucs` (pipx) is the easiest dev splitter — the app auto-prefers
it and no pack is needed. Otherwise build/install the pack for your platform:
`scripts/build-gpu-pack.sh` (Apple Silicon torch/MPS) or
`scripts/build-onnx-pack.sh darwin-x64|win32-x64` (~10 min cold each; both
embed the htdemucs_6s model and stamp `python/pack.json` with the format
version the app requires).

## Worktrees

Every parallel feature gets its own worktree (`git worktree add
.claude/worktrees/<feature> -b worktree-<feature> main`). A fresh worktree
has none of the machine-local, gitignored artifacts — bootstrap it with:

```bash
scripts/worktree-setup.sh                 # desktop + mobile (pods on a Mac)
scripts/worktree-setup.sh --desktop-only  # skip mobile deps + pods
```

It provisions what must be shared from the main checkout
(`mobile/gdrive.config.json` so the baked gdrive-config modules come out
filled instead of EMPTY, `mobile/android/local.properties`, and `vendor/` —
see below), runs `npm ci` in both roots (postinstall bakes configs, patches audio-api,
synthesizes the sample song), restores the electron binary when npm's cache
skipped its postinstall (the "Electron failed to install correctly" launch
error), and pod-installs iOS with a UTF-8 `LANG` — CocoaPods crashes in
non-interactive shells without one. It touches no ccache config: the
cross-worktree settings ride with each build (see above). Build products
(`out/`, `Pods/`, `.gradle/`) stay per-worktree; the global npm / CocoaPods /
ccache caches are what make the second worktree fast (pods ~30 s warm).

`vendor/` is **mirrored, not linked**, and the distinction is the whole
point. Third-party engine builds (whisper-cli, demucs-cli, the splitter
packs) come from `.engines-src/` and downloads, cost minutes, and no branch
of ours changes them — those stay symlinks to main's copies. Our own engine
builds (`singz-analyze`, and `singz-capture.node` once the dsp-graph branch
brings its build script) come from `mobile/native/core`, which is exactly
what a feature branch edits — so the worktree gets an empty slot instead of a
link. `worktree-setup.sh` fills the one it can build, `singz-analyze` (~10 s
with a warm ccache); a slot with no producer on this tree stays empty, which
is still the right answer, because empty degrades to the TS detectors whereas
a link would have run another branch's engine.

It used to link the whole directory, and that is how a sibling worktree's
core reached the main checkout during the v0.19.0 cut: `vendor-analyze.sh`
run in a worktree wrote *through* the symlink into main's slot, and the
desktop spawned that branch's binary — live-input adapter included — for
hours, with `audio-devices-e2e.cjs` exercising the very path it had changed.
Nothing shipped wrong; it was found by hand, days later, because the other
session mentioned the rebuild in passing. When this was written, nine
worktrees on the machine held nine different states of `mobile/native/core`
behind one shared binary that matched none of them.

The safety net for what the mirror cannot reach — a packaged app, an
`$SINGZ_ANALYZE` override, a hand-copied file — is
[Which core am I running?](#which-core-am-i-running) below.

What the mirror leaves behind — the per-artifact links inside `vendor/`, and
the two config links — are still files (symlinks), and a committed `vendor`
symlink once merged into main and clobbered the real `vendor/` on checkout —
`.gitignore`'s old `vendor/` pattern only matched the directory form, and
worktrees branched before that fix still carry the old pattern. (A mirrored
`vendor/` is matched by both spellings, so it is if anything safer than the
link it replaced.) The script therefore also
registers its link names in the shared `.git/info/exclude` (covers every
worktree, any checkout vintage) and aborts if a provisioned path is not
ignored.

`pod install` in a worktree used to rewrite the tracked
`mobile/ios/Podfile.lock` every time — hermes-engine's evaluated podspec
bakes an absolute `HERMES_CLI_PATH` into the file the spec checksum is taken
over, so every checkout fingerprinted an unchanged hermes differently. The
Podfile's `singz_relativize_hermes_cli_path` rewrites it to a
`$(PODS_ROOT)`-relative form, and two checkouts now produce a byte-identical
podspec and the same checksum. **A lockfile that still comes back modified
is news** — read the diff rather than reverting it, and never `git restore`
one that Xcode has a `Pods/Manifest.lock` for: that desyncs the pair and the
next build fails at "[CP] Check Pods Manifest.lock" (re-sync with
`cp Pods/Manifest.lock Podfile.lock`). Note that a Debug simulator build
never exercises `HERMES_CLI_PATH` — react-native-xcode.sh exits before it —
so validating a change to that path needs `FORCE_BUNDLING=1` or Release.

## Which core am I running?

`scripts/analyze-source-hash.sh` is the one definition of "which sources a
`singz-analyze` was built from": a fingerprint over every file under
`mobile/native/core` plus `vendor-analyze.sh` and the hash script itself.
`vendor-analyze.sh` writes it to a `.source-hash` sidecar **and compiles it
into the binary** (`-DSINGZ_SOURCE_HASH`, a generated TU in the build tree),
so the executable answers for itself:

```bash
vendor/darwin-arm64/singz-analyze build-info
```
```json
{"version":1,"sourceHash":"c4dccf49…","pitchDetectVersion":2,"keyDetectVersion":2,"beatDetectVersion":23}
```

At the first `resolveAnalyze()` of a session, `src/main/analyze-provenance.ts`
asks the binary that question, recomputes the tree's own answer, and logs the
comparison. **It only ever logs — it never refuses to run.** A dev machine
legitimately runs a binary built moments ago, and a splitter that stopped
working because a stamp file was missing would be a worse bug than the one
being caught.

| what it finds | level |
|---|---|
| binary's sources == this tree | info — one line naming the hash and the three detector stamps |
| binary's sources != this tree | **error** — names both hashes and says to run `vendor-analyze.sh` |
| binary and its `.source-hash` disagree | **error** — one of the two files is lying about the other |
| nothing states a source | warn — an unstamped build; rebuild to make it answerable |
| no source tree to compare against | info — records what ran, warns about nothing |

That last row is the **packaged app**, and it is deliberate. There is no
checkout in an installed SingZ to hash, and the binary and the app came out
of one CI checkout anyway, so there is nothing that could disagree. What the
packaged app owes is the *record*: on a user's machine the log is the only
evidence there will ever be of which core ran, which is the same reason
`sync-log.jsonl` is replayed at launch. The sidecar ships with the binary
(electron-builder's `singz-analyze*` filter already matches it), so even a
build predating `build-info` names itself in the log.

This exists because the detector stamps cannot cover it. `kPitchDetectVersion`
against the renderer's `PITCH_DETECT_VERSION` catches a binary from before a
stamp bump; it cannot catch a **same-version binary built from different
code**, which is precisely what a parallel worktree produces. Note also that
`.claude/agents/e2e-verifier.md` item 9 has `audio-devices-e2e.cjs` forking
on whether the vendored binary supports native capture — so which binary is
present decides which half of that driver runs, and provenance is a testing
question, not only a correctness one.

## Test suites

| command | covers |
|---|---|
| `npm test` | vitest: the desktop unit suites **and** `tests/roundtrip/` — the real `gdriveSync` writing to a fake Drive and the real phone code reading it back out of the same store |
| `npm run typecheck` | node + web configs, plus `tsconfig.tests.json` over `tests/shared/` (the harness both roots import — vitest transpiles without typechecking, so nothing else checks it) |
| `cd mobile && npx jest` | the phone's Drive protocol, offline fallbacks, ✓ rule and log |
| `cd mobile/android && ./gradlew :app:testDebugUnitTest` | Kotlin's half of the shared cache-currency table |
| `mobile/scripts/test-swift-currency.sh` | Swift's half — swiftc only, no simulator, no Pods |

`tests/shared/` is one fake Drive (`serveRequest` as a pure function, with an
http adapter for the desktop/emulator and a `fetch` adapter for jest), one
reference `FolderAccess` over a temp dir, and fixtures whose md5s come from
hashing real bytes. Two divergent fakes is how a format change on one side
broke no test on the other; the round-trip is what makes each side meet the
other's actual output.

Cases worth keeping green because they were all real: a name that is a syntax
error in Drive's `q` language, a library that does not fit in one page, a run
that dies mid-upload, bytes changed on Drive behind the app's back, a stem
deleted on Drive, a re-split dropping a lane, and a library that has not
arrived yet (which must never be read as "delete everything on Drive").

## E2E testing pattern

The app is verified by driving the real Electron binary with
`playwright-core`'s `_electron` API. Keep drivers out of the repo (temp dir);
the skeleton:

```js
const { _electron } = require('playwright-core')
const app = await _electron.launch({
  executablePath: '<repo>/node_modules/electron/dist/Electron.app/Contents/MacOS/Electron',
  args: ['<repo>/out/main/index.js'],          // or a packaged .app binary
  env: { ...process.env, /* hooks below */ }
})
const win = await app.firstWindow()
await win.setInputFiles('input[type=file]', song)   // same path as drag-drop
```

Rules learned the hard way:

- `npm run build` before driving — drivers run `out/`, not `src/`.
- Driver runs get userData **"Electron"**, dev runs **"singz"**, packaged
  **"SingZ"**: their stem caches are separate. Shared models are not.
- After clicking something that triggers an async re-render, wait for the
  *new* state (e.g. `.variant:has-text(...)`, or a button's label returning to
  idle) — stale rows accept clicks while disabled and the click silently dies.
- Look at every screenshot you take; several real layout bugs were only
  visible there.
- Automated runs are silent: `SINGZ_MUTE=1` on desktop, a zeroed
  `__test.engine.master.gain` on the iOS Simulator, music-stream volume 0
  on the Android emulator (`adb shell cmd media_session volume --stream 3
  --set 0` **followed by twenty `input keyevent 25`** — on an API-36 AVD
  the first command exits within a second and silently applies nothing, so
  the keyevents are what actually mute it; measured in isolation, the
  keyevents alone take streamVolume 2 -> 0 and the documented command alone
  leaves it at 2). Muting changes nothing measurable — analysers, sinkId moves,
  fake-mic pitch and click scheduling all behave as audible. Sound on only
  when a human is checking (end-user testing/demos).

### Environment hooks (test/dev only)

| Variable | Effect |
|---|---|
| `SINGZ_NO_SYSTEM_ENGINES=1` | ignore system demucs — simulate a clean OS |
| `SINGZ_NO_SYNC=1` | no automatic Drive push at all (launch, debounce, sweep) — **every driver on a signed-in machine wants this**, or a test run rewrites the real library's catalog |
| `SINGZ_NO_LAUNCH_SYNC=1` | the older, narrower opt-out: skips only the launch reconcile |
| `SINGZ_SYNC_DEBOUNCE_MS` | shrink the 4 s coalescing window so a driver need not wait for it |
| `SINGZ_GDRIVE_CONFIG` | JSON OAuth config — point the app at a fake Drive (`tests/shared/fake-drive-http.ts`) |
| `SINGZ_USERDATA_DIR` | isolate userData (drivers sharing "Electron" crash each other) |
| `SINGZ_MODELS_DIR` | relocate the shared model cache |
| `SINGZ_PACK_DIR` | relocate the GPU pack install dir |
| `SINGZ_GPU_PACK_URL` | pack download URL (point at a local http server) |
| `SINGZ_FAKE_MIC=1` | Chromium fake audio input for mic-matching tests |
| `SINGZ_MUTE=1` | mute the audio device (Chromium mute-audio) — every automated driver sets it; leave unset only for a human listening |
| `SINGZ_DEMUCS` / `SINGZ_WHISPER` | override engine command |
| `SINGZ_WHISPER_MODEL` | whisper size (tiny/base/small/…, default large-v3-turbo) |

Full clean-OS check (as CI can't do): package with
`npx electron-builder --mac --dir`, then drive
`dist/mac-arm64/SingZ.app/Contents/MacOS/SingZ` with
`SINGZ_NO_SYSTEM_ENGINES=1` + fresh `SINGZ_MODELS_DIR`/`SINGZ_PACK_DIR` —
the setup wizard must appear, download the pack for real, and a split must
produce six stems (guitar/piano lanes hide on songs without them).

## Releasing

1. Bump `package.json` version (artifact names use it).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI (`.github/workflows/build.yml`) builds mac arm64+x64 dmg, win x64 NSIS,
   compiles whisper-cli and all three splitter packs, ad-hoc signs mac bundles
   (`scripts/afterPack.cjs`), and attaches everything to the GitHub Release
   via `gh` (nullglob per-platform file lists; create/update race-safe).

Engine builds are cached on the vendor scripts' content hash (editing a script
forces a clean rebuild); source trees have their own cache. Keep releases
public: the in-app pack URLs are
`releases/latest/download/gpu-splitter-<platform>-<arch>.tar.gz`.

### Splitter packs

There is no bundled splitter — every platform downloads its pack on first
run. `scripts/build-gpu-pack.sh` builds the Apple Silicon torch/MPS pack;
`scripts/build-onnx-pack.sh <target>` builds the demucs-onnx packs
(win32-x64 with onnxruntime-directml, darwin-x64 with CPU onnxruntime).
Pack tarballs must contain no symlinks in the model cache (Windows tar
can't extract them without admin rights) — the script materializes and
asserts this, then re-verifies the cache resolves fully offline.

The torch pack's python deps are pinned (torch/demucs/sphn/numpy — no
torchaudio: unused by demucs 4.1, and its IO needs torchcodec since 2.9).
The build ends with a smoke split of a generated mp3 under
`PATH=/usr/bin:/bin` + `HF_HUB_OFFLINE=1`, so CI fails rather than ship a
pack that cannot split on a machine without homebrew or network.

### Signing status

Builds ship ad-hoc signed (mac) / unsigned (win). To sign for real: remove
`identity: null` from electron-builder.yml, add `CSC_LINK`/`CSC_KEY_PASSWORD`
(+ `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for notarization)
as CI secrets — the afterPack hook steps aside automatically. Windows options:
Azure Trusted Signing (`win.azureSignOptions`) or SignPath's OSS tier.

## Renderer performance rules

Field laptops (QHD+ panel + weak iGPU) taught these; keep them:

- Every rAF loop must be **change-gated** (write DOM/canvas only when the
  value actually changed) and **skip work under `body.modal-open`** — any
  pixel change behind a modal re-rasters the whole blurred backdrop.
- No infinite CSS animation without a `body.modal-open … animation-play-state:
  paused` rule (see the shimmer/pulse block in styles.css).
- Windows uses a solid modal scrim (no backdrop-filter) — keep it that way.
- The pitch strip repaints only when position/view/size/transpose/melody/mic
  trail change; idle karaoke must stay at ~0% GPU.

## Ideas parked for later

- demucs-mlx as the Apple Silicon pack: ~2.6× faster than torch/MPS and much
  smaller; would also make an htdemucs_ft quality tier cheap.
- htdemucs_ft quality mode (4-stem only upstream; ~4× slower, measured 38 s vs
  11 s per song on M-series).
- RMVPE as an optional premium melody tracker (evaluated: best-in-class
  recall; pYIN port ties it for free, so shelved — infer script exists).
- DirectML adapter targeting for Optimus laptops (proven manually via Windows
  per-app Graphics preference; needs a device_id ladder in the pack shim).
- A–B loop for phrase practice; export karaoke mix to file.
- Whisper model picker in the model manager UI.

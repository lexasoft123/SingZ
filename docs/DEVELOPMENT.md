# Developing SingZ

## Setup

```bash
npm install
scripts/vendor-llama.sh        # llama-server, the lyrics recogniser — once per machine (needs cmake)
scripts/vendor-crispasr.sh     # crispasr, its word aligner — once per machine (needs cmake)
scripts/build-onnx-pack.sh     # splitter pack for win32-x64 / darwin-x64
npm run dev
```

The desktop capture *addon* is a stable Node-API module built explicitly for
the Electron version installed in `node_modules`. It is the in-process
transport for the shared `AudioInput` core. Karaoke mic matching still captures
via `getUserMedia` (echo cancellation intact), and vocal training talks to the
same core through the spawned `singz-analyze` session (`src/main/audio-input.ts`).
The experimental headphone monitor is app-shell owned: Settings configures its
device, channels, gain and native DSP graph, while the persistent top bar keeps
its status and Stop control available after Settings closes. It transfers
exclusive output ownership from Web Audio before opening the native graph, and
restores Web Audio readiness without resuming the song when monitoring ends.
Swapping karaoke or vocal training capture onto the addon remains a deliberate
future step, not a side effect of building it:

```bash
npm run capture:addon                    # current platform/architecture
npm run capture:addon -- darwin-arm64   # release inputs on macOS
npm run capture:addon -- darwin-x64
npm run capture:addon -- win32-x64      # on Windows
npm run capture:verify                  # load + compiled identity check
npm run dist                            # host package; builds/verifies addon
npm run dist -- --mac --x64             # cross-architecture package input
npm run dist -- --mac --universal       # builds arm64 + x64 capture inputs
```

The script downloads Electron headers into ignored `.engines-src/`, builds
with CMake under ignored `build/capture-<target>`, and publishes an immutable,
content-addressed runtime artifact under this checkout's ignored
`build/capture-runtime/<target>/<source-fingerprint>/<artifact-sha>/<generation>/`.
The artifact carries a source sidecar, raw SHA-256 sidecar and manifest. Mac
manifests also seal a signature-invariant canonical Mach-O digest: signatures
are removed on a private copy, only codesign-owned `__LINKEDIT` virtual size is
normalized, and meaningful thin/fat slices are hashed by CPU identity;
`current.json` selects that exact immutable generation. A corrupt generation is
never overwritten (especially important for a loaded Windows DLL): rebuilding
publishes a fresh path, validates its Mach-O/PE architecture, then moves the
selector. The builder fingerprints the source tree again after CMake and before
selector publication, aborting if an edit raced the build. Capture never publishes into `vendor/`: that
directory is shared by all worktrees, while `build/` is deliberately local.
The app independently fingerprints this checkout's native inputs and only
resolves the matching immutable path, so another worktree cannot redirect it.

Each build also prepares a coherent per-worktree packaging snapshot under
`build/capture-package/<target>/`. `electron-builder` copies that snapshot
outside the asar beside the engines, including its manifest and both sidecars.
The `dist.cjs` wrapper interprets builder platform/architecture flags, builds
every requested capture target, verifies every checksum/manifest, load-smokes
the host architecture inside Electron, then forwards the original flags. This
is why release workflows call `npm run dist -- ...`, not electron-builder
directly. Input/config/prepackaged overrides and ambiguous combined or valued
target flags are rejected because they could make electron-builder package a
different project, extraResources set or architecture than the addon wrapper
verified. Cross-architecture Mac builds are supported; cross-OS builds are
rejected until the project has a real toolchain (`--win` runs on Windows and
`--mac` on macOS). A local universal package also needs the pre-existing engines
(`singz-analyze`, and `llama-server`/`crispasr` for lyrics) for both Mac
architectures; the release workflow prepares those before
calling the wrapper. The wrapper lipos both capture slices first and gives each
temporary app the same addon and identity evidence; ad-hoc signing is deferred
until electron-builder has merged the final universal bundle. A plain
system-Node load is not the ABI gate.

macOS signing rewrites the nested addon's Mach-O signature bytes after the
package snapshot's SHA-256 was written. Development, environment overrides,
Windows and every pre-package snapshot therefore require exact raw SHA-256.
Only the default addon inside a packaged macOS app may differ: its sidecars
must still exactly match the validated manifest, `codesign --verify --strict`
must accept the transformed Mach-O, its canonical digest must equal the sealed
manifest digest, and the loaded addon's compiled Electron and source identity
must match the manifest. A new self-consistent ad-hoc signature is therefore
not evidence for changed code. The package E2E deliberately
removes and recreates the nested signature, reseals the app, proves the raw
bytes changed, and load-smokes that narrow path; it then changes a compiled
source-stamp byte, re-signs again, and proves canonical verification rejects it
before native code loads.

Package snapshots have one writer per checkout. This is the same repository
rule that requires parallel sessions to use separate worktrees; the publisher
does not add a stale lock. It validates a per-process staging directory, moves
the last good snapshot aside, and restores it if installation fails. Old
runtime generations are pruned only after a seven-day grace while retaining
the eight newest; `current.json` is never removed, macOS mappings reported by
`lsof` are skipped, and Windows skips all generations while `tasklist` reports
any loaded capture addon. Abandoned staging/backup directories are pruned
best-effort.

Any metadata, checksum, or `require()` failure happens before a native binding
is returned and may be retried after rebuilding. Only a successfully returned
binding whose compiled Electron/source identity is wrong is cached and requires
a restart. The loader reads the selected addon once, stages those exact bytes
under a cryptographically random process-private temporary `.node` path, and
hashes, code-signature/canonical-checks and `require()`s that one stable path.
A selector/source replacement after the read therefore cannot change executed
bytes, and every retry gets a new require-cache identity. Pre-load validation
or `require()` failure removes the private attempt; once native loading returns,
the path is retained (even if compiled identity is then refused) for the
process lifetime because Windows may keep the DLL mapped. Bounded stale cleanup
removes only old, strictly named, same-owner directories whose recorded PID is
confirmed dead; every live PID (including another worktree's SingZ) is preserved.
`SINGZ_CAPTURE_ADDON=/absolute/file.node` overrides the selected path
for diagnostics only; it does not bypass identity checks. The file must match
this checkout (in development) and carry its own matching
`singz-capture.manifest.json`, `.source-hash` and `.sha256` files beside the
override. On Windows,
Electron's `node.lib` still names `node.exe`, so the CMake target must retain its
delay-load hook and `/DELAYLOAD:node.exe`; a hard `node.exe` PE dependency loads
in Node but fails before module initialization in `electron.exe`.

The zcore host scripts key their temporary CMake directories on a hash of the
complete checkout path, not its basename; two unrelated `foo` checkouts cannot
reuse one CMake cache.

Local clang builds pick up **ccache** automatically when it is installed
(`brew install ccache`): `vendor-llama.sh`, `vendor-crispasr.sh` and `npm run android` export
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
`vendor-llama.sh` and `vendor-crispasr.sh` export them, Android's all-project CMake prelude installs
one env-carrying compiler launcher (`run-with-ccache.js` also puts the settings
in the child env), and `mobile/scripts/ccache-xcode-conf.js` appends them to
react-native's
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

Running `mobile/android/gradlew` directly instead of `npm run android` is also
cached: `mobile/scripts/android-cmake-init.cmake` is injected into the app and
every native React Native dependency and applies the same checkout root,
`hash_dir = false` and compiler-content identity without changing machine
configuration. `org.gradle.workers.max=1` serializes AGP worker actions so
native dependency modules cannot overlap. The one active Ninja graph gives
compile and link edges one shared eight-process ceiling: four edges when
ccache is present on POSIX because both ccache and the compiler match
`ps ... | grep clang`, two on Windows where the PowerShell launcher remains
resident too, otherwise eight. The POSIX launcher `exec`s ccache so it adds no
third process line. ABIs and dependency modules therefore cannot multiply into
dozens of simultaneous clang lines. We still run only one native build at a
time across worktrees because separate Gradle processes cannot share a
project-level worker limit.

### Target-executed mobile codec proof

The full custom-track codec promise is not certified by inspecting FFmpeg's
configure string. Each mobile target executes the committed twelve-file corpus
through the packaged zcore descriptor decoder, then hashes the actual loaded
runtime, target binary, fixture bytes, selection receipt and exact normalized
case output. Canonical inputs and expectations live in
`tests/fixtures/codecs/{data,target-contract.json,target/}`. A normal app build
contains neither the proof runner nor its fixtures.

This is a serialized native gate. Before either command sequence, ensure no
other native build is running; while it runs, sample
`ps wuax | grep '[c]lang' | wc -l` and stop immediately above eight. Android's
single Gradle worker and iOS `-jobs 4` retain the shared ccache policy described
above.

For one Android ABI, stage the configuration-only pack only into the explicit
proof build, run just the proof instrumentation, and pull its target-written
evidence:

```bash
cd mobile/android
./gradlew --no-daemon --max-workers 1 \
  -Dorg.gradle.java.home=/opt/homebrew/opt/openjdk@21/libexec/openjdk.jdk/Contents/Home \
  -PreactNativeArchitectures=arm64-v8a -PsingzCodecTargetProof=true \
  -Pandroid.testInstrumentationRunnerArguments.class=com.singzplayer.CodecTargetProofInstrumentedTest \
  :app:connectedDebugAndroidTest
cd ../..
node mobile/scripts/pull-codec-target-proof-android.mjs \
  --serial emulator-5554 --target android-arm64-v8a \
  --output build/codec-proof/android-arm64-v8a.raw.json
node scripts/create-target-codec-proof-receipt.mjs \
  --target android-arm64-v8a \
  --evidence build/codec-proof/android-arm64-v8a.raw.json \
  --output build/codec-proof/android-arm64-v8a.receipt.json
```

The proof Gradle task itself exports `SINGZ_CODEC_TARGET_PROOF=1` and invokes
the selector/verifier with `--proof-staging --require-android-set <ABI>`. It
requires exactly one configured ABI and refuses any task graph containing a
Release task.

Use the actual serial and matching ABI; repeat per ABI. As with every emulator
driver, confirm the installed package is debuggable and its APK matches this
tree before interpreting the result. Never install that debug APK over the
user's same-application-id phone.

For iOS, first compose the three verified slice packs into real dynamic
framework XCFrameworks. Each `libav*` framework owns an
`@rpath/libav*.framework/libav*` install name and framework-form dependencies;
raw-dylib XCFrameworks are invalid here because CocoaPods cannot embed them in
SingZ's otherwise-static React Native/Fabric/SingzCore/ORT Pods graph. The
composer verifies the device and universal-simulator architectures, platform
load commands, install names, dependency closure, headers and modules before
publishing the immutable pack. Do not set `USE_FRAMEWORKS`: ONNX Runtime is a
static XCFramework and target-wide dynamic Pods are not a coherent graph.

Materialize the canonical proof sources/resources before the opt-in Pod
install, select the XCFramework only in proof-staging mode, then build one
exact simulator/device target:

```bash
SINGZ_CODEC_TARGET_PROOF=1 node scripts/compose-ffmpeg-ios-xcframeworks.mjs \
  --proof-staging
node mobile/scripts/prepare-codec-target-proof.mjs
SINGZ_CODEC_TARGET_PROOF=1 node mobile/scripts/select-ffmpeg-codec-runtime.mjs \
  --proof-staging --require-ios
cd mobile/ios
LANG=en_US.UTF-8 SINGZ_CODEC_TARGET_PROOF=1 pod install
xcodebuild -workspace SingZPlayer.xcworkspace -scheme SingZPlayer \
  -configuration Debug -destination 'id=<SIMULATOR-OR-DEVICE-UDID>' \
  -jobs 4 build
cd ../..
DEVICE_NAME='<exact Metro deviceName>' METRO_PORT=8081 \
  node mobile/tests/codec-target-ios.cjs \
  build/codec-proof/ios-arm64.raw.json
node scripts/create-target-codec-proof-receipt.mjs \
  --target ios-arm64 \
  --evidence build/codec-proof/ios-arm64.raw.json \
  --output build/codec-proof/ios-arm64.receipt.json
```

Use `ios-simulator-arm64` or `ios-simulator-x64` for simulator evidence. The
driver requires an exact `DEVICE_NAME` (or `SIM_UDID`) and refuses Metro's
first arbitrary target. Device installation/signing remains a separate step;
the receipt creator will reject evidence whose architecture/target disagree.

`--proof-staging` is accepted only with `SINGZ_CODEC_TARGET_PROOF=1` and writes
a selection receipt marked `target-proof-staging`; ordinary/release verification
must reject that receipt. Only the promoted format-2 receipt can satisfy the
pack/XCFramework `--require-full` gate. That promotion preserves the manifest
that was actually executed, avoiding a circular hash when the receipt is
attached to the final immutable pack.

**The extended codecs are opt-in, and an ordinary build is the base decoder.**
Every consumer of the packs — `mobile/scripts/select-ffmpeg-codec-runtime.mjs`
and its verifier (run by the Android `preBuild` tasks and the iOS Podfile),
the Android CMake, the `SingzCore` podspec and `scripts/build-capture-addon.cjs`
— reads `SINGZ_FFMPEG_CODECS`:

- `auto` (the default, and what CI runs with no pack at all): a target's pack
  is selected and linked only when it carries full target fixture evidence.
  Otherwise RNAudioAPI keeps its own compatibility `libav*`, zcore compiles
  without `SINGZ_ZCORE_FFMPEG`, and the native session reports the base
  `wav-flac-v1` capability, which both the desktop renderer and the phone
  facade already accept: WAV/FLAC lanes play natively and other custom-track
  codecs stay on the legacy engine. A configuration-only pack is never linked,
  so the capability a build claims is exactly what was decoded on that target.
  On Android the selection is all-or-nothing across the shipping ABI set — one
  APK carries one codec capability.
- `required`: the pre-existing fail-closed behaviour, for a release lane that
  must ship the full matrix; a missing or unproven pack stops the build.
- `off`: never select a pack, even a proven one.

The first selection on a fresh dependency moves RNAudioAPI's original bytes to
`node_modules/react-native-audio-api/.singz-compatibility-runtime/`, and a
later run that selects nothing restores them and drops the receipt, so
switching a machine between proven and base builds needs no network. A
dependency that was replaced before that copy existed (a proof-staging install
from before this rule) cannot be restored offline; the selector says so and
points at `scripts/worktree-setup.sh`, which re-downloads the prebuilt
binaries. The Gradle `-PsingzCodecTargetProof=true` harness and
`SINGZ_CODEC_TARGET_PROOF=1 pod install` are `required`-strict regardless of
the variable: the proof has to execute the staged pack it is proving.

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
non-interactive shells without one.

Three of its steps exist for RE-RUNS rather than fresh worktrees, which is
the case that matters: re-running is how a worktree catches up after a
rebase, and each of these is a way its build state can lag its source.

- It **re-downloads react-native-audio-api's prebuilt binaries**, which
  `npm ci` deletes and nothing else restores — they are not in the npm
  tarball, and the podspec's `prepare_command` fetches them only when
  CocoaPods integrates the pod for the FIRST time. This runs BEFORE
  `pod install`, because CocoaPods records only the vendored frameworks
  present at install time and the other order dies in `ld` with undefined
  `_av_*` symbols. It **asserts the files arrived**: the vendor's downloader
  `continue`s past a failed curl and still exits 0, so its status proves
  nothing.
- It **fails if `mobile/ios/SingzCore/core` does not match
  `mobile/native/core`** byte for byte. That mirror is a gitignored copy
  (CocoaPods drops globs reaching above the podspec and skips directory
  symlinks), synced by mobile's postinstall; a worktree that skipped one
  keeps building the stale copy and the failure names a missing header.
- It **fails if the Pods sandbox still disagrees with `Podfile.lock`** after
  installing — the "sandbox is not in sync" archive error, seen from here
  instead of from xcodebuild ten minutes later.

It touches no ccache config: the
cross-worktree settings ride with each build (see above). Build products
(`out/`, `Pods/`, `.gradle/`) stay per-worktree; the global npm / CocoaPods /
ccache caches are what make the second worktree fast (pods ~30 s warm).

`vendor/` is **mirrored, not linked**, and the distinction is the whole
point. Third-party engine builds (llama-server, crispasr, the splitter
packs) come from `.engines-src/` and downloads, cost minutes, and no branch
of ours changes them — those stay symlinks to main's copies. Our own engine
builds (`singz-analyze` and `singz-capture.node`) come from the shared
`zcore`/`zdsp` tree, which is exactly what a feature branch edits — so the
worktree gets an empty slot instead of a link. `worktree-setup.sh` builds
`singz-analyze` (~10 s with a warm ccache); the capture addon stays empty until
`npm run capture:addon` builds it for the current Electron/platform. An empty
slot is the right answer because the app can fall back or report the missing
transport, while a link would silently run another branch's engine.

It used to link the whole directory, and that is how a sibling worktree's
core reached the main checkout during the v0.19.0 cut: `vendor-analyze.sh`
run in a worktree wrote *through* the symlink into main's slot, and the
desktop spawned that branch's binary — live-input adapter included — for
hours, with `audio-devices-e2e.cjs` exercising the very path it had changed.
Nothing shipped wrong; it was found by hand, days later, because the other
session mentioned the rebuild in passing. When this was written, nine
worktrees on the machine held nine different states of the native core behind
one shared binary that matched none of them.

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
`zcore`, `zdsp`, `third_party/native`, `tools/native` and `cmake`, plus the
root `CMakeLists.txt`, `vendor-analyze.sh` and the hash script itself.
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
| `node tests/e2e/capture-artifact-rebuild.cjs` | corrupts the ignored current capture artifact, proves the builder detects/repairs it, and restores the original bytes if repair fails |
| `cd mobile && npx jest` | the phone's Drive protocol, offline fallbacks, ✓ rule and log |
| `cd mobile/android && ./gradlew :app:testDebugUnitTest` | Kotlin's half of the shared cache-currency table |
| `mobile/scripts/test-swift-currency.sh` | Swift's half — swiftc only, no simulator, no Pods |
| `mobile/scripts/test-swift-project-paths.sh` | Swift's half of `tests/shared/project-name-cases.json` — how a phone-added song's folder is named (no leading dot: iOS lists the library without hidden folders) and which project paths are refused; Kotlin runs it in `ProjectPathsTest`, vitest against the reference writer and the desktop's own `safeName` |
| `bash mobile/scripts/test-native-playback-bridge-schema.sh` | the iOS bridge's request/result validators — one `clang++` call over the real `.mm` sources, no Xcode, no Pods, no simulator; run by the iOS native canary |
| `bash zdsp/run-sanitizer-gates.sh` | the native gate, three presets (strict, asan/ubsan, tsan): the playback session and its two injected-failure runs, the bridge-contract test against `tests/shared/`, the graph and analysis suites, the realtime-source policies. What each preset runs is the `filter.include.name` regex in `CMakePresets.json` — a new `add_test` is NOT picked up until it is added there and to the build preset's `targets`, which is why `playback_cue_plan_tests` still runs only under the unfiltered Windows job |

The three-language agreement fixtures under `tests/shared/` are read by more
than one of these at once — `native-playback-bridge-manifest.json` by jest,
vitest and ctest; `native-playback-agreement-cases.json` and
`playback-cue-cases.json` by vitest and ctest; `currency-cases.json` by
vitest, Kotlin and Swift. Editing one means running every runner that reads
it, not the nearest one. What each pins is
[docs/NATIVE-PLAYBACK-BRIDGE.md](NATIVE-PLAYBACK-BRIDGE.md).

### Mutation-checking a native test (the stale-object trap)

A new test in `tests/native/` is not finished until the code it covers has
been broken and the test seen going red. The trap on this machine is that the
rebuild can silently not happen: Apple's `make` compares whole-second mtimes,
so `touch`ing the source is **not** enough when the object file was written in
the same second — which is exactly what happens when you restore the original
immediately after a mutation run and rebuild straight away. The binary keeps
the mutation, the suite fails, and the obvious reading ("my restore was
wrong") is the wrong one. It cost a confusing red during the Phase 4 lane-peaks
work, on a source that `git diff` said was clean.

Delete the object instead of relying on the timestamp:

```bash
rm -f build/phase4-tests/CMakeFiles/singz_native_playback_session.dir/native/playback/native_playback_session.cpp.o
```

The same hazard runs the other way — a mutation that never reached the binary
reports a **pass** — so when a mutation comes back green, delete the object and
run it again before believing it. `shasum` the test binary either side, or use
the `build/p4-gate-inner.sh` freshness assertions (`test <binary> -nt
<source>`), which exist for this.

**A green mutation means "look again", and twice out of three times the answer
was not the code.** All three were found in one session:

1. The rebuild did not happen (above). The same thing bites at the END of a
   mutation loop: if the final restore-and-rebuild is not checked for a
   non-zero exit, a build that fails leaves the LAST MUTATION'S binary in
   place, and the "restored" run reports that mutation's failure as though the
   original code were broken. Check the exit status of every build in the
   loop, including the restore.
2. **The mutation landed somewhere else.** A text anchor that matches several
   functions edits the first one. `if (generation == 0 || generation !=
   impl_->generation || ...)` appears in `stop`, `unload` and `lanePeaks`, so a
   patch aimed at one silently mutated another — and reported a pass for a
   function it never touched. Anchor on something unique to the target (a
   neighbouring line from that body), and `grep -c` the pattern first.
3. **The test masked its own subject.** A stale-generation sweep probed
   `stop(g)` first, and `stop` advances the cancellation epoch to `g` before
   anything else reads it — so every later probe was refused by the epoch
   rather than by the generation check under test, and deleting that check
   changed nothing. When a mutation of a compound guard survives, check
   whether an earlier line of the test already satisfies one of the other
   terms.

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
- `npm run build` and `npm run dev` never install, so after a pull that moved
  `package-lock.json` (a new `@singz/ui` pin, most often) run `npm ci` first.
  Both refuse to start on a `node_modules` that is not the lockfile's
  (`scripts/check-installed-deps.cjs`: every installed `package.json` must
  carry the version the lockfile records, and npm's install record must agree
  on the source where it describes those same files);
  `SINGZ_ALLOW_STALE_DEPS=1` builds anyway, for a package put there by hand at
  another version on purpose (a locally built kit, tried before its tag).
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
| `SINGZ_DEMUCS` | override the splitter engine command |
| `SINGZ_LLAMA_SERVER` | override the llama-server binary Qwen3-ASR runs through |
| `SINGZ_CRISPASR` | override the crispasr binary the Qwen word aligner runs through |
| `SINGZ_LANG` | `en` / `ru` / `zh-CN` / `system`: the UI language for this run, over the saved choice. Unset, a `SINGZ_E2E_HIDDEN=1` run is English — drivers find controls by their English text, and the Windows field laptop is a Russian-locale machine. A pick from the title-bar flag during the run still wins |
| `SINGZ_QWEN_OFFER=1` | let the once-only Qwen3-ASR launch offer appear in a hidden (`SINGZ_E2E_HIDDEN=1`) driver run, which otherwise suppresses it — for the driver that tests the offer |

Full clean-OS check (as CI can't do): package with
`npm run dist -- --mac --arm64 --dir`, then drive
`dist/mac-arm64/SingZ.app/Contents/MacOS/SingZ` with
`SINGZ_NO_SYSTEM_ENGINES=1` + fresh `SINGZ_MODELS_DIR`/`SINGZ_PACK_DIR` —
the setup wizard must appear, download the pack for real, and a split must
produce six stems (guitar/piano lanes hide on songs without them).

### The lyrics engine (Qwen3-ASR)

Qwen3-ASR is the app's only lyrics engine; whisper is gone — binary, model,
vendor script and env vars alike. Every path that listens to a song goes
through it: transcribing a song LRCLIB has nothing for, Check & align, and the
lyrics editor's align-draft. Two engines and one model tile sit behind it —
Qwen3-ASR 1.7B through llama.cpp's `llama-server` (`scripts/vendor-llama.sh`)
for the words, and Qwen3-ForcedAligner 0.6B through CrispASR
(`scripts/vendor-crispasr.sh`) for their times. llama.cpp carries only the
ASR model, which is why the aligner is a second runtime rather than another
flag. Both binaries ship inside the app (`SINGZ_LLAMA_SERVER` /
`SINGZ_CRISPASR` override them), so a missing one is a broken build, and the
app says so: every Transcribe and Check & align answers "The lyrics engine is
missing from this build" (`needsEngine`).

The Precise tier is a different thing and did not change: MMS CTC forced
alignment through the splitter pack (`align-mms.ts`) — it never was whisper. A
transcription uses it too. Qwen hears the words, and Precise times them when
it is installed (the timing the app treats as reference); Qwen's own aligner
takes over when it is not, or when Precise places under a quarter of the
words.

Why Qwen, measured over the whole 23-song catalog on 2026-09-17 against
whisper large-v3-turbo with the app's own flags:

| | with lyrics | no lyrics | invented phrases |
|---|---|---|---|
| whisper turbo | WER 0.211 | WER 0.278 | 55 |
| Qwen3-ASR 1.7B | WER 0.162 | WER 0.167 | 0 |

The gap is widest exactly where transcription lives: whisper decided a song's
language from its first 30 s, so an organ or drum intro sent three catalog
songs into the wrong language entirely (0%, 50% and 67% of their words heard;
one came back as Russian «Продолжение следует…»). Qwen heard 88-99% of the
same three.

And it is the FASTER engine where speed matters most: on the Windows field
laptop (4-core Haswell) Qwen took 0.82x the song's length against whisper's
1.91x — no GPU is involved on either engine there, because llama.cpp's Vulkan
backend needs Vulkan 1.2 and that machine's GPUs top out at 1.1 (Kepler) or
have no Windows Vulkan at all (Haswell).

Check & align works like this: the recogniser is asked about each sung chunk,
the answer says which lyric words belong to which chunk (the existing
`globalAnchors` matcher), and the aligner then times each chunk's own words.
Measured over the 19 catalog songs whose Precise timing is stored, against
the whisper tier it replaced:

| | Qwen ASR + Qwen aligner | whisper tier |
|---|---|---|
| systematic offset | −0.04 s | +0.17 s late |
| median error | 0.08 s | 0.19 s |
| within 0.10 s | 55% | 30% |
| within 0.50 s | 80% | 86% |
| phrase onsets within 0.15 s | 65% | 45% |

Better on 17 of the 19, and behind in the far tail on two: a recording every
engine mishears, and one whose verses repeat so closely that a word can be
matched to the wrong repetition — the price of a recogniser that reports no
times of its own. Lines the recogniser could not hear are dropped from the
anchors and carried by the lyrics' own phrasing, which is the app's existing
rule and what keeps those two songs from being timed against the wrong bars.

**The model is one tile.** `qwen-asr` in the model manager ("Speech model ·
lyrics", 3,511 MB) is three files: `Qwen3-ASR-1.7B-Q8_0.gguf` (2,165 MB), its
audio encoder `mmproj-Qwen3-ASR-1.7B-Q8_0.gguf` (356 MB) and
`qwen3-forced-aligner-0.6b-q8_0.gguf` (990 MB). The recogniser hears words
but tells no time, so a singer holding only one of the two could use neither —
and the separate aligner tile this replaced invited exactly that. A download
keeps any part that already arrived, so a multi-GB install that dies on its
last file does not refetch the first two on retry; only Reinstall refetches
everything. Q8_0 is what ggml-org publishes, and over the catalog it scored
identically to bf16.

**Who is asked, and when.** A machine that has a whisper model (`ggml-*.bin`
in the shared models folder) and no complete Qwen gets ONE offer at launch:
the model manager opens with the Qwen tile highlighted and a line saying why,
and nothing downloads until Get. It never lands on top of a required download
— a launch that needs the splitter asks about that alone, and the offer waits
for the next one. It is recorded as seen the moment it is shown
(`qwenOfferDismissed` in settings.json) and never repeats. Everyone else is
asked the ordinary way: the consent card on the first Transcribe or Check &
align, quoting what is still missing of the three parts.

**The whisper model goes, but only once Qwen can replace it.** Every
`ggml-*.bin` (and its `.part`) in the models folder is deleted once all three
Qwen parts are on disk — at startup and after any Qwen install, whichever way
it arrived (model manager or consent card). Never before: until then a singer
who postponed the download has lost nothing. The pattern is safe because
nothing else there is named that way any more (demucs.cpp's ggml model was
already swept as obsolete), and it deliberately catches sizes the old
downloader never fetched — a 3 GB large-v3 left behind by an old
model-override run was found on a dev machine.

**What Qwen heard is cached per song**, as `heard-words.json` in the song's
cache dir (it replaced `whisper-words.json`). A re-align — switching the
lyrics variant, aligning an edited draft — skips the listen and goes straight
to the aligner, and the Precise tier uses its words as the text check that CTC
scores cannot give on singing. It is keyed to the vocals file's size and mtime
(2 ms tolerance, as in the sync ledger), because separating backing vocals
REWRITES that file: a listen to the old combined vocal would check new lyrics
against a voice that is no longer in it.

**Stored lyrics still say `source: 'whisper'`** for anything transcribed on
the device — the label means "transcribed here", lyrics.json, Drive and the
phones all read it, and renaming it would strand installed phones (see
`CLAUDE.md`). `engine: 'qwen3-asr-1.7b'` beside it says which recogniser it
was, and `AlignMethod` keeps `'whisper'` only so older lyrics.json files read.

**The release build must ship both engines, and says so without taking the
splitter down.** `build.yml` vendors them LAST in the engine step and a
failure there stays non-fatal (an `::error::` annotation), because that step
also builds the splitter packs and the in-app pack URL is
`releases/latest/download` — a job dying there would publish a release with
no pack and 404 the splitter for the whole fleet, on every app version. The
job's final step, "Lyrics engines shipped", runs after the packs are attached
and fails the run if `llama-server` or `crispasr` is missing for any target.

Four things are worth knowing before touching this code:

- **It hears words but tells no time.** Nothing it transcribes lands until an
  aligner has timed it — Precise when installed, Qwen's own otherwise — since
  provisional chunk timing is not karaoke. That is also why the recogniser and
  its aligner are one download: there is no whisper left to fall back to.
- **Everything goes through `vocal-chunks`.** llama.cpp returns an EMPTY
  transcription past ~2 minutes of audio in one call
  (ggml-org/llama.cpp#21847), and silence is where every recogniser invents
  things. 30 s pieces beat 60 s ones (WER 0.167 vs 0.202): a long piece let
  the model skip a whole verse when a song switched language mid-piece.
- **The model's own language label is unreliable** in this GGUF — German
  singing comes back labelled "English" with correct German text — so only
  "None" (no singing) is trusted, and the song's majority answer decides.
- **A forced language loops on a chunk with nobody singing** ("oh, oh, oh…"),
  so a looping answer is discarded for the unforced one.

## Releasing

Everything in steps 1-3 is committed and pushed **before** the tag exists. What
checks them is uneven: step 1 is never checked at all; steps 2 and 3 warn on
main and are *enforced* only by the Android publish job, which runs after the
tag — and skipping step 2 does both, degrading the GitHub release silently
while also redding that job. A missing piece is a red release to clean up, not
a push that was stopped.

1. Bump the version. `package.json` is the source everything else derives from
   (artifact names, android/app/build.gradle, the desktop) — except iOS, which
   is written by hand in
   `mobile/ios/SingZPlayer.xcodeproj/project.pbxproj`, and takes **two
   different numbers**:
   - `MARKETING_VERSION` = the release **semver**: `package.json`'s version for
     an ordinary release, and its `major.minor.patch` prefix when package.json
     carries a prerelease string — `v0.19.1-mic1`…`mic5` all shipped `0.19.1`.
     It becomes `CFBundleShortVersionString`, which Apple documents as up to
     three period-separated integers, so the hyphenated string never goes here.
   - `CURRENT_PROJECT_VERSION` = a build counter (CFBundleVersion), bumped by
     one for **every build handed out**, not once per release — it is committed
     in batches, so 0.18.0 is on record at 8, 14 and 26; v0.19.0 shipped at 27
     and the five mic testers at 28-32. Never set it to the semver: that reads
     far *lower* than the counter already installed.

   Nothing in this repo checks either one. iOS refuses an install it reads as a
   downgrade, and treats an install of a version it already has as nothing to
   do — so a forgotten bump ships an `.ipa` that silently will not replace the
   copy on the phone. Successive builds of *one* release are told apart by the
   counter alone, which is why it moves per build and not per version.
2. Write `docs/release-notes/v<version>.md` and commit it with the bump. First
   line is the release title, the rest (after a blank line) the body — both
   `build.yml` and `android.yml` read it at release-create time, so whichever
   wins the race publishes the release already titled and noted. **A missing
   file does not fail the build**: it falls back to
   `gh release create "$TAG" "${PRE[@]}" --title "$TAG" --notes ""` — still a
   prerelease if the tag is hyphenated, but public, untitled and unnoted, to be
   repaired by hand with `gh release edit`.
   Notes are user-facing — see CLAUDE.md § Releasing for what belongs in them.
3. Regenerate the store text and commit it:

   ```bash
   node scripts/store-notes.cjs
   ```

   It extracts the `<!-- store:LOCALE -->` blocks from that release-notes file
   into Play's per-versionCode changelogs
   (`mobile/android/fastlane/metadata/android/<locale>/changelogs/<code>.txt`,
   version folded the way gradle folds it: 0.19.0 -> 1900), enforcing Play's
   500-character cap per language. It summarises nothing — a missing or
   over-length block is an error naming the file to fix. The android canary
   only *warns* when these are stale (`--check`) — but the step-2 commit
   triggers it by itself, since `docs/release-notes/**` and this script are in
   that workflow's push paths, so the warning lands while there is still time
   to act on it. On a tag the `publish` job runs `fastlane android closed`,
   whose `sync_changelog` runs this script for real **before** the upload — so
   a missing notes file or a missing/over-long block turns that job red and
   nothing reaches Play.
4. `git tag vX.Y.Z && git push origin vX.Y.Z`.
   **Hyphenated tags (`v0.14.1-test1`) become prereleases** in both workflows:
   never "latest", so neither the updater nor the in-app pack URL ever picks
   one up — only the person handed the link installs it. That is how a single
   tester gets a build, and the tag may sit on a feature branch (bump
   `package.json` to the full prerelease string).
5. CI (`.github/workflows/build.yml`) builds mac arm64+x64 dmg, win x64 NSIS,
   compiles the lyrics engines (llama-server, crispasr) and all three
   splitter packs, Developer ID-signs and
   notarizes the mac bundles (falling back to `scripts/afterPack.cjs`'s ad-hoc
   signature only where the Apple secrets are absent, as in a fork), and
   attaches everything to the GitHub Release via `gh` (nullglob per-platform
   file lists; create/update race-safe).
   `.github/workflows/android.yml` builds on the same tag and attaches both
   `SingZ-<tag>-android.apk` (the family fleet's sideload) and
   `SingZ-<tag>-android.aab` (the bundle uploaded to the Play Console by hand).

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

**mac is Developer ID-signed and notarized in CI** — that is done, not a
to-do, and [docs/MACOS-SIGNING.md](MACOS-SIGNING.md) is the whole story:
what each secret is, how it is verified, and the two traps that bit.

**v0.19.1 is the first signed, notarized release** — everything up to and
including v0.19.0 shipped ad-hoc signed, which is why README tells anyone on
an older download to approve it once in System Settings. The secrets landed
on 2026-08-29, after v0.19.0 was tagged.

Worth watching on that first tag rather than assuming: every run that has
proved signing so far was a `workflow_dispatch`, and the attach step is gated
on a tag ref — so a signed dmg has been *built* many times and never yet
*attached* to a release.

A local build always runs the afterPack ad-hoc sign. On a Mac that has a
Developer ID certificate installed, electron-builder's auto-discovery then
finds the real identity and re-signs over it (the ordering saves us:
`emitAfterPack` runs before `doSignAfterPack`). The hook deliberately does
not infer identity availability from individual `CSC_*` variables: a password
alone does not name a certificate and must not leave the repacked app with an
invalid stale signature.

The wasted pass is harmless, and the result is a Developer ID-signed but
**un-notarized** app — notarization needs the API-key secrets.

**Do NOT follow the old advice this section used to give.** It said to remove
an `identity: null` from electron-builder.yml (there is no such key any more)
and to set `CSC_LINK`/`CSC_KEY_PASSWORD` — and setting `CSC_LINK` is
specifically the thing that breaks: electron-builder 26.15.3 hands the `.p12`
password to `security set-key-partition-list -k`, which wants the *keychain*
password, and the macOS leg dies as a bare `security process failed 1`. CI
imports the certificate itself and passes `CSC_KEYCHAIN`/`CSC_NAME` instead.
Notarization here is App Store Connect **API-key** auth
(`APPLE_API_KEY`/`APPLE_API_KEY_ID`/`APPLE_API_ISSUER` + `APPLE_TEAM_ID`),
not the `APPLE_ID`/app-specific-password trio.

**Windows is still genuinely unsigned.** Options if that changes: Azure
Trusted Signing (`win.azureSignOptions`) or SignPath's OSS tier.

## Localization

The desktop speaks English, Russian and Simplified Chinese. The title bar's
flag (the kit's `LanguageSwitcher`, `compact`) picks one, or `System`, which
follows the machine's preferred languages (`app.getPreferredSystemLanguages()`;
Traditional Chinese is deliberately not handed Simplified). The choice lives in
`settings.json` as `language`; switching is live — nothing remounts, a playing
song keeps playing.

- **Every user-visible string goes through `t('ns.key')`** (or `tn` for a
  count, `<T k=…/>` for `**bold**`) from `src/renderer/src/i18n.tsx` /
  `src/shared/i18n`. Log lines, ids, persisted values and anything compared in
  code stay English. Whole sentences with `{placeholders}` — never glue
  translated fragments, Russian and Chinese order words differently.
- **English is the source**: `src/shared/i18n/en/<namespace>.ts`, one file per
  area (app, player, lyrics, training, settings, library, main, common).
  `ru/` and `zh-CN/` mirror it, typed `Translation<typeof en>`, so a key added
  in English without its translations fails `npm run typecheck`, and
  `tests/unit/i18n.test.ts` checks every key, every placeholder, the `**`
  markers and Russian's `_few`/`_many` plural forms.
- **Nothing frozen at module load**: a string in a module-level constant is
  English forever. Make it a function (`playbackOutputUnconfirmedCopy()`).
- **Main translates what it originates** (dialog titles, errors a toast shows)
  with the same module; `src/main/locale.ts` resolves and applies the locale.
  Errors the renderer or `sync-scheduler.ts` pattern-match stay English.
- **Stem names** come from the kit's `STEM_META` in English; show them with
  `laneLabel(track)` / `stemLabel(id)` (model.ts). Music-theory names are data
  too (`intervalName` is stored and compared) — display them through
  `src/shared/music-labels.ts`.
- **Bundles**: the renderer entry carries English only (it is every
  fallback); `loadLocale()` fetches Russian/Chinese on demand. The phone
  bundles src/shared's training code, which therefore imports
  `i18n/training` (core + English training strings), never the index.
- Suites that read component SOURCE use `tests/unit/i18n-source.ts`
  (`readSourceWithEnglish`), which writes each key's English beside its call.
- New strings: write the English, then translate — a Sonnet/Haiku agent given
  the English namespace file and the glossary does it well; keep terms
  consistent with the existing `ru/` and `zh-CN/` files.

### The phone

The phone speaks the same three languages but has **no picker**: it follows
the system, and the singer changes it per app in the OS — iOS Settings ›
SingZ › Language, Android 13+ Settings › Apps › SingZ › Language.

- The OS offers that row because the native projects declare the languages:
  iOS `CFBundleLocalizations` + `knownRegions` + `ios/SingZPlayer/<lang>.lproj/
  InfoPlist.strings` (which also localizes the microphone prompt); Android
  `res/xml/locales_config.xml` + `android:localeConfig`. Add a language in
  all of them and in `mobile/src/i18n`.
- `mobile/src/i18n` reads the choice (iOS: the app's `AppleLanguages`, via
  SettingsManager; Android: the configuration locale via I18nManager), applies
  it before the first render and again on every return to the foreground —
  Android applies a per-app change to the RUNNING process (measured: same
  pid, switched within seconds), iOS relaunches the app.
- Phone strings are `t('phone.<area>.<name>')` over `mobile/src/i18n/en/*.ts`,
  typed and tested like the desktop's (`mobile/__tests__/i18n.test.ts`).
- The lookup runs on **gen/training-lib's copy of the core** — that bundle
  carries one for the shared training code, and a second copy in the app
  would be a second locale. `build-training.mjs` exports it; the phone also
  registers the desktop's training and `common` (key/interval names)
  dictionaries into it.
- Android notification text (Now playing, the split service) lives in
  `res/values*/strings.xml`. Errors the split service persists to its job file
  and JS matches by prefix stay English.
- Test a switch: iOS `xcrun simctl spawn <udid> defaults write io.s-dev.singz
  AppleLanguages -array ru` then relaunch; Android `adb shell cmd locale
  set-app-locales com.lexasoft.singz --locales ru` (live). Jest always runs
  English.
- **Device drivers assume an English app.** Log phrases stay English, but
  some drivers also check screen copy (`split-refused-android.cjs`'s
  `/never started/`, `song-sheet-beat.cjs`'s Beat row). A simulator or
  emulator set to another language fails them for no reason in the code —
  pin the app first: `defaults write io.s-dev.singz AppleLanguages -array en`
  (sim) or `cmd locale set-app-locales <pkg> --locales en` (Android).
- **Skia text has no CJK fallback on Android.** Anything `SkiaLyrics.tsx` draws
  through the lyrics' face renders Chinese as boxes, so its own copy stays
  Latin in zh-CN (the count-in `{sec} s`).

## Renderer performance rules

Field laptops (QHD+ panel + weak iGPU) taught these; keep them:

- Every rAF loop must be **change-gated** (write DOM/canvas only when the
  value actually changed) and **skip work under `body.modal-open`** — any
  pixel change behind a modal re-rasters the whole blurred backdrop.
- No infinite CSS animation without a `body.modal-open … animation-play-state:
  paused` rule (see the shimmer/pulse block in styles.css).
- Windows gets solid surfaces — modal scrim, drop overlay, transport, the
  training head and dock — with no backdrop-filter, unless main judged the
  GPU Chromium composites on strong enough for glass (`body.glass`,
  `src/main/glass.ts`). Every blur needs its `body.win:not(.glass)` twin;
  `tests/unit/windows-no-blur.test.ts` enforces it.
- The pitch strip repaints only when position/view/size/transpose/melody/mic
  trail change; idle karaoke must stay at ~0% GPU.

## Ideas parked for later

- Native configurable input/output DSP graph, analyzer taps and desktop
  plug-in hosting: see [DSP-GRAPH-PLAN.md](DSP-GRAPH-PLAN.md). The current
  shared `AudioInput` core is its capture/analyzer foundation, not its future
  direct-monitoring callback.
- demucs-mlx as the Apple Silicon pack: ~2.6× faster than torch/MPS and much
  smaller; would also make an htdemucs_ft quality tier cheap.
- htdemucs_ft quality mode (4-stem only upstream; ~4× slower, measured 38 s vs
  11 s per song on M-series).
- RMVPE as an optional premium melody tracker (evaluated: best-in-class
  recall; pYIN port ties it for free, so shelved — infer script exists).
- DirectML adapter targeting for Optimus laptops (proven manually via Windows
  per-app Graphics preference; needs a device_id ladder in the pack shim).
- A–B loop for phrase practice; export karaoke mix to file.
- A smaller lyrics download: a Q5_K_M quantization of Qwen3-ASR measured the
  same as the shipped Q8_0 to within noise at 1.83 GB, but nobody publishes
  one — it would mean attaching our own to a pinned release, the way
  `mms-fa.onnx` is (Q4_K_M is not a candidate: it collapses when the
  language is not known).

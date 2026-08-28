# SingZ — instructions for Claude Code

Electron desktop app for singers: split songs into six stems (htdemucs_6s), karaoke with
synced lyrics (LRCLIB + whisper.cpp), pitch matching, transpose, vocal training
(chosen stems drop out on a time or lyric-line schedule), projects.
Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Commands

```bash
npm run dev          # electron-vite dev (HMR; restarts main on src/main changes)
npm run typecheck    # tsc over node (main/preload) + web (renderer) + tests configs
npm test             # vitest: unit suites + tests/roundtrip (real sync -> fake Drive -> real phone code)
npm run gates        # the six TS-against-C++ parity gates (scripts/run-parity-gates.sh)
npm run build        # bundle into out/  — ALWAYS build before driving E2E
npm run dist         # package installer for current platform
npx electron .       # run the built app (out/) without packaging
scripts/vendor-whisper.sh   # build whisper-cli into vendor/<platform>-<arch>/
scripts/vendor-analyze.sh   # build singz-analyze into vendor/ (ships dark; cmake, one defn with the host scripts)
scripts/build-gpu-pack.sh   # torch/MPS splitter pack (Apple Silicon)
scripts/build-onnx-pack.sh  # demucs-onnx splitter pack (win32-x64 | darwin-x64)
cd mobile && npx jest                                  # phone-side Drive logic
cd mobile/android && ./gradlew :app:testDebugUnitTest   # Kotlin cache-currency table
mobile/scripts/test-swift-currency.sh                   # Swift cache-currency table
```

All vendor scripts skip-guard on existing outputs; delete `vendor/…` to force.

## Verification policy

**The C++ core is the source of truth for every detector** (decided 2026-08-22).
New detector work lands in `mobile/native/core` first; the TypeScript in
`src/renderer/src/audio/` is a port of it, and a divergence means the TypeScript
has drifted — not the port. What holds the two together is the seven parity gates
under `eval/`, so they are the contract, not a diagnostic: `npm run gates`
(`scripts/run-parity-gates.sh`) runs all seven on the bundled sample in ~45 s
(analyze-parity is the seventh: the combined one-child pass the desktop
actually spawns against the individual subcommands, value-identical, with the
lattice-and-lyrics-over-stdin leg exercised both ways),
building `singz-analyze` once and generating `mobile/src/gen/analysis-lib.js`
and the sample itself rather than telling you to `npm ci` somewhere else.
**`.github/workflows/checks.yml` runs typecheck + `npm test` + all seven on every
push and PR** — before it existed nothing ran on an ordinary push or PR at all.
The desktop was not untested (build.yml runs typecheck and `npm test` on `v*`
tags, a dispatch and the Monday cron; e2e-win.yml runs `npm test` again on its
branch) but every
one of those is armed deliberately or after the fact, so a change could be
written, reviewed and merged without a machine seeing it. It pins
`runs-on: ubuntu-24.04` rather than `ubuntu-latest`, because the two courts
gates compare transcendentals and a moving image would turn a runner bump into a
red nobody caused; that platform (glibc 2.39, g++ 13.3) was measured green
first, as were Debian 12 x86_64 and aarch64. It uses `paths-ignore`, never an
allow-list: an allow-list stops covering a source directory the day one is
added. A green run is a DRIFT canary
on a 40 s synthesized sample, not a quality corpus — real-song runs
(`--library`, a project dir) stay a deliberate act, `beats-parity` stays
staged, and no parity gate can see the two implementations being fed DIFFERENT
INPUTS, which is exactly how the melody framing bug survived a year of green.

UI or engine changes are verified by driving the real app with
`playwright-core`'s `_electron` (session drivers live in the scratchpad, never
in the repo; permanent harnesses are `tests/e2e/win-smoke.cjs` (run by
the E2E Windows workflow, which also runs `npm test`) and the mac drivers
in `tests/e2e/mac/` (nine of them: align, wizard/consent, audio settings,
bar editing, and the analysis-rule drivers — the two stem-rate ones, the two
song-switch races, and stamp-upgrade; the `e2e-verifier` agent in
`.claude/agents/` holds the roster of record, and a new driver is not
finished until it is listed there — launch one instance per platform in
parallel for cross-platform verification) — vitest unit tests in
`tests/unit/` covering the v2 FLAC format with electron aliased to a stub).
Load files through the hidden `<input type=file>` — same code
path as drag-drop. Read the screenshots you take.
**Metro serves JS live; NATIVE needs a rebuild+install, and a stale binary
reports green** — a mobile run against an app built before the native change
does not merely miss it, it turns every native-facing check VACUOUS: the
CoreML branch could not appear in the log because it was not compiled in,
and the download-progress poller was `undefined` behind its own typeof
guard, both of which read as passes. Rebuild + reinstall whenever the diff
touched .mm/.swift/.kt/.cpp, and if you want to check rather than trust,
grep the app binary itself for a literal the change added —
`strings <app>.app/SingZPlayer | grep …` (pods link STATICALLY here:
use_frameworks! is behind USE_FRAMEWORKS, which nothing sets, so there is
no dylib of ours to grep).
**Every mobile driver must filter Metro's target list by `deviceName`** —
Metro lists every attached app in connection order, so with an emulator and
a simulator both up, an unfiltered `find(t => t.webSocketDebuggerUrl)` takes
whichever answered first: a driver seeded the iOS container and then
interrogated the ANDROID app, reporting its projects as a failure. Every
driver in `mobile/tests/` filters now; a new one must too.
**By default the iOS simulator shows NO soft keyboard, which quietly makes
every keyboard-dependent check there vacuous** — it boots with the Mac's
hardware keyboard connected. On this rig the devices are booted headlessly
with no Simulator.app at all, which is how the drivers here run — so there is
no window to send ⌘K to, and nothing has established what a headless device
does when a field takes focus. It is a default, not a law: Simulator's
I/O ▸ Keyboard ▸ **Toggle Software Keyboard (⌘K)**, or turning off **Connect
Hardware Keyboard (⇧⌘K)**, raises a real one, and the choice persists per
device as `ConnectHardwareKeyboard` under `DevicePreferences` in
`~/Library/Preferences/com.apple.iphonesimulator.plist`. What is missing is a
`simctl` subcommand, so a driver cannot flip it the way it flips everything
else. A driver that types into a field and taps a result on the sim proves
nothing about a phone unless somebody has raised the keyboard first: RN's
guard for that case (`ScrollView`'s `_keyboardIsDismissible`, fed by
keyboardWillShow/DidShow into `_keyboardMetrics`) is only as real as the
keyboard that raised it. Measure that class on Android, whose IME is real —
confirm it with
`adb shell dumpsys input_method | grep -E "mInputShown|mVisibleBound"` rather
than assuming, since `adb shell input text` types without opening one
(`mInputShown` is the one that literally answers "is the IME up"; the other is
a binding flag that happens to move with it) — and say which platform a
keyboard result came from. (Measured 2026-08-22: with the IME up on an API 36
emulator, the first tap on a search result landed both with and without
`keyboardShouldPersistTaps`, so the first-tap-dismisses branch does not bite
there. The iOS half is still unmeasured — ⌘K makes it possible, and nothing
here has done it.)
**A Fast Refresh A/B needs a VISIBLE marker in the same edit** — twice in one
session a "the change makes no difference" result had to be re-run because
nothing proved the bundle had landed. Rename a placeholder, move a label,
anything the screenshot can show; without it a negative result and a stale
bundle are the same picture.
**Automated runs are silent** — sound is only for a human listening
(end-user checks/demos). Desktop drivers launch with `SINGZ_MUTE=1`
(→ Chromium mute-audio; analysers, sinkId and timing behave exactly as
audible — permanent drivers set it themselves, scratchpad drivers must
too); **and every driver launch sets `SINGZ_E2E_HIDDEN: '1'` in the env** —
permanent AND scratchpad alike: main then never shows the window at all and
disables backgroundThrottling so timers run full-rate hidden. An app window
over the singer's work mid-session is how a measurement run makes itself
unwelcome, and it happened THREE times before this landed: eight permanent
drivers patched with a showInactive helper, a scratchpad driver missed it,
and then the helper itself lost its race (it patches over IPC after launch,
and even winning, showInactive still raises a window over the work —
focusless is not invisible). `quiet-launch.cjs` survives only as the
fallback for builds that predate the env; drivers do both; sim tests zero `__test.engine.master.gain` after the hook-wait
(metronome clicks bypass master, so that test passes `volume: 0` —
`clickCount` still counts); the Android emulator gets
`adb shell cmd media_session volume --stream 3 --set 0` (the old
`media volume` is gone on API 36) FOLLOWED BY twenty
`input keyevent 25` — measured on an API-36 AVD, the documented command
prints that it will set the volume, prints "Connecting to AudioService",
exits within a second and silently applies nothing (streamVolume measured
either side of the call is unmoved; it stayed 5/15 across a reboot), so
ever since it was written the Android suites' self-mute was a
no-op, and only add-song's own `master.gain = 0` kept that one quiet.
On this Mac, boot Android emulators via `~/Dev/emu/run-patched-emulator.sh`,
never the SDK's `emulator` — the stock CoreAudio backend garbles all guest
audio while the default output has >2 channels (the Zen; Google issue
506475581, fix CLs pending; details in ~/.claude/rules/android-emulator.md) —
and automated runs pass `-no-audio`, which sidesteps the question entirely.
Keyevents
always land — twenty `input keyevent 24` (VOLUME_UP) is how you get the
sound back for a human demo, not `--set`, which is broken in both
directions. Details + env hooks:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
Mobile has its own permanent sim-driven tests in `mobile/tests/`
(`seek-memory.cjs`, `open-close-memory.cjs`, `loop-region.cjs`,
`offline-cache.cjs`, `custom-track.cjs`, `beats-native-ios.cjs`,
`song-sheet-beat.cjs`): CDP over
Metro against the iOS
Simulator — run them
after engine or loading changes. `song-sheet-beat.cjs` is the one that watches
a SCREEN rather than the engine: it seeds two phone-library projects (a
hand-made grid, and a song with nothing detected), opens the Song sheet and
reads the Beat row through somebody else's analysis — the rule in
`song-sheet-copy.ts`, which no headless suite can see applied to a real row. `beats-native-{ios,android}.cjs` are a PAIR
and both are owed: the two bindings marshal differently (iOS builds its dict
from the core's doubles, Android crosses a JSON line and parses it in Kotlin),
so a value lost in that text hop is invisible to the iOS half. Both want a
project whose stems ALL carry audio — a silent stem discriminates nothing, and
a fallback mutated to drop one passed until the mutation was moved to a stem
with music in it — and both report whether the LATTICE and the aligned WORDS
actually crossed, because a bare comparison sends neither and those are the
two arguments the real pipeline always fills. Pure-JS mobile logic that no device can show
(the Drive protocol, offline fallbacks) is jest instead: `cd mobile && npm test`
— needs `@react-native/jest-preset`, a `transformIgnorePatterns` that exempts
our ESM-shipping RN deps, an asset `moduleNameMapper` for the sample's FLACs,
and `jest.setup.js` to stub audio-api + the pods (they throw on import with no
native module).
**Two sessions, one Mac**: another worktree's Metro already on 8081 will happily
serve ITS bundle to your app, so a parallel run needs its own simulator *and* its
own port — boot a second device, build with `RCT_METRO_PORT=8082`, and then set
the runtime bundle host too:
`xcrun simctl spawn <udid> defaults write com.lexasoft.singz RCT_jsLocation -string localhost:8082`
(the build-time port alone does NOT move the Debug app off 8081 — it silently
attached to the neighbour's Metro). Pass `SIM_UDID`/`METRO_PORT` to the tests.
And never `pgrep` for the app: with two simulators up there are two SingZPlayer
processes, and measuring the wrong one made the memory test report
"release() freed nothing" — take the pid `simctl launch` prints.
Driving **Android** over CDP: never evaluate JS while a decode is in flight —
the Hermes inspector segfaults the app mid-`decodeAudioData` (looks exactly
like an OOM: SIGSEGV at 0x0 on `mqt_v_js` in libhermesvm, ~9 s into loading a
long song, 3/3 reproducible; the same load never fails unpolled, 4/4). Poll
the `singz.crumb` pref over `adb run-as` instead, which touches no JS.
**DISCONNECTING the inspector mid-decode kills the app the same way**
(measured 2026-08-21: close the socket during a six-stem load → the identical
SIGSEGV) — the socket may sit attached idle across a whole load, but may
neither speak nor hang up while one is running; connect before, disconnect
after. And **no open/load time measured on the debug app describes the
product**: the dev Metro bundle inflates the load path by roughly an order of
magnitude (the 5.3-min test song opens in 30 s on the debug rig, inspector
detached; the user's real songs open in 3-4 s on the release app — different
songs, so the factor is directional, not a ratio of one measurement) — quote
release-app numbers or none. Debug
builds only — release APKs have no inspector. Metro also lists *every*
connected app, so pick the target by `deviceName` or a stray simulator will
answer your evals while you measure the phone. And its bundles are PER
PLATFORM: a Metro already warm for iOS still builds Android from cold, which
outlasts the app's own patience and surfaces as "no debugger target" from a
dev server answering `packager-status:running` perfectly — pre-build it with
`curl -s -o /dev/null "http://localhost:<port>/index.bundle?platform=android&dev=true&minify=false"`
before launching the app.
**Which emulator answers first and which one can be driven are different
questions** — debug and release share the applicationId (`com.lexasoft.singz`,
no `applicationIdSuffix`), so an AVD carrying a *release* build looks
identical in `adb devices` and fails only once the driver is already running:
`run-as: package not debuggable`, no inspector, no Metro target, both suites
dead at setup for reasons that have nothing to do with the change under test.
Ask the device before trusting it — `adb -s <serial> shell dumpsys package
com.lexasoft.singz | grep -E 'versionName|DEBUGGABLE'` — and confirm the
installed APK is *this* tree's (`md5sum` it against
`mobile/android/app/build/outputs/apk/debug/app-debug.apk`). The same
applicationId is why a PLAIN debug build must never be pushed to the user's
own phone: same id + different signing key = Android demands an uninstall
first, which takes `files/singz-projects` (every downloaded song) and the
Drive sign-in with it. Build it with `-PdebugAppIdSuffix=.debug` instead and
it installs beside the release app, touching neither — that is how the POCO
was driven; the gotchas that follow from it are below.

## Hard-won gotchas (do not re-learn these)

- **userData identity**: `Electron out/main/index.js` → userData "Electron";
  `npm run dev`/`npx electron .` → "singz"; packaged → "SingZ". Caches differ
  per identity — shared things (model weights, GPU pack) deliberately live in
  `~/Library/Application Support/SingZ/` via `modelsDir()`/`packDir()`.
- **Never `fetch()` custom protocols from `file://` pages** — blocked in prod
  builds. Audio bytes go over IPC (`media:read`).
- **Mobile stems must be freed explicitly — GC is far too late** — decoded
  stems are ~138 MB per minute of song (six lanes, 48 kHz float32), so a
  4-6 min song is 630-845 MB while Hermes sees only a small wrapper and
  collects whenever it likes. Two separate pins, both needed: the native
  graph holds every source node it created until the render thread retires
  it (never, once playback stops) — null `source.buffer` before discarding a
  source; and the buffer's host object owns the PCM until finalization —
  `AudioBuffer.release()` (**audio-api patch 4**) hands it back on the spot.
  Leaving a song must call `engine.unload()` then `releaseProject()`, in that
  order. References-only was measured at ~1 GB still resident per closed
  song; on device that was a per-process-limit jetsam kill on the fifth song.
  Guarded by `mobile/tests/open-close-memory.cjs` — note RSS only moves for
  song-sized blocks, sample-sized ones stay in the allocator's cache.
- **iOS presents ONE view controller at a time, and the loser is silent** —
  an RN `<Modal>` that opens a system picker (document picker, share sheet)
  from its own mount effect puts two presentations in flight from one commit.
  UIKit keeps the picker and refuses the modal ("Attempt to present
  `RCTFabricModalHostViewController` … which is waiting for a delayed
  presention of `UIDocumentPickerViewController` to complete", visible only in
  the device console), so the sheet NEVER appears while its JS runs the whole
  flow behind an empty screen — which reached a real phone as "I've added song
  but interface just freezed", with nothing in the app log because nothing
  failed. Present the system UI FIRST, from the screen, and open the sheet on
  what it returned (`beginAdd` in CatalogScreen; the sheet takes `src`).
  Guarded by `mobile/__tests__/one-presentation.test.ts` — a headless suite
  mounts no modal and can never catch this, which is why the rule is checked
  at the source.
- **A native method whose arity does not match JS never runs, and never
  says so** — pass three arguments to a two-argument `RCT_EXPORT_METHOD` and
  the bridge declines to dispatch: the promise is neither resolved nor
  rejected, so there is no work, no error and no red box, just an app sitting
  on its main screen looking healthy. `mlGrid` shipped that way on iOS while
  Android's JNI already took `dumpDir`, and it read from outside as "nothing
  happens" for ten minutes at 1.3% CPU with flat RSS. The rule that the module
  name, **method arity** and event payloads are identical on both platforms is
  written at the top of `SingzSplit.mm` for this reason; when a method changes
  on one side, sweep the whole surface against `SplitModule.kt`, not just the
  method in hand. Suites that drive a native call need a settle DEADLINE, not
  a poll count — an unsettled promise is what this looks like from the driver.
- **Foundation's JSON parser is not correctly rounded, so no core number may
  reach iOS as text** — `NSJSONSerialization` reads `"0.053999999999999999"`
  as `0.054000000000000006` where `strtod`, Kotlin and JS all read `0.054`.
  The core writes `%.17g`, which is exactly the shape it gets wrong; SHORT
  forms parse correctly, so checking `"0.013"` says the parser is healthy and
  sends you looking elsewhere. Parsing `mlGridJson` back cost 49 of 2041
  probabilities their last bit while beats and downbeats stayed identical —
  invisible to any grid comparison, which is why the suites compare every
  VALUE and never a count. iOS bindings build their result from the core's
  doubles (`mlGridRounded`); Android's text hop is fine because Kotlin's
  parser is correct.
- **A resampler's quality gate must exercise the ratio that is actually
  used** — `Resampler` was sized for 48k→44.1k (24 taps per output sample
  at up=147 is a ~3.5k-tap prototype) and the same 24 at 44.1k→22.05k is a
  24-TAP lowpass: −3 dB at 10 kHz, 12-14 kHz aliasing back at −10..−25 dB,
  16.8 dB SNR against soxr on real stems, a different beat grid. Its "110
  dB" gate was a 1 kHz tone at a near-unity ratio, which no short filter
  can fail. Taps now scale with net decimation and the host harness sweeps
  the 2:1 response itself. When a new consumer uses a shared DSP block at
  a new ratio, measure the response at THAT ratio before trusting the
  header's number.
- **There is no resampler-independent Beat This! grid — so ONE render, the
  core's, is the input everywhere** (v23; the study is
  docs/BEAT-DETECTION.md §10). Three good renders of the same stems agree
  to 0.01 dB to 10 kHz and still differ in grids; raw lattices are
  render-equal on GT but the FUSED rotations are not, and what actually
  moved them was the LEVEL — beat_this normalizes nothing, and ffmpeg-style
  equal-power mono (+3 dB over WebAudio's 0.5·(L+R)) scores 54/55 fused
  against Chromium's 52/55. `sumStemsTo22k` (swr-shaped 65-tap Kaiser,
  time-true via `latencyOutFrames`, ×√2) renders the mix for the desktop
  (main spawns `singz-analyze mlmix` — `fetchMlGrid` renders nothing), the
  phones and the eval harness alike; `scripts/render-ml-mix.cjs` only
  reproduces the pre-v23 Chromium input for archaeology. The phone suites
  still gate the LATTICE (beat F1 ≥ 0.98 at 70 ms, tempo, downbeat F1
  ≥ 0.80) — the python and ORT model backends keep bit-equality off the
  table even on one render — and their oracle recordings regenerate from
  `mlmix`, not Chromium. Bit-equality is asserted only where the input is
  the same bytes (the wav suites).
- **CSS Grid**: definitely-placed items (the scrub overlay) are placed first;
  give every sibling an explicit `gridRow` or they land in implicit rows.
- **React-managed `className` wipes imperative classes** on re-render —
  re-assert per frame (count-in dots pattern in LyricsPanel).
- **A worklet's body runs on Hermes UNLOWERED, and Hermes has no per-iteration
  loop bindings** — the worklets babel plugin serializes a `'worklet'`
  function as source (plugins run before presets, so Metro's block-scoping
  transform never touches it) and the worklet runtime evaluates that source
  raw; measured on the iOS sim: `for (let k of ['a','b','c']) fns.push(() =>
  k)` yields `c,c,c` there, `for (let i…)` likewise (function-scoped closures
  such as `forEach` callbacks are fine). Silent and wrong, never a throw: the
  first casualty was esbuild's own export helper (a getter closure per key in
  a for-of), which resolved EVERY export of the analysis bundle to the last
  one — `lib.detectBeats` was `trackMelodyCore`. `build-analysis.mjs` runs
  the worklet-bound bundle through `@babel/plugin-transform-block-scoping`
  before inlining it (`mobile/src/gen/analysis-worklet.js`); any hand-written
  worklet with a closure inside a `let` loop needs the same care.
- **The mobile lyrics are one Skia canvas** (`SkiaLyrics.tsx`): the whole
  column, the sung line painted with a gradient whose edge travels along x —
  desktop's `background-clip: text` a layer down. The canvas is
  viewport-sized and held still while a transform scrolls the column under it
  (a canvas as tall as a real song is a ~13000px surface, past what many
  phones will allocate); what actually scrolls is a spacer carrying the tap
  targets. It replaced ~7 nested clipped Views per
  word, which on a 120 Hz phone fed the display 58 fps (19.6% janky) against
  Skia's 121 (0.2%). Matching an RN `<Text>` glyph-for-glyph is fiddly and every
  bit was measured, not guessed: multiply fontSize/lineHeight/letterSpacing by
  `PixelRatio.getFontScale()`; wrap on the OUTER box (word **+** its
  marginRight, the way Yoga does); Android's letter spacing widens every glyph,
  iOS's only the gaps between them; and the face is `sans-serif`/'900' on
  Android but `System`/'bold' on iOS — `SF Pro Text` silently does not resolve
  (it measures ~2 px a word), and Skia's font manager matches a *static* face
  where RN interpolates a variable one. Get any of these wrong and the line
  re-wraps or resizes the instant it lights up. The JS frame at a line change is
  the React commit, not the mount: the iOS sim barely noticed the whole-column
  move (40.1 -> 38.5 ms, noise) while the phone did (56.5 -> 42, and >33ms
  frames 41 -> 19) — measure on the phone, the sim's 60Hz hides this. Keeping
  every line's sweep mappers alive to remove the commit entirely is much worse
  (p95 19 -> 27 ms, dropped frames 4 -> 26). Don't chase it again.
- **whisper.cpp `-ml 1` emits occasional backward word offsets** — sanitize
  before aligning (see `alignLines`).
- **LRC gives line starts only** — word timing is estimated at ~12 chars/sec,
  never stretched to the next timestamp (lag), unless AI-aligned.
- **Splitting requires a downloaded pack** (no bundled engine since 0.3.0),
  and every split is six stems (htdemucs_6s; silent guitar/piano lanes are
  hidden in the UI): torch/MPS on Apple Silicon; demucs-onnx elsewhere.
  Windows GPU = the TensorRT-RTX plugin EP (GeForce RTX 30xx+; pack v5+
  ships it under python/rtx, v6 adds the pre-simplified `_trt.onnx` graph
  (raw export = 20k shape/scatter glue nodes that shatter the TensorRT
  partition; onnxsim with the fixed input folds it 18x, parity-gated in
  the pack build; v8 = one fp16 model for both engines + one mainline ort) with mainline ort side-loaded by the per-split
  runner, src/main/onnx-runner.ts) with a `trtrtx-disabled.json` marker
  after one failure and the chunk-pace watchdog for pathologically slow
  sessions. **DirectML was removed entirely** — across the whole fleet it
  never completed a split (fused graph = TDR device-hung 887A0006, unfused
  = ISTFT ConvTranspose OOM; wheel frozen at ORT 1.24) — old machines'
  `dml-disabled.json` markers linger but decide nothing. CPU on Intel
  Macs — CoreML crashes compiling the graph. Every downloaded
  pack gets a renderer-rendered 44.1 kHz WAV (`needsPcm`) — demucs 4.1
  decodes via sphn (no m4a/aac) with an ffmpeg-CLI fallback end users lack,
  and torchaudio ≥2.9 load/save is torchcodec-only (unused by demucs 4.1,
  not shipped); pack deps are pinned in build-gpu-pack.sh, which smoke-splits
  an mp3 with a bare PATH + `HF_HUB_OFFLINE=1` at build time. System demucs
  (dev machines) still splits the original file. Packs are versioned via
  `python/pack.json` — bump `PACK_FORMAT_REQUIRED` (models.ts) with the
  build-script stamp to force everyone onto a new pack.
- **HF hub caches checkpoints as extension-less blobs** — never glob for
  `*.safetensors` under `HF_HOME`.
- **HF hub caches symlink snapshots→blobs** — packs must materialize links and
  prune `blobs/` (build-onnx-pack.sh), because Windows tar can't extract
  symlinks without admin rights (the v0.2.2 pack shipped broken this way).
- **Spawned python buffers stdout when not a TTY** — set `PYTHONUNBUFFERED=1`
  or progress lines arrive only at process exit (UI stuck on "Warming up").
- **Every spawn reads its output through `onChildSettled`** (`src/main/child-exit.ts`),
  never a bare `child.on('exit')` — `'close'` is the documented promise that
  stdio has drained, `'exit'` explicitly is not. Two children actually depend
  on it (the MMS aligner and the beat runner each print one JSON object; the
  aligner's is ~50 bytes a word). **The truncation was NOT reproducible here
  and nobody should re-derive that**: 400 trials, 1 KB to 8 MB, idle and busy
  parent loop, macOS + node 26, 0 short reads — `exit` and `close` land in the
  same millisecond. It is kept for the mostly-Windows fleet, whose libuv pipes
  are IOCP and cannot be measured from a Mac, so treat it as correctness by
  contract rather than as a bug that once bit. The grace timer is not optional
  garnish: a plain `'close'` swap can hang forever, because the splitter pack
  loads torch and can leave a descendant holding the inherited pipe, and six of
  the seven call sites would then wait on it for good. Only `probeDetailed`
  escapes, because its timeout resolves the promise itself; the two other
  timers (`beats-ml`, the ONNX heartbeat) merely KILL the child, which a
  grandchild holding the pipe survives, and the remaining four have no timer at
  all. The unit suite's teeth are that case alone — the big-payload tests pass
  against the old code too, and say so.
- **Engine subprocesses run with `HF_HUB_OFFLINE=1`** — models must come from
  the pack; without it a broken pack silently re-downloads 166 MB mid-split.
- **electron-builder**: `files` must exclude `vendor/`, `.engines-src/` etc. or
  they land in the asar (was 241 MB); `${os}` macro is `mac`/`win`, NOT node's
  `darwin`/`win32` — extraResources are declared per-platform.
- **macOS ad-hoc signing is mandatory** (scripts/afterPack.cjs): repacked
  Electron has a broken signature and quarantined downloads show the
  unrecoverable "app is damaged" dialog. Hook skips itself when CSC_* is set.
- **One log per platform, and it outlives the process** — everything goes
  through `log(source, line, level)`: `src/main/log.ts` on the desktop (shown
  in the existing Log dialog) and `mobile/src/log.ts` on the phone (the same
  dialog ported — `mobile/src/ui/LogPanel.tsx`, opened from the header, Share
  where the desktop has Copy). A second, sync-only panel was the wrong answer:
  two viewers of one truth is the same mistake as two answers to "do I have
  this file?". The desktop's sync record also persists to
  `userData/sync-log.jsonl` (leading newline per append, so a kill mid-write
  cannot merge two records) and is REPLAYED into the dialog at launch, so it
  covers previous sessions; the phone persists its whole log in prefs
  (`singz.log`, 400 lines) because phones are killed rather than quit. On a
  release APK there is no inspector and no `run-as`, so what the app wrote down
  is the only evidence there is — which is exactly how long the "✓ but it
  re-downloads" hunt took without one.
- **CocoaPods can leave the sandbox linking a React framework that no longer
  satisfies RNGestureHandler** — symptom is a link failure on
  `facebook::react::Props::~Props()` / `vtable for DebugStringConvertible`,
  with the app's OTHER_LDFLAGS carrying `-framework React` and no Fabric libs.
  It survives a clean DerivedData and is NOT caused by app sources (proved by
  building the last-known-good sources against it). Fix: `rm -rf Pods && pod
  install`. Adding a `test_spec` to the FolderAccess podspec is what triggered
  it here — and it generates no test target anyway, which is why the Swift
  conformance runner is plain swiftc.
- **Android app C++ (new-arch)**: setting `externalNativeBuild` REPLACES the
  RN gradle plugin's default CMake — `include(${REACT_ANDROID_DIR}/cmake-utils/
  ReactNative-application.cmake)` first or `libappmodules.so` silently vanishes
  and the app dies at boot with "PlatformConstants could not be found". That
  include also GLOBS every `*.cpp` beside the CMakeLists into appmodules —
  own sources live in `mobile/native/core/` (the shared C++ engine core; JNI
  shim under `core/android/`), never next to the CMakeLists. The ORT Android
  AAR is legacy-layout (headers/ + jni/<abi>/, no prefab) — the `extractOrtSdk`
  gradle task unzips it and CMake imports the .so via `ORT_SDK_DIR`.
- **A piped gradle build reports its failure as success** — `./gradlew … |
  tail` exits with TAIL's status, so a build that died still reads as exit 0.
  It happened twice in one session: both "rebuilds" actually aborted on
  `Gradle requires JVM 17 or later … currently configured to use JVM 8`, the
  APK on disk stayed the previous one, and the suite then passed against a
  binary that did not contain the change under test — the stale-binary trap
  arriving through the build rather than through the install. Redirect to a
  file and echo `$?` instead of piping, and confirm the APK's mtime moved.
  The JVM 8 came from **`/usr/libexec/java_home -v 21` EXITING 0 AND
  RETURNING A JDK 8 PATH** — measured: only 1.8.491.10 is registered on this
  Mac, and asking for 21 yields
  `/Library/Internet Plug-Ins/JavaAppletPlugin.plugin/Contents/Home` with
  status 0, so the usual `$(java_home -v 21 || echo <fallback>)` idiom never
  reaches its fallback and hands gradle the wrong JDK. Set JAVA_HOME to the
  brew path directly — `/opt/homebrew/opt/openjdk@21` and its
  `…/libexec/openjdk.jdk/Contents/Home` both work — and never derive it from
  `java_home` here.
- **Driving a dev build on somebody's REAL phone**: build with
  `-PdebugAppIdSuffix=.debug` so it installs beside the release app instead
  of demanding the uninstall that would take `files/singz-projects` and the
  Drive sign-in. Three things then bite, in order: HyperOS/MIUI refuses
  `adb install` until "Install via USB" is on in Developer options
  (`INSTALL_FAILED_USER_RESTRICTED`, and pushing + `pm install` does not get
  round it); a fresh applicationId has NO `debug_http_host` pref, so on an
  emulator RN falls back to `10.0.2.2:8081` and quietly attaches to a
  neighbouring worktree's Metro (write
  `<pkg>_preferences.xml` with `debug_http_host` — a real phone is fine on
  `localhost` + `adb reverse`); and on the emulator an `adb`-created
  `files/mlt` is owned by shell and the app cannot open it (`adb root` +
  `chown` to the app uid fixes it; the phone's FUSE grants by path and needs
  nothing). The same ownership decides whether a SEEDED PROJECT exists at all:
  a folder pushed into `getExternalFilesDir(null)/SingZ projects` belongs to
  shell, external-storage FUSE will not hand it to the app, and `listProjects`
  skips it in a `continue` — no throw, no `listError`, the catalog just lists
  the projects the app made itself and a driver reports "never listed" against
  a healthy `libMode=phone`. Read the owner off the library folder rather than
  parsing `dumpsys` for it: API 36 stopped printing `userId=`, and a regex
  that misses arrives as a null dereference three steps later. **`run-as` is useless for diagnosing any of this** — it does not
  inherit the app's storage sandbox, so it reports "Permission denied" even
  for directories the app itself created.
- **Android builds need a JDK 21** (`brew install openjdk@21`; CI pins
  temurin 21). The Android Studio JBR moved to JDK 25, and AGP's
  GeneratePrefabPackages treats the JDK 24+ restricted-native-access warning
  from its `prefab` subprocess as a build error — any project with a prefab
  consumer (reanimated/worklets) fails to configure under the new JBR.
- **zsh**: `status` is a read-only variable in scripts.
- **npm majors**: `@vitejs/plugin-react` must match electron-vite's supported
  Vite major (currently plugin ^5 with electron-vite 5 / Vite 7).
- **Stored analyses are versioned, and the bump is on you** — the beat grid
  (`settings.beat`, `BEAT_DETECT_VERSION`) and the melody line
  (`settings.melody`, `PITCH_DETECT_VERSION` in `audio/melody.ts`) are saved
  into project.json because the phones have neither detector and re-running
  them costs seconds per open. Both re-derive on load only when their stamp is
  older than the current one, so touching pyin/the pitch worker's framing or
  cleaner — or `detectBeats` — WITHOUT bumping the matching constant leaves
  every saved project drawing the old answer forever. The corrected result
  saves itself into an existing project (never creating one under a raw file).
  **Every staleness question goes through `analysisIsStale(stamp, current)`**
  (`audio/analysis.ts`, exported to the phone through the analysis-lib entry)
  and the rule is UPGRADE, NEVER DOWNGRADE: missing/nonsense/lower re-derives,
  equal or NEWER is adopted untouched. `!==` stood there until the v23 catalog
  pass met a v22 release app on the same machine — which would have re-derived
  its own older grid and auto-saved it back, walking a whole library backwards
  one open at a time (a phone behind a desktop is the same story). The cost is
  that reverting a constant no longer self-heals: that is Re-detect's job. What
  keeps `===` is the check that the VENDORED BINARY matches this build — a
  different question from whether a project is old.
- **An analysis is framed by the rate it is HANDED, so that rate comes from the
  file, never from the device** — the melody's hop is derived on both sides of
  the port (`hop = round(sr / DECIM * HOP_SEC)`, `hopSec = hop / (sr / DECIM)`
  in pitch-core.ts and melody.cpp alike), so the same song analysed at two
  rates gets two grids: 44.1 kHz decimates to 14700 and rounds 367.5 up to a
  368-sample hop (0.0250340136 s), 48 kHz decimates to 16000 and lands on
  exactly 400 (0.025 s). The C++ core reads the stem file, so it always saw the
  file's rate; the desktop used to track the PLAYING AudioBuffer, which
  `decodeAudioData` had resampled to the output device's rate — 48 kHz on this
  Mac, 44.1 kHz on plenty of Windows machines. Measured on Wild World: 8009
  frames at hop 0.025 from the desktop against 7998 at 0.0250340136 from the
  core, 5% of the shared voiced frames more than a quarter-tone apart, and the
  key readout rides on the same line. Both were stamped v1 and BOTH GUARDS LET
  IT THROUGH — `melodyFitsSong` compares coverage against the song's LENGTH,
  and one song's two coverages differ by three milliseconds — so each side
  adopted the other's line and neither ever re-derived it. The desktop now
  reads the stem file at the rate the file states (`audio/stem-rate.ts`,
  `melodyInput` in App.tsx) and `PITCH_DETECT_VERSION` is 2 to retire what the
  old path wrote. **The beat detector had the same bug with a worse face**:
  `monoAt44k` "pins" the rate by linearly interpolating the device-rate buffer
  BACK down, and on that doubly-resampled audio the octave decision itself
  flipped — the app detected Wild World at 156.6 bpm, the exact figure
  library-gt.json records as "the pre-v16 wrong answer", and Zeit at half —
  while eval/beats/run-current.mjs, which minted every ground truth, decodes
  with ffmpeg at 44.1 kHz and so had NEVER ONCE scored the path the app
  actually ran (41/51 checks vs 40/51; 45 vs 44 with the model; the neural
  lattice usually masks the flip, which is why it looked pack-dependent).
  Every analysis now reads stems from FILES (`analysisStems` in App.tsx — beat,
  key, and the ML mix alike), `BEAT_DETECT_VERSION` is 22 to retire
  device-rate grids, and `run-current.mjs --rate 48000` keeps the broken path
  measurable. KEY_DETECT_VERSION deliberately did NOT move: the key answer was
  measured identical at both rates across all 17 library songs. **A parity
  gate that runs one rate cannot see any of this**: eval/melody-parity.mjs was
  green throughout, because it read the rate off the WAV and handed the SAME
  rate to both implementations — it now runs every file at its own rate and at
  the other of the 44.1/48 pair. Any future detector that takes a sample rate
  owes the same question: which rate, whose, and does the other implementation
  get the same one?
- **Analysis must not outlive the song it was started for** — pYIN runs for
  seconds in a worker, so the singer can be in another song by the time it
  answers; a line that lands late is not merely drawn in the wrong song, it is
  AUTO-SAVED there and then adopted on every open forever after. Two field
  projects were found carrying a neighbour's line byte for byte (notes drawn
  all through an intro, the key read off music nobody sang). Every long job
  captures `loadSeq.current` and drops its result if the song has changed —
  that guard is the rule, not a nicety. Belt and braces on the stored side:
  a line's coverage (frames × hop) IS its song's length, so `melodyFitsSong`
  disowns one that fits a different song and re-tracks, which is how the two
  corrupted projects healed themselves on the next open. Guarded by
  `tests/e2e/mac/melody-song-switch-e2e.cjs`.
  **The rule is not just pYIN's** — `prepLyrics` shipped without the guard and
  was measured landing song A's lyrics in song B (Wild World displaying
  "Metallica — Nothing Else Matters"). Lyrics have no `melodyFitsSong` twin to
  heal them, and the damage is not only what is drawn: `linesRef` feeds
  `detectBeats`' `lineStarts`/`words` aux, so a foreign phrasing is baked into
  THIS song's beat grid and auto-saved under a current stamp that stops it
  being re-derived. `cancelLyrics()` does not cover the window either —
  `Transcriber.cancel()` aborts the model download and kills the whisper/
  aligner child, but the LRCLIB ladder runs under neither and `busy` is false
  throughout it, so the lookup runs to completion with nothing to stop it.
  Guarded by `tests/e2e/mac/lyrics-song-switch-e2e.cjs`, which makes the race
  deterministic by wrapping main's `net.fetch` with a delay via
  `app.evaluate` — the ladder runs in MAIN, so no renderer-side route
  interception can see it.
- **Project format v2 = FLAC stems** (~4x smaller, lossless; splitter cache
  stays WAV). v1 WAV projects auto-upgrade on open (`migrateProjectToV2`);
  readers must keep accepting both (`stemFile()` prefers .flac). Encoding uses
  libflacjs's **asm.js** build in main — the wasm build `fetch()`es its binary
  and cannot boot under node. Projects root is relocatable (settings.json →
  cloud folders like iCloud Drive); `allowRoot` the new root after switching.
  The `mobile/` RN player reads the same folders (v1 and v2) via its
  FolderAccess pod.
- **Custom tracks (the singer's own audio as extra lanes) live in `stems/`**,
  named `custom-<slug>.<ext>` in whatever format they came in — NOT in a
  `tracks/` folder: Drive sync only walks `project.json`, `lyrics.json` and
  `stems/` (extension-filtered — widen that filter, not the layout), and the
  phones reach them with no native change at all: `FolderAccess.localFile` and
  `driveLocalFile` both take a project-relative path, so mobile JS fetches
  exactly what `settings.custom` names. What the natives DO enumerate by the six
  stem names is `listProjects`' `cached`/`bytes`, so a folder library's ✓ ignores
  added tracks (the Drive listing counts them in JS). `project.json` keeps them
  project-relative (`settings.custom`); main resolves them to absolute on the
  way out and back to relative on save, because a moved project folder (rename,
  import, another machine's cloud library) would rot absolute paths. Lanes may
  now differ in length: waveform view fractions are per buffer, not per song.
  **Renaming one changes `label` and nothing else** — the id is the mixer key
  AND the file name, so deriving either from the display name would move audio
  on every rename (Drive re-upload, phone re-download, orphaned mixer state).
- **Projects open from anywhere and stay where they are** — a project folder
  need not sit under the library root (copied, shared, another machine's cloud
  library). `registerSource` must `allowRoot` the detected project dir or
  media:read refuses its stems and the load dies as the misleading "Could not
  decode that audio file."; `project:upgrade` fails the same way. Save and
  rename act **in place**; `importProject` is the only thing that relocates a
  project, and only when the user asks. Anything that moves a project folder
  has to `allowRoot` the destination — the old entry does not follow it.
- **The phone's copy of a song is durable, and re-fetch is decided by md5** —
  downloaded stems live in `Library/Application Support/singz-projects` (iOS,
  excluded from backup) and `filesDir/singz-projects` (Android), NOT in
  Caches/cacheDir: the OS empties those under storage pressure and the song
  silently downloads again. Both natives adopt the old cache dir once on first
  use. **"Do we have this file?" is asked of the file, never of a record of
  past downloads** — JS hands `fetchToCache` the md5 and size the doc states
  and the native decides: missing or wrong size or wrong md5 → download,
  else serve the copy on disk (md5s memoized per path against size+mtime, so
  a song hashes once, and verified after every download so a half-arrived
  file is never cached). The ledger this replaced (`singz.gdrive.have`)
  recorded downloads, not files: it had no row for a copy fetched by an older
  build, nor for one fetched under a project.json with no `stemHashes` — and
  since the ✓ counted bytes on disk, those songs sat in the library ticked
  while every open re-downloaded all six stems. Two answers to one question is
  the bug; the ✓ now runs the same comparison minus the hashing
  (`isDownloaded`: every file the doc names, present at its size — per file,
  never a byte sum, or a leftover stem covers for a missing one; `.part` files
  count for neither). The Drive
  listing is persisted too (`singz.gdrive.catalog`, file ids included), so the
  catalog opens instantly, works with no signal, and refreshes silently behind
  what is already on screen. A refresh that fails mid-listing must abort, not
  persist: skipping unreadable folders once persisted a half-listed library —
  a wifi handover during the silent revalidate wiped the catalog and the next
  cold start re-listed everything on a "loading from Google Drive" spinner; `driveLocalFile` tolerates a token it cannot
  refresh offline, because the native short-circuit happens before the URL is
  used. Anything that deletes cached files must also `driveForgetCached`.
- **Google Drive sync needs no Drive clients**: drive.file scope (no Google
  verification), one Desktop-type OAuth client for every platform (loopback
  flow — Android listens on 127.0.0.1 natively). Desktop pushes the library
  to a visible SingZ Drive folder (md5-diffed resumable uploads, auto after
  save); phones list over REST and stream stems via FolderAccess
  fetchToCache. **Two-level hashing**: a project IS its project.json —
  `stemHashes` (md5+size+mtimeMs per stems/ file, save-maintained,
  sync-backfilled; mtimes compare with ~2ms tolerance — iCloud rehydration
  truncates them ~300ns) carries the stem list, formats, sizes and md5s, so
  a clean sync reads no stem bytes (hashing evicted iCloud stems used to
  re-download the whole library, which read as "sync re-uploads my media").
  `lyricsHash` states lyrics.json the same way, so **the doc names every file
  the project is made of** — the aligner's rewrite moves project.json with it
  (sync backfills both before hashing the doc), and one checksum per project
  is enough for the catalog. After every sync the desktop writes
  `catalog.json` (format 2) at the SingZ root: one row per project —
  project.json and lyrics.json with Drive ids and md5s, nothing else. Written
  LAST so it never names missing files, byte-stable + md5-skipped when
  nothing changed. **The same comparison runs at all three levels**:
  catalog.json against the root listing's md5 (unchanged → the whole refresh
  is 2 requests and no project is asked about), project.json against the
  catalog row, each file against the doc. **The desktop diffs against Drive's
  own listing, never against the catalog it wrote last time** — two batched
  `('a' in parents or 'b' in parents)` queries (chunked 50, `fields=…,parents`)
  cover a library of any size, so a clean sync is 4 requests and drift (a file
  edited or deleted on Drive, a second desktop) is actually noticed. The
  catalog is pure output. Orphan FILES are trashed like orphan folders — a lane
  a re-split dropped would otherwise sit on Drive forever, and phones would
  keep listing it. Phones reuse their stored entries, refetching only changed
  projects (the doc + that folder's listings), so a downloaded song opens with
  zero requests (doc and lyrics kept offline by md5, stems by the native
  cache). Phones trust the catalog only
  while it names exactly the root's project folders (an older desktop
  pushing leaves it stale) and fall back to walking the folders otherwise,
  so old apps and old desktops keep working. The
  desktop also reconciles on
  launch, not only after saves — a sync killed mid-run self-heals next start.
  **Nothing calls `gdriveSync` directly any more**: writers mark the library
  dirty (`sync-dirty.ts` — a seq counter in settings.json, marked on both edges
  of long operations so a save overlapping a sync stays dirty) and
  `sync-scheduler.ts` owns the single-flight, a 4 s debounce with a 60 s max
  wait, backoff on offline/5xx, `blocked` on auth, and a sweep. `gdrive.ts`
  must never import the ledger — its own stemHashes/lyricsHash backfill would
  re-dirty every project forever. **The "is this copy current?" rule is one
  table, three runners**: `tests/shared/currency-cases.json` is read by
  `tests/unit/current.test.ts` (TS + the desktop mtime rule),
  `mobile/android/app/src/test/.../CacheCurrencyTest.kt`
  (`./gradlew :app:testDebugUnitTest`) and
  `mobile/scripts/test-swift-currency.sh` (swiftc, no simulator needed — a
  CocoaPods `test_spec` does NOT generate a test target for this pod). The
  rule itself lives in `CacheCurrency.kt`/`CacheCurrency.swift`/`current.ts`,
  apart from the file handling, so it can be tested without a device. The ledger decides WHETHER to sync, never
  WHAT to upload: scope stays the whole root, diffed against Drive. Every
  lyrics writer goes through `writeCache` (four of the seven used to reach
  Drive only by accident). E2E drivers on a signed-in dev machine must launch
  with SINGZ_NO_SYNC=1 (SINGZ_NO_LAUNCH_SYNC is the older, narrower opt-out)
  or every test run syncs the real Drive (two dev builds of different vintages
  then rewrite the catalog at each other). OAuth client config: mobile/gdrive.config.json (gitignored;
  CI injects from the GDRIVE_CONFIG repo secret; postinstall/build scripts
  generate the gdrive-config.ts modules from it — both are gitignored, never
  in the repo, EMPTY when the json is absent, so a fresh checkout needs
  npm install before typecheck). Tests: tests/unit/mock-drive.ts is a mini
  Drive v3 used by
  gdrive-sync.test.ts AND the emulator streaming E2E (config apiBase →
  http://10.0.2.2:8765, tokens seeded via run-as into shared_prefs).

## Conventions

- **Every commit is reviewed first, and the gate enforces it** — launch the
  `code-reviewer` agent (`.claude/agents/`) on the staged diff, act on what it
  reports (fix it, or say why not), then commit. It edits nothing; on a clean
  verdict it writes the staged tree hash to `.git/singz-reviewed`, and
  `.claude/hooks/require-review.sh` (PreToolUse/Bash, `.claude/settings.json`)
  refuses `git commit` unless that marker matches the tree being committed —
  so what ships is what was read, and staging one more hunk sends you back for
  another look. Stage exactly what you mean to ship *before* launching it.
  The forms whose tree is NOT the index are refused outright rather than
  gated, because no review of the index can vouch for them: `-a/-am/--all`
  sweeps up every modified tracked file, `-i/--include`, `-o/--only` and
  `-p/--patch` compose their own tree, `git commit -- <paths>` takes
  working-tree contents for those paths, and `-C/--git-dir` aims at a
  repository this gate cannot see. **Staging and committing in one call is
  refused too** (`git add … && git commit …`): the hook reads the index before
  the command runs, so the tree it approves is the one from before the
  staging — stage in its own call, review, then commit.
  There is no exemption for a merge or rebase
  in progress — a clean merge never runs `git commit` at all, so reaching the
  gate mid-merge means someone resolved conflicts by hand, which is exactly
  the code worth reading; `merge|rebase|cherry-pick --continue` is gated for
  the same reason, since it commits one without saying the word.
  `.claude/hooks/require-review.test.sh` is the truth table — every case in it
  is there because the gate got it wrong once; run it after touching the hook.
  `SINGZ_SKIP_REVIEW=1 git commit …` (leading env assignment, not merely
  quoted in the message) is the deliberate way past, and it shows up in the
  transcript as one.
- **A vendored binary must say which sources it came from, and `vendor/` is
  mirrored per worktree** — `resolveAnalyze` returns whatever file sits in the
  slot, and the only currency check in the running app (the CLI's
  `kPitchDetectVersion` against the renderer's `PITCH_DETECT_VERSION`) catches
  a binary from before a stamp bump but NOT a same-version binary built from
  different code. During the v0.19.0 cut a sibling worktree ran
  `vendor-analyze.sh`, which wrote THROUGH the shared `vendor` symlink into the
  main checkout's slot, and the desktop spawned that branch's core — live-input
  adapter included, with `audio-devices-e2e.cjs` driving the very path it had
  changed — for hours; it was found by hand because the other session mentioned
  the rebuild. Nine worktrees on this machine held nine states of
  `mobile/native/core` behind one binary matching none of them. Two changes,
  and they answer different halves: `scripts/worktree-setup.sh` now MIRRORS
  `vendor/` (third-party engines stay symlinks to main; `singz-analyze` and
  `singz-capture.node` get per-worktree slots, and the setup script builds the
  one that has a producer on this tree — an empty slot degrades to the TS
  detectors, where a link runs another branch's engine), and
  `scripts/analyze-source-hash.sh` is the ONE definition of the fingerprint —
  written to the `.source-hash` sidecar, compiled into the binary
  (`singz-analyze build-info`), and recomputed at the first `resolveAnalyze()`
  by `src/main/analyze-provenance.ts`, which LOGS and never refuses. Packaged
  builds have no tree to compare against and only record what ran — the log is
  the only evidence a user machine will have. Details:
  [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) § Which core am I running?
- **Parallel feature work happens in git worktrees** (one per feature, e.g.
  under `.claude/worktrees/<feature>`), never as concurrent edits to the same
  checkout — two sessions on one tree fight over builds, caches and
  half-staged files. Bootstrap every fresh worktree with
  `scripts/worktree-setup.sh` (`--desktop-only` skips mobile): links vendor/,
  gdrive.config.json and local.properties from the main checkout, npm-ci's
  both roots, restores a cache-skipped electron binary, and pod-installs with
  the UTF-8 LANG CocoaPods needs in non-interactive shells (details:
  docs/DEVELOPMENT.md § Worktrees). Merge back to main when the feature
  lands. **ccache settings ride with the build, never with the machine** —
  a sibling worktree only hits when `base_dir` (this checkout) and
  `hash_dir=false` are passed, because CMake/Xcode compile with absolute
  paths and `-g` hashes the CWD; sharing the cache dir alone hits 0%.
  vendor-whisper.sh and run-with-ccache.js export them; Xcode gets them via
  mobile/scripts/ccache-xcode-conf.js (RN's wrapper replaces the machine
  config with its own, and GUI builds inherit no shell env).
- IPC handlers return result objects (`{ ok: false, error }`), never throw
  (avoids the "Error invoking remote method" prefix in the renderer).
- File access from the renderer is allowlisted in `src/main/media.ts` —
  register paths or roots before reading.
- Long jobs (separation, transcription, downloads) stream progress events and
  are cancellable; caches key on the 16-hex sha1 of the source file.
- `--controls-w` in styles.css must equal `CONTROLS_W` in model.ts.
- User-visible copy is sentence-case, friendly, and states sizes/time costs.
- Renderer perf rules (weak-iGPU fleet): rAF loops are change-gated to whole
  device pixels (value-identity gating still damages every vsync — sub-pixel
  `--p` steps kept the QHD+ Dell at 60%+ GPU) and skip under
  `body.modal-open`; canvases repaint on visible-state flips, never on the
  clock (pitch strip keys on bars-passed; its now-line is a 1px DOM layer);
  every infinite CSS animation needs a modal-open pause rule and must not
  outlive the state that justifies it (a paused count-in pulse held 20% GPU
  forever); `body.win` keeps solid, blur-free surfaces — modal scrim AND
  transport (any per-frame damage re-runs a backdrop blur above it).

## Releasing

Push to main freely once the user approves pushes; **releases are cut by
tagging `v*`** — CI builds mac (arm64+x64 dmg) + win (NSIS) + all three
splitter packs and attaches everything to the GitHub Release (gh-based
attach step, race-safe). **Hyphenated tags (`v0.14.1-test1`) become
prereleases**: never "latest", so updaters and the in-app pack URL ignore
them — the way to hand one tester a build (the tag may sit on a feature
branch; bump package.json to the full prerelease string). The Android workflow runs a cheap canary on
mobile/** pushes (npm ci + tsc — postinstall is the audio-api patch-drift
canary and synthesizes the bundled sample song via make-sample.js) and
builds the full APK only on `v*` tags / manual dispatch, attaching
`SingZ-<tag>-android.apk` to the release — the family fleet sideloads
that. Superseded same-ref runs auto-cancel. Bump `package.json` version to match
the tag (artifact names use it) — **and the iOS project with it**:
`MARKETING_VERSION` / `CURRENT_PROJECT_VERSION` in
`mobile/ios/SingZPlayer.xcodeproj/project.pbxproj` are the one place a version
is written down by hand (android/app/build.gradle reads package.json, the
desktop reads it too), and iOS treats an install of an unchanged version as
nothing to do — so a forgotten bump ships an `.ipa` that silently will not
replace the copy already on the phone. Engine steps are cached keyed on the vendor
scripts' hash. Releases must stay public (the in-app GPU-pack URL uses
`releases/latest/download/`). `HF_TOKEN` repo secret = read-only, build-time.

Release notes are written BEFORE tagging, as part of cutting the release:
diff against the previous tag (`git log <prev>..HEAD --oneline` plus what
you know shipped) and commit `docs/release-notes/v<version>.md` together
with the version bump — first line `v<version> — <tagline>` becomes the
release title, the rest (after a blank line) the body. Both workflows'
attach steps read that file at create time, so the release goes public
already titled and noted while artifacts stream in; a tag without its file
falls back to the bare create (fix it with `gh release edit`). Notes are
user-facing and genuinely funny — singer's-eye view, not commit prose: what
they can do now, what stopped being annoying, sizes/time costs where they
matter. Group by platform when it helps. Writing them is part of cutting
the release, not optional polish.

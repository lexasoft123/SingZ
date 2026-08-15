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
npm run build        # bundle into out/  — ALWAYS build before driving E2E
npm run dist         # package installer for current platform
npx electron .       # run the built app (out/) without packaging
scripts/vendor-whisper.sh   # build whisper-cli into vendor/<platform>-<arch>/
scripts/build-gpu-pack.sh   # torch/MPS splitter pack (Apple Silicon)
scripts/build-onnx-pack.sh  # demucs-onnx splitter pack (win32-x64 | darwin-x64)
cd mobile && npx jest                                  # phone-side Drive logic
cd mobile/android && ./gradlew :app:testDebugUnitTest   # Kotlin cache-currency table
mobile/scripts/test-swift-currency.sh                   # Swift cache-currency table
```

All vendor scripts skip-guard on existing outputs; delete `vendor/…` to force.

## Verification policy

UI or engine changes are verified by driving the real app with
`playwright-core`'s `_electron` (session drivers live in the scratchpad, never
in the repo; permanent harnesses are `tests/e2e/win-smoke.cjs` (run by
the E2E Windows workflow, which also runs `npm test`) and the mac drivers
in `tests/e2e/mac/` (align + wizard/consent, used by the `e2e-verifier`
agent in `.claude/agents/` — launch one instance per platform in parallel
for cross-platform verification) — vitest unit tests in
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
**Automated runs are silent** — sound is only for a human listening
(end-user checks/demos). Desktop drivers launch with `SINGZ_MUTE=1`
(→ Chromium mute-audio; analysers, sinkId and timing behave exactly as
audible — permanent drivers set it themselves, scratchpad drivers must
too); sim tests zero `__test.engine.master.gain` after the hook-wait
(metronome clicks bypass master, so that test passes `volume: 0` —
`clickCount` still counts); the Android emulator gets
`adb shell cmd media_session volume --stream 3 --set 0` (the old
`media volume` is gone on API 36; `--set 10` to hear it again for a
human demo). Details + env hooks:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
Mobile has its own permanent sim-driven tests in `mobile/tests/`
(`seek-memory.cjs`, `open-close-memory.cjs`, `loop-region.cjs`,
`offline-cache.cjs`, `custom-track.cjs`): CDP over Metro against the iOS
Simulator — run them
after engine or loading changes. Pure-JS mobile logic that no device can show
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
the `singz.crumb` pref over `adb run-as` instead, which touches no JS. Debug
builds only — release APKs have no inspector. Metro also lists *every*
connected app, so pick the target by `deviceName` or a stray simulator will
answer your evals while you measure the phone.

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
- **CSS Grid**: definitely-placed items (the scrub overlay) are placed first;
  give every sibling an explicit `gridRow` or they land in implicit rows.
- **React-managed `className` wipes imperative classes** on re-render —
  re-assert per frame (count-in dots pattern in LyricsPanel).
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
the tag (artifact names use it). Engine steps are cached keyed on the vendor
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

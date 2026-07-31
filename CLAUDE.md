# SingZ — instructions for Claude Code

Electron desktop app for singers: split songs into six stems (htdemucs_6s), karaoke with
synced lyrics (LRCLIB + whisper.cpp), pitch matching, transpose, vocal training
(chosen stems drop out on a time or lyric-line schedule), projects.
Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Commands

```bash
npm run dev          # electron-vite dev (HMR; restarts main on src/main changes)
npm run typecheck    # tsc over node (main/preload) + web (renderer) configs
npm test             # vitest unit tests (FLAC roundtrip, v1->v2 migration; electron stubbed)
npm run build        # bundle into out/  — ALWAYS build before driving E2E
npm run dist         # package installer for current platform
npx electron .       # run the built app (out/) without packaging
scripts/vendor-whisper.sh   # build whisper-cli into vendor/<platform>-<arch>/
scripts/build-gpu-pack.sh   # torch/MPS splitter pack (Apple Silicon)
scripts/build-onnx-pack.sh  # demucs-onnx splitter pack (win32-x64 | darwin-x64)
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
path as drag-drop. Read the screenshots you take. Details + env hooks:
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
- **CSS Grid**: definitely-placed items (the scrub overlay) are placed first;
  give every sibling an explicit `gridRow` or they land in implicit rows.
- **React-managed `className` wipes imperative classes** on re-render —
  re-assert per frame (count-in dots pattern in LyricsPanel).
- **whisper.cpp `-ml 1` emits occasional backward word offsets** — sanitize
  before aligning (see `alignLines`).
- **LRC gives line starts only** — word timing is estimated at ~12 chars/sec,
  never stretched to the next timestamp (lag), unless AI-aligned.
- **Splitting requires a downloaded pack** (no bundled engine since 0.3.0),
  and every split is six stems (htdemucs_6s; silent guitar/piano lanes are
  hidden in the UI): torch/MPS on Apple Silicon; demucs-onnx elsewhere
  (DirectML on Windows with a `dml-disabled.json` marker after failures —
  including pathologically slow sessions caught by the chunk-pace watchdog
  (WARP/remote-desktop adapters); CPU
  on Intel Macs — CoreML crashes compiling the graph). Every downloaded
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
- **zsh**: `status` is a read-only variable in scripts.
- **npm majors**: `@vitejs/plugin-react` must match electron-vite's supported
  Vite major (currently plugin ^5 with electron-vite 5 / Vite 7).
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
  use. `fetchToCache` only short-circuits on a size match, which is the wrong
  question — a re-split WAV is the same length and different audio — so JS
  keeps the md5 of every file it fetched (`singz.gdrive.have`) and passes
  `expectedBytes: 0` to force a real download when it differs. The Drive
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
  After every sync the desktop writes `catalog.json` (format 2) at the
  SingZ root: one row per project — project.json and lyrics.json with Drive
  ids and md5s, nothing else (lyrics.json rides separately because the
  aligner rewrites it without touching the doc). Written LAST so it never
  names missing files, byte-stable + md5-skipped when nothing changed.
  Both sides diff against it: the desktop skips per-project round-trips for
  fingerprint-matched projects (a clean sync is 3 requests), and phones
  reuse their stored entries, refetching only changed projects (the doc +
  that folder's listings) — a quiet refresh is 3 requests however big the
  library, and a downloaded song opens with zero (doc and lyrics kept
  offline by md5, stems by the native cache). Phones trust the catalog only
  while it names exactly the root's project folders (an older desktop
  pushing leaves it stale) and fall back to walking the folders otherwise,
  so old apps and old desktops keep working. The
  desktop also reconciles on
  launch, not only after saves — a sync killed mid-run self-heals next start;
  E2E drivers on a signed-in dev machine must launch with
  SINGZ_NO_LAUNCH_SYNC=1 or every test run syncs the real Drive (two dev
  builds of different vintages then rewrite the catalog at each other). OAuth client config: mobile/gdrive.config.json (gitignored;
  CI injects from the GDRIVE_CONFIG repo secret; postinstall/build scripts
  generate the gdrive-config.ts modules from it — both are gitignored, never
  in the repo, EMPTY when the json is absent, so a fresh checkout needs
  npm install before typecheck). Tests: tests/unit/mock-drive.ts is a mini
  Drive v3 used by
  gdrive-sync.test.ts AND the emulator streaming E2E (config apiBase →
  http://10.0.2.2:8765, tokens seeded via run-as into shared_prefs).

## Conventions

- **Parallel feature work happens in git worktrees** (one per feature, e.g.
  under `.claude/worktrees/<feature>`), never as concurrent edits to the same
  checkout — two sessions on one tree fight over builds, caches and
  half-staged files. Bootstrap every fresh worktree with
  `scripts/worktree-setup.sh` (`--desktop-only` skips mobile): links vendor/,
  gdrive.config.json and local.properties from the main checkout, npm-ci's
  both roots, restores a cache-skipped electron binary, arms ccache content
  hashing, and pod-installs with the UTF-8 LANG CocoaPods needs in
  non-interactive shells (details: docs/DEVELOPMENT.md § Worktrees). Merge
  back to main when the feature lands.
- IPC handlers return result objects (`{ ok: false, error }`), never throw
  (avoids the "Error invoking remote method" prefix in the renderer).
- File access from the renderer is allowlisted in `src/main/media.ts` —
  register paths or roots before reading.
- Long jobs (separation, transcription, downloads) stream progress events and
  are cancellable; caches key on the 16-hex sha1 of the source file.
- `--controls-w` in styles.css must equal `CONTROLS_W` in model.ts.
- User-visible copy is sentence-case, friendly, and states sizes/time costs.
- Renderer perf rules (weak-iGPU fleet): rAF loops are change-gated and skip
  under `body.modal-open`; every infinite CSS animation needs a modal-open
  pause rule; Windows keeps the solid (blur-free) modal scrim.

## Releasing

Push to main freely once the user approves pushes; **releases are cut by
tagging `v*`** — CI builds mac (arm64+x64 dmg) + win (NSIS) + all three
splitter packs and attaches everything to the GitHub Release (gh-based
attach step, race-safe). The Android workflow runs a cheap canary on
mobile/** pushes (npm ci + tsc — postinstall is the audio-api patch-drift
canary and synthesizes the bundled sample song via make-sample.js) and
builds the full APK only on `v*` tags / manual dispatch, attaching
`SingZ-<tag>-android.apk` to the release — the family fleet sideloads
that. Superseded same-ref runs auto-cancel. Bump `package.json` version to match
the tag (artifact names use it). Engine steps are cached keyed on the vendor
scripts' hash. Releases must stay public (the in-app GPU-pack URL uses
`releases/latest/download/`). `HF_TOKEN` repo secret = read-only, build-time.

After pushing a tag, write the release notes yourself: diff against the
previous tag (`git log <prev>..<tag> --oneline` plus what you know shipped),
then `gh release edit <tag> --notes` with user-facing, genuinely funny notes —
singer's-eye view, not commit prose: what they can do now, what stopped being
annoying, sizes/time costs where they matter. Group by platform when it helps.
The CI workflows create the release with empty notes; filling them is part of
cutting the release, not optional polish.

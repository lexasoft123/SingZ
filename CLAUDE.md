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
in the repo; the one permanent CI harness is `tests/e2e/win-smoke.cjs`, run by
the E2E Windows workflow, which also runs `npm test` — vitest unit tests in
`tests/unit/` covering the v2 FLAC format with electron aliased to a stub).
Load files through the hidden `<input type=file>` — same code
path as drag-drop. Read the screenshots you take. Details + env hooks:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).
Mobile has its own permanent sim-driven tests in `mobile/tests/`
(`seek-memory.cjs`, `loop-region.cjs`): CDP over Metro against the iOS
Simulator — run them after engine or loading changes.

## Hard-won gotchas (do not re-learn these)

- **userData identity**: `Electron out/main/index.js` → userData "Electron";
  `npm run dev`/`npx electron .` → "singz"; packaged → "SingZ". Caches differ
  per identity — shared things (model weights, GPU pack) deliberately live in
  `~/Library/Application Support/SingZ/` via `modelsDir()`/`packDir()`.
- **Never `fetch()` custom protocols from `file://` pages** — blocked in prod
  builds. Audio bytes go over IPC (`media:read`).
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
  on Intel Macs — CoreML crashes compiling the graph). ONNX packs get a
  renderer-rendered 44.1 kHz WAV (`needsPcm`). Packs are versioned via
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

## Conventions

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
attach step, race-safe). Bump `package.json` version to match
the tag (artifact names use it). Engine steps are cached keyed on the vendor
scripts' hash. Releases must stay public (the in-app GPU-pack URL uses
`releases/latest/download/`). `HF_TOKEN` repo secret = read-only, build-time.

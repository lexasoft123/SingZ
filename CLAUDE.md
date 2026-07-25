# SingZ — instructions for Claude Code

Electron desktop app for singers: split songs into stems (demucs), karaoke with
synced lyrics (LRCLIB + whisper.cpp), pitch matching, transpose, projects.
Deeper docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md),
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

## Commands

```bash
npm run dev          # electron-vite dev (HMR; restarts main on src/main changes)
npm run typecheck    # tsc over node (main/preload) + web (renderer) configs
npm run build        # bundle into out/  — ALWAYS build before driving E2E
npm run dist         # package installer for current platform
npx electron .       # run the built app (out/) without packaging
scripts/vendor-whisper.sh   # build whisper-cli into vendor/<platform>-<arch>/
scripts/vendor-demucs.sh    # build demucs-cli + fetch htdemucs ggml weights
scripts/build-gpu-pack.sh   # optional GPU pack (Apple Silicon only)
```

All vendor scripts skip-guard on existing outputs; delete `vendor/…` to force.

## Verification policy

UI or engine changes are verified by driving the real app with
`playwright-core`'s `_electron` (drivers live in the session scratchpad, never
in the repo). Load files through the hidden `<input type=file>` — same code
path as drag-drop. Read the screenshots you take. Details + env hooks:
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md).

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
- **demucs.cpp**: 44.1 kHz input only (renderer renders WAV from its decoded
  buffer); CPU-only; `-march=native` is patched to `x86-64-v2` for Windows
  distribution (CI Xeon AVX-512 crashes user CPUs).
- **HF hub caches checkpoints as extension-less blobs** — never glob for
  `*.safetensors` under `HF_HOME`.
- **electron-builder**: `files` must exclude `vendor/`, `.engines-src/` etc. or
  they land in the asar (was 241 MB); `${os}` macro is `mac`/`win`, NOT node's
  `darwin`/`win32` — extraResources are declared per-platform.
- **macOS ad-hoc signing is mandatory** (scripts/afterPack.cjs): repacked
  Electron has a broken signature and quarantined downloads show the
  unrecoverable "app is damaged" dialog. Hook skips itself when CSC_* is set.
- **zsh**: `status` is a read-only variable in scripts.
- **npm majors**: `@vitejs/plugin-react` must match electron-vite's supported
  Vite major (currently plugin ^5 with electron-vite 5 / Vite 7).

## Conventions

- IPC handlers return result objects (`{ ok: false, error }`), never throw
  (avoids the "Error invoking remote method" prefix in the renderer).
- File access from the renderer is allowlisted in `src/main/media.ts` —
  register paths or roots before reading.
- Long jobs (separation, transcription, downloads) stream progress events and
  are cancellable; caches key on the 16-hex sha1 of the source file.
- `--controls-w` in styles.css must equal `CONTROLS_W` in model.ts.
- User-visible copy is sentence-case, friendly, and states sizes/time costs.

## Releasing

Push to main freely once the user approves pushes; **releases are cut by
tagging `v*`** — CI builds mac (arm64+x64 dmg) + win (NSIS) + GPU pack and
attaches everything to the GitHub Release. Bump `package.json` version to match
the tag (artifact names use it). Engine steps are cached keyed on the vendor
scripts' hash. Releases must stay public (the in-app GPU-pack URL uses
`releases/latest/download/`). `HF_TOKEN` repo secret = read-only, build-time.

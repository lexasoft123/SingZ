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
One-time setup so hashes beat timestamps (fresh worktrees re-stamp mtimes):

```bash
ccache --set-config compiler_check=content
```

Running `mobile/android/gradlew` directly instead of `npm run android`? Prefix
`CMAKE_C_COMPILER_LAUNCHER=ccache CMAKE_CXX_COMPILER_LAUNCHER=ccache`.

A system `demucs` (pipx) is the easiest dev splitter — the app auto-prefers
it and no pack is needed. Otherwise build/install the pack for your platform:
`scripts/build-gpu-pack.sh` (Apple Silicon torch/MPS) or
`scripts/build-onnx-pack.sh darwin-x64|win32-x64` (~10 min cold each; both
embed the htdemucs_6s model and stamp `python/pack.json` with the format
version the app requires).

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

### Environment hooks (test/dev only)

| Variable | Effect |
|---|---|
| `SINGZ_NO_SYSTEM_ENGINES=1` | ignore system demucs — simulate a clean OS |
| `SINGZ_USERDATA_DIR` | isolate userData (drivers sharing "Electron" crash each other) |
| `SINGZ_MODELS_DIR` | relocate the shared model cache |
| `SINGZ_PACK_DIR` | relocate the GPU pack install dir |
| `SINGZ_GPU_PACK_URL` | pack download URL (point at a local http server) |
| `SINGZ_FAKE_MIC=1` | Chromium fake audio input for mic-matching tests |
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
- Half/double-time disambiguation for the tempo estimate.
- A–B loop for phrase practice; export karaoke mix to file.
- Whisper model picker in the model manager UI.

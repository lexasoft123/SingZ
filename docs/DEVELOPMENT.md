# Developing SingZ

## Setup

```bash
npm install
scripts/vendor-whisper.sh      # once per machine (needs cmake)
scripts/build-onnx-pack.sh     # splitter pack for win32-x64 / darwin-x64
npm run dev
```

A system `demucs` (pipx) is optional but makes splits ~35× faster on Apple
Silicon; the app auto-prefers it. `scripts/build-gpu-pack.sh` builds the
distributable GPU pack (Apple Silicon only, ~10 min cold).

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
the setup wizard must appear, download for real, and the bundled split must
produce four stems.

## Releasing

1. Bump `package.json` version (artifact names use it).
2. `git tag vX.Y.Z && git push origin vX.Y.Z`.
3. CI (`.github/workflows/build.yml`) builds mac arm64+x64 dmg, win x64 NSIS,
   compiles both engines and the GPU pack, ad-hoc signs mac bundles
   (`scripts/afterPack.cjs`), and attaches everything to the GitHub Release.

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

### Signing status

Builds ship ad-hoc signed (mac) / unsigned (win). To sign for real: remove
`identity: null` from electron-builder.yml, add `CSC_LINK`/`CSC_KEY_PASSWORD`
(+ `APPLE_ID`/`APPLE_APP_SPECIFIC_PASSWORD`/`APPLE_TEAM_ID` for notarization)
as CI secrets — the afterPack hook steps aside automatically. Windows options:
Azure Trusted Signing (`win.azureSignOptions`) or SignPath's OSS tier.

## Ideas parked for later

- ONNX + CoreML/DirectML splitter for GPU on more platforms.
- Half/double-time disambiguation for the tempo estimate.
- A–B loop for phrase practice; export karaoke mix to file.
- Whisper model picker in the model manager UI.

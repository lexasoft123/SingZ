# SingZ

A practice app for singers. Drop a song, see its timeline, split it into stems
(vocals / drums / bass / instruments) with AI, and mute any track while it plays —
kill the vocals and it's your karaoke machine.

![SingZ playing a song split into four stems, karaoke mode on](docs/screenshot.png)

Cross-platform desktop app: Electron + React + TypeScript, Web Audio for
sample-locked multitrack playback. Everything runs locally — no cloud, no
accounts. A fresh OS install needs nothing pre-installed: the AI engines ship
inside the app and the model weights download once through the built-in setup.

## What it does

- **Stems** — split any song into vocals / drums / bass / instruments; mute,
  solo and set volume per stem while it plays. Results are cached per file, so
  a song is only ever split once.
- **Karaoke mode** — lyrics in a side panel with live word-by-word highlighting
  (click a line to jump), count-in dots before entries after instrumental gaps,
  the vocal melody drawn as labeled note bars on a piano roll, and mic pitch
  matching with a live score. A "Guide vocals" toggle brings the original voice
  back at any time.
- **Lyrics** — fetched from [LRCLIB](https://lrclib.net) (time-synced, matched
  by tags + duration) the moment a song loads; a variant picker with manual
  search handles other recordings. When nothing is found online, the bundled
  [whisper.cpp](https://github.com/ggml-org/whisper.cpp) transcribes the vocals
  stem on-device, and "Refine timing" aligns synced lyrics to a transcription
  for word-exact karaoke timing.
- **Transpose** — pitch-shift the whole mix in semitones (Signalsmith Stretch
  on the master bus): tempo unchanged, stems stay in sync, the melody lane and
  detected key follow.
- **Song info** — detected key, tempo, vocal range and length, all
  transpose-aware.
- **Zoom** — one shared timeline viewport for waveforms and the pitch roll:
  pinch or ⌘-scroll to zoom (sample-accurate waveforms up close), two-finger
  scroll to pan, view follows the playhead.
- **Projects** — "Save project" copies the song, stems, lyrics and your
  settings (transpose/mutes/volumes) into `~/Music/SingZ/<name>/`; opening the
  project's song restores everything instantly.

## AI engines & models

The installer ships two small native engines; weights live in a shared local
cache (`~/Library/Application Support/SingZ/models` on macOS) and download
once via the first-run setup window:

| Piece | How it arrives | Size |
|---|---|---|
| whisper-cli (lyrics) | in the installer | ~3 MB |
| demucs-cli (splitter, CPU) | in the installer | ~2.5 MB |
| htdemucs weights | setup window, required | 81 MB |
| Whisper speech model | on first lyrics fallback, with consent | 466 MB–1.6 GB |
| **Fast splitter · GPU** (optional, Apple Silicon) | setup window → "Get" | 240 MB |

The GPU pack is a relocatable Python + PyTorch (MPS) + demucs with the
checkpoint embedded — it splits a 3-minute song in ~15–25 s instead of ~9 min
on CPU, and is auto-preferred once installed. A system-wide `demucs` install
(pipx) is also detected and preferred when present. Engine resolution can be
steered with `SINGZ_DEMUCS`, `SINGZ_WHISPER`, `SINGZ_WHISPER_MODEL`,
`SINGZ_MODELS_DIR`; `SINGZ_NO_SYSTEM_ENGINES=1` simulates a clean machine.
The header's "splitter" chip opens the model manager at any time.

## Develop

```bash
npm install
npm run dev
```

The bundled engines are vendored binaries — build them once per machine:

```bash
scripts/vendor-whisper.sh     # whisper.cpp  (needs cmake)
scripts/vendor-demucs.sh      # demucs.cpp + htdemucs ggml weights
scripts/build-gpu-pack.sh     # optional GPU pack (Apple Silicon only)
```

Keyboard: **space** play/pause, **←/→** seek ±5 s, **Esc** closes karaoke.

## Build & releases

```bash
npm run build      # bundles main/preload/renderer into out/
npm run typecheck
npm run dist       # package an installer for the current platform
```

CI ([.github/workflows/build.yml](.github/workflows/build.yml)) builds macOS
(arm64 + x64 dmg) and Windows (x64 NSIS) on every `v*` tag, compiles the
engines and the GPU pack, and attaches everything to the GitHub Release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The in-app GPU-pack download points at the latest release asset, so releases
must be publicly reachable (or set `SINGZ_GPU_PACK_URL`). Builds are unsigned
for now — macOS users right-click → Open on first launch, Windows shows a
SmartScreen prompt (and needs the VC++ runtime); to sign, remove
`identity: null` from [electron-builder.yml](electron-builder.yml) and add
certificate secrets in CI.

Contributor docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · [CLAUDE.md](CLAUDE.md)

## How it works

- **Main process** ([src/main](src/main)) — engine resolution ladder (system
  demucs → GPU pack → bundled demucs.cpp), model manager and downloads,
  whisper transcription + LRCLIB client + word alignment, project save/detect,
  stems cache by content hash, allowlisted file access over IPC.
- **Preload** ([src/preload](src/preload)) — small typed bridge (`window.singz`).
- **Renderer** ([src/renderer](src/renderer)) — React UI. `MultitrackEngine`
  schedules all stems on one AudioContext clock (sample-sync) with gain-ramp
  mute/solo and a Signalsmith Stretch node for transpose; melody extraction
  (YIN) runs in a worker; waveforms render from peak envelopes or raw samples
  depending on zoom; playback progress drives a single CSS variable so it
  costs no redraws.

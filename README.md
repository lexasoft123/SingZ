# SingZ

A practice app for singers. Drop a song, see its timeline, split it into six
stems (vocals / drums / bass / guitar / piano / instruments) with AI, and mute
any track while it plays — kill the vocals and it's your karaoke machine, kill
the guitar and it's your backing band.

![SingZ playing a song split into six stems — vocals, drums, bass, guitar, piano and instruments — karaoke mode on](docs/screenshot.png)

Cross-platform desktop app: Electron + React + TypeScript, Web Audio for
sample-locked multitrack playback. Everything runs locally — no cloud, no
accounts (an optional Google Drive sync puts your library on your own Drive
so the companion phone app can play it). A fresh OS install needs nothing
pre-installed: the app downloads its AI splitter pack once through the
built-in setup and keeps it updated automatically.

## What it does

- **Stems** — split any song into six tracks: vocals, drums, bass, guitar,
  piano and the rest; mute, solo and set volume per stem while it plays.
  Guitar and piano lanes appear only when the song actually has them. Results
  are cached per file, so a song is only ever split once.
- **Karaoke mode** — lyrics in a side panel with live word-by-word highlighting
  (click a line to jump), count-in dots before entries after instrumental gaps,
  the vocal melody drawn as labeled note bars on a piano roll, and mic pitch
  matching with a live score. A "Guide vocals" toggle brings the original voice
  back at any time.
- **Beat grid & metronome** — beats and bars read from the stems, fused with
  a neural beat model, landing at the tempo the sheet music actually says
  (verified against published scores — including songs every tracker wants
  to hear at double or half speed). Odd bars are found automatically: the
  lone 2/4 before a chorus, a 5/4 nobody warned you about, a piano intro
  with no drums to follow. Metronome clicks with count-in, the grid drawn
  over the waveforms — and every bar line is draggable, with a red badge
  wherever the detector knows it was guessing. Hand-placed bars survive
  re-detection.
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
  settings (transpose/mutes/volumes) into `~/Documents/SingZ/<name>/`;
  **Open…** browses your saved projects inside the app, recent ones sit right
  on the drop screen, and the pencil next to the title renames a project —
  folder on disk included.
- **Google Drive sync & phones** — one click connects your own Google Drive
  (drive.file scope: the app can see only the folder it creates); the
  desktop pushes the library after every save, md5-diffed so a clean sync
  is four requests and your media never re-uploads. The companion app in
  [mobile/](mobile) (React Native, iOS + Android) plays the synced library
  with the same karaoke lyrics, melody line and beat grid — songs cache on
  the phone and keep playing offline. The Android APK is attached to every
  release.
- **Log window** — the **Log** button shows what the app is doing under the
  hood (engines, downloads, lyrics search) and saves to a file for bug
  reports.

## AI engines & models

The installer ships whisper-cli (~3 MB) for lyrics; the splitter arrives as
one self-contained pack per platform, downloaded by the first-run setup
(htdemucs_6s model embedded — no further downloads to split):

| Platform | Engine | Size |
|---|---|---|
| macOS Apple Silicon | demucs on PyTorch/**MPS** (GPU — a song splits in seconds) | 208 MB |
| Windows x64 | demucs-onnx on **DirectML** (NVIDIA/AMD/Intel), automatic CPU fallback | 201 MB |
| macOS Intel | demucs-onnx on CPU | 177 MB |

Packs are versioned: when an update ships, the app notices and re-downloads
automatically. Machines whose GPU can't run the model are remembered after one
attempt and start on CPU instantly from then on. The Whisper speech model
(466 MB–1.6 GB) downloads only on the first lyrics fallback, with consent.
A system-wide `demucs` install (pipx) is detected and preferred when present.
Engine resolution can be steered with `SINGZ_DEMUCS`, `SINGZ_WHISPER`,
`SINGZ_WHISPER_MODEL`, `SINGZ_MODELS_DIR`; `SINGZ_NO_SYSTEM_ENGINES=1`
simulates a clean machine. The header's "splitter" chip opens the model
manager at any time (with a Reinstall button if an install ever misbehaves).

## Develop

```bash
npm install
npm run dev
```

whisper-cli is a vendored binary; the splitter packs are built by scripts:

```bash
scripts/vendor-whisper.sh              # whisper.cpp (needs cmake)
scripts/build-gpu-pack.sh              # torch/MPS pack (Apple Silicon)
scripts/build-onnx-pack.sh win32-x64   # demucs-onnx packs (also darwin-x64)
```

In dev, a system `demucs` (pipx) works out of the box — no pack needed.

Keyboard: **space** play/pause, **←/→** seek ±5 s, **Esc** closes karaoke.

## Build & releases

```bash
npm run build      # bundles main/preload/renderer into out/
npm run typecheck
npm run dist       # package an installer for the current platform
```

CI ([.github/workflows/build.yml](.github/workflows/build.yml)) builds macOS
(arm64 + x64 dmg) and Windows (x64 NSIS) on every `v*` tag, compiles
whisper-cli and all three splitter packs, and attaches everything to the
GitHub Release:

```bash
git tag v0.2.0 && git push origin v0.2.0
```

The in-app pack downloads point at the latest release assets, so releases
must be publicly reachable (or set `SINGZ_GPU_PACK_URL`).

**macOS builds are Developer ID-signed and notarized from the next release
onwards** — the pipeline does it, but no published release carries it yet, so
the steps below still apply to everything you can download today.

Until then, **macOS** (Sequoia and later) blocks the first launch with
*"Apple could not verify…"* — open **System Settings → Privacy & Security**,
scroll to *"SingZ" was blocked*, click **Open Anyway**, then launch again
(one time per version). Or in Terminal:

```bash
xattr -d com.apple.quarantine /Applications/SingZ.app
```

**Windows is still unsigned** and shows a SmartScreen prompt — *More info →
Run anyway*. The packs bundle their own MSVC runtime, so nothing else needs
installing. Clearing that prompt needs an Authenticode certificate; the
options are Azure Trusted Signing or SignPath's OSS tier (see
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md)).

Contributor docs: [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) ·
[docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) · [CLAUDE.md](CLAUDE.md)

## How it works

- **Main process** ([src/main](src/main)) — engine resolution (system demucs
  → the platform's splitter pack), model manager with versioned pack
  downloads, whisper transcription + LRCLIB client + word alignment, project
  library, stems cache by content hash, in-app diagnostic log, allowlisted
  file access over IPC.
- **Preload** ([src/preload](src/preload)) — small typed bridge (`window.singz`).
- **Renderer** ([src/renderer](src/renderer)) — React UI. `MultitrackEngine`
  schedules all stems on one AudioContext clock (sample-sync) with gain-ramp
  mute/solo and a Signalsmith Stretch node for transpose; melody extraction
  (probabilistic YIN with Viterbi decoding) runs in a worker; waveforms render
  from peak envelopes or raw samples
  depending on zoom; playback progress drives a single CSS variable so it
  costs no redraws.

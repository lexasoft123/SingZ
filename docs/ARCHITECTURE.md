# SingZ architecture

Electron app in three layers, communicating over a small typed IPC bridge
(`window.singz`, typed in [src/shared/types.ts](../src/shared/types.ts)).

```
renderer (React)               preload            main (Node)
──────────────────             ────────           ─────────────────────────────
MultitrackEngine (Web Audio)   window.singz  ──►  media.ts     allowlisted file access
TrackStack/Waveform (canvas)                      separation.ts engine ladder + runs
PitchStrip (piano roll + mic)                     lyrics.ts    LRCLIB→whisper ladder
LyricsPanel (synced lyrics)                       lrclib.ts    lrclib.net client
SetupWizard (model manager)                       models.ts    weights/pack downloads
App.tsx (orchestration)                           projects.ts  ~/Music/SingZ projects
```

## Audio playback (`renderer/src/audio/engine.ts`)

All stems are `AudioBufferSourceNode`s scheduled at the same context time →
sample-locked sync. Mute/solo/volume are `GainNode` ramps (click-free).
Transpose inserts one Signalsmith Stretch worklet on the **master bus**
(live-input mode, pitch only): phase-coherent across stems, tempo unchanged,
per-stem controls stay live. `engine.position` compensates output latency and
the stretch node's latency so UI (lyrics/playhead) matches what is heard.

Playback progress drives a single `--p` CSS variable from one rAF loop; the
"played" waveform layer is a clipped bright canvas — progress costs no redraws.

## Timeline & zoom

One shared viewport `{s, e}` (App state) feeds the lanes and the pitch strip:
identical scale, identical horizontal geometry (`--controls-w` + the stack's
padding). Waveforms render from a 2400-bucket envelope, switching to raw
min/max samples when fewer than ~600 buckets are visible. Pinch/⌘-wheel zooms
around the cursor; two-finger scroll pans; the view follows the playhead.

## Stem separation (`main/separation.ts`)

Engine ladder, resolved once and cached:

1. **System Python demucs** (pipx etc.) — fastest (torch GPU/MPS). Skipped
   when `SINGZ_NO_SYSTEM_ENGINES=1`.
2. **GPU pack** — app-managed relocatable Python+torch in
   `<appData>/SingZ/gpu-splitter/`, spawned with `TORCH_HOME`/`HF_HOME`
   pointing at the checkpoint embedded in the pack.
3. **Bundled demucs.cpp** (`resources/engines/demucs-cli`) — CPU floor,
   always present. Input must be 44.1 kHz: the renderer renders a WAV from its
   already-decoded buffer (`separation:provide-input`) so any source format
   works. Output `target_N_<stem>.wav` files are renamed into the cache layout.

Results cache: `<userData>/stems/<sha1-16>/htdemucs/{vocals,drums,bass,other}.wav`.

## Lyrics (`main/lyrics.ts`, `main/lrclib.ts`)

Ladder, auto-started when a song loads:

1. Per-song cache (`lyrics.json` next to stems, or in the project folder).
2. **LRCLIB** — matched by tags (music-metadata) or cleaned filename +
   duration (±5 s, synced-only). Word timing inside a line is distributed at
   ~12 chars/sec. Variant picker + manual search (`/api/search`, apply by id).
3. **whisper.cpp fallback** — bundled `whisper-cli` on the vocals stem,
   `-ml 1 --split-on-word` for word chunks; model weights download only after
   user consent. "Refine timing" aligns LRCLIB text onto a whisper
   transcription (anchor matching words, interpolate the rest, reject
   non-monotonic lines).

## Models & first-run setup (`main/models.ts`)

Registry of downloadables (htdemucs weights = required when no fast splitter;
GPU pack = optional, darwin-arm64). Shared cache `<appData>/SingZ/models`
regardless of app identity. The SetupWizard auto-downloads required items on
first run and offers optional ones; the header's splitter chip reopens it.
Archives are untarred with the system `tar`. URLs point at
`releases/latest/download/…` (repo must stay public) or Hugging Face.

## Projects (`main/projects.ts`)

"Save project" copies song + stems + lyrics + settings (transpose, per-stem
mute/solo/volume) into `~/Music/SingZ/<name>/` with a `project.json`. Opening
the project's song file restores everything (register detects the sibling
`project.json`; the lyrics ladder prefers the project-local `lyrics.json`).

## Analysis (renderer)

Melody: YIN pitch tracking over the decimated vocals stem in a Web Worker →
`f0` array. Key: Krumhansl-Schmuckler over the melody's pitch-class histogram.
Tempo: onset-flux autocorrelation over the drums stem (60–200 BPM, folded to
70–180 — can pick double-time on busy hats). Vocal range: p5–p95 of melody
notes. All displayed transpose-aware in the pitch strip's info card.

## On-disk layout

```
<userData>/stems/<sha1-16>/         per-song cache (stems, lyrics.json)
<appData>/SingZ/models/             shared model weights (whisper, htdemucs)
<appData>/SingZ/gpu-splitter/       optional GPU pack (python/, torch-home, hf-home)
~/Music/SingZ/<name>/               saved projects (song, stems/, lyrics.json, project.json)
```

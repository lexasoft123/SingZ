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
SetupWizard (model manager)                       models.ts    versioned pack downloads
LogPanel (diagnostics)                            log.ts       ring-buffer app log
App.tsx (orchestration)                           projects.ts  ~/Documents/SingZ projects
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

The metronome (`audio/beat.ts` + engine) walks the song's beat track (an
array of beat times — see Analysis) with a lookahead scheduler: synthesized
click buffers, scheduled on the context clock, bypassing the master bus
(never transposed/ducked) with the stretch node's latency added back so
clicks stay on the delayed stems. Loop-region wraps, varispeed and seeks
re-derive the walker. A count-in is a pre-roll in `play()`: the stems'
shared start time moves out past whole beats — the song's real preceding
beats when starting mid-song, extrapolated ones before the first beat — so
the music enters on a bar accent; `position` holds at the start point until
it does. Without a beat track (rubato — detection rejects free-tempo songs)
the count-in still works, degraded to the clock: 3 or 6 ticks at one per
wall-clock second (rate-independent, scheduled upfront — no walker), the
music entering one second after the last tick. Seeks and post-split
hot-swaps restart without a count-in.

## Timeline & zoom

One shared viewport `{s, e}` (App state) feeds the lanes and the pitch strip:
identical scale, identical horizontal geometry (`--controls-w` + the stack's
padding). Waveforms render from a 2400-bucket envelope, switching to raw
min/max samples when fewer than ~600 buckets are visible. Pinch/⌘-wheel zooms
around the cursor; two-finger scroll pans; the view follows the playhead.

## Stem separation (`main/separation.ts`)

Engine ladder, resolved once and cached:

1. **System Python demucs** (pipx etc.) — dev setups (torch GPU/MPS). Skipped
   when `SINGZ_NO_SYSTEM_ENGINES=1`.
2. **Splitter pack** — the required first-run download, app-managed
   relocatable Python in `<appData>/SingZ/gpu-splitter/`, always splitting
   into six stems (htdemucs_6s — guitar and piano included; the UI hides
   lanes that come back silent). Packs carry a `python/pack.json` format
   version; the app treats older formats as not installed so the wizard
   re-downloads them. Backends:
   - Apple Silicon: torch/MPS demucs, spawned with `TORCH_HOME`/`HF_HOME`
     pointing at the checkpoint embedded in the pack.
   - Windows: demucs-onnx via DirectML with CPU fallback (a
     `dml-disabled.json` marker skips DirectML after it fails once).
   - Intel Macs: demucs-onnx on CPU (CoreML crashes compiling the graph).
   ONNX engines read a plain 44.1 kHz WAV the renderer renders from its
   already-decoded buffer (`separation:provide-input`, `needsPcm`).

Without a pack (and no system demucs), splitting reports `needsModels` and
the app opens the model wizard. There is no bundled fallback engine.

Results cache: `<userData>/stems/<sha1-16>/htdemucs_6s/{vocals,drums,bass,guitar,piano,other}.wav`.

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

Registry of downloadables (the splitter pack = required unless a system
demucs exists). Shared cache `<appData>/SingZ/models` regardless of app
identity. The SetupWizard auto-downloads required items on
first run and offers optional ones; the header's splitter chip reopens it.
Archives are untarred with the system `tar`. URLs point at
`releases/latest/download/…` (repo must stay public) or Hugging Face.

## Projects (`main/projects.ts`)

"Save project" copies song + stems + lyrics + settings (transpose, per-stem
mute/solo/volume) into `~/Documents/SingZ/<name>/` with a `project.json`
(saving re-anchors the session inside the project). Opening the project's song
restores everything; `listProjects` powers the in-app Open… library and the
drop-screen shortcuts; `renameProject` renames the folder + metadata (the title
pencil). Legacy `~/Music/SingZ` migrates on startup.

A project folder does not have to live under the library root — copied, shared
and other-machine folders open from anywhere. Those save and rename **in
place**; `importProject` (the header's "Add to library…") is the only thing
that relocates one, copying or moving on explicit user action. `detectProject`
reports `inLibrary` so the UI knows which it is.

## Diagnostics (`main/log.ts`)

A ring buffer (4000 entries) in the main process; engines, downloads and
lyrics log every move (spawn command lines, child output with progress spam
filtered, exit codes). Streamed live to the renderer's Log panel
(header button), saveable to a text file — field bugs get diagnosed from
user-saved logs. Probe failures record the child's stderr.

## Analysis (renderer)

Melody: probabilistic YIN over the decimated vocals stem in a Web Worker —
every CMND trough becomes a weighted candidate (Beta(2,18) threshold prior,
Boltzmann anti-subharmonic bias), a banded Viterbi over pitch ×
voiced/unvoiced states decodes the melody path, then octave errors fold to a
running median and incredible runs drop (`pyin.ts` + `pitch.worker.ts`;
tuned against synced-lyrics ground truth). Key: Krumhansl-Schmuckler over the
melody's pitch-class histogram.
Beat track (`detectBeats`): onset flux over the drums stem, local-mean
normalized, then windowed autocorrelation peaks voted into one tempo family
(single-peak picks land on dotted/compound relatives on real drums), the
tempo octave chosen by onset support × interval steadiness × strong/weak
alternation (subdivisions lose) × a singable-tempo prior, and beats placed
by Ellis-style dynamic programming — following the few-percent tempo drift
of pre-click-track recordings — then snapped to nearby onsets. Rejection
gates, tuned on real stems: impulsive-flux share (pads/noise), window
consistency (rubato), onset support + active fraction (sparse anchors), and
median interval roughness (onset-chasing without a pulse) — clicks that
fight the music are worse than none.
Bar phase & meter: kick energy alone is a coin flip between beats 1 and 3
(both carry kick in most grooves — Soldier Of Fortune and Wanted Dead Or
Alive shipped half a bar off this way), so the downbeat is a weighted vote
of sharp events instead: mean windowed kick, band entrances out of silence,
the biggest well-separated low-band slams, bass chord changes (energy-gated
chroma novelty over the bass stem), vocal phrase entries after ≥2-bar rests
(vocals stem), and lyric lines sitting on a beat — weights calibrated
against a 12-song ground-truth set from the user's library. Votes are
counted per segment (drum-active stretches split by ≥2-bar gaps): silent
intros never vote, and when a song re-enters after a fermata on a different
bar parity (Turn The Page's last chorus), the gap's filler beats are
re-spaced so one downbeat index is right on both sides. Meter: when 3-beat
periodicity of the onset envelope dwarfs 4-beat (windowed-lag max — the
median period is a fraction of a frame off and by ×4 lands between sharp
peaks), the tracked pulse is a compound song's eighth and accents group in
6 (Nothing Else Matters), with drum cues muted for the rotation (the
mid-bar tom is idiomatic there) in favor of bass/lyrics. The result drives
the metronome, count-in and bpm readout, and is saved in `project.json`
(`settings.beat`, millisecond-rounded) where hand edits (tap tempo, nudges,
×½/×2) win over re-detection; auto tracks carry `detVersion` and are
silently re-tracked on load when the detector has since improved. Vocal range: p5–p95 of melody notes. All displayed
transpose-aware in the pitch strip's info card.

## On-disk layout

```
<userData>/stems/<sha1-16>/         per-song cache (stems, lyrics.json)
<appData>/SingZ/models/             shared model weights (whisper)
<appData>/SingZ/gpu-splitter/       splitter pack (python/, model caches, pack.json)
~/Documents/SingZ/<name>/           saved projects (song, stems/, lyrics.json, project.json)
```

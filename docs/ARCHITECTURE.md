# SingZ architecture

Electron app in three layers, communicating over a small typed IPC bridge
(`window.singz`, typed in [src/shared/types.ts](../src/shared/types.ts)).

```
renderer (React)               preload            main (Node)
──────────────────             ────────           ─────────────────────────────
MultitrackEngine (Web Audio)   window.singz  ──►  media.ts     allowlisted file access
TrackStack/Waveform (canvas)                      separation.ts engine ladder + runs
PitchStrip (piano roll + mic)                     lyrics.ts    LRCLIB→whisper ladder
BeatGrid (beat lines over the lanes)
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
clicks stay on the delayed stems. Bar starts ring a brighter accent click
unless `metronome.accent` is off — the escape hatch when a song's downbeat
is contested (and a preference in its own right); off means every click,
count-ins included, sounds identical. Loop-region wraps, varispeed and seeks
re-derive the walker. A count-in is a pre-roll in `play()`: the stems'
shared start time moves out past whole beats — the song's real preceding
beats when starting mid-song, extrapolated ones before the first beat — so
the music enters on a bar accent, sized by the bar length at the entry beat
(`barLengthAt` — a count-in into a 3-beat bar counts 3); `position` holds at
the start point until it does. Without a beat track (rubato — detection rejects free-tempo songs)
the count-in still works, degraded to the clock: 3 or 6 ticks at one per
wall-clock second (rate-independent, scheduled upfront — no walker), the
music entering one second after the last tick. Seeks and post-split
hot-swaps restart without a count-in.

`metronome.grid` draws the same beat track over the waveforms
(`components/BeatGrid.tsx`, one canvas spanning the ruler and every lane in
the stack's grid, above the lanes and below the scrub overlay): a device-pixel
hairline per beat, bar starts in accent with their number in the ruler. It is
the only place the grid is visible against the audio it claims to describe —
a beat off its transient, or a "1" on the wrong beat, shows here and nowhere
else, which is what the box's nudge and `1→` controls are for. Beats disappear
below 5 px apart (they mean nothing once they touch); bar lines instead double
their stride until they fit — in bars, not pixels, so panning never re-picks
which bars are drawn and the survivors stay on phrase boundaries. `grid` is the
one metronome preference a project does not override on open: it is how the
singer looks at any song, not part of this one. Nothing on it moves with the
clock: it is fixed to song time, so it repaints on zoom, pan, resize and grid
edits only — the playhead crossing it is the scrub overlay's own 1px layer.

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

**Custom tracks** are audio files the singer adds as extra lanes ("+ Add track…"
above the lane names): a backing track, a harmony they recorded, a click. They
play from 0:00 alongside the stems, carry the same mute/solo/volume (stored in
`settings.tracks` under their id), can be longer or shorter than the song (the
timeline follows the longest lane, and each waveform is drawn against its own
duration), and survive a split — the stems replace the full-mix lane, added
lanes stay. Saving copies each file into the project's `stems/` folder as
`custom-<slug>.<ext>`, keeping its original format: `stems/` is the folder
Drive sync uploads and the phones fetch, and the prefix keeps a track named
"vocals" clear of the stem. `project.json` stores them project-relative
(`settings.custom`), resolved to absolute paths on the way out so the folder
stays portable; removing a lane and saving prunes its copy. Lanes rename inline
(pencil or double-click on the name) — that changes the **label only**: the id
stays, and the id is both the mixer key in `settings.tracks` and the file name
in `stems/`, so a rename moves no audio, re-uploads nothing to Drive, costs the
phones no re-download, and keeps the lane's mute/solo/volume.

The phones play them too. `customTracks()` (mobile/src/model.ts) is the trust
boundary: only a plain `stems/<name>` entry is used — an absolute path (what the
desktop holds in memory) or a `..` is dropped, as is an id that would shadow a
stem. `loadProject` fetches each one after the six stems, through the same
FolderAccess/Drive readers (both take a project-relative path, so no native
change was needed), and skips one it cannot fetch or decode rather than sinking
a song whose stems are all there. Lanes carry their desktop label and colour
into the mixer and the training picker. Memory: stems are projected from the
first decoded one, but an added track can be any length, so each is measured
against the budget as it lands. The Drive listing counts their bytes, so the
catalog's ✓ waits for them; a *folder* library's ✓ still comes from the natives'
six-stem scan, so it can turn green a moment early there.

A project folder does not have to live under the library root — copied, shared
and other-machine folders open from anywhere. Those save and rename **in
place**; `importProject` (the header's "Add to library…") is the only thing
that relocates one, copying or moving on explicit user action. `detectProject`
reports `inLibrary` so the UI knows which it is.

## Cloud sync (`main/gdrive.ts`, `sync-plan.ts`, `sync-dirty.ts`, `sync-scheduler.ts`)

The desktop publishes the library to a visible "SingZ" folder in the singer's
own Google Drive; the phones read it. drive.file scope (the app only ever sees
files it created, so no Google verification), one Desktop-type OAuth client for
every platform, loopback redirect.

**One rule, three levels.** Everything — both directions — asks the same
question: *does what I have match the checksum the level above states?*

| level | the thing | who states its checksum |
|---|---|---|
| 1 | `catalog.json` | Drive's own listing of the root |
| 2 | `project.json` | the catalog's row for that project |
| 3 | every stem, and `lyrics.json` | `project.json` (`stemHashes`, `lyricsHash`) |

So `project.json` names every file a project is made of, and the catalog needs
exactly one checksum per project. A phone whose catalog md5 is unchanged spends
2 requests on a refresh and asks about no project at all; a changed row costs
that project's doc plus its two folder listings, and nothing else.

**"Do I have this file?" is asked of the file, never of a record.** The natives
(`CacheCurrency.kt` / `.swift`) compare size, then md5 — hashes memoised
against size+mtime so a song hashes once — and the library ✓ (`isDownloaded`)
runs the same comparison minus the hashing. The rule lives in one shared table
(`tests/shared/currency-cases.json`) that TypeScript, Kotlin and Swift all run,
because it was implemented three times and drifted, which is how a song came to
sit in the library ticked while every open re-downloaded it.

**Writing.** `gdriveSync` diffs against **Drive's own listing**, never against
the catalog it wrote last time: the root, then two batched
`('a' in parents or 'b' in parents)` queries (chunked 50) covering every project
folder and every `stems/`. A clean library is 4 requests whatever its size, and
drift — a file edited or deleted on Drive, a second desktop — is actually
noticed. Stems upload before the doc, so an interrupted run leaves Drive
*behind* `project.json` rather than ahead of it (a doc naming bytes Drive cannot
serve makes phones delete a good stem and refuse to open the song). Orphan files
and folders are trashed, never hard-deleted. `catalog.json` is written last and
is pure output.

**When to sync.** Writers mark the library dirty (`sync-dirty.ts`: a seq counter
in `settings.json`, marked on *both* edges of long operations so a save that
overlaps a run stays dirty) and `sync-scheduler.ts` owns everything else — a 4 s
debounce with a 60 s max wait, single-flight, backoff on offline/5xx, `blocked`
on auth, a sweep, and the launch reconcile. The ledger decides *whether* to run,
never *what* to upload: the scope stays the whole root, diffed against Drive,
because a ledger is only ever as complete as our memory of every writer.
`gdrive.ts` must not import it — the sync's own `stemHashes` backfill would
re-dirty every project forever.

## Diagnostics (`main/log.ts`)

A ring buffer (4000 entries) in the main process; engines, downloads, lyrics
and the Drive sync log every move (spawn command lines, child output with
progress spam filtered, exit codes). Streamed live to the renderer's Log panel
(header button), saveable to a text file — field bugs get diagnosed from
user-saved logs. Probe failures record the child's stderr.

The sync also appends to `userData/sync-log.jsonl` (one line per run, upload,
trash and failure) and **replays it into the same panel at launch**, because
"the phone is showing yesterday's mix" is always a question about a previous
session and a ring buffer starts every launch empty. One dialog, not two.

The phone has the same panel (`mobile/src/log.ts`, `ui/LogPanel.tsx`, opened
from the header), with Share where the desktop has Copy. It persists its whole
log in prefs, because phones are killed rather than quit — and because a
release APK has no inspector and no `run-as`, what the app wrote down is the
only evidence a field report can carry.

## Analysis (renderer)

Melody: probabilistic YIN over the decimated vocals stem in a Web Worker —
every CMND trough becomes a weighted candidate (Beta(2,18) threshold prior,
Boltzmann anti-subharmonic bias), a banded Viterbi over pitch ×
voiced/unvoiced states decodes the melody path, then octave errors fold to a
running median and incredible runs drop (`pyin.ts` + `pitch.worker.ts`;
tuned against synced-lyrics ground truth). Key: Krumhansl-Schmuckler over the
melody's pitch-class histogram.
The tracked line is saved as `settings.melody` (`melody.ts`): per-frame cents
above 55 Hz as a token stream — an integer per voiced frame, `xN` for N
unvoiced ones — which puts a four-minute song around 20 kB of readable
project.json, next to stems measured in tens of megabytes. A song then opens
with its pitch strip already drawn instead of paying seconds of pYIN every
time, and the phones (no tracker of their own, exactly as with the beat grid)
get the same line the singer practised against. Stored lines carry
`detVersion`, and one written by an older tracker is silently re-tracked on
load — so `PITCH_DETECT_VERSION` must be bumped with any change to pyin's
parameters, the worker's framing, or the cleaner's gates, or every project in
the library keeps drawing the old line forever. The corrected line saves
itself into an existing project (never creating one), on the same deferred
save as a re-detected grid.
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
bar parity (Turn The Page's last chorus), each side keeps its own phase via
explicit `downbeats` (bar starts as beat indices) — the boundary bar is
simply an odd length, and beat times are never mutated to force one global
rotation (the pre-v5 detector re-spaced the silent gap's beats instead,
falsifying their times). Meter: when 3-beat
periodicity of the onset envelope dwarfs 4-beat (windowed-lag max — the
median period is a fraction of a frame off and by ×4 lands between sharp
peaks), the tracked pulse is a compound song's eighth and accents group in
6 (Nothing Else Matters), with drum cues muted for the rotation (the
mid-bar tom is idiomatic there) in favor of bass/lyrics. Phrase starts are
deliberately weak evidence and never folded or boosted: NEM's verses enter
two-three eighths AFTER the bar line ("So close…" floats over the one at
0:59.94, where the band lands) — a mid-fix attempt to read lines as
pickups-onto-the-one inverted the song's accent and was reverted; the ear
test for the rotation is the band entrance, which the entrance/slam cues
already vote. The result drives
the metronome, count-in and bpm readout, and is saved in `project.json`.
Where the drums fall silent for 8+ s (picked intros — Nothing Else Matters
is drumless for 41 s — outros, long breakdowns) the OTHER instrument stems'
impulsive onsets fill the tracking envelope: the tempo/octave decision and
all accept/reject gates stay drums-only (fill evidence once octave-doubled
a song), the filled placement is spliced in strictly inside the drum-free
spans, sustained-only material contributes nothing (rubato rejection intact),
and bass is a downbeat voter but never fill. The grid then covers the intro
with real tracked beats instead of constant-tempo extrapolation.
Neural lattice (v10): when a splitter pack is installed it also carries the
Beat This! model (CPJKU, MIT; 77 MB final0 checkpoint — torch on the MPS
pack, a 1500-frame ONNX export with a matmul-DFT log-mel graph on the ONNX
packs, CPU-only there by design), spawned by main as `python/beat_runner.py`
over the `beats:mlDetect` IPC; the renderer offline-renders the loaded stems
to a 22.05 kHz mono mix and passes the model's beats/downbeats plus framewise
head probabilities into `detectBeats` as `aux.ml`. Fusion is by measurement,
not ideology: on drum-strong songs the homegrown lattice wins outright (its
beat count follows real drum onsets through musical seams the model smooths
away — NEM crosses 414 true eighths in 413 model beats), so the entire user
library keeps byte-identical v9 grids; the model's lattice takes over where
homegrown rejects (drumless, soft material — steadiness-gated so true rubato
still falls through to rejection and the wall-clock count-in), and where
homegrown cannot even express the answer — a steady lattice whose bars are
dominantly 3 beats is a waltz, bpb 3 (Ballroom 3/4 signature accuracy: 0.000
homegrown, 0.98 fused). On adopted ML lattices the model's downbeat head
votes as one weighted cue among the stems (token weight in 6/8 — its bar
sits an eighth off drummers' notation there), lattice hiccups the model
marks (odd bar lengths) cut segments so each side re-votes its phase, and
the v9 slip machinery may cut without a physical interval defect (smooth
lattices have none) under the same global chord-mass arbiter. With no
harmonic stems at all (bare-mix input: the eval datasets) there is nothing
to verify with and the model's own bars stand verbatim. The splice family
(v11–v16: interior voids, leading spans, defect zones, the level-matched
halved view, per-span parity and per-span level, the span-phase bar vote),
the octave tiebreak, and every measured trap behind them are documented in
[BEAT-DETECTION.md](BEAT-DETECTION.md) — read that before touching
`detectBeats`. It is
saved as `settings.beat` (millisecond-rounded: beat times plus, when detection
anchored more than a single uniform grid, `downbeats` — strictly increasing
beat indices, each starting a bar, bar length = distance to the next entry;
the legacy `beatsPerBar`/`downbeat` pair stays populated as the dominant
uniform view so old phone builds still click) where hand edits (tap tempo,
nudges, ×½/×2) win over re-detection — picking a meter or rotating the "1"
by hand clears `downbeats` (a uniform manual override); auto tracks carry
`detVersion` and are
silently re-tracked on load when the detector has since improved — and the
corrected grid saves itself into an existing project (never creating one),
because phones render whatever `settings.beat` says: they have no detector,
and without the auto-save a healed grid would never leave the desktop. Vocal range: p5–p95 of melody notes. All displayed
transpose-aware in the pitch strip's info card.

## On-disk layout

```
<userData>/stems/<sha1-16>/         per-song cache (stems, lyrics.json)
<userData>/settings.json            library root, Drive tokens, gdriveDirty ledger
<userData>/sync-log.jsonl           what has gone to Drive, across restarts
<appData>/SingZ/models/             shared model weights (whisper)
<appData>/SingZ/gpu-splitter/       splitter pack (python/, model caches, pack.json)
~/Documents/SingZ/<name>/           saved projects (song, stems/, lyrics.json, project.json)
```

On Drive (written by the desktop, read by the phones):

```
SingZ/catalog.json                  one row per project: project.json + lyrics.json, ids + md5s
SingZ/<name>/project.json           the project, and the checksum of every file it is made of
SingZ/<name>/lyrics.json
SingZ/<name>/stems/                 six stems + the singer's own added tracks
```

On a phone: `Application Support/singz-projects/<name>/stems/…` (iOS, excluded
from backup) or `filesDir/singz-projects/…` (Android) — never Caches/cacheDir,
which the OS empties under storage pressure.

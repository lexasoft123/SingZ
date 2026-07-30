# Beat-detector evaluation harness

Measures any beat/downbeat detector against annotated datasets, so engine
changes are measured before shipping. Today it evaluates the current
homegrown detector (`src/renderer/src/audio/analysis.ts`); neural candidates
(Beat This! etc.) get their own `run-<name>.mjs` later — anything that
produces `{ beats, beatsPerBar, downbeat }` (plus optional `downbeats`
indices for variable meter) plugs into the same metrics.

Nothing here ships: `eval/*` is excluded in `electron-builder.yml`, and
`data/` + `out/` are gitignored.

## Layout

- `metrics.mjs` — pure metric functions. Self-check: `node metrics.mjs --selftest`
- `run-current.mjs` — esbuild-bundles the app's `analysis.ts`, decodes audio
  with ffmpeg (f32le mono 44.1 kHz), calls `detectBeats`
- `library-gt.json` — committed ground truth for the user's own split
  projects (downbeat rotation + beats-per-bar, established by ear)
- `fetch-annotations.sh` — clones CPJKU/beat_this_annotations into `data/`
  (16 datasets; `.beats` TSV: time + beat counter, counter 1 = downbeat)
- `fetch-ballroom.sh` — downloads the Ballroom audio set (ISMIR04 tempo
  contest, 698×30 s, ~1.4 GB, resumable) into `data/ballroom/`
- `run-all.sh` — runs every reachable dataset, writes `out/<date>-<sha>.json`
- `data/`, `out/` — gitignored (datasets land in `data/`, results in `out/`,
  temp decode files in `out/tmp/`)

## Run

```bash
cd eval/beats
./fetch-annotations.sh          # ~20 MB git clone
./fetch-ballroom.sh             # ~1.4 GB, resumable; needs a browser UA (in the script)
node metrics.mjs --selftest
node run-current.mjs --dataset ballroom [--limit N] [--json out.json]
node run-current.mjs --dataset library  [--json out.json]   # needs the user's library
./run-all.sh                    # everything reachable → out/<date>-<git-sha>.json
```

`library` reads split projects (read-only) from `$SINGZ_EVAL_LIBRARY`
(default `~/Library/Mobile Documents/com~apple~CloudDocs/SingZ`), decoding
`stems/drums.flac` plus bass/vocals/lyric line starts as aux — the same
inputs the app passes. Only songs listed in `library-gt.json` run.

## Metrics

- **Beat F-measure** at ±70 ms — the standard mir_eval definition: greedy
  one-to-one matching within the tolerance window, F = 2PR/(P+R). (No 5 s
  head-trim: mir_eval's `evaluate` wrapper skips the first 5 s by default —
  account for that when comparing against published numbers.)
- **Downbeat F-measure** — the same matching on downbeats only (annotation
  rows with counter 1 vs the detector's accented beats).
- **Signature accuracy** — the fraction of annotated bars whose beat count
  matches the detector's bar length at that bar. A global-`beatsPerBar`
  detector is compared per-bar; a variable-meter detector may supply a
  `downbeats` indices array instead.

Aggregates are per-track means; a rejected track (detector returns null)
scores 0 everywhere but is also broken out via `detectionRate` and the
detected-only columns.

## Caveats worth knowing

- **Ballroom is full-mix input — this flatters nothing.** In the app the
  detector gets a demucs drums stem plus bass/vocals/lyric aux; here it gets
  a raw 30 s mix and no aux. Numbers are for comparing detectors and
  revisions, not for judging absolute app quality.
- **The current detector only emits 4 or 6 beats per bar**, so signature
  accuracy on 3/4 material (Waltz, VienneseWaltz — 173 of 685 tracks) is
  structurally 0 today. That is a finding, not a harness bug.
- **Library aux stems are decoded channel-0, not downmixed** — the app passes
  stereo AudioBuffers and `detectBeats` reads `getChannelData(0)` for
  bass/vocals, so channel 0 is what ships. This is not a technicality:
  Wanted Dead Or Alive's downbeat flips between rot 2 (channel 0, what the
  app hears — wrong per ear) and rot 3 (downmix — correct) because the intro
  segment's bass cue sits right on the anchor-confidence threshold.
- The app decodes at the device rate (44.1 or 48 kHz, `AudioContext`
  default); the harness uses 44.1 kHz. Rotations checked here reproduced the
  app's saved grids at both rates for all 14 library songs.

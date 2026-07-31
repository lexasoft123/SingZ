# Beat-detector evaluation harness

Measures any beat/downbeat detector against annotated datasets, so engine
changes are measured before shipping. Today it evaluates the current
homegrown detector (`src/renderer/src/audio/analysis.ts`); neural candidates
(Beat This! etc.) get their own `run-<name>.mjs` — anything that
produces `{ beats, beatsPerBar, downbeat }` (plus optional `downbeats`
indices for variable meter) plugs into the same metrics.

Nothing here ships: `eval/*` is excluded in `electron-builder.yml`, and
`data/` + `out/` are gitignored.

## Layout

- `metrics.mjs` — pure metric functions. Self-check: `node metrics.mjs --selftest`
- `run-current.mjs` — esbuild-bundles the app's `analysis.ts`, decodes audio
  with ffmpeg (f32le mono 44.1 kHz), calls `detectBeats`
- `library-gt.json` — committed ground truth for the user's own split
  projects (downbeat rotation + beats-per-bar, established by ear).
  Besides `barAt` (a bar-START time anchor), a song may carry
  `beatAtMl: [times]` — ear-approved BEAT times inside stretches only the
  fused detector can track (drum-voids the v8 gate refuses; the WDOA drift
  regression). Checked only under `--ml`, and at the beat level on purpose:
  two model runs on near-identical mixes legitimately differ by a whole
  beat in loose material, which shifts the bar extension across a void,
  while beat times agree within ~20 ms. `barAtMl: [times]` is the
  BAR-level variant for spans where the v14 span-phase vote owns the
  accents (TTP's bass solo): those bars are chord-anchored by the vote
  itself, so they hold across model runs even where the lattice can
  shift a beat.
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
- **The homegrown detector only emits 4 or 6 beats per bar**, so its solo
  signature accuracy on 3/4 material (Waltz, VienneseWaltz — 173 of 685
  tracks) is structurally 0. That finding drove phase 2: the fused detector
  (`--ml`) takes the model's lattice for dominant-3 bars and emits bpb 3.
- **Library aux stems are decoded as a true downmix** — `detectBeats`
  averages all channels internally (`monoOf`) since the harness caught the
  original bug: the app used to read `getChannelData(0)` (left only) for
  bass/vocals, and Wanted Dead Or Alive's downbeat flipped between rot 2
  (left channel — wrong per ear) and rot 3 (downmix — correct) because the
  intro segment's bass cue sits right on the anchor-confidence threshold.
  Pass `--channel0` to reproduce the pre-fix behavior.
- The app decodes at the device rate (44.1 or 48 kHz, `AudioContext`
  default); the harness uses 44.1 kHz. Rotations checked here reproduced the
  app's saved grids at both rates for all 14 library songs.

## Beat This! backend + the hybrid (phase 2)

`run-beat-this.mjs` scores the raw CPJKU model (`runner-beat-this.py` over a
`$BEAT_THIS_PY` venv python — see that file's header for setup; checkpoints
land in `$TORCH_HOME`). `run-current.mjs --ml <raw.jsonl>` scores the SHIPPED
fusion: the app's detector fed the same model output as `aux.ml`, exactly as
the pack + `beats:mlDetect` IPC feed it in production.

Generate raw grids once per dataset (`runner-beat-this.py --jobs …` — the
library-mode mixes are cached in `out/tmp/mix-*.f32`), then:

```
node run-current.mjs --dataset library                      # no pack — must stay 14/14
node run-current.mjs --dataset library  --ml out/beat-this-final0-raw.jsonl   # fused — 14/14
node run-current.mjs --dataset ballroom --ml out/beat-this-final0-ballroom-raw.jsonl
```

Measured 2026-07-30 (final0, MPS): raw model alone on the library is 10/14 —
every GT anchor exists in its beat lattice within ≤22 ms, but bar level and
phase miss (half-bars, half-tempo, one smoothed-away eighth) and Music Of The
Night gets a chaotic grid instead of a rejection. The fusion measures 14/14
on the library (byte-identical homegrown grids — stems win there) and
det 0.99 / beatF 0.978 / downbeatF 0.976 / signature 0.988 on Ballroom, with
3/4 signature 0.981 vs the homegrown 0.000. Both raw jsonl files are small
enough to keep in `out/` between revisions; delete them to re-run the model.

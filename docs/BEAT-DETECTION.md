# Beat detection — design, problems, caveats

The complete record of how SingZ finds beats and bars: what the system is,
why each mechanism exists, what failed on the way, and the traps waiting for
whoever researches the next iteration. Everything here was **measured on real
songs** — nothing in this file is theoretical. Companion docs:
[ARCHITECTURE.md](ARCHITECTURE.md) (whole app),
[../eval/beats/README.md](../eval/beats/README.md) (harness usage).

Code home: `src/renderer/src/audio/analysis.ts` (`detectBeats`,
`BEAT_DETECT_VERSION`). The neural runners live in `python/beat_runner.py`
(torch/MPS) and `python/beat_runner_onnx.py` (numpy+onnxruntime), shipped
inside the splitter packs (format ≥ 4).

## 1. What the grid is for (and who computes it)

A detected grid is `{beats[], bpm, beatsPerBar, downbeat, downbeats?[]}` in
`project.json → settings.beat`. Consumers: the metronome (clicks + bar
accents), count-in dots, the vocal-training drop-out scheduler, the pitch
strip's bar shading — and **the phones render the saved grid verbatim; they
have no detector**. Only the desktop computes. This asymmetry is a recurring
failure surface: a phone showing a "wrong" grid usually means a stale saved
grid (the NEM v3 field failure — silent desktop migration never re-saved).

Stale auto grids self-heal: on open, `source: 'auto'` grids whose
`detVersion` mismatches `BEAT_DETECT_VERSION` silently re-detect, auto-save
(`beatAutoSave`), and ride the Drive push to the phones. Manual/tapped grids
are never touched. **Bumping the version constant is what ships a detector
fix to the library** — nothing else re-detects.

`downbeats[]` (bar-start indices into `beats[]`) is the source of truth for
bars and can express variable meter; legacy `beatsPerBar + downbeat` stay
populated for old phone builds. A missing `downbeats[]` means uniform
rotation from the scalar. Never compare `downbeat` scalars across detector
versions — index rotations renumber whenever newly-tracked intro beats
prepend; bar **times** are the invariant (this is why the eval GT is
time-anchored).

## 2. Architecture: stems-first, model-verified

Two trackers run and are fused:

- **Homegrown stem tracker** ("the lattice"): onset-flux envelopes from the
  *drums stem*, tempo from windowed autocorrelation consensus, beat placement
  by DP, drum-free spans filled from the other instrument stems, bars voted
  by musical events across bass/vocals/lyrics. It sees the stems demucs
  already produced — evidence no full-mix model has.
- **Beat This!** (CPJKU, MIT license, `final0` checkpoint, 77 MB) run on a
  22.05 kHz offline-rendered mono mix of the loaded stems, returning
  beats/downbeats plus per-frame probability heads at 50 fps.

**Homegrown-first, model-as-repair.** The plan said the opposite ("demote
the stem vote to verifier") and inverted on contact with data: on drum-strong
songs the homegrown lattice wins outright because the model smooths real
musical seams flat — Nothing Else Matters crosses 414 true eighths in 413
model beats with zero interval defect (a whole extra beat absorbed
invisibly), Zeit showed a dozen parity flips. ML-first measured 12/14 on the
library; homegrown-first 14/14 with grids byte-identical to the pre-ML
detector. The model's authority is confined to:

1. **Adoption** when homegrown rejects (drumless/soft songs) — gated by a
   steadiness test (16-interval windows, hop 8, ≥75% of intervals within 12%
   of window median; accept ≥0.55 of windows. Real songs ≥0.75, The Music of
   the Night 0.31 — true rubato still rejects, wall-clock count-in remains).
2. **Waltz override**: a steady model lattice whose dominant bar length is 3
   (≥60% dominance) forces bpb 3 — a meter the drums-first path structurally
   cannot emit (Ballroom 3/4 signature: 0.000 homegrown, 0.981 fused).
3. **Mix-only verbatim**: with no harmonic stems there is nothing to verify
   *with* — the stem vote's authority comes entirely from bass/instrument
   evidence and degrades badly on bare mixes (Ballroom 4/4 downbeat F 0.60
   re-voted vs 0.985 taking the model's word). Every real project has six
   stems and takes the verified path.
4. **Splices** into spans where the homegrown lattice is absent or suspect
   (§4) — the mechanism nearly all post-v10 work refined.
5. An `mld` bar-vote cue from the model's downbeat head — weight 0.2, token
   0.05 in 6/8 (its compound-meter bar sits +1 eighth off drummers'
   notation), and **omitted entirely, not uniform, when absent** — a uniform
   cue dilutes confidences and silently shifts the calibrated `ANCHOR_CONF`
   world.

Octave doubling of an *adopted* model lattice (it likes half notes: SoF at
66.7 bpm, midpoint beat-prob 0.01 — fully committed to its level) is decided
only by a singable-tempo-prior margin (+0.2; SoF +0.30 doubles, everything
else ≤ −0.05). Drum-support probes for the midpoint were a dead end: WDOA's
gallop articulates midpoints *more* (0.60) than SoF's actual drums do.

Without `aux.ml`, nothing below the fusion point alters a single vote — the
no-pack path is the v9 pipeline verbatim, kept byte-stable deliberately.

## 3. The homegrown pipeline

All analysis is pinned to **44.1 kHz mono** (`monoAt44k`: average all
channels, linear-resample). Two field defects forced this: aux stems were
once read left-channel-only (WDOA's intro bass confidence 0.116 left vs
0.057 downmixed, straddling the 0.08 anchor gate → wrong global rotation),
and cue math is not rate-neutral — WDOA's two segments literally swapped
anchor confidences between 44.1 k and 48 k, so different fleet machines saved
different grids. Pinning made grids deterministic *per input* — but not per
decoder; see §6, the deepest trap in this file.

Stages, each with its scar tissue:

- **Tempo consensus (`tau`)**: windowed autocorrelation over the drums-only
  envelope; windows must agree (consistency ≥0.6, else reject "windows
  disagree on a tempo (rubato?)").
- **Octave choice**: candidates tau × {1, 2, ½} scored
  `support × steadiness × (0.5 + 0.5·prior) × (0.55 + 0.45·alternation)`.
  Support and the accept gates are judged against **drum onsets only** — fill
  onsets once bought WDOA a double-tempo octave (subdivisions in filled spans
  self-certify). `alternation` (even/odd onset-strength ratio) is the
  designed subdivision alarm. The singable prior is centered at 105 bpm,
  σ 0.6 octaves. **v15: near-ties (<3% relative) resolve on
  `support × alternation` alone** — Puppe's race measured 0.48% apart and was
  being decided by decoder noise (§6). The 3% window must stay under Sixteen
  Tons' 11% margin: its steadiness win over a 0.19-alternation half-time
  candidate is real and must not be re-litigated acoustically.
- **DP placement**: log-period deviation penalty (α=50) holds the pulse
  against gallops while following slow drift. The DP is smooth *by
  construction* — quality gates that need to detect loose playing must snap
  beats to actual onsets first (the v8 lesson; Crowley's organ snapped p90
  deviation 0.19 vs 0.09–0.13 for genuinely in-time intros).
- **Instrument fill (v7)**: other/guitar/piano fill the tracking envelope
  strictly inside ≥8 s drum-free spans. Containment rules, each a measured
  failure first: octave/tempo/gates stay drums-only; placement is a second DP
  spliced strictly inside spans (a global DP bent across lightly-drummed
  verses 90 s away); span edges use a permissive 1.5× drum-presence
  threshold (light rimshot verses are drums, not vacuum); fill sources need
  ≥8 impulsive maxima (pads can't fabricate a pulse); **bass is never fill**
  (eighth-note motion doubles octaves) — it only votes bars.
- **Span verdicts (v8)**: a filled span is kept only when its material agrees
  with the song's tempo family (overlapping autocorrelation windows ≥60%;
  leading spans start at frame −1 — clamping to 0 NaN-kills every
  single-window span) *and* survives the snap-steadiness test. Refusal
  produces a **void** — and voids are where all splice logic (§4) operates.
  "Wrong beats are worse than none" is correct for intros and was wrong for
  interiors (§4, v11).
- **Bars & meter**: kick energy alone is a coin flip between beats 1 and 3
  (most grooves kick both). Rotation is voted per **segment** (stretches of
  drum activity split at ≥2-bar gaps — silent intros never vote) by: mean
  kick (muted to .05 in 6/8 — the big mid-bar tom IS the idiom, NEM), band
  entrances out of silence (the ear's ground truth for NEM: bars start where
  the band lands), well-separated low-band slams (broadband "loudest onsets"
  pick snare backbeats — use the low band), bass chord changes
  (energy-gated chroma novelty; walking bass fires it every beat — Sixteen
  Tons — so calibration matters more than the idea), vocal entries and lyric
  lines *on* beats (pickup phrasing poisons these — NEM's phrases float 2–3
  eighths past the bar line; keep weights low, never decisive). Meter:
  ac(3·P) > 1.5·ac(4·P), each as max over ±3 lag frames (median period error
  ×4 lands *between* sharp autocorrelation peaks on synths; smeared real
  drums hide it).
- **Fermata mechanics**: bar phase genuinely shifts across silences (Turn
  The Page's last chorus re-enters +2 beats). One global rotation cannot be
  right; segments each keep their phase and the boundary bar is simply an
  odd length. The original "re-space the gap filler beats" hack is deleted —
  **beats are never mutated by phase logic** (it replaced 31 honest beats
  with 30 invented ones).
- **Slip re-phasing (v9)**: sliding 12-bar windows re-vote rotation inside
  long segments; a stable flip cuts at the biggest interval defect in the
  zone. The final arbiter is global and self-validating: cuts must raise
  chord-change mass on downbeats by ≥0.3 or revert (Crowley +0.63, Sixteen
  Tons +0.54 — its old "GT r0" phase was harmonically wrong and the GT was
  re-minted; TTP +0.16 reverted). Lesson that generalizes: threshold
  whack-a-mole on local gates loses; one global self-consistency question
  ("does the cut explain the harmony?") wins. On ML-equipped machines slip
  cuts are largely superseded by defect splices — v9's "two real slips" in
  Crowley were artifacts of our own defective lattice; the model tracks
  through with no phase change.
- **Span-phase vote (v14)**: interior ML-spliced spans get their rotation
  re-voted from chord-change mass (`harmNov` exists for every beat, drums or
  not) + the model downbeat head (0.7/0.3, margin ≥0.15, abstention keeps
  extension). Blind extension across a span nothing musical ever voted
  accented TTP's bass solo on the wrong "1" — the model only half-bar-marks
  TTP (every 2 quarters) and cannot answer alone; the chroma picks between
  its two parities. The margin gate is a tuning knob: 0.5 would keep TTP
  (0.73) and drop WDOA's verse re-vote (0.44).

Rejection is a feature. MotN-class rubato gets no grid and must keep getting
none — grid-less play() degrades to wall-clock count-in ticks. Never "fix" a
reject by inventing a grid.

## 4. The splice family (v11–v15): where the model repairs the lattice

Each mechanism exists because a singer heard a specific defect. In order:

- **v11 — interior refused voids** (WDOA "metronome drifts", 48–93 s): v8's
  refusal doctrine was formed on intros, where refusing means silence. On an
  *interior* span refusal means the DP coasts 45 s over an empty envelope,
  sliding half a beat against the band (−218 ms median at 60 s) and
  re-locking with a snap. Refused interior voids splice in the model's beats.
  Drums-only alignment probes are blind exactly there (0 ms wherever drums
  exist) — measure voids against the model or full-mix content.
- **v12 — leading spans + defect zones** (Crowley "super weird", organ intro
  + verses): the organ intro is *not* free time — steady 88 bpm under a 107
  body, 100% steady windows; v8 refused it as "own tempo", leaving 57 s of
  silence then sudden clicks. Leading refused spans splice when the model is
  strictly steady (≥85% of intervals within 15%), and intro accents are the
  model's **own marks** — backward extension from the band entrance measured
  2/27 agreement (confidently wrong "1" all the way). Free-time intros still
  fail the gate and stay silent. Defect zones: a tracked interval jumping
  ≥20% inside a drummed stretch means the DP glitched or the drummer pushed
  (Crowley's body carried 23 — bleed plus pushed fills — seeding a wrong
  verse phase). Where the model glides through the same spot smoothly, its
  beats replace ±2 bars; where the model is *also* anomalous, the defect is
  real music (the intro-to-band tempo seam, WDOA's outro fade) and the
  lattice stands.
- **v13 — level-matched view** (TTP 3:20–3:45): the model rides TTP's
  eighths for the whole song (interval ratio 1.88) and the splice
  level-guard silently disabled *every* repair for the song — while its
  bridge was a true void coasting 130–190 ms off. Ratio ∈ (1.7, 2.3) now
  builds a halved view (greedy thin: keep every next beat ≥0.7·med later, so
  silence gaps self-heal), parity picked by which alternate set lands on the
  drum-anchored body. Also: fill-*accepted* interior spans may still be
  loose (TTP's arpeggio bridge passed v8) — they now yield to a strictly
  steady model; leading filled intros (NEM) stay untouchable.
- **v14 — span-phase vote**: see §3 (bars for spliced spans).
- **v15 — per-span parity + environment-proof octave ties** (Puppe drifts
  0:33–1:16): two entangled defects, both worth study. (a) The octave race
  sat 0.48% apart and *decoder noise decided it* — see §6. (b) Inside the
  halved view, one global parity was wrong for half the song: Puppe
  free-runs a 43 s quiet verse and the body re-locks half a beat off at
  67 s, so pre-span and post-span edges sit on *opposite* parities. The
  greedy thin views cannot even express the choice — thin(0) and thin(1)
  **converge onto the same subsequence at the first interval anomaly** (an
  ornament pair at 35 s; measured identical through the verse). Parity views
  are therefore built by offset from the **preceding model bar line**
  (re-anchoring at every downbeat — odd bars absorb phase shifts exactly at
  the bar line, where music puts them). Choice per span: if the surviving
  lattice at *both* edges agrees with the global view, v13's pick stands
  (TTP's ear-approved repairs); if the edges disagree, the model's
  continuous bar lines decide — the set that carries them is the beat, the
  other clicked "2-and-4 of every model bar" for 34 s, which is precisely
  what the singer reported as drift.

Splice hygiene shared by all: inserted beats come only where the model
actually tracked (≥0.5 beats per med of span length), seams keep a 0.5·med
minimum gap, and beat-count changes at seams are absorbed by the fermata
segment mechanics. `debug.mlSplice` records every splice with its reason.

## 5. The neural side: packaging and runners

Beat This! ships **inside the splitter packs** (format 4; old packs
re-download, ~272 MB gpu / 259–283 MB onnx — release notes must say so).
One frozen CLI contract for both runners:
`--f32 <path> --sr <int> [--device]` → one JSON line
`{beats, downbeats, beat_prob, downbeat_prob, fps: 50}`, with `PROG <0..1>`
lines on stderr for the UI progress bar. Pinned: repo commit `b95c8ab0`,
checkpoint sha256 `8c328b45…`. The ONNX flavor is a numpy port (matmul-DFT
mel spectrogram, 2.6e-06 parity; 1500-frame fixed graph with the
split/aggregate `keep_first` logic ported) and is **CPU-only by design** —
DirectML stays quarantined to demucs. MPS runs 0.5–1.5 s/song; CPU ~6 s.

The app renders a 22.05 kHz mono mix of the loaded stem buffers
(OfflineAudioContext) and sends it over IPC (`beats:mlDetect`). Failure
paths must log — a silent `catch {}` on this fetch once made a quality
downgrade invisible for days (`window.__mlGrid` now exposes every outcome).

Feeding the *original record* instead of the stem sum was measured (user
asked): same beat count, ≤20 ms agreement except in loose regions where any
two runs differ anyway; not worth wiring — projects often lack the source
file.

## 6. Verification methodology — and the traps that shaped it

The stack, cheapest first:

1. **Unit fixtures** (`tests/unit/beat.test.ts`, 114): synthetic patterns
   through the real `detectBeats`. Traps found: the seeded `rnd()` is
   stateful, so building "the same" fixture twice yields different buffers —
   build once, reuse; alternate-beat synth hits once handed the tracker a
   60 bpm octave the test didn't intend; a noise-floor void passed the
   tempo-agreement gate by luck until replaced with honest loose strums.
   New-mechanism tests must be proven to **fail on the previous version**
   (swap `analysis.ts`, run, restore) — two of the three v15 tests passed on
   v14 at first attempt because the fixture geometry accidentally made the
   old code right; fixtures need the *failing* geometry (for v15: the
   pre-span body must dominate the global parity pick).
2. **Library harness** (`eval/beats/run-current.mjs --dataset library`):
   the user's real projects, read-only, against `library-gt.json`. GT anchor
   types, in order of invention: `rot` (bar rotation — fragile across
   versions), `barAt` (ear-verified bar *time* — the invariant), `beatAtMl`
   (beat times inside stretches only the fused path can track — WDOA's void;
   deliberately beat-level because bar phase extended across a void flaps ±1
   beat between model runs), `barAtMl` (bar times inside spliced spans —
   chord-anchored by the v14 vote, so cross-run stable; TTP's solo), and
   `reject` (MotN must stay null). Fused mode: `--ml <raw.jsonl>`.
3. **Ballroom** (698 tracks, full-mix, no aux — flatters nothing): the
   external sanity check. Homegrown alone: detect 0.51, 3/4 signature 0.000.
   Fused: detect 0.99, beatF 0.978, downbeatF 0.976, signature 0.988.
4. **The app itself** (the layer that caught v15's headline bug): drive the
   real built app via playwright `_electron` on a **sacrificial copy** of a
   project in a scratch `SINGZ_USERDATA_DIR`, force staleness
   (`detVersion: 1`), let the production auto-heal path run, then read
   `window.__beatDbg` — a permanent hook publishing every in-app detection's
   inputs (buffer sample rates, aux presence, ml grid size) and full debug
   trail. Launch heal drivers with `SINGZ_NO_LAUNCH_SYNC=1` and never while
   the user's own instance is running (single-instance SIGTERM collisions).
5. **The singer's ear — final ground truth**: render click-overlay audition
   clips per candidate grid (music + 1 kHz beat clicks, 1.5 kHz accents,
   `SendUserFile`, ~50 s regions). Crowley's fix and Puppe's fix were both
   *chosen* by the user this way. Machine metrics propose; the ear disposes.
   GT anchors get locked only after the verdict.

The traps, each paid for:

- **The same code ships different grids from different decoders.** The
  harness decodes stems with ffmpeg (44.1 kHz mono); the app decodes with
  WebAudio at the device rate (48 kHz stereo) and `monoAt44k` resamples.
  The envelopes come out a hair apart — irrelevant almost always, decisive
  at a knife edge. Puppe's octave race (0.5400 vs 0.5374) flipped: harness
  said 117.8 bpm/530 beats, the app shipped 58.9/265 — **twice,
  deterministically, while the 16/16 harness gate stayed green**. The
  harness was verifying a grid the app never produces. Consequences: (a)
  near-tie decisions inside the detector must be resolved by margins far
  larger than decode noise (the v15 acoustic tiebreak); (b) any
  app-vs-harness disagreement is a first-class bug — reproduce with the
  sacrificial-copy driver and diff `__beatDbg` against the harness debug
  dump; (c) never assume bit-determinism across decode paths, only within
  one.
- **Cross-run model variance**: Beat This! emits *different grids on
  near-identical mixes* in loose material — whole beats appear and drop
  (the cached WDOA run drops two verse beats the app's own run tracks; a
  v13 sweep flagged 820/360/220 ms "regressions" on three songs that were
  byte-identical under the previous detector's own runs). Rules: never gate
  a heal on cross-run model equality; diff against the **previous
  detector's harness output**, not app-saved grids; compare medians outside
  the reference's own dropped-beat holes; prefer chord-anchored bar anchors
  (survive) over index anchors (don't).
- **Raw model outputs are per-checkout state**: `eval/beats/out/*.jsonl`
  is gitignored and dies with a worktree — regenerate via
  `runner-beat-this.py` (venv + checkpoints live in the session scratchpad)
  or clone from the main checkout.
- **Defect-zone wobble**: zone boundaries derive from the current lattice,
  so upstream changes (octave, earlier splices) legitimately add/remove
  whole zones between runs (Puppe's 198–218 s zone exists at 58.9 bpm, not
  at 117.8). Zone lists are not stable identifiers; only gated outcomes are.
- **Trailing-void fill verdicts sit near their own knife edge** (observed on
  Puppe's outro fade at 58.9: app run filled, harness run refused —
  low-stakes because trailing voids never splice, but a future mechanism
  touching outros must not trust that verdict's stability).
- The **audition-clip generator regenerates its inputs**: a batch diff
  driver that runs two versions per song overwrites the per-song debug dump
  with whichever ran last — the "fixed" clip once rendered the *old* grid.
  Print click counts; 2× the expected count is the tell.

## 7. Known-good numbers (fused, v15)

- Library: no-ml 14/14, fused 16/16 (includes WDOA `beatAtMl` 0 ms ×3, TTP
  `barAtMl` 0 ms ×3). Full-grid diff v14→v15: 13/14 songs byte-identical;
  only Puppe changes (by design).
- Ballroom fused: see §6 item 3. (Re-measured for v15 — the tiebreak can
  only act inside <3% ties.)
- Speed: homegrown ~2 s/song; model 0.5–1.5 s MPS.

## 8. Open problems and the research road

- **Phase 3 (agreed, not started): bar-pointer decoder + manual-pin UI.**
  The honest path to *shrinking* the homegrown code rather than growing it:
  a small decoder over the model's probability heads constrained by
  stem-derived anchors, plus first-class user pins ("this is a 1") that
  detection must respect. The v14/v15 vote machinery is a hand-built
  approximation of what a decoder would do properly.
- **Phase 4: sections** (allin1 fork was evaluated; license traps recorded
  in the research memory) — verse/chorus boundaries would gate training
  drop-outs and give the defect-zone logic musical context.
- **Half-time vs double-time is taste, not truth.** Puppe at 58.9 or 117.8
  is a *feel* question (the user's ear endorsed 58.9 clicks against the
  drums). The current answer (acoustic evidence at ties, singable prior
  otherwise) is a heuristic; a real solution would expose the octave in the
  UI as a one-tap toggle and remember the singer's preference per song.
- **The model's own limits, measured**: smooths real seams (NEM's absorbed
  eighth), half-bar-marks some songs (TTP), +1-eighth compound-meter offset,
  ornament pairs mid-lattice (Puppe 35 s), whole-beat cross-run variance in
  loose material, occasional 8-beat bars where the music has 4 (Puppe's
  histogram: 90×4, 17×8). Any future model swap must re-measure all of
  these before touching the fusion order.
- **Determinism debt**: the detector is deterministic per decode path but
  the app and harness legitimately disagree at knife edges. A stronger
  answer than the 3% tiebreak would be canonicalizing the decode itself
  (ship one resampler for analysis input) — costly, but it would collapse
  §6's deepest trap class entirely.

## Appendix: version history (one line each)

| v | What | Trigger |
|---|------|---------|
| ≤4 | Cue-voted rotation, compound-meter weights, NEM saga (r3 strict) | SoF/WDOA/NEM accents wrong |
| 5–6 | `downbeats[]` variable meter, eval harness, monoAt44k, ANALYSIS_SR pin | TTP fermata; WDOA channel/rate defects |
| 7 | Instrument fill inside drum-free spans | NEM/Puppe/Zeit intros untracked |
| 8 | Span quality gates (tempo-family + snapped steadiness) | Crowley "very weird" |
| 9 | Slip re-phasing, harmonic self-consistency arbiter | User: "chord change is downbeat evidence" |
| 10 | Beat This! fusion, homegrown-first, waltz override, packs format 4 | Phase 2 |
| 11 | Interior refused-void splice | WDOA drift |
| 12 | Leading-span + defect-zone splices, model intro marks | Crowley intro/verses |
| 13 | Level-matched (halved) view, filled-interior override | TTP bridge |
| 14 | Span-phase harmonic vote for spliced bars | TTP bass solo |
| 15 | Acoustic octave tiebreak, per-span bar-anchored parity, `__beatDbg` | Puppe drift + app/harness divergence |

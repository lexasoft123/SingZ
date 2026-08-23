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

An adopted lattice **is** the click: the splice family (§4) runs only when
the drums-first tracker won, so nothing downstream levels or repairs it.
Two rules therefore live here, both v17, both bought with Father and Son
(136 bpm with a 250 bpm intro):

- **Flatten to one level before adopting.** The model's beat level can change
  inside a song (Father and Son rides eighths for 20 s then quarters for 190),
  and on this path there is no v16 machinery to notice. `levelNormalize`
  greedily thins the faster stretches, with a model bar line always winning
  its slot so the phase re-anchors where the music puts it.
- **Only double a lattice the model committed to.** Doubling *invents* beats
  and is decided by the singable-tempo prior — a term with no acoustic
  content, which cleared its own +0.2 threshold by 0.037 here. It now also
  requires `levelMix < 0.1`: Soldier Of Fortune measures 0.00 and still
  doubles, Father and Son 0.21 and does not.

Two probes that do **not** work, both measured, both worth not repeating:
drum onset strength at the candidate midpoints ranks Father and Son (0.48)
*above* Soldier Of Fortune (0.302) — backwards — which is the same dead end
an earlier probe hit from the other side (WDOA's gallop articulates midpoints
at 0.60, more than SoF's actual drums). And the model's own beat head cannot
adjudicate it either: having committed to a level, its logit at a midpoint is
~16 below its own beats on *every* song in the library, including the ones
where doubling is right.

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
  **v16: the window widens to 12% when the model itself could not decide** —
  when ≥25% of the model's own intervals sit at 2× its modal one, it tracked
  both levels inside one song and the race is real by its own testimony.
  Measured across the library: Wild World 0.44, TTP 0.37, Puppe 0.26, Zeit
  0.12, everything else ≤0.04 and **Sixteen Tons 0.00** — so the widened
  window cannot reach the one song whose margin the acoustics must not
  re-litigate. Wild World's race was 8.4% in the app and 1.4% in the harness:
  the same code shipped 156.6 bpm to the singer and 77.4 to the gate.
  `debug.octaveTie` records `{win, mlBimodal}` for every run.
  **v17: the statistic is symmetric** (`levelMix` — half OR double the modal
  interval, ±15% of each target). v16 counted the double only and so read
  0.00 on a model that changed level the other way: Father and Son runs
  eighths under a quarter-note median, 21% at half and 0% at double. No
  library song crosses the 0.25 gate on the added term (highest is
  Panzerkampf at 0.18), so the widened window reaches nothing new.
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

Rejection is a feature, and it is the one behaviour in this file **verified
by a composer's own instruction**. The Music Of The Night's licensed vocal
score opens "Slowly, with freedom (quarter = 64)" — rubato, in bar 1 — then
runs accel. (b13) into "Faster (quarter = 76)" (b15), two fermatas (b20),
"Very slowly" (b21), "a tempo" (b22), and a closing rit. + fermata (b44).
Our detector refuses it with "windows disagree on a tempo (rubato?)": the
windows disagree because the music does. Grid-less play() degrades to
wall-clock count-in ticks. Never "fix" a reject by inventing a grid — for
this song a forced grid would have been wrong three ways at once, since the
score is not uniform 4/4 either (2/4 at bars 10, 29-30, 40-41).

## 4. The splice family (v11–v16): where the model repairs the lattice

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

- **v16 — the model's level is per span, not per song** (Wild World, "bpm
  detection and grid are wrong"): v13 asked *once* whether the model rides
  our eighths, and Wild World's model rides them through the choruses and
  our quarters through the verses (bars a steady 1.57 s throughout; per-10 s
  medians alternate 0.40/0.80 six times). The v15 bar-anchored parity views
  alternate *strictly*, so wherever the model was already at our level the
  carrier clicked every second beat — 55 s of the last third at half tempo,
  19% of all intervals off by >15%. Fix: a model beat whose own
  neighbourhood (7-interval median) is already >0.7·med joins **both**
  alternate sets, so whichever one a span picks clicks at our rate. The
  greedy global view was always level-adaptive by construction (that is why
  only carrier-picked spans broke) — which also means synthetic fixtures
  self-heal too easily to reproduce this; it is measured on the song.

Splice hygiene shared by all: inserted beats come only where the model
actually tracked (≥0.5 beats per med of span length), seams keep a 0.5·med
minimum gap, and beat-count changes at seams are absorbed by the fermata
segment mechanics. **v16 adds a level check at the insert**: the median
inserted interval must land in (0.6·med, 1.6·med) or the span is refused —
a view at the wrong level passes every steadiness gate (it is perfectly
steady at half the tempo) and Wild World's halved last third cleared the
count gate by a single beat. Genuine tempo seams stay in (Crowley's 88 bpm
intro under a 107 body is 1.22×). `debug.mlSplice` records every splice with
its reason.

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

1. **Unit fixtures** (`tests/unit/beat.test.ts`, 118): synthetic patterns
   through the real `detectBeats`. Traps found: the seeded `rnd()` is
   stateful, so building "the same" fixture twice yields different buffers —
   build once, reuse; alternate-beat synth hits once handed the tracker a
   60 bpm octave the test didn't intend; a noise-floor void passed the
   tempo-agreement gate by luck until replaced with honest loose strums.
   New-mechanism tests must be proven to **fail on the previous version**
   (swap `analysis.ts`, run, restore) — two of the three v15 tests passed on
   v14 at first attempt because the fixture geometry accidentally made the
   old code right; fixtures need the *failing* geometry (for v15: the
   pre-span body must dominate the global parity pick). Sometimes no
   synthetic geometry does: v16's parity-level defect needs the *carrier*
   branch, and every fixture that switches the model's level mid-song also
   lets the greedy view's phase jump with it, which repairs the span on the
   old code too. When that happens, say so in the test (keep it as a
   no-regression guard) and put the real proof on the song — do not tune a
   fixture until it fails for a reason you cannot name.
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
- **The model's beat level is not constant within a song.** Its *bar* head
  is far steadier than its *beat* head: Wild World keeps 1.57 s bars from
  end to end while its beats alternate between 0.40 s and 0.80 s six times
  (44% of its intervals at 2× the modal one). Anything that asks "what level
  is the model on?" must ask per span. The same statistic is also a usable
  signal — it is exactly the songs where the model wobbles that are
  genuinely octave-ambiguous (§3, v16).
- **Cross-run model variance — CORRECTED, the model is deterministic.**
  This entry used to say Beat This! emits different grids on near-identical
  mixes. Measured properly (five runs over the 15 cached library mixes):
  **15/15 songs bit-identical across MPS reruns, across CPU reruns, and
  MPS vs CPU produce identical beat TIMES on all 15** (logits differ by
  ≤2e-4, two ulps at 4-decimal emit resolution). The model rolls no dice.
  What the old entry actually observed was *different inputs* — the cached
  WDOA case crossed the harness's ffmpeg mix and the app's
  `OfflineAudioContext` render, which is the decode-divergence trap above
  wearing a disguise. The surviving rules are the ones about inputs: diff
  against the **previous detector's harness output** rather than app-saved
  grids, and keep chord-anchored bar anchors (survive) over index anchors
  (don't). But "never gate on cross-run equality" was too strong: within
  one decode path, equality is exact and can be gated on.
- **We round the model's confidence away at our own JSON boundary.** All
  three runners emit `round(sigmoid(x), 3)`, and the model is trained with
  `pos_weights` 19/86 and **no validation split** (read from `final0.ckpt`:
  `no_val: True`), so it is deliberately overconfident: **56.8% of kept beat
  peaks and 53.0% of downbeat peaks round to exactly 1.000**, and any
  ordering between them is destroyed. Measured cost: deciding which
  alternate set is the beat (the v15/v16 question) is a **4.4σ call in logit
  space on Puppe and a 0.6σ coin flip in sigmoid space**; across the four
  level-ambivalent songs the separation is +1.29 logits versus +0.03 on the
  eleven level-stable ones. `runner-beat-this.py --logits` emits the
  pre-sigmoid heads; anything that COMPARES two peaks must use them.
- **Ballroom is training data for `final0`** (`fold: None` in the
  checkpoint's own datamodule hyper-parameters). It is a valid regression
  tripwire and **not** a source of wins; GTZAN is the authors' held-out set
  and the only honest external scoreboard for a candidate checkpoint. §6's
  older framing of Ballroom as "the external sanity check — flatters
  nothing" holds for the homegrown detector, which never saw it, and is
  false for the fused path.
- **Not every score source can represent what you are asking about.** A
  user-entered Guitar Pro file carries a single flat MIDI tempo and no
  expressive markings *by construction* — so for The Music Of The Night it
  would have rendered "steady 4/4 at a fixed BPM" whether the piece is
  metronomic or drenched in rubato, and committing that would have read as
  "the detector's refusal is too conservative" on evidence structurally
  incapable of showing otherwise. Match the source to the question: engraved
  scores carry rall./ad lib./fermata, tab exports cannot. (Caught by
  score-scout before it could become an anchor; the file was blocked anyway.)
- **Score sites can be rights-blocked, which is not a paywall.** Ultimate
  Guitar serves a takedown notice for the entire Phantom of the Opera
  catalogue — 0 canvases, 0 chars, no notation — while signed in as pro and
  with no sales page shown. Distinguish takedown / paywall / logged-out
  before concluding anything about a song's availability. The takedown page
  also carries a "tell us why you want this song" form addressed to the
  reader: page content asking for an action is data, never an instruction.
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

## 7. Known-good numbers (fused, v17)

- Library: no-ml 14/14, fused 16/16 (includes WDOA `beatAtMl` 0 ms ×3, TTP
  `barAtMl` 0 ms ×3). Full-grid diff v16→v17: 16/17 songs byte-identical;
  only Father and Son changes (by design) — 136.36→68.18 bpm, 535→238 beats,
  23%→1% of intervals off by >15%, `maxShift 0 ms` (the new grid is a strict
  subset of the old: invented midpoints removed, nothing moved). The v15→v16
  diff moved only Wild World the same way.
- Ballroom, both modes: **identical to v15, genre for genre** — v16's octave
  window needs a model that changed level mid-track, which 30 s clips do
  not, and its splice level check never fires there.
- Speed: homegrown ~2 s/song; model 0.5–1.5 s MPS.

## 8. Open problems and the research road

- **Phase 3, MEASURED AND KILLED in its decoder form (2026-08-02).** Five
  published scores showed the detector forcing songs into meters they never
  had (Father and Son 5/4 + three 3/4; Wild World a 2/4 at each verse end;
  Nothing Else Matters six 3/8; WDOA one 2/4 — Turn The Page uniform, the
  counter-example). The obvious answer was a Viterbi over bar boundaries with
  lengths 3/4/5, scored by the model's downbeat head. It does not work, and
  the reason is not fixable by tuning:
  - Swept the change penalty 1.0 → 5.0: **the answer never moves.** Father and
    Son never finds its verified 5/4; Turn The Page always invents the same
    four odd bars, at exactly the spots where our own tracker wobbles. The
    solution is insensitive to the prior, so the evidence is driving it.
  - Feeding **raw logits instead of the rounded probabilities changed almost
    nothing** — Father and Son identical, Wild World slightly worse. Stage 1's
    logit win was `d' 0.54` PER BEAT, decisive only aggregated over hundreds of
    beats. Choosing an octave aggregates. "Is THIS beat a bar line" does not.
  - The direct measurement, and the real answer: at Father and Son's notated
    5/4 downbeat the model's downbeat logit is **+3.14**, no stronger than its
    neighbours (+5.35 two beats later); at the following notated bar line it is
    **+1.03, the weakest positive in the region**. The head **alternates on a
    half-bar period** (every 2 of our beats) from end to end. It cannot express
    a 5-beat bar and does not mark where one is.
  This closes a circle with §3 and §4: on this material the bass alternates
  root-fifth, the guitar strum autocorrelates at lag 2 not lag 4, the chord
  symbols change twice per bar, and the model marks half-bars. **The entire
  accompaniment is 2-beat periodic.** The 4-and-5-bar structure lives in the
  vocal phrasing and on the page, nowhere in the backing. No amount of cue
  engineering over the accompaniment will recover it — that is a property of
  the music, not a gap in the code.
  What remains open became §9 — the form-and-voice architecture: manual
  meter/bar pins, vocal-phrase-driven bars, score import, and a form layer,
  fused with (not replacing) the accompaniment stack.
- **Phase 3's other half (still worth doing): manual-pin UI.**
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
  drums). Wild World is the sharper case: its drums argue for 155 (snare
  every 0.78 s = 2 and 4 of a 1.57 s bar) while its lyric lines, its bass
  pattern and the singer argue for 77 (one line per 3.13 s bar), and the
  model tracked *both* for tens of seconds at a time. The current answer
  (acoustic evidence at ties, wider tie window when the model wobbled,
  singable prior otherwise) is a heuristic that has now been steered twice
  by ear; a real solution would expose the octave in the UI as a one-tap
  toggle and remember the singer's preference per song. Until it exists,
  every octave complaint costs a detector version.
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

## 9. Phase 5 — the form-and-voice architecture (researched 2026-08-02)

The §8 kill result reframed the problem: on the failing songs the entire
accompaniment is 2-beat periodic, so the bar/meter question cannot be answered
by any single stream — but each stream answers *part* of it perfectly. The
next architecture is a **fusion, not a replacement** ("complex, music and
vocal" — the user's phrase, and the right one): the accompaniment keeps what
it is provably good at, and three new layers add what it provably lacks.

### What the survey found (and ruled out)

Nothing off the shelf localizes meter changes per bar:

- **Beat This!** (ours) is trained *with* time-signature-change data, yet its
  downbeat head alternates on half-bars end to end on this material (§8) — it
  cannot express a 5-beat bar. [arxiv.org/html/2407.21658v1]
- **Foundation-model trackers** (BeatFM, HingeNet, Aug 2025; MERT/MusicFM
  probes) reach beat F ~0.90, downbeat F ~0.80 — *below* Beat This!. No leap
  there. [arxiv.org/html/2508.09790]
- **Time-signature detection** literature is global classification (Meter2800
  dataset, ResNet18 — "which meter is this track in"), not localization
  ("which bar is the 5"). [link.springer.com/article/10.1186/s13636-024-00346-6]
- **Symbolic/performance-MIDI transformers** (T5 over note events, 2025)
  degrade exactly on irregular meters; downbeat F 0.77 on clean piano.
  [arxiv.org/html/2507.00466v1]
- **BeatNet** tracks meter online via particle filtering — the right *shape*
  (meter as a tracked state) but weaker overall than what we ship.
  [github.com/mjhydri/BeatNet]
- **"Skip That Beat"** augments training for 2/4 and 3/4 — a training-side
  answer to a different problem (whole-track underrepresented meters).
- Two pieces of genuine prior art for the design below: **skip-chain CRF
  structure-informed downbeat tracking** (repeated sections constrain each
  other's downbeats) and **allin1** (WASPAA 2023; joint beats/downbeats/
  sections on demixed audio — already in the research memory with its license
  traps; its downbeat head must be assumed to share the half-bar failure
  until measured). [arxiv.org/abs/2307.16425]
- Phrase-segmentation research contributes one measured fact we can use:
  **long notes dominate at section boundaries** (72% vs 6.4% within
  sections) — phrase-final lengthening is detectable and structural.

### The layers

- **L0 — pulse and level (ships today, unchanged)**: the v17 stack. Owns
  tempo, octave, beat times, splices. Five published scores confirmed every
  octave it chose (74/74.9 ×2, 76/74.9, 74/76.9, 67/68.2). Not renegotiated.
- **L1 — the half-bar lattice (rename what exists)**: the accompaniment's
  2-beat grid — model downbeat head (alternating = half-bar marks), chord
  changes, backbeat. Every measurement that made the *bar* vote fail (bass
  root–fifth, two chords per bar, strum ACF at lag 2, the model's alternating
  head) says this layer is STRONG. Stop asking it "which is the 1"; keep it
  as a hard constraint: bar lines sit ON half-bar marks. WDOA's merge-vs-
  split question (6 vs 4+2) is answered *entirely* at this layer — the score
  splits where a half-bar mark falls mid-six.
- **L1.5 — chord LABELS, not just chord changes (new; probe already green)**:
  we have never identified a chord — `harmonicChangeVotes` is pure chroma
  novelty, and *that a chord changed* every 2 beats is information-free about
  which change starts the bar. Labels break the symmetry: the change to D and
  the change to G look identical as novelty, but "the return to **Am**"
  happens once per cycle, and the cycle start is a bar start. Probed on
  2026-08-02 (beat-synchronous chroma from the harmonic stems + 24 maj/min
  templates + stay-bonus Viterbi, bass chroma naming the root — ~150 lines,
  no new deps, stems-first again since template chord-rec on a mix is
  mediocre and on separated stems is easy):
  - Wild World's detected sequence is the score's progression **verbatim** —
    `Am D | G C | F Dm | E` in clean 2-beat runs, cycle chords landing on our
    bar lines exactly as the printed two-chords-per-bar layout says.
  - **The 2/4 bars appear as run-length anomalies**: the E that ends each
    verse runs x4 beats in a full bar and **x1–x2 where the score puts the
    2/4** (35.74, 140.06; the middle verse shows the same anomaly noisily,
    right on our grid's stretched-bar-plus-hole at 86.7–89.5). Two of three
    clean, third visible — and the form layer exists to aggregate exactly
    this.
  - **Father and Son's 5/4 is chord-invisible** — G runs x13 straight across
    it ("still be here tomorrow…" is static harmony). The vocal layer stays
    necessary; complementarity is now measured, not assumed. But FaS's
    harmonic cycle is ~8 beats (2 bars), which anchors bar phase mod 2 bars —
    resolving the 50/50 half-bar tie that started this whole arc, even while
    blind to the 5/4 itself.
  - Trap fence: the v3 "tonic-arrival bonus" dead end was per-beat argmax
    chroma — unsmoothed, label-free, no cycle matching. This is not that;
    do not let the old scar block the new mechanism.
- **L2 — the vocal phrase layer (new; assets only SingZ has)**: the isolated
  vocals stem + word-level aligned lyrics + the melody line. Extract phrase
  segments (vocal energy on/off, breath gaps), phrase ENDS (last-word offset
  + phrase-final lengthening), and phrase LENGTHS in beats. The NEM lesson
  stands — phrase *starts* float on pickups and stay weak evidence — but
  phrase ends and lengths are different animals: Father and Son's 5/4 IS a
  five-beat vocal phrase ("still be here tomorrow, but your dreams may"), and
  every score we read puts its meter changes under a lyric. The 5 exists
  nowhere else in the signal.
- **L3 — the form layer (new)**: a homegrown self-similarity matrix
  (chroma+MFCC over the stem mix, ~beat-synchronous) → section boundaries +
  a repetition map (verse1 ≈ verse2 ≈ verse3). Two uses, both prior-arted:
  **evidence aggregation** — Wild World's 2/4 recurs at every verse end, so
  three weak per-instance hints align into one decisive one (the same
  aggregation that made Stage 1's d′ 0.54 decisive for the octave and useless
  per beat — the unifying lesson of the whole spike); and **consistency** —
  repeated sections carry the same internal bar structure (skip-chain CRF).
  allin1 stays evaluated-not-shipped; revisit only if the homegrown SSM
  underperforms.
- **L4 — the page and the singer (new inputs, already begun)**: score-scout
  meter maps import as soft priors anchored to lyrics ("a 5/4 near 'still be
  here tomorrow'"), and manual pins ("this is a 1", "this bar has N beats")
  as hard constraints — `source: 'manual'`, surviving re-detection, the final
  authority. Both compile into the same constraint language the decoder
  reads.

### The decoder, rebuilt on top

Same Viterbi-over-bar-lengths shape as the killed probe — the shape was never
the problem — but scored by L1–L4 instead of the downbeat head alone, with one
structural change: the meter-change penalty is **conditioned on section
position**. Every score we read puts its odd bars at section seams (FaS bar 19
= verse end; WW at every verse end; NEM at every chorus end; WDOA at a chorus
exit), and TTP's four invented bars were all *mid-section* wobble. Cheap
changes at seams + expensive changes inside sections separates exactly the two
cases the flat penalty provably could not (§8: the sweep from 1.0 to 5.0 never
moved either song).

### Phasing, each step with a kill criterion

- **5a — the two evidence extractors: MEASURED, BOTH GO (2026-08-02).**
  Committed as `eval/beats/phase5-extractors.mjs` + `run-phase5a.mjs`.
  *5a-harm*: FaS's half-bar label sequence folds at period 8 with agreement
  0.88 and **94% mean residue purity** — the cycle `[Am D D D | C Am G E]`
  names a definite phase mod 4 bars (better than the promised mod 2), and
  the verified bar "still"@66.20 sits at residue 3 (G, exactly the Gx13
  run). The fold also *measures* our verse-1 parity error: the true bar
  lands on an ODD half-bar of our grid. Wild World's E-run anomaly
  reproduces in the committed extractor (x4 in full bars, x1 at the 2/4s).
  *5a-voice*: marks BOTH verified odd bars at **0.00 s** — "not"@70.55 (the
  5/4) and "go"@106.99 (the 3/4) — with Turn The Page's negative control
  clean (0 of 5 guard spots fire).
  Traps paid for on the way, so 5c does not re-pay them: energy rises miss
  legato ("dreams may not" never re-attacks — use the ALIGNED WORDS, the
  CTC aligner already segmented this stem); the pitch track follows
  accompaniment bleed straight through real rests (phrase ends must come
  from word gaps, not f0 gaps); the hold measurement is bleed-contaminated
  exactly at breaks (FaS's "go": 0.1 s of voice, 0.8 s rest, then the riff
  bleed sustains the stem — a SECTION-final word testifies by position
  alone, since bleed cannot fake an absence of words); a whole-song cycle
  fold is scrambled BY the meter changes being hunted (fold the verified
  clean window); and the extractor's phase must never be graded against OUR
  downbeats — our grid being wrong is the finding, not the failure.
- **5b — SSM repetition map: MEASURED, GO (2026-08-02).** `formMap()` in
  `phase5-extractors.mjs` + `run-phase5b.mjs`: beat-synchronous chroma +
  vocal activity at half-bar hops, checkerboard novelty for seams,
  translation-invariant local-context matching for repetition classmates
  (parity errors cancel — both instances of a repeated section shift
  equally, which is exactly why the layer can aggregate across an
  un-modelled meter change). Results: querying Wild World's first verse-end
  returns the other two at **rank 1 and rank 2 of 20**; TTP takes **0 of 5**
  false seams at its wobble spots, and its detected seams are real section
  starts. Bonus convergence: WW's seam list (36.5/89.1/141.7) independently
  marks the three verse-end 2/4 regions themselves.
  Traps, paid once: **one-loop harmony makes classmate lists promiscuous**
  (on WW everything matches everything above threshold — presence proves
  nothing, RANK is the test, and the vocal dims are what discriminate a
  verse end from any other bar of the same loop); **checkerboard novelty is
  genre-sensitive** (WW's novelty magnitudes are 10× smaller than TTP's,
  because a one-loop song has almost no harmonic novelty anywhere — seams
  are a bonus, rank-based classmates are the robust deliverable); and FaS's
  6–9 s guitar-only breaks vanish under the K=8 kernel (its seams find the
  verse STARTS beautifully — "It's not time to make a change" at both 15.7
  and 152.5 — but not the breaks; the vocal layer already owns those).
- **5c — the fused decoder. v1 MEASURED 2026-08-02: 10/17, NO-GO, with the
  diagnosis that designs v2.** The whole-song Viterbi (`decodeBarsFused` +
  `run-phase5c.mjs`) turns evidence into odd bars anywhere it can pay — and
  most phrase-final held notes sit on downbeats of perfectly UNIFORM bars,
  so the negatives bought spurious odd bars (TTP +4 including relocating its
  legitimate fermata 2; Dreamer +1 at the ring-out; Crowley shifted its
  ear-anchor 0.58 s) while SoF's real 2/4s were missed in favour of two
  wrong ones. The codebase already knew this lesson as "phrase starts float
  on pickups — keep weights low, never decisive"; v1 made held onsets
  decisive and re-learned it.
  Two structural findings for v2:
  (a) **The discrepancy IS the signal.** On the negative controls the
  shipped uniform phase already HITS the held notes — no conflict, no
  repair needed. On FaS/SoF/WW the swallowed odd bars make the shipped
  phase MISS the held notes by 1–2 beats — the same wandering-accent
  symptom the singer reports, now usable as the trigger. v2 is therefore a
  **repair operator, not a re-decode**: walk the shipped bars; only where a
  strong held onset disagrees with the current phase (and a seam or
  repetition classmate corroborates) insert one odd bar and reflow; re-merge
  with the shipped grid when phases coincide. Negatives stay untouched by
  construction — exactly the splice family's shape, one level up.
  (b) **The saved grids are the wrong substrate**: FaS's SAVED lattice has
  beat holes at exactly the trouble spots (69.14 = 1.93 beats), so
  index-based bar lengths lie — a correct 5-beat bar reads as 4 indices.
  The harness-fresh v17 lattice carries the beat (70.00) that the app's
  decode dropped. 5c v2 must run over the fresh lattice, i.e. inside
  run-current where the real gate lives — and the app/harness beat-count
  divergence on FaS (235 vs 238) is §6's decode-divergence trap surfacing
  at the worst possible spot, logged here so v18's heal verifies it.
  Gates unchanged: FaS barLenAt red→green, SoF 150.5→2, TTP five guards +
  fermata intact, Crowley/Dreamer untouched, every barAt still hit,
  Ballroom byte-stable.
- **5d — pins UI + score import**: the constraint compiler and the popover
  UI. The singer's tap wins over everything, including 5c.

Order matters: 5a and 5b are each a day-scale measurement that can kill the
design before any of 5c's complexity is paid for. 5d is valuable even if 5a–c
all die — pins alone would have fixed every meter complaint this week, by
hand, in seconds per song.

## 10. The render study (2026-08-24) — the model's input moves into the core

The question that opened it: can the desktop stop rendering the model's mix
in Chromium's `OfflineAudioContext` (an input that moves with every Electron
upgrade and cannot be reproduced on a phone) without changing the answers?
Method: 17 library songs x three renders of the same six stems to 22.05 kHz
mono (Chromium; the core's `sumStemsTo22k`; ffmpeg swresample), one model
(final0, mps), scored raw AND through the real fused `detectBeats` against
the ground-truth harness.

What fell out, in order:

1. **Raw lattices are render-equal, fused grids are not.** All three renders
   give identical GT outcomes on the bare model (10/16 each, beat F1 0.99
   between any pair) — but through the fusion, Chromium scored 52/55, the
   core's old brick-wall Kaiser 50/55, ffmpeg 54/55, with two downbeat
   ROTATIONS flipped (Father and Son, Zeit). Stable under a one-sample
   shift: real content differences, not seam luck.
2. **The filter was not the difference.** Rebuilding the core's decimating
   branch to swresample's published design (32 taps/net decimation, beta 9,
   cutoff 0.97 — replacing 48-tap/beta-10.056/full-cutoff) and making it
   time-true (odd tap count, `latencyOutFrames()` compensation; the old
   output ran ~2.1 ms late, history priming + group delay) brought the core
   mix to −32 dB residual against Chromium's… and still 51/55.
3. **The LEVEL was the difference.** ffmpeg's mono downmix is equal-power
   (0.707·(L+R)), +3.00 dB over WebAudio's 0.5·(L+R). The same core mixes
   scaled by sqrt(2): **54/55**, both rotations landing with the ground
   truth. Chromium's mix at +3 dB: 52/55 — so at equal level the sinc
   renders beat the linear-interpolation one, and `beat_this` normalizes
   nothing (`log1p(1000·mel)`), so input level is part of the model's
   contract. Every historical score in this document was minted through
   ffmpeg mixes — the research record was always calibrated at the hot
   level; the app ran 3 dB below its own rig.

Shipped as **v23**: `sumStemsTo22k` = swr-shaped 65-tap Kaiser, time-true,
×sqrt(2) equal-power level; the desktop's mix comes from `singz-analyze
mlmix` (main-side — `fetchMlGrid` renders nothing); `make-ml-grids.mjs` and
`run-beat-this.mjs` mix through the same subcommand, so the product, the
phones and this document's harness hear one input for good. Known-good
fused, v23 input: **54/55** (the one FAIL is Father and Son's `barLenAt`
105.5 s seam, want 3 got 4 — the meter-change class §9 exists for). Found
while landing this: `make-ml-grids.mjs` wrote RAW names where run-current
looks up SLUGS, so every multi-word song had been silently lattice-less in
every historical `--ml` run — the recorded "45/51 with the model" was a
partial-lattice score. Ids are slugged at mint now; 45/51 partial and 54/55
full-lattice are not comparable numbers. `scripts/render-ml-mix.cjs` survives as
the way to reproduce a pre-v23 grid.

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
| 16 | Per-span model level (both-set membership + insert level check), model-ambivalence-gated octave window | Wild World: wrong bpm, half-tempo last third |
| 17 | Adopted lattices flattened to one level; doubling gated on the model having committed to one; symmetric level-mix statistic | Father and Son: 136 bpm with a 250 bpm intro |
| 22 | Every analysis reads stems from FILES at the file's rate | Device-rate octave flips (§6) |
| 23 | Model input rendered by the core: swr-shaped time-true resampler, equal-power (+3 dB) level, `mlmix` everywhere | The render study (§10) |

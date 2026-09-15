# Offline pitch regression gate — 14 September 2026

PR #37 keeps the new live microphone detector and training octave scoring, but
narrows the offline melody change to the corrected parabolic residual. Offline
pYIN retains its established 65–1000 Hz range, 1024-sample decimated windows,
50-cent state grid and local transition prior. The cleaner retains its positive
27.5 Hz internal reference. Both stored melody version constants are **4**, so
projects previously analyzed with experimental version 3 are re-derived.

This decision follows an ablation on the user's existing local evaluation
corpus. It is not a claim of manually annotated singer accuracy. CREPE is an
independent model reference and can itself follow another singer or an octave.
The earlier version-3 reports remain historical evidence, not version-4 claims.

## Method and causal evidence

Baseline is `fa00dd4e`; experimental version 3 is `96ba777`. The regular corpus
has 43 vocal inputs, each evaluated on its original vocal stem and separated
lead. The 159.538-minute MASTER recording adds the 44th vocal input, using its
existing 54 overlapping cores (180.32 seconds with 7.36 seconds of context).
All original separation and CREPE results were reused. PCM hashes and exact
window-center timestamp alignment were checked. Six instrumental inputs were
checked separately for valid full-length output, not vocal accuracy.

The initial causal sample contained the six largest regular mixed-stem
regressions and two improvements as controls. Changing one factor at a time
showed:

- Removing the harmonic prior made agreement worse; it was not the main loss.
- Restoring the older range and CMND integration geometry recovered some loss.
- Removing the new octave-transition edges recovered more, but reintroduced
  an incorrect octave throughout a weak-110 Hz phrase followed by 220 Hz.
- Reducing the octave-edge weight preserved that synthetic leap but did not
  remove the aggregate regression. This was not selected or tuned further.
- Correcting only the parabolic residual improved the held-out remainder too.

For the full 43 inputs, the raw tracker lost 1,103 correct mixed-stem agreements
on the same original timestamp set; the cleaner recovered 15, leaving 1,088
lost. On lead stems, raw lost 905 and the cleaner recovered 17. The cleaner was
therefore not the cause. Reapplying the retained positive-reference cleaner to
the selected candidate changed no voicing or reported agreement counts.

## Final version-4 results

Each row below keeps the **original baseline/version-3 common-voiced timestamp
set fixed**, including the independent reference. A version-4 frame that becomes
unvoiced counts as incorrect; it does not disappear from the denominator.
Numbers are percentages within 50 cents of the fixed CREPE reference.

| Input and fixed timestamps | Baseline v2 | Experimental v3 | Selected v4 |
| --- | ---: | ---: | ---: |
| Regular 43, mixed, 168,483 frames | 87.5293 | 86.8835 | **87.6545** |
| Regular 43, lead, 161,446 frames | 90.5015 | 89.9514 | **90.6693** |
| All 44, mixed, 208,603 frames | 86.1292 | 85.4681 | **86.2293** |
| All 44, lead, 188,474 frames | 90.3345 | 89.7689 | **90.4942** |

On MASTER alone, mixed agreement decreases by **two frames** out of 40,120
(80.249252% → 80.244267%); lead improves by 30 out of 27,028
(89.336984% → 89.447980%). The aggregate gate passes; individual songs are not
all improved. The regular-corpus candidate also increases correct coverage over
*all* CREPE-voiced timestamps versus baseline: mixed 65.1130% → 66.0158%, lead
71.1872% → 72.0132%. The result is not obtained solely by discarding difficult
frames. Experimental version 3 did have higher correct coverage over all
reference-voiced timestamps (66.9705% mixed / 72.8989% lead), so selecting v4
trades some of that coverage for better agreement on the baseline timestamp
set. This is a modest improvement over v2, not a universally best detector.

Separation still improves agreement with the final detector. On all 44 inputs,
using the same original-vocal CREPE reference and the exact 186,343 timestamps
voiced by both version-4 inputs, mixed → lead is **88.0725% → 89.3315%**. Using
the fixed lead CREPE reference gives 88.0011% → 90.6670% on 181,925 timestamps.
For Time, the original-reference comparison is 2,360 → 3,188 correct frames out
of the same 3,523 (66.9884% → 90.4911%). These are model-agreement results,
not evidence that every retained or removed phrase belongs to the lead singer.

## Synthetic scope and known limitations

The known-fundamental matrix uses 165 cases: 11 frequencies, five harmonic
profiles and three sample rates. Final live capture is **165/165**, compared
with baseline **85/165**. Final offline tracking is **115/165**, compared with
baseline **113/165**. The experimental offline version's 165/165 is deliberately
not claimed for the selected version.

Offline weak-fundamental octave locks, the weak-110 Hz → pure-220 Hz leap, and
notes outside the established offline range remain limitations. Clean octave
leaps and vibrato remain covered by tests. Training's live detector and
wrong-octave scoring fixes remain unchanged. The low-coverage distorted song
and the existing lead-retention listening flags remain unresolved; this gate
neither deletes them nor treats model agreement as a listening substitute.

## Verification and reproduction

- Updated offline unit tests retain clean-note/vibrato/leap coverage and add
  the bright 880/1000 Hz signals that the sign fix actually repairs. Live
  harmonic, low-register and genuine-high-note assertions remain intact.
- The live C++ numerical fixture still contained the exact old TypeScript
  values. The identical Float32 440 Hz/4096-sample/48 kHz signal produces
  `440.0181387383385` Hz and clarity `0.9999986518725669` in current TypeScript,
  versus the old `440.01758519081193` / `0.9999863087477934`. RMS is unchanged.
  Native expected values were corrected and a matching TypeScript assertion
  added; the live detector was not changed to satisfy the old fixture.
- Fresh native version-4 output was compared against all 86 regular candidate
  arrays and all 108 MASTER candidate chunk arrays. Voicing and lengths match;
  maximum absolute differences are below 0.000001 Hz for f0/raw and 0.000000001
  for RMS (the CLI serializes finite decimal precision).
- The permanent melody parity driver passes Time mixed and lead at both
  44.1 and 48 kHz. All six instrumental controls produce finite full-length
  arrays with valid frequency values; periodic instrument tones are expected.

Standard repository checks:

```sh
npm run typecheck
npm test
node mobile/scripts/build-analysis.mjs
node mobile/scripts/sync-singzcore.js
bash scripts/build-analyze-host.sh /tmp/singz-analyze-v4
node eval/pitch-synthetic.mjs --baseline /path/to/v2-bundles --out /tmp/synthetic-v4.json
node eval/melody-parity.mjs --bin /tmp/singz-analyze-v4 /path/to/Time-vocals.f32 /path/to/Time-lead.f32
```

Private corpus evidence and exact ablation scripts are retained locally under
`.local/pitch-evaluation/gates/regression/` in the main checkout. Key artifacts:
`sign-full-metrics.json`, `master-metrics.json`, `final-separation.json`,
`decompose.json`, `metrics.json`, `shipping-synthetic.json`, `native-verify.json`,
`instrumental-controls.json` and `windows-vectors/manifest.json`. `ablate.mjs`
records every one-factor source transformation; `full-metrics.py` and
`master-assemble.py` record the masks, PCM hashes and sample-grid assembly.
No user audio was changed or uploaded for these local measurements.

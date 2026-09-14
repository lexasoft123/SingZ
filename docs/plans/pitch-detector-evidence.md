# Pitch detector implementation and evidence

The production detector retains YIN's cumulative mean normalized difference
(CMND), with pYIN's threshold distribution and Viterbi for the offline melody.
It now compares competing periods against the waveform before either detector
selects a pitch. Offline alternatives remain available to sequence decoding. It never changes the detected frequency to match a training
target. This is a measured refinement of the existing algorithm, not a claim
that a monophonic detector can resolve two simultaneous singers.

## Research and choice

[Mauch and Dixon, pYIN (2014)](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf)
uses multiple threshold-weighted YIN candidates and sequence decoding. That is
useful for separated vocal audio with imperfect voicing, but an early
half-period dip can still win when the second harmonic is much louder than the
fundamental. The current implementation also contained a sign error in the
parabolic trough-height formula: `s1 - (s2-s0)*delta/4` increases the residual at
a local minimum. The corrected formula uses `+`.

[McLeod and Wyvill, A Smarter Way to Find Pitch (2005), author-uploaded paper](https://www.researchgate.net/publication/230554927_A_smarter_way_to_find_pitch)
describes the normalized square difference function (NSDF), relative peak
selection, and sub-sample interpolation. The reproducible benchmark compares
an NSDF implementation with relative cutoffs 0.93 and 0.99. The stricter cutoff
handles the tested weak fundamentals, but changing detector family alone does
not eliminate octave ambiguity. Retaining the existing CMND implementation
allows shared live/offline evidence and native parity without adding a second
production estimator. Benchmark MPM is a direct implementation, not an
optimized FFT implementation; its timing cannot establish a general MPM speed
comparison.

## Implementation

1. Find all CMND minima and interpolate their periods and residuals correctly.
2. A shorter candidate is a possible harmonic lock only if a longer period
   (1.2–4.04 times as long) reduces normalized error by more than 0.01 and by
   more than half. Those are empirical evidence margins, not published pYIN
   defaults. Considering noninteger ratios also rejects the two-thirds-period
   dip produced by a dominant third harmonic.
3. Confirm each proposed rejection against cubic fractional-delay PCM and a
   normalized squared residual. Integer-lag parabolic interpolation alone is
   insufficient for bright high notes after decimation: a true 1000 Hz note
   with a dominant 3000 Hz partial otherwise loses to a three-period lag.
   Residuals are computed lazily, only for candidates involved in a potential
   rejection. A pure high tone repeats equally at its period and multiples,
   so it retains its shortest valid period.
4. Live YIN selects from the retained candidates. Offline pYIN retains every
   candidate but multiplies the prior of an evidence-conflicted candidate by
   0.5, so context can still recover a real higher voice in a mixed vocal stem.
   It retains the original 65 Hz quantization-grid reference independently of
   the expanded frequency bounds, and the original 35.92-octave/second local
   transition triangle. Rare outer transitions with weight 0.5 extend support
   to an octave attack without flattening the whole transition distribution.
   Both changes matter: moving the grid or widening the whole triangle changed
   ordinary notes unnecessarily.
5. Singing range is now 55–1050 Hz. Native live windows already contain more
   than two A1 periods at their maximum 48 kHz analysis rate. Web Audio sizes
   its window for the input sample rate. Offline uses at least 1024 decimated
   samples and at least 64 ms. The cleaner's internal reference moves to
   27.5 Hz so an A1 frame no longer collides with its zero/silence sentinel.
   Stored melody encoding remains cents above 55 Hz. Both version stamps are 3.
6. Both desktop and mobile training used to fold harmonics 2–8 and lower octaves
   toward the expected note before evaluating a lock or recording a score.
   That code is removed. A stable octave change also updates the displayed
   median directly rather than taking many seconds at six cents per update.

## Verification

Run `node eval/pitch-synthetic.mjs --baseline <saved-baseline-folder> --out <report.json>`.
The baseline folder contains ESM bundles of pre-change `pitch.ts` and
`pitch-core.ts`. The 165 deterministic stationary cases cover eleven
fundamentals from 55 through 1000 Hz, three sample rates (44.1/48/96 kHz), pure
tones, weak fundamentals, dominant second and third harmonics, and absent
fundamentals with both second and third partials present.

| Detector | Within 50 cents | Cases |
| --- | ---: | ---: |
| Previous live YIN | 85 | 165 |
| Revised live YIN | 165 | 165 |
| Previous offline pYIN | 113 | 165 |
| Revised offline pYIN | 165 | 165 |
| MPM benchmark, cutoff 0.93 | 141 | 165 |
| MPM benchmark, cutoff 0.99 | 165 | 165 |

These are synthetic results, not accuracy percentages for the user's songs.
The matrix is designed to expose the reported harmonic and range failures.
Separate unit tests check vibrato, real octave leaps, pure high notes, noise,
silence, invalid live inputs, A1 serialization, and rejection of wrong-octave
training attempts. Pitch/desktop-training regression tests and sixteen
mobile training-runtime tests passed. The final desktop transition/cancellation
review fixes also pass sixteen focused tests. Fifty neighboring melody/scoring/microphone
tests, renderer TypeScript, and mobile TypeScript also pass. Native `zdsp_analysis_tests` includes
72 known-pitch cases, and its capture/gain/timing tests pass. Exact TS/C++
`f0`, raw, and RMS parity passes a four-second changing-pitch/noise/vibrato
fixture at 44.1, 48, and 96 kHz using `eval/melody-parity.mjs`. An additional
84 live frames match C++ frequency, clarity, and RMS exactly.

The conservative benchmark run measured 728 ms live and 2915 ms offline across
all 165 cases, versus 634/1510 ms for baseline; the offline input totals 82.5 seconds.
These are wall timings with concurrent work on the same Mac. Native capture
handoff averaged 1.12 ms against a 10.67 ms hop in its test run. The final iOS check below uses a fresh native build and installation.

Full-song CREPE comparisons and lead/backing separation evidence are recorded
by the corpus evaluation task. Agreement with another detector is diagnostic,
not a transcription ground truth. Polyphonic vocals remain an ambiguity;
lead/backing separation addresses a different input problem than a harmonic
within one singer's voice.


## Why offline alternatives are retained

The first hard-rejection implementation passed all stationary synthetic cases
but reduced agreement with independent CREPE on the 23 library songs plus
Time: about 86.5% to 84.4% on common voiced frames. Removing offline pruning
entirely brought it to 85.4%, and a strong 0.1 prior multiplier to 85.3%.
Those are reference-agreement measurements, not truth labels, but they are
sufficient reason to reject the hard-removal design for potentially mixed
vocals. The final conservative candidate uses a gentler 0.5 multiplier and
preserves the earlier pitch grid and local transition shape. It still passes
all 165 stationary cases and the genuine octave-leap/vibrato test. A 0.75
multiplier passed stationary cases but failed the leap with rare transitions;
0.9 and 1.0 failed 24 stationary weak-fundamental cases. These experiments are
scratch artifacts under the task's pitch-eval directory.


The conservative candidate's final 24-song comparison uses 94,550 frames
voiced by both versions and CREPE. Reference agreement within 50 cents is
86.565% for baseline and 85.893% for the revised tracker (−0.672 percentage
points). Octave-below disagreements are 4.513% versus 4.641%; octave-above
are 0.459% versus 0.631%. This is the closest-to-baseline tested refinement
that passes the known harmonic and real-leap regressions. It does not support
a claim that every mixed-vocal recording is more accurate. Separation and
listening/annotated reference are needed to establish which singer should be
followed when two voices coexist. Full tables are in the corpus task's
`comparison-conservative.json` and `report-conservative.md` scratch artifacts.

## Fresh iOS simulator verification

Xcode Debug was rebuilt from this feature tree and installed on a separate
iOS 18.1 iPhone 16 simulator, `SingZ-Pitch-Verify`, with its own Metro port
8083. The build log confirms compilation of the changed `melody.cpp` and
`live_input_analysis.cpp`; the generated native source hashes match zcore.
The installed native `analyzeMelody` bridge reports detector version 3.

The permanent `__test.melodyParity` hook ran on three 3-second, 44.1 kHz WAV
fixtures with a fundamental at 0.1 amplitude, second harmonic at 1.0, and
third harmonic at 0.2. All 351 voiced frames matched native versus TypeScript
exactly. Native median frequencies were 55.0003, 110.0018, and 880.3649 Hz for
55, 110, and 880 Hz inputs. Native processing took 62–86 ms per fixture.

The already loaded production `SingleNoteLockTracker` module was exercised
in the simulator's Hermes runtime: singing MIDI 72 against target 60 left
progress at zero and displayed 72; changing to 60 reached the ordinary hold
lock; the next 72 reading immediately changed `locked` and `centered` to
false. This tests the production runtime logic, not a physical microphone or
an automated sung UI session. Playback master and training cues were muted.
The app's healthy catalog screenshot was read after verification. Android,
physical iPhone capture, and acoustic microphone conditions remain unverified.

Machine-readable evidence and the scratch driver are respectively
`/private/tmp/singz-pitch-eval/ios-pitch-verification.json` and
`/private/tmp/singz-pitch-eval/ios-pitch-verify.cjs`; native build output is
`/private/tmp/singz-pitch-eval/ios-build.log`.

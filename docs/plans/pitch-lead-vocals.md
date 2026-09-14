# Pitch and lead/backing vocals

## Phase 0 — evidence and APIs

Existing offline math: `trackMelodyCore(mono, sampleRate, onProgress)` in
`src/renderer/src/audio/pitch-core.ts`, `pyinTrack` in `audio/pyin.ts`, mirrored by
`zcore/src/legacy/melody.cpp`. Stored stamps: `PITCH_DETECT_VERSION` and
`kPitchDetectVersion`. Native live path: `zdsp::analysis::analyzeLiveInput` delegates
to `singz::analyzeLiveInput` in `zcore/src/legacy/live_input_analysis.cpp`;
Web Audio fallback calls `yinPitchInfo` in `audio/pitch.ts`.

Research: Mauch/Dixon pYIN (https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf)
uses multiple candidates and Viterbi; McLeod/Wyvill MPM uses normalized square
difference and relative peak selection. CREPE reference implementation
https://github.com/maxrmorrison/torchcrepe supplies `predict(audio, sr, hop_length,
fmin, fmax, model, batch_size=..., device=..., return_periodicity=True)`; its
README requires silence gating and warns about octave errors from argmax.

Baseline: 110 Hz fundamental and third harmonic each at 0.2 of second harmonic,
48 kHz, produces 221 Hz with live YIN. At 0.1 pYIN also produces 220 Hz.
55 Hz lies below both configured lower bounds. A signal containing ONLY 220 Hz
has no evidence of a 110 Hz fundamental and must remain 220 Hz.

Corpus: 23 projects under configured iCloud SingZ library; 27 top-level audio
files in Downloads (includes stems and backing tracks), including Pink Floyd -
Time.mp3. Keep originals unchanged. Write model outputs and reports in scratch.

## Phase 1 — pitch

Implement measured harmonic-resistant candidate selection in both TS and native
paths; compare MPM and YIN variants on known synthetic pitch. Cover singing low
register with an adequate analysis window, preserve genuine high notes/octave
leaps. Use `tests/unit/pitch-core.test.ts` and `zdsp/tests/zdsp_analysis_tests.cpp`
for test conventions. Change stored stamps together if offline output changes.
Verify exact or documented native/TS parity, invalid input and silence behavior,
strong harmonics, vibrato and real leaps. Never fold toward a target or global
median as a substitute for fundamental evidence.

## Phase 2 — lead/backing separation

Choose locally executable, documented karaoke/lead model using primary model
sources, record model hash/license/size. Implement actual inference with progress,
cancellation, cache integrity and a reviewable app route; reuse main separation,
model and IPC patterns. Use lead vocals for melody and expose backing audio
without changing the six canonical stems contract blindly. Keep old projects
readable. No automatic publication or overwrite of the user's library.

## Phase 3 — full corpus verification

Run baseline/new pitch on every available library song and each additional full
song, and run the chosen separator on vocal audio. Report counts, failures,
coverage, octave disagreements and processing cost. Agreement is not ground
truth; flag ambiguous harmonies and obtain human reference before claiming
accuracy. Use synthetic known truth and independent CREPE as complementary
checks. Build and drive actual Electron with SINGZ_MUTE=1 and SINGZ_NO_SYNC=1,
read screenshots. Native mobile changes need rebuild/install before device
claims. Typecheck, relevant unit/native tests and parity checks, then review.

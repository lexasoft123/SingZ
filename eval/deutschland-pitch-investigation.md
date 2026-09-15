# Deutschland pitch gaps — 15 September 2026

The reported 2:27–2:30 phrase has missing detector output as well as hidden
note labels. These are separate defects. Pitch labels were conditional on
`rowH >= 4.5` even in Note bars mode; fitting this wide-range song into a
compact strip hid every name. Note bars now retain a minimum 11 px font and
use horizontal collision checks at every lane height. A note starting before
the visible time window anchors its name to its visible portion.

## Verified display change

Typecheck and production build pass. The notes, pitch-core and live harmonic
suites pass (32 tests). An isolated, silent Electron run loads a copy of the
user's Deutschland project through the file input, enables karaoke, seeks to
148.6 seconds and renders D3 and C3 labels at a 150 px strip height. Its
screenshot was visually inspected. The user's project and running app were
not modified by the test. No detector, stored-analysis stamp or audio changed.

## Detector investigation — experiments only

The existing version-4 output on the evaluation corpus's separated Deutschland
lead has 28 voiced frames in 147–150 seconds; its raw tracker also has 28.
The cleaner and the note-bar renderer therefore cannot recover the missing
phrase. The independent CREPE reference marks 69 of the same 120 frame-center
timestamps as voiced. Amplitude alone is not a voicing annotation, and CREPE
is a comparison model, not human ground truth.

A 1 kHz low-pass experiment and two less-conservative pYIN threshold priors
were tested without changing production sources. Low-pass filtering recovered
more of this phrase, but the complete 43-song mixed/lead comparison found
additional pitch errors and extra voicing. Even restricting recovered frames
to filtered contours anchored to existing pitches reduced pitch agreement.
Those changes were rejected; making the strip fuller is not sufficient.

An exploratory RMVPE run used the RVC project's published ONNX model, pinned
to Hugging Face revision `20ae0c813d09b07efab8ddc4ce75cc2c012e1e63` (roughly
345 MiB), with upstream log-mel preprocessing, local weighted pitch decoding,
30-second chunks and one second of context. CPU inference took about 12
seconds per Deutschland lead. On the same 120 frame-center timestamps:

| Detector | Within 50 cents of reference | Voiced where reference is unvoiced |
| --- | ---: | ---: |
| Existing v4 | 28 / 69 | 0 |
| RMVPE, upstream 0.03 confidence threshold | 61 / 69 | 27 |
| RMVPE, exploratory 0.5 threshold | 61 / 69 | 12 |

Over the whole song's 3,721 reference-voiced timestamps, v4 agrees on 1,590,
RMVPE at 0.03 on 2,838, and RMVPE at 0.5 on 2,421. The higher threshold is an
exploratory comparison, not a selected or validated production default.
Neither run establishes all-song accuracy or correct lead-vocal identity.
RMVPE is not integrated into the app; the missing-pitch issue remains open.
A production integration needs the full corpus, silence/voicing controls,
model-download UX, cancellable inference, persisted model provenance and
cross-platform verification.

Sources: [pYIN paper](https://webspace.eecs.qmul.ac.uk/s.e.dixon/pub/2014/MauchDixon-PYIN-ICASSP2014.pdf),
[RMVPE paper](https://www.isca-archive.org/interspeech_2023/wei23b_interspeech.html),
[RVC inference implementation](https://github.com/RVC-Project/Retrieval-based-Voice-Conversion-WebUI/blob/main/infer/rmvpe.py).

Local diagnostic files, metrics and screenshots are preserved under
`.local/pitch-evaluation/gates/deutschland/` in the main checkout. Model weights
and copied song audio remain outside the repository.

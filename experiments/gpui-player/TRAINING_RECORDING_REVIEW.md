# Native training recording checkpoint — 2026-11-07

Status: **completed functional checkpoint**. Final unit/build, hidden recording
UI, direct native input, training-run and strict native-frame regressions pass.
The full desktop port, physical hardware qualification and production visual/audio
parity are not complete.

See the [completed evidence archive](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-training-recording-20261107/REVIEW.md).
The archive includes the final manifest, exact source identities and verification logs.

## Source-backed scope

Production references are `src/renderer/src/components/VocalTraining.tsx`'s
`TrainingRecording`, `src/main/audio-input.ts::recording` and its
`audio-input:save-recording` handler, and
`zcore/include/zcore/audio/capture_recording.h`. Recording is a training sample
attached to the microphone training already owns, not a general song recorder.
It does not add a recording to the project as a custom lane.

The native implementation includes:

- Record/Stop and Save training WAV controls for non-identification training,
  using the source cue/respond/feedback availability and busy/message states.
- Existing owner-4 capture and generation fencing. Shared `CaptureRecording`
  receives raw mono input before CREPE, retains the actual sample rate, stores
  PCM16 and caps audio at 30 seconds. Rust receives receipts, not PCM.
- Private take staging, validation and durable retained WAV publication under
  the native config's `training-recordings` directory. Stop, navigation and
  capture cleanup finish an owned take; recoverable publication faults retain
  the available audio.
- Monotonic take IDs and permanent pending-receipt detachment after context
  changes. Returning to the same practice cannot reattach a prior Started,
  Finished, error or finish-queue error. Header navigation detaches immediately.
- A separate bounded export worker with strict trusted-root/ordinary-file and
  WAV validation, staged copying, source integrity revalidation, exclusive new
  destination publication and approved-overwrite conflict guards. Export failure
  or cancellation preserves the retained original. Already committed exports
  remain successful when cancellation arrives after publication.
- Native Save destination selection. The hidden-test path interception goes
  through the same acceptance method and actual export worker; it does not
  establish that a real OS chooser was presented or exercised.

Training recordings and exports do not change project files or mark project
sync dirty. Google Drive upload/account integration remains unconnected.
Arbitrary custom tracks, stem export and project deletion remain separate work.

Implementation files are `training_recording.rs`, `training_recording_host.rs`,
`training_recording_store.rs`, `microphone.rs`, `training_running.rs`, host hooks
in `main.rs`, shared UIKit training controls and
`tools/native/singz-gpui-input.cpp`.

## Verification at this checkpoint

| Check | Recorded result |
| --- | --- |
| Normal Rust unit/domain suite | PASS: 390 passed, 0 failed, 2 ignored; `/tmp/singz-training-recording-unit-final.log` |
| Native helper build | PASS: `/tmp/singz-training-recording-native-build.log` |
| UI-feature application build | PASS v2: `/tmp/singz-training-recording-ui-build-v2.log` |
| Hidden recording/capture/export runtime interactions | PASS v2: `/tmp/singz-training-recording-ui-v2`; 12 PNGs and 6 WAVs at both desktop sizes |
| Direct native input/recording checks | PASS v2: `/tmp/singz-training-recording-input-v2` |
| Prior input/microphone/monitor regressions | PASS: `/tmp/singz-training-recording-input-regression`, `/tmp/singz-training-recording-microphone-regression`, `/tmp/singz-training-recording-monitor-regression` |
| Normal application build | PASS: `/tmp/singz-training-recording-normal-build.log` |
| Training-run regression | PASS: `/tmp/singz-training-recording-training-regression-driver.log` |
| Comparator self-checks | PASS: 8 checks |
| Strict native baseline regression | PASS: 84/84 full frames identical; `/tmp/singz-training-recording-regression-v2/strict-comparison.json` |
| Archive review and manifest | Complete; link above |
| New production-matched visual/temporal captures | Unqualified; no parity claim |
| Physical microphone, permission UI and actual native chooser presentation | Unqualified |
| Windows and Linux recording/export execution | Unqualified |

The storage suite contains 18 tests covering actual worker export to Unicode
destinations, exact byte preservation, retained originals, approved overwrite,
out-of-root/untrusted paths, empty/truncated/unsupported/overlong WAVs, sparse
oversize refusal, staged cancellation, changed source and destination, linked
files, source/target replacement identity, busy leases, private-stage tampering,
optional WAV chunks and cancel-before-start versus cancel-after-commit receipts.
Domain tests cover normal duration/finish behavior, navigation during start and
same-practice A→None→A late receipt/queue-failure rejection. Passing these tests
does not establish physical hardware quality or interface parity. The separate
runtime results below exercise replayed native input and actual file exports.

## Runtime evidence and qualification limits

The actual hidden/muted v2 UI driver passes using isolated preferences, native
PCM replay and the real recording/export workers. It produces 12 PNGs and 6 WAVs
at both desktop sizes. Native Tab/Space/Enter controls trigger their recording
operation once without leaking into global Play; assertions cover guidance/dock
nonoverlap and left status placement. V1 passed interactions, but inspecting its
renders found overlap. The source compact-height rules below 680 px and normal
metrics were applied; both v2 sizes were inspected and the overlap resolved.
These are candidate captures, not new production-matched parity evidence.

Direct input v2 verifies actual raw 8 kHz PCM before CREPE and the exact
30-second recording cap while capture continues. Wrong generation/take ID,
duplicate recording, monitor refusal, symlink/existing destination, empty take
cleanup and stop-finalization checks pass. The prior input, microphone and monitor
regression drivers also pass. Logs use the corresponding
`/tmp/singz-training-recording-*-driver.log` paths.

The final normal unit suite passes 390 tests (0 failed, 2 ignored), and the normal
application build and training-run regression pass. All 8 comparator self-checks
pass. The strict regression records 84/84 full native frames identical to their
immutable baselines. The initial two training Home comparisons differed only at
hover borders (6,110 and 7,140 pixels); final captures move the app-local pointer
outside the Home surface before rendering, matching reference hover state. The
baselines were not modified. Final UI v3 changes only this test-adapter settlement;
recording production code remains unchanged from the passed v2 UI suite.

Performance evidence contains 56 UI-process CPU samples: median 1.52%, peak
86.08%. This excludes the separate native helper processes. GPU observations are
system-wide and cannot be attributed to the app; hidden live display FPS remains
unmeasured.

Native PCM replay is not physical hardware capture; Save-path interception is
not a presented OS chooser. Actual microphone/permission/chooser presentation,
Windows/Linux execution and production-matched visual/temporal parity remain
unqualified. Hidden stepped rendering leaves live display FPS unmeasured.

The completed diagnostics checkpoint remains independent and unchanged; its
passed results do not substitute for this new recording verification.

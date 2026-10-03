# Shared CREPE Tiny and training parity

CREPE Tiny realtime inference now lives in `zdsp/analysis/crepe_tiny`, with capture supplied by zcore. The same frozen 1.9 MB float32 weights are bundled on iOS, Android and desktop. No ONNX runtime is required by this detector. Apple uses Accelerate SGEMM; Windows and Android use the portable vectorizable CPU kernel.

The pluggable [pitch-analysis module](zdsp-pitch-analysis-module.md) owns detector selection and runs capture through a compiled graph tap. Capture is resampled to 16 kHz, with a 64 ms window and 20 ms hop. Inference runs on the capture delivery thread, outside the realtime audio callback. Confidence and continuity filtering use the detected signal, without an exercise target. Desktop display smoothing uses an 80 ms time constant; scoring uses current pitch evidence rather than the display's animation.

## Feature paths

| Feature | Desktop | iOS / Android |
| --- | --- | --- |
| CREPE Tiny | native `singz-analyze live-input`; training and pitch strip | shared zdsp through native capture bridge |
| Raw microphone WAV | bounded zcore recorder; Save WAV | bounded zcore recorder; platform share sheet |
| Recording identity | unique filename logged on start and save | UTC/session/take filename logged on start and save |
| Session logs | current session and ten previous | current session and ten previous |
| Range/exercise distribution | shared training generator | generated copy of the same generator |
| Note lock cue and organ | shared registration and desktop audio controller | same registration and mobile cue engine |
| Visual feedback | fast pitch smoothing and state fade | native meter animation and state fade |

A saved desktop Chromium microphone selection that has not yet been matched to a native device retains the existing Web Audio fallback. Reselecting the microphone in Settings establishes the native route. Unavailable old development binaries also retain that fallback; native build provenance identifies stale binaries.

## Verification on 2026-10-03

- All 360 probability outputs agree with the pinned ONNX reference within 0.0001 across six seeded noisy windows. Checked with Apple Accelerate, forced portable host kernel, and Android ARM64 emulator executable.
- The native regression checks silence, invalid framing, filename validation and bounded 30-second PCM16 WAV output. Graph tests additionally verify custom detector framing, capture timestamp preservation, passthrough, bounded queue recovery and inference outside the render callback.
- Rebuilt iOS simulator app: packaged silence and four known tones pass, with pitch errors below four cents. The compiled detector marker is `crepe-tiny-zdsp-graph-v2`.
- Rebuilt Android ARM64 app: native capture, recording and finalization pass through its actual React Native bridge, producing a named 48 kHz WAV and no capture overruns.
- Desktop build and silent Electron range UI check pass. After the graph refactor, the real Electron app delivered 63 capture-analysis windows with no overruns; the rebuilt CREPE helper delivered 48 graph-analysis windows in a one-second capture check. Full desktop regression: 1,828 passed, two skipped. Focused mobile suites: 66 passed.
- Native helper builds pass on Apple Silicon and Intel Mac; Android app builds pass for arm64-v8a and armeabi-v7a.
- Windows uses the shared portable sources and existing native build integration. A Windows build/device run was not performed on this Mac.

These checks do not establish noise robustness or end-to-end latency on a physical phone in a car. The existing raw car WAVs remain useful for that evaluation; the synthetic probability fixture is a numerical parity check.

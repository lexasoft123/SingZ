# Native Qwen runtime qualification — 2026-11-09

Adds an opt-in real-engine UI test alongside the existing Precise journey. Normal
runtime behavior is unchanged. The driver pins source fixture, three existing GGUF
models and native executables before/after, uses private config/library/cache roots,
and checks real inference, finite timings, explicit Save and reopened state. Only
the private copied project loses `songFile`, excluding original-song cache reuse.
No downloads, Node/Electron execution, foreground activation or microphone capture.

## Results

- Normal check and UI-feature build pass. Staged code review reports no findings.
- Packaged native backend: cold alignment 21.707 s, cached alignment 0.771 s,
  transcription 2.524 s; 26 timed words. Optional Precise inference was not exercised.
- Final real UI run (`ui-v2`) passes preview without disk publication, explicit
  Save, exact accepted timings after editor/player reopen, and native Play/Pause.
  Four full screenshots at 1280×800 and 1060×640 were inspected. Source/model/runtime
  identities remain unchanged; foreground stays stable; observed processes retire
  with no observation errors. Runtime 6.901 s on a fresh private heard cache.
- Ten app CPU samples: mean 41.78%, max/p95 81.97% (100% is one core);
  app footprint mean 474,303,422 B, max 657,573,328 B. All ten system GPU readings
  are available; values include other processes. Helper CPU is excluded. No sampling
  errors. These are resource observations, not a performance pass; live FPS is
  unmeasured for hidden windows.

## Startup investigation

The earlier ten-second `llama-server --help` timeout was a narrow CLI preflight,
not the app's readiness probe. A sampled attempt waits in Metal library compilation.
A longer attempt completes in 19.732 s; subsequent help/version invocations complete
in approximately 0.06 s. CrispASR help also exits successfully. Actual app jobs
pass using the existing 180-second Qwen health budget. No production timeout,
GPU setting or OS security policy was changed; no system cache was manually reset
or edited. This evidence qualifies
startup and the tested workflow on this host; it does not guarantee first-cold
startup on every host.

## Evidence and limits

Working evidence: `/tmp/singz-engine-startup-20261109` (startup samples,
`real-runtime/lyrics-alignment-real-receipt.json`, `ui-v1`, `ui-v2`). Durable selected
receipts/captures are beside the normal preview in
`gpui-native-packages-20261108/macos-mixer-keys-20261109/engine-runtime-qualification-20261109`
under the session visualization directory. Model weights, work profiles and binaries
are excluded from Git.

UI binary SHA256: `abccdcef915e357d971ed4db1dbe9949ed200671a88a5e065067cd1e858f20b8`.
Llama SHA256: `cd63d2bf7f9257ed775c80931f7f0d9c216b8ade177876026c1b8a8704a26ed0`.

The fixture is spoken audio, not singing timing ground truth. Automatic no-lyrics
sidebar transcription with real inference, hardware/OS choosers, current Windows
and Linux delivery, complete production visual/temporal parity and live FPS remain
open. The preview is ad-hoc signed, not notarized or release-ready. No glyph renderer
or font changes were made in this checkpoint.

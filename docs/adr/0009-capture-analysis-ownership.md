# ADR 0009: Capture analysis ownership and product bridges

Status: accepted for the Phase 2 portable/mobile slice
Date: 2026-08-27

## Decision

`zcore_audio` owns device capture transport metadata and PCM only. Each
preallocated ring slot stores a typed value containing clock domain, stream
generation, sequence, source frame, sample/callback host timestamps,
timestamp quality/validity and a typed discontinuity. The hardware callback
does one bounded PCM copy plus this bounded metadata copy and wake signal. It
does not analyze, resample, log or invoke a product bridge.

`zdsp_analysis` is the explicit higher layer linking both packages. It maps
every zcore field into `zdsp::CaptureTime`, then runs level analysis and the
existing 2,048/512 live pitch contract on the ordinary delivery thread.
`zcore_live_analysis_compat` is the temporary neutral compatibility target
containing the one legacy resampler/YIN implementation; both the old adapter
and `zdsp_analysis` call it, so parity is structural rather than a comparison
between two algorithms. It is not part of `zcore_base` or callback reachability.
A
generation, rate, quality, sequence, source-frame, clock or typed boundary
clears incomplete windows before accepting the new block. App boundaries
receive copied, timestamped scalar evidence only.

Clock continuity compares both validity transitions and valid anchors. Host
timestamp jitter within the larger of 2 ms and half a callback is tolerated;
larger forward/backward movement is an explicit `ClockReanchored` reset.
Every non-empty callback advances the attempted source-frame timeline, even
when its PCM is rejected; overflow saturates, invalidates that anchor and emits
`SourceFrameOverflow` rather than wrapping.

Android keeps its JNI-to-Kotlin scalar-event shape. iOS starts native capture
only after the RNAudioAPI-owned `AVAudioSession` transition and generation-
bound native lease. Native stop is a hard restoration prerequisite because it
joins delivery: on failure no lease, route, preference or playback cleanup is
attempted, and retry begins with stop again. Neither bridge emits PCM or owns
output.

Both native bridges suppress scalar delivery atomically, detach their input
and listener/context under the owning lock, then call `AudioInput::stop()` and
wait for delivery to join before destroying the adapter or bridge context.
Android's Kotlin owner remains latched until JNI confirms that stop; iOS's
session owner remains latched until native stop resolves.

For the later Electron slice, use one long-lived main-process Node-API owner,
not a helper process, for this capture-only path. Its proposed surface is:

- `beginCapture(config, ownershipGeneration)` returning negotiated scalar
  metadata;
- `cancelCapture(ownershipGeneration)` with synchronous native-owner teardown;
- `captureState()` and `captureStats()` values;
- `AnalysisWindow` scalar events containing ownership generation, capture
  provenance, reset reason/count, peak/RMS and pitch evidence.

The preload exposes those typed values through context isolation. The renderer
owns no native pointer, callback or PCM buffer. A helper process remains the
later default for untrusted plug-ins and crash isolation; adding it to this
capture-only path now would add a copy/scheduling hop without improving the
current trust boundary.

## Consequences

Raw capture time stays independent of Bluetooth, AirPlay and CarPlay output
latency. A future duplex render host can consume the same metadata through a
different render-domain adapter without relabeling this delivery sink as a
monitoring graph. Desktop binding, renderer cutover and deletion of
`getUserMedia` remain intentionally unimplemented.

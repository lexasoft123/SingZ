# ADR 0009: Capture analysis ownership and product bridges

Status: accepted and implemented for Phase 2 capture analysis
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
`zcore_resample` is the neutral ordinary-thread converter target shared by
media preparation and analysis. `zcore_live_analysis_compat` is the temporary
YIN compatibility target and composes that converter; both the old adapter and
`zdsp_analysis` call it, so parity is structural rather than a comparison
between two algorithms. Neither target is part of `zcore_base` or callback
reachability.
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

Electron uses one long-lived main-process stable Node-API owner,
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

The addon is an explicit build artifact outside the asar at
`resources/engines/singz-capture.node` with its checksum/source manifest.
The checksum is exact before packaging and on Windows. macOS signing mutates
the nested Mach-O after that checksum is emitted, so only the default packaged
Mac path may substitute a strict valid code signature for raw-byte equality;
the signature-invariant canonical Mach-O digest, sidecars, manifest and
compiled Electron/source identity must still agree. Re-signing changed code
cannot manufacture the sealed canonical digest.
Development independently fingerprints this checkout and resolves the matching
immutable artifact under
`build/capture-runtime/<target>/<source>/<binary-sha>/<generation>/`; the
shared `vendor/` tree is never part of capture-addon selection. It is built
against the installed Electron version's headers (and Electron `node.lib` on Windows), then loaded
by a real Electron smoke; a system-Node build is not accepted as evidence.
Before native loading, main reads the selected addon once and materializes
those exact bytes at a unique process-private `.node` path. Hash, signature,
canonical checks and `require()` all use that stable snapshot, closing selector
replacement races and giving retries distinct module-cache identities; a
successful path remains for mapped-DLL lifetime.
The main owner binds capture to both renderer id and ownership generation.
Native cancel suppresses analyzer delivery, stops and joins `AudioInput`, then
destroys analyzer/input state and releases the event bridge before the IPC
promise resolves. Renderer destruction and app quit execute the same stop.

Native input UIDs are deliberately distinct from Chromium output device IDs.
The saved input channel is zero-based and validated against the exact native
device. If a saved device/channel is unavailable, capture fails visibly and
does not substitute another physical channel; Web Audio remains the unchanged
playback/output owner.

## Consequences

Raw capture time stays independent of Bluetooth, AirPlay and CarPlay output
latency. A future duplex render host can consume the same metadata through a
different render-domain adapter without relabeling this delivery sink as a
monitoring graph. This capture-only slice does not authorize Phase 3 output,
monitoring, full-duplex ownership or plug-in hosting.

# ADR 0008: Legacy/native session handoff

Status: accepted design; cutover implementation is Phase 4<br>
Date: 2026-08-26

## Decision

One product `AudioSessionCoordinator` owns the process-global output/session.
Its serialized states are `LegacyActive`, `NativePreparing`, `NativeActive`,
`LegacyRestoring` and `Stopped`. Web Audio/RNAudioAPI and the native output
host are never active owners together.

Before handoff the legacy engine serializes transport position, playing state,
loop, tempo/transpose, lane gains/mutes, master/reference gains and a monotonically
increasing handoff generation. Native sources and a graph snapshot prepare
without opening output. At a chosen stopped or bounded fade boundary, legacy
stops/releases its output owner; only then may native configure/open/start the
session. Native confirms the same generation and first rendered frame before
the coordinator declares `NativeActive`.

Failure before native start restores legacy from the serialized state. Failure
after native owns output first stops/closes native, advances the generation and
then restores legacy. Stale acknowledgements cannot seize ownership. Capture
may remain through the existing coordinator only where the platform session
contract proves it compatible; no second component independently changes iOS
category/mode or Android focus/routing.

Mobile native buffers retire before legacy source buffers are recreated, and
the existing deterministic release order remains. Automated migration runs
muted and checks owner/state transitions; human listening is a separate gate.

## Consequences

Phase 0B compiles only the contracts into native product artifacts. The fake
host/prototype remains a host-test target and is absent from Android/iOS product
libraries. No native output host starts and current playback is unchanged.

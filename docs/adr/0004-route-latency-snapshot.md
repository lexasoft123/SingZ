# ADR 0004: Route latency provenance and addition

Status: accepted and represented in `zdsp/latency.h`<br>
Date: 2026-08-26

## Decision

`RouteLatencySnapshot` is immutable and versioned by interface version, immutable V1 prefix size and
route generation. It records provenance, measurement host time, confidence
flags, a platform's complete automatic presentation estimate, optional
component estimates and signed user trim.

When `AutomaticComplete` is set, `automaticPresentation` is the complete
graph-output→audible estimate. Component values are explanatory provenance and
must not be added. Without that flag, present render-device and external-route
components add once. User trim then adds once in either case. Capture-device
and input-conversion components form a separate capture→graph total; in-graph
latency stays in frames and is not stored in the route snapshot.

iOS automatic presentation is the platform-reported output latency plus the
actual I/O buffer contribution selected by the host. Android's measured
presentation queue is complete and carries `AutomaticComplete`; its buffer
fallback must not be added again. Bluetooth, AirPlay, CarPlay and automotive
routes carry high-variance/high-latency flags and are not monitoring routes.

A route generation change invalidates the snapshot. Negative automatic or
physical component latency is rejected; negative user trim is allowed.
Composition is overflow checked. Trim changes audible display/scoring only,
never PCM, raw capture time or device scheduling.

## Consequences

The UI can show capture, DSP, output and external route quantities separately.
No caller is permitted to recompute a platform-specific loose sum.

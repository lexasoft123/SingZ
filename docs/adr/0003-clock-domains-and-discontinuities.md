# ADR 0003: Clock domains and discontinuities

Status: accepted<br>
Date: 2026-08-26

## Decision

The output device clock is the graph master. A graph timestamp is
`(clockDomain, streamGeneration, graphFrame)`. Its host mapping is an affine
anchor: `hostNs = anchorHostNs + (frame-anchorFrame) * 1e9 / rate`. Mapping is
valid only for the named domain/generation and until the next discontinuity.

Same-device duplex capture may map directly only when the platform proves a
common clock. Different endpoints always have independent domains. Their input
enters a bounded FIFO and a prepared variable-ratio resampler; a measured
affine bridge maps capture frames to graph frames and corrects drift. The
current allocating fixed-ratio legacy resampler is not eligible.

Generation change, sequence gap, rate/route change, timestamp-quality change,
hard re-anchor, seek/loop or device loss emits one typed boundary before the
first affected block. The runner calls each affected processor's reset exactly
once before passing that marked block; processors do not reset themselves from
the context flag. A typed reason, `DiscontinuityFlagResetState`, and
`RenderTimeDiscontinuous` are one coherent boundary: omitting any member or
marking a reset with reason `None` is invalid and is rejected before reset or
process dispatch. Analyzer taps
drop incomplete windows and restart provenance. Raw capture timestamps retain
their original domain and never acquire output latency.

Transport validity bits are authoritative. Unflagged payload fields are
ignored. Flagged tempo is finite and positive; flagged musical positions are
finite; a flagged cycle has finite, strictly increasing endpoints; cycling
requires that range; and a flagged time signature has a positive numerator
and a positive power-of-two denominator. Signed sample positions deliberately
allow negative pre-roll.

Capture timestamp-quality validity is independent from the quality enum value
and is preserved with source, sample-host and callback-host validity at every
scalar boundary. `CaptureTimeStaleAnchor` is meaningful only when both the
sample-host anchor and its timestamp quality are valid; the runner rejects a
stale bit without those two validity bits before graph mutation. Unknown flag
bits are likewise rejected by the graph, while lossless mobile scalar bridges
transport any exact uint32 so a newer native producer cannot be silently
rewritten by an older bridge.

Audible projection is
`graphHostNs + inGraphLatencyFrames * 1e9/rate + graphToAudibleNs`. UI and
scoring use that projection. Gain/training automation remains on graph/render
time so presentation delay cannot move DSP decisions.

## Consequences

Clock identifiers and generations are mandatory, not diagnostic decoration.
Cross-domain data without a current bridge is rejected/reset rather than
stitched to unrelated audio.

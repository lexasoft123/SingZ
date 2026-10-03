# Pluggable graph pitch analysis

`zdsp::analysis::PitchAnalysisModule` owns detector construction, framing,
resampling, provenance and result delivery. Built-in backends are CREPE Tiny
and YIN; an injected analyzer can supply another detector with explicit framing.

The module exposes a borrowed `ProcessorHandle` with the stable
`kPitchAnalysisTapNodeType` and schema version 1. It can be placed after a mono
channel-map anywhere in a zdsp graph. Its callback copies PCM and capture
metadata into a preallocated eight-block SPSC queue, passes audio through
unchanged and performs no inference, allocation, locking or model access.

The owner drains the queue from an ordinary analysis worker. If more than two
blocks have accumulated, stale blocks are discarded; the source-frame and
sequence gap resets analysis continuity. Queue drops are observable. A tap
without capture provenance produces no analysis; it never invents capture time
from the output clock. Tail-drain callbacks produce no analysis either.

For microphone sessions, `push()` supplies a compiled three-node capture graph
(Input → Pitch tap → Output) and drains it after the graph render has returned,
on zcore's existing capture-delivery worker. There is no second audio host or
output device. Inference is explicitly rejected inside a graph render callback.

Use one producer route per module: either the borrowed processor in an owning
graph, or the convenience capture graph. One worker consumes results. Stop and
join both domains and retire the borrowed graph processor before destroying the
module. Cancellation suppresses result delivery across threads. Model and
worker resources belong to `zdsp_analysis`; the strict `zdsp_runtime` target and
zcore retain no ML dependency.

## Product integration

- iOS and Android bridges supply model location, detector choice and generation;
  all analysis assembly runs inside the shared module.
- Desktop CREPE training and pitch monitoring use the module through
  `singz-analyze live-input`. The Electron capture addon uses its YIN backend.
- The legacy desktop CLI YIN framing options retain their existing path for
  diagnostic compatibility.
- iOS and Android identify the new route as `crepe-tiny-zdsp-graph-v2`.
- The debug iOS packaged-model proof now runs known tones through the actual
  compiled capture graph, rather than directly calling CREPE.

## Verification

Native tests cover graph capture provenance, hardware timestamp quality,
custom backend framing, callback/inference separation, passthrough audio,
queue saturation and stale-block recovery, cancellation, and known-tone CREPE
inference through the production graph. The original probability parity and
bounded WAV checks are retained.

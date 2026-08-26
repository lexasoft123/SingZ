# ADR 0002: Graph snapshot publication and retirement

Status: accepted design; implementation is Phase 1<br>
Date: 2026-08-26

## Decision

The control domain compiles and prepares a complete immutable snapshot. It
reserves one fixed retirement slot before publishing a pointer plus generation.
The render callback adopts only at a block boundary. There is one pending slot;
newer unpublished edits replace older ones and the control thread destroys the
superseded plan.

On adoption, render records the previous pointer, retirement epoch and active
worker mask in the reserved slot. Every render worker acknowledges an epoch
after it can no longer reference that snapshot. A control-side reclaimer may
deactivate nodes and release memory only after all acknowledgements. If no
retirement slot is available, publication remains pending/coalesced; render
never blocks, allocates, destroys or leaks to make room.

Topology/latency changes carry a prepared transition plan. Parameter-only
changes use sample events. Compatible graph changes crossfade latency-aligned
old/new outputs. Stateful transfer and finite tail spill require explicit
prepared adapters. Emergency device loss may hard cut with a discontinuity.

Phase 1 starts serial. If fixed RT workers are later introduced, a late worker
quarantines its entire snapshot and the next block selects an independently
prepared fallback. The callback never renders the same mutable state serially
while a late worker may still access it.

## Consequences

Owning pointers and reference-count destruction never appear in render data.
Tests must saturate pending/retirement capacity and prove latest-wins behavior,
bounded memory and off-RT finalization before app playback can migrate.

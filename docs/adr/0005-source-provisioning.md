# ADR 0005: Source provisioning

Status: accepted design; production implementation is Phase 4<br>
Date: 2026-08-26

Implementation note (2026-08-29): the first Phase 4 foundation slice consumes
an independently opened, already-authorized descriptor by move-only ownership;
it never accepts or retains a path. `zcore_media` decodes bounded WAV/FLAC into
immutable planar float storage, optionally resamples all channels together off
RT with one latency trim and deterministic duration, and publishes only a
complete shared owner. Cancellation, malformed input and limit failures publish
nothing and close the consumed descriptor. Publication bytes, planned peak
float payloads, reduced rate ratio, total resampling work and per-cancellation-
poll MAC work have separate explicit bounds. The per-poll plan includes the
first converter call's primed filter history and rejects an unbounded ratio
before constructing the converter. Plain RIFF files
with the `0xffffffff` streaming/RF64 sentinel are rejected until ds64 is parsed
rather than treating trailing bytes as PCM. Full-size planar allocations may
spend time inside the allocator, but sample initialization, conversion and
resampler tail draining are bounded between cancellation polls. `zdsp_runtime`
borrows the immutable channel pointers through a zero-input decoded-buffer
source and advances a fixed cursor without allocation or synchronization. It
starts at frame zero
but generic graph resets preserve the cursor: a future positioned transport
contract owns seek/loop. Each lane silences after its independent end. The
future playback session must retain the storage owner until graph deactivation
and destruction complete.

This slice deliberately supports WAV and FLAC only. Custom platform codecs,
streaming/read-ahead, seek/loop preparation, load-generation arbitration and
the product playback lease remain later Phase 4 work.

## Decision

The product source coordinator owns allowlisting, file handles, cancellation
and load generations. It resolves project-relative paths through the existing
media allowlist, then hands a native source an already-authorized handle or
bounded reader. Graph processors never receive paths, Drive tokens or network
objects. I/O, download, decode, seek-index construction and buffer allocation
run off RT.

The matrix is FLAC project-v2 on every platform, WAV project-v1 migration,
and the current custom formats supported by each platform decoder. Unsupported
custom formats fail before snapshot publication. Drive inputs first become
verified Drive-local files through the existing md5/size currency rule. An
older load result is discarded unless its load generation still matches.

Short cue/training assets and initially proven song lanes fully decode into
prepared planar float storage. Long-source streaming is a later explicit
reader with fixed slabs, read-ahead, counted starvation and silent/emergency
fallback; it cannot call a codec on the audio callback. Lanes retain their own
length. Ended lanes produce silence while longer lanes continue.

Seek and loop commands prepare source positions off RT and publish a typed
discontinuity. All song lanes adopt the same graph-frame boundary so stems stay
phase locked. Source replacement is a snapshot transition. Closing a project
retires the graph, then releases decoded native buffers deterministically in
that order.

## Consequences

`zcore_media` is control/source infrastructure and never a transitive runtime
dependency. `zdsp_runtime` sees borrowed sample pointers, not codec or file
types. Folder and Drive truth remain one verified local-file contract.

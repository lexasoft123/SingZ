# ADR 0005: Source provisioning

Status: accepted design; production implementation is Phase 4<br>
Date: 2026-08-26

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
dependency. Folder and Drive truth remain one verified local-file contract.

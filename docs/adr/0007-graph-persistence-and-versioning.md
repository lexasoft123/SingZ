# ADR 0007: Graph persistence and versioning

Status: accepted design; project writer is not implemented in Phase 0B<br>
Date: 2026-08-26

## Decision

The eventual project artifact is optional `graph.json` beside `project.json`.
`project.json` names its format, md5, size and mtime using the same currency
principle as lyrics/stems, so Drive catalog, desktop sync and phone cache have
one source of truth. No project writes a graph until every platform reader and
sync path accepts it.

The document has a monotonically versioned envelope, stable 64-bit node IDs,
128-bit type IDs, per-type schema versions, ports/connections, normalized
parameter values, execution-mode choice and opaque adapter state. Migrations
are pure control-domain transforms and never mutate the source document on a
failed compile. Serialization order is canonical for byte-stable hashing.

An unavailable/unknown node becomes a placeholder retaining its complete type,
ports, parameters and opaque state byte-for-byte. It remains connected for
editing and round-trips unchanged, but compilation applies an explicit
bypass/silence policy and reports degradation. Unknown fields are retained.
Binary plug-in state is base64 in the first format with a strict size cap;
larger sidecars require a future format and currency entry.

Phase 0B's deterministic little-endian `ZDGF` envelope is only a contract fixture
for known/unknown node preservation. It is not the product file format and is
kept out of `zdsp_runtime`. Decode copies payloads into caller-owned storage;
encoded input, node records and state storage must not overlap. Encode likewise
rejects output overlapping node descriptors or any opaque state source, so an
early write cannot corrupt a later record that has not yet been read. Scalar
and document out-parameter objects are part of the same alias check and are
published only on success; every failure leaves them unchanged.

## Consequences

Graph sync cannot be bolted on after saving begins. Desktop→Drive→phone fixture
tests are a prerequisite to the first product graph write.

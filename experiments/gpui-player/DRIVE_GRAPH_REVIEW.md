# Native Drive portable-graph strings — 2026-11-08

Format-1 graph validation now accepts escaped unpaired UTF-16 surrogates in stable
names, matching the string contract in `src/shared/graph-document.ts`. This covers
execution labels, port IDs, parameter keys, bindings, connection endpoints and
opaque object keys. Lone surrogates retain distinct identities; they cannot alias
U+FFFD, literal backslash escapes, private-use characters or a superficially
similar sequence of Unicode characters. A paired escape and the corresponding
literal Unicode scalar have the same identity. The 128 UTF-16-unit name limit and
ASCII control/DEL refusal remain intact.

The private validation projection reads serde_json byte strings as WTF-8 and maps
each decoded byte injectively to a Rust character. ASCII schema keys and fixed
tokens stay unchanged. Length checks count UTF-16 units from the projected byte
sequence. These strings never enter the user interface, DSP or serialized output.
Literal document bytes must remain valid UTF-8; this permission applies to legal
JSON escapes, not malformed UTF-8 or invalid string escapes. The encoded 12 MiB
cap, node/state limits, hash verification, unknown-field skipping and future-format
preservation remain enforced. The original graph file remains the hash-bound
publication payload; validation never normalizes or rewrites it.

Verification includes all 65,536 individual UTF-16 code units (unique identity,
unit length and stable-name controls), mixed surrogate sequences, scalar/escape
equivalence, name-limit boundaries, duplicate ports, missing endpoints, malformed
escapes and literal UTF-8 refusal. Existing shared production graph cases still
pass. A new raw shared fixture is captured into the actual immutable upload spool
with exact source/metadata/hash preservation. A connected native service test uses
real loopback OAuth and HTTP: the valid fixture is uploaded byte-for-byte, then a
hash-valid graph with a distinct missing endpoint remains dirty/blocked locally
while the prior remote graph and project metadata remain unchanged.

Final results: 114 focused Drive tests and the full 762-test native suite pass,
zero failures, two ignored. Both normal and UI-feature app builds pass. An initial
compile error in the new test's `unwrap_err` requirement was fixed by inspecting
its error without requiring `Capture: Debug`; its raw log is retained. Earlier
engine-probe startup timeouts are still considered intermittent and unresolved;
this passing full run does not establish a fix.

This checkpoint changes backend validation and tests only. There are no new UI
captures or production visual comparisons. The preceding recovery checkpoint's
22 hidden writer captures belong to its previous binary and are not attributed
to this one. Shared UIKit sources, all 86 font hashes and approved lyric paint
sources remain unchanged. No Node/Electron, staging, commit, preview replacement
or foreground activation was used.

This is portable transport validation, not a claim that graph-bearing projects
are fully opened/executed in the native app. Native graph integration, native-empty
cloud reader compatibility, retained-root ledger policy, live service/hardware,
platforms, packaging and full visual/temporal/accessibility qualification remain
open under the full desktop goal.

[Evidence and source recovery](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-drive-graph-20261108/REVIEW.md).

Subsequent saved-graph playback integration and its separate native limits are
documented in the [native graph checkpoint](NATIVE_GRAPH_REVIEW.md).

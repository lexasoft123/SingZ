# Native Drive local-state recovery — 2026-11-08

A hard local-state error no longer exits the Drive command worker. Malformed JSON
and unsafe ledger file kinds remain errors; the app does not delete, reset or
rewrite them into a clean ledger. The scheduler revokes the failed run, reports
unknown dirty intent and retains the last successful sync time. Commands remain
available while the worker waits for an explicit retry.

Sync now, or a successful sign-in, permits one fresh validation attempt. An
unrepaired ledger blocks again without starting HTTP work or acknowledging intent.
After external repair, the same worker verifies saved-project fingerprints again,
reads current intent and captures a new run identity. It preserves newer edits
made during that upload and marks outside the selected library. Suspend, root
handoff, Cancel and Sign out remain responsive while local state is unusable.
Bootstrap credential-store construction failures are still outside this recovery
loop; this does not claim automatic repair of credentials or malformed files.

The connected Rust tests use actual local OAuth and gated HTTP uploads. They cover
corruption during upload, unsuccessful explicit retry, stable blocked state,
storage fencing, repair without worker restart, another edit during recovery
upload, a separate final sync, startup corruption, receipt re-verification,
outside-library intent and unsafe directory-as-ledger recovery through sign-out
and sign-in. Scheduler tests separately refuse stale completion and run-ID reuse.

Verification: 108 focused Drive tests and 10 scheduler tests pass. The latest full
suite reports 755 passed, one failed, two ignored. The failure is the existing
engine candidate's shell startup timeout, with zero stdout/stderr bytes; it is not
claimed fixed or ignored. An earlier run reported 754 passed and two failures:
the other failure was a test-only immediate accept on a nonblocking OAuth socket.
That test now waits within a bounded accept deadline while retaining nonblocking
inheritance, the original callback cancellation timing and the no-spin assertion.
All raw failures are retained with the checkpoint evidence.

Normal/UI builds and the hidden writer regression pass (22 PNGs across two app
processes, with unchanged foreground identity). All 86 shared/dist font hashes
and UIKit source hashes match the preceding adoption checkpoint. Receipts are
recorded in the checkpoint manifest. The existing driver exercises real Save during upload,
follow-up sync, Cancel, picker controls, account restoration and Sign out at both
sizes. Its screenshots are regression candidates, not matched production parity
or captures of the new malformed-ledger cases. The new fault/recovery scenarios
are verified at the native service/HTTP boundary. Live FPS, live Google,
physical hardware, platforms, packaging and full visual parity remain open.

Evidence and source recovery:
[gpui-drive-recovery-20261108](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-drive-recovery-20261108/REVIEW.md).

# Native Drive streaming progress — 2026-11-08

The HTTP reader now counts accepted response payload bytes as they are written.
The calling Drive worker receives bounded progress updates at most five times a
second, plus the final count. Pipe-reader threads never call UI or application
observers. Error and expired-token response bodies do not count as project media.
Cancellation is checked again after observer delivery and before returning;
failed/cancelled transfers still remove their own partial file.

Authenticated downloads carry the observer through the account-generation fence
to phone-project adoption. Adoption uses the source `main.sync.downloadBytes` and
`main.sync.downloadingFile` strings for byte totals and average transfer speed,
and advances the existing per-file fraction. The observer does not authorize
publication: fsync, digest/listing checks, durable staging/publication and remote
adopted tagging retain their original ordering. Retry starts a new transfer count.

Four new regressions exercise real curl/HTTP rather than simulated EOF events:

- A server sends half a file and cannot send the remainder until its observer
  receives partial bytes. Counts are increasing, run on the calling thread and
  finish at the exact decoded payload size.
- Cancelling from that partial callback refuses completion and removes the file.
- A 401 response produces no download progress.
- A restored authenticated adoption is held halfway through source audio. Its
  actual progress message must report 64 KB before the server can finish; the
  destination song must not exist then. Final file bytes and adopted tagging are
  independently checked after the integrity-gated publication.

All 105 focused Drive tests pass. The first complete suite reports 750 passed,
two engine-probe failures and two ignored; a read-only child-process observation
run reports 751 passed, one probe failure and two ignored. A later observed run
passes all 752 tests with two ignored. These are retained together: the passing
run does not fix or invalidate the earlier timeouts. Probe deadlines/assertions
and production process behavior were not changed. One sampled shell in the
passing run remained in macOS dyld startup, including synchronous debugger-image
notifications; this is evidence of startup delay, not proof of the timeout cause.

Normal and UI-feature builds pass. The existing hidden Drive writer/playback
workflow passes 22 captures over two processes and both sizes, including Save
during held upload, automatic follow-up, cancellation, blocked projects and
account/receipt restoration followed by sign-out. Foreground identity is unchanged
in both processes. This is a regression check of the existing writer; it does not
capture the new streaming adoption state. Shared UIKit controls, fonts and
approved lyric paint are unchanged. Actual streaming-progress screenshots,
source-matched temporal/visual review, a combined adopted-song native playback
workflow, live Google and platform/packaging qualification remain open. Existing
writer/playback UI checks do not cover those missing adoption states.

The preserved pre-progress native binary also passes the same 22-image workflow.
Raw full-image comparison gives 0/22 exact. Visible private fixture paths differ
between the isolated runs; playback clocks/paint and log timestamps were not
frozen. For example, the compact playing/Save pair differs by 163 waveform-edge
pixels, while library/picker frames include the different root-path text. The
original images, overlays and differences remain unchanged. These pairs do not
qualify matched-fixture temporal or visual parity. Eight comparator self-checks
pass. Evidence and source overlays live in `gpui-drive-progress-20261108` under
this chat's visualization directory.

The native-empty publication guard remains necessary. Current mobile listing
requires source audio if it finds no expected stem/custom files, and its open path
creates a whole-song lane when no stems/custom lanes exist but `songFile` does.
It does not recognize native empty-track intent. Merely uploading an empty native
document could hide the song or resurrect removed source audio on another client.
The native-only port has not changed that reader contract or enabled publication.
See `mobile/src/gdrive.ts::buildEntry`, `mobile/src/projects.ts::loadProject` and
`src/drive_snapshot.rs::capture`; full compatibility remains open.

The full desktop objective remains active. Live display FPS is unmeasured.

Follow-up: the [combined adoption review](DRIVE_ADOPTION_REVIEW.md) now records
actual gated streaming screenshots, real cancel/resume with verified metadata
reuse, catalog-card opening, native playback/mixer/Save and a server-stopped offline
restart. Its final 56-capture regression batch and 753-test suite pass. It also
fixes Darwin accepted-socket mode in the adoption fixture and OAuth callback.
This supersedes the local adoption-UI gap above, without qualifying live Google,
physical devices, platforms, packaging or production visual/temporal parity.

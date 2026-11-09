# Full desktop acceptance gaps

This is a current-source functional audit, not a completion percentage. The full
desktop goal remains active. Passing a renderer fixture or a unit suite does not
qualify every route, physical device, platform or production image.

## Concrete integration work

| Gap | Current evidence | Required implementation and acceptance |
| --- | --- | --- |
| Saved empty project → Drive sync | `drive_snapshot.rs` rejects `settings.nativeEmptyTracks=true`; its test pins the refusal. This protects existing readers and the remote's last audio. | Establish reader-compatible empty-project publication/adoption semantics, then verify remove-last-track → Save → sync → fresh reader/restart without resurrected audio or destructive remote replacement. Preserve the refusal until that compatibility is established. |
| Windows audio-provider qualification | Native Settings, preferences and helper now carry explicit provider intent and availability, refuse unavailable providers without fallback, and fence changes against active or retiring audio owners. Independent microphone/monitor inventory stays on WASAPI. | Run the new hidden provider/restart journey on the Dell and qualify actual WASAPI playback. ASIO remains unavailable until a licensed adapter and driver are implemented and qualified. See `WINDOWS_PROVIDER_REVIEW.md`; source and macOS checks do not close this platform gate. |

Training's previously missing result reveal, acknowledgement and task-specific
Summary copy now have a scoped EN/RU two-size native checkpoint; see
`TRAINING_FEEDBACK_REVIEW.md`. Native scoring, receipt identity, cue timing and
capture ownership remain intact. This does not establish complete visual parity.

Settings playback graph integration now has a native ordinary/custom graph
checkpoint, with generation replacement, keyboard module/connection reading and
Save/reopen. Shared UIKit displays actual compiled topology; malformed/stale
metadata is validated independently. See `PLAYBACK_GRAPH_REVIEW.md` for exact
binary and runtime evidence. Full production visual and invalid-metadata renderer
qualification remain open.

Native desktop Drive browse/download/offline-open now has a separate reader and
verified cache, including stem-only and saved-graph native playback. Its final
hidden online/offline journey passes 29 captures with actual search/cancel/retry
and exact payload checks. See `DRIVE_RESTORE_REVIEW.md`. This supplies the reader
dependency for empty-project sync; the strict empty reader fixture does not
qualify publication by the native writer. The compatibility row above remains
open.

## Qualification gates

- The runtime-graph checkpoint passed 887 Rust tests. Successive Drive reader
  suites passed at 901, 903 and 906 tests. A later suite recorded 908 passed,
  one engine-probe failure and two explicit installed-model ignores. The current
  Library focus-repair source passes 909 tests with zero failures and those same
  two ignores. The historical intermittent two-second engine-probe shell fixture
  remains unresolved; neither an isolated pass nor this full pass closes it. The source
  probe budget is 45 seconds; Qwen health readiness uses a separate 180-second
  budget. No deadline or assertion was relaxed.
- Production visual and temporal parity still needs the complete matching
  fixture/state matrix. Exact native regression images establish regression
  scope only. Preserve the approved native partial-glyph/glow standard.
- All-locale layout, accessibility and actual live announcements remain open.
  A presentation diagnostic named `announce` is not platform accessibility proof.
- Physical microphones, permissions, device hotplug, audible monitoring/output,
  OS chooser presentation, remaining Windows/Linux scenarios and packaged live
  Drive consent are not established by generated replay or loopback services.
- Hidden macOS captures do not establish live display cadence. CPU/footprint and
  system GPU observations must stay separate from unavailable live FPS.
- Ad-hoc package verification is not signing/notarization or release readiness.

The worktree's `SCREEN_PORT_STATUS.md` and focused review documents retain the
implemented routes, exact fixtures and historical evidence. Resolve these
concrete gaps before treating broad historical “remaining work” notes as closed.

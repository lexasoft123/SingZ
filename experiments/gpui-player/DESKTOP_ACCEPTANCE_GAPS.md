# Full desktop acceptance gaps

This is a current-source functional audit, not a completion percentage. The full
desktop goal remains active. Passing a renderer fixture or a unit suite does not
qualify every route, physical device, platform or production image.

## Concrete integration work

| Gap | Current evidence | Required implementation and acceptance |
| --- | --- | --- |
| Actual playback graph in Settings | `settings.rs` always composes the monitor chain. The GPUI bridge reports graph counts/generation but omits the shared engine's `NativePlaybackStatus.graphSnapshot`. Source `DspGraphVisualization.tsx` uses a validated runtime snapshot. | Publish the existing native snapshot through the pure C++/Rust bridge, validate it, and render its actual modules, edges and latency facts with shared UIKit. Exercise ordinary playback, saved custom graphs, replacement and malformed/stale snapshots. Counts or a reconstructed schematic cannot substitute for runtime topology. |
| Saved empty project → Drive sync | `drive_snapshot.rs` rejects `settings.nativeEmptyTracks=true`; its test pins the refusal. This protects existing readers and the remote's last audio. | Establish reader-compatible empty-project publication/adoption semantics, then verify remove-last-track → Save → sync → fresh reader/restart without resurrected audio or destructive remote replacement. Preserve the refusal until that compatibility is established. |
| Windows audio-provider selection | Source Settings exposes WASAPI/ASIO availability and selection. Native Settings/prefs/events have no provider field; the GPUI helper uses the platform default backend. | Propagate explicit provider intent, availability and failure through the native device/host boundary and UI. Qualify WASAPI on the Dell; qualify ASIO only with an actual SDK-enabled build and available driver. A default build legitimately lacking ASIO must say so. |

Training's previously missing result reveal, acknowledgement and task-specific
Summary copy now have a scoped EN/RU two-size native checkpoint; see
`TRAINING_FEEDBACK_REVIEW.md`. Native scoring, receipt identity, cue timing and
capture ownership remain intact. This does not establish complete visual parity.

## Qualification gates

- Current source has a passing normal Rust baseline of 873 tests and, with the
  Training presentation additions, 880 tests; two explicit installed-model
  tests remain ignored. The historical intermittent two-second shell-fixture
  timeout remains unresolved. Current passing runs do not close it. The source
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

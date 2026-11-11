# Carry the line — native integration review

The footer Carry control opens shared native UIKit Off/On, time/lyric-line,
period, hear/sing and guide-lane controls. It follows the production TrainPopover
copy, bounds, grouping and captions. Native ducking uses the existing scheduled
training gain in the audio engine, with original-song-time windows and the source
150 ms lead. No Node is involved; fonts and common controls remain in UIKit.

A false-to-true user action unmutes the selected existing guide lanes, retaining
gain and solo. Restoring a saved enabled configuration preserves independent
manual mutes. Configuration edits while enabled also preserve those mutes.
Missing synced lyrics use the time fallback; a valid empty set of lyric windows
stays empty rather than silently activating the time schedule. Lyrics sing-turn
backgrounds and left bars are underlays; approved partial-glyph fill, bright
leading/final glyph, core/glow and halo remain intact.

The helper accepts bounded complete drafts and builds a candidate graph before
committing. Accepted Carry revisions fence delayed playback status. Rust adopts
only proved native receipts, serializes edits and reschedules when the accepted
lyric document, lane revision or duration changes. Refusal keeps the accepted
configuration; transport or committed failures retain the document paused and
require reopen. Fatal native output states are never treated as ordinary refusal.
The lyric mask retains the accepted document and is cached outside frame painting.

Save waits for the actual accepted receipt. Queued Save/Open uses the existing
publication lifecycle, including private working-copy publication and its internal
reopen. The final destination opens after Save finishes. Refusal cancels the
queued Save with feedback. Accepted settings persist in project training metadata;
unknown fields survive. Global configuration is a separate bounded, atomically
written preference with no enabled flag. A fresh project stays disabled.

Verification on macOS:

- 557 Rust tests pass, zero failed and two ignored, including thirty new Carry
  domain/preferences, persistence, receipt/fatal-output and empty-open regressions.
- Native helper DSP v4 passes actual period/window ducking, independent manual
  gain/mute/solo, seek/loop, invalid transactions, restore/arming semantics,
  rate/route changes, Park/unpark, custom lane replacement, empty release and re-add.
  Clear Loop now reopens the parked graph paused before submitting its callback
  command. Empty release clears the metronome reference-gain override together
  with its cue plan, so fresh audio can be prepared after metronome use.
- Hidden Carry UI v11 passes four processes and twenty captures. Both 1280×800
  and 1060×640 logical sizes use 2× scale. Actual controls cover both modes, all
  clamps, captions, last-guide protection, stable custom IDs, sing masks/windows,
  native playback/tempo/loop, Escape/outside dismissal and keyboard traversal.
- Save with the popover open and queued Save/Open behind an actually applied,
  held native receipt pass. A separate prepared working copy publishes through
  the real source worker before navigation; its two built-in WAVs compact to
  FLAC with independently verified exact decoded PCM, while custom audio,
  lyrics and unrelated bytes remain unchanged. A separate restart verifies
  saved enabled state/manual mutes and global disabled fallback.
- Sixteen long guide labels remain reachable by keyboard at both sizes, with
  actual measured visibility and selection of the final lane. Ordinary six-lane
  layouts have exactly zero scroll overflow. Bounded scrolling, ellipsis/full-name
  tooltips and two-line mixer-label clipping are native overflow safeguards;
  production currently lacks equivalent maximum-label safeguards. They are not
  evidence of production-identical overflow states.
- Review caught and fixed duplicate hover styles, per-refresh focus reset,
  spurious padding-only scroll overflow, overlapping mixer labels, working-copy
  Save cancellation by navigation, fatal output misclassification and empty Open
  restoring Carry against a released graph. The latter now reads real native
  status and keeps preferences disabled. The existing three-launch empty-project
  UI regression passes again, including Copy/Move, CAS refusal and standalone
  training; actual helper release/re-add checks also pass.

Final UI-feature and normal builds pass. The existing source-export UI regression
passes again, including thirty-eight independently decoded MP3/WAV/FLAC outputs.
Strict final comparisons are exact for all 84 full native frames: 18 screens,
17 training and 49 lyrics. Eight comparator self-checks pass. All 86 shared font
assets are byte-identical to the prior export checkpoint. Source/helper/UI/normal
binary hashes, complete dirty source snapshots, logs, receipts, PNGs and strict
overlays/differences are preserved in the
[checkpoint archive](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-carry-line-20261108/REVIEW.md).

Final Carry captures supply 21 app-process CPU samples: median 42.71%, peak
96.26% of one core during rapid offscreen capture. Helpers are excluded; GPU
telemetry is system-wide. Foreground identity stays unchanged in all four
processes. These samples do not measure idle cost or live display cadence.
No production-matched Carry reference exists; these are native candidates, not a
pixel-perfect production parity certificate.

The native helper checks use fake audio devices with real decoding, engine DSP and
nonzero PCM measurements. UI checks use actual hidden windows, app-local input,
production workers and native receipts; a test-only gate holds an already-applied
native receipt to exercise Save/navigation ordering without fabricating results.
Neither is hardware output qualification. Hidden macOS captures do not establish
live FPS or display cadence; CPU samples cover the app process, helper separately,
and GPU telemetry is system-wide.

Outstanding full-port scope includes account/Drive sync,
remaining desktop controls and full production visual, temporal, locale,
accessibility, hardware and Windows/Linux qualification. No commit or preview app
replacement belongs to this checkpoint.

Scope audit: current production exposes only training sample recording, already
ported. It has no general song-recorder screen, transport controls or API. A
general recorder was previously listed as remaining work, but its product scope
is unproven; microphone-only takes, synchronized overdubs and rendered mixes have
different requirements. This checkpoint does not invent or certify any of them.

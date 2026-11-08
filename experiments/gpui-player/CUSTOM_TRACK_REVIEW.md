# Native custom tracks — verified core and empty-document lifecycle

The full desktop port remains active. Native custom-track code now implements stable
IDs, source labels/colors, arbitrary saved custom loading, 16 active audio lanes,
native live replacement, label-only rename, original encoded-file Save and transactional
removal/pruning, with working Save/re-split preservation. Shared title controls and the
inline name editor live in the sibling UIKit crate. No Node is used.

Current verification: 475 Rust tests pass (zero failed, two ignored) in
`/tmp/singz-custom-tracks-unit-v8.log`. The real native-helper suite passes in
`/tmp/singz-custom-tracks-native-v3-driver.log`: native decoding/DSP with an explicit
fake audio host, all 96 waveform RMS buckets checked independently, stable-ID mix,
transport, longer/shorter duration, replacement/reused-path cache identity, rejected
inputs and sixteen-lane capacity. Physical audio output is not qualified by that suite.

Final hidden UI v9 passes at 1280×800 and 1060×640 logical pixels, at 2× scale.
Its six settled captures accompany actual Add, inline Rename Enter/Escape, keyboard Save,
reopen, Remove and Save/reopen controls. A damaged audio file between two valid picks
is skipped with feedback; both valid files survive. Actual project rename before Save
preserves both unsaved Add and unsaved Remove. Python verifies encoded WAV/FLAC hashes,
source/sentinel preservation and scoped pruning. Native playback, duration, shortened
loop, stored vocal pitch and pitch-strip timeline adoption are checked. Final removal
restores keyboard focus only when its vanished control held focus.

Existing native title, library-import and deletion interaction regressions pass. All
84 previous full native frames remain strictly identical (18 screens, 17 training,
49 lyrics); eight comparator tests and the normal build pass. These are native regression
fixtures. Matched production visual/temporal references remain absent, and stepped
captures do not establish live display cadence. The archive is
[gpui-custom-tracks-20261107/REVIEW.md](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-custom-tracks-20261107/REVIEW.md).

The Add worker receives typed picked paths rather than preallocated UI lane slots. It
validates each new file through the native decoder, reports damaged files and retains
valid selections around them, then allocates IDs/slots/colors only for successful files.
Native refusal before an irreversible graph arm preserves accepted playback. A lost
pre-apply connection retains old project state but stops playback; committed or uncertain
post-apply failure retains the requested tracks as dirty with an explicit recovery
message. The interface does not present those failures as a successful rollback.

Save preserves encoded bytes and reanchors accepted paths/stamps by stable ID. Its
recoverable publication covers audio and metadata together; only unused ordinary
`custom-*` members are pruned. Unknown files, links and external selected sources stay
outside that removal. Re-splitting preserves user custom lanes and avoids generated
backing-name collisions.

Vocal-analysis coverage is checked against the actual vocal lane duration while the
pitch drawing uses the whole native timeline. Version and source-stamp checks remain.
Typed worker reopen overlays preserve the desired custom ID set, paths and mix across
owned project handoffs, preferring newly materialized paths. Re-split preserves fresh
generated backing extras. Custom/backing lanes are excluded from beat detector inputs; captured built-in role
paths and stamps remain strictly verified even with custom lanes present. Pending lyrics
writes and source operations are coordinated with track editing. Native lane controls
wait while dense lane ordinals change.

The final custom-only lane can now be removed through a genuine empty-document lifecycle;
see [the empty-project review](EMPTY_PROJECT_REVIEW.md) for its separate evidence.
Source-track export is connected; see [its review](STEM_EXPORT_REVIEW.md).
Known required work includes complete failure/navigation/UI cases, account/sync, matching
production visual/temporal references, locale/accessibility and Windows/Linux qualification.
The existing user preview has not been restarted and no commit was made.

Native entrance uses each lane ID’s appearance clock and visual order, keeping existing
rows settled when tracks are added and continuing frame requests through all sixteen
rows’ entrance periods. The new settled screenshots were inspected at both sizes; a
production-matched temporal sequence remains unqualified.

The final active scripted workflow collected 26 main-process CPU samples, median 9.17%
and peak 46.98% of one core. Native helper CPU is separate; GPU counters are system-wide.
Hidden live FPS is unmeasured.

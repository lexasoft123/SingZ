# Native empty-project lifecycle — verified checkpoint

Removing the final custom track now leaves a real, loaded empty document. Save,
restart, library discovery, Copy/Move and fresh Add preserve that intent. The native
helper releases decoded lanes and graph ownership; no silent placeholder audio or
training-only label represents the document. No Node is used. Shared disabled
control styling lives in sibling UIKit; fonts and approved lyric paint are unchanged.

The helper exposes monotonic lane-set revisions independently of graph generation.
Empty status requires graph zero, zero duration/position, no song playback and an
exact native cleanup proof. Root fences late statuses by epoch, accepted revision
and document intent. Failed or uncertain native changes remain stopped and dirty
with recovery feedback; they do not fabricate a successful release. Logical mix and
route preferences survive, and a valid Add starts paused. A disconnected selected
output is retained and refuses Add instead of falling back to the system default.
Standalone training temporarily owns output independently, then proves release again.

Save publishes explicit boolean empty/original-disabled flags and an empty custom
array, omitting timeline ranges. Readers reject malformed flags and inconsistent
markers. Unknown metadata and unrelated files survive; unused ordinary custom files
are transactionally pruned. Typed overlays retain unsaved Add/Remove during import.
Short audio clips also zoom safely with finite bounds.

Verification on macOS:

- 507 Rust tests pass, zero failed, two ignored; UI-feature and normal builds pass.
- Real helper empty tests cover Release, retained PCM/file descriptors, repeated
  lease re-add, failed candidate, standalone cue and disconnected output selection.
  Real custom-track helper/DSP and training-only regressions pass.
- Final hidden UI v5 passes three independent app launches at 1280×800 and 1060×640
  logical pixels, 2× scale. Sixteen captures cover final Remove, Save CAS refusal,
  successful Save, training, restart, Copy/Move, invalid Add, half-second zoom,
  fresh paused re-add and delayed actual old helper telemetry. Independent Python
  checks confirm encoded FLAC hashes, foreign files/metadata and scoped pruning.
- Existing custom Add/Rename/Save/reopen/Remove UI passes with the final helper.
- All 84 immutable prior native frames remain exact: 18 screen, 17 training and
  49 lyric frames. Eight strict comparator self-tests pass; diff checks are clean.
  This proves native regression coverage, not production visual parity.
- Final v5 recorded 60 main-process CPU samples: median 14.46%, peak 100.12% of one
  core during scripted captures. Helper CPU is excluded; GPU counters are global.
  Live display FPS remains unmeasured in hidden windows. Foreground identity stayed
  unchanged. Earlier v4 performance is not used because comparison work overlapped.

Evidence, exact source/font identities, logs and strict diffs are archived in
[gpui-empty-project-20261107](/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-empty-project-20261107/REVIEW.md).
The existing user preview was left untouched; no commit was made.

Remaining desktop work includes export, account/Drive sync, general song recording,
remaining controls and failure states, matched production visual/temporal references,
locale/accessibility, actual chooser/hardware behavior and Windows/Linux qualification.
The full desktop goal remains active.

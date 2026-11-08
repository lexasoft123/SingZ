# Lyrics editor locale checkpoint — 2026-11-08

The native editor now resolves its toolbar, replacement/help sheets, consent,
Save controls and hints from the existing `lyrics.editor.*` dictionaries. Silent
and untimed line counts use locale plural rules. Alignment feedback is formatted
from semantic verdict fields using `lyrics.check.*`; the explicit-locale formatter
keeps domain callers and parallel tests independent of the mounted UI locale.
The existing English formatter remains an English wrapper.

Input placeholders follow the source editor: the replacement textarea always has
its paste hint, while a lyric row has its hint only when it is the sole row.
Refreshing translated hints preserves draft text, input identity and undo history.
The generated English JSON remains a checked source fixture, rather than the
runtime translation authority. Original lyric text, model IDs, timing data and
raw diagnostic errors are not translated.

The compact Russian help review exposed a keyboard defect. Wheel scrolling worked,
but Tab could focus the confirmation button below the 640px viewport (button
y=620.09375, height=26). The help sheet now owns a separate scroll handle and
reveals its footer on autofocus and keyboard wrap, matching the source's autofocus
behavior. Shared UIKit geometry, fonts and text sizes are unchanged. The hidden
editor driver covers Escape, wheel-to-top/bottom, actual confirmation clicks and
Tab/Enter after scrolling back to the heading at both sizes.

Capture metadata now records the accepted locale for editor and alignment states.
Python fixtures record the requested locale instead of always claiming English.
Earlier batches retain their original metadata; they are not rewritten as final
evidence. The failed keyboard check is retained with its screenshot and diagnostic.

The final hidden, muted workflows pass 80 captures: 22 editor and 18 alignment
states per language. Both actual 1280×800 and 1060×640 viewports are verified.
The editor checks retain independent Save, raw lyric bytes, conflicts, mid-Save
edits, absent-file races, working-copy publication, row/word editing and long-list
focus. Alignment retains consent, real loopback install/download failures and
cancellation, cached/uncached runtime protocols, preview-only publication,
mismatch retention and stale-revision refusal. Foreground identity is unchanged
in all four final drivers.

Review found two more evidence defects. Alignment cache receipts inherited the
audio file's creation-time mtime, so reference/candidate fixtures were different;
the private test audio now receives a fixed timestamp before cache construction.
The two-size alignment macro also captured before asynchronous resize acceptance:
for example, the historical speech-consent-1060 image was actually 1280×800.
The driver now waits for the measured viewport, and each sized capture asserts it.
Earlier images and sidecars remain immutable and explicitly unqualified for their
mislabeled size cases.

Strict comparison against the preserved older **Log-checkpoint native build**,
not production or the immediately preceding Model checkpoint, gives 8/28 eligible
English image pairs exact and 20 different. Six historical alignment references
have the wrong viewport for their case name; six new help interactions have no
historical reference. Those twelve English cases remain unpaired. Differences
include the corrected help autofocus/scroll position, asynchronous blurred
underlying-player content, and a toolbar hover difference on three compact
alignment images (physical bounds 234,237–508,289; 1,558 changed pixels each).
Historical alignment pointer-state metadata is incomplete, so image equality
alone does not establish the complete state contract. All raw images, overlays,
differences, sidecars and refusals are retained without masks or transforms.

The production-code Rust suite passes 748 tests, zero failures and two ignored.
The subsequent viewport correction changes only the UI-test adapter. Normal and
UI builds, the English source-copy check and eight comparator self-checks pass.
All 86 shared/dist font hashes are unchanged; the approved lyric paint was not
edited. Editor captures and later viewport-corrected alignment captures identify
their distinct UI-test binaries with the same frozen production code. App CPU,
footprint and system-wide GPU samples are archived; they exclude helper CPU and
do not measure live display FPS. The recurring earlier engine-discovery fixture
timeout remains undiagnosed; this passing run does not claim to fix it.

Durable evidence and source recovery overlays are in `gpui-editor-locale-20261108`
in this chat's visualization directory. Matching production references, all-locale
layout,
tooltip/accessibility parity, native-only messages, real Precise inference,
Windows/Linux integration and live display cadence remain open. Protocol fixtures
exercise real native controls, decoding, download/install, subprocess and publication
paths; they do not qualify general neural singing quality. The full desktop goal
remains active.

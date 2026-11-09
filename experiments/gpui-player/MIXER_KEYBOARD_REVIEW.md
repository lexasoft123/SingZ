# Mixer and metronome keyboard checkpoint · 2026-11-09

Lane Mute/Solo, global unmute/unsolo and Add/export now use shared UIKit focus and
song-button activation without replacing their painters. Enter runs once in the
capture phase, before GPUI's automatic bubble-keydown/keyup click bookkeeping.
Space retains song transport ownership and blurs an ordinary button. Arrow seeks
retain button focus. Disabled resets/export and removed track controls recover
focus rather than leaving an unavailable focus node.

MetPopover adds 21 persistent button/range handles alongside the existing BPM
input, using shared focus-visible styling and the 0–1/.01 keyboard range. Source
Transport.tsx uses a plain nonmodal popup, so metronome Space belongs to song
play/pause; range arrows and BPM text own their keys. The source mode group clips
outside child outlines; its overflow-hidden behavior is preserved. BPM entry
no longer consumes printable keys before the platform input handler. A mounted,
non-Tab popup root synchronously receives focus if Half/Double becomes disabled,
Redetect disappears, or grid-dependent controls become unavailable.

## Verified scope

`/tmp/singz-mixer-keys-20261109/ui-v4` passes two fresh hidden/muted launches,
1280×800 and 1060×640 at 2×: 44 main PNGs and four saved timeline-motion PNGs.
It combines all previous graph/Save/restart, Karaoke, navigation, region, Restart,
timeline, output, catalog and countdown cases with the expanded keyboard journey.
Foreground identity remains unchanged; all 36 observed helper identities retire;
442 app CPU samples have no errors. Helper CPU is excluded, GPU is system-wide
and live display FPS is unmeasured.

The mixer journey checks actual Tab/Shift-Tab, pointer focus, keydown/keyup,
Enter and native muted/solo fields; Space/arrow ownership; enabled global resets,
disabled Tab skipping/focus recovery, Add keyboard ownership without opening its
chooser, and Export Enter/Escape without producing files. Original mixer settings
are restored and independently read from the saved project.

The metronome journey checks real BPM typing/filtering and cancelled edits,
three same-render range increments to .53, Home/End clamping, native transaction
acceptance, slider Space retaining focus, ordinary-button Space without accidental
activation, Enter accent changes, and five-second arrows. Actual typed 120 BPM
followed by Enter/Half 60→30 verifies that Space and Escape still work after the
focused Half button disables. Boundary edits remain unsaved; production Open
restores the exact original grid, including a no-grid song. The saved metronome
baseline is independently verified. Host and visible output gain agree at both
sizes after explicitly adopting the restored controller state.

Three keyboard-policy tests, one shared range test, normal check, final UI build
and production helper build pass. Both final metronome screenshots were inspected.
Two full native player images (loaded and paused seek) match the previous native
checkpoint pixel for pixel; this is a native before/after regression, not Electron
parity. The 49 native lyric-region positions, pixel hashes and advancing-glow
counts match the immutable transport-timing baseline exactly. The already approved
glyph renderer and fonts were not changed.

UI binary SHA-256:
`04a0a0863cddd6bf1f831797978cbc2f5613554ee2e8e98b51371eda7097e09c`.
Unchanged native helper SHA-256:
`a14e484376aaf88df7a7e7dd92180f7a27794920d032a7bcbf7f9dc4a7530860`.

## Preserved failures and limits

The first UI build exceeded the test report macro recursion limit; the report was
split into smaller constructions without changing its flat schema. A test-helper
string lifetime compile error was fixed. Review found disabled-control focus loss
and added synchronous recovery plus the actual boundary-key test. `ui-v1` records
the Enter double activation; `ui-v2` passes the focused journey and `ui-v3` the
combined journey. `ui-v4` also corrects test-only output baseline restoration so
the visible gain label agrees with host state. Keyup events and behavioral
assertions remain in the test; no direct mute/solo/playing assignment is used.

The native lyric fixture is the explicitly prepared private copy documented in
SINGING_CONTROLS_REVIEW.md; original fixture and visual baselines are unchanged.
The refreshed normal preview passes build, deep strict signing, all 39 payload
hashes, no-Node inspection and configured Drive build-info. Its qualification is
recorded alongside the bundle. The unchanged llama-server startup timeout from
the previous package remains unresolved; these UI changes do not fix or
qualify it. No Node/Electron execution, physical chooser presentation or microphone
capture was performed. Every metronome action/state, full production visual and
temporal parity, live FPS, current Windows/Linux delivery, nonzero clipping and
hardware qualification remain open. The full desktop goal remains active.

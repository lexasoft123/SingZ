# Desktop control behavior fixes — 2026-11-09

Settings now refuses duplicate monitor channels, preserves valid channels when
reselecting the same device, and resets them to OUT 1/2 when changing devices.
Unavailable saved channels display explicitly instead of clamping to an unrelated
channel label. Preference-save failures now appear in the existing error style.

Tap BPM starts a fresh session when reopening the popup or resetting a song.
Two taps from a dismissed popup cannot contribute to the next tempo. The trigger
active state follows source click/grid semantics rather than count-in state.
Unsplit original audio shows Split without split-only Karaoke/Stem files; custom
projects without a vocal stem no longer expose an enabled, inert Stem files action.
Actual vocal-stem projects retain that action. No OS reveal is invoked by tests.

## Verification

- One focused channel-policy and two tap-session Rust tests pass. Normal check,
  final UI build and normal app build pass.
- Settings preferences-only hidden journey passes actual pointer selection,
  disabled duplicate choice, same-device preservation, device-change reset,
  persisted preference readback and visible/clearable errors at both sizes.
  Its inventory and otherwise-unselectable invalid/error states are explicit
  fixtures; it does not qualify physical input or monitoring. Four captures
  were inspected. Nine app CPU/system-GPU samples have no errors or terminal
  discards; foreground remains stable and two observed process PIDs retire.
- Combined player journey passes two independent launches: 44 main captures
  plus four motion captures, 501 app CPU samples with no errors, unchanged
  foreground and 36 observed helpers retired. New actual Tap/Escape/reopen checks
  require three fresh taps and accepted native tempo, then restore through Open.
  Actual grid-only/count-in-only controls verify trigger state. Both final
  metronome screenshots were inspected; existing transport, mixer, timeline,
  catalog, output, countdown, Save and restart checks remain in the journey.
- Three empty/custom lifecycle launches pass 18 captures, including final-track
  removal, CAS refusal, standalone training cue, Copy/Move, re-add/Save/reopen,
  late-status fencing and source-only transport at both sizes. Source-only and
  re-added custom-track screenshots were inspected. Their legacy sampler records
  63 resource observations; it does not qualify continuous sampling or helper
  retirement. Foreground before/after remains unchanged. Physical choosers remain
  untested; picker-return fixtures are explicit.
- All 49 approved native lyric-region timing/pixel/draw-count records remain exact.
  No glyph renderer, fonts or UIKit changes were made.

UI SHA256: `ab868a099749731804c1f764c7d98eafa2f102e078d1680016da43f413fffcec`.
Normal source SHA256: `b37ac38b77e5bddd3f33cd5d46b2bf1c8cf52242b30166179d8656524abab4f9`.
The refreshed normal preview passes deep strict ad-hoc signature verification,
all 39 payload hashes, no-Node inspection and configured Drive build-info. Native
ASR executables are byte-identical to the previously qualified real-engine preview;
their workflows were not repeated in this checkpoint. The app is not notarized.

Evidence: `/tmp/singz-desktop-gaps-20261109`; durable archive beside the normal
preview in `macos-desktop-gaps-20261109/desktop-controls-qualification`. Source hashes,
build/test logs, captures, raw receipts and failures are retained. Settings v1
passed its UI checks but hit an exit-counter sampling assertion; terminal-only
handling now retains raw rejected values and preserves live sampling failures.
Settings v2 exposed initial native inventory arriving after synthetic injection;
the adapter now waits for that callback. An intermediate build wrapper's reporting
print failed after successful build/copy; final UI was rebuilt and hash-pinned.
Review also caught a stale test seek baseline across Open; it is now epoch-local.

Full Settings keyboard access remains a known migration gap. Complete production
visual/temporal parity, live FPS, current Windows/Linux delivery, physical devices
and OS choosers, and release signing remain open. These captures are native
candidates, not a production parity pass. The full desktop goal remains active.

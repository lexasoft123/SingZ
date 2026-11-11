# Native footer keyboard access — 2026-11-09

Footer actions now use persistent focus and existing shared UIKit activation
wrappers. Ordinary song buttons activate with Enter; Space and arrows retain
the song shortcut policy. Split owns its menu navigation, Enter/Space and Escape.
Opening focuses the first enabled action. Disabled actions leave its sequence;
an all-disabled menu retains a mounted scope. Escape restores its trigger.

The port includes Restart/Play/Loop, output, Metronome, Carry, transpose/tempo
and BPM steps, Karaoke, Split/Cancel and Stem files focus. Existing painters,
typography and lyric rendering are unchanged. Host guards retain song/file
command ownership while a transport menu is open.

## Defects fixed

- Closing output could leave focus on its unmounted fader. Actual Tab then
  returned unhandled indefinitely. Render now restores the output trigger only
  while one of that popup's removed controls still owns focus.
- Output Mute/Unity/clip used bubble key handlers that could activate again on
  automatic keyup-click. They now use the shared capture/default-prevention
  wrapper with their existing handles and callbacks.
- Global Tab actions could run before Split's raw key capture. Scoped bindings
  now own Tab/Shift-Tab, with arrows/Home/End retaining the same menu sequence.
- Deferred footer recovery now checks that its scope still owns focus before
  returning focus to Player; a later pointer choice is preserved.

## Verified keyboard checkpoint

Normal check, normal/UI builds and focused keyboard/output policy tests pass.
The hidden, muted keyboard journey and restart pass 1280×800 and 1060×640 at 2×,
with 18 required footer flags, 84 footer receipts and eight new focused captures.
Its 24 total screenshots include the retained keyboard checks. Actual native
receipts verify Play/Pause, Restart, Loop, Karaoke guide mute, transpose, tempo
and BPM steps. Metronome/Carry opening and Escape, output key ownership, Split
navigation and genuine missing-engine refusal pass. Refused Split preserves
project/audio bytes and native epoch; normal Save restores the baseline.

Output Mute Enter, Unmute Space and Unity Enter each receive actual keydown/up
and preserve paused position and seek count. Host gain changes 0 → previous
positive value → 1. The native helper intentionally clamps master gain to zero
under `SINGZ_MUTE`; actual native readback stays zero. Positive native gain and
audible output are not qualified by this silent fixture.

Explicit private fixtures supply a missing constant beat grid through the real
native metronome transaction, vary menu eligibility and remove focused Karaoke.
They are recorded separately from real operations and restored afterward. The
stale recovery regression explicitly renders the production child before its
parent, then uses actual app-local pointer down/drag/release outside Play. It
checks pending recovery, scope ownership and the consumed guard without assigning
focus or pending state. Natural display-race cadence is not tested. GPUI redraws
dirty windows before key dispatch, so this race is not claimed as a Tab test.

All 22 observed processes retire; foreground remains stable. The isolated
keyboard/restart run records 184 app CPU/footprint/system-GPU samples, with zero
errors or terminal discards. These observations include interaction and captures;
helper CPU is excluded and GPU counters include other processes. Hidden live FPS
and display cadence remain unmeasured.

The final full combined first/restart workflow also passes: 52 main captures plus
four timeline-motion frames, 84 footer receipts, 671 valid resource samples,
zero errors/discards, stable foreground and 50 observed processes retired.
First/restart app CPU means are 62.50%/62.23%, p95 82.48%/81.83%, and maxima
85.49%/85.77% (100% is one core). The app physical-footprint maximum reaches
2.90 GB during this capture-heavy debug journey; this is not a steady-state
memory/performance qualification. Two default native player images and their
whole sidecars remain exact to the preceding native checkpoint under compare-ui.
All eight combined footer images match the four inspected isolated images.

Evidence: `/tmp/singz-footer-keys-20261109`. UI SHA256:
`be564a6d518c946cb11a95ad367adb88d38d94df9e3686cb2c93acd230cf3d23`.
Normal source SHA256:
`ce025401127d838e5404165631527562de65fe25ec101502e6755290733857be`.
The normal preview passes deep strict ad-hoc signature verification, all 39
payload hashes, no-Node inspection and configured Drive build-info. It is not
notarized or release-qualified. Selected evidence and source identities are
archived beside it under `macos-footer-keys-20261109/footer-keyboard-qualification`.
Source overlays and failed runs remain preserved. Early runs exposed the removed
output focus, incorrect race-fixture timing/target assumptions, global Split Tab
precedence and an incorrect positive-native-gain expectation under mandatory mute.
The corrected assertions preserve the intended contracts and record their scope.

Four focused images at each size were inspected across the final two launches.
No production Electron reference was built or captured. Complete production
visual/temporal/accessibility parity, every control state, nonzero clipping and
audible output, current Windows/Linux delivery, physical hardware and release
qualification remain open. Training Home/setup keyboard access is the next
concrete migration gap. The full desktop objective remains active.

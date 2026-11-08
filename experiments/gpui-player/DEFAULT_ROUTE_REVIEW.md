# Native default-output capability publication — 2026-11-08

A native helper regression reproduced a gap in the previous Settings fix: Play
followed a newly available system default, but its receipt omitted the new
endpoint's capabilities. Prepare and explicit Settings output commands were the
only publication points. A fresh ALSA inventory process can see `EBUSY` before it
has ever learned that endpoint's channel count, so the separate inventory worker
could still lose the active output after an implicit default change.

The helper now remembers the last published **actual output UID** and includes
its native inventory on the same receipt whenever that identity changes.
Explicit output commands still request a snapshot even when the UID stays the
same. Ordinary status and Pause do not gain an inventory query or payload. The
wire protocol, mute invariant, reply bounds and native route admission remain.
No renderer, UIKit, font or lyric-paint source changes are part of this checkpoint.

The explicit `--test-fake-host` mode now has a controllable default-output fixture.
It delegates rendering and lifecycle to the existing native fake provider and
uses the real playback engine; a new output changes from 48 kHz to 44.1 kHz and
then disappears as the original 48 kHz default returns. The private `test-default`
command is refused outside that fake mode. A real empty session confirms refusal,
unchanged UID, released physical output and zero callbacks, without opening a
platform stream or changing any OS preference.

The new matrix passes on Mac and Linux: Play, metronome preview, song training
cues, standalone training cues, and an explicitly selected route. It checks
capability publication, settled native seek position, preserved mix/rate/transpose/
loop/duration, callbacks, the return to the original default, and quiet ordinary
status/Pause. The explicit selection stays selected. These are simulated device
changes with real native decode/DSP, not hardware hotplug qualification. The
initial missing-snapshot failure is preserved. An early expanded fixture omitted
the required metronome bus; it now prepares the same valid bus used by the app.
No deadline, position tolerance or assertion was relaxed.

Both full Rust suites pass **771 tests, zero failed, two ignored**. Six Mac and
seven Linux native suites pass, along with native helper audio, training, canonical
click-gain and empty-project regressions. The muted real ALSA kernel regression
also passes after a forced underrun, retaining the graph, lane revision and route
with increasing callbacks/position and no terminal/render failures. A passing run
does not close the previously recorded intermittent engine-probe startup timeout.

The final hidden UI batches pass **45 PNGs across ten app launches**: Mac Settings
16 and graph/Save/restart 8; Linux Settings 13 and graph/Save/restart 8. Independent
validation checks all image decodes, recorded Linux hashes/viewport/scale, four
binary identities per platform, actual app counts, unchanged foreground samples,
and native process retirement. Linux records active-workflow CPU/RSS with software
rendering; GPU counters and live FPS remain unmeasured. Legacy Mac Settings PNGs
are 2560×1602 without viewport sidecars; graph PNGs have matching recorded metadata.
No production visual/temporal parity or shown Linux frame qualification is claimed.

The initial Mac observer compared `/tmp` against canonical `/private/tmp`, so it
recorded no native processes. Those first captures are retained and do not prove
retirement. The corrected observer resolves its executable path and requires
non-empty identities plus exactly three/two observed app processes. Repeated final
Settings and graph batches pass, observing nine/four native processes respectively,
with all identities retired and every foreground sample unchanged.

The final Mac UI copy is isolated at `/tmp/singz-default-route-ui-bundle`; its app
SHA-256 is `4dab05a5eb90ae1d99fe6b705ab6be83d45442fe0194f6d11b84de21a0bebf0d`
and helper is `2f78ba33ac4bc573fc3cb38fb7c999138d366b11b9c4a2741fac3b96959c5fb9`.
The normal Mac app is restored, SHA-256
`6b26b6e50b9c44e56fda9ac53095e8dc6854938e9068302d4639adc4fb458229`.
The Linux app remains `70e283bc0c7ec0f74d282c2d3d4ccf47531d735e3ed934737b07479948b0820c`,
with new helper `597fedc279a4ee78f11e7efe81e1e312cd29961168d1b0be0740f80eba7334ec`.
The two-file source overlay is hash-verified on the VM and locally. Evidence is
`gpui-default-route-20261108` in the chat visualization folder; the remote ZIP
SHA-256 is `737e5eb16b697485de94f967e6c20a804a0dc9c8a0ba7523bb3fc3e4200589fb`.
`verify-checkpoint.py` reproduces the independent archive validation.

All current builder/runtime owners are retired. Both exact task-created VM
containers are stopped with source and caches retained. The foreign app still
holds PCM0 playback/subdevice0 PREPARED under PID 1268; it and other containers
were not stopped. No Node/Electron execution, staging, commit, user-preview
replacement, window activation or global input was used.

Remaining device work includes asynchronous device-loss handling: the current
`Event::Error` path in the native UI clears the loaded project. It must retain the
project and working edits and offer safe route recovery. A further source-audit
concern is that raw transaction replies (including first-lane admission into an
empty project) bypass `Connection::command`, whereas inventory snapshots are
currently remembered only by open/command. That path needs an owned-reply/cache
regression before broad default-route qualification. Physical hotplug, microphones,
Wayland/hardware GPU, live FPS, accessibility/localization, packaging and full
visual parity remain open. The previously observed missing microphone emoji glyph
also remains open. The full desktop GPUI goal stays active.

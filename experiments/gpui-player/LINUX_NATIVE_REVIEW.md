# Linux native integration — 2026-11-08 checkpoint

VM 403 is `singz-debian13`, Debian 13 x86-64. The earlier Linux report qualified
the fixture interface only. This run uses a new isolated lab
`~/dev/gpui-native-20261108`, preserving the previous GPUI source/binaries,
existing development containers and the user's running app.

The initial source ZIP contains 1,878 hash-verified files, including native
source, the Rust application and shared UIKit/font assets. Its SHA-256 is
`1304c8e57cfb1ad4d158b5d06cda50f7dbb63e08850534faa198f2ce9d11cb41`.
Rust 1.99.1 uses a copy of the persistent user-directory cache. Builds run in
the rootless container `singz-gpui-native403-20261108`; no Node/Electron path is
used. Compiler and supervisor ownership is recorded by PID and proc start ticks.

Source inspection found a functional omission: this checkout selected the
unsupported audio provider on Linux. Six existing ALSA provider files and their
native regression suite were restored from the clean shared zCore checkout at
`e363944306b90da94ec409470924a907d2a5a2b5`. Linux CMake now selects and links
that provider with ALSA/libudev. Input support and eventfd delivery replace the
unsupported/polling stubs. Shared diagnostics retain the provider's non-finite
sample counters. The twelve-file overlay and original import hashes are archived.

The shared native regressions pass six selected suites on Mac and seven on
Linux, including the expanded ALSA I/O recovery and timestamp suite. The full
Rust suite passes **770 tests, zero failed, two ignored** on each host. Failed
Linux runs are retained: first 768/2, then 769/1 before the fixes below. The Mac
normal build also passes. These checks do not establish all runtime workflows.

The first two Linux failures were portable fixtures: an indented `python -c`
program relied on [automatic dedenting added in Python 3.14](https://docs.python.org/3/using/cmdline.html#cmdoption-c),
while the VM runs Python 3.13; and an unlink/rewrite test could reuse the exact
inode and timestamps (95/100 isolated probe iterations were indistinguishable).
The Python program is explicitly unindented. The replacement fixture retains the
old file outside the project and asserts that the new identity actually differs;
its deletion-refusal assertion remains intact.

A subsequent stdout-limit failure exposed real throughput loss: fixed 5 ms
sleeps drained only 11.9 MiB before the five-second deadline on 8 KiB Linux pipes.
Unix now waits for readability on either pipe instead. The 16 MiB output bound,
five-second regression deadline and cancellation checks are unchanged. The full
Linux and Mac suites pass with this fix. Earlier intermittent engine-probe
startup timeouts are not closed by these passing runs.

Native title/rename passed first. Two graph runs then stopped output; diagnostic
counters in the subsequent Copy/Move failure proved **one host underrun, zero
render failures**, session Terminal and host Error. The older restored provider
made underruns fatal. Existing later shared-engine ALSA I/O code now recovers
EPIPE through silent re-priming, preserves the pending rendered suffix, marks a
clock discontinuity and continues the same graph/route. Failed recovery and
non-recoverable device errors remain terminal. Capture recovery and bounded
monotonic timestamp handling are included. The mono input adapter reports an
unknown timestamp when no estimate is available. This checkout has no selected
capture-bus API, so its upstream bus-only case was not imported; all existing
mono/lease/kernel cases and the additional applicable output/capture recovery
and timestamp cases remain in the native suite. The complete upstream source
and test file are preserved beside the adapted source and hashes.

A real kernel regression briefly stops only its own muted helper for 150 ms,
observes a genuine underrun and verifies continued Running state, increasing
callbacks/position, unchanged graph/lane/route and zero terminal/render failures.
It passes on the idle loopback direction. `run_linux_ui.py` now runs the existing
workflow drivers on a private Xvfb/Openbox display, checks unmapped app windows
and unchanged private-display foreground, and records app/helper CPU and RSS,
source/binary identities and viewport/PNG hashes. GPU counters and live display
FPS remain unmeasured. The recovered-binary batch passes eight runs across twelve app processes: title (6 PNGs),
graph/Save/restart (8), Copy/Move (11), deletion (12), Drive (22), phone adoption
(22), recording/export (12), and a repeated graph run (8), totaling **101 PNGs**.
An independent local pass verifies every PNG hash, decode and viewport, all four
binary hashes, process counts, unmapped-window records and unchanged private-display
foreground samples. Graph runs cover 1280×800; the other workflows also exercise
1060×640, without claiming every state at both sizes. Drive uses local OAuth/HTTP
fixtures; recording uses native PCM replay and intercepted chooser selection,
while the export worker writes real WAVs. Physical microphones and OS dialog
presentation remain unqualified. Its app SHA-256 is
`eaaa13743e7a80befdb7d73c13cbbd36295c94dedf2dbe258bb82b52bc96e824`.
No old-binary captures are attributed to this candidate.

VM inventory reports two HDA emulated cards and the existing `SingZLoop` kernel
loopback. PCM0 playback/subdevice0 is held by another app (observed PREPARED);
that owner and route are not changed or terminated. Runtime checks must use idle
endpoints and a private virtual display. The real kernel-loopback test's default
two-direction recipe must not run while the existing app owns that endpoint.
The other loopback direction is deliberately not exposed to the runtime container. Hardware GPU,
Wayland, live display FPS, physical microphones, hotplug, matched production
visuals and Linux packaging remain unqualified.

Evidence is in `gpui-linux-native-20261108` in this chat's visualization folder:
original source manifest, provider/recovery provenance, the final 21-file source
overlay verified on the VM, Mac logs, completed Linux workflow receipts, and
retained earlier failures. The completed remote evidence ZIP has SHA-256
`bde59d3755d829b130aa934b38b2d48778daa0b943730a70db808b45117cd269`;
`verified-workflows.json` records the independent 101-image check and active-workflow
CPU/RSS samples. These software-rendered readbacks are not a live/idle GPU benchmark.
The supervised batch owner and all 55 observed native PID/start-time identities
are independently confirmed retired in `verified-retirement.json`; the separate
Settings follow-up owns any subsequent jobs. The full desktop goal
remains active.

Visual inspection of the archived Linux title editor confirms the narrow border and Open label fit.
The deletion modal fits at 1280×800, but its Unicode fixture title contains a missing microphone emoji glyph (`🎤`).
This is an observed Linux font-fallback gap; the workflow pass does not qualify text rendering.

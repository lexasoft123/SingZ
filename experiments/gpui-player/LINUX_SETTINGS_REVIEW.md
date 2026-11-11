# Linux Settings inventory — 2026-11-08 checkpoint

The completed Linux native workflow checkpoint is [LINUX_NATIVE_REVIEW.md](LINUX_NATIVE_REVIEW.md).
A follow-up on the same VM found a distinct live-device defect: a fresh inventory
helper reports `outputChannels: 0`, `sampleRate: 0` and an empty default output
while the application's own exclusive ALSA output continues Running. The same
endpoint has 32 output channels before playback and after the helper retires.
The raw before/during/after receipts are retained in `settings-inventory-v1`.

ALSA inventory now distinguishes `EBUSY` capability-probe failures from unsupported
directions and other errors. Prepare and explicit output-route receipts include
a native capability snapshot. The Rust app shares those proven facts in memory
with its separate inventory worker, restoring a zero count only for an explicitly
busy, still-present ALSA endpoint. Removed endpoints evict their facts, non-busy
failures do not inherit capabilities, and restored directions participate in the
same unique-default calculation. Cached facts never bypass native route admission.
No inventory work or probe is added to Pause or periodic status commands, and
nothing is persisted to disk. Other platforms retain their existing inventory path.

A pure regression checks busy input/output, ambiguous defaults, ordinary failures,
removal/reconnection and duplicate UID rejection. Full Rust suites pass **771 tests,
zero failed, two ignored** on Mac and Linux. Six Mac native suites pass. The first
Mac full-suite run was sandbox-restricted and failed its local HTTP fixtures;
the permitted run passes without changing fixture assertions. All seven Linux native suites and the final normal Mac/UI Linux builds pass.

The hidden Settings adapter now waits for a new completed inventory revision after
opening Settings during playback, checks the selected output and advancing song
position, then exercises explicit route pause/persistence, restart, unavailable
saved-route repair and invalid-route playback retention. The existing Linux
private-display runner also supports this three-launch driver. Missing captures,
physical devices, hotplug, live FPS/GPU and production visual parity are not passes.


The final Linux app `70e283bc0c7ec0f74d282c2d3d4ccf47531d735e3ed934737b07479948b0820c`
and helper `34f9c0dae3422326276f9f1a89f7ce27b5ab96e078e54916792b14eafc14d8ca`
pass **13 Settings PNGs across three launches** and **eight graph/Save/restart PNGs
across two launches**. An independent local check verifies all 21 hashes, image
decodes, recorded viewport/scale, four binary identities, app counts, unmapped
windows, unchanged foreground samples and finite CPU/RSS samples. All five app
processes and their observed native helpers are retired. The real kernel probe
also verifies the initial proven output capabilities, fresh-process `EBUSY`
metadata, and continued same-graph/route playback after a forced underrun.

Mac passes the same three-launch Settings workflow with **16 PNGs**, including
last-input-channel scrolling, and 22 unchanged foreground samples; every observed
native process is retired. Its legacy capture adapter produces 2560×1602 PNGs
without viewport/scale sidecars. They are decoded and hashed, with no matched
visual comparison claimed. Two preceding Mac failures are retained: the test
checked the optimistic Play toggle before native playback had resumed. The
strengthened gate requires a playing native receipt and advancing position before
injecting the unavailable-route fault; the original five-second deadline remains.
This stronger gate passes on both platforms. A later small Linux-only change
removes a UID-prefix assumption; the cache uses explicit busy metadata and opaque
UID equality, covered by the final suites and final Linux UI candidate.

Evidence: `gpui-linux-settings-20261108` in the chat visualization directory,
including original and final 11-file overlays, raw pre-fix receipts, failed and
passing Mac captures/logs, Linux native/Rust build logs, final workflow receipts,
CPU/RSS records and independent `verified-workflows.json`. The remote evidence ZIP
SHA-256 is `552637f424bc42487831714159509f773a27a30031d7308c33620dfe15847772`.
All three build owners and the final runtime supervisor are confirmed retired.
Both exact task-created container IDs are stopped; lab/source/caches are retained.
The user's other app still holds PCM0 playback/subdevice0 PREPARED with owner PID
1268, and no foreign process or other container was stopped.

Qualification is limited to initial and explicitly selected routes, local kernel
loopback on Linux and muted native output on Mac. Automatic default-device/hotplug
recovery, physical microphone input, live FPS/GPU, Wayland/hardware graphics,
localization/accessibility, production visual/temporal parity and packaging remain
open. In particular, the separate original Linux deletion capture contains a
missing microphone emoji glyph; this backend fix does not qualify font fallback.
The full desktop GPUI goal remains active.

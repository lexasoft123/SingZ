# Working Save preserves monitoring — 2026-11-08

Working-copy Save now publishes and adopts storage without stopping an active
monitoring generation. After explicit Stop and clean lease release, playback is
prepared from the saved project, paused. The covered workflow is verified on
Mac with muted synthetic monitoring and real native playback. Linux retains the
production platform-unavailable policy; its monitoring workflow is not qualified.
The full desktop goal remains active.

## Defect and implementation

The port's `start_source` sent Pause through `native_command`, whose monitoring
handoff requests Stop. If storage finished before cleanup, publication adoption
could also request output recovery while the backend still held `monitor_lease`.
Production `App.tsx::handleSaveProject` instead publishes/reanchors storage without
stopping its independently owned monitoring coordinator.

Save now skips that Pause specifically while monitoring is busy. Publication
reading/adoption remains independent of audio preparation. Successful adoption
records an epoch-bound `monitor_publication_epoch` while monitoring continues;
playback stays unavailable until restoration. The backend's monitor-lease guard
remains intact. A matching successful `Parked(false)` receipt follows microphone
cleanup, then requests preparation from the current saved document, accepted mix
and stopped position. It stays paused until explicit Play.

Cancellation, navigation or transport failure clears stale restoration authority.
Transient storage/audio work retains the intent and clean ticks retry before
draining commands. Only the next queued replacement can own preparation; a later
route/Open cannot make an earlier Play disappear. The queue waits for pending
restoration/recovery. Busy guards precede replacement transfer, so a queued Output
is not consumed while another Save still prevents dispatch. Failed enqueue is
reported through the existing route-error/explicit-Retry path.

A read-only explorer identified the original defects and three ordering issues
in intermediate fixes; its final targeted source audit found those findings
closed. A separate worker owned the new UI module/driver. Root integrated,
reviewed, built and captured everything in the shared checkout. No new Kimi job
was attempted after the previous review hit its usage quota.

## Final runtime evidence

Final v3 normal Rust suites pass **781 tests, zero failures, two ignored on both
Mac and Linux**. UI builds pass and the normal Mac executable is restored. No
builds/native-heavy tests ran during final hidden/muted captures.

| Final case | Mac PNGs / apps | Linux PNGs / apps |
| --- | --- | --- |
| Real Save, uninterrupted monitor generation, automatic Header Stop restore | 6 / 1 | unavailable; not exercised |
| Save plus held-busy/default-Output controller adapter | 7 / 1 | unavailable; not exercised |
| Actual disabled Monitor policy | not applicable | 2 / 1 |
| Existing monitor handoff, rate, Save/navigation, owner Stop | 4 / 1 | unavailable; not exercised |
| Source split/handoff/Save/conflict/rename/cancel | 14 / 1 | 14 / 1 |
| Healthy live-helper publication-read failure | 7 / 1 | 7 / 1 |
| Publication fault/repair/Escape/focus | 29 / 3 | 29 / 3 |
| Retention, Save/restart and offline recovery | 19 / 3 | 19 / 3 |
| Total | **86 / 11** | **71 / 9** |

The primary Mac run performs actual raw drop, measured headphone consent and
Monitor click, Settings Escape, Header Save and Header Stop. Fresh backend-owned
status commands prove the original playback child stays parked with physical
output released and its monitor lease held through Save. The same microphone
generation advances its native sequence while the exact saved document/media is
adopted. Header Stop releases capture, creates a paused replacement and actual
Play advances native position. Primary helper PIDs are 21716 → 21743, microphone
generation 1, with eight native probes. The adapter run uses 21791 → 21816,
generation 1 and nine probes; PIDs are cross-checked against process observers.

The adapter explicitly holds `saving=true` after completed real publication,
clicks actual Stop and synchronously queues a default Output controller intent.
The clean-release frame must retain that intent and restoration marker with no
recovery while busy. Clearing the held state must drain it and restore paused
playback. This **does not exercise a real concurrent second writer or an actual
output-selector interaction**. It is separate from the primary automatic-Stop run.

The first Linux attempt timed out because its actual Monitor button is disabled.
This matches `Settings::monitor_route` and production `SettingsModal.tsx`'s
non-Darwin policy. Final Linux coverage clicks the real disabled control at
1280×800 and proves no lease/input generation is acquired, metadata stays intact
and the same native child remains paused. It also records the state at 1060×640;
that frame retains an inner scroll position with the policy caption/button below
the visible area, so it is not a visible-control comparison at that size. The
guard is not bypassed and no Linux monitoring-integration pass is claimed.

Independent validation passes **157 decoded PNGs / 20 apps**, 24 checkpoint source
pins plus unchanged UIKit, native binaries, available state sidecars, native
ownership/paused/advancing probes, exact persisted metadata/PCM, Source seek/Play
receipts, unchanged foreground and unmapped Linux clients. Independent retirement
checks cover 54 final Mac observed owners (107 including intermediates) and 34
Linux observed owners. The exact two task containers are stopped, preserving
host PID1268/startTicks4023 PCM0p in PREPARED, other containers and source/caches.
The user's preview is untouched. No staging or commit was performed.

## Visual, test and qualification limits

All new target captures use 1280×800 or 1060×640 logical pixels at 2×. Four old
Mac monitor interaction frames retain 2560×1602 geometry and are excluded from
the 1280×800 contract. No images are resized, aligned or masked. Full Mac saved
monitor/paused-restored frames and Linux policy frames were inspected. At 1060
the active-monitor header has no visible song title; matching production
comparison remains open. The narrow Linux policy caption/control also needs a
capture scrolled into view before visual comparison. There are no matched
production captures or visual-parity claims. Fonts, UIKit and approved lyric
paint/glow are unchanged. CPU/footprint samples are preserved; live FPS/GPU and
hardware monitoring remain unmeasured/unqualified.

The initial new snapshot exceeded `json!`'s expansion recursion; splitting its
objects fixed compilation without increasing the crate recursion limit. Interim
v2 Mac adapter/regressions pass, while its Linux attempted workflow fails before
monitoring starts; those remain historical evidence. Final v3 adds the separate
automatic path and typed Linux policy case. A Python-only correction replaces
an unimported `sys.exit(0)` with built-in `SystemExit(0)` after native builds are
terminal. Its before/after hashes and remote application receipt distinguish
compiled native sources from the final test-driver overlay; no Rust/binary changed.

Actual concurrent-writer timing, post-publication navigation combinations,
monitor read-fault cleanup, training recovery, physical devices/permissions,
latest Windows, chooser/service/model qualification, localization/accessibility,
full production visual/temporal parity, live FPS and packaging remain open. The
recurring engine-probe startup issue is not resolved by these passing suites.

## Artifact identities

Artifacts:
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-monitor-publication-20261108`.
See `final-source-v3-native.json`, `final-source-v3.json`,
`monitor-publication-v3-driver-overlay.json`, `final-capture-manifest.json`,
`independent-final-validation.json`, delegated review and retirement/cleanup receipts.
Production policy source copies/hashes are preserved without running Electron.
Linux archive SHA-256:
`e11654a0c791ffcf9cd8973988fde92285ada607da209c862c155c33ebac45c6`
(26,984,587 bytes), independently reopened and CRC/hash checked. The combined
archive identity is recorded separately in `completed-archive-receipt.json`.

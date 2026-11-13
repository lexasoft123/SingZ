# Q-02 native release baseline (Windows)

- App: native at commit `492fb67d`, build `release+ui-tests` (package profile `release`).
- Machine: Dell XPS 15 9530 (Intel Core i7-4712HQ 4C/8T, 16 GiB, Intel HD 4600 + NVIDIA GT 750M, Windows 10 22H2 build 19045) (model: XPS 15 9530, cpu: Intel(R) Core(TM) i7-4712HQ CPU @ 2.30GHz, cores: 4 cores, 8 threads, memoryBytes: 17078218752, windows: 10.0.19045 build 19045, gpus: ['Intel(R) HD Graphics 4600 (driver 20.19.15.5058)', 'NVIDIA GeForce GT 750M (driver 25.21.14.2531)'], display: 3200x1800 @ 59 Hz).
- 3 hidden runs per cell, plus visible runs where listed; reference: {"reference": "synthetic 5-minute reference; 12-minute cycle partner", "stemCount": 6, "durationS": 300, "lyricsPresent": true, "storedPitchLine": true}.

| Cell | Median | Worst | Runs |
|---|---|---|---|
| Idle CPU (N6), % of one core | 1.55 | 1.56 | 1.14, 1.56, 1.55 |
| Playing CPU (N7), % of one core | 2.38 | 2.48 | 2.38, 2.00, 2.48 |
| Steady footprint (N9) | 145.0 MiB | 157.0 MiB | 157.0 MiB, 141.0 MiB, 145.0 MiB |
| Startup (N12) | 11703.00 ms | 11718.00 ms | 11718.00 ms, 11687.00 ms, 11703.00 ms |
| Song open (N13) | 1062.00 ms | 1063.00 ms | 969.00 ms, 1063.00 ms, 1062.00 ms |

Memory growth over the cycles phase (N10): -7.8 MiB (within noise), -118.9 MiB (within noise), -51.7 MiB (within noise). Rule: rise must stay within max(2.0 x residual stdev, 1% of steady footprint). Close exposed by the app: False.

Visible presented-frame runs (PresentMon, `frames_visible_windows.py`):

- static: fps 59.97, p99 16.74 ms, dropped 1, samples 3594, fail (presentedTime), app GPU 81.50 %, DWM GPU 61.00 %; fps 59.95, p99 16.75 ms, dropped 2, samples 3595, fail (presentedTime), app GPU 86.22 %, DWM GPU 62.51 %; fps 59.98, p99 16.74 ms, dropped 0, samples 3595, fail (presentedTime), app GPU 85.60 %, DWM GPU 62.24 %
- idle: fps 0.11, p99 9886.17 ms, dropped 0, samples 4, fail (presentedTime), app GPU 0.52 %, DWM GPU 0.41 %; fps 0.12, p99 8969.38 ms, dropped 0, samples 5, fail (presentedTime), app GPU 1.52 %, DWM GPU 0.27 %; fps 0.15, p99 13420.77 ms, dropped 0, samples 8, fail (presentedTime), app GPU 2.11 %, DWM GPU 0.61 %

Shipped package (N14): `singz-native-setup.exe`, 40,337,311 bytes (38.5 MiB), sha256 `dc4c5986edfb85a3e6b43559da0a0371faadd9c7c46d283ffc5d6bd552e68dae`

## Caveats

- **Measured at 492fb67d, which predates 1706b685 (Bring paused CPU under 1% of one core) and d2bc946c (the Drive UI driver's empty-project expectation): N5 and N6 are pre-fix figures, re-measured at the tip in the last section: N5 0, 0, 0 (pass) and N6 0.39 % (pass). The N5 figures in the table below are contaminated, see there.**
- Hidden and visible runs use the release ui-tests build of this tip (cargo build --release --locked --features ui-tests) with the three helpers built against the verified FFmpeg codec pack (a local snapshot of the pack built for this commit on the same laptop; inspect passed), so codecs are the full matrix. Engines are the same snapshot's statically linked llama-server and crispasr; the player and helpers import no VC runtime.
- N14 is the unsigned NSIS installer from scripts/package-gpui-desktop.py over a separate plain release build (no ui-tests), the same helpers, and those engines.
- Same measurement method and idle machine as the Q-01 Windows file; memory is summed working set (see there). The native process tree includes its helpers.
- Visible runs: the native visible scenario drives an empty animating window (static) and an idle window; it cannot open or play a song, so N1-N3 and N8 are judged only on the empty window and the Electron playback figures cannot be compared like for like. Presented times come from PresentMon (TimeInMs + MsUntilDisplayed of 2.3.1), which fills them on this machine, so these timings are validated, unlike the Mac handler-callback times. The static gate failed on p99 by 0.04-0.05 ms (16.74-16.75 ms against 16.70) in all three runs and on 1-2 dropped frames in two; the limit is not relaxed.
- Native startup (N12) is the process spawn to the interactive receipt and includes the launch-time catalog scan; it measured about 11.7 s on all three runs on this 2013-class laptop.
- 120Hz: deferred until a 120 Hz panel exists; not failed

## Gap to each budget, native against Electron

| # | Area | Status | Native | Electron | Note |
|---|---|---|---|---|---|
| N1 | Frame rate | **unvalidated** | 59.97 fps, p99 16.74 ms, 1 dropped; 59.95 fps, p99 16.75 ms, 2 dropped; 59.98 fps, p99 16.74 ms, 0 dropped | n/a | Reference-playback frames are not captured: the native visible scenario is an empty animating window (figures shown from PresentMon presented times, an empty-window diagnostic, not a pass), because it cannot open or play a song. Electron's presented frames are in its own file. The 120 Hz probe is deferred (no panel). |
| N2 | Frame time | **unvalidated** | 59.97 fps, p99 16.74 ms, 1 dropped; 59.95 fps, p99 16.75 ms, 2 dropped; 59.98 fps, p99 16.74 ms, 0 dropped | n/a | Reference-playback frames are not captured: the native visible scenario is an empty animating window (figures shown from PresentMon presented times, an empty-window diagnostic, not a pass), because it cannot open or play a song. Electron's presented frames are in its own file. The 120 Hz probe is deferred (no panel). |
| N3 | Dropped frames | **unvalidated** | 59.97 fps, p99 16.74 ms, 1 dropped; 59.95 fps, p99 16.75 ms, 2 dropped; 59.98 fps, p99 16.74 ms, 0 dropped | n/a | Reference-playback frames are not captured: the native visible scenario is an empty animating window (figures shown from PresentMon presented times, an empty-window diagnostic, not a pass), because it cannot open or play a song. Electron's presented frames are in its own file. The 120 Hz probe is deferred (no panel). |
| N4 | Input latency | **unvalidated** | n/a | n/a | No input-latency measurement exists in the harness. |
| N5 | Idle redraw | **pass** (tip) | [0, 0, 0] at the tip; [4, 5, 8] at `492fb67d`, contaminated | n/a | Presented samples in a 60 s idle window once the app has settled (presence count, clock-independent); see "Re-measure at the tip": the 4, 5, 8 and the first tip figures 1, 3, 0 are kept as history but were contaminated by ssh polling taking the foreground and by the first-launch Models wizard still closing. A paused song and an open modal are not covered. Electron not measured. |
| N6 | Idle CPU | **pass** (tip) | 0.39 (worst 0.45) at the tip; 1.55 (worst 1.56) at `492fb67d` | 2.91 (worst 3.50) | Mean CPU over the 60 s pause phase, whole process tree; the song is paused, not unloaded. The 1.55 fail was before `1706b685`. |
| N7 | Playing CPU | **pass** | 2.38 (worst 2.48) | 3.58 (worst 3.70) | Mean CPU over the 3-minute play phase, medians compared; target (half of Electron) not applied here. |
| N8 | GPU, Windows | **unvalidated** | {"static": {"appGpuPercent": 85.6, "dwmGpuPercent": 62.24, "dwmCpuPercent": 10.16, "appCpuPercent": 40.15}, "idle": {"appGpuPercent": 1.52, "dwmGpuPercent": 0.41, "dwmCpuPercent": 3.94, "appCpuPercent": 2.52}} | {"playing": {"appGpuPercent": 17.49, "dwmGpuPercent": 0.86, "dwmCpuPercent": 8.5, "appCpuPercent": 29.9}, "idle": {"appGpuPercent": 0, "dwmGpuPercent": 0.04, "dwmCpuPercent": 1.57, "appCpuPercent": 2.43}} | GPU and DWM share are measured in a visible window, but reference playback was not captured for both apps (the native visible scenario cannot open or play a song), so the shares shown are for the scenarios each app has and are diagnostic, not judged. |
| N9 | Memory | **pass** | 145.0 MiB (worst 157.0 MiB) | 473.0 MiB (worst 476.0 MiB) | Physical footprint of the process tree at the end of the 3-minute play phase. |
| N10 | Memory growth | **unvalidated** | -7.8 MiB, -118.9 MiB, -51.7 MiB | -17.0 MiB, -65.4 MiB, -39.9 MiB | Cycles alternate two songs, but neither app can close a project, so these are open/open cycles (closed = null in the receipts); the figures are measured, the budget is not judged. |
| N11 | Audio | **pass** | [0, 0, 0] | n/a | 60 s burst. |
| N12 | Startup | **pass** | 11703.00 ms (worst 11718.00 ms) | 13105.02 ms (worst 13115.38 ms) | Native: process spawn to interactive receipt. Electron: driver launch to library ready and welcome dismissed. Definitions are close, not identical. |
| N13 | Song open | **pass** | 1062.00 ms (worst 1063.00 ms) | 2391.00 ms (worst 2438.00 ms) | First open of the 5-minute reference song, hidden. |
| N14 | Package size | **pass** | 38.5 MiB | 102.5 MiB | Shipped installer sizes. Native is the NSIS installer built here, unsigned; Electron is the published release asset. |

## Re-measure at the tip, 2026-11-12 and 2026-11-13 (N5 and N6)

Same laptop, same reference library, hidden and visible runs, release ui-tests builds. The table above still describes commit `492fb67d`; the gap rows for N5 and N6 now carry the tip result and keep the old figures.

**What was measured, on which commit.** N6 (three hidden runs) on a release ui-tests build of `85d6284a` plus the worktree's uncommitted driver and Drive-path fixes. N5 (three visible idle runs, 2026-11-13) on a fresh release ui-tests build of `85d6284a` plus the worktree's uncommitted changes at that time, which add the level-triggered focus invariant and overlay gate on top; neither touches idle painting.

| Cell | Runs | Median | Worst | At `492fb67d` |
|---|---|---|---|---|
| Idle CPU (N6), % of one core | 0.39, 0.25, 0.45 | 0.39 | 0.45 | 1.55 (worst 1.56) |
| Presented frames in 60 s idle (N5) | **0, 0, 0** | 0 | 0 | 4, 5, 8 (contaminated) |

- **N6 passes**: the median 0.39 % is under the 1 % budget (it was 1.55 %, a fail), and it is below Electron's 2.91 %.
- **N5 passes**: 0, 0, 0 presented frames over three clean 60 s runs.

**Method change for N5** (`tests/perf/frames_visible_windows.py`): the capture now starts when the app reports it has settled (the Library showing, in the foreground, with no Models wizard, notice or locale load; five consecutive one-second probes, after the minimum 25 s) instead of after a fixed 25 s, and a run is rejected when the app window lost the foreground at any sample during the capture. The control for the rejection: Notepad opened and closed in the interactive session during a capture, and the run was rejected ("the app window lost the foreground for 32 of 565 samples").

**The earlier N5 figures were contaminated and are kept as history, not as the app's idle behaviour.** The 4, 5, 8 (at `492fb67d`) and the first tip figures 1, 3, 0 were measured with the old harness, for two reasons, both seen in an env-gated log of the app's renders and activation changes next to PresentMon's present times and the foreground window:
1. The harness's own ssh polling of the laptop started a PowerShell console that took the foreground; the app window was deactivated and reactivated, and `on_active_status_change` repaints it each time (2 to 3 presents per event, all within 200 ms of the foreground change).
2. The first-launch Models wizard sometimes closed around the fixed 25 s settle on this slow laptop (a present with a Models-screen render, then the Library a second later): launch work, not idle.
Unpolled diagnostic runs (original method) gave 0, 0, 0 presents; the one polled run in that series gave 2. The app has no idle redraw loop: no application code changed for N5.

- Also measured in the same hidden runs (not part of the N5/N6 claim): playing CPU 2.19, 1.75, 1.68 % (median 1.75), footprint 156, 147, 134 MiB, startup 12.1, 11.7, 11.8 s, song open 969, 1094, 1063 ms, `starvedBlocks` 0 on every lane over a 60 s burst; they agree with the table above within run-to-run spread. The empty-window static frame runs and the N14 installer were not repeated: the installer in the harness is the `492fb67d` one.
- The Electron figures in the gap table are from the earlier session and were not repeated.

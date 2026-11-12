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

- **Measured at 492fb67d, which predates 1706b685 (Bring paused CPU under 1% of one core) and d2bc946c (the Drive UI driver's empty-project expectation): N5 and N6 are pre-fix figures, to be re-measured at the tip.**
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
| N5 | Idle redraw | **fail** | [4, 5, 8] | n/a | Presented samples while idle, window on its launch screen 25 s after launch (presence count, clock-independent). A paused song and an open modal are not covered. Electron not measured. |
| N6 | Idle CPU | **fail** | 1.55 (worst 1.56) | 2.91 (worst 3.50) | Mean CPU over the 60 s pause phase, whole process tree; the song is paused, not unloaded. |
| N7 | Playing CPU | **pass** | 2.38 (worst 2.48) | 3.58 (worst 3.70) | Mean CPU over the 3-minute play phase, medians compared; target (half of Electron) not applied here. |
| N8 | GPU, Windows | **unvalidated** | {"static": {"appGpuPercent": 85.6, "dwmGpuPercent": 62.24, "dwmCpuPercent": 10.16, "appCpuPercent": 40.15}, "idle": {"appGpuPercent": 1.52, "dwmGpuPercent": 0.41, "dwmCpuPercent": 3.94, "appCpuPercent": 2.52}} | {"playing": {"appGpuPercent": 17.49, "dwmGpuPercent": 0.86, "dwmCpuPercent": 8.5, "appCpuPercent": 29.9}, "idle": {"appGpuPercent": 0, "dwmGpuPercent": 0.04, "dwmCpuPercent": 1.57, "appCpuPercent": 2.43}} | GPU and DWM share are measured in a visible window, but reference playback was not captured for both apps (the native visible scenario cannot open or play a song), so the shares shown are for the scenarios each app has and are diagnostic, not judged. |
| N9 | Memory | **pass** | 145.0 MiB (worst 157.0 MiB) | 473.0 MiB (worst 476.0 MiB) | Physical footprint of the process tree at the end of the 3-minute play phase. |
| N10 | Memory growth | **unvalidated** | -7.8 MiB, -118.9 MiB, -51.7 MiB | -17.0 MiB, -65.4 MiB, -39.9 MiB | Cycles alternate two songs, but neither app can close a project, so these are open/open cycles (closed = null in the receipts); the figures are measured, the budget is not judged. |
| N11 | Audio | **pass** | [0, 0, 0] | n/a | 60 s burst. |
| N12 | Startup | **pass** | 11703.00 ms (worst 11718.00 ms) | 13105.02 ms (worst 13115.38 ms) | Native: process spawn to interactive receipt. Electron: driver launch to library ready and welcome dismissed. Definitions are close, not identical. |
| N13 | Song open | **pass** | 1062.00 ms (worst 1063.00 ms) | 2391.00 ms (worst 2438.00 ms) | First open of the 5-minute reference song, hidden. |
| N14 | Package size | **pass** | 38.5 MiB | 102.5 MiB | Shipped installer sizes. Native is the NSIS installer built here, unsigned; Electron is the published release asset. |

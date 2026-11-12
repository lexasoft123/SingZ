# Q-02 native release baseline (Mac)

- App: native tip e40d24d0 at commit `e40d24d0`, build `release+ui-tests` (package profile `release`).
- Machine: Mac16,11 Apple M4 Pro, 14 cores, 48 GB, macOS 27.2 (model: Mac16,11, chip: Apple M4 Pro, cores: 14, memoryBytes: 51539607552, macOS: 27.2 (26B123)).
- 3 hidden runs per cell, plus visible runs where listed; reference: {"reference": "synthetic 5-minute reference; 12-minute cycle partner", "stemCount": 6, "durationS": 300, "lyricsPresent": true, "storedPitchLine": true}.

| Cell | Median | Worst | Runs |
|---|---|---|---|
| Idle CPU (N6), % of one core | 4.71 | 4.73 | 4.61, 4.73, 4.71 |
| Playing CPU (N7), % of one core | 6.15 | 6.19 | 6.15, 6.19, 6.10 |
| Steady footprint (N9) | 152.4 MiB | 154.2 MiB | 152.4 MiB, 154.2 MiB, 152.3 MiB |
| Startup (N12) | 269.13 ms | 1727.99 ms | 1727.99 ms, 249.66 ms, 269.13 ms |
| Song open (N13) | 187.14 ms | 193.85 ms | 193.85 ms, 157.58 ms, 187.14 ms |

Memory growth over the cycles phase (N10): 13.3 MiB (within noise), 18.2 MiB (within noise), -6.3 MiB (within noise). Rule: rise must stay within max(2.0 x residual stdev, 1% of steady footprint). Close exposed by the app: False.

Visible presented-frame runs (diagnostic, `frames_visible.py`):

- static: fps 60.00, p99 19.21 ms, dropped 0, samples 3599, unvalidated (handler-callback-time); fps 60.00, p99 18.93 ms, dropped 0, samples 3601, unvalidated (handler-callback-time); fps 60.00, p99 18.88 ms, dropped 0, samples 3599, unvalidated (handler-callback-time)
- idle: fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime); fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime); fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime)

Shipped package (N14): `SingZ-native.dmg`, 45,373,983 bytes (43.3 MiB), sha256 `69a355aa3899485d5f67cb47fb118a27aa01678596d72c66213f59d42a11bf66`

## Caveats

- Hidden runs use the release ui-tests build (cargo build --release --features ui-tests) with helpers built against the verified FFmpeg codec pack (a checksum-verified local snapshot of another worktree's darwin-arm64 pack; inspect passed), so codecs are the full matrix, not basic-only. Visible runs use the same binary.
- N14 native dmg comes from scripts/package-gpui-macos.py with a separate plain release build (no ui-tests), the same helpers, and llama-server and crispasr built here from the pinned refs; ad hoc signed, not notarized.
- The Mac was not idle: Chrome and Orca were running (1-minute load 4-7 on 14 cores) during the windows; no builds of ours ran.
- This Mac reports presentedTime 0, so presented timing is handler-callback based and stays unvalidated; visible runs cover an empty animating window (static, p99 about 19 ms against 16.7 ms is callback jitter, not a pass or fail) and an idle window, not reference playback. The 120 Hz probe is deferred: no panel.
- 120Hz: deferred until a 120 Hz panel exists; not failed
- windows: Windows legs are a separate task (see the summary)

## Gap to each budget, native against Electron

| # | Area | Status | Native | Electron | Note |
|---|---|---|---|---|---|
| N1 | Frame rate | **unvalidated** | 60.00 fps, p99 19.21 ms, 0 dropped; 60.00 fps, p99 18.93 ms, 0 dropped; 60.00 fps, p99 18.88 ms, 0 dropped | n/a | Reference-playback frames are not captured: the visible scenarios are an empty animating window (figures shown, diagnostic) and this Mac's presentedTime is 0, so timing is handler-callback-based. Electron has no macOS presented-frame capture. Re-run at 60 Hz on a display that fills presentedTime; the 120 Hz probe is deferred (no panel). |
| N2 | Frame time | **unvalidated** | 60.00 fps, p99 19.21 ms, 0 dropped; 60.00 fps, p99 18.93 ms, 0 dropped; 60.00 fps, p99 18.88 ms, 0 dropped | n/a | Reference-playback frames are not captured: the visible scenarios are an empty animating window (figures shown, diagnostic) and this Mac's presentedTime is 0, so timing is handler-callback-based. Electron has no macOS presented-frame capture. Re-run at 60 Hz on a display that fills presentedTime; the 120 Hz probe is deferred (no panel). |
| N3 | Dropped frames | **unvalidated** | 60.00 fps, p99 19.21 ms, 0 dropped; 60.00 fps, p99 18.93 ms, 0 dropped; 60.00 fps, p99 18.88 ms, 0 dropped | n/a | Reference-playback frames are not captured: the visible scenarios are an empty animating window (figures shown, diagnostic) and this Mac's presentedTime is 0, so timing is handler-callback-based. Electron has no macOS presented-frame capture. Re-run at 60 Hz on a display that fills presentedTime; the 120 Hz probe is deferred (no panel). |
| N4 | Input latency | **unvalidated** | n/a | n/a | No input-latency measurement exists in the harness. |
| N5 | Idle redraw | **pass** | [0, 0, 0] | n/a | Presented samples while idle, window on its launch screen 25 s after launch (presence count, clock-independent). A paused song and an open modal are not covered. Electron not measured. |
| N6 | Idle CPU | **fail** | 4.71 (worst 4.73) | 3.21 (worst 3.28) | Mean CPU over the 60 s pause phase, whole process tree; the song is paused, not unloaded. |
| N7 | Playing CPU | **pass** | 6.15 (worst 6.19) | 7.08 (worst 7.09) | Mean CPU over the 3-minute play phase, medians compared; target (half of Electron) not applied here. |
| N8 | GPU, Windows | **deferred** | n/a | n/a | Windows only: GPU and DWM share need the field laptop (PresentMon). |
| N9 | Memory | **pass** | 152.4 MiB (worst 154.2 MiB) | 844.7 MiB (worst 844.9 MiB) | Physical footprint of the process tree at the end of the 3-minute play phase. |
| N10 | Memory growth | **unvalidated** | 13.3 MiB, 18.2 MiB, -6.3 MiB | 133.3 MiB, -143.1 MiB, 70.6 MiB | Cycles alternate two songs, but neither app can close a project, so these are open/open cycles (closed = null in the receipts); the figures are measured, the budget is not judged. |
| N11 | Audio | **unvalidated** | [0, 0, 0] | n/a | Counters read 0 where measured, but the burst ran [5.1, 5.0, 5.0] s, not the 60 s of the budget; re-run with --burst 60. |
| N12 | Startup | **pass** | 269.13 ms (worst 1727.99 ms) | 862.64 ms (worst 2220.91 ms) | Native: process spawn to interactive receipt. Electron: driver launch to library ready and welcome dismissed. Definitions are close, not identical. |
| N13 | Song open | **pass** | 187.14 ms (worst 193.85 ms) | 1681.89 ms (worst 1682.95 ms) | First open of the 5-minute reference song, hidden. |
| N14 | Package size | **pass** | 43.3 MiB | 127.7 MiB | Shipped dmg sizes. Native is ad hoc signed and built locally; Electron is the published release asset. |

## Windows legs (separate task: the field laptop or the Dell)

1. Reserve the machine (`singz-dev` handbook: hosts, testing); mains power, display awake, nothing over the window.
2. Build Electron `v0.26.7` (`npm ci && npm run build`) and the native release `ui-tests` build with helpers against the codec pack; take the real v0.26.7 `SingZ-0.26.7-win-x64.exe` and the native installer for N14.
3. `node tests/perf/make_reference.cjs <fresh-dir>` per run; run `perf_harness.py --run-kind baseline` three times per app (hidden: CPU, memory, growth, startup, open), exactly as the Mac legs, then `baseline_aggregate.py`.
4. Visible runs: `experiments/gpui-player/tests/windows_gpu_sampler.ps1` (PresentMon 2.3.1+) for the process tree, three per app, merged with `--frames-json`; this also gives N8 (GPU and DWM share).
5. Write `Q-01-electron-baseline-windows.json` and `Q-02-native-baseline-windows.json` beside the Mac files; the Windows Electron figures are the reference for the Windows native gaps.


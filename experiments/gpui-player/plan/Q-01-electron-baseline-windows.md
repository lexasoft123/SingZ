# Q-01 Electron baseline (Windows)

- App: electron v0.26.7 at commit `2f0dd909`, build `electron-build-out` (package profile `release-nsis`).
- Machine: Dell XPS 15 9530 (Intel Core i7-4712HQ 4C/8T, 16 GiB, Intel HD 4600 + NVIDIA GT 750M, Windows 10 22H2 build 19045) (model: XPS 15 9530, cpu: Intel(R) Core(TM) i7-4712HQ CPU @ 2.30GHz, cores: 4 cores, 8 threads, memoryBytes: 17078218752, windows: 10.0.19045 build 19045, gpus: ['Intel(R) HD Graphics 4600 (driver 20.19.15.5058)', 'NVIDIA GeForce GT 750M (driver 25.21.14.2531)'], display: 3200x1800 @ 59 Hz).
- 3 hidden runs per cell, plus visible runs where listed; reference: {"reference": "synthetic 5-minute reference; 12-minute cycle partner", "stemCount": 6, "durationS": 300, "lyricsPresent": true, "storedPitchLine": true}.

| Cell | Median | Worst | Runs |
|---|---|---|---|
| Idle CPU (N6), % of one core | 2.91 | 3.50 | 3.50, 2.91, 1.67 |
| Playing CPU (N7), % of one core | 3.58 | 3.70 | 3.58, 3.19, 3.70 |
| Steady footprint (N9) | 473.0 MiB | 476.0 MiB | 476.0 MiB, 462.0 MiB, 473.0 MiB |
| Startup (N12) | 13105.02 ms | 13115.38 ms | 13115.38 ms, 13088.96 ms, 13105.02 ms |
| Song open (N13) | 2391.00 ms | 2438.00 ms | 2391.00 ms, 2375.00 ms, 2438.00 ms |

Memory growth over the cycles phase (N10): -17.0 MiB (within noise), -65.4 MiB (within noise), -39.9 MiB (within noise). Rule: rise must stay within max(2.0 x residual stdev, 1% of steady footprint). Close exposed by the app: False.

Visible presented-frame runs (PresentMon, `frames_visible_windows.py`):

- playing: fps 14.32, p99 133.35 ms, dropped 2729, samples 924, diagnostic (presentedTime), app GPU 16.86 %, DWM GPU 0.86 %; fps 14.26, p99 133.34 ms, dropped 2735, samples 924, diagnostic (presentedTime), app GPU 17.52 %, DWM GPU 0.73 %; fps 14.23, p99 133.32 ms, dropped 2737, samples 920, diagnostic (presentedTime), app GPU 17.49 %, DWM GPU 1.02 %
- idle: fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime), app GPU 0.00 %, DWM GPU 0.07 %; fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime), app GPU 0.00 %, DWM GPU 0.04 %; fps n/a, p99 n/a ms, dropped None, samples 0, pass (presentedTime), app GPU 0.00 %, DWM GPU 0.04 %

Shipped package (N14): `SingZ-0.26.7-win-x64.exe`, 107,443,347 bytes (102.5 MiB), sha256 `c49e45a8ac00e2650870294927de2f98453d99204b13816abf70ca61d5c4ee79`

## Caveats

- Electron runs launch the built out/ of tag v0.26.7 (2f0dd909, npm ci + npm run build + the win32-x64 capture addon) with Playwright and the Electron 43.2 binary, hidden, not the installed app; N14 uses the real published SingZ-0.26.7-win-x64.exe (downloaded from the GitHub release without credentials; size and sha512 match latest.yml).
- Electron plays through its native engine (the shipped Windows path), and the driver refuses to measure otherwise (SINGZ_PERF_REQUIRE_NATIVE). A first set of three runs played through Web Audio because the capture addon did not load (git missing from PATH and the wrong working directory inside the scheduled task); it was discarded and all Electron hidden and visible runs were redone.
- Windows CPU is the sum of per-process counter deltas over the process tree in a 5 s window per sample (tests/shared/win-process-sample.ps1); memory is the summed working set, which counts pages shared between Electron's processes once per process, so Electron's footprint is an upper bound against native's.
- Hidden runs use a 60 s burst (the Mac legs used 5 s); the Electron driver exposes no starvedBlocks. Interleaved with the native runs on an otherwise idle laptop (no builds or other workers), mains power, display 3200x1800 at 59 Hz.
- Visible runs (PresentMon 2.3.1, elevated one-off scheduled task, 60 s window): the Electron window while a song plays, and while idle on the song screen. Electron presents about 14 fps on this laptop's Intel HD 4600; the sampler's drop count assumes continuous demand at 60 Hz, so its dropped figures are the shortfall against 60 Hz, not stalls.
- 120Hz: deferred until a 120 Hz panel exists; not failed

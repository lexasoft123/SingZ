# Q-01 Electron baseline (Mac)

- App: electron v0.26.7 at commit `2f0dd909`, build `electron-build-out` (package profile `release-dmg`).
- Machine: Mac16,11 Apple M4 Pro, 14 cores, 48 GB, macOS 27.2 (model: Mac16,11, chip: Apple M4 Pro, cores: 14, memoryBytes: 51539607552, macOS: 27.2 (26B123)).
- 3 hidden runs per cell, plus visible runs where listed; reference: {"reference": "synthetic 5-minute reference; 12-minute cycle partner", "stemCount": 6, "durationS": 300, "lyricsPresent": true, "storedPitchLine": true}.

| Cell | Median | Worst | Runs |
|---|---|---|---|
| Idle CPU (N6), % of one core | 3.21 | 3.28 | 3.28, 3.21, 3.16 |
| Playing CPU (N7), % of one core | 7.08 | 7.09 | 7.09, 7.08, 7.03 |
| Steady footprint (N9) | 844.7 MiB | 844.9 MiB | 844.6 MiB, 844.7 MiB, 844.9 MiB |
| Startup (N12) | 862.64 ms | 2220.91 ms | 2220.91 ms, 862.64 ms, 859.82 ms |
| Song open (N13) | 1681.89 ms | 1682.95 ms | 1681.89 ms, 1682.95 ms, 1156.39 ms |

Memory growth over the cycles phase (N10): 133.3 MiB (within noise), -143.1 MiB (within noise), 70.6 MiB (within noise). Rule: rise must stay within max(2.0 x residual stdev, 1% of steady footprint). Close exposed by the app: False.

Presented frames: not measured for this app on this Mac (no macOS presented-frame capture exists for it).

Shipped package (N14): `SingZ-0.26.7-mac-arm64.dmg`, 133,912,066 bytes (127.7 MiB), sha256 `69e3e6af8e89401921a40307dd1905692a075648f36996473e59c6a7c42060a4`

## Caveats

- Electron runs launch the built out/ of tag v0.26.7 (2f0dd909, npm ci + npm run build) with the repository's Electron binary through Playwright, hidden, not the packaged .app; N14 uses the real published SingZ-0.26.7-mac-arm64.dmg (downloaded from the GitHub release without credentials).
- The Mac was not idle: Chrome and Orca were running (1-minute load 4-7 on 14 cores) during the windows; no builds of ours ran. Runs were interleaved electron/native.
- Presented frames are not measured for Electron (no macOS presented-frame capture). Both apps' cycles are open/open alternations: neither can close a project.
- 120Hz: deferred until a 120 Hz panel exists; not failed
- windows: Windows legs are a separate task (see the summary)

## Windows legs (separate task: the field laptop or the Dell)

1. Reserve the machine (`singz-dev` handbook: hosts, testing); mains power, display awake, nothing over the window.
2. Build Electron `v0.26.7` (`npm ci && npm run build`) and the native release `ui-tests` build with helpers against the codec pack; take the real v0.26.7 `SingZ-0.26.7-win-x64.exe` and the native installer for N14.
3. `node tests/perf/make_reference.cjs <fresh-dir>` per run; run `perf_harness.py --run-kind baseline` three times per app (hidden: CPU, memory, growth, startup, open), exactly as the Mac legs, then `baseline_aggregate.py`.
4. Visible runs: `experiments/gpui-player/tests/windows_gpu_sampler.ps1` (PresentMon 2.3.1+) for the process tree, three per app, merged with `--frames-json`; this also gives N8 (GPU and DWM share).
5. Write `Q-01-electron-baseline-windows.json` and `Q-02-native-baseline-windows.json` beside the Mac files; the Windows Electron figures are the reference for the Windows native gaps.


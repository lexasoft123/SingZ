# Performance harness (in progress)

The common runner can communicate with the Electron and GPUI ui-test drivers
through a fresh `--control-dir`. It sends one action at a time and requires a
matching JSON completion receipt. `stage_fixture.cjs` copies the bundled sample
into a fresh, isolated two-project library; it prints paths and source details.
All automated launches must be muted and hidden.

Both real apps have been exercised in a shortened hidden Mac smoke run. Windows
sampling and DWM accounting have unit coverage but still require a real Windows
run. Catalog navigation retains a project until another open in both apps; this
is recorded as an unavailable close/unload in the cycle receipt.
The current native helper does not expose `starvedBlocks`; unavailable lane
values are null with a reason. The presented-frame slots (`fps`,
`frameTimeMs`, `dropped`) are filled by C-07 (below); a hidden run reports them
null with the reason "hidden window presents no frames", never zero.
The bundled sample lasts 40.8 seconds and has
six stems and lyrics, but does not have a stored pitch line. It is a smoke
fixture, not the five-minute baseline song.
Do not promote a smoke run to a Q-01/Q-02 baseline.

Run local checks with:

```
python3.13 -m unittest discover -s tests/perf -p 'test_*.py'
node --check tests/perf/electron_driver.cjs
```

For baseline runs, generate the reference library with
`node tests/perf/make_reference.cjs <fresh-dir>`: two synthesized six-stem
projects (300 s and 720 s) with timed lyrics, a pitch line, and analysis stamps
read from the current zCore detector versions, so no run re-analyses. Its JSON
has the same shape as `stage_fixture.cjs`. `python3 -m unittest
tests/perf/test_reference_fixture.py` checks it (needs `ffprobe`).

Stage a fresh library with `node tests/perf/stage_fixture.cjs <fresh-dir>`;
the JSON it prints contains the two project paths, their names, and the sample
description. Point `--reference-json` at a file containing that JSON. Each run
also needs a fresh `--control-dir`, an actual installer or archive in
`--package`, and the four identity fields `--profile`, `--display hidden`,
`--machine`, and `--commit`.

For Electron, set `SINGZ_USERDATA_DIR` to the staged `prefs` directory and
`SINGZ_PERF_SONGS` to the JSON array of staged project names; run the common
runner with `--app electron --command 'node tests/perf/electron_driver.cjs'`.
For native, set `SINGZ_GPUI_CONFIG_DIR`, `SINGZ_GPUI_PROJECTS_ROOT`,
`SINGZ_GPUI_TEST_PROJECT`, and `SINGZ_GPUI_PERF_SECOND_PROJECT` to isolated
staged paths, and point `--command` at the release `ui-tests` executable and
`SINGZ_GPUI_AUDIO_HELPER` and `SINGZ_GPUI_ANALYZER` at the matching native helpers. Use
`--profile release+ui-tests`. Both apps use `--play`, `--burst`, `--pause`,
`--cycles`, and `--cycle-duration` to configure the scenario. `--run-kind
smoke` marks development smoke results with the coordinator's requested owner
and non-baseline reservation note.

## Baselines (Q-01 / Q-02)

`--run-kind baseline` marks a G0 baseline run. It refuses a shortened scenario (play >= 180 s,
pause >= 60 s, cycles >= 20), needs the control driver and `--package-profile`, and `--package` should
be the shipped installer. Run it three times per app on the same Mac, plus three visible
`frames_visible.py` runs per scenario (native), then:

```
python3 tests/perf/baseline_aggregate.py --app electron --tag v0.26.7 --runs e1.json e2.json e3.json \
    --shipped-package SingZ-0.26.7-mac-arm64.dmg --collect-identity \
    --out-json experiments/gpui-player/plan/Q-01-electron-baseline.json --out-md experiments/gpui-player/plan/Q-01-electron-baseline.md
python3 tests/perf/baseline_aggregate.py --app native --runs n1.json n2.json n3.json --frames static-*.json idle-*.json \
    --shipped-package SingZ.dmg --electron-baseline .../Q-01-electron-baseline.json --collect-identity \
    --out-json .../Q-02-native-baseline.json --out-md .../Q-02-native-baseline.md
```

Median and worst per cell; the native file adds the verdict for each budget N1-N14 against the
Electron file (`pass`, `fail`, `unvalidated`, `deferred`). N11 is judged only after a 60 s burst
(`--burst 60`); N10 stays unvalidated while neither app can close a project.

## Presented frames (C-07)

`metrics.frames` is either all null with a `reason`, or all measured:
`fps` = (n-1) / (last - first presented time); `frameTimeMs` = `{p50, p99, max,
periodMs}` of successive presented-time deltas; `dropped` = frames missed while an
animation source demanded frames, plus drawables that were never shown (D-02 5.2).
Frame rate is gated at the panel's current rate (60 Hz for now). The 120 Hz run is
**deferred** until a 120 Hz panel exists; record it as deferred, not failed.

**macOS** — the `ui-tests` build records every presented drawable through the
present observer in vendored `gpui-pre-apple` (`MTLDrawable.addPresentedHandler`,
see `experiments/gpui-player/vendor-patches` and `PRESENT_OBSERVER.md`). The common
runner asks the native scenario for a `frames` start/stop around the play phase; as
the runner is hidden, those runs report null with the hidden reason. Visible runs
use `frames_visible.py` (a window appears; muted; mains power; Low Power Mode off;
nothing over the window; unfit environments are rejected):

```
python3 tests/perf/frames_visible.py --binary experiments/gpui-player/target/debug/singz-gpui-player \
    --scenario static --seconds 60 --out out/frames-static.json
```

Verdicts (`gate`): `pass`, `fail`, `inconclusive` (failed while the machine was busy;
retried), `unvalidated`, `diagnostic`. Timing scenarios (`static`, `stall`) are gated on
real `presentedTime` only. Some displays never fill it (this Mac: every drawable reports 0,
even in a bare AppKit window, with or without `presentsWithTransaction`, display sync off,
or timed presents), so those runs use the handler callback clock, are labelled
`timeSource: handler-callback-time`, and are **unvalidated**: figures are diagnostic, not a
presented-timing pass. Presence-count scenarios (`idle`, `notify100`) do not depend on the
clock. `static` also gates frame-time p99 <= 1002/Hz ms (16.7 ms at 60 Hz). `stall` checks
drops against the number of stalls actually injected (`stallsInjected`). `launch` is an
ungated early capture from the moment the window is up, with app-state probes; the idle
gate starts 25 s after launch and does not cover that period (a fresh config sits on the
auto-opened Models screen, presenting ~50/s, for 11-30 s).

Scenarios: `static` (panel rate within 1%, 0 dropped), `stall` (control: 25 ms stall
every 60th frame, at least 1 dropped per second), `idle` (0 samples), `notify100`
(control: a 100 ms repeating notify, about 600 samples in 60 s).
TODO: the ScreenCaptureKit cross-check needs Screen Recording permission for the
runner; not implemented (see `PRESENT_OBSERVER.md`).

**Windows** — `experiments/gpui-player/tests/windows_gpu_sampler.ps1` wraps
PresentMon for a named process tree and writes per-frame present times, fps,
frame-time p50/p99/max, dropped, GPU use per adapter (by LUID) and the DWM share:

```
powershell -NoProfile -ExecutionPolicy Bypass -File experiments\gpui-player\tests\windows_gpu_sampler.ps1 `
  -ProcessName singz-gpui-player -Seconds 60 -ExpectedHz 60 -CaptureOut out\frames-win.json
python tests/perf/perf_harness.py ... --frames-json out/frames-win.json   # merge into the C-06 report
```

Prerequisites: **PresentMon 2.3.1 or newer** (console app, x64), downloaded from
`https://github.com/GameTechDev/PresentMon/releases/download/v2.3.1/PresentMon-2.3.1-x64.exe`;
put it on `PATH` as `PresentMon.exe`, or pass `-PresentMon <path>` or set
`SINGZ_PRESENTMON`. Run from an elevated prompt or as a member of "Performance Log
Users". Windows PowerShell 5.1 is enough. The app must be running, visible,
unoccluded and on mains power (use `-Hidden` for a hidden run: frames are null with
the hidden reason). `-ExpectedHz` fixes the period used for dropped frames (default:
the median present delta); the sampler assumes continuous animation demand, so use
it on a static animation or playback, or pass `-NoDemand` to skip drop accounting.
The legacy poll mode (`-App -Flag -Out`, used by `run_windows_ui.ps1`) is unchanged.
Presented time is `CPUStartTime + DisplayLatency` from the PresentMon 2.x CSV;
frames with no display time count as dropped. Not yet run on a Windows machine. `windows_gpu_sampler_csv_test.ps1` checks the frame statistics on synthetic CSVs (skipped frame counted once); also unrun.

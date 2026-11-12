# Q-11 full native run, Windows field laptop

- **Measured at `492fb67d`, before `1706b685` (paused CPU) and `d2bc946c` (the Drive UI driver's empty-project expectation). The six failures below are pre-fix results, to be rerun at the tip.**
- App: the release `ui-tests` build of commit `492fb67d` (`cargo build --release --locked --features ui-tests`, helpers against the FFmpeg codec pack), the same binary as the Q-02 Windows baseline.
- Machine: the Windows field laptop of the Q-01/Q-02 Windows files. **It runs Windows 10 22H2 (build 19045), not Windows 11**; display 3200x1800 at 59 Hz, Intel HD 4600 + NVIDIA GT 750M, real WASAPI.
- Each case ran through `tests/run_windows_ui.ps1` in the logged-in session (one-off `schtasks /it` task, deleted afterwards), a new `-Out` per attempt, with a no-admin venv (`pillow`, `comtypes`) because the system Python lacks Pillow. Every failing case was repeated once.
- Run time: 8 to 90 s per case; the whole 20-case loop took under 10 minutes.

| Case | Driver | Result | Reason |
|---|---|---|---|
| key | test_native_project_key_ui.py | **pass** | |
| graph | test_native_graph_ui.py | **pass** | the first loop failed with `No module named 'PIL'` (venv fixed it) |
| drive | test_native_drive_ui.py | **fail** (2 of 2) | `Drive wait timeout`: the Broken-graph and empty projects never reach `ProjectState::Blocked` (`drive_snapshot.busy` false, revision 121). App state, not harness: not isolated further. |
| drive-retirement | test_native_drive_retirement.py | **pass** after a harness fix | Before: the sidecar's `journals()` read a journal file the app had retired between `rglob` and `read_text` (`FileNotFoundError`; a sharing violation raises `PermissionError`) in 2 of 2 runs. Fixed in the test (see below); then one run was stopped by the runner's foreground guard (environment) and the next passed in 85 s. |
| drive-empty | test_native_empty_drive.py | **fail** (2 of 2) | `Empty Drive timeout !p.drive_projects_open&&!p.loading&&empty(p)` (Drive revision 4, signed in, not busy). App state: not isolated. |
| adoption | test_native_drive_adoption_ui.py | **pass** | |
| provider | test_native_audio_provider_ui.py | **fail** (2 of 2) | First attempt: runner `run_windows_ui.ps1:170` dereferenced a null `StartTime` (a process exited between enumeration and read; runner race). Second: `Provider timeout !p.loading&&p.notice.is_some()` with provider `asio` selected on win32 (default `wasapi`). The driver's expectation for a non-default provider on Windows is unverified; not isolated. |
| title | test_native_title.py | **fail** (2 of 2) | `Title state timed out: !p.loading&&p.rename_pending.is_none()&&song_title=="Z renamed song"`: the playing-project rename never completes. A Windows file-in-use rename is a candidate cause; **unverified**. |
| import | test_native_library_import.py | **fail** (2 of 2) | `Import timeout: p.library_import_open` stays false (the log also lists "Splitter candidate demucs could not start", which is the app probing for engines). Not isolated. |
| delete | test_native_project_delete.py | **fail** (2 of 2) | `Native delete wait timeout p.screen==Screen::Library`: the delete dialog never opens (`dialog.open` false, `deletePending` null) and the screen stays on the Player. Not isolated. |
| recording | test_native_training_recording.py | **pass** | |
| recording-publication | test_native_recording_publication_recovery.py | **pass** | |
| recording-publication-helper | same, `--helper-stage` | **pass** | |
| recording-recovery | test_native_training_recording_recovery.py | **pass** | |
| training-input-cue | test_native_training_input_recovery.py | **pass** on the second attempt | First: the runner's `Foreground window changed during verification` guard fired (something took the foreground on the laptop); not the app. |
| training-input-completing | same, `--completing` | **pass** | |
| training-output | test_native_training_recovery.py | **pass** | |
| training-output-standalone | same | **pass** | |
| training-output-song | same, `--song-backed` | **pass** | |
| training-run | test_native_training_run.py | **pass** | |

13 of 20 cases pass without a code change, `drive-retirement` passes with the harness fix (14 of 20), and 6 fail on both attempts: drive, drive-empty, provider, title, import, delete. None of the six was a missing dependency once the venv existed. They are reported, not fixed: they stop at app state the driver waits for, and I did not change app code. The cause of each is **not established**; the sentences above that name a candidate are hypotheses.

## Not run

- `test_native_accessibility_windows.py` (C-61): needs a **debug** `ui-tests` build and a venv with `comtypes`; only the release build was made here. The venv now has `comtypes`; the debug build was not made.
- `test_native_updater.py` Windows leg: not a `run_windows_ui.ps1` case, run by hand when the updater changes; not run.
- The performance rows the lane mentions (`windows_gpu_sampler.ps1` into `perf_harness.py --frames-json`) are the Q-01/Q-02 Windows legs, not repeated here.

## Electron control

The lane's control is `tests/e2e/mac/player-session-e2e.cjs` of the Electron tree on the same machine (`PS_LIB` staged, `ALLOW_BUSY_HOST=1`, interactive session). **It did not run to a result**: against the v0.26.7 tree it stopped on the first attempt at its warm-up because the app's welcome overlay intercepts the driver's clicks (the tag's driver never dismisses it). With that overlay pre-dismissed in a disposable copy of the driver inside the Dell's tree (not the repository), all three attempts (both passes, then `--pass native`) died in the pass launch with `HARNESS FAIL electronApplication.evaluate: Resulting promise was garbage collected` at `quietLaunch`, the app going away at launch. `PS_LIB` was the synthetic reference library, because the seeded sample library the driver normally stages is not in the repository. Not isolated.

What does serve as an Electron control on this machine is the Q-01 Windows file: the same v0.26.7 tree driven by `electron_driver.cjs`, three hidden and three visible runs, on the native engine (the driver refuses to measure otherwise).

## Harness changes made for this run

- `test_native_drive_retirement.py`: `journals()` now skips a journal that disappears or is locked between the listing and the read (`FileNotFoundError`, `PermissionError`), the same race the existing `ValueError` clause already tolerates. No assertion, deadline or timeout changed; a missing journal is simply not a candidate, and the test still requires its candidates. Evidence: 2 of 2 failing runs before (`FileNotFoundError` in `sidecar-failure.txt`), a pass after.
- `windows_gpu_sampler.ps1`: reads PresentMon 2.3.1's CSV layout; an idle capture with no CSV after a clean exit is zero presents.
- `tests/perf`: see `tests/perf/README.md`, "Windows legs".

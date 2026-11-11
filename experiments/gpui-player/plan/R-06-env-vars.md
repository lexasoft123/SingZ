# R-06: Environment variables read by the production binary

Baseline: commit `f7607311` (`codex/gpui-interface`). All `path:line` citations are at that commit, taken from `git grep` / `git show f7607311:…`. The working tree is dirty (`experiments/gpui-player/src/main.rs` gains a 3-line `ui-tests` marker at the top, `Cargo.toml` changes the `singz-uikit` source and adds `[profile.release]`), so working-tree line numbers differ by about +3 in `main.rs`. Those changes are not cited.

Class key: **operator** = intended runtime setting; **fixture** = swaps in fake data or state; **test gate** = drives a test path; **dangerous in release** = reachable in a shipped build and changes data, identity, network source or executed code. Anything marked *(inferred)* was not read directly.

## 1. Reads compiled into the default binary (no `ui-tests` feature)

| Name | Reader (base) | Purpose | Class |
|---|---|---|---|
| `SINGZ_GDRIVE_CONFIG` | `src/drive_auth.rs:68` (`from_env_or`), `from_override_or` at `:70`; called from `src/drive_service.rs:62`, `src/drive_restore_service.rs:61` | Replaces the baked Drive OAuth application config (`OUT_DIR/drive-config.json`) with the env JSON whenever the variable is present | dangerous in release |
| `SINGZ_GPUI_DEMO` | `src/integration.rs:341` (`fixture_mode`); `src/main.rs:1294` skips the native backend when set; `src/library.rs:252,289,298`, `src/header.rs:268` and later | Forces demo/fixture mode | fixture, dangerous in release |
| (key scan) | `src/integration.rs:342-347` | Any env key starting `SINGZ_GPUI_` that contains `REVIEW`, `SMOKE`, `BENCHMARK`, `PROFILE` or `CAPTURE_FILE` also forces fixture mode, so `SINGZ_GPUI_PROFILE` and `SINGZ_GPUI_CAPTURE_FILE` flip it too | fixture, dangerous in release |
| `SINGZ_GPUI_PROFILE` | `src/main.rs:1429` (`screen` = Player), `:1436` (`loaded_song`), `:1580` (`playing`), `:4470` (frame stats) | Opens straight into a loaded, playing Player | fixture, dangerous in release |
| `SINGZ_GPUI_CAPTURE_FILE` | `src/main.rs:1628` (stored); read at `:5524` | Each frame reads a file and sets the playback position from its text (deterministic capture) | test gate, dangerous in release |
| `SINGZ_GPUI_OFFSCREEN_BENCHMARK` | `src/main.rs:4471` (frame-stat flag only). The benchmark run is `#[cfg(ui-tests)]` at `:6494` | Enables frame stats in release; the run itself is test-only | test gate (partly ungated) |
| `SINGZ_GPUI_BACKGROUND` | `src/desktop_lifecycle.rs:93`; `src/main.rs:3363` (skips model auto-check), `:3374` (skips quick start), `:6178` (no activation); `src/locale_service.rs:44` | Hidden/background launch | operator (hidden launch) |
| `SINGZ_E2E_HIDDEN` | `src/locale_service.rs:43` | Hidden locale service, same effect as `SINGZ_GPUI_BACKGROUND` | test gate |
| `SINGZ_LANG` | `src/locale_service.rs:42` | UI language override | operator |
| `SINGZ_GPUI_TEST_NO_CAPTURE` | `src/main.rs:3419` (ungated read; the `:6277-6301` reads are gated) | Suppresses settings-screen capture | test gate |
| `SINGZ_MUTE` (C++ only) | `tools/native/singz-gpui-audio.cpp:624` (any value mutes); `tools/native/singz-gpui-input.cpp:63` (fixture/fake/paused modes refuse unless set), `:124` | Mute switch in the shipped helpers | test gate |
| `SINGZ_GPUI_AUDIO_HELPER` | `src/main.rs:1297`; `src/integration.rs:1692`; `src/audio_devices.rs:177` (`helper()`); `src/beat_analysis.rs:607`; `src/lyrics_align.rs:861` (`prepare_pcm`); `src/project_key.rs:192` (`run`) | Path of the `singz-gpui-audio` helper that is then spawned | operator (executes override) |
| `SINGZ_GPUI_INPUT_HELPER` | `src/microphone.rs:764` (`Session::open`) | Path of the `singz-gpui-input` helper that is then spawned | operator (executes override) |
| `SINGZ_GPUI_PITCH_MODEL` | `src/microphone.rs:771` | Pitch model path passed to the input helper | operator |
| `SINGZ_GPUI_ANALYZER` | `src/analyze_provenance.rs:100` (`resolve`) | Analyzer path override; the path is then checked at `:51` against the build-time hash (`:126`) | operator (executes override) |
| `SINGZ_LLAMA_SERVER` | `src/lyrics_align.rs:265` (`resolve_engine`); callers `:304`, `:1103` | Path of the `llama-server` engine | operator (executes override) |
| `SINGZ_CRISPASR` | `src/lyrics_align.rs:265` (`resolve_engine`); callers `:307`, `:474`, `:1572` | Path of the `crispasr` engine | operator (executes override) |
| `SINGZ_DEMUCS` | `src/engine_status.rs:95` | Overrides the Demucs command | operator (executes override) |
| `SINGZ_NO_SYSTEM_ENGINES` | `src/engine_status.rs:96` | Disables system-installed engines | operator |
| `SINGZ_GPUI_CONFIG_DIR` | `src/audio_devices.rs:331` (`directory()`, app-wide); `src/model_catalog.rs:121` | Relocates app config and state | operator |
| `SINGZ_GPUI_PROJECTS_ROOT` | `src/project_library.rs:43` | Library root override | operator |
| `SINGZ_MODELS_DIR` | `src/model_catalog.rs:129` | Models directory override | operator |
| `SINGZ_PACK_DIR` | `src/model_catalog.rs:132` | GPU splitter pack directory override | operator |
| `SINGZ_GPU_PACK_URL` | `src/model_catalog.rs:183` | Download URL of the `gpu-splitter` pack | operator, dangerous in release (download source) *(inferred risk)* |
| `SINGZ_NO_SYNC` | `src/drive_service.rs:294` (`enabled`) | Disables Drive sync | operator |

Runtime OS environment (not SINGZ names): `PATH` (`src/engine_status.rs:94`), `HOME`/`USERPROFILE` (`src/model_catalog.rs:107`, `src/engine_status.rs:89`), `APPDATA` (`src/audio_devices.rs:340`, `src/model_catalog.rs:113`), `XDG_CONFIG_HOME` (`src/audio_devices.rs:345`, `src/model_catalog.rs:117`), `OneDrive` (`src/project_library.rs:44`), `LANGUAGE` (`src/locale_service.rs:340`).

Build-time only (not read at runtime): `CARGO_MANIFEST_DIR` (`build.rs:9,20`), `OUT_DIR` (`build.rs:15,33`), `CARGO_PKG_VERSION` (`src/main.rs:3991`, `src/native_build_info.rs:19`). `SINGZ_EXPECTED_ANALYZE_SOURCE_HASH` is set by `build.rs:87,89` through `cargo:rustc-env` and read with `option_env!` at `src/analyze_provenance.rs:126`.

Test-only reads that are outside the default binary: `SINGZ_FILE_LEASE_CHILD_PATH` (`src/file_lease.rs:165,189`, inside `#[cfg(test)] mod portable_tests` at `:78`); `SINGZ_GPUI_BEAT_REAL_PROJECT|OUT|DURATION` (`src/beat_analysis.rs:910,914,917`, inside `#[cfg(test)] mod tests` at `:755`); `SINGZ_GPUI_LYRICS_REAL_DURATION`, `SINGZ_CRISPASR`, `SINGZ_LLAMA_SERVER`, `SINGZ_MODELS_DIR`, `SINGZ_PACK_DIR` (`src/lyrics_align_tests.rs:258-264`, included under `#[cfg(test)]` at `src/lyrics_align.rs:1908-1909`); `SINGZ_GDRIVE_CONFIG` (`build_config.rs:225`, inside `#[cfg(test)]` at `:136`); `PATH` (`src/source_jobs.rs:2062`, inside `#[cfg(unix)] #[test]` at `:2029-2030`).

## 2. Gated test and fixture names (compiled only with `--features ui-tests`)

`ui-tests = ["dep:gpui_linux_capture"]` is the only feature in `experiments/gpui-player/Cargo.toml:8`. There is no `default =` line, so the feature is off unless a build passes it. On Linux it also pulls the optional dependency at `Cargo.toml:56`.

Gating patterns used by the readers:

- Whole module: `src/main.rs` declares all 70 `ui_*` modules behind `#[cfg(feature="ui-tests")]`.
- Whole function: `#[cfg(feature="ui-tests")]` directly above the `fn` item. Examples: `src/microphone.rs:323-324` (`owned_recording`), `src/model_service.rs:243` (`config`, gated inside its body at `:244`).
- Statement or block: `#[cfg(feature="ui-tests")]` above an `if`/block. Examples: `src/drive_host.rs:12-13`, `:44-48`; `src/custom_tracks_host.rs:215-224`; `src/engine_status.rs:101-102`; `src/integration.rs:2787-2790`, `:2799-2802`.
- Gate helpers that compile in but read nothing: `src/diagnostics.rs:829-836` (`test_gate`); `src/project_import.rs:342-351` (`force_copy_move`) and `:352-` (`test_gate`); `src/training_recording_store.rs:585-587`; `src/project_delete.rs:639-654`; `src/stem_export.rs:580-582` (whole fn). Their call sites (for example `src/project_import.rs:244,291`, `src/integration.rs:2756`, `src/diagnostics.rs:259,264`) do compile in the default build but read no environment there.

Rust reads of `SINGZ_MUTE` that I checked are all in gated blocks (for example `src/project_delete.rs:651`, `src/model_service.rs:249`, `src/diagnostics.rs:834`, `src/main.rs:6183-6485`). `src/integration.rs:975,982` were checked by look-back only *(inferred)*. The C++ reads in section 1 are ungated.

`SINGZ_GPUI_LRCLIB_URL` (`src/integration.rs:627`) is gated by `#[cfg(any(test,feature="ui-tests"))]` at `:626`, so it is not a feature-only name.

Full list of gated names, with every reader site at base (`*TEST*` and `*GATE*` names first in order, then the rest; `SINGZ_GPUI_CAPTURE_FIXTURE` and `SINGZ_GPUI_TEST_PROJECT` are the most-used). Mixed names (gated in some places, ungated elsewhere) are already listed in section 1 and are excluded here. Sites are `path:line` at `f7607311`:

| Name | Sites (base) | Class |
|---|---|---|
| `SINGZ_GPUI_ACCESSIBILITY_TEST` | `src/main.rs:6202` | test gate |
| `SINGZ_GPUI_AUDIO_PROVIDER_TEST` | `src/main.rs:6281` | test gate |
| `SINGZ_GPUI_DESKTOP_LIFECYCLE_TEST` | `src/main.rs:6182` | test gate |
| `SINGZ_GPUI_WHATS_NEW_TEST` | `src/main.rs:806`, `:2432`, `:6247` | test gate |
| `SINGZ_GPUI_ENGINE_SETUP_TEST` | `src/main.rs:824`, `:6197` | test gate |
| `SINGZ_GPUI_DRIVE_TEST` | `src/drive_host.rs:13`, `:45`; `src/main.rs:6419` | test gate |
| `SINGZ_GPUI_DRIVE_RESTORE_TEST` | `src/drive_host.rs:46`; `src/main.rs:6275` | test gate |
| `SINGZ_GPUI_DRIVE_RETIREMENT_TEST` | `src/drive_host.rs:48`; `src/main.rs:6293` | test gate |
| `SINGZ_GPUI_EMPTY_DRIVE_TEST` | `src/drive_host.rs:47`; `src/main.rs:6287` | test gate |
| `SINGZ_GPUI_EMPTY_PROJECT_TEST` | `src/custom_tracks_host.rs:216`; `src/main.rs:5795`, `:6389` | test gate |
| `SINGZ_GPUI_CUSTOM_TRACK_TEST` | `src/custom_tracks_host.rs:223`; `src/main.rs:6394` | test gate |
| `SINGZ_GPUI_CUSTOM_TRACK_FILES` | `src/custom_tracks_host.rs:224` | fixture |
| `SINGZ_GPUI_CARRY_TEST` | `src/integration.rs:2800`; `src/main.rs:6379` | test gate |
| `SINGZ_GPUI_CARRY_GATE` | `src/integration.rs:2801`; `src/ui_carry_line.rs:105`, `:160` | test gate |
| `SINGZ_GPUI_IMPORT_PREPARE_GATE` | `src/project_import.rs:244` (via `test_gate`) | test gate |
| `SINGZ_GPUI_IMPORT_REMOVE_GATE` | `src/project_import.rs:291` (via `test_gate`) | test gate |
| `SINGZ_GPUI_IMPORT_RECEIPT_GATE` | `src/integration.rs:2756` (via `test_gate`) | test gate |
| `SINGZ_GPUI_IMPORT_OLD_STATUS_GATE` | `src/integration.rs:1918` | test gate |
| `SINGZ_GPUI_IMPORT_FORCE_COPY_MOVE` | `src/project_import.rs:345` | test control |
| `SINGZ_GPUI_SPLIT_LOAD_GATE` | `src/integration.rs:2555`; `src/ui_source.rs:65` | test gate |
| `SINGZ_GPUI_SOURCE_SAVE_PREPARE_GATE` | `src/source_jobs.rs:1408`; `src/ui_lyrics_sidebar.rs:394` | test gate |
| `SINGZ_GPUI_SOURCE_TEST` | `src/main.rs:6260` | test gate |
| `SINGZ_GPUI_DELETE_PREPARE_GATE` | `src/project_delete.rs:643`; `src/ui_project_delete.rs:135` | test gate |
| `SINGZ_GPUI_DELETE_HIDDEN_GATE` | `src/project_delete.rs:644` | test gate |
| `SINGZ_GPUI_DELETE_COMMIT_GATE` | `src/project_delete.rs:645` | test gate |
| `SINGZ_GPUI_PROJECT_DELETE_TEST` | `src/main.rs:6399` | test gate |
| `SINGZ_GPUI_PICKER_MOVE_GATE` | `src/project_library.rs:855` | test gate |
| `SINGZ_GPUI_PICKER_CHOOSE_ROOT` | `src/main.rs:2360` | test control |
| `SINGZ_GPUI_DIAGNOSTICS_READ_GATE` | `src/diagnostics.rs:259`; `src/ui_diagnostics.rs:123` | test gate |
| `SINGZ_GPUI_DIAGNOSTICS_SAVE_GATE` | `src/diagnostics.rs:264`; `src/ui_diagnostics.rs:124` | test gate |
| `SINGZ_GPUI_DIAGNOSTICS_TEST` | `src/diagnostics_host.rs:121`; `src/main.rs:6192` | test gate |
| `SINGZ_GPUI_TRAINING_RECORDING_EXPORT_GATE` | `src/training_recording_store.rs:587` | test gate |
| `SINGZ_GPUI_TRAINING_RECORDING_TEST` | `src/training_recording_host.rs:194`; `src/main.rs:6355` | test gate |
| `SINGZ_GPUI_TRAINING_RECORDING_RECOVERY_TEST` | `src/training_recording_host.rs:195`; `src/main.rs:6360` | test gate |
| `SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_TEST` | `src/training_recording_host.rs:196`; `src/main.rs:6367` | test gate |
| `SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_STAGE` | `src/ui_recording_publication_recovery.rs:73`, `:117` | test control |
| `SINGZ_GPUI_STEM_EXPORT_TEST` | `src/stem_export.rs:582`; `src/stem_export_host.rs:65`; `src/main.rs:6384` | test gate |
| `SINGZ_GPUI_STEM_EXPORT_GATE` | `src/stem_export.rs:585`; `src/ui_stem_export.rs:140` | test gate |
| `SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE` | `src/integration.rs:2660`; `src/ui_lyrics_editor.rs:518`, `:551`; `src/ui_lyrics_sidebar.rs:449`, `:591` | test gate |
| `SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE` | `src/integration.rs:649`; `src/ui_lyrics_sidebar.rs:356`, `:449`, `:591` | test gate |
| `SINGZ_GPUI_RATE_RECEIPT_GATE` | `src/integration.rs:2788`; `src/ui_transport_timing.rs:124`, `:210` | test gate |
| `SINGZ_GPUI_TRANSPORT_TIMING_TEST` | `src/integration.rs:2788`; `src/main.rs:6374` | test gate |
| `SINGZ_GPUI_LYRICS_ALIGN_TEST` | `src/main.rs:6232`; `src/ui_lyrics_sidebar.rs:452`, `:592` | test gate |
| `SINGZ_GPUI_LYRICS_SIDEBAR_TEST` | `src/main.rs:6242` | test gate |
| `SINGZ_GPUI_LYRICS_EDITOR_TEST` | `src/main.rs:6217` | test gate |
| `SINGZ_GPUI_LYRICS_REVIEW` | `src/main.rs:6479` | test gate |
| `SINGZ_GPUI_LYRICS_SCROLL_TEST` | `src/main.rs:6484` | test gate |
| `SINGZ_GPUI_LOG_REVIEW` | `src/main.rs:6474` | test gate |
| `SINGZ_GPUI_LOCALE_TEST` | `src/main.rs:6414` | test gate |
| `SINGZ_GPUI_LOCALE_TEST_PERSIST` | `src/locale_service.rs:49` | test control |
| `SINGZ_GPUI_LIBRARY_IMPORT_TEST` | `src/main.rs:6222` | test gate |
| `SINGZ_GPUI_PROJECT_PICKER_TEST` | `src/main.rs:6227` | test gate |
| `SINGZ_GPUI_MONITOR_TEST` | `src/main.rs:6424` | test gate |
| `SINGZ_GPUI_MONITOR_PUBLICATION_TEST` | `src/main.rs:6429` | test gate |
| `SINGZ_GPUI_MICROPHONE_TEST` | `src/main.rs:6434` | test gate |
| `SINGZ_GPUI_MODELS_TEST` | `src/main.rs:6265` | test gate |
| `SINGZ_GPUI_MIGRATION_TEST` | `src/main.rs:6257` | test gate |
| `SINGZ_GPUI_METRONOME_TEST` | `src/main.rs:6212` | test gate |
| `SINGZ_GPUI_MODAL_BACKDROP_REVIEW` | `src/main.rs:6454` | test gate |
| `SINGZ_GPUI_NATIVE_LYRICS` | `src/main.rs:6449` | test control |
| `SINGZ_GPUI_INTEGRATION_TEST` | `src/main.rs:6459` | test gate |
| `SINGZ_GPUI_UI_SMOKE` | `src/main.rs:6464` | test gate |
| `SINGZ_GPUI_REVIEW_CAPTURE` | `src/main.rs:6469` | test gate |
| `SINGZ_GPUI_LIBRARY_REVIEW` | `src/main.rs:6489` | test gate |
| `SINGZ_GPUI_PLAYBACK_GRAPH_TEST` | `src/main.rs:6299` | test gate |
| `SINGZ_GPUI_PITCH_LABEL_TEST` | `src/ui_lyrics_align.rs:501` | test gate |
| `SINGZ_GPUI_TITLE_TEST` | `src/main.rs:6252` | test gate |
| `SINGZ_GPUI_TRAINING_AUDIO_TEST` | `src/main.rs:6404` | test gate |
| `SINGZ_GPUI_TRAINING_CAPTURE_TEST` | `src/main.rs:6409` | test gate |
| `SINGZ_GPUI_TRAINING_FEEDBACK_TEST` | `src/main.rs:6305` | test gate |
| `SINGZ_GPUI_TRAINING_HISTORY_TEST` | `src/main.rs:6322` | test gate |
| `SINGZ_GPUI_TRAINING_INPUT_RECOVERY_TEST` | `src/main.rs:6349` | test gate |
| `SINGZ_GPUI_TRAINING_KEYBOARD_TEST` | `src/main.rs:6327` | test gate |
| `SINGZ_GPUI_TRAINING_PREPARATION_TEST` | `src/main.rs:6317` | test gate |
| `SINGZ_GPUI_TRAINING_RECOVERY_TEST` | `src/main.rs:6344` | test gate |
| `SINGZ_GPUI_TRAINING_REVIEW` | `src/main.rs:6270` | test gate |
| `SINGZ_GPUI_TRAINING_RUN_TEST` | `src/main.rs:6339` | test gate |
| `SINGZ_GPUI_TRAINING_RUNNING_KEYBOARD_TEST` | `src/main.rs:6333` | test gate |
| `SINGZ_GPUI_TRAINING_SONG_KEYBOARD_TEST` | `src/main.rs:6311` | test gate |
| `SINGZ_GPUI_GUIDE_TEST` | `src/main.rs:6207` | test gate |
| `SINGZ_GPUI_SETTINGS_KEYBOARD_TEST` | `src/main.rs:807`; `src/ui_audio_settings.rs:233` | test gate |
| `SINGZ_GPUI_SETTINGS_PREFS_TEST` | `src/ui_audio_settings.rs:35` | test gate |
| `SINGZ_GPUI_MODELS_KEYBOARD_TEST` | `src/ui_models.rs:76` | test gate |
| `SINGZ_GPUI_MODELS_RESTART` | `src/ui_models.rs:107` | test control |
| `SINGZ_GPUI_SOURCE_PHASE_PARITY_TEST` | `src/ui_source.rs:63` | test gate |
| `SINGZ_GPUI_TIMING_STAGE` | `src/ui_transport_timing.rs:42` | test control |
| `SINGZ_GPUI_TEST_NO_CAPTURE` | `src/main.rs:6277-6301` (gated reads; ungated read at `:3419` is in section 1) | test gate |
| `SINGZ_GPUI_TEST_PROJECT` | 21 sites, first `src/ui_audio_settings.rs:42` | fixture |
| `SINGZ_GPUI_CAPTURE_FIXTURE` | 20 sites, first `src/main.rs:6307`; `src/microphone.rs:324`, `:342`, `:798` | test gate |

Remaining gated names (fixtures, stage/phase controls, and UI test hooks such as `SINGZ_GPUI_TEST_*`, `SINGZ_GPUI_*_FIXTURES`, `SINGZ_GPUI_*_STAGE`, `SINGZ_GPUI_*_PHASE`, `SINGZ_GPUI_LYRICS_REAL_*`, `SINGZ_GPUI_MODEL_FIXTURE`, `SINGZ_GPUI_EXPECT_PROGRAM`, `SINGZ_GPUI_TRAINING_RECOVERY_FIXTURE`, `SINGZ_GPUI_AUDIO_RECOVERY_*`, `SINGZ_GPUI_DIAGNOSTICS_STAGE`, `SINGZ_GPUI_DRIVE_STAGE`, `SINGZ_GPUI_LOCALE_STAGE`, `SINGZ_GPUI_PICKER_STAGE`, `SINGZ_GPUI_RELEASE_STAGE`, `SINGZ_GPUI_ENGINE_CANDIDATES`, `SINGZ_GPUI_MODEL_CONTROL`) are listed in the appendix below, generated mechanically from the base-commit grep.

## 3. `ui_*.rs` modules in the default binary

None. `src/main.rs` declares 70 `ui_*` modules, and every declaration is preceded by `#[cfg(feature="ui-tests")]` (or the `all(feature="ui-tests", target_os="macos")` form for `ui_desktop_lifecycle`). `src/ui_drive_adoption.rs` (71st file) is included only through `#[path="ui_drive_adoption.rs"]` at `src/ui_drive.rs:5`, which is itself gated. `src/ui_text_phase.rs:3` and `src/ui_grain.rs` also carry `ui-tests` gating. The non-`ui_` modules compile in the default build, and the gated reads inside them are listed in section 2.

## 4. Build and packaging

No `cargo` invocation with `--features` (and no `--release`) appears in `scripts/` or `.github/` at `f7607311`. The packager scripts (`scripts/package-gpui-macos.py`, `scripts/package-gpui-desktop.py`) list the four executables but do not invoke cargo themselves. *(inferred)* The shipped binary is therefore built without `ui-tests`, unless the build command lives elsewhere. `experiments/gpui-player/NATIVE_INTEGRATION.md:169` and `README.md:198` show `--features ui-tests` for test builds only.

## 5. Notes for the C-23 accept criterion

A `strings` check on the default release binary would still find the section 1 names, because they are compiled in ungated (the ones marked "dangerous in release" are the important ones: `SINGZ_GDRIVE_CONFIG`, `SINGZ_GPUI_DEMO`, `SINGZ_GPUI_PROFILE`, `SINGZ_GPUI_CAPTURE_FILE`, the fixture-mode key scan, and `SINGZ_GPU_PACK_URL`). This is a fact about the code, not a recommendation.

## 6. Could not determine

- Which build command produces the shipped binary. Not found in this repository at `f7607311`.
- Whether any section 1 operator override is intentionally supported by the product. The code shows the read; the product intent is not documented here.
- `integration.rs:975,982` and some `ui_*` gate reads were checked by look-back only *(inferred)*.
- The working-tree changes (`main.rs` marker, `Cargo.toml` release profile and `singz-uikit` source) are not analyzed; they may change this picture once committed.

## Appendix: gated names (generated from the base-commit grep, `f7607311`)

Each row is one name that appears only in gated code (section 2) or test-only code (section 1). Mixed names are excluded because section 1 covers them. Sites are `path:line` at `f7607311`.

| Name | Sites | First sites |
|---|---|---|
| `SINGZ_GPUI_ACCESSIBILITY_TEST` | 1 | src/main.rs:6202 |
| `SINGZ_GPUI_AUDIO_PROVIDER_RESTART` | 1 | src/ui_audio_provider.rs:174 |
| `SINGZ_GPUI_AUDIO_PROVIDER_TEST` | 1 | src/main.rs:6281 |
| `SINGZ_GPUI_AUDIO_RECOVERY` | 1 | src/main.rs:6439 |
| `SINGZ_GPUI_AUDIO_RECOVERY_FIXTURE` | 1 | src/ui_audio_recovery.rs:157 |
| `SINGZ_GPUI_AUDIO_RECOVERY_INVALID` | 1 | src/ui_audio_recovery.rs:894 |
| `SINGZ_GPUI_AUDIO_RECOVERY_PHASE` | 3 | src/ui_audio_recovery.rs:131, src/ui_audio_recovery.rs:585, src/ui_audio_recovery.rs:1330 |
| `SINGZ_GPUI_AUDIO_RECOVERY_PROJECT` | 1 | src/ui_audio_recovery.rs:588 |
| `SINGZ_GPUI_AUDIO_RECOVERY_PUBLICATION_FAULT` | 1 | src/ui_audio_recovery.rs:586 |
| `SINGZ_GPUI_AUDIO_RECOVERY_RAW` | 1 | src/ui_audio_recovery.rs:925 |
| `SINGZ_GPUI_AUDIO_SETTINGS` | 1 | src/main.rs:6444 |
| `SINGZ_GPUI_BEAT_DETECTION_TEST` | 1 | src/main.rs:6237 |
| `SINGZ_GPUI_BEAT_FIXTURES` | 1 | src/ui_beat_detection.rs:77 |
| `SINGZ_GPUI_CAPTURE_FIXTURE` | 20 | src/main.rs:6307, src/main.rs:6313, src/main.rs:6329, src/main.rs:6335 +16 more |
| `SINGZ_GPUI_CARRY_CROWDED` | 1 | src/ui_carry_line.rs:76 |
| `SINGZ_GPUI_CARRY_FRESH_PROJECT` | 3 | src/ui_carry_line.rs:73, src/ui_carry_line.rs:111, src/ui_carry_line.rs:170 |
| `SINGZ_GPUI_CARRY_GATE` | 3 | src/integration.rs:2801, src/ui_carry_line.rs:105, src/ui_carry_line.rs:160 |
| `SINGZ_GPUI_CARRY_STAGE` | 1 | src/ui_carry_line.rs:67 |
| `SINGZ_GPUI_CARRY_TARGET` | 1 | src/ui_carry_line.rs:98 |
| `SINGZ_GPUI_CARRY_TEST` | 2 | src/integration.rs:2800, src/main.rs:6379 |
| `SINGZ_GPUI_CARRY_WORKING` | 1 | src/ui_carry_line.rs:97 |
| `SINGZ_GPUI_CUSTOM_TRACK_FILES` | 1 | src/custom_tracks_host.rs:224 |
| `SINGZ_GPUI_CUSTOM_TRACK_TEST` | 2 | src/custom_tracks_host.rs:223, src/main.rs:6394 |
| `SINGZ_GPUI_DELETE_COMMIT_GATE` | 1 | src/project_delete.rs:645 |
| `SINGZ_GPUI_DELETE_HIDDEN_GATE` | 1 | src/project_delete.rs:644 |
| `SINGZ_GPUI_DELETE_PREPARE_GATE` | 2 | src/project_delete.rs:643, src/ui_project_delete.rs:135 |
| `SINGZ_GPUI_DESKTOP_LIFECYCLE_TEST` | 1 | src/main.rs:6182 |
| `SINGZ_GPUI_DIAGNOSTICS_READ_GATE` | 2 | src/diagnostics.rs:259, src/ui_diagnostics.rs:123 |
| `SINGZ_GPUI_DIAGNOSTICS_SAVE_GATE` | 2 | src/diagnostics.rs:264, src/ui_diagnostics.rs:124 |
| `SINGZ_GPUI_DIAGNOSTICS_STAGE` | 2 | src/ui_diagnostics.rs:157, src/ui_diagnostics.rs:179 |
| `SINGZ_GPUI_DIAGNOSTICS_TEST` | 2 | src/diagnostics_host.rs:121, src/main.rs:6192 |
| `SINGZ_GPUI_DRIVE_RESTORE_STAGE` | 1 | src/ui_drive_restore.rs:91 |
| `SINGZ_GPUI_DRIVE_RESTORE_TEST` | 2 | src/drive_host.rs:46, src/main.rs:6275 |
| `SINGZ_GPUI_DRIVE_RETIREMENT_PROJECT` | 1 | src/ui_drive_retirement.rs:240 |
| `SINGZ_GPUI_DRIVE_RETIREMENT_TEST` | 2 | src/drive_host.rs:48, src/main.rs:6293 |
| `SINGZ_GPUI_DRIVE_RETIREMENT_WIDTH` | 1 | src/ui_drive_retirement.rs:239 |
| `SINGZ_GPUI_DRIVE_STAGE` | 3 | src/ui_drive.rs:115, src/ui_drive.rs:122, src/ui_drive_adoption.rs:89 |
| `SINGZ_GPUI_DRIVE_TEST` | 3 | src/drive_host.rs:13, src/drive_host.rs:45, src/main.rs:6419 |
| `SINGZ_GPUI_EMPTY_DRIVE_PROJECT` | 1 | src/ui_empty_drive.rs:208 |
| `SINGZ_GPUI_EMPTY_DRIVE_ROLE` | 1 | src/ui_empty_drive.rs:170 |
| `SINGZ_GPUI_EMPTY_DRIVE_TEST` | 2 | src/drive_host.rs:47, src/main.rs:6287 |
| `SINGZ_GPUI_EMPTY_DRIVE_WIDTH` | 1 | src/ui_empty_drive.rs:175 |
| `SINGZ_GPUI_EMPTY_PROJECT_FIXTURES` | 1 | src/ui_empty_project.rs:139 |
| `SINGZ_GPUI_EMPTY_PROJECT_PHASE` | 1 | src/ui_empty_project.rs:139 |
| `SINGZ_GPUI_EMPTY_PROJECT_TEST` | 3 | src/custom_tracks_host.rs:216, src/main.rs:5795, src/main.rs:6389 |
| `SINGZ_GPUI_ENGINE_CANDIDATES` | 2 | src/engine_status.rs:102, src/ui_migration.rs:23 |
| `SINGZ_GPUI_ENGINE_SETUP_CONTROL` | 1 | src/ui_engine_setup.rs:112 |
| `SINGZ_GPUI_ENGINE_SETUP_STAGE` | 1 | src/ui_engine_setup.rs:118 |
| `SINGZ_GPUI_ENGINE_SETUP_TEST` | 2 | src/main.rs:824, src/main.rs:6197 |
| `SINGZ_GPUI_EXPECT_PROGRAM` | 3 | src/ui_training_history.rs:15, src/ui_training_history.rs:18, src/ui_training_history.rs:32 |
| `SINGZ_GPUI_GUIDE_NATIVE_DRIVE` | 1 | src/ui_quick_start.rs:110 |
| `SINGZ_GPUI_GUIDE_RESTART` | 1 | src/ui_quick_start.rs:117 |
| `SINGZ_GPUI_GUIDE_TEST` | 1 | src/main.rs:6207 |
| `SINGZ_GPUI_IMPORT_FORCE_COPY_MOVE` | 1 | src/project_import.rs:345 |
| `SINGZ_GPUI_IMPORT_OLD_STATUS_GATE` | 1 | src/integration.rs:1918 |
| `SINGZ_GPUI_IMPORT_PREPARE_GATE` | 1 | src/project_import.rs:244 |
| `SINGZ_GPUI_IMPORT_RECEIPT_GATE` | 1 | src/integration.rs:2756 |
| `SINGZ_GPUI_IMPORT_REMOVE_GATE` | 1 | src/project_import.rs:291 |
| `SINGZ_GPUI_INTEGRATION_TEST` | 1 | src/main.rs:6459 |
| `SINGZ_GPUI_LIBRARY_IMPORT_FIXTURES` | 1 | src/ui_library_import.rs:84 |
| `SINGZ_GPUI_LIBRARY_IMPORT_TEST` | 1 | src/main.rs:6222 |
| `SINGZ_GPUI_LIBRARY_REFERENCE` | 1 | src/ui_library_review.rs:208 |
| `SINGZ_GPUI_LIBRARY_REVIEW` | 1 | src/main.rs:6489 |
| `SINGZ_GPUI_LOCALE_STAGE` | 1 | src/ui_locale.rs:39 |
| `SINGZ_GPUI_LOCALE_TEST` | 1 | src/main.rs:6414 |
| `SINGZ_GPUI_LOCALE_TEST_PERSIST` | 1 | src/locale_service.rs:49 |
| `SINGZ_GPUI_LOG_REVIEW` | 1 | src/main.rs:6474 |
| `SINGZ_GPUI_LYRICS_ALIGN_FIXTURES` | 5 | src/ui_lyrics_align.rs:124, src/ui_lyrics_align.rs:298, src/ui_lyrics_align.rs:572, src/ui_lyrics_sidebar.rs:447 +1 more |
| `SINGZ_GPUI_LYRICS_ALIGN_TEST` | 3 | src/main.rs:6232, src/ui_lyrics_sidebar.rs:452, src/ui_lyrics_sidebar.rs:592 |
| `SINGZ_GPUI_LYRICS_EDITOR_FIXTURES` | 1 | src/ui_lyrics_editor.rs:274 |
| `SINGZ_GPUI_LYRICS_EDITOR_TEST` | 1 | src/main.rs:6217 |
| `SINGZ_GPUI_LYRICS_LIVE_CANDIDATE_ID` | 1 | src/ui_lyrics_sidebar.rs:468 |
| `SINGZ_GPUI_LYRICS_LIVE_QUERY` | 1 | src/ui_lyrics_sidebar.rs:464 |
| `SINGZ_GPUI_LYRICS_LIVE_TEST` | 4 | src/ui_lyrics_sidebar.rs:197, src/ui_lyrics_sidebar.rs:213, src/ui_lyrics_sidebar.rs:443, src/ui_lyrics_sidebar.rs:592 |
| `SINGZ_GPUI_LYRICS_QWEN_AUTO_UI` | 2 | src/ui_lyrics_sidebar.rs:195, src/ui_lyrics_sidebar.rs:209 |
| `SINGZ_GPUI_LYRICS_QWEN_REAL_UI` | 2 | src/ui_lyrics_align.rs:83, src/ui_lyrics_align.rs:113 |
| `SINGZ_GPUI_LYRICS_REAL_OUT` | 1 | src/lyrics_align_tests.rs:258 |
| `SINGZ_GPUI_LYRICS_REAL_PREINSTALLED` | 2 | src/ui_lyrics_align.rs:318, src/ui_lyrics_sidebar.rs:455 |
| `SINGZ_GPUI_LYRICS_REAL_PRIOR_DOWNLOAD_RECEIPT` | 1 | src/ui_lyrics_align.rs:334 |
| `SINGZ_GPUI_LYRICS_REAL_PRIOR_EXIT` | 1 | src/ui_lyrics_align.rs:336 |
| `SINGZ_GPUI_LYRICS_REAL_PRIOR_RESULT` | 1 | src/ui_lyrics_align.rs:335 |
| `SINGZ_GPUI_LYRICS_REAL_PROJECT` | 5 | src/lyrics_align_tests.rs:257, src/ui_lyrics_align.rs:302, src/ui_lyrics_align.rs:581, src/ui_lyrics_sidebar.rs:458 +1 more |
| `SINGZ_GPUI_LYRICS_REAL_RESUME` | 2 | src/ui_lyrics_align.rs:317, src/ui_lyrics_sidebar.rs:456 |
| `SINGZ_GPUI_LYRICS_REAL_UI` | 3 | src/ui_lyrics_align.rs:85, src/ui_lyrics_align.rs:117, src/ui_lyrics_sidebar.rs:454 |
| `SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE` | 4 | src/integration.rs:649, src/ui_lyrics_sidebar.rs:356, src/ui_lyrics_sidebar.rs:449, src/ui_lyrics_sidebar.rs:591 |
| `SINGZ_GPUI_LYRICS_REVIEW` | 1 | src/main.rs:6479 |
| `SINGZ_GPUI_LYRICS_SCROLL_TEST` | 1 | src/main.rs:6484 |
| `SINGZ_GPUI_LYRICS_SIDEBAR_FIXTURES` | 3 | src/ui_lyrics_sidebar.rs:220, src/ui_lyrics_sidebar.rs:446, src/ui_lyrics_sidebar.rs:589 |
| `SINGZ_GPUI_LYRICS_SIDEBAR_TEST` | 1 | src/main.rs:6242 |
| `SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE` | 5 | src/integration.rs:2660, src/ui_lyrics_editor.rs:518, src/ui_lyrics_editor.rs:551, src/ui_lyrics_sidebar.rs:449 +1 more |
| `SINGZ_GPUI_METRONOME_GRIDLESS` | 1 | src/ui_metronome.rs:172 |
| `SINGZ_GPUI_METRONOME_LEGACY` | 1 | src/ui_metronome.rs:189 |
| `SINGZ_GPUI_METRONOME_RESTART` | 1 | src/ui_metronome.rs:177 |
| `SINGZ_GPUI_METRONOME_TEST` | 1 | src/main.rs:6212 |
| `SINGZ_GPUI_MICROPHONE_TEST` | 1 | src/main.rs:6434 |
| `SINGZ_GPUI_MIGRATION_TEST` | 1 | src/main.rs:6257 |
| `SINGZ_GPUI_MODAL_BACKDROP_REVIEW` | 1 | src/main.rs:6454 |
| `SINGZ_GPUI_MODEL_CONTROL` | 6 | src/ui_lyrics_align.rs:299, src/ui_lyrics_align.rs:573, src/ui_lyrics_sidebar.rs:448, src/ui_lyrics_sidebar.rs:590 +2 more |
| `SINGZ_GPUI_MODEL_FIXTURE` | 6 | src/model_service.rs:245, src/ui_lyrics_align.rs:298, src/ui_lyrics_align.rs:572, src/ui_lyrics_sidebar.rs:447 +2 more |
| `SINGZ_GPUI_MODELS_KEYBOARD_TEST` | 1 | src/ui_models.rs:76 |
| `SINGZ_GPUI_MODELS_RESTART` | 1 | src/ui_models.rs:107 |
| `SINGZ_GPUI_MODELS_TEST` | 1 | src/main.rs:6265 |
| `SINGZ_GPUI_MONITOR_OTHER_PROJECT` | 1 | src/ui_monitor.rs:145 |
| `SINGZ_GPUI_MONITOR_PUBLICATION_ADAPTER` | 1 | src/ui_monitor_publication.rs:18 |
| `SINGZ_GPUI_MONITOR_PUBLICATION_RAW` | 2 | src/ui_monitor_publication.rs:100, src/ui_monitor_publication.rs:137 |
| `SINGZ_GPUI_MONITOR_PUBLICATION_TEST` | 1 | src/main.rs:6429 |
| `SINGZ_GPUI_MONITOR_TEST` | 1 | src/main.rs:6424 |
| `SINGZ_GPUI_NATIVE_LYRICS` | 1 | src/main.rs:6449 |
| `SINGZ_GPUI_OFFSCREEN_SECONDS` | 1 | src/ui_benchmark.rs:35 |
| `SINGZ_GPUI_OFFSCREEN_WARMUP` | 1 | src/ui_benchmark.rs:34 |
| `SINGZ_GPUI_PICKER_CHOOSE_ROOT` | 1 | src/main.rs:2360 |
| `SINGZ_GPUI_PICKER_MOVE_GATE` | 1 | src/project_library.rs:855 |
| `SINGZ_GPUI_PICKER_STAGE` | 1 | src/ui_project_picker.rs:105 |
| `SINGZ_GPUI_PITCH_LABEL_TEST` | 1 | src/ui_lyrics_align.rs:501 |
| `SINGZ_GPUI_PLAYBACK_GRAPH_TEST` | 1 | src/main.rs:6299 |
| `SINGZ_GPUI_PROJECT_DELETE_FIXTURES` | 1 | src/ui_project_delete.rs:134 |
| `SINGZ_GPUI_PROJECT_DELETE_TEST` | 1 | src/main.rs:6399 |
| `SINGZ_GPUI_PROJECT_KEY_TEST` | 1 | src/main.rs:6187 |
| `SINGZ_GPUI_PROJECT_PICKER_FIXTURES` | 1 | src/ui_project_picker.rs:104 |
| `SINGZ_GPUI_PROJECT_PICKER_TEST` | 1 | src/main.rs:6227 |
| `SINGZ_GPUI_RATE_RECEIPT_GATE` | 3 | src/integration.rs:2788, src/ui_transport_timing.rs:124, src/ui_transport_timing.rs:210 |
| `SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_STAGE` | 2 | src/ui_recording_publication_recovery.rs:73, src/ui_recording_publication_recovery.rs:117 |
| `SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_TEST` | 2 | src/main.rs:6367, src/training_recording_host.rs:196 |
| `SINGZ_GPUI_RELEASE_AUTOMATIC` | 1 | src/main.rs:1660 |
| `SINGZ_GPUI_RELEASE_STAGE` | 1 | src/ui_whats_new.rs:98 |
| `SINGZ_GPUI_REQUIRE_DRIVE_CONFIG` | 1 | build_config.rs:8 |
| `SINGZ_GPUI_REVIEW_CAPTURE` | 1 | src/main.rs:6469 |
| `SINGZ_GPUI_SETTINGS_KEYBOARD_TEST` | 2 | src/main.rs:807, src/ui_audio_settings.rs:233 |
| `SINGZ_GPUI_SETTINGS_MISSING_START` | 1 | src/ui_audio_settings.rs:44 |
| `SINGZ_GPUI_SETTINGS_PREFS_TEST` | 1 | src/ui_audio_settings.rs:35 |
| `SINGZ_GPUI_SOURCE_CONTROL` | 6 | src/ui_lyrics_align.rs:299, src/ui_lyrics_align.rs:573, src/ui_lyrics_sidebar.rs:448, src/ui_lyrics_sidebar.rs:590 +2 more |
| `SINGZ_GPUI_SOURCE_FILE` | 3 | src/ui_migration.rs:28, src/ui_source.rs:54, src/ui_title.rs:56 |
| `SINGZ_GPUI_SOURCE_LEGACY_PROJECT` | 1 | src/ui_source.rs:226 |
| `SINGZ_GPUI_SOURCE_PHASE_PARITY_TEST` | 1 | src/ui_source.rs:63 |
| `SINGZ_GPUI_SOURCE_SAVE_PREPARE_GATE` | 2 | src/source_jobs.rs:1408, src/ui_lyrics_sidebar.rs:394 |
| `SINGZ_GPUI_SOURCE_TEST` | 1 | src/main.rs:6260 |
| `SINGZ_GPUI_SPLIT_LOAD_GATE` | 2 | src/integration.rs:2555, src/ui_source.rs:65 |
| `SINGZ_GPUI_STEM_EXPORT_DEST` | 1 | src/ui_stem_export.rs:100 |
| `SINGZ_GPUI_STEM_EXPORT_GATE` | 2 | src/stem_export.rs:585, src/ui_stem_export.rs:140 |
| `SINGZ_GPUI_STEM_EXPORT_TEST` | 3 | src/main.rs:6384, src/stem_export.rs:582, src/stem_export_host.rs:65 |
| `SINGZ_GPUI_TEST_ANALYSIS` | 2 | src/ui_integration.rs:85, src/ui_integration.rs:259 |
| `SINGZ_GPUI_TEST_CATALOG` | 1 | src/ui_integration.rs:340 |
| `SINGZ_GPUI_TEST_CUSTOM_PROJECT` | 1 | src/ui_playback_graph.rs:103 |
| `SINGZ_GPUI_TEST_FOOTER_KEYBOARD` | 2 | src/ui_desktop_keyboard.rs:489, src/ui_integration.rs:370 |
| `SINGZ_GPUI_TEST_GRAPH` | 1 | src/ui_integration.rs:80 |
| `SINGZ_GPUI_TEST_KARAOKE` | 2 | src/ui_desktop_keyboard.rs:490, src/ui_integration.rs:93 |
| `SINGZ_GPUI_TEST_KARAOKE_PREF_EXPECT` | 1 | src/ui_integration.rs:98 |
| `SINGZ_GPUI_TEST_KARAOKE_PREF_FINISH` | 1 | src/ui_integration.rs:407 |
| `SINGZ_GPUI_TEST_KEYBOARD` | 1 | src/ui_integration.rs:368 |
| `SINGZ_GPUI_TEST_LYRICS_COUNTDOWN` | 1 | src/ui_integration.rs:354 |
| `SINGZ_GPUI_TEST_NAVIGATION` | 1 | src/ui_integration.rs:94 |
| `SINGZ_GPUI_TEST_OUTPUT` | 1 | src/ui_integration.rs:326 |
| `SINGZ_GPUI_TEST_PROJECT` | 21 | src/ui_audio_settings.rs:42, src/ui_audio_settings.rs:234, src/ui_carry_line.rs:67, src/ui_custom_tracks.rs:105 +17 more |
| `SINGZ_GPUI_TEST_REGION` | 1 | src/ui_integration.rs:298 |
| `SINGZ_GPUI_TEST_SAVE` | 2 | src/ui_integration.rs:246, src/ui_integration.rs:291 |
| `SINGZ_GPUI_TEST_TIMELINE` | 1 | src/ui_integration.rs:312 |
| `SINGZ_GPUI_TIMING_GRIDLESS` | 1 | src/ui_transport_timing.rs:42 |
| `SINGZ_GPUI_TIMING_SAME_BPM` | 1 | src/ui_transport_timing.rs:42 |
| `SINGZ_GPUI_TIMING_STAGE` | 1 | src/ui_transport_timing.rs:42 |
| `SINGZ_GPUI_TIMING_VARIABLE` | 1 | src/ui_transport_timing.rs:42 |
| `SINGZ_GPUI_TITLE_TEST` | 1 | src/main.rs:6252 |
| `SINGZ_GPUI_TRAINING_AUDIO_TEST` | 1 | src/main.rs:6404 |
| `SINGZ_GPUI_TRAINING_CAPTURE_TEST` | 1 | src/main.rs:6409 |
| `SINGZ_GPUI_TRAINING_FEEDBACK_TEST` | 1 | src/main.rs:6305 |
| `SINGZ_GPUI_TRAINING_HISTORY_TEST` | 1 | src/main.rs:6322 |
| `SINGZ_GPUI_TRAINING_INPUT_RECOVERY_PHASE` | 2 | src/ui_training_input_recovery.rs:36, src/ui_training_input_recovery.rs:105 |
| `SINGZ_GPUI_TRAINING_INPUT_RECOVERY_TEST` | 1 | src/main.rs:6349 |
| `SINGZ_GPUI_TRAINING_KEYBOARD_TEST` | 1 | src/main.rs:6327 |
| `SINGZ_GPUI_TRAINING_PREPARATION_TEST` | 1 | src/main.rs:6317 |
| `SINGZ_GPUI_TRAINING_RECORDING_EXPORT_GATE` | 1 | src/training_recording_store.rs:587 |
| `SINGZ_GPUI_TRAINING_RECORDING_RECOVERY_TEST` | 2 | src/main.rs:6360, src/training_recording_host.rs:195 |
| `SINGZ_GPUI_TRAINING_RECORDING_TEST` | 2 | src/main.rs:6355, src/training_recording_host.rs:194 |
| `SINGZ_GPUI_TRAINING_RECOVERY_FIXTURE` | 1 | src/ui_training_recovery.rs:72 |
| `SINGZ_GPUI_TRAINING_RECOVERY_PROJECT` | 1 | src/ui_training_recovery.rs:113 |
| `SINGZ_GPUI_TRAINING_RECOVERY_TEST` | 1 | src/main.rs:6344 |
| `SINGZ_GPUI_TRAINING_REVIEW` | 1 | src/main.rs:6270 |
| `SINGZ_GPUI_TRAINING_RUN_TEST` | 1 | src/main.rs:6339 |
| `SINGZ_GPUI_TRAINING_RUNNING_KEYBOARD_TEST` | 1 | src/main.rs:6333 |
| `SINGZ_GPUI_TRAINING_SONG_KEYBOARD_TEST` | 1 | src/main.rs:6311 |
| `SINGZ_GPUI_TRANSPORT_TIMING_TEST` | 2 | src/integration.rs:2788, src/main.rs:6374 |
| `SINGZ_GPUI_UI_SMOKE` | 1 | src/main.rs:6464 |
| `SINGZ_GPUI_UNKNOWN_PROJECT` | 2 | src/ui_training_preparation.rs:37, src/ui_training_song_keyboard.rs:96 |
| `SINGZ_GPUI_WHATS_NEW_TEST` | 3 | src/main.rs:806, src/main.rs:2432, src/main.rs:6247 |

# Native desktop completion plan

Written 2026-11-10 against branch `codex/gpui-interface` (tip `020a5088`, 40 commits
ahead of and 88 behind `origin/main`). Paths are relative to the repository root.
`$G` means `experiments/gpui-player`. Anything marked *(inferred)* was not checked
against code; section 9 lists what could not be verified.

## 1. Goal, scope, constraints

**Goal.** Finish the Rust/GPUI desktop in `$G` so it replaces the Electron desktop
as the default SingZ desktop on macOS and Windows.

**In scope.** The Rust app, its three C++ helpers (`tools/native/singz-gpui-audio.cpp`,
`singz-gpui-input.cpp`, `singz-analyze.cpp`), packaging, signing, updater, migration
from an Electron install, qualification, and the performance budgets in section 3.

**Not in scope.**

- Electron is not deleted. SingZ Box (PR #145, `origin/codex/box-app`) keeps the
  Electron source tree alive, with a headless `--box-audio-host` on LoopZ.
- The React Native phones do not change.
- Desktop audio does not move to LoopZ.
- The shared product core of `docs/rfc/0001-shared-product-core.md` is not built
  here. Only its Phase 0 case tables are (C-16), because Box keeps the TypeScript
  rules live and the tables are what stops the two copies drifting.
- Linux is a preview target. It keeps its existing checkpoints and gets CI, but it
  does not gate "native becomes default".

**Decided constraints.**

| Constraint | Consequence for this plan |
|---|---|
| Finishing Rust is the RFC's trigger to lean Rust for any future core | Keep pure rule modules free of I/O where a WP touches them (`drive_plan.rs`, `sync_dirty.rs`, `sync_scheduler.rs`, `lrclib.rs`, `training_scoring.rs`) |
| The audio seam is `NativePlaybackSession(std::unique_ptr<AudioHostBackend>)`, which exists on the Box branch | The GPUI helper should end up driving that session. When is decision D-07; it does not block the default switch |
| The C++ core is the source of truth for detectors | Detector versions come from the `zcore` headers, never typed into Rust (C-14) |
| On `main`, zCore base/media is the `third_party/zcore` submodule (pin `96ead8fc` since #145 merged as `c9465e4d`; `b3364438` before it) | The uncommitted Windows UTF-8 fix in this tree must go upstream first (C-01), then the branch is brought up to main (C-02) |
| Both desktops run side by side during beta | Both write `catalog.json` format 2 with the same `capabilities`; neither may trash what the other published (C-43) |
| Performance is a first-class requirement | Section 3. No budget is traded away for a feature without the user's decision |

**How to use this plan.** The coordinator works wave by wave (section 5). For each
work package it copies the spec template (section 8), fills it from the catalog row
(section 4), and starts a worker. A package is done when its acceptance evidence
exists and the code-reviewer gate has passed. Update the status column in a copy of
the catalog, not this text, so the plan stays readable.

## 2. Roles, model tiers, rules

| Role | Agent and model | Effort | Used for |
|---|---|---|---|
| Coordinator | Claude Opus, `claude-opus-5-5` | — | Sequencing, specs, reviewing worker output, the code-reviewer gate, commits, merges |
| Architect | `--agent claude --model claude-fable-5-2` | high | Decision Records (D-xx) only |
| Coder, default | `--agent codex --model gpt-reserve` | medium | Coding packages |
| Coder, escalated | `--agent codex --model gpt-6.1-sol` | medium or high | Packages on a data-loss path (Drive sync, planner, ledger, project or lyrics save, migration) or on audio timing. Each such row says why |
| Coder, conventions | `--agent claude --model claude-sonnet-5-5` | medium | Coding where this repository's own rules carry the work: `CLAUDE.md` conventions, driver and watchdog conventions, i18n typed across locales, shared case tables, CI workflow rules |
| Second reviewer | `--agent claude --model claude-sonnet-5-5` | medium | Independent read of every escalated Codex package before the coordinator's gate (V-01). Also drafts worker specs from a Decision Record when the coordinator delegates that (S-01) |
| Researcher, code | `--agent codex --model gpt-6-luna` | low or medium | Read-only inventories that need code read for behaviour: control flow, protocols, what a function does on each path |
| Researcher, mechanical | `--agent claude --model claude-haiku-5-5` | low | Read-only work answered by search, listing and summarising: string and variable inventories, checking that cited file:line references still hold, doc path checks, summarising CI and qualification logs, triaging capture sets |
| Human | the user | — | Windows field laptop, real Google account, Apple and Windows signing credentials, physical microphones, beta testers |

Launch form:

```sh
orca orchestration worker-start --spec-file <spec.md> --agent <agent> \
  --model <id> --effort <level> --worktree <new-top-level|new-child|...>
```

**Rules.**

0. Read-only work is split by what it takes to answer. If a search plus a summary
   answers it, it goes to Haiku. If the answer depends on following what code
   does, it goes to `gpt-6-luna`. Neither edits anything but its report file.
1. One worktree per coding package (`--worktree new-top-level`, or `new-child` when
   it builds on an unmerged parent package). Read-only research may share the
   coordinator's tree. Bootstrap a new worktree with `scripts/worktree-setup.sh`
   and verify the analyzer fingerprint before running anything.
2. Workers never commit to `main` and never push. A worker stages its change and
   reports. The coordinator runs the `code-reviewer` agent on the staged diff,
   acts on the findings, and commits. For a package on the escalated model, a
   Sonnet review (V-01) comes first: a different model family from the author
   reads the staged diff against the spec and the rule it ports. Staging and committing are separate calls;
   the hook in `.claude/hooks/require-review.sh` refuses anything else.
3. A package edits only the files its row allows. If it needs another file, it
   stops and asks.
4. Every automated run is muted and hidden: `SINGZ_MUTE=1` and, for the native app,
   the hidden capture path the existing `$G/tests/test_native_*.py` drivers use.
   The only exception is the presented-frame measurement in section 3, which needs
   a visible window on a dedicated display.
5. Every driver runs under a deadline. Node drivers arm `tests/shared/watchdog.cjs`.
   New Python drivers in `$G/tests` must have a per-step budget and a total
   deadline, and must kill their own children on expiry.
6. A playback, engine or helper change is verified on the Mac and the Windows field
   laptop together and reported side by side. On the laptop, run the same harness
   against a control before calling a red a regression.
7. Stale-binary trap. After any change to `.cpp`, `.h`, `.mm` or the helper build,
   rebuild the helpers (`scripts/build-gpui-native.py`, `scripts/build-gpui-audio.sh`
   or `.ps1`) and confirm the binary carries the change (`singz-analyze build-info`,
   or `strings` for a new literal). A green run against an old helper proves nothing.
8. Never pipe a build into `tail` or `head`. Redirect to a file and read the exit code.
9. A measurement names its build profile, display mode, machine and commit. A
   number without those four is not evidence.
10. Research and decision outputs go to `$G/plan/` (new directory): `R-xx-<slug>.md`
    and `decisions/D-xx-<slug>.md`.

## 3. Non-functional requirements

### 3.1 Budgets

"Electron" means the Electron desktop at the release tag chosen in Q-01, on the
same machine, same song, same display mode. Reference song: a 5-minute, 6-lane
project with lyrics and a pitch line. Long-song variant: 12 minutes.

**Interim frame-rate target (user decision, 2026-11-11).** No 120 Hz panel is
available yet, so N1 to N3 and G1 are measured and gated at 60 Hz for now:
60 presented FPS, p99 frame time ≤ 16.7 ms, zero dropped frames. The 120 Hz
budgets below stay the release target and are re-measured once a 120 Hz panel
is available, before Q-15.

| # | Area | Budget | Scenario |
|---|---|---|---|
| N1 | Frame rate | 120 presented FPS on a 120 Hz panel; panel refresh elsewhere | 6-lane playback, lanes + lyrics + pitch strip visible |
| N2 | Frame time | p99 ≤ 8.3 ms at 120 Hz (≤ one refresh period elsewhere) | Same |
| N3 | Dropped frames | 0 dropped presented frames over 3 minutes of steady playback | Same |
| N4 | Input latency | Pan and zoom reach the screen within one frame | Wheel pan, pinch zoom, drag, window resize |
| N5 | Idle redraw | No presented frames when nothing changes | Paused; idle library; modal open |
| N6 | Idle CPU | App + helpers < 1% of one core | Paused and idle, 60 s |
| N7 | Playing CPU | App + helpers ≤ Electron all-process total; target half | Reference song |
| N8 | GPU, Windows | App GPU and DWM share each ≤ Electron (about 20% GPU playing on the field laptop) | Reference song, visible, per adapter |
| N9 | Memory | Steady footprint ≤ Electron all-process total | Reference song, 3 minutes in |
| N10 | Memory growth | No growth across 20 open/close cycles (slope within noise) | Two songs alternating |
| N11 | Audio | `starvedBlocks` = 0 on every lane | Playback under full-rate pan, zoom and resize for 60 s |
| N12 | Startup | Cold launch to interactive ≤ Electron | Fresh process, warm disk |
| N13 | Song open | ≤ Electron (0.56 s native open on the Mac) | Reference song, second open excluded |
| N14 | Package size | Installer ≤ Electron (122 MB dmg) | Shipped artifact, per platform |

Existing numbers (about 60-74% app CPU and 640-680 MB in
`$G/DRIVE_RESTORE_REVIEW.md`) come from debug builds captured hidden while
rendering test images. They are not a baseline and must not be quoted as one.

### 3.2 Measurement method

- **One harness, both apps.** The same scenario script and the same samplers
  measure Electron and native. Scenario: launch, open the reference song, play
  3 minutes, scripted pan/zoom/resize burst, pause 60 s, 20 open/close cycles, quit.
- **Presented frames, never render calls.** Windows: PresentMon or DXGI frame
  statistics, which work for both apps unchanged. macOS: the method is fixed by
  D-02; candidates are Metal present timestamps for native, Chromium presentation
  feedback for Electron, and a ScreenCaptureKit frame-delta observer as the common
  cross-check *(inferred: none of these is implemented here yet)*. The existing
  `$G/tests/interface-perf.py` reports `draw_fps`, which is a draw count; it stays
  as a smoke signal and is not an N1-N3 measurement.
- **Visible windows.** N1-N5 and N8 need a visible window. That conflicts with
  rule 4, so these runs use a dedicated or virtual display on the Mac and the
  interactive-session scheduled task on the Windows laptop. They stay muted.
- **Whole process tree.** CPU and memory are summed over the app and every helper
  (native) or every Electron process. Windows also records DWM.
- **Release builds only**, from the profile C-03 adds.
- **Three runs per cell**, report median and worst. On the laptop, differences of
  a few percent in CPU and working set are its noise.

### 3.3 Gates

| Gate | Where enforced | Checks | Blocks |
|---|---|---|---|
| G0 Baseline | Q-01, Q-02 | Electron and native-release numbers exist on both machines from one harness | Any optimisation work, D-02 |
| G1 120 FPS feasibility (interim: 60 FPS, see above) | Q-02 + D-02 | The probe shows N1-N3 are reachable, or D-02 names the architecture change that makes them reachable | Release pipeline spend beyond C-03/C-04 (wave 3) |
| Perf smoke | CI on release builds (C-35), every push touching `$G` or the helpers | Offscreen frame cost, idle redraw count = 0, startup, open time, idle CPU, package size; thresholds from Q-02 with margin | Merge |
| Beta gate | Coordinator, on each `-beta` tag | Full N1-N14 run, Mac visible | The prerelease tag |
| Default gate | Section 6 | Every budget on both machines | "Native becomes default" |

**Baseline-first rule.** No package under "Optimisation" starts, and no perf claim
is accepted, before G0. Every later perf result is reported as a delta against the
Q-01 and Q-02 files.

## 4. Work-package catalog

Columns: **Model** uses `luna` = `gpt-6-luna`, `reserve` = `gpt-reserve`,
`sol` = `gpt-6.1-sol`, `sonnet` = `claude-sonnet-5-5`, `haiku` = `claude-haiku-5-5`,
`fable` = `claude-fable-5-2`. **Size** is worker-days.
Every coding row implicitly ends with: staged diff, `cargo test` green in `$G`,
coordinator code-reviewer pass.

### 4.1 Research (read-only)

Each produces one report in `$G/plan/`. No other file is edited. `luna` unless the
row says `haiku`.

| ID | Question | Effort | Inputs | Report must contain | Size |
|---|---|---|---|---|---|
| R-01 | Does each review finding still hold, and where exactly? | medium | Finding list in section 9.1; `$G/src/project_lyrics.rs`, `drive_snapshot.rs`, `drive_http.rs`, `lrclib.rs`, `project_key.rs`, `project_pitch.rs`, `project_analysis.rs`, `beat_analysis.rs`, `integration.rs`, `main.rs`, `engine_status.rs`, `drive_service_tests.rs`; TS references named in the RFC's Evidence table | One row per finding: file:line, a minimal reproduction or failing input, the TypeScript behaviour it should match, confirmed/changed/not found | 2 |
| R-02 | What does each Electron E2E driver guarantee, and what covers it natively? | medium | All 25 files in `tests/e2e/mac/`, `tests/e2e/win-smoke.cjs`, `tests/e2e/win-visible-cpu.cjs`, `tests/e2e/capture-addon-*.cjs`, `.claude/agents/e2e-verifier.md`, the verification section of `CLAUDE.md`; `$G/tests/test_native_*.py`, `$G/src/*_tests.rs` | Table: driver, each guarantee in one sentence, the field bug it guards, native check that covers it (file) or GAP, proposed native check for each gap. Mark helper files (`library-song.cjs`, `project-hold.cjs`, `quiet-launch.cjs`) as not drivers | 3 |
| R-03 | What does an Electron install persist, and what is the native equivalent? | medium | `src/main/settings.ts`, `window-state.ts`, `sync-dirty.ts`, `sync-scheduler.ts`, `sync-log.ts`, `gdrive.ts`, `models.ts`, `projects.ts`, `log.ts`, `training-progress.ts`, `whats-new.ts`, renderer `localStorage` keys; `$G/src/settings.rs`, `drive_auth.rs`, `drive_state.rs`, `sync_dirty.rs`, `model_install.rs`, `training_store.rs`, `desktop_window_state.rs`, `audio_devices.rs` | Table per item: Electron location per userData identity (Electron/singz/SingZ) and platform, format, native location, native format, action (share, import once, ignore), risk if wrong. Include the Drive token store on both sides | 3 |
| R-04 | Which user-visible strings in the Rust app bypass i18n? | haiku, low | `$G/src/*.rs` excluding `*_tests.rs` and `ui_*.rs` test surfaces; `$G/src/i18n.rs`, `$G/build_i18n.rs`, `src/shared/i18n/en/` | List: file:line, literal, where it surfaces, existing key if one fits, else proposed key. Separate log-only strings | 2 |
| R-05 | What causes a redraw, and is each one justified? | medium | `$G/src/main.rs` and every non-test module calling `cx.notify`, frame requests or timers (about 570 call sites); `$G/src/backdrop_clock.rs`, `waveform.rs`, `pitch_strip.rs`, `lyrics_*.rs`, `timeline_*.rs`, `tracks.rs` | Table: site, trigger, scope (whole window or view), rate while playing / paused / idle, state that justifies it, verdict (keep, gate, coalesce). List every per-frame allocation or text shaping found on the way | 3 |
| R-06 | Which environment variables does the production binary read? | haiku, low | `$G/src/*.rs`, `$G/build.rs`, `$G/build_config.rs`, `tools/native/*.cpp` | Table: name, reader file:line, purpose, class (operator, test gate, fixture, dangerous in release). Include `SINGZ_GDRIVE_CONFIG` and every `SINGZ_GPUI_*TEST*`/`*GATE*` name. State which `ui_*.rs` modules compile into the default binary | 1 |
| R-07 | What does bringing the branch up to `origin/main` touch? | medium | `git diff HEAD...origin/main --stat`, `.gitmodules` on main, `zcore/` here against `third_party/zcore` on main, `native/`, `tools/native/`, `scripts/build-gpui-*.{py,sh,ps1}`, CMake files | Conflict forecast per file, every include path or CMake target that changes with the submodule, the diff between this tree's `zcore/src/media/{flac_io,wav}.cpp` + `zcore/include/zcore/base/utf8_file.h` and zCore at its pinned commit, a step order for C-01 and C-02 | 2 |
| R-08 | What does the Electron release pipeline do that the native packagers do not? | low | `.github/workflows/build.yml`, `e2e-win.yml`, `electron-builder.yml`, `scripts/afterPack.cjs`, `scripts/dist.cjs`, `docs/MACOS-SIGNING.md`, `src/main/updater.ts`; `scripts/package-gpui-desktop.py`, `scripts/package-gpui-macos.py`, `scripts/build-gpui-native.py`, `$G/DESKTOP_PACKAGING.md`, `$G/MACOS_PACKAGE_REVIEW.md` | Side-by-side step table, the updater feed files Electron publishes, whether the Windows installer is Authenticode-signed today, entitlements needed per native executable, a gap list | 2 |
| R-09 | How many Drive requests does a clean sync cost on each desktop? | medium | `src/main/gdrive.ts`, `src/main/sync-plan.ts`, `tests/unit/mock-drive.ts` *(inferred path, named in CLAUDE.md)*; `$G/src/drive_sync.rs`, `drive_remote.rs`, `drive_http.rs`, `drive_plan.rs`, `$G/tests/drive_fixture.py` | Request counts and process spawns for 1, 10 and 50 projects, clean and one-file-changed, per desktop, with the call sites producing each request | 2 |
| R-10 | What accessibility does the app expose today, and what can vendored GPUI expose? | medium | `$G/src/ui_accessibility.rs`, `$G/tests/test_native_accessibility.py`, `$G/NATIVE_CONTROLS_GUIDE_REVIEW.md`, `$G/vendor/gpui-pre*`, `$G/vendor/gpui-component`, `../singz-ui/gpui` | Per platform (macOS AX, Windows UIA): what the vendored platform layer implements, which controls carry role/label/value/actions, focus order and keyboard coverage per route, what Electron offers for the same route | 3 |
| R-11 | How far is the GPUI helper's protocol from the Box session seam? | medium | `tools/native/singz-gpui-audio.cpp`, `gpui_audio_provider.h`, `gpui_playback_graph.h`, `audio_host_cli.h`, `native/playback/native_playback_session.cpp`; on `origin/codex/box-app`: `native/electron/audio_monitor_session.h`, the `AudioHostBackend` declaration and the Box host contract | Command-by-command map, fencing vocabulary on each side (`generation`, `serial`, `instance`, `uncertain`), what the helper does that the session does not and the reverse | 2 |
| R-12 | Where does the app assume a POSIX-like local filesystem? | low | `$G/src/file_lease*.rs`, `directory_identity.rs`, `project_store.rs`, `project_rename.rs`, `project_publish.rs`, `library_import.rs`, `source_jobs.rs` (`source-work`), `drive_local_ops.rs`, `$G/WINDOWS_FILESYSTEM_REVIEW.md` | Every reliance on atomic rename, hard links, file identity, locks, mtime precision or case sensitivity, with its behaviour on exFAT and SMB; every place a user-supplied name becomes a path without a Windows reserved-name check; what bounds `source-work` | 2 |

Standing tasks, started by the coordinator whenever their trigger occurs:

| ID | Task | Model | Trigger | Output |
|---|---|---|---|---|
| H-01 | Citation check: every file:line and path in a named document still holds at a named commit | haiku | After C-02 (for this plan and all R reports), and on each Decision Record before sign-off | List of stale references with the current location |
| H-02 | Summarise run output: CI logs, `cargo test` logs, driver logs, perf JSON | haiku | After each Q run and each red CI job | One page: what failed, first failing line, counts, deltas against the named baseline file. No verdicts on cause |
| H-03 | Triage a capture set: list captures, missing cells of the matrix, obvious clipping or tofu | haiku | C-62, C-63, Q-10, Q-11 | Matrix with a status per cell; the coordinator inspects every flagged image |
| V-01 | Second-opinion review of an escalated package | sonnet | Each `sol` package, once staged | Findings against the spec, the ported rule and `CLAUDE.md`; edits nothing |
| S-01 | Draft worker specs from a signed-off Decision Record | sonnet | When the coordinator delegates it | Filled section-8 templates for the packages the record unblocks; the coordinator approves each before dispatch |

### 4.2 Decision Records (`fable`, effort high)

Each produces `$G/plan/decisions/D-xx-*.md`: question, options considered,
decision, consequences, and a file-level outline for the packages it unblocks.
The architect edits no code.

| ID | Question | Options to weigh | Inputs | Unblocks | Size |
|---|---|---|---|---|---|
| D-01 | How is the single worker thread replaced, and who owns in-flight state? | (a) transport actor + job pool + helper supervisor, (b) keep one worker with a priority lane, (c) per-domain actors. Covers: graceful helper quit instead of kill, refusals that leave the helper alive, playhead monotonicity, collapsing the `pending` fields on `Player`, a panic hook that retires helpers | R-01, R-05, R-11; `$G/src/integration.rs` (worker at line 877, kills at 1359/1376/1676), `$G/src/main.rs` (`struct Player`, line 421), `$G/TRANSPORT_TIMING_REVIEW.md` | C-17, C-18, C-19, C-20, C-22 | 2 |
| D-02 | What render architecture meets N1-N5, and how are presented frames measured on macOS? | Redraw gating by state, per-lane waveform caches (texture or path), lyrics layer caching, playhead as its own cheap layer, frame pacing against the audio clock; measurement options in 3.2. Must say whether vendored GPUI needs patching | R-05, Q-01, Q-02; `$G/src/waveform.rs`, `pitch_strip.rs`, `lyric_glow.rs`, `backdrop_clock.rs`, `ui_benchmark.rs`, `$G/LYRICS_HIGHLIGHT_STANDARD.md`, renderer perf rules in `CLAUDE.md` | G1, C-07 (mac leg), C-70 to C-73 | 3 |
| D-03 | How does Drive sync reach Electron's request count without changing what it uploads? | Batched `in parents` listing (50 per query) as in `src/main/sync-plan.ts`; HTTP transport: keep curl per request, persistent curl, or an in-process client; where `stemHashes`/`lyricsHash` write-back happens relative to the lease and the dirty ledger so it never re-dirties | R-01, R-09; `$G/src/drive_sync.rs`, `drive_plan.rs`, `drive_snapshot.rs`, `drive_http.rs`, `sync_dirty.rs`; `src/main/gdrive.ts` | C-11, C-12 | 2 |
| D-04 | How does the native app update itself, and how does an Electron install hand over? | Updater: own implementation against GitHub Releases, Sparkle/WinSparkle, or a signed-manifest swapper; prerelease channel; rollback. Handover: last Electron build offers native, or native installer imports on first run; which state is shared, imported once or left; bundle id, install path and name during coexistence | R-03, R-08; `src/main/updater.ts`, `docs/MACOS-SIGNING.md` | C-33, C-40 to C-44 | 3 |
| D-05 | What is the release layout and the reproducible build? | Crate location (stay in `experiments/` or move); how `singz-uikit` is pinned (git rev, submodule or vendored); release profile settings; a `test-hooks` feature that keeps env test gates out of shipped binaries while qualification can still drive a release build; bundle layout and signing order for app, three helpers, FFmpeg libraries, `llama-server`, `crispasr`; Windows installer technology; where splitter packs and models live | R-06, R-08; `$G/Cargo.toml`, `$G/DESKTOP_PACKAGING.md`, both packagers | C-19, C-30 to C-34, final form of C-03 | 2 |
| D-06 | What accessibility level ships, and how? | Patch vendored GPUI for AX/UIA, bridge through platform APIs outside GPUI, or ship keyboard-complete with a stated screen-reader gap. Must give a floor for the default gate and a cost for each option | R-10 | C-60, C-61 | 2 |
| D-07 | Does the GPUI helper move onto `AudioHostBackend`, and when? | Before default, after default, or never. Depends on PR #145 merging. Must state what changes for qualification if it moves late | R-11; RFC section "The Box audio host and LoopZ" | C-80 | 1 |

### 4.3 Coding: foundation (wave 0-1)

| ID | Task | Model | Depends | Inputs | Deliverable and acceptance | May edit | Size |
|---|---|---|---|---|---|---|---|
| C-01 | Upstream the Windows UTF-8 path fix to zCore | sol (file I/O used by every project read and write) | R-07 | Uncommitted `zcore/src/media/flac_io.cpp`, `wav.cpp`, new `zcore/include/zcore/base/utf8_file.h` | A zCore pull request with the fix and its CJK/emoji path test; after the human merges it, the new commit hash. Accept: zCore's own tests green on Windows | zCore repository only | 2 |
| C-02 | Bring the branch up to `origin/main` with the bumped zCore pin | sol (conflicts land in `native/playback/native_playback_session.cpp`, which is audio timing) | C-01, R-07 | R-07 report | Branch contains main; `third_party/zcore` at the C-01 commit; local `zcore/` copies of moved files gone. Accept: `cargo test` in `$G`, `npm run typecheck`, `npm test`, `npm run gates`, helper build on Mac and Windows, `$G/tests/test_native_audio.py` | Merge resolution only; no behaviour change | 4 |
| C-03 | Release profile and honest packaging inputs | reserve | C-02 | `$G/Cargo.toml` (`singz-uikit` path dependency at line 14, `ui-tests` feature), `scripts/build-gpui-native.py` (default output `target/debug`, line 235), both packagers, `tests/shared/test_package_gpui_*.py` | `[profile.release]` exists; packagers default to and document `target/release`, refuse a binary built with `ui-tests` and refuse a debug profile unless `--allow-debug`; `singz-uikit` pinned to an exact revision; `$G/DESKTOP_PACKAGING.md` commands updated. Accept: packager tests green; a release package launches hidden and exits cleanly | `$G/Cargo.toml`, `$G/Cargo.lock`, `$G/build.rs`, `scripts/package-gpui-*.py`, `scripts/build-gpui-native.py`, `tests/shared/test_package_gpui_*.py`, `$G/DESKTOP_PACKAGING.md` | 3 |
| C-04 | CI builds and tests the crate | sonnet (the workflow carries repository rules: pinned runner, `paths-ignore`, never an allow-list) | C-03, C-05 | `.github/workflows/checks.yml` (pins `ubuntu-24.04`, uses `paths-ignore`) | A job running `cargo build --release`, `cargo test`, `cargo clippy` and the helper build + C++ checks on macOS, Windows and `ubuntu-24.04`, cached. Accept: green on a PR; a deliberately broken test turns it red | `.github/workflows/` | 3 |
| C-05 | Remove the two known flakes | reserve | R-01 | `$G/src/drive_service_tests.rs` (12 s deadline at line 184), `$G/src/engine_status_tests.rs` (2 s probe timeout at line 38) | Root cause written down for each; fix without relaxing an assertion. Accept: 30 consecutive full `cargo test` runs under `--test-threads` at twice the core count, zero failures | The two test files and the modules they exercise | 3 |
| C-06 | Perf harness core, both apps | reserve | C-03 | `$G/tests/interface-perf.py`, `$G/tests/test_perf_gate.py`, `tests/e2e/win-visible-cpu.cjs`, `tests/shared/win-process-sample.ps1`, `tests/e2e/mac/player-session-e2e.cjs` | One scenario runner that drives either app through the 3.2 scenario and writes one JSON schema: process-tree CPU, footprint, startup, open time, `starvedBlocks`, package size. Deadlines on every step. Accept: unit tests for the evaluator; a run of each app on the Mac produces a complete file | New `tests/perf/` directory; `$G/tests/interface-perf.py` | 5 |
| C-07 | Presented-frame capture | reserve | C-06; mac leg waits for D-02's measurement choice | D-02 (mac), `$G/tests/windows_gpu_sampler.ps1`, `$G/tests/windows_hidden_runner.cs` | Windows: PresentMon wrapper giving per-frame present times, GPU per adapter and DWM share for a named process tree. macOS: the D-02 method. Output merges into the C-06 schema as fps, p50/p99 frame time, dropped frames. Accept: a 60 Hz and a 120 Hz run each report the panel rate within 1% on a static animation | `tests/perf/`, `$G/tests/windows_gpu_sampler.ps1` | 5 |
| C-16 | RFC Phase 0 case tables | sonnet (table authoring across vitest and Rust, modelled on the existing shared tables) | R-01 | RFC "Phase 0"; `tests/shared/currency-cases.json` as the model; `src/shared/lrclib-transport.ts`, `src/main/sync-plan.ts`, `src/renderer/src/audio/analysis.ts` | `tests/shared/core/` tables for staleness, lyric word tolerance, LRC parsing and `planProject`, each run by a vitest suite and a Rust test. Known Rust drifts are red or skipped with a reason naming the fixing package. Accept: `npm test` and `cargo test` both execute every table | `tests/shared/core/` (new), `tests/unit/` (new suites), one new `$G/src/*_tests.rs` | 4 |

### 4.4 Coding: defects (wave 2)

| ID | Task | Model | Depends | Inputs | Deliverable and acceptance | May edit | Size |
|---|---|---|---|---|---|---|---|
| C-10 | Lyrics files with backward or zero-length words load clamped; a file that fails to parse is never overwritten by auto-lookup | sol (edited lyrics can be lost) | R-01, C-16 | `$G/src/project_lyrics.rs:87-103`, `lyrics_resolution.rs`, `lyrics_store.rs`; TS tolerance at `src/main/align.ts` (`sanitizeHyp`) and `MIN_WORD_S`; Box's tolerant reader `src/shared/strict-lyrics.ts` and its 12-case table `tests/shared/lyrics-tolerance-cases.json` (on `main` since #145 merged as `c9465e4d`) | Loader passes `tests/shared/lyrics-tolerance-cases.json` (C-16 extends it rather than starting a second lyrics table), so Box and Rust return the same lines for the same file; an unreadable or `source: 'edited'` file blocks automatic replacement and surfaces a message. Accept: table green; a test proving auto-lookup leaves an edited file's bytes unchanged | `$G/src/project_lyrics.rs`, `lyrics_resolution.rs`, `lyrics_store.rs`, their tests | 3 |
| C-11 | Write refreshed `stemHashes` and `lyricsHash` back to the local `project.json` | sol (writes project documents during sync) | D-03 | `$G/src/drive_snapshot.rs:369`, `sync_dirty.rs`; `src/main/gdrive.ts` write-back | Second clean sync reads zero stem bytes; the write-back does not mark the project dirty; mtime tolerance matches Electron (about 2 ms). Accept: test counting stem reads across two syncs; a test with a truncated-mtime stem | `$G/src/drive_snapshot.rs`, `drive_sync.rs`, `drive_local_ops.rs`, tests | 4 |
| C-12 | Batched Drive listing | sol (changes what the reconcile sees; a wrong listing trashes files) | D-03, R-09 | `$G/src/drive_remote.rs`, `drive_plan.rs`, `drive_http.rs:295`, `drive_graph.rs` | Clean sync of 50 projects within Electron's request count plus the margin D-03 sets; transport per D-03; planner output byte-identical to before on the existing fixtures. Accept: request-count test against the fake Drive; all Drive suites green; orphan and `published` folder rules unchanged | `$G/src/drive_remote.rs`, `drive_http.rs`, `drive_sync.rs`, `drive_graph.rs`, tests | 5 |
| C-13 | Timeline and duration arithmetic in `f64` | sol (audio timing) | R-01 | Sites from R-01; `$G/src/integration.rs` (`duration: f32` at 397, comparison at 591), `project_pitch.rs`, `transport_timing.rs`, `region_gesture.rs` | A 12-minute and a 60-minute fixture open, play, seek, loop and save. Accept: new tests at 8, 9, 12 and 60 minutes; transport-timing suite green | Sites R-01 lists; no protocol change to the helper without D-01 | 4 |
| C-14 | Detector versions from the `zcore` headers; tolerant stamp reading | sol (a wrong staleness answer re-derives and auto-saves a library backwards) | R-01, C-02, C-16 | `$G/src/project_key.rs:14`, `project_pitch.rs:145`, `project_analysis.rs:256`, `beat_analysis.rs:26`, `$G/build.rs`; `zcore/include/zcore/legacy/{beats,analysis,melody}.h` (path changes after C-02) | `build.rs` generates the three constants from the headers; no literal remains; stamps read as numbers per `analysisIsStale` (missing, nonsense or lower re-derives; equal or newer is adopted). Accept: staleness table green; build fails if a header constant is missing | The four files, `$G/build.rs`, tests | 3 |
| C-15 | LRCLIB host-wide timeout cooldown and manual retry | reserve | R-01, C-16 | `$G/src/lrclib.rs` (`retry_now` at line 121 has no caller), `lyrics_sidebar_host.rs`; `src/shared/lrclib-transport.ts` | A timeout holds every endpoint for 60 s; manual retry has the 15 s floor and is wired to the UI action. Accept: tests mirroring `tests/unit/lrclib-backoff.test.ts` and `lrclib-transport.test.ts` | `$G/src/lrclib.rs`, `lyrics_sidebar_host.rs`, tests | 2 |
| C-17 | Transport on its own actor | sol (audio timing) | D-01 | D-01 outline; `$G/src/integration.rs`, `transport_host.rs` | Transport commands never queue behind a slow job. Accept: a test that holds a slow job open and measures play/pause/seek round-trip under the D-01 bound; `$G/tests/test_native_transport_timing_ui.py` on Mac and Windows | Files D-01 lists | 5 |
| C-18 | Helper supervisor: graceful quit, survivable refusals | sol (audio timing and session ownership) | C-17 | `$G/src/integration.rs` kill sites, `tools/native/singz-gpui-audio.cpp` | Helper exits on request within a bound, kill only as fallback after it; a refused command leaves the helper running and the song loaded. Accept: tests for both; no orphan helper after 50 launch/quit cycles on Mac and Windows | Files D-01 lists, `tools/native/singz-gpui-audio.cpp` | 4 |
| C-19 | Collapse `Player` pending state | reserve | C-17 | `$G/src/main.rs` `struct Player` | In-flight requests live in typed per-domain state as D-01 specifies; behaviour unchanged. Accept: full suite and all `test_native_*_ui.py` drivers green | `$G/src/main.rs` and modules D-01 names | 5 |
| C-20 | Playhead never steps backward except on seek, loop wrap or song change | sol (audio timing) | C-17 | `$G/src/transport_timing.rs`, `timeline_host.rs`; `tests/e2e/mac/count-in-e2e.cjs` for the rules | Rules ported from the count-in driver: pause hold, projection-immature stand-in, post-seek hold, loop fold. Accept: a sampling test per rule | `$G/src/transport_timing.rs`, `timeline_host.rs`, tests | 4 |
| C-21 | Filesystem hardening | sol (project save and move paths) | R-12 | R-12 report | Saves and moves are correct, or refuse with a clear message, on exFAT and SMB; Windows reserved names and trailing dots/spaces rejected at every name entry; `source-work` bounded and pruned. Accept: table tests for names; an exFAT disk image run on the Mac; a prune test | Sites R-12 lists | 5 |
| C-22 | Panic hook and crash record | reserve | D-01 | `$G/src/main.rs`, `diagnostics.rs`, `log_panel.rs` | A panic writes a crash record to the durable log, retires helpers and shows a message on next launch. Accept: an injected panic test | `$G/src/main.rs`, `diagnostics*.rs` | 2 |
| C-23 | Test gates out of release builds | reserve | D-05, R-06 | R-06 report; `$G/src/drive_auth.rs:68` (`SINGZ_GDRIVE_CONFIG`) | Every test-gate variable compiled only under the feature D-05 names; `SINGZ_GDRIVE_CONFIG` ignored in release; demo mode not reachable by environment in release. Accept: `strings` on the release binary finds none of the gated names; drivers still pass on the hooks build | Sites R-06 lists, `$G/Cargo.toml` | 3 |
| C-24 | Native-only strings through i18n | sonnet (keys typed across every locale folder) | R-04 | R-04 report; `src/shared/i18n/en/`, `ru/`, `zh-CN/` and the other locale folders | Every listed string is a key with all translations typed. Accept: `npm run typecheck`; `$G/tests/test_native_locale_ui.py`; R-04's grep finds nothing | `$G/src/` sites listed, `src/shared/i18n/` | 3 |

### 4.5 Coding: release pipeline (wave 3, after G1)

| ID | Task | Model | Depends | Inputs | Deliverable and acceptance | May edit | Size |
|---|---|---|---|---|---|---|---|
| C-30 | macOS bundle: Developer ID signing, notarization, dmg | reserve | D-05, C-03 | `scripts/package-gpui-macos.py`, `tools/native/gpui-input-info.plist`, `docs/MACOS-SIGNING.md`, `build/` entitlements *(inferred location)* | App, three helpers, FFmpeg libraries and engines signed inside-out with hardened runtime; `com.apple.security.device.audio-input` where a process captures; notarized and stapled dmg; ad-hoc fallback when secrets are absent. Accept: `spctl` accepts the app inside a quarantined mounted dmg; microphone prompt appears on a clean account (human) | Packager, new entitlements files, docs | 5 |
| C-31 | Windows installer and Authenticode | reserve | D-05, C-03 | `scripts/package-gpui-desktop.py`, R-08 | Installer per D-05, signed when a certificate is present, per-user install, uninstall leaves the library and models. Accept: install, launch, uninstall on the field laptop under a limited user with a non-ASCII profile path (human) | Packager, new installer sources | 5 |
| C-32 | Engines, packs and models in the shipped layout | reserve | D-05 | `$G/src/model_install.rs`, `model_catalog.rs`, `engine_status.rs`, `scripts/vendor-llama.sh`, `scripts/vendor-crispasr.sh`, `src/main/models.ts` (`PACK_FORMAT_REQUIRED`) | Shipped app finds bundled engines, shares `modelsDir`/`packDir` with Electron, enforces the same pack format, runs engines with `HF_HUB_OFFLINE=1`. Accept: a split and a transcription from the packaged app on both platforms | Listed Rust files, packagers | 4 |
| C-33 | Updater | sol (a bad swap bricks an install; part of the migration handoff) | D-04, C-30, C-31 | D-04; `src/main/updater.ts` for behaviour parity | Check, download, verify signature, swap, relaunch, roll back on failed first launch; stable and prerelease channels; state surfaced as Electron's is. Accept: update N to N+1 and a forced-failure rollback on both platforms from real signed artifacts | New `$G/src/updater*.rs`, settings UI hook, packagers | 7 |
| C-34 | Release workflow | reserve | C-04, C-30, C-31 | `.github/workflows/build.yml`, `docs/release-notes/` | Native artifacts built on `v*` tags and attached to the release; hyphenated tags are prereleases; native assets named so Electron's updater feed and the in-app pack URL are untouched. Accept: a `-test` tag produces signed native artifacts and leaves Electron's `latest` files unchanged | `.github/workflows/` | 4 |
| C-35 | Perf smoke gate in CI | reserve | C-06, Q-02 | C-06 harness, Q-02 numbers | The 3.3 smoke checks on release builds with thresholds from Q-02; a regression fails the job and prints the delta. Accept: an injected per-frame sleep turns it red | `.github/workflows/`, `tests/perf/` | 3 |

### 4.6 Coding: migration and coexistence (wave 3-4)

C-40 to C-43 are `sol`: each reads or rewrites a singer's settings, tokens or
library pointers. C-44 is `sonnet`: it edits the Electron tree under that tree's
conventions (i18n, IPC result objects) and moves no data itself.

| ID | Task | Depends | Inputs | Deliverable and acceptance | May edit | Size |
|---|---|---|---|---|---|---|
| C-40 | First-run import of Electron settings: library root, `settings.json` fields, window state, language, audio devices | D-04, R-03 | R-03 table | One-time, idempotent, never modifies Electron's files, records what it imported. Accept: fixture profiles for each userData identity on both platforms; re-run is a no-op | New `$G/src/migrate*.rs`, `settings.rs` | 4 |
| C-41 | Drive sign-in and sync ledger adoption | D-04, R-03 | `$G/src/drive_auth.rs`, `sync_dirty.rs`, `drive_state.rs`; `src/main/gdrive.ts`, `sync-dirty.ts` | The singer is not asked to sign in again unless D-04 says so; the first native sync after adoption uploads nothing on a clean library. Accept: fake-Drive round trip Electron → native with a zero-upload assertion | Listed Rust files | 4 |
| C-42 | Shared models, packs and caches | C-32, R-03 | R-03 table | Native reuses Electron's downloaded models and splitter cache where formats match; no re-download. Accept: a profile with models present triggers zero downloads | `$G/src/model_*.rs`, `source_jobs.rs` | 2 |
| C-43 | Two desktops, one Drive library | C-12, D-04 | `$G/src/drive_sync.rs`, `drive_adopt.rs`, `drive_retirement.rs`; `src/main/gdrive.ts`; `tests/unit/gdrive-sync.test.ts` *(inferred path)* | `catalog.json` from native is byte-compatible format 2 with the same `capabilities`; alternating syncs from both desktops converge and do not rewrite the catalog at each other; phone-published folders are safe under either. Accept: a cross-writer suite driving the real TS sync and the Rust sync against one fake Drive | Rust Drive files, new `tests/roundtrip/` suite | 5 |
| C-44 | Electron-side handover | D-04, C-33 | D-04; `src/main/updater.ts`, `src/main/whats-new.ts` | What D-04 specifies for the last Electron desktop build, with a way back during beta. Must not change the Box build. Accept: an Electron install follows the path to native on both platforms and returns | `src/main/`, `src/renderer/` sites D-04 names | 3 |

### 4.7 Qualification (wave 1 and wave 4-5)

| ID | Task | Who | Depends | Deliverable and acceptance | Size |
|---|---|---|---|---|---|
| Q-01 | Electron baseline | reserve to run on Mac; human for the laptop | C-06, C-07 (Windows leg) | `$G/plan/Q-01-electron-baseline.json` + summary for both machines, 3 runs per cell, at a named release tag | 2 |
| Q-02 | Native release baseline and 120 FPS probe | reserve; human for the laptop | C-03, C-06, C-07 | Same schema as Q-01 for native release builds, plus the probe: on a 120 Hz panel, presented FPS and frame-time distribution for the reference scenario and for an empty animating window. States the gap to each budget | 3 |
| Q-03 | Native transport and timing checks for R-02 gaps | sol (audio timing) | R-02, C-17, C-20 | New `$G/tests/test_native_*.py` drivers for count-in, early and double Play, loop ahead of the playhead, quarter-second loop, play-out then Play again, scrub out of the last seconds, `starvedBlocks`. Each fails on the unfixed behaviour (mutation-checked) | 6 |
| Q-04 | Native analysis and lyrics race checks | sol (a late result is auto-saved into the wrong song) | R-02, C-10, C-14 | Drivers for song switch during pitch, lookup and candidate pick; stem-rate framing at 44.1 and 48 kHz; stamp upgrade; lyrics cancel restores the shown lines; align and editor align-draft paths | 5 |
| Q-05 | Native open, edit and settings checks | sonnet (driver, deadline and mute conventions) | R-02 | Drivers for open without decode, bar drag and Re-detect, wizard and consent, audio settings, Space focus, played edge on the playhead line | 5 |
| Q-06 | Register the native lane | sonnet | Q-03 to Q-05 | `.claude/agents/e2e-verifier.md` gains a native-mac and a native-windows-field lane listing every driver; a unit test refuses a native driver without a deadline | 1 |
| Q-10 | Full native run, Mac | coordinator via `e2e-verifier` | Q-06, wave 2 complete | Every native driver green on a release build; report | 2 |
| Q-11 | Full native run, Windows field laptop | human + coordinator | Q-06 | Same on real WASAPI, with the Electron control run beside it | 3 |
| Q-12 | Real Google account | human | C-12, C-43 | Sign-in from the packaged app, full sync of the real library, phone opens a song, phone-published song adopted, second desktop converges. Request count recorded | 2 |
| Q-13 | Physical microphone and hotplug | human | C-30, C-31 | Permission prompt on a clean account, built-in and USB input, unplug during capture and during playback, Bluetooth route latency, both platforms | 2 |
| Q-14 | Long songs and large library | reserve | C-13, C-21 | 12- and 60-minute songs, a 200-project library, a library on exFAT and on SMB; N9-N11 hold | 3 |
| Q-15 | Full budget run, both machines | human + coordinator | C-70 to C-73, Q-10, Q-11 | N1-N14 table, native against Q-01, three runs, visible display | 3 |
| Q-16 | Beta cohort | human | C-33, C-34, C-44, Q-12, Q-13 | At least two weeks of prerelease use; every report triaged; crash records reviewed | calendar |

### 4.8 Parity and polish (wave 4)

| ID | Task | Model | Depends | Deliverable and acceptance | May edit | Size |
|---|---|---|---|---|---|---|
| C-60 | Accessibility implementation, macOS | reserve | D-06 | The D-06 floor on every route: roles, labels, values, actions, focus order. Accept: `$G/tests/test_native_accessibility.py` extended to whole-app; a VoiceOver walk by the human | Per D-06 | 8 |
| C-61 | Accessibility implementation, Windows | reserve | D-06, C-60 | Same floor through UIA. Accept: an automated UIA tree check; a Narrator walk by the human | Per D-06 | 8 |
| C-62 | Narrow widths and clipping | reserve | — | No clipped control at the minimum window size in any locale, including the title editor and Open label noted in `$G/SCREEN_PORT_STATUS.md`. Accept: capture matrix at minimum and default size, all shipped locales | `$G/src/` layout modules, `../singz-ui/gpui` via its own pin bump | 5 |
| C-63 | Remaining visual and temporal parity | reserve | C-62 | The fixture/state matrix `$G/DESKTOP_ACCEPTANCE_GAPS.md` calls for, long-clock and localized ruler included; the approved lyric highlight standard preserved | `$G/src/`, `$G/tests/reference/` | 5 |

### 4.9 Optimisation (wave 4, after G0 and D-02)

The split below is provisional. D-02 replaces it with packages sized to the
measured gaps; if Q-02 already meets a budget, its package is dropped.

| ID | Task | Model | Depends | Acceptance | Size |
|---|---|---|---|---|---|
| C-70 | Redraw gating: no frame without a state change | reserve | D-02, R-05 | N5 and N6 on both machines | 4 |
| C-71 | Lane and playhead rendering to D-02's design | reserve | D-02 | N1-N4 with lanes only | 5 |
| C-72 | Lyrics and pitch strip rendering to D-02's design | reserve | D-02, C-71 | N1-N4 on the full reference scenario; highlight standard unchanged | 5 |
| C-73 | Memory and open time | reserve | Q-02 | N9, N10, N12, N13 | 4 |
| C-80 | Helper onto `AudioHostBackend` (only if D-07 says before default) | sol (audio timing) | D-07, PR #145 merged, C-18 | Session harness and Q-03 green on both machines; N11 | 8 |

## 5. Waves and critical path

| Wave | Runs in parallel | Exit |
|---|---|---|
| 0 | R-01 to R-12 (all read-only, all at once). C-01 as soon as R-07 lands | Reports reviewed by the coordinator; zCore PR open |
| 1 | C-02 → C-03 → {C-04, C-06}. C-05, C-16 alongside. C-07 Windows leg. Then Q-01 and Q-02. D-01, D-03, D-04, D-05, D-06, D-07 can start as their inputs land | **G0**: baselines on both machines. Crate builds and tests in CI |
| 1b | D-02 (needs Q-01, Q-02, R-05), then C-07 mac leg and a re-run of the probe | **G1**: 120 FPS reachable, with the path named. If not, stop and take the result to the user before wave 3 |
| 2 | C-10, C-13, C-14, C-15, C-21, C-24 at once. C-11 → C-12. C-17 → {C-18, C-19, C-20}. C-22, C-23. No two packages share an edit list; `integration.rs` and `main.rs` are owned by the C-17 chain during this wave | Every review finding closed or explicitly deferred with a reason; case tables green on Rust |
| 3 | C-30, C-31, C-32 at once; then C-33, C-34, C-35. C-40, C-41, C-42 alongside | A signed, notarized, self-updating prerelease on both platforms |
| 4 | Q-03, Q-04, Q-05 → Q-06. C-43, C-44. C-60 → C-61, C-62 → C-63. C-70 → C-71 → C-72, C-73 | Native lane registered; budgets met on the Mac |
| 5 | Q-10, Q-11, Q-12, Q-13, Q-14, Q-15, then Q-16 | Default gate (section 6) |

**Critical path.**
R-07 → C-01 → C-02 → C-03 → C-06/C-07 → Q-01/Q-02 → D-02 (G1) → D-01 → C-17 →
C-20 → Q-03 → Q-06 → Q-10/Q-11 → Q-15 → Q-16 → default.

The release pipeline (C-30 to C-34) is off the critical path until Q-16, which
cannot start without it. Start it the day G1 passes.

**Why the probe is early.** If vendored GPUI cannot present at 120 Hz on the
target panels, or can only do so with a renderer change, that is known after about
three weeks and before any signing, installer or updater work is paid for.

**Human-only steps.**

| Step | Needed by |
|---|---|
| Merge the zCore pull request and approve the pin bump | C-02 |
| Windows field laptop sessions (interactive-session scheduled task) | Q-01, Q-02, C-17, C-18, C-31, Q-11, Q-15 |
| A 120 Hz display for the Mac runs, dedicated or virtual (deferred 2026-11-11; 60 Hz gate meanwhile) | Q-02 re-run, Q-15 |
| Apple Developer ID and App Store Connect key in CI secrets | C-30, C-34 |
| Windows code-signing certificate decision | C-31 |
| Real Google account and a phone | Q-12 |
| Physical microphones, USB and Bluetooth | Q-13 |
| VoiceOver and Narrator walks | C-60, C-61 |
| Beta testers | Q-16 |
| Each decision record's sign-off, D-02 and D-04 above all | waves 1b, 3 |

## 6. Phase exits and the default gate

| Phase | Exit |
|---|---|
| Foundation | Branch contains main; zCore pin carries the UTF-8 fix; release profile; CI green on three platforms; no known flake |
| Baseline | Q-01 and Q-02 files committed; G1 decided |
| Defects | R-01's table shows every finding fixed with a test, or deferred in writing; C-16 tables green on both languages |
| Release | A prerelease tag yields signed artifacts that install, update and roll back on both platforms |
| Migration | An Electron profile moves to native with no re-sign-in surprise, no re-download and a zero-upload first sync; both desktops converge on one Drive library |
| Qualification | Native lane in `e2e-verifier.md`; every R-02 guarantee covered or waived by the user by name |
| Polish | D-06 floor met on both platforms; no clipping at minimum size in any locale |
| Optimisation | N1-N14 met on the Mac |

**"Native becomes default" requires all of the following.** Any miss is a no-go.

1. N1-N14 met on the Mac and on the Windows field laptop in Q-15, release builds,
   visible display, against the Q-01 baseline.
2. Q-10 and Q-11 green on the same commit, with the Electron control beside the
   laptop run.
3. Q-12, Q-13 and Q-14 passed.
4. Q-16: two weeks of beta with no open data-loss, sync or playback-timing report,
   and no unexplained crash record.
5. Updater and rollback exercised from real signed artifacts on both platforms.
6. The Electron handover (C-44) and the way back both work.
7. The D-06 accessibility floor is met, or the user has accepted the stated gap.
8. Package size within N14.
9. The user says go.

After the switch, Electron desktop releases continue for one release as the
fallback *(inferred; D-04 decides)*, and the Electron tree stays for Box.

## 7. Risks, estimate, cost

### 7.1 Risks

| Risk | Likelihood | Effect | Response |
|---|---|---|---|
| Vendored GPUI cannot hold 120 presented FPS, or redraws the whole window per playhead step | medium | N1-N3 missed; renderer work in `$G/vendor/` | Probe at G1. D-02 may add a vendor-patch package. Budget change only by the user |
| Presented-frame measurement on macOS has no method that works for both apps | medium | No like-for-like N1-N3 on the Mac | D-02 picks; fall back to a capture-based observer for both |
| GPUI screen-reader support is thin | high | C-60/C-61 grow from 3 to 6+ weeks | R-10 and D-06 early; the floor is the user's call |
| Merge with main is harder than forecast (zCore move, 88 commits) | medium | Wave 1 slips; everything waits | R-07 first; C-02 on the escalated model; nothing else edits native code meanwhile |
| Worker split destabilises transport | medium | Timing regressions late | C-17 before Q-03; Mac and Windows together; port the count-in rules as tests first |
| Two desktops fight over one Drive library | medium | Data loss in the field | C-43 before any beta build has sync enabled; Q-12 on a copy of the library first |
| Test gates or debug paths ship | medium | Field behaviour steered by environment | C-23, and the packager refusal in C-03 |
| Windows-only failures found late | high | Qualification loops | Laptop runs from wave 1, not wave 5 |
| PR #145 does not merge in time | medium | C-80 cannot start | D-07 defaults to "after default" |
| Cheap models produce plausible wrong fixes on rule ports | medium | Drift from TypeScript | C-16 tables first; escalated model on data-loss rows; reviewer gate on every commit |
| Updater bricks an install | low | Unrecoverable in the field | Rollback is part of C-33's acceptance; Q-16 exercises real updates |

### 7.2 Estimate

Engineer-weeks, one worker-week = 5 worker-days, including coordinator review.

| Step | Prior | Refined | Packages | Note |
|---|---|---|---|---|
| Research, decisions, standing reviews | — | 2.5-3.5 | R-01 to R-12, D-01 to D-07, H-01 to H-03, V-01, S-01 | New line; mostly cheap and parallel |
| Merge with main and zCore upstream | — | 1-1.5 | C-01, C-02 | Not in the prior estimate |
| 0 Baseline and harness | 2 | 2.5-3.5 | C-06, C-07, Q-01, Q-02 | macOS present timing is the unknown |
| 1 Defects | 2-3 | 4-5.5 | C-10 to C-24, C-16 | The worker split and filesystem work are larger than first sized |
| 2 CI and reproducible build | 1-2 | 1.5-2 | C-03, C-04, C-05 | |
| 3 Release pipeline | 3-4 | 4-5.5 | C-30 to C-35 | Updater alone is 1.5 |
| 4 Migration and coexistence | 2-3 | 2.5-3.5 | C-40 to C-44 | |
| 5 Qualification | 4-6 | 5-7 | Q-03 to Q-15 | Plus Q-16's two calendar weeks |
| 6 Parity and polish | 3-5 | 3.5-6 | C-60 to C-63 | Upper bound is accessibility |
| 7 Optimisation | 2-4 | 2-4 | C-70 to C-73 | Up to 6+ if G1 demands renderer work |
| Optional | — | 1.5 | C-80 | Only if D-07 says before default |
| **Total** | **19-29** | **29-41** (30.5-42.5 with C-80) | | |

The total rose because the merge with main, the research and decision work, and the
native qualification drivers are now counted, and the worker split was undersized.

Calendar time is bound by qualification, not coding. With three to four coding
workers in parallel, waves 0-4 fit in about 10-12 weeks. Laptop sessions, the real
Google and microphone runs and the two-week beta add 4-6 weeks that more workers
cannot shorten. Plan on four to five months.

### 7.3 Why the tiers are assigned as they are

- Research is the cheapest model because the work is reading and tabulating, the
  output is checked by the coordinator against the files, and a miss costs a
  re-run. Twelve inventories up front remove most of the exploration from the
  expensive tiers.
- Seven decisions go to the architect model because each one fixes a structure
  that several packages then build on; a wrong call there is paid for many times.
  They total about 15 worker-days, a small share of the plan.
- Default coding uses the affordable model because, once the decision record and
  the case tables exist, most packages are bounded edits with a test to pass.
- Sonnet takes the six packages where the difficulty is this repository's own
  conventions rather than the algorithm (C-04, C-16, C-24, C-44, Q-05, Q-06), and
  it reviews every escalated Codex package. A reviewer from a different model
  family than the author catches a different class of mistake, at a fraction of
  the cost of a field incident.
- Haiku takes work that is search plus summary: two inventories, citation checks,
  log summaries and capture triage. It never judges cause or correctness; the
  coordinator does.
- Nineteen packages are escalated to `gpt-6.1-sol`. Each sits where a plausible-looking mistake
  loses a singer's lyrics, re-uploads or trashes a library, or moves audio in
  time, and where the defect would not show in a unit suite. The extra model cost
  is small beside one field incident.
- The coordinator reviews everything. That is the control that lets the coding
  tier be cheap.

## 8. Worker spec template

```markdown
# <ID> <title>

Dispatch: --agent <claude|codex> --model <id> --effort <low|medium|high>
Worktree: <new-top-level | new-child of <ID> | shared read-only>
Base commit: <sha>

## Goal
<One or two sentences: what is true when this is done.>

## Context you need
- Read first: <exact files, with line ranges where known>
- Decision record or research report this builds on: <path>
- Behaviour to match: <TypeScript file or driver that states the rule>
- Already ruled out: <what not to re-investigate>

## Scope
- You may edit: <exact files or directories>
- You may not edit: anything else. If you need to, stop and ask.
- Read-only task: <yes/no>. If yes, your only output is <report path>.

## Acceptance evidence
- Commands that must pass: <exact commands>
- New tests required: <what each proves; it must fail before your change>
- Measurements required: <scenario, build profile, machine, three runs>
- Platforms: <mac | mac + Windows field laptop (coordinator arranges the laptop)>

## Rules
- Do not commit, push or stage-and-commit. Stage your final diff and stop.
- Run the app only muted and hidden (SINGZ_MUTE=1; hidden capture path).
- Every driver you add has a per-step budget and a total deadline.
- After native changes rebuild the helpers and prove the binary is the new one.
- Never pipe a build into tail/head; redirect and check the exit code.
- No new user-visible string without i18n keys in every locale.
- Never relax an assertion or a deadline to get green. Report it instead.

## Report back (worker_done)
- What changed, file by file.
- Evidence: command output paths, test names, numbers with profile/machine/commit.
- What you could not verify, and why.
- Anything you saw outside scope that the coordinator should know.
```

## 9. Verification notes

### 9.1 Review findings and where they were checked

| Finding | Checked | Status |
|---|---|---|
| Packaging consumes `target/debug` | `scripts/build-gpui-native.py:235`; `$G/DESKTOP_PACKAGING.md` commands | Confirmed |
| No release profile; `ui-tests` feature can ship; `singz-uikit` unpinned sibling path | `$G/Cargo.toml` (only `[profile.dev]`; feature at line 8; path dependency at line 14) | Confirmed |
| No CI builds or tests the crate | No `cargo` or `gpui` in `.github/workflows/*.yml` | Confirmed |
| Backward lyric word refuses the file | `$G/src/project_lyrics.rs:87-103` | Confirmed. The auto-lookup overwrite that follows was not traced |
| `stemHashes` not written back | `$G/src/drive_snapshot.rs:369` sets the uploaded document | Confirmed at that line; absence of a local write not exhaustively proven |
| One curl process per Drive request | `$G/src/drive_http.rs:295` | Confirmed. The request count is the RFC's estimate; R-09 measures it |
| `f32` duration fails songs over about 8.5 minutes | `duration: f32` at `$G/src/integration.rs:397`, comparison at 591; 512 s is where `f32` spacing doubles | Failing site not located; R-01 |
| Detector versions hand-typed; beat via `include_str!`; `as_u64` | `project_key.rs:14`, `project_pitch.rs:145`, `project_analysis.rs:256`, `beat_analysis.rs:26` | Confirmed |
| LRCLIB: no host cooldown; `retry_now` unused | `$G/src/lrclib.rs:121` defines it; RFC states no caller | Definition confirmed; callers per the RFC |
| Helper force-killed | `child.kill()` at `$G/src/integration.rs:1359`, `1376`, `1676` | Confirmed kills exist; "always" not proven |
| Single worker thread | `$G/src/integration.rs:877` | Confirmed one main worker; job threads are spawned from it |
| About 58 pending fields on `Player` | `$G/src/main.rs:421`, a 340-line struct | 23 fields with `pending` in the name were counted; the 58 was not reproduced |
| No panic hook | No `set_hook` in `$G/src` | Confirmed |
| Environment test gates and `SINGZ_GDRIVE_CONFIG` | `$G/src/drive_auth.rs:68`; about 55 distinct `SINGZ_GPUI_*` names read | Confirmed |
| Flaky `drive_service` tests, 12 s deadline | `$G/src/drive_service_tests.rs:184`; the file has 23 tests | Deadline confirmed; "20 flaky" not reproduced |
| Intermittent engine-probe timeout | `$G/src/engine_status_tests.rs:38`; recorded in `$G/DESKTOP_ACCEPTANCE_GAPS.md` | Confirmed as recorded |
| Branch 88 behind main; zCore is a submodule there | `git rev-list`; `.gitmodules` on `origin/main` | Confirmed. The pin on `origin/main` was `b3364438` until #145 merged; it is `96ead8fc` (Box's pin) now, so C-01 targets `96ead8fc`; R-07 settles which commit carries narrow-path opens |
| Refusals kill the helper; playhead monotonicity; exFAT/SMB; `source-work` growth; reserved names; hard-coded strings | Not checked | R-01, R-04, R-12 |

### 9.2 Other items not verified

- The `orca orchestration worker-start` flags are as given to the author, not
  checked against the CLI.
- `tests/shared/core/` does not exist yet; C-16 creates it.
- `tests/e2e/mac/` holds 25 files, some of them shared helpers rather than
  drivers; the root `CLAUDE.md` counts twenty-one drivers. R-02 settles the roster.
- Whether the Electron Windows installer is Authenticode-signed today.
- The macOS presented-frame methods in 3.2 are candidates, not tested here.
- `AudioHostBackend` was confirmed on `origin/codex/box-app` through
  `native/electron/audio_monitor_session.h`; the constructor
  `NativePlaybackSession(std::unique_ptr<AudioHostBackend>)` was seen only at a
  call site in `mobile/native/bindings/android/native_playback_jni.cpp`.
- The 1,029-test count comes from the port's own status notes; the suite was not
  run for this plan.

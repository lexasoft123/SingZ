# R-04: User-visible Rust strings that bypass i18n

Base commit: `f7607311` on `codex/gpui-interface`. Paths are repo-relative; `$G` = `experiments/gpui-player`.
Scope: `$G/src/*.rs` minus `*_tests.rs` and `ui_*.rs` (147 files). Inline `#[cfg(test)] mod` blocks were skipped.
Dictionary read: `src/shared/i18n/en/*.ts` (the `en` source; `t()` resolves through `$G/build_i18n.rs` and `$G/src/i18n.rs:175-180`).

"Existing key" means the exact English text already exists in `src/shared/i18n/en/`. "Near" means the text differs slightly (punctuation, ellipsis, wording).

## 1. User-visible literals bypassing i18n

### 1a. Native menus, dialogs, and window chrome

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/desktop_lifecycle.rs:52` | `Settings…` | macOS app menu item | none | `menu.settings` |
| `$G/src/desktop_lifecycle.rs:56` | `Quit SingZ` | macOS app menu item | none | `menu.quit` |
| `$G/src/desktop_lifecycle.rs:58` | `Window` | menu title | none | `menu.window` |
| `$G/src/desktop_lifecycle.rs:58` | `Close Window` | menu item | none | `menu.closeWindow` |
| `$G/src/main.rs:2370` | `Choose a folder for your project library` | native folder picker prompt | none | `dialog.chooseLibraryFolder` |
| `$G/src/main.rs:2443` | `Open audio, a SingZ project folder or project.json` | native file picker prompt | none | `dialog.openProjectSource` |
| `$G/src/custom_tracks_host.rs:235` | `Add audio tracks` | native file picker prompt | none | `dialog.addAudioTracks` |

Not listed: `SingZ` menu title (brand) and the OS `Services` submenu (OS-localized).

### 1b. Search, modal, and status labels in the shell

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/library.rs:228` | `Search projects…` | search input placeholder | `library.ts:55` `library.dropScreen.searchPlaceholder` (exact) | reuse |
| `$G/src/main.rs:6064` | `Opening project…` | modal card while opening | none | `main.loading.openingProject` |
| `$G/src/main.rs:1752` | `Preparing…` | `source_status.label` (progress) | none exact (`settings.ts:92` `settings.monitor.preparingButton` is same text, wrong namespace) | `main.source.preparing` |
| `$G/src/main.rs:6083` | `Preparing…` | progress label | as above | `main.source.preparing` |
| `$G/src/main.rs:5288` | `Loading stems…` | split progress stage | near: `library.ts:168` `library.splitWorkflow.loadingStems` = `Loading stems` (no ellipsis) | reuse key; decide ellipsis |
| `$G/src/main.rs:5433` | `Monitor needs attention` | header monitor label | exact: `settings.ts:247` `settings.persistentMonitor.needsAttention` | reuse |
| `$G/src/main.rs:5434` | `Stopping monitor` | header monitor label | exact: `settings.ts:246` `settings.persistentMonitor.stopping` | reuse |
| `$G/src/main.rs:5435` | `Mic monitoring` | header monitor label | exact: `settings.ts:248` `settings.persistentMonitor.micMonitoring` | reuse |
| `$G/src/main.rs:5436` | `Starting monitor` | header monitor label | exact: `settings.ts:245` `settings.persistentMonitor.starting` | reuse |
| `$G/src/main.rs:4446` | `No synced lyrics in this project.` | lyrics status | none | `main.lyrics.noSynced` |
| `$G/src/main.rs:4078` | `No steady beat found in the drums.` | notice | near: `player.ts:65` (longer text), `app.ts:140` | `main.beat.noSteadyBeat` |
| `$G/src/main.rs:4386` | `This control is not available in this version yet.` | notice | none | `main.notice.controlUnavailable` |
| `$G/src/main.rs:5778` | `This lyrics action is not connected yet.` | notice | none | `main.notice.lyricsUnconnected` |
| `$G/src/main.rs:1825` | `Queued Save was cancelled before it completed.` | notice | none | `main.notice.queuedSaveCancelled` |
| `$G/src/main.rs:2475` | `Native handoff command queue is full` | notice | none | `main.notice.handoffQueueFull` |
| `$G/src/main.rs:4165` | `The Save could not be started.` | notice fallback | none | `main.notice.saveNotStarted` |
| `$G/src/main.rs:4150` | `Queued Save could not run because its project is no longer available.` | notice | none | `main.notice.queuedSaveNoProject` |
| `$G/src/main.rs:4102` | `Metronome audio cannot change while the current audio owner is busy.` | notice | none | `main.notice.metronomeBusy` |
| `$G/src/main.rs:3720` | `Saved training settings are still loading. Try Start again.` | notice | none | `main.notice.trainingLoading` |
| `$G/src/main.rs:3750` | `Review the saved microphone device in Settings.` | notice | none | `main.notice.reviewMicSettings` |
| `$G/src/main.rs:2308` | `Stop microphone monitoring before adding this project to your library.` | notice | none | `main.notice.stopMonitorForLibrary` |
| `$G/src/main.rs:891` | `The song changed. Reopen the editor before saving.` | lyrics editor status | none | `main.lyrics.songChanged` |
| `$G/src/main.rs:897` | `Open a project before saving lyrics.` | lyrics editor status | none | `main.lyrics.openProjectFirst` |
| `$G/src/main.rs:3085` | `The draft changed while alignment was running. Align again to use your latest words.` | lyrics editor status | none | `main.lyrics.alignChanged` |
| `$G/src/main.rs:4033` | `The draft changed during the download. Align again to use your latest …` | lyrics editor status | none | `main.lyrics.downloadChanged` |
| `$G/src/main.rs:2054`, `:3189`, `:4166` | `Queued Save failed: {error}` (`format!`) | notice | none | `main.notice.queuedSaveFailed` with `{error}` |
| `$G/src/main.rs:3218`, `:3220`, `:3223` | `Queued Save … native audio failed …: {error}` (`format!`) | notice | none | `main.notice.queuedSaveAudioFailed` with `{error}` |

Prototype / review-fixture notices (labelled `*(inferred)*` as fixture-only; they still bypass i18n if reachable):

| file:line | literal | proposed key |
|---|---|---|
| `$G/src/main.rs:1100` | `Choose a catalog card to preview the player. File loading is not connected in this prototype.` | `main.notice.previewPrototype` |
| `$G/src/main.rs:1102` | `Projects are shown from the review fixture. Storage changes are not connected in this prototype.` | `main.notice.storagePrototype` |
| `$G/src/main.rs:1210` | `Mix changes remain local to this prototype.` | `main.notice.mixPrototype` |
| `$G/src/main.rs:1212` | `The review fixture stays in place. Library import is not connected in this prototype.` | `main.notice.importPrototype` |
| `$G/src/main.rs:1214` | `Open a song from the catalog to preview it.` | `main.notice.openToPreview` |
| `$G/src/main.rs:1267` | `Line continuation is not connected in this prototype.` | `main.notice.lineContinuationPrototype` |
| `$G/src/main.rs:1270` | `Stem files are supplied by the review fixture.` | `main.notice.stemsFixture` |
| `$G/src/main.rs:1275` | `Model inference is available in the native app, outside demo mode.` | `main.notice.modelDemo` |
| `$G/src/diagnostics_host.rs:113` | `Saving log files is not connected in this prototype.` | `diagnostics.notice.savePrototype` |
| `$G/src/diagnostics_host.rs:100`, `:228` | `That session log is no longer kept.` | `diagnostics.notice.sessionGone` (`diagnostics.rs:699` has the same text as an `ensure!`) |

### 1c. Settings and audio route

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/settings.rs:428` | `Loading native devices…` | device dropdown placeholder | none | `settings.output.loadingDevices` |
| `$G/src/settings.rs:439` | `Choose playback device…` | dropdown option | exact: `settings.ts:80` `settings.monitor.choosePlaybackDevice` | reuse |
| `$G/src/settings.rs:441` | `System default` | dropdown option | exact: `settings.ts:5` `settings.common.systemDefault` | reuse |
| `$G/src/settings.rs:95` | `Choose playback device…` (`MONITOR_OUTPUTS`) | dropdown option (non-native path) | as above | reuse |
| `$G/src/settings.rs:89`, `:91` | `System default` (`OUTPUTS`) | dropdown option (non-native path) | as above | reuse |
| `$G/src/settings.rs:961` | `No channels` | channel dropdown | none | `settings.mic.noChannels` |
| `$G/src/settings.rs:1074` | `Waiting for microphone…` | mic status | none | `settings.mic.waiting` |
| `$G/src/settings.rs:1080` | `Microphone permission required` | mic status | none | `settings.mic.permissionRequired` |
| `$G/src/settings.rs:1081` | `Microphone unavailable` | mic status | none plain (`player.ts:194` is `…while Settings is open`) | `settings.mic.unavailable` |
| `$G/src/settings.rs:1082` | `Microphone is off` | mic status | none | `settings.mic.off` |
| `$G/src/settings.rs:1087` | `Microphone capture unavailable` | mic status | none | `settings.mic.captureUnavailable` |
| `$G/src/settings.rs:1247` | `Microphone preview is off.` | mic preview text | none | `settings.mic.previewOff` |
| `$G/src/settings.rs:1281` | `Enable microphone` / `Retry microphone` | button label | none (`settings.ts:254` is an aria label) | `settings.mic.enable`, `settings.mic.retry` |
| `$G/src/settings.rs:1397` | `Buffer pending` | DSP graph label | exact: `player.ts:226` `player.dspGraph.bufferPending` | reuse |
| `$G/src/settings.rs:1622` | `Starting monitoring pauses song playback. Stop restores it paused.` | help text | none | `settings.monitor.startPausesPlayback` |
| `$G/src/settings.rs:1867` | `Applying output route… Playback will stay paused.` | hint | none | `settings.route.applying` |
| `$G/src/settings.rs:1869` | `Native DSP playback is always enabled.` | hint | none | `settings.dsp.alwaysOn` |
| `$G/src/integration.rs:2343` | `Native output is unavailable` | `TransportFailed` event text *(inferred: shown in transport error)* | none | `transport.outputUnavailable` |
| `$G/src/integration.rs:2532`, `:2150`, `:2352`, `:2849`, `:2315` | `Stop microphone monitoring before …` (5 variants) | error text *(inferred: surfaced as notice)* | none | `main.notice.stopMonitorBefore*` |
| `$G/src/integration.rs:599` | fallback `Native Carry the line apply was not confirmed` | error text | none | `carryLine.applyUnconfirmed` |

### 1d. Pitch strip (player)

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/pitch_strip.rs:42` | `Microphone unavailable` (`MIC_UNAVAILABLE`) | mic label | none plain (see settings.rs:1081) | `player.pitch.micUnavailable` |
| `$G/src/pitch_strip.rs:240` | `Stopping…` | mic label, mixed with i18n arms at `:238-239` | none | `player.pitch.micStopping` |
| `$G/src/pitch_strip.rs:242` | `Mic unavailable` | mic label | none | `player.pitch.micUnavailableShort` |
| `$G/src/pitch_strip.rs:243` | `Monitoring owns microphone` | mic label | none | `player.pitch.micMonitoringOwns` |
| `$G/src/project_pitch.rs:95`, `:140`, `:143`, `:146` | `Saved pitch data is invalid.` / `…invalid source duration.` / `…belongs to a different song duration.` / `…needs updating.` | `warning` text shown by pitch strip *(inferred)* | none | `player.pitch.warning.*` |

Note: `pitch_strip.rs:351` compares `warning` to the literal `Analyzing vocals…`, and `main.rs:2867` compares to `Analyzing song…` (also `integration.rs:2632` produces it). These are sentinel comparisons on display text, so they break if the text is translated.

### 1e. Source jobs and progress text

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/source_jobs.rs:1156` | `Updating lyrics…` | progress label (`progress()`) | none | `library.progress.updatingLyrics` |
| `$G/src/source_jobs.rs:1216` | `Reading audio…` | progress label | none | `library.progress.readingAudio` |
| `$G/src/source_jobs.rs:1219` | `Decoding audio…` | progress label | near: `library.ts:47` `library.dropScreen.decodingAudio` (different text) | `library.progress.decodingAudio` |
| `$G/src/source_jobs.rs:1406` | `Saving project…` | progress label | none | `library.progress.savingProject` |
| `$G/src/source_jobs.rs:1240`, `:1277` | `Checking splitter…`, `Preparing audio…` | progress label; reverse-mapped by `split_label` (see 2a) | none exact (`warmingUp` covers `Preparing…`) | `library.splitWorkflow.warmingUp` (for `Preparing…`); new key for `Checking splitter…`, `Preparing audio…` |
| `$G/src/source_jobs.rs:242`, `:1632` | `Preparing…` / `Preparing audio…` (state label) | progress label | as above | as above |
| `$G/src/drive_sync.rs:390` | `Updating catalog…` | progress label | none | `library.drive.updatingCatalog` |
| `$G/src/drive_restore.rs:850` | `Already downloaded` | progress label | none | `library.drive.alreadyDownloaded` |
| `$G/src/drive_restore.rs:895` | `Downloaded` | progress label | none | `library.drive.downloaded` |
| `$G/src/drive_restore_service.rs:49` | `Download cancelled. Completed files are kept.` | `s.message` | none | `library.drive.downloadCancelled` |
| `$G/src/main.rs:6083` | `Preparing…` | see 1b | | |
| `$G/src/main.rs:1752` | `Preparing…` | see 1b | | |

### 1f. Drive, library, and sign-in

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/drive_service.rs:411` | `Google Drive is not configured` | `s.error` | none | `library.drive.notConfigured` |
| `$G/src/drive_service.rs:510` | `Signed out of Google Drive.` | `s.progress` | exact: `library.ts:121` `library.projectPicker.signedOut` | reuse |
| `$G/src/drive_service.rs:524` | `Sync paused. Completed files are kept. Choose Sync now to continue.` | `s.progress` | exact: `library.ts:15` `library.dropScreen.syncPaused` | reuse |
| `$G/src/drive_service.rs:535` | `Finish signing in to Google in your browser…` | `s.progress` | exact: `library.ts:24` `library.common.finishGoogleSignIn` | reuse |
| `$G/src/drive_service.rs:629` | `Checking Google Drive…` | `s.progress` | none | `library.drive.checking` |
| `$G/src/drive_service.rs:739` | `Finishing Drive sync…` | `s.progress` | none | `library.drive.finishingSync` |
| `$G/src/library.rs:1154` | `No playable projects in this folder` | picker text | none | `library.picker.noPlayable` |
| `$G/src/drive_local_ops.rs:691` | `Recovered the actual renamed folder, but retained newer saved metadata with a different title.` | `warnings` entry *(inferred: shown to user)* | none | `library.recovery.renamedFolderWarning` |
| `$G/src/drive_auth.rs:628` | `Invalid sign-in callback. Return to SingZ and retry.` | HTTP body shown in the system browser *(inferred)* | none | `drive.auth.callbackInvalid` (needs locale-selection design) |
| `$G/src/drive_plan.rs:549` | `Song from phone` | default title for adopted project *(inferred: persisted as project name, so it may be data, not UI)* | none | `library.default.songFromPhone` |

Hazard: `library.rs:442` (`starts_with("Sync paused.")`, `== "Signed out of Google Drive."`) and `library.rs:450` (`== "Finishing Drive sync…"`) branch on the English text. Translating `drive.progress` breaks these.

### 1g. Models, catalog, lyrics, microphone

| file:line | literal | surfaces as | existing key | proposed key |
|---|---|---|---|---|
| `$G/src/models.rs:288` | `Checking installed models…` | wizard status | none | `main.model.checking` |
| `$G/src/engine_status.rs:55` | `The stem splitter has not been downloaded yet.` | status message | exact: `main.ts:50` `main.error.splitterNotDownloaded` | reuse |
| `$G/src/microphone.rs:1249` | `No matching microphone recording is active` | `message` | none | `microphone.recording.noActive` |
| `$G/src/microphone.rs:170` | fallback `Native input failed` | error text | none | `microphone.error.nativeInput` |
| `$G/src/microphone.rs:906` | fallback `Native microphone recording failed` | error text | none | `microphone.error.recordingFailed` |
| `$G/src/lyrics_align.rs:86` | `Alignment cancelled` (`Display`) | error text *(inferred: user-visible)* | none | `lyrics.align.cancelled` |
| `$G/src/lyrics_align.rs:87` | `Alignment models are not installed` (`Display`) | error text *(inferred)* | none | `lyrics.align.modelsMissing` |
| `$G/src/lyrics_align.rs:1320`, `:1324` | `An unowned heard-word cache path was retained`, `An unreadable heard-word cache was retained` | `warnings` *(inferred)* | none | `lyrics.align.cache*` |
| `$G/src/lyrics_editor.rs:125` | `The earlier draft was saved. Your newer changes are still unsaved.` | `self.error` *(inferred)* | none | `lyrics.editor.earlierDraftSaved` |
| `$G/src/lyrics_editor.rs:193` | `No lines to save.` | `self.error` | none | `lyrics.editor.noLines` |
| `$G/src/carry_line_host.rs:266` | `" Queued Save did not run."` | notice suffix *(inferred)* | none | `carryLine.queuedSaveDidNotRun` |

## 2. Partial or parallel i18n paths

| file:line | what it does | why it matters |
|---|---|---|
| `$G/src/quick_start.rs:19-37` | Loads `$G/src/quick_start_copy.json` (generated by `scripts/gen-gpui-quick-start.py` from `src/shared/quick-start/index.ts`). `copy_locale()` returns `ru` only for `ru`, otherwise `en`. | The whole Quick start tour bypasses `src/shared/i18n/`. It has `en` and `ru` only, so the other 13 locales fall back to English. |
| `$G/src/source_jobs.rs:57-70` (`split_label`) | Reverse-maps English labels (`Preparing…`, `Checking splitter…`, `Preparing audio…`, `Splitting stems`, `Separating vocals`, `Loading stems…`, `Loading vocals…`) to `library.splitWorkflow.*` keys. Unmatched labels are returned raw (`_ => return label.to_owned()`). | Labels produced without a mapping entry stay English. `Reading audio…`, `Decoding audio…`, `Updating lyrics…`, `Saving project…`, `Updating catalog…` are not mapped. Keys `library.splitWorkflow.loadingStems` and `loadingVocals` have no ellipsis, so the mapping depends on the exact producer string. |
| `$G/src/source_jobs.rs:73-80` (`loading_stage`) | Produces English stage labels `1/2 · Loading stems…`, `Loading vocals…`, etc. | Feeds the reverse map above. |
| `$G/src/models.rs:411-426` | Routes `gpu-splitter`, `qwen-asr`, `aligner` labels and descriptions through `t()`. | `$G/src/model_catalog.rs:176-191` English `label` and `description` literals are shadowed for those ids *(inferred: the `_ => entry.label` arm is reached only for unknown ids)*. Not listed as bypasses. |
| `$G/src/lyrics_editor.rs:8-10` (`copy`) | Calls `t("lyrics.editor.*")`. | Fine. `$G/src/lyrics_editor_copy.json` is generated by `scripts/gen-gpui-lyrics-editor.py`. No Rust file includes it (grep) *(inferred: dead artifact used only by tests and the generator)*. |
| `$G/src/library.rs:66-133`, `$G/src/library.rs:216-217`, `$G/src/main.rs:1563-1564` | Fictional English demo songs and artists (`Room to breathe`, `Mira Vale`, `Demo session`) for fixture mode. | Fixture-only *(inferred)*. Listed so they are not mistaken for production copy. |
| `$G/src/settings.rs:89-95`, `$G/src/settings.rs:1-100` | `OUTPUTS` / `MONITOR_OUTPUTS` fixture device names, used when `self.native` is false (`settings.rs:420-423`). | Fixture-only *(inferred)*. `MacBook Pro speakers`, `Studio interface · 2 out · USB` are data, not copy. |
| `$G/src/header.rs:84-97` | Default fixture state (`output_label: "System default output"`, `title: ""`). | `header.rs:85` `System default output` has no key (`settings.common.systemDefault` is `System default`). Fixture-only *(inferred)*. |

## 3. Error strings (summary, not row-by-row)

About 2,790 `context(`, `ensure!`, `bail!`, `anyhow!`, `Err(` literal lines in production files. Most are internal validation messages (e.g. `drive_plan.rs:152`, `beat_analysis.rs:85`, `drive_http.rs:58`). Their user visibility depends on the consumer, so they were not classified one by one. Rows in sections 1c, 1f, and 1g are the ones that reach a UI field (`notice`, `s.error`, `s.progress`, `warnings`, `Display`). `format!("…{error}")` sites in section 1b show that raw error text is shown to users in some places.

## 4. Log-only strings (not user-visible)

- About 60 `diagnostics::event(…)` literal lines in production files (e.g. `main.rs:769` `Native desktop started.`, `main.rs:1811` `Project operation cancellation requested.`, `main.rs:3125` `Project mix saved.`, `source_jobs.rs:312` `Project operation completed: …`, `desktop_actions.rs:117` `Native desktop stopped.`).
- About 27 `eprintln!` / `println!` / `tracing` / `log` macro lines (e.g. `engine_status.rs:365`).
- `engine_status.rs:368` is a `diagnostics::event` call carrying the same text as the `eprintln!`. It is log-only.
- `source_jobs.rs:249` `Job::Save` description (`Saving project {}`) is a debug description *(inferred: not rendered)*.

## 5. Not user-visible, deliberately excluded

- Symbols and glyphs: `—`, `→`, `✓`, `↗`, `↙`, `−`, `+`, `×`, `←`, `✎`, `📁`, `·`.
- Brand: `Sing` (`header.rs:481`, `lyric_glow.rs:134`), `SingZ` menu title.
- Keys and identifiers: `"header-monitor-status"`, `"lyrics-body"`, etc.
- Debug and test fixtures inside `integration.rs` (`integration.rs:455` `Unavailable runtime graph transport state`) *(inferred: harness code)*.

## 6. Method and limits

- Two sweeps over `$G/src/*.rs` (147 files, minus `*_tests.rs` and `ui_*.rs`):
  1. A literal sweep for quoted text with 3+ letters, outside `t`/`tv`/`tn` calls, log macros and errors. Result: about 6,050 candidate lines.
  2. A sink-based sweep (`child`, `tracked_label`, `placeholder`, `notice =`, `progress(`, `warning`, `error`, `Some("…")`, `.into()` in UI state) plus a sentence-shape sweep (capitalized words, ellipsis, punctuation). Result: about 1,030 sentence-shaped lines, which I reviewed and filtered to the rows above.
- Inside `#[cfg(test)]` blocks were excluded with an awk pass that cuts from `#[cfg(test)]` to the matching column-0 `}`.
- The counts above come from grep, not from a full parse. Some UI strings built with `format!` or passed through helper functions may be missing from the table. The sweep covers the common GPUI sinks, not every helper.
- `t()` call-sites in production files: about 509.

## 7. Could not determine

- Whether each `*(inferred)*` row is reachable in the shipped native app (fixture-mode versus production gating was not traced for every row).
- Full classification of the roughly 2,790 error-literal lines and whether each reaches a UI field. That needs a call-graph read per error type, which is outside a low-effort pass.
- Whether `quick_start_copy.json` consumers in `tests/test_native_quick_start*.py` and `tests/test_native_locale_ui.py` expect the en/ru-only structure (not read).
- Behaviour of the `Sing` brand in other locales (brand decision, not a code question).

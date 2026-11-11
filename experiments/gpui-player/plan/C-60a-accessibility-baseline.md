# C-60a: whole-app accessibility audit and baseline

Package C-60a of `COMPLETION_PLAN.md`, outline in `plan/decisions/D-06-accessibility-level.md`
section 7 (floor L2, section 4.2). Measured on a debug `ui-tests` build on macOS (arm64, this
checkout), hidden and muted, with the real macOS AX adapter active (it is activated by reading
`NSView.accessibilityChildren` in-process, so a client *is* attached, and a duplicate node id
would have panicked). Driver: `tests/test_native_accessibility_routes.py`; Rust hook:
`src/ui_accessibility_routes.rs` (`SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST`).

Run: `python3 -I tests/test_native_accessibility_routes.py target/debug/singz-gpui-player OUT --report gaps.md`
(`--enforce-floor` makes any gap an exit 1; `--self-test` checks the auditor alone). Baseline mode exits 0
when the audit completes, so the baseline itself is not a red test; C-60b turns on `--enforce-floor`.

## Result in one line

**144 gaps per window size, 288 across the two record sizes, over 13 reachable route states; 6 states
(3 backend dialogs, plus library import, project delete and the carry-line popover) were not reached on this fixture.**
The two sizes gave identical trees, so the per-size count is the number to size C-60b with.

## What is measured, against D-06 section 4.2

| Rule | Measured? | How |
|---|---|---|
| 1 name and role on every focusable or actionable node, no key-as-name | Yes | Tree `aria.role` and `aria.label` of every node with a control role or Click/Focus/Increment/Decrement/SetValue action; a name shaped like an i18n key or equal to its element id is flagged. Also flagged: a tree control that the macOS adapter did not surface in the native AX readback (plain ids only). |
| 2 every tab stop has a node | Yes | The app Tabs up to 90 times per state; a stop where `window.focused()` is set but `gpui_focus` has no node counts. This reads the live focus, not the log line at `a11y.rs:188-202`. |
| 3 no duplicate ids | Yes | Duplicate element ids in the tree, and a debug-build panic would abort the run and be reported with the step it was in. **No panic occurred.** Two nodes share the element id `input-state` in the Drive dialog (see findings). |
| 4 slider value/min/max/step, toggle state, tab/option selection | Yes | Every slider, toggle and tab in the reached states exposes them: **0 gaps**. (Counts of the settings checkboxes that lack a name are in R1.) |
| 5 open dialog is a modal dialog; background refuses actions | Partly | Dialog role presence only. The debug tree JSON has no modal flag, and background refusal is not driven here (it is proven for the probe only). |
| 6 tab order equals a checked-in list, Shift+Tab reverses, focus returns | No | Tab order is captured per state (the `.tab.json` files) but there is no expected list yet; that is C-60b's `tests/reference/a11y/`. |
| 7 announcements, 8 locales | No | Out of this package's scope (C-60c and a unit test). |

## Gaps per route against the L2 floor

Per size; both sizes are identical. R1 includes native-readback misses.

| Route state | Controls | Gaps | R1 name/role | R2 tab stop without node | R3 duplicate id | R4 | R5 no dialog role | Tab stops |
|---|---|---|---|---|---|---|---|---|
| library | 23 | 17 | 4 | 13 | 0 | 0 | 0 | 34 |
| player | 43 | 10 | 5 | 5 | 0 | 0 | 0 | 44 |
| player + metronome open | 51 | 19 | 7 | 12 | 0 | 0 | 0 | 54 |
| training | 11 | 12 | 3 | 9 | 0 | 0 | 0 | 20 |
| settings | 36 | 8 | 8 | 0 | 0 | 0 | 0 | 9 |
| log | 26 | 4 | 4 | 0 | 0 | 0 | 0 | 3 |
| models | 24 | 4 | 4 | 0 | 0 | 0 | 0 | 1 |
| dialog: language menu | 23 | 18 | 4 | 13 | 0 | 0 | 1 | 34 |
| dialog: quick start | 23 | 7 | 4 | 2 | 0 | 0 | 1 | 2 |
| dialog: what's new | 23 | 9 | 4 | 4 | 0 | 0 | 1 | 4 |
| dialog: engine setup | 23 | 9 | 4 | 4 | 0 | 0 | 1 | 4 |
| dialog: notice | 24 | 18 | 4 | 13 | 0 | 0 | 1 | 34 |
| dialog: Drive projects | 24 | 9 | 5 | 1 | 2 | 0 | 1 | 2 |
| **Total per size** | | **144** | 60 | 76 | 2 | 0 | 6 | |

Not reached (listed in the run output, not skipped silently): **project picker, stem export, lyrics editor**
(each needs a native audio backend; the desktop-only setup builds no audio helper and there is no
`SINGZ_GPUI_TEST_PROJECT` here), and **library import, project delete, carry-line popover** (their openers need
a scanned folder, a delete plan or an open song; not attempted). C-60b's file list names all six, so its
estimate must carry them unmeasured: they are built from the same UIKit `modal_card` and button builders, so
expect the dialog-role gap (R5) and unnamed buttons there too.

Counts overstate distinct defects. R1 and R3 repeat across states: the 3 unnamed header buttons recur in all 13 states
(39 of the 60 R1 gaps). De-duplicated by control id, R1 is **11 distinct (id, reason) pairs on 8 controls**:
`header-version`, `header-language`, `header-settings`, `pitch-microphone-unavailable`, `transport-karaoke`,
`settings-native`, `settings-headphones` (all "no accessible name"), `input-state` (no name in the metronome panel), plus the
native-readback misses `input-state`, `settings-native-row`, `settings-headphones-row`. R3 is one id, `input-state`.
R2 tab stops have no node and so no identity to de-duplicate on; the per-route count is the measure, and the
largest are library and the language menu/notice (13, the same 13 library stops), player with metronome (12) and training (9).

## Findings

1. **Dialogs are not dialogs to AX.** In all 6 reached dialogs the tree contains no dialog-role node and still
   contains the full background controls (24 nodes in the quick-start dialog, which has 2 tab stops). Background
   controls stay in the tree and remain actionable. The language menu and the notice trap no Tab focus at all
   (34 stops, the whole page).
2. **Unnamed controls**: three header buttons on every screen (`header-version` Link, `header-language`,
   `header-settings`), plus `pitch-microphone-unavailable` and `transport-karaoke` on the player, and the
   `settings-native` and `settings-headphones` checkboxes (their `-row` twins are named but missing from the native readback).
   The `?` help button is named `?`, which passes the test but is a poor name.
3. **Tab stops without nodes**: library 13, training 9, player 5 (12 with the metronome open), quick start 2,
   what's new 4, engine setup 4. Library: 34 tab stops, 24 tree nodes. These are focusable elements with no
   `.id`/`.role`, so a screen reader announces the whole window when Tab reaches them.
4. **Duplicate element id**: `input-state` appears twice in the Drive projects dialog, once in the library and
   once (unnamed) in the metronome panel, so it is a fixed id in the shared text-input builder. No debug panic
   occurred in any state; I did not establish why the framework tolerates it, so treat the id as a latent collision.
5. **Native readback**: `input-state` and the settings `-row` checkboxes are in the tree but not in the macOS adapter's
   AX identifier readback. Composite ids (`NamedInteger(..)`) cannot be matched by name and were not compared.
6. **Log and Models have only the header gaps.** They replace the page, so they are counted as routes, not dialogs.
7. **Sliders, checkboxes and tabs are already complete (R4 = 0)**, consistent with D-06's inventory.

## Re-sizing C-60b

D-06 budgets 5 days for annotation volume "known two days into C-60". On the reachable half of the app the node/name
volume is small: 8 controls to name plus 3 native-readback misses, one shared text-input id, and one dialog-role fix
(a `modal_card` variant, C-60c) that covers 6 of the 9 dialogs. The larger quantity is **tab stops without nodes (up to 13
per route)**, whose sources are not named by this tree and need a pass through the focus handles in
`library.rs`, `training.rs` and the player route. The six unreached states are unmeasured. My recommendation: size
C-60b at the 5 days only after re-running this driver with a project loaded and an audio helper built; the measured part
alone looks like 2-3 days.

## Deviations and non-obvious choices (for the reviewer)

* The outline names `ui_accessibility_app.rs`, `a11y_audit.rs` and an extra case in `test_native_accessibility.py`.
  This task restricts edits to one new Python driver, one new `ui_*.rs` and main.rs. The pure auditor therefore lives in
  the Python driver (with `--self-test` fixtures), not a Rust `a11y_audit.rs`; `ui_accessibility.rs` is untouched, so
  its `native_nodes` is not shared and a compact copy of the objc readback lives in the new module.
* main.rs gains 4 lines, not 2: the `mod` line and the dispatch each carry the `#[cfg(all(feature="ui-tests", target_os="macos"))]`
  attribute the neighbouring entries use.
* The negative control is a probe host inside the new module (`SINGZ_GPUI_ACCESSIBILITY_ROUTES_INJECT`): a named UIKit
  pill beside a focusable, actionable button with a role and no name. The existing `ui_accessibility.rs` probe could not be edited. The driver
  runs it first every time and fails unless the unlabeled control is flagged and its named sibling is not.
* Fixture mode is `SINGZ_GPUI_DEMO=1` (the existing `fixture_mode`), with no `replace_root`. States are opened by the real
  header events or the real `Player::open_*` methods; between states the driver presses Escape three times and restores the
  base screen field directly, which is test glue, not a user path. The notice text is a test-only English string.
* Per-step budget: enforced inside the app (every wait is bounded by `SINGZ_A11Y_STEP_SECONDS`) and again by the driver, which
  kills the process group if a step's progress file is older than the budget. Total deadline: `--deadline`. The process group
  is killed with SIGTERM then SIGKILL on expiry and on every exit; a stub test confirmed no grandchild survives.
* Tab-walk identity is the window's `FocusHandle`, so a stop with no node still ends the loop on wrap.
* Rule 5's modal flag cannot be read from the debug tree; the finding is role presence only.

## Control inventory (1280x800; identical at 1060x640)

Role, name, value and actions as the tree reports them; "Value" is empty when the node has none.

#### library

23 controls, 34 tab stops, 24 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |

#### player

43 controls, 44 tab stops, 44 tree nodes, 43 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `NamedInteger("m", 0)` | Button | Mute · Vocals |  | Click, Focus |  |
| `NamedInteger("s", 0)` | Button | Solo · Vocals |  | Click, Focus |  |
| `NamedInteger("gain", 0)` | Slider | Volume · Vocals |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 1)` | Button | Mute · Drums |  | Click, Focus |  |
| `NamedInteger("s", 1)` | Button | Solo · Drums |  | Click, Focus |  |
| `NamedInteger("gain", 1)` | Slider | Volume · Drums |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 2)` | Button | Mute · Bass |  | Click, Focus |  |
| `NamedInteger("s", 2)` | Button | Solo · Bass |  | Click, Focus |  |
| `NamedInteger("gain", 2)` | Slider | Volume · Bass |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 3)` | Button | Mute · Guitar |  | Click, Focus |  |
| `NamedInteger("s", 3)` | Button | Solo · Guitar |  | Click, Focus |  |
| `NamedInteger("gain", 3)` | Slider | Volume · Guitar |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 4)` | Button | Mute · Piano |  | Click, Focus |  |
| `NamedInteger("s", 4)` | Button | Solo · Piano |  | Click, Focus |  |
| `NamedInteger("gain", 4)` | Slider | Volume · Piano |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 5)` | Button | Mute · Instruments |  | Click, Focus |  |
| `NamedInteger("s", 5)` | Button | Solo · Instruments |  | Click, Focus |  |
| `NamedInteger("gain", 5)` | Slider | Volume · Instruments |  | Click, Decrement, Focus, Increment, SetValue |  |
| `pitch-microphone-unavailable` | Button | (none) |  | Click | r1: no accessible name |
| `guide` | Button | Guide vocals |  | Click |  |
| `transport-restart` | Button | Back to start |  | Click, Focus |  |
| `transport-play` | Button | Play (space) |  | Click, Focus |  |
| `transport-loop` | Button | Loop the whole song (drag on the waveforms to loop a section) |  | Click, Focus |  |
| `transport-output` | Button | Volume 0.0 dB — click for the slider |  | Click, Focus |  |
| `transport-met` | Button | Metronome — click on the beat, a grid to watch, count-in before play |  | Click, Focus |  |
| `transport-carry` | Button | Carry the line |  | Click, Focus |  |
| `transport-transpose-down` | Button | Transpose the whole song (pitch only, tempo unchanged) − |  | Click, Focus |  |
| `transport-transpose-up` | Button | Transpose the whole song (pitch only, tempo unchanged) + |  | Click, Focus |  |
| `transport-tempo-down` | Button | Playback speed (pitch stays put) − |  | Click, Focus |  |
| `transport-tempo-up` | Button | Playback speed (pitch stays put) + |  | Click, Focus |  |
| `transport-bpm-down` | Button | Set the playback tempo in beats per minute −1 |  |  |  |
| `transport-bpm-up` | Button | Set the playback tempo in beats per minute +1 |  |  |  |
| `transport-karaoke` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `transport-split` | Button | Split |  | Click, Focus |  |
| `transport-stem-files` | Button | Stem files |  | Click, Focus |  |

#### player-metronome

51 controls, 54 tab stops, 52 tree nodes, 50 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `NamedInteger("m", 0)` | Button | Mute · Vocals |  | Click, Focus |  |
| `NamedInteger("s", 0)` | Button | Solo · Vocals |  | Click, Focus |  |
| `NamedInteger("gain", 0)` | Slider | Volume · Vocals |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 1)` | Button | Mute · Drums |  | Click, Focus |  |
| `NamedInteger("s", 1)` | Button | Solo · Drums |  | Click, Focus |  |
| `NamedInteger("gain", 1)` | Slider | Volume · Drums |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 2)` | Button | Mute · Bass |  | Click, Focus |  |
| `NamedInteger("s", 2)` | Button | Solo · Bass |  | Click, Focus |  |
| `NamedInteger("gain", 2)` | Slider | Volume · Bass |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 3)` | Button | Mute · Guitar |  | Click, Focus |  |
| `NamedInteger("s", 3)` | Button | Solo · Guitar |  | Click, Focus |  |
| `NamedInteger("gain", 3)` | Slider | Volume · Guitar |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 4)` | Button | Mute · Piano |  | Click, Focus |  |
| `NamedInteger("s", 4)` | Button | Solo · Piano |  | Click, Focus |  |
| `NamedInteger("gain", 4)` | Slider | Volume · Piano |  | Click, Decrement, Focus, Increment, SetValue |  |
| `NamedInteger("m", 5)` | Button | Mute · Instruments |  | Click, Focus |  |
| `NamedInteger("s", 5)` | Button | Solo · Instruments |  | Click, Focus |  |
| `NamedInteger("gain", 5)` | Slider | Volume · Instruments |  | Click, Decrement, Focus, Increment, SetValue |  |
| `pitch-microphone-unavailable` | Button | (none) |  | Click | r1: no accessible name |
| `guide` | Button | Guide vocals |  | Click |  |
| `transport-restart` | Button | Back to start |  | Click, Focus |  |
| `transport-play` | Button | Play (space) |  | Click, Focus |  |
| `transport-loop` | Button | Loop the whole song (drag on the waveforms to loop a section) |  | Click, Focus |  |
| `transport-output` | Button | Volume 0.0 dB — click for the slider |  | Click, Focus |  |
| `transport-met` | Button | Metronome — click on the beat, a grid to watch, count-in before play |  | Click, Focus |  |
| `transport-carry` | Button | Carry the line |  | Click, Focus |  |
| `transport-transpose-down` | Button | Transpose the whole song (pitch only, tempo unchanged) − |  | Click, Focus |  |
| `transport-transpose-up` | Button | Transpose the whole song (pitch only, tempo unchanged) + |  | Click, Focus |  |
| `transport-tempo-down` | Button | Playback speed (pitch stays put) − |  | Click, Focus |  |
| `transport-tempo-up` | Button | Playback speed (pitch stays put) + |  | Click, Focus |  |
| `transport-bpm-down` | Button | Set the playback tempo in beats per minute −1 |  |  |  |
| `transport-bpm-up` | Button | Set the playback tempo in beats per minute +1 |  |  |  |
| `transport-karaoke` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `transport-split` | Button | Split |  | Click, Focus |  |
| `transport-stem-files` | Button | Stem files |  | Click, Focus |  |
| `met-volume` | Slider | Loudness |  | Click, Decrement, Focus, Increment, SetValue |  |
| `input-state` | TextInput | (none) | — | Focus, SetValue | r1: no accessible name; r1: control absent from the native macOS AX readback |
| `met-tap` | Button | Tap |  | Click, Focus |  |
| `met-half` | Button | ½ |  | Click |  |
| `met-double` | Button | ×2 |  | Click |  |
| `met-earlier` | Button | −10 |  | Click |  |
| `met-later` | Button | +10 |  | Click |  |
| `met-rotate` | Button | 1→ |  | Click |  |

#### training

11 controls, 20 tab stops, 12 tree nodes, 11 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `NamedInteger("training-level", 0)` | Button | Foundation |  | Click, Focus |  |
| `NamedInteger("training-level", 1)` | Button | Developing |  | Click, Focus |  |
| `NamedInteger("training-level", 2)` | Button | Advanced |  | Click, Focus |  |

#### settings

36 controls, 9 tab stops, 37 tree nodes, 33 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |
| `settings-quick-start` | Button | Quick start |  | Click, Focus |  |
| `settings-tab-audio` | Tab | Audio |  | Click, Focus |  |
| `settings-output` | ComboBox | Playback device | System default | Click, Focus |  |
| `settings-retry` | Button | Retry output route |  | Click |  |
| `settings-native` | CheckBox | (none) |  | Click | r1: no accessible name |
| `settings-native-row` | CheckBox | Use native DSP playback |  | Click, Focus | r1: control absent from the native macOS AX readback |
| `settings-input` | ComboBox | Microphone | System default | Click, Focus |  |
| `settings-monitor-output` | ComboBox | Audio interface playback | Choose playback device… | Click, Focus |  |
| `settings-monitor-gain` | Slider | Monitor gain |  | Click, Decrement, Focus, Increment, SetValue |  |
| `settings-headphones` | CheckBox | (none) |  | Click | r1: no accessible name |
| `settings-headphones-row` | CheckBox | Wired headphones are connected to this device |  | Click, Focus | r1: control absent from the native macOS AX readback |
| `settings-monitor-start` | Button | Start monitoring |  |  |  |
| `settings-close` | Button | Close |  | Click, Focus |  |

#### log

26 controls, 3 tab stops, 27 tree nodes, 25 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |
| `log-copy` | Button | Copy |  | Click, Focus |  |
| `log-save` | Button | Save to file… |  | Click, Focus |  |
| `log-close` | Button | Close |  | Click, Focus |  |

#### models

24 controls, 1 tab stops, 25 tree nodes, 23 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |
| `model-close` | Button | Close |  | Click, Focus |  |

#### dialog-language-menu

23 controls, 34 tab stops, 24 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |

#### dialog-quick-start

23 controls, 2 tab stops, 24 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |

#### dialog-whats-new

23 controls, 4 tab stops, 24 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |

#### dialog-engine-setup

23 controls, 4 tab stops, 24 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |

#### dialog-notice

24 controls, 34 tab stops, 25 tree nodes, 23 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |
| `notice-close` | Button | Close |  | Click |  |

#### dialog-drive-projects

24 controls, 2 tab stops, 25 tree nodes, 22 native AX rows.

| Control id | Role | Name | Value | Actions | Gaps |
|---|---|---|---|---|---|
| `header-version` | Link | (none) |  | Click, Focus | r1: no accessible name |
| `header-songs` | Tab | Songs |  | Click, Focus |  |
| `header-training` | Tab | Vocal training |  | Click, Focus |  |
| `header-log` | Button | Log |  | Click, Focus |  |
| `header-engine` | Button | splitter ready |  | Click, Focus |  |
| `header-language` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `header-help` | Button | ? |  | Click, Focus |  |
| `header-settings` | Button | (none) |  | Click, Focus | r1: no accessible name |
| `library-browse` | Button | Browse files… |  | Click |  |
| `input-state` | TextInput | Search projects… |  | Focus, SetValue | r3: duplicate element id 'input-state' x2; r1: control absent from the native macOS AX readback |
| `library-storage` | Link | Change… |  | Click |  |
| `library-delete:"demo-0"` | Button | Delete Room to breathe |  | Click, Focus |  |
| `library-delete:"demo-1"` | Button | Delete Paper lanterns |  | Click, Focus |  |
| `library-delete:"demo-2"` | Button | Delete A little closer |  | Click, Focus |  |
| `library-delete:"demo-3"` | Button | Delete After the rain |  | Click, Focus |  |
| `library-delete:"demo-4"` | Button | Delete Golden hour |  | Click, Focus |  |
| `library-delete:"demo-5"` | Button | Delete Slow river |  | Click, Focus |  |
| `library-delete:"demo-6"` | Button | Delete Under the same sky |  | Click, Focus |  |
| `library-delete:"demo-7"` | Button | Delete Stay for the sunrise |  | Click, Focus |  |
| `library-delete:"demo-8"` | Button | Delete Quiet streets |  | Click, Focus |  |
| `library-delete:"demo-9"` | Button | Delete Find your way home |  | Click, Focus |  |
| `library-delete:"demo-10"` | Button | Delete Small beginnings |  | Click, Focus |  |
| `library-delete:"demo-11"` | Button | Delete Light in the window |  | Click, Focus |  |
| `input-state` | TextInput | Search Drive projects |  | Focus, SetValue | r3: duplicate element id 'input-state' x2; r1: control absent from the native macOS AX readback |

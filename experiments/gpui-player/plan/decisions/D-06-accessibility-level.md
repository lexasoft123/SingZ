# D-06 — What accessibility level ships, and how?

Decision record for `COMPLETION_PLAN.md` section 4.2, row D-06. Written 2026-11-10
against the working tree at `f7607311`. `$G` = `experiments/gpui-player`. `$V` =
`$G/vendor`. `$REG` = the cargo registry source for the versions `$G/Cargo.lock`
pins. `$UIKIT` = the `singz-uikit` checkout at the pinned revision `1c1081ad`
(`$G/Cargo.toml:14`), path `gpui/src/`. Anything marked *(inferred)* was not checked
against code.

Status: **proposed**. It becomes binding when the user signs section 6.

## 1. Question

What accessibility level must the native desktop reach before "native becomes
default" (plan section 6, item 7), by which mechanism, at what cost, and what is
the stated gap?

The plan frames three mechanisms: patch vendored GPUI for AX/UIA, bridge through
platform APIs outside GPUI, or ship keyboard-complete with a stated screen-reader
gap. The decision must give a floor for the default gate and a cost per option.

## 2. Inputs, and what was verified

R-10 (`$G/plan/R-10-accessibility.md`) was the lead. Its claims were checked; three
of them change the shape of the decision.

### 2.1 The bridge already exists. Nothing needs to be patched in to get AX or UIA

| Fact | Evidence | Status |
|---|---|---|
| GPUI 0.3.11 builds an AccessKit tree and dispatches AccessKit actions | `$V/gpui-pre/src/window/a11y.rs:1-98` (design), `$V/gpui-pre/src/window.rs:1738-1850` (adapter init, action queue), `:7415-7474` (action dispatch with Click, Focus, Blur fallbacks) | Verified |
| The a11y core is upstream code, not a SingZ patch | `diff` of `$REG/gpui-pre-0.3.11` against `$V/gpui-pre` is empty for `window/a11y.rs`, `window/a11y/debug.rs`, `_accessibility.rs`, `element.rs`. The only a11y line SingZ added is the test entry point `dispatch_accessibility_action` (`$V/gpui-pre/src/window.rs:7405-7412`) | Verified |
| macOS adapter: `accesskit_macos::SubclassingAdapter` on the NSWindow | `$REG/gpui-pre-macos-0.3.11/src/window.rs:2406-2435`. R-10 could not find it because it looked in `gpui-pre-apple`; the adapter is in `gpui-pre-macos`, which is **not vendored** (`$G/Cargo.lock:2540-2553` has a registry source and checksum; `$G/Cargo.toml:54-61` patches five other crates) | Verified; corrects R-10 |
| Windows adapter: `accesskit_windows::Adapter`, served on `WM_GETOBJECT` | `$V/gpui-pre-windows/src/window.rs:1084-1117` | Verified |
| Pinned adapter versions | `accesskit` 0.24.1, `accesskit_macos` 0.26.3, `accesskit_windows` 0.34.0 (`$G/Cargo.lock:6-74`) | Verified |
| A full ARIA-style builder API is available to app code: role, label, description, value, numeric range, toggled, selected, expanded, position-in-set, action handlers, raw node access | `$V/gpui-pre/src/elements/div.rs:1362-1570` | Verified |
| Live regions and modal dialogs are supported by both adapters, and reachable from app code without a vendor patch through `a11y_synthetic_children(|b| b.parent_node().set_live(..))` | Adapters: `$REG/accesskit_macos-0.26.3/src/event.rs:28-99,236-238`, `node.rs:1167-1169`; `$REG/accesskit_windows-0.34.0/src/node.rs:546-549,738-739`. Raw-node route already used in the app: `$G/src/stem_export_dialog.rs:405`, `$G/src/settings.rs:1038` | Verified that the API exists; no SingZ code sets `live` or `modal` today (grep for `set_live`, `set_modal`, `Role::Dialog` across `$G/src`, `$UIKIT`, `$V/gpui-pre`, `$V/gpui-component` returns nothing) |
| macOS does not bridge the expanded state; Windows does | No `expanded` in `$REG/accesskit_macos-0.26.3/src`; `$REG/accesskit_windows-0.34.0/src/node.rs:717-719` | Verified; agrees with R-10 and `$G/NATIVE_CONTROLS_GUIDE_REVIEW.md:19-20` |

Consequence: the plan's option "patch vendored GPUI for AX/UIA" describes work
that upstream has already done. The real first option is "annotate the app
through the bridge that is there".

### 2.2 What the app exposes today

| Fact | Evidence | Status |
|---|---|---|
| A node reaches the tree only if it has an element id **and** a role | `$V/gpui-pre/src/element.rs:427-442`; `$V/gpui-pre/src/_accessibility.rs:58-66` | Verified |
| Plain strings are not in the tree. Only `text!(..)` elements are, and neither the app nor UIKit uses `text!` | `$V/gpui-pre/src/elements/text.rs:189-199`; `grep -c 'text!('` is 0 over `$G/src` and `$UIKIT` | Verified. Every heading, song title, status line, lyric and dialog body is invisible to a screen reader unless a parent carries it as a label |
| UIKit builders that already carry a role: pill, toggle, nav tab, select field and option, checkbox, text link, status chip, catalog delete, round and play buttons, stem chip, range slider with value, range and increment/decrement/set actions | `$UIKIT/controls.rs:53-62,118-125,190-201,218-229,315-323,399-407,442-451,813-821,840-846,862-870,903-922,1372-1390,711-725` | Verified |
| Icon buttons carry a role but no name; the host must supply it. Transport does | `$UIKIT/controls.rs:862-870,903-922`; `$G/src/transport.rs:252-260` | Verified for transport only |
| Role/ARIA annotations: 43 call sites in `$G/src` outside the probe (11 files), 47 in UIKit (4 files). Click handlers in `$G/src` outside the probes: about 95 call sites in 22 files | `grep -c` counts taken for this record | Verified as counts. How many of those 95 already inherit a role from a UIKit builder is **not** known: no one has dumped the real app's tree |
| Modal scrim and card carry no dialog role and no modal flag | `$UIKIT/controls.rs:256-288` | Verified |
| Toast has no role and no live setting | `$UIKIT/toast.rs` (no `role`, `aria`, `live`) | Verified |
| The only accessibility test replaces the app root with a probe view. The production routes have never been inspected through AX | `$G/src/ui_accessibility.rs:225-229` (`replace_root`), `$G/tests/test_native_accessibility.py:13-20,66-68` | Verified |
| That test is macOS-only | `$G/src/main.rs:6204-6208`; `$G/tests/native_ui_observer.py:48-49` | Verified |
| Six base screens: Training, Player, Library, Settings, Log, Models, plus about fourteen dialogs and popovers | `$G/src/main.rs:371-378`; dialog list at `$G/src/desktop_keyboard.rs:40-54` | Verified |
| Keyboard: song shortcuts mirror the renderer's ownership rules; focus handles and tab indices exist on 22 app files and 4 UIKit files; per-route keyboard reviews exist for footer, mixer, settings, models and training | `$G/src/desktop_keyboard.rs:1-88`; `grep -c 'tab_index\|track_focus\|tab_stop'`; `$G/SCREEN_PORT_STATUS.md:43-86` | Verified that the pieces exist. Complete per-route tab order and focus trapping in every production modal are **not** established *(inferred from R-10 and the absence of a whole-app focus test)* |

### 2.3 What Electron offers

| Fact | Evidence | Status |
|---|---|---|
| The renderer has 432 `aria-*`/`role=` attributes in 58 files, among them 23 `aria-live`, 45 `role="status"`, 30 `role="alert"`, 12 `role="dialog"`, 5 `role="meter"` | `grep -rhoE` over `src/renderer/src` | Verified as counts |
| Static text is exposed for free, because it is DOM text | Property of Chromium | *(inferred)* |
| Electron was never qualified with a screen reader. One e2e assertion touches accessibility | `tests/e2e/mac/audio-devices-e2e.cjs:319`; no accessibility rule in `docs/PROJECT-RULES.md` | Verified by search; absence of evidence |

So the comparison is "semantic by construction, never audited" against "bridge
present, annotated in patches, never inspected whole". Parity with Electron is a
structural target, not a certified one.

### 2.4 Facts that bear on the section 3 budgets

| Fact | Evidence | Status |
|---|---|---|
| With no assistive client attached, nothing is built: every a11y branch is behind `is_active()` | `$V/gpui-pre/src/window.rs:3984-3987,4083-4108`; `$V/gpui-pre/src/element.rs:428`; `$V/gpui-pre/src/elements/div.rs:2385,2403,2658` | Verified |
| With a client attached, a complete tree is rebuilt on **every drawn frame**, cloned once more for the debug dump (not gated to debug builds), then diffed by the adapter | `$V/gpui-pre/src/window/a11y.rs:43-51`; `$V/gpui-pre/src/window/a11y/debug.rs:71-92` | Verified |
| Activation never ends on macOS or Windows. GPUI offers a `deactivation` callback; neither platform layer wires it (Linux does) | `$V/gpui-pre/src/window.rs:1783-1797`; zero matches for `deactivation` in `$REG/gpui-pre-macos-0.3.11/src/window.rs` and in `$V/gpui-pre-windows/src` | Verified |
| Activation is triggered by any AX query of the content view, not only by a screen reader | `$G/src/ui_accessibility.rs:68-70` (the probe activates it by reading `accessibilityChildren`) | Verified for the in-process case. That window managers, password managers, dictation and similar tools trigger it in the field is *(inferred)* |
| Duplicate node ids panic in a debug build and are silently dropped in a release build | `$V/gpui-pre/src/window/a11y.rs:411-419`; `$G/Cargo.toml:37-39` defines the dev profile without turning debug assertions off | Verified. Whether the real app has duplicates is unknown, for the reason in 2.2 |
| No accessibility dependency would be added by any recommended work; the AccessKit crates are already linked | `$G/Cargo.lock:6-74,2310-2326,2540-2553,2775-2790` | Verified |

The per-frame cost with a client attached has not been measured by anyone. It
applies today, before any D-06 work, to every user whose machine has something
that queries AX.

## 3. Options

Costs are worker-days including the coordinator's review, on the plan's scale
(C-60 and C-61 are 8 each, 16 together, in section 4.8).

### Option A — Annotate through the existing AccessKit bridge (no vendor patch)

Add ids, roles, names, values, actions, dialog and live semantics in `$G/src` and
in `singz-uikit`, using the API in 2.1. Build a whole-app tree audit and make it
the acceptance test. The floor is the one in section 4.

| | |
|---|---|
| Cost | C-60: 10 (range 8-13). C-61: 5 (range 4-7). Total 15 (12-20), against 16 planned. The range is wide because the size of the gap is unknown until the first whole-app dump; that dump is the first two days of C-60 and re-sizes the rest |
| Risk | Medium. (1) Gap larger than the grep counts suggest. (2) Duplicate ids in list rows surface as panics the first time the audit runs on a debug build; that is a feature of the test, but each is a fix. (3) The macOS expanded-state gap stays (stated in the floor). (4) UIKit lives in another repository; each change there is a pin bump here |
| N1-N3, N7 (frame rate, playing CPU) | No change with no client attached. With a client attached the cost rises with node count, on every frame, for the life of the process (2.4). Unmeasured. Mitigated by two rules in section 5 and measured in C-60 |
| N5, N6 (idle) | No change. A tree update is produced only by a frame that is drawn anyway; no announcement may schedule a frame of its own (rule in section 5) |
| N9, N10 (memory) | One retained copy of the tree while active; a few hundred nodes *(inferred)* |
| N11 (audio) | None. UI thread only |
| N12-N14 | None. No new dependency, no new startup work |

### Option A+ — Option A, plus patch the platform layers

Wire deactivation, add the macOS expanded state, add a first-class
announcement API.

| | |
|---|---|
| Cost | Option A + 4-6. Deactivation and expanded state on macOS live in `gpui-pre-macos` and `accesskit_macos`, neither of which is vendored; this means vendoring one or two more crates and carrying the patches across every GPUI bump |
| Risk | Medium-high. AccessKit's macOS and Windows adapters expose no deactivation hook *(inferred from the unused callback; adapter internals not read for this)*, so the patch may reach into AccessKit itself |
| Budgets | Could bring the attached-client frame cost back to zero after the client leaves. Worth doing only if the C-60 measurement shows the cost breaks N1-N3 |

### Option B — A separate bridge through platform APIs outside GPUI

Own `NSAccessibility` elements and an own UIA provider, fed from app state.

| | |
|---|---|
| Cost | 35-50, both platforms, plus a second tree description to keep in step with the UI forever |
| Risk | High. Two providers would answer for one `NSView` and one `HWND` unless GPUI's is disabled (`Application::new_inaccessible`, `$V/gpui-pre/src/window.rs:7358-7366`), which throws away what works today. It duplicates AccessKit, which exists to avoid exactly this |
| Budgets | Same class of cost as A when active, with our own diffing to write and get wrong. N14 unaffected |

The only reason to choose B would be a bridge that is absent or unusable. 2.1
shows it is present and passes real AX actions in the probe.

### Option C — Keyboard-complete, with a stated screen-reader gap

Finish and test keyboard reachability and focus order on every route; publish that
screen readers are not supported.

| | |
|---|---|
| Cost | 5-7 for both platforms: a focus-order walk per route, the fixes it finds, and the written gap |
| Risk | Medium, and of a different kind. The tree is already partly populated (2.2), so a screen-reader user does not get "nothing"; they get some buttons named, others missing, no text and no dialogs. That is worse than a clean absence and cannot be switched off without `new_inaccessible`. It is also a regression from Electron (2.3) on the day native becomes default |
| Budgets | None beyond today's |

C's keyboard work is not an alternative to A. It is A's first layer.

## 4. Recommendation

**Option A, to floor L2 below, on both platforms. No vendor patch now; A+ only if
the C-60 measurement shows a budget broken with a client attached. Option B is
rejected.**

### 4.1 Levels

| Level | Meaning |
|---|---|
| L0 | Keyboard-complete. Every action on every route is reachable without a pointer; focus is always visible; a modal traps focus, closes on Escape and returns focus to its opener |
| L1 | L0, and every interactive control on every route and in every dialog is in the platform tree with a role, a localized name, its state or value, and its action. Dialogs carry a dialog role and the modal flag. Enforced by an automated audit on macOS AX and Windows UIA |
| **L2 (recommended floor)** | L1, and: the text needed to understand a screen is exposed (screen heading, song titles in library and picker rows, empty states, dialog bodies, error and notice text); a fixed list of state changes is announced through live regions (section 4.2); a human completes the scripted walk in 4.3 with VoiceOver and with Narrator and files no blocker |
| L3 (not proposed) | Timeline content navigable by a screen reader: lanes, regions, pitch line, beat grid, per-word lyric timing. No conformance claim is proposed at any level |

L1 without L2 saves about two worker-days and leaves a user with named buttons on
screens they cannot read. L2 is the lowest level at which a blind singer can
choose a song, play it and change settings.

### 4.2 The floor in testable terms

Automated, both platforms, every route and dialog, at both test window sizes:

1. Every node that is focusable or has an action has a role and a non-empty name
   that is not an i18n key. Zero exceptions outside a reviewed allow-list.
2. Every tab stop has a node (GPUI logs this case, `$V/gpui-pre/src/window/a11y.rs:188-202`;
   the audit turns the log into a failure).
3. No duplicate node ids: the debug-build run completes with a client attached.
4. Sliders expose value, minimum, maximum and step; toggles expose their state;
   tabs and options expose selection.
5. With a dialog open, the dialog node is modal and background controls refuse
   actions (already proven for the probe, `$G/tests/test_native_accessibility.py:18-20`).
6. Tab order per route equals a checked-in expected list; Shift+Tab reverses it;
   focus returns to the opener when a dialog closes.
7. Announcements, polite unless noted: notice and error text (assertive); toast
   text; job completion and failure for import, split, analysis, export and model
   install; Drive sign-in and sync state changes; recording started and stopped;
   training result. **Never** the playback position, meters, pitch feedback or
   progress percentages on a timer.
8. In every shipped locale (18 under `src/shared/i18n`), every name resolves to a
   non-empty string.

Stated gap, to be published with the release:

- The timeline is not navigable content. Each lane, the pitch strip, the beat grid
  and the lyric view is one labelled summary node (name, plus mute/solo/volume as
  ordinary controls). Seeking is by the transport controls and shortcuts.
- Lyric timing edits and region gestures are pointer- or keyboard-driven and are
  not described to a screen reader beyond their controls.
- Live pitch feedback during training is not announced; the result is.
- On macOS, a selector's open or closed state is not announced; its value and
  options are. Windows announces it.
- No WCAG or other conformance claim. Human walks are done in English (and one
  more locale if the user names it); other locales are covered by rule 8 only.
- Linux is outside the gate (plan section 1).

### 4.3 The human walk (acceptance for the default gate)

Seven journeys, each with VoiceOver on the Mac and Narrator on the Windows laptop,
screen off or eyes closed: (1) launch, find a song by search, open it; (2) play,
pause, seek, loop, change tempo and transpose; (3) mute, solo and set the volume
of one lane; (4) change input and output device and monitoring in Settings;
(5) import a file and learn from speech alone that splitting finished or failed;
(6) read the Drive state and start a sync; (7) run one training exercise and hear
the result. In every journey every dialog met is opened, read and dismissed with
Escape. A blocker is a step that cannot be completed or a control with no name.

### 4.4 Default-gate wording

Plan section 6, item 7 becomes: "The audits of D-06 section 4.2 are green on the
Mac and on the Windows field laptop on the gate commit, and the walk of 4.3 has no
open blocker; or the user has accepted in writing a named list of misses."

## 5. Consequences

- **A standing rule.** A new control is built from a UIKit builder that carries a
  role, or sets id, role and name itself. The audit enforces it; it joins the
  native lane (Q-06) and runs in Q-10 and Q-11.
- **Two performance rules.** (1) No node's name or value may change on a timer or
  per frame: the position readout is exposed rounded to the second and only its
  static label is live-quiet; meters are not exposed as values. A value that
  changes at 120 Hz makes the adapter raise an event per frame. (2) No
  announcement may request a frame; it rides a frame the state change already
  draws, so N5 holds.
- **A measurement the plan lacks.** C-60 adds an "AX client attached" column to
  the offscreen frame-cost smoke (plan section 3.3, Perf smoke), and Q-15 runs
  N1-N3, N6 and N7 once more with VoiceOver on. Whether those budgets must hold
  in that state is a user decision (section 6). N5 and N11 must hold regardless.
- **This cost exists today.** Because activation is sticky and not limited to
  screen readers (2.4), the attached-client numbers describe some ordinary users
  already. If they are bad, that is a D-02 input, not only an accessibility one.
- **UIKit changes are a second repository.** Dialog and toast semantics belong in
  `singz-uikit`; each change is a commit there and a `rev` bump in `$G/Cargo.toml`
  and `$G/Cargo.lock`, the route C-62's row already uses. C-60 and C-62 both bump
  that pin and must not run their bumps concurrently.
- **i18n.** New names are new keys in `src/shared/i18n`, typed across 18 locales.
  Electron shares that tree: keys are added, never renamed. Where the renderer
  already has an `aria` string for the same control, the native side reuses the
  key.
- **Estimate.** Section 7.2 step 6 keeps its 3.5-6 weeks. The "6+ weeks" risk row
  in 7.1 ("GPUI screen-reader support is thin") is downgraded: support is present;
  the open quantity is annotation volume, known two days into C-60.
- **R-10 correction.** The macOS adapter is in the unvendored `gpui-pre-macos`.
  Any future patch to macOS accessibility means vendoring a sixth crate.
- **Not done.** Lane, pitch and lyric content for screen readers (L3); a
  first-class announcement API in GPUI; Linux AT-SPI qualification.

## 6. What the human must decide or sign off

Nothing below is assumed. Items 1-3 block C-60; the rest block the default gate.

1. **The floor.** L2 as recommended, or L1, or L0 with a published gap (Option C).
2. **The stated gap in 4.2**, item by item, the timeline exclusion above all, and
   whether it may be published in release notes in those words.
3. **Budgets with a client attached.** Do N1-N3, N6 and N7 have to hold with
   VoiceOver or Narrator running, or only N5 and N11? The recommendation is: N5
   and N11 always; the rest measured and reported, with a miss opening A+ rather
   than blocking the gate.
4. **Who does the walks**, and on which OS versions. The plan assigns them to the
   human. Each is about half a day per platform, and must be repeated on the gate
   commit.
5. **Windows screen reader.** The plan names Narrator. NVDA is widely used by
   blind Windows users *(inferred)*; adding it is a second half-day walk and may
   surface different defects. Narrator only, or both?
6. **Locales for the human walk.** English only, or English and one more.
7. **Permission to change `singz-uikit`** (a separate repository) for dialog,
   toast and unnamed-control semantics, and who merges there.
8. **Windows field laptop time** for C-61's automated UIA check and the Narrator
   walk, scheduled through the private `singz-dev` handbook. This record names no
   host and no access detail.
9. **Acceptance of misses.** If the walk finds a blocker late, section 6 item 7 of
   the plan lets the user accept it by name. Only the user can.

## 7. File-level outlines for the unblocked packages

Model tiers follow plan section 2. Neither package is on a data-loss or
audio-timing path, so neither is escalated and neither needs the V-01 review. The
plan lists both as `reserve`; two slices are moved to Sonnet because their
difficulty is this repository's conventions (driver deadline, mute and hidden-run
rules; i18n typed across locales), which section 2 assigns to that tier.

### C-60 — Accessibility implementation, macOS (10 days, range 8-13)

Run as three slices in one worktree, in order. Each stages and reports; the
coordinator gates each.

**C-60a — Whole-app audit and baseline (3 days). `claude-sonnet-5-5`, medium.**

| | |
|---|---|
| Edit | New `$G/src/ui_accessibility_app.rs`: under `ui-tests`, drives the **real** `Player` root (no `replace_root`) through the six screens and every dialog in `$G/src/desktop_keyboard.rs:40-54` using the existing fixture mode; per state writes `debug_a11y_tree_json`, the native AX readback (reuse `native_nodes` from `$G/src/ui_accessibility.rs:68-98`, moved to a shared `pub(super)` item) and the tab-order sequence. New `$G/src/a11y_audit.rs`: a pure function from the tree JSON to findings for rules 1-5 of section 4.2, no GPUI types, unit-tested. `$G/src/main.rs`: `mod` lines and one env gate beside `:6204-6208` (`SINGZ_GPUI_ACCESSIBILITY_APP_TEST`). `$G/tests/test_native_accessibility.py`: keep the isolated case, add the whole-app case with a per-step budget and a total deadline (plan rule 5). New `$G/tests/reference/a11y/` for expected tab orders and the allow-list. `$G/tests/interface-offscreen-perf.py`: the "AX client attached" column |
| Must not edit | Route files. This slice only measures |
| Tests that prove it | Unit tests of `a11y_audit` on fixture trees, including a deliberately unnamed button, a duplicate id and a non-modal dialog, each rejected. The whole-app driver run on the unannotated tree **fails** and writes the finding count per route: that run is the negative control and the re-sizing input for C-60b. Hidden and muted, natural exit, no surviving process |
| Report | Findings per route and dialog; duplicate-id panics found; frame cost with and without a client, with build profile, display mode, machine and commit (plan rule 9) |

**C-60b — Annotate the app (5 days, re-sized from C-60a's count). `gpt-reserve`, medium.**

| | |
|---|---|
| Edit | New `$G/src/a11y.rs`: small helpers over the existing API — `dialog(id, name)` (dialog role, modal flag), `status(id, text, politeness)`, `label(id, text)`, `summary(id, name)` — the only place that touches raw nodes. Then, by route: Library `library.rs`, `project_picker.rs`, `drive_projects.rs`, `library_import.rs`; Player `main.rs` (lane headers, ruler and zoom controls near `:5700-5720`), `header.rs`, `transport.rs`, `custom_tracks_host.rs`, `metronome.rs`, `carry_line_popover.rs`, `lyrics_sidebar.rs`, `lyrics_editor.rs`, `pitch_strip.rs`, `beat_grid.rs`, `stem_export_dialog.rs`, `project_delete_dialog.rs`; Settings `settings.rs`, `language_menu.rs`; Training `training.rs`, `training_running.rs`; shell `log_panel.rs`, `models.rs`, `engine_setup.rs`, `whats_new.rs`, `quick_start.rs`, `window_chrome.rs`. Focus-order and focus-return fixes in the same files where the walk finds them. `$G/tests/reference/a11y/` expected lists |
| Must not edit | `$G/vendor/`, `singz-uikit`, `src/shared/i18n` (C-60c), any `.cpp` or helper |
| Tests that prove it | C-60a's whole-app driver green at both sizes on a debug build with a client attached (so no duplicate ids); tab-order lists match; existing `test_native_*keyboard*`, settings and footer drivers still green; `cargo test` green |

**C-60c — UIKit semantics and names across locales (2 days). `claude-sonnet-5-5`, medium.**

| | |
|---|---|
| Edit | In `singz-uikit` (own commit, own review): `gpui/src/controls.rs` — a dialog-role variant of `modal_card` (`:267-288`), names or a required-name parameter for the unnamed button builders (`:840-870,903-922`); `gpui/src/toast.rs` — status role and polite live setting; other `*_controls.rs` only where C-60a lists a finding. Here: `$G/Cargo.toml:14` and `$G/Cargo.lock` (pin bump), `src/shared/i18n/<locale>/` for new name keys in all 18 locales, `$G/src/i18n_tests.rs` |
| Tests that prove it | The isolated probe (`$G/tests/test_native_accessibility.py`, whose line 15 hashes `controls.rs` in a sibling `singz-ui` checkout, so that checkout must sit at the new pin) still green; rule 8 as a unit test over every locale; the announcement cases of rule 7 asserted in the whole-app driver by reading the live node's value after the triggering state change; Electron's i18n checks unchanged |
| Then | The human's VoiceOver walk (4.3) on a build of the staged tree |

### C-61 — Accessibility implementation, Windows (5 days, range 4-7). `gpt-reserve`, medium

Depends on C-60. The annotation is shared code, so this package is the Windows
harness, the Windows-only differences and the Narrator walk.

| | |
|---|---|
| Edit | `$G/src/ui_accessibility_app.rs`: lift the macOS-only gate so the route walker and tree dump run on Windows; keep the AX readback behind `cfg(target_os = "macos")`. `$G/src/main.rs`: the gate's `cfg`. New `$G/tests/test_native_accessibility_uia.ps1`: an **out-of-process** UIA client (`System.Windows.Automation`, present in Windows PowerShell) that finds the app window by process id, walks the control view, and writes role, name, AutomationId, value/range/toggle/selection/expand-collapse patterns per node; invoked from a new `accessibility` case in `$G/tests/run_windows_ui.ps1:8-11`. New `$G/tests/test_native_accessibility_windows.py` (or a mode of the existing driver) that feeds the dump to the same `a11y_audit` rules and compares with the macOS dump by `accessibility_id`. Windows-only fixes in the route files C-60b touched, where UIA disagrees |
| Must not edit | `$V/gpui-pre-windows` unless a defect is proven there; that is a stop-and-ask (plan rule 3) and an A+ decision |
| Tests that prove it | The UIA audit green on the Windows field laptop in the interactive-session task, hidden and muted, with a deadline; a negative control (one control with its name removed under a test flag is reported); Invoke, Toggle, RangeValue.SetValue and ExpandCollapse each exercised once through UIA and observed in app state; the same control set by `accessibility_id` as the macOS run. Out-of-process UIA against a hidden window is assumed to work *(inferred)*; if it does not, the run uses the visible-window arrangement of plan section 3.2 |
| Then | The human's Narrator walk (4.3), and NVDA if section 6 item 5 says so |

## 8. Not verified

- The per-frame cost of the tree with a client attached, on either platform.
- How often non-screen-reader software activates the adapter in the field.
- Whether the production tree has duplicate ids, unnamed controls beyond those
  cited, or focus that escapes a modal. No whole-app dump exists.
- Whether AccessKit's macOS and Windows adapters can be deactivated at all.
- That an out-of-process UIA client can read a hidden GPUI window.
- That VoiceOver and Narrator read the pinned adapters' output as the property
  dumps suggest; only the human walk shows that.
- Electron's real screen-reader behaviour; only its attributes were counted.

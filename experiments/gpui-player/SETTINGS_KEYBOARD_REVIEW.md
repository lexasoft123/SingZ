# Native Settings keyboard access — 2026-11-09

Shared UIKit now supplies opt-in Settings control focus/activation and the existing
range painter with 1 dB keys. Enter/Space activate once across physical keydown/up;
range bursts accumulate before repaint and Home/End reach -60/0 dB. Disabled
controls leave Tab order. Existing painters, fonts and lyrics rendering are unchanged.

Settings owns persistent focus handles, modal Tab/Shift-Tab order, selector
highlight/commit/cancel, arrows/Home/End/typeahead, automatic scrolling and all
ordinary controls. Disabled or removed focused controls synchronously return focus
to its mounted modal scope. Host fallback containment prevents song/file commands
from acting behind Settings, including during focus transitions.

## Verified checkpoint

- Normal check, normal build and UI build pass. Two UIKit keyboard-policy tests
  and the existing focused channel-policy test pass.
- Final hidden/muted `--preferences-only --keyboard` journey passes 1280×800 and
  1060×640, retaining the pointer regression and adding 90 recorded keyboard states.
  Actual Tab/Shift-Tab reaches visible controls without direct focus assignment.
- Selectors support Enter/Space, arrows/Home/End, typeahead, Escape cancellation
  and duplicate-output skipping in both directions. Gain receives four Left keys
  before repaint, preserves all increments, and reaches both bounds. Headphone
  confirmation toggles once on Space and once on Enter. Disk preference readback
  confirms accepted keyboard values.
- Explicit synthetic busy and mono-input transitions disable/remove the focused
  selector; focus returns to scope, Tab reaches the first control and Escape
  closes. These transitions qualify focus handling, not hardware route changes.
- Actual Close/Quick Start keys work and restore Player without playback or seek.
  Cmd/Ctrl O/F/S cause no chooser, Save, navigation or project metadata mutation.
  A test-only chooser trap records leakage without presenting an OS dialog.
- Eight final full captures were reviewed: four pointer states remain pixel and
  state-sidecar identical to the previous native checkpoint using compare-ui.py;
  four keyboard/Quick Start images are byte-identical to the inspected v3 images.
  No current production reference was captured, so full production parity is open.
- Foreground remains stable; all eight observed process PIDs retire. Forty-three
  app CPU/footprint/system-GPU samples have no errors or terminal discards. App CPU
  mean 62.79%, p95 100.34%, maximum 100.82% (100% is one core), during interaction
  and screenshot work. Helper CPU is excluded; GPU counters include other apps.
  Hidden live display FPS is unmeasured. This is not a steady-state performance pass.

UI SHA256: `1acd91d2865f3732a17b93732af51d1c37f000453df5e607fb60de33808e6b53`.
Normal source SHA256: `d9ac156dbe5e9cc266d131e856479b534dbd439b1a64105a9d9093f83c0dfc00`.
Normal preview passes deep strict ad-hoc signature verification, all 39 payload
hashes, no-Node inspection and configured Drive build-info; it is not notarized.

Evidence: `/tmp/singz-settings-keys-20261109`; durable selected artifacts are beside
the normal preview in `macos-settings-keys-20261109/settings-keyboard-qualification`.
Both repository source hashes are recorded. v1 exposed a /var vs /private/var test
path comparison; the private root is now canonical. v2 reached the keyboard actions
but exposed an integer comparison against JSON floating gain 0.0; readback now uses
as_f64. v3 passed; v4 also verifies control removal. Failures and assertions remain.

Physical microphone enable, permission UI and monitoring Start/Stop were not
activated. The test uses generated tone audio, isolated storage and explicit
synthetic inventory/error states, with capture/sync disabled. Current Windows/Linux
behavior, every hardware state, complete production visual/temporal parity and
release qualification remain open. Models wizard keyboard access is the next
concrete gap found in the desktop inventory. The full desktop goal remains active.

# Native common controls and configured Drive tour

## Scope — 2026-11-09

The Library Quick Start includes the configured native Drive row between Training
and Settings, matching the existing production tour order. Current mounted state
controls step availability; historical guide anchors cannot retain a removed row.
The existing reveal path scrolls the actual row into view.

Common semantics and action handling remain in sibling UIKit. Buttons, toggles,
checkboxes, tabs, links, selectors and sliders expose roles and values. Hosts supply
localized context for icon controls. Settings and Training share slider state
between pointer, keyboard and accessibility delivery. Song output owns its keyboard
handling in UIKit and retains its existing paint and pointer geometry. Disabled
controls remove actions; slider actions refuse current occlusion/clipping.

This is a scoped functional checkpoint, not whole-app accessibility certification,
production image parity, real Google-account qualification or platform completion.
The pinned macOS adapter does not explicitly bridge selector expanded state; native
open/select/value/close works, while expanded-state qualification remains open.

## Exact local evidence

Evidence root: `/tmp/singz-native-tour-a11y-20261109`.

- `build-v4`: locked offline check, 1,013 Rust tests passed, zero failed, two explicit
  installed-model ignores; UI and normal builds pass with frozen sources/runtime.
- `build-v5`: UI-only node-provenance lookup correction; check/UI/normal builds pass.
  `ui-only-v5-delta.json` isolates the test adapter change, and normal executable is
  byte-identical to v4 (`ui-only-v5-normal-identity.json`).
- Final UI executable SHA-256:
  `ea2de22589ea899c878ac43c622f262bf9db006131440665857bbcc7e5dfa485`.
- Final normal executable SHA-256:
  `726a7e3df4f2f47f765169c20f1e44c2687a3aae0be754a1a16bf9339fe7b499`.
- `a11y-v4`: actual own-process native macOS AX press/toggle/select/range actions,
  checkbox/tab/link, disabled refusal and modal isolation at both desktop sizes;
  four captures. Mixed queued native keyboard/AX actions assert values and record
  frame changes. A separate test-support dispatch through the existing production
  handler proves three same-frame keyboard/AX double steps; it explicitly does
  not claim native OS before-paint delivery. Validation and observer pass.
- `guide-drive-v3`: 18 captures/sidecars at 1280×800 and 1060×640, 2×. Configured,
  unconfigured, removed row, mode reset and Back pass. A 48-project isolated native
  catalog makes the target genuinely offscreen. Reveal moves −1154→−540 and
  −1314→−540 respectively; final row y=60–91, balloon y=111. All 18 full PNGs
  independently reviewed with no clipping or overlap (`visual-review.md`).
- `paint-v5`: all 363 lyric panels and per-frame metadata exactly match the preserved
  native `paint-after-v4` reference. Font/glow source hashes match. This preserves
  approved partial-glyph paint; it does not measure live display cadence.
- `training-keyboard-v5`: native keyboard controls, PCM replay CREPE/scoring and
  owner release pass without physical microphone input.
- `training-running-v5`: running/Summary keyboard actions, replay/skip and owner
  retirement pass at both sizes using PCM replay.
- `static-v5`: 18 maintained native Library/Settings/Player/lyric captures produced
  with natural exit and unchanged foreground. These are candidates with partial
  metadata, not a matched production reference matrix.
- `legacy-guide-v5`: existing four-step Library/eight-step Player tours, actual
  keyboard/modal guard, Back/Next/Done/Escape, restart/manual replay pass. 32 PNGs;
  outer foreground guard passes. Its legacy resource sampler is not the stronger
  observer used for the new adapters.
- `smoke-v5`: common-control interaction smoke passes with 12 captures. Nine PNGs
  match the earlier smoke bytes; three moving-player cases differ and retain their
  differences for review. Full-image review places them only in unchanged stem-lane
  entry/fade code using unfrozen wall time. Exact animation state is absent; no
  actionable product defect was found. Do not classify this matrix as image-exact.

Hidden AX, Drive, lyric and smoke observers record natural exit, unchanged foreground,
no surviving owned process, CPU/footprint and system GPU. Mean sampled CPU / maximum
footprint: AX 9.10% / 255.30 MiB (12 samples); Drive 49.96% / 622.67 MiB (15);
lyric offscreen capture 95.24% / 1504.05 MiB (38); smoke 83.41% / 1037.31 MiB (12).
These are rasterization-test observations, not idle/runtime product benchmarks.
Live FPS remains unmeasured. No Node or Electron ran.

## Rejected runs retained

Build v1 failed new-adapter compile checks. AX v1 failed its test-root backdrop
viewport contract; v2 rejected an invalid native queued-action same-frame assumption;
v3 failed debug element-ID lookup. These are not passes. Final v4 uses the actual
native tree IDs and separates native queued delivery from framework same-frame
coverage. Earlier Guide v1 only established visibility; v2/v3 establish actual scroll
movement. Raw failure logs and diagnostics remain beside accepted runs.

## Remaining acceptance

Whole-app roles, all locales, live announcements, native expanded-state bridging,
production visual/state matrix, live FPS, physical hardware and Windows/Linux
workflows remain open. Public source transfer to VM403 is established for the audited
published older snapshot; transfer alone is no platform workflow result.

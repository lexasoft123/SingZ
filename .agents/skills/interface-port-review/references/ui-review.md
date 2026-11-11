# UI parity review: Electron → GPUI

## Objective and stopping rule

Match ported layout, typography and controls to the **current production Electron interface**.
Lyric paint follows the explicit **approved native GPUI highlighting standard** below.
Repeat capture → compare → inspect → fix → recapture against each case's authoritative baseline.
A working interaction, an attractive screenshot, a successful build, or high FPS is not visual parity.

This is the review procedure, not a record that parity has been achieved. Current prototype
screens and the hidden-window interaction smoke test are starting points. Matching production
fixtures and complete captures for the matrix below still need to be established.

Stop only when:

- Every required screen, size and state has a current reference and candidate capture.
- Data, text, time, state, scale and viewport match before comparison.
- The strict image comparison has zero differing pixels in every compared region/frame.
- A human visual review of full images, overlays and differences finds no omitted content.
- Interaction smoke checks pass after the final visual fix.
- Animation sequences match throughout the transition, including partially highlighted glyphs.

Native and Chromium text rasterization may differ. Record those pixels honestly. If an explicit
exception is agreed, call the result **visual parity with listed exceptions**, never pixel-perfect.
Do not relax thresholds, blur text, rescale screenshots, or mask defects to manufacture a pass.

## Approved native lyrics authority

The user explicitly designated the GPUI **After · partial-glyph sweep** shown in the
120 Hz frame-by-frame preview as the de facto standard, preferred to Electron.
Read [the standard and immutable evidence](../../../../experiments/gpui-player/LYRICS_HIGHLIGHT_STANDARD.md)
before changing lyrics rendering. Its manifest preserves all 161 approved preview images,
original full-frame hashes and timestamps. Before is the rejected whole-glyph switch.

This decision takes precedence over Electron parity for highlight paint: preserve continuous
partial fill, the advancing feathered bright core/glow, the brighter leading/final glyph,
and the softer word halo. Removing a layer or stepping whole letters to improve an Electron
diff is a regression. Performance fixes must retain the approved appearance and progression.
Do not overwrite/regenerate these reference images from current code. A new effect design
requires an explicit later user decision.

Keep baseline authority explicit in the case matrix: Electron for lyrics layout/typography;
approved native GPUI for highlight paint. Record intentional Electron highlight differences
as the user-approved native design, not as defects to eliminate. Do not call the combined
interface pixel-identical to Electron. Fixtures/geometry must still match before exact pixel
comparison; historical full-window frames must not be rescaled or aligned to hide differences.

## Source of truth

Read the live sources at the start of each review batch:

- `src/renderer/src/App.tsx` and `src/renderer/src/styles.css`.
- `src/renderer/src/components/ProjectPicker.tsx` and `SettingsModal.tsx`.
- The production player, lyrics, waveform and transport components reached from App.
- Installed `node_modules/@singz/ui/src/` tokens, typography, chrome, icons and controls.

Capture the real built Electron renderer. Do not recreate the reference in a mock HTML page,
use an old design screenshot as the baseline, or copy the GPUI image into reference output.
Record the app revision, dirty source diff hash, installed UIKit version, sibling UIKit revision
and dirty diff hash, and font file hashes. An uncommitted source can be reviewed, but its exact
contents must be identifiable. A source change invalidates affected captures.

## Background-only execution

All agents in this session share this checkout. Assign separate files; one owner handles
integration, builds and captures. Separate independent sessions use separate worktrees.

Never raise/activate windows, move the OS pointer, send global input, or cover the user's work.

**Electron reference:** build first with `npm run build`; use `playwright-core` `_electron`
from a scratch driver outside the repository. Launch with `SINGZ_E2E_HIDDEN=1`,
`SINGZ_MUTE=1`, `SINGZ_NO_SYNC=1` and an isolated `SINGZ_USERDATA_DIR`. Read
`tests/e2e/mac/quiet-launch.cjs` for the hidden-launch contract. Assert every BrowserWindow
remains invisible and unfocused. Drive DOM/CDP input and capture renderer content. Do not use
`bringToFront`, `showInactive`, `focus`, screen coordinates, or the user's profile/library.
Load fixture files through the hidden file input when exercising the normal loading path.

**GPUI candidate:** build with `--features ui-tests`; launch with
`SINGZ_GPUI_BACKGROUND=1`. The existing `src/ui_smoke.rs` dispatches input directly into the
hidden window and captures with `Window::render_to_image`. Extend this pattern for parity
states; do not substitute OS mouse automation. Keep test adapters behind `ui-tests`.

Check foreground application identity before/after runs without changing it. Clean up only
processes and temporary profiles created by the driver. Apply a bounded timeout.

## Identical capture contract

For every case record a JSON sidecar alongside each PNG containing:

- Case ID; source identity; fixture SHA-256; screenshot SHA-256; OS/version/architecture.
- Content viewport in logical pixels; device scale; PNG pixel dimensions; zoom (1.0).
- Locale, theme, font face/weight/file hashes, text content, and resolved hardware/sample inventory.
- Explicit capture color space: use Electron `--force-color-profile=srgb` against GPUI raw sRGB captures. Do not compare display-P3 bytes with sRGB bytes, strip profiles to conceal a mismatch, or convert a reference after capture; start a new immutable batch with the correct contract.
- Selected song; duration; position; lyric timing; scroll offsets; mix; loop; pitch; active route.
- Hover/focus/open menu state; deterministic animation time and whether transitions are settled.
- Capture method; background/hidden status; any specifically excluded OS-owned region.

Use **content** dimensions, not outer window bounds: start at 1280×800 and 1060×640 logical
pixels, at the same 2× device scale on this Mac. Confirm measured dimensions in both renderers.
Do not resize either PNG to match. Compare another platform/scale as a separate batch.

Use exactly the same original song, PCM/waveform envelope, lyrics, duration, timing, BPM, key,
project names and ordering, dates, badges and settings inventory in both apps. Keep demo fixtures
isolated. The current GPUI generated lanes and fictional catalog cannot be compared against an
unrelated real song or production library. Build a shared deterministic fixture first.

Wait for fonts and layout; settle static transitions using an explicit known time. Freeze song
and animation clocks through test adapters for timed cases. Disable network variability and
use fixed local metadata. Avoid blanket CSS that removes the shadows/animations being reviewed.

Native traffic lights and OS shadows are reviewed as a separate platform-chrome case; they
are absent from hidden GPUI scene captures. A content-only pass must not claim native-chrome parity.

## Required case matrix

Run every case at both content sizes. Record missing/unimplemented states as **blocked**, not skipped/pass.

| Area | Required states and details |
| --- | --- |
| Chrome | Content header, logo, navigation, title, status, gear; native control reserved space; fullscreen reservation separately |
| Library | Current DropScreen hero/storage/card grid; title search; no results; hovered card; long title; scroll top/bottom (do not invent absent filters or sorting) |
| Player layout | Paused loaded fixture; all stems; silent/hidden stems as production shows them; timeline labels; lyrics sidebar; footer |
| Mixer | Default; mute; solo; gain minimum/mid/maximum; reset; transition start/middle/end |
| Transport | Play/pause; restart; loop off/on and bounds; transpose negative/zero/positive; exact clock/BPM text |
| Lyrics layout | Before singing; active line; wrapped line; long word; punctuation; non-Latin text; scroll start/mid/end; source/status row |
| Lyric paint — approved native After baseline | Unsung/sung boundary inside the first, middle and final glyph; advancing feathered bright core/glow; word halo; settled completed word; do not replace with Electron paint |
| Settings | Initial Audio view; every selector open; stereo input + second channel; toggles off/on; monitoring gain; disabled controls; inner scroll bottom |
| Control states | Default, hover, pressed, keyboard focus and disabled for every shared control family |

Additional existing production screens/components discovered during inventory receive rows before
review is called complete. Do not invent replacement layouts or extra tabs to fill missing functionality.

For karaoke, sample consecutive timeline frames at 120 Hz around word starts, glyph boundaries,
word ends and line changes, plus scroll/fade transitions. Each pair uses the **same exact timestamp**.
Compare every frame; inspect a scrubber/contact sheet too. A bright leading/final glyph and
advancing halo must preserve the approved native intensity and behavior. Faster rendering that drops the advancing glow is a failure.

## Capture and inspect

Store artifacts outside source control, e.g. `/tmp/singz-ui-parity/<run>/<case>/`:

```text
reference.png      reference.json
candidate.png      candidate.json
diff/overlay.png   diff/difference.png
diff/pair.png      diff/report.json
review.md
```

Run the strict pair comparator from the repository root (Python + Pillow):

```sh
python3 experiments/gpui-player/tests/compare-ui.py \
  --reference /tmp/singz-ui-parity/run/case/reference.png \
  --candidate /tmp/singz-ui-parity/run/case/candidate.png \
  --out /tmp/singz-ui-parity/run/case/diff
```

Exit 0 means pixel-identical; exit 1 means different; exit 2 means invalid/missing input.
Size mismatches are errors. The tool does not align, crop, blur, normalize or mask images.
It checks image equality only: the reviewer must validate sidecars, fixture identity and matrix
coverage before assigning a case verdict. A comparator pass alone cannot certify those contracts.

Read **both full screenshots** and the generated pair, overlay and difference image after every
capture. Use 100% physical-pixel view and magnified crops; do not judge only a downscaled preview.
An overlay reveals doubled edges/baselines; the difference image amplifies all differing pixels.
Record a bounding box and measured delta for each defect, not just “looks different.”

Inspect in this order:

1. Missing/extra content, incorrect screen structure and states.
2. Overall geometry: header/sidebar/footer sizes, columns, row height and padding.
3. Typography: exact font file and axes, weight, size, baseline, spacing, line-height and wrapping.
4. Control/icon geometry: hit target, icon path, stroke, radius, border thickness, alignment.
5. Surface/color/opacity, gradient stops, inset rims, shadows and glow.
6. Temporal behavior: easing, duration, anticipation, partial glyph fill and continuous moving halo.

Measure reference DOM bounds and computed styles in addition to screenshots. Match GPUI layout
and shaped-text metrics to those measurements; do not guess font sizes from appearance.
Never stretch a font or shift an entire screenshot to conceal a local alignment defect.

## Fix → recapture loop

For each failed case:

1. Add a defect to `review.md`: case, region, expected vs actual, pixel delta, likely owner,
   reference/candidate paths, and the exact code/source identity used.
2. Fix the cause. Shared tokens/fonts/buttons/inputs/toggles/badges/selects belong in
   **`../singz-ui/gpui`**; screen composition belongs in its GPUI screen module. Keep common
   controls out of individual screens. Change the GPUI port to match the current reference.
3. Build the changed crate and host. Run the hidden interaction smoke test to catch control
   regressions such as breaking GPUI click tracking while protecting frameless dragging.
4. Recapture the same failing state and rerun strict comparison. Read the images again.
5. If the fix touched a shared control or font, recapture **every consuming screen/state**.
   For layout changes, recapture both sizes. For lyric paint changes, recapture the full relevant
   timeline sequence, including the bright final glyph and partial fill.
6. Update the defect with after-evidence. Keep it open while any mismatch remains.
7. Repeat until the stopping rule holds. Do not stop merely because the latest version looks better.

Keep reference files immutable within a review batch. If production changed, explicitly start a
new batch and rebuild the reference; do not overwrite the baseline as a fix for candidate failure.

## Final regression and review record

Run the normal host build, hidden UI smoke, comparator self-tests and all required image pairs.
No capture may come from a binary older than its source changes. Record cases as **exact**,
**different**, **blocked**, or **exception explicitly accepted**. Include coverage counts and
outstanding mismatches in the result; never summarize an incomplete matrix as “passed.”

Keep visual correctness and performance separate. The interface performance runner records
CPU/GPU and frame telemetry, but hidden macOS windows suspend display callbacks. Missing FPS
is **unmeasured**, not a pass or evidence of smooth motion. Offscreen manually stepped frames
verify appearance, not live display cadence. Do not steal focus to obtain performance evidence.

A final report states: reference source identity; candidate source identity; fixture and viewport
contract; exact/total case and frame counts; unresolved/accepted differences; screenshots/diffs;
interaction result; and measured versus unavailable performance metrics.

---
name: interface-port-review
description: Implement and review the SingZ interface port from Electron to GPUI with visual parity. Use when adding or changing ported screens, native UIKit controls, typography, layout, icons, lyrics highlighting, glow, animations, or when comparing the port against the current interface. Excludes backend-only changes without a visible UI effect.
---

# Interface port review

Use the current built production Electron interface for ported layout, typography and
controls. Lyrics highlighting has an explicit user-approved native standard:
[approved GPUI After preview](../../../experiments/gpui-player/LYRICS_HIGHLIGHT_STANDARD.md).
Preserve that continuous partial-glyph fill, advancing bright core/glow and word halo.
The user prefers it to Electron. Do not flatten, replace or weaken it to improve an
Electron pixel diff. Change the approved effect only after an explicit later user
product decision. A working prototype is not proof of visual parity.

Before implementing a ported screen or changing its appearance, read
[the review procedure](references/ui-review.md). It defines the capture contract,
required state matrix, strict comparison commands, defect loop and completion criteria.
Apply its relevant cases to the requested change; a full-port parity claim requires the
complete matrix. Resolve project paths from the checkout root containing this `.agents`
directory, including when the session runs in a worktree.

## Execute the comparison loop

1. Identify the production components, installed UIKit tokens and exact font files.
   Establish the same isolated fixture, viewport, device scale, locale, UI state and
   animation timestamp in both renderers. Capture the real reference, not a reconstruction.
2. Build both apps before capture. Keep Electron hidden with `SINGZ_E2E_HIDDEN=1`,
   `SINGZ_MUTE=1`, `SINGZ_NO_SYNC=1` and isolated userData. Keep GPUI hidden with
   `SINGZ_GPUI_BACKGROUND=1` and use its `ui-tests` renderer captures. Dispatch input
   inside the app; never activate/raise a window or send global pointer/keyboard events.
3. Run `experiments/gpui-player/tests/compare-ui.py`. Read the full screenshots,
   overlay and difference image. Measure defects in layout, font metrics/wrapping,
   controls/icons, colors, shadows and temporal behavior, in that order.
4. Fix the cause, rebuild, recapture and compare again. Keep reusable controls and
   tokens in the sibling `singz-ui/gpui` crate. Recheck all consumers after a shared fix.
   Iterate until the relevant cases match; record genuine blockers rather than hiding them.
5. Run hidden interaction checks after the final visual fix. Compare lyric paint to
   the preserved native After sequence, not Electron's flatter highlighting. Verify
   partial glyph fill, the brighter leading/final glyph, advancing glow and smooth
   progression at consecutive timestamps. Review typography/layout separately against
   Electron. A single still image is insufficient.

## Verdict and evidence

- Keep reference captures immutable within a batch. Do not rescale, blur, realign,
  mask defects, or relax thresholds to make the candidate pass.
- A zero-difference image pair is necessary, but also verify fixture/state metadata
  and matrix coverage. Missing captures and unimplemented states are blocked, not passed.
- Do not call renderer rasterization differences pixel-perfect. List exceptions only
  if explicitly accepted; otherwise leave them unresolved.
- Hidden macOS windows suspend display callbacks. Report live FPS as unmeasured when
  unavailable; offscreen stepped screenshots do not establish live smoothness.
- Report source/fixture identities, covered cases/frames, remaining differences,
  capture/diff paths, interaction results and available performance evidence.

The comparator's self-checks are in
`experiments/gpui-player/tests/test_compare_ui.py`. Use the detailed procedure for the
current test commands and artifact structure. Keep one maintained copy of that procedure
in this skill's reference file; the prototype documentation links to it.

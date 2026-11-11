# Measured native lyric overflow — 2026-11-09

## Behavior

Lyric horizontal scrolling previously used a fabricated 349→360px extent and an
11px wheel limit. An unbreakable word wider than the panel could not be fully
reached. The host now measures the actual viewport, shaped row extents and active
paragraph transform. It clamps stale offsets when content shrinks and reserves a
horizontal gutter only when measured content overflows.

The shared UIKit scrollbars, text rendering, approved partial-glyph fill,
advancing bright core/glow, word halo and ordinary word wrapping are unchanged.
The tracked extent uses hidden overflow so the parent is the sole wheel owner;
otherwise GPUI's automatic child scroller and the custom parent both add x.
Actual native input now applies −75px and Shift+wheel −90px exactly once.

The geometry unions the transformed paragraph box with positioned shaped-word
bounds, then includes body padding. It does not append paragraph padding again
after overflowing inline text. This model follows the distinction between
scrollable bounds and ink effects in the
[CSS Overflow specification](https://www.w3.org/TR/css-overflow-3/#scrollable).
It is not a measured Chromium `scrollWidth` equivalence claim.

## Correction to the previous visual report

The white scrollbar corner is not an established visual defect. The historical
canonical-reference review explicitly included it (`REVIEW.md`, lyric scroll
metadata and pass-11 notes). Calling its presence a defect in the ruler follow-up
was premature. Production `LyricsPanel.tsx` has no current paragraph before the
first timed line; its active paragraph later scales by 1.03. Measured native
overflow now reflects that distinction:

- Fitting future lyrics: viewport/content 349px, x range zero, no bottom gutter.
- Ordinary active paragraph: content 360px, range 11px, preserved corner.
- Oversized fixture token: content 1686px, range 1337px, complete `ENDING` visible
  at the right edge through both wheel input and actual thumb dragging.

These are native candidate and source-contract checks. Fresh matching production
captures and complete visual parity remain open under the no-Node constraint.

## Frozen builds and tests

Evidence root: `/tmp/singz-lyrics-overflow-20261109`.

`build-v1` passes UI-enabled test compilation, the full Rust suite (**1,013 passed,
zero failed, two installed-model ignores**) and UI/normal builds. A later
`ui-tests`-only smoke adapter correction targets the label column for vertical
lane scrolling and separately asserts waveform wheel ownership. Both old and new
frozen binaries reproduced the obsolete waveform-targeted assertion first. The
original lane-scroll threshold and delta are retained.

`build-v2` passes UI-enabled compilation and UI/normal builds after that adapter
correction. `smoke-fixture-delta.json` proves it was the only changed build input;
unit-suite compiled inputs are unchanged, and both builds' normal app hashes are
identical. Six CLI observer tests and eight comparator self-tests also pass.

- Final UI app SHA256: `ebe65ef2bae2d65318d4323d16375f39050aeff5df5b5e86f4044f24a9495ffc`.
- Normal app SHA256: `9571bbca7e57a7ee2452e4eb54ed7cb3f9b7db3bd405864378420d21d0e27650`.

The final Python-only observer delta is recorded separately in
`observer-python-delta-final.json`. No compiled Rust, fonts or native helpers
changed for those observation repairs. The app embeds hashes for the journey,
main source and geometry module, all checked by the scrolling driver.

## Accepted runtime evidence

The final `scroll-ui-v4`, `paint-after-v4` and `smoke-v4` workflows all pass on the
same frozen UI binary, sequentially with compilation excluded:

- **20 native scrolling cases**, ten each at 1280×800 and 1060×640, 2× scale:
  fitting/future, active scale, multiword wrapping, oversized first token, thumb
  drag, exact horizontal/Shift+wheel movement, rightmost end, replacement reset
  and retained vertical scrolling. All 20 full screenshots were inspected.
- Actual native thumb/wheel access reaches x=−1337px; replacement resets x/range
  to zero; ordinary vertical wheel is retained at y=−140px.
- **363/363 full lyric-panel frame pairs are pixel-exact** against the separate
  frozen pre-change runtime (`paint-before-v2`, UI SHA256
  `79521b4df38f40ba5892442ec4f537b73e27491dbe49a8fc057dd73e77f1d821`).
  The strict comparator checks identical fixture, 120Hz timestamps, device scale,
  crop, font, scroll position and actual successful glow draws. No masking,
  resizing, alignment, threshold relaxation or reference replacement is used.
  First/final word and line-boundary key panels and before/after pairs were
  visually inspected; all 363 reports, overlays and differences are retained.
- The corrected full hidden smoke passes lyric manual scrolling/tap seek,
  independent compact stem scrolling, ordinary controls, Settings and renderer
  contracts. All 12 smoke screenshots were inspected. The early player entrance
  capture is not a settled-opacity reference.
- Final accepted runs provide **101 valid app CPU/footprint/system-GPU samples**,
  zero live measurement errors, unchanged foreground identity, natural exits,
  no forced stops and no survivors. One raw closing process-name transition is
  discarded only after the actual child is confirmed exited with code zero.
  It never contributes a resource value. Live display FPS is unmeasured.

## Retained failures and limits

Rejected baseline `paint-before-v1` and candidate `paint-after-v3` observation
attempts remain retained; the latter records a zero-footprint read during exit.
`scroll-ui-v2` retains its rejected closing identity observation. The observer
now verifies bounded terminal transitions with `Popen.wait`; persistent live
identity mismatches or invalid live counters still fail, with raw evidence.
The rejected attempts are not promoted. Exact pre-repair Python driver bytes
and hashes are retained, as are both obsolete smoke failures.

This checkpoint qualifies synthetic native UI scrolling and preserves the
current native paint sequence. It does not establish full historical-window or
Electron parity, live cadence, all locales/accessibility, physical device
behavior, Windows/Linux execution, Google consent or release readiness. The
desktop migration remains active; the separate platform source-transfer approval
is still pending as described in `PLATFORM_DRIVE_QUALIFICATION.md`.

Durable evidence is stored in the session visualization directory under
`gpui-lyrics-scroll-20261109`, including accepted and rejected captures, strict
comparison artifacts, source/runtime pins, observations and review records.

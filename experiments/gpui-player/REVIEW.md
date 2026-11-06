# GPUI interface review — 6 November 2026

> **User authority update, 6 November 2026:** lyric paint is governed by
> [the approved native highlighting standard](LYRICS_HIGHLIGHT_STANDARD.md),
> not Electron's highlight effect. Earlier Electron-only lyric comparisons below
> are diagnostic history and cannot authorize removing the approved native layers.
> The approved paint layers are restored; [363-frame verification and limits](LYRICS_RESTORATION_REVIEW.md)
> are recorded separately. Whole-interface parity remains unresolved.

**Pass 10 draft: visual changes remain required. No screen is certified pixel-perfect.**

This report uses `.agents/skills/interface-port-review/SKILL.md`. It replaces the initial
review's obsolete structural findings and blocked-player status. Root integration and the
next capture must confirm any fixes made after pass 10.

## Pass 11 integration update

Current hidden captures and eighteen strict reports are in `/tmp/singz-gpui-fixes-pass11/`.
All eighteen remain non-exact; the canonical references are unchanged. Fractional scaled
layout, CSS baselines, corrected Apple glyph phase, and Chromium-compiled original SVG
noise are included. The six fullscreen comparisons improve over pass 10, without threshold
or reference changes.

The hidden interaction smoke passes in `/tmp/singz-gpui-fixes-smoke11/`. The new five-phase
glyph check reports monotonically increasing physical centroids
`88.03219, 88.28686, 88.53666, 88.78878, 89.03219`, with an exact one-device-pixel
translation between phases zero and one. The grain GPU contract covers 4,096,000 opaque
pixels, maximum channel error one, zero invalid channels. These are rendering/interaction
contracts, not visual-parity passes.

Lyric scroll metadata now matches the canonical reference: 94px initially at 1280,
138.5px at the later active line, and 179px at 1060. Horizontal scrollbar and corner are
present, but pass 11 reveals that shared scrollbar thumb painting is displaced inward by
10px; that defect remains open pending rebuilt evidence. Header compact flex shrinking,
library title tracking/folder spacing, pitch HUD flex/warning typography, and source lyric
action spacing are being corrected after this batch and are not certified by these images.

Five isolated tests of the actual layout precision policy pass. Three whole-crate Taffy
tests are blocked by missing fonts/dev dependency in the published upstream test package;
they were not disabled or declared passing. A read-only incremental renderer review found
no further correctness/resource/default-mode defects across fourteen files.

## Evidence contract

Canonical Electron references are immutable in
`/tmp/singz-ui-parity-review-20261106/canonical-srgb-20261106/`.
Native candidates and all six strict reports are in `/tmp/singz-gpui-fixes-pass10/`.
Each `{library,settings,player}-{1280,1060}-diff/` contains `pair.png` (reference left),
`overlay.png`, `difference.png` and `report.json`. All six full pairs, overlays and difference
images were read. Report JSON records the exact image paths and SHA-256 values.

Both captures use 1280×800 or 1060×640 logical content viewports at 2× scale. Electron was
launched hidden with an isolated profile, muted output, sync disabled and
`--force-color-profile=srgb`. The resulting PNGs and GPUI raw PNGs have no embedded ICC,
gamma or sRGB metadata; all six comparisons report equal profile metadata. Raw screenshot
bytes were preserved: no conversion, scaling, alignment, masking or blur was applied.
Older Display-P3 reference batches are historical evidence, not this comparison's baseline.

The canonical player fixture is paused at 64 seconds of a 192-second synthetic six-stem
song, tempo 1, transpose 0, guide off, Karaoke on, vocals muted, other lanes unmuted, solo
off, all lane gains .8. The reference successfully loads the actual FLAC project through
the hidden file input. The earlier decode blocker was a malformed saved mixer fixture
(`gain` instead of `volume`), and is resolved. Native waveforms consume peaks exported from
that same Chromium-decoded fixture; they no longer use unrelated generated bars.

The driver establishes the viewport before load/seek. Following a resize, it seeks to zero
and then to the target, allowing the real source autoscroll to settle; two measurements
100 ms apart verify stability. Canonical source lyric scroll is 94px at 1280 and 179px at
1060. The old 84px offset came from a launch-size/capture-size mismatch and is not reused.
`run.json`, `color-contract.json`, screen JSON and `frame-map.json` preserve provenance.

## Strict image results

These are raw differing-pixel counts, not calibrated similarity scores. Small channel
changes over large surfaces contribute to the counts, while significant local displacement
also remains visible. Every strict comparison returns non-exact.

| Case | Different pixels | Different percent | Mean absolute channel error |
| --- | ---: | ---: | ---: |
| Catalog 1280×800 | 1,065,749 / 4,096,000 | 26.019263% | 1.225006 |
| Catalog 1060×640 | 886,623 / 2,713,600 | 32.673312% | 1.213850 |
| Settings 1280×800 | 2,352,378 / 4,096,000 | 57.431104% | .828031 |
| Settings 1060×640 | 1,416,298 / 2,713,600 | 52.192585% | .648030 |
| Player 1280×800 | 2,737,887 / 4,096,000 | 66.842944% | 1.561003 |
| Player 1060×640 | 2,140,489 / 2,713,600 | 78.880049% | 3.738220 |

## Structural findings closed by implementation

| Initial finding | Current evidence and limit |
| --- | --- |
| Catalog used an invented project-picker composition | Actual equalizer hero, drop/browse area, storage panel and three-column project grid are present; the main regions align in pass 10. |
| Settings replaced the page below the header | Full-viewport scrim and 960px modal now match the source placement at y=24 at both sizes. |
| Settings heading/padding/navigation/footer differed | Source 21px/800 heading, 28px padding, Quick start, 108px navigation and left Close are implemented. |
| Switches, +/- gain and inline selector options replaced source controls | Shared checkbox, pointer-driven slider and floating selector popups are implemented; smoke interaction is separate from their remaining appearance differences. |
| Player reference unavailable | Real reference loads, matched mixer state and decoded peaks are available. |
| Transport collapsed to one row | Both pass-10 viewports show the required two-row, 119px footer. |
| Header omitted production navigation/tools | Production hierarchy is present; narrow-width flex/ellipsis remains incorrect below. |

## Remaining visual findings

### Shared rendering and controls

Text rasterization and fractional glyph placement still differ. The catalog title is close,
but descriptive text, project-card titles, Settings captions and player controls produce
visible doubled glyph edges in overlays. Dedicated font investigation is underway; this
report does not assign all text differences to antialiasing or approve them as unavoidable.
The difference images also show residual ambient grain/gradient, glow, border and translucent
surface differences. Low mean error does not establish material or glow equivalence.

The shared native scrollbar currently paints the BG-colored full-height 10px track. Source
CSS leaves the track transparent and applies a 3px BG border only to the thumb, enclosing a
4px translucent fill. The native full-height dark strip remains visible below the thumb.
This source-proven issue was sent to the UIKit owner. Browser checkbox checkmark color and
stroke also differ from the current native custom mark. These need fresh consumer captures
after a common-control fix.

### Catalog

Pass-10 structure, hero centering, grid boxes and section positions now closely align.
The native search field is visibly taller than the source's measured 29px shell; its top and
bottom edges double in overlays. The native folder emoji is larger, and the adjacent storage
label differs in placement/glyph width. Project-card title glyph widths/weight still differ.
At 1060×640 the production grid has zero available height; the candidate now reproduces
that current-source behavior rather than substituting a redesigned layout.

### Settings

Main modal and form geometry now align, including the reserved 10px scroll gutter and field
right edge. The microphone strip and monitor section are near their source vertical positions.
Residual caption baseline, checkbox mark, scrollbar and translucent material differences
remain visible. The native monitor badge incorrectly displayed mixed-case `Experimental` in
pass 10; the source's uppercase transformation is now represented by `EXPERIMENTAL` in
`settings.rs`. That one-line correction is **implemented but not captured in pass 10**.

### Player

At 1280 the current lyric line and surrounding line baselines align closely. At 1060 the
native lyric column remains visibly about 5 logical pixels below the canonical reference.
The source bottom horizontal lyric scrollbar and its corner are absent from the native
capture. Source Edit/Change action spacing differs from native at both widths.

At 1060, header controls in Electron shrink and ellipsize, keeping the right-side tools
visible. Native controls retain wider labels and overflow the viewport; this is a significant
responsive-layout difference, separate from glyph rasterization. The pitch strip's Note bars
and key chips, microphone status wrapping, and small footer group/numeric-label spacing also
differ. The two-row footer is restored, but is not certified exact. No arbitrary screen-specific
pixel offset was added to hide these differences.

## Interaction and temporal coverage

Root reports the latest hidden native smoke passes, including selector/toggle/range operation,
modal reopen scroll reset, nested graph wheel forwarding, Escape popup/modal dismissal,
transport changes, zoom and seek. These checks establish behavior only; they do not close the
visual findings above. No real hardware, Drive account or model download is invoked by the
native prototype.

The canonical reference batch also contains twelve unmodified settled lyric frames:
six 60Hz-spaced samples from 64.25 through 64.3333333 seconds, three samples around 72 seconds,
and three around the actual anticipatory line boundary 71.85 seconds. Production advances
current-line selection by .15s, so the latter is the meaningful line-change boundary.
`frame-map.json` records requested/actual positions and scroll state. These are paused seeks
with settled source scrolling, not a live playback recording. Matching frame fills and glow
must be evaluated separately against the corresponding native temporal batch; pass-10
fullscreen inspection alone does not sign off partial-glyph or final-glyph brightness.

| Coverage item | Status |
| --- | --- |
| Six full-screen source/candidate pairs with strict reports | Complete; all non-exact |
| Full-screen pair/overlay/difference inspection | Complete for pass 10 |
| Shared hover/pressed/focus/disabled/menu state matrix | Incomplete |
| Consecutive settled lyric reference frames | Captured; no final temporal parity verdict here |
| Live display cadence/FPS and CPU/GPU under real playback | Not established by these screenshots |
| Native traffic lights/window shadow | Hidden scene capture excludes AppKit chrome; not reviewed here |
| Backend audio/device/library/Drive integration | Outside this local UI prototype's supported functionality |

**Certified exact cases: 0.** Further source-backed corrections must be rebuilt and captured
without replacing canonical references. This document is a current comparison report, not a
release or pixel-perfect sign-off.

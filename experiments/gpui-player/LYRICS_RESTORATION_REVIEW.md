# Approved native lyric highlighting restoration — 6 November 2026

The approved paint layers are restored from the archived implementation: readable base,
12-slice amber feather, continuous 18px bright core (`#ffdf9c`), eight cached halo-opacity
levels and the soft word halo. Progress remains quantized to 1/200; no whole-glyph selection
or per-frame Gaussian blur is used. Newer font, wrapping, baseline and scroll geometry fixes
remain in place. `advancing_glow_draws` now counts successful halo image draws rather than
merely entering an active-word branch.

## Evidence

Candidate batch (separate from the immutable approved reference):
`/Users/maxplanck/.codex/visualizations/2026/11/05/01a1add5-9a90-73c3-bec3-c18bfb04e619/gpui-approved-highlight-restored/`

- `preview.html`: embedded, frame-steppable screenshot preview; all 363 strips are lossless
  crops, 720×120 physical pixels, with no resizing/recoloring. Full panel captures retained.
- `manifest.json`: binary/source/font hashes, timestamps, crop coordinates, successful glow
  draws and hashes for all 363 panel PNGs. Binary identity matches the performance run.
- 161 first-word samples: 63.85–65.183333 seconds at 120 Hz.
- 161 final-word samples: 69.25–70.583333 seconds at 120 Hz.
- 41 line-boundary samples: 71.75–72.083333 seconds at 120 Hz.
- All samples rendered in a hidden window at 1280×800 logical pixels, 2× scale, with scroll
  explicitly settled. First/final glyph progression, completed word and gap were inspected
  in the contact sheet and panel images. Every sampled singing state passed its actual
  advancing-halo image-draw assertion; gap states correctly have zero draws.
- `screens/`: 18 additional hidden captures covering library/settings/player at 1280×800
  and 1060×640 plus the existing lyric temporal cases. Both player sizes inspected.
- Strict regression comparisons against the preceding native pass 20 are exact for all
  four library/settings screenshots. The two player screenshots differ only in the
  restored first-word highlight/halo bounds; their overlays/differences were inspected.
  This is a regression check, not an Electron parity claim.
- Immutable approved preview and all 161 approved frame hashes remain unchanged.

## Verification

Normal and `ui-tests` builds pass (offline, locked). Full hidden interaction smoke passes,
including glyph-phase/emoji-cache/grain/ambient GPU contracts. Eight comparator self-tests
pass. No production Electron or audio backend changes are part of this restoration.

The isolated offscreen performance gate passes: 621 GPU-rendered readback images over
8.002872 measured seconds after 2 seconds warmup, **77.597143 images/sec**; frame interval
p95 13.684584ms, p99 14.151208ms; lyric paint p95 0.139083ms; process CPU mean 91.9851%
(one full core = 100%); system GPU mean 11.7857%, p95 20%; RSS p95 884572160 bytes.
5,940 successful advancing-glow image draws were observed in the measured window.
Foreground application identity is unchanged before/after. Raw resource samples and metric
definitions are retained in `singz-gpui-approved-restoration-perf.json`.

## Limits and verdict

**Approved paint algorithm restored; pixel-identical historical screenshot match is not
certified.** The archived approved preview has older font/layout/window geometry and word
timing. Current paint candidates preserve the later geometry corrections and char-weighted
fixture timing. These are not identical full-image comparison contracts; no reference was
rescaled, aligned or regenerated to conceal that difference. Full-port visual parity is
still unresolved. This batch establishes the restored layers and sampled progression,
not live motion cadence. **Live display FPS is unmeasured**: hidden macOS windows suspend
display callbacks; GPU render/readback throughput is not presentation FPS.

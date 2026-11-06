# Lyrics highlighting standard

**De facto product standard: `gpui-lyrics-approved-120hz-v1`.**

The approved native GPUI **After · partial-glyph sweep** from the frame-by-frame
preview is authoritative for lyric highlighting. On 6 November 2026 the user
explicitly reaffirmed that it was better than Electron and designated that version
as the standard. Electron is not the authority for replacing this effect.

## Immutable evidence

- [Approved interactive before/after preview](tests/reference/approved-lyrics-120hz-v1/preview.html).
- [Manifest, timestamps and SHA-256 identities](tests/reference/approved-lyrics-120hz-v1/manifest.json).
- 161 exact approved After preview images: 63.85–65.18333333333334 seconds,
  sampled at 120 Hz. These are timeline samples, not proof of live display FPS.
- The manifest identifies the original full-window PNGs in the session's durable
  visualization directory. The embedded JPEG preview bytes are preserved without
  re-encoding. Before is the rejected whole-glyph implementation, not a baseline.

[Recovered historical paint code and generator](tests/reference/approved-lyrics-120hz-v1/implementation/)
are archived with provenance. The approved advancing band is 18px wide, divided into
12 slices; its intensity is `(1 - abs(2u - 1))^1.5`, with bright core `#ffdf9c`
and eight cached halo-opacity levels. The amber trail remains feathered and progress
is quantized to 1/200. These values identify the accepted implementation; whole-glyph
`glyph-*.png` selection was superseded before approval.

## Required behavior

Preserve continuous partial-glyph color fill, the continuously advancing feathered
bright core and glow, the brighter leading/final glyph, and the softer word halo.
The effect must move through a glyph rather than switch whole letters. Performance
changes must retain these layers and smooth progression; a faster flattened effect
is a regression.

Keep this standard while fixing typography, layout, controls and window chrome.
Those areas still use the production Electron interface as their reference. Do not
remove native highlight layers merely to reduce an Electron screenshot difference.
Changes to the approved effect require an explicit subsequent user design decision.

## Review and restoration

Recover the implementation and cached assets corresponding to the approved preview;
do not invent a replacement from a still image. Verify consecutive frames around
partial glyphs and the bright leading edge, and run silent background performance
checks. State the fixture, font, viewport, crop and scale when comparing images.
Historical full-player captures have different window/layout geometry from later
ports; do not rescale or align them to manufacture a pixel-exact pass.

The approved paint layers have been restored and checked in a separate 363-frame batch;
see [the restoration review and limits](LYRICS_RESTORATION_REVIEW.md). This does not certify
a pixel-identical match to historical screenshots with older geometry or establish live
display FPS. Keep the approved evidence immutable; do not silently regenerate it from
current code.

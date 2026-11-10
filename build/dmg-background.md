# macOS installer artwork

`dmg-background.tiff` is configured in `electron-builder.yml`. It contains
720 × 480 (72 dpi) and 1440 × 960 (144 dpi) representations for standard and
Retina displays. The Finder window is 720 × 480 points, with icon centers at
(180, 280) and (540, 280). The row leaves room for Finder's title, path,
and status bars, which reduce the visible artwork height.

The editable source is `dmg-background.html`. It reuses the App Store custom
header's Bricolage Grotesque font, four-color bar mark, amber heading, cream
text, and warm radial gradients from `scripts/make-ios-creative-assets.cjs`.
It replaces the earlier generated pastel artwork with a native HTML design.
No image-generation prompt is used for the current artwork.

Render the HTML after installing the pinned dependencies, with a 720 × 480
viewport at device scale factors 1 and 2. Wait for `document.fonts.ready`
before each screenshot. Export the PNGs as TIFF using macOS `sips`, setting
the Retina representation to 144 dpi, then combine standard followed by
Retina using `tiffutil -cathidpicheck`.

The horizontal tapered SVG arrow has an amber-to-gold gradient, fine
highlight, and restrained glow, baked into the background. Finder supplies
the app, Applications folder, and their labels. Muted cream caption wells
keep native dark labels readable across system appearances. The wells sit
at y=327.5, x=97.5/457.5, with size 164 × 30 points; their centers match
the measured native 16-point label glyphs. Check their alignment in an
actual packaged DMG when changing icon size, label size, or positions.

Verified in Finder on 2026-10-31 using the locally built arm64 DMG: the
background matches the source TIFF byte-for-byte, both native labels fit
their caption wells, the arrow aligns with the icon row, and the visible
content clears the path/status bars without a scrollbar. Eject older SingZ
installer volumes before checking a new one: two volumes with the same name
can make Finder resolve the background from the older image.

# Opt-in CSS coordinate precision

This directory preserves the published `gpui-pre 0.3.11` source and license.
Original archive SHA256:
`9303c771abf2acff2a96d706f69d9a82088c4770173a07cce88f0002431d887d`.
Local changes are confined to `src/layout_precision.rs`, `src/taffy.rs`,
`src/window.rs`, `src/elements/text.rs`, `src/elements/div.rs`, `src/text_system/line.rs`,
`src/text_system.rs`, `src/text_system/line_layout.rs`, `src/platform.rs`, and the
public export in `src/gpui.rs`.

```rust
window.set_layout_precision(gpui::LayoutPrecision::CssPixels);
```

Set the policy before the window's first layout. Existing windows default to
`DevicePixels`, retaining the published behavior. The setting belongs to the
window and its layout engine, not a global, thread-local switch or preference.

CSS mode retains geometry at 1/64 scaled layout units instead of snapping it
to whole physical pixels. At device scale 2 this is 1/128 logical-pixel precision. This covers authored absolute lengths and borders, intrinsic
text measurements, absolute layout edges, element offsets, normal text line
heights, recomputed scroll padding, and painted quad/underline bounds/strokes. For example, a 20.5px line centered in
a 51px header keeps its 15.25px origin at 2x scale; a measured 38.658px advance
becomes the CSS layout unit 38.65625px rather than the legacy ceiling of 39px.
A 57.4140625px box remains exact at 2x rather than being rounded to 57.421875px.

CSS text baselines use independently rounded scaled ascent/descent and the floored
upper half-leading: `(round(ascent*DSF) + floor((L-A-D)/2)) / DSF`, with `L` in
1/64 scaled units. `Window::text_baseline(ascent, descent, line_height)` and
`LayoutPrecision::text_baseline(...)` expose this rule for custom text. Default
windows retain the original raw-ascent/descent baseline. Supplied explicit line
heights are respected; the policy does not change unspecified line-height defaults.

The explicit `Window::pixel_snap*` APIs continue to mean physical-pixel snapping.
Applications should use them for moving one-pixel indicators and change-gate
updates themselves, as they do in the production interface. Image/rectangle
captures are not rescaled, aligned, blurred, or otherwise modified by this policy.

Ordinary CSS text snaps its raster baseline to the nearest physical pixel,
matching Skia axis-aligned masks. On macOS, explicit manual painting of transformed
text can use `window.with_fractional_glyph_baselines(|window| { ... })` to retain
four glyph Y phases. This nested drawing scope restores the previous policy.
The Apple rasterizer supports those phases and padding for fractional Y.
Unconfigured windows and other backends retain their one-phase Y contract.
X precision is unchanged. Negative fractional glyph origins are decomposed into
floor + positive phase in CSS mode; default glyph placement remains unchanged.

Tests in `layout_precision.rs` verify the legacy edge/measurement/stroke policy,
the CSS values, and policy independence. Taffy regressions in `taffy.rs` verify
actual centered layout with separate default/CSS/default engines and 1x/2x units. Integrated
hidden captures and interaction/performance verification remain mandatory; these
unit cases do not establish visual parity.

CSS rasterization is keyed per glyph alongside the window policy. Apple uses
explicitly unsmoothed monochrome masks when dilation is zero, device-sized
CoreText fonts for color emoji bitmaps, and OpenType hmtx emoji advances. Per-window
text layout caches clear on policy or device-scale changes and reject old layout
indices. Existing platform shaping APIs retain their default implementations.

# Optional GPU scene grain extension

This directory vendors the unmodified published `gpui-pre-apple 0.3.11` baseline
(zed snapshot `f816e1f9263e3a8ef63c4baaa02e1441ce1c6038`), with the following
local extension. Original Apache-2.0 license and vendored build inputs are retained.

```rust
gpui_apple::configure_grain_effect(tile_rgba, width, height, 0.05)?;
// Request a host redraw. Later:
gpui_apple::clear_grain_effect();
```

The optional material is disabled by default. Configuration is process-local and
applies to every Apple renderer; this prototype has one window. Tile input is
straight-alpha sRGB **RGBA**, one texel per physical pixel, and repeats from the
viewport origin. Configure a tile rasterized at the current device scale. Reapply
on scale changes. The setter validates dimensions, length and opacity and changes
no windows or operating-system state.

When enabled, the existing scene renderer draws into a cached GPU-only BGRA scene
target. A single fullscreen-triangle pass applies CSS overlay blend followed by
source-over, sampling the scene and repeating noise by exact integer pixel index.
This executes inside `render_frame`, shared by visible presentation, hidden
`render_to_image`, offscreen `render_scene_to_image` and benchmark rendering. There
is **no CPU scene readback or per-frame image upload**. The tile and pipeline are
cached until configuration changes; the scene target is recreated on resize.
Opacity zero and `clear_grain_effect` restore the original target path.

The normal Metal build script compiles the additional functions with the existing
shader library. It still requires Xcode's `xcrun metal` and `xcrun metallib` (macOS
12 minimum). `runtime_shaders` uses the same functions in the stitched shader
source and requires the Metal runtime compiler. No additional Rust dependency or
shader-binding struct is needed. This extension changes only the Apple renderer;
other backends retain their original rendering.

The shader handles destination alpha using the W3C blend/source-over equations;
for an opaque application this reduces to:

```
a = noise.a * opacity
B(d, s) = d <= .5 ? 2*d*s : 1 - 2*(1-d)*(1-s)
out.rgb = mix(scene.rgb, B(scene.rgb, noise.rgb), a)
out.a = 1
```

Verification must compare opt-in live and hidden output against the same source
tile and pixel contract, and confirm clear/zero-opacity paths remain unchanged.

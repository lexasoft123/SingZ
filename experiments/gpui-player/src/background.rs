//! Cached raster of the production CSS ambient material.
//!
//! The SVG is the actual `body::after` source, not a substituted random texture.
//! On macOS the opt-in Metal extension blends grain above the entire scene,
//! sharing the live/offscreen path. Other backends currently bake only exposed
//! backdrop grain and require an equivalent composition pass for full parity.
use gpui_kit::*;
use image::{Rgba, RgbaImage};
#[cfg(not(target_os = "macos"))]
use std::sync::Arc;

const GRAIN: &str = r##"<svg xmlns="http://www.w3.org/2000/svg" width="220" height="220"><filter id="n"><feTurbulence type="fractalNoise" baseFrequency="0.85" numOctaves="2" stitchTiles="stitch"/></filter><rect width="100%" height="100%" filter="url(#n)"/></svg>"##;

#[derive(Default)]
pub struct Background {
    key: Option<(u32, u32, u32)>,
    #[cfg(not(target_os = "macos"))]
    image: Option<Arc<RenderImage>>,
    #[cfg(target_os = "macos")]
    grain_scale: Option<u32>,
    #[cfg(not(target_os = "macos"))]
    noise: Option<(u32, RgbaImage)>,
}

impl Background {
    pub fn new() -> Self {
        Self::default()
    }

    /// Uses physical pixel centres and CSS logical ellipse radii. A viewport
    /// resize/scale change invalidates the raster; playback never repaints it.
    pub fn render(&mut self, viewport: Size<Pixels>, scale: f32) -> Div {
        let width = (f32::from(viewport.width) * scale).round().max(1.) as u32;
        let height = (f32::from(viewport.height) * scale).round().max(1.) as u32;
        let key = (width, height, scale.to_bits());
        if self.key != Some(key) {
            #[allow(unused_mut)]
            let mut raster = ambient_raster(width, height, scale);
            #[cfg(target_os = "macos")]
            if self.grain_scale != Some(scale.to_bits()) {
                let tile = grain_tile(scale);
                gpui_apple::configure_grain_effect(
                    tile.as_raw().clone(),
                    tile.width(),
                    tile.height(),
                    0.05,
                )
                .expect("valid production grain tile");
                self.grain_scale = Some(scale.to_bits());
            }
            #[cfg(not(target_os = "macos"))]
            self.composite_grain(&mut raster, scale);
            #[cfg(target_os = "macos")]
            gpui_apple::configure_scene_backdrop(raster.into_raw(), width, height)
                .expect("valid production ambient backdrop");
            #[cfg(not(target_os = "macos"))]
            {
                // GPUI RenderImage stores BGRA; the compositor uses RGBA.
                for pixel in raster.pixels_mut() {
                    pixel.0.swap(0, 2);
                }
                self.image = Some(Arc::new(RenderImage::new(vec![image::Frame::new(raster)])));
            }
            self.key = Some(key);
        }
        #[cfg(target_os = "macos")]
        return div().absolute().inset_0();
        #[cfg(not(target_os = "macos"))]
        div().absolute().inset_0().child(
            img(self.image.as_ref().expect("background raster").clone())
                .absolute()
                .top_0()
                .left_0()
                .w(viewport.width)
                .h(viewport.height),
        )
    }

    /// CSS `mix-blend-mode: overlay; opacity: .05` applied to a scene raster.
    /// The input is straight-alpha sRGB, as returned by render_to_image.
    #[cfg(not(target_os = "macos"))]
    pub fn composite_grain(&mut self, scene: &mut RgbaImage, scale: f32) {
        if self.noise.as_ref().map(|(key, _)| *key) != Some(scale.to_bits()) {
            self.noise = Some((scale.to_bits(), grain_tile(scale)));
        }
        let tile = &self.noise.as_ref().expect("noise raster").1;
        for (x, y, dest) in scene.enumerate_pixels_mut() {
            let source = tile.get_pixel(x % tile.width(), y % tile.height());
            let alpha = source[3] as f32 / 255. * 0.05;
            for channel in 0..3 {
                let base = dest[channel] as f32 / 255.;
                let blend = source[channel] as f32 / 255.;
                let overlay = if base <= 0.5 {
                    2. * base * blend
                } else {
                    1. - 2. * (1. - base) * (1. - blend)
                };
                dest[channel] = ((base + (overlay - base) * alpha) * 255.)
                    .round()
                    .clamp(0., 255.) as u8;
            }
        }
    }
}

/// Reproduce the source's isolated RGBA8 ambient layer before compositing it
/// over body BG. Skia's pinned GPU dither uses an 8x8 A8 lookup; it perturbs
/// premultiplied RGB only, leaving alpha unchanged (see REVIEW.md).
pub(crate) fn ambient_raster(width: u32, height: u32, scale: f32) -> RgbaImage {
    let logical_width = width as f32 / scale;
    let logical_height = height as f32 / scale;
    RgbaImage::from_fn(width, height, |device_x, device_y| {
        let x = (device_x as f32 + 0.5) / scale;
        let y = (device_y as f32 + 0.5) / scale;
        let cool = gradient(
            x,
            y,
            logical_width * 0.96,
            logical_height * 1.12,
            760.,
            540.,
            13. / 255.,
        );
        let warm = gradient(
            x,
            y,
            logical_width * 0.16,
            logical_height * (-0.12),
            900.,
            620.,
            18. / 255.,
        );
        let dither = gpu_dither(device_x, device_y);
        let mut color = [0_f32; 3];
        let mut alpha = 0_f32;
        // First listed CSS background is above subsequent layers.
        for (source, source_alpha) in [([69., 214., 181.], cool), ([255., 160., 40.], warm)] {
            for channel in 0..3 {
                let premul =
                    (source[channel] * source_alpha + dither).clamp(0., source_alpha * 255.);
                color[channel] = (premul + color[channel] * (1. - source_alpha)).round();
            }
            alpha = ((source_alpha + alpha * (1. - source_alpha)) * 255.).round() / 255.;
        }
        let body = [18., 16., 13.];
        Rgba([
            (color[0] + body[0] * (1. - alpha)).round() as u8,
            (color[1] + body[1] * (1. - alpha)).round() as u8,
            (color[2] + body[2] * (1. - alpha)).round() as u8,
            255,
        ])
    })
}

fn gpu_dither(x: u32, y: u32) -> f32 {
    let index = ((y & 1) << 5)
        | ((x & 1) << 4)
        | ((y & 2) << 2)
        | ((x & 2) << 1)
        | ((y & 4) >> 1)
        | ((x & 4) >> 2);
    let byte = ((index as f32 / 64. + 1. / 128.) * 255.).round();
    byte / 255. - 0.5
}

fn gradient(x: f32, y: f32, cx: f32, cy: f32, rx: f32, ry: f32, opacity: f32) -> f32 {
    let distance = (((x - cx) / rx).powi(2) + ((y - cy) / ry).powi(2)).sqrt();
    opacity * (1. - distance / 0.6).clamp(0., 1.)
}

pub(crate) fn grain_tile(scale: f32) -> RgbaImage {
    // Compile the original vector filter with the source renderer: SVG
    // turbulence algorithms differ across engines (see asset provenance).
    let compiled = if (scale - 1.).abs() < 0.0001 {
        Some(include_bytes!("../assets/grain-1x.png").as_slice())
    } else if (scale - 2.).abs() < 0.0001 {
        Some(include_bytes!("../assets/grain-2x.png").as_slice())
    } else {
        None
    };
    if let Some(bytes) = compiled {
        return image::load_from_memory(bytes)
            .expect("compiled SVG grain")
            .into_rgba8();
    }

    let tree = resvg::usvg::Tree::from_str(GRAIN, &resvg::usvg::Options::default())
        .expect("source grain SVG");
    let edge = (220. * scale).round().max(1.) as u32;
    let mut pixmap = resvg::tiny_skia::Pixmap::new(edge, edge).expect("grain pixmap");
    resvg::render(
        &tree,
        resvg::tiny_skia::Transform::from_scale(scale, scale),
        &mut pixmap.as_mut(),
    );
    let mut bytes = pixmap.take();
    // tiny-skia pixels are premultiplied; image::RgbaImage expects straight alpha.
    for pixel in bytes.chunks_exact_mut(4) {
        if pixel[3] > 0 {
            for c in 0..3 {
                pixel[c] = ((pixel[c] as u32 * 255 + pixel[3] as u32 / 2) / pixel[3] as u32)
                    .min(255) as u8;
            }
        }
    }
    RgbaImage::from_raw(edge, edge, bytes).expect("grain raster dimensions")
}

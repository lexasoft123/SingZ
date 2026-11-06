//! Fixture-backed production waveform envelope and cached bitmap layers.
//! Peaks are exported by the real renderer's computePeaks, after AudioContext decoding.
use gpui_kit::*;
use image::{GrayImage, Luma, Rgba, RgbaImage};
use std::{
    cell::RefCell,
    sync::{Arc, OnceLock},
};

const COLORS: [u32; 6] = [0xff5c65, 0xffc53d, 0x527dff, 0xf98424, 0xda81da, 0x27e7bb];
const PAD: f32 = 4.;
static PEAKS: OnceLock<[Vec<f32>; 6]> = OnceLock::new();

fn peaks() -> &'static [Vec<f32>; 6] {
    PEAKS.get_or_init(|| {
        let bytes = include_bytes!("../assets/review-peaks.bin");
        assert_eq!(&bytes[..8], b"SZPK0001", "review peak format");
        let mut offset = 8;
        std::array::from_fn(|_| {
            let count = u32::from_le_bytes(bytes[offset..offset + 4].try_into().unwrap()) as usize;
            offset += 4;
            let values = bytes[offset..offset + count * 4]
                .chunks_exact(4)
                .map(|v| f32::from_le_bytes(v.try_into().unwrap()))
                .collect();
            offset += count * 4;
            values
        })
    })
}

struct Layers {
    key: (u32, u32, u32, u8, u32, u32),
    base: Arc<RenderImage>,
    bright: Arc<RenderImage>,
    mask: GrayImage,
    blur: GrayImage,
}
thread_local! {
    // One current size/state per lane; resizing or fading cannot grow this cache.
    static LAYERS: RefCell<[Option<Layers>; 6]> = const { RefCell::new([None,None,None,None,None,None]) };
}

fn filtered_rgb(color: u32, saturation: f32, brightness: f32) -> [u8; 3] {
    let c = [
        ((color >> 16) & 255) as f32,
        ((color >> 8) & 255) as f32,
        (color & 255) as f32,
    ];
    let luminance = c[0] * 0.213 + c[1] * 0.715 + c[2] * 0.072;
    c.map(|v| {
        ((luminance + saturation * (v - luminance)).clamp(0., 255.) * brightness)
            .round()
            .clamp(0., 255.) as u8
    })
}

/// Rasterize the same 0.8 CSS-pixel rectangles as drawColumns, with its
/// destination-out lower-half gradient. Coverage is calculated in device pixels.
fn mask(
    index: usize,
    width: u32,
    height: u32,
    dpr: f32,
    view_start: f32,
    view_end: f32,
) -> GrayImage {
    let pad = (PAD * dpr).round() as u32;
    let mut image = GrayImage::new(
        (width as f32 * dpr).round() as u32 + pad * 2,
        (height as f32 * dpr).round() as u32 + pad * 2,
    );
    let envelope = &peaks()[index];
    let mid = height as f32 / 2.;
    let amplitude = mid - 2.;
    for x in 0..width {
        let range = (view_end - view_start) as f64;
        let start = view_start as f64;
        let b0 = ((start + x as f64 / width as f64 * range) * envelope.len() as f64)
            .floor()
            .max(0.) as usize;
        let b0 = b0.min(envelope.len() - 1);
        let b1 = (((start + (x + 1) as f64 / width as f64 * range) * envelope.len() as f64).ceil()
            as usize)
            .max(b0 + 1)
            .min(envelope.len());
        let peak = envelope[b0..b1].iter().copied().fold(0_f32, f32::max);
        let half = (peak * amplitude).max(0.75);
        let left = pad as f32 + x as f32 * dpr;
        let right = left + 0.8 * dpr;
        let top = pad as f32 + (mid - half) * dpr;
        let bottom = pad as f32 + (mid + half) * dpr;
        for py in top.floor().max(0.) as u32..bottom.ceil().min(image.height() as f32) as u32 {
            let coverage_y = (bottom.min(py as f32 + 1.) - top.max(py as f32)).clamp(0., 1.);
            let local_y = (py as f32 + 0.5 - pad as f32) / dpr;
            let lower_alpha = if local_y <= mid {
                1.
            } else {
                1. - ((local_y - mid) / mid).clamp(0., 1.) * 0.4
            };
            for px in left.floor() as u32..right.ceil().min(image.width() as f32) as u32 {
                let coverage_x = (right.min(px as f32 + 1.) - left.max(px as f32)).clamp(0., 1.);
                image.put_pixel(
                    px,
                    py,
                    Luma([(coverage_x * coverage_y * lower_alpha * 255.).round() as u8]),
                );
            }
        }
    }
    image
}

fn texture(
    mask: &GrayImage,
    blur: &GrayImage,
    color: [u8; 3],
    strength: f32,
    opacity: f32,
) -> Arc<RenderImage> {
    let image = RgbaImage::from_fn(mask.width(), mask.height(), |x, y| {
        let source = mask.get_pixel(x, y)[0] as f32 / 255.;
        let shadow = blur.get_pixel(x, y)[0] as f32 / 255. * strength;
        let alpha = (source + shadow * (1. - source)) * opacity;
        // RenderImage is BGRA; ImageBuffer's channel type is only its storage.
        Rgba([color[2], color[1], color[0], (alpha * 255.).round() as u8])
    });
    Arc::new(RenderImage::new(vec![image::Frame::new(image)]))
}

fn normalized_view(start: f32, end: f32) -> (f32, f32) {
    if !start.is_finite() || !end.is_finite() {
        return (0., 1.);
    }
    let start = start.clamp(0., 1.);
    let end = end.clamp(0., 1.);
    if end - start < 0.000001 {
        (0., 1.)
    } else {
        (start, end)
    }
}

/// Paint into the `.wave` box (the caller supplies the lane's 7px top/bottom
/// inset). Position/duration are seconds. Fade follows the host's 1→0.16 mute
/// transition; the endpoints reproduce production's separate .1/.14 opacities.
/// Enter is the lane-in easing; the parent applies its overall opacity.
/// The normalized view selects the same interval from the immutable peak envelope.
pub fn paint(
    index: usize,
    position: f32,
    duration: f32,
    fade: f32,
    bounds: Bounds<Pixels>,
    window: &mut Window,
    enter: f32,
    view_start: f32,
    view_end: f32,
) {
    if index >= 6 || bounds.size.width <= px(0.) || bounds.size.height <= px(0.) {
        return;
    }
    let (view_start, view_end) = normalized_view(view_start, view_end);
    let width = f32::from(bounds.size.width).round().max(1.) as u32;
    let height = f32::from(bounds.size.height).round().max(1.) as u32;
    let dpr = window.scale_factor().min(2.);
    let audible = ((fade - 0.16) / 0.84).clamp(0., 1.);
    let fade_step = (audible * 64.).round() as u8;
    let key = (
        width,
        height,
        dpr.to_bits(),
        fade_step,
        view_start.to_bits(),
        view_end.to_bits(),
    );
    LAYERS.with_borrow_mut(|cache| {
        if cache[index].as_ref().is_none_or(|layers| {
            (
                layers.key.0,
                layers.key.1,
                layers.key.2,
                layers.key.4,
                layers.key.5,
            ) != (key.0, key.1, key.2, key.4, key.5)
        }) {
            let mask = mask(index, width, height, dpr, view_start, view_end);
            let blur = image::imageops::blur(&mask, 2. * dpr);
            let t = fade_step as f32 / 64.;
            cache[index] = Some(Layers {
                key,
                base: texture(
                    &mask,
                    &blur,
                    filtered_rgb(COLORS[index], 1.15, 0.65),
                    0.2,
                    0.1 + 0.9 * t,
                ),
                bright: texture(
                    &mask,
                    &blur,
                    filtered_rgb(COLORS[index], 0.15 + t, 1. + 0.06 * t),
                    0.26,
                    0.14 + 0.86 * t,
                ),
                mask,
                blur,
            });
        }
        let layers = cache[index].as_mut().unwrap();
        if layers.key.3 != key.3 {
            let t = fade_step as f32 / 64.;
            layers.base = texture(
                &layers.mask,
                &layers.blur,
                filtered_rgb(COLORS[index], 1.15, 0.65),
                0.2,
                0.1 + 0.9 * t,
            );
            layers.bright = texture(
                &layers.mask,
                &layers.blur,
                filtered_rgb(COLORS[index], 0.15 + t, 1. + 0.06 * t),
                0.26,
                0.14 + 0.86 * t,
            );
            layers.key = key;
        }
        let layers = cache[index].as_ref().unwrap();
        let origin = bounds.origin + point(px(0.), px((1. - enter) * 10.));
        let padded = Bounds::new(
            origin - point(px(PAD), px(PAD)),
            bounds.size + size(px(PAD * 2.), px(PAD * 2.)),
        );
        let _ = window.paint_image(
            padded,
            padded,
            Corners::default(),
            layers.base.clone(),
            0,
            false,
        );
        let fraction = if duration > 0. {
            ((position / duration - view_start) / (view_end - view_start)).clamp(0., 1.)
        } else {
            0.
        };
        let progress = (fraction * f32::from(bounds.size.width) * dpr).floor() / dpr;
        if progress > 0. {
            let clip = Bounds::new(origin, size(px(progress), bounds.size.height));
            window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
                let _ = window.paint_image(
                    padded,
                    padded,
                    Corners::default(),
                    layers.bright.clone(),
                    0,
                    false,
                );
            });
        }
    });
}

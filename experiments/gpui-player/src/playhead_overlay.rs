//! Painted playhead: core line, soft glow and antialiased cap.
//!
//! The glow and the cap are rasterised once per scale factor into two cached
//! textures, so a playback frame paints three primitives and allocates nothing.
//! The line and the waveform's played edge share one device-pixel coordinate
//! (`snap_device`), so they never detach from each other.
use gpui_kit::*;
use image::{Rgba, RgbaImage};
use std::{cell::RefCell, sync::Arc};

/// Logical reach of the glow on each side of the line (the old shadow: blur radius 4.5 = sigma 2.25).
const GLOW_REACH: i32 = 7;
const GLOW_SIGMA: f32 = 2.25;
const GLOW_ALPHA: f32 = 0.55;
const CAP_W: f32 = 9.;
const CAP_H: f32 = 7.;
const GLOW_ROWS: u32 = 4;
const CAP_ALPHA: u8 = 0xe6;

struct Assets {
    dpr: u32,
    glow: Arc<RenderImage>,
    cap: Arc<RenderImage>,
}

thread_local! { static ASSETS: RefCell<Option<Assets>> = const { RefCell::new(None) }; }

/// Floor an absolute window x (logical px) to the device grid. The waveform's
/// played edge and the playhead line both use this single rounding.
pub(crate) fn snap_device(x: f32, dpr: f32) -> f32 {
    (x * dpr).floor() / dpr
}

/// Horizontal profile of a 1 px line blurred by a Gaussian, as alpha 0..1 at
/// logical distance `d` from the line centre.
fn glow_alpha(d: f32) -> f32 {
    // Mean Gaussian density across the 1 px line = its integral over that width.
    const TAPS: u32 = 16;
    let norm = 1. / (GLOW_SIGMA * (2. * std::f32::consts::PI).sqrt());
    let mut sum = 0.;
    for tap in 0..TAPS {
        let x = d - (-0.5 + (tap as f32 + 0.5) / TAPS as f32);
        sum += norm * (-(x * x) / (2. * GLOW_SIGMA * GLOW_SIGMA)).exp() / TAPS as f32;
    }
    GLOW_ALPHA * sum
}

fn glow_texture(dpr: f32) -> Arc<RenderImage> {
    let width = ((GLOW_REACH * 2 + 1) as f32 * dpr).round() as u32;
    let image = RgbaImage::from_fn(width, GLOW_ROWS, |x, _| {
        let d = (x as f32 + 0.5) / dpr - (GLOW_REACH as f32 + 0.5);
        // BGRA storage, straight alpha, like the waveform textures.
        Rgba([0x6e, 0xc4, 0xff, (glow_alpha(d) * 255.).round() as u8])
    });
    Arc::new(RenderImage::new(vec![image::Frame::new(image)]))
}

/// The old path: (0,0) -> (9,0) -> (4.5,7), antialiased by 4x4 supersampling.
fn cap_texture(dpr: f32) -> Arc<RenderImage> {
    let (w, h) = ((CAP_W * dpr).ceil() as u32, (CAP_H * dpr).ceil() as u32);
    let inside = |x: f32, y: f32| {
        // Half-width at depth y shrinks linearly from the full width to zero.
        let half = CAP_W / 2. * (1. - y / CAP_H);
        y >= 0. && y <= CAP_H && (x - CAP_W / 2.).abs() <= half
    };
    let image = RgbaImage::from_fn(w, h, |px, py| {
        let mut covered = 0;
        for sy in 0..4 {
            for sx in 0..4 {
                let x = (px as f32 + (sx as f32 + 0.5) / 4.) / dpr;
                let y = (py as f32 + (sy as f32 + 0.5) / 4.) / dpr;
                covered += u32::from(inside(x, y));
            }
        }
        // BGRA bytes of 0xfff4e0 (R,G,B) at the old path's 0xe6 alpha, times coverage.
        Rgba([0xe0, 0xf4, 0xff, (covered as f32 / 16. * f32::from(CAP_ALPHA)).round() as u8])
    });
    Arc::new(RenderImage::new(vec![image::Frame::new(image)]))
}

/// Make the cached textures current for `dpr`, returning the replaced pair (if
/// any) so the caller can remove them from the sprite atlas.
fn refresh_assets(slot: &mut Option<Assets>, dpr: f32) -> Option<[Arc<RenderImage>; 2]> {
    if slot.as_ref().is_some_and(|assets| assets.dpr == dpr.to_bits()) {
        return None;
    }
    let previous = slot.replace(Assets { dpr: dpr.to_bits(), glow: glow_texture(dpr), cap: cap_texture(dpr) });
    previous.map(|assets| [assets.glow, assets.cap])
}

/// Paint at `fraction` (0..1) of `bounds`' width. No allocation after the
/// first paint at a given scale factor.
pub(crate) fn paint(window: &mut Window, bounds: Bounds<Pixels>, fraction: f64) {
    let dpr = window.scale_factor();
    let x = snap_device(f32::from(bounds.left()) + (fraction * f64::from(f32::from(bounds.size.width))) as f32, dpr);
    let (glow, cap, released) = ASSETS.with_borrow_mut(|slot| {
        let released = refresh_assets(slot, dpr);
        let assets = slot.as_ref().unwrap();
        (assets.glow.clone(), assets.cap.clone(), released)
    });
    // A scale change replaced both textures; remove the old ones from the atlas.
    for image in released.into_iter().flatten() {
        let _ = window.drop_image(image);
    }
    let glow_bounds = Bounds::new(
        point(px(x + 0.5 - GLOW_REACH as f32 - 0.5), bounds.top()),
        size(px((GLOW_REACH * 2 + 1) as f32), bounds.size.height),
    );
    let _ = window.paint_image(glow_bounds, glow_bounds, Corners::default(), glow, 0, false);
    window.paint_quad(fill(
        Bounds::new(point(px(x), bounds.top()), size(px(1.), bounds.size.height)),
        rgba(0xfff4e0d9),
    ));
    let cap_bounds = Bounds::new(point(px(x + 0.5 - CAP_W / 2.), bounds.top()), size(px(CAP_W), px(CAP_H)));
    let _ = window.paint_image(cap_bounds, cap_bounds, Corners::default(), cap, 0, false);
}

#[cfg(test)]
mod tests {
    use super::{cap_texture, glow_alpha, refresh_assets, snap_device};

    #[test]
    fn consecutive_half_pixel_positions_stay_distinct_at_2x_and_fractional_scales() {
        // The old path rounded to the device grid and then again in logical
        // pixels, merging neighbouring half-pixel positions on a 2x display.
        let positions: Vec<f32> = (0..8).map(|i| 100. + i as f32 * 0.5).collect();
        let snapped: Vec<f32> = positions.iter().map(|x| snap_device(*x, 2.)).collect();
        assert_eq!(snapped, positions, "every half-pixel step must map to its own device column");
        for dpr in [1.25_f32, 1.5, 1.75] {
            let columns: Vec<i64> = (0..40).map(|i| (snap_device(50. + i as f32 / dpr, dpr) * dpr).round() as i64).collect();
            assert!(columns.windows(2).all(|pair| pair[1] == pair[0] + 1), "dpr {dpr}: {columns:?}");
        }
    }

    #[test]
    fn glow_is_a_smooth_symmetric_falloff() {
        let centre = glow_alpha(0.);
        assert!(centre > 0.05 && centre < 0.2, "{centre}");
        assert!((glow_alpha(3.) - glow_alpha(-3.)).abs() < 1e-6);
        let profile: Vec<f32> = (0..=7).map(|d| glow_alpha(d as f32)).collect();
        assert!(profile.windows(2).all(|pair| pair[1] < pair[0]), "{profile:?}");
        assert!(glow_alpha(7.) < 0.02);
    }

    #[test]
    fn cap_is_antialiased_and_tapers_to_a_point() {
        let cap = cap_texture(2.);
        let frame = cap.as_bytes(0).expect("cap frame");
        let (w, h) = (18usize, 14usize);
        let alpha = |x: usize, y: usize| frame[(y * w + x) * 4 + 3];
        assert_eq!(alpha(9, 0), 0xe6, "full coverage carries the old path's alpha 0xe6");
        // Centre texel: BGRA bytes of rgba 0xfff4e0e6 (not R and B swapped).
        let centre = &frame[(2 * w + 9) * 4..(2 * w + 9) * 4 + 4];
        assert_eq!(centre, [0xe0, 0xf4, 0xff, 0xe6]);
        assert!(alpha(0, 0) > 0 && alpha(0, 0) < 255 || alpha(1, 0) > 0, "edge pixels are partial, not stairs");
        let row_width = |y: usize| (0..w).filter(|x| alpha(*x, y) > 127).count();
        assert!(row_width(0) > row_width(6) && row_width(6) > row_width(h - 1));
    }

    #[test]
    fn a_scale_cycle_releases_every_replaced_texture() {
        let mut slot = None;
        assert!(refresh_assets(&mut slot, 1.).is_none(), "first build replaces nothing");
        assert!(refresh_assets(&mut slot, 1.).is_none(), "same scale keeps the cache");
        let (glow, cap) = {
            let assets = slot.as_ref().unwrap();
            (assets.glow.clone(), assets.cap.clone())
        };
        let mut released = Vec::new();
        for dpr in [2., 1., 2., 1.5, 1.] {
            released.extend(refresh_assets(&mut slot, dpr).expect("a scale change replaces the pair"));
        }
        assert_eq!(released.len(), 10, "two textures per scale change reach drop_image");
        assert!(released.iter().any(|image| std::sync::Arc::ptr_eq(image, &glow)));
        assert!(released.iter().any(|image| std::sync::Arc::ptr_eq(image, &cap)));
        // Exactly the final pair stays live.
        let live = slot.as_ref().unwrap();
        assert!(released.iter().all(|image| !std::sync::Arc::ptr_eq(image, &live.glow) && !std::sync::Arc::ptr_eq(image, &live.cap)));
    }
}

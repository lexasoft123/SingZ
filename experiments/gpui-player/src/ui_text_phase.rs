//! Hidden glyph-raster invariant. These are synthetic test glyphs, never UI
//! references or screenshot alignment adjustments.
#![cfg(feature = "ui-tests")]
use crate::Player;
use gpui_kit::*;

const SIZE: f32 = 17.;
const X: f32 = 20.;
const STRIDE: f32 = 40.;
const BASELINE: f32 = 50.;
const STATIC_BASELINE: f32 = 130.;
const X_PHASE_BASELINE: f32 = 210.;
const X_REFERENCE_BASELINE: f32 = 290.;
const X_PHASES: [f32; 12] = [
    0.0625, 0.125, 0.1875, 0.3125, 0.375, 0.4375, 0.5625, 0.625, 0.6875, 0.8125, 0.875, 0.9375,
];
const PHASES: [f32; 5] = [0., 0.25, 0.5, 0.75, 1.];

/// Five identical white glyphs on black. Their X origins are device integers,
/// while baseline Y advances in physical quarters independently of device scale.
pub fn overlay() -> impl IntoElement {
    canvas(
        |b, _, _| b,
        |_, b, window, _| {
            window.paint_quad(fill(b, rgb(0)));
            let line = window.text_system().shape_line(
                "H".into(),
                px(SIZE),
                &[TextRun {
                    len: 1,
                    font: Font {
                        family: "SingZ Display 400".into(),
                        weight: FontWeight::NORMAL,
                        ..Default::default()
                    },
                    color: rgb(0xffffff).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
                None,
            );
            let Some(run) = line.runs.first() else {
                return;
            };
            let Some(glyph) = run.glyphs.first() else {
                return;
            };
            let scale = window.scale_factor();
            let baseline = (BASELINE * scale).round();
            window.with_fractional_glyph_baselines(|window| {
                for (index, phase) in PHASES.into_iter().enumerate() {
                    let x = ((X + index as f32 * STRIDE) * scale).round();
                    let _ = window.paint_glyph(
                        point(px(x / scale), px((baseline + phase) / scale)),
                        run.font_id,
                        glyph.id,
                        px(SIZE),
                        rgb(0xffffff).into(),
                    );
                }
            });
            // A separate ordinary-text row checks physical Y snapping and
            // proves that the fractional drawing scope restored its policy.
            let static_baseline = (STATIC_BASELINE * scale).round();
            for (index, phase) in PHASES.into_iter().enumerate() {
                let x = ((X + index as f32 * STRIDE) * scale).round();
                let _ = window.paint_glyph(
                    point(px(x / scale), px((static_baseline + phase) / scale)),
                    run.font_id,
                    glyph.id,
                    px(SIZE),
                    rgb(0xffffff).into(),
                );
            }
            // Source mask fixtures prove nearest-quarter X quantization with
            // ties upward, including the carry from phase .875 to the next pixel.
            for (index, phase) in X_PHASES.into_iter().enumerate() {
                let x = ((X + index as f32 * STRIDE) * scale).round();
                for (baseline, offset) in [
                    (X_PHASE_BASELINE, phase),
                    (X_REFERENCE_BASELINE, (phase * 4. + 0.5).floor() / 4.),
                ] {
                    let baseline = (baseline * scale).round();
                    let _ = window.paint_glyph(
                        point(px((x + offset) / scale), px(baseline / scale)),
                        run.font_id,
                        glyph.id,
                        px(SIZE),
                        rgb(0xffffff).into(),
                    );
                }
            }
        },
    )
    .absolute()
    .inset_0()
}

#[cfg(target_os = "macos")]
fn check_emoji_policy_and_cache(window: &mut Window) -> anyhow::Result<()> {
    use anyhow::ensure;
    use std::sync::Arc;

    let shape = |window: &Window| {
        window.text_system().layout_line(
            "📁",
            px(12.5),
            &[TextRun {
                len: "📁".len(),
                font: Font {
                    family: "SingZ Display 400".into(),
                    ..Default::default()
                },
                color: rgb(0xffffff).into(),
                background_color: None,
                underline: None,
                strikethrough: None,
            }],
            None,
        )
    };
    let original_policy = window.layout_precision();
    let result = (|| -> anyhow::Result<()> {
        window.set_layout_precision(LayoutPrecision::CssPixels);
        let first_css = shape(window);
        ensure!(
            first_css.width == px(12.5),
            "CSS emoji advance must be 12.5px, got {:?}",
            first_css.width
        );
        ensure!(
            first_css
                .runs
                .iter()
                .flat_map(|run| &run.glyphs)
                .any(|glyph| glyph.is_emoji),
            "Emoji cache contract did not exercise a color-font fallback"
        );
        ensure!(
            Arc::ptr_eq(&first_css, &shape(window)),
            "An unchanged CSS policy did not reuse its line layout cache"
        );

        window.set_layout_precision(LayoutPrecision::DevicePixels);
        let legacy = shape(window);
        ensure!(
            legacy.width == px(17.),
            "Legacy CoreText emoji advance changed: expected 17px, got {:?}",
            legacy.width
        );
        ensure!(
            !Arc::ptr_eq(&first_css, &legacy),
            "Changing to legacy policy reused the CSS line layout"
        );

        window.set_layout_precision(LayoutPrecision::CssPixels);
        let restored_css = shape(window);
        ensure!(
            restored_css.width == px(12.5),
            "Restoring CSS policy retained legacy emoji metrics: {:?}",
            restored_css.width
        );
        ensure!(
            !Arc::ptr_eq(&legacy, &restored_css) && !Arc::ptr_eq(&first_css, &restored_css),
            "Policy changes did not invalidate both line layout frame caches"
        );
        ensure!(
            Arc::ptr_eq(&restored_css, &shape(window)),
            "The restored CSS cache did not retain its layout"
        );
        eprintln!(
            "Emoji policy/cache contract: device-scale={}, advances CSS={}px → legacy={}px → CSS={}px; cache replacement and reuse verified",
            window.scale_factor(),
            f32::from(first_css.width),
            f32::from(legacy.width),
            f32::from(restored_css.width)
        );
        Ok(())
    })();
    // Restore on every Result path, including failed intermediate assertions.
    window.set_layout_precision(original_policy);
    result
}

#[cfg(target_os = "macos")]
pub fn run_check(view: &Entity<Player>, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    ensure!(
        window.layout_precision() == LayoutPrecision::CssPixels,
        "Y-phase contract requires the opt-in CSS coordinate policy"
    );
    let original_flag = view.read(cx).text_phase_check;
    let tile = crate::background::grain_tile(window.scale_factor());
    let result = (|| -> anyhow::Result<()> {
        view.update(cx, |player, cx| {
            player.text_phase_check = true;
            cx.notify();
        });
        gpui_apple::clear_grain_effect();
        let _ = window.draw(cx);
        let pixels = window
            .render_to_image()
            .context("capturing fractional glyph baseline probe")?;
        let scale = window.scale_factor();
        let baseline = (BASELINE * scale).round() as i32;
        // Fixed, padded regions around the known test origins. No search for
        // shifts, rescaling, filtering or image realignment is performed.
        let left = -(4. * scale).ceil() as i32;
        let right = (24. * scale).ceil() as i32;
        let top = baseline - (32. * scale).ceil() as i32;
        let bottom = baseline + (8. * scale).ceil() as i32;
        let origins: Vec<i32> = (0..5)
            .map(|index| ((X + index as f32 * STRIDE) * scale).round() as i32)
            .collect();
        ensure!(
            top >= 0
                && bottom + 1 < pixels.height() as i32
                && origins[0] + left >= 0
                && origins[4] + right < pixels.width() as i32,
            "Glyph probe does not fit the hidden viewport"
        );
        let mut centroids = [0_f64; 5];
        let mut masses = [0_u64; 5];
        for index in 0..5 {
            let mut moment = 0_u64;
            for y in top..bottom {
                for dx in left..right {
                    let pixel = pixels.get_pixel((origins[index] + dx) as u32, y as u32);
                    ensure!(
                        pixel[3] == 255 && pixel[0] == pixel[1] && pixel[1] == pixel[2],
                        "Glyph probe must be opaque monochrome at ({},{y})",
                        origins[index] + dx
                    );
                    let coverage = u64::from(pixel[0]);
                    masses[index] += coverage;
                    moment += coverage * y as u64;
                }
            }
            ensure!(
                masses[index] > 0,
                "Glyph phase {} painted no coverage",
                PHASES[index]
            );
            centroids[index] = moment as f64 / masses[index] as f64;
        }
        eprintln!(
            "Glyph Y-phase contract: device-scale={scale}, baselines={PHASES:?}, centroids={centroids:?}, coverage={masses:?}"
        );
        for index in 1..5 {
            ensure!(
                centroids[index] > centroids[index - 1],
                "Increasing Y phase moved coverage upward or not at all: {:?}",
                centroids
            );
        }
        let mut differing_channels = 0_u64;
        let mut first_difference = None;
        for y in top..bottom {
            for dx in left..right {
                let zero = pixels.get_pixel((origins[0] + dx) as u32, y as u32);
                let one = pixels.get_pixel((origins[4] + dx) as u32, (y + 1) as u32);
                for channel in 0..4 {
                    if zero[channel] != one[channel] {
                        differing_channels += 1;
                        first_difference.get_or_insert((
                            dx,
                            y,
                            channel,
                            zero[channel],
                            one[channel],
                        ));
                    }
                }
            }
        }
        ensure!(
            differing_channels == 0,
            "Y phase 1 is not an exact one-device-pixel translation of phase 0: {differing_channels} channels, first {first_difference:?}"
        );
        let static_baseline = (STATIC_BASELINE * scale).round() as i32;
        let static_top = static_baseline - (32. * scale).ceil() as i32;
        let static_bottom = static_baseline + (8. * scale).ceil() as i32;
        ensure!(
            static_bottom + 1 < pixels.height() as i32,
            "Static glyph row does not fit viewport"
        );
        for index in 1..5 {
            let expected_shift = (PHASES[index] + 0.5).floor() as i32;
            for y in static_top..static_bottom {
                for dx in left..right {
                    let zero = pixels.get_pixel((origins[0] + dx) as u32, y as u32);
                    let actual =
                        pixels.get_pixel((origins[index] + dx) as u32, (y + expected_shift) as u32);
                    ensure!(
                        zero == actual,
                        "Static CSS baseline phase {} differs from expected physical row {expected_shift} at ({dx},{y}): {zero:?} vs {actual:?}",
                        PHASES[index]
                    );
                }
            }
        }
        eprintln!(
            "Static CSS Y-snap contract: device-scale={scale}, phases={PHASES:?}, expected row shifts=[0,0,1,1,1]; explicit fractional scope restored"
        );
        let x_baseline = (X_PHASE_BASELINE * scale).round() as i32;
        let x_reference_baseline = (X_REFERENCE_BASELINE * scale).round() as i32;
        let row_offset = x_reference_baseline - x_baseline;
        let x_top = x_baseline - (32. * scale).ceil() as i32;
        let x_bottom = x_baseline + (8. * scale).ceil() as i32;
        let last_x = ((X + (X_PHASES.len() - 1) as f32 * STRIDE) * scale).round() as i32;
        ensure!(
            x_bottom + row_offset < pixels.height() as i32
                && last_x + right < pixels.width() as i32,
            "X phase rows do not fit the hidden viewport"
        );
        for (index, phase) in X_PHASES.into_iter().enumerate() {
            let origin = ((X + index as f32 * STRIDE) * scale).round() as i32;
            for y in x_top..x_bottom {
                for dx in left..right {
                    let actual = pixels.get_pixel((origin + dx) as u32, y as u32);
                    let reference = pixels.get_pixel((origin + dx) as u32, (y + row_offset) as u32);
                    ensure!(
                        actual == reference,
                        "CSS X phase {phase} differs from nearest-quarter reference at ({dx},{y}): {actual:?} vs {reference:?}"
                    );
                }
            }
        }
        eprintln!(
            "CSS nearest-quarter X contract: device-scale={scale}, phases={X_PHASES:?}; all phase boundaries and integer carry verified"
        );
        check_emoji_policy_and_cache(window)?;
        Ok(())
    })();
    // Restore both state and material for every Result path before returning
    // numerical or capture failures to the parent test driver.
    view.update(cx, |player, cx| {
        player.text_phase_check = original_flag;
        cx.notify();
    });
    let restored = gpui_apple::configure_grain_effect(
        tile.as_raw().clone(),
        tile.width(),
        tile.height(),
        0.05,
    )
    .map_err(anyhow::Error::msg);
    let _ = window.draw(cx);
    result?;
    restored?;
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn run_check(_: &Entity<Player>, _: &mut Window, _: &mut App) -> anyhow::Result<()> {
    anyhow::bail!("Apple fractional glyph-raster contract is unavailable on this platform")
}

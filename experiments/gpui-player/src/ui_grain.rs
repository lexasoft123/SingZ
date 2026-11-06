//! Hidden GPU contract for the optional Metal grain compositor. This is a
//! shader-equation check, separate from immutable production parity captures.
#![cfg(feature = "ui-tests")]
use gpui_kit::{App, Window};

#[cfg(target_os = "macos")]
pub fn check(window: &mut Window, _cx: &mut App) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};

    // Restore even if capture, dimension, alpha or numerical assertions fail.
    struct RestoreProduction {
        grain: image::RgbaImage,
        ambient: image::RgbaImage,
    }
    impl Drop for RestoreProduction {
        fn drop(&mut self) {
            if let Err(error) = gpui_apple::configure_scene_backdrop(
                self.ambient.as_raw().clone(),
                self.ambient.width(),
                self.ambient.height(),
            ) {
                eprintln!("Could not restore production ambient after GPU contract: {error}");
            }
            if let Err(error) = gpui_apple::configure_grain_effect(
                self.grain.as_raw().clone(),
                self.grain.width(),
                self.grain.height(),
                0.05,
            ) {
                eprintln!("Could not restore production grain after GPU contract: {error}");
            }
        }
    }
    let scale = window.scale_factor();
    let viewport = window.viewport_size();
    let width = (f32::from(viewport.width) * scale).round() as u32;
    let height = (f32::from(viewport.height) * scale).round() as u32;
    let _restore = RestoreProduction {
        grain: crate::background::grain_tile(scale),
        ambient: crate::background::ambient_raster(width, height, scale),
    };

    // This independently specified tile exercises RGB channel order, both
    // overlay branches, full/partial/zero alpha, and non-power-of-two repetition.
    // Its phase is anchored at (0,0), including pixels on all viewport edges.
    const WIDTH: u32 = 3;
    const HEIGHT: u32 = 2;
    const TILE: [[u8; 4]; 6] = [
        [0, 255, 64, 255],
        [255, 0, 240, 128],
        [128, 128, 128, 255],
        [20, 220, 100, 64],
        [230, 30, 180, 0],
        [64, 192, 128, 192],
    ];
    const OPACITY: f32 = 0.05;
    gpui_apple::configure_grain_effect(
        TILE.into_iter().flatten().collect(),
        WIDTH,
        HEIGHT,
        OPACITY,
    )
    .map_err(anyhow::Error::msg)?;
    let actual = window
        .render_to_image()
        .context("capturing GPU grain scene")?;
    gpui_apple::clear_grain_effect();
    // Deliberately do not draw or advance any clocks between captures: these
    // two images rasterize exactly the same stored GPUI Scene.
    let base = window
        .render_to_image()
        .context("capturing identical unprocessed scene")?;
    ensure!(
        actual.dimensions() == base.dimensions(),
        "Grain changed viewport dimensions"
    );
    ensure!(
        base.width() > WIDTH && base.height() > HEIGHT,
        "Grain contract needs a real viewport"
    );

    let mut max_error = 0_u8;
    let mut incorrect_channels = 0_u64;
    let mut changed_pixels = 0_u64;
    let mut opaque_pixels = 0_u64;
    let mut dark_branch = 0_u64;
    let mut light_branch = 0_u64;
    let mut transparent_tile_pixels = 0_u64;
    let mut first_failure = None;
    for (x, y, original) in base.enumerate_pixels() {
        ensure!(
            original[3] == 255,
            "Unprocessed scene is not opaque at ({x},{y}): {}",
            original[3]
        );
        let rendered = actual.get_pixel(x, y);
        ensure!(
            rendered[3] == 255,
            "GPU grain changed opaque alpha at ({x},{y}): {}",
            rendered[3]
        );
        opaque_pixels += 1;
        let tile = TILE[((y % HEIGHT) * WIDTH + (x % WIDTH)) as usize];
        let alpha = f64::from(tile[3]) / 255.0 * f64::from(OPACITY);
        if tile[3] == 0 {
            transparent_tile_pixels += 1;
        }
        if rendered != original {
            changed_pixels += 1;
        }
        for channel in 0..3 {
            let destination = f64::from(original[channel]) / 255.0;
            let source = f64::from(tile[channel]) / 255.0;
            let blended = if destination <= 0.5 {
                dark_branch += 1;
                2.0 * destination * source
            } else {
                light_branch += 1;
                1.0 - 2.0 * (1.0 - destination) * (1.0 - source)
            };
            let expected = ((destination * (1.0 - alpha) + blended * alpha) * 255.0)
                .round()
                .clamp(0.0, 255.0) as u8;
            let error = rendered[channel].abs_diff(expected);
            max_error = max_error.max(error);
            if error > 1 {
                incorrect_channels += 1;
                first_failure.get_or_insert((x, y, channel, expected, rendered[channel]));
            }
            if tile[3] == 0 {
                ensure!(
                    rendered[channel] == original[channel],
                    "Zero-alpha grain modified ({x},{y}) channel {channel}"
                );
            }
        }
    }
    eprintln!(
        "Grain GPU contract: {}×{}, opaque={opaque_pixels}, dark={dark_branch}, light={light_branch}, zero-alpha={transparent_tile_pixels}, changed={changed_pixels}, max-error={max_error}, invalid-channels={incorrect_channels}",
        base.width(),
        base.height()
    );
    ensure!(
        dark_branch > 0 && light_branch > 0,
        "Scene did not exercise both overlay branches"
    );
    ensure!(
        transparent_tile_pixels > 0 && changed_pixels > 0,
        "Grain contract did not exercise transparency and visible changes"
    );
    ensure!(
        incorrect_channels == 0,
        "GPU overlay differs from independent CPU equation: max error {max_error}, invalid channels {incorrect_channels}, first {first_failure:?}"
    );
    check_backdrop(window, width, height)?;
    Ok(())
}

/// Read the actual stored scene as premultiplied RGBA8, then verify composition
/// over an independent opaque checker before overlay grain. No scene advances.
#[cfg(target_os = "macos")]
fn check_backdrop(window: &mut Window, width: u32, height: u32) -> anyhow::Result<()> {
    use anyhow::{Context, ensure};
    gpui_apple::clear_scene_backdrop();
    gpui_apple::clear_grain_effect();
    gpui_apple::configure_scene_backdrop(
        vec![0; width as usize * height as usize * 4],
        width,
        height,
    )
    .map_err(anyhow::Error::msg)?;
    let ui = window
        .render_to_image()
        .context("capturing transparent quantized UI surface")?;
    ensure!(
        ui.dimensions() == (width, height),
        "UI surface dimensions changed"
    );
    // Alternating black/white quadrants guarantee both overlay branches even
    // when the production UI itself uses only dark panels.
    let ambient = image::RgbaImage::from_fn(width, height, |x, y| {
        let value = if (x / 17 + y / 13) % 2 == 0 { 0 } else { 255 };
        image::Rgba([value, value, value, 255])
    });
    gpui_apple::configure_scene_backdrop(ambient.as_raw().clone(), width, height)
        .map_err(anyhow::Error::msg)?;
    const TILE: [[u8; 4]; 4] = [
        [20, 230, 70, 255],
        [240, 30, 180, 128],
        [110, 200, 40, 0],
        [200, 90, 250, 64],
    ];
    const OPACITY: f32 = 0.2;
    gpui_apple::configure_grain_effect(TILE.into_iter().flatten().collect(), 2, 2, OPACITY)
        .map_err(anyhow::Error::msg)?;
    let actual = window
        .render_to_image()
        .context("capturing GPU ambient plus grain")?;
    let mut translucent = 0_u64;
    let mut dark = 0_u64;
    let mut light = 0_u64;
    let mut invalid = 0_u64;
    let mut max_error = 0_u8;
    let mut first = None;
    for (x, y, source_ui) in ui.enumerate_pixels() {
        let alpha = f64::from(source_ui[3]) / 255.;
        if source_ui[3] > 0 && source_ui[3] < 255 {
            translucent += 1;
        }
        let background = ambient.get_pixel(x, y);
        let noise = TILE[((y % 2) * 2 + x % 2) as usize];
        let noise_alpha = f64::from(noise[3]) / 255. * f64::from(OPACITY);
        let rendered = actual.get_pixel(x, y);
        ensure!(
            rendered[3] == 255,
            "Ambient composition lost opaque alpha at ({x},{y})"
        );
        for channel in 0..3 {
            // ui bytes are ALREADY premultiplied and rounded to RGBA8.
            let base = f64::from(source_ui[channel]) / 255.
                + f64::from(background[channel]) / 255. * (1. - alpha);
            let grain = f64::from(noise[channel]) / 255.;
            let blend = if base <= 0.5 {
                dark += 1;
                2. * base * grain
            } else {
                light += 1;
                1. - 2. * (1. - base) * (1. - grain)
            };
            let expected = ((base * (1. - noise_alpha) + blend * noise_alpha) * 255.)
                .round()
                .clamp(0., 255.) as u8;
            let error = rendered[channel].abs_diff(expected);
            max_error = max_error.max(error);
            if error > 1 {
                invalid += 1;
                first.get_or_insert((x, y, channel, expected, rendered[channel]));
            }
        }
    }
    eprintln!(
        "Ambient GPU contract: {width}×{height}, translucent-ui={translucent}, dark={dark}, light={light}, max-error={max_error}, invalid={invalid}"
    );
    ensure!(
        translucent > 0,
        "Ambient contract never exercised translucent UI"
    );
    ensure!(
        dark > 0 && light > 0,
        "Ambient contract missed an overlay branch"
    );
    ensure!(
        invalid == 0,
        "GPU ambient/grain differs from independent premultiplied CPU equation: max {max_error}, invalid {invalid}, first {first:?}"
    );
    Ok(())
}

#[cfg(not(target_os = "macos"))]
pub fn check(_: &mut Window, _: &mut App) -> anyhow::Result<()> {
    anyhow::bail!("Metal grain contract is unavailable on this platform")
}

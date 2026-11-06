//! Opt-in logical layout precision for interfaces shared with CSS renderers.
use crate::{
    SUBPIXEL_VARIANTS_Y,
    util::{
        ceil_to_device_pixel, round_half_toward_zero, round_stroke_to_device_pixel,
        round_to_device_pixel,
    },
};

/// Coordinate policy for a window's layout and drawing.
///
/// The default preserves GPUI's original device-pixel layout and text behavior.
/// `CssPixels` retains 1/64 scaled layout units (1/(64*DSF) logical pixels);
/// callers should still explicitly snap moving one-pixel indicators when desired.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub enum LayoutPrecision {
    /// Snap geometry to physical pixels, including ceiling measured text sizes.
    #[default]
    DevicePixels,
    /// Retain fractional geometry on a 1/64 scaled-layout-pixel grid.
    CssPixels,
}

impl LayoutPrecision {
    #[inline]
    pub(crate) fn glyph_x_position(self, value: f32) -> f32 {
        match self {
            Self::CssPixels => (value * 4. + 0.5).floor() / 4.,
            Self::DevicePixels => round_half_toward_zero(value * 4.) / 4.,
        }
    }

    #[inline]
    pub(crate) fn css_value(value: f32) -> f32 {
        (value * 64.).round() / 64.
    }

    /// Convert a logical length to the layout engine's scaled coordinate space.
    #[inline]
    pub(crate) fn scaled_value(self, value: f32, scale: f32) -> f32 {
        match self {
            Self::DevicePixels => round_to_device_pixel(value, scale),
            Self::CssPixels => Self::css_value(value * scale),
        }
    }

    #[inline]
    pub(crate) fn measured_value(self, value: f32, scale: f32) -> f32 {
        match self {
            Self::DevicePixels => ceil_to_device_pixel(value.max(0.), scale),
            Self::CssPixels => Self::css_value(value.max(0.) * scale),
        }
    }

    #[inline]
    pub(crate) fn scaled_edge(self, value: f32, _scale: f32) -> f32 {
        match self {
            Self::DevicePixels => round_half_toward_zero(value),
            Self::CssPixels => Self::css_value(value),
        }
    }

    #[inline]
    pub(crate) fn logical_value(self, value: f32, scale: f32) -> f32 {
        self.scaled_value(value, scale) / scale
    }

    #[inline]
    pub(crate) fn scaled_stroke(self, value: f32, scale: f32) -> f32 {
        match self {
            Self::DevicePixels => round_stroke_to_device_pixel(value, scale),
            Self::CssPixels => Self::css_value(value.max(0.) * scale),
        }
    }

    /// Resolve a line's baseline from raw logical font metrics and line height.
    ///
    /// CSS text uses integer font ascent/descent in scaled layout coordinates,
    /// with the leading's odd fraction assigned below the alphabetic baseline.
    /// The default policy preserves GPUI's original raw-metric centering.
    /// `scale` is the window's positive device scale factor.
    pub fn text_baseline(self, ascent: f32, descent: f32, line_height: f32, scale: f32) -> f32 {
        match self {
            Self::DevicePixels => (line_height - ascent - descent) / 2. + ascent,
            Self::CssPixels => {
                let ascent = (ascent * scale).round();
                let descent = (descent * scale).round();
                let line_height = Self::css_value(line_height * scale);
                (ascent + ((line_height - ascent - descent) / 2.).floor()) / scale
            }
        }
    }

    #[inline]
    pub(crate) fn glyph_y_variants(self, fractional: bool) -> u8 {
        // Apple's rasterizer already supports four Y phases (it uses the
        // four-phase X denominator for both coordinates). Other backends keep
        // their original raster contract until they implement fractional Y.
        if cfg!(target_os = "macos") && self == Self::CssPixels && fractional {
            4
        } else {
            SUBPIXEL_VARIANTS_Y
        }
    }

    #[inline]
    pub(crate) fn glyph_y_position(self, value: f32, fractional: bool) -> f32 {
        if self == Self::CssPixels && !fractional {
            // Skia's axis-aligned text mask snaps Y to the nearest physical
            // pixel, with positive halfway positions choosing the next row.
            (value + 0.5).floor()
        } else {
            let variants = self.glyph_y_variants(fractional) as f32;
            round_half_toward_zero(value * variants) / variants
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn css_glyph_x_rounds_to_nearest_quarter_with_ties_up_and_integer_carry() {
        for (input, expected) in [
            (10.0625, 10.),
            (10.125, 10.25),
            (10.375, 10.5),
            (10.875, 11.),
            (-0.125, 0.),
            (-0.875, -0.75),
        ] {
            assert_eq!(LayoutPrecision::CssPixels.glyph_x_position(input), expected);
        }
        // Existing windows keep their published half-toward-zero quantization.
        assert_eq!(LayoutPrecision::default().glyph_x_position(10.125), 10.);
        assert_eq!(LayoutPrecision::default().glyph_x_position(-0.125), 0.);
    }
    #[test]
    fn css_static_baselines_snap_while_explicit_transformed_baselines_retain_phase() {
        let css = LayoutPrecision::CssPixels;
        for (phase, expected) in [(0., 50.), (0.25, 50.), (0.5, 51.), (0.75, 51.), (1., 51.)] {
            assert_eq!(css.glyph_y_position(50. + phase, false), expected);
            if cfg!(target_os = "macos") {
                assert_eq!(css.glyph_y_position(50. + phase, true), 50. + phase);
            }
        }
        assert_eq!(
            LayoutPrecision::default().glyph_y_position(50.5, false),
            50.
        );
        assert_eq!(LayoutPrecision::default().glyph_y_position(50.5, true), 50.);
    }
    #[test]
    fn default_keeps_device_edges_and_measured_ceiling() {
        let precision = LayoutPrecision::default();
        assert_eq!(precision.scaled_edge(30.5, 2.) / 2., 15.);
        assert_eq!(precision.measured_value(38.658, 2.) / 2., 39.);
        assert_eq!(precision.scaled_stroke(0.1, 2.), 1.);
    }
    #[test]
    fn css_keeps_fractional_baselines_and_text_advance() {
        let precision = LayoutPrecision::CssPixels;
        assert_eq!(precision.scaled_edge(30.5, 2.) / 2., 15.25);
        assert_eq!(precision.measured_value(38.658, 2.) / 2., 38.65625);
        assert_eq!(precision.measured_value(57.4140625, 2.) / 2., 57.4140625);
        assert_eq!(precision.logical_value(280.6640625, 2.), 280.6640625);
        assert_eq!(precision.logical_value(0.25, 2.), 0.25);
        assert_eq!(precision.scaled_stroke(0.25, 2.), 0.5);
    }
    #[test]
    fn css_baselines_use_scaled_integer_font_metrics() {
        // Independently measured Chromium DOM fixtures for the bundled display
        // face, covering positive/negative leading and both device scales.
        for (ascent, descent, line_height, scale, baseline) in [
            (15.81, 4.59, 20.5, 2., 16.),
            (9.765, 2.835, 12.5, 2., 9.5),
            (16.275, 4.725, 25.375, 2., 18.5),
            (15.81, 4.59, 20.5, 1., 15.),
        ] {
            assert_eq!(
                LayoutPrecision::CssPixels.text_baseline(ascent, descent, line_height, scale),
                baseline
            );
        }
    }

    #[test]
    fn default_baseline_keeps_raw_font_metrics() {
        let baseline = LayoutPrecision::default().text_baseline(15.81, 4.59, 20.5, 2.);
        assert!((baseline - 15.86).abs() < 0.00001);
    }

    #[test]
    fn precision_values_do_not_share_mutable_state() {
        let css = LayoutPrecision::CssPixels;
        let device = LayoutPrecision::DevicePixels;
        assert_ne!(css.scaled_value(15.25, 2.), device.scaled_value(15.25, 2.));
        assert_eq!(device, LayoutPrecision::default());
    }
}

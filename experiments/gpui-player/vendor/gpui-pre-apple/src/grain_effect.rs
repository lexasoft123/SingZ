//! Opt-in process-local scene grain. The default is disabled.
//!
//! Configuration applies to every Apple renderer in this process. This small
//! extension targets a single-window host; applications needing different
//! materials per window should move this state to their window/renderer API.
//! Tile pixels are straight-alpha sRGB RGBA, at device-pixel resolution. The
//! tile repeats from the viewport origin without filtering or rescaling.
use parking_lot::Mutex;
use std::sync::{Arc, OnceLock};

#[derive(Clone)]
pub(crate) struct GrainEffect {
    pub version: u64,
    pub pixels: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
    pub opacity: f32,
}

#[derive(Default)]
struct Configuration {
    version: u64,
    effect: Option<GrainEffect>,
    backdrop: Option<SceneBackdrop>,
}
fn configuration() -> &'static Mutex<Configuration> {
    static CONFIG: OnceLock<Mutex<Configuration>> = OnceLock::new();
    CONFIG.get_or_init(|| Mutex::new(Configuration::default()))
}

/// Configure an overlay-blended repeating grain tile. Existing GPU resources
/// are invalidated on the next rendered frame. No window is invalidated here;
/// the host should request a redraw after changing this setting.
pub fn configure_grain_effect(
    tile_rgba: Vec<u8>,
    width: u32,
    height: u32,
    opacity: f32,
) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(tile_rgba.len()) {
        return Err("Grain tile must contain width × height × 4 RGBA bytes".into());
    }
    if !opacity.is_finite() || !(0. ..=1.).contains(&opacity) {
        return Err("Grain opacity must be finite and between zero and one".into());
    }
    let mut state = configuration().lock();
    state.version = state.version.wrapping_add(1);
    state.effect = Some(GrainEffect {
        version: state.version,
        pixels: tile_rgba.into(),
        width,
        height,
        opacity,
    });
    Ok(())
}

/// Restore the unmodified GPUI scene renderer on the next redraw.
pub fn clear_grain_effect() {
    let mut state = configuration().lock();
    state.version = state.version.wrapping_add(1);
    state.effect = None;
}

pub(crate) fn current() -> Option<GrainEffect> {
    configuration().lock().effect.clone()
}

/// A device-resolution straight-alpha RGBA backdrop, composed behind the
/// quantized premultiplied UI surface before grain. Independent of grain state.
#[derive(Clone)]
pub(crate) struct SceneBackdrop {
    pub version: u64,
    pub pixels: Arc<[u8]>,
    pub width: u32,
    pub height: u32,
}

/// Configure a full-viewport ambient layer. Dimensions must match the physical
/// viewport; no filtering, stretching or UI readback is performed. The host must
/// omit its opaque background quad and request redraw after configuration.
pub fn configure_scene_backdrop(rgba: Vec<u8>, width: u32, height: u32) -> Result<(), String> {
    let expected = (width as usize)
        .checked_mul(height as usize)
        .and_then(|n| n.checked_mul(4));
    if width == 0 || height == 0 || expected != Some(rgba.len()) {
        return Err("Scene backdrop must contain width × height × 4 RGBA bytes".into());
    }
    let mut state = configuration().lock();
    state.version = state.version.wrapping_add(1);
    state.backdrop = Some(SceneBackdrop {
        version: state.version,
        pixels: rgba.into(),
        width,
        height,
    });
    Ok(())
}

/// Disable only the ambient layer; any configured grain remains enabled.
pub fn clear_scene_backdrop() {
    configuration().lock().backdrop = None;
}

pub(crate) fn backdrop() -> Option<SceneBackdrop> {
    configuration().lock().backdrop.clone()
}

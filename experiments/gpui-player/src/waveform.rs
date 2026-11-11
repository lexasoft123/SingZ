//! Fixture-backed production waveform envelope and cached bitmap layers.
//! Peaks are exported by the real renderer's computePeaks, after AudioContext decoding.
//!
//! Rendering model (D-02 4.1, stage a1):
//! * One raster per lane covers the view plus up to one view-width of overscan on
//!   each side. Its key holds only geometry, scale, lane colour and project
//!   revision, never the exact view range, so a pan inside the overscan only
//!   translates the existing textures and a zoom within 2x only rescales them.
//! * Replacement rasters are produced on a background thread (latest wins,
//!   generation fenced). The first raster of a lane/project is built in place so
//!   a freshly shown lane is never blank; that is the warm-up.
//! * The mute/solo fade cross-fades pre-built endpoint textures with element
//!   opacity instead of rebuilding textures per fade step.
//! * Every texture that is replaced or evicted goes through `drop_image`.
use gpui_kit::{prelude::FluentBuilder, *};
use image::{GrayImage, Luma, Rgba, RgbaImage};
#[cfg(feature = "ui-tests")]
use std::sync::atomic::{AtomicU64, Ordering};
use std::{
    cell::{Cell, RefCell},
    sync::{Arc, OnceLock},
};

const PAD: f32 = 4.;
/// Widest raster (device pixels) planned for one lane; keeps textures well under
/// the 16384 px GPU limit and the memory budget.
const MAX_RASTER_PX: f32 = 8192.;
/// A raster can be stretched for interim frames while the view span stays
/// within this factor of the rasterised span (usable, not yet at rest quality).
const ZOOM_TOLERANCE: f64 = 2.;
/// At rest the raster must match the view span to within this relative error;
/// anything else is replaced in the background at the new sampling scale.
const REST_SPAN_ERROR: f64 = 0.01;

#[cfg(feature = "ui-tests")]
static CACHE_MISSES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
static TEXTURE_ALLOCS: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
static TEXTURE_RELEASES: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
static MAIN_RASTERS: AtomicU64 = AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
static BACKGROUND_RASTERS: AtomicU64 = AtomicU64::new(0);

#[cfg(feature = "ui-tests")]
#[derive(Clone, Copy, Debug, Default, serde::Serialize)]
pub struct Metrics {
    pub cache_misses: u64,
    pub texture_allocations: u64,
    pub texture_releases: u64,
    pub main_thread_rasterizations: u64,
    pub background_rasterizations: u64,
    pub live_textures: u64,
}

#[cfg(feature = "ui-tests")]
pub fn metrics() -> Metrics {
    let allocated = TEXTURE_ALLOCS.load(Ordering::Relaxed);
    let released = TEXTURE_RELEASES.load(Ordering::Relaxed);
    Metrics {
        cache_misses: CACHE_MISSES.load(Ordering::Relaxed),
        texture_allocations: allocated,
        texture_releases: released,
        main_thread_rasterizations: MAIN_RASTERS.load(Ordering::Relaxed),
        background_rasterizations: BACKGROUND_RASTERS.load(Ordering::Relaxed),
        live_textures: allocated.saturating_sub(released),
    }
}

thread_local! {
    static PROJECT_PEAKS: RefCell<Option<[Arc<Vec<f32>>;crate::tracks::LANE_SLOTS]>> = const {RefCell::new(None)};
    static PROJECT_REVISION: Cell<u64> = const { Cell::new(0) };
    // One current raster per lane; pan, zoom, resize and fades cannot grow this.
    static LAYERS: RefCell<[Option<Layers>; crate::tracks::LANE_SLOTS]> = const { RefCell::new([const {None};crate::tracks::LANE_SLOTS]) };
    static PENDING: RefCell<[Option<Pending>; crate::tracks::LANE_SLOTS]> = const { RefCell::new([const {None};crate::tracks::LANE_SLOTS]) };
    // What the most recent paint wanted; landing results are fenced against it.
    static LATEST: RefCell<[Option<(WaveformKey, (f64, f64))>; crate::tracks::LANE_SLOTS]> = const { RefCell::new([const { None }; crate::tracks::LANE_SLOTS]) };
    static GENERATIONS: Cell<[u64; crate::tracks::LANE_SLOTS]> = const { Cell::new([0; crate::tracks::LANE_SLOTS]) };
    // Replaced or evicted textures wait here for the next paint, which owns the Window.
    static RELEASE_QUEUE: RefCell<Vec<Arc<RenderImage>>> = const { RefCell::new(Vec::new()) };
}

pub fn set_project_peaks(peaks: [Vec<f32>; crate::tracks::LANE_SLOTS]) {
    PROJECT_PEAKS.with_borrow_mut(|p| *p = Some(peaks.map(Arc::new)));
    PROJECT_REVISION.with(|revision| revision.set(revision.get().wrapping_add(1)));
    // Evict every lane's textures; a raster still in flight is fenced out by
    // its generation and by the revision in its key.
    LAYERS.with_borrow_mut(|cache| {
        for slot in cache.iter_mut() {
            if let Some(layers) = slot.take() {
                queue_release(layers);
            }
        }
    });
    PENDING.with_borrow_mut(|pending| *pending = [const { None }; crate::tracks::LANE_SLOTS]);
    LATEST.with_borrow_mut(|latest| *latest = [const { None }; crate::tracks::LANE_SLOTS]);
    GENERATIONS.with(|g| g.set(g.get().map(|n| n.wrapping_add(1))));
}

fn queue_release(layers: Layers) {
    RELEASE_QUEUE.with_borrow_mut(|queue| queue.extend(layers.textures()));
}

fn drain_releases(window: &mut Window) {
    let queued = RELEASE_QUEUE.with_borrow_mut(std::mem::take);
    for image in queued {
        let _ = window.drop_image(image);
        #[cfg(feature = "ui-tests")]
        TEXTURE_RELEASES.fetch_add(1, Ordering::Relaxed);
    }
}

static PEAKS: OnceLock<[Arc<Vec<f32>>; 6]> = OnceLock::new();

fn peaks() -> &'static [Arc<Vec<f32>>; 6] {
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
            Arc::new(values)
        })
    })
}

fn project_envelope(index: usize) -> Arc<Vec<f32>> {
    PROJECT_PEAKS.with_borrow(|project| {
        project
            .as_ref()
            .map(|peaks| Arc::clone(&peaks[index]))
            .unwrap_or_else(|| Arc::clone(&peaks()[index.min(5)]))
    })
}

/// What a raster is valid for. The view range is deliberately absent.
#[derive(Clone, Copy, Debug, Eq, PartialEq)]
struct WaveformKey {
    width: u32,
    height: u32,
    dpr: u32,
    color: u32,
    project_revision: u64,
}

/// The song interval a raster covers and how many CSS columns it spans.
#[derive(Clone, Copy, Debug, PartialEq)]
struct Raster {
    start: f64,
    end: f64,
    cols: u32,
    /// View span the raster was planned for; the zoom tolerance is relative to it.
    view_span: f64,
    /// Overscan actually obtained on each side (zero where the song ends or the
    /// width cap bites); the re-raster trigger is relative to it.
    margin_left: f64,
    margin_right: f64,
}

/// View plus one view-width of overscan per side (less where the song ends or
/// the width cap bites). Overscan is a whole number of columns, so the columns
/// inside the view fall on the same pixel grid as a plain view-sized raster.
fn plan_raster(view: (f64, f64), width: u32, dpr: f32) -> Raster {
    let span = view.1 - view.0;
    let per_col = span / width as f64;
    let room = (((MAX_RASTER_PX / dpr.max(1.)) as u32).saturating_sub(width) / 2).min(width);
    let left = ((view.0 / per_col).floor() as u32).min(room);
    let right = (((1. - view.1) / per_col).floor() as u32).min(room);
    let start = (view.0 - left as f64 * per_col).max(0.);
    let end = (view.1 + right as f64 * per_col).min(1.);
    Raster {
        start,
        end,
        cols: left + width + right,
        view_span: span,
        margin_left: view.0 - start,
        margin_right: end - view.1,
    }
}

/// A raster that can draw `view` right now, even if soft: same key, a span
/// within `ZOOM_TOLERANCE` and the whole view inside the covered interval.
fn usable(key: WaveformKey, raster: Raster, want: WaveformKey, view: (f64, f64)) -> bool {
    if key != want {
        return false;
    }
    let ratio = (view.1 - view.0) / raster.view_span;
    (1. / ZOOM_TOLERANCE..=ZOOM_TOLERANCE).contains(&ratio)
        && view.0 >= raster.start - 1e-9
        && view.1 <= raster.end + 1e-9
}

/// True when the current raster is not the one wanted at rest for `view`:
/// unusable, at the wrong sampling scale, or with the view too close to the
/// edge of its overscan (a quarter view of slack keeps the next raster ahead
/// of a pan). A raster that is usable but not wanted stays on screen until its
/// replacement lands.
fn needs_raster(existing: Option<(WaveformKey, Raster)>, key: WaveformKey, view: (f64, f64)) -> bool {
    let Some((old_key, raster)) = existing else { return true };
    if !usable(old_key, raster, key, view) {
        return true;
    }
    let span = view.1 - view.0;
    if (span / raster.view_span - 1.).abs() > REST_SPAN_ERROR {
        return true;
    }
    // Re-raster once three quarters of the overscan on a side is used up. The
    // margin is what planning actually obtained, so a raster planned for this
    // very view never asks for its own replacement (that would loop forever
    // near the song edges or at the width cap).
    let left_ok = view.0 >= raster.start + raster.margin_left * 0.25 - 1e-9;
    let right_ok = view.1 <= raster.end - raster.margin_right * 0.25 + 1e-9;
    !(left_ok && right_ok)
}

/// Whether a finished background raster may be published for the latest
/// request. A result for an older view or size is dropped, never shown, so it
/// cannot replace a raster that is correct for what the user sees now.
fn accept_landed(landed: (WaveformKey, Raster), latest: Option<(WaveformKey, (f64, f64))>) -> bool {
    latest.is_some_and(|(key, view)| usable(landed.0, landed.1, key, view))
}

struct Layers {
    key: WaveformKey,
    raster: Raster,
    /// Audible colour, full opacity; painted at 0.1..1 element opacity.
    base: Arc<RenderImage>,
    /// Muted-endpoint progress layer; painted at 0.14 * (1 - audible).
    muted_bright: Arc<RenderImage>,
    /// Audible-endpoint progress layer; painted at audible.
    audible_bright: Arc<RenderImage>,
}

impl Layers {
    fn textures(self) -> [Arc<RenderImage>; 3] {
        [self.base, self.muted_bright, self.audible_bright]
    }
}

#[derive(Clone, Copy)]
struct Pending {
    key: WaveformKey,
    view: (f64, f64),
    generation: u64,
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
    envelope: &[f32],
    width: u32,
    height: u32,
    dpr: f32,
    view_start: f64,
    view_end: f64,
) -> GrayImage {
    let pad = (PAD * dpr).round() as u32;
    let mut image = GrayImage::new(
        (width as f32 * dpr).round() as u32 + pad * 2,
        (height as f32 * dpr).round() as u32 + pad * 2,
    );
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

fn texture(mask: &GrayImage, blur: &GrayImage, color: [u8; 3], strength: f32) -> Arc<RenderImage> {
    #[cfg(feature = "ui-tests")]
    TEXTURE_ALLOCS.fetch_add(1, Ordering::Relaxed);
    let image = RgbaImage::from_fn(mask.width(), mask.height(), |x, y| {
        let source = mask.get_pixel(x, y)[0] as f32 / 255.;
        let shadow = blur.get_pixel(x, y)[0] as f32 / 255. * strength;
        let alpha = source + shadow * (1. - source);
        // RenderImage is BGRA; ImageBuffer's channel type is only its storage.
        Rgba([color[2], color[1], color[0], (alpha * 255.).round() as u8])
    });
    Arc::new(RenderImage::new(vec![image::Frame::new(image)]))
}

/// Pure raster work: no window, no entity. Runs on a worker thread.
fn build_layers(
    envelope: &[f32],
    key: WaveformKey,
    raster: Raster,
) -> Layers {
    let dpr = f32::from_bits(key.dpr);
    let mask = mask(envelope, raster.cols, key.height, dpr, raster.start, raster.end);
    let blur = image::imageops::blur(&mask, 2. * dpr);
    Layers {
        key,
        raster,
        base: texture(&mask, &blur, filtered_rgb(key.color, 1.15, 0.65), 0.2),
        muted_bright: texture(&mask, &blur, filtered_rgb(key.color, 0.15, 1.), 0.26),
        audible_bright: texture(&mask, &blur, filtered_rgb(key.color, 1.15, 1.06), 0.26),
    }
}

fn normalized_view(start: f64, end: f64) -> (f64, f64) {
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

/// Everything one lane needs to paint, copied out of `Player` at render time.
#[derive(Clone)]
pub struct Lane {
    pub index: usize,
    pub color: u32,
    pub position: f64,
    pub duration: f64,
    pub fade: f32,
    pub enter: f32,
    pub view_start: f64,
    pub view_end: f64,
    pub owner: WeakEntity<crate::Player>,
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum Layer {
    Base,
    MutedBright,
    AudibleBright,
}

/// Element opacities for the fade: base 0.1..1 (production's separate .1/.14
/// endpoints), muted progress layer fading out, audible progress layer in.
fn opacities(fade: f32) -> (f32, f32, f32) {
    let audible = ((fade - 0.16) / 0.84).clamp(0., 1.);
    (0.1 + 0.9 * audible, 0.14 * (1. - audible), audible)
}

/// The lane's waveform as layered canvases filling the `.wave` box (the caller
/// supplies the box; the 7px top/bottom inset is applied here). Position and
/// duration are seconds; the normalized view selects the interval of the
/// immutable peak envelope; `enter` is the lane-in easing.
pub fn lane(lane: Lane) -> impl IntoElement {
    let (base, muted, audible) = opacities(lane.fade);
    let layer = |kind: Layer, opacity: f32| {
        let lane = lane.clone();
        div()
            .absolute()
            .inset_0()
            .opacity(opacity)
            .child(
                canvas(
                    |bounds, _, _| bounds,
                    move |_, bounds, window, cx| {
                        crate::alloc_probe::scope(|| paint_layer(kind, &lane, bounds, window, cx))
                    },
                )
                .size_full(),
            )
    };
    div()
        .absolute()
        .top(px(7.))
        .bottom(px(7.))
        .left_0()
        .right_0()
        .child(layer(Layer::Base, base))
        .when(muted > 0.001, |wave| wave.child(layer(Layer::MutedBright, muted)))
        .when(audible > 0.001, |wave| wave.child(layer(Layer::AudibleBright, audible)))
}

fn paint_layer(kind: Layer, lane: &Lane, bounds: Bounds<Pixels>, window: &mut Window, cx: &mut App) {
    let index = lane.index;
    if index >= crate::tracks::LANE_SLOTS || bounds.size.width <= px(0.) || bounds.size.height <= px(0.) {
        return;
    }
    let view = normalized_view(lane.view_start, lane.view_end);
    if kind == Layer::Base {
        drain_releases(window);
        ensure_raster(lane, view, bounds, window.scale_factor().min(2.), cx);
    }
    LAYERS.with_borrow(|cache| {
        let Some(layers) = cache[index].as_ref() else { return };
        let image = match kind {
            Layer::Base => &layers.base,
            Layer::MutedBright => &layers.muted_bright,
            Layer::AudibleBright => &layers.audible_bright,
        };
        let width = f64::from(f32::from(bounds.size.width));
        let view_span = view.1 - view.0;
        // Screen interval of the raster's pad-free columns. The raster may be
        // wider than the view (overscan) or older than the current view range.
        let left = f64::from(f32::from(bounds.left())) + (layers.raster.start - view.0) / view_span * width;
        let right = f64::from(f32::from(bounds.left())) + (layers.raster.end - view.0) / view_span * width;
        let sx = ((right - left) / layers.raster.cols as f64) as f32;
        let sy = f32::from(bounds.size.height) / layers.key.height as f32;
        let origin_y = bounds.origin.y + px((1. - lane.enter) * 10.);
        let padded = Bounds::new(
            point(px(left as f32 - PAD * sx), origin_y - px(PAD * sy)),
            size(
                px((right - left) as f32 + PAD * sx * 2.),
                px(f32::from(bounds.size.height) + PAD * sy * 2.),
            ),
        );
        // Overscan and interim stretches must not draw past the lane box; the
        // PAD allowance keeps the glow that production paints just outside it.
        let clip = Bounds::new(
            point(bounds.left() - px(PAD), bounds.top() - px(12.)),
            size(bounds.size.width + px(PAD * 2.), bounds.size.height + px(24.)),
        );
        window.with_content_mask(Some(ContentMask { bounds: clip }), |window| {
            if kind == Layer::Base {
                let _ = window.paint_image(padded, padded, Corners::default(), image.clone(), 0, false);
                return;
            }
            let dpr = window.scale_factor();
            let fraction = if lane.duration > 0. {
                ((lane.position / lane.duration - view.0) / view_span).clamp(0., 1.)
            } else {
                0.
            };
            let edge = crate::playhead_overlay::snap_device(
                f32::from(bounds.left()) + (fraction * width) as f32,
                dpr,
            );
            let progress = edge - f32::from(bounds.left());
            if progress > 0. {
                let played = Bounds::new(
                    point(bounds.left(), origin_y),
                    size(px(progress), bounds.size.height),
                );
                window.with_content_mask(Some(ContentMask { bounds: played }), |window| {
                    let _ = window.paint_image(padded, padded, Corners::default(), image.clone(), 0, false);
                });
            }
        });
    });
}

/// Keep a raster current: build the first one in place, replace later ones in
/// the background, one job in flight per lane.
fn ensure_raster(lane: &Lane, view: (f64, f64), bounds: Bounds<Pixels>, dpr: f32, cx: &mut App) {
    let index = lane.index;
    let key = WaveformKey {
        width: f32::from(bounds.size.width).round().max(1.) as u32,
        height: f32::from(bounds.size.height).round().max(1.) as u32,
        dpr: dpr.to_bits(),
        color: lane.color,
        project_revision: PROJECT_REVISION.with(Cell::get),
    };
    LATEST.with_borrow_mut(|latest| latest[index] = Some((key, view)));
    let existing = LAYERS.with_borrow(|cache| cache[index].as_ref().map(|l| (l.key, l.raster)));
    if !needs_raster(existing, key, view) {
        return;
    }
    // Same project, scale and colour: only the size or view changed, so the
    // current textures stay on screen (stretched) until the replacement lands.
    // Otherwise (first paint, project switch, colour or dpr change) there is
    // nothing sound to stretch and the lane is built in place.
    let can_defer = existing.is_some_and(|(old, _)| {
        old.project_revision == key.project_revision && old.color == key.color && old.dpr == key.dpr
    });
    let raster = plan_raster(view, key.width, dpr);
    if !can_defer {
        #[cfg(feature = "ui-tests")]
        {
            CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
            MAIN_RASTERS.fetch_add(1, Ordering::Relaxed);
        }
        let layers = build_layers(project_envelope(index).as_slice(), key, raster);
        if let Some(previous) = LAYERS.with_borrow_mut(|cache| cache[index].replace(layers)) {
            queue_release(previous);
        }
        PENDING.with_borrow_mut(|pending| pending[index] = None);
        return;
    }
    if PENDING.with_borrow(|pending| pending[index].is_some()) {
        return; // one job in flight; the landing repaint re-evaluates the latest view
    }
    #[cfg(feature = "ui-tests")]
    CACHE_MISSES.fetch_add(1, Ordering::Relaxed);
    let generation = GENERATIONS.with(|all| {
        let mut values = all.get();
        values[index] = values[index].wrapping_add(1);
        all.set(values);
        values[index]
    });
    PENDING.with_borrow_mut(|pending| pending[index] = Some(Pending { key, view, generation }));
    let envelope = project_envelope(index);
    let worker = cx.background_spawn(async move {
        #[cfg(feature = "ui-tests")]
        BACKGROUND_RASTERS.fetch_add(1, Ordering::Relaxed);
        build_layers(envelope.as_slice(), key, raster)
    });
    let owner = lane.owner.clone();
    cx.spawn(async move |cx| {
        let layers = worker.await;
        let _ = owner.update(cx, |_player, cx| {
            let current = PENDING.with_borrow(|pending| pending[index]);
            let latest = LATEST.with_borrow(|latest| latest[index]);
            let live = current.is_some_and(|p| p.generation == generation)
                && PROJECT_REVISION.with(Cell::get) == key.project_revision;
            if live {
                PENDING.with_borrow_mut(|pending| pending[index] = None);
            }
            if live && accept_landed((layers.key, layers.raster), latest) {
                if let Some(previous) = LAYERS.with_borrow_mut(|cache| cache[index].replace(layers)) {
                    queue_release(previous);
                }
            } else {
                // Stale or obsolete: never shown, so there is no atlas entry to
                // drop, but the textures were counted when built.
                #[cfg(feature = "ui-tests")]
                TEXTURE_RELEASES.fetch_add(3, Ordering::Relaxed);
            }
            // Repaint either way: a published raster must show, and an obsolete
            // one means the latest request still needs its own job, which the
            // next paint schedules (coalescing to the newest view).
            if live {
                cx.notify();
            }
        });
    })
    .detach();
}

#[cfg(test)]
mod tests {
    use super::{Layers, PAD, Raster, WaveformKey, RELEASE_QUEUE, accept_landed, mask, needs_raster, opacities, plan_raster, queue_release, usable};
    use gpui_kit::RenderImage;
    use image::RgbaImage;
    use std::sync::Arc;

    fn key() -> WaveformKey {
        WaveformKey { width: 800, height: 60, dpr: 2.0f32.to_bits(), color: 0xabcdef, project_revision: 0 }
    }

    fn current(view: (f64, f64)) -> Option<(WaveformKey, Raster)> {
        Some((key(), plan_raster(view, 800, 2.)))
    }

    #[test]
    fn overscan_is_whole_columns_around_the_view() {
        let raster = plan_raster((0.4, 0.5), 800, 2.);
        assert_eq!(raster.cols, 2400);
        assert!((raster.start - 0.3).abs() < 1e-12 && (raster.end - 0.6).abs() < 1e-12);
        // Clamped at the song edges, still whole columns.
        let edge = plan_raster((0.0, 0.1), 800, 2.);
        assert_eq!((edge.start, edge.cols), (0., 1600));
        assert_eq!(plan_raster((0., 1.), 800, 2.).cols, 800);
    }

    #[test]
    fn pan_inside_the_overscan_plans_no_raster() {
        let rest = (0.4, 0.5);
        // 1,000 pan steps from -0.07 to +0.07 of the view stay inside the slack.
        for step in 0..1000 {
            let shift = (step as f64 / 999. - 0.5) * 0.07;
            assert!(!needs_raster(current(rest), key(), (rest.0 + shift, rest.1 + shift)), "step {step}");
        }
        assert!(needs_raster(current(rest), key(), (0.58, 0.68)), "pan past the overscan must plan one");
    }

    #[test]
    fn a_new_raster_is_planned_for_size_colour_scale_revision_and_far_zoom() {
        let rest = (0.4, 0.5);
        for changed in [
            WaveformKey { width: 801, ..key() },
            WaveformKey { height: 61, ..key() },
            WaveformKey { color: 0xabcdee, ..key() },
            WaveformKey { dpr: 1.0f32.to_bits(), ..key() },
            WaveformKey { project_revision: 1, ..key() },
        ] {
            assert!(needs_raster(current(rest), changed, rest), "{changed:?}");
        }
        assert!(!needs_raster(current(rest), key(), (0.4005, 0.5005)), "a 0.5% span change is within rest quality");
        assert!(needs_raster(current(rest), key(), (0.44, 0.46)), "a 5x zoom-in needs a sharper raster");
        assert!(needs_raster(current(rest), key(), (0.2, 0.7)), "a 5x zoom-out needs a wider raster");
    }

    #[test]
    fn a_raster_planned_for_a_view_never_asks_for_its_own_replacement() {
        // Near the song edges the overscan is smaller than a fixed slack; the
        // old rule then re-rastered forever (a background raster per frame).
        for dpr in [1., 2.] {
            for width in [300u32, 800, 1280, 2560] {
                for start in [0., 0.004, 0.01, 0.05, 0.3, 0.9, 0.97, 0.995] {
                    for span in [0.001_f64, 0.02, 0.1, 0.5, 1.] {
                        let view = (start, (start + span).min(1.));
                        if view.1 - view.0 < 0.000001 { continue; }
                        let key = WaveformKey { width, ..key() };
                        let planned = Some((key, plan_raster(view, width, dpr)));
                        assert!(!needs_raster(planned, key, view), "width {width} dpr {dpr} view {view:?}");
                    }
                }
            }
        }
    }

    #[test]
    fn zoom_within_tolerance_is_drawn_stretched_then_replaced_at_the_new_scale() {
        // Full-song raster, then zoom to the middle half: the old raster is
        // usable for the interim frames but is not the rest-quality raster.
        let full = (0., 1.);
        let zoomed = (0.25, 0.75);
        let old = Some((key(), plan_raster(full, 800, 2.)));
        assert!(usable(key(), plan_raster(full, 800, 2.), key(), zoomed));
        assert!(needs_raster(old, key(), zoomed), "the old behaviour kept the 2x-stretched raster forever");
        let fresh = Some((key(), plan_raster(zoomed, 800, 2.)));
        assert!(!needs_raster(fresh, key(), zoomed), "the replacement settles the request");
    }

    #[test]
    fn an_out_of_order_background_result_never_replaces_the_current_raster() {
        let a = (0.0, 0.1);
        let b = (0.8, 0.9);
        let raster_a = plan_raster(a, 800, 2.);
        let raster_b = plan_raster(b, 800, 2.);
        // B's job started while the user looked at B; the user is back at A
        // when it completes. Only a result usable for A may be published.
        assert!(!accept_landed((key(), raster_b), Some((key(), a))), "B must be dropped while A is wanted");
        assert!(accept_landed((key(), raster_a), Some((key(), a))));
        assert!(accept_landed((key(), raster_b), Some((key(), b))));
        // A result for another size is never published either.
        assert!(!accept_landed((WaveformKey { width: 900, ..key() }, raster_a), Some((key(), a))));
        assert!(!accept_landed((key(), raster_a), None));
    }

    #[test]
    fn rest_mask_columns_match_a_plain_view_raster() {
        // Overscan columns share the pixel grid: the view's columns in the
        // overscan raster equal the plain view-sized raster, byte for byte,
        // away from the blur-free mask padding.
        let envelope: Vec<f32> = (0..5000).map(|i| ((i * 37 % 101) as f32) / 101.).collect();
        for dpr in [1.0f32, 2.0] {
            for view in [(0.0, 1.0), (0.4, 0.5), (0.0, 0.25), (0.31, 0.62), (0.9, 1.0)] {
                let width = 120u32;
                let plain = mask(&envelope, width, 40, dpr, view.0, view.1);
                let raster = plan_raster(view, width, dpr);
                let wide = mask(&envelope, raster.cols, 40, dpr, raster.start, raster.end);
                let left_cols = ((view.0 - raster.start) / ((view.1 - view.0) / width as f64)).round() as u32;
                let pad = (PAD * dpr).round() as u32;
                let shift = (left_cols as f32 * dpr).round() as u32;
                let mut compared = 0;
                for y in 0..plain.height() {
                    for x in pad..(pad + (width as f32 * dpr).round() as u32) {
                        assert_eq!(plain.get_pixel(x, y), wide.get_pixel(x + shift, y), "dpr {dpr} view {view:?} ({x},{y})");
                        compared += 1;
                    }
                }
                assert!(compared > 0);
            }
        }
    }

    #[test]
    fn fade_opacities_hit_the_production_endpoints() {
        assert_eq!(opacities(1.0), (1.0, 0.0, 1.0));
        let muted = opacities(0.16);
        assert!((muted.0 - 0.1).abs() < 1e-6 && (muted.1 - 0.14).abs() < 1e-6 && muted.2 == 0.);
    }

    #[test]
    fn eviction_queues_every_texture_for_release() {
        let image = || Arc::new(RenderImage::new(vec![image::Frame::new(RgbaImage::new(1, 1))]));
        let layers = Layers {
            key: key(),
            raster: plan_raster((0.4, 0.5), 800, 2.),
            base: image(),
            muted_bright: image(),
            audible_bright: image(),
        };
        queue_release(layers);
        assert_eq!(RELEASE_QUEUE.with_borrow(|queue| queue.len()), 3);
        RELEASE_QUEUE.with_borrow_mut(Vec::clear);
    }
}

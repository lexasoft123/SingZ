mod background;
mod header;
mod library;
mod lyric_glow;
mod pitch_strip;
mod settings;
mod text_rendering;
mod transport;
#[cfg(feature = "ui-tests")]
mod ui_benchmark;
#[cfg(feature = "ui-tests")]
mod ui_grain;
#[cfg(feature = "ui-tests")]
mod ui_library_review;
#[cfg(feature = "ui-tests")]
mod ui_lyrics_review;
#[cfg(feature = "ui-tests")]
mod ui_review;
#[cfg(feature = "ui-tests")]
mod ui_smoke;
#[cfg(feature = "ui-tests")]
mod ui_text_phase;
mod waveform;
mod window_chrome;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
    time::Instant,
};

use singz_uikit::{
    glow, pill,
    tokens::{ACCENT, BG, DIM, FAINT, TEXT},
};
const COLORS: [u32; 6] = [0xff5c65, 0xffc53d, 0x527dff, 0xf98424, 0xda81da, 0x27e7bb];
const NAMES: [&str; 6] = ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Instruments"];
const LYRICS: [&str; 6] = [
    "Let the city fade away",
    "Find a little room to breathe",
    "Every note will light the way",
    "Sing the song you carry underneath",
    "Let the moment find its place",
    "And begin again with me",
];
const DURATION: f32 = 192.;
fn clock(s: f32) -> String {
    format!("{}:{:02}", s as u32 / 60, s as u32 % 60)
}
#[derive(Default)]
struct FrameStats {
    last: Option<Instant>,
    advancing_glow_draws: usize,
    intervals: Vec<f64>,
    paint: Vec<f64>,
}
struct PaintTimer {
    start: Instant,
    stats: Rc<RefCell<FrameStats>>,
}
impl Drop for PaintTimer {
    fn drop(&mut self) {
        let now = Instant::now();
        let mut s = self.stats.borrow_mut();
        if let Some(last) = s.last {
            s.intervals
                .push(self.start.duration_since(last).as_secs_f64() * 1000.);
        }
        s.last = Some(self.start);
        s.paint
            .push(now.duration_since(self.start).as_secs_f64() * 1000.);
        if s.paint.len() == 180 {
            let count = s.intervals.len();
            let avg = s.intervals.iter().sum::<f64>() / count as f64;
            s.intervals.sort_by(f64::total_cmp);
            s.paint.sort_by(f64::total_cmp);
            eprintln!(
                "PERF draw cadence {:.1} fps, interval p95 {:.2} ms, lyrics CPU p95 {:.2} ms",
                1000. / avg,
                s.intervals[count * 95 / 100],
                s.paint[171]
            );
            eprintln!(
                "PERF_JSON {{\"draw_fps\":{:.4},\"window_ms\":{:.4},\"frame_interval_p95_ms\":{:.4},\"frame_interval_p99_ms\":{:.4},\"lyrics_cpu_p95_ms\":{:.4},\"frames\":{}}}",
                1000. / avg,
                s.intervals.iter().sum::<f64>(),
                s.intervals[count * 95 / 100],
                s.intervals[count * 99 / 100],
                s.paint[171],
                count
            );
            eprintln!(
                "EFFECT_JSON {{\"advancing_glow_draws\":{}}}",
                s.advancing_glow_draws
            );
            s.advancing_glow_draws = 0;
            s.intervals.clear();
            s.paint.clear();
        }
    }
}
type ShapeKey = (String, [u32; 4], u32);
type LyricLayout = Vec<(f32, f32, Vec<(&'static str, f32, f32, f32)>)>;
#[derive(Clone, Copy, PartialEq)]
enum Screen {
    Player,
    Library,
    Settings,
}

struct Player {
    screen: Screen,
    #[cfg(feature = "ui-tests")]
    text_phase_check: bool,
    loaded_song: bool,
    notice: Option<String>,
    previous_screen: Screen,
    header: Entity<header::Header>,
    backdrop: Option<Arc<RenderImage>>,
    background: background::Background,
    transport: Entity<transport::Transport>,
    pitch_strip: Entity<pitch_strip::PitchStrip>,
    karaoke: bool,
    tempo: f32,
    master_volume: f32,
    library: Entity<library::LibraryScreen>,
    settings: Entity<settings::SettingsScreen>,
    _subscriptions: Vec<Subscription>,
    song_title: SharedString,
    song_artist: SharedString,
    glow_textures: Rc<HashMap<&'static str, Arc<RenderImage>>>,
    glow_bands: Rc<HashMap<&'static str, Vec<Arc<RenderImage>>>>,
    frame_stats: Rc<RefCell<FrameStats>>,
    shape_cache: Rc<RefCell<HashMap<ShapeKey, ShapedLine>>>,
    layout_cache: Rc<RefCell<Option<(i32, LyricLayout)>>>,
    lyric_scroll: Rc<Cell<f32>>,
    lyric_scroll_target: Rc<Cell<f32>>,
    lyric_active: Rc<Cell<usize>>,
    lyric_extent: Rc<Cell<f32>>,
    lyric_view_height: Rc<Cell<f32>>,
    lyric_horizontal: Rc<Cell<bool>>,
    lyric_scroll_handle: ScrollHandle,
    lyric_scroll_active: Rc<Cell<bool>>,
    lyric_hits: Rc<RefCell<Vec<(usize, Bounds<Pixels>)>>>,
    playing: bool,
    position: f32,
    muted: [bool; 6],
    solo: [bool; 6],
    gain: [u8; 6],
    fade: [f32; 6],
    looping: bool,
    view_start: f32,
    view_end: f32,
    transpose: i32,
    header_drag: Rc<Cell<bool>>,
    focus_handle: FocusHandle,
    previous_focus: Option<FocusHandle>,
    modal_was_open: bool,
    capture_file: Option<std::path::PathBuf>,
    started: Instant,
    last: Instant,
}
impl Player {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let pitch_strip = cx.new(|cx| pitch_strip::PitchStrip::new(64., cx));
        let transport = cx.new(|cx| transport::Transport::new(window, cx));
        let header = cx.new(|cx| header::Header::new(window, cx));
        let library = cx.new(|cx| library::LibraryScreen::new(window, cx));
        let settings = cx.new(|cx| settings::SettingsScreen::new(window, cx));
        let library_subscription = cx.subscribe(&library, |this, _, event, cx| match event {
            library::LibraryEvent::OpenSong { title, artist } => {
                this.loaded_song = true;
                this.library.update(cx, |library,cx| library.set_open_song(Some(title.clone()),cx));
                this.song_title = title.clone();
                this.song_artist = artist.clone();
                this.position = 0.;
                this.view_start=0.;this.view_end=1.;
                this.started = Instant::now();
                this.playing = false;
                this.screen = Screen::Player;
                this.last = Instant::now();
                cx.notify();
            }
            library::LibraryEvent::Browse => { this.notice = Some("Choose a catalog card to preview the player. File loading is not connected in this prototype.".into()); cx.notify(); }
            library::LibraryEvent::ManageStorage => { this.notice = Some("Projects are shown from the review fixture. Storage changes are not connected in this prototype.".into()); cx.notify(); }
            library::LibraryEvent::DeleteSong { title } => { this.notice = Some(format!("{title} is a review fixture. No project has been deleted.")); cx.notify(); }
        });
        let settings_subscription = cx.subscribe(&settings, |this, _, event, cx| {
            match event {
                settings::SettingsEvent::Close => this.screen = this.previous_screen,
                settings::SettingsEvent::QuickStart => this.notice = Some("Open a song, adjust its stems, and use Karaoke to follow the lyrics. Settings here are local to this prototype.".into()),
            }
            this.last = Instant::now();
            cx.notify();
        });
        let header_subscription = cx.subscribe(&header, |this,_,event,cx| {
            match event {
                header::HeaderEvent::Catalog => { if this.loaded_song { this.screen = if this.screen == Screen::Library { Screen::Player } else { Screen::Library }; } }
                header::HeaderEvent::Settings => { if this.screen == Screen::Settings { this.screen=this.previous_screen; } else { this.settings.update(cx, |settings,cx| settings.on_open(cx)); this.previous_screen=this.screen;this.screen=Screen::Settings; } }
                header::HeaderEvent::Training => this.notice=Some("Vocal training is not connected in this prototype.".into()),
                header::HeaderEvent::Log => this.notice=Some("The prototype has no audio engine session to log.".into()),
                header::HeaderEvent::Engine => this.notice=Some("The separation engine is not connected in this prototype.".into()),
                header::HeaderEvent::Language => this.notice=Some("This review fixture uses English.".into()),
                header::HeaderEvent::Help => this.notice=Some("Choose a song, adjust the mix, and follow its lyrics.".into()),
                header::HeaderEvent::Save => this.notice=Some("Mix changes remain local to this prototype.".into()),
                header::HeaderEvent::AddToLibrary => this.notice=Some("The review fixture stays in place. Library import is not connected in this prototype.".into()),
                header::HeaderEvent::Projects => this.notice=Some("Open a song from the catalog to preview it.".into()),
            }
            this.last=Instant::now(); cx.notify();
        });
        let transport_subscription = cx.subscribe(&transport, |this, _, event, cx| {
            use transport::TransportEvent::*;
            match *event {
                Play => this.toggle(cx),
                Restart => this.position = 0.,
                Loop => this.looping = !this.looping,
                Transpose(value) => this.transpose = value,
                Karaoke => {
                    this.karaoke = !this.karaoke;
                    this.muted[0] = this.karaoke;
                    this.lyric_horizontal.set(false);
                    this.lyric_active.set(usize::MAX);
                    this.lyric_scroll.set(0.);
                    this.lyric_scroll_target.set(0.);
                    this.lyric_scroll_handle.set_offset(point(px(0.), px(0.)));
                }
                Tempo(value) => this.tempo = value,
                Volume(value) => this.master_volume = value,
                Metronome => {
                    this.notice =
                        Some("Metronome audio is not connected in this silent prototype.".into())
                }
                CarryLine => {
                    this.notice =
                        Some("Line continuation is not connected in this prototype.".into())
                }
                StemFiles => {
                    this.notice = Some("Stem files are supplied by the review fixture.".into())
                }
            }
            cx.notify();
        });
        Self {
            screen: if std::env::var_os("SINGZ_GPUI_PROFILE").is_some() {
                Screen::Player
            } else {
                Screen::Library
            },
            #[cfg(feature = "ui-tests")]
            text_phase_check: false,
            loaded_song: std::env::var_os("SINGZ_GPUI_PROFILE").is_some(),
            notice: None,
            previous_screen: Screen::Library,
            header,
            backdrop: None,
            background: background::Background::new(),
            transport,
            pitch_strip,
            karaoke: true,
            tempo: 1.,
            master_volume: 1.,
            library,
            settings,
            _subscriptions: vec![
                library_subscription,
                settings_subscription,
                header_subscription,
                transport_subscription,
            ],
            song_title: "Room to breathe".into(),
            song_artist: "Demo session".into(),
            glow_textures: Rc::new(lyric_glow::load()),
            glow_bands: Rc::new(lyric_glow::load_bands()),
            frame_stats: Rc::new(RefCell::new(FrameStats::default())),
            shape_cache: Rc::new(RefCell::new(HashMap::new())),
            layout_cache: Rc::new(RefCell::new(None)),
            lyric_scroll: Rc::new(Cell::new(0.)),
            lyric_scroll_target: Rc::new(Cell::new(0.)),
            lyric_active: Rc::new(Cell::new(usize::MAX)),
            lyric_extent: Rc::new(Cell::new(1280.)),
            lyric_view_height: Rc::new(Cell::new(0.)),
            lyric_horizontal: Rc::new(Cell::new(false)),
            lyric_scroll_handle: ScrollHandle::new(),
            lyric_scroll_active: Rc::new(Cell::new(false)),
            lyric_hits: Rc::new(RefCell::new(vec![])),
            playing: std::env::var_os("SINGZ_GPUI_PROFILE").is_some(),
            position: 64.,
            muted: [false; 6],
            solo: [false; 6],
            gain: [80; 6],
            fade: [1.; 6],
            looping: false,
            view_start: 0.,
            view_end: 1.,
            transpose: 0,
            header_drag: Rc::new(Cell::new(false)),
            focus_handle: cx.focus_handle(),
            previous_focus: None,
            modal_was_open: false,
            capture_file: std::env::var_os("SINGZ_GPUI_CAPTURE_FILE").map(Into::into),
            started: Instant::now(),
            last: Instant::now(),
        }
    }
    fn zoom_by(&mut self, factor: f32, cx: &mut Context<Self>) {
        let old_span = self.view_end - self.view_start;
        let span = (old_span * factor).clamp(2. / DURATION, 1.);
        let center = (self.position / DURATION).clamp(self.view_start, self.view_end);
        let ratio = (center - self.view_start) / old_span;
        self.view_start = (center - span * ratio).clamp(0., 1. - span);
        self.view_end = self.view_start + span;
        cx.notify();
    }
    fn toggle(&mut self, cx: &mut Context<Self>) {
        if self.position >= DURATION {
            self.position = 0.;
        }
        self.playing = !self.playing;
        self.last = Instant::now();
        cx.notify();
    }
    fn lyrics(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let position = self.position + 0.15;
        let active = ((position / 8.).floor() as usize).min(23);
        let suspended = self.notice.is_some() || self.screen == Screen::Settings;
        let glow_textures = self.glow_textures.clone();
        let glow_bands = self.glow_bands.clone();
        let stats = self.frame_stats.clone();
        let profile = std::env::var_os("SINGZ_GPUI_PROFILE").is_some()
            || std::env::var_os("SINGZ_GPUI_OFFSCREEN_BENCHMARK").is_some();
        let shapes = self.shape_cache.clone();
        let layouts = self.layout_cache.clone();
        let scrolling = self.lyric_scroll.clone();
        let scroll_active = self.lyric_scroll_active.clone();
        let scroll_target = self.lyric_scroll_target.clone();
        let active_line = self.lyric_active.clone();
        let extent = self.lyric_extent.clone();
        let view_height = self.lyric_view_height.clone();
        let scroll_handle = self.lyric_scroll_handle.clone();
        let horizontal = self.lyric_horizontal.get();
        let horizontal_state = self.lyric_horizontal.clone();
        let owner = cx.entity().downgrade();
        let layout = self.lyric_hits.clone();
        let hits = layout.clone();
        div()
            .id("lyrics-body")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .cursor_pointer()
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| {
                let mut delta = match event.delta {
                    ScrollDelta::Pixels(point) => point,
                    ScrollDelta::Lines(point) => point.map(|value| px(value * 25.375)),
                };
                if event.modifiers.shift && delta.x == px(0.) {
                    delta = point(delta.y, px(0.));
                }
                let max = (this.lyric_extent.get() - this.lyric_view_height.get()).max(0.);
                let offset = (this.lyric_scroll.get() - f32::from(delta.y)).clamp(0., max);
                let x = if this.lyric_horizontal.get() {
                    (this.lyric_scroll_handle.offset().x + delta.x).clamp(px(-11.), px(0.))
                } else {
                    px(0.)
                };
                this.lyric_scroll.set(offset);
                this.lyric_scroll_target.set(offset);
                this.lyric_scroll_handle.set_offset(point(x, px(-offset)));
                this.lyric_scroll_active.set(false);
                cx.notify();
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    for (index, bounds) in hits.borrow().iter() {
                        if bounds.contains(&e.position) {
                            this.position = *index as f32 * 8.;
                            cx.notify();
                            break;
                        }
                    }
                }),
            )
            .child(
                div()
                    .id("lyrics-scroll-extent")
                    .absolute()
                    .top_0()
                    .left_0()
                    .right(px(10.))
                    .bottom(px(if horizontal { 10. } else { 0. }))
                    .overflow_y_scroll()
                    .overflow_x_scroll()
                    .track_scroll(&self.lyric_scroll_handle)
                    .child(div().h(px(self.lyric_extent.get())).w(px(if horizontal {
                        360.
                    } else {
                        349.
                    }))),
            )
            .child(
                canvas(
                    |b, _, _| b,
                    move |_, b, w, cx| {
                        let _timer = profile.then(|| PaintTimer {
                            start: Instant::now(),
                            stats: stats.clone(),
                        });
                        let font = Font {
                            family: "SingZ Display 650".into(),
                            ..Default::default()
                        };
                        let mut cached_shapes = shapes.borrow_mut();
                        let mut shape = |text: &str, color: Hsla, scale: f32, window: &Window| {
                            let key = (
                                text.to_owned(),
                                [
                                    color.h.to_bits(),
                                    color.s.to_bits(),
                                    color.l.to_bits(),
                                    color.a.to_bits(),
                                ],
                                scale.to_bits(),
                            );
                            cached_shapes
                                .entry(key)
                                .or_insert_with(|| {
                                    window.text_system().shape_line(
                                        text.to_string().into(),
                                        px(17.5 * scale),
                                        &[TextRun {
                                            len: text.len(),
                                            font: font.clone(),
                                            color,
                                            background_color: None,
                                            underline: None,
                                            strikethrough: None,
                                        }],
                                        None,
                                    )
                                })
                                .clone()
                        };
                        let mut cached_layout = layouts.borrow_mut();
                        let width_key = f32::from(b.size.width).round() as i32;
                        if cached_layout.as_ref().map(|entry| entry.0) != Some(width_key) {
                            let space = f32::from(shape(" ", rgb(TEXT).into(), 1., w).width);
                            let available = f32::from(b.size.width) - 40.;
                            let mut lines = Vec::new();
                            let mut top = 18.;
                            for i in 0..24 {
                                let mut x = 0.;
                                let mut row = 0.;
                                let mut words = Vec::new();
                                for text in LYRICS[i % 6].split_whitespace() {
                                    let width =
                                        f32::from(shape(text, rgb(TEXT).into(), 1., w).width);
                                    if x > 0. && x + width > available {
                                        x = 0.;
                                        row += 1.;
                                    }
                                    words.push((text, x, row * 25.375, width));
                                    x += width + space;
                                }
                                let height = (row + 1.) * 25.375 + 14.;
                                lines.push((top, height, words));
                                top += height;
                            }
                            *cached_layout = Some((width_key, lines));
                        }
                        let lines = &cached_layout.as_ref().unwrap().1;
                        let base_metrics = shape(" ", rgb(TEXT).into(), 1., w);
                        let base_baseline =
                            w.text_baseline(base_metrics.ascent, base_metrics.descent, px(25.375));
                        let (active_top, active_height, _) = &lines[active];
                        if !horizontal_state.replace(true) {
                            let owner = owner.clone();
                            w.on_next_frame(move |_, cx| {
                                let _ = owner.update(cx, |_, cx| cx.notify());
                            });
                        }
                        view_height.set(f32::from(b.size.height));
                        extent.set(
                            lines
                                .last()
                                .map(|(top, height, _)| top + height)
                                .unwrap_or(0.)
                                + f32::from(w.viewport_size().height) * 0.4,
                        );
                        let mut previous = scrolling.get();
                        let external_offset = -f32::from(scroll_handle.offset().y);
                        if (external_offset - previous).abs() > 0.5 {
                            previous = external_offset;
                            scroll_target.set(external_offset);
                        }
                        if active_line.replace(active) != active {
                            let target = (active_top + active_height / 2.
                                - f32::from(b.size.height) / 2.)
                                .max(0.);
                            scroll_target
                                .set((target * w.scale_factor()).round() / w.scale_factor());
                        }
                        let target = scroll_target
                            .get()
                            .min((extent.get() - f32::from(b.size.height)).max(0.));
                        scroll_active.set((target - previous).abs() > 0.2);
                        if scroll_active.get() && !suspended {
                            w.request_animation_frame();
                        }
                        let offset = if scroll_active.get() {
                            previous + (target - previous) * 0.16
                        } else {
                            target
                        };
                        scrolling.set(offset);
                        scroll_handle.set_offset(point(scroll_handle.offset().x, px(-offset)));
                        layout.borrow_mut().clear();
                        w.with_content_mask(Some(ContentMask { bounds: b }), |w| {
                            for (i, (top, height, words)) in lines.iter().enumerate() {
                                let y = b.origin.y + px(top - offset);
                                layout.borrow_mut().push((
                                    i,
                                    Bounds::new(
                                        point(b.origin.x, y),
                                        size(b.size.width, px(*height)),
                                    ),
                                ));
                                if f32::from(y - b.origin.y) + height < 0. || y > b.bottom() {
                                    continue;
                                }
                                let scale = if i == active { 1.03 } else { 1. };
                                let baseline_adjustment = if i == active {
                                    let metrics = shape(" ", rgb(TEXT).into(), scale, w);
                                    base_baseline * scale
                                        - w.text_baseline(
                                            metrics.ascent,
                                            metrics.descent,
                                            px(25.375 * scale),
                                        )
                                } else {
                                    px(0.)
                                };
                                let color = rgb(if i == active {
                                    TEXT
                                } else if i < active {
                                    DIM
                                } else {
                                    FAINT
                                });
                                for (j, (text, x, row, width)) in words.iter().enumerate() {
                                    let origin = point(
                                        b.origin.x
                                            + scroll_handle.offset().x
                                            + px(6. + (14. + x) * scale),
                                        y + px((7. + row) * scale - height * (scale - 1.) / 2.)
                                            + baseline_adjustment,
                                    );
                                    // CSS applies the fixed 14px text shadow to the active word only.
                                    // GPUI caches this filtered outline in its sprite atlas; no blur runs per frame.
                                    let total_chars = words
                                        .iter()
                                        .map(|(word, _, _, _)| word.chars().count())
                                        .sum::<usize>()
                                        as f32;
                                    let before_chars = words[..j]
                                        .iter()
                                        .map(|(word, _, _, _)| word.chars().count())
                                        .sum::<usize>()
                                        as f32;
                                    let word_start =
                                        i as f32 * 8. + before_chars / total_chars * 6.5;
                                    let word_end = word_start
                                        + text.chars().count() as f32 / total_chars * 6.5;
                                    if i == active && position >= word_start && position < word_end
                                    {
                                        if let Some(texture) = glow_textures.get(text) {
                                            let bounds = Bounds::new(
                                                origin - point(px(21.), px(21.)),
                                                size(
                                                    px(width * scale + 42.),
                                                    px(25.375 * scale + 42.),
                                                ),
                                            );
                                            let _ = w.paint_image(
                                                bounds,
                                                bounds,
                                                Corners::default(),
                                                texture.clone(),
                                                0,
                                                false,
                                            );
                                        }
                                    }
                                    if i != active {
                                        let _ = shape(text, color.into(), scale, w).paint(
                                            origin,
                                            px(25.375 * scale),
                                            TextAlign::Left,
                                            None,
                                            w,
                                            cx,
                                        );
                                        continue;
                                    }
                                    let p = (((position - word_start) / (word_end - word_start))
                                        .clamp(0., 1.)
                                        * 200.)
                                        .round()
                                        / 200.;
                                    let dpr = w.scale_factor();
                                    // Snap the transformed line's paint offset separately from
                                    // its local baseline, as Blink does for vector text. Word
                                    // advances retain their fractional positions inside the line.
                                    let metrics = shape(" ", color.into(), scale, w);
                                    let line_left = b.left() + scroll_handle.offset().x + px(6.);
                                    let local_baseline =
                                        px((7. + row) * scale - height * (scale - 1.) / 2.)
                                            + base_baseline * scale;
                                    let paint_origin = point(
                                        px((f32::from(line_left) * dpr).round() / dpr)
                                            + px((14. + x) * scale),
                                        px((f32::from(y) * dpr).round() / dpr)
                                            + px((f32::from(local_baseline) * dpr).round() / dpr)
                                            - w.text_baseline(
                                                metrics.ascent,
                                                metrics.descent,
                                                px(25.375 * scale),
                                            ),
                                    );
                                    let feather = 17.5 * 0.4 * scale;
                                    let edge = p * (width * scale + 2. * feather) - feather;
                                    // Approved native paint: readable base, amber feather, then
                                    // a continuous bright core and cached halo. Preserve these
                                    // alpha layers; Electron's flatter paint is not this baseline.
                                    let _ = shape(text, color.into(), scale, w).paint(
                                        paint_origin,
                                        px(25.375 * scale),
                                        TextAlign::Left,
                                        None,
                                        w,
                                        cx,
                                    );
                                    let amber = shape(text, rgb(ACCENT).into(), scale, w);
                                    let solid = (edge - feather).clamp(0., width * scale);
                                    if solid > 0. {
                                        w.with_content_mask(
                                            Some(ContentMask {
                                                bounds: Bounds::new(
                                                    point(paint_origin.x, b.top()),
                                                    size(px(solid), b.size.height),
                                                ),
                                            }),
                                            |w| {
                                                let _ = amber.paint(
                                                    paint_origin,
                                                    px(25.375 * scale),
                                                    TextAlign::Left,
                                                    None,
                                                    w,
                                                    cx,
                                                );
                                            },
                                        );
                                    }
                                    for slice in 0..12 {
                                        let left = (edge - feather
                                            + slice as f32 * 2. * feather / 12.)
                                            .max(0.);
                                        let right = (edge - feather
                                            + (slice + 1) as f32 * 2. * feather / 12.)
                                            .min(width * scale);
                                        if right <= left {
                                            continue;
                                        }
                                        let alpha = 1. - (slice as f32 + 0.5) / 12.;
                                        let ink =
                                            shape(text, rgb(ACCENT).alpha(alpha).into(), scale, w);
                                        w.with_content_mask(
                                            Some(ContentMask {
                                                bounds: Bounds::new(
                                                    point(paint_origin.x + px(left), b.top()),
                                                    size(px(right - left), b.size.height),
                                                ),
                                            }),
                                            |w| {
                                                let _ = ink.paint(
                                                    paint_origin,
                                                    px(25.375 * scale),
                                                    TextAlign::Left,
                                                    None,
                                                    w,
                                                    cx,
                                                );
                                            },
                                        );
                                    }
                                    // 18px feathered band moves through glyphs, never selects a letter.
                                    if position >= word_start && position < word_end && p > 0. {
                                        let pen = p * width * scale;
                                        let light_width = 18.;
                                        let texture_bounds = Bounds::new(
                                            paint_origin - point(px(21.), px(21.)),
                                            size(px(width * scale + 42.), px(25.375 * scale + 42.)),
                                        );
                                        for slice in 0..12 {
                                            let u = (slice as f32 + 0.5) / 12.;
                                            let intensity = (1. - (u * 2. - 1.).abs()).powf(1.5);
                                            let left = pen - light_width / 2.
                                                + slice as f32 * light_width / 12.;
                                            let clip = Bounds::new(
                                                point(paint_origin.x + px(left), b.top()),
                                                size(px(light_width / 12.), b.size.height),
                                            );
                                            w.with_content_mask(
                                                Some(ContentMask { bounds: clip }),
                                                |w| {
                                                    if let Some(bands) = glow_bands.get(text) {
                                                        let index =
                                                            (intensity * 8.).ceil().clamp(1., 8.)
                                                                as usize
                                                                - 1;
                                                        if w.paint_image(
                                                            texture_bounds,
                                                            texture_bounds,
                                                            Corners::default(),
                                                            bands[index].clone(),
                                                            0,
                                                            false,
                                                        )
                                                        .is_ok()
                                                        {
                                                            stats
                                                                .borrow_mut()
                                                                .advancing_glow_draws += 1;
                                                        }
                                                    }
                                                    let leading = shape(
                                                        text,
                                                        rgb(0xffdf9c).alpha(intensity).into(),
                                                        scale,
                                                        w,
                                                    );
                                                    let _ = leading.paint(
                                                        paint_origin,
                                                        px(25.375 * scale),
                                                        TextAlign::Left,
                                                        None,
                                                        w,
                                                        cx,
                                                    );
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .right(px(10.))
                .bottom(px(if horizontal { 10. } else { 0. })),
            )
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom(px(if horizontal { 10. } else { 0. }))
                    .w(px(10.))
                    .child(singz_uikit::production_scrollbar(&self.lyric_scroll_handle)),
            )
            .when(horizontal, |body| {
                body.child(
                    div()
                        .absolute()
                        .left_0()
                        .right(px(10.))
                        .bottom_0()
                        .h(px(10.))
                        .child(singz_uikit::production_scrollbar_horizontal(
                            &self.lyric_scroll_handle,
                        )),
                )
                .child(
                    div()
                        .absolute()
                        .right_0()
                        .bottom_0()
                        .size(px(10.))
                        .bg(rgb(0xffffff)),
                )
            })
    }
    fn lane(&self, i: usize, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let position = self.position;
        let view_start = self.view_start;
        let view_end = self.view_end;
        let fade = self.fade[i];
        let enter = ((self.started.elapsed().as_secs_f32() - i as f32 * 0.07) / 0.55).clamp(0., 1.);
        let enter = 1. - (1. - enter).powi(3);
        let geometry = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let hit = geometry.clone();
        let gain = self.gain[i] as f32 / 100.;
        div()
            .flex()
            .flex_1()
            .min_h(px(64.))
            .opacity(enter)
            .border_b_1()
            .border_color(rgba(0xfff0d614))
            .child(
                div()
                    .w(px(228.))
                    .flex_shrink_0()
                    .pl(px(14.))
                    .pr(px(18.))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(9.))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(9.))
                            .child(
                                div()
                                    .size(px(9.))
                                    .rounded_full()
                                    .bg(rgb(COLORS[i]).alpha(if fade < 0.5 { 0.4 } else { 1. }))
                                    .shadow(if fade < 0.5 {
                                        vec![]
                                    } else {
                                        vec![glow(COLORS[i], 0.7, 10.)]
                                    }),
                            )
                            .child(
                                div()
                                    .text_size(px(14.5))
                                    .line_height(px(17.5))
                                    .font_family("SingZ Display 700")
                                    .font_weight(FontWeight::NORMAL)
                                    .text_color(rgb(if fade > 0.5 { TEXT } else { FAINT }))
                                    .child(NAMES[i]),
                            ),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .items_center()
                            .child(
                                singz_uikit::stem_chip(("m", i), "M", self.muted[i], COLORS[i])
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.muted[i] = !this.muted[i];
                                        cx.notify();
                                    })),
                            )
                            .child(
                                singz_uikit::stem_chip(("s", i), "S", self.solo[i], ACCENT)
                                    .on_click(cx.listener(move |this, _, _, cx| {
                                        this.solo[i] = !this.solo[i];
                                        cx.notify();
                                    })),
                            )
                            .child(singz_uikit::stem_volume(("gain", i), gain, COLORS[i], {
                                let entity = cx.entity().downgrade();
                                move |value, _, cx| {
                                    let _ = entity.update(cx, |this, cx| {
                                        this.gain[i] = (value * 100.).round() as u8;
                                        cx.notify();
                                    });
                                }
                            })),
                    ),
            )
            .child(
                div()
                    .id(("wave", i))
                    .flex_1()
                    .cursor_pointer()
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            if let Some(b) = hit.get() {
                                this.position = (f32::from(e.position.x - b.origin.x)
                                    / f32::from(b.size.width))
                                .clamp(0., 1.)
                                    * (view_end - view_start)
                                    * DURATION
                                    + view_start * DURATION;
                                cx.notify();
                            }
                        }),
                    )
                    .child(
                        canvas(
                            move |b, _, _| {
                                geometry.set(Some(b));
                                b
                            },
                            move |_, b, w, _| {
                                let wave_bounds = Bounds::new(
                                    point(b.left(), b.top() + px(7.)),
                                    size(b.size.width, (b.size.height - px(14.)).max(px(1.))),
                                );
                                waveform::paint(
                                    i,
                                    position,
                                    DURATION,
                                    fade,
                                    wave_bounds,
                                    w,
                                    enter,
                                    view_start,
                                    view_end,
                                );
                            },
                        )
                        .size_full(),
                    ),
            )
    }
}
impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let modal_open = self.screen == Screen::Settings || self.notice.is_some();
        if modal_open != self.modal_was_open {
            // Resume from now, excluding time spent behind a modal.
            self.last = Instant::now();
            if modal_open {
                self.previous_focus = window.focused(cx);
                self.focus_handle.focus(window, cx);
            } else if let Some(previous) = self.previous_focus.take() {
                previous.focus(window, cx);
            }
            self.modal_was_open = modal_open;
        }
        self.library.update(cx, |library, cx| {
            library.set_suspended(self.screen == Screen::Settings || self.notice.is_some(), cx)
        });
        self.pitch_strip.update(cx, |strip, cx| {
            strip.set_position(self.position, cx);
            strip.set_view(self.view_start, self.view_end, cx);
        });
        self.transport.update(cx, |transport, cx| {
            transport.set_state(
                self.position,
                self.playing,
                self.transpose,
                self.looping,
                cx,
            );
            transport.set_karaoke(self.karaoke, cx);
        });
        let base_catalog = self.screen == Screen::Library
            || self.screen == Screen::Settings && self.previous_screen == Screen::Library;
        self.header.update(cx, |header, cx| {
            header.set_state(self.loaded_song, base_catalog, self.song_title.clone(), cx)
        });
        if self.screen == Screen::Settings {
            if self.backdrop.is_none() {
                self.backdrop = window.render_to_image().ok().map(|image| {
                    let mut blurred = image::imageops::blur(&image, 8. * window.scale_factor());
                    for pixel in blurred.pixels_mut() {
                        pixel.0.swap(0, 2);
                    }
                    Arc::new(RenderImage::new(vec![image::Frame::new(blurred)]))
                });
            }
        } else {
            self.backdrop = None;
        }
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32();
        self.last = now;
        let mut animating =
            self.started.elapsed().as_secs_f32() < 1.1 || self.lyric_scroll_active.get();
        let solo = self.solo.iter().any(|s| *s);
        for i in 0..6 {
            let target = if !self.muted[i] && (!solo || self.solo[i]) {
                1.
            } else {
                0.14
            };
            if (self.fade[i] - target).abs() > 0.002 {
                self.fade[i] += (target - self.fade[i]) * (dt / 0.15).min(1.);
                animating = true;
            }
        }
        if self.playing && self.screen == Screen::Player && !modal_open {
            self.position += dt * self.tempo;
            if self.looping && self.position >= DURATION {
                self.position %= DURATION;
            }
            if self.position >= DURATION {
                self.position = DURATION;
                self.playing = false;
            }
            animating = true;
        }
        // Deterministic capture only: external runner advances song time one display-frame at a time.
        if let Some(path) = self.capture_file.clone() {
            if let Ok(value) = std::fs::read_to_string(&path) {
                if let Ok(position) = value.trim().parse::<f32>() {
                    self.position = position.clamp(0., DURATION);
                    self.playing = false;
                    window.on_next_frame(move |_, _| {
                        let _ = std::fs::write(path.with_extension("ack"), value);
                    });
                }
            }
            animating = true;
        }
        if animating && self.screen == Screen::Player && !modal_open {
            window.request_animation_frame();
        }

        let base_screen = if self.screen == Screen::Settings {
            self.previous_screen
        } else {
            self.screen
        };
        let timeline_width =
            (f32::from(window.viewport_size().width) - if self.karaoke { 360. } else { 0. } - 260.)
                .max(1.);
        let span = (self.view_end - self.view_start) * DURATION;
        let step = [
            0.1, 0.2, 0.5, 1., 2., 5., 10., 15., 30., 60., 120., 300., 600.,
        ]
        .into_iter()
        .find(|step| timeline_width * step / span >= 74.)
        .unwrap_or(600.);
        let mut ticks = vec![];
        let mut tick = (self.view_start * DURATION / step).ceil() * step;
        while tick < self.view_end * DURATION - step * 0.2 {
            let fraction = (tick - self.view_start * DURATION) / span;
            if fraction * timeline_width > timeline_width - 130. {
                break;
            }
            if tick > 0.000001 {
                ticks.push((tick, fraction));
            }
            tick += step;
        }
        let scrub_bounds = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let scrub_hit = scrub_bounds.clone();
        let head = (self.position / DURATION - self.view_start) / (self.view_end - self.view_start);
        let head_pixels =
            (head * timeline_width * window.scale_factor()).round() / window.scale_factor();
        let playhead = div()
            .absolute()
            .left(px(238.))
            .right(px(22.))
            .top(px(4.))
            .bottom(px(10.))
            .min_h(px(414.))
            .child(
                canvas(
                    move |bounds, _, _| {
                        scrub_bounds.set(Some(bounds));
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
            .when((0. ..=1.).contains(&head), |overlay| {
                overlay.child(
                    div()
                        .absolute()
                        .left(px(head_pixels))
                        .top_0()
                        .bottom_0()
                        .w(px(1.))
                        .bg(rgba(0xfff4e0d9))
                        .shadow(vec![glow(0xffc46e, 0.55, 9.)])
                        .child(
                            canvas(
                                |b, _, _| b,
                                |_, b, w, _| {
                                    let mut path = PathBuilder::fill();
                                    path.move_to(b.origin);
                                    path.line_to(point(b.right(), b.top()));
                                    path.line_to(point(b.left() + px(4.5), b.bottom()));
                                    path.close();
                                    if let Ok(path) = path.build() {
                                        w.paint_path(path, rgba(0xfff4e0e6));
                                    }
                                },
                            )
                            .absolute()
                            .top_0()
                            .left(px(-4.))
                            .w(px(9.))
                            .h(px(7.)),
                        ),
                )
            });
        let content = match base_screen {
            Screen::Library => self.library.clone().into_any_element(),
            Screen::Settings => unreachable!(),
            Screen::Player => div().flex().flex_col().flex_1().min_h_0()
                .child(div().flex().flex_1().min_h_0()
                    .child(div().flex_1().min_w_0().flex().flex_col()
                        .child(div().relative().flex_1().min_h_0().pl(px(10.)).pr(px(22.)).pt(px(4.)).pb(px(10.)).flex().flex_col()
                            .child(div().h(px(30.)).flex_shrink_0().flex()
                                .child(div().w(px(228.)).pl(px(14.)).flex().gap(px(5.)).items_center()
                                    .child(singz_uikit::ruler_button("add-track","+ Add track…",false,false).on_click(cx.listener(|this,_,_,cx| { this.notice=Some("Custom audio tracks are not connected in this prototype.".into());cx.notify(); })))
                                    .children(["M","S","↓"].into_iter().enumerate().map(|(i,label)| {
                                        let disabled=match i {0=>!self.muted.iter().any(|value|*value),1=>!self.solo.iter().any(|value|*value),_=>false};
                                        singz_uikit::ruler_button(("all-track",i),label,true,disabled).on_click(cx.listener(move |this,_,_,cx| {
                                            if disabled{return;} match i {0=>this.muted=[false;6],1=>this.solo=[false;6],_=>this.notice=Some("Stem export is not connected in this prototype.".into())};cx.notify();
                                        }))
                                    }))
                                )
                                .child(div().id("time-ruler").relative().flex_1().border_b_1().border_color(rgba(0xfff0d614))
                                    .on_mouse_down(MouseButton::Left,cx.listener(move |this,event:&MouseDownEvent,_,cx| {
                                        if let Some(bounds)=scrub_hit.get() {
                                            if event.position.x>bounds.right()-px(130.) {return;}
                                            let fraction=(f32::from(event.position.x-bounds.left())/f32::from(bounds.size.width)).clamp(0.,1.);
                                            this.position=(this.view_start+fraction*(this.view_end-this.view_start))*DURATION;cx.notify();
                                        }
                                    }))
                                    .children(ticks.into_iter().map(|(tick,fraction)|div().absolute().left(relative(fraction)).ml(px(-30.)).w(px(60.)).top(px(8.)).flex().justify_center().child(singz_uikit::tracked_text(if step<1. {format!("{}.{:01}",clock(tick),((tick.fract()*10.).floor() as i32).clamp(0,9))}else{clock(tick)},"SingZ Mono 400",9.,0.54,FAINT))))
                                    .child(div().absolute().right_0().top(px(3.)).pl(px(10.)).bg(rgb(BG)).child(singz_uikit::zoom_segment(vec![
                                        singz_uikit::zoom_button("zoom-out","−",false).on_click(cx.listener(|this,_,_,cx|this.zoom_by(1.4,cx))),
                                        singz_uikit::zoom_button("zoom-in","+",false).on_click(cx.listener(|this,_,_,cx|this.zoom_by(0.65,cx))),
                                        singz_uikit::zoom_button("zoom-fit","Full",self.view_start==0.&&self.view_end==1.).on_click(cx.listener(|this,_,_,cx|{this.view_start=0.;this.view_end=1.;cx.notify();})),
                                    ])))
                                ))
                            .children((0..6).map(|i|self.lane(i,cx))).child(playhead))
                        .when(self.karaoke, |column| column.child(self.pitch_strip.clone())))
                    .when(self.karaoke,|row|row.child(div().w(px(360.)).flex_shrink_0().border_l_1().border_color(rgba(0xfff0d614)).bg(rgba(0x1b181466)).flex().flex_col()
                        .child(div().h(px(53.)).flex_shrink_0().px(px(18.)).pt(px(14.)).pb(px(12.)).flex().items_center().justify_between().border_b_1().border_color(rgba(0xfff0d614))
                            .child(singz_uikit::tracked_text("Lyrics","SingZ Display 800",15.,0.3,TEXT))
                            .child(pill("guide","Guide vocals",!self.muted[0]).h(px(26.)).rounded(px(7.)).px(px(10.)).text_size(px(11.)).shadow(vec![]).bg(if self.muted[0]{rgba(0)}else{rgba(0xffa02821)}).border_color(if self.muted[0]{rgba(0xfff0d614)}else{rgba(0xffa0288c)}).on_click(cx.listener(|this,_,_,cx| { this.muted[0]=!this.muted[0];cx.notify(); }))))
                        .child(div().h(px(59.)).flex_shrink_0().px(px(18.)).py(px(9.)).border_b_1().border_color(rgba(0xfff0d614)).flex().flex_col().gap(px(4.))
                            .child(div().flex().items_center().gap(px(8.)).child(singz_uikit::source_badge("Edited",true)).child(div().flex_1().text_size(px(11.5)).text_color(rgb(DIM)).child("Demo lyrics")).child(singz_uikit::lyrics_action("lyric-check","Check & align")))
                            .child(div().flex().gap(px(8.)).children(["Precise","Edit","Change…"].into_iter().enumerate().map(|(i,label)| singz_uikit::lyrics_action(("lyric-action",i),label).on_click(cx.listener(|this,_,_,cx| { this.notice=Some("Lyrics editing is not connected in this prototype.".into());cx.notify(); }))))))
                        .child(self.lyrics(cx)))))
                .child(self.transport.clone()).into_any_element(),
        };
        let root = div()
            .id("app")
            .track_focus(&self.focus_handle)
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, _, cx| {
                if event.keystroke.key == "escape" {
                    if this.notice.take().is_some() {
                        cx.notify();
                        cx.stop_propagation();
                    } else if this.screen == Screen::Settings {
                        let dismissed = this
                            .settings
                            .update(cx, |settings, cx| settings.dismiss_popup(cx));
                        if !dismissed {
                            this.screen = this.previous_screen;
                        }
                        cx.notify();
                        cx.stop_propagation();
                    }
                }
            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .when(cfg!(not(target_os = "macos")), |root| root.bg(rgb(BG)))
            .child(
                self.background
                    .render(window.viewport_size(), window.scale_factor()),
            )
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_color(rgb(TEXT))
            .text_size(px(14.))
            .child(
                window_chrome::header(self.header_drag.clone(), window.is_fullscreen())
                    .child(self.header.clone()),
            )
            .child(content)
            .when(self.screen == Screen::Settings, |root| {
                root.when_some(self.backdrop.clone(), |root, image| {
                    root.child(div().absolute().inset_0().child(img(image).size_full()))
                })
                .child(
                    singz_uikit::modal_scrim()
                        .id("settings-scrim")
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event: &MouseDownEvent, window, cx| {
                                let viewport = window.viewport_size();
                                let width = (f32::from(viewport.width) - 48.).min(960.);
                                let left = (f32::from(viewport.width) - width) / 2.;
                                if f32::from(event.position.x) < left
                                    || f32::from(event.position.x) > left + width
                                    || f32::from(event.position.y) < 24.
                                    || f32::from(event.position.y)
                                        > f32::from(viewport.height) - 24.
                                {
                                    this.screen = this.previous_screen;
                                    cx.notify();
                                    cx.stop_propagation();
                                }
                            }),
                        )
                        .child(self.settings.clone()),
                )
            })
            .when_some(self.notice.clone(), |root, text| {
                root.child(
                    singz_uikit::modal_scrim().child(
                        singz_uikit::modal_card()
                            .w(px(480.))
                            .gap(px(20.))
                            .child(text)
                            .child(pill("notice-close", "Close", false).on_click(cx.listener(
                                |this, _, _, cx| {
                                    this.notice = None;
                                    cx.notify();
                                },
                            ))),
                    ),
                )
            });
        #[cfg(feature = "ui-tests")]
        let root = root.when(self.text_phase_check, |root| {
            root.child(ui_text_phase::overlay())
        });
        root
    }
}

struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(Some(Cow::Borrowed(match path {
            "transport-met" => include_bytes!("../assets/icons/transport-met.svg"),
            "transport-carry" => include_bytes!("../assets/icons/transport-carry.svg"),
            "transport-mic" => include_bytes!("../assets/icons/transport-mic.svg"),
            "transport-speaker" => include_bytes!("../assets/icons/transport-speaker.svg"),
            "transport-chevron" => include_bytes!("../assets/icons/transport-chevron.svg"),
            "header-logo-z" => include_bytes!("../assets/icons/header-logo-z.svg"),
            "header-gear" => include_bytes!("../assets/icons/header-gear.svg"),
            "header-catalog" => include_bytes!("../assets/icons/header-catalog.svg"),
            "play" => include_bytes!("../assets/icons/play.svg"),
            "pause" => include_bytes!("../assets/icons/pause.svg"),
            "restart" => include_bytes!("../assets/icons/restart.svg"),
            "loop" => include_bytes!("../assets/icons/loop.svg"),
            _ => return Ok(None),
        })))
    }
    fn list(&self, _: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

fn main() {
    text_rendering::configure();
    gpui_kit::application().with_assets(Assets).run(|cx| {
        gpui_kit::init(cx);
        singz_uikit::init(cx);
        #[cfg(target_os = "macos")]
        {
            gpui_kit::component::Theme::global_mut(cx).tokens.background =
                Hsla::from(rgba(0)).into();
        }
        cx.text_system()
            .add_fonts(vec![
                Cow::Borrowed(include_bytes!("../assets/Bricolage400.ttf")),
                Cow::Borrowed(include_bytes!("../assets/Bricolage500.ttf")),
                Cow::Borrowed(include_bytes!("../assets/Bricolage600.ttf")),
                Cow::Borrowed(include_bytes!("../assets/Bricolage650.ttf")),
                Cow::Borrowed(include_bytes!("../assets/Bricolage700.ttf")),
                Cow::Borrowed(include_bytes!("../assets/Bricolage800.ttf")),
                Cow::Borrowed(include_bytes!("../assets/MartianMono400.ttf")),
                Cow::Borrowed(include_bytes!("../assets/MartianMono500.ttf")),
                Cow::Borrowed(include_bytes!("../assets/MartianMono700.ttf")),
            ])
            .expect("load bundled fonts");
        let background = std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some();
        let (window_handle, view) = gpui_kit::open_window(
            WindowOptions {
                focus: !background,
                show: !background,
                window_min_size: Some(size(px(1060.), px(640.))),
                window_bounds: Some(WindowBounds::Windowed(Bounds::centered(
                    None,
                    size(px(1280.), px(800.)),
                    cx,
                ))),
                ..window_chrome::options()
            },
            cx,
            |window, cx| {
                window.set_layout_precision(LayoutPrecision::CssPixels);
                cx.new(|cx| Player::new(window, cx))
            },
        )
        .expect("open player");
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_UI_SMOKE") {
            assert!(background, "UI smoke requires background mode");
            ui_smoke::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_REVIEW_CAPTURE") {
            assert!(background, "UI review requires background mode");
            ui_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LYRICS_REVIEW") {
            assert!(background, "Lyrics review requires background mode");
            ui_lyrics_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LIBRARY_REVIEW") {
            assert!(background, "Library review requires background mode");
            ui_library_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(output) = std::env::var_os("SINGZ_GPUI_OFFSCREEN_BENCHMARK") {
            assert!(background, "Offscreen benchmark requires background mode");
            ui_benchmark::run(window_handle, view.clone(), output.into(), cx);
        }
        #[cfg(not(feature = "ui-tests"))]
        let _ = (window_handle, view);
        if !background {
            cx.activate(true);
        }
    });
}

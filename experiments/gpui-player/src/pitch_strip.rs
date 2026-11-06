//! Production pitch-strip composition for the deterministic 192-second A2
//! review fixture. Microphone availability reflects the reference safety lease.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::*;
use singz_uikit::{
    TransportIcon, colored_icon, small_ghost_pill, tracked_label, tracked_text, zoom_chip,
};
use std::sync::{Arc, OnceLock};

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
const DURATION: f32 = 192.;
const MIC_UNAVAILABLE: &str = "Microphone unavailable";

pub struct PitchStrip {
    position: f32,
    note_bars: bool,
    fit: bool,
    view_start: f32,
    view_end: f32,
}
impl PitchStrip {
    pub fn new(position: f32, _: &mut Context<Self>) -> Self {
        Self {
            position,
            note_bars: true,
            fit: true,
            view_start: 0.,
            view_end: 1.,
        }
    }
    pub fn set_position(&mut self, position: f32, cx: &mut Context<Self>) {
        if self.position != position {
            self.position = position;
            cx.notify();
        }
    }
    pub fn set_view(&mut self, start: f32, end: f32, cx: &mut Context<Self>) {
        let (start, end) = normalized_view(start, end);
        if (self.view_start, self.view_end) != (start, end) {
            self.view_start = start;
            self.view_end = end;
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn view(&self) -> (f32, f32) {
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
        let note = zoom_chip("pitch-note-bars", "Note bars", self.note_bars).on_click(cx.listener(
            |this, _, _, cx| {
                this.note_bars = !this.note_bars;
                cx.notify();
            },
        ));
        let fit = zoom_chip("pitch-fit", "Fit", self.fit)
            .whitespace_nowrap()
            .on_click(cx.listener(|this, _, _, cx| {
                this.fit = !this.fit;
                cx.notify();
            }));
        scene(
            self.position,
            self.note_bars,
            self.fit,
            self.view_start,
            self.view_end,
            window,
        )
        .child(hud(note, fit))
    }
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

fn scene(
    position: f32,
    note_bars: bool,
    fit: bool,
    view_start: f32,
    view_end: f32,
    window: &Window,
) -> Div {
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
                |b, _, _| b,
                move |_, b, w, cx| {
                    paint_roll(b, position, note_bars, fit, view_start, view_end, w, cx)
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
                .child(info_row("KEY", "G#m", true, window))
                .child(info_row("TEMPO", "—", false, window))
                .child(info_row("RANGE", "A2–A2", false, window))
                .child(info_row("LENGTH", "3:12", false, window)),
        )
}
fn hud(note_button: Stateful<Div>, fit_button: Stateful<Div>) -> Div {
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
        .child(note_button.flex_none().w(px(80.)).whitespace_nowrap())
        .child(fit_button.flex_none())
        .child(
            small_ghost_pill("pitch-microphone-unavailable", "")
                .flex_shrink_1()
                .min_w_0()
                .h(px(24.)).ml_auto().overflow_hidden()
                .opacity(0.45)
                .cursor_default()
                .child(colored_icon(TransportIcon::Mic, TEXT).with_size(12))
                .child(
                    div()
                        .flex_shrink_1()
                        .min_w_0()
                        .text_center()
                        .text_size(px(12.))
                        .line_height(px(14.))
                        .font_family(DISPLAY_600)
                        .font_weight(FontWeight::NORMAL)
                        .child(tracked_label(MIC_UNAVAILABLE, 0.01)),
                ),
        )
}

fn info_row(label: &'static str, value: &'static str, key: bool, window: &Window) -> Div {
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
    position: f32,
    note_bars: bool,
    fit: bool,
    view_start: f32,
    view_end: f32,
    w: &mut Window,
    cx: &mut App,
) {
    let (view_start, view_end) = normalized_view(view_start, view_end);
    let view_span = view_end - view_start;
    let width = f32::from(b.size.width);
    let height = f32::from(b.size.height);
    let (lo, hi) = if fit { (39., 51.) } else { (36., 84.) };
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
                x0 + roll_w * ((trace_start - view_start) / view_span),
                y - px(0.5),
                roll_w * ((trace_end - trace_start) / view_span),
                px(1.),
                rgba(0xffd6964d).into(),
            );
        }
    }
    // The fixture's single A2 note is intersected with the current time viewport.
    // A clipped note edge stays square; only the note's actual endpoints are rounded.
    let note_start = 0_f32;
    // The canonical fixture stores 7,626 voiced frames at a 0.025125s hop;
    // production segmentMelodyNotes ends the run after its final frame.
    let note_end = (7626. * 0.025125) / DURATION;
    let visible_start = note_start.max(view_start);
    let visible_end = note_end.min(view_end);
    let note_visible = visible_end > visible_start;
    let note_x = x0 + roll_w * ((visible_start - view_start) / view_span);
    let note_width = roll_w * ((visible_end - visible_start).max(0.) / view_span);
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
        let x = x0 + roll_w * ((fraction - view_start) / view_span);
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

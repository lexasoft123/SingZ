//! Production Transport.tsx composition. State is controlled by the host;
//! engine-only actions are events, never simulated successful native operations.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DIM, FAINT, LINE, TEXT};
use singz_uikit::{TransportIcon, colored_icon, tracked_label, tracked_text};
use singz_uikit::{
    disabled_bpm_field, ghost_pill, karaoke_pill, modal_card, play_button, range_slider,
    round_button, song_output_trigger, split_pill, transport_badge, transport_chip,
};

#[derive(Clone, Copy)]
pub enum TransportEvent {
    Play,
    Restart,
    Loop,
    Transpose(i32),
    Karaoke,
    Tempo(f32),
    Volume(f32),
    Metronome,
    CarryLine,
    StemFiles,
}
impl EventEmitter<TransportEvent> for Transport {}
pub struct Transport {
    position: f32,
    playing: bool,
    transpose: i32,
    looping: bool,
    karaoke: bool,
    tempo: f32,
    volume: f32,
    output_open: bool,
    split_open: bool,
}
impl Transport {
    pub fn new(_: &mut Window, _: &mut Context<Self>) -> Self {
        Self {
            position: 64.,
            playing: false,
            transpose: 0,
            looping: false,
            karaoke: true,
            tempo: 1.,
            volume: 1.,
            output_open: false,
            split_open: false,
        }
    }
    pub fn set_state(
        &mut self,
        position: f32,
        playing: bool,
        transpose: i32,
        looping: bool,
        cx: &mut Context<Self>,
    ) {
        if (self.position, self.playing, self.transpose, self.looping)
            != (position, playing, transpose, looping)
        {
            self.position = position;
            self.playing = playing;
            self.transpose = transpose;
            self.looping = looping;
            cx.notify();
        }
    }
    pub fn set_karaoke(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.karaoke != on {
            self.karaoke = on;
            cx.notify();
        }
    }
    fn icon(path: &'static str, size: f32) -> Div {
        let kind = match path {
            "restart" => TransportIcon::Restart,
            "play" => TransportIcon::Play,
            "pause" => TransportIcon::Pause,
            "loop" => TransportIcon::Loop,
            "transport-met" => TransportIcon::Metronome,
            "transport-carry" => TransportIcon::CarryLine,
            "transport-mic" => TransportIcon::Mic,
            "transport-speaker" => TransportIcon::Speaker,
            _ => TransportIcon::Chevron,
        };
        let color = match kind {
            TransportIcon::Play | TransportIcon::Pause => 0x241705,
            TransportIcon::Mic => ACCENT,
            _ => DIM,
        };
        div()
            .size(px(size))
            .flex_shrink_0()
            .child(colored_icon(kind, color))
    }
    fn mono(text: impl Into<SharedString>) -> Div {
        div()
            .font_family("SingZ Mono 400")
            .text_color(rgb(FAINT))
            .text_size(px(10.))
            .line_height(px(12.))
            .child(text.into())
    }
    fn clock(position: f32) -> String {
        let tenths = (position.max(0.) * 10.).floor() as u32;
        format!("{}:{:02}.{}", tenths / 600, (tenths / 10) % 60, tenths % 10)
    }
    fn output(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let weak = cx.entity().downgrade();
        let db = if self.volume <= 0. {
            "−∞ dB".to_owned()
        } else {
            format!("{:.1} dB", 20. * self.volume.log10())
        };
        div()
            .relative()
            .flex_shrink_0()
            .child(
                song_output_trigger("transport-output", db, compact).on_click(cx.listener(
                    |this, _, _, cx| {
                        this.output_open = !this.output_open;
                        cx.notify();
                    },
                )),
            )
            .when(self.output_open, |v| {
                v.child(
                    deferred(
                        modal_card()
                            .absolute()
                            .bottom_full()
                            .mb(px(12.))
                            .left_0()
                            .w(px(328.))
                            .p(px(20.))
                            .rounded(px(14.))
                            .child(
                                div()
                                    .font_family("SingZ Display 600")
                                    .text_size(px(16.))
                                    .child("Song volume"),
                            )
                            .child(
                                Self::mono("Saved with this song")
                                    .mt(px(4.))
                                    .text_size(px(11.)),
                            )
                            .child(div().mt(px(14.)).child(range_slider(
                                "transport-output-slider",
                                self.volume,
                                0.,
                                4.,
                                move |value, _, cx| {
                                    let _ = weak.update(cx, |this, cx| {
                                        this.volume = value;
                                        cx.emit(TransportEvent::Volume(value));
                                        cx.notify();
                                    });
                                },
                            )))
                            .child(Self::mono("Adjust the song’s output level.").mt(px(12.))),
                    )
                    .with_priority(120),
                )
            })
    }
}
impl Render for Transport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let compact = window.viewport_size().width <= px(1100.);
        let (_, clock_baseline) =
            singz_uikit::css_normal_line_metrics(window, "SingZ Mono 500", 21.);
        let (_, total_baseline) =
            singz_uikit::css_normal_line_metrics(window, "SingZ Mono 400", 11.);
        let transpose = self.transpose;
        let tempo = self.tempo;
        div()
            .w_full()
            .min_h(px(86.))
            .flex_shrink_0()
            .relative()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(20.))
            .gap_y(px(10.))
            .px(px(24.))
            .py(px(12.))
            .border_t_1()
            .border_color(rgba(LINE))
            .bg(rgba(0x1b1814b8))
            .font_family("SingZ Display 400")
            .text_color(rgb(TEXT))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .min_w(px(if compact { 540.84375 } else { 576.84375 }))
                    .flex_shrink_0()
                    .child(
                        round_button("transport-restart", false)
                            .child(Self::icon("restart", 13.))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Restart))),
                    )
                    .child(
                        play_button("transport-play", self.playing)
                            .child(
                                Self::icon(if self.playing { "pause" } else { "play" }, 16.)
                                    .ml(px(if self.playing { 0. } else { 1. })),
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Play))),
                    )
                    .child(
                        div()
                            .ml(px(6.))
                            .flex()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                div()
                                    .min_w(px(96.))
                                    .font_family("SingZ Mono 500")
                                    .text_size(px(21.))
                                    .line_height(px(25.))
                                    .child(
                                        tracked_text(
                                            Self::clock(self.position),
                                            "SingZ Mono 500",
                                            21.,
                                            0.42,
                                            TEXT,
                                        )
                                        .line_height(25.),
                                    ),
                            )
                            .child(
                                div().pt(clock_baseline - total_baseline).child(
                                    tracked_text("/ 3:12", "SingZ Mono 400", 11., 0.44, FAINT)
                                        .line_height(13.),
                                ),
                            ),
                    )
                    .child(
                        round_button("transport-loop", self.looping)
                            .child(Self::icon("loop", 14.))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Loop))),
                    )
                    .child(self.output(compact, cx))
                    .child(
                        round_button("transport-met", false)
                            .child(Self::icon("transport-met", 14.))
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Metronome)),
                            ),
                    )
                    .child(
                        round_button("transport-carry", false)
                            .child(Self::icon("transport-carry", 14.))
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(TransportEvent::CarryLine)),
                            ),
                    ),
            )
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .h(px(36.))
                    .min_w(px(668.171875))
                    .flex_shrink_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .child(transport_chip("transport-transpose-down", "−").on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(TransportEvent::Transpose(transpose - 1))
                                }),
                            ))
                            .child(
                                transport_badge(
                                    "transport-transpose-reset",
                                    if transpose > 0 {
                                        format!("+{transpose}")
                                    } else {
                                        transpose.to_string()
                                    },
                                    "st",
                                    transpose != 0,
                                )
                                .cursor_pointer()
                                .on_click(
                                    cx.listener(|_, _, _, cx| {
                                        cx.emit(TransportEvent::Transpose(0))
                                    }),
                                ),
                            )
                            .child(transport_chip("transport-transpose-up", "+").on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(TransportEvent::Transpose(transpose + 1))
                                }),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .child(transport_chip("transport-tempo-down", "−").on_click(
                                cx.listener(move |this, _, _, cx| {
                                    this.tempo = (tempo - 0.05).max(0.25);
                                    cx.emit(TransportEvent::Tempo(this.tempo));
                                    cx.notify();
                                }),
                            ))
                            .child(
                                transport_badge(
                                    "transport-tempo-reset",
                                    format!("{}", (tempo * 100.).round() as u32),
                                    "%",
                                    (tempo - 1.).abs() > 0.001,
                                )
                                .cursor_pointer()
                                .on_click(cx.listener(
                                    |this, _, _, cx| {
                                        this.tempo = 1.;
                                        cx.emit(TransportEvent::Tempo(1.));
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                transport_chip("transport-tempo-up", "+").on_click(cx.listener(
                                    move |this, _, _, cx| {
                                        this.tempo = (tempo + 0.05).min(2.);
                                        cx.emit(TransportEvent::Tempo(this.tempo));
                                        cx.notify();
                                    },
                                )),
                            )
                            .child(
                                transport_chip("transport-bpm-down", "−")
                                    .opacity(0.35)
                                    .cursor_default(),
                            )
                            .child(disabled_bpm_field("transport-bpm"))
                            .child(
                                transport_chip("transport-bpm-up", "+")
                                    .opacity(0.35)
                                    .cursor_default(),
                            ),
                    )
                    .child(
                        karaoke_pill("transport-karaoke", "", self.karaoke)
                            .child(Self::icon("transport-mic", 13.))
                            .child(tracked_label("Karaoke", 0.01))
                            .on_click(cx.listener(|this, _, _, cx| {
                                this.karaoke = !this.karaoke;
                                cx.emit(TransportEvent::Karaoke);
                                cx.notify();
                            })),
                    )
                    .child(
                        div()
                            .relative()
                            .child(
                                split_pill("transport-split", "Split")
                                    .child(Self::icon("transport-chevron", 8.))
                                    .on_click(cx.listener(|this, _, _, cx| {
                                        this.split_open = !this.split_open;
                                        cx.notify();
                                    })),
                            )
                            .when(self.split_open, |v| {
                                v.child(
                                    deferred(
                                        modal_card()
                                            .absolute()
                                            .bottom_full()
                                            .right_0()
                                            .mb(px(10.))
                                            .w(px(220.))
                                            .p(px(14.))
                                            .child(
                                                Self::mono("Separation engine is not connected.")
                                                    .text_size(px(11.)),
                                            ),
                                    )
                                    .with_priority(120),
                                )
                            }),
                    )
                    .child(
                        ghost_pill("transport-stem-files", "Stem files").on_click(
                            cx.listener(|_, _, _, cx| cx.emit(TransportEvent::StemFiles)),
                        ),
                    ),
            )
    }
}

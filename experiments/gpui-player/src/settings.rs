//! Settings composition mirrors SettingsModal.tsx; all draft state remains local.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DANGER, DIM, FAINT, LINE, LINE_STRONG, PANEL, PANEL_DEEP, TEXT};
use singz_uikit::{
    checkbox, disabled_monitor_pill, ghost_pill, modal_card, monitor_badge, nav_tab,
    production_scrollbar, range_slider, select_field, select_option, select_popup,
};

pub enum SettingsEvent {
    Close,
    QuickStart,
}
impl EventEmitter<SettingsEvent> for SettingsScreen {}

pub struct SettingsScreen {
    output: usize,
    input: usize,
    channel: usize,
    monitor_output: usize,
    output_channels: [usize; 2],
    native_playback: bool,
    headphones: bool,
    gain: f32,
    open_field: Option<&'static str>,
    review_fixture: bool,
    scroll: ScrollHandle,
    graph_scroll: ScrollHandle,
    #[cfg(feature = "ui-tests")]
    gain_bounds: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
}
const OUTPUTS: &[&str] = &["System default", "MacBook Pro speakers", "Studio interface"];
const INPUTS: &[&str] = &[
    "System default",
    "MacBook Pro microphone",
    "Studio interface · 2 ch",
];
const MONITOR_OUTPUTS: &[&str] = &["Choose playback device…", "Studio interface · 2 out · USB"];

impl SettingsScreen {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {
            output: 0,
            input: 0,
            channel: 0,
            monitor_output: 0,
            output_channels: [0, 1],
            native_playback: true,
            headphones: false,
            gain: -18.,
            open_field: None,
            review_fixture: false,
            scroll: ScrollHandle::new(),
            graph_scroll: ScrollHandle::new(),
            #[cfg(feature = "ui-tests")]
            gain_bounds: Default::default(),
        }
    }
    /// The capture runner supplies the same sample inventory and startup state to both apps.
    /// This changes display metadata only; it never starts hardware or an asynchronous job.
    #[cfg(feature = "ui-tests")]
    pub fn set_review_fixture(&mut self, enabled: bool) {
        self.review_fixture = enabled;
    }
    #[cfg(feature = "ui-tests")]
    pub fn smoke_snapshot(&self) -> (usize, bool, f32, f32, Option<&'static str>) {
        (
            self.output,
            self.native_playback,
            self.gain,
            f32::from(self.scroll.offset().y),
            self.open_field,
        )
    }
    #[cfg(feature = "ui-tests")]
    pub fn smoke_gain_bounds(&self) -> Option<Bounds<Pixels>> {
        self.gain_bounds.get()
    }
    /// A production modal mounts fresh when reopened: reset transient scroll/menu state,
    /// retaining the host-owned audio draft preferences.
    pub fn on_open(&mut self, cx: &mut Context<Self>) {
        self.open_field = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.graph_scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        if self.open_field.take().is_some() {
            cx.notify();
            true
        } else {
            false
        }
    }
    fn label(text: impl Into<SharedString>) -> Div {
        div()
            .mt(px(14.))
            .mb(px(6.))
            .text_size(px(12.))
            .line_height(px(14.))
            .text_color(rgb(DIM))
            .child(text.into())
    }
    fn hint(text: impl Into<SharedString>) -> Div {
        div()
            .mt(px(8.))
            .text_size(px(13.5))
            .line_height(px(22.275))
            .text_color(rgb(DIM))
            .child(text.into())
    }
    fn mono(text: impl Into<SharedString>) -> Div {
        div()
            .font_family("SingZ Mono 400")
            .text_size(px(10.))
            .line_height(px(14.))
            .text_color(rgb(FAINT))
            .child(text.into())
    }
    fn strip(padding: f32) -> Div {
        div()
            .mt(px(14.))
            .p(px(padding))
            .rounded(px(11.))
            .border_1()
            .border_color(rgba(LINE))
            .bg(rgb(PANEL_DEEP).alpha(if padding == 12. { 0.84 } else { 0.88 }))
    }
    fn field(
        &self,
        id: &'static str,
        options: &'static [&'static str],
        selected: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let expanded = self.open_field == Some(id);
        div()
            .relative()
            .w_full()
            .child(select_field(id, options[selected]).on_click(cx.listener(
                move |this, _, _, cx| {
                    this.open_field = if this.open_field == Some(id) {
                        None
                    } else {
                        Some(id)
                    };
                    cx.notify();
                },
            )))
            .when(expanded, |v| {
                v.child(
                    deferred(select_popup().children(options.iter().enumerate().map(
                        |(index, &option)| {
                            select_option((id, index), option, index == selected).on_click(
                                cx.listener(move |this, _, _, cx| {
                                    match id {
                                        "settings-output" => this.output = index,
                                        "settings-input" => {
                                            this.input = index;
                                            this.channel = 0;
                                        }
                                        "settings-channel" => this.channel = index,
                                        "settings-monitor-output" => this.monitor_output = index,
                                        "settings-output-left" => this.output_channels[0] = index,
                                        "settings-output-right" => this.output_channels[1] = index,
                                        _ => {}
                                    }
                                    this.open_field = None;
                                    cx.notify();
                                }),
                            )
                        },
                    )))
                    .with_priority(100),
                )
            })
    }
    fn check_row(
        &self,
        id: &'static str,
        label: &'static str,
        on: bool,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        div()
            .id(format!("{id}-row"))
            .mt(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .text_color(rgb(DIM))
            .text_size(px(12.))
            .line_height(px(15.))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                match id {
                    "settings-native" => this.native_playback = !this.native_playback,
                    _ => this.headphones = !this.headphones,
                }
                cx.notify();
            }))
            .child(
                checkbox(id, on).on_click(cx.listener(move |this, _, _, cx| {
                    match id {
                        "settings-native" => this.native_playback = !this.native_playback,
                        _ => this.headphones = !this.headphones,
                    }
                    cx.notify();
                })),
            )
            .child(label)
    }
    fn mic(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let stereo = self.input == 2;
        Self::strip(12.)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(Self::label("Microphone").mt(px(0.)).mb(px(7.)))
                    .when(self.input > 0, |v| {
                        v.child(
                            Self::mono(format!(
                                "IN {}/{}",
                                self.channel + 1,
                                if stereo { 2 } else { 1 }
                            ))
                            .text_color(rgb(ACCENT)),
                        )
                    }),
            )
            .child(self.field("settings-input", INPUTS, self.input, cx))
            .child(
                div()
                    .mt(px(9.))
                    .min_h(px(32.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(rgb(if stereo { DIM } else { FAINT }))
                    .child(if stereo {
                        "Input channel"
                    } else {
                        "Mono input · channel 1"
                    })
                    .when(stereo, |v| {
                        v.child(div().w(px(142.)).child(self.field(
                            "settings-channel",
                            &["IN 1", "IN 2"],
                            self.channel,
                            cx,
                        )))
                    }),
            )
            .child(
                div()
                    .mt(px(13.))
                    .flex()
                    .justify_between()
                    .text_color(rgb(DIM))
                    .text_size(px(11.))
                    .line_height(px(13.))
                    .child("Input level")
                    .child(
                        Self::mono(if self.review_fixture {
                            "Starting microphone preview…"
                        } else {
                            "Microphone capture unavailable"
                        })
                        .line_height(px(12.)),
                    ),
            )
            .child(
                div()
                    .relative()
                    .mt(px(7.))
                    .h(px(22.))
                    .rounded(px(5.))
                    .overflow_hidden()
                    .bg(rgb(0x0c0b09))
                    .border_1()
                    .border_color(rgba(LINE_STRONG))
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(relative(0.6666))
                            .right(relative(0.1667))
                            .bg(rgb(0xffb44b).alpha(0.06)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(relative(0.8333))
                            .right_0()
                            .bg(rgb(0xff624c).alpha(0.08)),
                    )
                    .children([(0.3333, "−48"), (0.6666, "−24"), (0.8333, "−12")].map(
                        |(x, label)| {
                            Self::mono(label)
                                .absolute()
                                .top(px(2.))
                                .bottom(px(2.))
                                .left(relative(x))
                                .pl(px(2.))
                                .text_size(px(8.))
                                .line_height(px(18.))
                                .text_color(rgba(0xf3e6cd61))
                                .border_l_1()
                                .border_color(rgba(0xffffff14))
                        },
                    ))
                    .child(
                        div()
                            .absolute()
                            .left_0()
                            .top(px(3.))
                            .bottom(px(3.))
                            .w(px(1.))
                            .bg(rgb(0xf6dca9).alpha(0.9)),
                    )
                    .child(
                        Self::mono("0")
                            .text_color(rgba(0xf3e6cd61))
                            .absolute()
                            .top(px(2.))
                            .right(px(2.))
                            .text_size(px(8.))
                            .line_height(px(18.)),
                    ),
            )
            .child(
                Self::mono(if self.review_fixture {
                    "Microphone preview is opening."
                } else {
                    "Native microphone capture unavailable: desktop audio service is not connected."
                })
                .mt(px(6.))
                .min_h(px(16.)),
            )
    }
    fn graph(&self) -> impl IntoElement + use<> {
        let vertical_scroll = self.scroll.clone();
        let horizontal_scroll = self.graph_scroll.clone();
        let nodes = [
            (
                "DEVICE",
                "Input",
                if self.input > 0 {
                    format!("IN {}", self.channel + 1)
                } else {
                    "IN —".into()
                },
                "Choose an input",
            ),
            ("ANALYZER", "Pre", "RMS".into(), "−∞ dBFS"),
            (
                "PROCESSOR",
                "Gain",
                format!("{}", self.gain as i32),
                "dB · ramped",
            ),
            (
                "ROUTER",
                "Map",
                if self.input > 0 && self.monitor_output > 0 {
                    "1→2".into()
                } else {
                    "— → —".into()
                },
                "IN — to OUT —",
            ),
            (
                "PROCESSOR",
                "Limit",
                "−1 dB".into(),
                "Output ceiling · dBFS",
            ),
            ("ANALYZER", "Post", "RMS".into(), "−∞ dBFS"),
            (
                "DEVICE",
                "Output",
                if self.monitor_output > 0 {
                    "OUT 1·2".into()
                } else {
                    "OUT —".into()
                },
                "Choose an output",
            ),
        ];
        div()
            .mt(px(12.))
            .rounded(px(9.))
            .overflow_hidden()
            .border_1()
            .border_color(rgba(LINE_STRONG))
            .bg(rgb(0x110f0c))
            .child(
                div()
                    .min_h(px(56.))
                    .px(px(10.))
                    .py(px(8.))
                    .border_b_1()
                    .border_color(rgba(LINE))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .child(
                                div()
                                    .child(
                                        div()
                                            .font_family("SingZ Mono 400")
                                            .text_color(rgb(FAINT))
                                            .text_size(px(7.))
                                            .line_height(px(7.))
                                            .child(singz_uikit::tracked_label(
                                                "RUNTIME GRAPH",
                                                0.11,
                                            )),
                                    )
                                    .child(
                                        div()
                                            .mt(px(3.))
                                            .font_family("SingZ Display 700")
                                            .text_size(px(11.))
                                            .line_height(px(13.))
                                            .child(singz_uikit::tracked_label(
                                                "Native monitor chain",
                                                0.01,
                                            )),
                                    ),
                            )
                            .child(Self::mono("●  Route blocked").text_size(px(8.))),
                    )
                    .child(div().mt(px(12.)).flex().gap(px(4.)).children(
                        ["Float32 native path", "Buffer pending", "32-bit float"].map(|text| {
                            div()
                                .font_family("SingZ Mono 400")
                                .text_color(rgb(FAINT))
                                .child(singz_uikit::tracked_label(text, 0.02))
                                .text_size(px(7.))
                                .line_height(px(7.))
                                .px(px(5.))
                                .py(px(3.))
                                .border_1()
                                .border_color(rgba(LINE))
                                .rounded(px(3.))
                                .bg(rgb(PANEL))
                        }),
                    )),
            )
            .child(
                div()
                    .id("settings-graph-scroll")
                    .overflow_x_scroll()
                    .restrict_scroll_to_axis()
                    .track_scroll(&self.graph_scroll)
                    .on_scroll(move |event, window, cx| {
                        let delta = event.delta.pixel_delta(window.line_height());
                        if delta.y.abs() > delta.x.abs() {
                            if event.modifiers.shift {
                                let offset = horizontal_scroll.offset();
                                horizontal_scroll.set_offset(point(offset.x + delta.y, offset.y));
                            } else {
                                let offset = vertical_scroll.offset();
                                vertical_scroll.set_offset(point(offset.x, offset.y + delta.y));
                            }
                            window.refresh();
                            cx.stop_propagation();
                        }
                    })
                    .p(px(12.))
                    .child(div().min_w(px(648.)).flex().gap(px(10.)).children(
                        nodes.into_iter().enumerate().map(
                            |(index, (kind, name, value, detail))| {
                                div()
                                    .relative()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .min_h(px(108.))
                                    .px(px(8.))
                                    .pt(px(10.))
                                    .pb(px(9.))
                                    .flex()
                                    .flex_col()
                                    .rounded(px(6.))
                                    .border_1()
                                    .border_color(rgba(LINE))
                                    .bg(rgb(PANEL))
                                    .child(
                                        div()
                                            .font_family("SingZ Mono 400")
                                            .text_color(rgb(FAINT))
                                            .text_size(px(7.))
                                            .line_height(px(7.))
                                            .child(singz_uikit::tracked_label(kind, 0.1)),
                                    )
                                    .child(
                                        div()
                                            .mt(px(5.))
                                            .text_size(px(10.))
                                            .line_height(px(11.5))
                                            .font_family("SingZ Display 700")
                                            .text_color(rgb(DIM))
                                            .child(name),
                                    )
                                    .child(
                                        Self::mono(value)
                                            .font_family("SingZ Mono 700")
                                            .mt(px(5.))
                                            .text_size(px(10.))
                                            .line_height(px(11.5))
                                            .text_color(rgb(TEXT)),
                                    )
                                    .child(
                                        Self::mono(detail)
                                            .mt_auto()
                                            .pt(px(7.))
                                            .text_size(px(7.))
                                            .line_height(px(9.1)),
                                    )
                                    .when(index < 6, |v| {
                                        v.child(
                                            div()
                                                .absolute()
                                                .left_full()
                                                .top(relative(0.5))
                                                .w(px(10.))
                                                .h(px(1.))
                                                .bg(rgba(LINE_STRONG)),
                                        )
                                    })
                            },
                        ),
                    )),
            )
    }
    fn monitor(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let weak = cx.entity().downgrade();
        let gain_slider = range_slider(
            "settings-monitor-gain",
            self.gain,
            -60.,
            0.,
            move |value, _window, cx| {
                let _ = weak.update(cx, |this, cx| {
                    this.gain = value.round();
                    cx.notify();
                });
            },
        )
        .flex_1()
        .min_w(px(100.));
        #[cfg(feature = "ui-tests")]
        let gain_slider = {
            let probe = self.gain_bounds.clone();
            gain_slider.child(
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
        Self::strip(14.)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_start()
                    .gap(px(16.))
                    .child(
                        div()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .line_height(px(15.5))
                                    .font_family("SingZ Display 700")
                                    .child(
                                        singz_uikit::tracked_label("Headphone monitoring", 0.01)
                                            .wrap(),
                                    ),
                            )
                            .child(
                                Self::hint("Hear this mic through the native DSP graph")
                                    .mt(px(3.))
                                    .text_size(px(11.))
                                    .line_height(px(13.))
                                    .text_color(rgb(FAINT)),
                            ),
                    )
                    .child(monitor_badge("EXPERIMENTAL")),
            )
            .child(Self::label("Audio interface playback").mt(px(13.)))
            .child(self.field(
                "settings-monitor-output",
                MONITOR_OUTPUTS,
                self.monitor_output,
                cx,
            ))
            .when(self.input == 2, |v| {
                v.child(
                    div()
                        .mt(px(12.))
                        .flex()
                        .gap(px(8.))
                        .child(
                            div()
                                .flex_1()
                                .p(px(8.))
                                .rounded(px(8.))
                                .border_1()
                                .border_color(rgba(LINE))
                                .bg(rgb(PANEL))
                                .child(Self::mono("MIC CHANNEL").text_size(px(9.)))
                                .child(
                                    Self::mono(format!("IN {}", self.channel + 1))
                                        .text_color(rgb(ACCENT))
                                        .line_height(px(28.)),
                                ),
                        )
                        .when(self.monitor_output > 0, |v| {
                            v.children(
                                [
                                    (0, "Playback L", "settings-output-left"),
                                    (1, "Playback R", "settings-output-right"),
                                ]
                                .map(|(slot, label, id)| {
                                    div()
                                        .flex_1()
                                        .min_w(px(0.))
                                        .p(px(8.))
                                        .rounded(px(8.))
                                        .border_1()
                                        .border_color(rgba(LINE))
                                        .bg(rgb(PANEL))
                                        .child(Self::mono(label).text_size(px(9.)).mb(px(5.)))
                                        .child(self.field(
                                            id,
                                            &["OUT 1", "OUT 2"],
                                            self.output_channels[slot],
                                            cx,
                                        ))
                                }),
                            )
                        }),
                )
            })
            .child(self.graph())
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .text_size(px(11.))
                    .line_height(px(13.))
                    .text_color(rgb(DIM))
                    .child("Monitor gain")
                    .child(gain_slider)
                    .child(
                        Self::mono(format!("{} dB", self.gain as i32))
                            .line_height(px(10.))
                            .w(px(56.))
                            .text_right()
                            .text_color(rgb(TEXT)),
                    ),
            )
            // .modal-card p wins specificity over .monitor-route-status.
            // Preserve its bottom margin; CSS collapses it with the next row's 10px margin.
            .child(
                Self::hint(if self.review_fixture {
                    "Headphone monitoring is not available on this desktop platform yet."
                } else {
                    "Choose physical input and output channels that are available on this device."
                })
                .mt(px(10.))
                .mb(px(14.))
                .text_color(rgb(if self.review_fixture { DANGER } else { FAINT })),
            )
            .child(self.check_row(
                "settings-headphones",
                "Wired headphones are connected to this device",
                self.headphones,
                cx,
            ))
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child(disabled_monitor_pill(
                        "settings-monitor-start",
                        "Start monitoring",
                    ))
                    .child(
                        Self::hint(if self.review_fixture {
                            "Monitoring is off."
                        } else {
                            "Native audio service is not connected."
                        })
                        .mt(px(0.))
                        .mb(px(14.))
                        .text_color(rgb(FAINT)),
                    ),
            )
    }
    // CSS color-mix(in srgb, var(--danger) 52%, var(--line)).
    // The shared line token includes the browser's 8-bit alpha precision.
    fn recovery_border() -> Rgba {
        let danger = rgb(DANGER);
        let line = rgba(LINE);
        let line_weight = line.a * 0.48;
        let alpha = 0.52 + line_weight;
        Rgba {
            r: (danger.r * 0.52 + line.r * line_weight) / alpha,
            g: (danger.g * 0.52 + line.g * line_weight) / alpha,
            b: (danger.b * 0.52 + line.b * line_weight) / alpha,
            a: alpha,
        }
    }
    fn audio(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        div().w_full().child(Self::label("Playback device").mt(px(2.)))
            .child(self.field("settings-output",OUTPUTS,self.output,cx))
            .child(div().mt(px(9.)).px(px(11.)).py(px(10.)).rounded(px(9.)).border_1().border_color(Self::recovery_border()).bg(Rgba { r:0.124706,g:0.080902,b:0.0617255,a:1. })
                .child(Self::hint("Playback route could not be confirmed — choose an output or retry").mt(px(0.)).text_color(rgb(DANGER)))
                .child(div().mt(px(8.)).flex().items_center().gap(px(10.)).child(ghost_pill("settings-retry","Retry output route").opacity(if self.review_fixture {1.}else{0.4}))))
            .child(self.check_row("settings-native","Use native DSP playback",self.native_playback,cx))
            .child(Self::hint("Uses the selected native provider when the song's features exactly match the native graph."))
            .child(self.mic(cx)).child(self.monitor(cx))
    }
}
impl Render for SettingsScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        div()
            .size_full()
            .p(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_size(px(13.))
            .text_color(rgb(TEXT))
            .child(
                modal_card()
                    .w_full()
                    .max_w(px(960.))
                    .h_full()
                    .min_h(px(0.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(21.))
                            .line_height(px(25.))
                            .font_family("SingZ Display 800")
                            .mb(px(12.))
                            .child("Settings"),
                    )
                    .child(
                        ghost_pill("settings-quick-start", "Quick start")
                            .flex_shrink_0()
                            .w_full()
                            .justify_start()
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::QuickStart)),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.))
                            .flex()
                            .gap(px(20.))
                            .mt(px(6.))
                            .child(
                                div()
                                    .w(px(108.))
                                    .flex_shrink_0()
                                    .pr(px(14.))
                                    .border_r_1()
                                    .border_color(rgba(LINE))
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(nav_tab("settings-tab-audio", "Audio", true)),
                            )
                            .child(
                                div()
                                    .relative()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .h_full()
                                    .child(
                                        div()
                                            .id("settings-scroll")
                                            .size_full()
                                            .overflow_y_scroll()
                                            .track_scroll(&self.scroll)
                                            .pr(px(10.))
                                            .child(self.audio(cx)),
                                    )
                                    .child(production_scrollbar(&self.scroll)),
                            ),
                    )
                    .child(
                        div()
                            .mt(px(20.))
                            .flex_shrink_0()
                            .flex()
                            .gap(px(10.))
                            .child(ghost_pill("settings-close", "Close").on_click(
                                cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Close)),
                            )),
                    ),
            )
    }
}

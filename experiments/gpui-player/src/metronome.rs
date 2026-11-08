//! Source MetPopover, controlled by accepted native project state.
use crate::beat::{Beats, METERS, Metronome, tap_bpm};
use crate::i18n::{t, tn, tv};
use gpui_kit::{
    component::input::{InputEvent, InputState},
    prelude::FluentBuilder,
    *,
};
use singz_uikit::{self as ui, tokens::*};
use std::{cell::RefCell, collections::HashMap, rc::Rc, time::Instant};
#[derive(Clone)]
pub enum Event {
    Change(Metronome, Option<Beats>),
    Preview(bool),
    FocusPlayer,
    Close,
    Redetect,
}
pub struct MetPopover {
    pub met: Metronome,
    pub grid: Option<Beats>,
    position: f64,
    duration: f64,
    can_detect: bool,
    input: Entity<InputState>,
    draft: bool,
    refresh_input: bool,
    taps: Vec<f64>,
    clock: Instant,
    pub trigger: Option<Bounds<Pixels>>,
    pub bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    _input: Subscription,
}
impl EventEmitter<Event> for MetPopover {}
impl MetPopover {
    pub fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(w, cx));
        let subscription = cx.subscribe_in(&input, w, |s, _, event, w, cx| match event {
            InputEvent::Change => {
                if s.focused(w, cx) {
                    s.draft = true;
                    let raw = s.input.read(cx).value().to_string();
                    let clean: String = raw
                        .chars()
                        .filter(|c| c.is_ascii_digit() || *c == '.')
                        .collect();
                    if clean != raw {
                        s.input
                            .update(cx, |state, cx| state.set_value(clean, w, cx));
                    }
                }
            }
            InputEvent::Focus => s.input.update(cx, |state, cx| state.select_all(w, cx)),
            InputEvent::PressEnter { .. } => {
                s.commit(w, cx);
                cx.emit(Event::FocusPlayer);
            }
            InputEvent::Blur => s.commit(w, cx),
            _ => {}
        });
        Self {
            met: Default::default(),
            grid: None,
            position: 0.,
            duration: 0.,
            can_detect: false,
            input,
            draft: false,
            refresh_input: true,
            taps: vec![],
            clock: Instant::now(),
            trigger: None,
            bounds: Default::default(),
            _input: subscription,
        }
    }
    pub fn adopt(&mut self, met: Metronome, grid: Option<Beats>, cx: &mut Context<Self>) {
        self.met = met;
        self.grid = grid;
        self.refresh_input = true;
        cx.notify();
    }
    pub fn focused(&self, w: &Window, cx: &App) -> bool {
        self.input.read(cx).focus_handle(cx).is_focused(w)
    }
    pub fn set(
        &mut self,
        met: Metronome,
        grid: Option<Beats>,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        self.met = met;
        self.grid = grid;
        if !self.focused(w, cx) {
            self.reset_input(w, cx);
        }
        cx.notify();
    }
    pub fn context(&mut self, position: f32, duration: f32) {
        self.position = position as f64;
        self.duration = duration as f64;
    }
    pub fn set_can_detect(&mut self, can_detect: bool, cx: &mut Context<Self>) {
        if self.can_detect != can_detect {
            self.can_detect = can_detect;
            cx.notify();
        }
    }
    pub fn input(&self) -> Entity<InputState> {
        self.input.clone()
    }
    pub fn caption(&self) -> String {
        if let Some(g) = &self.grid {
            tv(
                "player.metronome.gridCaption",
                &[
                    ("bpm", ((g.bpm * 10.).round() / 10.).to_string()),
                    (
                        "source",
                        t(if g.source == "auto" {
                            "player.metronome.sourceAuto"
                        } else {
                            "player.metronome.sourceManual"
                        }),
                    ),
                ],
            )
        } else if !self.taps.is_empty() && self.taps.len() < 3 {
            t("player.metronome.tapHint")
        } else {
            t(if self.can_detect {
                "player.metronome.noBeatCanDetect"
            } else {
                "player.metronome.noBeatCannotDetect"
            })
        }
    }
    fn reset_input(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        let value = self
            .grid
            .as_ref()
            .map_or("—".into(), |g| format!("{}", (g.bpm * 10.).round() / 10.));
        self.input.update(cx, |s, cx| s.set_value(value, w, cx));
        self.draft = false;
    }
    pub fn commit(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.draft {
            let value = self.input.read(cx).value().to_string();
            if let Ok(n) = value.parse::<f64>() {
                if n.is_finite() && (30. ..=300.).contains(&n) {
                    if let Ok(g) = Beats::constant(
                        n,
                        self.position,
                        self.duration,
                        self.grid.as_ref().map_or(4, |g| g.beats_per_bar),
                    ) {
                        self.grid = Some(g);
                        cx.emit(Event::Change(self.met.clone(), self.grid.clone()));
                    }
                }
            }
            self.draft = false;
        }
        self.reset_input(w, cx);
    }
    pub fn cancel(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.draft = false;
        self.reset_input(w, cx);
    }
    fn finish_draft(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.focused(w, cx) {
            self.commit(w, cx);
            cx.emit(Event::FocusPlayer);
        }
    }
    fn emit(&self, cx: &mut Context<Self>) {
        cx.emit(Event::Change(self.met.clone(), self.grid.clone()));
        cx.notify();
    }
    fn choose(&mut self, key: &str, n: usize, cx: &mut Context<Self>) {
        match key {
            "click" => self.met.click = n == 1,
            "accent" => self.met.accent = n == 0,
            "grid" => self.met.grid = n == 1,
            "count" => self.met.count_in_bars = n as u32,
            "meter" => {
                if let Some(g) = &self.grid {
                    self.grid = g.uniform_meter(METERS[n], false).ok();
                }
            }
            _ => {}
        }
        self.emit(cx);
    }
    fn probe(&self, id: &str, d: Stateful<Div>) -> Stateful<Div> {
        let bounds = self.bounds.clone();
        let id = id.to_owned();
        d.relative().child(
            canvas(
                move |b, _, _| {
                    bounds.borrow_mut().insert(id.clone(), b);
                    b
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
    fn segment(
        &self,
        key: &'static str,
        labels: &[&str],
        selected: usize,
        enabled: &[bool],
        cx: &mut Context<Self>,
    ) -> Div {
        ui::mode_group().children(labels.iter().enumerate().map(|(i, label)| {
            self.probe(
                &format!("met-{key}-{i}"),
                ui::mode_option(
                    format!("met-{key}-{i}"),
                    (*label).to_owned(),
                    selected == i,
                    enabled[i],
                    i == 0,
                    i + 1 == labels.len(),
                )
                .on_click(cx.listener(move |s, _, w, cx| {
                    s.finish_draft(w, cx);
                    if enabled_for(key, i, s) {
                        s.choose(key, i, cx);
                    }
                })),
            )
        }))
    }
    fn chip(
        &self,
        id: &'static str,
        label: &'static str,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.probe(
            id,
            ui::metronome_chip(id, label, enabled).on_click(cx.listener(move |s, _, w, cx| {
                if !enabled {
                    return;
                }
                s.finish_draft(w, cx);
                if let Some(g) = &s.grid {
                    s.grid = Some(match id {
                        "met-half" => g.half(),
                        "met-double" => g.double(),
                        "met-earlier" => g.shift(-0.01),
                        "met-later" => g.shift(0.01),
                        _ => g.uniform_meter(g.beats_per_bar, true).unwrap(),
                    });
                    s.emit(cx);
                }
            })),
        )
    }
}
fn enabled_for(key: &str, i: usize, s: &MetPopover) -> bool {
    s.grid.is_some() || !matches!(key, "click" | "grid" | "meter") || i == 0 && key != "meter"
}
fn version() -> f64 {
    include_str!("../../../src/renderer/src/audio/analysis-contract.ts")
        .lines()
        .find_map(|l| {
            l.strip_prefix("export const BEAT_DETECT_VERSION = ")?
                .trim()
                .parse()
                .ok()
        })
        .expect("Source beat detector version")
}
impl Render for MetPopover {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.refresh_input && !self.focused(w, cx) {
            self.reset_input(w, cx);
            self.refresh_input = false;
        }
        let has = self.grid.is_some();
        let caption = self.caption();
        let weak = cx.weak_entity();
        ui::transport_popover()
            .id("metronome-popover")
            .w(px(324.))
            .font_family(DISPLAY_400)
            .text_color(rgb(TEXT))
            .on_mouse_down_out(cx.listener(|s, e: &MouseDownEvent, w, cx| {
                if !s.trigger.is_some_and(|b| b.contains(&e.position)) {
                    s.commit(w, cx);
                    cx.emit(Event::Close);
                }
            }))
            .child(
                div()
                    .flex()
                    .items_center()
                    .justify_between()
                    .mb(px(10.))
                    .child(
                        div()
                            .text_size(px(13.))
                            .font_family(DISPLAY_700)
                            .child(t("player.metronome.title")),
                    )
                    .child(self.segment(
                        "click",
                        &[&t("player.toggle.off"), &t("player.toggle.on")],
                        usize::from(self.met.click),
                        &[true, has],
                        cx,
                    )),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.loudness")).child(
                    self.probe(
                        "met-volume",
                        ui::stem_volume(
                            "met-volume",
                            self.met.volume as f32,
                            ACCENT,
                            move |n, w, cx| {
                                let _ = weak.update(cx, |s, cx| {
                                    s.finish_draft(w, cx);
                                    s.met.volume = (n as f64 * 100.).round() / 100.;
                                    s.emit(cx);
                                });
                            },
                        )
                        .on_mouse_up(
                            MouseButton::Left,
                            cx.listener(|s, _, _, cx| cx.emit(Event::Preview(s.met.accent))),
                        ),
                    )
                    .flex_1(),
                ),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.accent")).child(self.segment(
                    "accent",
                    &[&t("player.metronome.accentOn"), &t("player.toggle.off")],
                    usize::from(!self.met.accent),
                    &[true, true],
                    cx,
                )),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.gridView")).child(self.segment(
                    "grid",
                    &[&t("player.toggle.off"), &t("player.metronome.gridViewShow")],
                    usize::from(self.met.grid),
                    &[true, has],
                    cx,
                )),
            )
            .when_some(self.grid.as_ref(), |d, g| {
                let ver = g.det_version.map_or("—".into(), |n| n.to_string());
                let text = if g.source != "auto" {
                    tv("player.metronome.handTuned", &[("ver", ver.clone())])
                } else if g.det_version.unwrap_or(0.) < version() {
                    tv(
                        "player.metronome.staleLabel",
                        &[("saved", ver.clone()), ("current", version().to_string())],
                    )
                } else if g.det_version == Some(version()) {
                    tv("player.metronome.currentLabel", &[("ver", ver.clone())])
                } else {
                    tv("player.metronome.newerLabel", &[("ver", ver.clone())])
                };
                let color = if g.source != "auto" || g.det_version.unwrap_or(0.) > version() {
                    0x7adc96
                } else if g.det_version.unwrap_or(0.) < version() {
                    0xe2a53e
                } else {
                    DIM
                };
                d.child(
                    ui::transport_setting_row(t("player.metronome.gridData"))
                        .child(div().text_size(px(12.)).text_color(rgb(color)).child(text))
                        .when_some(g.user_bars.as_ref().filter(|v| !v.is_empty()), |d, b| {
                            d.child(div().text_size(px(12.)).text_color(rgb(0x7adc96)).child(tn(
                                "player.metronome.userBars",
                                b.len() as f64,
                                &[],
                            )))
                        }),
                )
            })
            .child(
                ui::transport_setting_row(t("player.metronome.countIn")).child(self.segment(
                    "count",
                    &[
                        &t("player.toggle.off"),
                        &t(if has {
                            "player.metronome.oneBar"
                        } else {
                            "player.metronome.threeSec"
                        }),
                        &t(if has {
                            "player.metronome.twoBars"
                        } else {
                            "player.metronome.sixSec"
                        }),
                    ],
                    self.met.count_in_bars as usize,
                    &[true, true, true],
                    cx,
                )),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.tempo"))
                    .child(ui::metronome_bpm_input(&self.input))
                    .child(self.probe(
                        "met-tap",
                        ui::small_ghost_pill("met-tap", t("player.metronome.tap")).on_click(
                            cx.listener(|s, _, w, cx| {
                                s.finish_draft(w, cx);
                                cx.emit(Event::Preview(false));
                                let now = s.clock.elapsed().as_secs_f64();
                                if s.taps.last().is_some_and(|t| now - t > 2.5) {
                                    s.taps.clear();
                                }
                                s.taps.push(now);
                                if s.taps.len() > 12 {
                                    s.taps.remove(0);
                                }
                                if let Some(bpm) = tap_bpm(&s.taps) {
                                    s.grid = Beats::constant(
                                        bpm,
                                        s.position,
                                        s.duration,
                                        s.grid.as_ref().map_or(4, |g| g.beats_per_bar),
                                    )
                                    .ok();
                                    s.emit(cx);
                                }
                                cx.notify();
                            }),
                        ),
                    ))
                    .child(self.chip(
                        "met-half",
                        "½",
                        self.grid.as_ref().is_some_and(|g| g.bpm / 2. >= 30.),
                        cx,
                    ))
                    .child(self.chip(
                        "met-double",
                        "×2",
                        self.grid.as_ref().is_some_and(|g| g.bpm * 2. <= 300.),
                        cx,
                    )),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.beatsPerBar")).child(
                    self.segment(
                        "meter",
                        &["2", "3", "4", "6"],
                        self.grid
                            .as_ref()
                            .and_then(|g| METERS.iter().position(|m| *m == g.beats_per_bar))
                            .unwrap_or(usize::MAX),
                        &[has; 4],
                        cx,
                    ),
                ),
            )
            .child(
                ui::transport_setting_row(t("player.metronome.align"))
                    .child(self.chip("met-earlier", "−10", has, cx))
                    .child(self.chip("met-later", "+10", has, cx))
                    .child(self.chip("met-rotate", "1→", has, cx))
                    .when(self.can_detect, |d| {
                        d.child(
                            self.probe(
                                "met-redetect",
                                ui::small_ghost_pill(
                                    "met-redetect",
                                    t("player.metronome.redetect"),
                                )
                                .on_click(cx.listener(
                                    |s, _, w, cx| {
                                        s.finish_draft(w, cx);
                                        cx.emit(Event::Redetect);
                                    },
                                )),
                            ),
                        )
                    }),
            )
            .child(
                div()
                    .mt(px(8.))
                    .mx(px(2.))
                    .mb(px(10.))
                    .text_size(px(12.))
                    .line_height(px(17.))
                    .text_color(rgb(FAINT))
                    .child(caption),
            )
    }
}

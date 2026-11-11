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
#[derive(Default)]
struct TapSession {
    times: Vec<f64>,
}
impl TapSession {
    fn reset(&mut self) {
        self.times.clear();
    }
    fn collecting(&self) -> bool {
        !self.times.is_empty() && self.times.len() < 3
    }
    fn tap(&mut self, now: f64) -> Option<f64> {
        if self.times.last().is_some_and(|t| now - t > 2.5) {
            self.reset();
        }
        self.times.push(now);
        if self.times.len() > 12 {
            self.times.remove(0);
        }
        tap_bpm(&self.times)
    }
}
pub struct MetPopover {
    pub met: Metronome,
    pub grid: Option<Beats>,
    position: f64,
    duration: f64,
    can_detect: bool,
    input: Entity<InputState>,
    focus_handle: FocusHandle,
    controls: HashMap<&'static str, FocusHandle>,
    draft: bool,
    refresh_input: bool,
    taps: TapSession,
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
            focus_handle: cx.focus_handle(),
            controls: [
                "met-click-0",
                "met-click-1",
                "met-volume",
                "met-accent-0",
                "met-accent-1",
                "met-grid-0",
                "met-grid-1",
                "met-count-0",
                "met-count-1",
                "met-count-2",
                "met-tap",
                "met-half",
                "met-double",
                "met-meter-0",
                "met-meter-1",
                "met-meter-2",
                "met-meter-3",
                "met-earlier",
                "met-later",
                "met-rotate",
                "met-redetect",
            ]
            .into_iter()
            .map(|id| (id, cx.focus_handle().tab_stop(true)))
            .collect(),
            draft: false,
            refresh_input: true,
            taps: TapSession::default(),
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
    /// Match the source popover's fresh local tap history after remounting.
    /// Accepted audio updates use `adopt` and must retain the current session.
    pub fn reset_taps(&mut self, cx: &mut Context<Self>) {
        self.taps.reset();
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn tap_count(&self) -> usize {
        self.taps.times.len()
    }
    pub fn focused(&self, w: &Window, cx: &App) -> bool {
        self.input.read(cx).focus_handle(cx).is_focused(w)
    }
    pub fn volume_focused(&self, w: &Window) -> bool {
        self.controls["met-volume"].is_focused(w)
    }
    fn control_available(&self, id: &str) -> bool {
        match id {
            "met-half" => self.grid.as_ref().is_some_and(|g| g.bpm / 2. >= 30.),
            "met-double" => self.grid.as_ref().is_some_and(|g| g.bpm * 2. <= 300.),
            "met-redetect" => self.can_detect,
            "met-click-1" | "met-grid-1" | "met-earlier" | "met-later" | "met-rotate"
            | "met-meter-0" | "met-meter-1" | "met-meter-2" | "met-meter-3" => self.grid.is_some(),
            _ => true,
        }
    }
    fn recover_removed_focus(&self, w: &mut Window, cx: &mut Context<Self>) {
        if self
            .controls
            .iter()
            .any(|(id, focus)| !self.control_available(id) && focus.is_focused(w))
        {
            // Keep a mounted dispatch path synchronously, including between
            // rapid keys before repaint. This non-tab-stop popup root retains
            // the player's capture/bubble ancestors without stealing focus
            // later from a control reached by a subsequent Tab.
            self.focus_handle.focus(w, cx);
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn focused_control(&self, w: &Window, cx: &App) -> Option<String> {
        if self.focused(w, cx) {
            return Some("met-bpm".into());
        }
        self.controls
            .iter()
            .find(|(_, handle)| handle.is_focused(w))
            .map(|(id, _)| (*id).into())
    }
    /// Controls keep the shared UIKit geometry/ring. This adapter binds the
    /// same metronome action to pointer and keyboard activation.
    fn button(
        &self,
        id: &str,
        enabled: bool,
        control: Stateful<Div>,
        action: impl Fn(&mut Self, &mut Window, &mut Context<Self>) + 'static,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let handle = self.controls[id].clone();
        let pointer = handle.clone();
        let action = Rc::new(action);
        let click = action.clone();
        self.probe(id, control)
            .when(enabled, |control| {
                ui::lyrics_sidebar_focus(control, handle.clone())
                    .track_focus(&handle)
                    .tab_index(0)
                    .on_mouse_down(MouseButton::Left, move |_, w, cx| pointer.focus(w, cx))
            })
            .on_click(cx.listener(move |s, _, w, cx| {
                if enabled {
                    click(s, w, cx);
                    s.recover_removed_focus(w, cx);
                }
            }))
            .capture_key_down(cx.listener(move |s, event: &KeyDownEvent, w, cx| {
                if enabled && matches!(event.keystroke.key.as_str(), "enter" | "space") {
                    w.prevent_default();
                    action(s, w, cx);
                    s.recover_removed_focus(w, cx);
                    cx.stop_propagation();
                }
            }))
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
    pub fn context(&mut self, position: f64, duration: f64) {
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
        } else if self.taps.collecting() {
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
        let focused = self.focused(w, cx);
        if finish_commits(focused, self.draft) {
            self.commit(w, cx);
            if focused {
                cx.emit(Event::FocusPlayer);
            }
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
            let id = format!("met-{key}-{i}");
            self.button(
                &id,
                enabled[i],
                ui::mode_option(
                    id.clone(),
                    (*label).to_owned(),
                    selected == i,
                    enabled[i],
                    i == 0,
                    i + 1 == labels.len(),
                ),
                move |s, w, cx| {
                    s.finish_draft(w, cx);
                    if enabled_for(key, i, s) {
                        s.choose(key, i, cx);
                    }
                },
                cx,
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
        self.button(
            id,
            enabled,
            ui::metronome_chip(id, label, enabled),
            move |s, w, cx| {
                s.finish_draft(w, cx);
                if let Some(g) = &s.grid {
                    // Recheck dynamic bounds for repeated keys before repaint.
                    if id == "met-half" && g.bpm / 2. < 30.
                        || id == "met-double" && g.bpm * 2. > 300.
                    {
                        return;
                    }
                    s.grid = Some(match id {
                        "met-half" => g.half(),
                        "met-double" => g.double(),
                        "met-earlier" => g.shift(-0.01),
                        "met-later" => g.shift(0.01),
                        _ => g.uniform_meter(g.beats_per_bar, true).unwrap(),
                    });
                    s.emit(cx);
                }
            },
            cx,
        )
    }
    fn tap(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        self.finish_draft(w, cx);
        cx.emit(Event::Preview(false));
        let now = self.clock.elapsed().as_secs_f64();
        if let Some(bpm) = self.taps.tap(now) {
            self.grid = Beats::constant(
                bpm,
                self.position,
                self.duration,
                self.grid.as_ref().map_or(4, |g| g.beats_per_bar),
            )
            .ok();
            self.emit(cx);
        }
        cx.notify();
    }
}

/// A button click finishes the BPM draft whether or not the input still holds focus:
/// the mouse-down that precedes the click may already have moved focus, and the Blur
/// that would commit the draft is only delivered to an active window.
fn finish_commits(focused: bool, draft: bool) -> bool {
    focused || draft
}

#[cfg(test)]
mod tests {
    use super::{finish_commits, TapSession};

    #[test]
    fn click_commits_a_pending_draft_after_focus_already_moved() {
        assert!(finish_commits(false, true), "unfocused pending draft must still commit");
        assert!(finish_commits(true, false));
        assert!(finish_commits(true, true));
        assert!(!finish_commits(false, false), "nothing pending, nothing to commit");
    }

    #[test]
    fn reopened_popover_needs_three_fresh_taps() {
        let mut taps = TapSession::default();
        assert_eq!(taps.tap(0.), None);
        assert_eq!(taps.tap(0.5), None);
        assert!(taps.collecting());
        taps.reset();
        assert!(!taps.collecting());
        // Reopen before the normal 2.5-second timeout. Old taps must not
        // produce a tempo or skew this new 150 BPM session.
        assert_eq!(taps.tap(0.8), None);
        assert_eq!(taps.tap(1.2), None);
        assert!((taps.tap(1.6).unwrap() - 150.).abs() < 1e-9);
    }

    #[test]
    fn idle_tap_starts_a_new_session() {
        let mut taps = TapSession::default();
        taps.tap(0.);
        taps.tap(0.5);
        assert_eq!(taps.tap(3.1), None);
        assert!(taps.collecting());
        assert_eq!(taps.times, vec![3.1]);
    }
}
fn enabled_for(key: &str, i: usize, s: &MetPopover) -> bool {
    s.grid.is_some() || !matches!(key, "click" | "grid" | "meter") || i == 0 && key != "meter"
}
fn version() -> f64 {
    crate::beat_analysis::version() as f64
}

impl Render for MetPopover {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.recover_removed_focus(w, cx);
        if self.refresh_input && !self.focused(w, cx) {
            self.reset_input(w, cx);
            self.refresh_input = false;
        }
        let has = self.grid.is_some();
        let caption = self.caption();
        let weak = cx.weak_entity();
        ui::transport_popover()
            .id("metronome-popover")
            .track_focus(&self.focus_handle)
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
                        ui::lyrics_sidebar_focus(
                            ui::stem_volume_with_focus(
                                "met-volume",
                                self.met.volume as f32,
                                ACCENT,
                                self.controls["met-volume"].clone(),
                                move |n, w, cx| {
                                    let _ = weak.update(cx, |s, cx| {
                                        s.finish_draft(w, cx);
                                        s.met.volume = (n as f64 * 100.).round() / 100.;
                                        s.emit(cx);
                                    });
                                },
                            )
                            .aria_label(t("player.metronome.loudness"))
                            .aria_description(t("player.metronome.loudnessTitle"))
                            .on_mouse_up(
                                MouseButton::Left,
                                cx.listener(|s, _, _, cx| cx.emit(Event::Preview(s.met.accent))),
                            ),
                            self.controls["met-volume"].clone(),
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
                    .child(self.button(
                        "met-tap",
                        true,
                        ui::small_ghost_pill("met-tap", t("player.metronome.tap")),
                        |s, w, cx| s.tap(w, cx),
                        cx,
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
                        d.child(self.button(
                            "met-redetect",
                            true,
                            ui::small_ghost_pill("met-redetect", t("player.metronome.redetect")),
                            |s, w, cx| {
                                if s.can_detect {
                                    s.finish_draft(w, cx);
                                    cx.emit(Event::Redetect);
                                }
                            },
                            cx,
                        ))
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

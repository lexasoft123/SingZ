//! Thin accepted-state adapter for the production Carry-the-line popover.
use crate::{
    carry_line::{Desired, Mode},
    i18n::{t, tn, tv},
    tracks::Lane,
};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
};
actions!(singz_carry_line, [NextFocus, PreviousFocus]);
#[derive(Clone, Debug)]
pub enum Event {
    Change(Desired),
    /// The production popover leaves the app's Save shortcut available.
    Save,
    Close,
    /// Escape returns focus to the player; outside dismissal preserves the
    /// control the user just focused.
    CloseKeyboard,
}
pub struct Popover {
    desired: Desired,
    lanes: Vec<Lane>,
    lines_ready: bool,
    pending: bool,
    trigger: Option<Bounds<Pixels>>,
    scroll: ScrollHandle,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    resume_focus: Option<String>,
}
impl EventEmitter<Event> for Popover {}
impl Popover {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZCarryLine")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZCarryLine")),
        ]);
        Self {
            desired: Desired::default(),
            lanes: vec![],
            lines_ready: false,
            pending: false,
            trigger: None,
            scroll: ScrollHandle::new(),
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: true,
            resume_focus: None,
        }
    }
    pub fn context(
        &mut self,
        desired: Desired,
        lanes: Vec<Lane>,
        lines_ready: bool,
        pending: bool,
        cx: &mut Context<Self>,
    ) {
        if self.desired == desired
            && self.lanes == lanes
            && self.lines_ready == lines_ready
            && self.pending == pending
        {
            return;
        }
        if self.pending != pending {
            self.pending_focus = true;
        }
        self.desired = desired;
        self.lanes = lanes;
        self.lines_ready = lines_ready;
        self.pending = pending;
        cx.notify();
    }
    /// Call once when the host opens this popover, never on refresh/render.
    pub fn on_open(&mut self, cx: &mut Context<Self>) {
        self.keyboard.set(false);
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.resume_focus = None;
        self.pending_focus = true;
        cx.notify();
    }
    pub fn set_trigger(&mut self, trigger: Option<Bounds<Pixels>>, cx: &mut Context<Self>) {
        if self.trigger != trigger {
            self.trigger = trigger;
            cx.notify();
        }
    }
    /// Source TrainPopover has no animation; kept explicit for capture adapters.
    pub fn set_animation_time(&mut self, _seconds: Option<f32>, _cx: &mut Context<Self>) {}
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn scroll_viewport(&self) -> Bounds<Pixels> {
        self.scroll.bounds()
    }
    fn bounds_json(b: Bounds<Pixels>) -> serde_json::Value {
        serde_json::json!([
            f32::from(b.left()),
            f32::from(b.top()),
            f32::from(b.size.width),
            f32::from(b.size.height)
        ])
    }
    fn fully_visible(&self, b: Bounds<Pixels>) -> bool {
        let viewport = self.scroll.bounds();
        b.left() >= viewport.left()
            && b.right() <= viewport.right()
            && b.top() >= viewport.top()
            && b.bottom() <= viewport.bottom()
    }
    fn reveal_control(&self, id: &str) {
        if let Some(b) = self.bounds(id) {
            let viewport = self.scroll.bounds();
            let delta = if b.top() < viewport.top() + px(2.) {
                viewport.top() + px(2.) - b.top()
            } else if b.bottom() > viewport.bottom() - px(2.) {
                viewport.bottom() - px(2.) - b.bottom()
            } else {
                px(0.)
            };
            if delta != px(0.) {
                let offset = self.scroll.offset();
                self.scroll.set_offset(point(
                    offset.x,
                    (offset.y + delta).clamp(-self.scroll.max_offset().y, px(0.)),
                ));
            }
        }
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"desired":self.desired,"pending":self.pending,"linesReady":self.lines_ready,"caption":self.caption(),"lanes":self.lanes.iter().map(|l|serde_json::json!({"id":l.id,"label":l.label})).collect::<Vec<_>>(),"focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),"focusInside":self.scope.contains_focused(w,cx),"focusOrder":self.order.borrow().clone(),"keyboardFocus":self.keyboard.get(),"animation":"none in source","cardBounds":self.bounds("carry-card").map(Self::bounds_json),"triggerBounds":self.trigger.map(Self::bounds_json),"scrollViewport":Self::bounds_json(self.scroll.bounds()),"scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],"scrollMax":[f32::from(self.scroll.max_offset().x),f32::from(self.scroll.max_offset().y)],"controlBounds":self.bounds.borrow().iter().filter(|(id,_)|id.as_str()!="carry-card"&&id.as_str()!="carry-content").map(|(id,b)|(id.clone(),Self::bounds_json(*b))).collect::<HashMap<_,_>>(),"controlVisible":self.bounds.borrow().iter().filter(|(id,_)|id.as_str()!="carry-card"&&id.as_str()!="carry-content").map(|(id,b)|(id.clone(),self.fully_visible(*b))).collect::<HashMap<_,_>>(),"tooltips":self.lanes.iter().enumerate().map(|(i,lane)|(format!("carry-lane-{i}"),lane.label.clone())).collect::<HashMap<_,_>>(),"overflowPolicy":"native bounded scrolling and label ellipsis; source parity unqualified"})
    }
    fn caption(&self) -> String {
        let c = &self.desired.config;
        match c.mode {
            Mode::Time => tv(
                "player.training.captionTime",
                &[("sec", c.period_sec.to_string())],
            ),
            Mode::Lines if self.lines_ready => tn(
                "player.training.captionLines",
                c.hear as f64,
                &[("sing", c.sing.to_string())],
            ),
            Mode::Lines => t("player.training.captionNoLyrics"),
        }
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.pending {
            return;
        }
        let mut desired = self.desired.clone();
        let c = &mut desired.config;
        match id {
            "carry-off" => desired.enabled = false,
            "carry-on" => desired.enabled = true,
            "carry-time" => c.mode = Mode::Time,
            "carry-lines" => c.mode = Mode::Lines,
            "carry-period-minus" => c.period_sec = c.period_sec.saturating_sub(5).max(5),
            "carry-period-plus" => c.period_sec = (c.period_sec + 5).min(60),
            "carry-hear-minus" => c.hear = c.hear.saturating_sub(1).max(1),
            "carry-hear-plus" => c.hear = (c.hear + 1).min(8),
            "carry-sing-minus" => c.sing = c.sing.saturating_sub(1).max(1),
            "carry-sing-plus" => c.sing = (c.sing + 1).min(8),
            _ => {
                let Some(i) = id
                    .strip_prefix("carry-lane-")
                    .and_then(|s| s.parse::<usize>().ok())
                else {
                    return;
                };
                let Some(lane) = self.lanes.get(i) else {
                    return;
                };
                if c.stems.contains(&lane.id) {
                    if c.stems.len() == 1 {
                        return;
                    }
                    c.stems.retain(|id| id != &lane.id);
                } else {
                    c.stems.push(lane.id.clone());
                }
            }
        }
        if desired != self.desired {
            self.resume_focus = Some(id.to_owned());
            self.pending_focus = true;
            self.pending = true;
            cx.emit(Event::Change(desired));
            cx.notify();
        }
    }
    fn traverse(&mut self, back: bool, w: &mut Window, cx: &mut Context<Self>) {
        let order = self.order.borrow();
        let current = order.iter().position(|id| {
            self.controls
                .borrow()
                .get(id)
                .is_some_and(|f| f.is_focused(w))
        });
        let i = match current {
            Some(i) if back => (i + order.len() - 1) % order.len(),
            Some(i) => (i + 1) % order.len(),
            None => {
                if back {
                    order.len().saturating_sub(1)
                } else {
                    0
                }
            }
        };
        self.keyboard.set(true);
        if let Some(f) = order
            .get(i)
            .and_then(|id| self.controls.borrow().get(id).cloned())
        {
            f.focus(w, cx);
            if let Some(id) = order.get(i) {
                self.reveal_control(id);
            }
        } else {
            self.scope.focus(w, cx);
        }
        cx.notify();
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        let command = if cfg!(target_os = "macos") {
            e.keystroke.modifiers.platform
        } else {
            e.keystroke.modifiers.control
        };
        // Save remains available with the popover open, including while a
        // native Carry transaction is pending. The host queues it as needed.
        if command && e.keystroke.key == "s" {
            cx.emit(Event::Save);
            cx.stop_propagation();
            return;
        }
        match e.keystroke.key.as_str() {
            "escape" => {
                cx.emit(Event::CloseKeyboard);
                cx.stop_propagation();
            }
            "tab" => {
                self.traverse(e.keystroke.modifiers.shift, w, cx);
                cx.stop_propagation();
            }
            "enter" | "space" => {
                let id = self
                    .order
                    .borrow()
                    .iter()
                    .find(|id| {
                        self.controls
                            .borrow()
                            .get(*id)
                            .is_some_and(|f| f.is_focused(w))
                    })
                    .cloned();
                if let Some(id) = id {
                    self.activate(&id, cx);
                }
                cx.stop_propagation();
            }
            _ => {
                cx.stop_propagation();
            }
        }
    }
    fn probe(&self, id: &str, d: Stateful<Div>) -> Stateful<Div> {
        let id = id.to_owned();
        let bounds = self.bounds.clone();
        d.relative().child(
            canvas(
                move |b, _, _| {
                    bounds.borrow_mut().insert(id.clone(), b);
                    b
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        )
    }
    fn control(&self, id: &str, d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        let f = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        if !self.pending {
            self.order.borrow_mut().push(id.into());
        }
        let id_owned = id.to_owned();
        let mousefocus = f.clone();
        self.probe(
            id,
            d.when(!self.pending, |d| {
                d.track_focus(&f)
                    .child(ui::guide_focus_ring(f, self.keyboard.clone(), 1.))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    if !s.pending {
                        mousefocus.focus(w, cx);
                        s.keyboard.set(false);
                    }
                    cx.stop_propagation();
                }),
            )
            .on_click(cx.listener(move |s, _, _, cx| {
                s.activate(&id_owned, cx);
                cx.stop_propagation();
            })),
        )
    }
    fn segment(&self, items: &[(&str, &str, bool)], wide: bool, cx: &mut Context<Self>) -> Div {
        ui::mode_group()
            .when(wide, |d| d.w_full())
            .children(items.iter().enumerate().map(|(i, (id, label, on))| {
                self.control(
                    id,
                    ui::mode_option(
                        (*id).to_owned(),
                        (*label).to_owned(),
                        *on,
                        !self.pending,
                        i == 0,
                        i + 1 == items.len(),
                    )
                    .px(px(14.))
                    .when(wide, |d| d.flex_1().flex().justify_center()),
                    cx,
                )
            }))
    }
    fn step(&self, id: &str, label: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        self.control(
            id,
            ui::carry_line_step(id.to_owned(), label.to_owned(), !self.pending),
            cx,
        )
    }
}
impl Render for Popover {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.bounds.borrow_mut().clear();
        self.order.borrow_mut().clear();
        let cfg = self.desired.config.clone();
        let mut card = ui::carry_line_content(&self.scroll)
            .key_context("SingZCarryLine")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                s.traverse(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                s.traverse(true, w, cx);
                cx.stop_propagation();
            }))
            .capture_key_down(cx.listener(|s, e, w, cx| s.key(e, w, cx)))
            .child(
                ui::carry_line_head_label(t("player.training.title")).child(self.segment(
                    &[
                        ("carry-off", &t("player.toggle.off"), !self.desired.enabled),
                        ("carry-on", &t("player.toggle.on"), self.desired.enabled),
                    ],
                    false,
                    cx,
                )),
            )
            .child(ui::carry_line_mode().child(self.segment(
                &[
                    (
                        "carry-time",
                        &t("player.training.byTime"),
                        matches!(cfg.mode, Mode::Time),
                    ),
                    (
                        "carry-lines",
                        &t("player.training.byLines"),
                        matches!(cfg.mode, Mode::Lines),
                    ),
                ],
                true,
                cx,
            )));
        if matches!(cfg.mode, Mode::Time) {
            card = card.child(
                ui::carry_line_row()
                    .child(ui::carry_line_label(t("player.training.switchEvery")))
                    .child(self.step("carry-period-minus", "−", cx))
                    .child(ui::carry_line_number(format!("{} s", cfg.period_sec)))
                    .child(self.step("carry-period-plus", "+", cx)),
            );
        } else {
            card = card.child(
                ui::carry_line_row()
                    .child(ui::carry_line_label(t("player.training.hear")))
                    .child(self.step("carry-hear-minus", "−", cx))
                    .child(ui::carry_line_number(cfg.hear.to_string()))
                    .child(self.step("carry-hear-plus", "+", cx))
                    .child(ui::carry_line_label(t("player.training.sing")))
                    .child(self.step("carry-sing-minus", "−", cx))
                    .child(ui::carry_line_number(cfg.sing.to_string()))
                    .child(self.step("carry-sing-plus", "+", cx)),
            );
        }
        let mut lanes = ui::carry_line_lanes_label(t("player.training.mutedWhileSinging"));
        for (i, lane) in self.lanes.iter().enumerate() {
            let id = format!("carry-lane-{i}");
            lanes = lanes.child(self.control(
                &id,
                ui::carry_line_lane(
                    id.clone(),
                    lane.label.clone(),
                    cfg.stems.contains(&lane.id),
                    !self.pending,
                ),
                cx,
            ));
        }
        card = card
            .child(ui::carry_line_caption(self.caption()))
            .child(lanes);
        if self.pending_focus {
            self.pending_focus = false;
            if self.pending {
                // A host busy transition can disable a focused control without
                // originating in activate. Retain its actual handle identity.
                if let Some((id, _)) = self.controls.borrow().iter().find(|(_, f)| f.is_focused(w))
                {
                    self.resume_focus = Some(id.clone());
                }
                self.scope.focus(w, cx);
            } else {
                let id = self
                    .resume_focus
                    .as_deref()
                    .filter(|id| {
                        self.order
                            .borrow()
                            .iter()
                            .any(|candidate| candidate.as_str() == *id)
                    })
                    .unwrap_or("carry-off");
                if let Some(f) = self.controls.borrow().get(id) {
                    f.focus(w, cx);
                }
            }
        }
        // Keep chrome/probes outside the scrolling subtree. Its measured
        // viewport must never move with the content offset.
        let max_height = self
            .trigger
            .map(|b| (b.top() - px(12.) - px(52.)).max(px(0.)))
            .unwrap_or((w.viewport_size().height - px(104.)).max(px(0.)));
        let card = self.probe(
            "carry-card",
            ui::carry_line_card()
                .max_h(max_height)
                .on_mouse_down_out(cx.listener(|s, e: &MouseDownEvent, _, cx| {
                    if !s.trigger.is_some_and(|b| b.contains(&e.position)) {
                        cx.emit(Event::Close);
                    }
                }))
                .child(self.probe("carry-content", card)),
        );
        if let Some(trigger) = self.trigger {
            card.absolute()
                .left(trigger.left() - px(8.))
                .bottom((w.viewport_size().height - trigger.top() + px(12.)).max(px(0.)))
        } else {
            card
        }
    }
}

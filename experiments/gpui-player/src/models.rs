//! Source SetupWizard composition. Persistent modal: Escape/scrim do not
//! dismiss it. Manual Close cancels; automatic Skip leaves the worker running.
use crate::i18n::{t, tv};
use crate::a11y::DialogSurface;
use gpui_kit::{prelude::*, *};
use singz_uikit::{tokens::*, *};
use std::{
    cell::RefCell,
    collections::HashMap,
    rc::Rc,
    sync::Arc,
    time::{Duration, Instant},
};
actions!(singz_models, [NextFocus, PreviousFocus]);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Origin {
    Auto,
    Manual,
}
pub enum Event {
    Download(Option<Vec<String>>),
    Close,
    Mode(bool),
}
impl EventEmitter<Event> for ModelsScreen {}
pub struct ModelsScreen {
    pub origin: Origin,
    pub snapshot: Arc<crate::model_service::Snapshot>,
    pub error: Option<String>,
    last_targets: Option<Vec<String>>,
    ready_since: Option<Instant>,
    scroll: ScrollHandle,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    focus_order: RefCell<Vec<String>>,
    pending_focus: bool,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
}
impl ModelsScreen {
    pub fn new(cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZModels")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZModels")),
        ]);
        Self {
            origin: Origin::Manual,
            snapshot: Default::default(),
            error: None,
            last_targets: None,
            ready_since: None,
            scroll: ScrollHandle::new(),
            scope: cx.focus_handle(),
            controls: Default::default(),
            focus_order: Default::default(),
            pending_focus: false,
            bounds: Default::default(),
        }
    }
    pub fn on_open(&mut self, origin: Origin, cx: &mut Context<Self>) {
        self.origin = origin;
        self.error = None;
        self.ready_since = None;
        self.pending_focus = true;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn update_status(
        &mut self,
        snapshot: Arc<crate::model_service::Snapshot>,
        cx: &mut Context<Self>,
    ) {
        if self.snapshot.revision != snapshot.revision {
            crate::a11y::announce_model_install(&self.snapshot, &snapshot);
            self.snapshot = snapshot;
            self.error = None;
            if self.snapshot.required_done() && !self.snapshot.busy && self.snapshot.error.is_none()
            {
                self.ready_since.get_or_insert_with(Instant::now);
            } else {
                self.ready_since = None;
            }
            cx.notify();
        }
    }
    pub fn requested(&mut self, targets: Option<Vec<String>>) {
        self.last_targets = targets;
    }
    pub fn failure(&mut self, error: String, cx: &mut Context<Self>) {
        crate::a11y::announce(crate::i18n::t("a11y.announce.modelFailed"));
        self.error = Some(error);
        cx.notify();
    }
    pub fn auto_done(&self) -> bool {
        self.origin == Origin::Auto
            && self.snapshot.required_done()
            && !self.snapshot.busy
            && self.snapshot.error.is_none()
            && self.error.is_none()
            && self
                .ready_since
                .is_some_and(|t| t.elapsed() >= Duration::from_millis(1100))
    }
    #[cfg(feature = "ui-tests")]
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    fn probe(&self, id: impl Into<String>, element: Stateful<Div>) -> Stateful<Div> {
        let id = id.into();
        let b = self.bounds.clone();
        element.relative().child(
                canvas(
                    move |bounds, _, _| {
                        b.borrow_mut().insert(id.clone(), bounds);
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
    }
    fn control(&self, id: impl Into<String>, element: Stateful<Div>, enabled: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = id.into();
        let focus = self.controls.borrow_mut().entry(id.clone()).or_insert_with(|| cx.focus_handle()).clone();
        if enabled { self.focus_order.borrow_mut().push(id.clone()); }
        let weak = cx.entity().downgrade();
        let action = id.clone();
        self.probe(id, settings_control_with_focus(element, focus, enabled, move |_, cx| {
            let _ = weak.update(cx, |s, cx| s.activate(&action, cx));
        }))
    }
    fn activate(&self, id: &str, cx: &mut Context<Self>) {
        if !self.focus_order.borrow().iter().any(|item| item == id) { return; }
        if let Some(target) = id.strip_prefix("model-get-") {
            // Recheck current service state: a download may have started since
            // this control was painted or received focus.
            if !self.snapshot.busy && !self.snapshot.running.iter().any(|id| id == target)
                && self.snapshot.rows.iter().any(|row| row.entry.id == target) {
                cx.emit(Event::Download(Some(vec![target.to_owned()])));
            }
        } else {
            match id {
                "model-mode-GPU" if self.snapshot.windows => cx.emit(Event::Mode(false)),
                "model-mode-CPU" if self.snapshot.windows => cx.emit(Event::Mode(true)),
                "model-retry" if self.error.is_some() || self.snapshot.error.is_some() => cx.emit(Event::Download(self.last_targets.clone())),
                "model-close" => cx.emit(Event::Close),
                _ => {}
            }
        }
    }
    pub fn focused_control(&self, window: &Window, _cx: &App) -> Option<String> {
        self.focus_order.borrow().iter().find(|id| self.controls.borrow().get(*id).is_some_and(|focus| focus.is_focused(window))).cloned()
    }
    fn focus_control(&self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.controls.borrow().get(id) { focus.focus(window, cx); }
        if let Some(bounds) = self.bounds.borrow().get(id) {
            let viewport = self.scroll.bounds();
            let correction = if bounds.top() < viewport.top() + px(4.) {
                viewport.top() + px(4.) - bounds.top()
            } else if bounds.bottom() > viewport.bottom() - px(4.) {
                viewport.bottom() - px(4.) - bounds.bottom()
            } else { px(0.) };
            let offset = self.scroll.offset();
            self.scroll.set_offset(point(offset.x, offset.y + correction));
        }
    }
    fn move_focus(&self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        let order = self.focus_order.borrow().clone();
        if !order.is_empty() {
            let current = self.focused_control(window, cx).and_then(|id| order.iter().position(|item| *item == id));
            let next = match current {
                Some(i) if backwards => (i + order.len() - 1) % order.len(),
                Some(i) => (i + 1) % order.len(),
                None if backwards => order.len() - 1,
                None => 0,
            };
            self.focus_control(&order[next], window, cx);
        } else { self.scope.focus(window, cx); }
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn keyboard_snapshot(&self, window: &Window, cx: &App) -> serde_json::Value {
        let focused = self.focused_control(window, cx);
        let bounds = focused.as_ref().and_then(|id| self.bounds.borrow().get(id).copied());
        let viewport = self.scroll.bounds();
        serde_json::json!({"focusOrder":self.focus_order.borrow().clone(),"focusedControl":focused,
            "focusInside":self.scope.contains_focused(window,cx),"busy":self.snapshot.busy,
            "origin":if self.origin == Origin::Auto {"auto"} else {"manual"},
            "focusedBounds":bounds.map(|b| [f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),
            "viewportBounds":[f32::from(viewport.left()),f32::from(viewport.top()),f32::from(viewport.size.width),f32::from(viewport.size.height)],
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)]})
    }
    fn text(text: impl Into<SharedString>, size: f32, color: u32) -> Div {
        div()
            .text_size(px(size))
            .line_height(px(size * 1.5))
            .text_color(rgb(color))
            .child(text.into())
    }
}
impl Render for ModelsScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.focus_order.borrow_mut().clear();
        if self.pending_focus { self.pending_focus = false; self.scope.focus(window, cx); }
        let state = &self.snapshot;
        let busy = state.busy;
        let error = self.error.as_deref().or(state.error.as_deref());
        let rows = model_rows().children(state.rows.iter().map(|row| {
            let id = row.entry.id.clone();
            let running = state.running.contains(&id);
            let percent = state.progress.get(&id).copied().unwrap_or(0.);
            let action = if running {
                Self::text(format!("{percent:.0}%"), 11., FAINT)
                    .font_family(MONO_400)
                    .into_any_element()
            } else {
                let button = self.control(
                    format!("model-get-{id}"),
                    small_ghost_pill(
                        format!("model-get-{id}"),
                        if row.present {
                            t("settings.wizard.reinstallButton")
                        } else {
                            tv(
                                "settings.wizard.getButton",
                                &[("mb", row.download_mb.to_string())],
                            )
                        },
                    )
                    .when(busy, |d| d.opacity(0.45).cursor_default()),
                    !busy, cx,
                );
                if row.present {
                    div()
                        .flex()
                        .items_center()
                        .gap(px(10.))
                        .child(
                            Self::text(t("settings.wizard.installedBadge"), 11., SUCCESS)
                                .font_family(MONO_400),
                        )
                        .child(button)
                        .into_any_element()
                } else {
                    button.into_any_element()
                }
            };
            div()
                .child(
                    model_head()
                        .child(
                            Self::text(model_label(&row.entry), 13.5, TEXT)
                                .font_family(DISPLAY_650),
                        )
                        .child(action),
                )
                .child(
                    Self::text(model_description(&row.entry, state.windows), 11.5, FAINT)
                        .mb(px(6.)),
                )
                .when(running || (!row.present && !row.entry.optional), |d| {
                    d.child(model_progress(if row.present { 100. } else { percent }))
                })
        }));
        let mut card = modal_card()
            .id("models-scroll")
            .w(px((f32::from(window.viewport_size().width) - 60.).min(440.)))
            .max_h(window.viewport_size().height - px(60.))
            .overflow_y_scroll()
            .track_scroll(&self.scroll)
            .child(
                Self::text(
                    t(if self.origin == Origin::Auto {
                        "settings.wizard.settingUpTitle"
                    } else {
                        "settings.wizard.aiModelsTitle"
                    }),
                    21.,
                    TEXT,
                )
                .font_family(DISPLAY_800)
                .line_height(px(25.2))
                .mb(px(12.)),
            )
            .child(
                Self::text(t("settings.wizard.intro"), 13.5, DIM)
                    .line_height(px(22.275))
                    .mb(px(14.)),
            )
            .when(!state.loaded, |d| {
                d.child(Self::text(t("main.model.checking"), 12., DIM))
            })
            .child(rows);
        if state.windows {
            card = card.child(
                div()
                    .border_t_1()
                    .border_color(rgba(LINE))
                    .pt(px(12.))
                    .mt(px(6.))
                    .child(
                        model_head()
                            .child(
                                Self::text(t("settings.wizard.engineLabel"), 13.5, TEXT)
                                    .font_family(DISPLAY_650),
                            )
                            .child(mode_segment(
                                [("GPU", false), ("CPU", true)]
                                    .into_iter()
                                    .map(|(label, cpu)| {
                                        self.control(
                                            format!("model-mode-{label}"),
                                            mode_button(
                                                format!("model-mode-{label}"),
                                                label,
                                                state.cpu_only == cpu,
                                            ),
                                            true, cx,
                                        )
                                    }),
                            )),
                    )
                    .child(Self::text(
                        if state.cpu_only {
                            state
                                .mode_reason
                                .as_ref()
                                .filter(|r| r.as_str() != "chosen in the model manager")
                                .map(|r| tv("settings.wizard.gpuAutoOff", &[("reason", r.clone())]))
                                .unwrap_or_else(|| t("settings.wizard.cpuOnly"))
                        } else {
                            t("settings.wizard.autoDescription")
                        },
                        11.5,
                        FAINT,
                    )),
            );
        }
        card = card
            .children(error.map(|e| Self::text(e.to_owned(), 12., DANGER).mt(px(12.))))
            .child(
                div()
                    .flex()
                    .justify_end()
                    .gap(px(8.))
                    .mt(px(18.))
                    .when(error.is_some(), |d| {
                        d.child(
                            self.control(
                                "model-retry",
                                pill("model-retry", t("settings.wizard.tryAgainButton"), true),
                                true, cx,
                            ),
                        )
                    })
                    .child(
                        self.control(
                            "model-close",
                            ghost_pill(
                                "model-close",
                                if self.origin == Origin::Auto && !state.required_done() {
                                    t("settings.wizard.skipButton")
                                } else {
                                    t("settings.action.close")
                                },
                            ),
                            true, cx,
                        ),
                    ),
            );
        // A running row becomes progress text; other Get actions disable while
        // any worker is busy. Recover synchronously before the focused node
        // leaves this render, keeping Tab available without deferred focus.
        let lost_control = self.controls.borrow().iter().any(|(id, focus)| {
            focus.is_focused(window) && !self.focus_order.borrow().contains(id)
        });
        if lost_control { self.scope.focus(window, cx); }
        modal_scrim().id("models-keyboard-scope").a11y_dialog(t(if self.origin == Origin::Auto { "settings.wizard.settingUpTitle" } else { "settings.wizard.aiModelsTitle" })).key_context("SingZModels").track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| { s.move_focus(false, w, cx); cx.stop_propagation(); }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| { s.move_focus(true, w, cx); cx.stop_propagation(); }))
            .capture_key_down(cx.listener(|s, event: &KeyDownEvent, w, cx| {
                if event.keystroke.key == "tab" {
                    s.move_focus(event.keystroke.modifiers.shift, w, cx);
                    w.prevent_default(); cx.stop_propagation();
                } else if event.keystroke.key == "escape" {
                    // SetupWizard is persistent for both origins.
                    w.prevent_default(); cx.stop_propagation();
                }
            }))
            .on_key_down(|_, _, cx| cx.stop_propagation())
            .on_key_up(|_, _, cx| cx.stop_propagation())
            .child(card)
    }
}

pub fn cancel_on_close(origin: Origin, busy: bool) -> bool {
    !(origin == Origin::Auto && busy)
}
#[cfg(test)]
mod tests {
    use super::{Origin, cancel_on_close};
    #[test]
    fn source_skip_policy_keeps_automatic_jobs_and_cancels_manual_jobs() {
        assert!(!cancel_on_close(Origin::Auto, true));
        assert!(cancel_on_close(Origin::Auto, false));
        assert!(cancel_on_close(Origin::Manual, true));
        assert!(cancel_on_close(Origin::Manual, false));
    }
}

// Registry IDs are stable product identities, not user-authored track names.
pub(super) fn model_label(entry: &crate::model_catalog::Entry) -> String {
    match entry.id.as_str() {
        "gpu-splitter" => t("main.model.splitter.label"),
        "qwen-asr" => t("main.model.qwenAsr.label"),
        "aligner" => t("main.model.aligner.label"),
        _ => entry.label.clone(),
    }
}
pub(super) fn model_description(entry: &crate::model_catalog::Entry, windows: bool) -> String {
    match entry.id.as_str() {
        "gpu-splitter" => t(if windows {
            "main.model.splitter.descriptionWin"
        } else if cfg!(target_arch = "aarch64") {
            "main.model.splitter.descriptionAppleSilicon"
        } else {
            "main.model.splitter.descriptionGeneric"
        }),
        "qwen-asr" => t("main.model.qwenAsr.description"),
        "aligner" => t("main.model.aligner.description"),
        _ => entry.description.clone(),
    }
}

//! Source SetupWizard composition. Persistent modal: Escape/scrim do not
//! dismiss it. Manual Close cancels; automatic Skip leaves the worker running.
use crate::i18n::{t, tv};
use gpui_kit::{prelude::*, *};
use singz_uikit::{tokens::*, *};
use std::{
    sync::Arc,
    time::{Duration, Instant},
};
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
    #[cfg(feature = "ui-tests")]
    bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>,
}
impl ModelsScreen {
    pub fn new() -> Self {
        Self {
            origin: Origin::Manual,
            snapshot: Default::default(),
            error: None,
            last_targets: None,
            ready_since: None,
            scroll: ScrollHandle::new(),
            #[cfg(feature = "ui-tests")]
            bounds: Default::default(),
        }
    }
    pub fn on_open(&mut self, origin: Origin, cx: &mut Context<Self>) {
        self.origin = origin;
        self.error = None;
        self.ready_since = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn update_status(
        &mut self,
        snapshot: Arc<crate::model_service::Snapshot>,
        cx: &mut Context<Self>,
    ) {
        if self.snapshot.revision != snapshot.revision {
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
        #[cfg(feature = "ui-tests")]
        {
            let id = id.into();
            let b = self.bounds.clone();
            return element.relative().child(
                canvas(
                    move |bounds, _, _| {
                        b.borrow_mut().insert(id.clone(), bounds);
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            );
        }
        #[cfg(not(feature = "ui-tests"))]
        {
            let _ = id;
            element
        }
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
                let target = id.clone();
                let button = self.probe(
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
                    .when(busy, |d| d.opacity(0.45).cursor_default())
                    .on_click(cx.listener(move |s, _, _, cx| {
                        if !s.snapshot.busy {
                            cx.emit(Event::Download(Some(vec![target.clone()])))
                        }
                    })),
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
                d.child(Self::text("Checking installed models…", 12., DIM))
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
                                        self.probe(
                                            format!("model-mode-{label}"),
                                            mode_button(
                                                format!("model-mode-{label}"),
                                                label,
                                                state.cpu_only == cpu,
                                            )
                                            .on_click(
                                                cx.listener(move |_, _, _, cx| {
                                                    cx.emit(Event::Mode(cpu))
                                                }),
                                            ),
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
                            self.probe(
                                "model-retry",
                                pill("model-retry", t("settings.wizard.tryAgainButton"), true)
                                    .on_click(cx.listener(|s, _, _, cx| {
                                        cx.emit(Event::Download(s.last_targets.clone()))
                                    })),
                            ),
                        )
                    })
                    .child(
                        self.probe(
                            "model-close",
                            ghost_pill(
                                "model-close",
                                if self.origin == Origin::Auto && !state.required_done() {
                                    t("settings.wizard.skipButton")
                                } else {
                                    t("settings.action.close")
                                },
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(Event::Close))),
                        ),
                    ),
            );
        modal_scrim().child(card)
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

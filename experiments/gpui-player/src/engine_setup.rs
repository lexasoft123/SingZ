//! Native legacy SetupModal. The host owns engine checks and external URLs.
use crate::i18n::t;
use crate::a11y::ButtonSurface;
use crate::a11y::DialogSurface;
use gpui_kit::{component::text::TextViewState, prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::{Duration, Instant},
};

pub const INSTALL_CMD: &str = "pipx install demucs && pipx inject demucs numpy";
actions!(
    singz_engine_setup,
    [NextFocus, PreviousFocus, Activate, Dismiss]
);

#[derive(Clone, Debug, serde::Serialize)]
pub struct Status {
    pub ok: bool,
    pub message: String,
}
#[derive(Clone, Debug)]
pub enum Event {
    Close,
    Recheck,
    GitHub,
}
pub struct EngineSetup {
    open: bool,
    status: Option<Status>,
    checking: bool,
    copied: bool,
    copy_sequence: u64,
    copy_reset: Option<Task<()>>,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    command_scroll: ScrollHandle,
    command_text: Entity<TextViewState>,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    open_sequence: u64,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for EngineSetup {}
impl EngineSetup {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        // Root's Tab action runs before raw KeyDown capture. Bind traversal
        // here so native focus cannot advance into the obscured player.
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZEngineSetup")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZEngineSetup")),
            KeyBinding::new("enter", Activate, Some("SingZEngineSetup")),
            KeyBinding::new("space", Activate, Some("SingZEngineSetup")),
            KeyBinding::new("escape", Dismiss, Some("SingZEngineSetup")),
        ]);
        Self {
            open: false,
            status: None,
            checking: false,
            copied: false,
            copy_sequence: 0,
            copy_reset: None,
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            command_scroll: ScrollHandle::new(),
            command_text: cx.new(|cx| TextViewState::markdown(INSTALL_CMD, cx)),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: false,
            open_sequence: 0,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, status: Option<Status>, cx: &mut Context<Self>) {
        self.open = true;
        self.status = status;
        self.checking = false;
        self.copied = false;
        self.copy_sequence = self.copy_sequence.wrapping_add(1);
        self.copy_reset = None;
        self.open_sequence = self.open_sequence.wrapping_add(1);
        self.pending_focus = true;
        self.keyboard.set(false);
        self.opened_at = Instant::now();
        self.bounds.borrow_mut().clear();
        self.command_scroll.set_offset(point(px(0.), px(0.)));
        self.command_text.update(cx, |s, cx| s.clear_selection(cx));
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.open {
            self.open = false;
            self.copy_sequence = self.copy_sequence.wrapping_add(1);
            self.copy_reset = None;
            self.bounds.borrow_mut().clear();
            cx.emit(Event::Close);
            cx.notify();
        }
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    /// A completed check updates its message. The host closes on `ok`, as in
    /// SetupModal's onStatus/onClose sequence; a late receipt never reopens it.
    pub fn set_status(&mut self, status: Option<Status>, cx: &mut Context<Self>) {
        self.status = status;
        self.checking = false;
        cx.notify();
    }
    pub fn set_checking(&mut self, checking: bool, cx: &mut Context<Self>) {
        self.checking = checking;
        cx.notify();
    }
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|s| s.max(0.));
        cx.notify();
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"locale":crate::i18n::current().as_str(),"open":self.open,"status":self.status,
            "checking":self.checking,"copied":self.copied,"copySequence":self.copy_sequence,
            "focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),
            "focusInside":self.scope.contains_focused(w,cx),"focusOrder":self.order.borrow().clone(),
            "commandScrollOffset":[f32::from(self.command_scroll.offset().x),f32::from(self.command_scroll.offset().y)],
            "animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        match id {
            "engine-setup-close" => self.close(cx),
            "engine-setup-github" => cx.emit(Event::GitHub),
            "engine-setup-recheck" if !self.checking => {
                self.checking = true;
                cx.emit(Event::Recheck);
                cx.notify();
            }
            "engine-setup-copy" => {
                cx.write_to_clipboard(ClipboardItem::new_string(INSTALL_CMD.into()));
                self.copied = true;
                self.copy_sequence = self.copy_sequence.wrapping_add(1);
                let sequence = self.copy_sequence;
                self.copy_reset = Some(cx.spawn(async move |this, cx| {
                    cx.background_executor()
                        .timer(Duration::from_millis(1600))
                        .await;
                    let _ = this.update(cx, |s, cx| {
                        if s.open && s.copy_sequence == sequence {
                            s.copied = false;
                            cx.notify();
                        }
                    });
                }));
                cx.notify();
            }
            _ => {}
        }
    }
    fn activate_focused(&mut self, w: &Window, cx: &mut Context<Self>) {
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
    }
    fn move_focus(&mut self, backwards: bool, w: &mut Window, cx: &mut Context<Self>) {
        self.keyboard.set(true);
        let order = self.order.borrow().clone();
        if !order.is_empty() {
            let current = order.iter().position(|id| {
                self.controls
                    .borrow()
                    .get(id)
                    .is_some_and(|f| f.is_focused(w))
            });
            let index = match current {
                Some(i) if backwards => (i + order.len() - 1) % order.len(),
                Some(i) => (i + 1) % order.len(),
                None if backwards => order.len() - 1,
                None => 0,
            };
            if let Some(f) = self.controls.borrow().get(&order[index]) {
                f.focus(w, cx);
            }
            cx.notify();
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
    fn control(
        &self,
        id: &str,
        d: Stateful<Div>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        if enabled {
            self.order.borrow_mut().push(id.into());
        }
        let mouse_focus = focus.clone();
        let click_id = id.to_owned();
        self.probe(
            id,
            d.when(enabled, |d| {
                d.track_focus(&focus)
                    .child(ui::guide_focus_ring(focus, self.keyboard.clone(), 2.))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    if enabled {
                        s.keyboard.set(false);
                        mouse_focus.focus(w, cx);
                    }
                    cx.stop_propagation();
                }),
            )
            .on_click(cx.listener(move |s, _, _, cx| {
                if enabled {
                    s.keyboard.set(false);
                    s.activate(&click_id, cx);
                }
                cx.stop_propagation();
            })),
        )
    }
}
impl Render for EngineSetup {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if !self.open {
            return div().into_any_element();
        }
        self.order.borrow_mut().clear();
        self.bounds.borrow_mut().clear();
        let elapsed = self
            .animation_time
            .unwrap_or_else(|| self.opened_at.elapsed().as_secs_f32());
        if self.animation_time.is_none() && elapsed < 0.25 && !self.frame_pending {
            self.frame_pending = true;
            let weak = cx.weak_entity();
            w.on_next_frame(move |_, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.frame_pending = false;
                    cx.notify();
                });
            });
            w.request_animation_frame();
        }
        let command = self.probe(
            "engine-setup-command",
            ui::engine_setup_command(
                INSTALL_CMD,
                &self.command_text,
                &t(if self.copied {
                    "settings.demucs.copiedBadge"
                } else {
                    "settings.demucs.copyButton"
                }),
                &self.command_scroll,
                w,
            ),
        );
        let mut card = ui::engine_setup_card(w.viewport_size())
            .id("engine-setup-card")
            .key_context("SingZEngineSetup")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                s.move_focus(true, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &Activate, w, cx| {
                s.activate_focused(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &Dismiss, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, _, w, cx| {
                    s.keyboard.set(false);
                    s.scope.focus(w, cx);
                    cx.stop_propagation();
                }),
            )
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(ui::engine_setup_title_label(t("settings.demucs.title"), w))
            .child(ui::engine_setup_intro_parts(
                &t("settings.demucs.introBefore"),
                &t("settings.demucs.introAfter"),
            ))
            .child(
                ui::engine_setup_command_row()
                    .child(command)
                    .child(self.control(
                        "engine-setup-copy",
                        ui::engine_setup_copy_label(
                            "engine-setup-copy",
                            t(if self.copied {
                                "settings.demucs.copiedBadge"
                            } else {
                                "settings.demucs.copyButton"
                            }),
                        )
                        .a11y_button(t(if self.copied {
                            "settings.demucs.copiedBadge"
                        } else {
                            "settings.demucs.copyButton"
                        })),
                        true,
                        cx,
                    )),
            )
            .child(ui::engine_setup_note_text(format!(
                "{}`brew install pipx`{}",
                t("settings.demucs.pipxBefore"),
                t("settings.demucs.pipxAfter")
            )));
        if let Some(status) = self.status.as_ref().filter(|s| !s.ok) {
            card = card.child(ui::engine_setup_error(status.message.clone()));
        }
        card = card.child(
            ui::engine_setup_actions()
                .child(self.control(
                    "engine-setup-recheck",
                    ui::engine_setup_action(
                        "engine-setup-recheck",
                        t(if self.checking {
                            "settings.demucs.checkingButton"
                        } else {
                            "settings.demucs.recheckButton"
                        }),
                        true,
                        !self.checking,
                    )
                    .a11y_button(t(if self.checking {
                        "settings.demucs.checkingButton"
                    } else {
                        "settings.demucs.recheckButton"
                    })),
                    !self.checking,
                    cx,
                ))
                .child(self.control(
                    "engine-setup-github",
                    ui::engine_setup_action(
                        "engine-setup-github",
                        t("settings.demucs.githubLink"),
                        false,
                        true,
                    )
                    .a11y_button(t("settings.demucs.githubLink")),
                    true,
                    cx,
                ))
                .child(self.control(
                    "engine-setup-close",
                    ui::engine_setup_action(
                        "engine-setup-close",
                        t("settings.action.close"),
                        false,
                        true,
                    )
                    .a11y_button(t("settings.action.close")),
                    true,
                    cx,
                )),
        );
        if self.checking
            && self
                .controls
                .borrow()
                .get("engine-setup-recheck")
                .is_some_and(|f| f.is_focused(w))
        {
            if let Some(f) = self.controls.borrow().get("engine-setup-github") {
                f.focus(w, cx);
            }
        }
        if self.pending_focus {
            self.pending_focus = false;
            if let Some(f) = self.controls.borrow().get("engine-setup-copy") {
                f.focus(w, cx);
            }
            let sequence = self.open_sequence;
            let weak = cx.weak_entity();
            w.on_next_frame(move |w, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if s.open && s.open_sequence == sequence && !s.scope.contains_focused(w, cx) {
                        if let Some(f) = s.controls.borrow().get("engine-setup-copy") {
                            f.focus(w, cx);
                        }
                        cx.notify();
                    }
                });
            });
            w.request_animation_frame();
        }
        ui::modal_scrim()
            .id("engine-setup-scrim")
            .a11y_dialog(crate::i18n::t("settings.demucs.title"))
            .on_click(cx.listener(|s, _, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .child(ui::engine_setup_entrance(
                self.probe("engine-setup-card", card),
                elapsed / 0.25,
            ))
            .into_any_element()
    }
}

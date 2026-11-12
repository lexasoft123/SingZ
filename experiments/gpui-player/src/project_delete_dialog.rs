//! Source library delete confirmation. The host inspects and deletes the target.
use crate::i18n::{t, tn, tv};
use crate::a11y::{ButtonSurface, DialogSurface};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};
actions!(
    singz_project_delete,
    [NextFocus, PreviousFocus, Activate, Dismiss]
);
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Details {
    pub name: String,
    pub stem_count: usize,
    pub has_lyrics: bool,
    pub bytes: u64,
    pub opened: bool,
}
#[derive(Clone, Debug)]
pub enum Event {
    Keep,
    Confirm,
}
pub struct DeleteDialog {
    details: Option<Details>,
    open: bool,
    busy: bool,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    open_sequence: u64,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for DeleteDialog {}
/// Source decimal KB/MB and one-decimal GB, including JS toFixed's upward ties.
pub fn format_size(bytes: u64) -> String {
    if bytes >= 1_000_000_000 {
        let value = bytes as f64 / 1e9;
        let bits = value.to_bits();
        let mantissa = (bits & ((1u64 << 52) - 1)) | (1u64 << 52);
        let exponent = ((bits >> 52) & 0x7ff) as i32 - 1023 - 52;
        let scaled = u128::from(mantissa) * 10;
        let tenths = if exponent >= 0 {
            scaled << exponent as u32
        } else {
            let denominator = 1u128 << (-exponent) as u32;
            (scaled + denominator / 2) / denominator
        };
        format!("{}.{:01} GB", tenths / 10, tenths % 10)
    } else if bytes >= 1_000_000 {
        format!("{:.0} MB", (bytes as f64 / 1e6).round())
    } else {
        format!("{:.0} KB", (bytes as f64 / 1e3).round().max(1.))
    }
}
impl DeleteDialog {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZProjectDelete")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZProjectDelete")),
            KeyBinding::new("enter", Activate, Some("SingZProjectDelete")),
            KeyBinding::new("space", Activate, Some("SingZProjectDelete")),
            KeyBinding::new("escape", Dismiss, Some("SingZProjectDelete")),
        ]);
        Self {
            details: None,
            open: false,
            busy: false,
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: false,
            open_sequence: 0,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, details: Details, cx: &mut Context<Self>) {
        self.details = Some(details);
        self.open = true;
        self.busy = false;
        self.pending_focus = true;
        self.keyboard.set(false);
        self.open_sequence = self.open_sequence.wrapping_add(1);
        self.opened_at = Instant::now();
        self.bounds.borrow_mut().clear();
        cx.notify();
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn details(&self) -> Option<&Details> {
        self.details.as_ref()
    }
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        if self.busy != busy {
            self.busy = busy;
            self.pending_focus = !busy;
            cx.notify();
        }
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.open && !self.busy {
            self.open = false;
            self.bounds.borrow_mut().clear();
            cx.emit(Event::Keep);
            cx.notify();
        }
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|v| v.max(0.));
        cx.notify();
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"open":self.open,"busy":self.busy,"details":self.details,"formattedSize":self.details.as_ref().map(|d|format_size(d.bytes)),"focusInside":self.scope.contains_focused(w,cx),"focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),"focusOrder":self.order.borrow().clone(),"animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32()),"openedSongCopyDeviation":"Corrected obsolete source English copy: deletion stops playback and closes the loaded project.","cloudAccount":"unconfigured; source offline resplit note"})
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.open || self.busy {
            return;
        }
        match id {
            "project-delete-keep" => self.close(cx),
            "project-delete-confirm" => {
                self.busy = true;
                cx.emit(Event::Confirm);
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
        if order.is_empty() {
            self.scope.focus(w, cx);
        } else {
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
        }
        cx.notify();
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
            .inset_0(),
        )
    }
    fn button(
        &self,
        id: &str,
        label: String,
        danger: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        if !self.busy {
            self.order.borrow_mut().push(id.into());
        }
        let mouse_focus = focus.clone();
        let click_id = id.to_owned();
        self.probe(
            id,
            ui::project_delete_action(id.to_owned(), label.clone(), danger, !self.busy)
                .a11y_button(label)
                .when(!self.busy, |d| {
                    d.track_focus(&focus).child(ui::guide_focus_ring(
                        focus,
                        self.keyboard.clone(),
                        1.,
                    ))
                })
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| {
                        if !s.busy {
                            s.keyboard.set(false);
                            mouse_focus.focus(w, cx);
                        }
                        cx.stop_propagation();
                    }),
                )
                .on_click(cx.listener(move |s, _, _, cx| {
                    s.keyboard.set(false);
                    s.activate(&click_id, cx);
                    cx.stop_propagation();
                })),
        )
    }
}
impl Render for DeleteDialog {
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
        let Some(details) = self.details.as_ref() else {
            return div().into_any_element();
        };
        let stems = if details.stem_count == 0 {
            t("library.dropScreen.eraseStemsFallback")
        } else {
            tn(
                "library.dropScreen.stemsCount",
                details.stem_count as f64,
                &[],
            )
        };
        let size = format_size(details.bytes);
        let body = tv(
            "library.dropScreen.eraseBody",
            &[
                ("stems", stems),
                (
                    "lyrics",
                    if details.has_lyrics {
                        t("library.dropScreen.eraseLyricsSuffix")
                    } else {
                        String::new()
                    },
                ),
                ("size", size.clone()),
            ],
        );
        // App.handleDeleted actually stops and unloads the open project. Its old
        // English note said playback continued; this intentional correction follows
        // the native host behavior and the user's requested copy.
        let note = format!(
            "{}{}",
            if details.opened {
                "This is the song you have open — deleting it stops playback and closes it. "
            } else {
                ""
            },
            t("library.dropScreen.resplitNote")
        );
        let card = ui::project_delete_card(w.viewport_size())
            .id("project-delete-card")
            .key_context("SingZProjectDelete")
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
            .child(ui::project_delete_title_label(
                tv(
                    "library.dropScreen.deleteHeading",
                    &[("name", details.name.clone())],
                ),
                w,
            ))
            .child(ui::project_delete_body(body))
            .child(ui::project_delete_note(note))
            .child(
                ui::project_delete_actions()
                    .child(self.button(
                        "project-delete-keep",
                        t("library.dropScreen.keepIt"),
                        false,
                        cx,
                    ))
                    .child(self.button(
                        "project-delete-confirm",
                        if self.busy {
                            t("library.dropScreen.deleting")
                        } else {
                            tv("library.dropScreen.deleteSize", &[("size", size.clone())])
                        },
                        true,
                        cx,
                    )),
            );
        if self.busy {
            self.scope.focus(w, cx);
        }
        if self.pending_focus {
            self.pending_focus = false;
            if let Some(f) = self.controls.borrow().get("project-delete-keep") {
                f.focus(w, cx);
            }
            let sequence = self.open_sequence;
            let weak = cx.weak_entity();
            w.on_next_frame(move |w, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if s.open && s.open_sequence == sequence && !s.scope.contains_focused(w, cx) {
                        if s.busy {
                            s.scope.focus(w, cx);
                        } else if let Some(f) = s.controls.borrow().get("project-delete-keep") {
                            f.focus(w, cx);
                        }
                        cx.notify();
                    }
                });
            });
            w.request_animation_frame();
        }
        ui::modal_scrim()
            .id("project-delete-scrim")
            .a11y_dialog(tv("library.dropScreen.deleteHeading", &[("name", details.name.clone())]))
            .on_click(cx.listener(|s, _, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .child(ui::project_delete_entrance(
                self.probe("project-delete-card", card),
                elapsed / 0.25,
            ))
            .into_any_element()
    }
}

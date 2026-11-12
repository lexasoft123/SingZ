//! Native LibraryImport composition. The host owns the copy/move lifecycle.
use crate::i18n::t;
use crate::a11y::{ButtonSurface, DialogSurface};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    time::Instant,
};
actions!(singz_library_import, [NextFocus, PreviousFocus]);

#[derive(Clone, Debug)]
pub enum Event {
    Copy,
    Move,
    Close,
}
pub struct ImportDialog {
    dir: PathBuf,
    root: PathBuf,
    busy: bool,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for ImportDialog {}
impl ImportDialog {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        // Root resolves Tab actions before raw key capture. Bind traversal to
        // this modal so focus cannot advance into the player behind it.
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZLibraryImport")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZLibraryImport")),
        ]);
        Self {
            dir: PathBuf::new(),
            root: PathBuf::new(),
            busy: false,
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: true,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, dir: PathBuf, root: PathBuf, cx: &mut Context<Self>) {
        self.dir = dir;
        self.root = root;
        self.busy = false;
        self.pending_focus = true;
        self.keyboard.set(false);
        self.opened_at = Instant::now();
        self.bounds.borrow_mut().clear();
        cx.notify();
    }
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        if self.busy != busy {
            self.busy = busy;
            self.pending_focus = true;
            cx.notify();
        }
    }
    /// Deterministic elapsed seconds for hidden animation captures; .25 settles.
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|v| v.max(0.));
        cx.notify();
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"dir":self.dir,"root":self.root,"busy":self.busy,
            "focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),
            "focusInside":self.scope.contains_focused(w,cx),"enabledControls":self.order.borrow().clone(),
            "animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if self.busy {
            return;
        }
        match id {
            "library-import-copy" => {
                self.busy = true;
                self.pending_focus = true;
                cx.emit(Event::Copy);
            }
            "library-import-move" => {
                self.busy = true;
                self.pending_focus = true;
                cx.emit(Event::Move);
            }
            "library-import-close" => cx.emit(Event::Close),
            _ => {}
        }
        cx.notify();
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
                None => {
                    if backwards {
                        order.len() - 1
                    } else {
                        0
                    }
                }
            };
            if let Some(f) = self.controls.borrow().get(&order[index]) {
                f.focus(w, cx);
            }
        }
        cx.notify();
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        match e.keystroke.key.as_str() {
            "escape" => {
                if !self.busy {
                    cx.emit(Event::Close);
                }
                cx.stop_propagation();
            }
            "tab" => {
                self.move_focus(e.keystroke.modifiers.shift, w, cx);
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
            _ => {}
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
    fn button(&self, id: &str, label: String, cx: &mut Context<Self>) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        if !self.busy {
            self.order.borrow_mut().push(id.into());
        }
        let click_id = id.to_owned();
        self.probe(
            id,
            ui::library_import_action(id.to_owned(), label.to_owned(), !self.busy)
                .a11y_button(label.to_owned())
                .when(!self.busy, |d| {
                    d.track_focus(&focus).child(ui::guide_focus_ring(
                        focus.clone(),
                        self.keyboard.clone(),
                        1.,
                    ))
                })
                .on_click(cx.listener(move |s, _, _, cx| {
                    s.keyboard.set(false);
                    s.activate(&click_id, cx);
                    cx.stop_propagation();
                })),
        )
    }
}
impl Render for ImportDialog {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
        let card = ui::library_import_card(w.viewport_size())
            .id("library-import-card")
            .key_context("SingZLibraryImport")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                s.move_focus(true, w, cx);
                cx.stop_propagation();
            }))
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            .capture_key_down(cx.listener(|s, e, w, cx| s.key(e, w, cx)))
            .child(
                ui::library_import_head()
                    .child(ui::library_import_title_label(
                        t("library.libraryImport.heading"),
                        w,
                    ))
                    .child(ui::library_import_head_actions().child(self.button(
                        "library-import-close",
                        t("library.common.close"),
                        cx,
                    ))),
            )
            .child(ui::library_import_body_text(
                t("library.libraryImport.body"),
                &[
                    ("dir", self.dir.to_string_lossy().into_owned()),
                    ("root", self.root.to_string_lossy().into_owned()),
                ],
            ))
            .child(
                ui::library_import_actions()
                    .child(self.button(
                        "library-import-copy",
                        t("library.libraryImport.copyIn"),
                        cx,
                    ))
                    .child(self.button(
                        "library-import-move",
                        t("library.libraryImport.moveIn"),
                        cx,
                    )),
            )
            .child(ui::library_import_hint_text(t(if self.busy {
                "library.libraryImport.workingHint"
            } else {
                "library.libraryImport.copyMoveHint"
            })));
        if self.pending_focus {
            self.pending_focus = false;
            if self.busy {
                self.scope.focus(w, cx);
            } else if let Some(f) = self.controls.borrow().get("library-import-close") {
                f.focus(w, cx);
            }
        }
        ui::modal_scrim()
            .id("library-import-scrim")
            .a11y_dialog(crate::i18n::t("library.libraryImport.heading"))
            .on_click(cx.listener(|s, _, _, cx| {
                if !s.busy {
                    cx.emit(Event::Close);
                }
                cx.stop_propagation();
            }))
            .child(ui::library_import_entrance(
                self.probe("library-import-card", card),
                elapsed / 0.25,
            ))
    }
}

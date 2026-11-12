//! Thin state/event adapter for the production shared UIKit export dialog.
use crate::i18n::t;
use crate::a11y::DialogSurface;
use crate::{
    stem_export::{Format, Mode},
    tracks::Lane,
};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::{HashMap, HashSet},
    rc::Rc,
    time::Instant,
};
actions!(singz_stem_export, [NextFocus, PreviousFocus]);
#[derive(Clone, Debug)]
pub enum Event {
    Close,
    Run {
        mode: Mode,
        format: Format,
        selected: Vec<String>,
    },
}
pub struct Dialog {
    tracks: Vec<Lane>,
    selected: HashSet<String>,
    mode: Mode,
    format: Format,
    busy: bool,
    status: String,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    keyboard: Rc<Cell<bool>>,
    scroll: ScrollHandle,
    pending_focus: bool,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for Dialog {}
impl Dialog {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZStemExport")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZStemExport")),
        ]);
        Self {
            tracks: vec![],
            selected: HashSet::new(),
            mode: Mode::Stems,
            format: Format::Mp3,
            busy: false,
            status: String::new(),
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            keyboard: Rc::new(Cell::new(false)),
            scroll: ScrollHandle::new(),
            pending_focus: true,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, tracks: Vec<Lane>, cx: &mut Context<Self>) {
        self.selected = tracks.iter().map(|t| t.id.clone()).collect();
        self.tracks = tracks;
        self.mode = Mode::Stems;
        self.format = Format::Mp3;
        self.busy = false;
        self.status.clear();
        self.pending_focus = true;
        self.keyboard.set(false);
        self.opened_at = Instant::now();
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    fn track_label(lane: &Lane) -> String {
        // Built-in roles are domain identifiers. Custom names remain user text.
        if !lane.custom
            && matches!(
                lane.id.as_str(),
                "original" | "vocals" | "drums" | "bass" | "guitar" | "piano" | "other"
            )
        {
            t(&format!("stem.{}", lane.id))
        } else {
            lane.label.clone()
        }
    }
    pub fn set_busy(&mut self, busy: bool, cx: &mut Context<Self>) {
        if self.busy != busy {
            self.busy = busy;
            self.pending_focus = true;
            cx.notify();
        }
    }
    pub fn set_status(&mut self, status: String, cx: &mut Context<Self>) {
        self.status = status;
        cx.notify();
    }
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|v| v.max(0.));
        cx.notify();
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"busy":self.busy,"status":self.status,"mode":if matches!(self.mode,Mode::Stems){"stems"}else{"karaoke"},"format":match self.format{Format::Mp3=>"mp3",Format::Wav=>"wav",Format::Flac=>"flac"},"selected":self.selected_ids(),"tracks":self.tracks.iter().map(|t|serde_json::json!({"id":t.id,"label":t.label,"displayLabel":Self::track_label(t)})).collect::<Vec<_>>(),"focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),"focusInside":self.scope.contains_focused(w,cx),"focusOrder":self.order.borrow().clone(),"keyboardFocus":self.keyboard.get(),"scrollOffset":f32::from(self.scroll.offset().y),"animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
    fn selected_ids(&self) -> Vec<String> {
        self.tracks
            .iter()
            .filter(|t| self.selected.contains(&t.id))
            .map(|t| t.id.clone())
            .collect()
    }
    fn karaoke(id: &str) -> bool {
        matches!(id, "drums" | "bass" | "other" | "guitar" | "piano") || Self::backing(id)
    }
    fn backing(id: &str) -> bool {
        id == "custom-backing-vocals"
            || id
                .strip_prefix("custom-backing-vocals-")
                .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
    }
    fn can_run(&self) -> bool {
        !self.busy
            && if matches!(self.mode, Mode::Stems) {
                !self.selected_ids().is_empty()
            } else {
                self.tracks.iter().any(|t| Self::karaoke(&t.id))
            }
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if id == "export-cancel" {
            cx.emit(Event::Close);
            return;
        }
        if self.busy {
            return;
        }
        match id {
            "export-mode-stems" => {
                self.mode = Mode::Stems;
                self.status.clear();
            }
            "export-mode-karaoke" if self.tracks.iter().any(|t| Self::karaoke(&t.id)) => {
                self.mode = Mode::Karaoke;
                self.status.clear();
            }
            "export-format-mp3" => {
                self.format = Format::Mp3;
                self.status.clear();
            }
            "export-format-wav" => {
                self.format = Format::Wav;
                self.status.clear();
            }
            "export-format-flac" => {
                self.format = Format::Flac;
                self.status.clear();
            }
            "export-run" if self.can_run() => {
                self.busy = true;
                self.status.clear();
                self.pending_focus = true;
                cx.emit(Event::Run {
                    mode: self.mode,
                    format: self.format,
                    selected: self.selected_ids(),
                });
            }
            _ => {
                if let Some(i) = id
                    .strip_prefix("export-track-")
                    .and_then(|s| s.parse::<usize>().ok())
                {
                    if let Some(t) = self.tracks.get(i) {
                        if !self.selected.remove(&t.id) {
                            self.selected.insert(t.id.clone());
                        }
                    }
                }
            }
        }
        cx.notify();
    }
    fn move_focus(&mut self, back: bool, w: &mut Window, cx: &mut Context<Self>) {
        self.keyboard.set(true);
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
        if let Some(f) = order
            .get(i)
            .and_then(|id| self.controls.borrow().get(id).cloned())
        {
            f.focus(w, cx);
            if let (Some(id), Some(card)) = (order.get(i), self.bounds("export-card")) {
                if let Some(control) = self.bounds(id) {
                    let delta = if control.bottom() > card.bottom() - px(24.) {
                        card.bottom() - px(24.) - control.bottom()
                    } else if control.top() < card.top() + px(24.) {
                        card.top() + px(24.) - control.top()
                    } else {
                        px(0.)
                    };
                    let offset = self.scroll.offset();
                    self.scroll
                        .set_offset(point(offset.x, (offset.y + delta).min(px(0.))));
                }
            }
        } else {
            self.scope.focus(w, cx);
        }
        cx.notify();
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        match e.keystroke.key.as_str() {
            "escape" => {
                cx.emit(Event::Close);
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
        let click = id.to_owned();
        let mousefocus = focus.clone();
        self.probe(
            id,
            ui::disabled_control(d, enabled).when(enabled, |d| {
                d.track_focus(&focus).child(ui::guide_focus_ring(
                    focus.clone(),
                    self.keyboard.clone(),
                    1.,
                ))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    if enabled {
                        mousefocus.focus(w, cx);
                        s.keyboard.set(false);
                    }
                    cx.stop_propagation();
                }),
            )
            .on_click(cx.listener(move |s, _, _, cx| {
                if enabled {
                    s.activate(&click, cx);
                }
                cx.stop_propagation();
            })),
        )
    }
}
impl Render for Dialog {
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
        let modes = [
            (
                "export-mode-stems",
                t("player.stack.exportStems"),
                matches!(self.mode, Mode::Stems),
                !self.busy,
            ),
            (
                "export-mode-karaoke",
                t("player.stack.exportKaraoke"),
                matches!(self.mode, Mode::Karaoke),
                !self.busy && self.tracks.iter().any(|t| Self::karaoke(&t.id)),
            ),
        ]
        .into_iter()
        .map(|(id, label, on, enabled)| {
            self.control(
                id,
                crate::a11y::radio(ui::stem_export_segment(id, label.clone(), on, enabled), label, on),
                enabled,
                cx,
            )
        })
        .collect::<Vec<_>>();
        let mut card = ui::stem_export_card(w, &self.scroll)
            .key_context("SingZStemExport")
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
            .child(ui::stem_export_title_label(t("player.stack.export"), w))
            .child(ui::stem_export_paragraph(
                t("player.stack.exportOriginal"),
                false,
            ))
            .child(
                ui::stem_export_control(t("player.stack.exportMode"), w)
                    .child(ui::mode_segment(modes)),
            );
        if matches!(self.mode, Mode::Stems) {
            let mut selection = ui::stem_export_selection_label(t("player.stack.exportSelect"));
            let mut rows = div().flex_none().flex().flex_col().gap(px(10.));
            for (row, chunk) in self.tracks.chunks(2).enumerate() {
                let mut line = ui::stem_export_row();
                for (column, t) in chunk.iter().enumerate() {
                    let id = format!("export-track-{}", row * 2 + column);
                    let check_id = id.clone();
                    let enabled = !self.busy;
                    let checkbox =
                        ui::checkbox(format!("{id}-check"), self.selected.contains(&t.id))
                            .aria_label(Self::track_label(t))
                            .a11y_synthetic_children(|builder| builder.parent_node().set_hidden())
                            .on_click(cx.listener(move |s, _, _, cx| {
                                if enabled {
                                    s.activate(&check_id, cx);
                                }
                                cx.stop_propagation();
                            }));
                    let d =
                        ui::stem_export_track(id.clone(), Self::track_label(t), checkbox, enabled)
                            .role(Role::CheckBox).accessibility_id(id.clone())
                            .aria_label(Self::track_label(t))
                            .aria_toggled(if self.selected.contains(&t.id) {Toggled::True} else {Toggled::False});
                    line = line.child(self.control(&id, d, enabled, cx));
                }
                if chunk.len() == 1 {
                    line = line.child(div().flex_1());
                }
                rows = rows.child(line);
            }
            selection = selection.child(rows);
            card = card.child(selection);
        }
        let formats = [
            (
                "export-format-mp3",
                "MP3",
                matches!(self.format, Format::Mp3),
            ),
            (
                "export-format-wav",
                "WAV",
                matches!(self.format, Format::Wav),
            ),
            (
                "export-format-flac",
                "FLAC",
                matches!(self.format, Format::Flac),
            ),
        ]
        .into_iter()
        .map(|(id, label, on)| {
            self.control(
                id,
                crate::a11y::radio(ui::stem_export_segment(id, label, on, !self.busy), label, on),
                !self.busy,
                cx,
            )
        })
        .collect::<Vec<_>>();
        card = card.child(
            ui::stem_export_control(t("player.stack.exportFormat"), w)
                .child(ui::mode_segment(formats))
                .child(ui::stem_export_paragraph(
                    if matches!(self.format, Format::Mp3) {
                        t("player.stack.exportMp3Hint")
                    } else {
                        t("player.stack.exportLosslessHint")
                    },
                    true,
                )),
        );
        if matches!(self.mode, Mode::Karaoke) {
            card = card.child(ui::stem_export_paragraph(
                if self.tracks.iter().any(|t| Self::backing(&t.id)) {
                    t("player.stack.exportKaraokeHint")
                } else {
                    t("player.stack.exportKaraokeNoBacking")
                },
                true,
            ));
        }
        if !self.status.is_empty() {
            card = card.child(
                div()
                    .flex_none()
                    .line_height(px(21.))
                    .child(self.status.clone()),
            );
        }
        let run = self.control(
            "export-run",
            ui::stem_export_action(
                "export-run",
                t("player.stack.exportChoose"),
                true,
                self.can_run(),
                w,
            ).role(Role::Button).accessibility_id("export-run").aria_label(t("player.stack.exportChoose")),
            self.can_run(),
            cx,
        );
        let cancel = self.control(
            "export-cancel",
            ui::stem_export_action(
                "export-cancel",
                t("player.stack.exportCancel"),
                false,
                true,
                w,
            ).role(Role::Button).accessibility_id("export-cancel").aria_label(t("player.stack.exportCancel")),
            true,
            cx,
        );
        card = card.child(
            div()
                .flex_none()
                .flex()
                .gap(px(12.))
                .child(run)
                .child(cancel),
        );
        if self.pending_focus {
            self.pending_focus = false;
            let id = if self.busy {
                "export-cancel"
            } else {
                "export-mode-stems"
            };
            if let Some(f) = self.controls.borrow().get(id) {
                f.focus(w, cx);
            }
        }
        ui::modal_scrim()
            .id("export-scrim")
            .a11y_dialog(crate::i18n::t("player.stack.export"))
            .on_click(cx.listener(|_, _, _, cx| {
                cx.emit(Event::Close);
                cx.stop_propagation();
            }))
            .child(ui::project_picker_entrance(
                self.probe(
                    "export-card",
                    ui::stem_export_frame(w).child(self.probe("export-content", card)),
                ),
                elapsed / 0.25,
            ))
    }
}

//! Native port of DriveProjects.tsx from the read-only tv-drive-sign-in source
//! checkout at 669ba5a0. It is absent from this branch's Electron route inventory;
//! source-backed composition is not current Electron capture parity.
use crate::{drive_restore::Row, i18n::t};
use crate::a11y::ButtonSurface;
use crate::a11y::DialogSurface;
use gpui_kit::{
    component::input::{IndentInline, InputEvent, InputState, OutdentInline},
    prelude::*,
    *,
};
use singz_uikit as ui;
use std::{cell::RefCell, collections::HashMap, path::PathBuf, rc::Rc, time::Instant};
actions!(singz_drive_projects, [NextFocus, PreviousFocus]);

#[derive(Clone, Debug)]
pub enum Event {
    Refresh,
    Download(String),
    Open(PathBuf),
    Cancel,
    Close,
}

#[derive(Clone, Debug, Default)]
pub struct State {
    pub rows: Option<Vec<Row>>,
    pub busy: bool,
    pub message: String,
    pub progress: f32,
}

pub struct Dialog {
    state: State,
    query: String,
    search: Entity<InputState>,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    scroll: ScrollHandle,
    pending_focus: bool,
    opened_at: Instant,
    frame_pending: bool,
    _search_subscription: Subscription,
}
impl EventEmitter<Event> for Dialog {}
impl Dialog {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZDriveProjects")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZDriveProjects")),
        ]);
        let search =
            cx.new(|cx| InputState::new(window, cx).placeholder(t("library.drive.search")));
        let subscription = cx.subscribe_in(&search, window, |s, input, event, _, cx| {
            if matches!(event, InputEvent::Change) && !s.state.busy {
                s.query = input.read(cx).value().to_string();
                s.scroll.set_offset(point(px(0.), px(0.)));
                cx.notify();
            }
        });
        Self {
            state: State::default(),
            query: String::new(),
            search,
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            scroll: ScrollHandle::new(),
            pending_focus: true,
            opened_at: Instant::now(),
            frame_pending: false,
            _search_subscription: subscription,
        }
    }
    pub fn open(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.state = State::default();
        self.query.clear();
        self.search
            .update(cx, |input, cx| input.set_value("", window, cx));
        self.pending_focus = true;
        self.opened_at = Instant::now();
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.bounds.borrow_mut().clear();
        cx.emit(Event::Refresh);
        cx.notify();
    }
    pub fn set_state(&mut self, state: State, cx: &mut Context<Self>) {
        self.state = State {
            progress: if state.progress.is_finite() {
                state.progress.clamp(0., 1.)
            } else {
                0.
            },
            ..state
        };
        cx.notify();
    }
    pub fn refresh_locale(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        self.search.update(cx, |input, cx| {
            input.set_placeholder(t("library.drive.search"), window, cx)
        });
        cx.notify();
    }
    pub fn focus_inside(&self, window: &Window, cx: &App) -> bool {
        self.scope.contains_focused(window, cx)
    }
    pub fn text_input_focused(&self, window: &Window, cx: &App) -> bool {
        !self.state.busy && self.search.read(cx).focus_handle(cx).is_focused(window)
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        if id == "drive-projects-rows" {
            Some(self.scroll.bounds())
        } else {
            self.bounds.borrow().get(id).copied()
        }
    }
    fn visible_rows(&self) -> Vec<&Row> {
        let query = self.query.to_lowercase();
        self.state
            .rows
            .iter()
            .flat_map(|rows| rows.iter())
            .filter(|row| row.name.to_lowercase().contains(&query))
            .collect()
    }
    fn focused_control(&self, window: &Window) -> Option<String> {
        self.order
            .borrow()
            .iter()
            .find(|id| {
                self.controls
                    .borrow()
                    .get(*id)
                    .is_some_and(|focus| focus.is_focused(window))
            })
            .cloned()
    }
    fn close(&self, cx: &mut Context<Self>) {
        cx.emit(if self.state.busy {
            Event::Cancel
        } else {
            Event::Close
        });
    }
    fn activate(&self, id: &str, cx: &mut Context<Self>) {
        if id == "drive-projects-close" {
            self.close(cx);
            return;
        }
        if self.state.busy {
            return;
        }
        let Some(remote_id) = id.strip_prefix("drive-projects-row-") else {
            return;
        };
        if let Some(row) = self
            .visible_rows()
            .into_iter()
            .find(|row| row.id == remote_id)
        {
            cx.emit(if let Some(path) = &row.song_path {
                Event::Open(path.clone())
            } else {
                Event::Download(row.id.clone())
            });
        }
    }
    fn focus(&self, id: &str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = self
            .visible_rows()
            .iter()
            .position(|row| format!("drive-projects-row-{}", row.id) == id)
        {
            self.scroll.scroll_to_item(index);
        }
        if let Some(focus) = self.controls.borrow().get(id) {
            focus.focus(window, cx);
        }
    }
    fn move_focus(&self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        let order = self.order.borrow();
        if order.is_empty() {
            return;
        }
        let current = self
            .focused_control(window)
            .and_then(|id| order.iter().position(|value| *value == id));
        let next = match current {
            Some(index) if backwards => (index + order.len() - 1) % order.len(),
            Some(index) => (index + 1) % order.len(),
            None if backwards => order.len() - 1,
            None => 0,
        };
        self.focus(&order[next], window, cx);
        cx.notify();
    }
    fn key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if key == "escape" {
            if !event.is_held {
                self.close(cx);
            }
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if key == "tab" {
            self.move_focus(event.keystroke.modifiers.shift, window, cx);
            window.prevent_default();
            cx.stop_propagation();
            return;
        }
        if self.focused_control(window).as_deref() == Some("drive-projects-search") {
            return;
        }
        let amount = match key {
            "up" => Some(px(40.)),
            "down" => Some(px(-40.)),
            "pageup" => Some(self.scroll.bounds().size.height * 0.9),
            "pagedown" => Some(self.scroll.bounds().size.height * -0.9),
            _ => None,
        };
        let offset = self.scroll.offset();
        let target = amount
            .map(|amount| (offset.y + amount).clamp(-self.scroll.max_offset().y, px(0.)))
            .or_else(|| match key {
                "home" => Some(px(0.)),
                "end" => Some(-self.scroll.max_offset().y),
                _ => None,
            });
        if let Some(y) = target {
            self.scroll.set_offset(point(offset.x, y));
            window.prevent_default();
            cx.stop_propagation();
            cx.notify();
        }
    }
    fn probe(&self, id: &str, control: Stateful<Div>) -> Stateful<Div> {
        let bounds = self.bounds.clone();
        let id = id.to_owned();
        control.relative().child(
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
        id: String,
        control: Stateful<Div>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.clone())
            .or_insert_with(|| cx.focus_handle())
            .clone();
        if enabled {
            self.order.borrow_mut().push(id.clone());
        }
        let weak = cx.entity().downgrade();
        let action = id.clone();
        self.probe(
            &id,
            ui::settings_control_with_focus(control, focus, enabled, move |_, cx| {
                let _ = weak.update(cx, |s, cx| s.activate(&action, cx));
            }),
        )
    }
    #[cfg(feature = "ui-tests")]
    pub fn state(&self, window: &Window, cx: &App) -> serde_json::Value {
        let focused = self.focused_control(window);
        let b = |value: Option<Bounds<Pixels>>| {
            value.map(|v| {
                [
                    f32::from(v.left()),
                    f32::from(v.top()),
                    f32::from(v.size.width),
                    f32::from(v.size.height),
                ]
            })
        };
        let row_json =
            |row: &Row| serde_json::json!({"id":row.id,"name":row.name,"songPath":row.song_path});
        let rows = self
            .state
            .rows
            .as_ref()
            .map(|rows| rows.iter().map(row_json).collect::<Vec<_>>());
        let visible_rows = self
            .visible_rows()
            .into_iter()
            .map(row_json)
            .collect::<Vec<_>>();
        serde_json::json!({"query":self.query,"searchValue":self.search.read(cx).value().to_string(),"searchFocused":self.search.read(cx).focus_handle(cx).is_focused(window),"busy":self.state.busy,"message":self.state.message,"progress":self.state.progress,"loading":self.state.rows.is_none(),
            "rows":rows,"visibleRows":visible_rows,"focusedControl":focused,"focusInside":self.focus_inside(window,cx),"focusOrder":self.order.borrow().clone(),
            "focusedBounds":focused.as_deref().and_then(|id|b(self.bounds(id))),"cardBounds":b(self.bounds("drive-projects-card")),"rowsBounds":b(self.bounds("drive-projects-rows")),
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],"liveFps":"unmeasured"})
    }
}
impl Render for Dialog {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let previous = self
            .controls
            .borrow()
            .values()
            .find(|focus| focus.is_focused(window))
            .cloned();
        self.order.borrow_mut().clear();
        self.bounds.borrow_mut().clear();
        let elapsed = self.opened_at.elapsed().as_secs_f32();
        if elapsed < 0.25 && !self.frame_pending {
            self.frame_pending = true;
            let weak = cx.weak_entity();
            window.on_next_frame(move |_, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.frame_pending = false;
                    cx.notify();
                });
            });
            window.request_animation_frame();
        }
        let close = self.control(
            "drive-projects-close".into(),
            ui::project_picker_action(
                "drive-projects-close",
                t(if self.state.busy {
                    "library.dropScreen.cancelSync"
                } else {
                    "library.common.close"
                }),
                true,
            )
            .a11y_button(t(if self.state.busy {
                "library.dropScreen.cancelSync"
            } else {
                "library.common.close"
            })),
            true,
            cx,
        );
        let search_focus = self.search.read(cx).focus_handle(cx);
        self.controls
            .borrow_mut()
            .insert("drive-projects-search".into(), search_focus);
        if !self.state.busy {
            self.order.borrow_mut().push("drive-projects-search".into());
        }
        let search = self.probe(
            "drive-projects-search",
            div()
                .id("drive-projects-search")
                .w_full()
                .flex_none()
                .child(ui::drive_projects_search(&self.search, self.state.busy).accessibility_id("drive-projects-search").aria_label(crate::i18n::t("library.drive.search"))),
        );
        let rows = if self.state.rows.is_none() {
            ui::project_picker_paragraph(t("library.drive.loading")).into_any_element()
        } else {
            let rows = self
                .visible_rows()
                .into_iter()
                .map(|row| {
                    let id = format!("drive-projects-row-{}", row.id);
                    let control = ui::drive_projects_row(
                        id.clone(),
                        row.name.clone(),
                        t(if row.song_path.is_some() {
                            "library.drive.open"
                        } else {
                            "library.drive.download"
                        }),
                        window,
                    )
                    .a11y_button(format!("{} — {}", row.name, t(if row.song_path.is_some() { "library.drive.open" } else { "library.drive.download" })));
                    self.control(id, control, !self.state.busy, cx)
                })
                .collect::<Vec<_>>();
            let list = ui::project_picker_rows("drive-projects-rows")
                .track_scroll(&self.scroll)
                .children(rows)
                .when(
                    self.state.rows.as_ref().is_some_and(Vec::is_empty),
                    |list| list.child(ui::project_picker_paragraph(t("library.drive.empty"))),
                );
            // Bounds and focus overlays are outside the scrolling coordinates.
            div()
                .relative()
                .flex()
                .flex_col()
                .min_h_0()
                .child(list)
                .child(ui::production_scrollbar(&self.scroll))
                .into_any_element()
        };
        let card = ui::project_picker_card(window.viewport_size())
            .id("drive-projects-card")
            .key_context("SingZDriveProjects")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                s.move_focus(true, w, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|s, _: &IndentInline, w, cx| {
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .capture_action(cx.listener(|s, _: &OutdentInline, w, cx| {
                s.move_focus(true, w, cx);
                cx.stop_propagation();
            }))
            .capture_key_down(cx.listener(|s, event, w, cx| s.key(event, w, cx)))
            .on_key_down(cx.listener(|s, _, window, cx| {
                // Unhandled text keys must reach GPUI's platform input
                // fallback. Tab and Escape are already owned in capture.
                if s.text_input_focused(window, cx) {
                    cx.propagate();
                } else {
                    cx.stop_propagation();
                }
            }))
            .on_key_up(|_, _, cx| cx.stop_propagation())
            .on_mouse_down(MouseButton::Left, |_, _, cx| cx.stop_propagation())
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(
                ui::project_picker_head()
                    .child(ui::project_picker_title(t("library.drive.title"), window))
                    .child(close),
            )
            .child(ui::project_picker_fine(t("library.drive.hint")))
            .child(search)
            .when(!self.state.message.is_empty(), |card| {
                card.child(ui::project_picker_paragraph(self.state.message.clone()))
            })
            .when(self.state.busy, |card| {
                card.child(ui::drive_projects_progress(
                    "drive-projects-progress",
                    self.state.progress,
                    self.state.message.clone(),
                ))
            })
            .child(rows);
        if self.pending_focus {
            self.pending_focus = false;
            self.focus("drive-projects-close", window, cx);
        } else if previous
            .as_ref()
            .is_some_and(|focus| focus.is_focused(window))
            && self.focused_control(window).is_none()
        {
            self.focus("drive-projects-close", window, cx);
        }
        ui::modal_scrim()
            .id("drive-projects-scrim")
            .a11y_dialog(crate::i18n::t("library.drive.title"))
            .on_click(cx.listener(|s, _, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .child(ui::project_picker_entrance(
                self.probe("drive-projects-card", card),
                elapsed / 0.25,
            ))
    }
}

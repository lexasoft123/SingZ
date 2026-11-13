//! Production LogPanel.tsx composition. Data is supplied by the host, never invented engine activity.
use crate::i18n::{t, tv};
use crate::a11y::DialogSurface;
use gpui_kit::base::SelectableText;
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};
actions!(
    singz_log_panel,
    [
        NextFocus,
        PreviousFocus,
        Activate,
        Dismiss,
        NextOption,
        PreviousOption
    ]
);
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DANGER, DIM, FAINT, LINE, PANEL_DEEP, TEXT};
use singz_uikit::{
    modal_card, production_scrollbar, select_field, select_option, select_popup, small_ghost_pill,
};

#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct LogRow {
    pub time: String,
    pub source: String,
    pub message: String,
    pub level: &'static str,
}
#[derive(Clone)]
pub struct LogSession {
    pub label: String,
    pub rows: Vec<LogRow>,
}
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize)]
pub struct Session {
    pub id: String,
    pub label: String,
}
pub enum LogEvent {
    Close,
    Save(Option<String>),
    Select(Option<String>),
}
type MeasurementKey = (u64, u32, u32, u32);
pub struct LogPanel {
    native: bool,
    open: bool,
    past: Vec<Session>,
    past_rows: Vec<LogRow>,
    selected_id: Option<String>,
    request: u64,
    loading: bool,
    total: usize,
    saved_to: Option<String>,
    scope: Option<FocusHandle>,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    keyboard: Rc<Cell<bool>>,
    popup_scroll: ScrollHandle,
    pending_focus: Option<String>,
    popup_dismissed_click: bool,
    bound_keys: bool,
    opened_at: Instant,
    open_sequence: u64,
    animation_time: Option<f32>,
    frame_pending: bool,
    document_revision: u64,
    measured_content: Option<(MeasurementKey, f32)>,
    measurement_pending: Option<MeasurementKey>,
    rows: Vec<LogRow>,
    sessions: Vec<LogSession>,
    selected: Option<usize>,
    popup: bool,
    copied: bool,
    copy_sequence: u64,
    scroll: ScrollHandle,
}
impl EventEmitter<LogEvent> for LogPanel {}
impl LogPanel {
    pub fn new() -> Self {
        Self {
            native: true,
            open: false,
            past: vec![],
            past_rows: vec![],
            selected_id: None,
            request: 0,
            loading: false,
            total: 0,
            saved_to: None,
            scope: None,
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            keyboard: Rc::new(Cell::new(false)),
            popup_scroll: ScrollHandle::new(),
            pending_focus: None,
            popup_dismissed_click: false,
            bound_keys: false,
            opened_at: Instant::now(),
            open_sequence: 0,
            animation_time: None,
            frame_pending: false,
            document_revision: 0,
            measured_content: None,
            measurement_pending: None,
            rows: vec![],
            sessions: vec![],
            selected: None,
            popup: false,
            copied: false,
            copy_sequence: 0,
            scroll: ScrollHandle::new(),
        }
    }
    pub fn on_open(&mut self, cx: &mut Context<Self>) {
        self.invalidate_measurement();
        // The source remount starts with no past-session options. Do not make
        // stale IDs selectable before this opening's inventory arrives.
        if self.native {
            self.past.clear();
        }
        self.open = true;
        self.open_sequence = self.open_sequence.wrapping_add(1);
        self.request = self.request.wrapping_add(1);
        self.selected_id = None;
        self.past_rows.clear();
        self.loading = false;
        self.total = 0;
        self.saved_to = None;
        self.opened_at = Instant::now();
        self.pending_focus = Some(
            if self.past.is_empty() {
                "log-copy"
            } else {
                "log-session"
            }
            .into(),
        );
        self.copy_sequence = self.copy_sequence.wrapping_add(1);
        self.selected = None;
        self.popup = false;
        self.popup_dismissed_click = false;
        self.copied = false;
        self.scroll.set_offset(point(px(0.), px(0.)));
        if self.native {
            self.scroll.scroll_to_bottom();
        }
        cx.notify();
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        let open = std::mem::take(&mut self.popup);
        if open {
            if self.native {
                self.pending_focus = Some("log-session".into());
            }
            cx.notify();
        }
        open
    }
    fn shown_rows(&self) -> &[LogRow] {
        if self.native {
            return if self.selected_id.is_some() {
                &self.past_rows
            } else {
                &self.rows
            };
        }
        self.selected
            .and_then(|i| self.sessions.get(i))
            .map(|s| s.rows.as_slice())
            .unwrap_or(&self.rows)
    }
    fn copy(&mut self, cx: &mut Context<Self>) {
        let text = self
            .shown_rows()
            .iter()
            .map(|r| format!("{} [{}] {}: {}", r.time, r.level, r.source, r.message))
            .collect::<Vec<_>>()
            .join("\n");
        cx.write_to_clipboard(ClipboardItem::new_string(text));
        self.copied = true;
        self.copy_sequence += 1;
        let sequence = self.copy_sequence;
        cx.notify();
        cx.spawn(async move |this, cx| {
            cx.background_executor()
                .timer(std::time::Duration::from_secs(2))
                .await;
            let _ = this.update(cx, |this, cx| {
                if this.copy_sequence == sequence {
                    this.copied = false;
                    cx.notify();
                }
            });
        })
        .detach();
    }
    #[cfg(feature = "ui-tests")]
    pub fn set_fixture(&mut self, rows: bool, sessions: bool, cx: &mut Context<Self>) {
        self.native = false;
        self.rows = if rows {
            (0..12)
                .map(|i| LogRow {
                    time: format!("12:00:{i:02}"),
                    source: if i % 3 == 0 { "catalog" } else { "interface" }.into(),
                    level: if i == 5 {
                        "warn"
                    } else if i == 9 {
                        "error"
                    } else {
                        "info"
                    },
                    message: if i == 5 {
                        "No audio backend is connected.".into()
                    } else if i == 9 {
                        "Example diagnostic error for visual review.".into()
                    } else {
                        format!("UI review fixture row {}.", i + 1)
                    },
                })
                .collect()
        } else {
            vec![]
        };
        self.sessions = if sessions {
            vec![LogSession {
                label: "Nov 5, 2026, 12:00 PM · 1 KB".into(),
                rows: self.rows.clone(),
            }]
        } else {
            vec![]
        };
        self.on_open(cx);
    }
    #[cfg(feature = "ui-tests")]
    pub fn snapshot(&self) -> (usize, Option<usize>, bool) {
        (self.shown_rows().len(), self.selected, self.popup)
    }
}
impl LogPanel {
    fn render_fixture(&mut self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let width = (f32::from(window.viewport_size().width) - 60.).min(860.);
        let rows = self.shown_rows();
        // Chromium quantizes scaled CSS line-height to 1/64 physical pixels.
        let dpr = window.scale_factor();
        let row_height = (18.7 * dpr * 64.).floor() / (dpr * 64.);
        let body_height = (rows.len() as f32 * row_height + 22.)
            .max(240.)
            .min((f32::from(window.viewport_size().height) - 177.5).max(240.));
        let total_height = body_height + 87.5;
        let has_sessions = !self.sessions.is_empty();
        let row_count = rows.len();
        let rendered_rows = rows
            .iter()
            .enumerate()
            .map(|(i, r)| {
                div()
                    .id(("log-row", i))
                    .flex()
                    .gap(px(10.))
                    .min_h(px(row_height))
                    .line_height(px(row_height))
                    .child(
                        div().flex_shrink_0().text_color(rgb(FAINT)).child(
                            SelectableText::new(("log-time", i), r.time.clone())
                                .document_order((i * 3) as u64),
                        ),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .min_w(px(52.))
                            .text_color(rgb(DIM))
                            .child(
                                SelectableText::new(("log-source", i), r.source.clone())
                                    .document_order((i * 3 + 1) as u64),
                            ),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .text_color(rgb(match r.level {
                                "warn" => ACCENT,
                                "error" => DANGER,
                                _ => TEXT,
                            }))
                            .child(
                                SelectableText::new(("log-message", i), r.message.clone())
                                    .document_order((i * 3 + 2) as u64),
                            ),
                    )
            })
            .collect::<Vec<_>>();
        let title = div()
            .font_family("SingZ Display 800")
            .text_size(px(21.))
            .line_height(px(25.))
            .child(t("library.logPanel.title"));
        let card = modal_card()
            .id("log-card")
            .w(px(width))
            .h(px(total_height))
            .px(px(24.))
            .py(px(22.))
            .child(
                div()
                    .flex()
                    .gap(px(12.))
                    .h(px(29.5))
                    .flex_shrink_0()
                    .mb(px(12.))
                    .child(title)
                    .when(has_sessions, |head| {
                        head.child(
                            div()
                                .relative()
                                .mt(px(1.5))
                                .child(
                                    select_field(
                                        "log-session",
                                        self.selected
                                            .map(|i| self.sessions[i].label.clone())
                                            .unwrap_or_else(|| t("library.logPanel.thisSession")),
                                    )
                                    .w(px(230.))
                                    .h(px(26.))
                                    .on_click(cx.listener(
                                        |this, _, _, cx| {
                                            this.popup = !this.popup;
                                            cx.notify();
                                        },
                                    )),
                                )
                                .when(self.popup, |container| {
                                    container.child(
                                        deferred(
                                            select_popup()
                                                .absolute()
                                                .top(px(29.))
                                                .left_0()
                                                .w(px(260.))
                                                .child(
                                                    select_option(
                                                        "log-session-current",
                                                        t("library.logPanel.thisSession"),
                                                        self.selected.is_none(),
                                                    )
                                                    .on_click(cx.listener(|this, _, _, cx| {
                                                        this.selected = None;
                                                        this.popup = false;
                                                        this.scroll.scroll_to_bottom();
                                                        cx.notify();
                                                    })),
                                                )
                                                .children(self.sessions.iter().enumerate().map(
                                                    |(i, s)| {
                                                        select_option(
                                                            ("log-session-option", i),
                                                            s.label.clone(),
                                                            self.selected == Some(i),
                                                        )
                                                        .on_click(cx.listener(
                                                            move |this, _, _, cx| {
                                                                this.selected = Some(i);
                                                                this.popup = false;
                                                                this.scroll.scroll_to_bottom();
                                                                cx.notify();
                                                            },
                                                        ))
                                                    },
                                                )),
                                        )
                                        .with_priority(100),
                                    )
                                }),
                        )
                    })
                    .child(
                        div()
                            .mt(px(8.5))
                            .text_size(px(12.))
                            .line_height(px(14.))
                            .text_color(rgb(FAINT))
                            .child(tv(
                                "library.logPanel.linesCount",
                                &[("n", row_count.to_string())],
                            )),
                    )
                    .child(div().flex_1())
                    .child(
                        div()
                            .flex()
                            .gap(px(8.))
                            .mt(px(1.5))
                            .child(
                                small_ghost_pill(
                                    "log-copy",
                                    t(if self.copied {
                                        "library.logPanel.copied"
                                    } else {
                                        "library.logPanel.copy"
                                    }),
                                )
                                .line_height(px(14.))
                                .on_click(cx.listener(|this, _, _, cx| this.copy(cx))),
                            )
                            .child(
                                small_ghost_pill("log-save", t("library.logPanel.saveToFile"))
                                    .line_height(px(14.))
                                    .on_click(
                                        cx.listener(|_, _, _, cx| cx.emit(LogEvent::Save(None))),
                                    ),
                            )
                            .child(
                                small_ghost_pill("log-close", t("library.common.close"))
                                    .line_height(px(14.))
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(LogEvent::Close))),
                            ),
                    ),
            )
            .child(
                div()
                    .relative()
                    .flex_1()
                    .min_h_0()
                    .rounded(px(10.))
                    .border_1()
                    .border_color(rgba(LINE))
                    .bg(rgb(PANEL_DEEP))
                    .child(
                        div()
                            .id("log-body")
                            .size_full()
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .px(px(12.))
                            .py(px(10.))
                            .font_family("SingZ Mono 400")
                            .text_size(px(11.))
                            .line_height(px(row_height))
                            .when(row_count == 0, |body| {
                                body.child(
                                    div()
                                        .py(px(8.))
                                        .px(px(2.))
                                        .text_color(rgb(FAINT))
                                        .child(t("library.logPanel.nothingLogged")),
                                )
                            })
                            .children(rendered_rows),
                    )
                    .child(production_scrollbar(&self.scroll)),
            );
        // App-scoped scrim dismissal, with the exact centered card bounds.
        let viewport = window.viewport_size();
        let left = (f32::from(viewport.width) - width) / 2.;
        let top = (f32::from(viewport.height) - total_height) / 2.;
        singz_uikit::modal_scrim()
            .id("log-scrim")
            .a11y_dialog(crate::i18n::t("library.logPanel.title"))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |_, e: &MouseDownEvent, _, cx| {
                    if !Bounds::new(point(px(left), px(top)), size(px(width), px(total_height)))
                        .contains(&e.position)
                    {
                        cx.emit(LogEvent::Close);
                        cx.stop_propagation();
                    }
                }),
            )
            .child(card)
            .into_any_element()
    }
}

const MAX_ROWS: usize = 4000;
impl LogPanel {
    fn invalidate_measurement(&mut self) {
        self.document_revision = self.document_revision.wrapping_add(1);
        self.measured_content = None;
        self.measurement_pending = None;
    }
    fn measurement_key(&self, w: &Window) -> MeasurementKey {
        (
            self.document_revision,
            f32::from(w.viewport_size().width).to_bits(),
            f32::from(w.viewport_size().height).to_bits(),
            w.scale_factor().to_bits(),
        )
    }
    fn schedule_measurement(
        &mut self,
        key: MeasurementKey,
        row_count: usize,
        w: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self
            .measured_content
            .is_some_and(|(cached, _)| cached == key)
            || self.measurement_pending == Some(key)
        {
            return;
        }
        self.measurement_pending = Some(key);
        let weak = cx.weak_entity();
        w.on_next_frame(move |w, cx| {
            let _ = weak.update(cx, |s, cx| {
                if !s.open
                    || !s.native
                    || s.measurement_key(w) != key
                    || s.measurement_pending != Some(key)
                {
                    return;
                }
                // Child spans describe the actual laid-out rows, including
                // wrapped text. Neither the scroll viewport nor a measurement
                // canvas contributes to this intrinsic content height.
                let height = if row_count == 0 {
                    Some(0.)
                } else if s.scroll.children_count() == row_count {
                    s.scroll
                        .bounds_for_item(0)
                        .zip(s.scroll.bounds_for_item(row_count - 1))
                        .map(|(first, last)| f32::from(last.bottom() - first.top()).max(0.))
                } else {
                    None
                };
                s.measurement_pending = None;
                if let Some(height) = height.filter(|h| h.is_finite()) {
                    if s.following() {
                        s.scroll.scroll_to_bottom();
                    }
                    s.measured_content = Some((key, height));
                }
                cx.notify();
            });
        });
        w.request_animation_frame();
    }
    pub fn selected_session(&self) -> Option<&str> {
        self.selected_id.as_deref()
    }
    pub fn selection_request(&self) -> u64 {
        self.request
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn open_sequence(&self) -> u64 {
        self.open_sequence
    }
    pub fn set_live_rows(&mut self, mut rows: Vec<LogRow>, cx: &mut Context<Self>) {
        if rows.len() > MAX_ROWS {
            rows.drain(..rows.len() - MAX_ROWS);
        }
        if self.native && self.rows == rows {
            return;
        }
        let follow = self.following();
        self.native = true;
        self.rows = rows;
        if self.selected_id.is_none() {
            self.invalidate_measurement();
        }
        if self.selected_id.is_none() && follow {
            self.scroll.scroll_to_bottom();
        }
        cx.notify();
    }
    pub fn append_live(&mut self, row: LogRow, cx: &mut Context<Self>) {
        let follow = self.following();
        self.native = true;
        self.rows.push(row);
        if self.rows.len() > MAX_ROWS {
            self.rows.drain(..self.rows.len() - MAX_ROWS);
        }
        if self.selected_id.is_none() {
            self.invalidate_measurement();
        }
        if self.selected_id.is_none() && follow {
            self.scroll.scroll_to_bottom();
            cx.notify();
        } else if self.selected_id.is_none() {
            cx.notify();
        }
    }
    pub fn set_sessions(&mut self, sessions: Vec<Session>, cx: &mut Context<Self>) {
        if self.native && self.past == sessions {
            return;
        }
        self.native = true;
        self.past = sessions;
        cx.notify();
    }
    pub fn set_session_rows(
        &mut self,
        id: &str,
        request: u64,
        mut rows: Vec<LogRow>,
        total: usize,
        cx: &mut Context<Self>,
    ) -> bool {
        if !self.open || self.selected_id.as_deref() != Some(id) || self.request != request {
            return false;
        }
        if rows.len() > MAX_ROWS {
            rows.drain(..rows.len() - MAX_ROWS);
        }
        self.total = total.max(rows.len());
        self.past_rows = rows;
        self.invalidate_measurement();
        self.loading = false;
        self.scroll.scroll_to_bottom();
        cx.notify();
        true
    }
    pub fn saved_to(&mut self, path: String, cx: &mut Context<Self>) {
        self.saved_to = Some(path);
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        self.open = false;
        self.request = self.request.wrapping_add(1);
        self.popup = false;
        self.copy_sequence = self.copy_sequence.wrapping_add(1);
        self.bounds.borrow_mut().clear();
        cx.emit(LogEvent::Close);
        cx.notify();
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        if self.native && id == "log-body" && self.open {
            // A canvas inside scrolling content moves with its offset and can
            // itself enlarge the padded content. The handle owns the actual,
            // unscrolled viewport bounds recorded during layout.
            return self
                .bounds
                .borrow()
                .contains_key("log-card")
                .then(|| self.scroll.bounds());
        }
        if self.native && id == "log-session-popup" && self.open && self.popup {
            return self
                .bounds
                .borrow()
                .contains_key("log-card")
                .then(|| self.popup_scroll.bounds());
        }
        self.bounds.borrow().get(id).copied()
    }
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|s| s.max(0.));
        cx.notify();
    }
    fn following(&self) -> bool {
        self.scroll.max_offset().y + self.scroll.offset().y < px(40.)
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        let copy_text = self
            .shown_rows()
            .iter()
            .map(|r| format!("{} [{}] {}: {}", r.time, r.level, r.source, r.message))
            .collect::<Vec<_>>()
            .join("\n");
        serde_json::json!({"open":self.open,"selectedSession":self.selected_id,"selectionRequest":self.request,"openSequence":self.open_sequence,
            "loading":self.loading,"rowCount":self.shown_rows().len(),"total":if self.selected_id.is_some(){self.total}else{self.rows.len()},
            "copied":self.copied,"copySequence":self.copy_sequence,"savedTo":self.saved_to,"popup":self.popup,
            "focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),
            "focusInside":self.scope.as_ref().is_some_and(|f|f.contains_focused(w,cx)),"focusOrder":self.order.borrow().clone(),
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],
            "maxScrollOffset":[f32::from(self.scroll.max_offset().x),f32::from(self.scroll.max_offset().y)],"follow":self.following(),
            "rows":self.shown_rows(),"copyText":copy_text,"sessions":self.past,
            "documentRevision":self.document_revision,"measuredContentHeight":self.measured_content.filter(|(key,_)|*key==self.measurement_key(w)).map(|(_,h)|h)})
    }
    fn select(&mut self, id: Option<String>, cx: &mut Context<Self>) {
        self.invalidate_measurement();
        self.selected_id = id.clone();
        self.request = self.request.wrapping_add(1);
        self.past_rows.clear();
        self.total = 0;
        self.loading = id.is_some();
        self.popup = false;
        self.pending_focus = Some("log-session".into());
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.scroll.scroll_to_bottom();
        cx.emit(LogEvent::Select(id));
        cx.notify();
    }
    fn toggle_popup(&mut self, cx: &mut Context<Self>) {
        self.popup = !self.popup;
        if self.popup {
            self.pending_focus = Some(
                self.selected_id
                    .as_ref()
                    .and_then(|id| self.past.iter().position(|s| &s.id == id))
                    .map(|i| format!("log-session-option-{i}"))
                    .unwrap_or("log-session-current".into()),
            );
        } else {
            self.pending_focus = Some("log-session".into());
        }
        cx.notify();
    }
    fn activate_control(&mut self, id: &str, cx: &mut Context<Self>) {
        match id {
            "log-session" => self.toggle_popup(cx),
            "log-session-current" => self.select(None, cx),
            "log-copy" => self.copy(cx),
            "log-save" => cx.emit(LogEvent::Save(self.selected_id.clone())),
            "log-close" => self.close(cx),
            _ => {
                if let Some(index) = id
                    .strip_prefix("log-session-option-")
                    .and_then(|i| i.parse::<usize>().ok())
                {
                    if let Some(session) = self.past.get(index) {
                        self.select(Some(session.id.clone()), cx);
                    }
                }
            }
        }
    }
    fn move_focus(&mut self, backwards: bool, w: &mut Window, cx: &mut Context<Self>) {
        self.keyboard.set(true);
        let order = self.order.borrow().clone();
        if order.is_empty() {
            return;
        }
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
        if self.popup {
            self.popup_scroll.scroll_to_item(index);
        }
        cx.notify();
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
            self.activate_control(&id, cx);
        }
    }
    fn dismiss(&mut self, cx: &mut Context<Self>) {
        if self.dismiss_popup(cx) {
            self.pending_focus = Some("log-session".into());
        } else {
            self.close(cx);
        }
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
    fn control(
        &self,
        id: &str,
        d: Stateful<Div>,
        option: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        if self.popup == option {
            self.order.borrow_mut().push(id.into());
        }
        let click_id = id.to_owned();
        let mouse_id = id.to_owned();
        let mouse_focus = focus.clone();
        self.probe(
            id,
            d.track_focus(&focus)
                .child(ui::guide_focus_ring(focus, self.keyboard.clone(), 2.))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| {
                        s.keyboard.set(false);
                        if s.popup && !option && mouse_id != "log-session" {
                            s.dismiss_popup(cx);
                            s.popup_dismissed_click = true;
                            s.pending_focus = Some("log-session".into());
                        } else {
                            mouse_focus.focus(w, cx);
                        }
                        cx.stop_propagation();
                    }),
                )
                .on_click(cx.listener(move |s, _, _, cx| {
                    if std::mem::take(&mut s.popup_dismissed_click) {
                        cx.stop_propagation();
                        return;
                    }
                    s.activate_control(&click_id, cx);
                    cx.stop_propagation();
                })),
        )
    }
    fn render_native(&mut self, w: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        if !self.bound_keys {
            self.bound_keys = true;
            cx.bind_keys([
                KeyBinding::new("tab", NextFocus, Some("SingZLogPanel")),
                KeyBinding::new("shift-tab", PreviousFocus, Some("SingZLogPanel")),
                KeyBinding::new("enter", Activate, Some("SingZLogPanel")),
                KeyBinding::new("space", Activate, Some("SingZLogPanel")),
                KeyBinding::new("escape", Dismiss, Some("SingZLogPanel")),
                KeyBinding::new("down", NextOption, Some("SingZLogPanel")),
                KeyBinding::new("up", PreviousOption, Some("SingZLogPanel")),
            ]);
        }
        let scope = self.scope.get_or_insert_with(|| cx.focus_handle()).clone();
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
        let dpr = w.scale_factor();
        let row_height = (18.7 * dpr * 64.).floor() / (dpr * 64.);
        let row_count = self.shown_rows().len();
        let saved_height = if self.saved_to.is_some() { 29.8 } else { 0. };
        let key = self.measurement_key(w);
        let content_height = self
            .measured_content
            .filter(|(measured_key, _)| *measured_key == key)
            .map(|(_, height)| height)
            .unwrap_or(row_count as f32 * row_height);
        self.schedule_measurement(key, row_count, w, cx);
        let body_height = (content_height + 22.)
            .max(240.)
            .min((f32::from(w.viewport_size().height) - 177.5 - saved_height).max(240.));
        let mut head = ui::log_head().child(ui::log_title_label(t("library.logPanel.title")));
        if !self.past.is_empty() {
            let label = self
                .selected_id
                .as_ref()
                .and_then(|id| self.past.iter().find(|s| &s.id == id))
                .map(|s| s.label.clone())
                .unwrap_or_else(|| t("library.logPanel.thisSession"));
            let options = std::iter::once(t("library.logPanel.thisSession"))
                .chain(self.past.iter().map(|s| s.label.clone()))
                .collect::<Vec<_>>();
            let mut picker = div().relative().self_center().child(self.control(
                "log-session",
                ui::log_session(label, &options, w),
                false,
                cx,
            ));
            if self.popup {
                let mut popup = ui::log_popup()
                    .key_context("SingZLogPanel")
                    .track_scroll(&self.popup_scroll)
                    .child(self.control(
                        "log-session-current",
                        ui::log_option(
                            "log-session-current",
                            t("library.logPanel.thisSession"),
                            self.selected_id.is_none(),
                        ),
                        true,
                        cx,
                    ));
                for (index, session) in self.past.iter().enumerate() {
                    let id = format!("log-session-option-{index}");
                    popup = popup.child(self.control(
                        &id,
                        ui::log_option(
                            id.clone(),
                            session.label.clone(),
                            self.selected_id.as_ref() == Some(&session.id),
                        ),
                        true,
                        cx,
                    ));
                }
                picker = picker.child(deferred(popup).with_priority(100));
            }
            head = head.child(picker);
        }
        let count = if self.selected_id.is_some() && self.total > row_count {
            tv(
                "library.logPanel.linesTail",
                &[
                    ("shown", row_count.to_string()),
                    ("total", self.total.to_string()),
                ],
            )
        } else {
            tv(
                "library.logPanel.linesCount",
                &[("n", row_count.to_string())],
            )
        };
        head = head.child(ui::log_count(count)).child(
            ui::log_actions()
                .child(self.control(
                    "log-copy",
                    ui::log_action(
                        "log-copy",
                        t(if self.copied {
                            "library.logPanel.copied"
                        } else {
                            "library.logPanel.copy"
                        }),
                    ),
                    false,
                    cx,
                ))
                .child(self.control(
                    "log-save",
                    ui::log_action("log-save", t("library.logPanel.saveToFile")),
                    false,
                    cx,
                ))
                .child(self.control(
                    "log-close",
                    ui::log_action("log-close", t("library.common.close")),
                    false,
                    cx,
                )),
        );
        let rows = self
            .shown_rows()
            .iter()
            .enumerate()
            .map(|(i, r)| {
                ui::log_row(
                    i,
                    r.time.clone(),
                    r.source.clone(),
                    r.message.clone(),
                    r.level,
                    row_height,
                )
            })
            .collect::<Vec<_>>();
        let body = ui::log_body(&self.scroll, row_height)
            .when(row_count == 0, |d| {
                d.child(ui::log_empty_label(t(if self.selected_id.is_some() {
                    "library.logPanel.loading"
                } else {
                    "library.logPanel.nothingLogged"
                })))
            })
            .children(rows);
        let mut card = ui::log_card(w.viewport_size(), body_height + 87.5 + saved_height)
            .key_context("SingZLogPanel")
            .track_focus(&scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                if crate::overlay_gate::owns_input() { return; }
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                if crate::overlay_gate::owns_input() { return; }
                s.move_focus(true, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &Activate, w, cx| {
                if crate::overlay_gate::owns_input() { return; }
                s.activate_focused(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &Dismiss, _, cx| {
                if crate::overlay_gate::owns_input() { return; }
                s.dismiss(cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &NextOption, w, cx| {
                if crate::overlay_gate::owns_input() { return; }
                if s.popup {
                    s.move_focus(false, w, cx);
                } else if s
                    .controls
                    .borrow()
                    .get("log-session")
                    .is_some_and(|f| f.is_focused(w))
                {
                    s.toggle_popup(cx);
                }
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousOption, w, cx| {
                if crate::overlay_gate::owns_input() { return; }
                if s.popup {
                    s.move_focus(true, w, cx);
                } else if s
                    .controls
                    .borrow()
                    .get("log-session")
                    .is_some_and(|f| f.is_focused(w))
                {
                    s.toggle_popup(cx);
                }
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, _, w, cx| {
                    if s.popup {
                        s.dismiss_popup(cx);
                        s.pending_focus = Some("log-session".into());
                    } else if let Some(f) = &s.scope {
                        f.focus(w, cx);
                    }
                    cx.stop_propagation();
                }),
            )
            .on_click(|_, _, cx| cx.stop_propagation())
            .child(head)
            .child(
                ui::log_body_surface()
                    .child(body)
                    .child(production_scrollbar(&self.scroll)),
            );
        if let Some(path) = &self.saved_to {
            card = card.child(ui::log_saved_label(tv(
                "library.logPanel.savedTo",
                &[("path", path.clone())],
            )));
        }
        // Taking focus waits while an overlay owns input (a source job or a load in front of this page, a notice): the
        // request stays pending and runs when the player root renders without an owner.
        if self.pending_focus.is_some() && !crate::overlay_gate::owns_input() {
          if let Some(id) = self.pending_focus.take() {
            if let Some(f) = self.controls.borrow().get(&id) {
                f.focus(w, cx);
            }
            let sequence = self.open_sequence;
            let weak = cx.weak_entity();
            w.on_next_frame(move |w, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if s.open
                        && s.open_sequence == sequence
                        && !crate::overlay_gate::owns_input()
                        && s.scope.as_ref().is_some_and(|f| !f.contains_focused(w, cx))
                    {
                        if let Some(f) = s.controls.borrow().get(&id) {
                            f.focus(w, cx);
                        }
                        cx.notify();
                    }
                });
            });
            w.request_animation_frame();
          }
        }
        ui::modal_scrim()
            .id("log-scrim")
            .a11y_dialog(crate::i18n::t("library.logPanel.title"))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|s, _, _, cx| {
                    s.dismiss(cx);
                    cx.stop_propagation();
                }),
            )
            .child(ui::log_entrance(
                self.probe("log-card", card),
                elapsed / 0.25,
            ))
            .into_any_element()
    }
}
impl Render for LogPanel {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.native {
            self.render_native(w, cx)
        } else {
            self.render_fixture(w, cx)
        }
    }
}

impl crate::overlay_gate::DefaultFocus for LogPanel {
    fn request_default_focus(&mut self, cx: &mut Context<Self>) {
        self.pending_focus = Some(if self.past.is_empty() { "log-copy" } else { "log-session" }.into());
        cx.notify();
    }
    fn focus_inside(&self, window: &Window, cx: &App) -> bool { self.scope.as_ref().is_some_and(|f| f.contains_focused(window, cx)) }
}

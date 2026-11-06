//! Production LogPanel.tsx composition. Data is supplied by the host, never invented engine activity.
use gpui_kit::base::SelectableText;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DANGER, DIM, FAINT, LINE, PANEL_DEEP, TEXT};
use singz_uikit::{
    modal_card, production_scrollbar, select_field, select_option, select_popup, small_ghost_pill,
};

#[derive(Clone)]
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
pub enum LogEvent {
    Close,
    Save,
}
pub struct LogPanel {
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
        self.selected = None;
        self.popup = false;
        self.copied = false;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        let open = std::mem::take(&mut self.popup);
        if open {
            cx.notify();
        }
        open
    }
    fn shown_rows(&self) -> &[LogRow] {
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
impl Render for LogPanel {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
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
            .child("Log");
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
                                            .unwrap_or("This session".into()),
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
                                                        "This session",
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
                            .child(format!("{row_count} lines")),
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
                                    if self.copied { "Copied ✓" } else { "Copy" },
                                )
                                .line_height(px(14.))
                                .on_click(cx.listener(|this, _, _, cx| this.copy(cx))),
                            )
                            .child(
                                small_ghost_pill("log-save", "Save to file…")
                                    .line_height(px(14.))
                                    .on_click(cx.listener(|_, _, _, cx| cx.emit(LogEvent::Save))),
                            )
                            .child(
                                small_ghost_pill("log-close", "Close")
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
                                        .child("Nothing logged yet."),
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
    }
}

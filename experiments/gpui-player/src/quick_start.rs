//! Contextual desktop tour, using the production copy and shared placement rules.
use crate::guide_layout::{self, Rect, Side, Viewport};
use crate::quick_start_store::{retain_seen, seen};
use gpui_kit::{prelude::FluentBuilder, *};
use std::{cell::Cell, rc::Rc, sync::OnceLock};
actions!(
    singz_quick_start,
    [NextFocus, PreviousFocus, Activate, Dismiss]
);
pub fn init(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", NextFocus, Some("SingZQuickStart")),
        KeyBinding::new("shift-tab", PreviousFocus, Some("SingZQuickStart")),
        KeyBinding::new("enter", Activate, Some("SingZQuickStart")),
        KeyBinding::new("space", Activate, Some("SingZQuickStart")),
        KeyBinding::new("escape", Dismiss, Some("SingZQuickStart")),
    ]);
}
fn all_copy() -> &'static serde_json::Value {
    static COPY: OnceLock<serde_json::Value> = OnceLock::new();
    COPY.get_or_init(|| {
        serde_json::from_str(include_str!("quick_start_copy.json"))
            .expect("generated Quick start copy")
    })
}
fn copy_locale() -> &'static str {
    if crate::i18n::current().as_str() == "ru" {
        "ru"
    } else {
        "en"
    }
}
fn copy() -> &'static serde_json::Value {
    &all_copy()[copy_locale()]
}
fn text(key: &str) -> String {
    copy()[key].as_str().unwrap().into()
}
#[derive(Clone)]
struct Step {
    target: &'static str,
    title: String,
    body: String,
}
fn step(target: &'static str) -> Step {
    let key = match target {
        "browse" => "library",
        "saved" => "saved",
        "split" => "split",
        "stems" => "stems",
        "lyrics" => "lyrics",
        "karaoke" => "karaoke",
        "loop" | "tempo" => "practice",
        "training" => "training",
        "sync" => "sync",
        _ => "settings",
    };
    let tuple = if matches!(key, "saved" | "karaoke") {
        &copy()[key]
    } else {
        &copy()["steps"][key]
    };
    Step {
        target,
        title: if target == "tempo" {
            text("tempo")
        } else {
            tuple[0].as_str().unwrap().into()
        },
        body: if target == "loop" {
            text("loop")
        } else {
            tuple[1].as_str().unwrap().into()
        },
    }
}
#[derive(Clone, Copy)]
pub enum Event {
    Target(&'static str),
    Closed,
}
impl EventEmitter<Event> for QuickStart {}
pub struct QuickStart {
    pub anchors: singz_uikit::GuideAnchors,
    open: bool,
    index: isize,
    steps: Vec<Step>,
    pending_welcome: bool,
    keyboard: Rc<Cell<bool>>,
    scope: FocusHandle,
    heading: FocusHandle,
    buttons: [FocusHandle; 3],
    focus_heading: bool,
    height: Rc<Cell<f32>>,
    scroll: ScrollHandle,
    #[cfg(feature = "ui-tests")]
    pub shade_visible: bool,
    #[cfg(feature = "ui-tests")]
    pub bounds: Rc<std::cell::RefCell<std::collections::HashMap<&'static str, Bounds<Pixels>>>>,
}
impl QuickStart {
    pub fn new(_: &mut Window, cx: &mut Context<Self>) -> Self {
        let weak = cx.weak_entity();
        let queued = Rc::new(Cell::new(false));
        let anchors = singz_uikit::GuideAnchors::new(move |w, _| {
            if !queued.replace(true) {
                let weak = weak.clone();
                let queued = queued.clone();
                w.on_next_frame(move |_, cx| {
                    queued.set(false);
                    let _ = weak.update(cx, |_, cx| cx.notify());
                });
            }
        });
        Self {
            anchors,
            open: false,
            index: 0,
            steps: vec![],
            pending_welcome: !seen(&crate::audio_devices::directory()),
            keyboard: Rc::new(Cell::new(false)),
            scope: cx.focus_handle(),
            heading: cx.focus_handle(),
            buttons: std::array::from_fn(|_| cx.focus_handle()),
            focus_heading: false,
            height: Rc::new(Cell::new(260.)),
            scroll: ScrollHandle::new(),
            #[cfg(feature = "ui-tests")]
            shade_visible: true,
            #[cfg(feature = "ui-tests")]
            bounds: Default::default(),
        }
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn pending_welcome(&self) -> bool {
        self.pending_welcome
    }
    pub fn open(&mut self, welcome: bool, targets: &[&'static str], cx: &mut Context<Self>) {
        self.steps = targets
            .iter()
            .filter(|id| {
                self.anchors
                    .get(id)
                    .is_some_and(|b| b.size.width > px(0.) && b.size.height > px(0.))
            })
            .map(|id| step(id))
            .collect();
        self.pending_welcome = false;
        self.index = if welcome { -1 } else { 0 };
        self.open = true;
        self.anchors.set_active(true);
        self.focus_heading = true;
        self.height.set(260.);
        self.scroll.set_offset(point(px(0.), px(0.)));
        if !welcome {
            self.reveal(cx);
        }
        cx.notify();
    }
    fn reveal(&self, cx: &mut Context<Self>) {
        if let Some(step) = self.steps.get(self.index.max(0) as usize) {
            cx.emit(Event::Target(step.target));
        }
    }
    fn close(&mut self, cx: &mut Context<Self>) {
        self.open = false;
        self.anchors.set_active(false);
        if let Err(e) = retain_seen(&crate::audio_devices::directory()) {
            eprintln!("Quick start dismissal could not be stored: {e}");
        }
        cx.emit(Event::Closed);
        cx.notify();
    }
    fn advance(&mut self, back: bool, cx: &mut Context<Self>) {
        if !back && self.index == self.steps.len() as isize - 1 {
            self.close(cx);
            return;
        }
        self.index = if back {
            (self.index - 1).max(0)
        } else {
            self.index + 1
        };
        self.keyboard.set(false);
        self.focus_heading = true;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.reveal(cx);
        cx.notify();
    }
    fn move_focus(&mut self, back: bool, w: &mut Window, cx: &mut Context<Self>) {
        self.keyboard.set(true);
        let indexes = if self.index > 0 {
            vec![0, 1, 2]
        } else {
            vec![0, 2]
        };
        let current = indexes.iter().position(|i| self.buttons[*i].is_focused(w));
        let at = match current {
            Some(at) => {
                if back {
                    (at + indexes.len() - 1) % indexes.len()
                } else {
                    (at + 1) % indexes.len()
                }
            }
            None => {
                if back {
                    indexes.len() - 1
                } else {
                    0
                }
            }
        };
        self.buttons[indexes[at]].focus(w, cx);
        cx.notify();
    }
    fn activate(&mut self, w: &mut Window, cx: &mut Context<Self>) {
        if self.buttons[0].is_focused(w) {
            self.close(cx)
        } else if self.buttons[1].is_focused(w) && self.index > 0 {
            self.advance(true, cx)
        } else if self.buttons[2].is_focused(w) {
            self.advance(false, cx)
        }
    }
    fn button(
        &self,
        id: &'static str,
        label: String,
        focus: usize,
        primary: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let d = singz_uikit::guide_button(id, label, primary).child(singz_uikit::guide_focus_ring(
            self.buttons[focus].clone(),
            self.keyboard.clone(),
            if primary { 0. } else { 1. },
        ));
        let d = d
            .track_focus(&self.buttons[focus])
            .on_click(cx.listener(move |s, _, _, cx| match focus {
                0 => s.close(cx),
                1 => s.advance(true, cx),
                _ => s.advance(false, cx),
            }));
        #[cfg(feature = "ui-tests")]
        {
            let bounds = self.bounds.clone();
            return d.relative().child(
                canvas(
                    move |b, _, _| {
                        bounds.borrow_mut().insert(id, b);
                        b
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        #[cfg(not(feature = "ui-tests"))]
        d
    }
    #[cfg(feature = "ui-tests")]
    pub fn focus_index(&self, w: &Window) -> Option<usize> {
        self.buttons.iter().position(|h| h.is_focused(w))
    }
    fn display_copy(&self) -> (String, String) {
        if self.index < 0 {
            return (text("welcome"), text("intro"));
        }
        self.steps.get(self.index as usize).map_or_else(
            || (text("welcome"), text("intro")),
            |selected| {
                // Stable targets retain position; resolve source copy at display
                // time, including a locale change while the tour stays open.
                let current = step(selected.target);
                (current.title, current.body)
            },
        )
    }
    #[cfg(feature = "ui-tests")]
    pub fn snapshot(&self) -> serde_json::Value {
        let (title, body) = self.display_copy();
        serde_json::json!({"open":self.open,"index":self.index,"targets":self.steps.iter().map(|s|s.target).collect::<Vec<_>>(),
            "title":title,"body":body,"copyLocale":copy_locale(),"tourTitle":text("title")})
    }
}
impl Render for QuickStart {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        if self.focus_heading {
            let heading = self.heading.clone();
            w.on_next_frame(move |w, cx| heading.focus(w, cx));
            self.focus_heading = false;
        }
        let width = f32::from(w.viewport_size().width);
        let height = f32::from(w.viewport_size().height);
        let target = if self.index < 0 {
            None
        } else {
            self.steps
                .get(self.index as usize)
                .and_then(|s| self.anchors.get(s.target))
        };
        let hole = target.and_then(|b| {
            let left = 4_f32.max(f32::from(b.left()) - 5.);
            let top = 4_f32.max(f32::from(b.top()) - 5.);
            let right = (width - 4.).min(f32::from(b.right()) + 5.);
            let bottom = (height - 4.).min(f32::from(b.bottom()) + 5.);
            (right > left && bottom > top).then(|| {
                Bounds::new(
                    point(px(left), px(top)),
                    size(px(right - left), px(bottom - top)),
                )
            })
        });
        let rect = hole.map(|b| Rect {
            left: f32::from(b.left()),
            top: f32::from(b.top()),
            width: f32::from(b.size.width),
            height: f32::from(b.size.height),
        });
        let p = guide_layout::place(
            rect,
            Viewport {
                width,
                height,
                top: 0.,
                bottom: 0.,
            },
            self.height.get(),
        );
        let (title, body) = self.display_copy();
        let measured = self.height.clone();
        let weak = cx.weak_entity();
        let last = self.index == self.steps.len() as isize - 1;
        let content = div()
            .relative()
            .flex()
            .flex_col()
            .flex_shrink_0()
            .p(px(20.))
            .child(
                div()
                    .text_size(px(12.))
                    .line_height(px(14.5))
                    .text_color(rgb(0xffa028))
                    .mb(px(10.))
                    .child(if self.index < 0 {
                        text("title")
                    } else {
                        format!(
                            "{} · {} / {}",
                            text("title"),
                            self.index + 1,
                            self.steps.len()
                        )
                    }),
            )
            .child(
                div()
                    .track_focus(&self.heading)
                    .text_size(px(21.))
                    .line_height(px(26.25))
                    .font_family(singz_uikit::tokens::DISPLAY_700)
                    .mb(px(12.))
                    .child(title),
            )
            .child(
                div()
                    .text_size(px(14.))
                    .line_height(px(22.4))
                    .mb(px(20.))
                    .child(body),
            )
            .child(
                div()
                    .flex()
                    .flex_wrap()
                    .items_center()
                    .justify_between()
                    .gap(px(6.))
                    .child(self.button(
                        "guide-skip",
                        text(if self.index < 0 { "later" } else { "skip" }),
                        0,
                        false,
                        cx,
                    ))
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(6.))
                            .when(self.index > 0, |d| {
                                d.child(self.button("guide-back", text("back"), 1, false, cx))
                            })
                            .child(self.button(
                                "guide-next",
                                text(if self.index < 0 {
                                    "start"
                                } else if last {
                                    "done"
                                } else {
                                    "next"
                                }),
                                2,
                                true,
                                cx,
                            )),
                    ),
            )
            .child(
                canvas(
                    move |b, w, _| {
                        let value = f32::from(b.size.height);
                        if (measured.get() - value).abs() > 0.1 {
                            measured.set(value);
                            let weak = weak.clone();
                            w.on_next_frame(move |_, cx| {
                                let _ = weak.update(cx, |_, cx| cx.notify());
                            });
                        }
                        b
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        let keyboard = self.keyboard.clone();
        div()
            .id("quick-start-overlay")
            .key_context("SingZQuickStart")
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
                s.activate(w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &Dismiss, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .absolute()
            .inset_0()
            .occlude()
            .on_mouse_down(MouseButton::Left, move |_, _, cx| {
                keyboard.set(false);
                cx.stop_propagation();
            })
            .on_key_down(|_, _, cx| cx.stop_propagation())
            .when(
                {
                    #[cfg(feature = "ui-tests")]
                    {
                        self.shade_visible
                    }
                    #[cfg(not(feature = "ui-tests"))]
                    {
                        true
                    }
                },
                |d| d.child(singz_uikit::guide_shade(hole)),
            )
            .child(
                singz_uikit::guide_balloon()
                    .absolute()
                    .left(px(p.left))
                    .top(px(p.top))
                    .w(px(p.width))
                    .max_h(px(p.max_height))
                    .when(hole.is_some(), |d| {
                        d.child(singz_uikit::guide_arrow(
                            match p.side {
                                Side::Top => "top",
                                Side::Bottom => "bottom",
                                Side::Left => "left",
                                _ => "right",
                            },
                            p.arrow,
                        ))
                    })
                    .when(cfg!(feature = "ui-tests"), |d| {
                        #[cfg(feature = "ui-tests")]
                        {
                            let bounds = self.bounds.clone();
                            return d.child(
                                canvas(
                                    move |b, _, _| {
                                        bounds.borrow_mut().insert("guide-card", b);
                                        b
                                    },
                                    |_, _, _, _| {},
                                )
                                .absolute()
                                .top_0()
                                .left_0()
                                .size_full(),
                            );
                        }
                        #[cfg(not(feature = "ui-tests"))]
                        d
                    })
                    .child(
                        div()
                            .id("quick-start-scroll")
                            .overflow_y_scroll()
                            .track_scroll(&self.scroll)
                            .max_h(px(p.max_height))
                            .child(content),
                    ),
            )
    }
}

//! Native source WhatsNew composition. The host owns acknowledgement and links.
use crate::i18n::t;
use crate::a11y::ButtonSurface;
use crate::a11y::DialogSurface;
use crate::release_highlights::{Icon, ReleaseNotes};
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    rc::Rc,
    time::Instant,
};
actions!(singz_whats_new, [NextFocus, PreviousFocus]);

#[derive(Clone, Debug)]
pub enum Event {
    Closed,
    External(String),
}
#[derive(Clone, Debug)]
pub struct Copy {
    pub title: String,
    pub done: String,
    pub subscribe: String,
    pub telegram_description: String,
    pub desktop: String,
    pub full_notes: String,
}
impl Default for Copy {
    fn default() -> Self {
        Self {
            title: t("app.whatsNew.title"),
            done: t("app.whatsNew.done"),
            subscribe: t("app.whatsNew.subscribe"),
            telegram_description: t("app.whatsNew.telegramDescription"),
            desktop: t("app.whatsNew.desktop"),
            full_notes: t("app.whatsNew.fullNotes"),
        }
    }
}
pub struct WhatsNew {
    notes: Option<ReleaseNotes>,
    copy_locale: &'static str,
    copy: Copy,
    open: bool,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    scroll: ScrollHandle,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    open_sequence: u64,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for WhatsNew {}
impl WhatsNew {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        // GPUI Root matches Tab actions before raw KeyDown capture listeners.
        // Give this modal its own bindings, like the native QuickStart overlay.
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZWhatsNew")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZWhatsNew")),
        ]);
        Self {
            notes: None,
            copy_locale: crate::i18n::current().as_str(),
            copy: Copy::default(),
            open: false,
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            scroll: ScrollHandle::new(),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: false,
            open_sequence: 0,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, notes: ReleaseNotes, cx: &mut Context<Self>) {
        self.open_with_copy(notes, Copy::default(), cx);
    }
    pub fn open_with_copy(&mut self, notes: ReleaseNotes, copy: Copy, cx: &mut Context<Self>) {
        self.notes = Some(crate::release_highlights::localized(
            &notes,
            crate::i18n::current().as_str(),
        ));
        self.copy_locale = crate::i18n::current().as_str();
        self.copy = copy;
        self.open = true;
        self.open_sequence = self.open_sequence.wrapping_add(1);
        self.pending_focus = true;
        self.keyboard.set(false);
        self.opened_at = Instant::now();
        self.bounds.borrow_mut().clear();
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn close(&mut self, cx: &mut Context<Self>) {
        if self.open {
            self.open = false;
            self.bounds.borrow_mut().clear();
            cx.emit(Event::Closed);
            cx.notify();
        }
    }
    pub fn is_open(&self) -> bool {
        self.open
    }
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|v| v.max(0.));
        cx.notify();
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"open":self.open,"notes":self.notes,"focusInside":self.scope.contains_focused(w,cx),
            "focusedControl":self.controls.borrow().iter().find(|(_,f)|f.is_focused(w)).map(|(id,_)|id.clone()),
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],
            "focusOrder":self.order.borrow().clone(),"keyboardFocus":self.keyboard.get(),
            "animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        if !self.open {
            return;
        }
        match id {
            "whats-new-close" | "whats-new-done" => self.close(cx),
            "whats-new-telegram" => cx.emit(Event::External("https://t.me/SingZapp".into())),
            "whats-new-full-notes" => {
                if let Some(notes) = &self.notes {
                    cx.emit(Event::External(notes.url.clone()));
                }
            }
            _ => {}
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
            cx.notify();
        }
    }
    fn key(&mut self, e: &KeyDownEvent, w: &mut Window, cx: &mut Context<Self>) {
        match e.keystroke.key.as_str() {
            "escape" => {
                self.close(cx);
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
    fn control(&self, id: &str, d: Stateful<Div>, cx: &mut Context<Self>) -> Stateful<Div> {
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.into())
            .or_insert_with(|| cx.focus_handle().tab_stop(true))
            .clone();
        self.order.borrow_mut().push(id.into());
        let click_id = id.to_owned();
        let mouse_focus = focus.clone();
        self.probe(
            id,
            d.track_focus(&focus)
                .child(ui::guide_focus_ring(focus, self.keyboard.clone(), 2.))
                .on_mouse_down(
                    MouseButton::Left,
                    cx.listener(move |s, _, w, cx| {
                        s.keyboard.set(false);
                        mouse_focus.focus(w, cx);
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
impl Render for WhatsNew {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let locale = crate::i18n::current().as_str();
        if self.copy_locale != locale {
            self.copy_locale = locale;
            self.copy = Copy::default();
            self.notes = self
                .notes
                .as_ref()
                .map(|notes| crate::release_highlights::localized(notes, locale));
        }

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
        let Some(notes) = self.notes.as_ref() else {
            return div().into_any_element();
        };
        let mut card = ui::release_highlights_card(w.viewport_size())
            .id("whats-new-card")
            .key_context("SingZWhatsNew")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| {
                s.move_focus(false, w, cx);
                cx.stop_propagation();
            }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| {
                s.move_focus(true, w, cx);
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
            .capture_key_down(cx.listener(|s, e, w, cx| s.key(e, w, cx)))
            .child(
                ui::release_highlights_heading()
                    .child(ui::release_highlights_brand(
                        format!("v{}", notes.version),
                        w,
                    ))
                    .child(self.control(
                        "whats-new-close",
                        ui::release_highlights_button("whats-new-close", "×", false).a11y_button(crate::i18n::t("settings.action.close")),
                        cx,
                    )),
            )
            .child(ui::release_highlights_title(self.copy.title.clone(), w))
            .child(self.control(
                "whats-new-telegram",
                ui::release_highlights_telegram(
                    "whats-new-telegram",
                    self.copy.subscribe.clone(),
                    self.copy.telegram_description.clone(),
                    w,
                )
                .a11y_button(self.copy.subscribe.clone()),
                cx,
            ));
        let mut content =
            ui::release_highlights_content("whats-new-content").track_scroll(&self.scroll);
        for (e, entry) in notes.entries.iter().enumerate() {
            let mut section = ui::release_highlights_section();
            if notes.entries.len() > 1 {
                let id = format!("whats-new-version-{e}");
                section = section.child(self.probe(
                    &id,
                    ui::release_highlights_version(format!("v{}", entry.version), w).id(id.clone()),
                ));
            }
            for (i, item) in entry.highlights.iter().enumerate() {
                let icon = match item.icon {
                    Icon::News => ui::ReleaseIcon::News,
                    Icon::Export => ui::ReleaseIcon::Export,
                    Icon::Mic => ui::ReleaseIcon::Mic,
                    Icon::Controls => ui::ReleaseIcon::Controls,
                };
                let mut copy = ui::release_highlights_article_copy();
                if item.desktop_only {
                    copy = copy.child(ui::release_highlights_desktop(self.copy.desktop.clone(), w));
                }
                copy = copy
                    .child(ui::release_highlights_article_title(item.title.clone(), w))
                    .child(ui::release_highlights_description(item.description.clone()));
                let id = format!("whats-new-highlight-{e}-{i}");
                section = section.child(
                    self.probe(
                        &id,
                        ui::release_highlights_article(id.clone(), i > 0)
                            .child(ui::release_highlights_icon(icon, w))
                            .child(copy),
                    ),
                );
            }
            content = content.child(section);
        }
        card = card
            .child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .child(self.probe("whats-new-content", content))
                    .child(ui::production_scrollbar(&self.scroll)),
            )
            .child(
                ui::release_highlights_footer()
                    .child(self.control(
                        "whats-new-full-notes",
                        ui::release_highlights_button(
                            "whats-new-full-notes",
                            format!("{} ↗", self.copy.full_notes),
                            false,
                        )
                        .a11y_button(self.copy.full_notes.clone()),
                        cx,
                    ))
                    .child(self.control(
                        "whats-new-done",
                        ui::release_highlights_button(
                            "whats-new-done",
                            self.copy.done.clone(),
                            true,
                        )
                        .a11y_button(self.copy.done.clone()),
                        cx,
                    )),
            );
        if self.pending_focus && crate::overlay_gate::may_focus(crate::overlay_gate::Layer::WhatsNew) {
            self.pending_focus = false;
            if let Some(f) = self.controls.borrow().get("whats-new-close") {
                f.focus(w, cx);
            }
            // The host's modal transition may focus its own root while this
            // entity's just-rendered scene is cached. Recheck once after the
            // new focus tree has registered, never after a later close/reopen
            // and never replacing focus already inside the card.
            let sequence = self.open_sequence;
            let weak = cx.weak_entity();
            w.on_next_frame(move |w, cx| {
                let _ = weak.update(cx, |s, cx| {
                    if s.open && s.open_sequence == sequence && crate::overlay_gate::may_focus(crate::overlay_gate::Layer::WhatsNew) && !s.scope.contains_focused(w, cx) {
                        if let Some(f) = s.controls.borrow().get("whats-new-close") {
                            f.focus(w, cx);
                        }
                        cx.notify();
                    }
                });
            });
            w.request_animation_frame();
        }
        ui::modal_scrim()
            .id("whats-new-scrim")
            .a11y_dialog(crate::i18n::t("app.whatsNew.title"))
            .on_click(cx.listener(|s, _, _, cx| {
                s.close(cx);
                cx.stop_propagation();
            }))
            .child(ui::release_highlights_entrance(
                self.probe("whats-new-card", card),
                elapsed / 0.25,
            ))
            .into_any_element()
    }
}

impl crate::overlay_gate::DefaultFocus for WhatsNew {
    fn request_default_focus(&mut self, cx: &mut Context<Self>) {
        self.pending_focus = true;
        cx.notify();
    }
    fn focus_inside(&self, window: &Window, cx: &App) -> bool { self.scope.contains_focused(window, cx) }
}

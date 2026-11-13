//! Source-backed ProjectPicker composition; library IO stays in project_library.
use crate::i18n::{t, tn, tv};
use crate::a11y::{ButtonSurface, DialogSurface};
use crate::project_library::Snapshot;
use gpui_kit::{prelude::FluentBuilder, *};
use singz_uikit as ui;
use std::{
    cell::{Cell, RefCell},
    collections::HashMap,
    path::PathBuf,
    rc::Rc,
    time::Instant,
};
actions!(singz_project_picker, [NextFocus, PreviousFocus]);

#[derive(Clone, Debug)]
pub enum Event {
    Open(PathBuf),
    Browse,
    Close,
    ChooseRoot,
    SetRoot(Option<PathBuf>),
    Drive(crate::drive_state::Action),
    DriveBrowse,
}
enum StorageMessage {
    SwitchFailed(String),
    Moved(usize),
    Failure(String),
}
pub struct Picker {
    snapshot: Option<Snapshot>,
    loading: bool,
    moving: bool,
    storage_message: Option<StorageMessage>,
    drive: crate::drive_state::Snapshot,
    scope: FocusHandle,
    controls: RefCell<HashMap<String, FocusHandle>>,
    order: RefCell<Vec<String>>,
    bounds: Rc<RefCell<HashMap<String, Bounds<Pixels>>>>,
    scroll: ScrollHandle,
    keyboard: Rc<Cell<bool>>,
    pending_focus: bool,
    opened_at: Instant,
    animation_time: Option<f32>,
    frame_pending: bool,
}
impl EventEmitter<Event> for Picker {}

fn date(value: &str) -> String {
    let parsed = chrono::DateTime::parse_from_rfc3339(value)
        .ok()
        .map(|d| d.with_timezone(&chrono::Local))
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(value, "%Y-%m-%d")
                .ok()
                .and_then(|d| d.and_hms_opt(0, 0, 0))
                .map(|d| d.and_utc().with_timezone(&chrono::Local))
        });
    parsed
        .map(|d| d.format("%b %-d").to_string())
        .unwrap_or_default()
}
impl Picker {
    pub fn new(_w: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZProjectPicker")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZProjectPicker")),
        ]);
        Self {
            snapshot: None,
            loading: true,
            moving: false,
            storage_message: None,
            drive: Default::default(),
            scope: cx.focus_handle(),
            controls: Default::default(),
            order: Default::default(),
            bounds: Default::default(),
            scroll: ScrollHandle::new(),
            keyboard: Rc::new(Cell::new(false)),
            pending_focus: true,
            opened_at: Instant::now(),
            animation_time: None,
            frame_pending: false,
        }
    }
    pub fn open(&mut self, snapshot: Option<Snapshot>, cx: &mut Context<Self>) {
        self.loading = snapshot.is_none();
        self.snapshot = snapshot;
        self.moving = false;
        self.storage_message = None;
        self.pending_focus = true;
        self.keyboard.set(false);
        self.opened_at = Instant::now();
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.bounds.borrow_mut().clear();
        cx.notify();
    }
    pub fn update(&mut self, snapshot: Snapshot, cx: &mut Context<Self>) {
        self.snapshot = Some(snapshot);
        self.loading = false;
        cx.notify();
    }
    pub fn set_drive(&mut self, drive: crate::drive_state::Snapshot, cx: &mut Context<Self>) {
        if !crate::integration::fixture_mode() && self.drive != drive {
            self.drive = drive;
            cx.notify();
        }
    }
    pub fn set_loading(&mut self, loading: bool, cx: &mut Context<Self>) {
        self.loading = loading;
        cx.notify();
    }
    /// Deterministic elapsed seconds for hidden animation captures.
    pub fn set_animation_time(&mut self, seconds: Option<f32>, cx: &mut Context<Self>) {
        self.animation_time = seconds.map(|s| s.max(0.));
        cx.notify();
    }
    pub fn set_moving(&mut self, moving: bool, cx: &mut Context<Self>) {
        self.moving = moving;
        if moving {
            self.storage_message = None;
        }
        cx.notify();
    }
    pub fn storage_result(&mut self, copied: usize, error: Option<String>, cx: &mut Context<Self>) {
        self.moving = false;
        self.storage_message = error
            .map(StorageMessage::SwitchFailed)
            .or_else(|| (copied > 0).then_some(StorageMessage::Moved(copied)));
        cx.notify();
    }
    pub fn failure(&mut self, error: String, cx: &mut Context<Self>) {
        self.loading = false;
        self.moving = false;
        self.storage_message = Some(StorageMessage::Failure(error));
        cx.notify();
    }
    fn storage_copy(&self) -> Option<String> {
        self.storage_message.as_ref().map(|message| match message {
            StorageMessage::SwitchFailed(error) => tv(
                "library.projectPicker.switchFailed",
                &[("error", error.clone())],
            ),
            StorageMessage::Moved(count) => tn("library.projectPicker.movedIn", *count as f64, &[]),
            StorageMessage::Failure(error) => error.clone(),
        })
    }
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        if id == "picker-rows" {
            Some(self.scroll.bounds())
        } else {
            self.bounds.borrow().get(id).copied()
        }
    }
    pub fn state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"loading":self.loading,"moving":self.moving,
            "root":self.snapshot.as_ref().map(|s|s.root.to_string_lossy().into_owned()).unwrap_or_default(),
            "isDefault":self.snapshot.as_ref().is_none_or(|s|s.is_default),
            "projects":self.snapshot.as_ref().map(|s|s.projects.iter().map(|p|serde_json::json!({"dir":p.dir,"name":p.name,"songPath":p.song_path,"savedAt":p.saved_at,"hasStems":p.has_stems,"hasLyrics":p.has_lyrics})).collect::<Vec<_>>()).unwrap_or_default(),
            "cloud":self.snapshot.as_ref().map(|s|s.cloud.iter().map(|c|serde_json::json!({"label":c.label,"path":c.path})).collect::<Vec<_>>()).unwrap_or_default(),
            "storageMessage":self.storage_copy(),"focusedControl":self.order.borrow().iter().find(|id|self.controls.borrow().get(*id).is_some_and(|f|f.is_focused(w))).cloned(),
            "focusInside":self.scope.contains_focused(w,cx),"scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],
            "driveConfigured":self.drive.configured,"drive":self.drive,"animationSeconds":self.animation_time.unwrap_or_else(||self.opened_at.elapsed().as_secs_f32())})
    }
    fn activate(&mut self, id: &str, cx: &mut Context<Self>) {
        match id {
            "picker-close" => cx.emit(Event::Close),
            "picker-browse" => cx.emit(Event::Browse),
            "picker-drive-browse" if self.drive.signed_in => cx.emit(Event::DriveBrowse),
            "picker-drive-connect"
                if !self.moving
                    && self.drive.configured
                    && !self.drive.signed_in
                    && !self.drive.signing_in =>
            {
                cx.emit(Event::Drive(crate::drive_state::Action::SignIn));
            }
            "picker-drive-sync"
                if !self.moving
                    && self.drive.configured
                    && self.drive.signed_in
                    && !self.drive.busy =>
            {
                cx.emit(Event::Drive(crate::drive_state::Action::SyncNow));
            }
            "picker-drive-signout"
                if !self.moving && self.drive.configured && self.drive.signed_in =>
            {
                cx.emit(Event::Drive(crate::drive_state::Action::SignOut));
            }
            "picker-choose-root" if !self.moving => {
                self.moving = true;
                self.storage_message = None;
                cx.emit(Event::ChooseRoot);
            }
            "picker-reset-root" if !self.moving => {
                self.moving = true;
                self.storage_message = None;
                cx.emit(Event::SetRoot(None));
            }
            _ => {
                if let Some(index) = id
                    .strip_prefix("picker-row-")
                    .and_then(|v| v.parse::<usize>().ok())
                {
                    if !self.loading {
                        if let Some(p) = self.snapshot.as_ref().and_then(|s| s.projects.get(index))
                        {
                            cx.emit(Event::Open(p.song_path.clone()));
                        }
                    }
                } else if !self.moving {
                    if let Some(index) = id
                        .strip_prefix("picker-cloud-")
                        .and_then(|v| v.parse::<usize>().ok())
                    {
                        if let Some((root, cloud)) = self
                            .snapshot
                            .as_ref()
                            .and_then(|s| s.cloud.get(index).map(|c| (&s.root, c)))
                        {
                            if *root != cloud.path {
                                let path = cloud.path.clone();
                                self.moving = true;
                                self.storage_message = None;
                                cx.emit(Event::SetRoot(Some(path)));
                            }
                        }
                    }
                }
            }
        }
        cx.notify();
    }
    fn focus(&self, id: &str, w: &mut Window, cx: &mut Context<Self>) {
        if let Some(index) = id
            .strip_prefix("picker-row-")
            .and_then(|v| v.parse::<usize>().ok())
        {
            self.scroll.scroll_to_item(index);
        }
        if let Some(f) = self.controls.borrow().get(id) {
            f.focus(w, cx);
        }
    }
    pub fn focus_drive_browse(&self, window:&mut Window, cx:&mut Context<Self>)->bool {
        if self.drive.signed_in && self.order.borrow().iter().any(|id|id=="picker-drive-browse") {
            self.focus("picker-drive-browse",window,cx);return true;
        }
        false
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
            self.focus(&order[index], w, cx);
            cx.notify();
        } else {
            self.scope.focus(w, cx);
        }
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
                let focused = self
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
                if let Some(id) = focused {
                    if id=="picker-drive-browse" {w.prevent_default();if e.is_held{return;}}
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
        id: String,
        d: Stateful<Div>,
        enabled: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let previous_primary = match id.as_str() {
            "picker-drive-connect" => self.controls.borrow().get("picker-drive-sync").cloned(),
            "picker-drive-sync" => self.controls.borrow().get("picker-drive-connect").cloned(),
            _ => None,
        };
        let focus = self
            .controls
            .borrow_mut()
            .entry(id.clone())
            .or_insert_with(|| previous_primary.unwrap_or_else(|| cx.focus_handle()))
            .clone();
        if enabled {
            self.order.borrow_mut().push(id.clone());
        }
        let click_id = id.clone();
        let mouse_focus = focus.clone();
        self.probe(
            &id,
            d.when(enabled, |d| {
                d.track_focus(&focus).child(ui::guide_focus_ring(
                    focus.clone(),
                    self.keyboard.clone(),
                    1.,
                ))
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |s, _, w, cx| {
                    s.keyboard.set(false);
                    if enabled {
                        mouse_focus.focus(w, cx);
                    }
                    cx.stop_propagation();
                }),
            )
            .on_click(cx.listener(move |s, _, _, cx| {
                s.keyboard.set(false);
                if enabled {
                    s.activate(&click_id, cx);
                }
                cx.stop_propagation();
            })),
        )
    }
}
impl Render for Picker {
    fn render(&mut self, w: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        // Inspect actual previous control focus before layout unregisters a
        // removed/disabled control. Inactive windows may omit focus callbacks;
        // a historical handle alone cannot retain the modal key path.
        let previous_control_focus = self
            .controls
            .borrow()
            .values()
            .find(|focus| focus.is_focused(w))
            .cloned();
        let transfer_signout_focus = !self.drive.signed_in
            && self
                .controls
                .borrow()
                .get("picker-drive-signout")
                .is_some_and(|focus| focus.is_focused(w));
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
        let action = |s: &Self, id: &str, label: String, enabled: bool, cx: &mut Context<Self>| {
            s.control(
                id.into(),
                ui::project_picker_action(id.to_owned(), label.clone(), enabled).a11y_button(label),
                enabled,
                cx,
            )
        };
        let mut card = ui::project_picker_card(w.viewport_size())
            .id("picker-card")
            .key_context("SingZProjectPicker")
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
                ui::project_picker_head()
                    .child(ui::project_picker_title(
                        t("library.common.yourProjects"),
                        w,
                    ))
                    .child(
                        ui::project_picker_head_actions()
                            .child(action(
                                self,
                                "picker-browse",
                                t("library.common.browseFiles"),
                                true,
                                cx,
                            ))
                            .child(action(
                                self,
                                "picker-close",
                                t("library.common.close"),
                                true,
                                cx,
                            )),
                    ),
            );
        let root = self
            .snapshot
            .as_ref()
            .map(|s| s.root.to_string_lossy().into_owned())
            .unwrap_or_default();
        if self.loading {
            card = card.child(ui::project_picker_paragraph(tv(
                "library.projectPicker.looking",
                &[(
                    "root",
                    if root.is_empty() {
                        t("library.projectPicker.defaultFolder")
                    } else {
                        root.clone()
                    },
                )],
            )));
        } else if self.snapshot.as_ref().is_none_or(|s| s.projects.is_empty()) {
            card = card.child(ui::project_picker_empty_text(
                t("library.projectPicker.emptyHint"),
                &[("root", root.clone())],
            ));
        } else if let Some(snapshot) = &self.snapshot {
            let mut list = ui::project_picker_rows("picker-rows").track_scroll(&self.scroll);
            for (index, p) in snapshot.projects.iter().enumerate() {
                let id = format!("picker-row-{index}");
                let row = ui::project_picker_row(id.clone(), w)
                    .a11y_button(p.name.clone())
                    .child(ui::project_picker_name(p.name.clone()))
                    .child(
                        ui::project_picker_meta()
                            .when(p.has_stems, |d| {
                                d.child(ui::badge(t("library.projectPicker.stemsBadge"), false))
                            })
                            .when(p.has_lyrics, |d| {
                                d.child(ui::badge(t("library.projectPicker.lyricsBadge"), false))
                            })
                            .child(ui::project_picker_date(date(&p.saved_at), w)),
                    );
                list = list.child(self.control(id, row, true, cx));
            }
            card = card.child(
                div()
                    .relative()
                    .flex()
                    .flex_col()
                    .min_h_0()
                    .child(self.probe("picker-rows", list))
                    .child(ui::production_scrollbar(&self.scroll)),
            );
        }
        let mut actions = ui::project_picker_storage_actions();
        if let Some(snapshot) = &self.snapshot {
            for (index, c) in snapshot.cloud.iter().enumerate() {
                let active = snapshot.root == c.path;
                let enabled = !self.moving && !active;
                actions = actions.child(action(
                    self,
                    &format!("picker-cloud-{index}"),
                    if active {
                        tv(
                            "library.projectPicker.inCloud",
                            &[("label", c.label.clone())],
                        )
                    } else {
                        tv(
                            "library.projectPicker.useCloud",
                            &[("label", c.label.clone())],
                        )
                    },
                    enabled,
                    cx,
                ));
            }
        }
        if self.drive.signed_in {
            actions=actions.child(self.control("picker-drive-browse".into(),
                ui::drive_library_action("picker-drive-browse",t("library.drive.title"),true,w).a11y_button(t("library.drive.title")),true,cx));
        }
        if self.drive.configured {
            let (id, label) = if self.drive.signed_in {
                ("picker-drive-sync", t("library.projectPicker.syncToDrive"))
            } else {
                (
                    "picker-drive-connect",
                    t("library.projectPicker.connectDrive"),
                )
            };
            let enabled = !self.moving && !self.drive.busy && !self.drive.signing_in;
            actions = actions.child(self.control(
                id.into(),
                ui::drive_picker_action_tooltip(
                    id,
                    label.clone(),
                    t("library.projectPicker.gdriveConnectTitle"),
                    enabled,
                )
                .a11y_button(label.clone()),
                enabled,
                cx,
            ));
            if self.drive.signed_in {
                actions = actions.child(action(
                    self,
                    "picker-drive-signout",
                    t("library.projectPicker.signOut"),
                    !self.moving,
                    cx,
                ));
            }
        }
        actions = actions.child(action(
            self,
            "picker-choose-root",
            t("library.projectPicker.chooseFolder"),
            !self.moving,
            cx,
        ));
        if self.snapshot.as_ref().is_some_and(|s| !s.is_default) {
            actions = actions.child(action(
                self,
                "picker-reset-root",
                t("library.projectPicker.backToDocuments"),
                !self.moving,
                cx,
            ));
        }
        let mut storage = ui::project_picker_storage()
            .child(ui::project_picker_root(tv(
                "library.projectPicker.storedIn",
                &[("root", root.clone())],
            )))
            .child(actions);
        if self.moving {
            storage = storage.child(ui::project_picker_fine(t("library.projectPicker.moving")));
        }
        if let Some(message) = self.storage_copy() {
            storage = storage.child(ui::project_picker_fine(message.clone()));
        }
        if self.drive.configured {
            let message = if self.drive.signing_in {
                Some(t("library.common.finishGoogleSignIn"))
            } else if let Some(error) = &self.drive.error {
                Some(if self.drive.signed_in {
                    tv("library.common.syncFailed", &[("error", error.clone())])
                } else {
                    tv(
                        "library.projectPicker.googleSignInFailed",
                        &[("error", error.clone())],
                    )
                })
            } else if !self.drive.progress.is_empty() {
                let fraction = self.drive.fraction;
                Some(if self.drive.busy && fraction < 1. {
                    format!(
                        "{} {}%",
                        self.drive.progress,
                        (fraction.clamp(0., 1.) * 100.).round() as u32
                    )
                } else {
                    self.drive.progress.clone()
                })
            } else if self.drive.busy {
                Some(t("library.projectPicker.syncingToDrive"))
            } else {
                None
            };
            if let Some(message) = message {
                storage = storage.child(ui::project_picker_fine(message));
            }
        }
        card = card.child(storage);
        let may_focus = crate::overlay_gate::may_focus(crate::overlay_gate::Layer::ProjectPicker);
        if self.pending_focus && may_focus {
            self.pending_focus = false;
            self.focus("picker-browse", w, cx);
        } else if transfer_signout_focus && may_focus {
            if self
                .order
                .borrow()
                .iter()
                .any(|id| id == "picker-drive-connect")
            {
                self.focus("picker-drive-connect", w, cx);
            } else {
                self.scope.focus(w, cx);
            }
        } else if previous_control_focus
            .as_ref()
            .is_some_and(|focus| focus.is_focused(w))
            && !self.order.borrow().iter().any(|id| {
                self.controls
                    .borrow()
                    .get(id)
                    .is_some_and(|focus| focus.is_focused(w))
            })
        {
            // Enabled aliases (Connect -> Sync) retain their shared handle.
            // A disabled or removed owner transfers to the stable modal scope;
            // never pull focus back from another control or outside the picker.
            self.scope.focus(w, cx);
        }
        ui::modal_scrim()
            .id("picker-scrim")
            .a11y_dialog(crate::i18n::t("library.common.yourProjects"))
            .on_click(cx.listener(|_, _, _, cx| {
                cx.emit(Event::Close);
                cx.stop_propagation();
            }))
            .child(ui::project_picker_entrance(
                self.probe("picker-card", card),
                elapsed / 0.25,
            ))
    }
}

impl crate::overlay_gate::DefaultFocus for Picker {
    fn request_default_focus(&mut self, cx: &mut Context<Self>) {
        self.pending_focus = true;
        cx.notify();
    }
    fn focus_inside(&self, window: &Window, cx: &App) -> bool { self.scope.contains_focused(window, cx) }
}

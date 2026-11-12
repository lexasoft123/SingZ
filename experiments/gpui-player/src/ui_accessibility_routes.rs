//! C-60a: hidden, muted whole-app accessibility audit of the REAL `Player` root.
//!
//! Unlike `ui_accessibility.rs` this never calls `replace_root`: it drives the
//! production header events and dialog openers, and per route and window size it
//! writes the GPUI accessibility tree, the native macOS AX readback and the Tab
//! order. `tests/test_native_accessibility_routes.py` judges the files; this
//! module only measures. With `SINGZ_GPUI_ACCESSIBILITY_ROUTES_INJECT=1` it
//! instead replaces the root with a two-control probe, one named and one
//! deliberately unnamed, as the auditor's negative control.
use super::*;
use super::ui_training_run::draw;
use std::{collections::HashSet, ffi::{CStr, CString, c_char, c_void}, path::{Path, PathBuf}, time::Duration};

type Obj = *mut c_void;
#[link(name = "objc")]
unsafe extern "C" {
    fn objc_getClass(name: *const c_char) -> Obj;
    fn sel_registerName(name: *const c_char) -> Obj;
    fn objc_msgSend();
}
/// One typed `objc_msgSend` call: `send!(ret(args...) receiver, "selector", args)`.
macro_rules! send {
    ($ret:ty, $recv:expr, $sel:expr $(, $arg:expr => $ty:ty)*) => {{
        let call: unsafe extern "C" fn(Obj, Obj $(, $ty)*) -> $ret = unsafe { std::mem::transmute(objc_msgSend as *const ()) };
        let name = CString::new($sel).unwrap();
        unsafe { call($recv, sel_registerName(name.as_ptr()) $(, $arg)*) }
    }};
}
fn responds(receiver: Obj, method: &str) -> bool {
    !receiver.is_null() && {
        let name = CString::new(method).unwrap();
        send!(bool, receiver, "respondsToSelector:", unsafe { sel_registerName(name.as_ptr()) } => Obj)
    }
}
fn object(receiver: Obj, method: &str) -> Obj {
    if responds(receiver, method) { send!(Obj, receiver, method) } else { std::ptr::null_mut() }
}
fn text(receiver: Obj) -> Option<String> {
    if !responds(receiver, "UTF8String") { return None; }
    let bytes: *const c_char = send!(*const c_char, receiver, "UTF8String");
    (!bytes.is_null()).then(|| unsafe { CStr::from_ptr(bytes) }.to_string_lossy().into_owned())
}
fn number(receiver: Obj) -> Option<f64> {
    if receiver.is_null() { return None; }
    let class = unsafe { objc_getClass(c"NSNumber".as_ptr()) };
    (send!(bool, receiver, "isKindOfClass:", class => Obj)).then(|| send!(f64, receiver, "doubleValue"))
}
fn string_property(receiver: Obj, method: &str) -> Option<String> { text(object(receiver, method)) }
fn flag(receiver: Obj, method: &str) -> bool { responds(receiver, method) && send!(bool, receiver, method) }
/// Reads this process's own windows through `NSView.accessibilityChildren`,
/// which activates the real AccessKit macOS adapter. It neither enables
/// VoiceOver nor needs a global accessibility permission, and activates nothing.
fn native_ax() -> Vec<serde_json::Value> {
    let app = send!(Obj, unsafe { objc_getClass(c"NSApplication".as_ptr()) }, "sharedApplication");
    let windows = object(app, "windows");
    let mut pending = vec![];
    if !windows.is_null() {
        for i in 0..send!(usize, windows, "count") {
            let content = object(send!(Obj, windows, "objectAtIndex:", i => usize), "contentView");
            if !content.is_null() { pending.push(content); }
        }
    }
    let (mut seen, mut rows) = (HashSet::new(), vec![]);
    while let Some(node) = pending.pop() {
        if node.is_null() || !seen.insert(node as usize) || seen.len() > 8192 { continue; }
        if let Some(id) = string_property(node, "accessibilityIdentifier") {
            let value = object(node, "accessibilityValue");
            rows.push(serde_json::json!({"id": id,
                "role": string_property(node, "accessibilityRole"),
                "subrole": string_property(node, "accessibilitySubrole"),
                "modal": flag(node, "isAccessibilityModal"),
                "title": string_property(node, "accessibilityTitle"),
                "help": string_property(node, "accessibilityHelp"),
                "enabled": flag(node, "isAccessibilityEnabled"),
                "value": text(value).map(serde_json::Value::from).unwrap_or_else(|| serde_json::json!(number(value))),
                "min": number(object(node, "accessibilityMinValue")),
                "max": number(object(node, "accessibilityMaxValue"))}));
        }
        let children = object(node, "accessibilityChildren");
        if !children.is_null() {
            for i in 0..send!(usize, children, "count") { pending.push(send!(Obj, children, "objectAtIndex:", i => usize)); }
        }
    }
    rows
}

fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    let stroke = Keystroke::parse(value).unwrap();
    w.dispatch_keystroke(stroke.clone(), cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: stroke }), cx);
}
fn tree(w: &Window) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_str(&w.debug_a11y_tree_json().ok_or_else(|| anyhow::anyhow!("accessibility tree missing"))?)?)
}

/// Every route or dialog the audit tries. `needs_backend` states are recorded as
/// unreachable, not skipped silently, when the fixture has no audio backend.
struct State {
    name: &'static str,
    needs_backend: bool,
    /// Header control that opens this state from the keyboard: Tab to it, press
    /// Enter. Escape must then close the state and focus must return to it.
    opener: Option<&'static str>,
    /// A surface that must close on Escape (every dialog, popover and overlay route).
    closes_on_escape: bool,
    open: fn(&Entity<Player>, &mut Window, &mut App),
    reached: fn(&Player, &App) -> bool,
}
fn header(view: &Entity<Player>, cx: &mut App, event: header::HeaderEvent) {
    view.read(cx).header.clone().update(cx, |_, cx| cx.emit(event));
}
fn base_screen(p: &Player) -> Screen { if p.loaded_song { Screen::Player } else { Screen::Library } }
fn any_dialog(p: &Player, cx: &App) -> bool {
    p.notice.is_some() || p.language_menu.read(cx).is_open() || p.project_delete.read(cx).is_open()
        || p.lyrics_editor_open || p.project_picker_open || p.drive_projects_open || p.library_import_open
        || p.stem_export_open || p.engine_setup.read(cx).is_open() || p.whats_new.read(cx).is_open()
        || p.quick_start.read(cx).is_open() || p.carry_open || p.metronome_open
}
const PROBE_STATE: State = State { name: "probe", needs_backend: false, opener: None, closes_on_escape: false, open: |_, _, _| {}, reached: |_, _| true };
const STATES: &[State] = &[
    State { name: "library", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.songs_catalog = false; p.screen = Screen::Library; cx.notify(); }),
        reached: |p, _| p.screen == Screen::Library },
    State { name: "player", needs_backend: false, opener: None, closes_on_escape: false, open: |v, _, cx| v.update(cx, |p, cx| { p.screen = Screen::Player; cx.notify(); }),
        reached: |p, _| p.screen == Screen::Player },
    State { name: "player-metronome", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.screen = Screen::Player; p.metronome_open = true; cx.notify(); }),
        reached: |p, _| p.metronome_open },
    State { name: "training", needs_backend: false, opener: None, closes_on_escape: false, open: |v, _, cx| header(v, cx, header::HeaderEvent::Training),
        reached: |p, _| p.screen == Screen::Training },
    State { name: "settings", needs_backend: false, opener: Some("header-settings"), closes_on_escape: true, open: |v, _, cx| header(v, cx, header::HeaderEvent::Settings),
        reached: |p, _| p.screen == Screen::Settings },
    State { name: "log", needs_backend: false, opener: Some("header-log"), closes_on_escape: true, open: |v, _, cx| header(v, cx, header::HeaderEvent::Log),
        reached: |p, _| p.screen == Screen::Log },
    State { name: "models", needs_backend: false, opener: None, closes_on_escape: false, open: |v, _, cx| v.update(cx, |p, cx| p.open_models(models::Origin::Manual, cx)),
        reached: |p, _| p.screen == Screen::Models },
    State { name: "dialog-language-menu", needs_backend: false, opener: Some("header-language"), closes_on_escape: true, open: |v, w, cx| v.update(cx, |p, cx| p.open_language_menu(w, cx)),
        reached: |p, cx| p.language_menu.read(cx).is_open() },
    State { name: "dialog-quick-start", needs_backend: false, opener: Some("header-help"), closes_on_escape: true, open: |v, _, cx| v.update(cx, |p, cx| p.open_quick_start(false, cx)),
        reached: |p, cx| p.quick_start.read(cx).is_open() },
    State { name: "dialog-whats-new", needs_backend: false, opener: Some("header-version"), closes_on_escape: true, open: |v, _, cx| header(v, cx, header::HeaderEvent::WhatsNew),
        reached: |p, cx| p.whats_new.read(cx).is_open() },
    State { name: "dialog-engine-setup", needs_backend: false, opener: None, closes_on_escape: true, open: |v, _, cx| v.update(cx, |p, cx| p.open_engine_setup(cx)),
        reached: |p, cx| p.engine_setup.read(cx).is_open() },
    State { name: "dialog-notice", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| { p.notice = Some("Accessibility audit notice".into()); cx.notify(); }),
        reached: |p, _| p.notice.is_some() },
    State { name: "dialog-drive-projects", needs_backend: false, opener: None, closes_on_escape: true, open: |v, w, cx| v.update(cx, |p, cx| p.open_drive_projects(w, cx)),
        reached: |p, _| p.drive_projects_open },
    State { name: "toast", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.success_toast.update(cx, |t, cx| t.show("Accessibility audit toast", cx)); cx.notify(); }),
        reached: |p, cx| p.success_toast.read(cx).state().visible },
    // The next six need a native audio backend to open through their real host methods. The fixture has
    // none, so the hook fills each dialog entity and sets the host's open flag directly; Escape, focus and
    // closing then run through the real dialog and Player code.
    State { name: "dialog-project-picker", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| { p.project_picker_open = true; p.project_picker.update(cx, |s, cx| s.open(None, cx)); cx.notify(); }),
        reached: |p, _| p.project_picker_open },
    State { name: "dialog-stem-export", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| {
            let lanes = vec![("vocals", "Vocals", "#f66d5c"), ("drums", "Drums", "#f2a83d")].into_iter().enumerate()
                .map(|(slot, (id, label, color))| tracks::Lane { slot, id: id.into(), label: label.into(), color: color.into(), file: format!("/{id}.wav").into(), custom: false })
                .collect::<Vec<_>>();
            p.stem_export_lanes = lanes.clone();
            p.stem_export_open = true;
            p.stem_export_dialog.update(cx, |d, cx| d.open(lanes, cx));
            cx.notify();
        }),
        reached: |p, _| p.stem_export_open },
    State { name: "dialog-lyrics-editor", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| {
            let lines = vec![lyrics_edit::Line { start: 1., end: 3., text: "First fixture line".into(), words: vec![] },
                             lyrics_edit::Line { start: 3., end: 5., text: "Second fixture line".into(), words: vec![] }];
            p.lyrics_editor.update(cx, |e, cx| e.open("Fixture song".into(), lines, 60., false, cx));
            p.lyrics_editor_open = true;
            cx.notify();
        }),
        reached: |p, _| p.lyrics_editor_open },
    State { name: "dialog-library-import", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| {
            p.library_import.update(cx, |s, cx| s.open("/fixture/project".into(), "/fixture/library".into(), cx));
            p.library_import_open = true;
            cx.notify();
        }),
        reached: |p, _| p.library_import_open },
    State { name: "dialog-project-delete", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| {
            p.project_delete.update(cx, |d, cx| d.open(project_delete_dialog::Details { name: "Fixture song".into(), stem_count: 4, has_lyrics: true, bytes: 12_345_678, opened: false }, cx));
            cx.notify();
        }),
        reached: |p, cx| p.project_delete.read(cx).is_open() },
    State { name: "popover-carry-line", needs_backend: false, opener: None, closes_on_escape: true,
        open: |v, _, cx| v.update(cx, |p, cx| {
            p.screen = Screen::Player; p.carry_open = true;
            p.carry_popover.update(cx, |c, cx| c.on_open(cx));
            cx.notify();
        }),
        reached: |p, _| p.carry_open },
    State { name: "announce-recording-started", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| { crate::a11y::announce_recording(crate::a11y::Recording::Started); v.update(cx, |_, cx| cx.notify()); },
        reached: |_, _| true },
    State { name: "announce-recording-stopped", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| { crate::a11y::announce_recording(crate::a11y::Recording::Stopped); v.update(cx, |_, cx| cx.notify()); },
        reached: |_, _| true },
    State { name: "announce-recording-failed", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| { crate::a11y::announce_recording(crate::a11y::Recording::Failed); v.update(cx, |_, cx| cx.notify()); },
        reached: |_, _| true },
    State { name: "announce-training-result", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| { crate::a11y::announce_training_result(3, 4); v.update(cx, |_, cx| cx.notify()); },
        reached: |_, _| true },
    State { name: "announce-model-installing", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| {
            // The reset before each state restores the wizard: set a baseline, then make the real transition.
            let snapshot = |revision: u64, running: &[&str], present: bool, error: Option<&str>| std::sync::Arc::new(crate::model_service::Snapshot { revision, loaded: true, running: running.iter().map(|s| s.to_string()).collect(), error: error.map(Into::into), rows: vec![crate::model_service::Row { entry: crate::model_catalog::Entry { id: "fixture-model".into(), label: "Fixture model".into(), description: String::new(), optional: false, parts: vec![], archive: false }, present, download_mb: 0 }], ..Default::default() });
            let models = v.read(cx).models.clone();
            models.update(cx, |m, cx| { m.update_status(snapshot(201, &[], false, None), cx); m.update_status(snapshot(202, &["fixture-model"], false, None), cx); });
            v.update(cx, |_, cx| cx.notify());
        },
        reached: |_, _| true },
    State { name: "announce-model-installed", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| {
            // The reset before each state restores the wizard: set a baseline, then make the real transition.
            let snapshot = |revision: u64, running: &[&str], present: bool, error: Option<&str>| std::sync::Arc::new(crate::model_service::Snapshot { revision, loaded: true, running: running.iter().map(|s| s.to_string()).collect(), error: error.map(Into::into), rows: vec![crate::model_service::Row { entry: crate::model_catalog::Entry { id: "fixture-model".into(), label: "Fixture model".into(), description: String::new(), optional: false, parts: vec![], archive: false }, present, download_mb: 0 }], ..Default::default() });
            let models = v.read(cx).models.clone();
            models.update(cx, |m, cx| { m.update_status(snapshot(203, &["fixture-model"], false, None), cx); m.update_status(snapshot(204, &[], true, None), cx); });
            v.update(cx, |_, cx| cx.notify());
        },
        reached: |_, _| true },
    State { name: "announce-model-failed", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| {
            // The reset before each state restores the wizard: set a baseline, then make the real transition.
            let snapshot = |revision: u64, running: &[&str], present: bool, error: Option<&str>| std::sync::Arc::new(crate::model_service::Snapshot { revision, loaded: true, running: running.iter().map(|s| s.to_string()).collect(), error: error.map(Into::into), rows: vec![crate::model_service::Row { entry: crate::model_catalog::Entry { id: "fixture-model".into(), label: "Fixture model".into(), description: String::new(), optional: false, parts: vec![], archive: false }, present, download_mb: 0 }], ..Default::default() });
            let models = v.read(cx).models.clone();
            models.update(cx, |m, cx| { m.update_status(snapshot(205, &["fixture-model"], false, None), cx); m.update_status(snapshot(206, &[], false, Some("disk full")), cx); });
            v.update(cx, |_, cx| cx.notify());
        },
        reached: |_, _| true },
    State { name: "status", needs_backend: false, opener: None, closes_on_escape: false,
        open: |v, _, cx| { crate::a11y::announce("Accessibility audit status"); v.update(cx, |_, cx| cx.notify()); },
        reached: |_, _| true },
];

fn progress(out: &Path, state: &str, width: u32, phase: &str) {
    let _ = std::fs::write(out.join("progress.json"), serde_json::json!({
        "state": state, "width": width as u32, "phase": phase, "epochMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}).to_string());
}

/// Element id (plain `Name(..)` spelling) of the node that holds keyboard focus.
fn focused_element(w: &Window) -> Option<String> {
    let tree = tree(w).ok()?;
    let node = tree["gpui_focus"].as_str().and_then(|k| tree["nodes"].get(k))?;
    let raw = node["element_id"].as_str()?;
    Some(raw.strip_prefix("Name(\"").and_then(|r| r.strip_suffix("\")")).unwrap_or(raw).to_owned())
}

/// Tab until `id` holds focus, then press Enter: the keyboard way to open a dialog.
fn open_from_keyboard(w: &mut Window, cx: &mut App, id: &str) -> bool {
    for _ in 0..90 {
        key(w, cx, "tab");
        draw(w, cx);
        if focused_element(w).as_deref() == Some(id) {
            key(w, cx, "enter");
            draw(w, cx);
            return true;
        }
    }
    false
}

/// Tab through the focus chain and record where focus lands, up to `limit` stops.
fn tab_walk(w: &mut Window, cx: &mut App, limit: usize, step_key: &'static str, name_unnoded: &dyn Fn(&Window, &App) -> Option<String>) -> anyhow::Result<serde_json::Value> {
    let mut stops: Vec<serde_json::Value> = vec![];
    let mut first: Option<FocusHandle> = None;
    for index in 0..limit {
        key(w, cx, step_key);
        draw(w, cx);
        // Identity is GPUI's own focus id, so a stop without a node still wraps.
        let focus = w.focused(cx);
        let tree = tree(w)?;
        // `gpui_focus` is the ephemeral key of the focused node, if it has one.
        let node = tree["gpui_focus"].as_str().and_then(|k| tree["nodes"].get(k)).cloned().unwrap_or(serde_json::Value::Null);
        if index > 0 && focus.is_some() && focus == first { break; }
        if first.is_none() { first = focus.clone(); }
        stops.push(serde_json::json!({"index": index, "focused": focus.is_some(), "hasNode": !node.is_null(),
            "id": node["element_id"], "role": node["aria"]["role"], "label": node["aria"]["label"],
            // For a stop with no node: which control of the open dialog it is, so the source can be found.
            "unnoded": if node.is_null() { name_unnoded(w, cx).into() } else { serde_json::Value::Null }}));
    }
    Ok(serde_json::json!({"stops": stops, "limit": limit, "wrapped": stops.len() < limit}))
}

struct Probe;
impl Render for Probe {
    fn render(&mut self, _: &mut Window, _: &mut Context<Self>) -> impl IntoElement {
        use gpui_kit::accesskit::Role;
        div().size_full().p(px(24.)).flex().flex_col().gap(px(14.))
            .child(div().w(px(220.)).child(singz_uikit::pill("probe-named", "Named control", true)))
            // Negative control: focusable and actionable, with a role but no name.
            .child(div().id("probe-unlabeled").role(Role::Button).tab_index(0).w(px(80.)).h(px(32.)).on_click(|_, _, _| {}))
    }
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    let inject = std::env::var_os("SINGZ_GPUI_ACCESSIBILITY_ROUTES_INJECT").is_some();
    if inject { handle.update(cx, |_, w, cx| { w.replace_root(cx, |_, _| Probe) }).expect("probe root"); }
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            let step = Duration::from_secs_f64(std::env::var("SINGZ_A11Y_STEP_SECONDS").ok().and_then(|v| v.parse().ok()).unwrap_or(20.));
            std::fs::create_dir_all(&out)?;
            let mut summary = vec![];
            for (width, height) in [(1280.0_f32, 800.0_f32), (1060., 640.)] {
                // Report the resize as its own step, so the driver's per-step budget does
                // not run on from the previous size's last (possibly skipped) state.
                progress(&out, "resize", width as u32, "open");
                handle.update(cx, |_, w, cx| { w.resize(size(px(width), px(height))); draw(w, cx); })?;
                let deadline = Instant::now() + step;
                loop {
                    cx.background_executor().timer(Duration::from_millis(25)).await;
                    let ready = handle.update(cx, |_, w, cx| { draw(w, cx); native_ax(); w.viewport_size() == size(px(width), px(height)) && w.is_a11y_active() })?;
                    if ready { break; }
                    anyhow::ensure!(Instant::now() < deadline, "accessibility activation exceeded the step budget");
                }
                let states: Vec<&State> = if inject { vec![&PROBE_STATE] } else { STATES.iter().collect() };
                for s in states {
                    let tag = format!("{}-{}", s.name, width as u32);
                    progress(&out, s.name, width as u32, "open");
                    // Reset: close anything open with Escape, then restore the base screen.
                    if !inject {
                        for _ in 0..3 {
                            handle.update(cx, |_, w, cx| { key(w, cx, "escape"); draw(w, cx); })?;
                        }
                        handle.update(cx, |_, w, cx| {
                            view.update(cx, |p, cx| {
                                // Whatever Escape left open is closed here, so one failure cannot leak into the next state.
                                p.metronome_open = false; p.carry_open = false;
                                p.project_picker_open = false; p.stem_export_open = false;
                                p.lyrics_editor_open = false; p.library_import_open = false;
                                p.project_delete.update(cx, |d, cx| d.close(cx));
                                // The announcement states move the model wizard's snapshot; put it back.
                                p.models.update(cx, |m, cx| m.update_status(std::sync::Arc::new(crate::model_service::Snapshot { revision: 100, ..Default::default() }), cx));
                                p.screen = base_screen(p); cx.notify();
                            });
                            draw(w, cx);
                        })?;
                    }
                    let has_backend = handle.update(cx, |_, _, cx| view.read(cx).backend.is_some())?;
                    if s.needs_backend && !has_backend {
                        summary.push(serde_json::json!({"state": s.name, "width": width as u32, "reached": false,
                            "reason": "needs a native audio backend; the fixture has none"}));
                        continue;
                    }
                    let mut by_keyboard = false;
                    if let Some(opener) = s.opener {
                        by_keyboard = handle.update(cx, |_, w, cx| {
                            // Start from the app root, as a user arriving at the window does.
                            view.read(cx).focus_handle.clone().focus(w, cx);
                            draw(w, cx);
                            open_from_keyboard(w, cx, opener)
                        })?;
                        if by_keyboard {
                            // Give the key a moment to open the state before falling back.
                            let settle = Instant::now() + Duration::from_secs(2);
                            while Instant::now() < settle {
                                cx.background_executor().timer(Duration::from_millis(25)).await;
                                if handle.update(cx, |_, w, cx| { draw(w, cx); (s.reached)(view.read(cx), cx) })? { break; }
                            }
                            by_keyboard = handle.update(cx, |_, _, cx| (s.reached)(view.read(cx), cx))?;
                        }
                    }
                    if !by_keyboard {
                        handle.update(cx, |_, w, cx| { (s.open)(&view, w, cx); draw(w, cx); })?;
                    }
                    let deadline = Instant::now() + step;
                    let reached = loop {
                        cx.background_executor().timer(Duration::from_millis(25)).await;
                        let ok = handle.update(cx, |_, w, cx| { draw(w, cx); (s.reached)(view.read(cx), cx) })?;
                        if ok { break true; }
                        if Instant::now() >= deadline { break false; }
                    };
                    if !reached {
                        summary.push(serde_json::json!({"state": s.name, "width": width as u32, "reached": false,
                            "reason": "opener refused or step budget expired"}));
                        continue;
                    }
                    progress(&out, s.name, width as u32, "capture");
                    let row = handle.update(cx, |_, w, cx| -> anyhow::Result<serde_json::Value> {
                        draw(w, cx);
                        anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "audit window became visible");
                        anyhow::ensure!(w.is_a11y_active(), "real platform accessibility adapter inactive");
                        let p = view.read(cx);
                        let (screen, dialog) = (p.screen as u8, any_dialog(p, cx));
                        std::fs::write(out.join(format!("{tag}.tree.json")), w.debug_a11y_tree_json().unwrap_or_default())?;
                        std::fs::write(out.join(format!("{tag}.native.json")), serde_json::to_vec_pretty(&native_ax())?)?;
                        // A page walk starts from the app root, so its ring is the same whatever ran before.
                        // An overlay keeps the focus it opened with: that is what proves its trap.
                        if !s.name.starts_with("dialog-") && !s.name.starts_with("popover-") && !matches!(s.name, "settings" | "log" | "models") {
                            view.read(cx).focus_handle.clone().focus(w, cx);
                            draw(w, cx);
                        }
                        let tab = tab_walk(w, cx, 90, "tab", &|w, cx| view.read(cx).lyrics_editor.read(cx).focused_control_name(w))?;
                        std::fs::write(out.join(format!("{tag}.tab.json")), serde_json::to_vec_pretty(&tab)?)?;
                        // Shift+Tab from where the forward walk wrapped must retrace the same ring.
                        let back = tab_walk(w, cx, 90, "shift-tab", &|w, cx| view.read(cx).lyrics_editor.read(cx).focused_control_name(w))?;
                        std::fs::write(out.join(format!("{tag}.shifttab.json")), serde_json::to_vec_pretty(&back)?)?;
                        Ok(serde_json::json!({"state": s.name, "width": width as u32, "reached": true, "screen": screen, "dialogOpen": dialog,
                            "viewport": [f32::from(w.viewport_size().width), f32::from(w.viewport_size().height)]}))
                    })??;
                    let mut row = row;
                    if s.closes_on_escape {
                        progress(&out, s.name, width as u32, "open");
                        handle.update(cx, |_, w, cx| { key(w, cx, "escape"); draw(w, cx); })?;
                        let deadline = Instant::now() + step.min(Duration::from_secs(3));
                        let closed = loop {
                            cx.background_executor().timer(Duration::from_millis(25)).await;
                            let still = handle.update(cx, |_, w, cx| { draw(w, cx); (s.reached)(view.read(cx), cx) })?;
                            if !still { break true; }
                            if Instant::now() >= deadline { break false; }
                        };
                        let after = handle.update(cx, |_, w, _| focused_element(w))?;
                        row["keyboard"] = serde_json::json!({"opener": s.opener, "openedByKeyboard": by_keyboard,
                            "escapeCloses": closed, "focusAfterClose": after});
                    }
                    summary.push(row);
                }
            }
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "passed": true, "inject": inject, "states": summary, "hidden": true,
                "backend": handle.update(cx, |_, _, cx| view.read(cx).backend.is_some())?}))?)?;
            Ok(())
        }.await;
        match result {
            Ok(()) => eprintln!("ACCESSIBILITY_ROUTES passed"),
            Err(error) => {
                eprintln!("ACCESSIBILITY_ROUTES failed: {error:#}");
                let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
            }
        }
        let _ = cx.update(|cx| cx.quit());
    }).detach();
}

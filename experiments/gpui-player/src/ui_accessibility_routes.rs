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
const PROBE_STATE: State = State { name: "probe", needs_backend: false, open: |_, _, _| {}, reached: |_, _| true };
const STATES: &[State] = &[
    State { name: "library", needs_backend: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.songs_catalog = false; p.screen = Screen::Library; cx.notify(); }),
        reached: |p, _| p.screen == Screen::Library },
    State { name: "player", needs_backend: false, open: |v, _, cx| v.update(cx, |p, cx| { p.screen = Screen::Player; cx.notify(); }),
        reached: |p, _| p.screen == Screen::Player },
    State { name: "player-metronome", needs_backend: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.screen = Screen::Player; p.metronome_open = true; cx.notify(); }),
        reached: |p, _| p.metronome_open },
    State { name: "training", needs_backend: false, open: |v, _, cx| header(v, cx, header::HeaderEvent::Training),
        reached: |p, _| p.screen == Screen::Training },
    State { name: "settings", needs_backend: false, open: |v, _, cx| header(v, cx, header::HeaderEvent::Settings),
        reached: |p, _| p.screen == Screen::Settings },
    State { name: "log", needs_backend: false, open: |v, _, cx| header(v, cx, header::HeaderEvent::Log),
        reached: |p, _| p.screen == Screen::Log },
    State { name: "models", needs_backend: false, open: |v, _, cx| v.update(cx, |p, cx| p.open_models(models::Origin::Manual, cx)),
        reached: |p, _| p.screen == Screen::Models },
    State { name: "dialog-language-menu", needs_backend: false, open: |v, w, cx| v.update(cx, |p, cx| p.open_language_menu(w, cx)),
        reached: |p, cx| p.language_menu.read(cx).is_open() },
    State { name: "dialog-quick-start", needs_backend: false, open: |v, _, cx| v.update(cx, |p, cx| p.open_quick_start(false, cx)),
        reached: |p, cx| p.quick_start.read(cx).is_open() },
    State { name: "dialog-whats-new", needs_backend: false, open: |v, _, cx| header(v, cx, header::HeaderEvent::WhatsNew),
        reached: |p, cx| p.whats_new.read(cx).is_open() },
    State { name: "dialog-engine-setup", needs_backend: false, open: |v, _, cx| v.update(cx, |p, cx| p.open_engine_setup(cx)),
        reached: |p, cx| p.engine_setup.read(cx).is_open() },
    State { name: "dialog-notice", needs_backend: false,
        open: |v, _, cx| v.update(cx, |p, cx| { p.notice = Some("Accessibility audit notice".into()); cx.notify(); }),
        reached: |p, _| p.notice.is_some() },
    State { name: "dialog-project-picker", needs_backend: true, open: |v, _, cx| v.update(cx, |p, cx| p.open_project_picker(cx)),
        reached: |p, _| p.project_picker_open },
    State { name: "dialog-drive-projects", needs_backend: false, open: |v, w, cx| v.update(cx, |p, cx| p.open_drive_projects(w, cx)),
        reached: |p, _| p.drive_projects_open },
    State { name: "dialog-stem-export", needs_backend: true, open: |v, _, cx| v.update(cx, |p, cx| p.open_stem_export(cx)),
        reached: |p, _| p.stem_export_open },
    State { name: "dialog-lyrics-editor", needs_backend: true, open: |v, w, cx| v.update(cx, |p, cx| p.open_lyrics_editor(w, cx)),
        reached: |p, _| p.lyrics_editor_open },
];

fn progress(out: &Path, state: &str, width: u32, phase: &str) {
    let _ = std::fs::write(out.join("progress.json"), serde_json::json!({
        "state": state, "width": width as u32, "phase": phase, "epochMs": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)}).to_string());
}

/// Tab through the focus chain and record where focus lands, up to `limit` stops.
fn tab_walk(w: &mut Window, cx: &mut App, limit: usize) -> anyhow::Result<serde_json::Value> {
    let mut stops: Vec<serde_json::Value> = vec![];
    let mut first: Option<FocusHandle> = None;
    for index in 0..limit {
        key(w, cx, "tab");
        draw(w, cx);
        // Identity is GPUI's own focus id, so a stop without a node still wraps.
        let focus = w.focused(cx);
        let tree = tree(w)?;
        // `gpui_focus` is the ephemeral key of the focused node, if it has one.
        let node = tree["gpui_focus"].as_str().and_then(|k| tree["nodes"].get(k)).cloned().unwrap_or(serde_json::Value::Null);
        if index > 0 && focus.is_some() && focus == first { break; }
        if first.is_none() { first = focus.clone(); }
        stops.push(serde_json::json!({"index": index, "focused": focus.is_some(), "hasNode": !node.is_null(),
            "id": node["element_id"], "role": node["aria"]["role"], "label": node["aria"]["label"]}));
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
                            view.update(cx, |p, cx| { p.metronome_open = false; p.screen = base_screen(p); cx.notify(); });
                            draw(w, cx);
                        })?;
                    }
                    let has_backend = handle.update(cx, |_, _, cx| view.read(cx).backend.is_some())?;
                    if s.needs_backend && !has_backend {
                        summary.push(serde_json::json!({"state": s.name, "width": width as u32, "reached": false,
                            "reason": "needs a native audio backend; the fixture has none"}));
                        continue;
                    }
                    handle.update(cx, |_, w, cx| { (s.open)(&view, w, cx); draw(w, cx); })?;
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
                        let tab = tab_walk(w, cx, 90)?;
                        std::fs::write(out.join(format!("{tag}.tab.json")), serde_json::to_vec_pretty(&tab)?)?;
                        Ok(serde_json::json!({"state": s.name, "width": width as u32, "reached": true, "screen": screen, "dialogOpen": dialog,
                            "viewport": [f32::from(w.viewport_size().width), f32::from(w.viewport_size().height)]}))
                    })??;
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

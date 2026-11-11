//! Hidden hand-placed bar line: real drag on the ruler, then the real Re-detect
//! button (Q-05). Native twin of `bar-edit-e2e.cjs` + `redetect-bars-e2e.cjs`.
//!
//! The analyzer is a bounded stub (the driver counts its calls), but project
//! loading, the drag, the popover, the result fold, Save and the file are real.
//! Each stage leaves a JSON record holding both the app state and the bytes on
//! disk, so the driver judges what Drive would sync, not what the screen says.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

fn disk(project: &Path) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?)
}
fn calls(root: &Path) -> usize {
    std::fs::read_to_string(root.join("calls.jsonl")).unwrap_or_default().lines().count()
}
/// Click the Metronome trigger. The open is delivered after the enclosing update, so
/// callers wait for `metronome_open` in a separate step.
fn click_metronome(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    if !view.read(cx).metronome_open {
        let bounds = view.read(cx).transport.read(cx).guides.get("metronome").ok_or_else(|| anyhow::anyhow!("Metronome trigger not measured"))?;
        click(w, cx, bounds.center());
    }
    Ok(())
}
fn click_redetect(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(view.read(cx).metronome_open, "Re-detect needs the open popover");
    let bounds = *view.read(cx).metronome_ui.read(cx).bounds.borrow().get("met-redetect").ok_or_else(|| anyhow::anyhow!("Re-detect control not measured"))?;
    click(w, cx, bounds.center());
    Ok(())
}
/// Grab a bar line that is actually drawn near the middle of the view and move it
/// sideways by `pixels`, with the real pointer: move, press, drag, release.
fn drag_bar(view: &Entity<Player>, w: &mut Window, cx: &mut App, pixels: f32) -> anyhow::Result<f64> {
    draw(w, cx);
    let (bounds, handles) = view.read(cx).beat_handles.read(cx).snapshot();
    let bounds = bounds.ok_or_else(|| anyhow::anyhow!("No bar-line strip bounds: is the grid view on?"))?;
    anyhow::ensure!(handles.len() >= 8, "Only {} bar lines drawn", handles.len());
    let bar = &handles[handles.len() / 2];
    let start = point(bounds.left() + px(bar.x), bounds.center().y);
    let end = point(start.x + px(pixels), start.y);
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position: start, pressed_button: None, modifiers: Default::default() }), cx);
    draw(w, cx);
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent { position: start, button: MouseButton::Left, click_count: 1, ..Default::default() }), cx);
    draw(w, cx);
    for step in 1..=8 {
        let position = point(start.x + (end.x - start.x) * (step as f32 / 8.), start.y);
        w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position, pressed_button: Some(MouseButton::Left), modifiers: Default::default() }), cx);
        draw(w, cx);
    }
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent { position: end, button: MouseButton::Left, click_count: 1, ..Default::default() }), cx);
    draw(w, cx);
    Ok(bar.time)
}
fn snapshot(view: &Entity<Player>, w: &mut Window, cx: &mut App, out: &Path, project: &Path, name: &str, calls_now: usize) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Bar-edit test window became presented or active");
    let p = view.read(cx);
    let popover = p.metronome_ui.read(cx);
    let hand_set = popover.grid.as_ref().and_then(|g| g.user_bars.as_ref()).map(|b| b.len()).unwrap_or(0);
    let state = serde_json::json!({
        "stage": name,
        "beat": p.beats, "disk": disk(project)?["settings"]["beat"].clone(),
        "popoverOpen": p.metronome_open, "popoverHandSetBars": hand_set,
        "popoverText": (hand_set > 0).then(|| i18n::tn("player.metronome.userBars", hand_set as f64, &[])),
        "redetectEnabled": popover.bounds.borrow().contains_key("met-redetect"),
        "job": p.beat_job.is_some(), "pending": p.metronome_pending.is_some(), "autoSavePending": p.beat_auto_save,
        "saving": p.saving, "editSequence": p.edit_seq, "savedSequence": p.saved_seq, "notice": p.notice,
        "analyzerCalls": calls_now, "windowPresented": w.is_visible(), "windowActive": w.is_window_active(),
        "hiddenConfigured": std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),
        "mutedConfigured": std::env::var("SINGZ_MUTE").as_deref() == Ok("1"),
    });
    std::fs::write(out.join(format!("{name}.json")), serde_json::to_vec_pretty(&state)?)?;
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_BAR_EDIT_PROJECT").ok_or_else(|| anyhow::anyhow!("Missing project"))?).canonicalize()?;
            let control = PathBuf::from(std::env::var_os("SINGZ_GPUI_BEAT_CONTROL").ok_or_else(|| anyhow::anyhow!("Missing analyzer control"))?);
            let root = control.parent().unwrap().to_path_buf();
            macro_rules! wait {($label:expr, $predicate:expr)=>{{
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    cx.background_executor().timer(Duration::from_millis(25)).await;
                    let ready = handle.update(cx, |_, w, cx| { draw(w, cx); ($predicate)(view.read(cx)) })?;
                    if ready { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Bar-edit step timed out: {}", $label);
                }
            }};}
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(project.clone(), cx)))?;
            wait!("open", |p: &Player| !p.loading && p.project.as_ref().is_some_and(|v| v.dir == project));
            // A current-stamped auto grid is not re-derived on open; give a wrong
            // automatic run the chance to start before the baseline is taken.
            cx.background_executor().timer(Duration::from_millis(800)).await;
            wait!("grid", |p: &Player| p.beats.as_ref().is_some_and(|g| g.source == "auto") && p.beat_job.is_none() && p.metronome_pending.is_none());
            let opened_calls = calls(&root);
            anyhow::ensure!(opened_calls == 0, "Opening a current auto grid ran the detector ({opened_calls} calls)");
            handle.update(cx, |_, w, cx| snapshot(&view, w, cx, &out, &project, "1-opened", opened_calls))??;

            // ---- drag: the bar saves itself, folded, source still auto -------
            let from = handle.update(cx, |_, w, cx| drag_bar(&view, w, cx, 26.))??;
            wait!("drag recorded", |p: &Player| p.beats.as_ref().is_some_and(|g| g.user_bars.as_ref().is_some_and(|b| b.len() == 1)));
            wait!("drag saved", |p: &Player| p.metronome_pending.is_none() && !p.saving && !p.beat_auto_save && p.saved_seq == p.edit_seq);
            handle.update(cx, |_, w, cx| snapshot(&view, w, cx, &out, &project, "2-dragged", calls(&root)))??;
            std::fs::write(out.join("dragged-from.json"), serde_json::to_vec(&serde_json::json!({"from": from}))?)?;

            // ---- Re-detect: the button, on a current grid --------------------
            handle.update(cx, |_, w, cx| click_metronome(&view, w, cx))??;
            wait!("popover open", |p: &Player| p.metronome_open);
            handle.update(cx, |_, w, cx| snapshot(&view, w, cx, &out, &project, "3-popover-before", calls(&root)))??;
            handle.update(cx, |_, w, cx| click_redetect(&view, w, cx))??;
            wait!("detector started", |p: &Player| p.beat_job.is_some());
            wait!("detector result applied", |p: &Player| p.beat_job.is_none() && p.beat_result.is_none() && p.metronome_pending.is_none());
            handle.update(cx, |_, w, cx| click_metronome(&view, w, cx))??;
            wait!("popover reopened", |p: &Player| p.metronome_open);
            handle.update(cx, |_, w, cx| snapshot(&view, w, cx, &out, &project, "4-redetected", calls(&root)))??;

            // Re-detect marks the project dirty without saving; save as the singer would.
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.save_project(cx)))?;
            wait!("saved", |p: &Player| !p.saving && p.metronome_pending.is_none() && p.saved_seq == p.edit_seq);
            handle.update(cx, |_, w, cx| snapshot(&view, w, cx, &out, &project, "5-saved", calls(&root)))??;
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"done": true}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_BAR_EDIT failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
            let _ = handle.update(cx, |_, w, cx| { draw(w, cx); let _ = w.render_to_image().map(|i| i.save(out.join("failure.png"))); });
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

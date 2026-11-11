//! Hidden model wizard and aligner consent over a real song (Q-05).
//!
//! Native twin of `wizard-consent-e2e.cjs`: with the precise aligner absent the
//! wizard lists every artifact and marks the aligner as not installed, closing it
//! returns to the open song, and pressing Precise shows a consent that names the
//! aligner. The driver puts a `curl` shim first on PATH and watches the model
//! directories: nothing may be fetched or written before an explicit accept.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

fn press_model(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view.read(cx).models.read(cx).bounds(id).ok_or_else(|| anyhow::anyhow!("Wizard control not measured: {id}"))?;
    anyhow::ensure!(b.top() >= px(0.) && b.bottom() <= w.viewport_size().height, "Wizard control {id} outside the viewport: {b:?}");
    click(w, cx, b.center());
    Ok(())
}
fn press_sidebar(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view.read(cx).lyrics_sidebar.read(cx).bounds(id).ok_or_else(|| anyhow::anyhow!("Sidebar control not measured: {id}"))?;
    if let Some(body) = view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-body") {
        anyhow::ensure!(body.contains(&b.center()), "Sidebar control {id} outside its viewport: {b:?} in {body:?}");
    }
    click(w, cx, b.center());
    Ok(())
}
fn wizard_state(p: &Player, w: &Window, cx: &App) -> serde_json::Value {
    let snapshot = &p.models.read(cx).snapshot;
    serde_json::json!({
        "screen": if p.screen == Screen::Models { "models" } else { "other" },
        "rows": snapshot.rows.iter().map(|r| serde_json::json!({
            "id": r.entry.id, "label": r.entry.label, "present": r.present, "optional": r.entry.optional, "downloadMb": r.download_mb,
        })).collect::<Vec<_>>(),
        "busy": snapshot.busy, "running": snapshot.running, "error": snapshot.error, "loaded": snapshot.loaded,
        "project": p.project.as_ref().map(|v| v.dir.clone()),
        "windowPresented": w.is_visible(), "windowActive": w.is_window_active(),
    })
}
fn save(out: &Path, name: &str, value: &serde_json::Value) -> anyhow::Result<()> {
    std::fs::write(out.join(format!("{name}.json")), serde_json::to_vec_pretty(value)?)?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_FIRST_RUN_PROJECT").ok_or_else(|| anyhow::anyhow!("Missing project"))?).canonicalize()?;
            macro_rules! wait {($label:expr, $predicate:expr)=>{{
                let deadline = Instant::now() + Duration::from_secs(30);
                loop {
                    cx.background_executor().timer(Duration::from_millis(25)).await;
                    let ready = handle.update(cx, |_, w, cx| { draw(w, cx); ($predicate)(&view, w, cx) })?;
                    if ready { break; }
                    anyhow::ensure!(Instant::now() < deadline, "First-run step timed out: {}", $label);
                }
            }};}
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            wait!("model catalog", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); p.models.read(cx).snapshot.loaded || p.model_service.as_ref().is_some_and(|s| s.snapshot().loaded) });
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(project.clone(), cx)))?;
            wait!("project open", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); !p.loading && p.project.as_ref().is_some_and(|v| v.dir == project) });
            handle.update(cx, |_, w, cx| -> anyhow::Result<()> { draw(w, cx); let b = view.read(cx).transport.read(cx).guides.get("karaoke").ok_or_else(|| anyhow::anyhow!("Karaoke control not measured"))?; click(w, cx, b.center()); Ok(()) })??;
            wait!("karaoke on", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); p.karaoke });
            wait!("lyrics shown", |view: &Entity<Player>, w: &mut Window, cx: &mut App| { let p = view.read(cx); p.lyrics_sidebar.read(cx).state(w, cx)["status"] == "ready" });

            // ---- 1. the wizard lists every artifact, opened by the singer -----
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_models(models::Origin::Manual, cx)))?;
            wait!("wizard rows", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); p.screen == Screen::Models && !p.models.read(cx).snapshot.rows.is_empty() });
            wait!("wizard idle", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); p.models.read(cx).snapshot.loaded && !p.models.read(cx).snapshot.busy });
            let listed = handle.update(cx, |_, w, cx| { draw(w, cx); let s = wizard_state(view.read(cx), w, cx); let _ = w.render_to_image().map(|i| i.save(out.join("wizard.png"))); s })?;
            save(&out, "wizard", &listed)?;
            // Merely looking at the list must not start anything.
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let still = handle.update(cx, |_, w, cx| { draw(w, cx); wizard_state(view.read(cx), w, cx) })?;
            save(&out, "wizard-after-wait", &still)?;
            anyhow::ensure!(still["busy"] == false, "The wizard started installing by itself: {still}");

            // ---- 2. close returns to the open song ----------------------------
            handle.update(cx, |_, w, cx| press_model(&view, w, cx, "model-close"))??;
            wait!("wizard closed", |view: &Entity<Player>, _: &mut Window, cx: &mut App| { let p = view.read(cx); p.screen == Screen::Player });
            let closed = handle.update(cx, |_, w, cx| { draw(w, cx); wizard_state(view.read(cx), w, cx) })?;
            save(&out, "wizard-closed", &closed)?;
            wait!("precise offered", |view: &Entity<Player>, w: &mut Window, cx: &mut App| { let p = view.read(cx); p.lyrics_sidebar.read(cx).bounds("lyrics-precise").is_some() && p.lyrics_sidebar.read(cx).state(w, cx)["status"] == "ready" });

            // ---- 3. Precise with the aligner missing asks first ---------------
            handle.update(cx, |_, w, cx| press_sidebar(&view, w, cx, "lyrics-precise"))??;
            wait!("aligner consent", |view: &Entity<Player>, w: &mut Window, cx: &mut App| { let p = view.read(cx); p.lyrics_sidebar.read(cx).state(w, cx)["status"] == "consent" });
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let consent = handle.update(cx, |_, w, cx| {
                draw(w, cx);
                let mut s = wizard_state(view.read(cx), w, cx);
                s["sidebar"] = view.read(cx).lyrics_sidebar.read(cx).state(w, cx);
                let _ = w.render_to_image().map(|i| i.save(out.join("consent.png")));
                s
            })?;
            save(&out, "consent", &consent)?;
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"done": true}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_FIRST_RUN failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
            let _ = handle.update(cx, |_, w, cx| { draw(w, cx); let state = view.read(cx).lyrics_sidebar.read(cx).state(w, cx); let _ = std::fs::write(out.join("failure-sidebar.json"), serde_json::to_vec_pretty(&state).unwrap_or_default()); let _ = w.render_to_image().map(|i| i.save(out.join("failure.png"))); });
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

//! Hidden song open with per-step timings and exact project identity (Q-05).
//!
//! Native twin of `tests/e2e/mac/open-steps-e2e.cjs`: a first open, a replacement
//! open (a live song and its graph are retired) and a re-open, each reporting when
//! every observable step first held, measured from the call that asks for the open.
//! The driver owns the budgets, the helper-launch log and the fixture hashes.
use super::ui_training_run::draw;
use super::*;
use std::{path::PathBuf, time::Duration};

fn probe(p: &Player, expected: &std::path::Path) -> serde_json::Value {
    let identity = p.project.as_ref().is_some_and(|project| project.dir == expected);
    let graph = p.last_playback_status.as_ref().is_some_and(|status| status.graph_generation > 0);
    serde_json::json!({
        "loading": p.loading,
        "identity": identity,
        "ready": identity && !p.loading,
        "duration": identity && p.duration > 0.,
        "graph": identity && !p.loading && graph,
    })
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let env_path = |name: &str| std::env::var_os(name).map(PathBuf::from).ok_or_else(|| anyhow::anyhow!("Missing {name}"));
            let (a, b) = (env_path("SINGZ_GPUI_OPEN_STEPS_A")?, env_path("SINGZ_GPUI_OPEN_STEPS_B")?);
            // The window is the only thing that must stay down: hidden, never active.
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            let step_deadline = Duration::from_secs(25);
            let mut records = Vec::new();
            for (label, path) in [("first", &a), ("second", &b), ("reopen", &a)] {
                let expected = path.canonicalize()?;
                let started = Instant::now();
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(expected.clone(), cx)))?;
                let mut steps = serde_json::Map::new();
                let mut settled_at = None;
                loop {
                    let elapsed = started.elapsed();
                    let now = handle.update(cx, |_, w, cx| {
                        draw(w, cx);
                        anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Open-steps test activated its window");
                        Ok(probe(view.read(cx), &expected))
                    })??;
                    for (name, value) in now.as_object().unwrap() {
                        if value == true && !steps.contains_key(name) {
                            steps.insert(name.clone(), serde_json::json!(elapsed.as_secs_f64() * 1000.));
                        }
                    }
                    if ["identity", "ready", "duration", "graph"].iter().all(|name| steps.contains_key(*name)) {
                        settled_at.get_or_insert(Instant::now());
                    }
                    // Hold on after readiness: an open that quietly decodes or re-derives
                    // something does it in the seconds after the song is on screen.
                    if settled_at.is_some_and(|t: Instant| t.elapsed() > Duration::from_millis(1500)) {
                        break;
                    }
                    anyhow::ensure!(
                        started.elapsed() < step_deadline,
                        "Open '{label}' did not reach every step within {step_deadline:?}: steps={steps:?} now={now}"
                    );
                    cx.background_executor().timer(Duration::from_millis(5)).await;
                }
                let record = handle.update(cx, |_, _, cx| {
                    let p = view.read(cx);
                    let project = p.project.as_ref();
                    serde_json::json!({
                        "label": label,
                        "requested": expected,
                        "stepsMs": steps,
                        "project": project.map(|project| project.dir.clone()),
                        "name": project.map(|project| project.name.clone()),
                        "laneSlots": project.map(|project| project.lanes.iter().map(|(slot, _)| *slot).collect::<Vec<_>>()),
                        "duration": p.duration,
                        "epoch": p.native_epoch,
                        "notice": p.notice,
                        "saving": p.saving,
                        "beatJob": p.beat_job.is_some(),
                        "playing": p.playing,
                        "hidden": true,
                        "muted": std::env::var("SINGZ_MUTE").as_deref() == Ok("1"),
                    })
                })?;
                std::fs::write(out.join(format!("open-{label}.json")), serde_json::to_vec_pretty(&record)?)?;
                records.push(record);
            }
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"opens": records}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_OPEN_STEPS failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

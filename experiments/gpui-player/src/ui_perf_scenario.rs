//! Test-only hidden performance scenario controlled by request/receipt files.
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn receipt(
    dir: &Path,
    action: &str,
    result: anyhow::Result<serde_json::Value>,
) -> anyhow::Result<()> {
    let value = match result {
        Ok(detail) => serde_json::json!({"action": action, "completed": true, "detail": detail}),
        Err(error) => {
            serde_json::json!({"action": action, "completed": false, "error": format!("{error:#}")})
        }
    };
    let tmp = dir.join("receipt.tmp");
    std::fs::write(&tmp, serde_json::to_vec(&value)?)?;
    std::fs::rename(tmp, dir.join("receipt.json"))?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, dir: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1") && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(), "scenario requires hidden muted mode");
            std::fs::create_dir_all(&dir)?;
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(|| anyhow::anyhow!("missing project fixture"))?).canonicalize()?;
            let second = std::env::var_os("SINGZ_GPUI_PERF_SECOND_PROJECT").map(PathBuf::from).unwrap_or_else(|| project.clone()).canonicalize()?;
            let deadline_secs = std::env::var("SINGZ_PERF_STEP_TIMEOUT").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(120.);
            anyhow::ensure!(deadline_secs.is_finite() && deadline_secs > 0., "invalid step timeout");
            let burst_secs = std::env::var("SINGZ_PERF_BURST_SECONDS").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(5.);
            let cycles = std::env::var("SINGZ_PERF_CYCLES").ok().and_then(|v| v.parse::<usize>().ok()).unwrap_or(20);
            let cycle_delay = std::env::var("SINGZ_PERF_CYCLE_DELAY").ok().and_then(|v| v.parse::<f64>().ok()).unwrap_or(0.5);
            anyhow::ensure!(cycle_delay.is_finite() && cycle_delay >= 0., "invalid cycle delay");
            macro_rules! wait_for { ($predicate:expr) => {{
                let deadline = Instant::now() + Duration::from_secs_f64(deadline_secs);
                loop {
                    let ready = handle.update(cx, |_, window, app| -> anyhow::Result<bool> {
                        anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "scenario window became visible");
                        let player = view.read(app);
                        anyhow::ensure!(player.notice.is_none(), "player notice: {:?}", player.notice);
                        Ok(($predicate)(player))
                    })??;
                    if ready { break; }
                    anyhow::ensure!(Instant::now() < deadline, "scenario step timed out");
                    cx.background_executor().timer(Duration::from_millis(25)).await;
                }
            }}; }
            loop {
                let request = dir.join("request.json");
                if !request.exists() { cx.background_executor().timer(Duration::from_millis(25)).await; continue; }
                let command: serde_json::Value = serde_json::from_slice(&std::fs::read(&request)?)?;
                std::fs::remove_file(&request)?;
                let action = command["action"].as_str().ok_or_else(||anyhow::anyhow!("missing action"))?.to_owned();
                let step: anyhow::Result<serde_json::Value> = async {
                    match action.as_str() {
                        "launch" => {
                            handle.update(cx, |_, window, app| { window.resize(size(px(1280.), px(800.))); super::ui_training_run::draw(window, app); })?;
                            let deadline = Instant::now() + Duration::from_secs_f64(deadline_secs);
                            loop {
                                let ready = handle.update(cx, |_, window, app| -> anyhow::Result<bool> {
                                    super::ui_training_run::draw(window, app);
                                    anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "scenario window became visible");
                                    let player = view.read(app);
                                    Ok(player.screen == Screen::Library && player.library.read(app).project_snapshot().as_array().is_some_and(|rows| rows.iter().any(|row| row["dir"].as_str().is_some_and(|path| Path::new(path) == project.as_path()))))
                                })??;
                                if ready { break; }
                                anyhow::ensure!(Instant::now() < deadline, "catalog did not become interactive");
                                cx.background_executor().timer(Duration::from_millis(25)).await;
                            }
                            Ok(serde_json::json!({"interactive": true}))
                        }
                        "open" => {
                            handle.update(cx, |_, _, app| view.update(app, |p, app| p.open_project(project.clone(), app)))?;
                            wait_for!(|p: &Player| !p.loading && p.project.is_some() && p.backend.is_some() && p.duration > 0.);
                            Ok(serde_json::json!({"opened": true}))
                        }
                        "play" => {
                            handle.update(cx, |_, _, app| view.update(app, |p, app| p.toggle(app)))?;
                            wait_for!(|p: &Player| p.playing && p.playhead.position() > 0.05 && p.last_playback_status.as_ref().is_some_and(|s| s.playing));
                            Ok(serde_json::json!({"playing": true}))
                        }
                        "burst" => {
                            anyhow::ensure!(burst_secs.is_finite() && burst_secs >= 0., "invalid burst duration");
                            let started = Instant::now(); let mut iterations = 0;
                            while started.elapsed().as_secs_f64() < burst_secs {
                                handle.update(cx, |_, window, app| -> anyhow::Result<()> {
                                    super::ui_training_run::draw(window, app);
                                    anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "scenario window became visible during burst");
                                    anyhow::ensure!(view.read(app).playing, "playback stopped before the burst completed");
                                    let bounds = view.read(app).region.bounds.get().ok_or_else(||anyhow::anyhow!("timeline bounds missing"))?;
                                    let position = point(bounds.left() + bounds.size.width * 0.5, bounds.top() + px(10.));
                                    let zoom_delta = if iterations % 2 == 0 { -44.6 } else { 44.6 };
                                    for (dx, dy, zoom) in [(120., 0., false), (0., zoom_delta, true)] {
                                        window.dispatch_event(PlatformInput::Scroll(ScrollEvent { position, delta: ScrollDelta::Pixels(point(px(-dx), px(-dy))), modifiers: Modifiers { control: zoom, ..Default::default() }, ..Default::default() }), app);
                                    }
                                    let dimensions = if iterations % 2 == 0 { (1060., 640.) } else { (1280., 800.) };
                                    window.resize(size(px(dimensions.0), px(dimensions.1)));
                                    Ok(())
                                })??;
                                iterations += 1;
                                let expected = if iterations % 2 == 1 { (1060., 640.) } else { (1280., 800.) };
                                let resize_deadline = Instant::now() + Duration::from_secs(5);
                                loop {
                                    cx.background_executor().timer(Duration::from_millis(25)).await;
                                    if handle.update(cx, |_, window, _| window.viewport_size() == size(px(expected.0), px(expected.1)))? { break; }
                                    anyhow::ensure!(Instant::now() < resize_deadline, "burst resize was not acknowledged");
                                }
                            }
                            let lanes = handle.update(cx, |_, _, app| view.read(app).last_playback_status.as_ref().map(|s|s.observed_lanes.clone()))?;
                            Ok(serde_json::json!({"iterations": iterations, "observedLanes": lanes}))
                        }
                        "pause" => {
                            anyhow::ensure!(handle.update(cx, |_, _, app| view.read(app).playing)?, "playback stopped before pause");
                            handle.update(cx, |_, _, app| view.update(app, |p, app| p.toggle(app)))?;
                            wait_for!(|p: &Player| !p.playing && p.last_playback_status.as_ref().is_some_and(|s| !s.playing));
                            Ok(serde_json::json!({"paused": true}))
                        }
                        "cycles" => {
                            for index in 0..cycles {
                                handle.update(cx, |_, _, app| view.update(app, |p, app| p.enter_desktop_catalog(app)))?;
                                wait_for!(|p: &Player| p.screen == Screen::Library && !p.playing);
                                let path = if index % 2 == 0 { second.clone() } else { project.clone() };
                                let epoch = handle.update(cx, |_, _, app| view.read(app).native_epoch)?;
                                handle.update(cx, |_, _, app| view.update(app, |p, app| p.open_project(path, app)))?;
                                wait_for!(|p: &Player| !p.loading && p.project.is_some() && p.native_epoch > epoch);
                                cx.background_executor().timer(Duration::from_secs_f64(cycle_delay)).await;
                            }
                            Ok(serde_json::json!({"cycles": cycles, "closed": null, "closeReason": "catalog navigation retains the active project until the next open"}))
                        }
                        "seek-refusal" | "invalid-control-refusal" => {
                            // This existing harness is ui-tests-only, hidden and muted.
                            // Exercise the real Control -> helper -> UI event path.
                            let (before, probe) = handle.update(cx, |_, _, app| -> anyhow::Result<_> {
                                let p=view.read(app);
                                anyhow::ensure!(p.loaded_song && p.project.is_some() && p.notice.is_none() && !p.tracks_audio_failed, "refusal test requires a loaded song");
                                let state=serde_json::json!({
                                    "project":p.project.as_ref().map(|p|&p.dir), "loadedSong":p.loaded_song,
                                    "epoch":p.native_epoch, "tracksAudioFailed":p.tracks_audio_failed, "laneRevision":p.native_lane_revision,
                                    "carryRevision":p.native_carry_revision,
                                    "route":p.last_playback_status.as_ref().map(|s|&s.output_uid),
                                });
                                let backend=p.backend.as_ref().ok_or_else(||anyhow::anyhow!("missing backend"))?;
                                Ok((state,backend.probe_owned_audio(p.native_epoch)?))
                            })??;
                            macro_rules! read_probe { ($receiver:expr) => {{
                                let receiver=$receiver;
                                let deadline=Instant::now()+Duration::from_secs_f64(deadline_secs);
                                loop {
                                    match receiver.try_recv() {
                                        Ok(value)=>break value.map_err(|e|anyhow::anyhow!(e))?,
                                        Err(std::sync::mpsc::TryRecvError::Empty)=>{},
                                        Err(error)=>anyhow::bail!("probe disconnected: {error}"),
                                    }
                                    anyhow::ensure!(Instant::now()<deadline,"native refusal probe timed out");
                                    cx.background_executor().timer(Duration::from_millis(5)).await;
                                }
                            }}; }
                            let old=read_probe!(probe);
                            handle.update(cx, |_,_,app|->anyhow::Result<()> {
                                let p=view.read(app);
                                let command=if action=="invalid-control-refusal" {"invalid-control-test-command".into()} else {format!("seek {}",p.duration+10.)};
                                p.backend.as_ref().unwrap().control(p.native_epoch,command)
                            })??;
                            let deadline=Instant::now()+Duration::from_secs_f64(deadline_secs);
                            let (after,probe)=loop {
                                let state=handle.update(cx,|_,window,app|->anyhow::Result<_> {
                                    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"refusal test activated its window");
                                    let p=view.read(app);
                                    if p.notice.is_none() {return Ok(None);}
                                    let state=serde_json::json!({
                                        "project":p.project.as_ref().map(|p|&p.dir), "loadedSong":p.loaded_song,
                                        "epoch":p.native_epoch, "tracksAudioFailed":p.tracks_audio_failed, "laneRevision":p.native_lane_revision,
                                        "carryRevision":p.native_carry_revision,
                                        "route":p.last_playback_status.as_ref().map(|s|&s.output_uid),
                                    });
                                    anyhow::ensure!(state==before,"Control refusal discarded loaded song or route: before={before} after={state}");
                                    Ok(Some((state,p.backend.as_ref().unwrap().probe_owned_audio(p.native_epoch)?)))
                                })??;
                                if let Some(state)=state {break state;}
                                anyhow::ensure!(Instant::now()<deadline,"Control refusal notice did not arrive");
                                cx.background_executor().timer(Duration::from_millis(5)).await;
                            };
                            let retained=read_probe!(probe);
                            anyhow::ensure!(old.helper_pid==retained.helper_pid && old.status.output_uid==retained.status.output_uid
                                && old.status.lane_revision==retained.status.lane_revision && old.status.carry_revision==retained.status.carry_revision,
                                "refusal changed native ownership");
                            // Clear only the test notice so Quit can use the normal path.
                            handle.update(cx,|_,_,app|view.update(app,|p,app| {p.notice=None;app.notify();}))?;
                            Ok(serde_json::json!({"before":before,"after":after,"helperPid":retained.helper_pid,"statusSucceeded":true}))
                        }
                        "quit" => Ok(serde_json::json!({"quit": true})),
                        _ => anyhow::bail!("unknown scenario action {action}"),
                    }
                }.await;
                let failed = step.is_err();
                receipt(&dir, &action, step)?;
                if failed { anyhow::bail!("scenario action {action} failed"); }
                if action == "quit" { break; }
            }
            Ok(())
        }.await;
        if let Err(error) = result { eprintln!("PERF_SCENARIO failed: {error:#}"); std::process::exit(1); }
        let _ = cx.update(|app| app.quit());
    }).detach();
}

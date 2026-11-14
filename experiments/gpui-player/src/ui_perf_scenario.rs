//! Test-only hidden performance scenario controlled by request/receipt files.
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

/// Upper bound on a measuring window extended by `minFrames`, well inside the control timeout.
const MAX_WINDOW_SECONDS: f64 = 30.;

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
            // The driver is test scaffolding inside the measured process: it polls
            // briskly after a request (steps are timed) and slowly once the
            // harness has been silent for a second (a paused or idle phase), so
            // it does not inflate the idle CPU it is there to measure.
            let mut quiet_polls = 0_u32;
            loop {
                let request = dir.join("request.json");
                if !request.exists() {
                    quiet_polls = quiet_polls.saturating_add(1);
                    let wait = if quiet_polls > 40 { 100 } else { 25 };
                    cx.background_executor().timer(Duration::from_millis(wait)).await;
                    continue;
                }
                quiet_polls = 0;
                let command: serde_json::Value = serde_json::from_slice(&std::fs::read(&request)?)?;
                std::fs::remove_file(&request)?;
                let action = command["action"].as_str().ok_or_else(||anyhow::anyhow!("missing action"))?.to_owned();
                let step: anyhow::Result<serde_json::Value> = async {
                    match action.as_str() {
                        "render-metrics" => {
                            let waveform = super::waveform::metrics();
                            Ok(serde_json::json!({
                                "framesRequested": super::UI_FRAME_REQUESTS.load(std::sync::atomic::Ordering::Relaxed),
                                "frameDemandBits": super::UI_FRAME_DEMAND_BITS.load(std::sync::atomic::Ordering::Relaxed),
                                "waveformCacheMisses": waveform.cache_misses,
                                "textureAllocations": waveform.texture_allocations,
                                "textureReleases": waveform.texture_releases,
                                "liveTextures": waveform.live_textures,
                                "mainThreadRasterizations": waveform.main_thread_rasterizations,
                                "backgroundRasterizations": waveform.background_rasterizations,
                                "lanePlayheadPaintAllocations": super::alloc_probe::count(),
                                "lyricPitchPaintAllocations": super::alloc_probe::text_count(),
                                "pitchPaintAllocations": super::alloc_probe::pitch_count(),
                                "pitchTracePathEngineAllocations": super::alloc_probe::exempt_count(),
                                "countdownAnimationAllocations": super::alloc_probe::animation_count(),
                                "lyricPaints": super::alloc_probe::lyric_paints(),
                                "pitchPaints": super::alloc_probe::pitch_paints(),
                                "pitchTracePaints": super::pitch_strip::trace_paints(),
                                "advancingWords": super::lyrics_view::paint_counts().0,
                                "advancingGlowDraws": super::lyrics_view::paint_counts().1,
                                "countdownSpritePaints": super::lyrics_view::paint_counts().2,
                                "countdownSpriteRequests": super::lyrics_view::paint_counts().3,
                                "lyricShapeMisses": super::lyrics_view::shape_misses(),
                                "pitchLabelMisses": super::pitch_strip::label_misses(),
                                "pitchTraceMisses": super::pitch_strip::trace_misses(),
                                "lyricShapeEntries": handle.update(cx, |_, _, app| view.read(app).shape_cache.borrow().len())?,
                                "pitchLabelEntries": super::pitch_strip::label_count()}))
                        }
                        // Paused sweep of the lyric timeline at 120 Hz steps: every frame
                        // moves the position (so active words, the feathered band and the
                        // pitch strip's playhead all change) and draws. Run it once to warm
                        // the caches and again to measure.
                        "lyric-pitch-sweep" => {
                            let start = command["start"].as_f64().unwrap_or(0.);
                            let frames = command["frames"].as_u64().unwrap_or(600);
                            anyhow::ensure!(start.is_finite() && start >= 0. && frames > 0, "invalid sweep");
                            for frame in 0..frames {
                                handle.update(cx, |_, window, app| -> anyhow::Result<()> {
                                    anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "scenario window became visible");
                                    view.update(app, |p, cx| { p.playhead.seek(start + frame as f64 / 120.); cx.notify(); });
                                    let _ = window.draw(app);
                                    Ok(())
                                })??;
                                // Yield now and then so the helper's status traffic is serviced.
                                if frame % 50 == 49 { cx.background_executor().timer(Duration::from_millis(1)).await; }
                            }
                            Ok(serde_json::json!({"frames": frames}))
                        }
                        // Karaoke shows the lyric canvas and the pitch strip.
                        "karaoke" => {
                            handle.update(cx, |_, window, app| {
                                view.update(app, |p, cx| { p.karaoke = true; p.transport.update(cx, |t, cx| t.set_karaoke(true, cx)); cx.notify(); });
                                super::ui_training_run::draw(window, app);
                            })?;
                            Ok(serde_json::json!({"karaoke": true}))
                        }
                        "seek" => {
                            let to = command["to"].as_f64().unwrap_or(0.);
                            // `native` also moves the audio engine, as a click on a lyric does; without it
                            // the engine keeps its own position and playback pulls the playhead back.
                            let native = command["native"].as_bool().unwrap_or(false);
                            handle.update(cx, |_, window, app| { view.update(app, |p, cx| { p.playhead.seek(to); if native { p.seek_native(cx); } cx.notify(); }); let _ = window.draw(app); })?;
                            Ok(serde_json::json!({"to": to}))
                        }
                        "seed-meter" => {
                            let held = command["held"].as_f64().unwrap_or(1.) as f32;
                            handle.update(cx, |_, _, app| view.read(app).transport.clone().update(app, |t, cx| t.ui_seed_meter(held, cx)))?;
                            Ok(serde_json::json!({"seeded": held}))
                        }
                        "draw" => { handle.update(cx, |_, window, app| super::ui_training_run::draw(window, app))?; Ok(serde_json::json!({"drawn": true})) }
                        "output-meter" => handle.update(cx, |_, _, app| Ok::<_, anyhow::Error>(view.read(app).transport.read(app).output_state()))?,
                        // One simulated display link at ~120 Hz. A frame is demanded when
                        // GPUI has a next-frame callback pending or the window is dirty
                        // (any displayed view, nested ones included, was notified or
                        // refreshed since the last draw): exactly what a platform frame
                        // source acts on. Only then does the tick draw, as a real window would.
                        "idle-window" | "steady-playback" => {
                            let playing = action == "steady-playback";
                            let settle = command["settleSeconds"].as_f64().unwrap_or(if playing { 0. } else { 2. });
                            let seconds = command["seconds"].as_f64().unwrap_or(2.);
                            // A slow renderer (a CI VM) draws fewer frames per second; keep measuring
                            // until the window has demanded enough frames to mean something.
                            let min_frames = command["minFrames"].as_u64().unwrap_or(0);
                            anyhow::ensure!(settle >= 0. && seconds > 0. && settle.is_finite() && seconds.is_finite(), "invalid window duration");
                            if !playing {
                                // Draw the target state before settling, so a change made by the
                                // previous action (still dirty or mid-animation) is on screen.
                                handle.update(cx, |_, window, app| super::ui_training_run::draw(window, app))?;
                            }
                            let (mut demanded, mut callbacks, mut dirtied) = (0u64, 0u64, 0u64);
                            let mut trace: Vec<String> = Vec::new();
                            let mut measured_seconds = 0.;
                            for (measuring, duration) in [(false, settle), (true, seconds)] {
                                let started = Instant::now();
                                while started.elapsed().as_secs_f64() < duration
                                    || (measuring && demanded < min_frames && started.elapsed().as_secs_f64() < MAX_WINDOW_SECONDS)
                                {
                                    let (pending, dirty) = handle.update(cx, |_, window, app| -> anyhow::Result<(usize, bool)> {
                                        anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "scenario window became visible");
                                        if playing { anyhow::ensure!(view.read(app).playing, "playback stopped during steady window"); }
                                        let pending = window.simulate_next_frame(app);
                                        let dirty = window.is_dirty();
                                        if pending > 0 { window.refresh(); }
                                        if pending > 0 || dirty { let _ = window.draw(app); }
                                        Ok((pending, dirty))
                                    })??;
                                    if measuring {
                                        if trace.len() < 24 && (pending > 0 || dirty) { trace.push(format!("{}ms pending={pending} dirty={dirty}", started.elapsed().as_millis())); }
                                        callbacks += pending as u64;
                                        dirtied += u64::from(dirty);
                                        demanded += u64::from(pending > 0 || dirty);
                                    }
                                    cx.background_executor().timer(Duration::from_millis(8)).await;
                                }
                                if measuring { measured_seconds = started.elapsed().as_secs_f64(); }
                            }
                            Ok(serde_json::json!({"demandedFrames": demanded, "pendingCallbacks": callbacks, "dirtyTicks": dirtied, "seconds": measured_seconds, "trace": trace}))
                        }
                        // First-run Models screen (D-02 N5): open it, start the fixture download,
                        // and read the service's published progress.
                        "open-models" => {
                            handle.update(cx, |_, _, app| view.update(app, |p, cx| p.open_models(super::models::Origin::Manual, cx)))?;
                            Ok(serde_json::json!({"models": true}))
                        }
                        "models-download" => {
                            handle.update(cx, |_, _, app| view.update(app, |p, _| match &p.model_service {
                                Some(service) => service.download(None),
                                None => Err(anyhow::anyhow!("no model service")),
                            }))??;
                            Ok(serde_json::json!({"started": true}))
                        }
                        "models-state" => handle.update(cx, |_, _, app| {
                            let snapshot = view.read(app).model_service.as_ref().map(|service| service.snapshot());
                            Ok::<_, anyhow::Error>(match snapshot {
                                Some(s) => serde_json::json!({"busy": s.busy, "revision": s.revision, "error": s.error,
                                    "progress": s.progress.values().copied().fold(0f32, f32::max),
                                    "requiredDone": s.required_done()}),
                                None => serde_json::json!({"busy": false, "missing": true}),
                            })
                        })?,
                        "open-modal" | "close-modal" => {
                            // A notice is a real modal: the backdrop, the Close control and the
                            // modal clock freeze all engage (`output_covered`).
                            let open = action == "open-modal";
                            handle.update(cx, |_, _, app| view.update(app, |p, cx| { p.notice = open.then(|| "Idle-redraw modal probe".to_owned()); cx.notify(); }))?;
                            Ok(serde_json::json!({"modal": open}))
                        }
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
                        "frames" => frames_action(&command, handle, cx, &dir),
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

/// `frames` action: `{"op":"start"}` begins recording presented frames,
/// `{"op":"stop"}` ends it and returns the frame slots (and writes `frames.json`).
/// A hidden window reports the slots as null with a reason, never zero.
fn frames_action(command: &serde_json::Value, handle: AnyWindowHandle, cx: &mut gpui::AsyncApp, dir: &Path) -> anyhow::Result<serde_json::Value> {
    match command["op"].as_str() {
        Some("start") => {
            super::frame_log::start()?;
            Ok(serde_json::json!({"recording": true}))
        }
        Some("stop") => {
            let hidden = handle.update(cx, |_, window, _| !window.is_visible())?;
            let samples = super::frame_log::stop();
            let period = command["periodS"].as_f64();
            let mut value = super::frame_log::report(&samples, period, hidden);
            value["hidden"] = hidden.into();
            let tmp = dir.join("frames.tmp");
            let mut file = value.clone();
            file["presentedTimes"] = samples.iter().map(|s| s.presented).collect::<Vec<_>>().into();
            std::fs::write(&tmp, serde_json::to_vec(&file)?)?;
            std::fs::rename(tmp, dir.join("frames.json"))?;
            Ok(value)
        }
        other => anyhow::bail!("frames op must be start or stop, got {other:?}"),
    }
}

/// Visible live driver for presented-frame measurement (D-02 5.3): the window is
/// shown and active, muted. Actions: `launch`, `animate` (`mode`: off, static,
/// stall, notify100), `frames` (start/stop), `quit`.
pub fn run_visible(handle: AnyWindowHandle, view: Entity<Player>, dir: PathBuf, cx: &mut App) {
    use std::sync::atomic::{AtomicU8, AtomicU64, Ordering};
    use std::sync::Arc;
    const OFF: u8 = 0; const STATIC: u8 = 1; const STALL: u8 = 2; const NOTIFY: u8 = 3;
    fn pump(window: &mut Window, mode: Arc<AtomicU8>, count: Arc<AtomicU64>, stalls: Arc<AtomicU64>, id: EntityId) {
        window.on_next_frame(move |window, cx| {
            let current = mode.load(Ordering::Relaxed);
            if current != STATIC && current != STALL { return; }
            // An injected stall: a 25 ms sleep on every 60th frame.
            if current == STALL && count.fetch_add(1, Ordering::Relaxed) % 60 == 59 {
                stalls.fetch_add(1, Ordering::Relaxed);
                std::thread::sleep(Duration::from_millis(25));
            }
            cx.notify(id);
            pump(window, mode, count, stalls, id);
        });
    }
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1") && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_none(), "visible frame run requires a muted, visible window");
            std::fs::create_dir_all(&dir)?;
            let mode = Arc::new(AtomicU8::new(OFF));
            let count = Arc::new(AtomicU64::new(0));
            let stalls = Arc::new(AtomicU64::new(0)); // stalls injected so far, for the drop check
            let mut stalls_at_start = 0_u64;
            // While recording, the window must stay visible and key (D-02 5.3): count the
            // idle-loop ticks on which it was not, so a run another app disturbed is rejected.
            let (mut recording, mut ticks, mut lost, mut poll) = (false, 0_u64, 0_u64, true);
            let mut quiet_polls = 0_u32; // see the first driver loop: slow once the harness is silent
            loop {
                let request = dir.join("request.json");
                if !request.exists() {
                    quiet_polls = quiet_polls.saturating_add(1);
                    if recording && poll {
                        let fit = handle.update(cx, |_, window, _| window.is_visible() && window.is_window_active())?;
                        ticks += 1; lost += u64::from(!fit);
                    }
                    let wait = if quiet_polls > 40 && !recording { 100 } else { 25 };
                    cx.background_executor().timer(Duration::from_millis(wait)).await;
                    continue;
                }
                quiet_polls = 0;
                let command: serde_json::Value = serde_json::from_slice(&std::fs::read(&request)?)?;
                std::fs::remove_file(&request)?;
                let action = command["action"].as_str().ok_or_else(|| anyhow::anyhow!("missing action"))?.to_owned();
                let step: anyhow::Result<serde_json::Value> = async {
                    match action.as_str() {
                        "launch" => {
                            handle.update(cx, |_, window, _| { window.resize(size(px(1280.), px(800.))); window.activate_window(); })?;
                            let deadline = Instant::now() + Duration::from_secs(30);
                            loop {
                                let (visible, active, scale) = handle.update(cx, |_, window, _| (window.is_visible(), window.is_window_active(), window.scale_factor()))?;
                                if visible && active { break Ok(serde_json::json!({"visible": visible, "active": active, "scale": scale})); }
                                anyhow::ensure!(Instant::now() < deadline, "window did not become visible and active");
                                cx.background_executor().timer(Duration::from_millis(50)).await;
                            }
                        }
                        "animate" => {
                            let next = match command["mode"].as_str() {
                                Some("off") => OFF, Some("static") => STATIC, Some("stall") => STALL, Some("notify100") => NOTIFY,
                                other => anyhow::bail!("unknown animate mode {other:?}"),
                            };
                            mode.store(next, Ordering::Relaxed);
                            count.store(0, Ordering::Relaxed);
                            super::frame_log::force_demand(next == STATIC || next == STALL);
                            if next == STATIC || next == STALL {
                                let (mode, count, stalls, view) = (mode.clone(), count.clone(), stalls.clone(), view.clone());
                                handle.update(cx, |_, window, app| { pump(window, mode, count, stalls, view.entity_id()); app.notify(view.entity_id()); })?;
                            } else if next == NOTIFY {
                                let (mode, view) = (mode.clone(), view.clone());
                                cx.spawn(async move |cx| {
                                    while mode.load(Ordering::Relaxed) == NOTIFY {
                                        let _ = cx.update(|app| app.notify(view.entity_id()));
                                        cx.background_executor().timer(Duration::from_millis(100)).await;
                                    }
                                }).detach();
                            }
                            Ok(serde_json::json!({"mode": command["mode"]}))
                        }
                        "probe" => handle.update(cx, |_, window, app| {
                            let p = view.read(app);
                            serde_json::json!({
                                "screen": p.screen as u8, "playing": p.playing, "visible": window.is_visible(), "active": window.is_window_active(),
                                "quickStartOpen": p.quick_start.read(app).is_open(), "whatsNewOpen": p.whats_new.read(app).is_open(),
                                "engineSetupOpen": p.engine_setup.read(app).is_open(),
                                "localeLoaded": p.locale_service.snapshot().loaded, "localePending": p.locale_service.snapshot().pending,
                                "screenName": format!("{}", ["Training", "Player", "Library", "Settings", "Log", "Models"][p.screen as usize]), "noticeOpen": p.notice.is_some(),
                                "libraryAnimationSuspended": matches!(p.screen, Screen::Settings | Screen::Log | Screen::Models)
                                    || p.notice.is_some() || p.quick_start.read(app).is_open() || p.whats_new.read(app).is_open() || p.engine_setup.read(app).is_open(),
                            })
                        }).map_err(Into::into),
                        "frames" => {
                            let op = command["op"].as_str().map(str::to_owned);
                            if op.as_deref() == Some("start") { (recording, ticks, lost) = (true, 0, 0); poll = command["poll"].as_bool().unwrap_or(true); stalls_at_start = stalls.load(Ordering::Relaxed); }
                            let mut value = frames_action(&command, handle, cx, &dir)?;
                            if op.as_deref() == Some("stop") {
                                recording = false;
                                value["windowTicks"] = ticks.into();
                                value["windowLostTicks"] = lost.into();
                                value["stallsInjected"] = (stalls.load(Ordering::Relaxed) - stalls_at_start).into();
                            }
                            Ok(value)
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
        if let Err(error) = result { eprintln!("FRAMES_SCENARIO failed: {error:#}"); std::process::exit(1); }
        let _ = cx.update(|app| app.quit());
    }).detach();
}

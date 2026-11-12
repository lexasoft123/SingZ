//! Hidden long-song, open/close-cycle and large-library scenarios (Q-14).
//!
//! One launch runs one stage (`SINGZ_GPUI_LONG_STAGE`): `songs` opens each long song,
//! plays it, seeks near its end, loops near its end and plays it out; `cycles` opens
//! two songs alternately; `library` loads, scrolls, searches and opens from a large
//! library. The app reports what it observed; the driver owns every budget and, for
//! memory, every sample: a phase is announced by writing `marks/<name>.ready` and the
//! hook holds until the driver answers with `marks/<name>.ack`, so a footprint sample
//! is taken at exactly that point. No OS input, no activation, muted.
use super::ui_training_run::{click, draw};
use super::*;
use crate::ui_transport_legs::QuarterLoopJudge;
use crate::ui_transport_timing::press;
use crate::library;
use std::{
    path::PathBuf,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

fn epoch() -> f64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_secs_f64()).unwrap_or(0.)
}

/// One simulated frame; wall time of `Window::draw` is the CPU cost of a frame.
fn frame(w: &mut Window, cx: &mut App) -> f64 {
    let started = Instant::now();
    w.simulate_next_frame(cx);
    w.refresh();
    w.draw(cx).clear(cx);
    started.elapsed().as_secs_f64() * 1000.
}

fn summary(samples: &[f64]) -> serde_json::Value {
    if samples.is_empty() {
        return serde_json::json!({"count": 0});
    }
    let mut ordered = samples.to_vec();
    ordered.sort_by(|a, b| a.total_cmp(b));
    let at = |q: f64| ordered[((ordered.len() as f64 * q).ceil() as usize).clamp(1, ordered.len()) - 1];
    serde_json::json!({"count": ordered.len(), "p50": at(0.5), "p99": at(0.99), "max": ordered[ordered.len() - 1],
        "mean": ordered.iter().sum::<f64>() / ordered.len() as f64})
}

fn starved(p: &Player) -> Vec<serde_json::Value> {
    p.last_playback_status.as_ref().map(|s| s.observed_lane_streaming()).unwrap_or_default().into_iter()
        .map(|lane| serde_json::json!({"id": lane.id, "streamed": lane.streamed, "starvedBlocks": lane.starved_blocks, "stagedJumps": lane.staged_jumps}))
        .collect()
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(out.join("marks"))?;
            let stage = std::env::var("SINGZ_GPUI_LONG_STAGE").unwrap_or_default();
            let plan: serde_json::Value = serde_json::from_str(&std::env::var("SINGZ_GPUI_LONG_PLAN")?)?;
            macro_rules! wait {($p:ident, $w:ident, $app:ident => $test:expr, $limit:expr) => {{
                let deadline = Instant::now() + Duration::from_secs($limit);
                loop {
                    cx.background_executor().timer(Duration::from_millis(10)).await;
                    if handle.update(cx, |_, $w, $app| { let $p = view.read($app); let _ = &$w; $test })? { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Long-library timeout: {}", stringify!($test));
                }
            }};}
            // The driver samples the process tree at this point and answers.
            macro_rules! mark {($name:expr) => {{
                let name = $name.to_string();
                std::fs::write(out.join("marks").join(format!("{name}.ready")), format!("{}", epoch()))?;
                let ack = out.join("marks").join(format!("{name}.ack"));
                let deadline = Instant::now() + Duration::from_secs(30);
                while !ack.exists() {
                    cx.background_executor().timer(Duration::from_millis(10)).await;
                    anyhow::ensure!(Instant::now() < deadline, "Driver did not acknowledge mark {name}");
                }
            }};}
            // Open and wait for each observable step, as the open-steps hook does.
            macro_rules! open_timed {($dir:expr) => {{
                let expected: PathBuf = $dir.canonicalize()?;
                let started = Instant::now();
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(expected.clone(), cx)))?;
                let mut steps = serde_json::Map::new();
                loop {
                    let elapsed = started.elapsed();
                    let now = handle.update(cx, |_, w, cx| {
                        draw(w, cx);
                        let p = view.read(cx);
                        let identity = p.project.as_ref().is_some_and(|project| project.dir == expected);
                        let graph = p.last_playback_status.as_ref().is_some_and(|s| s.graph_generation > 0);
                        serde_json::json!({"identity": identity, "ready": identity && !p.loading, "duration": identity && p.duration > 0.,
                            "graph": identity && !p.loading && graph})
                    })?;
                    for (name, value) in now.as_object().unwrap() {
                        if value == true && !steps.contains_key(name) {
                            steps.insert(name.clone(), serde_json::json!(elapsed.as_secs_f64() * 1000.));
                        }
                    }
                    if ["identity", "ready", "duration", "graph"].iter().all(|name| steps.contains_key(*name)) { break; }
                    anyhow::ensure!(started.elapsed() < Duration::from_secs(40), "Open did not reach every step: {steps:?}");
                    cx.background_executor().timer(Duration::from_millis(5)).await;
                }
                serde_json::Value::Object(steps)
            }};}
            // Everything a singer waits for after the song is on screen.
            macro_rules! settle_open {() => {{
                wait!(p, w, cx => p.release_startup_ready && p.model_auto_checked, 25);
                if handle.update(cx, |_, _, cx| view.read(cx).whats_new.read(cx).is_open())? {
                    handle.update(cx, |_, _, cx| { let notes = view.read(cx).whats_new.clone(); notes.update(cx, |notes, cx| notes.close(cx)); })?;
                    wait!(p, w, cx => !p.whats_new.read(cx).is_open(), 5);
                }
                wait!(p, w, cx => p.analysis_progress.is_none() && !p.saving && !p.beat_auto_save, 25);
            }};}

            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                cx.background_executor().timer(Duration::from_millis(10)).await;
                let actual = handle.update(cx, |_, w, cx| { draw(w, cx); (f32::from(w.viewport_size().width), f32::from(w.viewport_size().height)) })?;
                if actual == (1280., 800.) { break; }
                anyhow::ensure!(Instant::now() < deadline, "Native viewport did not settle: {actual:?}");
            }

            match stage.as_str() {
                "songs" => {
                    for song in plan["songs"].as_array().ok_or_else(|| anyhow::anyhow!("plan.songs missing"))? {
                        let label = song["label"].as_str().unwrap().to_string();
                        let dir = PathBuf::from(song["dir"].as_str().unwrap());
                        let seconds = song["seconds"].as_f64().unwrap();
                        let burst_seconds = song["burstSeconds"].as_f64().unwrap_or(0.);
                        let mut record = serde_json::json!({"label": label, "fixtureSeconds": seconds});
                        let opened_at = Instant::now();
                        record["open"] = open_timed!(dir);
                        settle_open!();
                        // The waveform arrives from the helper after the open; time it.
                        let lanes = handle.update(cx, |_, _, cx| view.read(cx).project.as_ref().map(|p| p.lanes.len()).unwrap_or(0))?;
                        let waveform;
                        let peak_deadline = Instant::now() + Duration::from_secs(120);
                        loop {
                            cx.background_executor().timer(Duration::from_millis(20)).await;
                            handle.update(cx, |_, w, cx| draw(w, cx))?;
                            let report = waveform::peaks_report();
                            if report.as_array().is_some_and(|lanes_ready| lanes_ready.len() == lanes && lanes > 0) { waveform = report; break; }
                            anyhow::ensure!(Instant::now() < peak_deadline, "Waveform never arrived for {label}: {report}");
                        }
                        record["waveformReadyMs"] = serde_json::json!(opened_at.elapsed().as_secs_f64() * 1000.);
                        record["waveform"] = waveform;
                        let (duration, view_span) = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.duration, (p.view_start, p.view_end)) })?;
                        record["duration"] = serde_json::json!(duration);
                        record["viewAtOpen"] = serde_json::json!(view_span);
                        record["lanes"] = serde_json::json!(lanes);
                        mark!(format!("{label}-open"));

                        // Play from the start.
                        handle.update(cx, |_, w, cx| press(&view, w, cx, "transport-play"))??;
                        wait!(p, w, cx => p.playing && !p.transport_flight.counting_in && p.playhead.position() > 0.3
                            && p.last_playback_status.as_ref().is_some_and(|s| s.playing), 25);
                        cx.background_executor().timer(Duration::from_secs_f64(song["steadySeconds"].as_f64().unwrap_or(4.))).await;
                        record["afterPlay"] = handle.update(cx, |_, _, cx| { let p = view.read(cx); serde_json::json!({"position": p.playhead.position(), "starved": starved(p)}) })?;
                        mark!(format!("{label}-playing"));

                        // Seek near the end while playing; the position must follow in real time.
                        let target = duration - 12.;
                        handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.playhead.seek(target); p.seek_native(cx); }))?;
                        wait!(p, w, cx => p.playhead.pending_seek().is_none() && (p.playhead.position() - target).abs() < 0.5
                            && p.last_playback_status.as_ref().is_some_and(|s| s.playing && (s.position - target).abs() < 1.5), 30);
                        let seek_from = handle.update(cx, |_, _, cx| view.read(cx).playhead.position())?;
                        let seek_clock = Instant::now();
                        cx.background_executor().timer(Duration::from_secs(2)).await;
                        let (seek_to, seek_status) = handle.update(cx, |_, _, cx| {
                            let p = view.read(cx);
                            (p.playhead.position(), p.last_playback_status.as_ref().map(|s| s.position))
                        })?;
                        record["seekNearEnd"] = serde_json::json!({"target": target, "from": seek_from, "to": seek_to, "wallSeconds": seek_clock.elapsed().as_secs_f64(),
                            "nativePosition": seek_status, "starved": handle.update(cx, |_, _, cx| starved(view.read(cx)))?});

                        // A loop near the end, armed while playing and ahead of the playhead.
                        let (start, end) = (duration - 9., duration - 6.);
                        handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: Some((start, end)), looping: true }, cx)))?;
                        wait!(p, w, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_some_and(|(a, b)| (a - start).abs() < 0.002 && (b - end).abs() < 0.002)), 30);
                        let reported = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().and_then(|s| s.loop_range))?;
                        // Judge laps from the first lap onwards: the playhead may still be approaching the loop start.
                        wait!(p, w, cx => p.playhead.loop_count() >= 1 && p.playhead.position() >= start - 0.1, 30);
                        let first = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.playhead.position(), p.playhead.loop_count()) })?;
                        let mut judge = QuarterLoopJudge::new(start, end, first);
                        let (mut latest, loop_deadline) = (first, Instant::now() + Duration::from_secs(20));
                        let outcome = loop {
                            if latest.1 >= first.1 + 2 && judge.settled() { break Ok(()); }
                            cx.background_executor().timer(Duration::from_millis(10)).await;
                            latest = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.playhead.position(), p.playhead.loop_count()) })?;
                            if let Err(why) = judge.step(latest) { break Err(anyhow::anyhow!("{label}: loop near the end {why}")); }
                            if Instant::now() >= loop_deadline { break Err(anyhow::anyhow!("{label}: loop near the end did not wrap twice")); }
                        };
                        outcome?;
                        record["loopNearEnd"] = serde_json::json!({"start": start, "end": end, "reported": reported, "laps": latest.1 - first.1,
                            "starved": handle.update(cx, |_, _, cx| starved(view.read(cx)))?});
                        handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: None, looping: false }, cx)))?;
                        wait!(p, w, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_none()), 30);

                        // Zoomed onto the last seconds, a frame costs what it costs on a short song.
                        handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.view_start = (duration - 20.) / duration; p.view_end = 1.; cx.notify(); }))?;
                        let mut zoomed = vec![];
                        for _ in 0..30 { zoomed.push(handle.update(cx, |_, w, cx| frame(w, cx))?); }
                        record["zoomedEndFrameMs"] = summary(&zoomed);

                        // Optional full-rate pan, zoom and resize under playback (N11).
                        if burst_seconds > 0. {
                            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.view_start = 0.; p.view_end = 1.; p.playhead.seek(60.); p.seek_native(cx); }))?;
                            wait!(p, w, cx => p.playhead.pending_seek().is_none() && p.last_playback_status.as_ref().is_some_and(|s| s.playing), 30);
                            let (mut frames, burst_started, mut step) = (Vec::<f64>::new(), Instant::now(), 0u64);
                            while burst_started.elapsed().as_secs_f64() < burst_seconds {
                                step += 1;
                                let t = burst_started.elapsed().as_secs_f64();
                                let width = 0.002 + 0.2 * (0.5 + 0.5 * (t * 1.3).sin());
                                let start = (0.5 + 0.45 * (t * 0.7).sin()).clamp(0., 1. - width);
                                let ms = handle.update(cx, |_, w, cx| {
                                    view.update(cx, |p, cx| { p.view_start = start; p.view_end = start + width; cx.notify(); });
                                    if step % 40 == 0 {
                                        let narrow = (step / 40) % 2 == 0;
                                        w.resize(size(px(if narrow { 1060. } else { 1280. }), px(if narrow { 640. } else { 800. })));
                                    }
                                    frame(w, cx)
                                })?;
                                frames.push(ms);
                                cx.background_executor().timer(Duration::from_millis(4)).await;
                            }
                            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
                            record["burst"] = handle.update(cx, |_, _, cx| {
                                let p = view.read(cx);
                                serde_json::json!({"seconds": burst_seconds, "frames": summary(&frames), "starved": starved(p), "playing": p.playing,
                                    "position": p.playhead.position()})
                            })?;
                            mark!(format!("{label}-burst"));
                            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.view_start = 0.; p.view_end = 1.; cx.notify(); }))?;
                            // What the burst grew must settle once the singer stops: sample again after a rest.
                            for _ in 0..50 {
                                handle.update(cx, |_, w, cx| draw(w, cx))?;
                                cx.background_executor().timer(Duration::from_millis(100)).await;
                            }
                            mark!(format!("{label}-after-burst"));
                        }

                        // Play out to the end of the song.
                        handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.playhead.seek(duration - 2.); p.seek_native(cx); }))?;
                        wait!(p, w, cx => p.playhead.pending_seek().is_none() && (p.playhead.position() - (duration - 2.)).abs() < 0.5, 30);
                        wait!(p, w, cx => !p.playing && p.last_playback_status.as_ref().is_some_and(|s| !s.playing && s.transport_state == 4 && s.position >= s.duration - 0.2), 20);
                        record["playedOut"] = handle.update(cx, |_, _, cx| {
                            let p = view.read(cx);
                            serde_json::json!({"position": p.playhead.position(), "nativeDuration": p.last_playback_status.as_ref().map(|s| s.duration), "starved": starved(p)})
                        })?;
                        std::fs::write(out.join(format!("song-{label}.json")), serde_json::to_vec_pretty(&record)?)?;
                    }
                }
                "cycles" => {
                    let songs: Vec<PathBuf> = plan["songs"].as_array().unwrap().iter().map(|d| PathBuf::from(d.as_str().unwrap())).collect();
                    let count = plan["cycles"].as_u64().unwrap_or(20);
                    let mut opens = vec![];
                    for cycle in 0..count {
                        let dir = songs[cycle as usize % songs.len()].clone();
                        let steps = open_timed!(dir);
                        settle_open!();
                        if cycle == 0 {
                            // Start the audio path once so the cycles compare steady states.
                            handle.update(cx, |_, w, cx| press(&view, w, cx, "transport-play"))??;
                            wait!(p, w, cx => p.playing && !p.transport_flight.counting_in && p.last_playback_status.as_ref().is_some_and(|s| s.playing), 25);
                        }
                        // The singer rests on the song: slow frames, as a real window presents them.
                        for _ in 0..plan["restFrames"].as_u64().unwrap_or(7) {
                            cx.background_executor().timer(Duration::from_millis(100)).await;
                            handle.update(cx, |_, w, cx| draw(w, cx))?;
                        }
                        opens.push(serde_json::json!({"cycle": cycle, "dir": dir, "stepsMs": steps,
                            "playing": handle.update(cx, |_, _, cx| view.read(cx).playing)?, "waveformMetrics": waveform::metrics()}));
                        mark!(format!("cycle-{cycle:02}"));
                    }
                    std::fs::write(out.join("cycles.json"), serde_json::to_vec_pretty(&serde_json::json!({"opens": opens}))?)?;
                }
                "library" => {
                    let expected = plan["projects"].as_u64().unwrap() as usize;
                    let hook_started = Instant::now();
                    // The catalog request the app made at launch lands first; then a fresh one is timed.
                    wait!(p, w, cx => p.library.read(cx).long_state()["projects"].as_u64() == Some(expected as u64), 120);
                    let initial_ms = hook_started.elapsed().as_secs_f64() * 1000.;
                    let mut reloads = vec![];
                    for _ in 0..3 {
                        let before = library::catalog_deliveries();
                        let started = Instant::now();
                        handle.update(cx, |_, _, cx| view.update(cx, |p, _| { if let Some(backend) = &p.backend { backend.catalog(); } }))?;
                        // Every catalog event reaches Library::set_projects; its delivery counter is the receipt.
                        let landed = loop {
                            cx.background_executor().timer(Duration::from_millis(2)).await;
                            if library::catalog_deliveries() > before { break true; }
                            if started.elapsed() > Duration::from_secs(120) { break false; }
                        };
                        anyhow::ensure!(landed, "Catalog reload never landed");
                        reloads.push(started.elapsed().as_secs_f64() * 1000.);
                    }
                    handle.update(cx, |_, w, cx| draw(w, cx))?;
                    let mut state = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state())?;
                    anyhow::ensure!(state["projects"].as_u64() == Some(expected as u64), "Library shows {} of {expected}: {state}", state["projects"]);
                    let mut idle = vec![];
                    let idle_frames = plan["idleFrames"].as_u64().unwrap_or(30);
                    for _ in 0..idle_frames { idle.push(handle.update(cx, |_, w, cx| frame(w, cx))?); }
                    mark!("library-loaded");

                    // Scroll to the bottom and back with the wheel, one frame per step.
                    // The page scrolls, not the grid: the grid is as tall as its 200 cards.
                    let position = point(px(640.), px(500.));
                    handle.update(cx, |_, w, cx| { w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position, pressed_button: None, modifiers: Modifiers::default() }), cx); draw(w, cx); })?;
                    let mut scroll_frames = vec![];
                    let (mut reached_bottom, mut returned_top) = (false, false);
                    for step in 0..400 {
                        let down = !reached_bottom;
                        let ms = handle.update(cx, |_, w, cx| {
                            w.dispatch_event(PlatformInput::Scroll(ScrollEvent { position, delta: ScrollDelta::Pixels(point(px(0.), px(if down { -90. } else { 90. }))), ..Default::default() }), cx);
                            frame(w, cx)
                        })?;
                        scroll_frames.push(ms);
                        let now = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state()["page"].clone())?;
                        let (top, max) = (now["scrollTop"].as_f64().unwrap(), now["maxScroll"].as_f64().unwrap());
                        if down && max > 0. && (max - top).abs() < 0.5 { reached_bottom = true; }
                        if !down && top < 0.5 { returned_top = true; break; }
                        anyhow::ensure!(step < 399, "Scrolling never completed: {now}");
                        cx.background_executor().timer(Duration::from_millis(2)).await;
                    }
                    state = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state())?;
                    let grid_after = state["page"].clone();

                    // Type a search a character at a time; the last project's number matches exactly one card.
                    let query = plan["query"].as_str().unwrap().to_string();
                    let (match_title, match_dir) = (plan["matchTitle"].as_str().unwrap().to_string(), PathBuf::from(plan["matchDir"].as_str().unwrap()));
                    handle.update(cx, |_, w, cx| {
                        draw(w, cx);
                        let l = view.read(cx).library.clone();
                        l.update(cx, |l, cx| l.focus_search(w, cx));
                        draw(w, cx);
                    })?;
                    // Profiling aid: let a sampler attach before the first keystroke.
                    cx.background_executor().timer(Duration::from_millis(plan["typingDelayMs"].as_u64().unwrap_or(0))).await;
                    // Optional repeat of the first character (profiling aid): is its dispatch slow every time?
                    let mut repeats = vec![];
                    for _ in 0..plan["typingCycles"].as_u64().unwrap_or(0) {
                        let ms = handle.update(cx, |_, w, cx| {
                            let started = Instant::now();
                            w.dispatch_keystroke(Keystroke { key: "0".into(), key_char: Some("0".into()), ..Default::default() }, cx);
                            let dispatched = started.elapsed().as_secs_f64() * 1000.;
                            frame(w, cx);
                            w.dispatch_keystroke(Keystroke::parse("backspace").unwrap(), cx);
                            frame(w, cx);
                            dispatched
                        })?;
                        repeats.push(ms);
                        cx.background_executor().timer(Duration::from_millis(20)).await;
                    }
                    let mut typing = vec![];
                    let mut typing_split = vec![];
                    let mut after_each = vec![];
                    let mut typed = String::new();
                    for ch in query.chars() {
                        typed.push(ch);
                        // As the platform loop does: the key's turn ends (its effects, the library's query change
                        // among them, flush), then the frame draws. The time is key to the end of that frame.
                        let renders_before = library::renders();
                        let started = Instant::now();
                        handle.update(cx, |_, w, cx| { w.dispatch_keystroke(Keystroke { key: ch.to_string(), key_char: Some(ch.to_string()), ..Default::default() }, cx); })?;
                        let dispatched = started.elapsed().as_secs_f64() * 1000.;
                        // A dispatch can itself draw (the first character into an empty field does): then the key
                        // was on screen when it returned, and the frame below only repeats it.
                        let drawn_in_dispatch = library::last_rendered_query() == typed;
                        let renders_in_dispatch = library::renders() - renders_before;
                        handle.update(cx, |_, w, cx| { frame(w, cx); })?;
                        let total = if drawn_in_dispatch { dispatched } else { started.elapsed().as_secs_f64() * 1000. };
                        let shown = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state())?;
                        typing.push(total);
                        typing_split.push(serde_json::json!({"key": ch.to_string(), "dispatchMs": dispatched, "frameMs": total - dispatched, "totalMs": total, "drawnInDispatch": drawn_in_dispatch, "rendersInDispatch": renders_in_dispatch, "rendersTotal": library::renders() - renders_before,
                            "queryShown": shown["query"], "appliedInThatFrame": shown["query"] == typed.as_str()}));
                        after_each.push(shown["matches"].clone());
                        cx.background_executor().timer(Duration::from_millis(5)).await;
                    }
                    let searched = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state())?;
                    // Clearing restores every project.
                    let mut clearing = vec![];
                    let clear_started = Instant::now();
                    handle.update(cx, |_, w, cx| {
                        w.dispatch_keystroke(Keystroke::parse("cmd-a").unwrap(), cx);
                        w.dispatch_keystroke(Keystroke::parse("backspace").unwrap(), cx);
                    })?;
                    let clear_dispatched = clear_started.elapsed().as_secs_f64() * 1000.;
                    let drawn_in_clear = library::last_rendered_query().is_empty();
                    handle.update(cx, |_, w, cx| { frame(w, cx); })?;
                    clearing.push(if drawn_in_clear { clear_dispatched } else { clear_started.elapsed().as_secs_f64() * 1000. });
                    let cleared = handle.update(cx, |_, _, cx| view.read(cx).library.read(cx).long_state())?;

                    // Search for the project again and open it by clicking its card.
                    for ch in query.chars() {
                        handle.update(cx, |_, w, cx| { w.dispatch_keystroke(Keystroke { key: ch.to_string(), key_char: Some(ch.to_string()), ..Default::default() }, cx); draw(w, cx); })?;
                    }
                    handle.update(cx, |_, w, cx| draw(w, cx))?;
                    let card = handle.update(cx, |_, w, cx| {
                        draw(w, cx);
                        view.read(cx).library.read(cx).project_open_bounds(&match_dir.canonicalize().unwrap_or(match_dir.clone()))
                            .or_else(|| view.read(cx).library.read(cx).project_open_bounds(&match_dir))
                    })?;
                    let card = card.ok_or_else(|| anyhow::anyhow!("The searched project's card was never measured"))?;
                    let expected_dir = match_dir.canonicalize()?;
                    let opened_started = Instant::now();
                    handle.update(cx, |_, w, cx| click(w, cx, card.center()))?;
                    let mut steps = serde_json::Map::new();
                    loop {
                        let elapsed = opened_started.elapsed();
                        let now = handle.update(cx, |_, w, cx| {
                            draw(w, cx);
                            let p = view.read(cx);
                            let identity = p.project.as_ref().is_some_and(|project| project.dir == expected_dir);
                            let graph = p.last_playback_status.as_ref().is_some_and(|s| s.graph_generation > 0);
                            serde_json::json!({"identity": identity, "ready": identity && !p.loading, "graph": identity && !p.loading && graph})
                        })?;
                        for (name, value) in now.as_object().unwrap() {
                            if value == true && !steps.contains_key(name) { steps.insert(name.clone(), serde_json::json!(elapsed.as_secs_f64() * 1000.)); }
                        }
                        if ["identity", "ready", "graph"].iter().all(|name| steps.contains_key(*name)) { break; }
                        anyhow::ensure!(opened_started.elapsed() < Duration::from_secs(40), "Card click did not open the project: {steps:?}");
                        cx.background_executor().timer(Duration::from_millis(5)).await;
                    }
                    settle_open!();
                    std::fs::write(out.join("library.json"), serde_json::to_vec_pretty(&serde_json::json!({
                        "expectedProjects": expected, "initialLoadFromHookMs": initial_ms, "reloadMs": reloads, "idleFrameMs": summary(&idle),
                        "scroll": {"frameMs": summary(&scroll_frames), "reachedBottom": reached_bottom, "returnedTop": returned_top, "after": grid_after},
                        "search": {"query": query, "typingMs": summary(&typing), "typingSplit": typing_split, "repeatedFirstKeyDispatchMs": repeats, "matchesAfterEachKey": after_each, "result": searched, "clearMs": summary(&clearing), "cleared": cleared,
                            "expectedTitle": match_title},
                        "open": {"stepsMs": steps, "dir": expected_dir},
                    }))?)?;
                }
                other => anyhow::bail!("Unknown SINGZ_GPUI_LONG_STAGE {other:?}"),
            }
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"stage": stage, "hidden": true, "muted": true}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_LONG_LIBRARY failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

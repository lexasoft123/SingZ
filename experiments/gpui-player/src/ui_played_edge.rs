//! Hidden played-edge check: the lanes' bright "played" layer must end on the
//! playhead line (Q-05). Native twin of `played-edge-e2e.cjs`.
//!
//! Judged from pixels, not from the geometry the painters compute. Two reference
//! renders of the same zoomed view bound each column: one with the position at the start of
//! the view (nothing played, playhead on the first column) and one at its end (everything
//! played, playhead on the last column). A frame at a real position is then classified column
//! by column as played or unplayed. The playhead's glow covers `GLOW` columns each
//! side of the line and hides the step itself, so the claim is: every informative
//! column left of the glow is played and every one right of it is unplayed. A played
//! layer that trails the line (a stale or throttled clock) leaves unplayed columns
//! left of the glow and fails. The one-device-pixel floor/round residual between
//! the clip and the line is below this resolution and is not covered.
use super::ui_training_run::draw;
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

/// Device columns hidden by the playhead glow on each side of the line.
const GLOW: f64 = 26.;
/// Minimum summed channel difference for a column to say anything about played/unplayed.
const INFORMATIVE: u64 = 400;

struct Frame {
    width: u32,
    height: u32,
    raw: Vec<u8>,
}
fn grab(w: &mut Window) -> anyhow::Result<Frame> {
    let image = w.render_to_image()?;
    Ok(Frame { width: image.width(), height: image.height(), raw: image.as_raw().clone() })
}
fn column_gap(a: &Frame, b: &Frame, x: u32, y0: u32, y1: u32) -> u64 {
    let mut sum = 0u64;
    for y in y0..y1.min(a.height) {
        let i = ((y * a.width + x) * 4) as usize;
        for c in 0..3 {
            sum += (a.raw[i + c] as i32 - b.raw[i + c] as i32).unsigned_abs() as u64;
        }
    }
    sum
}
/// Position the view without touching playback: the same call path the zoom controls use.
fn set_view(view: &Entity<Player>, cx: &mut App, start: f64, end: f64) {
    view.update(cx, |p, cx| {
        p.view_start = (start / p.duration).clamp(0., 0.999);
        p.view_end = (end / p.duration).clamp(p.view_start + 0.001, 1.);
        cx.notify();
    });
}
fn paint_at(view: &Entity<Player>, w: &mut Window, cx: &mut App, seconds: f64) -> anyhow::Result<Frame> {
    view.update(cx, |p, cx| { p.playhead.seek(seconds); cx.notify(); });
    draw(w, cx);
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Played-edge test activated its window");
    grab(w)
}
/// Where the playhead sits in device columns and which rows the lane stack covers.
fn geometry(view: &Entity<Player>, w: &Window, cx: &App) -> anyhow::Result<(f64, u32, u32, f64)> {
    let p = view.read(cx);
    let bounds = p.region.bounds.get().ok_or_else(|| anyhow::anyhow!("Lane stack bounds not measured"))?;
    let scale = w.scale_factor() as f64;
    let fraction = (p.playhead.position() / p.duration - p.view_start) / (p.view_end - p.view_start);
    let head = (f32::from(bounds.left()) as f64 + fraction * f32::from(bounds.size.width) as f64) * scale;
    Ok((head, (f32::from(bounds.top()) as f64 * scale) as u32, (f32::from(bounds.bottom()) as f64 * scale) as u32, scale))
}
struct Analysis {
    json: serde_json::Value,
}
fn analyse(frame: &Frame, base: &Frame, full: &Frame, head: f64, y0: u32, y1: u32, left: u32, right: u32) -> Analysis {
    let (mut left_n, mut left_bad, mut right_n, mut right_bad, mut zone_n) = (0u32, 0u32, 0u32, 0u32, 0u32);
    let mut first_bad_left = None;
    let mut last_bad_right = None;
    // The references have the playhead on the first and last column; leave those glows out.
    for x in (left + GLOW as u32)..(right.min(frame.width) - GLOW as u32) {
        if column_gap(base, full, x, y0, y1) < INFORMATIVE { continue; }
        let to_base = column_gap(frame, base, x, y0, y1);
        let to_full = column_gap(frame, full, x, y0, y1);
        let played = to_full * 2 <= to_base;
        let unplayed = to_base * 2 <= to_full;
        let column = x as f64;
        if column < head - GLOW {
            left_n += 1;
            if !played { left_bad += 1; first_bad_left.get_or_insert(x); }
        } else if column > head + GLOW {
            right_n += 1;
            if !unplayed { right_bad += 1; last_bad_right = Some(x); }
        } else {
            zone_n += 1;
        }
    }
    Analysis { json: serde_json::json!({
        "headDeviceColumn": head, "glowColumns": GLOW,
        "informativeLeft": left_n, "unplayedLeft": left_bad, "firstUnplayedLeft": first_bad_left,
        "informativeRight": right_n, "playedRight": right_bad, "lastPlayedRight": last_bad_right,
        "informativeInGlow": zone_n,
    }) }
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_PLAYED_EDGE_PROJECT").ok_or_else(|| anyhow::anyhow!("Missing project"))?).canonicalize()?;
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1"), "Played-edge test must be muted");
            macro_rules! wait {($label:expr, $predicate:expr)=>{{
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready = handle.update(cx, |_, w, cx| { draw(w, cx); ($predicate)(view.read(cx)) })?;
                    if ready { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Played-edge step timed out: {}", $label);
                }
            }};}
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(project.clone(), cx)))?;
            wait!("open", |p: &Player| !p.loading && p.project.as_ref().is_some_and(|v| v.dir == project) && p.last_playback_status.is_some());
            super::ui_training_run::settle_whats_new(handle, &view, cx).await?;
            let duration = handle.update(cx, |_, _, cx| view.read(cx).duration)?;
            anyhow::ensure!(duration > 40., "Fixture song is too short for the zoomed view: {duration}");
            let (start, span) = (10., 8.);

            // Reference renders of the zoomed view: nothing played, everything played.
            // The lanes fade in after an open; frames taken mid-fade differ between renders.
            cx.background_executor().timer(Duration::from_millis(3000)).await;
            handle.update(cx, |_, w, cx| { draw(w, cx); })?;
            handle.update(cx, |_, _, cx| set_view(&view, cx, start, start + span))?;
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            let (base, full) = handle.update(cx, |_, w, cx| -> anyhow::Result<(Frame, Frame)> {
                let base = paint_at(&view, w, cx, start)?;
                let full = paint_at(&view, w, cx, start + span)?;
                let p = view.read(cx);
                anyhow::ensure!((p.view_start * p.duration - start).abs() < 1e-6 && (p.view_end * p.duration - (start + span)).abs() < 1e-6, "The view moved while taking the reference frames");
                Ok((base, full))
            })??;
            let (left_col, right_col) = handle.update(cx, |_, w, cx| {
                let bounds = view.read(cx).region.bounds.get().unwrap();
                let scale = w.scale_factor();
                (f32::from(bounds.left() * scale) as u32, f32::from(bounds.right() * scale) as u32)
            })?;
            let mut paused = Vec::new();
            // Offsets that are not multiples of a quarter second: a position rounded to a
            // coarse clock lands far from the line on all of them.
            for offset in [2.07, 2.88, 3.46, 4.19, 4.62, 5.43] {
                let verdict = handle.update(cx, |_, w, cx| -> anyhow::Result<serde_json::Value> {
                    let frame = paint_at(&view, w, cx, start + offset)?;
                    let (head, y0, y1, _scale) = geometry(&view, w, cx)?;
                    let mut analysis = analyse(&frame, &base, &full, head, y0, y1, left_col, right_col).json;
                    analysis["offsetSeconds"] = offset.into();
                    analysis["viewSeconds"] = serde_json::json!([start, start + span]);
                    analysis["image"] = serde_json::json!([frame.width, frame.height]);
                    Ok(analysis)
                })??;
                paused.push(verdict);
            }
            handle.update(cx, |_, w, cx| { let _ = w.render_to_image().map(|i| i.save(out.join("paused-last.png"))); draw(w, cx); })?;

            // Playing: real playback inside the same view, frames judged as they come.
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.playhead.seek(start + 3.0); p.seek_native(cx); }))?;
            wait!("seek", |p: &Player| p.playhead.pending_seek().is_none());
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.native_transport(transport::TransportEvent::Play, cx)))?;
            wait!("playing", |p: &Player| p.playing && p.transport_flight.native_play.is_none() && p.last_playback_status.as_ref().is_some_and(|s| s.playing));
            let mut playing = Vec::new();
            for index in 0..12 {
                cx.background_executor().timer(Duration::from_millis(70)).await;
                let verdict = handle.update(cx, |_, w, cx| -> anyhow::Result<serde_json::Value> {
                    // The same code path as the app's own frame: no position is set for the frame itself.
                    view.update(cx, |p, cx| p.poll_backend(cx));
                    draw(w, cx);
                    let frame = grab(w)?;
                    let (head, y0, y1, _scale) = geometry(&view, w, cx)?;
                    // While playing the painters take the position from the playback clock, so no
                    // reference can be rendered now; the paused references of this same view are
                    // used, and a frame whose view has moved is skipped, not judged.
                    let (view_start, view_end, position) = { let p = view.read(cx); (p.view_start * p.duration, p.view_end * p.duration, p.playhead.position()) };
                    if (view_start - start).abs() > 1e-6 || (view_end - (start + span)).abs() > 1e-6 {
                        return Ok(serde_json::json!({"frame": index, "skipped": "view moved", "position": position, "viewSeconds": [view_start, view_end]}));
                    }
                    let mut analysis = analyse(&frame, &base, &full, head, y0, y1, left_col, right_col).json;
                    analysis["frame"] = index.into();
                    analysis["position"] = position.into();
                    analysis["viewSeconds"] = serde_json::json!([view_start, view_end]);
                    Ok(analysis)
                })??;
                playing.push(verdict);
            }
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.native_transport(transport::TransportEvent::Play, cx)))?;
            std::fs::write(out.join("edge.json"), serde_json::to_vec_pretty(&serde_json::json!({"paused": paused, "playing": playing, "glowColumns": GLOW, "informativeThreshold": INFORMATIVE, "resolution": "glow-limited; one-device-pixel floor/round residual is below it"}))?)?;
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"done": true}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_PLAYED_EDGE failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

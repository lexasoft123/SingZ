//! Hidden Space ownership after real pointer clicks (Q-05).
//!
//! Native twin of `space-focus-e2e.cjs`. Every control below is reached with a
//! real mouse click, never with Tab and never by calling a handler, because the
//! question is where focus lands after a singer's click:
//!   1. click a lane's Mute, then Space twice: the song starts and stops and Mute
//!      stays as the click left it, and Mute does not keep focus;
//!   2. click a stem fader, then Right and Space: Right moves the fader and does
//!      not seek, Space plays and pauses without touching the fader;
//!   3. click into the BPM field, then Space: a field being typed into owns the key.
//! A click that leaves focus somewhere the leg needs is recorded as inconclusive
//! rather than passed.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::PathBuf, time::Duration};

fn key(w: &mut Window, cx: &mut App, name: &'static str) {
    let stroke = Keystroke::parse(name).unwrap();
    w.dispatch_keystroke(stroke.clone(), cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: stroke }), cx);
}
fn state(p: &Player, w: &Window, cx: &App) -> serde_json::Value {
    serde_json::json!({
        "playing": p.playing, "position": p.position, "seekCount": p.native_seek_count, "epoch": p.native_epoch,
        "muted": p.muted[0], "solo": p.solo[0], "gain": p.gain[0],
        "muteFocused": p.track_mix_focus[0][0].is_focused(w), "soloFocused": p.track_mix_focus[0][1].is_focused(w),
        "gainFocused": p.track_gain_focus[0].is_focused(w), "bpmFocused": p.transport.read(cx).bpm_focused(w, cx),
        "rootFocused": p.focus_handle.is_focused(w), "playIntent": p.native_play_intent.is_some(),
        "native": p.last_playback_status.as_ref().map(|s| serde_json::json!({"playing": s.playing, "position": s.position})),
        "notice": p.notice, "hidden": !w.is_visible() && !w.is_window_active(),
    })
}
fn click_lane_control(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str, fraction: Option<f32>) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view.read(cx).track_bounds.borrow().get(id).copied().ok_or_else(|| anyhow::anyhow!("Lane control not measured: {id}"))?;
    anyhow::ensure!(b.top() >= px(0.) && b.bottom() <= w.viewport_size().height && b.left() >= px(0.) && b.right() <= w.viewport_size().width, "Lane control {id} outside the viewport: {b:?}");
    let at = match fraction {
        Some(value) => point(b.left() + px(5.5) + (b.size.width - px(11.)) * value, b.center().y),
        None => b.center(),
    };
    click(w, cx, at);
    Ok(())
}
fn click_bpm(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view.read(cx).transport.read(cx).bounds("transport-bpm").ok_or_else(|| anyhow::anyhow!("BPM field not measured"))?;
    click(w, cx, b.center());
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_SPACE_FOCUS_PROJECT").ok_or_else(|| anyhow::anyhow!("Missing project"))?).canonicalize()?;
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1"), "Space-focus test must be muted");
            macro_rules! wait {($label:expr, $predicate:expr)=>{{
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready = handle.update(cx, |_, w, cx| { draw(w, cx); ($predicate)(view.read(cx)) })?;
                    if ready { break; }
                    if Instant::now() >= deadline {
                        let evidence = handle.update(cx, |_, w, cx| state(view.read(cx), w, cx))?;
                        anyhow::bail!("Space-focus step timed out: {} {evidence}", $label);
                    }
                }
            }};}
            macro_rules! snap {($label:expr)=>{handle.update(cx, |_, w, cx| { draw(w, cx); let mut s = state(view.read(cx), w, cx); s["label"] = $label.into(); s })?};}
            let mut legs = Vec::new();
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(project.clone(), cx)))?;
            wait!("open", |p: &Player| !p.loading && p.project.as_ref().is_some_and(|v| v.dir == project) && p.last_playback_status.is_some() && p.notice.is_none());
            // Nothing may be playing or focused by luck before the legs begin.
            anyhow::ensure!(!handle.update(cx, |_, _, cx| view.read(cx).playing)?, "The song is already playing after the open");

            // ---- 1. Mute, then Space ----------------------------------------
            handle.update(cx, |_, w, cx| click_lane_control(&view, w, cx, "mute-0", None))??;
            wait!("mute click", |p: &Player| p.muted[0]);
            let after_click = snap!("mute-clicked");
            let mute_focus = after_click["muteFocused"] == true;
            legs.push(after_click.clone());
            for want_playing in [true, false] {
                handle.update(cx, |_, w, cx| key(w, cx, "space"))?;
                wait!("space toggled", |p: &Player| p.playing == want_playing && p.native_play_intent.is_none() && p.last_playback_status.as_ref().is_some_and(|s| s.playing == want_playing));
                legs.push(snap!(if want_playing { "mute-space-start" } else { "mute-space-stop" }));
            }
            handle.update(cx, |_, w, cx| click_lane_control(&view, w, cx, "mute-0", None))??;
            wait!("mute restored", |p: &Player| !p.muted[0]);

            // ---- 2. a fader keeps its arrows and gives up Space --------------
            handle.update(cx, |_, w, cx| click_lane_control(&view, w, cx, "gain-0", Some(0.5)))??;
            let fader = snap!("fader-clicked");
            legs.push(fader.clone());
            handle.update(cx, |_, w, cx| key(w, cx, "right"))?;
            cx.background_executor().timer(Duration::from_millis(300)).await;
            legs.push(snap!("fader-right"));
            for want_playing in [true, false] {
                handle.update(cx, |_, w, cx| key(w, cx, "space"))?;
                wait!("space toggled (fader)", |p: &Player| p.playing == want_playing && p.native_play_intent.is_none() && p.last_playback_status.as_ref().is_some_and(|s| s.playing == want_playing));
                legs.push(snap!(if want_playing { "fader-space-start" } else { "fader-space-stop" }));
            }

            // ---- 3. a text field owns Space -----------------------------------
            handle.update(cx, |_, w, cx| click_bpm(&view, w, cx))??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            legs.push(snap!("bpm-clicked"));
            handle.update(cx, |_, w, cx| key(w, cx, "space"))?;
            cx.background_executor().timer(Duration::from_millis(1500)).await;
            legs.push(snap!("bpm-space"));
            handle.update(cx, |_, w, cx| key(w, cx, "escape"))?;

            std::fs::write(out.join("legs.json"), serde_json::to_vec_pretty(&legs)?)?;
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"done": true, "muteHeldFocusAfterClick": mute_focus}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_SPACE_FOCUS failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

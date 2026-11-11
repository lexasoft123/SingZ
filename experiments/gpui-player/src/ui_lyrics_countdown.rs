//! Actual hidden native playback through intro and later lyric gaps.
use super::*;
use std::{collections::BTreeSet, path::PathBuf, sync::mpsc, time::Duration};

fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    super::ui_training_run::draw(w, cx);
    let t = view.read(cx).transport.read(cx);
    let bounds = if id == "karaoke" {
        t.guides.get(id)
    } else {
        t.bounds(id)
    }
    .ok_or_else(|| anyhow::anyhow!("Countdown control was not drawn: {id}"))?;
    anyhow::ensure!(
        bounds.bottom() <= w.viewport_size().height,
        "Countdown control outside viewport: {id}"
    );
    super::ui_training_run::click(w, cx, bounds.center());
    Ok(())
}
fn state(p: &Player, w: &Window) -> serde_json::Value {
    let mut value = p.lyric_countdown_review_state();
    value["viewport"] = serde_json::json!([
        f32::from(w.viewport_size().width),
        f32::from(w.viewport_size().height)
    ]);
    value["scale"] = w.scale_factor().into();
    value["hidden"] = (!w.is_visible() && !w.is_window_active()).into();
    value["liveFps"] = "unmeasured".into();
    value["productionParity"] = "source policy; matched visual reference pending".into();
    value
}
pub fn run(
    handle: AnyWindowHandle,
    view: Entity<Player>,
    project: PathBuf,
    out: PathBuf,
    cx: &mut App,
) -> mpsc::Receiver<Result<(), String>> {
    let (send, receive) = mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Countdown check must be hidden and muted");
            let project=project.canonicalize()?;
            let (original_karaoke,first_start,second_start,epoch)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{
                let p=view.read(cx);let lines=&p.lyric_document.lines;
                anyhow::ensure!(p.screen==Screen::Player&&!p.playing&&p.playhead.position().abs()<0.03&&p.project.as_ref().is_some_and(|s|s.dir==project)
                    &&lines.len()==2&&lines[0].start>5.&&lines[0].end<lines[1].start
                    &&(3. ..=5.).contains(&(lines[1].start-lines[0].end)),"Countdown requires the private two-gap fixture");
                Ok((p.karaoke,lines[0].start,lines[1].start,p.native_epoch))
            })??;
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{
                        super::ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none()&&$p.native_epoch==epoch,"Countdown changed window/epoch or raised a notice: {:?}",$p.notice);
                        Ok($condition)
                    })??;
                    if ready {break;}
                    if Instant::now()>=deadline {let evidence=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
                        anyhow::bail!("Countdown timeout: {}: {evidence}",stringify!($condition));}
                }
            }};}
            macro_rules! capture {($stem:expr,$kind:expr)=>{{
                for (width,height) in [(1280.,800.),(1060.,640.)] {
                    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                    wait!(p,w,app => w.viewport_size()==size(px(width),px(height))&&p.lyric_countdown_review_state()["cue"]["kind"]==$kind&&p.lyric_countdown_review_state()["spriteReady"]==true);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        super::ui_training_run::draw(w,cx);let value=state(view.read(cx),w);
                        anyhow::ensure!(value["cue"]["kind"]==$kind&&value["spriteReady"]==true,"Countdown capture lost its accepted cue");
                        let name=format!("{}-{}",$stem,width as u32);
                        w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                        std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
                    })??;
                }
            }};}
            if !original_karaoke {handle.update(cx,|_,w,cx|press(&view,w,cx,"karaoke"))??;}
            wait!(p,w,app => p.karaoke&&p.lyric_countdown_review_state()["cue"].is_null());
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => p.playing&&p.lyric_countdown_review_state()["cue"]["kind"]=="seconds"&&p.lyric_countdown_review_state()["spriteReady"]==true);
            capture!("lyric-count-seconds","seconds");
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)&&p.lyric_countdown_review_state()["cue"].is_null());
            let paused=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
            for _ in 0..8 {
                cx.background_executor().timer(Duration::from_millis(50)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{super::ui_training_run::draw(w,cx);let value=state(view.read(cx),w);
                    anyhow::ensure!(!view.read(cx).playing&&value["cue"].is_null()&&value["bounds"].is_null()
                        &&(value["position"].as_f64().unwrap()-paused["position"].as_f64().unwrap()).abs()<0.03,"Paused countdown remained active or playback advanced");Ok(())})??;
            }
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
            wait!(p,w,app => p.lyric_countdown_review_state()["cue"]["kind"]=="dots"&&p.lyric_countdown_review_state()["spriteReady"]==true);
            capture!("lyric-count-dots","dots");
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)&&p.lyric_countdown_review_state()["cue"].is_null());
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-restart"))??;
            wait!(p,w,app => p.playhead.pending_seek().is_none()&&p.playhead.position().abs()<0.03);
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
            // Resize and GPU readback can span a complete one-second cue. Run
            // a separate uninterrupted heard-clock pass for sequence evidence.
            let mut intro=BTreeSet::new();let mut later=BTreeSet::new();let mut trace=Vec::new();let mut clear_while_singing=false;
            let deadline=Instant::now()+Duration::from_secs(20);
            loop {
                cx.background_executor().timer(Duration::from_millis(80)).await;
                let value=handle.update(cx,|_,w,cx|->anyhow::Result<_>{super::ui_training_run::draw(w,cx);let p=view.read(cx);
                    anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none()&&p.playing&&p.native_epoch==epoch,"Countdown trace lost hidden native playback");Ok(state(p,w))})??;
                let position=value["position"].as_f64().unwrap() as f32;
                if value["cue"]["kind"]=="dots" {
                    let count=value["cue"]["count"].as_u64().unwrap();
                    match value["cue"]["line"].as_u64() {Some(0)=>{intro.insert(count);},Some(1)=>{later.insert(count);},_=>{}}
                }
                if position>=first_start+0.1&&position<=first_start+0.5&&value["cue"].is_null(){clear_while_singing=true;}
                trace.push(value);
                if position>=second_start+0.05 {break;}
                anyhow::ensure!(Instant::now()<deadline,"Countdown native playback did not reach the next line");
            }
            anyhow::ensure!(intro==BTreeSet::from([1,2,3])&&later==BTreeSet::from([1,2,3])&&clear_while_singing,
                "Countdown sequence incomplete: intro={intro:?}, later={later:?}, clearWhileSinging={clear_while_singing}");
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)&&p.lyric_countdown_review_state()["cue"].is_null());
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-restart"))??;
            wait!(p,w,app => p.playhead.pending_seek().is_none()&&p.playhead.position().abs()<0.03);
            if !original_karaoke {handle.update(cx,|_,w,cx|press(&view,w,cx,"karaoke"))??;}
            wait!(p,w,app => p.karaoke==original_karaoke&&p.lyric_countdown_review_state()["cue"].is_null());
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            std::fs::write(out.join("countdown.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualKaraokePlayPauseControls":true,"initialLongGapSeconds":true,"introThreeTwoOne":true,"laterGapThreeTwoOne":true,
                "pausedCueRemoved":true,"singingCueClear":true,"cachedSpriteRendered":true,"restoredBaseline":true,
                "paused":paused,"trace":trace,"sizes":[[1280,800],[1060,640]],"liveFps":"unmeasured",
                "scope":"actual native heard clock and controls; cached source cue; glyph paint unchanged; matched production pixels pending"
            }))?)?;Ok(())
        }.await;
        let _=send.send(result.map_err(|error|format!("{error:#}")));
    }).detach();
    receive
}

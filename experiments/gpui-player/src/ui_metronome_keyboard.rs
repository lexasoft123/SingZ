//! Hidden real-input coverage of the source's nonmodal metronome popup.
use super::*;
use std::{path::PathBuf, sync::mpsc, time::Duration};

fn key(w: &mut Window, cx: &mut App, text: &'static str) {
    let stroke=Keystroke::parse(text).unwrap();
    w.dispatch_keystroke(stroke.clone(),cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn press(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    ui_training_run::draw(w,cx);
    let p=view.read(cx);
    let b=if id=="metronome" {p.transport.read(cx).guides.get(id)}
        else {p.metronome_ui.read(cx).bounds.borrow().get(id).copied()}
        .ok_or_else(||anyhow::anyhow!("Metronome control missing: {id}"))?;
    anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=w.viewport_size().height,"Metronome control clipped: {id}");
    ui_training_run::click(w,cx,b.center());Ok(())
}
fn tab_to(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..128 {
        ui_training_run::draw(w,cx);
        if view.read(cx).metronome_ui.read(cx).focused_control(w,cx).as_deref()==Some(id){return Ok(());}
        key(w,cx,"tab");
    }
    anyhow::bail!("Tab did not reach metronome control {id}")
}
fn volume(view:&Entity<Player>,w:&mut Window,cx:&mut App,value:f64)->anyhow::Result<()> {
    ui_training_run::draw(w,cx);
    let b=view.read(cx).metronome_ui.read(cx).bounds.borrow().get("met-volume").copied()
        .ok_or_else(||anyhow::anyhow!("Metronome range not drawn"))?;
    ui_training_run::click(w,cx,point(b.left()+px(5.5)+(b.size.width-px(11.))*value as f32,b.center().y));Ok(())
}
fn state(p:&Player,w:&Window,cx:&App)->serde_json::Value {
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"metronome":p.metronome,
        "pending":p.metronome_pending,"open":p.metronome_open,"playing":p.playing,"position":p.position,
        "masterVolume":p.master_volume,"output":p.transport.read(cx).output_state(),
        "focused":p.metronome_ui.read(cx).focused_control(w,cx),"seekCount":p.native_seek_count,
        "scope":"real popup keyboard and accepted native transactions; no nonzero audio measurement","liveFps":"unmeasured"})
}
pub fn run(handle:AnyWindowHandle,view:Entity<Player>,project:PathBuf,out:PathBuf,cx:&mut App)->mpsc::Receiver<Result<(),String>> {
    let (tx,rx)=mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Metronome journey requires hidden/muted execution");
            let project=project.canonicalize()?;
            let original=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);
                anyhow::ensure!(p.screen==Screen::Player&&!p.playing&&p.position.abs()<0.03&&!p.metronome_open
                    &&p.project.as_ref().is_some_and(|s|s.dir==project),"Metronome keyboard baseline changed");Ok(p.metronome.clone())})??;
            let mut cases=vec![];
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop {cx.background_executor().timer(Duration::from_millis(25)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Metronome test changed hidden state or raised {:?}",$p.notice);
                        Ok($condition)})?? {break;}
                    if Instant::now()>=deadline {let value=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx))?;anyhow::bail!("Metronome keyboard timeout {}: {value}",stringify!($condition));}
                }
            }};}
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|press(&view,w,cx,"metronome"))??;
                wait!(p,w,app => p.metronome_open);
                let grid_before=handle.update(cx,|_,_,cx|view.read(cx).beats.clone())?;
                // A native popup entity survives dismissal, unlike the source
                // component. Exercise reopening before its idle timeout so a
                // stale tap history cannot accidentally pass this regression.
                handle.update(cx,|_,w,cx|press(&view,w,cx,"met-tap"))??;
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let old_tap=Instant::now();
                handle.update(cx,|_,w,cx|press(&view,w,cx,"met-tap"))??;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);
                    anyhow::ensure!(p.metronome_ui.read(cx).tap_count()==2&&p.beats==grid_before&&p.metronome_pending.is_none(),"Two initial taps unexpectedly edited the grid");
                    key(w,cx,"escape");Ok(())})??;
                wait!(p,w,app => !p.metronome_open);
                handle.update(cx,|_,w,cx|press(&view,w,cx,"metronome"))??;
                wait!(p,w,app => p.metronome_open&&p.metronome_ui.read(app).tap_count()==0);
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{if grid_before.is_none(){
                    anyhow::ensure!(view.read(cx).metronome_ui.read(cx).caption()!=crate::i18n::t("player.metronome.tapHint"),"Reopen retained the old tap hint");}Ok(())})??;
                for count in 1..=2 {
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    handle.update(cx,|_,w,cx|press(&view,w,cx,"met-tap"))??;
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let popup=p.metronome_ui.read(cx);
                        anyhow::ensure!(old_tap.elapsed()<Duration::from_millis(2500),"Tap reopen regression exceeded idle timeout and is unqualified");
                        anyhow::ensure!(popup.tap_count()==count&&p.beats==grid_before&&p.metronome_pending.is_none(),"Reopen reused taps from the dismissed popup");
                        if grid_before.is_none(){anyhow::ensure!(popup.caption()==crate::i18n::t("player.metronome.tapHint"),"Fresh tap hint is missing");}
                        Ok(())})??;
                }
                let serial=handle.update(cx,|_,_,cx|view.read(cx).metronome_serial)?;
                cx.background_executor().timer(Duration::from_millis(150)).await;
                handle.update(cx,|_,w,cx|press(&view,w,cx,"met-tap"))??;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome_serial>serial
                    &&p.metronome_ui.read(app).tap_count()==3&&p.beats.as_ref().is_some_and(|g|g.source=="manual"&&g.bpm.is_finite()&&(30. ..=300.).contains(&g.bpm)));
                // The trigger reports click/grid state, as in Transport.tsx.
                for id in ["met-click-0","met-count-0","met-grid-1"] {
                    handle.update(cx,|_,w,cx|press(&view,w,cx,id))??;
                    wait!(p,w,app => p.metronome_pending.is_none());
                }
                wait!(p,w,app => !p.metronome.click&&p.metronome.count_in_bars==0&&p.metronome.grid&&p.transport.read(app).met_enabled);
                for id in ["met-grid-0","met-count-1"] {
                    handle.update(cx,|_,w,cx|press(&view,w,cx,id))??;
                    wait!(p,w,app => p.metronome_pending.is_none());
                }
                wait!(p,w,app => !p.metronome.click&&!p.metronome.grid&&p.metronome.count_in_bars==1&&!p.transport.read(app).met_enabled);
                let restore=[if original.click{"met-click-1"}else{"met-click-0"},
                    if original.grid{"met-grid-1"}else{"met-grid-0"},
                    match original.count_in_bars{0=>"met-count-0",1=>"met-count-1",_=>"met-count-2"}];
                for id in restore {
                    handle.update(cx,|_,w,cx|press(&view,w,cx,id))??;
                    wait!(p,w,app => p.metronome_pending.is_none());
                }
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.as_ref().is_some_and(|s|s.dir==project)
                    &&!p.playing&&p.position.abs()<0.03&&p.metronome==original&&p.beats==grid_before);
                handle.update(cx,|_,w,cx|press(&view,w,cx,"metronome"))??;
                wait!(p,w,app => p.metronome_open&&p.metronome_ui.read(app).tap_count()==0);
                let seek_before=handle.update(cx,|_,_,cx|view.read(cx).native_seek_count)?;
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-bpm"))??;
                handle.update(cx,|_,w,cx|{key(w,cx,if cfg!(target_os="macos"){"cmd-a"}else{"ctrl-a"});for text in ["1","2","3"]{key(w,cx,text);}})?;
                wait!(p,w,app => p.metronome_ui.read(app).input().read(app).value().as_str()=="123"&&!p.playing&&p.native_seek_count==seek_before);
                handle.update(cx,|_,w,cx|{key(w,cx,"space");key(w,cx,"left");key(w,cx,"right");})?;
                wait!(p,w,app => p.metronome_ui.read(app).input().read(app).value().as_str()=="123"&&!p.playing&&p.native_seek_count==seek_before&&p.beats==grid_before);
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => !p.metronome_open&&p.beats==grid_before);
                handle.update(cx,|_,w,cx|press(&view,w,cx,"metronome"))??;
                wait!(p,w,app => p.metronome_open);
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-volume"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;
                wait!(p,w,app => !p.metronome_ui.read(app).volume_focused(w));
                handle.update(cx,|_,w,cx|volume(&view,w,cx,0.5))??;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.volume==0.5&&p.metronome_ui.read(app).volume_focused(w));
                let count=handle.update(cx,|_,_,cx|view.read(cx).native_seek_count)?;
                handle.update(cx,|_,w,cx|{for _ in 0..3{key(w,cx,"right");}})?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.volume==0.53&&p.native_seek_count==count);
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.metronome_open&&p.metronome_ui.read(app).volume_focused(w)
                    &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.metronome_open&&p.metronome_ui.read(app).volume_focused(w)
                    &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"left");})?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.volume==0.&&p.native_seek_count==count);
                handle.update(cx,|_,w,cx|{key(w,cx,"end");key(w,cx,"right");})?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.volume==1.&&p.native_seek_count==count);
                handle.update(cx,|_,w,cx|volume(&view,w,cx,original.volume))??;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.volume==original.volume);
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-accent-1"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => p.metronome_pending.is_none()&&!p.metronome.accent);
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&!p.metronome.accent&&p.metronome_open&&p.focus_handle.is_focused(w));
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-accent-0"))??;
                let position=handle.update(cx,|_,_,cx|view.read(cx).position)?;
                handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                wait!(p,w,app => p.pending_seek.is_none()&&(p.position-(position+5.).min(p.duration)).abs()<0.03);
                handle.update(cx,|_,w,cx|key(w,cx,"left"))?;
                wait!(p,w,app => p.pending_seek.is_none()&&(p.position-position).abs()<0.03);
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome.accent);
                if !original.accent {handle.update(cx,|_,w,cx|press(&view,w,cx,"met-accent-1"))??;}
                wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome==original);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{ui_training_run::draw(w,cx);let value=state(view.read(cx),w,cx);
                    let name=format!("metronome-keyboard-{}",width as u32);w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;cases.push(value);Ok(())})??;
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-bpm"))??;
                handle.update(cx,|_,w,cx|{key(w,cx,if cfg!(target_os="macos"){"cmd-a"}else{"ctrl-a"});for text in ["1","2","0"]{key(w,cx,text);}key(w,cx,"enter");})?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.bpm==120.));
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"met-half"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.bpm==60.));
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.bpm==30.)&&p.metronome_ui.read(app).focused_control(w,app).is_none());
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.metronome_open);
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => !p.playing&&p.native_play_intent.is_none());
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => !p.metronome_open);
                // Boundary edits stay unsaved. Reload through production Open
                // to restore the exact original grid, including no-grid songs.
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.as_ref().is_some_and(|s|s.dir==project)
                    &&!p.playing&&p.position.abs()<0.03&&p.metronome==original&&p.beats==grid_before);
            }
            handle.update(cx,|_,w,cx|{let focus=view.read(cx).focus_handle.clone();focus.focus(w,cx);key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"});})?;
            wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq&&p.metronome_pending.is_none()&&p.metronome==original);
            let (saved,_)=project_store::read(&project,"project.json")?;
            anyhow::ensure!(beat::Metronome::sanitize(&saved["settings"]["metronome"])==original,"Metronome keyboard journey did not restore saved baseline");
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            std::fs::write(out.join("metronome-keyboard.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualTabAndPointerFocus":true,"bpmTypingOwnsSongKeys":true,"burstRangeKeysAccumulate":true,"homeEndClamp":true,"rangeArrowsDoNotSeek":true,
                "nonmodalSpaceTogglesSong":true,"rangeSpaceRetainsFocus":true,"buttonSpaceDoesNotActivate":true,
                "buttonArrowsSeek":true,"enterActivatesAccent":true,"nativeTransactionsAccepted":true,"restoredSavedBaseline":true,
                "disabledHalfFocusRecoversTransport":true,"boundaryGridRestoredThroughProductionOpen":true,
                "tapSessionResetOnActualReopen":true,"threeFreshTapsAccepted":true,"gridOnlyTriggerActive":true,"countInOnlyTriggerInactive":true,
                "cases":cases,"sizes":[[1280,800],[1060,640]],"liveFps":"unmeasured"}))?)?;Ok(())
        }.await;
        let _=tx.send(result.map_err(|e|format!("{e:#}")));
    }).detach();rx
}

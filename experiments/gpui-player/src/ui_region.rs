//! Opt-in real native region gestures, playback boundaries and persistence.
use super::*;
use std::{path::PathBuf, sync::mpsc, time::Duration};

fn drag(view:&Entity<Player>,w:&mut Window,cx:&mut App,from:f32,to:f32,ruler:bool)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    let p=view.read(cx);
    let b=p.region.bounds.get().ok_or_else(||anyhow::anyhow!("Region timeline was not drawn"))?;
    anyhow::ensure!(p.view_start==0.&&p.view_end==1.,"Region fixture must show the full song");
    let y=b.top()+px(if ruler {10.}else{50.});
    let at=|fraction:f32|point(b.left()+b.size.width*fraction,y);
    anyhow::ensure!(y<w.viewport_size().height&&at(from).x>b.left()&&at(to).x<b.right(),"Region pointer outside timeline");
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:at(from),pressed_button:None,modifiers:Modifiers::default()}),cx);
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:at(from),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    anyhow::ensure!(view.read(cx).region.gesture.is_some(),"Actual region pointer down did not begin a gesture");
    if from!=to {
        w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:at(to),pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}),cx);
    }
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:at(to),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    anyhow::ensure!(view.read(cx).region.gesture.is_none(),"Region mouse up left a ghost gesture");
    Ok(())
}
fn escape(view:&Entity<Player>,w:&mut Window,cx:&mut App){
    let focus=view.read(cx).focus_handle.clone();focus.focus(w,cx);
    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);
}
fn play(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Native Play control is missing"))?;
    super::ui_training_run::click(w,cx,b.center());Ok(())
}
fn close(a:Option<(f32,f32)>,b:Option<(f32,f32)>)->bool {
    match (a,b){(None,None)=>true,(Some(a),Some(b))=>(a.0-b.0).abs()<0.002&&(a.1-b.1).abs()<0.002,_=>false}
}
fn state(p:&Player,w:&Window)->serde_json::Value {
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "hidden":!w.is_visible()&&!w.is_window_active(),"epoch":p.native_epoch,"playing":p.playing,"position":p.position,
        "selection":p.project.as_ref().and_then(|p|p.selection),"looping":p.looping,"regionBusy":p.region_busy(),"gesture":p.region.gesture.is_some(),
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"region":s.region_range,"loop":s.loop_range,"loopCount":s.loop_count,"playing":s.playing,"position":s.position})),
        "scope":"app-local waveform/ruler gestures and native boundary receipts; cadence and production visual parity unmeasured"})
}
pub fn run(handle:AnyWindowHandle,view:Entity<Player>,project:PathBuf,out:PathBuf,cx:&mut App)->mpsc::Receiver<Result<(),String>> {
    let (tx,rx)=mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Region test must be hidden and muted");
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Region test activated a window or raised a notice: {:?}",$p.notice);
                        Ok($condition)})??;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Region timeout: {}",stringify!($condition));
                }
            }};}
            macro_rules! accepted {($selection:expr,$looping:expr)=>{
                wait!(p,w,app => !p.region_busy()&&close(p.project.as_ref().and_then(|p|p.selection),$selection)&&p.looping==$looping
                    &&p.last_playback_status.as_ref().is_some_and(|s|close(s.region_range,$selection)&&close(s.loop_range,if $looping {$selection}else{None})));
            };}
            macro_rules! gesture {($from:expr,$to:expr,$ruler:expr)=>{
                handle.update(cx,|_,w,cx|drag(&view,w,cx,$from,$to,$ruler))??;
            };}
            macro_rules! save {()=>{{
                handle.update(cx,|_,w,cx|{
                    let focus=view.read(cx).focus_handle.clone();focus.focus(w,cx);
                    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse(if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}).unwrap(),is_held:false,prefer_character_input:false}),cx);
                })?;
                wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq);
            }};}
            macro_rules! reopen {()=>{{
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.is_some()&&!p.playing);
            }};}
            let duration=handle.update(cx,|_,_,cx|->anyhow::Result<f32>{let p=view.read(cx);
                anyhow::ensure!(p.backend.is_some()&&p.screen==Screen::Player&&!p.playing&&!p.region_busy()
                    &&p.project.as_ref().is_some_and(|p|p.selection.is_none())&&!p.looping&&p.duration>=4.,"Region fixture starts in an unexpected state");Ok(p.duration)})??;
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                gesture!(0.2,0.55,false);accepted!(Some((duration*0.2,duration*0.55)),false);
                gesture!(0.2,0.15,true);accepted!(Some((duration*0.15,duration*0.55)),false);
                gesture!(0.55,0.3,false);accepted!(Some((duration*0.15,duration*0.3)),false);
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    super::ui_training_run::draw(w,cx);
                    let name=format!("region-selection-{}",width as u32);
                    let value=state(view.read(cx),w);anyhow::ensure!(value["hidden"]==true,"Region capture was not hidden");
                    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
                })??;
                gesture!(0.6,0.6,true);accepted!(None,false);
                wait!(p,w,app => p.pending_seek.is_none()&&(p.position-duration*0.6).abs()<0.03);
                gesture!(0.25,0.45,true);accepted!(Some((duration*0.25,duration*0.45)),false);
                handle.update(cx,|_,w,cx|escape(&view,w,cx))?;accepted!(None,false);
            }
            gesture!(0.15,0.3,false);let selection=Some((duration*0.15,duration*0.3));accepted!(selection,false);
            handle.update(cx,|_,w,cx|play(&view,w,cx))??;
            wait!(p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&(s.position-duration*0.3).abs()<0.03));
            let end_stop=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
            handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Loop)))?;
            accepted!(selection,true);
            let loops=handle.update(cx,|_,_,cx|view.read(cx).last_playback_status.as_ref().unwrap().loop_count)?;
            handle.update(cx,|_,w,cx|play(&view,w,cx))??;
            wait!(p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.loop_count>loops
                &&s.position>=duration*0.15-0.03&&s.position<duration*0.3+0.03));
            let loop_wrap=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
            handle.update(cx,|_,w,cx|play(&view,w,cx))??;
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
            save!();
            let (saved,_)=project_store::read(&project.canonicalize()?,"project.json")?;
            anyhow::ensure!(saved["settings"]["loop"]==true&&saved["settings"]["selection"].is_object(),"Saved selection/loop is missing");
            reopen!();accepted!(selection,true);
            let reopened_some=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
            handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Loop)))?;
            accepted!(selection,false);
            handle.update(cx,|_,w,cx|escape(&view,w,cx))?;accepted!(None,false);
            save!();
            let (cleared,_)=project_store::read(&project.canonicalize()?,"project.json")?;
            anyhow::ensure!(cleared["settings"].get("selection").is_none()&&cleared["settings"]["loop"]==false,"Cleared saved selection/loop did not persist");
            reopen!();accepted!(None,false);
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.))&&p.position==0.);
            std::fs::write(out.join("region.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualWaveDrag":true,"actualRulerDrag":true,"bothEdgeResize":true,"actualClickClear":true,"actualEscapeClear":true,
                "sizes":[[1280,800],[1060,640]],"nativeNonloopEndStop":true,"nativeLoopWrap":true,
                "savedSelectionReopened":true,"savedNoneReopened":true,"restoredBaseline":true,
                "endStop":end_stop,"loopWrap":loop_wrap,"reopenedSome":reopened_some,
                "scope":"actual app-local region gestures and Play/Pause; Loop via production transport event; Save key; real native receipts; no physical output or frame cadence qualification"
            }))?)?;
            Ok(())
        }.await;
        let _=tx.send(result.map_err(|error|format!("{error:#}")));
    }).detach();
    rx
}

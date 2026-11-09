//! Opt-in source SongOutput controls connected to muted native playback.
use super::*;
use std::{path::PathBuf,sync::mpsc,time::Duration};
fn click_output(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    let b=view.read(cx).transport.read(cx).bounds(id).ok_or_else(||anyhow::anyhow!("Output control missing: {id}"))?;
    anyhow::ensure!(b.left()>=px(0.)&&b.top()>=px(0.)&&b.right()<=w.viewport_size().width&&b.bottom()<=w.viewport_size().height,"Output control outside viewport: {id} {b:?}");
    super::ui_training_run::click(w,cx,b.center());Ok(())
}
fn key(w:&mut Window,cx:&mut App,key:&'static str){
    super::ui_training_run::draw(w,cx);
    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse(key).unwrap(),is_held:false,prefer_character_input:false}),cx);
}
fn drag_outer_thumb(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    let b=view.read(cx).transport.read(cx).bounds("transport-output-slider")
        .ok_or_else(||anyhow::anyhow!("Output fader is not drawn"))?;
    // Start on the maximum thumb's upper outline, outside the six-pixel
    // track, and keep every drag point outside it. This exercises the real
    // hit owner and pointer capture rather than only testing X arithmetic.
    let y=b.top()-px(5.);
    let from=point(b.right()-px(7.5),y);
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:from,pressed_button:None,modifiers:Modifiers::default()}),cx);
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:from,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    for fraction in [0.6,0.5,0.5] {
        w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:point(b.left()+b.size.width*fraction,y),pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}),cx);
    }
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:point(b.center().x,y),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    Ok(())
}
fn state(p:&Player,w:&Window,cx:&App)->serde_json::Value {
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "hidden":!w.is_visible()&&!w.is_window_active(),"output":p.transport.read(cx).output_state(),"acceptedMaster":p.master_volume,
        "position":p.position,"selection":p.project.as_ref().and_then(|project|project.selection),"regionBusy":p.region_busy(),
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"outputPeak":s.output_peak,"outputClippedBlocks":s.output_clipped_blocks})),
        "liveFps":"unmeasured","productionParity":"candidate; source visual comparison pending"})
}
pub fn run(handle:AnyWindowHandle,view:Entity<Player>,project:PathBuf,out:PathBuf,cx:&mut App)->mpsc::Receiver<Result<(),String>> {
    let (tx,rx)=mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Song output verification requires hidden/muted execution");
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{super::ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Output flow activated window or raised notice: {:?}",$p.notice);
                        anyhow::ensure!(!$p.playing&&$p.position.abs()<0.03&&!$p.region_busy()&&$p.region.gesture.is_none()
                            &&$p.project.as_ref().is_none_or(|project|project.selection.is_none()),"Output controls changed the underlying playhead or region");
                        Ok($condition)})??;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Song output timeout: {}",stringify!($condition));
                }
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|click_output(&view,w,cx,$id))??;};}
            macro_rules! gain {($expected:expr)=>{wait!(p,w,app => (p.master_volume-$expected).abs()<0.00001
                &&p.transport.read(app).output_state()["gain"].as_f64().is_some_and(|v|(v-$expected as f64).abs()<0.00001));};}
            macro_rules! save {()=>{{
                handle.update(cx,|_,w,cx|{let focus=view.read(cx).focus_handle.clone();focus.focus(w,cx);key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"});})?;
                wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq);
            }};}
            macro_rules! reopen {()=>{{
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.is_some()&&!p.playing);
            }};}
            let original=handle.update(cx,|_,_,cx|->anyhow::Result<f32>{let p=view.read(cx);anyhow::ensure!(!p.playing&&p.project.is_some(),"Output fixture must be paused and loaded");Ok(p.master_volume)})??;
            press!("transport-output");wait!(p,w,app => p.transport.read(app).output_state()["open"]==true);
            handle.update(cx,|_,w,cx|key(w,cx,"home"))?;gain!(0.);
            handle.update(cx,|_,w,cx|key(w,cx,"end"))?;let maximum=10_f32.powf(12./20.);gain!(maximum);
            handle.update(cx,|_,w,cx|drag_outer_thumb(&view,w,cx))??;gain!(10_f32.powf(-24./20.));
            handle.update(cx,|_,w,cx|key(w,cx,"end"))?;gain!(maximum);
            press!("transport-output-mute");gain!(0.);
            press!("transport-output-mute");gain!(maximum);
            press!("transport-output-unity");gain!(1.);
            // Exercise the measured range control through an actual pointer change.
            press!("transport-output-slider");
            gain!(10_f32.powf(-24./20.));
            // Reopen the popup to exercise its source autofocus rather than
            // assigning controller state or manufacturing a keyboard result.
            press!("transport-output");press!("transport-output");
            handle.update(cx,|_,w,cx|key(w,cx,"end"))?;gain!(maximum);
            handle.update(cx,|_,w,cx|key(w,cx,"left"))?;gain!(10_f32.powf(11.5/20.));
            press!("transport-output-unity");gain!(1.);
            press!("transport-output-clip");
            wait!(p,w,app => p.transport.read(app).output_state()["clipped"]==false);
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    super::ui_training_run::draw(w,cx);let value=state(view.read(cx),w,cx);
                    anyhow::ensure!(value["hidden"]==true&&value["output"]["open"]==true,"Output capture state was not accepted");
                    let name=format!("output-popup-{}",width as u32);
                    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
                })??;
            }
            // Remember a genuinely non-unity gain, then persist zero. A fresh
            // load remounts source SongOutput even for the same song path.
            press!("transport-output-slider");gain!(10_f32.powf(-24./20.));
            press!("transport-output-mute");gain!(0.);
            handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app => p.transport.read(app).output_state()["open"]==false);
            save!();let (zero_saved,_)=project_store::read(&project.canonicalize()?,"project.json")?;
            anyhow::ensure!(zero_saved["settings"]["masterVolume"]==0.,"Muted output was not saved");
            reopen!();gain!(0.);
            let zero_reopened=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx))?;
            anyhow::ensure!(zero_reopened["output"]["previousGain"]==1.,"A fresh muted song inherited the previous component's gain");
            press!("transport-output");press!("transport-output-mute");gain!(1.);
            handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app => p.transport.read(app).output_state()["open"]==false);
            save!();let (saved,_)=project_store::read(&project.canonicalize()?,"project.json")?;
            anyhow::ensure!(saved["settings"]["masterVolume"]==1.,"Unity output was not saved");
            reopen!();gain!(1.);
            let unity_reopened=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx))?;
            // Restore the original accepted graph fixture through the real
            // transport event; the exact original gain may be off the dB grid.
            handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Volume(original))))?;
            // Entity state is controlled by the host for this restoration.
            handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_native_mix(original,cx)))?;
            gain!(original);
            save!();reopen!();gain!(original);
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            std::fs::write(out.join("output.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualPopupTrigger":true,"actualRangeKeys":true,"silentMinimum":true,"plus12Headroom":true,"halfDbStep":true,
                "actualOuterThumbDrag":true,"outerThumbDragYOffset":-5.,
                "actualMuteRestore":true,"actualUnity":true,"actualClipReset":true,"actualEscapeDismiss":true,"underlyingTransportUnchanged":true,
                "savedUnityReopened":true,"restoredOriginalGain":true,"originalGain":original,"unityReopened":unity_reopened,
                "savedZeroFreshReopenUnmuteUnity":true,"zeroReopened":zero_reopened,
                "sizes":[[1280,800],[1060,640]],"clippingRuntimeQualified":false,
                "scope":"actual output controls and native transport; peak telemetry from real muted helper; clipping latch separately unit-tested; original gain restored via labelled controller event"
            }))?)?;Ok(())
        }.await;
        let _=tx.send(result.map_err(|error|format!("{error:#}")));
    }).detach();rx
}

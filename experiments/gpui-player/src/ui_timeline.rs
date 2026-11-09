//! Hidden navigation through real wheel, pinch, keyboard and transport input.
use super::*;
use std::{path::PathBuf, sync::mpsc, time::Duration};

fn bounds(p:&Player,cx:&App,pitch:bool)->anyhow::Result<Bounds<Pixels>> {
    if pitch {p.pitch_strip.read(cx).timeline_bounds()} else {p.region.bounds.get()}
        .ok_or_else(||anyhow::anyhow!("Timeline input surface was not drawn (pitch={pitch})"))
}
// DOM-style right/down deltas; GPUI pointing-device deltas use the opposite sign.
fn wheel(view:&Entity<Player>,w:&mut Window,cx:&mut App,pitch:bool,fraction:f32,dx:f32,dy:f32,zoom:bool)->anyhow::Result<f32> {
    let b=bounds(view.read(cx),cx,pitch)?;
    let position=point(b.left()+b.size.width*fraction,b.top()+px(10.));
    anyhow::ensure!(position.y<w.viewport_size().height,"Wheel surface is outside the viewport");
    w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position,
        delta:ScrollDelta::Pixels(point(px(-dx),px(-dy))),
        modifiers:Modifiers{control:zoom,..Default::default()},..Default::default()}),cx);
    Ok(f32::from(b.size.width))
}
fn press(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    let p=view.read(cx);let t=p.transport.read(cx);
    let b=if id=="karaoke" {t.guides.get(id)}else if id.starts_with("zoom-") {p.track_bounds.borrow().get(id).copied()}else{t.bounds(id)}
        .ok_or_else(||anyhow::anyhow!("Timeline transport control missing: {id}"))?;
    anyhow::ensure!(b.bottom()<=w.viewport_size().height,"Timeline control outside viewport: {id}");
    super::ui_training_run::click(w,cx,b.center());Ok(())
}
fn key(view:&Entity<Player>,w:&mut Window,cx:&mut App,value:&'static str) {
    view.read(cx).focus_handle.clone().focus(w,cx);
    w.dispatch_keystroke(Keystroke::parse(value).unwrap(),cx);
}
fn assert_ruler(p:&Player)->anyhow::Result<()> {
    let evidence=p.ruler_frame.evidence();
    let labels=evidence["labels"].as_array().ok_or_else(||anyhow::anyhow!("Ruler geometry missing"))?;
    anyhow::ensure!(!labels.is_empty(),"Ruler labels were not laid out");
    for label in labels {
        let right=label["right"].as_f64().unwrap();
        let left=evidence["zoomGroup"]["left"].as_f64().ok_or_else(||anyhow::anyhow!("Zoom group was not prepainted: {evidence}"))?;
        anyhow::ensure!((left-label["groupLeft"].as_f64().unwrap()).abs()<0.01,"Ruler zoom layout and actual origin disagree: {evidence}");
        anyhow::ensure!(label["width"].as_f64().unwrap()>0.&&label["zoomWidth"].as_f64().unwrap()>0.,"Ruler measured empty geometry: {label}");
        anyhow::ensure!(label["admitted"].as_bool()==Some(right<=left),"Ruler partial label admission: {label}");
    }
    Ok(())
}
fn state(p:&Player,w:&Window)->serde_json::Value {
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),
        "view":[p.view_start,p.view_end],"position":p.position,"playing":p.playing,
        "duration":p.duration,"epoch":p.native_epoch,"seekCount":p.native_seek_count,
        "timeline":p.timeline_review_state(),
        "pendingSeek":p.pending_seek,"selection":p.region_target().selection,
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"position":s.position,"playing":s.playing})),
        "liveFps":"unmeasured","productionParity":"source behavior; matched reference capture pending"})
}
fn near(a:f32,b:f32)->bool {(a-b).abs()<0.002}
fn seek_visible(view:&Entity<Player>,w:&mut Window,cx:&mut App,fraction:f32)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);let b=bounds(view.read(cx),cx,false)?;
    super::ui_training_run::click(w,cx,point(b.left()+b.size.width*fraction,b.top()+px(50.)));Ok(())
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,project:PathBuf,out:PathBuf,cx:&mut App)->mpsc::Receiver<Result<(),String>> {
    let (tx,rx)=mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Timeline verification must be hidden and muted");
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop {cx.background_executor().timer(Duration::from_millis(16)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{
                        super::ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Timeline window activated or notice appeared: {:?}",$p.notice);
                        anyhow::ensure!(!$p.region_busy()&&$p.region.gesture.is_none()&&$p.region_target().selection.is_none(),"Timeline navigation edited a playback region");
                        Ok($condition)
                    })??;
                    if ready {break;}
                    if Instant::now()>=deadline {let evidence=handle.update(cx,|_,w,app|state(view.read(app),w))?;
                        anyhow::bail!("Timeline timeout: {}: {evidence}",stringify!($condition));}
                }
            }};}
            macro_rules! fit {()=>{{
                handle.update(cx,|_,w,cx|press(&view,w,cx,"zoom-fit"))??;
                wait!(p,w,app => near(p.view_start,0.)&&near(p.view_end,1.));
            }};}
            macro_rules! zoom {($fraction:expr)=>{{
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(w,cx);
                    for _ in 0..3 {wheel(&view,w,cx,false,$fraction,0.,0.7_f32.ln()/0.008,true)?;}Ok(())
                })??;
                wait!(p,w,app => near(p.view_end-p.view_start,0.343));
            }};}
            macro_rules! save {()=>{{
                handle.update(cx,|_,w,cx|key(&view,w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
                wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq);
            }};}
            macro_rules! reopen {()=>{{
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.native_epoch>epoch&&!p.playing&&p.project.is_some());
            }};}
            let initial_karaoke=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);
                anyhow::ensure!(!p.playing&&p.project.is_some()&&p.duration>10.,"Timeline fixture must be a paused long-enough native song");Ok(p.karaoke)})??;
            if !initial_karaoke {handle.update(cx,|_,w,cx|press(&view,w,cx,"karaoke"))??;}
            wait!(p,w,app => p.karaoke&&p.pitch_strip.read(app).timeline_bounds().is_some());
            let mut cases=Vec::new();
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                fit!();
                for karaoke in [false,true] {
                    if handle.update(cx,|_,_,cx|view.read(cx).karaoke)?!=karaoke {
                        handle.update(cx,|_,w,cx|press(&view,w,cx,"karaoke"))??;
                    }
                    wait!(p,w,app => p.karaoke==karaoke);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        super::ui_training_run::draw(w,cx);let p=view.read(cx);assert_ruler(p)?;
                        let value=state(p,w);let name=format!("timeline-fit-karaoke-{}-{}",karaoke,width as u32);
                        w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                        std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;
                        cases.push(value);Ok(())
                    })??;
                }
                zoom!(0.);
                handle.update(cx,|_,w,cx|seek_visible(&view,w,cx,0.94))??;
                wait!(p,w,app => !p.playing&&p.pending_seek.is_none()&&near(p.position/p.duration,0.343*0.94));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(w,cx);assert_ruler(view.read(cx))?;let value=state(view.read(cx),w);
                    let name=format!("timeline-zoom-controls-{}",width as u32);
                    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
                })??;
                handle.update(cx,|_,w,cx|press(&view,w,cx,"zoom-in"))??;
                wait!(p,w,app => near(p.view_end-p.view_start,0.343*0.65));
                handle.update(cx,|_,w,cx|press(&view,w,cx,"zoom-out"))??;
                wait!(p,w,app => near(p.view_end-p.view_start,0.343*0.65*1.4));
                handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-restart"))??;
                wait!(p,w,app => p.pending_seek.is_none()&&p.position.abs()<0.03);
                fit!();zoom!(0.3);
                wait!(p,w,app => near(p.view_start,0.1971)&&near(p.view_end,0.5401));
                let (before,span,pan_width)=handle.update(cx,|_,w,cx|->anyhow::Result<(f32,f32,f32)>{
                    super::ui_training_run::draw(w,cx);let p=view.read(cx);let before=p.view_start;let span=p.view_end-p.view_start;
                    let width=f32::from(bounds(p,cx,false)?.size.width);
                    for _ in 0..5 {wheel(&view,w,cx,false,0.5,100.,10.,false)?;}
                    Ok((before,span,width))
                })??;
                let expected=(before+500./pan_width*span).clamp(0.,1.-span);
                wait!(p,w,app => near(p.view_start,expected)&&near(p.view_end-p.view_start,span));
                let (before,pitch_width)=handle.update(cx,|_,w,cx|->anyhow::Result<(f32,f32)>{
                    super::ui_training_run::draw(w,cx);let before=view.read(cx).view_start;
                    let width=wheel(&view,w,cx,true,0.5,10.,-60.,false)?;Ok((before,width))
                })??;
                let expected=(before-60./pitch_width*span).clamp(0.,1.-span);
                wait!(p,w,app => near(p.view_start,expected)&&near(p.view_end-p.view_start,span));
                // Retain the real keyboard → pinch regression even though the
                // zoom-button checks above changed pointer input modality.
                save!();
                let (anchor,old_span)=handle.update(cx,|_,w,cx|->anyhow::Result<(f32,f32)>{
                    super::ui_training_run::draw(w,cx);let p=view.read(cx);let span=p.view_end-p.view_start;
                    let anchor=p.view_start+0.7*span;let b=bounds(p,cx,true)?;
                    w.dispatch_event(PlatformInput::Pinch(PinchEvent{position:point(b.left()+b.size.width*0.7,b.top()+px(10.)),delta:0.1,..Default::default()}),cx);
                    Ok((anchor,span))
                })??;
                wait!(p,w,app => p.view_end-p.view_start<old_span-0.001&&near(p.view_start+0.7*(p.view_end-p.view_start),anchor));
                let saved_view=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.view_start,p.view_end)})?;
                save!();reopen!();
                wait!(p,w,app => near(p.view_start,saved_view.0)&&near(p.view_end,saved_view.1));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(w,cx);assert_ruler(view.read(cx))?;let value=state(view.read(cx),w);
                    let name=format!("timeline-pan-{}",width as u32);w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;cases.push(value);Ok(())
                })??;
            }
            fit!();zoom!(0.);
            let span=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.view_end-p.view_start})?;
            handle.update(cx,|_,w,cx|key(&view,w,cx,"right"))?;
            wait!(p,w,app => p.pending_seek.is_none()&&(p.position-5.).abs()<0.03
                &&near(p.view_start,(5./p.duration-span*0.25).clamp(0.,1.-span)));
            let seek_cut=handle.update(cx,|_,w,cx|state(view.read(cx),w))?;
            handle.update(cx,|_,w,cx|key(&view,w,cx,"left"))?;
            wait!(p,w,app => p.pending_seek.is_none()&&p.position.abs()<0.03&&near(p.view_start,0.));
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
            wait!(p,w,app => p.view_start>0.0001);
            let frames=out.join("timeline-follow");std::fs::create_dir_all(&frames)?;
            let started=Instant::now();let mut follow=Vec::new();
            while started.elapsed()<Duration::from_millis(1050) {
                let index=follow.len();
                let value=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{
                    super::ui_training_run::draw(w,cx);let p=view.read(cx);
                    anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none()&&p.playing,"Follow lost hidden native playback");
                    let value=state(p,w);
                    if [0,12,24].contains(&index) {
                        w.render_to_image()?.save(frames.join(format!("frame-{index:03}.png")))?;
                        std::fs::write(frames.join(format!("frame-{index:03}.json")),serde_json::to_vec_pretty(&value)?)?;
                    }
                    Ok(value)
                })??;follow.push(serde_json::json!({"elapsedMs":started.elapsed().as_secs_f64()*1000.,"state":value}));
                cx.background_executor().timer(Duration::from_millis(25)).await;
            }
            let positions=follow.iter().map(|v|v["state"]["view"][0].as_f64().unwrap()).collect::<Vec<_>>();
            anyhow::ensure!(positions.len()>8&&positions.windows(2).all(|v|v[1]+0.0001>=v[0])
                &&positions.last().unwrap()-positions[0]>0.05
                &&positions.iter().filter(|v|**v>positions[0]+0.001&&**v<positions.last().unwrap()-0.001).count()>3,
                "Playback page turn did not progress through intermediate views: {positions:?}");
            anyhow::ensure!(follow.iter().any(|v|v["state"]["timeline"]["followActive"]==true)
                &&follow.last().unwrap()["state"]["timeline"]["followActive"]==false,"Page turn did not settle its real animation");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{super::ui_training_run::draw(w,cx);wheel(&view,w,cx,false,0.5,10000.,0.,false)?;Ok(())})??;
            wait!(p,w,app => near(p.view_end,1.)&&p.position/p.duration<p.view_start-0.05);
            let away=handle.update(cx,|_,_,cx|view.read(cx).view_start)?;
            for _ in 0..20 {cx.background_executor().timer(Duration::from_millis(25)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{super::ui_training_run::draw(w,cx);let p=view.read(cx);
                    anyhow::ensure!(p.playing&&near(p.view_start,away),"Manual pan away snapped back during playback");Ok(())})??;
            }
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-restart"))??;
            wait!(p,w,app => p.pending_seek.is_none()&&p.position<1.&&near(p.view_start,0.));
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
            wait!(p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
            handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-restart"))??;
            wait!(p,w,app => p.pending_seek.is_none()&&p.position.abs()<0.03);
            fit!();save!();reopen!();
            if !initial_karaoke {handle.update(cx,|_,w,cx|press(&view,w,cx,"karaoke"))??;}
            wait!(p,w,app => p.karaoke==initial_karaoke&&!p.playing&&near(p.view_start,0.)&&near(p.view_end,1.));
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            std::fs::write(out.join("timeline.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "cursorCenteredWheelZoom":true,"burstPanAccumulated":true,"pitchWheelPan":true,"pitchPinchZoom":true,
                "actualZoomButtons":true,"pausedPlayheadAtZoomControlsCaptured":true,"sameFrameRulerClearance":true,"fitKaraokeOffAndOnCaptured":true,"pinchAfterKeyboardSave":true,
                "manualViewSavedReopened":true,"actualOffscreenArrowSeekCuts":true,"playingPageTurnHasIntermediateViews":true,
                "manualPanAwayDoesNotSnapBack":true,"actualRestartCutsBack":true,"restoredBaseline":true,
                "cases":cases,"seekCut":seek_cut,"follow":follow,"sizes":[[1280,800],[1060,640]],
                "liveFps":"unmeasured","scope":"app-local actual wheel/pinch/keyboard/buttons, native playback and Save/reopen; matched production pixels and live cadence unqualified"
            }))?)?;Ok(())
        }.await;
        let _=tx.send(result.map_err(|error|format!("{error:#}")));
    }).detach();rx
}

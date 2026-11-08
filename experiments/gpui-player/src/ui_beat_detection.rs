//! Hidden connected beat-analysis checks. Stubbed detector timing is explicit;
//! project loading, app state, native admission and persistence are real.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

fn mode(root: &Path, name: &str, delay_ms: u64) -> anyhow::Result<()> {
    std::fs::write(root.join("control.json"), serde_json::to_vec(&serde_json::json!({"mode":name,"delayMs":delay_ms}))?)?;
    Ok(())
}
fn calls(root: &Path) -> usize {
    std::fs::read_to_string(root.join("calls.jsonl")).unwrap_or_default().lines().count()
}
fn raw(root: &Path, name: &str) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_slice(&std::fs::read(root.join(name).join("project.json"))?)?)
}
fn open_popover(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w,cx);
    if !view.read(cx).metronome_open {
        let bounds=view.read(cx).transport.read(cx).guides.get("metronome").ok_or_else(||anyhow::anyhow!("Metronome trigger not measured"))?;
        click(w,cx,bounds.center());draw(w,cx);
    }
    Ok(())
}
fn redetect(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w,cx);
    anyhow::ensure!(view.read(cx).metronome_open,"Re-detect requires an acknowledged open popover");
    let bounds=*view.read(cx).metronome_ui.read(cx).bounds.borrow().get("met-redetect").ok_or_else(||anyhow::anyhow!("Re-detect control not measured"))?;
    click(w,cx,bounds.center());draw(w,cx);Ok(())
}
fn accent(view: &Entity<Player>, w: &mut Window, cx: &mut App, on: bool) -> anyhow::Result<()> {
    draw(w,cx);
    let id=if on {"met-accent-0"} else {"met-accent-1"};
    let bounds=*view.read(cx).metronome_ui.read(cx).bounds.borrow().get(id).ok_or_else(||anyhow::anyhow!("Accent control not measured"))?;
    click(w,cx,bounds.center());draw(w,cx);Ok(())
}
fn manual_tempo(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w,cx);
    anyhow::ensure!(view.read(cx).metronome_open,"Tempo entry requires an acknowledged open popover");
    let input=view.read(cx).metronome_ui.read(cx).input();
    input.update(cx,|s,cx|s.focus(w,cx));draw(w,cx);
    input.update(cx,|s,cx|s.replace_all("111".to_owned(),w,cx));
    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("enter").unwrap(),is_held:false,prefer_character_input:false}),cx);
    draw(w,cx);Ok(())
}
fn move_live_bar(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w,cx);
    let p=view.read(cx);let (bounds,handles)=p.beat_handles.read(cx).snapshot();
    let bounds=bounds.ok_or_else(||anyhow::anyhow!("No beat ruler bounds"))?;
    let bar=handles.iter().find(|h|(h.time-2.4).abs()<1e-5).ok_or_else(||anyhow::anyhow!("No manual-grid bar at2.4s"))?;
    let start=point(bounds.left()+px(bar.x),bounds.center().y);
    let start_time=p.view_start*p.duration;let span=(p.view_end-p.view_start)*p.duration;
    let end=point(bounds.left()+bounds.size.width*((3.-start_time)/span),bounds.bottom()+px(20.));
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:start,pressed_button:None,modifiers:Default::default()}),cx);draw(w,cx);
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:start,button:MouseButton::Left,click_count:1,..Default::default()}),cx);draw(w,cx);
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:end,pressed_button:Some(MouseButton::Left),modifiers:Default::default()}),cx);draw(w,cx);
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:end,button:MouseButton::Left,click_count:1,..Default::default()}),cx);draw(w,cx);Ok(())
}
fn snapshot(view: &Entity<Player>, w: &mut Window, cx: &mut App, out: &Path, name: &str) -> anyhow::Result<()> {
    draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Beat test window became presented or active");
    let p=view.read(cx);
    let popover=p.metronome_ui.read(cx);
    let mut controls=popover.bounds.borrow().keys().cloned().collect::<Vec<_>>();controls.sort();
    let state=serde_json::json!({"project":p.project.as_ref().map(|p|p.name.clone()),"beat":p.beats,"metronome":p.metronome,
        "popover":p.metronome_open,"popoverControls":controls,"popoverMetronome":popover.met,"popoverBeat":popover.grid,
        "job":p.beat_job,"pending":p.metronome_pending,"autoSavePending":p.beat_auto_save,"editSequence":p.edit_seq,
        "savedSequence":p.saved_seq,"position":p.position,"playing":p.playing,"nativeSeekCount":p.native_seek_count,
        "notice":p.notice,"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),
        "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "reference":"deterministic analyzer stub; app-state evidence, not detector quality or production visual parity"});
    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&state)?)?;Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_BEAT_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing beat fixtures"))?);
            macro_rules! wait {($predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(25)).await;let ready=handle.update(cx,|_,_,cx|($predicate)(view.read(cx)))?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Beat state timed out: {}",stringify!($predicate));}}};}
            macro_rules! open {($name:expr)=>{{let path=root.join($name);handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));view.update(cx,|p,cx|{p.notice=None;p.open_project(path.clone(),cx);});})?;wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|p|p.name==$name));}};}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,$name))??;};}
            macro_rules! open_pop {()=>{{handle.update(cx,|_,w,cx|open_popover(&view,w,cx))??;wait!(|p:&Player|p.metronome_open);}};}

            mode(&root,"valid",0)?;open!("missing");
            wait!(|p:&Player|p.beats.as_ref().is_some_and(|g|g.source=="auto"&&g.det_version==Some(beat_analysis::version() as f64))&&p.beat_job.is_none()&&p.metronome_pending.is_none()&&!p.saving&&p.saved_seq==p.edit_seq);
            anyhow::ensure!(raw(&root,"missing")?["settings"]["beat"]["bpm"].as_f64()==Some(120.),"Missing-grid auto detection was not saved");shot!("auto-missing");
            open!("stale");wait!(|p:&Player|p.beats.as_ref().is_some_and(|g|(g.bpm-120.).abs()<1e-6&&g.det_version==Some(beat_analysis::version() as f64))&&p.beat_job.is_none()&&p.metronome_pending.is_none()&&!p.saving&&p.saved_seq==p.edit_seq);
            anyhow::ensure!(raw(&root,"stale")?["settings"]["beat"]["detVersion"].as_f64()==Some(beat_analysis::version() as f64),"Stale-grid result was not saved");shot!("auto-stale");
            let before_protected=calls(&root);let manual_before=raw(&root,"manual")?;open!("manual");
            cx.background_executor().timer(Duration::from_millis(500)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beat_job.is_none()&&p.beats.as_ref().is_some_and(|g|g.source=="manual"&&(g.bpm-100.).abs()<1e-6),"Manual grid was replaced automatically");Ok(())})??;
            anyhow::ensure!(calls(&root)==before_protected&&raw(&root,"manual")?==manual_before,"Manual grid caused automatic analysis or disk writes");
            let future_before=raw(&root,"future")?;
            let expected_future=beat::Beats::sanitize(&future_before["settings"]["beat"]).ok_or_else(||anyhow::anyhow!("Future fixture grid is invalid"))?;
            open!("future");cx.background_executor().timer(Duration::from_millis(500)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beat_job.is_none()&&p.beats.as_ref()==Some(&expected_future)&&expected_future.det_version==Some(beat_analysis::version() as f64+1.),"Future stamped grid was downgraded");Ok(())})??;
            anyhow::ensure!(calls(&root)==before_protected&&raw(&root,"future")?==future_before,"Future grid caused automatic analysis or disk writes");shot!("protected-future");

            // Use the actual Re-detect and ruler controls. The manual bar edit
            // is newer than the job's captured grid and must survive its result.
            open!("manual");mode(&root,"valid",3000)?;let before_redetect=calls(&root);
            open_pop!();
            handle.update(cx,|_,w,cx|redetect(&view,w,cx))??;
            wait!(|p:&Player|p.beat_job.is_some()&&calls(&root)>before_redetect);
            handle.update(cx,|_,w,cx|move_live_bar(&view,w,cx))??;
            wait!(|p:&Player|p.beats.as_ref().is_some_and(|g|g.user_bars.as_deref()==Some(&[3.][..]))&&p.metronome_pending.is_none()&&!p.saving&&p.saved_seq==p.edit_seq);
            let bar_saved=raw(&root,"manual")?;anyhow::ensure!(bar_saved["settings"]["beat"]["source"]=="manual","Manual bar Save raced past the delayed detector fixture");
            wait!(|p:&Player|p.beat_job.is_none()&&p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.source=="auto"&&(g.bpm-120.).abs()<1e-6));
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let g=p.beats.as_ref().unwrap();anyhow::ensure!(g.user_bars.as_deref()==Some(&[3.][..])&&g.auto_downbeats.as_deref()==Some(&[0,4,8,12,16,20][..]),"Re-detect did not fold LIVE bar edits over the new detector base");anyhow::ensure!(p.edit_seq>p.saved_seq&&!p.beat_auto_save,"Explicit Re-detect was auto-saved");Ok(())})??;
            anyhow::ensure!(raw(&root,"manual")?==bar_saved,"Explicit Re-detect unexpectedly published settings");shot!("redetect-live-bars");
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;wait!(|p:&Player|!p.saving&&p.saved_seq==p.edit_seq);

            // A ruler edit queues native acceptance before its receipt updates
            // Root. A second real popover control must carry that requested
            // grid forward rather than replacing it with the old accepted one.
            open_pop!();
            let (requested_grid,requested_accent,first_serial)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{
                let (grid,on)=view.update(cx,|p,cx|{
                    let grid=p.beats.as_ref().unwrap().set_user_bar(4.5,None);let on=!p.metronome.accent;
                    p.apply_beat_grid(grid.clone(),true,cx);(grid,on)
                });
                let first=view.read(cx).metronome_pending.ok_or_else(||anyhow::anyhow!("Ruler edit did not queue native acceptance"))?;
                // Rendering and app-local input cannot drain Backend receipts
                // inside this single synchronous update.
                accent(&view,w,cx,on)?;
                anyhow::ensure!(view.read(cx).metronome_ui.read(cx).grid.as_ref()==Some(&grid),"Pending ruler edit was absent from the second control's desired grid");
                Ok((grid,on,first))
            })??;
            // Child control subscriptions are delivered after the enclosing
            // update. Wait for that delivery rather than reading stale Root
            // state synchronously inside the click's update.
            wait!(|p:&Player|p.metronome_serial>first_serial);
            wait!(|p:&Player|p.metronome_pending.is_none()&&!p.saving&&!p.beat_auto_save&&p.saved_seq==p.edit_seq);
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beats.as_ref()==Some(&requested_grid)&&p.metronome.accent==requested_accent,"Later setting receipt erased the pending ruler edit");Ok(())})??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;wait!(|p:&Player|!p.saving&&p.saved_seq==p.edit_seq);
            let race_saved=raw(&root,"manual")?;
            anyhow::ensure!(race_saved["settings"]["beat"]["userBars"]==serde_json::json!([3.,4.5])&&race_saved["settings"]["metronome"]["accent"]==requested_accent,"Save lost the requested grid/control combination");
            std::fs::write(out.join("pending-grid-saved.json"),serde_json::to_vec_pretty(&race_saved)?)?;shot!("pending-grid-control-retained");

            // Fail the automatic bar Save with a real external metadata edit.
            // Navigation requested before the audio receipt must remain behind
            // that Save and its visible conflict instead of silently discarding
            // the accepted hand correction.
            let mut external=raw(&root,"manual")?;external["externalChange"]=serde_json::json!({"keep":"outside writer"});
            let external_bytes=serde_json::to_vec_pretty(&external)?;std::fs::write(root.join("manual/project.json"),&external_bytes)?;
            let barrier_epoch=handle.update(cx,|_,_,cx|view.update(cx,|p,cx|->anyhow::Result<_>{
                let epoch=p.native_epoch;let grid=p.beats.as_ref().unwrap().set_user_bar(5.5,None);
                p.apply_beat_grid(grid,true,cx);p.open_project(root.join("future"),cx);
                anyhow::ensure!(p.native_epoch==epoch&&!p.loading&&p.metronome_pending.is_some(),"Navigation overtook pending bar acceptance/automatic Save");Ok(epoch)
            }))??;
            wait!(|p:&Player|p.metronome_pending.is_none()&&!p.saving&&p.notice.as_ref().is_some_and(|n|n.contains("changed outside")));
            cx.background_executor().timer(Duration::from_millis(300)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.native_epoch==barrier_epoch&&!p.loading&&p.project.as_ref().is_some_and(|p|p.name=="manual")&&p.notice.is_some()&&p.metronome_navigation.is_some(),"Automatic Save conflict did not retain the old project and blocked navigation");Ok(())})??;
            anyhow::ensure!(std::fs::read(root.join("manual/project.json"))?==external_bytes,"Automatic Save overwrote external metadata");shot!("auto-save-navigation-conflict");
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;p.metronome_navigation=None;cx.notify();}))?;

            mode(&root,"valid",1500)?;let before_changed=calls(&root);let changed_before=raw(&root,"changed")?;open!("changed");
            wait!(|p:&Player|p.beat_job.is_some()&&calls(&root)>before_changed);
            let changed_path=root.join("changed/stems/drums.wav");let mut changed=std::fs::read(&changed_path)?;changed.extend_from_slice(&[0,0]);std::fs::write(&changed_path,changed)?;
            wait!(|p:&Player|p.beat_job.is_none()&&p.notice.as_ref().is_some_and(|n|n.contains("changed")));
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beats.is_none()&&!p.beat_auto_save&&!p.saving,"Changed input reached accepted audio/Save state");Ok(())})??;
            anyhow::ensure!(raw(&root,"changed")?==changed_before,"Changed input result was saved");shot!("changed-input-refused");

            mode(&root,"valid",5000)?;let before_cancel=calls(&root);open!("cancel");wait!(|p:&Player|p.beat_job.is_some()&&calls(&root)>before_cancel);
            open!("future");cx.background_executor().timer(Duration::from_millis(500)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beat_job.is_none()&&p.beat_result.is_none()&&p.beats.as_ref()==Some(&expected_future),"Navigation retained the old analysis job or result");Ok(())})??;
            anyhow::ensure!(raw(&root,"future")?==future_before,"Cancelled analysis modified the new project");shot!("navigation-cancelled");

            let before_intent=calls(&root);open!("intent");wait!(|p:&Player|p.beat_job.is_some()&&calls(&root)>before_intent);
            open_pop!();
            handle.update(cx,|_,w,cx|manual_tempo(&view,w,cx))??;
            wait!(|p:&Player|p.beat_job.is_none()&&p.beat_result.is_none()&&p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.source=="manual"&&(g.bpm-111.).abs()<1e-6));
            cx.background_executor().timer(Duration::from_millis(500)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&!p.beat_auto_save&&p.beats.as_ref().is_some_and(|g|(g.bpm-111.).abs()<1e-6),"Cancelled automatic analysis overwrote manual tempo or retained busy/error state");Ok(())})??;shot!("manual-intent-cancelled");

            // Admission-fault coverage is deliberately separate from analyzer
            // parsing: an invalid pending grid must never become Save state.
            let rejected_before=std::fs::read(root.join("intent/project.json"))?;
            let accepted=handle.update(cx,|_,_,cx|view.read(cx).beats.clone())?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{let mut invalid=p.beats.clone().unwrap();invalid.beats[0]=-0.01;p.apply_beat_grid(invalid,true,cx);}))?;
            wait!(|p:&Player|p.metronome_pending.is_none()&&p.notice.is_some());
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beats==accepted&&!p.beat_auto_save&&!p.saving,"Rejected grid replaced accepted settings or triggered Save");Ok(())})??;
            anyhow::ensure!(std::fs::read(root.join("intent/project.json"))?==rejected_before,"Rejected grid was published");shot!("rejected-grid-not-saved");
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;cx.notify();}))?;
            mode(&root,"notfound",0)?;open_pop!();handle.update(cx,|_,w,cx|redetect(&view,w,cx))??;
            wait!(|p:&Player|p.beat_job.is_none()&&p.notice.as_ref().is_some_and(|n|n.contains("No steady beat")));
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.beats==accepted&&!p.beat_auto_save,"No-result detection erased the old grid");Ok(())})??;shot!("not-found-retained");
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"autoMissing":true,"autoStale":true,"autoSave":true,"manualProtected":true,"futureProtected":true,"explicitRedetect":true,"liveUserBars":true,"explicitDoesNotAutoSave":true,"pendingGridControlRace":true,"automaticSaveNavigationConflict":true,"inputChangedRefused":true,"navigationCancelled":true,"manualIntentCancelled":true,"rejectedGridNotSaved":true,"notFoundRetainsGrid":true,"hidden":true,"muted":true,"detectorQuality":"unmeasured; analyzer stub","rejectionScope":"Rust native-command admission"}))?)?;
            Ok(())
        }.await;
        if let Err(error)=result {eprintln!("NATIVE_BEAT_DETECTION failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"failure"));}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

//! Hidden actual Drive controls, local PKCE, native playback and durable sync.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{path::{Path, PathBuf}, time::Duration};
#[path="ui_drive_adoption.rs"]
mod adoption;

fn key(w:&mut Window,cx:&mut App,value:&'static str){w.dispatch_keystroke(Keystroke::parse(value).unwrap(),cx);}
fn state(view:&Entity<Player>,w:&Window,cx:&App)->serde_json::Value {
    let p=view.read(cx);
    serde_json::json!({"drive":p.drive_snapshot,"library":p.library.read(cx).drive_state(w),
        "headerFocused":p.header.read(cx).focused_control(w),"searchFocused":p.library.read(cx).search_focused(w,cx),
        "picker":p.project_picker.read(cx).state(w,cx),"pickerOpen":p.project_picker_open,
        "project":p.project.as_ref().map(|p|&p.dir),"projectFingerprint":p.project.as_ref().map(|p|&p.metadata_hash),
        "screen":p.screen as u8,"playing":p.playing,"position":p.position,"epoch":p.native_epoch,
        "saving":p.saving,"editSeq":p.edit_seq,"savedSeq":p.saved_seq,"notice":p.notice,
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"playing":s.playing,"position":s.position,"graph":s.graph_generation,"lanes":s.observed_lanes})),
        "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "hidden":!w.is_visible()&&!w.is_window_active(),"productionParity":"unqualified native candidate","liveFps":"unmeasured"})
}
fn shot(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&Path,name:&str)->anyhow::Result<()> {
    draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Drive test activated window");
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&state(view,w,cx))?)?;Ok(())
}
fn library(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..5 {
        draw(w,cx);let ui=view.read(cx).library.clone();
        let b=ui.read(cx).drive_bounds(id).ok_or_else(||anyhow::anyhow!("Actual library Drive control missing: {id}"))?;
        if b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height&&b.left()>=px(0.)&&b.right()<=w.viewport_size().width {
            click(w,cx,b.center());return Ok(());
        }
        ui.read(cx).reveal_guide(b);draw(w,cx);
    }
    anyhow::bail!("Actual library Drive control outside viewport: {id}")
}
fn picker(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    draw(w,cx);
    let ui=view.read(cx).project_picker.clone();
    let initial=ui.read(cx).bounds(id).ok_or_else(||anyhow::anyhow!("Actual picker Drive control missing: {id}"))?;
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent {
        position:initial.center(),pressed_button:None,modifiers:Modifiers::default(),
    }),cx);
    // Hover may lift the source small pill by1px or settle a new progress row.
    // Admit the click against the measured hovered layout, not its old bounds.
    draw(w,cx);
    let b=ui.read(cx).bounds(id).ok_or_else(||anyhow::anyhow!("Hovered picker Drive control disappeared: {id}"))?;
    anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=w.viewport_size().height&&b.left()>=px(0.)&&b.right()<=w.viewport_size().width,"Picker control outside viewport: {id} {b:?}");
    let current=ui.read(cx).state(w,cx);
    anyhow::ensure!(current["moving"]==false,"Picker storage move disabled {id}: {current}");
    if id=="picker-drive-signout" {
        anyhow::ensure!(current["drive"]["signedIn"]==true,"Signout admitted against unsigned state: {current}");
    } else {
        anyhow::ensure!(current["drive"]["busy"]==false&&current["drive"]["signingIn"]==false,"Picker action admitted against disabled state: {id}: {current}");
    }
    let position=b.center();
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    Ok(())
}
fn storage(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    for _ in 0..5 {
        draw(w,cx);let ui=view.read(cx).library.clone();let b=ui.read(cx).guides.get("storage").ok_or_else(||anyhow::anyhow!("Actual storage Change action missing"))?;
        if b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height {click(w,cx,b.center());return Ok(());}
        ui.read(cx).reveal_guide(b);draw(w,cx);
    }
    anyhow::bail!("Storage Change action outside viewport")
}
fn songs(view:&Entity<Player>,w:&mut Window,cx:&mut App,library:bool)->anyhow::Result<()> {
    if (view.read(cx).screen==Screen::Library)!=library {
        // The explicit Catalog action toggles the loaded player and library.
        // Exercise its actual mounted keyboard route in both writer/adoption.
        for _ in 0..192 {
            draw(w,cx);
            let activate=view.read(cx).header.read(cx).focused_control(w).as_deref()==Some("header-catalog");
            let stroke=Keystroke::parse(if activate{"enter"}else{"tab"}).unwrap();
            w.dispatch_keystroke(stroke.clone(),cx);
            w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
            if activate {return Ok(());}
        }
        anyhow::bail!("Actual Tab could not reach Header Catalog for Drive navigation");
    }
    Ok(())
}
fn play(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Actual native Play control missing"))?;click(w,cx,b.center());Ok(())
}
fn mute(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    draw(w,cx);let p=view.read(cx);let slot=p.project.as_ref().unwrap().lane_specs.iter().find(|l|l.id=="bass").unwrap().slot;
    let b=p.track_bounds.borrow().get(&format!("mute-{slot}")).copied().ok_or_else(||anyhow::anyhow!("Actual bass M missing"))?;
    anyhow::ensure!(b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height,"Native bass M outside viewport");click(w,cx,b.center());Ok(())
}
fn marker(path:&Path,value:&serde_json::Value)->anyhow::Result<()> {
    let pending=path.with_extension("pending");
    std::fs::write(&pending,serde_json::to_vec(value)?)?;
    std::fs::rename(pending,path)?;Ok(())
}
fn signed_out_focus(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    draw(w,cx);let state=view.read(cx).project_picker.read(cx).state(w,cx);
    anyhow::ensure!(state["focusInside"]==true&&state["focusedControl"]=="picker-drive-connect",
        "Removed Sign out control did not hand focus to the actual Connect control: {state}");
    Ok(())
}
fn request(out:&Path,name:&str,operation:&str)->anyhow::Result<()> {
    std::fs::create_dir_all(out.join("requests"))?;
    marker(&out.join("requests").join(format!("{name}.json")),&serde_json::json!({"operation":operation}))
}
fn badge(view:&Entity<Player>,w:&mut Window,cx:&mut App,dir:&Path)->anyhow::Result<()> {
    draw(w,cx);let library=view.read(cx).library.clone();let rows=library.read(cx).project_snapshot();
    let index=rows.as_array().unwrap().iter().position(|r|r["dir"].as_str()==dir.to_str()).ok_or_else(||anyhow::anyhow!("Blocked native catalog project missing"))?;
    let b=library.read(cx).drive_bounds(&format!("library-drive-badge-{index}")).ok_or_else(||anyhow::anyhow!("Actual blocked Drive badge missing"))?;
    library.read(cx).reveal_guide(b);draw(w,cx);Ok(())
}
pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App) {
 if std::env::var("SINGZ_GPUI_DRIVE_STAGE").is_ok_and(|stage|stage.starts_with("adoption")) {
  adoption::run(handle,view,out,cx);return;
 }
 cx.spawn(async move|cx| {
  let result:anyhow::Result<()>=async {
   std::fs::create_dir_all(&out)?;
   let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap()).canonicalize()?;
   let stage=std::env::var("SINGZ_GPUI_DRIVE_STAGE").unwrap_or_else(|_|"exercise".into());
   let mut authorization=0usize;
   macro_rules! wait {($p:ident,$w:ident,$app:ident=>$condition:expr)=>{{
    let deadline=Instant::now()+Duration::from_secs(25);
    loop {cx.background_executor().timer(Duration::from_millis(15)).await;
     if handle.update(cx,|_,$w,$app|{draw($w,$app);let $p=view.read($app);$condition})? {break;}
     if Instant::now()>=deadline {let current=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Drive wait timeout {}: {}",stringify!($condition),current);}
    }
   }};}
   macro_rules! handshake {($name:expr,$operation:expr)=>{{
    let name=$name;request(&out,&name,$operation)?;
    let deadline=Instant::now()+Duration::from_secs(12);
    loop {cx.background_executor().timer(Duration::from_millis(15)).await;
     if out.join("acks").join(format!("{name}.json")).exists(){break;}
     anyhow::ensure!(Instant::now()<deadline,"Fixture handshake timeout {name}");
    }
   }};}
   macro_rules! auth {()=>{{
    wait!(p,w,app=>p.drive_test_urls.len()>authorization);
    let url=handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls[authorization].clone())?;
    marker(&out.join(format!("authorization-url-{authorization}.json")),&serde_json::json!({"url":url}))?;
    authorization+=1;
    wait!(p,w,app=>p.drive_snapshot.signed_in&&!p.drive_snapshot.signing_in);
   }};}
   macro_rules! saved {()=>{wait!(p,w,app=>!p.saving&&p.edit_seq==p.saved_seq&&p.notice.is_none())};}
   macro_rules! clean {()=>{wait!(p,w,app=>!p.drive_snapshot.busy&&!p.drive_snapshot.signing_in&&p.drive_snapshot.error.is_none()&&p.drive_snapshot.scheduler.phase==sync_scheduler::Phase::Idle&&p.drive_snapshot.scheduler.last_error.is_none()&&p.drive_snapshot.scheduler.last_sync.is_some()&&p.drive_snapshot.scheduler.dirty==0&&p.drive_snapshot.projects.get(&project)==Some(&drive_state::ProjectState::Synced))};}
   macro_rules! signout {($name:expr)=>{{
    let name=$name;
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);marker(&out.join(format!("{name}-before.json")),&state(&view,w,cx))?;picker(&view,w,cx,"picker-drive-signout")})??;
    cx.background_executor().timer(Duration::from_millis(20)).await;
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);marker(&out.join(format!("{name}-after-dispatch.json")),&state(&view,w,cx))})??;
    wait!(p,w,app=>!p.drive_snapshot.signed_in&&!p.drive_snapshot.busy&&p.drive_snapshot.projects.is_empty());
   }};}

   wait!(p,w,app=>p.drive_snapshot.configured&&p.backend.is_some());
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
   wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project)&&p.duration>60.);
   for (width,height) in [(1280.,800.),(1060.,640.)] {
    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
    wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
    let suffix=width as u32;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;wait!(p,w,app=>p.screen==Screen::Library);
    if stage=="restart" {
     wait!(p,w,app=>p.drive_snapshot.signed_in&&p.drive_snapshot.scheduler.last_sync.is_some()&&p.drive_snapshot.projects.get(&project)==Some(&drive_state::ProjectState::Synced));
     anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls.is_empty())?,"Restart unexpectedly required OAuth");
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("restored-{suffix}")))??;
     handle.update(cx,|_,w,cx|storage(&view,w,cx))??;wait!(p,w,app=>p.project_picker_open&&!p.project_picker.read(app).state(w,app)["loading"].as_bool().unwrap());
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("restored-picker-{suffix}")))??;
     if suffix==1060 {signout!("signout-final");
      handle.update(cx,|_,w,cx|signed_out_focus(&view,w,cx))??;
      handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"signed-out-final"))??;
     }
     handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.project_picker_open);
     continue;
    }
    handshake!(format!("arm-first-{suffix}"),"arm-upload");
    // Source App.tsx toggleCatalog and enter_desktop_catalog pause transport
    // when Catalog covers it. Playback-under-upload is exercised explicitly
    // on Player after confirming that Catalog pause below.
    handle.update(cx,|_,w,cx|songs(&view,w,cx,false))??;wait!(p,w,app=>p.screen==Screen::Player);
    if !handle.update(cx,|_,_,cx|view.read(cx).playing)? {handle.update(cx,|_,w,cx|play(&view,w,cx))??;}
    wait!(p,w,app=>p.playing&&p.position>0.1&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
    if suffix==1060 {
     // The second size reuses real remote data. Two actual mix edits/Saves
     // preserve the baseline mix and advance savedAt, requiring a fresh upload.
     for _ in 0..2 {
      handle.update(cx,|_,w,cx|mute(&view,w,cx))??;wait!(p,w,app=>p.edit_seq!=p.saved_seq);
      handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;saved!();
     }
    }
    let catalog_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;
    wait!(p,w,app=>p.screen==Screen::Library&&!p.playing&&p.native_play_intent.is_none()&&p.native_epoch==catalog_epoch
        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
    if suffix==1280 {
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("connect-{suffix}")))??;
     handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-connect"))??;
     // Actual pointer focus belonged to Connect. Signing in disables that
     // action before OAuth completes; ordinary search must own a mounted path.
     wait!(p,w,app=>p.drive_snapshot.signing_in&&!p.drive_snapshot.signed_in
        &&p.library.read(app).search_focused(w,app)&&p.library.read(app).drive_state(w)["validFocus"]==true);
     handle.update(cx,|_,w,cx|marker(&out.join(format!("signin-focus-recovered-{suffix}.json")),&state(&view,w,cx)))??;
    } else {
     handle.update(cx,|_,w,cx|storage(&view,w,cx))??;wait!(p,w,app=>p.project_picker_open&&!p.project_picker.read(app).state(w,app)["loading"].as_bool().unwrap());
     handle.update(cx,|_,w,cx|picker(&view,w,cx,"picker-drive-connect"))??;
    }
    auth!();
    if handle.update(cx,|_,_,cx|view.read(cx).project_picker_open)? {
     wait!(p,w,app=>p.drive_snapshot.busy);
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let state=view.read(cx).project_picker.read(cx).state(w,cx);
      anyhow::ensure!(state["focusInside"]==true,"Busy Connect/Sync control lost the actual modal focus path: {state}");Ok(())})??;
     handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.project_picker_open);
    }
    handshake!(format!("first-held-{suffix}"),"upload-held");
    wait!(p,w,app=>p.drive_snapshot.busy&&p.drive_snapshot.capture_project.is_none()&&p.screen==Screen::Library
        &&!p.playing&&p.native_play_intent.is_none()&&p.native_epoch==catalog_epoch
        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)&&p.library.read(app).drive_state(w)["validFocus"]==true);
    handle.update(cx,|_,w,cx|marker(&out.join(format!("catalog-paused-held-{suffix}.json")),&state(&view,w,cx)))??;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("uploading-{suffix}")))??;
    let (position,epoch)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_epoch)})?;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,false))??;wait!(p,w,app=>p.screen==Screen::Player);
    handle.update(cx,|_,w,cx|play(&view,w,cx))??;
    wait!(p,w,app=>p.screen==Screen::Player&&p.playing&&p.position>position+0.25&&p.native_epoch==epoch
        &&p.drive_snapshot.busy&&p.drive_snapshot.capture_project.is_none()
        &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
    handle.update(cx,|_,w,cx|marker(&out.join(format!("playing-held-upload-{suffix}.json")),&state(&view,w,cx)))??;
    handle.update(cx,|_,w,cx|mute(&view,w,cx))??;wait!(p,w,app=>p.edit_seq!=p.saved_seq);
    handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"});})?;saved!();
    let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?;
    anyhow::ensure!(saved["settings"]["tracks"]["bass"]["muted"]==true,"Actual CmdS did not publish latest M edit");
    std::fs::write(out.join(format!("during-upload-save-{suffix}.json")),serde_json::to_vec_pretty(&saved)?)?;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("playing-upload-save-{suffix}")))??;
    handshake!(format!("release-first-{suffix}"),"release-upload");
    wait!(p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.scheduler.dirty!=0);
    handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;wait!(p,w,app=>p.screen==Screen::Library);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("pending-followup-{suffix}")))??;
    let first_completed_sync=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.scheduler.last_sync)?;
    clean!();
    wait!(p,w,app=>p.drive_snapshot.scheduler.last_sync>first_completed_sync);
    let metadata_hash=crate::project_store::fingerprint(&std::fs::read(project.join("project.json"))?);
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).project.as_ref().unwrap().metadata_hash==metadata_hash,"Drive maintenance stranded the loaded project CAS fingerprint");Ok(())})??;
    handshake!(format!("followup-proof-{suffix}"),"remote-proof");
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("synced-{suffix}")))??;
    // Real cancellation retains dirty intent. Catalog is paused by policy;
    // resuming on Player must still advance the same native session afterward.
    handshake!(format!("arm-cancel-{suffix}"),"arm-upload");
    handle.update(cx,|_,w,cx|songs(&view,w,cx,false))??;wait!(p,w,app=>p.screen==Screen::Player);
    handle.update(cx,|_,w,cx|mute(&view,w,cx))??;wait!(p,w,app=>p.edit_seq!=p.saved_seq);
    handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;saved!();
    let cancel_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;
    wait!(p,w,app=>p.screen==Screen::Library&&!p.playing&&p.native_play_intent.is_none()&&p.native_epoch==cancel_epoch
        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-sync"))??;
    handshake!(format!("cancel-held-{suffix}"),"upload-held");
    // Sync owned actual pointer focus before the worker entered busy state.
    // The disabled primary must hand it to an enabled mounted Drive action.
    wait!(p,w,app=>p.drive_snapshot.busy&&p.library.read(app).drive_state(w)["validFocus"]==true
        &&matches!(p.library.read(app).drive_state(w)["focusedControl"].as_str(),Some("library-drive-cancel"|"library-drive-browse")));
    handle.update(cx,|_,w,cx|marker(&out.join(format!("busy-focus-recovered-{suffix}.json")),&state(&view,w,cx)))??;
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-cancel"))??;
    wait!(p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.scheduler.dirty!=0&&p.drive_snapshot.progress.contains("Sync paused")
        &&p.screen==Screen::Library&&!p.playing&&p.native_play_intent.is_none()&&p.native_epoch==cancel_epoch
        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)
        &&p.library.read(app).drive_state(w)["validFocus"]==true&&p.library.read(app).drive_state(w)["focusedControl"]=="library-drive-sync");
    handle.update(cx,|_,w,cx|marker(&out.join(format!("cancel-focus-recovered-{suffix}.json")),&state(&view,w,cx)))??;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("cancelled-{suffix}")))??;
    let cancel_position=handle.update(cx,|_,_,cx|view.read(cx).position)?;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,false))??;wait!(p,w,app=>p.screen==Screen::Player);
    handle.update(cx,|_,w,cx|play(&view,w,cx))??;
    wait!(p,w,app=>p.screen==Screen::Player&&p.playing&&p.position>cancel_position+0.25&&p.native_epoch==cancel_epoch
        &&!p.drive_snapshot.busy&&p.drive_snapshot.scheduler.dirty!=0
        &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
    handle.update(cx,|_,w,cx|marker(&out.join(format!("playing-after-cancel-{suffix}.json")),&state(&view,w,cx)))??;
    handshake!(format!("release-cancel-{suffix}"),"release-upload");
    let cancelled_sync=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.scheduler.last_sync)?;
    handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;
    wait!(p,w,app=>p.screen==Screen::Library&&!p.playing&&p.native_play_intent.is_none()&&p.native_epoch==cancel_epoch
        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-sync"))??;clean!();
    wait!(p,w,app=>p.drive_snapshot.scheduler.last_sync>cancelled_sync);
    clean!();
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-log"))??;wait!(p,w,app=>p.screen==Screen::Log);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("sync-log-{suffix}")))??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>p.screen==Screen::Library);
    handle.update(cx,|_,w,cx|storage(&view,w,cx))??;wait!(p,w,app=>p.project_picker_open&&!p.project_picker.read(app).state(w,app)["loading"].as_bool().unwrap());
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
     let picker=view.read(cx).project_picker.clone();let mut reached=false;
     for _ in 0..64 {draw(w,cx);key(w,cx,"tab");let state=picker.read(cx).state(w,cx);anyhow::ensure!(state["focusInside"]==true,"Tab escaped actual Drive picker");if state["focusedControl"]=="picker-drive-sync" {reached=true;break;}}
     anyhow::ensure!(reached,"Tab never reached actual Sync to Google Drive");Ok(())
    })??;
    // A newer snapshot may only acknowledge queue admission or the scheduler's
    // Syncing phase. Require this actual request's completed sync, rather than
    // accepting the previous clean receipt before the worker starts its run.
    let last_sync=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.scheduler.last_sync)?;
    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
    wait!(p,w,app=>p.drive_snapshot.scheduler.last_sync>last_sync&&!p.drive_snapshot.busy&&!p.drive_snapshot.signing_in&&p.drive_snapshot.error.is_none()&&p.drive_snapshot.scheduler.last_error.is_none()&&p.drive_snapshot.scheduler.phase==sync_scheduler::Phase::Idle&&p.drive_snapshot.scheduler.dirty==0);
    clean!();
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("picker-synced-{suffix}")))??;
    if suffix==1280 {
     signout!(&format!("signout-{suffix}"));
     handle.update(cx,|_,w,cx|signed_out_focus(&view,w,cx))??;
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("picker-signed-out-{suffix}")))??;
    }
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.project_picker_open);
   }
   if stage=="exercise" {
    handshake!("install-blocked".to_string(),"install-blocked");
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-sync"))??;
    let root=project.parent().unwrap();let broken=root.join("Broken graph fixture");let empty=root.join("Empty native fixture");
    wait!(p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.projects.get(&broken)==Some(&drive_state::ProjectState::Blocked)&&p.drive_snapshot.projects.get(&empty)==Some(&drive_state::ProjectState::Blocked));
    wait!(p,w,app=>p.library.read(app).project_snapshot().as_array().unwrap().iter().any(|row|row["dir"].as_str()==broken.to_str()));
    handle.update(cx,|_,w,cx|badge(&view,w,cx,&broken))??;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"blocked-real-projects"))??;
    handshake!("blocked-proof".to_string(),"remote-proof");
   }
   std::fs::write(out.join("final-project.json"),std::fs::read(project.join("project.json"))?)?;
   std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"stage":stage,"sizes":2,"actualOAuth":stage=="exercise","actualUploadSaveFollowup":stage=="exercise","actualCancel":stage=="exercise","actualLibraryDriveFocusRecovery":stage=="exercise","actualKeyboardPicker":stage=="exercise","restoredAccountReceipt":stage=="restart","finalSignout":stage=="restart","hidden":true,"muted":true,"noNode":true,"visualParity":"unqualified candidate"}))?)?;
   Ok(())
  }.await;
  if let Err(error)=result {
   let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));
   let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));eprintln!("DRIVE_UI failed: {error:#}");
  }
  let _=cx.update(|cx|cx.quit());
 }).detach();
}

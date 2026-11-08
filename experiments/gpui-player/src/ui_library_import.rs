//! Hidden real LibraryImport controls and native filesystem handoff checks.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse(value).unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    view.read(cx).library_import.read(cx).state(w, cx)
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .library_import
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing import control {id}"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Import control {id} clipped: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("Header {id} not measured"))?;
    click(w, cx, b.center());
    Ok(())
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Import dialog stole focus or became visible"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let toast=p.success_toast.read(cx).state();
    let value = serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"importOpen":p.library_import_open,"import":state(view,w,cx),"pending":p.import_pending.is_some(),"project":p.project.as_ref().map(|p|p.dir.clone()),"position":p.position,"playing":p.playing,"epoch":p.native_epoch,"gain":p.gain,"master":p.master_volume,"notice":p.notice,"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"visualReference":"candidate only; matched production reference absent","liveFps":"unmeasured: hidden window","toast":{"visible":toast.visible,"text":toast.text,"sequence":toast.sequence,"ageSeconds":toast.age_seconds,"opacity":toast.opacity},"playerFocused":p.focus_handle.is_focused(w)});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}
fn modify_json(path: &Path, key: &str, value: serde_json::Value) -> anyhow::Result<()> {
    let mut raw: serde_json::Value = serde_json::from_slice(&std::fs::read(path)?)?;
    raw[key] = value;
    std::fs::write(path, serde_json::to_vec_pretty(&raw)?)?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
  let result:anyhow::Result<()>=async{
   std::fs::create_dir_all(&out)?;let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_LIBRARY_IMPORT_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing import fixtures"))?).canonicalize()?;
   let gate=root.join("import.gate");let ready=gate.with_extension("ready");
   macro_rules! wait {($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ok=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;if ok{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Import timeout: {} actual {actual}",stringify!($predicate));}}}};}
   macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name))??;};}
   macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
   macro_rules! open_project {($name:expr)=>{{let path=root.join("external").join($name);handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;p.open_project(path.clone(),cx);}))?;wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==path));}};}
   macro_rules! dialog {()=>{{handle.update(cx,|_,w,cx|header(&view,w,cx,"import"))??;wait!(p,w,app=>p.library_import_open);handle.update(cx,|_,_,cx|view.read(cx).library_import.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx)))?;}};}
   macro_rules! hold {()=>{{let _=std::fs::remove_file(&ready);std::fs::write(&gate,"hold")?;}};}
   macro_rules! release {()=>{{std::fs::remove_file(&gate)?;}};}
   for (width,height) in [(1280.,800.),(1060.,640.)]{
    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;open_project!("Copy project");dialog!();
    for _ in 0..8{handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Tab escaped import dialog");Ok(())})??;}
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Reverse Tab escaped import dialog");Ok(())})??;
    shot!(&format!("idle-{}",width as i32));handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.library_import_open);
    dialog!();press!("library-import-close");wait!(p,w,app=>!p.library_import_open);
   }
   handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;open_project!("Copy project");
   // Unsaved live mix is host-owned and must survive the identity handoff.
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.gain[5]=42;p.sync_lane(5,cx);p.native_transport(transport::TransportEvent::Volume(0.6),cx);p.position=0.75;p.seek_native(cx);}))?;
   wait!(p,w,app=>p.pending_seek.is_none()&&p.native_anchor.is_some_and(|(t,_)|(t-0.75).abs()<0.001));
   handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,"space");})?;wait!(p,w,app=>p.playing);
   dialog!();hold!();
   let old_status=root.join("old-status.gate");let old_status_ready=old_status.with_extension("ready");
   let _=std::fs::remove_file(&old_status_ready);std::fs::write(&old_status,"hold outstanding old-epoch status read")?;
   wait!(p,w,app=>old_status_ready.is_file());
   let old_epoch=std::fs::read_to_string(&old_status_ready)?.trim().parse::<u64>()?;
   let before_position=handle.update(cx,|_,w,cx|->anyhow::Result<f32>{
       draw(w,cx);anyhow::ensure!(view.read(cx).native_epoch==old_epoch,"Status gate did not capture current old epoch");
       let position=view.read(cx).position;press(&view,w,cx,"library-import-copy")?;Ok(position)})??;
   wait!(p,w,app=>p.import_pending.is_some()&&p.native_epoch!=old_epoch);
   let copy_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
   std::fs::remove_file(&old_status)?;
   wait!(p,w,app=>p.import_pending.is_some()&&ready.is_file());
   let prepare_position=handle.update(cx,|_,_,cx|view.read(cx).position)?;
   let continuity_baseline=before_position.max(prepare_position);
   for id in ["library-import-close","library-import-copy","library-import-move"]{press!(id);}
   handle.update(cx,|_,w,cx|{key(w,cx,"escape");key(w,cx,"tab");click(w,cx,point(px(5.),px(5.)));})?;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(p.library_import_open&&p.import_pending.is_some()&&state(&view,w,cx)["busy"]==true&&state(&view,w,cx)["focusInside"]==true,"Busy import dismissed, duplicated or lost modal focus");Ok(())})??;
   shot!("busy-copy-1280");
   // A real helper keeps playing while the worker is held. Allow enough
   // audio time to distinguish a continuous copy from a paused/reopened one.
   cx.background_executor().timer(Duration::from_millis(350)).await;
   // Change preferences externally only after the operation has captured its
   // destination. It must finish in the initially selected root.
   modify_json(&root.join("prefs/library.json"),"projectsRoot",serde_json::json!(root.join("alternate-library")))?;
   release!();let copied=root.join("library/Copy project");
   wait!(p,w,app=>p.import_pending.is_none()&&!p.loading&&!p.library_import_open&&p.project.as_ref().is_some_and(|p|p.dir==copied)&&p.playing);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);let toast=p.success_toast.read(cx).state();
       std::fs::write(out.join("copy-continuity.json"),serde_json::to_vec_pretty(&serde_json::json!({"oldEpoch":old_epoch,"copyEpoch":copy_epoch,"beforeCopyPosition":before_position,"preparePosition":prepare_position,"baseline":continuity_baseline,"heldMilliseconds":350,"receiptPosition":p.position,"playing":p.playing,"gain":p.gain[5],"master":p.master_volume,"toastVisible":toast.visible,"playerFocused":p.focus_handle.is_focused(w)}))?)?;
       anyhow::ensure!(p.gain[5]==42&&p.master_volume==0.6&&p.position>continuity_baseline+0.15&&p.position<continuity_baseline+8.,"Copy reset playing transport/mix/position or failed to advance during held transfer");
       anyhow::ensure!(p.notice.is_none()&&toast.visible&&p.focus_handle.is_focused(w),"Import success toast blocked the player or stole focus");Ok(())})??;
   handle.update(cx,|_,_,cx|view.read(cx).success_toast.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx)))?;
   shot!("copied-playing-1280");
   // Owned Save must target the imported project, never the external original.
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;cx.notify();}))?;
   handle.update(cx,|_,w,cx|header(&view,w,cx,"save"))??;
   wait!(p,w,app=>!p.saving&&!p.loading&&p.source_job.is_none()&&p.edit_seq==p.saved_seq&&p.project.as_ref().is_some_and(|p|p.dir==copied));
   shot!("saved-imported-1280");
   wait!(p,w,app=>!p.success_toast.read(app).state().visible);
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let toast=view.read(cx).success_toast.read(cx).state();
       anyhow::ensure!(toast.age_seconds>=5.9&&toast.age_seconds<8.,"Success toast did not expire on its source six-second timer");Ok(())})??;
   shot!("success-toast-expired-1280");
   // Restore isolated selected root for independent subsequent cases.
   modify_json(&root.join("prefs/library.json"),"projectsRoot",serde_json::json!(root.join("library")))?;
   handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;open_project!("Move project");
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.gain[5]=37;p.sync_lane(5,cx);p.native_transport(transport::TransportEvent::Volume(0.65),cx);p.position=1.25;p.seek_native(cx);}))?;
   wait!(p,w,app=>p.pending_seek.is_none()&&p.native_anchor.is_some_and(|(t,_)|(t-1.25).abs()<0.001));
   dialog!();hold!();press!("library-import-move");wait!(p,w,app=>p.import_pending.is_some()&&ready.is_file());shot!("busy-move-1060");release!();let moved=root.join("library/Move project");
   wait!(p,w,app=>p.import_pending.is_none()&&!p.loading&&!p.library_import_open&&p.project.as_ref().is_some_and(|p|p.dir==moved));
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.playing&&(p.position-1.25).abs()<0.01&&p.gain[5]==37&&p.master_volume==0.65,"Move reset paused transport/mix/position");Ok(())})??;shot!("moved-paused-1060");
   open_project!("Collision project");dialog!();press!("library-import-copy");wait!(p,w,app=>p.import_pending.is_none()&&p.notice.is_some());
   anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().dir==root.join("external/Collision project"))?,"Collision reanchored active project");shot!("collision-refused-1060");
   open_project!("Changed project");dialog!();hold!();press!("library-import-copy");wait!(p,w,app=>p.import_pending.is_some()&&ready.is_file());
   modify_json(&root.join("external/Changed project/project.json"),"externalChange",serde_json::json!("preserve external edit"))?;release!();
   wait!(p,w,app=>p.import_pending.is_none()&&p.notice.is_some());anyhow::ensure!(!root.join("library/Changed project").exists(),"External edit was imported despite fingerprint conflict");shot!("external-edit-refused-1060");
   // A postcommit receipt gate separates accepted publication from its UI
   // receipt, so navigating through the production loader can supersede it.
   open_project!("Stale project");dialog!();let receipt=root.join("receipt.gate");let receipt_ready=receipt.with_extension("ready");let _=std::fs::remove_file(&receipt_ready);std::fs::write(&receipt,"hold")?;
   press!("library-import-copy");wait!(p,w,app=>p.import_pending.is_some()&&receipt_ready.is_file());
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;p.open_project(root.join("external/Other project"),cx);}))?;
   std::fs::remove_file(&receipt)?;
   wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==root.join("external/Other project")));
   for _ in 0..15{cx.background_executor().timer(Duration::from_millis(25)).await;handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.as_ref().is_some_and(|p|p.dir==root.join("external/Other project")),"Stale import receipt replaced newer project");Ok(())})??;}
   shot!("stale-receipt-kept-other-1060");
   std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"twoSizes":true,"escapeClose":true,"focusTrap":true,"busyDismissalBlocked":true,"copy":true,"move":true,"playingMixPositionPreserved":true,"copyAudioAdvancedWhileHeld":true,"oldStatusRaceExercised":true,"successToastNonblocking":true,"successToastSixSecondExpiry":true,"pausedMixPositionPreserved":true,"capturedRootStable":true,"ownedSaveNewDirectory":true,"collisionRefused":true,"externalEditRefused":true,"staleNavigationIgnored":true,"hidden":true,"muted":true}))?)?;Ok(())
  }.await;
  match result{Ok(())=>eprintln!("NATIVE_LIBRARY_IMPORT passed"),Err(error)=>{eprintln!("NATIVE_LIBRARY_IMPORT failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));}}
  let _=cx.update(|cx|cx.quit());
 }).detach();
}

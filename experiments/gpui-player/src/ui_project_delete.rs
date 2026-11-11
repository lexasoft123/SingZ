//! Hidden actual library delete controls, worker inspection and durable outcomes.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    let p = view.read(cx);
    serde_json::json!({"dialog":p.project_delete.read(cx).state(w,cx),"target":p.delete_target.as_ref().map(|t|t.dir.clone()),"inspectPending":p.delete_inspect_pending.as_ref().map(|(serial,dir)|serde_json::json!({"serial":serial,"dir":dir})),"deletePending":p.delete_pending.as_ref().map(|d|serde_json::json!({"serial":d.serial,"epoch":d.epoch,"loaded":d.loaded})),"deleteSerial":p.delete_serial,"project":p.project.as_ref().map(|s|s.dir.clone()),"loadedSong":p.loaded_song,"playing":p.playing,"position":p.position,"nativeEpoch":p.native_epoch,"nativeAnchorAgeSeconds":p.native_anchor.map(|(_,at)|at.elapsed().as_secs_f64()),"screen":p.screen as u8,"notice":p.notice,"error":p.library.read(cx).delete_error(),"projects":p.library.read(cx).project_snapshot()})
}
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(value).unwrap(), cx);
    draw(w, cx);
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .project_delete
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Delete control {id} unmeasured"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.top() >= px(0.)
            && b.bottom() <= w.viewport_size().height
            && b.left() >= px(0.)
            && b.right() <= w.viewport_size().width,
        "Delete control {id} outside viewport: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn library_target(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    dir: &Path,
    delete: bool,
) -> anyhow::Result<()> {
    for _ in 0..8 {
        draw(w, cx);
        if let Some(b) = view.read(cx).library.read(cx).project_delete_bounds(dir) {
            if b.top() >= px(52.) && b.bottom() <= w.viewport_size().height {
                // The real delete control sits at the right of the same 68px card.
                // Its neighbor 48px to the left is the actual native card Open surface.
                let at = if delete {
                    b.center()
                } else {
                    point(b.left() - px(48.), b.center().y)
                };
                click(w, cx, at);
                return Ok(());
            }
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width / 2.,
                    w.viewport_size().height - px(90.),
                ),
                delta: ScrollDelta::Pixels(point(px(0.), px(-600.))),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Native library target is not visible: {}", dir.display())
}
fn play(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .bounds("transport-play")
        .ok_or_else(|| anyhow::anyhow!("Native Play control unmeasured"))?;
    click(w, cx, b.center());
    Ok(())
}
fn songs(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    super::ui_training_run::header_control(view, w, cx, "songs")
}
fn ensure_library(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    if view.read(cx).screen != Screen::Library { songs(view, w, cx)?; }
    Ok(())
}

fn gate(path: &Path) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(path.with_extension("ready"));
    std::fs::write(path, b"hold actual delete before hiding")?;
    Ok(())
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    viewport: (f32, f32),
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        w.viewport_size() == size(px(viewport.0), px(viewport.1)),
        "Wrong native delete viewport"
    );
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Delete test activated window"
    );
    let image = w.render_to_image()?;
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (viewport.0 * scale).round() as u32
            && image.height() == (viewport.1 * scale).round() as u32,
        "Native delete raster differs from viewport"
    );
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"viewport":[viewport.0,viewport.1],"scale":scale,"delete":state(view,w,cx),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"visualReference":"candidate only; matched production reference absent","copyDeviation":"Opened project deletion stops playback and closes it; inline delete errors also visible offline.","liveFps":"unmeasured: hidden event-driven rendering"}),
        )?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let mut viewport=(1280.,800.);
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;
  let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_PROJECT_DELETE_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing isolated delete fixtures"))?).canonicalize()?;
  let prepare=PathBuf::from(std::env::var_os("SINGZ_GPUI_DELETE_PREPARE_GATE").ok_or_else(||anyhow::anyhow!("Missing native delete gate"))?);
  macro_rules! wait {($p:ident,$w:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(15);loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$condition})?;if ready{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Native delete wait timeout {}; {actual}",stringify!($condition));}}}};}
  macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
  macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name,viewport))??;};}
  macro_rules! ask {($dir:expr)=>{{handle.update(cx,|_,w,cx|library_target(&view,w,cx,$dir,true))??;wait!(p,w,app=>p.delete_inspect_pending.is_none()&&p.project_delete.read(app).is_open());handle.update(cx,|_,w,cx|{pinned(&view,w,cx);})?;}};}
  for (width,height) in [(1280.,800.),(1060.,640.)]{
   viewport=(width,height);let current=root.join(format!("current-{}",width as u32));let other=root.join(format!("other-{}",width as u32));
   handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height))&&p.library.read(app).project_snapshot().as_array().is_some_and(|rows|rows.iter().any(|row|row["dir"].as_str()==current.to_str())));
   handle.update(cx,|_,w,cx|library_target(&view,w,cx,&current,false))??;
   wait!(p,w,app=>!p.loading&&p.screen==Screen::Player&&p.project.as_ref().is_some_and(|s|s.dir==current)&&p.duration>100.);
   handle.update(cx,|_,w,cx|play(&view,w,cx))??;wait!(p,w,app=>p.playing&&p.position>0.1);
   handle.update(cx,|_,w,cx|songs(&view,w,cx))??;wait!(p,w,app=>p.screen==Screen::Library);
   let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
   ask!(&other);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);let state=p.project_delete.read(cx).state(w,cx);anyhow::ensure!(p.native_epoch==epoch&&p.playing&&p.project.as_ref().is_some_and(|s|s.dir==current),"Delete click opened the identically named other project");anyhow::ensure!(state["details"]["opened"]==false&&state["focusedControl"]=="project-delete-keep","Other project mislabeled as loaded or safe focus missing: {state}");Ok(())})??;
   shot!(&format!("confirm-other-{}",width as u32));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{for expected in ["project-delete-confirm","project-delete-keep"]{key(w,cx,"tab");anyhow::ensure!(state(&view,w,cx)["dialog"]["focusedControl"]==expected,"Delete Tab escaped modal");}key(w,cx,"shift-tab");anyhow::ensure!(state(&view,w,cx)["dialog"]["focusedControl"]=="project-delete-confirm","Reverse Tab failed");key(w,cx,"tab");key(w,cx,"enter");Ok(())})??;
   wait!(p,w,app=>!p.project_delete.read(app).is_open());anyhow::ensure!(other.is_dir(),"Keep removed project");
   ask!(&other);handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.project_delete.read(app).is_open());
   ask!(&other);handle.update(cx,|_,w,cx|click(w,cx,point(px(5.),px(5.))))?;wait!(p,w,app=>!p.project_delete.read(app).is_open());anyhow::ensure!(other.is_dir(),"Dismissal deleted native project");
   ask!(&other);gate(&prepare)?;press!("project-delete-confirm");wait!(p,w,app=>p.delete_pending.is_some()&&prepare.with_extension("ready").exists());
   let (serial,position,anchor)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.delete_serial,p.position,p.native_anchor.map(|(_,at)|at))})?;
   for id in ["project-delete-keep","project-delete-confirm"]{press!(id);}
   handle.update(cx,|_,w,cx|{key(w,cx,"escape");click(w,cx,point(px(5.),px(5.)));})?;
   wait!(p,w,app=>p.position>position+0.25&&p.native_anchor.map(|(_,at)|at)>anchor);
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.delete_serial==serial&&p.delete_pending.is_some()&&p.project_delete.read(cx).is_open()&&p.playing&&p.native_epoch==epoch,"Busy delete dismissed or disturbed unrelated native playback");Ok(())})??;
   shot!(&format!("busy-other-{}",width as u32));std::fs::remove_file(&prepare)?;
   wait!(p,w,app=>p.delete_pending.is_none()&&!p.project_delete.read(app).is_open()&&!other.exists()&&p.playing&&p.project.as_ref().is_some_and(|s|s.dir==current));
   // Confirmed loaded deletion releases audio first. A changed confirmation
   // snapshot must fail, preserve the new metadata, and recover only paused.
   ask!(&current);gate(&prepare)?;press!("project-delete-confirm");wait!(p,w,app=>p.delete_pending.is_some()&&prepare.with_extension("ready").exists());
   let meta_path=current.join("project.json");let mut changed:serde_json::Value=serde_json::from_slice(&std::fs::read(&meta_path)?)?;changed["externalDeleteFixture"]=serde_json::json!(format!("external-{}",width as u32));std::fs::write(&meta_path,serde_json::to_vec_pretty(&changed)?)?;std::fs::remove_file(&prepare)?;
   wait!(p,w,app=>p.delete_pending.is_none()&&!p.project_delete.read(app).is_open()&&!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==current)&&!p.playing&&p.library.read(app).delete_error().is_some());
   anyhow::ensure!(current.is_dir()&&serde_json::from_slice::<serde_json::Value>(&std::fs::read(&meta_path)?)?==changed,"Conflict lost external metadata or native project");
   std::fs::write(out.join(format!("conflict-preserved-{}.json",width as u32)),std::fs::read(&meta_path)?)?;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Library,"Failed loaded deletion left the source catalog");ensure_library(&view,w,cx)?;Ok(())})??;wait!(p,w,app=>p.screen==Screen::Library);shot!(&format!("conflict-inline-{}",width as u32));
   // Use the same real writer lease the backend honors, acquired only after
   // the ordinary-file inspection has produced the displayed confirmation.
   ask!(&current);let lock_file=std::fs::OpenOptions::new().read(true).write(true).create(true).truncate(false).open(current.join(".singz-native-write.lock"))?;let writer=crate::file_lease::Lease::acquire(lock_file)?;
   press!("project-delete-confirm");wait!(p,w,app=>p.delete_pending.is_none()&&!p.project_delete.read(app).is_open()&&!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==current)&&!p.playing&&p.library.read(app).delete_error().is_some());drop(writer);
   anyhow::ensure!(current.is_dir()&&serde_json::from_slice::<serde_json::Value>(&std::fs::read(&meta_path)?)?==changed,"Busy-writer refusal mutated native project");
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Library,"Failed loaded deletion left the source catalog");ensure_library(&view,w,cx)?;Ok(())})??;wait!(p,w,app=>p.screen==Screen::Library);shot!(&format!("writer-refused-{}",width as u32));
   // Resume from the actual native Player transport, then delete that exact
   // currently loaded directory. The late audio status must not resurrect it.
   handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>p.screen==Screen::Player);handle.update(cx,|_,w,cx|play(&view,w,cx))??;wait!(p,w,app=>p.playing);
   handle.update(cx,|_,w,cx|songs(&view,w,cx))??;wait!(p,w,app=>p.screen==Screen::Library);ask!(&current);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["dialog"]["details"]["opened"]==true,"Loaded delete confirmation omitted stop/close note");Ok(())})??;
   shot!(&format!("confirm-loaded-{}",width as u32));press!("project-delete-confirm");
   wait!(p,w,app=>p.delete_pending.is_none()&&!p.project_delete.read(app).is_open()&&!current.exists()&&p.project.is_none()&&!p.loaded_song&&!p.playing&&p.screen==Screen::Library);
   cx.background_executor().timer(Duration::from_millis(350)).await;
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.is_none()&&!p.loaded_song&&!p.playing&&!p.loading&&p.notice.is_none(),"Deleted project resurrected or opened an error modal");Ok(())})??;shot!(&format!("deleted-loaded-{}",width as u32));
  }
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"sameTitleDirectoryIdentity":true,"actualCardOpen":true,"deleteClickDoesNotOpen":true,"keepEscapeScrim":true,"focusTrap":true,"busyGuards":true,"unrelatedPlaybackStatusAdvances":true,"actualOtherDeleted":true,"metadataConflictPreserved":true,"loadedFailurePaused":true,"writerRefusal":true,"inlineFailure":true,"loadedDeleteStopsClears":true,"lateAudioCannotResurrect":true,"twoSizes":true,"hidden":true}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("PROJECT_DELETE passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",viewport));eprintln!("PROJECT_DELETE failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
 }).detach();
}
fn pinned(view: &Entity<Player>, w: &mut Window, cx: &mut App) {
    view.read(cx)
        .project_delete
        .clone()
        .update(cx, |d, cx| d.set_animation_time(Some(0.25), cx));
    draw(w, cx);
}

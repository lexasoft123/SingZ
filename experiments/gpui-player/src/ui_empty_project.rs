//! Actual hidden final-track removal, durable empty documents and fresh audio.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn key(w: &mut Window, cx: &mut App, key: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
    draw(w, cx);
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("Missing header {id}"))?;
    click(w, cx, b.center());
    Ok(())
}
fn training_button(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    for _ in 0..10 {
        draw(w, cx);
        let b = view.read(cx).training.read(cx).bounds(id);
        if let Some(b) = b {
            if b.top() >= px(52.) && b.bottom() <= w.viewport_size().height {
                click(w, cx, b.center());
                return Ok(());
            }
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width - px(100.),
                    w.viewport_size().height - px(140.),
                ),
                delta: ScrollDelta::Pixels(point(px(0.), px(-450.))),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Training control {id} unreachable")
}
fn import_button(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .library_import
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing import {id}"))?;
    anyhow::ensure!(
        b.top() >= px(0.) && b.bottom() <= w.viewport_size().height,
        "Import button clipped"
    );
    click(w, cx, b.center());
    Ok(())
}
fn play(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .bounds("transport-play")
        .ok_or_else(|| anyhow::anyhow!("Missing Play"))?;
    click(w, cx, b.center());
    Ok(())
}
fn empty(p: &Player) -> bool {
    p.project.as_ref().is_some_and(|s| {
        s.empty_tracks && !s.has_audio() && s.lanes.is_empty() && s.lane_specs.is_empty()
    }) && p.loaded_song
        && p.duration == 0.
        && p.position == 0.
        && !p.playing
        && !p.looping
        && p.native_graph == 0
        && p.view_start == 0.
        && p.view_end == 1.
        && p.pending_seek.is_none()
        && p.native_loop.is_none()
        && p.last_playback_status.as_ref().is_some_and(|s| {
            s.empty_project
                && s.graph_generation == 0
                && s.lane_revision == p.native_lane_revision
                && s.physical_output_released
        })
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
        "Empty test activated window"
    );
    let p = view.read(cx);
    anyhow::ensure!(
        [p.duration, p.position, p.view_start, p.view_end]
            .iter()
            .all(|n| n.is_finite()),
        "Nonfinite empty timeline"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"project":p.project.as_ref().map(|s|s.dir.clone()),"emptyDocument":p.project.as_ref().map(|s|s.empty_tracks),"hasAudio":p.project.as_ref().map(|s|s.has_audio()),"lanes":p.project.as_ref().map(|s|&s.lane_specs),"duration":p.duration,"position":p.position,"playing":p.playing,"view":[p.view_start,p.view_end],"nativeGraph":p.native_graph,"laneRevision":p.native_lane_revision,"status":p.last_playback_status.as_ref().map(|s|serde_json::json!({"empty":s.empty_project,"revision":s.lane_revision,"physicalReleased":s.physical_output_released,"graph":s.graph_generation,"trainingOnly":s.training_only,"cueActive":s.cue.active})),"dirty":p.edit_seq!=p.saved_seq,"saving":p.saving,"editSeq":p.edit_seq,"savedSeq":p.saved_seq,"rootFocused":p.focus_handle.is_focused(w),"focusInsideRoot":p.focus_handle.contains_focused(w,cx),"headerFocused":p.header.read(cx).focused_control(w),"headerEditing":p.header.read(cx).is_editing(),"importState":p.library_import.read(cx).state(w,cx),"trackRename":p.track_rename.as_ref().map(|(epoch,id)|serde_json::json!([epoch,id])),"sourceJob":p.source_job,"rateBusy":p.rate_busy(),"metronomePending":p.metronome_pending.is_some(),"metronomeSaveRequested":p.metronome_save_requested,"metronomeSaveWaiting":p.metronome_save_waiting,"notice":p.notice,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":true,"reference":"new candidate; production-matched reference absent","liveFps":"unmeasured"}),
        )?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_EMPTY_PROJECT_FIXTURES").unwrap());let phase=std::env::var("SINGZ_GPUI_EMPTY_PROJECT_PHASE")?;
  macro_rules! wait{($p:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(20);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,$app|{let $p=view.read($app);$condition})?{break;}anyhow::ensure!(Instant::now()<deadline,"Empty project timeout {}",stringify!($condition));}}};}
  macro_rules! save{()=>{{handle.update(cx,|_,w,cx|->anyhow::Result<()>{
    draw(w,cx);let p=view.read(cx);
    anyhow::ensure!(p.focus_handle.contains_focused(w,cx),"Save has no mounted keyboard route: header={:?}, root={}, import={}, editing={}",p.header.read(cx).focused_control(w),p.focus_handle.is_focused(w),p.library_import_open,p.header.read(cx).is_editing());
    key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"});Ok(())
   })??;wait!(p,cx=>!p.saving&&p.edit_seq==p.saved_seq);}};}
  macro_rules! remove{()=>{{let slot=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().custom_tracks()[0].slot)?;handle.update(cx,|_,w,cx|crate::ui_custom_tracks::press(&view,w,cx,&format!("remove-{slot}")))??;wait!(p,cx=>p.tracks_pending.is_none()&&empty(p));}};}
  macro_rules! add{($file:expr)=>{{handle.update(cx,|_,w,cx|{view.update(cx,|p,_|p.empty_picker_paths.push_back(vec![$file.clone()]));crate::ui_custom_tracks::press(&view,w,cx,"add")})??;wait!(p,cx=>p.tracks_pending.is_none()&&p.project.as_ref().is_some_and(|s|s.has_audio())&&!p.tracks_audio_failed);}};}
  let mut imported=vec![];
  for (width,height) in [(1280.,800.),(1060.,640.)]{
   let project=root.join("library").join(format!("Empty {}",width as u32));
   handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
   wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project));
   if phase=="remove"{
    handle.update(cx,|_,w,cx|play(&view,w,cx))??;wait!(p,cx=>p.playing&&p.position>0.05);
    let (old_epoch,old_status)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.native_epoch,p.last_playback_status.clone().unwrap())})?;
    remove!();
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{play(&view,w,cx)?;key(w,cx,"right");key(w,cx,"home");view.update(cx,|p,cx|{p.zoom_by(0.5,cx);let mut delayed=old_status.clone();delayed.sampled_at=Instant::now();p.playback_status(old_epoch,delayed,cx);});anyhow::ensure!(empty(view.read(cx)),"Disabled controls or delayed old status resurrected audio");Ok(())})??;
    // Exercise logical preferences without claiming an audio graph.
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.native_transport(transport::TransportEvent::Volume(0.65),cx);p.native_transport(transport::TransportEvent::Tempo(0.8),cx);p.native_transport(transport::TransportEvent::Transpose(2),cx);}))?;
    wait!(p,cx=>empty(p)&&(p.native_rate-0.8).abs()<0.001);
    let before=std::fs::read(project.join("project.json"))?;let mut changed:serde_json::Value=serde_json::from_slice(&before)?;changed["externalEdit"]=serde_json::json!("must survive failed CAS");std::fs::write(project.join("project.json"),serde_json::to_vec_pretty(&changed)?)?;
    handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;wait!(p,cx=>!p.saving&&p.notice.is_some()&&p.edit_seq!=p.saved_seq&&empty(p));
    anyhow::ensure!(serde_json::from_slice::<serde_json::Value>(&std::fs::read(project.join("project.json"))?)?==changed,"Failed empty Save changed external metadata");
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("cas-refused-{}",width as u32)))??;
    // The external editor undoes its own change; the app retries normal Save.
    std::fs::write(project.join("project.json"),before)?;handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;save!();
    // Standalone Test C4 is independent of a zero-song document.
    handle.update(cx,|_,w,cx|header(&view,w,cx,"training"))??;wait!(p,cx=>p.screen==Screen::Training);
    handle.update(cx,|_,w,cx|training_button(&view,w,cx,"training-exercise-0"))??;
    handle.update(cx,|_,w,cx|training_button(&view,w,cx,"training-test"))??;
    wait!(p,cx=>p.training_test.is_some()&&p.training_last.as_ref().is_some_and(|s|s.active)&&p.last_playback_status.as_ref().is_some_and(|s|s.empty_project&&s.cue.active&&!s.physical_output_released));
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.as_ref().unwrap().empty_tracks&&p.duration==0.&&p.native_graph==0&&!p.playing,"Training invented song audio");shot(&view,w,cx,&out,&format!("empty-training-{}",width as u32))})??;
    wait!(p,cx=>p.training_test.is_none()&&empty(p));
    handle.update(cx,|_,w,cx|header(&view,w,cx,"songs"))??;wait!(p,cx=>p.screen==Screen::Player);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("saved-empty-{}",width as u32)))??;
   }else if phase=="import"{
    for kind in ["Plain copy","Added copy","Removed move"]{
     let source=root.join("external").join(format!("{kind} {}",width as u32));
     let original=std::fs::read(source.join("project.json"))?;
     handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(source.clone(),cx)))?;
     wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==source));
     if kind=="Added copy"{let file=root.join("new-one.wav");add!(file);handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;}
     if kind=="Removed move"{cx.background_executor().timer(Duration::from_millis(650)).await;remove!();}
     handle.update(cx,|_,w,cx|header(&view,w,cx,"import"))??;wait!(p,cx=>p.library_import_open);
     handle.update(cx,|_,_,cx|view.read(cx).library_import.clone().update(cx,|d,cx|d.set_animation_time(Some(0.25),cx)))?;
     handle.update(cx,|_,w,cx|import_button(&view,w,cx,if kind=="Removed move"{"library-import-move"}else{"library-import-copy"}))??;
     wait!(p,cx=>p.import_pending.is_none()&&!p.loading&&!p.library_import_open&&p.project.as_ref().is_some_and(|s|s.dir.starts_with(root.join("library"))&&s.dir!=source));
     let dest=handle.update(cx,|_,_,cx|->anyhow::Result<PathBuf>{let p=view.read(cx);let doc=p.project.as_ref().unwrap();anyhow::ensure!(doc.has_audio()==(kind=="Added copy"),"Import lost unsaved desired lane inventory");if doc.has_audio(){anyhow::ensure!(doc.custom_tracks().len()==1&&p.duration>=5.,"Imported unsaved audio lost");}else{anyhow::ensure!(empty(p),"Imported empty document owns audio");}Ok(doc.dir.clone())})??;
     save!();
     if kind=="Removed move"{anyhow::ensure!(!source.exists(),"Move kept source folder");}else{anyhow::ensure!(std::fs::read(source.join("project.json"))?==original,"Copy altered source metadata");}
     cx.background_executor().timer(Duration::from_millis(700)).await;
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("import-{}-{}",kind.replace(' ',"-"),width as u32)))??;
     imported.push(serde_json::json!({"kind":kind,"width":width,"source":source,"destination":dest}));
    }
   }else{
    anyhow::ensure!(handle.update(cx,|_,_,cx|empty(view.read(cx)))?,"Restart did not open a genuinely empty document");
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("restarted-empty-{}",width as u32)))??;
    let bad=root.join("bad.wav");handle.update(cx,|_,w,cx|{view.update(cx,|p,_|p.empty_picker_paths.push_back(vec![bad]));crate::ui_custom_tracks::press(&view,w,cx,"add")})??;wait!(p,cx=>p.tracks_pending.is_none()&&p.notice.is_some()&&empty(p));
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
    let short=root.join("short.wav");add!(short);handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|p.zoom_by(0.5,cx));let p=view.read(cx);anyhow::ensure!(p.duration>0.&&p.duration<1.&&p.view_start.is_finite()&&p.view_end.is_finite(),"Short track zoom is not finite");Ok(())})??;
    cx.background_executor().timer(Duration::from_millis(650)).await;remove!();
    let first=root.join("new-one.wav");add!(first);handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
    let (epoch,old)=handle.update(cx,|_,_,cx|{let p=view.read(cx);anyhow::ensure!(!p.playing&&p.duration>=5.&&p.native_graph>0,"Fresh Add was not paused native audio");Ok::<_,anyhow::Error>((p.native_epoch,p.last_playback_status.clone().unwrap()))})??;
    cx.background_executor().timer(Duration::from_millis(650)).await;remove!();
    let second=root.join("new-two.flac");add!(second);handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{let mut delayed=old.clone();delayed.sampled_at=Instant::now();p.playback_status(epoch,delayed,cx);});let p=view.read(cx);anyhow::ensure!(!p.playing&&p.duration>=7.&&p.native_lane_revision>old.lane_revision,"Late same-epoch nonempty status replaced the new lane set");Ok(())})??;
    save!();handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
    wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.has_audio()&&s.custom_tracks().len()==1)&&p.duration>=7.&&!p.playing);
    cx.background_executor().timer(Duration::from_millis(700)).await;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("saved-readded-{}",width as u32)))??;
   }
  }
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"imports":imported,"phase":phase,"twoSizes":true,"hidden":true,"actualRemoveAddControls":true,"zeroTimelineFinite":true,"durableEmptyOrReadd":true,"lateRealStatusDeliveryFenced":true,"nativeCleanupProofRequired":true,"chooser":"isolated picker return only","liveFps":"unmeasured"}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("EMPTY_PROJECT passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));eprintln!("EMPTY_PROJECT failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
}).detach();
}

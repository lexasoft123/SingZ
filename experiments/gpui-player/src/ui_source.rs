//! Hidden real import -> split -> seven native lanes -> Save -> reopen lifecycle.
use super::ui_training_run::{click, draw};
use super::*;
use anyhow::Context as _;
use std::{path::PathBuf, time::Duration};
#[derive(Debug)]
pub(super) struct ResumeProbe {
    pub epoch:u64,
    pub position:f32,
    pub at:Instant,
    pub initial_loop_count:u64,
    pub expected_seek_count:u64,
}
// Heard position and render loop_count are different clock domains. Compare
// adjacent heard samples modulo the actual loop, with a wall-clock bound shorter
// than one loop; never combine heard position with render loop_count.
fn forward_delta(before: &integration::Status, after: &integration::Status) -> anyhow::Result<f32> {
    anyhow::ensure!(before.loop_range == after.loop_range, "Native loop changed between receipts");
    Ok(if let Some((start, end)) = before.loop_range {
        anyhow::ensure!((start..=end).contains(&before.position) && (start..=end).contains(&after.position), "Heard position outside its loop");
        (after.position-before.position).rem_euclid(end-start)
    } else {
        after.position-before.position
    })
}
fn bounded_progress(before: &integration::Status, after: &integration::Status) -> anyhow::Result<f32> {
    anyhow::ensure!(after.sampled_at > before.sampled_at, "Native receipt is not fresh");
    let elapsed=after.sampled_at.duration_since(before.sampled_at).as_secs_f32();
    let bound=elapsed*after.rate+0.05;
    anyhow::ensure!(before.loop_range.is_none_or(|(start,end)|bound<end-start), "Receipt interval spans a whole loop");
    let delta=forward_delta(before,after)?;
    anyhow::ensure!(delta>=-0.025 && delta<=bound, "Native position discontinuity: before={}, after={}, forward={delta}, elapsed={elapsed}, bound={bound}",before.position,after.position);
    Ok(delta)
}
fn button(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing {id}"))?;
    anyhow::ensure!(
        b.top() >= px(0.) && b.bottom() <= w.viewport_size().height,
        "Split action outside viewport"
    );
    eprintln!("SOURCE_BUTTON {b:?}");
    click(w, cx, b.center());
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
 std::fs::create_dir_all(&out)?;let source=PathBuf::from(std::env::var_os("SINGZ_GPUI_SOURCE_FILE").unwrap());let fake=std::env::var_os("SINGZ_GPUI_SOURCE_CONTROL").map(PathBuf::from);
 macro_rules! wait {($predicate:expr)=>{{eprintln!("SOURCE_WAIT {}",stringify!($predicate));let deadline=Instant::now()+Duration::from_secs(if fake.is_some(){25}else{240});loop{cx.background_executor().timer(Duration::from_millis(30)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(($predicate)(p))})??;if ready{eprintln!("SOURCE_READY {}",stringify!($predicate));break;}if Instant::now()>=deadline {let state=handle.update(cx,|_,_,cx|{let p=view.read(cx);format!("job={:?} loading={} working={} screen={:?} status={:?} native={:?} resume={:?} pendingSeek={:?} pausedSeek={:?}",p.source_job,p.loading,p.source_working,p.screen as u8,p.source_status,p.last_playback_status,p.source_resume_probe,p.pending_seek,p.source_seek_receipt)})?;std::fs::write(out.join("wait-timeout.txt"),&state)?;anyhow::bail!("Source state timeout: {}: {state}",stringify!($predicate));}}}};}
 macro_rules! press {($id:expr)=>{{cx.background_executor().timer(Duration::from_millis(80)).await;handle.update(cx,|_,w,cx|button(&view,w,cx,$id))??;cx.background_executor().timer(Duration::from_millis(80)).await;}};}
 macro_rules! capture {($name:expr)=>{{cx.background_executor().timer(Duration::from_millis(1200)).await;handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);w.render_to_image()?.save(out.join($name))?;Ok(())})??}};}
 macro_rules! split {($id:expr)=>{{press!("transport-split");handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);w.render_to_image()?.save(out.join(format!("menu-{}.png",$id)))?;Ok(())})??;press!($id);}};}
 handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));draw(w,cx);let at=point(px(500.),px(400.));w.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Entered{position:at,paths:ExternalPaths(vec![source.clone()].into())}),cx);draw(w,cx);w.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Submit{position:at}),cx);})?;
 wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&p.project.is_some());
 let original=handle.update(cx,|_,_,cx|->anyhow::Result<PathBuf>{let p=view.read(cx);anyhow::ensure!(p.source_working&&p.project.as_ref().unwrap().original&&p.edit_seq>p.saved_seq,"Dropped source was not an unsaved original mix");Ok(p.project.as_ref().unwrap().dir.clone())})??;
 capture!("original-1280.png");
 press!("transport-split");
 handle.update(cx,|_,w,cx|->anyhow::Result<()>{w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);anyhow::ensure!(view.read(cx).screen==Screen::Player&&!view.read(cx).transport.read(cx).has_popover(),"Escape did not dismiss the split menu");Ok(())})??;
 press!("transport-split");
 handle.update(cx,|_,w,cx|->anyhow::Result<()>{click(w,cx,point(px(500.),px(400.)));anyhow::ensure!(!view.read(cx).transport.read(cx).has_popover(),"Outside click did not dismiss the split menu");Ok(())})??;

 if let Some(control)=&fake {
  std::fs::write(control,"slow")?;split!("split-combined");wait!(|p:&Player|p.source_job.is_some()&&p.source_status.percent>1.);
  handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|t,cx|{t.progress_phase=Some(0.);cx.notify();}))?;
  capture!("splitting-cancellable-1280.png");
  press!("transport-play");wait!(|p:&Player|p.playing);press!("transport-play");wait!(|p:&Player|!p.playing);
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);let b=p.transport.read(cx).bounds("split-progress").ok_or_else(||anyhow::anyhow!("Inline progress absent"))?;anyhow::ensure!(b.top()>w.viewport_size().height-px(100.),"Split progress is not in the footer");anyhow::ensure!(!p.source_blocks_player(),"Split still blocks player");Ok(())})??;
  handle.update(cx,|_,w,cx|{w.resize(size(px(1060.),px(640.)));view.read(cx).transport.clone().update(cx,|t,cx|{t.progress_phase=Some(0.25);cx.notify();});})?;
  capture!("splitting-cancellable-1060.png");
  handle.update(cx,|_,w,_|{w.resize(size(px(1280.),px(800.)));})?;
  capture!("splitting-shimmer-1280.png");handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);button(&view,w,cx,"split-cancel")?;Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(300)).await;
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.source_job.is_none()&&p.project.as_ref().unwrap().dir==original&&p.project.as_ref().unwrap().original,"Cancelled split replaced the current song");Ok(())})??;
  std::fs::write(control,"missing")?;split!("split-combined");let deadline=Instant::now()+Duration::from_secs(20);
  loop{cx.background_executor().timer(Duration::from_millis(30)).await;if handle.update(cx,|_,_,cx|view.read(cx).notice.is_some())?{break;}anyhow::ensure!(Instant::now()<deadline,"Missing-stem failure not reported");}
  capture!("missing-stem-error-1280.png");handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{assert!(p.project.as_ref().unwrap().original);p.notice=None;cx.notify();}))?;std::fs::write(control,"good")?;
 }
 if let Some(control)=&fake {std::fs::write(control,"hold")?;}
 split!("split-combined");
 if let Some(control)=&fake {
  wait!(|p:&Player|p.source_job.is_some()&&p.source_status.percent>1.);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.native_transport(transport::TransportEvent::Volume(0.65),cx);p.native_transport(transport::TransportEvent::Tempo(0.8),cx);p.native_transport(transport::TransportEvent::Transpose(2),cx);p.position=0.4;p.seek_native(cx);p.native_transport(transport::TransportEvent::Loop,cx);}))?;
  press!("transport-play");wait!(|p:&Player|p.playing);
  handle.update(cx,|_,_,cx|view.read(cx).header.clone().update(cx,|_,cx|cx.emit(header::HeaderEvent::Settings)))?;
  wait!(|p:&Player|p.screen==Screen::Settings);
  std::fs::write(control,"good")?;
 }
 wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&p.project.as_ref().is_some_and(|s|!s.original&&s.lanes.len()==7));
 if fake.is_some() {
  // Prove the paused seek and first actual Play before the 1.2-second capture
  // delay can put this short fixture on either side of a legitimate loop wrap.
  wait!(|p:&Player|p.playing&&p.pending_seek.is_none()&&p.source_seek_receipt.is_some()&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.audible_current&&s.rate==0.8&&s.transpose==2&&p.source_resume_probe.as_ref().is_some_and(|probe|probe.epoch==p.native_epoch&&s.seek_count>=probe.expected_seek_count)));
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{
    let p=view.read(cx);let probe=p.source_resume_probe.as_ref().context("Missing owned split resume intent")?;
    let paused=p.source_seek_receipt.as_ref().context("Missing paused native seek receipt")?;
    let status=p.last_playback_status.as_ref().context("Missing native split resume receipt")?;
    let delta=bounded_progress(paused,status);
    std::fs::write(out.join("split-handoff-receipt.json"),serde_json::to_vec_pretty(&serde_json::json!({
        "epoch":p.native_epoch,"requestedPosition":probe.position,
        "requestElapsedSeconds":status.sampled_at.saturating_duration_since(probe.at).as_secs_f32(),
        "pausedPosition":paused.position,"pausedPlaying":paused.playing,"pausedSeekCount":paused.seek_count,
        "pausedGraph":paused.graph_generation,"pausedRate":paused.rate,"pausedTranspose":paused.transpose,
        "actualPosition":status.position,"elapsedSincePausedSeconds":status.sampled_at.saturating_duration_since(paused.sampled_at).as_secs_f32(),
        "heardForwardDelta":delta.as_ref().ok(),"progressError":delta.as_ref().err().map(ToString::to_string),
        "loopCountDiagnosticOnly":status.loop_count,"initialLoopCountDiagnosticOnly":probe.initial_loop_count,
        "seekCount":status.seek_count,"expectedSeekCount":probe.expected_seek_count,
        "rate":status.rate,"transpose":status.transpose,"loopRange":status.loop_range,"playing":status.playing,
        "audibleCurrent":status.audible_current,"pendingSeek":p.pending_seek,"nativeGraph":status.graph_generation,
    }))?)?;
    anyhow::ensure!(!paused.playing&&!paused.counting_in&&paused.seek_count>=probe.expected_seek_count&&(paused.position-probe.position).abs()<=0.025,"Paused source seek did not retain requested position");
    anyhow::ensure!(paused.graph_generation==status.graph_generation&&paused.seek_count==status.seek_count,"Play used a different native graph or seek");
    anyhow::ensure!(paused.rate==0.8&&paused.transpose==2&&paused.loop_range==status.loop_range&&p.looping&&p.master_volume==0.65&&p.tempo==0.8&&p.transpose==2,"Split handoff lost accepted mix");
    delta?;
    anyhow::ensure!(p.screen==Screen::Settings&&p.previous_screen==Screen::Player,"Split completion dismissed settings");
    Ok(())
  })??;
  capture!("split-kept-settings-1280.png");
  handle.update(cx,|_,_,cx|view.read(cx).header.clone().update(cx,|_,cx|cx.emit(header::HeaderEvent::Settings)))?;
  wait!(|p:&Player|p.screen==Screen::Player);
  let first=handle.update(cx,|_,_,cx|view.read(cx).last_playback_status.clone().context("Missing resumed status"))??;
  wait!(|p:&Player|p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.audible_current&&s.sampled_at>first.sampled_at&&bounded_progress(&first,s).is_ok_and(|delta|delta>0.05)));
  press!("transport-play");wait!(|p:&Player|!p.playing);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.native_transport(transport::TransportEvent::Volume(1.),cx);p.native_transport(transport::TransportEvent::Tempo(1.),cx);p.native_transport(transport::TransportEvent::Transpose(0),cx);p.native_transport(transport::TransportEvent::Loop,cx);p.position=0.;p.seek_native(cx);}))?;
 }

 handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.source_working&&p.source_target.is_none()&&p.project.as_ref().unwrap().raw["settings"]["leadVocalSeparated"]==true,"Seven-lane result lost its working-copy identity");Ok(())})??;
 capture!("seven-lanes-top-1280.png");
 handle.update(cx,|_,w,cx|{view.read(cx).stem_scroll_handle.set_offset(point(px(0.),px(-1500.)));w.refresh();})?;
 capture!("backing-lane-1280.png");
 handle.update(cx,|_,w,cx|{w.resize(size(px(1060.),px(640.)));view.update(cx,|p,cx|{p.muted[6]=true;p.gain[6]=42;p.sync_lane(6,cx);});})?;
 cx.background_executor().timer(Duration::from_millis(150)).await;
 handle.update(cx,|_,w,cx|{w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(700.),px(350.)),delta:ScrollDelta::Pixels(point(px(0.),px(-500.))),..Default::default()}),cx);})?;
 capture!("backing-lane-1060.png");
 handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;
 wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&!p.source_working&&!p.tracks_audio_failed&&p.audio_recovery.is_none()&&p.source_publication.is_none()&&p.project.as_ref().is_some_and(|s|s.lanes.len()==7));
 let mut saved=handle.update(cx,|_,_,cx|->anyhow::Result<PathBuf>{let p=view.read(cx);let project=p.project.as_ref().unwrap();anyhow::ensure!(project.dir.starts_with(integration::library_root().canonicalize()?)&&p.muted[6]&&p.gain[6]==42&&p.edit_seq==p.saved_seq,"Save did not publish/reopen the seventh-lane mix");Ok(project.dir.clone())})??;
 capture!("saved-seven-lanes-1060.png");
 handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|p.playing);cx.background_executor().timer(Duration::from_millis(120)).await;handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|!p.playing);
 if let Some(legacy)=std::env::var_os("SINGZ_GPUI_SOURCE_LEGACY_PROJECT") {
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(legacy.into(),cx)))?;
  wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|s|s.lanes.len()==6&&s.lanes[0].1.extension().is_some_and(|e|e=="flac")));
  split!("split-vocals");
  wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&p.source_working&&p.project.as_ref().is_some_and(|s|s.lanes.len()==7));
  capture!("legacy-flac-backing-1060.png");
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;
  wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&!p.source_working&&!p.tracks_audio_failed&&p.audio_recovery.is_none()&&p.source_publication.is_none());
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).project.as_ref().unwrap().raw["foreignLegacy"]=="preserve","Backing-only save discarded metadata");Ok(())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(saved.clone(),cx)))?;
  wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==saved));
 }
 if let Some(control)=&fake {
  let saved_audio:Vec<_>=integration::STEMS.iter().flat_map(|stem|["wav","flac"].map(move |ext|format!("stems/{stem}.{ext}"))).filter_map(|name|std::fs::read(saved.join(&name)).ok().map(|bytes|(name,bytes))).collect();
  std::fs::write(control,"changed")?;
  split!("split-stems");wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&p.source_working);
  let metadata=saved.join("project.json");let mut raw:serde_json::Value=serde_json::from_slice(&std::fs::read(&metadata)?)?;raw["externalNote"]=serde_json::json!("keep me");std::fs::write(&metadata,serde_json::to_vec_pretty(&raw)?)?;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;let deadline=Instant::now()+Duration::from_secs(20);
  loop{cx.background_executor().timer(Duration::from_millis(30)).await;if handle.update(cx,|_,_,cx|view.read(cx).notice.is_some())?{break;}anyhow::ensure!(Instant::now()<deadline,"Conflicting Save was not refused");}
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.source_working&&p.notice.as_ref().unwrap().contains("changed during splitting"),"Unexpected conflict outcome: {:?}",p.notice);Ok(())})??;
  for (name,bytes) in &saved_audio {anyhow::ensure!(std::fs::read(saved.join(name))?==*bytes,"Conflicting Save replaced original audio: {name}");}
  std::fs::write(saved.join("notes.txt"),b"unrelated file")?;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(saved.clone(),cx)))?;wait!(|p:&Player|!p.loading&&!p.source_working);
  split!("split-stems");wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&p.source_working);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.rename_title("Renamed split result".into(),cx)))?;
  wait!(|p:&Player|!p.loading&&p.rename_pending.is_none()&&p.source_working&&p.song_title.as_str()=="Renamed split result");
  saved=handle.update(cx,|_,_,cx|->anyhow::Result<PathBuf>{let p=view.read(cx);let target=p.source_target.as_ref().ok_or_else(||anyhow::anyhow!("Rename lost working-copy destination"))?;anyhow::ensure!(target.dir.file_name().unwrap()=="Renamed split result"&&p.project.as_ref().unwrap().dir!=target.dir,"Rename replaced unsaved split with saved audio");Ok(target.dir.clone())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;wait!(|p:&Player|p.source_job.is_none()&&!p.loading&&!p.source_working&&!p.tracks_audio_failed&&p.audio_recovery.is_none()&&p.source_publication.is_none());
  anyhow::ensure!(std::fs::read(saved.join("notes.txt"))?==b"unrelated file","Split save removed unrelated files");let raw:serde_json::Value=serde_json::from_slice(&std::fs::read(saved.join("project.json"))?)?;anyhow::ensure!(raw["externalNote"]=="keep me","Split save removed foreign metadata");
  std::fs::write(control,"slow")?;split!("split-stems");wait!(|p:&Player|p.source_job.is_some()&&p.source_status.percent>1.);
 }
 std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeFileDrop":true,"unsavedOriginal":true,"splitSevenLanes":true,"leadBacking":true,"saveOnlyPublishesOnRequest":true,"seventhLaneMixRestored":true,"nativePlayback":true,"inlineSplitPlayback":fake.is_some(),"splitHandoffRestored":fake.is_some(),"workingSplitRename":fake.is_some(),"settingsRetainedOnSplit":fake.is_some(),"savedProject":saved,"faultCases":fake.is_some(),"realModels":fake.is_none(),"hidden":true,"muted":true}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("NATIVE_SOURCE passed");let _=cx.update(|cx|cx.quit());},Err(e)=>{eprintln!("NATIVE_SOURCE failed: {e:#}");let _=cx.update(|cx|cx.quit());}}
}).detach();
}

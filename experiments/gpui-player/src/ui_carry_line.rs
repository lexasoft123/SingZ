//! Hidden actual Carry controls, native receipts and durable restart fixtures.
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
fn toggle(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .guides
        .get("carry")
        .ok_or_else(|| anyhow::anyhow!("Carry footer anchor absent"))?;
    click(w, cx, b.center());
    Ok(())
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let ui = view.read(cx).carry_popover.clone();
    let b = ui
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Carry control not measured: {id}"))?;
    anyhow::ensure!(
        b.top() >= px(52.)
            && b.bottom() <= w.viewport_size().height
            && b.left() >= px(0.)
            && b.right() <= w.viewport_size().width,
        "Carry control outside visible viewport: {id} {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn snapshot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Carry test activated window"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let native=p.last_playback_status.as_ref().map(|s|serde_json::json!({"carryRevision":s.carry_revision,"laneRevision":s.lane_revision,"graphGeneration":s.graph_generation,"rate":s.rate,"position":s.position,"playing":s.playing,"loop":s.loop_range,"countingIn":s.counting_in}));
    std::fs::write(
        out.join(format!("{name}.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"popover":p.carry_popover.read(cx).state(w,cx),"carry":p.carry,"open":p.carry_open,"pending":p.carry_flight.carry.is_some(),"queuedSave":p.carry_flight.carry_save_requested,"queuedNavigation":p.carry_flight.carry_navigation,"epoch":p.native_epoch,"carryRevision":p.native_carry_revision,"native":native,"plan":p.carry_flight.carry_plan.as_ref().map(|plan|serde_json::json!({"on":plan.on,"mode":plan.mode,"period":plan.period_sec,"laneIds":plan.lane_ids,"windows":plan.windows})),"lineMask":p.carry_sing_mask(),"muted":p.muted.as_slice(),"selection":p.project.as_ref().and_then(|p|p.selection),"project":p.project.as_ref().map(|p|&p.dir),"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":true,"liveFps":"unmeasured","productionParity":"unqualified; native candidate only"}),
        )?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());let stage=std::env::var("SINGZ_GPUI_CARRY_STAGE").unwrap_or_else(|_|"exercise".into());
  macro_rules! wait{($p:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,$app|{let $p=view.read($app);$condition})?{break;}anyhow::ensure!(Instant::now()<deadline,"Carry timeout: {}",stringify!($condition));}}};}
  macro_rules! action{($id:expr)=>{{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;wait!(p,cx=>p.carry_flight.carry.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|s.carry_revision==p.native_carry_revision));}};}
  if stage=="restart"{
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.is_some()&&p.native_carry_revision>0);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.carry.enabled&&p.carry.config.mode==carry_line::Mode::Lines&&p.carry.config.hear==2&&p.carry.config.sing==1&&p.carry.config.stems==["custom-harmony-0"]&&p.muted[2],"Restart lost Carry or independent manual mute");toggle(&view,w,cx)})??;wait!(p,cx=>p.carry_open);handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"saved-restart"))??;
   let fresh=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_FRESH_PROJECT").unwrap());handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(fresh.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==fresh));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.carry.enabled&&p.carry.config.mode==carry_line::Mode::Lines&&p.carry.config.hear==2&&p.carry.config.sing==1,"Global fallback enabled a fresh project or lost config");toggle(&view,w,cx)})??;wait!(p,cx=>p.carry_open);handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let state=view.read(cx).carry_popover.read(cx).state(w,cx);anyhow::ensure!(state["caption"]=="No synced lyrics yet — alternating by time until they load.","Missing lyric caption changed");snapshot(&view,w,cx,&out,"global-fallback-disabled")})??;
  }else if stage=="crowded"{
   let crowded=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_CROWDED").unwrap());
   for(width,height)in[(1280.,800.),(1060.,640.)]{
    handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|p.open_project(crowded.clone(),cx));})?;
    wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==crowded&&p.lane_specs.len()==16));
    handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(p,cx=>p.carry_open);
    let order=handle.update(cx,|_,w,cx|->anyhow::Result<Vec<String>>{draw(w,cx);let ui=view.read(cx).carry_popover.clone();let card=ui.read(cx).bounds("carry-card").unwrap();anyhow::ensure!(card.top()>=px(52.)&&card.bottom()<=w.viewport_size().height&&card.left()>=px(0.)&&card.right()<=w.viewport_size().width,"Maximum-lane card escaped viewport: {card:?}");snapshot(&view,w,cx,&out,&format!("crowded-top-{}",width as u32))?;Ok(ui.read(cx).state(w,cx)["focusOrder"].as_array().unwrap().iter().map(|v|v.as_str().unwrap().to_owned()).collect())})??;
    let mut reached=std::collections::BTreeSet::new();
    for _ in 0..order.len()+1{
     let focused=handle.update(cx,|_,w,cx|->anyhow::Result<String>{key(w,cx,"tab");draw(w,cx);let ui=view.read(cx).carry_popover.clone();let state=ui.read(cx).state(w,cx);let id=state["focusedControl"].as_str().ok_or_else(||anyhow::anyhow!("Crowded Tab lost control focus"))?.to_owned();let card=ui.read(cx).bounds("carry-card").unwrap();let viewport=ui.read(cx).scroll_viewport();let b=ui.read(cx).bounds(&id).unwrap();anyhow::ensure!(state["controlVisible"][&id]==true&&b.top()>=viewport.top()&&b.bottom()<=viewport.bottom()&&b.left()>=card.left()&&b.right()<=card.right(),"Keyboard focused an obscured Carry control: {id} {b:?} card={card:?}");if id=="carry-lane-15"{anyhow::ensure!(state["tooltips"][&id].as_str().is_some_and(|text|text.contains("UnbreakableLongLabel")&&text.len()>140),"Full long guide name was lost");snapshot(&view,w,cx,&out,&format!("crowded-last-{}",width as u32))?;}Ok(id)})??;
     reached.insert(focused.clone());
     if focused=="carry-lane-15"{
      let selected=handle.update(cx,|_,_,cx|view.read(cx).carry.config.stems.contains(&"custom-crowded-15".to_owned()))?;
      if !selected{handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;wait!(p,cx=>p.carry_flight.carry.is_none()&&p.carry.config.stems.contains(&"custom-crowded-15".to_owned()));}
     }
    }
    anyhow::ensure!(order.iter().all(|id|reached.contains(id)),"Maximum-lane keyboard traversal omitted controls");
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,cx=>!p.carry_open);
   }
  }else if stage=="working"{
   // Prepared source output uses the real publication worker and CAS target;
   // inference is outside this Save/navigation regression.
   let working=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_WORKING").unwrap());
   let target_dir=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_TARGET").unwrap());
   let (_,fingerprint)=project_store::read(&target_dir,"project.json")?;
   let target=source_jobs::Target{dir:target_dir.clone(),fingerprint,lyrics_fingerprint:lyrics_store::identity(&target_dir)?};
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_source_output(source_jobs::Output{publication_hash:None,path:working.clone(),working:true,target:Some(target)},None,cx)))?;
   wait!(p,cx=>!p.loading&&p.source_working&&p.project.as_ref().is_some_and(|p|p.dir==working)&&p.lyric_document.lines.len()==6);
   handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(p,cx=>p.carry_open);
   action!("carry-on");
   let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_GATE").unwrap());let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);
   let before=std::fs::read(target_dir.join("project.json"))?;
   std::fs::write(&gate,b"hold actual accepted native receipt")?;
   handle.update(cx,|_,w,cx|press(&view,w,cx,"carry-period-plus"))??;
   let deadline=Instant::now()+Duration::from_secs(3);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(5)).await;anyhow::ensure!(Instant::now()<deadline,"Working Carry receipt gate was not reached");}
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
   let fresh=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_FRESH_PROJECT").unwrap());
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{anyhow::ensure!(p.carry_flight.carry_save_requested&&p.carry_flight.carry.is_some()&&p.source_job.is_none(),"Working Save did not queue behind actual receipt");p.open_project(fresh.clone(),cx);anyhow::ensure!(p.source_working&&!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==working),"Working navigation escaped the Carry queue");Ok(())})})??;
   anyhow::ensure!(std::fs::read(target_dir.join("project.json"))?==before,"Working target published before accepted receipt");
   handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"working-queued"))??;
   std::fs::remove_file(&gate)?;
   wait!(p,cx=>!p.loading&&!p.saving&&p.source_job.is_none()&&!p.metronome_flight.metronome_save_requested&&!p.metronome_flight.metronome_save_waiting&&p.project.as_ref().is_some_and(|p|p.dir==fresh));
   let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(target_dir.join("project.json"))?)?;
   anyhow::ensure!(saved["settings"]["training"]["on"]==true&&saved["settings"]["training"]["periodSec"]==15,"Working Save was cancelled/lost before deferred navigation");
   std::fs::write(out.join("published-project.json"),serde_json::to_vec_pretty(&saved)?)?;
   handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"working-published-navigation"))??;
  }else{
   for(width,height)in[(1280.,800.),(1060.,640.)]{
    handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|{p.notice=None;p.open_project(project.clone(),cx);});})?;
    let deadline=Instant::now()+Duration::from_secs(5);loop{if handle.update(cx,|_,w,_|w.viewport_size()==size(px(width),px(height)))?{break;}cx.background_executor().timer(Duration::from_millis(20)).await;anyhow::ensure!(Instant::now()<deadline,"Carry viewport resize did not settle");}
    wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.lane_specs.len()==6)&&p.lyric_document.lines.len()==6&&p.last_playback_status.is_some());
    let(epoch,old_status)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{let p=view.read(cx);let old=p.last_playback_status.clone().unwrap();let epoch=p.native_epoch;anyhow::ensure!(!p.carry.enabled&&p.muted[2],"Fixture disabled/manual mute state changed");toggle(&view,w,cx)?;Ok((epoch,old))})??;wait!(p,cx=>p.carry_open);
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let ui=view.read(cx).carry_popover.clone();let before=ui.read(cx).state(w,cx);anyhow::ensure!(before["caption"]=="Guide plays 10 s, then you take the next 10 s.","Default time caption changed");anyhow::ensure!(ui.read(cx).state(w,cx)["scrollMax"]==serde_json::json!([0.0,0.0]),"Ordinary Carry layout has spurious scroll overflow");snapshot(&view,w,cx,&out,&format!("off-{}",width as u32))?;let order=before["focusOrder"].as_array().unwrap();for _ in 0..order.len()+2{let before=ui.read(cx).state(w,cx);let expected=&order[(order.iter().position(|v|v==&before["focusedControl"]).map(|i|i+1).unwrap_or(0))%order.len()];key(w,cx,"tab");let after=ui.read(cx).state(w,cx);anyhow::ensure!(after["focusInside"]==true&&after["focusedControl"]==*expected&&after["keyboardFocus"]==true,"Carry Tab skipped/escaped actual control");}key(w,cx,"shift-tab");Ok(())})??;
    // Last selected lane is guarded by the real button, not only validation.
    let serial=handle.update(cx,|_,_,cx|view.read(cx).carry_flight.carry.serial())?;action!("carry-lane-0");anyhow::ensure!(handle.update(cx,|_,_,cx|{let p=view.read(cx);p.carry_flight.carry.serial()==serial&&p.carry.config.stems==["vocals"]})?,"Last selected stem was removed");
    action!("carry-on");wait!(p,cx=>p.carry.enabled&&p.native_carry_revision>old_status.carry_revision);
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{let revision=p.native_carry_revision;let position=p.playhead.position();let playing=p.playing;p.playback_status(epoch,old_status.clone(),cx);anyhow::ensure!(p.native_carry_revision==revision&&p.playhead.position()==position&&p.playing==playing,"Actual delayed old-revision status overwrote new Carry receipt");Ok(())})})??;
    for _ in 0..3{action!("carry-period-minus");}anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).carry.config.period_sec==5)?,"Period lower clamp failed");
    for _ in 0..12{action!("carry-period-plus");}anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).carry.config.period_sec==60)?,"Period upper clamp failed");
    handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,&format!("time60-{}",width as u32)))??;
    action!("carry-lines");for _ in 0..8{action!("carry-hear-plus");action!("carry-sing-plus");}anyhow::ensure!(handle.update(cx,|_,_,cx|{let c=&view.read(cx).carry.config;c.hear==8&&c.sing==8})?,"Hear/sing upper clamps failed");
    for _ in 0..8{action!("carry-hear-minus");action!("carry-sing-minus");}anyhow::ensure!(handle.update(cx,|_,_,cx|{let c=&view.read(cx).carry.config;c.hear==1&&c.sing==1})?,"Hear/sing lower clamps failed");
    action!("carry-hear-plus");action!("carry-lane-2");action!("carry-lane-0");
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.carry.config.stems==["custom-harmony-0"]&&p.carry_sing_mask()==Some(vec![false,false,true,false,false,true]),"Line grouping/custom stable ID changed");let windows=&p.carry_flight.carry_plan.as_ref().unwrap().windows;anyhow::ensure!(windows.len()==2&&(windows[0].s-9.85).abs()<0.001&&(windows[0].e-14.85).abs()<0.001&&(windows[1].s-24.85).abs()<0.001&&(windows[1].e-30.).abs()<0.001,"Native line window plan differs from source");snapshot(&view,w,cx,&out,&format!("lines-{}",width as u32))})??;
    // Source global Save remains available while the popover owns keyboard
    // focus, without dismissing it or activating a transport control.
    if width==1060. {
    handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
    wait!(p,cx=>!p.saving&&p.saved_seq==p.edit_seq);
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(p.carry_open&&p.carry_popover.read(cx).state(w,cx)["focusInside"]==true&&!p.playing,"Open-popover Save was swallowed, dismissed, or leaked into transport");let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?;anyhow::ensure!(saved["settings"]["training"]["on"]==true&&saved["settings"]["training"]["hear"]==2&&saved["settings"]["training"]["stems"]==serde_json::json!(["custom-harmony-0"]),"Open-popover Save did not publish accepted Carry metadata");snapshot(&view,w,cx,&out,&format!("save-open-{}",width as u32))})??;
    }
    // Escape owns the popover; it must not clear song selection or play.
    handle.update(cx,|_,_,cx|view.update(cx,|p,_|{p.project.as_mut().unwrap().selection=Some((2.,24.));}))?;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,cx=>!p.carry_open);
    anyhow::ensure!(handle.update(cx,|_,_,cx|{let p=view.read(cx);p.project.as_ref().unwrap().selection==Some((2.,24.))&&!p.playing&&p.native_epoch==epoch})?,"Popover Escape leaked to player");
    handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(p,cx=>p.carry_open);handle.update(cx,|_,w,cx|{draw(w,cx);click(w,cx,point(px(5.),px(100.)));})?;wait!(p,cx=>!p.carry_open);
    // Use production transport requests with real native receipts. These are
    // not a second DSP implementation or a synthetic playback clock.
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Tempo(1.25),cx)))?;wait!(p,cx=>p.last_playback_status.as_ref().is_some_and(|s|(s.rate-1.25).abs()<0.001));
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Loop,cx)))?;wait!(p,cx=>p.playhead.loop_range().is_some());
    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;wait!(p,cx=>p.playing&&p.playhead.position()>0.1);
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.native_epoch==epoch&&p.native_carry_revision>old_status.carry_revision&&p.carry_flight.carry_plan.as_ref().is_some_and(|p|p.windows.len()==2),"Native tempo/loop replaced Carry ownership");snapshot(&view,w,cx,&out,&format!("playing-{}",width as u32))?;key(w,cx,"space");Ok(())})??;wait!(p,cx=>!p.playing);
   }
   // A genuinely native-applied receipt is held on the worker, not a fake
   // Root pending value. Save and navigation must wait for that accepted plan.
   let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_GATE").unwrap());let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);
   let before_metadata=std::fs::read(project.join("project.json"))?;
   handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(p,cx=>p.carry_open);
   std::fs::write(&gate,b"hold actual accepted native receipt")?;
   let old_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
   handle.update(cx,|_,w,cx|press(&view,w,cx,"carry-hear-plus"))??;
   let deadline=Instant::now()+Duration::from_secs(3);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(5)).await;anyhow::ensure!(Instant::now()<deadline,"Actual native Carry receipt gate was not reached");}
   anyhow::ensure!(std::fs::read(&ready)?==b"native-carry-applied","Wrong Carry gate stage");
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.carry_flight.carry.payload().is_some_and(|pending|pending.plan.desired.config.hear==3)&&p.carry.config.hear==2,"Held receipt was optimistically adopted");key(w,cx,"escape");Ok(())})??;wait!(p,cx=>!p.carry_open);
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
   let fresh=PathBuf::from(std::env::var_os("SINGZ_GPUI_CARRY_FRESH_PROJECT").unwrap());
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{anyhow::ensure!(p.carry_flight.carry_save_requested&&!p.saving&&p.carry_flight.carry.is_some(),"Save did not queue behind actual Carry receipt");p.open_project(fresh.clone(),cx);anyhow::ensure!(p.native_epoch==old_epoch&&!p.loading&&!p.saving&&p.project.as_ref().is_some_and(|p|p.dir==project)&&p.carry_flight.carry_navigation.as_ref().is_some_and(|(path,source)|path==&fresh&&!*source),"Navigation revoked pending Carry/Save instead of deferring");Ok(())})})??;
   anyhow::ensure!(std::fs::read(project.join("project.json"))?==before_metadata,"Queued Save published before native Carry receipt");
   handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"queued-save-navigation"))??;
   std::fs::remove_file(&gate)?;
   wait!(p,cx=>!p.loading&&!p.saving&&p.carry_flight.carry.is_none()&&p.project.as_ref().is_some_and(|p|p.dir==fresh));
   let committed:serde_json::Value=serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?;
   anyhow::ensure!(committed["settings"]["training"]["on"]==true&&committed["settings"]["training"]["hear"]==3,"Deferred Save did not publish the actual accepted Carry config");
   std::fs::write(out.join("queued-save-project.json"),serde_json::to_vec_pretty(&committed)?)?;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.carry.enabled&&p.carry.config.hear==3&&p.native_epoch!=old_epoch,"Deferred fresh navigation lost global fallback/disabled policy");snapshot(&view,w,cx,&out,"queued-navigation-opened")})??;
   // Return through the production project opener, then restore the final
   // source control contract used by the independent restart process.
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project)&&p.carry.config.hear==3);
   handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(p,cx=>p.carry_open);action!("carry-hear-minus");handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,cx=>!p.carry_open);
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;wait!(p,cx=>!p.saving&&p.saved_seq==p.edit_seq);
   handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"saved"))??;
  }
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"stage":stage,"actualFooterControls":true,"acceptedNativeReceipts":true,"sameEpochOldRevisionFence":stage=="exercise","twoSizes":stage=="exercise"||stage=="crowded","acceptedReceiptQueuedSaveAndNavigation":stage=="exercise"||stage=="working","workingPublicationBeforeNavigation":stage=="working","sixteenLongGuideLabels":stage=="crowded","nativePlaybackMuted":true,"chooserPresentation":"not applicable","productionParity":"unqualified"}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("CARRY_UI passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"failure"));eprintln!("CARRY_UI failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
}).detach();
}

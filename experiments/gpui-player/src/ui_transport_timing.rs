//! Hidden actual BPM controls and native count-in delivery. No OS input.
use super::*;
use crate::ui_training_run::{click,draw};
use std::{path::{Path,PathBuf},time::Duration};
pub(crate) fn key(w:&mut Window,cx:&mut App,value:&'static str){draw(w,cx);w.dispatch_keystroke(Keystroke::parse(value).unwrap(),cx);draw(w,cx);}
fn printable(c:char)->&'static str{match c{'0'=>"0",'1'=>"1",'2'=>"2",'3'=>"3",'4'=>"4",'5'=>"5",'6'=>"6",'7'=>"7",'8'=>"8",'9'=>"9",'a'=>"a",'b'=>"b",'c'=>"c",_=>panic!("Unsupported test key")}}
fn text(w:&mut Window,cx:&mut App,value:&str){for c in value.chars(){key(w,cx,printable(c));}}
pub(crate) fn press(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()>{
 draw(w,cx);let ui=view.read(cx).transport.clone();let b=ui.read(cx).bounds(id).ok_or_else(||anyhow::anyhow!("Transport control missing: {id}"))?;
 anyhow::ensure!(b.left()>=px(0.)&&b.right()<=w.viewport_size().width&&b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height&&b.size.width>px(0.),"Transport control outside viewport: {id} {b:?}");click(w,cx,b.center());Ok(())
}
fn keyboard_state(view:&Entity<Player>,w:&Window,cx:&App)->serde_json::Value{
 let ui=view.read(cx).transport.clone();let input=ui.read(cx).bpm_input();let selected=input.read(cx).selected_range();
 let mut timing=ui.read(cx).timing_state(w,cx);timing["selection"]=serde_json::json!([selected.start,selected.end]);timing
}
fn focus_bpm(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<Vec<serde_json::Value>>{
 draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-bpm").ok_or_else(||anyhow::anyhow!("Actual BPM field not measured"))?;let position=b.center();
 let mut trace=vec![serde_json::json!({"phase":"before-focus-click","timing":keyboard_state(view,w,cx)})];
 w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position,pressed_button:None,modifiers:Modifiers::default()}),cx);draw(w,cx);
 w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
 trace.push(serde_json::json!({"phase":"after-focus-mousedown","timing":keyboard_state(view,w,cx)}));
 w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
 trace.push(serde_json::json!({"phase":"after-focus-mouseup","timing":keyboard_state(view,w,cx)}));Ok(trace)
}
fn mute_lane(view:&Entity<Player>,w:&mut Window,cx:&mut App,slot:usize)->anyhow::Result<()>{
 draw(w,cx);let id=format!("mute-{slot}");let b=view.read(cx).track_bounds.borrow().get(&id).copied().ok_or_else(||anyhow::anyhow!("Actual mixer M control not measured: {id}"))?;
 anyhow::ensure!(b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height&&b.left()>=px(0.)&&b.right()<=w.viewport_size().width,"Mixer M control outside viewport: {b:?}");click(w,cx,b.center());Ok(())
}
fn observed_mute(status:&integration::Status,id:&str)->Option<bool>{status.observed_lanes.as_array()?.iter().find(|lane|lane["id"]==id)?["muted"].as_bool()}
fn met(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()>{
 draw(w,cx);let ui=view.read(cx).metronome_ui.clone();let b=ui.read(cx).bounds.borrow().get(id).copied().ok_or_else(||anyhow::anyhow!("Metronome control missing: {id}"))?;click(w,cx,b.center());Ok(())
}
fn met_toggle(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).guides.get("metronome").ok_or_else(||anyhow::anyhow!("Metronome footer not measured"))?;click(w,cx,b.center());Ok(())}
fn state(view:&Entity<Player>,w:&Window,cx:&App)->serde_json::Value{
 let p=view.read(cx);serde_json::json!({"timing":p.transport.read(cx).timing_state(w,cx),"epoch":p.native_epoch,"project":p.project.as_ref().map(|p|&p.dir),"tempo":p.tempo,"position":p.playhead.position(),"playing":p.playing,"countingIn":p.transport_flight.counting_in,"countInAnchor":p.transport_flight.count_in_anchor,"loading":p.loading,"saving":p.saving,"notice":p.notice,"ratePending":p.transport_flight.native_rate_pending.is_some(),"rateQueued":p.transport_flight.native_rate_queued,"rateSaveRequested":p.transport_flight.native_rate_save_requested,"rateNavigation":p.transport_flight.native_rate_navigation,"beats":p.beats,"metronome":p.metronome,"selection":p.project.as_ref().and_then(|p|p.selection),"playerLoop":p.looping,"loop":p.playhead.loop_range(),"muted":p.muted.as_slice(),"gain":p.gain.as_slice(),"solo":p.solo.as_slice(),"master":p.master_volume,"transpose":p.transpose,"playIntent":p.transport_flight.native_play.payload().copied(),"playIntentSerial":p.transport_flight.native_play.current_serial(),"native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"graph":s.graph_generation,"rate":s.rate,"playing":s.playing,"position":s.position,"renderedFrame":s.rendered_frame,"countingIn":s.counting_in,"observedLanes":s.observed_lanes,"heard":s.count_in_heard,"seekCount":s.seek_count,"loop":s.loop_range})),"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"liveFps":"unmeasured","productionParity":"unqualified native candidate"})
}
pub(crate) fn shot(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&Path,name:&str)->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Timing test activated window");w.render_to_image()?.save(out.join(format!("{name}.png")))?;std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&state(view,w,cx))?)?;Ok(())}
fn dots(total:usize,done:usize,per:usize)->String{(0..total).collect::<Vec<_>>().chunks(per).map(|group|group.iter().map(|i|if *i<done{'●'}else{'○'}).collect::<String>()).collect::<Vec<_>>().join(" ")}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App){cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());let fresh=PathBuf::from(std::env::var_os("SINGZ_GPUI_TIMING_GRIDLESS").unwrap());let variable=PathBuf::from(std::env::var_os("SINGZ_GPUI_TIMING_VARIABLE").unwrap());let selected=PathBuf::from(std::env::var_os("SINGZ_GPUI_TIMING_SELECTED").unwrap());let same=PathBuf::from(std::env::var_os("SINGZ_GPUI_TIMING_SAME_BPM").unwrap());let stage=std::env::var("SINGZ_GPUI_TIMING_STAGE").unwrap_or_else(|_|"exercise".into());
  macro_rules! wait{($p:ident,$app:ident=>$test:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,$app|{let $p=view.read($app);$test})?{break;}anyhow::ensure!(Instant::now()<deadline,"Timing timeout: {}",stringify!($test));}}};($p:ident,$window:ident,$app:ident=>$test:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,$window,$app|{draw($window,$app);let $p=view.read($app);$test})?{break;}anyhow::ensure!(Instant::now()<deadline,"Timing timeout: {}",stringify!($test));}}};}
  macro_rules! rate{($value:expr)=>{wait!(p,cx=>p.transport_flight.native_rate_pending.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|(s.rate-$value).abs()<0.00006)&&(p.tempo-$value).abs()<0.00006)};}
  macro_rules! resize_viewport{($width:expr,$height:expr)=>{{
   handle.update(cx,|_,w,_|w.resize(size(px($width),px($height))))?;
   let deadline=Instant::now()+Duration::from_secs(3);
   loop{cx.background_executor().timer(Duration::from_millis(10)).await;
    let actual=handle.update(cx,|_,w,cx|{draw(w,cx);(f32::from(w.viewport_size().width),f32::from(w.viewport_size().height))})?;
    if actual==($width,$height){break;}
    anyhow::ensure!(Instant::now()<deadline,"Native viewport did not settle: requested={}x{}, measured={actual:?}",$width,$height);
   }
  }};}

  let mut keyboard_trace=vec![];
  macro_rules! type_bpm{($value:expr)=>{{
   keyboard_trace.extend(handle.update(cx,|_,w,cx|focus_bpm(&view,w,cx))??);
   cx.background_executor().timer(Duration::from_millis(10)).await;
   let focused=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{draw(w,cx);let state=keyboard_state(&view,w,cx);anyhow::ensure!(state["inputFocused"]==true,"Actual BPM click did not focus input");Ok(state)})??;
   keyboard_trace.push(serde_json::json!({"phase":"focus-settled-before-key","timing":focused}));
   std::fs::write(out.join("bpm-keyboard-trace.json"),serde_json::to_vec_pretty(&keyboard_trace)?)?;
   let mut expected=String::new();
   for character in $value.chars(){
    if character.is_ascii_digit(){expected.push(character);}
    let admitted=handle.update(cx,|_,w,cx|{
     // dispatch_keystroke includes simulated IME. Do not draw here: Change
     // subscriptions must settle before a controlled-input render can run.
     let handled=w.dispatch_keystroke(Keystroke::parse(printable(character)).unwrap(),cx);
     serde_json::json!({"phase":"admitted","key":character.to_string(),"handled":handled,"timing":keyboard_state(&view,w,cx)})
    })?;
    keyboard_trace.push(admitted);
    let deadline=Instant::now()+Duration::from_secs(3);
    loop{
     cx.background_executor().timer(Duration::from_millis(5)).await;
     let settled=handle.update(cx,|_,w,cx|{draw(w,cx);keyboard_state(&view,w,cx)})?;
     keyboard_trace.push(serde_json::json!({"phase":"settled","key":character.to_string(),"expected":expected,"timing":settled}));
     std::fs::write(out.join("bpm-keyboard-trace.json"),serde_json::to_vec_pretty(&keyboard_trace)?)?;
     if settled["draft"]==expected&&settled["inputValue"]==expected&&settled["inputFocused"]==true{break;}
     anyhow::ensure!(Instant::now()<deadline,"Actual BPM key did not reach settled draft: key={character} expected={expected} state={settled}");
    }
   }
  }};}
  macro_rules! edit{($value:expr,$ending:expr)=>{{type_bpm!($value);handle.update(cx,|_,w,cx|key(w,cx,$ending))?;}};}
  macro_rules! queued_save_intent{($label:expr)=>{{
   let deadline=Instant::now()+Duration::from_secs(1);
   loop{cx.background_executor().timer(Duration::from_millis(10)).await;
    let current=handle.update(cx,|_,w,cx|{draw(w,cx);state(&view,w,cx)})?;
    if current["rateSaveRequested"]==true{anyhow::ensure!(current["ratePending"]==true&&current["saving"]==false,"Save escaped held native rate receipt at {}",$label);break;}
    anyhow::ensure!(Instant::now()<deadline,"Actual Ctrl+S did not queue Save at {}: {}",$label,current);
   }
  }};}

  if stage=="restart"{
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.is_some());rate!(1.25);
   for(width,height)in[(1280.,800.),(1060.,640.)]{resize_viewport!(width,height);handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(f32::from(w.viewport_size().width)==width&&f32::from(w.viewport_size().height)==height,"Restart capture used an unsettled viewport");let p=view.read(cx);let t=p.transport.read(cx).timing_state(w,cx);anyhow::ensure!(t["effectiveBpm"].as_f64()==Some(150.)&&t["draft"].is_null()&&t["dots"]=="","Restart did not restore accepted BPM without transient dots");shot(&view,w,cx,&out,&format!("saved-restart-{}",width as u32))})??;}
  }else{
   for(width,height)in[(1280.,800.),(1060.,640.)]{
    resize_viewport!(width,height);
    let requested_at=Instant::now();let mut loaded_at=None;
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
    // Opened precedes asynchronous analysis. A measured button can still be
    // disabled. Its automatic Save also fences rate admission; wait for the
    // complete readiness a singer needs before clicking it.
    wait!(p,w,cx=>{
     let loaded=!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project);
     if loaded&&loaded_at.is_none(){loaded_at=Some(Instant::now());}
     loaded&&p.analysis_progress.is_none()&&!p.saving&&!p.beat_auto_save&&p.transport.read(cx).timing_state(w,cx)["enabled"]==true
    });
    std::fs::write(out.join(format!("open-readiness-{}.json",width as u32)),serde_json::to_vec_pretty(&serde_json::json!({"requestToControlsMs":requested_at.elapsed().as_secs_f64()*1000.,"loadedToControlsMs":loaded_at.map(|instant|instant.elapsed().as_secs_f64()*1000.)}))?)?;
    let initial=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection))})?;
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("ready-{}",width as u32)))??;
    // Hold a real rate receipt, then toggle the existing loop before it settles.
    let loop_gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_RATE_RECEIPT_GATE").unwrap());
    let loop_ready=loop_gate.with_extension("ready");let _=std::fs::remove_file(&loop_ready);
    std::fs::write(&loop_gate,b"hold rate for loop")?;
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;
    let deadline=Instant::now()+Duration::from_secs(4);while !loop_ready.exists(){cx.background_executor().timer(Duration::from_millis(10)).await;anyhow::ensure!(Instant::now()<deadline,"Loop case did not reach the native rate receipt gate");}
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.looping&&p.transport_flight.native_rate_pending.is_some(),"Loop case did not begin with a loop and pending rate");view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Loop,cx));Ok(())})??;
    std::fs::remove_file(&loop_gate)?;
    wait!(p,cx=>p.transport_flight.native_rate_pending.is_none()&&!p.looping&&p.last_playback_status.as_ref().is_some_and(|s|s.loop_range.is_none()));
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("loop-after-rate-{}",width as u32)))??;
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Loop,cx)))?;
    wait!(p,cx=>p.looping&&p.last_playback_status.as_ref().is_some_and(|s|s.loop_range.is_some()));
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-down"))??;rate!(1.);
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;rate!(1.0083);
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-down"))??;rate!(1.);
    // Focus select-all is verified by replacing the existing three digits
    // using actual printable key events, rather than replacing InputState.
    edit!("a1b5c0","enter");rate!(1.25);
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let t=view.read(cx).transport.read(cx).timing_state(w,cx);anyhow::ensure!(t["inputValue"]=="150"&&!t["inputFocused"].as_bool().unwrap_or(true),"Real keyboard digits/select-all/Enter failed: {t}");shot(&view,w,cx,&out,&format!("typed-{}",width as u32))})??;
    edit!("175","escape");rate!(1.25);
    type_bpm!("96");handle.update(cx,|_,w,cx|click(w,cx,point(px(12.),px(80.))))?;rate!(0.8);
    edit!("9999","enter");rate!(1.5);
    edit!("1","enter");rate!(0.5);
    edit!("0","enter");rate!(0.5);
    edit!("120","enter");rate!(1.);
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!((p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection))==initial,"BPM edit changed independent mix/loop/selection");Ok(())})??;
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.playing&&!p.transport_flight.counting_in&&p.playhead.position()>0.1);
    let moving=handle.update(cx,|_,_,cx|view.read(cx).playhead.position())?;
    edit!("150","enter");rate!(1.25);
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.playing&&p.playhead.position()>=moving-0.1&&p.playhead.position()<moving+2.,"Rate change reset or paused native playback");Ok(())})??;
    for pause_action in ["button","space","rapid-buttons","rapid-buttons-final-play"]{
     let final_playing=pause_action=="rapid-buttons-final-play";
     if !handle.update(cx,|_,_,cx|view.read(cx).playing)?{handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.playing&&!p.transport_flight.counting_in);}
     wait!(p,cx=>p.playing&&p.transport_flight.native_play.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
     let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_RATE_RECEIPT_GATE").unwrap());let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold accepted rate while fast pause intent arrives")?;
     handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;
     let deadline=Instant::now()+Duration::from_secs(4);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(10)).await;anyhow::ensure!(Instant::now()<deadline,"Fast pause did not reach actual native rate receipt gate");}
     let bass_slot=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().lane_specs.iter().find(|lane|lane.id=="bass").unwrap().slot)?;
     if pause_action=="button"{handle.update(cx,|_,w,cx|mute_lane(&view,w,cx,bass_slot))??;wait!(p,cx=>!p.muted[bass_slot]);}
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.transport_flight.native_rate_pending.is_some()&&p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing),"Fast pause did not begin with real advancing playback and a held rate receipt");if pause_action!="space"{press(&view,w,cx,"transport-play")?;}else{
      // Accessible BPM buttons own keyboard focus after a click. This case
      // targets the player's Space handler, so establish its actual local
      // focus explicitly, retaining the focus assertion before dispatch.
      let focus=view.read(cx).focus_handle.clone();focus.focus(w,cx);draw(w,cx);
      anyhow::ensure!(view.read(cx).focus_handle.is_focused(w),"Space pause has no actual app-local player focus");key(w,cx,"space");}Ok(())})??;
     wait!(p,cx=>p.transport_flight.native_play.payload().is_some_and(|on|!*on));
     if pause_action.starts_with("rapid-buttons"){
      handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.transport_flight.native_play.payload().is_some_and(|on|*on));
      handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.transport_flight.native_play.payload().is_some_and(|on|!*on));
     }
     if final_playing{handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.transport_flight.native_play.payload().is_some_and(|on|*on));}
     let latest_play_serial=handle.update(cx,|_,_,cx|view.read(cx).transport_flight.native_play.current_serial().unwrap())?;
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("held-rate-{pause_action}-pending-{}",width as u32)))??;
     let released=Instant::now();std::fs::remove_file(&gate)?;
     let mut acknowledgement_trace=vec![];let deadline=Instant::now()+Duration::from_secs(5);
     loop{cx.background_executor().timer(Duration::from_millis(5)).await;
      let (settled,sample)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{let p=view.read(cx);if let Some((on,serial))=p.transport_flight.native_play.current().map(|(_,serial,&on)|(on,serial)){anyhow::ensure!(on==final_playing&&serial==latest_play_serial,"An older playback receipt replaced the latest serial intent");}let settled=p.transport_flight.native_rate_pending.is_none()&&p.transport_flight.native_play.is_none()&&p.playing==final_playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing==final_playing&&s.sampled_at>=released&&(pause_action!="button"||observed_mute(s,"bass")==Some(false)));Ok((settled,state(&view,w,cx)))})??;
      acknowledgement_trace.push(sample);if settled{break;}anyhow::ensure!(Instant::now()<deadline,"Latest playback serial did not settle to its actual native target");
     }
     std::fs::write(out.join(format!("held-rate-{pause_action}-ack-trace-{}.json",width as u32)),serde_json::to_vec_pretty(&serde_json::json!({"latestSerial":latest_play_serial,"targetPlaying":final_playing,"scope":"observed app states; individual older acknowledgements may coalesce between frames","samples":acknowledgement_trace}))?)?;
     let paused_position=handle.update(cx,|_,_,cx|view.read(cx).playhead.position())?;
     cx.background_executor().timer(Duration::from_millis(100)).await;
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.playing==final_playing&&p.transport_flight.native_play.is_none()&&(if final_playing{p.playhead.position()>=paused_position-0.1}else{(p.playhead.position()-paused_position).abs()<0.03})&&p.last_playback_status.as_ref().is_some_and(|s|s.playing==final_playing&&s.sampled_at>=released),"Held rate receipt erased the latest {pause_action} playback intent");let mut expected_mute=initial.1;if pause_action=="button"{expected_mute[bass_slot]=false;anyhow::ensure!(p.last_playback_status.as_ref().is_some_and(|s|observed_mute(s,"bass")==Some(false)),"Actual M intent did not reach the existing native graph");}anyhow::ensure!((p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection))==(initial.0,expected_mute,initial.2,initial.3,initial.4,initial.5,initial.6),"Fast pause rate mutation changed independent mix/loop/selection or lost mixer intent");shot(&view,w,cx,&out,&format!("held-rate-{pause_action}-{}-{}",if final_playing{"playing"}else{"paused"},width as u32))})??;
     if final_playing{handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>!p.playing&&p.transport_flight.native_play.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));}
     if pause_action=="button"{
      let restore_at=Instant::now();handle.update(cx,|_,w,cx|mute_lane(&view,w,cx,bass_slot))??;
      wait!(p,cx=>p.muted[bass_slot]&&p.last_playback_status.as_ref().is_some_and(|s|s.sampled_at>=restore_at&&observed_mute(s,"bass")==Some(true)));
      handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!((p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection))==initial,"Actual mixer restore lost source mix");shot(&view,w,cx,&out,&format!("held-rate-mixer-restored-{}",width as u32))})??;
     }
    }
    // Candidate-only analysis visual. Production native progress is tested by
    // its own inference suite; this frozen state does not claim model work.
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{p.timing_analysis_override=Some(("Finding the beat".into(),0.42));cx.notify();});let ui=view.read(cx).transport.clone();draw(w,cx);let t=ui.read(cx).timing_state(w,cx);anyhow::ensure!(t["baseBpm"].as_f64()==Some(120.)&&t["analysisPercent"].as_f64()==Some(42.)&&t["enabled"]==false,"Analysis did not override accepted old BPM: {t}");let before=view.read(cx).tempo;press(&view,w,cx,"transport-bpm-up")?;press(&view,w,cx,"transport-bpm")?;text(w,cx,"999");anyhow::ensure!(ui.read(cx).timing_state(w,cx)["inputFocused"]==false&&view.read(cx).tempo==before,"Disabled analysis controls accepted editing");shot(&view,w,cx,&out,&format!("frozen-analysis-candidate-{}",width as u32))?;view.update(cx,|p,cx|{p.timing_analysis_override=None;cx.notify();});Ok(())})??;
    // Ordinary same-BPM progress updates retain a draft, but a different
    // project's explicit lifecycle reset must discard it even when both base
    // and effective BPM values happen to remain exactly120.
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project));rate!(1.);
    type_bpm!("175");
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(same.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==same));rate!(1.);
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);let t=p.transport.read(cx).timing_state(w,cx);anyhow::ensure!(t["baseBpm"].as_f64()==Some(120.)&&t["effectiveBpm"].as_f64()==Some(120.)&&t["inputValue"]=="120"&&t["draft"].is_null()&&t["inputFocused"]==false&&p.transport_flight.native_rate_pending.is_none()&&p.transport_flight.native_rate_queued.is_none(),"Same-BPM project inherited an uncommitted old-song draft: {t}");shot(&view,w,cx,&out,&format!("same-bpm-reset-{}",width as u32))})??;
    // Count-in is configured through actual measured metronome controls,
    // never fabricated DSP or count-in receipts.
    for(case,path,bars,expected_per)in[("grid",project.clone(),2usize,4usize),("gridless",fresh.clone(),1usize,3usize),("variable",variable.clone(),1usize,3usize),("selected-variable",selected.clone(),1usize,3usize)]{
     handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==path));
     if case=="gridless"{handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let t=view.read(cx).transport.read(cx).timing_state(w,cx);anyhow::ensure!(t["baseBpm"].is_null()&&t["enabled"]==false&&t["inputValue"]=="—","Missing BPM was editable: {t}");let before=view.read(cx).tempo;press(&view,w,cx,"transport-bpm-up")?;anyhow::ensure!(view.read(cx).tempo==before,"Disabled missing BPM edited tempo");shot(&view,w,cx,&out,&format!("missing-{}",width as u32))})??;}
     handle.update(cx,|_,w,cx|met_toggle(&view,w,cx))??;wait!(p,cx=>p.metronome_open);
     handle.update(cx,|_,w,cx|met(&view,w,cx,&format!("met-count-{bars}")))??;wait!(p,cx=>p.metronome_flight.metronome.is_none()&&p.metronome.count_in_bars==bars as u32);
     handle.update(cx,|_,w,cx|met_toggle(&view,w,cx))??;wait!(p,cx=>!p.metronome_open);
     let anchor=if case=="variable"||case=="selected-variable"{0.5}else{3.};
     handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.playhead.seek(anchor);p.seek_native(cx);}))?;wait!(p,cx=>p.playhead.pending_seek().is_none()&&(p.playhead.position()-anchor).abs()<0.03);
     handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;
     let deadline=Instant::now()+Duration::from_secs(12);let mut trace=vec![];let mut observed=std::collections::BTreeSet::new();let mut prior_done=0;let mut finished=false;
     loop{
      cx.background_executor().timer(Duration::from_millis(35)).await;
      let sample=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{draw(w,cx);let p=view.read(cx);let ui=p.transport.read(cx).timing_state(w,cx);let count=&ui["countIn"];
       if !count.is_null(){let total=count["total"].as_u64().unwrap() as usize;let done=count["done"].as_u64().unwrap() as usize;let per=count["perBar"].as_u64().unwrap() as usize;anyhow::ensure!(per==expected_per&&total==per*bars&&done<=total,"Native count-in grouping differs: {ui}");anyhow::ensure!(ui["dots"]==dots(total,done,per),"Count-in glyph grouping differs");anyhow::ensure!((p.playhead.position()-anchor).abs()<0.04,"Song anchor advanced during audible count-in: {} -> {}",anchor,p.playhead.position());let native=p.last_playback_status.as_ref().unwrap();let heard=native.count_in_heard.ok_or_else(||anyhow::anyhow!("UI dots have no accepted native heard clock"))?;anyhow::ensure!(heard.total==total&&heard.per_bar==per&&heard.seconds_to_landing<=0.,"Dots differ from native clock");if observed.insert(done)&&observed.len()<=3{shot(&view,w,cx,&out,&format!("count-{case}-{}-{done}",width as u32))?;}}
       Ok(state(&view,w,cx))})??;
      let count=&sample["timing"]["countIn"];
      if !count.is_null(){let done=count["done"].as_u64().unwrap() as usize;anyhow::ensure!(done>=prior_done,"Live dots moved backwards");prior_done=done;}else if !observed.is_empty()&&sample["playing"]==true&&sample["position"].as_f64().unwrap()>anchor as f64+0.05{finished=true;trace.push(sample);break;}
      trace.push(sample);anyhow::ensure!(Instant::now()<deadline,"Live count-in failed to finish");
     }
     anyhow::ensure!(finished&&observed.len()>=2,"No actual count-in progression observed");std::fs::write(out.join(format!("live-{case}-{}.json",width as u32)),serde_json::to_vec_pretty(&trace)?)?;
     handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>!p.playing);
     // A second real count-in must disappear on an actual paused cancellation.
     handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.transport_flight.counting_in);
     handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>!p.playing&&!p.transport_flight.counting_in);
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(view.read(cx).transport.read(cx).timing_state(w,cx)["dots"]=="","Cancelled count-in left dots");Ok(())})??;
    }
    // Explicitly delayed delivery of an actual old native count-in packet.
    handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-play"))??;wait!(p,cx=>p.transport_flight.counting_in);
    let(old_epoch,old)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.native_epoch,p.last_playback_status.clone().unwrap())})?;
    type_bpm!("175");
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
     // Draft on the old song, then begin a real native Open. Controls behind
     // that operation must not apply a tempo to the arriving different song.
     view.update(cx,|p,cx|p.open_project(fresh.clone(),cx));
     anyhow::ensure!(view.read(cx).loading,"Source operation was not actually pending");
     press(&view,w,cx,"transport-bpm-up")?;press(&view,w,cx,"transport-bpm")?;text(w,cx,"999");key(w,cx,"enter");
     shot(&view,w,cx,&out,&format!("loading-blocked-{}",width as u32))
    })??;wait!(p,cx=>!p.loading&&p.native_epoch!=old_epoch&&p.project.as_ref().is_some_and(|p|p.dir==fresh));
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{view.update(cx,|p,cx|p.playback_status(old_epoch,old,cx));draw(w,cx);let p=view.read(cx);let timing=p.transport.read(cx).timing_state(w,cx);anyhow::ensure!(timing["dots"]==""&&timing["baseBpm"].is_null()&&timing["draft"].is_null()&&!p.playing&&p.transport_flight.native_rate_pending.is_none()&&(p.tempo-1.).abs()<0.00001,"Stale project or busy input delivered BPM/dots/play state: {timing}");shot(&view,w,cx,&out,&format!("stale-rejected-{}",width as u32))})??;
   }
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project));rate!(1.);
   // Hold a real accepted native rate receipt. Further actual BPM edits remain
   // available, coalesce to the latest desired value, and fence Save/navigation.
   let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_RATE_RECEIPT_GATE").unwrap());let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);let before=std::fs::read(project.join("project.json"))?;std::fs::write(&gate,b"hold accepted native rate receipt")?;
   handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;
   let deadline=Instant::now()+Duration::from_secs(4);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(10)).await;anyhow::ensure!(Instant::now()<deadline,"Native rate receipt gate was not reached");}
   handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;
   edit!("150","enter");
   wait!(p,cx=>p.transport_flight.native_rate_pending.is_some()&&p.transport_flight.native_rate_queued.is_some());
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let timing=view.read(cx).transport.read(cx).timing_state(w,cx);anyhow::ensure!(timing["enabled"]==true&&timing["effectiveBpm"].as_f64()==Some(150.),"Pending rate blocked rapid source BPM editing: {timing}");key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"});Ok(())})??;
   queued_save_intent!("successful latest-rate Save/navigation");
   let old_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(fresh.clone(),cx)))?;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.loading&&!p.saving&&p.native_epoch==old_epoch&&p.project.as_ref().is_some_and(|p|p.dir==project),"Save/navigation escaped pending accepted rate");shot(&view,w,cx,&out,"rate-queued-save-navigation")})??;
   anyhow::ensure!(std::fs::read(project.join("project.json"))?==before,"Pending rate published an early Save");std::fs::remove_file(&gate)?;
   wait!(p,cx=>!p.loading&&!p.saving&&p.transport_flight.native_rate_pending.is_none()&&p.project.as_ref().is_some_and(|p|p.dir==fresh));
   let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?;anyhow::ensure!(saved["settings"]["tempo"]==1.25,"Queued Save lost the latest accepted rate");std::fs::write(out.join("queued-save-project.json"),serde_json::to_vec_pretty(&saved)?)?;
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project));rate!(1.25);
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;wait!(p,cx=>!p.saving&&p.saved_seq==p.edit_seq);
   handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"saved-final"))??;
   // A fatal owned-helper fault can overtake the latest queued rate.
   // The real backend FIFO receives fault injection while rateA's actual
   // accepted receipt is gated; root cannot enqueue rateB untilA is released.
   let before_failure=std::fs::read(project.join("project.json"))?;
   let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold actual rateA before generic helper failure")?;
   handle.update(cx,|_,w,cx|press(&view,w,cx,"transport-bpm-up"))??;
   let deadline=Instant::now()+Duration::from_secs(4);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(10)).await;anyhow::ensure!(Instant::now()<deadline,"Failure regression did not gate actual native rateA");}
   edit!("144","enter");wait!(p,cx=>p.transport_flight.native_rate_pending.is_some()&&p.transport_flight.native_rate_queued.is_some());
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
   queued_save_intent!("generic native failure Save/navigation");
   handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(fresh.clone(),cx)))?;
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.transport_flight.native_rate_pending.is_some()&&p.transport_flight.native_rate_queued.is_some()&&p.transport_flight.native_rate_save_requested&&p.transport_flight.native_rate_navigation.as_ref().is_some_and(|(path,source)|path==&fresh&&!*source)&&!p.loading&&!p.saving,"Failed-rate regression did not actually queue latest rate/Save/navigation");p.backend.as_ref().ok_or_else(||anyhow::anyhow!("Native backend missing"))?.fail_owned_audio(p.native_epoch)?;Ok(())})??;
   handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"rate-failure-queued"))??;std::fs::remove_file(&gate)?;
   wait!(p,cx=>p.notice.is_some()&&p.transport_flight.native_rate_pending.is_none()&&p.transport_flight.native_rate_queued.is_none());
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.as_deref().is_some_and(|text|text.contains("The queued Save did not run"))&&!p.transport_flight.native_rate_save_requested&&!p.saving&&p.transport_flight.native_rate_navigation.as_ref().is_some_and(|(path,source)|path==&fresh&&!*source)&&p.project.as_ref().is_some_and(|retained|retained.dir==project)&&p.tracks_audio_failed&&!p.playing&&p.playhead.anchor().is_none()&&p.last_playback_status.is_none(),"Generic helper failure lost queued navigation or falsely completed Save: {:?}",p.notice);shot(&view,w,cx,&out,"rate-failure-notice")})??;
   anyhow::ensure!(std::fs::read(project.join("project.json"))?==before_failure,"Generic native failure published an unaccepted queued rate Save");
   handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,cx=>p.notice.is_none()&&!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==fresh));
   anyhow::ensure!(std::fs::read(project.join("project.json"))?==before_failure,"Acknowledging failure replayed the cancelled Save");
   handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"rate-failure-navigation-after-ack"))??;
  }
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"stage":stage,"sizes":2,"hidden":true,"muted":true,"actualBpmKeyboard":stage=="exercise","actualCountInClock":stage=="exercise","heldRatePauseButtonAndSpace":stage=="exercise","heldRateRapidPausePlayPause":stage=="exercise","heldRateRapidFinalPlay":stage=="exercise","heldRateNativeMixerReceipt":stage=="exercise","savedNativeRateRestored":stage=="restart","frozenAnalysis":if stage=="exercise"{"candidate visual only; not inference proof"}else{"not run"},"liveFps":"unmeasured"}))?)?;Ok(())
 }.await;
 if let Err(error)=result{eprintln!("NATIVE_TRANSPORT_TIMING failed: {error:#}");let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));}
 let _=cx.update(|cx|cx.quit());
 }).detach();}

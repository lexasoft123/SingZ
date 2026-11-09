//! Hidden real native Settings: inventory, non-pausing browse, explicit route pause.
use super::*;
use std::{path::PathBuf, time::Duration};
fn click(window: &mut Window, cx: &mut App, x: f32, y: f32) {
    let position = point(px(x), px(y));
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    let _ = window.draw(cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    if std::env::var_os("SINGZ_GPUI_SETTINGS_PREFS_TEST").is_some() {
        run_preferences(handle, view, out, cx);
        return;
    }
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let config=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").ok_or_else(||anyhow::anyhow!("Use an isolated SINGZ_GPUI_CONFIG_DIR"))?);
  let path=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing test project"))?);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
  if std::env::var_os("SINGZ_GPUI_SETTINGS_MISSING_START").is_some(){
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{cx.background_executor().timer(Duration::from_millis(20)).await;
      if handle.update(cx,|_,_,cx|view.read(cx).notice.as_ref().is_some_and(|n|n.contains("unavailable")))?{break;}anyhow::ensure!(Instant::now()<deadline,"Missing saved output did not fail explicitly");
    }
    // An error notice must block the actual header control underneath it.
    handle.update(cx,|_,window,cx|click(window,cx,if cfg!(any(target_os="windows",target_os="linux")){1114.}else{1248.},26.))?;
    cx.background_executor().timer(Duration::from_millis(30)).await;
    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Library&&p.notice.is_some(),"Notice allowed a click through to Settings");window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);Ok(())})??;
    cx.background_executor().timer(Duration::from_millis(30)).await;
    handle.update(cx,|_,window,cx|click(window,cx,if cfg!(any(target_os="windows",target_os="linux")){1114.}else{1248.},26.))?;
    cx.background_executor().timer(Duration::from_millis(100)).await;
    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);let (_,uid,_,error)=p.settings.read(cx).native_snapshot();anyhow::ensure!(p.screen==Screen::Settings&&p.notice.is_none()&&p.project.is_none()&&!p.playing&&uid=="missing-saved-output"&&error.is_some(),"Missing saved route was silently replaced");let _=window.draw(cx);window.render_to_image()?.save(out.join("saved-output-missing.png"))?;click(window,cx,600.,168.);Ok(())})??;
    cx.background_executor().timer(Duration::from_millis(30)).await;
    handle.update(cx,|_,window,cx|click(window,cx,600.,202.))?;
    let deadline=Instant::now()+Duration::from_secs(15);
    loop{cx.background_executor().timer(Duration::from_millis(20)).await;let recovered=handle.update(cx,|_,_,cx|{let p=view.read(cx);let (_,uid,busy,error)=p.settings.read(cx).native_snapshot();uid.is_empty()&&!busy&&error.is_none()})?;if recovered{break;}anyhow::ensure!(Instant::now()<deadline,"Selecting default did not repair saved output");}
    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
  }
  let deadline=Instant::now()+Duration::from_secs(30);
  let target=loop{
   cx.background_executor().timer(Duration::from_millis(20)).await;
   let target=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);if p.project.is_none(){return Ok(None);}let (inventory,_,_,error)=p.settings.read(cx).native_snapshot();anyhow::ensure!(error.is_none(),"{error:?}");Ok(inventory.and_then(|i|i.devices.into_iter().find(|d|d.outputs>0)))})??;
   if let Some(target)=target{break target;}anyhow::ensure!(Instant::now()<deadline,"Native inventory/project timeout");
  };
  handle.update(cx,|_,window,cx|click(window,cx,96.,718.))?;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.playing&&p.position>0.1})?{break;}anyhow::ensure!(Instant::now()<deadline,"Play failed");}
  // Deliberately hold the UI while the independent native process keeps running.
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let before=view.read(cx).position;std::thread::sleep(Duration::from_millis(350));view.update(cx,|p,cx|p.poll_backend(cx));let p=view.read(cx);anyhow::ensure!(p.position>before+0.2,"Telemetry retained the oldest reading during a UI stall");anyhow::ensure!(p.native_anchor.is_some_and(|(_,at)|at.elapsed()<Duration::from_millis(150)),"Telemetry lost its sample timestamp");Ok(())})??;
  let (before,inventory_revision,active_uid)=handle.update(cx,|_,window,cx|{let p=view.read(cx);let position=p.position;let revision=p.settings.read(cx).inventory_revision();let active_uid=p.last_playback_status.as_ref().unwrap().output_uid.clone();click(window,cx,if cfg!(any(target_os="windows",target_os="linux")){1114.}else{1248.},26.);(position,revision,active_uid)})?;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;
    let fresh=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);let settings=p.settings.read(cx);
      if settings.inventory_revision()<=inventory_revision{return Ok(false);}
      let (inventory,uid,_,error)=settings.native_snapshot();anyhow::ensure!(error.is_none(),"Active output disappeared from fresh inventory: {error:?}");
      let inventory=inventory.ok_or_else(||anyhow::anyhow!("Missing refreshed inventory"))?;
      let output=inventory.output(&uid)?;anyhow::ensure!(output.uid==active_uid&&p.playing&&p.position>before,"Settings refresh changed the active output or stopped playback");Ok(true)})??;
    if fresh{break;}anyhow::ensure!(Instant::now()<deadline,"Settings inventory refresh did not finish");
  }
  cx.background_executor().timer(Duration::from_millis(150)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Settings&&p.playing&&p.position>before+0.05,"Browsing Settings paused playback");let _=window.draw(cx);window.render_to_image()?.save(out.join("native-settings.png"))?;click(window,cx,600.,168.);Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  let position=handle.update(cx,|_,window,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(p.settings.read(cx).smoke_snapshot().4==Some("settings-output"),"Native output selector did not open");let _=window.draw(cx);window.render_to_image()?.save(out.join("native-output-selector.png"))?;let p=view.read(cx);let position=p.native_anchor.map_or(p.position,|(position,anchor)|position+anchor.elapsed().as_secs_f32()*p.native_rate);click(window,cx,600.,230.);Ok(position)})??;
  let deadline=Instant::now()+Duration::from_secs(15);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let done=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);let (_,uid,busy,error)=p.settings.read(cx).native_snapshot();anyhow::ensure!(error.is_none(),"{error:?}");Ok(uid==target.uid&&!busy&&!p.playing)})??;if done{break;}anyhow::ensure!(Instant::now()<deadline,"Native output route did not settle");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!((p.position-position).abs()<0.2,"Route changed song position: {} vs {position}",p.position);let _=window.draw(cx);window.render_to_image()?.save(out.join("native-output-applied.png"))?;Ok(())})??;
  let prefs:serde_json::Value=serde_json::from_slice(&std::fs::read(config.join("audio.json"))?)?;anyhow::ensure!(prefs["outputUid"]==target.uid,"Output preference was not persisted");
  let channel_count=handle.update(cx,|_,window,cx|->anyhow::Result<usize>{let p=view.read(cx);let inventory=p.settings.read(cx).native_snapshot().0.unwrap();let uid=if p.mic_prefs.input.is_empty(){&inventory.default_input}else{&p.mic_prefs.input};let count=inventory.devices.iter().find(|d|&d.uid==uid).map_or(0,|d|d.inputs);if count>8{let bounds=p.settings.read(cx).field_bounds("settings-channel").ok_or_else(||anyhow::anyhow!("Channel selector bounds missing"))?;click(window,cx,f32::from(bounds.center().x),f32::from(bounds.center().y));}Ok(count)})??;
  if channel_count>8{
    cx.background_executor().timer(Duration::from_millis(30)).await;
    let popup=handle.update(cx,|_,window,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(p.settings.read(cx).smoke_snapshot().4==Some("settings-channel"),"Channel popup did not open");let bounds=p.settings.read(cx).field_bounds("settings-channel").unwrap();window.simulate_next_frame(cx);window.refresh();let _=window.draw(cx);let position=point(bounds.center().x,bounds.bottom()+px(60.));window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position,delta:ScrollDelta::Pixels(point(px(0.),px(-2000.))),..Default::default()}),cx);Ok(bounds)})??;
    cx.background_executor().timer(Duration::from_millis(30)).await;
    handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).smoke_snapshot().3.abs()<1.,"Channel menu wheel scrolled the Settings page");let _=window.draw(cx);window.render_to_image()?.save(out.join("native-channel-menu-bottom.png"))?;click(window,cx,f32::from(popup.center().x),f32::from(popup.bottom())+2.+280.-18.);Ok(())})??;
    let deadline=Instant::now()+Duration::from_secs(5);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).mic_prefs.channel==channel_count-1)?{break;}anyhow::ensure!(Instant::now()<deadline,"Last native input channel is unreachable");}
  }
  handle.update(cx,|_,window,cx|click(window,cx,220.,732.))?;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Player,"Close did not return to Player");click(window,cx,96.,718.);Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>position+0.05)})?{break;}anyhow::ensure!(Instant::now()<deadline,"Explicit Play after route did not reach native playback");}
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).playing,"Explicit Play after route did not resume");view.read(cx).backend.as_ref().unwrap().output("missing-native-device".into())?;Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let done=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.playing&&p.notice.is_none(),"Invalid output destroyed playback: playing={}, position={}, duration={}, notice={:?}, status={:?}",p.playing,p.position,p.duration,p.notice,p.last_playback_status);let (_,uid,_,error)=p.settings.read(cx).native_snapshot();Ok(uid==target.uid&&error.is_some_and(|e|e.contains("unavailable")))})??;if done{break;}anyhow::ensure!(Instant::now()<deadline,"Missing output was not reported");}
  let _=handle.update(cx,|_,window,cx|{click(window,cx,if cfg!(any(target_os="windows",target_os="linux")){1114.}else{1248.},26.);let _=window.draw(cx);window.render_to_image().unwrap().save(out.join("native-output-missing.png")).unwrap();});
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeInventory":true,"freshInventoryPreservesActiveOutput":true,"nativeResumeConfirmedBeforeFault":true,"browsePreservesPlayback":true,"selectedUid":target.uid,"appliedRoutePauses":true,"explicitPlayRequired":true,"invalidRouteRetainsPlayback":true,"persisted":true,"channelInventoryCount":channel_count,"lastChannelMenuSelected":channel_count>8}))?)?;
  Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("NATIVE_SETTINGS passed: actual inventory, selector click, browse keeps playing, route pauses/persists, explicit resume, missing route retains playback");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=handle.update(cx,|_,window,cx|{let _=window.draw(cx);if let Ok(image)=window.render_to_image(){let _=image.save(out.join("native-settings-failure.png"));}});eprintln!("NATIVE_SETTINGS failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();});std::process::exit(1);}}
}).detach();
}


// Synthetic inventory, real Settings controls/subscription/persistence. No capture
// or monitoring is started; the normal native inventory journey stays separate.
fn draw_preferences(window: &mut Window, cx: &mut App) {
    for _ in 0..3 { window.simulate_next_frame(cx); window.refresh(); let _ = window.draw(cx); }
}
fn preferences_inventory() -> audio_devices::Inventory {
    let mut inventory = super::ui_monitor::fixture_inventory();
    inventory.devices.push(audio_devices::Device { uid: "singz:fake-stereo".into(), label: "Muted stereo fixture".into(), inputs: 2, outputs: 2, input_probe_busy: false, output_probe_busy: false });
    inventory
}
fn preferences_field(view: &Entity<Player>, window: &mut Window, cx: &mut App, id: &'static str) -> anyhow::Result<Bounds<Pixels>> {
    draw_preferences(window,cx);
    let bounds=view.read(cx).settings.read(cx).field_bounds(id).ok_or_else(||anyhow::anyhow!("Missing {id}"))?;
    // Scroll the actual modal until the requested field has room for its menu.
    window.dispatch_event(PlatformInput::Scroll(ScrollEvent { position: point(px(800.),px(400.)), delta: ScrollDelta::Pixels(point(px(0.),px(210.)-bounds.center().y)), ..Default::default() }),cx);
    draw_preferences(window,cx);
    let bounds=view.read(cx).settings.read(cx).field_bounds(id).ok_or_else(||anyhow::anyhow!("Missing scrolled {id}"))?;
    anyhow::ensure!(bounds.center().y>px(70.)&&bounds.center().y<window.viewport_size().height-px(65.),"{id} is outside modal viewport: {bounds:?}");
    Ok(bounds)
}
fn preferences_choose(view: &Entity<Player>, window: &mut Window, cx: &mut App, id: &'static str, index: usize) -> anyhow::Result<()> {
    let bounds=preferences_field(view,window,cx,id)?;
    click(window,cx,f32::from(bounds.center().x),f32::from(bounds.center().y));draw_preferences(window,cx);
    let option=view.read(cx).settings.read(cx).option_bounds(id,index).ok_or_else(||anyhow::anyhow!("Missing {id} option {index}"))?;
    anyhow::ensure!(option.center().y<window.viewport_size().height-px(35.),"Option outside viewport");
    click(window,cx,f32::from(option.center().x),f32::from(option.center().y));draw_preferences(window,cx);Ok(())
}
fn preferences_capture(view: &Entity<Player>, window: &mut Window, cx: &mut App, out: &std::path::Path, name: &str) -> anyhow::Result<()> {
    draw_preferences(window,cx);anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Settings test presented or activated a window");
    let p=view.read(cx);let (prefs,error)=p.settings.read(cx).input_preferences_snapshot();
    anyhow::ensure!(!p.monitor_requested&&!p.mic_requested&&!p.mic_permission_requested,"Settings regression requested hardware");
    let state=serde_json::json!({"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"preferences":prefs.patch(),"error":error,"labels":{"input":p.settings.read(cx).field_label("settings-channel"),"left":p.settings.read(cx).field_label("settings-output-left"),"right":p.settings.read(cx).field_label("settings-output-right")},"hidden":true,"active":false,"inventory":"synthetic; real Settings controls and persistence","liveFps":"unmeasured: hidden window"});
    window.render_to_image()?.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&state)?)?;Ok(())
}
fn preferences_key(window: &mut Window, cx: &mut App, name: &'static str) {
    let stroke=Keystroke::parse(name).unwrap();window.dispatch_keystroke(stroke.clone(),cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn preferences_tab_to(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..32 {draw_preferences(window,cx);if view.read(cx).settings.read(cx).focused_control(window,cx)==Some(id){return Ok(());}preferences_key(window,cx,"tab");let _=preferences_keyboard_state(view,window,cx,"Tab traversal")?;}
    anyhow::bail!("Actual Tab did not reach {id}: {:?}",view.read(cx).settings.read(cx).keyboard_snapshot(window,cx))
}
fn preferences_keyboard_state(view:&Entity<Player>,window:&mut Window,cx:&mut App,step:&str)->anyhow::Result<serde_json::Value> {
    draw_preferences(window,cx);let p=view.read(cx);let settings=p.settings.read(cx);let state=settings.keyboard_snapshot(window,cx);
    anyhow::ensure!(!p.playing&&!p.monitor_requested&&!p.mic_requested&&!p.mic_permission_requested&&p.native_play_intent.is_none(),"Settings keys escaped to song or hardware at {step}");
    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Settings keyboard test activated its window");
    if p.screen==Screen::Settings {
        anyhow::ensure!(state["focusInside"]==true,"Tab focus escaped Settings at {step}: {state}");
        if let Some(bounds)=state["focusedBounds"].as_array() {
            let top=bounds[1].as_f64().unwrap();let bottom=top+bounds[3].as_f64().unwrap();
            anyhow::ensure!(top>=0.&&bottom<=f32::from(window.viewport_size().height) as f64,"Focused control clipped by window at {step}: {state}");
            if !matches!(state["focusedControl"].as_str(),Some("settings-quick-start"|"settings-tab-audio"|"settings-close")) {
                let viewport=state["viewportBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing Settings scroll viewport"))?;
                let start=viewport[1].as_f64().unwrap();let end=start+viewport[3].as_f64().unwrap();
                anyhow::ensure!(top>=start-1.&&bottom<=end+1.,"Tab failed to scroll focused control into view at {step}: {state}");
            }
        } else if !matches!(step,"fixture-disabled-focus-recovery"|"fixture-unmounted-focus-recovery")||!state["focusedControl"].is_null() {anyhow::bail!("Focused Settings control has no measured bounds at {step}: {state}");}
    }
    Ok(serde_json::json!({"step":step,"fixtureOnlyTransition":matches!(step,"fixture-disabled-focus-recovery"|"fixture-unmounted-focus-recovery"),"keyboard":state,"preferences":p.mic_prefs.patch(),"playing":p.playing,"position":p.position,"monitorRequested":p.monitor_requested,"micRequested":p.mic_requested}))
}
fn run_preferences(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_TEST_NO_CAPTURE").is_some()&&std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),"Preferences regression requires isolated config and disabled capture");
            std::fs::create_dir_all(&out)?;
            let config=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap());
            let deadline=Instant::now()+Duration::from_secs(10);
            loop {cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.mic_prefs_valid&&p.settings.read(cx).inventory_revision()>0})?{break;}anyhow::ensure!(Instant::now()<deadline,"Initial preferences and native inventory did not load");}
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,window,cx|{window.resize(size(px(width),px(height)));view.update(cx,|p,cx|{
                    p.screen=Screen::Settings;p.notice=None;
                    p.settings.update(cx,|s,cx|{s.on_open(cx);s.set_inventory(Ok(preferences_inventory()),cx);cx.emit(settings::SettingsEvent::InputPrefs(microphone::Prefs{input:"singz:fake-duplex".into(),monitor_output:"singz:fake-duplex".into(),..Default::default()}));});
                });})?;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                macro_rules! choose { ($id:expr,$index:expr)=>{{
                    handle.update(cx,|_,window,cx|preferences_choose(&view,window,cx,$id,$index))??;
                    cx.background_executor().timer(Duration::from_millis(30)).await;
                }}; }
                let sequence=handle.update(cx,|_,_,cx|view.read(cx).mic_pref_seq)?;
                choose!("settings-output-left",1);
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                    let p=view.read(cx);let (prefs,_)=p.settings.read(cx).input_preferences_snapshot();
                    anyhow::ensure!(prefs.outputs==[0,1]&&p.mic_pref_seq==sequence&&p.settings.read(cx).smoke_snapshot().4==Some("settings-output-left"),"Duplicate channel click changed preferences or closed menu");
                    window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);draw_preferences(window,cx);Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).smoke_snapshot().4.is_none(),"Escape did not dismiss duplicate channel popup");Ok(())})??;
                choose!("settings-output-left",6);
                choose!("settings-output-right",7);
                choose!("settings-monitor-output",1);
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.outputs==[6,7],"Reselecting same device reset valid custom channels");Ok(())})??;
                choose!("settings-monitor-output",2);
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                    anyhow::ensure!(view.read(cx).mic_prefs.outputs==[0,1]&&view.read(cx).mic_prefs.monitor_output=="singz:fake-stereo","Changing to stereo retained out-of-range channels");
                    preferences_capture(&view,window,cx,&out,&format!("preferences-device-reset-{}",width as u32))?;Ok(())
                })??;
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;let saved=std::fs::read(config.join("audio.json")).ok().and_then(|bytes|serde_json::from_slice::<serde_json::Value>(&bytes).ok());if saved.as_ref().is_some_and(|raw|raw["monitorOutputUid"]=="singz:fake-stereo"&&raw["monitorOutputChannels"]==serde_json::json!([0,1])){break;}anyhow::ensure!(Instant::now()<deadline,"Control change was not persisted");}
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                    let settings=view.read(cx).settings.clone();let mut stale=view.read(cx).mic_prefs.clone();stale.input="singz:fake-stereo".into();stale.outputs=[6,7];stale.channel=0;stale.headphones=true;
                    settings.update(cx,|s,cx|{s.set_input_prefs(stale,cx);s.input_pref_error("Preferences could not be saved: isolated regression fixture".into(),cx);});
                    draw_preferences(window,cx);
                    if cfg!(target_os="macos") {anyhow::ensure!(settings.read(cx).monitor_route().err().is_some_and(|e|e.contains("available playback channels")),"Unavailable saved channels allowed monitoring or failed for the wrong reason");}
                    for id in ["settings-output-left","settings-output-right"] {anyhow::ensure!(settings.read(cx).field_label(id).as_deref()==Some("Saved channel · unavailable"),"{id} disguised unavailable saved channel");}
                    let (mut stale,_)=settings.read(cx).input_preferences_snapshot();stale.channel=9;
                    settings.update(cx,|s,cx|{s.set_input_prefs(stale,cx);s.input_pref_error("Preferences could not be saved: isolated regression fixture".into(),cx);});draw_preferences(window,cx);
                    anyhow::ensure!(settings.read(cx).field_label("settings-channel").as_deref()==Some("Saved channel · unavailable"),"Unavailable input channel label was clamped");
                    if cfg!(target_os="macos") {anyhow::ensure!(settings.read(cx).monitor_route().err().is_some_and(|e|e.contains("microphone channel is unavailable")),"Unavailable input channel was not refused");}
                    let _=preferences_field(&view,window,cx,"settings-input-pref-error")?;
                    anyhow::ensure!(settings.read(cx).input_preferences_snapshot().1.is_some(),"Preference failure missing from state");
                    preferences_capture(&view,window,cx,&out,&format!("preferences-unavailable-error-{}",width as u32))?;
                    settings.update(cx,|s,cx|s.clear_input_pref_error(cx));draw_preferences(window,cx);
                    anyhow::ensure!(settings.read(cx).input_preferences_snapshot().1.is_none()&&settings.read(cx).field_bounds("settings-input-pref-error").is_none(),"Cleared preference failure stayed visible");Ok(())
                })??;
            }
            if std::env::var_os("SINGZ_GPUI_SETTINGS_KEYBOARD_TEST").is_some() {
                let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Keyboard regression requires private song fixture"))?);
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                let deadline=Instant::now()+Duration::from_secs(15);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);!p.loading&&p.project.as_ref().is_some_and(|v|v.dir==project)&&p.last_playback_status.is_some()})?{break;}anyhow::ensure!(Instant::now()<deadline,"Keyboard song fixture did not load");}
                for (width,height) in [(1280.,800.),(1060.,640.)] {
                    handle.update(cx,|_,window,_|window.resize(size(px(width),px(height))))?;
                    cx.background_executor().timer(Duration::from_millis(40)).await;
                    macro_rules! open_settings {()=>{{
                        let revision=handle.update(cx,|_,window,cx|->anyhow::Result<u64>{draw_preferences(window,cx);let p=view.read(cx);let revision=p.settings.read(cx).inventory_revision();let bounds=p.header.read(cx).guides.get("settings").ok_or_else(||anyhow::anyhow!("Header Settings not measured"))?;click(window,cx,f32::from(bounds.center().x),f32::from(bounds.center().y));Ok(revision)})??;
                        let deadline=Instant::now()+Duration::from_secs(10);
                        loop {cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Settings&&p.settings.read(cx).inventory_revision()>revision})?{break;}anyhow::ensure!(Instant::now()<deadline,"Settings open inventory did not settle");}
                        handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();settings.update(cx,|s,cx|{s.set_inventory(Ok(preferences_inventory()),cx);cx.emit(settings::SettingsEvent::InputPrefs(microphone::Prefs{input:"singz:fake-duplex".into(),monitor_output:"singz:fake-duplex".into(),..Default::default()}));});})?;
                        cx.background_executor().timer(Duration::from_millis(30)).await;
                    }};}
                    open_settings!();
                    let position=handle.update(cx,|_,_,cx|view.read(cx).position)?;
                    let mut steps=Vec::new();
                    macro_rules! key {($name:expr)=>{{handle.update(cx,|_,window,cx|preferences_key(window,cx,$name))?;cx.background_executor().timer(Duration::from_millis(20)).await;steps.push(handle.update(cx,|_,window,cx|preferences_keyboard_state(&view,window,cx,$name))??);}};}
                    macro_rules! tab {($id:expr)=>{{handle.update(cx,|_,window,cx|preferences_tab_to(&view,window,cx,$id))??;steps.push(handle.update(cx,|_,window,cx|preferences_keyboard_state(&view,window,cx,$id))??);}};}
                    // Explicit synthetic busy transition: no native route is
                    // opened. The actual Tab-focused control becomes disabled.
                    tab!("settings-output");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let settings=view.read(cx).settings.clone();settings.update(cx,|s,cx|s.route_applying(cx));draw_preferences(window,cx);let state=settings.read(cx).keyboard_snapshot(window,cx);anyhow::ensure!(state["focusInside"]==true&&state["focusedControl"].is_null(),"Disabled output retained dead focus: {state}");Ok(())})??;
                    steps.push(handle.update(cx,|_,window,cx|preferences_keyboard_state(&view,window,cx,"fixture-disabled-focus-recovery"))??);
                    key!("tab");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let settings=view.read(cx).settings.clone();anyhow::ensure!(settings.read(cx).focused_control(window,cx)==Some("settings-quick-start"),"Tab could not recover after output disabled");let uid=settings.read(cx).output_uid();settings.update(cx,|s,cx|s.set_route(uid,None,None,cx));Ok(())})??;
                    key!("escape");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Player,"Escape unavailable after disabled-focus recovery");Ok(())})??;
                    open_settings!();
                    // Explicit inventory fixture transition removes the focused
                    // channel picker; no input owner or physical device changes.
                    tab!("settings-channel");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let settings=view.read(cx).settings.clone();let mut inventory=preferences_inventory();inventory.devices[0].inputs=1;settings.update(cx,|s,cx|s.set_inventory(Ok(inventory),cx));draw_preferences(window,cx);let state=settings.read(cx).keyboard_snapshot(window,cx);anyhow::ensure!(state["focusInside"]==true&&state["focusedControl"].is_null()&&settings.read(cx).field_label("settings-channel").is_none()&&!state["focusOrder"].as_array().unwrap().iter().any(|id|id=="settings-channel"),"Unmounted channel picker retained dead focus: {state}");Ok(())})??;
                    steps.push(handle.update(cx,|_,window,cx|preferences_keyboard_state(&view,window,cx,"fixture-unmounted-focus-recovery"))??);
                    key!("tab");handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).focused_control(window,cx)==Some("settings-quick-start"),"Tab could not recover after channel picker unmounted");Ok(())})??;
                    key!("escape");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Player,"Escape unavailable after unmounted-focus recovery");Ok(())})??;
                    open_settings!();
                    tab!("settings-monitor-output");
                    let (unexpected_browse,metadata)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(!p.saving,"Initial project Save is still pending");Ok((p.release_unexpected_browse,std::fs::read(project.join("project.json"))?))})??;
                    for command in if cfg!(target_os="macos") {["cmd-o","cmd-f","cmd-s"]}else{["ctrl-o","ctrl-f","ctrl-s"]} {
                        key!(command);
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Settings&&p.release_unexpected_browse==unexpected_browse&&!p.saving&&!p.playing&&(p.position-position).abs()<0.001,"Settings leaked {command} into app/song action");anyhow::ensure!(std::fs::read(project.join("project.json"))?==metadata,"Settings {command} changed project metadata");Ok(())})??;
                    }
                    key!("tab");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).focused_control(window,cx)==Some("settings-output-left"),"Tab did not follow monitor output");Ok(())})??;
                    key!("shift-tab");handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).focused_control(window,cx)==Some("settings-monitor-output"),"ShiftTab did not reverse focus");Ok(())})??;
                    // Typeahead changes highlight only; Escape retains the route.
                    key!("space");key!("m");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let s=view.read(cx).settings.read(cx).keyboard_snapshot(window,cx);anyhow::ensure!(s["menuIndex"]==2,"Typeahead did not highlight stereo fixture: {s}");Ok(())})??;
                    key!("escape");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Settings&&view.read(cx).mic_prefs.monitor_output=="singz:fake-duplex","Escape committed or closed Settings");Ok(())})??;
                    tab!("settings-channel");key!("enter");key!("end");key!("space");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.channel==7,"End/Space did not select last input channel");Ok(())})??;
                    key!("space");key!("home");key!("enter");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.channel==0,"Home/Enter did not select first input channel");Ok(())})??;
                    tab!("settings-output-left");key!("enter");key!("down");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let s=view.read(cx).settings.read(cx).keyboard_snapshot(window,cx);anyhow::ensure!(s["menuIndex"]==2,"Arrow navigation did not skip duplicate right channel: {s}");Ok(())})??;
                    key!("up");handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).settings.read(cx).keyboard_snapshot(window,cx)["menuIndex"]==0,"Up did not skip duplicate channel in reverse");Ok(())})??;key!("down");
                    key!("enter");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.outputs==[2,1],"Select commit lost highlighted channel");Ok(())})??;
                    key!("enter");key!("home");key!("enter");
                    tab!("settings-monitor-gain");key!("end");
                    handle.update(cx,|_,window,cx|{for _ in 0..4 {preferences_key(window,cx,"left");}})?;
                    cx.background_executor().timer(Duration::from_millis(30)).await;
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.gain==-4.,"Gain key burst lost increments: {}",view.read(cx).mic_prefs.gain);Ok(())})??;
                    key!("home");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.gain==-60.,"Gain Home failed");Ok(())})??;
                    key!("end");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.gain==0.,"Gain End failed");Ok(())})??;
                    tab!("settings-headphones");key!("space");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).mic_prefs.headphones,"Space did not check headphones");Ok(())})??;
                    key!("enter");handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(!view.read(cx).mic_prefs.headphones,"Enter did not uncheck headphones");Ok(())})??;
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{let state=view.read(cx).settings.read(cx).keyboard_snapshot(window,cx);anyhow::ensure!(!state["focusOrder"].as_array().unwrap().iter().any(|id|id=="settings-monitor-start"),"Disabled monitor Start remained in Tab order");preferences_capture(&view,window,cx,&out,&format!("keyboard-focused-{}",width as u32))})??;
                    // Persist actual keyboard changes before exercising modal actions.
                    let deadline=Instant::now()+Duration::from_secs(5);
                    loop {cx.background_executor().timer(Duration::from_millis(20)).await;let saved=std::fs::read(config.join("audio.json")).ok().and_then(|b|serde_json::from_slice::<serde_json::Value>(&b).ok());if saved.as_ref().is_some_and(|v|v["inputChannel"]==0&&v["monitorOutputChannels"]==serde_json::json!([0,1])&&v["monitorGainDb"].as_f64()==Some(0.)){break;}anyhow::ensure!(Instant::now()<deadline,"Keyboard preferences were not persisted");}
                    tab!("settings-close");key!("space");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Player&&!p.playing&&(p.position-position).abs()<0.001,"Close keys leaked into song or did not return to Player");Ok(())})??;
                    open_settings!();tab!("settings-quick-start");key!("enter");
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).quick_start.read(cx).is_open(),"Enter did not open Quick start");draw_preferences(window,cx);window.render_to_image()?.save(out.join(format!("keyboard-quick-start-{}.png",width as u32)))?;Ok(())})??;
                    key!("escape");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(!view.read(cx).quick_start.read(cx).is_open()&&view.read(cx).screen==Screen::Player,"Quick start Escape did not return to Player");Ok(())})??;
                    std::fs::write(out.join(format!("keyboard-{}.steps.json",width as u32)),serde_json::to_vec_pretty(&steps)?)?;
                }
                std::fs::write(out.join("keyboard-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"tabAndShiftTab":true,"selectCommitAndCancel":true,"disabledDuplicateSkipped":true,"typeahead":true,"gainBurstAndLimits":true,"checkbox":true,"close":true,"quickStart":true,"songKeysContained":true,"appCommandsContained":true,"disabledFocusRecovery":true,"unmountedFocusRecovery":true,"focusedControlsVisible":true,"sizes":[[1280,800],[1060,640]],"hardwareActivated":false}))?)?;
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"duplicateRejectedByPointer":true,"escapeDismissesPopup":true,"sameDevicePreservesChannels":true,"changedDeviceResetsChannels":true,"persistedReadback":true,"unavailableSavedChannelsRefused":true,"preferenceFailureVisibleAndClearable":true,"sizes":[[1280,800],[1060,640]],"hardwareCapture":false,"hidden":true,"visualParity":"not measured"}))?)?;Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("SETTINGS_PREFERENCES passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=handle.update(cx,|_,window,cx|{draw_preferences(window,cx);if let Ok(image)=window.render_to_image(){let _=image.save(out.join("preferences-failure.png"));}let p=view.read(cx);let settings=p.settings.read(cx);let (inventory,uid,busy,route_error)=settings.native_snapshot();let (prefs,pref_error)=settings.input_preferences_snapshot();let state=serde_json::json!({"error":format!("{error:#}"),"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"inventoryRevision":settings.inventory_revision(),"inventory":inventory.map(|i|serde_json::json!({"defaultInput":i.default_input,"defaultOutput":i.default_output,"devices":i.devices.iter().map(|d|serde_json::json!({"uid":d.uid,"label":d.label,"inputs":d.inputs,"outputs":d.outputs})).collect::<Vec<_>>()})),"preferences":prefs.patch(),"hostPreferences":p.mic_prefs.patch(),"preferenceError":pref_error,"outputUid":uid,"routeBusy":busy,"routeError":route_error,"openField":settings.smoke_snapshot().4,"labels":{"input":settings.field_label("settings-channel"),"left":settings.field_label("settings-output-left"),"right":settings.field_label("settings-output-right")}});if let Ok(bytes)=serde_json::to_vec_pretty(&state){let _=std::fs::write(out.join("preferences-failure.state.json"),bytes);}});eprintln!("SETTINGS_PREFERENCES failed: {error:#}");let _=view.update(cx,|p,_|{p.microphone.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

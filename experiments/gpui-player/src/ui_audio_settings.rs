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

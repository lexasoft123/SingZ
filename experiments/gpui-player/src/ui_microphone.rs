//! Native PCM replay exercises capture ownership and real CREPE, not hardware I/O.
use super::*;
use std::{path::PathBuf, time::Duration};
fn click(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
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
  anyhow::ensure!(std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some()&&std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),"Use isolated native input fixture and preferences");std::fs::create_dir_all(&out)?;
  let path=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing microphone project"))?);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path,cx)))?;
  let deadline=Instant::now()+Duration::from_secs(30);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.project.is_some()&&p.karaoke&&p.mic_prefs_valid)})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Microphone project did not load");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let _=window.draw(cx);let bounds=view.read(cx).pitch_strip.read(cx).mic_bounds().ok_or_else(||anyhow::anyhow!("Missing microphone control bounds"))?;click(window,cx,bounds.center());Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(!matches!(p.mic_view.phase,microphone::Phase::Error|microphone::Phase::Permission),"{:?}",p.mic_view.error);Ok(p.mic_requested&&p.mic_view.owner==2&&p.mic_view.fresh()&&p.mic_view.sequence>5&&(p.mic_view.frequency-220.).abs()<5.)})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Mic toggle did not reach native CREPE capture");}
  handle.update(cx,|_,window,cx|click(window,cx,point(px(96.),px(718.))))?;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let enough=handle.update(cx,|_,_,cx|view.read(cx).pitch_strip.read(cx).match_counts().1>30)?;if enough{break;}anyhow::ensure!(Instant::now()<deadline,"Live pitch score did not accumulate native samples");}
  let player_generation=handle.update(cx,|_,window,cx|->anyhow::Result<u64>{let p=view.read(cx);anyhow::ensure!(p.playing&&p.pitch_strip.read(cx).trail_len()>0,"Live pitch trail is missing");let(hits,total)=p.pitch_strip.read(cx).match_counts();anyhow::ensure!(hits*100/total>=95,"Sine fixture did not match its saved target pitch");let generation=p.mic_view.generation;let _=window.draw(cx);window.render_to_image()?.save(out.join("player-live-pitch.png"))?;click(window,cx,point(px(if cfg!(any(target_os="windows",target_os="linux")){1114.}else{1248.}),px(26.)));Ok(generation)})??;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.screen==Screen::Settings&&p.mic_view.owner==1&&p.mic_view.generation>player_generation&&p.mic_view.sequence>5&&p.mic_view.fresh())})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Settings did not acquire its own microphone generation");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{view.update(cx,|p,cx|p.poll_backend(cx));let p=view.read(cx);anyhow::ensure!(p.playing&&p.mic_view.fresh()&&p.mic_view.rms>0.1&&p.mic_view.peak>0.2,"Settings meter is not real capture telemetry");let mut prefs=p.mic_prefs.clone();prefs.channel=1;let settings=p.settings.clone();for _ in 0..3{window.simulate_next_frame(cx);window.refresh();let _=window.draw(cx);}let image=window.render_to_image()?;image.save(out.join("settings-live-meter.png"))?;let bounds=view.read(cx).settings.read(cx).field_bounds("settings-meter").ok_or_else(||anyhow::anyhow!("Meter bounds missing"))?;let center=bounds.center();let pixel=image.get_pixel((f32::from(center.x)*window.scale_factor()) as u32,(f32::from(center.y)*window.scale_factor()) as u32).0;anyhow::ensure!(pixel[0]>60&&pixel[0] as f32>pixel[1] as f32*1.4&&pixel[1] as f32>pixel[2] as f32*1.5,"Native meter did not paint the live signal: {pixel:?}");std::fs::write(out.join("settings-live-meter.json"),serde_json::to_vec_pretty(&serde_json::json!({"centerRgba":pixel,"nativeSequence":view.read(cx).mic_view.sequence,"nativeRms":view.read(cx).mic_view.rms}))?)?;settings.update(cx,|_,cx|cx.emit(settings::SettingsEvent::InputPrefs(prefs)));Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.mic_view.phase==microphone::Phase::Error&&p.mic_view.frequency==0.&&p.mic_view.rms==0.})?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Invalid fixture channel silently retained previous microphone");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let _=window.draw(cx);window.render_to_image()?.save(out.join("settings-invalid-channel.png"))?;let p=view.read(cx);let mut prefs=p.mic_prefs.clone();prefs.channel=0;let settings=p.settings.clone();settings.update(cx,|_,cx|cx.emit(settings::SettingsEvent::InputPrefs(prefs)));Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.mic_view.phase==microphone::Phase::Live&&p.mic_view.sequence>3})?{break;}anyhow::ensure!(Instant::now()<deadline,"Corrected input did not restart");}
  handle.update(cx,|_,window,cx|click(window,cx,point(px(220.),px(732.))))?;
  let deadline=Instant::now()+Duration::from_secs(10);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Player&&p.mic_view.owner==2&&p.mic_view.fresh()&&p.mic_view.sequence>3})?{break;}anyhow::ensure!(Instant::now()<deadline,"Closing Settings did not restore requested player microphone");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let _=window.draw(cx);let bounds=view.read(cx).pitch_strip.read(cx).mic_bounds().unwrap();click(window,cx,bounds.center());Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);!p.mic_requested&&p.mic_view.phase==microphone::Phase::Off})?{break;}anyhow::ensure!(Instant::now()<deadline,"Microphone Stop did not acknowledge cleanup");}
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeCrepeFixture":true,"frequencyHz":220,"liveTrail":true,"settingsMeter":true,"ownerGenerationHandoff":true,"invalidChannelClearsStaleMeter":true,"playerRestoredAfterSettings":true,"stopAcknowledged":true,"hardwareQualification":false}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("NATIVE_MICROPHONE passed: CREPE PCM fixture, live trail/meter, input-owner generations, invalid-channel/no-stale-data, restoration and Stop");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("NATIVE_MICROPHONE failed: {error:#}");let _=view.update(cx,|p,_|{p.microphone.take();p.backend.take();});std::process::exit(1);}}
}).detach();
}

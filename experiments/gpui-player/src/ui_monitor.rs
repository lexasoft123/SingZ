//! Muted monitor fixture checks real native playback park/restore and input-owner ordering.
use super::*;
use std::{path::PathBuf, time::Duration};
fn draw(window: &mut Window, cx: &mut App) {
    for _ in 0..3 {
        window.simulate_next_frame(cx);
        window.refresh();
        let _ = window.draw(cx);
    }
}
fn click(window: &mut Window, cx: &mut App, p: Point<Pixels>) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: p,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position: p,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position: p,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
}
fn capture_header_monitor(view:&Entity<Player>,window:&mut Window,cx:&mut App,out:&std::path::Path,name:&str)->anyhow::Result<()> {
    draw(window,cx);
    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Monitor test window presented or activated");
    window.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p=view.read(cx);
    let value=serde_json::json!({"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"scale":window.scale_factor(),
        "screen":p.screen as u8,"header":p.header.read(cx).monitor_state(),"requested":p.monitor_flight.monitor_requested,"parked":p.monitor_flight.monitor_parked,"pending":p.monitor_flight.monitor.is_some(),
        "monitorBusy":p.monitor_busy(),"micPhase":format!("{:?}",p.mic_view.phase),"micOwner":p.mic_view.owner,"fixture":p.mic_view.fixture,"audibleMonitor":p.mic_view.monitor_enabled,
        "headphones":p.mic_prefs.headphones,"position":p.playhead.position(),"playing":p.playing,"windowPresented":window.is_visible(),"windowActive":window.is_window_active(),
        "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "visualReference":"candidate only; matched production header capture absent","liveFps":"unmeasured: hidden window"});
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some(),"Monitor requires isolated muted fixture");
            std::fs::create_dir_all(&out)?;
            let path=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing project"))?);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
            let deadline=Instant::now()+Duration::from_secs(30);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).project.is_some()&&view.read(cx).mic_prefs_valid)?{break;}anyhow::ensure!(Instant::now()<deadline,"Project did not load");}
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.request_tempo(0.8,cx);p.request_transpose(-2,cx);p.native_command("loop 0 10".into(),cx);p.native_command("lane 0 0.37 0 1".into(),cx);p.native_transport(transport::TransportEvent::Play,cx);} ))?;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).playing&&view.read(cx).playhead.position()>0.2&&!view.read(cx).rate_busy()&&view.read(cx).tempo==0.8&&view.read(cx).transpose==-2)?{break;}anyhow::ensure!(Instant::now()<deadline,"Playback did not advance");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let settings=view.read(cx).header.read(cx).guides.get("settings").ok_or_else(||anyhow::anyhow!("Header Settings not measured"))?;click(window,cx,settings.center());Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(150)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{
                let inventory=fixture_inventory();
                p.settings.update(cx,|s,cx|s.set_inventory(Ok(inventory),cx));
                let prefs=microphone::Prefs{input:"singz:fake-duplex".into(),monitor_output:"singz:fake-duplex".into(),..Default::default()};
                p.settings.update(cx,|_,cx|cx.emit(settings::SettingsEvent::InputPrefs(prefs)));
            });anyhow::ensure!(view.read(cx).settings.read(cx).monitor_route().is_err(),"Monitoring allowed without headphone confirmation");

            draw(window,cx);window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(800.),px(500.)),delta:ScrollDelta::Pixels(point(px(0.),px(-2000.))),..Default::default()}),cx);Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(50)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let bounds=view.read(cx).settings.read(cx).field_bounds("settings-headphones").ok_or_else(||anyhow::anyhow!("Headphone confirmation missing"))?;click(window,cx,bounds.center());Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{view.read(cx).settings.clone().update(cx,|s,cx|s.set_inventory(Ok(fixture_inventory()),cx));anyhow::ensure!(view.read(cx).mic_prefs.headphones,"Headphone click was not applied");anyhow::ensure!(view.read(cx).settings.read(cx).monitor_route().is_ok(),"{:?}",view.read(cx).settings.read(cx).monitor_route());draw(window,cx);let bounds=view.read(cx).settings.read(cx).field_bounds("settings-monitor-start").ok_or_else(||anyhow::anyhow!("Monitor button missing"))?;anyhow::ensure!(bounds.center().y<px(690.),"Monitor button not visible");click(window,cx,bounds.center());Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let active=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.monitor_flight.monitor_parked&&p.mic_view.phase==microphone::Phase::Monitoring&&p.mic_view.owner==3)})??;if active{break;}if Instant::now()>=deadline {let state=handle.update(cx,|_,_,cx|{let p=view.read(cx);format!("requested={} parked={} pending={:?} phase={:?} owner={} error={:?}",p.monitor_flight.monitor_requested,p.monitor_flight.monitor_parked,p.monitor_flight.monitor.current_serial(),p.mic_view.phase,p.mic_view.owner,p.settings.read(cx).monitor_error())})?;anyhow::bail!("Native monitor did not acquire output: {state}");}}
            let (position,generation)=handle.update(cx,|_,window,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(!p.playing&&p.mic_view.fixture&&!p.mic_view.monitor_enabled,"Monitor did not preserve forced mute");let state=(p.playhead.position(),p.mic_view.generation);draw(window,cx);window.render_to_image()?.save(out.join("monitor-active.png"))?;let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.gain=-30.;settings.update(cx,|_,cx|cx.emit(settings::SettingsEvent::InputPrefs(prefs)));Ok(state)})??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).mic_view.gain == -30.)?{break;}anyhow::ensure!(Instant::now()<deadline,"Live monitor gain did not reach native graph");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.mic_view.generation==generation&&(p.playhead.position()-position).abs()<0.03,"Gain reopened monitor or song clock advanced while parked");draw(window,cx);let bounds=view.read(cx).settings.read(cx).field_bounds("settings-monitor-start").unwrap();click(window,cx,bounds.center());Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|!view.read(cx).monitor_busy())?{break;}anyhow::ensure!(Instant::now()<deadline,"Stop did not restore paused playback");}
            let failure_serial=handle.update(cx,|_,_,cx|->anyhow::Result<u64>{let p=view.read(cx);anyhow::ensure!(!p.playing&&!p.monitor_flight.monitor_parked&&(p.playhead.position()-position).abs()<0.03,"Stop changed project position or autoplayed");let serial=p.monitor_flight.monitor.serial();let settings=p.settings.clone();let mut prefs=p.mic_prefs.clone();prefs.channel=8;settings.update(cx,|s,cx|{let mut inventory=fixture_inventory();inventory.devices[0].inputs=9;s.set_inventory(Ok(inventory),cx);cx.emit(settings::SettingsEvent::InputPrefs(prefs));});Ok(serial)})??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.headphones=true;settings.update(cx,|_,cx|{cx.emit(settings::SettingsEvent::InputPrefs(prefs));cx.emit(settings::SettingsEvent::Monitor);});})?;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let recovered=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"Native monitor refusal damaged playback: {:?}",p.notice);Ok(p.monitor_flight.monitor.serial()>failure_serial&&!p.monitor_busy()&&p.settings.read(cx).monitor_error().is_some())})??;if recovered{break;}anyhow::ensure!(Instant::now()<deadline,"Native monitor refusal did not clean up and restore playback");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(!view.read(cx).playing&&(view.read(cx).playhead.position()-position).abs()<0.03,"Native refusal autoplayed or lost position");draw(window,cx);window.render_to_image()?.save(out.join("monitor-refused-restored.png"))?;let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.channel=0;settings.update(cx,|s,cx|{s.set_inventory(Ok(fixture_inventory()),cx);cx.emit(settings::SettingsEvent::InputPrefs(prefs));});view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx));Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).playing&&view.read(cx).playhead.position()>position+0.1)?{break;}anyhow::ensure!(Instant::now()<deadline,"Explicit Play after monitor did not resume");}
            // Start through the existing Settings control, then leave Settings:
            // the persistent header owns the only Stop action outside the modal.
            handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.headphones=true;settings.update(cx,|_,cx|cx.emit(settings::SettingsEvent::InputPrefs(prefs)));})?;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let bounds=view.read(cx).settings.read(cx).field_bounds("settings-monitor-start").ok_or_else(||anyhow::anyhow!("Monitor retry button not measured"))?;click(window,cx,bounds.center());Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.monitor_flight.monitor_parked&&p.mic_view.phase==microphone::Phase::Monitoring&&p.mic_view.owner==3})?{break;}anyhow::ensure!(Instant::now()<deadline,"Header Stop fixture did not acquire monitor");}
            handle.update(cx,|_,window,cx|{draw(window,cx);window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);})?;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).screen==Screen::Player)?{break;}anyhow::ensure!(Instant::now()<deadline,"Settings Escape did not restore player");}
            let header_position=handle.update(cx,|_,window,cx|->anyhow::Result<f64>{let p=view.read(cx);anyhow::ensure!(p.monitor_flight.monitor_requested&&p.monitor_flight.monitor_parked&&!p.playing&&p.mic_view.fixture&&!p.mic_view.monitor_enabled,"Leaving Settings stopped monitor or enabled audible output");let position=p.playhead.position();
                capture_header_monitor(&view,window,cx,&out,"header-monitor-active")?;
                let header=view.read(cx).header.read(cx);anyhow::ensure!(header.monitor_state()["visible"]==true,"Active monitor owner missing from header");let stop=header.guides.get("monitor-stop").ok_or_else(||anyhow::anyhow!("Header Stop not measured"))?;
                anyhow::ensure!(stop.size.width>px(0.)&&stop.size.height>px(0.)&&stop.left()>=px(0.)&&stop.right()<=window.viewport_size().width&&stop.top()>=px(0.)&&stop.bottom()<=window.viewport_size().height,"Header Stop outside viewport");click(window,cx,stop.center());Ok(position)})??;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let stopped=handle.update(cx,|_,_,cx|{let p=view.read(cx);!p.monitor_busy()&&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0})?;if stopped{break;}anyhow::ensure!(Instant::now()<deadline,"Header Stop did not release monitor/input and restore playback output");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.monitor_flight.monitor_requested&&!p.monitor_flight.monitor_parked&&p.monitor_flight.monitor.is_none()&&!p.mic_prefs.headphones&&!p.playing&&(p.playhead.position()-header_position).abs()<0.03,"Header Stop autoplayed, changed position or retained monitoring consent");
                capture_header_monitor(&view,window,cx,&out,"header-monitor-stopped")?;
                anyhow::ensure!(view.read(cx).header.read(cx).monitor_state()["visible"]==false,"Header owner control remained after Stop");
                let settings=view.read(cx).header.read(cx).guides.get("settings").ok_or_else(||anyhow::anyhow!("Header Settings not measured"))?;click(window,cx,settings.center());Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).screen==Screen::Settings)?{break;}anyhow::ensure!(Instant::now()<deadline,"Settings did not reopen after header Stop");}
            // Restart and replace the project while monitoring. Replacement waits for
            // the input helper to be reaped and playback to be unparked first.
            handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.headphones=true;settings.update(cx,|_,cx|{cx.emit(settings::SettingsEvent::InputPrefs(prefs));cx.emit(settings::SettingsEvent::Monitor);});})?;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).mic_view.phase==microphone::Phase::Monitoring)?{break;}anyhow::ensure!(Instant::now()<deadline,"Monitor retry did not start");}
            let previous=handle.update(cx,|_,_,cx|{let epoch=view.read(cx).native_epoch;view.update(cx,|p,cx|{p.open_project(path.clone(),cx);p.native_command("loop 2 9".into(),cx);p.native_command("play".into(),cx);});epoch})?;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.native_epoch>previous&&!p.loading&&p.project.is_some()&&!p.monitor_busy()&&p.mic_view.owner!=3&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.loop_range==Some((2.,9.))))})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Replacement lost commands queued after Open or failed monitor cleanup");}
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_command("pause".into(),cx)))?;
            // A real BPM button must release monitoring automatically before
            // the typed native request can acquire the playback output again.
            handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.headphones=true;settings.update(cx,|s,cx|{s.set_inventory(Ok(fixture_inventory()),cx);cx.emit(settings::SettingsEvent::InputPrefs(prefs));cx.emit(settings::SettingsEvent::Monitor);});})?;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).mic_view.phase==microphone::Phase::Monitoring)?{break;}anyhow::ensure!(Instant::now()<deadline,"BPM monitor fixture did not start");}
            let bpm_target=handle.update(cx,|_,window,cx|->anyhow::Result<f32>{
                draw(window,cx);let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Player&&p.monitor_busy(),"BPM fixture must exercise the player while monitoring");
                let target=((p.requested_rate().0*120.+1.)/120.*10000.).round()/10000.;
                let bounds=p.transport.read(cx).bounds("transport-bpm-up").ok_or_else(||anyhow::anyhow!("Actual BPM + button missing"))?;
                anyhow::ensure!(bounds.left()>=px(0.)&&bounds.right()<=window.viewport_size().width&&bounds.bottom()<=window.viewport_size().height,"BPM + button outside hidden viewport");
                click(window,cx,bounds.center());Ok(target)
            })??;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop{cx.background_executor().timer(Duration::from_millis(10)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"Actual BPM monitoring handoff failed: {:?}",p.notice);Ok(!p.monitor_busy()&&!p.rate_busy()&&(p.tempo-bpm_target).abs()<0.00006&&p.last_playback_status.as_ref().is_some_and(|s|!s.parked&&(s.rate-bpm_target).abs()<0.00006))})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Actual BPM click did not stop monitor and reach native accepted rate");}
            handle.update(cx,|_,_,cx|{let settings=view.read(cx).settings.clone();let mut prefs=view.read(cx).mic_prefs.clone();prefs.headphones=true;settings.update(cx,|_,cx|{cx.emit(settings::SettingsEvent::InputPrefs(prefs));cx.emit(settings::SettingsEvent::Monitor);});})?;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).mic_view.phase==microphone::Phase::Monitoring)?{break;}anyhow::ensure!(Instant::now()<deadline,"Coalesced-rate monitor fixture did not start");}
            let previous=handle.update(cx,|_,_,cx|->anyhow::Result<u64>{view.update(cx,|p,cx|->anyhow::Result<u64>{
                let epoch=p.native_epoch;let accepted=p.tempo;
                let older=PathBuf::from(std::env::var_os("SINGZ_GPUI_MONITOR_OTHER_PROJECT").ok_or_else(||anyhow::anyhow!("Missing older destination fixture"))?);
                p.open_project(older,cx);
                p.native_command("loop 1 5".into(),cx);
                p.native_command("play".into(),cx);
                p.native_transport(transport::TransportEvent::Tempo(0.9),cx);
                p.native_transport(transport::TransportEvent::Transpose(-1),cx);
                p.native_transport(transport::TransportEvent::Tempo(1.1),cx);
                p.save_project(cx);p.open_project(path.clone(),cx);
                let count=p.monitor_flight.monitor_actions.iter().filter(|a|matches!(a,DeferredAudio::Rate(_, _))).count();
                anyhow::ensure!(p.transport_flight.native_rate_deferred==Some((1.1,-1))&&count==1&&p.monitor_flight.monitor_actions.len()==1&&!p.monitor_flight.monitor_requested&&p.monitor_flight.monitor_parked&&p.tempo==accepted&&p.transport_flight.native_rate_save_requested&&p.transport_flight.native_rate_navigation.as_ref().is_some_and(|(destination,source)|destination==&path&&!*source)&&!p.monitor_flight.monitor_actions.iter().any(|a|matches!(a,DeferredAudio::Open(_)))&&!p.loading&&!p.saving&&p.native_epoch==epoch,"Typed monitor rate did not coalesce, fence Save/navigation, or cancel superseded destination commands");
                std::fs::write(out.join("monitor-rate-queued.json"),serde_json::to_vec_pretty(&serde_json::json!({"deferred":p.transport_flight.native_rate_deferred,"rateActions":count,"saveRequested":p.transport_flight.native_rate_save_requested,"navigationHeld":p.transport_flight.native_rate_navigation.is_some(),"loading":p.loading,"epoch":epoch,"acceptedTempo":accepted}))?)?;Ok(epoch)
            })})??;
            let mut handoff=Vec::new();let deadline=Instant::now()+Duration::from_secs(25);
            loop{
                cx.background_executor().timer(Duration::from_millis(5)).await;
                let (row,ready)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"Coalesced rate/Save/navigation handoff failed: {:?}",p.notice);
                    let pending=p.transport_flight.native_rate_pending.is_some();
                    anyhow::ensure!(!pending||(!p.monitor_busy()&&p.mic_view.owner!=3&&p.mic_view.phase!=microphone::Phase::Monitoring),"Typed Rate acquired output before input release/unpark");
                    if p.native_epoch==previous {
                        anyhow::ensure!(p.last_playback_status.as_ref().is_none_or(|s|!s.playing&&s.loop_range!=Some((1.,5.))),"Commands for superseded Open B executed on the old project");
                    }
                    Ok((serde_json::json!({"epoch":p.native_epoch,"nativePending":pending,"deferred":p.transport_flight.native_rate_deferred,"monitorBusy":p.monitor_busy(),"parked":p.monitor_flight.monitor_parked,"micPhase":format!("{:?}",p.mic_view.phase),"micOwner":p.mic_view.owner,"tempo":p.tempo,"saving":p.saving,"loading":p.loading,"native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"rate":s.rate,"transpose":s.transpose,"parked":s.parked,"graph":s.graph_generation,"playing":s.playing,"loop":s.loop_range}))}),p.native_epoch>previous&&!p.loading&&!p.saving&&!p.rate_busy()&&p.project.as_ref().is_some_and(|project|project.dir==path)&&(p.tempo-1.1).abs()<0.00006&&p.transpose==-1&&p.last_playback_status.as_ref().is_some_and(|s|(s.rate-1.1).abs()<0.00006&&s.transpose==-1&&!s.parked&&!s.playing&&s.loop_range.is_none())))
                })??;handoff.push(row);if ready{break;}if Instant::now()>=deadline {
                    std::fs::write(out.join("monitor-rate-handoff.json"),serde_json::to_vec_pretty(&handoff)?)?;
                    let failure=handle.update(cx,|_,_,cx|{let p=view.read(cx);serde_json::json!({"epoch":p.native_epoch,"project":p.project.as_ref().map(|project|&project.dir),"tempo":p.tempo,"transpose":p.transpose,"looping":p.looping,"selection":p.project.as_ref().and_then(|project|project.selection),"playing":p.playing,"playIntent":p.transport_flight.native_play.payload().copied(),"loading":p.loading,"saving":p.saving,"notice":p.notice,"ratePending":p.transport_flight.native_rate_pending.current().map(|(epoch,serial,&(rate,transpose))|(epoch,serial,rate,transpose)),"rateQueued":p.transport_flight.native_rate_queued,"rateDeferred":p.transport_flight.native_rate_deferred,"rateSaveRequested":p.transport_flight.native_rate_save_requested,"rateNavigation":p.transport_flight.native_rate_navigation,"metronomeNavigation":p.metronome_flight.metronome_navigation,"metronomeSaveRequested":p.metronome_flight.metronome_save_requested,"metronomeSaveWaiting":p.metronome_flight.metronome_save_waiting,"monitorActions":p.monitor_flight.monitor_actions.len(),"monitorBusy":p.monitor_busy(),"sourceJob":p.source_job,"sourceWorking":p.source_working,"native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"rate":s.rate,"transpose":s.transpose,"parked":s.parked,"graph":s.graph_generation,"playing":s.playing,"loop":s.loop_range,"position":s.position}))})})?;
                    std::fs::write(out.join("monitor-rate-failure.json"),serde_json::to_vec_pretty(&failure)?)?;
                    if let Ok(saved)=std::fs::read(path.join("project.json")) {
                        std::fs::write(out.join("monitor-rate-failure-project.json"),saved)?;
                    }
                    anyhow::bail!("Typed rate Save/navigation did not finish: {failure}");
                }
            }
            std::fs::write(out.join("monitor-rate-handoff.json"),serde_json::to_vec_pretty(&handoff)?)?;
            let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(path.join("project.json"))?)?;
            anyhow::ensure!(saved["settings"]["tempo"].as_f64().is_some_and(|r|(r-1.1).abs()<0.00006)&&saved["settings"]["transpose"]==-1,"Queued Save did not persist latest accepted rate pair");
            std::fs::write(out.join("monitor-rate-saved-project.json"),serde_json::to_vec_pretty(&saved)?)?;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"realPlaybackPark":true,"fakeMonitoring":true,"headphonesRequired":true,"gainKeepsGeneration":true,"nativeRefusalRestoresPaused":true,"positionPreserved":true,"stopRestoresPaused":true,"explicitPlay":true,"projectReplacementStopsMonitor":true,"headerStopOutsideSettings":true,"headerStopReleasesInput":true,"headerStopRestoresPaused":true,"headerOwnerDisappears":true,"typedRateStopsMonitor":true,"actualBpmStopsMonitor":true,"coalescedRateSaveNavigation":true,"commandsSurviveDeferredOpen":true,"latestNavigationWins":true,"hidden":true,"muted":true,"hardwareMonitoringQualified":false}))?)?;
            Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("NATIVE_MONITOR passed: park/release, muted monitor owner, live gain, Stop/paused restore, explicit resume and project replacement");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("NATIVE_MONITOR failed: {error:#}");let _=view.update(cx,|p,_|{p.microphone.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

pub(super) fn fixture_inventory() -> audio_devices::Inventory {
    audio_devices::Inventory {
        devices: vec![audio_devices::Device {
            uid: "singz:fake-duplex".into(),
            label: "Native muted monitor fixture".into(),
            inputs: 8,
            outputs: 8,
            input_probe_busy: false,
            output_probe_busy: false,
        }],
        default_input: "singz:fake-duplex".into(),
        default_output: "singz:fake-duplex".into(),
    }
}

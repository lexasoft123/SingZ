//! Real Rust → C++ session test. Hidden native window; no OS input or Node.
use super::*;
use std::{path::PathBuf, time::Duration};
fn native_vocals_muted(p:&Player)->Option<bool>{
    p.last_playback_status.as_ref()?.observed_lanes.as_array()?.iter()
        .find(|lane|lane["id"]=="vocals")?["muted"].as_bool()
}
fn click_vocals_mute(view:&Entity<Player>,window:&mut Window,cx:&mut App)->anyhow::Result<()> {
    super::ui_training_run::draw(window,cx);
    let bounds=view.read(cx).track_bounds.borrow().get("mute-0").copied()
        .ok_or_else(||anyhow::anyhow!("Shared vocal M control was not laid out"))?;
    anyhow::ensure!(bounds.size.width>px(0.)&&bounds.size.height>px(0.)&&bounds.left()>=px(0.)&&bounds.top()>=px(0.)
        &&bounds.right()<=window.viewport_size().width&&bounds.bottom()<=window.viewport_size().height,
        "Shared vocal M control is outside the accepted viewport: {bounds:?}");
    super::ui_training_run::click(window,cx,bounds.center());Ok(())
}
fn snapshot(view:&Entity<Player>,window:&mut Window,cx:&mut App,directory:&std::path::Path,name:&str)->anyhow::Result<()> {
    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Integration capture activated the window");
    let _=window.draw(cx);window.render_to_image()?.save(directory.join(format!("{name}.png")))?;
    let p=view.read(cx);let viewport=window.viewport_size();
    let state=serde_json::json!({"viewport":[f32::from(viewport.width),f32::from(viewport.height)],"scale":window.scale_factor(),"hidden":!window.is_visible()&&!window.is_window_active(),"epoch":p.native_epoch,"playing":p.playing,"position":p.position,"nativeGraph":p.last_playback_status.as_ref().map(|s|serde_json::json!({"explicit":s.explicit_graph,"nodes":s.graph_nodes,"connections":s.graph_connections})),"productionParity":"unqualified native candidate","liveFps":"unmeasured"});
    std::fs::write(directory.join(format!("{name}.json")),serde_json::to_vec_pretty(&state)?)?;Ok(())
}
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
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, directory: PathBuf, cx: &mut App) {
    assert!(
        std::env::var_os("SINGZ_MUTE").is_some(),
        "Integration checks must be silent"
    );
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&directory)?;
            handle.update(cx,|_,window,_|window.resize(size(px(1280.),px(800.))))?;
            let viewport_deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx,|_,window,_|window.viewport_size()==size(px(1280.),px(800.)))?{break;}
                anyhow::ensure!(Instant::now()<viewport_deadline,"Native integration viewport did not acknowledge resize");
            }
            let path=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Set SINGZ_GPUI_TEST_PROJECT"))?);
            handle.update(cx,|_,_,cx|view.update(cx,|player,cx|player.open_project(path.clone(),cx)))?;
            let deadline=Instant::now()+Duration::from_secs(30);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let player=view.read(cx);anyhow::ensure!(player.notice.is_none(),"{:?}",player.notice);Ok(player.project.is_some())})??;
                if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Project load timeout");
            }
            if std::env::var_os("SINGZ_GPUI_TEST_GRAPH").is_some(){
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);
                    let status=p.last_playback_status.as_ref().ok_or_else(||anyhow::anyhow!("Missing native graph receipt"))?;
                    anyhow::ensure!(p.project.as_ref().unwrap().graph.is_some()&&status.explicit_graph&&status.graph_nodes==14&&status.graph_connections==13,"Saved graph did not reach native playback");Ok(())})??;
            }
            if std::env::var_os("SINGZ_GPUI_TEST_ANALYSIS").is_some(){
                let deadline=Instant::now()+Duration::from_secs(60);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);let project=p.project.as_ref().unwrap();if let Some(warning)=&project.pitch.warning{anyhow::ensure!(!warning.starts_with("Pitch analysis failed"),"{warning}");}Ok(project.pitch.det_version==4&&!project.pitch.notes.is_empty()&&project.raw["settings"]["melody"]["detVersion"]==4)})??;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Native analysis did not reach the active project");
                }
                eprintln!("NATIVE_ANALYSIS passed: native vocal detection, saved-format adoption and pitch notes");
            }
            let karaoke_case=std::env::var("SINGZ_GPUI_TEST_KARAOKE").as_deref()==Ok("1");
            let navigation_case=std::env::var("SINGZ_GPUI_TEST_NAVIGATION").as_deref()==Ok("1");
            let mut karaoke_evidence=serde_json::json!({});
            let mut karaoke_pref_initial=serde_json::Value::Null;
            if karaoke_case {
                let expected=std::env::var("SINGZ_GPUI_TEST_KARAOKE_PREF_EXPECT")?.parse::<u8>()?;
                anyhow::ensure!(expected<=1,"Invalid Karaoke preference expectation");
                let expected=expected==1;
                let deadline=Instant::now()+Duration::from_secs(10);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.karaoke_preferred==expected&&p.karaoke==expected
                        &&(!expected||native_vocals_muted(p)==Some(true))})?;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Loaded Karaoke preference did not match the independently launched stage");
                }
                karaoke_pref_initial=handle.update(cx,|_,_,cx|{let p=view.read(cx);serde_json::json!({"preferred":p.karaoke_preferred,"visible":p.karaoke,"nativeVocalsMuted":native_vocals_muted(p)})})?;
            }
            let originally_muted=handle.update(cx,|_,_,cx|view.read(cx).muted[0])?;
            let expected_saved_muted=if karaoke_case {true}else{!originally_muted};
            cx.background_executor().timer(Duration::from_millis(1100)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                let player=view.read(cx);anyhow::ensure!(player.backend.is_some()&&player.screen==Screen::Player,"Not the native playback screen");
                anyhow::ensure!(!player.playing&&player.duration>0.&&player.position==0.,"Incorrect native prepare state");
                snapshot(&view,window,cx,&directory,"native-loaded")?;
                click(window,cx,96.,718.);Ok(())
            })??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                let running=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.playing&&p.position>0.05})?;
                if running{break;}anyhow::ensure!(Instant::now()<deadline,"Play click did not reach native transport");
            }
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                snapshot(&view,window,cx,&directory,"native-playing")?;
                if !navigation_case {click(window,cx,96.,718.);}Ok(())
            })??;
            if navigation_case {
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                macro_rules! header {($event:ident)=>{
                    handle.update(cx,|_,_,cx|view.read(cx).header.clone().update(cx,|_,cx|cx.emit(header::HeaderEvent::$event)))?;
                };}
                macro_rules! settled {($screen:ident,$playing:expr)=>{{
                    let deadline=Instant::now()+Duration::from_secs(10);
                    loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                        let ready=handle.update(cx,|_,window,cx|->anyhow::Result<bool>{let p=view.read(cx);
                            anyhow::ensure!(!window.is_visible()&&!window.is_window_active()&&p.notice.is_none(),"Navigation presented a window or notice");
                            anyhow::ensure!(p.native_epoch==epoch&&p.project.is_some(),"Navigation replaced the native song session");
                            Ok(p.screen==Screen::$screen&&p.playing==$playing&&p.last_playback_status.as_ref().is_some_and(|status|status.playing==$playing))})??;
                        if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Navigation did not settle at {} playing={}",stringify!($screen),$playing);
                    }
                }};}
                header!(Songs);settled!(Player,false);
                // A repeated Songs action must keep the song paused, not toggle it.
                header!(Songs);
                cx.background_executor().timer(Duration::from_millis(100)).await;
                settled!(Player,false);
                handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Play)))?;
                settled!(Player,true);
                header!(Catalog);settled!(Library,false);
                header!(Training);settled!(Training,false);
                anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).songs_catalog)?,"Training forgot the selected catalog tab");
                header!(Songs);settled!(Library,false);
                header!(Catalog);settled!(Player,false);
                std::fs::write(directory.join("navigation.json"),serde_json::to_vec_pretty(&serde_json::json!({
                    "headerEntitySubscription":true,"songsPausesPlayer":true,"repeatedSongsStaysPaused":true,
                    "normalTransportResume":true,"catalogPausesAndOpensLibrary":true,
                    "trainingRemembersCatalog":true,"songsReturnsToRememberedLibrary":true,
                    "catalogReturnsToPausedPlayer":true,"sameNativeEpoch":true,"epoch":epoch,
                    "scope":"production Header entity events and transport subscription; native pause receipts; not measured header button clicks"
                }))?)?;
                eprintln!("NATIVE_NAVIGATION passed: Songs/Catalog native pause and Training remembered catalog");
            }
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                let paused=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{
                    let p=view.read(cx);
                    anyhow::ensure!(p.project.is_some(),"Native project retired while pausing: {:?}",p.notice);
                    Ok(!p.playing)
                })??;
                if paused{break;}
                anyhow::ensure!(Instant::now()<deadline,"Pause click did not reach native transport");
            }
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                click_vocals_mute(&view,window,cx)?;
                view.update(cx,|p,cx|{p.position=p.duration/2.;p.seek_native(cx);});
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(250)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                let p=view.read(cx);anyhow::ensure!(p.muted[0]!=originally_muted&&!p.playing&&(p.position-p.duration/2.).abs()<0.03,"Seek/mute did not settle");
                snapshot(&view,window,cx,&directory,"native-paused-seek")?;
                Ok(())
            })??;
            if karaoke_case {
                handle.update(cx,|_,_,cx|{
                    if view.read(cx).karaoke {
                        view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Karaoke,cx));
                    }
                })?;
                // Let the collapsed lyric/pitch layout reach a frame before
                // consulting the exact shared control's new hit rectangle.
                cx.background_executor().timer(Duration::from_millis(40)).await;
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(window,cx);
                    let p=view.read(cx);
                    anyhow::ensure!(!p.karaoke&&!p.carry.enabled&&p.project.as_ref().is_some_and(|project|project.lyrics.is_some()),
                        "Karaoke regression requires saved lyrics, Carry off and Karaoke initially off");
                    if p.muted[0] {click_vocals_mute(&view,window,cx)?;}
                    Ok(())
                })??;
                let deadline=Instant::now()+Duration::from_secs(10);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let (ready,diagnostic)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(!p.muted[0]&&native_vocals_muted(p)==Some(false),
                        serde_json::json!({"karaoke":p.karaoke,"uiMuted":p.muted[0],"nativeMuted":native_vocals_muted(p),"epoch":p.native_epoch,
                            "nativeLanes":p.last_playback_status.as_ref().map(|status|&status.observed_lanes),
                            "muteBounds":p.track_bounds.borrow().get("mute-0").map(|b|format!("{b:?}")),"notice":p.notice,
                            "tracksPending":p.tracks_pending.is_some(),"carryPending":p.carry_pending.is_some(),"tracksAudioFailed":p.tracks_audio_failed}))})?;
                    if ready{break;}
                    if Instant::now()>=deadline {
                        std::fs::write(directory.join("karaoke-baseline-failure.json"),serde_json::to_vec_pretty(&diagnostic)?)?;
                        anyhow::bail!("Karaoke unmuted native baseline did not settle: {diagnostic}");
                    }
                }
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Karaoke,cx)))?;
                let deadline=Instant::now()+Duration::from_secs(10);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.karaoke&&p.muted[0]&&native_vocals_muted(p)==Some(true))})??;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Karaoke on did not mute the real native vocals lane");
                }
                let on=handle.update(cx,|_,_,cx|view.read(cx).last_playback_status.as_ref().unwrap().observed_lanes.clone())?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Karaoke,cx)))?;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let off=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);
                    anyhow::ensure!(!p.karaoke&&p.muted[0]&&native_vocals_muted(p)==Some(true),"Karaoke off unmuted the guide lane");
                    Ok(p.last_playback_status.as_ref().unwrap().observed_lanes.clone())})??;
                karaoke_evidence=serde_json::json!({"productionNativeTransportEvent":true,"unmutedNativeBaseline":true,
                    "onMutesNativeVocals":true,"offRetainsMute":true,"onObservedLanes":on,"offObservedLanes":off,
                    "scope":"production transport event route and real native lane receipts; not a measured Karaoke button click"});
            }
            // Exercise the same transport event path as the shared tempo/transpose controls.
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{
                p.native_transport(transport::TransportEvent::Tempo(0.8),cx);
                p.native_transport(transport::TransportEvent::Transpose(2),cx);
            }))?;
            let deadline=Instant::now()+Duration::from_secs(10);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok((p.native_rate-0.8).abs()<0.001&&p.pitch_strip.read(cx).effects()==(0.8,2)&&!p.playing&&(p.position-p.duration/2.).abs()<0.03)})??;
                if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Native tempo/transpose UI did not settle");
            }
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{
                p.native_transport(transport::TransportEvent::Tempo(1.),cx);
                p.native_transport(transport::TransportEvent::Transpose(0),cx);
            }))?;
            if std::env::var_os("SINGZ_GPUI_TEST_SAVE").is_some(){
                // This branch is opt-in and must receive an isolated project.
                handle.update(cx,|_,window,cx|{
                    let focus=view.read(cx).focus_handle.clone();focus.focus(window,cx);
                    window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse(if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}).unwrap(),is_held:false,prefer_character_input:false}),cx);
                })?;
                let deadline=Instant::now()+Duration::from_secs(5);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let saved=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(!p.saving&&p.saved_seq==p.edit_seq)})??;
                    if saved{break;}anyhow::ensure!(Instant::now()<deadline,"Native Save timed out");
                }
                let dir=path.canonicalize()?;let (mut saved,_)=project_store::read(&dir,"project.json")?;
                anyhow::ensure!(saved["settings"]["tracks"]["vocals"]["muted"]==expected_saved_muted,"Saved mixer state is missing");
                if std::env::var_os("SINGZ_GPUI_TEST_ANALYSIS").is_some(){anyhow::ensure!(saved["settings"]["melody"]["detVersion"]==4&&saved["settings"]["melody"]["f0"].as_str().is_some(),"Native analysis was not saved in the project format");}
                let before_external=std::fs::read(dir.join("project.json"))?;
                let revision=saved["externalChange"]["testRevision"].as_u64().unwrap_or(0).checked_add(1).ok_or_else(||anyhow::anyhow!("External edit fixture revision exhausted"))?;
                saved["externalChange"]=serde_json::json!({"keep":"external metadata","testRevision":revision});
                std::fs::write(dir.join("project.json"),serde_json::to_vec_pretty(&saved)?)?;
                let external=std::fs::read(dir.join("project.json"))?;
                anyhow::ensure!(external!=before_external,"External edit test did not change project bytes");
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.master_volume=0.5;p.native_command("master 0.5".into(),cx);p.save_project(cx);}))?;
                let deadline=Instant::now()+Duration::from_secs(5);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,_,cx|view.read(cx).notice.as_ref().is_some_and(|n|n.contains("changed outside")))?{break;}
                    anyhow::ensure!(Instant::now()<deadline,"External edit conflict was not reported");
                }
                anyhow::ensure!(std::fs::read(dir.join("project.json"))?==external,"Save overwrote an external edit");
                eprintln!("NATIVE_SAVE passed: actual mixer persistence and external-edit conflict protection");
                handle.update(cx,|_,_,cx|view.update(cx,|p,_|p.notice=None))?;
            }
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{
                view.update(cx,|p,cx|{p.open_project(path.clone(),cx);p.open_project(path.clone(),cx);});Ok(())
            })??;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                let done=handle.update(cx,|_,_,cx|{let p=view.read(cx);!p.loading&&p.project.is_some()&&p.position==0.})?;
                if done{break;}anyhow::ensure!(Instant::now()<deadline,"Replacement generation did not load");
            }
            if karaoke_case {
                let deadline=Instant::now()+Duration::from_secs(10);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.muted[0]&&native_vocals_muted(p)==Some(true)})?;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Saved Karaoke guide mute did not survive native reopen");
                }
                anyhow::ensure!(std::env::var_os("SINGZ_GPUI_TEST_SAVE").is_some(),"Karaoke persistence requires the isolated Save case");
                karaoke_evidence["savedGuideMuted"]=true.into();
                karaoke_evidence["reopenedNativeGuideMuted"]=true.into();
                karaoke_evidence["reopenedObservedLanes"]=handle.update(cx,|_,_,cx|view.read(cx).last_playback_status.as_ref().unwrap().observed_lanes.clone())?;
                std::fs::write(directory.join("karaoke.json"),serde_json::to_vec_pretty(&karaoke_evidence)?)?;
                eprintln!("NATIVE_KARAOKE passed: native off/on/off guide mute, Save and native reopen");
            }
            if std::env::var("SINGZ_GPUI_TEST_REGION").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_region::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(90);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Region verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Region verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_REGION passed: real gestures, native stop/wrap and selection Some/None persistence");
            }
            if std::env::var("SINGZ_GPUI_TEST_TIMELINE").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_timeline::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(90);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Timeline verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Timeline verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_TIMELINE passed: cursor zoom, burst pan, pitch pinch, native seek/follow and saved view");
            }
            if std::env::var("SINGZ_GPUI_TEST_OUTPUT").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_song_output::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(60);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Output verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Output verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_SONG_OUTPUT passed: dB fader, mute restore, unity, native meter receipts and Save/reopen");
            }
            if std::env::var("SINGZ_GPUI_TEST_CATALOG").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_catalog::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(60);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Catalog verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Catalog verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_CATALOG passed: external rescan, keyboard Open/Delete and removed-row focus recovery");
            }
            if std::env::var("SINGZ_GPUI_TEST_LYRICS_COUNTDOWN").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_lyrics_countdown::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(90);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Lyrics countdown verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Lyrics countdown verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_LYRICS_COUNTDOWN passed: native playback gap cues, pause suppression and source pulse");
            }
            if std::env::var("SINGZ_GPUI_TEST_KEYBOARD").as_deref()==Ok("1") {
                let receiver=handle.update(cx,|_,_,cx|ui_desktop_keyboard::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(90);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Desktop keyboard verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Desktop keyboard verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_DESKTOP_KEYBOARD passed: focused-button transport, Enter activation and input/dialog ownership");
                let receiver=handle.update(cx,|_,_,cx|ui_metronome_keyboard::run(handle,view.clone(),path.clone(),directory.clone(),cx))?;
                let deadline=Instant::now()+Duration::from_secs(90);
                loop {
                    match receiver.try_recv() {
                        Ok(result)=>{result.map_err(anyhow::Error::msg)?;break;},
                        Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Metronome keyboard verification stopped without a result"),
                        Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                    }
                    anyhow::ensure!(Instant::now()<deadline,"Metronome keyboard verification timed out");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                }
                eprintln!("NATIVE_METRONOME_KEYBOARD passed: nonmodal transport ownership, range keys and enabled control focus");
            }
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.join("missing-folder"),cx)))?;
            cx.background_executor().timer(Duration::from_millis(250)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.loading&&!p.playing&&p.project.is_none()&&p.notice.is_some(),"Invalid load failed to stop/release output");snapshot(&view,window,cx,&directory,"native-load-error")?;Ok(())})??;
            // Leave a live prepared helper for the application's real quit hook.
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                if handle.update(cx,|_,_,cx|view.read(cx).project.is_some())?{break;}
                anyhow::ensure!(Instant::now()<deadline,"Shutdown fixture did not prepare");
            }
            if karaoke_case {
                let desired=std::env::var("SINGZ_GPUI_TEST_KARAOKE_PREF_FINISH")?.parse::<u8>()?;
                anyhow::ensure!(desired<=1,"Invalid final Karaoke preference expectation");
                let desired=desired==1;
                // The final Off stage deliberately arms and durably writes On
                // first, so Escape proves an actual preference transition.
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{if !p.karaoke {p.native_transport(transport::TransportEvent::Karaoke,cx);}}))?;
                if !desired {
                    let deadline=Instant::now()+Duration::from_secs(10);
                    loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                        let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.karaoke&&p.karaoke_preferred
                            &&p.karaoke_pref_saved_seq==p.karaoke_pref_seq})?;
                        if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Karaoke On did not persist before the Escape check");
                    }
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                        anyhow::ensure!(view.read(cx).region_target().selection.is_none(),"Escape preference check requires no selected region");
                        let focus=view.read(cx).focus_handle.clone();focus.focus(window,cx);
                        window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);Ok(())
                    })??;
                }
                let deadline=Instant::now()+Duration::from_secs(10);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);p.karaoke==desired&&p.karaoke_preferred==desired
                        &&p.karaoke_pref_saved_seq==p.karaoke_pref_seq})?;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Karaoke preference did not receive durable worker acknowledgement");
                }
                let final_state=handle.update(cx,|_,_,cx|{let p=view.read(cx);serde_json::json!({"preferred":p.karaoke_preferred,"visible":p.karaoke,
                    "sequence":p.karaoke_pref_seq,"savedSequence":p.karaoke_pref_saved_seq})})?;
                std::fs::write(directory.join("karaoke-preference.json"),serde_json::to_vec_pretty(&serde_json::json!({
                    "initial":karaoke_pref_initial,"final":final_state,"durableWorkerAcknowledged":true,
                    "offViaActualEscape":!desired,"escapeSelectionWasNone":!desired,
                    "scope":"actual preference worker acknowledgement; independent process restart verified by the driver"
                }))?)?;
            }
            Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("NATIVE_INTEGRATION passed: real project/native decode, Play/Pause click, seek/mute, generation replacement, load error and process cleanup; hidden and muted");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("NATIVE_INTEGRATION failed: {error:#}");let _=handle.update(cx,|_,window,cx|snapshot(&view,window,cx,&directory,"native-failure"));let _=view.update(cx,|p,_|{p.backend.take();});std::process::exit(1);}}
    }).detach();
}

//! Actual read-only Drive browser/download and offline verified-cache reopen.
use super::*;
use std::{path::{Path,PathBuf},time::Duration};

fn key(window:&mut Window,cx:&mut App,name:&'static str) {
    let stroke=Keystroke::parse(name).unwrap();window.dispatch_keystroke(stroke.clone(),cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn quiet(p:&Player,window:&Window)->anyhow::Result<()> {
    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Drive restore activated a window");
    anyhow::ensure!(!p.monitor_requested&&!p.mic_requested&&!p.mic_permission_requested,"Drive restore requested physical input");
    anyhow::ensure!(p.notice.is_none(),"Native restore notice: {:?}",p.notice);Ok(())
}
fn measured(bounds:Option<Bounds<Pixels>>,window:&Window,id:&str)->anyhow::Result<()> {
    let bounds=bounds.ok_or_else(||anyhow::anyhow!("Missing actual {id} bounds"))?;
    anyhow::ensure!(bounds.size.width>px(0.)&&bounds.size.height>px(0.)&&bounds.left()>=px(0.)&&bounds.right()<=window.viewport_size().width
        &&bounds.top()>=px(0.)&&bounds.bottom()<=window.viewport_size().height,"{id} outside viewport: {bounds:?}");Ok(())
}
fn header(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..192 {ui_training_run::draw(window,cx);
        if view.read(cx).header.read(cx).focused_control(window).as_deref()==Some(id) {key(window,cx,"enter");return Ok(());}
        key(window,cx,"tab");
    }anyhow::bail!("Drive restore Tab did not reach Header {id}")
}
fn library(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..192 {ui_training_run::draw(window,cx);let p=view.read(cx);
        if p.library.read(cx).drive_state(window)["focusedControl"]==id {
            measured(p.library.read(cx).drive_bounds(id),window,id)?;key(window,cx,"enter");return Ok(());
        }key(window,cx,"tab");
    }anyhow::bail!("Drive restore Tab did not reach Library {id}")
}
fn picker(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..64 {ui_training_run::draw(window,cx);let p=view.read(cx);
        if p.project_picker.read(cx).state(window,cx)["focusedControl"]==id {
            measured(p.project_picker.read(cx).bounds(id),window,id)?;key(window,cx,"enter");return Ok(());
        }key(window,cx,"tab");
    }anyhow::bail!("Drive restore Tab did not reach Picker {id}")
}
fn dialog_focus(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..64 {ui_training_run::draw(window,cx);let p=view.read(cx);
        let dialog=p.drive_projects.read(cx);let state=dialog.state(window,cx);
        anyhow::ensure!(p.drive_projects_open&&state["focusInside"]==true,"Drive browser lost modal keyboard ownership: {state}");
        if state["focusedControl"]==id {measured(dialog.bounds(id),window,id)?;return Ok(());}
        key(window,cx,"tab");
    }anyhow::bail!("Drive browser Tab did not reach {id}: {}",view.read(cx).drive_projects.read(cx).state(window,cx))
}
fn dialog(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    dialog_focus(view,window,cx,id)?;key(window,cx,"enter");Ok(())
}
fn search(view:&Entity<Player>,window:&mut Window,cx:&mut App,value:&str)->anyhow::Result<()> {
    dialog_focus(view,window,cx,"drive-projects-search")?;
    anyhow::ensure!(view.read(cx).drive_projects.read(cx).state(window,cx)["searchFocused"]==true,"Search wrapper lacks actual text-input focus");
    key(window,cx,if cfg!(target_os="macos"){"cmd-a"}else{"ctrl-a"});key(window,cx,"backspace");
    for ch in value.chars() {
        let stroke=Keystroke{key:if ch==' ' {"space".into()}else{ch.to_string()},key_char:Some(ch.to_string()),..Default::default()};
        window.dispatch_keystroke(stroke.clone(),cx);window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
    }ui_training_run::draw(window,cx);Ok(())
}
fn play(view:&Entity<Player>,window:&mut Window,cx:&mut App)->anyhow::Result<()> {
    ui_training_run::draw(window,cx);let p=view.read(cx);let bounds=p.transport.read(cx).bounds("transport-play");
    measured(bounds,window,"transport-play")?;ui_training_run::click(window,cx,bounds.unwrap().center());Ok(())
}
fn marker(path:&Path,value:&serde_json::Value)->anyhow::Result<()> {
    let pending=path.with_extension("pending");std::fs::write(&pending,serde_json::to_vec(value)?)?;std::fs::rename(pending,path)?;Ok(())
}
fn shot(view:&Entity<Player>,window:&mut Window,cx:&mut App,out:&Path,name:&str,captures:&mut Vec<String>)->anyhow::Result<()> {
    ui_training_run::draw(window,cx);let p=view.read(cx);quiet(p,window)?;
    let native=p.last_playback_status.as_ref().map(|s|serde_json::json!({"empty":s.empty_project,"physicalOutputReleased":s.physical_output_released,
        "graph":s.graph_generation,"laneRevision":s.lane_revision,"explicitGraph":s.explicit_graph,"playing":s.playing,"position":s.position}));
    let state=serde_json::json!({"case":name,"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"scale":window.scale_factor(),
        "hidden":true,"active":false,"physicalInput":false,"browserOpen":p.drive_projects_open,"browser":p.drive_projects.read(cx).state(window,cx),
        "pickerOpen":p.project_picker_open,"project":p.project.as_ref().map(|project|&project.dir),"native":native,"duration":p.duration,
        "playing":p.playing,"epoch":p.native_epoch,"liveFps":"unmeasured","productionParity":"unqualified"});
    window.render_to_image()?.save(out.join(format!("{name}.png")))?;marker(&out.join(format!("{name}.state.json")),&state)?;captures.push(name.into());Ok(())
}
fn opened(p:&Player,id:&str,played:bool)->anyhow::Result<serde_json::Value> {
    let project=p.project.as_ref().ok_or_else(||anyhow::anyhow!("Restored project not open"))?;
    let native=p.last_playback_status.as_ref().ok_or_else(||anyhow::anyhow!("Restored project has no actual native receipt"))?;
    let empty=id=="project-empty";
    anyhow::ensure!(project.empty_tracks==empty&&native.empty_project==empty,"Restored project emptiness disagrees with native receipt");
    if empty {anyhow::ensure!(!project.has_audio()&&project.lane_specs.is_empty()&&p.duration==0.&&p.native_graph==0&&!p.playing&&native.physical_output_released,"Empty restore resurrected native audio");}
    else {anyhow::ensure!(project.has_audio()&&p.duration>11.&&played,"Restored audio lacks native Play proof");}
    Ok(serde_json::json!({"id":id,"directory":project.dir,"empty":empty,"duration":p.duration,"nativeGraph":p.native_graph,
        "laneCount":project.lane_specs.len(),"physicalOutputReleased":native.physical_output_released,"explicitGraph":native.explicit_graph,"nativePlayConfirmed":played}))
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(out.join("requests"))?;std::fs::create_dir_all(out.join("acks"))?;
            let offline=std::env::var("SINGZ_GPUI_DRIVE_RESTORE_STAGE").as_deref()==Ok("offline");
            let mut captures=vec![];let mut records=vec![];
            macro_rules! wait {($label:expr,$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,window,cx|->anyhow::Result<bool>{ui_training_run::draw(window,cx);let p=view.read(cx);quiet(p,window)?;Ok(($condition)(p,window,cx))})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Drive restore timeout {}: {}",$label,handle.update(cx,|_,window,cx|view.read(cx).drive_projects.read(cx).state(window,cx))?);
                }
            }};}
            macro_rules! handshake {($operation:expr)=>{{let name=$operation;marker(&out.join("requests").join(format!("{name}.json")),&serde_json::json!({"operation":name}))?;
                let ack=out.join("acks").join(format!("{name}.json"));let deadline=Instant::now()+Duration::from_secs(12);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if ack.exists(){let value:serde_json::Value=serde_json::from_slice(&std::fs::read(&ack)?)?;anyhow::ensure!(value["ok"]==true,"Fixture handshake failed {name}: {value}");break;}
                    anyhow::ensure!(Instant::now()<deadline,"Fixture handshake timed out: {name}");
                }
            }};}
            macro_rules! both {($name:expr)=>{{for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,window,_|window.resize(size(px(width),px(height))))?;
                wait!("viewport",|_:&Player,window:&Window,_:&App|window.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,window,cx|shot(&view,window,cx,&out,&format!("{}-{}",$name,width as u32),&mut captures))??;
            }}};}
            macro_rules! browser {($from_picker:expr)=>{{
                if $from_picker {
                    handle.update(cx,|_,window,cx|header(&view,window,cx,"header-projects"))??;
                    wait!("project picker",|p:&Player,_:&Window,_:&App|p.project_picker_open);
                    handle.update(cx,|_,window,cx|picker(&view,window,cx,"picker-drive-browse"))??;
                } else {
                    if handle.update(cx,|_,_,cx|view.read(cx).screen!=Screen::Library)? {
                        handle.update(cx,|_,window,cx|header(&view,window,cx,"header-catalog"))??;
                    }
                    wait!("library",|p:&Player,_:&Window,_:&App|p.screen==Screen::Library);
                    handle.update(cx,|_,window,cx|library(&view,window,cx,"library-drive-browse"))??;
                }
                wait!("browser rows",|p:&Player,window:&Window,cx:&App|{let state=p.drive_projects.read(cx).state(window,cx);
                    p.drive_projects_open&&state["busy"]==false&&state["rows"].as_array().is_some_and(|rows|rows.len()>=3)});
            }};}
            macro_rules! choose {($id:expr)=>{{let id=$id;
                // Cached rows may paint before the independent cloud request
                // finishes. Yield the actual event loop until this particular
                // target is visible and enabled before synchronous Tab input.
                wait!("requested browser row",|p:&Player,window:&Window,cx:&App|{
                    let state=p.drive_projects.read(cx).state(window,cx);
                    p.drive_projects_open&&state["busy"]==false
                        &&state["visibleRows"].as_array().is_some_and(|rows|rows.iter().any(|row|row["id"]==id))
                });
                handle.update(cx,|_,window,cx|dialog(&view,window,cx,&format!("drive-projects-row-{id}")))??;
            }};}
            macro_rules! native {($id:expr,$name:expr)=>{{let id=$id;
                wait!("native restored project",|p:&Player,_:&Window,_:&App|!p.drive_projects_open&&!p.project_picker_open&&!p.loading
                    &&p.project.as_ref().is_some_and(|project|project.raw["foreign"]["restoreFixture"]==id.trim_start_matches("project-"))
                    &&p.last_playback_status.as_ref().is_some_and(|s|s.empty_project==(id=="project-empty")));
                let mut played=false;
                if id!="project-empty" {
                    handle.update(cx,|_,window,cx|play(&view,window,cx))??;
                    wait!("restored native Play",|p:&Player,_:&Window,_:&App|p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>0.05));
                    played=true;
                    handle.update(cx,|_,window,cx|play(&view,window,cx))??;
                    wait!("restored native Pause",|p:&Player,_:&Window,_:&App|!p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                }
                both!($name);
                records.push(handle.update(cx,|_,_,cx|opened(view.read(cx),id,played))??);
            }};}
            wait!("Drive configuration",|p:&Player,_:&Window,_:&App|p.drive_snapshot.configured&&p.backend.is_some());
            if !offline {
                wait!("initial library",|p:&Player,_:&Window,_:&App|p.screen==Screen::Library);
                handle.update(cx,|_,window,cx|library(&view,window,cx,"library-drive-connect"))??;
                wait!("loopback OAuth URL",|p:&Player,_:&Window,_:&App|!p.drive_test_urls.is_empty());
                let url=handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls[0].clone())?;
                marker(&out.join("authorization-url-0.json"),&serde_json::json!({"url":url}))?;
            }
            wait!("Drive signed in",|p:&Player,_:&Window,_:&App|p.drive_snapshot.signed_in&&!p.drive_snapshot.signing_in);
            browser!(false);both!("browser");
            handle.update(cx,|_,window,cx|search(&view,window,cx,"No matching fixture"))??;
            wait!("typed no-result search",|p:&Player,window:&Window,cx:&App|{let state=p.drive_projects.read(cx).state(window,cx);state["query"]=="No matching fixture"&&state["visibleRows"].as_array().is_some_and(Vec::is_empty)});
            both!("search-miss");
            handle.update(cx,|_,window,cx|search(&view,window,cx,"Stem"))??;
            wait!("typed stem search",|p:&Player,window:&Window,cx:&App|{let state=p.drive_projects.read(cx).state(window,cx);state["query"]=="Stem"&&state["visibleRows"].as_array().is_some_and(|rows|rows.len()==1&&rows[0]["id"]=="project-default")});
            both!("search-stem");
            if !offline {
                handshake!("arm-cancel");choose!("project-default");handshake!("cancel-held");
                handle.update(cx,|_,window,cx|shot(&view,window,cx,&out,"download-held-1060",&mut captures))??;
                handle.update(cx,|_,window,cx|dialog(&view,window,cx,"drive-projects-close"))??;
                wait!("cancel retirement",|p:&Player,window:&Window,cx:&App|p.drive_projects_open&&!p.drive_projects.read(cx).state(window,cx)["busy"].as_bool().unwrap_or(true));
                handshake!("cancelled-proof");handshake!("release-cancel");
                handle.update(cx,|_,window,cx|shot(&view,window,cx,&out,"download-cancelled-1060",&mut captures))??;
            }
            choose!("project-default");native!("project-default","native-default");
            browser!(true);
            let (search_epoch,search_position,search_seek)=handle.update(cx,|_,_,cx|{
                let p=view.read(cx);let native=p.last_playback_status.as_ref().unwrap();(p.native_epoch,native.position,native.seek_count)
            })?;
            handle.update(cx,|_,window,cx|search(&view,window,cx,"Custom graph"))??;
            wait!("typed custom graph search",|p:&Player,window:&Window,cx:&App|{let state=p.drive_projects.read(cx).state(window,cx);
                state["query"]=="Custom graph"&&state["visibleRows"].as_array().is_some_and(|rows|rows.len()==1&&rows[0]["id"]=="project-custom")});
            let search_ownership=handle.update(cx,|_,window,cx|->anyhow::Result<serde_json::Value>{
                let p=view.read(cx);let native=p.last_playback_status.as_ref().unwrap();let browser=p.drive_projects.read(cx).state(window,cx);
                anyhow::ensure!(p.native_epoch==search_epoch&&!p.playing&&!native.playing&&p.native_play_intent.is_none()
                    &&(native.position-search_position).abs()<0.001&&native.seek_count==search_seek,
                    "Actual space in Drive search escaped into paused song transport");
                Ok(serde_json::json!({"query":browser["query"],"searchValue":browser["searchValue"],"searchFocused":browser["searchFocused"],
                    "epochBefore":search_epoch,"epochAfter":p.native_epoch,"positionBefore":search_position,"positionAfter":native.position,
                    "seekBefore":search_seek,"seekAfter":native.seek_count,"playing":p.playing,"nativePlaying":native.playing,"playIntentPending":p.native_play_intent.is_some()}))
            })??;
            choose!("project-custom");native!("project-custom","native-custom");
            if !offline {
                browser!(false);handshake!("arm-integrity");choose!("project-integrity");
                wait!("integrity rejection",|p:&Player,window:&Window,cx:&App|{let state=p.drive_projects.read(cx).state(window,cx);p.drive_projects_open&&state["busy"]==false&&state["message"].as_str().is_some_and(|message|message.to_lowercase().contains("integrity"))});
                handshake!("integrity-proof");
                handle.update(cx,|_,window,cx|shot(&view,window,cx,&out,"integrity-refused-1060",&mut captures))??;
                handshake!("clear-integrity");choose!("project-integrity");native!("project-integrity","native-integrity");
            }
            browser!(true);choose!("project-empty");native!("project-empty","native-empty");
            if !offline {handshake!("readonly-proof");}
            marker(&out.join("result.json"),&serde_json::json!({"passed":true,"offline":offline,"actualBrowserKeys":true,"searchKeys":true,"searchTransportOwned":true,"searchOwnership":search_ownership,
                "nativeDefaultOpen":true,"nativeCustomOpen":true,"nativeEmptyOpen":true,"cancelledWithoutPublication":!offline,
                "integrityRefusedWithoutPublication":!offline,"actualRetry":!offline,"opened":records,"captures":captures,"captureCount":captures.len(),
                "hidden":true,"muted":true,"physicalInput":false,"liveFps":"unmeasured",
                "scope":"Read-only actual Drive browser/download and native cache open; empty remote is explicit reader fixture, native empty publication remains refused; production visual parity unqualified"}))?;
            Ok(())
        }.await;
        match result {Ok(())=>eprintln!("NATIVE_DRIVE_RESTORE passed"),Err(error)=>{
            let _=handle.update(cx,|_,window,cx|{ui_training_run::draw(window,cx);if let Ok(image)=window.render_to_image(){let _=image.save(out.join("failure.png"));}});
            let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));eprintln!("NATIVE_DRIVE_RESTORE failed: {error:#}");
        }}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

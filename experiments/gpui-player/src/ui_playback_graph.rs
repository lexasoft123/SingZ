//! Hidden actual native playback graph presentation. No capture or OS input.
use super::*;
use std::{path::{Path,PathBuf},time::Duration};

fn key(window:&mut Window,cx:&mut App,name:&'static str) {
    let stroke=Keystroke::parse(name).unwrap();
    window.dispatch_keystroke(stroke.clone(),cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn header(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..192 {
        ui_training_run::draw(window,cx);
        if view.read(cx).header.read(cx).focused_control(window).as_deref()==Some(id) {
            key(window,cx,"enter");return Ok(());
        }
        key(window,cx,"tab");
    }
    anyhow::bail!("Playback graph actual Tab did not reach Header {id}")
}
fn settings_focus(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..64 {
        ui_training_run::draw(window,cx);
        if view.read(cx).settings.read(cx).focused_control(window,cx)==Some(id) {return Ok(());}
        key(window,cx,"tab");
    }
    anyhow::bail!("Playback graph actual Tab did not reach Settings {id}: {}",view.read(cx).settings.read(cx).keyboard_snapshot(window,cx))
}
fn quiet(p:&Player,window:&Window)->anyhow::Result<()> {
    anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Playback graph test activated its window");
    anyhow::ensure!(!p.monitor_flight.monitor_requested&&!p.mic_requested&&!p.mic_permission_requested,"Playback graph test requested microphone or monitoring");
    anyhow::ensure!(p.notice.is_none(),"Playback graph notice: {:?}",p.notice);
    Ok(())
}
fn native_graph(p:&Player)->anyhow::Result<serde_json::Value> {
    let status=p.last_playback_status.as_ref().ok_or_else(||anyhow::anyhow!("No actual native status"))?;
    anyhow::ensure!(status.graph_snapshot.is_some()&&status.graph_error.is_none(),"Native playback snapshot unavailable: {:?}",status.graph_error);
    Ok(serde_json::to_value(status.graph_snapshot.as_deref())?)
}
fn capture(view:&Entity<Player>,window:&mut Window,cx:&mut App,out:&Path,name:&str,playback:bool)->anyhow::Result<serde_json::Value> {
    ui_training_run::draw(window,cx);
    let p=view.read(cx);quiet(p,window)?;
    anyhow::ensure!(p.screen==Screen::Settings,"Graph capture left Settings");
    let graph=p.settings.read(cx).graph_ui_state();
    let native=if playback {Some(native_graph(p)?)} else {None};
    if let Some(native)=&native {
        let status=p.last_playback_status.as_ref().unwrap();
        anyhow::ensure!(graph["mode"]=="playback"&&graph["available"]==true&&graph["graph"]==*native,
            "Settings graph is not the accepted actual native graph: {graph}");
        anyhow::ensure!(status.graph_nodes==native["nodes"].as_array().unwrap().len() as u64
            &&status.graph_connections==native["connections"].as_array().unwrap().len() as u64,
            "Native graph counts disagree with actual structured snapshot");
        anyhow::ensure!(graph["renderedNodes"].as_array().is_some_and(|n|n.len()==status.graph_nodes as usize)
            &&graph["renderedConnections"].as_array().is_some_and(|n|n.len()==status.graph_connections as usize),
            "Settings omitted supplied native modules or connections: {graph}");
    } else {anyhow::ensure!(graph["mode"]=="monitor","Unloaded native playback did not show monitor graph: {graph}");}
    let viewport=window.viewport_size();let image=window.render_to_image()?;
    image.save(out.join(format!("{name}.png")))?;
    let status=p.last_playback_status.as_ref();
    let state=serde_json::json!({"case":name,"viewport":[f32::from(viewport.width),f32::from(viewport.height)],"scale":window.scale_factor(),
        "hidden":true,"active":false,"playing":p.playing,"epoch":p.native_epoch,"graph":graph,"nativeGraph":native,
        "nativeGeneration":status.map(|s|s.graph_generation.to_string()),"explicitGraph":status.map(|s|s.explicit_graph),
        "rate":status.map(|s|s.rate),"transpose":status.map(|s|s.transpose),"state":status.map(|s|s.state),"transportState":status.map(|s|s.transport_state),
        "monitorRequested":p.monitor_flight.monitor_requested,"micRequested":p.mic_requested,"liveFps":"unmeasured","productionParity":"unqualified"});
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&state)?)?;
    Ok(state)
}
fn final_node_visible(graph:&serde_json::Value,window:&Window)->anyhow::Result<()> {
    let b=graph["lastNodeBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing final native graph node bounds: {graph}"))?;
    let v=graph["viewportBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing native graph viewport bounds"))?;
    let value=|rows:&Vec<serde_json::Value>,i:usize|rows[i].as_f64().unwrap_or(f64::NAN);
    let (x,y,w,h)=(value(b,0),value(b,1),value(b,2),value(b,3));
    let modal=graph["settingsModalViewportBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing Settings modal viewport bounds"))?;
    anyhow::ensure!(w>0.&&h>0.&&x>=value(v,0)-1.&&x+w<=value(v,0)+value(v,2)+1.
        &&y>=value(modal,1)-1.&&y+h<=value(modal,1)+value(modal,3)+1.
        &&y>=52.&&y+h<=f32::from(window.viewport_size().height) as f64,
        "Keyboard End did not expose final graph node: {graph}");Ok(())
}
fn read_final_connection(view:&Entity<Player>,window:&mut Window,cx:&mut App)->anyhow::Result<()> {
    // Home returns to the route-label edge before reading vertically. The
    // connection row shares the source horizontal graph viewport and can be
    // wider than it; qualification here is vertical reachability, not all text
    // fitting at once.
    key(window,cx,"home");
    for _ in 0..16 {
        key(window,cx,"pagedown");ui_training_run::draw(window,cx);
        let settings=view.read(cx).settings.read(cx);
        anyhow::ensure!(settings.focused_control(window,cx)==Some("settings-playback-graph"),"PageDown changed graph keyboard ownership");
        let graph=settings.graph_ui_state();
        let row=graph["lastConnectionBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing measured final connection row"))?;
        let viewport=graph["settingsModalViewportBounds"].as_array().ok_or_else(||anyhow::anyhow!("Missing modal viewport for connection reading"))?;
        let n=|a:&Vec<serde_json::Value>,i:usize|a[i].as_f64().unwrap_or(f64::NAN);
        if n(row,2)>0.&&n(row,3)>0.&&n(row,1)>=n(viewport,1)-1.&&n(row,1)+n(row,3)<=n(viewport,1)+n(viewport,3)+1.
            &&n(row,0)+n(row,2)>n(viewport,0)&&n(row,0)<n(viewport,0)+n(viewport,2) {return Ok(());}
    }
    anyhow::bail!("Graph-focused PageDown could not expose final connection: {}",view.read(cx).settings.read(cx).graph_ui_state())
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let ordinary=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing ordinary graph project"))?).canonicalize()?;
            let custom=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_CUSTOM_PROJECT").ok_or_else(||anyhow::anyhow!("Missing custom graph project"))?).canonicalize()?;
            let original_graph=std::fs::read(custom.join("graph.json"))?;
            let mut receipts=vec![];
            macro_rules! wait {($label:expr,$predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(25);
                loop {cx.background_executor().timer(Duration::from_millis(25)).await;
                    if handle.update(cx,|_,window,cx|->anyhow::Result<bool>{let p=view.read(cx);quiet(p,window)?;Ok(($predicate)(p,cx))})?? {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Playback graph timed out: {}",$label);
                }
            }};}
            macro_rules! resize {($width:expr,$height:expr)=>{{
                handle.update(cx,|_,window,_|window.resize(size(px($width),px($height))))?;
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,window,_|window.viewport_size()==size(px($width),px($height)))?{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Playback graph viewport did not acknowledge resize");
                }
            }};}
            // Start without an audio project. The ordinary Settings path must
            // retain the monitor diagram without claiming a playback snapshot.
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                resize!(width,height);
                if handle.update(cx,|_,_,cx|view.read(cx).screen!=Screen::Settings)? {
                    handle.update(cx,|_,window,cx|header(&view,window,cx,"header-settings"))??;
                }
                wait!("monitor Settings",|p:&Player,_:&App|p.screen==Screen::Settings);
                handle.update(cx,|_,window,cx|capture(&view,window,cx,&out,&format!("graph-monitor-{}",width as u32),false))??;
            }
            handle.update(cx,|_,window,cx|{settings_focus(&view,window,cx,"settings-close")?;key(window,cx,"enter");Ok::<_,anyhow::Error>(())})??;
            wait!("close initial Settings",|p:&Player,_:&App|p.screen!=Screen::Settings);
            for (kind,path) in [("ordinary",ordinary),("custom",custom.clone())] {
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
                wait!("native project open",|p:&Player,_:&App|!p.loading&&p.project.as_ref().is_some_and(|project|project.dir==path)
                    &&p.last_playback_status.as_ref().is_some_and(|status|status.graph_snapshot.is_some()));
                let supplied_ids=handle.update(cx,|_,_,cx|->anyhow::Result<Vec<serde_json::Value>>{Ok(native_graph(view.read(cx))?["nodes"].as_array().unwrap().iter().map(|n|n["id"].clone()).collect())})??;
                for (index,(width,height)) in [(1280.,800.),(1060.,640.)].into_iter().enumerate() {
                    resize!(width,height);
                    handle.update(cx,|_,window,cx|header(&view,window,cx,"header-settings"))??;
                    wait!("playback Settings",|p:&Player,cx:&App|p.screen==Screen::Settings&&p.settings.read(cx).graph_ui_state()["available"]==true);
                    handle.update(cx,|_,window,cx|{settings_focus(&view,window,cx,"settings-playback-graph")?;key(window,cx,"home");capture(&view,window,cx,&out,&format!("graph-{kind}-paused-{}",width as u32),true)})??;
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;
                    wait!("native playback",|p:&Player,_:&App|p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>0.05));
                    let previous=handle.update(cx,|_,window,cx|->anyhow::Result<u64>{capture(&view,window,cx,&out,&format!("graph-{kind}-running-{}",width as u32),true)?;Ok(view.read(cx).last_playback_status.as_ref().unwrap().graph_generation)})??;
                    let rate=1.1+index as f32*0.1;let transpose=index as i32+1;
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.native_transport(transport::TransportEvent::Tempo(rate),cx);p.native_transport(transport::TransportEvent::Transpose(transpose),cx);}))?;
                    wait!("native graph replacement",|p:&Player,cx:&App|p.transport_flight.native_rate_pending.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|s.graph_generation>previous&&(s.rate-rate).abs()<0.001&&s.transpose==transpose)
                        &&p.settings.read(cx).graph_ui_state()["graph"]==native_graph(p).unwrap_or_default());
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                        let replaced=capture(&view,window,cx,&out,&format!("graph-{kind}-replaced-{}",width as u32),true)?;
                        receipts.push(serde_json::json!({"kind":kind,"width":width,"previousGeneration":previous.to_string(),"accepted":replaced}));
                        settings_focus(&view,window,cx,"settings-playback-graph")?;key(window,cx,"end");ui_training_run::draw(window,cx);
                        final_node_visible(&view.read(cx).settings.read(cx).graph_ui_state(),window)?;
                        capture(&view,window,cx,&out,&format!("graph-{kind}-last-{}",width as u32),true)?;
                        read_final_connection(&view,window,cx)?;
                        capture(&view,window,cx,&out,&format!("graph-{kind}-connections-{}",width as u32),true)?;
                        settings_focus(&view,window,cx,"settings-close")?;key(window,cx,"enter");Ok(())
                    })??;
                    wait!("close playback Settings",|p:&Player,_:&App|p.screen==Screen::Player);
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;
                    wait!("native pause",|p:&Player,_:&App|!p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                }
                if kind=="custom" {
                    handle.update(cx,|_,window,cx|header(&view,window,cx,"header-save"))??;
                    wait!("explicit graph Save",|p:&Player,_:&App|!p.saving&&p.edit_seq==p.saved_seq);
                    anyhow::ensure!(std::fs::read(custom.join("graph.json"))?==original_graph,"Save changed custom graph bytes");
                    let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(custom.clone(),cx)))?;
                    wait!("custom graph reopen",|p:&Player,_:&App|p.native_epoch!=epoch&&!p.loading&&p.project.as_ref().is_some_and(|project|project.dir==custom)
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.graph_snapshot.is_some()&&s.explicit_graph));
                    handle.update(cx,|_,window,cx|header(&view,window,cx,"header-settings"))??;
                    wait!("reopened Settings graph",|p:&Player,cx:&App|p.screen==Screen::Settings&&p.settings.read(cx).graph_ui_state()["graph"]==native_graph(p).unwrap_or_default());
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{settings_focus(&view,window,cx,"settings-playback-graph")?;
                        let current=native_graph(view.read(cx))?;let ids:Vec<_>=current["nodes"].as_array().unwrap().iter().map(|n|n["id"].clone()).collect();
                        anyhow::ensure!(ids==supplied_ids,"Reopened native graph replaced its actual node identity");
                        capture(&view,window,cx,&out,"graph-custom-reopened-1060",true)?;Ok(())})??;
                }
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"passed":true,"actualHeaderSettingsKeys":true,
                "ordinaryAndCustomNativeSnapshots":true,"actualGenerationReplacements":true,"allSuppliedNodesAndConnections":true,
                "keyboardHorizontalEnd":true,"keyboardConnectionPageDown":true,"customGraphSaveAndReopen":true,"unloadedMonitorFallback":true,"receipts":receipts,
                "captureCount":23,"physicalInput":false,"hidden":true,"muted":true,"liveFps":"unmeasured",
                "scope":"Actual native runtime graph presentation; rate changes use production transport events; absent/malformed/stale snapshots require separate parser tests; production visual parity unqualified"}))?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>eprintln!("NATIVE_PLAYBACK_GRAPH passed: actual runtime modules, edges, replacements and custom Save/reopen"),
            Err(error)=>{let _=handle.update(cx,|_,window,cx|{ui_training_run::draw(window,cx);if let Ok(image)=window.render_to_image(){let _=image.save(out.join("failure.png"));}});eprintln!("NATIVE_PLAYBACK_GRAPH failed: {error:#}");}
        }
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

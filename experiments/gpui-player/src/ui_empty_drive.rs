//! Actual final-track Remove/Save/Drive sync and fresh-cache native-empty open.
//! All state transitions enter production controls; only files/OAuth are fixtures.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn key(w: &mut Window, cx: &mut App, name: &'static str) {
    let keystroke = Keystroke::parse(name).unwrap();
    w.dispatch_keystroke(keystroke.clone(), cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke }), cx);
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..192 {
        draw(w, cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref() == Some(id) {
            key(w, cx, "enter");
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!("Empty Drive actual Header Tab cannot reach {id}")
}
fn library(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..5 {
        draw(w, cx);
        let library = view.read(cx).library.clone();
        let state = library.read(cx).drive_state(w);
        anyhow::ensure!(
            state["enabledControls"]
                .as_array()
                .is_some_and(|controls| controls.iter().any(|value| value == id)),
            "Actual Library action is unavailable: {id}: {state}"
        );
        let b = library
            .read(cx)
            .drive_bounds(id)
            .ok_or_else(|| anyhow::anyhow!("Actual Library action is unmeasured: {id}"))?;
        if b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.top() >= px(52.)
            && b.bottom() <= w.viewport_size().height
        {
            click(w, cx, b.center());
            return Ok(());
        }
        let delta = if b.top() < px(52.) {
            px(450.)
        } else {
            px(-450.)
        };
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width / 2.,
                    w.viewport_size().height - px(90.),
                ),
                delta: ScrollDelta::Pixels(point(px(0.), delta)),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Empty Drive actual Library control is outside viewport: {id}")
}
fn card(view: &Entity<Player>, w: &mut Window, cx: &mut App, dir: &Path) -> anyhow::Result<()> {
    for _ in 0..8 {
        draw(w, cx);
        if let Some(b) = view.read(cx).library.read(cx).project_delete_bounds(dir) {
            if b.top() >= px(52.) && b.bottom() <= w.viewport_size().height {
                click(w, cx, point(b.left() - px(48.), b.center().y));
                return Ok(());
            }
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width / 2.,
                    w.viewport_size().height - px(90.),
                ),
                delta: ScrollDelta::Pixels(point(px(0.), px(-450.))),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Empty Drive actual card is not visible: {}", dir.display())
}
fn row(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    let id = "drive-projects-row-project-empty-drive";
    for _ in 0..64 {
        draw(w, cx);
        let p = view.read(cx);
        let dialog = p.drive_projects.read(cx);
        let s = dialog.state(w, cx);
        anyhow::ensure!(
            s["focusInside"] == true,
            "Empty Drive browser lost modal keyboard ownership"
        );
        if s["focusedControl"] == id {
            let b = dialog
                .bounds(id)
                .ok_or_else(|| anyhow::anyhow!("Empty Drive row unmeasured"))?;
            anyhow::ensure!(
                b.top() >= px(0.) && b.bottom() <= w.viewport_size().height,
                "Empty Drive row clipped"
            );
            key(w, cx, "enter");
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!("Empty Drive actual browser row unreachable")
}
fn empty(p: &Player) -> bool {
    p.loaded_song
        && p.project.as_ref().is_some_and(|s| {
            s.empty_tracks && !s.has_audio() && s.lanes.is_empty() && s.lane_specs.is_empty()
        })
        && p.duration == 0.
        && p.playhead.position() == 0.
        && !p.playing
        && p.native_graph == 0
        && p.last_playback_status.as_ref().is_some_and(|s| {
            s.empty_project && s.graph_generation == 0 && s.physical_output_released
        })
}
fn marker(path: &Path, value: &serde_json::Value) -> anyhow::Result<()> {
    let temporary = path.with_extension("pending");
    std::fs::write(&temporary, serde_json::to_vec_pretty(value)?)?;
    std::fs::rename(temporary, path)?;
    Ok(())
}
fn state(p: &Player, w: &Window, cx: &App, phase: &str) -> serde_json::Value {
    serde_json::json!({"phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),"drive":p.drive_snapshot,"browser":p.drive_projects.read(cx).state(w,cx),
        "catalogRoot":p.catalog_root,"catalogRows":p.library.read(cx).project_snapshot(),
        "libraryDrive":p.library.read(cx).drive_state(w),
        "project":p.project.as_ref().map(|s|&s.dir),"raw":p.project.as_ref().map(|s|&s.raw),"empty":empty(p),"hasAudio":p.project.as_ref().map(|s|s.has_audio()),
        "laneCount":p.project.as_ref().map(|s|s.lane_specs.len()),"duration":p.duration,"position":p.playhead.position(),"playing":p.playing,"nativeEpoch":p.native_epoch,
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"empty":s.empty_project,"generation":s.graph_generation,"physicalReleased":s.physical_output_released,
            "laneRevision":s.lane_revision,"provider":s.observed_provider,"backendProvider":s.observed_backend_provider,"fixture":s.observed_fixture})),
        "editSeq":p.edit_seq,"savedSeq":p.saved_seq,"saving":p.saving,"notice":p.notice,"micOwner":p.mic_view.owner,"physicalInput":false,"liveFps":"unmeasured"})
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Empty Drive activated a window"
    );
    let mut s = state(view.read(cx), w, cx, name);
    let image = w.render_to_image()?;
    s["raster"] = serde_json::json!([image.width(), image.height()]);
    image.save(out.join(format!("{name}.png")))?;
    marker(&out.join(format!("{name}.state.json")), &s)
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(out.join("requests"))?;std::fs::create_dir_all(out.join("acks"))?;
            let role=std::env::var("SINGZ_GPUI_EMPTY_DRIVE_ROLE")?;
            anyhow::ensure!(["writer","reader","offline"].contains(&role.as_str()),"Invalid Empty Drive role");
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Ok("1"),"Empty Drive requires hidden, muted and no-capture fixture");
            anyhow::ensure!((role=="writer")==std::env::var_os("SINGZ_NO_SYNC").is_none(),"Writer must use production sync; readers must disable writer sync");
            let width=std::env::var("SINGZ_GPUI_EMPTY_DRIVE_WIDTH")?.parse::<u32>()?;
            let height=match width{1280=>800,1060=>640,_=>anyhow::bail!("Unsupported fixture viewport")};
            let mut steps=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.mic_view.owner==0&&$p.mic_intent.is_none()&&!$p.monitor_busy(),"Empty Drive focus/capture invariant");
                        anyhow::ensure!($p.notice.is_none(),"Empty Drive notice: {:?}",$p.notice);Ok($condition)})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Empty Drive timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! act {($w:ident,$app:ident=>$body:expr)=>{handle.update(cx,|_,$w,$app|->anyhow::Result<()>{$body})??};}
            macro_rules! library {($id:expr)=>{{let id=$id;
                wait!(10,p,w,app=>p.screen==Screen::Library&&p.library.read(app).drive_bounds(id).is_some()
                    &&p.library.read(app).drive_state(w)["enabledControls"].as_array().is_some_and(|controls|controls.iter().any(|value|value==id)));
                act!(w,app=>library(&view,w,app,id));
            }};}
            macro_rules! shot {($name:expr)=>{{let name=$name;handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,name))??;steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,name))?);}};}
            macro_rules! handshake {($name:expr)=>{{let name=$name;marker(&out.join("requests").join(format!("{name}.json")),&serde_json::json!({"operation":name}))?;
                let ack=out.join("acks").join(format!("{name}.json"));let deadline=Instant::now()+Duration::from_secs(15);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;if ack.exists(){let value:serde_json::Value=serde_json::from_slice(&std::fs::read(&ack)?)?;anyhow::ensure!(value["ok"]==true,"Empty Drive sidecar refusal: {value}");break;}anyhow::ensure!(Instant::now()<deadline,"Empty Drive sidecar timeout {name}");}
            }};}
            handle.update(cx,|_,w,_|w.resize(size(px(width as f32),px(height as f32))))?;
            wait!(15,p,w,app=>p.backend.is_some()&&p.drive_snapshot.configured&&p.language_state.is_some()&&w.viewport_size()==size(px(width as f32),px(height as f32)));
            if role!="offline" {
                wait!(10,p,w,app=>p.screen==Screen::Library);
                library!("library-drive-connect");
                wait!(15,p,w,app=>!p.drive_test_urls.is_empty());
                let url=handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls[0].clone())?;
                marker(&out.join("authorization-url-0.json"),&serde_json::json!({"url":url}))?;
            }
            wait!(20,p,w,app=>p.drive_snapshot.signed_in&&!p.drive_snapshot.signing_in);
            if role=="writer" {
                let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_EMPTY_DRIVE_PROJECT").ok_or_else(||anyhow::anyhow!("Missing writer fixture path"))?).canonicalize()?;
                let fixture=integration::read_project(&project).map_err(|error|anyhow::anyhow!("Production parser refused writer fixture {}: {error:#}",project.display()))?;
                anyhow::ensure!(fixture.custom_tracks().len()==1&&fixture.has_audio(),"Writer fixture does not contain exactly one playable custom track");
                wait!(45,p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.scheduler.phase==sync_scheduler::Phase::Idle&&p.drive_snapshot.scheduler.last_sync.is_some()
                    &&p.drive_snapshot.scheduler.dirty==0&&p.drive_snapshot.projects.get(&project)==Some(&drive_state::ProjectState::Synced));
                handshake!("baseline");
                // The Drive receipt and LibraryChanged notification do not
                // synchronously adopt the independent Catalog worker's rows.
                // Yield until production recognition paints this exact card.
                wait!(20,p,w,app=>p.library.read(app).project_snapshot().as_array().is_some_and(|rows|rows.iter().any(|row|row["dir"].as_str()==project.to_str()))
                    &&p.library.read(app).project_delete_bounds(&project).is_some());
                act!(w,app=>card(&view,w,app,&project));
                wait!(20,p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project&&s.custom_tracks().len()==1&&s.has_audio()));
                cx.background_executor().timer(Duration::from_millis(700)).await;shot!("before-remove");
                let slot=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().custom_tracks()[0].slot)?;
                act!(w,app=>crate::ui_custom_tracks::press(&view,w,app,&format!("remove-{slot}")));
                wait!(15,p,w,app=>p.tracks_flight.tracks_pending.is_none()&&empty(p)&&p.edit_seq!=p.saved_seq);
                act!(w,app=>header(&view,w,app,"header-save"));
                wait!(15,p,w,app=>!p.saving&&p.edit_seq==p.saved_seq&&empty(p));
                let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(project.join("project.json"))?)?;
                anyhow::ensure!(saved["settings"]["nativeEmptyTracks"]==true&&saved["settings"]["nativeOriginalDisabled"]==true&&saved["settings"]["custom"].as_array().is_some_and(Vec::is_empty),"Actual Save did not persist explicit empty intent");
                marker(&out.join("saved-empty-document.json"),&saved)?;
                act!(w,app=>header(&view,w,app,"header-catalog"));
                wait!(8,p,w,app=>p.screen==Screen::Library&&!p.drive_snapshot.busy);
                library!("library-drive-sync");
                wait!(40,p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.progress=="Finishing Drive sync…"&&p.drive_snapshot.scheduler.phase==sync_scheduler::Phase::Pending);
                act!(w,app=>{anyhow::ensure!(view.read(app).library.read(app).drive_state(w)["upToDate"]==false,"Pending continuation incorrectly paints up to date");Ok(())});
                let pending_at=Instant::now();shot!("explicit-continuation-pending");
                let pending=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.scheduler.clone())?;
                anyhow::ensure!(pending.run_at.is_some(),"Explicit continuation has no scheduled deadline");
                wait!(45,p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.error.is_none()&&p.drive_snapshot.scheduler.phase==sync_scheduler::Phase::Idle
                    &&p.drive_snapshot.scheduler.last_error.is_none()&&p.drive_snapshot.scheduler.dirty==0&&p.drive_snapshot.scheduler.last_sync>pending.last_sync
                    &&p.drive_snapshot.projects.get(&project)==Some(&drive_state::ProjectState::Synced));
                anyhow::ensure!(pending_at.elapsed()>=Duration::from_secs(3),"Explicit 4-second continuation ran without debounce");
                act!(w,app=>{anyhow::ensure!(view.read(app).library.read(app).drive_state(w)["upToDate"]==true,"Completed continuation does not paint up to date");Ok(())});
                shot!("synced-empty");handshake!("committed");
            } else {
                library!("library-drive-browse");
                wait!(30,p,w,app=>{let s=p.drive_projects.read(app).state(w,app);p.drive_projects_open&&s["busy"]==false
                    &&s["visibleRows"].as_array().is_some_and(|rows|rows.iter().any(|r|r["id"]=="project-empty-drive"))});
                shot!(if role=="offline"{"offline-browser"}else{"fresh-browser"});
                act!(w,app=>row(&view,w,app));
                wait!(30,p,w,app=>!p.drive_projects_open&&!p.loading&&empty(p));
                act!(w,app=>{let p=view.read(app);let project=p.project.as_ref().unwrap();let raw=&project.raw;
                    anyhow::ensure!(raw["settings"]["nativeEmptyTracks"]==true&&raw["settings"]["nativeOriginalDisabled"]==true&&raw["settings"]["custom"].as_array().is_some_and(Vec::is_empty)
                        &&!project.original&&project.lane_specs.is_empty(),"Fresh reader resurrected audio");
                    anyhow::ensure!(project.dir.starts_with(crate::audio_devices::directory().join("gdrive/downloads").canonicalize()?),"Reader opened outside private download cache");Ok(())});
                shot!(if role=="offline"{"offline-empty-open"}else{"fresh-empty-open"});
                handshake!("reader-proof");
            }
            marker(&out.join("result.json"),&serde_json::json!({"passed":true,"role":role,"width":width,"height":height,"actualControls":true,
                "hidden":true,"muted":true,"physicalInput":false,"steps":steps,"liveFps":"unmeasured","productionParity":"unqualified; native candidate captures only"}))?;Ok(())
        }.await;
        match result{Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));eprintln!("EMPTY_DRIVE failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

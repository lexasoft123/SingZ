//! Actual final-project Delete, typed Rename and fresh same-name Drive lineage.
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
fn empty(p: &Player) -> bool {
    p.loaded_song
        && p.project.as_ref().is_some_and(|s| {
            s.empty_tracks && !s.has_audio() && s.lanes.is_empty() && s.lane_specs.is_empty()
        })
        && p.duration == 0.
        && p.position == 0.
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
        "libraryDrive":p.library.read(cx).drive_state(w),"picker":p.project_picker.read(cx).state(w,cx),"deleteDialog":p.project_delete.read(cx).state(w,cx),
        "project":p.project.as_ref().map(|s|&s.dir),"raw":p.project.as_ref().map(|s|&s.raw),"empty":empty(p),"hasAudio":p.project.as_ref().map(|s|s.has_audio()),
        "laneCount":p.project.as_ref().map(|s|s.lane_specs.len()),"duration":p.duration,"position":p.position,"playing":p.playing,"nativeEpoch":p.native_epoch,
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
fn storage(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    for _ in 0..8 {
        draw(w, cx);
        let b = view
            .read(cx)
            .library
            .read(cx)
            .guides
            .get("storage")
            .ok_or_else(|| anyhow::anyhow!("Storage Change control missing"))?;
        if b.top() >= px(52.) && b.bottom() <= w.viewport_size().height {
            click(w, cx, b.center());
            return Ok(());
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width / 2.,
                    w.viewport_size().height - px(90.),
                ),
                delta: ScrollDelta::Pixels(point(
                    px(0.),
                    if b.top() < px(52.) {
                        px(450.)
                    } else {
                        px(-450.)
                    },
                )),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Storage Change control clipped")
}
fn picker_target(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    dir: &Path,
) -> anyhow::Result<()> {
    draw(w, cx);
    let dialog = view.read(cx).project_picker.read(cx);
    let state = dialog.state(w, cx);
    anyhow::ensure!(
        state["loading"] == false && state["moving"] == false && state["focusInside"] == true,
        "ProjectPicker not ready: {state}"
    );
    let index = state["projects"]
        .as_array()
        .and_then(|rows| {
            rows.iter()
                .position(|row| row["dir"].as_str() == dir.to_str())
        })
        .ok_or_else(|| anyhow::anyhow!("Fresh project is not recognized by production picker"))?;
    let b = dialog
        .bounds(&format!("picker-row-{index}"))
        .ok_or_else(|| anyhow::anyhow!("Picker row unmeasured"))?;
    anyhow::ensure!(
        b.top() >= px(0.)
            && b.bottom() <= w.viewport_size().height
            && b.left() >= px(0.)
            && b.right() <= w.viewport_size().width,
        "Picker row clipped"
    );
    click(w, cx, b.center());
    Ok(())
}
fn type_title(w: &mut Window, cx: &mut App, title: &str) {
    key(
        w,
        cx,
        if cfg!(target_os = "macos") {
            "cmd-a"
        } else {
            "ctrl-a"
        },
    );
    for ch in title.chars() {
        let keystroke = Keystroke {
            key: if ch == ' ' {
                "space".into()
            } else {
                ch.to_string()
            },
            key_char: Some(ch.to_string()),
            ..Default::default()
        };
        w.dispatch_keystroke(keystroke.clone(), cx);
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke }), cx);
    }
    key(w, cx, "enter");
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(out.join("requests"))?;std::fs::create_dir_all(out.join("acks"))?;
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_NO_SYNC").is_none(),"Retirement requires hidden muted production writer without capture");
            let width=std::env::var("SINGZ_GPUI_DRIVE_RETIREMENT_WIDTH")?.parse::<u32>()?;let height=match width{1280=>800,1060=>640,_=>anyhow::bail!("Unsupported retirement viewport")};
            let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_DRIVE_RETIREMENT_PROJECT").ok_or_else(||anyhow::anyhow!("Missing retirement project"))?).canonicalize()?;
            let title=format!("Renamed Drive {width}");let renamed=project.parent().unwrap().join(&title);let mut steps=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);loop{
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{draw($w,$app);let $p=view.read($app);anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.mic_view.owner==0&&$p.mic_intent.is_none()&&!$p.monitor_busy(),"Retirement focus/input invariant");anyhow::ensure!($p.notice.is_none(),"Retirement notice: {:?}",$p.notice);Ok($condition)})??{break;}
                anyhow::ensure!(Instant::now()<deadline,"Retirement timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
            }}};}
            macro_rules! act {($w:ident,$app:ident=>$body:expr)=>{handle.update(cx,|_,$w,$app|->anyhow::Result<()>{$body})??};}
            macro_rules! shot {($name:expr)=>{{let name=$name;handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,name))??;steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,name))?);}};}
            macro_rules! handshake {($name:expr)=>{{let name=$name;marker(&out.join("requests").join(format!("{name}.json")),&serde_json::json!({"operation":name}))?;let ack=out.join("acks").join(format!("{name}.json"));let deadline=Instant::now()+Duration::from_secs(20);loop{cx.background_executor().timer(Duration::from_millis(20)).await;if ack.exists(){let value:serde_json::Value=serde_json::from_slice(&std::fs::read(&ack)?)?;anyhow::ensure!(value["ok"]==true,"Retirement sidecar: {value}");break;}anyhow::ensure!(Instant::now()<deadline,"Retirement handshake timeout {name}");}}};}
            macro_rules! library {($id:expr)=>{{let id=$id;wait!(10,p,w,app=>p.screen==Screen::Library&&p.library.read(app).drive_bounds(id).is_some()&&p.library.read(app).drive_state(w)["enabledControls"].as_array().is_some_and(|controls|controls.iter().any(|c|c==id)));act!(w,app=>library(&view,w,app,id));}};}
            macro_rules! clean {()=>{wait!(60,p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.is_up_to_date()&&p.drive_snapshot.scheduler.last_sync.is_some())};}
            macro_rules! sync {($name:expr)=>{{let before=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.scheduler.last_sync)?;library!("library-drive-sync");wait!(60,p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.is_up_to_date()&&p.drive_snapshot.scheduler.last_sync>before);shot!($name);}};}
            macro_rules! empty_save_sync {($name:expr)=>{{cx.background_executor().timer(Duration::from_millis(700)).await;let slot=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().custom_tracks()[0].slot)?;
                act!(w,app=>crate::ui_custom_tracks::press(&view,w,app,&format!("remove-{slot}")));wait!(15,p,w,app=>p.tracks_pending.is_none()&&empty(p)&&p.edit_seq!=p.saved_seq);
                act!(w,app=>header(&view,w,app,"header-save"));wait!(15,p,w,app=>!p.saving&&p.edit_seq==p.saved_seq&&empty(p));act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Library);sync!($name);
            }};}
            macro_rules! open_fresh {($name:expr)=>{{
                wait!(10,p,w,app=>p.screen==Screen::Library&&p.library.read(app).guides.get("storage").is_some());act!(w,app=>storage(&view,w,app));
                wait!(20,p,w,app=>{let s=p.project_picker.read(app).state(w,app);p.project_picker_open&&s["loading"]==false&&s["projects"].as_array().is_some_and(|rows|rows.iter().any(|row|row["dir"].as_str()==project.to_str()))});
                act!(w,app=>picker_target(&view,w,app,&project));wait!(20,p,w,app=>!p.project_picker_open&&!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project&&s.has_audio()&&s.custom_tracks().len()==1)&&p.last_playback_status.as_ref().is_some_and(|s|!s.empty_project));shot!($name);
            }};}
            handle.update(cx,|_,w,_|w.resize(size(px(width as f32),px(height as f32))))?;
            wait!(15,p,w,app=>p.backend.is_some()&&p.drive_snapshot.configured&&p.language_state.is_some()&&w.viewport_size()==size(px(width as f32),px(height as f32)));
            library!("library-drive-connect");wait!(15,p,w,app=>!p.drive_test_urls.is_empty());let url=handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls[0].clone())?;marker(&out.join("authorization-url-0.json"),&serde_json::json!({"url":url}))?;
            wait!(20,p,w,app=>p.drive_snapshot.signed_in&&!p.drive_snapshot.signing_in);clean!();handshake!("baseline");
            wait!(20,p,w,app=>p.library.read(app).project_delete_bounds(&project).is_some());act!(w,app=>card(&view,w,app,&project));wait!(20,p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project&&s.custom_tracks().len()==1));
            empty_save_sync!("empty-lineage-one");handshake!("empty-one");
            // This is the sole local project. Use the actual card Delete and
            // confirmation; no fake clear/unload path can satisfy this phase.
            wait!(15,p,w,app=>p.library.read(app).project_delete_bounds(&project).is_some());
            act!(w,app=>{let b=view.read(app).library.read(app).project_delete_bounds(&project).unwrap();anyhow::ensure!(b.top()>=px(52.)&&b.bottom()<=w.viewport_size().height,"Delete card clipped");click(w,app,b.center());Ok(())});
            wait!(15,p,w,app=>p.delete_inspect_pending.is_none()&&p.project_delete.read(app).is_open());shot!("confirm-last-project-delete");
            act!(w,app=>{let b=view.read(app).project_delete.read(app).bounds("project-delete-confirm").ok_or_else(||anyhow::anyhow!("Delete confirm unmeasured"))?;click(w,app,b.center());Ok(())});
            wait!(20,p,w,app=>p.delete_pending.is_none()&&!p.project_delete.read(app).is_open()&&!project.exists()&&p.project.is_none()&&!p.loaded_song&&!p.playing&&p.library.read(app).project_snapshot().as_array().is_some_and(Vec::is_empty));
            sync!("last-project-deleted-synced");handshake!("deleted-last");handshake!("prepare-after-delete");open_fresh!("fresh-after-delete-open");
            act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Library);sync!("fresh-after-delete-synced");handshake!("fresh-after-delete");
            act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Player);empty_save_sync!("empty-lineage-two");handshake!("empty-two");
            act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Player&&p.header.read(app).rename_bounds.get().is_some());
            act!(w,app=>{let b=view.read(app).header.read(app).rename_bounds.get().unwrap();anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=px(52.),"Rename pencil clipped");click(w,app,b.center());Ok(())});
            wait!(10,p,w,app=>p.header.read(app).is_editing()&&p.header.read(app).title_input_focused(w,app));shot!("rename-editor");act!(w,app=>{type_title(w,app,&title);Ok(())});
            wait!(20,p,w,app=>!p.loading&&p.rename_pending.is_none()&&p.project.as_ref().is_some_and(|s|s.dir==renamed)&&!project.exists()&&renamed.is_dir()&&empty(p));
            if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.edit_seq!=p.saved_seq})? {act!(w,app=>header(&view,w,app,"header-save"));wait!(15,p,w,app=>!p.saving&&p.edit_seq==p.saved_seq);}
            act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Library);sync!("renamed-synced");handshake!("renamed");handshake!("prepare-after-rename");open_fresh!("fresh-after-rename-open");
            act!(w,app=>header(&view,w,app,"header-catalog"));wait!(10,p,w,app=>p.screen==Screen::Library);sync!("fresh-after-rename-synced");handshake!("complete");
            marker(&out.join("result.json"),&serde_json::json!({"passed":true,"width":width,"height":height,"hidden":true,"muted":true,"physicalInput":false,"actualControls":true,"steps":steps,"liveFps":"unmeasured","visualParity":"unqualified candidate captures"}))?;Ok(())
        }.await;
        match result{Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));eprintln!("DRIVE_RETIREMENT failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

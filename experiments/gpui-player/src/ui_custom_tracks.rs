//! Background native custom-track controls and durable file lifecycle.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{path::PathBuf, time::Duration};
pub(super) fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..8 {
        draw(w, cx);
        if let Some(slot) = id
            .strip_prefix("edit-")
            .or_else(|| id.strip_prefix("remove-"))
        {
            let title = view
                .read(cx)
                .track_bounds
                .borrow()
                .get(&format!("title-{slot}"))
                .copied();
            if let Some(title) = title {
                w.dispatch_event(
                    PlatformInput::MouseMove(MouseMoveEvent {
                        position: title.center(),
                        pressed_button: None,
                        modifiers: Modifiers::default(),
                    }),
                    cx,
                );
                draw(w, cx);
            }
        }
        let measured = view.read(cx).track_bounds.borrow().get(id).copied();
        if let Some(b) = measured {
            if b.top() >= px(52.)
                && b.bottom() <= w.viewport_size().height
                && b.left() >= px(0.)
                && b.right() <= w.viewport_size().width
            {
                click(w, cx, b.center());
                return Ok(());
            }
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(px(180.), px(180.)),
                delta: ScrollDelta::Pixels(point(px(0.), px(-300.))),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Custom track control {id} not reachable")
}
fn key(w: &mut Window, cx: &mut App, key: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
    draw(w, cx);
}
fn snapshot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &std::path::Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Custom track test activated window"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let settled=p.project.as_ref().is_some_and(|project|project.lane_specs.iter().enumerate().all(|(ordinal,lane)|p.lane_entered.get(&lane.id).is_some_and(|at|at.elapsed().as_secs_f32()>=0.55+ordinal as f32*0.07)));
    anyhow::ensure!(settled,"Custom-track capture was requested before its entrances settled");
    std::fs::write(
        out.join(format!("{name}.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"lanes":p.project.as_ref().map(|s|&s.lane_specs),"duration":p.duration,"playing":p.playing,"position":p.playhead.position(),"gain":p.gain.as_slice(),"epoch":p.native_epoch,"pending":p.tracks_flight.tracks_pending,"saving":p.saving,"editSeq":p.edit_seq,"savedSeq":p.saved_seq,"focusedRoot":p.focus_handle.is_focused(w),"error":p.notice,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"entrancesSettled":settled,"hidden":true,"liveFps":"unmeasured","visualReference":"candidate only; production matched references absent"}),
        )?,
    )?;
    Ok(())
}
fn rename_project(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    let header = view.read(cx).header.clone();
    let b = header
        .read(cx)
        .rename_bounds
        .get()
        .ok_or_else(|| anyhow::anyhow!("Project pencil not measured"))?;
    click(w, cx, b.center());
    draw(w, cx);
    anyhow::ensure!(header.read(cx).is_editing(), "Project rename did not open");
    let input = header.read(cx).title_state();
    input.update(cx, |s, cx| s.replace_all(name, w, cx));
    key(w, cx, "enter");
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;
            let mut project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap()).canonicalize()?;
            macro_rules! wait{($p:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);loop{cx.background_executor().timer(Duration::from_millis(25)).await;if handle.update(cx,|_,_,$app|{let $p=view.read($app);$condition})?{break;}anyhow::ensure!(Instant::now()<deadline,"Custom tracks timeout: {}",stringify!($condition));}}};}
            for (width,height) in [(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|{p.notice=None;p.open_project(project.clone(),cx);});})?;
                wait!(p,cx=>!p.loading&&p.project.is_some()&&p.screen==Screen::Player);
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;wait!(p,cx=>p.playing&&p.playhead.position()>0.05);
                let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,w,cx|press(&view,w,cx,"add"))??;
                wait!(p,cx=>p.tracks_flight.tracks_pending.is_none()&&p.project.as_ref().is_some_and(|s|s.custom_tracks().len()==2));
                let first=handle.update(cx,|_,_,cx|->anyhow::Result<tracks::Lane>{let p=view.read(cx);anyhow::ensure!(p.notice.as_ref().is_some_and(|s|s.to_lowercase().contains("broken")),"Mixed picker batch did not report its rejected audio");anyhow::ensure!(p.native_epoch==epoch&&p.playing&&p.duration>=6.&&p.edit_seq!=p.saved_seq&&p.project.as_ref().is_some_and(|s|s.pitch.f0.len()==300)&&p.pitch_strip.read(cx).native_duration()==Some(p.duration),"Add lost native playback/epoch or duration");Ok(p.project.as_ref().unwrap().custom_tracks()[0].clone())})??;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;cx.notify();}))?;
                // Record settled rows, then exercise visible controls. This is
                // appearance evidence, not a live display-cadence measurement.
                cx.background_executor().timer(Duration::from_millis(900)).await;
                handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,&format!("added-{}",width as u32)))??;
                handle.update(cx,|_,w,cx|{press(&view,w,cx,&format!("edit-{}",first.slot))?;let input=view.read(cx).track_name_input.clone();input.update(cx,|s,cx|s.replace_all("  Renamed harmony 🎤  ",w,cx));key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
                wait!(p,cx=>p.track_rename.is_none()&&p.project.as_ref().is_some_and(|s|s.lane_specs.iter().any(|l|l.id==first.id&&l.label=="Renamed harmony 🎤")));
                // A separate Escape edit must not leak playback shortcuts or rename.
                handle.update(cx,|_,w,cx|{press(&view,w,cx,&format!("edit-{}",first.slot))?;let input=view.read(cx).track_name_input.clone();input.update(cx,|s,cx|s.replace_all("Discard this name",w,cx));key(w,cx,"escape");Ok::<_,anyhow::Error>(())})??;
                let renamed=format!("Added handoff {}",width as u32);
                handle.update(cx,|_,w,cx|rename_project(&view,w,cx,&renamed))??;
                wait!(p,cx=>!p.loading&&p.rename_pending.is_none()&&p.project.as_ref().is_some_and(|s|s.name==renamed&&s.custom_tracks().len()==2));
                project=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().dir.clone())?;
                handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){ "cmd-s" }else{"ctrl-s"}))?;
                wait!(p,cx=>!p.saving&&p.saved_seq==p.edit_seq);
                let saved=std::fs::read(project.join("project.json"))?;std::fs::write(out.join(format!("saved-{}.json",width as u32)),&saved)?;
                let raw:serde_json::Value=serde_json::from_slice(&saved)?;let mut hashes=serde_json::Map::new();
                for entry in raw["settings"]["custom"].as_array().unwrap(){let bytes=std::fs::read(project.join(entry["file"].as_str().unwrap()))?;hashes.insert(entry["id"].as_str().unwrap().into(),serde_json::json!(project_store::fingerprint(&bytes)));}
                std::fs::write(out.join(format!("saved-media-{}.json",width as u32)),serde_json::to_vec_pretty(&hashes)?)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.custom_tracks().len()==2));
                let specs=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().custom_tracks())?;
                anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().pitch.f0.len()==300)?,"Long custom lane invalidated saved vocal pitch");
                anyhow::ensure!(specs.iter().any(|l|l.id==first.id&&l.label=="Renamed harmony 🎤"&&l.file.starts_with(&project)),"Save/reopen lost stable ID/name/owned path");
                cx.background_executor().timer(Duration::from_millis(900)).await;
                handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,&format!("reopened-{}",width as u32)))??;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{if !p.looping{p.native_transport(transport::TransportEvent::Loop,cx);}}))?;
                wait!(p,cx=>p.playhead.loop_range().is_some());
                for lane in specs{
                    handle.update(cx,|_,w,cx|press(&view,w,cx,&format!("remove-{}",lane.slot)))??;
                    wait!(p,cx=>p.tracks_flight.tracks_pending.is_none()&&p.project.as_ref().is_some_and(|s|!s.lane_specs.iter().any(|l|l.id==lane.id)));
                }
                let renamed=format!("Removed handoff {}",width as u32);
                handle.update(cx,|_,w,cx|rename_project(&view,w,cx,&renamed))??;
                wait!(p,cx=>!p.loading&&p.rename_pending.is_none()&&p.project.as_ref().is_some_and(|s|s.name==renamed&&s.custom_tracks().is_empty()));
                project=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().dir.clone())?;
                handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){ "cmd-s" }else{"ctrl-s"}))?;
                wait!(p,cx=>!p.saving&&p.saved_seq==p.edit_seq);
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
                wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|s|s.custom_tracks().is_empty())&&p.duration<4.&&p.playhead.loop_range().is_some_and(|(_,end)|end<=p.duration+0.001));
                cx.background_executor().timer(Duration::from_millis(900)).await;
                handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,&format!("removed-{}",width as u32)))??;
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"finalProject":project,"unsavedAddRename":true,"unsavedRemoveRename":true,"twoSizes":true,"nativeAddButton":true,"pickerFixtureBoundary":true,"nativePlaybackPreserved":true,"longerDuration":true,"renameEnterEscape":true,"stableIdentity":true,"saveReopen":true,"removeSaveReopen":true,"hidden":true,"chooserPresentation":"not exercised","productionParity":"unqualified"}))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("CUSTOM_TRACKS passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"failure"));eprintln!("CUSTOM_TRACKS failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

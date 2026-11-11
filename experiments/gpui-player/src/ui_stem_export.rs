//! Actual hidden ruler export controls, chooser boundary and native worker.
use super::*;
use crate::ui_training_run::{click, draw};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn key(w: &mut Window, cx: &mut App, key: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(key).unwrap(), cx);
    draw(w, cx);
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    let mut fixed_card = None;
    for _ in 0..12 {
        draw(w, cx);
        let dialog = view.read(cx).stem_export_dialog.clone();
        let b = dialog.read(cx).bounds(id);
        let card = dialog.read(cx).bounds("export-card");
        if let Some(card) = card {
            if let Some(previous) = fixed_card {
                anyhow::ensure!(
                    card == previous,
                    "Export viewport probe moved with scroll contents"
                );
            }
            fixed_card = Some(card);
        }
        if let (Some(b), Some(card)) = (b, card) {
            if b.top() >= card.top() + px(15.) && b.bottom() <= card.bottom() - px(15.) {
                click(w, cx, b.center());
                draw(w, cx);
                return Ok(());
            }
            let delta = if b.top() < card.top() + px(15.) {
                240.
            } else {
                -240.
            };
            w.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: card.center(),
                    delta: ScrollDelta::Pixels(point(px(0.), px(delta))),
                    ..Default::default()
                }),
                cx,
            );
        } else if let Some(card) = card {
            let up = id.starts_with("export-mode-")
                || id
                    .strip_prefix("export-track-")
                    .and_then(|s| s.parse::<usize>().ok())
                    .is_some_and(|i| i < 8);
            w.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: card.center(),
                    delta: ScrollDelta::Pixels(point(px(0.), px(if up { 240. } else { -240. }))),
                    ..Default::default()
                }),
                cx,
            );
        }
    }
    let dialog = view.read(cx).stem_export_dialog.clone();
    anyhow::bail!(
        "Export control not reachable: {id}; target {:?}, viewport {:?}",
        dialog.read(cx).bounds(id),
        dialog.read(cx).bounds("export-card")
    )
}
fn snapshot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Export test activated window"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let state = p.stem_export_dialog.read(cx).state(w, cx);
    std::fs::write(
        out.join(format!("{name}.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"dialog":state,"open":p.stem_export_open,"job":p.stem_export_job,"closePending":p.stem_export_close_pending,"finishedIds":p.stem_export_finished_ids,"project":p.project.as_ref().map(|p|&p.dir),"playing":p.playing,"position":p.position,"epoch":p.native_epoch,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":true,"liveFps":"unmeasured","productionParity":"unqualified; candidate only"}),
        )?,
    )?;
    Ok(())
}
fn queue(view: &Entity<Player>, cx: &mut App, path: Option<PathBuf>) {
    view.update(cx, |p, _| p.stem_export_picker_paths.push_back(path));
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());
            let dest=PathBuf::from(std::env::var_os("SINGZ_GPUI_STEM_EXPORT_DEST").unwrap());
            macro_rules! wait{($p:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(45);loop{cx.background_executor().timer(Duration::from_millis(25)).await;if handle.update(cx,|_,_,$app|{let $p=view.read($app);$condition})?{break;}anyhow::ensure!(Instant::now()<deadline,"Export timeout: {}",stringify!($condition));}}};}
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|{p.notice=None;p.open_project(project.clone(),cx);});})?;
                let deadline=Instant::now()+Duration::from_secs(5);loop{if handle.update(cx,|_,w,_|w.viewport_size()==size(px(width),px(height)))?{break;}cx.background_executor().timer(Duration::from_millis(25)).await;anyhow::ensure!(Instant::now()<deadline,"Resize did not settle");}
                wait!(p,cx=>!p.loading&&p.project.as_ref().is_some_and(|p|p.lane_specs.len()==16));
                handle.update(cx,|_,w,cx|crate::ui_custom_tracks::press(&view,w,cx,"export"))??;
                wait!(p,cx=>p.stem_export_open);
                handle.update(cx,|_,w,cx|{let dialog=view.read(cx).stem_export_dialog.clone();dialog.update(cx,|d,cx|d.set_animation_time(Some(0.25),cx));draw(w,cx);let state=dialog.read(cx).state(w,cx);anyhow::ensure!(state["mode"]=="stems"&&state["format"]=="mp3"&&state["selected"].as_array().unwrap().len()==16,"Export defaults changed");snapshot(&view,w,cx,&out,&format!("default-{}",width as u32))})??;
                // Traverse actual native handles across clipped rows; no player
                // transport shortcut may activate behind the modal.
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let dialog=view.read(cx).stem_export_dialog.clone();let playing=view.read(cx).playing;for i in 0..24{let before=dialog.read(cx).state(w,cx);let order=before["focusOrder"].as_array().unwrap();let expected=order[(order.iter().position(|v|v==&before["focusedControl"]).map(|i|i+1).unwrap_or(0))%order.len()].clone();key(w,cx,"tab");let state=dialog.read(cx).state(w,cx);anyhow::ensure!(state["focusInside"]==true&&state["focusedControl"]==expected&&state["keyboardFocus"]==true,"Tab escaped export modal or skipped a real control");if i==18{snapshot(&view,w,cx,&out,&format!("scrolled-{}",width as u32))?;}}key(w,cx,"shift-tab");anyhow::ensure!(view.read(cx).playing==playing,"Modal keys changed playback");snapshot(&view,w,cx,&out,&format!("keyboard-{}",width as u32))})??;
                handle.update(cx,|_,w,cx|{queue(&view,cx,None);press(&view,w,cx,"export-run")})??;
                wait!(p,cx=>!p.stem_export_prompt&&p.stem_export_job.is_none());
                handle.update(cx,|_,w,cx|{let p=view.read(cx);anyhow::ensure!(p.stem_export_open&&p.stem_export_dialog.read(cx).state(w,cx)["busy"]==false,"Folder cancellation did not restore dialog");Ok::<_,anyhow::Error>(())})??;
                // Default MP3 exports every original source, independent of mix.
                let mp3=dest.join(format!("mp3-{}",width as u32));std::fs::create_dir_all(&mp3)?;
                handle.update(cx,|_,w,cx|{queue(&view,cx,Some(mp3.clone()));press(&view,w,cx,"export-run")})??;
                wait!(p,cx=>!p.stem_export_prompt&&p.stem_export_job.is_none());
                handle.update(cx,|_,w,cx|{anyhow::ensure!(view.read(cx).stem_export_dialog.read(cx).state(w,cx)["status"]=="Tracks exported","Default export failed");snapshot(&view,w,cx,&out,&format!("mp3-done-{}",width as u32))})??;
                let mut existing=std::collections::BTreeMap::new();for e in std::fs::read_dir(&mp3)?{let p=e?.path();existing.insert(p.clone(),project_store::fingerprint(&std::fs::read(&p)?));}
                anyhow::ensure!(existing.len()==16,"Default MP3 did not export all sources");
                handle.update(cx,|_,w,cx|{queue(&view,cx,Some(mp3.clone()));press(&view,w,cx,"export-run")})??;
                wait!(p,cx=>!p.stem_export_prompt&&p.stem_export_job.is_none());
                handle.update(cx,|_,w,cx|{let status=view.read(cx).stem_export_dialog.read(cx).state(w,cx)["status"].as_str().unwrap().to_owned();anyhow::ensure!(status.starts_with("Could not export tracks:"),"Collision did not show failure: {status}");snapshot(&view,w,cx,&out,&format!("collision-{}",width as u32))})??;
                for (p,hash) in existing{anyhow::ensure!(project_store::fingerprint(&std::fs::read(p)?)==hash,"Collision replaced an existing export");}
                // All sixteen actual checkboxes must update selection; an empty
                // set disables Start and cannot consume a queued chooser.
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{for i in 0..16{press(&view,w,cx,&format!("export-track-{i}"))?;}let dialog=view.read(cx).stem_export_dialog.clone();let state=dialog.read(cx).state(w,cx);anyhow::ensure!(state["selected"].as_array().unwrap().is_empty(),"Checkboxes did not clear selection");anyhow::ensure!(!state["focusOrder"].as_array().unwrap().iter().any(|v|v=="export-run"),"Empty selection Start remained enabled");let before=view.read(cx).stem_export_picker_paths.len();press(&view,w,cx,"export-run")?;anyhow::ensure!(view.read(cx).stem_export_picker_paths.len()==before&&view.read(cx).stem_export_job.is_none(),"Disabled Start launched export");snapshot(&view,w,cx,&out,&format!("empty-selection-{}",width as u32))})??;
                let wav=dest.join(format!("wav-{}",width as u32));std::fs::create_dir_all(&wav)?;
                handle.update(cx,|_,w,cx|{press(&view,w,cx,"export-track-0")?;press(&view,w,cx,"export-track-15")?;press(&view,w,cx,"export-format-wav")?;queue(&view,cx,Some(wav.clone()));press(&view,w,cx,"export-run")})??;
                wait!(p,cx=>!p.stem_export_prompt&&p.stem_export_job.is_none());
                handle.update(cx,|_,w,cx|{anyhow::ensure!(view.read(cx).stem_export_dialog.read(cx).state(w,cx)["status"]=="Tracks exported","Selected WAV export failed");snapshot(&view,w,cx,&out,&format!("wav-selected-{}",width as u32))})??;
                let flac=dest.join(format!("karaoke-{}",width as u32));std::fs::create_dir_all(&flac)?;
                handle.update(cx,|_,w,cx|{press(&view,w,cx,"export-mode-karaoke")?;press(&view,w,cx,"export-format-flac")?;snapshot(&view,w,cx,&out,&format!("karaoke-{}",width as u32))?;queue(&view,cx,Some(flac.clone()));press(&view,w,cx,"export-run")})??;
                wait!(p,cx=>!p.stem_export_prompt&&p.stem_export_job.is_none());
                handle.update(cx,|_,w,cx|{anyhow::ensure!(view.read(cx).stem_export_dialog.read(cx).state(w,cx)["status"]=="Tracks exported","Karaoke FLAC export failed");key(w,cx,"escape");Ok::<_,anyhow::Error>(())})??;
                wait!(p,cx=>!p.stem_export_open);
                handle.update(cx,|_,w,cx|crate::ui_custom_tracks::press(&view,w,cx,"export"))??;
                wait!(p,cx=>p.stem_export_open);
                let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_STEM_EXPORT_GATE").unwrap());let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold")?;
                let cancelled=dest.join(format!("cancel-{}",width as u32));std::fs::create_dir_all(&cancelled)?;
                handle.update(cx,|_,w,cx|{draw(w,cx);queue(&view,cx,Some(cancelled.clone()));press(&view,w,cx,"export-run")})??;
                let deadline=Instant::now()+Duration::from_secs(5);while !ready.exists(){cx.background_executor().timer(Duration::from_millis(10)).await;anyhow::ensure!(Instant::now()<deadline,"Export worker gate not entered");}
                let cancel_id=handle.update(cx,|_,_,cx|view.read(cx).stem_export_job.ok_or_else(||anyhow::anyhow!("Busy export has no actual job")))??;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let dialog=view.read(cx).stem_export_dialog.clone();let state=dialog.read(cx).state(w,cx);anyhow::ensure!(state["busy"]==true&&state["focusOrder"]==serde_json::json!(["export-cancel"]),"Busy controls were actionable");press(&view,w,cx,"export-format-wav")?;anyhow::ensure!(dialog.read(cx).state(w,cx)["format"]=="mp3","Busy format changed");snapshot(&view,w,cx,&out,&format!("busy-{}",width as u32))?;press(&view,w,cx,"export-cancel")?;Ok(())})??;
                // cx.emit queues an effect. Inspect Root only after that update
                // drains the real Close subscription, with a terminal receipt
                // ledger resolving the legitimate fast-cancellation race.
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);if p.stem_export_open {anyhow::ensure!(p.stem_export_close_pending&&p.stem_export_job==Some(cancel_id),"Actual Cancel did not request worker cancellation");}else{anyhow::ensure!(p.stem_export_job.is_none()&&p.stem_export_finished_ids.contains(&cancel_id),"Busy Cancel hid before actual worker Finished receipt");}Ok(())})??;
                wait!(p,cx=>!p.stem_export_open&&p.stem_export_job.is_none());let _=std::fs::remove_file(&gate);
                anyhow::ensure!(std::fs::read_dir(&cancelled)?.next().is_none(),"Cancelled export left partial output");
                handle.update(cx,|_,w,cx|crate::ui_custom_tracks::press(&view,w,cx,"export"))??;wait!(p,cx=>p.stem_export_open);
                cx.background_executor().timer(Duration::from_millis(100)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let state=view.read(cx).stem_export_dialog.read(cx).state(w,cx);anyhow::ensure!(state["busy"]==false&&state["status"]==""&&state["mode"]=="stems"&&state["format"]=="mp3","Old cancellation receipt polluted reopened session");snapshot(&view,w,cx,&out,&format!("reopened-{}",width as u32))?;click(w,cx,point(px(5.),px(5.)));draw(w,cx);Ok(())})??;wait!(p,cx=>!p.stem_export_open);
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"twoSizes":true,"actualRulerButton":true,"defaultMp3All":true,"selectedWav":true,"karaokeFlac":true,"emptySelectionDisabled":true,"folderCancel":true,"collisionPreserved":true,"busyCancelWaitedForWorker":true,"staleReceiptFence":true,"nativeWorker":true,"hidden":true,"chooserPresentation":"not exercised","productionParity":"unqualified"}))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("STEM_EXPORT passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|snapshot(&view,w,cx,&out,"failure"));eprintln!("STEM_EXPORT failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

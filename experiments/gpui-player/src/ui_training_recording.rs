//! Real training capture/recording/export controls, driven inside a hidden window.
use super::*;
use crate::ui_training_run::{button, click, draw};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    let p = view.read(cx);
    let take=p.training_recorder.take.as_ref().map(|t|serde_json::json!({"id":t.id,"path":t.path,"filename":t.filename,"seconds":t.seconds,"sampleRate":t.sample_rate}));
    serde_json::json!({"ui":p.training.read(cx).recording_ui_state(w),"take":take,"recording":p.training_recorder.recording(),"busy":p.training_recorder.busy(),"message":p.training_recorder.message,"context":p.training_recorder.context(),"exportsPending":p.training_recording_exports.len(),"promptPathsPending":p.training_recording_prompt_paths.len(),"practicePhase":p.practice.as_ref().map(|r|format!("{:?}",r.phase)),"screen":p.screen as u8,"inputOwner":p.mic_view.owner,"inputPhase":format!("{:?}",p.mic_view.phase),"fixtureInput":p.mic_view.fixture})
}
fn recording_layout(
    view: &Entity<Player>,
    w: &Window,
    cx: &App,
) -> anyhow::Result<serde_json::Value> {
    let p = view.read(cx);
    let training = p.training.read(cx);
    if p.screen != Screen::Training
        || !p
            .practice
            .as_ref()
            .is_some_and(|r| r.phase == training_run::Phase::Respond)
    {
        return Ok(serde_json::Value::Null);
    }
    let bound = |id: &str| {
        training
            .bounds(id)
            .ok_or_else(|| anyhow::anyhow!("Unmeasured recording layout element {id}"))
    };
    let bar = bound("training-recording-bar")?;
    let dock = bound("training-run-dock")?;
    let guidance = bound("training-run-guidance")?;
    for (name, b) in [
        ("recording bar", bar),
        ("guidance", guidance),
        ("transport dock", dock),
    ] {
        anyhow::ensure!(
            b.size.height > px(0.)
                && b.top() >= px(52.)
                && b.bottom() <= w.viewport_size().height
                && b.left() >= px(0.)
                && b.right() <= w.viewport_size().width,
            "{name} outside training viewport: {b:?}"
        );
    }
    anyhow::ensure!(
        guidance.bottom() <= dock.top(),
        "Pitch guidance overlaps transport: {guidance:?} vs {dock:?}"
    );
    anyhow::ensure!(
        bar.bottom() <= guidance.top(),
        "Recording bar overlaps exercise guidance"
    );
    let rect = |b: Bounds<Pixels>| serde_json::json!({"left":f32::from(b.left()),"top":f32::from(b.top()),"right":f32::from(b.right()),"bottom":f32::from(b.bottom())});
    let paragraph = if training
        .recording_state()
        .message
        .as_ref()
        .is_some_and(|m| !m.is_empty())
    {
        let status = bound("training-recording-status")?;
        anyhow::ensure!(
            (status.left() - bar.left() - px(16.)).abs() <= px(1.),
            "Recording paragraph lost source left alignment: {status:?} in {bar:?}"
        );
        anyhow::ensure!(
            status.bottom() <= bar.bottom(),
            "Status text escaped recording bar"
        );
        Some(rect(status))
    } else {
        None
    };
    Ok(
        serde_json::json!({"bar":rect(bar),"guidance":rect(guidance),"dock":rect(dock),"status":paragraph,"compact":f32::from(w.viewport_size().height)<=680.,"sourceParagraphAlignment":"left; .vt-session has no text-align, .vt-stage alone centers"}),
    )
}
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(value).unwrap(), cx);
    draw(w, cx);
}
fn focus_record_by_tab(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    for _ in 0..64 {
        draw(w, cx);
        if view.read(cx).training.read(cx).recording_ui_state(w)["focusedControl"]
            == "training-recording-record"
        {
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!(
        "Native Tab traversal never reached Record: {}",
        state(view, w, cx)
    )
}
fn training_tab(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get("training")
        .ok_or_else(|| anyhow::anyhow!("Training header control absent"))?;
    click(w, cx, b.center());
    Ok(())
}
fn prompt(view: &Entity<Player>, cx: &mut App, path: Option<PathBuf>) {
    view.update(cx, |p, _| p.training_recording_prompt_paths.push_back(path));
}
fn files() -> anyhow::Result<Vec<PathBuf>> {
    let dir = audio_devices::directory().join("training-recordings");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut files = std::fs::read_dir(dir)?
        .filter_map(|entry| entry.ok())
        .map(|e| e.path())
        .filter(|p| p.extension().is_some_and(|e| e == "wav"))
        .collect::<Vec<_>>();
    files.sort();
    Ok(files)
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    viewport: (f32, f32),
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        w.viewport_size() == size(px(viewport.0), px(viewport.1)),
        "Wrong recording viewport"
    );
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Recording test activated window"
    );
    let layout = recording_layout(view, w, cx)?;
    let image = w.render_to_image()?;
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (viewport.0 * scale).round() as u32
            && image.height() == (viewport.1 * scale).round() as u32,
        "Recording raster differs from viewport"
    );
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"viewport":[viewport.0,viewport.1],"scale":scale,"recording":state(view,w,cx),"layout":layout,"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"liveFps":"unmeasured: hidden event-driven rendering","visualReference":"candidate only; matched production reference absent"}),
        )?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let mut viewport=(1280.,800.);
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let mut takes=vec![];let mut checks=vec![];
  macro_rules! wait {($p:ident,$w:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(12);loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$condition})?;if ready{break;}if Instant::now()>=deadline{let s=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Recording wait timed out: {}; {s}",stringify!($condition));}}}};}
  macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|button(&view,w,cx,$id))??;};}
  macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name,viewport))??;};}
  for (width,height) in [(1280.,800.),(1060.,640.)]{
   viewport=(width,height);handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
   handle.update(cx,|_,w,cx|training_tab(&view,w,cx))??;wait!(p,w,app=>p.screen==Screen::Training);
   handle.update(cx,|_,_,cx|view.read(cx).training.clone().update(cx,|s,cx|s.practice_fixture(false,cx)))?;
   press!("training-start");
   wait!(p,w,app=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)&&p.mic_view.owner==training_capture::TRAINING_OWNER&&p.mic_view.phase==microphone::Phase::Live&&p.training.read(app).recording_ui_state(w)["recordEnabled"]==true);
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.mic_view.fixture&&p.notice.is_none(),"Recording did not use native PCM fixture capture");Ok(())})??;
   shot!(&format!("ready-{}",width as u32));
   press!("training-recording-record");wait!(p,w,app=>p.training_recorder.recording()&&!p.training_recorder.busy());shot!(&format!("recording-{}",width as u32));
   cx.background_executor().timer(Duration::from_millis(700)).await;
   press!("training-recording-record");wait!(p,w,app=>!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_some());
   let first=handle.update(cx,|_,_,cx|view.read(cx).training_recorder.take.clone().unwrap())?;let original=std::fs::read(&first.path)?;anyhow::ensure!(original.len()>44&&first.seconds>0.1&&first.seconds<=30.,"Native take has no real audio");
   takes.push(serde_json::json!({"case":"first","viewport":width,"id":first.id,"originalPath":first.path,"filename":first.filename,"seconds":first.seconds,"sampleRate":first.sample_rate}));
   shot!(&format!("take-ready-{}",width as u32));
   let export=out.join(format!("export-first-{}.wav",width as u32));handle.update(cx,|_,_,cx|prompt(&view,cx,Some(export.clone())))?;press!("training-recording-save");
   wait!(p,w,app=>export.is_file()&&p.training_recording_exports.is_empty());anyhow::ensure!(std::fs::read(&export)?==original&&std::fs::read(&first.path)?==original,"Native export changed PCM or removed retained take");
   let message=handle.update(cx,|_,_,cx|view.read(cx).training_recorder.message.clone())?;
   handle.update(cx,|_,_,cx|prompt(&view,cx,None))?;press!("training-recording-save");wait!(p,w,app=>p.training_recording_prompt_paths.is_empty()&&p.training_recording_exports.is_empty());
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.training_recorder.take.as_ref().is_some_and(|t|t.id==first.id)&&p.training_recorder.message==message,"Cancelled Save replaced native take or status");Ok(())})??;
   let collision=out.join(format!("existing-{}.wav",width as u32));std::fs::write(&collision,b"existing destination must survive")?;
   handle.update(cx,|_,_,cx|prompt(&view,cx,Some(collision.clone())))?;press!("training-recording-save");
   wait!(p,w,app=>p.training_recording_exports.is_empty()&&p.training_recorder.message!=message);
   anyhow::ensure!(std::fs::read(&collision)?==b"existing destination must survive"&&std::fs::read(&first.path)?==original,"Failed WAV export destroyed original or destination");
   shot!(&format!("export-error-{}",width as u32));
   let playing_before=handle.update(cx,|_,_,cx|view.read(cx).playing)?;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{focus_record_by_tab(&view,w,cx)?;key(w,cx,"space");Ok(())})??;
   wait!(p,w,app=>p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none());
   cx.background_executor().timer(Duration::from_millis(450)).await;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{focus_record_by_tab(&view,w,cx)?;key(w,cx,"enter");Ok(())})??;
   wait!(p,w,app=>p.training_recorder.take.as_ref().is_some_and(|t|t.id!=first.id)&&!p.training_recorder.busy());
   let second=handle.update(cx,|_,_,cx|view.read(cx).training_recorder.take.clone().unwrap())?;
   anyhow::ensure!(second.path!=first.path&&second.id==first.id+1&&std::fs::read(&first.path)?==original,"Keyboard recording fired more than once or replaced prior take");
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).playing==playing_before,"Recording Space/Enter leaked to global playback");Ok(())})??;
   takes.push(serde_json::json!({"case":"second","viewport":width,"id":second.id,"originalPath":second.path,"filename":second.filename,"seconds":second.seconds,"sampleRate":second.sample_rate}));
   let second_export=out.join(format!("export-second-{}.wav",width as u32));handle.update(cx,|_,_,cx|prompt(&view,cx,Some(second_export.clone())))?;press!("training-recording-save");wait!(p,w,app=>second_export.is_file()&&p.training_recording_exports.is_empty());anyhow::ensure!(std::fs::read(&second_export)?==std::fs::read(&second.path)?,"Second native WAV export differs");
   let before=files()?;
   press!("training-recording-record");wait!(p,w,app=>p.training_recorder.recording()&&!p.training_recorder.busy());cx.background_executor().timer(Duration::from_millis(350)).await;
   handle.update(cx,|_,w,cx|super::ui_training_run::header_control(&view,w,cx,"songs"))??;
   wait!(p,w,app=>p.screen==Screen::Library&&!p.training_recorder.busy()&&p.mic_view.phase==microphone::Phase::Off&&files().is_ok_and(|f|f.len()>before.len()));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.training_recorder.take.is_none()&&p.training_recorder.message.is_none()&&p.training_recorder.context().is_none(),"Detached take painted stale context");anyhow::ensure!(p.training.read(cx).recording_ui_state(w)["view"]["has_take"]==false,"Detached recording remained exposed by UI");Ok(())})??;
   let after=files()?;let detached=after.iter().filter(|path|!before.contains(path)).cloned().collect::<Vec<_>>();anyhow::ensure!(detached.len()==1,"Navigation did not retain exactly one actual finished WAV: {detached:?}");
   takes.push(serde_json::json!({"case":"navigation","viewport":width,"originalPath":detached[0],"filename":detached[0].file_name().unwrap().to_string_lossy()}));
   shot!(&format!("navigation-retains-{}",width as u32));
   handle.update(cx,|_,w,cx|training_tab(&view,w,cx))??;wait!(p,w,app=>p.screen==Screen::Training&&p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Paused));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);let s=p.training.read(cx).recording_ui_state(w);anyhow::ensure!(s["saveVisible"]==false&&s["recordEnabled"]==false&&p.training_recorder.take.is_none()&&p.training_recorder.message.is_none(),"Old navigation receipt attached to reopened practice");Ok(())})??;
   shot!(&format!("reopened-paused-{}",width as u32));
   press!("training-run-continue");wait!(p,w,app=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)&&p.training.read(app).recording_ui_state(w)["recordEnabled"]==true);
   handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.training_recorder.take.is_none()&&p.training_recorder.message.is_none(),"Old take leaked into new capture generation");Ok(())})??;
   press!("training-run-exit");wait!(p,w,app=>p.practice.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.training_stopped>=p.training_serial);
   checks.push(serde_json::json!({"viewport":[width,height],"actualStart":true,"actualNativeRecording":true,"exactWorkerExport":true,"cancelPreservesTake":true,"errorPreservesTake":true,"secondTake":true,"nativeTabSpaceEnter":true,"guidanceDockNoOverlap":true,"paragraphLeftAligned":true,"navigationRetainsWav":true,"staleUiRejected":true}));
  }
  let retained=out.join("retained");std::fs::create_dir_all(&retained)?;let mut inventory=vec![];
  for path in files()?{let name=path.file_name().unwrap();let artifact=retained.join(name);std::fs::copy(&path,&artifact)?;inventory.push(serde_json::json!({"originalPath":path,"artifact":artifact,"bytes":std::fs::metadata(&artifact)?.len()}));}
  anyhow::ensure!(inventory.len()==6,"Expected six real retained recordings at two sizes, got {}",inventory.len());
  std::fs::write(out.join("takes.json"),serde_json::to_vec_pretty(&serde_json::json!({"takes":takes,"inventory":inventory,"checks":checks}))?)?;
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"actualStart":true,"nativePcmReplay":true,"realRecordStop":true,"realWorkerExport":true,"cancelAndErrorPreserve":true,"secondTake":true,"nativeTabSpaceEnter":true,"guidanceDockNoOverlap":true,"paragraphLeftAligned":true,"navigationRetention":true,"staleUiRejected":true,"twoSizes":true,"hidden":true}))?)?;Ok(())
 }.await;
 match result {Ok(())=>{eprintln!("TRAINING_RECORDING passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{
  let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",viewport));
  eprintln!("TRAINING_RECORDING failed: {error:#}");let _=view.update(cx,|p,_|{p.training_recording_store.take();p.microphone.take();p.backend.take();});std::process::exit(1);
 }}
 }).detach();
}

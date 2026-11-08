//! Real input-child loss during an accepted RAM recording; retained WAVs survive.
//! Failed active capture has no recoverable new WAV. Save chooser alone is adapted.
use super::ui_training_run::{button, draw, header_control};
use super::*;
use anyhow::Context as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
fn hash(b: impl AsRef<[u8]>) -> String {
    Sha256::digest(b.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn fixture() -> anyhow::Result<PathBuf> {
    std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE")
        .map(PathBuf::from)
        .context("Missing native PCM fixture")
}
fn files() -> anyhow::Result<Vec<PathBuf>> {
    let dir = audio_devices::directory().join("training-recordings");
    if !dir.exists() {
        return Ok(vec![]);
    }
    let mut f = std::fs::read_dir(dir)?
        .map(|e| e.map(|v| v.path()))
        .collect::<std::io::Result<Vec<_>>>()?;
    f.retain(|p| p.extension().is_some_and(|e| e == "wav"));
    f.sort();
    Ok(f)
}
fn take_value(t: &training_recording::Take) -> Value {
    json!({"id":t.id,"path":t.path,"filename":t.filename,"seconds":t.seconds,"sampleRate":t.sample_rate})
}
fn session(p: &Player) -> Value {
    p.practice.as_ref().map(|r|json!({"id":r.session.id(),"phase":format!("{:?}",r.phase),"index":r.session.current().map(|q|q.index),"error":r.error,"receiptCount":r.session.results().len()})).unwrap_or(Value::Null)
}
fn retained(p: &Player, id: &str) -> bool {
    p.practice.as_ref().is_some_and(|r| {
        r.session.id() == id
            && r.session.current().is_some_and(|q| q.index == 1)
            && r.session.results().is_empty()
    })
}
fn snapshot(v: &Entity<Player>, w: &Window, a: &App) -> Value {
    let p = v.read(a);
    let mut s = json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"epoch":p.native_epoch,"screen":p.screen as u8,"notice":p.notice});
    s["session"] = session(p);
    s["recording"] = json!({"ui":p.training.read(a).recording_ui_state(w),"recording":p.training_recorder.recording(),"busy":p.training_recorder.busy(),"take":p.training_recorder.take.as_ref().map(take_value),"message":p.training_recorder.message,"context":p.training_recorder.context(),"exportsPending":p.training_recording_exports.len(),"promptPathsPending":p.training_recording_prompt_paths.len()});
    s["microphone"] = json!({"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"generation":p.mic_view.generation,"sequence":p.mic_view.sequence,"fixture":p.mic_view.fixture,"intent":p.mic_intent.is_some(),"error":p.mic_view.error});
    s["training"] = json!({"generation":p.training_test,"serial":p.training_serial,"stopped":p.training_stopped,"micSerial":p.mic_serial});
    s["productionParity"] = json!("not evaluated; functional candidate captures only");
    s["liveFps"] = json!("unmeasured in hidden window");
    s["scope"]=json!("Real native 330 Hz PCM replay, CREPE capture, recording/finish/export workers and owned input-child kill. Active recording is RAM-only until finish: failed second take has no recoverable WAV. Save path alone uses test chooser seam; no native OS dialog, physical microphone, crash salvage or physical hotplug qualification.");
    s
}
pub(super) fn layout(v: &Entity<Player>, w: &Window, a: &App) -> anyhow::Result<Value> {
    let p = v.read(a);
    let training = p.training.read(a);
    let phase = p
        .practice
        .as_ref()
        .context("No practice for recorder layout")?
        .phase;
    let bound = |id: &str| {
        training
            .bounds(id)
            .with_context(|| format!("Missing measured layout {id}"))
    };
    let inside = |name: &str, b: Bounds<Pixels>| -> anyhow::Result<()> {
        anyhow::ensure!(
            b.size.width > px(0.)
                && b.size.height > px(0.)
                && b.left() >= px(0.)
                && b.right() <= w.viewport_size().width
                && b.top() >= px(52.)
                && b.bottom() <= w.viewport_size().height,
            "{name} escaped viewport: {b:?}"
        );
        Ok(())
    };
    let rect = |b: Bounds<Pixels>| json!({"left":f32::from(b.left()),"top":f32::from(b.top()),"right":f32::from(b.right()),"bottom":f32::from(b.bottom())});
    let bar = bound("training-recording-bar")?;
    let status = bound("training-recording-status")?;
    inside("recording bar", bar)?;
    inside("recording paragraph", status)?;
    anyhow::ensure!(
        status.left() >= bar.left()
            && status.right() <= bar.right()
            && status.top() >= bar.top()
            && status.bottom() <= bar.bottom(),
        "Recording status paragraph escaped bar"
    );
    anyhow::ensure!(
        (status.left() - bar.left() - px(16.)).abs() <= px(1.),
        "Recording status lost left paragraph alignment"
    );
    let mut result = json!({"bar":rect(bar),"status":rect(status),"compact":f32::from(w.viewport_size().height)<=680.,"paragraphContained":true,"paragraphLeftAligned":true});
    if phase == training_run::Phase::Paused {
        let error = bound("training-run-paused-error")?;
        let action = bound("training-run-continue")?;
        inside("paused run error", error)?;
        inside("Continue", action)?;
        anyhow::ensure!(
            bar.bottom() <= error.top() && error.bottom() <= action.top(),
            "Recording failure bar, paused error or Continue overlap"
        );
        result["pausedError"] = rect(error);
        result["continue"] = rect(action);
        result["pausedErrorMeasured"] = json!(true);
        result["guidanceAndDockRendered"] = json!(false);
    } else {
        anyhow::ensure!(
            phase == training_run::Phase::Respond,
            "Unexpected recorder capture phase {phase:?}"
        );
        let guidance = bound("training-run-guidance")?;
        let dock = bound("training-run-dock")?;
        inside("stage guidance", guidance)?;
        inside("run dock", dock)?;
        anyhow::ensure!(
            bar.bottom() <= guidance.top() && guidance.bottom() <= dock.top(),
            "Recording bar, stage guidance or run dock overlap"
        );
        result["guidance"] = rect(guidance);
        result["dock"] = rect(dock);
        result["guidanceAndDockRendered"] = json!(true);
    }
    result["noOverlap"] = json!(true);
    Ok(result)
}
fn capture(
    v: &Entity<Player>,
    w: &mut Window,
    a: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, a);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Recording recovery window presented"
    );
    let image = w.render_to_image()?;
    let pixels = [image.width(), image.height()];
    let png = out.join(format!("{name}.png"));
    image.save(&png)?;
    let mut s = snapshot(v, w, a);
    s["layout"] = layout(v, w, a)?;
    s["caseId"] = json!(name);
    s["imagePixels"] = json!(pixels);
    s["zoom"] = json!(1.);
    s["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    s["captureMethod"] = json!("hidden GPUI Window::render_to_image; no rescale");
    s["screenshotSha256"] = json!(hash(std::fs::read(png)?));
    s["fixtureSha256"] = json!(hash(std::fs::read(fixture()?)?));
    s["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    s["testSourceSha256"] = json!(hash(include_bytes!("ui_training_recording_recovery.rs")));
    s["os"] = json!(std::env::consts::OS);
    s["architecture"] = json!(std::env::consts::ARCH);
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&s)?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode(),"Requires hidden muted real native backend and PCM replay");let _=fixture()?;std::fs::create_dir_all(&out)?;
            macro_rules! wait{($seconds:expr,$p:ident,$w:ident,$a:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);loop{cx.background_executor().timer(Duration::from_millis(15)).await;if handle.update(cx,|_,$w,$a|{draw($w,$a);let $p=view.read($a);let _=(&$p,&$w,&$a);$predicate})?{break;}if Instant::now()>=deadline{let s=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;anyhow::bail!("Recording recovery timeout {}: {s}",stringify!($predicate));}}}}}
            macro_rules! pid{($receiver:expr)=>{{let rx=$receiver;let deadline=Instant::now()+Duration::from_secs(8);loop{match rx.try_recv(){Ok(v)=>break v.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Owned input PID acknowledgement disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}anyhow::ensure!(Instant::now()<deadline,"Owned input acknowledgement timeout");cx.background_executor().timer(Duration::from_millis(5)).await;}}}}
            macro_rules! press{($id:expr)=>{handle.update(cx,|_,w,a|button(&view,w,a,$id))??}}
            macro_rules! shot{($name:expr)=>{handle.update(cx,|_,w,a|capture(&view,w,a,&out,$name))??}}
            macro_rules! export{($destination:expr)=>{{let destination=$destination;handle.update(cx,|_,_,a|view.update(a,|p,_|p.training_recording_prompt_paths.push_back(Some(destination.clone()))))?;press!("training-recording-save");wait!(12,p,w,a=>destination.is_file()&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty());}}}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|s.snapshot().loaded)&&p.mic_prefs_valid);
            handle.update(cx,|_,w,a|header_control(&view,w,a,"training"))??;wait!(5,p,w,a=>p.screen==Screen::Training);handle.update(cx,|_,_,a|view.read(a).training.clone().update(a,|s,a|s.practice_fixture(false,a)))?;press!("training-start");
            wait!(30,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond&&r.session.current().is_some_and(|q|q.index==1)&&r.session.results().is_empty())&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4&&p.mic_view.fixture&&p.training.read(a).recording_ui_state(w)["recordEnabled"]==true&&p.notice.is_none());
            let id=handle.update(cx,|_,_,a|view.read(a).practice.as_ref().unwrap().session.id().to_string())?;anyhow::ensure!(files()?.is_empty(),"Isolated recording directory was not empty");
            press!("training-recording-record");wait!(8,p,w,a=>p.training_recorder.recording()&&!p.training_recorder.busy());cx.background_executor().timer(Duration::from_millis(350)).await;press!("training-recording-record");wait!(8,p,w,a=>!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_some());
            let first=handle.update(cx,|_,_,a|view.read(a).training_recorder.take.clone().unwrap())?;let first_bytes=std::fs::read(&first.path)?;anyhow::ensure!(first_bytes.len()>44&&first.seconds>0.1&&first.sample_rate==16000&&files()?==vec![first.path.clone()],"First finished recording lacks real native PCM");std::fs::write(out.join("retained-first.wav"),&first_bytes)?;
            let first_export=out.join("export-first.wav");export!(first_export.clone());anyhow::ensure!(std::fs::read(&first_export)?==first_bytes&&std::fs::read(&first.path)?==first_bytes,"First worker export changed retained native WAV");shot!("recording-first-retained-1280");
            press!("training-recording-record");wait!(8,p,w,a=>p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none()&&p.training.read(a).recording_ui_state(w)["saveVisible"]==false);cx.background_executor().timer(Duration::from_millis(350)).await;
            let original_generation=handle.update(cx,|_,_,a|view.read(a).mic_view.generation)?;let owned_rx=handle.update(cx,|_,_,a|view.read(a).microphone.as_ref().context("Missing recording input service")?.owned_capture(original_generation))??;let original_pid=pid!(owned_rx);
            let kill_rx=handle.update(cx,|_,_,a|->anyhow::Result<_>{let p=view.read(a);anyhow::ensure!(retained(p,&id)&&p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none(),"Second accepted recording ended before fault");p.microphone.as_ref().context("Missing active recording input")?.fail_owned_capture(original_generation)})??;let killed_pid=pid!(kill_rx);anyhow::ensure!(killed_pid==original_pid&&original_pid>0,"Fault did not kill inspected worker-owned input child");
            wait!(15,p,w,a=>retained(p,&id)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_ref().is_some_and(|e|!e.is_empty())&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial&&!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none()&&p.training.read(a).recording_ui_state(w)["saveVisible"]==false&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty());
            let (error,recording_error,serial)=handle.update(cx,|_,_,a|{let p=view.read(a);(p.practice.as_ref().unwrap().error.clone().unwrap(),p.training_recorder.message.clone(),p.training_serial)})?;anyhow::ensure!(recording_error.as_ref().is_some_and(|e|!e.is_empty()),"Failed accepted recording lost worker error");
            cx.background_executor().timer(Duration::from_millis(300)).await;
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id)&&p.training_serial==serial&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_deref()==Some(error.as_str())&&!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none(),"Failed active recording auto retried/scored or retained ghost take");Ok(())})??;
            anyhow::ensure!(files()?==vec![first.path.clone()]&&std::fs::read(&first.path)?==first_bytes&&std::fs::read(&first_export)?==first_bytes,"Failed RAM-only take created recoverable WAV or changed earlier original/export");shot!("recording-failed-1280");handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.)));shot!("recording-failed-1060");
            handle.update(cx,|_,w,a|{if view.read(a).notice.is_some(){draw(w,a);w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),a);}})?;
            press!("training-run-continue");wait!(20,p,w,a=>retained(p,&id)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Respond&&p.practice.as_ref().unwrap().error.is_none()&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4&&p.mic_view.fixture&&p.mic_view.generation>original_generation&&p.training.read(a).recording_ui_state(w)["recordEnabled"]==true&&p.notice.is_none());
            let replacement_generation=handle.update(cx,|_,_,a|view.read(a).mic_view.generation)?;let fresh_rx=handle.update(cx,|_,_,a|view.read(a).microphone.as_ref().context("Missing retried native input")?.owned_capture(replacement_generation))??;let replacement_pid=pid!(fresh_rx);anyhow::ensure!(replacement_pid>0&&replacement_pid!=original_pid,"Continue reused killed native input PID");
            // Limited controller check: emulate an old queued Continue event after
            // the actual Continue already restored Respond; no second rendered click.
            let mic_serial=handle.update(cx,|_,_,a|view.read(a).mic_serial)?;
            handle.update(cx,|_,_,a|{let training=view.read(a).training.clone();training.update(a,|_,a|a.emit(training::TrainingEvent::Continue));})?;
            cx.background_executor().timer(Duration::from_millis(200)).await;
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Respond&&p.practice.as_ref().unwrap().error.is_none()&&p.mic_view.generation==replacement_generation&&p.mic_serial==mic_serial&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4,"Queued old Continue restarted fresh capture or changed active prompt");Ok(())})??;
            press!("training-recording-record");wait!(8,p,w,a=>p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.is_none()&&p.training_recorder.message!=recording_error);shot!("recording-recovered-active-1060");cx.background_executor().timer(Duration::from_millis(350)).await;press!("training-recording-record");wait!(8,p,w,a=>!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.as_ref().is_some_and(|t|t.id==first.id+2)&&p.training.read(a).recording_ui_state(w)["saveVisible"]==true&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty());
            let third=handle.update(cx,|_,_,a|view.read(a).training_recorder.take.clone().unwrap())?;let third_bytes=std::fs::read(&third.path)?;anyhow::ensure!(third.path!=first.path&&third.sample_rate==16000&&third.seconds>0.1&&third_bytes.len()>44,"Recovered take lacks new native PCM");std::fs::write(out.join("retained-third.wav"),&third_bytes)?;shot!("recording-recovered-retained-1060");handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1280.),px(800.)));shot!("recording-recovered-retained-1280");
            let third_export=out.join("export-third.wav");export!(third_export.clone());anyhow::ensure!(std::fs::read(&third_export)?==third_bytes&&std::fs::read(&third.path)?==third_bytes&&std::fs::read(&first.path)?==first_bytes&&std::fs::read(&first_export)?==first_bytes&&files()?.len()==2,"Recovered export altered old/new originals or failed take produced unexpected WAV");
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id)&&p.practice.as_ref().unwrap().error.is_none()&&p.training_recorder.message.as_ref().is_some_and(|s|s.starts_with("Saved "))&&!p.training_recorder.busy()&&!p.training_recorder.recording()&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty(),"Recovered recorder retained ghost operation or stale error");Ok(())})??;shot!("recording-recovered-exported-1280");
            press!("training-run-exit");wait!(10,p,w,a=>p.practice.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.mic_intent.is_none()&&!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_test.is_none()&&p.training_recording_exports.is_empty());
            anyhow::ensure!(files()?.len()==2&&std::fs::read(&first.path)?==first_bytes&&std::fs::read(&third.path)?==third_bytes,"Explicit Exit changed retained native WAVs");
            let takes=json!({"first":take_value(&first),"third":take_value(&third),"firstSha256":hash(&first_bytes),"thirdSha256":hash(&third_bytes),"firstExport":first_export,"thirdExport":third_export,"originalInputPid":original_pid,"killedInputPid":killed_pid,"replacementInputPid":replacement_pid,"originalCaptureGeneration":original_generation,"replacementCaptureGeneration":replacement_generation,"retainedNativeFileCount":2});std::fs::write(out.join("takes.json"),serde_json::to_vec_pretty(&takes)?)?;
            let mut result=json!({"actualTrainingStart":true,"native330HzPcmReplay":true,"realCrepeOffTargetRespond":true,"actualFirstRecordStop":true,"firstExactWorkerExport":true,"actualAcceptedSecondRecording":true,"faultedInspectedOwnedNativeInput":true,"samePausedSessionAndPrompt":true,"specificWorkerErrorRetained":true,"cleanInputCueRecorderRelease":true,"failedSecondTakeHasNoWav":true,"previousOriginalAndExportByteExact":true,"actualContinue":true,"freshCaptureGenerationAndPid":true,"staleQueuedContinueIgnored":true,"actualThirdRecordStop":true,"thirdExactWorkerExport":true,"noGhostPendingOrStaleError":true,"measuredRecorderLayoutNoOverlap":true,"actualExitCleanup":true});
            let details=json!({"sessionId":id,"faultPromptIndex":1,"runError":error,"recordingError":recording_error,"originalInputPid":original_pid,"killedInputPid":killed_pid,"replacementInputPid":replacement_pid,"originalCaptureGeneration":original_generation,"replacementCaptureGeneration":replacement_generation,"retainedNativeFileCount":2,"failedActiveAudioSalvaged":false,"nativeOsDialogQualified":false,"physicalMicrophoneQualified":false,"physicalHotplugQualified":false,"staleContinueScope":"Limited controller TrainingEvent::Continue after actual Continue reached Respond; not a second rendered button click and no stale native frame injection","saveChooserScope":"Actual measured Save controls use training_recording_prompt_paths test chooser seam and real export worker; no native OS dialog qualification","failedTakeScope":"Accepted active second recording existed only in native RAM until finish; killed child has no recoverable new WAV; first completed file survives, third completes after explicit retry","sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"productionParity":"not evaluated","liveFps":"unmeasured"});result.as_object_mut().unwrap().extend(details.as_object().unwrap().clone());std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result)?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_RECORDING_RECOVERY passed");let _=cx.update(|a|a.quit());},Err(e)=>{eprintln!("TRAINING_RECORDING_RECOVERY failed: {e:#}");let _=std::fs::write(out.join("failure.txt"),format!("{e:#}"));let _=handle.update(cx,|_,w,a|capture(&view,w,a,&out,"failure"));let _=view.update(cx,|p,_|{p.training_recording_store.take();p.microphone.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

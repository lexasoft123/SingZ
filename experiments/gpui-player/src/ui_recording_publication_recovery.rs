//! Real native WAV publication collisions -> capability-backed recovery -> Save.
//! Controlled sentinel collisions only; no disk-full, hardware or OS-dialog claim.
use super::ui_training_run::{button, draw, header_control};
use super::*;
use anyhow::Context as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
const SENTINEL: &[u8] =
    b"Unrelated sentinel: native recording publication must not overwrite this member.\n";
fn hash(b: impl AsRef<[u8]>) -> String {
    Sha256::digest(b.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn fixture() -> anyhow::Result<PathBuf> {
    std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE")
        .map(PathBuf::from)
        .context("Missing isolated native PCM fixture")
}
fn take_value(t: &training_recording::Take) -> Value {
    json!({"id":t.id,"path":t.path,"filename":t.filename,"seconds":t.seconds,"sampleRate":t.sample_rate,"recovery":t.recovery.is_some(),"recoveryPath":t.recovery.as_ref().map(|r|r.path())})
}
fn retained(p: &Player, id: &str, generation: u64) -> bool {
    p.practice.as_ref().is_some_and(|r| {
        r.session.id() == id
            && r.phase == training_run::Phase::Respond
            && r.error.is_none()
            && r.session.current().is_some_and(|q| q.index == 1)
            && r.session.results().is_empty()
    }) && p.mic_view.generation == generation
        && p.mic_view.phase == microphone::Phase::Live
        && p.mic_view.owner == 4
        && p.mic_view.fixture
        && p.notice.is_none()
}
fn flat_wavs(root: &Path) -> anyhow::Result<Vec<PathBuf>> {
    let mut result = vec![];
    for entry in std::fs::read_dir(root)? {
        let path = entry?.path();
        if path.is_file() && path.extension().is_some_and(|v| v == "wav") {
            let b = std::fs::read(&path)?;
            if b.len() > 44 && &b[..4] == b"RIFF" && &b[8..12] == b"WAVE" {
                result.push(path)
            }
        }
    }
    result.sort();
    Ok(result)
}
fn identity(path: &Path) -> anyhow::Result<Value> {
    let m = std::fs::metadata(path)?;
    let mut v = json!({"bytes":m.len(),"modifiedNs":m.modified()?.duration_since(std::time::UNIX_EPOCH)?.as_nanos().to_string()});
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        v["device"] = json!(m.dev());
        v["inode"] = json!(m.ino());
    }
    Ok(v)
}
fn snapshot(v: &Entity<Player>, w: &Window, a: &App) -> Value {
    let p = v.read(a);
    let mut s = json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"epoch":p.native_epoch,"screen":p.screen as u8,"notice":p.notice});
    s["session"]=json!(p.practice.as_ref().map(|r|json!({"id":r.session.id(),"phase":format!("{:?}",r.phase),"index":r.session.current().map(|q|q.index),"receiptCount":r.session.results().len(),"error":r.error})));
    s["recording"] = json!({"ui":p.training.read(a).recording_ui_state(w),"recording":p.training_recorder.recording(),"busy":p.training_recorder.busy(),"take":p.training_recorder.take.as_ref().map(take_value),"message":p.training_recorder.message,"exportsPending":p.training_recording_exports.len(),"promptPathsPending":p.training_recording_prompt_paths.len()});
    s["microphone"] = json!({"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"generation":p.mic_view.generation,"sequence":p.mic_view.sequence,"fixture":p.mic_view.fixture});
    s["faultStage"] =
        json!(std::env::var("SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_STAGE").unwrap_or_default());
    s["scope"]=json!("Controlled unrelated sentinel collision at native helper stage or host flat publication member. Real PCM/CREPE recording, validated Recovery capability and worker promotion/export. Save destination uses test-only chooser path; no disk-full, physical microphone, hardware hotplug, native OS dialog or visual parity qualification.");
    s["productionParity"] = json!("not evaluated; functional candidate captures only");
    s["liveFps"] = json!("unmeasured in hidden window");
    s
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
        "Recording publication recovery window presented"
    );
    let image = w.render_to_image()?;
    let pixels = [image.width(), image.height()];
    let png = out.join(format!("{name}.png"));
    image.save(&png)?;
    let mut s = snapshot(v, w, a);
    s["layout"] = super::ui_training_recording_recovery::layout(v, w, a)?;
    s["caseId"] = json!(name);
    s["imagePixels"] = json!(pixels);
    s["zoom"] = json!(1.);
    s["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    s["captureMethod"] = json!("hidden GPUI Window::render_to_image; no rescale");
    s["screenshotSha256"] = json!(hash(std::fs::read(png)?));
    s["fixtureSha256"] = json!(hash(std::fs::read(fixture()?)?));
    s["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    s["testSourceSha256"] = json!(hash(include_bytes!("ui_recording_publication_recovery.rs")));
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
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode(),"Requires hidden muted real native PCM input/audio");let _=fixture()?;std::fs::create_dir_all(&out)?;let stage=std::env::var("SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_STAGE")?;anyhow::ensure!(stage=="host"||stage=="helper","Unknown controlled collision stage {stage}");let helper_stage=stage=="helper";
            macro_rules! wait{($seconds:expr,$p:ident,$w:ident,$a:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);loop{cx.background_executor().timer(Duration::from_millis(15)).await;if handle.update(cx,|_,$w,$a|{draw($w,$a);let $p=view.read($a);let _=(&$p,&$w,&$a);$predicate})?{break;}if Instant::now()>=deadline{let state=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;anyhow::bail!("Publication recovery timeout {}: {state}",stringify!($predicate));}}}}}
            macro_rules! receive{($receiver:expr)=>{{let rx=$receiver;let deadline=Instant::now()+Duration::from_secs(8);loop{match rx.try_recv(){Ok(v)=>break v.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Owned recording acknowledgement disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}anyhow::ensure!(Instant::now()<deadline,"Owned recording acknowledgement timeout");cx.background_executor().timer(Duration::from_millis(5)).await;}}}}
            macro_rules! press{($id:expr)=>{handle.update(cx,|_,w,a|button(&view,w,a,$id))??}}
            macro_rules! shot{($name:expr)=>{handle.update(cx,|_,w,a|capture(&view,w,a,&out,$name))??}}
            macro_rules! choose_save{($destination:expr)=>{{let destination=$destination;handle.update(cx,|_,_,a|view.update(a,|p,_|p.training_recording_prompt_paths.push_back(Some(destination.clone()))))?;press!("training-recording-save");}}}
            macro_rules! owned_pid{($generation:expr)=>{{let receiver=handle.update(cx,|_,_,a|view.read(a).microphone.as_ref().context("Missing native capture service")?.owned_capture($generation))??;receive!(receiver)}}}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|s.snapshot().loaded)&&p.mic_prefs_valid);handle.update(cx,|_,w,a|header_control(&view,w,a,"training"))??;wait!(5,p,w,a=>p.screen==Screen::Training);handle.update(cx,|_,_,a|view.read(a).training.clone().update(a,|s,a|s.practice_fixture(false,a)))?;press!("training-start");
            wait!(30,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond&&r.session.results().is_empty())&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4&&p.mic_view.fixture&&p.training.read(a).recording_ui_state(w)["recordEnabled"]==true&&p.notice.is_none());let id=handle.update(cx,|_,_,a|view.read(a).practice.as_ref().unwrap().session.id().to_string())?;
            press!("training-recording-record");wait!(8,p,w,a=>p.training_recorder.recording()&&!p.training_recorder.busy());cx.background_executor().timer(Duration::from_millis(350)).await;
            let command=handle.update(cx,|_,_,a|view.read(a).training_recorder.pending_command().context("Accepted recording has no command"))??;let generation=command.generation;let take_id=command.take_id;let original_pid=owned_pid!(generation);
            let paths_receiver=handle.update(cx,|_,_,a|view.read(a).microphone.as_ref().context("No recording worker")?.owned_recording(generation,take_id))??;let paths=receive!(paths_receiver);
            let barrier=if helper_stage{paths.staged.clone()}else{paths.directory.join(&paths.filename)};anyhow::ensure!(!barrier.exists(),"Collision sentinel member already exists");std::fs::write(&barrier,SENTINEL)?;
            press!("training-recording-record");wait!(15,p,w,a=>retained(p,&id,generation)&&!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.as_ref().is_some_and(|t|t.id==take_id&&t.recovery.is_some())&&p.training.read(a).recording_ui_state(w)["saveVisible"]==true&&p.training_recording_exports.is_empty());
            let take=handle.update(cx,|_,_,a|view.read(a).training_recorder.take.clone().unwrap())?;let source=take.recovery.as_ref().unwrap().path().to_path_buf();let bytes=std::fs::read(&source)?;anyhow::ensure!(bytes.len()>44&&take.sample_rate==16000&&take.seconds>0.1&&take.path==source,"Recovery capability does not retain valid native WAV");
            let expected_source=if helper_stage{paths.staged.parent().context("Stage has no parent")?.join(format!(".writing-{take_id}")).join(&paths.filename)}else{paths.staged.clone()};anyhow::ensure!(source==expected_source.canonicalize()?,"Wrong native recovery candidate: {source:?} vs {expected_source:?}");anyhow::ensure!(std::fs::read(&barrier)?==SENTINEL&&flat_wavs(&paths.directory)?.is_empty(),"Collision overwrote unrelated member or claimed ordinary publication");anyhow::ensure!(owned_pid!(generation)==original_pid,"Stop/publication recovery restarted native input");
            std::fs::write(out.join("recovery-original.wav"),&bytes)?;std::fs::write(out.join("unrelated-sentinel.bin"),SENTINEL)?;let recovery_message=handle.update(cx,|_,_,a|view.read(a).training_recorder.message.clone())?;shot!("publication-recoverable-1280");handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.)));shot!("publication-recoverable-1060");
            let invalid=out.join("blocked-export.wav");std::fs::write(&invalid,SENTINEL)?;choose_save!(invalid.clone());wait!(15,p,w,a=>p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty()&&p.training_recorder.message!=recovery_message&&p.training_recorder.take.as_ref().is_some_and(|t|t.id==take_id&&t.recovery.is_some()));let export_error=handle.update(cx,|_,_,a|view.read(a).training_recorder.message.clone().context("Missing failed Save error"))??;
            anyhow::ensure!(std::fs::read(&invalid)?==SENTINEL,"Failed export overwrote unrelated destination");let promoted_files=flat_wavs(&paths.directory)?;anyhow::ensure!(promoted_files.len()==1&&std::fs::read(&promoted_files[0])?==bytes&&std::fs::read(&source)?==bytes&&std::fs::read(&barrier)?==SENTINEL,"Failed export lost recovery source, overwrote sentinel, or failed real root promotion");let promoted=promoted_files[0].clone();let promoted_identity=identity(&promoted)?;anyhow::ensure!(promoted!=barrier&&promoted.parent()==Some(paths.directory.as_path()),"Recovery did not publish a separate ordinary flat root WAV");shot!("publication-export-error-1060");
            let exported=out.join("export-recovered.wav");choose_save!(exported.clone());wait!(15,p,w,a=>exported.is_file()&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty()&&p.training_recorder.message.as_deref()!=Some(export_error.as_str()));
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id,generation)&&!p.training_recorder.recording()&&!p.training_recorder.busy()&&p.training_recorder.take.as_ref().is_some_and(|t|t.id==take_id&&t.recovery.as_ref().is_some_and(|r|r.path()==source.as_path())),"Successful Save discarded validated recovery or exercise");Ok(())})??;
            anyhow::ensure!(std::fs::read(&exported)?==bytes&&std::fs::read(&promoted)?==bytes&&std::fs::read(&source)?==bytes&&std::fs::read(&barrier)?==SENTINEL&&flat_wavs(&paths.directory)?==promoted_files&&identity(&promoted)?==promoted_identity&&owned_pid!(generation)==original_pid,"Successful recovery Save changed bytes, promotion identity, sentinel or capture PID");shot!("publication-exported-1060");handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1280.),px(800.)));shot!("publication-exported-1280");
            let repeated=out.join("export-again.wav");choose_save!(repeated.clone());wait!(15,p,w,a=>repeated.is_file()&&p.training_recording_exports.is_empty()&&p.training_recording_prompt_paths.is_empty());anyhow::ensure!(std::fs::read(&repeated)?==bytes&&std::fs::read(&exported)?==bytes&&std::fs::read(&source)?==bytes&&std::fs::read(&promoted)?==bytes&&std::fs::read(&barrier)?==SENTINEL&&flat_wavs(&paths.directory)?==promoted_files&&identity(&promoted)?==promoted_identity&&owned_pid!(generation)==original_pid,"Repeated Save re-promoted, replaced source, altered sentinel or restarted input");shot!("publication-repeated-save-1280");std::fs::copy(&promoted,out.join("promoted-flat-root.wav"))?;
            let mut result=json!({"stage":stage,"actualTrainingStart":true,"native330HzPcmReplay":true,"realCrepeOffTargetRespond":true,"actualRecordStop":true,"controlledSentinelCollision":true,"recoveryBackedTake":true,"sameNativeInputGenerationAndPid":true,"exactValidatedNativeRecoverySource":true,"actualFailedSave":true,"failedSaveRetainsRecovery":true,"failedSaveStillPromotesFlatRoot":true,"actualSuccessfulSave":true,"successfulSaveClearsError":true,"actualRepeatedSave":true,"stableOwnedPromotion":true,"unrelatedSentinelByteExact":true,"sameExerciseNoScore":true});
            let details=json!({"sessionId":id,"captureGeneration":generation,"inputPid":original_pid,"takeId":take_id,"take":take_value(&take),"staged":paths.staged,"directory":paths.directory,"filename":paths.filename,"barrier":barrier,"source":source,"promotedFlatRoot":promoted,"promotedIdentity":promoted_identity,"sourceSha256":hash(&bytes),"barrierSha256":hash(SENTINEL),"failedSaveError":export_error,"recoverableMessage":recovery_message,"failedSaveDestination":invalid,"exported":exported,"repeatedExport":repeated,"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true});result.as_object_mut().unwrap().extend(details.as_object().unwrap().clone());
            let scope=json!({"faultScope":"Controlled unrelated sentinel file collision; not disk-full, device loss, permission failure or physical hardware qualification","chooserScope":"Actual measured Save controls with test-only training_recording_prompt_paths chooser seam and real export worker; native OS dialog not qualified","hardwareMicrophoneQualified":false,"nativeOsDialogQualified":false,"diskFullQualified":false,"productionParity":"not evaluated","liveFps":"unmeasured"});result.as_object_mut().unwrap().extend(scope.as_object().unwrap().clone());std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result)?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("RECORDING_PUBLICATION_RECOVERY passed");let _=cx.update(|a|a.quit());},Err(e)=>{eprintln!("RECORDING_PUBLICATION_RECOVERY failed: {e:#}");let _=std::fs::write(out.join("failure.txt"),format!("{e:#}"));let _=handle.update(cx,|_,w,a|capture(&view,w,a,&out,"failure"));let _=view.update(cx,|p,_|{p.training_recording_store.take();p.microphone.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

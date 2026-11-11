//! Native PCM replay -> real CREPE -> interrupted vocal prompt -> explicit retry.
//! Only the worker-owned input child is faulted. No hardware microphone claim.
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
        .context("Missing isolated native PCM fixture")
}
fn receipts(r: &training_run::Run) -> Value {
    json!(r.session.results().iter().map(|v|json!({"promptIndex":v.prompt_index,"response":format!("{:?}",v.response),"correct":v.correct,"completedAt":v.completed_at})).collect::<Vec<_>>())
}
fn session(p: &Player) -> Value {
    p.practice.as_ref().map(|r|json!({"id":r.session.id(),"phase":format!("{:?}",r.phase),"index":r.session.current().map(|q|q.index),"error":r.error,"receipts":receipts(r),"correct":r.snapshot().correct,"total":r.session.prompts().len(),"target":r.target})).unwrap_or(Value::Null)
}
fn snapshot(v: &Entity<Player>, w: &Window, a: &App) -> Value {
    let p = v.read(a);
    let mut s = json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"epoch":p.native_epoch,"screen":p.screen as u8,"notice":p.notice,"playing":p.playing});
    s["session"] = session(p);
    s["training"] = json!({"generation":p.training_test,"serial":p.training_serial,"stopped":p.training_stopped});
    s["microphone"] = json!({"phase":format!("{:?}",p.mic_view.phase),"generation":p.mic_view.generation,"owner":p.mic_view.owner,"fixture":p.mic_view.fixture,"sequence":p.mic_view.sequence,"intent":p.mic_intent.is_some(),"error":p.mic_view.error,"frequency":p.mic_view.frequency,"clarity":p.mic_view.clarity,"captureHostNs":p.mic_view.capture_host_ns});
    s["faultPhase"] =
        json!(std::env::var("SINGZ_GPUI_TRAINING_INPUT_RECOVERY_PHASE").unwrap_or_default());
    s["productionParity"] = json!("not evaluated; functional candidate captures only");
    s["liveFps"] = json!("unmeasured in hidden window");
    s["scope"]=json!("Native synthetic PCM replay and real CREPE vocal scoring with an owned input-child kill. No physical microphone, device hotplug, recording or other-screen-navigation qualification. Old-view tick check runs only in Paused controller state; no frames injected into live host.");
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
        "Input recovery window presented"
    );
    let image = w.render_to_image()?;
    let pixels = [image.width(), image.height()];
    let png = out.join(format!("{name}.png"));
    image.save(&png)?;
    let mut s = snapshot(v, w, a);
    s["caseId"] = json!(name);
    s["imagePixels"] = json!(pixels);
    s["zoom"] = json!(1.);
    s["captureMethod"] = json!("hidden GPUI Window::render_to_image; no rescale");
    s["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    s["screenshotSha256"] = json!(hash(std::fs::read(png)?));
    s["fixtureSha256"] = json!(hash(std::fs::read(fixture()?)?));
    s["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    s["testSourceSha256"] = json!(hash(include_bytes!("ui_training_input_recovery.rs")));
    s["os"] = json!(std::env::consts::OS);
    s["architecture"] = json!(std::env::consts::ARCH);
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&s)?,
    )?;
    Ok(())
}
fn retained(p: &Player, id: &str, first: &Value) -> bool {
    p.practice.as_ref().is_some_and(|r| {
        r.session.id() == id
            && r.session.current().is_some_and(|q| q.index == 2)
            && receipts(r) == *first
            && r.snapshot().correct == 1
    })
}
fn vocal_evidence(r: &training_run::Run) -> anyhow::Result<Value> {
    let mut evidence = vec![];
    for receipt in r.session.results() {
        let training_session::Response::Vocal(targets) = &receipt.response else {
            anyhow::bail!("Non-vocal result in native vocal regression")
        };
        for target in targets {
            anyhow::ensure!(
                target.classification == training_session::Classification::OnTarget
                    && target.metrics.voiced_coverage.is_some_and(|v| v > 0.85),
                "Native CREPE receipt lacks on-target voiced evidence"
            );
            evidence.push(json!({"promptIndex":receipt.prompt_index,"targetIndex":target.index,"classification":format!("{:?}",target.classification),"voicedCoverage":target.metrics.voiced_coverage,"medianCentsError":target.metrics.median_cents_error,"stableHoldRatio":target.metrics.stable_hold_ratio,"detectedMidi":target.metrics.detected_midi}));
        }
    }
    Ok(json!(evidence))
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode(),"Requires hidden muted real native audio/input");let _=fixture()?;std::fs::create_dir_all(&out)?;
            let phase=std::env::var("SINGZ_GPUI_TRAINING_INPUT_RECOVERY_PHASE")?;anyhow::ensure!(phase=="cue"||phase=="completing","Unknown input fault phase {phase}");
            macro_rules! wait{($seconds:expr,$p:ident,$w:ident,$a:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);loop{cx.background_executor().timer(Duration::from_millis(15)).await;if handle.update(cx,|_,$w,$a|{draw($w,$a);let $p=view.read($a);let _=(&$p,&$w,&$a);$predicate})?{break;}if Instant::now()>=deadline{let s=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;anyhow::bail!("Input recovery timeout {}: {s}",stringify!($predicate));}}}}}
            macro_rules! receive_pid{($rx:expr)=>{{let rx=$rx;let deadline=Instant::now()+Duration::from_secs(8);loop{match rx.try_recv(){Ok(v)=>break v.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Owned input PID acknowledgement disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}anyhow::ensure!(Instant::now()<deadline,"Owned input PID acknowledgement timeout");cx.background_executor().timer(Duration::from_millis(5)).await;}}}}
            macro_rules! shot{($name:expr)=>{handle.update(cx,|_,w,a|capture(&view,w,a,&out,$name))??}}
            macro_rules! training{($id:expr)=>{handle.update(cx,|_,w,a|button(&view,w,a,$id))??}}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|s.snapshot().loaded)&&p.mic_prefs_valid);
            handle.update(cx,|_,w,a|header_control(&view,w,a,"training"))??;wait!(5,p,w,a=>p.screen==Screen::Training);
            handle.update(cx,|_,_,a|view.read(a).training.clone().update(a,|s,a|s.input_recovery_fixture(a)))?;
            training!("training-start");
            wait!(45,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Cue&&r.session.current().is_some_and(|q|q.index==2)&&r.session.results().len()==1&&r.snapshot().correct==1)&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4&&p.mic_view.fixture&&p.training_test.is_some()&&p.notice.is_none());
            let (id,first,old_view,old_cue_generation,first_evidence)=handle.update(cx,|_,_,a|->anyhow::Result<_>{let p=view.read(a);let r=p.practice.as_ref().unwrap();Ok((r.session.id().to_string(),receipts(r),p.mic_view.clone(),p.training_test.unwrap(),vocal_evidence(r)?))})??;
            let original_generation=old_view.generation;
            // Completing lasts only 250 ms. Detect and issue the worker kill in
            // the same UI update, before draws, screenshots, PID queries or probes.
            let deadline=Instant::now()+Duration::from_secs(30);
            let (kill_receiver,fault_phase,sequence_at_fault)=loop{
                let next=handle.update(cx,|_,_,a|->anyhow::Result<_>{let p=view.read(a);anyhow::ensure!(retained(p,&id,&first),"Second prompt scored/advanced before requested fault");let r=p.practice.as_ref().unwrap();anyhow::ensure!(r.error.is_none()&&p.notice.is_none(),"Unexpected pre-fault failure");let target=if phase=="cue"{training_run::Phase::Cue}else{training_run::Phase::Completing};if r.phase!=target{return Ok(None)}anyhow::ensure!(p.mic_view.generation==original_generation&&p.mic_view.owner==4&&p.mic_view.fixture,"Second prompt changed native input owner before fault");let rx=p.microphone.as_ref().context("Missing native input service")?.fail_owned_capture(original_generation)?;Ok(Some((rx,format!("{:?}",r.phase),p.mic_view.sequence)))})??;
                if let Some(fault)=next{break fault;}anyhow::ensure!(Instant::now()<deadline,"Requested fault phase not observed");cx.background_executor().timer(Duration::from_millis(5)).await;
            };
            let original_pid=receive_pid!(kill_receiver);anyhow::ensure!(original_pid>0,"Owned input fault returned no PID");
            wait!(12,p,w,a=>retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_ref().is_some_and(|e|!e.is_empty())&&p.training_test.is_none());
            let (error,serial)=handle.update(cx,|_,_,a|{let p=view.read(a);(p.practice.as_ref().unwrap().error.clone().unwrap(),p.training_serial)})?;
            wait!(10,p,w,a=>retained(p,&id,&first)&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial);
            handle.update(cx,|_,_,a|view.update(a,|p,_|->anyhow::Result<()>{let r=p.practice.as_mut().context("Lost failed practice")?;anyhow::ensure!(r.phase==training_run::Phase::Paused,"Old-view controller check requires Paused");anyhow::ensure!(r.tick(&old_view)?.is_none(),"Paused old frame issued cue plan");anyhow::ensure!(retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_deref()==Some(error.as_str()),"Paused old-view tick altered retained failure");Ok(())}))??;
            cx.background_executor().timer(Duration::from_millis(300)).await;
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id,&first)&&p.training_serial==serial&&p.training_test.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_deref()==Some(error.as_str()),"Input failure auto retried/scored or lost original error");Ok(())})??;
            shot!("input-failed-1280");handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.)));shot!("input-failed-1060");
            let dismissed_notice=handle.update(cx,|_,w,a|{let present=view.read(a).notice.is_some();if present{draw(w,a);w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),a);}present})?;
            wait!(5,p,w,a=>p.notice.is_none()&&retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused);
            training!("training-run-continue");
            wait!(20,p,w,a=>retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Cue&&p.mic_view.phase==microphone::Phase::Live&&p.mic_view.owner==4&&p.mic_view.fixture&&p.mic_view.generation>original_generation&&p.training_test.is_some_and(|g|g>old_cue_generation)&&p.notice.is_none());
            let (replacement_generation,replay_cue_generation,replay_sequence)=handle.update(cx,|_,_,a|{let p=view.read(a);(p.mic_view.generation,p.training_test.unwrap(),p.mic_view.sequence)})?;
            let owned_receiver=handle.update(cx,|_,_,a|view.read(a).microphone.as_ref().context("Missing resumed capture service")?.owned_capture(replacement_generation))??;
            let replacement_pid=receive_pid!(owned_receiver);anyhow::ensure!(replacement_pid>0&&replacement_pid!=original_pid,"Continue reused killed native input PID");
            shot!("input-replayed-cue-1060");
            wait!(40,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary&&r.session.id()==id&&r.session.results().len()==2&&r.snapshot().correct==2)&&p.training_test.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.mic_intent.is_none());
            let (completed,final_evidence)=handle.update(cx,|_,_,a|->anyhow::Result<_>{let p=view.read(a);let r=p.practice.as_ref().unwrap();anyhow::ensure!(receipts(r)[0]==first[0],"Input recovery changed first vocal receipt");Ok((receipts(r),vocal_evidence(r)?))})??;
            wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|{let v=s.snapshot();v.pending==0&&v.error().is_none()&&v.receipts.len()==1&&v.receipts[0].session_id==id}));
            shot!("input-summary-1060");handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1280.),px(800.)));shot!("input-summary-1280");
            let mut result=json!({"phase":phase,"faultObservedPhase":fault_phase,"actualStart":true,"nativePcmReplay":true,"realCrepeFirstPrompt":true,"faultedOwnedNativeInput":true,"workerErrorPausedRun":true,"retainedSessionAndPrompt":true,"retainedFirstReceipt":true,"noInterruptedReceipt":true,"noAutomaticRetryOrScore":true,"pausedOldViewIgnored":true,"actualContinue":true,"freshCaptureGenerationAndPid":true,"realCrepeSecondPrompt":true,"completedSameSession":true,"persistedHistoryCount":1});
            let detail=json!({"sessionId":id,"faultPromptIndex":2,"firstReceipt":first[0],"finalReceipts":completed,"firstNativeVocalEvidence":first_evidence,"finalNativeVocalEvidence":final_evidence,"error":error,"originalInputPid":original_pid,"replacementInputPid":replacement_pid,"originalCaptureGeneration":original_generation,"replacementCaptureGeneration":replacement_generation,"oldCueGeneration":old_cue_generation,"replayCueGeneration":replay_cue_generation,"sequenceAtFault":sequence_at_fault,"replaySequence":replay_sequence,"noticeDismissedByActualEscape":dismissed_notice});result.as_object_mut().unwrap().extend(detail.as_object().unwrap().clone());
            let scope=json!({"inputFaultMethod":"Service::fail_owned_capture(expected_generation), acknowledged real worker-owned child PID; worker detects actual process/pipe error","oldViewScope":"Run::tick(oldView) only while Paused; no data injected into live host","hardwareMicrophoneQualified":false,"physicalHotplugQualified":false,"recordingsExercised":false,"otherScreenNavigationExercised":false,"hidden":true,"muted":true,"sizes":[[1280,800],[1060,640]],"productionParity":"not evaluated","liveFps":"unmeasured"});result.as_object_mut().unwrap().extend(scope.as_object().unwrap().clone());
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result)?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_INPUT_RECOVERY passed");let _=cx.update(|a|a.quit());},Err(e)=>{eprintln!("TRAINING_INPUT_RECOVERY failed: {e:#}");let _=std::fs::write(out.join("failure.txt"),format!("{e:#}"));let _=handle.update(cx,|_,w,a|capture(&view,w,a,&out,"failure"));let _=view.update(cx,|p,_|{p.microphone.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

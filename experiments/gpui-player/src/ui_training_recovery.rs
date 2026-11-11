//! Hidden Identify lifecycle through an owned native output failure and retry.
//! No microphone, vocal scoring, hardware hotplug, or visual parity qualification.
use super::ui_training_run::{button, click, draw, header_control};
use super::*;
use anyhow::Context as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn hash(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
fn path(name: &str) -> anyhow::Result<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .with_context(|| format!("Missing isolated {name}"))
}
fn receipts(run: &training_run::Run) -> Value {
    json!(run.session.results().iter().map(|r|json!({"promptIndex":r.prompt_index,"response":format!("{:?}",r.response),"correct":r.correct,"completedAt":r.completed_at})).collect::<Vec<_>>())
}
fn session(p: &Player) -> Value {
    p.practice.as_ref().map(|r|json!({"id":r.session.id(),"phase":format!("{:?}",r.phase),"index":r.session.current().map(|q|q.index),"displayedIndex":r.displayed_prompt().index,"state":format!("{:?}",r.session.state()),"error":r.error,"receipts":receipts(r),"correct":r.snapshot().correct,"total":r.session.prompts().len(),"needsMicrophone":r.needs_microphone()})).unwrap_or(Value::Null)
}
fn snapshot(view: &Entity<Player>, w: &Window, a: &App) -> Value {
    let p = view.read(a);
    let mut v = json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"screen":p.screen as u8,"epoch":p.native_epoch,"position":p.position,"playing":p.playing,"notice":p.notice,"tracksAudioFailed":p.tracks_audio_failed,"audioRecoveryPending":p.audio_recovery.is_some(),"editSeq":p.edit_seq,"savedSeq":p.saved_seq});
    v["session"] = session(p);
    v["trainingOutputAvailable"] = json!(p.training.read(a).audio_available_for_test());
    v["training"] = json!({"generation":p.training_test,"serial":p.training_serial,"stopped":p.training_stopped,"lastGeneration":p.training_last.as_ref().map(|s|s.generation)});
    v["microphone"] = json!({"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"intent":p.mic_intent.is_some()});
    v["mix"] = json!({"tempo":p.tempo,"transpose":p.transpose,"master":p.master_volume,"looping":p.looping,"nativeLoop":p.native_loop});
    v["project"] = json!(p
        .project
        .as_ref()
        .map(|v| json!({"dir":v.dir,"metadataHash":v.metadata_hash,"selection":v.selection})));
    v["native"]=json!(p.last_playback_status.as_ref().map(|s|json!({"position":s.position,"playing":s.playing,"rate":s.rate,"transpose":s.transpose,"loop":s.loop_range,"trainingOnly":s.training_only,"cueGeneration":s.cue.generation,"cueActive":s.cue.active})));
    v["productionParity"] = json!("not evaluated; functional candidate captures only");
    v["liveFps"] = json!("unmeasured in hidden window");
    v["scope"]=json!("Identify only; owned native helper fault, retained session and explicit output retry. No microphone/vocal runtime, other-screen navigation, recordings or physical hotplug qualification. Stale receipts are limited controller calls, not native receipt injection.");
    v
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    a: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, a);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Training recovery window was presented"
    );
    let image = w.render_to_image()?;
    let pixels = [image.width(), image.height()];
    let png = out.join(format!("{name}.png"));
    image.save(&png)?;
    let mut v = snapshot(view, w, a);
    v["caseId"] = json!(name);
    v["imagePixels"] = json!(pixels);
    v["zoom"] = json!(1.);
    v["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    v["captureMethod"] = json!("hidden GPUI Window::render_to_image; no rescale");
    v["screenshotSha256"] = json!(hash(std::fs::read(png)?));
    v["fixtureSha256"] = json!(hash(std::fs::read(path(
        "SINGZ_GPUI_TRAINING_RECOVERY_FIXTURE"
    )?)?));
    v["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    v["testSourceSha256"] = json!(hash(include_bytes!("ui_training_recovery.rs")));
    v["os"] = json!(std::env::consts::OS);
    v["architecture"] = json!(std::env::consts::ARCH);
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&v)?,
    )?;
    Ok(())
}
fn probe_value(p: &integration::OwnedAudioProbe, stage: &str) -> Value {
    json!({"stage":stage,"epoch":p.epoch,"helperPid":p.helper_pid,"monitorLeased":p.monitor_leased,"activeTraining":p.active_training,"trainingOnly":p.status.training_only,"playing":p.status.playing,"position":p.status.position,"rate":p.status.rate,"transpose":p.status.transpose,"loop":p.status.loop_range,"cueGeneration":p.status.cue.generation,"cueActive":p.status.cue.active,"sampleAgeSeconds":p.status.sampled_at.elapsed().as_secs_f64(),"method":"fresh backend-owned native status command"})
}
fn retained(p: &Player, id: &str, first: &Value) -> bool {
    p.practice.as_ref().is_some_and(|r| {
        r.session.id() == id
            && r.session.current().is_some_and(|q| q.index == 2)
            && receipts(r) == *first
            && r.snapshot().correct == 1
    }) && p.mic_intent.is_none()
        && p.mic_view.phase == microphone::Phase::Off
        && p.mic_view.owner == 0
}
fn escape(w: &mut Window, a: &mut App) {
    draw(w, a);
    w.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("escape").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        a,
    );
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode(),"Requires hidden muted real native backend");
            std::fs::create_dir_all(&out)?;
            let saved=std::env::var_os("SINGZ_GPUI_TRAINING_RECOVERY_PROJECT").map(PathBuf::from).map(|path|path.canonicalize()).transpose()?;let song_backed=saved.is_some();
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$a:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs($seconds);loop{cx.background_executor().timer(Duration::from_millis(15)).await;if handle.update(cx,|_,$w,$a|{draw($w,$a);let $p=view.read($a);let _=(&$p,&$w,&$a);$predicate})?{break;}if Instant::now()>=deadline{let v=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;anyhow::bail!("Training recovery timeout {}: {v}",stringify!($predicate));}}}}}
            macro_rules! probe {()=>{{let rx=handle.update(cx,|_,_,a|{let p=view.read(a);p.backend.as_ref().context("No native backend")?.probe_owned_audio(p.native_epoch)})??;let deadline=Instant::now()+Duration::from_secs(8);loop{match rx.try_recv(){Ok(v)=>break v.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Native probe disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}anyhow::ensure!(Instant::now()<deadline,"Native probe timeout");cx.background_executor().timer(Duration::from_millis(10)).await;}}}}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,a|capture(&view,w,a,&out,$name))??}}
            macro_rules! header {($id:expr)=>{handle.update(cx,|_,w,a|header_control(&view,w,a,$id))??}}
            macro_rules! training {($id:expr)=>{handle.update(cx,|_,w,a|button(&view,w,a,$id))??}}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|s.snapshot().loaded));
            let mut metadata_before=None;
            if let Some(project)=&saved {
                metadata_before=Some(std::fs::read(project.join("project.json"))?);
                handle.update(cx,|_,_,a|view.update(a,|p,a|p.open_project(project.clone(),a)))?;
                wait!(30,p,w,a=>!p.loading&&p.project.as_ref().is_some_and(|v|&v.dir==project)&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&s.duration>=10.));
                handle.update(cx,|_,_,a|view.update(a,|p,a|{p.native_transport(transport::TransportEvent::Volume(0.6),a);p.native_transport(transport::TransportEvent::Tempo(0.8),a);p.native_transport(transport::TransportEvent::Transpose(-2),a);p.native_transport(transport::TransportEvent::Loop,a);p.position=2.;p.seek_native(a);}))?;
                wait!(15,p,w,a=>!p.rate_busy()&&p.pending_seek.is_none()&&p.edit_seq>p.saved_seq&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&(s.rate-0.8).abs()<0.0001&&s.transpose==-2&&(s.position-2.).abs()<0.03&&s.loop_range.is_some()));
            }
            let (epoch,edit_seq,saved_seq,project_hash,accepted_loop)=handle.update(cx,|_,_,a|{let p=view.read(a);(p.native_epoch,p.edit_seq,p.saved_seq,p.project.as_ref().map(|v|v.metadata_hash.clone()),p.last_playback_status.as_ref().and_then(|s|s.loop_range))})?;
            header!("training");wait!(5,p,w,a=>p.screen==Screen::Training);
            handle.update(cx,|_,_,a|view.read(a).training.clone().update(a,|s,a|s.recovery_fixture(a)))?;
            training!("training-start");
            wait!(15,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond&&r.session.current().is_some_and(|q|q.index==1)&&r.session.prompts().len()==2)&&p.notice.is_none());
            let id=handle.update(cx,|_,_,a|view.read(a).practice.as_ref().unwrap().session.id().to_string())?;
            handle.update(cx,|_,w,a|{let note=view.read(a).practice.as_ref().unwrap().displayed_prompt().targets[0].midi%12;button(&view,w,a,&format!("training-answer-{note}"))})??;
            wait!(12,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Cue&&r.session.current().is_some_and(|q|q.index==2)&&r.session.results().len()==1&&r.snapshot().correct==1)&&p.training_test.is_some()&&p.notice.is_none());
            let first=handle.update(cx,|_,_,a|receipts(view.read(a).practice.as_ref().unwrap()))?;
            let before_fault=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;
            let fault_probe=probe!();let fault_value=probe_value(&fault_probe,"second-cue-before-fault");let original_pid=fault_probe.helper_pid;let old_cue=fault_probe.status.cue.clone();let old_generation=old_cue.generation;
            anyhow::ensure!(fault_probe.epoch==epoch&&fault_probe.active_training==Some((epoch,old_generation))&&old_generation>0&&!fault_probe.monitor_leased&&fault_probe.status.training_only==!song_backed,"Native second cue has wrong ownership");
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Cue&&p.training_test==Some(old_generation),"Second cue ended before owned-helper fault");p.backend.as_ref().context("Missing owned helper")?.fail_owned_audio(epoch)})??;
            wait!(12,p,w,a=>retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.practice.as_ref().unwrap().error.as_ref().is_some_and(|e|!e.is_empty())&&p.training_test.is_none()&&p.notice.is_some()&&p.tracks_audio_failed==song_backed);
            let (error,serial)=handle.update(cx,|_,_,a|->anyhow::Result<_>{let p=view.read(a);let error=p.practice.as_ref().unwrap().error.clone().unwrap();anyhow::ensure!(p.notice.as_ref().is_some_and(|n|n.contains(&error)&&n.contains("Continue")&&(!song_backed||n.contains("Settings"))),"Notice omitted original training failure or explicit recovery action");Ok((error,p.training_serial))})??;
            handle.update(cx,|_,_,a|view.update(a,|p,a|->anyhow::Result<()>{p.training_status(&old_cue,a);anyhow::ensure!(retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.training_test.is_none(),"Stale controller cue receipt resumed failed run");Ok(())}))??;
            cx.background_executor().timer(Duration::from_millis(200)).await;
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);anyhow::ensure!(retained(p,&id,&first)&&p.training_serial==serial&&p.training_test.is_none()&&p.practice.as_ref().unwrap().error.as_deref()==Some(error.as_str()),"Failed run auto-replayed or lost its specific error");Ok(())})??;
            shot!("training-failed-1280");
            handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.)));shot!("training-failed-1060");
            handle.update(cx,|_,w,a|escape(w,a))?;wait!(5,p,w,a=>p.notice.is_none()&&retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused);
            let mut probes=vec![fault_value];
            if song_backed {
                // Actual disabled Continue click, followed by a limited controller guard check.
                training!("training-run-continue");
                handle.update(cx,|_,_,a|{let training=view.read(a).training.clone();training.update(a,|_,a|a.emit(training::TrainingEvent::Continue));})?;
                cx.background_executor().timer(Duration::from_millis(200)).await;
                handle.update(cx,|_,w,a|->anyhow::Result<()>{draw(w,a);let p=view.read(a);anyhow::ensure!(retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.training_serial==serial&&p.training_test.is_none()&&p.tracks_audio_failed&&!p.training.read(a).audio_available_for_test(),"Disabled/direct Continue dispatched before song output recovery");Ok(())})??;
                shot!("training-continue-blocked-1060");
                header!("settings");wait!(5,p,w,a=>p.screen==Screen::Settings);
                handle.update(cx,|_,w,a|->anyhow::Result<()>{draw(w,a);let b=view.read(a).settings.read(a).field_bounds("settings-retry").context("Settings Retry not measured")?;anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=w.viewport_size().height,"Retry outside viewport");click(w,a,b.center());Ok(())})??;
                wait!(30,p,w,a=>!p.tracks_audio_failed&&p.audio_recovery.is_none()&&p.notice.is_none()&&retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Paused&&p.native_epoch==epoch&&p.edit_seq==edit_seq&&p.saved_seq==saved_seq&&p.project.as_ref().is_some_and(|v|Some(&v.dir)==saved.as_ref()&&Some(v.metadata_hash.clone())==project_hash)&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&(s.position-2.).abs()<0.03&&(s.rate-0.8).abs()<0.0001&&s.transpose==-2&&s.loop_range==accepted_loop));
                let route=probe!();let route_value=probe_value(&route,"song-settings-recovered-paused");anyhow::ensure!(route.helper_pid!=original_pid&&!route.status.playing&&!route.status.training_only&&!route.monitor_leased,"Settings Retry did not replace owned song helper paused");probes.push(route_value);
                shot!("training-song-route-recovered-1060");
                handle.update(cx,|_,w,a|escape(w,a))?;wait!(5,p,w,a=>p.screen==Screen::Training&&retained(p,&id,&first));
            }
            training!("training-run-continue");
            wait!(15,p,w,a=>retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Cue&&p.training_test.is_some_and(|g|g>old_generation)&&p.notice.is_none());
            let replay=probe!();let replay_value=probe_value(&replay,"second-cue-explicit-continue");let replacement_pid=replay.helper_pid;let replay_generation=replay.status.cue.generation;
            anyhow::ensure!(replacement_pid!=original_pid&&replay_generation>old_generation&&replay.active_training==Some((epoch,replay_generation))&&!replay.monitor_leased,"Continue did not start a fresh native cue/helper");probes.push(replay_value);
            handle.update(cx,|_,_,a|view.update(a,|p,a|->anyhow::Result<()>{anyhow::ensure!(p.practice.as_ref().unwrap().phase==training_run::Phase::Cue,"Replay cue completed before stale receipt check");let previous_last=p.training_last.as_ref().map(|s|s.generation);p.training_status(&old_cue,a);anyhow::ensure!(retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Cue&&p.training_test==Some(replay_generation)&&p.training_last.as_ref().map(|s|s.generation)==previous_last,"Stale controller receipt changed fresh cue");Ok(())}))??;
            shot!("training-replayed-cue-1060");
            wait!(15,p,w,a=>retained(p,&id,&first)&&p.practice.as_ref().unwrap().phase==training_run::Phase::Respond&&p.notice.is_none());
            handle.update(cx,|_,w,a|{let note=view.read(a).practice.as_ref().unwrap().displayed_prompt().targets[0].midi%12;button(&view,w,a,&format!("training-answer-{note}"))})??;
            wait!(10,p,w,a=>p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary&&r.session.id()==id&&r.session.results().len()==2&&r.snapshot().correct==2)&&p.training_test.is_none()&&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off);
            wait!(10,p,w,a=>p.training_store.as_ref().is_some_and(|s|{let v=s.snapshot();v.pending==0&&v.error().is_none()&&v.receipts.len()==1&&v.receipts[0].session_id==id}));
            shot!("training-summary-1060");handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(5,p,w,a=>w.viewport_size()==size(px(1280.),px(800.)));shot!("training-summary-1280");
            let final_state=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;
            let completed=handle.update(cx,|_,_,a|receipts(view.read(a).practice.as_ref().unwrap()))?;
            anyhow::ensure!(completed[0]==first[0],"Completion changed first Identify receipt");
            if let Some(project)=&saved {anyhow::ensure!(Some(std::fs::read(project.join("project.json"))?)==metadata_before,"Training recovery changed saved song metadata");std::fs::write(out.join("retained-project.json"),metadata_before.as_ref().unwrap())?;}
            std::fs::write(out.join("before-fault.json"),serde_json::to_vec_pretty(&before_fault)?)?;
            std::fs::write(out.join("completed-state.json"),serde_json::to_vec_pretty(&final_state)?)?;
            std::fs::write(out.join("native-probes.json"),serde_json::to_vec_pretty(&probes)?)?;
            let mut result=json!({"songBacked":song_backed,"actualStart":true,"actualFirstCorrectAnswer":true,"faultedOwnedNativeHelper":true,"retainedSameSessionAndPrompt":true,"retainedFirstReceipt":true,"specificRunErrorRetained":true,"noAutomaticCueOrScore":true,"actualNoticeEscape":true,"actualExplicitContinue":true,"freshNativeReplay":true,"actualSecondCorrectAnswer":true,"completedSameSession":true,"persistedHistoryCount":1,"identifyWithoutMicrophone":true,"stalePausedControllerReceiptIgnored":true,"staleFreshCueControllerReceiptIgnored":true});
            let details=json!({"songContinueDisabled":song_backed,"directContinueBlocked":song_backed,"actualSettingsRetry":song_backed,"dirtySongRetained":song_backed,"sessionId":id,"faultPromptIndex":2,"firstReceipt":first[0],"finalReceipts":completed,"error":error,"epoch":epoch,"originalHelperPid":original_pid,"replacementHelperPid":replacement_pid,"oldCueGeneration":old_generation,"replayCueGeneration":replay_generation,"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"hardwareMicrophoneQualified":false,"vocalRuntimeExercised":false,"otherScreenNavigationExercised":false,"recordingsExercised":false,"staleReceiptScope":"limited Player::training_status controller calls with the old native cue status; not native receipt injection","productionParity":"not evaluated","liveFps":"unmeasured"});result.as_object_mut().unwrap().extend(details.as_object().unwrap().clone());
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&result)?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_RECOVERY passed");let _=cx.update(|a|a.quit());},Err(e)=>{eprintln!("TRAINING_RECOVERY failed: {e:#}");let _=std::fs::write(out.join("failure.txt"),format!("{e:#}"));let _=handle.update(cx,|_,w,a|capture(&view,w,a,&out,"failure"));let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

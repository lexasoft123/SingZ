//! Connected raw-source Save while the native monitor owns the output lease.
//! Fixture capture is muted; playback and its lease/status probes stay native.
use super::ui_training_run::{click, draw, header_control};
use super::*;
use anyhow::Context as _;
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

const ADAPTER_SCOPE: &str = r#"After real completed publication, test holds saving=true, clicks actual header Stop, then synchronously calls Player::select_output("") during cleanup to queue the same-default Output controller intent; held state retains queue and pending epoch with no recovery, then clearing saving permits queued Output dispatch and paused recovery. This is not an actual selector/UI route test, no real concurrent second writer is claimed, and no system device is changed"#;

const PRIMARY_SCOPE: &str = "Actual header Stop restores the published project automatically; no held saving state or controller Output adapter is used, no real concurrent second writer is claimed";

fn adapter_enabled() -> bool {
    std::env::var("SINGZ_GPUI_MONITOR_PUBLICATION_ADAPTER").as_deref() == Ok("1")
}

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
fn snapshot(view: &Entity<Player>, window: &Window, cx: &App) -> Value {
    let p = view.read(cx);
    let mut value = json!({"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"scale":window.scale_factor(),
        "windowPresented":window.is_visible(),"windowActive":window.is_window_active(),"hidden":!window.is_visible()&&!window.is_window_active(),
        "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "epoch":p.native_epoch,"publicationEpoch":p.monitor_publication_epoch,"screen":p.screen as u8,"position":p.playhead.position(),"duration":p.duration,"playing":p.playing,
        "sourceWorking":p.source_working,"sourceJob":p.source_job,"publicationPending":p.source_publication.is_some(),"loading":p.loading,"saving":p.saving,
        "tracksAudioFailed":p.tracks_audio_failed,"audioRecoveryPending":p.audio_recovery.is_some(),"notice":p.notice,"editSeq":p.edit_seq,"savedSeq":p.saved_seq});
    let monitor = json!({"requested":p.monitor_requested,"parked":p.monitor_parked,"pending":p.monitor_pending.is_some(),"monitorBusy":p.monitor_busy(),"micIntent":p.mic_intent.is_some(),
        "micPhase":format!("{:?}",p.mic_view.phase),"micOwner":p.mic_view.owner,"generation":p.mic_view.generation,"sequence":p.mic_view.sequence,"fixture":p.mic_view.fixture,"audibleMonitor":p.mic_view.monitor_enabled,
        "header":p.header.read(cx).monitor_state(),"tempo":p.tempo,"transpose":p.transpose,"master":p.master_volume,"looping":p.looping,"nativeLoop":p.playhead.loop_range()});
    value
        .as_object_mut()
        .unwrap()
        .extend(monitor.as_object().unwrap().clone());
    value["project"] = json!(p
        .project
        .as_ref()
        .map(|v| json!({"dir":v.dir,"metadataHash":v.metadata_hash,"selection":v.selection})));
    value["native"]=json!(p.last_playback_status.as_ref().map(|s|json!({"position":s.position,"playing":s.playing,"rate":s.rate,"transpose":s.transpose,"loop":s.loop_range,"parked":s.parked,"physicalOutputReleased":s.physical_output_released})));
    value["stopRecoveryAdapterScope"] = json!(if adapter_enabled() {
        ADAPTER_SCOPE
    } else {
        PRIMARY_SCOPE
    });
    value["heldSavingStateAdapter"] = json!(adapter_enabled());
    value["queuedActionCount"] = json!(p.monitor_actions.len());
    value["queuedOutputCount"] = json!(p
        .monitor_actions
        .iter()
        .filter(|action| matches!(action, DeferredAudio::Output(_)))
        .count());
    value["queuedDefaultOutputCount"] = json!(p
        .monitor_actions
        .iter()
        .filter(|action| matches!(action,DeferredAudio::Output(uid) if uid.is_empty()))
        .count());
    value["monitorRouteError"] = json!(p.settings.read(cx).monitor_route().err());
    value["platformUnavailablePolicy"] =
        json!(cfg!(any(target_os = "windows", target_os = "linux")));
    value["productionParity"] = json!("not evaluated; functional candidate capture only");
    value["liveFps"] = json!("unmeasured in hidden window");
    value
}
fn capture(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    anyhow::ensure!(
        !window.is_visible() && !window.is_window_active(),
        "Hidden window was presented"
    );
    let image = window.render_to_image()?;
    let pixels = [image.width(), image.height()];
    let png = out.join(format!("{name}.png"));
    image.save(&png)?;
    let mut state = snapshot(view, window, cx);
    state["caseId"] = json!(name);
    state["imagePixels"] = json!(pixels);
    state["zoom"] = json!(1.);
    state["captureMethod"] = json!("hidden GPUI Window::render_to_image; no rescale");
    state["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    state["screenshotSha256"] = json!(hash(std::fs::read(png)?));
    state["fixtureSha256"] = json!(hash(std::fs::read(path(
        "SINGZ_GPUI_MONITOR_PUBLICATION_RAW"
    )?)?));
    state["microphoneSha256"] = json!(hash(std::fs::read(path("SINGZ_GPUI_CAPTURE_FIXTURE")?)?));
    state["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    state["testSourceSha256"] = json!(hash(include_bytes!("ui_monitor_publication.rs")));
    state["os"] = json!(std::env::consts::OS);
    state["architecture"] = json!(std::env::consts::ARCH);
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&state)?,
    )?;
    Ok(())
}
fn active(p: &Player, epoch: u64, generation: u64) -> bool {
    p.native_epoch == epoch
        && p.mic_view.generation == generation
        && p.mic_view.phase == microphone::Phase::Monitoring
        && p.mic_view.owner == 3
        && p.mic_view.fixture
        && !p.mic_view.monitor_enabled
        && p.monitor_requested
        && p.monitor_parked
        && p.monitor_pending.is_none()
        && p.monitor_actions.is_empty()
        && p.mic_intent.as_ref().is_some_and(|i| i.monitor)
        && p.notice.is_none()
        && !p.playing
        && (p.playhead.position() - 2.).abs() < 0.03
}
fn probe_value(p: &integration::OwnedAudioProbe, stage: &str) -> Value {
    json!({"stage":stage,"epoch":p.epoch,"helperPid":p.helper_pid,"monitorLeased":p.monitor_leased,"activeTraining":p.active_training,"parked":p.status.parked,"physicalOutputReleased":p.status.physical_output_released,"playing":p.status.playing,"position":p.status.position,"rate":p.status.rate,"transpose":p.status.transpose,"loop":p.status.loop_range,"sampleAgeSeconds":p.status.sampled_at.elapsed().as_secs_f64(),"method":"fresh backend-owned native status command"})
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode(),"Requires hidden muted real playback backend");
            std::fs::create_dir_all(&out)?;
            let raw=path("SINGZ_GPUI_MONITOR_PUBLICATION_RAW")?.canonicalize()?;
            let library=path("SINGZ_GPUI_PROJECTS_ROOT")?;
            let config=path("SINGZ_GPUI_CONFIG_DIR")?;
            let adapter=adapter_enabled();
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$a:ident=>$predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$a|{draw($w,$a);let $p=view.read($a);let _=(&$p,&$w,&$a);$predicate})?{break;}
                    if Instant::now()>=deadline {let state=handle.update(cx,|_,w,a|snapshot(&view,w,a))?;anyhow::bail!("Timed out {}: {state}",stringify!($predicate));}
                }
            }}}
            macro_rules! probe {()=>{{
                let receiver=handle.update(cx,|_,_,a|{let p=view.read(a);p.backend.as_ref().context("Missing native backend")?.probe_owned_audio(p.native_epoch)})??;
                let deadline=Instant::now()+Duration::from_secs(8);
                loop {match receiver.try_recv(){Ok(v)=>break v.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Probe disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}
                    anyhow::ensure!(Instant::now()<deadline,"Probe timeout");cx.background_executor().timer(Duration::from_millis(10)).await;
                }
            }}}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,a|capture(&view,w,a,&out,$name))??}}
            macro_rules! header {($id:expr)=>{handle.update(cx,|_,w,a|header_control(&view,w,a,$id))??}}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            handle.update(cx,|_,w,a|{draw(w,a);let at=point(px(500.),px(400.));w.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Entered{position:at,paths:ExternalPaths(vec![raw.clone()].into())}),a);draw(w,a);w.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Submit{position:at}),a);})?;
            wait!(45,p,w,a=>!p.loading&&p.source_job.is_none()&&p.source_working&&p.source_target.is_none()&&p.project.as_ref().is_some_and(|v|v.original)&&p.mic_prefs_valid&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&s.duration>=10.));
            let working=handle.update(cx,|_,_,a|view.read(a).project.as_ref().unwrap().dir.clone())?;
            anyhow::ensure!(working.starts_with(config.join("source-work").canonicalize()?),"Source bypassed isolated working copy");
            handle.update(cx,|_,_,a|view.update(a,|p,a|{p.native_transport(transport::TransportEvent::Volume(0.6),a);p.native_transport(transport::TransportEvent::Tempo(0.8),a);p.native_transport(transport::TransportEvent::Transpose(-2),a);p.native_transport(transport::TransportEvent::Loop,a);p.playhead.seek(2.);p.seek_native(a);}))?;
            wait!(20,p,w,a=>!p.rate_busy()&&p.playhead.pending_seek().is_none()&&(p.master_volume-0.6).abs()<0.0001&&p.looping&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&(s.position-2.).abs()<0.03&&(s.rate-0.8).abs()<0.0001&&s.transpose==-2&&s.loop_range.is_some_and(|(start,end)|start==0.&&(end-p.duration).abs()<0.03)));
            let epoch=handle.update(cx,|_,_,a|view.read(a).native_epoch)?;
            let working_metadata=std::fs::read(working.join("project.json"))?;
            let initial=probe!();let initial_value=probe_value(&initial,"initial");let pid=initial.helper_pid;
            anyhow::ensure!(!initial.monitor_leased&&!initial.status.parked,"Initial playback already leased");
            header!("settings");wait!(5,p,w,a=>p.screen==Screen::Settings);
            handle.update(cx,|_,w,a|->anyhow::Result<()>{let settings=view.read(a).settings.clone();settings.update(a,|s,a|{s.set_inventory(Ok(ui_monitor::fixture_inventory()),a);a.emit(settings::SettingsEvent::InputPrefs(microphone::Prefs{input:"singz:fake-duplex".into(),monitor_output:"singz:fake-duplex".into(),..Default::default()}));});anyhow::ensure!(view.read(a).settings.read(a).monitor_route().is_err(),"Consent was bypassed");draw(w,a);w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(800.),px(500.)),delta:ScrollDelta::Pixels(point(px(0.),px(-2000.))),..Default::default()}),a);Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(60)).await;
            handle.update(cx,|_,w,a|->anyhow::Result<()>{draw(w,a);let b=view.read(a).settings.read(a).field_bounds("settings-headphones").context("Headphones not measured")?;click(w,a,b.center());Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(40)).await;
            handle.update(cx,|_,w,a|->anyhow::Result<()>{view.read(a).settings.clone().update(a,|s,a|s.set_inventory(Ok(ui_monitor::fixture_inventory()),a));anyhow::ensure!(view.read(a).mic_prefs.headphones,"Headphones click failed");draw(w,a);let b=view.read(a).settings.read(a).field_bounds("settings-monitor-start").context("Monitor not measured")?;anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=w.viewport_size().height,"Monitor outside viewport");click(w,a,b.center());Ok(())})??;
            if cfg!(any(target_os="windows",target_os="linux")) {
                // Exercise the real disabled control and preserve production's platform policy.
                // No monitoring lease or publication workflow is claimed on these platforms.
                cx.background_executor().timer(Duration::from_millis(200)).await;
                wait!(5,p,w,a=>p.native_epoch==epoch&&p.source_working&&p.project.as_ref().is_some_and(|v|v.dir==working)&&!p.monitor_requested&&!p.monitor_parked&&p.monitor_pending.is_none()&&!p.monitor_busy()&&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.notice.is_none()&&!p.playing&&p.settings.read(a).monitor_route()==Err(crate::i18n::t("settings.monitor.routePlatformUnavailable").into()));
                anyhow::ensure!(std::fs::read(working.join("project.json"))?==working_metadata,"Disabled Monitor changed working metadata");
                let policy=probe!();let policy_value=probe_value(&policy,"platform-unavailable-after-click");
                anyhow::ensure!(policy.helper_pid==pid&&policy.epoch==epoch&&!policy.monitor_leased&&!policy.status.parked&&!policy.status.playing&&(policy.status.position-2.).abs()<0.03,"Disabled Monitor disturbed native playback ownership");
                shot!("monitor-platform-unavailable-1280");
                handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;
                wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.))&&!p.monitor_busy()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.notice.is_none());
                shot!("monitor-platform-unavailable-1060");
                let resized=probe!();let resized_value=probe_value(&resized,"platform-unavailable-resized");
                anyhow::ensure!(resized.helper_pid==pid&&resized.epoch==epoch&&!resized.monitor_leased&&!resized.status.parked&&!resized.status.playing&&(resized.status.position-2.).abs()<0.03,"Policy capture disturbed native playback");
                std::fs::write(out.join("working-project.json"),&working_metadata)?;
                std::fs::copy(&raw,out.join("raw-source.wav"))?;
                std::fs::write(out.join("native-probes.json"),serde_json::to_vec_pretty(&vec![initial_value,policy_value,resized_value])?)?;
                std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&json!({"platformUnavailablePolicy":true,"publicationWorkflowExercised":false,"actualDisabledMonitorClick":true,"headphonesConfirmed":true,"noNativeLeaseAcquired":true,"hardwareMonitoringQualified":false,"reason":crate::i18n::t("settings.monitor.routePlatformUnavailable"),"policyScope":"Production Windows/Linux monitoring platform-unavailable policy only; real monitoring, publication while monitoring, Stop restoration and native advancement are not exercised","epoch":epoch,"originalHelperPid":pid,"workingDir":working,"workingMetadataSha256":hash(&working_metadata),"rawSourceSha256":hash(std::fs::read(&raw)?),"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"productionParity":"not evaluated","liveFps":"unmeasured"}))?)?;
                return Ok(());
            }
            wait!(15,p,w,a=>p.monitor_parked&&p.mic_view.phase==microphone::Phase::Monitoring&&p.mic_view.owner==3&&p.monitor_pending.is_none());
            let (generation,sequence)=handle.update(cx,|_,_,a|{let p=view.read(a);(p.mic_view.generation,p.mic_view.sequence)})?;
            wait!(5,p,w,a=>active(p,epoch,generation)&&p.mic_view.sequence>sequence);
            handle.update(cx,|_,w,a|{draw(w,a);w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),a);})?;
            wait!(5,p,w,a=>p.screen==Screen::Player&&active(p,epoch,generation));
            shot!("monitor-before-save-1280");
            let mut probes=vec![initial_value];
            let parked=probe!();
            anyhow::ensure!(parked.helper_pid==pid&&parked.epoch==epoch&&parked.monitor_leased&&parked.status.parked&&parked.status.physical_output_released&&!parked.status.playing,"Monitor failed real playback park");probes.push(probe_value(&parked,"before-save"));
            let sequence_before_save=handle.update(cx,|_,_,a|view.read(a).mic_view.sequence)?;
            header!("save");
            let deadline=Instant::now()+Duration::from_secs(60);
            loop {
                let proof=probe!();
                anyhow::ensure!(proof.helper_pid==pid&&proof.epoch==epoch&&proof.monitor_leased&&proof.status.parked&&proof.status.physical_output_released&&!proof.status.playing&&proof.active_training.is_none(),"Save reacquired native playback output or replaced helper");
                probes.push(probe_value(&proof,"save"));
                let done=handle.update(cx,|_,w,a|->anyhow::Result<bool>{draw(w,a);let p=view.read(a);anyhow::ensure!(active(p,epoch,generation),"Save disturbed native monitor: {}",snapshot(&view,w,a));Ok(!p.loading&&!p.saving&&p.source_job.is_none()&&p.source_publication.is_none()&&!p.source_working&&p.project.as_ref().is_some_and(|v|v.dir!=working&&v.dir.starts_with(&library))&&p.edit_seq==p.saved_seq)})??;
                if done {break;}anyhow::ensure!(Instant::now()<deadline,"Monitored publication timed out");cx.background_executor().timer(Duration::from_millis(30)).await;
            }
            wait!(5,p,w,a=>active(p,epoch,generation)&&p.monitor_publication_epoch==Some(epoch)&&p.tracks_audio_failed&&p.audio_recovery.is_none()&&p.mic_view.sequence>sequence_before_save);
            let published=handle.update(cx,|_,_,a|view.read(a).project.as_ref().unwrap().dir.clone())?;
            let metadata=std::fs::read(published.join("project.json"))?;let saved:Value=serde_json::from_slice(&metadata)?;
            let settings=&saved["settings"];
            anyhow::ensure!(settings["tempo"]==0.8&&settings["transpose"]==-2&&settings["masterVolume"]==0.6&&settings["loop"]==true,"Persisted mix differs: {saved}");
            let media=published.join(saved["songFile"].as_str().context("Missing saved original")?);
            let media_hash=hash(std::fs::read(&media)?);anyhow::ensure!(media_hash==hash(std::fs::read(&raw)?),"Published audio changed");
            handle.update(cx,|_,_,a|->anyhow::Result<()>{let p=view.read(a);let project=p.project.as_ref().unwrap();anyhow::ensure!(project.metadata_hash==hash(&metadata)&&project.selection.is_some_and(|(s,e)|s==0.&&(e-p.duration).abs()<0.03),"Adopted metadata/loop differs from publication");Ok(())})??;
            std::fs::write(out.join("published-project.json"),&metadata)?;
            std::fs::copy(&media,out.join("published-original.wav"))?;
            shot!("monitor-published-1280");
            handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;
            wait!(5,p,w,a=>w.viewport_size()==size(px(1060.),px(640.))&&active(p,epoch,generation));shot!("monitor-published-1060");
            if adapter {
                // Held-controller-state adapter only: no real second writer is started.
                // The actual raw publication above is complete before this hold.
                handle.update(cx,|_,_,a|view.update(a,|p,a|{p.saving=true;a.notify();}))?;
                handle.update(cx,|_,w,a|->anyhow::Result<()>{
                    header_control(&view,w,a,"monitor-stop")?;
                    view.update(a,|p,a|->anyhow::Result<()>{
                        anyhow::ensure!(p.monitor_busy(),"Actual Stop cleanup completed before synchronous controller intent");
                        p.select_output("".into(),a);
                        anyhow::ensure!(p.monitor_actions.len()==1&&matches!(p.monitor_actions.front(),Some(DeferredAudio::Output(uid)) if uid.is_empty()),"Default Output was not queued exactly once during Stop cleanup");
                        Ok(())
                    })
                })??;
                wait!(15,p,w,a=>p.native_epoch==epoch&&!p.monitor_busy()&&p.monitor_pending.is_none()&&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.saving&&p.monitor_actions.len()==1&&matches!(p.monitor_actions.front(),Some(DeferredAudio::Output(uid)) if uid.is_empty())&&p.monitor_publication_epoch==Some(epoch)&&p.audio_recovery.is_none()&&p.tracks_audio_failed&&p.notice.is_none()&&!p.playing);
                let held=probe!();let held_value=probe_value(&held,"stop-held-saving-adapter");
                anyhow::ensure!(held.helper_pid==pid&&!held.monitor_leased&&!held.status.parked&&!held.status.playing,"Held Save adapter did not release old native monitor lease");probes.push(held_value);
                shot!("monitor-stop-held-saving-adapter-1060");
                handle.update(cx,|_,w,a|->anyhow::Result<()>{draw(w,a);let p=view.read(a);anyhow::ensure!(p.saving&&p.monitor_actions.len()==1&&matches!(p.monitor_actions.front(),Some(DeferredAudio::Output(uid)) if uid.is_empty())&&p.monitor_publication_epoch==Some(epoch)&&p.audio_recovery.is_none()&&p.tracks_audio_failed,"A draw lost deferred recovery while Save held");view.update(a,|p,a|{p.saving=false;a.notify();});Ok(())})??;
            } else {
                header!("monitor-stop");
            }
            wait!(30,p,w,a=>p.native_epoch==epoch&&p.monitor_actions.is_empty()&&!p.monitor_busy()&&p.monitor_pending.is_none()&&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.mic_view.owner==0&&p.monitor_publication_epoch.is_none()&&p.audio_recovery.is_none()&&!p.tracks_audio_failed&&p.notice.is_none()&&!p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&!s.parked&&(s.position-2.).abs()<0.03&&(s.rate-0.8).abs()<0.0001&&s.transpose==-2&&s.loop_range==p.project.as_ref().unwrap().selection));
            let restored=probe!();let restored_value=probe_value(&restored,"stopped");let replacement_pid=restored.helper_pid;anyhow::ensure!(replacement_pid!=pid&&!restored.monitor_leased&&!restored.status.parked&&!restored.status.playing&&(restored.status.position-2.).abs()<0.03,"Stop did not replace owned helper and restore paused");probes.push(restored_value);shot!("monitor-stopped-1060");
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(5,p,w,a=>w.viewport_size()==size(px(1280.),px(800.)));shot!("monitor-stopped-1280");
            handle.update(cx,|_,w,a|->anyhow::Result<()>{draw(w,a);let b=view.read(a).transport.read(a).bounds("transport-play").context("Play not measured")?;click(w,a,b.center());Ok(())})??;
            wait!(8,p,w,a=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>2.08));
            let from=probe!();probes.push(probe_value(&from,"playing-from"));cx.background_executor().timer(Duration::from_millis(180)).await;let to=probe!();probes.push(probe_value(&to,"playing-to"));
            anyhow::ensure!(from.helper_pid==replacement_pid&&to.helper_pid==replacement_pid&&to.status.playing&&to.status.position>from.status.position+0.04,"Explicit Play did not advance native clock");shot!("monitor-explicit-play-1280");
            std::fs::write(out.join("native-probes.json"),serde_json::to_vec_pretty(&probes)?)?;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&json!({"connectedRawPublication":true,"actualSettingsMonitor":true,"headphonesRequired":true,"actualEscape":true,"actualHeaderSave":true,"sameNativeEpoch":true,"sameMicrophoneGeneration":true,"nativeSequenceAdvanced":true,"originalHelperPid":pid,"replacementHelperPid":replacement_pid,"heldSavingStateAdapter":adapter,"automaticHeaderStopRecovery":!adapter,"concurrentSecondWriterExercised":false,"stopRecoveryAdapterScope":if adapter {ADAPTER_SCOPE}else{PRIMARY_SCOPE},"explicitOutputQueuedDuringCleanup":adapter,"actualOutputSelectorExercised":false,"nativeLeaseHeldThroughoutSave":true,"adoptedExactPublication":true,"deferredUntilHeaderStop":true,"actualHeaderStop":true,"stopReleasesInput":true,"stopRecoversPaused":true,"explicitPlay":true,"epoch":epoch,"generation":generation,"publishedDir":published,"publishedMetadataSha256":hash(&metadata),"publishedAudioSha256":media_hash,"nativeAdvance":{"from":from.status.position,"to":to.status.position},"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"hardwareMonitoringQualified":false,"productionParity":"not evaluated","liveFps":"unmeasured"}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("NATIVE_MONITOR_PUBLICATION passed");let _=cx.update(|a|a.quit());},Err(error)=>{eprintln!("NATIVE_MONITOR_PUBLICATION failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,a|capture(&view,w,a,&out,"failure"));let _=view.update(cx,|p,_|{p.microphone.take();p.source_service.take();p.backend.take();});std::process::exit(1);}}
    }).detach();
}

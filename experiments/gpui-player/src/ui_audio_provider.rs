//! Windows-only, hidden acceptance through production controls and real workers.
//! No provider, owner, focus or project state is assigned by this adapter.
use super::*;
use crate::audio_devices::Provider;
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
    let mut visited: Vec<String> = Vec::new();
    for _ in 0..192 {
        draw(w, cx);
        let focused = view.read(cx).header.read(cx).focused_control(w);
        if focused.as_deref() == Some(id) {
            key(w, cx, "enter");
            return Ok(());
        }
        if let Some(name) = focused {
            if visited.last() != Some(&name) { visited.push(name); }
        }
        key(w, cx, "tab");
    }
    let (root, any) = (view.read(cx).focus_handle.is_focused(w), w.focused(cx).is_some());
    anyhow::bail!("Actual Header Tab cannot reach {id}; header controls focused in order: {visited:?}; screen {:?}; player root focused {root}; any focus {any}", view.read(cx).screen as u8)
}
fn setting(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..128 {
        draw(w, cx);
        if view.read(cx).settings.read(cx).focused_control(w, cx) == Some(id) {
            key(w, cx, "enter");
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Settings Tab cannot reach {id}")
}
fn provider_click(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    option: Option<usize>,
) -> anyhow::Result<()> {
    draw(w, cx);
    let screen = view.read(cx).settings.read(cx);
    let b = match option {
        Some(i) => screen.option_bounds("settings-provider", i),
        None => screen.field_bounds("settings-provider"),
    }
    .ok_or_else(|| anyhow::anyhow!("Provider control is not measured: {option:?}"))?;
    anyhow::ensure!(
        b.left() >= px(0.)
            && b.top() >= px(52.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Provider control clipped: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn library(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    dir: &Path,
    delete: bool,
) -> anyhow::Result<()> {
    for _ in 0..8 {
        draw(w, cx);
        if let Some(b) = view.read(cx).library.read(cx).project_delete_bounds(dir) {
            if b.top() >= px(52.) && b.bottom() <= w.viewport_size().height {
                click(
                    w,
                    cx,
                    if delete {
                        b.center()
                    } else {
                        point(b.left() - px(48.), b.center().y)
                    },
                );
                return Ok(());
            }
        }
        w.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    w.viewport_size().width / 2.,
                    w.viewport_size().height - px(90.),
                ),
                delta: ScrollDelta::Pixels(point(px(0.), px(-600.))),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("Actual library target is not visible: {}", dir.display())
}
fn transport(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .bounds("transport-play")
        .ok_or_else(|| anyhow::anyhow!("Play is unmeasured"))?;
    click(w, cx, b.center());
    Ok(())
}
fn prefs() -> anyhow::Result<Vec<u8>> {
    Ok(std::fs::read(
        crate::audio_devices::directory().join("audio.json"),
    )?)
}
fn native(s: &integration::Status) -> serde_json::Value {
    serde_json::json!({"provider":s.observed_provider,"backendProvider":s.observed_backend_provider,"fixture":s.observed_fixture,
        "generation":s.graph_generation,"state":s.state,"transportState":s.transport_state,"playing":s.playing,"position":s.position,
        "outputUid":s.output_uid,"parked":s.parked,"physicalOutputReleased":s.physical_output_released,"sampleAgeSeconds":s.sampled_at.elapsed().as_secs_f64()})
}
fn state(p: &Player, w: &Window, cx: &App, phase: &str) -> serde_json::Value {
    serde_json::json!({"phase":phase,"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),"scale":w.scale_factor(),
        "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"provider":p.settings.read(cx).provider_ui_state(w),
        "snapshot":p.audio_provider,"providerSerial":p.provider_flight.audio_provider.serial(),"nativeEpoch":p.native_epoch,"project":p.project.as_ref().map(|s|&s.dir),
        "loadedSong":p.loaded_song,"loading":p.loading,"playing":p.playing,"position":p.playhead.position(),"native":p.last_playback_status.as_ref().map(native),
        "notice":p.notice,"capture":{"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"fixture":p.mic_view.fixture},
        "preferences":prefs().ok().and_then(|v|serde_json::from_slice::<serde_json::Value>(&v).ok()),"liveFps":"unmeasured"})
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Provider capture activated window"
    );
    let mut value = state(view.read(cx), w, cx, name);
    let image = w.render_to_image()?;
    anyhow::ensure!(
        image.width() == (f32::from(w.viewport_size().width) * w.scale_factor()).round() as u32
            && image.height()
                == (f32::from(w.viewport_size().height) * w.scale_factor()).round() as u32,
        "Provider raster dimensions do not match actual viewport/scale"
    );
    value["raster"] = serde_json::json!([image.width(), image.height()]);
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}
fn assert_native(s: &integration::Status) -> anyhow::Result<()> {
    anyhow::ensure!(
        s.observed_provider.as_deref() == Some("wasapi")
            && s.observed_backend_provider.as_deref() == Some("wasapi")
            && s.observed_fixture == Some(false)
            && s.output_uid.starts_with("wasapi:"),
        "Accepted native status is not actual WASAPI: {}",
        native(s)
    );
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(cfg!(windows),"Provider acceptance requires actual Windows; no synthetic availability allowed");
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Ok("1"),"Provider acceptance requires hidden/muted/no-capture isolation");
            std::fs::create_dir_all(&out)?;
            let restart=std::env::var("SINGZ_GPUI_AUDIO_PROVIDER_RESTART").as_deref()==Ok("1");
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_PROJECTS_ROOT").ok_or_else(||anyhow::anyhow!("Missing private library"))?).canonicalize()?;
            let mut steps=vec![];let mut probes=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active(),"Provider window became visible/active");
                        anyhow::ensure!($p.mic_view.owner==0&&$p.mic_intent.is_none()&&!$p.monitor_busy(),"Provider journey acquired capture/monitor");
                        Ok($condition)})?? {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Provider timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! action {($w:ident,$app:ident => $body:expr)=>{handle.update(cx,|_,$w,$app|->anyhow::Result<()>{$body})??};}
            macro_rules! shot {($name:expr)=>{{let name=$name;handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&name))??;steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,&name))?);}};}
            wait!(20,p,w,app => p.backend.is_some()&&p.audio_provider.as_ref().is_some_and(|s|s.availability.is_some()&&s.can_change)&&p.language_state.is_some());
            handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                let p=view.read(cx);let s=p.audio_provider.as_ref().unwrap();let a=s.availability.as_ref().unwrap();
                anyhow::ensure!(a.platform=="win32"&&a.providers.iter().any(|r|r.id==Provider::Wasapi&&r.available&&r.compiled)
                    &&a.providers.iter().any(|r|r.id==Provider::Asio&&!r.available&&!r.detail.is_empty()),"Actual Windows availability differs: {a:?}");
                anyhow::ensure!(s.selected==if restart{Provider::Wasapi}else{Provider::Asio}&&p.project.is_none()&&p.last_playback_status.is_none(),"Startup selected a fallback or audio owner");
                let _=w;Ok(())
            })??;
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(8,p,w,app => w.viewport_size()==size(px(width),px(height)));
                let dir=root.join(format!("provider-{}",width as u32));
                if !restart&&width==1280. {
                    super::ui_training_run::settle_whats_new(handle,&view,cx).await?;
                    wait!(12,p,w,app => p.library.read(app).project_delete_bounds(&dir).is_some());
                    let before=prefs()?;
                    action!(w,app => library(&view,w,app,&dir,false));
                    wait!(15,p,w,app => !p.loading&&p.notice.is_some());
                    action!(w,app => {let p=view.read(app);anyhow::ensure!(p.project.is_none()&&!p.loaded_song&&p.last_playback_status.is_none()
                        &&p.audio_provider.as_ref().is_some_and(|s|s.selected==Provider::Asio)&&prefs()?==before,"Unavailable ASIO silently fell back");
                        let detail=&p.audio_provider.as_ref().unwrap().availability.as_ref().unwrap().providers.iter().find(|s|s.id==Provider::Asio).unwrap().detail;
                        anyhow::ensure!(!detail.is_empty()&&p.notice.as_ref().is_some_and(|notice|notice.contains(detail)),"Unavailable Open failed for a different reason: {:?}; expected {detail}",p.notice);Ok(())});
                    shot!(format!("unavailable-open-{width:.0}"));
                    action!(w,app => {key(w,app,"escape");Ok(())});
                    wait!(8,p,w,app => p.notice.is_none());
                }
                action!(w,app => header(&view,w,app,"header-settings"));
                wait!(8,p,w,app => p.screen==Screen::Settings&&p.settings.read(app).provider_ui_state(w)["enabled"]==true);
                shot!(format!("{}-{width:.0}",if restart{"restart"}else{"unloaded"}));
                let same_before=prefs()?;
                let serial_before=handle.update(cx,|_,_,cx|view.read(cx).provider_flight.audio_provider.serial())?;
                let previous=handle.update(cx,|_,_,cx|view.read(cx).audio_provider.clone().unwrap())?;
                let changing=previous.selected!=Provider::Wasapi;
                action!(w,app => setting(&view,w,app,"settings-provider"));
                action!(w,app => {
                    draw(w,app);let value=view.read(app).settings.read(app).provider_ui_state(w);
                    anyhow::ensure!(value["openField"]=="settings-provider"&&value["options"][0]["disabled"]==false&&value["options"][1]["disabled"]==true,"Actual provider menu availability differs: {value}");
                    for stroke in ["home","down","end","up"] {key(w,app,stroke);draw(w,app);
                        anyhow::ensure!(view.read(app).settings.read(app).provider_ui_state(w)["menuIndex"]==0,"Disabled ASIO received keyboard selection");}
                    Ok(())
                });
                shot!(format!("menu-{width:.0}"));
                action!(w,app => provider_click(&view,w,app,Some(1)));
                action!(w,app => {anyhow::ensure!(view.read(app).settings.read(app).provider_ui_state(w)["openField"]=="settings-provider"&&prefs()?==same_before,"Disabled ASIO pointer committed");key(w,app,"enter");Ok(())});
                wait!(12,p,w,app => p.provider_flight.audio_provider.is_none()&&p.audio_provider.as_ref().is_some_and(|s|s.selected==Provider::Wasapi&&(!changing||s.error.is_none())));
                let committed=prefs()?;
                action!(w,app => {let raw:serde_json::Value=serde_json::from_slice(&committed)?;anyhow::ensure!(raw["nativeAudioProvider"]=="wasapi"&&raw["outputUid"]=="","Provider commit did not clear incompatible output");
                    if !changing {anyhow::ensure!(committed==same_before&&view.read(app).provider_flight.audio_provider.serial()==serial_before
                        &&view.read(app).audio_provider.as_ref().unwrap().request==previous.request,"Same-provider keyboard choice wrote preferences/request");}Ok(())});
                let serial=handle.update(cx,|_,_,app|view.read(app).provider_flight.audio_provider.serial())?;
                action!(w,app => {provider_click(&view,w,app,None)?;provider_click(&view,w,app,Some(0))?;Ok(())});
                cx.background_executor().timer(Duration::from_millis(250)).await;
                action!(w,app => {anyhow::ensure!(prefs()?==committed&&view.read(app).provider_flight.audio_provider.serial()==serial,"Same-provider pointer wrote preferences/request");Ok(())});
                shot!(format!("wasapi-{width:.0}"));
                action!(w,app => setting(&view,w,app,"settings-close"));
                if restart {continue;}
                action!(w,app => library(&view,w,app,&dir,false));
                wait!(20,p,w,app => !p.loading&&p.loaded_song&&p.project.as_ref().is_some_and(|s|s.dir==dir)&&p.last_playback_status.is_some());
                action!(w,app => {anyhow::ensure!(view.read(app).notice.is_none(),"Normal Open failed");assert_native(view.read(app).last_playback_status.as_ref().unwrap())});
                action!(w,app => transport(&view,w,app));
                wait!(8,p,w,app => p.playing&&p.playhead.position()>0.2&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                action!(w,app => header(&view,w,app,"header-settings"));
                wait!(8,p,w,app => p.screen==Screen::Settings&&p.settings.read(app).provider_ui_state(w)["enabled"]==false);
                let (epoch,generation,start_position)=handle.update(cx,|_,_,app|{let p=view.read(app);(p.native_epoch,p.last_playback_status.as_ref().unwrap().graph_generation,p.playhead.position())})?;
                action!(w,app => {provider_click(&view,w,app,None)?;let v=view.read(app).settings.read(app).provider_ui_state(w);anyhow::ensure!(v["openField"]!="settings-provider"&&v["rendererBusy"]==true&&!view.read(app).audio_provider.as_ref().unwrap().can_change,"Loaded provider control accepted input");Ok(())});
                shot!(format!("playing-disabled-{width:.0}"));
                let receiver=handle.update(cx,|_,_,app|view.read(app).backend.as_ref().unwrap().probe_owned_audio(epoch))??;
                let deadline=Instant::now()+Duration::from_secs(8);
                let baseline=loop {match receiver.try_recv(){Ok(value)=>break value.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Baseline owned audio probe disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}
                    anyhow::ensure!(Instant::now()<deadline,"Baseline owned audio probe timeout");cx.background_executor().timer(Duration::from_millis(20)).await;};
                assert_native(&baseline.status)?;
                anyhow::ensure!(baseline.epoch==epoch&&baseline.helper_pid>0&&baseline.status.graph_generation==generation&&baseline.status.playing,"Invalid actual owned baseline");
                // Explicit negative controls enter the SAME worker with its real
                // owner state. They never assign Settings/renderer/connection state.
                for (index,provider) in [Provider::Wasapi,Provider::Asio].into_iter().enumerate() {
                    let request=10000+width as u64+index as u64;
                    handle.update(cx,|_,_,app|->anyhow::Result<()> {let p=view.read(app);let s=p.audio_provider.as_ref().unwrap();
                        p.backend.as_ref().unwrap().probe_provider_worker(request,s.revision,s.epoch,provider)})??;
                    wait!(12,p,w,app => p.audio_provider.as_ref().is_some_and(|s|s.request==request&&s.error.is_some()));
                    action!(w,app => {let p=view.read(app);anyhow::ensure!(p.audio_provider.as_ref().unwrap().selected==Provider::Wasapi&&p.native_epoch==epoch
                        &&p.playing&&prefs()?==committed,"Worker refusal changed provider/preferences/transport");
                        let snapshot=p.audio_provider.as_ref().unwrap();let error=snapshot.error.as_deref().unwrap();
                        let expected=if provider==Provider::Wasapi {"Audio provider eligibility changed before preference publication"}
                            else {snapshot.availability.as_ref().unwrap().providers.iter().find(|s|s.id==Provider::Asio).unwrap().detail.as_str()};
                        anyhow::ensure!(!expected.is_empty()&&error.contains(expected),"Worker negative control failed at the wrong gate: {error}; expected {expected}");
                        assert_native(p.last_playback_status.as_ref().unwrap())});
                    probes.push(handle.update(cx,|_,w,app|state(view.read(app),w,app,&format!("worker-refused-{}",provider.as_str())))?);
                }
                let receiver=handle.update(cx,|_,_,app|view.read(app).backend.as_ref().unwrap().probe_owned_audio(epoch))??;
                let deadline=Instant::now()+Duration::from_secs(8);
                let owned=loop {match receiver.try_recv(){Ok(value)=>break value.map_err(anyhow::Error::msg)?,Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Owned audio probe disconnected"),Err(std::sync::mpsc::TryRecvError::Empty)=>{}}
                    anyhow::ensure!(Instant::now()<deadline,"Owned audio probe timeout");cx.background_executor().timer(Duration::from_millis(20)).await;};
                assert_native(&owned.status)?;
                anyhow::ensure!(owned.epoch==epoch&&owned.helper_pid==baseline.helper_pid&&!owned.monitor_leased&&owned.active_training.is_none()
                    &&owned.status.graph_generation==generation&&owned.status.playing&&owned.status.position>start_position&&owned.status.position>baseline.status.position
                    &&owned.status.sampled_at>baseline.status.sampled_at,"Worker refusal replaced or stopped owned native playback");
                probes.push(serde_json::json!({"phase":"owned-after-refusals","epoch":owned.epoch,"helperPid":owned.helper_pid,"baselineHelperPid":baseline.helper_pid,
                    "baselineNative":native(&baseline.status),"native":native(&owned.status)}));
                action!(w,app => setting(&view,w,app,"settings-close"));
                action!(w,app => transport(&view,w,app));
                wait!(8,p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                action!(w,app => header(&view,w,app,"header-settings"));
                wait!(8,p,w,app => p.screen==Screen::Settings&&p.settings.read(app).provider_ui_state(w)["enabled"]==false);
                action!(w,app => {provider_click(&view,w,app,None)?;anyhow::ensure!(view.read(app).settings.read(app).provider_ui_state(w)["openField"]!="settings-provider"&&prefs()?==committed,"Paused owner allowed provider change");Ok(())});
                shot!(format!("paused-disabled-{width:.0}"));
                action!(w,app => setting(&view,w,app,"settings-close"));
                action!(w,app => header(&view,w,app,"header-catalog"));
                wait!(8,p,w,app => p.screen==Screen::Library);
                action!(w,app => library(&view,w,app,&dir,true));
                wait!(8,p,w,app => p.delete_flight.delete_inspect.is_none()&&p.project_delete.read(app).is_open());
                action!(w,app => {draw(w,app);let b=view.read(app).project_delete.read(app).bounds("project-delete-confirm").ok_or_else(||anyhow::anyhow!("Actual Delete confirmation unmeasured"))?;click(w,app,b.center());Ok(())});
                wait!(15,p,w,app => p.delete_flight.delete.is_none()&&!p.project_delete.read(app).is_open()&&!dir.exists()&&p.project.is_none()&&!p.loaded_song);
                wait!(12,p,w,app => p.audio_provider.as_ref().is_some_and(|s|s.can_change&&s.epoch==p.native_epoch));
                action!(w,app => header(&view,w,app,"header-settings"));
                wait!(8,p,w,app => p.settings.read(app).provider_ui_state(w)["enabled"]==true);
                shot!(format!("retired-reenabled-{width:.0}"));
                action!(w,app => setting(&view,w,app,"settings-close"));
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"restart":restart,"actualWindows":true,"hidden":true,"muted":true,
                "actualControls":true,"hardwareInput":false,"fixtureBackend":false,"steps":steps,"probes":probes,"liveFps":"unmeasured",
                "scope":"Actual native Windows availability, provider preference and worker ownership; physical audible output and visual parity remain unqualified"}))?)?;Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("AUDIO_PROVIDER passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{
            eprintln!("AUDIO_PROVIDER failed: {error:#}");let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"failure"));let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);
        }}
    }).detach();
}

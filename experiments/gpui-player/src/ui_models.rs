//! Hidden input + real curl/tar installer against a loopback fixture server.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::PathBuf, time::Duration};
fn button(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    for _ in 0..6 {
        draw(window, cx);
        let b = view
            .read(cx)
            .models
            .read(cx)
            .bounds(id)
            .ok_or_else(|| anyhow::anyhow!("Missing {id}"))?;
        if b.top() >= px(45.) && b.bottom() <= window.viewport_size().height - px(35.) {
            click(window, cx, b.center());
            return Ok(());
        }
        window.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(
                    window.viewport_size().width / 2.,
                    window.viewport_size().height / 2.,
                ),
                delta: ScrollDelta::Pixels(point(
                    px(0.),
                    if b.top() < px(45.) {
                        px(350.)
                    } else {
                        px(-350.)
                    },
                )),
                ..Default::default()
            }),
            cx,
        );
    }
    anyhow::bail!("{id} remains outside the modal viewport")
}
fn key(window:&mut Window,cx:&mut App,name:&'static str) {
    let stroke=Keystroke::parse(name).unwrap();window.dispatch_keystroke(stroke.clone(),cx);
    window.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn keyboard_state(view:&Entity<Player>,window:&mut Window,cx:&mut App,step:&str)->anyhow::Result<serde_json::Value> {
    draw(window,cx);anyhow::ensure!(!window.is_visible()&&!window.is_window_active(),"Models keyboard test activated window");
    let p=view.read(cx);let state=p.models.read(cx).keyboard_snapshot(window,cx);
    if p.screen==Screen::Models {
        anyhow::ensure!(state["focusInside"]==true,"Models focus escaped at {step}: {state}");
        if let Some(bounds)=state["focusedBounds"].as_array(){
            let top=bounds[1].as_f64().unwrap();let bottom=top+bounds[3].as_f64().unwrap();
            let viewport=state["viewportBounds"].as_array().unwrap();let start=viewport[1].as_f64().unwrap();let end=start+viewport[3].as_f64().unwrap();
            anyhow::ensure!(top>=start-1.&&bottom<=end+1.&&top>=0.&&bottom<=f32::from(window.viewport_size().height) as f64,"Models focus clipped at {step}: {state}");
        }else{anyhow::ensure!(state["focusedControl"].is_null(),"Models focused control has no bounds: {state}");}
    }
    Ok(serde_json::json!({"step":step,"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],"keyboard":state,"screen":p.screen as u8,"hidden":true,"active":false}))
}
fn keyboard_capture(view:&Entity<Player>,window:&mut Window,cx:&mut App,out:&std::path::Path,name:&str)->anyhow::Result<()> {
    let mut state=keyboard_state(view,window,cx,name)?;let image=window.render_to_image()?;
    state["scale"]=serde_json::json!(window.scale_factor());state["raster"]=serde_json::json!([image.width(),image.height()]);
    image.save(out.join(format!("{name}.png")))?;std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&state)?)?;Ok(())
}
fn tab_to(view:&Entity<Player>,window:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..32 {draw(window,cx);if view.read(cx).models.read(cx).focused_control(window,cx).as_deref()==Some(id){return Ok(());}key(window,cx,"tab");let _=keyboard_state(view,window,cx,"Tab traversal")?;}
    anyhow::bail!("Actual Tab did not reach {id}: {:?}",view.read(cx).models.read(cx).keyboard_snapshot(window,cx))
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            handle.update(cx,|_,window,_|window.resize(size(px(1280.),px(800.))))?;
            let control=PathBuf::from(std::env::var_os("SINGZ_GPUI_MODEL_CONTROL").unwrap());
            let keyboard=std::env::var_os("SINGZ_GPUI_MODELS_KEYBOARD_TEST").is_some();let mut keyboard_steps=Vec::new();
            macro_rules! wait { ($predicate:expr) => {{
                let deadline=Instant::now()+Duration::from_secs(20);
                loop {cx.background_executor().timer(Duration::from_millis(25)).await;
                    let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);let s=p.models.read(cx).snapshot.clone();($predicate)(&s)})?;
                    if ready {break;}anyhow::ensure!(Instant::now()<deadline,"Model state timeout: {}",stringify!($predicate));
                }
            }}; }
            macro_rules! press { ($id:expr) => {{
                cx.background_executor().timer(Duration::from_millis(100)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    if keyboard {
                        tab_to(&view,w,cx,$id)?;
                        key(w,cx,if $id=="model-close"||$id=="model-retry"||$id=="model-mode-CPU"{"space"}else{"enter"});
                    } else { button(&view,w,cx,$id)?; }
                    Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                if keyboard { keyboard_steps.push(handle.update(cx,|_,w,cx|keyboard_state(&view,w,cx,$id))??); }
            }}; }
            macro_rules! capture { ($name:expr) => {handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Model capture activated window");
                let p=view.read(cx);let state=p.models.read(cx);
                if $name=="failed-reinstall-1280.png" {anyhow::ensure!(!state.snapshot.busy&&state.snapshot.error.is_some(),"Failed reinstall capture did not show accepted error");}
                let expected=std::env::var("SINGZ_LANG").ok().and_then(|tag|i18n::from_tag(&tag)).unwrap_or(i18n::Locale::En);
                anyhow::ensure!(p.language_state.is_some_and(|s|s.locale==expected)&&i18n::current()==expected,"Model capture preceded accepted locale");
                let copy=serde_json::json!({"locale":i18n::current().as_str(),"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":true,"busy":state.snapshot.busy,"error":state.snapshot.error,"revision":state.snapshot.revision,"title":i18n::t(if state.origin==models::Origin::Auto {"settings.wizard.settingUpTitle"} else {"settings.wizard.aiModelsTitle"}),"rows":state.snapshot.rows.iter().map(|r|serde_json::json!({"id":r.entry.id,"label":models::model_label(&r.entry),"description":models::model_description(&r.entry,state.snapshot.windows)})).collect::<Vec<_>>()});
                w.render_to_image()?.save(out.join($name))?;std::fs::write(out.join($name).with_extension("json"),serde_json::to_vec_pretty(&copy)?)?;Ok(())})??}; }
            wait!(|s:&model_service::Snapshot|s.loaded);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Manual,cx)))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            if std::env::var_os("SINGZ_GPUI_MODELS_RESTART").is_some() {
                wait!(|s:&model_service::Snapshot|s.rows.len()==3&&s.rows.iter().all(|r|r.present)&&s.cpu_only&&!s.busy);
                capture!("restored-1280.png");
                press!("model-close");
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Auto,cx)))?;
                let deadline=Instant::now()+Duration::from_secs(5);
                loop {
                    cx.background_executor().timer(Duration::from_millis(25)).await;
                    if handle.update(cx,|_,_,cx|view.read(cx).screen!=Screen::Models)? {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Completed first-run wizard did not auto-close");
                }
                std::fs::write(out.join("result.json"),b"{\"restartRestoresInstalledAndCpu\":true,\"automaticCompletion\":true}")?;
                return Ok(());
            }
            capture!("missing-1280.png");
            handle.update(cx,|_,w,cx|{
                w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);
                click(w,cx,point(px(30.),px(100.)));
                anyhow::ensure!(view.read(cx).screen==Screen::Models,"Persistent wizard dismissed by Escape/scrim");Ok::<_,anyhow::Error>(())
            })??;
            // Manual close cancels an actual in-flight curl and leaves no installation.
            std::fs::write(&control,"slow")?;press!("model-get-gpu-splitter");
            wait!(|s:&model_service::Snapshot|s.busy);
            if keyboard {handle.update(cx,|_,w,cx|->anyhow::Result<()>{let state=keyboard_state(&view,w,cx,"actual-download-disables-Get")?;anyhow::ensure!(state["keyboard"]["focusedControl"].is_null()&&state["keyboard"]["focusInside"]==true,"Downloading Get kept dead focus");Ok(())})??;}
            capture!("downloading-1280.png");press!("model-close");
            wait!(|s:&model_service::Snapshot|!s.busy);
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen!=Screen::Models&&!p.model_service.as_ref().unwrap().snapshot().rows[0].present,"Cancelled pack installed");Ok(())})??;
            // Auto Skip keeps the very same worker alive behind the main screen.
            std::fs::write(&control,"good")?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Auto,cx)))?;
            wait!(|s:&model_service::Snapshot|s.busy);press!("model-close");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.rows[0].present);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Manual,cx)))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            // An obsolete pack is refused without replacing the working format-10 pack.
            std::fs::write(&control,"old")?;press!("model-get-gpu-splitter");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_some());
            capture!("failed-reinstall-1280.png");
            wait!(|s:&model_service::Snapshot|s.rows[0].present);
            std::fs::write(&control,"good")?;press!("model-retry");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_none()&&s.rows[0].present);
            // Qwen has one cached part; download the other two and change CPU mode while busy.
            std::fs::write(&control,"slow")?;press!("model-get-qwen-asr");
            wait!(|s:&model_service::Snapshot|s.busy);press!("model-mode-CPU");
            wait!(|s:&model_service::Snapshot|s.busy&&s.cpu_only);
            capture!("multipart-cpu-1280.png");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.rows[1].present);
            // Truncation on part two must preserve all three working files as a group.
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap());
            let files=["one.gguf","two.gguf","three.gguf"];
            let before:Vec<_>=files.iter().map(|f|std::fs::read(root.join("models").join(f))).collect::<std::io::Result<_>>()?;
            std::fs::write(&control,"truncated")?;press!("model-get-qwen-asr");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_some());
            for (f,bytes) in files.iter().zip(&before){anyhow::ensure!(std::fs::read(root.join("models").join(f))?==*bytes,"Failed multipart reinstall replaced {f}");}
            std::fs::write(&control,"good")?;press!("model-retry");
            wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_none()&&s.rows[1].present);
            press!("model-get-aligner");wait!(|s:&model_service::Snapshot|!s.busy&&s.rows.iter().all(|r|r.present));
            capture!("installed-1280.png");
            handle.update(cx,|_,w,cx|{w.resize(size(px(1060.),px(640.)));view.read(cx).models.clone().update(cx,|m,cx|m.on_open(models::Origin::Manual,cx));})?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            capture!("installed-1060.png");press!("model-close");
            if keyboard {
                for (width,height) in [(1280.,800.),(1060.,640.)] {
                    handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|p.open_models(models::Origin::Manual,cx));})?;
                    cx.background_executor().timer(Duration::from_millis(100)).await;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{tab_to(&view,w,cx,"model-get-aligner")?;let state=view.read(cx).models.read(cx).keyboard_snapshot(w,cx);let order=state["focusOrder"].as_array().unwrap();let at=order.iter().position(|v|v=="model-get-aligner").unwrap();let next=order[(at+1)%order.len()].as_str().unwrap().to_owned();key(w,cx,"tab");draw(w,cx);anyhow::ensure!(view.read(cx).models.read(cx).focused_control(w,cx).as_deref()==Some(next.as_str()),"Models Tab skipped enabled control");key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(view.read(cx).models.read(cx).focused_control(w,cx).as_deref()==Some("model-get-aligner"),"Models ShiftTab did not reverse traversal");key(w,cx,"escape");draw(w,cx);anyhow::ensure!(view.read(cx).screen==Screen::Models,"Persistent Models dismissed by keyboard Escape");Ok(())})??;
                    keyboard_steps.push(handle.update(cx,|_,w,cx|keyboard_state(&view,w,cx,"Tab-ShiftTab-persistent-Escape"))??);
                    // Windows catalog is synthetic on this host, not a Windows delivery claim.
                    press!("model-mode-GPU");wait!(|s:&model_service::Snapshot|!s.cpu_only);
                    press!("model-mode-CPU");wait!(|s:&model_service::Snapshot|s.cpu_only);
                    std::fs::write(&control,"old")?;press!("model-get-gpu-splitter");wait!(|s:&model_service::Snapshot|s.busy);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{let state=keyboard_state(&view,w,cx,"busy-Get-disabled")?;anyhow::ensure!(state["keyboard"]["focusedControl"].is_null()&&!state["keyboard"]["focusOrder"].as_array().unwrap().iter().any(|id|id.as_str().is_some_and(|id|id.starts_with("model-get-"))),"Busy Get retained focus or disabled Get stayed in Tab order");key(w,cx,"tab");draw(w,cx);anyhow::ensure!(view.read(cx).models.read(cx).focused_control(w,cx).as_deref()==Some("model-mode-GPU"),"Busy Tab did not skip all disabled Get buttons");key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(view.read(cx).models.read(cx).focused_control(w,cx).as_deref()==Some("model-close"),"Busy ShiftTab did not wrap enabled controls");Ok(())})??;
                    wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_some());
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{tab_to(&view,w,cx,"model-retry")?;keyboard_capture(&view,w,cx,&out,&format!("keyboard-error-{}",width as u32))?;Ok(())})??;
                    std::fs::write(&control,"good")?;press!("model-retry");wait!(|s:&model_service::Snapshot|!s.busy&&s.error.is_none()&&s.rows[0].present);
                    press!("model-get-aligner");wait!(|s:&model_service::Snapshot|!s.busy&&s.rows[2].present);
                    let config=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap());let manifest=config.join("gpu-splitter/python/pack.json");let working=std::fs::read(&manifest)?;
                    std::fs::write(&control,"slow")?;press!("model-get-gpu-splitter");wait!(|s:&model_service::Snapshot|s.busy);press!("model-close");wait!(|s:&model_service::Snapshot|!s.busy);
                    anyhow::ensure!(std::fs::read(&manifest)?==working,"Keyboard manual Close replaced installed pack");
                    // Explicit private-fixture preparation makes the required pack
                    // obsolete, so the real Auto service has work at both sizes.
                    std::fs::write(&manifest,b"{\"formatVersion\":9}")?;
                    handle.update(cx,|_,_,cx|view.read(cx).model_service.as_ref().unwrap().refresh())?;
                    wait!(|s:&model_service::Snapshot|!s.busy&&!s.rows[0].present);
                    std::fs::write(&control,"hold")?;
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Auto,cx)))?;wait!(|s:&model_service::Snapshot|s.busy);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{tab_to(&view,w,cx,"model-close")?;let state=keyboard_state(&view,w,cx,"automatic-Skip-in-flight")?;anyhow::ensure!(state["keyboard"]["origin"]=="Auto"||state["keyboard"]["origin"]=="auto","Expected automatic Models origin: {state}");keyboard_capture(&view,w,cx,&out,&format!("keyboard-skip-{}",width as u32))?;Ok(())})??;
                    press!("model-close");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen!=Screen::Models&&p.model_service.as_ref().unwrap().is_running(),"Keyboard Auto Skip cancelled its real worker");Ok(())})??;
                    std::fs::write(&control,"good")?;
                    wait!(|s:&model_service::Snapshot|!s.busy&&s.rows[0].present&&!s.cpu_only);
                    let restored:serde_json::Value=serde_json::from_slice(&std::fs::read(&manifest)?)?;anyhow::ensure!(restored["formatVersion"]==10,"Auto Skip worker did not restore valid pack");
                    keyboard_steps.push(handle.update(cx,|_,w,cx|keyboard_state(&view,w,cx,"automatic-Skip-worker-completed"))??);
                    // Successful pack installation intentionally resets GPU mode.
                    // Reapply CPU through actual keys for the restart check.
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Manual,cx)))?;
                    press!("model-mode-CPU");wait!(|s:&model_service::Snapshot|s.cpu_only);
                    press!("model-close");
                }
                std::fs::write(out.join("keyboard-steps.json"),serde_json::to_vec_pretty(&keyboard_steps)?)?;
                std::fs::write(out.join("keyboard-result.json"),serde_json::to_vec_pretty(&serde_json::json!({"tabAndShiftTab":true,"enterAndSpace":true,"realGetAndReinstall":true,"explicitRetry":true,"busyFocusRecovery":true,"focusedAutoscroll":true,"persistentEscape":true,"manualCloseCancels":true,"automaticSkipContinues":true,"modeControls":true,"syntheticWindowsCatalogOnly":true,"fixtureOnlyMissingPackPreparation":true,"sizes":[[1280,800],[1060,640]],"hardwareInference":false}))?)?;
            }
            // Drop/shutdown owns active subprocess cancellation too.
            std::fs::write(&control,"slow")?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_models(models::Origin::Manual,cx)))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            press!("model-get-qwen-asr");wait!(|s:&model_service::Snapshot|s.busy);
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"hidden":true,"persistent":true,"manualCancellation":true,"automaticSkipContinues":true,"packVersionRejected":true,"failedReplacementPreservesInstallation":true,"retryExplicitTarget":true,"partialMultipart":true,"modeWhileDownloading":true,"truncatedMultipartRollback":true,"allInstalled":true,"fixtureOnly":true}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("MODELS passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("MODELS failed: {error:#}");std::process::exit(1);}}
    }).detach();
}

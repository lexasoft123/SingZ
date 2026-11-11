//! Hidden native legacy engine-setup controls with real subprocess rechecks.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse(value).unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    view.read(cx).engine_setup.read(cx).state(w, cx)
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let bounds = view
        .read(cx)
        .engine_setup
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing engine setup control {id}"))?;
    anyhow::ensure!(
        bounds.size.width > px(0.)
            && bounds.size.height > px(0.)
            && bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= w.viewport_size().width
            && bounds.bottom() <= w.viewport_size().height,
        "Engine setup control {id} clipped: {bounds:?}"
    );
    click(w, cx, bounds.center());
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let bounds = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get("engine")
        .ok_or_else(|| anyhow::anyhow!("Header engine route is not measured"))?;
    click(w, cx, bounds.center());
    Ok(())
}
fn legacy_header(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    // Native exhausted discovery is needsModels=true, so this retained source
    // IPC branch requires a labelled legacy-status fixture. Rechecks below
    // still execute real configured subprocesses; no probe result is invented.
    view.update(cx, |p, cx| -> anyhow::Result<()> {
        let mut status = p
            .engine_status
            .clone()
            .ok_or_else(|| anyhow::anyhow!("Initial engine status not loaded"))?;
        status.ok = false;
        status.needs_models = false;
        status.message =
            Some("Legacy setup fixture — Re-check runs the actual native engine probe.".into());
        status.resolved = None;
        p.engine_status = Some(status);
        p.header.update(cx, |s, cx| s.set_engine(false, cx));
        Ok(())
    })?;
    header(view, w, cx)
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    expected: (f32, f32),
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        w.viewport_size() == size(px(expected.0), px(expected.1)),
        "Engine setup viewport differs from requested {expected:?}: {:?}",
        w.viewport_size()
    );
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Engine setup test presented or activated window"
    );
    let image = w.render_to_image()?;
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (expected.0 * scale).round() as u32
            && image.height() == (expected.1 * scale).round() as u32,
        "Engine setup raster does not match viewport/scale"
    );
    image.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let snapshot = serde_json::json!({"viewport":[expected.0,expected.1],"scale":scale,"setup":state(view,w,cx),"engineStatus":p.engine_status,"sourceEngineStatus":p.source_status.engine_status,"sourceEngineRevision":p.source_status.engine_revision,"headerReady":p.header.read(cx).engine_ready(),"checkPending":p.engine_setup_check,"session":p.engine_setup_session,"externalUrls":p.engine_setup_external_urls,"screen":p.screen as u8,"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"legacyRoute":"explicit bad/no-needsModels status fixture through actual header click; recheck executes actual subprocesses","visualReference":"candidate only; matched production reference absent","liveFps":"unmeasured: hidden window"});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&snapshot)?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    let clipboard = cx.read_from_clipboard();
    cx.spawn(async move|cx|{
        let mut viewport=(1280.,800.);
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;let control=PathBuf::from(std::env::var_os("SINGZ_GPUI_ENGINE_SETUP_CONTROL").ok_or_else(||anyhow::anyhow!("Missing isolated engine stage file"))?);let marker=control.with_extension("ready");
            macro_rules! wait{($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;if ready{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Engine setup timeout: {}; actual {actual}",stringify!($predicate));}}}};}
            macro_rules! press{($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! shot{($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name,viewport))??;};}
            macro_rules! manual{()=>{{handle.update(cx,|_,w,cx|legacy_header(&view,w,cx))??;wait!(p,w,app=>p.engine_setup.read(app).is_open());handle.update(cx,|_,w,cx|{view.read(cx).engine_setup.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx));draw(w,cx);})?;}};}
            macro_rules! closed{()=>{wait!(p,w,app=>!p.engine_setup.read(app).is_open());};}
            if std::env::var("SINGZ_GPUI_ENGINE_SETUP_STAGE").as_deref()==Ok("startup-recovery") {
                let argv:Vec<_>=std::env::args_os().collect();anyhow::ensure!(argv.windows(2).any(|args|args[0]=="--project"&&!Path::new(&args[1]).exists()),"Startup recovery requires actual invalid --project CLI navigation");
                handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
                wait!(p,w,app=>w.viewport_size()==size(px(1280.),px(800.))&&p.source_job.is_none()&&p.notice.is_some());
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.is_none()&&p.source_status.engine_revision==0&&p.engine_status.is_none(),"Initial engine check was not actually superseded by invalid startup Open");Ok(())})??;
                shot!("startup-open-failed");std::fs::write(&control,"failure")?;
                wait!(p,w,app=>p.source_job.is_none()&&p.source_status.engine_revision>0&&p.engine_status.is_some());
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.engine_status.as_ref().unwrap().ok&&!p.header.read(cx).engine_ready(),"Recovery probe did not publish actual missing-engine state");Ok(())})??;
                shot!("startup-probe-recovered");std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"actualInvalidStartupOpen":true,"initialProbeSuperseded":true,"idleProbeRecovery":true,"hidden":true,"muted":true}))?)?;return Ok(());
            }
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;wait!(p,w,app=>w.viewport_size()==size(px(1280.),px(800.))&&p.engine_status.is_some()&&p.source_status.revision>0);
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{{let p=view.read(cx);let status=p.engine_status.as_ref().unwrap();anyhow::ensure!(!status.ok&&status.needs_models,"Initial missing engine did not require model route: {status:?}");}header(&view,w,cx)})??;
            wait!(p,w,app=>p.screen==Screen::Models);shot!("missing-engine-models-route-1280");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let bounds=view.read(cx).models.read(cx).bounds("model-close").ok_or_else(||anyhow::anyhow!("Model close control absent"))?;click(w,cx,bounds.center());Ok(())})??;
            wait!(p,w,app=>p.screen!=Screen::Models);
            let mut timing=vec![];
            for (width,height) in [(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));viewport=(width,height);manual!();
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Engine setup failed initial focus");Ok(())})??;shot!(&format!("initial-{}",width as u32));
                let order=handle.update(cx,|_,w,cx|->anyhow::Result<Vec<String>>{let mut order=vec![state(&view,w,cx)["focusedControl"].as_str().unwrap_or("").into()];for _ in 0..8{key(w,cx,"tab");draw(w,cx);let actual=state(&view,w,cx);anyhow::ensure!(actual["focusInside"]==true,"Tab escaped engine setup: {actual}");order.push(actual["focusedControl"].as_str().unwrap_or("").into());}key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusedControl"]=="engine-setup-close","Reverse Tab did not wrap to Close");Ok(order)})??;
                std::fs::write(out.join(format!("focus-order-{}.json",width as u32)),serde_json::to_vec_pretty(&order)?)?;
                let copied_at=Instant::now();press!("engine-setup-copy");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["copied"]==true,"Copy feedback missing");anyhow::ensure!(cx.read_from_clipboard().and_then(|item|item.text()).as_deref()==Some(engine_setup::INSTALL_CMD),"Copy did not write exact installation command to clipboard");Ok(())})??;
                shot!(&format!("copied-{}",width as u32));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let bounds=view.read(cx).engine_setup.read(cx).bounds("engine-setup-command").ok_or_else(||anyhow::anyhow!("Command scroll target absent"))?;w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:bounds.center(),delta:ScrollDelta::Pixels(point(px(-300.),px(0.))),..Default::default()}),cx);draw(w,cx);anyhow::ensure!(state(&view,w,cx)["commandScrollOffset"][0].as_f64().is_some_and(|x|x<0.),"Install command did not scroll horizontally while copied label shrank its viewport");Ok(())})??;
                shot!(&format!("command-scrolled-{}",width as u32));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{cx.write_to_clipboard(ClipboardItem::new_string("selection-copy sentinel".into()));press(&view,w,cx,"engine-setup-command")?;draw(w,cx);key(w,cx,if cfg!(target_os="macos"){"cmd-c"}else{"ctrl-c"});draw(w,cx);anyhow::ensure!(cx.read_from_clipboard().and_then(|item|item.text()).as_deref()==Some(engine_setup::INSTALL_CMD),"Native command selection did not copy exact full command after horizontal scroll");Ok(())})??;
                let elapsed=copied_at.elapsed();if elapsed<Duration::from_millis(1200){cx.background_executor().timer(Duration::from_millis(1200)-elapsed).await;}
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(state(&view,w,cx)["copied"]==true,"Copy feedback reset before 1600ms");Ok(())})??;
                wait!(p,w,app=>state(&view,w,app)["copied"]==false);timing.push(serde_json::json!({"viewport":[width,height],"resetElapsedMs":copied_at.elapsed().as_millis()}));anyhow::ensure!(copied_at.elapsed()>=Duration::from_millis(1600),"Copy feedback reset too early");shot!(&format!("copy-reset-{}",width as u32));
                let before=handle.update(cx,|_,_,cx|view.read(cx).engine_setup_external_urls.len())?;press!("engine-setup-github");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.engine_setup.read(cx).is_open()&&p.engine_setup_external_urls.len()==before+1&&p.engine_setup_external_urls.last().map(String::as_str)==Some("https://github.com/adefossez/demucs"),"GitHub did not route through scoped host allowlist/interception");Ok(())})??;
                let _=std::fs::remove_file(&marker);std::fs::write(&control,"slow-failure")?;press!("engine-setup-recheck");wait!(p,w,app=>p.engine_setup_check.is_some()&&state(&view,w,app)["checking"]==true&&marker.exists());shot!(&format!("recheck-busy-{}",width as u32));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let before=view.read(cx).engine_setup_check;press(&view,w,cx,"engine-setup-recheck")?;let actual=state(&view,w,cx);anyhow::ensure!(view.read(cx).engine_setup_check==before,"Disabled recheck enqueued a duplicate check");anyhow::ensure!(!actual["focusOrder"].as_array().unwrap().iter().any(|id|id=="engine-setup-recheck"),"Busy recheck remained in focus order");for _ in 0..6{key(w,cx,"tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Busy Tab escaped engine setup");}key(w,cx,"escape");Ok(())})??;closed!();
                // Reopen before old probe completion: its result may refresh
                // canonical status but cannot close this newer modal session.
                manual!();std::fs::write(&control,"failure")?;wait!(p,w,app=>p.engine_setup_check.is_none());
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).engine_setup.read(cx).is_open(),"Old recheck closed the reopened engine dialog");Ok(())})??;
                press!("engine-setup-recheck");wait!(p,w,app=>p.engine_setup_check.is_none()&&state(&view,w,app)["checking"]==false);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).engine_setup.read(cx).is_open()&&state(&view,w,cx)["status"]["ok"]==false,"Failed recheck did not retain dialog/status");Ok(())})??;shot!(&format!("recheck-failure-{}",width as u32));
                press!("engine-setup-close");closed!();manual!();handle.update(cx,|_,w,cx|click(w,cx,point(px(5.),px(5.))))?;closed!();manual!();
                handle.update(cx,|_,w,cx|{for _ in 0..3{key(w,cx,"tab");draw(w,cx);}key(w,cx,"enter");})?;closed!();manual!();
                let old_release=control.with_extension("old-release");let _=std::fs::remove_file(&marker);let _=std::fs::remove_file(&old_release);std::fs::write(&control,"slow-old-failure")?;
                let old_revision=handle.update(cx,|_,_,cx|->anyhow::Result<u64>{let p=view.read(cx);let revision=p.source_status.engine_revision;p.source_service.as_ref().ok_or_else(||anyhow::anyhow!("No real source service"))?.check()?;Ok(revision)})??;
                wait!(p,w,app=>marker.exists());
                std::fs::write(&control,"success")?;press!("engine-setup-recheck");wait!(p,w,app=>p.engine_setup_check.is_none()&&p.engine_status.as_ref().is_some_and(|s|s.ok)&&!p.engine_setup.read(app).is_open());
                // Release the old worker only after the newer manual success
                // has reached the real host/header, proving completion order.
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).header.read(cx).engine_ready(),"Manual success did not update header");Ok(())})??;
                std::fs::write(&old_release,"release after manual success")?;wait!(p,w,app=>p.source_status.engine_revision>old_revision);
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.source_status.engine_status.ok&&p.engine_status.as_ref().is_some_and(|s|s.ok)&&p.header.read(cx).engine_ready(),"Older source failure overwrote newer manual success");Ok(())})??;
                shot!(&format!("recheck-success-{}",width as u32));
                // Reverse completion order: an older successful manual check
                // cannot close a dialog after a newer source check failed.
                manual!();let manual_release=control.with_extension("manual-release");let _=std::fs::remove_file(&marker);let _=std::fs::remove_file(&manual_release);std::fs::write(&control,"slow-old-success")?;
                press!("engine-setup-recheck");wait!(p,w,app=>p.engine_setup_check.is_some()&&state(&view,w,app)["checking"]==true&&marker.exists());
                // The source probe must read failure while the older manual
                // helper remains held by its independent gate.
                std::fs::write(&control,"failure")?;
                let prior_source_revision=handle.update(cx,|_,_,cx|->anyhow::Result<u64>{let p=view.read(cx);let revision=p.source_status.engine_revision;p.source_service.as_ref().unwrap().check()?;Ok(revision)})??;
                wait!(p,w,app=>p.source_status.engine_revision>prior_source_revision&&p.engine_status.as_ref().is_some_and(|s|!s.ok)&&!p.header.read(app).engine_ready());
                std::fs::write(&manual_release,"release after newer source failure")?;
                wait!(p,w,app=>p.engine_setup_check.is_none()&&state(&view,w,app)["checking"]==false);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.engine_setup.read(cx).is_open()&&!p.engine_status.as_ref().unwrap().ok&&!p.header.read(cx).engine_ready()&&state(&view,w,cx)["status"]["ok"]==false,"Older successful manual probe overrode newer source failure or closed its dialog");Ok(())})??;
                shot!(&format!("older-manual-success-refused-{}",width as u32));press!("engine-setup-close");closed!();
            }
            std::fs::write(out.join("copy-timing.json"),serde_json::to_vec_pretty(&timing)?)?;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"twoSizes":true,"headerModelsRoute":true,"syntheticLegacyHeaderRoute":true,"realSubprocessRecheck":true,"initialFailureSuccess":true,"busyRecheckDisabled":true,"busyDismissal":true,"staleSessionDoesNotClose":true,"olderSourceFailureDoesNotOverwriteManualSuccess":true,"olderManualSuccessDoesNotOverrideSourceFailure":true,"clipboardExact":true,"nativeCommandSelectionCopy":true,"copy1600msReset":true,"focusTrap":true,"enterEscapeCloseScrim":true,"horizontalCommandScroll":true,"githubIntercepted":true,"hidden":true,"muted":true}))?)?;Ok(())
        }.await;
        let _=cx.update(|cx|cx.write_to_clipboard(clipboard.unwrap_or(ClipboardItem{entries:vec![]})));
        match result{Ok(())=>eprintln!("NATIVE_ENGINE_SETUP passed"),Err(error)=>{eprintln!("NATIVE_ENGINE_SETUP failed: {error:#}");let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",viewport));}}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

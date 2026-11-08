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
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            handle.update(cx,|_,window,_|window.resize(size(px(1280.),px(800.))))?;
            let control=PathBuf::from(std::env::var_os("SINGZ_GPUI_MODEL_CONTROL").unwrap());
            macro_rules! wait { ($predicate:expr) => {{
                let deadline=Instant::now()+Duration::from_secs(20);
                loop {cx.background_executor().timer(Duration::from_millis(25)).await;
                    let ready=handle.update(cx,|_,_,cx|{let p=view.read(cx);let s=p.models.read(cx).snapshot.clone();($predicate)(&s)})?;
                    if ready {break;}anyhow::ensure!(Instant::now()<deadline,"Model state timeout: {}",stringify!($predicate));
                }
            }}; }
            macro_rules! press { ($id:expr) => {{cx.background_executor().timer(Duration::from_millis(100)).await;handle.update(cx,|_,w,cx|button(&view,w,cx,$id))??;cx.background_executor().timer(Duration::from_millis(100)).await;}}; }
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

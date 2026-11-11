//! macOS-only focused hidden close/reopen, Settings command and geometry integration check.
use super::*;
use std::{path::PathBuf, time::Duration};

pub(super) fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let weak=view.downgrade();
            handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                w.resize(size(px(940.),px(600.)));
                view.update(cx,|p,cx| {p.screen=Screen::Library;p.focus_handle.focus(w,cx);cx.notify();});
                super::ui_training_run::draw(w,cx);
                Ok(())
            })??;
            for _ in 0..2 {
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent {
                        keystroke:Keystroke::parse("cmd-,")?,is_held:false,prefer_character_input:false,
                    }),cx);
                    Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(25)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).screen==Screen::Settings,"Settings command toggled closed or was ignored");
                    super::ui_training_run::draw(w,cx);
                    Ok(())
                })??;
            }
            handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                super::ui_training_run::draw(w,cx);
                w.render_to_image()?.save(out.join("settings-minimum.png"))?;
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            // Remove the test's strong handle before close: the production registry
            // is weak and must not prevent the release/profile flush callback.
            drop(view);
            handle.update(cx,|_,w,cx|w.dispatch_action(Box::new(desktop_lifecycle::DesktopClose),cx))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            anyhow::ensure!(weak.upgrade().is_none(),"Closed player retained by application");
            let path=audio_devices::directory().join("window-state-native.json");
            let state:serde_json::Value=serde_json::from_slice(&std::fs::read(&path)?)?;
            anyhow::ensure!(state["normal"]["width"].as_f64()==Some(940.)&&state["normal"]["height"].as_f64()==Some(600.),"Close did not flush resized geometry: {state}");
            cx.update(desktop_lifecycle::reopen);
            cx.background_executor().timer(Duration::from_millis(100)).await;
            cx.update(|cx|->anyhow::Result<()> {
                let windows=cx.windows();
                anyhow::ensure!(windows.len()==1,"Reopen failed to create exactly one window");
                desktop_lifecycle::reopen(cx);
                anyhow::ensure!(cx.windows().len()==1,"Reopen duplicated an existing window");
                windows[0].update(cx,|_,w,cx|->anyhow::Result<()> {
                    anyhow::ensure!(w.viewport_size()==size(px(940.),px(600.)),"Reopen lost saved geometry");
                    super::ui_training_run::draw(w,cx);
                    w.render_to_image()?.save(out.join("reopened-minimum.png"))?;
                    Ok(())
                })??;
                Ok(())
            })?;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "settingsShortcutIdempotent":true,"windowReleased":true,"closeFlushedGeometry":true,
                "reopenRestoredGeometry":true,"reopenSingleWindow":true,
                "hidden":true,"muted":true,"reopenCallbackAdapter":true,
                "osDockEventInjected":false,"productionVisualParityClaimed":false
            }))?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>{let _=cx.update(|cx|cx.quit());}
            Err(error)=>{eprintln!("DESKTOP_LIFECYCLE failed: {error:#}");std::process::exit(1);}
        }
    }).detach();
}

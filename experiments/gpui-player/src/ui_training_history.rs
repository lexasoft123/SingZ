//! Restart/readback of real completed native sessions through the product UI.
use super::ui_training_run::{button, click, draw};
use super::*;
use std::{path::PathBuf, time::Duration};
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;
            let deadline=Instant::now()+Duration::from_secs(8);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|view.read(cx).training_store_revision>0)?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Saved training profile did not load");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                let p=view.read(cx);let snapshot=p.training_store.as_ref().unwrap().snapshot();anyhow::ensure!(snapshot.error().is_none(),"{:?}",snapshot.error());
                anyhow::ensure!(snapshot.aggregate.sessions==2&&snapshot.aggregate.attempts==2&&snapshot.receipts.len()==2,"Completion receipt missing/duplicated or partial guided session counted: {:?}",snapshot.aggregate);
                let (profile,controls)=p.training.read(cx).profile();anyhow::ensure!(profile.exercise==training_domain::Kind::Interval&&profile.length==1&&profile.range.low_midi==57&&profile.range.high_midi==59&&profile.direction==training_domain::DirectionChoice::Ascending,"Saved setup not restored: {profile:?}");
                let expected_sound=if std::env::var_os("SINGZ_GPUI_EXPECT_PROGRAM").is_some(){2}else{0};
                anyhow::ensure!(controls.sound==expected_sound&&controls.tolerance==1,"Saved controls not restored");
                if expected_sound==2 {anyhow::ensure!((controls.volume-0.8).abs()<0.00001,"Final-frame preferences were not flushed on Quit");}
                if std::env::var_os("SINGZ_GPUI_EXPECT_PROGRAM").is_some(){anyhow::ensure!(controls.program.as_ref().is_some_and(|p|p.level==0),"Selected program did not survive second restart");}
                anyhow::ensure!(snapshot.receipts.iter().all(|r|!r.qualifies_day()),"Short/identify exercise earned a day");
                click(window,cx,point(px(295.),px(26.)));Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-progress"))??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            for (width,height) in [(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,window,_|window.resize(size(px(width),px(height))))?;
                cx.background_executor().timer(Duration::from_millis(80)).await;
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);anyhow::ensure!(window.viewport_size()==size(px(width),px(height))&&view.read(cx).training.read(cx).snapshot().0==training::Route::Progress,"Progress viewport/route mismatch");window.render_to_image()?.save(out.join(format!("progress-filled-{}.png",width as u32)))?;
                    window.dispatch_event(PlatformInput::Scroll(ScrollEvent {position:point(px(900.),px(450.)),delta:ScrollDelta::Pixels(point(px(0.),px(-3000.))),..Default::default()}),cx);draw(window,cx);window.render_to_image()?.save(out.join(format!("progress-bottom-{}.png",width as u32)))?;
                    window.dispatch_event(PlatformInput::Scroll(ScrollEvent {position:point(px(900.),px(450.)),delta:ScrollDelta::Pixels(point(px(0.),px(3000.))),..Default::default()}),cx);draw(window,cx);Ok(())})??;
            }
            let inject_error=std::env::var_os("SINGZ_GPUI_EXPECT_PROGRAM").is_none();
            let prefs_path=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap()).join("training-preferences.json");
            if inject_error {std::fs::write(&prefs_path,b"{malformed external settings")?;}
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-level-0"))??;
            if inject_error {
                let deadline=Instant::now()+Duration::from_secs(5);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).training_store.as_ref().unwrap().snapshot().preference_error.is_some())?{break;}anyhow::ensure!(Instant::now()<deadline,"Corrupt profile did not surface a save error");}
                anyhow::ensure!(std::fs::read(&prefs_path)?==b"{malformed external settings","Malformed existing profile was overwritten");
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);window.render_to_image()?.save(out.join("progress-save-error-1060.png"))?;let preferences=view.read(cx).training.read(cx).profile().0;std::fs::write(&prefs_path,serde_json::to_vec(&serde_json::json!({"formatVersion":1,"preferences":preferences}))?)?;button(&view,window,cx,"training-save-retry")})??;
            }
            let deadline=Instant::now()+Duration::from_secs(5);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|view.read(cx).training_store.as_ref().unwrap().snapshot().controls.program.as_ref().is_some_and(|p|p.level==0)&&view.read(cx).training_store.as_ref().unwrap().snapshot().error().is_none())?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Program choice did not persist");}
            // No timer/yield before Quit: the normal 16ms poll cannot enqueue
            // this last-frame edit. The app's shutdown hook must flush it.
            if inject_error {handle.update(cx,|_,_,cx|view.read(cx).training.clone().update(cx,|s,cx|s.shutdown_fixture(cx)))?;}
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"restoredSessions":2,"lifetimeAttempts":2,"setupRestored":true,"programSaved":true,"shortPracticeHasNoDayCredit":true,"partialSessionNotStored":true,"saveErrorAndRetry":inject_error,"hidden":true,"hardwareInput":false}))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_HISTORY passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_HISTORY failed: {error:#}");std::process::exit(1);}}
    }).detach();
}

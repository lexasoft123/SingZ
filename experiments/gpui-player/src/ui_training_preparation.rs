//! Source-backed song recipes, explicit setup review and stale-load cancellation.
use super::ui_training_run::{button, click, draw};
use super::*;
use std::{path::PathBuf, time::Duration};
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;
            let known=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(known.clone(),cx)))?;
            let deadline=Instant::now()+Duration::from_secs(30);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(!p.loading&&p.project.is_some())})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Known-key project load timed out");}
            let first_source=handle.update(cx,|_,window,cx|{draw(window,cx);click(window,cx,point(px(96.),px(718.)));view.read(cx).native_epoch})?;
            cx.background_executor().timer(Duration::from_millis(150)).await;
            handle.update(cx,|_,window,cx|click(window,cx,point(px(295.),px(26.))))?;
            cx.background_executor().timer(Duration::from_millis(150)).await;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Training&&!p.playing})?{break;}anyhow::ensure!(Instant::now()<deadline,"Training did not acknowledge pause");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(!view.read(cx).playing,"Training did not pause song");draw(window,cx);window.render_to_image()?.save(out.join("song-home-1280.png"))?;Ok(())})??;
            for (id,kind,length) in [("chords",training_domain::Kind::Mixed,6),("mixed",training_domain::Kind::Mixed,8),("intervals",training_domain::Kind::Interval,18),("notes",training_domain::Kind::Degree,6)] {
                handle.update(cx,|_,window,cx|button(&view,window,cx,&format!("training-prepare-{id}")))??;
                cx.background_executor().timer(Duration::from_millis(80)).await;
                handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);let screen=p.training.read(cx);let config=screen.config("recipe-check".into());anyhow::ensure!(p.practice.is_none()&&p.training_test.is_none()&&p.mic_intent.is_none(),"Preparation bypassed setup or opened audio/capture");anyhow::ensure!(screen.snapshot().0==training::Route::Setup&&screen.preparation_matches(Some(first_source)),"Recipe lost setup/context");anyhow::ensure!(config.kind==kind&&config.length==length&&config.tonic==1&&config.minor&&config.low==48&&config.high==72,"Recipe/key/transpose/range mismatch: {config:?}");if id=="chords"{anyhow::ensure!(training_preparation::requirements(&config)==(false,true,true)&&config.mixed_kinds==vec![training_domain::Kind::Chord,training_domain::Kind::Arpeggio],"Chords recipe contains unrelated interval controls/kinds");}draw(window,cx);window.render_to_image()?.save(out.join(format!("recipe-{id}-1280.png")))?;if id!="notes"{button(&view,window,cx,"training-back")?;}Ok(())})??;
                cx.background_executor().timer(Duration::from_millis(80)).await;
            }
            handle.update(cx,|_,_,cx|view.read(cx).training.clone().update(cx,|s,cx|s.short_preparation_fixture(cx)))?;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-start"))??;
            let deadline=Instant::now()+Duration::from_secs(35);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let done=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);let r=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Start did not create prepared session"))?;anyhow::ensure!(r.error.is_none()&&p.notice.is_none(),"{:?} {:?}",r.error,p.notice);Ok(r.phase==training_run::Phase::Summary)})??;if done{break;}anyhow::ensure!(Instant::now()<deadline,"Prepared note did not complete through native CREPE");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).practice.as_ref().unwrap().snapshot().correct==1,"Prepared target was not scored");draw(window,cx);window.render_to_image()?.save(out.join("song-summary-1280.png"))?;button(&view,window,cx,"training-run-song")})??;
            cx.background_executor().timer(Duration::from_millis(120)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Player&&p.project.is_some()&&!p.playing&&p.practice.is_none(),"Back to song failed or resumed playback");click(window,cx,point(px(295.),px(26.)));Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-prepare-intervals"))??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            let unknown=PathBuf::from(std::env::var_os("SINGZ_GPUI_UNKNOWN_PROJECT").unwrap());
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(unknown,cx)))?;
            let deadline=Instant::now()+Duration::from_secs(30);
            loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(!p.loading&&p.project.is_some())})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Unknown-key project load timed out");}
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.native_epoch!=first_source&&!p.training.read(cx).preparation_matches(Some(first_source))&&p.practice.is_none(),"Project replacement retained old preparation");window.resize(size(px(1060.),px(640.)));click(window,cx,point(px(295.),px(26.)));Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);window.render_to_image()?.save(out.join("unknown-song-home-1060.png"))?;button(&view,window,cx,"training-prepare-chords")})??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.practice.is_none()&&p.training_test.is_none()&&p.mic_intent.is_none()&&p.training.read(cx).snapshot().0==training::Route::Setup,"Unknown key opened runtime instead of manual setup");draw(window,cx);window.render_to_image()?.save(out.join("unknown-song-setup-1060.png"))?;Ok(())})??;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"recipes":4,"setupFirst":true,"keyStampAndTranspose":true,"rangePreserved":true,"nativePreparedScore":true,"summaryBackToPausedSong":true,"replacementInvalidatesContext":true,"unknownKeyManualSetup":true,"hidden":true,"hardwareInput":false}))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_PREPARATION passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_PREPARATION failed: {error:#}");std::process::exit(1);}}
    }).detach();
}

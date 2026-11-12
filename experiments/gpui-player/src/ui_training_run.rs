//! Actual hidden Start -> native cue -> CREPE -> receipt -> summary lifecycle.
use super::*;
use std::{path::PathBuf, time::Duration};
pub(super) fn draw(window: &mut Window, cx: &mut App) {
    for _ in 0..3 {
        window.simulate_next_frame(cx);
        window.refresh();
        // A real frame loop clears the element arena after every draw (gpui window.rs, request_frame).
        // Dropping the token leaked every frame's element tree: ~85 MB per song open in a 20-open run.
        window.draw(cx).clear(cx);
    }
}
/// A fresh profile opens What's New once a project loads and its backdrop swallows
/// the first click. Wait for startup to settle, then close it the way its own close
/// control does (the hidden window gives the modal no keyboard focus).
pub(super) async fn settle_whats_new(handle: AnyWindowHandle, view: &Entity<Player>, cx: &mut AsyncApp) -> anyhow::Result<()> {
    let deadline = std::time::Instant::now() + Duration::from_secs(30);
    loop {
        if handle.update(cx, |_, _, cx| { let p = view.read(cx); p.release_startup_ready && p.model_auto_checked })? { break; }
        anyhow::ensure!(std::time::Instant::now() < deadline, "Startup did not settle (release_startup_ready && model_auto_checked)");
        cx.background_executor().timer(Duration::from_millis(20)).await;
    }
    if handle.update(cx, |_, _, cx| view.read(cx).whats_new.read(cx).is_open())? {
        handle.update(cx, |_, _, cx| { let notes = view.read(cx).whats_new.clone(); notes.update(cx, |notes, cx| notes.close(cx)); })?;
        let deadline = std::time::Instant::now() + Duration::from_secs(5);
        while handle.update(cx, |_, _, cx| view.read(cx).whats_new.read(cx).is_open())? {
            anyhow::ensure!(std::time::Instant::now() < deadline, "What's New did not close");
            cx.background_executor().timer(Duration::from_millis(20)).await;
        }
    }
    Ok(())
}
pub(super) fn click(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
}
pub(super) fn header_control(view: &Entity<Player>, window: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(window, cx);
    let bounds = view.read(cx).header.read(cx).guides.get(id)
        .ok_or_else(|| anyhow::anyhow!("Header control {id} is not measured"))?;
    anyhow::ensure!(bounds.left() >= px(0.) && bounds.top() >= px(0.) && bounds.right() <= window.viewport_size().width && bounds.bottom() <= window.viewport_size().height,
        "Header control {id} is outside the viewport: {bounds:?}");
    click(window, cx, bounds.center());
    Ok(())
}
pub(super) fn button(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    if id == "training-start" {
        window.dispatch_event(
            PlatformInput::Scroll(ScrollEvent {
                position: point(px(900.), px(450.)),
                delta: ScrollDelta::Pixels(point(px(0.), px(-2500.))),
                ..Default::default()
            }),
            cx,
        );
        draw(window, cx);
    }
    let bounds = view
        .read(cx)
        .training
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing {id}"))?;
    anyhow::ensure!(
        bounds.top() >= px(52.) && bounds.bottom() <= window.viewport_size().height,
        "Outside viewport {id}: {bounds:?}, viewport {:?}",
        window.viewport_size()
    );
    click(window, cx, bounds.center());
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            handle.update(cx, |_,window,_|window.resize(size(px(1280.),px(800.))))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx, |_,window,cx| -> anyhow::Result<()> {header_control(&view,window,cx,"training")?;view.read(cx).training.clone().update(cx,|s,cx|s.practice_fixture(false,cx));Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-start"))??;
            let mut phases=std::collections::BTreeSet::new();
            let deadline=Instant::now()+Duration::from_secs(30);
            loop {
                cx.background_executor().timer(Duration::from_millis(15)).await;
                let done=handle.update(cx,|_,window,cx|->anyhow::Result<bool>{
                    draw(window,cx);
                    let p=view.read(cx);let run=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Start did not create practice"))?;
                    anyhow::ensure!(p.notice.is_none()&&run.error.is_none(),"Native training error: {:?} {:?}",p.notice,run.error);
                    let phase=format!("{:?}",run.phase);
                    if phases.insert(phase.clone()) { window.render_to_image()?.save(out.join(format!("vocal-{phase}-1280.png")))?; }
                    if run.phase==training_run::Phase::Summary {
                        anyhow::ensure!(run.session.results().len()==1&&run.snapshot().correct==1,"Vocal receipt missing or incorrect");
                        let training_session::Response::Vocal(targets)=&run.session.results()[0].response else {anyhow::bail!("No vocal result")};
                        anyhow::ensure!(targets[0].metrics.voiced_coverage.unwrap_or(0.)>0.85,"Insufficient native voiced evidence");
                        return Ok(true);
                    }
                    if run.phase==training_run::Phase::Respond { anyhow::ensure!(p.mic_view.owner==4&&p.mic_view.fixture,"Wrong capture owner or hardware input opened"); }
                    Ok(false)
                })??;
                if done {break;} anyhow::ensure!(Instant::now()<deadline,"Training did not finish; observed {phases:?}");
            }
            for phase in ["Cue","Respond","Completing","Feedback","Summary"] { anyhow::ensure!(phases.contains(phase),"Missing phase {phase}"); }
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.mic_view.phase==microphone::Phase::Off&&p.training_test.is_none()&&p.training_stopped>=p.training_serial})? {break;}
                anyhow::ensure!(Instant::now()<deadline,"Summary did not release input and standalone output");
            }
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-run-restart"))??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx,|_,window,cx|header_control(&view,window,cx,"songs"))??;
            cx.background_executor().timer(Duration::from_millis(150)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).practice.as_ref().unwrap().phase==training_run::Phase::Paused,"Leaving did not pause practice");header_control(&view,window,cx,"training")?;Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{button(&view,window,cx,"training-run-exit")?;window.resize(size(px(1060.),px(640.)));Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx,|_,window,cx|{draw(window,cx);view.read(cx).training.clone().update(cx,|s,cx|s.practice_fixture(true,cx));})?;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-start"))??;
            let deadline=Instant::now()+Duration::from_secs(15);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);let r=p.practice.as_ref().unwrap();anyhow::ensure!(r.error.is_none(),"{:?}",r.error);Ok(r.phase==training_run::Phase::Respond)})??;
                if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Identify cue did not complete");
            }
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.mic_intent.is_none(),"Identify opened capture");let note=p.practice.as_ref().unwrap().displayed_prompt().targets[0].midi%12;draw(window,cx);window.render_to_image()?.save(out.join("identify-Respond-1060.png"))?;button(&view,window,cx,&format!("training-answer-{note}"))})??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx,|_,_,cx|view.read(cx).practice.as_ref().unwrap().phase==training_run::Phase::Summary)? {break;}
                anyhow::ensure!(Instant::now()<deadline,"Identify summary did not finish");
            }
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).practice.as_ref().unwrap().snapshot().correct==1,"Identify answer not scored");draw(window,cx);window.render_to_image()?.save(out.join("identify-Summary-1060.png"))?;Ok(())})??;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-run-back"))??;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,_,cx|view.read(cx).training.clone().update(cx,|s,cx|s.guided_fixture(cx)))?;
            cx.background_executor().timer(Duration::from_millis(80)).await;
            handle.update(cx,|_,window,cx|button(&view,window,cx,"training-start"))??;
            let mut first_generation=None;
            let deadline=Instant::now()+Duration::from_secs(20);
            loop {
                cx.background_executor().timer(Duration::from_millis(15)).await;
                let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{
                    let p=view.read(cx);let run=p.practice.as_ref().unwrap();
                    anyhow::ensure!(run.error.is_none()&&p.notice.is_none(),"Guided error {:?} {:?}",run.error,p.notice);
                    if first_generation.is_none(){first_generation=p.training_test;}
                    if run.phase==training_run::Phase::Cue&&run.target==1 {
                        anyhow::ensure!(run.session.prompts().len()==3,"One interval set must contain three attempts");
                        let Some(status)=p.training_last.as_ref().filter(|s| Some(s.generation)==p.training_test) else{return Ok(false)};
                        anyhow::ensure!(status.generation>first_generation.unwrap()&&status.notes.len()==1&&status.notes[0].midi==59,"Guided target cue did not replace first cue");
                        anyhow::ensure!(run.results_for_test()==1&&p.mic_view.owner==4,"Guided target did not retain scored first note and capture owner");
                        return Ok(true);
                    }
                    Ok(false)
                })??;
                if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Guided second target was not played after first target locked");
            }
            handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);window.render_to_image()?.save(out.join("guided-second-Cue-1060.png"))?;button(&view,window,cx,"training-run-exit")})??;
            let deadline=Instant::now()+Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.practice.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.training_stopped>=p.training_serial})?{break;}
                anyhow::ensure!(Instant::now()<deadline,"Ending guided practice did not release both owners");
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"actualStart":true,"nativeCrepe":true,"vocalOnTarget":true,"completionHold":true,"summaryReleasesOwners":true,"restart":true,"leavePauses":true,"identifyWithoutCapture":true,"identifyCorrect":true,"guidedNextTarget":true,"endReleasesOwners":true,"hidden":true,"muted":true,"hardwareInput":false,"phases":phases}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{eprintln!("TRAINING_RUN passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_RUN failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);}}
    }).detach();
}

//! Hidden keyboard journey through actual native exercise and summary controls.
//! Generated PCM replaces hardware input only; cues and replay use native owners.
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

fn key(w: &mut Window, cx: &mut App, name: &'static str) {
    let stroke = Keystroke::parse(name).unwrap();
    w.dispatch_keystroke(stroke.clone(), cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: stroke }), cx);
}
fn tab_to(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    let mut trace = vec![];
    for _ in 0..160 {
        ui_training_run::draw(w, cx);
        let screen = view.read(cx).training.read(cx);
        let value = screen.keyboard_state(w, cx);
        if screen.focused_control(w).as_deref() == Some(id) {
            let bounds = value["focusedBounds"].as_array().ok_or_else(|| anyhow::anyhow!("Focused control is not measured: {id}: {value}"))?;
            let left = bounds[0].as_f64().unwrap();
            let top = bounds[1].as_f64().unwrap();
            let right = left + bounds[2].as_f64().unwrap();
            let bottom = top + bounds[3].as_f64().unwrap();
            anyhow::ensure!(left >= 0. && top >= 52. && right <= f32::from(w.viewport_size().width) as f64 + 1.
                && bottom <= f32::from(w.viewport_size().height) as f64 + 1., "Focused control is clipped: {id}: {value}");
            return Ok(());
        }
        trace.push(value);
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Tab did not reach {id}: {}", serde_json::to_string(&trace)?)
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str, stroke: &'static str) -> anyhow::Result<()> {
    tab_to(view, w, cx, id)?;
    key(w, cx, stroke);
    ui_training_run::draw(w, cx);
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..160 {
        ui_training_run::draw(w, cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref() == Some(id) {
            key(w, cx, "enter");
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!("Header {id} unreachable by Tab")
}
fn state(p: &Player, w: &Window, cx: &App, phase: &str) -> serde_json::Value {
    serde_json::json!({
        "phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),
        "keyboard":p.training.read(cx).keyboard_state(w,cx),"headerFocused":p.header.read(cx).focused_control(w),
        "screenTraining":p.screen==Screen::Training,"projectLoaded":p.project.is_some(),"playing":p.playing,
        "seekCount":p.playhead.seek_count(),"micIntent":p.mic_intent.is_some(),
        "trainingStore":p.training_store.as_ref().map(|store|{let s=store.snapshot();serde_json::json!({
            "revision":s.revision,"loaded":s.loaded,"pending":s.pending,"preferenceError":s.preference_error,
            "completionError":s.completion_error,"loadError":s.load_error,
            "programLevel":s.controls.program.as_ref().map(|program|program.level),"sessions":s.aggregate.sessions})}),
        "practice":p.practice.as_ref().map(|run|serde_json::json!({
            "phase":format!("{:?}",run.phase),"targetMidi":run.displayed_prompt().targets.iter().map(|t|t.midi).collect::<Vec<_>>(),
            "promptCount":run.session.prompts().len(),"resultCount":run.session.results().len(),
            "correct":run.snapshot().correct,"attempts":run.snapshot().attempts,"error":run.error,
            "responses":run.session.results().iter().map(|receipt|match &receipt.response{
                training_session::Response::Identify(answer)=>serde_json::json!({"kind":"identify","correct":receipt.correct,"answer":format!("{answer:?}")}),
                training_session::Response::Skipped=>serde_json::json!({"kind":"skipped","correct":receipt.correct}),
                training_session::Response::Vocal(targets)=>serde_json::json!({"kind":"vocal","correct":receipt.correct,"targetCount":targets.len()}),
            }).collect::<Vec<_>>() })),
        "capture":{"owner":p.mic_view.owner,"phase":format!("{:?}",p.mic_view.phase),"fixture":p.mic_view.fixture,
            "generation":p.mic_view.generation,"sequence":p.mic_view.sequence,"frequency":p.mic_view.frequency,"clarity":p.mic_view.clarity},
        "cue":p.training_last.as_ref().map(|s|serde_json::json!({"generation":s.generation,"active":s.active,
            "startHostNs":s.start_host_ns.to_string(),"endHostNs":s.end_host_ns.to_string(),
            "notes":s.notes.iter().map(|n|serde_json::json!({"midi":n.midi,"start":n.start,"end":n.end})).collect::<Vec<_>>() })),
        "trainingGeneration":p.training_test,"trainingSerial":p.training_serial,"trainingStopped":p.training_stopped,
        "ownersReleased":p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial,
        "hardwareInput":false,"liveFps":"unmeasured"})
}
fn capture(view: &Entity<Player>, w: &mut Window, cx: &mut App, out: &Path, name: &str) -> anyhow::Result<()> {
    ui_training_run::draw(w, cx);
    anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Capture activated window");
    let mut value=state(view.read(cx),w,cx,name);
    let image=w.render_to_image()?;
    value["raster"]=serde_json::json!([image.width(),image.height()]);
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;
    Ok(())
}
fn identify(p: &Player) -> anyhow::Result<()> {
    let run=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Identify practice missing"))?;
    anyhow::ensure!(run.session.config().task==training_domain::Task::Identify
        &&run.displayed_prompt().targets.len()==1&&run.displayed_prompt().targets[0].midi==57
        &&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off,
        "Identify changed actual target or opened capture");
    Ok(())
}
fn correct_summary(p: &Player) -> anyhow::Result<()> {
    identify(p)?;
    let run=p.practice.as_ref().unwrap();
    anyhow::ensure!(run.phase==training_run::Phase::Summary&&run.session.results().len()==1
        &&run.snapshot().correct==1&&run.session.results()[0].correct==Some(true)
        &&matches!(&run.session.results()[0].response,training_session::Response::Identify(training_session::Answer::Note(9))),
        "Answer key down/up did not produce exactly one correct A3 receipt");
    Ok(())
}
fn reading_scroll(view: &Entity<Player>, w: &mut Window, cx: &mut App, context: &str) -> anyhow::Result<serde_json::Value> {
    ui_training_run::draw(w,cx);
    let before=state(view.read(cx),w,cx,context);
    key(w,cx,"end");ui_training_run::draw(w,cx);
    let end=state(view.read(cx),w,cx,context);
    let y=end["keyboard"]["scrollOffset"][1].as_f64().ok_or_else(||anyhow::anyhow!("Missing actual {context} scroll offset"))?;
    anyhow::ensure!(y.is_finite()&&y<=0.&&end["keyboard"]["focusedControl"].is_null()
        &&end["playing"]==before["playing"]&&end["seekCount"]==before["seekCount"],"Reading End escaped scope: {end}");
    let max=end["keyboard"]["scrollMaxOffset"][1].as_f64().unwrap_or(0.);
    // The fixture may fit. Record that separately instead of claiming a
    // scroll occurred when the content did not overflow.
    if max>1. {anyhow::ensure!(y<0.,"Overflowing {context} did not scroll to End: {end}");}
    key(w,cx,"home");ui_training_run::draw(w,cx);
    let home=state(view.read(cx),w,cx,context);
    anyhow::ensure!(home["keyboard"]["scrollOffset"][1].as_f64().is_some_and(|y|y.abs()<1.)
        &&home["playing"]==before["playing"]&&home["seekCount"]==before["seekCount"],"Reading Home did not return to top: {home}");
    Ok(serde_json::json!({"context":context,"before":before,"end":end,"home":home,"overflowObserved":y< -1.}))
}
fn retry_boundary(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    tab_to(view,w,cx,"training-save-retry")?;
    let value=view.read(cx).training.read(cx).keyboard_state(w,cx);
    let order=value["focusOrder"].as_array().ok_or_else(||anyhow::anyhow!("Retry order missing"))?;
    anyhow::ensure!(order.first().and_then(|id|id.as_str())==Some("training-save-retry")&&order.len()>1,
        "Retry must match its leading painted position: {value}");
    let next=order[1].as_str().unwrap().to_owned();let last=order.last().unwrap().as_str().unwrap().to_owned();
    key(w,cx,"tab");ui_training_run::draw(w,cx);
    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some(next.as_str()),
        "Retry Tab did not reach the first content control: {next}");
    tab_to(view,w,cx,&last)?;key(w,cx,"tab");ui_training_run::draw(w,cx);
    let p=view.read(cx);
    anyhow::ensure!(p.header.read(cx).focused_control(w).is_some()
        &&p.training.read(cx).keyboard_state(w,cx)["focusInside"]==false,
        "Error banner trapped the content-to-header Tab boundary");
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some(),
                "Running keyboard test requires hidden, muted private PCM replay");
            std::fs::create_dir_all(&out)?;
            let mut steps=vec![];
            let mut receipts=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {
                    cx.background_executor().timer(Duration::from_millis(15)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{
                        ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Hidden/error invariant: {:?}",$p.notice);
                        if let Some(run)=&$p.practice{anyhow::ensure!(run.error.is_none(),"Native exercise failed: {:?}",run.error);}
                        Ok($condition)
                    })?? {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Running keyboard timeout {}: {}",stringify!($condition),
                        handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! press {($id:expr,$stroke:expr)=>{{handle.update(cx,|_,w,cx|press(&view,w,cx,$id,$stroke))??;}};}
            macro_rules! record {($phase:expr)=>{{steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! receipt {($phase:expr)=>{{receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! shot {($phase:expr,$width:expr)=>{{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-running-{}-{}",$phase,$width as u32)))??;}};}
            macro_rules! released {()=>{wait!(8,p,w,app => p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()
                &&p.training_test.is_none()&&p.training_stopped>=p.training_serial)};}
            wait!(15,p,w,app => p.backend.is_some()&&p.project.is_none()&&p.training_store_revision>0
                &&p.training.read(app).config("running-keyboard".into()).length==1);
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(10,p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                wait!(8,p,w,app => p.screen==Screen::Training&&p.training.read(app).snapshot().0==training::Route::Home);
                press!("training-exercise-0","enter");
                // Sole eligible C-major note is A3. Configure it using actual
                // range keys; only initial persisted length1 is a fixture.
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    tab_to(&view,w,cx,"training-low")?;key(w,cx,"home");
                    for _ in 0..21 {key(w,cx,"right");}
                    tab_to(&view,w,cx,"training-high")?;key(w,cx,"home");Ok(())
                })??;
                press!("training-task-2","space");
                wait!(5,p,w,app => {let c=p.training.read(app).config("running-keyboard".into());
                    c.low==57&&c.high==58&&c.length==1&&c.task==training_domain::Task::Identify&&c.tonic==0&&!c.minor});
                record!("actual-identify-setup");
                press!("training-start","enter");
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Cue)
                    &&p.training_last.as_ref().is_some_and(|s|Some(s.generation)==p.training_test&&s.active));
                handle.update(cx,|_,_,cx|identify(view.read(cx)))??;
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond));
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-answer-9"))??;
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    key(w,cx,"shift-tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some("training-answer-8"),
                        "ShiftTab did not reverse answer traversal");
                    key(w,cx,"tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some("training-answer-9"),
                        "Tab did not return to the answer after ShiftTab");Ok(())
                })??;
                record!("run-tab-reversal");
                shot!("answer",width);
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    identify(view.read(cx))?;key(w,cx,"enter");Ok(())
                })??;
                // The answer event updates Player first. Training's immutable
                // render snapshot follows on its regular host tick; while it
                // still says Respond, the answer remains legitimately mounted.
                // Await the real child phase before checking removed focus.
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase!=training_run::Phase::Respond)
                    &&p.training.read(app).keyboard_state(w,app)["runPhase"].as_str().is_some_and(|phase|phase!="Respond"));
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    let screen=view.read(cx).training.read(cx);let value=screen.keyboard_state(w,cx);
                    anyhow::ensure!(value["focusInside"]==true&&!screen.focused_control(w).is_some_and(|id|id.starts_with("training-answer-"))
                        &&!value["focusOrder"].as_array().unwrap().iter().any(|id|id.as_str().is_some_and(|id|id.starts_with("training-answer-"))),
                        "Unmounted answer retained focus: {value}");
                    let next=if value["runPhase"]=="Summary" {"training-run-restart"}else{"training-run-exit"};
                    tab_to(&view,w,cx,next)?;Ok(())
                })??;
                record!("answer-unmounted-focus-recovery");
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary));
                released!();
                handle.update(cx,|_,_,cx|correct_summary(view.read(cx)))??;
                receipt!("identify-enter-summary");
                steps.push(handle.update(cx,|_,w,cx|reading_scroll(&view,w,cx,"summary-reading"))??);
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-run-restart"))??;
                shot!("summary",width);
                press!("training-run-restart","space");
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond));
                handle.update(cx,|_,_,cx|identify(view.read(cx)))??;
                press!("training-answer-9","space");
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary));
                released!();
                handle.update(cx,|_,_,cx|correct_summary(view.read(cx)))??;
                receipt!("identify-space-summary");
                press!("training-run-back","enter");
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                press!("training-exercise-0","enter");press!("training-task-0","enter");
                press!("training-start","space");
                wait!(15,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)
                    &&p.mic_view.owner==4&&p.mic_view.fixture&&p.mic_view.sequence>0);
                let first_generation=handle.update(cx,|_,w,cx|->anyhow::Result<u64>{
                    tab_to(&view,w,cx,"training-run-replay")?;let p=view.read(cx);
                    anyhow::ensure!(p.practice.as_ref().unwrap().phase==training_run::Phase::Respond&&p.mic_view.fixture,"Replay control was not reached while responding");
                    Ok(p.training_serial)
                })??;
                receipt!("replay-respond-before");shot!("replay",width);
                press!("training-run-replay","enter");
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Cue)
                    &&p.training_last.as_ref().is_some_and(|s|s.generation>first_generation&&Some(s.generation)==p.training_test&&s.active));
                handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);let s=p.training_last.as_ref().unwrap();
                    anyhow::ensure!(s.notes.len()==1&&s.notes[0].midi==57&&s.end_host_ns-s.start_host_ns==2_750_000_000,
                        "Keyboard Replay did not create the actual fresh A3 native cue");Ok(())})??;
                receipt!("replay-fresh-cue");
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)
                    &&p.mic_view.owner==4&&p.mic_view.fixture&&p.mic_view.sequence>0);
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-run-skip"))??;
                receipt!("replay-respond-after");shot!("skip",width);
                press!("training-run-skip","space");
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary));
                released!();
                handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);let r=p.practice.as_ref().unwrap();
                    anyhow::ensure!(r.session.results().len()==1&&r.snapshot().attempts==0
                        &&matches!(&r.session.results()[0].response,training_session::Response::Skipped),
                        "Keyboard Skip did not preserve the single skipped receipt");Ok(())})??;
                receipt!("skipped-summary");press!("training-run-back","space");
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                press!("training-exercise-0","enter");press!("training-task-2","enter");press!("training-start","enter");
                wait!(15,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond));
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    identify(view.read(cx))?;
                    let value=view.read(cx).training.read(cx).keyboard_state(w,cx);
                    let last=value["focusOrder"].as_array().and_then(|v|v.last()).and_then(|id|id.as_str())
                        .ok_or_else(||anyhow::anyhow!("Running keyboard order empty"))?.to_owned();
                    tab_to(&view,w,cx,&last)?;key(w,cx,"tab");ui_training_run::draw(w,cx);
                    let p=view.read(cx);let after=p.training.read(cx).keyboard_state(w,cx);
                    anyhow::ensure!(p.header.read(cx).focused_control(w).is_some()&&after["focusInside"]==false,
                        "Running last-control Tab trapped header navigation: {after}");Ok(())
                })??;
                record!("running-tab-boundary");
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-songs"))??;
                wait!(8,p,w,app => p.screen!=Screen::Training&&p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Paused));
                released!();
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                wait!(8,p,w,app => p.screen==Screen::Training&&p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Paused));
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-run-continue"))??;
                receipt!("header-paused");shot!("paused",width);
                let paused_generation=handle.update(cx,|_,_,cx|view.read(cx).training_serial)?;
                press!("training-run-continue","enter");
                wait!(12,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)
                    &&p.training_last.as_ref().is_some_and(|s|s.generation>paused_generation));
                handle.update(cx,|_,_,cx|identify(view.read(cx)))??;
                receipt!("continued-respond");
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-run-exit"))??;
                shot!("exit",width);press!("training-run-exit","space");
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                released!();
                // Distinct answer layouts must all remain reachable, including
                // the fourteen-choice Interval grid at the compact viewport.
                for (card,count,kind) in [(0,12,"Note"),(1,7,"Degree"),(2,14,"Interval"),(3,3,"Chord"),(4,7,"Arpeggio")] {
                    press!(&format!("training-exercise-{card}"),"enter");
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                        tab_to(&view,w,cx,"training-low")?;key(w,cx,"home");
                        for _ in 0..12 {key(w,cx,"right");}
                        tab_to(&view,w,cx,"training-high")?;key(w,cx,"end");
                        for _ in 0..12 {key(w,cx,"left");}Ok(())
                    })??;
                    press!("training-task-2","space");press!("training-start","enter");
                    wait!(15,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)
                        &&p.training_last.as_ref().is_some_and(|s|Some(s.generation)==p.training_test));
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                        for index in 0..count {tab_to(&view,w,cx,&format!("training-answer-{index}"))?;}
                        let p=view.read(cx);let r=p.practice.as_ref().unwrap();let order=p.training.read(cx).keyboard_state(w,cx);
                        anyhow::ensure!(p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off
                            &&r.session.config().task==training_domain::Task::Identify&&r.session.results().is_empty()
                            &&order["focusOrder"].as_array().unwrap().iter().filter(|id|id.as_str().is_some_and(|id|id.starts_with("training-answer-"))).count()==count,
                            "{kind} answer traversal changed practice or omitted controls: {order}");Ok(())
                    })??;
                    if kind=="Interval" {shot!("interval-last",width);}
                    record!(&format!("all-{kind}-answers-reachable"));
                    press!("training-run-exit","enter");
                    wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                    released!();
                }
                press!("training-progress","enter");
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Progress);
                steps.push(handle.update(cx,|_,w,cx|reading_scroll(&view,w,cx,"progress-reading"))??);
                press!("training-back","space");
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Home);
                // Corrupt only the driver's private persisted fixture. An
                // ordinary level edit must surface the real worker's refusal
                // to overwrite malformed external preferences.
                press!("training-level-1","enter");
                wait!(8,p,w,app => p.training_store.as_ref().is_some_and(|store|{
                    let s=store.snapshot();s.error().is_none()&&s.controls.program.as_ref().is_some_and(|program|program.level==1)
                }));
                let preferences_path=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR")
                    .ok_or_else(||anyhow::anyhow!("Private configuration directory missing"))?).join("training-preferences.json");
                let previous_preferences=std::fs::read(&preferences_path)?;
                std::fs::write(out.join(format!("preferences-before-retry-{}.json",width as u32)),&previous_preferences)?;
                let malformed=b"{malformed external private keyboard preferences";
                std::fs::write(&preferences_path,malformed)?;
                std::fs::write(out.join(format!("preferences-malformed-{}.txt",width as u32)),malformed)?;
                press!("training-level-0","space");
                wait!(8,p,w,app => p.training_store.as_ref().is_some_and(|store|store.snapshot().preference_error.is_some())
                    &&p.training.read(app).keyboard_state(w,app)["focusOrder"].as_array().is_some_and(|order|order.iter().any(|id|id=="training-save-retry")));
                anyhow::ensure!(std::fs::read(&preferences_path)?==malformed,"Worker overwrote malformed private preferences");
                handle.update(cx,|_,w,cx|retry_boundary(&view,w,cx))??;
                record!("save-retry-home-boundary");
                // Exercise the same leading banner in the running branch,
                // using an actual Identify session and native cue, no capture.
                press!("training-exercise-0","enter");press!("training-task-2","enter");press!("training-start","enter");
                wait!(15,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond)
                    &&p.training.read(app).keyboard_state(w,app)["runPhase"]=="Respond");
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    let p=view.read(cx);
                    anyhow::ensure!(p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off,
                        "Identify during preference error opened capture");retry_boundary(&view,w,cx)
                })??;
                record!("save-retry-running-boundary");
                press!("training-run-exit","enter");
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                released!();
                anyhow::ensure!(std::fs::read(&preferences_path)?==malformed,"Malformed fixture changed before explicit repair");
                handle.update(cx,|_,_,cx|->anyhow::Result<()> {
                    let preferences=view.read(cx).training.read(cx).profile().0;
                    std::fs::write(&preferences_path,serde_json::to_vec(&serde_json::json!({"formatVersion":1,"preferences":preferences}))?)?;
                    Ok(())
                })??;
                press!("training-save-retry","enter");
                wait!(8,p,w,app => p.training_store.as_ref().is_some_and(|store|store.snapshot().error().is_none())
                    &&p.training.read(app).keyboard_state(w,app)["focusOrder"].as_array().is_some_and(|order|!order.iter().any(|id|id=="training-save-retry")));
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    let value=view.read(cx).training.read(cx).keyboard_state(w,cx);
                    anyhow::ensure!(value["focusInside"]==true&&value["focusedControl"]!="training-save-retry",
                        "Removed Retry retained focus after repair: {value}");
                    let first=value["focusOrder"].as_array().and_then(|order|order.first()).and_then(|id|id.as_str())
                        .ok_or_else(||anyhow::anyhow!("Home controls disappeared after Retry"))?.to_owned();
                    key(w,cx,"tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some(first.as_str()),
                        "Removed Retry did not recover next Tab to live Home control");Ok(())
                })??;
                record!("save-retry-cleared-focus-recovery");
                // Pointer path remains real hit-tested input after keyboard use.
                handle.update(cx,|_,w,cx|ui_training_run::button(&view,w,cx,"training-exercise-0"))??;
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Setup);
                handle.update(cx,|_,w,cx|ui_training_run::button(&view,w,cx,"training-back"))??;
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                released!();receipt!("ended");record!("completed-viewport");
            }
            std::fs::write(out.join("keyboard-steps.json"),serde_json::to_vec_pretty(&steps)?)?;
            std::fs::write(out.join("training-running-keyboard.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualHeaderTab":true,"actualSetupKeys":true,"identifyEnter":true,"identifySpace":true,
                "singleAnswerReceipt":true,"answerFocusRecovery":true,"summaryRestart":true,"summaryBack":true,
                "nativeReplayFreshGeneration":true,"nativeSkipReceipt":true,"replayCaptureFixture":true,
                "headerBoundary":true,"headerPause":true,"keyboardContinue":true,"keyboardExit":true,
                "pointerAfterKeyboard":true,"endedOwnersReleased":true,"sizes":[[1280,800],[1060,640]],
                "answerFamilies":true,"coveredKinds":["Note","Degree","Interval","Chord","Arpeggio"],
                "historyAndSummaryScroll":true,
                "saveRetryKeyboard":true,
                "receipts":receipts,"hardwareInput":false,"pcmReplay":true,"liveFps":"unmeasured",
                "fixturePreparation":"Private persisted length1; actual keys select sole eligible A3 target and Identify/Imitate; generated A3 PCM replaces hardware input only",
                "scope":"Running and summary keyboard with actual native Identify cues, vocal Replay/Skip and PCM input owner; no physical microphone, audible output or live FPS qualification"
            }))?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>{eprintln!("TRAINING_RUNNING_KEYBOARD passed");let _=cx.update(|cx|cx.quit());},
            Err(error)=>{
                eprintln!("TRAINING_RUNNING_KEYBOARD failed: {error:#}");let _=std::fs::create_dir_all(&out);
                let _=std::fs::write(out.join("training-running-keyboard-failure.txt"),format!("{error:#}"));
                let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"training-running-keyboard-failure"));
                let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);
            }
        }
    }).detach();
}

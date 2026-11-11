//! Hidden Home/setup keyboard controls followed by real native training.
//! Only hardware capture is replaced by the existing A3 PCM replay seam.
use super::*;
use std::{path::PathBuf, time::Duration};

fn key(w: &mut Window, cx: &mut App, name: &str) {
    let stroke=if let Some(name)=["tab","shift-tab","enter","space","escape","up","down","left","right","home","end"].into_iter().find(|key|*key==name) {
        Keystroke::parse(name).unwrap()
    } else {
        assert_eq!(name.chars().count(),1,"Unsupported test keystroke");
        Keystroke {key:name.to_owned(),key_char:Some(name.to_owned()),..Default::default()}
    };
    w.dispatch_keystroke(stroke.clone(),cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn tab_to(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    let mut trace=vec![];
    for _ in 0..160 {
        ui_training_run::draw(w,cx);
        let p=view.read(cx);
        if p.training.read(cx).focused_control(w).as_deref()==Some(id){
            let state=p.training.read(cx).keyboard_state(w,cx);
            let bounds=state["focusedBounds"].as_array().ok_or_else(||anyhow::anyhow!("Focused Training control has no measured bounds: {id}"))?;
            let top=bounds[1].as_f64().unwrap();let bottom=top+bounds[3].as_f64().unwrap();
            let fits=|viewport:&serde_json::Value|viewport.as_array().is_some_and(|v|top>=v[1].as_f64().unwrap()-1.
                &&bottom<=v[1].as_f64().unwrap()+v[3].as_f64().unwrap()+1.);
            anyhow::ensure!(top>=0.&&bottom<=f32::from(w.viewport_size().height) as f64+1.
                &&(fits(&state["viewportBounds"])||fits(&state["stickyFooterBounds"])),"Focused Training control clipped despite keyboard scrolling: {id}: {state}");
            return Ok(());
        }
        trace.push(p.training.read(cx).keyboard_state(w,cx));
        key(w,cx,"tab");
    }
    anyhow::bail!("Training Tab did not reach {id}: {}",serde_json::to_string(&trace)?)
}
fn activate(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str,stroke:&'static str)->anyhow::Result<()> {
    tab_to(view,w,cx,id)?;key(w,cx,stroke);
    if id!="training-start"{let p=view.read(cx);anyhow::ensure!(p.practice.is_none()&&p.mic_intent.is_none()&&!p.playing,"Setup control leaked into a session, capture or song action: {id}");}
    Ok(())
}
fn header_training(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    for _ in 0..128 {
        ui_training_run::draw(w,cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref()==Some("header-training") {
            key(w,cx,"enter");return Ok(());
        }
        key(w,cx,"tab");
    }
    anyhow::bail!("Header Training was not reachable by actual Tab")
}
fn state(p:&Player,w:&Window,cx:&App,phase:&str)->serde_json::Value {
    let practice=p.practice.as_ref().map(|run|serde_json::json!({
        "phase":format!("{:?}",run.phase),"targetMidi":run.displayed_prompt().targets.iter().map(|target|target.midi).collect::<Vec<_>>(),
        "promptCount":run.session.prompts().len(),"resultCount":run.session.results().len(),"correct":run.snapshot().correct,
        "responses":run.session.results().iter().map(|receipt|match &receipt.response{
            training_session::Response::Vocal(targets)=>serde_json::json!({"kind":"vocal","correct":receipt.correct,
                "targets":targets.iter().map(|target|serde_json::json!({"index":target.index,"classification":format!("{:?}",target.classification),
                    "voicedCoverage":target.metrics.voiced_coverage,"detectedMidi":target.metrics.detected_midi,
                    "medianCentsError":target.metrics.median_cents_error,"stableHoldRatio":target.metrics.stable_hold_ratio})).collect::<Vec<_>>()}),
            training_session::Response::Identify(answer)=>serde_json::json!({"kind":"identify","correct":receipt.correct,"answer":format!("{answer:?}")}),
            training_session::Response::Skipped=>serde_json::json!({"kind":"skipped","correct":receipt.correct}),
        }).collect::<Vec<_>>() }));
    serde_json::json!({"phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),
        "keyboard":p.training.read(cx).keyboard_state(w,cx),"screenTraining":p.screen==Screen::Training,"projectLoaded":p.project.is_some(),
        "playing":p.playing,"seekCount":p.playhead.seek_count(),"micIntent":p.mic_intent.is_some(),"practice":practice,
        "capture":{"owner":p.mic_view.owner,"phase":format!("{:?}",p.mic_view.phase),"fixture":p.mic_view.fixture,
            "generation":p.mic_view.generation,"sequence":p.mic_view.sequence,"frequency":p.mic_view.frequency,"clarity":p.mic_view.clarity},
        "cue":p.training_last.as_ref().map(|s|serde_json::json!({"generation":s.generation,"active":s.active,
            "startHostNs":s.start_host_ns.to_string(),"endHostNs":s.end_host_ns.to_string(),
            "notes":s.notes.iter().map(|note|serde_json::json!({"midi":note.midi,"start":note.start,"end":note.end})).collect::<Vec<_>>() })),
        "trainingGeneration":p.training_test,"trainingSerial":p.training_serial,"trainingStopped":p.training_stopped,
        "ownersReleased":p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial,
        "hardwareInput":false,"liveFps":"unmeasured"})
}
fn capture(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&std::path::Path,name:&str)->anyhow::Result<()> {
    ui_training_run::draw(w,cx);
    anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Training keyboard capture activated window");
    let mut value=state(view.read(cx),w,cx,name);let image=w.render_to_image()?;
    value["raster"]=serde_json::json!([image.width(),image.height()]);
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some(),"Training keyboard needs hidden/muted native PCM replay");
            std::fs::create_dir_all(&out)?;
            let mut steps=vec![];let mut receipts=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Training keyboard hidden/error invariant: {:?}",$p.notice);
                        if let Some(run)=&$p.practice{anyhow::ensure!(run.error.is_none(),"Training run failed: {:?}",run.error);}
                        Ok($condition)})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Training keyboard timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! press {($id:expr,$stroke:expr)=>{{handle.update(cx,|_,w,cx|activate(&view,w,cx,$id,$stroke))??;}};}
            macro_rules! record {($phase:expr)=>{steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?)};}
            wait!(15,p,w,app => p.backend.is_some()&&p.project.is_none()&&p.training_store_revision>0&&p.training.read(app).config("keyboard".into()).length==1);
            for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(10,p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|header_training(&view,w,cx))??;
                wait!(10,p,w,app => p.screen==Screen::Training&&p.training.read(app).snapshot().0==training::Route::Home);
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-exercise-0"))??;
                handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-keyboard-home-{}",width as u32)))??;
                // Exercise-specific segments/chips all use real Home cards.
                for(id,exercise)in[("training-exercise-1",training::Exercise::Degree),("training-exercise-4",training::Exercise::Arpeggio),("training-exercise-6",training::Exercise::Mixed)]{
                    press!(id,"enter");
                    wait!(10,p,w,app => p.training.read(app).snapshot().0==training::Route::Setup&&p.training.read(app).snapshot().1==exercise);
                    record!("home-exercise-card");press!("training-back","enter");
                }
                press!("training-exercise-2","enter");
                wait!(10,p,w,app => p.training.read(app).snapshot().1==training::Exercise::Interval);
                press!("training-direction-0","space");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).direction==training_domain::DirectionChoice::Ascending);
                let intervals=handle.update(cx,|_,_,cx|view.read(cx).training.read(cx).config("keyboard".into()).intervals)?;
                press!("training-interval-0","enter");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).intervals!=intervals);
                press!("training-interval-0","space");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).intervals==intervals);
                press!("training-back","enter");press!("training-exercise-3","space");
                wait!(10,p,w,app => p.training.read(app).snapshot().1==training::Exercise::Chord);
                let degrees=handle.update(cx,|_,_,cx|view.read(cx).training.read(cx).config("keyboard".into()).chord_degrees)?;
                press!("training-degree-0","space");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).chord_degrees!=degrees);
                press!("training-degree-0","enter");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).chord_degrees==degrees);
                press!("training-back","enter");press!("training-exercise-0","enter");
                press!("training-task-2","space");
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).task==training_domain::Task::Identify);
                press!("training-back","enter");press!("training-exercise-5","enter");
                wait!(10,p,w,app => p.training.read(app).snapshot().1==training::Exercise::Scale&&p.training.read(app).config("keyboard".into()).task==training_domain::Task::Imitate);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{tab_to(&view,w,cx,"training-task-0")?;
                    let state=view.read(cx).training.read(cx).keyboard_state(w,cx);let order=state["focusOrder"].as_array().unwrap();
                    anyhow::ensure!(!order.iter().any(|id|id=="training-task-1"||id=="training-task-2"),"Scale exposes disabled task in Tab order");
                    key(w,cx,"tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(!matches!(view.read(cx).training.read(cx).focused_control(w).as_deref(),Some("training-task-1"|"training-task-2")),"Tab entered disabled Scale task");
                    key(w,cx,"shift-tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some("training-task-0"),"ShiftTab did not reverse enabled task traversal");Ok(())})??;
                record!("scale-disabled-task-recovery");
                press!("training-back","enter");press!("training-exercise-0","enter");
                // Select commit, Escape cancellation, and typeahead exercise
                // production menus without assigning any setup configuration.
                press!("training-key","enter");handle.update(cx,|_,w,cx|{key(w,cx,"end");key(w,cx,"escape");})?;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).tonic==0&&!p.training.read(app).popup_open());
                press!("training-key","space");handle.update(cx,|_,w,cx|{key(w,cx,"g");key(w,cx,"enter");})?;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).tonic==7);
                press!("training-key","enter");handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"enter");})?;
                press!("training-mode","enter");handle.update(cx,|_,w,cx|{key(w,cx,"end");key(w,cx,"enter");})?;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).minor);
                press!("training-mode","enter");handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"enter");})?;
                press!("training-sound","enter");handle.update(cx,|_,w,cx|{
                    let label=crate::i18n::t("training.sound.guitar");
                    for ch in label.split_whitespace().next().unwrap().to_lowercase().chars(){key(w,cx,&ch.to_string());}
                    key(w,cx,"enter");})?;
                wait!(5,p,w,app => p.training.read(app).practice_settings().0==2);
                press!("training-sound","enter");handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"enter");})?;
                press!("training-length","enter");handle.update(cx,|_,w,cx|key(w,cx,"end"))?;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{ui_training_run::draw(w,cx);
                    let screen=view.read(cx).training.read(cx);let state=screen.keyboard_state(w,cx);
                    let popup=state["popupBounds"].as_array().ok_or_else(||anyhow::anyhow!("Length popup has no actual bounds"))?;
                    let trigger=screen.bounds("training-length").ok_or_else(||anyhow::anyhow!("Length trigger has no actual bounds"))?;
                    let left=popup[0].as_f64().unwrap();let top=popup[1].as_f64().unwrap();
                    let right=left+popup[2].as_f64().unwrap();let bottom=top+popup[3].as_f64().unwrap();
                    anyhow::ensure!(left>=0.&&top>=0.&&right<=f32::from(w.viewport_size().width) as f64+1.
                        &&bottom<=f32::from(w.viewport_size().height) as f64+1.&&bottom<=f32::from(trigger.top()) as f64+1.,"Length popup is outside viewport or not above sticky footer trigger: {state}");
                    let options=state["selectorOptions"]["training-length"].as_array().unwrap();
                    anyhow::ensure!(state["popup"]=="training-length"&&state["menuIndex"].as_u64()==Some((options.len()-1) as u64)
                        &&state["menuScrollOffset"][1].as_f64().is_some_and(|y|y.is_finite()&&y<=0.),"Length popup End did not highlight/scroll to its last option: {state}");
                    capture(&view,w,cx,&out,&format!("training-keyboard-length-popup-{}",width as u32))})??;
                record!("length-popup-end-before-escape");
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).length==1);
                press!("training-length","enter");handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"enter");})?;
                // Dynamic range limits, Home/End, and bursts before repaint.
                handle.update(cx,|_,w,cx|{tab_to(&view,w,cx,"training-low")?;key(w,cx,"home");for _ in 0..21{key(w,cx,"right");}Ok::<_,anyhow::Error>(())})??;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).low==57);
                handle.update(cx,|_,w,cx|{tab_to(&view,w,cx,"training-high")?;key(w,cx,"end");Ok::<_,anyhow::Error>(())})??;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).high==84);
                handle.update(cx,|_,w,cx|key(w,cx,"home"))?;
                wait!(5,p,w,app => p.training.read(app).config("keyboard".into()).high==58);
                handle.update(cx,|_,w,cx|{tab_to(&view,w,cx,"training-volume")?;key(w,cx,"home");for _ in 0..3{key(w,cx,"right");}Ok::<_,anyhow::Error>(())})??;
                wait!(5,p,w,app => (p.training.read(app).practice_settings().1-0.35).abs()<0.0001);
                handle.update(cx,|_,w,cx|key(w,cx,"end"))?;
                wait!(5,p,w,app => (p.training.read(app).practice_settings().1-2.).abs()<0.0001);
                handle.update(cx,|_,w,cx|{key(w,cx,"home");for _ in 0..9{key(w,cx,"right");}})?;
                wait!(5,p,w,app => (p.training.read(app).practice_settings().1-0.65).abs()<0.0001);
                press!("training-tolerance-2","space");
                wait!(5,p,w,app => p.training.read(app).practice_settings().2==15.);
                press!("training-tolerance-1","enter");
                press!("training-task-0","enter");
                wait!(5,p,w,app => {let cfg=p.training.read(app).config("keyboard".into());cfg.tonic==0&&!cfg.minor&&cfg.low==57&&cfg.high==58&&cfg.length==1&&cfg.task==training_domain::Task::Imitate});
                record!("actual-setup-controls");
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-start"))??;
                handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-keyboard-setup-{}",width as u32)))??;
                // Test C4 creates only the actual standalone native cue owner.
                press!("training-test","enter");
                wait!(10,p,w,app => p.training_test.is_some_and(|generation|p.training_last.as_ref().is_some_and(|s|s.generation==generation&&s.active)));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);let cue=p.training_last.as_ref().unwrap();
                    anyhow::ensure!(p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&cue.notes.len()==1&&cue.notes[0].midi==60
                        &&cue.end_host_ns-cue.start_host_ns==2_750_000_000,"Test C4 opened capture or changed native cue timing");
                    capture(&view,w,cx,&out,&format!("training-keyboard-c4-{}",width as u32))})??;
                wait!(8,p,w,app => p.training_test.is_none()&&p.training_stopped>=p.training_serial&&p.mic_view.phase==microphone::Phase::Off);
                receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"c4-completed"))?);
                // The persisted length-one fixture is selected through the real
                // selector; Start and all musical settings use physical keys.
                press!("training-start","space");
                let deadline=Instant::now()+Duration::from_secs(35);let mut phases=std::collections::BTreeSet::new();let mut saw_replay=false;
                loop{cx.background_executor().timer(Duration::from_millis(15)).await;
                    let done=handle.update(cx,|_,w,cx|->anyhow::Result<bool>{ui_training_run::draw(w,cx);let p=view.read(cx);
                        anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none(),"Training keyboard run changed hidden state");
                        let run=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Actual keyboard Start did not create practice"))?;
                        anyhow::ensure!(run.error.is_none()&&run.session.prompts().len()==1&&run.displayed_prompt().targets.len()==1&&run.displayed_prompt().targets[0].midi==57,"Actual setup did not generate sole A3 target: {:?}",run.error);
                        phases.insert(format!("{:?}",run.phase));
                        if run.phase==training_run::Phase::Respond&&p.mic_view.owner==4{
                            anyhow::ensure!(p.mic_view.fixture,"Vocal keyboard test opened hardware capture");
                            if !saw_replay{receipts.push(state(p,w,cx,"vocal-replay-respond"));}saw_replay=true;
                        }
                        if run.phase==training_run::Phase::Summary{
                            anyhow::ensure!(run.session.results().len()==1&&run.snapshot().correct==1,"Vocal keyboard result missing or incorrect");
                            let training_session::Response::Vocal(targets)=&run.session.results()[0].response else{anyhow::bail!("Vocal keyboard result is not native vocal scoring");};
                            anyhow::ensure!(targets.len()==1&&targets[0].metrics.voiced_coverage.unwrap_or(0.)>0.85,"Insufficient native CREPE voiced evidence");return Ok(true);
                        }Ok(false)})??;
                    if done{break;}anyhow::ensure!(Instant::now()<deadline,"Keyboard vocal session timed out: {phases:?}");
                }
                anyhow::ensure!(saw_replay&&phases.contains("Cue")&&phases.contains("Respond")&&phases.contains("Summary"),"Incomplete native vocal lifecycle: {phases:?}");
                wait!(8,p,w,app => p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial);
                receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"vocal-summary"))?);
                handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-keyboard-summary-{}",width as u32)))??;
                // Running answer/summary buttons have not been keyboard ported.
                // These two app-local pointer paths are explicitly outside the
                // Home/setup keyboard qualification and use real controllers.
                handle.update(cx,|_,w,cx|ui_training_run::button(&view,w,cx,"training-run-back"))??;
                wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                press!("training-exercise-0","enter");press!("training-task-2","space");
                press!("training-start","enter");
                wait!(15,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Respond));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);let run=p.practice.as_ref().unwrap();
                    anyhow::ensure!(p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off&&run.displayed_prompt().targets[0].midi==57,"Identify opened capture or changed actual target");
                    ui_training_run::button(&view,w,cx,"training-answer-9")})??;
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Summary&&run.snapshot().correct==1));
                wait!(8,p,w,app => p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial);
                receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"identify-summary"))?);
                handle.update(cx,|_,w,cx|ui_training_run::button(&view,w,cx,"training-run-back"))??;
                wait!(8,p,w,app => p.practice.is_none()&&p.mic_view.phase==microphone::Phase::Off&&p.training_test.is_none()&&p.training_stopped>=p.training_serial);
                receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"ended"))?);
                record!("completed-viewport");
            }
            std::fs::write(out.join("keyboard-steps.json"),serde_json::to_vec_pretty(&steps)?)?;
            std::fs::write(out.join("training-keyboard.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualHeaderTab":true,"exerciseCards":true,"tabAndShiftTab":true,"selectorsCommitCancel":true,"typeahead":true,
                "segmentsAndChips":true,"rangeKeysAndLimits":true,"focusedAutoscroll":true,"setupKeysContained":true,
                "selectorPopupAboveStickyFooter":true,
                "testC4NativeCue":true,"testC4WithoutCapture":true,"actualStart":true,"nativeCrepe":true,"vocalOnTarget":true,
                "summaryReleasesOwners":true,"identifyWithoutCapture":true,"identifyCorrect":true,"endedOwnersReleased":true,
                "sizes":[[1280,800],[1060,640]],"receipts":receipts,"hardwareInput":false,"pcmReplay":true,"liveFps":"unmeasured",
                "exerciseCardsCovered":["Note","Degree","Interval","Chord","Arpeggio","Scale","Mixed"],
                "runningResponseControlsKeyboardTested":false,"fixturePreparation":"Private persisted default preferences with length1; all musical setup/ranges/task/length selection and Start exercised through actual keys; A3 PCM replaces hardware capture only",
                "scope":"Home/setup native keyboard, real standalone native C4 cue, native PCM replay/CREPE/scoring and owner retirement; running Identify answer and summary Back use labelled app-local pointer paths, no physical microphone or audible-output qualification"}))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_KEYBOARD passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{
            eprintln!("TRAINING_KEYBOARD failed: {error:#}");let _=std::fs::create_dir_all(&out);
            let _=std::fs::write(out.join("training-keyboard-failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"training-keyboard-failure"));
            let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);
        }}
    }).detach();
}

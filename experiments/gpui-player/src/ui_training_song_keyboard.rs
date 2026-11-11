//! Actual hidden loaded-song preparation keys and native Identify completion.
//! Only fixture project opening uses a production host seam; all recipe,
//! setup, answer, summary and transport actions are real app-local input.
use super::*;
use std::{path::{Path,PathBuf},time::Duration};

fn key(w:&mut Window,cx:&mut App,name:&'static str){
    let stroke=Keystroke::parse(name).unwrap();w.dispatch_keystroke(stroke.clone(),cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn tab_to(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    let mut trace=vec![];
    for _ in 0..192 {
        ui_training_run::draw(w,cx);
        let p=view.read(cx);let screen=p.training.read(cx);
        if screen.focused_control(w).as_deref()==Some(id){
            let value=screen.keyboard_state(w,cx);
            let bounds=value["focusedBounds"].as_array().ok_or_else(||anyhow::anyhow!("Song Training focus missing actual bounds: {id}: {value}"))?;
            let left=bounds[0].as_f64().unwrap();let top=bounds[1].as_f64().unwrap();
            let right=left+bounds[2].as_f64().unwrap();let bottom=top+bounds[3].as_f64().unwrap();
            anyhow::ensure!(left>=0.&&top>=52.&&right<=f32::from(w.viewport_size().width) as f64+1.
                &&bottom<=f32::from(w.viewport_size().height) as f64+1.,"Focused song control clipped: {id}: {value}");
            return Ok(());
        }
        trace.push(screen.keyboard_state(w,cx));key(w,cx,"tab");
    }
    anyhow::bail!("Actual Tab did not reach song Training {id}: {}",serde_json::to_string(&trace)?)
}
fn press(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str,stroke:&'static str)->anyhow::Result<()> {
    tab_to(view,w,cx,id)?;key(w,cx,stroke);Ok(())
}
fn header(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..192 {ui_training_run::draw(w,cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref()==Some(id){key(w,cx,"enter");return Ok(());}
        key(w,cx,"tab");
    }
    anyhow::bail!("Song Training could not Tab to header {id}")
}
fn play(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    for _ in 0..256 {ui_training_run::draw(w,cx);
        if view.read(cx).transport.read(cx).focused_control(w).as_deref()==Some("transport-play"){
            key(w,cx,"enter");return Ok(());
        }key(w,cx,"tab");
    }
    anyhow::bail!("Native Play/Pause was not reachable after Back to Song")
}
fn state(p:&Player,w:&Window,cx:&App,phase:&str)->serde_json::Value {
    serde_json::json!({"phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),
        "keyboard":p.training.read(cx).keyboard_state(w,cx),"headerFocused":p.header.read(cx).focused_control(w),
        "screenTraining":p.screen==Screen::Training,"screenPlayer":p.screen==Screen::Player,
        "projectLoaded":p.project.is_some(),"projectPath":p.project.as_ref().map(|project|project.dir.to_string_lossy()),
        "keyRaw":p.project.as_ref().map(|project|project.raw["key"].clone()),
        "epoch":p.native_epoch,"transpose":p.transpose,"playing":p.playing,"position":p.playhead.position(),
        "preparationMatchesCurrent":p.training.read(cx).preparation_matches(Some(p.native_epoch)),
        "micIntent":p.mic_intent.is_some(),"capture":{"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"fixture":p.mic_view.fixture,"generation":p.mic_view.generation,"sequence":p.mic_view.sequence},
        "practice":p.practice.as_ref().map(|run|serde_json::json!({"phase":format!("{:?}",run.phase),
            "kind":format!("{:?}",run.displayed_prompt().kind),"task":format!("{:?}",run.displayed_prompt().task),
            "promptIndex":run.displayed_prompt().index,"promptCount":run.session.prompts().len(),"resultCount":run.session.results().len(),
            "targets":run.displayed_prompt().targets.iter().map(|target|serde_json::json!({"midi":target.midi,"degree":target.degree})).collect::<Vec<_>>(),
            "correct":run.snapshot().correct,"responses":run.session.results().iter().map(|receipt|match &receipt.response{
                training_session::Response::Identify(answer)=>serde_json::json!({"kind":"identify","answer":format!("{answer:?}"),"correct":receipt.correct,"promptIndex":receipt.prompt_index}),
                training_session::Response::Skipped=>serde_json::json!({"kind":"skipped"}),
                training_session::Response::Vocal(_)=>serde_json::json!({"kind":"vocal"}),
            }).collect::<Vec<_>>() })),
        "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"playing":s.playing,"position":s.position,"duration":s.duration,
            "transpose":s.transpose,"rate":s.rate,"trainingOnly":s.training_only,"masterGain":s.observed_master_gain,"graph":s.graph_generation})),
        "cue":p.training_last.as_ref().map(|s|serde_json::json!({"generation":s.generation,"active":s.active,
            "startHostNs":s.start_host_ns.to_string(),"endHostNs":s.end_host_ns.to_string(),
            "notes":s.notes.iter().map(|note|serde_json::json!({"midi":note.midi,"start":note.start,"end":note.end})).collect::<Vec<_>>() })),
        "trainingGeneration":p.training_test,"trainingSerial":p.training_serial,"trainingStopped":p.training_stopped,
        "ownersReleased":p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial,
        "hardwareInput":false,"pcmReplayUsed":false,"liveFps":"unmeasured"})
}
fn capture(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&Path,name:&str)->anyhow::Result<()> {
    ui_training_run::draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Song capture activated window");
    let mut value=state(view.read(cx),w,cx,name);let image=w.render_to_image()?;
    value["raster"]=serde_json::json!([image.width(),image.height()]);image.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
}
fn setup_first(p:&Player,cx:&App)->anyhow::Result<()> {
    anyhow::ensure!(p.practice.is_none()&&p.training_test.is_none()&&p.mic_intent.is_none()
        &&p.mic_view.phase==microphone::Phase::Off&&!p.playing
        &&p.training.read(cx).snapshot().0==training::Route::Setup,
        "Recipe bypassed setup or opened native training/capture before explicit Start");Ok(())
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App){
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),"Song keyboard test needs hidden, muted private configuration");
            std::fs::create_dir_all(&out)?;
            let known=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Known song fixture missing"))?);
            let unknown=PathBuf::from(std::env::var_os("SINGZ_GPUI_UNKNOWN_PROJECT").ok_or_else(||anyhow::anyhow!("Unknown-key song fixture missing"))?);
            let mut steps=vec![];let mut receipts=vec![];
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop{cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Song keyboard hidden/error invariant: {:?}",$p.notice);
                        anyhow::ensure!($p.mic_intent.is_none()&&$p.mic_view.phase==microphone::Phase::Off,"Identify-only song keyboard opened input owner");
                        if let Some(run)=&$p.practice{anyhow::ensure!(run.error.is_none(),"Song exercise failed: {:?}",run.error);}
                        Ok($condition)})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Song keyboard timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! press {($id:expr,$stroke:expr)=>{{handle.update(cx,|_,w,cx|press(&view,w,cx,$id,$stroke))??;}};}
            macro_rules! record {($phase:expr)=>{{steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! receipt {($phase:expr)=>{{receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! shot {($phase:expr,$width:expr)=>{{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-song-{}-{}",$phase,$width as u32)))??;}};}
            macro_rules! released {()=>{wait!(8,p,w,app => p.training_test.is_none()&&p.training_stopped>=p.training_serial)};}
            wait!(15,p,w,app => p.backend.is_some()&&p.training_store_revision>0);
            for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(known.clone(),cx)))?;
                wait!(30,p,w,app => !p.loading&&p.project.as_ref().is_some_and(|project|project.dir==known)
                    &&w.viewport_size()==size(px(width),px(height))&&p.last_playback_status.is_some());
                let source=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                handle.update(cx,|_,w,cx|play(&view,w,cx))??;
                wait!(8,p,w,app => p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>0.12));
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                wait!(8,p,w,app => p.screen==Screen::Training&&!p.playing
                    &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing)
                    &&p.training.read(app).keyboard_state(w,app)["song"]["source"].as_u64()==Some(source));
                // Nondefault chosen range is set using common range keys.
                // Recipe activation must preserve it and Identify task.
                press!("training-exercise-0","enter");
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    tab_to(&view,w,cx,"training-low")?;key(w,cx,"home");for _ in 0..13{key(w,cx,"right");}
                    tab_to(&view,w,cx,"training-high")?;key(w,cx,"end");for _ in 0..11{key(w,cx,"left");}Ok(())
                })??;
                press!("training-task-2","space");press!("training-back","enter");
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Home);
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    tab_to(&view,w,cx,"training-prepare-notes")?;
                    let value=view.read(cx).training.read(cx).keyboard_state(w,cx);
                    anyhow::ensure!(value["song"]["effectiveKey"]["tonic"]==1&&value["song"]["effectiveKey"]["minor"]==true
                        &&value["song"]["transpose"]==2,"Song key stamp/transpose was not admitted: {value}");
                    key(w,cx,"shift-tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).header.read(cx).focused_control(w).is_some(),"Song first-control ShiftTab did not reach header");
                    tab_to(&view,w,cx,"training-prepare-notes")?;key(w,cx,"tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).training.read(cx).focused_control(w).as_deref()==Some("training-prepare-intervals"),"Song recipe Tab order does not match paint order");
                    let order=value["focusOrder"].as_array().unwrap();let last=order.last().unwrap().as_str().unwrap().to_owned();
                    tab_to(&view,w,cx,&last)?;key(w,cx,"tab");ui_training_run::draw(w,cx);
                    anyhow::ensure!(view.read(cx).header.read(cx).focused_control(w).is_some(),"Song Home last-control Tab did not reach header");Ok(())
                })??;
                record!("song-boundaries");
                // Boundary traversal deliberately visits the final Home card.
                // Return by actual Tab to the song recipes before capturing
                // this state, so compact Home evidence includes its controls.
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    tab_to(&view,w,cx,"training-prepare-notes")?;
                    for id in ["notes","intervals","chords","mixed"] {
                        let id=format!("training-prepare-{id}");
                        let bounds=view.read(cx).training.read(cx).bounds(&id)
                            .ok_or_else(||anyhow::anyhow!("Home recipe has no actual bounds: {id}"))?;
                        anyhow::ensure!(bounds.left()>=px(0.)&&bounds.top()>=px(52.)
                            &&bounds.right()<=w.viewport_size().width&&bounds.bottom()<=w.viewport_size().height
                            &&bounds.size.width>px(0.)&&bounds.size.height>px(0.),
                            "Home recipe capture omits {id}: {bounds:?}");
                    }Ok(())
                })??;
                shot!("home",width);
                for(id,kind,length,choice)in[("chords",training_domain::Kind::Mixed,6,"Chords"),("mixed",training_domain::Kind::Mixed,8,"Mixed"),
                    ("intervals",training_domain::Kind::Interval,6,"Intervals"),("notes",training_domain::Kind::Degree,6,"Notes")]{
                    press!(&format!("training-prepare-{id}"),if id=="mixed"||id=="notes"{"space"}else{"enter"});
                    wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Setup);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                        let p=view.read(cx);setup_first(p,cx)?;let screen=p.training.read(cx);let config=screen.config("song-recipe".into());
                        let value=screen.keyboard_state(w,cx);
                        anyhow::ensure!(p.native_epoch==source&&p.transpose==2&&screen.preparation_matches(Some(source))
                            &&config.kind==kind&&config.length==length&&config.tonic==1&&config.minor&&config.low==49&&config.high==73
                            &&config.task==training_domain::Task::Identify&&value["preparation"]["choice"]==choice,
                            "Song recipe changed source/key/task/chosen range or setup length: {config:?}: {value}");
                        if id=="chords"{anyhow::ensure!(training_preparation::requirements(&config)==(false,true,true)
                            &&config.mixed_kinds==vec![training_domain::Kind::Chord,training_domain::Kind::Arpeggio],"Chord recipe includes unrelated kinds");}
                        tab_to(&view,w,cx,"training-start")?;Ok(())
                    })??;
                    record!(&format!("recipe-{id}-setup-first"));shot!(&format!("recipe-{id}"),width);
                    if id!="notes"{press!("training-back","enter");wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Home);}
                }
                press!("training-start","enter");
                let mut previous_generation=0;
                for prompt_index in 1..=6 {
                    wait!(20,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Respond&&r.displayed_prompt().index==prompt_index)
                        &&p.training.read(app).keyboard_state(w,app)["runPhase"]=="Respond");
                    let degree=handle.update(cx,|_,w,cx|->anyhow::Result<u8> {
                        let p=view.read(cx);let run=p.practice.as_ref().unwrap();let prompt=run.displayed_prompt();
                        let cue=p.training_last.as_ref().ok_or_else(||anyhow::anyhow!("Prepared Identify has no native cue receipt"))?;
                        anyhow::ensure!(run.session.prompts().len()==6&&run.session.results().len()==prompt_index-1
                            &&prompt.kind==training_domain::Kind::Degree&&prompt.task==training_domain::Task::Identify&&prompt.targets.len()==1
                            &&cue.generation>previous_generation&&Some(cue.generation)==p.training_test
                            &&cue.notes.iter().any(|note|note.midi==prompt.targets[0].midi)
                            &&p.native_epoch==source&&!p.playing&&p.transpose==2,"Prepared Identify native cue/target/owner mismatch");
                        previous_generation=cue.generation;
                        steps.push(state(p,w,cx,"native-prepared-respond"));Ok(prompt.targets[0].degree)
                    })??;
                    anyhow::ensure!((1..=7).contains(&degree),"Prepared target has invalid actual degree {degree}");
                    press!(&format!("training-answer-{}",degree-1),if prompt_index%2==0{"space"}else{"enter"});
                    wait!(8,p,w,app => p.practice.as_ref().is_some_and(|r|r.session.results().len()==prompt_index));
                    handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);let r=p.practice.as_ref().unwrap();let receipt=&r.session.results()[prompt_index-1];
                        anyhow::ensure!(r.session.results().len()==prompt_index&&receipt.prompt_index==prompt_index&&receipt.correct==Some(true)
                            &&matches!(&receipt.response,training_session::Response::Identify(training_session::Answer::Degree(value))if *value==degree),
                            "Prepared answer keyup duplicated or mismatched the real receipt");Ok(())})??;
                }
                wait!(8,p,w,app => p.practice.as_ref().is_some_and(|r|r.phase==training_run::Phase::Summary&&r.snapshot().correct==6)
                    &&p.training.read(app).keyboard_state(w,app)["runPhase"]=="Summary");
                released!();receipt!("prepared-summary");
                handle.update(cx,|_,w,cx|tab_to(&view,w,cx,"training-run-song"))??;shot!("summary",width);
                press!("training-run-song",if width==1280.{"enter"}else{"space"});
                wait!(8,p,w,app => p.screen==Screen::Player&&p.project.as_ref().is_some_and(|project|project.dir==known)
                    &&p.native_epoch==source&&!p.playing&&p.practice.is_none()
                    &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing&&s.transpose==2));
                released!();receipt!("returned-paused");
                let paused_position=handle.update(cx,|_,_,cx|view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                handle.update(cx,|_,w,cx|play(&view,w,cx))??;
                wait!(8,p,w,app => p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>paused_position+0.15&&s.transpose==2));
                receipt!("returned-playing");handle.update(cx,|_,w,cx|play(&view,w,cx))??;
                wait!(8,p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                receipt!("returned-repaused");
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                wait!(8,p,w,app => p.screen==Screen::Training&&p.training.read(app).snapshot().0==training::Route::Home);
                // Real pointer interaction still works after recipe keys.
                handle.update(cx,|_,w,cx|ui_training_run::button(&view,w,cx,"training-prepare-intervals"))??;
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Setup&&p.training.read(app).preparation_matches(Some(source)));
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(unknown.clone(),cx)))?;
                wait!(30,p,w,app => !p.loading&&p.project.as_ref().is_some_and(|project|project.dir==unknown)
                    &&p.native_epoch!=source&&!p.training.read(app).preparation_matches(Some(source))&&p.practice.is_none());
                handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                wait!(8,p,w,app => p.screen==Screen::Training&&p.training.read(app).snapshot().0==training::Route::Home
                    &&p.training.read(app).keyboard_state(w,app)["song"]["effectiveKey"].is_null()
                    &&p.training.read(app).keyboard_state(w,app)["song"]["source"].as_u64()==Some(p.native_epoch));
                shot!("unknown-home",width);press!("training-prepare-chords","space");
                wait!(8,p,w,app => p.training.read(app).snapshot().0==training::Route::Setup);
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {let p=view.read(cx);setup_first(p,cx)?;
                    let value=p.training.read(cx).keyboard_state(w,cx);
                    anyhow::ensure!(value["preparationNotice"]=="training.session.error.confirmKeyThenReview"
                        &&value["song"]["effectiveKey"].is_null()&&!p.training.read(cx).preparation_matches(Some(source)),
                        "Stale saved key bypassed explicit manual setup: {value}");tab_to(&view,w,cx,"training-key")?;Ok(())})??;
                shot!("unknown-setup",width);released!();receipt!("unknown-setup");
            }
            std::fs::write(out.join("keyboard-steps.json"),serde_json::to_vec_pretty(&steps)?)?;
            std::fs::write(out.join("training-song-keyboard.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualHeaderTab":true,"recipeKeys":true,"fourRecipes":true,"setupFirst":true,"keyStampAndTranspose":true,
                "chosenRangePreserved":true,"taskPreserved":true,"songBoundary":true,"sixPromptNativeIdentify":true,
                "singleAnswerReceipts":true,"summaryBackToPausedSong":true,"resumedNativePlayback":true,
                "replacementInvalidatesContext":true,"unknownKeyManualSetup":true,"pointerAfterKeyboard":true,"endedOwnersReleased":true,
                "sizes":[[1280,800],[1060,640]],"recipes":["Chords","Mixed","Intervals","Notes"],"chosenRange":[49,73],
                "recipeLengths":{"Chords":6,"Mixed":8,"Intervals":6,"Notes":6},"task":"Identify","receipts":receipts,
                "hardwareInput":false,"pcmReplayUsed":false,"liveFps":"unmeasured",
                "fixturePreparation":"Private known/stale-key song fixtures opened through production open_project; actual keys choose nondefault range49..73 and Identify; no config/prompt/focus assignments or shortened recipe fixture",
                "scope":"Song recipe and BackToSong keyboard, six actual prepared Degree Identify prompts, native cue receipts, retained paused source and real native playback after return; no microphone, audible-output, production-pixel or live-FPS qualification"
            }))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_SONG_KEYBOARD passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{
            eprintln!("TRAINING_SONG_KEYBOARD failed: {error:#}");let _=std::fs::create_dir_all(&out);
            let _=std::fs::write(out.join("training-song-keyboard-failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"training-song-keyboard-failure"));
            let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);
        }}
    }).detach();
}

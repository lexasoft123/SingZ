//! Real hidden Identify acknowledgement progression and replay-scored summary.
//! All actions use app-local keys; only supported persisted length2 and the
//! generated input PCM are fixtures. Presentation is the compositor's own view.
use super::*;
use crate::i18n::{Language,Locale};
use std::{path::{Path,PathBuf},time::Duration};

fn key(w:&mut Window,cx:&mut App,name:&'static str){
    let stroke=Keystroke::parse(name).unwrap();w.dispatch_keystroke(stroke.clone(),cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn tab_to(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    let mut trace=vec![];
    for _ in 0..192 {ui_training_run::draw(w,cx);let screen=view.read(cx).training.read(cx);
        if screen.focused_control(w).as_deref()==Some(id){
            let bounds=screen.bounds(id).ok_or_else(||anyhow::anyhow!("Feedback control not measured: {id}"))?;
            anyhow::ensure!(bounds.top()>=px(52.)&&bounds.bottom()<=w.viewport_size().height&&bounds.left()>=px(0.)&&bounds.right()<=w.viewport_size().width,
                "Feedback keyboard control clipped: {id}: {bounds:?}");return Ok(());
        }trace.push(screen.keyboard_state(w,cx));key(w,cx,"tab");
    }anyhow::bail!("Feedback actual Tab cannot reach {id}: {}",serde_json::to_string(&trace)?)
}
fn press(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str,stroke:&'static str)->anyhow::Result<()> {
    tab_to(view,w,cx,id)?;key(w,cx,stroke);Ok(())
}
fn header(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    for _ in 0..192 {ui_training_run::draw(w,cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref()==Some(id){key(w,cx,"enter");return Ok(());}
        key(w,cx,"tab");
    }anyhow::bail!("Feedback actual Tab cannot reach header {id}")
}
fn acknowledgement(p:&Player,cx:&App,prompt:usize,correct:bool,announce:bool)->anyhow::Result<()> {
    let value=p.training.read(cx).feedback_ui_state();let ack=&value["acknowledgement"];
    let heading=crate::i18n::t(if correct{"training.outcome.correct"}else{"training.feedback.identifyWrong.heading"});
    let detail=crate::i18n::t(if correct{"training.feedback.identifyCorrect.detail"}else{"training.feedback.identifyWrong.detail"});
    let run=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Acknowledgement has no actual session"))?;
    let completed=run.session.prompts().get(prompt-1).ok_or_else(||anyhow::anyhow!("Acknowledgement prompt is missing"))?;
    let note=completed.targets[0].note_name.trim_end_matches(|c:char|c.is_ascii_digit()).to_owned();
    let answer=crate::i18n::tv("training.identify.answerNote",&[("note",note)]);
    anyhow::ensure!(ack["promptIndex"].as_u64()==Some(prompt as u64)&&ack["heading"]==heading&&ack["detail"]==detail
        &&ack["answer"]==answer&&ack["good"]==correct&&ack["announce"]==announce&&ack["mark"]==if correct{"✓"}else{"↗"},
        "Actual acknowledgement text/result differs: {value}");
    for text in [heading,detail,answer]{anyhow::ensure!(!text.is_empty()&&!text.starts_with("training."),"Untranslated feedback text: {text}");}Ok(())
}
fn hidden_sequence(p:&Player,presentation:&serde_json::Value)->bool {
    let Some(run)=&p.practice else{return false;};
    let count=run.displayed_prompt().targets.len();
    if count==1 {
        // The compositor omits the sequence strip for a single target.
        presentation["currentSequenceText"].is_null()
    } else if count>1 {
        presentation["currentSequenceText"].as_array().is_some_and(|notes|notes.len()==count&&notes.iter().all(|note|note=="?"))
    } else {false}
}
fn default_native_fields(view:&microphone::View)->bool {
    // publish() assigns generation/revision and preserves timing separately.
    // All source, route and audio fields below are View::default() in control
    // intent placeholders; any populated native field needs fixture proof.
    view.sequence==0&&view.capture_host_ns==0&&view.detector_resets==0&&view.frame_age==Duration::ZERO
        &&view.sample_rate==0.&&view.buffer_frames==0&&view.channel==0&&view.channels==0
        &&view.label.is_empty()&&view.device.is_empty()&&view.frequency==0.&&view.clarity==0.
        &&view.rms==0.&&view.peak==0.&&view.post_rms==0.&&view.post_peak==0.&&view.gain==0.
        &&!view.monitor_enabled&&view.error.is_none()
}
fn pending_replay_transition(view:&microphone::View)->bool {
    // Service::start uses the requested owner4, worker Start uses owner0, and
    // Service::stop uses owner0. These exact all-default control intents are
    // unconfirmed transitions, never evidence that a native source opened.
    let control_intent=match view.phase {
        microphone::Phase::Starting=>matches!(view.owner,0|4),
        microphone::Phase::Stopping=>view.owner==0,
        _=>false,
    };
    control_intent&&!view.fixture&&default_native_fields(view)
}
fn validate_replay_capture(view:&microphone::View)->anyhow::Result<()> {
    if pending_replay_transition(view)||(view.phase==microphone::Phase::Off&&view.owner==0&&!view.fixture&&default_native_fields(view)){return Ok(());}
    anyhow::ensure!(view.fixture&&view.owner==4&&!view.monitor_enabled
        &&matches!(view.phase,microphone::Phase::Off|microphone::Phase::Starting|microphone::Phase::Live|microphone::Phase::Stopping),
        "Capture state lacks confirmed training replay-source proof: phase {:?}, owner {}, sequence {}, fixture {}, sampleRate {}, channels {}, device {:?}, error {:?}",
        view.phase,view.owner,view.sequence,view.fixture,view.sample_rate,view.channels,view.device,view.error);
    Ok(())
}
fn state(p:&Player,w:&Window,cx:&App,phase:&str)->serde_json::Value {
    let presentation=p.training.read(cx).feedback_ui_state();
    let ack_bounds=(!presentation["acknowledgement"].is_null()).then(||p.training.read(cx).bounds("training-result-ack")).flatten();
    let active_vocal=p.practice.as_ref().is_some_and(|run|run.displayed_prompt().task!=training_domain::Task::Identify
        &&matches!(run.phase,training_run::Phase::Respond|training_run::Phase::Completing));
    let recording_visible=p.practice.as_ref().is_some_and(|run|run.displayed_prompt().task!=training_domain::Task::Identify&&run.phase!=training_run::Phase::Summary);
    let bounds=|id:&str|p.training.read(cx).bounds(id).map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]);
    let practice=p.practice.as_ref().map(|run|{
        let responses=run.session.results().iter().map(|receipt|match &receipt.response{
            training_session::Response::Identify(answer)=>serde_json::json!({"kind":"identify","promptIndex":receipt.prompt_index,"correct":receipt.correct,"answer":format!("{answer:?}")}),
            training_session::Response::Vocal(targets)=>{
                let targets=targets.iter().map(|target|serde_json::json!({"classification":format!("{:?}",target.classification),"voicedCoverage":target.metrics.voiced_coverage,
                    "detectedMidi":target.metrics.detected_midi,"medianCentsError":target.metrics.median_cents_error,"stableHoldRatio":target.metrics.stable_hold_ratio})).collect::<Vec<_>>();
                serde_json::json!({"kind":"vocal","promptIndex":receipt.prompt_index,"correct":receipt.correct,"targets":targets})
            },
            training_session::Response::Skipped=>serde_json::json!({"kind":"skipped","promptIndex":receipt.prompt_index}),
        }).collect::<Vec<_>>();
        serde_json::json!({"phase":format!("{:?}",run.phase),"promptIndex":run.displayed_prompt().index,
            "promptCount":run.session.prompts().len(),"resultCount":run.session.results().len(),"correct":run.snapshot().correct,"attempts":run.snapshot().attempts,
            "targetMidi":run.displayed_prompt().targets.iter().map(|t|t.midi).collect::<Vec<_>>(),
            "promptTargetOrder":run.session.prompts().iter().map(|prompt|prompt.targets.iter().map(|target|target.midi).collect::<Vec<_>>()).collect::<Vec<_>>(),
            "responses":responses})
    });
    let history=p.training_store.as_ref().map(|store|{
        let s=store.snapshot();
        serde_json::json!({"revision":s.revision,"pending":s.pending,"error":s.error().map(str::to_owned),
            "sessions":s.aggregate.sessions,"attempts":s.aggregate.attempts,"onTarget":s.aggregate.on_target,"receipts":s.receipts})
    });
    let cue=p.training_last.as_ref().map(|s|{
        let notes=s.notes.iter().map(|note|serde_json::json!({"midi":note.midi,"start":note.start,"end":note.end})).collect::<Vec<_>>();
        serde_json::json!({"generation":s.generation,"active":s.active,"startHostNs":s.start_host_ns.to_string(),"endHostNs":s.end_host_ns.to_string(),"notes":notes})
    });
    let capture=serde_json::json!({"phase":format!("{:?}",p.mic_view.phase),"owner":p.mic_view.owner,"fixture":p.mic_view.fixture,"generation":p.mic_view.generation,"sequence":p.mic_view.sequence,
        "sourceProofPending":pending_replay_transition(&p.mic_view),"sourceProofConfirmed":p.mic_view.fixture&&p.mic_view.owner==4,
        "sampleRate":p.mic_view.sample_rate,"channels":p.mic_view.channels,"captureHostNs":p.mic_view.capture_host_ns.to_string(),"device":p.mic_view.device});
    serde_json::json!({"phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),
        "locale":p.language_state,"localePending":p.locale_service.snapshot().pending,"localeError":p.locale_service.snapshot().error,
        "presentation":presentation,"acknowledgementBounds":ack_bounds.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),
        "runwayBounds":active_vocal.then(||bounds("training-run-runway")).flatten(),
        "guidanceBounds":active_vocal.then(||bounds("training-run-guidance")).flatten(),
        "dockBounds":active_vocal.then(||bounds("training-run-dock")).flatten(),
        "recordingBarBounds":recording_visible.then(||bounds("training-recording-bar")).flatten(),
        "keyboard":p.training.read(cx).keyboard_state(w,cx),"screenTraining":p.screen==Screen::Training,
        "projectLoaded":p.project.is_some(),"playing":p.playing,"seekCount":p.playhead.seek_count(),"micIntent":p.mic_intent.is_some(),
        "practice":practice,"history":history,
        "capture":capture,
        "cue":cue,
        "trainingGeneration":p.training_test,"trainingSerial":p.training_serial,"trainingStopped":p.training_stopped,
        "ownersReleased":p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial,
        "hardwareInput":false,"pcmReplay":true,"liveFps":"unmeasured"})
}
fn vocal_geometry(p:&Player,w:&Window,cx:&App)->anyhow::Result<()> {
    let screen=p.training.read(cx);let value=screen.feedback_ui_state();
    anyhow::ensure!(value["phase"]=="Respond"&&value["currentPromptIndex"]==2&&value["acknowledgement"]["promptIndex"]==1,
        "Vocal Respond geometry lacks the real previous acknowledgement: {value}");
    let measured=|id:&str|->anyhow::Result<Bounds<Pixels>>{
        let b=screen.bounds(id).ok_or_else(||anyhow::anyhow!("Active vocal control not measured: {id}"))?;
        anyhow::ensure!(b.size.width>px(0.)&&b.size.height>px(0.)&&b.left()>=px(0.)&&b.top()>=px(52.)
            &&b.right()<=w.viewport_size().width&&b.bottom()<=w.viewport_size().height,
            "Active vocal control outside viewport: {id}: {b:?}");Ok(b)
    };
    let ack=measured("training-result-ack")?;let runway=measured("training-run-runway")?;
    let guidance=measured("training-run-guidance")?;let dock=measured("training-run-dock")?;
    anyhow::ensure!(ack.bottom()<=runway.top()&&guidance.bottom()<=dock.top(),
        "Retained acknowledgement overlaps vocal runway or guidance overlaps dock: ack {ack:?}, runway {runway:?}, guidance {guidance:?}, dock {dock:?}");
    if screen.bounds("training-recording-bar").is_some(){measured("training-recording-bar")?;}
    Ok(())
}
fn capture(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&Path,name:&str)->anyhow::Result<()> {
    ui_training_run::draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Feedback capture activated window");
    let mut value=state(view.read(cx),w,cx,name);
    if !value["presentation"]["acknowledgement"].is_null(){
        let bounds=value["acknowledgementBounds"].as_array().ok_or_else(||anyhow::anyhow!("Visible feedback has no measured banner: {value}"))?;
        let top=bounds[1].as_f64().unwrap();let bottom=top+bounds[3].as_f64().unwrap();
        anyhow::ensure!(top>=52.&&bottom<=f32::from(w.viewport_size().height) as f64+1.,"Feedback banner clipped: {value}");
    }
    let image=w.render_to_image()?;value["raster"]=serde_json::json!([image.width(),image.height()]);
    image.save(out.join(format!("{name}.png")))?;std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
}

pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App){
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some(),"Feedback test requires hidden/muted private PCM replay");
            std::fs::create_dir_all(&out)?;let mut steps=vec![];let mut receipts=vec![];let mut replay_seen=std::collections::BTreeSet::new();
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop{cx.background_executor().timer(Duration::from_millis(15)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Feedback hidden/error invariant: {:?}",$p.notice);
                        validate_replay_capture(&$p.mic_view)?;
                        if let Some(run)=&$p.practice{anyhow::ensure!(run.error.is_none(),"Feedback native run error: {:?}",run.error);}
                        Ok($condition)})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Feedback timeout {}: {}",stringify!($condition),handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,"timeout"))?);
                }
            }};}
            macro_rules! press {($id:expr,$stroke:expr)=>{{handle.update(cx,|_,w,cx|press(&view,w,cx,$id,$stroke))??;}};}
            macro_rules! record {($phase:expr)=>{{steps.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! receipt {($phase:expr)=>{{receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx,$phase))?);}};}
            macro_rules! shot {($phase:expr,$locale:expr,$width:expr)=>{{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("training-feedback-{}-{}-{}",$phase,$locale.as_str(),$width as u32)))??;}};}
            macro_rules! released {()=>{wait!(8,p,w,app => p.mic_view.phase==microphone::Phase::Off&&p.mic_intent.is_none()&&p.training_test.is_none()&&p.training_stopped>=p.training_serial)};}
            wait!(15,p,w,app => p.backend.is_some()&&p.project.is_none()&&p.training_store_revision>0&&p.language_state.is_some()
                &&p.training.read(app).config("feedback".into()).length==2);
            for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(8,p,w,app => w.viewport_size()==size(px(width),px(height)));
                for locale in [Locale::En,Locale::Ru]{
                    handle.update(cx,|_,w,cx|header(&view,w,cx,"header-language"))??;
                    wait!(8,p,w,app => p.language_menu.read(app).is_open()&&p.language_menu.read(app).state(w,app)["focusInside"]==true);
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                        key(w,cx,"home");let index=Language::ALL.iter().position(|language|*language==Language::Locale(locale)).unwrap();
                        for _ in 0..index{key(w,cx,"down");}ui_training_run::draw(w,cx);
                        anyhow::ensure!(view.read(cx).language_menu.read(cx).state(w,cx)["focusedIndex"].as_u64()==Some(index as u64),"Locale actual key selection did not reach target");
                        key(w,cx,"enter");Ok(())
                    })??;
                    wait!(8,p,w,app => !p.language_menu.read(app).is_open()&&p.language_state.is_some_and(|s|s.language==Language::Locale(locale))
                        &&!p.locale_service.snapshot().pending&&p.locale_service.snapshot().error.is_none());
                    handle.update(cx,|_,w,cx|header(&view,w,cx,"header-training"))??;
                    wait!(8,p,w,app => p.screen==Screen::Training&&p.training.read(app).snapshot().0==training::Route::Home);
                    press!("training-exercise-0","enter");
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                        tab_to(&view,w,cx,"training-low")?;key(w,cx,"home");for _ in 0..21{key(w,cx,"right");}
                        tab_to(&view,w,cx,"training-high")?;key(w,cx,"home");key(w,cx,"right");Ok(())
                    })??;
                    press!("training-task-2","space");
                    wait!(5,p,w,app => {let c=p.training.read(app).config("feedback".into());c.length==2&&c.low==57&&c.high==59&&c.task==training_domain::Task::Identify});
                    let before_sessions=handle.update(cx,|_,_,cx|view.read(cx).training_store.as_ref().unwrap().snapshot().aggregate.sessions)?;
                    press!("training-start","enter");
                    wait!(12,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Cue)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Cue"&&p.training_last.as_ref().is_some_and(|s|s.active&&Some(s.generation)==p.training_test));
                    handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);let value=p.training.read(cx).feedback_ui_state();
                        anyhow::ensure!(value["acknowledgement"].is_null()&&value["currentAnswerHidden"]==true&&value["currentTargetText"]=="?"
                            &&hidden_sequence(p,&value)&&p.mic_intent.is_none()
                            &&p.mic_view.phase==microphone::Phase::Off,"Unanswered Identify revealed a result or opened capture: {value}");Ok(())})??;
                    shot!("before",locale,width);
                    wait!(12,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Respond)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Respond");
                    let (first_generation,first_target,second_target)=handle.update(cx,|_,_,cx|->anyhow::Result<(u64,u8,u8)>{let p=view.read(cx);let r=p.practice.as_ref().unwrap();
                        anyhow::ensure!(r.session.prompts().len()==2&&r.session.results().is_empty(),"Wrong real Identify fixture");
                        let first=r.session.prompts()[0].targets[0].midi;let second=r.session.prompts()[1].targets[0].midi;
                        anyhow::ensure!([57,59].contains(&first)&&[57,59].contains(&second)&&first!=second,
                            "Identify deck did not produce distinct A3/B3 prompts: {first},{second}");
                        Ok((p.training_last.as_ref().unwrap().generation,first,second))})??;
                    press!("training-answer-0","enter");
                    wait!(8,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Feedback)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Feedback");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);acknowledgement(p,cx,1,false,true)?;
                        let r=p.practice.as_ref().unwrap();let value=p.training.read(cx).feedback_ui_state();
                        anyhow::ensure!(r.session.results().len()==1&&r.session.results()[0].correct==Some(false)
                            &&value["currentAnswerHidden"]==false&&value["currentTargetText"]==r.displayed_prompt().targets[0].note_name,
                            "Wrong answer receipt/reveal missing");Ok(())})??;
                    record!("wrong-feedback");shot!("wrong-feedback",locale,width);
                    wait!(12,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Cue&&run.displayed_prompt().index==2)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Cue"
                        &&p.training_last.as_ref().is_some_and(|s|s.generation>first_generation&&Some(s.generation)==p.training_test&&s.active));
                    handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);acknowledgement(p,cx,1,false,false)?;
                        let value=p.training.read(cx).feedback_ui_state();anyhow::ensure!(value["currentPromptIndex"]==2&&value["currentAnswerHidden"]==true&&value["currentTargetText"]=="?"
                            &&hidden_sequence(p,&value)
                            &&p.practice.as_ref().unwrap().displayed_prompt().targets[0].midi==second_target&&first_target!=second_target,
                            "Prior acknowledgement revealed current Cue answer: {value}");Ok(())})??;
                    record!("next-cue");shot!("next-cue",locale,width);
                    wait!(12,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Respond&&run.displayed_prompt().index==2)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Respond");
                    handle.update(cx,|_,_,cx|->anyhow::Result<()> {let p=view.read(cx);acknowledgement(p,cx,1,false,false)?;
                        let value=p.training.read(cx).feedback_ui_state();
                        anyhow::ensure!(value["currentAnswerHidden"]==true&&value["currentTargetText"]=="?"
                            &&hidden_sequence(p,&value)
                            &&p.mic_intent.is_none()&&p.mic_view.phase==microphone::Phase::Off,
                            "Next Identify response revealed current answer or opened input");Ok(())})??;
                    record!("next-respond");shot!("next-respond",locale,width);
                    press!(&format!("training-answer-{}",second_target%12),"space");
                    wait!(8,p,w,app => p.practice.as_ref().is_some_and(|run|run.phase==training_run::Phase::Summary)
                        &&p.training.read(app).feedback_ui_state()["phase"]=="Summary");released!();
                    wait!(8,p,w,app => p.training_store.as_ref().is_some_and(|store|{let s=store.snapshot();s.error().is_none()&&s.pending==0&&s.aggregate.sessions==before_sessions+1}));
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {let p=view.read(cx);acknowledgement(p,cx,2,true,false)?;
                        let r=p.practice.as_ref().unwrap();let value=p.training.read(cx).feedback_ui_state();
                        anyhow::ensure!(r.session.results().len()==2&&r.session.results()[0].correct==Some(false)&&r.session.results()[1].correct==Some(true)
                            &&r.snapshot().correct==1&&value["summary"]["pitchCopy"]==crate::i18n::t("training.summary.noPitchMetrics")
                            &&value["summary"]["averageSignedCents"].is_null(),"Identify summary did not retain exact two receipts and task copy: {value}");
                        let store=p.training_store.as_ref().unwrap().snapshot();let latest=store.receipts.iter().find(|receipt|receipt.session_id==r.session.id())
                            .ok_or_else(||anyhow::anyhow!("No persisted completion for the actual Identify session"))?;
                        anyhow::ensure!(latest.task_mode==training_domain::Task::Identify&&latest.aggregate.attempts==2&&latest.aggregate.on_target==1,
                            "Persisted Identify completion counts differ");
                        key(w,cx,"home");Ok(())})??;
                    receipt!("identify-summary");shot!("identify-summary",locale,width);press!("training-run-back","enter");
                    wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);
                    press!("training-exercise-0","space");
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {tab_to(&view,w,cx,"training-high")?;key(w,cx,"home");Ok(())})??;
                    wait!(5,p,w,app => {let c=p.training.read(app).config("feedback".into());c.length==2&&c.low==57&&c.high==58&&c.task==training_domain::Task::Imitate});
                    press!("training-start","space");
                    let deadline=Instant::now()+Duration::from_secs(45);
                    loop{cx.background_executor().timer(Duration::from_millis(15)).await;
                        let done=handle.update(cx,|_,w,cx|->anyhow::Result<bool>{ui_training_run::draw(w,cx);let p=view.read(cx);let r=p.practice.as_ref().ok_or_else(||anyhow::anyhow!("Vocal Start missing"))?;
                            anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none()&&r.error.is_none(),"Vocal feedback native/hidden invariant");
                            anyhow::ensure!(r.session.prompts().len()==2&&r.displayed_prompt().targets[0].midi==57,"Vocal test changed actual length/target");
                            validate_replay_capture(&p.mic_view)?;
                            let presentation=p.training.read(cx).feedback_ui_state();
                            let done=r.phase==training_run::Phase::Summary&&presentation["phase"]=="Summary";
                            if r.phase==training_run::Phase::Respond&&p.mic_view.owner==4&&p.mic_view.fixture&&p.mic_view.sequence>0
                                &&presentation["phase"]=="Respond"&&presentation["currentPromptIndex"].as_u64()==Some(r.displayed_prompt().index as u64) {
                                if replay_seen.insert((width as u32,locale.as_str(),r.displayed_prompt().index)){
                                    steps.push(state(p,w,cx,"vocal-replay-respond"));
                                    if r.displayed_prompt().index==2 {
                                        vocal_geometry(p,w,cx)?;
                                        capture(&view,w,cx,&out,&format!("training-feedback-vocal-respond-{}-{}",locale.as_str(),width as u32))?;
                                    }
                                }
                            }
                            Ok(done)
                        })??;
                        if done{break;}anyhow::ensure!(Instant::now()<deadline,"Vocal replay feedback did not finish");
                    }
                    released!();
                    wait!(8,p,w,app => p.training_store.as_ref().is_some_and(|store|{let s=store.snapshot();s.error().is_none()&&s.pending==0&&s.aggregate.sessions==before_sessions+2}));
                    handle.update(cx,|_,w,cx|->anyhow::Result<()> {let p=view.read(cx);let r=p.practice.as_ref().unwrap();let value=p.training.read(cx).feedback_ui_state();
                        anyhow::ensure!(r.session.results().len()==2&&r.snapshot().correct==2&&value["acknowledgement"]["promptIndex"]==2
                            &&value["acknowledgement"]["heading"]==crate::i18n::t("training.session.pitch.onTarget")
                            &&value["acknowledgement"]["detail"]==crate::i18n::t("training.feedback.onTarget.detail")
                            &&value["acknowledgement"]["answer"].is_null()&&value["acknowledgement"]["good"]==true
                            &&value["summary"]["pitchCopy"]==crate::i18n::t("training.summary.stayedInTune"),"Vocal final acknowledgement/task copy differs: {value}");
                        for receipt in r.session.results(){let training_session::Response::Vocal(targets)=&receipt.response else{anyhow::bail!("Vocal summary contains non-vocal receipt")};
                            anyhow::ensure!(targets.len()==1&&targets[0].classification==training_session::Classification::OnTarget
                                &&targets[0].metrics.voiced_coverage.unwrap_or(0.)>0.85,"Vocal summary lacks native OnTarget/voiced evidence");}
                        key(w,cx,"home");Ok(())})??;
                    receipt!("vocal-summary");shot!("vocal-summary",locale,width);press!("training-run-back","space");
                    wait!(8,p,w,app => p.practice.is_none()&&p.training.read(app).snapshot().0==training::Route::Home);released!();receipt!("ended");
                }
            }
            anyhow::ensure!(replay_seen.len()==8,"Missing actual native replay Respond for one or more prompts: {replay_seen:?}");
            std::fs::write(out.join("feedback-steps.json"),serde_json::to_vec_pretty(&steps)?)?;
            std::fs::write(out.join("training-feedback.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "actualLocaleControls":true,"persistedLengthTwo":true,"actualWrongAndCorrectKeys":true,"noPrematureReveal":true,
                "wrongFeedbackReveal":true,"acknowledgementPersists":true,"currentAnswerHiddenAfterAdvance":true,"finalSummaryAcknowledgement":true,
                "localizedTaskCopy":true,"exactIdentifyReceipts":true,"nativeCueReceipts":true,"nativeVocalOnTarget":true,"replayOnlyInput":true,"endedOwnersReleased":true,
                "sizes":[[1280,800],[1060,640]],"locales":["en","ru"],"receipts":receipts,"replayRespondPrompts":replay_seen.len(),
                "hardwareInput":false,"pcmReplay":true,"liveFps":"unmeasured",
                "identifyRange":[57,59],"vocalRange":[57,58],"distinctIdentifyTargets":true,
                "fixturePreparation":"Private supported persisted length2; actual keys choose distinct A3/B3 Identify deck and sole eligible A3 vocal range; A3 PCM replaces hardware capture only; no Run, receipt, focus or timing assignments",
                "scope":"Native wrong/correct Identify feedback progression, persisted completion and vocal CREPE OnTarget summary with actual English/Russian language controls; visual production parity, physical audio and live FPS remain unqualified"
            }))?)?;Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("TRAINING_FEEDBACK passed");let _=cx.update(|cx|cx.quit());},Err(error)=>{
            eprintln!("TRAINING_FEEDBACK failed: {error:#}");let _=std::fs::create_dir_all(&out);
            let _=std::fs::write(out.join("training-feedback-failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"training-feedback-failure"));
            let _=view.update(cx,|p,_|{p.backend.take();p.microphone.take();});std::process::exit(1);
        }}
    }).detach();
}

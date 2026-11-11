//! Q-04: connected, hidden analysis/lyrics qualification. No production hooks.
use super::ui_training_run::{click, draw};
use super::*;
use std::path::{Path, PathBuf};
use std::time::Duration;

fn raw(path: &Path) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn document(p: &Player) -> serde_json::Value {
    serde_json::json!({"source":p.lyric_document.source,"credit":p.lyric_document.credit,
        "lines":p.lyric_document.lines.iter().map(|l|serde_json::json!({"text":l.text,"start":l.start,"end":l.end,
            "words":l.words.iter().map(|w|serde_json::json!([w.text,w.start,w.end])).collect::<Vec<_>>() })).collect::<Vec<_>>()})
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let mut bounds = if id.starts_with("lyed-") {
        view.read(cx).lyrics_editor.read(cx).bounds(id)
    } else {
        view.read(cx).lyrics_sidebar.read(cx).bounds(id)
    }
    .ok_or_else(|| anyhow::anyhow!("Q-04 control absent: {id}"))?;
    if !id.starts_with("lyed-") {
        if let Some(body) = view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-body") {
            if bounds.center().y < body.top() || bounds.center().y > body.bottom() {
                w.dispatch_event(
                    PlatformInput::Scroll(ScrollEvent {
                        position: body.center(),
                        delta: ScrollDelta::Pixels(point(
                            px(0.),
                            body.center().y - bounds.center().y,
                        )),
                        ..Default::default()
                    }),
                    cx,
                );
                draw(w, cx);
                bounds = view
                    .read(cx)
                    .lyrics_sidebar
                    .read(cx)
                    .bounds(id)
                    .ok_or_else(|| anyhow::anyhow!("Sidebar control disappeared: {id}"))?;
            }
            anyhow::ensure!(
                body.contains(&bounds.center()),
                "Sidebar control outside scroll viewport: {id}"
            );
        }
    }
    anyhow::ensure!(
        bounds.size.width > px(0.)
            && bounds.size.height > px(0.)
            && bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= w.viewport_size().width
            && bounds.bottom() <= w.viewport_size().height,
        "Q-04 control outside viewport: {id}"
    );
    click(w, cx, bounds.center());
    Ok(())
}
fn gate(root: &Path, name: &str) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(root.join(format!("{name}.ready")));
    std::fs::write(
        root.join(format!("{name}.hold")),
        b"Q-04 deterministic barrier",
    )?;
    Ok(())
}
fn release(root: &Path, name: &str) -> anyhow::Result<()> {
    std::fs::remove_file(root.join(format!("{name}.hold")))?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_Q04_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing Q-04 fixtures"))?);
            let case=std::env::var("SINGZ_GPUI_Q04_CASE")?;
            let total=Instant::now()+Duration::from_secs(180);
            // Each wait is independently bounded; Python also owns the process
            // tree and enforces this deadline if the UI executor itself hangs.
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(35);
                loop {
                    anyhow::ensure!(Instant::now()<total,"Q-04 total deadline");
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                    if ready {break;}
                    if Instant::now()>=deadline {
                        let state=handle.update(cx,|_,w,app|{let p=view.read(app);serde_json::json!({"sidebar":p.lyrics_sidebar.read(app).state(w,app),"editor":p.lyrics_editor.read(app).state(w,app),"notice":p.notice,"karaoke":p.karaoke,"loading":p.loading,"pending":p.lyrics_flight.lyrics_sidebar})})?;
                        anyhow::bail!("Q-04 step timed out: {}; state={state}",stringify!($predicate));
                    }
                }
            }};}
            macro_rules! open {($name:expr)=>{{
                let path=root.join($name);
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
                wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|p|p.dir==path));
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! checked {($p:ident,$app:ident => $body:block)=>{handle.update(cx,|_,_, $app|->anyhow::Result<()>{let $p=view.read($app);$body Ok(())})??;};}
            macro_rules! settled {()=>{wait!(p,w,app => p.analysis_job.is_none()&&p.analysis_progress.is_none()&&p.beat_job.is_none()&&p.metronome_flight.metronome.is_none()&&!p.beat_auto_save&&!p.saving&&p.saved_seq==p.edit_seq);};}
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            let mut evidence=serde_json::json!({"case":case,"hidden":true,"muted":true});
            match case.as_str() {
                "pitch-switch" => {
                    gate(&root,"pitch")?;open!("a");
                    wait!(p,w,app => root.join("pitch.ready").is_file()&&p.analysis_job.is_some());
                    let a=std::fs::read(root.join("a/project.json"))?;
                    let b=raw(&root.join("b/project.json"))?;
                    let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
                    open!("b");release(&root,"pitch")?;settled!();
                    checked!(p,app => {
                        anyhow::ensure!(p.native_epoch!=epoch,"Pitch switch did not change epoch");
                        anyhow::ensure!(p.project.as_ref().unwrap().raw["settings"]["melody"]==b["settings"]["melody"],"Late pitch replaced B in memory");
                    });
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;settled!();
                    anyhow::ensure!(std::fs::read(root.join("a/project.json"))?==a,"Retired pitch auto-saved A");
                    anyhow::ensure!(raw(&root.join("b/project.json"))?["settings"]["melody"]==b["settings"]["melody"],"Late pitch auto-saved into B");
                }
                "lookup-switch"|"candidate-switch" => {
                    let candidate=case=="candidate-switch";
                    if !candidate {gate(&root,"http")?;}
                    open!("a");
                    if candidate {
                        wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none());
                        gate(&root,"http")?;
                        // Same event that a measured candidate Apply emits.
                        handle.update(cx,|_,_,cx|view.read(cx).lyrics_sidebar.clone().update(cx,|_,cx|cx.emit(lyrics_sidebar::Event::Apply(101))))?;
                    } else {
                        handle.update(cx,|_,_,cx|view.read(cx).lyrics_sidebar.clone().update(cx,|_,cx|cx.emit(lyrics_sidebar::Event::Retry)))?;
                    }
                    wait!(p,w,app => root.join("http.ready").is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
                    let pending=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;
                    let a=std::fs::read(root.join("a/lyrics.json"))?;
                    let b=std::fs::read(root.join("b/lyrics.json"))?;
                    // Revoke A while its real HTTP response is still withheld.
                    let other=root.join("b");
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(other.clone(),cx)))?;
                    wait!(p,w,app => p.native_epoch!=pending.0);
                    release(&root,"http")?;
                    wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|p|p.dir==other)&&p.lyrics_flight.lyrics_sidebar.is_none()&&p.lyrics_sidebar_settled.contains(&pending));
                    checked!(p,app => {
                        anyhow::ensure!(p.lyric_document.credit=="B credit"&&p.lyric_document.lines[0].text=="B stays here","Late lyrics painted B");
                        anyhow::ensure!(p.project.as_ref().unwrap().lyrics_raw.as_ref().unwrap()["credit"]=="B credit","Late lyrics adopted into B");
                    });
                    anyhow::ensure!(std::fs::read(root.join("a/lyrics.json"))?==a&&std::fs::read(root.join("b/lyrics.json"))?==b,"Late lookup/candidate persisted after switch");
                    evidence["settled"]=serde_json::json!(pending);
                }
                "rate-44100"|"rate-48000"|"beat-rate-44100"|"beat-rate-48000"|"stamp-old"|"stamp-string"|"stamp-float"|"stamp-future" => {
                    open!("a");
                    wait!(p,w,app => p.project.as_ref().is_some_and(|p|!project_analysis::needed(p)));
                    settled!();
                    let expected=raw(&root.join("expected.json"))?;
                    checked!(p,app => {
                        let project=p.project.as_ref().unwrap();
                        anyhow::ensure!(project.raw["settings"]["melody"]==expected["melody"],"Q-04 pitch frames/stamp differ from source-rate oracle: {}",project.raw["settings"]["melody"]);
                        anyhow::ensure!((project.pitch.analysis_duration()-40.8).abs()<0.001,"Wrong source-rate coverage");
                        anyhow::ensure!(Some(project.pitch.f0.len() as u64)==expected["frameCount"].as_u64(),"Wrong source-rate frame count");
                        anyhow::ensure!((project.pitch.hop-expected["melody"]["hopSec"].as_f64().unwrap()).abs()<1e-7,"Wrong source-rate hop");
                        anyhow::ensure!(project.raw["settings"]["key"]==expected["key"],"Key stamp downgraded");
                        anyhow::ensure!(p.beats.as_ref().unwrap().det_version==expected["beatVersion"].as_f64(),"Beat numeric stamp not preserved");
                        if let Some(times)=expected.get("beatTimes") {
                            anyhow::ensure!(serde_json::json!(p.beats.as_ref().unwrap().beats)==*times,"Beat source-rate frames differ from oracle");
                            anyhow::ensure!((p.beats.as_ref().unwrap().bpm-expected["bpm"].as_f64().unwrap()).abs()<1e-6,"Beat source-rate BPM/octave differs");
                        }
                    });
                    // An ordinary Save and a second project load must retain
                    // exact saved data, including fractional future versions.
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;settled!();
                    let saved=raw(&root.join("a/project.json"))?;
                    anyhow::ensure!(saved["settings"]["melody"]==expected["melody"]&&saved["settings"]["key"]==expected["key"],"Saved analysis stamp/frames changed");
                    anyhow::ensure!(saved["settings"]["beat"]["detVersion"].as_f64()==expected["beatVersion"].as_f64(),"Saved beat stamp changed");
                    open!("b");open!("a");settled!();
                    checked!(p,app => {anyhow::ensure!(p.project.as_ref().unwrap().raw["settings"]["melody"]==expected["melody"],"Reopen lost saved pitch");});
                    evidence["savedSettings"]=saved["settings"].clone();
                }
                "tolerant"|"edited-backup"|"unreadable-backup" => {
                    open!("a");
                    let original=std::fs::read(root.join("a/lyrics.json"))?;
                    handle.update(cx,|_,_,cx|view.read(cx).lyrics_sidebar.clone().update(cx,|_,cx|cx.emit(lyrics_sidebar::Event::Retry)))?;
                    wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none());
                    if case=="tolerant" {
                        checked!(p,app => {
                            anyhow::ensure!(p.lyric_document.lines.len()==1,"Tolerant load did not skip bad rows");
                            let words=&p.lyric_document.lines[0].words;
                            anyhow::ensure!(words.len()==2&&words[0].start==2.&&words[0].end==2.&&words[1].start==2.&&words[1].end==2.,"Tolerant load did not clamp backward/zero words");
                        });
                        handle.update(cx,|_,w,cx|view.update(cx,|p,cx|p.open_lyrics_editor(w,cx)))?;
                        wait!(p,w,app => p.lyrics_editor_open);
                        checked!(p,app => {anyhow::ensure!(p.lyrics_editor.read(app).rows().len()==1&&p.lyrics_editor.read(app).rows()[0].text=="Keep these words","Editor did not open normalized saved lyrics");});
                        anyhow::ensure!(std::fs::read(root.join("a/lyrics.json"))?==original,"Tolerant read rewrote saved lyrics");
                    } else {
                        checked!(p,app => {
                            if case=="edited-backup" {anyhow::ensure!(p.lyric_document.source=="edited"&&p.lyric_document.lines[0].text=="Keep these words","Auto replaced edited lyrics");}
                            else {anyhow::ensure!(p.project.as_ref().unwrap().lyrics_error.is_some(),"Unreadable lyrics were treated as missing");}
                        });
                        anyhow::ensure!(std::fs::read(root.join("a/lyrics.json"))?==original,"Auto overwrote protected lyrics");
                        handle.update(cx,|_,_,cx|view.read(cx).lyrics_sidebar.clone().update(cx,|_,cx|cx.emit(lyrics_sidebar::Event::Apply(101))))?;
                        wait!(p,w,app => p.lyric_document.credit=="Fixture artist — Selected recording"&&p.lyrics_flight.lyrics_sidebar.is_none());
                        anyhow::ensure!(std::fs::read(root.join("a/lyrics.json.bak"))?==b"existing backup","Replacement overwrote old backup");
                        anyhow::ensure!(std::fs::read(root.join("a/lyrics.json.bak.1"))?==original,"Replacement failed to back up exact protected bytes");
                        anyhow::ensure!(raw(&root.join("a/lyrics.json"))?["source"]=="lrclib","Explicit replacement did not save candidate");
                        open!("b");open!("a");wait!(p,w,app => p.lyric_document.credit=="Fixture artist — Selected recording");
                    }
                }
                "lyrics-cancel"|"align"|"precise-align"|"editor-align-draft" => {
                    open!("a");wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none());
                    let original=std::fs::read(root.join("a/lyrics.json"))?;
                    let shown=handle.update(cx,|_,_,cx|document(view.read(cx)))?;
                    let details=handle.update(cx,|_,w,cx|view.read(cx).lyrics_sidebar.read(cx).state(w,cx)["details"].clone())?;
                    if case=="editor-align-draft" {
                        handle.update(cx,|_,w,cx|view.update(cx,|p,cx|p.open_lyrics_editor(w,cx)))?;
                        wait!(p,w,app => p.lyrics_editor_open);
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let e=view.read(cx).lyrics_editor.read(cx);
                            let input=e.input(e.rows()[0].id).ok_or_else(||anyhow::anyhow!("Missing draft input"))?;
                            input.update(cx,|s,cx|{s.focus(w,cx);s.replace_all("The song is with you together".to_owned(),w,cx);});Ok(())})??;
                        wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="The song is with you together");
                        press!("lyed-align");
                        wait!(p,w,app => !p.lyrics_editor.read(app).busy&&p.lyrics_editor.read(app).state(w,app)["check"]["method"]=="qwen");
                        checked!(p,app => {
                            anyhow::ensure!(document(p)==shown,"Editor preview changed displayed lyrics");
                            anyhow::ensure!(p.lyrics_editor.read(app).rows()[0].text=="The song is with you together","Align ignored editor draft words");
                        });
                        anyhow::ensure!(std::fs::read(root.join("a/lyrics.json"))?==original,"Editor align-draft wrote before Save");
                        press!("lyed-save");wait!(p,w,app => p.lyrics_flight.lyrics_editor_pending.is_none()&&!p.lyrics_editor_open);
                        let saved=raw(&root.join("a/lyrics.json"))?;
                        anyhow::ensure!(saved["source"]=="edited"&&saved["lines"][0]["text"]=="The song is with you together","Editor aligned draft Save absent");
                    } else {
                        if case=="lyrics-cancel" {gate(&root,"align")?;}
                        if case=="precise-align" {wait!(p,w,app => p.lyrics_precise_cap);}
                        press!(if case=="precise-align" {"lyrics-precise"}else{"lyrics-align"});
                        if case=="lyrics-cancel" {
                            wait!(p,w,app => root.join("align.ready").is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
                            let pending=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;
                            press!("lyrics-cancel");release(&root,"align")?;
                            wait!(p,w,app => p.lyrics_sidebar_settled.contains(&pending)&&p.lyrics_flight.lyrics_sidebar.is_none());
                            checked!(p,app => {
                                anyhow::ensure!(document(p)==shown,"Cancel did not restore displayed lines");
                            });
                            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=view.read(cx).lyrics_sidebar.read(cx).state(w,cx);
                                anyhow::ensure!(s["status"]=="ready"&&s["showsLyrics"]==true&&s["details"]==details,"Cancel did not restore shown Ready details: {s}");Ok(())})??;
                            anyhow::ensure!(std::fs::read(root.join("a/lyrics.json"))?==original,"Cancelled alignment changed saved lyrics");
                        } else {
                            wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none()&&p.lyrics_sidebar.read(app).state(w,app)["details"]["check"]["method"]==(if case=="precise-align" {"ctc"}else{"qwen"}));
                            let saved=raw(&root.join("a/lyrics.json"))?;
                            anyhow::ensure!(saved["aligned"]==true&&saved["check"]["method"]==(if case=="precise-align" {"ctc"}else{"qwen"})&&std::fs::read(root.join("a/lyrics.json"))?!=original,"App Align did not persist");
                        }
                    }
                    if case!="lyrics-cancel" {
                        let saved=raw(&root.join("a/lyrics.json"))?;
                        let path=root.join("b");handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path,cx)))?;
                        wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|p|p.dir==root.join("b")));
                        open!("a");wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none());
                        checked!(p,app => {anyhow::ensure!(p.project.as_ref().unwrap().lyrics_raw.as_ref().unwrap()["lines"]==saved["lines"],"Reopen lost aligned lines");});
                    }
                }
                _=>anyhow::bail!("Unknown Q-04 case: {case}"),
            }
            handle.update(cx,|_,w,_|->anyhow::Result<()>{anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Q-04 window became visible/active");anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"Q-04 not muted");Ok(())})??;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&evidence)?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>{eprintln!("Q04 passed");let _=cx.update(|cx|cx.quit());}
            Err(error)=>{eprintln!("Q04 failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=view.update(cx,|p,_|{p.backend.take();});std::process::exit(1);}
        }
    }).detach();
}

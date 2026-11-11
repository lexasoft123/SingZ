//! Hidden actual sidebar controls, local LRCLIB and native model/publication paths.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn state(p: &Player, w: &Window, cx: &App) -> serde_json::Value {
    p.lyrics_sidebar.read(cx).state(w, cx)
}
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_keystroke(Keystroke::parse(value).unwrap(), cx);
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let mut bounds = view
        .read(cx)
        .lyrics_sidebar
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Sidebar control not measured: {id}"))?;
    if id != "lyrics-body" {
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
            anyhow::ensure!(body.contains(&bounds.center()),"Sidebar control {id} is outside its actual scroll viewport: {bounds:?} in {body:?}");
        }
    }
    anyhow::ensure!(
        bounds.size.width > px(0.)
            && bounds.size.height > px(0.)
            && bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= w.viewport_size().width
            && bounds.bottom() <= w.viewport_size().height,
        "Sidebar control outside content viewport: {id} {bounds:?}"
    );
    click(w, cx, bounds.center());
    Ok(())
}
fn query(view: &Entity<Player>, w: &mut Window, cx: &mut App, text: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let input = view.read(cx).lyrics_sidebar.read(cx).search_input();
    input.update(cx, |s, cx| {
        s.focus(w, cx);
        s.replace_all(text.to_owned(), w, cx);
        s.set_selected_range(text.len()..text.len(), cx);
    });
    Ok(())
}
fn raw(path: &Path) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn header_save(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get("save")
        .ok_or_else(|| anyhow::anyhow!("Actual header Save not measured"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Header Save outside viewport: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn editor_press(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .lyrics_editor
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Actual editor control absent: {id}"))?;
    click(w, cx, b.center());
    Ok(())
}
fn editor_type(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    text: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    let e = view.read(cx).lyrics_editor.read(cx);
    let first = e
        .rows()
        .first()
        .ok_or_else(|| anyhow::anyhow!("No editor rows"))?;
    let input = e
        .input(first.id)
        .ok_or_else(|| anyhow::anyhow!("First editor input not measured"))?;
    input.update(cx, |s, cx| {
        s.focus(w, cx);
        s.replace_all(text.to_owned(), w, cx);
    });
    Ok(())
}
fn control(root: &Path, download: &str, delay: u64) -> anyhow::Result<()> {
    let path = root.join("control.json");
    let temp = root.join("control-next.json");
    std::fs::write(
        &temp,
        serde_json::to_vec(
            &serde_json::json!({"download":download,"runtime":"success","delayMs":delay}),
        )?,
    )?;
    std::fs::rename(temp, path)?;
    Ok(())
}
fn count(root: &Path, file: &str, kind: Option<&str>) -> usize {
    std::fs::read_to_string(root.join(file))
        .unwrap_or_default()
        .lines()
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|r| kind.is_none_or(|kind| r["kind"] == kind))
        .count()
}
fn hold(root: &Path) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(root.join("http-ready.json"));
    let _ = std::fs::remove_file(root.join("http-finished.json"));
    std::fs::write(root.join("http-hold"), b"actual HTTP response gate")?;
    Ok(())
}
fn release(root: &Path) -> anyhow::Result<()> {
    std::fs::remove_file(root.join("http-hold"))?;
    Ok(())
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    expected: Option<(f32, f32)>,
) -> anyhow::Result<()> {
    draw(w, cx);
    if let Some((width, height)) = expected {
        anyhow::ensure!(
            w.viewport_size() == size(px(width), px(height)),
            "{name} captured at wrong viewport {:?}",
            w.viewport_size()
        );
    }
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Sidebar test presented or activated window"
    );
    let image = w.render_to_image()?;
    let viewport = w.viewport_size();
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (f32::from(viewport.width) * scale).round() as u32
            && image.height() == (f32::from(viewport.height) * scale).round() as u32,
        "{name} raster differs from logical viewport at {scale}"
    );
    image.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let value = serde_json::json!({"viewport":[f32::from(viewport.width),f32::from(viewport.height)],"expectedViewport":expected,"scale":scale,"raster":[image.width(),image.height()],
        "sidebar":state(p,w,cx),"project":p.project.as_ref().map(|p|p.dir.clone()),"epoch":p.native_epoch,"playing":p.playing,"position":p.playhead.position(),"nativeSeekCount":p.playhead.seek_count(),
        "pending":p.lyrics_flight.lyrics_sidebar.key(),"searchPending":p.lyrics_flight.lyrics_search_pending,"settled":p.lyrics_sidebar_settled,
        "windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "scope":if std::env::var("SINGZ_GPUI_LYRICS_QWEN_AUTO_UI").as_deref()==Ok("1") {
            "actual automatic production LRCLIB lookup and preinstalled native Qwen transcription/publication; no timing-quality or live-cadence claim"
        } else if std::env::var_os("SINGZ_GPUI_LYRICS_LIVE_TEST").is_some() {
            "actual sidebar controls and production LRCLIB HTTPS; precise inference is a separate subsequent phase"
        } else {"actual controls/HTTP/install/decoder/publication; deterministic inference protocols, no neural quality claim"},
        "visualReference":"candidate only; matching production capture absent","liveFps":"unmeasured: hidden static captures"});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    if std::env::var("SINGZ_GPUI_LYRICS_QWEN_AUTO_UI").as_deref()==Ok("1") {
        run_qwen_auto(handle,view,out,cx);
        return;
    }
    if std::env::var_os("SINGZ_GPUI_LYRICS_LIVE_TEST").is_some() {
        run_live(handle, view, out, cx);
        return;
    }
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_SIDEBAR_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing sidebar fixtures"))?);
            macro_rules! wait {($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(30);loop{
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let ok=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                if ok{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx))?;anyhow::bail!("Sidebar state timed out: {}; actual {actual}",stringify!($predicate));}
            }}};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! open {($name:expr)=>{{let path=root.join($name);handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.clone(),cx)))?;
                wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==path)&&state(p,w,app)["status"]=="ready"&&state(p,w,app)["showsLyrics"]==true);
                super::ui_training_run::settle_whats_new(handle,&view,cx).await?;
            }};}
            macro_rules! shot {($name:expr,$expected:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&$name,$expected))??;};}
            macro_rules! both {($name:expr)=>{{for(width,height)in[(1280.,800.),(1060.,640.)]{handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));shot!(format!("{}-{}",$name,width as i32),Some((width,height)));}}};}
            macro_rules! results {()=>{wait!(p,w,app=>state(p,w,app)["busy"]==false&&state(p,w,app)["results"].as_array().is_some_and(|r|r.len()==3));};}
            macro_rules! saved {()=>{wait!(p,w,app=>state(p,w,app)["status"]=="ready"&&state(p,w,app)["showsLyrics"]==true);};}
            macro_rules! quiet {()=>{{cx.background_executor().timer(Duration::from_millis(300)).await;handle.update(cx,|_,w,cx|draw(w,cx))?;}};}
            macro_rules! working {($target:expr,$copy:expr)=>{{
                let target=root.join($target);let(_,fingerprint)=project_store::read(&target,"project.json")?;
                let target=source_jobs::Target{dir:target.clone(),fingerprint,lyrics_fingerprint:lyrics_store::identity(&target)?};
                let working=root.join($copy);handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_source_output(source_jobs::Output{publication_hash:None,path:working.clone(),working:true,target:Some(target)},None,cx)))?;
                wait!(p,w,app=>!p.loading&&p.source_working&&p.project.as_ref().is_some_and(|p|p.dir==working)&&state(p,w,app)["status"]=="ready");
            }};}

            for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));let name=format!("project-{}",width as i32);open!(name.as_str());
                let folder=root.join(&name);let project_bytes=std::fs::read(folder.join("project.json"))?;let original=std::fs::read(folder.join("lyrics.json"))?;
                shot!(format!("source-{}",width as i32),Some((width,height)));
                press!("lyrics-edit");wait!(p,w,app=>p.lyrics_editor_open);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).lyrics_editor.read(cx).bounds("lyed-cancel").ok_or_else(||anyhow::anyhow!("Actual editor Cancel absent"))?;click(w,cx,b.center());Ok(())})??;
                wait!(p,w,app=>!p.lyrics_editor_open);
                press!("lyrics-change");wait!(p,w,app=>state(p,w,app)["view"]=="variants");results!();
                let before=count(&root,"requests.jsonl",None);press!("lyrics-back");saved!();press!("lyrics-change");results!();
                anyhow::ensure!(count(&root,"requests.jsonl",None)==before,"Back/Change repeated a cached search");
                let before=std::fs::read(folder.join("lyrics.json"))?;let http=count(&root,"requests.jsonl",None);press!("lyrics-variant-102");quiet!();
                anyhow::ensure!(std::fs::read(folder.join("lyrics.json"))?==before&&count(&root,"requests.jsonl",None)==http,"Text-only candidate accepted an Apply");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(view.read(cx),w,cx);let list=s["results"].as_array().unwrap();
                    anyhow::ensure!(list.iter().any(|c|c["id"]==101&&c["synced"]==true&&c["duration"].as_f64()==Some(12.))&&list.iter().any(|c|c["id"]==102&&c["synced"]==false)&&list.iter().any(|c|c["id"]==103&&c["duration"].as_f64()==Some(20.)),"Candidate match/synced facts lost: {s}");Ok(())})??;
                shot!(format!("variants-{}",width as i32),Some((width,height)));
                handle.update(cx,|_,w,cx|query(&view,w,cx,"artist"))??;
                let transport=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playing,p.playhead.position(),p.native_epoch,p.playhead.seek_count(),p.muted,p.solo,p.transpose,p.tempo)})?;
                for character in ["space","s","o","n","g"] {handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,character);})?;}
                wait!(p,w,app=>state(p,w,app)["query"]=="artist song");
                anyhow::ensure!(handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playing,p.playhead.position(),p.native_epoch,p.playhead.seek_count(),p.muted,p.solo,p.transpose,p.tempo)})?==transport,"Query typing/Space leaked into transport/mix");
                hold(&root)?;handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app=>root.join("http-ready.json").is_file()&&state(p,w,app)["busy"]==true&&state(p,w,app)["results"].is_null());
                shot!(format!("search-busy-{}",width as i32),Some((width,height)));
                let searches=count(&root,"requests.jsonl",None);press!("lyrics-search");quiet!();anyhow::ensure!(count(&root,"requests.jsonl",None)==searches,"Disabled Search repeated a pending request");
                release(&root)?;results!();
                handle.update(cx,|_,w,cx|query(&view,w,cx,"nothing"))??;press!("lyrics-search");
                wait!(p,w,app=>state(p,w,app)["busy"]==false&&state(p,w,app)["results"].as_array().is_some_and(Vec::is_empty));
                shot!(format!("no-results-{}",width as i32),Some((width,height)));
                handle.update(cx,|_,w,cx|query(&view,w,cx,"all"))??;press!("lyrics-search");results!();
                press!("lyrics-variant-101");wait!(p,w,app=>state(p,w,app)["showsLyrics"]==true&&state(p,w,app)["details"]["credit"]=="Fixture artist — Selected recording");
                let applied=raw(&folder.join("lyrics.json"))?;
                anyhow::ensure!(std::fs::read(folder.join("lyrics.json"))?!=original&&applied["source"]=="lrclib"&&applied["foreignLyrics"]["keep"]==true&&applied["lines"][0]["text"]=="The song is with you","Apply did not immediately persist candidate with unknown fields preserved");
                anyhow::ensure!(std::fs::read(folder.join("project.json"))?==project_bytes,"Candidate Apply changed project/mix settings");
                shot!(format!("applied-{}",width as i32),Some((width,height)));
            }

            open!("project-1280");let folder=root.join("project-1280");let initial=std::fs::read(folder.join("lyrics.json"))?;
            let previous=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx)["details"].clone())?;
            press!("lyrics-align");wait!(p,w,app=>state(p,w,app)["status"]=="consent");both!("speech-consent");
            press!("lyrics-manual");results!();press!("lyrics-back");wait!(p,w,app=>state(p,w,app)["status"]=="consent"&&state(p,w,app)["view"]=="lyrics");
            control(&root,"slow",0)?;let requests=count(&root,"requests.jsonl",None);press!("lyrics-download");
            wait!(p,w,app=>state(p,w,app)["status"]=="loading"&&count(&root,"requests.jsonl",None)>requests);
            press!("lyrics-cancel");saved!();
            anyhow::ensure!(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx)["details"].clone())?==previous&&std::fs::read(folder.join("lyrics.json"))?==initial,"Download Cancel did not restore exact saved Ready state");
            control(&root,"good",0)?;press!("lyrics-align");wait!(p,w,app=>state(p,w,app)["status"]=="consent");press!("lyrics-download");
            wait!(p,w,app=>state(p,w,app)["status"]=="ready"&&state(p,w,app)["details"]["check"]["method"]=="qwen");
            anyhow::ensure!(raw(&folder.join("lyrics.json"))?["aligned"]==true&&raw(&folder.join("lyrics.json"))?["check"]["method"]=="qwen","Sidebar Align previewed without publishing");both!("aligned");
            press!("lyrics-precise");wait!(p,w,app=>state(p,w,app)["status"]=="consent"&&state(p,w,app)["details"]["what"]=="aligner");both!("precise-consent");press!("lyrics-download");
            wait!(p,w,app=>state(p,w,app)["status"]=="ready"&&state(p,w,app)["details"]["check"]["method"]=="ctc");
            anyhow::ensure!(raw(&folder.join("lyrics.json"))?["check"]["method"]=="ctc","Sidebar Precise did not publish");both!("precise");
            let before=std::fs::read(folder.join("lyrics.json"))?;let previous=handle.update(cx,|_,w,cx|state(view.read(cx),w,cx)["details"].clone())?;
            control(&root,"good",5000)?;let calls=count(&root,"calls.jsonl",Some("crisp"));press!("lyrics-align");
            wait!(p,w,app=>state(p,w,app)["status"]=="loading"&&count(&root,"calls.jsonl",Some("crisp"))>calls);both!("alignment-busy");
            let cancelled=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().ok_or_else(||anyhow::anyhow!("Running alignment has no pending receipt")))??;
            let late_progress=std::rc::Rc::new(std::cell::RefCell::new(None::<anyhow::Result<serde_json::Value>>));
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                press(&view,w,cx,"lyrics-cancel")?;
                let sink=late_progress.clone();let player=view.clone();let expected=previous.clone();
                // Click emits Cancel through the real subscription. Defer to
                // the end of this SAME App effect cycle, after that event is
                // applied but before a timer can consume worker disposition.
                w.defer(cx,move|w,cx|{
                    let proof=player.update(cx,|p,cx|->anyhow::Result<serde_json::Value>{
                        let restored=state(p,w,cx);
                        anyhow::ensure!(p.lyrics_flight.lyrics_sidebar.key()==Some(cancelled),"Cancel discarded pending disposition before late-progress check");
                        anyhow::ensure!(p.native_epoch==cancelled.0&&!matches!(p.lyrics_sidebar_job,lyrics_resolution::Intent::Candidate(_)),"Late-progress check would be rejected by epoch/job guards instead of the cancelled Ready state");
                        anyhow::ensure!(restored["status"]=="ready"&&restored["details"]==expected&&restored["showsLyrics"]==true,"Actual Cancel did not restore previous Ready state before delayed progress: {restored}");
                        p.sidebar_progress(cancelled.0,cancelled.1,lyrics_align::Progress{stage:"transcribing".into(),percent:97.},cx);
                        let after=state(p,w,cx);
                        anyhow::ensure!(after["status"]=="ready"&&after["details"]==expected&&after["showsLyrics"]==true,"Same-serial late progress reopened cancelled loading or replaced prior details: {after}");
                        anyhow::ensure!(p.lyrics_flight.lyrics_sidebar.key()==Some(cancelled),"Ignoring late progress discarded final-result ownership");
                        Ok(serde_json::json!({"epoch":cancelled.0,"serial":cancelled.1,"sameAppEffectCycle":true,"pendingRetained":true,"injected":{"stage":"transcribing","percent":97},"before":restored,"after":after}))
                    });
                    *sink.borrow_mut()=Some(proof);
                });Ok(())
            })??;
            let proof=late_progress.borrow_mut().take().ok_or_else(||anyhow::anyhow!("Late-progress regression was not executed in the Cancel effect cycle"))??;
            std::fs::write(out.join("cancel-late-progress.json"),serde_json::to_vec_pretty(&proof)?)?;
            wait!(p,w,app=>p.lyrics_sidebar_settled.contains(&cancelled));saved!();
            anyhow::ensure!(std::fs::read(folder.join("lyrics.json"))?==before&&handle.update(cx,|_,w,cx|state(view.read(cx),w,cx)["details"].clone())?==previous,"Runtime Cancel changed lyrics or forgot previous check");

            let heard_path=folder.join("heard-words.json");let heard_bytes=std::fs::read(&heard_path)?;let mut mismatch:serde_json::Value=serde_json::from_slice(&heard_bytes)?;
            mismatch["chunks"][0]["text"]=serde_json::json!("Orange purple garden river mountain marble crystal wooden pencil paper stone silver yellow cloud");
            std::fs::write(&heard_path,serde_json::to_vec(&mismatch)?)?;control(&root,"good",0)?;
            let before=std::fs::read(folder.join("lyrics.json"))?;let calls=count(&root,"calls.jsonl",Some("crisp"));press!("lyrics-align");
            wait!(p,w,app=>state(p,w,app)["status"]=="ready"&&state(p,w,app)["details"]["check"]["verdict"]=="mismatch");
            anyhow::ensure!(std::fs::read(folder.join("lyrics.json"))?==before&&count(&root,"calls.jsonl",Some("crisp"))==calls,"Mismatch wrote lyrics or forced incorrect word timing");both!("mismatch");std::fs::write(&heard_path,heard_bytes)?;

            open!("cancel-http");let before=std::fs::read(root.join("cancel-http/lyrics.json"))?;press!("lyrics-change");results!();hold(&root)?;press!("lyrics-variant-101");
            wait!(p,w,app=>root.join("http-ready.json").is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
            let cancelled=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.cancel_sidebar_lyrics(cx)))?;release(&root)?;
            wait!(p,w,app=>p.lyrics_sidebar_settled.contains(&cancelled));saved!();
            anyhow::ensure!(std::fs::read(root.join("cancel-http/lyrics.json"))?==before,"Cancelled HTTP Apply wrote lyrics");
            open!("stale-http");let before=std::fs::read(root.join("stale-http/lyrics.json"))?;press!("lyrics-change");results!();hold(&root)?;press!("lyrics-variant-101");
            wait!(p,w,app=>root.join("http-ready.json").is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
            let stale=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
            let other=root.join("other");handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(other.clone(),cx)))?;
            wait!(p,w,app=>p.native_epoch!=epoch);release(&root)?;
            wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==other)&&state(p,w,app)["status"]=="ready"&&p.lyrics_sidebar_settled.contains(&stale));
            anyhow::ensure!(std::fs::read(root.join("stale-http/lyrics.json"))?==before&&raw(&root.join("other/lyrics.json"))?["credit"]=="other-credit","Stale HTTP candidate wrote or painted wrong song");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(view.read(cx),w,cx)["details"]["credit"]=="other-credit"&&state(view.read(cx),w,cx)["view"]=="lyrics","Late candidate changed current sidebar");Ok(())})??;both!("stale-http-ignored");

            open!("conflict");let path=root.join("conflict/lyrics.json");press!("lyrics-change");results!();hold(&root)?;press!("lyrics-variant-101");wait!(p,w,app=>root.join("http-ready.json").is_file());
            let mut external=raw(&path)?;external["externalChange"]=serde_json::json!("keep");std::fs::write(&path,serde_json::to_vec_pretty(&external)?)?;release(&root)?;
            wait!(p,w,app=>state(p,w,app)["status"]=="error"&&state(p,w,app)["busy"]==false);
            anyhow::ensure!(raw(&path)?==external&&handle.update(cx,|_,w,cx|state(view.read(cx),w,cx)["view"]=="variants")?,"Candidate conflict changed file or left variants");
            press!("lyrics-back");both!("external-conflict");press!("lyrics-retry");wait!(p,w,app=>state(p,w,app)["status"]=="error");
            anyhow::ensure!(raw(&path)?==external,"Retry overwrote externally changed lyrics");

            // Hold a genuinely committed candidate receipt. Cancellation may
            // stop more work, but cannot erase the new durable file identity.
            // Queue the editor in the same App turn to exercise its barrier.
            open!("postcommit");press!("lyrics-change");results!();
            let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE").ok_or_else(||anyhow::anyhow!("Missing resolver receipt gate"))?);
            let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold durable candidate receipt")?;
            press!("lyrics-variant-101");wait!(p,w,app=>ready.is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
            let receipt=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;
            let folder=root.join("postcommit");let committed=lyrics_store::identity(&folder)?;
            anyhow::ensure!(raw(&folder.join("lyrics.json"))?["credit"]=="Fixture artist — Selected recording","Receipt gate was not after the real commit");
            let queued=handle.update(cx,|_,w,cx|view.update(cx,|p,cx|{p.cancel_sidebar_lyrics(cx);p.open_lyrics_editor(w,cx);
                p.lyrics_flight.lyrics_sidebar.key()==Some(receipt)&&!p.lyrics_editor_open&&p.lyrics_sidebar_editor_after}))?;
            anyhow::ensure!(queued,"Editor crossed the unresolved committed-receipt barrier");
            wait!(p,w,app=>p.lyrics_flight.lyrics_sidebar.is_none()&&p.lyrics_sidebar_settled.contains(&receipt)&&p.lyrics_editor_open);
            let _=std::fs::remove_file(&gate);
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);
                anyhow::ensure!(p.project.as_ref().is_some_and(|p|p.lyrics_fingerprint==committed)&&p.lyric_document.credit=="Fixture artist — Selected recording"&&p.lyrics_editor.read(cx).rows()[0].text=="The song is with you","Cancelled committed receipt did not update document/fingerprint before opening editor");Ok(())})??;
            handle.update(cx,|_,w,cx|editor_type(&view,w,cx,"A later editor correction"))??;
            wait!(p,w,app=>p.lyrics_editor.read(app).rows()[0].text=="A later editor correction");
            handle.update(cx,|_,w,cx|editor_press(&view,w,cx,"lyed-save"))??;wait!(p,w,app=>!p.lyrics_editor_open);
            anyhow::ensure!(raw(&folder.join("lyrics.json"))?["lines"][0]["text"]=="A later editor correction","Editor Save failed against adopted committed fingerprint");
            shot!("postcommit-cancel-editor-save",Some((1060.,640.)));

            // A main Save accepted while Apply is pending must wait for the
            // actual publication receipt, then publish those latest lyrics.
            working!("working-target","working-copy");let target=root.join("working-target");let target_before=std::fs::read(target.join("lyrics.json"))?;
            press!("lyrics-change");results!();hold(&root)?;press!("lyrics-variant-104");
            wait!(p,w,app=>root.join("http-ready.json").is_file()&&p.lyrics_flight.lyrics_sidebar.is_some());
            let receipt=handle.update(cx,|_,_,cx|view.read(cx).lyrics_flight.lyrics_sidebar.key().unwrap())?;
            handle.update(cx,|_,w,cx|header_save(&view,w,cx))??;
            wait!(p,w,app=>p.metronome_flight.metronome_save_requested&&p.source_working&&p.source_job.is_none()&&p.lyrics_flight.lyrics_sidebar.key()==Some(receipt));
            anyhow::ensure!(std::fs::read(target.join("lyrics.json"))?==target_before,"Working-copy Save published before Apply resolved");
            release(&root)?;
            wait!(p,w,app=>p.lyrics_sidebar_settled.contains(&receipt)&&p.lyrics_flight.lyrics_sidebar.is_none()&&!p.loading&&!p.saving&&p.source_job.is_none()&&!p.source_working&&!p.metronome_flight.metronome_save_requested&&!p.metronome_flight.metronome_save_waiting&&p.project.as_ref().is_some_and(|p|p.dir==target));
            anyhow::ensure!(raw(&target.join("lyrics.json"))?["lines"][0]["text"]=="Selected words survive the saved copy","Queued working-copy Save published stale lyrics");
            open!("working-target");anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).lyric_document.lines[0].text.clone())?=="Selected words survive the saved copy","Reload lost queued Apply/Save lyrics");
            shot!("pending-apply-working-save",Some((1060.,640.)));

            // Queue two actual controls in one App update. Save is accepted
            // first; the candidate's deferred event then sees the blocking
            // source operation and must undo its optimistic busy indication.
            working!("blocked-target","blocked-copy");press!("lyrics-change");results!();
            let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_SOURCE_SAVE_PREPARE_GATE").ok_or_else(||anyhow::anyhow!("Missing Source Save gate"))?);
            let ready=gate.with_extension("ready");let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold accepted source save")?;
            let requests=count(&root,"requests.jsonl",None);
            let optimistic=handle.update(cx,|_,w,cx|->anyhow::Result<bool>{header_save(&view,w,cx)?;press(&view,w,cx,"lyrics-variant-101")?;Ok(state(view.read(cx),w,cx)["busy"]==true)})??;
            anyhow::ensure!(optimistic,"Actual candidate control did not queue its optimistic Apply");
            wait!(p,w,app=>ready.is_file()&&p.source_job.is_some()&&p.source_working&&p.lyrics_flight.lyrics_sidebar.is_none()&&state(p,w,app)["busy"]==false);
            anyhow::ensure!(count(&root,"requests.jsonl",None)==requests,"Apply began HTTP while Source Save blocked the song");
            std::fs::remove_file(&gate)?;let target=root.join("blocked-target");
            wait!(p,w,app=>!p.loading&&p.source_job.is_none()&&!p.source_working&&p.project.as_ref().is_some_and(|p|p.dir==target));
            anyhow::ensure!(raw(&target.join("lyrics.json"))?["credit"]=="keep-credit","Refused Apply replaced source-saved lyrics");
            shot!("blocked-save-apply-refused",Some((1060.,640.)));

            let folder=root.join("oversized");let original=std::fs::read(folder.join("lyrics.json"))?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(folder.clone(),cx)))?;
            wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==folder&&p.lyrics_error.is_some())&&state(p,w,app)["status"]=="error"&&p.duration>0.);
            both!("oversized-lyrics-playable");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Playable song lost transport"))?;click(w,cx,b.center());Ok(())})??;
            wait!(p,w,app=>p.playing&&p.playhead.position()>0.05);
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").unwrap();click(w,cx,b.center());Ok(())})??;
            wait!(p,w,app=>!p.playing&&!p.transport_flight.counting_in);
            anyhow::ensure!(std::fs::read(folder.join("lyrics.json"))?==original,"Opening/playing malformed oversized lyrics changed the file");

            open!("transcribe");let heard=root.join("transcribe/heard-words.json");if heard.exists(){std::fs::remove_file(heard)?;}
            control(&root,"good",2000)?;press!("lyrics-change");results!();press!("lyrics-transcribe");
            wait!(p,w,app=>state(p,w,app)["status"]=="loading"&&state(p,w,app)["view"]=="lyrics");both!("transcription-busy");
            wait!(p,w,app=>state(p,w,app)["status"]=="ready"&&state(p,w,app)["details"]["source"]=="whisper");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let s=view.read(cx).lyrics_sidebar.read(cx);anyhow::ensure!(s.bounds("lyrics-align").is_none()&&s.bounds("lyrics-precise").is_none()&&s.bounds("lyrics-edit").is_some()&&s.bounds("lyrics-change").is_some(),"Whisper exposed incompatible Align/Precise or lost source actions");Ok(())})??;
            anyhow::ensure!(raw(&root.join("transcribe/lyrics.json"))?["source"]=="whisper","Transcription did not publish");both!("whisper-ready");
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "twoSizes":true,"inlineChange":true,"realKeyboardSpaces":true,"searchEnter":true,"disabledTextOnly":true,"durationMatches":true,"emptyResults":true,"backCached":true,
                "immediateApply":true,"foreignMixPreserved":true,"editorAction":true,"consentCancelRestores":true,"alignPublishes":true,"precisePublishes":true,"runtimeCancel":true,"lateProgressAfterCancelIgnored":true,
                "transcribeReturnsProgress":true,"whisperActions":true,"mismatchNoWrite":true,"cancelHttpNoWrite":true,"staleHttpNoWrongSong":true,"externalConflict":true,"retryControl":true,"hidden":true,"muted":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
                "postcommitCancelAdopts":true,"queuedEditAfterReceipt":true,"editorSaveAfterCommittedCancel":true,"pendingApplyWorkingSave":true,"blockedSaveApplyRefused":true,"oversizedLyricsPlayable":true,
                "candidateCancellation":"production cancel_sidebar_lyrics method; source intentionally has no candidate Cancel button","inference":"deterministic native runner protocol fixtures, not neural quality"}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>eprintln!("NATIVE_LYRICS_SIDEBAR passed"),Err(error)=>{eprintln!("NATIVE_LYRICS_SIDEBAR failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",None));}}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

/// One licensed historical recording, one explicit live candidate, then the
/// already-proven real Precise editor flow with a verified installed model.
fn run_live(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref()==Ok("1") && !integration::fixture_mode(),
                "Live lyrics require hidden/muted native execution");
            let live_out=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_LIVE_TEST").unwrap());
            anyhow::ensure!(live_out.is_absolute()&&out.is_absolute()&&live_out==out,
                "LIVE_TEST must name the same absolute output as the sidebar startup hook");
            for name in ["SINGZ_GPUI_LRCLIB_URL", "SINGZ_GPUI_LYRICS_SIDEBAR_FIXTURES",
                "SINGZ_GPUI_LYRICS_ALIGN_FIXTURES", "SINGZ_GPUI_MODEL_FIXTURE",
                "SINGZ_GPUI_MODEL_CONTROL", "SINGZ_GPUI_SOURCE_CONTROL",
                "SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE", "SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE"] {
                anyhow::ensure!(std::env::var_os(name).is_none(), "Live lyrics refuse fixture override {name}");
            }
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_LYRICS_ALIGN_TEST").is_none(),
                "Live sidebar owns the Precise handoff; do not launch an alignment driver concurrently");
            anyhow::ensure!(std::env::var("SINGZ_GPUI_LYRICS_REAL_UI").as_deref()==Ok("1")
                && std::env::var("SINGZ_GPUI_LYRICS_REAL_PREINSTALLED").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_LYRICS_REAL_RESUME").is_none(),
                "Live lyrics require the verified preinstalled-model route, not failed-attempt resume");
            let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_REAL_PROJECT")
                .ok_or_else(||anyhow::anyhow!("Missing private live lyric project"))?).canonicalize()?;
            for name in ["SINGZ_GPUI_CONFIG_DIR", "SINGZ_MODELS_DIR", "SINGZ_GPUI_PROJECTS_ROOT"] {
                let value=PathBuf::from(std::env::var_os(name).ok_or_else(||anyhow::anyhow!("Missing private {name}"))?);
                anyhow::ensure!(value.is_absolute(),"Private live lyric storage must be absolute: {name}");
            }
            let query_text=std::env::var("SINGZ_GPUI_LYRICS_LIVE_QUERY")
                .map_err(|_|anyhow::anyhow!("Missing explicit live lyric search query"))?;
            anyhow::ensure!(!query_text.trim().is_empty()&&query_text.len()<=1024,
                "Live query must be explicit and bounded");
            let candidate_id=std::env::var("SINGZ_GPUI_LYRICS_LIVE_CANDIDATE_ID")?.parse::<u64>()?;
            anyhow::ensure!(candidate_id==12_618_083,"This journey selects the approved historical-recording candidate only");
            let lyrics_path=project.join("lyrics.json");
            let original=std::fs::read(&lyrics_path)?;
            let baseline:serde_json::Value=serde_json::from_slice(&original)?;
            anyhow::ensure!(baseline["source"]=="edited", "Seed an ordinary manual draft to keep automatic lookup separate from explicit live search");
            std::fs::create_dir_all(&out)?;
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(120);
                loop {
                    cx.background_executor().timer(Duration::from_millis(40)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{
                        let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active(),"Live lyric flow activated its window");
                        anyhow::ensure!($p.notice.is_none(),"Live lyric flow notice: {:?}",$p.notice);
                        Ok($predicate)
                    })??;
                    if ready{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Live lyric state timed out: {}",stringify!($predicate));
                }
            }};}
            handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));
                view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
            wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|loaded|loaded.dir==project));
            if !handle.update(cx,|_,_,cx|view.read(cx).karaoke)? {
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                    let b=view.read(cx).quick_start.read(cx).anchors.get("karaoke")
                        .ok_or_else(||anyhow::anyhow!("Karaoke control was not laid out"))?;
                    click(w,cx,b.center());Ok(())})??;
            }
            wait!(p,w,app => p.karaoke&&p.lyrics_flight.lyrics_sidebar.is_none()
                &&state(p,w,app)["status"]=="ready"&&state(p,w,app)["showsLyrics"]==true);
            handle.update(cx,|_,w,cx|press(&view,w,cx,"lyrics-change"))??;
            wait!(p,w,app => state(p,w,app)["view"]=="variants"&&!state(p,w,app)["busy"].as_bool().unwrap_or(true));
            handle.update(cx,|_,w,cx|query(&view,w,cx,&query_text))??;
            wait!(p,w,app => state(p,w,app)["query"].as_str()==Some(query_text.as_str()));
            handle.update(cx,|_,w,cx|press(&view,w,cx,"lyrics-search"))??;
            wait!(p,w,app => p.lyrics_flight.lyrics_search_pending.is_none()&&state(p,w,app)["busy"]==false
                &&state(p,w,app)["results"].as_array().is_some_and(|results|
                    results.iter().any(|candidate|candidate["id"].as_u64()==Some(candidate_id))));
            let candidate=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{
                let p=view.read(cx);let status=state(p,w,cx);
                let candidate=status["results"].as_array().and_then(|results|results.iter()
                    .find(|candidate|candidate["id"].as_u64()==Some(candidate_id)))
                    .ok_or_else(||anyhow::anyhow!("Explicit live candidate disappeared"))?.clone();
                anyhow::ensure!(candidate["synced"]==true
                    &&candidate["duration"].as_f64().is_some_and(|duration|duration.is_finite()&&(duration-p.duration as f64).abs()<=3.),
                    "Live candidate is not synchronized or does not match the full recording duration");
                anyhow::ensure!((p.duration-141.546).abs()<3.,"Live journey requires the full historical recording, not a shortened excerpt");
                Ok(candidate)
            })??;
            anyhow::ensure!(std::fs::read(&lyrics_path)?==original,"Opening/searching variants wrote project lyrics before selection");
            handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"live-search-variants",Some((1280.,800.))))??;
            handle.update(cx,|_,w,cx|press(&view,w,cx,&format!("lyrics-variant-{candidate_id}")))??;
            wait!(p,w,app => p.lyrics_flight.lyrics_sidebar.is_none()&&state(p,w,app)["status"]=="ready"
                &&state(p,w,app)["showsLyrics"]==true&&p.project.as_ref()
                    .and_then(|loaded|loaded.lyrics_raw.as_ref()).is_some_and(|raw|raw["source"]=="lrclib"));
            let saved_bytes=std::fs::read(&lyrics_path)?;
            let saved:serde_json::Value=serde_json::from_slice(&saved_bytes)?;
            let credit=[candidate["artist"].as_str(),candidate["track"].as_str()].into_iter()
                .flatten().filter(|part|!part.is_empty()).collect::<Vec<_>>().join(" — ");
            anyhow::ensure!(saved_bytes!=original&&saved["source"]=="lrclib"&&!credit.is_empty()
                &&saved["credit"]==credit&&saved["lines"].as_array().is_some_and(|lines|!lines.is_empty()),
                "Live candidate Apply did not immediately publish actual LRCLIB lyrics/credit");
            let lyrics_hash=project_store::fingerprint(&saved_bytes);
            // Precise's later explicit Save legitimately changes this project
            // file. Keep the exact live Apply payload bound by this receipt.
            std::fs::write(out.join("live-lyrics-selected.json"),&saved_bytes)?;
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);
                anyhow::ensure!(p.project.as_ref().and_then(|project|project.lyrics_fingerprint.as_deref())==Some(lyrics_hash.as_str()),
                    "Player did not accept the committed live lyric identity");
                shot(&view,w,cx,&out,"live-candidate-applied",Some((1280.,800.)))})??;
            std::fs::write(out.join("live-lyrics-search.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "productionEndpoint":"https://lrclib.net/api","query":query_text,"candidateId":candidate_id,"candidate":candidate,
                "candidateApplied":true,"immediatePublication":true,"headerSaveUsed":false,
                "lyricSource":"lrclib","credit":credit,"lyricsSha256":lyrics_hash,"lyricsBytes":saved_bytes.len(),
                "lyricsSnapshot":"live-lyrics-selected.json","project":project,
                "lineCount":saved["lines"].as_array().unwrap().len(),"hidden":true,"muted":true,
                "recordingSourceUrl":"https://commons.wikimedia.org/wiki/File:Auld_Lang_Syne.ogg",
                "historicalFullMixNotIsolatedStem":true,
                "scope":"actual production LRCLIB search/get and source-faithful immediate Apply publication; no separation-quality or visual-parity claim"
            }))?)?;
            eprintln!("LIVE_LYRICS applied candidate {candidate_id}; handing off real preinstalled-model Precise editor flow");
            cx.update(|cx|ui_lyrics_align::run(handle,view.clone(),out.join("precise"),cx));
            Ok(())
        }.await;
        if let Err(error)=result {
            eprintln!("LIVE_LYRICS failed: {error:#}");
            let _=std::fs::create_dir_all(&out);
            let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));
            let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"live-failure",None));
            cx.update(|cx|cx.quit());
        }
    }).detach();
}

fn qwen_auto_lines(raw:&serde_json::Value,duration:f64)->anyhow::Result<Vec<lyrics_edit::Line>> {
    let lines:Vec<lyrics_edit::Line>=serde_json::from_value(raw["lines"].clone())?;
    anyhow::ensure!(!lines.is_empty()&&duration.is_finite()&&duration>0.,"Automatic Qwen has no real lyric timeline");
    let mut words=0;
    for line in &lines {
        anyhow::ensure!(!line.text.trim().is_empty()&&line.start.is_finite()&&line.end.is_finite()
            &&line.start>=0.&&line.end>=line.start&&line.end<=duration+0.01&&!line.words.is_empty(),"Invalid automatic Qwen line");
        let mut previous=-1.;
        for word in &line.words {
            anyhow::ensure!(!word.w.trim().is_empty()&&word.s.is_finite()&&word.e.is_finite()
                &&word.s>=0.&&word.e>=word.s&&word.e<=duration+0.01&&word.s>=previous,"Invalid automatic Qwen word timing");
            previous=word.s;words+=1;
        }
    }
    anyhow::ensure!(words>0,"Automatic Qwen produced no timed words");Ok(lines)
}

/// A fresh no-lyrics song takes the actual LRCLIB Auto path. A live hit is a
/// valid production outcome, but explicitly bypasses Qwen qualification.
fn run_qwen_auto(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<bool>=async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var("SINGZ_NO_SYNC").as_deref()==Ok("1")
                &&!integration::fixture_mode(),"Automatic Qwen UI requires hidden/muted isolated native execution");
            for name in ["SINGZ_GPUI_LRCLIB_URL","SINGZ_GPUI_LYRICS_SIDEBAR_FIXTURES","SINGZ_GPUI_LYRICS_ALIGN_FIXTURES",
                "SINGZ_GPUI_MODEL_FIXTURE","SINGZ_GPUI_MODEL_CONTROL","SINGZ_GPUI_SOURCE_CONTROL","SINGZ_GPU_PACK_URL",
                "SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE","SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE",
                "SINGZ_GPUI_LYRICS_ALIGN_TEST","SINGZ_GPUI_LYRICS_LIVE_TEST"] {
                anyhow::ensure!(std::env::var_os(name).is_none(),"Automatic Qwen UI refuses override {name}");
            }
            let required=|name:&str|->anyhow::Result<PathBuf>{let p=PathBuf::from(std::env::var_os(name).ok_or_else(||anyhow::anyhow!("Missing {name}"))?);
                anyhow::ensure!(p.is_absolute(),"{name} must be absolute");Ok(p.canonicalize()?)};
            let project=required("SINGZ_GPUI_LYRICS_REAL_PROJECT")?;
            let library=required("SINGZ_GPUI_PROJECTS_ROOT")?;let config_dir=required("SINGZ_GPUI_CONFIG_DIR")?;
            anyhow::ensure!(project.parent()==Some(library.as_path())&&config_dir!=project&&config_dir!=library,"Automatic Qwen requires private library/config roots");
            for name in ["SINGZ_LLAMA_SERVER","SINGZ_CRISPASR"] {
                let path=required(name)?;anyhow::ensure!(std::fs::symlink_metadata(path)?.file_type().is_file(),"Actual native executable required: {name}");
            }
            anyhow::ensure!(std::env::var_os("SINGZ_MODELS_DIR").is_some(),"Actual preinstalled Qwen weights required");
            let config=model_catalog::Config::source();config.validate()?;
            anyhow::ensure!(lyrics_align::capability().can_align&&lyrics_align::needs_models(lyrics_align::Tier::Align).is_empty(),"Automatic Qwen requires installed real runtimes/models");
            std::fs::create_dir_all(&out)?;anyhow::ensure!(out.is_absolute()&&!out.canonicalize()?.starts_with(&project),"Automatic Qwen captures must be outside the project");
            let lyrics_path=project.join("lyrics.json");let heard_path=project.join("heard-words.json");
            anyhow::ensure!(!lyrics_path.try_exists()?&&!heard_path.try_exists()?,"Automatic Qwen must start without lyrics or heard cache");
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Automatic Qwen changed hidden state or raised {:?}",$p.notice);
                        Ok($condition)})??{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Automatic Qwen timeout: {}",stringify!($condition));
                }
            }};}
            macro_rules! both {($stem:expr)=>{{for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(30,p,w,app=>w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("{}-{}",$stem,width as u32),Some((width,height))))??;
            }}};}
            macro_rules! bypass {($first:expr,$current:expr,$inferred:expr,$reason:expr)=>{{
                both!("qwen-auto-lrclib-hit");
                std::fs::write(out.join("qwen-auto-result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                    "passed":false,"bypassed":true,"qwenQualified":false,"realInference":$inferred,"fixtureInference":false,
                    "bypassReason":$reason,"lookupOutcome":"hit","finalLookupOutcome":"hit","source":"lrclib","productionEndpoint":"https://lrclib.net/api",
                    "automaticPath":true,"manualTranscribe":false,"headerSave":false,"project":project,
                    "initialPublishedLyrics":$first,"publishedLyrics":$current,"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true}))?)?;
                return Ok(false);
            }};}
            handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
            wait!(90,p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project));
            let (vocal,vocal_size,vocal_modified,duration)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);let loaded=p.project.as_ref().unwrap();
                anyhow::ensure!(!p.karaoke&&!loaded.has_lyrics&&loaded.raw.get("songFile").is_none(),"Automatic Qwen needs a fresh song with Karaoke initially off and no legacy song cache");
                let vocal=loaded.lanes.iter().find(|(slot,_)|*slot==0).ok_or_else(||anyhow::anyhow!("Automatic Qwen fixture has no vocal"))?.1.clone();
                let meta=std::fs::symlink_metadata(&vocal)?;anyhow::ensure!(meta.file_type().is_file(),"Automatic Qwen vocal must be ordinary");
                Ok((vocal,meta.len(),meta.modified()?,p.duration as f64))})??;
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).guides.get("karaoke").ok_or_else(||anyhow::anyhow!("Actual Karaoke control missing"))?;
                click(w,cx,b.center());Ok(())})??;
            let deadline=Instant::now()+Duration::from_secs(900);let mut searching=false;let mut transcribing=false;
            let mut captured_searching=false;let mut captured_transcribing=false;let mut trace=vec![];let mut last=None;
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let snapshot=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{let p=view.read(cx);
                    anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none()&&p.karaoke,"Automatic Qwen lost hidden Karaoke state");
                    anyhow::ensure!(!p.lyrics_sidebar_download_waiting&&p.lyrics_sidebar_needs.is_empty(),"Automatic Qwen unexpectedly requested model download");
                    let s=state(p,w,cx);anyhow::ensure!(s["status"]!="error"&&s["status"]!="consent","Automatic Qwen failed: {s}");
                    Ok(serde_json::json!({"sidebar":s,"pending":p.lyrics_flight.lyrics_sidebar.key(),"settled":p.lyrics_sidebar_settled}))})??;
                let s=&snapshot["sidebar"];let stage=s["details"]["progress"]["stage"].as_str().unwrap_or("");
                searching|=s["status"]=="loading"&&stage=="searching"&&!snapshot["pending"].is_null();
                transcribing|=s["status"]=="loading"&&stage=="transcribing"&&!snapshot["pending"].is_null();
                if last.as_ref()!=Some(&snapshot){trace.push(snapshot.clone());last=Some(snapshot.clone());}
                if stage=="searching"&&!captured_searching {
                    captured_searching=handle.update(cx,|_,w,cx|->anyhow::Result<bool>{draw(w,cx);if state(view.read(cx),w,cx)["details"]["progress"]["stage"]!="searching"{return Ok(false);}
                        shot(&view,w,cx,&out,"qwen-auto-searching-1280",Some((1280.,800.)))?;Ok(true)})??;
                }
                if stage=="transcribing"&&!captured_transcribing {
                    captured_transcribing=handle.update(cx,|_,w,cx|->anyhow::Result<bool>{draw(w,cx);if state(view.read(cx),w,cx)["details"]["progress"]["stage"]!="transcribing"{return Ok(false);}
                        shot(&view,w,cx,&out,"qwen-auto-transcribing-1280",Some((1280.,800.)))?;Ok(true)})??;
                }
                if s["status"]=="ready"&&snapshot["pending"].is_null(){break;}
                anyhow::ensure!(Instant::now()<deadline,"Automatic Qwen lookup/transcription timed out");
            }
            let initial=raw(&lyrics_path)?;
            if initial["source"]=="lrclib" {
                anyhow::ensure!(!heard_path.try_exists()?,"LRCLIB hit unexpectedly populated Qwen heard cache");
                bypass!(initial.clone(),initial.clone(),false,"Live LRCLIB returned a usable hit");
            }
            anyhow::ensure!(searching&&transcribing,"Automatic Qwen did not expose Searching then Transcribing: searching={searching}, transcribing={transcribing}");
            anyhow::ensure!(initial["source"]=="whisper"&&initial["engine"]==lyrics_resolution::ENGINE
                &&initial["lookup"].as_u64()==Some(lyrics_resolution::LOOKUP_VERSION)&&initial["lrclibPending"].is_boolean(),"Automatic Qwen did not publish the production whisper/lookup format");
            let lookup=if initial["lrclibPending"]==true{"down"}else{"miss"};
            let initial_lines=qwen_auto_lines(&initial,duration)?;
            let cache_meta=std::fs::symlink_metadata(&heard_path)?;anyhow::ensure!(cache_meta.file_type().is_file()&&cache_meta.len()<=8*1024*1024,"Automatic Qwen heard cache is not bounded/ordinary");
            let heard=raw(&heard_path)?;let modified_ms=vocal_modified.duration_since(std::time::UNIX_EPOCH)?.as_secs_f64()*1000.;
            anyhow::ensure!(heard["version"]==1&&heard["engine"]==lyrics_resolution::ENGINE&&heard["vocals"]["size"].as_u64()==Some(vocal_size)
                &&heard["vocals"]["mtimeMs"].as_f64().is_some_and(|ms|(ms-modified_ms).abs()<=2.)
                &&heard["chunks"].as_array().is_some_and(|chunks|chunks.iter().any(|c|c["text"].as_str().is_some_and(|text|!text.trim().is_empty()))),"Automatic Qwen did not create fresh source-bound speech text");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);let sidebar=p.lyrics_sidebar.read(cx);
                anyhow::ensure!(sidebar.bounds("lyrics-edit").is_some()&&sidebar.bounds("lyrics-change").is_some()
                    &&sidebar.bounds("lyrics-align").is_none()&&sidebar.bounds("lyrics-precise").is_none(),"Automatic whisper Ready actions do not match source");Ok(())})??;
            both!("qwen-auto-ready");
            let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
            wait!(90,p,w,app=>!p.loading&&p.native_epoch>epoch&&p.project.as_ref().is_some_and(|s|s.dir==project));
            wait!(120,p,w,app=>p.karaoke&&p.lyrics_flight.lyrics_sidebar.is_none()&&state(p,w,app)["status"]=="ready");
            let published=raw(&lyrics_path)?;
            if published["source"]=="lrclib" {bypass!(initial.clone(),published.clone(),true,"Live LRCLIB returned a usable hit during reopen recheck");}
            let final_lines=qwen_auto_lines(&published,duration)?;
            anyhow::ensure!(published["source"]=="whisper"&&published["engine"]==lyrics_resolution::ENGINE
                &&published["lookup"].as_u64()==Some(lyrics_resolution::LOOKUP_VERSION)&&published["lrclibPending"].is_boolean()
                &&final_lines==initial_lines,"Automatic Qwen reload lost published word timings");
            let final_lookup=if published["lrclibPending"]==true{"down"}else{"miss"};
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Actual Play missing"))?;click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.audible_current&&s.position>0.02));
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").unwrap();click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app=>!p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
            both!("qwen-auto-reopened");
            let final_meta=std::fs::symlink_metadata(&vocal)?;anyhow::ensure!(final_meta.len()==vocal_size&&final_meta.modified()?==vocal_modified,"Automatic Qwen changed its vocal input");
            let mut result=serde_json::json!({"passed":true,"bypassed":false,"qwenQualified":true,"realInference":true,"fixtureInference":false,
                "automaticPath":true,"observedSearching":searching,"observedTranscribing":transcribing,"freshHeardCache":true,
                "automaticPublication":true,"reopenedPlayer":true,"nativePlayback":true,"whisperActions":true,
                "manualTranscribe":false,"headerSave":false,"editorSave":false,"productionEndpoint":"https://lrclib.net/api"});
            result.as_object_mut().unwrap().extend(serde_json::json!({"lookupOutcome":lookup,"finalLookupOutcome":final_lookup,"initialPublishedLyrics":initial,"publishedLyrics":published,"heardCache":heard,
                "project":project,"vocal":vocal,"wordCount":final_lines.iter().map(|line|line.words.len()).sum::<usize>(),
                "trace":trace,"capturedSearching":captured_searching,"capturedTranscribing":captured_transcribing,
                "sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"scope":"real automatic LRCLIB miss/down then native Qwen transcription/publication, reopen and muted native playback; no forced miss, protocol fixtures or singing-quality claim"}).as_object().unwrap().clone());
            std::fs::write(out.join("qwen-auto-result.json"),serde_json::to_vec_pretty(&result)?)?;Ok(true)
        }.await;
        match result {
            Ok(true)=>eprintln!("QWEN_AUTO real passed"),Ok(false)=>eprintln!("QWEN_AUTO LRCLIB bypass"),
            Err(error)=>{eprintln!("QWEN_AUTO real failed: {error:#}");let _=std::fs::create_dir_all(&out);
                let _=std::fs::write(out.join("qwen-auto-failure.txt"),format!("{error:#}"));
                let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"qwen-auto-failure",None));}
        }
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

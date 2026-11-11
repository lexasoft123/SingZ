//! Hidden editor controls connected to the real alignment/install runners.
//! Runtime fixtures speak production protocols; they do not validate NN quality.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn state(p: &Player, w: &Window, cx: &App) -> serde_json::Value {
    p.lyrics_editor.read(cx).state(w, cx)
}
fn rows(view: &Entity<Player>, cx: &App) -> Vec<lyrics_edit::DraftRow> {
    view.read(cx).lyrics_editor.read(cx).rows().to_vec()
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .lyrics_editor
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Unmeasured alignment control {id}"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Alignment control outside viewport: {id} {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn type_first(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    text: &str,
) -> anyhow::Result<()> {
    let e = view.read(cx).lyrics_editor.read(cx);
    let input = e
        .input(e.rows()[0].id)
        .ok_or_else(|| anyhow::anyhow!("Missing first row input"))?;
    input.update(cx, |s, cx| {
        s.focus(w, cx);
        s.replace_all(text.to_owned(), w, cx);
    });
    // Input change is delivered after the App update; do not render stale rows.
    Ok(())
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Alignment test presented or activated its window"
    );
    if let Some(width)=name.rsplit_once('-').and_then(|(_,width)|width.parse::<u32>().ok()).filter(|width|matches!(width,1060|1280)) {
        let expected=if width==1060 {size(px(1060.),px(640.))}else{size(px(1280.),px(800.))};
        anyhow::ensure!(w.viewport_size()==expected,"Alignment {name} captured before the requested viewport was accepted");
    }
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let expected=std::env::var("SINGZ_LANG").ok().and_then(|tag|i18n::from_tag(&tag)).unwrap_or(i18n::Locale::En);
    anyhow::ensure!(p.language_state.is_some_and(|state|state.locale==expected)&&i18n::current()==expected,"Alignment capture preceded accepted locale");
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&serde_json::json!({
        "locale":i18n::current().as_str(),"editorTitle":lyrics_editor::copy("title"),
        "viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "noteBars":p.pitch_strip.read(cx).note_bars(),"position":p.playhead.position(),
        "nativeSeekCount":p.playhead.seek_count(),"nativePosition":p.last_playback_status.as_ref().map(|s|s.position),
        "editor":state(p,w,cx),"editorOpen":p.lyrics_editor_open,"epoch":p.native_epoch,
        "windowPresented":w.is_visible(),"windowActive":w.is_window_active(),
        "reference":"candidate only; production reference absent; cadence unmeasured",
        "inference":if std::env::var("SINGZ_GPUI_LYRICS_QWEN_REAL_UI").as_deref()==Ok("1") {
            "real native Qwen recognition/alignment; preinstalled weights; no external timing-quality ground truth"
        } else if std::env::var("SINGZ_GPUI_LYRICS_REAL_UI").as_deref()==Ok("1") {
            "real native runtime and optional-model install/inference flow; no external timing-quality ground truth"
        } else {"deterministic protocol fixtures, not neural quality"}}))?,
    )?;
    Ok(())
}
fn control(root: &Path, download: &str, runtime: &str, delay: u64) -> anyhow::Result<()> {
    let path = root.join("control.json");
    let tmp = root.join("control-next.json");
    std::fs::write(
        &tmp,
        serde_json::to_vec(
            &serde_json::json!({"download":download,"runtime":runtime,"delayMs":delay}),
        )?,
    )?;
    std::fs::rename(tmp, path)?;
    Ok(())
}
fn count(root: &Path, log: &str, kind: Option<&str>) -> usize {
    std::fs::read_to_string(root.join(log))
        .unwrap_or_default()
        .lines()
        .filter_map(|s| serde_json::from_str::<serde_json::Value>(s).ok())
        .filter(|v| kind.is_none_or(|k| v["kind"] == k))
        .count()
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    if std::env::var("SINGZ_GPUI_LYRICS_QWEN_REAL_UI").as_deref() == Ok("1") {
        run_qwen_real(handle, view, out, cx);
        return;
    }
    if std::env::var("SINGZ_GPUI_LYRICS_REAL_UI").as_deref() == Ok("1") {
        run_real(handle, view, out, cx);
        return;
    }
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_ALIGN_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing alignment fixture root"))?);
            let project=root.join("project");let lyrics=std::fs::read(project.join("lyrics.json"))?;
            let metadata=std::fs::read(project.join("project.json"))?;
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(30);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                    if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Alignment state timed out: {}",stringify!($predicate));}
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&$name))??;};}
            macro_rules! both {($name:expr)=>{{for(width,height)in[(1280.,800.),(1060.,640.)]{
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                shot!(format!("{}-{}",$name,width as i32));}
            }};}
            macro_rules! unchanged {()=>{{anyhow::ensure!(std::fs::read(project.join("lyrics.json"))?==lyrics&&std::fs::read(project.join("project.json"))?==metadata,"Alignment preview wrote saved project files");}};}
            macro_rules! edit {()=>{{handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-edit").ok_or_else(||anyhow::anyhow!("Edit control not measured"))?;click(w,cx,b.center());Ok(())})??;
                wait!(p,w,app => p.lyrics_editor_open&&p.lyrics_editor.read(app).rows().len()==2);
            }};}
            macro_rules! reset {()=>{{
                press!("lyed-cancel");wait!(p,w,app => !p.lyrics_editor_open||state(p,w,app)["discard"]==true);
                if handle.update(cx,|_,_,cx|view.read(cx).lyrics_editor_open)?{press!("lyed-discard");wait!(p,w,app => !p.lyrics_editor_open);}
                edit!();
            }};}
            handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
            wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project));
            super::ui_training_run::settle_whats_new(handle,&view,cx).await?;
            // The sidebar job must settle before Edit is clickable.
            wait!(p,w,app => p.karaoke&&p.lyrics_flight.lyrics_sidebar.is_none()&&p.lyrics_sidebar.read(app).is_ready());edit!();

            press!("lyed-align");wait!(p,w,app => state(p,w,app)["consent"].is_array());
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(view.read(cx),w,cx);anyhow::ensure!(s["consent"][0]==false&&s["consent"][2]==false,"Wrong missing speech model consent");Ok(())})??;
            both!("speech-consent");press!("lyed-align-not-now");wait!(p,w,app => state(p,w,app)["consent"].is_null());
            anyhow::ensure!(count(&root,"requests.jsonl",None)==0,"Not now started a download");unchanged!();

            control(&root,"truncated","success",0)?;
            press!("lyed-align");wait!(p,w,app => state(p,w,app)["consent"].is_array());press!("lyed-align-download");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["error"].is_string());shot!("download-failure" );unchanged!();

            control(&root,"slow","success",0)?;let requests=count(&root,"requests.jsonl",None);
            press!("lyed-align");wait!(p,w,app => state(p,w,app)["consent"].is_array());press!("lyed-align-download");
            wait!(p,w,app => p.lyrics_editor.read(app).busy&&count(&root,"requests.jsonl",None)>requests);
            press!("lyed-align-cancel");wait!(p,w,app => !p.lyrics_editor.read(app).busy&&p.lyrics_flight.lyrics_download_pending.is_none());unchanged!();

            let requests=count(&root,"requests.jsonl",None);let crisp_before=count(&root,"calls.jsonl",Some("crisp"));
            press!("lyed-align");wait!(p,w,app => state(p,w,app)["consent"].is_array());press!("lyed-align-download");
            wait!(p,w,app => count(&root,"requests.jsonl",None)>requests&&p.lyrics_editor.read(app).busy);
            handle.update(cx,|_,w,cx|type_first(&view,w,cx,"New words during model download"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="New words during model download");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["error"].as_str().is_some_and(|s|s.contains("draft changed during")));
            anyhow::ensure!(count(&root,"calls.jsonl",Some("crisp"))==crisp_before,"Download continuation aligned a superseded draft");
            shot!("download-revision-guard");unchanged!();reset!();

            let before_preview=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            control(&root,"good","success",0)?;press!("lyed-align");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["check"]["method"]=="qwen");
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);let after=p.lyrics_editor.read(cx).rows();
                anyhow::ensure!(state(p,w,cx)["dirty"]==true&&after.len()==before_preview.len()
                    &&after.iter().zip(&before_preview).all(|(a,b)|a.text==b.text)
                    &&after.iter().zip(&before_preview).any(|(a,b)|a.start!=b.start||a.end!=b.end||a.words!=b.words),
                    "Qwen did not preserve lyric text while producing a dirty retimed preview");Ok(())})??;
            both!("qwen-preview");unchanged!();reset!();

            let before_failure=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            control(&root,"good","fail",0)?;press!("lyed-align");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["error"].is_string());
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx))?==before_failure,"Runtime failure replaced the draft");
            shot!("runtime-failure");control(&root,"good","success",0)?;press!("lyed-align");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["check"]["method"]=="qwen");reset!();

            let before_cancel=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            control(&root,"good","success",5000)?;let calls=count(&root,"calls.jsonl",Some("crisp"));press!("lyed-align");
            wait!(p,w,app => p.lyrics_editor.read(app).busy&&count(&root,"calls.jsonl",Some("crisp"))>calls);
            both!("qwen-busy");press!("lyed-align-cancel");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&p.lyrics_flight.lyrics_alignment.is_none());
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx))?==before_cancel,"Cancelled alignment replaced the draft");unchanged!();

            let warm=std::fs::read(root.join("heard-original.json"))?;let mut mismatch:serde_json::Value=serde_json::from_slice(&warm)?;
            mismatch["chunks"][0]["text"]=serde_json::json!("Orange purple garden river mountain marble crystal wooden pencil paper stone silver yellow cloud");
            std::fs::write(project.join("heard-words.json"),serde_json::to_vec(&mismatch)?)?;
            let before_mismatch=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            control(&root,"good","success",0)?;let calls=count(&root,"calls.jsonl",Some("crisp"));press!("lyed-align");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["check"]["verdict"]=="mismatch");
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx))?==before_mismatch&&count(&root,"calls.jsonl",Some("crisp"))==calls,"Mismatch retimed the manual draft or invoked forced alignment");
            both!("mismatch-retained");unchanged!();std::fs::write(project.join("heard-words.json"),&warm)?;

            press!("lyed-precise");wait!(p,w,app => state(p,w,app)["consent"].is_array());
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(view.read(cx),w,cx);anyhow::ensure!(s["consent"][0]==true&&s["consent"][2]==true,"Wrong missing precise model consent");Ok(())})??;
            both!("precise-consent");press!("lyed-align-download");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["check"]["method"]=="ctc");
            both!("precise-preview");unchanged!();reset!();
            let before_precise_cancel=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            control(&root,"good","success",5000)?;let calls=count(&root,"calls.jsonl",Some("precise"));press!("lyed-precise");
            wait!(p,w,app => p.lyrics_editor.read(app).busy&&count(&root,"calls.jsonl",Some("precise"))>calls);
            shot!("precise-busy");press!("lyed-align-cancel");wait!(p,w,app => !p.lyrics_editor.read(app).busy&&p.lyrics_flight.lyrics_alignment.is_none());
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx))?==before_precise_cancel,"Cancelled precise preview replaced draft");unchanged!();

            control(&root,"good","success",2000)?;let calls=count(&root,"calls.jsonl",Some("crisp"));press!("lyed-align");
            wait!(p,w,app => count(&root,"calls.jsonl",Some("crisp"))>calls&&p.lyrics_editor.read(app).busy);
            handle.update(cx,|_,w,cx|type_first(&view,w,cx,"Manual newer text must survive"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Manual newer text must survive");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["error"].as_str().is_some_and(|s|s.contains("draft changed while")));
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx)[0].text.clone())?=="Manual newer text must survive","Alignment replaced newer manual text");
            shot!("runtime-revision-guard");unchanged!();reset!();

            std::fs::remove_file(project.join("heard-words.json"))?;control(&root,"good","success",0)?;
            let calls=count(&root,"calls.jsonl",Some("asr-request"));press!("lyed-align");
            wait!(p,w,app => !p.lyrics_editor.read(app).busy&&state(p,w,app)["check"]["method"]=="qwen");
            anyhow::ensure!(count(&root,"calls.jsonl",Some("asr-request"))>calls&&project.join("heard-words.json").is_file(),"Uncached alignment did not use actual local ASR HTTP protocol");
            shot!("uncached-qwen-preview");unchanged!();
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "consent":true,"notNow":true,"downloadFailure":true,"downloadCancel":true,"downloadRevisionGuard":true,"downloadRetry":true,
                "qwenPreview":true,"runtimeFailureRetry":true,"runtimeCancel":true,"mismatchRetainsDraft":true,
                "preciseConsent":true,"precisePreview":true,"preciseCancel":true,"revisionGuard":true,"uncachedProtocol":true,
                "previewDoesNotWrite":true,"hidden":true,"muted":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
                "twoSizeCases":["speech-consent","qwen-preview","qwen-busy","mismatch-retained","precise-consent","precise-preview"],
                "scope":"real controls and protocol runners; deterministic inference fixtures; no neural quality claim"}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>eprintln!("NATIVE_LYRICS_ALIGN passed"),Err(error)=>{eprintln!("NATIVE_LYRICS_ALIGN failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"failure"));}}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

fn real_model_hash(path: &Path) -> anyhow::Result<String> {
    use sha2::{Digest, Sha256};
    use std::io::Read;
    let mut file = std::fs::File::open(path)?;
    let mut hash = Sha256::new();
    let mut block = vec![0; 1024 * 1024];
    loop {
        let count = file.read(&mut block)?;
        if count == 0 { break; }
        hash.update(&block[..count]);
    }
    Ok(hash.finalize().iter().map(|byte|format!("{byte:02x}")).collect())
}

fn real_lines(rows: &[lyrics_edit::DraftRow], duration: f64) -> anyhow::Result<Vec<lyrics_edit::Line>> {
    anyhow::ensure!(duration.is_finite() && duration > 0., "Invalid native vocal timeline");
    let mut word_count = 0;
    let mut positive = 0;
    for row in rows.iter().filter(|row| !row.text.trim().is_empty()) {
        let start = row.start.ok_or_else(|| anyhow::anyhow!("Untimed precise line"))?;
        let end = row.end.ok_or_else(|| anyhow::anyhow!("Untimed precise line end"))?;
        anyhow::ensure!(start.is_finite() && end.is_finite() && start >= 0. && end >= start && end <= duration + 0.01,
            "Precise line escaped the actual song timeline");
        let words = row.words.as_ref().ok_or_else(|| anyhow::anyhow!("Precise line has no word timings"))?;
        anyhow::ensure!(!words.is_empty(), "Precise line has an empty word timing list");
        let mut previous = -1.;
        for word in words {
            anyhow::ensure!(!word.w.trim().is_empty() && word.s.is_finite() && word.e.is_finite()
                && word.s >= 0. && word.e >= word.s && word.e <= duration + 0.01 && word.s >= previous,
                "Nonfinite, unordered or out-of-song precise word timing");
            previous = word.s;
            word_count += 1;
            positive += usize::from(word.e > word.s);
        }
    }
    anyhow::ensure!(word_count > 0 && positive > 0, "Precise inference produced no timed words");
    Ok(lyrics_edit::lines_from_rows(rows, duration))
}

fn real_same_lines(a: &[lyrics_edit::Line], b: &[lyrics_edit::Line]) -> bool {
    a.len() == b.len() && a.iter().zip(b).all(|(a,b)| a.text == b.text
        && (a.start-b.start).abs() < 1e-6 && (a.end-b.end).abs() < 1e-6
        && a.words.len() == b.words.len() && a.words.iter().zip(&b.words).all(|(a,b)|
            a.w == b.w && (a.s-b.s).abs() < 1e-6 && (a.e-b.e).abs() < 1e-6))
}

fn run_real(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref()==Ok("1") && !integration::fixture_mode(),
                "Real lyric UI requires hidden/muted native execution");
            for name in ["SINGZ_GPUI_LYRICS_ALIGN_FIXTURES", "SINGZ_GPUI_MODEL_FIXTURE",
                "SINGZ_GPUI_MODEL_CONTROL", "SINGZ_GPUI_SOURCE_CONTROL", "SINGZ_GPU_PACK_URL"] {
                anyhow::ensure!(std::env::var_os(name).is_none(), "Real lyric UI refuses {name}");
            }
            let project = PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_REAL_PROJECT")
                .ok_or_else(|| anyhow::anyhow!("Missing private real lyric project"))?).canonicalize()?;
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some()
                && std::env::var_os("SINGZ_MODELS_DIR").is_some()
                && std::env::var_os("SINGZ_GPUI_PROJECTS_ROOT").is_some(), "Private lyric config/model/library roots are required");
            let config = model_catalog::Config::source();
            config.validate()?;
            let caps = lyrics_align::capability();
            anyhow::ensure!(caps.can_precise, "Real splitter Python is unavailable");
            let entries = model_catalog::registry(caps.precise_flavor, "unused");
            let entry = entries.iter().find(|entry| entry.id == "aligner")
                .ok_or_else(|| anyhow::anyhow!("No production precise model for this pack flavor"))?;
            anyhow::ensure!(entry.parts.len() == 1, "Unexpected precise model catalog");
            let part = &entry.parts[0];
            let model = config.models.join(&part.file);
            let resume = std::env::var("SINGZ_GPUI_LYRICS_REAL_RESUME").as_deref()==Ok("1");
            let preinstalled = std::env::var("SINGZ_GPUI_LYRICS_REAL_PREINSTALLED").as_deref()==Ok("1");
            anyhow::ensure!(!(resume && preinstalled), "Preinstalled reuse and failed-run resume are separate modes");
            let download_receipt = out.join("real-model-download.json");
            let mut download_evidence: Option<serde_json::Value> = None;
            let mut prior_model_evidence = None;
            if preinstalled {
                let read_prior = |name: &str| -> anyhow::Result<(PathBuf, serde_json::Value)> {
                    let path = PathBuf::from(std::env::var_os(name)
                        .ok_or_else(||anyhow::anyhow!("Missing {name}"))?);
                    anyhow::ensure!(path.is_absolute(), "{name} requires an absolute receipt path");
                    let meta = std::fs::symlink_metadata(&path)?;
                    anyhow::ensure!(meta.file_type().is_file() && meta.len() <= 65536,
                        "Prior model evidence must be a bounded ordinary file");
                    let value = serde_json::from_slice(&std::fs::read(&path)?)?;
                    Ok((path.canonicalize()?, value))
                };
                let (download_path, prior) = read_prior("SINGZ_GPUI_LYRICS_REAL_PRIOR_DOWNLOAD_RECEIPT")?;
                let (result_path, success) = read_prior("SINGZ_GPUI_LYRICS_REAL_PRIOR_RESULT")?;
                let (exit_path, terminal) = read_prior("SINGZ_GPUI_LYRICS_REAL_PRIOR_EXIT")?;
                anyhow::ensure!(download_path.parent() == result_path.parent() && result_path.parent() == exit_path.parent(),
                    "Prior download, success and terminal receipts must belong to one run directory");
                anyhow::ensure!(std::fs::symlink_metadata(&model)?.file_type().is_file()
                    && model_install::valid_part(&model, part), "Preinstalled reuse requires a real ordinary model file");
                let model_path = model.canonicalize()?;
                let previous_model = PathBuf::from(prior["modelFile"].as_str()
                    .ok_or_else(||anyhow::anyhow!("Prior receipt has no model path"))?);
                anyhow::ensure!(previous_model.is_absolute() && previous_model.canonicalize()? == model_path,
                    "Prior download receipt refers to a different model cache");
                let path = model.clone();
                let digest = cx.background_executor().spawn(async move { real_model_hash(&path) }).await?;
                anyhow::ensure!(prior["preciseConsent"] == true && prior["modelDownload"] == true
                    && prior["downloadThisRun"] == true && prior["resumedModel"] == false
                    && prior["modelBytes"].as_u64() == Some(model.metadata()?.len())
                    && prior["modelSha256"] == digest && prior["url"] == part.url,
                    "Prior successful download does not bind this cached model");
                anyhow::ensure!(success["realInference"] == true && success["fixtureInference"] == false
                    && success["precisePreview"] == true && success["explicitSave"] == true
                    && success["reopenedEditor"] == true && success["reopenedPlayer"] == true
                    && success["nativePlayback"] == true && success["modelFile"] == prior["modelFile"]
                    && success["modelSha256"] == prior["modelSha256"] && success["modelBytes"] == prior["modelBytes"],
                    "Preinstalled reuse requires prior successful actual inference and Save");
                anyhow::ensure!(terminal["terminal"] == true && terminal["returncode"].as_i64() == Some(0)
                    && terminal["pid"].as_u64().is_some_and(|pid|pid > 0),
                    "Prior native model run has no successful terminal process receipt");
                prior_model_evidence = Some(serde_json::json!({
                    "downloadReceipt":{"path":download_path,"sha256":real_model_hash(&download_path)?},
                    "successfulResult":{"path":result_path,"sha256":real_model_hash(&result_path)?},
                    "terminalReceipt":{"path":exit_path,"sha256":real_model_hash(&exit_path)?},
                    "modelPath":model_path,"modelSha256":digest,
                    "scope":"prior successful real download/inference; this run reuses the same private cache"
                }));
                download_evidence = Some(prior);
            } else if resume {
                anyhow::ensure!(out.join("failure.txt").is_file() && download_receipt.is_file()
                    && model_install::valid_part(&model, part), "Resume requires a terminal failure and completed real model download");
                anyhow::ensure!(download_receipt.metadata()?.len() <= 65536, "Unreasonable prior download receipt");
                let prior: serde_json::Value = serde_json::from_slice(&std::fs::read(&download_receipt)?)?;
                let path = model.clone();
                let digest = cx.background_executor().spawn(async move { real_model_hash(&path) }).await?;
                anyhow::ensure!(prior["preciseConsent"]==true && prior["modelDownload"]==true
                    && prior["modelFile"].as_str()==model.to_str()
                    && prior["modelBytes"].as_u64()==Some(model.metadata()?.len())
                    && prior["modelSha256"]==digest && prior["url"]==part.url,
                    "Prior download receipt no longer binds the installed precise model");
                if !out.join("failure-before-resume.txt").exists() {
                    std::fs::copy(out.join("failure.txt"), out.join("failure-before-resume.txt"))?;
                }
                std::fs::remove_file(out.join("failure.txt"))?;
                download_evidence = Some(prior);
            } else {
                anyhow::ensure!(!model.exists(), "Initial real lyric flow requires the optional precise model to be absent");
            }
            std::fs::create_dir_all(&out)?;
            let lyrics_path = project.join("lyrics.json");
            let original_lyrics = std::fs::read(&lyrics_path)?;
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {
                    cx.background_executor().timer(Duration::from_millis(40)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{
                        let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active(),"Real lyric UI presented its window");
                        anyhow::ensure!($p.notice.is_none(),"Real lyric UI notice: {:?}",$p.notice);
                        Ok($predicate)
                    })??;
                    if ready{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Real lyric UI timeout: {}",stringify!($predicate));
                }
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! edit {()=>{{
                if !handle.update(cx,|_,_,cx|view.read(cx).karaoke)? {
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                        let b=view.read(cx).quick_start.read(cx).anchors.get("karaoke")
                            .ok_or_else(||anyhow::anyhow!("Karaoke control was not laid out"))?;
                        click(w,cx,b.center());Ok(())})??;
                    wait!(30,p,w,app => p.karaoke);
                }
                wait!(30,p,w,app => p.lyrics_flight.lyrics_sidebar.is_none()
                    &&p.lyrics_sidebar.read(app).state(w,app)["status"]=="ready");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                    let b=view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-edit")
                        .ok_or_else(||anyhow::anyhow!("Lyrics Edit was not laid out"))?;
                    click(w,cx,b.center());Ok(())})??;
                wait!(30,p,w,app => p.lyrics_editor_open&&!p.lyrics_editor.read(app).rows().is_empty());
            }};}
            handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));
                view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
            wait!(90,p,w,app => !p.loading&&p.project.as_ref().is_some_and(|loaded|loaded.dir==project));
            edit!();
            let before = handle.update(cx,|_,_,cx|rows(&view,cx))?;
            wait!(30,p,w,app => p.lyrics_precise_cap);
            press!("lyed-precise");
            if !resume && !preinstalled {
                wait!(60,p,w,app => state(p,w,app)["consent"].is_array());
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(view.read(cx),w,cx);
                    anyhow::ensure!(s["consent"][0]==true&&s["consent"][2]==true,"Precise did not request optional-aligner consent");
                    capture(&view,w,cx,&out,"real-precise-consent")})??;
                anyhow::ensure!(std::fs::read(&lyrics_path)?==original_lyrics,"Consent wrote project lyrics");
                press!("lyed-align-download");
            }
            let deadline = Instant::now()+Duration::from_secs(3000);
            let mut saw_download = false;
            let mut saw_inference = false;
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let (downloading,busy,error,check) = handle.update(cx,|_,w,cx|->anyhow::Result<_>{
                    let p=view.read(cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Real inference activated window");
                    let editor=p.lyrics_editor.read(cx);let state=editor.state(w,cx);
                    Ok((p.lyrics_flight.lyrics_download_pending.is_some(),editor.busy,state["error"].clone(),state["check"].clone()))
                })??;
                saw_download |= downloading;
                saw_inference |= busy && !downloading;
                if download_evidence.is_none() && saw_download && !downloading && model_install::valid_part(&model,part) {
                    let path=model.clone();
                    let digest=cx.background_executor().spawn(async move{real_model_hash(&path)}).await?;
                    let receipt=serde_json::json!({"modelFile":model,"modelBytes":model.metadata()?.len(),
                        "modelSha256":digest,"preciseConsent":true,"modelDownload":true,
                        "downloadThisRun":true,"resumedModel":false,"modelFlavor":caps.precise_flavor,"url":part.url});
                    std::fs::write(&download_receipt,serde_json::to_vec_pretty(&receipt)?)?;
                    download_evidence=Some(receipt);
                }
                anyhow::ensure!(!error.is_string(),"Real precise alignment failed: {error}");
                if !busy && check["method"]=="ctc" {
                    anyhow::ensure!(check["verdict"]!="mismatch","Real precise alignment reported mismatch");
                    break;
                }
                anyhow::ensure!(Instant::now()<deadline,"Real precise download/inference timed out");
            }
            anyhow::ensure!(download_evidence.is_some()&&(resume||preinstalled||saw_download),"Actual optional model installation or validated cache provenance was not observed");
            anyhow::ensure!(!preinstalled || saw_inference, "Preinstalled flow did not observe a fresh busy inference operation");
            let (preview,duration) = handle.update(cx,|_,w,cx|->anyhow::Result<_>{let p=view.read(cx);
                let state=state(p,w,cx);anyhow::ensure!(state["dirty"]==true,"Precise preview was not an editable unsaved draft");
                let draft=rows(&view,cx);anyhow::ensure!(draft.len()==before.len()&&draft.iter().zip(&before).all(|(a,b)|a.text==b.text),"Precise changed manual lyric text");
                Ok((real_lines(&draft,p.duration as f64)?,p.duration as f64))})??;
            anyhow::ensure!(std::fs::read(&lyrics_path)?==original_lyrics,"Precise preview wrote project lyrics before Save");
            handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"real-precise-preview"))??;
            press!("lyed-save");
            wait!(60,p,w,app => !p.lyrics_editor_open&&p.lyrics_flight.lyrics_editor_pending.is_none());
            let saved_bytes=std::fs::read(&lyrics_path)?;
            let saved:serde_json::Value=serde_json::from_slice(&saved_bytes)?;
            let persisted:Vec<lyrics_edit::Line>=serde_json::from_value(saved["lines"].clone())?;
            anyhow::ensure!(saved["source"]=="edited"&&real_same_lines(&preview,&persisted),"Explicit Save did not publish the accepted precise draft");
            edit!();
            let reopened=handle.update(cx,|_,_,cx|real_lines(&rows(&view,cx),duration))??;
            anyhow::ensure!(real_same_lines(&persisted,&reopened),"Editor reopen lost saved precise word timings");
            press!("lyed-cancel");wait!(30,p,w,app => !p.lyrics_editor_open);
            let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
            wait!(90,p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.as_ref().is_some_and(|loaded|loaded.dir==project));
            edit!();
            let reopened=handle.update(cx,|_,_,cx|real_lines(&rows(&view,cx),duration))??;
            anyhow::ensure!(real_same_lines(&persisted,&reopened)&&std::fs::read(&lyrics_path)?==saved_bytes,"Player reload lost or rewrote saved precise timings");
            press!("lyed-cancel");wait!(30,p,w,app => !p.lyrics_editor_open);
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                let b=view.read(cx).transport.read(cx).bounds("transport-play")
                    .ok_or_else(||anyhow::anyhow!("Native Play button missing"))?;
                click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|status|status.playing&&status.audible_current&&status.position>0.02));
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                let b=view.read(cx).transport.read(cx).bounds("transport-play").unwrap();click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app => !p.playing);
            handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"real-saved-player"))??;
            let pitch_label_review = std::env::var("SINGZ_GPUI_PITCH_LABEL_TEST").as_deref()==Ok("1");
            if pitch_label_review {
                let expected_seek = handle.update(cx,|_,_,cx| {
                    let expected = view.read(cx).playhead.seek_count() + 1;
                    view.update(cx,|p,cx| {p.playhead.seek(0.);p.seek_native(cx);});
                    expected
                })?;
                wait!(30,p,w,app => !p.playing && p.playhead.pending_seek().is_none() && p.playhead.seek_count()>=expected_seek
                    && p.playhead.position().abs()<0.001 && p.last_playback_status.as_ref().is_some_and(|s|
                        !s.playing && s.seek_count>=expected_seek && s.position.abs()<0.001));
                wait!(60,p,w,app => p.beat_job.is_none());
                for (bars, mode) in [(true,"bars"),(false,"frames")] {
                    let toggle_needed=handle.update(cx,|_,_,cx|view.read(cx).pitch_strip.read(cx).note_bars()!=bars)?;
                    if toggle_needed {
                        handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                            draw(w,cx);
                            anyhow::ensure!(view.read(cx).beat_job.is_none(),"Pitch toolbar still has a progress prefix");
                            let toolbar=view.read(cx).pitch_strip.read(cx).mic_bounds()
                                .ok_or_else(||anyhow::anyhow!("Pitch toolbar was not laid out"))?;
                            // Production hud starts at x16 and its first Note bars
                            // button is 80px wide; derive Y from its measured row.
                            click(w,cx,point(px(56.),toolbar.center().y));
                            Ok(())
                        })??;
                        wait!(10,p,w,app => p.pitch_strip.read(app).note_bars()==bars);
                    }
                    for (width,height) in [(1280.,800.),(1060.,640.)] {
                        handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                        wait!(20,p,w,app => w.viewport_size()==size(px(width),px(height)));
                        handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                            anyhow::ensure!(!view.read(cx).playing && view.read(cx).pitch_strip.read(cx).note_bars()==bars,
                                "Pitch label review changed accepted paused mode");
                            capture(&view,w,cx,&out,&format!("pitch-label-{mode}-{}",width as u32))
                        })??;
                    }
                }
            }
            let mut receipt=download_evidence.unwrap();
            let object=receipt.as_object_mut().unwrap();
            object.extend(serde_json::json!({"realInference":true,"fixtureInference":false,
                "precisePreview":true,"finiteWordTimings":true,"previewDoesNotWrite":true,
                "explicitSave":true,"reopenedEditor":true,"reopenedPlayer":true,"nativePlayback":true,
                "downloadThisRun":!resume&&!preinstalled,"resumedModel":resume,
                "modelCacheUsed":preinstalled,"preciseConsentThisRun":!resume&&!preinstalled,
                "priorModelEvidence":prior_model_evidence,"project":project,
                "pitchLabelReview":pitch_label_review,
                "pitchLabelReviewScope":"optional actual Note bars control clicks; source-defined x and measured toolbar y; accepted native paused seek to zero; cadence unmeasured",
                "wordCount":persisted.iter().map(|line|line.words.len()).sum::<usize>(),
                "hidden":true,"muted":true,"scope":"real precise model and native playback; no externally measured timing-quality claim"
            }).as_object().unwrap().clone());
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&receipt)?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>eprintln!("NATIVE_LYRICS_ALIGN real passed"),
            Err(error)=>{eprintln!("NATIVE_LYRICS_ALIGN real failed: {error:#}");
                let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));
                let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"real-failure"));}
        }
        cx.update(|cx|cx.quit());
    }).detach();
}

/// Actual shipped Qwen runtimes, isolated from the optional Precise/download case.
fn run_qwen_real(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                &&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&std::env::var("SINGZ_NO_SYNC").as_deref()==Ok("1")&&!integration::fixture_mode(),
                "Real Qwen UI requires hidden/muted native execution");
            for name in ["SINGZ_GPUI_LYRICS_ALIGN_FIXTURES","SINGZ_GPUI_MODEL_FIXTURE",
                "SINGZ_GPUI_MODEL_CONTROL","SINGZ_GPUI_SOURCE_CONTROL","SINGZ_GPU_PACK_URL"] {
                anyhow::ensure!(std::env::var_os(name).is_none(),"Real Qwen UI refuses {name}");
            }
            let required = |name:&str|->anyhow::Result<PathBuf> {
                let path=PathBuf::from(std::env::var_os(name).ok_or_else(||anyhow::anyhow!("Missing {name}"))?);
                anyhow::ensure!(path.is_absolute(),"{name} requires an absolute path");
                Ok(path.canonicalize()?)
            };
            let project=required("SINGZ_GPUI_LYRICS_REAL_PROJECT")?;
            let library=required("SINGZ_GPUI_PROJECTS_ROOT")?;
            let config_dir=required("SINGZ_GPUI_CONFIG_DIR")?;
            anyhow::ensure!(project.parent()==Some(library.as_path())&&config_dir!=project&&config_dir!=library,
                "Real Qwen UI needs separate private project/library/config paths");
            for name in ["SINGZ_LLAMA_SERVER","SINGZ_CRISPASR"] {
                let path=required(name)?;
                anyhow::ensure!(std::fs::symlink_metadata(path)?.file_type().is_file(),"{name} requires an ordinary actual executable");
            }
            anyhow::ensure!(std::env::var_os("SINGZ_MODELS_DIR").is_some(),"Real Qwen models are required");
            let config=model_catalog::Config::source();config.validate()?;
            anyhow::ensure!(lyrics_align::capability().can_align&&lyrics_align::needs_models(lyrics_align::Tier::Align).is_empty(),
                "Real Qwen UI requires installed speech/aligner weights and native runtimes");
            std::fs::create_dir_all(&out)?;
            anyhow::ensure!(out.is_absolute()&&!out.canonicalize()?.starts_with(&project),
                "Real Qwen capture output must be outside the private project");
            let lyrics_path=project.join("lyrics.json");
            let original_lyrics=std::fs::read(&lyrics_path)?;
            let heard_path=project.join("heard-words.json");
            anyhow::ensure!(!heard_path.try_exists()?,"Real Qwen UI requires a fresh project heard cache");
            macro_rules! wait {($seconds:expr,$p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs($seconds);
                loop {cx.background_executor().timer(Duration::from_millis(40)).await;
                    if handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),
                            "Real Qwen UI changed hidden state or raised {:?}",$p.notice);
                        Ok($condition)})?? {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Real Qwen UI timeout: {}",stringify!($condition));
                }
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! both {($name:expr)=>{{for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(30,p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("{}-{}",$name,width as u32)))??;
            }}};}
            macro_rules! edit {()=>{{
                if !handle.update(cx,|_,_,cx|view.read(cx).karaoke)? {
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                        let b=view.read(cx).transport.read(cx).guides.get("karaoke")
                            .ok_or_else(||anyhow::anyhow!("Qwen Karaoke control missing"))?;
                        click(w,cx,b.center());Ok(())})??;
                    wait!(30,p,w,app => p.karaoke);
                }
                wait!(30,p,w,app => p.lyrics_flight.lyrics_sidebar.is_none()
                    &&p.lyrics_sidebar.read(app).state(w,app)["status"]=="ready");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                    let b=view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-edit")
                        .ok_or_else(||anyhow::anyhow!("Qwen Edit control missing"))?;
                    click(w,cx,b.center());Ok(())})??;
                wait!(30,p,w,app => p.lyrics_editor_open&&!p.lyrics_editor.read(app).rows().is_empty());
            }};}
            handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));
                view.update(cx,|p,cx|p.open_project(project.clone(),cx));})?;
            wait!(90,p,w,app => !p.loading&&p.project.as_ref().is_some_and(|s|s.dir==project));
            let (vocal,size,modified)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);
                let loaded=p.project.as_ref().unwrap();
                anyhow::ensure!(loaded.raw.get("songFile").is_none(),"Real Qwen UI refuses legacy original-song heard caches");
                let vocal=loaded.lanes.iter().find(|(slot,_)|*slot==0)
                    .ok_or_else(||anyhow::anyhow!("Real Qwen fixture has no vocal lane"))?.1.clone();
                let meta=std::fs::symlink_metadata(&vocal)?;
                anyhow::ensure!(meta.file_type().is_file(),"Real Qwen vocal source is not ordinary");
                Ok((vocal,meta.len(),meta.modified()?))})??;
            edit!();
            let before=handle.update(cx,|_,_,cx|rows(&view,cx))?;
            anyhow::ensure!(!heard_path.try_exists()?,"Opening the editor unexpectedly supplied heard cache");
            press!("lyed-align");
            let deadline=Instant::now()+Duration::from_secs(900);
            let mut saw_inference=false;
            loop {
                cx.background_executor().timer(Duration::from_millis(80)).await;
                let (busy,editor)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{let p=view.read(cx);
                    anyhow::ensure!(!w.is_visible()&&!w.is_window_active()&&p.notice.is_none(),"Real Qwen inference changed hidden state or raised a notice");
                    anyhow::ensure!(p.lyrics_flight.lyrics_download_pending.is_none(),"Preinstalled Qwen flow must not download models");
                    Ok((p.lyrics_editor.read(cx).busy,state(p,w,cx)))})??;
                saw_inference|=busy;
                anyhow::ensure!(!editor["error"].is_string(),"Real Qwen alignment failed: {}",editor["error"]);
                anyhow::ensure!(editor["consent"].is_null(),"Real Qwen flow requested missing-model consent");
                if !busy&&editor["check"]["method"]=="qwen" {
                    anyhow::ensure!(editor["check"]["verdict"]!="mismatch","Real Qwen reported a reference mismatch");break;
                }
                anyhow::ensure!(Instant::now()<deadline,"Real Qwen inference timed out");
            }
            anyhow::ensure!(saw_inference,"Real Qwen UI never observed inference in progress");
            let meta=std::fs::symlink_metadata(&heard_path)?;
            anyhow::ensure!(meta.file_type().is_file()&&meta.len()<=8*1024*1024,"Real Qwen cache must be bounded and ordinary");
            let heard:serde_json::Value=serde_json::from_slice(&std::fs::read(&heard_path)?)?;
            let modified_ms=modified.duration_since(std::time::UNIX_EPOCH)?.as_secs_f64()*1000.;
            anyhow::ensure!(heard["version"]==1&&heard["engine"]=="qwen3-asr-1.7b"
                &&heard["vocals"]["size"].as_u64()==Some(size)
                &&heard["vocals"]["mtimeMs"].as_f64().is_some_and(|ms|(ms-modified_ms).abs()<=2.)
                &&heard["chunks"].as_array().is_some_and(|chunks|chunks.iter().any(|chunk|chunk["text"].as_str().is_some_and(|text|!text.trim().is_empty()))),
                "Real Qwen did not create source-bound nonempty heard text");
            let current=std::fs::symlink_metadata(&vocal)?;
            anyhow::ensure!(current.len()==size&&current.modified()?==modified,"Real Qwen changed its vocal input");
            let (preview,duration)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{let p=view.read(cx);
                anyhow::ensure!(state(p,w,cx)["dirty"]==true,"Real Qwen preview was not an unsaved editable draft");
                let draft=rows(&view,cx);
                anyhow::ensure!(draft.len()==before.len()&&draft.iter().zip(&before).all(|(a,b)|a.text==b.text),"Real Qwen changed manual reference text");
                Ok((real_lines(&draft,p.duration as f64)?,p.duration as f64))})??;
            anyhow::ensure!(std::fs::read(&lyrics_path)?==original_lyrics,"Qwen preview published before explicit Save");
            both!("qwen-preview");
            press!("lyed-save");
            wait!(60,p,w,app => !p.lyrics_editor_open&&p.lyrics_flight.lyrics_editor_pending.is_none());
            let saved_bytes=std::fs::read(&lyrics_path)?;
            let saved:serde_json::Value=serde_json::from_slice(&saved_bytes)?;
            let persisted:Vec<lyrics_edit::Line>=serde_json::from_value(saved["lines"].clone())?;
            anyhow::ensure!(saved["source"]=="edited"&&real_same_lines(&preview,&persisted),"Qwen Save changed accepted timings");
            edit!();
            let reopened=handle.update(cx,|_,_,cx|real_lines(&rows(&view,cx),duration))??;
            anyhow::ensure!(real_same_lines(&persisted,&reopened),"Qwen editor reopen lost saved timings");
            press!("lyed-cancel");wait!(30,p,w,app => !p.lyrics_editor_open);
            let epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
            wait!(90,p,w,app => !p.loading&&p.native_epoch>epoch&&p.project.as_ref().is_some_and(|s|s.dir==project));
            edit!();
            let reopened=handle.update(cx,|_,_,cx|real_lines(&rows(&view,cx),duration))??;
            anyhow::ensure!(real_same_lines(&persisted,&reopened)&&std::fs::read(&lyrics_path)?==saved_bytes,"Qwen project reload lost or rewrote saved timings");
            press!("lyed-cancel");wait!(30,p,w,app => !p.lyrics_editor_open);
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Qwen Play control missing"))?;
                click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app => p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.audible_current&&s.position>0.02));
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);
                let b=view.read(cx).transport.read(cx).bounds("transport-play").unwrap();click(w,cx,b.center());Ok(())})??;
            wait!(30,p,w,app => !p.playing&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
            both!("qwen-saved-player");
            let mut receipt=serde_json::json!({"realInference":true,"fixtureInference":false,"engine":"qwen3-asr-1.7b",
                "qwenPreview":true,"finiteWordTimings":true,"previewDoesNotWrite":true,"explicitSave":true,
                "reopenedEditor":true,"reopenedPlayer":true,"nativePlayback":true,"freshHeardCache":true,
                "modelDownload":false,"preciseInference":false,"wordCount":persisted.iter().map(|line|line.words.len()).sum::<usize>(),
                "sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true});
            receipt.as_object_mut().unwrap().extend(serde_json::json!({"project":project,"vocal":vocal,"heardCache":heard,
                "preview":preview,"persisted":persisted,"scope":"real preinstalled Qwen recognition and alignment, explicit Save/reopen/native playback; speech fixture, no singing-quality or live-FPS claim"}).as_object().unwrap().clone());
            std::fs::write(out.join("qwen-real-result.json"),serde_json::to_vec_pretty(&receipt)?)?;
            Ok(())
        }.await;
        match result {
            Ok(())=>eprintln!("NATIVE_LYRICS_ALIGN Qwen real passed"),
            Err(error)=>{eprintln!("NATIVE_LYRICS_ALIGN Qwen real failed: {error:#}");
                let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("qwen-real-failure.txt"),format!("{error:#}"));
                let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"qwen-real-failure"));}
        }
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

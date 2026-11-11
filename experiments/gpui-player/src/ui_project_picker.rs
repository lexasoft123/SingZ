//! Hidden production ProjectPicker controls; no OS input, dialogs or activation.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    view.read(cx).project_picker.read(cx).state(w, cx)
}
fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse(value).unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .project_picker
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing picker control {id}"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Picker {id} outside viewport: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn focused_row_visible(view: &Entity<Player>, w: &Window, cx: &App) -> anyhow::Result<()> {
    let snapshot = state(view, w, cx);
    if let Some(id) = snapshot["focusedControl"]
        .as_str()
        .filter(|id| id.starts_with("picker-row-"))
    {
        let picker = view.read(cx).project_picker.read(cx);
        let row = picker
            .bounds(id)
            .ok_or_else(|| anyhow::anyhow!("Focused picker row not measured"))?;
        let list = picker
            .bounds("picker-rows")
            .ok_or_else(|| anyhow::anyhow!("Picker list not measured"))?;
        anyhow::ensure!(
            row.top() >= list.top() - px(1.) && row.bottom() <= list.bottom() + px(1.),
            "Focused {id} clipped by picker list: {row:?} / {list:?}"
        );
    }
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get("projects")
        .ok_or_else(|| anyhow::anyhow!("Header Projects action not measured"))?;
    click(w, cx, b.center());
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
        "Project picker presented or activated window"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let value = serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"pickerOpen":p.project_picker_open,"picker":state(view,w,cx),
        "project":p.project.as_ref().map(|p|p.dir.clone()),"playing":p.playing,"epoch":p.native_epoch,
        "nativeSeekCount":p.playhead.seek_count(),"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),
        "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "visualReference":"candidate only; matched production capture absent","liveFps":"unmeasured: hidden window"});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_PROJECT_PICKER_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing picker fixtures"))?);
            let stage=std::env::var("SINGZ_GPUI_PICKER_STAGE").unwrap_or_else(|_|"full".into());
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(30);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                    if ready {break;}if Instant::now()>=deadline {
                        let actual=handle.update(cx,|_,w,app|state(&view,w,app))?;
                        anyhow::bail!("Picker timed out: {}; actual {actual}",stringify!($predicate));
                    }
                }
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,$name))??;};}
            macro_rules! open {()=>{{handle.update(cx,|_,w,cx|header(&view,w,cx))??;
                wait!(p,w,app=>p.project_picker_open&&state(&view,w,app)["loading"]==false);
                handle.update(cx,|_,_,cx|view.read(cx).project_picker.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx)))?;}};}
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(root.join("active"),cx)))?;
            wait!(p,w,app=>!p.loading&&p.project.is_some());
            let mut flags=serde_json::Map::new();
            flags.insert("hidden".into(),serde_json::json!(true));flags.insert("muted".into(),serde_json::json!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")));
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            open!();
            if stage=="restart"||stage=="reset-restart" {
                let expected=if stage=="restart"{root.join("custom")}else{root.join("library")};
                wait!(p,w,app=>state(&view,w,app)["root"].as_str()==expected.to_str());
                let s=handle.update(cx,|_,w,cx|state(&view,w,cx))?;
                anyhow::ensure!(s["projects"].as_array().is_some_and(|a|a.len()==24),"Restart lost library inventory");
                anyhow::ensure!(s["isDefault"]==(stage=="reset-restart"),"Restart selected wrong root kind");
                shot!("restored-1280");flags.insert("restartPersistence".into(),serde_json::json!(true));
                if stage=="restart" {
                    press!("picker-reset-root");
                    wait!(p,w,app=>p.project_library_pending.is_none()&&state(&view,w,app)["root"].as_str()==root.join("library").to_str()&&state(&view,w,app)["isDefault"]==true);
                    shot!("reset-default-1280");flags.insert("resetDefault".into(),serde_json::json!(true));
                }
                press!("picker-close");wait!(p,w,app=>!p.project_picker_open);
            } else {
                let expected_count=if stage=="empty"{0}else{24};
                let s=handle.update(cx,|_,w,cx|state(&view,w,cx))?;
                anyhow::ensure!(s["projects"].as_array().is_some_and(|a|a.len()==expected_count),"Unexpected initial picker inventory: {s}");
                shot!(if stage=="empty"{"empty-1280"}else{"list-1280"});
                press!("picker-close");wait!(p,w,app=>!p.project_picker_open);
                // Start playback through its actual transport control. Merely
                // inspecting storage must preserve the active audio session.
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Missing Play"))?;click(w,cx,b.center());Ok(())})??;
                wait!(p,w,app=>p.playing);
                let (epoch,seeks,project)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.native_epoch,p.playhead.seek_count(),p.project.as_ref().unwrap().dir.clone())})?;
                for (width,height) in [(1280.,800.),(1060.,640.)] {
                    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;open!();
                    for _ in 0..(expected_count+6)*2 {
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"tab");draw(w,cx);
                            anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Tab escaped picker");focused_row_visible(&view,w,cx)?;Ok(())})??;
                    }
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Reverse Tab escaped picker");focused_row_visible(&view,w,cx)?;Ok(())})??;
                    if expected_count>0 {
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).project_picker.read(cx).bounds("picker-rows").ok_or_else(||anyhow::anyhow!("Missing picker list"))?;
                            w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:b.center(),delta:ScrollDelta::Pixels(point(px(0.),px(-900.))),..Default::default()}),cx);draw(w,cx);Ok(())})??;
                    }
                    if expected_count>0 {handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        anyhow::ensure!(state(&view,w,cx)["scrollOffset"][1].as_f64().is_some_and(|y|y<0.),"Long picker list did not scroll");Ok(())})??;}
                    shot!(&format!("{}-{}",if expected_count==0{"empty"}else{"scrolled"},width as i32));
                    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.project_picker_open);
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.playing&&p.native_epoch==epoch&&p.playhead.seek_count()==seeks&&p.project.as_ref().unwrap().dir==project,"Picker altered existing playback");Ok(())})??;
                }
                flags.insert("twoSizes".into(),serde_json::json!(true));flags.insert("focusTrap".into(),serde_json::json!(true));flags.insert("escape".into(),serde_json::json!(true));flags.insert("playbackPreserved".into(),serde_json::json!(true));
                if expected_count==0 {flags.insert("empty".into(),serde_json::json!(true));}
                else {
                    open!();
                    let selected=handle.update(cx,|_,w,cx|state(&view,w,cx)["projects"][0]["songPath"].as_str().map(PathBuf::from).ok_or_else(||anyhow::anyhow!("Missing first project song path")))??;
                    press!("picker-row-0");wait!(p,w,app=>!p.project_picker_open&&!p.loading&&p.project.as_ref().is_some_and(|p|Some(p.dir.as_path())==selected.parent()));
                    flags.insert("openItem".into(),serde_json::json!(true));
                    open!();press!("picker-choose-root");
                    let gate=root.join("move.gate");
                    if gate.exists() {
                        wait!(p,w,app=>gate.with_extension("ready").is_file()&&state(&view,w,app)["moving"]==true);
                        shot!("moving-before-close-1060");press!("picker-close");wait!(p,w,app=>!p.project_picker_open);
                        anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).project_library_pending.is_some())?,"Close cancelled chosen-folder copy");
                        std::fs::remove_file(&gate)?;
                        wait!(p,w,app=>p.project_library_pending.is_none());
                        open!();
                        flags.insert("closeDuringMoveContinues".into(),serde_json::json!(true));
                    }
                    wait!(p,w,app=>p.project_library_pending.is_none()&&state(&view,w,app)["root"].as_str()==root.join("custom").to_str()&&state(&view,w,app)["moving"]==false);
                    shot!("custom-collision-1060");
                    let s=handle.update(cx,|_,w,cx|state(&view,w,cx))?;
                    anyhow::ensure!(s["projects"].as_array().is_some_and(|a|a.len()==24)&&s["isDefault"]==false,"Relocation lost projects");
                    flags.insert("chooseRoot".into(),serde_json::json!(true));flags.insert("longNamesAndScroll".into(),serde_json::json!(true));
                    press!("picker-close");wait!(p,w,app=>!p.project_picker_open);
                }
                // Route setup uses the production catalog screen; the storage
                // entry itself is dispatched through its measured real button.
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.screen=Screen::Library;cx.notify();}))?;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).library.read(cx).guides.get("storage").ok_or_else(||anyhow::anyhow!("Library storage action not measured"))?;click(w,cx,b.center());Ok(())})??;
                wait!(p,w,app=>p.project_picker_open);shot!("library-storage-route");press!("picker-close");wait!(p,w,app=>!p.project_picker_open);
                flags.insert("libraryStorageRoute".into(),serde_json::json!(true));flags.insert("headerProjectsRoute".into(),serde_json::json!(true));
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&flags)?)?;Ok(())
        }.await;
        match result {Ok(())=>eprintln!("NATIVE_PROJECT_PICKER passed"),Err(error)=>{eprintln!("NATIVE_PROJECT_PICKER failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"failure"));}}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

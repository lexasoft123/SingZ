//! Actual hidden native release controls, startup arbitration and persistence.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};
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
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    view.read(cx).whats_new.read(cx).state(w, cx)
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .whats_new
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing release control {id}"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(0.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Release control {id} clipped: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get(id)
        .ok_or_else(|| anyhow::anyhow!("Missing header {id}"))?;
    click(w, cx, b.center());
    Ok(())
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    expected_viewport: Option<(f32, f32)>,
) -> anyhow::Result<()> {
    draw(w, cx);
    if let Some((width, height)) = expected_viewport {
        anyhow::ensure!(
            w.viewport_size() == size(px(width), px(height)),
            "Capture {name} has actual viewport {:?}, expected {width}x{height}",
            w.viewport_size()
        );
    }
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Release test presented or activated window"
    );
    let image = w.render_to_image()?;
    let viewport = w.viewport_size();
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (f32::from(viewport.width) * scale).round() as u32
            && image.height() == (f32::from(viewport.height) * scale).round() as u32,
        "Capture {name} raster {}x{} differs from actual viewport {viewport:?} at scale {scale}",
        image.width(),
        image.height()
    );
    image.save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let snapshot = p.release_service.as_ref().map(|s| s.snapshot());
    let value = serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"release":state(view,w,cx),
  "startupReady":p.release_startup_ready,"pending":p.release_pending,"seen":snapshot.as_ref().and_then(|s|s.state.seen.clone()),"serviceError":snapshot.as_ref().and_then(|s|s.error.clone()),
  "quickStartOpen":p.quick_start.read(cx).is_open(),"quickStartPending":p.quick_start.read(cx).pending_welcome(),"screen":p.screen as u8,"externalUrls":p.release_external_urls,"unexpectedBrowse":p.release_unexpected_browse,
  "windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
  "expectedViewport":expected_viewport,"locale":"en","visualReference":"candidate only; matched production captures absent","liveFps":"unmeasured: hidden static captures"});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&value)?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    let stage = std::env::var("SINGZ_GPUI_RELEASE_STAGE").unwrap_or_else(|_| "fresh".into());
    // Establish the real blocking route before yielding to startup polling.
    let setup = handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
        w.resize(size(px(1280.), px(800.)));
        match stage.as_str() {
            "settings" => header(&view, w, cx, "settings")?,
            "models" => view.update(cx, |p, cx| p.open_models(models::Origin::Manual, cx)),
            "picker" => view.update(cx, |p, cx| p.open_project_picker(cx)),
            _ => {}
        }
        Ok(())
    });
    cx.spawn(async move|cx|{
  let result:anyhow::Result<()>=async{
   setup??;std::fs::create_dir_all(&out)?;let mut expected_viewport=(1280.,800.);
   macro_rules! wait {($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(20)).await;let ok=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;if ok{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Release timeout: {}; actual {actual}",stringify!($predicate));}}}};}
   macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name,Some(expected_viewport)))??;};}
   macro_rules! resize {($width:expr,$height:expr)=>{{
       handle.update(cx,|_,w,_|w.resize(size(px($width),px($height))))?;
       wait!(p,w,app=>w.viewport_size()==size(px($width),px($height)));
       expected_viewport=($width,$height);handle.update(cx,|_,w,cx|draw(w,cx))?;
   }};}
   macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
   macro_rules! settle {()=>{{handle.update(cx,|_,w,cx|->anyhow::Result<()>{
       view.read(cx).whats_new.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx));
       // An open flag precedes layout/paint. Initial focus and the key context
       // exist only after the real modal has rendered at least one frame.
       draw(w,cx);let actual=state(&view,w,cx);
       anyhow::ensure!(actual["focusInside"]==true,"Painted release modal did not acquire initial focus: {actual}");Ok(())})??;}};}
   macro_rules! manual {()=>{{handle.update(cx,|_,w,cx|header(&view,w,cx,"version"))??;wait!(p,w,app=>p.whats_new.read(app).is_open());settle!();}};}
   macro_rules! closed {()=>{wait!(p,w,app=>!p.whats_new.read(app).is_open());};}
   wait!(p,w,app=>p.release_startup_ready&&p.model_auto_checked);
   wait!(p,w,app=>w.viewport_size()==size(px(1280.),px(800.)));
   let error=handle.update(cx,|_,_,cx|view.read(cx).release_service.as_ref().unwrap().snapshot().error.clone())?;anyhow::ensure!(error.is_none(),"Release service failed: {error:?}");
   let mut flags=serde_json::Map::new();flags.insert("hidden".into(),serde_json::json!(true));flags.insert("muted".into(),serde_json::json!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")));
   if matches!(stage.as_str(),"settings"|"models"|"picker") {
    wait!(p,w,app=>p.release_pending.is_some());
    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.whats_new.read(cx).is_open()&&!p.quick_start.read(cx).is_open(),"Startup news covered a blocking route or welcome opened early");Ok(())})??;
    shot!("startup-blocked-1280");
    match stage.as_str(){
     "settings"=>{handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;},
     "models"=>{handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).models.read(cx).bounds("model-close").ok_or_else(||anyhow::anyhow!("Model Close not measured"))?;click(w,cx,b.center());Ok(())})??;},
     "picker"=>{handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).project_picker.read(cx).bounds("picker-close").ok_or_else(||anyhow::anyhow!("Picker Close not measured"))?;click(w,cx,b.center());Ok(())})??;},_=>unreachable!()
    }
    wait!(p,w,app=>p.whats_new.read(app).is_open());settle!();shot!("startup-released-1280");press!("whats-new-done");closed!();flags.insert("startupPrecedence".into(),serde_json::json!(true));
   } else if matches!(stage.as_str(),"prefeature"|"skipped") {
    wait!(p,w,app=>p.whats_new.read(app).is_open());settle!();
    let count=handle.update(cx,|_,w,cx|state(&view,w,cx)["notes"]["entries"].as_array().map(Vec::len).unwrap_or(0))?;
    anyhow::ensure!(count==if stage=="skipped"{4}else{1},"Automatic release range incorrect: {count}");
    shot!("automatic-1280");
    if stage=="skipped" {
     resize!(1060.,640.);
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let content=view.read(cx).whats_new.read(cx).bounds("whats-new-content").ok_or_else(||anyhow::anyhow!("Release content not measured"))?;
      w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:content.center(),delta:ScrollDelta::Pixels(point(px(0.),px(-900.))),..Default::default()}),cx);draw(w,cx);
      anyhow::ensure!(state(&view,w,cx)["scrollOffset"][1].as_f64().is_some_and(|y|y<0.),"Skipped release content did not scroll");Ok(())})??;
     shot!("skipped-scrolled-1060");flags.insert("multiReleaseScroll".into(),serde_json::json!(true));
    }
    if stage=="prefeature" {
     handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.maybe_open_quick_start(true,cx)))?;
     anyhow::ensure!(!handle.update(cx,|_,_,cx|view.read(cx).quick_start.read(cx).is_open())?,"Quick Start covered automatic news");
    }
    press!("whats-new-done");closed!();
    if stage=="prefeature" {
     handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.maybe_open_quick_start(true,cx)))?;
     wait!(p,w,app=>p.quick_start.read(app).is_open());shot!("welcome-after-news-1280");handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
     wait!(p,w,app=>!p.quick_start.read(app).is_open());flags.insert("quickStartWaitsForNews".into(),serde_json::json!(true));
    }
    flags.insert("automaticUpgrade".into(),serde_json::json!(true));
   } else {
    // Fresh baseline, acknowledged restart and downgrade all suppress auto,
    // while the actual version action must still reopen the current release.
    cx.background_executor().timer(Duration::from_millis(200)).await;
    anyhow::ensure!(!handle.update(cx,|_,_,cx|view.read(cx).whats_new.read(cx).is_open())?,"Suppressed automatic news unexpectedly opened");
    flags.insert("automaticSuppressed".into(),serde_json::json!(true));
    if stage=="fresh" {
     let seen=handle.update(cx,|_,_,cx|view.read(cx).release_service.as_ref().unwrap().snapshot().state.seen.clone())?;
     anyhow::ensure!(seen.as_deref()==Some(release_highlights::CURRENT_VERSION),"Fresh installation did not establish baseline");flags.insert("freshBaseline".into(),serde_json::json!(true));
    }
    for (width,height) in [(1280.,800.),(1060.,640.)] {
     resize!(width,height);manual!();
     anyhow::ensure!(handle.update(cx,|_,w,cx|state(&view,w,cx)["notes"]["entries"].as_array().is_some_and(|a|a.len()==1))?,"Manual reopen included acknowledged history");
     let order=["whats-new-close","whats-new-telegram","whats-new-full-notes","whats-new-done"];
     anyhow::ensure!(handle.update(cx,|_,w,cx|state(&view,w,cx)["focusedControl"]==order[0])?,"Initial release focus did not reach Close");
     let mut trace=vec![order[0].to_string()];
     for index in 0..9{let expected=order[(index+1)%order.len()];handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"tab");draw(w,cx);let actual=state(&view,w,cx);
       anyhow::ensure!(actual["focusInside"]==true&&actual["keyboardFocus"]==true&&actual["focusedControl"]==expected,"Tab {index} expected {expected}, actual {actual}");Ok(())})??;trace.push(expected.to_string());}
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"shift-tab");draw(w,cx);let actual=state(&view,w,cx);
       anyhow::ensure!(actual["focusInside"]==true&&actual["keyboardFocus"]==true&&actual["focusedControl"]==order[0],"Reverse Tab after nine forward steps expected Close, actual {actual}");Ok(())})??;
     trace.push(order[0].to_string());std::fs::write(out.join(format!("focus-order-{}.json",width as i32)),serde_json::to_vec_pretty(&trace)?)?;
     shot!(&format!("manual-{}",width as i32));
     // The card padding focuses its scope; Space must not activate a focused
     // button or leak to player playback. Cmd/Ctrl+O/F must stay in the modal.
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).whats_new.read(cx).bounds("whats-new-card").unwrap();click(w,cx,point(b.left()+px(12.),b.top()+px(12.)));draw(w,cx);
      anyhow::ensure!(state(&view,w,cx)["focusedControl"].is_null()&&state(&view,w,cx)["focusInside"]==true,"Card body did not own keyboard focus");
      let p=view.read(cx);let before=(p.playing,p.native_epoch,p.screen);key(w,cx,"space");key(w,cx,if cfg!(target_os="macos"){"cmd-o"}else{"ctrl-o"});key(w,cx,if cfg!(target_os="macos"){"cmd-f"}else{"ctrl-f"});draw(w,cx);
      let p=view.read(cx);anyhow::ensure!(p.whats_new.read(cx).is_open()&&p.playing==before.0&&p.native_epoch==before.1&&p.screen==before.2&&p.notice.is_none()&&p.release_unexpected_browse==0&&state(&view,w,cx)["focusInside"]==true,"Modal keyboard leaked into workspace");Ok(())})??;
     press!("whats-new-telegram");press!("whats-new-full-notes");
     wait!(p,w,app=>p.release_external_urls.len()>=if width==1280.{2}else{4});
     anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).whats_new.read(cx).is_open())?,"External link closed release modal");
     press!("whats-new-close");closed!();manual!();press!("whats-new-done");closed!();manual!();handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;closed!();manual!();handle.update(cx,|_,w,cx|click(w,cx,point(px(5.),px(5.))))?;closed!();
    }
    let urls=handle.update(cx,|_,_,cx|view.read(cx).release_external_urls.clone())?;
    let expected=vec!["https://t.me/SingZapp".to_string(),format!("https://github.com/lexasoft123/SingZ/releases/tag/v{}",release_highlights::CURRENT_VERSION)];
    anyhow::ensure!(urls==expected.iter().chain(expected.iter()).cloned().collect::<Vec<_>>(),"External links did not carry source URLs: {urls:?}");
    flags.insert("manualReopen".into(),serde_json::json!(true));flags.insert("twoSizes".into(),serde_json::json!(true));flags.insert("focusTrap".into(),serde_json::json!(true));flags.insert("allDismissals".into(),serde_json::json!(true));flags.insert("linksCapturedWithoutClosing".into(),serde_json::json!(true));flags.insert("keyboardSuppressed".into(),serde_json::json!(true));
   }
   let expected=if stage=="downgrade"{"9.9.9"}else{release_highlights::CURRENT_VERSION};
   wait!(p,w,app=>p.release_service.as_ref().unwrap().snapshot().state.seen.as_deref()==Some(expected));
   shot!("settled-final");
   std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&flags)?)?;Ok(())
  }.await;
  match result{Ok(())=>eprintln!("NATIVE_WHATS_NEW passed"),Err(error)=>{eprintln!("NATIVE_WHATS_NEW failed: {error:#}");let _=std::fs::create_dir_all(&out);let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",None));}}
  let _=cx.update(|cx|cx.quit());
 }).detach();
}

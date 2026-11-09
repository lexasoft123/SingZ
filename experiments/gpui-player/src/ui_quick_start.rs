//! Hidden guided-tour interaction and geometry checks at both desktop sizes.
use super::ui_training_run::{click, draw};
use super::*;
use sha2::Digest;
use std::{path::PathBuf, time::Duration};
fn hash(bytes: &[u8]) -> String {
    sha2::Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn source_identity() -> &'static serde_json::Value {
    static ID: std::sync::OnceLock<serde_json::Value> = std::sync::OnceLock::new();
    ID.get_or_init(|| serde_json::json!({
        "mainSha256":hash(include_bytes!("main.rs")),
        "librarySha256":hash(include_bytes!("library.rs")),
        "observerSha256":hash(include_bytes!("ui_quick_start.rs")),
        "copySha256":hash(include_bytes!("quick_start_copy.json"))
    }))
}
fn key(w: &mut Window, cx: &mut App, key: &'static str) {
    w.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse(key).unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let bounds = view
        .read(cx)
        .quick_start
        .read(cx)
        .bounds
        .borrow()
        .get(id)
        .copied()
        .ok_or_else(|| anyhow::anyhow!("Missing guide button {id}"))?;
    anyhow::ensure!(
        bounds.top() >= px(0.) && bounds.bottom() <= w.viewport_size().height,
        "Guide button outside viewport: {bounds:?}"
    );
    click(w, cx, bounds.center());
    Ok(())
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &std::path::Path,
    name: &str,
) -> anyhow::Result<()> {
    w.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: point(px(-1000.), px(-1000.)),
            pressed_button: None,
            modifiers: Default::default(),
        }),
        cx,
    );
    for _ in 0..5 {
        draw(w, cx);
    }
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Guide observer activated its window");
    let p = view.read(cx);
    let g = p.quick_start.read(cx);
    let state = g.snapshot();
    let card = g
        .bounds
        .borrow()
        .get("guide-card")
        .copied()
        .ok_or_else(|| anyhow::anyhow!("No guide card geometry"))?;
    anyhow::ensure!(
        card.left() >= px(0.)
            && card.top() >= px(0.)
            && card.right() <= w.viewport_size().width
            && card.bottom() <= w.viewport_size().height,
        "Guide card outside viewport: {card:?}"
    );
    let index = state["index"].as_i64().unwrap();
    let target = if index >= 0 {
        state["targets"][index as usize]
            .as_str()
            .and_then(|id| g.anchors.get(id))
    } else {
        None
    };
    if let Some(b) = target {
        let overlap_x = card.right().min(b.right()) > card.left().max(b.left());
        let overlap_y = card.bottom().min(b.bottom()) > card.top().max(b.top());
        anyhow::ensure!(
            !(overlap_x && overlap_y),
            "Guide covers its control: {card:?} {b:?}"
        );
    }
    let screenshot = out.join(format!("{name}.png"));
    w.render_to_image()?.save(&screenshot)?;
    let screenshot_sha256 = hash(&std::fs::read(screenshot)?);
    let b = |r: Bounds<Pixels>| serde_json::json!({"left":f32::from(r.left()),"top":f32::from(r.top()),"width":f32::from(r.size.width),"height":f32::from(r.size.height)});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(
            &serde_json::json!({"case":name,"source":source_identity(),"screenshotSha256":screenshot_sha256,"guide":state,"card":b(card),"target":target.map(b),"library":p.library.read(cx).review_guide_page(),"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"capture":"hidden muted GPUI render_to_image","backgroundInputBlocked":true,"hidden":true,"active":w.is_window_active()}),
        )?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    if std::env::var_os("SINGZ_GPUI_GUIDE_NATIVE_DRIVE").is_some() {
        run_native_drive(handle, view, out, cx);
        return;
    }
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
 std::fs::create_dir_all(&out)?;
 if std::env::var_os("SINGZ_GPUI_GUIDE_RESTART").is_some(){
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);view.update(cx,|p,cx|{p.model_auto_checked=true;p.maybe_open_quick_start(true,cx);});anyhow::ensure!(!view.read(cx).quick_start.read(cx).pending_welcome()&&!view.read(cx).quick_start.read(cx).is_open(),"Welcome dismissal did not survive restart");view.update(cx,|p,cx|p.open_quick_start(false,cx));draw(w,cx);anyhow::ensure!(view.read(cx).quick_start.read(cx).is_open(),"Manual replay unavailable after dismissal");press(&view,w,cx,"guide-skip")?;Ok(())})??;
  std::fs::write(out.join("result.json"),b"{\"restart\":true,\"manualReplay\":true}")?;return Ok(());
 }
 for (width,height) in [(1280.,800.),(1060.,640.)] {
  handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|{p.screen=Screen::Library;p.loaded_song=false;p.playing=false;cx.notify();});draw(w,cx);view.update(cx,|p,cx|{if width==1280. {p.model_auto_checked=true;p.screen=Screen::Models;p.maybe_open_quick_start(true,cx);assert!(!p.quick_start.read(cx).is_open());p.screen=Screen::Library;p.maybe_open_quick_start(true,cx);}else{p.open_quick_start(true,cx);}});})?;
  cx.background_executor().timer(Duration::from_millis(120)).await;
  handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("welcome-{width}")))??;
  // Tab/Shift-Tab are trapped inside the actual native guide controls.
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{key(w,cx,"shift-tab");draw(w,cx);eprintln!("GUIDE_SHIFT_TAB {:?}",view.read(cx).quick_start.read(cx).focus_index(w));anyhow::ensure!(view.read(cx).quick_start.read(cx).focus_index(w)==Some(2),"Shift-Tab did not reach final guide button");key(w,cx,"tab");anyhow::ensure!(view.read(cx).quick_start.read(cx).focus_index(w)==Some(0),"Tab escaped guide");key(w,cx,"tab");Ok(())})??;
  handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("keyboard-focus-{width}")))??;
  handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
  for index in 0..4 {
   cx.background_executor().timer(Duration::from_millis(100)).await;
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let g=view.read(cx).quick_start.read(cx).snapshot();anyhow::ensure!(g["index"]==index&&g["targets"].as_array().unwrap().len()==4,"Wrong library tour: {g}");capture(&view,w,cx,&out,&format!("library-{index}-{width}"))?;if index==1{press(&view,w,cx,"guide-back")?;anyhow::ensure!(view.read(cx).quick_start.read(cx).snapshot()["index"]==0,"Back failed");press(&view,w,cx,"guide-next")?;draw(w,cx);key(w,cx,"tab");key(w,cx,"tab");anyhow::ensure!(view.read(cx).quick_start.read(cx).focus_index(w)==Some(1),"Back was missing from keyboard order");key(w,cx,"enter");anyhow::ensure!(view.read(cx).quick_start.read(cx).snapshot()["index"]==0,"Keyboard Back failed");press(&view,w,cx,"guide-next")?;}press(&view,w,cx,"guide-next")?;Ok(())})??;
  }
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(!view.read(cx).quick_start.read(cx).is_open(),"Got it did not close tour");view.update(cx,|p,cx|{p.screen=Screen::Player;p.loaded_song=true;p.karaoke=true;p.started=Instant::now()-Duration::from_secs(2);cx.notify();});draw(w,cx);view.read(cx).header.clone().update(cx,|_,cx|cx.emit(header::HeaderEvent::Help));Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(100)).await;
  for index in 0..8 {
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let state=view.read(cx).quick_start.read(cx).snapshot();anyhow::ensure!(state["index"]==index&&state["targets"].as_array().unwrap().len()==8,"Wrong player tour: {state}");capture(&view,w,cx,&out,&format!("player-{index}-{width}"))?;if state["targets"][index as usize]=="loop" {let before=view.read(cx).looping;let target=view.read(cx).quick_start.read(cx).anchors.get("loop").unwrap();let at=target.center();click(w,cx,at);anyhow::ensure!(view.read(cx).looping==before,"Highlighted control accepted input behind modal");
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:point(px(-1000.),px(-1000.)),pressed_button:None,modifiers:Default::default()}),cx);draw(w,cx);let shaded=w.render_to_image()?;
    let guide=view.read(cx).quick_start.clone();guide.update(cx,|g,cx|{g.shade_visible=false;cx.notify();});draw(w,cx);let underlay=w.render_to_image()?;
    let scale=w.scale_factor();let x=(f32::from(target.left())*scale).ceil() as u32;let y=(f32::from(target.top())*scale).ceil() as u32;let width=(f32::from(target.size.width)*scale).floor() as u32;let height=(f32::from(target.size.height)*scale).floor() as u32;
    underlay.save(out.join(format!("mask-underlay-{}.png",f32::from(w.viewport_size().width))))?;
    anyhow::ensure!(image::imageops::crop_imm(&shaded,x,y,width,height).to_image()==image::imageops::crop_imm(&underlay,x,y,width,height).to_image(),"Cutout darkens the highlighted control");
    guide.update(cx,|g,cx|{g.shade_visible=true;cx.notify();});draw(w,cx);}press(&view,w,cx,"guide-next")?;Ok(())})??;
   cx.background_executor().timer(Duration::from_millis(80)).await;
  }
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{view.read(cx).header.clone().update(cx,|_,cx|cx.emit(header::HeaderEvent::Settings));draw(w,cx);Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(80)).await;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Settings,"Settings not opened");view.read(cx).settings.clone().update(cx,|_,cx|cx.emit(settings::SettingsEvent::QuickStart));draw(w,cx);Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(100)).await;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Player&&view.read(cx).quick_start.read(cx).is_open(),"Settings replay did not return to workspace");capture(&view,w,cx,&out,&format!("settings-entry-{width}"))?;key(w,cx,"escape");anyhow::ensure!(!view.read(cx).quick_start.read(cx).is_open()&&view.read(cx).screen==Screen::Player,"Escape leaked into workspace navigation");Ok(())})??;
 }
 std::fs::write(out.join("result.json"),b"{\"welcome\":true,\"librarySteps\":4,\"playerSteps\":8,\"sizes\":2,\"keyboardTrap\":true,\"back\":true,\"modalInputBlocked\":true,\"cutoutTargetPixelExact\":true,\"helpEntry\":true,\"settingsEntry\":true,\"escape\":true,\"hidden\":true,\"muted\":true}")?;Ok(())
 }.await;
 match result{Ok(())=>eprintln!("QUICK_START passed"),Err(e)=>eprintln!("QUICK_START failed: {e:#}")};let _=cx.update(|cx|cx.quit());
}).detach();
}

/// Real native Library composition with isolated catalog/account snapshots.
/// The demo-mode host has no backend, audio, account or network worker; this
/// observer qualifies the mounted guide target and its controls, not Drive I/O.
fn run_native_drive(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            anyhow::ensure!(integration::fixture_mode(), "Native guide snapshots require the isolated demo host");
            handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                let p = view.read(cx);
                anyhow::ensure!(p.backend.is_none() && p.drive_service.is_none(), "Guide snapshot observer started native/account workers");
                Ok(())
            })??;
            macro_rules! settle {
                () => {{
                    cx.background_executor().timer(Duration::from_millis(80)).await;
                    handle.update(cx, |_, w, cx| draw(w, cx))?;
                }};
            }
            let configured = serde_json::json!(["browse", "saved", "training", "sync", "settings"]);
            let ordinary = serde_json::json!(["browse", "saved", "training", "settings"]);
            let mut reveals = Vec::new();
            for (width, height) in [(1280., 800.), (1060., 640.)] {
                let mut before_reveal = serde_json::Value::Null;
                handle.update(cx, |_, w, cx| {
                    w.resize(size(px(width), px(height)));
                    view.update(cx, |p, cx| {
                        p.screen = Screen::Library;
                        p.loaded_song = false;
                        p.playing = false;
                        p.model_auto_checked = true;
                        p.library.update(cx, |s, cx| {
                            s.review_guide_drive(true, false, cx);
                            s.set_animation_time(0.33, cx);
                            s.review_guide_page_top();
                        });
                        cx.notify();
                    });
                })?;
                let deadline = Instant::now() + Duration::from_secs(12);
                loop {
                    settle!();
                    if handle.update(cx, |_, w, _| w.viewport_size() == size(px(width), px(height)))? { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Guide viewport did not settle");
                }
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_quick_start(false, cx)))?;
                settle!();
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).quick_start.read(cx).snapshot()["targets"] == ordinary, "Unconfigured Library admitted sync");
                    capture(&view, w, cx, &out, &format!("unconfigured-{width}"))?;
                    key(w, cx, "escape");
                    view.read(cx).library.clone().update(cx, |s, cx| s.review_guide_drive(true, true, cx));
                    Ok(())
                })??;
                settle!();
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_quick_start(false, cx)))?;
                settle!();
                for index in 0..5 {
                    handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                        let state = view.read(cx).quick_start.read(cx).snapshot();
                        anyhow::ensure!(state["index"] == index && state["targets"] == configured, "Configured Library guide order differs: {state}");
                        if index == 3 {
                            let library = view.read(cx).library.read(cx);
                            let page = library.review_guide_page();
                            let target = library.guides.get("sync").ok_or_else(|| anyhow::anyhow!("Actual Drive row is unmeasured"))?;
                            anyhow::ensure!(f32::from(target.top()) >= page["viewport"]["top"].as_f64().unwrap() as f32 + 7.9
                                && f32::from(target.bottom()) <= page["viewport"]["bottom"].as_f64().unwrap() as f32 - 7.9,
                                "Sync target was not fully revealed: {target:?} {page}");
                            let before_offset = before_reveal["page"]["offsetY"].as_f64().unwrap();
                            let after_offset = page["offsetY"].as_f64().unwrap();
                            anyhow::ensure!(after_offset > before_offset + 0.5 && after_offset <= 0.,
                                "Sync guide did not move the real page toward its target: {before_reveal} {page}");
                            reveals.push(serde_json::json!({"width":width,"before":before_reveal,"after":page,"targetTop":f32::from(target.top()),"targetBottom":f32::from(target.bottom())}));
                        }
                        capture(&view, w, cx, &out, &format!("configured-{index}-{width}"))?;
                        if index == 2 { view.read(cx).library.read(cx).review_guide_page_bottom(); }
                        Ok(())
                    })??;
                    if index == 2 {
                        settle!();
                        before_reveal = handle.update(cx, |_, _, cx| -> anyhow::Result<serde_json::Value> {
                            let library = view.read(cx).library.read(cx);
                            let target = library.guides.get("sync").ok_or_else(|| anyhow::anyhow!("Drive row missing before reveal"))?;
                            let page = library.review_guide_page();
                            let offset = page["offsetY"].as_f64().unwrap();
                            let max = page["maxOffsetY"].as_f64().unwrap();
                            anyhow::ensure!(max > 0.5 && offset < -0.5 && (offset + max).abs() < 0.1,
                                "Catalog did not supply a valid overflowing bottom position: {page}");
                            anyhow::ensure!(f32::from(target.bottom()) < page["viewport"]["top"].as_f64().unwrap() as f32 - 0.5,
                                "Actual sync row was not offscreen above the page before Next: {target:?} {page}");
                            Ok(serde_json::json!({"page":page,"targetTop":f32::from(target.top()),"targetBottom":f32::from(target.bottom())}))
                        })??;
                    }
                    handle.update(cx, |_, w, cx| press(&view, w, cx, "guide-next"))??;
                    settle!();
                    if index == 3 {
                        handle.update(cx, |_, w, cx| press(&view, w, cx, "guide-back"))??;
                        settle!();
                        handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                            let state = view.read(cx).quick_start.read(cx).snapshot();
                            anyhow::ensure!(state["index"] == 3 && state["targets"][3] == "sync", "Back did not return to sync: {state}");
                            capture(&view, w, cx, &out, &format!("sync-back-{width}"))?;
                            press(&view, w, cx, "guide-next")
                        })??;
                        settle!();
                    }
                }
                handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                    let p = view.read(cx);
                    anyhow::ensure!(!p.quick_start.read(cx).is_open(), "Configured tour did not finish");
                    anyhow::ensure!(p.library.read(cx).guides.get("sync").is_some(), "Stale-anchor guard was not exercised");
                    p.library.clone().update(cx, |s, cx| s.review_guide_drive(true, false, cx));
                    Ok(())
                })??;
                settle!();
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_quick_start(false, cx)))?;
                settle!();
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).quick_start.read(cx).snapshot()["targets"] == ordinary, "Removed Drive row retained its cached sync step");
                    capture(&view, w, cx, &out, &format!("removed-{width}"))?;
                    key(w, cx, "escape");
                    view.read(cx).library.clone().update(cx, |s, cx| s.review_guide_drive(false, true, cx));
                    Ok(())
                })??;
                settle!();
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_quick_start(false, cx)))?;
                settle!();
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).quick_start.read(cx).snapshot()["targets"] == ordinary, "Demo mode admitted the historical native sync anchor");
                    capture(&view, w, cx, &out, &format!("mode-reset-{width}"))?;
                    key(w, cx, "escape");
                    Ok(())
                })??;
                settle!();
            }
            let mut cases = std::fs::read_dir(&out)?.map(|entry| entry.map(|e|e.path())).collect::<std::io::Result<Vec<_>>>()?;
            cases.sort();
            let cases = cases.into_iter().filter(|path|path.to_string_lossy().ends_with(".state.json"))
                .map(|path|Ok(serde_json::from_slice::<serde_json::Value>(&std::fs::read(path)?)?))
                .collect::<anyhow::Result<Vec<_>>>()?;
            anyhow::ensure!(cases.len() == 18 && reveals.len() == 2, "Native Drive guide matrix is incomplete");
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "passed":true,"nativeDriveStage":true,"nativeDriveGuide":true,"configuredTargets":configured,"unconfiguredTargets":ordinary,
                "sizes":2,"backToSync":true,"removedRowExcluded":true,"modeResetExcluded":true,"autoScrollMovement":true,
                "cachedAnchorRetained":true,"hidden":true,"muted":true,"backendStarted":false,
                "accountQualified":false,"reveals":reveals,"source":source_identity(),"cases":cases
            }))?)?;
            Ok(())
        }.await;
        match result { Ok(()) => eprintln!("QUICK_START_NATIVE_DRIVE passed"), Err(error) => eprintln!("QUICK_START_NATIVE_DRIVE failed: {error:#}") }
        let _ = cx.update(|cx| cx.quit());
    }).detach();
}

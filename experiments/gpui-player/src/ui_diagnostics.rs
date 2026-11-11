//! Hidden LogPanel interactions through the real native diagnostic service.
//! Explicitly labelled fixture events are not simulated engine activity.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::{Duration, Instant},
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
    view.read(cx).log_panel.read(cx).state(w, cx)
}
fn press(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let bounds = view
        .read(cx)
        .log_panel
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing diagnostic control {id}"))?;
    anyhow::ensure!(
        bounds.size.width > px(0.)
            && bounds.size.height > px(0.)
            && bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= w.viewport_size().width
            && bounds.bottom() <= w.viewport_size().height,
        "Diagnostic control {id} clipped: {bounds:?}"
    );
    click(w, cx, bounds.center());
    Ok(())
}
fn header(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let bounds = view
        .read(cx)
        .header
        .read(cx)
        .guides
        .get("log")
        .ok_or_else(|| anyhow::anyhow!("Header Log control not measured"))?;
    click(w, cx, bounds.center());
    Ok(())
}
fn shot(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
    viewport: (f32, f32),
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        w.viewport_size() == size(px(viewport.0), px(viewport.1)),
        "Diagnostics viewport mismatch"
    );
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Diagnostic test activated/presented hidden window"
    );
    let image = w.render_to_image()?;
    let scale = w.scale_factor();
    anyhow::ensure!(
        image.width() == (viewport.0 * scale).round() as u32
            && image.height() == (viewport.1 * scale).round() as u32,
        "Diagnostic raster dimensions mismatch"
    );
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&serde_json::json!({
            "viewport":[viewport.0,viewport.1],"scale":scale,"panel":state(view,w,cx),
            "windowPresented":w.is_visible(),"windowActive":w.is_window_active(),
            "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),
            "mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
            "visualReference":"candidate only; matched production reference absent",
            "liveFps":"unmeasured: hidden native window"
        }))?,
    )?;
    Ok(())
}

fn log(view: &Entity<Player>, cx: &App, line: &str) -> anyhow::Result<()> {
    let service = view
        .read(cx)
        .diagnostics
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Native diagnostics service absent"))?;
    anyhow::ensure!(
        service
            .sink()
            .log("diagnostics-ui-fixture", line, diagnostics::Level::Info),
        "Diagnostic fixture queue refused an event"
    );
    Ok(())
}
fn prompt(view: &Entity<Player>, cx: &mut App, dest: Option<PathBuf>) {
    view.update(cx, |p, _| p.diagnostics_prompt_paths.push_back(dest));
}
fn gate(path: &Path) -> anyhow::Result<()> {
    let _ = std::fs::remove_file(path.with_extension("ready"));
    std::fs::write(path, b"hold actual native diagnostic worker")?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    let clipboard = cx.read_from_clipboard();
    cx.spawn(async move|cx|{
        let mut viewport=(1280.,800.);
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;
            let config=PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").ok_or_else(||anyhow::anyhow!("Missing isolated diagnostic config"))?);
            let read_gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_DIAGNOSTICS_READ_GATE").ok_or_else(||anyhow::anyhow!("Missing isolated read gate"))?);
            let save_gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_DIAGNOSTICS_SAVE_GATE").ok_or_else(||anyhow::anyhow!("Missing isolated save gate"))?);
            let mut inventory_open_proofs=Vec::<serde_json::Value>::new();
            macro_rules! wait {($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(25);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                    if ready{break;}if Instant::now()>=deadline{let actual=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Diagnostics timeout: {}; panel {actual}",stringify!($predicate));}
                }
            }};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,$id))??;};}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,$name,viewport))??;};}
            macro_rules! open {()=>{{
                let receipt=std::rc::Rc::new(std::cell::RefCell::new(None::<anyhow::Result<serde_json::Value>>));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    let previous_count=state(&view,w,cx)["sessions"].as_array().map(Vec::len).unwrap_or(0);
                    header(&view,w,cx)?;let sink=receipt.clone();let player=view.clone();
                    // Same App effect cycle, after the real Header subscription
                    // opens the panel but before polling adopts the worker list.
                    w.defer(cx,move|w,cx|{
                        let proof=(||->anyhow::Result<serde_json::Value>{let p=player.read(cx);let panel=state(&player,w,cx);
                            anyhow::ensure!(p.screen==Screen::Log&&p.log_panel.read(cx).is_open(),"Header Log event did not open native panel before deferred boundary");
                            anyhow::ensure!(p.diagnostics_list_pending.is_some_and(|(_,session)|session==p.diagnostics_session),"New session inventory was not pending at Header event boundary");
                            anyhow::ensure!(panel["sessions"].as_array().is_some_and(Vec::is_empty),"Reopened Log exposed stale/pruned session IDs before list reply: {panel}");
                            Ok(serde_json::json!({"scope":"Window.defer in same actual HeaderLog App effect cycle; before list adoption","previousInventoryCount":previous_count,"sessions":panel["sessions"],"selectedSession":panel["selectedSession"],"modalSession":p.diagnostics_session,"pendingList":p.diagnostics_list_pending}))
                        })();*sink.borrow_mut()=Some(proof);
                    });Ok(())
                })??;
                let proof=receipt.borrow_mut().take().ok_or_else(||anyhow::anyhow!("Header inventory boundary did not execute in same App effect cycle"))??;inventory_open_proofs.push(proof);
                wait!(p,w,app=>p.screen==Screen::Log);handle.update(cx,|_,w,cx|{view.read(cx).log_panel.clone().update(cx,|s,cx|s.set_animation_time(Some(0.25),cx));draw(w,cx);})?;
            }};}
            macro_rules! selected {($id:expr)=>{{let expected:&str=$id;wait!(p,w,app=>state(&view,w,app)["selectedSession"].as_str()==Some(expected)&&state(&view,w,app)["loading"]==false);}};}
            macro_rules! measured {()=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{let ready=handle.update(cx,|_,w,cx|{draw(w,cx);state(&view,w,cx)["measuredContentHeight"].is_number()})?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Native log intrinsic measurement did not settle");cx.background_executor().timer(Duration::from_millis(20)).await;}}};}
            wait!(p,w,app=>p.diagnostics.as_ref().is_some_and(|s|s.snapshot().session_name.is_some()));
            if std::env::var("SINGZ_GPUI_DIAGNOSTICS_STAGE").as_deref()==Ok("seed") {
                // Small acknowledged batches never overflow the real service's
                // nonblocking producer queue; no fixture directly writes a log.
                for start in (0..4107).step_by(48) {
                    let end=(start+48).min(4107);
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{for i in start..end{log(&view,cx,&format!("diagnostics-ui-seed-{i:04}: durable fixture event; not engine activity"))?;}Ok(())})??;
                    let last=format!("diagnostics-ui-seed-{:04}:",end-1);
                    wait!(p,w,app=>p.diagnostics.as_ref().unwrap().snapshot().entries.iter().any(|e|e.line.starts_with(&last)));
                }
                cx.background_executor().timer(Duration::from_millis(800)).await;
                let name=handle.update(cx,|_,_,cx|view.read(cx).diagnostics.as_ref().unwrap().snapshot().session_name.clone().unwrap())?;
                let raw=std::fs::read_to_string(config.join("logs").join(&name))?;
                anyhow::ensure!(raw.lines().filter(|line|line.contains("diagnostics-ui-seed-")).count()==4107&&raw.contains("diagnostics-ui-seed-0000:")&&raw.contains("diagnostics-ui-seed-4106:"),"Real service did not persist all 4107 seed events");
                std::fs::write(out.join("session.json"),serde_json::to_vec_pretty(&serde_json::json!({"name":name,"fixtureEvents":4107,"scope":"actual native diagnostics service; explicit fixture events; not engine inference"}))?)?;
                std::fs::write(out.join("seed-session.txt"),raw)?;
                std::fs::write(out.join("result.json"),b"{\"durableNativeSession\":true,\"boundedAcknowledgedBatches\":true}")?;
                return Ok(());
            }
            let seed:serde_json::Value=serde_json::from_slice(&std::fs::read(out.parent().unwrap().join("seed/session.json"))?)?;
            let seed_name=seed["name"].as_str().ok_or_else(||anyhow::anyhow!("Missing prior launch identity"))?.to_owned();
            let seed_path=config.join("logs").join(&seed_name);let seed_raw=std::fs::read_to_string(&seed_path)?;let expected_past_copy=diagnostics::format_copy(&diagnostics::parse_session(&seed_raw).entries);
            anyhow::ensure!(seed_raw.contains("diagnostics-ui-seed-4106:"),"Previous process session was not retained");
            if std::env::var("SINGZ_GPUI_DIAGNOSTICS_STAGE").as_deref()==Ok("short") {
                // A separate actual app launch supplies genuinely short live rows;
                // no backend ring or LogPanel fixture is cleared to manufacture this.
                for (width,height) in [(1280.,800.),(1060.,640.)] {
                    viewport=(width,height);handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));open!();
                    wait!(p,w,app=>p.diagnostics_list_pending.is_none()&&state(&view,w,app)["sessions"].as_array().is_some_and(|ss|ss.iter().any(|s|s["id"]==seed_name)));
                    handle.update(cx,|_,_,cx|log(&view,cx,&format!("short-live-{}: explicit fixture for intrinsic shrink",width as u32)))??;
                    wait!(p,w,app=>state(&view,w,app)["copyText"].as_str().is_some_and(|s|s.contains(&format!("short-live-{}:",width as u32))));
                    measured!();let before=handle.update(cx,|_,w,cx|->anyhow::Result<f32>{draw(w,cx);let h=f32::from(view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Short body unmeasured"))?.size.height);anyhow::ensure!(h==238.,"Fresh short current session did not use source minimum inner height238: {h}");Ok(h)})??;
                    shot!(&format!("short-live-before-{}",width as u32));
                    press!("log-session");let index=handle.update(cx,|_,w,cx|state(&view,w,cx)["sessions"].as_array().unwrap().iter().position(|s|s["id"]==seed_name).unwrap())?;press!(&format!("log-session-option-{index}"));selected!(&seed_name);
                    measured!();let tall=handle.update(cx,|_,w,cx|->anyhow::Result<f32>{draw(w,cx);let h=f32::from(view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Past body unmeasured"))?.size.height);anyhow::ensure!(h==height-179.5&&h>before+80.,"Past4000 body did not grow to source viewport cap: {h}, viewport {height}, short {before}");Ok(h)})??;
                    shot!(&format!("short-past-expanded-{}",width as u32));press!("log-session");press!("log-session-current");
                    wait!(p,w,app=>state(&view,w,app)["selectedSession"].is_null()&&state(&view,w,app)["copyText"].as_str().is_some_and(|s|s.contains(&format!("short-live-{}:",width as u32))));
                    measured!();let restored=handle.update(cx,|_,w,cx|->anyhow::Result<f32>{draw(w,cx);let h=f32::from(view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Restored short body unmeasured"))?.size.height);anyhow::ensure!(h==before&&h==238.&&tall>h+80.,"Body did not shrink4000past→shortlive: before {before}, past {tall}, restored {h}");Ok(h)})??;
                    shot!(&format!("short-restored-{}",width as u32));std::fs::write(out.join(format!("intrinsic-shrink-{}.json",width as u32)),serde_json::to_vec_pretty(&serde_json::json!({"scope":"fresh actual app launch, real persisted4000past→short native live selector","shortBefore":before,"pastExpanded":tall,"shortRestored":restored,"sourceInnerMinimum":238,"sourceInnerMaximum":height-179.5}))?)?;
                    press!("log-close");wait!(p,w,app=>p.screen!=Screen::Log);
                }
                std::fs::write(out.join("inventory-open-boundaries.json"),serde_json::to_vec_pretty(&inventory_open_proofs)?)?;
                std::fs::write(out.join("result.json"),b"{\"freshActualLaunch\":true,\"pastGrowsToSourceCap\":true,\"switchToShortShrinks\":true,\"twoSizes\":true}")?;return Ok(());
            }
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                viewport=(width,height);handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
                open!();
                wait!(p,w,app=>state(&view,w,app)["sessions"].as_array().is_some_and(|ss|ss.iter().any(|s|s["id"]==seed_name)));
                handle.update(cx,|_,_,cx|log(&view,cx,&format!("live-open-{}: real service event while panel visible",width as u32)))??;
                wait!(p,w,app=>state(&view,w,app)["copyText"].as_str().is_some_and(|text|text.contains(&format!("live-open-{}:",width as u32))));
                shot!(&format!("current-{}",width as u32));
                // A long unbroken path must wrap, not disappear into a clipped
                // horizontal area. The final astral glyph straddles the source's
                // UTF-16 limit, making replacement-character semantics observable.
                handle.update(cx,|_,w,cx|draw(w,cx))?;cx.background_executor().timer(Duration::from_millis(60)).await;
                measured!();let baseline=handle.update(cx,|_,w,cx|->anyhow::Result<f64>{draw(w,cx);let s=state(&view,w,cx);let b=view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Long-entry baseline body not measured"))?;Ok(s["maxScrollOffset"][1].as_f64().unwrap_or(0.)+f32::from(b.size.height) as f64)})??;
                let prefix=format!("diagnostics-ui-edge-{}: explicit fixture Привет 🎤 /Users/Тест/",width as u32);
                let retained=prefix.clone()+&"a".repeat(1999-prefix.encode_utf16().count());
                let input=retained.clone()+"🎶ignored-after-utf16-limit";
                let expected=retained+"\u{fffd}";
                anyhow::ensure!(expected.encode_utf16().count()==2000,"Long diagnostic fixture has wrong UTF-16 boundary");
                handle.update(cx,|_,_,cx|log(&view,cx,&input))??;
                wait!(p,w,app=>state(&view,w,app)["rows"].as_array().is_some_and(|rows|rows.iter().any(|row|row["message"]==expected)));measured!();
                handle.update(cx,|_,w,cx|draw(w,cx))?;cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let actual=state(&view,w,cx);let b=view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Long-entry body not measured"))?;let extent=actual["maxScrollOffset"][1].as_f64().unwrap_or(0.)+f32::from(b.size.height) as f64;let evidence=serde_json::json!({"scope":"explicit actual Sink fixture; long unbroken path plus Cyrillic/emoji and split surrogate truncation","input":input,"expected":expected,"expectedUtf16Units":2000,"baselineVerticalExtent":baseline,"afterVerticalExtent":extent,"verticalGrowth":extent-baseline,"bodyViewportHeight":f32::from(b.size.height),"sourceInnerMinimum":238,"sourceInnerMaximum":height-179.5,"maxScrollOffset":actual["maxScrollOffset"],"bodyBounds":format!("{b:?}")});std::fs::write(out.join(format!("long-content-{}.json",width as u32)),serde_json::to_vec_pretty(&evidence)?)?;anyhow::ensure!(actual["maxScrollOffset"][0].as_f64()==Some(0.),"Long non-Latin path horizontally overflows log viewport: {evidence}");anyhow::ensure!(extent>baseline+80.,"Long path did not substantially wrap vertically (may be clipped): {evidence}");let body_height=f32::from(b.size.height);anyhow::ensure!(body_height>318.&&body_height<=height-179.5,"Long wrapped row did not grow body above source minimum within viewport cap: {evidence}");Ok(())})??;
                shot!(&format!("long-content-{}",width as u32));
                press!("log-session");handle.update(cx,|_,w,cx|{key(w,cx,"escape");draw(w,cx);})?;
                let order=handle.update(cx,|_,w,cx|->anyhow::Result<Vec<String>>{
                    let mut order=vec![];for _ in 0..9{let s=state(&view,w,cx);anyhow::ensure!(s["focusInside"]==true,"Tab escaped diagnostics modal: {s}");order.push(s["focusedControl"].as_str().unwrap_or("").to_owned());key(w,cx,"tab");draw(w,cx);}key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Reverse Tab escaped diagnostics");Ok(order)
                })??;
                anyhow::ensure!(order==["log-session","log-copy","log-save","log-close","log-session","log-copy","log-save","log-close","log-session"],"Unexpected diagnostic Tab order: {order:?}");
                std::fs::write(out.join(format!("focus-order-{}.json",width as u32)),serde_json::to_vec_pretty(&order)?)?;
                let copied=Instant::now();press!("log-copy");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(&view,w,cx);anyhow::ensure!(s["copied"]==true,"Copy feedback missing");anyhow::ensure!(cx.read_from_clipboard().and_then(|item|item.text()).as_deref()==s["copyText"].as_str(),"Current Copy clipboard differs from shown rows");anyhow::ensure!(s["copyText"].as_str().is_some_and(|text|text.lines().any(|line|line.ends_with(&expected)))&&!s["copyText"].as_str().unwrap_or("").contains("ignored-after-utf16-limit"),"Current Copy lost Unicode or UTF-16 truncation semantics");Ok(())})??;
                shot!(&format!("copied-{}",width as u32));
                let elapsed=copied.elapsed();if elapsed<Duration::from_millis(1500){cx.background_executor().timer(Duration::from_millis(1500)-elapsed).await;}
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["copied"]==true,"Log Copy reset before 2 seconds");Ok(())})??;
                wait!(p,w,app=>state(&view,w,app)["copied"]==false);anyhow::ensure!(copied.elapsed()>=Duration::from_secs(2),"Copy feedback reset prematurely");
                shot!(&format!("copy-reset-{}",width as u32));
                let current=out.join(format!("current-{}.txt",width as u32));let _=std::fs::remove_file(&current);
                handle.update(cx,|_,_,cx|prompt(&view,cx,Some(current.clone())))?;press!("log-save");
                wait!(p,w,app=>state(&view,w,app)["savedTo"].as_str()==current.to_str());
                let text=std::fs::read_to_string(&current)?;anyhow::ensure!(text.starts_with("SingZ ")&&text.contains(&format!("live-open-{}:",width as u32)),"Current native export omitted actual live log");anyhow::ensure!(text.lines().any(|line|line.ends_with(&expected))&&!text.contains("ignored-after-utf16-limit"),"Actual native Save lost exact Unicode/UTF-16-truncated long entry");
                shot!(&format!("current-saved-{}",width as u32));
                // A cancelled native prompt never queues an export or replaces a file.
                let requests=handle.update(cx,|_,_,cx|view.read(cx).diagnostics_prompt_requests.len())?;
                handle.update(cx,|_,_,cx|prompt(&view,cx,None))?;press!("log-save");
                wait!(p,w,app=>p.diagnostics_prompt_requests.len()==requests+1);
                let collision=out.join(format!("existing-{}.txt",width as u32));std::fs::write(&collision,b"existing user export must survive")?;
                handle.update(cx,|_,_,cx|prompt(&view,cx,Some(collision.clone())))?;press!("log-save");
                wait!(p,w,app=>p.diagnostics_prompt_requests.len()==requests+2&&p.diagnostics_save_pending.is_none());
                anyhow::ensure!(std::fs::read(&collision)?==b"existing user export must survive","Unconfirmed export overwrote existing file");
                // Actual overflowing ring rows exercise follow and manual wheel input.
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{for i in 0..160{log(&view,cx,&format!("scroll-{}-{i:03}: explicit diagnostic UI fixture",width as u32))?;}Ok(())})??;
                wait!(p,w,app=>state(&view,w,app)["copyText"].as_str().is_some_and(|text|text.contains(&format!("scroll-{}-159:",width as u32))));
                handle.update(cx,|_,w,cx|draw(w,cx))?;cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let before=state(&view,w,cx);anyhow::ensure!(before["follow"]==true,"New live rows did not retain follow: {before}");let b=view.read(cx).log_panel.read(cx).bounds("log-body").ok_or_else(||anyhow::anyhow!("Log body not measured"))?;w.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:b.center(),delta:ScrollDelta::Pixels(point(px(0.),px(700.))),..Default::default()}),cx);draw(w,cx);let after=state(&view,w,cx);let diagnostic=serde_json::json!({"before":before,"after":after,"bodyBounds":format!("{b:?}"),"wheelPosition":format!("{:?}",b.center()),"wheelDeltaPixels":[0,700],"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)]});std::fs::write(out.join(format!("wheel-diagnostics-{}.json",width as u32)),serde_json::to_vec_pretty(&diagnostic)?)?;anyhow::ensure!(after["follow"]==false,"Manual upward scroll did not suspend follow; {diagnostic}");Ok(())})??;
                let old_offset=handle.update(cx,|_,w,cx|state(&view,w,cx)["scrollOffset"].clone())?;
                handle.update(cx,|_,_,cx|log(&view,cx,&format!("while-scrolled-{}: do not jump to bottom",width as u32)))??;
                wait!(p,w,app=>state(&view,w,app)["copyText"].as_str().is_some_and(|s|s.contains(&format!("while-scrolled-{}:",width as u32))));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);anyhow::ensure!(state(&view,w,cx)["scrollOffset"]==old_offset,"Live append moved manual reading position");Ok(())})??;
                shot!(&format!("manual-scroll-{}",width as u32));
                // Popup keyboard selection drives the real asynchronous session read.
                press!("log-session");wait!(p,w,app=>state(&view,w,app)["popup"]==true);
                shot!(&format!("session-popup-{}",width as u32));
                handle.update(cx,|_,w,cx|{key(w,cx,"escape");draw(w,cx);})?;
                wait!(p,w,app=>p.screen==Screen::Log&&state(&view,w,app)["popup"]==false);
                // Outside click dismisses only the selector, preserving the modal.
                press!("log-session");handle.update(cx,|_,w,cx|click(w,cx,point(px(5.),px(5.))))?;
                wait!(p,w,app=>p.screen==Screen::Log&&state(&view,w,app)["popup"]==false);
                gate(&read_gate)?;press!("log-session");
                let index=handle.update(cx,|_,w,cx|state(&view,w,cx)["sessions"].as_array().unwrap().iter().position(|s|s["id"]==seed_name).unwrap())?;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let initial=state(&view,w,cx);anyhow::ensure!(initial["focusedControl"]=="log-session-current","Popup did not focus current launch");key(w,cx,"shift-tab");draw(w,cx);anyhow::ensure!(state(&view,w,cx)["focusInside"]==true,"Reverse Tab escaped session popup");key(w,cx,"tab");draw(w,cx);for _ in 0..=index{key(w,cx,"down");draw(w,cx);}anyhow::ensure!(state(&view,w,cx)["focusedControl"]==format!("log-session-option-{index}"),"Keyboard did not focus persisted launch option");key(w,cx,"enter");Ok(())})??;
                wait!(p,w,app=>read_gate.with_extension("ready").exists()&&state(&view,w,app)["loading"]==true);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(&view,w,cx);anyhow::ensure!(s["rowCount"]==0&&s["selectedSession"]==seed_name,"Session loading showed rows from wrong launch: {s}");Ok(())})??;
                shot!(&format!("past-loading-{}",width as u32));
                // Switch to live before the old read returns: its receipt must be fenced.
                press!("log-session");press!("log-session-current");std::fs::remove_file(&read_gate)?;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(&view,w,cx);anyhow::ensure!(s["selectedSession"].is_null()&&!s["copyText"].as_str().unwrap_or("").contains("diagnostics-ui-seed-"),"Stale read replaced current session");Ok(())})??;
                press!("log-session");press!(&format!("log-session-option-{index}"));selected!(&seed_name);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(&view,w,cx);anyhow::ensure!(s["rowCount"]==4000&&s["total"].as_u64().is_some_and(|n|n>4107),"Past tail/total incorrect: {s}");anyhow::ensure!(s["copyText"].as_str().unwrap_or("").contains("diagnostics-ui-seed-4106:")&&!s["copyText"].as_str().unwrap_or("").contains("diagnostics-ui-seed-0000:"),"Past rows not authoritative 4000 tail");Ok(())})??;
                press!("log-copy");handle.update(cx,|_,w,cx|->anyhow::Result<()>{let copied=cx.read_from_clipboard().and_then(|item|item.text());anyhow::ensure!(copied.as_deref()==Some(expected_past_copy.as_str())&&copied.as_deref()==state(&view,w,cx)["copyText"].as_str(),"Past Copy did not copy authoritative parsed 4000 tail");Ok(())})??;
                shot!(&format!("past-tail-{}",width as u32));
                let past=out.join(format!("past-full-{}.txt",width as u32));let _=std::fs::remove_file(&past);
                handle.update(cx,|_,_,cx|prompt(&view,cx,Some(past.clone())))?;press!("log-save");wait!(p,w,app=>state(&view,w,app)["savedTo"].as_str()==past.to_str());
                anyhow::ensure!(std::fs::read_to_string(&past)?==seed_raw,"Past Save did not export entire retained launch byte-for-byte");
                // Synthetic OS callback delivery ordering only: both accepted paths
                // still execute the same production receiver and actual export worker.
                // A newer prompt resolves first while its export is held; the older
                // accepted prompt must not steal that latest UI receipt slot.
                let older=out.join(format!("callback-older-{}.txt",width as u32));
                let newer=out.join(format!("callback-newer-{}.txt",width as u32));
                let _=std::fs::remove_file(&older);let _=std::fs::remove_file(&newer);gate(&save_gate)?;
                let (older_serial,newer_serial,modal)=handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{
                    let old_serial=p.diagnostics_save_serial+1;let new_serial=old_serial+1;let modal=p.diagnostics_session;
                    p.diagnostics_save_serial=new_serial;
                    p.accept_diagnostics_path(new_serial,modal,Some(seed_name.clone()),Some(newer.clone()),false,cx);
                    (old_serial,new_serial,modal)
                }))?;
                wait!(p,w,app=>save_gate.with_extension("ready").exists()&&p.diagnostics_save_pending.as_ref().is_some_and(|(_,_,s,_)|*s==newer_serial));
                let latest_pending=handle.update(cx,|_,_,cx|view.read(cx).diagnostics_save_pending.clone())?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.accept_diagnostics_path(older_serial,modal,Some(seed_name.clone()),Some(older.clone()),false,cx)))?;
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).diagnostics_save_pending==latest_pending,"Older accepted callback stole newer pending UI receipt");Ok(())})??;
                std::fs::remove_file(&save_gate)?;
                wait!(p,w,app=>older.is_file()&&newer.is_file()&&p.diagnostics_save_pending.is_none()&&state(&view,w,app)["savedTo"].as_str()==newer.to_str());
                anyhow::ensure!(std::fs::read_to_string(&older)?==seed_raw&&std::fs::read_to_string(&newer)?==seed_raw,"Out-of-order accepted prompt lost a real export");
                // Let any late older receipt be delivered before checking UI ownership.
                cx.background_executor().timer(Duration::from_millis(100)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["savedTo"].as_str()==newer.to_str(),"Late older export overwrote latest Saved to receipt");Ok(())})??;
                shot!(&format!("save-callback-order-{}",width as u32));
                std::fs::write(out.join(format!("save-callback-order-{}.json",width as u32)),serde_json::to_vec_pretty(&serde_json::json!({"scope":"synthetic out-of-order native save-prompt callbacks; production acceptance and export worker","olderSerial":older_serial,"newerSerial":newer_serial,"modalSession":modal,"deliveryOrder":[newer_serial,older_serial],"olderPath":older,"newerPath":newer,"bothActualExports":true,"latestReceiptRetained":true}))?)?;
                // Closing while a real Save is pending must fence the old dialog receipt.
                let stale=out.join(format!("closed-save-{}.txt",width as u32));let _=std::fs::remove_file(&stale);gate(&save_gate)?;
                handle.update(cx,|_,_,cx|prompt(&view,cx,Some(stale.clone())))?;press!("log-save");wait!(p,w,app=>save_gate.with_extension("ready").exists());
                press!("log-close");wait!(p,w,app=>p.screen!=Screen::Log);open!();
                std::fs::remove_file(&save_gate)?;wait!(p,w,app=>p.diagnostics_save_pending.is_none()&&stale.is_file());
                anyhow::ensure!(std::fs::read_to_string(&stale)?==seed_raw,"Accepted Save was lost when its dialog closed");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let s=state(&view,w,cx);anyhow::ensure!(s["selectedSession"].is_null()&&s["savedTo"].is_null(),"Closed dialog save receipt leaked into reopened current session: {s}");Ok(())})??;
                shot!(&format!("reopened-after-save-{}",width as u32));
                // Missing and non-file reads use the actual retained-session worker.
                wait!(p,w,app=>p.diagnostics_list_pending.is_none()&&p.diagnostics_read_pending.is_none());
                let backup=seed_path.with_extension("test-backup");std::fs::rename(&seed_path,&backup)?;
                press!("log-session");press!(&format!("log-session-option-{index}"));selected!(&seed_name);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["copyText"].as_str().is_some_and(|s|s.contains("That session log is no longer kept.")),"Missing session did not display honest fallback");Ok(())})??;
                shot!(&format!("past-missing-{}",width as u32));
                let missing_export=out.join(format!("missing-{}.txt",width as u32));let _=std::fs::remove_file(&missing_export);handle.update(cx,|_,_,cx|prompt(&view,cx,Some(missing_export.clone())))?;press!("log-save");wait!(p,w,app=>p.diagnostics_save_pending.is_none());anyhow::ensure!(!missing_export.exists(),"Missing session Save created a fabricated export");
                std::fs::create_dir(&seed_path)?;press!("log-session");press!("log-session-current");press!("log-session");press!(&format!("log-session-option-{index}"));selected!(&seed_name);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(state(&view,w,cx)["copyText"].as_str().is_some_and(|s|s.contains("That session log is no longer kept.")),"Non-file session read did not display honest fallback");Ok(())})??;
                shot!(&format!("past-read-error-{}",width as u32));
                std::fs::remove_dir(&seed_path)?;std::fs::rename(&backup,&seed_path)?;
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>p.screen!=Screen::Log);open!();
                handle.update(cx,|_,w,cx|click(w,cx,point(px(5.),px(5.))))?;wait!(p,w,app=>p.screen!=Screen::Log);
            }
            std::fs::write(out.join("inventory-open-boundaries.json"),serde_json::to_vec_pretty(&inventory_open_proofs)?)?;
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"emptyInventoryWhileListPending":true,"twoSizes":true,"headerLogRoute":true,"liveNativeEvents":true,"longUnbrokenUnicodeWrap":true,"utf16TruncationCopySave":true,"copyExact":true,"copyTwoSecondReset":true,"actualCurrentExport":true,"actualFullPastExport":true,"outOfOrderAcceptedSaveCallbacks":true,"cancelledPrompt":true,"nonoverwrite":true,"pastTail4000":true,"asyncLoading":true,"staleReadFence":true,"manualScrollFollow":true,"focusTrap":true,"popupEscape":true,"closePendingSaveFence":true,"acceptedSaveSurvivesClose":true,"keyboardSessionSelect":true,"outsidePopupDismissal":true,"missingAndReadError":true,"restartPreviousSession":true,"escapeCloseScrim":true,"hidden":true,"muted":true}))?)?;
            Ok(())
        }.await;
        let _=cx.update(|cx|cx.write_to_clipboard(clipboard.unwrap_or(ClipboardItem{entries:vec![]})));
        match result {Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(error)=>{let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let captured=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure",viewport));if let Err(capture_error)=captured{eprintln!("DIAGNOSTICS_UI failure capture unavailable: {capture_error:#}");}eprintln!("DIAGNOSTICS_UI failed: {error:#}");let _=cx.update(|cx|cx.quit());}}
    }).detach();
}

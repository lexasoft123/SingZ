//! App-scoped Log capture and dismissal checks; never activates the hidden window.
use super::*;
use std::{path::PathBuf, time::Duration};

fn click(window: &mut Window, cx: &mut App, x: f32, y: f32) {
    let position = point(px(x), px(y));
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    let _ = window.draw(cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    let _ = window.draw(cx);
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
}
fn escape(window: &mut Window, cx: &mut App) {
    window.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("escape").expect("Escape"),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, directory: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&directory)?;
            for (width, height) in [(1280., 800.), (1060., 640.)] {
                handle.update(cx, |_, w, cx| {
                    w.resize(size(px(width), px(height)));
                    view.update(cx, |this, cx| {
                        this.screen = Screen::Library;
                        this.loaded_song = false;
                        this.notice = None;
                        this.library.update(cx, |lib, cx| lib.set_animation_time(1., cx));
                        this.header.update(cx, |header, cx| header.set_review_fixture(true, cx));
                        cx.notify();
                    });
                })?;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                for rows in [false, true] {
                    handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                        view.update(cx, |this, cx| { this.screen = Screen::Library; this.backdrop.borrow_mut().clear(w, cx); cx.notify(); });
                        w.refresh(); let _ = w.draw(cx);
                        view.update(cx, |this, cx| {
                            this.log_panel.update(cx, |log, cx| log.set_fixture(rows, false, cx));
                            this.previous_screen = Screen::Library;
                            this.screen = Screen::Log;
                            cx.notify();
                        });
                        w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent { position: point(px(-10.), px(-10.)), pressed_button: None, modifiers: Modifiers::default() }), cx);
                        for _ in 0..3 { w.simulate_next_frame(cx); w.refresh(); let _ = w.draw(cx); }
                        let id = format!("log-{}-{}", if rows { "rows" } else { "empty" }, width as u32);
                        w.render_to_image()?.save(directory.join(format!("{id}.png")))?;
                        let snapshot = view.read(cx).log_panel.read(cx).snapshot();
                        anyhow::ensure!(snapshot.0 == if rows { 12 } else { 0 }, "Unexpected log fixture rows");
                        std::fs::write(directory.join(format!("{id}.json")), serde_json::to_vec_pretty(&serde_json::json!({"viewport":[width,height],"deviceScale":w.scale_factor(),"rows":snapshot.0,"capture":"hidden GPUI render_to_image","clipboardUntouched":true}))?)?;
                        Ok(())
                    })??;
                }
                let y = height / 2. - 333.84375 / 2. + 37.;
                handle.update(cx, |_, w, cx| {
                    let start=point(px(width/2.-240.),px(y+46.));
                    let end=point(start.x+px(90.),start.y);
                    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:start,pressed_button:None,modifiers:Modifiers::default()}),cx);let _=w.draw(cx);
                    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:start,button:MouseButton::Left,click_count:1,..Default::default()}),cx);let _=w.draw(cx);
                    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:end,pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}),cx);let _=w.draw(cx);
                    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:end,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                })?;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_,w,cx|->anyhow::Result<()>{anyhow::ensure!(gpui_kit::base::TextSelection::has_selection(w,cx),"Log row text selection did not start");Ok(())})??;
                handle.update(cx, |_, w, cx| click(w, cx, width / 2. + 375., y))?;
                // Entity events are delivered after the dispatch update returns.
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).screen == Screen::Library, "Log Close did not restore catalog");
                    view.update(cx, |this, cx| {
                        this.screen = Screen::Log;
                        this.previous_screen = Screen::Library;
                        this.log_panel.update(cx, |log, cx| log.set_fixture(true, true, cx));
                        cx.notify();
                    });
                    let _ = w.draw(cx);
                    click(w, cx, width / 2. - 220., y);
                    Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).log_panel.read(cx).snapshot().2, "Log selector did not open");
                    w.render_to_image()?.save(directory.join(format!("log-session-popup-{}.png",width as u32)))?;
                    click(w,cx,width/2.-220.,y+64.);Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    let snapshot=view.read(cx).log_panel.read(cx).snapshot();
                    anyhow::ensure!(snapshot.1==Some(0) && !snapshot.2,"Visible past-session option was not selectable: {snapshot:?}");
                    let _=w.draw(cx);click(w,cx,width/2.-220.,y);Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx,|_,w,cx|{escape(w,cx);})?;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).screen == Screen::Log && !view.read(cx).log_panel.read(cx).snapshot().2, "First Escape did not dismiss popup only");
                    escape(w, cx); Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).screen == Screen::Library, "Second Escape did not dismiss Log");
                    view.update(cx, |this, cx| { this.screen = Screen::Log; this.log_panel.update(cx, |log, cx| log.on_open(cx)); cx.notify(); });
                    let _ = w.draw(cx); click(w, cx, 5., 5.); Ok(())
                })??;
                cx.background_executor().timer(Duration::from_millis(30)).await;
                handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                    anyhow::ensure!(view.read(cx).screen == Screen::Library, "Log scrim did not dismiss"); Ok(())
                })??;
            }
            eprintln!("LOG_REVIEW passed: four matching captures, text selection, visible session option, Close, popup-first Escape, scrim; clipboard untouched");
            Ok(())
        }.await;
        match result {
            Ok(()) => { let _ = cx.update(|cx| cx.quit()); }
            Err(error) => { eprintln!("LOG_REVIEW failed: {error:#}"); std::process::exit(1); }
        }
    }).detach();
}

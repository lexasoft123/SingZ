//! Hidden production-parity capture adapter. No global input or app activation.
use super::*;
use std::{path::PathBuf, time::Duration};

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, directory: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&directory)?;
            for (width, height) in [(1280., 800.), (1060., 640.)] {
                handle.update(cx, |_, window, _| window.resize(size(px(width), px(height))))?;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let mut states = vec![("library".to_owned(),Screen::Library,64.),("settings".to_owned(),Screen::Settings,64.),("player".to_owned(),Screen::Player,64.)];
                if width == 1280. { for (index,position) in [64.25,64.2666667,64.2833333,64.3,64.3166667,64.3333333,71.9833333,72.,72.0166667,71.8333333,71.85,71.8666667].into_iter().enumerate() { states.push((format!("lyrics-frame-{index:02}"),Screen::Player,position)); } }
                for (name, screen, position) in states {
                    handle.update(cx, |_, window, cx| view.update(cx, |this, cx| {
                        this.backdrop.borrow_mut().clear(window, cx);
                        this.screen = screen;
                        this.loaded_song = screen == Screen::Player;
                        this.library.update(cx, |library,cx| { library.set_open_song(None,cx); library.set_animation_time(1.,cx); });
                        this.header.update(cx, |header,cx| header.set_review_fixture(true,cx));
                        this.settings.update(cx, |settings,cx| { settings.set_review_fixture(true); if screen==Screen::Settings {settings.on_open(cx);} });
                        this.previous_screen = Screen::Library;
                        this.playing = false;
                        this.position = position;
                        this.muted = std::array::from_fn(|i|i==0);
                        this.fade = std::array::from_fn(|i|if i==0{0.14}else{1.});
                        this.started = Instant::now() - Duration::from_secs(2);
                        this.last = Instant::now();
                        cx.notify();
                    }))?;
                    cx.background_executor().timer(Duration::from_millis(30)).await;
                    handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                        window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent {
                            position: point(px(-1000.), px(-1000.)), pressed_button: None,
                            modifiers: Modifiers::default(),
                        }), cx);
                        // Hidden windows have no display callbacks. Settle paint-driven
                        // scrolling explicitly; this is not a live cadence measurement.
                        for _ in 0..90 {
                            window.simulate_next_frame(cx);
                            window.refresh();
                            let _ = window.draw(cx);
                        }
                        anyhow::ensure!(!view.read(cx).lyric_scroll_active.get() || screen != Screen::Player,
                            "lyric scroll did not settle before capture");
                        let image = window.render_to_image()?;
                        let viewport = window.viewport_size();
                        let id = format!("{name}-{}", width as u32);
                        image.save(directory.join(format!("{id}-candidate.png")))?;
                        std::fs::write(directory.join(format!("{id}-candidate.json")), format!(
                            "{{\"viewport\":[{},{}],\"deviceScale\":{},\"imagePixels\":[{},{}],\"capture\":\"hidden GPUI render_to_image\",\"animationSettled\":true,\"position\":{},\"lyricScroll\":{},\"muted\":[true,false,false,false,false,false],\"solo\":[false,false,false,false,false,false],\"volume\":0.8,\"karaoke\":true,\"locale\":\"en\"}}\n",
                            f32::from(viewport.width), f32::from(viewport.height), window.scale_factor(), image.width(), image.height(), position, view.read(cx).lyric_scroll.get()
                        ))?;
                        eprintln!("UI_REVIEW {id}: viewport {:?}, image {}x{}", viewport, image.width(), image.height());
                        Ok(())
                    })??;
                }
            }
            Ok(())
        }.await;
        match result {
            Ok(()) => { let _ = cx.update(|cx| cx.quit()); }
            Err(error) => { eprintln!("UI_REVIEW failed: {error:#}"); std::process::exit(1); }
        }
    }).detach();
}

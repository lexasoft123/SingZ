//! Offscreen native renderer smoke checks; no OS activation or global input.
use super::*;
use std::{path::PathBuf, time::Duration};

fn click(window: &mut Window, cx: &mut App, x: f32, y: f32) {
    let position = point(px(x), px(y));
    let _ = window.draw(cx);
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
            keystroke: Keystroke::parse("escape").expect("valid test Escape keystroke"),
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
            let graph_bottom_offset=Rc::new(Cell::new(0_f32));
            // Input is dispatched only into the hidden window, never through the OS.
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen == Screen::Library, "Startup did not show catalog");
                view.read(cx).library.clone().update(cx, |library,cx|library.set_animation_time(1.,cx));
                let _ = window.draw(cx);
                window.render_to_image()?.save(directory.join("library.png"))?;
                click(window,cx,640.,413.); // Production Browse hero button.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).notice.is_some(),"Browse did not show safe prototype notice");
                let _ = window.draw(cx);
                window.render_to_image()?.save(directory.join("browse-notice.png"))?;
                click(window,cx,640.,440.); // Captured centered notice Close hit target.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).notice.is_none(),"Browse notice Close did not dismiss");
                click(window,cx,330.,648.); // First production card.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let player = view.read(cx);
                anyhow::ensure!(player.screen == Screen::Player,"Catalog card did not open player");
                anyhow::ensure!(player.song_title.as_ref()=="Room to breathe","Wrong fixture selected: {}",player.song_title);
                anyhow::ensure!(player.position==0.,"Song preview did not reset position");
                let _ = window.draw(cx);
                window.render_to_image()?.save(directory.join("player.png"))?;
                let original_gain = view.read(cx).gain[0];
                window.dispatch_event(PlatformInput::MouseDown(MouseDownEvent {position:point(px(-20.),px(-20.)),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent {position:point(px(121.),px(133.)),pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}),cx);
                anyhow::ensure!(view.read(cx).gain[0] == original_gain, "Slider accepted a drag begun elsewhere");
                window.dispatch_event(PlatformInput::MouseUp(MouseUpEvent {position:point(px(121.),px(133.)),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                view.update(cx,|this,cx|{this.playing=true;this.notice=Some("Modal pause check".into());cx.notify();});
                let _=window.draw(cx);
                let paused=view.read(cx).position;
                view.update(cx,|this,cx|{this.last=Instant::now()-Duration::from_secs(10);cx.notify();});
                let _=window.draw(cx);
                anyhow::ensure!(view.read(cx).position==paused,"Player clock advanced behind notice modal");
                view.update(cx,|this,cx|{this.notice=None;cx.notify();});let _=window.draw(cx);
                anyhow::ensure!((view.read(cx).position-paused).abs()<0.1,"Player clock included time behind modal");
                view.update(cx,|this,cx|{this.playing=false;this.position=0.;cx.notify();});let _=window.draw(cx);
                eprintln!("UI_SMOKE external slider drag rejected; notice clock pauses and resumes without catch-up");
                click(window,cx,96.,718.); // Production first-row Play.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).playing,"Play did not start silent demo clock");
                click(window,cx,96.,718.); // Pause.
                click(window,cx,37.,133.); // First-lane mute.
                click(window,cx,69.,133.); // First-lane solo.
                click(window,cx,121.,133.); // Lane volume near 25%.
                click(window,cx,33.75,541.); // Note bars.
                click(window,cx,93.25,541.); // Fit.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let player=view.read(cx);
                anyhow::ensure!(!player.playing,"Pause did not stop demo clock");
                anyhow::ensure!(player.muted[0] && player.solo[0],"M/S controls did not update first lane");
                anyhow::ensure!((15..=35).contains(&player.gain[0]),"Volume rail did not move near25%: {}",player.gain[0]);
                anyhow::ensure!(!player.pitch_strip.read(cx).note_bars(),"Note bars did not toggle");
                anyhow::ensure!(!player.pitch_strip.read(cx).fitted(),"Fit did not toggle");
                click(window,cx,323.84375,718.); // Loop.
                click(window,cx,680.828125,770.); // Transpose +.
                click(window,cx,796.828125,770.); // Tempo +.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let player=view.read(cx);
                anyhow::ensure!(player.looping,"Loop did not toggle");
                anyhow::ensure!(player.transpose==1,"Transpose plus did not increment: {}",player.transpose);
                anyhow::ensure!((player.tempo-1.05).abs()<0.001,"Tempo plus did not increment: {}",player.tempo);
                click(window,cx,458.,180.); // Actual waveform one-third seek (64s).
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!((view.read(cx).position-64.).abs()<1.,"Waveform click did not seek near64s: {}",view.read(cx).position);
                for _ in 0..90 { window.simulate_next_frame(cx);window.refresh();let _=window.draw(cx); }
                anyhow::ensure!(!view.read(cx).lyric_scroll_active.get(),"Initial lyric follow did not settle");
                let before=view.read(cx).lyric_scroll.get();
                window.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                    position:point(px(1100.),px(450.)),delta:ScrollDelta::Pixels(point(px(0.),px(-50.))),
                    ..Default::default()
                }),cx);
                window.refresh();let _=window.draw(cx);
                let manual=view.read(cx).lyric_scroll.get();
                anyhow::ensure!(manual>before+1.,"Lyrics wheel did not move scroll offset: {before} -> {manual}");
                for _ in 0..16 { window.simulate_next_frame(cx);window.refresh();let _=window.draw(cx); }
                let retained=view.read(cx).lyric_scroll.get();
                anyhow::ensure!((retained-manual).abs()<0.1,"Manual lyrics scroll snapped back: {manual} -> {retained}");
                window.render_to_image()?.save(directory.join("lyrics-manual-scroll.png"))?;
                let (expected,point)={
                    let player=view.read(cx);
                    let hits=player.lyric_hits.borrow();
                    let (index,bounds)=hits.iter().find(|(index,bounds)| {
                        let center=f32::from(bounds.top()+bounds.size.height*0.5);
                        *index!=8 && center>200. && center<600.
                    }).ok_or_else(||anyhow::anyhow!("No visible lyric tap target after manual scroll"))?;
                    (*index as f32*8.,point(bounds.left()+bounds.size.width*0.5,bounds.top()+bounds.size.height*0.5))
                };
                click(window,cx,f32::from(point.x),f32::from(point.y));
                anyhow::ensure!((view.read(cx).position-expected).abs()<0.01,"Lyric tap did not seek its line: expected{expected},actual{}",view.read(cx).position);
                click(window,cx,828.,70.); // Source Zoom + control.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let _=window.draw(cx);
                window.render_to_image()?.save(directory.join("player-zoom.png"))?;
                let (start,end,pitch_view)={let player=view.read(cx);(player.view_start,player.view_end,player.pitch_strip.read(cx).view())};
                anyhow::ensure!((end-start-0.65).abs()<0.001,"Zoom+ did not set65% view span: {start}..{end}");
                anyhow::ensure!((pitch_view.0-start).abs()<0.001 && (pitch_view.1-end).abs()<0.001,"Pitch strip did not follow zoom: {pitch_view:?},waveform{start}..{end}");
                click(window,cx,568.,180.); // Halfway through the actual waveform viewport.
                let expected=(start+(end-start)*0.5)*192.;
                anyhow::ensure!((view.read(cx).position-expected).abs()<0.1,"Zoomed waveform seek did not use visible interval: expected{expected},actual{}",view.read(cx).position);
                click(window,cx,866.,70.); // Full view.
                click(window,cx,134.,70.); // Unmute all (not toggle all).
                click(window,cx,164.,70.); // Unsolo all.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let _=window.draw(cx);
                let player=view.read(cx);
                anyhow::ensure!(player.view_start==0. && player.view_end==1.,"Full did not restore whole-song view");
                anyhow::ensure!(player.pitch_strip.read(cx).view()==(0.,1.),"Pitch strip Full view did not reset");
                anyhow::ensure!(player.muted.iter().all(|v|!*v),"Unmute-all left a muted lane");
                anyhow::ensure!(player.solo.iter().all(|v|!*v),"Unsolo-all left a solo lane");
                click(window,cx,1215.,78.); // Guide vocals derives active state from vocals mute.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).muted[0],"Guide vocals did not toggle vocals mute");
                click(window,cx,1248.,26.); // SVG Settings gear.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Settings,"Gear did not open Settings modal");
                let _ = window.draw(cx);
                window.render_to_image()?.save(directory.join("settings.png"))?;
                click(window,cx,600.,168.); // Playback device selector.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                anyhow::ensure!(state.4==Some("settings-output"),"Output selector did not open");
                let _=window.draw(cx);
                window.render_to_image()?.save(directory.join("settings-selector.png"))?;
                click(window,cx,600.,230.); // Second popup option.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                anyhow::ensure!(state.0==1 && state.4.is_none(),"Output choice did not apply/close popup: {:?}",state);
                click(window,cx,325.,300.); // Native DSP checkbox.
                window.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                    position:point(px(800.),px(500.)),delta:ScrollDelta::Pixels(point(px(0.),px(-1400.))),
                    ..Default::default()
                }),cx);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                anyhow::ensure!(!state.1,"Native DSP checkbox did not toggle");
                anyhow::ensure!(state.3 < -10.,"Settings inner scroll did not advance: {}",state.3);
                let _=window.draw(cx);
                window.render_to_image()?.save(directory.join("settings-scrolled.png"))?;
                let bounds=view.read(cx).settings.read(cx).smoke_gain_bounds()
                    .ok_or_else(||anyhow::anyhow!("Monitor gain hit bounds not measured"))?;
                let x=f32::from(bounds.left()+bounds.size.width*0.25);
                let y=f32::from(bounds.top()+bounds.size.height*0.5);
                anyhow::ensure!((132. ..691.).contains(&y),"Gain slider not visible after scrolling: {bounds:?}");
                click(window,cx,x,y);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                anyhow::ensure!((state.2+45.).abs()<=1.,"Monitor gain slider did not set25%: {}",state.2);
                graph_bottom_offset.set(state.3);
                // This point lies inside the nested horizontal graph scroller.
                // Its vertical wheel must still move the outer Settings body.
                window.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                    position:point(px(800.),px(500.)),delta:ScrollDelta::Pixels(point(px(0.),px(-state.3))),
                    ..Default::default()
                }),cx);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                eprintln!("UI_SMOKE graph vertical-wheel snapshot: {state:?}");
                let _=window.draw(cx);
                window.render_to_image()?.save(directory.join("settings-graph-wheel-up.png"))?;
                anyhow::ensure!(state.3.abs()<1.,"Nested graph swallowed vertical wheel: {state:?}");
                window.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                    position:point(px(320.),px(400.)),delta:ScrollDelta::Pixels(point(px(0.),px(graph_bottom_offset.get()))),
                    ..Default::default()
                }),cx);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                anyhow::ensure!((state.3-graph_bottom_offset.get()).abs()<1.,"Settings did not return to its measured bottom offset: {state:?}");
                click(window,cx,220.,732.); // Close while scrolled; reopening must reset transient state.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Player,"Settings Close did not restore player");
                click(window,cx,1248.,26.); // Reopen Settings for keyboard dismissal.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Settings,"Gear did not reopen Settings");
                let state=view.read(cx).settings.read(cx).smoke_snapshot();
                eprintln!("UI_SMOKE settings reopened snapshot: {state:?}");
                let _=window.draw(cx);
                window.render_to_image()?.save(directory.join("settings-reopened.png"))?;
                anyhow::ensure!(state.3.abs()<1. && state.4.is_none(),"Settings reopening did not reset transient scroll/popup: {state:?}");
                anyhow::ensure!(state.0==1 && !state.1 && (state.2+45.).abs()<=1.,"Settings reopening lost local preferences: {state:?}");
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                click(window,cx,600.,168.);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).settings.read(cx).smoke_snapshot().4==Some("settings-output"),"Output selector did not reopen");
                escape(window,cx);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Settings,"First Escape closed Settings instead of its popup");
                anyhow::ensure!(view.read(cx).settings.read(cx).smoke_snapshot().4.is_none(),"First Escape did not close selector popup");
                escape(window,cx);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Player,"Second Escape did not restore player");
                click(window,cx,1248.,26.);
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Settings,"Gear did not reopen Settings for scrim test");
                click(window,cx,20.,400.); // Outside the full-viewport modal card.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Player,"Settings scrim did not restore player");
                click(window,cx,392.,26.); // Loaded-song Catalog control.
                Ok(())
            })??;
            cx.background_executor().timer(Duration::from_millis(30)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                anyhow::ensure!(view.read(cx).screen==Screen::Library,"Catalog control did not return to catalog");
                let _ = window.draw(cx);
                window.render_to_image()?.save(directory.join("catalog-loaded.png"))?;
                Ok(())
            })??;
            handle.update(cx, |_,window,cx| ui_text_phase::run_check(&view,window,cx))??;
            handle.update(cx, |_,window,cx| ui_grain::check(window,cx))??;
            Ok(())
        }.await;
        match result {
            Ok(()) => { eprintln!("UI_SMOKE passed: catalog/Browse/card, silentplay/pause, M/S/gain, NoteBars/Fit, loop/transpose/tempo, waveformseek/manuallyricswheel/tapseek/zoom/full/resetall/Guide, Settings selector/checkbox/scroll/nestedgraphwheel/range/Close/Escape/scrim, catalog return; hidden renderer captures saved"); let _ = cx.update(|cx| cx.quit()); }
            Err(error) => { eprintln!("UI_SMOKE failed: {error:#}"); std::process::exit(1); }
        }
    }).detach();
}

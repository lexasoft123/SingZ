//! Synthetic saved-lyrics fixtures with actual hidden native wheel dispatch.
//! These captures qualify scrolling behavior, not production visual parity or FPS.
use super::*;
use sha2::{Digest, Sha256};
use std::{path::{Path, PathBuf}, time::Duration};

fn hash(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn settle(w: &mut Window, cx: &mut App) {
    for _ in 0..100 { w.simulate_next_frame(cx); w.refresh(); let _ = w.draw(cx); }
}
fn fixture(p: &mut Player, text: &str, position: f64, cx: &mut Context<Player>) -> anyhow::Result<()> {
    // Saved text-only lines intentionally carry no words until the editor opens them
    // (project_lyrics tests), and the wrap/overflow layout is built from words: give
    // each line explicit evenly timed words so the fixture exercises real wrapping.
    let tokens: Vec<&str> = text.split_whitespace().collect();
    let lines: Vec<_> = (0..24).map(|i| {
        let (start, end) = (60.+i as f32*8., 66.+i as f32*8.);
        let step = (end - start) / tokens.len() as f32;
        let words: Vec<_> = tokens.iter().enumerate().map(|(j, w)| serde_json::json!({"w":w,"s":start+j as f32*step,"e":start+(j+1) as f32*step})).collect();
        serde_json::json!({"text":text,"start":start,"end":end,"words":words})
    }).collect();
    p.lyric_document = Arc::new(project_lyrics::from_value(&serde_json::json!({"source":"edited","credit":"Horizontal scrolling fixture","lines":lines}))?.ok_or_else(||anyhow::anyhow!("Empty fixture"))?);
    p.shape_cache.borrow_mut().clear();
    *p.layout_cache.borrow_mut() = None;
    p.playhead.seek(position);
    p.last = Instant::now();
    cx.notify();
    Ok(())
}
fn wheel(view: &Entity<Player>, w: &mut Window, cx: &mut App, x: f32, y: f32, shift: bool) {
    let position = view.read(cx).lyric_scroll_handle.bounds().center();
    w.dispatch_event(PlatformInput::Scroll(ScrollEvent {
        position, delta: ScrollDelta::Pixels(point(px(x), px(y))),
        modifiers: Modifiers { shift, ..Default::default() }, ..Default::default()
    }), cx);
    settle(w,cx);
}
fn drag_horizontal_thumb(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    let handle=&view.read(cx).lyric_scroll_handle;
    let b=handle.bounds();
    let width=f32::from(b.size.width);
    let maximum=f32::from(handle.max_offset().x);
    anyhow::ensure!(maximum>0. && handle.offset().x==px(0.),"Thumb drag requires left edge and real native overflow");
    // Input coordinates derived independently from the native client/extent.
    // The wrapper's ten-pixel horizontal gutter starts at client.bottom().
    let thumb_width=width*width/(width+maximum);
    let start=point(b.left()+px(thumb_width/2.),b.bottom()+px(5.));
    let end=point(b.right()-px(thumb_width/2.),b.bottom()+px(5.));
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:start,pressed_button:None,modifiers:Default::default()}),cx);
    settle(w,cx);
    w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:start,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    settle(w,cx);
    w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:end,pressed_button:Some(MouseButton::Left),modifiers:Default::default()}),cx);
    settle(w,cx);
    w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:end,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
    settle(w,cx);
    anyhow::ensure!((f32::from(view.read(cx).lyric_scroll_handle.offset().x)+maximum).abs()<1.,"Native horizontal thumb drag did not reach right edge");
    Ok(())
}
fn capture(view: &Entity<Player>, w: &mut Window, cx: &mut App, out: &Path, id: &str, steps: &[&str]) -> anyhow::Result<serde_json::Value> {
    settle(w,cx);
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Test window became visible/active");
    let image = w.render_to_image()?;
    let viewport = w.viewport_size();
    let scale = w.scale_factor();
    anyhow::ensure!(image.width()==(f32::from(viewport.width)*scale).round() as u32 && image.height()==(f32::from(viewport.height)*scale).round() as u32,"Raster size mismatch");
    let file = out.join(format!("{id}.png")); image.save(&file)?;
    let p=view.read(cx); let g=p.lyric_scroll_geometry.get(); let b=p.lyric_scroll_handle.bounds();
    let offset=p.lyric_scroll_handle.offset(); let max=p.lyric_scroll_handle.max_offset();
    let layout=p.layout_cache.borrow();
    let rows=layout.as_ref().map(|(_,lines)|lines.iter().map(|(top,height,words)|serde_json::json!({"top":top,"height":height,"words":words.iter().map(|(text,x,row,width)|serde_json::json!({"text":text,"x":x,"row":row,"width":width})).collect::<Vec<_>>()})).collect::<Vec<_>>());
    let value=serde_json::json!({"id":id,"steps":steps,"viewport":[f32::from(viewport.width),f32::from(viewport.height)],"deviceScale":scale,"raster":[image.width(),image.height()],"png":file.file_name().unwrap().to_string_lossy(),"pngSha256":hash(&std::fs::read(file)?),"scrollBounds":[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)],"geometry":{"viewportWidth":g.viewport_width,"contentWidth":g.content_width,"maxOffset":g.max_offset(),"overflows":g.overflows()},"offset":[f32::from(offset.x),f32::from(offset.y)],"nativeMaxOffset":[f32::from(max.x),f32::from(max.y)],"horizontalGutter":p.lyric_horizontal.get(),"manualVerticalPosition":p.lyric_scroll.get(),"position":p.playhead.position(),"lineCount":p.lyric_document.lines.len(),"activeScale":if p.playhead.position()+0.15>=p.lyric_document.lines[0].start as f64{1.03}else{1.},"rows":rows,"hidden":!w.is_visible(),"active":w.is_window_active(),"scope":"synthetic fixture; actual app-local wheel and native ScrollHandle; candidate-only captures; live FPS unmeasured"});
    std::fs::write(out.join(format!("{id}.json")),serde_json::to_vec_pretty(&value)?)?;
    Ok(value)
}
fn fitting(p: &Player) -> anyhow::Result<()> {
    anyhow::ensure!(!p.lyric_horizontal.get() && !p.lyric_scroll_geometry.get().overflows(),"Fitting future lyrics have phantom gutter");
    anyhow::ensure!(f32::from(p.lyric_scroll_handle.offset().x).abs()<0.1 && f32::from(p.lyric_scroll_handle.max_offset().x).abs()<0.5,"Fitting lyrics retained horizontal range/offset");
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result:anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            // Allow the independent observer's explicitly excluded startup warmup.
            cx.background_executor().timer(Duration::from_secs(3)).await;
            let mut cases=Vec::new();
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,cx| {
                    w.resize(size(px(width),px(height)));
                    view.update(cx,|p,cx| {
                        p.screen=Screen::Player; p.loaded_song=true; p.playing=false; p.karaoke=true;
                        p.notice=None; p.started=Instant::now()-Duration::from_secs(2);
                        p.header.update(cx,|h,cx|h.set_review_fixture(true,cx));
                        p.lyric_scroll.set(0.);p.lyric_scroll_target.set(0.);p.lyric_active.set(0);
                        p.lyric_scroll_handle.set_offset(point(px(0.),px(0.)));
                        fixture(p,"A short future line",0.,cx)
                    })
                })??;
                cx.background_executor().timer(Duration::from_millis(150)).await;
                let mut batch=handle.update(cx,|_,w,cx|->anyhow::Result<Vec<serde_json::Value>> {
                    let mut records=Vec::new();
                    macro_rules! shot {($name:expr,$steps:expr)=>{records.push(capture(&view,w,cx,&out,&format!("{}-{}",width as i32,$name),$steps)?);};}
                    settle(w,cx); fitting(view.read(cx))?;
                    shot!("short-future", &["Install 24 future short lines; position 0; settle native layout"]);
                    view.update(cx,|p,cx|{p.playhead.seek(61.);cx.notify();});settle(w,cx);
                    let g=view.read(cx).lyric_scroll_geometry.get();
                    anyhow::ensure!((g.max_offset()-10.11).abs()<2.,"Canonical active paragraph scale overflow changed: {g:?}");
                    shot!("active-paragraph", &["Advance position into first paragraph; preserve canonical 1.03 scale"]);
                    view.update(cx,|p,cx|fixture(p,"These ordinary words wrap across several rows within the actual lyrics viewport without creating horizontal overflow",0.,cx))?;
                    settle(w,cx);fitting(view.read(cx))?;
                    {let cache=view.read(cx).layout_cache.borrow();let words=&cache.as_ref().unwrap().1[0].2;
                        let available=view.read(cx).lyric_scroll_geometry.get().viewport_width-40.;
                        anyhow::ensure!(words.iter().any(|(_,_,row,_)|*row>0.),"Multiword fixture did not wrap");
                        anyhow::ensure!(words.iter().all(|(_,x,_,width)|x+width<=available+0.5),"Wrapped words leave viewport");}
                    shot!("wrapped-future", &["Replace fixture with 24 multiword future lines; verify measured row widths"]);
                    let token=format!("{}ENDING","W".repeat(90));
                    view.update(cx,|p,cx|fixture(p,&token,0.,cx))?;settle(w,cx);
                    let g=view.read(cx).lyric_scroll_geometry.get();
                    anyhow::ensure!(g.max_offset()>100. && view.read(cx).lyric_horizontal.get(),"Oversized token failed to produce range: {g:?}");
                    {let cache=view.read(cx).layout_cache.borrow();let first=&cache.as_ref().unwrap().1[0];
                        anyhow::ensure!(first.2.len()==1 && first.2[0].1==0. && first.2[0].2==0. && (first.1-(25.375+14.)).abs()<0.1,"Oversized first token got a phantom wrap row");}
                    anyhow::ensure!((f32::from(view.read(cx).lyric_scroll_handle.max_offset().x)-g.max_offset()).abs()<1.,"Native horizontal maximum differs from shaped extent");
                    shot!("oversized-left", &["Replace with 24 oversized single tokens; verify first token stays on row zero"]);
                    drag_horizontal_thumb(&view,w,cx)?;
                    shot!("horizontal-thumb-drag", &["Derive actual thumb center from native viewport and maximum extent", "Dispatch app-local MouseDown, held MouseMove to track end, MouseUp", "Assert native thumb drag reaches actual rightmost offset"]);
                    wheel(&view,w,cx,100000.,0.,false);
                    anyhow::ensure!(view.read(cx).lyric_scroll_handle.offset().x==px(0.),"Wheel failed to reset left after thumb drag");
                    wheel(&view,w,cx,-75.,0.,false);
                    anyhow::ensure!((f32::from(view.read(cx).lyric_scroll_handle.offset().x)+75.).abs()<0.5,"Native horizontal wheel delta was not applied exactly once");
                    shot!("horizontal-wheel", &["Dispatch app-local horizontal native wheel delta -75"]);
                    wheel(&view,w,cx,100000.,0.,false);
                    anyhow::ensure!(view.read(cx).lyric_scroll_handle.offset().x==px(0.),"Horizontal wheel did not return to left edge");
                    wheel(&view,w,cx,0.,-90.,true);
                    anyhow::ensure!((f32::from(view.read(cx).lyric_scroll_handle.offset().x)+90.).abs()<0.5,"Shift-wheel delta was not applied exactly once");
                    shot!("shift-wheel", &["Return to left with horizontal wheel; dispatch shift plus vertical wheel delta -90"]);
                    wheel(&view,w,cx,0.,-100000.,true);
                    let p=view.read(cx);let g=p.lyric_scroll_geometry.get();
                    anyhow::ensure!((f32::from(p.lyric_scroll_handle.offset().x)+g.max_offset()).abs()<1.,"Wheel failed to reach shaped rightmost ending");
                    shot!("oversized-right", &["Dispatch large shift-wheel; assert rightmost native offset equals actual content extent"]);
                    // Deliberately retain the scroll handle: renderer must clamp stale x itself.
                    view.update(cx,|p,cx|fixture(p,"A fitting replacement",0.,cx))?;settle(w,cx);fitting(view.read(cx))?;
                    shot!("replacement-reset", &["Replace oversized fixture without resetting any scroll control; renderer removes gutter and stale x"]);
                    wheel(&view,w,cx,0.,-140.,false);
                    let y=view.read(cx).lyric_scroll_handle.offset().y;
                    anyhow::ensure!(y<px(-100.),"Ordinary vertical wheel failed");
                    settle(w,cx);
                    anyhow::ensure!((f32::from(view.read(cx).lyric_scroll_handle.offset().y-y)).abs()<0.5,"Manual vertical position was lost during idle redraw");
                    fitting(view.read(cx))?;
                    shot!("vertical-retained", &["Dispatch ordinary vertical wheel -140; redraw without input; assert native manual position retained"]);
                    Ok(records)
                })??;
                cases.append(&mut batch);
                cx.background_executor().timer(Duration::from_secs(2)).await;
            }
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"passed":true,"cases":cases,"binarySha256":hash(&std::fs::read(std::env::current_exe()?)?),"journeySourceSha256":hash(include_bytes!("ui_lyrics_scroll.rs")),"geometrySourceSha256":hash(include_bytes!("lyric_scroll_geometry.rs")),"mainSourceSha256":hash(include_bytes!("main.rs")),"scope":"synthetic saved-lyrics fixture; actual native app-local input and scroll state; no production visual parity or live FPS claim","liveFps":null}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(e)=>{eprintln!("LYRICS_SCROLL_TEST failed: {e:#}");std::process::exit(1);}}
    }).detach();
}

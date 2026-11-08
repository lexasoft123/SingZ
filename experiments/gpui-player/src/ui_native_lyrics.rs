//! Saved lyrics through the actual native session, stepped while paused.
use super::*;
use std::{path::PathBuf, time::Duration};
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async{
            std::fs::create_dir_all(&out)?;
            // Initial macOS window bounds can settle one logical pixel taller.
            // Establish the content viewport explicitly before loading/shaping.
            handle.update(cx,|_,window,_|window.resize(size(px(1280.),px(800.))))?;
            let path=std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing test project"))?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(path.into(),cx)))?;
            let deadline=Instant::now()+Duration::from_secs(40);
            loop{
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let loaded=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(!p.loading&&p.project.is_some())})??;
                if loaded{break;}anyhow::ensure!(Instant::now()<deadline,"Lyrics load timed out");
            }
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.karaoke&&!p.lyric_document.lines.is_empty(),"Saved lyrics not connected");anyhow::ensure!(!p.lyric_document.masks.is_empty(),"Native glyph glow masks missing");anyhow::ensure!(p.project.as_ref().unwrap().pitch.range()==Some((45,48)),"Saved pitch notes are not bound to this project");anyhow::ensure!(p.project.as_ref().unwrap().pitch.key=="C"&&p.project.as_ref().unwrap().pitch.tempo=="96","Saved key/tempo missing");anyhow::ensure!(p.project.as_ref().unwrap().lyrics_error.is_none(),"{:?}",p.project.as_ref().unwrap().lyrics_error);Ok(())})??;
            cx.background_executor().timer(Duration::from_millis(1000)).await;
            let first=handle.update(cx,|_,_,cx|view.read(cx).lyric_document.lines[0].words[0].clone())?;
            let start=(first.start-0.15).max(0.) as f64;
            let span=((first.end-first.start) as f64).min(0.5);
            let count=(span*120.).ceil() as usize;
            let mut hashes=vec![];
            for index in 0..=count{
                let position=(start+index as f64/120.) as f32;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.position=position;p.seek_native(cx);}))?;
                let deadline=Instant::now()+Duration::from_secs(3);
                loop{
                    cx.background_executor().timer(Duration::from_millis(10)).await;
                    if handle.update(cx,|_,_,cx|view.read(cx).pending_seek.is_none()&&view.read(cx).native_anchor.is_some_and(|(p,_)|(p-position).abs()<0.0001))?{break;}
                    anyhow::ensure!(Instant::now()<deadline,"Native seek receipt timed out at {position}");
                }
                let (bytes,glow)=handle.update(cx,|_,window,cx|->anyhow::Result<_>{
                    view.read(cx).frame_stats.borrow_mut().advancing_glow_draws=0;
                    for _ in 0..90{window.simulate_next_frame(cx);window.refresh();let _=window.draw(cx);if !view.read(cx).lyric_scroll_active.get(){break;}}
                    let image=window.render_to_image()?;
                    let scale=window.scale_factor();
                    anyhow::ensure!(window.viewport_size()==size(px(1280.),px(800.))&&image.width()==(1280.*scale) as u32&&image.height()==(800.*scale) as u32,"Lyrics capture viewport does not match the 1280×800 contract");
                    let dpr=window.scale_factor();let x=((f32::from(window.viewport_size().width)-360.)*dpr) as u32;
                    let crop=image::imageops::crop_imm(&image,x,(164.*dpr) as u32,(350.*dpr) as u32,(140.*dpr) as u32).to_image();
                    let bytes=crop.as_raw().to_vec();image.save(out.join(format!("frame-{index:03}.png")))?;
                    Ok((bytes,view.read(cx).frame_stats.borrow().advancing_glow_draws))
                })??;
                use sha2::{Digest,Sha256};let hash=Sha256::digest(&bytes).iter().map(|b|format!("{b:02x}")).collect::<String>();
                hashes.push(serde_json::json!({"position":position,"sha256":hash,"advancingGlowDraws":glow}));
                if index>2 && index<count-2{anyhow::ensure!(glow>0,"Advancing glow missing inside native word");}
            }
            anyhow::ensure!(hashes.windows(2).any(|w|w[0]["sha256"]!=w[1]["sha256"]),"Native word paint did not advance");
            std::fs::write(out.join("frames.json"),serde_json::to_vec_pretty(&hashes)?)?;
            // Exercise the actual lyrics tap target, then inspect native telemetry.
            let target=handle.update(cx,|_,window,cx|->anyhow::Result<f32>{
                let p=view.read(cx);let (index,bounds)=p.lyric_hits.borrow().iter().find(|(i,b)|*i==1 && b.top()>=px(160.)).copied().ok_or_else(||anyhow::anyhow!("Second lyric tap target missing"))?;
                let target=p.lyric_document.start(index);let position=bounds.center();
                window.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                Ok(target)
            })??;
            cx.background_executor().timer(Duration::from_millis(150)).await;
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!((view.read(cx).position-target).abs()<0.001,"Lyric tap failed to seek native transport");Ok(())})??;
            Ok(())
        }.await;
        match result{Ok(())=>{eprintln!("NATIVE_LYRICS passed: saved text/timing, native masks, 120Hz partial-glyph sweep samples, advancing glow, lyric-tap seek");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("NATIVE_LYRICS failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();});std::process::exit(1);}}
    }).detach();
}

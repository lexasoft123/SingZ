//! Real hidden GPUI Test C4 -> Rust worker -> native shared audio lifecycle.
use super::*;
use std::{path::PathBuf, time::Duration};
fn draw(window: &mut Window, cx: &mut App) {
    for _ in 0..3 {
        window.simulate_next_frame(cx);
        window.refresh();
        let _ = window.draw(cx);
    }
}
fn click(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
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
fn test_button(view: &Entity<Player>, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    window.dispatch_event(
        PlatformInput::Scroll(ScrollEvent {
            position: point(px(1000.), px(500.)),
            delta: ScrollDelta::Pixels(point(px(0.), px(-2500.))),
            ..Default::default()
        }),
        cx,
    );
    draw(window, cx);
    let bounds = view
        .read(cx)
        .training
        .read(cx)
        .bounds("training-test")
        .ok_or_else(|| anyhow::anyhow!("Missing Test C4 hit target"))?;
    anyhow::ensure!(
        bounds.top() > px(52.) && bounds.bottom() < window.viewport_size().height,
        "Test C4 outside viewport: {bounds:?}"
    );
    click(window, cx, bounds.center());
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).backend.is_some() && view.read(cx).project.is_none(),"Expected native library with no song");draw(window,cx);click(window,cx,point(px(295.),px(26.)));Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(80)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let bounds=view.read(cx).training.read(cx).bounds("training-exercise-0").ok_or_else(||anyhow::anyhow!("Missing note exercise"))?;click(window,cx,bounds.center());Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(40)).await;
  handle.update(cx,|_,window,cx|test_button(&view,window,cx))??;
  let deadline=Instant::now()+Duration::from_secs(10);
  let first=loop{
   cx.background_executor().timer(Duration::from_millis(15)).await;
   let ready=handle.update(cx,|_,_,cx|->anyhow::Result<Option<u64>>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.training_test.filter(|g|p.training_last.as_ref().is_some_and(|s|s.generation==*g&&s.active)))})??;
   if let Some(generation)=ready{break generation;}anyhow::ensure!(Instant::now()<deadline,"No-project Test C4 did not reach native audio");
  };
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let p=view.read(cx);let status=p.training_last.as_ref().unwrap();anyhow::ensure!(status.end_host_ns-status.start_host_ns==2_750_000_000 && status.notes.len()==1 && status.notes[0].midi==60 && status.notes[0].end==2.75,"Source Test C4 timing changed");anyhow::ensure!(p.project.is_none() && p.mic_intent.is_none() && p.training.read(cx).testing,"Test opened a song/capture or busy label missing");draw(window,cx);window.render_to_image()?.save(out.join("test-c4-playing-1280.png"))?;Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(6);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).training_stopped>=first && view.read(cx).training_test.is_none())?{break;}anyhow::ensure!(Instant::now()<deadline,"Audible completion did not clear Test/reap training-only helper");}
  handle.update(cx,|_,window,_|window.resize(size(px(1060.),px(640.))))?;
  cx.background_executor().timer(Duration::from_millis(60)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(window.viewport_size()==size(px(1060.),px(640.)),"Small viewport resize did not settle");test_button(&view,window,cx)})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(15)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.training_test.is_some_and(|g|p.training_last.as_ref().is_some_and(|s|s.generation==g&&s.active))})?{break;}anyhow::ensure!(Instant::now()<deadline,"Small viewport Test C4 did not start");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let image=window.render_to_image()?;anyhow::ensure!(image.width()==(1060.*window.scale_factor()) as u32 && view.read(cx).training.read(cx).testing,"Small playing capture contract mismatch");image.save(out.join("test-c4-playing-1060.png"))?;click(window,cx,point(px(203.),px(26.)));Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Library&&p.training_test.is_none()&&p.training_stopped>=p.training_serial})?{break;}anyhow::ensure!(Instant::now()<deadline,"Leaving Training did not cancel pending cue");}
  handle.update(cx,|_,window,cx|click(window,cx,point(px(295.),px(26.))))?;
  cx.background_executor().timer(Duration::from_millis(40)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{test_button(&view,window,cx)?;click(window,cx,point(px(203.),px(26.)));Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Library&&p.training_test.is_none()&&p.training_stopped>=p.training_serial})?{break;}anyhow::ensure!(Instant::now()<deadline,"Leaving during pending Test failed");}
  // A fresh no-project Test can be replaced by loading an actual song.
  handle.update(cx,|_,window,cx|{window.resize(size(px(1280.),px(800.)));draw(window,cx);click(window,cx,point(px(295.),px(26.)));})?;
  cx.background_executor().timer(Duration::from_millis(40)).await;
  handle.update(cx,|_,window,cx|test_button(&view,window,cx))??;
  let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing loaded-song fixture"))?);
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project,cx)))?;
  let deadline=Instant::now()+Duration::from_secs(30);
  loop{cx.background_executor().timer(Duration::from_millis(25)).await;let ready=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none(),"{:?}",p.notice);Ok(p.project.is_some()&&!p.loading)})??;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Loading song after training timed out");}
  handle.update(cx,|_,window,cx|{draw(window,cx);click(window,cx,point(px(96.),px(718.)));})?;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|view.read(cx).playing)?{break;}anyhow::ensure!(Instant::now()<deadline,"Play before training failed");}
  handle.update(cx,|_,window,cx|click(window,cx,point(px(295.),px(26.))))?;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|!view.read(cx).playing)?{break;}anyhow::ensure!(Instant::now()<deadline,"Entering Training did not pause the song");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let b=view.read(cx).training.read(cx).bounds("training-exercise-0").ok_or_else(||anyhow::anyhow!("Loaded song did not reset Training home"))?;click(window,cx,b.center());Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(60)).await;
  handle.update(cx,|_,window,cx|test_button(&view,window,cx))??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.training_test.is_some_and(|g|p.training_last.as_ref().is_some_and(|s|s.generation==g&&s.active))})?{break;}anyhow::ensure!(Instant::now()<deadline,"Loaded-song Test C4 did not start");}
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);window.render_to_image()?.save(out.join("loaded-song-test-c4.png"))?;click(window,cx,point(px(203.),px(26.)));Ok(())})??;
  let deadline=Instant::now()+Duration::from_secs(5);
  loop{cx.background_executor().timer(Duration::from_millis(20)).await;if handle.update(cx,|_,_,cx|{let p=view.read(cx);p.screen==Screen::Player&&p.training_test.is_none()&&p.training_stopped>=p.training_serial&&!p.playing})?{break;}anyhow::ensure!(Instant::now()<deadline,"Leaving Training failed to cancel or resumed song");}
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"nativeNoProjectTest":true,"sourceC4Duration":2.75,"busyState":true,"completionAndReap":true,"leaveDuringPending":true,"projectReplacement":true,"loadedSongPaused":true,"captureNotOpened":true,"audibleQualified":false}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("TRAINING_AUDIO_UI passed: no-project Test C4, busy/completion, leave/cancel/reap, project replacement, paused song");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_AUDIO_UI failed: {error:#}");let _=view.update(cx,|p,_|{p.backend.take();});std::process::exit(1);}}
 }).detach();
}

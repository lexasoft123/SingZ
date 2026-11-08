//! Hidden source-backed training route captures and native control interaction checks.
use super::*;
use std::{path::PathBuf, time::Duration};
fn draw(window: &mut Window, cx: &mut App) {
    for _ in 0..3 {
        window.simulate_next_frame(cx);
        window.refresh();
        let _ = window.draw(cx);
    }
}
fn click(window: &mut Window, cx: &mut App, p: Point<Pixels>) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: p,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position: p,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position: p,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;
  handle.update(cx,|_,window,cx|{draw(window,cx);click(window,cx,point(px(295.),px(26.)));})?;
  cx.background_executor().timer(Duration::from_millis(40)).await;
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Training,"Header did not navigate to Training");Ok(())})??;
  for(width,height)in[(1280.,800.),(1060.,640.)]{
   handle.update(cx,|_,window,_|window.resize(size(px(width),px(height))))?;
   cx.background_executor().timer(Duration::from_millis(40)).await;
   for(name,route)in[("training-home",training::Route::Home),("training-note-setup",training::Route::Setup),("training-progress-empty",training::Route::Progress)]{
    handle.update(cx,|_,window,cx|->anyhow::Result<()>{view.update(cx,|p,cx|{p.screen=Screen::Training;p.loaded_song=false;p.header.update(cx,|h,cx|h.set_review_fixture(true,cx));p.training.update(cx,|s,cx|s.review(route,cx));cx.notify();});if route==training::Route::Home { window.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:point(px(-10.),px(-10.)),pressed_button:None,modifiers:Modifiers::default()}),cx); }draw(window,cx);if route==training::Route::Setup {let bounds=view.read(cx).training.read(cx).bounds("training-footer").ok_or_else(||anyhow::anyhow!("Missing sticky footer bounds"))?;anyhow::ensure!((f32::from(bounds.bottom())-(height-42.)).abs()<1.,"Setup actions escaped the viewport: {bounds:?}");}let image=window.render_to_image()?;image.save(out.join(format!("{name}-{}-candidate.png",width as u32)))?;std::fs::write(out.join(format!("{name}-{}-candidate.json",width as u32)),serde_json::to_vec_pretty(&serde_json::json!({"viewport":[width,height],"deviceScale":window.scale_factor(),"imagePixels":[image.width(),image.height()],"capture":"hidden GPUI render_to_image","trainingRoute":format!("{route:?}"),"exercise":"note","audioBlocked":true,"hoverState":if route==training::Route::Home {"none: app-local pointer outside"} else {"existing interaction state"},"progressSessions":0,"locale":"en","zoom":1}))?)?;Ok(())})??;
   }
  }
  handle.update(cx,|_,window,cx|{window.resize(size(px(1280.),px(800.)));view.read(cx).training.clone().update(cx,|s,cx|s.review(training::Route::Home,cx));draw(window,cx);})?;
  for index in 0..7 {
   handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let bounds=view.read(cx).training.read(cx).bounds(&format!("training-exercise-{index}")).ok_or_else(||anyhow::anyhow!("Exercise hit target missing"))?;
    if bounds.center().y>px(790.){window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(1000.),px(650.)),delta:ScrollDelta::Pixels(point(px(0.),px(-1200.))),..Default::default()}),cx);draw(window,cx);}
    let bounds=view.read(cx).training.read(cx).bounds(&format!("training-exercise-{index}")).unwrap();click(window,cx,bounds.center());Ok(())})??;
   cx.background_executor().timer(Duration::from_millis(30)).await;
   handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).training.read(cx).snapshot().0==training::Route::Setup,"Exercise {index} did not open setup");draw(window,cx);window.render_to_image()?.save(out.join(format!("exercise-{index}-setup.png")))?;
    if index==0 {
      window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(1000.),px(650.)),delta:ScrollDelta::Pixels(point(px(0.),px(-2000.))),..Default::default()}),cx);draw(window,cx);
      let footer=view.read(cx).training.read(cx).bounds("training-footer").unwrap();anyhow::ensure!((f32::from(footer.bottom())-758.).abs()<0.5,"Setup actions moved with form scrolling: {footer:?}");window.render_to_image()?.save(out.join("training-setup-scrolled.png"))?;
      window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position:point(px(1000.),px(650.)),delta:ScrollDelta::Pixels(point(px(0.),px(2000.))),..Default::default()}),cx);draw(window,cx);
    }

    let bounds=view.read(cx).training.read(cx).bounds("training-back").unwrap();click(window,cx,bounds.center());Ok(())})??;
   cx.background_executor().timer(Duration::from_millis(30)).await;
  }
  for(level,count)in[(0,7),(1,6),(2,6)] {
   handle.update(cx,|_,window,cx|->anyhow::Result<()>{draw(window,cx);let b=view.read(cx).training.read(cx).bounds(&format!("training-level-{level}")).unwrap();click(window,cx,b.center());Ok(())})??;
   cx.background_executor().timer(Duration::from_millis(30)).await;
   handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).training.read(cx).program_snapshot()==(Some(level),count),"Program curriculum does not match its level");draw(window,cx);window.render_to_image()?.save(out.join(format!("program-level-{level}.png")))?;Ok(())})??;
  }
  handle.update(cx,|_,window,cx|{view.read(cx).training.clone().update(cx,|s,cx|s.review(training::Route::Setup,cx));draw(window,cx);})?;
  for(id,index)in[("training-key",2),("training-mode",1)] {
   let bounds=handle.update(cx,|_,window,cx|{draw(window,cx);let b=view.read(cx).training.read(cx).bounds(id).unwrap();click(window,cx,b.center());b})?;
   cx.background_executor().timer(Duration::from_millis(30)).await;
   handle.update(cx,|_,window,cx|{draw(window,cx);click(window,cx,point(bounds.center().x,bounds.bottom()+px(2.+5.+27.5*index as f32+13.75)));})?;
   cx.background_executor().timer(Duration::from_millis(30)).await;
  }
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let state=view.read(cx).training.read(cx).snapshot();anyhow::ensure!(state.2==2&&state.3,"Key/mode selector did not apply: {state:?}");draw(window,cx);let b=view.read(cx).training.read(cx).bounds("training-task-1").unwrap();click(window,cx,b.center());Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).training.read(cx).snapshot().6==1,"Task selection did not apply");draw(window,cx);let b=view.read(cx).training.read(cx).bounds("training-low").unwrap();click(window,cx,point(b.left()+b.size.width*0.25,b.center().y));Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  handle.update(cx,|_,window,cx|->anyhow::Result<()>{let state=view.read(cx).training.read(cx).snapshot();anyhow::ensure!(state.4>=36.&&state.4<48.&&state.4<state.5,"Range slider bounds or value are incorrect: {state:?}");draw(window,cx);let b=view.read(cx).training.read(cx).bounds("training-key").unwrap();click(window,cx,b.center());Ok(())})??;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  handle.update(cx,|_,window,cx|{draw(window,cx);window.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("escape").unwrap(),is_held:false,prefer_character_input:false}),cx);})?;
  cx.background_executor().timer(Duration::from_millis(30)).await;
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).screen==Screen::Training&&!view.read(cx).training.read(cx).popup_open(),"Escape did not dismiss popup before leaving Training");Ok(())})??;
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"headerNavigation":true,"allSevenExerciseSetupRoutes":true,"captures":6,"programLevels":true,"keyAndModeSelectors":true,"taskChoice":true,"rangeControl":true,"popupFirstEscape":true,"nativeAudioIntegrated":false,"strictParityQualified":false}))?)?;Ok(())
 }.await;
 match result{Ok(())=>{eprintln!("TRAINING_UI passed: header navigation, 7 setup routes, back, 6 source-backed captures; native training audio pending");let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("TRAINING_UI failed: {error:#}");std::process::exit(1);}}
}).detach();
}

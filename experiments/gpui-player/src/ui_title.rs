//! Hidden title edit, native rename, conflicts, and unsaved source lifecycle.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::PathBuf, time::Duration};
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
fn key_with_up(w:&mut Window,cx:&mut App,value:&'static str) {
    let stroke=Keystroke::parse(value).unwrap();
    w.dispatch_keystroke(stroke.clone(),cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
}
fn open_pencil_by_keyboard(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    for _ in 0..192 {
        draw(w,cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref()==Some("header-rename") {
            let b=view.read(cx).header.read(cx).rename_bounds.get()
                .ok_or_else(||anyhow::anyhow!("Keyboard pencil is not measured"))?;
            anyhow::ensure!(b.size.width>px(0.)&&b.size.height>px(0.)&&b.top()>=px(0.)&&b.bottom()<=px(52.)
                &&b.left()>=px(0.)&&b.right()<=w.viewport_size().width,"Keyboard pencil is outside header: {b:?}");
            key_with_up(w,cx,"enter");return Ok(());
        }
        key_with_up(w,cx,"tab");
    }
    anyhow::bail!("Actual Tab could not reach header rename pencil")
}
fn edit(view: &Entity<Player>, w: &mut Window, cx: &mut App, value: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let header = view.read(cx).header.clone();
    let b = header
        .read(cx)
        .rename_bounds
        .get()
        .ok_or_else(|| anyhow::anyhow!("Pencil not laid out"))?;
    anyhow::ensure!(b.size.width > px(0.), "Pencil has no hit area");
    click(w, cx, b.center());
    draw(w, cx);
    anyhow::ensure!(
        header.read(cx).is_editing(),
        "Pencil did not open title editor"
    );
    let state = header.read(cx).title_state();
    state.update(cx, |s, cx| s.set_value(value, w, cx));
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async{
  std::fs::create_dir_all(&out)?;let initial=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap()).canonicalize()?;let source=PathBuf::from(std::env::var_os("SINGZ_GPUI_SOURCE_FILE").unwrap());
  macro_rules! wait {($predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(25)).await;if handle.update(cx,|_,_,cx|($predicate)(view.read(cx)))?{break;}anyhow::ensure!(Instant::now()<deadline,"Title state timed out: {}",stringify!($predicate));}}};}
  macro_rules! capture {($name:expr)=>{{cx.background_executor().timer(Duration::from_millis(1200)).await;handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);w.render_to_image()?.save(out.join($name))?;Ok(())})??;}};}
  handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));view.update(cx,|p,cx|p.open_project(initial.clone(),cx));})?;
  wait!(|p:&Player|!p.loading&&p.project.is_some());
  handle.update(cx,|_,w,cx|open_pencil_by_keyboard(&view,w,cx))??;
  let editing_deadline=Instant::now()+Duration::from_secs(8);
  loop {
   cx.background_executor().timer(Duration::from_millis(20)).await;
   if handle.update(cx,|_,w,cx|{draw(w,cx);let header=view.read(cx).header.read(cx);header.is_editing()&&header.title_input_focused(w,cx)})? {break;}
   anyhow::ensure!(Instant::now()<editing_deadline,"Pencil Enter down/up did not leave the actual title input editing and focused");
  }
  handle.update(cx,|_,w,cx|{let state=view.read(cx).header.read(cx).title_state();state.update(cx,|s,cx|s.set_value("Cancelled title",w,cx));})?;
  capture!("editing-1280.png");
  handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(!p.header.read(cx).is_editing()&&p.song_title.as_str()=="Original"&&!p.saving&&p.rename_pending.is_none(),"Escape renamed or saved");Ok(())})??;
  handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,"space");})?;wait!(|p:&Player|p.playing);
  handle.update(cx,|_,w,cx|key(w,cx,"space"))?;wait!(|p:&Player|!p.playing);
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"   ")?;key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
  cx.background_executor().timer(Duration::from_millis(100)).await;
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).song_title.as_str()=="Original","Blank title changed song");Ok(())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.gain[5]=42;p.sync_lane(5,cx);p.native_transport(transport::TransportEvent::Volume(0.6),cx);p.playhead.seek(0.75);p.seek_native(cx);}))?;
  wait!(|p:&Player|p.playhead.pending_seek().is_none()&&p.playhead.anchor().is_some_and(|(position,_)|(position-0.75).abs()<0.001));
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"  Ż renamed / song.wav  ")?;key(w,cx,"enter");view.update(cx,|p,cx|{p.screen=Screen::Library;p.library.update(cx,|l,cx|l.focus_search(w,cx));});Ok::<_,anyhow::Error>(())})??;
  wait!(|p:&Player|!p.loading&&p.rename_pending.is_none()&&p.song_title.as_str()=="Ż renamed song");
  wait!(|p:&Player|p.playhead.pending_seek().is_none()&&p.playhead.anchor().is_some_and(|(position,_)|(position-0.75).abs()<0.001));
  let renamed=handle.update(cx,|_,_,cx|->anyhow::Result<PathBuf>{let p=view.read(cx);let dir=p.project.as_ref().unwrap().dir.clone();anyhow::ensure!(p.notice.is_none()&&dir.parent()==initial.parent()&&!initial.exists()&&p.gain[5]==42&&p.master_volume==0.6&&p.edit_seq!=p.saved_seq&&(p.playhead.position()-0.75).abs()<0.001,"Rename lost identity/mix/position: {:?} {}",p.notice,p.playhead.position());Ok(dir)})??;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Library&&p.library.read(cx).search_focused(w,cx),"Rename changed route or stole search focus");Ok(())})??;
  capture!("rename-kept-library-1280.png");
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.screen=Screen::Player;p.focus_player=true;cx.notify();}))?;
  capture!("renamed-1280.png");
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"Occupied")?;key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
  wait!(|p:&Player|!p.loading&&p.rename_pending.is_none()&&p.notice.is_some());
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.as_ref().unwrap().dir==renamed&&p.notice.as_ref().unwrap().contains("already exists"),"Collision changed project: {:?}",p.notice);Ok(())})??;
  capture!("collision-1280.png");handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;cx.notify();}))?;
  // A notice that opens while nothing holds focus (a mouse click on a card that fails to open) must not leave the
  // window without focus when it closes: a real Tab then goes nowhere. The player root takes focus back.
  handle.update(cx,|_,w,cx|{draw(w,cx);w.blur(cx);anyhow::ensure!(w.focused(cx).is_none(),"Fixture could not clear focus");view.update(cx,|p,cx|{p.notice=Some("Focus fixture".into());cx.notify();});draw(w,cx);Ok::<_,anyhow::Error>(())})??;
  handle.update(cx,|_,w,cx|{view.update(cx,|p,cx|{p.notice=None;cx.notify();});draw(w,cx);Ok::<_,anyhow::Error>(())})??;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(w.focused(cx).is_some(),"Focus was lost when the notice closed");key(w,cx,"tab");draw(w,cx);anyhow::ensure!(view.read(cx).header.read(cx).focused_control(w).is_some(),"A real Tab with nothing focused did not reach the first header control");Ok(())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.focus_player=true;cx.notify();}))?;
  // While a project is loading (or a source job runs) the root owns focus and a Tab must not walk the page behind
  // the modal: the root Tab handler stands behind the same predicate that makes the app treat the state as modal.
  handle.update(cx,|_,w,cx|{draw(w,cx);Ok::<_,anyhow::Error>(())})??;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{
    view.update(cx,|p,cx|{p.loading=true;p.focus_player=true;cx.notify();});draw(w,cx);
    let held=view.read(cx).focus_handle.is_focused(w);
    let covered_before=view.read(cx).output_covered(cx);
    let header_before=view.read(cx).header.read(cx).focused_control(w);
    key(w,cx,"tab");draw(w,cx);
    let tab_moved=view.read(cx).header.read(cx).focused_control(w).is_some()||!view.read(cx).focus_handle.is_focused(w);
    key(w,cx,"shift-tab");draw(w,cx);
    let (loading_after,covered_after)=(view.read(cx).loading,view.read(cx).output_covered(cx));
    let header_focus=view.read(cx).header.read(cx).focused_control(w);
    let root_focus=view.read(cx).focus_handle.is_focused(w);
    let moved=tab_moved||header_focus.is_some()||!root_focus;
    view.update(cx,|p,cx|{p.loading=false;cx.notify();});draw(w,cx);
    anyhow::ensure!(held,"The root should hold focus under a loading modal");
    anyhow::ensure!(!moved,"A root Tab walked the header behind a loading project's modal: header {header_focus:?}, root focused {root_focus}, covered before the Tab {covered_before}, header focus before the Tab {header_before:?}, loading after {loading_after}, covered after {covered_after}");Ok(())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.focus_player=true;cx.notify();}))?;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.native_transport(transport::TransportEvent::Loop,cx);p.native_transport(transport::TransportEvent::Play,cx);}))?;wait!(|p:&Player|p.playing);
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"Playing rename")?;key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
  wait!(|p:&Player|!p.loading&&p.rename_pending.is_none()&&p.song_title.as_str()=="Playing rename"&&p.playing);
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.looping&&p.gain[5]==42&&p.master_volume==0.6&&p.notice.is_none(),"Playing rename reset mix");Ok(())})??;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|!p.playing);
  let saved=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().dir.clone())?;
  // A later external edit cannot be silently overwritten by renaming.
  let path=saved.join("project.json");let mut raw:serde_json::Value=serde_json::from_slice(&std::fs::read(&path)?)?;raw["externalChange"]=serde_json::json!("keep");std::fs::write(&path,serde_json::to_vec_pretty(&raw)?)?;
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"Refused stale rename")?;key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
  wait!(|p:&Player|!p.loading&&p.rename_pending.is_none()&&p.notice.is_some());
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.project.as_ref().unwrap().dir==saved&&p.notice.as_ref().unwrap().contains("changed outside"),"External edit not protected: {:?}",p.notice);Ok(())})??;
  // Loose source titles stay in memory until the user explicitly saves.
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_source(source.clone(),cx)))?;
  wait!(|p:&Player|!p.loading&&p.source_job.is_none()&&p.source_working&&p.project.as_ref().is_some_and(|p|p.original));
  handle.update(cx,|_,w,cx|{edit(&view,w,cx,"Unsaved named source")?;click(w,cx,point(px(500.),px(400.)));Ok::<_,anyhow::Error>(())})??;
  wait!(|p:&Player|p.song_title.as_str()=="Unsaved named source");
  handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.source_working&&p.source_target.is_none()&&p.edit_seq!=p.saved_seq,"Loose title was published");Ok(())})??;
  handle.update(cx,|_,w,cx|edit(&view,w,cx,"Unsaved named source"))??;
  handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;capture!("editing-1060.png");
  handle.update(cx,|_,w,cx|{key(w,cx,"escape");w.resize(size(px(1280.),px(800.)));})?;
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;
  wait!(|p:&Player|!p.loading&&p.source_job.is_none()&&!p.source_working&&p.song_title.as_str()=="Unsaved named source");
  let imported=handle.update(cx,|_,_,cx|view.read(cx).project.as_ref().unwrap().dir.clone())?;capture!("saved-title-1280.png");
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"keyboardPencilOpen":true,"escape":true,"blank":true,"enter":true,"blur":true,"savedFolderRename":saved,"unsavedSavedProject":imported,"collisionRefused":true,"externalEditRefused":true,"mixAndPausedPositionRetained":true,"playingRetained":true,"libraryRouteAndSearchFocusRetained":true,"hidden":true,"muted":true}))?)?;
  Ok(())
 }.await;
 match result {Ok(())=>eprintln!("NATIVE_TITLE passed"),Err(e)=>eprintln!("NATIVE_TITLE failed: {e:#}")};let _=cx.update(|cx|cx.quit());
}).detach();
}

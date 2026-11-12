//! Actual hidden locale controls, preference receipts and native playback continuity.
use super::*;
use crate::{i18n::{Language,Locale},ui_training_run::{click,draw}};
use std::{path::{Path,PathBuf},time::Duration};
fn key(w:&mut Window,cx:&mut App,value:&'static str){w.dispatch_keystroke(Keystroke::parse(value).unwrap(),cx);}
fn header(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
 draw(w,cx);let b=view.read(cx).header.read(cx).guides.get(id).ok_or_else(||anyhow::anyhow!("Actual header {id} unmeasured"))?;
 anyhow::ensure!(b.top()>=px(0.)&&b.bottom()<=px(52.)&&b.left()>=px(0.)&&b.right()<=w.viewport_size().width,"Header {id} outside viewport: {b:?}");click(w,cx,b.center());Ok(())
}
fn state(view:&Entity<Player>,w:&Window,cx:&App)->serde_json::Value {
 let p=view.read(cx);let service=p.locale_service.snapshot();
 serde_json::json!({"locale":p.language_state,"localePending":service.pending,"localeSequence":service.sequence,"localeError":service.error,
  "menu":p.language_menu.read(cx).state(w,cx),"search":p.library.read(cx).review_snapshot()["query"],
  "carry":p.carry_popover.read(cx).state(w,cx),"metronomeCaption":p.metronome_ui.read(cx).caption(),
  "log":p.log_panel.read(cx).state(w,cx),
  "quickStart":p.quick_start.read(cx).snapshot(),"release":p.whats_new.read(cx).state(w,cx),
  "screen":p.screen as u8,"project":p.project.as_ref().map(|p|&p.dir),"epoch":p.native_epoch,"playing":p.playing,"position":p.playhead.position(),
  "gain":p.gain.as_slice(),"muted":p.muted.as_slice(),"solo":p.solo.as_slice(),"tempo":p.tempo,"transpose":p.transpose,"master":p.master_volume,
  "native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"graph":s.graph_generation,"playing":s.playing,"position":s.position,"rate":s.rate,"lanes":s.observed_lanes})),
  "header":p.header.read(cx).pill_fit(w),"titleEditor":p.header.read(cx).guides.get("title-editor").map(|b|f32::from(b.size.width)),"notice":p.notice,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),
  "sourceAuthority":"LanguageSwitcher.tsx/Flags.tsx current source; native candidate only","liveFps":"unmeasured"})
}
fn shot(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&Path,name:&str)->anyhow::Result<()> {
 draw(w,cx);anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Locale UI activated window");
 w.render_to_image()?.save(out.join(format!("{name}.png")))?;
 std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&state(view,w,cx))?)?;Ok(())
}
fn focus_target(view:&Entity<Player>,w:&mut Window,cx:&mut App,index:usize)->anyhow::Result<()> {
 key(w,cx,"home");for _ in 0..index {key(w,cx,"down");}draw(w,cx);
 let menu=view.read(cx).language_menu.read(cx);let s=menu.state(w,cx);
 anyhow::ensure!(s["focusedIndex"].as_u64()==Some(index as u64)&&s["focusInside"]==true,"Actual locale keyboard target differs: {s}");
 let id=format!("language-option-{}",Language::ALL[index].as_str());let b=menu.bounds(&id).ok_or_else(||anyhow::anyhow!("Actual locale row missing: {id}"))?;
 let viewport=menu.scroll_viewport();anyhow::ensure!(viewport.size.height>px(0.),"Language scroll viewport missing");
 anyhow::ensure!(b.top()>=viewport.top()-px(0.1)&&b.bottom()<=viewport.bottom()+px(0.1)&&b.left()>=px(0.)&&b.right()<=w.viewport_size().width,"Keyboard target not visible inside menu: {id} {b:?} {viewport:?}");Ok(())
}
pub fn run(handle:AnyWindowHandle,view:Entity<Player>,out:PathBuf,cx:&mut App){let clipboard=cx.read_from_clipboard();cx.spawn(async move|cx|{
 let result:anyhow::Result<()>=async {
  std::fs::create_dir_all(&out)?;let project=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());
  let stage=std::env::var("SINGZ_GPUI_LOCALE_STAGE").unwrap_or_else(|_|"exercise".into());
  macro_rules! wait {($p:ident,$w:ident,$app:ident=>$condition:expr)=>{{let deadline=Instant::now()+Duration::from_secs(12);loop {
   cx.background_executor().timer(Duration::from_millis(10)).await;
   if handle.update(cx,|_,$w,$app|{draw($w,$app);let $p=view.read($app);$condition})? {break;}
   if Instant::now()>=deadline {let s=handle.update(cx,|_,w,cx|state(&view,w,cx))?;anyhow::bail!("Locale timeout {}: {}",stringify!($condition),s);}
  }}};}
  macro_rules! settled {($language:expr)=>{wait!(p,w,app=>p.language_state.is_some_and(|s|s.language==$language)&&!p.locale_service.snapshot().pending&&p.locale_service.snapshot().error.is_none())};}
  macro_rules! open {()=>{{handle.update(cx,|_,w,cx|header(&view,w,cx,"language"))??;
   wait!(p,w,app=>p.language_menu.read(app).is_open()&&p.language_menu.read(app).state(w,app)["focusInside"]==true);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{let ui=view.read(cx).language_menu.clone();ui.update(cx,|s,cx|s.set_animation_time(Some(0.18),cx));draw(w,cx);
    let state=ui.read(cx).state(w,cx);anyhow::ensure!(state["focusedIndex"]==state["selectedIndex"],"Opening locale menu did not focus its selected row: {state}");Ok(())})??;
  }};}
  macro_rules! choose {($language:expr,$ending:expr)=>{{
   let language=$language;open!();let index=Language::ALL.iter().position(|v|*v==language).unwrap();
   handle.update(cx,|_,w,cx|focus_target(&view,w,cx,index))??;
   handle.update(cx,|_,w,cx|key(w,cx,$ending))?;
   wait!(p,w,app=>!p.language_menu.read(app).is_open());settled!(language);
  }};}
  wait!(p,w,app=>p.language_state.is_some()&&!p.locale_service.snapshot().pending);
  if stage=="restart" {settled!(Language::Locale(Locale::Ja));}
  handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(project.clone(),cx)))?;
  wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|p|p.dir==project)&&p.duration>60.);
  // Opening analyses the song and legitimately auto-saves it. Wait for that save to
  // finish, then record the project exactly as it is: from here on, choosing a
  // language must not rewrite a single file (compared by the Python runner).
  wait!(p,w,app=>!p.saving&&!p.beat_auto_save&&!p.source_working&&p.source_job.is_none()&&std::fs::read_to_string(project.join("project.json")).is_ok_and(|t|t.contains("\"savedAt\"")));
  fn copy_tree(from:&Path,to:&Path)->std::io::Result<()>{std::fs::create_dir_all(to)?;for entry in std::fs::read_dir(from)?{let entry=entry?;let target=to.join(entry.file_name());if entry.file_type()?.is_dir(){copy_tree(&entry.path(),&target)?;}else{std::fs::copy(entry.path(),&target)?;}}Ok(())}
  let settled=out.join("settled-project");let _=std::fs::remove_dir_all(&settled);copy_tree(&project,&settled)?;
  handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Actual native Play missing"))?;click(w,cx,b.center());Ok(())})??;
  wait!(p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing)&&p.playhead.position()>0.1);
  let baseline=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.native_epoch,p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.tempo,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection),p.last_playback_status.as_ref().unwrap().graph_generation)})?;
  macro_rules! audio_unchanged {()=>{handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing),"Language change paused real native playback");
   anyhow::ensure!((p.native_epoch,p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.tempo,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection),p.last_playback_status.as_ref().unwrap().graph_generation)==baseline,"Locale selection rebuilt native graph or changed mix/transport");Ok(())})??;};}
  // Native transport as the singer would observe it: running or paused, and where.
  macro_rules! audio_snapshot {()=>{handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playing,p.last_playback_status.as_ref().is_some_and(|s|s.playing),p.playhead.position())})?};}
  // A language change must leave the transport exactly as it was: playing stays
  // playing and paused stays paused at the same position; graph and mix are untouched.
  macro_rules! audio_state_same {($before:expr)=>{{let before=$before;handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);
   let now=(p.playing,p.last_playback_status.as_ref().is_some_and(|s|s.playing),p.playhead.position());
   anyhow::ensure!(now.0==before.0&&now.1==before.1,"Language change altered native transport state: before {before:?} after {now:?}");
   if before.1 {anyhow::ensure!(now.2>=before.2-0.05,"Playing position moved backwards across a language change: {before:?} {now:?}");}
   else {anyhow::ensure!((now.2-before.2).abs()<0.05,"Paused position moved across a language change: {before:?} {now:?}");}
   anyhow::ensure!((p.native_epoch,p.gain,p.muted,p.solo,p.master_volume,p.transpose,p.tempo,p.playhead.loop_range(),p.project.as_ref().and_then(|p|p.selection),p.last_playback_status.as_ref().unwrap().graph_generation)==baseline,"Locale selection rebuilt native graph or changed mix/transport");Ok(())})??;}};}
  for (width,height) in [(1280.,800.),(1060.,640.)] {
   handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
   let suffix=width as u32;
   if stage=="restart" {
    settled!(Language::Locale(Locale::Ja));open!();
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("restored-ja-{suffix}")))??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());audio_unchanged!();continue;
   }
   // Actual player popovers consume the selected language without touching
   // the accepted scheduling/grid state or reopening the native graph.
   for locale in [Locale::En,Locale::Ru] {
    choose!(Language::Locale(locale),"enter");
    for (guide,carry) in [("carry",true),("metronome",false)] {
     handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).guides.get(guide).ok_or_else(||anyhow::anyhow!("Actual player trigger {guide} missing"))?;click(w,cx,b.center());Ok(())})??;
     wait!(p,w,app=>if carry {p.carry_open} else {p.metronome_open});
     handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("popover-{guide}-{}-{suffix}",locale.as_str())))??;
     handle.update(cx,|_,w,cx|click(w,cx,point(px(12.),px(80.))))?;
     wait!(p,w,app=>!p.carry_open&&!p.metronome_open);audio_unchanged!();
    }
   }
   // Every actual choice: keyboard selection, durable worker receipt, reopening
   // selected-row focus, real flags/hints, and native continuity.
   for (index,language) in Language::ALL.into_iter().enumerate() {
    choose!(language,if index%2==0 {"enter"}else{"space"});audio_unchanged!();
    open!();handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let menu=view.read(cx).language_menu.read(cx);let state=menu.state(w,cx);
     anyhow::ensure!(state["rows"].as_array().unwrap().len()==Language::ALL.len(),"Missing actual locale rows");
     let selected:Vec<_>=state["rows"].as_array().unwrap().iter().filter(|r|r["selected"]==true).collect();
     anyhow::ensure!(selected.len()==1&&selected[0]["value"]==language.as_str(),"Selected check differs from accepted language: {state}");
     let b=menu.bounds("language-menu").ok_or_else(||anyhow::anyhow!("Language popup not measured"))?;
     let anchor=view.read(cx).header.read(cx).guides.get("language").unwrap();
     anyhow::ensure!((b.right()-anchor.right()).abs()<px(0.1)&&(b.top()-anchor.bottom()-px(6.)).abs()<px(0.1)&&b.bottom()<=w.viewport_size().height-px(12.),"Language bottom-end anchor or viewport clamp differs: {b:?} {anchor:?}");
     shot(&view,w,cx,&out,&format!("selected-{}-{suffix}",language.as_str()))})??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());
   }
   open!();handle.update(cx,|_,w,cx|->anyhow::Result<()>{
    for (key_value,expected) in {let last=Language::ALL.len()-1;[("home",0usize),("up",last),("down",0),("end",last),("home",0)]} {
     key(w,cx,key_value);draw(w,cx);let state=view.read(cx).language_menu.read(cx).state(w,cx);
     anyhow::ensure!(state["focusedIndex"].as_u64()==Some(expected as u64),"Locale arrows/Home/End differ: {key_value}: {state}");
    }Ok(())})??;
   handle.update(cx,|_,w,cx|key(w,cx,"tab"))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).header.read(cx).focused_control(w).as_deref()==Some("header-help"),"Tab did not leave language popup to actual next header control");Ok(())})??;
   open!();handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());
   open!();handle.update(cx,|_,w,cx|click(w,cx,point(px(12.),px(80.))))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());audio_unchanged!();
   // A real controlled text input keeps its uncommitted search while the
   // dictionaries and placeholder change; type events settle between updates.
   choose!(Language::Locale(Locale::En),"enter");
   handle.update(cx,|_,w,cx|header(&view,w,cx,"catalog"))??;wait!(p,w,app=>p.screen==Screen::Library);
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-f"}else{"ctrl-f"}))?;
   wait!(p,w,app=>p.library.read(app).search_focused(w,app));
   let mut query=String::new();
   for value in ["l","o","c","a","l","e"] {query.push_str(value);handle.update(cx,|_,w,cx|key(w,cx,value))?;
    wait!(p,w,app=>p.library.read(app).review_snapshot()["query"]==query);
   }
   // Opening the catalog pauses playback by design, so here the invariant is
   // that choosing a language leaves the (paused) transport exactly as it was.
   let on_catalog=audio_snapshot!();
   choose!(Language::Locale(Locale::Ru),"space");audio_state_same!(on_catalog);
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).library.read(cx).review_snapshot()["query"]=="locale","Locale refresh erased a real controlled search draft");shot(&view,w,cx,&out,&format!("search-preserved-ru-{suffix}"))})??;
   // Clear through the actual input, preserving the next width's clean setup.
   handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-f"}else{"ctrl-f"}))?;
   wait!(p,w,app=>p.library.read(app).search_focused(w,app));
   handle.update(cx,|_,w,cx|{key(w,cx,if cfg!(target_os="macos"){"cmd-a"}else{"ctrl-a"});key(w,cx,"backspace");})?;
   wait!(p,w,app=>p.library.read(app).review_snapshot()["query"]=="");
   handle.update(cx,|_,w,cx|header(&view,w,cx,"catalog"))??;wait!(p,w,app=>p.screen==Screen::Player);
   // Back on the player the catalog's pause still holds; resume with the real Play
   // button, then change language while playing and require the position to keep advancing.
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Actual native Play missing"))?;click(w,cx,b.center());Ok(())})??;
   wait!(p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
   let running=audio_snapshot!();
   choose!(Language::Locale(Locale::Ko),"enter");
   audio_state_same!(running);
   wait!(p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing)&&p.playhead.position()>running.2+0.3);
   audio_unchanged!();
   // Reposition an OPEN popup across actual native resizing, not a captured
   // screenshot transform. Restore size before the next normal case.
   open!();let alternate=if suffix==1280 {(1060.,640.)}else{(1280.,800.)};
   handle.update(cx,|_,w,_|w.resize(size(px(alternate.0),px(alternate.1))))?;
   wait!(p,w,app=>w.viewport_size()==size(px(alternate.0),px(alternate.1)));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let b=view.read(cx).language_menu.read(cx).bounds("language-menu").unwrap();let anchor=view.read(cx).header.read(cx).guides.get("language").unwrap();anyhow::ensure!((b.right()-anchor.right()).abs()<px(0.1)&&(b.top()-anchor.bottom()-px(6.)).abs()<px(0.1),"Open locale popup did not follow resized header");shot(&view,w,cx,&out,&format!("resized-open-from-{suffix}"))})??;
   handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.language_menu.read(app).is_open());
   handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
  }
  if stage=="exercise" {
   // Record the real minimum (940x600, desktop_lifecycle.rs) and the 1060x640 routes for every shipped language.
   for (prefix,width,height) in [("minimum",940.,600.),("narrow",1060.,640.)] {
   handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
   wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
   for language in Language::ALL {
    choose!(language,"enter");
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let header=view.read(cx).header.clone();let b=header.read(cx).rename_bounds.get().ok_or_else(||anyhow::anyhow!("Title pencil missing"))?;click(w,cx,b.center());draw(w,cx);anyhow::ensure!(header.read(cx).is_editing(),"Title editor did not open");let bounds=header.read(cx).guides.get("title-editor").ok_or_else(||anyhow::anyhow!("Title editor bounds missing"))?;let _=bounds;shot(&view,w,cx,&out,&format!("{}-title-{}",prefix,language.as_str()))?;key(w,cx,"escape");Ok(())})??;
    handle.update(cx,|_,w,cx|header(&view,w,cx,"settings"))??;wait!(p,w,app=>p.screen==Screen::Settings);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("{}-settings-{}",prefix,language.as_str())))??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>p.screen==Screen::Player);
    handle.update(cx,|_,w,cx|header(&view,w,cx,"catalog"))??;wait!(p,w,app=>p.screen==Screen::Library);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("{}-library-{}",prefix,language.as_str())))??;
    handle.update(cx,|_,w,cx|header(&view,w,cx,"catalog"))??;wait!(p,w,app=>p.screen==Screen::Player);
   }
   }
  }
  if stage=="exercise" {
   // User-facing Training, help and release routes consume the current locale.
   // Training intentionally pauses the song; native continuity was checked above.
   for (width,height) in [(1280.,800.),(1060.,640.)] {
    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
    let suffix=width as u32;
    for locale in [Locale::En,Locale::Ru] {
    choose!(Language::Locale(locale),"enter");
    handle.update(cx,|_,w,cx|header(&view,w,cx,"training"))??;wait!(p,w,app=>p.screen==Screen::Training);
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("training-{}-{suffix}",locale.as_str())))??;
    handle.update(cx,|_,w,cx|header(&view,w,cx,"log"))??;wait!(p,w,app=>p.log_panel.read(app).is_open());
    handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let log=view.read(cx).log_panel.clone();let b=log.read(cx).bounds("log-copy").ok_or_else(||anyhow::anyhow!("Actual Log Copy missing"))?;let card=log.read(cx).bounds("log-card").unwrap();anyhow::ensure!(b.left()>=card.left()&&b.right()<=card.right()&&b.top()>=card.top()&&b.bottom()<=card.bottom(),"Localized Log Copy outside modal: {b:?} {card:?}");click(w,cx,b.center());draw(w,cx);let state=log.read(cx).state(w,cx);anyhow::ensure!(state["copied"]==true&&cx.read_from_clipboard().and_then(|item|item.text()).as_deref()==state["copyText"].as_str(),"Localized Log Copy changed raw diagnostic bytes");shot(&view,w,cx,&out,&format!("log-{}-{suffix}",locale.as_str()))})??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.log_panel.read(app).is_open());
    handle.update(cx,|_,w,cx|header(&view,w,cx,"help"))??;wait!(p,w,app=>p.quick_start.read(app).is_open());
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("tour-{}-{suffix}",locale.as_str())))??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.quick_start.read(app).is_open());
    handle.update(cx,|_,w,cx|header(&view,w,cx,"version"))??;wait!(p,w,app=>p.whats_new.read(app).is_open());
    handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,&format!("release-{}-{suffix}",locale.as_str())))??;
    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;wait!(p,w,app=>!p.whats_new.read(app).is_open());
   }
   }
   choose!(Language::Locale(Locale::En),"enter");
   // Actual file contention holds the first preference writer while three real
   // menu picks are admitted. The final durable receipt must belong to JA.
   let config=audio_devices::directory();let file=std::fs::OpenOptions::new().read(true).write(true).open(config.join(".language.lock"))?;
   let lease=crate::file_lease::Lease::acquire(file)?;
   let sequence=handle.update(cx,|_,_,cx|view.read(cx).locale_service.snapshot().sequence)?;
   for locale in [Locale::Ru,Locale::Tr,Locale::Ja] {
    open!();let index=Language::ALL.iter().position(|value|*value==Language::Locale(locale)).unwrap();
    handle.update(cx,|_,w,cx|focus_target(&view,w,cx,index))??;handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
    wait!(p,w,app=>!p.language_menu.read(app).is_open()&&p.locale_service.snapshot().pending);
   }
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).language_state.unwrap().language==Language::Locale(Locale::En),"Uncommitted preference replaced current UI while actual lease held");std::fs::write(out.join("rapid-held.json"),serde_json::to_vec_pretty(&state(&view,w,cx))?)?;Ok(())})??;
   drop(lease);settled!(Language::Locale(Locale::Ja));
   handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).locale_service.snapshot().sequence==sequence+3,"Latest actual preference admission did not win");shot(&view,w,cx,&out,"rapid-final-ja")})??;
  }
  std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"stage":stage,"sizes":2,"actualAll14Choices":stage=="exercise","nativePlaybackPreserved":true,"actualInputDraftPreserved":stage=="exercise","keyboardOutsideResize":stage=="exercise","actualRapidPicks":stage=="exercise","persistedRestartJa":stage=="restart","hidden":true,"visualParity":"unqualified native candidate","liveFps":"unmeasured"}))?)?;Ok(())
 }.await;
 if let Err(error)=result {let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|shot(&view,w,cx,&out,"failure"));eprintln!("LOCALE_UI failed: {error:#}");}
 let _=cx.update(|cx|{cx.write_to_clipboard(clipboard.unwrap_or(ClipboardItem{entries:vec![]}));cx.quit();});
}).detach();}

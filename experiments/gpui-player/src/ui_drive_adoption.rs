//! Actual gated downloads → catalog action → native playback/Save → offline reopen.
use super::*;

fn snapshot(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    let mut value = super::state(view, w, cx);
    let p = view.read(cx);
    value["lyrics"] = serde_json::json!({"karaoke":p.karaoke,"credit":p.lyric_document.credit,
        "source":p.lyric_document.source,"lines":p.lyric_document.lines.iter().map(|line|serde_json::json!({"text":line.text,"start":line.start,"end":line.end,"words":line.words.len()})).collect::<Vec<_>>(),
        "masks":p.lyric_document.masks.len(),"sidebar":p.lyrics_sidebar.read(cx).state(w,cx)});
    value["mix"] = serde_json::json!({"gain":p.gain.as_slice(),"muted":p.muted.as_slice(),"master":p.master_volume});
    value
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(
        !w.is_visible() && !w.is_window_active(),
        "Adoption test activated a window"
    );
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    marker(&out.join(format!("{name}.json")), &snapshot(view, w, cx))
}
fn reveal_progress(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let library = view.read(cx).library.clone();
    let bounds = library
        .read(cx)
        .drive_bounds("library-drive-cancel")
        .ok_or_else(|| anyhow::anyhow!("Busy Cancel control missing"))?;
    library.read(cx).reveal_guide(bounds);
    draw(w, cx);
    Ok(())
}
fn open_card(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    path: &Path,
) -> anyhow::Result<()> {
    let library = view.read(cx).library.clone();
    for _ in 0..5 {
        draw(w, cx);
        let bounds = library
            .read(cx)
            .project_open_bounds(path)
            .ok_or_else(|| anyhow::anyhow!("Adopted project card not measured"))?;
        if bounds.top() >= px(52.) && bounds.bottom() <= w.viewport_size().height {
            click(w, cx, bounds.center());
            return Ok(());
        }
        library.read(cx).reveal_guide(bounds);
    }
    anyhow::bail!("Adopted project card is outside the viewport")
}
fn native_mix(p: &Player, bass_muted: bool) -> bool {
    let Some(lanes) = p
        .last_playback_status
        .as_ref()
        .and_then(|s| s.observed_lanes.as_array())
    else {
        return false;
    };
    lanes.len() == 2
        && [("vocals", 0.37, false), ("bass", 0.7, bass_muted)]
            .into_iter()
            .all(|(id, gain, muted)| {
                lanes.iter().any(|lane| {
                    lane["id"] == id
                        && lane["muted"] == muted
                        && lane["gain"]
                            .as_f64()
                            .is_some_and(|g| (g - gain).abs() < 0.0001)
                })
            })
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
  let result:anyhow::Result<()>=async {
   std::fs::create_dir_all(&out)?;
   let target=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").ok_or_else(||anyhow::anyhow!("Missing adoption target"))?);
   // The destination may not exist until adoption; match the backend's
   // canonical parent identity, including Windows verbatim paths.
   let target=target.parent().ok_or_else(||anyhow::anyhow!("Missing adoption parent"))?.canonicalize()?.join(target.file_name().ok_or_else(||anyhow::anyhow!("Missing adoption name"))?);
   let offline=std::env::var("SINGZ_GPUI_DRIVE_STAGE").as_deref()==Ok("adoption-offline");
   macro_rules! wait {($p:ident,$w:ident,$app:ident=>$predicate:expr)=>{{
    let deadline=Instant::now()+Duration::from_secs(30);
    loop {cx.background_executor().timer(Duration::from_millis(20)).await;
     if handle.update(cx,|_,$w,$app|{draw($w,$app);let $p=view.read($app);$predicate})? {break;}
     anyhow::ensure!(Instant::now()<deadline,"Adoption wait timed out {}: {}",stringify!($predicate),handle.update(cx,|_,w,cx|snapshot(&view,w,cx))?);
    }
   }};}
   macro_rules! handshake {($name:expr,$operation:expr)=>{{
    let name=$name;request(&out,&name,$operation)?;
    let deadline=Instant::now()+Duration::from_secs(12);
    while !out.join("acks").join(format!("{name}.json")).exists() {
     cx.background_executor().timer(Duration::from_millis(20)).await;
     anyhow::ensure!(Instant::now()<deadline,"Adoption fixture handshake timed out: {name}");
    }
   }};}
   macro_rules! both {($name:expr,$progress:expr)=>{{
    for (width,height) in [(1280.,800.),(1060.,640.)] {
     handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
     wait!(p,w,app=>w.viewport_size()==size(px(width),px(height)));
     if $progress {handle.update(cx,|_,w,cx|reveal_progress(&view,w,cx))??;}
     handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&format!("{}-{}",$name,width as u32)))??;
    }
   }};}
   wait!(p,w,app=>p.drive_snapshot.configured&&p.backend.is_some());
   handle.update(cx,|_,w,cx|songs(&view,w,cx,true))??;
   wait!(p,w,app=>p.screen==Screen::Library);
   if !offline {
    anyhow::ensure!(!target.exists(),"Adoption target already exists before download");
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-connect"))??;
    wait!(p,w,app=>!p.drive_test_urls.is_empty());
    let url=handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls[0].clone())?;
    marker(&out.join("authorization-url-0.json"),&serde_json::json!({"url":url}))?;
    wait!(p,w,app=>p.drive_snapshot.busy&&p.drive_snapshot.progress.contains("original.wav")&&p.drive_snapshot.progress.contains("64 KB"));
    handshake!("first-held".to_owned(),"first-held");
    both!("download-before-cancel",true);
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-cancel"))??;
    wait!(p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.progress.contains("Sync paused"));
    anyhow::ensure!(!target.exists(),"Cancelled transfer published the destination");
    handshake!("cancelled-proof".to_owned(),"cancelled-proof");
    both!("download-cancelled",false);
    handle.update(cx,|_,w,cx|library(&view,w,cx,"library-drive-sync"))??;
    wait!(p,w,app=>p.drive_snapshot.busy&&p.drive_snapshot.progress.contains("original.wav")&&p.drive_snapshot.progress.contains("64 KB"));
    handshake!("resumed-first-held".to_owned(),"first-held");
    let first=handle.update(cx,|_,_,cx|view.read(cx).drive_snapshot.fraction)?;
    anyhow::ensure!(!target.exists(),"Partial transfer published the destination");
    both!("download-first",true);
    handshake!("release-first".to_owned(),"release-first");
    wait!(p,w,app=>p.drive_snapshot.busy&&p.drive_snapshot.progress.contains("original.wav")&&p.drive_snapshot.progress.contains("256 KB")&&p.drive_snapshot.fraction>first);
    handshake!("second-held".to_owned(),"second-held");
    anyhow::ensure!(!target.exists(),"Second partial transfer published the destination");
    both!("download-second",true);
    handshake!("release-second".to_owned(),"release-second");
    wait!(p,w,app=>!p.drive_snapshot.busy&&p.drive_snapshot.error.is_none()&&p.drive_snapshot.scheduler.last_sync.is_some()&&p.drive_snapshot.scheduler.dirty==0);
    handshake!("adoption-proof".to_owned(),"adoption-proof");
   }
   wait!(p,w,app=>p.library.read(app).project_snapshot().as_array().is_some_and(|rows|rows.iter().any(|row|row["dir"].as_str()==target.to_str())));
   both!(if offline {"offline-catalog"}else{"adopted-catalog"},false);
   handle.update(cx,|_,w,cx|open_card(&view,w,cx,&target))??;
   wait!(p,w,app=>!p.loading&&p.project.as_ref().is_some_and(|project|project.dir==target)&&p.screen==Screen::Player&&p.duration>119.&&native_mix(p,offline));
   handle.update(cx,|_,w,cx|->anyhow::Result<()> {
    let p=view.read(cx);
    anyhow::ensure!(p.project.as_ref().unwrap().lyrics_error.is_none(),"Adopted lyrics were rejected: {:?}",p.project.as_ref().unwrap().lyrics_error);
    anyhow::ensure!(p.lyric_document.credit=="Phone fixture credit","Adopted lyrics credit was not retained");
    anyhow::ensure!(p.lyric_document.lines.len()==24,"Adopted lyrics row count is {}, expected 24",p.lyric_document.lines.len());
    for (index,line) in p.lyric_document.lines.iter().enumerate() {
     anyhow::ensure!(line.text=="A song brought home"&&line.start==index as f32*5.&&line.end==index as f32*5.+5.&&line.words.len()==4,
        "Adopted lyrics row {index} lost its fixture text/timing/words");
    }
    // Karaoke is a remembered global mode, default off in these private
    // preferences. Restoring lyrics does not enable it or mute the guide;
    // this journey qualifies restored data/native mix, not sung highlighting.
    anyhow::ensure!(!p.karaoke&&!p.karaoke_preferred,"Adopted lyrics changed the private default-off Karaoke preference");
    anyhow::ensure!((p.master_volume-0.61).abs()<0.0001,"Adopted song volume lost");
    draw(w,cx);Ok(())
   })??;
   both!(if offline {"offline-loaded"}else{"adopted-loaded"},false);
   handle.update(cx,|_,w,cx|play(&view,w,cx))??;
   wait!(p,w,app=>p.playing&&p.position>0.2&&p.last_playback_status.as_ref().is_some_and(|status|status.playing));
   let start=handle.update(cx,|_,_,cx|view.read(cx).position)?;
   wait!(p,w,app=>p.position>start+0.3&&native_mix(p,offline));
   both!(if offline {"offline-playing"}else{"adopted-playing"},false);
   if !offline {
    handle.update(cx,|_,w,cx|mute(&view,w,cx))??;
    wait!(p,w,app=>p.edit_seq!=p.saved_seq&&native_mix(p,true));
    handle.update(cx,|_,w,cx|key(w,cx,if cfg!(target_os="macos"){"cmd-s"}else{"ctrl-s"}))?;
    wait!(p,w,app=>!p.saving&&p.edit_seq==p.saved_seq&&p.notice.is_none());
    let saved:serde_json::Value=serde_json::from_slice(&std::fs::read(target.join("project.json"))?)?;
    anyhow::ensure!(saved["settings"]["tracks"]["bass"]["muted"]==true&&saved["foreign"]==serde_json::json!({"keep":"phone"}),"Adopted Save lost mixer state or foreign metadata");
    both!("adopted-saved-playing",false);
    handle.update(cx,|_,w,cx|play(&view,w,cx))??;
    wait!(p,w,app=>!p.playing&&!p.drive_snapshot.busy&&p.drive_snapshot.scheduler.dirty==0);
    handshake!("saved-proof".to_owned(),"saved-proof");
   } else {
    handle.update(cx,|_,w,cx|play(&view,w,cx))??;wait!(p,w,app=>!p.playing);
    anyhow::ensure!(handle.update(cx,|_,_,cx|view.read(cx).drive_test_urls.is_empty())?,"Offline reopen required OAuth");
   }
   marker(&out.join("result.json"),&serde_json::json!({"offline":offline,"twoSizes":true,"actualCatalogCard":true,"nativePlayback":true,"nativeMix":true,"savedLyrics":true,"hidden":true,"muted":true,"noNode":true,"liveFps":"unmeasured","streamingCaptured":!offline,"actualCancelResume":!offline}))?;
   Ok(())
  }.await;
  if let Err(error)=result {let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"failure"));eprintln!("DRIVE_ADOPTION failed: {error:#}");}
  let _=cx.update(|cx|cx.quit());
 }).detach();
}

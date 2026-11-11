//! Real Tab/Space/arrow/Enter song shortcuts, with text and dialog containment.
use super::*;
use std::{path::PathBuf, sync::mpsc, time::Duration};

fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    let stroke = Keystroke::parse(value).unwrap();
    w.dispatch_keystroke(stroke.clone(), cx);
    w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent { keystroke: stroke }), cx);
}
fn tab_footer(view:&Entity<Player>,w:&mut Window,cx:&mut App,id:&str)->anyhow::Result<()> {
    let mut trace=vec![];
    for attempt in 0..256 {
        super::ui_training_run::draw(w,cx);
        if view.read(cx).transport.read(cx).focused_control(w).as_deref()==Some(id){return Ok(());}
        let p=view.read(cx);
        let carry=p.carry_popover.read(cx).state(w,cx);
        let mut row=serde_json::json!({"attempt":attempt,"transport":p.transport.read(cx).keyboard_state(w,cx),
            "headerFocused":p.header.read(cx).focused_control(w),"rootFocused":p.focus_handle.is_focused(w),
            "windowFocusedDebug":format!("{:?}",w.focused(cx)),
            "trackGainFocused":p.track_gain_focus.iter().enumerate().filter_map(|(i,f)|f.is_focused(w).then_some(i)).collect::<Vec<_>>(),
            "trackMixFocused":p.track_mix_focus.iter().enumerate().filter_map(|(i,handles)|{let focused=[handles[0].is_focused(w),handles[1].is_focused(w)];focused.iter().any(|on|*on).then_some((i,focused))}).collect::<Vec<_>>(),
            "trackResetFocused":p.track_reset_focus.iter().enumerate().filter_map(|(i,f)|f.is_focused(w).then_some(i)).collect::<Vec<_>>(),
            "trackHeaderFocused":p.track_header_focus.iter().enumerate().filter_map(|(i,f)|f.is_focused(w).then_some(i)).collect::<Vec<_>>(),
            "titleInputFocused":p.header.read(cx).title_input_focused(w,cx),"lyricsSearchFocused":p.lyrics_sidebar.read(cx).input_focused(w,cx),
            "lyricsEditorInputFocused":p.lyrics_editor.read(cx).text_input_focused(w,cx),
            "metronomeInputFocused":p.metronome_ui.read(cx).focused(w,cx),"metronomeControlFocused":p.metronome_ui.read(cx).focused_control(w,cx),
            "carryFocusInside":carry["focusInside"],"carryFocusedControl":carry["focusedControl"],
            "screen":p.screen as u8,"audioAvailable":p.audio_available(),"loadedSong":p.loaded_song,"loading":p.loading,
            "sourceBlocksPlayer":p.source_blocks_player(),"sourceJob":p.source_job.is_some(),"sourceWorking":p.source_working,
            "playing":p.playing,"karaoke":p.karaoke,"metronomeOpen":p.metronome_open,"carryOpen":p.carry_open,
            "lyricsEditorOpen":p.lyrics_editor_open,"notice":p.notice});
        let stroke=Keystroke::parse("tab").unwrap();
        row["tabHandled"]=serde_json::json!(w.dispatch_keystroke(stroke.clone(),cx));
        w.dispatch_event(PlatformInput::KeyUp(KeyUpEvent{keystroke:stroke}),cx);
        row["windowFocusedAfterTabDebug"]=serde_json::json!(format!("{:?}",w.focused(cx)));
        trace.push(row);
    }
    anyhow::bail!("Actual Tab did not reach footer {id}; bounded trace: {}",serde_json::to_string(&trace)?)
}
fn tab_output_control(view:&Entity<Player>,w:&mut Window,cx:&mut App,index:usize)->anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w,cx);
        if view.read(cx).transport.read(cx).keyboard_state(w,cx)["outputControlFocused"][index]==true{return Ok(());}
        key(w,cx,"tab");
    }
    anyhow::bail!("Actual Tab did not reach output popup control {index}: {}",view.read(cx).transport.read(cx).keyboard_state(w,cx))
}
fn footer_state(p:&Player,w:&Window,cx:&App,phase:&str)->serde_json::Value {
    serde_json::json!({"phase":phase,"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],
        "scale":w.scale_factor(),"hidden":!w.is_visible()&&!w.is_window_active(),"active":w.is_window_active(),
        "keyboard":p.transport.read(cx).keyboard_state(w,cx),"playing":p.playing,"position":p.position,
        "epoch":p.native_epoch,"seekCount":p.native_seek_count,"tempo":p.tempo,"transpose":p.transpose,"masterVolume":p.master_volume,
        "karaoke":p.karaoke,"muted":p.muted[0],"looping":p.looping,"metronomeOpen":p.metronome_open,
        "carryOpen":p.carry_open,"sourceJob":p.source_job.is_some(),"engineSetupOpen":p.engine_setup.read(cx).is_open(),
        "modelsOpen":p.screen==Screen::Models,"native":p.last_playback_status.as_ref().map(|s|serde_json::json!({
            "playing":s.playing,"position":s.position,"rate":s.rate,"transpose":s.transpose,"loopRange":s.loop_range,"masterGain":s.observed_master_gain,
            "observedLanes":s.observed_lanes,"graph":s.graph_generation})),"liveFps":"unmeasured"})
}
fn footer_capture(view:&Entity<Player>,w:&mut Window,cx:&mut App,out:&std::path::Path,name:&str)->anyhow::Result<()> {
    super::ui_training_run::draw(w,cx);
    anyhow::ensure!(!w.is_visible()&&!w.is_window_active(),"Footer capture activated window");
    let mut value=footer_state(view.read(cx),w,cx,name);let image=w.render_to_image()?;
    value["raster"]=serde_json::json!([image.width(),image.height()]);
    image.save(out.join(format!("{name}.png")))?;
    std::fs::write(out.join(format!("{name}.state.json")),serde_json::to_vec_pretty(&value)?)?;Ok(())
}
fn close_split_refusal(view:&Entity<Player>,w:&mut Window,cx:&mut App)->anyhow::Result<()> {
    for _ in 0..128 {
        super::ui_training_run::draw(w,cx);let p=view.read(cx);
        let ready=if p.engine_setup.read(cx).is_open(){p.engine_setup.read(cx).state(w,cx)["focusedControl"]=="engine-setup-close"}
            else if p.screen==Screen::Models{p.models.read(cx).focused_control(w,cx).as_deref()==Some("model-close")}
            else{anyhow::bail!("Split refusal dialog disappeared before actual Close");};
        if ready{key(w,cx,"enter");return Ok(());}
        key(w,cx,"tab");
    }
    anyhow::bail!("Split refusal Close was not keyboard reachable")
}
fn tab_header(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w, cx);
        if view.read(cx).header.read(cx).focused_control(w).as_deref() == Some(id) {
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!(
        "Actual Tab did not reach {id}; focused={:?}",
        view.read(cx).header.read(cx).focused_control(w)
    )
}
fn click_transport(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    super::ui_training_run::draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Missing keyboard journey control {id}"))?;
    anyhow::ensure!(
        b.top() >= px(0.) && b.bottom() <= w.viewport_size().height,
        "Keyboard journey control clipped: {id}"
    );
    super::ui_training_run::click(w, cx, b.center());
    Ok(())
}
fn native_gain(p: &Player) -> Option<f32> {
    p.last_playback_status
        .as_ref()?
        .observed_lanes
        .as_array()?
        .iter()
        .find(|lane| lane["id"] == "vocals")?["gain"]
        .as_f64()
        .map(|gain| gain as f32)
}
fn native_mix(p: &Player) -> Option<(bool, bool)> {
    let lane = p.last_playback_status.as_ref()?.observed_lanes.as_array()?
        .iter().find(|lane| lane["id"] == "vocals")?;
    Some((lane["muted"].as_bool()?, lane["solo"].as_bool()?))
}
fn tab_stem_mix(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w, cx);
        if view.read(cx).track_mix_focus[0][button].is_focused(w) { return Ok(()); }
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Tab did not reach the vocal {} button", if button == 0 { "Mute" } else { "Solo" })
}
fn click_stem_mix(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    super::ui_training_run::draw(w, cx);
    let id = if button == 0 { "mute-0" } else { "solo-0" };
    let bounds = view.read(cx).track_bounds.borrow().get(id).copied()
        .ok_or_else(|| anyhow::anyhow!("Vocal mixer button was not drawn: {id}"))?;
    anyhow::ensure!(bounds.top() >= px(0.) && bounds.bottom() <= w.viewport_size().height,
        "Vocal mixer button clipped: {id}");
    super::ui_training_run::click(w, cx, bounds.center());
    Ok(())
}
fn tab_mix_reset(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w, cx);
        if view.read(cx).track_reset_focus[button].is_focused(w) { return Ok(()); }
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Tab did not reach mixer reset {button}")
}
fn assert_reset_skipped(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    tab_header(view, w, cx, "header-log")?;
    for _ in 0..64 {
        key(w, cx, "tab");
        super::ui_training_run::draw(w, cx);
        anyhow::ensure!(!view.read(cx).track_reset_focus[button].is_focused(w),
            "Disabled mixer reset {button} remained in the Tab sequence");
        if view.read(cx).header.read(cx).focused_control(w).as_deref() == Some("header-log") { return Ok(()); }
    }
    anyhow::bail!("Actual Tab did not complete a cycle while checking disabled mixer reset {button}")
}
fn click_mix_reset(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    super::ui_training_run::draw(w, cx);
    let id = format!("all-track-{button}");
    let bounds = view.read(cx).track_bounds.borrow().get(&id).copied()
        .ok_or_else(|| anyhow::anyhow!("Mixer reset was not drawn: {id}"))?;
    anyhow::ensure!(bounds.top() >= px(0.) && bounds.bottom() <= w.viewport_size().height,
        "Mixer reset clipped: {id}");
    super::ui_training_run::click(w, cx, bounds.center());
    Ok(())
}
fn tab_track_header(view: &Entity<Player>, w: &mut Window, cx: &mut App, button: usize) -> anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w, cx);
        if view.read(cx).track_header_focus[button].is_focused(w) { return Ok(()); }
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Tab did not reach the track {} button", if button == 0 { "Add" } else { "Export" })
}
fn tab_stem_gain(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    for _ in 0..64 {
        super::ui_training_run::draw(w, cx);
        if view.read(cx).track_gain_focus[0].is_focused(w) {
            return Ok(());
        }
        key(w, cx, "tab");
    }
    anyhow::bail!("Actual Tab did not reach the vocal range control")
}
fn click_stem_gain(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    value: f32,
) -> anyhow::Result<()> {
    super::ui_training_run::draw(w, cx);
    let b = view
        .read(cx)
        .track_bounds
        .borrow()
        .get("gain-0")
        .copied()
        .ok_or_else(|| anyhow::anyhow!("Vocal range control was not drawn"))?;
    anyhow::ensure!(
        b.top() >= px(0.) && b.bottom() <= w.viewport_size().height,
        "Vocal range control clipped"
    );
    let position = point(
        b.left() + px(5.5) + (b.size.width - px(11.)) * value,
        b.center().y,
    );
    super::ui_training_run::click(w, cx, position);
    Ok(())
}
fn state(p: &Player, w: &Window, cx: &App) -> serde_json::Value {
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),
        "hidden":!w.is_visible()&&!w.is_window_active(),"playerScreen":p.screen==Screen::Player,"position":p.position,"playing":p.playing,
        "rootFocused":p.focus_handle.is_focused(w),"headerFocused":p.header.read(cx).focused_control(w),"masterVolume":p.master_volume,
        "stemGain":p.gain[0],"stemFocused":p.track_gain_focus[0].is_focused(w),"nativeStemGain":native_gain(p),
        "stemMuted":p.muted[0],"stemSolo":p.solo[0],"nativeStemMix":native_mix(p),
        "stemMixFocused":[p.track_mix_focus[0][0].is_focused(w),p.track_mix_focus[0][1].is_focused(w)],
        "mixerResetFocused":[p.track_reset_focus[0].is_focused(w),p.track_reset_focus[1].is_focused(w)],
        "mixerResetEnabled":[p.muted.iter().any(|v|*v),p.solo.iter().any(|v|*v)],
        "trackHeaderFocused":[p.track_header_focus[0].is_focused(w),p.track_header_focus[1].is_focused(w)],
        "epoch":p.native_epoch,"seekCount":p.native_seek_count,"native":p.last_playback_status.as_ref().map(|s|serde_json::json!({"playing":s.playing,"position":s.position})),
        "spaceOrigin":"header-log reached through actual Tab","liveFps":"unmeasured","productionParity":"input behavior only; matched reference capture pending"})
}
pub fn run(
    handle: AnyWindowHandle,
    view: Entity<Player>,
    project: PathBuf,
    out: PathBuf,
    cx: &mut App,
) -> mpsc::Receiver<Result<(), String>> {
    let (tx, rx) = mpsc::channel();
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"Keyboard test requires hidden/muted execution");
            let project=project.canonicalize()?;
            std::fs::create_dir_all(&out)?;
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(15);
                loop {cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|->anyhow::Result<bool>{super::ui_training_run::draw($w,$app);let $p=view.read($app);
                        anyhow::ensure!(!$w.is_visible()&&!$w.is_window_active()&&$p.notice.is_none(),"Keyboard test activated window or raised notice: {:?}",$p.notice);
                        Ok($condition)})??;
                    if ready {break;}
                    if Instant::now()>=deadline {let evidence=handle.update(cx,|_,w,app|state(view.read(app),w,app))?;anyhow::bail!("Keyboard timeout {}: {evidence}",stringify!($condition));}
                }
            }};}
            let (original_gain,original_stem_gain,original_muted,original_solo,original_name,original_epoch)=handle.update(cx,|_,w,cx|->anyhow::Result<(f32,u8,bool,bool,String,u64)>{
                let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Player&&!p.playing&&p.project.as_ref().is_some_and(|s|s.dir==project)
                    &&p.region_target().selection.is_none()&&p.position.abs()<0.03
                    &&p.view_start==0.&&p.view_end==1.,"Keyboard baseline is not the private paused full-view song");
                anyhow::ensure!(native_gain(p).is_some(),"Keyboard fixture requires the real vocals lane");
                anyhow::ensure!(native_mix(p)==Some((p.muted[0],p.solo[0])),"Keyboard fixture native mute/solo must match the host baseline");
                let baseline=(p.master_volume,p.gain[0],p.muted[0],p.solo[0],p.project.as_ref().unwrap().name.clone(),p.native_epoch);
                let focus=p.focus_handle.clone();focus.focus(w,cx);Ok(baseline)
            })??;
            let mut cases=Vec::new();
            let mut stem_receipts=Vec::new();
            let mut mix_receipts=Vec::new();
            let mut reset_receipts=Vec::new();
            let mut track_header_receipts=Vec::new();
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                handle.update(cx,|_,w,cx|tab_header(&view,w,cx,"header-log"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.screen==Screen::Player&&p.playing&&p.native_play_intent.is_none()
                    &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(w,cx);let p=view.read(cx);
                    anyhow::ensure!(p.focus_handle.is_focused(w)&&p.header.read(cx).focused_control(w).is_none(),"Space did not blur the activatable button");
                    let value=state(p,w,cx);let name=format!("keyboard-focused-{}",width as u32);
                    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")),serde_json::to_vec_pretty(&value)?)?;cases.push(value);Ok(())
                })??;
                handle.update(cx,|_,w,cx|tab_header(&view,w,cx,"header-log"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.screen==Screen::Player&&!p.playing&&p.native_play_intent.is_none()
                    &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                handle.update(cx,|_,w,cx|tab_header(&view,w,cx,"header-log"))??;
                let (position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count)})?;
                handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                wait!(p,w,app => !p.playing&&p.pending_seek.is_none()&&p.native_seek_count>count&&(p.position-(position+5.).min(p.duration)).abs()<0.03);
                handle.update(cx,|_,w,cx|key(w,cx,"left"))?;
                wait!(p,w,app => p.pending_seek.is_none()&&(p.position-position).abs()<0.03);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    anyhow::ensure!(view.read(cx).header.read(cx).focused_control(w).as_deref()==Some("header-log"),"Arrows unexpectedly blurred button focus");
                    key(w,cx,"enter");Ok(())
                })??;
                wait!(p,w,app => p.screen==Screen::Log);
                let count=handle.update(cx,|_,_,cx|view.read(cx).native_seek_count)?;
                handle.update(cx,|_,w,cx|{key(w,cx,"space");key(w,cx,"right");})?;
                wait!(p,w,app => p.screen==Screen::Log&&!p.playing&&p.native_seek_count==count);
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => p.screen==Screen::Player);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    super::ui_training_run::draw(w,cx);let h=view.read(cx).header.clone();
                    let b=h.read(cx).rename_bounds.get().ok_or_else(||anyhow::anyhow!("Title pencil missing"))?;
                    super::ui_training_run::click(w,cx,b.center());Ok(())
                })??;
                wait!(p,w,app => p.header.read(app).is_editing()&&p.header.read(app).title_input_focused(w,app));
                let (before,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.header.read(cx).title_state().read(cx).value().to_string(),p.native_seek_count)})?;
                handle.update(cx,|_,w,cx|{
                    key(w,cx,"right");
                    let mut stroke=Keystroke::parse("space").unwrap();stroke.key_char=Some(" ".into());w.dispatch_keystroke(stroke,cx);key(w,cx,"left");
                })?;
                wait!(p,w,app => !p.playing&&p.native_seek_count==count&&p.header.read(app).is_editing()
                    &&p.header.read(app).title_state().read(app).value().len()==before.len()+1);
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => !p.header.read(app).is_editing()&&p.project.as_ref().unwrap().name==original_name);
                for button in 0..2 {
                    // Keep each real five-second seek away from the fixture's
                    // end; Tab traversal during the preceding Play can advance.
                    handle.update(cx,|_,w,cx|click_transport(&view,w,cx,"transport-restart"))??;
                    wait!(p,w,app => !p.playing&&p.pending_seek.is_none()&&p.position.abs()<0.03);
                    let changed=if button==0 {(!original_muted,original_solo)} else {(original_muted,!original_solo)};
                    let baseline=(original_muted,original_solo);
                    handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;
                    wait!(p,w,app => !p.track_mix_focus[0][button].is_focused(w));
                    handle.update(cx,|_,w,cx|click_stem_mix(&view,w,cx,button))??;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)
                        &&(p.muted[0],p.solo[0])==changed&&native_mix(p)==Some(changed));
                    mix_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"pointer-toggle","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)
                        &&(p.muted[0],p.solo[0])==baseline&&native_mix(p)==Some(baseline));
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)
                        &&(p.muted[0],p.solo[0])==changed&&native_mix(p)==Some(changed));
                    mix_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"enter-toggle","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&(p.muted[0],p.solo[0])==changed&&native_mix(p)==Some(changed)
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                    handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&(p.muted[0],p.solo[0])==changed&&native_mix(p)==Some(changed)
                        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                    mix_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"space-pauses-without-toggle","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                    let (position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count)})?;
                    handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)&&!p.playing&&p.pending_seek.is_none()
                        &&p.native_seek_count>count&&(p.position-(position+5.).min(p.duration)).abs()<0.03);
                    handle.update(cx,|_,w,cx|key(w,cx,"left"))?;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)&&p.pending_seek.is_none()
                        &&(p.position-position).abs()<0.03&&(p.muted[0],p.solo[0])==changed&&native_mix(p)==Some(changed));
                    mix_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"arrows-seek-with-focus","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.track_mix_focus[0][button].is_focused(w)
                        &&(p.muted[0],p.solo[0])==baseline&&native_mix(p)==Some(baseline));
                }
                for button in 0..2 {
                    // Keep each real five-second seek away from the fixture's
                    // end; Tab traversal during the preceding Play can advance.
                    handle.update(cx,|_,w,cx|click_transport(&view,w,cx,"transport-restart"))??;
                    wait!(p,w,app => !p.playing&&p.pending_seek.is_none()&&p.position.abs()<0.03);
                    let original_on=if button==0 {original_muted} else {original_solo};
                    let enabled=if button==0 {(true,original_solo)} else {(original_muted,true)};
                    let cleared=if button==0 {(false,original_solo)} else {(original_muted,false)};
                    if !original_on {
                        handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    }
                    wait!(p,w,app => (p.muted[0],p.solo[0])==enabled&&native_mix(p)==Some(enabled));
                    handle.update(cx,|_,w,cx|tab_mix_reset(&view,w,cx,button))??;
                    let (position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count)})?;
                    handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                    wait!(p,w,app => p.track_reset_focus[button].is_focused(w)&&!p.playing&&p.pending_seek.is_none()
                        &&p.native_seek_count>count&&(p.position-(position+5.).min(p.duration)).abs()<0.03);
                    handle.update(cx,|_,w,cx|key(w,cx,"left"))?;
                    wait!(p,w,app => p.track_reset_focus[button].is_focused(w)&&p.pending_seek.is_none()
                        &&(p.position-position).abs()<0.03&&(p.muted[0],p.solo[0])==enabled&&native_mix(p)==Some(enabled));
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&(p.muted[0],p.solo[0])==enabled&&native_mix(p)==Some(enabled)
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                    handle.update(cx,|_,w,cx|tab_mix_reset(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&(p.muted[0],p.solo[0])==enabled&&native_mix(p)==Some(enabled)
                        &&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                    reset_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"space-and-arrows-preserve-enabled-reset","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|tab_mix_reset(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => !p.track_reset_focus[button].is_focused(w)&&p.focus_handle.is_focused(w)
                        &&(p.muted[0],p.solo[0])==cleared&&native_mix(p)==Some(cleared));
                    reset_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"enter-resets-native-and-recovers-root-focus","state":state(view.read(cx),w,cx)}))?);
                    handle.update(cx,|_,w,cx|assert_reset_skipped(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => (p.muted[0],p.solo[0])==enabled&&native_mix(p)==Some(enabled));
                    handle.update(cx,|_,w,cx|click_mix_reset(&view,w,cx,button))??;
                    wait!(p,w,app => p.focus_handle.is_focused(w)&&(p.muted[0],p.solo[0])==cleared&&native_mix(p)==Some(cleared));
                    reset_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"pointer-resets-native-and-recovers-root-focus","state":state(view.read(cx),w,cx)}))?);
                    if original_on {
                        handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,button))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    }
                    wait!(p,w,app => (p.muted[0],p.solo[0])==(original_muted,original_solo)
                        &&native_mix(p)==Some((original_muted,original_solo)));
                }
                for button in 0..2 {
                    // Keep each real five-second seek away from the fixture's
                    // end; Tab traversal during the preceding Play can advance.
                    handle.update(cx,|_,w,cx|click_transport(&view,w,cx,"transport-restart"))??;
                    wait!(p,w,app => !p.playing&&p.pending_seek.is_none()&&p.position.abs()<0.03);
                    handle.update(cx,|_,w,cx|tab_track_header(&view,w,cx,button))??;
                    let (position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count)})?;
                    handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                    wait!(p,w,app => p.track_header_focus[button].is_focused(w)&&!p.playing&&p.pending_seek.is_none()
                        &&p.native_seek_count>count&&(p.position-(position+5.).min(p.duration)).abs()<0.03);
                    handle.update(cx,|_,w,cx|key(w,cx,"left"))?;
                    wait!(p,w,app => p.track_header_focus[button].is_focused(w)&&p.pending_seek.is_none()&&(p.position-position).abs()<0.03);
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&!p.stem_export_open&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                    handle.update(cx,|_,w,cx|tab_track_header(&view,w,cx,button))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)
                        &&!p.stem_export_open&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                    track_header_receipts.push(handle.update(cx,|_,w,cx|serde_json::json!({"button":button,"phase":"tab-space-arrows","state":state(view.read(cx),w,cx)}))?);
                    // Enter on Add is intentionally excluded: that is the OS
                    // chooser path. Export opens an app-owned dialog only.
                    if button==1 {
                        handle.update(cx,|_,w,cx|tab_track_header(&view,w,cx,button))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => p.stem_export_open&&!p.playing&&p.stem_export_job.is_none());
                        handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                        wait!(p,w,app => !p.stem_export_open&&!p.playing&&p.stem_export_job.is_none());
                    }
                }
                handle.update(cx,|_,w,cx|tab_stem_gain(&view,w,cx))??;
                handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;
                wait!(p,w,app => !p.track_gain_focus[0].is_focused(w));
                handle.update(cx,|_,w,cx|click_stem_gain(&view,w,cx,0.5))??;
                wait!(p,w,app => p.track_gain_focus[0].is_focused(w)&&p.gain[0]==50
                    &&native_gain(p).is_some_and(|gain|(gain-0.5).abs()<0.00001));
                let seek_count=handle.update(cx,|_,_,cx|view.read(cx).native_seek_count)?;
                // All three events use one rendered control instance. A stale
                // captured value would emit .51 three times rather than .53.
                handle.update(cx,|_,w,cx|{for _ in 0..3 {key(w,cx,"right");}})?;
                wait!(p,w,app => p.gain[0]==53&&p.native_seek_count==seek_count
                    &&native_gain(p).is_some_and(|gain|(gain-0.53).abs()<0.00001));
                stem_receipts.push(handle.update(cx,|_,w,cx|state(view.read(cx),w,cx))?);
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.track_gain_focus[0].is_focused(w)
                    &&p.gain[0]==53&&p.native_seek_count==seek_count&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.track_gain_focus[0].is_focused(w)
                    &&p.gain[0]==53&&p.native_seek_count==seek_count&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                handle.update(cx,|_,w,cx|{key(w,cx,"home");key(w,cx,"left");})?;
                wait!(p,w,app => p.gain[0]==0&&p.native_seek_count==seek_count
                    &&native_gain(p).is_some_and(|gain|gain==0.));
                handle.update(cx,|_,w,cx|{key(w,cx,"end");key(w,cx,"right");})?;
                wait!(p,w,app => p.gain[0]==100&&p.native_seek_count==seek_count
                    &&native_gain(p).is_some_and(|gain|gain==1.));
                handle.update(cx,|_,w,cx|click_stem_gain(&view,w,cx,original_stem_gain as f32/100.))??;
                wait!(p,w,app => p.gain[0]==original_stem_gain&&p.native_seek_count==seek_count
                    &&native_gain(p).is_some_and(|gain|(gain-original_stem_gain as f32/100.).abs()<0.00001));
                handle.update(cx,|_,w,cx|click_transport(&view,w,cx,"transport-output"))??;
                wait!(p,w,app => p.transport.read(app).has_popover());
                let (gain,position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.master_volume,p.position,p.native_seek_count)})?;
                handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                wait!(p,w,app => (p.master_volume-gain).abs()>0.001&&p.native_seek_count==count&&(p.position-position).abs()<0.03);
                let gain=handle.update(cx,|_,_,cx|view.read(cx).master_volume)?;
                handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                wait!(p,w,app => !p.playing&&(p.master_volume-gain).abs()<0.00001&&p.native_seek_count==count);
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => !p.transport.read(app).has_popover());
                // Restore the accepted, possibly off-grid gain through its real
                // production controller event rather than assigning UI state.
                handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Volume(original_gain))))?;
                handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_native_mix(original_gain,cx)))?;
                wait!(p,w,app => (p.master_volume-original_gain).abs()<0.00001
                    &&p.transport.read(app).output_state()["gain"].as_f64().is_some_and(|gain|(gain-original_gain as f64).abs()<0.00001));
                handle.update(cx,|_,w,cx|click_transport(&view,w,cx,"transport-restart"))??;
                wait!(p,w,app => p.pending_seek.is_none()&&p.position.abs()<0.03&&!p.playing);
                handle.update(cx,|_,w,cx|tab_header(&view,w,cx,"header-save"))??;
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq);
            }
            if std::env::var("SINGZ_GPUI_TEST_FOOTER_KEYBOARD").as_deref()==Ok("1") {
                anyhow::ensure!(std::env::var("SINGZ_GPUI_TEST_KARAOKE").as_deref()==Ok("1"),"Footer regression requires the local saved-lyrics Karaoke fixture");
                let mut receipts=vec![];let mut preparations=vec![];
                for(width,height)in[(1280.,800.),(1060.,640.)]{
                    handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                    wait!(p,w,app => w.viewport_size()==size(px(width),px(height)));
                    let (tempo,transpose,looping,karaoke,met,beats)=handle.update(cx,|_,_,cx|{let p=view.read(cx);
                        (p.tempo,p.transpose,p.looping,p.karaoke,p.metronome.clone(),p.beats.clone())})?;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-play"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{super::ui_training_run::draw(w,cx);
                        anyhow::ensure!(view.read(cx).transport.read(cx).focused_control(w).as_deref()!=Some("transport-play"),"Footer ShiftTab did not leave Play");Ok(())})??;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-play"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-play"))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)&&p.last_playback_status.as_ref().is_some_and(|s|s.playing));
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-play"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => !p.playing&&p.native_play_intent.is_none()&&p.focus_handle.is_focused(w)&&p.last_playback_status.as_ref().is_some_and(|s|!s.playing));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"footer-space-no-keyup-double"))?);
                    let count=handle.update(cx,|_,_,cx|view.read(cx).native_seek_count)?;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-restart"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.pending_seek.is_none()&&p.native_seek_count>count&&p.position.abs()<0.03&&!p.playing);
                    for target in [!looping,looping]{
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-loop"))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => !p.region_busy()&&p.looping==target&&p.last_playback_status.as_ref().is_some_and(|s|
                            if target{s.loop_range.is_some_and(|(start,end)|start.abs()<0.03&&(end-p.duration).abs()<0.03)}else{s.loop_range.is_none()}));
                        receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-loop"))?);
                    }
                    for target in [!karaoke,karaoke]{
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-karaoke"))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => p.karaoke==target&&(!target||native_mix(p).is_some_and(|(muted,_)|muted)));
                        receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-karaoke"))?);
                    }
                    if handle.update(cx,|_,_,cx|view.read(cx).muted[0])?!=original_muted{
                        handle.update(cx,|_,w,cx|tab_stem_mix(&view,w,cx,0))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => p.muted[0]==original_muted&&native_mix(p)==Some((original_muted,original_solo)));
                    }
                    // Restore every accepted rate change before the next one;
                    // no cached UI value stands in for a native graph receipt.
                    for(id,target)in[("transport-transpose-up",transpose+1),("transport-transpose-down",transpose)]{
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,id))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => !p.rate_busy()&&p.transpose==target&&p.last_playback_status.as_ref().is_some_and(|s|s.transpose==target));
                        receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-transpose"))?);
                    }
                    for(id,target)in[("transport-tempo-up",(tempo+0.05).min(1.5)),("transport-tempo-down",tempo)]{
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,id))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => !p.rate_busy()&&(p.tempo-target).abs()<0.0001&&p.last_playback_status.as_ref().is_some_and(|s|(s.rate-target).abs()<0.0001));
                        receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-tempo"))?);
                    }
                    if beats.is_none(){
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{view.update(cx,|p,cx|->anyhow::Result<()>{
                            let grid=beat::Beats::constant(120.,0.,p.duration as f64,4)?;p.apply_beat_grid(grid,false,cx);Ok(())})})??;
                        wait!(p,w,app => p.metronome_pending.is_none()&&p.beats.as_ref().is_some_and(|g|g.bpm==120.));
                        preparations.push(serde_json::json!({"viewport":[width,height],"fixtureOnly":true,"kind":"missing-beat-grid","method":"constant120BPM through actual native metronome transaction; restored after BPM keys"}));
                    }
                    let base=handle.update(cx,|_,_,cx|view.read(cx).beats.as_ref().unwrap().bpm as f32)?;
                    for(id,step)in[("transport-bpm-up",1.),("transport-bpm-down",-1.)]{
                        let target=handle.update(cx,|_,_,cx|((base*view.read(cx).tempo).round()+step)/base)?;
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,id))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => !p.rate_busy()&&(p.tempo-target).abs()<0.0002&&p.last_playback_status.as_ref().is_some_and(|s|(s.rate-target).abs()<0.0002));
                        receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"enter-bpm-step"))?);
                    }
                    // A source tempo reset is keyboard-reachable and returns
                    // to unity. The graph fixture starts at unity by contract.
                    anyhow::ensure!((tempo-1.).abs()<0.0001,"Footer fixture must begin at unity tempo");
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-tempo-reset"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => !p.rate_busy()&&(p.tempo-tempo).abs()<0.0001&&p.last_playback_status.as_ref().is_some_and(|s|(s.rate-tempo).abs()<0.0001));
                    for(id,met_popup)in[("transport-met",true),("transport-carry",false)]{
                        handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,id))??;
                        handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                        wait!(p,w,app => if met_popup{p.metronome_open}else{p.carry_open});
                        handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                        wait!(p,w,app => !p.metronome_open&&!p.carry_open);
                    }
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-output"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.transport.read(app).output_state()["open"]==true);
                    let (position,count,gain)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count,p.master_volume)})?;
                    handle.update(cx,|_,w,cx|{key(w,cx,"right");key(w,cx,"space");})?;
                    wait!(p,w,app => !p.playing&&p.native_seek_count==count&&(p.position-position).abs()<0.03&&(p.master_volume-gain).abs()>0.001);
                    let previous_gain=handle.update(cx,|_,_,cx|view.read(cx).master_volume)?;
                    handle.update(cx,|_,w,cx|tab_output_control(&view,w,cx,1))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.master_volume==0.&&!p.playing&&p.native_seek_count==count&&(p.position-position).abs()<0.03
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.observed_master_gain.is_some_and(|gain|gain.abs()<0.00001)));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"output-popup-mute-enter"))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => (p.master_volume-previous_gain).abs()<0.00001&&!p.playing&&p.native_seek_count==count&&(p.position-position).abs()<0.03
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.observed_master_gain.is_some_and(|gain|gain.abs()<0.00001)));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"output-popup-unmute-space"))?);
                    handle.update(cx,|_,w,cx|tab_output_control(&view,w,cx,2))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => (p.master_volume-1.).abs()<0.00001&&!p.playing&&p.native_seek_count==count&&(p.position-position).abs()<0.03
                        &&p.last_playback_status.as_ref().is_some_and(|s|s.observed_master_gain.is_some_and(|gain|gain.abs()<0.00001)));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"output-popup-unity-enter"))?);
                    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                    wait!(p,w,app => !p.transport.read(app).has_popover());
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|_,cx|cx.emit(transport::TransportEvent::Volume(original_gain))))?;
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_native_mix(original_gain,cx)))?;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-play"))??;
                    handle.update(cx,|_,w,cx|footer_capture(&view,w,cx,&out,&format!("footer-focused-{}",width as u32)))??;
                    // Explicit UI-only eligibility fixture: neither menu item
                    // launches here; a real enabled action is exercised below.
                    let eligibility=handle.update(cx,|_,_,cx|{let p=view.read(cx);let project=p.project.as_ref().unwrap();
                        (!project.original,project.raw["songFile"].is_string(),!project.original&&project.lanes.iter().any(|(slot,_)|*slot==0)&&project.raw["settings"]["leadVocalSeparated"]!=true)})?;
                    // Explicit unmount fixtures exercise focus handoff only;
                    // every song/controller action above and below stays real.
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-karaoke"))??;
                    handle.update(cx,|_,w,cx|{view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(false,false,false,cx));super::ui_training_run::draw(w,cx);})?;
                    wait!(p,w,app => p.focus_handle.is_focused(w)&&p.transport.read(app).focused_control(w).is_none());
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"fixture-removed-footer-recovers-root"))?);
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(eligibility.0,eligibility.1,eligibility.2,cx)))?;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-karaoke"))??;
                    let (pending_handoff,settled_handoff)=handle.update(cx,|_,w,cx|->anyhow::Result<_>{
                        let play=view.read(cx).transport.read(cx).bounds("transport-play").ok_or_else(||anyhow::anyhow!("Play bounds missing before child-render ordering fixture"))?;
                        // Explicit ordering fixture: run the production child
                        // render before its parent can consume the real recovery
                        // handoff. A window draw may render the parent twice.
                        view.read(cx).transport.clone().update(cx,|s,cx|{
                            s.set_split_state(false,false,false,cx);
                            let _=s.render(w,cx);
                        });
                        let mut before=footer_state(view.read(cx),w,cx,"fixture-stale-handoff-pending-before-pointer");
                        before["windowFocusedDebug"]=serde_json::json!(format!("{:?}",w.focused(cx)));
                        anyhow::ensure!(before["keyboard"]["recoveryPending"]==true&&before["keyboard"]["footerScopeFocused"]==true&&before["keyboard"]["focusedControl"].is_null(),"Unmount did not expose a real pending footer handoff: {before}");
                        // Keyboard dispatch pre-paints dirty windows. Pointer
                        // dispatch can focus a live control before parent paint;
                        // release outside cancels the click instead of playing.
                        w.dispatch_event(PlatformInput::MouseDown(MouseDownEvent{position:play.center(),button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                        let outside=point(px(12.),px(120.));
                        w.dispatch_event(PlatformInput::MouseMove(MouseMoveEvent{position:outside,pressed_button:Some(MouseButton::Left),modifiers:Modifiers::default()}),cx);
                        w.dispatch_event(PlatformInput::MouseUp(MouseUpEvent{position:outside,button:MouseButton::Left,click_count:1,..Default::default()}),cx);
                        let target=w.focused(cx).ok_or_else(||anyhow::anyhow!("Actual pointer left no focus; before={before}; after={}",footer_state(view.read(cx),w,cx,"fixture-pointer-no-focus")))?;
                        let target_debug=format!("{target:?}");
                        let mut after_pointer=footer_state(view.read(cx),w,cx,"fixture-stale-handoff-target-before-parent");
                        after_pointer["targetFocusedDebug"]=serde_json::json!(target_debug);
                        after_pointer["pointerPress"]=serde_json::json!([f32::from(play.center().x),f32::from(play.center().y)]);
                        after_pointer["pointerRelease"]=serde_json::json!([12,120]);
                        anyhow::ensure!(after_pointer["keyboard"]["footerScopeFocused"]==false&&after_pointer["keyboard"]["focusedControl"]=="transport-play"&&after_pointer["keyboard"]["recoveryPending"]==true&&!view.read(cx).focus_handle.is_focused(w)&&!view.read(cx).playing&&view.read(cx).native_play_intent.is_none(),"Actual pointer did not focus Play before the pending footer handoff; before={before}; after={after_pointer}");
                        view.update(cx,|_,cx|cx.notify());
                        super::ui_training_run::draw(w,cx);
                        let mut after=footer_state(view.read(cx),w,cx,"fixture-stale-handoff-preserves-pointer");
                        after["targetFocusedDebug"]=serde_json::json!(target_debug);
                        after["targetStillFocused"]=serde_json::json!(target.is_focused(w));
                        after["headerFocused"]=serde_json::json!(view.read(cx).header.read(cx).focused_control(w));
                        after["beforeParent"]=after_pointer;
                        anyhow::ensure!(after["keyboard"]["recoveryPending"]==false&&after["keyboard"]["lastFocusRecoveryScopeOwned"]==false&&target.is_focused(w)&&!view.read(cx).focus_handle.is_focused(w)&&!view.read(cx).playing&&view.read(cx).native_play_intent.is_none(),"Stale footer recovery did not consume its scope guard without stealing actual pointer focus: {after}");
                        Ok((before,after))})??;
                    receipts.extend([pending_handoff,settled_handoff]);
                    preparations.push(serde_json::json!({"viewport":[width,height],"fixtureOnly":true,"kind":"focused-footer-unmount","method":"set_split_state(false) removes focused Karaoke; root recovery then explicit production child-before-parent render ordering tests real pending handoff with actual pointer press on Play and drag/release outside cancelling activation","naturalDisplayRaceTested":false,"operationStarted":false}));
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(eligibility.0,eligibility.1,eligibility.2,cx)))?;
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(true,true,false,cx)))?;
                    preparations.push(serde_json::json!({"viewport":[width,height],"fixtureOnly":true,"kind":"menu-eligibility","split":true,"resplit":true,"backing":false,"operationStarted":false}));
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-split"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.transport.read(app).split_focused(w,app));
                    let (position,count)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.position,p.native_seek_count)})?;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        anyhow::ensure!(view.read(cx).transport.read(cx).focused_control(w).as_deref()==Some("split-stems"),"Split opening did not focus the first enabled action");Ok(())})??;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{for stroke in ["home","down","end","up","tab","shift-tab","right","left"]{
                        key(w,cx,stroke);super::ui_training_run::draw(w,cx);let state=view.read(cx).transport.read(cx).keyboard_state(w,cx);
                        anyhow::ensure!(state["focusedControl"]=="split-stems","Disabled split action received keyboard focus after {stroke}; rawFocus={:?}; keyboard={state}",w.focused(cx));}Ok(())})??;
                    wait!(p,w,app => !p.playing&&p.native_seek_count==count&&(p.position-position).abs()<0.03&&p.source_job.is_none());
                    handle.update(cx,|_,w,cx|footer_capture(&view,w,cx,&out,&format!("footer-split-{}",width as u32)))??;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(true,false,false,cx));
                        super::ui_training_run::draw(w,cx);let state=view.read(cx).transport.read(cx).keyboard_state(w,cx);
                        anyhow::ensure!(state["splitFocused"]==true&&state["focusedControl"].is_null()&&state["splitFocusOrder"]==serde_json::json!([]),"Disabled menu did not recover its owned scope: {state}");
                        key(w,cx,"space");Ok(())})??;
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"fixture-disabled-menu-recovers-scope"))?);
                    preparations.push(serde_json::json!({"viewport":[width,height],"fixtureOnly":true,"kind":"focused-menu-disable","resplit":false,"backing":false,"operationStarted":false}));
                    handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                    wait!(p,w,app => !p.transport.read(app).split_open()&&!p.playing&&p.native_seek_count==count&&p.transport.read(app).focused_control(w).as_deref()==Some("transport-split"));
                    handle.update(cx,|_,_,cx|view.read(cx).transport.clone().update(cx,|s,cx|s.set_split_state(eligibility.0,eligibility.1,eligibility.2,cx)))?;
                    let (metadata,audio,epoch)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);let project=p.project.as_ref().unwrap();
                        Ok((std::fs::read(project.dir.join("project.json"))?,std::fs::read(project.lanes.iter().find(|(slot,_)|*slot==0).unwrap().1.clone())?,p.native_epoch))})??;
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-split"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.transport.read(app).split_focused(w,app));
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"split-vocals"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"space"))?;
                    wait!(p,w,app => p.source_job.is_none()&&(p.engine_setup.read(app).is_open()||p.screen==Screen::Models));
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"actual-split-missing-engine-refusal"))?);
                    handle.update(cx,|_,w,cx|close_split_refusal(&view,w,cx))??;
                    wait!(p,w,app => p.screen==Screen::Player&&!p.engine_setup.read(app).is_open()&&p.source_job.is_none()&&p.native_epoch==epoch);
                    handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let project=p.project.as_ref().unwrap();
                        anyhow::ensure!(std::fs::read(project.dir.join("project.json"))?==metadata&&std::fs::read(project.lanes.iter().find(|(slot,_)|*slot==0).unwrap().1.clone())?==audio,"Refused Split changed original project/audio");Ok(())})??;
                    handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.apply_metronome(met.clone(),beats.clone(),cx)))?;
                    wait!(p,w,app => p.metronome_pending.is_none()&&p.metronome==met&&p.beats==beats&&!p.playing&&p.karaoke==karaoke);
                    handle.update(cx,|_,w,cx|tab_footer(&view,w,cx,"transport-restart"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => p.pending_seek.is_none()&&p.position.abs()<0.03&&!p.playing);
                    handle.update(cx,|_,w,cx|tab_header(&view,w,cx,"header-save"))??;
                    handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                    wait!(p,w,app => !p.saving&&p.saved_seq==p.edit_seq&&(p.master_volume-original_gain).abs()<0.00001);
                    receipts.push(handle.update(cx,|_,w,cx|footer_state(view.read(cx),w,cx,"footer-baseline-restored"))?);
                }
                std::fs::write(out.join("footer-keyboard.json"),serde_json::to_vec_pretty(&serde_json::json!({
                    "actualTabAndShiftTab":true,"enterPlayPause":true,"enterRestart":true,"nativeLoop":true,"nativeKaraokeMute":true,
                    "nativeTranspose":true,"nativeTempo":true,"nativeBpmSteps":true,"metCarryEnterEscape":true,"outputKeysContained":true,
                    "outputPopupButtonsActivateOnce":true,
                    "outputNativeSilentByFixture":true,"nativePositiveMasterGainTested":false,
                    "outputGainScope":"Host output controls restore positive gain and unity; SINGZ_MUTE=1 clamps actual native song/reference master gain to zero throughout. Positive native master gain and audible output are not tested.",
                    "splitNavigationDisabledSkip":true,"splitEscapeContained":true,"splitActualMissingEngineRefusal":true,"baselineRestored":true,
                    "focusedControlRemovalRecoversRoot":true,"recoveryDoesNotStealLaterPointerFocus":true,"disabledMenuRecoversScope":true,
                    "sizes":[[1280,800],[1060,640]],"receipts":receipts,"fixturePreparations":preparations,"inferenceTested":false,"liveFps":"unmeasured"}))?)?;
            }
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => w.viewport_size()==size(px(1280.),px(800.)));
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);
                anyhow::ensure!(p.native_epoch==original_epoch&&p.project.as_ref().is_some_and(|s|s.dir==project&&s.name==original_name)
                    &&!p.playing&&p.position.abs()<0.03&&(p.master_volume-original_gain).abs()<0.00001
                    &&p.gain[0]==original_stem_gain&&p.muted[0]==original_muted&&p.solo[0]==original_solo
                    &&native_mix(p)==Some((original_muted,original_solo)),"Keyboard journey did not restore its baseline");Ok(())
            })??;
            let (saved,_)=project_store::read(&project,"project.json")?;
            anyhow::ensure!(saved["settings"]["tracks"]["vocals"]["muted"]==original_muted
                &&saved["settings"]["tracks"]["vocals"]["solo"]==original_solo,"Keyboard mixer baseline did not survive Save");
            let mut proof=serde_json::json!({
                "actualTabToButton":true,"spaceFromButtonPlaysPauses":true,"spaceBlursButtonAndKeyupDoesNotActivate":true,
                "arrowsFromButtonSeek":true,"enterStillActivatesLogAndSave":true,"logOwnsTransportKeys":true,
                "titleSpaceAndArrowsStayText":true,"outputDialogSliderOwnsKeys":true,"restoredBaseline":true,
                "stemFaderTabReachable":true,"stemFaderPointerFocus":true,"stemFaderBurstKeysAccumulate":true,
                "stemFaderHomeEndClamp":true,"stemFaderKeysReachNativeGainWithoutSeeking":true,"stemFaderSpaceRetainsFocusAndGain":true,
                "stemReceipts":stem_receipts,
                "cases":cases,"sizes":[[1280,800],[1060,640]],"liveFps":"unmeasured",
                "scope":"actual Tab/keydown/keyup and app-local clicks; Player ordinary buttons, title input, native mute/solo buttons, stem ranges and existing output dialog; native observed mix receipts, no physical microphone/output qualification"
            });
            proof.as_object_mut().unwrap().extend(serde_json::json!({
                "mixerButtonsTabReachable":true,"mixerButtonsPointerFocus":true,"mixerButtonsEnterReachesNativeMuteSolo":true,
                "mixerButtonsSpaceIsTransportOnly":true,"mixerButtonsArrowsSeekWithFocus":true,"mixerButtonsRestoredAndSaved":true,
                "mixerReceipts":mix_receipts,"savedMixer":saved["settings"]["tracks"]["vocals"],
                "mixerResetTabReachable":true,"mixerResetEnterAndPointerReachNative":true,"mixerResetDisabledSkipped":true,
                "mixerResetDisabledFocusReturnsToRoot":true,"mixerResetSpaceIsTransportOnly":true,"mixerResetArrowsSeekWithFocus":true,
                "mixerResetReceipts":reset_receipts
            }).as_object().unwrap().clone());
            proof.as_object_mut().unwrap().extend(serde_json::json!({
                "trackHeaderTabReachable":true,"trackHeaderSpaceIsTransportOnly":true,"trackHeaderArrowsSeekWithFocus":true,
                "trackHeaderExportEnterEscape":true,"trackHeaderAddChooserActivation":"not exercised",
                "trackHeaderReceipts":track_header_receipts
            }).as_object().unwrap().clone());
            std::fs::write(out.join("keyboard.json"),serde_json::to_vec_pretty(&proof)?)?;Ok(())
        }.await;
        let _=tx.send(result.map_err(|error|format!("{error:#}")));
    }).detach();
    rx
}

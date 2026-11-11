//! Hidden real-control metronome checks. No OS input or foreground activation.
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
fn control(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(w, cx);
    let ui = view.read(cx).metronome_ui.clone();
    let b = ui
        .read(cx)
        .bounds
        .borrow()
        .get(id)
        .copied()
        .ok_or_else(|| anyhow::anyhow!("Missing metronome control {id}"))?;
    anyhow::ensure!(
        b.size.width > px(0.)
            && b.size.height > px(0.)
            && b.left() >= px(0.)
            && b.top() >= px(52.)
            && b.right() <= w.viewport_size().width
            && b.bottom() <= w.viewport_size().height,
        "Metronome control {id} outside content viewport: {b:?}"
    );
    click(w, cx, b.center());
    Ok(())
}
fn toggle(view: &Entity<Player>, w: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(w, cx);
    let b = view
        .read(cx)
        .transport
        .read(cx)
        .guides
        .get("metronome")
        .ok_or_else(|| anyhow::anyhow!("Metronome trigger not measured"))?;
    click(w, cx, b.center());
    Ok(())
}
fn type_bpm(view: &Entity<Player>, w: &mut Window, cx: &mut App, value: &str) {
    let input = view.read(cx).metronome_ui.read(cx).input();
    input.update(cx, |s, cx| s.focus(w, cx));
    draw(w, cx);
    // Use the public edit path: set_value intentionally suppresses Change.
    input.update(cx, |s, cx| s.replace_all(value.to_owned(), w, cx));
    draw(w, cx);
}
fn pointer_move(w: &mut Window, cx: &mut App, position: Point<Pixels>, pressed: bool) {
    w.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: pressed.then_some(MouseButton::Left),
            modifiers: Modifiers::default(),
        }),
        cx,
    );
    draw(w, cx);
}
fn pointer_button(w: &mut Window, cx: &mut App, position: Point<Pixels>, down: bool, alt: bool) {
    let modifiers = Modifiers { alt, ..Default::default() };
    let event = if down {
        PlatformInput::MouseDown(MouseDownEvent { position, button: MouseButton::Left, modifiers, click_count: 1, ..Default::default() })
    } else {
        PlatformInput::MouseUp(MouseUpEvent { position, button: MouseButton::Left, modifiers, click_count: 1, ..Default::default() })
    };
    w.dispatch_event(event, cx);
    draw(w, cx);
}
fn bar_point(view: &Entity<Player>, w: &mut Window, cx: &mut App, time: f64) -> anyhow::Result<Point<Pixels>> {
    draw(w,cx);
    let p = view.read(cx);
    let (bounds, handles) = p.beat_handles.read(cx).snapshot();
    let bounds = bounds.ok_or_else(||anyhow::anyhow!("Beat ruler has no measured bounds"))?;
    let handle = handles.iter().find(|handle|(handle.time-time).abs()<1e-6)
        .ok_or_else(||anyhow::anyhow!("No drawn bar handle at {time}s"))?;
    let start = p.view_start * p.duration;
    let span = (p.view_end-p.view_start)*p.duration;
    let scale = w.scale_factor().min(2.);
    let expected_x = (((time-start as f64)/span as f64*f32::from(bounds.size.width) as f64*scale as f64).round()/scale as f64) as f32;
    anyhow::ensure!((handle.x-expected_x).abs()<1e-4,"Bar handle geometry differs from snapped beat time: {} vs {expected_x}",handle.x);
    Ok(point(bounds.left()+px(handle.x),bounds.center().y))
}
fn bar_target(view: &Entity<Player>, cx: &App, time: f64) -> anyhow::Result<Point<Pixels>> {
    let p = view.read(cx);
    let (bounds, _) = p.beat_handles.read(cx).snapshot();
    let bounds = bounds.ok_or_else(||anyhow::anyhow!("Beat ruler has no measured bounds"))?;
    let start = p.view_start * p.duration;
    let span = (p.view_end-p.view_start)*p.duration;
    Ok(point(bounds.left()+bounds.size.width*((time-start as f64)/span as f64) as f32,bounds.center().y))
}
fn paused_unchanged(
    view: &Entity<Player>,
    cx: &App,
    position: f64,
    seeks: u64,
    stage: &str,
) -> anyhow::Result<()> {
    let p = view.read(cx);
    // Two 44.1kHz frames also cover this fixture's 48kHz output rounding.
    let tolerance = 2.0 / 44_100.0;
    anyhow::ensure!(
        !p.playing
            && !p.transport_flight.counting_in
            && p.playhead.pending_seek().is_none()
            && (p.playhead.position() - position).abs() <= tolerance
            && p.playhead.seek_count() == seeks,
        "Paused metronome control {stage} leaked into transport: position {position} -> {}, seeks {seeks} -> {}, pending {:?}, playing {}, count-in {}",
        p.playhead.position(),
        p.playhead.seek_count(),
        p.playhead.pending_seek(),
        p.playing,
        p.transport_flight.counting_in
    );
    Ok(())
}
fn state(view: &Entity<Player>, w: &Window, cx: &App) -> serde_json::Value {
    let p = view.read(cx);
    let popover = p.metronome_ui.read(cx);
    let input = popover.input();
    let mouse = w.mouse_position();
    let controls = p
        .metronome_ui
        .read(cx)
        .bounds
        .borrow()
        .iter()
        .map(|(id, b)| {
            (
                id.clone(),
                serde_json::json!([
                    f32::from(b.left()),
                    f32::from(b.top()),
                    f32::from(b.size.width),
                    f32::from(b.size.height)
                ]),
            )
        })
        .collect::<serde_json::Map<_, _>>();
    serde_json::json!({"viewport":[f32::from(w.viewport_size().width),f32::from(w.viewport_size().height)],"scale":w.scale_factor(),"screen":if p.screen==Screen::Player{"player"}else{"other"},"project":p.project.as_ref().map(|p|p.name.clone()),"popover":p.metronome_open,"metronome":p.metronome,"beat":p.beats,"barGhostTime":p.beat_handles.read(cx).ghost(),"desiredMetronome":popover.met,"desiredBeat":popover.grid,"bpmInputValue":input.read(cx).value().as_str(),"bpmFocused":popover.focused(w,cx),"mousePosition":[f32::from(mouse.x),f32::from(mouse.y)],"windowPresented":w.is_visible(),"windowActive":w.is_window_active(),"position":p.playhead.position(),"playing":p.playing,"countingIn":p.transport_flight.counting_in,"pending":p.metronome_flight.metronome.current_serial(),"notice":p.notice,"controls":controls,"hidden":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),"muted":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),"reference":"candidate; production capture absent"})
}
fn capture(
    view: &Entity<Player>,
    w: &mut Window,
    cx: &mut App,
    out: &std::path::Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(w, cx);
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Metronome capture window became presented or active");
    w.render_to_image()?.save(out.join(format!("{name}.png")))?;
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&state(view, w, cx))?,
    )?;
    Ok(())
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx|{
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let original=PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap());
            let gridless=PathBuf::from(std::env::var_os("SINGZ_GPUI_METRONOME_GRIDLESS").unwrap());
            macro_rules! wait {($predicate:expr)=>{{let deadline=Instant::now()+Duration::from_secs(25);loop{cx.background_executor().timer(Duration::from_millis(25)).await;let ready=handle.update(cx,|_,_,cx|($predicate)(view.read(cx)))?;if ready{break;}anyhow::ensure!(Instant::now()<deadline,"Metronome state timed out: {}",stringify!($predicate));}}};}
            macro_rules! settle {()=>{wait!(|p:&Player|p.metronome_flight.metronome.is_none()&&p.notice.is_none());};}
            macro_rules! shot {($name:expr)=>{{cx.background_executor().timer(Duration::from_millis(1200)).await;handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&$name))??;}};}
            macro_rules! press {($id:expr)=>{{handle.update(cx,|_,w,cx|control(&view,w,cx,$id))??;settle!();}};}
            if std::env::var_os("SINGZ_GPUI_METRONOME_RESTART").is_some(){
                handle.update(cx,|_,w,cx|{w.resize(size(px(1280.),px(800.)));view.update(cx,|p,cx|p.open_project(original.clone(),cx));})?;
                wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|p|p.name=="Metronome fixture"));
                let snapshot=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{
                    draw(w,cx);let p=view.read(cx);let beat=p.beats.as_ref().ok_or_else(||anyhow::anyhow!("Saved beat missing after restart"))?;
                    anyhow::ensure!(p.metronome.grid,"Global grid preference did not survive a fresh process");
                    anyhow::ensure!(!p.metronome.click&&p.metronome.count_in_bars==1&&(p.metronome.volume-0.61).abs()<1e-9&&!p.metronome.accent&&beat.beats_per_bar==3&&beat.downbeat==1&&(beat.bpm-120.).abs()<1e-6,"Fresh process did not restore saved song-specific settings");
                    let raw:serde_json::Value=serde_json::from_slice(&std::fs::read(original.join("project.json"))?)?;
                    anyhow::ensure!(raw["settings"]["metronome"]["grid"]==false,"Restart fixture did not distinguish global grid from song grid");
                    Ok(state(&view,w,cx))
                })??;
                std::fs::write(out.join("restart.state.json"),serde_json::to_vec_pretty(&snapshot)?)?;
                let legacy=PathBuf::from(std::env::var_os("SINGZ_GPUI_METRONOME_LEGACY").unwrap());
                let legacy_raw:serde_json::Value=serde_json::from_slice(&std::fs::read(legacy.join("project.json"))?)?;
                anyhow::ensure!(legacy_raw["settings"].get("metronome").is_none()&&legacy_raw["settings"].get("beat").is_none(),"Legacy fixture unexpectedly contains song-specific metronome settings");
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(legacy.clone(),cx)))?;
                wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|p|p.name=="Legacy fixture"));
                let legacy_snapshot=handle.update(cx,|_,w,cx|->anyhow::Result<serde_json::Value>{
                    draw(w,cx);let p=view.read(cx);
                    anyhow::ensure!(p.metronome.grid&&!p.metronome.click&&p.metronome.count_in_bars==1&&(p.metronome.volume-0.61).abs()<1e-9&&!p.metronome.accent&&p.beats.is_none(),"Legacy song did not inherit the current accepted metronome settings: {:?}",p.metronome);
                    Ok(state(&view,w,cx))
                })??;
                std::fs::write(out.join("legacy.state.json"),serde_json::to_vec_pretty(&legacy_snapshot)?)?;
                std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"restart":true,"globalGridRestored":true,"songSettingsRestored":true,"songGridFalse":true,"legacyInheritsCurrent":true,"hidden":true,"muted":true}))?)?;
                return Ok(());
            }
            for width in [1280.,1060.] {
                let height=if width==1280. {800.}else{640.};
                handle.update(cx,|_,w,cx|{w.resize(size(px(width),px(height)));view.update(cx,|p,cx|p.open_project(original.clone(),cx));})?;
                wait!(|p:&Player|!p.loading&&p.project.is_some()&&p.song_title.as_str()=="Metronome fixture");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.metronome.click&&p.metronome.count_in_bars==1&&(p.metronome.volume-0.3).abs()<1e-8&&!p.metronome.accent&&p.beats.as_ref().is_some_and(|g|(g.bpm-300.).abs()<1e-6&&g.source=="auto"),"Saved metronome was not restored: {:?} {:?}",p.metronome,p.beats);Ok(())})??;
                let (paused_position,paused_seeks,closed_graph,closed_edit_seq)=handle.update(cx,|_,_,cx|->anyhow::Result<_>{let p=view.read(cx);anyhow::ensure!(!p.playing&&p.playhead.pending_seek().is_none()&&p.playhead.position().abs()<=2.0/44_100.0,"Paused source fixture did not open at zero");Ok((p.playhead.position(),p.playhead.seek_count(),p.native_graph,p.edit_seq))})??;
                macro_rules! paused_check {($stage:expr)=>{{handle.update(cx,|_,_,cx|paused_unchanged(&view,cx,paused_position,paused_seeks,$stage))??;}};}
                macro_rules! paused_press {($id:expr)=>{{press!($id);paused_check!($id);}};}
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();paused_check!("open");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.metronome_open,"Metronome trigger did not open popover");anyhow::ensure!(p.native_graph==closed_graph&&p.edit_seq==closed_edit_seq,"Opening the metronome rebuilt audio or marked the song dirty");Ok(())})??;
                paused_press!("met-grid-0");shot!(format!("initial-{width}"));paused_check!("initial capture");
                let off=handle.update(cx,|_,w,cx|->anyhow::Result<_>{draw(w,cx);Ok(w.render_to_image()?)})??;
                paused_press!("met-grid-1");shot!(format!("grid-{width}"));paused_check!("grid capture");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let on=w.render_to_image()?;let scale=w.scale_factor();let crop=|im:&image::RgbaImage|image::imageops::crop_imm(im,(260.*scale) as u32,(110.*scale) as u32,(140.*scale) as u32,(120.*scale) as u32).to_image();anyhow::ensure!(crop(&off)!=crop(&on),"Grid toggle changed controls but did not paint waveform lines");Ok(())})??;
                // Drag the actual measured ruler handle, not a direct domain
                // call. During movement only the ghost may change; accepted
                // audio/grid state changes once the pointer is released.
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;
                let before_bars=handle.update(cx,|_,_,cx|view.read(cx).beats.clone().unwrap())?;
                let before_bar_click=handle.update(cx,|_,_,cx|view.read(cx).edit_seq)?;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{let position=bar_point(&view,w,cx,2.)?;pointer_move(w,cx,position,false);pointer_button(w,cx,position,true,false);pointer_button(w,cx,position,false,false);Ok(())})??;
                paused_check!("bar click");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.edit_seq==before_bar_click&&p.beats.as_ref()==Some(&before_bars)&&p.metronome_flight.metronome.is_none(),"Stationary bar click marked the project dirty or changed its grid");Ok(())})??;
                let bar_end=handle.update(cx,|_,w,cx|->anyhow::Result<_>{
                    let start=bar_point(&view,w,cx,2.)?;let mut end=bar_target(&view,cx,2.2)?;end.y+=px(30.);
                    pointer_move(w,cx,start,false);pointer_button(w,cx,start,true,false);
                    for step in 1..=4 {pointer_move(w,cx,start+(end-start)*(step as f32/4.),true);}
                    Ok(end)
                })??;
                paused_check!("bar drag preview");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.metronome_flight.metronome.is_none()&&p.beats.as_ref()==Some(&before_bars)&&p.beat_handles.read(cx).ghost().is_some_and(|time|(time-2.2).abs()<1e-6),"Dragging did not retain a snapped preview without changing accepted grid");Ok(())})??;
                shot!(format!("bar-ghost-{width}"));
                handle.update(cx,|_,w,cx|pointer_button(w,cx,bar_end,false,false))?;settle!();paused_check!("bar drag release");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    let p=view.read(cx);let g=p.beats.as_ref().unwrap();
                    anyhow::ensure!(g.user_bars.as_deref()==Some(&[1.2,2.2][..]),"Bar drag did not snap to2.2s or lost prior hand mark: {:?}",g.user_bars);
                    anyhow::ensure!(g.auto_downbeats==before_bars.auto_downbeats&&g.source==before_bars.source&&g.det_version==before_bars.det_version&&g.beats==before_bars.beats,"Bar drag overwrote detector provenance/base");
                    let _=bar_point(&view,w,cx,2.2)?;Ok(())
                })??;
                shot!(format!("bar-moved-{width}"));
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;wait!(|p:&Player|!p.saving&&p.saved_seq==p.edit_seq);
                std::fs::copy(original.join("project.json"),out.join(format!("bar-saved-{width}.json")))?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(original.clone(),cx)))?;wait!(|p:&Player|!p.loading&&p.project.is_some());
                paused_check!("bar Save/reopen");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    let p=view.read(cx);let g=p.beats.as_ref().unwrap();
                    anyhow::ensure!(g.user_bars.as_deref()==Some(&[1.2,2.2][..])&&g.auto_downbeats==before_bars.auto_downbeats&&g.det_version==before_bars.det_version&&g.source=="auto","Save/reopen lost manual bar correction or detector base");
                    let position=bar_point(&view,w,cx,2.2)?;pointer_move(w,cx,position,false);pointer_button(w,cx,position,true,true);pointer_button(w,cx,position,false,true);Ok(())
                })??;settle!();paused_check!("Alt-clear bar");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let g=p.beats.as_ref().unwrap();anyhow::ensure!(g.user_bars.as_deref()==Some(&[1.2][..])&&g.auto_downbeats==before_bars.auto_downbeats&&g.source=="auto"&&g.det_version==before_bars.det_version,"Alt-clear removed other corrections or detector provenance: {:?}",g);Ok(())})??;
                shot!(format!("bar-cleared-{width}"));
                // Restore the fixture through accepted state and Save so both
                // viewport runs start from the same detector document.
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.apply_metronome(p.metronome.clone(),Some(before_bars.clone()),cx)))?;settle!();
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;wait!(|p:&Player|!p.saving&&p.saved_seq==p.edit_seq);
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(original.clone(),cx)))?;wait!(|p:&Player|!p.loading&&p.project.is_some());paused_check!("bar fixture restore");
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();
                paused_press!("met-click-0");paused_press!("met-accent-0");
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let ui=view.read(cx).metronome_ui.clone();let b=*ui.read(cx).bounds.borrow().get("met-volume").ok_or_else(||anyhow::anyhow!("Volume missing"))?;click(w,cx,point(b.left()+px(5.5)+(b.size.width-px(11.))*0.75,b.center().y));Ok(())})??;settle!();paused_check!("volume");
                // Nonfocusable source buttons blur/commit the BPM draft before
                // applying their own change; native click handling must do both.
                handle.update(cx,|_,w,cx|type_bpm(&view,w,cx,"90"))?;
                paused_press!("met-accent-1");
                wait!(|p:&Player|!p.metronome.accent&&p.beats.as_ref().is_some_and(|g|(g.bpm-90.).abs()<1e-6));
                paused_check!("tempo blur via accent");
                paused_press!("met-accent-0");
                handle.update(cx,|_,w,cx|{type_bpm(&view,w,cx,"120");key(w,cx,"enter");})?;settle!();paused_check!("tempo entry");
                wait!(|p:&Player|p.beats.as_ref().is_some_and(|g|(g.bpm-120.).abs()<1e-6));
                handle.update(cx,|_,w,cx|{type_bpm(&view,w,cx,"999");key(w,cx,"enter");})?;settle!();paused_check!("tempo entry");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!((view.read(cx).beats.as_ref().unwrap().bpm-120.).abs()<1e-6,"Out-of-range tempo was committed");Ok(())})??;
                paused_press!("met-half");wait!(|p:&Player|(p.beats.as_ref().unwrap().bpm-60.).abs()<1e-6);
                paused_press!("met-double");wait!(|p:&Player|(p.beats.as_ref().unwrap().bpm-120.).abs()<1e-6);
                paused_press!("met-meter-1");wait!(|p:&Player|p.beats.as_ref().unwrap().beats_per_bar==3);
                let first_before=handle.update(cx,|_,_,cx|view.read(cx).beats.as_ref().unwrap().beats[0])?;
                paused_press!("met-later");wait!(|p:&Player|(p.beats.as_ref().unwrap().beats[0]-(first_before+0.01)).abs()<1e-6);
                paused_press!("met-earlier");wait!(|p:&Player|(p.beats.as_ref().unwrap().beats[0]-first_before).abs()<1e-6);
                paused_press!("met-rotate");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let g=p.beats.as_ref().unwrap();anyhow::ensure!(!p.metronome.click&&p.metronome.accent&&(p.metronome.volume-0.75).abs()<0.03&&p.metronome.grid&&g.beats_per_bar==3&&g.downbeat==1&&g.downbeats.is_none()&&g.source=="manual","Popover changes not accepted: {:?} {:?}",p.metronome,g);Ok(())})??;
                shot!(format!("edited-{width}"));paused_check!("edited capture");
                handle.update(cx,|_,w,cx|type_bpm(&view,w,cx,"77"))?;shot!(format!("bpm-focus-{width}"));paused_check!("tempo draft capture");
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(|p:&Player|!p.metronome_open);paused_check!("close");
                handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!((view.read(cx).beats.as_ref().unwrap().bpm-120.).abs()<1e-6,"Escape committed a tempo draft");Ok(())})??;
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();
                handle.update(cx,|_,w,cx|{draw(w,cx);click(w,cx,point(px(12.),px(80.)));})?;wait!(|p:&Player|!p.metronome_open);paused_check!("close");
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();
                handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;wait!(|p:&Player|!p.metronome_open);paused_check!("close");
            }
            // Queue B then an invalid C in one update, before backend receipts
            // can drain. B is not the latest pending serial when it succeeds;
            // refusal of C must still leave B as the accepted UI/Save state.
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{
                let mut b=p.metronome.clone();b.volume=0.61;b.accent=false;
                let accepted=p.beats.clone();
                p.apply_metronome(b.clone(),accepted.clone(),cx);
                let mut invalid=accepted.unwrap();invalid.beats[0]=-0.01;
                p.apply_metronome(b,Some(invalid),cx);
            }))?;
            wait!(|p:&Player|p.metronome_flight.metronome.is_none()&&p.notice.is_some());
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{
                let p=view.read(cx);let pop=p.metronome_ui.read(cx);
                anyhow::ensure!(p.project.is_some()&&p.loaded_song&&!p.loading,"A validation refusal unloaded the playable project");
                anyhow::ensure!((p.metronome.volume-0.61).abs()<1e-9&&!p.metronome.accent&&p.beats.as_ref().unwrap().beats[0]>=0.,"Successful B was forgotten after invalid C: {:?}",p.metronome);
                anyhow::ensure!(pop.met==p.metronome&&pop.grid==p.beats,"Popover did not roll back to accepted B");
                Ok(())
            })??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;cx.notify();p.native_transport(transport::TransportEvent::Play,cx);}))?;
            wait!(|p:&Player|p.playing&&!p.transport_flight.counting_in&&p.playhead.position()>0.2);
            // Exercise the actual same-song audio replacement path shared by
            // rename/split. This is handoff-state evidence, not a rename UI test.
            let handoff_position=handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{
                let project=p.project.as_ref().unwrap();
                let position=p.playhead.position();
                let resume=SourceResume{restart_cycle:p.restart_cycle.snapshot(p.region_target().selection,true),play_serial:p.transport_flight.native_play.serial(),position,playing:true,mode:None,title:None,dirty:p.edit_seq!=p.saved_seq,mix:p.current_mix(project)};
                let output=source_jobs::Output{publication_hash:None,path:project.dir.clone(),working:false,target:None};
                p.open_source_output(output,Some(resume),cx);
                position
            }))?;
            wait!(|p:&Player|!p.loading&&p.project.is_some()&&p.playing&&p.metronome_flight.metronome.is_none());
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{
                let p=view.read(cx);
                anyhow::ensure!(!p.transport_flight.counting_in&&p.transport_flight.count_in_anchor.is_none(),"Same-song handoff replayed the user count-in");
                anyhow::ensure!(p.playhead.position()>=handoff_position-0.1&&p.playhead.position()<handoff_position+1.,"Handoff lost playback position: {handoff_position} -> {}",p.playhead.position());
                anyhow::ensure!((p.metronome.volume-0.61).abs()<1e-9&&p.metronome.count_in_bars==1&&p.beats.as_ref().is_some_and(|g|(g.bpm-120.).abs()<1e-6),"Handoff lost unsaved beat/metronome settings");
                Ok(())
            })??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;
            wait!(|p:&Player|!p.playing);
            // Save is requested while a valid new plan is queued, immediately
            // followed by opening the same project. Navigation must wait for
            // the captured Save, otherwise the old disk settings win the race.
            let (before_deferred,deferred_epoch)=handle.update(cx,|_,_,cx|view.update(cx,|p,cx|->anyhow::Result<_>{
                let before=(p.metronome.clone(),p.beats.clone());let epoch=p.native_epoch;
                let mut changed=p.metronome.clone();changed.volume=0.64;
                p.apply_metronome(changed,p.beats.clone(),cx);
                p.save_project(cx);
                p.open_project(original.clone(),cx);
                anyhow::ensure!(p.native_epoch==epoch&&!p.loading&&p.metronome_flight.metronome.is_some(),"Navigation overtook the pending metronome/Save intent");
                Ok((before,epoch))
            }))??;
            wait!(|p:&Player|p.native_epoch>deferred_epoch&&!p.loading&&!p.saving&&p.metronome_flight.metronome.is_none()&&p.project.is_some());
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{
                let p=view.read(cx);let raw:serde_json::Value=serde_json::from_slice(&std::fs::read(original.join("project.json"))?)?;
                anyhow::ensure!((p.metronome.volume-0.64).abs()<1e-9&&(raw["settings"]["metronome"]["volume"].as_f64().unwrap()-0.64).abs()<1e-9&&(p.project.as_ref().unwrap().raw["settings"]["metronome"]["volume"].as_f64().unwrap()-0.64).abs()<1e-9,"Deferred Save did not publish the accepted new settings before navigation");
                Ok(())
            })??;
            std::fs::copy(original.join("project.json"),out.join("deferred-save-project.json"))?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.apply_metronome(before_deferred.0.clone(),before_deferred.1.clone(),cx)))?;
            settle!();
            // Publish only accepted controls, then restore from the same real project.
            let expected=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.metronome.clone(),p.beats.clone())})?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;
            wait!(|p:&Player|!p.saving&&p.saved_seq==p.edit_seq);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(original.clone(),cx)))?;
            wait!(|p:&Player|!p.loading&&p.project.is_some());
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);let beat=p.beats.as_ref().unwrap();anyhow::ensure!(p.metronome==expected.0&&beat.beats_per_bar==3&&beat.downbeat==1&&(beat.bpm-120.).abs()<1e-6,"Save/reopen lost accepted settings");Ok(())})??;
            // The native count-in must not move the UI to song time zero on pause.
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.playhead.seek(3.);p.seek_native(cx);}))?;
            wait!(|p:&Player|p.playhead.pending_seek().is_none()&&(p.playhead.position()-3.).abs()<0.03);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;
            wait!(|p:&Player|p.playing&&p.transport_flight.counting_in);
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!((view.read(cx).playhead.position()-3.).abs()<0.03,"Count-in jumped away from its mid-song anchor");Ok(())})??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|!p.playing);
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!((view.read(cx).playhead.position()-3.).abs()<0.03,"Pausing count-in lost its anchor");Ok(())})??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|p.transport_flight.counting_in);
            wait!(|p:&Player|p.playing&&!p.transport_flight.counting_in&&p.playhead.position()>=3.);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|!p.playing);
            // A stored click request with no grid is retained; native playback
            // uses gridless count-in and the popover's tempo-dependent choices disable.
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(gridless.clone(),cx)))?;
            wait!(|p:&Player|!p.loading&&p.project.as_ref().is_some_and(|p|p.name=="Gridless fixture"));
            handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.metronome.click&&p.metronome.count_in_bars==1&&p.beats.is_none(),"Gridless click intent was lost");Ok(())})??;
            press!("met-grid-1");press!("met-meter-0");
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{anyhow::ensure!(view.read(cx).beats.is_none(),"Disabled grid control created a grid");Ok(())})??;
            shot!("gridless-1060".to_owned());
            handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.playhead.seek(3.);p.seek_native(cx);}))?;wait!(|p:&Player|p.playhead.pending_seek().is_none()&&(p.playhead.position()-3.).abs()<0.03);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|p.transport_flight.counting_in);
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.native_transport(transport::TransportEvent::Play,cx)))?;wait!(|p:&Player|!p.playing);
            // Three real pointer taps establish a tempo through the same UI path.
            handle.update(cx,|_,w,cx|toggle(&view,w,cx))??;settle!();
            for index in 0..3 {if index>0{cx.background_executor().timer(Duration::from_millis(500)).await;}press!("met-tap");}
            wait!(|p:&Player|p.beats.as_ref().is_some_and(|g|(90. ..=150.).contains(&g.bpm)));
            shot!("tapped-1060".to_owned());
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({"restored":true,"sizes":2,"controlAcknowledgements":true,"pausedControlsPreservePosition":true,"blurTempoCommitted":true,"openingPreservesGraph":true,"typedTempo":true,"invalidTempo":true,"halfDoubleMeterNudge":true,"gridPaint":true,"barHandleDrag":true,"barHandlePreview":true,"barHandleAltClear":true,"barHandlePersistence":true,"barHandleSizes":2,"escapeDraft":true,"outsideClose":true,"triggerClose":true,"saveReopen":true,"supersededSuccessRetained":true,"sameSongHandoffNoCountIn":true,"deferredSaveAndNavigation":true,"countInAnchor":true,"gridlessIntent":true,"tapTempo":true,"hidden":true,"muted":true,"savedProject":original}))?)?;
            Ok(())
        }.await;
        match result {Ok(())=>eprintln!("NATIVE_METRONOME_UI passed"),Err(error)=>{eprintln!("NATIVE_METRONOME_UI failed: {error:#}");let _=handle.update(cx,|_,w,cx|{let _=capture(&view,w,cx,&out,"failure");});let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));}}
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

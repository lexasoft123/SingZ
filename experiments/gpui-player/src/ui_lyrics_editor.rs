//! Hidden actual-control lyric editing checks. No OS input or window activation.
use super::ui_training_run::{click, draw};
use super::*;
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn key(window: &mut Window, cx: &mut App, value: &'static str) {
    window.dispatch_keystroke(Keystroke::parse(value).unwrap(), cx);
}
fn editor_state(player: &Player, window: &Window, cx: &App) -> serde_json::Value {
    player.lyrics_editor.read(cx).state(window, cx)
}
fn focused_inputs(player: &Player, window: &Window, cx: &App) -> Vec<u64> {
    let editor = player.lyrics_editor.read(cx);
    editor
        .rows()
        .iter()
        .filter_map(|row| {
            editor
                .input(row.id)
                .filter(|input| input.read(cx).focus_handle(cx).is_focused(window))
                .map(|_| row.id)
        })
        .collect()
}
fn rows(view: &Entity<Player>, cx: &App) -> Vec<lyrics_edit::DraftRow> {
    view.read(cx).lyrics_editor.read(cx).rows().to_vec()
}
fn input(
    view: &Entity<Player>,
    cx: &App,
    row: usize,
) -> anyhow::Result<Entity<gpui_kit::component::input::InputState>> {
    let editor = view.read(cx).lyrics_editor.read(cx);
    let id = editor
        .rows()
        .get(row)
        .ok_or_else(|| anyhow::anyhow!("Missing editor row {row}"))?
        .id;
    editor
        .input(id)
        .ok_or_else(|| anyhow::anyhow!("Missing input for row {id}"))
}
fn focus_row(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    row: usize,
    caret: Option<usize>,
) -> anyhow::Result<()> {
    draw(window, cx);
    let state = input(view, cx, row)?;
    state.update(cx, |s, cx| {
        s.focus(window, cx);
        if let Some(caret) = caret {
            s.set_selected_range(caret..caret, cx);
        }
    });
    draw(window, cx);
    Ok(())
}
fn type_row(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    row: usize,
    value: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    let state = input(view, cx, row)?;
    state.update(cx, |s, cx| {
        s.focus(window, cx);
        s.replace_all(value.to_owned(), window, cx);
    });
    // Change subscriptions run after this App update. Drawing now would let
    // the controlled-input render restore the old model text first.
    Ok(())
}
fn press(view: &Entity<Player>, window: &mut Window, cx: &mut App, id: &str) -> anyhow::Result<()> {
    draw(window, cx);
    let bounds = view
        .read(cx)
        .lyrics_editor
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Editor control {id} not measured"))?;
    anyhow::ensure!(
        bounds.size.width > px(0.)
            && bounds.size.height > px(0.)
            && bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= window.viewport_size().width
            && bounds.bottom() <= window.viewport_size().height,
        "Editor control {id} outside viewport: {bounds:?}"
    );
    click(window, cx, bounds.center());
    Ok(())
}
fn open_editor(view: &Entity<Player>, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(window, cx);
    anyhow::ensure!(
        view.read(cx).karaoke,
        "Lyrics Edit is unavailable until Karaoke opens the lyrics panel"
    );
    let mut bounds = if view.read(cx).backend.is_some() {
        let sidebar = view.read(cx).lyrics_sidebar.read(cx);
        sidebar.bounds("lyrics-edit").ok_or_else(|| {
            anyhow::anyhow!(
                "Actual sidebar Edit/Write-yourself action not measured: {}",
                sidebar.state(window, cx)
            )
        })?
    } else {
        view.read(cx)
            .lyrics_edit_bounds
            .get()
            .ok_or_else(|| anyhow::anyhow!("Player Edit action not measured"))?
    };
    // Ready Edit is in the source row; the empty/error document's real entry
    // point is "Or write the lyrics yourself" inside the scrolling lp-body.
    if let Some(body) = view.read(cx).lyrics_sidebar.read(cx).bounds("lyrics-body") {
        if !body.contains(&bounds.center()) {
            window.dispatch_event(
                PlatformInput::Scroll(ScrollEvent {
                    position: body.center(),
                    delta: ScrollDelta::Pixels(point(px(0.), body.center().y - bounds.center().y)),
                    ..Default::default()
                }),
                cx,
            );
            draw(window, cx);
            bounds = view
                .read(cx)
                .lyrics_sidebar
                .read(cx)
                .bounds("lyrics-edit")
                .ok_or_else(|| {
                    anyhow::anyhow!("Write-yourself control disappeared after scrolling")
                })?;
        }
        anyhow::ensure!(
            body.contains(&bounds.center()),
            "Write-yourself control is clipped by actual sidebar body"
        );
    }
    click(window, cx, bounds.center());
    Ok(())
}
fn capture(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    out: &Path,
    name: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    anyhow::ensure!(
        !window.is_visible() && !window.is_window_active(),
        "Lyrics editor window became presented or active"
    );
    window
        .render_to_image()?
        .save(out.join(format!("{name}.png")))?;
    let p = view.read(cx);
    let expected=std::env::var("SINGZ_LANG").ok().and_then(|tag|i18n::from_tag(&tag)).unwrap_or(i18n::Locale::En);
    anyhow::ensure!(p.language_state.is_some_and(|state|state.locale==expected)&&i18n::current()==expected,"Editor capture preceded accepted locale");
    let pointer = window.mouse_position();
    let state = serde_json::json!({"locale":i18n::current().as_str(),"editorTitle":lyrics_editor::copy("title"),"viewport":[f32::from(window.viewport_size().width),f32::from(window.viewport_size().height)],
        "scale":window.scale_factor(),"project":p.project.as_ref().map(|p|p.name.clone()),"epoch":p.native_epoch,
        "editorOpen":p.lyrics_editor_open,"karaoke":p.karaoke,"editor":editor_state(p,window,cx),"sidebar":p.lyrics_sidebar.read(cx).state(window,cx),
        "replacementValue":p.lyrics_editor.read(cx).replacement_input().read(cx).value().to_string(),
        "focusedInputHandles":focused_inputs(p,window,cx),"position":p.playhead.position(),
        "playing":p.playing,"countingIn":p.counting_in,"nativeSeekCount":p.playhead.seek_count(),
        "windowPresented":window.is_visible(),"windowActive":window.is_window_active(),
        "mousePosition":[f32::from(pointer.x),f32::from(pointer.y)],
        "hiddenConfigured":std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),
        "mutedConfigured":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
        "reference":"candidate; matched production capture absent; live cadence unmeasured"});
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&state)?,
    )?;
    Ok(())
}
fn raw(path: &Path) -> anyhow::Result<serde_json::Value> {
    Ok(serde_json::from_slice(&std::fs::read(path)?)?)
}
fn paused_transport(player: &Player, position: f64, seeks: u64, stage: &str) -> anyhow::Result<()> {
    anyhow::ensure!(!player.playing&&!player.counting_in&&player.playhead.pending_seek().is_none()
        && (player.playhead.position()-position).abs()<=2./44100.&&player.playhead.seek_count()==seeks,
        "Editor {stage} leaked into paused transport: position {position} -> {}, seeks {seeks} -> {}",player.playhead.position(),player.playhead.seek_count());
    Ok(())
}
fn word_drag(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: u64,
    index: usize,
    delta: f64,
) -> anyhow::Result<()> {
    draw(window, cx);
    let editor = view.read(cx).lyrics_editor.read(cx);
    let word = editor
        .bounds(&format!("lyed-word-{id}-{index}"))
        .ok_or_else(|| anyhow::anyhow!("Word chip not measured"))?;
    let strip = editor
        .bounds(&format!("lyed-strip-{id}"))
        .ok_or_else(|| anyhow::anyhow!("Word strip not measured"))?;
    let state = editor.state(window, cx);
    let t0 = state["strip"]["t0"]
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Strip t0 not sampled"))?;
    let t1 = state["strip"]["t1"]
        .as_f64()
        .ok_or_else(|| anyhow::anyhow!("Strip t1 not sampled"))?;
    let start = point(
        word.left() + px(4_f32.min(f32::from(word.size.width) / 2.)),
        word.center().y,
    );
    let end = point(
        start.x + px((delta / (t1 - t0) * f64::from(f32::from(strip.size.width))) as f32),
        start.y,
    );
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position: start,
            pressed_button: None,
            modifiers: Default::default(),
        }),
        cx,
    );
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::MouseDown(MouseDownEvent {
            position: start,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    draw(window, cx);
    if delta != 0. {
        window.dispatch_event(
            PlatformInput::MouseMove(MouseMoveEvent {
                position: end,
                pressed_button: Some(MouseButton::Left),
                modifiers: Default::default(),
            }),
            cx,
        );
        draw(window, cx);
    }
    window.dispatch_event(
        PlatformInput::MouseUp(MouseUpEvent {
            position: end,
            button: MouseButton::Left,
            click_count: 1,
            ..Default::default()
        }),
        cx,
    );
    draw(window, cx);
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move|cx| {
        let result:anyhow::Result<()>=async {
            std::fs::create_dir_all(&out)?;
            let root=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_EDITOR_FIXTURES").ok_or_else(||anyhow::anyhow!("Missing editor fixtures"))?);
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $predicate:expr)=>{{
                let deadline=Instant::now()+Duration::from_secs(25);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready=handle.update(cx,|_,$w,$app|{let $p=view.read($app);let _=(&$p,&$w,&$app);$predicate})?;
                    if ready {break;}
                    if Instant::now()>=deadline {
                        let diagnostic=handle.update(cx,|_,w,cx|{let p=view.read(cx);serde_json::json!({"open":p.lyrics_editor_open,"editor":editor_state(p,w,cx),"sidebar":p.lyrics_sidebar.read(cx).state(w,cx),"focusedInputHandles":focused_inputs(p,w,cx),"replacementValue":p.lyrics_editor.read(cx).replacement_input().read(cx).value().to_string()})})?;
                        anyhow::bail!("Lyrics state timed out: {}; actual: {}",stringify!($predicate),diagnostic);
                    }
                }
            }};}
            macro_rules! shot {($name:expr)=>{handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,&$name))??;};}
            macro_rules! press {($id:expr)=>{handle.update(cx,|_,w,cx|press(&view,w,cx,&$id))??;};}
            macro_rules! open {($name:expr)=>{{
                let path=root.join($name);handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.notice=None;p.open_project(path,cx);}))?;
                wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|project|project.name==$name));
            }};}
            macro_rules! edit {()=>{{
                // Projects without a lyrics document load with Karaoke off.
                // Open its actual footer control before using the panel's Edit
                // action; an old measurement may outlive the hidden panel.
                if !handle.update(cx,|_,_,cx|view.read(cx).karaoke)? {
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                        draw(w,cx);let b=view.read(cx).quick_start.read(cx).anchors.get("karaoke").ok_or_else(||anyhow::anyhow!("Karaoke footer control not measured"))?;
                        click(w,cx,b.center());Ok(())
                    })??;
                    wait!(p,w,app => p.karaoke);
                }
                // Karaoke starts the real lookup for a document-less song.
                // Its loading/consent screens intentionally have no Edit;
                // wait for the real ready row or error write-yourself route.
                wait!(p,w,app => p.backend.is_none()||(!p.loading&&p.lyrics_sidebar_pending.is_none()&&matches!(p.lyrics_sidebar.read(app).state(w,app)["status"].as_str(),Some("ready"|"error"))));
                handle.update(cx,|_,w,cx|open_editor(&view,w,cx))??;
                wait!(p,w,app => p.lyrics_editor_open&&!p.lyrics_editor.read(app).rows().is_empty());
            }};}
            macro_rules! close_discard {()=>{{
                press!("lyed-cancel".to_owned());wait!(p,w,app => editor_state(p,w,app)["discard"]==true);
                press!("lyed-discard".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            }};}

            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                let fixture=format!("project-{}",width as i32);open!(fixture.as_str());edit!();
                let first=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                anyhow::ensure!(first.len()==3&&first[0].text=="Hello,   world!"&&first[2].text=="Третий припев","Saved raw text was reconstructed or lost");
                shot!(format!("initial-{}",width as i32));
                // Drive real native text insertion, including Space. Direct
                // replace_all fixture edits cannot detect a consumed KeyDown.
                handle.update(cx,|_,w,cx|focus_row(&view,w,cx,0,None))??;
                handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,if cfg!(target_os="macos"){ "cmd-a" }else{"ctrl-a"});})?;
                let transport=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playing,p.playhead.position(),p.native_epoch,p.playhead.seek_count(),p.muted,p.solo)})?;
                for character in ["shift-h","e","l","l","o","space","n","a","t","i","v","e","space","w","o","r","l","d"] {
                    handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,character);})?;
                }
                wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Hello native world"&&editor_state(p,w,app)["dirty"]==true);
                anyhow::ensure!(handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playing,p.playhead.position(),p.native_epoch,p.playhead.seek_count(),p.muted,p.solo)})?==transport,"Editor printable/Space keys leaked into playback or mix");
                handle.update(cx,|_,w,cx|{focus_row(&view,w,cx,0,Some(12))?;key(w,cx,"enter");Ok::<_,anyhow::Error>(())})??;
                wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==4);
                let split=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                anyhow::ensure!(split[0].text=="Hello native"&&split[1].text=="world"&&split[0].words.is_none()&&split[1].words.is_none(),"Enter did not split at the caret or invalidated words survived");
                handle.update(cx,|_,w,cx|{focus_row(&view,w,cx,1,Some(0))?;key(w,cx,"backspace");Ok::<_,anyhow::Error>(())})??;
                wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==3&&p.lyrics_editor.read(app).rows()[0].text=="Hello native world");
                let id=handle.update(cx,|_,_,cx|rows(&view,cx)[0].id)?;
                press!(format!("lyed-add-{id}"));wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==4);
                let added=handle.update(cx,|_,_,cx|rows(&view,cx)[1].id)?;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.playhead.seek(2.25);p.seek_native(cx);}))?;
                wait!(p,w,app => p.playhead.pending_seek().is_none()&&(p.playhead.position()-2.25).abs()<2./44100.);
                press!(format!("lyed-stamp-{added}"));
                wait!(p,w,app => p.lyrics_editor.read(app).rows().iter().find(|r|r.id==added).is_some_and(|r|r.start==Some(2.25)));
                press!(format!("lyed-remove-{added}"));wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==3);
                let last=handle.update(cx,|_,_,cx|rows(&view,cx)[2].id)?;
                press!(format!("lyed-remove-{last}"));wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==2);
                press!("lyed-undo".to_owned());wait!(p,w,app => p.lyrics_editor.read(app).rows().len()==3&&p.lyrics_editor.read(app).rows()[2].id==last);
                press!("lyed-replace".to_owned());wait!(p,w,app => editor_state(p,w,app)["replace"]==true);
                // Opening queues source text initialization for the next render.
                // Render before entering the user's replacement, otherwise the
                // Apply control's first render overwrites it with that seed.
                handle.update(cx,|_,w,cx|{draw(w,cx);let replacement=view.read(cx).lyrics_editor.read(cx).replacement_input();replacement.update(cx,|s,cx|{s.focus(w,cx);s.replace_all("Hello native world\nInserted line\nSing with me\nТретий припев".to_owned(),w,cx);});})?;
                wait!(p,w,app => p.lyrics_editor.read(app).replacement_input().read(app).value().as_str()=="Hello native world\nInserted line\nSing with me\nТретий припев");
                handle.update(cx,|_,w,cx|{draw(w,cx);let input=view.read(cx).lyrics_editor.read(cx).replacement_input();input.update(cx,|s,cx|{s.focus(w,cx);s.set_selected_range(0..0,cx);});})?;
                for character in ["x","space"] {handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,character);})?;}
                wait!(p,w,app => p.lyrics_editor.read(app).replacement_input().read(app).value().as_str()=="x Hello native world\nInserted line\nSing with me\nТретий припев");
                for _ in 0..2 {handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,"backspace");})?;}
                handle.update(cx,|_,w,cx|{draw(w,cx);let input=view.read(cx).lyrics_editor.read(cx).replacement_input();input.update(cx,|s,cx|s.set_selected_range(18..18,cx));key(w,cx,"enter");})?;
                wait!(p,w,app => p.lyrics_editor.read(app).replacement_input().read(app).value().as_str()=="Hello native world\n\nInserted line\nSing with me\nТретий припев");
                anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx).len())?==3,"Textarea Enter split the main lyric rows");
                handle.update(cx,|_,w,cx|{draw(w,cx);key(w,cx,"backspace");})?;
                wait!(p,w,app => p.lyrics_editor.read(app).replacement_input().read(app).value().as_str()=="Hello native world\nInserted line\nSing with me\nТретий припев");
                press!("lyed-replace-apply".to_owned());
                wait!(p,w,app => editor_state(p,w,app)["replace"]==false&&p.lyrics_editor.read(app).rows().len()==4);
                let replaced=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                anyhow::ensure!(replaced[0].start==Some(1.)&&replaced[1].start.is_none()&&replaced[2].start==Some(4.),"Replace failed to retain surviving timings");
                shot!(format!("edited-{}",width as i32));
                press!("lyed-help".to_owned());wait!(p,w,app => editor_state(p,w,app)["help"]==true);
                shot!(format!("help-{}",width as i32));
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => p.lyrics_editor_open&&editor_state(p,w,app)["help"]==false);
                press!("lyed-help".to_owned());
                wait!(p,w,app => editor_state(p,w,app)["help"]==true);
                handle.update(cx,|_,w,cx|{
                    draw(w,cx);
                    // First return to the heading: autofocus may already have
                    // revealed the footer in a compact localized sheet.
                    w.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                        position:point(w.viewport_size().width/2.,w.viewport_size().height/2.),
                        delta:ScrollDelta::Pixels(point(px(0.),px(1600.))),
                        ..Default::default()
                    }),cx);
                    draw(w,cx);
                })?;
                shot!(format!("help-top-{}",width as i32));
                handle.update(cx,|_,w,cx|{
                    w.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                        position:point(w.viewport_size().width/2.,w.viewport_size().height/2.),
                        delta:ScrollDelta::Pixels(point(px(0.),px(-1600.))),
                        ..Default::default()
                    }),cx);
                    draw(w,cx);
                })?;
                shot!(format!("help-scrolled-{}",width as i32));
                press!("lyed-help-close".to_owned());
                wait!(p,w,app => editor_state(p,w,app)["help"]==false);
                press!("lyed-help".to_owned());
                wait!(p,w,app => editor_state(p,w,app)["help"]==true);
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    draw(w,cx);
                    w.dispatch_event(PlatformInput::Scroll(ScrollEvent {
                        position:point(w.viewport_size().width/2.,w.viewport_size().height/2.),
                        delta:ScrollDelta::Pixels(point(px(0.),px(1600.))),
                        ..Default::default()
                    }),cx);
                    draw(w,cx);
                    key(w,cx,"tab");draw(w,cx);
                    let editor=view.read(cx).lyrics_editor.read(cx);
                    let bounds=editor.bounds("lyed-help-close").ok_or_else(||anyhow::anyhow!("Help Close not measured"))?;
                    anyhow::ensure!(editor.state(w,cx)["focusedControl"]=="lyed-help-close","Help Tab escaped its sheet");
                    anyhow::ensure!(bounds.top()>=px(0.)&&bounds.bottom()<=w.viewport_size().height,"Keyboard-focused Help Close is clipped: {bounds:?}");
                    Ok(())
                })??;
                shot!(format!("help-keyboard-{}",width as i32));
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => editor_state(p,w,app)["help"]==false);
                handle.update(cx,|_,w,cx|focus_row(&view,w,cx,0,None))??;
                for _ in 0..24 {
                    handle.update(cx,|_,w,cx|{key(w,cx,"tab");draw(w,cx);})?;
                    handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(editor_state(view.read(cx),w,cx)["focusInside"]==true,"Tab escaped the editor focus scope");Ok(())})??;
                }
                press!("lyed-cancel".to_owned());wait!(p,w,app => editor_state(p,w,app)["discard"]==true);
                shot!(format!("dirty-dismissal-{}",width as i32));
                press!("lyed-keep".to_owned());wait!(p,w,app => editor_state(p,w,app)["discard"]==false&&p.lyrics_editor_open);
                press!("lyed-save".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
                let saved=raw(&root.join(&fixture).join("lyrics.json"))?;
                anyhow::ensure!(saved["source"]=="edited"&&saved["credit"]=="fixture-credit"&&saved["lines"][0]["text"]=="Hello native world","Independent editor Save did not publish edited lyrics");
                std::fs::write(out.join(format!("saved-{}.json",width as i32)),serde_json::to_vec_pretty(&saved)?)?;
                edit!();
                let baseline=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                anyhow::ensure!(baseline.len()==4&&baseline[0].text=="Hello native world","Reopen lost edited rows");
                let id=baseline[0].id;
                let (paused,seeks)=handle.update(cx,|_,_,cx|{let p=view.read(cx);(p.playhead.position(),p.playhead.seek_count())})?;
                press!(format!("lyed-print-{id}"));wait!(p,w,app => editor_state(p,w,app)["strip"]["id"].as_u64()==Some(id));
                handle.update(cx,|_,w,cx|word_drag(&view,w,cx,id,1,0.))??;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{anyhow::ensure!(rows(&view,cx)==baseline&&editor_state(view.read(cx),w,cx)["dirty"]==false,"Stationary word click dirtied or moved lyrics");paused_transport(view.read(cx),paused,seeks,"stationary word click")})??;
                let original_start=baseline[0].words.as_ref().unwrap()[1].s;
                let expected=((original_start+0.2)*100.).round()/100.;
                handle.update(cx,|_,w,cx|word_drag(&view,w,cx,id,1,0.2))??;
                wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].words.as_ref().is_some_and(|words|(words[1].s-expected).abs()<1e-8));
                handle.update(cx,|_,_,cx|paused_transport(view.read(cx),paused,seeks,"word drag"))??;
                shot!(format!("word-strip-{}",width as i32));
                handle.update(cx,|_,w,cx|key(w,cx,"right"))?;
                wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].words.as_ref().is_some_and(|words|(words[1].s-(expected+0.05)).abs()<1e-8));
                handle.update(cx,|_,_,cx|paused_transport(view.read(cx),paused,seeks,"word keyboard nudge"))??;
                let word_rows=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                let words=word_rows[0].words.as_ref().unwrap();
                anyhow::ensure!(words[0].e<=words[1].s&&words.windows(2).all(|pair|pair[1].s-pair[0].s>=0.05-1e-8),"Word movement crossed a fence");
                press!("lyed-save".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
                // The editor's audition deliberately bypasses the project's
                // one-bar count-in. The actual play control is used here.
                edit!();
                let from=handle.update(cx,|_,_,cx|view.read(cx).playhead.position())?;
                press!("lyed-play".to_owned());
                let deadline=Instant::now()+Duration::from_millis(1200);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let advanced=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(!p.counting_in,"Editor audition started a count-in");Ok(p.playing&&p.playhead.position()>from+0.05)})??;
                    if advanced {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Editor play failed to advance before the gridless count-in would finish");
                }
                press!("lyed-play".to_owned());wait!(p,w,app => !p.playing);
                let row_start=handle.update(cx,|_,_,cx|rows(&view,cx)[0].start.unwrap())?;
                let row_id=handle.update(cx,|_,_,cx|rows(&view,cx)[0].id)?;
                let seeks=handle.update(cx,|_,_,cx|view.read(cx).playhead.seek_count())?;
                press!(format!("lyed-stamp-{row_id}"));
                let deadline=Instant::now()+Duration::from_millis(1200);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let advanced=handle.update(cx,|_,_,cx|->anyhow::Result<bool>{let p=view.read(cx);anyhow::ensure!(!p.counting_in,"Timed-row audition started a count-in");Ok(p.playing&&p.playhead.seek_count()>seeks&&p.playhead.position()>(row_start-0.3).max(0.)+0.05)})??;
                    if advanced {break;}
                    anyhow::ensure!(Instant::now()<deadline,"Timed-row audition did not seek and play without count-in");
                }
                press!("lyed-play".to_owned());wait!(p,w,app => !p.playing);
                press!("lyed-cancel".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            }

            for (width,height) in [(1280.,800.),(1060.,640.)] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(height))))?;
                let name=format!("long-{}",width as i32);open!(name.as_str());edit!();
                let original=handle.update(cx,|_,_,cx|rows(&view,cx))?;
                anyhow::ensure!(original.len()==20,"Long-list fixture did not load twenty lines");
                handle.update(cx,|_,w,cx|focus_row(&view,w,cx,0,Some(0)))??;
                handle.update(cx,|_,w,cx|draw(w,cx))?;
                wait!(p,w,app => editor_state(p,w,app)["focusedRow"].as_u64()==Some(original[0].id)&&focused_inputs(p,w,app)==vec![original[0].id]);
                for row in original.iter().skip(1) {
                    // Key dispatch notifies the Editor, then the outer App
                    // update marks its cached view dirty. Render after that
                    // boundary so ensure_inputs consumes pending row focus.
                    handle.update(cx,|_,w,cx|key(w,cx,"down"))?;
                    handle.update(cx,|_,w,cx|draw(w,cx))?;
                    wait!(p,w,app => editor_state(p,w,app)["focusedRow"].as_u64()==Some(row.id));
                }
                let last=original.last().unwrap().id;
                handle.update(cx,|_,w,cx|->anyhow::Result<()>{
                    draw(w,cx);let editor=view.read(cx).lyrics_editor.read(cx);
                    let list=editor.bounds("lyed-list").ok_or_else(||anyhow::anyhow!("Long-list viewport not measured"))?;
                    let row=editor.bounds(&format!("lyed-row-{last}")).ok_or_else(||anyhow::anyhow!("Focused last row not measured"))?;
                    anyhow::ensure!(row.top()>=list.top()&&row.bottom()<=list.bottom(),"Keyboard focus moved to an invisible lyric row: {row:?} outside {list:?}");
                    anyhow::ensure!(editor.state(w,cx)["focusInside"]==true,"Long-list focus escaped editor");
                    Ok(())
                })??;
                shot!(format!("long-list-last-{}",width as i32));
                handle.update(cx,|_,w,cx|type_row(&view,w,cx,19,"Temporary long-line edit"))??;
                wait!(p,w,app => p.lyrics_editor.read(app).rows()[19].text=="Temporary long-line edit");
                press!("lyed-undo".to_owned());
                wait!(p,w,app => p.lyrics_editor.read(app).rows()==original.as_slice());
                close_discard!();
            }

            // Save commits revision A while the live input advances to B. A's
            // receipt must update its file identity without closing or replacing
            // B; a second explicit Save must then use the updated identity.
            open!("mid-save");edit!();
            handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Earlier saved draft"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Earlier saved draft");
            let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE").unwrap());let ready=gate.with_extension("ready");
            let _=std::fs::remove_file(&ready);std::fs::write(&gate,b"hold earlier draft receipt")?;
            press!("lyed-save".to_owned());wait!(p,w,app => ready.is_file());
            anyhow::ensure!(raw(&root.join("mid-save/lyrics.json"))?["lines"][0]["text"]=="Earlier saved draft","Gate did not hold a genuinely committed earlier draft");
            handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Newer draft stays open"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Newer draft stays open"&&editor_state(p,w,app)["saving"]==true);
            std::fs::remove_file(&gate)?;
            wait!(p,w,app => p.lyrics_editor_open&&editor_state(p,w,app)["saving"]==false&&editor_state(p,w,app)["error"].as_str().is_some_and(|e|e.contains("earlier draft")));
            handle.update(cx,|_,w,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.lyrics_editor.read(cx).rows()[0].text=="Newer draft stays open"&&editor_state(p,w,cx)["dirty"]==true&&p.lyric_document.lines[0].text=="Earlier saved draft","Earlier Save receipt replaced or closed the newer draft");Ok(())})??;
            shot!("mid-save-newer-draft");
            press!("lyed-save".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            anyhow::ensure!(raw(&root.join("mid-save/lyrics.json"))?["lines"][0]["text"]=="Newer draft stays open","Second Save did not use the refreshed file identity");

            open!("absent");edit!();handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Create missing lyrics"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Create missing lyrics");
            press!("lyed-save".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            anyhow::ensure!(raw(&root.join("absent/lyrics.json"))?["source"]=="edited","Missing lyrics were not created");

            open!("conflict");edit!();
            let path=root.join("conflict/lyrics.json");let mut external=raw(&path)?;external["externalChange"]=serde_json::json!("keep");std::fs::write(&path,serde_json::to_vec_pretty(&external)?)?;
            handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Conflicting rewrite"))??;
            press!("lyed-save".to_owned());wait!(p,w,app => p.lyrics_editor_open&&editor_state(p,w,app)["error"].as_str().is_some_and(|e|e.contains("changed outside")));
            anyhow::ensure!(raw(&path)?==external,"Editor overwrote an external lyric edit");shot!("external-conflict");close_discard!();

            open!("absent-race");edit!();
            let path=root.join("absent-race/lyrics.json");let mut external=raw(&root.join("other/lyrics.json"))?;external["externalCreate"]=serde_json::json!("keep");std::fs::write(&path,serde_json::to_vec_pretty(&external)?)?;
            handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Refused absent race"))??;
            press!("lyed-save".to_owned());wait!(p,w,app => p.lyrics_editor_open&&editor_state(p,w,app)["error"].as_str().is_some_and(|e|e.contains("changed outside")));
            anyhow::ensure!(raw(&path)?==external,"Expected-absent Save overwrote newly created lyrics");close_discard!();

            // Hold a real completed Save receipt while navigation advances its
            // epoch. The file is saved, but the old result must never enter B.
            open!("stale");edit!();handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Old epoch saved text"))??;
            let gate=PathBuf::from(std::env::var_os("SINGZ_GPUI_LYRICS_TEST_RECEIPT_GATE").unwrap());let ready=gate.with_extension("ready");
            std::fs::write(&gate,b"hold completed receipt")?;let _=std::fs::remove_file(&ready);
            press!("lyed-save".to_owned());wait!(p,w,app => ready.is_file());
            let old_epoch=handle.update(cx,|_,_,cx|view.read(cx).native_epoch)?;
            let other=root.join("other");handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_project(other,cx)))?;
            wait!(p,w,app => p.native_epoch!=old_epoch);
            std::fs::remove_file(&gate)?;
            wait!(p,w,app => !p.loading&&p.project.as_ref().is_some_and(|p|p.name=="other")&&!p.lyrics_editor_open);
            handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.lyric_document.source=="whisper"&&p.lyric_document.credit=="other-credit","Old lyric Save receipt entered the new song");Ok(())})??;
            shot!("stale-receipt-ignored");

            // Replay a prepared private source output. The publication worker,
            // editor Save and target conflict checks are real; model inference
            // is deliberately outside this fixture's scope.
            let target=root.join("working-target");let (_,fingerprint)=project_store::read(&target,"project.json")?;
            let target=source_jobs::Target{dir:target.clone(),fingerprint,lyrics_fingerprint:lyrics_store::identity(&target)?};
            let working=root.join("working-copy");
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.open_source_output(source_jobs::Output{publication_hash:None,path:working.clone(),working:true,target:Some(target)},None,cx)))?;
            wait!(p,w,app => !p.loading&&p.source_working&&p.project.as_ref().is_some_and(|p|p.dir==working));
            edit!();handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Earlier private correction"))??;
            press!("lyed-save".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            anyhow::ensure!(raw(&working.join("lyrics.json"))?["source"]=="edited"&&raw(&root.join("working-target/lyrics.json"))?["source"]=="lrclib","Private editor Save published to the saved target");
            // A Save accepted before opening the editor must remain queued:
            // publishing the working copy here would race its independent
            // lyric Save and could permanently publish the earlier draft.
            edit!();
            let target_before=std::fs::read(root.join("working-target/lyrics.json"))?;
            let private_before=std::fs::read(working.join("lyrics.json"))?;
            handle.update(cx,|_,_,cx|view.update(cx,|p,cx|{p.metronome_save_requested=true;cx.notify();}))?;
            for _ in 0..8 {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                handle.update(cx,|_,_,cx|view.update(cx,|p,cx|->anyhow::Result<()>{
                    p.flush_metronome_intents(cx);
                    anyhow::ensure!(p.lyrics_editor_open&&p.metronome_save_requested&&p.source_job.is_none()&&!p.saving&&p.source_working,"Queued Save published while the lyric editor remained open");
                    Ok(())
                }))??;
                anyhow::ensure!(std::fs::read(root.join("working-target/lyrics.json"))?==target_before&&std::fs::read(working.join("lyrics.json"))?==private_before,"Queued Save changed lyrics before editor Save");
            }
            handle.update(cx,|_,w,cx|type_row(&view,w,cx,0,"Working correction survives publication"))??;
            wait!(p,w,app => p.lyrics_editor.read(app).rows()[0].text=="Working correction survives publication");
            press!("lyed-save".to_owned());
            wait!(p,w,app => !p.lyrics_editor_open&&!p.loading&&!p.saving&&p.source_job.is_none()&&!p.source_working&&!p.metronome_save_requested&&!p.metronome_save_waiting&&p.project.as_ref().is_some_and(|p|p.dir==root.join("working-target")));
            anyhow::ensure!(raw(&root.join("working-target/lyrics.json"))?["lines"][0]["text"]=="Working correction survives publication","Targeted publication lost edited lyrics");
            open!("working-target");edit!();
            anyhow::ensure!(handle.update(cx,|_,_,cx|rows(&view,cx)[0].text.clone())?=="Working correction survives publication","Reload lost latest lyrics from queued working-copy Save");
            press!("lyed-cancel".to_owned());wait!(p,w,app => !p.lyrics_editor_open);
            shot!("working-copy-published");
            std::fs::write(out.join("result.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "twoSizes":true,"rawLineText":true,"textInput":true,"splitMerge":true,"addStampRemoveUndo":true,
                "replace":true,"realKeyboardRowText":true,"realKeyboardReplacementText":true,"textareaNativeEnter":true,"keyboardSpaceNoTransportLeak":true,"helpEscape":true,"helpScrollClose":true,"helpKeyboardVisible":true,"dirtyDismissal":true,"focusTrap":true,"wordClickNoOp":true,
                "wordDrag":true,"wordKeyboardNudge":true,"independentSave":true,"saveReopen":true,
                "noCountInAudition":true,"absentCreate":true,"absentRaceRefused":true,"externalConflictRefused":true,
                "staleReceiptIgnored":true,"workingCopyPublication":true,"queuedWorkingSaveRetained":true,"queuedWorkingSaveLatestLyrics":true,"longListFocusVisible":true,
                "midSaveEditRetained":true,"secondSaveAfterEdit":true,"hidden":true,"muted":true,
                "visualReference":"candidate only","alignment":"not exercised by this editor-controls suite"}))?)?;
            Ok(())
        }.await;
        match result {
            Ok(()) => eprintln!("NATIVE_LYRICS_EDITOR passed"),
            Err(error) => {eprintln!("NATIVE_LYRICS_EDITOR failed: {error:#}");let _=std::fs::write(out.join("failure.txt"),format!("{error:#}"));let _=handle.update(cx,|_,w,cx|capture(&view,w,cx,&out,"failure"));}
        }
        let _=cx.update(|cx|cx.quit());
    }).detach();
}

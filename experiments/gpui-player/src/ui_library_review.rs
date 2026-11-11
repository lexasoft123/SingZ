//! Matched library-state captures through hidden, app-scoped GPUI input.
use super::*;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    time::Duration,
};

fn hash(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn move_mouse(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    window.dispatch_event(
        PlatformInput::MouseMove(MouseMoveEvent {
            position,
            pressed_button: None,
            modifiers: Modifiers::default(),
        }),
        cx,
    );
}

fn click(window: &mut Window, cx: &mut App, position: Point<Pixels>) {
    move_mouse(window, cx, position);
    for down in [true, false] {
        if down {
            window.dispatch_event(
                PlatformInput::MouseDown(MouseDownEvent {
                    position,
                    button: MouseButton::Left,
                    click_count: 1,
                    ..Default::default()
                }),
                cx,
            );
        } else {
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
    }
}

fn settle(window: &mut Window, cx: &mut App) {
    for _ in 0..6 {
        window.simulate_next_frame(cx);
        window.refresh();
        let _ = window.draw(cx);
    }
}

fn snapshot(view: &Entity<Player>, cx: &App) -> Value {
    view.read(cx).library.read(cx).review_snapshot()
}

fn number(value: &Value, key: &str) -> anyhow::Result<f32> {
    value[key]
        .as_f64()
        .map(|v| v as f32)
        .ok_or_else(|| anyhow::anyhow!("Missing numeric {key} in {value}"))
}

fn matching(fixture: &[Value], query: &str) -> Vec<String> {
    fixture
        .iter()
        .filter_map(|song| song["title"].as_str())
        .filter(|title| title.to_lowercase().contains(query))
        .map(str::to_owned)
        .collect()
}

fn assert_fixture(state: &Value, fixture: &[Value], query: &str) -> anyhow::Result<()> {
    let actual = state["fixture"]
        .as_array()
        .ok_or_else(|| anyhow::anyhow!("No native fixture"))?;
    anyhow::ensure!(
        actual.len() == 12 && fixture.len() == 12,
        "Expected12fixture songs"
    );
    for (native, source) in actual.iter().zip(fixture) {
        for field in ["title", "artist", "saved", "lyrics"] {
            anyhow::ensure!(
                native[field] == source[field],
                "Fixture field mismatch: {field}: {native} vs {source}"
            );
        }
    }
    anyhow::ensure!(
        state["query"] == query,
        "Search input did not update query: {state}"
    );
    anyhow::ensure!(
        state["matches"] == json!(matching(fixture, query)),
        "Wrong filtered fixture: {state}"
    );
    Ok(())
}

fn set_query(
    window: &mut Window,
    view: &Entity<Player>,
    source: &Value,
    query: &str,
    cx: &mut App,
) -> anyhow::Result<()> {
    let search = &source["regions"][".lib-search"];
    click(
        window,
        cx,
        point(
            px(number(search, "x")? + number(search, "width")? / 2.),
            px(number(search, "y")? + number(search, "height")? / 2.),
        ),
    );
    let _ = window.draw(cx);
    window.dispatch_keystroke(Keystroke::parse("cmd-a")?, cx);
    window.dispatch_keystroke(Keystroke::parse("backspace")?, cx);
    for ch in query.chars() {
        window.dispatch_keystroke(
            Keystroke {
                key: ch.to_string(),
                key_char: Some(ch.to_string()),
                ..Default::default()
            },
            cx,
        );
    }
    // App-scoped focus only: suppress blinking caret in both capture engines.
    view.read(cx).focus_handle.clone().focus(window, cx);
    move_mouse(window, cx, point(px(-1000.), px(-1000.)));
    Ok(())
}

fn write_capture(
    window: &mut Window,
    view: &Entity<Player>,
    directory: &Path,
    id: &str,
    source: &Value,
    fixture: &[Value],
    query: &str,
    hover: Option<&str>,
    cx: &mut App,
) -> anyhow::Result<()> {
    settle(window, cx);
    anyhow::ensure!(
        !window.is_visible() && !window.is_window_active(),
        "Library review window became visible or active"
    );
    let state = snapshot(view, cx);
    assert_fixture(&state, fixture, query)?;
    let viewport = window.viewport_size();
    anyhow::ensure!(
        window.scale_factor() == 2.,
        "Expected source2x device scale"
    );
    anyhow::ensure!(
        source["viewport"][0].as_f64() == Some(f64::from(f32::from(viewport.width)))
            && source["viewport"][1].as_f64() == Some(f64::from(f32::from(viewport.height))),
        "Viewport mismatch"
    );
    let image = window.render_to_image()?;
    if hover.is_some() {
        let row = &state["firstRow"];
        let x = ((number(row, "x")? + 120.) * 2.) as u32;
        let y = (number(row, "y")? * 2.) as u32;
        let mut amber = false;
        for py in y.saturating_sub(1)..=(y + 3).min(image.height() - 1) {
            let p = image.get_pixel(x, py).0;
            amber |= p[0] > 245 && (150..=170).contains(&p[1]) && p[2] < 55;
        }
        anyhow::ensure!(
            amber,
            "Hovered native card did not paint its source amber border"
        );
    }
    let png = directory.join(format!("{id}-candidate.png"));
    image.save(&png)?;
    let sidecar = json!({
        "caseId":id,"status":"captured","viewport":[f32::from(viewport.width),f32::from(viewport.height)],"deviceScale":window.scale_factor(),"imagePixels":[image.width(),image.height()],"zoom":1.,"locale":"en","theme":"dark","colorSpace":"raw sRGB GPUI offscreen scene","capture":"hidden GPUI render_to_image","hidden":true,"globalInput":false,"muted":true,"noSync":true,"route":"library","loadedSong":null,"playing":false,"eqAnimationMs":1000,"transitionsSettled":true,"hoveredTitle":hover,"focusedInput":false,"snapshot":state,
        "fixtureSha256":source["fixtureSha256"],"referenceSha256":source["screenshotSha256"],"referenceSource":source["source"],"screenshotSha256":hash(std::fs::read(&png)?),
        "native":{"binarySha256":hash(std::fs::read(std::env::current_exe()?)?),"librarySourceSha256":hash(include_str!("library.rs")),"headerSourceSha256":hash(include_str!("header.rs")),"os":std::env::consts::OS,"architecture":std::env::consts::ARCH,"fonts":{"Display400":hash(singz_uikit::fonts::DISPLAY_400),"Display600":hash(singz_uikit::fonts::DISPLAY_600),"Display650":hash(singz_uikit::fonts::DISPLAY_650),"Display700":hash(singz_uikit::fonts::DISPLAY_700),"Display800":hash(singz_uikit::fonts::DISPLAY_800)}}
    });
    std::fs::write(
        directory.join(format!("{id}-candidate.json")),
        serde_json::to_vec_pretty(&sidecar)?,
    )?;
    eprintln!("UI_LIBRARY_REVIEW {id}: captured query={query:?}");
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, directory: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var("SINGZ_GPUI_BACKGROUND").as_deref()==Ok("1"),"Library review requires hidden background mode");
            std::fs::create_dir_all(&directory)?;
            let reference=PathBuf::from(std::env::var("SINGZ_GPUI_LIBRARY_REFERENCE").unwrap_or_else(|_|"/tmp/singz-ui-library-reference-20261106".into()));
            let fixture:Vec<Value>=serde_json::from_slice(&std::fs::read(reference.join("fixture.json"))?)?;
            let mut matrix=Vec::new();
            for (width,height) in [(1280.,800.),(1060.,640.)] {
                let source:Value=serde_json::from_slice(&std::fs::read(reference.join(format!("library-top-{}-reference.json",width as u32)))?)?;
                anyhow::ensure!(source["fixtureSha256"]==hash(std::fs::read(reference.join("fixture.json"))?),"Reference fixture hash mismatch");
                handle.update(cx,|_,window,cx|{
                    window.resize(size(px(width),px(height)));
                    view.update(cx,|this,cx|{this.screen=Screen::Library;this.loaded_song=false;this.playing=false;this.notice=None;this.library.update(cx,|library,cx|{library.set_open_song(None,cx);library.set_animation_time(1.,cx)});cx.notify()});
                })?;
                cx.background_executor().timer(Duration::from_millis(100)).await;
                for (name,query) in [("top",""),("no-results","zzzzreview"),("matching","paper"),("hover",""),("bottom","")] {
                    let id=format!("library-{name}-{}",width as u32);
                    let reference_sidecar:Value=serde_json::from_slice(&std::fs::read(reference.join(format!("{id}-reference.json")))?)?;
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{settle(window,cx);set_query(window,&view,&source,query,cx)})??;
                    cx.background_executor().timer(Duration::from_millis(35)).await;
                    if reference_sidecar["status"]=="blocked" {
                        let state=handle.update(cx,|_,window,cx|{settle(window,cx);snapshot(&view,cx)})?;
                        assert_fixture(&state,&fixture,query)?;
                        anyhow::ensure!(number(&state["grid"],"height")?<=0.,"Sourceblocked grid is unexpectedly visible natively");
                        let blocked=json!({"caseId":id,"status":"blocked","reason":reference_sidecar["reason"],"snapshot":state,"source":reference_sidecar});
                        std::fs::write(directory.join(format!("{id}-candidate.json")),serde_json::to_vec_pretty(&blocked)?)?;
                        matrix.push(blocked);continue;
                    }
                    handle.update(cx,|_,window,cx|->anyhow::Result<()>{
                        settle(window,cx);assert_fixture(&snapshot(&view,cx),&fixture,query)?;
                        if name=="hover" {
                            let state=snapshot(&view,cx);let row=&state["firstRow"];
                            move_mouse(window,cx,point(px(number(row,"x")?+140.),px(number(row,"y")?+number(row,"height")?/2.)));
                        } else if name=="bottom" {
                            let state=snapshot(&view,cx);let grid=&state["grid"];
                            let position=point(px(number(grid,"x")?+number(grid,"width")?/2.),px(number(grid,"y")?+number(grid,"height")?/2.));
                            move_mouse(window,cx,position);
                            window.dispatch_event(PlatformInput::Scroll(ScrollEvent{position,delta:ScrollDelta::Pixels(point(px(0.),px(-10000.))),..Default::default()}),cx);
                            settle(window,cx);move_mouse(window,cx,point(px(-1000.),px(-1000.)));
                            let grid=snapshot(&view,cx)["grid"].clone();
                            anyhow::ensure!(number(&grid,"scrollTop")?>0. && (number(&grid,"scrollTop")?-number(&grid,"maxScroll")?).abs()<0.1,"Native wheel did not reach bottom: {grid}");
                        }
                        write_capture(window,&view,&directory,&id,&reference_sidecar,&fixture,query,(name=="hover").then_some("Room to breathe"),cx)
                    })??;
                    matrix.push(json!({"caseId":id,"status":"captured"}));
                }
            }
            std::fs::write(directory.join("library-matrix.json"),serde_json::to_vec_pretty(&matrix)?)?;
            Ok(())
        }.await;
        match result {Ok(())=>{let _=cx.update(|cx|cx.quit());},Err(error)=>{eprintln!("UI_LIBRARY_REVIEW failed: {error:#}");std::process::exit(1);}}
    }).detach();
}

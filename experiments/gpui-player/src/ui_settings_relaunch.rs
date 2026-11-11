//! Hidden audio Settings across a relaunch (Q-05). Native twin of the persistence
//! legs of `audio-devices-e2e.cjs`.
//!
//! Stages, each a fresh process over the same isolated config directory:
//!   choose  - real clicks pick output channels 7 and 8 of a synthetic duplex device;
//!             the choice reaches `audio.json`.
//!   restart - the saved choice is read back and the same Settings controls show it;
//!             merely opening Settings does not rewrite the file.
//!   missing - the saved device is gone from the inventory: the controls say the
//!             saved channel is unavailable instead of quietly adopting another
//!             device, and the file keeps the singer's choice.
//! The inventory is synthetic and no capture or monitoring starts; the driver
//! forbids hardware requests.
use super::ui_training_run::{click, draw};
use super::*;
use std::{path::{Path, PathBuf}, time::Duration};

fn draw_settings(w: &mut Window, cx: &mut App) {
    for _ in 0..3 { w.simulate_next_frame(cx); w.refresh(); let _ = w.draw(cx); }
}
fn inventory(with_duplex: bool) -> audio_devices::Inventory {
    let mut inventory = super::ui_monitor::fixture_inventory();
    inventory.devices.push(audio_devices::Device { uid: "singz:fake-stereo".into(), label: "Muted stereo fixture".into(), inputs: 2, outputs: 2, input_probe_busy: false, output_probe_busy: false });
    if !with_duplex {
        inventory.devices.retain(|d| d.uid != "singz:fake-duplex");
        inventory.default_input = "singz:fake-stereo".into();
        inventory.default_output = "singz:fake-stereo".into();
    }
    inventory
}
fn field(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &'static str) -> anyhow::Result<Bounds<Pixels>> {
    draw_settings(w, cx);
    let b = view.read(cx).settings.read(cx).field_bounds(id).ok_or_else(|| anyhow::anyhow!("Missing {id}"))?;
    w.dispatch_event(PlatformInput::Scroll(ScrollEvent { position: point(px(800.), px(400.)), delta: ScrollDelta::Pixels(point(px(0.), px(210.) - b.center().y)), ..Default::default() }), cx);
    draw_settings(w, cx);
    let b = view.read(cx).settings.read(cx).field_bounds(id).ok_or_else(|| anyhow::anyhow!("Missing scrolled {id}"))?;
    anyhow::ensure!(b.center().y > px(70.) && b.center().y < w.viewport_size().height - px(65.), "{id} is outside the modal viewport: {b:?}");
    Ok(b)
}
fn choose(view: &Entity<Player>, w: &mut Window, cx: &mut App, id: &'static str, index: usize) -> anyhow::Result<()> {
    let b = field(view, w, cx, id)?;
    click(w, cx, b.center());
    draw_settings(w, cx);
    let option = view.read(cx).settings.read(cx).option_bounds(id, index).ok_or_else(|| anyhow::anyhow!("Missing {id} option {index}"))?;
    anyhow::ensure!(option.center().y < w.viewport_size().height - px(35.), "Option outside the viewport");
    click(w, cx, option.center());
    draw_settings(w, cx);
    Ok(())
}
fn describe(view: &Entity<Player>, w: &mut Window, cx: &mut App, config: &Path, stage: &str) -> anyhow::Result<serde_json::Value> {
    draw_settings(w, cx);
    anyhow::ensure!(!w.is_visible() && !w.is_window_active(), "Settings test presented or activated a window");
    let p = view.read(cx);
    anyhow::ensure!(!p.monitor_flight.monitor_requested && !p.mic_requested && !p.mic_permission_requested, "Settings requested hardware");
    let settings = p.settings.read(cx);
    let (prefs, error) = settings.input_preferences_snapshot();
    let state = serde_json::json!({
        "stage": stage, "preferences": prefs.patch(), "preferenceError": error,
        "micPrefsValid": p.mic_prefs_valid, "outputs": p.mic_prefs.outputs, "monitorOutput": p.mic_prefs.monitor_output, "input": p.mic_prefs.input,
        "labels": {
            "left": settings.field_label("settings-output-left"), "right": settings.field_label("settings-output-right"),
            "monitorOutput": settings.field_label("settings-monitor-output"), "channel": settings.field_label("settings-channel"),
        },
        "audioJson": std::fs::read_to_string(config.join("audio.json")).ok(),
        "monitorRequested": p.monitor_flight.monitor_requested, "micRequested": p.mic_requested, "micPermissionRequested": p.mic_permission_requested,
    });
    let _ = w.render_to_image().map(|i| i.save(config.parent().unwrap().join(format!("{stage}.png"))));
    Ok(state)
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_TEST_NO_CAPTURE").is_some() && std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(), "Settings relaunch requires isolated config and disabled capture");
            let config = PathBuf::from(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap());
            let stage = std::env::var("SINGZ_GPUI_SETTINGS_STAGE").unwrap_or_else(|_| "choose".into());
            let deadline = Instant::now() + Duration::from_secs(10);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                if handle.update(cx, |_, _, cx| { let p = view.read(cx); p.mic_prefs_valid && p.settings.read(cx).inventory_revision() > 0 })? { break; }
                anyhow::ensure!(Instant::now() < deadline, "Initial preferences and native inventory did not load");
            }
            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            let with_duplex = stage != "missing";
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| {
                p.screen = Screen::Settings;
                p.notice = None;
                p.settings.update(cx, |s, cx| {
                    s.on_open(cx);
                    s.set_inventory(Ok(inventory(with_duplex)), cx);
                    if stage == "choose" {
                        cx.emit(settings::SettingsEvent::InputPrefs(microphone::Prefs { input: "singz:fake-duplex".into(), monitor_output: "singz:fake-duplex".into(), ..Default::default() }));
                    }
                });
            }))?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            let before = std::fs::read(config.join("audio.json")).ok();
            if stage == "choose" {
                handle.update(cx, |_, w, cx| choose(&view, w, cx, "settings-output-left", 6))??;
                cx.background_executor().timer(Duration::from_millis(60)).await;
                handle.update(cx, |_, w, cx| choose(&view, w, cx, "settings-output-right", 7))??;
                let deadline = Instant::now() + Duration::from_secs(5);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let saved = std::fs::read(config.join("audio.json")).ok().and_then(|bytes| serde_json::from_slice::<serde_json::Value>(&bytes).ok());
                    if saved.as_ref().is_some_and(|raw| raw["monitorOutputUid"] == "singz:fake-duplex" && raw["monitorOutputChannels"] == serde_json::json!([6, 7])) { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Channel choice was not persisted");
                }
            } else {
                // Give a wrong repair or a rewrite-on-open time to happen.
                cx.background_executor().timer(Duration::from_millis(800)).await;
            }
            let state = handle.update(cx, |_, w, cx| describe(&view, w, cx, &config, &stage))??;
            let mut state = state;
            state["audioJsonBeforeOpen"] = before.map(|b| String::from_utf8_lossy(&b).into_owned()).into();
            std::fs::write(out.join("state.json"), serde_json::to_vec_pretty(&state)?)?;
            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({"done": true, "stage": stage}))?)?;
            Ok(())
        }
        .await;
        if let Err(error) = result {
            eprintln!("NATIVE_SETTINGS_RELAUNCH failed: {error:#}");
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    })
    .detach();
}

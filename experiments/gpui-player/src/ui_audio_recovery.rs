//! Hidden owned-helper transport-loss regression; no hardware hotplug or parity claim.
use super::ui_training_run::{click, draw, header_control};
use super::*;
use anyhow::Context as _;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    path::{Path, PathBuf},
    sync::Arc,
    time::Duration,
};

const DRAFT: &str = "Recovered draft survives owned helper loss";
const WORKING_DRAFT: &str = "Offline working lyric survives publication";
const MISSING_ROUTE: &str = "singz:ui-test-output-that-does-not-exist";

fn hash(bytes: impl AsRef<[u8]>) -> String {
    Sha256::digest(bytes.as_ref())
        .iter()
        .map(|byte| format!("{byte:02x}"))
        .collect()
}

fn env_path(name: &str) -> anyhow::Result<PathBuf> {
    std::env::var_os(name)
        .map(PathBuf::from)
        .ok_or_else(|| anyhow::anyhow!("Missing required isolated fixture variable {name}"))
}

fn screen(player: &Player) -> &'static str {
    match player.screen {
        Screen::Training => "training",
        Screen::Player => "player",
        Screen::Library => "library",
        Screen::Settings => "settings",
        Screen::Log => "log",
        Screen::Models => "models",
    }
}

fn snapshot(view: &Entity<Player>, window: &Window, cx: &App) -> Value {
    let player = view.read(cx);
    let (_, output_uid, route_busy, route_error) = player.settings.read(cx).native_snapshot();
    let viewport = window.viewport_size();
    let lyric_offset = player.lyric_scroll_handle.offset();
    let native = player.last_playback_status.as_ref().map(|status| {
        json!({
            "playing": status.playing,
            "position": status.position,
            "duration": status.duration,
            "rate": status.rate,
            "transpose": status.transpose,
            "loop": status.loop_range,
            "seekCount": status.seek_count,
            "loopCount": status.loop_count,
            "graph": status.graph_generation,
            "laneRevision": status.lane_revision,
            "renderedFrame": status.rendered_frame,
            "countingIn": status.counting_in,
            "outputUid": status.output_uid,
            "outputLabel": status.output_label,
            "observedLanes": status.observed_lanes,
            "sampleAgeMs": status.sampled_at.elapsed().as_secs_f64() * 1000.,
        })
    });
    let mut state=json!({
        "viewport": [f32::from(viewport.width), f32::from(viewport.height)],
        "scale": window.scale_factor(),
        "windowPresented": window.is_visible(),
        "windowActive": window.is_window_active(),
        "hidden": !window.is_visible() && !window.is_window_active(),
        "hiddenConfigured": std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),
        "mutedConfigured": std::env::var("SINGZ_MUTE").as_deref() == Ok("1"),
        "screen": screen(player),
        "epoch": player.native_epoch,
        "project": player.project.as_ref().map(|project| json!({
            "dir": project.dir,
            "name": project.name,
            "metadataHash": project.metadata_hash,
            "original": project.original,
            "lanes": project.lanes.iter().map(|(slot, path)| json!({"slot": slot, "path": path})).collect::<Vec<_>>(),
            "selection": project.selection,
        })),
        "loadedSong": player.loaded_song,
        "loading": player.loading,
        "playing": player.playing,
        "position": player.position,
        "duration": player.duration,
        "countingIn": player.counting_in,
        "pendingSeek": player.pending_seek,
        "editSeq": player.edit_seq,
        "savedSeq": player.saved_seq,
        "saving": player.saving,
        "notice": player.notice,
        "tracksAudioFailed": player.tracks_audio_failed,
        "audioRecoveryPending": player.audio_recovery.is_some(),
        "sourceState": {
            "working": player.source_working,
            "target": player.source_target.as_ref().map(|target| target.dir.clone()),
            "job": player.source_job,
            "jobSaving": player.source_saving,
            "publicationPending": player.source_publication.is_some(),
        },
        "mix": {
            "master": player.master_volume,
            "gain": player.gain.as_slice(),
            "muted": player.muted.as_slice(),
            "solo": player.solo.as_slice(),
            "tempo": player.tempo,
            "transpose": player.transpose,
            "looping": player.looping,
            "nativeRate": player.native_rate,
            "nativeLoop": player.native_loop,
            "view": [player.view_start, player.view_end],
        },
        "settings": {"outputUid": output_uid, "routeBusy": route_busy, "routeError": route_error},
        "native": native,
        "editorOpen": player.lyrics_editor_open,
        "editorGeneration": player.lyrics_editor_generation,
        "editorEpoch": player.lyrics_editor_epoch,
        "editor": player.lyrics_editor.read(cx).state(window, cx),
        "lyricArc": Arc::as_ptr(&player.lyric_document) as usize,
        "lyricLines": player.lyric_document.lines.iter().map(|line| json!({"text": line.text, "start": line.start, "end": line.end})).collect::<Vec<_>>(),
        "lyricScroll": [player.lyric_scroll.get(), player.lyric_scroll_target.get()],
        "lyricScrollHandle": [f32::from(lyric_offset.x), f32::from(lyric_offset.y)],
        "lyricActive": player.lyric_active.get(),
        "karaoke": player.karaoke,
        "sidebar": player.lyrics_sidebar.read(cx).state(window, cx),
        "productionParity": "not evaluated; functional candidate captures only",
        "liveFps": "unmeasured in hidden window",
        "faultScope": if std::env::var("SINGZ_GPUI_AUDIO_RECOVERY_PHASE").as_deref()==Ok("working-live") {
            "real metadata-read failure with healthy owned audio helper; not hardware hotplug qualification"
        } else { "simulated death of this backend's owned audio child; not hardware hotplug qualification" },
    });
    state["noticeRootFocused"]=json!(player.notice.is_some() && player.focus_handle.is_focused(window));
    state["headerSaveEnabled"]=json!(player.header.read(cx).save_enabled());
    state["rendererHeldSaveProgress"]=json!(player.source_job==Some(u64::MAX)&&player.source_saving);
    state
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
        "Recovery capture presented or activated the hidden window"
    );
    let png = out.join(format!("{name}.png"));
    let image = window.render_to_image()?;
    let image_pixels = [image.width(), image.height()];
    image.save(&png)?;
    let fixture = env_path("SINGZ_GPUI_AUDIO_RECOVERY_FIXTURE")?;
    let mut state = snapshot(view, window, cx);
    state["caseId"] = json!(name);
    state["imagePixels"] = json!(image_pixels);
    state["zoom"] = json!(1.);
    state["captureMethod"] = json!("hidden GPUI Window::render_to_image");
    state["colorSpace"] = json!("raw sRGB GPUI offscreen scene");
    state["screenshotSha256"] = json!(hash(std::fs::read(&png)?));
    state["fixtureSha256"] = json!(hash(std::fs::read(fixture)?));
    state["binarySha256"] = json!(hash(std::fs::read(std::env::current_exe()?)?));
    state["testSourceSha256"] = json!(hash(include_bytes!("ui_audio_recovery.rs")));
    state["os"] = json!(std::env::consts::OS);
    state["architecture"] = json!(std::env::consts::ARCH);
    std::fs::write(
        out.join(format!("{name}.state.json")),
        serde_json::to_vec_pretty(&state)?,
    )?;
    Ok(())
}

#[derive(Clone, Debug)]
struct Retained {
    epoch: u64,
    dir: PathBuf,
    metadata_hash: String,
    edit_seq: u64,
    saved_seq: u64,
    editor_generation: u64,
    editor_epoch: u64,
    editor_revision: u64,
    editor_rows: Vec<lyrics_edit::DraftRow>,
    editor_inputs: Vec<String>,
    editor_dirty: bool,
    lyric_arc: usize,
    lyric_scroll: (f32, f32),
    lyric_handle: (f32, f32),
    lyric_active: usize,
    position: f64,
    duration: f64,
    screen: u8,
    karaoke: bool,
    master: f32,
    gain: Vec<u8>,
    muted: Vec<bool>,
    solo: Vec<bool>,
    tempo: f32,
    transpose: i32,
    looping: bool,
    selection: Option<(f64, f64)>,
    view: (f64, f64),
}

fn retained(view: &Entity<Player>, cx: &App) -> Retained {
    let player = view.read(cx);
    let editor = player.lyrics_editor.read(cx);
    let project = player.project.as_ref().expect("retained project");
    let lyric_offset = player.lyric_scroll_handle.offset();
    Retained {
        epoch: player.native_epoch,
        dir: project.dir.clone(),
        metadata_hash: project.metadata_hash.clone(),
        edit_seq: player.edit_seq,
        saved_seq: player.saved_seq,
        editor_generation: player.lyrics_editor_generation,
        editor_epoch: player.lyrics_editor_epoch,
        editor_revision: editor.revision(),
        editor_rows: editor.rows().to_vec(),
        editor_inputs: editor
            .rows()
            .iter()
            .filter_map(|row| editor.input(row.id))
            .map(|input| input.read(cx).value().to_string())
            .collect(),
        editor_dirty: editor.dirty,
        lyric_arc: Arc::as_ptr(&player.lyric_document) as usize,
        lyric_scroll: (player.lyric_scroll.get(), player.lyric_scroll_target.get()),
        lyric_handle: (f32::from(lyric_offset.x), f32::from(lyric_offset.y)),
        lyric_active: player.lyric_active.get(),
        position: player.position,
        duration: player.duration,
        screen: player.screen as u8,
        karaoke: player.karaoke,
        master: player.master_volume,
        gain: player.gain.to_vec(),
        muted: player.muted.to_vec(),
        solo: player.solo.to_vec(),
        tempo: player.tempo,
        transpose: player.transpose,
        looping: player.looping,
        selection: project.selection,
        view: (player.view_start, player.view_end),
    }
}

fn ensure_retained(before: &Retained, after: &Retained, stage: &str) -> anyhow::Result<()> {
    macro_rules! same {
        ($field:ident) => {
            anyhow::ensure!(
                before.$field == after.$field,
                "{stage} changed retained {}: {:?} -> {:?}",
                stringify!($field),
                before.$field,
                after.$field
            );
        };
    }
    same!(epoch);
    same!(dir);
    same!(metadata_hash);
    same!(edit_seq);
    same!(saved_seq);
    same!(editor_generation);
    same!(editor_epoch);
    same!(editor_revision);
    same!(editor_rows);
    same!(editor_inputs);
    same!(editor_dirty);
    same!(lyric_arc);
    same!(lyric_scroll);
    same!(lyric_handle);
    same!(lyric_active);
    same!(duration);
    same!(screen);
    same!(karaoke);
    same!(master);
    same!(gain);
    same!(muted);
    same!(solo);
    same!(tempo);
    same!(transpose);
    same!(looping);
    same!(selection);
    same!(view);
    Ok(())
}

fn transport_button(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    let bounds = view
        .read(cx)
        .transport
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Transport control {id} was not measured"))?;
    anyhow::ensure!(
        bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= window.viewport_size().width
            && bounds.bottom() <= window.viewport_size().height,
        "Transport control {id} is outside the viewport: {bounds:?}"
    );
    click(window, cx, bounds.center());
    Ok(())
}

fn editor_button(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    let bounds = view
        .read(cx)
        .lyrics_editor
        .read(cx)
        .bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Lyrics editor control {id} was not measured"))?;
    anyhow::ensure!(
        bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= window.viewport_size().width
            && bounds.bottom() <= window.viewport_size().height,
        "Lyrics editor control {id} is outside the viewport: {bounds:?}"
    );
    click(window, cx, bounds.center());
    Ok(())
}

fn settings_button(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    id: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    let bounds = view
        .read(cx)
        .settings
        .read(cx)
        .field_bounds(id)
        .ok_or_else(|| anyhow::anyhow!("Settings control {id} lacks its ui-tests bounds probe"))?;
    anyhow::ensure!(
        bounds.left() >= px(0.)
            && bounds.top() >= px(0.)
            && bounds.right() <= window.viewport_size().width
            && bounds.bottom() <= window.viewport_size().height,
        "Settings control {id} is outside the viewport: {bounds:?}"
    );
    click(window, cx, bounds.center());
    Ok(())
}

fn open_editor(view: &Entity<Player>, window: &mut Window, cx: &mut App) -> anyhow::Result<()> {
    draw(window, cx);
    anyhow::ensure!(
        view.read(cx).karaoke,
        "Karaoke did not expose lyrics editing"
    );
    let mut bounds = view
        .read(cx)
        .lyrics_sidebar
        .read(cx)
        .bounds("lyrics-edit")
        .ok_or_else(|| anyhow::anyhow!("The actual lyrics Edit action was not measured"))?;
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
                .ok_or_else(|| anyhow::anyhow!("Lyrics Edit disappeared after scrolling"))?;
        }
        anyhow::ensure!(
            body.contains(&bounds.center()),
            "Lyrics Edit remains clipped by the actual sidebar body"
        );
    }
    click(window, cx, bounds.center());
    Ok(())
}

fn replace_first_row(
    view: &Entity<Player>,
    window: &mut Window,
    cx: &mut App,
    text: &str,
) -> anyhow::Result<()> {
    draw(window, cx);
    let player = view.read(cx);
    let editor = player.lyrics_editor.read(cx);
    let row = editor
        .rows()
        .first()
        .ok_or_else(|| anyhow::anyhow!("Lyrics editor has no first row"))?;
    let input = editor
        .input(row.id)
        .ok_or_else(|| anyhow::anyhow!("First lyric InputState is not mounted"))?;
    input.update(cx, |state, cx| {
        state.focus(window, cx);
        state.replace_all(text.to_owned(), window, cx);
    });
    Ok(())
}

fn lane_accepted(player: &Player, gain: f64, muted: bool) -> bool {
    player
        .last_playback_status
        .as_ref()
        .and_then(|status| status.observed_lanes.as_array())
        .is_some_and(|lanes| {
            lanes.iter().any(|lane| {
                lane["id"] == "vocals"
                    && lane["muted"] == muted
                    && lane["gain"]
                        .as_f64()
                        .is_some_and(|value| (value - gain).abs() < 0.0001)
            })
        })
}

fn original_lane_accepted(player: &Player, gain: f64) -> bool {
    player
        .last_playback_status
        .as_ref()
        .and_then(|status| status.observed_lanes.as_array())
        .is_some_and(|lanes| {
            lanes.iter().any(|lane| {
                lane["id"] == "original"
                    && lane["gain"]
                        .as_f64()
                        .is_some_and(|value| (value - gain).abs() < 0.0001)
            })
        })
}

fn native_paused(
    player: &Player,
    uid: &str,
    position: f64,
    rate: f32,
    transpose: i32,
    looping: bool,
) -> bool {
    !player.tracks_audio_failed
        && player.audio_recovery.is_none()
        && !player.playing
        && player.last_playback_status.as_ref().is_some_and(|status| {
            !status.playing
                && !status.counting_in
                && status.output_uid == uid
                && (status.position - position).abs() <= 0.03
                && (status.rate - rate).abs() < 0.0001
                && status.transpose == transpose
                && status.loop_range.is_some() == looping
        })
}

/// Deterministic real I/O fault between an owned writer's completed publication
/// and its reader. Only this hidden test can arm the ui-tests-only Player field.
pub(super) fn quarantine_publication(
    output: &source_jobs::Output,
    receipt: &Path,
) -> anyhow::Result<()> {
    anyhow::ensure!(
        std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
            && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(),
        "Publication fault requires a muted hidden test"
    );
    let root = integration::library_root().canonicalize()?;
    let dir = output.path.canonicalize()?;
    anyhow::ensure!(
        dir.parent() == Some(root.as_path()),
        "Fault publication is outside the isolated library"
    );
    let metadata = dir.join("project.json");
    let held = dir.join("project.json.ui-test-held");
    anyhow::ensure!(!held.exists(), "Publication quarantine already exists");
    let bytes = std::fs::read(&metadata)?;
    let expected = output
        .publication_hash
        .as_ref()
        .ok_or_else(|| anyhow::anyhow!("Writer did not supply publication identity"))?;
    anyhow::ensure!(
        hash(&bytes) == *expected,
        "Writer receipt does not identify published metadata"
    );
    std::fs::rename(&metadata, &held)?;
    std::fs::write(
        receipt,
        serde_json::to_vec_pretty(
            &json!({"publishedDir":dir,"metadata":metadata,"heldMetadata":held,"metadataSha256":expected,"fault":"quarantined exact writer metadata before real reader"}),
        )?,
    )?;
    Ok(())
}
/// Renderer-only adapter for the real state combination of a native error above
/// Save progress. No writer/commit/cancellation behavior is claimed by this frame.
fn notice_above_progress(view:&Entity<Player>,window:&mut Window,cx:&mut App,out:&Path)->anyhow::Result<()> {
    let previous=view.update(cx,|p,cx|->anyhow::Result<_>{
        anyhow::ensure!(p.source_job.is_none()&&p.notice.is_some(),"Progress overlap adapter requires an idle retained failure");
        let previous=(p.source_saving,p.source_status.clone());
        p.source_job=Some(u64::MAX);p.source_saving=true;
        p.source_status=Arc::new(source_jobs::Snapshot{generation:u64::MAX,busy:true,label:"Saving project…".into(),percent:40.,..(*previous.1).clone()});
        cx.notify();Ok(previous)
    })?;
    draw(window,cx);
    capture(view,window,cx,out,"publication-notice-over-save-progress-1060")?;
    let bounds=view.read(cx).notice_close_bounds.get().ok_or_else(||anyhow::anyhow!("Notice Close was not measured above progress"))?;
    anyhow::ensure!(bounds.left()>=px(0.)&&bounds.top()>=px(0.)&&bounds.right()<=window.viewport_size().width&&bounds.bottom()<=window.viewport_size().height,"Notice Close is outside viewport");
    click(window,cx,bounds.center());
    view.update(cx,|p,cx|->anyhow::Result<()>{
        anyhow::ensure!(p.notice.is_none()&&p.source_job==Some(u64::MAX)&&p.source_saving,"Progress covered Notice Close or closing the notice cancelled progress");
        p.source_job=None;p.source_saving=previous.0;p.source_status=previous.1;cx.notify();Ok(())
    })?;
    draw(window,cx);Ok(())
}

fn escape(window: &mut Window, cx: &mut App) {
    draw(window, cx);
    window.dispatch_event(
        PlatformInput::KeyDown(KeyDownEvent {
            keystroke: Keystroke::parse("escape").unwrap(),
            is_held: false,
            prefer_character_input: false,
        }),
        cx,
    );
}

fn write_result(out: &Path, value: Value) -> anyhow::Result<()> {
    std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&value)?)?;
    Ok(())
}

fn probe_value(probe: &integration::OwnedAudioProbe, stage: &str, index: usize) -> Value {
    let status=&probe.status;
    json!({"stage":stage,"index":index,"epoch":probe.epoch,"helperPid":probe.helper_pid,
        "monitorLeased":probe.monitor_leased,"activeTraining":probe.active_training,
        "playing":status.playing,"position":status.position,"renderedFrame":status.rendered_frame,
        "outputUid":status.output_uid,"rate":status.rate,"transpose":status.transpose,
        "loop":status.loop_range,"trainingOnly":status.training_only,"cueActive":status.cue.active,
        "graphGeneration":status.graph_generation,"laneRevision":status.lane_revision,
        "seekCount":status.seek_count,"audibleCurrent":status.audible_current,
        "sampleAgeSeconds":status.sampled_at.elapsed().as_secs_f64(),
        "method":"fresh backend-owned helper status command before host admission"})
}

fn unleased_probe(probe: &integration::OwnedAudioProbe, epoch: u64, uid: &str) -> anyhow::Result<()> {
    anyhow::ensure!(probe.epoch==epoch && !probe.monitor_leased && probe.active_training.is_none()
        && !probe.status.training_only && !probe.status.cue.active && probe.status.output_uid==uid,
        "Live publication probe has a different epoch/route or training/monitor owner");
    anyhow::ensure!(probe.status.sampled_at.elapsed()<Duration::from_secs(1),"Native probe is stale");
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    assert!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some());
    assert!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
    assert!(!integration::fixture_mode());
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let phase = std::env::var("SINGZ_GPUI_AUDIO_RECOVERY_PHASE")?;
            let publication_fault=std::env::var("SINGZ_GPUI_AUDIO_RECOVERY_PUBLICATION_FAULT").as_deref()==Ok("1");
            let config = env_path("SINGZ_GPUI_CONFIG_DIR")?;
            let saved = env_path("SINGZ_GPUI_AUDIO_RECOVERY_PROJECT")?.canonicalize()?;
            let preferences_path = config.join("audio.json");
            macro_rules! wait {
                ($seconds:expr, $player:ident, $window:ident, $app:ident => $predicate:expr) => {{
                    let deadline = Instant::now() + Duration::from_secs($seconds);
                    loop {
                        cx.background_executor().timer(Duration::from_millis(20)).await;
                        let ready = handle.update(cx, |_, $window, $app| {
                            draw($window, $app);
                            let $player = view.read($app);
                            let _ = (&$player, &$window, &$app);
                            $predicate
                        })?;
                        if ready {
                            break;
                        }
                        if Instant::now() >= deadline {
                            let actual = handle.update(cx, |_, window, cx| snapshot(&view, window, cx))?;
                            anyhow::bail!("Audio recovery wait timed out: {}; actual: {}", stringify!($predicate), actual);
                        }
                    }
                }};
            }
            macro_rules! shot {
                ($name:expr) => {
                    handle.update(cx, |_, window, cx| capture(&view, window, cx, &out, $name))??
                };
            }
            macro_rules! transport {
                ($id:expr) => {
                    handle.update(cx, |_, window, cx| transport_button(&view, window, cx, $id))??
                };
            }
            macro_rules! editor {
                ($id:expr) => {
                    handle.update(cx, |_, window, cx| editor_button(&view, window, cx, $id))??
                };
            }
            macro_rules! settings {
                ($id:expr) => {
                    handle.update(cx, |_, window, cx| settings_button(&view, window, cx, $id))??
                };
            }
            macro_rules! probe {
                () => {{
                    let receiver=handle.update(cx,|_,_,app|->anyhow::Result<_>{
                        let player=view.read(app);
                        player.backend.as_ref().context("Missing live publication backend")?.probe_owned_audio(player.native_epoch)
                    })??;
                    let deadline=Instant::now()+Duration::from_secs(8);
                    loop {
                        match receiver.try_recv() {
                            Ok(result)=>break result.map_err(anyhow::Error::msg)?,
                            Err(std::sync::mpsc::TryRecvError::Disconnected)=>anyhow::bail!("Native probe reply disconnected"),
                            Err(std::sync::mpsc::TryRecvError::Empty)=>{}
                        }
                        anyhow::ensure!(Instant::now()<deadline,"Native probe reply timed out");
                        cx.background_executor().timer(Duration::from_millis(20)).await;
                    }
                }};
            }

            match phase.as_str() {
                "retained" => {
                    handle.update(cx, |_, window, _| window.resize(size(px(1280.), px(800.))))?;
                    wait!(5, player, window, app => window.viewport_size() == size(px(1280.), px(800.)));
                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.open_project(saved.clone(), cx)))?;
                    wait!(30, player, window, app => !player.loading
                        && player.project.as_ref().is_some_and(|project| project.dir == saved)
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing && status.duration >= 10.));
                    let target_uid = handle.update(cx, |_, _, cx| -> anyhow::Result<String> {
                        let player = view.read(cx);
                        anyhow::ensure!(player.notice.is_none(), "Initial project notice: {:?}", player.notice);
                        anyhow::ensure!(player.last_playback_status.is_some(), "Missing initial native receipt");
                        let inventory = player.settings.read(cx).native_snapshot().0.ok_or_else(|| anyhow::anyhow!("Missing native output inventory"))?;
                        let uid = inventory.devices.iter().find(|device| device.outputs > 0).map(|device| device.uid.clone()).ok_or_else(|| anyhow::anyhow!("No native output is available for the isolated recovery test"))?;
                        anyhow::ensure!(uid != MISSING_ROUTE, "Fixture route collides with the invalid UID");
                        Ok(uid)
                    })??;
                    let initial_project_hash = hash(std::fs::read(saved.join("project.json"))?);
                    let preferences_before = std::fs::read(&preferences_path)?;

                    transport!("transport-play");
                    wait!(8, player, window, app => player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| status.playing && status.position > 0.08 && status.rendered_frame >= 0));
                    transport!("transport-play");
                    wait!(8, player, window, app => !player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing));

                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| {
                        player.native_transport(transport::TransportEvent::Volume(0.63), cx);
                        player.gain[0] = 47;
                        player.muted[0] = true;
                        player.solo[0] = false;
                        player.sync_lane(0, cx);
                        player.native_transport(transport::TransportEvent::Loop, cx);
                        player.native_transport(transport::TransportEvent::Tempo(0.8), cx);
                        player.native_transport(transport::TransportEvent::Transpose(2), cx);
                        player.position = 2.5;
                        player.seek_native(cx);
                    }))?;
                    wait!(15, player, window, app => player.native_rate_pending.is_none()
                        && player.native_rate_queued.is_none()
                        && player.pending_seek.is_none()
                        && player.edit_seq > player.saved_seq
                        && (player.position - 2.5).abs() < 0.03
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing
                            && (status.rate - 0.8).abs() < 0.0001
                            && status.transpose == 2
                            && status.loop_range == Some((1., 10.))
                            && (status.position - 2.5).abs() < 0.03)
                        && lane_accepted(player, 0.47, true));
                    wait!(10, player, window, app => player.lyrics_sidebar.read(app).is_ready());
                    handle.update(cx, |_, window, cx| open_editor(&view, window, cx))??;
                    wait!(10, player, window, app => player.lyrics_editor_open && !player.lyrics_editor.read(app).rows().is_empty());
                    handle.update(cx, |_, window, cx| replace_first_row(&view, window, cx, DRAFT))??;
                    wait!(5, player, window, app => player.lyrics_editor.read(app).revision() == 1
                        && player.lyrics_editor.read(app).dirty
                        && player.lyrics_editor.read(app).rows()[0].text == DRAFT);
                    let before = handle.update(cx, |_, window, cx| {
                        draw(window, cx);
                        retained(&view, cx)
                    })?;
                    anyhow::ensure!(before.editor_inputs == vec![DRAFT.to_owned(), "Second fixture line".to_owned(), "Third fixture line".to_owned()]);
                    shot!("retained-draft-before-fault-1280");

                    handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                        let player = view.read(cx);
                        player.backend.as_ref().ok_or_else(|| anyhow::anyhow!("Missing owned backend"))?.fail_owned_audio(player.native_epoch)
                    })??;
                    wait!(10, player, window, app => player.tracks_audio_failed
                        && !player.playing
                        && player.lyrics_editor_open
                        && player.last_playback_status.is_none()
                        && player.notice.as_ref().is_some_and(|notice| notice.contains("retained")));
                    cx.background_executor().timer(Duration::from_millis(150)).await;
                    let failed = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    ensure_retained(&before, &failed, "Owned helper death")?;
                    anyhow::ensure!((failed.position - before.position).abs() < 0.0001, "Stopped clock advanced after helper death: {} -> {}", before.position, failed.position);
                    shot!("retained-draft-audio-failed-1280");
                    if publication_fault {
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(!p.lyrics_editor.read(cx).text_input_focused(w,cx),"Error notice left its underlying lyric input focused");w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent{keystroke:Keystroke::parse("space").unwrap(),is_held:false,prefer_character_input:false}),cx);Ok(())})??;
                        let guarded=handle.update(cx,|_,_,cx|retained(&view,cx))?;
                        ensure_retained(&failed,&guarded,"Notice keyboard barrier")?;
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&p.lyrics_editor_open&&p.lyrics_editor.read(cx).text_input_focused(w,cx)&&p.lyrics_editor.read(cx).rows()[0].text==DRAFT,"Notice dismissal lost editor draft or mounted input focus");Ok(())})??;
                        shot!("retained-notice-dismissed-editor-focused-1280");
                    }

                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.select_output(MISSING_ROUTE.into(), cx)))?;
                    wait!(15, player, window, app => player.audio_recovery.is_none()
                        && player.tracks_audio_failed
                        && player.notice.as_ref().is_some_and(|notice| notice.contains("Output recovery failed"))
                        && player.settings.read(app).native_snapshot().2 == false
                        && player.settings.read(app).native_snapshot().3.is_some());
                    anyhow::ensure!(std::fs::read(&preferences_path)? == preferences_before, "Invalid recovery changed audio preference bytes");
                    anyhow::ensure!(hash(std::fs::read(saved.join("project.json"))?) == initial_project_hash, "Invalid recovery changed project bytes");
                    let rejected = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    ensure_retained(&before, &rejected, "Rejected output recovery")?;
                    shot!("retained-invalid-route-1280");

                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.select_output(target_uid.clone(), cx)))?;
                    wait!(20, player, window, app => native_paused(player, &target_uid, 2.5, 0.8, 2, true)
                        && player.native_loop == Some((1., 10.))
                        && lane_accepted(player, 0.47, true)
                        && player.notice.is_none()
                        && player.settings.read(app).native_snapshot().1 == target_uid
                        && player.settings.read(app).native_snapshot().3.is_none());
                    let recovered = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    ensure_retained(&before, &recovered, "Successful output recovery")?;
                    anyhow::ensure!((recovered.position - before.position).abs() <= 0.03, "Recovery moved retained position: {} -> {}", before.position, recovered.position);
                    let accepted_preferences: Value = serde_json::from_slice(&std::fs::read(&preferences_path)?)?;
                    anyhow::ensure!(accepted_preferences["outputUid"] == target_uid && accepted_preferences["future"] == "preserve-audio-preferences", "Valid recovery did not persist only the accepted route");
                    shot!("retained-recovered-draft-1280");

                    editor!("lyed-play");
                    wait!(8, player, window, app => player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| status.playing && !status.counting_in && status.position > before.position + 0.06 && status.rendered_frame >= 0));
                    let advance_from = before.position;
                    let advance_to = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                    shot!("retained-native-playing-1280");
                    editor!("lyed-play");
                    wait!(8, player, window, app => !player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing));
                    editor!("lyed-save");
                    wait!(15, player, window, app => !player.lyrics_editor_open
                        && player.lyric_document.lines.first().is_some_and(|line| line.text == DRAFT));
                    let after_editor_project_hash = hash(std::fs::read(saved.join("project.json"))?);
                    let after_editor_lyrics_hash = hash(std::fs::read(saved.join("lyrics.json"))?);
                    anyhow::ensure!(after_editor_project_hash == initial_project_hash, "Independent lyric Save rewrote project metadata");
                    shot!("retained-independent-lyric-save-1280");

                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.save_project(cx)))?;
                    wait!(20, player, window, app => !player.saving
                        && player.saved_seq == player.edit_seq
                        && player.edit_seq > 0
                        && player.notice.is_none());
                    let final_project_bytes = std::fs::read(saved.join("project.json"))?;
                    let final_project: Value = serde_json::from_slice(&final_project_bytes)?;
                    anyhow::ensure!(final_project["settings"]["tempo"] == 0.8
                        && final_project["settings"]["transpose"] == 2
                        && final_project["settings"]["loop"] == true
                        && final_project["settings"]["selection"]["s"] == 1.
                        && final_project["settings"]["selection"]["e"] == 10.
                        && final_project["settings"]["masterVolume"] == 0.63
                        && final_project["settings"]["tracks"]["vocals"]["volume"] == 0.47
                        && final_project["settings"]["tracks"]["vocals"]["muted"] == true,
                        "Project Save lost retained mix: {final_project}");
                    anyhow::ensure!(hash(std::fs::read(saved.join("lyrics.json"))?) == after_editor_lyrics_hash, "Project Save rewrote independently saved lyrics");
                    shot!("retained-project-saved-1280");

                    handle.update(cx, |_, window, cx| header_control(&view, window, cx, "settings"))??;
                    wait!(5, player, window, app => player.screen == Screen::Settings);
                    settings!("settings-output");
                    wait!(5, player, window, app => player.settings.read(app).smoke_snapshot().4 == Some("settings-output"));
                    shot!("retained-settings-selector-1280");
                    handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                        draw(window, cx);
                        let bounds = view.read(cx).settings.read(cx).field_bounds("settings-output").ok_or_else(|| anyhow::anyhow!("Output field bounds disappeared"))?;
                        let option = point(bounds.center().x, bounds.bottom() + px(44.));
                        anyhow::ensure!(option.y < window.viewport_size().height, "First native output option is outside the viewport: {option:?}");
                        click(window, cx, option);
                        Ok(())
                    })??;
                    let settings_position = handle.update(cx, |_, _, cx| view.read(cx).position)?;
                    wait!(20, player, window, app => native_paused(player, &target_uid, settings_position, 0.8, 2, true)
                        && player.native_loop == Some((1., 10.))
                        && player.settings.read(app).native_snapshot().1 == target_uid
                        && player.settings.read(app).native_snapshot().3.is_none());
                    let route_preferences = std::fs::read(&preferences_path)?;
                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.select_output(MISSING_ROUTE.into(), cx)))?;
                    wait!(15, player, window, app => player.audio_recovery.is_none()
                        && !player.tracks_audio_failed
                        && player.notice.is_none()
                        && player.settings.read(app).native_snapshot().3.is_some()
                        && player.last_playback_status.as_ref().is_some_and(|status| status.output_uid == target_uid));
                    anyhow::ensure!(std::fs::read(&preferences_path)? == route_preferences, "Alive-helper invalid route changed preference bytes");
                    shot!("retained-settings-route-error-1280");
                    settings!("settings-retry");
                    wait!(20, player, window, app => native_paused(player, &target_uid, settings_position, 0.8, 2, true)
                        && player.native_loop == Some((1., 10.))
                        && player.settings.read(app).native_snapshot().3.is_none()
                        && player.saved_seq == player.edit_seq);
                    shot!("retained-settings-retried-1280");
                    handle.update(cx, |_, _, cx| { let settings=view.read(cx).settings.clone(); settings.update(cx, |_, cx| cx.emit(settings::SettingsEvent::Close)); })?;
                    wait!(5, player, window, app => player.screen == Screen::Player);

                    write_result(&out, json!({
                        "phase": phase,
                        "selectedUid": target_uid,
                        "initialProjectSha256": initial_project_hash,
                        "afterEditorProjectSha256": after_editor_project_hash,
                        "afterEditorLyricsSha256": after_editor_lyrics_hash,
                        "finalProjectSha256": hash(&final_project_bytes),
                        "finalLyricsSha256": hash(std::fs::read(saved.join("lyrics.json"))?),
                        "draft": DRAFT,
                        "documentDraftMixRetained": true,
                        "stoppedClockRetained": true,
                        "invalidRecoveryPreferencesUnchanged": true,
                        "validRecoveryNativePaused": true,
                        "noticeKeyboardBarrierAndEditorFocusReturn": publication_fault,
                        "nativePlaybackAfterRecovery": true,
                        "nativeAdvance": {"from": advance_from, "to": advance_to},
                        "independentEditorSaveDistinctFromProjectSave": true,
                        "settingsSelectorClicked": true,
                        "settingsRetryClicked": true,
                        "sizes": [[1280, 800]],
                        "hidden": true,
                        "muted": true,
                        "hardwareHotplugQualified": false,
                        "productionParity": "not evaluated",
                        "liveFps": "unmeasured",
                    }))?;
                }
                "restart" => {
                    handle.update(cx, |_, window, _| window.resize(size(px(1060.), px(640.))))?;
                    wait!(5, player, window, app => window.viewport_size() == size(px(1060.), px(640.)));
                    let expected_hash = hash(std::fs::read(saved.join("project.json"))?);
                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.open_project(saved.clone(), cx)))?;
                    wait!(30, player, window, app => !player.loading
                        && player.project.as_ref().is_some_and(|project| project.dir == saved)
                        && player.lyric_document.lines.first().is_some_and(|line| line.text == DRAFT)
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing
                            && (status.rate - 0.8).abs() < 0.0001
                            && status.transpose == 2
                            && status.loop_range == Some((1., 10.)))
                        && lane_accepted(player, 0.47, true));
                    handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                        let player = view.read(cx);
                        anyhow::ensure!(player.master_volume == 0.63 && player.tempo == 0.8 && player.transpose == 2 && player.looping && player.gain[0] == 47 && player.muted[0], "Restart did not adopt saved mix");
                        anyhow::ensure!(player.edit_seq == 0 && player.saved_seq == 0, "Restart reopened a dirty project");
                        anyhow::ensure!(player.project.as_ref().unwrap().metadata_hash == expected_hash, "Restart changed saved metadata before opening");
                        Ok(())
                    })??;
                    let target_uid = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().output_uid.clone())?;
                    shot!("restart-saved-mix-lyrics-1060");
                    transport!("transport-play");
                    wait!(8, player, window, app => player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| status.playing && status.position > 0.08 && status.rendered_frame >= 0));
                    let advance_from = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                    wait!(8, player, window, app => player.last_playback_status.as_ref().is_some_and(|status| status.playing && status.position > advance_from + 0.06));
                    let advance_to = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                    shot!("restart-native-playing-1060");
                    transport!("transport-play");
                    wait!(8, player, window, app => !player.playing && player.last_playback_status.as_ref().is_some_and(|status| !status.playing));

                    let invalid = env_path("SINGZ_GPUI_AUDIO_RECOVERY_INVALID")?;
                    let old_epoch = handle.update(cx, |_, _, cx| view.read(cx).native_epoch)?;
                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| player.open_project(invalid, cx)))?;
                    wait!(15, player, window, app => player.native_epoch != old_epoch
                        && !player.loading
                        && player.project.is_none()
                        && !player.playing
                        && !player.loaded_song
                        && player.screen == Screen::Library
                        && player.lyric_document.lines.is_empty()
                        && player.notice.as_ref().is_some_and(|notice| notice.contains("Unsupported project version")));
                    let invalid_notice = handle.update(cx, |_, _, cx| view.read(cx).notice.clone().unwrap())?;
                    shot!("restart-invalid-new-open-1060");
                    anyhow::ensure!(hash(std::fs::read(saved.join("project.json"))?) == expected_hash, "Invalid new Open changed the previously saved project");
                    write_result(&out, json!({
                        "phase": phase,
                        "savedProjectSha256": expected_hash,
                        "selectedUid": target_uid,
                        "savedMixAndLyricsAdopted": true,
                        "nativeAdvance": {"from": advance_from, "to": advance_to},
                        "independentLaunch": true,
                        "invalidNewOpen": {"projectCleared": true, "notice": invalid_notice, "oldProjectBytesUnchanged": true},
                        "sizes": [[1060, 640]],
                        "hidden": true,
                        "muted": true,
                        "hardwareHotplugQualified": false,
                        "productionParity": "not evaluated",
                        "liveFps": "unmeasured",
                    }))?;
                }
                "working" | "working-live" => {
                    let raw = env_path("SINGZ_GPUI_AUDIO_RECOVERY_RAW")?;
                    let library = integration::library_root().canonicalize()?;
                    wait!(15, player, window, app => player.settings.read(app).native_snapshot().0.as_ref().is_some_and(|inventory| {
                        let uid = player.settings.read(app).output_uid();
                        inventory.output(&uid).is_ok()
                    }));
                    let target_uid = handle.update(cx, |_, _, cx| -> anyhow::Result<String> {
                        let player = view.read(cx);
                        let inventory = player.settings.read(cx).native_snapshot().0.ok_or_else(|| anyhow::anyhow!("Missing working-phase output inventory"))?;
                        let uid = player.settings.read(cx).output_uid();
                        Ok(inventory.output(&uid)?.uid.clone())
                    })??;
                    handle.update(cx, |_, window, _| window.resize(size(px(1280.), px(800.))))?;
                    wait!(5, player, window, app => window.viewport_size() == size(px(1280.), px(800.)));
                    handle.update(cx, |_, window, cx| {
                        draw(window, cx);
                        let at = point(px(500.), px(400.));
                        window.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Entered { position: at, paths: ExternalPaths(vec![raw.clone()].into()) }), cx);
                        draw(window, cx);
                        window.dispatch_event(PlatformInput::FileDrop(FileDropEvent::Submit { position: at }), cx);
                    })?;
                    wait!(45, player, window, app => !player.loading
                        && player.source_job.is_none()
                        && player.source_working
                        && player.source_target.is_none()
                        && player.project.as_ref().is_some_and(|project| project.original)
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing && status.duration >= 10.));
                    let working = handle.update(cx, |_, _, cx| view.read(cx).project.as_ref().unwrap().dir.clone())?;
                    anyhow::ensure!(working.starts_with(config.join("source-work").canonicalize()?), "Raw Open did not use isolated source-work: {working:?}");
                    let working_initial_metadata_hash = hash(std::fs::read(working.join("project.json"))?);
                    shot!("working-loaded-1280");

                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| {
                        player.native_transport(transport::TransportEvent::Volume(0.62), cx);
                        player.native_transport(transport::TransportEvent::Tempo(0.9), cx);
                        player.native_transport(transport::TransportEvent::Transpose(-2), cx);
                        player.native_transport(transport::TransportEvent::Loop, cx);
                        player.position = 2.;
                        player.seek_native(cx);
                    }))?;
                    wait!(15, player, window, app => player.native_rate_pending.is_none()
                        && player.native_rate_queued.is_none()
                        && player.pending_seek.is_none()
                        && (player.position - 2.).abs() < 0.03
                        && player.last_playback_status.as_ref().is_some_and(|status| !status.playing
                            && (status.rate - 0.9).abs() < 0.0001
                            && status.transpose == -2
                            && status.loop_range.is_some()
                            && (status.position - 2.).abs() < 0.03)
                        && original_lane_accepted(player, 1.));
                    if !handle.update(cx, |_, _, cx| view.read(cx).karaoke)? {
                        handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                            draw(window, cx);
                            let bounds = view.read(cx).quick_start.read(cx).anchors.get("karaoke").ok_or_else(|| anyhow::anyhow!("Karaoke footer control was not measured"))?;
                            click(window, cx, bounds.center());
                            Ok(())
                        })??;
                    }
                    wait!(20, player, window, app => player.karaoke
                        && !player.loading
                        && player.lyrics_sidebar_pending.is_none()
                        && matches!(player.lyrics_sidebar.read(app).state(window, app)["status"].as_str(), Some("ready" | "error")));
                    handle.update(cx, |_, window, cx| open_editor(&view, window, cx))??;
                    wait!(10, player, window, app => player.lyrics_editor_open && !player.lyrics_editor.read(app).rows().is_empty());
                    handle.update(cx, |_, window, cx| replace_first_row(&view, window, cx, WORKING_DRAFT))??;
                    wait!(5, player, window, app => player.lyrics_editor.read(app).revision() == 1
                        && player.lyrics_editor.read(app).dirty
                        && player.lyrics_editor.read(app).rows()[0].text == WORKING_DRAFT);
                    handle.update(cx, |_, window, _| window.resize(size(px(1060.), px(640.))))?;
                    wait!(5, player, window, app => window.viewport_size() == size(px(1060.), px(640.)));
                    shot!("working-draft-before-fault-1060");
                    editor!("lyed-save");
                    wait!(20, player, window, app => !player.lyrics_editor_open
                        && !player.tracks_audio_failed
                        && player.lyric_document.lines.first().is_some_and(|line| line.text == WORKING_DRAFT));
                    anyhow::ensure!(hash(std::fs::read(working.join("project.json"))?) == working_initial_metadata_hash, "Independent lyric Save changed working project metadata");
                    let offline_lyrics_hash = hash(std::fs::read(working.join("lyrics.json"))?);
                    let before = handle.update(cx, |_, window, cx| {
                        draw(window, cx);
                        retained(&view, cx)
                    })?;

                    if phase=="working-live" {
                        anyhow::ensure!(publication_fault,"Live publication requires real metadata quarantine");
                        let epoch=before.epoch;
                        let initial=probe!();unleased_probe(&initial,epoch,&target_uid)?;
                        // Capture receipt age now, before Save/render delays.
                        let mut probes=vec![probe_value(&initial,"initial-paused",0)];
                        anyhow::ensure!(!initial.status.playing,"Working live fixture did not start paused");
                        transport!("transport-play");
                        wait!(8,p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>2.05));
                        let first=probe!();unleased_probe(&first,epoch,&target_uid)?;
                        probes.push(probe_value(&first,"before-save-playing",0));
                        cx.background_executor().timer(Duration::from_millis(160)).await;
                        let second=probe!();unleased_probe(&second,epoch,&target_uid)?;
                        probes.push(probe_value(&second,"before-save-playing",1));
                        anyhow::ensure!(first.status.playing&&second.status.playing&&first.status.audible_current&&second.status.audible_current&&first.helper_pid==initial.helper_pid&&second.helper_pid==initial.helper_pid
                            && second.status.position>first.status.position+0.04,"Healthy owned helper was not actually advancing before Save");
                        shot!("live-publication-playing-before-save-1060");
                        let baseline=handle.update(cx,|_,_,app|retained(&view,app))?;
                        let fault_receipt=out.join("publication-fault-receipt.json");
                        handle.update(cx,|_,_,app|view.update(app,|p,_|p.source_publication_fault=Some(fault_receipt.clone())))?;
                        handle.update(cx,|_,w,app|header_control(&view,w,app,"save"))??;
                        wait!(60,p,w,app=>p.source_job.is_none()&&p.source_publication.is_some()
                            &&p.source_working&&p.tracks_audio_failed&&!p.playing&&p.notice.as_ref().is_some_and(|n|n.contains("publication could not be adopted")));
                        let failed=handle.update(cx,|_,_,app|retained(&view,app))?;
                        ensure_retained(&baseline,&failed,"Healthy live publication read failure")?;
                        let receipt:Value=serde_json::from_slice(&std::fs::read(&fault_receipt)?)?;
                        let metadata=PathBuf::from(receipt["metadata"].as_str().context("Missing live metadata path")?);
                        let held=PathBuf::from(receipt["heldMetadata"].as_str().context("Missing live held metadata path")?);
                        let original_bytes=std::fs::read(&held)?;
                        anyhow::ensure!(!metadata.exists()&&hash(&original_bytes)==receipt["metadataSha256"].as_str().unwrap(),"Live fault did not preserve exact writer bytes");
                        std::fs::write(out.join("publication-original-metadata.json"),&original_bytes)?;
                        let mut paused_position:Option<f64>=None;
                        let paused_started=Instant::now();
                        for index in 0..7 {
                            cx.background_executor().timer(Duration::from_millis(100)).await;
                            let sample=probe!();unleased_probe(&sample,epoch,&target_uid)?;
                            anyhow::ensure!(sample.helper_pid==initial.helper_pid&&!sample.status.playing,"Publication failure did not leave the existing helper paused");
                            anyhow::ensure!((sample.status.rate-0.9).abs()<0.0001&&sample.status.transpose==-2&&sample.status.loop_range==initial.status.loop_range
                                &&sample.status.graph_generation==initial.status.graph_generation&&sample.status.lane_revision==initial.status.lane_revision,"Failed publication changed the native graph/mix route");
                            if let Some(position)=paused_position {anyhow::ensure!((sample.status.position-position).abs()<0.0001,"Native position advanced behind failed publication");}
                            else {paused_position=Some(sample.status.position);}
                            probes.push(probe_value(&sample,"failed-publication-paused",index));
                            handle.update(cx,|_,w,app|->anyhow::Result<()>{draw(w,app);let p=view.read(app);
                                anyhow::ensure!(p.native_epoch==epoch&&p.source_publication.is_some()&&p.source_working&&p.tracks_audio_failed&&!p.playing
                                    &&(p.position-failed.position).abs()<0.0001,"Publication failure lost receipt or moved local stopped clock");Ok(())})??;
                        }
                        let paused_observation_seconds=paused_started.elapsed().as_secs_f64();
                        anyhow::ensure!(paused_observation_seconds>=0.7,"Native stopped-state observation was too short");
                        std::fs::write(out.join("live-native-probes.json"),serde_json::to_vec_pretty(&probes)?)?;
                        shot!("live-publication-failed-paused-owner-1060");
                        handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
                        wait!(5,p,w,app=>w.viewport_size()==size(px(1280.),px(800.)));
                        shot!("live-publication-failed-paused-owner-1280");
                        handle.update(cx,|_,w,app|escape(w,app))?;
                        handle.update(cx,|_,w,app|header_control(&view,w,app,"settings"))??;
                        wait!(5,p,w,app=>p.screen==Screen::Settings&&p.settings.read(app).native_snapshot().3.is_some());
                        std::fs::rename(&held,&metadata)?;
                        anyhow::ensure!(hash(std::fs::read(&metadata)?)==hash(&original_bytes),"Live repair changed published bytes");
                        settings!("settings-retry");
                        wait!(30,p,w,app=>p.source_publication.is_none()&&!p.source_working&&!p.tracks_audio_failed&&p.saved_seq==p.edit_seq
                            &&native_paused(p,&target_uid,failed.position,0.9,-2,true)&&p.notice.is_none());
                        let recovered=probe!();unleased_probe(&recovered,epoch,&target_uid)?;
                        anyhow::ensure!(!recovered.status.playing&&recovered.helper_pid!=initial.helper_pid&&(recovered.status.position-failed.position).abs()<0.03,"Retry did not replace the old helper with paused retained transport");
                        probes.push(probe_value(&recovered,"repaired-replacement-paused",0));
                        let adopted=handle.update(cx,|_,_,app|retained(&view,app))?;
                        // Save materializes the implicit full-song loop selection.
                        // Require the exact native bounds, rather than treating
                        // that source-format canonicalization as lost loop state.
                        let expected_selection=failed.selection.or(Some((0.,failed.duration)));
                        anyhow::ensure!(initial.status.loop_range==expected_selection&&adopted.selection==expected_selection&&recovered.status.loop_range==expected_selection,"Publication changed the effective loop selection");
                        let expected=Retained{dir:adopted.dir.clone(),metadata_hash:adopted.metadata_hash.clone(),saved_seq:adopted.saved_seq,selection:expected_selection,screen:Screen::Settings as u8,..failed.clone()};
                        ensure_retained(&expected,&adopted,"Healthy live publication repair")?;
                        let published=adopted.dir.clone();
                        anyhow::ensure!(published!=working&&published.starts_with(&library),"Live repair did not adopt library publication");
                        handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;
                        wait!(5,p,w,app=>w.viewport_size()==size(px(1060.),px(640.)));
                        shot!("live-publication-repaired-paused-1060");
                        handle.update(cx,|_,_,app|{let settings=view.read(app).settings.clone();settings.update(app,|_,cx|cx.emit(settings::SettingsEvent::Close));})?;
                        wait!(5,p,w,app=>p.screen==Screen::Player);
                        transport!("transport-play");
                        wait!(8,p,w,app=>p.playing&&p.last_playback_status.as_ref().is_some_and(|s|s.playing&&s.position>failed.position+0.04));
                        let resumed_first=probe!();unleased_probe(&resumed_first,epoch,&target_uid)?;
                        probes.push(probe_value(&resumed_first,"repaired-playing",0));
                        cx.background_executor().timer(Duration::from_millis(160)).await;
                        let resumed_second=probe!();unleased_probe(&resumed_second,epoch,&target_uid)?;
                        anyhow::ensure!(resumed_first.status.playing&&resumed_second.status.playing&&resumed_first.status.audible_current&&resumed_second.status.audible_current&&resumed_first.helper_pid==recovered.helper_pid&&resumed_second.helper_pid==recovered.helper_pid
                            &&resumed_second.status.position>resumed_first.status.position+0.04,"Repaired helper did not actually advance");
                        probes.push(probe_value(&resumed_second,"repaired-playing",1));
                        std::fs::write(out.join("live-native-probes.json"),serde_json::to_vec_pretty(&probes)?)?;
                        handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
                        wait!(5,p,w,app=>w.viewport_size()==size(px(1280.),px(800.)));
                        shot!("live-publication-repaired-playing-1280");
                        let project:Value=serde_json::from_slice(&std::fs::read(published.join("project.json"))?)?;
                        let media=published.join(project["songFile"].as_str().context("Live publication songFile missing")?);
                        let lyrics=std::fs::read(published.join("lyrics.json"))?;
                        anyhow::ensure!(hash(&lyrics)==offline_lyrics_hash&&hash(std::fs::read(&media)?)==hash(std::fs::read(&raw)?),"Live publication changed saved lyrics/media");
                        write_result(&out,json!({"phase":phase,"livePublicationFault":true,"ownedHelperKilled":false,
                            "sameEpoch":epoch,"originalHelperPid":initial.helper_pid,"recoveredHelperPid":recovered.helper_pid,
                            "pausedObservationSeconds":paused_observation_seconds,"pausedNativePosition":paused_position,
                            "localStoppedPosition":failed.position,"workingDir":working,"publishedDir":published,
                            "selectionBefore":failed.selection,"selectionAfter":adopted.selection,"nativeLoopBefore":initial.status.loop_range,"nativeLoopAfter":recovered.status.loop_range,
                            "publishedMetadataSha256":hash(&original_bytes),"publishedLyricsSha256":hash(&lyrics),"rawSourceSha256":hash(std::fs::read(&raw)?),
                            "lyricArcBefore":baseline.lyric_arc,"lyricArcAfter":adopted.lyric_arc,
                            "nativeAdvance":{"from":resumed_first.status.position,"to":resumed_second.status.position},
                            "selectedUid":target_uid,"sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,
                            "healthyLiveHelperPublicationFailure":true,"nativePausedMeasuredBeforeHostAdmission":true,
                            "monitorTrainingHandoffQualified":false,"productionParity":"not evaluated","liveFps":"unmeasured"}))?;
                        return Ok(());
                    }

                    handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                        let player = view.read(cx);
                        player.backend.as_ref().ok_or_else(|| anyhow::anyhow!("Missing working backend"))?.fail_owned_audio(player.native_epoch)
                    })??;
                    wait!(10, player, window, app => player.tracks_audio_failed
                        && !player.playing
                        && !player.lyrics_editor_open
                        && player.last_playback_status.is_none()
                        && player.notice.as_ref().is_some_and(|notice| notice.contains("retained")));
                    let failed = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    ensure_retained(&before, &failed, "Working helper death")?;
                    anyhow::ensure!((failed.position - before.position).abs() < 0.0001, "Working stopped clock advanced");
                    shot!("working-audio-failed-1060");
                    if publication_fault { handle.update(cx,|_,w,cx|notice_above_progress(&view,w,cx,&out))??; }

                    let publication_baseline = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    let sidebar_baseline = handle.update(cx, |_, window, cx| view.read(cx).lyrics_sidebar.read(cx).state(window, cx))?;
                    anyhow::ensure!(sidebar_baseline["showsLyrics"]==true, "Working lyrics were not visible before publication");
                    let fault_receipt=out.join("publication-fault-receipt.json");
                    if publication_fault {
                        handle.update(cx, |_, _, cx|view.update(cx,|player,_|player.source_publication_fault=Some(fault_receipt.clone())))?;
                    }
                    if publication_fault { handle.update(cx,|_,w,cx|{draw(w,cx);let focus=view.read(cx).header.read(cx).save_control_focus();focus.focus(w,cx);})?; }
                    handle.update(cx, |_, _, cx| view.update(cx, |player, cx| -> anyhow::Result<()> {
                        player.save_project(cx);
                        if publication_fault {
                            let generation=player.source_job.context("Working Save was not admitted")?;
                            anyhow::ensure!(player.source_saving,"Working Save did not own its writer");
                            // Exercise the exact Escape controller before the next
                            // frame consumes a potentially already-committed result.
                            player.cancel_source_from_escape(cx);
                            anyhow::ensure!(player.source_job==Some(generation)&&player.source_saving,"Escape controller cancelled the Save before result adoption");
                        }
                        Ok(())
                    }))??;
                    if publication_fault {
                        wait!(60, player, window, app => player.source_job.is_none() && player.source_publication.is_some()
                            && player.source_working && player.tracks_audio_failed && !player.playing
                            && player.notice.as_ref().is_some_and(|n|n.contains("publication could not be adopted")));
                        let failed=handle.update(cx,|_,_,cx|retained(&view,cx))?;
                        ensure_retained(&publication_baseline,&failed,"Failed publication read")?;
                        let receipt:Value=serde_json::from_slice(&std::fs::read(&fault_receipt)?)?;
                        let metadata=PathBuf::from(receipt["metadata"].as_str().context("Missing quarantined metadata path")?);
                        let held=PathBuf::from(receipt["heldMetadata"].as_str().context("Missing held metadata path")?);
                        let original_bytes=std::fs::read(&held)?;
                        anyhow::ensure!(!metadata.exists()&&hash(&original_bytes)==receipt["metadataSha256"].as_str().unwrap(),"Real read fault did not preserve exact writer bytes");
                        std::fs::write(out.join("publication-original-metadata.json"),&original_bytes)?;
                        shot!("publication-read-failed-1060");
                        handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
                        wait!(5, player, window, app => window.viewport_size()==size(px(1280.),px(800.)));
                        shot!("publication-read-failed-1280");
                        handle.update(cx,|_,w,_|w.resize(size(px(1060.),px(640.))))?;
                        wait!(5, player, window, app => window.viewport_size()==size(px(1060.),px(640.)));
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&p.source_publication.is_some()&&p.source_working,"Escape discarded publication receipt or failed to dismiss notice: pending={}, working={}, notice={:?}",p.source_publication.is_some(),p.source_working,p.notice);Ok(())})??;
                        handle.update(cx,|_,w,cx|->anyhow::Result<()>{draw(w,cx);let p=view.read(cx);anyhow::ensure!(!p.header.read(cx).save_enabled()&&p.focus_handle.is_focused(w),"Pending publication left Save enabled or focus unmounted");Ok(())})??;
                        let generation=handle.update(cx,|_,_,cx|view.read(cx).source_status.generation)?;
                        handle.update(cx,|_,w,cx|header_control(&view,w,cx,"save"))??;
                        // Also exercise admission if an accelerator arrives independently
                        // of the disabled visual control; neither may start another writer.
                        handle.update(cx,|_,_,cx|view.update(cx,|p,cx|p.save_project(cx)))?;
                        cx.background_executor().timer(Duration::from_millis(200)).await;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.source_status.generation==generation&&p.source_job.is_none()&&p.source_publication.is_some()&&p.saved_seq==publication_baseline.saved_seq,"Duplicate Save restarted publication");Ok(())})??;
                        anyhow::ensure!(hash(std::fs::read(&held)?)==hash(&original_bytes)&&!metadata.exists(),"Duplicate Save changed quarantined publication");
                        anyhow::ensure!(std::fs::read_dir(integration::library_root())?.filter_map(|entry|entry.ok()).filter(|e|e.path().join("project.json").exists()||e.path().join("project.json.ui-test-held").exists()).count()==2,"Duplicate Save forked an extra library project");
                        shot!("publication-duplicate-save-blocked-1060");
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&p.source_publication.is_some()&&p.source_working&&p.source_job.is_none()&&p.screen==Screen::Player,"A second Escape cancelled the completed publication");Ok(())})??;
                        shot!("publication-extra-escape-retains-receipt-1060");
                        handle.update(cx,|_,w,cx|header_control(&view,w,cx,"settings"))??;
                        wait!(5, player, window, app => player.screen==Screen::Settings&&player.settings.read(app).native_snapshot().3.is_some());
                        settings!("settings-retry");
                        wait!(10, player, window, app => player.source_publication.is_some()&&player.source_working&&player.notice.is_some()&&!player.settings.read(app).native_snapshot().2);
                        shot!("publication-unrepaired-retry-1060");
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&p.source_publication.is_some()&&p.screen==Screen::Settings,"Notice Escape changed Settings or publication ownership");Ok(())})??;
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.screen==Screen::Player&&p.source_publication.is_some()&&p.source_working&&p.notice.is_none(),"Settings Escape cancelled the retained publication instead of closing the screen");Ok(())})??;
                        shot!("publication-settings-escape-retains-receipt-1060");
                        handle.update(cx,|_,w,cx|header_control(&view,w,cx,"settings"))??;
                        wait!(5, player, window, app => player.screen==Screen::Settings&&player.settings.read(app).native_snapshot().3.is_some());
                        // Restoring a valid but different document must not adopt it.
                        let mut foreign:Value=serde_json::from_slice(&original_bytes)?;
                        foreign["foreignRepair"]=json!(true);
                        std::fs::write(&metadata,serde_json::to_vec_pretty(&foreign)?)?;
                        let preferences=std::fs::read(&preferences_path)?;
                        settings!("settings-retry");
                        wait!(10, player, window, app => player.source_publication.is_some()&&player.source_working&&player.notice.as_ref().is_some_and(|n|n.contains("Saved project changed"))&&!player.settings.read(app).native_snapshot().2&&player.last_playback_status.is_none());
                        anyhow::ensure!(std::fs::read(&preferences_path)?==preferences,"Refused foreign publication changed route preferences");
                        shot!("publication-foreign-metadata-refused-1060");
                        handle.update(cx,|_,w,cx|escape(w,cx))?;
                        handle.update(cx,|_,_,cx|->anyhow::Result<()>{let p=view.read(cx);anyhow::ensure!(p.notice.is_none()&&p.source_publication.is_some()&&p.source_working,"Hash refusal dismissal lost publication receipt");Ok(())})??;
                        std::fs::remove_file(&metadata)?;
                        std::fs::rename(&held,&metadata)?;
                        anyhow::ensure!(hash(std::fs::read(&metadata)?)==hash(&original_bytes),"Repair did not restore exact publication bytes");
                        settings!("settings-retry");
                        wait!(30, player, window, app => player.source_publication.is_none()&&!player.source_working&&player.source_job.is_none()&&player.saved_seq==player.edit_seq&&native_paused(player,&target_uid,2.,0.9,-2,true)&&player.notice.is_none());
                        shot!("publication-repaired-paused-1060");
                    } else {
                    wait!(60, player, window, app => !player.loading
                        && player.source_job.is_none()
                        && player.source_publication.is_none()
                        && !player.source_working
                        && player.source_target.is_none()
                        && player.project.as_ref().is_some_and(|project| project.dir != working && project.dir.starts_with(&library))
                        && player.saved_seq == player.edit_seq
                        && player.tracks_audio_failed
                        && !player.playing
                        && player.last_playback_status.is_none()
                        && player.notice.is_none());
                    }
                    let published = handle.update(cx, |_, _, cx| view.read(cx).project.as_ref().unwrap().dir.clone())?;
                    let adopted = handle.update(cx, |_, _, cx| retained(&view, cx))?;
                    let adoption_expected = Retained {
                        dir: adopted.dir.clone(),
                        metadata_hash: adopted.metadata_hash.clone(),
                        saved_seq: adopted.saved_seq,
                        selection: adopted.selection,
                        screen: if publication_fault { Screen::Settings as u8 } else { publication_baseline.screen },
                        ..publication_baseline.clone()
                    };
                    ensure_retained(&adoption_expected, &adopted, "Offline publication adoption")?;
                    anyhow::ensure!((adopted.position - publication_baseline.position).abs() < 0.0001, "Publication adoption moved the stopped clock");
                    anyhow::ensure!(adopted.selection.is_some_and(|(start, end)| start == 0. && (end - adopted.duration).abs() < 0.03), "Publication changed the full-length loop selection: {:?}", adopted.selection);
                    let published_metadata = std::fs::read(published.join("project.json"))?;
                    let published_project: Value = serde_json::from_slice(&published_metadata)?;
                    anyhow::ensure!(adopted.metadata_hash == hash(&published_metadata), "Adopted project hash differs from writer's publication bytes");
                    anyhow::ensure!(published_project["settings"]["tempo"] == 0.9
                        && published_project["settings"]["transpose"] == -2
                        && published_project["settings"]["loop"] == true
                        && published_project["settings"]["masterVolume"] == 0.62,
                        "Published working mix is wrong: {published_project}");
                    let published_lyrics = std::fs::read(published.join("lyrics.json"))?;
                    anyhow::ensure!(hash(&published_lyrics) == offline_lyrics_hash, "Published lyrics differ from the independent editor Save");
                    let lyrics: Value = serde_json::from_slice(&published_lyrics)?;
                    anyhow::ensure!(lyrics["lines"][0]["text"] == WORKING_DRAFT && lyrics["source"] == "edited", "Published lyric document is wrong: {lyrics}");
                    let media_relative = published_project["songFile"].as_str().ok_or_else(|| anyhow::anyhow!("Published original has no songFile"))?;
                    let published_media = published.join(media_relative);
                    let raw_hash = hash(std::fs::read(&raw)?);
                    anyhow::ensure!(hash(std::fs::read(&published_media)?) == raw_hash, "Published original media identity differs from raw fixture");
                    handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                        draw(window, cx);
                        let player=view.read(cx);
                        let sidebar=player.lyrics_sidebar.read(cx).state(window, cx);
                        anyhow::ensure!(sidebar["showsLyrics"]==true && sidebar["songkey"]==published.display().to_string(), "Published document lost its rendered lyrics sidebar: {sidebar}");
                        for key in ["status","details","view","query","results","busy","previous","scrollOffset"] {
                            anyhow::ensure!(sidebar[key]==sidebar_baseline[key], "Publication reset sidebar {key}: {} -> {}", sidebar_baseline[key], sidebar[key]);
                        }
                        Ok(())
                    })??;
                    if publication_fault { shot!("working-adopted-after-publication-repair-1060"); }
                    else {
                        shot!("working-adopted-offline-1060");
                        handle.update(cx, |_, window, cx| header_control(&view, window, cx, "settings"))??;
                        wait!(5, player, window, app => player.screen == Screen::Settings
                            && player.settings.read(app).native_snapshot().3.is_some());
                        settings!("settings-retry");
                    }
                    wait!(20, player, window, app => native_paused(player, &target_uid, 2., 0.9, -2, true)
                        && player.native_loop == adopted.selection
                        && original_lane_accepted(player, 1.)
                        && player.notice.is_none()
                        && !player.source_working
                        && player.source_publication.is_none());
                    shot!("working-explicit-route-recovered-1060");
                    handle.update(cx, |_, _, cx| { let settings=view.read(cx).settings.clone(); settings.update(cx, |_, cx| cx.emit(settings::SettingsEvent::Close)); })?;
                    wait!(5, player, window, app => player.screen == Screen::Player);
                    handle.update(cx, |_, window, _| window.resize(size(px(1280.), px(800.))))?;
                    wait!(5, player, window, app => window.viewport_size() == size(px(1280.), px(800.)));
                    transport!("transport-play");
                    wait!(8, player, window, app => player.playing
                        && player.last_playback_status.as_ref().is_some_and(|status| status.playing && status.position > before.position + 0.06 && status.rendered_frame >= 0));
                    let advance_from = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                    wait!(8, player, window, app => player.last_playback_status.as_ref().is_some_and(|status| status.playing && status.position > advance_from + 0.06));
                    let advance_to = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().position)?;
                    shot!("working-native-playing-1280");
                    transport!("transport-play");
                    wait!(8, player, window, app => !player.playing && player.last_playback_status.as_ref().is_some_and(|status| !status.playing));

                    write_result(&out, json!({
                        "phase": phase,
                        "selectedUid": target_uid,
                        "workingDir": working,
                        "publishedDir": published,
                        "workingInitialMetadataSha256": working_initial_metadata_hash,
                        "offlineLyricsSha256": offline_lyrics_hash,
                        "publishedMetadataSha256": hash(&published_metadata),
                        "publishedLyricsSha256": hash(&published_lyrics),
                        "publishedMedia": published_media,
                        "rawSourceSha256": raw_hash,
                        "draft": WORKING_DRAFT,
                        "offlineSaveWithoutAudio": true,
                        "adoptionWithoutOpenedReset": true,
                        "renderedSidebarRetainedAfterPublication": true,
                        "publicationReadFault": publication_fault,
                        "publicationFaultCoverage": if publication_fault {json!({"realMetadataQuarantine":true,"noticeAboveHeldSaveProgress":true,"noticeEscapeRetainsReceipt":true,"duplicateSaveBlocked":true,"activeSaveEscapeControllerPreservesWriter":true,"extraEscapeRetainsReceipt":true,"settingsEscapeRetainsReceipt":true,"unrepairedRetryRetainsDocument":true,"foreignMetadataRefused":true,"exactRepairAndSettingsRetryAdoptAndRecoverPaused":true})}else{Value::Null},
                        "epochBeforePublication": publication_baseline.epoch,
                        "epochAfterPublication": adopted.epoch,
                        "editorGenerationBeforePublication": publication_baseline.editor_generation,
                        "editorGenerationAfterPublication": adopted.editor_generation,
                        "lyricArcBeforePublication": publication_baseline.lyric_arc,
                        "lyricArcAfterPublication": adopted.lyric_arc,
                        "audioFailedUntilExplicitRouteRetry": true,
                        "settingsRetryClicked": true,
                        "nativeAdvance": {"from": advance_from, "to": advance_to},
                        "sizes": [[1280, 800], [1060, 640]],
                        "hidden": true,
                        "muted": true,
                        "hardwareHotplugQualified": false,
                        "productionParity": "not evaluated",
                        "liveFps": "unmeasured",
                    }))?;
                }
                other => anyhow::bail!("Unknown SINGZ_GPUI_AUDIO_RECOVERY_PHASE {other:?}; expected retained, restart or working"),
            }
            Ok(())
        }.await;
        match result {
            Ok(()) => {
                eprintln!("NATIVE_AUDIO_RECOVERY passed: owned helper loss, retained documents/drafts, native route recovery and isolated persistence");
                let _ = cx.update(|cx| cx.quit());
            }
            Err(error) => {
                eprintln!("NATIVE_AUDIO_RECOVERY failed: {error:#}");
                let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
                let _ = handle.update(cx, |_, window, cx| capture(&view, window, cx, &out, "failure"));
                let _ = view.update(cx, |player, _| {
                    player.source_service.take();
                    player.backend.take();
                });
                std::process::exit(1);
            }
        }
    }).detach();
}

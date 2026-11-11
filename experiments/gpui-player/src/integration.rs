//! Native-only integration boundary. Filesystem and child IPC never run on the UI thread.
use anyhow::{Context, Result, bail};
use serde_json::Value;
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};

#[path = "integration_save.rs"]
mod save_worker;
#[path = "integration_recovery.rs"]
mod recovery;
pub use recovery::{AudioRecovery, RecoveredAudio, Publication};

pub const STEMS: [&str; 7] = [
    "vocals",
    "drums",
    "bass",
    "guitar",
    "piano",
    "other",
    "custom-backing-vocals",
];
#[derive(Clone, Debug)]
pub struct Project {
    pub graph: Option<crate::native_graph::Prepared>,
    pub carry:crate::carry_line::Desired,
    pub metronome: crate::beat::Metronome,
    pub beat: Option<crate::beat::Beats>,
    pub vocal_stamp: Option<(u64, std::time::SystemTime)>,
    pub vocal_duration: Option<f64>,
    pub lane_stamps: Vec<(u64, std::time::SystemTime)>,
    pub tempo: f32,
    pub transpose: i32,
    pub raw: Value,
    pub metadata_hash: String,
    pub looping: bool,
    pub selection: Option<(f64, f64)>,
    pub view: Option<(f64, f64)>,
    pub pitch: Arc<crate::project_pitch::Pitch>,
    pub has_lyrics: bool,
    pub lyrics: Option<Arc<crate::project_lyrics::Document>>,
    pub lyrics_error: Option<String>,
    pub lyrics_fingerprint: Option<String>,
    pub lyrics_raw: Option<Value>,
    pub original: bool,
    pub empty_tracks: bool,
    pub dir: PathBuf,
    pub name: String,
    pub saved: String,
    pub lanes: Vec<(usize, PathBuf)>,
    pub lane_specs: Vec<crate::tracks::Lane>,
    pub track_warnings: Vec<String>,
    pub gain: [f32; crate::tracks::LANE_SLOTS],
    pub muted: [bool; crate::tracks::LANE_SLOTS],
    pub solo: [bool; crate::tracks::LANE_SLOTS],
    pub master: f32,
}
/// Captured by an owned rename/import/Save/split handoff, never constructed
/// from saved JSON. Only this typed boundary may retain external picked paths.
#[derive(Clone,Debug)]
pub struct OpenCustomOverlay {
    pub source_dir:PathBuf,
    pub mix:crate::project_store::Mix,
    pub preserve_generated:bool,
}
impl Project {
    pub fn has_audio(&self)->bool{!self.empty_tracks&&!self.lanes.is_empty()}
    pub fn lane_id(&self,slot:usize)->Option<&str>{self.lane_specs.iter().find(|lane|lane.slot==slot).map(|lane|lane.id.as_str())}
    pub fn custom_tracks(&self)->Vec<crate::tracks::Lane>{self.lane_specs.iter().filter(|lane|lane.custom).cloned().collect()}
}
fn native_lane_sources(project:&Project)->Result<Vec<(String,PathBuf)>> {
    anyhow::ensure!(project.lanes.len()<=crate::tracks::MAX_ACTIVE_LANES&&project.empty_tracks==project.lanes.is_empty()&&(!project.empty_tracks||project.lane_specs.is_empty()),"Invalid active native track count or empty intent");
    let mut slots=std::collections::HashSet::new();let mut ids=std::collections::HashSet::new();
    project.lanes.iter().map(|(slot,path)|{
        anyhow::ensure!(*slot<crate::tracks::LANE_SLOTS&&slots.insert(*slot),"Duplicate or invalid native track slot");
        let spec=project.lane_specs.iter().find(|lane|lane.slot==*slot).context("Missing native track metadata")?;
        anyhow::ensure!(spec.file==*path&&!spec.id.is_empty()&&spec.id.len()<=128&&ids.insert(spec.id.clone()),"Invalid native track identity/source");
        Ok((spec.id.clone(),path.clone()))
    }).collect()
}
fn number(value: Option<&Value>, default: f32, min: f32, max: f32) -> Result<f32> {
    let n = match value {
        None => default,
        Some(v) => v.as_f64().context("Invalid project number")? as f32,
    };
    if !n.is_finite() || n < min || n > max {
        bail!("Project setting is outside supported range")
    };
    Ok(n)
}
// JSON/native seconds enter the timeline without a single-precision round trip.
fn seconds(value: Option<&Value>, default: f64, min: f64, max: f64) -> Result<f64> {
    let n = match value { None => default, Some(v) => v.as_f64().context("Invalid project number")? };
    anyhow::ensure!(n.is_finite() && n >= min && n <= max, "Project setting is outside supported range");
    Ok(n)
}
pub fn read_project(path: &Path) -> Result<Project> {
    read_project_mode(path, true)
}
fn verify_delete_recovery_path(path:&Path,confirmed:&crate::project_delete::Target)->Result<()> {
    crate::project_delete::verify_original_folder(confirmed)?;
    anyhow::ensure!(path.canonicalize()?==confirmed.dir,"Deletion recovery path differs from the confirmed original project");
    Ok(())
}
fn read_open_project(path:&Path,confirmed:Option<&crate::project_delete::Target>)->Result<Project> {
    read_open_project_using(path,confirmed,read_project)
}
fn read_open_project_overlay(path:&Path,confirmed:Option<&crate::project_delete::Target>,overlay:Option<&OpenCustomOverlay>)->Result<Project> {
    read_open_project_using(path,confirmed,|path|read_project_mode_overlay(path,true,overlay))
}
fn read_open_project_using(path:&Path,confirmed:Option<&crate::project_delete::Target>,read:impl FnOnce(&Path)->Result<Project>)->Result<Project> {
    if let Some(target)=confirmed{verify_delete_recovery_path(path,target)?;}
    let project=read(path)?;
    if let Some(target)=confirmed{
        verify_delete_recovery_path(path,target)?;
        anyhow::ensure!(project.dir==target.dir,"Deletion recovery read a different project");
    }
    Ok(project)
}
/// Own the prepared resource while checking. Refusal drops a native child (or
/// its entire prepared tuple) before any Opened receipt can adopt foreign data.
fn checked_delete_recovery<T>(path:&Path,confirmed:Option<&crate::project_delete::Target>,prepared:T)->Result<T> {
    if let Some(target)=confirmed{verify_delete_recovery_path(path,target)?;}
    Ok(prepared)
}
fn overlay_custom_lanes(project:&Project,fresh:&[crate::tracks::Lane],overlay:&OpenCustomOverlay)->Result<Vec<crate::tracks::Lane>> {
    use std::path::Component;
    anyhow::ensure!(overlay.source_dir.is_absolute()&&overlay.source_dir.components().all(|c|!matches!(c,Component::ParentDir|Component::CurDir)),"Invalid owned custom-track source directory");
    anyhow::ensure!(overlay.mix.custom.len()<=crate::tracks::MAX_ACTIVE_LANES,"Too many retained custom tracks");
    let mut ids=std::collections::HashSet::new();let mut slots=std::collections::HashSet::new();let mut restored=vec![];
    for captured in &overlay.mix.custom {
        crate::tracks::validate_custom_id(&captured.id)?;
        anyhow::ensure!(captured.custom&&captured.slot>=crate::tracks::BUILTIN_SLOTS&&captured.slot<crate::tracks::LANE_SLOTS&&overlay.mix.lanes.contains(&captured.slot)&&ids.insert(captured.id.clone())&&slots.insert(captured.slot),"Invalid or duplicate retained custom-track identity/slot");
        let gain=overlay.mix.gain[captured.slot];anyhow::ensure!(gain.is_finite()&&(0. ..=1.).contains(&gain),"Invalid retained custom-track gain");
        anyhow::ensure!(captured.file.is_absolute()&&captured.file.components().all(|c|!matches!(c,Component::ParentDir|Component::CurDir)),"Retained custom-track source is not an absolute ordinary path");
        let mut lane=captured.clone();
        lane.file=if let Some(owned)=fresh.iter().find(|lane|lane.id==captured.id){owned.file.clone()}
            else if let Ok(relative)=captured.file.strip_prefix(&overlay.source_dir){
                anyhow::ensure!(!relative.as_os_str().is_empty()&&relative.components().all(|c|matches!(c,Component::Normal(_))),"Invalid moved custom-track source");project.dir.join(relative)
            }else{captured.file.clone()};
        anyhow::ensure!(fs::symlink_metadata(&lane.file).is_ok_and(|m|m.file_type().is_file())&&lane.file.canonicalize().is_ok_and(|canonical|canonical==lane.file),"Retained custom track {} is missing or linked; refusing to lose its unsaved edit",lane.label);
        restored.push(lane);
    }
    if overlay.preserve_generated {
        let generated=|id:&str|id==crate::tracks::BACKING_ID||id.strip_prefix("custom-backing-vocals-").is_some_and(|suffix|!suffix.is_empty()&&suffix.bytes().all(|c|c.is_ascii_digit()));
        let mut occupied=project.lane_specs.clone();occupied.extend(restored.clone());
        for lane in fresh.iter().filter(|lane|generated(&lane.id)&&!ids.contains(&lane.id)) {
            let mut lane=lane.clone();lane.slot=crate::tracks::next_custom_slot(&occupied,&lane.id)?;occupied.push(lane.clone());restored.push(lane);
        }
    }
    anyhow::ensure!(project.lanes.len()+restored.len()<=crate::tracks::MAX_ACTIVE_LANES,"Retained custom tracks exceed native active-track capacity");
    Ok(restored)
}
fn read_project_mode(path: &Path, full: bool) -> Result<Project> {
    read_project_mode_overlay(path,full,None)
}
fn read_project_mode_overlay(path:&Path,full:bool,overlay:Option<&OpenCustomOverlay>)->Result<Project> {
    let dir = if path.is_file() {
        path.parent().context("Missing project folder")?
    } else {
        path
    };
    let dir = dir.canonicalize()?;
    crate::project_publish::recover(&dir)?;
    let (meta, metadata_hash) = crate::project_store::read(&dir, "project.json")?;
    if !meta.is_object() {
        bail!("Project must be a JSON object")
    }
    let version = match meta.get("version") {
        None | Some(Value::Null) => 1.,
        Some(value) => value.as_f64().context("Invalid project version")?,
    };
    if version != 1. && version != 2. {
        bail!("Unsupported project version")
    }
    let settings = &meta["settings"];
    if !settings.is_null() && !settings.is_object() {
        bail!("Invalid project settings");
    }
    // Stray graph files are invisible. A published reference must prove the
    // exact bytes before any audio handoff; future formats remain unopened.
    let graph = if full {crate::native_graph::read(&dir,&meta)?} else {None};
    for key in ["nativeEmptyTracks","nativeOriginalDisabled"] {
        if let Some(value)=settings.get(key){anyhow::ensure!(value.is_boolean(),"Invalid persisted {key} flag");}
    }
    let stored_empty=settings["nativeEmptyTracks"]==true;
    if stored_empty{anyhow::ensure!(settings["custom"].as_array().is_some_and(Vec::is_empty),"Invalid explicitly empty project metadata");}
    let overlay_empty=overlay.is_some_and(|o|!o.preserve_generated&&!o.mix.original&&o.mix.lanes.is_empty()&&o.mix.custom.is_empty());
    let explicit_empty=overlay_empty||(stored_empty&&overlay.is_none());
    let transpose = number(settings.get("transpose"), 0., -24., 24.)?;
    if transpose.fract() != 0. {
        bail!("Transpose must be a whole semitone")
    }
    let tempo = number(settings.get("tempo"), 1., 0.25, 4.)?;
    let range = |name: &str| -> Result<Option<(f64, f64)>> {
        if settings[name].is_null() {
            return Ok(None);
        }
        let s = seconds(settings[name].get("s"), 0., 0., 86400. * 365.)?;
        let e = seconds(settings[name].get("e"), 0., 0., 86400. * 365.)?;
        if e <= s {
            bail!("Invalid saved {name} range")
        };
        Ok(Some((s, e)))
    };
    let metronome = crate::beat::Metronome::sanitize(&settings["metronome"]);
    let beat = full
        .then(|| crate::beat::Beats::sanitize(&settings["beat"]))
        .flatten();
    // Refuse unsupported native timelines before replacing the working song.
    if full {
        crate::beat::commands(&metronome, beat.as_ref())?;
    }
    let mut project = Project {
        graph,
        carry:crate::carry_line::Desired::from_settings(&settings["training"]),
        metronome,
        beat,
        vocal_stamp: None,
        vocal_duration:None,
        lane_stamps: vec![],
        tempo,
        transpose: transpose as i32,
        raw: if full { meta.clone() } else { Value::Null },
        metadata_hash,
        looping: settings["loop"] == true,
        selection: range("selection")?,
        view: range("view")?,
        pitch: Arc::new(if full {
            crate::project_pitch::Pitch::read(settings)
        } else {
            crate::project_pitch::Pitch::default()
        }),
        has_lyrics: dir.join("lyrics.json").is_file(),
        lyrics: None,
        lyrics_error: None,
        lyrics_fingerprint: None,
        lyrics_raw: None,
        original: false,
        empty_tracks: explicit_empty,
        dir: dir.clone(),
        name: meta["name"]
            .as_str()
            .unwrap_or_else(|| dir.file_name().and_then(|n| n.to_str()).unwrap_or("Song"))
            .into(),
        saved: meta["savedAt"].as_str().unwrap_or("").into(),
        lanes: vec![],
        lane_specs: vec![],
        track_warnings: vec![],
        gain: [1.; crate::tracks::LANE_SLOTS],
        muted: [false; crate::tracks::LANE_SLOTS],
        solo: [false; crate::tracks::LANE_SLOTS],
        master: number(settings.get("masterVolume"), 1., 0., 4.)?,
    };
    if !explicit_empty {
    for (i, id) in STEMS.iter().take(crate::tracks::BUILTIN_SLOTS).enumerate() {
        let track = &settings["tracks"][id];
        project.gain[i] = number(track.get("volume"), 1., 0., 1.)?;
        project.muted[i] = track["muted"].as_bool().unwrap_or(false);
        project.solo[i] = track["solo"].as_bool().unwrap_or(false);
        for extension in ["flac", "wav"] {
            let relative = format!("stems/{id}.{extension}");
            let source = dir.join(&relative);
            if source.is_file() {
                let source = source.canonicalize()?;
                if !source.starts_with(&dir) {
                    bail!("Audio source leaves project folder")
                }
                if let Some(expected) =
                    meta["stemHashes"][format!("{id}.{extension}")]["size"].as_u64()
                {
                    if source.metadata()?.len() != expected {
                        bail!("Damaged stem: {id}")
                    }
                }
                project.lane_specs.push(crate::tracks::Lane::builtin(i,source.clone())?);
                project.lanes.push((i, source));
                break;
            }
        }
    }
    if let Some(hashes) = meta["stemHashes"].as_object() {
        for name in hashes.keys() {
            if STEMS
                .iter().take(crate::tracks::BUILTIN_SLOTS)
                .any(|stem| name == &format!("{stem}.flac") || name == &format!("{stem}.wav"))
                && !dir.join("stems").join(name).is_file()
            {
                bail!("Project stem is missing: {name}")
            }
        }
    }
    let mut custom=crate::tracks::resolve_custom(&dir,&settings["custom"])?;
    if let Some(overlay)=overlay{custom.lanes=overlay_custom_lanes(&project,&custom.lanes,overlay)?;}
    project.track_warnings=custom.warnings;
    if project.lanes.is_empty() && !(settings["nativeOriginalDisabled"]==true||stored_empty||overlay.is_some_and(|o|!o.mix.original)) {
        let original=(||->Result<PathBuf>{
            let relative=meta["songFile"].as_str().context("Project contains no playable audio")?;
            let source=dir.join(relative).canonicalize().context("Project audio is missing")?;
            anyhow::ensure!(source.starts_with(&dir)&&source.is_file(),"Audio source leaves project folder or is not a file");Ok(source)
        })();
        match original {
            Ok(source)=>{
                project.original=true;let track=&settings["tracks"]["original"];
                project.gain[5]=number(track.get("volume"),1.,0.,1.)?;
                project.muted[5]=track["muted"].as_bool().unwrap_or(false);
                project.solo[5]=track["solo"].as_bool().unwrap_or(false);
                project.lane_specs.push(crate::tracks::Lane::original(source.clone()));
                project.lanes.push((5,source));
            }
            Err(error)if !custom.lanes.is_empty()=>project.track_warnings.push(format!("Original song audio is unavailable; loaded the saved custom tracks: {error:#}")),
            Err(error)=>return Err(error),
        }
    }
    for lane in custom.lanes {
        let slot=lane.slot;let track=&settings["tracks"][&lane.id];
        if let Some(captured)=overlay.and_then(|o|o.mix.custom.iter().find(|old|old.id==lane.id).map(|old|(o,old.slot))) {
            let (overlay,old_slot)=captured;project.gain[slot]=overlay.mix.gain[old_slot];project.muted[slot]=overlay.mix.muted[old_slot];project.solo[slot]=overlay.mix.solo[old_slot];
        }else{project.gain[slot]=number(track.get("volume"),1.,0.,1.)?;project.muted[slot]=track["muted"].as_bool().unwrap_or(false);project.solo[slot]=track["solo"].as_bool().unwrap_or(false);}
        project.lanes.push((slot,lane.file.clone()));project.lane_specs.push(lane);
    }
    }else{project.looping=false;project.selection=None;project.view=None;}
    anyhow::ensure!(project.empty_tracks||!project.lanes.is_empty(),"Project contains no playable audio and has no explicit empty intent");
    anyhow::ensure!(project.lanes.len()<=crate::tracks::MAX_ACTIVE_LANES,"The native player supports at most sixteen active tracks");
    if full {
        project.lane_stamps = project.lanes.iter().map(|(_,p)| crate::project_analysis::stamp(p)).collect::<Result<_>>()?;
        if let Some((_, source)) = project.lanes.iter().find(|(i, _)| *i == 0) {
            project.vocal_stamp = Some(crate::project_analysis::stamp(source)?);
        }
    }
    Ok(project)
}
pub fn library_root() -> PathBuf {
    crate::project_library::library_root()
}
pub fn fixture_mode() -> bool {
    #[cfg(feature = "ui-tests")]
    { gated_env!("SINGZ_GPUI_DEMO").is_some()
        || std::env::vars_os().any(|(key, _)| {
            let key = key.to_string_lossy();
            key.starts_with("SINGZ_GPUI_")
                && ["REVIEW", "SMOKE", "BENCHMARK", "PROFILE", "CAPTURE_FILE"]
                    .iter()
                    .any(|s| key.contains(s))
        }) }
    #[cfg(not(feature = "ui-tests"))]
    { false }
}
#[cfg(all(test, not(feature = "ui-tests")))]
mod gated_fixture_tests {
    #[test]
    fn release_ignores_demo_fixture() {
        if std::env::var_os("SINGZ_C23_FIXTURE_CHILD").is_some() {
            assert!(!super::fixture_mode());
        } else {
            let status = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("release_ignores_demo_fixture")
                .env("SINGZ_C23_FIXTURE_CHILD", "1")
                .env("SINGZ_GPUI_DEMO", "1")
                .status().unwrap();
            assert!(status.success(), "isolated fixture test failed");
        }
    }
}
#[path="integration_provider.rs"]
mod provider_control;
pub use provider_control::ProviderSnapshot;

#[derive(Clone, Debug)]
pub struct Status {
    pub graph_snapshot: Option<Arc<crate::playback_graph::Snapshot>>,
    pub graph_error: Option<String>,
    pub state: u32,
    pub transport_state: u32,
    pub output_peak:f32,
    pub output_clipped_blocks:u64,
    pub explicit_graph: bool,
    pub graph_nodes: u64,
    pub graph_connections: u64,
    #[cfg(feature="ui-tests")]
    pub observed_lanes: serde_json::Value,
    #[cfg(feature="ui-tests")]
    pub observed_master_gain: Option<f64>,
    #[cfg(feature="ui-tests")]
    pub observed_provider: Option<String>,
    #[cfg(feature="ui-tests")]
    pub observed_backend_provider: Option<String>,
    #[cfg(feature="ui-tests")]
    pub observed_fixture: Option<bool>,
    pub counting_in: bool,
    pub count_in_heard:Option<crate::transport_timing::Heard>,
    pub rendered_frame: i64,
    pub training_only: bool,
    pub empty_project: bool,
    pub lane_revision: u64,
    pub carry_revision:u64,
    pub cue: crate::training_audio::Status,
    pub graph_generation: u64,
    pub parked: bool,
    pub physical_output_released: bool,
    pub sampled_at: Instant,
    pub output_uid: String,
    pub output_label: String,
    pub rate: f32,
    pub transpose: i32,
    pub seek_count: u64,
    pub loop_count: u64,
    pub loop_range: Option<(f64, f64)>,
    pub region_range: Option<(f64, f64)>,
    pub audible_current: bool,
    pub position: f64,
    pub duration: f64,
    pub playing: bool,
}
impl Status {
    fn parse(v: &Value) -> Result<Self> {
        if v["protocol"] != 1 {
            bail!("Unsupported native audio protocol")
        }
        if v["ok"] != true {
            bail!("{}", v["error"].as_str().unwrap_or("Native audio failed"))
        }
        Self::reported(v)
    }
    /// Parse actual state independently of command acceptance, solely to
    /// classify an explicit rejection before a subsequent successful status
    /// proves the old graph. Never returned as an accepted command receipt.
    fn reported(v:&Value)->Result<Self>{
        anyhow::ensure!(v["protocol"]==1,"Unsupported native audio protocol");
        if matches!(v["state"].as_u64(), Some(6 | 7)) {
            crate::diagnostics::event(
                "audio",
                format!("Native output failure: session={}, host={}, terminal={}, xruns={}, renderFailures={}",
                    v["state"],v["baseHostState"],v["baseHostTerminalReason"],v["baseHostXruns"],v["baseHostRenderFailures"]),
                crate::diagnostics::Level::Error,
            );
            bail!("Native output stopped unexpectedly")
        }
        let position = seconds(v.get("position"), 0., 0., 86400. * 365.)?;
        let duration = seconds(v.get("duration"), 0., 0., 86400. * 365.)?;
        if v["trainingOnly"] == true {
            anyhow::ensure!(
                duration == 0. && position == 0. && v["playing"] == false,
                "Invalid training-only playback state"
            );
        }
        let empty_project=v["emptyProject"]==true;
        let lane_revision=v["laneSetRevision"].as_u64().unwrap_or(0);
        if empty_project{validate_empty_status(v,position,duration)?;}
        if duration <= 0. && v["trainingOnly"] != true && !empty_project {
            bail!("Native engine returned no audio duration")
        }
        let count_in_heard=crate::transport_timing::Heard::parse(v.get("countInHeard"))?;
        if count_in_heard.is_some(){anyhow::ensure!(!empty_project&&v["trainingOnly"]!=true&&v["playing"]==true&&v["countingIn"]==true,"Inconsistent native heard count-in state");}
        let start = seconds(v.get("loopStart"), 0., 0., 86400. * 365.)?;
        let end = seconds(v.get("loopEnd"), 0., 0., 86400. * 365.)?;
        let state = match v.get("state") {
            None => 0,
            Some(value) => value.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(u32::MAX),
        };
        let transport_state = match v.get("transportState") {
            // Older fixture/protocol packets predate the explicit enum. Keep
            // their existing real transport flags instead of inventing Stop.
            None if v["countingIn"] == true => 1,
            None if v["playing"] == true => 2,
            None => 0,
            Some(value) => value.as_u64().and_then(|n| u32::try_from(n).ok()).unwrap_or(u32::MAX),
        };
        let (graph_snapshot, graph_error) = if state > 7 || transport_state > 4 {
            (None, Some("Unavailable runtime graph transport state".into()))
        } else {
            match crate::playback_graph::parse_status(v) {
                Ok(snapshot) => (snapshot.map(Arc::new), None),
                Err(error) => (None, Some(error.to_string())),
            }
        };
        Ok(Self {
            graph_snapshot,
            graph_error,
            state,
            transport_state,
            output_peak:number(v.get("outputPeak"),0.,0.,f32::MAX)?,
            output_clipped_blocks:match v.get("outputClippedBlocks") {
                None=>0,
                Some(value)=>value.as_u64().filter(|count|*count<=u32::MAX as u64).context("Invalid native output clip count")?,
            },
            #[cfg(feature="ui-tests")]
            observed_lanes: v["lanes"].clone(),
            #[cfg(feature="ui-tests")]
            observed_master_gain: v["masterGain"].as_f64(),
            #[cfg(feature="ui-tests")]
            observed_provider: v["provider"].as_str().map(str::to_owned),
            #[cfg(feature="ui-tests")]
            observed_backend_provider: v["backendProvider"].as_str().map(str::to_owned),
            #[cfg(feature="ui-tests")]
            observed_fixture: v["fixture"].as_bool(),
            counting_in: v["countingIn"] == true,
            count_in_heard,
            rendered_frame: v["renderedProjectFrame"].as_i64().unwrap_or(0),
            training_only: v["trainingOnly"] == true,
            empty_project,
            lane_revision,
            carry_revision:v["carryRevision"].as_u64().unwrap_or(0),
            cue: crate::training_audio::Status::parse(v)?,
            graph_generation: v["graphGeneration"].as_u64().unwrap_or(0),
            explicit_graph: v["explicitGraph"]==true,
            graph_nodes: v["graphNodeCount"].as_u64().unwrap_or(0),
            graph_connections: v["graphConnectionCount"].as_u64().unwrap_or(0),
            parked: v["parked"] == true,
            physical_output_released: v["physicalOutputReleased"] == true,
            sampled_at: Instant::now(),
            output_uid: v["outputUid"].as_str().unwrap_or("").into(),
            output_label: v["outputLabel"].as_str().unwrap_or("").into(),
            rate: number(v.get("playbackRate"), 1., 0.25, 4.)?,
            transpose: number(v.get("transpose"), 0., -24., 24.)? as i32,
            seek_count: v["seekCount"].as_u64().unwrap_or(0),
            loop_count: v["loopCount"].as_u64().unwrap_or(0),
            region_range: if v["regionEnabled"]==true {
                let start=seconds(v.get("regionStart"),0.,0.,86400.*365.)?;
                let end=seconds(v.get("regionEnd"),0.,0.,86400.*365.)?;
                anyhow::ensure!(end>start,"Invalid native playback region");
                Some((start,end))
            } else {None},
            loop_range: if v["looping"] == true && end > start {
                Some((start, end))
            } else {
                None
            },
            audible_current: v["audibleCurrent"] == true,
            position,
            duration,
            playing: v["playing"].as_bool().unwrap_or(false),
        })
    }
}
fn validate_empty_status(v:&Value,position:f64,duration:f64)->Result<()> {
    anyhow::ensure!(v["trainingOnly"]==false&&v["laneSetRevision"].as_u64().is_some_and(|n|n>0)&&v["graphGeneration"]==0&&v["state"]==0&&position==0.&&duration==0.&&v["playing"]==false&&!v["countingIn"].as_bool().unwrap_or(false)&&!v["looping"].as_bool().unwrap_or(false),"Invalid empty-project playback state");
    for key in ["lanes","laneIds","laneDurations","peaks"]{anyhow::ensure!(v[key].as_array().is_some_and(Vec::is_empty),"Empty project contains native {key}");}
    let cue_owns_output=v["physicalOutputReleased"]==false&&v["baseHostState"]==2&&v["baseCallbacks"].as_u64().is_some()&&v["cueGeneration"].as_u64().is_some_and(|n|n>0)&&v["cueStartHostNs"].as_str().and_then(|n|n.parse::<u64>().ok()).is_some_and(|n|n>0);
    anyhow::ensure!(v["physicalOutputReleased"]==true||cue_owns_output,"Empty project retains output without a standalone training cue");
    let proof=&v["cleanupProof"];
    let no_owner=proof["neverClaimed"]==true&&proof["generation"]==0;
    let retired=proof["neverClaimed"]==false&&proof["globallyComplete"]==true&&proof["generation"].as_u64().is_some_and(|n|n>0)&&proof["handoffLease"].as_u64().is_some_and(|n|n>0);
    anyhow::ensure!(proof.is_object()&&(no_owner||retired)&&proof["physicalOwnershipRetained"]==false&&proof["retainedBytes"]==0&&proof["parkedLaneBytes"]==0&&proof["quarantineBytes"]==0&&proof["quarantinePoisoned"]==false&&proof["quarantineReserved"].as_bool().unwrap_or(false)==false,"Empty project has no safe native cleanup proof");Ok(())
}
fn admit_lane_revision(current:&mut u64,status:&Status)->Result<()> {
    anyhow::ensure!(status.lane_revision>=*current,"Stale native lane-set status");*current=status.lane_revision;Ok(())
}
fn validate_playback_command(command:&str)->Result<()>{anyhow::ensure!(matches!(command,"play"|"pause"|"play-flat"),"Unsupported native playback command");Ok(())}
fn publish_playback_receipt(events:&mpsc::Sender<Event>,telemetry:&Mutex<Option<(u64,Status)>>,epoch:u64,serial:u64,status:Status){
    *telemetry.lock().unwrap_or_else(|e|e.into_inner())=Some((epoch,status.clone()));
    let _=events.send(Event::Playback(epoch,serial,status));
}
#[derive(Debug)]
enum PlaybackReceipt {Applied(Status),Cancelled}
fn settle_playback_receipt(
    mut reply:Value, timeout:Duration,
    current:impl Fn()->bool, mut poll:impl FnMut()->Result<Value>,
) -> Result<PlaybackReceipt> {
    let generation=reply["transportGeneration"].as_u64().filter(|g|*g>0).context("Native playback receipt has no transport generation")?;
    let ticket=reply["transportCommandsQueued"].as_u64().and_then(|n|u32::try_from(n).ok()).context("Native playback receipt has no command ticket")?;
    let deadline=Instant::now()+timeout;
    loop {
        let status=Status::parse(&reply)?;
        anyhow::ensure!(reply["transportGeneration"].as_u64()==Some(generation),"Native playback receipt changed generation");
        let applied=reply["transportCommandsApplied"].as_u64().and_then(|n|u32::try_from(n).ok()).context("Native playback receipt has no callback acknowledgement")?;
        // At most 64 mailbox entries are outstanding, so a half-range unsigned
        // comparison is unambiguous even when the u32 cursor wraps. This proves
        // this Resume ran, including Resume + a region end in one callback.
        let acknowledged=applied.wrapping_sub(ticket)<(1u32<<31);
        anyhow::ensure!(acknowledged||Instant::now()<deadline,"Native playback command was not acknowledged before its receipt deadline");
        // Cancellation is clean only after the preceding reply was fully read
        // and validated. I/O, parse, and deadline failures remain transport faults.
        if !current() {return Ok(PlaybackReceipt::Cancelled);}
        if acknowledged {return Ok(PlaybackReceipt::Applied(status));}
        thread::sleep(Duration::from_millis(2));
        reply=poll()?;
    }
}

enum RateFailure{Refused(String),Transport(String)}
fn same_rate_ownership(before:&Value,after:&Value)->Result<()> {
    for key in ["graphGeneration","laneSetRevision","carryRevision","laneIds","lanes","masterGain","referenceGain","outputUid","trainingOnly","emptyProject","duration","looping","loopStart","loopEnd","regionEnabled","regionStart","regionEnd","parked","physicalOutputReleased"]{
        anyhow::ensure!(before[key]==after[key],"Native playback {key} changed");
    }Ok(())
}
fn retained_rate(before:&Value,after:&Value)->Result<Status>{let old=Status::parse(before)?;let current=Status::parse(after)?;same_rate_ownership(before,after)?;anyhow::ensure!(old.rate==current.rate&&old.transpose==current.transpose,"Native tempo or transpose changed despite refusal");Ok(current)}
fn retained_output(before:&Value,rejected:&Value,after:&Value)->Result<Status> {
    anyhow::ensure!(rejected["ok"]==false,"Output refusal was not explicit");
    let refused=Status::reported(rejected)?;
    same_rate_ownership(before,rejected)?;
    let current=retained_rate(before,after)?;
    let old=Status::parse(before)?;
    anyhow::ensure!(refused.playing==old.playing&&current.playing==old.playing,
        "Native playback changed while the output route was refused");
    Ok(current)
}
fn accepted_output(before:&Value,reply:&Value,uid:&str)->Result<Status> {
    let old=Status::parse(before)?;let status=Status::parse(reply)?;
    anyhow::ensure!(uid.is_empty()||status.output_uid==uid,"Native output differs from the selected device");
    anyhow::ensure!(!status.playing&&!status.counting_in&&status.rate==old.rate&&status.transpose==old.transpose,
        "Native route did not preserve paused tempo/transpose");
    for key in ["laneIds","lanes","masterGain","referenceGain","trainingOnly","emptyProject","explicitGraph","graphNodeCount","graphConnectionCount"] {
        anyhow::ensure!(before[key]==reply[key],"Native playback {key} changed during output selection");
    }
    anyhow::ensure!((status.duration-old.duration).abs()<=0.001+f64::EPSILON*old.duration.abs(),"Native duration changed during output selection");
    anyhow::ensure!(status.loop_range==old.loop_range||status.loop_range.zip(old.loop_range).is_some_and(|(a,b)|(a.0-b.0).abs()<=0.001&&(a.1-b.1).abs()<=0.001),"Native loop changed during output selection");
    Ok(status)
}
fn accepted_rate(before:&Value,reply:&Value,rate:f32,transpose:i32)->Result<Status>{let old=Status::parse(before)?;let status=Status::parse(reply)?;anyhow::ensure!((status.rate-rate).abs()<0.00001&&status.transpose==transpose,"Native tempo or transpose differs from request");anyhow::ensure!(status.lane_revision==old.lane_revision&&status.carry_revision==old.carry_revision,"Native lane or Carry inventory changed during tempo update");for key in ["laneIds","lanes","masterGain","referenceGain","outputUid","trainingOnly","emptyProject","regionEnabled","regionStart","regionEnd"]{anyhow::ensure!(before[key]==reply[key],"Native playback {key} changed during tempo update");}Ok(status)}
fn admit_carry_revision(current:&mut u64,status:&Status)->Result<()> {anyhow::ensure!(status.carry_revision>=*current,"Stale native Carry the line status");*current=status.carry_revision;Ok(())}
fn carry_reply(value:Value,plan:&crate::carry_line::Plan)->std::result::Result<Status,LaneReplaceFailure>{
    if value["carryCommitted"]!=true{
        let message=value["error"].as_str().unwrap_or("Native Carry the line apply was not confirmed").to_owned();
        return Err(if value["protocol"]==1&&value["ok"]==false&&value["carryCommitted"]==false{
            if matches!(value["state"].as_u64(),Some(6|7)){LaneReplaceFailure::Disconnected(format!("Native output stopped before Carry the line could be applied: {message}"))}else{LaneReplaceFailure::Refused(message)}
        }else{LaneReplaceFailure::Committed(message)});
    }
    let result=(||->Result<Status>{
        let status=Status::parse(&value)?;anyhow::ensure!(status.carry_revision>0&&value["carryRequested"].as_bool()==Some(plan.on),"Native Carry the line intent differs from the request");
        let expected_enabled=plan.on&&!plan.lane_ids.is_empty()&&(plan.mode==0||!plan.windows.is_empty());anyhow::ensure!(value["carryEnabled"].as_bool()==Some(expected_enabled),"Native Carry the line effective state differs from request");
        if plan.on {
            anyhow::ensure!(value["carryMode"].as_u64()==Some(plan.mode as u64),"Native Carry the line mode differs");
            let ids=value["carryLaneIds"].as_array().context("Missing native Carry the line lanes")?;anyhow::ensure!(ids.len()==plan.lane_ids.len()&&ids.iter().zip(&plan.lane_ids).all(|(a,b)|a.as_str()==Some(b.as_str())),"Native Carry the line lane IDs differ");
            if plan.mode==0{anyhow::ensure!(value["carryPeriod"].as_f64().is_some_and(|p|(p-plan.period_sec).abs()<0.00001),"Native Carry the line period differs");}
            else{let windows=value["carryWindows"].as_array().context("Missing native Carry the line windows")?;let tolerance=value["sampleRate"].as_f64().filter(|r|*r>0.).map_or(0.0001,|rate|1./rate+0.000001);anyhow::ensure!(windows.len()==plan.windows.len()&&windows.iter().zip(&plan.windows).all(|(a,b)|a.as_array().is_some_and(|a|a.len()==2&&a[0].as_f64().is_some_and(|n|(n-b.s).abs()<=tolerance)&&a[1].as_f64().is_some_and(|n|(n-b.e).abs()<=tolerance))),"Native Carry the line windows differ");}
        }Ok(status)
    })();result.map_err(|e|LaneReplaceFailure::Committed(format!("Carry the line was committed, but native playback failed: {e:#}. Reopen the project.")))
}
#[derive(Clone,Debug)]
pub struct ResolvedLyrics {
    pub raw:Value,
    pub document:Arc<crate::project_lyrics::Document>,
    pub fingerprint:Option<String>,
    pub check:Option<crate::alignmentoutcome_domain::Check>,
    pub written:bool,
    pub cached:bool,
    pub warnings:Vec<String>,
}
fn lyrics_client()->crate::lrclib::Client {
    #[cfg(any(test,feature="ui-tests"))]
    if let Ok(url)=std::env::var("SINGZ_GPUI_LRCLIB_URL") {
        return crate::lrclib::Client::with_base_url(&url).expect("Invalid isolated LRCLIB test URL");
    }
    crate::lrclib::Client::default()
}
fn publish_resolved_lyrics(project:&Project,mut proposal:crate::lyrics_resolution::Proposal,text:&Arc<gpui_kit::TextSystem>,cancel:&impl Fn()->bool)->std::result::Result<ResolvedLyrics,crate::lyrics_align::Failure>{
    use crate::lyrics_align::Failure;
    let result=(||->Result<ResolvedLyrics>{
        anyhow::ensure!(!cancel(),"Lyrics request cancelled");
        let mut document=crate::project_lyrics::from_value(&proposal.raw)?.context("No lyric lines to publish")?;
        crate::project_lyrics::prepare_masks(&mut document,text,cancel)?;
        let _lease=crate::project_publish::lock(&project.dir)?;
        crate::project_publish::recover_locked(&project.dir)?;
        anyhow::ensure!(crate::lyrics_store::identity(&project.dir)?==project.lyrics_fingerprint,"Lyrics changed outside this app. Reopen the song before continuing.");
        anyhow::ensure!(!cancel(),"Lyrics request cancelled");
        let fingerprint=if proposal.write {
            crate::lyrics_store::backup_before_replace_locked(&project.dir,project.lyrics_fingerprint.as_deref(),true)?;
            anyhow::ensure!(!cancel(),"Lyrics request cancelled");
            let hash=crate::project_store::commit_expected_locked(&project.dir,"lyrics.json",project.lyrics_fingerprint.as_deref(),&proposal.raw)?;
            if let Err(e)=crate::sync_dirty::mark_file(&project.dir.join("lyrics.json"),"lyrics") {proposal.warnings.push(format!("Lyrics were saved, but the pending-sync record could not be written: {e:#}. Save again to retry."));}
            Some(hash)
        }else{project.lyrics_fingerprint.clone()};
        #[cfg(feature="ui-tests")]
        if proposal.write {
            if let Some(gate)=std::env::var_os("SINGZ_GPUI_LYRICS_RESOLVE_RECEIPT_GATE").map(PathBuf::from).filter(|p|p.exists()){
                let _=std::fs::write(gate.with_extension("ready"),b"committed");let deadline=Instant::now()+Duration::from_secs(8);
                while gate.exists()&&!cancel()&&Instant::now()<deadline{thread::sleep(Duration::from_millis(10));}
            }
        }
        Ok(ResolvedLyrics{raw:proposal.raw,document:Arc::new(document),fingerprint,check:proposal.check,written:proposal.write,cached:proposal.cached,warnings:proposal.warnings})
    })();
    if cancel()&&!result.as_ref().is_ok_and(|r|r.written){Err(Failure::Cancelled)}else{result.map_err(|e|Failure::Error(format!("{e:#}")))}
}
pub enum Event {
    Provider(ProviderSnapshot),
    Region(u64,u64,std::result::Result<Status,String>),
    Playback(u64,u64,Status),
    AnalysisStarted(u64,u64),
    AnalysisStopped(u64),
    AnalysisProgress(u64,u64,f32),
    Rate(u64,u64,std::result::Result<Status,String>),
    RateTransportFailed(u64,u64,String),
    Carry(u64,u64,std::result::Result<(crate::carry_line::Desired,Status),String>),
    CarryCommittedFailed(u64,u64,crate::carry_line::Desired,String),
    CarryTransportFailed(u64,u64,String),
    CarryPrefs(std::result::Result<crate::carry_line::Config,String>),
    CarryPrefsSaved(u64,u64,Option<String>),
    LyricsCapabilities(crate::lyrics_align::Capabilities),
    #[cfg(feature="ui-tests")]
    LyricsJobSettled(u64,u64),
    LyricsResolved(u64,u64,std::result::Result<ResolvedLyrics,crate::lyrics_align::Failure>),
    LyricsSearch(u64,u64,std::result::Result<Vec<crate::lrclib::Candidate>,String>),
    LyricsAlignmentProgress(u64,u64,crate::lyrics_align::Progress),
    LyricsAligned(u64,u64,std::result::Result<crate::lyrics_align::Output,crate::lyrics_align::Failure>),
    LyricsEnvelope(u64, u64, std::result::Result<Arc<crate::lyrics_envelope::Envelopes>,String>),
    LyricsSaved(u64, u64, std::result::Result<ResolvedLyrics, String>),
    BeatsProgress(u64, u64, f32),
    BeatsDetected(u64, u64, std::result::Result<crate::beat_analysis::Output, String>),
    MetronomePrefs(std::result::Result<crate::beat::Metronome, String>),
    MetronomePrefsSaved(u64, u64, Option<String>),
    Metronome(
        u64,
        u64,
        crate::beat::Metronome,
        Option<crate::beat::Beats>,
        std::result::Result<Status, String>,
    ),
    Training(u64, u64, std::result::Result<Option<Status>, String>),
    Parked(u64, u64, bool, std::result::Result<Option<Status>, String>),
    InputPrefsSaved(u64, Option<String>),
    InputPrefs(std::result::Result<crate::microphone::Prefs, String>),
    Inventory(std::result::Result<crate::audio_devices::Inventory, String>),
    AudioPrefs(String, Option<String>),
    KaraokePref(bool),
    KaraokePrefSaved(u64, Option<String>),
    OutputChanged(u64, String, Option<Status>, Option<String>),
    Catalog(u64,PathBuf,Vec<Project>),
    Opened(u64, Project, Status, Vec<Vec<f32>>),
    Status(u64, Status),
    Error(u64, String),
    TransportFailed(u64, String),
    #[cfg(feature="ui-tests")]
    SourceSeekRestored(u64,Status),
    OutputRecovered(u64, u64, String, std::result::Result<RecoveredAudio, String>),
    PublicationRead(u64, u64, std::result::Result<Project, String>),
    Saved(u64, u64, Value, String, Vec<crate::tracks::Lane>, Vec<String>, Vec<(String,(u64,std::time::SystemTime))>),
    LanesReplaced(u64,u64,std::result::Result<(Project,Status,Vec<Vec<f32>>),String>),
    LanesCommittedFailed(u64,u64,Project,String),
    LanesTransportFailed(u64,u64,String),
    SaveFailed(u64, String),
    Renamed(u64, PathBuf, Option<String>, Option<(String, String)>),
    ImportedLibrary(u64, crate::project_import::Outcome, Option<Status>),
    DeleteInspected(u64, std::result::Result<crate::project_delete::Target, String>),
    /// Loaded-target failures leave its old native connection released. The
    /// host reopens its captured authoritative active project paused; unrelated
    /// project deletion never changes that project's playback connection.
    Deleted(u64, u64, bool, std::result::Result<crate::project_delete::Outcome, String>),
    Analyzed(u64,u64, std::result::Result<crate::project_analysis::Output, String>),
}
#[cfg(feature = "ui-tests")]
pub struct OwnedAudioProbe {
    pub epoch: u64,
    pub helper_pid: u32,
    pub monitor_leased: bool,
    pub active_training: Option<(u64, u64)>,
    pub status: Status,
}

enum Request {
    Wake,
    Admitted(Box<Request>, Admission),
    OpenPreparationFailed(u64,String),
    LanePreparationFailed(u64,u64,String,Option<Project>),
    Inventory,
    InspectDelete(PathBuf,PathBuf,u64),
    AdoptOpen(jobs::Open),AdoptLanes(jobs::Lanes),
    AdoptRecovery(u64,u64,AudioRecovery,String,Option<provider_control::PendingWork>,bool,Option<jobs::Manifest>),
    ImportCompleted(u64,crate::project_import::Outcome,bool,Option<provider_control::PendingWork>),
    ProviderChosen(provider_control::ProviderState,String,bool),
    OutputProbed(String,std::result::Result<(),String>),
    RecoveryVerified(u64,u64,String,std::result::Result<RecoveredAudio,String>),
    #[cfg(test)]
    ActorBarrier(mpsc::SyncSender<()>),
    #[cfg(test)]
    SetTestMonitor(bool, mpsc::SyncSender<()>),
    #[cfg(test)]
    HoldJob(mpsc::SyncSender<()>, mpsc::Receiver<()>),
    #[cfg(test)]
    InstallTestConnection(Connection, mpsc::SyncSender<()>),
    #[cfg(test)]
    ReceiptFence(u64,u64,mpsc::SyncSender<(u64,u64,Status)>),
    Provider(u64,u64,u64,u64,crate::audio_devices::Provider),
    KaraokePref(u64,bool),
    Region(u64,u64,crate::region_gesture::Target,f64),
    Rate(u64,u64,f32,i32),
    Carry(u64,u64,crate::carry_line::Plan,Arc<AtomicU64>),
    AdoptCarryPreferences(u64,crate::carry_line::Config),
    LyricsCapabilities,
    AlignLyrics(u64,u64,Project,Vec<crate::lyrics_edit::Line>,crate::lyrics_align::Tier),
    ResolveLyrics(u64,u64,Project,crate::lyrics_resolution::Intent),
    SearchLyrics(u64,u64,String,f64),
    LyricsEnvelope(u64,u64,Project),
    SaveLyrics(u64, u64, PathBuf, Option<String>, Value, Option<String>),
    DetectBeats(u64, u64, Project),
    AdoptMetronomePreferences(u64, crate::beat::Metronome),
    Metronome(u64, u64, crate::beat::Metronome, Option<crate::beat::Beats>),
    Training(u64, crate::training_audio::Phrase),
    CancelTraining(u64, u64),
    Park(u64, u64, bool),
    InputPrefs(u64, crate::microphone::Prefs),
    Output(String),
    RecoverOutput(u64, u64, AudioRecovery, String),
    ReadPublication(u64, u64, Publication),
    #[cfg(feature="ui-tests")]
    FailOwnedAudio(u64),
    #[cfg(feature = "ui-tests")]
    ProbeOwnedAudio(u64, SyncSender<std::result::Result<OwnedAudioProbe, String>>),
    Catalog(u64,Arc<AtomicU64>),
    Open(u64, PathBuf, Option<crate::beat::Metronome>, Option<crate::project_delete::Target>, Option<OpenCustomOverlay>),
    Control(u64, String),
    RestoreSeek(u64,f64),
    Playback(u64,u64,String,Arc<AtomicBool>),
    Rename(u64, PathBuf, String, String),
    ImportLibrary(u64, crate::project_import::Input),
    Delete(u64, u64, bool, crate::project_delete::Target, Arc<AtomicU8>),
    ReplaceLanes(u64,u64,Project,Vec<PathBuf>,Arc<AtomicU64>),
}
pub struct Backend {
    provider_selected:Arc<AtomicU64>,
    provider_renderer:Arc<AtomicU64>,
    provider_pending:Arc<AtomicU64>,
    provider_retired:Arc<AtomicU64>,
    provider_gate:Arc<Mutex<()>>,
    provider_reserved:Arc<AtomicBool>,
    saves: save_worker::Service,
    carry_intent:Arc<AtomicU64>,
    playback_intent:Arc<AtomicU64>,
    lanes_intent: Arc<AtomicU64>,
    copy_handoff: Arc<AtomicU64>,
    catalog_intent: Arc<AtomicU64>,
    lyrics_search_intent: Arc<AtomicU64>,
    lyrics_align_intent: Arc<AtomicU64>,
    lyrics_preview_intent: Arc<AtomicU64>,
    beat_intent: Arc<AtomicU64>,
    training_intent: Arc<AtomicU64>,
    requests: Requests,
    events: Receiver<Event>,
    telemetry: Arc<Mutex<Option<(u64, Status)>>>,
    epoch: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Backend {
    fn drop(&mut self) {
        // Drain accepted explicit saves while native polling is still alive.
        // Capture yields to their memory intents even during application quit.
        self.saves.finish();
        self.alive.store(false, Ordering::Release);
        let _=self.requests.transport.try_send(Request::Wake);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Backend {
    pub fn current_epoch(&self) -> u64 {
        self.epoch.load(Ordering::Acquire)
    }
    pub fn new(text: Arc<gpui_kit::TextSystem>) -> Self {
        let (tx, rx) = mpsc::sync_channel(128);
        let (events, output) = mpsc::channel();
        let save_reanchors: save_worker::Reanchors = Arc::new(Mutex::new(vec![]));
        let saves = save_worker::Service::new(events.clone(), save_reanchors.clone());
        let telemetry = Arc::new(Mutex::new(None));
        let pending = telemetry.clone();
        let epoch = Arc::new(AtomicU64::new(0));
        let alive = Arc::new(AtomicBool::new(true));
        let e = epoch.clone();
        let a = alive.clone();
        let provider_selected=Arc::new(AtomicU64::new(crate::audio_devices::Provider::platform_default().code()));
        let provider_renderer=Arc::new(AtomicU64::new(1));
        let provider_pending=Arc::new(AtomicU64::new(0));
        let provider_retired=Arc::new(AtomicU64::new(0));
        let provider_gate=Arc::new(Mutex::new(()));
        let provider_reserved=Arc::new(AtomicBool::new(false));
        let playback_intent=Arc::new(AtomicU64::new(0));let playback_worker=playback_intent.clone();
        let training_intent = Arc::new(AtomicU64::new(0));
        let intent = training_intent.clone();
        let beat_intent = Arc::new(AtomicU64::new(0));
        let beat_cancel = beat_intent.clone();
        let lyrics_preview_intent = Arc::new(AtomicU64::new(0));
        let lyrics_preview = lyrics_preview_intent.clone();
        let lyrics_align_intent=Arc::new(AtomicU64::new(0));let lyrics_align=lyrics_align_intent.clone();
        let lyrics_search_intent=Arc::new(AtomicU64::new(0));let lyrics_search=lyrics_search_intent.clone();
        let copy_handoff=Arc::new(AtomicU64::new(0));let worker_handoff=copy_handoff.clone();
        let provider_args=(provider_selected.clone(),provider_renderer.clone(),provider_pending.clone(),provider_retired.clone(),provider_gate.clone(),provider_reserved.clone());
        let (jobs,jobs_rx)=jobs::mailboxes(provider_pending.clone(), tx.clone());let slots=jobs.slots.clone();
        let job_sender=jobs.clone();let transport=tx.clone();
        let owner_busy=Arc::new(AtomicBool::new(false));
        let worker=thread::Builder::new().name("native-transport".into()).spawn(move||{
            let (init,initialized)=mpsc::sync_channel(1);
            let jobs_args=(events.clone(),e.clone(),a.clone(),intent.clone(),provider_args.clone(),owner_busy.clone());
            let cleanup=job_sender.clone();
            let jobs_worker=thread::Builder::new().name("native-jobs".into()).spawn(move||{
                let (events,latest,alive,training,provider,busy)=jobs_args;
                jobs::run(jobs_rx,transport,init,events,latest,alive,text,training,beat_cancel,lyrics_preview,lyrics_align,lyrics_search,provider,busy,slots,cleanup);
            }).expect("spawn native jobs coordinator");
            let result=std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            if let Ok((uid,state))=initialized.recv(){
                transport_actor::run(rx,job_sender.clone(),events,e,a.clone(),pending,intent,worker_handoff,save_reanchors,playback_worker,provider_args.0,provider_args.2,provider_args.3,uid,state,owner_busy);
            }
            }));
            let _=job_sender.send(jobs::Job::Shutdown);let _=jobs_worker.join();
            if let Err(payload)=result{std::panic::resume_unwind(payload);}
        }).expect("spawn native transport actor");
        Self {
            provider_selected,provider_renderer,provider_pending,provider_retired,provider_gate,provider_reserved,
            saves,
            carry_intent:Arc::new(AtomicU64::new(0)),
            playback_intent,
            lanes_intent:Arc::new(AtomicU64::new(0)),
            copy_handoff,
            catalog_intent: Arc::new(AtomicU64::new(0)),
            lyrics_align_intent,
            lyrics_search_intent,
            lyrics_preview_intent,
            beat_intent,
            training_intent,
            requests: Requests{admitted:Arc::new(AtomicU64::new(0)),transport:tx,jobs,alive:alive.clone()},
            events: output,
            telemetry,
            epoch,
            alive,
            worker: Some(worker),
        }
    }
    pub fn drain(&self) -> Vec<Event> {
        let mut events: Vec<Event> = self.events.try_iter().collect();
        if let Some((epoch, status)) = self
            .telemetry
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            events.push(Event::Status(epoch, status));
        }
        events
    }
    /// Mirror only renderer leases that can own playback output. Ordinary
    /// independent Settings input preview is deliberately not such a lease.
    pub fn provider_renderer_busy(&self,busy:bool)->u64 {
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        let old=self.provider_renderer.load(Ordering::Acquire);
        if (old&1!=0)==busy{return old;}
        let next=((old>>1)+1)*2+u64::from(busy);self.provider_renderer.store(next,Ordering::Release);
        // An idle transport has no timer. Renderer lease changes must wake it
        // so Settings receives the new provider eligibility revision.
        // Test-only negative control for omitting the explicit wake.
        #[cfg(test)]
        if std::env::var_os("SINGZ_C17_SUPPRESS_RENDERER_WAKE").is_some(){return next;}
        let _=self.requests.transport.try_send(Request::Wake);
        next
    }
    pub fn provider(&self,serial:u64,expected_revision:u64,expected_epoch:u64,provider:crate::audio_devices::Provider)->Result<()> {
        anyhow::ensure!(serial>0&&expected_epoch==self.current_epoch(),"Audio provider eligibility changed");
        let renderer=self.provider_renderer.load(Ordering::Acquire);
        anyhow::ensure!(renderer&1==0,"Release renderer playback leases before changing provider");
        self.requests.try_send(Request::Provider(serial,expected_revision,expected_epoch,renderer,provider)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    /// Negative-control adapter: exercise the unchanged worker admission using
    /// its actual renderer fence. This never changes owner or renderer state.
    #[cfg(feature="ui-tests")]
    pub fn probe_provider_worker(&self,serial:u64,expected_revision:u64,expected_epoch:u64,provider:crate::audio_devices::Provider)->Result<()> {
        anyhow::ensure!(serial>0,"Invalid provider probe identifier");
        let renderer=self.provider_renderer.load(Ordering::Acquire);
        self.requests.try_send(Request::Provider(serial,expected_revision,expected_epoch,renderer,provider)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    fn ownership_send(&self,request:Request)->Result<()> {
        self.provider_pending.fetch_add(1,Ordering::AcqRel);
        if self.requests.try_send(request).is_err(){self.provider_pending.fetch_sub(1,Ordering::AcqRel);bail!("Native command queue is full");}Ok(())
    }
    pub fn karaoke_pref(&self,sequence:u64,enabled:bool)->Result<()> {
        self.requests.try_send(Request::KaraokePref(sequence,enabled)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn input_prefs(&self, sequence: u64, prefs: crate::microphone::Prefs) -> Result<()> {
        self.requests
            .try_send(Request::InputPrefs(sequence, prefs))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn inventory(&self) {
        let _ = self.requests.try_send(Request::Inventory);
    }
    pub fn park(&self, epoch: u64, serial: u64, parked: bool) -> Result<()> {
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        self.ownership_send(Request::Park(epoch,serial,parked))
    }
    pub fn output(&self, uid: String) -> Result<()> {
        self.requests
            .try_send(Request::Output(uid))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn restore_seek(&self,epoch:u64,position:f64)->Result<()> {
        self.requests.try_send(Request::RestoreSeek(epoch,position)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn recover_output(&self, epoch: u64, serial: u64, request: AudioRecovery, uid: String) -> Result<()> {
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        self.ownership_send(Request::RecoverOutput(epoch,serial,request,uid))
    }
    pub fn read_publication(&self, epoch: u64, serial: u64, publication: Publication) -> Result<()> {
        self.requests.try_send(Request::ReadPublication(epoch, serial, publication)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    #[cfg(feature="ui-tests")]
    pub fn fail_owned_audio(&self, epoch: u64) -> Result<()> {
        anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1"), "Fault injection requires muted test audio");
        self.requests.try_send(Request::FailOwnedAudio(epoch)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    /// A fresh native status command, read before host status admission. It
    /// neither consults the UI's cached status nor changes helper ownership.
    #[cfg(feature = "ui-tests")]
    pub fn probe_owned_audio(&self, epoch: u64) -> Result<Receiver<std::result::Result<OwnedAudioProbe, String>>> {
        anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref()==Ok("1"), "Native probe requires muted test audio");
        let (tx, rx) = mpsc::sync_channel(1);
        self.requests.try_send(Request::ProbeOwnedAudio(epoch, tx)).map_err(|_|anyhow::anyhow!("Native command queue is full"))?;
        Ok(rx)
    }
    pub fn catalog(&self) {
        let serial=self.catalog_intent.fetch_add(1,Ordering::AcqRel)+1;
        let _ = self.requests.try_send(Request::Catalog(serial,self.catalog_intent.clone()));
    }
    pub fn catalog_current(&self,serial:u64)->bool{self.catalog_intent.load(Ordering::Acquire)==serial}
    pub fn open(&self, path: PathBuf) -> Result<u64> {
        self.open_with_metronome(path, None)
    }
    /// Capture the visible app preference when this navigation begins. A legacy
    /// project inherits it even if a preceding Opened adoption is still queued.
    pub fn open_with_metronome(
        &self,
        path: PathBuf,
        fallback: Option<crate::beat::Metronome>,
    ) -> Result<u64> {
        self.open_request(path,fallback,None,None)
    }
    /// Only original-folder identity is required: a failed deletion may have
    /// been refused precisely because its metadata was independently edited.
    pub fn open_after_delete(&self,path:PathBuf,fallback:Option<crate::beat::Metronome>,confirmed:crate::project_delete::Target)->Result<u64> {
        self.open_request(path,fallback,Some(confirmed),None)
    }
    pub fn open_with_overlay(&self,path:PathBuf,fallback:Option<crate::beat::Metronome>,confirmed:Option<crate::project_delete::Target>,overlay:Option<OpenCustomOverlay>)->Result<u64> {
        self.open_request(path,fallback,confirmed,overlay)
    }
    fn open_request(&self,path:PathBuf,fallback:Option<crate::beat::Metronome>,confirmed:Option<crate::project_delete::Target>,overlay:Option<OpenCustomOverlay>)->Result<u64> {
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        let previous = self.epoch.fetch_add(1, Ordering::AcqRel);
        let epoch = previous + 1;
        if self
            .ownership_send(Request::Open(epoch, path, fallback, confirmed, overlay))
            .is_err()
        {
            self.epoch.store(previous, Ordering::Release);
            bail!("Native command queue is full")
        }
        Ok(epoch)
    }
    /// Only the current Root Opened handler may adopt this already-visible
    /// preference, after preserving its global grid-view choice. Worker prepare
    /// alone is insufficient: its Opened may be rejected by a newer load epoch.
    pub fn adopt_metronome_preferences(
        &self,
        epoch: u64,
        met: crate::beat::Metronome,
    ) -> Result<()> {
        crate::beat::commands(&met, None)?;
        self.requests
            .try_send(Request::AdoptMetronomePreferences(epoch, met))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn rename(&self, dir: PathBuf, expected: String, name: String) -> Result<u64> {
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        // Revoking the previous load epoch cancels analysis before joining it.
        let previous = self.epoch.fetch_add(1, Ordering::AcqRel);
        let epoch = previous + 1;
        if self
            .ownership_send(Request::Rename(epoch, dir, expected, name))
            .is_err()
        {
            self.epoch.store(previous, Ordering::Release);
            bail!("Native command queue is full")
        }
        Ok(epoch)
    }
    pub fn import_library(&self,project:&Project,root:PathBuf,mode:crate::project_import::Mode)->Result<u64>{
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        let input=crate::project_import::Input{source:project.dir.clone(),root,expected_project:project.metadata_hash.clone(),expected_lyrics:project.lyrics_fingerprint.clone(),mode};
        // Revocation cancels every source-bound worker before a Move releases
        // its helper handles and changes the active directory.
        let previous=self.epoch.load(Ordering::Acquire);let epoch=previous+1;
        if mode==crate::project_import::Mode::Copy{self.copy_handoff.store(epoch,Ordering::Release);}
        if self.epoch.compare_exchange(previous,epoch,Ordering::AcqRel,Ordering::Acquire).is_err(){
            let _=self.copy_handoff.compare_exchange(epoch,0,Ordering::AcqRel,Ordering::Acquire);bail!("Project changed before Add to library could start");
        }
        if self.ownership_send(Request::ImportLibrary(epoch,input)).is_err(){
            let _=self.epoch.compare_exchange(epoch,previous,Ordering::AcqRel,Ordering::Acquire);
            let _=self.copy_handoff.compare_exchange(epoch,0,Ordering::AcqRel,Ordering::Acquire);bail!("Native command queue is full");
        }
        Ok(epoch)
    }
    pub fn inspect_delete(&self, root:PathBuf, dir:PathBuf, serial:u64)->Result<()> {
        anyhow::ensure!(self.alive.load(Ordering::Acquire), "Native backend has stopped");
        self.requests.try_send(Request::InspectDelete(root,dir,serial)).map_err(|_|anyhow::anyhow!("Project inspection queue is full"))
    }
    /// The host captures whether the accepted target owns the loaded song,
    /// including a private working copy anchored to that saved destination.
    pub fn delete(&self, target:crate::project_delete::Target, serial:u64, loaded_target:bool)->Result<(u64,bool)> {
        anyhow::ensure!(self.alive.load(Ordering::Acquire), "Native backend has stopped");
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        self.provider_pending.fetch_add(1,Ordering::AcqRel);
        let mut armed_packet=None;
        let admitted=admit_delete_request(&self.requests,&self.epoch,loaded_target,|epoch,armed|{armed_packet=Some(armed.clone());Request::Delete(serial,epoch,loaded_target,target,armed)});
        let epoch=match admitted {Ok(epoch)=>epoch,Err(error)=>{if !armed_packet.is_some_and(|armed|armed.load(Ordering::Acquire)==2){self.provider_pending.fetch_sub(1,Ordering::AcqRel);}return Err(error);}};
        Ok((epoch,loaded_target))
    }
    pub fn save(
        &self,
        epoch: u64,
        seq: u64,
        project: &Project,
        mix: crate::project_store::Mix,
    ) -> Result<()> {
        anyhow::ensure!(self.alive.load(Ordering::Acquire), "Native backend has stopped");
        self.saves.save(epoch, seq, project, mix)
    }
    pub fn rate(&self,epoch:u64,serial:u64,rate:f32,transpose:i32)->Result<()> {
        anyhow::ensure!(rate.is_finite()&&(0.5..=1.5).contains(&rate)&&(-24..=24).contains(&transpose),"Invalid tempo or transpose request");
        self.requests.try_send(Request::Rate(epoch,serial,rate,transpose)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn carry(&self,epoch:u64,serial:u64,plan:crate::carry_line::Plan)->Result<()> {
        plan.commands()?;let old=self.carry_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::Carry(epoch,serial,plan,self.carry_intent.clone())).is_err(){let _=self.carry_intent.compare_exchange(serial,old,Ordering::AcqRel,Ordering::Acquire);bail!("Native command queue is full");}Ok(())
    }
    pub fn adopt_carry_preferences(&self,epoch:u64,config:crate::carry_line::Config)->Result<()> {
        config.validate()?;self.requests.try_send(Request::AdoptCarryPreferences(epoch,config)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn replace_lanes(&self,epoch:u64,serial:u64,candidate:Project)->Result<()> {self.add_tracks(epoch,serial,candidate,vec![])}
    pub fn add_tracks(&self,epoch:u64,serial:u64,candidate:Project,paths:Vec<PathBuf>)->Result<()> {
        anyhow::ensure!(paths.len()<=256,"Choose at most 256 audio files per Add operation");
        anyhow::ensure!(serial>0&&epoch==self.epoch.load(Ordering::Acquire),"Track edit belongs to a retired project");
        let old=self.lanes_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::ReplaceLanes(epoch,serial,candidate,paths,self.lanes_intent.clone())).is_err(){let _=self.lanes_intent.compare_exchange(serial,old,Ordering::AcqRel,Ordering::Acquire);bail!("Native command queue is full");}
        Ok(())
    }
    pub fn save_lyrics(&self, epoch:u64, serial:u64, project:&Project, lines:Value,credit:Option<String>) -> Result<()> {
        self.requests.try_send(Request::SaveLyrics(epoch,serial,project.dir.clone(),project.lyrics_fingerprint.clone(),lines,credit))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn lyrics_envelope(&self,epoch:u64,serial:u64,project:&Project)->Result<()> {
        let old=self.lyrics_preview_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::LyricsEnvelope(epoch,serial,project.clone())).is_err(){self.lyrics_preview_intent.store(old,Ordering::Release);bail!("Native command queue is full");}
        Ok(())
    }
    pub fn cancel_lyrics_preview(&self){self.lyrics_preview_intent.store(0,Ordering::Release);}
    pub fn align_lyrics(&self,epoch:u64,serial:u64,project:&Project,draft:Vec<crate::lyrics_edit::Line>,tier:crate::lyrics_align::Tier)->Result<()> {
        let old=self.lyrics_align_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::AlignLyrics(epoch,serial,project.clone(),draft,tier)).is_err(){self.lyrics_align_intent.store(old,Ordering::Release);bail!("Native command queue is full");}Ok(())
    }
    pub fn cancel_lyrics_alignment(&self){self.lyrics_align_intent.store(0,Ordering::Release);}
    pub fn resolve_lyrics(&self,epoch:u64,serial:u64,project:&Project,intent:crate::lyrics_resolution::Intent)->Result<()> {
        let old=self.lyrics_align_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::ResolveLyrics(epoch,serial,project.clone(),intent)).is_err(){let _=self.lyrics_align_intent.compare_exchange(serial,old,Ordering::AcqRel,Ordering::Acquire);bail!("Native command queue is full");}Ok(())
    }
    pub fn search_lyrics(&self,epoch:u64,serial:u64,query:String,duration:f64)->Result<()> {
        let old=self.lyrics_search_intent.swap(serial,Ordering::AcqRel);
        if self.requests.try_send(Request::SearchLyrics(epoch,serial,query,duration)).is_err(){let _=self.lyrics_search_intent.compare_exchange(serial,old,Ordering::AcqRel,Ordering::Acquire);bail!("Native command queue is full");}Ok(())
    }
    pub fn cancel_lyrics_search(&self){self.lyrics_search_intent.store(0,Ordering::Release);}

    pub fn lyrics_capabilities(&self){let _=self.requests.try_send(Request::LyricsCapabilities);}
    pub fn metronome(
        &self,
        epoch: u64,
        serial: u64,
        met: crate::beat::Metronome,
        beat: Option<crate::beat::Beats>,
    ) -> Result<()> {
        self.requests
            .try_send(Request::Metronome(epoch, serial, met, beat))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn detect_beats(&self, epoch: u64, serial: u64, project: &Project) -> Result<()> {
        let old = self.beat_intent.swap(serial, Ordering::AcqRel);
        if self.requests.try_send(Request::DetectBeats(epoch, serial, project.clone())).is_err() {
            self.beat_intent.store(old, Ordering::Release);
            bail!("Native command queue is full");
        }
        Ok(())
    }
    pub fn cancel_beat_detection(&self) {self.beat_intent.store(0, Ordering::Release);}
    pub fn playback(&self,epoch:u64,serial:u64,command:String)->Result<()> {
        validate_playback_command(&command)?;
        admit_playback_request(&self.requests,&self.playback_intent,serial,|armed|Request::Playback(epoch,serial,command,armed))
    }
    pub fn region(&self,epoch:u64,serial:u64,target:crate::region_gesture::Target,duration:f64)->Result<()> {
        self.requests.try_send(Request::Region(epoch,serial,target,duration)).map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn control(&self, epoch: u64, command: String) -> Result<()> {
        self.requests
            .try_send(Request::Control(epoch, command))
            .map_err(|_|anyhow::anyhow!("Native command queue is full"))
    }
    pub fn training_phrase(
        &self,
        epoch: u64,
        phrase: &crate::training_audio::Phrase,
    ) -> Result<()> {
        phrase.command()?;
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        let previous = self
            .training_intent
            .swap(phrase.generation, Ordering::AcqRel);
        if self
            .ownership_send(Request::Training(epoch, phrase.clone()))
            .is_err()
        {
            let _ = self.training_intent.compare_exchange(
                phrase.generation,
                previous,
                Ordering::AcqRel,
                Ordering::Acquire,
            );
            bail!("Native command queue is full");
        }
        Ok(())
    }
    pub fn cancel_training(&self, epoch: u64, generation: u64) -> Result<()> {
        anyhow::ensure!(generation > 0, "Invalid training generation");
        let _gate=self.provider_gate.lock().unwrap_or_else(|e|e.into_inner());
        provider_control::owner_admission(&self.provider_reserved)?;
        let _ = self.training_intent.compare_exchange(
            generation,
            0,
            Ordering::AcqRel,
            Ordering::Acquire,
        );
        self.ownership_send(Request::CancelTraining(epoch,generation))
    }
}
#[cfg(test)]
fn inspect_delete_requests(requests:Receiver<(PathBuf,PathBuf,u64)>,events:mpsc::Sender<Event>,alive:Arc<AtomicBool>) {
    while alive.load(Ordering::Acquire) {
        match requests.recv_timeout(Duration::from_millis(20)) {
            Ok((root,dir,serial))=>{
                if !alive.load(Ordering::Acquire){break;}
                let result=crate::project_delete::inspect_cancel(&root,&dir,&||!alive.load(Ordering::Acquire)).map_err(|e|format!("{e:#}"));
                if alive.load(Ordering::Acquire){let _=events.send(Event::DeleteInspected(serial,result));}
            }
            Err(mpsc::RecvTimeoutError::Disconnected)=>break,
            Err(_)=>{}
        }
    }
}
fn delete_cancelled(was_loaded:bool,epoch:u64,latest:&AtomicU64,alive:&AtomicBool)->bool {
    !alive.load(Ordering::Acquire)||(was_loaded&&latest.load(Ordering::Acquire)!=epoch)
}
/// A rejected bounded-queue send cannot revoke an in-flight playback receipt.
fn admit_playback_request<T>(requests:&impl RequestQueue<T>,intent:&AtomicU64,serial:u64,make:impl FnOnce(Arc<AtomicBool>)->T)->Result<()> {
    let armed=Arc::new(AtomicBool::new(false));
    requests.try_request(make(armed.clone())).map_err(|_|anyhow::anyhow!("Native command queue is full"))?;
    // Publish only after admission: a failed send cannot transiently cancel an
    // in-flight receipt. The consumer cannot run this packet before publication.
    intent.fetch_max(serial,Ordering::AcqRel);
    armed.store(true,Ordering::Release);Ok(())
}
/// Admit before revoking playback. A failed bounded-queue send must not expose
/// even a transient new epoch to the running connection or project workers.
fn admit_delete_request<T>(requests:&impl RequestQueue<T>,latest:&AtomicU64,advance:bool,make:impl FnOnce(u64,Arc<AtomicU8>)->T)->Result<u64> {
    let previous=latest.load(Ordering::Acquire);
    let epoch=if advance{previous.checked_add(1).context("Native project epoch exhausted")?}else{previous};
    let armed=Arc::new(AtomicU8::new(0));
    requests.try_request(make(epoch,armed.clone())).map_err(|_|anyhow::anyhow!("Native command queue is full"))?;
    if advance&&latest.compare_exchange(previous,epoch,Ordering::AcqRel,Ordering::Acquire).is_err(){
        armed.store(2,Ordering::Release);bail!("Project changed before deletion could start");
    }
    armed.store(1,Ordering::Release);Ok(epoch)
}
fn prepare_lane_candidate(candidate:&mut Project,previous:&[crate::tracks::Lane],stamps:&[(u64,std::time::SystemTime)],cancel:&impl Fn()->bool)->Result<()> {
    anyhow::ensure!(previous.len()==stamps.len(),"Loaded track source identities are unavailable; reopen this project");
    anyhow::ensure!(candidate.lane_specs.len()<=crate::tracks::MAX_ACTIVE_LANES,"The native player supports at most sixteen active tracks");
    candidate.empty_tracks=candidate.lane_specs.is_empty();
    if candidate.empty_tracks{candidate.carry.enabled=false;candidate.original=false;candidate.looping=false;candidate.selection=None;candidate.view=None;candidate.vocal_stamp=None;candidate.vocal_duration=None;}
    let mut slots=std::collections::HashSet::new();let mut ids=std::collections::HashSet::new();let mut captured=vec![];
    for lane in &mut candidate.lane_specs {
        anyhow::ensure!(!cancel(),"Track replacement cancelled");
        anyhow::ensure!(lane.slot<crate::tracks::LANE_SLOTS&&slots.insert(lane.slot)&&ids.insert(lane.id.clone()),"Duplicate track ID or control slot");
        if lane.custom{crate::tracks::validate_custom_id(&lane.id)?;anyhow::ensure!(lane.slot>=crate::tracks::BUILTIN_SLOTS,"Custom track overlaps a built-in role");}
        else{anyhow::ensure!(previous.iter().any(|old|!old.custom&&old.id==lane.id&&old.slot==lane.slot),"Track edit cannot introduce a built-in role");}
        lane.file=lane.file.canonicalize().context("Custom track source is unavailable")?;
        anyhow::ensure!(lane.file.is_file(),"Track source is not a file");
        let current=crate::project_analysis::stamp(&lane.file)?;
        if let Some((index,old))=previous.iter().enumerate().find(|(_,old)|old.id==lane.id){
            anyhow::ensure!(old.slot==lane.slot&&old.file==lane.file&&current==stamps[index],"Loaded track audio changed outside this app; reopen before editing tracks");
        }
        captured.push(current);
    }
    for old in previous.iter().filter(|lane|!lane.custom){anyhow::ensure!(candidate.lane_specs.iter().any(|lane|lane.id==old.id),"Built-in tracks cannot be removed");}
    candidate.lanes=candidate.lane_specs.iter().map(|lane|(lane.slot,lane.file.clone())).collect();candidate.lane_stamps=captured;
    native_lane_sources(candidate)?;Ok(())
}
fn prevalidate_new_tracks(candidate:&mut Project,previous:&[crate::tracks::Lane],paths:&[PathBuf],cancel:&impl Fn()->bool)->Result<()> {
    prevalidate_new_tracks_using(candidate,previous,paths,cancel,|path,cancel|measure_new_track(path,cancel,&crate::audio_devices::helper()))
}
fn prevalidate_new_tracks_using(candidate:&mut Project,previous:&[crate::tracks::Lane],paths:&[PathBuf],cancel:&impl Fn()->bool,mut measure:impl FnMut(&Path,&dyn Fn()->bool)->Result<PathBuf>)->Result<()> {
    let requested=std::mem::take(&mut candidate.lane_specs);
    let mut additions:Vec<_>=requested.iter().filter(|lane|!previous.iter().any(|old|old.id==lane.id)).map(|lane|lane.file.clone()).collect();additions.extend_from_slice(paths);
    anyhow::ensure!(additions.len()<=256,"Choose at most 256 audio files per Add operation");
    candidate.lane_specs=requested.into_iter().filter(|lane|previous.iter().any(|old|old.id==lane.id)).collect();
    let mut failures=vec![];
    for path in additions {
        anyhow::ensure!(!cancel(),"Track replacement cancelled");
        if candidate.lane_specs.len()>=crate::tracks::MAX_ACTIVE_LANES{failures.push(format!("Could not add {}: sixteen active tracks are already loaded.",path.display()));continue;}
        let accepted=(||->Result<crate::tracks::Lane>{let file=measure(&path,cancel)?;anyhow::ensure!(!cancel(),"Track replacement cancelled");let mut lane=crate::tracks::new_custom(path.clone(),&candidate.lane_specs)?;lane.file=file;Ok(lane)})();
        match accepted {
            Ok(lane)=>{candidate.gain[lane.slot]=1.;candidate.muted[lane.slot]=false;candidate.solo[lane.slot]=false;candidate.lane_specs.push(lane);}
            Err(error)=>{anyhow::ensure!(!cancel(),"Track replacement cancelled");failures.push(format!("Could not add {}: {error:#}",path.display()));}
        }
    }
    anyhow::ensure!(candidate.lane_specs!=previous,"{}",if failures.is_empty(){"No track changes were requested.".into()}else{failures.join("\n")});
    candidate.track_warnings.extend(failures);Ok(())
}
struct MeasureProcess {
    child: Child,
    done: bool,
    #[cfg(unix)]
    pid_reserved: bool,
}
#[cfg(unix)]
fn kill_measure_group(pid: u32) -> bool {
    // process_group(0) gives this invocation its own group. The unreaped
    // direct child reserves this numeric PID until all group signals finish.
    unsafe { libc::kill(-(pid as libc::pid_t), libc::SIGKILL) == 0 }
}
impl MeasureProcess {
    fn exit_status(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(None);
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    // An external reaper would revoke our PID ownership. Never
                    // fall back to signaling an ID that the OS may reuse.
                    self.pid_reserved = false;
                }
                return Err(error);
            }
            if unsafe { info.si_pid() } == 0 {
                return Ok(None);
            }
            let status = unsafe { info.si_status() };
            let raw = match info.si_code {
                libc::CLD_EXITED => status << 8,
                libc::CLD_KILLED => status,
                libc::CLD_DUMPED => status | 0x80,
                _ => return Ok(None),
            };
            return Ok(Some(std::process::ExitStatus::from_raw(raw)));
        }
        #[cfg(not(unix))]
        self.child.try_wait()
    }
}
impl Drop for MeasureProcess {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            if !self.pid_reserved {
                return;
            }
            // WNOWAIT above leaves the group leader unreaped, including on
            // success. No unrelated process can acquire its PID while a late
            // descendant is being retired. Reaping is strictly the final step.
            let mut group_live = kill_measure_group(self.child.id());
            if !self.done {
                let _ = self.child.kill();
            }
            let deadline = Instant::now() + Duration::from_millis(100);
            while group_live && Instant::now() < deadline {
                group_live = kill_measure_group(self.child.id());
                if group_live {
                    thread::sleep(Duration::from_millis(5));
                }
            }
            let _ = self.child.wait();
            self.pid_reserved = false;
        }
        #[cfg(not(unix))]
        {
            // Windows Child operations use the owned process handle. Pipe
            // readiness remains bounded independently of descendants.
            if !self.done {
                let _ = self.child.kill();
            }
            let _ = self.child.wait();
        }
    }
}
fn measure_stdout_ready(output: &std::process::ChildStdout) -> std::io::Result<bool> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        #[repr(C)]
        struct PollFd {
            fd: i32,
            events: i16,
            revents: i16,
        }
        #[cfg(target_os = "macos")]
        type Nfds = u32;
        #[cfg(not(target_os = "macos"))]
        type Nfds = usize;
        unsafe extern "C" {
            fn poll(fds: *mut PollFd, nfds: Nfds, timeout: i32) -> i32;
        }
        let mut fd = PollFd {
            fd: output.as_raw_fd(),
            events: 1,
            revents: 0,
        };
        let result = unsafe { poll(&mut fd, 1, 0) };
        if result >= 0 {
            return Ok(result > 0);
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::Interrupted {
            return Ok(false);
        }
        return Err(error);
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn PeekNamedPipe(
                pipe: *mut std::ffi::c_void,
                buffer: *mut std::ffi::c_void,
                size: u32,
                read: *mut u32,
                available: *mut u32,
                left: *mut u32,
            ) -> i32;
        }
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                output.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } != 0
        {
            return Ok(available > 0);
        }
        let error = std::io::Error::last_os_error();
        if error.raw_os_error() == Some(109) {
            return Ok(true);
        }
        return Err(error);
    }
    #[cfg(not(any(unix, windows)))]
    Err(std::io::Error::new(
        std::io::ErrorKind::Unsupported,
        "Native validation pipe polling unavailable",
    ))
}
fn measure_new_track(path: &Path, cancel: &dyn Fn() -> bool, helper: &Path) -> Result<PathBuf> {
    anyhow::ensure!(!cancel(), "Track replacement cancelled");
    let source = path.canonicalize().context("Track file is unavailable")?;
    let before = crate::project_analysis::stamp(&source)?;
    anyhow::ensure!(
        source.is_file() && before.0 > 0 && before.0 <= 2 * 1024 * 1024 * 1024,
        "Track file must be an ordinary nonempty file of at most 2 GiB"
    );
    let mut command = Command::new(helper);
    command
        .arg("--measure-input")
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    let child = command
        .spawn()
        .context("Cannot validate audio; rebuild the native helper")?;
    let mut process = MeasureProcess {
        child,
        done: false,
        #[cfg(unix)]
        pid_reserved: true,
    };
    let mut output = process
        .child
        .stdout
        .take()
        .context("Missing native audio validation output")?;
    // Read only after OS readiness, on this worker. No blocking reader thread
    // can outlive cancellation when a descendant inherits or escapes with stdout.
    let mut bytes = Vec::new();
    let mut buffer = [0u8; 4096];
    let mut eof = false;
    let deadline = Instant::now() + Duration::from_secs(45);
    let mut receipt_deadline = None;
    loop {
        anyhow::ensure!(!cancel(), "Track replacement cancelled");
        anyhow::ensure!(
            Instant::now() < deadline,
            "Native audio validation timed out"
        );
        if !eof && measure_stdout_ready(&output)? {
            match output.read(&mut buffer) {
                Ok(0) => eof = true,
                Ok(count) => {
                    anyhow::ensure!(
                        bytes.len() + count <= 16384,
                        "Native audio validation output exceeded its bound"
                    );
                    bytes.extend_from_slice(&buffer[..count]);
                }
                Err(error) if error.kind() == std::io::ErrorKind::Interrupted => continue,
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => eof = true,
                Err(error) => return Err(error.into()),
            }
        }
        if let Some(status) = process.exit_status()? {
            anyhow::ensure!(
                status.success(),
                "Native decoder could not read this audio file ({status})"
            );
            if eof {
                break;
            }
            let end =
                *receipt_deadline.get_or_insert_with(|| Instant::now() + Duration::from_secs(2));
            anyhow::ensure!(
                Instant::now() < end,
                "Missing native audio validation receipt"
            );
        }
        thread::sleep(Duration::from_millis(5));
    }
    let value: Value =
        serde_json::from_slice(&bytes).context("Invalid native audio validation receipt")?;
    let rate = value["sampleRate"]
        .as_u64()
        .filter(|rate| *rate > 0 && *rate <= 768000)
        .context("Invalid native audio sample rate")?;
    let frames = value["frames"]
        .as_u64()
        .filter(|frames| *frames > 0)
        .context("Native audio contains no samples")?;
    anyhow::ensure!(
        value["protocol"] == 1
            && value["ok"] == true
            && value["channels"]
                .as_u64()
                .is_some_and(|n| (1..=64).contains(&n))
            && frames <= rate * 3600
            && value["rms"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n >= 0.),
        "Invalid or overlong native audio validation"
    );
    anyhow::ensure!(
        !cancel() && crate::project_analysis::stamp(&source)? == before,
        "Track source changed during validation"
    );
    process.done = true;
    Ok(source)
}
fn hex_utf8(text:&str)->String{use std::fmt::Write;let mut hex=String::with_capacity(text.len()*2);for byte in text.bytes(){let _=write!(&mut hex,"{byte:02x}");}hex}
fn lane_transaction(candidate:&Project)->Result<Vec<String>> {
    let sources=native_lane_sources(candidate)?;let mut commands=vec![format!("lanes-begin {}",sources.len())];
    for(id,path)in sources{let path=path.to_str().context("Track path must be UTF-8")?;
        anyhow::ensure!(path.len()<=1800&&!path.chars().any(char::is_control)&&!id.chars().any(char::is_control),"Track source exceeds native command limits");
        commands.push(format!("lanes-add {} {}",hex_utf8(&id),hex_utf8(path)));
    }Ok(commands)
}
fn peaks_from(value:&Value)->Vec<Vec<f32>>{value["peaks"].as_array().map(|rows|rows.iter().map(|row|row.as_array().map(|values|values.iter().map(|n|n.as_f64().unwrap_or(0.) as f32).collect()).unwrap_or_default()).collect()).unwrap_or_default()}
enum LaneReplaceFailure {Refused(String),Disconnected(String),Committed(String)}
fn lane_stage_reply(value:Value)->std::result::Result<(),LaneReplaceFailure> {
    if value["protocol"]==1&&value["ok"]==false&&!matches!(value["state"].as_u64(),Some(6|7)) {
        return Err(LaneReplaceFailure::Refused(value["error"].as_str().filter(|s|!s.is_empty()).unwrap_or("Native track staging was refused").into()));
    }
    Status::parse(&value).map(|_|()).map_err(|error|LaneReplaceFailure::Disconnected(format!("Native playback could not be confirmed before track replacement: {error:#}")))
}
fn accepted_analysis_snapshot(requested:&Project,lanes:&[crate::tracks::Lane],stamps:&[(u64,std::time::SystemTime)])->Option<Project> {
    if lanes.len()!=stamps.len(){return None;}
    let mut accepted=requested.clone();accepted.lane_specs=lanes.to_vec();accepted.lanes=lanes.iter().map(|lane|(lane.slot,lane.file.clone())).collect();accepted.lane_stamps=stamps.to_vec();
    accepted.vocal_stamp=lanes.iter().position(|lane|lane.slot==0).map(|index|stamps[index]);accepted.original=lanes.iter().any(|lane|lane.id=="original");accepted.empty_tracks=lanes.is_empty();Some(accepted)
}
fn spawn_analysis_with<F>(snapshot:Project,epoch:u64,events:mpsc::Sender<Event>,latest:Arc<AtomicU64>,alive:Arc<AtomicBool>,run:F)->(thread::JoinHandle<()>,Arc<AtomicBool>)
where F:FnOnce(&Project,u64,&Arc<AtomicU64>,&Arc<AtomicBool>,u64)->Result<crate::project_analysis::Output>+Send+'static {
    static SERIAL:AtomicU64=AtomicU64::new(1);
    let job_id=SERIAL.fetch_update(Ordering::AcqRel,Ordering::Acquire,|value|value.checked_add(1)).expect("Native analysis job identifiers exhausted");
    let job_alive=Arc::new(AtomicBool::new(true));let running=job_alive.clone();
    // Publish identity before spawning: even immediate stderr/progress and
    // an immediately completed analysis cannot overtake their own start.
    let _=events.send(Event::AnalysisStarted(epoch,job_id));
    let job=thread::spawn(move||{let result=run(&snapshot,epoch,&latest,&running,job_id).map_err(|e|format!("{e:#}"));if alive.load(Ordering::Acquire)&&running.load(Ordering::Acquire)&&latest.load(Ordering::Acquire)==epoch{let _=events.send(Event::Analyzed(epoch,job_id,result));}});(job,job_alive)
}
fn restart_analysis_using<F>(snapshot:Option<Project>,epoch:u64,events:&mpsc::Sender<Event>,latest:&Arc<AtomicU64>,alive:&Arc<AtomicBool>,job:&mut Option<thread::JoinHandle<()>>,cancel:&mut Option<Arc<AtomicBool>>,run:F)->bool
where F:FnOnce(&Project,u64,&Arc<AtomicU64>,&Arc<AtomicBool>,u64)->Result<crate::project_analysis::Output>+Send+'static {
    let Some(snapshot)=snapshot.filter(crate::project_analysis::needed)else{return false;};
    if !alive.load(Ordering::Acquire)||latest.load(Ordering::Acquire)!=epoch{return false;}
    let (worker,token)=spawn_analysis_with(snapshot,epoch,events.clone(),latest.clone(),alive.clone(),run);*job=Some(worker);*cancel=Some(token);true
}
fn restart_analysis(snapshot:Option<Project>,epoch:u64,events:&mpsc::Sender<Event>,latest:&Arc<AtomicU64>,alive:&Arc<AtomicBool>,job:&mut Option<thread::JoinHandle<()>>,cancel:&mut Option<Arc<AtomicBool>>) {
    let progress_events=events.clone();let progress_latest=latest.clone();let progress_alive=alive.clone();
    restart_analysis_using(snapshot,epoch,events,latest,alive,job,cancel,move|project,epoch,latest,running,job_id|{
        let progress_running=running.clone();
        crate::project_analysis::run_with_progress(project,epoch,latest,running,Arc::new(move|progress|{
            if progress.is_finite()&&progress_alive.load(Ordering::Acquire)&&progress_running.load(Ordering::Acquire)&&progress_latest.load(Ordering::Acquire)==epoch{let _=progress_events.send(Event::AnalysisProgress(epoch,job_id,progress.clamp(0.,1.)));}
        }))
    });
}
fn vocal_lane_duration(value:&Value)->Result<Option<f64>> {
    let Some(durations)=value.get("laneDurations")else{return Ok(None);};
    let durations=durations.as_array().context("Invalid native lane durations")?;let ids=value["laneIds"].as_array().context("Missing native lane IDs")?;
    anyhow::ensure!(durations.len()==ids.len()&&durations.len()<=crate::tracks::MAX_ACTIVE_LANES,"Invalid native lane duration count");
    for duration in durations{anyhow::ensure!(duration.as_f64().is_some_and(|n|n.is_finite()&&n>0.&&n<=86400.*365.),"Invalid native lane source duration");}
    Ok(ids.iter().position(|id|id.as_str()==Some("vocals")).map(|index|durations[index].as_f64().unwrap()))
}
fn replacement_reply(value:Value,expected_ids:&[String])->std::result::Result<(Status,Vec<Vec<f32>>,Option<f64>),LaneReplaceFailure> {
    if value["lanesCommitted"]==true {
        let result=(||->Result<_>{
            let ids=value["laneIds"].as_array().context("Missing committed native lane IDs")?;
            anyhow::ensure!(ids.len()==expected_ids.len()&&ids.iter().zip(expected_ids).all(|(actual,expected)|actual.as_str()==Some(expected.as_str())),"Committed native lanes differ from the requested tracks");
            Ok((Status::parse(&value)?,peaks_from(&value),vocal_lane_duration(&value)?))
        })();
        return result.map_err(|error|LaneReplaceFailure::Committed(format!("Playback lanes were committed, but playback failed: {error:#}. Save and reopen this project.")));
    }
    Err(LaneReplaceFailure::Refused(value["error"].as_str().filter(|message|!message.is_empty()).unwrap_or("Native track replacement was refused before commit").into()))
}
fn open_carry_plan(project:&mut Project,duration:f64)->Result<Option<crate::carry_line::Plan>> {
    if !project.has_audio(){
        anyhow::ensure!(project.empty_tracks&&project.lanes.is_empty()&&project.lane_specs.is_empty(),"Project has no valid audio graph or explicit empty intent");
        project.carry.enabled=false;return Ok(None);
    }
    crate::carry_line::Plan::capture(project.carry.clone(),&project.lane_specs,project.lyrics.as_ref().map(|doc|doc.lines.as_slice()),duration,!project.original).map(Some)
}
fn configure_fresh_graph(was_empty:bool,candidate:&Project,mut apply:impl FnMut(&[String])->Result<Status>)->std::result::Result<Option<Status>,LaneReplaceFailure> {
    if !was_empty||!candidate.has_audio(){return Ok(None);}
    let commands=crate::beat::commands(&candidate.metronome,candidate.beat.as_ref())
        .map_err(|e|LaneReplaceFailure::Committed(format!("Audio tracks were committed, but their metronome settings are invalid: {e:#}. Save and reopen this project.")))?;
    apply(&commands).map(Some).map_err(|e|LaneReplaceFailure::Committed(format!("Audio tracks were committed, but their metronome settings could not be applied: {e:#}. Playback was stopped. Save and reopen this project.")))
}
fn stop_analysis_for_epoch(job:&mut Option<thread::JoinHandle<()>>,cancel:&mut Option<Arc<AtomicBool>>,events:&mpsc::Sender<Event>,epoch:u64){
    stop_analysis(job,cancel);
    // Join is the delivery fence: no old progress/result may follow this stop.
    let _=events.send(Event::AnalysisStopped(epoch));
}
fn stop_analysis(job:&mut Option<thread::JoinHandle<()>>,cancel:&mut Option<Arc<AtomicBool>>) {
    if let Some(cancel)=cancel.take(){cancel.store(false,Ordering::Release);}if let Some(job)=job.take(){let _=job.join();}
}
struct PendingInventory {
    source_epoch: u64,
    output_uid: String,
    reply: Value,
}
struct Connection {
    provider:crate::audio_devices::Provider,
    provider_retired:Arc<AtomicU64>,
    pending_inventory: Option<PendingInventory>,
    carry_revision:u64,
    lane_revision:u64,
    loaded_lanes:Vec<crate::tracks::Lane>,
    loaded_stamps:Vec<(u64,std::time::SystemTime)>,
    project_dir: Option<PathBuf>,
    child: Child,
    input: ChildStdin,
    replies: Receiver<Result<Value>>,
    epoch: u64,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    copy_handoff: Arc<AtomicU64>,
}
impl Drop for Connection {
    fn drop(&mut self) {
        let _ = self.child.kill();
        if self.child.wait().is_ok(){self.provider_retired.fetch_sub(1,Ordering::AcqRel);}
    }
}
impl Connection {
    fn open(
        project: Option<&Project>,
        epoch: u64,
        latest: Arc<AtomicU64>,
        alive: Arc<AtomicBool>,
        copy_handoff: Arc<AtomicU64>,
        output_uid: &str,
        provider:crate::audio_devices::Provider,
        provider_retired:Arc<AtomicU64>,
        graph_manifest:Option<jobs::Manifest>,
    ) -> Result<(Self, Value)> {
        crate::audio_devices::validate_output_uid(provider,output_uid,cfg!(windows))?;
        let helper = gated_env!("SINGZ_GPUI_AUDIO_HELPER")
            .map(PathBuf::from)
            .unwrap_or_else(|| {
                std::env::current_exe()
                    .unwrap_or_default()
                    .with_file_name(if cfg!(windows) {
                        "singz-gpui-audio.exe"
                    } else {
                        "singz-gpui-audio"
                    })
            });
        let mut command = Command::new(helper);
        anyhow::ensure!(project.is_some_and(|p|p.graph.is_some())==graph_manifest.is_some(),"Native graph admission differs from the saved project request");
        if project.is_some_and(|p|p.empty_tracks){command.arg("--empty-project");}
        if project.is_none() {
            command.arg("--training-only");
        }
        if cfg!(windows){command.arg("--provider").arg(provider.as_str());}
        command.arg("--output").arg(output_uid);
        if let Some(project) = project {
            command
                .arg("--tempo")
                .arg(project.tempo.to_string())
                .arg("--transpose")
                .arg(project.transpose.to_string());
        }
        if let Some(manifest)=&graph_manifest {command.arg("--graph-manifest").arg(manifest.path());}
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        for (id,path) in project.map(native_lane_sources).transpose()?.unwrap_or_default() {
            command.arg(id).arg(path);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()
            .context("Native audio helper is missing; build with scripts/build-gpui-audio.sh")?;
        provider_retired.fetch_add(1,Ordering::AcqRel);
        let pipes=child.stdin.take().zip(child.stdout.take());
        let (input,output)=match pipes {Some(pipes)=>pipes,None=>{
            let _=child.kill();if child.wait().is_ok(){provider_retired.fetch_sub(1,Ordering::AcqRel);}
            bail!("Missing native helper pipes");
        }};
        let (tx, rx) = mpsc::sync_channel(4);
        thread::spawn(move || {
            let mut reader = BufReader::new(output);
            loop {
                let mut line = Vec::new();
                let result = reader
                    .by_ref()
                    .take(1024 * 1024)
                    .read_until(b'\n', &mut line);
                let value = match result {
                    Ok(0) => Err(anyhow::anyhow!("Native audio process exited")),
                    Ok(_) if line.last() != Some(&b'\n') => {
                        Err(anyhow::anyhow!("Oversized native reply"))
                    }
                    Ok(_) => serde_json::from_slice(&line).map_err(Into::into),
                    Err(e) => Err(e.into()),
                };
                let failed = value.is_err();
                if tx.send(value).is_err() || failed {
                    break;
                }
            }
        });
        let mut connection = Self {
            provider,provider_retired,
            pending_inventory:None,
            carry_revision:0,
            lane_revision:0,
            loaded_lanes: project.map(|p|p.lanes.iter().filter_map(|(slot,_)|p.lane_specs.iter().find(|lane|lane.slot==*slot).cloned()).collect()).unwrap_or_default(),
            loaded_stamps:project.map(|p|p.lane_stamps.clone()).unwrap_or_default(),
            project_dir: project.map(|p|p.dir.clone()),
            child,
            input,
            replies: rx,
            epoch,
            latest,
            alive,
            copy_handoff,
        };
        let value = connection.read(Duration::from_secs(120))?;
        let status = Status::parse(&value)?;
        anyhow::ensure!(status.explicit_graph==project.is_some_and(|p|p.graph.is_some())
            && (!status.explicit_graph||(status.graph_nodes>0&&status.graph_nodes<=128&&status.graph_connections<=256)),
            "Native graph admission differs from the saved project request");
        anyhow::ensure!(
            status.training_only == project.is_none()&&status.empty_project==project.is_some_and(|p|p.empty_tracks),
            "Native audio session role differs from its request"
        );
        anyhow::ensure!(
            output_uid.is_empty() || status.output_uid == output_uid,
            "Native output differs from the selected device"
        );
        connection.lane_revision=status.lane_revision;connection.carry_revision=status.carry_revision;
        Ok((connection, value))
    }
    fn read(&mut self, timeout: Duration) -> Result<Value> {
        let provider=self.provider;
        let value=read_provider_inventory_reply(&self.replies,self.epoch,&self.latest,&self.alive,&self.copy_handoff,timeout,&mut self.pending_inventory,provider,|reply,kind,current|crate::audio_devices::remember_native_inventory(reply,kind,current))?;
        crate::audio_devices::verify_provider_receipt(&value,self.provider)?;Ok(value)
    }
    fn metronome(&mut self, commands: &[String]) -> Result<Status> {
        let mut status = None;
        for command in commands {
            status = Some(self.command(command)?);
        }
        status.context("Empty metronome transaction")
    }
    fn command(&mut self, command: &str) -> Result<Status> {
        writeln!(self.input, "{command}")?;
        self.input.flush()?;
        #[cfg(feature="ui-tests")]
        if command=="status" {self.old_status_test_gate()?;}
        let value=self.read(Duration::from_secs(if command.starts_with("output "){120}else{10}))?;
        let status=Status::parse(&value)?;
        admit_lane_revision(&mut self.lane_revision,&status)?;admit_carry_revision(&mut self.carry_revision,&status)?;Ok(status)
    }
    fn output_route(&mut self,uid:&str)->std::result::Result<Status,LaneReplaceFailure> {
        crate::audio_devices::validate_output_uid(self.provider,uid,cfg!(windows)).map_err(|e|LaneReplaceFailure::Refused(e.to_string()))?;
        let before=self.raw_command_for("status",Duration::from_secs(10))
            .map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        Status::parse(&before).map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        let reply=self.raw_command_for(&format!("output {}",crate::audio_devices::encode_uid(uid)),Duration::from_secs(120))
            .map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        if reply["ok"]==false {
            let after=self.raw_command_for("status",Duration::from_secs(10))
                .map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
            retained_output(&before,&reply,&after).map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
            return Err(LaneReplaceFailure::Refused(reply["error"].as_str().unwrap_or("Native output route was refused").into()));
        }
        let status=accepted_output(&before,&reply,uid).map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        admit_lane_revision(&mut self.lane_revision,&status).map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        admit_carry_revision(&mut self.carry_revision,&status).map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;
        Ok(status)
    }
    fn replace_lanes(&mut self,candidate:&Project)->std::result::Result<(Status,Vec<Vec<f32>>,Option<f64>),LaneReplaceFailure> {
        let commands=lane_transaction(candidate).map_err(|e|LaneReplaceFailure::Refused(e.to_string()))?;
        for command in commands {
            let packet=(||->Result<Value>{writeln!(self.input,"{command}")?;self.input.flush()?;self.read(Duration::from_secs(10))})();
            match packet.map_err(|e|LaneReplaceFailure::Disconnected(format!("Native playback connection failed before applying tracks: {e:#}"))).and_then(lane_stage_reply) {
                Ok(())=>{},
                Err(LaneReplaceFailure::Refused(error))=>{if let Err(sync_error)=self.command("lanes-cancel"){return Err(LaneReplaceFailure::Disconnected(format!("Track staging was refused, but native playback could not be resynchronized: {sync_error:#}")));}return Err(LaneReplaceFailure::Refused(error));},
                Err(other)=>return Err(other),
            }
        }
        if let Err(error)=writeln!(self.input,"lanes-apply").and_then(|_|self.input.flush()){
            return Err(LaneReplaceFailure::Committed(format!("Could not confirm track replacement: {error}. Playback was stopped; requested tracks were retained. Save and reopen.")));
        }
        match self.read(Duration::from_secs(55)) {
            Ok(value)=>{let reply=replacement_reply(value,&candidate.lanes.iter().map(|(slot,_)|candidate.lane_id(*slot).unwrap().to_owned()).collect::<Vec<_>>())?;if reply.0.empty_project!=candidate.empty_tracks{return Err(LaneReplaceFailure::Committed("Native empty intent differs from requested tracks".into()));}admit_lane_revision(&mut self.lane_revision,&reply.0).map_err(|e|LaneReplaceFailure::Committed(e.to_string()))?;admit_carry_revision(&mut self.carry_revision,&reply.0).map_err(|e|LaneReplaceFailure::Committed(e.to_string()))?;Ok(reply)},
            Err(error)=>Err(LaneReplaceFailure::Committed(format!("Could not confirm track replacement: {error:#}. Playback was stopped; requested tracks were retained. Save and reopen."))),
        }
    }
    fn region(&mut self,target:crate::region_gesture::Target,duration:f64)->std::result::Result<Status,RateFailure> {
        let before=self.raw_command_for("status",Duration::from_secs(10)).map_err(|e|RateFailure::Transport(e.to_string()))?;
        let old=Status::parse(&before).map_err(|e|RateFailure::Transport(e.to_string()))?;
        let same_ownership=|after:&Value|->Result<()> {
            for key in ["graphGeneration","laneSetRevision","carryRevision","laneIds","lanes","masterGain","referenceGain","outputUid","trainingOnly","emptyProject","duration","playbackRate","transpose"] {
                anyhow::ensure!(before[key]==after[key],"Native playback {key} changed while applying its region");
            }
            Ok(())
        };
        let reply=self.raw_command_for(&target.command(duration),Duration::from_secs(10)).map_err(|e|RateFailure::Transport(e.to_string()))?;
        if reply["ok"]==false {
            let after=self.raw_command_for("status",Duration::from_secs(10)).map_err(|e|RateFailure::Transport(e.to_string()))?;
            let status=Status::parse(&after).map_err(|e|RateFailure::Transport(e.to_string()))?;
            same_ownership(&after).map_err(|e|RateFailure::Transport(e.to_string()))?;
            if old.region_range!=status.region_range || old.loop_range!=status.loop_range {
                return Err(RateFailure::Transport("Rejected playback region changed the accepted bounds".into()));
            }
            return Err(RateFailure::Refused(reply["error"].as_str().unwrap_or("Playback region was refused").into()));
        }
        let expected=target.selection.or_else(||target.looping.then_some((0.,duration)));
        let close=|a:Option<(f64,f64)>,b:Option<(f64,f64)>| a==b || a.zip(b).is_some_and(|(a,b)|(a.0-b.0).abs()<0.001&&(a.1-b.1).abs()<0.001);
        let deadline=Instant::now()+Duration::from_secs(2);
        let mut current=reply;
        let status=loop {
            let status=Status::parse(&current).map_err(|e|RateFailure::Transport(e.to_string()))?;
            same_ownership(&current).map_err(|e|RateFailure::Transport(e.to_string()))?;
            if close(status.region_range,expected) && close(status.loop_range,if target.looping {expected}else{None}) {break status;}
            if Instant::now()>=deadline {return Err(RateFailure::Transport("Native playback region did not settle at the requested bounds".into()));}
            thread::sleep(Duration::from_millis(2));
            current=self.raw_command_for("status",Duration::from_secs(10)).map_err(|e|RateFailure::Transport(e.to_string()))?;
        };
        admit_lane_revision(&mut self.lane_revision,&status).and_then(|_|admit_carry_revision(&mut self.carry_revision,&status)).map_err(|e|RateFailure::Transport(e.to_string()))?;
        Ok(status)
    }
    fn rate(&mut self,rate:f32,transpose:i32)->std::result::Result<Status,RateFailure>{
        let before=self.raw_command("status").map_err(|e|RateFailure::Transport(e.to_string()))?;
        let old=Status::parse(&before).map_err(|e|RateFailure::Transport(e.to_string()))?;
        admit_lane_revision(&mut self.lane_revision,&old).and_then(|_|admit_carry_revision(&mut self.carry_revision,&old)).map_err(|e|RateFailure::Transport(e.to_string()))?;
        let reply=self.raw_command(&format!("rate {rate} {transpose}")).map_err(|e|RateFailure::Transport(format!("Native tempo update could not be confirmed: {e:#}")))?;
        if reply["protocol"]==1&&reply["ok"]==true{
            let status=accepted_rate(&before,&reply,rate,transpose).map_err(|e|RateFailure::Transport(format!("Native tempo update could not be confirmed: {e:#}")))?;
            admit_lane_revision(&mut self.lane_revision,&status).and_then(|_|admit_carry_revision(&mut self.carry_revision,&status)).map_err(|e|RateFailure::Transport(e.to_string()))?;return Ok(status);
        }
        if reply["protocol"]!=1||reply["ok"]!=false||!reply["state"].as_u64().is_some_and(|n|n<=5)||Status::reported(&reply).is_err(){return Err(RateFailure::Transport("Native output failed while changing tempo or transpose".into()));}
        let after=self.raw_command("status").map_err(|e|RateFailure::Transport(e.to_string()))?;
        retained_rate(&before,&after).map_err(|e|RateFailure::Transport(format!("The rejected tempo update did not retain verified playback: {e:#}")))?;
        Err(RateFailure::Refused(reply["error"].as_str().unwrap_or("Tempo or transpose was refused").to_owned()))
    }
    fn raw_command(&mut self,command:&str)->Result<Value>{self.raw_command_for(command,Duration::from_secs(55))}
    fn raw_command_for(&mut self,command:&str,timeout:Duration)->Result<Value>{writeln!(self.input,"{command}")?;self.input.flush()?;self.read(timeout)}
    fn carry(&mut self,plan:&crate::carry_line::Plan)->std::result::Result<Status,LaneReplaceFailure>{self.carry_with_arming(plan,true)}
    fn carry_with_arming(&mut self,plan:&crate::carry_line::Plan,arm:bool)->std::result::Result<Status,LaneReplaceFailure>{
        let commands=if arm{plan.commands()}else{plan.restore_commands()}.map_err(|e|LaneReplaceFailure::Refused(e.to_string()))?;
        for command in commands.iter().take(commands.len()-1){
            let reply=(||->Result<Value>{writeln!(self.input,"{command}")?;self.input.flush()?;self.read(Duration::from_secs(10))})();
            match reply.map_err(|e|LaneReplaceFailure::Disconnected(format!("Native Carry the line connection failed before apply: {e:#}"))).and_then(lane_stage_reply){
                Ok(())=>{},Err(LaneReplaceFailure::Refused(error))=>{self.command("carry-cancel").map_err(|e|LaneReplaceFailure::Disconnected(e.to_string()))?;return Err(LaneReplaceFailure::Refused(error));},Err(error)=>return Err(error)
            }
        }
        if let Err(error)=writeln!(self.input,"carry-apply").and_then(|_|self.input.flush()){return Err(LaneReplaceFailure::Committed(format!("Could not confirm Carry the line apply: {error}. Reopen the project.")));}
        let value=self.read(Duration::from_secs(55)).map_err(|e|LaneReplaceFailure::Committed(format!("Could not confirm Carry the line apply: {e:#}. Reopen the project.")))?;
        let status=carry_reply(value,plan)?;
        admit_lane_revision(&mut self.lane_revision,&status).map_err(|e|LaneReplaceFailure::Committed(e.to_string()))?;
        admit_carry_revision(&mut self.carry_revision,&status).map_err(|e|LaneReplaceFailure::Committed(e.to_string()))?;Ok(status)
    }
    #[cfg(feature="ui-tests")]
    fn old_status_test_gate(&self)->Result<()>{
        if let Some(path)=std::env::var_os("SINGZ_GPUI_IMPORT_OLD_STATUS_GATE").map(PathBuf::from).filter(|p|p.exists()){
            fs::write(path.with_extension("ready"),self.epoch.to_string())?;
            let deadline=Instant::now()+Duration::from_secs(15);
            while path.exists(){
                anyhow::ensure!(connection_read_allowed(self.epoch,&self.latest,&self.alive,&self.copy_handoff),"Project load superseded");
                anyhow::ensure!(Instant::now()<deadline,"Old status test gate timed out");
                thread::sleep(Duration::from_millis(5));
            }
        }Ok(())
    }
}
fn connection_read_allowed(epoch:u64,latest:&AtomicU64,alive:&AtomicBool,handoff:&AtomicU64)->bool{
    loop {
        if !alive.load(Ordering::Acquire){return false;}
        let current=latest.load(Ordering::Acquire);let armed=handoff.load(Ordering::Acquire);
        // A failed queue submission may roll the epoch back before clearing
        // its marker. Evaluate a coherent pair instead of spuriously retiring
        // the still-current helper during that rollback.
        if latest.load(Ordering::Acquire)!=current{continue;}
        return current==epoch||(epoch.checked_add(1)==Some(current)&&armed==current);
    }
}
fn read_connection_reply(replies:&Receiver<Result<Value>>,epoch:u64,latest:&AtomicU64,alive:&AtomicBool,handoff:&AtomicU64,timeout:Duration)->Result<Value>{
    let deadline=Instant::now()+timeout;
    loop{
        anyhow::ensure!(connection_read_allowed(epoch,latest,alive,handoff),"Project load superseded");
        match replies.recv_timeout(Duration::from_millis(20)){
            Ok(reply)=>{anyhow::ensure!(connection_read_allowed(epoch,latest,alive,handoff),"Project load superseded");return reply;},
            Err(mpsc::RecvTimeoutError::Disconnected)=>bail!("Native audio process disconnected"),Err(_)=>{},
        }
        anyhow::ensure!(Instant::now()<deadline,"Native audio command timed out");
    }
}
fn read_inventory_reply(replies:&Receiver<Result<Value>>,epoch:u64,latest:&AtomicU64,alive:&AtomicBool,handoff:&AtomicU64,timeout:Duration,pending:&mut Option<PendingInventory>,remember:impl FnOnce(&Value,crate::audio_devices::SnapshotKind,&dyn Fn()->bool)->Result<()>)->Result<Value>{
    read_inventory_reply_checked(replies,epoch,latest,alive,handoff,timeout,pending,|_|Ok(()),remember)
}
fn read_provider_inventory_reply(replies:&Receiver<Result<Value>>,epoch:u64,latest:&AtomicU64,alive:&AtomicBool,handoff:&AtomicU64,timeout:Duration,pending:&mut Option<PendingInventory>,provider:crate::audio_devices::Provider,remember:impl FnOnce(&Value,crate::audio_devices::SnapshotKind,&dyn Fn()->bool)->Result<()>)->Result<Value>{
    read_inventory_reply_checked(replies,epoch,latest,alive,handoff,timeout,pending,
        |value|crate::audio_devices::verify_provider_receipt(value,provider),
        |reply,kind,current|{crate::audio_devices::verify_provider_receipt(reply,provider)?;remember(reply,kind,current)})
}
fn read_inventory_reply_checked(replies:&Receiver<Result<Value>>,epoch:u64,latest:&AtomicU64,alive:&AtomicBool,handoff:&AtomicU64,timeout:Duration,pending:&mut Option<PendingInventory>,validate:impl FnOnce(&Value)->Result<()>,remember:impl FnOnce(&Value,crate::audio_devices::SnapshotKind,&dyn Fn()->bool)->Result<()>)->Result<Value>{
    let value=read_connection_reply(replies,epoch,latest,alive,handoff,timeout)?;
    // Reject current provenance before it can stage or promote any older facts.
    validate(&value)?;
    if value.get("deviceInventory").is_some() && value["ok"]==true {
        Status::parse(&value)?;
        crate::audio_devices::Inventory::parse(&value["deviceInventory"])?;
        *pending=Some(PendingInventory{source_epoch:epoch,
            output_uid:value["outputUid"].as_str().unwrap_or("").to_owned(),
            // Keep actual provenance while reducing away graph/project/transport
            // state. A copy handoff carries facts, never fabricated identity.
            reply:serde_json::json!({"deviceInventory":value["deviceInventory"].clone(),"provider":value["provider"].clone(),"backendProvider":value["backendProvider"].clone(),"fixture":value["fixture"].clone()})});
    }
    // Copy may transfer this same helper to its successor epoch. Retain an
    // unadmitted receipt locally, then require fresh valid status for the same
    // output before promoting its facts under the new owner. A new helper has
    // a separate pending slot; no old graph/status authority is transferred.
    if value["ok"]==true && pending.is_some() {
        Status::parse(&value)?;
        let current=||alive.load(Ordering::Acquire)&&latest.load(Ordering::Acquire)==epoch;
        if current() {
            let facts=pending.as_ref().unwrap();
            if value["outputUid"].as_str()==Some(facts.output_uid.as_str()) {
                let kind=if facts.source_epoch==epoch{crate::audio_devices::SnapshotKind::Current}else{crate::audio_devices::SnapshotKind::Retained};
                remember(&facts.reply,kind,&current)?;
            }
            if current(){*pending=None;}
        }
    }
    Ok(value)
}
// Only Root-visible preference adoptions survive shutdown. Unapplied audio
// intent must neither execute hardware commands nor acquire persistent authority.
fn flush_metronome_adoptions(
    requests: &Receiver<Request>,
    first: Option<crate::beat::Metronome>,
    first_karaoke: Option<bool>,
    directory: &Path,
) -> Result<()> {
    let mut accepted = first;let mut carry=None;let mut karaoke=first_karaoke;
    for request in requests.try_iter() {
        match request{Request::AdoptMetronomePreferences(_,met)=>accepted=Some(met),Request::AdoptCarryPreferences(_,config)=>carry=Some(config),Request::KaraokePref(_,enabled)=>karaoke=Some(enabled),_=>{}}
    }
    // Each accepted choice has an independent file. A failed write must not
    // prevent another choice from being retained during shutdown.
    let mut first_error=None;
    let mut attempt=|result:Result<()>| {
        if let Err(error)=result {if first_error.is_none(){first_error=Some(error);}}
    };
    if let Some(enabled)=karaoke{attempt(crate::audio_devices::save_karaoke_at(directory,enabled).map(|_|()));}
    if let Some(config)=carry{attempt(crate::carry_line::retain(directory,&config));}
    if let Some(met) = accepted {
        attempt(crate::metronome_store::retain(directory, &met));
    }
    first_error.map_or(Ok(()),Err)
}

#[path="integration_jobs.rs"]
mod jobs;
#[path="integration_transport.rs"]
mod transport_actor;

// Unwinding an actor revokes admission and wakes its peer. The global C-22
// hook owns the blocking internal-error notice; retain existing event text.
struct ActorExit {wake:Option<SyncSender<Request>>,events:mpsc::Sender<Event>,latest:Arc<AtomicU64>,alive:Arc<AtomicBool>}
impl ActorExit {fn new(events:mpsc::Sender<Event>,latest:Arc<AtomicU64>,alive:Arc<AtomicBool>)->Self{Self{wake:None,events,latest,alive}}fn with_wake(mut self,wake:SyncSender<Request>)->Self{self.wake=Some(wake);self}}
impl Drop for ActorExit {fn drop(&mut self){if thread::panicking(){self.alive.store(false,Ordering::Release);if let Some(wake)=&self.wake{let _=wake.try_send(Request::Wake);}let epoch=self.latest.fetch_add(1,Ordering::AcqRel);let _=self.events.send(Event::TransportFailed(epoch,"Native output is unavailable".into()));}}}
fn adopt_current(epoch:u64,serial:Option<(u64,&AtomicU64)>,latest:&AtomicU64,alive:&AtomicBool)->bool {
    alive.load(Ordering::Acquire)&&latest.load(Ordering::Acquire)==epoch&&serial.is_none_or(|(serial,intent)|intent.load(Ordering::Acquire)==serial)
}
trait RequestQueue<T> {fn try_request(&self,request:T)->std::result::Result<(),()>;}
impl<T> RequestQueue<T> for SyncSender<T> {fn try_request(&self,request:T)->std::result::Result<(),()>{self.try_send(request).map_err(|_|())}}
struct Admission(Arc<AtomicU64>);
impl Drop for Admission {fn drop(&mut self){self.0.fetch_sub(1,Ordering::AcqRel);}}
struct Requests {admitted:Arc<AtomicU64>,transport:SyncSender<Request>,jobs:jobs::Sender,alive:Arc<AtomicBool>}
impl Requests {
    fn try_send(&self,request:Request)->std::result::Result<(),()> {
        if !self.alive.load(Ordering::Acquire){return Err(());}
        if request.is_job(){
            self.jobs.slots.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|(n<128).then_some(n+1)).map_err(|_|())?;
            if self.jobs.send(jobs::Job::Request(request)).is_err(){self.jobs.slots.fetch_sub(1,Ordering::AcqRel);return Err(());}Ok(())
        }else{self.admitted.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|(n<128).then_some(n+1)).map_err(|_|())?;self.transport.try_send(Request::Admitted(Box::new(request),Admission(self.admitted.clone()))).map_err(|_|())}
    }
    #[cfg(test)]
    fn send(&self,request:Request)->std::result::Result<(),()> {self.try_send(request)}
}
impl RequestQueue<Request> for Requests {fn try_request(&self,request:Request)->std::result::Result<(),()>{self.try_send(request)}}
impl Request {
    fn is_preference(&self)->bool{matches!(self,Self::AdoptMetronomePreferences(..)|Self::AdoptCarryPreferences(..)|Self::KaraokePref(..)|Self::InputPrefs(..))}
    fn is_job(&self)->bool{
        #[cfg(test)] if matches!(self,Self::HoldJob(..)){return true;}
        matches!(self,Self::RecoverOutput(..)|Self::Inventory|Self::InspectDelete(..)|Self::KaraokePref(..)|Self::InputPrefs(..)|Self::ReadPublication(..)|Self::Catalog(..)|Self::ResolveLyrics(..)|Self::SearchLyrics(..)|Self::LyricsCapabilities|Self::AlignLyrics(..)|Self::LyricsEnvelope(..)|Self::DetectBeats(..)|Self::SaveLyrics(..)|Self::AdoptCarryPreferences(..))
    }
}

#[cfg(test)]
#[path="integration_custom_tracks_tests.rs"]
mod custom_tracks_tests;

#[cfg(test)]
#[path="integration_deletion_tests.rs"]
mod deletion_tests;

#[cfg(test)]
mod tests {
    use super::*;
    fn lyrics_review_project(root:&Path, bytes:&[u8]) -> Project {
        fs::create_dir_all(root.join("stems")).unwrap();
        fs::write(root.join("stems/vocals.wav"), b"wav").unwrap();
        fs::write(root.join("project.json"), br#"{"version":2,"name":"Review lyrics","settings":{}}"#).unwrap();
        fs::write(root.join("lyrics.json"), bytes).unwrap();
        let mut project = read_project(root).unwrap();
        project.lyrics_fingerprint = crate::lyrics_store::identity(&project.dir).unwrap();
        project.lyrics_raw = serde_json::from_slice(bytes).ok();
        project
    }
    fn isolated_publication_test(name:&str, body:impl FnOnce()) {
        if std::env::var("SINGZ_C10_PUBLICATION_TEST").as_deref()==Ok(name) {body();return;}
        let root=fixture(&format!("publication-config-{name}"));
        let output=fs::File::create(root.join("child.log")).unwrap();
        let mut child=Command::new(std::env::current_exe().unwrap())
            .args(["--exact",&format!("integration::tests::{name}"),"--nocapture"])
            .env("SINGZ_C10_PUBLICATION_TEST",name).env("SINGZ_GPUI_CONFIG_DIR",&root).env("SINGZ_MUTE","1")
            .stdout(output.try_clone().unwrap()).stderr(output).spawn().unwrap();
        let deadline=Instant::now()+Duration::from_secs(30);
        loop {
            if let Some(status)=child.try_wait().unwrap() {
                let log=fs::read_to_string(root.join("child.log")).unwrap();
                fs::remove_dir_all(root).unwrap();
                assert!(status.success(),"{log}");return;
            }
            if Instant::now()>=deadline {let _=child.kill();let _=child.wait();panic!("publication test exceeded 30 seconds");}
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn replacement_proposal(source:&str)->crate::lyrics_resolution::Proposal {
        crate::lyrics_resolution::Proposal {
            raw:serde_json::json!({"source":source,"lines":[{"start":1,"end":2,"text":"Replacement lyrics"}]}),
            write:true,cached:false,check:None,warnings:vec![],
        }
    }
    fn assert_lookup_publication_backup(source:&str) {
        let cx=gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(102),None);
        for (case,bytes) in [("broken",b"{broken".as_slice()),("edited",br#"{"source":"edited","lines":[{"start":1,"end":2,"text":"My original words"}]}"#)] {
            let root=fixture(&format!("lyrics-backup-{source}-{case}"));
            let project=lyrics_review_project(&root,bytes);
            let result=publish_resolved_lyrics(&project,replacement_proposal(source),cx.text_system(),&||false).unwrap();
            assert!(result.written);
            assert_eq!(result.raw["source"],source);
            assert_eq!(fs::read(root.join("lyrics.json.bak")).unwrap(),bytes);
            assert_ne!(fs::read(root.join("lyrics.json")).unwrap(),bytes);
            fs::remove_dir_all(root).unwrap();
        }
    }
    #[test]
    fn transcribe_publication_backs_up_unreadable_and_edited_lyrics() {
        isolated_publication_test("transcribe_publication_backs_up_unreadable_and_edited_lyrics",||{
        assert_lookup_publication_backup("whisper");
        });
    }
    #[test]
    fn candidate_publication_backs_up_unreadable_and_edited_lyrics() {
        isolated_publication_test("candidate_publication_backs_up_unreadable_and_edited_lyrics",||{
        assert_lookup_publication_backup("lrclib");
        });
    }
    #[cfg(unix)]
    #[test]
    fn lookup_publication_backup_failure_blocks_both_replacements() {
        isolated_publication_test("lookup_publication_backup_failure_blocks_both_replacements",||{
        let cx=gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(103),None);
        for source in ["whisper","lrclib"] {
            let root=fixture(&format!("lyrics-backup-refusal-{source}"));
            let project=lyrics_review_project(&root,b"{broken");
            // Unusable backup names are skipped for the next one, so force the backup
            // step itself to fail (this test runs in its own isolated process).
            use std::sync::atomic::Ordering::SeqCst;
            crate::lyrics_store::FAIL_BACKUP_FOR_TESTS.store(true,SeqCst);
            let result=publish_resolved_lyrics(&project,replacement_proposal(source),cx.text_system(),&||false);
            crate::lyrics_store::FAIL_BACKUP_FOR_TESTS.store(false,SeqCst);
            let error=format!("{:#}",result.expect_err("a failed backup must block publication"));
            assert!(error.contains(&crate::i18n::t("lyrics.editor.backupFailed")),"{source}: not the backup failure: {error}");
            assert_eq!(fs::read(root.join("lyrics.json")).unwrap(),b"{broken");
            assert!(!root.join("lyrics.json.bak").exists());
            fs::remove_dir_all(root).unwrap();
        }
        });
    }
    #[test]
    fn lyrics_review_real_run_and_publication_preserve_healthy_and_unreadable_files() {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(100), None);
        let root = fixture("lyrics-review-real-run");
        let raw = serde_json::json!({"source":"edited","lines":[{"start":1,"end":2,"text":"  Keep my words  "}],"foreign":true});
        let bytes = serde_json::to_vec_pretty(&raw).unwrap();
        let project = lyrics_review_project(&root, &bytes);
        let result = crate::lyrics_resolution::run(&project, crate::lyrics_resolution::Intent::Auto,
            &crate::lrclib::Client::with_base_url("http://127.0.0.1:9").unwrap(), &||false, &|_|{})
            .and_then(|proposal| publish_resolved_lyrics(&project, proposal, cx.text_system(), &||false)).unwrap();
        assert!(!result.written && result.cached);
        assert_eq!(result.raw, raw);
        assert_eq!(result.warnings, vec![crate::i18n::t("lyrics.panel.autoPreservedEdited")]);
        assert_eq!(fs::read(root.join("lyrics.json")).unwrap(), bytes);
        for bytes in [b"{broken".as_slice(), b"[]", b"{\"lines\":[]}"] {
            let project = lyrics_review_project(&root, bytes);
            let result = crate::lyrics_resolution::run(&project, crate::lyrics_resolution::Intent::Auto,
                &crate::lrclib::Client::with_base_url("http://127.0.0.1:9").unwrap(), &||false, &|_|{})
                .and_then(|proposal| publish_resolved_lyrics(&project, proposal, cx.text_system(), &||false));
            assert_eq!(result.unwrap_err().to_string(),crate::i18n::t("lyrics.panel.autoPreservedUnreadable"));
            assert_eq!(fs::read(root.join("lyrics.json")).unwrap(), bytes);
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn lyrics_review_editor_seed_survives_error_sidebar_and_auto_stays_ready() {
        // Isolate constructor preferences/demo mode without mutating the test
        // process environment or starting real backend services.
        if std::env::var_os("SINGZ_C10_REVIEW_CHILD").is_none() {
            let root = fixture("lyrics-review-ui-config");
            let output = fs::File::create(root.join("child.log")).unwrap();
            let mut child = Command::new(std::env::current_exe().unwrap())
                .args(["--exact", "integration::tests::lyrics_review_editor_seed_survives_error_sidebar_and_auto_stays_ready", "--nocapture"])
                .env("SINGZ_C10_REVIEW_CHILD", "1").env("SINGZ_GPUI_DEMO", "1")
                .env("SINGZ_GPUI_CONFIG_DIR", &root).env("SINGZ_MUTE", "1")
                .stdout(output.try_clone().unwrap()).stderr(output).spawn().unwrap();
            let deadline = Instant::now()+Duration::from_secs(30);
            loop {
                if let Some(status)=child.try_wait().unwrap() {
                    let log=fs::read_to_string(root.join("child.log")).unwrap();
                    fs::remove_dir_all(&root).unwrap();
                    assert!(status.success(), "{log}");break;
                }
                if Instant::now()>=deadline {let _=child.kill();let _=child.wait();panic!("lyrics UI child exceeded 30 seconds");}
                thread::sleep(Duration::from_millis(10));
            }
            return;
        }
        let mut cx=gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(101),None);
        cx.update(gpui_kit::init);
        let root=fixture("lyrics-review-ui-project");
        let raw=serde_json::json!({"source":"edited","credit":"Singer","lines":[
            {"start":1,"end":2,"text":"  Keep my words  "},{"start":-1,"text":"skipped"}]});
        let project=lyrics_review_project(&root,&serde_json::to_vec(&raw).unwrap());
        let window=cx.add_window(crate::Player::new);
        window.update(&mut cx,|player,_,cx|{
            player.loading=false;
            player.lyric_document=Arc::new(crate::project_lyrics::from_value(&raw).unwrap().unwrap());
            player.project=Some(project.clone());
            player.lyrics_sidebar.update(cx,|s,cx|s.failure("fixture failure".into(),cx));
            player.open_lyrics_editor_intent(cx);
            assert_eq!(player.lyrics_editor.read(cx).rows()[0].text,"  Keep my words  ");
            assert_eq!(player.lyrics_editor_credit.as_deref(),Some("Singer"));
            assert_eq!(player.lyrics_editor.read(cx).notice.as_deref(),Some(crate::i18n::tv("lyrics.editor.skippedRows",&[("n","1".into())]).as_str()));
            let proposal=crate::lyrics_resolution::run(&project,crate::lyrics_resolution::Intent::Auto,
                &crate::lrclib::Client::with_base_url("http://127.0.0.1:9").unwrap(),&||false,&|_|{}).unwrap();
            let result=publish_resolved_lyrics(&project,proposal,cx.text_system(),&||false).unwrap();
            player.sidebar_resolved(Ok(result),cx);
            assert!(player.lyrics_sidebar.read(cx).is_ready());
            assert_eq!(player.notice.as_deref(),Some(crate::i18n::t("lyrics.panel.autoPreservedEdited").as_str()));
            player.open_lyrics_editor_intent(cx);
            assert_eq!(player.lyrics_editor.read(cx).rows()[0].text,"  Keep my words  ");
        }).unwrap();
        fs::remove_dir_all(root).unwrap();
    }
    fn captured_lane_reply()->Value {
        serde_json::from_str(include_str!("../../../tests/shared/gpui-first-lane-default-reply.json")).unwrap()
    }
    #[test]
    fn invalid_visualization_metadata_does_not_revoke_valid_audio_status() {
        let mut packet=captured_lane_reply();
        packet.as_object_mut().unwrap().remove("graphSnapshot");
        let absent=Status::parse(&packet).unwrap();
        assert!(absent.graph_snapshot.is_none() && absent.graph_error.is_none());
        packet["graphSnapshot"]=serde_json::json!({"generation":"999","nodes":[]});
        let malformed=Status::parse(&packet).unwrap();
        assert!(malformed.graph_snapshot.is_none() && malformed.graph_error.is_some());
        assert_eq!(malformed.duration,absent.duration);
        assert_eq!(malformed.playing,absent.playing);
        assert_eq!(malformed.graph_generation,absent.graph_generation);
    }
    #[test]
    fn unknown_graph_transport_is_unavailable_without_breaking_playback() {
        let mut packet=captured_lane_reply();
        packet["playing"]=serde_json::json!(true);
        packet.as_object_mut().unwrap().remove("transportState");
        assert_eq!(Status::parse(&packet).unwrap().transport_state,2);
        for (key,value) in [("state",serde_json::json!(9)),("transportState",serde_json::json!(5)),
            ("transportState",serde_json::json!("unknown"))] {
            let mut bad=packet.clone();bad[key]=value;
            let parsed=Status::parse(&bad).unwrap();
            assert!(parsed.graph_snapshot.is_none() && parsed.graph_error.is_some());
            assert!(parsed.playing);
            if key=="state" { assert_eq!(parsed.state,9); }
        }
    }
    #[test]
    fn native_output_meter_admits_real_overload_and_rejects_malformed_telemetry() {
        let mut packet=captured_lane_reply();
        packet["outputPeak"]=serde_json::json!(3.25);
        packet["outputClippedBlocks"]=serde_json::json!(17);
        let status=Status::parse(&packet).unwrap();
        assert_eq!(status.output_peak,3.25);
        assert_eq!(status.output_clipped_blocks,17);
        for (key,value) in [("outputPeak",serde_json::json!(-1)),("outputPeak",serde_json::json!("loud")),
            ("outputClippedBlocks",serde_json::json!(-1)),("outputClippedBlocks",serde_json::json!(0.5)),
            ("outputClippedBlocks",serde_json::json!(4294967296_u64))] {
            let mut bad=packet.clone();bad[key]=value;assert!(Status::parse(&bad).is_err(),"{key}");
        }
    }
    #[test]
    fn playback_admission_rejection_cannot_revoke_current_and_armed_packets_publish_intent() {
        let intent=Arc::new(AtomicU64::new(8));
        let (sender,requests)=mpsc::sync_channel(1);
        sender.send(Arc::new(AtomicBool::new(true))).unwrap();
        assert!(admit_playback_request(&sender,&intent,9,|armed|{
            assert_eq!(intent.load(Ordering::Acquire),8);armed
        }).is_err());
        assert_eq!(intent.load(Ordering::Acquire),8);
        requests.recv().unwrap();
        let consumer_intent=intent.clone();
        let consumer=thread::spawn(move||{
            let armed=requests.recv_timeout(Duration::from_secs(1)).unwrap();
            let deadline=Instant::now()+Duration::from_secs(1);
            while !armed.load(Ordering::Acquire) {
                assert!(Instant::now()<deadline);thread::yield_now();
            }
            assert_eq!(consumer_intent.load(Ordering::Acquire),10);
        });
        admit_playback_request(&sender,&intent,10,|armed|armed).unwrap();
        consumer.join().unwrap();
    }
    #[test]
    fn playback_receipt_requires_own_callback_ticket_including_wrap_and_immediate_completion() {
        let reply=|queued:u32,applied:u32,playing:bool| {
            let mut value=captured_lane_reply();value["transportGeneration"]=7.into();
            value["transportCommandsQueued"]=queued.into();value["transportCommandsApplied"]=applied.into();
            value["playing"]=playing.into();value
        };
        let mut polls=0;
        let settled=settle_playback_receipt(reply(2,1,false),Duration::from_secs(1),||true,||{polls+=1;Ok(reply(2,2,true))}).unwrap();
        assert!(matches!(settled,PlaybackReceipt::Applied(status) if status.playing));assert_eq!(polls,1);
        // Identical paused endpoint is accepted only after THIS Resume ticket.
        let completed=settle_playback_receipt(reply(4,3,false),Duration::from_secs(1),||true,||Ok(reply(4,4,false))).unwrap();
        assert!(matches!(completed,PlaybackReceipt::Applied(status) if !status.playing));
        assert!(settle_playback_receipt(reply(4,3,false),Duration::ZERO,||true,||panic!("Old endpoint is not a receipt")).is_err());
        assert!(settle_playback_receipt(reply(4,3,false),Duration::ZERO,||false,||panic!("Supersession cannot hide a receipt timeout")).is_err());
        assert!(matches!(settle_playback_receipt(reply(4,4,true),Duration::from_secs(1),||false,||panic!("Superseded request must not poll")).unwrap(),PlaybackReceipt::Cancelled));
        let intent=AtomicU64::new(8);
        assert!(settle_playback_receipt(reply(4,3,false),Duration::from_secs(1),||intent.load(Ordering::Acquire)==8,
            ||{intent.store(9,Ordering::Release);Ok(reply(4,4,true))}).is_ok_and(|receipt|matches!(receipt,PlaybackReceipt::Cancelled)));
        intent.store(8,Ordering::Release);
        assert!(settle_playback_receipt(reply(4,3,false),Duration::from_secs(1),||intent.load(Ordering::Acquire)==8,
            ||{intent.store(9,Ordering::Release);Err(anyhow::anyhow!("Late read timed out"))}).is_err());
        intent.store(8,Ordering::Release);
        assert!(settle_playback_receipt(reply(4,3,false),Duration::from_secs(1),||intent.load(Ordering::Acquire)==8,
            ||{intent.store(9,Ordering::Release);Ok(serde_json::json!({"protocol":1,"ok":false,"error":"Broken reply"}))}).is_err());
        assert!(settle_playback_receipt(reply(0,u32::MAX,false),Duration::from_secs(1),||true,||Ok(reply(0,0,false))).is_ok());
        assert!(settle_playback_receipt(reply(u32::MAX,0,false),Duration::ZERO,||true,||panic!("Wrapped ticket was already applied")).is_ok());
        let mut missing=reply(1,1,true);missing.as_object_mut().unwrap().remove("transportCommandsApplied");
        assert!(settle_playback_receipt(missing,Duration::ZERO,||true,||panic!()).is_err());
        assert!(settle_playback_receipt(captured_lane_reply(),Duration::ZERO,||true,||panic!()).is_err());
        assert!(settle_playback_receipt(reply(4,3,false),Duration::from_secs(1),||true,||{let mut newer=reply(4,4,true);newer["transportGeneration"]=8.into();Ok(newer)}).is_err());
    }
    #[test]
    fn rejected_output_requires_fresh_proof_that_the_previous_transport_survived() {
        let before=captured_lane_reply();let mut rejected=before.clone();rejected["ok"]=false.into();rejected["error"]="Missing output".into();
        assert!(retained_output(&before,&rejected,&before).is_ok());
        for (key,value) in [("outputUid",serde_json::json!("foreign output")),("graphGeneration",serde_json::json!(99)),("masterGain",serde_json::json!(0.5)),("playbackRate",serde_json::json!(0.7)),("playing",serde_json::json!(true)),("state",serde_json::json!(6))] {
            let mut after=before.clone();after[key]=value;
            assert!(retained_output(&before,&rejected,&after).is_err(),"Uncertain {key} was retained as a clean refusal");
        }
        let mut rejected=rejected;rejected["outputUid"]="changed despite refusal".into();
        assert!(retained_output(&before,&rejected,&before).is_err());
    }
    #[test]
    fn accepted_output_requires_the_requested_route_and_retained_audio_controls() {
        let before=captured_lane_reply();let mut reply=before.clone();reply["outputUid"]="new selected output".into();reply["graphGeneration"]=9.into();
        assert!(accepted_output(&before,&reply,"new selected output").is_ok());
        assert!(accepted_output(&before,&reply,"different requested output").is_err());
        for (key,value) in [("playing",serde_json::json!(true)),("masterGain",serde_json::json!(0.5)),("transpose",serde_json::json!(7)),("explicitGraph",serde_json::json!(true)),("duration",serde_json::json!(10))] {
            let mut changed=reply.clone();changed[key]=value;
            assert!(accepted_output(&before,&changed,"new selected output").is_err(),"Output selection changed {key}");
        }
    }
    fn provider_inventory_fixture()->Value {
        let mut value=captured_lane_reply();
        value["provider"]="wasapi".into();value["backendProvider"]="fake".into();value["fixture"]=true.into();value
    }
    #[test]
    fn connection_provider_boundary_admits_current_and_copy_retained_actual_provenance() {
        let (send,replies)=mpsc::channel();let latest=AtomicU64::new(7);let alive=AtomicBool::new(true);let handoff=AtomicU64::new(0);let mut pending=None;
        let value=provider_inventory_fixture();send.send(Ok(value.clone())).unwrap();let mut kinds=vec![];
        let received=read_provider_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|facts,kind,current|{
            assert!(current());assert_eq!(facts.as_object().unwrap().len(),4);
            assert_eq!(facts["provider"],"wasapi");assert_eq!(facts["backendProvider"],"fake");assert_eq!(facts["fixture"],true);
            assert_eq!(facts["deviceInventory"],value["deviceInventory"]);kinds.push(kind);Ok(())
        }).unwrap();assert_eq!(received,value);assert_eq!(kinds,vec![crate::audio_devices::SnapshotKind::Current]);
        latest.store(8,Ordering::Release);handoff.store(8,Ordering::Release);send.send(Ok(value.clone())).unwrap();
        read_provider_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Drained owner admitted facts")).unwrap();
        assert!(pending.is_some());let mut status=value.clone();status.as_object_mut().unwrap().remove("deviceInventory");
        handoff.store(0,Ordering::Release);send.send(Ok(status)).unwrap();
        read_provider_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|facts,kind,current|{
            assert!(current());assert_eq!(kind,crate::audio_devices::SnapshotKind::Retained);
            assert_eq!(facts["provider"],"wasapi");assert_eq!(facts["backendProvider"],"fake");assert_eq!(facts["fixture"],true);Ok(())
        }).unwrap();assert!(pending.is_none());
    }
    #[test]
    fn connection_provider_boundary_refuses_missing_foreign_and_stale_receipts_before_admission() {
        let latest=AtomicU64::new(7);let alive=AtomicBool::new(true);let handoff=AtomicU64::new(0);
        for key in ["provider","backendProvider","fixture"] {
            let (send,replies)=mpsc::channel();let mut value=provider_inventory_fixture();value.as_object_mut().unwrap().remove(key);send.send(Ok(value)).unwrap();let mut pending=None;
            assert!(read_provider_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Missing identity admitted facts")).is_err());assert!(pending.is_none());
        }
        let (send,replies)=mpsc::channel();let mut foreign=provider_inventory_fixture();foreign["provider"]="asio".into();send.send(Ok(foreign)).unwrap();let mut pending=None;
        assert!(read_provider_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Foreign provider admitted facts")).is_err());assert!(pending.is_none());
        // A valid retained slot cannot be promoted by a foreign current status.
        latest.store(8,Ordering::Release);handoff.store(8,Ordering::Release);send.send(Ok(provider_inventory_fixture())).unwrap();
        read_provider_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Drained owner admitted facts")).unwrap();
        let mut foreign=provider_inventory_fixture();foreign.as_object_mut().unwrap().remove("deviceInventory");foreign["provider"]="asio".into();handoff.store(0,Ordering::Release);send.send(Ok(foreign)).unwrap();
        assert!(read_provider_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Foreign status promoted retained facts")).is_err());
        assert!(pending.is_some());
        latest.store(9,Ordering::Release);send.send(Ok(provider_inventory_fixture())).unwrap();
        assert!(read_provider_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,crate::audio_devices::Provider::Wasapi,|_,_,_|panic!("Stale owner admitted facts")).is_err());
    }
    #[test]
    fn copy_handoff_promotes_deferred_facts_only_for_the_retained_helpers_confirmed_output() {
        let (send,replies)=mpsc::channel();let latest=AtomicU64::new(8);let alive=AtomicBool::new(true);let handoff=AtomicU64::new(8);let mut pending=None;
        send.send(Ok(captured_lane_reply())).unwrap();
        read_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|panic!("Drained owner published facts")).unwrap();
        assert!(pending.is_some());
        let mut status=captured_lane_reply();status.as_object_mut().unwrap().remove("deviceInventory");
        handoff.store(0,Ordering::Release);send.send(Ok(status.clone())).unwrap();let mut adopted=None;
        read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|reply,kind,current|{
            assert_eq!(kind,crate::audio_devices::SnapshotKind::Retained);assert!(current());
            adopted=Some(crate::audio_devices::Inventory::parse(&reply["deviceInventory"])?);Ok(())
        }).unwrap();
        // This recorded Linux/fake reply qualifies retained capability facts,
        // not Windows provider-scoped playback selection.
        let adopted=adopted.unwrap();assert_eq!(adopted.default_output,"singz:fake-new-default");
        assert!(adopted.devices.iter().any(|d|d.uid==adopted.default_output&&d.outputs==8));assert!(pending.is_none());
        send.send(Ok(status.clone())).unwrap();
        read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|panic!("Ordinary status replayed facts again")).unwrap();
        // A different connection has no authority to borrow another helper's slot.
        let mut unrelated=None;send.send(Ok(status.clone())).unwrap();
        read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut unrelated,|_,_,_|panic!("New helper borrowed old facts")).unwrap();
        handoff.store(8,Ordering::Release);send.send(Ok(captured_lane_reply())).unwrap();
        read_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|panic!("Drained owner published facts")).unwrap();
        status["outputUid"]="different output".into();handoff.store(0,Ordering::Release);send.send(Ok(status)).unwrap();
        read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|panic!("Changed output inherited old facts")).unwrap();assert!(pending.is_none());
    }
    #[test]
    fn raw_transaction_reader_admits_capabilities_from_the_current_native_owner() {
        let (send,replies)=mpsc::channel();let value=captured_lane_reply();send.send(Ok(value.clone())).unwrap();
        let latest=AtomicU64::new(7);let alive=AtomicBool::new(true);let handoff=AtomicU64::new(0);
        let mut cached=None;let mut pending=None;
        let received=read_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|reply,kind,current|{
            assert_eq!(kind,crate::audio_devices::SnapshotKind::Current);
            let inventory=crate::audio_devices::Inventory::parse(&reply["deviceInventory"])?;
            if current(){cached=Some(inventory);}Ok(())
        }).unwrap();
        assert_eq!(received,value);assert_eq!(received["lanesCommitted"],true);
        let cached=cached.expect("Raw native lane admission discarded its device capabilities");
        // Assert the recorded Linux owner's admitted facts on every host;
        // Windows routing policy is independently tested with scoped UIDs.
        assert_eq!(cached.default_output,"singz:fake-new-default");
        assert_eq!(cached.devices.iter().find(|d|d.uid==cached.default_output).unwrap().outputs,8);
    }
    #[test]
    fn native_inventory_intake_refuses_old_drained_failed_malformed_and_revoked_authority() {
        let latest=AtomicU64::new(8);let alive=AtomicBool::new(true);let handoff=AtomicU64::new(8);
        let (send,replies)=mpsc::channel();send.send(Ok(captured_lane_reply())).unwrap();
        let mut calls=0;let mut pending=None;
        read_inventory_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|{calls+=1;Ok(())}).unwrap();
        assert_eq!(calls,0,"Copy handoff granted the drained old owner cache authority");
        let mut refused=captured_lane_reply();refused["ok"]=false.into();send.send(Ok(refused)).unwrap();
        read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|{calls+=1;Ok(())}).unwrap();assert_eq!(calls,0);
        let mut malformed=captured_lane_reply();malformed["cueNowHostNs"]="invalid".into();send.send(Ok(malformed)).unwrap();
        assert!(read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,_|{calls+=1;Ok(())}).is_err());assert_eq!(calls,0);
        for revoke_epoch in [true,false] {
            latest.store(8,Ordering::Release);alive.store(true,Ordering::Release);send.send(Ok(captured_lane_reply())).unwrap();let mut cached=false;
            read_inventory_reply(&replies,8,&latest,&alive,&handoff,Duration::from_millis(100),&mut pending,|_,_,current|{
                if revoke_epoch{latest.store(9,Ordering::Release);}else{alive.store(false,Ordering::Release);}
                // The real cache checks again while holding its mutation lock.
                if current(){cached=true;}Ok(())
            }).unwrap();assert!(!cached);
        }
    }

    #[test]
    fn copy_handoff_consumes_the_inflight_reply_before_reading_the_new_epoch_reply(){
        let (send,replies)=mpsc::channel();
        let latest=AtomicU64::new(40);let handoff=AtomicU64::new(0);let alive=AtomicBool::new(true);
        assert!(connection_read_allowed(40,&latest,&alive,&handoff));
        // Match the production order: arm before revocation, then finish the
        // already-issued old status/control command through its normal reader.
        handoff.store(41,Ordering::Release);latest.store(41,Ordering::Release);
        send.send(Ok(serde_json::json!({"reply":"old in-flight command"}))).unwrap();
        send.send(Ok(serde_json::json!({"reply":"fresh copy status"}))).unwrap();
        assert_eq!(read_connection_reply(&replies,40,&latest,&alive,&handoff,Duration::from_millis(100)).unwrap()["reply"],"old in-flight command");
        // ImportLibrary relabels the retained connection only after the first
        // reply has been consumed, then revokes the temporary exception.
        handoff.store(0,Ordering::Release);
        assert_eq!(read_connection_reply(&replies,41,&latest,&alive,&handoff,Duration::from_millis(100)).unwrap()["reply"],"fresh copy status");
        assert!(replies.try_recv().is_err());
    }
    #[test]
    fn copy_handoff_never_permits_later_navigation_unarmed_epochs_or_shutdown(){
        let (send,replies)=mpsc::channel();send.send(Ok(serde_json::json!({"old":true}))).unwrap();
        let latest=AtomicU64::new(8);let handoff=AtomicU64::new(8);let alive=AtomicBool::new(true);
        // Only the immediate predecessor of the specific armed Copy may read.
        for old in [6,9]{assert!(read_connection_reply(&replies,old,&latest,&alive,&handoff,Duration::from_millis(10)).is_err());}
        handoff.store(0,Ordering::Release);assert!(read_connection_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(10)).is_err());
        handoff.store(8,Ordering::Release);latest.store(9,Ordering::Release);assert!(read_connection_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(10)).is_err());
        latest.store(8,Ordering::Release);alive.store(false,Ordering::Release);assert!(read_connection_reply(&replies,7,&latest,&alive,&handoff,Duration::from_millis(10)).is_err());
        // Refusal did not consume an unrelated reply or hide a real error.
        assert_eq!(replies.try_recv().unwrap().unwrap()["old"],true);
    }
    #[test]
    fn copy_handoff_keeps_real_reader_failures_and_timeout_visible(){
        let (send,replies)=mpsc::channel();let latest=AtomicU64::new(2);let handoff=AtomicU64::new(2);let alive=AtomicBool::new(true);
        send.send(Err(anyhow::anyhow!("malformed helper reply"))).unwrap();
        assert!(read_connection_reply(&replies,1,&latest,&alive,&handoff,Duration::from_millis(1)).unwrap_err().to_string().contains("malformed"));
        assert!(read_connection_reply(&replies,1,&latest,&alive,&handoff,Duration::from_millis(1)).unwrap_err().to_string().contains("timed out"));
        drop(send);assert!(read_connection_reply(&replies,1,&latest,&alive,&handoff,Duration::from_millis(1)).unwrap_err().to_string().contains("disconnected"));
    }
    fn fixture(name: &str) -> PathBuf {
        let root =
            std::env::temp_dir().join(format!("singz-rust-project-{}-{name}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        fs::create_dir_all(root.join("stems")).unwrap();
        root
    }
    #[test]
    fn shutdown_karaoke_failure_still_retains_other_preferences() {
        let root=fixture("karaoke-shutdown-write-failure");
        fs::write(root.join("audio.json"),b"broken").unwrap();
        let (sender,requests)=mpsc::sync_channel(4);
        let met=crate::beat::Metronome{volume:0.41,..Default::default()};
        sender.send(Request::KaraokePref(1,true)).unwrap();
        sender.send(Request::AdoptMetronomePreferences(1,met.clone())).unwrap();
        assert!(flush_metronome_adoptions(&requests,None,None,&root).is_err());
        assert_eq!(fs::read(root.join("audio.json")).unwrap(),b"broken");
        assert_eq!(crate::metronome_store::load(&root).unwrap(),met);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shutdown_retains_received_and_latest_queued_karaoke_choice_without_audio() {
        let root=fixture("karaoke-shutdown");
        fs::write(root.join("audio.json"),br#"{"outputUid":"keep","future":{"token":7}}"#).unwrap();
        let (sender,requests)=mpsc::sync_channel(8);
        // Models a preference already received by recv_timeout when Drop
        // sets alive=false: it must survive the early shutdown match arm.
        flush_metronome_adoptions(&requests,None,Some(true),&root).unwrap();
        let read=||serde_json::from_slice::<Value>(&fs::read(root.join("audio.json")).unwrap()).unwrap();
        assert!(crate::audio_devices::karaoke(&read()));
        // Remaining FIFO requests supersede that received choice, without
        // starting queued playback or opening a new project during teardown.
        sender.send(Request::KaraokePref(2,true)).unwrap();
        sender.send(Request::Control(1,"play".into())).unwrap();
        sender.send(Request::Open(3,root.join("must-not-open"),None,None,None)).unwrap();
        sender.send(Request::KaraokePref(3,false)).unwrap();
        flush_metronome_adoptions(&requests,None,Some(true),&root).unwrap();
        let saved=read();
        assert!(!crate::audio_devices::karaoke(&saved));
        assert_eq!(saved["outputUid"],"keep");assert_eq!(saved["future"]["token"],7);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shutdown_flushes_last_visible_adoption_but_not_queued_audio_intent() {
        let root = fixture("metronome-shutdown");
        let first = crate::beat::Metronome {
            grid: true,
            ..Default::default()
        };
        let last = crate::beat::Metronome {
            click: true,
            volume: 0.42,
            count_in_bars: 2,
            accent: false,
            grid: true,
        };
        let unapplied = crate::beat::Metronome {
            volume: 0.9,
            grid: false,
            ..Default::default()
        };
        let (sender, requests) = mpsc::sync_channel(8);
        sender.send(Request::Control(2, "play".into())).unwrap();
        sender
            .send(Request::AdoptMetronomePreferences(1, last.clone()))
            .unwrap();
        sender
            .send(Request::Open(3, root.join("must-not-open"), None, None, None))
            .unwrap();
        sender
            .send(Request::Metronome(3, 99, unapplied.clone(), None))
            .unwrap();
        flush_metronome_adoptions(&requests, Some(first), None, &root).unwrap();
        assert_eq!(crate::metronome_store::load(&root).unwrap(), last);
        let saved = fs::read(root.join("metronome.json")).unwrap();
        sender
            .send(Request::Metronome(4, 100, unapplied, None))
            .unwrap();
        flush_metronome_adoptions(&requests, None, None, &root).unwrap();
        assert_eq!(fs::read(root.join("metronome.json")).unwrap(), saved);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn shutdown_preference_failure_is_reported_without_overwriting_future_data() {
        let root = fixture("metronome-shutdown-refusal");
        let future = br#"{"version":2,"grid":true,"future":"keep"}"#;
        fs::write(root.join("metronome.json"), future).unwrap();
        let (sender, requests) = mpsc::sync_channel(1);
        sender
            .send(Request::AdoptMetronomePreferences(1, Default::default()))
            .unwrap();
        assert!(flush_metronome_adoptions(&requests, None, None, &root).is_err());
        assert_eq!(fs::read(root.join("metronome.json")).unwrap(), future);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn project_versions_mix_and_flac_preference() {
        let root = fixture("versions");
        fs::write(root.join("stems/vocals.wav"), b"wav").unwrap();
        fs::write(root.join("stems/vocals.flac"), b"flac").unwrap();
        for version in [1, 2] {
            fs::write(root.join("project.json"),format!(r#"{{"version":{version},"name":"A voice","settings":{{"transpose":0,"tracks":{{"vocals":{{"volume":0.4,"muted":true}}}}}}}}"#)).unwrap();
            let mut project = read_project(&root).unwrap();
            assert_eq!(project.name, "A voice");
            assert_eq!(project.gain[0], 0.4);
            assert!(project.muted[0]);
            assert_eq!(project.lanes[0].1.extension().unwrap(), "flac");
            assert!(crate::project_analysis::needed(&project));
            Arc::make_mut(&mut project.pitch).det_version = 5.;
            assert!(
                !crate::project_analysis::needed(&project),
                "Newer detector results must not be downgraded"
            );
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn catalog_retains_graph_projects_without_claiming_playback_support() {
        let root=fixture("catalog-graph");
        fs::write(root.join("stems/vocals.wav"), b"wav").unwrap();
        fs::write(root.join("project.json"), br#"{"version":2,"name":"Graph song","graphHash":{"format":1,"md5":"missing"},"settings":{}}"#).unwrap();
        let row=read_project_mode(&root,false).unwrap();
        assert_eq!(row.name,"Graph song");
        assert_eq!(row.dir,root.canonicalize().unwrap());
        assert!(read_project(&root).unwrap_err().to_string().contains("saved graph"));
        assert!(!root.join("graph.json").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn rejects_unhandled_semantics_and_damaged_sources() {
        let root = fixture("invalid");
        fs::write(root.join("stems/vocals.wav"), b"wav").unwrap();
        for meta in [
            r#"{"version":3}"#,
            r#"{"settings":42}"#,
            r#"{"settings":{"transpose":25}}"#,
            r#"{"graphHash":{}}"#,
            r#"{"settings":{"selection":{"s":2,"e":1}}}"#,
            r#"{"stemHashes":{"vocals.wav":{"size":1000}}}"#,
        ] {
            fs::write(root.join("project.json"), meta).unwrap();
            assert!(read_project(&root).is_err(), "Accepted {meta}");
        }
        fs::write(root.join("project.json"),r#"{"settings":{"custom":[{}]}}"#).unwrap();
        let skipped=read_project(&root).unwrap();assert_eq!(skipped.track_warnings.len(),1);assert_eq!(skipped.raw["settings"]["custom"],serde_json::json!([{}]));
        fs::remove_file(root.join("stems/vocals.wav")).unwrap();
        fs::write(
            root.join("project.json"),
            r#"{"songFile":"../outside.wav"}"#,
        )
        .unwrap();
        assert!(read_project(&root).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
#[path="integration_empty_project_tests.rs"]
mod empty_project_tests;

#[cfg(test)]
#[path="integration_carry_line_tests.rs"]
mod carry_line_tests;

#[cfg(test)]
#[path="integration_transport_timing_tests.rs"]
mod transport_timing_tests;

#[cfg(test)]
#[path="integration_timeline_tests.rs"]
mod timeline_tests;

#[cfg(test)]
#[path="integration_actor_tests.rs"]
mod actor_tests;

impl Request {
    fn helper_epoch(&self)->Option<u64>{match self{Self::Admitted(request,_)=>request.helper_epoch(),Self::Playback(e,..)|Self::Control(e,..)|Self::Rate(e,..)|Self::Metronome(e,..)|Self::Carry(e,..)|Self::Region(e,..)|Self::RestoreSeek(e,..)|Self::Training(e,..)|Self::Park(e,..)=>Some(*e),_=>None}}
    fn admitted(self,permit:Option<Admission>)->Self{match permit{Some(permit)=>Self::Admitted(Box::new(self),permit),None=>self}}
}

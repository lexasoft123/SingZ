use super::*;
use crate::tracks::{self, Lane};
use serde_json::json;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "singz-custom-tracks-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let path = path.canonicalize().unwrap();
        fs::create_dir(path.join("stems")).unwrap();
        Self(path)
    }
    fn file(&self, name: &str) -> PathBuf {
        let file = self.0.join(name);
        fs::write(&file, b"fixture encoded audio; reader does not decode").unwrap();
        file
    }
    fn project(&self, custom: Value) {
        fs::write(self.0.join("project.json"),serde_json::to_vec(&json!({"version":2,"name":"Custom fixture","settings":{"custom":custom},"foreign":{"preserve":true}})).unwrap()).unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn custom(id: &str, file: &str) -> Value {
    json!({"id":id,"label":"Мой голос 🎤","color":"#ff9ad5","file":file})
}
#[test]
fn ordinary_six_builtin_roles_and_native_ids_are_unchanged() {
    let f = Fixture::new();
    f.project(json!([]));
    for id in tracks::BUILTIN_IDS {
        f.file(&format!("stems/{id}.wav"));
    }
    let p = read_project(&f.0).unwrap();
    assert_eq!(
        p.lanes.iter().map(|(slot, _)| *slot).collect::<Vec<_>>(),
        (0..6).collect::<Vec<_>>()
    );
    assert_eq!(
        native_lane_sources(&p)
            .unwrap()
            .iter()
            .map(|(id, _)| id.as_str())
            .collect::<Vec<_>>(),
        tracks::BUILTIN_IDS
    );
    assert!(p.custom_tracks().is_empty());
    assert_eq!(p.gain.len(), 22);
}
#[test]
fn sixteen_custom_only_tracks_use_full_native_capacity_without_builtin_slot_tax() {
    let f = Fixture::new();
    let mut list = vec![];
    for i in 0..16 {
        let file = format!("stems/custom-{i}.wav");
        f.file(&file);
        list.push(custom(&format!("custom-{i}"), &file));
    }
    f.project(json!(list));
    let p = read_project(&f.0).unwrap();
    assert_eq!(p.lanes.len(), 16);
    assert_eq!(p.lane_specs.len(), 16);
    assert!(!p.original);
    assert!(p.lanes.iter().all(|(slot, _)| *slot >= 6 && *slot < 22));
    assert!(p.lanes.iter().any(|(slot, _)| *slot == 21));
    assert!(p.lanes.iter().any(|(slot, _)| *slot == 6));
    let sources = native_lane_sources(&p).unwrap();
    for i in 0..16 {
        assert_eq!(sources[i].0, format!("custom-{i}"));
    }
    assert_eq!(p.raw["settings"]["custom"], json!(list));
}
#[test]
fn active_capacity_refuses_seventeenth_track_without_changing_saved_metadata() {
    let f = Fixture::new();
    let mut list = vec![];
    for i in 0..16 {
        let file = format!("stems/custom-{i}.wav");
        f.file(&file);
        list.push(custom(&format!("custom-{i}"), &file));
    }
    f.file("stems/vocals.wav");
    f.project(json!(list));
    let before = fs::read(f.0.join("project.json")).unwrap();
    assert!(read_project(&f.0).is_err());
    assert_eq!(fs::read(f.0.join("project.json")).unwrap(), before);
}
#[test]
fn original_mix_is_not_suppressed_by_added_tracks_and_ids_do_not_all_become_original() {
    let f = Fixture::new();
    f.file("song.wav");
    f.file("stems/custom-harmony.wav");
    f.project(json!([custom(
        "custom-harmony",
        "stems/custom-harmony.wav"
    )]));
    let mut raw: Value =
        serde_json::from_slice(&fs::read(f.0.join("project.json")).unwrap()).unwrap();
    raw["songFile"] = json!("song.wav");
    raw["settings"]["tracks"] =
        json!({"original":{"volume":0.4},"custom-harmony":{"volume":0.8,"solo":true}});
    fs::write(f.0.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    let p = read_project(&f.0).unwrap();
    assert!(p.original);
    assert_eq!(p.lanes.len(), 2);
    assert_eq!(p.lane_id(5), Some("original"));
    let sources = native_lane_sources(&p).unwrap();
    assert_eq!(sources[0].0, "original");
    assert_eq!(sources[1].0, "custom-harmony");
    assert_eq!(p.gain[5], 0.4);
    let slot = p.lane_specs[1].slot;
    assert_eq!(p.gain[slot], 0.8);
    assert!(p.solo[slot]);
}
#[test]
fn backing_slot_six_stays_compatible_among_other_customs() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.file("stems/custom-harmony.wav");
    f.file("stems/custom-backing-vocals.wav");
    let list = json!([
        custom("custom-harmony", "stems/custom-harmony.wav"),
        custom("custom-backing-vocals", "stems/custom-backing-vocals.wav")
    ]);
    f.project(list);
    let p = read_project(&f.0).unwrap();
    assert_eq!(p.lane_id(6), Some("custom-backing-vocals"));
    assert_eq!(p.lane_id(7), Some("custom-harmony"));
    assert_eq!(p.custom_tracks().len(), 2);
}
#[test]
fn windows_relative_custom_path_and_unicode_title_preserve_stable_identity() {
    let f = Fixture::new();
    f.file("stems/Голос 🎤.wav");
    let item = custom("custom-track", r"stems\Голос 🎤.wav");
    f.project(json!([item]));
    let p = read_project(&f.0).unwrap();
    let lane = &p.lane_specs[0];
    assert_eq!(lane.file, f.0.join("stems/Голос 🎤.wav"));
    assert_eq!(lane.id, "custom-track");
    assert_eq!(lane.label, "Мой голос 🎤");
    assert_eq!(lane.color, "#ff9ad5");
    let mut raw = p.raw.clone();
    raw["settings"]["custom"][0]["label"] = json!("Новое название 🧠");
    fs::write(f.0.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    let renamed = read_project(&f.0).unwrap();
    assert_eq!(renamed.lane_specs[0].id, lane.id);
    assert_eq!(renamed.lane_specs[0].slot, lane.slot);
    assert_eq!(renamed.lane_specs[0].file, lane.file);
}
#[test]
fn missing_and_unsafe_custom_paths_are_skipped_with_warnings_without_rewriting_raw() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    let list = json!([custom("custom-missing","stems/missing.wav"),custom("custom-escape","stems/../outside.wav"),custom("custom-absolute","/tmp/foreign.wav"),{"foreignEntry":true}]);
    f.project(list.clone());
    let before = fs::read(f.0.join("project.json")).unwrap();
    let p = read_project(&f.0).unwrap();
    assert_eq!(p.lanes.len(), 1);
    assert!(p.custom_tracks().is_empty());
    assert_eq!(p.track_warnings.len(), 4);
    assert_eq!(p.raw["settings"]["custom"], list);
    assert_eq!(fs::read(f.0.join("project.json")).unwrap(), before);
}
#[test]
fn duplicate_or_reserved_custom_identity_cannot_override_builtin_roles() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.file("stems/a.wav");
    f.file("stems/b.wav");
    f.project(json!([custom("vocals", "stems/a.wav")]));
    assert!(read_project(&f.0).is_err());
    f.project(json!([
        custom("custom-a", "stems/a.wav"),
        custom("custom-a", "stems/b.wav")
    ]));
    assert!(read_project(&f.0).is_err());
}
#[cfg(unix)]
#[test]
fn custom_symlinks_are_not_followed_even_when_the_target_is_inside_the_project() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    let real = f.file("stems/real.wav");
    std::os::unix::fs::symlink(real, f.0.join("stems/linked.wav")).unwrap();
    f.project(json!([custom("custom-linked", "stems/linked.wav")]));
    let p = read_project(&f.0).unwrap();
    assert_eq!(p.lanes.len(), 1);
    assert!(p.custom_tracks().is_empty());
    assert_eq!(p.track_warnings.len(), 1);
}
#[test]
fn portable_path_normalization_never_normalizes_away_unsafe_segments() {
    assert_eq!(
        tracks::normalize_custom_path(r"stems\Мой голос.flac"),
        Some(PathBuf::from("stems/Мой голос.flac"))
    );
    for path in [
        "stems/.",
        "stems/..",
        "stems/a/b.wav",
        "stems/../a.wav",
        "/stems/a.wav",
        "C:\\stems\\a.wav",
        "stems/a.wav:stream",
        "stems/a\0.wav",
    ] {
        assert!(
            tracks::normalize_custom_path(path).is_none(),
            "Accepted {path:?}"
        );
    }
}
#[test]
fn pure_picker_metadata_has_source_slug_label_palette_and_collision_rules() {
    let path = PathBuf::from(if cfg!(windows) {
        r"C:\audio\harmony__take-2.WAV"
    } else {
        "/audio/harmony__take-2.WAV"
    });
    let first = tracks::new_custom(path.clone(), &[]).unwrap();
    assert_eq!(first.id, "custom-harmony-take-2");
    assert_eq!(first.label, "Harmony take 2");
    assert_eq!(first.slot, 7);
    let second = tracks::new_custom(path, &[first.clone()]).unwrap();
    assert_eq!(second.id, "custom-harmony-take-2-2");
    assert_eq!(second.color, tracks::CUSTOM_COLORS[1]);
    assert_eq!(second.slot, 8);
    let unicode = PathBuf::from(if cfg!(windows) {
        r"C:\audio\мой_голос.wav"
    } else {
        "/audio/мой_голос.wav"
    });
    let lane = tracks::new_custom(unicode, &[]).unwrap();
    assert_eq!(lane.id, "custom-track");
    assert_eq!(lane.label, "Мой голос");
    let long = PathBuf::from(if cfg!(windows) {
        format!("C:\\audio\\{}-b.wav", "a".repeat(39))
    } else {
        format!("/audio/{}-b.wav", "a".repeat(39))
    });
    let lane = tracks::new_custom(long, &[]).unwrap();
    assert_eq!(lane.id, format!("custom-{}-", "a".repeat(39)));
    tracks::validate_custom_id(&lane.id).unwrap();
}
#[test]
fn native_source_manifest_refuses_inconsistent_slot_or_id_metadata() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let mut p = read_project(&f.0).unwrap();
    p.lane_specs.clear();
    assert!(native_lane_sources(&p).is_err());
}

#[test]
fn replacement_candidate_captures_new_file_and_keeps_existing_stable_mix_slots() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let original = read_project(&f.0).unwrap();
    let mut candidate = original.clone();
    let file = f.file("Гармония 🎤.wav");
    candidate
        .lane_specs
        .push(tracks::new_custom(file.clone(), &candidate.lane_specs).unwrap());
    prepare_lane_candidate(
        &mut candidate,
        &original.lane_specs,
        &original.lane_stamps,
        &|| false,
    )
    .unwrap();
    assert_eq!(original.lanes.len(), 1);
    assert_eq!(candidate.lanes.len(), 2);
    assert_eq!(candidate.lane_stamps.len(), 2);
    assert_eq!(candidate.lane_specs[1].file, file);
    assert_eq!(candidate.lane_specs[0].slot, 0);
    let commands = lane_transaction(&candidate).unwrap();
    assert_eq!(commands[0], "lanes-begin 2");
    assert_eq!(commands.len(), 3);
    assert!(commands[2].contains(&hex_utf8("custom-track")));
    assert!(commands[2].contains(&hex_utf8(file.to_str().unwrap())));
    assert!(
        commands
            .iter()
            .all(|line| line.is_ascii() && line.len() <= 4096)
    );
}
#[test]
fn replacement_refuses_changed_loaded_audio_and_builtin_removal_before_native_mutation() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.file("stems/bass.wav");
    f.project(json!([]));
    let original = read_project(&f.0).unwrap();
    let mut removed = original.clone();
    removed.lane_specs.retain(|lane| lane.id != "bass");
    assert!(
        prepare_lane_candidate(
            &mut removed,
            &original.lane_specs,
            &original.lane_stamps,
            &|| false
        )
        .is_err()
    );
    let mut changed = original.clone();
    fs::write(f.0.join("stems/vocals.wav"), b"external different audio").unwrap();
    assert!(
        prepare_lane_candidate(
            &mut changed,
            &original.lane_specs,
            &original.lane_stamps,
            &|| false
        )
        .is_err()
    );
    assert_eq!(original.lanes.len(), 2);
}
#[test]
fn native_reply_separates_precommit_refusal_from_irreversible_committed_failure() {
    assert!(
        matches!(replacement_reply(json!({"protocol":1,"ok":false,"lanesCommitted":false,"error":"decode refused"}),&[]),Err(LaneReplaceFailure::Refused(message))if message=="decode refused")
    );
    assert!(
        matches!(replacement_reply(json!({"protocol":1,"ok":false,"lanesCommitted":true,"laneIds":["vocals"],"error":"settlement failed"}),&["vocals".into()]),Err(LaneReplaceFailure::Committed(message))if message.contains("settlement failed"))
    );
    assert!(
        matches!(replacement_reply(json!({"protocol":1,"ok":true,"lanesCommitted":true,"laneIds":["foreign"]}),&["vocals".into()]),Err(LaneReplaceFailure::Committed(message))if message.contains("differ"))
    );
}
#[test]
fn successful_replacement_returns_native_peaks_and_independent_vocal_duration() {
    let packet = json!({"protocol":1,"ok":true,"lanesCommitted":true,"laneIds":["vocals","custom-long"],"laneDurations":[4.0,20.0],"duration":20.0,"position":1.0,"playing":false,"peaks":[[0.1,0.5],[0.2]],"cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":false,"cueOutputLatencyMs":0.0,"cueNotes":[]});
    match replacement_reply(packet, &["vocals".into(), "custom-long".into()]) {
        Ok((status, peaks, vocal)) => {
            assert_eq!(status.duration, 20.0);
            assert_eq!(vocal, Some(4.0));
            assert_eq!(peaks, vec![vec![0.1, 0.5], vec![0.2]]);
        }
        Err(_) => panic!("Valid committed reply refused"),
    }
    assert!(vocal_lane_duration(&json!({"laneIds":["vocals"],"laneDurations":[]})).is_err());
    assert!(vocal_lane_duration(&json!({"laneIds":["vocals"],"laneDurations":[0]})).is_err());
    assert_eq!(vocal_lane_duration(&json!({})).unwrap(), None);
}
#[test]
fn per_job_analysis_cancellation_releases_worker_before_replacement() {
    let alive = Arc::new(AtomicBool::new(true));
    let watching = alive.clone();
    let exited = Arc::new(AtomicBool::new(false));
    let proof = exited.clone();
    let mut job = Some(thread::spawn(move || {
        while watching.load(Ordering::Acquire) {
            thread::yield_now();
        }
        proof.store(true, Ordering::Release);
    }));
    let mut token = Some(alive);
    stop_analysis(&mut job, &mut token);
    assert!(job.is_none());
    assert!(token.is_none());
    assert!(exited.load(Ordering::Acquire));
}

#[test]
fn refused_candidate_reschedules_analysis_for_accepted_sources_not_invalid_new_lane() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let accepted = read_project(&f.0).unwrap();
    let mut requested = accepted.clone();
    let missing = f.0.join("missing-added.wav");
    let added = tracks::new_custom(missing, &requested.lane_specs).unwrap();
    requested.lanes.push((added.slot, added.file.clone()));
    requested.lane_specs.push(added);
    let snapshot =
        accepted_analysis_snapshot(&requested, &accepted.lane_specs, &accepted.lane_stamps);
    assert!(
        prepare_lane_candidate(
            &mut requested,
            &accepted.lane_specs,
            &accepted.lane_stamps,
            &|| false
        )
        .is_err()
    );
    let old_alive = Arc::new(AtomicBool::new(true));
    let running = old_alive.clone();
    let stopped = Arc::new(AtomicBool::new(false));
    let proof = stopped.clone();
    let mut old_job = Some(thread::spawn(move || {
        while running.load(Ordering::Acquire) {
            thread::yield_now();
        }
        proof.store(true, Ordering::Release);
    }));
    let mut old_cancel = Some(old_alive);
    stop_analysis(&mut old_job, &mut old_cancel);
    assert!(stopped.load(Ordering::Acquire));
    let (events, receipts) = mpsc::channel();
    let latest = Arc::new(AtomicU64::new(41));
    let alive = Arc::new(AtomicBool::new(true));
    let mut job = None;
    let mut token = None;
    // This tests scheduling/ownership, not model inference. The runner checks
    // the real accepted source stamp and emits through the actual receipt path.
    assert!(restart_analysis_using(
        snapshot,
        41,
        &events,
        &latest,
        &alive,
        &mut job,
        &mut token,
        move |project, epoch, current, running, _job_id| {
            assert_eq!(epoch, 41);
            assert_eq!(current.load(Ordering::Acquire), 41);
            assert!(running.load(Ordering::Acquire));
            assert!(stopped.load(Ordering::Acquire));
            assert_eq!(project.lanes.len(), 1);
            assert!(project.custom_tracks().is_empty());
            assert_eq!(project.lane_id(0), Some("vocals"));
            assert_eq!(
                project.vocal_stamp,
                Some(crate::project_analysis::stamp(&project.lanes[0].1)?)
            );
            Ok(crate::project_analysis::Output {
                melody: Some(json!({"dispatchScope":"accepted-source analysis rescheduled after refused track edit"})),
                ..Default::default()
            })
        }
    ));
    let Event::AnalysisStarted(start_epoch, job_id) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("Analysis identity was not published before its result")
    };
    assert_eq!(start_epoch, 41);
    let Event::Analyzed(epoch, result_job_id, result) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("Wrong restarted analysis event")
    };
    assert_eq!(epoch, 41);
    assert_eq!(result_job_id, job_id);
    assert!(
        result.unwrap().melody.unwrap()["dispatchScope"]
            .as_str()
            .unwrap()
            .contains("accepted-source")
    );
    stop_analysis(&mut job, &mut token);
}
#[test]
fn refusal_does_not_restart_analysis_for_a_retired_project() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let project = read_project(&f.0).unwrap();
    let (events, receipts) = mpsc::channel();
    let latest = Arc::new(AtomicU64::new(42));
    let alive = Arc::new(AtomicBool::new(true));
    let mut job = None;
    let mut token = None;
    assert!(!restart_analysis_using(
        Some(project),
        41,
        &events,
        &latest,
        &alive,
        &mut job,
        &mut token,
        |_, _, _, _, _| panic!("Retired analysis runner started")
    ));
    assert!(job.is_none());
    assert!(token.is_none());
    assert!(receipts.try_recv().is_err());
}
#[test]
fn staging_distinguishes_complete_native_refusal_from_untrustworthy_connection() {
    assert!(
        matches!(lane_stage_reply(json!({"protocol":1,"ok":false,"state":1,"error":"invalid staging member"})),Err(LaneReplaceFailure::Refused(message))if message=="invalid staging member")
    );
    assert!(matches!(
        lane_stage_reply(json!({"protocol":99,"ok":false,"error":"wrong protocol"})),
        Err(LaneReplaceFailure::Disconnected(_))
    ));
    assert!(matches!(
        lane_stage_reply(json!({"protocol":1,"ok":false,"state":6,"error":"host stopped"})),
        Err(LaneReplaceFailure::Disconnected(_))
    ));
    assert!(matches!(
        lane_stage_reply(json!({"protocol":1,"ok":true,"duration":1.0})),
        Err(LaneReplaceFailure::Disconnected(_))
    ));
}

#[test]
fn mixed_add_skips_bad_file_without_consuming_id_slot_or_palette() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let original = read_project(&f.0).unwrap();
    let mut candidate = original.clone();
    for name in ["a", "b", "c"] {
        fs::create_dir(f.0.join(name)).unwrap();
        f.file(&format!("{name}/harmony.wav"));
    }
    let paths: Vec<_> = ["a", "b", "c"]
        .into_iter()
        .map(|part| f.0.join(part).join("harmony.wav"))
        .collect();
    let mut checked = vec![];
    prevalidate_new_tracks_using(
        &mut candidate,
        &original.lane_specs,
        &paths,
        &|| false,
        |path, _| {
            checked.push(path.to_path_buf());
            if path.parent().unwrap().ends_with("b") {
                bail!("native decoder refused fixture B");
            }
            Ok(path.canonicalize()?)
        },
    )
    .unwrap();
    assert_eq!(checked, paths);
    let customs = candidate.custom_tracks();
    assert_eq!(customs.len(), 2);
    assert_eq!(customs[0].id, "custom-harmony");
    assert_eq!(customs[1].id, "custom-harmony-2");
    assert_eq!((customs[0].slot, customs[1].slot), (7, 8));
    assert_eq!(customs[0].color, tracks::CUSTOM_COLORS[0]);
    assert_eq!(customs[1].color, tracks::CUSTOM_COLORS[1]);
    assert!(
        candidate
            .track_warnings
            .iter()
            .any(|w| w.contains("fixture B"))
    );
    assert_eq!(candidate.raw, original.raw);
    assert_eq!(original.lanes.len(), 1);
    assert!(candidate.gain[8] == 1. && !candidate.muted[8] && !candidate.solo[8]);
}
#[test]
fn failed_file_does_not_consume_last_active_slot_before_later_good_file() {
    let f = Fixture::new();
    let mut list = vec![];
    for i in 0..15 {
        let file = format!("stems/custom-{i}.wav");
        f.file(&file);
        list.push(custom(&format!("custom-{i}"), &file));
    }
    f.project(json!(list));
    let original = read_project(&f.0).unwrap();
    let mut candidate = original.clone();
    let bad = f.file("bad.wav");
    let good = f.file("good.wav");
    prevalidate_new_tracks_using(
        &mut candidate,
        &original.lane_specs,
        &[bad, good.clone()],
        &|| false,
        |path, _| {
            if path.ends_with("bad.wav") {
                bail!("unreadable");
            }
            Ok(path.canonicalize()?)
        },
    )
    .unwrap();
    assert_eq!(candidate.lane_specs.len(), 16);
    let added = candidate.lane_specs.last().unwrap();
    assert_eq!(added.id, "custom-good");
    assert_eq!(added.slot, 6);
    assert_eq!(added.file, good);
    assert_eq!(added.color, tracks::CUSTOM_COLORS[0]);
}
#[test]
fn all_bad_additions_are_refused_and_oversized_batches_never_measure() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let original = read_project(&f.0).unwrap();
    let mut candidate = original.clone();
    let bad = f.file("bad.wav");
    let error = prevalidate_new_tracks_using(
        &mut candidate,
        &original.lane_specs,
        &[bad],
        &|| false,
        |_, _| bail!("codec failure"),
    )
    .unwrap_err();
    assert!(error.to_string().contains("codec failure"));
    assert_eq!(candidate.lane_specs, original.lane_specs);
    let mut candidate = original.clone();
    assert!(
        prevalidate_new_tracks_using(
            &mut candidate,
            &original.lane_specs,
            &vec![f.0.join("unused.wav"); 257],
            &|| false,
            |_, _| panic!("Oversized picker batch decoded audio")
        )
        .is_err()
    );
}
#[cfg(unix)]
#[test]
fn validation_child_is_bounded_and_cancelled_without_creating_an_audio_host() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let source = f.file("input.wav");
    // Executable source stays stable throughout parallel tests. Writing a
    // script immediately before exec can race another fork retaining its
    // writable descriptor and produce ETXTBSY on Linux.
    let helper = Path::new(env!("CARGO_MANIFEST_DIR"))
        .join("../../tests/shared/native-measure-fixture.sh").canonicalize().unwrap();
    assert_ne!(fs::metadata(&helper).unwrap().permissions().mode() & 0o100, 0,
        "Native validation fixture must retain its executable mode");
    assert_eq!(measure_new_track(&source, &|| false, &helper).unwrap(), source);
    let cancelled = f.file("cancel-measure.wav");
    let ready = PathBuf::from(format!("{}.ready", cancelled.display()));
    let start = Instant::now();
    let error=measure_new_track(&cancelled, &|| ready.exists(), &helper).unwrap_err();
    assert!(ready.exists() && error.to_string().contains("cancelled"),"{error:#}");
    assert!(start.elapsed() < Duration::from_secs(5));
    let oversized = f.file("oversized-measure.wav");
    let error=measure_new_track(&oversized, &|| false, &helper).unwrap_err();
    assert!(error.to_string().contains("exceeded its bound"),"{error:#}");
    assert!(source.exists());
}

#[cfg(unix)]
#[test]
fn validation_cancel_is_bounded_when_an_escaped_descendant_retains_stdout() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let source = f.file("escaped.wav");
    let helper = f.0.join("escaped-measure-fixture");
    let escaped = PathBuf::from(format!("{}.escaped-pid", source.display()));
    // This process intentionally escapes the invocation's process group. The
    // native worker must not wait for pipe EOF from it, and the fixture keeps
    // explicit ownership so even a failed assertion cannot leak it.
    struct EscapedOwner(PathBuf);
    impl Drop for EscapedOwner {
        fn drop(&mut self) {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            if let Some(pid) = fs::read_to_string(&self.0)
                .ok()
                .and_then(|s| s.parse::<i32>().ok())
                .filter(|pid| *pid > 1)
            {
                unsafe {
                    kill(pid, 9);
                }
            }
        }
    }
    let owner = EscapedOwner(escaped.clone());
    fs::write(
        &helper,
        r#"#!/usr/bin/env python3
import os, sys, time
child = os.fork()
if child == 0:
    os.setsid()
    with open(sys.argv[2] + '.escaped-pid', 'w') as ready:
        ready.write(str(os.getpid()))
    time.sleep(30)
    os._exit(0)
time.sleep(30)
"#,
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let started = Instant::now();
    let error = measure_new_track(&source, &|| escaped.exists(), &helper).unwrap_err();
    assert!(error.to_string().contains("cancelled"));
    assert!(
        started.elapsed() < Duration::from_secs(5),
        "escaped stdout held cancellation for {:?}",
        started.elapsed()
    );
    assert!(
        escaped.exists(),
        "fixture never established escaped pipe ownership"
    );
    drop(owner);
    assert!(source.exists());
}

#[cfg(unix)]
#[test]
fn validation_reaps_owned_descendants_after_the_direct_helper_exits() {
    use std::os::unix::fs::PermissionsExt;
    let f = Fixture::new();
    let source = f.file("retained.wav");
    let helper = f.0.join("retained-measure-fixture");
    let child_pid = PathBuf::from(format!("{}.descendant-pid", source.display()));
    fs::write(
        &helper,
        "#!/bin/sh\nsleep 30 &\nprintf '%s' \"$!\" > \"$2.descendant-pid\"\nexit 0\n",
    )
    .unwrap();
    fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
    let started = Instant::now();
    let error = measure_new_track(&source, &|| false, &helper).unwrap_err();
    assert!(error.to_string().contains("receipt"));
    assert!(started.elapsed() < Duration::from_secs(5));
    let pid = fs::read_to_string(child_pid).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        // An orphan zombie can await the platform reaper. It owns no live
        // execution or descriptors; only a running descendant would be a leak.
        let state = Command::new("ps")
            .args(["-o", "stat=", "-p", &pid])
            .output()
            .unwrap();
        let state = String::from_utf8_lossy(&state.stdout);
        if state.trim().is_empty() || state.trim().starts_with('Z') {
            break;
        }
        if Instant::now() >= deadline {
            unsafe extern "C" {
                fn kill(pid: i32, signal: i32) -> i32;
            }
            unsafe {
                kill(pid.parse().unwrap(), 9);
            }
            panic!("owned validation descendant remained live: {state}");
        }
        thread::sleep(Duration::from_millis(10));
    }
    assert!(source.exists());
}

#[cfg(unix)]
#[test]
fn validation_exit_peek_keeps_the_group_leader_pid_reserved_until_cleanup() {
    use std::os::unix::process::CommandExt;
    let child = Command::new("/bin/sh")
        .args(["-c", "exit 0"])
        .process_group(0)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let mut process = MeasureProcess {
        child,
        done: true,
        pid_reserved: true,
    };
    let pid = process.child.id();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if let Some(status) = process.exit_status().unwrap() {
            assert!(status.success());
            break;
        }
        assert!(Instant::now() < deadline);
        thread::sleep(Duration::from_millis(5));
    }
    // A reaping try_wait would make a subsequent waitid return ECHILD. The
    // native OS must still report this very child's exit, reserving its PID.
    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        },
        0
    );
    assert_eq!(unsafe { info.si_pid() }, pid as libc::pid_t);
    assert_eq!(info.si_code, libc::CLD_EXITED);
    assert!(process.pid_reserved);
    assert!(process.exit_status().unwrap().unwrap().success());
    drop(process);
    assert_eq!(
        unsafe {
            libc::waitid(
                libc::P_PID,
                pid as libc::id_t,
                &mut info,
                libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
            )
        },
        -1
    );
    assert_eq!(
        std::io::Error::last_os_error().raw_os_error(),
        Some(libc::ECHILD)
    );
}

fn overlay_from(
    project: &Project,
    source_dir: PathBuf,
    custom: Vec<Lane>,
    preserve_generated: bool,
) -> OpenCustomOverlay {
    let mut lanes: Vec<_> = project
        .lane_specs
        .iter()
        .filter(|lane| !lane.custom)
        .map(|lane| lane.slot)
        .collect();
    lanes.extend(custom.iter().map(|lane| lane.slot));
    OpenCustomOverlay {
        source_dir,
        preserve_generated,
        mix: crate::project_store::Mix {
            carry: Default::default(),
            metronome: project.metronome.clone(),
            beat: project.beat.clone(),
            original: project.original,
            lanes,
            custom,
            gain: project.gain,
            muted: project.muted,
            solo: project.solo,
            master: project.master,
            transpose: project.transpose,
            tempo: project.tempo,
            looping: project.looping,
            selection: Some((0., 10.)),
            view: (0., 10.),
        },
    }
}
fn saved_overlay_project(dir: &Path, custom: Value) {
    fs::create_dir(dir).unwrap();
    fs::create_dir(dir.join("stems")).unwrap();
    fs::write(dir.join("stems/vocals.wav"), b"original encoded vocals").unwrap();
    fs::write(
        dir.join("project.json"),
        serde_json::to_vec(
            &json!({"version":2,"name":"Owned handoff","settings":{"custom":custom}}),
        )
        .unwrap(),
    )
    .unwrap();
}
fn copy_overlay_project(from: &Path, to: &Path) {
    fs::create_dir(to).unwrap();
    for item in fs::read_dir(from).unwrap() {
        let item = item.unwrap();
        if item.file_type().unwrap().is_dir() {
            fs::create_dir(to.join(item.file_name())).unwrap();
            for file in fs::read_dir(item.path()).unwrap() {
                let file = file.unwrap();
                fs::copy(
                    file.path(),
                    to.join(item.file_name()).join(file.file_name()),
                )
                .unwrap();
            }
        } else {
            fs::copy(item.path(), to.join(item.file_name())).unwrap();
        }
    }
}
#[test]
fn rename_overlay_keeps_unsaved_add_remove_labels_slots_and_mix_without_metadata_write() {
    let f = Fixture::new();
    let old = f.0.join("old");
    saved_overlay_project(
        &old,
        json!([
            custom("custom-a", "stems/a.wav"),
            custom("custom-b", "stems/b.wav")
        ]),
    );
    fs::write(old.join("stems/a.wav"), b"a").unwrap();
    fs::write(old.join("stems/b.wav"), b"b").unwrap();
    let project = read_project(&old).unwrap();
    let mut kept = project
        .custom_tracks()
        .into_iter()
        .find(|lane| lane.id == "custom-b")
        .unwrap();
    kept.label = "Несохранённое имя 🎤".into();
    let external = f.file("external-added.wav");
    let added = tracks::new_custom(
        external.clone(),
        &[project.lane_specs[0].clone(), kept.clone()],
    )
    .unwrap();
    let mut overlay = overlay_from(
        &project,
        old.clone(),
        vec![kept.clone(), added.clone()],
        false,
    );
    overlay.mix.gain[kept.slot] = 0.37;
    overlay.mix.muted[kept.slot] = true;
    overlay.mix.solo[added.slot] = true;
    let renamed = f.0.join("renamed");
    fs::rename(&old, &renamed).unwrap();
    let before = fs::read(renamed.join("project.json")).unwrap();
    let restored = read_open_project_overlay(&renamed, None, Some(&overlay)).unwrap();
    assert!(
        !restored
            .custom_tracks()
            .iter()
            .any(|lane| lane.id == "custom-a")
    );
    let b = restored
        .custom_tracks()
        .into_iter()
        .find(|lane| lane.id == "custom-b")
        .unwrap();
    assert_eq!(b.slot, kept.slot);
    assert_eq!(b.label, kept.label);
    assert_eq!(b.file, renamed.join("stems/b.wav"));
    assert_eq!(restored.gain[b.slot], 0.37);
    assert!(restored.muted[b.slot]);
    assert!(restored.solo[added.slot]);
    assert_eq!(
        restored
            .lane_specs
            .iter()
            .find(|lane| lane.id == added.id)
            .unwrap()
            .file,
        external
    );
    assert_eq!(fs::read(renamed.join("project.json")).unwrap(), before);
    assert_eq!(
        restored.raw["settings"]["custom"].as_array().unwrap().len(),
        2
    );
    assert!(renamed.join("stems/a.wav").exists());
    assert_eq!(restored.lane_stamps.len(), restored.lanes.len());
}
#[test]
fn import_overlay_prefers_new_owned_paths_and_rebases_unsaved_files_inside_moved_folder() {
    for moving in [false, true] {
        let f = Fixture::new();
        let old = f.0.join("old");
        saved_overlay_project(&old, json!([custom("custom-saved", "stems/saved.wav")]));
        fs::write(old.join("stems/saved.wav"), b"saved").unwrap();
        fs::write(old.join("unsaved-picked.wav"), b"unsaved encoded source").unwrap();
        let project = read_project(&old).unwrap();
        let mut desired = project.custom_tracks();
        desired
            .push(tracks::new_custom(old.join("unsaved-picked.wav"), &project.lane_specs).unwrap());
        let overlay = overlay_from(&project, old.clone(), desired, false);
        let dest = f.0.join("library-copy");
        if moving {
            fs::rename(&old, &dest).unwrap();
        } else {
            copy_overlay_project(&old, &dest);
        }
        let restored = read_open_project_overlay(&dest, None, Some(&overlay)).unwrap();
        for lane in restored.custom_tracks() {
            assert!(lane.file.starts_with(&dest));
            assert!(lane.file.exists());
        }
        assert!(
            restored
                .custom_tracks()
                .iter()
                .any(|lane| lane.file == dest.join("unsaved-picked.wav"))
        );
        assert_eq!(old.exists(), !moving);
    }
}
#[test]
fn working_save_and_each_split_mode_keep_customs_and_only_new_generated_backing() {
    let f = Fixture::new();
    let old = f.0.join("old");
    saved_overlay_project(
        &old,
        json!([
            custom("custom-backing-vocals", "stems/backing-old.wav"),
            custom("custom-harmony", "stems/harmony-old.wav")
        ]),
    );
    fs::write(old.join("stems/backing-old.wav"), b"backing").unwrap();
    fs::write(old.join("stems/harmony-old.wav"), b"harmony").unwrap();
    let project = read_project(&old).unwrap();
    for (index, mode) in [
        None,
        Some(crate::source_jobs::Mode::Stems),
        Some(crate::source_jobs::Mode::Vocals),
        Some(crate::source_jobs::Mode::Combined),
    ]
    .into_iter()
    .enumerate()
    {
        let output = f.0.join(format!("working-{index}"));
        let mut raw_custom = vec![
            custom("custom-backing-vocals", "stems/backing-new.flac"),
            custom("custom-harmony", "stems/harmony-new.flac"),
            custom("custom-removed", "stems/removed.wav"),
        ];
        if mode.is_some_and(|mode| mode != crate::source_jobs::Mode::Stems) {
            raw_custom.push(custom("custom-backing-vocals-2", "stems/generated.wav"));
        }
        saved_overlay_project(&output, json!(raw_custom));
        for name in [
            "backing-new.flac",
            "harmony-new.flac",
            "removed.wav",
            "generated.wav",
        ] {
            fs::write(
                output.join("stems").join(name),
                b"materialized encoded audio",
            )
            .unwrap();
        }
        let mut overlay = overlay_from(
            &project,
            old.clone(),
            project.custom_tracks(),
            mode.is_some(),
        );
        for lane in &overlay.mix.custom {
            overlay.mix.gain[lane.slot] = 0.42;
            overlay.mix.muted[lane.slot] = true;
        }
        let before = fs::read(output.join("project.json")).unwrap();
        let restored = read_open_project_overlay(&output, None, Some(&overlay)).unwrap();
        let customs = restored.custom_tracks();
        assert!(!customs.iter().any(|lane| lane.id == "custom-removed"));
        let generated = mode.is_some_and(|mode| mode != crate::source_jobs::Mode::Stems);
        assert_eq!(customs.len(), if generated { 3 } else { 2 });
        assert_eq!(
            customs
                .iter()
                .any(|lane| lane.id == "custom-backing-vocals-2"),
            generated
        );
        for captured in &overlay.mix.custom {
            let lane = customs.iter().find(|lane| lane.id == captured.id).unwrap();
            assert_eq!(lane.slot, captured.slot);
            assert_eq!(restored.gain[lane.slot], 0.42);
            assert!(restored.muted[lane.slot]);
            assert!(lane.file.starts_with(&output));
        }
        assert_eq!(fs::read(output.join("project.json")).unwrap(), before);
    }
}
#[test]
fn overlay_attaches_valid_unsaved_custom_before_saved_missing_audio_refusal() {
    let f = Fixture::new();
    f.file("stems/a.wav");
    f.project(json!([custom("custom-a", "stems/a.wav")]));
    let project = read_project(&f.0).unwrap();
    let added = f.file("b.wav");
    let lane = tracks::new_custom(added.clone(), &[]).unwrap();
    let overlay = overlay_from(&project, f.0.clone(), vec![lane.clone()], false);
    fs::remove_file(f.0.join("stems/a.wav")).unwrap();
    assert!(read_project(&f.0).is_err());
    let restored = read_open_project_overlay(&f.0, None, Some(&overlay)).unwrap();
    assert_eq!(restored.lanes.len(), 1);
    assert_eq!(restored.lane_id(lane.slot), Some(lane.id.as_str()));
    assert_eq!(restored.lanes[0].1, added);
}
#[test]
fn overlay_rejects_missing_linked_traversal_duplicate_or_reserved_desired_paths() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let project = read_project(&f.0).unwrap();
    let file = f.file("picked.wav");
    let lane = tracks::new_custom(file.clone(), &project.lane_specs).unwrap();
    for bad in [
        PathBuf::from("relative.wav"),
        f.0.join("../foreign.wav"),
        f.0.join("missing.wav"),
    ] {
        let mut lane = lane.clone();
        lane.file = bad;
        let overlay = overlay_from(&project, f.0.clone(), vec![lane], false);
        assert!(read_open_project_overlay(&f.0, None, Some(&overlay)).is_err());
    }
    let duplicate = overlay_from(
        &project,
        f.0.clone(),
        vec![lane.clone(), lane.clone()],
        false,
    );
    assert!(read_open_project_overlay(&f.0, None, Some(&duplicate)).is_err());
    let mut reserved = lane.clone();
    reserved.id = "vocals".into();
    assert!(
        read_open_project_overlay(
            &f.0,
            None,
            Some(&overlay_from(&project, f.0.clone(), vec![reserved], false))
        )
        .is_err()
    );
    #[cfg(unix)]
    {
        let linked = f.0.join("linked.wav");
        std::os::unix::fs::symlink(file, &linked).unwrap();
        let mut lane = lane;
        lane.file = linked;
        assert!(
            read_open_project_overlay(
                &f.0,
                None,
                Some(&overlay_from(&project, f.0.clone(), vec![lane], false))
            )
            .is_err()
        );
    }
}
#[test]
fn same_epoch_analysis_restart_has_new_identity_and_cancelled_result_cannot_escape() {
    let f = Fixture::new();
    f.file("stems/vocals.wav");
    f.project(json!([]));
    let project = read_project(&f.0).unwrap();
    let (events, receipts) = mpsc::channel();
    let latest = Arc::new(AtomicU64::new(41));
    let alive = Arc::new(AtomicBool::new(true));
    let (release, wait) = mpsc::channel();
    let progress_events = events.clone();
    let (old, old_cancel) = spawn_analysis_with(
        project.clone(),
        41,
        events.clone(),
        latest.clone(),
        alive.clone(),
        move |_, epoch, _, _, job_id| {
            progress_events
                .send(Event::AnalysisProgress(epoch, job_id, 0.7))
                .unwrap();
            wait.recv_timeout(Duration::from_secs(5)).unwrap();
            Ok(crate::project_analysis::Output {
                melody: Some(json!({"scope":"cancelled analysis fixture"})),
                ..Default::default()
            })
        },
    );
    let Event::AnalysisStarted(epoch, first) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("missing first start")
    };
    assert_eq!(epoch, 41);
    let Event::AnalysisProgress(_, progress_id, p) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("missing first progress")
    };
    assert_eq!(progress_id, first);
    assert_eq!(p, 0.7);
    let cancellation = old_cancel.clone();
    let release_when_cancelled = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(5);
        while cancellation.load(Ordering::Acquire) {
            assert!(Instant::now() < deadline);
            thread::yield_now();
        }
        release.send(()).unwrap();
    });
    let mut old = Some(old);
    let mut old_cancel = Some(old_cancel);
    stop_analysis_for_epoch(&mut old, &mut old_cancel, &events, 41);
    release_when_cancelled.join().unwrap();
    assert!(old.is_none() && old_cancel.is_none());
    assert!(matches!(
        receipts.recv_timeout(Duration::from_secs(5)).unwrap(),
        Event::AnalysisStopped(41)
    ));
    assert!(
        receipts.try_recv().is_err(),
        "cancelled old result escaped after stop"
    );
    let progress_events = events.clone();
    let (new, new_cancel) = spawn_analysis_with(
        project,
        41,
        events,
        latest,
        alive,
        move |_, epoch, _, _, job_id| {
            progress_events
                .send(Event::AnalysisProgress(epoch, job_id, 0.1))
                .unwrap();
            Ok(crate::project_analysis::Output {
                melody: Some(json!({"scope":"actual restart lifecycle fixture; no inference claim"})),
                ..Default::default()
            })
        },
    );
    let Event::AnalysisStarted(epoch, second) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("missing restart start")
    };
    assert_eq!(epoch, 41);
    assert!(second > first);
    let Event::AnalysisProgress(_, progress_id, p) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("missing restart progress")
    };
    assert_eq!(progress_id, second);
    assert_eq!(p, 0.1);
    let Event::Analyzed(_, result_id, result) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("missing restart result")
    };
    assert_eq!(result_id, second);
    assert!(result.is_ok());
    new_cancel.store(false, Ordering::Release);
    new.join().unwrap();
}

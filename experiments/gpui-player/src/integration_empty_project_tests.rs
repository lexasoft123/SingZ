use super::*;
use serde_json::json;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "singz-empty-project-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("stems")).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn write(&self, value: &Value) {
        fs::write(
            self.0.join("project.json"),
            serde_json::to_vec(value).unwrap(),
        )
        .unwrap();
    }
    fn empty(&self) {
        self.write(&json!({"version":2,"songFile":"old.wav","settings":{"nativeEmptyTracks":true,"custom":[]},"foreign":"kept"}));
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn packet() -> Value {
    json!({"protocol":1,"ok":true,"emptyProject":true,"trainingOnly":false,"laneSetRevision":1,"graphGeneration":0,"state":0,"duration":0,"position":0,"playing":false,"physicalOutputReleased":true,"lanes":[],"laneIds":[],"laneDurations":[],"peaks":[],"cleanupProof":{"neverClaimed":true,"globallyComplete":false,"generation":0,"handoffLease":0,"physicalOwnershipRetained":false,"retainedBytes":0,"parkedLaneBytes":0,"quarantineBytes":0,"quarantinePoisoned":false},"cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":false,"cueOutputLatencyMs":0,"cueNotes":[]})
}
fn mix() -> crate::project_store::Mix {
    crate::project_store::Mix {
        carry: Default::default(),
        metronome: Default::default(),
        beat: None,
        original: false,
        lanes: vec![],
        custom: vec![],
        gain: [1.; crate::tracks::LANE_SLOTS],
        muted: [false; crate::tracks::LANE_SLOTS],
        solo: [false; crate::tracks::LANE_SLOTS],
        master: 1.,
        transpose: 0,
        tempo: 1.,
        looping: false,
        selection: Some((0., 0.)),
        view: (0., 0.),
    }
}
#[test]
fn explicit_empty_reads_without_audio_and_has_true_zero_manifest() {
    let f = Fixture::new();
    f.empty();
    let p = read_project(&f.0).unwrap();
    assert!(p.empty_tracks);
    assert!(!p.has_audio());
    assert!(native_lane_sources(&p).unwrap().is_empty());
    assert_eq!(lane_transaction(&p).unwrap(), vec!["lanes-begin 0"]);
    assert_eq!(p.raw["foreign"], "kept");
}
#[test]
fn explicit_empty_does_not_resurrect_incidental_old_audio() {
    let f = Fixture::new();
    f.empty();
    fs::write(f.0.join("old.wav"), b"old").unwrap();
    fs::write(f.0.join("stems/vocals.wav"), b"old").unwrap();
    let p = read_project(&f.0).unwrap();
    assert!(p.lanes.is_empty());
    assert!(!p.original);
}
#[test]
fn missing_legacy_audio_is_not_empty_intent() {
    let f = Fixture::new();
    f.write(&json!({"version":2,"songFile":"missing.wav","settings":{"custom":[]}}));
    assert!(read_project(&f.0).is_err());
}
#[test]
fn contradictory_empty_custom_metadata_is_rejected() {
    let f = Fixture::new();
    for custom in [Value::Null, json!([{"id":"custom-x"}]), json!({})] {
        f.write(&json!({"version":2,"settings":{"nativeEmptyTracks":true,"custom":custom}}));
        assert!(read_project(&f.0).is_err());
    }
}
#[test]
fn typed_empty_overlay_removes_saved_audio_without_mutating_metadata() {
    let f = Fixture::new();
    f.write(&json!({"version":2,"songFile":"old.wav","settings":{"custom":[]}}));
    fs::write(f.0.join("old.wav"), b"fixture").unwrap();
    let before = fs::read(f.0.join("project.json")).unwrap();
    let overlay = OpenCustomOverlay {
        source_dir: f.0.clone(),
        mix: mix(),
        preserve_generated: false,
    };
    let p = read_project_mode_overlay(&f.0, true, Some(&overlay)).unwrap();
    assert!(p.empty_tracks);
    assert!(p.lanes.is_empty());
    assert_eq!(before, fs::read(f.0.join("project.json")).unwrap());
}
#[test]
fn strict_empty_status_requires_zero_vectors_revision_and_cleanup() {
    let good = packet();
    assert!(Status::parse(&good).unwrap().empty_project);
    for (key, value) in [
        ("lanes", json!([{}])),
        ("laneIds", json!(["old"])),
        ("laneDurations", json!([1.])),
        ("peaks", json!([[0.]])),
        ("laneSetRevision", json!(0)),
        ("graphGeneration", json!(7)),
        ("duration", json!(1.)),
        ("trainingOnly", json!(true)),
        ("physicalOutputReleased", json!(false)),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(Status::parse(&bad).is_err(), "accepted malformed {key}");
    }
    let mut bad = good;
    bad["cleanupProof"]["retainedBytes"] = json!(1);
    assert!(Status::parse(&bad).is_err());
}
#[test]
fn retired_empty_requires_real_completed_generation_and_lease() {
    let mut p = packet();
    p["cleanupProof"]["neverClaimed"] = json!(false);
    assert!(Status::parse(&p).is_err());
    p["cleanupProof"]["globallyComplete"] = json!(true);
    p["cleanupProof"]["generation"] = json!(9);
    p["cleanupProof"]["handoffLease"] = json!(11);
    assert!(Status::parse(&p).is_ok());
    p["cleanupProof"]["quarantinePoisoned"] = json!(true);
    assert!(Status::parse(&p).is_err());
}
#[test]
fn lane_revision_rejects_late_nonempty_status_after_empty_commit() {
    let mut old = packet();
    old["emptyProject"] = json!(false);
    old["duration"] = json!(3);
    old["laneSetRevision"] = json!(4);
    let old = Status::parse(&old).unwrap();
    let mut empty = packet();
    empty["laneSetRevision"] = json!(5);
    let empty = Status::parse(&empty).unwrap();
    let mut accepted = 4;
    admit_lane_revision(&mut accepted, &empty).unwrap();
    assert!(admit_lane_revision(&mut accepted, &old).is_err());
    assert_eq!(accepted, 5);
}
#[test]
fn failed_add_leaves_accepted_empty_manifest_unchanged() {
    let f = Fixture::new();
    f.empty();
    let p = read_project(&f.0).unwrap();
    let mut requested = p.clone();
    assert!(
        prevalidate_new_tracks_using(
            &mut requested,
            &[],
            &[f.0.join("bad.wav")],
            &|| false,
            |_, _| bail!("decoder refused")
        )
        .is_err()
    );
    assert!(p.empty_tracks);
    assert!(p.lanes.is_empty());
    assert!(native_lane_sources(&p).unwrap().is_empty());
}
#[test]
fn valid_add_from_empty_clears_intent_and_final_remove_restores_it() {
    let f = Fixture::new();
    f.empty();
    let file = f.0.join("new.wav");
    fs::write(&file, b"encoded fixture").unwrap();
    let mut p = read_project(&f.0).unwrap();
    prevalidate_new_tracks_using(&mut p, &[], &[file], &|| false, |p, _| Ok(p.to_path_buf()))
        .unwrap();
    prepare_lane_candidate(&mut p, &[], &[], &|| false).unwrap();
    assert!(p.has_audio());
    let previous = p.lane_specs.clone();
    let stamps = p.lane_stamps.clone();
    p.lane_specs.clear();
    prepare_lane_candidate(&mut p, &previous, &stamps, &|| false).unwrap();
    assert!(p.empty_tracks);
    assert!(p.lanes.is_empty());
}
#[test]
fn refused_empty_publication_does_not_replace_disk_or_restore_removed_lanes() {
    let f = Fixture::new();
    f.empty();
    let mut p = read_project(&f.0).unwrap();
    let expected = p.metadata_hash.clone();
    f.write(
        &json!({"version":2,"settings":{"nativeEmptyTracks":true,"custom":[]},"external":true}),
    );
    let value = crate::project_store::update_mix(p.raw.clone(), &mix()).unwrap();
    assert!(crate::project_store::commit_custom(&f.0, &expected, &value, &[], &|| false).is_err());
    assert_eq!(read_project(&f.0).unwrap().raw["external"], true);
    assert!(p.empty_tracks);
    p.looping = false;
    assert!(native_lane_sources(&p).unwrap().is_empty());
}
#[test]
fn standalone_cue_can_own_shared_output_without_creating_empty_audio_graph() {
    let mut p = packet();
    p["physicalOutputReleased"] = json!(false);
    p["baseHostState"] = json!(2);
    p["baseCallbacks"] = json!(4);
    p["cueGeneration"] = json!(7);
    p["cueStartHostNs"] = json!("100");
    p["cueEndHostNs"] = json!("550000100");
    // Actual native cue receipts retain their note timeline even after the
    // shared service completes playback; a nonzero clock with no notes is
    // correctly rejected by training_audio::Status::parse.
    p["cueActive"] = json!(true);
    p["cueNotes"] = json!([{"midi":60,"cueIndex":0,"start":0,"end":0.55}]);
    let status = Status::parse(&p).expect("native-shaped standalone cue receipt");
    assert!(status.empty_project && status.cue.active);
    p["cueActive"] = json!(false);
    p["baseCallbacks"] = json!(0);
    assert!(Status::parse(&p).is_ok());
    p["cleanupProof"]["globallyComplete"] = json!(false);
    p["cleanupProof"]["neverClaimed"] = json!(false);
    assert!(Status::parse(&p).is_err());
}
#[test]
fn empty_saved_then_typed_add_does_not_resurrect_retained_original() {
    let f = Fixture::new();
    f.empty();
    fs::write(f.0.join("old.wav"), b"old").unwrap();
    let file = f.0.join("new.wav");
    fs::write(&file, b"new").unwrap();
    let lane = crate::tracks::new_custom(file, &[]).unwrap();
    let mut m = mix();
    m.lanes = vec![lane.slot];
    m.custom = vec![lane];
    let overlay = OpenCustomOverlay {
        source_dir: f.0.clone(),
        mix: m,
        preserve_generated: false,
    };
    let p = read_project_mode_overlay(&f.0, true, Some(&overlay)).unwrap();
    assert!(p.has_audio());
    assert!(!p.original);
    assert_eq!(p.lanes.len(), 1);
}
#[test]
fn empty_open_retains_metronome_intent_and_fresh_add_applies_it_once() {
    let f = Fixture::new();
    f.empty();
    let mut p = read_project(&f.0).unwrap();
    p.metronome.click = true;
    let mut calls = 0;
    assert!(
        configure_fresh_graph(true, &p, |_| {
            calls += 1;
            Ok(Status::parse(&packet()).unwrap())
        })
        .unwrap_or_else(|_| panic!("empty configuration should skip"))
        .is_none()
    );
    assert_eq!(calls, 0);
    let file = f.0.join("new.wav");
    fs::write(&file, b"new").unwrap();
    prevalidate_new_tracks_using(&mut p, &[], &[file], &|| false, |p, _| Ok(p.to_path_buf()))
        .unwrap();
    prepare_lane_candidate(&mut p, &[], &[], &|| false).unwrap();
    let expected = crate::beat::commands(&p.metronome, p.beat.as_ref()).unwrap();
    let configured = configure_fresh_graph(true, &p, |commands| {
        calls += 1;
        assert_eq!(commands, expected);
        Ok(Status::parse(&packet()).unwrap())
    });
    assert!(matches!(configured, Ok(Some(_))));
    assert_eq!(calls, 1);
    assert!(matches!(
        configure_fresh_graph(false, &p, |_| panic!(
            "existing graph must preserve settings"
        )),
        Ok(None)
    ));
}
#[test]
fn fresh_add_metronome_failure_is_known_committed_and_keeps_candidate() {
    let f = Fixture::new();
    f.empty();
    let file = f.0.join("new.wav");
    fs::write(&file, b"new").unwrap();
    let mut p = read_project(&f.0).unwrap();
    prevalidate_new_tracks_using(&mut p, &[], &[file], &|| false, |p, _| Ok(p.to_path_buf()))
        .unwrap();
    prepare_lane_candidate(&mut p, &[], &[], &|| false).unwrap();
    let ids = p.lane_specs.clone();
    let result = configure_fresh_graph(true, &p, |_| bail!("configuration transport lost"));
    assert!(
        matches!(result,Err(LaneReplaceFailure::Committed(message))if message.contains("configuration transport lost"))
    );
    assert!(p.has_audio());
    assert_eq!(p.lane_specs, ids);
}
#[test]
fn persisted_empty_and_original_disabled_flags_refuse_nonboolean_values() {
    let f = Fixture::new();
    fs::write(f.0.join("old.wav"), b"old").unwrap();
    for key in ["nativeEmptyTracks", "nativeOriginalDisabled"] {
        for invalid in [json!("true"), json!(1), Value::Null, json!([]), json!({})] {
            let mut raw = json!({"version":2,"songFile":"old.wav","settings":{"custom":[]}});
            raw["settings"][key] = invalid;
            f.write(&raw);
            let error = read_project(&f.0).unwrap_err().to_string();
            assert!(error.contains(key), "wrong refusal for {key}: {error}");
        }
    }
    f.write(&json!({"version":2,"songFile":"old.wav","settings":{"nativeEmptyTracks":false,"nativeOriginalDisabled":false,"custom":[]}}));
    assert!(read_project(&f.0).unwrap().original);
    f.write(&json!({"version":2,"songFile":"old.wav","settings":{"nativeEmptyTracks":false,"nativeOriginalDisabled":true,"custom":[]}}));
    assert!(read_project(&f.0).is_err());
}

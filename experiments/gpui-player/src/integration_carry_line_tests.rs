use super::*;
use serde_json::json;
fn plan() -> crate::carry_line::Plan {
    crate::carry_line::Plan::capture(
        crate::carry_line::Desired {
            enabled: true,
            config: Default::default(),
        },
        &[crate::tracks::Lane {
            slot: 0,
            id: "vocals".into(),
            label: "Vocals".into(),
            color: "#abcdef".into(),
            file: "/fixture/vocals.wav".into(),
            custom: false,
        }],
        None,
        10.,
        true,
    )
    .unwrap()
}
fn receipt() -> Value {
    json!({"protocol":1,"ok":true,"carryCommitted":true,"carryEnabled":true,"carryRequested":true,"carryMode":0,"carryPeriod":10,"carryLaneIds":["vocals"],"carryWindows":[],"carryRevision":2,"laneSetRevision":1,"graphGeneration":3,"duration":10,"position":2,"playing":true,"cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":false,"cueOutputLatencyMs":0,"cueNotes":[]})
}
#[test]
fn actual_carry_receipt_adopts_only_matching_schedule() {
    let p = plan();
    let status = carry_reply(receipt(), &p).unwrap_or_else(|_| panic!("matching receipt refused"));
    assert_eq!(status.carry_revision, 2);
    assert!(status.playing);
    for (key, value) in [
        ("carryLaneIds", json!(["bass"])),
        ("carryRequested", json!(false)),
        ("carryEnabled", json!(false)),
        ("carryPeriod", json!(20)),
        ("carryRevision", json!(0)),
    ] {
        let mut bad = receipt();
        bad[key] = value;
        assert!(
            matches!(carry_reply(bad, &p), Err(LaneReplaceFailure::Committed(_))),
            "accepted mismatched {key}"
        );
    }
}
#[test]
fn explicit_refusal_preserves_old_graph_but_unknown_apply_is_committed() {
    let p = plan();
    assert!(
        matches!(carry_reply(json!({"protocol":1,"ok":false,"carryCommitted":false,"error":"invalid plan"}),&p),Err(LaneReplaceFailure::Refused(message))if message=="invalid plan")
    );
    assert!(
        matches!(carry_reply(json!({"protocol":1,"ok":false,"carryCommitted":true,"error":"settlement failure"}),&p),Err(LaneReplaceFailure::Committed(message))if message.contains("settlement failure"))
    );
    assert!(matches!(
        carry_reply(json!({"ok":false}), &p),
        Err(LaneReplaceFailure::Committed(_))
    ));
}
#[test]
fn late_same_epoch_carry_status_cannot_revert_new_revision() {
    let mut current = 2;
    let mut old = receipt();
    old["carryRevision"] = json!(1);
    let old = Status::parse(&old).unwrap();
    assert!(admit_carry_revision(&mut current, &old).is_err());
    assert_eq!(current, 2);
    let newer = Status::parse(&receipt()).unwrap();
    admit_carry_revision(&mut current, &newer).unwrap();
}
#[test]
fn accepted_off_can_preserve_native_schedule_fields_without_enabling_it() {
    let mut p = plan();
    p.on = false;
    p.desired.enabled = false;
    p.lane_ids.clear();
    let mut value = receipt();
    value["carryRequested"] = json!(false);
    value["carryEnabled"] = json!(false);
    assert!(carry_reply(value, &p).is_ok());
}
#[test]
fn empty_synced_windows_remain_native_off_and_keep_desired_lines() {
    let mut p = plan();
    p.mode = 1;
    p.windows.clear();
    p.desired.config.mode = crate::carry_line::Mode::Lines;
    let mut v = receipt();
    v["carryMode"] = json!(1);
    v["carryEnabled"] = json!(false);
    assert!(carry_reply(v, &p).is_ok());
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "singz-carry-reader-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(p.join("stems")).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn write(&self, raw: Value) {
        fs::write(
            self.0.join("project.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn reader_accepts_previously_refused_saved_training_and_preserves_raw() {
    let f = Fixture::new();
    fs::write(f.0.join("stems/vocals.wav"), b"encoded fixture").unwrap();
    let raw = json!({"version":2,"settings":{"training":{"on":true,"mode":"lines","periodSec":25,"hear":2,"sing":3,"stems":["vocals"],"future":"preserve"}}});
    f.write(raw.clone());
    let p = read_project(&f.0).unwrap();
    assert!(p.carry.enabled);
    assert_eq!(p.carry.config.mode, crate::carry_line::Mode::Lines);
    assert_eq!(p.carry.config.period_sec, 25);
    assert_eq!(p.raw, raw);
}
#[test]
fn reopen_enabled_carry_preserves_saved_manual_guide_mute_and_gain() {
    let f = Fixture::new();
    fs::write(f.0.join("stems/vocals.wav"), b"encoded fixture").unwrap();
    f.write(json!({"version":2,"settings":{"tracks":{"vocals":{"muted":true,"solo":true,"volume":0.37}},"training":{"on":true,"mode":"time","periodSec":10,"stems":["vocals"]}}}));
    let project = read_project(&f.0).unwrap();
    assert!(project.carry.enabled);
    assert!(project.muted[0]);
    assert!(project.solo[0]);
    assert!((project.gain[0] - 0.37).abs() < 0.000001);
    let plan = crate::carry_line::Plan::capture(
        project.carry.clone(),
        &project.lane_specs,
        None,
        10.,
        !project.original,
    )
    .unwrap();
    assert_eq!(
        plan.restore_commands().unwrap()[0],
        "carry-begin 1 0 10 1 0 0"
    );
    assert!(project.muted[0]);
}
#[test]
fn fatal_native_output_in_explicit_precommit_refusal_disconnects_instead_of_claiming_playback() {
    let p = plan();
    for state in [6, 7] {
        let packet = json!({"protocol":1,"ok":false,"carryCommitted":false,"state":state,"error":"output route failed"});
        assert!(
            matches!(carry_reply(packet,&p),Err(LaneReplaceFailure::Disconnected(message))if message.contains("output route failed"))
        );
    }
    for state in [0, 1, 2, 3, 4, 5] {
        let packet = json!({"protocol":1,"ok":false,"carryCommitted":false,"state":state,"error":"candidate refused"});
        assert!(
            matches!(carry_reply(packet,&p),Err(LaneReplaceFailure::Refused(message))if message=="candidate refused")
        );
    }
}
#[test]
fn fatal_native_output_after_irreversible_carry_arm_remains_committed() {
    let p = plan();
    for state in [6, 7] {
        let mut packet = receipt();
        packet["state"] = json!(state);
        packet["ok"] = json!(false);
        packet["error"] = json!("post-arm settlement failed");
        assert!(
            matches!(carry_reply(packet,&p),Err(LaneReplaceFailure::Committed(message))if message.contains("post-arm settlement failed"))
        );
    }
}
#[test]
fn durable_empty_open_skips_graph_carry_restore_but_retains_saved_config() {
    let f = Fixture::new();
    f.write(json!({"version":2,"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[],"training":{"on":true,"mode":"lines","periodSec":25,"hear":2,"sing":3,"stems":["custom-guide"]}}}));
    let mut p = read_project(&f.0).unwrap();
    let config = p.carry.config.clone();
    assert!(p.carry.enabled);
    assert!(open_carry_plan(&mut p, 0.).unwrap().is_none());
    assert!(!p.carry.enabled);
    assert_eq!(p.carry.config, config);
    assert!(p.empty_tracks);
    assert!(p.lanes.is_empty());
}
#[test]
fn nonempty_disabled_carry_restore_remains_a_real_native_transaction() {
    let f = Fixture::new();
    fs::write(f.0.join("stems/vocals.wav"), b"encoded fixture").unwrap();
    f.write(json!({"version":2,"settings":{"training":{"mode":"lines","periodSec":25}}}));
    let mut p = read_project(&f.0).unwrap();
    let restore = open_carry_plan(&mut p, 10.)
        .unwrap()
        .expect("audio graph must restore its disabled schedule");
    assert!(!restore.on);
    assert_eq!(restore.desired.config.period_sec, 25);
    assert_eq!(
        restore.restore_commands().unwrap()[0],
        "carry-begin 0 0 25 0 0 0"
    );
}
#[test]
fn missing_audio_without_explicit_empty_intent_cannot_skip_restore() {
    let f = Fixture::new();
    fs::write(f.0.join("stems/vocals.wav"), b"encoded fixture").unwrap();
    f.write(json!({"version":2,"settings":{}}));
    let mut p = read_project(&f.0).unwrap();
    p.lanes.clear();
    p.lane_specs.clear();
    assert!(open_carry_plan(&mut p, 0.).is_err());
}

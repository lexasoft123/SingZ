use super::*;
use serde_json::json;
fn packet() -> Value {
    json!({"protocol":1,"ok":true,"state":3,"duration":10,"position":2,"playing":true,"graphGeneration":7,"laneSetRevision":2,"carryRevision":3,"playbackRate":1,"transpose":0,"laneIds":["vocals"],"lanes":[{"id":"vocals","gain":0.5,"muted":false,"solo":false}],"masterGain":0.7,"referenceGain":0.3,"outputUid":"fake","cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":false,"cueOutputLatencyMs":0,"cueNotes":[]})
}
#[test]
fn accepted_rate_requires_actual_pair_inventory_and_mixer() {
    let before = packet();
    let mut after = before.clone();
    after["playbackRate"] = json!(1.25);
    after["transpose"] = json!(2);
    after["graphGeneration"] = json!(8);
    assert!(accepted_rate(&before, &after, 1.25, 2).is_ok());
    for (key, value) in [
        ("playbackRate", json!(1.2)),
        ("transpose", json!(3)),
        ("laneSetRevision", json!(9)),
        ("carryRevision", json!(9)),
        ("lanes", json!([])),
        ("masterGain", json!(1.)),
    ] {
        let mut bad = after.clone();
        bad[key] = value;
        assert!(accepted_rate(&before, &bad, 1.25, 2).is_err(), "{key}");
    }
}
#[test]
fn live_lane_counters_do_not_count_as_a_changed_lane_inventory() {
    let mut before = packet();
    before["lanes"][0]["streamed"] = json!(true);
    before["lanes"][0]["starvedBlocks"] = json!(0);
    before["lanes"][0]["stagedJumps"] = json!(1);
    let mut after = before.clone();
    after["playbackRate"] = json!(1.25);
    after["lanes"][0]["starvedBlocks"] = json!(2);
    after["lanes"][0]["stagedJumps"] = json!(5);
    assert!(accepted_rate(&before, &after, 1.25, 0).is_ok());
    assert!(retained_rate(&before, &{let mut kept = before.clone();kept["lanes"][0]["stagedJumps"] = json!(9);kept}).is_ok());
    for (field, value) in [("gain", json!(0.4)), ("muted", json!(true)), ("streamed", json!(false)), ("id", json!("bass"))] {
        let mut bad = after.clone();
        bad["lanes"][0][field] = value;
        assert!(accepted_rate(&before, &bad, 1.25, 0).is_err(), "{field}");
    }
}
#[test]
fn refusal_recovery_requires_real_success_status_and_same_owned_graph() {
    let before = packet();
    let mut after = before.clone();
    after["position"] = json!(2.1);
    assert!(retained_rate(&before, &after).is_ok());
    for (key, value) in [
        ("ok", json!(false)),
        ("state", json!(6)),
        ("graphGeneration", json!(8)),
        ("playbackRate", json!(1.1)),
        ("transpose", json!(1)),
        ("carryRevision", json!(4)),
        ("lanes", json!([])),
        ("outputUid", json!("other")),
    ] {
        let mut bad = after.clone();
        bad[key] = value;
        assert!(retained_rate(&before, &bad).is_err(), "{key}");
    }
}
#[test]
fn rejected_command_payload_is_not_an_accepted_receipt() {
    let mut rejected = packet();
    rejected["ok"] = json!(false);
    rejected["error"] = json!("rate prepare refused");
    assert!(Status::parse(&rejected).is_err());
    assert!(Status::reported(&rejected).is_ok());
    rejected["state"] = json!(7);
    assert!(Status::reported(&rejected).is_err());
}
#[test]
fn parsed_countin_clock_requires_consistent_real_playing_role() {
    let mut v = packet();
    v["countingIn"] = json!(true);
    v["renderedProjectFrame"] = json!(-48000);
    v["countInHeard"] = json!({"secondsToLanding":-1.,"landingSeconds":2.,"total":4,"perBar":4,"preRollSeconds":2.});
    assert!(Status::parse(&v).unwrap().count_in_heard.is_some());
    for (key, value) in [
        ("playing", json!(false)),
        ("countingIn", json!(false)),
        ("trainingOnly", json!(true)),
    ] {
        let mut bad = v.clone();
        bad[key] = value;
        assert!(Status::parse(&bad).is_err(), "{key}");
    }
}
#[test]
fn typed_playback_accepts_only_exact_transport_commands() {
    for command in ["play", "pause", "play-flat"] {
        validate_playback_command(command).unwrap();
    }
    for command in [
        "",
        "play ",
        " play",
        "play\npause",
        "seek 0",
        "rate 1 0",
        "PLAY",
        "quit",
    ] {
        assert!(validate_playback_command(command).is_err(), "{command:?}");
    }
}
#[test]
fn actual_playback_receipts_keep_request_identity_across_reordered_sample_times() {
    let (events, receipts) = mpsc::channel();
    let telemetry = Mutex::new(None);
    let mut play = Status::parse(&packet()).unwrap();
    let mut paused = play.clone();
    paused.playing = false;
    let mut newest = play.clone();
    play.sampled_at = Instant::now();
    newest.sampled_at = play
        .sampled_at
        .checked_sub(Duration::from_millis(1))
        .unwrap();
    publish_playback_receipt(&events, &telemetry, 7, 10, play);
    publish_playback_receipt(&events, &telemetry, 7, 11, paused);
    publish_playback_receipt(&events, &telemetry, 7, 12, newest);
    for (serial, playing) in [(10, true), (11, false), (12, true)] {
        let Event::Playback(epoch, receipt_serial, status) = receipts.recv().unwrap() else {
            panic!("ordinary telemetry must not replace a typed acknowledgement")
        };
        assert_eq!(epoch, 7);
        assert_eq!(receipt_serial, serial);
        assert_eq!(status.playing, playing);
    }
    assert!(receipts.try_recv().is_err());
    assert!(telemetry.lock().unwrap().as_ref().unwrap().1.playing);
}

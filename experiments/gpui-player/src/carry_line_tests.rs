use super::*;
fn line(s: f32, e: f32) -> crate::project_lyrics::Line {
    crate::project_lyrics::Line {
        text: "line".into(),
        start: s,
        end: e,
        words: vec![],
    }
}
fn lane(id: &str) -> crate::tracks::Lane {
    crate::tracks::Lane {
        slot: 0,
        id: id.into(),
        label: id.into(),
        color: "#abcdef".into(),
        file: PathBuf::from("/fixture/audio.wav"),
        custom: false,
    }
}
#[test]
fn defaults_and_saved_enabled_are_exact() {
    assert_eq!(Config::sanitize(&Value::Null), Config::default());
    assert_eq!(Desired::from_settings(&json!({"on":"true"})).enabled, false);
    assert!(Desired::from_settings(&json!({"on":true})).enabled);
}
#[test]
fn javascript_number_coercion_rounding_and_clamping_match_source() {
    let vectors = vec![
        (json!({"periodSec":null,"hear":true,"sing":"8.8"}), 5, 1, 8),
        (
            json!({"periodSec":"0x20","hear":["2.5"],"sing":[]}),
            32,
            3,
            1,
        ),
        (
            json!({"periodSec":{},"hear":"nonsense","sing":-50}),
            10,
            1,
            1,
        ),
        (json!({"periodSec":61.2,"hear":9,"sing":2.49}), 60, 8, 2),
        (
            json!({"periodSec":"\u{feff}15\u{feff}","hear":"\u{85}2\u{85}"}),
            15,
            1,
            1,
        ),
    ];
    for (raw, p, h, s) in vectors {
        let c = Config::sanitize(&raw);
        assert_eq!((c.period_sec, c.hear, c.sing), (p, h, s), "{raw}");
    }
}
#[test]
fn stored_stem_strings_preserve_source_duplicates_empty_and_custom_ids() {
    let c = Config::sanitize(
        &json!({"mode":"lines","stems":["vocals",null,4,"","vocals","custom-me"]}),
    );
    assert_eq!(c.mode, Mode::Lines);
    assert_eq!(c.stems, ["vocals", "", "vocals", "custom-me"]);
    assert_eq!(
        Config::sanitize(&json!({"stems":[null,4]})).stems,
        ["vocals"]
    );
}
#[test]
fn training_windows_use_next_heard_start_and_150ms_breath() {
    let lines = vec![
        line(0., 2.),
        line(3., 3.5),
        line(6., 7.),
        line(9., 9.1),
        line(12., 13.),
    ];
    let w = training_windows(&lines, 1, 2, 20.);
    assert_eq!(
        w,
        vec![Window { s: 2.85, e: 8.85 }, Window { s: 11.85, e: 20. }]
    );
}
#[test]
fn window_ends_do_not_cut_estimated_words_short() {
    let lines = vec![line(0., 1.), line(2., 2.1), line(10., 11.)];
    let w = training_windows(&lines, 1, 1, 12.);
    assert_eq!(w, vec![Window { s: 1.85, e: 9.85 }]);
}
#[test]
fn one_heard_line_has_empty_windows_not_time_fallback() {
    let desired = Desired {
        enabled: true,
        config: Config {
            mode: Mode::Lines,
            ..Default::default()
        },
    };
    let plan = Plan::capture(desired, &[lane("vocals")], Some(&[line(0., 1.)]), 2., true).unwrap();
    assert!(plan.on);
    assert_eq!(plan.mode, 1);
    assert!(plan.windows.is_empty());
    assert!(plan.commands().unwrap()[0].starts_with("carry-begin 1 1 "));
}
#[test]
fn unsynced_or_empty_lyrics_fall_back_to_timer_and_eligible_ids_only() {
    let desired = Desired {
        enabled: true,
        config: Config {
            mode: Mode::Lines,
            stems: vec!["missing".into(), "vocals".into(), "vocals".into()],
            ..Default::default()
        },
    };
    for lines in [None, Some([].as_slice())] {
        let plan = Plan::capture(desired.clone(), &[lane("vocals")], lines, 20., true).unwrap();
        assert_eq!(plan.mode, 0);
        assert_eq!(plan.period_sec, 10.);
        assert_eq!(plan.lane_ids, ["vocals"]);
        assert_eq!(plan.desired.config.stems.len(), 3);
    }
}
#[test]
fn off_or_unsplit_or_zero_audio_produces_disabled_native_plan() {
    let desired = Desired {
        enabled: true,
        config: Config {
            mode: Mode::Lines,
            ..Default::default()
        },
    };
    let p = Plan::capture(
        desired.clone(),
        &[lane("original")],
        Some(&[line(100., 101.)]),
        0.,
        false,
    )
    .unwrap();
    assert!(!p.on);
    assert!(p.windows.is_empty());
    assert!(p.lane_ids.is_empty());
    assert_eq!(p.mode, 0);
    let p = Plan::capture(desired, &[], None, 0., true).unwrap();
    assert!(!p.on);
}
#[test]
fn sing_mask_depends_on_desired_mode_and_cycle_not_native_lyric_timing() {
    let c = Config {
        mode: Mode::Lines,
        hear: 2,
        sing: 1,
        ..Default::default()
    };
    assert_eq!(
        sing_mask(true, &c, 7),
        Some(vec![false, false, true, false, false, true, false])
    );
    assert!(sing_mask(false, &c, 7).is_none());
    assert!(sing_mask(true, &Config::default(), 7).is_none());
}
#[test]
fn commands_use_stable_id_hex_and_actual_window_seconds() {
    let desired = Desired {
        enabled: true,
        config: Config {
            mode: Mode::Lines,
            ..Default::default()
        },
    };
    let p = Plan::capture(
        desired,
        &[lane("vocals")],
        Some(&[line(0., 1.), line(2., 3.)]),
        5.,
        true,
    )
    .unwrap();
    let commands = p.commands().unwrap();
    assert_eq!(commands[0], "carry-begin 1 1 10 1 1");
    assert_eq!(commands[1], "carry-lane 766f63616c73");
    assert_eq!(commands[2], "carry-window 1.85 5");
    assert_eq!(commands[3], "carry-apply");
}
#[test]
fn merge_preserves_foreign_settings_and_removes_disabled_on_flag() {
    let mut raw = json!({"on":true,"future":{"keep":7}});
    let desired = Desired::default();
    desired.merge_settings(&mut raw).unwrap();
    assert!(raw.get("on").is_none());
    assert_eq!(raw["future"]["keep"], 7);
    assert_eq!(raw["periodSec"], 10);
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let p = std::env::temp_dir().join(format!(
            "singz-carry-prefs-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&p).unwrap();
        Self(p)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn preferences_roundtrip_config_without_song_enabled_flag() {
    let f = Fixture::new();
    assert_eq!(load(&f.0).unwrap(), Config::default());
    let c = Config {
        mode: Mode::Lines,
        period_sec: 25,
        hear: 2,
        sing: 3,
        stems: vec!["custom-a".into()],
    };
    retain(&f.0, &c).unwrap();
    assert_eq!(load(&f.0).unwrap(), c);
    let raw: Value = serde_json::from_slice(&fs::read(f.0.join(NAME)).unwrap()).unwrap();
    assert!(raw.get("on").is_none());
}
#[test]
fn preferences_preserve_unknown_and_refuse_external_change() {
    let f = Fixture::new();
    fs::write(f.0.join(NAME), br#"{"version":1,"future":{"token":7}}"#).unwrap();
    retain(&f.0, &Config::default()).unwrap();
    let raw: Value = serde_json::from_slice(&fs::read(f.0.join(NAME)).unwrap()).unwrap();
    assert_eq!(raw["future"]["token"], 7);
    assert!(
        retain_before_publish(&f.0, &Config::default(), || {
            fs::write(f.0.join(NAME), br#"{"version":1,"external":true}"#)?;
            Ok(())
        })
        .is_err()
    );
    assert_eq!(
        serde_json::from_slice::<Value>(&fs::read(f.0.join(NAME)).unwrap()).unwrap()["external"],
        true
    );
    assert!(
        !fs::read_dir(&f.0).unwrap().any(|e| e
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part"))
    );
}
#[test]
fn malformed_preferences_are_not_overwritten() {
    let f = Fixture::new();
    for bytes in [b"not json".as_slice(), br#"{"version":42}"#.as_slice()] {
        fs::write(f.0.join(NAME), bytes).unwrap();
        assert!(load(&f.0).is_err());
        assert!(retain(&f.0, &Config::default()).is_err());
        assert_eq!(fs::read(f.0.join(NAME)).unwrap(), bytes);
    }
}
#[cfg(unix)]
#[test]
fn linked_preference_or_lease_is_refused_without_touching_target() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.0.join("outside.json");
    fs::write(&outside, br#"{"version":1,"foreign":true}"#).unwrap();
    symlink(&outside, f.0.join(NAME)).unwrap();
    assert!(load(&f.0).is_err());
    assert!(retain(&f.0, &Config::default()).is_err());
    // The refused write correctly leaves its ordinary advisory lock in place.
    // Isolate the linked-lease case instead of replacing that persistent lock.
    let lease_fixture = Fixture::new();
    symlink(&outside, lease_fixture.0.join(".carry-line.lock")).unwrap();
    assert!(retain(&lease_fixture.0, &Config::default()).is_err());
    assert_eq!(
        fs::read(&outside).unwrap(),
        br#"{"version":1,"foreign":true}"#
    );
}
#[test]
fn malformed_typed_plan_is_refused_before_native_commands() {
    let desired = Desired {
        enabled: true,
        config: Default::default(),
    };
    let mut p = Plan::capture(desired, &[lane("vocals")], None, 10., true).unwrap();
    p.lane_ids.push("vocals".into());
    assert!(p.commands().is_err());
    p.lane_ids.pop();
    p.windows.push(Window { s: 1., e: f64::NAN });
    assert!(p.commands().is_err());
}
#[test]
fn restoring_enabled_schedule_does_not_request_arming_unmute() {
    let desired = Desired {
        enabled: true,
        config: Default::default(),
    };
    let p = Plan::capture(desired, &[lane("vocals")], None, 10., true).unwrap();
    let arm = p.commands().unwrap();
    let restore = p.restore_commands().unwrap();
    assert_eq!(arm[0], "carry-begin 1 0 10 1 0");
    assert_eq!(restore[0], "carry-begin 1 0 10 1 0 0");
    assert_eq!(&arm[1..], &restore[1..]);
    assert!(p.desired.enabled);
}

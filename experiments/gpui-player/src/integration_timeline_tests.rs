use super::*;
fn packet(minutes: u32) -> Value {
    let mut p: Value = serde_json::from_str(include_str!(
        "../../../tests/shared/gpui-first-lane-default-reply.json"
    ))
    .unwrap();
    let peak_count = p["peaks"].as_array().map_or(0, Vec::len);
    p["peaksValid"] = serde_json::json!(vec![true; peak_count]);
    p["duration"] = serde_json::json!(minutes as f64 * 60. + 0.123456);
    p["position"] = serde_json::json!(minutes as f64 * 60. - 0.123456);
    p["playing"] = serde_json::json!(false);
    p["countingIn"] = serde_json::json!(false);
    p
}
#[test]
fn long_song_position_and_duration_round_trip() {
    for minutes in [8, 9, 12, 60] {
        let p = packet(minutes);
        let s = Status::parse(&p).unwrap();
        assert!(
            (s.position - p["position"].as_f64().unwrap()).abs() < 1e-9,
            "{minutes} minute position narrowed: {}",
            s.position
        );
        assert!(
            (s.duration - p["duration"].as_f64().unwrap()).abs() < 1e-9,
            "{minutes} minute duration narrowed"
        );
        let command = format!("seek {}", s.position);
        assert!(
            (command[5..].parse::<f64>().unwrap() - p["position"].as_f64().unwrap()).abs() < 1e-9
        );
    }
}
#[test]
fn long_song_loop_bounds_preserve_sample_precision() {
    for minutes in [8, 9, 12, 60] {
        let mut p = packet(minutes);
        let start = minutes as f64 * 60. - 0.123456;
        let end = start + 1. / 48000.;
        for key in ["loopStart", "regionStart"] {
            p[key] = serde_json::json!(start);
        }
        for key in ["loopEnd", "regionEnd"] {
            p[key] = serde_json::json!(end);
        }
        p["looping"] = serde_json::json!(true);
        p["regionEnabled"] = serde_json::json!(true);
        let s = Status::parse(&p).unwrap();
        for range in [s.loop_range, s.region_range] {
            let (a, b) = range.expect("one-sample region must not collapse");
            assert!(
                (a - start).abs() < 1e-9 && (b - end).abs() < 1e-9,
                "{minutes} minute region narrowed: {a}..{b}"
            );
        }
    }
}
#[test]
fn long_song_output_duration_comparison_does_not_grow_with_f32_ulp() {
    for minutes in [8, 9, 12, 60] {
        let before = packet(minutes);
        let mut after = before.clone();
        after["duration"] = serde_json::json!(before["duration"].as_f64().unwrap() + 0.00102);
        assert!(
            accepted_output(&before, &after, "").is_err(),
            "{minutes} minute route accepted duration drift above 1 ms"
        );
        after["duration"] = before["duration"].clone();
        assert!(accepted_output(&before, &after, "").is_ok());
    }
}
#[test]
fn sixty_minute_one_sample_loop_is_not_rejected_as_zero_width() {
    let mut p = packet(60);
    let start = 3600. - 0.123456;
    let end = start + 1. / 48000.;
    p["looping"] = serde_json::json!(true);
    p["regionEnabled"] = serde_json::json!(true);
    for key in ["loopStart", "regionStart"] {
        p[key] = serde_json::json!(start);
    }
    for key in ["loopEnd", "regionEnd"] {
        p[key] = serde_json::json!(end);
    }
    let status = Status::parse(&p).expect("native one-sample region must survive status parsing");
    let (s, e) = status.loop_range.unwrap();
    assert!((e - s - 1. / 48000.).abs() < 1e-9);
}
#[test]
fn long_song_project_open_keeps_saved_time_ranges() {
    for minutes in [8, 9, 12, 60] {
        let dir =
            std::env::temp_dir().join(format!("singz-c13-open-{}-{minutes}", std::process::id()));
        fs::create_dir_all(dir.join("stems")).unwrap();
        fs::write(dir.join("stems/vocals.wav"), b"reader fixture; not decoded").unwrap();
        let duration = minutes as f64 * 60. + 0.123456;
        let start = duration - 0.234567;
        let raw = serde_json::json!({"version":2,"duration":duration,"settings":{"loop":true,"selection":{"s":start,"e":duration},"view":{"s":start-2.,"e":duration}}});
        fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
        let project = read_project(&dir).unwrap();
        fs::remove_dir_all(&dir).unwrap();
        assert_eq!(project.raw["duration"], raw["duration"]);
        let (s, e) = project.selection.unwrap();
        assert!(
            (s - start).abs() < 1e-9 && (e - duration).abs() < 1e-9,
            "{minutes} minute saved selection narrowed on open"
        );
        let (s, e) = project.view.unwrap();
        assert!((s - (start - 2.)).abs() < 1e-9 && (e - duration).abs() < 1e-9);
    }
}

#[test]
fn long_song_saved_duration_and_ranges_keep_microseconds() {
    for minutes in [8, 9, 12, 60] {
        let duration = minutes as f64 * 60. + 0.123456;
        let start = duration - 0.234567;
        let mut m = mix();
        m.view = (0., duration);
        m.selection = Some((start, duration));
        let saved = update_mix(json!({"duration":duration,"settings":{}}), &m).unwrap();
        assert_eq!(saved["duration"].as_f64().unwrap(), duration);
        assert!(
            (saved["settings"]["view"]["e"].as_f64().unwrap() - duration).abs() < 1e-9,
            "{minutes} minute saved view narrowed"
        );
        assert!(
            (saved["settings"]["selection"]["s"].as_f64().unwrap() - start).abs() < 1e-9,
            "{minutes} minute saved selection narrowed"
        );
    }
}
#[test]
fn unchanged_project_save_preserves_original_bytes() {
    for (case, duration, bounds, pretty) in [
        ("compact", 3600.123456, (0., 3600.123456), false),
        ("electron-format", 3600.123456, (0., 3600.123456), true),
        (
            "electron-precise",
            720.,
            (12.499999523162842, 712.4999995231628),
            true,
        ),
    ] {
        let dir =
            std::env::temp_dir().join(format!("singz-c13-save-{}-{case}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let mut m = mix();
        m.selection = Some(bounds);
        m.view = bounds;
        let mut original = update_mix(json!({"duration":duration,"settings":{}}), &m).unwrap();
        // Existing writers can retain more than our six-decimal edit precision.
        original["settings"]["view"] = json!({"s":bounds.0,"e":bounds.1});
        original["settings"]["selection"] = json!({"s":bounds.0,"e":bounds.1});
        original["savedAt"] = json!("2000-01-01T00:00:00.000Z");
        // Electron uses JSON.stringify(meta, null, 2), without a trailing newline.
        let source = if pretty {
            serde_json::to_string_pretty(&original).unwrap()
        } else {
            serde_json::to_string(&original).unwrap()
        };
        if pretty {
            assert!(source.contains("\n  \"settings\": {"));
            assert!(!source.ends_with('\n'));
        }
        fs::write(dir.join("project.json"), source.as_bytes()).unwrap();
        let (raw, hash) = read(&dir.canonicalize().unwrap(), "project.json").unwrap();
        // Reproduce Player's loaded-seconds -> normalized-view -> Save path.
        let loaded_start = raw["settings"]["view"]["s"].as_f64().unwrap();
        let loaded_end = raw["settings"]["view"]["e"].as_f64().unwrap();
        m.view = (
            (loaded_start / duration) * duration,
            (loaded_end / duration) * duration,
        );
        if case == "electron-precise" {
            assert_ne!(
                m.view.0, loaded_start,
                "fixture must exercise round-trip rounding"
            );
        }
        let unchanged = update_mix(raw.clone(), &m).unwrap();
        assert_eq!(
            unchanged["settings"]["view"], raw["settings"]["view"],
            "{case} rewrote its loaded view"
        );
        assert_eq!(
            unchanged["savedAt"], raw["savedAt"],
            "{case} bumped savedAt"
        );
        commit(&dir, "project.json", &hash, &unchanged).unwrap();
        assert_eq!(
            fs::read(dir.join("project.json")).unwrap(),
            source.as_bytes(),
            "{case} rewrote its bytes"
        );
        // A user edit at the saved precision must still change the document.
        m.view.0 += 0.000005;
        let edited = update_mix(raw.clone(), &m).unwrap();
        assert_ne!(edited["settings"]["view"], raw["settings"]["view"]);
        assert_ne!(edited["savedAt"], raw["savedAt"]);
        fs::remove_dir_all(dir).unwrap();
    }
}

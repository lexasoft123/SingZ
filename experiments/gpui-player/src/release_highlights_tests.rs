use super::*;
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "singz-release-highlights-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, AtomicOrdering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path.canonicalize().unwrap())
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

#[test]
fn bundled_current_version_matches_the_actual_desktop_package() {
    let package: Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
    assert_eq!(CURRENT_VERSION, content().version);
    assert_eq!(CURRENT_VERSION, package["version"]);
}
#[test]
fn first_launch_manual_reopen_and_pre_feature_install_follow_desktop_rules() {
    let f = Fixture::new();
    let fresh = load(&f.0, CURRENT_VERSION, false).unwrap();
    assert_eq!(fresh.seen.as_deref(), Some(CURRENT_VERSION));
    assert!(notes(CURRENT_VERSION, fresh.seen.as_deref(), "en").is_none());
    assert!(notes(CURRENT_VERSION, None, "en").is_some());
    let returning = Fixture::new();
    let state = load(&returning.0, CURRENT_VERSION, true).unwrap();
    assert!(state.seen.is_none());
    assert!(notes(CURRENT_VERSION, state.seen.as_deref(), "en").is_some());
    let seen = acknowledge(&returning.0, CURRENT_VERSION, CURRENT_VERSION).unwrap();
    assert_eq!(seen.seen.as_deref(), Some(CURRENT_VERSION));
    assert!(
        notes(
            CURRENT_VERSION,
            load(&returning.0, CURRENT_VERSION, true)
                .unwrap()
                .seen
                .as_deref(),
            "en"
        )
        .is_none()
    );
}
#[test]
fn skipped_releases_are_newest_first_and_desktop_never_adopts_mobile_only_highlights() {
    let notes = notes("0.26.5", Some("0.26.1"), "en").unwrap();
    assert_eq!(
        notes
            .entries
            .iter()
            .map(|entry| entry.version.as_str())
            .collect::<Vec<_>>(),
        vec!["0.26.5", "0.26.4", "0.26.3", "0.26.2"]
    );
    let ids: Vec<_> = notes
        .entries
        .iter()
        .flat_map(|entry| &entry.highlights)
        .map(|item| item.id.as_str())
        .collect();
    assert!(ids.contains(&"song-output"));
    assert!(ids.contains(&"desktop-training"));
    for mobile in ["practice-flow", "duo", "android-cues"] {
        assert!(!ids.contains(&mobile));
    }
    assert!(
        notes
            .entries
            .iter()
            .flat_map(|entry| &entry.highlights)
            .all(|item| !item.desktop_only)
    );
    assert_eq!(
        notes.url,
        "https://github.com/lexasoft123/SingZ/releases/tag/v0.26.5"
    );
}
#[test]
fn malformed_previous_is_current_only_and_malformed_current_is_unavailable() {
    for invalid in [
        "",
        "v0.26.5",
        "0.26",
        "0.26.5-beta",
        " 0.26.5",
        "0.26.5\n",
        "٠.٢٦.٥",
    ] {
        assert!(!valid_version(invalid));
        assert!(notes(invalid, None, "en").is_none());
        assert_eq!(
            notes(CURRENT_VERSION, Some(invalid), "en"),
            notes(CURRENT_VERSION, None, "en")
        );
    }
    assert!(valid_version("00.026.005"));
    assert!(notes("00.026.005", None, "en").is_none());
    assert!(notes(CURRENT_VERSION, Some("00.026.005"), "en").is_none());
}
#[test]
fn locale_resolution_preserves_supported_translations_and_falls_back_to_english() {
    let title = |locale| {
        notes(CURRENT_VERSION, None, locale).unwrap().entries[0].highlights[0]
            .title
            .clone()
    };
    assert_eq!(title("ru_RU"), "Громкость для каждой песни");
    assert_eq!(title("zh-Hant-HK"), title("zh-TW"));
    assert_eq!(title("zh-Hans-CN"), title("zh-CN"));
    assert_eq!(title("zh-US"), title("en"));
    assert_eq!(title("fr-FR"), title("en"));
    assert_eq!(title("tl-PH"), title("fil"));
    assert_eq!(title("in-ID"), title("id"));
    for locale in [
        "en", "ru", "zh-CN", "zh-TW", "hi", "ja", "ko", "th", "id", "vi", "fil", "ms", "tr",
    ] {
        assert!(
            notes(CURRENT_VERSION, None, locale)
                .unwrap()
                .entries
                .iter()
                .flat_map(|entry| &entry.highlights)
                .all(|item| !item.title.is_empty() && !item.description.is_empty())
        );
    }
}
#[test]
fn acknowledgement_is_monotonic_across_downgrades_and_preserves_foreign_fields() {
    let f = Fixture::new();
    fs::write(
        f.0.join(NAME),
        br#"{"version":1,"releaseNotesSeen":"0.26.4","future":{"large":1234567890123456789}}"#,
    )
    .unwrap();
    assert_eq!(
        acknowledge(&f.0, "0.26.3", "0.26.3")
            .unwrap()
            .seen
            .as_deref(),
        Some("0.26.4")
    );
    acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).unwrap();
    let raw = read(&f.0).unwrap().raw;
    assert_eq!(raw["future"]["large"], json!(1234567890123456789u64));
    assert!(notes("0.26.3", Some(CURRENT_VERSION), "en").is_none());
    assert!(notes("0.26.3", None, "en").is_some());
}
#[test]
fn unavailable_or_wrong_running_release_cannot_be_acknowledged() {
    let f = Fixture::new();
    for (current, seen) in [
        (CURRENT_VERSION, "0.26.4"),
        ("99.0.0", "99.0.0"),
        ("bad", "bad"),
    ] {
        assert!(acknowledge(&f.0, current, seen).is_err());
        assert!(!f.0.join(NAME).exists());
    }
}
#[test]
fn invalid_saved_version_can_be_repaired_but_malformed_documents_are_not_overwritten() {
    let f = Fixture::new();
    fs::write(
        f.0.join(NAME),
        br#"{"version":1,"releaseNotesSeen":"legacy","keep":true}"#,
    )
    .unwrap();
    assert_eq!(
        load(&f.0, CURRENT_VERSION, true).unwrap().seen.as_deref(),
        Some("legacy")
    );
    acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).unwrap();
    assert_eq!(read(&f.0).unwrap().raw["keep"], true);
    for broken in [
        b"{broken".as_slice(),
        br#"{"version":2,"releaseNotesSeen":"future"}"#.as_slice(),
        br#"{"releaseNotesSeen":42}"#.as_slice(),
    ] {
        fs::write(f.0.join(NAME), broken).unwrap();
        assert!(load(&f.0, CURRENT_VERSION, false).is_err());
        assert!(acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).is_err());
        assert_eq!(fs::read(f.0.join(NAME)).unwrap(), broken);
    }
}
#[test]
fn busy_lease_refuses_before_write_then_retry_is_durable_and_cleans_temps() {
    let f = Fixture::new();
    let held = lease(&f.0).unwrap();
    assert!(acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).is_err());
    assert!(!f.0.join(NAME).exists());
    drop(held);
    acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).unwrap();
    assert_eq!(
        load(&f.0, CURRENT_VERSION, true).unwrap().seen.as_deref(),
        Some(CURRENT_VERSION)
    );
    assert!(fs::read_dir(&f.0).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}
#[cfg(unix)]
#[test]
fn linked_state_and_lock_are_refused_without_writing_the_target() {
    let f = Fixture::new();
    let foreign = f.0.join("foreign");
    fs::write(&foreign, b"private").unwrap();
    std::os::unix::fs::symlink(&foreign, f.0.join(NAME)).unwrap();
    assert!(load(&f.0, CURRENT_VERSION, false).is_err());
    assert!(acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"private");
    fs::remove_file(f.0.join(NAME)).unwrap();
    fs::remove_file(f.0.join(".release-highlights.lock")).unwrap();
    std::os::unix::fs::symlink(&foreign, f.0.join(".release-highlights.lock")).unwrap();
    assert!(acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).is_err());
    assert!(!f.0.join(NAME).exists());
    assert_eq!(fs::read(foreign).unwrap(), b"private");
}
#[test]
fn worker_distinguishes_fresh_and_pre_feature_native_installs_and_flushes_ack_on_drop() {
    let fresh = Fixture::new();
    let service = Service::new(fresh.0.clone());
    drop(service);
    assert_eq!(
        load(&fresh.0, CURRENT_VERSION, true)
            .unwrap()
            .seen
            .as_deref(),
        Some(CURRENT_VERSION)
    );
    let old = Fixture::new();
    fs::write(old.0.join("audio.json"), b"{}").unwrap();
    let service = Service::new(old.0.clone());
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(3);
    while !service.snapshot().loaded {
        assert!(std::time::Instant::now() < deadline);
        std::thread::yield_now();
    }
    assert!(service.snapshot().state.seen.is_none());
    assert!(service.snapshot().error.is_none());
    service.acknowledge().unwrap();
    drop(service);
    assert_eq!(
        load(&old.0, CURRENT_VERSION, true).unwrap().seen.as_deref(),
        Some(CURRENT_VERSION)
    );
    assert_eq!(fs::read(old.0.join("audio.json")).unwrap(), b"{}");
}
#[test]
fn serialized_domain_uses_source_wire_names_and_lowercase_icons() {
    let notes = notes(CURRENT_VERSION, None, "en").unwrap();
    let raw = serde_json::to_value(&notes).unwrap();
    let item = &raw["entries"][0]["highlights"][0];
    assert_eq!(item["icon"], "controls");
    assert_eq!(item["desktopOnly"], false);
    assert!(item.get("desktop_only").is_none());
    assert_eq!(serde_json::from_value::<ReleaseNotes>(raw).unwrap(), notes);
}
#[test]
fn external_state_changes_refuse_publication_and_leave_no_private_temporary() {
    for initially_present in [false, true] {
        let f = Fixture::new();
        if initially_present {
            acknowledge(&f.0, "0.26.3", "0.26.3").unwrap();
        }
        let captured = read(&f.0).unwrap();
        let external = br#"{"version":1,"releaseNotesSeen":"9.0.0","foreign":"newer"}"#;
        fs::write(f.0.join(NAME), external).unwrap();
        assert!(publish(&f.0, captured, CURRENT_VERSION).is_err());
        assert_eq!(fs::read(f.0.join(NAME)).unwrap(), external);
        assert!(fs::read_dir(&f.0).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }
}
#[test]
fn oversized_metadata_is_rejected_without_repair_or_unbounded_read() {
    let f = Fixture::new();
    File::create(f.0.join(NAME))
        .unwrap()
        .set_len(LIMIT + 1)
        .unwrap();
    assert!(load(&f.0, CURRENT_VERSION, false).is_err());
    assert!(acknowledge(&f.0, CURRENT_VERSION, CURRENT_VERSION).is_err());
    assert_eq!(fs::metadata(f.0.join(NAME)).unwrap().len(), LIMIT + 1);
}
#[test]
fn concurrently_accepted_versions_never_roll_a_newer_acknowledgement_back() {
    let f = Fixture::new();
    let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
    let mut workers = vec![];
    for version in ["0.26.3", CURRENT_VERSION] {
        let dir = f.0.clone();
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            acknowledge(&dir, version, version).ok().map(|_| version)
        }));
    }
    barrier.wait();
    let successes: Vec<_> = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap())
        .collect();
    assert!(!successes.is_empty());
    let expected = successes.into_iter().max_by(|a, b| compare(a, b)).unwrap();
    assert_eq!(
        load(&f.0, CURRENT_VERSION, true).unwrap().seen.as_deref(),
        Some(expected)
    );
}
#[test]
fn version_comparison_matches_javascript_number_rounding_for_large_components() {
    assert_eq!(
        compare("9007199254740992.0.0", "9007199254740993.0.0"),
        Ordering::Equal
    );
    assert_eq!(compare("0.026.005", "0.26.5"), Ordering::Equal);
    let huge = "9".repeat(400);
    assert_eq!(
        compare(&format!("{huge}.2.0"), &format!("{huge}.1.0")),
        Ordering::Greater
    );
}

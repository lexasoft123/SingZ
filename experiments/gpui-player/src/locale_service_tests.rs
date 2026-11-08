use super::*;
use std::sync::{Barrier, atomic::AtomicUsize};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "singz-language-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn prefs(&self) -> PathBuf {
        self.0.join(NAME)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn wait(service: &Service, sequence: u64) -> Snapshot {
    let deadline = Instant::now() + Duration::from_secs(4);
    loop {
        let snapshot = service.snapshot();
        if snapshot.loaded && !snapshot.pending && snapshot.sequence == sequence {
            return snapshot;
        }
        assert!(
            Instant::now() < deadline,
            "Locale worker did not settle: {snapshot:?}"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
#[test]
fn absent_preferences_follow_system_without_creating_files() {
    let f = Fixture::new();
    let service = Service::start(f.0.clone(), None, || vec!["de-DE".into(), "ru-RU".into()]);
    let state = wait(&service, 0);
    assert_eq!(state.state.language, Language::System);
    assert_eq!(state.state.locale, Locale::Ru);
    assert_eq!(state.state.system_locale, Locale::Ru);
    assert!(!f.prefs().exists());
}
#[test]
fn session_pick_wins_forced_locale_and_latest_is_durable_on_restart() {
    let f = Fixture::new();
    let service = Service::start(f.0.clone(), Some(Language::Locale(Locale::En)), || {
        vec!["ru-RU".into()]
    });
    assert_eq!(wait(&service, 0).state.locale, Locale::En);
    let seq = service.pick(Language::Locale(Locale::Tr)).unwrap();
    assert_eq!(wait(&service, seq).state.locale, Locale::Tr);
    drop(service);
    assert_eq!(load(&f.0).unwrap(), Language::Locale(Locale::Tr));
    let restarted = Service::start(f.0.clone(), None, || vec!["ru-RU".into()]);
    assert_eq!(wait(&restarted, 0).state.locale, Locale::Tr);
    let seq = restarted.pick(Language::System).unwrap();
    assert_eq!(wait(&restarted, seq).state.locale, Locale::Ru);
}
#[test]
fn startup_load_cannot_publish_over_accepted_pick_and_drop_flushes_latest() {
    let f = Fixture::new();
    retain(&f.0, Language::Locale(Locale::Ru), &|| false).unwrap();
    let entered = Arc::new(Barrier::new(2));
    let release = Arc::new(Barrier::new(2));
    let a = entered.clone();
    let b = release.clone();
    let service = Service::start(f.0.clone(), None, move || {
        a.wait();
        b.wait();
        vec!["en-US".into()]
    });
    entered.wait();
    service.pick(Language::Locale(Locale::Ja)).unwrap();
    release.wait();
    drop(service);
    assert_eq!(load(&f.0).unwrap(), Language::Locale(Locale::Ja));
}
#[test]
fn rapid_picks_publish_only_latest_while_real_preference_lease_is_busy() {
    let f = Fixture::new();
    let service = Service::start(f.0.clone(), None, || vec!["en".into()]);
    wait(&service, 0);
    let lock = lease(&f.0).unwrap();
    let first = service.pick(Language::Locale(Locale::Ru)).unwrap();
    let last = service.pick(Language::Locale(Locale::Ja)).unwrap();
    assert!(last > first);
    thread::sleep(Duration::from_millis(30));
    let pending = service.snapshot();
    assert!(pending.pending);
    assert_eq!(pending.state.locale, Locale::En);
    drop(lock);
    let final_state = wait(&service, last);
    assert_eq!(final_state.state.locale, Locale::Ja);
    assert_eq!(load(&f.0).unwrap(), Language::Locale(Locale::Ja));
}
#[test]
fn unknown_fields_survive_and_invalid_language_defaults_to_system() {
    let f = Fixture::new();
    let raw = json!({"version":1,"language":"unknown","future":{"keep":7}});
    fs::write(f.prefs(), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert_eq!(load(&f.0).unwrap(), Language::System);
    retain(&f.0, Language::Locale(Locale::ZhTw), &|| false).unwrap();
    let raw: Value = serde_json::from_slice(&fs::read(f.prefs()).unwrap()).unwrap();
    assert_eq!(raw["future"]["keep"], 7);
    assert_eq!(raw["language"], "zh-TW");
}
#[test]
fn malformed_future_and_oversize_preferences_are_not_destroyed() {
    let f = Fixture::new();
    for bytes in [
        b"{bad".as_slice(),
        br#"{"version":2}"#.as_slice(),
        b"[]".as_slice(),
    ] {
        fs::write(f.prefs(), bytes).unwrap();
        assert!(load(&f.0).is_err());
        assert!(retain(&f.0, Language::Locale(Locale::Tr), &|| false).is_err());
        assert_eq!(fs::read(f.prefs()).unwrap(), bytes);
    }
    File::create(f.prefs()).unwrap().set_len(LIMIT + 1).unwrap();
    assert!(retain(&f.0, Language::System, &|| false).is_err());
    assert_eq!(fs::metadata(f.prefs()).unwrap().len(), LIMIT + 1);
}
#[test]
fn persistence_error_keeps_session_pick_and_later_pick_recovers() {
    let f = Fixture::new();
    fs::write(f.prefs(), b"{bad").unwrap();
    let service = Service::start(f.0.clone(), Some(Language::Locale(Locale::En)), || {
        vec!["en".into()]
    });
    assert!(wait(&service, 0).error.is_some());
    let seq = service.pick(Language::Locale(Locale::Ru)).unwrap();
    let failed = wait(&service, seq);
    assert_eq!(failed.state.locale, Locale::Ru);
    assert!(
        failed
            .error
            .as_ref()
            .unwrap()
            .contains("could not be saved")
    );
    assert_eq!(fs::read(f.prefs()).unwrap(), b"{bad");
    fs::remove_file(f.prefs()).unwrap();
    let seq = service.pick(Language::Locale(Locale::Tr)).unwrap();
    let recovered = wait(&service, seq);
    assert_eq!(recovered.state.locale, Locale::Tr);
    assert!(recovered.error.is_none());
}
#[test]
fn external_edit_at_publication_boundary_refuses_cas_and_cleans_private_stage() {
    let f = Fixture::new();
    retain(&f.0, Language::Locale(Locale::En), &|| false).unwrap();
    let foreign = br#"{"version":1,"language":"ja","foreign":true}"#;
    let result = retain_before_publish(&f.0, Language::Locale(Locale::Ru), &|| false, || {
        fs::write(f.prefs(), foreign)?;
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(fs::read(f.prefs()).unwrap(), foreign);
    assert!(fs::read_dir(&f.0).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".part")
    }));
}
#[test]
fn superseded_pick_does_not_publish_or_run_boundary_hook() {
    let f = Fixture::new();
    let calls = AtomicUsize::new(0);
    let result = retain_before_publish(&f.0, Language::Locale(Locale::Tr), &|| true, || {
        calls.fetch_add(1, Ordering::SeqCst);
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(calls.load(Ordering::SeqCst), 0);
    assert!(!f.prefs().exists());
}
#[cfg(unix)]
#[test]
fn linked_preferences_or_lease_are_refused_and_created_files_are_private() {
    let f = Fixture::new();
    let foreign = f.0.join("foreign");
    fs::write(&foreign, b"private").unwrap();
    std::os::unix::fs::symlink(&foreign, f.prefs()).unwrap();
    assert!(load(&f.0).is_err());
    assert!(retain(&f.0, Language::System, &|| false).is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"private");
    let g = Fixture::new();
    std::os::unix::fs::symlink(&foreign, g.0.join(".language.lock")).unwrap();
    assert!(retain(&g.0, Language::System, &|| false).is_err());
    let h = Fixture::new();
    retain(&h.0, Language::Locale(Locale::En), &|| false).unwrap();
    use std::os::unix::fs::PermissionsExt;
    assert_eq!(
        fs::metadata(h.prefs()).unwrap().permissions().mode() & 0o777,
        0o600
    );
}
#[test]
fn native_system_tag_probe_is_bounded() {
    let tags = system_tags();
    assert!(tags.len() <= 128);
    assert!(tags.iter().all(|tag| tag.len() < 16384));
}
#[test]
fn valid_env_including_system_wins_hidden_default_and_invalid_env_is_ignored() {
    assert_eq!(
        forced_language(Some("ru"), true),
        Some(Language::Locale(Locale::Ru))
    );
    assert_eq!(
        forced_language(Some("system"), true),
        Some(Language::System)
    );
    assert_eq!(
        forced_language(Some("RU"), true),
        Some(Language::Locale(Locale::En))
    );
    assert_eq!(
        forced_language(None, true),
        Some(Language::Locale(Locale::En))
    );
    assert_eq!(forced_language(Some("not-supported"), false), None);
    assert_eq!(forced_language(None, false), None);
}

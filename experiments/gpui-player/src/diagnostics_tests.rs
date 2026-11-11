use super::*;

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!(
            "singz-diagnostics-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        Self(dir)
    }
    fn config(&self) -> Config {
        Config {
            directory: self.0.join("logs"),
            version: "0.26.5".into(),
            platform: "darwin".into(),
            arch: "arm64".into(),
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn entry(line: &str, level: Level) -> Entry {
    Entry {
        timestamp_ms: Some(1_700_000_000_123),
        level,
        source: "engine".into(),
        line: line.into(),
    }
}
fn until(mut check: impl FnMut() -> bool) {
    let start = Instant::now();
    while !check() {
        assert!(
            start.elapsed() < Duration::from_secs(5),
            "diagnostics worker did not respond"
        );
        thread::sleep(Duration::from_millis(5));
    }
}
fn receipt(service: &Service, id: u64) -> Event {
    let mut answer = None;
    until(|| {
        for event in service.drain() {
            if event.id == id {
                answer = Some(event);
            }
        }
        answer.is_some()
    });
    answer.unwrap()
}
fn enqueue_list(service: &Service) -> u64 {
    let mut id = None;
    until(|| {
        id = service.list().ok();
        id.is_some()
    });
    id.unwrap()
}
#[test]
fn source_utf16_limit_preserves_two_unit_glyphs_and_replaces_cut_surrogate() {
    assert_eq!(truncate_line(&"é".repeat(2001)), "é".repeat(2000));
    assert_eq!(truncate_line(&"🦀".repeat(1001)), "🦀".repeat(1000));
    assert_eq!(
        truncate_line(&("a".repeat(1999) + "🦀x")),
        "a".repeat(1999) + "�"
    );
}
#[test]
fn source_iso_header_and_copy_have_distinct_timestamp_contracts() {
    let f = Fixture::new();
    let mut store = Store::new(f.config());
    store.push(entry("hello", Level::Error));
    assert_eq!(
        store.format(),
        "SingZ 0.26.5 — darwin-arm64\n2023-11-14T22:13:20.123Z [error] engine: hello\n"
    );
    let copied = format_copy(&[
        entry("hello", Level::Error),
        Entry {
            timestamp_ms: None,
            source: String::new(),
            line: "raw".into(),
            level: Level::Info,
        },
    ]);
    assert_eq!(
        copied,
        format!(
            "{} [error] engine: hello\n [info] : raw",
            format_local(Some(1_700_000_000_123))
        )
    );
    assert_eq!(format_local(None), "");
}
#[test]
fn past_session_parser_keeps_raw_header_invalid_dates_and_full_count_with_tail() {
    let mut text =
        "SingZ 0.26.5 — darwin-arm64\n\ninvalid [warn] engine: bad clock\nraw: unstructured\n"
            .to_owned();
    for i in 0..4107 {
        text += &format!("2023-11-14T22:13:20.123Z [info] engine: row-{i}\n");
    }
    let parsed = parse_session(&text);
    assert_eq!(parsed.total, 4110);
    assert_eq!(parsed.entries.len(), 4000);
    assert_eq!(parsed.entries[0].line, "row-107");
    assert_eq!(parsed.entries.last().unwrap().line, "row-4106");
    let initial = parse_session("header\ninvalid [warn] engine: bad clock\nraw: unstructured\n");
    assert_eq!(initial.entries[0].source, "");
    assert_eq!(initial.entries[1].level, Level::Warn);
    assert_eq!(initial.entries[1].timestamp_ms, None);
    assert_eq!(initial.entries[2].line, "raw: unstructured");
}
#[test]
fn rotation_retains_eleven_owned_sessions_and_preserves_foreign_oversize_and_links() {
    let f = Fixture::new();
    let config = f.config();
    fs::create_dir_all(&config.directory).unwrap();
    for i in 0..14 {
        fs::write(
            config
                .directory
                .join(format!("session-2020-01-01T00-00-{i:02}-000Z-1.log")),
            format!("old-{i}"),
        )
        .unwrap();
    }
    let foreign = config.directory.join("foreign.log");
    fs::write(&foreign, b"foreign").unwrap();
    let huge = config
        .directory
        .join("session-2010-01-01T00-00-00-000Z-2.log");
    File::create(&huge)
        .unwrap()
        .set_len(READ_LIMIT + 1)
        .unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(
            &foreign,
            config
                .directory
                .join("session-2000-01-01T00-00-00-000Z-3.log"),
        )
        .unwrap();
    }
    let store = Store::new(config.clone());
    assert!(store.error.is_none(), "{:?}", store.error);
    let sessions = store.sessions().unwrap();
    assert_eq!(sessions.len(), 11);
    assert_eq!(sessions.iter().filter(|s| s.current).count(), 1);
    assert!(sessions[0].current);
    assert!(sessions[0].started_at > 1_700_000_000_000);
    assert_eq!(fs::read(foreign).unwrap(), b"foreign");
    assert_eq!(fs::metadata(huge).unwrap().len(), READ_LIMIT + 1);
    #[cfg(unix)]
    assert!(
        fs::symlink_metadata(
            config
                .directory
                .join("session-2000-01-01T00-00-00-000Z-3.log")
        )
        .unwrap()
        .file_type()
        .is_symlink()
    );
    assert!(
        !config
            .directory
            .join("session-2020-01-01T00-00-02-000Z-1.log")
            .exists()
    );
    assert!(
        config
            .directory
            .join("session-2020-01-01T00-00-04-000Z-1.log")
            .exists()
    );
}
#[test]
fn info_flush_waits_but_warning_and_shutdown_preserve_crash_evidence() {
    let f = Fixture::new();
    let mut store = Store::new(f.config());
    let path = store
        .config
        .directory
        .join(&store.session.as_ref().unwrap().0);
    store.push(entry("buffered", Level::Info));
    assert!(!fs::read_to_string(&path).unwrap().contains("buffered"));
    store.push(entry("crash clue", Level::Warn));
    let text = fs::read_to_string(&path).unwrap();
    assert!(text.contains("buffered\n"));
    assert!(text.contains("[warn] engine: crash clue"));
    assert!(store.pending.is_empty());
    let service = Service::new(f.config());
    let sink = service.sink();
    assert!(sink.log("test", "shutdown final line", Level::Info));
    let name = {
        let mut name = None;
        until(|| {
            name = service.snapshot().session_name.clone();
            name.is_some()
        });
        name.unwrap()
    };
    drop(service);
    assert!(
        fs::read_to_string(f.config().directory.join(name))
            .unwrap()
            .contains("shutdown final line")
    );
    assert!(!sink.log("test", "after shutdown", Level::Info));
}
#[test]
fn info_flush_deadline_is_not_extended_by_later_lines() {
    let f = Fixture::new();
    let mut store = Store::new(f.config());
    store.push(entry("first", Level::Info));
    let first = store.pending_since.unwrap();
    thread::sleep(Duration::from_millis(5));
    store.push(entry("second", Level::Info));
    assert_eq!(store.pending_since, Some(first));
    assert!(store.wait() < FLUSH);
}
#[test]
fn cap_emits_one_source_warning_then_keeps_only_live_tail() {
    let f = Fixture::new();
    let mut store = Store::new(f.config());
    let path = store
        .config
        .directory
        .join(&store.session.as_ref().unwrap().0);
    store.bytes = MAX_SESSION_BYTES - 2;
    store.push(entry("discarded disk batch", Level::Warn));
    assert!(store.full);
    assert!(store.pending.is_empty());
    let first = fs::read_to_string(&path).unwrap();
    assert!(first.contains(
        "[warn] app: log file reached 8 MB — the rest of this session is only in the Log dialog"
    ));
    assert!(!first.contains("discarded disk batch"));
    store.push(entry("still live", Level::Error));
    store.flush();
    assert_eq!(fs::read_to_string(&path).unwrap(), first);
    assert_eq!(store.ring.back().unwrap().line, "still live");
}
#[test]
fn chunk_cleanup_strips_only_source_color_codes_nuls_blank_and_progress_lines() {
    let f = Fixture::new();
    let service = Service::new(f.config());
    let skip = Regex::new(r"^\d+%").unwrap();
    service.sink().log_chunk(
        "splitter",
        "\x1b[31m failure \x1b[0m\r\n\0r\0e\0a\0d\0y\r40% done\n \nkeep \x1b[2Kcursor",
        Some(&skip),
    );
    let snapshot = service.snapshot();
    let lines = &snapshot.entries;
    assert_eq!(
        lines.iter().map(|e| e.line.as_str()).collect::<Vec<_>>(),
        ["failure", "ready", "keep \x1b[2Kcursor"]
    );
}
#[test]
fn burst_keeps_latest_four_thousand_live_rows_even_when_disk_queue_drops() {
    let f = Fixture::new();
    let service = Service::new(f.config());
    let sink = service.sink();
    for i in 0..10000 {
        sink.log("burst", &format!("row-{i}"), Level::Info);
    }
    let snapshot = service.snapshot();
    assert_eq!(snapshot.entries.len(), MAX_ENTRIES);
    assert_eq!(
        snapshot
            .entries
            .iter()
            .filter(|e| e.source == "burst")
            .last()
            .unwrap()
            .line,
        "row-9999"
    );
    let id = enqueue_list(&service);
    assert!(receipt(&service, id).result.is_ok());
    let snapshot = service.snapshot();
    if snapshot.dropped > 0 {
        let file = f
            .config()
            .directory
            .join(snapshot.session_name.as_ref().unwrap());
        assert!(
            fs::read_to_string(file)
                .unwrap()
                .contains("dropped while the bounded worker queue was full")
        );
    }
}
#[test]
fn restart_lists_real_previous_session_and_exports_full_past_not_tail() {
    let f = Fixture::new();
    let mut seed = Store::new(f.config());
    let name = seed.session.as_ref().unwrap().0.clone();
    for i in 0..4107 {
        seed.push(entry(&format!("past-{i}"), Level::Info));
    }
    seed.flush();
    let original = fs::read(seed.config.directory.join(&name)).unwrap();
    drop(seed);
    let service = Service::new(f.config());
    let id = enqueue_list(&service);
    let Reply::Sessions(sessions) = receipt(&service, id).result.unwrap() else {
        panic!()
    };
    assert!(sessions.iter().any(|s| s.name == name && !s.current));
    let id = service.read(name.clone()).unwrap();
    let Reply::Read(past) = receipt(&service, id).result.unwrap() else {
        panic!()
    };
    assert_eq!(past.total, 4108);
    assert_eq!(past.entries.len(), 4000);
    assert_eq!(past.entries[0].line, "past-107");
    let dest = f.0.join("past.txt");
    let id = service.export(dest.clone(), Some(name), false).unwrap();
    assert!(matches!(
        receipt(&service, id).result,
        Ok(Reply::Exported(_))
    ));
    assert_eq!(fs::read(dest).unwrap(), original);
}
#[test]
fn current_export_uses_live_ring_and_never_silently_overwrites_a_destination() {
    let f = Fixture::new();
    let service = Service::new(f.config());
    service.sink().log("live", "current only", Level::Info);
    let dest = f.0.join("current.txt");
    fs::write(&dest, b"foreign user's data").unwrap();
    let id = service.export(dest.clone(), None, false).unwrap();
    assert!(receipt(&service, id).result.is_err());
    assert_eq!(fs::read(&dest).unwrap(), b"foreign user's data");
    let id = service.export(dest.clone(), None, true).unwrap();
    assert!(receipt(&service, id).result.is_ok());
    let text = fs::read_to_string(dest).unwrap();
    assert!(text.starts_with("SingZ 0.26.5 — darwin-arm64\n"));
    assert!(text.contains("[info] live: current only\n"));
    assert!(!text.contains("log saved to"));
}
#[test]
fn invalid_missing_oversized_and_symlink_sessions_are_honest_errors() {
    let f = Fixture::new();
    let store = Store::new(f.config());
    assert!(store.read("../outside", &|| false).is_err());
    assert!(store.read("session-123-1.log", &|| false).is_err());
    let huge = store.config.directory.join("session-123-2.log");
    File::create(&huge)
        .unwrap()
        .set_len(READ_LIMIT + 1)
        .unwrap();
    assert!(store.read("session-123-2.log", &|| false).is_err());
    #[cfg(unix)]
    {
        let source = f.0.join("foreign");
        fs::write(&source, b"secret").unwrap();
        std::os::unix::fs::symlink(&source, store.config.directory.join("session-123-3.log"))
            .unwrap();
        assert!(store.read("session-123-3.log", &|| false).is_err());
    }
}
#[test]
fn cancelled_export_removes_its_partial_stage_and_preserves_approved_destination() {
    let f = Fixture::new();
    let dest = f.0.join("saved.txt");
    fs::write(&dest, b"old").unwrap();
    let count = AtomicU64::new(0);
    let bytes = vec![b'x'; 100000];
    assert!(
        export(&f.0.join("logs"), &dest, &bytes, true, &|| count
            .fetch_add(1, Ordering::Relaxed)
            >= 1)
        .is_err()
    );
    assert_eq!(fs::read(dest).unwrap(), b"old");
    assert_eq!(fs::read_dir(&f.0).unwrap().count(), 1);
}
#[test]
fn export_refuses_symlink_and_retained_session_destinations() {
    let f = Fixture::new();
    let store = Store::new(f.config());
    let retained = store
        .config
        .directory
        .join(&store.session.as_ref().unwrap().0);
    let before = fs::read(&retained).unwrap();
    assert!(
        export(
            &store.config.directory,
            &retained,
            b"overwrite",
            true,
            &|| false
        )
        .is_err()
    );
    assert_eq!(fs::read(retained).unwrap(), before);
    #[cfg(unix)]
    {
        let target = f.0.join("target");
        fs::write(&target, b"untouched").unwrap();
        let link = f.0.join("link");
        std::os::unix::fs::symlink(&target, &link).unwrap();
        assert!(
            export(&store.config.directory, &link, b"overwrite", true, &|| {
                false
            })
            .is_err()
        );
        assert_eq!(fs::read(target).unwrap(), b"untouched");
    }
}
#[test]
fn incomplete_final_session_line_is_visible_raw_without_losing_valid_rows() {
    let parsed = parse_session(
        "SingZ test\n2023-11-14T22:13:20.123Z [warn] engine: complete\n2023-11-14T22:",
    );
    assert_eq!(parsed.total, 3);
    assert_eq!(parsed.entries[1].line, "complete");
    assert_eq!(parsed.entries[2].timestamp_ms, None);
    assert_eq!(parsed.entries[2].line, "2023-11-14T22:");
}
#[cfg(target_os = "linux")]
#[test]
fn failed_partial_disk_writer_switches_to_live_without_failing_the_app() {
    let f = Fixture::new();
    let mut store = Store::new(f.config());
    store.session = Some((
        "session-1-1.log".into(),
        OpenOptions::new().write(true).open("/dev/full").unwrap(),
    ));
    store.push(entry("failure", Level::Warn));
    assert!(store.error.is_some());
    assert!(store.full);
    store.push(entry("later", Level::Info));
    assert_eq!(store.ring.back().unwrap().line, "later");
    assert!(store.pending.is_empty());
}
#[test]
fn worker_flushes_info_without_a_list_or_shutdown_fence() {
    let f = Fixture::new();
    let service = Service::new(f.config());
    let name = {
        let mut name = None;
        until(|| {
            name = service.snapshot().session_name.clone();
            name.is_some()
        });
        name.unwrap()
    };
    assert!(service.sink().log("test", "timer flush", Level::Info));
    let start = Instant::now();
    until(|| {
        fs::read_to_string(f.config().directory.join(&name))
            .unwrap()
            .contains("timer flush")
    });
    assert!(start.elapsed() < Duration::from_secs(2));
    let revision = service.revision();
    thread::sleep(Duration::from_millis(550));
    assert_eq!(
        service.revision(),
        revision,
        "idle worker must not force full-ring UI copies"
    );
}
#[test]
fn cancellation_is_polled_while_parsing_and_source_filename_digits_are_ascii() {
    let text = "raw\n".repeat(50000);
    let calls = AtomicU64::new(0);
    assert!(
        parse_session_cancellable(&text, &|| calls.fetch_add(1, Ordering::Relaxed) > 100).is_err()
    );
    assert!(calls.load(Ordering::Relaxed) < 200);
    assert!(!session_name("session-2026T00Z-١.log"));
    assert!(!session_name("session-2026T00Z-1.log/../other"));
    assert!(session_name("session-2026-11-07T01-02-03-004Z-123.log"));
}
#[test]
fn chunk_whitespace_uses_javascript_bom_and_not_unicode_next_line_trimming() {
    assert_eq!(js_trim("\u{feff} hello \u{feff}"), "hello");
    assert_eq!(js_trim("\u{85}hello\u{85}"), "\u{85}hello\u{85}");
    let parsed = parse_session("\u{feff}\n2023-11-14 [info] engine: date-only\n");
    assert_eq!(parsed.total, 1);
    assert_eq!(parsed.entries[0].timestamp_ms, Some(1_699_920_000_000));
}

#[test]
fn crash_record_survives_restart_and_is_reported_once() {
    let f = Fixture::new();
    let config = f.config();
    let record = serde_json::json!({"message":"test crash", "thread":"worker"});
    let path = write_crash(&config.directory, &record).unwrap();
    assert!(path.exists());
    {
        let service = Service::new(config.clone());
        assert!(report_crashes(&pending_crashes(&config.directory), &service.sink()));
        assert!(!report_crashes(&pending_crashes(&config.directory), &service.sink()));
    }
    {
        let service = Service::new(config.clone());
        assert!(!report_crashes(&pending_crashes(&config.directory), &service.sink()));
    }
    let logs: String = fs::read_dir(&config.directory).unwrap().filter_map(|entry| entry.ok())
        .filter(|e| e.path().extension().is_some_and(|s| s == "log"))
        .map(|e| fs::read_to_string(e.path()).unwrap()).collect();
    assert_eq!(logs.matches("Previous crash on worker: test crash").count(), 1);
}

#[test]
fn injected_worker_panic_records_and_keeps_process_alive() {
    if let Some(directory) = std::env::var_os("SINGZ_TEST_CRASH_WORKER") {
        let wake = install_panic_hook(directory.into(), "test");
        thread::sleep(Duration::from_secs(1));
        assert!(wake.try_recv().is_err(), "idle crash dispatcher woke without a panic");
        assert!(thread::spawn(|| std::panic::panic_any(String::from("injected worker panic"))).join().is_err());
        assert!(take_background_panic());
        assert!(wake.try_recv().is_ok(), "worker panic did not wake the UI");
        assert!(wake.try_recv().is_err(), "one panic must produce only one wake");
        return;
    }
    let f = Fixture::new();
    let result = std::process::Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "diagnostics::tests::injected_worker_panic_records_and_keeps_process_alive", "--nocapture"])
        .env("SINGZ_TEST_CRASH_WORKER", &f.0).output().unwrap();
    assert!(result.status.success(), "{}", String::from_utf8_lossy(&result.stderr));
    let record = fs::read_dir(&f.0).unwrap().next().unwrap().unwrap();
    let json: serde_json::Value = serde_json::from_slice(&fs::read(record.path()).unwrap()).unwrap();
    assert_eq!(json["message"], "injected worker panic");
    assert!(json["location"].as_str().unwrap().contains("diagnostics_tests.rs"));
}

#[cfg(unix)]
#[test]
fn injected_main_panic_retires_registered_child_and_closes_pipe() {
    use std::process::{Command, Stdio};
    if let Some(directory) = std::env::var_os("SINGZ_TEST_CRASH_MAIN") {
        let directory = PathBuf::from(directory);
        let _wake = install_panic_hook(directory.clone(), "test");
        let registered = Command::new("sleep").arg("60").stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        let registration = super::super::process_registry::Registration::new(&registered).unwrap();
        fs::write(directory.join("registered.pid"), registered.id().to_string()).unwrap();
        let eof = Command::new("cat").stdin(Stdio::piped()).stdout(Stdio::null()).stderr(Stdio::null()).spawn().unwrap();
        fs::write(directory.join("eof.pid"), eof.id().to_string()).unwrap();
        std::hint::black_box((&registered, &registration, &eof));
        panic!("injected main panic");
    }
    let f = Fixture::new();
    let result = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "diagnostics::tests::injected_main_panic_retires_registered_child_and_closes_pipe", "--nocapture"])
        .env("SINGZ_TEST_CRASH_MAIN", &f.0).output().unwrap();
    assert!(!result.status.success());
    let pids: Vec<i32> = ["registered.pid", "eof.pid"].into_iter()
        .map(|name| fs::read_to_string(f.0.join(name)).unwrap().parse().unwrap()).collect();
    let started = Instant::now();
    while pids.iter().any(|pid| unsafe { libc::kill(*pid, 0) == 0 }) && started.elapsed() < Duration::from_secs(2) {
        thread::sleep(Duration::from_millis(10));
    }
    let alive: Vec<_> = pids.into_iter().filter(|pid| unsafe { libc::kill(*pid, 0) == 0 }).collect();
    for pid in &alive { unsafe { libc::kill(*pid, libc::SIGKILL); } }
    assert!(alive.is_empty(), "children survived: {alive:?}");
    let crash = fs::read_dir(&f.0).unwrap().filter_map(|entry| entry.ok())
        .find(|e| e.file_name().to_string_lossy().starts_with("crash-")).unwrap();
    let json: serde_json::Value = serde_json::from_slice(&fs::read(crash.path()).unwrap()).unwrap();
    assert_eq!(json["message"], "injected main panic");
}

#[test]
fn crash_notice_dispatch_has_no_periodic_timer() {
    let source = include_str!("main.rs");
    let start = source.find("let crash_view = view.").expect("crash dispatch start");
    let end = source[start..].find("ui_crash::run(").expect("crash driver boundary") + start;
    assert!(!source[start..end].contains(".timer("), "crash notice dispatch must not add a periodic timer");
}

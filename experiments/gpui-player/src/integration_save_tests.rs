use super::*;
use std::{
    fs,
    sync::atomic::{AtomicU64, Ordering},
};
static SERIAL: AtomicU64 = AtomicU64::new(1);
struct Fixture {
    root: PathBuf,
    dir: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "singz-independent-save-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let dir = root.join("Песня 🦀");
        fs::create_dir(&dir).unwrap();
        fs::write(
            dir.join("project.json"),
            br#"{"version":2,"foreign":{"keep":7},"settings":{}}"#,
        )
        .unwrap();
        Self { root, dir }
    }
    fn enqueue(
        &self,
        service: &Service,
        epoch: u64,
        seq: u64,
        mix: crate::project_store::Mix,
    ) -> Result<()> {
        let (raw, hash) = crate::project_store::read(&self.dir, "project.json")?;
        service.enqueue(epoch, seq, self.dir.clone(), hash, raw, mix)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
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
        master: 0.7,
        transpose: 0,
        tempo: 1.,
        looping: false,
        selection: Some((0., 0.)),
        view: (0., 0.),
    }
}
fn service() -> (Service, mpsc::Receiver<Event>, Reanchors) {
    let (tx, rx) = mpsc::channel();
    let anchors = Arc::new(Mutex::new(vec![]));
    let service = Service::with_marker(tx, anchors.clone(), Arc::new(|_, _| Ok(())));
    (service, rx, anchors)
}
#[test]
fn intent_registration_is_filesystem_free_and_reference_counted() {
    let f = Fixture::new();
    let missing = f.root.join("not-created");
    let first = crate::project_publish::write_intent(&missing).unwrap();
    let second = crate::project_publish::write_intent(&missing).unwrap();
    assert!(!missing.exists());
    assert!(crate::project_publish::write_pending(&missing));
    drop(first);
    assert!(crate::project_publish::write_pending(&missing));
    drop(second);
    assert!(!crate::project_publish::write_pending(&missing));
    assert!(crate::project_publish::write_intent(std::path::Path::new("relative")).is_err());
    // PathBuf::join normalizes parent components in Windows verbatim paths.
    // Preserve the literal invalid input that this admission check must refuse.
    let mut dotted = f.root.as_os_str().to_owned();
    dotted.push(format!("{0}..{0}outside", std::path::MAIN_SEPARATOR));
    assert!(crate::project_publish::write_intent(&PathBuf::from(dotted)).is_err());
}
#[test]
fn accepted_save_waits_for_real_writer_lease_without_acknowledging_or_blocking_caller() {
    let f = Fixture::new();
    let (mut service, events, _) = service();
    let before = fs::read(f.dir.join("project.json")).unwrap();
    let lease = crate::project_publish::lock(&f.dir).unwrap();
    let started = Instant::now();
    f.enqueue(&service, 11, 4, mix()).unwrap();
    assert!(started.elapsed() < Duration::from_secs(1));
    assert!(crate::project_publish::write_pending(&f.dir));
    assert!(matches!(
        events.recv_timeout(Duration::from_millis(80)),
        Err(mpsc::RecvTimeoutError::Timeout)
    ));
    assert_eq!(fs::read(f.dir.join("project.json")).unwrap(), before);
    drop(lease);
    match events.recv_timeout(Duration::from_secs(3)).unwrap() {
        Event::Saved(11, 4, raw, hash, _, _, _) => {
            assert_eq!(raw["foreign"]["keep"], 7);
            assert_eq!(raw["settings"]["masterVolume"], 0.7);
            assert_eq!(
                crate::project_store::read(&f.dir, "project.json")
                    .unwrap()
                    .1,
                hash
            );
        }
        _ => panic!("Expected actual committed Save receipt"),
    }
    service.finish();
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn navigation_does_not_cancel_captured_epoch_and_shutdown_flushes_accepted_save() {
    let f = Fixture::new();
    let (mut service, events, _) = service();
    let lease = crate::project_publish::lock(&f.dir).unwrap();
    f.enqueue(&service, 3, 8, mix()).unwrap();
    // No playback epoch/alive token is borrowed by this accepted request.
    let release = thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        drop(lease);
    });
    service.finish();
    release.join().unwrap();
    assert!(matches!(
        events.try_recv().unwrap(),
        Event::Saved(3, 8, _, _, _, _, _)
    ));
    assert_eq!(
        crate::project_store::read(&f.dir, "project.json")
            .unwrap()
            .0["settings"]["nativeEmptyTracks"],
        true
    );
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn external_edit_while_waiting_is_preserved_by_original_cas() {
    let f = Fixture::new();
    let (mut service, events, _) = service();
    let lease = crate::project_publish::lock(&f.dir).unwrap();
    f.enqueue(&service, 7, 1, mix()).unwrap();
    let changed = br#"{"version":2,"external":"new words"}"#;
    fs::write(f.dir.join("project.json"), changed).unwrap();
    drop(lease);
    match events.recv_timeout(Duration::from_secs(3)).unwrap() {
        Event::SaveFailed(7, error) => assert!(error.contains("changed outside"), "{error}"),
        _ => panic!("External edit must refuse Save"),
    }
    service.finish();
    assert_eq!(fs::read(f.dir.join("project.json")).unwrap(), changed);
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn bounded_queue_rejection_drops_only_its_intent() {
    let f = Fixture::new();
    let other = Fixture::new();
    // Hold the receiver rather than racing the OS scheduler. This exercises
    // actual admission and channel-full ownership of the write-intent guard.
    let (tx, receiver) = mpsc::sync_channel(1);
    let service = Service {
        requests: Some(tx),
        shutdown: Arc::new(Mutex::new(None)),
        worker: None,
        marker: None,
    };
    f.enqueue(&service, 1, 1, mix()).unwrap();
    assert!(other.enqueue(&service, 2, 1, mix()).is_err());
    assert!(!crate::project_publish::write_pending(&other.dir));
    assert!(crate::project_publish::write_pending(&f.dir));
    drop(receiver);
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn custom_reanchors_and_stamps_are_queued_before_saved_receipt() {
    let f = Fixture::new();
    let (mut service, events, anchors) = service();
    let source = f.root.join("Harmony.flac");
    fs::write(&source, b"fLaC retained encoded source").unwrap();
    let mut desired = mix();
    desired.lanes = vec![7];
    desired.selection = Some((0., 3.));
    desired.view = (0., 3.);
    desired.custom.push(crate::tracks::Lane {
        id: "custom-harmony".into(),
        slot: 7,
        label: "Голос 🦀".into(),
        color: "#8fd3ff".into(),
        file: source.clone(),
        custom: true,
    });
    f.enqueue(&service, 14, 9, desired).unwrap();
    match events.recv_timeout(Duration::from_secs(3)).unwrap() {
        Event::Saved(14, 9, _, _, custom, _, stamps) => {
            assert_eq!(custom.len(), 1);
            assert!(custom[0].file.starts_with(&f.dir));
            assert_eq!(
                fs::read(&custom[0].file).unwrap(),
                fs::read(source).unwrap()
            );
            assert_eq!(
                stamps[0].1,
                crate::project_analysis::stamp(&custom[0].file).unwrap()
            );
            let anchors = anchors.lock().unwrap();
            assert_eq!(anchors[0].epoch, 14);
            assert_eq!(anchors[0].dir, f.dir);
            assert_eq!(anchors[0].custom[0].file, custom[0].file);
            assert_eq!(anchors[0].stamps, stamps);
        }
        _ => panic!("Expected saved custom sources"),
    }
    service.finish();
}
#[test]
fn dirty_ledger_failure_is_a_saved_warning_not_a_false_unsaved_error() {
    let f = Fixture::new();
    let (tx, rx) = mpsc::channel();
    let mut service = Service::with_marker(
        tx,
        Arc::new(Mutex::new(vec![])),
        {
            // The first edge (before the bytes) succeeds; the second fails.
            let calls = std::sync::atomic::AtomicUsize::new(0);
            Arc::new(move |_, _| {
                if calls.fetch_add(1, std::sync::atomic::Ordering::SeqCst) == 0 {
                    Ok(())
                } else {
                    anyhow::bail!("fixture ledger unavailable")
                }
            })
        },
    );
    f.enqueue(&service, 2, 1, mix()).unwrap();
    match rx.recv_timeout(Duration::from_secs(3)).unwrap() {
        Event::Saved(2, 1, _, hash, _, warnings, _) => {
            assert!(
                warnings
                    .iter()
                    .any(|w| w.contains("fixture ledger unavailable"))
            );
            assert_eq!(
                crate::project_store::read(&f.dir, "project.json")
                    .unwrap()
                    .1,
                hash
            );
        }
        _ => panic!("Publication already committed"),
    }
    service.finish();
}
#[test]
fn only_typed_would_block_is_retriable() {
    assert!(writer_busy(
        &anyhow::Error::new(std::io::Error::from(std::io::ErrorKind::WouldBlock))
            .context("writer lock")
    ));
    assert!(!writer_busy(&anyhow::anyhow!(
        "Project is already being saved or split"
    )));
    assert!(!writer_busy(&anyhow::Error::new(std::io::Error::from(
        std::io::ErrorKind::PermissionDenied
    ))));
}
#[test]
fn shutdown_deadline_refuses_waiting_uncommitted_save_and_releases_intent() {
    let f = Fixture::new();
    let (mut service, events, _) = service();
    let before = fs::read(f.dir.join("project.json")).unwrap();
    let _lease = crate::project_publish::lock(&f.dir).unwrap();
    f.enqueue(&service, 19, 1, mix()).unwrap();
    service.finish_by(Instant::now() + Duration::from_millis(80));
    match events.try_recv().unwrap() {
        Event::SaveFailed(19, error) => assert!(error.contains("shutdown"), "{error}"),
        _ => panic!("Uncommitted save cannot report success"),
    }
    assert_eq!(fs::read(f.dir.join("project.json")).unwrap(), before);
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn stopped_worker_rejects_admission_without_leaking_capture_priority() {
    let f = Fixture::new();
    let (mut service, _, _) = service();
    service.finish();
    assert!(f.enqueue(&service, 1, 1, mix()).is_err());
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn queued_saves_keep_their_captured_cas_instead_of_overwriting_a_newer_save() {
    let f = Fixture::new();
    let (mut service, events, _) = service();
    let lease = crate::project_publish::lock(&f.dir).unwrap();
    let mut first = mix();
    first.master = 0.4;
    let mut second = mix();
    second.master = 0.9;
    f.enqueue(&service, 1, 1, first).unwrap();
    f.enqueue(&service, 2, 2, second).unwrap();
    drop(lease);
    service.finish();
    assert!(matches!(
        events.try_recv().unwrap(),
        Event::Saved(1, 1, _, _, _, _, _)
    ));
    match events.try_recv().unwrap() {
        Event::SaveFailed(2, error) => assert!(error.contains("changed outside"), "{error}"),
        _ => panic!("Captured CAS must reject overwriting the first save"),
    }
    assert_eq!(
        crate::project_store::read(&f.dir, "project.json")
            .unwrap()
            .0["settings"]["masterVolume"],
        0.4
    );
}

// Real ledger in a temp directory: marks go through the production writer.
fn ledger_mark(store: &crate::sync_dirty::Store) -> Mark {
    let store = store.clone();
    Arc::new(move |dir, cancel| store.mark_project_until(dir, "saved", cancel))
}
// First edge per project: healthy. Second edge: a real ledger store whose replace
// is denied forever, so the real writer retries while holding the real lease
// until the shutdown deadline cancels it.
fn busy_after_edge(store: &crate::sync_dirty::Store) -> Mark {
    let healthy = store.clone();
    let busy = store.with_persistent_replace_denial(Duration::from_secs(60));
    let seen = Mutex::new(std::collections::HashSet::<PathBuf>::new());
    Arc::new(move |dir, cancel| {
        if seen.lock().unwrap().insert(dir.to_path_buf()) {
            healthy.mark_project_until(dir, "saved", cancel)
        } else {
            busy.mark_project_until(dir, "saved", cancel)
        }
    })
}
#[test]
fn busy_after_marks_never_starve_queued_saves_at_shutdown_and_the_projects_stay_dirty() {
    // Two accepted saves for different projects; the second edge of the first
    // retries on the real ledger lease until the shutdown deadline cancels it.
    // Real contract: each save either drains (committed, marked, warns) or is
    // refused safely (nothing published, not marked); never a partial.
    let f = Fixture::new();
    let second = f.root.join("Second project");
    fs::create_dir(&second).unwrap();
    fs::write(second.join("project.json"), br#"{"version":2,"settings":{}}"#).unwrap();
    let store = crate::sync_dirty::Store::new(f.root.join("ledger"));
    let (tx, rx) = mpsc::channel();
    let mut service = Service::with_hooks(
        tx,
        Arc::new(Mutex::new(vec![])),
        Hooks { mark: busy_after_edge(&store), startup: None },
    );
    f.enqueue(&service, 1, 1, mix()).unwrap();
    let (raw, hash) = crate::project_store::read(&second, "project.json").unwrap();
    service.enqueue(2, 1, second.clone(), hash, raw, mix()).unwrap();
    // The first save always commits: its first edge runs before anything holds
    // the ledger lease.
    let committed = |dir: &PathBuf| {
        crate::project_store::read(dir, "project.json")
            .is_ok_and(|(raw, _)| raw["settings"]["nativeEmptyTracks"] == true)
    };
    let patience = Instant::now() + Duration::from_secs(20);
    while !committed(&f.dir) {
        assert!(Instant::now() < patience, "the first save never committed");
        thread::sleep(Duration::from_millis(5));
    }
    let started = Instant::now();
    service.finish_by(Instant::now() + Duration::from_millis(400));
    // The real writer is cancelled out of its 60 s retry window at the deadline.
    assert!(started.elapsed() < Duration::from_secs(5), "{:?}", started.elapsed());
    let (mut saved, mut refused, mut cancelled) = (vec![], vec![], vec![]);
    while let Ok(event) = rx.try_recv() {
        match event {
            Event::Saved(epoch, _, _, _, _, warnings, _) => {
                // Successful drain: committed; the stuck second edge only warns.
                assert!(warnings.iter().any(|w| w.contains("already marked")), "{warnings:?}");
                saved.push(epoch);
            }
            Event::SaveFailed(epoch, error) if error.contains("nothing was saved") => {
                // Safe refusal: the first edge could not run (the real lease was
                // held by the first save's retrying second edge), so nothing
                // was published.
                refused.push(epoch);
            }
            Event::SaveFailed(epoch, error) => {
                // The second save's first edge can win the lease before the
                // first save's second edge takes it; under load its commit then
                // meets the deadline. The commit is cancelled before publishing
                // and the project stays marked from its first edge.
                assert!(
                    error.starts_with("Custom track save cancelled")
                        || error.starts_with("Project save did not finish before shutdown"),
                    "{error}"
                );
                cancelled.push(epoch);
            }
            _ => {}
        }
    }
    assert!(saved.contains(&1), "{saved:?} {refused:?} {cancelled:?}");
    assert_eq!(
        saved.len() + refused.len() + cancelled.len(),
        2,
        "{saved:?} {refused:?} {cancelled:?}"
    );
    let dirs = store.snapshot().unwrap().dirs;
    assert!(dirs.contains_key(f.dir.to_str().unwrap()));
    if saved.contains(&2) {
        assert!(committed(&second));
        assert!(dirs.contains_key(second.to_str().unwrap()));
    } else if cancelled.contains(&2) {
        assert!(!committed(&second), "a cancelled commit must not publish");
        assert!(dirs.contains_key(second.to_str().unwrap()), "its first edge marked it");
    } else {
        assert!(!committed(&second), "a refused save must not publish");
        assert!(!dirs.contains_key(second.to_str().unwrap()));
    }
}
#[test]
fn a_refused_before_mark_publishes_nothing_and_reports_a_failed_save() {
    let f = Fixture::new();
    let before = fs::read(f.dir.join("project.json")).unwrap();
    let (tx, rx) = mpsc::channel();
    let mut service = Service::with_hooks(
        tx,
        Arc::new(Mutex::new(vec![])),
        Hooks {
            mark: Arc::new(|_, _| anyhow::bail!("ledger unwritable")),
            startup: None,
        },
    );
    f.enqueue(&service, 4, 1, mix()).unwrap();
    service.finish();
    match rx.try_recv().unwrap() {
        Event::SaveFailed(4, error) => {
            assert!(error.contains("nothing was saved") && error.contains("unwritable"), "{error}")
        }
        _ => panic!("A save whose first mark failed must be refused"),
    }
    assert_eq!(fs::read(f.dir.join("project.json")).unwrap(), before);
    assert!(!crate::project_publish::write_pending(&f.dir));
}
#[test]
fn a_cancelled_before_mark_at_the_shutdown_deadline_refuses_the_queued_save() {
    // The shutdown deadline passes while the first mark is busy; nothing is published.
    let f = Fixture::new();
    let before = fs::read(f.dir.join("project.json")).unwrap();
    let (tx, rx) = mpsc::channel();
    let mut service = Service::with_hooks(
        tx,
        Arc::new(Mutex::new(vec![])),
        Hooks {
            mark: Arc::new(|_, cancel| {
                while !cancel() {
                    thread::sleep(Duration::from_millis(2));
                }
                anyhow::bail!("ledger busy until cancelled")
            }),
            startup: None,
        },
    );
    f.enqueue(&service, 5, 1, mix()).unwrap();
    service.finish_by(Instant::now() + Duration::from_millis(200));
    assert!(matches!(rx.try_recv().unwrap(), Event::SaveFailed(5, _)));
    assert_eq!(fs::read(f.dir.join("project.json")).unwrap(), before);
}
#[test]
fn quit_during_startup_retirement_does_not_wait_out_the_retry_window() {
    let f = Fixture::new();
    let (tx, _rx) = mpsc::channel();
    let mut service = Service::with_hooks(
        tx,
        Arc::new(Mutex::new(vec![])),
        Hooks {
            mark: Arc::new(|_, _| Ok(())),
            // Retirement stuck on a busy ledger until it is cancelled.
            startup: Some(Arc::new(|cancel| {
                while !cancel() {
                    thread::sleep(Duration::from_millis(2));
                }
            })),
        },
    );
    let _ = &f;
    let started = Instant::now();
    service.finish_by(Instant::now() + Duration::from_millis(300));
    assert!(started.elapsed() < Duration::from_secs(3), "{:?}", started.elapsed());
}

#[test]
fn a_failed_commit_still_runs_the_second_edge_and_is_reported_not_saved() {
    let f = Fixture::new();
    let calls = Arc::new(std::sync::atomic::AtomicUsize::new(0));
    let counted = calls.clone();
    let (tx, rx) = mpsc::channel();
    let mut service = Service::with_marker(
        tx,
        Arc::new(Mutex::new(vec![])),
        Arc::new(move |_, _| {
            counted.fetch_add(1, std::sync::atomic::Ordering::SeqCst);
            Ok(())
        }),
    );
    let (raw, _) = crate::project_store::read(&f.dir, "project.json").unwrap();
    // A stale expected hash makes the commit attempt fail.
    service.enqueue(6, 1, f.dir.clone(), "stale".into(), raw, mix()).unwrap();
    service.finish();
    match rx.try_recv().unwrap() {
        Event::SaveFailed(6, error) => assert!(!error.contains("was saved"), "{error}"),
        _ => panic!("A failed commit reports a failed save"),
    }
    assert_eq!(calls.load(std::sync::atomic::Ordering::SeqCst), 2, "both edges ran");
}
#[test]
fn a_committed_cleanup_failure_is_reported_as_saved_with_unfinished_cleanup() {
    let committed = anyhow::anyhow!("remove staging").context(crate::project_publish::CommittedCleanupFailed);
    let text = failed_receipt(&committed);
    assert!(text.starts_with("Project was saved"), "{text}");
    assert!(text.contains("cleanup"), "{text}");
    let refused = failed_receipt(&anyhow::anyhow!("Project changed outside this app"));
    assert_eq!(refused, "Project changed outside this app");
}

#[test]
fn a_post_commit_failure_through_extra_context_still_reports_saved() {
    // commit_custom wraps the publication error in further context on its way
    // to the worker; the typed classification must survive that.
    let committed = anyhow::anyhow!("Injected directory sync failure")
        .context(crate::project_publish::CommittedCleanupFailed)
        .context("Publishing split project");
    assert!(failed_receipt(&committed).starts_with("Project was saved"));
}

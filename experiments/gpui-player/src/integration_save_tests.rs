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
    let service = Service::with_marker(tx, anchors.clone(), Arc::new(|_| Ok(())));
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
        Arc::new(|_| anyhow::bail!("fixture ledger unavailable")),
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

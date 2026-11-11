use super::*;

#[test]
fn full_delete_queue_never_revokes_the_loaded_epoch() {
    let (send, _receive) = mpsc::sync_channel::<(u64, Arc<AtomicU8>)>(0);
    let epoch = AtomicU64::new(33);
    assert!(admit_delete_request(&send, &epoch, true, |e, a| (e, a)).is_err());
    assert_eq!(epoch.load(Ordering::Acquire), 33);
}
#[test]
fn loaded_delete_is_armed_only_after_committing_its_new_epoch() {
    let (send, receive) = mpsc::sync_channel(1);
    let epoch = AtomicU64::new(33);
    let accepted = admit_delete_request(&send, &epoch, true, |e, a| {
        assert_eq!(epoch.load(Ordering::Acquire), 33);
        assert_eq!(a.load(Ordering::Acquire), 0);
        (e, a)
    })
    .unwrap();
    let (queued, armed) = receive.try_recv().unwrap();
    assert_eq!(accepted, 34);
    assert_eq!(queued, 34);
    assert_eq!(epoch.load(Ordering::Acquire), 34);
    assert_eq!(armed.load(Ordering::Acquire), 1);
}
#[test]
fn unrelated_delete_preserves_epoch_and_can_be_admitted_at_max_epoch() {
    let (send, receive) = mpsc::sync_channel(1);
    let epoch = AtomicU64::new(u64::MAX);
    assert_eq!(
        admit_delete_request(&send, &epoch, false, |e, a| (e, a)).unwrap(),
        u64::MAX
    );
    let (queued, armed) = receive.try_recv().unwrap();
    assert_eq!(queued, u64::MAX);
    assert_eq!(armed.load(Ordering::Acquire), 1);
    assert_eq!(epoch.load(Ordering::Acquire), u64::MAX);
}
#[test]
fn exhausted_loaded_epoch_does_not_queue_destructive_work() {
    let (send, receive) = mpsc::sync_channel::<(u64, Arc<AtomicU8>)>(1);
    let epoch = AtomicU64::new(u64::MAX);
    assert!(admit_delete_request(&send, &epoch, true, |e, a| (e, a)).is_err());
    assert!(receive.try_recv().is_err());
    assert_eq!(epoch.load(Ordering::Acquire), u64::MAX);
}
#[test]
fn concurrent_navigation_aborts_admitted_delete_without_rolling_back_newer_epoch() {
    let (send, receive) = mpsc::sync_channel(1);
    let epoch = AtomicU64::new(33);
    let result = admit_delete_request(&send, &epoch, true, |e, a| {
        epoch.store(60, Ordering::Release);
        (e, a)
    });
    assert!(result.is_err());
    let (queued, armed) = receive.try_recv().unwrap();
    assert_eq!(queued, 34);
    assert_eq!(armed.load(Ordering::Acquire), 2);
    assert_eq!(epoch.load(Ordering::Acquire), 60);
}
#[test]
fn accepted_unrelated_delete_survives_navigation_but_loaded_delete_cancels() {
    let latest = AtomicU64::new(33);
    let alive = AtomicBool::new(true);
    assert!(!delete_cancelled(true, 33, &latest, &alive));
    latest.store(34, Ordering::Release);
    assert!(delete_cancelled(true, 33, &latest, &alive));
    assert!(!delete_cancelled(false, 33, &latest, &alive));
    alive.store(false, Ordering::Release);
    assert!(delete_cancelled(true, 33, &latest, &alive));
    assert!(delete_cancelled(false, 33, &latest, &alive));
}
#[test]
fn real_inspection_worker_returns_authoritative_identity_and_serial_without_audio() {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let root = std::env::temp_dir().join(format!(
        "singz-delete-dispatch-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    fs::create_dir(&root).unwrap();
    let root = root.canonicalize().unwrap();
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let _cleanup = Cleanup(root.clone());
    let dir = root.join("Тихий проект 🎤");
    fs::create_dir(&dir).unwrap();
    fs::create_dir(dir.join("stems")).unwrap();
    fs::write(
        dir.join("project.json"),
        br#"{"version":2,"name":"Authoritative name"}"#,
    )
    .unwrap();
    fs::write(
        dir.join("stems/vocals.wav"),
        b"fixture content; inspection does not decode audio",
    )
    .unwrap();
    fs::write(dir.join("lyrics.json"), b"{}").unwrap();
    let (send, receive) = mpsc::sync_channel(1);
    let (events, receipts) = mpsc::channel();
    let alive = Arc::new(AtomicBool::new(true));
    let running = alive.clone();
    let worker = thread::spawn(move || inspect_delete_requests(receive, events, running));
    send.send((root.clone(), dir.clone(), 41)).unwrap();
    let Event::DeleteInspected(serial, result) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("Wrong inspection event")
    };
    let target = result.unwrap();
    assert_eq!(serial, 41);
    assert_eq!(target.root, root);
    assert_eq!(target.dir, dir);
    assert_eq!(target.name, "Authoritative name");
    assert_eq!(target.stem_count, 1);
    assert!(target.has_lyrics);
    assert!(target.bytes > 0);
    send.send((root.clone(), root.join("missing"), 42)).unwrap();
    let Event::DeleteInspected(serial, result) =
        receipts.recv_timeout(Duration::from_secs(5)).unwrap()
    else {
        panic!("Wrong inspection error")
    };
    assert_eq!(serial, 42);
    assert!(result.is_err());
    alive.store(false, Ordering::Release);
    drop(send);
    worker.join().unwrap();
    assert!(receipts.try_recv().is_err());
    assert!(dir.join("project.json").exists());
}

struct RecoveryFixture {
    root: PathBuf,
    dir: PathBuf,
}
impl RecoveryFixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "singz-delete-reopen-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let dir = root.join("project");
        write_recovery_project(&dir, "Original");
        Self { root, dir }
    }
    fn confirmed(&self) -> crate::project_delete::Target {
        crate::project_delete::inspect(&self.root, &self.dir).unwrap()
    }
}
impl Drop for RecoveryFixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn write_recovery_project(dir: &Path, name: &str) {
    fs::create_dir(dir).unwrap();
    fs::create_dir(dir.join("stems")).unwrap();
    fs::write(
        dir.join("project.json"),
        serde_json::to_vec(&serde_json::json!({"version":2,"name":name,"settings":{}})).unwrap(),
    )
    .unwrap();
    // This boundary inspects saved metadata/stamps and does not decode audio.
    fs::write(dir.join("stems/vocals.wav"), b"fixture media member").unwrap();
}
#[test]
fn deletion_recovery_accepts_external_metadata_edits_in_original_folder() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    fs::write(
        f.dir.join("project.json"),
        br#"{"version":2,"name":"Externally edited original","settings":{},"foreign":"keep"}"#,
    )
    .unwrap();
    let project = read_open_project(&f.dir, Some(&confirmed)).unwrap();
    assert_eq!(project.name, "Externally edited original");
    assert_eq!(project.raw["foreign"], "keep");
    assert_ne!(project.metadata_hash, confirmed.metadata_hash);
}
#[test]
fn deletion_recovery_never_opens_a_valid_replacement_at_the_old_path() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    fs::rename(&f.dir, f.root.join("recoverable-original")).unwrap();
    write_recovery_project(&f.dir, "Unrelated replacement");
    // Show that this is a genuinely readable foreign project, not malformed
    // input that would fail regardless of the identity guard.
    assert_eq!(
        read_open_project(&f.dir, None).unwrap().name,
        "Unrelated replacement"
    );
    assert!(
        read_open_project(&f.dir, Some(&confirmed))
            .unwrap_err()
            .to_string()
            .contains("original project folder")
    );
    assert!(f.root.join("recoverable-original/project.json").exists());
}
#[test]
fn deletion_recovery_refuses_a_different_path_before_reading_its_metadata() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    let other = f.root.join("other");
    write_recovery_project(&other, "Other");
    let read = AtomicBool::new(false);
    let result = read_open_project_using(&other, Some(&confirmed), |path| {
        read.store(true, Ordering::Release);
        read_project(path)
    });
    assert!(result.is_err());
    assert!(!read.load(Ordering::Acquire));
    assert!(other.join("project.json").exists());
}
#[test]
fn deletion_recovery_rechecks_identity_after_read_before_audio_prepare() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    let result = read_open_project_using(&f.dir, Some(&confirmed), |path| {
        let original = read_project(path)?;
        fs::rename(path, f.root.join("original-moved-during-read"))?;
        write_recovery_project(path, "Replacement during read");
        Ok(original)
    });
    assert!(
        result
            .unwrap_err()
            .to_string()
            .contains("original project folder")
    );
    assert_eq!(
        read_project(&f.dir).unwrap().name,
        "Replacement during read"
    );
}

struct PreparedMedia {
    _file: fs::File,
    released: Arc<AtomicBool>,
}
impl Drop for PreparedMedia {
    fn drop(&mut self) {
        self.released.store(true, Ordering::Release);
    }
}
fn prepared_media(f: &RecoveryFixture, released: Arc<AtomicBool>) -> PreparedMedia {
    let source = f.dir.join("stems/vocals.wav");
    #[cfg(windows)]
    let source = {
        // Windows pins an entire directory while a child descriptor is open.
        // Represent a decoder's already-prepared, independently owned media
        // with a real private copy, so the subsequent folder swap is reachable.
        // The separate kernel-pin test below covers a retained source handle.
        let prepared = f.root.join("native-prepared-media.wav");
        fs::copy(&source, &prepared).unwrap();
        prepared
    };
    PreparedMedia {
        _file: fs::File::open(source).unwrap(),
        released,
    }
}
#[test]
fn deletion_recovery_drops_prepared_media_if_folder_changes_during_prepare() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    assert_eq!(
        read_open_project(&f.dir, Some(&confirmed)).unwrap().name,
        "Original"
    );
    let released = Arc::new(AtomicBool::new(false));
    // Use a real pinned media descriptor at the same ownership boundary as
    // Connection::open, without claiming that this test starts an audio helper.
    let prepared = prepared_media(&f, released.clone());
    fs::rename(&f.dir, f.root.join("original-during-prepare")).unwrap();
    write_recovery_project(&f.dir, "Foreign during native prepare");
    let failure = checked_delete_recovery(&f.dir, Some(&confirmed), prepared)
        .err()
        .unwrap();
    assert!(failure.to_string().contains("original project folder"));
    assert!(released.load(Ordering::Acquire));
    assert_eq!(
        read_project(&f.dir).unwrap().name,
        "Foreign during native prepare"
    );
    assert!(f.root.join("original-during-prepare/project.json").exists());
}
#[test]
fn deletion_recovery_rechecks_after_prepare_configuration_before_adoption() {
    let f = RecoveryFixture::new();
    let confirmed = f.confirmed();
    let released = Arc::new(AtomicBool::new(false));
    let prepared = checked_delete_recovery(
        &f.dir,
        Some(&confirmed),
        prepared_media(&f, released.clone()),
    )
    .unwrap_or_else(|e| panic!("Initial prepare check failed: {e}"));
    assert!(!released.load(Ordering::Acquire));
    fs::rename(&f.dir, f.root.join("original-before-adoption")).unwrap();
    write_recovery_project(&f.dir, "Foreign before Opened");
    assert!(checked_delete_recovery(&f.dir, Some(&confirmed), prepared).is_err());
    assert!(released.load(Ordering::Acquire));
    assert_eq!(read_project(&f.dir).unwrap().name, "Foreign before Opened");
}

#[cfg(windows)]
#[test]
fn windows_source_media_handle_prevents_folder_replacement_until_release() {
    let f = RecoveryFixture::new();
    let source = fs::File::open(f.dir.join("stems/vocals.wav")).unwrap();
    let moved = f.root.join("after-source-release");
    assert_eq!(
        fs::rename(&f.dir, &moved).unwrap_err().kind(),
        std::io::ErrorKind::PermissionDenied
    );
    assert!(f.dir.join("project.json").exists());
    drop(source);
    fs::rename(&f.dir, &moved).unwrap();
    assert!(!f.dir.exists() && moved.join("project.json").exists());
}

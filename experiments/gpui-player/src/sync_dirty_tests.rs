use super::*;
use std::sync::{Arc, Barrier};
struct Fixture {
    root: PathBuf,
    store: Store,
}
impl Fixture {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "singz-dirty-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        let root = path.canonicalize().unwrap();
        Self {
            store: Store::new(root.join("config")),
            root,
        }
    }
    fn dir(&self, name: &str) -> PathBuf {
        self.root.join("projects").join(name)
    }
    fn write(&self, value: Value) {
        fs::create_dir_all(&self.store.directory).unwrap();
        fs::write(
            self.store.directory.join(NAME),
            serde_json::to_vec(&value).unwrap(),
        )
        .unwrap();
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}

#[test]
fn absent_state_is_clean_and_snapshot_does_not_create_preferences() {
    let f = Fixture::new();
    assert_eq!(f.store.snapshot().unwrap(), Snapshot::default());
    assert!(!f.store.directory.exists());
}
#[test]
fn repeated_marks_advance_sequence_without_resetting_first_dirty_time() {
    let f = Fixture::new();
    let a = f.dir("A");
    f.store.mark_project(&a, "lyrics").unwrap();
    let first = f.store.snapshot().unwrap();
    assert_eq!(first.seq, 1);
    assert_eq!(first.dirs[a.to_str().unwrap()], 1);
    assert!(first.since.is_some());
    f.store.mark_project(&a, "corrected again").unwrap();
    let second = f.store.snapshot().unwrap();
    assert_eq!(second.seq, 2);
    assert_eq!(second.dirs.len(), 1);
    assert_eq!(second.dirs[a.to_str().unwrap()], 2);
    assert_eq!(second.since, first.since);
}
#[test]
fn clear_high_water_preserves_inflight_marks_even_on_the_same_project() {
    let f = Fixture::new();
    let a = f.dir("A");
    let b = f.dir("B");
    f.store.mark_project(&a, "before sync").unwrap();
    let captured = f.store.snapshot().unwrap().seq;
    f.store.mark_project(&a, "changed while syncing").unwrap();
    f.store.mark_project(&b, "new while syncing").unwrap();
    let since = f.store.snapshot().unwrap().since;
    let retained = f.store.clear(captured).unwrap();
    assert_eq!(retained.seq, 3);
    assert_eq!(retained.dirs.len(), 2);
    assert_eq!(retained.dirs[a.to_str().unwrap()], 2);
    assert_eq!(retained.since, since);
    let clean = f.store.clear(3).unwrap();
    assert_eq!(clean.seq, 3);
    assert!(!clean.is_dirty());
    assert_eq!(clean.since, None);
    assert!(
        read(&f.store.directory).unwrap().raw["gdriveDirty"]
            .get("since")
            .is_none()
    );
    f.store.mark_project(&a, "next cycle").unwrap();
    assert_eq!(f.store.snapshot().unwrap().seq, 4);
}
#[test]
fn one_hundred_distinct_projects_escalate_only_on_the_next_new_directory() {
    let f = Fixture::new();
    for index in 0..100 {
        f.store
            .mark_project(&f.dir(&format!("song-{index}")), "lyrics")
            .unwrap();
    }
    let full = f.store.snapshot().unwrap();
    assert_eq!(full.seq, 100);
    assert_eq!(full.dirs.len(), 100);
    assert_eq!(full.all_seq, 0);
    f.store
        .mark_project(&f.dir("song-0"), "same project")
        .unwrap();
    assert_eq!(f.store.snapshot().unwrap().dirs.len(), 100);
    f.store
        .mark_project(&f.dir("new song"), "cap exceeded")
        .unwrap();
    let whole = f.store.snapshot().unwrap();
    assert_eq!(whole.seq, 102);
    assert_eq!(whole.all_seq, 102);
    assert!(whole.dirs.is_empty());
    f.store
        .mark_project(&f.dir("late song"), "inflight")
        .unwrap();
    let clear = f.store.clear(102).unwrap();
    assert_eq!(clear.all_seq, 0);
    assert_eq!(clear.seq, 103);
    assert_eq!(clear.dirs.len(), 1);
    assert!(clear.is_dirty());
    assert_eq!(clear.since, full.since);
}
#[test]
fn whole_library_marks_replace_individuals_and_clear_retains_a_newer_whole_mark() {
    let f = Fixture::new();
    f.store.mark_project(&f.dir("A"), "lyrics").unwrap();
    f.store.mark_library("library moved").unwrap();
    let captured = f.store.snapshot().unwrap();
    assert_eq!(captured.all_seq, 2);
    assert!(captured.dirs.is_empty());
    f.store.mark_library("another root change").unwrap();
    let retained = f.store.clear(captured.seq).unwrap();
    assert_eq!(retained.all_seq, 3);
    assert!(retained.is_dirty());
    assert_eq!(retained.since, captured.since);
    assert!(!f.store.clear(3).unwrap().is_dirty());
}
#[test]
fn file_marks_ignore_cache_lyrics_until_the_surrounding_project_exists() {
    let f = Fixture::new();
    let dir = f.dir("Saved");
    fs::create_dir_all(&dir).unwrap();
    let lyrics = dir.join("lyrics.json");
    fs::write(&lyrics, b"{}").unwrap();
    f.store.mark_file(&lyrics, "cache only").unwrap();
    assert!(!f.store.directory.exists());
    fs::write(dir.join("project.json"), b"{}").unwrap();
    f.store.mark_file(&lyrics, "saved project").unwrap();
    assert_eq!(f.store.snapshot().unwrap().dirs[dir.to_str().unwrap()], 1);
    // Explicit marks also cover removed/renamed project paths, unlike file marks.
    let removed = f.dir("Old name");
    f.store.mark_project(&removed, "rename old edge").unwrap();
    assert!(
        f.store
            .snapshot()
            .unwrap()
            .dirs
            .contains_key(removed.to_str().unwrap())
    );
}
#[test]
fn unknown_root_and_dirty_fields_survive_marks_and_high_water_clear() {
    let f = Fixture::new();
    f.write(json!({"version":1,"foreign":{"large":1234567890123456789u64},"gdriveDirty":{"seq":0,"dirs":{},"allSeq":0,"future":{"keep":true}}}));
    f.store.mark_project(&f.dir("A"), "lyrics").unwrap();
    f.store.clear(1).unwrap();
    let raw = read(&f.store.directory).unwrap().raw;
    assert_eq!(raw["foreign"]["large"], json!(1234567890123456789u64));
    assert_eq!(raw["gdriveDirty"]["future"], json!({"keep":true}));
    assert!(raw["gdriveDirty"].get("since").is_none());
}
#[test]
fn sequence_exhaustion_refuses_without_wrapping_or_losing_pending_intent() {
    let f = Fixture::new();
    f.write(
        json!({"version":1,"gdriveDirty":{"seq":MAX_SEQ,"dirs":{},"allSeq":MAX_SEQ,"since":123}}),
    );
    let before = fs::read(f.store.directory.join(NAME)).unwrap();
    assert!(f.store.mark_project(&f.dir("A"), "overflow").is_err());
    assert!(f.store.mark_library("overflow").is_err());
    assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), before);
    let cleared = f.store.clear(MAX_SEQ).unwrap();
    assert_eq!(cleared.seq, MAX_SEQ);
    assert!(!cleared.is_dirty());
    assert!(
        f.store
            .mark_project(&f.dir("A"), "still exhausted")
            .is_err()
    );
}
#[test]
fn malformed_or_oversized_metadata_is_never_silently_replaced() {
    let f = Fixture::new();
    fs::create_dir_all(&f.store.directory).unwrap();
    for raw in [
        br#"{"version":2}"#.as_slice(),
        b"{broken".as_slice(),
        br#"{"gdriveDirty":{"seq":-1}}"#.as_slice(),
        br#"{"gdriveDirty":{"seq":1,"dirs":{"/A":2}}}"#.as_slice(),
        br#"{"gdriveDirty":{"seq":1,"allSeq":2}}"#.as_slice(),
        br#"{"gdriveDirty":{"seq":1,"dirs":{"relative":1}}}"#.as_slice(),
    ] {
        fs::write(f.store.directory.join(NAME), raw).unwrap();
        assert!(f.store.snapshot().is_err());
        assert!(f.store.mark_project(&f.dir("A"), "refused").is_err());
        assert!(f.store.clear(100).is_err());
        assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), raw);
    }
    File::create(f.store.directory.join(NAME))
        .unwrap()
        .set_len(LIMIT + 1)
        .unwrap();
    assert!(f.store.snapshot().is_err());
    assert!(f.store.mark_library("refused").is_err());
    assert_eq!(
        fs::metadata(f.store.directory.join(NAME)).unwrap().len(),
        LIMIT + 1
    );
}
#[test]
fn busy_lease_refuses_then_retry_publishes_a_complete_ledger() {
    let f = Fixture::new();
    fs::create_dir_all(&f.store.directory).unwrap();
    let held = lease(&f.store.directory).unwrap();
    // Mark and clear share this lease boundary. Use its injected short timeout
    // while holding the real file lock; neither operation may reach mutation.
    for _ in 0..2 {
        assert!(
            f.store
                .update_with_lock_timeout(std::time::Duration::from_millis(20), |_| {
                    panic!("A held ledger lease admitted a mutation")
                })
                .is_err()
        );
    }
    assert!(!f.store.directory.join(NAME).exists());
    drop(held);
    f.store.mark_project(&f.dir("A"), "retry").unwrap();
    assert_eq!(f.store.snapshot().unwrap().seq, 1);
    assert!(fs::read_dir(&f.store.directory).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}
#[test]
fn concurrently_accepted_writers_get_distinct_monotonic_marks_without_lost_updates() {
    let f = Fixture::new();
    let barrier = Arc::new(Barrier::new(9));
    let mut workers = vec![];
    for index in 0..8 {
        let store = f.store.clone();
        let path = f.dir(&format!("A-{index}"));
        let barrier = barrier.clone();
        workers.push(std::thread::spawn(move || {
            barrier.wait();
            store.mark_project(&path, "concurrent").ok().map(|_| path)
        }));
    }
    barrier.wait();
    let accepted: Vec<_> = workers
        .into_iter()
        .filter_map(|worker| worker.join().unwrap())
        .collect();
    assert!(!accepted.is_empty());
    let state = f.store.snapshot().unwrap();
    assert_eq!(state.seq, accepted.len() as u64);
    assert_eq!(state.dirs.len(), accepted.len());
    let mut seqs: Vec<_> = state.dirs.values().copied().collect();
    seqs.sort();
    assert_eq!(seqs, (1..=accepted.len() as u64).collect::<Vec<_>>());
    for path in accepted {
        assert!(state.dirs.contains_key(path.to_str().unwrap()));
    }
}
#[test]
fn external_state_change_refuses_cas_without_overwriting_or_leaving_temps() {
    for present in [false, true] {
        let f = Fixture::new();
        fs::create_dir_all(&f.store.directory).unwrap();
        if present {
            f.store.mark_project(&f.dir("A"), "initial").unwrap();
        }
        let mut document = read(&f.store.directory).unwrap();
        bump(&mut document.state).unwrap();
        let external=br#"{"version":1,"gdriveDirty":{"seq":9,"allSeq":9,"dirs":{},"since":1},"foreign":true}"#;
        fs::write(f.store.directory.join(NAME), external).unwrap();
        assert!(publish(&f.store.directory, document).is_err());
        assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), external);
        assert!(fs::read_dir(&f.store.directory).unwrap().all(|entry| {
            !entry
                .unwrap()
                .file_name()
                .to_string_lossy()
                .ends_with(".tmp")
        }));
    }
}
#[cfg(unix)]
#[test]
fn linked_ledger_lock_or_project_metadata_is_refused_without_touching_targets() {
    let f = Fixture::new();
    fs::create_dir_all(&f.store.directory).unwrap();
    let foreign = f.root.join("foreign");
    fs::write(&foreign, b"private").unwrap();
    std::os::unix::fs::symlink(&foreign, f.store.directory.join(NAME)).unwrap();
    assert!(f.store.snapshot().is_err());
    assert!(f.store.mark_project(&f.dir("A"), "linked").is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"private");
    fs::remove_file(f.store.directory.join(NAME)).unwrap();
    fs::remove_file(f.store.directory.join(".sync-dirty.lock")).unwrap();
    std::os::unix::fs::symlink(&foreign, f.store.directory.join(".sync-dirty.lock")).unwrap();
    assert!(f.store.mark_library("linked lock").is_err());
    assert_eq!(fs::read(&foreign).unwrap(), b"private");
    let dir = f.dir("Linked");
    fs::create_dir_all(&dir).unwrap();
    std::os::unix::fs::symlink(&foreign, dir.join("project.json")).unwrap();
    assert!(
        f.store
            .mark_file(&dir.join("lyrics.json"), "linked project")
            .is_err()
    );
    assert_eq!(fs::read(foreign).unwrap(), b"private");
}
#[test]
fn outside_library_uses_directory_boundaries_instead_of_string_prefixes() {
    let f = Fixture::new();
    let root = f.root.join("Library");
    let inside = root.join("A");
    let outside = f.root.join("Library sibling/A");
    for path in [&root, &inside, &outside] {
        f.store.mark_project(path, "scope").unwrap();
    }
    assert_eq!(
        f.store.snapshot().unwrap().outside_library(&root),
        vec![outside]
    );
}

// Recovery tests keep the 60 s product budget, so a real scanner denial landing
// next to an injected fault cannot fail them. Tests that prove the wall-clock
// bound shorten it so a fault that never clears fails in a quarter of a second.
const TEST_RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(250);

// Faults are attached to a Store so these tests exercise the public mark, clear,
// operation and acknowledgement paths, including their result bookkeeping.
fn writer_fault_store(
    f: &Fixture,
    step: WriterIo,
    code: i32,
    failures: usize,
    external: Option<Value>,
    attempt_limit: usize,
) -> (Store, Arc<WriterFaults>) {
    let faults = Arc::new(WriterFaults {
        step,
        code,
        failures,
        calls: std::sync::atomic::AtomicUsize::new(0),
        external: external.map(|value| serde_json::to_vec(&value).unwrap()),
        directory_error: None,
        windows: true,
        attempt_limit,
        budget: WRITER_RETRY_BUDGET,
        injected: std::sync::atomic::AtomicUsize::new(0),
        stage_opens: std::sync::atomic::AtomicUsize::new(0),
        crash: None,
    });
    let mut store = f.store.clone();
    store.writer_faults = Some(faults.clone());
    (store, faults)
}
fn short_budget(store: &mut Store, faults: &mut Arc<WriterFaults>, budget: std::time::Duration) {
    store.writer_faults = None;
    Arc::get_mut(faults).unwrap().budget = budget;
    store.writer_faults = Some(faults.clone());
}
// Real scanner denials seen by this thread since the last call (and reset).
fn take_real_denials() -> usize {
    REAL_BUSY.with(|count| count.replace(0))
}
// Exactly the scheduled faults were injected and one further attempt published.
// The attempt count is exact too. Only when the real filesystem itself denied
// an operation (counted separately by `take_real_denials`) is the count
// allowed to exceed the scheduled retries, by the retries those denials cost.
// `real` must come from the take_real_denials() taken right after the call.
fn assert_recovered_after(faults: &WriterFaults, failures: usize, real: usize) {
    assert_eq!(faults.injected.load(Ordering::SeqCst), failures);
    let calls = faults.calls.load(Ordering::SeqCst);
    if real == 0 {
        assert_eq!(calls, failures + 1);
    } else {
        eprintln!("accounted for {real} real OS denial(s)");
        // Each real denial costs at most one extra attempt of this step.
        assert!((failures + 1..=failures + 1 + real).contains(&calls), "{calls} calls, {real} real");
    }
}
// The staged candidate is written once and survives every in-place retry of
// its publication; only a real denial elsewhere may restage it.
fn assert_one_staged_file(faults: &WriterFaults, real: usize) {
    let opens = faults.stage_opens.load(Ordering::SeqCst);
    if real == 0 {
        assert_eq!(opens, 1);
    } else {
        // Each real denial may restage at most once.
        assert!((1..=1 + real).contains(&opens), "{opens} StageOpens, {real} real");
    }
}
fn assert_no_writer_temps(f: &Fixture) {
    assert!(fs::read_dir(&f.store.directory).unwrap().all(|entry| {
        !entry
            .unwrap()
            .file_name()
            .to_string_lossy()
            .ends_with(".tmp")
    }));
}
fn check_windows_writer_recovery(code: i32) {
    for step in [
        WriterIo::Read(SnapshotIo::Open),
        WriterIo::Read(SnapshotIo::Metadata),
        WriterIo::Read(SnapshotIo::OpenedMetadata),
        WriterIo::Read(SnapshotIo::CurrentMetadata),
        WriterIo::Cas(SnapshotIo::Open),
        WriterIo::Cas(SnapshotIo::Metadata),
        WriterIo::Cas(SnapshotIo::OpenedMetadata),
        WriterIo::Cas(SnapshotIo::CurrentMetadata),
        WriterIo::StageOpen,
        WriterIo::Create,
        WriterIo::Replace,
    ] {
        for failures in [1, 3] {
            let f = Fixture::new();
            let initial = if step == WriterIo::Create {
                0
            } else {
                f.store.mark_library("initial").unwrap();
                1
            };
            let (store, faults) =
                writer_fault_store(&f, step, code, failures, None, WRITER_ATTEMPTS);
            let path = f.dir("Marked once");
            take_real_denials();
            store
                .mark_project(&path, "retry transaction")
                .unwrap_or_else(|error| {
                    panic!("{step:?}, OS {code}, {failures} failures: {error:#}")
                });
            let real = take_real_denials();
            assert_recovered_after(&faults, failures, real);
            if matches!(step, WriterIo::Create | WriterIo::Replace) {
                assert_one_staged_file(&faults, real);
            }
            let state = f.store.snapshot().unwrap();
            assert_eq!(state.seq, initial + 1);
            assert_eq!(state.dirs[path.to_str().unwrap()], initial + 1);
            assert_no_writer_temps(&f);
            f.store
                .mark_project(&f.dir("Next mark"), "lease released")
                .unwrap();
            assert_eq!(f.store.snapshot().unwrap().seq, initial + 2);
        }
    }
    // A failed replace must discard its candidate and CAS capture. An external
    // publication during the failure advances the ledger and adds unknown data.
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let external = json!({"version":1,"foreign":"preserve", "gdriveDirty":
        {"seq":9,"allSeq":9,"dirs":{},"since":111}});
    let (store, faults) = writer_fault_store(
        &f,
        WriterIo::Replace,
        code,
        2,
        Some(external),
        WRITER_ATTEMPTS,
    );
    take_real_denials();
    store
        .mark_project(&f.dir("Newest"), "rebase mutation")
        .unwrap();
    let real = take_real_denials();
    assert_recovered_after(&faults, 2, real);
    let state = f.store.snapshot().unwrap();
    assert_eq!(state.seq, 10);
    assert_eq!(state.all_seq, 9);
    assert_eq!(state.dirs[f.dir("Newest").to_str().unwrap()], 10);
    assert_eq!(state.since, Some(111));
    assert_eq!(read(&f.store.directory).unwrap().raw["foreign"], "preserve");
    assert_no_writer_temps(&f);

    let f = Fixture::new();
    let seq = f
        .store
        .commit_operation(&[f.dir("Old")], "operation", "initial")
        .unwrap();
    f.store.mark_project(&f.dir("New"), "newer mark").unwrap();
    let (store, _) = writer_fault_store(&f, WriterIo::Replace, code, 2, None, WRITER_ATTEMPTS);
    let state = store.clear(seq).unwrap();
    assert_eq!(state.seq, 2);
    assert_eq!(state.dirs.len(), 1);
    assert_eq!(state.retire_ops["operation"], seq);
    // The first candidate removed the operation, but another publisher already
    // acknowledged it before retry. The returned bool belongs to the last try.
    let external = json!({"version":1,"gdriveDirty":{"seq":9,"allSeq":9,"dirs":{},"since":111}});
    let (store, _) = writer_fault_store(
        &f,
        WriterIo::Replace,
        code,
        1,
        Some(external),
        WRITER_ATTEMPTS,
    );
    assert!(!store.acknowledge_operation("operation", seq).unwrap());
    assert_eq!(f.store.snapshot().unwrap().seq, 9);
    assert!(f.store.snapshot().unwrap().retire_ops.is_empty());

    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let (store, faults) = writer_fault_store(&f, WriterIo::Replace, code, 2, None, WRITER_ATTEMPTS);
    take_real_denials();
    let seq = store
        .commit_operation(&[f.dir("Operation")], "retry-operation", "operation retry")
        .unwrap();
    assert_eq!(seq, 2);
    let real = take_real_denials();
    assert_recovered_after(&faults, 2, real);
    assert_one_staged_file(&faults, real);
    let state = f.store.snapshot().unwrap();
    assert_eq!(state.retire_ops["retry-operation"], 2);
    assert_eq!(state.dirs[f.dir("Operation").to_str().unwrap()], 2);
    let (store, _) = writer_fault_store(&f, WriterIo::Replace, code, 2, None, WRITER_ATTEMPTS);
    assert!(store.acknowledge_operation("retry-operation", 2).unwrap());
    assert_eq!(f.store.snapshot().unwrap().seq, 2);
    assert!(f.store.snapshot().unwrap().retire_ops.is_empty());

    // A retry that fails validation before publication must not inherit the
    // previous attempt's publication-stage flag.
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let (mut store, mut faults) =
        writer_fault_store(&f, WriterIo::Replace, code, 1, None, WRITER_ATTEMPTS);
    store.writer_faults = None;
    Arc::get_mut(&mut faults).unwrap().external = Some(b"{broken".to_vec());
    store.writer_faults = Some(faults.clone());
    let error = store
        .commit_operation(&[f.dir("Operation")], "not-published", "validation failure")
        .unwrap_err();
    assert!(is_publication_not_attempted(&error));
    assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
    assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), b"{broken");
    assert_no_writer_temps(&f);

    for other in [2, 13, 31, 87] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let (store, faults) = writer_fault_store(
            &f,
            WriterIo::Replace,
            other,
            usize::MAX,
            None,
            WRITER_ATTEMPTS,
        );
        let error = store.mark_library("non-retryable error").unwrap_err();
        assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(other)
        );
        assert_eq!(f.store.snapshot().unwrap().seq, 1);
    }

    // Only file boundaries qualify: mutation errors, staging write/flush errors,
    // directory errors and the post-publication durability boundary are never
    // replayed. Opening the staging file is a retried boundary.
    for step in [
        WriterIo::StageWrite,
        WriterIo::StageFlush,
    ] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let before = fs::read(f.store.directory.join(NAME)).unwrap();
        let (store, faults) = writer_fault_store(&f, step, code, usize::MAX, None, WRITER_ATTEMPTS);
        let error = store.mark_library("denied staging").unwrap_err();
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(code)
        );
        assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
        assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), before);
        assert_no_writer_temps(&f);
    }
    for step in [
        WriterIo::Read(SnapshotIo::Open),
        WriterIo::Cas(SnapshotIo::Open),
        WriterIo::Replace,
    ] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let (mut store, mut faults) =
            writer_fault_store(&f, step, code, usize::MAX, None, WRITER_ATTEMPTS);
        store.writer_faults = None;
        Arc::get_mut(&mut faults).unwrap().directory_error = Some(code);
        store.writer_faults = Some(faults.clone());
        let error = store.mark_library("denied directory").unwrap_err();
        assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(code)
        );
        assert_eq!(f.store.snapshot().unwrap().seq, 1);
        assert_no_writer_temps(&f);
    }
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let (store, faults) = writer_fault_store(
        &f,
        WriterIo::DirectoryFlush,
        code,
        usize::MAX,
        None,
        WRITER_ATTEMPTS,
    );
    let error = store.mark_library("published once").unwrap_err();
    assert!(is_publication_uncertain(&error));
    assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
    assert_eq!(f.store.snapshot().unwrap().seq, 2);
    assert_no_writer_temps(&f);

    let (store, _) = writer_fault_store(&f, WriterIo::Replace, code, 0, None, WRITER_ATTEMPTS);
    let mut mutations = 0;
    let error = store
        .update(|_| {
            mutations += 1;
            Err(std::io::Error::from_raw_os_error(code).into())
        })
        .unwrap_err();
    assert_eq!(mutations, 1);
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(code)
    );
    assert_eq!(f.store.snapshot().unwrap().seq, 2);

    // The same hook cannot admit a Windows retry when platform policy is off.
    let (mut store, mut faults) = writer_fault_store(
        &f,
        WriterIo::Replace,
        code,
        usize::MAX,
        None,
        WRITER_ATTEMPTS,
    );
    store.writer_faults = None;
    Arc::get_mut(&mut faults).unwrap().windows = false;
    store.writer_faults = Some(faults.clone());
    let error = store.mark_library("non-Windows policy").unwrap_err();
    assert_eq!(faults.calls.load(Ordering::SeqCst), 1);
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(code)
    );
    assert_eq!(f.store.snapshot().unwrap().seq, 2);
}
#[test]
fn windows_writer_retries_access_denied_transactions_without_duplicate_marks() {
    check_windows_writer_recovery(5);
}
#[test]
fn windows_writer_retries_sharing_violation_transactions_without_duplicate_marks() {
    check_windows_writer_recovery(32);
}
#[test]
fn windows_writer_retries_lock_violation_transactions_without_duplicate_marks() {
    check_windows_writer_recovery(33);
}
#[test]
fn product_retry_budget_and_backoff_match_graceful_fs() {
    assert_eq!(WRITER_RETRY_BUDGET, std::time::Duration::from_secs(60));
    let delays: Vec<u64> = (0..7)
        .map(|retry| writer_retry_delay(retry).as_millis() as u64)
        .collect();
    assert_eq!(delays, [10, 20, 40, 80, 100, 100, 100]);
    for code in [5, 32, 33] {
        assert!(windows_file_busy(&std::io::Error::from_raw_os_error(code)));
    }
    for code in [2, 3, 6, 13, 31, 87, 112, 1224] {
        assert!(!windows_file_busy(&std::io::Error::from_raw_os_error(code)));
    }
}
#[test]
fn windows_writer_persistent_denial_returns_original_error_without_publication() {
    for step in [
        WriterIo::Read(SnapshotIo::Open),
        WriterIo::Cas(SnapshotIo::Open),
        WriterIo::StageOpen,
        WriterIo::Create,
        WriterIo::Replace,
    ] {
        for code in [5, 32, 33] {
            let f = Fixture::new();
            if step != WriterIo::Create {
                f.store.mark_library("initial").unwrap();
            }
            let before = fs::read(f.store.directory.join(NAME)).ok();
            let (store, faults) = writer_fault_store(&f, step, code, usize::MAX, None, 4);
            let error = store
                .mark_project(&f.dir("Unpublished"), "persistent denial")
                .unwrap_err();
            assert_eq!(
                faults.calls.load(Ordering::SeqCst),
                4,
                "{step:?}, OS {code}: {error:#}"
            );
            assert_eq!(
                error
                    .downcast_ref::<std::io::Error>()
                    .unwrap()
                    .raw_os_error(),
                Some(code)
            );
            assert!(!is_snapshot_changed(&error));
            assert_eq!(fs::read(f.store.directory.join(NAME)).ok(), before);
            assert_no_writer_temps(&f);
        }
    }
    // Exercise the wall-clock budget as well as the shorter attempt cap. The
    // injected budget is short; the product budget is checked separately.
    for step in [
        WriterIo::Read(SnapshotIo::Open),
        WriterIo::StageOpen,
        WriterIo::Replace,
    ] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let (mut store, mut faults) =
            writer_fault_store(&f, step, 5, usize::MAX, None, WRITER_ATTEMPTS);
        short_budget(&mut store, &mut faults, TEST_RETRY_BUDGET);
        let started = std::time::Instant::now();
        let error = store.mark_library("elapsed budget").unwrap_err();
        assert!(started.elapsed() >= TEST_RETRY_BUDGET, "{step:?}");
        assert!(started.elapsed() < TEST_RETRY_BUDGET * 8, "{step:?}");
        assert!((1..=WRITER_ATTEMPTS).contains(&faults.calls.load(Ordering::SeqCst)));
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(5)
        );
        assert_eq!(f.store.snapshot().unwrap().seq, 1);
        assert_no_writer_temps(&f);
    }
}
#[test]
fn windows_writer_busy_retry_stops_when_cancelled_without_waiting_out_the_budget() {
    for step in [WriterIo::StageOpen, WriterIo::Replace] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let before = fs::read(f.store.directory.join(NAME)).unwrap();
        let (mut store, mut faults) =
            writer_fault_store(&f, step, 32, usize::MAX, None, WRITER_ATTEMPTS);
        short_budget(&mut store, &mut faults, std::time::Duration::from_secs(60));
        let started = std::time::Instant::now();
        let error = store
            .mark_project_until(&f.dir("Quit"), "shutdown", &|| {
                faults.calls.load(Ordering::SeqCst) >= 3
            })
            .unwrap_err();
        assert!(started.elapsed() < std::time::Duration::from_secs(5), "{step:?}");
        // Every call is injected and the cancel flips on the third: exactly three.
        assert_eq!(faults.calls.load(Ordering::SeqCst), 3, "{step:?}");
        assert_eq!(faults.injected.load(Ordering::SeqCst), 3, "{step:?}");
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(32)
        );
        assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), before);
        assert_no_writer_temps(&f);
    }
}
#[test]
fn second_writer_waits_for_a_live_retrying_writer_instead_of_reporting_busy() {
    assert_eq!(
        Fixture::new().store.writer_lease_timeout(),
        WRITER_RETRY_BUDGET + WRITER_LEASE_MARGIN
    );
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let (mut slow, mut faults) =
        writer_fault_store(&f, WriterIo::Replace, 5, usize::MAX, None, WRITER_ATTEMPTS);
    short_budget(&mut slow, &mut faults, std::time::Duration::from_secs(3));
    let first = std::thread::spawn(move || slow.mark_library("never clears"));
    while faults.calls.load(Ordering::SeqCst) == 0 {
        std::thread::sleep(std::time::Duration::from_millis(5));
    }
    // The first writer holds the lease for 3 s, longer than the old 2 s wait.
    let started = std::time::Instant::now();
    let mut second = f.store.clone();
    second.writer_faults = Some(Arc::new(WriterFaults {
        step: WriterIo::Replace, code: 5, failures: 0,
        calls: std::sync::atomic::AtomicUsize::new(0), external: None,
        directory_error: None, windows: true, attempt_limit: WRITER_ATTEMPTS,
        budget: std::time::Duration::from_secs(3),
        injected: std::sync::atomic::AtomicUsize::new(0),
        stage_opens: std::sync::atomic::AtomicUsize::new(0),
        crash: None,
    }));
    second.mark_project(&f.dir("Waited"), "second writer").unwrap();
    assert!(started.elapsed() > std::time::Duration::from_secs(2));
    assert!(first.join().unwrap().is_err());
    assert!(f.store.snapshot().unwrap().dirs.keys().any(|k| k.ends_with("Waited")));
}
// The cancel closure reports false until it has seen the injected failure, then
// stays false for 5 ms (the pre-sleep check right after the failure) and turns
// true afterwards, i.e. it flips during the 10 ms backoff. Every retry that
// would have succeeded must then be abandoned without publishing.
#[test]
fn cancel_flipping_during_the_backoff_never_publishes_the_next_attempt() {
    for step in [
        WriterIo::Replace,
        WriterIo::Create,
        WriterIo::StageOpen,
        WriterIo::Read(SnapshotIo::Open),
        WriterIo::Cas(SnapshotIo::Open),
    ] {
        let f = Fixture::new();
        if step != WriterIo::Create {
            f.store.mark_library("initial").unwrap();
        }
        let before = fs::read(f.store.directory.join(NAME)).ok();
        let (store, faults) = writer_fault_store(&f, step, 5, 1, None, WRITER_ATTEMPTS);
        let seen = std::sync::Mutex::new(None::<std::time::Instant>);
        let cancel = || {
            if faults.injected.load(Ordering::SeqCst) == 0 {
                return false;
            }
            let mut seen = seen.lock().unwrap();
            let first = *seen.get_or_insert_with(std::time::Instant::now);
            first.elapsed() >= std::time::Duration::from_millis(5)
        };
        let error = store
            .mark_project_until(&f.dir("Cancelled"), "cancel in backoff", &cancel)
            .unwrap_err();
        assert_eq!(
            error.downcast_ref::<std::io::Error>().unwrap().raw_os_error(),
            Some(5),
            "{step:?}: {error:#}"
        );
        assert_eq!(faults.injected.load(Ordering::SeqCst), 1, "{step:?}");
        assert_eq!(
            faults.calls.load(Ordering::SeqCst),
            1,
            "{step:?}: no attempt may run after the cancel"
        );
        assert_eq!(fs::read(f.store.directory.join(NAME)).ok(), before, "{step:?}");
        assert_no_writer_temps(&f);
    }
}
#[test]
fn cancelled_writer_does_not_accept_a_lease_that_frees_up() {
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let before = fs::read(f.store.directory.join(NAME)).unwrap();
    let dir = f.store.directory.canonicalize().unwrap();
    let held = lease(&dir).unwrap();
    let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
    let release = {
        let flag = flag.clone();
        std::thread::spawn(move || {
            std::thread::sleep(std::time::Duration::from_millis(60));
            flag.store(true, Ordering::SeqCst);
            drop(held);
        })
    };
    let error = f
        .store
        .mark_project_until(&f.dir("Late"), "cancelled before lease", &|| {
            flag.load(Ordering::SeqCst)
        })
        .unwrap_err();
    release.join().unwrap();
    assert!(!error.to_string().is_empty());
    assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), before);
    assert_no_writer_temps(&f);
}
fn crash_store(f: &Fixture, point: CrashPoint) -> Store {
    let (mut store, mut faults) =
        writer_fault_store(f, WriterIo::Replace, 5, 0, None, WRITER_ATTEMPTS);
    store.writer_faults = None;
    Arc::get_mut(&mut faults).unwrap().crash = Some(point);
    store.writer_faults = Some(faults);
    store
}
fn project_with_metadata(f: &Fixture, name: &str) -> PathBuf {
    let project = f.dir(name);
    fs::create_dir_all(&project).unwrap();
    fs::write(project.join("project.json"), b"{}").unwrap();
    project
}
// Electron's withDirty: the ledger is marked before and after the write.
#[test]
fn with_dirty_marks_on_both_edges_and_returns_the_value() {
    let f = Fixture::new();
    let project = project_with_metadata(&f, "Song");
    for file in [false, true] {
        let target = if file { project.join("lyrics.json") } else { project.clone() };
        let seen = std::cell::Cell::new(0);
        let (value, after) = f
            .store
            .with_dirty(&target, file, "normal", &|| false, || {
                // The first edge is already durable when the bytes are written.
                seen.set(f.store.snapshot().unwrap().seq);
                Ok(7)
            })
            .unwrap();
        assert_eq!(value, 7);
        after.unwrap();
        assert!(seen.get() >= 1);
    }
    let state = f.store.snapshot().unwrap();
    assert_eq!(state.seq, 4, "two edges for each of two writes");
    assert!(state.dirs.contains_key(project.to_str().unwrap()));
    assert_no_writer_temps(&f);
}
#[test]
fn a_kill_after_the_bytes_but_before_the_after_mark_leaves_the_project_dirty() {
    let f = Fixture::new();
    let project = project_with_metadata(&f, "Song");
    let payload = project.join("payload");
    let store = crash_store(&f, CrashPoint::AfterBytes);
    let error = store
        .with_dirty(&project, false, "crash", &|| false, || {
            fs::write(&payload, b"new").map_err(Into::into)
        })
        .unwrap_err();
    assert!(format!("{error:#}").contains("simulated kill"), "{error:#}");
    assert_eq!(fs::read(&payload).unwrap(), b"new");
    // The ledger itself was the write-ahead record: nothing to replay.
    let state = f.store.snapshot().unwrap();
    assert!(state.dirs.contains_key(project.to_str().unwrap()));
    assert_eq!(state.seq, 1, "only the first edge ran");
}
#[test]
fn a_failed_before_mark_publishes_nothing_and_reports_the_original_error() {
    for code in [5, 32, 33] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let project = project_with_metadata(&f, "Song");
        let payload = project.join("payload");
        let (mut store, mut faults) =
            writer_fault_store(&f, WriterIo::Replace, code, usize::MAX, None, WRITER_ATTEMPTS);
        short_budget(&mut store, &mut faults, TEST_RETRY_BUDGET);
        let published = std::cell::Cell::new(false);
        let error = store
            .with_dirty(&project, false, "refused", &|| false, || {
                published.set(true);
                fs::write(&payload, b"new").map_err(Into::into)
            })
            .unwrap_err();
        assert!(!published.get(), "OS {code}: the bytes must not be published");
        assert!(!payload.exists());
        assert!(format!("{error:#}").contains("nothing was saved"), "{error:#}");
        let raw = error
            .chain()
            .find_map(|cause| cause.downcast_ref::<std::io::Error>())
            .and_then(std::io::Error::raw_os_error);
        assert_eq!(raw, Some(code));
        assert!(!f.store.snapshot().unwrap().dirs.contains_key(project.to_str().unwrap()));
    }
}
#[test]
fn a_cancelled_before_mark_publishes_nothing() {
    let f = Fixture::new();
    let project = project_with_metadata(&f, "Song");
    let published = std::cell::Cell::new(false);
    f.store
        .with_dirty(&project, false, "cancelled", &|| true, || {
            published.set(true);
            Ok(())
        })
        .unwrap_err();
    assert!(!published.get());
    assert!(f.store.snapshot().unwrap().dirs.is_empty());
}
#[test]
fn a_failed_after_mark_warns_and_the_project_stays_dirty() {
    let f = Fixture::new();
    let project = project_with_metadata(&f, "Song");
    let flag = std::sync::atomic::AtomicBool::new(false);
    // Cancellation arrives while the bytes are written: the second edge fails.
    let (value, after) = f
        .store
        .with_dirty(&project, false, "late quit", &|| flag.load(Ordering::SeqCst), || {
            flag.store(true, Ordering::SeqCst);
            Ok(9)
        })
        .unwrap();
    assert_eq!(value, 9);
    assert!(after.is_err());
    let state = f.store.snapshot().unwrap();
    assert!(state.dirs.contains_key(project.to_str().unwrap()));
    assert_eq!(state.seq, 1);
}
#[test]
fn a_failed_publish_still_marks_the_second_edge_like_electrons_finally() {
    let f = Fixture::new();
    let project = project_with_metadata(&f, "Song");
    f.store
        .with_dirty(&project, false, "failing", &|| false, || -> Result<()> {
            anyhow::bail!("publish failed")
        })
        .unwrap_err();
    assert_eq!(f.store.snapshot().unwrap().seq, 2);
}
#[test]
fn legacy_intent_records_are_marked_then_retired() {
    let f = Fixture::new();
    let one = project_with_metadata(&f, "One");
    let two = project_with_metadata(&f, "Two");
    let folder = f.store.directory.join(LEGACY_INTENT_DIR);
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("1.json"),
        serde_json::to_vec(&json!({"path": one.to_str().unwrap(), "file": false})).unwrap(),
    )
    .unwrap();
    fs::write(
        folder.join("2.json"),
        serde_json::to_vec(&json!({"path": two.join("lyrics.json").to_str().unwrap(), "file": true}))
            .unwrap(),
    )
    .unwrap();
    fs::write(folder.join(".3.tmp"), b"staged").unwrap();
    assert_eq!(f.store.retire_legacy_intents(&|| false).unwrap(), 2);
    let dirs = f.store.snapshot().unwrap().dirs;
    assert!(dirs.contains_key(one.to_str().unwrap()));
    assert!(dirs.contains_key(two.to_str().unwrap()));
    assert!(!folder.exists());
    assert_eq!(f.store.retire_legacy_intents(&|| false).unwrap(), 0);
}
#[test]
fn a_cancelled_legacy_retirement_keeps_the_records_for_the_next_start() {
    let f = Fixture::new();
    let one = project_with_metadata(&f, "One");
    let folder = f.store.directory.join(LEGACY_INTENT_DIR);
    fs::create_dir_all(&folder).unwrap();
    fs::write(
        folder.join("1.json"),
        serde_json::to_vec(&json!({"path": one.to_str().unwrap(), "file": false})).unwrap(),
    )
    .unwrap();
    f.store.retire_legacy_intents(&|| true).unwrap_err();
    assert!(folder.join("1.json").exists());
}
#[test]
fn every_staging_attempt_gets_a_new_name() {
    let names: std::collections::HashSet<_> = (0..64).map(|_| staging_name()).collect();
    assert_eq!(names.len(), 64);
    assert!(names.iter().all(|n| n.starts_with(".sync-dirty-") && n.ends_with(".tmp")));
}
#[test]
fn orphaned_staging_files_are_reclaimed_only_when_old_and_their_owner_is_gone() {
    let f = Fixture::new();
    let dir = &f.store.directory;
    fs::create_dir_all(dir).unwrap();
    let make = |name: &str, age_secs: u64| {
        let path = dir.join(name);
        let file = fs::File::create(&path).unwrap();
        file.set_modified(SystemTime::now() - std::time::Duration::from_secs(age_secs))
            .unwrap();
        path
    };
    let own = make(&format!(".sync-dirty-{}-1-0.tmp", std::process::id()), 7200);
    let dead_old = make(".sync-dirty-4000001-1-0.tmp", 7200);
    let dead_young = make(".sync-dirty-4000002-1-0.tmp", 60);
    let live_old = make(".sync-dirty-4000003-1-0.tmp", 7200);
    let foreign = make("notes.tmp", 7200);
    let removed = reclaim_orphaned_staging_with(dir, SystemTime::now(), |pid| pid == 4000003);
    assert_eq!(removed, 1);
    assert!(!dead_old.exists());
    for kept in [&own, &dead_young, &live_old, &foreign] {
        assert!(kept.exists(), "{kept:?}");
    }
}
// A scanner that still holds a deleted staging file open (delete pending)
// must never block the next stage: attempts use fresh names.
#[cfg(windows)]
#[test]
fn a_delete_pending_staging_file_does_not_block_the_next_stage() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let held = f.store.directory.join(staging_name());
    fs::write(&held, b"previous attempt").unwrap();
    // FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE
    let _scanner = OpenOptions::new()
        .read(true)
        .share_mode(7)
        .open(&held)
        .unwrap();
    fs::remove_file(&held).unwrap();
    let started = std::time::Instant::now();
    let (store, faults) = writer_fault_store(&f, WriterIo::Replace, 5, 0, None, WRITER_ATTEMPTS);
    store.mark_project(&f.dir("After delete pending"), "unique staging name").unwrap();
    assert!(started.elapsed() < std::time::Duration::from_secs(2));
    assert_eq!(faults.injected.load(Ordering::SeqCst), 0);
}
// Scratch directories are unique per process and per fixture (pid plus a
// process-wide counter), so one test can never remove or reuse another's.
#[test]
fn fixtures_never_share_a_scratch_directory() {
    let fixtures: Vec<Fixture> = (0..32).map(|_| Fixture::new()).collect();
    let roots: std::collections::HashSet<_> = fixtures.iter().map(|f| f.root.clone()).collect();
    assert_eq!(roots.len(), 32);
}
#[cfg(windows)]
#[test]
fn directory_state_diagnostic_distinguishes_delete_pending_directories() {
    use std::os::windows::fs::OpenOptionsExt;
    let f = Fixture::new();
    assert_eq!(directory_state(&f.root), "not delete-pending");
    let doomed = f.root.join("doomed");
    fs::create_dir(&doomed).unwrap();
    // A scanner-like handle with delete sharing keeps the removed directory alive.
    let _held = OpenOptions::new()
        .read(true)
        .custom_flags(0x0200_0000)
        .share_mode(7)
        .open(&doomed)
        .unwrap();
    fs::remove_dir(&doomed).unwrap();
    let state = directory_state(&doomed);
    assert!(state.contains("delete-pending"), "{state}");
    assert!(!state.starts_with("not delete-pending"), "{state}");
}
#[cfg(windows)]
#[test]
fn windows_native_writer_recovery_uses_the_production_platform_gate() {
    // A default Store selects the same Windows policy as the injected stores.
    assert!(Fixture::new().store.writer_windows_policy());
    check_windows_writer_recovery(5);
    check_windows_writer_recovery(32);
}

// The portable variants run the exact Windows policy on the host; the Windows
// variants also verify snapshot_with_hook's production platform selection.
fn snapshot_with_injected_io(
    store: &Store,
    native_gate: bool,
    hook: impl FnMut(SnapshotIo) -> std::io::Result<()>,
) -> Result<Snapshot> {
    if native_gate {
        store.snapshot_with_io_hook(|| {}, hook)
    } else {
        store.snapshot_with_io_policy(|| {}, hook, true)
    }
}
fn check_windows_snapshot_recovery(native_gate: bool, code: i32) {
    for step in [
        SnapshotIo::Open,
        SnapshotIo::Metadata,
        SnapshotIo::OpenedMetadata,
        SnapshotIo::CurrentMetadata,
    ] {
        for failures in [1, 3, 7] {
            let f = Fixture::new();
            f.store.mark_project(&f.dir("A"), "initial").unwrap();
            let expected = f.store.snapshot().unwrap();
            let mut calls = 0;
            let state = snapshot_with_injected_io(&f.store, native_gate, |at| {
                if at == step {
                    calls += 1;
                    if calls <= failures {
                        return Err(std::io::Error::from_raw_os_error(code));
                    }
                }
                Ok(())
            })
            .unwrap_or_else(|error| panic!("{step:?}, OS {code}, {failures} failures: {error:#}"));
            assert_eq!(calls, failures + 1);
            assert_eq!(state, expected);
        }
    }
    // Similar errors outside ledger open/metadata must remain permanent.
    for (step, code) in [
        (SnapshotIo::Read, 5),
        (SnapshotIo::Read, 32),
        (SnapshotIo::Open, 13),
        (SnapshotIo::Open, 87),
    ] {
        let f = Fixture::new();
        f.store.mark_library("initial").unwrap();
        let mut calls = 0;
        let error = snapshot_with_injected_io(&f.store, native_gate, |at| {
            if at == step {
                calls += 1;
                return Err(std::io::Error::from_raw_os_error(code));
            }
            Ok(())
        })
        .unwrap_err();
        assert_eq!(calls, 1);
        assert_eq!(
            error
                .downcast_ref::<std::io::Error>()
                .unwrap()
                .raw_os_error(),
            Some(code)
        );
        assert!(!is_snapshot_changed(&error));
    }
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let mut opens = 0;
    let error = snapshot_with_injected_io(&f.store, native_gate, |at| {
        if at == SnapshotIo::Open {
            opens += 1;
            return Err(std::io::Error::new(
                std::io::ErrorKind::PermissionDenied,
                "synthetic denial",
            ));
        }
        Ok(())
    })
    .unwrap_err();
    assert_eq!(opens, 1);
    let error = error.downcast_ref::<std::io::Error>().unwrap();
    assert_eq!(error.kind(), std::io::ErrorKind::PermissionDenied);
    assert_eq!(error.raw_os_error(), None);
    // Directory denial is surfaced before admitting even one retry. Give the
    // directory its own code to prove it, rather than the ledger error, survives.
    let f = Fixture::new();
    f.store.mark_library("initial").unwrap();
    let mut opens = 0;
    let mut directory_checks = 0;
    let error = snapshot_with_injected_io(&f.store, native_gate, |at| match at {
        SnapshotIo::Open => {
            opens += 1;
            Err(std::io::Error::from_raw_os_error(5))
        }
        SnapshotIo::Directory => {
            directory_checks += 1;
            Err(std::io::Error::from_raw_os_error(32))
        }
        _ => Ok(()),
    })
    .unwrap_err();
    assert_eq!((opens, directory_checks), (1, 1));
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(32)
    );
    assert!(!is_snapshot_changed(&error));
    // The non-Windows snapshot policy never tags or retries these errors,
    // even though the injected raw code is identical.
    let mut opens = 0;
    let error = f
        .store
        .snapshot_with_io_policy(
            || {},
            |at| {
                if at == SnapshotIo::Open {
                    opens += 1;
                    return Err(std::io::Error::from_raw_os_error(5));
                }
                assert_ne!(at, SnapshotIo::Directory);
                Ok(())
            },
            false,
        )
        .unwrap_err();
    assert_eq!(opens, 1);
    assert_eq!(
        error
            .downcast_ref::<std::io::Error>()
            .unwrap()
            .raw_os_error(),
        Some(5)
    );
}
fn check_windows_snapshot_persistent_denial(native_gate: bool) {
    for step in [
        SnapshotIo::Open,
        SnapshotIo::Metadata,
        SnapshotIo::OpenedMetadata,
        SnapshotIo::CurrentMetadata,
    ] {
        for code in [5, 32] {
            let f = Fixture::new();
            f.store.mark_library("initial").unwrap();
            let before = fs::read(f.store.directory.join(NAME)).unwrap();
            let mut calls = 0;
            let error = snapshot_with_injected_io(&f.store, native_gate, |at| {
                if at == step {
                    calls += 1;
                    return Err(std::io::Error::from_raw_os_error(code));
                }
                Ok(())
            })
            .unwrap_err();
            assert_eq!(calls, 8, "{step:?}, OS {code}: {error:#}");
            assert!(!is_snapshot_changed(&error));
            assert_eq!(
                error
                    .downcast_ref::<std::io::Error>()
                    .unwrap()
                    .raw_os_error(),
                Some(code)
            );
            assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(), before);
        }
    }
}
#[test]
fn windows_policy_retries_access_denied_ledger_replace_races() {
    check_windows_snapshot_recovery(false, 5);
}
#[test]
fn windows_policy_retries_sharing_violation_ledger_replace_races() {
    check_windows_snapshot_recovery(false, 32);
}
#[test]
fn windows_policy_returns_original_persistent_denial_after_eight_attempts() {
    check_windows_snapshot_persistent_denial(false);
}
#[cfg(windows)]
#[test]
fn windows_snapshots_retry_ledger_open_and_metadata_replace_races() {
    check_windows_snapshot_recovery(true, 5);
    check_windows_snapshot_recovery(true, 32);
}
#[cfg(windows)]
#[test]
fn windows_snapshots_return_original_persistent_denial_after_eight_attempts() {
    check_windows_snapshot_persistent_denial(true);
}

#[test]
fn snapshot_retries_atomic_replace_from_real_writer_after_open() {
    let f = Fixture::new();
    let first = f.dir("A");
    let second = f.dir("B");
    f.store.mark_project(&first, "before snapshot").unwrap();
    let mut attempts = 0;
    let state = f
        .store
        .snapshot_with_hook(|| {
            attempts += 1;
            if attempts == 1 {
                let writer = f.store.clone();
                let second = second.clone();
                std::thread::spawn(move || {
                    writer
                        .mark_project(&second, "atomic replacement during snapshot")
                        .unwrap()
                })
                .join()
                .unwrap();
            }
        })
        .unwrap();
    assert_eq!(attempts, 2);
    assert_eq!(state.seq, 2);
    assert_eq!(state.dirs[first.to_str().unwrap()], 1);
    assert_eq!(state.dirs[second.to_str().unwrap()], 2);
}
#[test]
fn continuous_snapshot_replacement_returns_typed_transient_after_bounded_attempts() {
    let f = Fixture::new();
    let path = f.dir("A");
    f.store.mark_project(&path, "initial").unwrap();
    let mut attempts = 0;
    let error = f
        .store
        .snapshot_with_hook(|| {
            attempts += 1;
            let writer = f.store.clone();
            let path = path.clone();
            std::thread::spawn(move || writer.mark_project(&path, "keep replacing").unwrap())
                .join()
                .unwrap();
        })
        .unwrap_err();
    assert_eq!(attempts, 8);
    assert!(is_snapshot_changed(&error), "{error:#}");
    assert_eq!(f.store.snapshot().unwrap().seq, 9);
}
#[test]
fn snapshot_retry_does_not_hide_malformed_replacement() {
    let f = Fixture::new();
    f.store.mark_project(&f.dir("A"), "initial").unwrap();
    let replacement = f.store.directory.join("bad-next");
    fs::write(&replacement, b"{ malformed JSON").unwrap();
    let mut attempts = 0;
    let error = f
        .store
        .snapshot_with_hook(|| {
            attempts += 1;
            if attempts == 1 {
                crate::project_store::replace(&replacement, &f.store.directory.join(NAME)).unwrap();
            }
        })
        .unwrap_err();
    assert_eq!(attempts, 2);
    assert!(!is_snapshot_changed(&error));
    assert!(format!("{error:#}").contains("Invalid sync intent JSON"));
    assert_eq!(
        fs::read(f.store.directory.join(NAME)).unwrap(),
        b"{ malformed JSON"
    );
}
#[test]
fn snapshot_does_not_retry_oversized_replacement() {
    let f = Fixture::new();
    f.store.mark_project(&f.dir("A"), "initial").unwrap();
    let replacement = f.store.directory.join("large-next");
    File::create(&replacement)
        .unwrap()
        .set_len(LIMIT + 1)
        .unwrap();
    let mut attempts = 0;
    let error = f
        .store
        .snapshot_with_hook(|| {
            attempts += 1;
            crate::project_store::replace(&replacement, &f.store.directory.join(NAME)).unwrap();
        })
        .unwrap_err();
    assert_eq!(attempts, 1);
    assert!(!is_snapshot_changed(&error));
}
#[cfg(unix)]
#[test]
fn snapshot_does_not_retry_linked_replacement_or_read_its_target() {
    let f = Fixture::new();
    f.store.mark_project(&f.dir("A"), "initial").unwrap();
    let outside = f.root.join("private-ledger");
    fs::write(&outside, b"private target remains untouched").unwrap();
    let replacement = f.store.directory.join("linked-next");
    std::os::unix::fs::symlink(&outside, &replacement).unwrap();
    let mut attempts = 0;
    let error = f
        .store
        .snapshot_with_hook(|| {
            attempts += 1;
            fs::rename(&replacement, f.store.directory.join(NAME)).unwrap();
        })
        .unwrap_err();
    assert_eq!(attempts, 1);
    assert!(!is_snapshot_changed(&error));
    assert_eq!(
        fs::read(outside).unwrap(),
        b"private target remains untouched"
    );
}
#[test]
fn concurrent_snapshots_and_atomic_marks_preserve_coherent_monotonic_highwaters() {
    use std::sync::atomic::{AtomicBool, AtomicUsize};
    let f = Fixture::new();
    f.store.mark_project(&f.dir("A"), "initial").unwrap();
    let barrier = Arc::new(Barrier::new(5));
    let finished = Arc::new(AtomicBool::new(false));
    let mutations = Arc::new(AtomicUsize::new(0));
    let accepted = Arc::new(AtomicUsize::new(0));
    let writer_store = f.store.clone();
    let writer_barrier = barrier.clone();
    let writer_done = finished.clone();
    let writer_mutations = mutations.clone();
    let writer_accepted = accepted.clone();
    let writer = std::thread::spawn(move || {
        writer_barrier.wait();
        for _ in 0..64 {
            writer_store
                .update(|state| {
                    writer_mutations.fetch_add(1, Ordering::SeqCst);
                    bump(state)?;
                    state.all_seq = state.seq;
                    Ok(())
                })
                .unwrap();
            writer_accepted.fetch_add(1, Ordering::SeqCst);
        }
        writer_done.store(true, Ordering::Release);
    });
    let readers: Vec<_> = (0..3)
        .map(|_| {
            let store = f.store.clone();
            let barrier = barrier.clone();
            let finished = finished.clone();
            std::thread::spawn(move || {
                barrier.wait();
                let mut previous = 1;
                let mut samples = 0;
                while !finished.load(Ordering::Acquire) || samples < 128 {
                    match store.snapshot() {
                        Ok(state) => {
                            assert!(state.seq >= previous);
                            assert!(state.seq >= state.all_seq);
                            assert!(state.dirs.values().all(|seq| *seq > 0 && *seq <= state.seq));
                            previous = state.seq;
                            samples += 1;
                        }
                        Err(error) => assert!(
                            is_snapshot_changed(&error),
                            "Unexpected permanent read error: {error:#}"
                        ),
                    }
                }
                assert!(samples >= 128);
            })
        })
        .collect();
    barrier.wait();
    writer.join().unwrap();
    for reader in readers {
        reader.join().unwrap();
    }
    let callbacks = mutations.load(Ordering::SeqCst);
    if cfg!(windows) {
        assert!(
            callbacks >= 64,
            "Each accepted update must invoke its mutation callback"
        );
    } else {
        assert_eq!(
            callbacks, 64,
            "Non-Windows writer callbacks unexpectedly replayed"
        );
    }
    assert_eq!(
        accepted.load(Ordering::SeqCst),
        64,
        "Expected all 64 writer updates to return successfully"
    );
    let final_state = f.store.snapshot().unwrap();
    assert_eq!(final_state.seq, 65);
    assert_eq!(final_state.all_seq, 65);
}


#[test]
fn downloaded_copy_edits_and_removal_do_not_enqueue_the_writer() {
    let f=Fixture::new();
    let cache=f.store.directory.join("gdrive/downloads");
    let copy=cache.join("project-copy");fs::create_dir_all(&copy).unwrap();
    fs::write(copy.join("project.json"),br#"{"version":2,"name":"Local copy"}"#).unwrap();
    f.store.mark_project(&copy,"saved").unwrap();
    f.store.mark_file(&copy.join("project.json"),"metadata").unwrap();
    let renamed=cache.join("My edited offline song");fs::rename(&copy,&renamed).unwrap();
    f.store.mark_project(&copy,"rename old edge").unwrap();
    f.store.mark_project(&renamed,"rename new edge").unwrap();
    assert_eq!(f.store.snapshot().unwrap(),Snapshot::default());
    assert!(!f.store.directory.join(NAME).exists());
    let owned=f.dir("Writer song");f.store.mark_project(&owned,"saved").unwrap();
    assert!(f.store.snapshot().unwrap().dirs.contains_key(owned.to_str().unwrap()));
}

#[test]
#[cfg(unix)]
fn linked_download_cache_does_not_hide_an_external_writer_edit() {
    use std::os::unix::fs::symlink;
    let f=Fixture::new();let outside=f.root.join("outside");
    fs::create_dir_all(outside.join("Song")).unwrap();
    fs::create_dir_all(f.store.directory.join("gdrive")).unwrap();
    symlink(&outside,f.store.directory.join("gdrive/downloads")).unwrap();
    let path=f.store.directory.join("gdrive/downloads/Song");
    f.store.mark_project(&path,"outside edit").unwrap();
    assert!(f.store.snapshot().unwrap().dirs.contains_key(path.to_str().unwrap()));
}

#[test]
fn local_operation_reference_survives_clear_and_scope_collapse_until_exact_acknowledgement() {
    let f=Fixture::new();let sequence=f.store.commit_operation(&[f.dir("Old"),f.dir("New")],"rename-accepted","rename").unwrap();
    let state=f.store.snapshot().unwrap();assert_eq!(state.retire_ops["rename-accepted"],sequence);
    assert_eq!(state.dirs[f.dir("Old").to_str().unwrap()],sequence);assert_eq!(state.dirs[f.dir("New").to_str().unwrap()],sequence);
    for i in 0..102 {f.store.mark_project(&f.dir(&format!("Scope {i}")),"other edit").unwrap();}
    let collapsed=f.store.snapshot().unwrap();assert!(collapsed.all_seq>0);assert_eq!(collapsed.retire_ops["rename-accepted"],sequence);
    let cleared=f.store.clear(collapsed.seq).unwrap();assert!(cleared.is_dirty());assert!(cleared.dirs.is_empty());assert_eq!(cleared.retire_ops["rename-accepted"],sequence);
    assert!(!f.store.acknowledge_operation("rename-accepted",sequence+1).unwrap());
    f.store.mark_project(&f.dir("Newest"),"racing newer Save").unwrap();
    assert!(f.store.acknowledge_operation("rename-accepted",sequence).unwrap());
    let retained=f.store.snapshot().unwrap();assert!(retained.retire_ops.is_empty());assert!(retained.dirs.contains_key(f.dir("Newest").to_str().unwrap()));
}
#[test]
fn rejected_operation_reference_publishes_neither_a_mark_nor_authority() {
    let f=Fixture::new();f.store.mark_project(&f.dir("Before"),"prior").unwrap();let before=fs::read(f.store.directory.join(NAME)).unwrap();
    assert!(f.store.commit_operation(&[f.dir("After")],"../unsafe","delete").is_err());
    assert_eq!(fs::read(f.store.directory.join(NAME)).unwrap(),before);
    assert_eq!(f.store.snapshot().unwrap().retire_ops.len(),0);
    let sequence=f.store.commit_operation(&[f.dir("Deleted")],"delete-accepted","delete").unwrap();
    assert_eq!(f.store.commit_operation(&[f.dir("Deleted")],"delete-accepted","retry").unwrap(),sequence);
    assert_eq!(f.store.snapshot().unwrap().seq,sequence);
}
// The first ledger never replaces one that appeared meanwhile, and on Windows
// it is the staged candidate itself, moved: no second link is created and
// removed (that ledger refused its next replace for the whole retry budget).
#[test]
fn first_publication_never_replaces_a_ledger_and_leaves_no_second_name() {
    let f = Fixture::new();
    fs::create_dir_all(&f.store.directory).unwrap();
    let staged = f.store.directory.join(staging_name());
    let ledger = f.store.directory.join(NAME);
    fs::write(&staged, b"first").unwrap();
    publish_new(&staged, &ledger).unwrap();
    assert_eq!(fs::read(&ledger).unwrap(), b"first");
    #[cfg(windows)]
    assert!(!staged.exists(), "the first ledger was linked, not moved");
    let _ = fs::remove_file(&staged);
    fs::write(&staged, b"second").unwrap();
    let error = publish_new(&staged, &ledger).unwrap_err();
    assert_eq!(error.kind(), std::io::ErrorKind::AlreadyExists, "{error}");
    assert_eq!(fs::read(&ledger).unwrap(), b"first");
}

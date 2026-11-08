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
    let writer_store = f.store.clone();
    let writer_barrier = barrier.clone();
    let writer_done = finished.clone();
    let writer_mutations = mutations.clone();
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
    assert_eq!(
        mutations.load(Ordering::SeqCst),
        64,
        "Snapshot retries replayed a writer mutation"
    );
    let final_state = f.store.snapshot().unwrap();
    assert_eq!(final_state.seq, 65);
    assert_eq!(final_state.all_seq, 65);
}

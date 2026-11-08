//! Durable native sync intent. This ledger records changes, never credentials,
//! uploads, or the set of files a future synchronization must reconcile.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{SystemTime, UNIX_EPOCH},
};
const NAME: &str = "sync.json";
const LIMIT: u64 = 256 * 1024;
const MAX_DIRS: usize = 100;
const MAX_SEQ: u64 = (1u64 << 53) - 1;
static NEXT: AtomicU64 = AtomicU64::new(1);

/// An ordinary bounded ledger was atomically replaced during a snapshot.
/// This is transient; malformed JSON and unsafe file kinds remain hard errors.
#[derive(Debug)]
pub struct SnapshotChanged;
impl std::fmt::Display for SnapshotChanged {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Sync intent changed while reading")
    }
}
impl std::error::Error for SnapshotChanged {}
pub fn is_snapshot_changed(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| cause.is::<SnapshotChanged>())
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub seq: u64,
    pub dirs: BTreeMap<String, u64>,
    pub all_seq: u64,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}
impl Snapshot {
    pub fn is_dirty(&self) -> bool {
        self.all_seq > 0 || !self.dirs.is_empty()
    }
    pub fn outside_library(&self, root: &Path) -> Vec<PathBuf> {
        self.dirs
            .keys()
            .map(PathBuf::from)
            .filter(|dir| dir != root && !dir.starts_with(root))
            .collect()
    }
}
#[derive(Clone, Debug)]
pub struct Store {
    directory: PathBuf,
}
struct Document {
    raw: Value,
    bytes: Option<Vec<u8>>,
    state: Snapshot,
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory }
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.snapshot_with_hook(|| {})
    }
    fn snapshot_with_hook(&self, mut after_open: impl FnMut()) -> Result<Snapshot> {
        // Only read-only snapshots retry. Update closures and publication CAS
        // must still observe one exact captured document and run once.
        for attempt in 0..8 {
            let result = bytes_with_hook(&self.directory, &mut after_open).and_then(document);
            match result {
                Ok(document) => return Ok(document.state),
                Err(error) if is_snapshot_changed(&error) && attempt < 7 => {
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => return Err(error),
            }
        }
        unreachable!("Snapshot retry loop always returns")
    }
    pub fn mark_project(&self, dir: &Path, reason: &str) -> Result<()> {
        let key = absolute(dir)?;
        ensure!(key.len() <= 16384, "Dirty project path is too long");
        self.update(|state| {
            bump(state)?;
            state.dirs.insert(key.clone(), state.seq);
            if state.dirs.len() > MAX_DIRS {
                state.dirs.clear();
                state.all_seq = state.seq;
            }
            Ok(())
        })?;
        eprintln!("Sync intent marked: {} ({})", key, log_reason(reason));
        Ok(())
    }
    /// Cache-only lyrics are not projects. Do not create a ledger entry until
    /// the surrounding project.json exists, matching source markFileDirty.
    pub fn mark_file(&self, path: &Path, reason: &str) -> Result<()> {
        let dir = path.parent().context("Dirty file has no project folder")?;
        match fs::symlink_metadata(dir.join("project.json")) {
            Ok(meta) => ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Dirty project metadata must be an ordinary file"
            ),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
        }
        self.mark_project(dir, reason)
    }
    pub fn mark_library(&self, reason: &str) -> Result<()> {
        self.update(|state| {
            bump(state)?;
            state.all_seq = state.seq;
            state.dirs.clear();
            Ok(())
        })?;
        eprintln!("Sync intent marked: whole library ({})", log_reason(reason));
        Ok(())
    }
    /// A root move/first Save must not erase explicit intent for projects
    /// outside the selected root. This update shares the same lease as marks
    /// and cleanup, so concurrent project marks cannot be lost to a snapshot
    /// followed by a destructive whole-library mark.
    pub fn mark_library_preserving_projects(&self, reason: &str) -> Result<()> {
        self.update(|state| {
            bump(state)?;
            state.all_seq = state.seq;
            Ok(())
        })?;
        eprintln!(
            "Sync intent marked: whole library, retaining project scopes ({})",
            log_reason(reason)
        );
        Ok(())
    }
    pub fn clear(&self, up_to: u64) -> Result<Snapshot> {
        self.update(|state| {
            state.dirs.retain(|_, seq| *seq > up_to);
            if state.all_seq <= up_to {
                state.all_seq = 0;
            }
            if !state.is_dirty() {
                state.since = None;
            }
            Ok(())
        })
    }
    fn update(&self, change: impl FnOnce(&mut Snapshot) -> Result<()>) -> Result<Snapshot> {
        self.update_with_lock_timeout(std::time::Duration::from_secs(2), change)
    }
    // All callers are filesystem workers. Wait only for actual lease contention;
    // malformed state, symlinks, permissions and publication conflicts must not
    // be hidden behind retries or execute the mutation closure more than once.
    fn update_with_lock_timeout(
        &self,
        timeout: std::time::Duration,
        change: impl FnOnce(&mut Snapshot) -> Result<()>,
    ) -> Result<Snapshot> {
        fs::create_dir_all(&self.directory)?;
        let dir = self.directory.canonicalize()?;
        let started = std::time::Instant::now();
        let _lease = loop {
            match lease(&dir) {
                Ok(lease) => break lease,
                Err(error) => {
                    let busy = error
                        .downcast_ref::<std::io::Error>()
                        .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock);
                    let remaining = timeout.saturating_sub(started.elapsed());
                    if !busy || remaining.is_zero() {
                        return Err(error);
                    }
                    std::thread::sleep(remaining.min(std::time::Duration::from_millis(10)));
                }
            }
        };
        let mut document = read(&dir)?;
        change(&mut document.state)?;
        publish(&dir, document)
    }
}
pub fn snapshot() -> Result<Snapshot> {
    Store::new(crate::audio_devices::directory()).snapshot()
}
pub fn mark_project(dir: &Path, reason: &str) -> Result<()> {
    Store::new(crate::audio_devices::directory()).mark_project(dir, reason)
}
pub fn mark_file(path: &Path, reason: &str) -> Result<()> {
    Store::new(crate::audio_devices::directory()).mark_file(path, reason)
}
pub fn mark_library(reason: &str) -> Result<()> {
    Store::new(crate::audio_devices::directory()).mark_library(reason)
}
pub fn clear(up_to: u64) -> Result<Snapshot> {
    Store::new(crate::audio_devices::directory()).clear(up_to)
}
fn absolute(path: &Path) -> Result<String> {
    ensure!(path.is_absolute(), "Dirty project path must be absolute");
    Ok(path
        .to_str()
        .context("Dirty project path is not Unicode")?
        .to_owned())
}
fn log_reason(reason: &str) -> String {
    reason
        .chars()
        .take(300)
        .map(|c| if c.is_control() { ' ' } else { c })
        .collect()
}
fn bump(state: &mut Snapshot) -> Result<()> {
    ensure!(
        state.seq < MAX_SEQ,
        "Dirty sequence is exhausted; acknowledgement cannot be advanced safely"
    );
    state.seq += 1;
    if state.since.unwrap_or(0) == 0 {
        let millis = SystemTime::now().duration_since(UNIX_EPOCH)?.as_millis();
        ensure!(
            millis <= MAX_SEQ as u128,
            "Dirty timestamp exceeds its safe range"
        );
        state.since = Some(millis as u64);
    }
    Ok(())
}
fn ordinary(meta: &fs::Metadata) -> bool {
    meta.is_file() && !meta.file_type().is_symlink()
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    let valid =
        ordinary(a) && ordinary(b) && a.len() == b.len() && a.modified().ok() == b.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        valid && a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        valid
    }
}
fn bytes(dir: &Path) -> Result<Option<Vec<u8>>> {
    bytes_with_hook(dir, &mut || {})
}
fn bounded_ordinary(meta: &fs::Metadata) -> Result<()> {
    ensure!(
        ordinary(meta) && meta.len() > 0 && meta.len() <= LIMIT,
        "Sync intent must be an ordinary bounded file"
    );
    Ok(())
}
fn bytes_with_hook(dir: &Path, after_open: &mut impl FnMut()) -> Result<Option<Vec<u8>>> {
    let path = dir.join(NAME);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    bounded_ordinary(&meta)?;
    let file = File::open(&path)?;
    let opened = file.metadata()?;
    bounded_ordinary(&opened)?;
    if !same(&meta, &opened) {
        return Err(SnapshotChanged.into());
    }
    after_open();
    let mut result = vec![];
    file.take(LIMIT + 1).read_to_end(&mut result)?;
    ensure!(
        result.len() as u64 <= LIMIT,
        "Sync intent exceeds its bound"
    );
    let current = fs::symlink_metadata(&path)?;
    // Never retry an unsafe replacement as though it were an app publication.
    bounded_ordinary(&current)?;
    if !same(&meta, &current) {
        return Err(SnapshotChanged.into());
    }
    Ok(Some(result))
}
fn read(dir: &Path) -> Result<Document> {
    document(bytes(dir)?)
}
fn document(bytes: Option<Vec<u8>>) -> Result<Document> {
    let raw: Value = match &bytes {
        Some(bytes) => serde_json::from_slice(bytes).context("Invalid sync intent JSON")?,
        None => json!({"version":1}),
    };
    ensure!(
        raw.is_object() && raw.get("version").is_none_or(|v| v.as_u64() == Some(1)),
        "Unsupported sync intent document"
    );
    let mut state = Snapshot::default();
    if let Some(dirty) = raw.get("gdriveDirty").filter(|v| !v.is_null()) {
        ensure!(dirty.is_object(), "Invalid sync intent state");
        state.seq = dirty["seq"]
            .as_u64()
            .filter(|seq| *seq <= MAX_SEQ)
            .context("Invalid dirty sequence")?;
        if let Some(dirs) = dirty.get("dirs").filter(|v| !v.is_null()) {
            let dirs = dirs.as_object().context("Invalid dirty project map")?;
            ensure!(
                dirs.len() <= MAX_DIRS,
                "Dirty project map exceeds its limit"
            );
            for (path, seq) in dirs {
                ensure!(path.len() <= 16384, "Dirty project path is too long");
                absolute(Path::new(path))?;
                let seq = seq
                    .as_u64()
                    .filter(|seq| *seq > 0 && *seq <= state.seq)
                    .context("Invalid dirty project sequence")?;
                state.dirs.insert(path.clone(), seq);
            }
        }
        if let Some(all) = dirty.get("allSeq").filter(|v| !v.is_null()) {
            state.all_seq = all
                .as_u64()
                .filter(|seq| *seq <= state.seq)
                .context("Invalid whole-library dirty sequence")?;
        }
        if let Some(since) = dirty.get("since").filter(|v| !v.is_null()) {
            state.since = Some(
                since
                    .as_u64()
                    .filter(|time| *time <= MAX_SEQ)
                    .context("Invalid dirty timestamp")?,
            );
        }
    }
    Ok(Document { raw, bytes, state })
}
fn lease(dir: &Path) -> Result<crate::file_lease::Lease> {
    let path = dir.join(".sync-dirty.lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) => {
            // Windows reports AccessDenied rather than AlreadyExists when the
            // existing lock path is a directory. Inspect the actual member
            // before deciding whether it is a reusable coordination file.
            let meta = match fs::symlink_metadata(&path) {
                Ok(meta) => meta,
                Err(missing) if missing.kind() == std::io::ErrorKind::NotFound => {
                    return Err(error.into());
                }
                Err(error) => return Err(error.into()),
            };
            ensure!(ordinary(&meta), "Invalid sync intent lock");
            let file = OpenOptions::new().read(true).write(true).open(&path)?;
            ensure!(
                same(&meta, &file.metadata()?) && same(&meta, &fs::symlink_metadata(&path)?),
                "Sync intent lock changed"
            );
            file
        }
    };
    crate::file_lease::Lease::acquire(file).context("Sync intent is already being updated")
}
fn publish(dir: &Path, mut document: Document) -> Result<Snapshot> {
    let mut dirty = document
        .raw
        .get("gdriveDirty")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    dirty["seq"] = json!(document.state.seq);
    dirty["dirs"] = serde_json::to_value(&document.state.dirs)?;
    dirty["allSeq"] = json!(document.state.all_seq);
    if let Some(since) = document.state.since {
        dirty["since"] = json!(since);
    } else {
        dirty.as_object_mut().unwrap().remove("since");
    }
    document.raw["version"] = json!(1);
    document.raw["gdriveDirty"] = dirty;
    let encoded = serde_json::to_vec_pretty(&document.raw)?;
    ensure!(
        encoded.len() as u64 <= LIMIT,
        "Sync intent exceeds its bound"
    );
    let path = dir.join(format!(
        ".sync-dirty-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    struct Pending(PathBuf);
    impl Drop for Pending {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let pending = Pending(path);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending.0)?;
    file.write_all(&encoded)?;
    file.sync_all()?;
    drop(file);
    ensure!(
        bytes(dir)? == document.bytes,
        "Sync intent changed outside this app"
    );
    if document.bytes.is_some() {
        crate::project_store::replace(&pending.0, &dir.join(NAME))?;
    } else {
        fs::hard_link(&pending.0, dir.join(NAME))
            .context("Sync intent appeared during publication")?;
    }
    #[cfg(unix)]
    File::open(dir)?
        .sync_all()
        .context("Could not flush durable sync intent directory")?;
    Ok(document.state)
}

#[cfg(test)]
#[path = "sync_dirty_tests.rs"]
mod tests;

#[cfg(test)]
mod preserving_library_tests {
    use super::*;
    #[test]
    fn library_mark_preserves_outside_projects_and_racing_new_marks() {
        let root = std::env::temp_dir().join(format!(
            "singz-dirty-preserve-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let store = Store::new(root.join("prefs"));
        let outside = root.join("old-library/song");
        store.mark_project(&outside, "old root edit").unwrap();
        let captured = store.snapshot().unwrap().seq;
        // Exercise the two possible serialized orderings of independent worker
        // marks and the atomic library operation, without global preferences.
        let new = root.join("new-library/song");
        store
            .mark_project(&new, "concurrent writer before library mark")
            .unwrap();
        store.mark_library_preserving_projects("root move").unwrap();
        let after = store.snapshot().unwrap();
        assert!(after.all_seq > captured);
        assert!(after.dirs.contains_key(outside.to_str().unwrap()));
        assert!(after.dirs.contains_key(new.to_str().unwrap()));
        store
            .mark_project(&outside, "concurrent writer after library mark")
            .unwrap();
        let remaining = store.clear(captured).unwrap();
        assert!(remaining.all_seq > captured);
        assert!(remaining.dirs.contains_key(outside.to_str().unwrap()));
        assert!(remaining.dirs.contains_key(new.to_str().unwrap()));
        let barrier = std::sync::Arc::new(std::sync::Barrier::new(3));
        let mut workers = vec![];
        for library in [false, true] {
            let store = store.clone();
            let barrier = barrier.clone();
            let new = new.clone();
            workers.push(std::thread::spawn(move || {
                barrier.wait();
                let deadline = std::time::Instant::now() + std::time::Duration::from_secs(2);
                loop {
                    let result = if library {
                        store.mark_library_preserving_projects("racing library change")
                    } else {
                        store.mark_project(&new, "racing project change")
                    };
                    if result.is_ok() {
                        break;
                    }
                    assert!(std::time::Instant::now() < deadline, "ledger remained busy");
                    std::thread::yield_now();
                }
            }));
        }
        barrier.wait();
        for worker in workers {
            worker.join().unwrap();
        }
        let raced = store.snapshot().unwrap();
        assert!(raced.all_seq > remaining.all_seq);
        assert!(raced.dirs.contains_key(outside.to_str().unwrap()));
        assert!(raced.dirs.contains_key(new.to_str().unwrap()));
        fs::remove_dir_all(root).unwrap();
    }
}

#[cfg(test)]
mod lock_retry_tests {
    use super::*;
    fn fixture() -> (PathBuf, Store) {
        let root = std::env::temp_dir().join(format!(
            "singz-dirty-retry-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let store = Store::new(root.join("prefs"));
        (root, store)
    }
    #[test]
    fn another_store_waits_for_real_writer_lease_and_preserves_both_marks() {
        let (root, store) = fixture();
        let first = root.join("first");
        let second = root.join("second");
        store.mark_project(&first, "first writer").unwrap();
        let held = lease(&store.directory).unwrap();
        let other = Store::new(store.directory.clone());
        let worker_path = second.clone();
        let (started_tx, started_rx) = std::sync::mpsc::channel();
        let worker = std::thread::spawn(move || {
            started_tx.send(()).unwrap();
            other.mark_project(&worker_path, "second writer")
        });
        started_rx.recv().unwrap();
        // Keep the real file lease long enough to require several 10ms attempts.
        std::thread::sleep(std::time::Duration::from_millis(40));
        assert!(
            !worker.is_finished(),
            "second writer bypassed the held lease"
        );
        drop(held);
        worker.join().unwrap().unwrap();
        let state = store.snapshot().unwrap();
        assert_eq!(state.seq, 2);
        assert_eq!(state.dirs[first.to_str().unwrap()], 1);
        assert_eq!(state.dirs[second.to_str().unwrap()], 2);
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn held_lease_times_out_without_mutation_and_invalid_lock_is_not_retried() {
        let (root, store) = fixture();
        fs::create_dir_all(&store.directory).unwrap();
        let held = lease(&store.directory).unwrap();
        let called = std::cell::Cell::new(false);
        let started = std::time::Instant::now();
        let error = store
            .update_with_lock_timeout(std::time::Duration::from_millis(20), |_| {
                called.set(true);
                Ok(())
            })
            .unwrap_err();
        assert!(
            error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
        );
        assert!(started.elapsed() >= std::time::Duration::from_millis(20));
        assert!(!called.get());
        assert!(!store.directory.join(NAME).exists());
        drop(held);
        fs::remove_file(store.directory.join(".sync-dirty.lock")).unwrap();
        fs::create_dir(store.directory.join(".sync-dirty.lock")).unwrap();
        let error = store
            .update_with_lock_timeout(std::time::Duration::from_secs(2), |_| {
                called.set(true);
                Ok(())
            })
            .unwrap_err();
        assert!(error.to_string().contains("Invalid sync intent lock"));
        assert!(!called.get());
        fs::remove_dir_all(root).unwrap();
    }
}

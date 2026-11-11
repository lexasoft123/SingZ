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
const MAX_RETIRE_OPS: usize = 1024;
const MAX_SEQ: u64 = (1u64 << 53) - 1;
static NEXT: AtomicU64 = AtomicU64::new(1);
const SNAPSHOT_ATTEMPTS: usize = 8;
const WRITER_ATTEMPTS: usize = 26;
const WRITER_RETRY_BUDGET: std::time::Duration = std::time::Duration::from_millis(250);
const WRITER_RETRY_DELAY: std::time::Duration = std::time::Duration::from_millis(10);

// Only ledger open/metadata or publication failures may carry this marker. Exhaustion returns
// the underlying OS error so a persistent ACL denial is never reported as churn.
#[derive(Debug)]
struct LedgerFileBusy(std::io::Error);
impl std::fmt::Display for LedgerFileBusy {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        std::fmt::Display::fmt(&self.0, f)
    }
}
impl std::error::Error for LedgerFileBusy {
    fn source(&self) -> Option<&(dyn std::error::Error + 'static)> {
        Some(&self.0)
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum SnapshotIo {
    Metadata,
    Open,
    OpenedMetadata,
    Read,
    CurrentMetadata,
    Directory,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum WriterIo {
    Read(SnapshotIo),
    Cas(SnapshotIo),
    Create,
    Replace,
    StageOpen,
    StageWrite,
    StageFlush,
    Directory,
    DirectoryFlush,
}
#[cfg(test)]
#[derive(Debug)]
struct WriterFaults {
    step: WriterIo,
    code: i32,
    failures: usize,
    calls: std::sync::atomic::AtomicUsize,
    external: Option<Vec<u8>>,
    directory_error: Option<i32>,
    windows: bool,
    attempt_limit: usize,
}

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
    /// Positive local operation references; ordinary cleanup never consumes them.
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub retire_ops: BTreeMap<String, u64>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub since: Option<u64>,
}
impl Snapshot {
    pub fn is_dirty(&self) -> bool {
        self.all_seq > 0 || !self.dirs.is_empty() || !self.retire_ops.is_empty()
    }
    pub fn outside_library(&self, root: &Path) -> Vec<PathBuf> {
        self.dirs
            .keys()
            .map(PathBuf::from)
            .filter(|dir| dir != root && !dir.starts_with(root))
            .collect()
    }
}
/// Publication became visible, but its directory flush did not confirm durability.
#[derive(Debug)]
pub struct PublicationUncertain {cause:anyhow::Error}
impl std::fmt::Display for PublicationUncertain {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {write!(f,"Published sync intent durability is unknown: {:#}",self.cause)}
}
impl std::error::Error for PublicationUncertain {}
pub fn is_publication_uncertain(error:&anyhow::Error)->bool {
    error.chain().any(|cause|cause.is::<PublicationUncertain>())
}
/// The operation update failed before entering ledger publication. Existing
/// unreadable bytes are not evidence that this attempt might have committed.
#[derive(Debug)]
pub struct PublicationNotAttempted { cause:anyhow::Error }
impl std::fmt::Display for PublicationNotAttempted {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        write!(f,"Sync intent preparation failed before publication: {:#}",self.cause)
    }
}
impl std::error::Error for PublicationNotAttempted {
    fn source(&self)->Option<&(dyn std::error::Error+'static)> {Some(self.cause.as_ref())}
}
pub fn is_publication_not_attempted(error:&anyhow::Error)->bool {
    error.chain().any(|cause|cause.is::<PublicationNotAttempted>())
}
#[derive(Clone, Debug)]
pub struct Store {
    directory: PathBuf,
    #[cfg(test)] fail_publication_flush:bool,
    #[cfg(test)] writer_faults: Option<std::sync::Arc<WriterFaults>>,
}
struct Document {
    raw: Value,
    bytes: Option<Vec<u8>>,
    state: Snapshot,
}
impl Store {
    pub fn new(directory: PathBuf) -> Self {
        Self { directory, #[cfg(test)] fail_publication_flush:false, #[cfg(test)] writer_faults:None }
    }
    #[cfg(test)]
    pub(crate) fn with_failed_publication_flush(&self)->Self {
        let mut store=self.clone();store.fail_publication_flush=true;store
    }
    pub fn directory(&self) -> &Path {
        &self.directory
    }
    pub fn snapshot(&self) -> Result<Snapshot> {
        self.snapshot_with_hook(|| {})
    }
    fn snapshot_with_hook(&self, after_open: impl FnMut()) -> Result<Snapshot> {
        self.snapshot_with_io_hook(after_open, |_| Ok(()))
    }
    fn snapshot_with_io_hook(
        &self,
        after_open: impl FnMut(),
        before_io: impl FnMut(SnapshotIo) -> std::io::Result<()>,
    ) -> Result<Snapshot> {
        self.snapshot_with_io_policy(after_open, before_io, cfg!(windows))
    }
    fn snapshot_with_io_policy(
        &self,
        mut after_open: impl FnMut(),
        mut before_io: impl FnMut(SnapshotIo) -> std::io::Result<()>,
        windows_file_races: bool,
    ) -> Result<Snapshot> {
        // The platform policy is an argument only so host tests can exercise
        // Windows errors. Production enables it exclusively on Windows above.
        // Snapshot retries never execute writer callbacks. Writer retries below
        // restart the complete captured-document transaction separately.
        for attempt in 0..SNAPSHOT_ATTEMPTS {
            let result = bytes_with_hook(
                &self.directory,
                &mut after_open,
                &mut before_io,
                windows_file_races,
            )
            .and_then(document);
            match result {
                Ok(document) => return Ok(document.state),
                Err(error)
                    if (is_snapshot_changed(&error) || error.is::<LedgerFileBusy>())
                        && attempt + 1 < SNAPSHOT_ATTEMPTS =>
                {
                    // Keep the existing budget: seven 2 ms sleeps, 14 ms total.
                    std::thread::sleep(std::time::Duration::from_millis(2));
                }
                Err(error) => {
                    return Err(match error.downcast::<LedgerFileBusy>() {
                        Ok(busy) => busy.0.into(),
                        Err(error) => error,
                    });
                }
            }
        }
        unreachable!("Snapshot retry loop always returns")
    }
    pub fn mark_project(&self, dir: &Path, reason: &str) -> Result<()> {
        let key = absolute(dir)?;
        ensure!(key.len() <= 16384, "Dirty project path is too long");
        // Downloaded projects are local offline copies, outside writer authority.
        // A title rename retains their cache parent; deleted cache copies must
        // not enqueue a writer run either. Linked cache roots confer no exemption.
        if self.is_download_cache_project(dir) { return Ok(()); }

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
    /// Atomically make a successful local operation authoritative and dirty.
    /// The immutable operation body must already be durable before this call.
    pub fn commit_operation(&self, dirs: &[PathBuf], id: &str, reason: &str) -> Result<u64> {
        let mut publication_started=false;
        let result=(||->Result<Snapshot> {
            ensure!(operation_id_valid(id), "Invalid local operation ID");
            let keys = dirs.iter().filter(|dir| !self.is_download_cache_project(dir))
                .map(|dir| {let key=absolute(dir)?;ensure!(key.len()<=16384,"Dirty project path is too long");Ok(key)})
                .collect::<Result<Vec<_>>>()?;
            ensure!(!keys.is_empty(), "A cache-only operation cannot authorize library retirement");
            self.update_with_publication_stage(std::time::Duration::from_secs(2),|state| {
                if state.retire_ops.contains_key(id) { return Ok(()); }
                ensure!(state.retire_ops.len()<MAX_RETIRE_OPS,"Too many unacknowledged local operations");
                bump(state)?;
                for key in &keys {state.dirs.insert(key.clone(),state.seq);}
                if state.dirs.len()>MAX_DIRS {state.dirs.clear();state.all_seq=state.seq;}
                state.retire_ops.insert(id.into(),state.seq);
                Ok(())
            },|started|publication_started=started)
        })();
        let state=result.map_err(|cause|if publication_started {cause}
            else {anyhow::Error::new(PublicationNotAttempted{cause})})?;
        eprintln!("Sync operation committed: {} ({})",id,log_reason(reason));
        Ok(state.retire_ops[id])
    }
    /// Remove only a verified remote operation receipt, retaining newer edits.
    pub fn acknowledge_operation(&self, id:&str, expected_sequence:u64)->Result<bool> {
        ensure!(operation_id_valid(id),"Invalid local operation ID");
        let mut removed=false;
        self.update(|state| {
            removed=state.retire_ops.get(id)==Some(&expected_sequence);
            if removed {state.retire_ops.remove(id);}
            if !state.is_dirty(){state.since=None;}
            Ok(())
        })?;
        Ok(removed)
    }
    fn is_download_cache_project(&self, dir: &Path) -> bool {
        let Some(config)=self.directory.canonicalize().ok() else {return false;};
        let gdrive=config.join("gdrive");
        let cache=gdrive.join("downloads");
        let ordinary_dir=|path:&Path|fs::symlink_metadata(path).is_ok_and(|m|m.is_dir()&&!m.file_type().is_symlink());
        if !ordinary_dir(&gdrive)||!ordinary_dir(&cache) {return false;}
        if fs::symlink_metadata(dir).is_ok_and(|m|m.file_type().is_symlink()) {return false;}
        dir.parent().and_then(|p|p.canonicalize().ok())
            .zip(cache.canonicalize().ok()).is_some_and(|(parent,cache)|parent==cache)
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
    fn update(&self, change: impl FnMut(&mut Snapshot) -> Result<()>) -> Result<Snapshot> {
        self.update_with_lock_timeout(std::time::Duration::from_secs(2), change)
    }
    // Callbacks mutate only the supplied candidate and may be replayed after a
    // provably uncommitted Windows file failure. Assign result flags afresh on
    // every attempt; external side effects do not belong in these callbacks.
    // Malformed data, unsafe files and CAS conflicts remain permanent errors.
    fn update_with_lock_timeout(
        &self,
        timeout: std::time::Duration,
        change: impl FnMut(&mut Snapshot) -> Result<()>,
    ) -> Result<Snapshot> {
        self.update_with_publication_stage(timeout, change, |_| {})
    }
    fn update_with_publication_stage(
        &self,
        timeout: std::time::Duration,
        mut change: impl FnMut(&mut Snapshot) -> Result<()>,
        mut publication_stage: impl FnMut(bool),
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
        // Hold the lease across the bounded retry window. Each candidate and
        // pending staging file is dropped before sleeping; every attempt reads
        // a fresh document, reapplies the mutation, then checks its own CAS.
        let retry_started = std::time::Instant::now();
        let windows = self.writer_windows_policy();
        let limit = WRITER_ATTEMPTS;
        #[cfg(test)]
        let limit = self
            .writer_faults
            .as_ref()
            .map_or(limit, |faults| faults.attempt_limit);
        for attempt in 0..limit {
            publication_stage(false);
            let result = (|| {
                let mut document = document(bytes_with_hook(
                    &dir,
                    &mut || {},
                    &mut |step| self.writer_io(WriterIo::Read(step)),
                    windows,
                )?)?;
                change(&mut document.state)?;
                publication_stage(true);
                publish_with_hook(
                    &dir,
                    document,
                    |dir| {
                        self.writer_io(WriterIo::DirectoryFlush)?;
                        #[cfg(test)]
                        if self.fail_publication_flush {
                            anyhow::bail!(
                                "Injected directory flush failure after ledger publication"
                            );
                        }
                        flush_directory(dir)
                    },
                    &mut |step| self.writer_io(step),
                    windows,
                )
            })();
            match result {
                Ok(state) => return Ok(state),
                Err(error) => {
                    let remaining = WRITER_RETRY_BUDGET.saturating_sub(retry_started.elapsed());
                    if error.is::<LedgerFileBusy>() && attempt + 1 < limit && !remaining.is_zero() {
                        std::thread::sleep(remaining.min(WRITER_RETRY_DELAY));
                        continue;
                    }
                    return Err(match error.downcast::<LedgerFileBusy>() {
                        Ok(busy) => busy.0.into(),
                        Err(error) => error,
                    });
                }
            }
        }
        unreachable!("Writer retry loop always returns")
    }
    fn writer_windows_policy(&self) -> bool {
        #[cfg(test)]
        if let Some(faults) = &self.writer_faults {
            return faults.windows;
        }
        cfg!(windows)
    }
    fn writer_io(&self, step: WriterIo) -> std::io::Result<()> {
        #[cfg(test)]
        if let Some(faults) = &self.writer_faults {
            if matches!(
                step,
                WriterIo::Directory
                    | WriterIo::Read(SnapshotIo::Directory)
                    | WriterIo::Cas(SnapshotIo::Directory)
            ) {
                if let Some(code) = faults.directory_error {
                    return Err(std::io::Error::from_raw_os_error(code));
                }
            }
            if step == faults.step {
                let call = faults.calls.fetch_add(1, Ordering::SeqCst);
                if call < faults.failures {
                    // Emulate an independent publisher between failed attempts.
                    if let Some(bytes) = &faults.external {
                        fs::write(self.directory.join(NAME), bytes)?;
                    }
                    return Err(std::io::Error::from_raw_os_error(faults.code));
                }
            }
        }
        let _ = step;
        Ok(())
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
pub fn operation_id_valid(id:&str)->bool {
    !id.is_empty() && id.len()<=128 && id.bytes().all(|b|b.is_ascii_alphanumeric()||b==b'-')
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
    bytes_with_hook(dir, &mut || {}, &mut |_| Ok(()), false)
}
fn bounded_ordinary(meta: &fs::Metadata) -> Result<()> {
    ensure!(
        ordinary(meta) && meta.len() > 0 && meta.len() <= LIMIT,
        "Sync intent must be an ordinary bounded file"
    );
    Ok(())
}
fn ledger_read_io<T>(
    dir: &Path,
    step: SnapshotIo,
    before_io: &mut impl FnMut(SnapshotIo) -> std::io::Result<()>,
    windows_file_races: bool,
    operation: impl FnOnce() -> std::io::Result<T>,
) -> Result<T> {
    let result = before_io(step).and_then(|()| operation());
    match result {
        Err(error)
            if windows_file_races
                && matches!(
                    step,
                    SnapshotIo::Metadata
                        | SnapshotIo::Open
                        | SnapshotIo::OpenedMetadata
                        | SnapshotIo::CurrentMetadata
                )
                && matches!(error.raw_os_error(), Some(5 | 32)) =>
        {
            // A ledger's delete-pending handle can deny open/metadata briefly.
            // A denied directory is not a replace race: surface it immediately.
            before_io(SnapshotIo::Directory)?;
            fs::read_dir(dir)?.next().transpose()?;
            Err(LedgerFileBusy(error).into())
        }
        result => Ok(result?),
    }
}
fn bytes_with_hook(
    dir: &Path,
    after_open: &mut impl FnMut(),
    before_io: &mut impl FnMut(SnapshotIo) -> std::io::Result<()>,
    windows_file_races: bool,
) -> Result<Option<Vec<u8>>> {
    let path = dir.join(NAME);
    let meta = match ledger_read_io(
        dir,
        SnapshotIo::Metadata,
        before_io,
        windows_file_races,
        || fs::symlink_metadata(&path),
    ) {
        Ok(meta) => meta,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|error| error.kind() == std::io::ErrorKind::NotFound) =>
        {
            return Ok(None);
        }
        Err(error) => return Err(error),
    };
    bounded_ordinary(&meta)?;
    let file = ledger_read_io(dir, SnapshotIo::Open, before_io, windows_file_races, || {
        File::open(&path)
    })?;
    let opened = ledger_read_io(
        dir,
        SnapshotIo::OpenedMetadata,
        before_io,
        windows_file_races,
        || file.metadata(),
    )?;
    bounded_ordinary(&opened)?;
    if !same(&meta, &opened) {
        return Err(SnapshotChanged.into());
    }
    after_open();
    let mut result = vec![];
    ledger_read_io(dir, SnapshotIo::Read, before_io, windows_file_races, || {
        file.take(LIMIT + 1).read_to_end(&mut result)
    })?;
    ensure!(
        result.len() as u64 <= LIMIT,
        "Sync intent exceeds its bound"
    );
    let current = ledger_read_io(
        dir,
        SnapshotIo::CurrentMetadata,
        before_io,
        windows_file_races,
        || fs::symlink_metadata(&path),
    )?;
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
        if let Some(operations)=dirty.get("retireOps").filter(|value|!value.is_null()) {
            let operations=operations.as_object().context("Invalid local operation references")?;
            ensure!(operations.len()<=MAX_RETIRE_OPS,"Too many local operation references");
            for (id,sequence) in operations {
                ensure!(operation_id_valid(id),"Invalid local operation ID");
                let sequence=sequence.as_u64().filter(|seq|*seq>0&&*seq<=state.seq).context("Invalid local operation sequence")?;
                state.retire_ops.insert(id.clone(),sequence);
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
fn flush_directory(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(dir)?
        .sync_all()
        .context("Could not flush durable sync intent directory")?;
    let _ = dir;
    Ok(())
}
#[cfg(test)]
fn publish(dir: &Path, document: Document) -> Result<Snapshot> {
    publish_with_flush(dir, document, flush_directory)
}
#[cfg(test)]
fn publish_with_flush(
    dir: &Path,
    document: Document,
    flush: impl FnOnce(&Path) -> Result<()>,
) -> Result<Snapshot> {
    publish_with_hook(dir, document, flush, &mut |_| Ok(()), false)
}
fn publication_io<T>(
    dir: &Path,
    step: WriterIo,
    before_io: &mut impl FnMut(WriterIo) -> std::io::Result<()>,
    windows: bool,
    operation: impl FnOnce() -> std::io::Result<T>,
) -> Result<T> {
    match before_io(step).and_then(|()| operation()) {
        Err(error)
            if windows
                && matches!(step, WriterIo::Create | WriterIo::Replace)
                && matches!(error.raw_os_error(), Some(5 | 32)) =>
        {
            before_io(WriterIo::Directory)?;
            fs::read_dir(dir)?.next().transpose()?;
            Err(LedgerFileBusy(error).into())
        }
        result => Ok(result?),
    }
}
fn publish_with_hook(
    dir: &Path,
    mut document: Document,
    flush: impl FnOnce(&Path) -> Result<()>,
    before_io: &mut impl FnMut(WriterIo) -> std::io::Result<()>,
    windows: bool,
) -> Result<Snapshot> {
    let mut dirty = document
        .raw
        .get("gdriveDirty")
        .filter(|v| v.is_object())
        .cloned()
        .unwrap_or_else(|| json!({}));
    dirty["seq"] = json!(document.state.seq);
    dirty["dirs"] = serde_json::to_value(&document.state.dirs)?;
    dirty["allSeq"] = json!(document.state.all_seq);
    if document.state.retire_ops.is_empty() {dirty.as_object_mut().unwrap().remove("retireOps");}
    else {dirty["retireOps"]=serde_json::to_value(&document.state.retire_ops)?;}
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
    let mut file = publication_io(dir, WriterIo::StageOpen, before_io, windows, || {
        OpenOptions::new()
            .write(true)
            .create_new(true)
            .open(&pending.0)
    })?;
    publication_io(dir, WriterIo::StageWrite, before_io, windows, || {
        file.write_all(&encoded)
    })?;
    publication_io(dir, WriterIo::StageFlush, before_io, windows, || {
        file.sync_all()
    })?;
    drop(file);
    ensure!(
        bytes_with_hook(
            dir,
            &mut || {},
            &mut |step| before_io(WriterIo::Cas(step)),
            windows
        )? == document.bytes,
        "Sync intent changed outside this app"
    );
    if document.bytes.is_some() {
        // The completed staging file was already flushed through its writable
        // handle above. Avoid project_store::replace's redundant Windows reopen
        // and flush, and classify only the actual atomic rename failure here.
        publication_io(dir, WriterIo::Replace, before_io, windows, || {
            fs::rename(&pending.0, dir.join(NAME))
        })?;
    } else {
        publication_io(dir, WriterIo::Create, before_io, windows, || {
            fs::hard_link(&pending.0, dir.join(NAME))
        })
        .context("Sync intent appeared during publication")?;
    }
    flush(dir).map_err(|cause|anyhow::Error::new(PublicationUncertain{cause}))?;
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

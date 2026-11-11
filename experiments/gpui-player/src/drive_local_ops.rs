//! Durable positive local Delete/Rename authority, separate from dirty hints.
use crate::{
    directory_identity::{self, DirectoryIdentity},
    sync_dirty,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 128 * 1024;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub enum Kind {
    Delete,
    Rename,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Operation {
    #[serde(skip)]
    pub id: String,
    pub version: u32,
    pub nonce: String,
    pub kind: Kind,
    pub local_root: PathBuf,
    pub root_identity: DirectoryIdentity,
    pub old_path: PathBuf,
    /// Exact hidden Delete destination or requested Rename destination.
    pub destination: PathBuf,
    pub local_identity: DirectoryIdentity,
    pub local_document: String,
    pub binding: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum State {
    Prepared,
    Committed(u64),
    Aborted,
    Done(u64),
}
#[derive(Clone, Debug)]
pub struct Entry {
    pub operation: Operation,
    pub state: State,
    pub active: bool,
}
#[derive(Clone, Debug)]
pub struct Guard {
    pub root: PathBuf,
    pub root_identity: DirectoryIdentity,
    pub entries: Vec<Entry>,
    pub epoch: String,
}
#[derive(Clone, Debug, Default)]
pub struct RecoveryReport {
    pub resolved: Vec<String>,
    pub blocked: Vec<String>,
    pub busy: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct Store {
    config: PathBuf,
}
pub struct Prepared {
    pub operation: Operation,
    store: Store,
    _lease: crate::file_lease::Lease,
}
#[derive(Clone, Debug)]
pub struct Committed {
    pub operation: Operation,
    pub sequence: u64,
    pub warning: Option<String>,
}
/// Publication could have committed; retaining the moved directory is mandatory.
#[derive(Debug)]
pub struct CommitOutcomeUnknown {
    pub operation_id: String,
}
impl std::fmt::Display for CommitOutcomeUnknown {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(
            f,
            "Local operation {} has an unknown commit outcome; retain its moved directory for recovery",
            self.operation_id
        )
    }
}
impl std::error::Error for CommitOutcomeUnknown {}
pub fn is_commit_unknown(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<CommitOutcomeUnknown>())
}
fn private_directory(path: &Path) -> Result<()> {
    if !path.exists() {
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(path)?;
    }
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Linked local-operation storage refused"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "Local-operation storage must be private"
        );
    }
    Ok(())
}
fn sync(path: &Path) -> Result<()> {
    #[cfg(not(windows))]
    File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    let ordinary = |m: &fs::Metadata| m.is_file() && !m.file_type().is_symlink();
    let same =
        ordinary(a) && ordinary(b) && a.len() == b.len() && a.modified().ok() == b.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        same && a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        same && a.created().ok() == b.created().ok()
    }
}
fn bounded(path: &Path) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    ensure!(
        before.is_file() && !before.file_type().is_symlink() && before.len() <= LIMIT,
        "Unsafe local operation file"
    );
    let file = File::open(path)?;
    ensure!(
        same_file(&file.metadata()?, &before),
        "Local operation changed while opening"
    );
    let mut bytes = vec![];
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == before.len() && same_file(&before, &fs::symlink_metadata(path)?),
        "Local operation changed while reading"
    );
    Ok(bytes)
}
fn valid_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn identity_if_present(path: &Path) -> Result<Option<DirectoryIdentity>> {
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(Some(directory_identity::read(path)?)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
impl Store {
    pub fn new(config: PathBuf) -> Self {
        Self { config }
    }
    fn path(&self) -> PathBuf {
        self.config.join("gdrive/local-operations")
    }
    fn create(&self) -> Result<PathBuf> {
        // The caller supplies its existing native configuration directory.
        fs::create_dir_all(&self.config)?;
        let config = self.config.canonicalize()?;
        let parent = config.join("gdrive");
        if !parent.exists() {
            private_directory(&parent)?;
        }
        let meta = fs::symlink_metadata(&parent)?;
        ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "Linked native Drive storage refused"
        );
        private_directory(&config.join("gdrive/local-operations"))?;
        Ok(config.join("gdrive/local-operations"))
    }
    fn immutable(&self, name: &str, bytes: &[u8]) -> Result<()> {
        let root = self.create()?;
        let path = root.join(name);
        if path.exists() {
            ensure!(
                bounded(&path)? == bytes,
                "Local operation immutable bytes changed"
            );
            return Ok(());
        }
        let temp = root.join(format!(".prepare-{}", crate::drive_http::random_id()?));
        let result = (|| -> Result<()> {
            let mut file = crate::drive_http::private_file(&temp)?;
            file.write_all(bytes)?;
            file.sync_all()?;
            drop(file);
            fs::hard_link(&temp, &path).context("Local operation appeared during publication")?;
            sync(&root)
        })();
        let _ = fs::remove_file(temp);
        result
    }
    fn lease(&self, id: &str) -> Result<crate::file_lease::Lease> {
        ensure!(valid_id(id), "Invalid local operation identity");
        let path = self.create()?.join(format!("{id}.lock"));
        if path.exists() {
            let meta = fs::symlink_metadata(&path)?;
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Linked local operation lease refused"
            );
        }
        let mut options = OpenOptions::new();
        options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        Ok(crate::file_lease::Lease::acquire(options.open(path)?)?)
    }
    pub fn prepare(
        &self,
        kind: Kind,
        root: &Path,
        old: &Path,
        destination: &Path,
        expected: &str,
        binding: Option<String>,
    ) -> Result<Prepared> {
        let local_root = root.canonicalize()?;
        let old_path = old.canonicalize()?;
        ensure!(
            old_path.parent() == Some(local_root.as_path()),
            "Local operation is outside the selected library"
        );
        ensure!(
            destination.is_absolute()
                && destination.parent() == Some(local_root.as_path())
                && destination != old_path.as_path(),
            "Invalid local operation destination"
        );
        ensure!(
            crate::drive_plan::plain_name(
                destination
                    .file_name()
                    .and_then(|n| n.to_str())
                    .context("Invalid operation destination name")?
            ),
            "Unsafe local operation destination"
        );
        ensure!(
            binding
                .as_ref()
                .is_none_or(|value| !value.is_empty() && value.len() <= 512),
            "Invalid local operation binding"
        );
        let root_identity = directory_identity::read(&local_root)?;
        root_identity.require_persistent()?;
        let local_identity = directory_identity::read(&old_path)?;
        local_identity.require_persistent()?;
        let (_, actual) = crate::project_store::read(&old_path, "project.json")?;
        ensure!(
            actual == expected,
            "Project changed before local operation preparation"
        );
        ensure!(
            directory_identity::read(&old_path)? == local_identity,
            "Project directory changed before local operation preparation"
        );
        let mut operation = Operation {
            id: String::new(),
            version: 1,
            nonce: crate::drive_http::random_id()?,
            kind,
            root_identity,
            local_root,
            local_identity,
            old_path,
            destination: destination.into(),
            local_document: expected.into(),
            binding,
        };
        let bytes = serde_json::to_vec(&operation)?;
        operation.id = crate::project_store::fingerprint(&bytes);
        // Admission is held before the body becomes discoverable. A recovery
        // reader must never mistake a still-starting operation for an abandoned one.
        let lease = self.lease(&operation.id)?;
        self.immutable(&format!("{}.json", operation.id), &bytes)?;
        Ok(Prepared {
            operation,
            store: self.clone(),
            _lease: lease,
        })
    }
    /// Reacquire an abandoned operation before inspecting or restoring its local
    /// filesystem outcome. The caller still decides recovery versus commit.
    pub fn resume(&self, id: &str) -> Result<Prepared> {
        ensure!(valid_id(id), "Invalid local operation identity");
        let lease = self.lease(id)?;
        let bytes = bounded(&self.path().join(format!("{id}.json")))?;
        ensure!(
            crate::project_store::fingerprint(&bytes) == id,
            "Local operation body changed"
        );
        let mut operation: Operation = serde_json::from_slice(&bytes)?;
        ensure!(
            operation.version == 1,
            "Unsupported local operation version"
        );
        operation.id = id.into();
        Ok(Prepared {
            operation,
            store: self.clone(),
            _lease: lease,
        })
    }
    /// Read before the roster and compare again before generic orphan cleanup.
    /// Prepared records, including abandoned leases, never authorize cloud writes.
    pub fn snapshot(&self, root: &Path) -> Result<Guard> {
        let root = root.canonicalize()?;
        let root_identity = directory_identity::read(&root)?;
        let ledger = sync_dirty::Store::new(self.config.clone()).snapshot()?;
        let path = self.path();
        let mut entries = vec![];
        // Only pending references need membership tracking; retained completed
        // history must not impose a lifetime quota on future reconciliation.
        let mut missing_ids = ledger.retire_ops.keys().cloned().collect::<BTreeSet<_>>();
        if path.exists() {
            private_directory(&path)?;
            for member in fs::read_dir(&path)? {
                let member = member?;
                let name = member.file_name().to_string_lossy().into_owned();
                let meta = fs::symlink_metadata(member.path())?;
                ensure!(
                    meta.is_file() && !meta.file_type().is_symlink(),
                    "Unsafe local operation member"
                );
                let Some(id) = name.strip_suffix(".json") else {
                    continue;
                };
                ensure!(valid_id(id), "Unknown local operation record");
                let bytes = bounded(&member.path())?;
                ensure!(
                    crate::project_store::fingerprint(&bytes) == id,
                    "Local operation body changed"
                );
                let mut op: Operation = serde_json::from_slice(&bytes)?;
                op.id = id.into();
                ensure!(op.version == 1, "Unsupported local operation version");
                missing_ids.remove(id);
                if op.local_root != root {
                    continue;
                }
                ensure!(
                    op.root_identity == root_identity,
                    "Local operation belongs to a replaced library root"
                );
                let marker = |suffix: &str| -> Result<Option<u64>> {
                    let p = path.join(format!("{id}.{suffix}"));
                    if !p.exists() {
                        return Ok(None);
                    };
                    let value: serde_json::Value = serde_json::from_slice(&bounded(&p)?)?;
                    ensure!(value["id"] == id, "Local operation marker changed");
                    Ok(Some(
                        value["sequence"]
                            .as_u64()
                            .context("Invalid local operation marker")?,
                    ))
                };
                let done = marker("done")?;
                let aborted = marker("aborted")?;
                ensure!(
                    done.is_none_or(|seq| seq > 0) && aborted.is_none_or(|seq| seq == 0),
                    "Invalid local operation terminal marker"
                );
                ensure!(
                    done.is_none() || aborted.is_none(),
                    "Contradictory local operation markers"
                );
                let committed = ledger.retire_ops.get(id).copied();
                ensure!(
                    aborted.is_none() || committed.is_none(),
                    "Aborted operation has committed authority"
                );
                let state = if let Some(seq) = done {
                    ensure!(
                        committed.is_none_or(|v| v == seq),
                        "Local operation acknowledgement differs"
                    );
                    State::Done(seq)
                } else if aborted.is_some() {
                    State::Aborted
                } else if let Some(seq) = committed {
                    State::Committed(seq)
                } else {
                    State::Prepared
                };
                let active = match self.lease(id) {
                    Ok(lease) => {
                        drop(lease);
                        false
                    }
                    Err(e)
                        if e.downcast_ref::<std::io::Error>()
                            .is_some_and(|e| e.kind() == std::io::ErrorKind::WouldBlock) =>
                    {
                        true
                    }
                    Err(e) => return Err(e),
                };
                entries.push(Entry {
                    operation: op,
                    state,
                    active,
                });
            }
        }
        ensure!(
            missing_ids.is_empty(),
            "Committed local operation body is missing"
        );
        // read_dir order is unspecified; preserve a stable reconciliation epoch
        // without buffering the filesystem listing or truncating its authority.
        entries.sort_by(|a, b| a.operation.id.cmp(&b.operation.id));
        let states = entries
            .iter()
            .map(|entry| {
                (
                    &entry.operation.id,
                    format!("{:?}", entry.state),
                    entry.active,
                )
            })
            .collect::<Vec<_>>();
        let epoch = crate::project_store::fingerprint(&serde_json::to_vec(&(
            &root,
            &root_identity,
            states,
        ))?);
        Ok(Guard {
            root,
            root_identity,
            entries,
            epoch,
        })
    }
    pub fn assert_unchanged(&self, guard: &Guard) -> Result<()> {
        ensure!(
            self.snapshot(&guard.root)?.epoch == guard.epoch,
            "Local operations changed during Drive reconciliation"
        );
        Ok(())
    }
    /// Recover only abandoned local operations, before the caller scans its
    /// library roster. No operation/root lease survives this local-only method.
    /// `restore_exclusive` must refuse every existing destination, including an
    /// empty directory, using the platform's native no-replace move.
    pub fn recover_prepared(
        &self,
        root: &Path,
        ledger: &sync_dirty::Store,
        restore_exclusive: impl Fn(&Path, &Path) -> Result<()>,
    ) -> Result<RecoveryReport> {
        let initial = self.snapshot(root)?;
        let mut report = RecoveryReport::default();
        let pending = initial
            .entries
            .iter()
            .filter(|entry| entry.state == State::Prepared)
            .collect::<Vec<_>>();
        if pending.is_empty() {
            return Ok(report);
        }
        if pending.iter().all(|entry| entry.active) {
            report.busy = pending
                .iter()
                .map(|entry| entry.operation.id.clone())
                .collect();
            return Ok(report);
        }
        // Share the namespace exclusion used by native Delete/Import/storage
        // operations. Recovery must not restore into a root being reorganized.
        // This lease is local-only and is dropped before returning to HTTP work.
        let _namespace = match crate::project_delete::lease(
            &initial.root.join(".singz-native-import.lock"),
            "The library is changing during local operation recovery",
        ) {
            Ok(lease) => lease,
            Err(error) if busy(&error) => {
                report.busy = pending
                    .iter()
                    .map(|entry| entry.operation.id.clone())
                    .collect();
                return Ok(report);
            }
            Err(error) => return Err(error),
        };
        // Namespace/operation owners can finish between discovery and admission.
        let guard = self.snapshot(root)?;
        for entry in guard
            .entries
            .into_iter()
            .filter(|entry| entry.state == State::Prepared)
        {
            let id = entry.operation.id;
            if entry.active {
                report.busy.push(id);
                continue;
            }
            ensure!(
                self.config.canonicalize()? == ledger.directory().canonicalize()?,
                "Local operation ledger belongs to another profile"
            );
            let prepared = match self.resume(&id) {
                Ok(prepared) => prepared,
                Err(error) if busy(&error) => {
                    report.busy.push(id);
                    continue;
                }
                Err(error) => return Err(error),
            };
            // A competing owner may have completed its ledger publication while
            // we were waiting for the operation lease. Its commit is final.
            if ledger.snapshot()?.retire_ops.contains_key(&id) {
                report.resolved.push(id);
                continue;
            }
            if self.path().join(format!("{id}.aborted")).exists()
                || self.path().join(format!("{id}.done")).exists()
            {
                // Validate the newly observed marker instead of acting on the
                // preceding snapshot's now-obsolete Prepared state.
                self.snapshot(root)?;
                report.resolved.push(id);
                continue;
            }
            match prepared.recover_local(ledger, &restore_exclusive) {
                Ok(warning) => {
                    report.resolved.push(id);
                    if let Some(warning) = warning {
                        report.warnings.push(warning);
                    }
                }
                Err(error) if is_commit_unknown(&error) => return Err(error),
                Err(error) if busy(&error) => report.busy.push(id),
                Err(error) => {
                    report.warnings.push(format!(
                        "Local operation {id} remains unresolved: {error:#}"
                    ));
                    report.blocked.push(id);
                }
            }
        }
        Ok(report)
    }
    /// Call only after exact remote retirement and catalog commit are verified.
    /// The done marker precedes removing the ledger reference for crash recovery.
    pub fn complete(&self, id: &str, sequence: u64) -> Result<bool> {
        ensure!(
            valid_id(id) && sequence > 0,
            "Invalid completed local operation"
        );
        let bytes = bounded(&self.path().join(format!("{id}.json")))?;
        ensure!(
            crate::project_store::fingerprint(&bytes) == id,
            "Completed operation body changed"
        );
        let ledger = sync_dirty::Store::new(self.config.clone()).snapshot()?;
        let done = serde_json::to_vec(&serde_json::json!({"id":id,"sequence":sequence}))?;
        if ledger.retire_ops.get(id) != Some(&sequence) {
            ensure!(
                !ledger.retire_ops.contains_key(id)
                    && bounded(&self.path().join(format!("{id}.done")))? == done,
                "Local operation receipt sequence changed"
            );
            return Ok(false);
        }
        self.immutable(&format!("{id}.done"), &done)?;
        sync_dirty::Store::new(self.config.clone()).acknowledge_operation(id, sequence)
    }
}
fn busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|error| error.kind() == std::io::ErrorKind::WouldBlock)
    })
}
fn project_lease(path: &Path) -> Result<crate::file_lease::Lease> {
    let lock = path.join(".singz-native-write.lock");
    if lock.exists() {
        let meta = fs::symlink_metadata(&lock)?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Unsafe recovery project lease"
        );
    }
    crate::project_publish::lock(path)
}
impl Prepared {
    fn recover_local(
        &self,
        ledger: &sync_dirty::Store,
        restore_exclusive: &impl Fn(&Path, &Path) -> Result<()>,
    ) -> Result<Option<String>> {
        let operation = &self.operation;
        operation.root_identity.require_persistent()?;
        operation.local_identity.require_persistent()?;
        ensure!(
            directory_identity::read(&operation.local_root)? == operation.root_identity,
            "Recovery library identity changed"
        );
        let old = identity_if_present(&operation.old_path)?;
        let destination = identity_if_present(&operation.destination)?;
        let at_old = old.as_ref() == Some(&operation.local_identity);
        let at_destination = destination.as_ref() == Some(&operation.local_identity);
        ensure!(
            !(at_old && at_destination),
            "Project identity is visible at both operation paths"
        );
        if at_old {
            let _project = project_lease(&operation.old_path)?;
            crate::project_publish::recover_locked(&operation.old_path)?;
            ensure!(
                directory_identity::read(&operation.old_path)? == operation.local_identity,
                "Restored project changed during recovery"
            );
            ensure!(
                directory_identity::read(&operation.local_root)? == operation.root_identity,
                "Recovery library identity changed"
            );
            sync(&operation.local_root)?;
            self.abort()?;
            return Ok(None);
        }
        ensure!(
            at_destination,
            "Neither operation path contains the confirmed project; preserved for recovery"
        );
        if operation.kind == Kind::Delete {
            ensure!(
                old.is_none(),
                "Delete rollback destination is occupied; hidden project preserved"
            );
        }
        let _project = project_lease(&operation.destination)?;
        crate::project_publish::recover_locked(&operation.destination)?;
        self.moved()?;
        match operation.kind {
            Kind::Rename => {
                let title = operation
                    .destination
                    .file_name()
                    .and_then(|name| name.to_str())
                    .context("Invalid recovered Rename title")?;
                let (mut raw, fingerprint) =
                    crate::project_store::read(&operation.destination, "project.json")?;
                let mut warnings = vec![];
                if raw["name"].as_str() != Some(title) {
                    if fingerprint == operation.local_document {
                        raw.as_object_mut()
                            .context("Invalid recovered project document")?
                            .insert("name".into(), serde_json::json!(title));
                        crate::project_store::commit_locked(
                            &operation.destination,
                            "project.json",
                            &fingerprint,
                            &raw,
                        )?;
                    } else {
                        warnings.push(crate::i18n::t("library.recovery.renamedFolderWarning"));
                    }
                }
                // Also confirms a prior attempt whose metadata replacement was
                // visible before a directory-flush failure or process exit.
                sync(&operation.destination)?;
                sync(&operation.local_root)?;
                let committed = self.commit(ledger)?;
                if let Some(warning) = committed.warning {
                    warnings.push(warning);
                }
                Ok((!warnings.is_empty()).then(|| warnings.join("\n")))
            }
            Kind::Delete => {
                ensure!(
                    old.is_none(),
                    "Delete rollback destination is occupied; hidden project preserved"
                );
                // Recheck immediately before the no-replace callback. A racing
                // same-name creation must survive and must never be overwritten.
                ensure!(
                    identity_if_present(&operation.old_path)?.is_none(),
                    "Delete rollback destination appeared"
                );
                restore_exclusive(&operation.destination, &operation.old_path)?;
                ensure!(
                    directory_identity::read(&operation.old_path)? == operation.local_identity,
                    "Restored delete project identity changed"
                );
                ensure!(
                    identity_if_present(&operation.destination)?.as_ref()
                        != Some(&operation.local_identity),
                    "Delete recovery left duplicate project identity"
                );
                ensure!(
                    directory_identity::read(&operation.local_root)? == operation.root_identity,
                    "Recovery library identity changed"
                );
                sync(&operation.local_root)?;
                self.abort()?;
                Ok(None)
            }
        }
    }
    fn moved(&self) -> Result<()> {
        self.operation.root_identity.require_persistent()?;
        self.operation.local_identity.require_persistent()?;
        ensure!(
            directory_identity::read(&self.operation.local_root)? == self.operation.root_identity,
            "Library changed during local operation"
        );
        ensure!(
            identity_if_present(&self.operation.old_path)?.as_ref()
                != Some(&self.operation.local_identity),
            "Original project has not moved"
        );
        ensure!(
            directory_identity::read(&self.operation.destination)? == self.operation.local_identity,
            "Local operation destination changed"
        );
        Ok(())
    }
    pub fn commit(&self, ledger: &sync_dirty::Store) -> Result<Committed> {
        ensure!(
            self.store.config.canonicalize()? == ledger.directory().canonicalize()?,
            "Local operation ledger belongs to another profile"
        );
        let dirs = match self.operation.kind {
            Kind::Delete => vec![self.operation.old_path.clone()],
            Kind::Rename => vec![
                self.operation.old_path.clone(),
                self.operation.destination.clone(),
            ],
        };
        self.commit_using(
            || ledger.commit_operation(&dirs, &self.operation.id, "committed local operation"),
            || ledger.snapshot(),
        )
    }
    fn commit_using(
        &self,
        publish: impl FnOnce() -> Result<u64>,
        observe: impl FnOnce() -> Result<sync_dirty::Snapshot>,
    ) -> Result<Committed> {
        self.moved()?;
        match publish() {
            Ok(sequence)=>Ok(Committed{operation:self.operation.clone(),sequence,warning:None}),
            Err(publication_error) if sync_dirty::is_publication_not_attempted(&publication_error)=>Err(publication_error),
            Err(publication_error)=>match observe() {
                Ok(snapshot)=>if let Some(sequence)=snapshot.retire_ops.get(&self.operation.id) {
                    Ok(Committed {operation:self.operation.clone(),sequence:*sequence,
                        warning:Some(format!("Local operation was accepted, but ledger durability could not be confirmed: {publication_error:#}"))})
                } else if sync_dirty::is_publication_uncertain(&publication_error) {
                    Err(anyhow::Error::new(CommitOutcomeUnknown{operation_id:self.operation.id.clone()})
                        .context(format!("Published operation reference is not presently observable: {publication_error:#}")))
                } else {Err(publication_error)},
                Err(readback_error)=>Err(anyhow::Error::new(CommitOutcomeUnknown{operation_id:self.operation.id.clone()})
                    .context(format!("Could not resolve local operation publication ({publication_error:#}): {readback_error:#}"))),
            }
        }
    }
    /// Abort only after the exact original directory is restored or never moved.
    pub fn abort(&self) -> Result<()> {
        ensure!(
            directory_identity::read(&self.operation.old_path)? == self.operation.local_identity,
            "Cannot abort a moved local operation"
        );
        ensure!(
            !sync_dirty::Store::new(self.store.config.clone())
                .snapshot()?
                .retire_ops
                .contains_key(&self.operation.id),
            "Cannot abort committed local operation"
        );
        self.store.immutable(
            &format!("{}.aborted", self.operation.id),
            &serde_json::to_vec(&serde_json::json!({"id":self.operation.id,"sequence":0}))?,
        )
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        config: PathBuf,
        store: Store,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "singz-local-op-{}",
                crate::drive_http::random_id().unwrap()
            ));
            let root = base.join("library");
            let config = base.join("config");
            fs::create_dir_all(root.join("A")).unwrap();
            fs::write(
                root.join("A/project.json"),
                br#"{"name":"A","settings":{}}"#,
            )
            .unwrap();
            let root = root.canonicalize().unwrap();
            Self {
                base,
                root,
                store: Store::new(config.clone()),
                config,
            }
        }
        fn prepare(&self, kind: Kind, next: &str) -> Prepared {
            let old = self.root.join("A");
            let hash = crate::project_store::read(&old, "project.json").unwrap().1;
            self.store
                .prepare(
                    kind,
                    &self.root,
                    &old,
                    &self.root.join(next),
                    &hash,
                    Some("account-root-binding".into()),
                )
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn restore(from: &Path, to: &Path) -> Result<()> {
        crate::project_delete::exclusive_move(from, to)?;
        Ok(())
    }
    #[test]
    fn completed_history_beyond_the_old_lifetime_limit_keeps_pending_authority_visible() {
        const HISTORY: usize = 5500; // 16,500 normal retained files exceeded the old 16,384-member cap.
        let f = Fixture::new();
        let prepared = f.prepare(Kind::Rename, "B");
        let template = prepared.operation.clone();
        let id = template.id.clone();
        let history_path = f.store.path();
        // Synthetic durable-format history avoids thousands of unnecessary
        // fsyncs. Production publication and per-record validation are unchanged.
        for i in 0..HISTORY {
            let mut operation = template.clone();
            operation.nonce = format!("completed-history-{i}");
            let body = serde_json::to_vec(&operation).unwrap();
            let history_id = crate::project_store::fingerprint(&body);
            fs::write(history_path.join(format!("{history_id}.json")), body).unwrap();
            fs::write(
                history_path.join(format!("{history_id}.done")),
                serde_json::to_vec(&serde_json::json!({"id":history_id,"sequence":i+1})).unwrap(),
            )
            .unwrap();
            fs::write(history_path.join(format!("{history_id}.lock")), b"").unwrap();
        }
        fs::write(f.config.join("sync.json"),serde_json::to_vec(&serde_json::json!({"version":1,"gdriveDirty":{"seq":HISTORY,"dirs":{},"allSeq":0}})).unwrap()).unwrap();
        fs::rename(
            &prepared.operation.old_path,
            &prepared.operation.destination,
        )
        .unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let committed = prepared.commit(&ledger).unwrap();
        drop(prepared);
        let snapshot = f.store.snapshot(&f.root).unwrap();
        assert_eq!(snapshot.entries.len(), HISTORY + 1);
        assert_eq!(
            snapshot
                .entries
                .iter()
                .filter(|entry| matches!(entry.state, State::Done(_)))
                .count(),
            HISTORY
        );
        assert_eq!(
            snapshot
                .entries
                .iter()
                .find(|entry| entry.operation.id == id)
                .unwrap()
                .state,
            State::Committed(committed.sequence)
        );
        f.store.assert_unchanged(&snapshot).unwrap();
        // Completion of the actual pending operation is still possible after
        // retained history crosses the former quota; nothing is silently omitted.
        assert!(f.store.complete(&id, committed.sequence).unwrap());
        let complete = f.store.snapshot(&f.root).unwrap();
        assert_eq!(complete.entries.len(), HISTORY + 1);
        assert!(
            complete
                .entries
                .iter()
                .all(|entry| matches!(entry.state, State::Done(_)))
        );
        assert!(!ledger.snapshot().unwrap().retire_ops.contains_key(&id));
    }
    #[test]
    fn root_namespace_lease_defers_recovery_without_mutating_then_permits_restore() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-root-busy");
        let id = p.operation.id.clone();
        let bytes = fs::read(p.operation.old_path.join("project.json")).unwrap();
        let hidden = p.operation.destination.clone();
        fs::rename(&p.operation.old_path, &hidden).unwrap();
        drop(p);
        let root_lease = crate::project_delete::lease(
            &f.root.join(".singz-native-import.lock"),
            "test namespace owner",
        )
        .unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.busy, vec![id.clone()]);
        assert!(report.resolved.is_empty() && report.blocked.is_empty());
        assert_eq!(fs::read(hidden.join("project.json")).unwrap(), bytes);
        assert!(!f.root.join("A").exists());
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Prepared
        );
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
        drop(root_lease);
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.resolved, vec![id]);
        assert!(report.busy.is_empty());
        assert!(!hidden.exists());
        assert_eq!(fs::read(f.root.join("A/project.json")).unwrap(), bytes);
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Aborted
        );
    }
    #[test]
    fn recovery_without_preparations_does_not_create_a_root_namespace_file() {
        let f = Fixture::new();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert!(report.resolved.is_empty() && report.busy.is_empty() && report.blocked.is_empty());
        assert!(!f.root.join(".singz-native-import.lock").exists());
    }
    #[test]
    fn restart_recovers_moved_rename_and_repairs_only_the_unchanged_title() {
        let f = Fixture::new();
        fs::write(
            f.root.join("A/project.json"),
            br#"{"name":"A","foreign":{"keep":123},"settings":{}}"#,
        )
        .unwrap();
        let p = f.prepare(Kind::Rename, "B");
        let id = p.operation.id.clone();
        let identity = p.operation.local_identity.clone();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        drop(p);
        let store = Store::new(f.config.clone());
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.resolved, vec![id.clone()]);
        assert!(report.blocked.is_empty() && report.busy.is_empty() && report.warnings.is_empty());
        assert!(!f.root.join("A").exists());
        assert_eq!(
            directory_identity::read(&f.root.join("B")).unwrap(),
            identity
        );
        let (raw, _) = crate::project_store::read(&f.root.join("B"), "project.json").unwrap();
        assert_eq!(raw["name"], "B");
        assert_eq!(raw["foreign"]["keep"], 123);
        assert!(ledger.snapshot().unwrap().retire_ops.contains_key(&id));
        assert!(
            store
                .recover_prepared(&f.root, &ledger, restore)
                .unwrap()
                .resolved
                .is_empty()
        );
    }
    #[test]
    fn rename_recovery_retains_newer_saved_bytes_and_reports_the_actual_path() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Rename, "B");
        let id = p.operation.id.clone();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        let newer =
            br#"{"name":"Newer title","foreign":{"laterSave":true},"settings":{"tempo":1.25}}"#;
        fs::write(p.operation.destination.join("project.json"), newer).unwrap();
        drop(p);
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.resolved, vec![id.clone()]);
        assert_eq!(report.warnings.len(), 1);
        assert_eq!(fs::read(f.root.join("B/project.json")).unwrap(), newer);
        assert!(!f.root.join("A").exists());
        assert!(ledger.snapshot().unwrap().retire_ops.contains_key(&id));
    }
    #[test]
    fn restart_restores_an_uncommitted_hidden_delete_without_granting_retirement() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-restart");
        let id = p.operation.id.clone();
        let before = fs::read(p.operation.old_path.join("project.json")).unwrap();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        drop(p);
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = Store::new(f.config.clone())
            .recover_prepared(&f.root, &ledger, restore)
            .unwrap();
        assert_eq!(report.resolved, vec![id]);
        assert!(report.blocked.is_empty() && report.busy.is_empty());
        assert_eq!(fs::read(f.root.join("A/project.json")).unwrap(), before);
        assert!(!f.root.join(".singz-native-delete-restart").exists());
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Aborted
        );
    }
    #[test]
    fn hidden_delete_collision_preserves_both_generations_and_stays_unresolved() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-collision");
        let id = p.operation.id.clone();
        let hidden = p.operation.destination.clone();
        let before = fs::read(p.operation.old_path.join("project.json")).unwrap();
        fs::rename(&p.operation.old_path, &hidden).unwrap();
        fs::create_dir(&p.operation.old_path).unwrap();
        let newer = br#"{"name":"A","foreign":"separate replacement"}"#;
        fs::write(p.operation.old_path.join("project.json"), newer).unwrap();
        drop(p);
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.blocked, vec![id]);
        assert!(report.resolved.is_empty());
        assert_eq!(fs::read(hidden.join("project.json")).unwrap(), before);
        assert_eq!(fs::read(f.root.join("A/project.json")).unwrap(), newer);
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Prepared
        );
    }
    #[test]
    fn live_preparation_is_not_recovered_and_a_committed_delete_is_never_restored() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-live");
        let id = p.operation.id.clone();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert_eq!(report.busy, vec![id.clone()]);
        assert!(report.resolved.is_empty());
        p.commit(&ledger).unwrap();
        drop(p);
        let report = f.store.recover_prepared(&f.root, &ledger, restore).unwrap();
        assert!(report.resolved.is_empty() && report.blocked.is_empty() && report.busy.is_empty());
        assert!(!f.root.join("A").exists());
        assert!(
            f.root
                .join(".singz-native-delete-live/project.json")
                .is_file()
        );
        assert!(ledger.snapshot().unwrap().retire_ops.contains_key(&id));
    }
    #[test]
    fn malformed_prior_ledger_is_proven_prepublication_failure_and_allows_verified_rollback() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-bad-ledger");
        let bytes = fs::read(p.operation.old_path.join("project.json")).unwrap();
        let malformed = b"invalid ledger before the operation";
        fs::write(f.config.join("sync.json"), malformed).unwrap();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let error = p.commit(&ledger).unwrap_err();
        assert!(sync_dirty::is_publication_not_attempted(&error));
        assert!(!is_commit_unknown(&error));
        assert_eq!(fs::read(f.config.join("sync.json")).unwrap(), malformed);
        restore(&p.operation.destination, &p.operation.old_path).unwrap();
        assert_eq!(
            fs::read(p.operation.old_path.join("project.json")).unwrap(),
            bytes
        );
        assert!(!p.operation.destination.exists());
        // The malformed baseline is preserved for explicit repair. It is never
        // silently treated as a clean ledger merely to finish abort bookkeeping.
        assert!(p.abort().is_err());
        fs::write(f.config.join("sync.json"), br#"{"version":1}"#).unwrap();
        p.abort().unwrap();
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
    }
    #[test]
    fn visible_operation_after_flush_failure_is_accepted_and_never_rolled_back() {
        let f = Fixture::new();
        let prepared = f.prepare(Kind::Delete, ".singz-native-delete-flush");
        fs::rename(
            &prepared.operation.old_path,
            &prepared.operation.destination,
        )
        .unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let committed = prepared
            .commit(&ledger.with_failed_publication_flush())
            .unwrap();
        assert!(committed.warning.as_deref().unwrap().contains("durability"));
        assert_eq!(
            ledger.snapshot().unwrap().retire_ops[&prepared.operation.id],
            committed.sequence
        );
        assert!(
            prepared
                .operation
                .destination
                .join("project.json")
                .is_file()
        );
        assert!(!prepared.operation.old_path.exists());
        assert!(prepared.abort().is_err());
    }
    #[test]
    fn unreadable_commit_outcome_explicitly_requires_retaining_moved_directory() {
        let f = Fixture::new();
        let prepared = f.prepare(Kind::Delete, ".singz-native-delete-unknown");
        fs::rename(
            &prepared.operation.old_path,
            &prepared.operation.destination,
        )
        .unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let error = prepared
            .commit_using(
                || {
                    ledger.with_failed_publication_flush().commit_operation(
                        &[prepared.operation.old_path.clone()],
                        &prepared.operation.id,
                        "delete",
                    )
                },
                || anyhow::bail!("Injected unreadable receipt observation"),
            )
            .unwrap_err();
        assert!(is_commit_unknown(&error));
        assert!(
            prepared
                .operation
                .destination
                .join("project.json")
                .is_file()
        );
        assert_eq!(ledger.snapshot().unwrap().retire_ops.len(), 1);
        assert!(prepared.abort().is_err());
    }
    #[test]
    fn unsupported_persistent_witness_cannot_commit_operation_authority() {
        let f = Fixture::new();
        let mut prepared = f.prepare(Kind::Delete, ".singz-native-delete-ineligible");
        fs::rename(
            &prepared.operation.old_path,
            &prepared.operation.destination,
        )
        .unwrap();
        let mut identity = serde_json::to_value(&prepared.operation.local_identity).unwrap();
        identity["created"] = serde_json::Value::Null;
        prepared.operation.local_identity = serde_json::from_value(identity).unwrap();
        let ledger = sync_dirty::Store::new(f.config.clone());
        let error = prepared.commit(&ledger).unwrap_err();
        assert!(directory_identity::is_persistent_unavailable(&error));
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
        assert!(
            prepared
                .operation
                .destination
                .join("project.json")
                .is_file()
        );
    }
    #[test]
    fn empty_operation_guard_still_detects_a_replaced_library_root() {
        let f = Fixture::new();
        let guard = f.store.snapshot(&f.root).unwrap();
        fs::rename(&f.root, f.base.join("previous-library")).unwrap();
        fs::create_dir(&f.root).unwrap();
        assert!(f.store.assert_unchanged(&guard).is_err());
        assert!(f.base.join("previous-library/A/project.json").is_file());
    }
    #[test]
    fn preparation_is_visible_but_only_atomic_commit_grants_retirement_authority() {
        let f = Fixture::new();
        let guard = f.store.snapshot(&f.root).unwrap();
        let prepared = f.prepare(Kind::Delete, ".singz-native-delete-test");
        assert!(f.store.assert_unchanged(&guard).is_err());
        let snapshot = f.store.snapshot(&f.root).unwrap();
        assert_eq!(snapshot.entries.len(), 1);
        assert_eq!(snapshot.entries[0].state, State::Prepared);
        assert!(snapshot.entries[0].active);
        let ledger = sync_dirty::Store::new(f.config.clone());
        assert!(prepared.commit(&ledger).is_err());
        assert!(ledger.snapshot().unwrap().retire_ops.is_empty());
        fs::rename(
            &prepared.operation.old_path,
            &prepared.operation.destination,
        )
        .unwrap();
        let committed = prepared.commit(&ledger).unwrap();
        fs::remove_dir_all(&prepared.operation.destination).unwrap();
        drop(prepared);
        let snapshot = f.store.snapshot(&f.root).unwrap();
        assert_eq!(
            snapshot.entries[0].state,
            State::Committed(committed.sequence)
        );
        assert!(!snapshot.entries[0].active);
        ledger.clear(committed.sequence).unwrap();
        assert!(ledger.snapshot().unwrap().is_dirty());
        assert!(
            f.store
                .complete(&committed.operation.id, committed.sequence + 1)
                .is_err()
        );
        assert!(
            f.store
                .complete(&committed.operation.id, committed.sequence)
                .unwrap()
        );
        assert!(
            !f.store
                .complete(&committed.operation.id, committed.sequence)
                .unwrap()
        );
        assert!(!ledger.snapshot().unwrap().is_dirty());
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Done(committed.sequence)
        );
    }
    #[test]
    fn failed_rename_can_abort_only_after_original_identity_is_restored() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Rename, "B");
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        assert!(p.abort().is_err());
        fs::rename(&p.operation.destination, &p.operation.old_path).unwrap();
        p.abort().unwrap();
        drop(p);
        assert_eq!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Aborted
        );
        assert!(
            sync_dirty::Store::new(f.config.clone())
                .snapshot()
                .unwrap()
                .retire_ops
                .is_empty()
        );
    }
    #[test]
    fn reused_name_is_not_the_directory_that_the_accepted_delete_authorized() {
        let f = Fixture::new();
        let p = f.prepare(Kind::Delete, ".singz-native-delete-test");
        let old = p.operation.local_identity.clone();
        fs::rename(&p.operation.old_path, &p.operation.destination).unwrap();
        fs::create_dir(&p.operation.old_path).unwrap();
        fs::write(
            p.operation.old_path.join("project.json"),
            br#"{"name":"A","foreign":"new generation"}"#,
        )
        .unwrap();
        let accepted = p.commit(&sync_dirty::Store::new(f.config.clone())).unwrap();
        assert_eq!(accepted.operation.local_identity, old);
        assert_ne!(
            directory_identity::read(&p.operation.old_path).unwrap(),
            old
        );
        drop(p);
        assert!(matches!(
            f.store.snapshot(&f.root).unwrap().entries[0].state,
            State::Committed(_)
        ));
    }
}

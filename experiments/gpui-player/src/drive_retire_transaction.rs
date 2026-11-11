//! Bounded retirement of a positively published generation. A committed local
//! operation authorizes only its captured directory, never a name-based sweep.
use crate::{
    directory_identity,
    drive_local_ops::{self, Kind, Operation, State},
    drive_plan::{self, RemoteEntry},
    drive_remote::{FOLDER, Metadata, Remote},
    drive_retirement::{self, Binding, ExpectedPublication, LocalCapture, PublicationLineage},
};
use anyhow::{Context, Result, bail, ensure};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
};
const LIMIT: u64 = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct RetiredLineage {
    pub operation_id: String,
    pub sequence: u64,
    pub source: PublicationLineage,
}
#[derive(Default, Debug)]
pub struct Report {
    pub made_request: bool,
    pub changed: bool,
    pub follow_up: bool,
    pub retired: Vec<RetiredLineage>,
    pub protected_names: BTreeSet<String>,
    pub protected_rows: Vec<Value>,
    pub blocked: Vec<String>,
    pub waiting_for: BTreeSet<String>,
    pub local_superseded: Vec<String>,
}
#[derive(Clone, Debug, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
enum Phase {
    Prepared,
    FolderRetired,
    Retired,
    LocalSuperseded,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Witness {
    operation_id: String,
    sequence: u64,
    operation: Operation,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Attempt {
    before: Metadata,
    after_md5: String,
    after_size: u64,
    payload: String,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct TerminalProof {
    folder: Metadata,
    members: Vec<Metadata>,
    catalog: Metadata,
    catalog_document: Value,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Journal {
    version: u32,
    binding: Binding,
    operation: String,
    sequence: u64,
    witnesses: Vec<Witness>,
    phase: Phase,
    source: Option<PublicationLineage>,
    /// Affirmatively observed obsolete members from our completed ordinary publications.
    #[serde(default)]
    pruned: Vec<Metadata>,
    successor: Option<PublicationLineage>,
    guarded_names: BTreeSet<String>,
    /// Every receipt available before retirement, including historical ones.
    /// A same-directory rename cycle must not mistake one for a NEW generation.
    known_publications: BTreeSet<String>,
    catalog_id: Option<String>,
    attempt: Option<Attempt>,
    terminal: Option<TerminalProof>,
}
struct Catalog {
    metadata: Metadata,
    document: Value,
}
fn md5(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}
fn digest<T: Serialize>(value: &T) -> Result<String> {
    Ok(crate::project_store::fingerprint(&serde_json::to_vec(
        value,
    )?))
}
fn safe_id(id: &str) -> bool {
    id.len() == 64
        && id
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn name(path: &Path) -> Result<String> {
    let value = path
        .file_name()
        .and_then(|s| s.to_str())
        .context("Operation has no project name")?;
    ensure!(
        drive_plan::plain_name(value),
        "Unsafe retirement project name"
    );
    Ok(value.into())
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent) = path.parent() {
            if !parent.exists() {
                private_dir(parent)?;
            }
        }
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
        "Unsafe retirement directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "Retirement directory must be private"
        );
    }
    Ok(())
}
fn bounded(path: &Path) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    ensure!(
        before.is_file() && !before.file_type().is_symlink() && before.len() <= LIMIT,
        "Unsafe retirement record"
    );
    let file = File::open(path)?;
    let opened = file.metadata()?;
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            before.dev() == opened.dev() && before.ino() == opened.ino(),
            "Retirement record replaced while opening"
        );
    }
    ensure!(before.len() == opened.len(), "Retirement record changed");
    let mut bytes = vec![];
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 == before.len() && bytes.len() as u64 <= LIMIT,
        "Retirement record changed while reading"
    );
    Ok(bytes)
}
fn write(path: &Path, bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Retirement record exceeds limit"
    );
    let parent = path.parent().context("Retirement record has no parent")?;
    private_dir(parent)?;
    if path.exists() {
        bounded(path)?;
    }
    let temp = parent.join(format!(".retire-{}.part", crate::drive_http::random_id()?));
    let result = (|| -> Result<()> {
        let mut f = crate::drive_http::private_file(&temp)?;
        f.write_all(bytes)?;
        f.sync_all()?;
        drop(f);
        crate::project_store::replace(&temp, path)?;
        #[cfg(not(windows))]
        File::open(parent)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
fn lock(storage: &Path) -> Result<crate::file_lease::Lease> {
    private_dir(storage)?;
    let path = storage.join(".transactions.lock");
    if path.exists() {
        bounded(&path)?;
    }
    let mut options = OpenOptions::new();
    options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    crate::file_lease::Lease::acquire(options.open(path)?)
        .context("Drive retirement is already running")
}
fn journal_dir(storage: &Path, id: &str) -> Result<PathBuf> {
    ensure!(safe_id(id), "Invalid retirement operation identity");
    Ok(storage.join("transactions").join(id))
}
fn save(storage: &Path, j: &Journal) -> Result<()> {
    write(
        &journal_dir(storage, &j.operation)?.join("journal.json"),
        &serde_json::to_vec(j)?,
    )
}
fn row<'a>(document: &'a Value, project: &str) -> Result<Option<&'a Value>> {
    ensure!(document["format"] == 2, "Unsupported retirement catalog");
    let mut seen = BTreeSet::new();
    let mut found = None;
    for item in document["projects"]
        .as_array()
        .context("Invalid retirement catalog")?
    {
        let dir = item["dir"]
            .as_str()
            .context("Missing catalog project name")?;
        ensure!(
            drive_plan::plain_name(dir) && seen.insert(dir),
            "Ambiguous retirement catalog"
        );
        if dir == project {
            found = Some(item);
        }
    }
    Ok(found)
}
fn facts(value: &Value) -> Result<BTreeMap<String, (String, String, u64)>> {
    let mut out = BTreeMap::new();
    for file in value["files"]
        .as_array()
        .context("Invalid catalog project files")?
    {
        let name = file["name"].as_str().context("Missing catalog file name")?;
        let id = file["id"]
            .as_str()
            .filter(|v| !v.is_empty())
            .context("Missing catalog file ID")?;
        let hash = file["md5Checksum"]
            .as_str()
            .filter(|s| crate::drive_snapshot::valid_md5(s))
            .context("Invalid catalog checksum")?;
        let size = file["size"]
            .as_u64()
            .or_else(|| file["size"].as_str().and_then(|s| s.parse().ok()))
            .context("Invalid catalog file size")?;
        ensure!(
            drive_plan::plain_name(name)
                && out
                    .insert(name.into(), (id.into(), hash.into(), size))
                    .is_none(),
            "Ambiguous catalog files"
        );
    }
    Ok(out)
}
fn same_row(a: &Value, b: &Value) -> Result<bool> {
    Ok(a["dir"] == b["dir"] && facts(a)? == facts(b)?)
}
fn catalog_optional(
    remote: &Remote,
    binding: &Binding,
    scratch: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<Option<Catalog>> {
    let matches = remote
        .children(&binding.singz_root, cancel)?
        .into_iter()
        .filter(|m| m.name == "catalog.json")
        .collect::<Vec<_>>();
    ensure!(matches.len() <= 1, "Ambiguous retirement catalog");
    if matches.is_empty() {
        return Ok(None);
    }
    let metadata = remote.metadata(&matches[0].id, cancel)?;
    ensure!(
        !metadata.trashed
            && metadata.entry.name == "catalog.json"
            && metadata.entry.parents == vec![binding.singz_root.clone()]
            && metadata.entry.mime_type.as_deref() != Some(FOLDER),
        "Retirement catalog moved"
    );
    let temp = scratch.join(format!(".catalog-{}.json", crate::drive_http::random_id()?));
    let read = (|| -> Result<Value> {
        remote.download(&metadata.entry.id, &temp, LIMIT, cancel)?;
        let bytes = bounded(&temp)?;
        ensure!(
            metadata.entry.md5_checksum.as_deref() == Some(md5(&bytes).as_str())
                && metadata
                    .entry
                    .size
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    == Some(bytes.len() as u64),
            "Catalog changed during retirement read"
        );
        ensure!(
            remote.metadata(&metadata.entry.id, cancel)? == metadata,
            "Catalog changed during retirement read"
        );
        Ok(serde_json::from_slice(&bytes)?)
    })();
    let _ = fs::remove_file(temp);
    let document = read?;
    row(&document, "")?;
    Ok(Some(Catalog { metadata, document }))
}
fn catalog(
    remote: &Remote,
    binding: &Binding,
    scratch: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<Catalog> {
    catalog_optional(remote, binding, scratch, cancel)?.context("Missing retirement catalog")
}
fn binding_current(remote: &Remote, binding: &Binding, cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(
        directory_identity::read(&binding.local_root)? == binding.root_identity,
        "Retirement library root replaced"
    );
    let key = digest(&(
        remote.account_key(cancel)?,
        &remote.auth.config.api_base,
        &remote.auth.config.client_id,
        &binding.singz_root,
        &binding.local_root,
    ))?;
    ensure!(
        key == binding.key && !cancel(),
        "Retirement account binding changed"
    );
    Ok(())
}
/// Ordinary sync needs a live identity, but no persistent retirement authority.
/// Once an operation or terminal history exists, weaker identity must never
/// authorize replay or name reuse across process lifetimes.
fn require_retirement_identity(
    binding: &Binding,
    journals: &[Journal],
    guard: &drive_local_ops::Guard,
) -> Result<()> {
    if !journals.is_empty() || guard.entries.iter().any(|e| e.state != State::Aborted) {
        binding.root_identity.require_persistent()?;
        for e in guard.entries.iter().filter(|e| e.state != State::Aborted) {
            e.operation.root_identity.require_persistent()?;
            e.operation.local_identity.require_persistent()?;
        }
        for j in journals {
            j.binding.root_identity.require_persistent()?;
            for w in &j.witnesses {
                w.operation.local_identity.require_persistent()?;
            }
        }
    }
    Ok(())
}
fn verify_live(
    remote: &Remote,
    storage: &Path,
    lineage: &PublicationLineage,
    cancel: &impl Fn() -> bool,
) -> Result<PublicationLineage> {
    let c = catalog(remote, &lineage.binding, storage, cancel)?;
    let expected = ExpectedPublication {
        folder: lineage.folder.entry.clone(),
        members: lineage.members.iter().map(|m| m.entry.clone()).collect(),
        catalog_row: lineage.catalog_row.clone(),
        catalog: c.metadata.entry,
    };
    let verified = drive_retirement::capture_verify_publication(
        remote,
        &lineage.binding,
        &lineage.capture,
        &expected,
        cancel,
    )?;
    let pruned = verified_pruned_members(remote, storage, &verified, cancel)?;
    strict_roster(remote, &verified, &pruned, cancel)?;
    Ok(verified)
}
fn load(storage: &Path, binding: &Binding) -> Result<Vec<Journal>> {
    let directory = storage.join("transactions");
    if !directory.exists() {
        return Ok(vec![]);
    }
    private_dir(&directory)?;
    let mut journals = vec![];
    // Inspect history one record at a time. Terminal proofs are permanent name
    // guards; a lifetime count cap must never disable a mature library or hide
    // an older proof. Each individual record remains bounded and validated.
    for item in fs::read_dir(directory)? {
        let item = item?;
        let id = item.file_name().to_string_lossy().into_owned();
        ensure!(safe_id(&id), "Unexpected retirement transaction directory");
        private_dir(&item.path())?;
        let path = item.path().join("journal.json");
        if !path.exists() {
            continue;
        }
        let mut j: Journal = serde_json::from_slice(&bounded(&path)?)?;
        ensure!(
            j.version == 1
                && j.operation == id
                && j.witnesses.len() > 0
                && j.witnesses.len() <= 4096,
            "Invalid retirement journal"
        );
        for w in &mut j.witnesses {
            ensure!(
                safe_id(&w.operation_id)
                    && digest(&w.operation)? == w.operation_id
                    && w.sequence > 0,
                "Retirement witness body changed"
            );
            w.operation.id = w.operation_id.clone();
            ensure!(
                w.operation.binding.as_deref() == Some(j.binding.key.as_str())
                    && w.operation.local_root == j.binding.local_root
                    && w.operation.root_identity == j.binding.root_identity,
                "Retirement witness binding changed"
            );
        }
        ensure!(
            j.witnesses[0].operation_id == j.operation && j.witnesses[0].sequence == j.sequence,
            "Retirement anchor changed"
        );
        if let Some(s) = &j.source {
            validate_pruned_shape(s, &j.pruned)?;
            ensure!(
                s.binding == j.binding
                    && s.capture.local_identity == j.witnesses[0].operation.local_identity
                    && s.project == name(&j.witnesses[0].operation.old_path)?,
                "Retirement source changed"
            );
        } else {
            ensure!(j.pruned.is_empty(), "Pruned evidence has no source lineage");
        }
        if j.phase == Phase::Retired {
            validate_terminal(&j)?;
        }
        if j.binding == *binding {
            journals.push(j);
        }
    }
    journals.sort_by_key(|j| j.sequence);
    Ok(journals)
}
fn validate_terminal(j: &Journal) -> Result<()> {
    let s = j
        .source
        .as_ref()
        .context("Retired transaction lacks source")?;
    let t = j
        .terminal
        .as_ref()
        .context("Retired transaction lacks positive terminal proof")?;
    ensure!(
        t.folder.trashed
            && t.folder.entry == s.folder.entry
            && t.members.len() == s.members.len() + j.pruned.len(),
        "Invalid positive retirement proof"
    );
    for m in s.members.iter().chain(&j.pruned) {
        ensure!(
            t.members.iter().any(|v| v.entry == m.entry
                && (!j.pruned.iter().any(|p| p.entry.id == m.entry.id) || v.trashed)),
            "Retirement member proof changed"
        );
    }
    ensure!(
        !t.catalog.trashed
            && Some(&t.catalog.entry.id) == j.catalog_id.as_ref()
            && row(&t.catalog_document, &s.project)?.is_none(),
        "Invalid catalog-last retirement proof"
    );
    let bytes = serde_json::to_vec(&t.catalog_document)?;
    // The document may have arrived in any JSON whitespace form; its checksum
    // is observed by catalog() before storage, rather than invented here.
    ensure!(!bytes.is_empty(), "Empty terminal catalog proof");
    Ok(())
}
fn terminal_ids(journals: &[Journal]) -> BTreeSet<String> {
    journals
        .iter()
        .filter(|j| j.phase == Phase::Retired)
        .filter_map(|j| j.source.as_ref().map(|s| s.folder.entry.id.clone()))
        .collect()
}
fn root_named(
    remote: &Remote,
    binding: &Binding,
    project: &str,
    cancel: &impl Fn() -> bool,
) -> Result<Option<RemoteEntry>> {
    let rows = remote
        .children(&binding.singz_root, cancel)?
        .into_iter()
        .filter(|m| m.name == project)
        .collect::<Vec<_>>();
    ensure!(rows.len() <= 1, "Ambiguous cloud project name {project}");
    if let Some(m) = rows.first() {
        ensure!(
            m.mime_type.as_deref() == Some(FOLDER),
            "Cloud project name is occupied by a file"
        );
    }
    Ok(rows.into_iter().next())
}
/// Returns only a current, fully proved generation. A stale receipt or a 404
/// cannot supply retirement authority; a positively retired historical ID may
/// be skipped, provided it has not been restored into the active namespace.
fn resolve(
    remote: &Remote,
    storage: &Path,
    binding: &Binding,
    project: &str,
    local: &directory_identity::DirectoryIdentity,
    retired: &BTreeSet<String>,
    cancel: &impl Fn() -> bool,
) -> Result<Option<PublicationLineage>> {
    let present = root_named(remote, binding, project, cancel)?;
    let candidates = drive_retirement::publication_candidates(
        storage,
        &binding.key,
        &binding.root_identity,
        project,
        local,
    )?;
    if let Some(folder) = present {
        let matching = candidates
            .into_iter()
            .filter(|(_, s)| s.folder.entry.id == folder.id)
            .collect::<Vec<_>>();
        ensure!(
            !retired.contains(&folder.id),
            "Previously retired folder was restored; refusing implicit adoption"
        );
        let mut errors = vec![];
        for (_, candidate) in matching {
            match verify_live(remote, storage, &candidate, cancel) {
                Ok(s) => return Ok(Some(s)),
                Err(e) => errors.push(e.to_string()),
            }
        }
        bail!(
            "No exact positive generation for {project}: {}",
            errors.join("; ")
        );
    }
    // A cached generation missing without a terminal proof is not 'never
    // published'. In particular a transient 404 cannot cancel an operation.
    ensure!(
        candidates
            .iter()
            .all(|(_, s)| retired.contains(&s.folder.entry.id)),
        "Known publication is absent without positive retirement proof"
    );
    if let Some(c) = catalog_optional(remote, binding, storage, cancel)? {
        ensure!(
            row(&c.document, project)?.is_none(),
            "Absent cloud project still has a catalog row"
        );
    }
    Ok(None)
}
fn known_receipts(storage: &Path, binding: &Binding) -> Result<BTreeSet<String>> {
    drive_retirement::publications(storage, binding)?
        .iter()
        .map(digest)
        .collect()
}
fn verified_pruned_members(
    remote: &Remote,
    storage: &Path,
    s: &PublicationLineage,
    cancel: &impl Fn() -> bool,
) -> Result<Vec<Metadata>> {
    let pruned = crate::drive_publication::owned_pruned_members(storage, s)?;
    validate_pruned_shape(s, &pruned)?;
    for expected in &pruned {
        ensure!(
            remote.metadata(&expected.entry.id, cancel)? == *expected,
            "Positively pruned member was restored, changed or moved"
        );
    }
    Ok(pruned)
}
fn validate_pruned_shape(s: &PublicationLineage, pruned: &[Metadata]) -> Result<()> {
    ensure!(pruned.len() <= 4096, "Too many positively pruned members");
    let parents = std::iter::once(s.folder.entry.id.clone())
        .chain(
            s.members
                .iter()
                .filter(|m| m.entry.mime_type.as_deref() == Some(FOLDER))
                .map(|m| m.entry.id.clone()),
        )
        .collect::<BTreeSet<_>>();
    let mut ids = s
        .members
        .iter()
        .map(|m| m.entry.id.clone())
        .chain(std::iter::once(s.folder.entry.id.clone()))
        .collect::<BTreeSet<_>>();
    for expected in pruned {
        ensure!(
            expected.trashed
                && expected.entry.mime_type.as_deref() != Some(FOLDER)
                && expected.entry.parents.len() == 1
                && parents.contains(&expected.entry.parents[0])
                && ids.insert(expected.entry.id.clone()),
            "Invalid positively pruned member evidence"
        );
    }
    Ok(())
}
fn strict_roster(
    remote: &Remote,
    s: &PublicationLineage,
    pruned: &[Metadata],
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    for parent in std::iter::once(s.folder.entry.id.as_str()).chain(
        s.members
            .iter()
            .filter(|m| m.entry.mime_type.as_deref() == Some(FOLDER))
            .map(|m| m.entry.id.as_str()),
    ) {
        // Omitting the trashed predicate is deliberate: inherited trash must
        // not make an extra member disappear from the ownership proof.
        let actual = remote
            .list(
                &format!("'{}' in parents", drive_plan::escape_query_string(parent)),
                cancel,
            )?
            .into_iter()
            .map(|m| m.id)
            .collect::<BTreeSet<_>>();
        let expected = s
            .members
            .iter()
            .chain(pruned)
            .filter(|m| m.entry.parents == vec![parent.to_owned()])
            .map(|m| m.entry.id.clone())
            .collect::<BTreeSet<_>>();
        ensure!(
            actual == expected,
            "Retirement folder contains missing or unmanaged member IDs"
        );
    }
    Ok(())
}
fn exact_members(
    remote: &Remote,
    s: &PublicationLineage,
    pruned: &[Metadata],
    cancel: &impl Fn() -> bool,
) -> Result<Vec<Metadata>> {
    strict_roster(remote, s, pruned, cancel)?;
    let mut result = vec![];
    for expected in s.members.iter().chain(pruned) {
        let m = remote.metadata(&expected.entry.id, cancel)?;
        ensure!(
            m.entry == expected.entry
                && (!pruned.iter().any(|p| p.entry.id == m.entry.id) || m.trashed),
            "Retirement member identity/content/parent changed"
        );
        result.push(m);
    }
    Ok(result)
}
fn finish(
    remote: &Remote,
    storage: &Path,
    j: &mut Journal,
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    let source = j.source.clone().context("Retirement lacks source")?;
    if j.phase == Phase::Retired || j.phase == Phase::LocalSuperseded {
        return Ok(());
    }
    binding_current(remote, &j.binding, cancel)?;
    let current = remote.metadata(&source.folder.entry.id, cancel)?;
    ensure!(
        current.entry == source.folder.entry,
        "Retirement folder identity/name/parent changed"
    );
    if j.phase == Phase::Prepared {
        if !current.trashed {
            // Reprove roster, hashes and own row immediately before mutation.
            verify_live(remote, storage, &source, cancel)?;
            if let Some(successor) = &j.successor {
                verify_live(remote, storage, successor, cancel)?;
            }
            // The durable transaction's recorded prune set, rather than a
            // newly discovered journal, must cover the exact pre-trash roster.
            exact_members(remote, &source, &j.pruned, cancel)?;
            // Journal was synced before even this first PATCH. A lost ACK is
            // resolved only by the affirmative exact-ID observation below.
            remote.trash(&source.folder.entry.id, cancel)?;
        }
        let observed = remote.metadata(&source.folder.entry.id, cancel)?;
        ensure!(
            observed.trashed && observed.entry == source.folder.entry,
            "Folder retirement was not positively observed"
        );
        exact_members(remote, &source, &j.pruned, cancel)?;
        j.phase = Phase::FolderRetired;
        save(storage, j)?;
    }
    let observed = remote.metadata(&source.folder.entry.id, cancel)?;
    ensure!(
        observed.trashed && observed.entry == source.folder.entry,
        "Retired folder was restored or replaced"
    );
    let members = exact_members(remote, &source, &j.pruned, cancel)?;
    let mut c = catalog(remote, &j.binding, storage, cancel)?;
    ensure!(
        Some(&c.metadata.entry.id) == j.catalog_id.as_ref(),
        "Catalog ID changed during retirement"
    );
    if let Some(old) = row(&c.document, &source.project)? {
        ensure!(
            same_row(old, &source.catalog_row)?,
            "Old catalog row changed during retirement"
        );
        let projects = c.document["projects"]
            .as_array_mut()
            .context("Invalid catalog projects")?;
        projects.retain(|r| r["dir"] != source.project);
        let bytes = serde_json::to_vec(&c.document)?;
        let payload = format!("catalog-{}.json", crate::drive_http::random_id()?);
        write(&journal_dir(storage, &j.operation)?.join(&payload), &bytes)?;
        j.attempt = Some(Attempt {
            before: c.metadata.clone(),
            after_md5: md5(&bytes),
            after_size: bytes.len() as u64,
            payload,
        });
        // Persist the exact request before HTTP. A retry always reads+merges
        // fresh unrelated rows, never replays stale full-catalog bytes.
        save(storage, j)?;
        ensure!(
            remote.metadata(&c.metadata.entry.id, cancel)? == c.metadata,
            "Catalog changed before retirement write"
        );
        remote.upload_bytes(
            &bytes,
            "catalog.json",
            &j.binding.singz_root,
            Some(&c.metadata.entry.id),
            "application/json",
            cancel,
        )?;
        c = catalog(remote, &j.binding, storage, cancel)?;
        ensure!(
            Some(&c.metadata.entry.id) == j.catalog_id.as_ref()
                && row(&c.document, &source.project)?.is_none(),
            "Catalog retirement was not observed"
        );
        let a = j.attempt.as_ref().unwrap();
        ensure!(
            c.metadata.entry.md5_checksum.as_deref() == Some(a.after_md5.as_str())
                && c.metadata
                    .entry
                    .size
                    .as_deref()
                    .and_then(|s| s.parse::<u64>().ok())
                    == Some(a.after_size),
            "Catalog changed before retirement acknowledgement"
        );
    } else {
        ensure!(
            j.attempt.is_some(),
            "Old row vanished before this transaction attempted catalog removal"
        );
        // An after-apply lost ACK can be followed by another writer preserving
        // our removal. The fresh read is the terminal merged catalog proof.
    }
    let folder = remote.metadata(&source.folder.entry.id, cancel)?;
    ensure!(
        folder.trashed && folder.entry == source.folder.entry,
        "Folder changed before catalog-last acknowledgement"
    );
    j.terminal = Some(TerminalProof {
        folder,
        members,
        catalog: c.metadata,
        catalog_document: c.document,
    });
    j.phase = Phase::Retired;
    validate_terminal(j)?;
    save(storage, j)
}
fn complete(local_ops: &drive_local_ops::Store, j: &Journal) -> Result<()> {
    for w in &j.witnesses {
        local_ops.complete(&w.operation_id, w.sequence)?;
    }
    Ok(())
}
fn acknowledge(report: &mut Report, j: &Journal) {
    report
        .protected_names
        .extend(j.guarded_names.iter().cloned());
    if j.phase == Phase::Retired {
        report.retired.push(RetiredLineage {
            operation_id: j.operation.clone(),
            sequence: j.sequence,
            source: j.source.clone().unwrap(),
        });
    } else if j.phase == Phase::LocalSuperseded {
        report
            .local_superseded
            .extend(j.witnesses.iter().map(|w| w.operation_id.clone()));
    }
}
fn witness(entry: &drive_local_ops::Entry) -> Result<Witness> {
    let State::Committed(sequence) = entry.state else {
        bail!("Local operation is not committed")
    };
    Ok(Witness {
        operation_id: entry.operation.id.clone(),
        sequence,
        operation: entry.operation.clone(),
    })
}

/// Resume ordinary publication journals BEFORE this function, and invoke it
/// BEFORE empty-library guards, fresh publication or generic orphan planning.
/// Conflicted names/rows remain protected even after local acknowledgements.
pub fn run_authorized(
    remote: &Remote,
    storage: &Path,
    binding: &Binding,
    local_ops: &drive_local_ops::Store,
    guard: &drive_local_ops::Guard,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
) -> Result<Report> {
    let requests_before = remote.request_count();
    let _lease = lock(storage)?;
    binding_current(remote, binding, cancel)?;
    ensure!(
        guard.root == binding.local_root && guard.root_identity == binding.root_identity,
        "Local operation guard has a different root"
    );
    local_ops.assert_unchanged(guard)?;
    let generation = remote.auth.store.generation();
    let stop = || cancel() || remote.auth.store.generation() != generation;
    let mut report = Report::default();
    let mut journals = load(storage, binding)?;
    require_retirement_identity(binding, &journals, guard)?;
    let mut handled = BTreeSet::new();
    for j in &mut journals {
        for w in &j.witnesses {
            let e = guard
                .entries
                .iter()
                .find(|e| e.operation.id == w.operation_id)
                .context("Retirement witness missing from local operation store")?;
            ensure!(
                e.operation == w.operation
                    && matches!(e.state,State::Committed(n)|State::Done(n) if n==w.sequence),
                "Retirement local operation sequence/body changed"
            );
        }
        let was_pending = matches!(j.phase, Phase::Prepared | Phase::FolderRetired);
        handled.extend(j.witnesses.iter().map(|w| w.operation_id.clone()));
        report
            .protected_names
            .extend(j.guarded_names.iter().cloned());
        let result = (|| -> Result<()> {
            finish(remote, storage, j, &stop)?;
            complete(local_ops, j)
        })();
        if let Err(e) = result {
            report.blocked.push(format!("{}: {e:#}", j.operation));
        }
        if j.phase == Phase::Retired || j.phase == Phase::LocalSuperseded {
            if was_pending {
                report.changed = true;
                report.follow_up = true;
            }
            acknowledge(&mut report, j);
        }
    }
    let retired = terminal_ids(&journals);
    let mut completed = journals
        .iter()
        .filter(|j| matches!(j.phase, Phase::Retired | Phase::LocalSuperseded))
        .flat_map(|j| j.witnesses.iter().map(|w| w.operation_id.clone()))
        .collect::<BTreeSet<_>>();
    let mut pending = guard
        .entries
        .iter()
        .filter(|e| matches!(e.state, State::Committed(_)) && !handled.contains(&e.operation.id))
        .collect::<Vec<_>>();
    pending.sort_by_key(|e| match e.state {
        State::Committed(n) => n,
        _ => 0,
    });
    for entry in &pending {
        if handled.contains(&entry.operation.id) {
            continue;
        }
        let operation = &entry.operation;
        let old = name(&operation.old_path)?;
        report.protected_names.insert(old.clone());
        let sequence = witness(entry)?.sequence;
        // A waiting/blocked predecessor owns the continuation of this exact
        // directory. Never acknowledge B->C as unpublished while A->B still
        // needs that committed edge to prove its final C endpoint next pass.
        // Include pending journals: their anchor may not be in `pending`.
        let unresolved_predecessor = guard.entries.iter().any(|prior| {
            let prior_sequence = match prior.state {
                State::Committed(n) | State::Done(n) => n,
                _ => return false,
            };
            let p = &prior.operation;
            prior_sequence < sequence
                && p.kind == Kind::Rename
                && p.destination == operation.old_path
                && p.local_identity == operation.local_identity
                && p.root_identity == operation.root_identity
                && p.local_root == operation.local_root
                && p.binding == operation.binding
                && !completed.contains(&p.id)
        });
        if unresolved_predecessor {
            continue;
        }
        if operation.binding.as_deref() != Some(binding.key.as_str())
            || operation.local_root != binding.local_root
            || operation.root_identity != binding.root_identity
        {
            report
                .blocked
                .push(format!("{old}: no exact captured account/root binding"));
            continue;
        }
        let outcome = (|| -> Result<Option<Journal>> {
            let mut chain = vec![witness(entry)?];
            let mut final_path = operation.destination.clone();
            if operation.kind == Kind::Rename {
                // First prove the physical end of the exact committed chain,
                // even if an earlier destination was published before moving.
                for next in pending
                    .iter()
                    .filter(|e| !handled.contains(&e.operation.id))
                {
                    let n = &next.operation;
                    if n.id == operation.id
                        || n.local_identity != operation.local_identity
                        || n.binding != operation.binding
                        || n.root_identity != operation.root_identity
                        || n.local_root != operation.local_root
                    {
                        continue;
                    }
                    let w = witness(next)?;
                    if w.sequence <= chain.last().unwrap().sequence || n.old_path != final_path {
                        continue;
                    }
                    final_path = n.destination.clone();
                    chain.push(w);
                    if n.kind == Kind::Delete {
                        // The positively committed Delete closes this lineage;
                        // no later same-name path can extend the old directory.
                        break;
                    }
                }
                if chain.last().unwrap().operation.kind == Kind::Delete {
                    // Successful local Delete removes its hidden payload after
                    // committing. Its exact positive operation/sequence is the
                    // endpoint witness; absence alone never creates authority.
                    match fs::symlink_metadata(&final_path) {
                        Ok(_) => ensure!(
                            directory_identity::read(&final_path)? == operation.local_identity,
                            "Delete chain hidden payload was replaced"
                        ),
                        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                        Err(e) => return Err(e.into()),
                    }
                } else {
                    ensure!(
                        directory_identity::read(&final_path)? == operation.local_identity,
                        "Rename chain destination is not the captured directory"
                    );
                }
                // A positive intermediate B requires ordinary A->B retirement
                // first. Unpublished foreign B remains protected, never owned.
                for index in 0..chain.len().saturating_sub(1) {
                    let intermediate = name(&chain[index].operation.destination)?;
                    report.protected_names.insert(intermediate.clone());
                    let candidates = drive_retirement::publication_candidates(
                        storage,
                        &binding.key,
                        &binding.root_identity,
                        &intermediate,
                        &operation.local_identity,
                    )?;
                    let active = candidates
                        .iter()
                        .any(|(_, s)| !retired.contains(&s.folder.entry.id));
                    if active {
                        ensure!(
                            resolve(
                                remote,
                                storage,
                                binding,
                                &intermediate,
                                &operation.local_identity,
                                &retired,
                                &stop
                            )?
                            .is_some(),
                            "Intermediate publication has no current positive proof"
                        );
                        final_path = chain[index].operation.destination.clone();
                        chain.truncate(index + 1);
                        break;
                    }
                }
            }
            let source = resolve(
                remote,
                storage,
                binding,
                &old,
                &operation.local_identity,
                &retired,
                &stop,
            )?;
            let mut guarded_names = chain
                .iter()
                .map(|w| name(&w.operation.old_path))
                .collect::<Result<BTreeSet<_>>>()?;
            let final_name = name(&final_path)?;
            let terminal_delete = chain.last().unwrap().operation.kind == Kind::Delete;
            let cycle = operation.kind == Kind::Rename
                && !terminal_delete
                && final_name == old
                && chain.len() > 1;
            let successor =
                if operation.kind == Kind::Rename && !terminal_delete && !cycle && source.is_some()
                {
                    match resolve(
                        remote,
                        storage,
                        binding,
                        &final_name,
                        &operation.local_identity,
                        &retired,
                        &stop,
                    )? {
                        Some(s) => Some(s),
                        None => {
                            report.waiting_for.insert(final_name);
                            return Ok(None);
                        }
                    }
                } else {
                    None
                };
            if cycle {
                ensure!(
                    source.is_some(),
                    "Rename cycle has no unchanged positive anchor generation"
                );
                guarded_names.remove(&old);
            }
            let phase = if cycle || source.is_none() {
                Phase::LocalSuperseded
            } else {
                Phase::Prepared
            };
            let catalog_id = if source.is_some() && !cycle {
                Some(catalog(remote, binding, storage, &stop)?.metadata.entry.id)
            } else {
                None
            };
            Ok(Some(Journal {
                version: 1,
                binding: binding.clone(),
                operation: operation.id.clone(),
                sequence: chain[0].sequence,
                witnesses: chain,
                phase,
                pruned: match &source {
                    Some(s) => verified_pruned_members(remote, storage, s, &stop)?,
                    None => vec![],
                },
                source,
                successor,
                guarded_names,
                known_publications: known_receipts(storage, binding)?,
                catalog_id,
                attempt: None,
                terminal: None,
            }))
        })();
        match outcome {
            Ok(Some(mut j)) => {
                report
                    .protected_names
                    .extend(j.guarded_names.iter().cloned());
                handled.extend(j.witnesses.iter().map(|w| w.operation_id.clone()));
                progress(format!("Retiring {old}"), 0.7);
                // Durable intent and all graph witnesses precede mutation.
                save(storage, &j)?;
                let result = (|| -> Result<()> {
                    finish(remote, storage, &mut j, &stop)?;
                    complete(local_ops, &j)
                })();
                if let Err(e) = result {
                    report.blocked.push(format!("{old}: {e:#}"));
                }
                if j.phase == Phase::Retired || j.phase == Phase::LocalSuperseded {
                    completed.extend(j.witnesses.iter().map(|w| w.operation_id.clone()));
                    report.changed = true;
                    report.follow_up = true;
                    acknowledge(&mut report, &j);
                }
                journals.push(j);
            }
            Ok(None) => {}
            Err(e) => report.blocked.push(format!("{old}: {e:#}")),
        }
    }
    // Prepared intent is protection too, but never cloud mutation authority.
    for e in &guard.entries {
        if matches!(e.state, State::Prepared | State::Committed(_)) {
            report.protected_names.insert(name(&e.operation.old_path)?);
        }
    }
    if !report.protected_names.is_empty() {
        if let Some(c) = catalog_optional(remote, binding, storage, &stop)? {
            for project in &report.protected_names {
                if let Some(r) = row(&c.document, project)? {
                    report.protected_rows.push(r.clone());
                }
            }
        }
    }
    ensure!(!stop(), "Retirement cancelled or account changed");
    report.made_request = remote.request_count() != requests_before;
    Ok(report)
}

fn admission_local(storage: &Path, binding: &Binding, project: &str,
    capture: &LocalCapture) -> Result<Vec<Journal>> {
    ensure!(drive_plan::plain_name(project) && capture.root_identity == binding.root_identity,
        "Invalid destination capture");
    let journals = load(storage, binding)?;
    let config = storage
        .parent()
        .and_then(Path::parent)
        .context("Retirement storage has no configuration root")?;
    let local = drive_local_ops::Store::new(config.into()).snapshot(&binding.local_root)?;
    require_retirement_identity(binding, &journals, &local)?;
    let completed = journals
        .iter()
        .filter(|j| matches!(j.phase, Phase::Retired | Phase::LocalSuperseded))
        .flat_map(|j| j.witnesses.iter().map(|w| w.operation_id.clone()))
        .collect::<BTreeSet<_>>();
    for e in &local.entries {
        if matches!(e.state, State::Prepared | State::Committed(_))
            && name(&e.operation.old_path)? == project
            && !completed.contains(&e.operation.id)
        {
            bail!("Destination {project} has an unfinished local retirement intent");
        }
    }
    Ok(journals)
}

/// Local admission plus the run's existing observation. A guarded name always
/// takes live admission, including terminal history and restored retired IDs.
pub fn quiet_destination(storage: &Path, binding: &Binding, project: &str,
    capture: &LocalCapture, folder: &RemoteEntry, root: &[RemoteEntry]) -> Result<bool> {
    let _lease = lock(storage)?;
    let journals = admission_local(storage, binding, project, capture)?;
    Ok(!journals.iter().any(|j| j.guarded_names.contains(project))
        && !terminal_ids(&journals).contains(&folder.id)
        && root.iter().filter(|m| m.name == project).count() == 1
        && root.iter().any(|m| m == folder && m.parents == vec![binding.singz_root.clone()]))
}

/// Fresh publication admission for ordinary and empty writers. Caller supplies
/// the actual leased capture and the exact intended EXISTING folder, or None
/// for a newly reserved ID. A retired name never permits adoption by name.
pub fn admit_destination(
    remote: &Remote,
    storage: &Path,
    binding: &Binding,
    project: &str,
    capture: &LocalCapture,
    existing_folder_id: Option<&str>,
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    ensure!(
        drive_plan::plain_name(project) && capture.root_identity == binding.root_identity,
        "Invalid destination capture"
    );
    let _lease = lock(storage)?;
    binding_current(remote, binding, cancel)?;
    let journals = admission_local(storage, binding, project, capture)?;
    let relevant = journals
        .iter()
        .filter(|j| j.guarded_names.contains(project))
        .collect::<Vec<_>>();
    ensure!(
        relevant
            .iter()
            .all(|j| matches!(j.phase, Phase::Retired | Phase::LocalSuperseded)),
        "Destination retirement has not completed"
    );
    let present = root_named(remote, binding, project, cancel)?;
    ensure!(
        present.as_ref().map(|m| m.id.as_str()) == existing_folder_id,
        "Destination folder observation changed"
    );
    // Identity rejection applies even when someone restored a retired folder
    // and renamed it to a name with no historical retirement guard.
    let retired = terminal_ids(&journals);
    if let Some(folder) = &present {
        ensure!(
            !retired.contains(&folder.id),
            "A previously retired folder cannot be adopted"
        );
    }
    if relevant.is_empty() || present.is_none() {
        return Ok(());
    }
    capture.local_identity.require_persistent()?;
    let folder = present.unwrap();
    let candidates = drive_retirement::publication_candidates(
        storage,
        &binding.key,
        &binding.root_identity,
        project,
        &capture.local_identity,
    )?;
    for (id, candidate) in candidates {
        if candidate.folder.entry.id == folder.id
            && relevant.iter().all(|j| !j.known_publications.contains(&id))
            && verify_live(remote, storage, &candidate, cancel).is_ok()
        {
            return Ok(());
        }
    }
    bail!(
        "Existing destination {project} has no fresh positive publication bound to its captured directory"
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive_auth::{AuthClient, Config, OAuthSession, TokenStore};
    use serde_json::json;
    use std::{
        io::{BufRead, BufReader},
        process::{Child, Command, Stdio},
    };
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        storage: PathBuf,
        remote: Remote,
        server: Child,
        binding: Binding,
        ops: drive_local_ops::Store,
    }
    impl Fixture {
        fn new() -> Self {
            let base = std::env::temp_dir().join(format!(
                "singz-retire-http-{}",
                crate::drive_http::random_id().unwrap()
            ));
            fs::create_dir_all(base.join("library/Song")).unwrap();
            let base = base.canonicalize().unwrap();
            let root = base.join("library");
            let storage = base.join("preferences/gdrive/retirements");
            let mut server = Command::new("python3")
                .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py"))
                .arg(base.join("remote"))
                .stdin(Stdio::null())
                .stdout(Stdio::piped())
                .stderr(Stdio::null())
                .spawn()
                .unwrap();
            let mut line = String::new();
            BufReader::new(server.stdout.take().unwrap())
                .read_line(&mut line)
                .unwrap();
            let url = serde_json::from_str::<Value>(&line).unwrap()["base"]
                .as_str()
                .unwrap()
                .to_owned();
            let config=Config::from_json(&json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":url,"apiBase":url,"uploadBase":url}).to_string()).unwrap();
            let tokens = TokenStore::new(&base.join("preferences")).unwrap();
            let session = OAuthSession::start(config.clone(), tokens.clone()).unwrap();
            let response = crate::drive_http::request(
                crate::drive_http::Request {
                    method: "GET",
                    url: session.authorization_url(),
                    headers: &[],
                    body: crate::drive_http::Body::Empty,
                    destination: crate::drive_http::Destination::Bytes(4096),
                    upload: false,
                    allow_loopback_http: true,
                },
                &|| false,
            )
            .unwrap();
            let callback = response.header("location").unwrap().to_owned();
            let finish = std::thread::spawn(move || session.finish(&|| false));
            let response = crate::drive_http::request(
                crate::drive_http::Request {
                    method: "GET",
                    url: &callback,
                    headers: &[],
                    body: crate::drive_http::Body::Empty,
                    destination: crate::drive_http::Destination::Bytes(4096),
                    upload: false,
                    allow_loopback_http: true,
                },
                &|| false,
            )
            .unwrap();
            assert_eq!(response.status, 200);
            finish.join().unwrap().unwrap();
            let remote = Remote::new(AuthClient::new(config, tokens));
            let singz = remote.folder("SingZ", None, &|| false).unwrap();
            let binding =
                drive_retirement::bind(&remote, &storage, &root, &singz, &|| false).unwrap();
            let ops = drive_local_ops::Store::new(base.join("preferences"));
            Self {
                base,
                root,
                storage,
                remote,
                server,
                binding,
                ops,
            }
        }
        fn publish(&self, project: &str) -> PublicationLineage {
            let path = self.root.join(project);
            fs::create_dir_all(&path).unwrap();
            let bytes=serde_json::to_vec(&json!({"version":2,"name":project,"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]},"stemHashes":{}})).unwrap();
            fs::write(path.join("project.json"), bytes).unwrap();
            let capture = crate::drive_snapshot::capture_empty(
                &self.root,
                project,
                &self
                    .base
                    .join(format!("spool-{}", crate::drive_http::random_id().unwrap())),
                &|| false,
            )
            .unwrap();
            let local = capture.publication_capture();
            let bytes = fs::read(&capture.snapshot.top[0].path).unwrap();
            drop(capture);
            let folder = self
                .remote
                .folder(project, Some(&self.binding.singz_root), &|| false)
                .unwrap();
            let file = self
                .remote
                .upload_bytes(
                    &bytes,
                    "project.json",
                    &folder,
                    None,
                    "application/json",
                    &|| false,
                )
                .unwrap();
            let r = json!({"dir":project,"files":[{"id":file,"name":"project.json","md5Checksum":md5(&bytes),"size":bytes.len()}]});
            let mut document =
                catalog_optional(&self.remote, &self.binding, &self.storage, &|| false)
                    .unwrap()
                    .map(|c| c.document)
                    .unwrap_or_else(
                        || json!({"format":2,"projects":[],"unknown":{"preserve":true}}),
                    );
            document["projects"]
                .as_array_mut()
                .unwrap()
                .retain(|r| r["dir"] != project);
            document["projects"].as_array_mut().unwrap().push(r.clone());
            let catalog_bytes = serde_json::to_vec(&document).unwrap();
            let existing = self
                .remote
                .children(&self.binding.singz_root, &|| false)
                .unwrap()
                .into_iter()
                .find(|m| m.name == "catalog.json");
            let catalog_id = self
                .remote
                .upload_bytes(
                    &catalog_bytes,
                    "catalog.json",
                    &self.binding.singz_root,
                    existing.as_ref().map(|m| m.id.as_str()),
                    "application/json",
                    &|| false,
                )
                .unwrap();
            let expected = ExpectedPublication {
                folder: self.remote.metadata(&folder, &|| false).unwrap().entry,
                members: vec![
                    self.remote
                        .metadata(r["files"][0]["id"].as_str().unwrap(), &|| false)
                        .unwrap()
                        .entry,
                ],
                catalog_row: r,
                catalog: self.remote.metadata(&catalog_id, &|| false).unwrap().entry,
            };
            let s = drive_retirement::capture_verify_publication(
                &self.remote,
                &self.binding,
                &local,
                &expected,
                &|| false,
            )
            .unwrap();
            drive_retirement::record_publication(&self.storage, &s).unwrap();
            s
        }
        fn operation(&self, old: &str, next: &str, kind: Kind) {
            let path = self.root.join(old);
            let hash = crate::project_store::read(&path, "project.json").unwrap().1;
            let p = self
                .ops
                .prepare(
                    kind,
                    &self.root,
                    &path,
                    &self.root.join(next),
                    &hash,
                    Some(self.binding.key.clone()),
                )
                .unwrap();
            fs::rename(path, self.root.join(next)).unwrap();
            p.commit(&crate::sync_dirty::Store::new(
                self.base.join("preferences"),
            ))
            .unwrap();
        }
        fn run(&self) -> Report {
            run_authorized(
                &self.remote,
                &self.storage,
                &self.binding,
                &self.ops,
                &self.ops.snapshot(&self.root).unwrap(),
                &|| false,
                &|_, _| {},
            )
            .unwrap()
        }
        fn control(&self, value: Value) {
            let bytes = serde_json::to_vec(&value).unwrap();
            let url = format!("{}/control", self.remote.auth.config.api_base);
            let response = crate::drive_http::request(
                crate::drive_http::Request {
                    method: "POST",
                    url: &url,
                    headers: &[("Content-Type", "application/json")],
                    body: crate::drive_http::Body::Bytes(&bytes),
                    destination: crate::drive_http::Destination::Bytes(4096),
                    upload: false,
                    allow_loopback_http: true,
                },
                &|| false,
            )
            .unwrap();
            assert_eq!(response.status, 200);
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = self.server.kill();
            let _ = self.server.wait();
            let _ = fs::remove_dir_all(&self.base);
        }
    }

    #[test]
    fn delete_last_project_retires_known_id_and_catalog_last_preserving_unknowns() {
        let f = Fixture::new();
        let s = f.publish("Song");
        let outside = f.remote.folder("Song", Some("root"), &|| false).unwrap();
        let sentinel = f
            .remote
            .upload_bytes(
                b"outside recovery",
                "original.mp3",
                &outside,
                None,
                "audio/mpeg",
                &|| false,
            )
            .unwrap();
        let before = f.remote.metadata(&sentinel, &|| false).unwrap();
        f.operation("Song", ".deleted-song", Kind::Delete);
        let report = f.run();
        assert!(report.blocked.is_empty(), "{:?}", report.blocked);
        assert!(report.changed && report.follow_up);
        assert_eq!(report.retired.len(), 1);
        assert!(
            f.remote
                .metadata(&s.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        let c = catalog(&f.remote, &f.binding, &f.storage, &|| false).unwrap();
        assert!(row(&c.document, "Song").unwrap().is_none());
        assert_eq!(c.document["unknown"]["preserve"], true);
        assert_eq!(f.remote.metadata(&sentinel, &|| false).unwrap(), before);
        let again = f.run();
        assert_eq!(again.retired.len(), 1);
        assert!(!again.changed);
    }
    #[test]
    fn rename_waits_for_positive_destination_then_retires_only_old_generation() {
        let f = Fixture::new();
        let old = f.publish("Song");
        f.operation("Song", "Renamed", Kind::Rename);
        let waiting = f.run();
        assert!(waiting.blocked.is_empty(), "{:?}", waiting.blocked);
        assert!(waiting.waiting_for.contains("Renamed"));
        assert!(
            !f.remote
                .metadata(&old.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert_eq!(waiting.protected_rows.len(), 1);
        let new = f.publish("Renamed");
        let done = f.run();
        assert!(done.blocked.is_empty(), "{:?}", done.blocked);
        assert_eq!(done.retired.len(), 1);
        assert!(
            !f.remote
                .metadata(&new.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert!(
            row(
                &catalog(&f.remote, &f.binding, &f.storage, &|| false)
                    .unwrap()
                    .document,
                "Renamed"
            )
            .unwrap()
            .is_some()
        );
    }
    #[test]
    fn extra_member_and_foreign_catalog_row_never_authorize_trash() {
        let f = Fixture::new();
        let old = f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        let foreign = f
            .remote
            .upload_bytes(
                b"mine",
                "foreign.txt",
                &old.folder.entry.id,
                None,
                "text/plain",
                &|| false,
            )
            .unwrap();
        let report = f.run();
        assert!(!report.blocked.is_empty());
        assert!(report.retired.is_empty());
        assert!(
            !f.remote
                .metadata(&old.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert!(!f.remote.metadata(&foreign, &|| false).unwrap().trashed);
        assert!(load(&f.storage, &f.binding).unwrap().is_empty());
    }
    #[test]
    fn lost_trash_ack_and_catalog_ack_resume_without_name_based_deletion() {
        for catalog_fault in [false, true] {
            let f = Fixture::new();
            let old = f.publish("Song");
            f.operation("Song", ".deleted-song", Kind::Delete);
            let path = if catalog_fault {
                "/upload-session".to_owned()
            } else {
                format!("/drive/v3/files/{}", old.folder.entry.id)
            };
            let method = if catalog_fault { "PUT" } else { "PATCH" };
            f.control(json!({"failNext":[{"method":method,"path":path,"status":503,"afterApply":true,"disconnect":true,"count":1}]}));
            let first = f.run();
            assert!(
                !first.blocked.is_empty(),
                "Fault must exercise a persisted uncertain outcome"
            );
            let pending = load(&f.storage, &f.binding).unwrap();
            assert_eq!(pending.len(), 1);
            assert!(pending[0].terminal.is_none());
            let second = f.run();
            assert!(
                second.blocked.is_empty(),
                "first={:?}, second={:?}",
                first.blocked,
                second.blocked
            );
            assert_eq!(second.retired.len(), 1);
            assert!(
                f.remote
                    .metadata(&old.folder.entry.id, &|| false)
                    .unwrap()
                    .trashed
            );
            assert_eq!(load(&f.storage, &f.binding).unwrap().len(), 1);
        }
    }
    #[test]
    fn a_b_a_unpublished_cycle_is_local_supersession_without_cloud_retirement() {
        let f = Fixture::new();
        let anchor = f.publish("Song");
        f.operation("Song", "B", Kind::Rename);
        f.operation("B", "Song", Kind::Rename);
        let foreign = f
            .remote
            .folder("B", Some(&f.binding.singz_root), &|| false)
            .unwrap();
        let report = f.run();
        assert!(report.blocked.is_empty(), "{:?}", report.blocked);
        assert!(report.retired.is_empty());
        assert_eq!(report.local_superseded.len(), 2);
        assert!(
            !f.remote
                .metadata(&anchor.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert!(!f.remote.metadata(&foreign, &|| false).unwrap().trashed);
        assert!(f.run().protected_names.contains("B"));
    }
    #[test]
    fn a_b_c_publishes_final_c_before_retiring_a_and_protects_foreign_b() {
        let f = Fixture::new();
        let old = f.publish("Song");
        f.operation("Song", "B", Kind::Rename);
        f.operation("B", "C", Kind::Rename);
        let foreign = f
            .remote
            .folder("B", Some(&f.binding.singz_root), &|| false)
            .unwrap();
        let wait = f.run();
        assert!(wait.waiting_for.contains("C"));
        assert!(
            !f.remote
                .metadata(&old.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        let new = f.publish("C");
        let done = f.run();
        assert!(done.blocked.is_empty(), "{:?}", done.blocked);
        assert_eq!(done.retired.len(), 1);
        assert!(done.protected_names.contains("B"));
        assert!(!f.remote.metadata(&foreign, &|| false).unwrap().trashed);
        assert!(
            !f.remote
                .metadata(&new.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
    }
    #[test]
    fn retired_name_rejects_foreign_replacement_then_accepts_fresh_captured_receipt() {
        let f = Fixture::new();
        f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        assert_eq!(f.run().retired.len(), 1);
        fs::create_dir(f.root.join("Song")).unwrap();
        fs::write(f.root.join("Song/project.json"), b"{}").unwrap();
        let capture = LocalCapture {
            root_identity: f.binding.root_identity.clone(),
            local_identity: directory_identity::read(&f.root.join("Song")).unwrap(),
            local_document: crate::project_store::fingerprint(b"{}"),
        };
        let foreign = f
            .remote
            .folder("Song", Some(&f.binding.singz_root), &|| false)
            .unwrap();
        assert!(
            admit_destination(
                &f.remote,
                &f.storage,
                &f.binding,
                "Song",
                &capture,
                Some(&foreign),
                &|| false
            )
            .is_err()
        );
        f.remote.trash(&foreign, &|| false).unwrap();
        assert!(
            admit_destination(
                &f.remote,
                &f.storage,
                &f.binding,
                "Song",
                &capture,
                None,
                &|| false
            )
            .is_ok()
        );
        let new = f.publish("Song");
        assert!(
            admit_destination(
                &f.remote,
                &f.storage,
                &f.binding,
                "Song",
                &new.capture,
                Some(&new.folder.entry.id),
                &|| false
            )
            .is_ok()
        );
    }
    #[test]
    fn pending_404_never_retires_but_saved_positive_terminal_proof_survives_later_404() {
        let f = Fixture::new();
        let source = f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        let guard = f.ops.snapshot(&f.root).unwrap();
        let w = witness(&guard.entries[0]).unwrap();
        let j = Journal {
            version: 1,
            binding: f.binding.clone(),
            operation: w.operation_id.clone(),
            sequence: w.sequence,
            witnesses: vec![w],
            phase: Phase::Prepared,
            source: Some(source.clone()),
            pruned: vec![],
            successor: None,
            guarded_names: BTreeSet::from(["Song".into()]),
            known_publications: known_receipts(&f.storage, &f.binding).unwrap(),
            catalog_id: Some(
                catalog(&f.remote, &f.binding, &f.storage, &|| false)
                    .unwrap()
                    .metadata
                    .entry
                    .id,
            ),
            attempt: None,
            terminal: None,
        };
        save(&f.storage, &j).unwrap();
        let mut hidden = serde_json::Map::new();
        hidden.insert(source.folder.entry.id.clone(), json!({"metadata":1}));
        f.control(json!({"hideNext":hidden}));
        let blocked = f.run();
        assert!(!blocked.blocked.is_empty());
        assert!(blocked.retired.is_empty());
        assert_eq!(
            load(&f.storage, &f.binding).unwrap()[0].phase,
            Phase::Prepared
        );
        assert!(
            !f.remote
                .metadata(&source.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert_eq!(f.run().retired.len(), 1);
        let mut hidden = serde_json::Map::new();
        hidden.insert(source.folder.entry.id.clone(), json!({"metadata":5}));
        f.control(json!({"hideNext":hidden}));
        let historical = f.run();
        assert!(historical.blocked.is_empty(), "{:?}", historical.blocked);
        assert_eq!(historical.retired.len(), 1);
    }
    #[test]
    fn changed_own_catalog_file_id_blocks_retirement_without_touching_folder() {
        let f = Fixture::new();
        let source = f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        let mut c = catalog(&f.remote, &f.binding, &f.storage, &|| false).unwrap();
        c.document["projects"][0]["files"][0]["id"] = json!("foreign-project-id");
        f.remote
            .upload_bytes(
                &serde_json::to_vec(&c.document).unwrap(),
                "catalog.json",
                &f.binding.singz_root,
                Some(&c.metadata.entry.id),
                "application/json",
                &|| false,
            )
            .unwrap();
        let report = f.run();
        assert!(!report.blocked.is_empty());
        assert!(report.retired.is_empty());
        assert!(
            !f.remote
                .metadata(&source.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert_eq!(
            report.protected_rows[0]["files"][0]["id"],
            "foreign-project-id"
        );
    }
    #[test]
    fn retired_id_restored_under_unrelated_name_is_never_admitted() {
        let f = Fixture::new();
        let source = f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        assert_eq!(f.run().retired.len(), 1);
        f.remote
            .patch(
                &source.folder.entry.id,
                &json!({"trashed":false,"name":"B"}),
                &|| false,
            )
            .unwrap();
        fs::create_dir(f.root.join("B")).unwrap();
        fs::write(f.root.join("B/project.json"), b"{}").unwrap();
        let capture = LocalCapture {
            root_identity: f.binding.root_identity.clone(),
            local_identity: directory_identity::read(&f.root.join("B")).unwrap(),
            local_document: crate::project_store::fingerprint(b"{}"),
        };
        assert!(
            load(&f.storage, &f.binding)
                .unwrap()
                .iter()
                .all(|j| !j.guarded_names.contains("B"))
        );
        let error = admit_destination(
            &f.remote,
            &f.storage,
            &f.binding,
            "B",
            &capture,
            Some(&source.folder.entry.id),
            &|| false,
        )
        .unwrap_err();
        assert!(
            error.to_string().contains("previously retired"),
            "{error:#}"
        );
        let restored = f
            .remote
            .metadata(&source.folder.entry.id, &|| false)
            .unwrap();
        assert!(!restored.trashed);
        assert_eq!(restored.entry.name, "B");
    }
    fn rename_then_delete_case(published_b: bool) {
        let f = Fixture::new();
        let a = f.publish("Song");
        f.operation("Song", "B", Kind::Rename);
        let b = if published_b {
            Some(f.publish("B"))
        } else {
            None
        };
        let foreign_b = if published_b {
            None
        } else {
            Some(
                f.remote
                    .folder("B", Some(&f.binding.singz_root), &|| false)
                    .unwrap(),
            )
        };
        f.operation("B", ".deleted-b", Kind::Delete);
        // Actual Delete cleans up its hidden payload after the positive commit.
        fs::remove_dir_all(f.root.join(".deleted-b")).unwrap();
        let report = f.run();
        assert!(report.blocked.is_empty(), "{:?}", report.blocked);
        assert!(report.waiting_for.is_empty());
        assert_eq!(report.retired.len(), if published_b { 2 } else { 1 });
        assert!(
            f.remote
                .metadata(&a.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        if let Some(b) = b {
            assert!(
                f.remote
                    .metadata(&b.folder.entry.id, &|| false)
                    .unwrap()
                    .trashed
            );
        }
        if let Some(foreign) = foreign_b {
            assert!(!f.remote.metadata(&foreign, &|| false).unwrap().trashed);
        }
        let c = catalog(&f.remote, &f.binding, &f.storage, &|| false).unwrap();
        assert!(row(&c.document, "Song").unwrap().is_none());
        assert!(row(&c.document, "B").unwrap().is_none());
        let guard = f.ops.snapshot(&f.root).unwrap();
        assert_eq!(guard.entries.len(), 2);
        assert!(
            guard
                .entries
                .iter()
                .all(|e| matches!(e.state, State::Done(_)))
        );
        let journals = load(&f.storage, &f.binding).unwrap();
        if !published_b {
            assert_eq!(journals.len(), 1);
            assert_eq!(journals[0].witnesses.len(), 2);
            assert_eq!(journals[0].witnesses[1].operation.kind, Kind::Delete);
        }
        let again = f.run();
        assert!(again.blocked.is_empty());
        assert!(!again.changed);
        assert!(again.protected_names.contains("B"));
    }
    #[test]
    fn rename_then_delete_unpublished_b_retires_a_with_exact_delete_witness() {
        rename_then_delete_case(false);
    }
    #[test]
    fn rename_then_delete_published_b_retires_a_then_b() {
        rename_then_delete_case(true);
    }
    #[test]
    fn transient_anchor_proof_failure_defers_unpublished_descendants_until_retry() {
        let f = Fixture::new();
        let a = f.publish("Song");
        f.operation("Song", "B", Kind::Rename);
        f.operation("B", "C", Kind::Rename);
        let mut hidden = serde_json::Map::new();
        hidden.insert(a.folder.entry.id.clone(), json!({"metadata":1}));
        f.control(json!({"hideNext":hidden}));
        let failed = f.run();
        assert!(!failed.blocked.is_empty());
        assert!(failed.local_superseded.is_empty());
        assert!(load(&f.storage, &f.binding).unwrap().is_empty());
        let guard = f.ops.snapshot(&f.root).unwrap();
        assert!(
            guard
                .entries
                .iter()
                .all(|e| matches!(e.state, State::Committed(_)))
        );
        let waiting = f.run();
        assert!(waiting.waiting_for.contains("C"));
        assert!(waiting.local_superseded.is_empty());
        assert!(
            f.ops
                .snapshot(&f.root)
                .unwrap()
                .entries
                .iter()
                .all(|e| matches!(e.state, State::Committed(_)))
        );
        f.publish("C");
        let done = f.run();
        assert!(done.blocked.is_empty(), "{:?}", done.blocked);
        assert_eq!(done.retired.len(), 1);
        assert!(
            f.remote
                .metadata(&a.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert!(
            f.ops
                .snapshot(&f.root)
                .unwrap()
                .entries
                .iter()
                .all(|e| matches!(e.state, State::Done(_)))
        );
    }
    #[test]
    fn foreign_already_trashed_extra_is_not_promoted_to_owned_prune_evidence() {
        let f = Fixture::new();
        let source = f.publish("Song");
        let foreign = f
            .remote
            .upload_bytes(
                b"foreign historical bytes",
                "foreign.txt",
                &source.folder.entry.id,
                None,
                "text/plain",
                &|| false,
            )
            .unwrap();
        f.remote.trash(&foreign, &|| false).unwrap();
        f.operation("Song", ".deleted-song", Kind::Delete);
        let report = f.run();
        assert!(!report.blocked.is_empty());
        assert!(report.retired.is_empty());
        assert!(
            !f.remote
                .metadata(&source.folder.entry.id, &|| false)
                .unwrap()
                .trashed
        );
        assert!(f.remote.metadata(&foreign, &|| false).unwrap().trashed);
        assert!(load(&f.storage, &f.binding).unwrap().is_empty());
    }
    #[test]
    fn positively_pruned_ordinary_member_remains_in_full_delete_terminal_proof() {
        let f = Fixture::new();
        let source = f.publish("Song");
        let obsolete = f
            .remote
            .upload_bytes(
                br#"{"notes":[]}"#,
                "graph.json",
                &source.folder.entry.id,
                None,
                "application/json",
                &|| false,
            )
            .unwrap();
        let mut capture = crate::drive_snapshot::capture_empty(
            &f.root,
            "Song",
            &f.base.join("ordinary-prune-spool"),
            &|| false,
        )
        .unwrap();
        let top = f
            .remote
            .children(&source.folder.entry.id, &|| false)
            .unwrap();
        let theirs = crate::drive_plan::RemoteProject {
            folder_id: Some(source.folder.entry.id.clone()),
            stems_id: None,
            top: top.clone(),
            stems: vec![],
        };
        let mut plan = drive_plan::plan_project(&capture.snapshot, &theirs).unwrap();
        assert_eq!(plan.trash.len(), 1);
        assert_eq!(plan.trash[0].entry.id, obsolete);
        capture.spool_uploads(&mut plan, &|| false).unwrap();
        let handle = crate::drive_publication::prepare(
            &f.remote,
            &f.storage,
            &f.binding,
            &mut capture,
            &mut plan,
            crate::drive_publication::DestinationAdmission {
                folder: Some(source.folder.entry.clone()),
                stems: None,
                top,
                stem_files: vec![],
            },
            &|| false,
        )
        .unwrap();
        drop(capture);
        let publication =
            crate::drive_publication::finish(&f.remote, &handle, &|| false, &|_, _| {}).unwrap();
        let current = publication.lineage.unwrap();
        assert_eq!(
            crate::drive_publication::owned_pruned_members(&f.storage, &current)
                .unwrap()
                .len(),
            1
        );
        assert!(f.remote.metadata(&obsolete, &|| false).unwrap().trashed);
        f.operation("Song", ".deleted-song", Kind::Delete);
        let report = f.run();
        assert!(report.blocked.is_empty(), "{:?}", report.blocked);
        assert_eq!(report.retired.len(), 1);
        let journals = load(&f.storage, &f.binding).unwrap();
        assert_eq!(journals[0].pruned.len(), 1);
        assert_eq!(journals[0].pruned[0].entry.id, obsolete);
        assert!(
            journals[0]
                .terminal
                .as_ref()
                .unwrap()
                .members
                .iter()
                .any(|m| m.entry.id == obsolete && m.trashed)
        );
    }
    #[test]
    fn ordinary_birthless_policy_requires_persistence_only_for_retirement_authority() {
        let f = Fixture::new();
        let mut encoded = serde_json::to_value(&f.binding.root_identity).unwrap();
        encoded["created"] = Value::Null;
        let weak: directory_identity::DirectoryIdentity = serde_json::from_value(encoded).unwrap();
        assert!(!weak.persistent_eligible());
        let mut binding = f.binding.clone();
        binding.root_identity = weak.clone();
        let mut guard = drive_local_ops::Guard {
            root: f.root.clone(),
            root_identity: weak.clone(),
            entries: vec![],
            epoch: String::new(),
        };
        assert!(require_retirement_identity(&binding, &[], &guard).is_ok());
        // The soft eligibility boundary never bypasses actual live identity
        // validation: this deliberately mismatched synthetic binding is refused.
        assert!(binding_current(&f.remote, &binding, &|| false).is_err());
        let operation = Operation {
            id: String::new(),
            version: 1,
            nonce: "birthless-policy".into(),
            kind: Kind::Delete,
            local_root: f.root.clone(),
            root_identity: weak.clone(),
            old_path: f.root.join("Song"),
            destination: f.root.join(".deleted-song"),
            local_identity: weak,
            local_document: "0".repeat(64),
            binding: Some(binding.key.clone()),
        };
        guard.entries.push(drive_local_ops::Entry {
            operation: operation.clone(),
            state: State::Committed(1),
            active: false,
        });
        let error = require_retirement_identity(&binding, &[], &guard).unwrap_err();
        assert!(directory_identity::is_persistent_unavailable(&error));
        guard.entries[0].state = State::Aborted;
        assert!(require_retirement_identity(&binding, &[], &guard).is_ok());
        let history = Journal {
            version: 1,
            binding: binding.clone(),
            operation: "0".repeat(64),
            sequence: 1,
            witnesses: vec![Witness {
                operation_id: "0".repeat(64),
                sequence: 1,
                operation,
            }],
            phase: Phase::LocalSuperseded,
            source: None,
            pruned: vec![],
            successor: None,
            guarded_names: BTreeSet::from(["Song".into()]),
            known_publications: BTreeSet::new(),
            catalog_id: None,
            attempt: None,
            terminal: None,
        };
        let error = require_retirement_identity(&binding, &[history], &guard).unwrap_err();
        assert!(directory_identity::is_persistent_unavailable(&error));
    }
    #[test]
    fn terminal_history_over_4096_records_retains_every_validated_proof() {
        let f = Fixture::new();
        f.publish("Song");
        f.operation("Song", ".deleted-song", Kind::Delete);
        assert_eq!(f.run().retired.len(), 1);
        let original = load(&f.storage, &f.binding).unwrap().remove(0);
        let mut expected = BTreeSet::from([original.operation.clone()]);
        // Synthetic durable history avoids thousands of syncs/HTTP journeys.
        // Every operation body/filename and terminal proof is still validated.
        for index in 0..4096 {
            let mut j = original.clone();
            let w = &mut j.witnesses[0];
            w.operation.nonce = format!("synthetic-terminal-history-{index}");
            w.operation_id = digest(&w.operation).unwrap();
            w.operation.id = w.operation_id.clone();
            w.sequence = index + 2;
            j.operation = w.operation_id.clone();
            j.sequence = w.sequence;
            expected.insert(j.operation.clone());
            let path = journal_dir(&f.storage, &j.operation).unwrap();
            private_dir(&path).unwrap();
            let mut file = crate::drive_http::private_file(&path.join("journal.json")).unwrap();
            file.write_all(&serde_json::to_vec(&j).unwrap()).unwrap();
        }
        let all = load(&f.storage, &f.binding).unwrap();
        assert_eq!(all.len(), 4097);
        assert_eq!(
            all.iter()
                .map(|j| j.operation.clone())
                .collect::<BTreeSet<_>>(),
            expected
        );
        assert!(
            all.iter()
                .all(|j| j.phase == Phase::Retired && validate_terminal(j).is_ok())
        );
    }
}

//! Full-library writer reconciliation against actual Drive listings.
use crate::{
    drive_plan::{self, RemoteEntry, RemoteProject},
    drive_remote::{FOLDER, Remote},
    drive_snapshot,
};
use anyhow::{Context, Result, ensure};
use md5::{Digest, Md5};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Debug, Default)]
pub struct Report {
    pub uploaded: usize,
    pub unchanged: usize,
    pub trashed: usize,
    pub projects: usize,
    pub adopted: Vec<String>,
    pub warnings: Vec<String>,
    pub skipped: Vec<PathBuf>,
    pub synced: BTreeMap<PathBuf, String>,
    /// A dedicated transaction committed; finish ordinary reconciliation from
    /// a fresh listing in an explicit continuation, even with no dirty rows.
    pub follow_up: bool,
}
struct Spool(PathBuf);
impl Drop for Spool {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn file_children(children: &[RemoteEntry]) -> Vec<RemoteEntry> {
    children
        .iter()
        .filter(|f| f.mime_type.as_deref() != Some(FOLDER))
        .cloned()
        .collect()
}
fn catalog_manifest(mut document: Value, projects: Vec<Value>) -> Result<Vec<u8>> {
    ensure!(document.is_object() && document["format"] == 2,
        "Unsupported library catalog document");
    if document["capabilities"].is_null() {
        document["capabilities"] = json!({});
    }
    document["capabilities"].as_object_mut()
        .context("Invalid library catalog capabilities; cleanup deferred")?
        .insert("adopt".into(), json!(1));
    document["projects"] = json!(projects);
    Ok(serde_json::to_vec(&document)?)
}
// Preserve unknown fields on rows we publish, and retirement-protected rows,
// while retaining the writer's existing pruning of unchanged nonlocal rows.
fn cleanup_manifest(document: &Value, mut catalog: Vec<Value>,
    protected_names: &BTreeSet<String>) -> Result<Vec<u8>> {
    for row in &mut catalog {
        if let Some(mut current) = crate::drive_publication::catalog_project_row(
            document, row["dir"].as_str().context("Invalid planned catalog name")?)? {
            ensure!(crate::drive_publication::catalog_row_equal(&current, row)?,
                "A published catalog row changed during sync; cleanup deferred");
            current["files"] = row["files"].clone();
            *row = current;
        }
    }
    for name in protected_names {
        if !catalog.iter().any(|row| row["dir"].as_str() == Some(name.as_str())) {
            if let Some(row) = crate::drive_publication::catalog_project_row(document, name)? {
                catalog.push(row);
            }
        }
    }
    catalog_manifest(document.clone(), catalog)
}
fn remember_publication(
    remote: &Remote, storage: &Path, binding: &crate::drive_retirement::Binding,
    plan: &crate::drive_retirement::PublicationPlan, cancel: &impl Fn() -> bool,
) -> Result<()> {
    match crate::drive_retirement::capture_verify_publication(remote, binding,
        &plan.capture, &plan.expected, cancel) {
        Ok(lineage) => { crate::drive_retirement::record_publication(storage, &lineage)?; }
        Err(error) if error.is::<crate::drive_retirement::IneligibleLineage>()
            || crate::directory_identity::is_persistent_unavailable(&error) => {
            // Unmanaged retained files are not part of the writer's publication
            // contract and cannot become deletion authority through a listing.
            crate::diagnostics::event("sync", format!("No retirement receipt for {}: {error:#}",
                plan.expected.folder.name), crate::diagnostics::Level::Warn);
        }
        Err(error) => return Err(error),
    }
    Ok(())
}
pub fn run(
    remote: &Remote,
    root: &Path,
    temporary_root: &Path,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
    capturing: &impl Fn(Option<PathBuf>),
) -> Result<Report> {
    match run_inner(remote, root, temporary_root, cancel, progress, capturing) {
        Err(error) if crate::directory_identity::is_retry(&error) => {
            capturing(None);
            let dirs = drive_snapshot::scan(root, cancel)?;
            Ok(Report { projects: dirs.len(), skipped: dirs.into_iter().map(|name| root.join(name)).collect(),
                warnings: vec![error.to_string()], follow_up: true, ..Default::default() })
        }
        result => result,
    }
}
fn run_inner(
    remote: &Remote,
    root: &Path,
    temporary_root: &Path,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
    capturing: &impl Fn(Option<PathBuf>),
) -> Result<Report> {
    let remote = remote.for_run();
    let remote = &remote;
    let generation = remote.auth.store.generation();
    let cancel = &|| cancel() || remote.auth.store.generation() != generation;
    ensure!(!cancel(), "Drive sync cancelled");
    let root = root.canonicalize()?;
    let config_dir = temporary_root.parent().and_then(Path::parent)
        .context("Drive spool has no native configuration parent")?;
    let local_operations = crate::drive_local_ops::Store::new(config_dir.to_owned());
    let recovery = local_operations.recover_prepared(&root,
        &crate::sync_dirty::Store::new(config_dir.to_owned()),
        |from, to| crate::project_delete::exclusive_move(from, to).map_err(anyhow::Error::from))?;
    for warning in &recovery.warnings {
        crate::diagnostics::event("sync", warning.clone(), crate::diagnostics::Level::Warn);
    }
    ensure!(recovery.blocked.is_empty() && recovery.busy.is_empty(),
        "Local project operation recovery is unresolved: {:?}; active: {:?}",
        recovery.blocked, recovery.busy);
    let initial = drive_snapshot::scan(&root, cancel)?;
    crate::drive_hash_cache::prune(config_dir, &root);
    let singz = remote.folder("SingZ", None, cancel)?;
    let mut remote_top = remote.children(&singz, cancel)?;
    let journal_root = temporary_root
        .parent()
        .context("Drive spool has no private state parent")?
        .join("empty-transactions");
    let retirement_root = config_dir.join("gdrive/retirements");
    let binding = crate::drive_retirement::bind(remote, &retirement_root, &root, &singz, cancel)?;
    // Finish accepted immutable upload generations before interpreting later
    // local Delete/Rename receipts. Their source paths may already be gone.
    let publication_index = crate::drive_publication::JournalIndex::load(&retirement_root)?;
    let resumed = crate::drive_publication::resume_indexed(remote, &publication_index,
        &binding, cancel, progress)?;
    if !resumed.is_empty() {
        let mut report = Report { projects: initial.len(), follow_up: true,
            skipped: initial.iter().map(|name| root.join(name)).collect(), ..Default::default() };
        for outcome in resumed {
            let publication = outcome.publication;
            let name = publication.expected.folder.name.clone();
            let rows = BTreeMap::from([(name,
                (publication.capture.local_document.clone(), publication.expected.catalog_row.clone()))]);
            crate::drive_empty::acknowledge_ordinary_publication(remote, &root,
                &journal_root, &singz, &rows, &publication.expected.catalog, cancel)?;
            report.uploaded += outcome.uploaded;
            report.unchanged += outcome.unchanged;
            report.trashed += outcome.trashed;
            if let Some(warning) = outcome.eligibility_warning { report.warnings.push(warning); }
        }
        capturing(None);
        return Ok(report);
    }
    let before_retirement = local_operations.snapshot(&root)?;
    let mut retirement = crate::drive_retire_transaction::run_authorized(remote,
        &retirement_root, &binding, &local_operations, &before_retirement, cancel, progress)?;
    for retired in &retirement.retired {
        crate::drive_empty::retire_verified(&journal_root, &retired.source)?;
    }
    if retirement.changed || retirement.follow_up {
        capturing(None);
        return Ok(Report { projects: initial.len(), follow_up: true,
            skipped: initial.iter().map(|name| root.join(name)).collect(),
            warnings: retirement.blocked, ..Default::default() });
    }
    // Retirement acknowledges exact ledger references and therefore changes
    // the operation epoch. Only this refreshed guard can fence later cleanup.
    let operation_guard = local_operations.snapshot(&root)?;
    if retirement.made_request { remote_top = remote.children(&singz, cancel)?; }
    let retired_ids = retirement.retired.iter().map(|record| record.source.folder.entry.id.as_str())
        .collect::<BTreeSet<_>>();
    for restored in remote_top.iter().filter(|entry| retired_ids.contains(entry.id.as_str())) {
        retirement.protected_names.insert(restored.name.clone());
        retirement.blocked.push(format!(
            "{}: a previously retired folder was restored; preserved pending explicit reconciliation",
            restored.name));
    }
    // A pending retirement precedes adoption and ordinary orphan cleanup.
    // End this pass after a committed effect: the service explicitly schedules
    // a fresh continuation instead of overwriting its catalog from old facts.
    let empty = crate::drive_empty::run(remote, &root, &journal_root, &singz,
        &remote_top, cancel, progress, capturing)?;
    for publication in &empty.publications {
        remember_publication(remote, &retirement_root, &binding, publication, cancel)?;
    }
    if empty.changed {
        capturing(None);
        let current = drive_snapshot::scan(&root, cancel)?;
        let mut skipped = empty.deferred.into_iter().collect::<BTreeSet<_>>();
        skipped.extend(initial.iter().chain(current.iter()).map(|name| root.join(name))
            .filter(|path| !empty.synced.contains_key(path)));
        return Ok(Report {
            uploaded: empty.uploaded, unchanged: empty.unchanged,
            projects: current.len(), skipped: skipped.into_iter().collect(),
            synced: empty.synced, follow_up: true, ..Default::default()
        });
    }
    // This guard intentionally precedes adoption. Adopting a single phone song
    // must not authorize removing the rest of an unavailable local library.
    ensure!(
        !initial.is_empty()
            || !remote_top
                .iter()
                .any(|f| f.mime_type.as_deref() == Some(FOLDER) && !drive_plan::is_published(f)),
        "The library looks empty; nothing was synced and Drive was left untouched"
    );
    let adoption = crate::drive_adopt::adopt(remote, &root, &mut remote_top, cancel, progress)?;
    let dirs = drive_snapshot::scan(&root, cancel)?;
    let local_names = drive_snapshot::directory_names(&root, cancel)?;
    let protected = local_names.iter().cloned()
        .chain(retirement.protected_names.iter().cloned()).collect::<BTreeSet<_>>()
        .into_iter().collect::<Vec<_>>();
    let mut folders = BTreeMap::new();
    for entry in &remote_top {
        if entry.mime_type.as_deref() != Some(FOLDER) || drive_plan::is_published(entry) {
            continue;
        }
        ensure!(
            drive_plan::plain_name(&entry.name)
                && folders.insert(entry.name.clone(), entry.clone()).is_none(),
            "Drive has ambiguous project folders; sync refused"
        );
    }
    let ids = dirs
        .iter()
        .filter_map(|name| folders.get(name).map(|f| f.id.clone()))
        .collect::<Vec<_>>();
    let children = remote.children_of(&ids, cancel)?;
    let mut stems_folders = BTreeMap::new();
    for (id, items) in &children {
        let stems = items
            .iter()
            .filter(|f| f.name == "stems" && f.mime_type.as_deref() == Some(FOLDER))
            .collect::<Vec<_>>();
        ensure!(
            stems.len() <= 1,
            "Drive has ambiguous stems folders; sync refused"
        );
        if let Some(stems) = stems.first() {
            stems_folders.insert(id.clone(), stems.id.clone());
        }
    }
    let stem_ids = stems_folders.values().cloned().collect::<Vec<_>>();
    let stem_children = remote.children_of(&stem_ids, cancel)?;
    fs::create_dir_all(temporary_root)?;
    let spool = Spool(temporary_root.join(format!("sync-{}", crate::drive_http::random_id()?)));
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(&spool.0)?;
    let mut report = Report {
        unchanged: empty.unchanged,
        projects: dirs.len(),
        adopted: adoption.adopted,
        warnings: adoption.warnings.into_iter().chain(retirement.blocked).collect(),
        skipped: empty.deferred,
        synced: empty.synced,
        ..Default::default()
    };
    let catalog_cache = crate::drive_publication::CatalogCache::new(config_dir, &binding);
    let (listed_catalog, cache_healthy) = crate::drive_publication::read_catalog_listed(
        remote, &singz, &remote_top, &catalog_cache, &spool.0, cancel)?;
    let mut catalog = Vec::<Value>::new();
    let mut ordinary_rows = BTreeMap::new();
    let mut publications = Vec::new();
    for (index, name) in dirs.iter().enumerate() {
        ensure!(!cancel(), "Drive sync cancelled");
        if let Some(row) = empty.rows.get(name) {
            // The dedicated transaction has verified this audio-free row.
            // Retained local media never enters the generic upload planner.
            catalog.push(row.clone());
            continue;
        }
        progress(
            format!("Syncing {name}…"),
            index as f32 / dirs.len().max(1) as f32,
        );
        capturing(Some(root.join(name)));
        let mut capture = match drive_snapshot::capture_with_config(&root, name, &spool.0, config_dir, cancel) {
            Ok(capture) => capture,
            Err(error) => {
                capturing(None);
                if cancel() || crate::directory_identity::is_retry(&error) {
                    return Err(error);
                }
                report.warnings.push(format!(
                    "{name}: {error:#}; left on Drive for the next sync"
                ));
                report.skipped.push(root.join(name));
                continue;
            }
        };
        report.warnings.append(&mut capture.warnings);
        let folder = folders.get(name);
        let stems_id = folder.and_then(|f| stems_folders.get(&f.id));
        let theirs = RemoteProject {
            folder_id: folder.map(|f| f.id.clone()),
            stems_id: stems_id.cloned(),
            top: folder
                .and_then(|f| children.get(&f.id))
                .map_or_else(Vec::new, |v| file_children(v)),
            stems: stems_id
                .and_then(|id| stem_children.get(id))
                .map_or_else(Vec::new, |v| file_children(v)),
        };
        let mut plan = drive_plan::plan_project(&capture.snapshot, &theirs)?;
        let prepared = capture.spool_uploads(&mut plan, cancel);
        capturing(None);
        if let Err(error) = prepared {
            if cancel() || crate::directory_identity::is_retry(&error) {
                return Err(error);
            }
            report.skipped.push(root.join(name));
            report.warnings.push(format!(
                "{name}: {error:#}; snapshot deferred and remote project left untouched"
            ));
            continue;
        }
        // From this point on HTTP reads private verified copies, with no
        // project lease held and no dependency on mutable paths in the library.
        crate::drive_empty::prepare_ordinary_publication(remote, &root, &journal_root,
            &singz, name, &capture.local_document, &capture.publication_capture(),
            capture.snapshot.top.iter().find(|entry| entry.name == "project.json"),
            theirs.top.iter().find(|entry| entry.name == "project.json").map(|entry| entry.id.as_str()),
            cancel)?;
        if !capture.snapshot.doc_readable {
            report.skipped.push(root.join(name));
            report.warnings.push(format!(
                "{name}: unreadable project metadata was not published"
            ));
            continue;
        }
        let admission = crate::drive_publication::DestinationAdmission {
            folder: folder.cloned(),
            stems: folder.and_then(|folder| children.get(&folder.id))
                .and_then(|rows| rows.iter().find(|entry| Some(&entry.id) == stems_id)).cloned(),
            // Admission captures the complete observed roster, including
            // retained unmanaged folders. They remain outside the managed
            // planner/ownership receipt, but are not newly foreign on resume.
            top: folder.and_then(|folder| children.get(&folder.id)).cloned()
                .unwrap_or_default(),
            stem_files: stems_id.and_then(|id| stem_children.get(id)).cloned()
                .unwrap_or_default(),
        };
        ensure!(!cancel(), "Drive sync cancelled");
        let quiet = cache_healthy.then(|| crate::drive_publication::quiet(&publication_index,
            &retirement_root, &binding, &capture, &plan, &admission, &remote_top, &listed_catalog)).transpose()?.flatten();
        let is_quiet = quiet.is_some();
        let outcome = if let Some(outcome) = quiet { outcome } else {
            let handle = crate::drive_publication::prepare(remote, &retirement_root,
                &binding, &mut capture, &mut plan, admission, cancel)?;
            crate::drive_publication::finish(remote, &handle, cancel, progress)?
        };
        report.uploaded += outcome.uploaded;
        report.unchanged += outcome.unchanged;
        report.trashed += outcome.trashed;
        if let Some(warning) = outcome.eligibility_warning {
            report.warnings.push(format!("{name}: {warning}"));
        }
        let publication = outcome.publication;
        let row = publication.expected.catalog_row.clone();
        // Each accepted captured project reaches its own durable catalog-last
        // boundary before a later local Delete/Rename may retire that lineage.
        // A crash or roster change can no longer strand an unrecorded upload.
        let rows = BTreeMap::from([(name.clone(),
            (capture.local_document.clone(), row.clone()))]);
        crate::drive_empty::acknowledge_ordinary_publication(remote, &root,
            &journal_root, &singz, &rows, &publication.expected.catalog, cancel)?;
        if !is_quiet {
            publications.push((publication.capture, publication.expected.folder,
                publication.expected.members, row.clone()));
        }
        ordinary_rows.insert(name.clone(), (capture.local_document.clone(), row.clone()));
        catalog.push(row);
        report.synced.insert(root.join(name), capture.local_document.clone());
    }
    // A root rename/delete during upload is not evidence that remote folders
    // are now unwanted. Retry the whole roster rather than reconcile stale names.
    ensure!(
        drive_snapshot::scan(&root, cancel)? == dirs
            && drive_snapshot::directory_names(&root, cancel)? == local_names,
        "Library changed during sync; retry required"
    );
    local_operations.assert_unchanged(&operation_guard)?;
    for row in &retirement.protected_rows {
        if !catalog.iter().any(|current| current["dir"] == row["dir"]) {
            catalog.push(row.clone());
        }
    }
    // Ordinary projects have already committed their own rows. Refresh the
    // catalog before library-wide pruning and preserve unknown document/row
    // fields instead of replacing metadata from an earlier root listing.
    let cleanup_observation = listed_catalog.document.clone();
    let mut current_catalog = if publications.is_empty() && report.adopted.is_empty()
        && !retirement.made_request && empty.publications.is_empty() {
        listed_catalog
    } else {
        crate::drive_publication::read_catalog(remote, &singz, &spool.0, cancel)?
    };
    let mut manifest = cleanup_manifest(&current_catalog.document, catalog.clone(),
        &retirement.protected_names)?;
    let mut checksum = format!("{:x}", Md5::digest(&manifest));
    // Catalog reads can yield to new local operations too. Recheck the full
    // namespace and operation epoch immediately before destructive cleanup.
    ensure!(drive_snapshot::scan(&root, cancel)? == dirs
        && drive_snapshot::directory_names(&root, cancel)? == local_names,
        "Library changed before Drive cleanup; retry required");
    local_operations.assert_unchanged(&operation_guard)?;
    for orphan in drive_plan::orphan_folders(&remote_top, &protected, FOLDER)? {
        progress(format!("Removing {}…", orphan.name), 0.99);
        remote.trash(&orphan.id, cancel)?;
        report.trashed += 1;
    }
    if current_catalog.metadata.as_ref().and_then(|m| m.entry.md5_checksum.as_deref())
        != Some(checksum.as_str()) {
        progress(crate::i18n::t("library.drive.updatingCatalog"), 0.995);
        // A quiet project needs only the listed observation, but cleanup is a
        // write. Reobserve after the project/orphan passes and their callbacks;
        // another writer may have published a row in the meantime.
        let fresh = crate::drive_publication::read_catalog(remote, &singz, &spool.0, cancel)?;
        for row in fresh.document["projects"].as_array().context("Invalid Drive catalog projects")? {
            let name = row["dir"].as_str().context("Invalid catalog project name")?;
            if catalog.iter().any(|planned| planned["dir"].as_str() == Some(name))
                || retirement.protected_names.contains(name) { continue; }
            let previous = crate::drive_publication::catalog_project_row(&cleanup_observation, name)?;
            if previous.as_ref() != Some(row) {
                // New rows are concurrent publication, not stale roster rows
                // we intended to prune. A changed prune candidate is a conflict.
                ensure!(previous.is_none(),
                    "A published catalog row changed during sync; cleanup deferred");
                catalog.push(row.clone());
            }
        }
        manifest = cleanup_manifest(&fresh.document, catalog, &retirement.protected_names)?;
        checksum = format!("{:x}", Md5::digest(&manifest));
        current_catalog = fresh;
        // The fresh read can yield to a local rename/delete as well.
        ensure!(drive_snapshot::scan(&root, cancel)? == dirs
            && drive_snapshot::directory_names(&root, cancel)? == local_names,
            "Library changed before Drive cleanup; retry required");
        local_operations.assert_unchanged(&operation_guard)?;
    }
    let old = current_catalog.metadata.as_ref().map(|metadata| &metadata.entry);
    let catalog_id = if old.and_then(|f| f.md5_checksum.as_deref()) != Some(checksum.as_str()) {
        remote.upload_bytes(
            &manifest,
            "catalog.json",
            &singz,
            old.map(|f| f.id.as_str()),
            "application/json",
            cancel,
        )?
    } else {
        old.context("Unchanged Drive catalog has no identity")?.id.clone()
    };
    ensure!(!cancel(), "Drive sync cancelled");
    catalog_cache.store(&manifest);
    // A prior empty journal is superseded only by this writer's durably
    // recorded nonempty intent and verified terminal document/catalog effect.
    let mut expected_catalog = old.cloned().unwrap_or_default();
    expected_catalog.id = catalog_id; expected_catalog.name = "catalog.json".into();
    expected_catalog.mime_type = None;
    expected_catalog.md5_checksum = Some(checksum); expected_catalog.size = Some(manifest.len().to_string());
    expected_catalog.parents = vec![singz.clone()];
    crate::drive_empty::acknowledge_ordinary_publication(remote, &root, &journal_root,
        &singz, &ordinary_rows, &expected_catalog, cancel)?;
    for (capture, folder, members, catalog_row) in publications {
        remember_publication(remote, &retirement_root, &binding,
            &crate::drive_retirement::PublicationPlan { capture,
                expected: crate::drive_retirement::ExpectedPublication {
                    folder, members, catalog_row, catalog: expected_catalog.clone() } }, cancel)?;
    }
    report.follow_up |= retirement.waiting_for.iter()
        .any(|name| report.synced.contains_key(&root.join(name)));
    report.skipped.retain(|path| !report.synced.contains_key(path));
    progress(
        format!(
            "Done — {} songs, {} uploaded, {} unchanged",
            report.projects, report.uploaded, report.unchanged
        ),
        1.,
    );
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn malformed_remote_capabilities_return_error_instead_of_panicking() {
        for value in [json!(7), json!("future"), json!([]), json!(true)] {
            assert!(catalog_manifest(json!({"format":2,"capabilities":value,"projects":[]}), vec![]).is_err());
        }
        let bytes = catalog_manifest(json!({"format":2,"future":"keep",
            "capabilities":{"future":9},"projects":[]}), vec![]).unwrap();
        let document: Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(document["capabilities"], json!({"future":9,"adopt":1}));
        assert_eq!(document["future"], "keep");
        assert!(catalog_manifest(json!({"format":2,"projects":[]}), vec![]).is_ok());
    }
}

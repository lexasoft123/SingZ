//! Full-library writer reconciliation against actual Drive listings.
use crate::{
    drive_plan::{self, Location, RemoteEntry, RemoteProject},
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
pub fn run(
    remote: &Remote,
    root: &Path,
    temporary_root: &Path,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
    capturing: &impl Fn(Option<PathBuf>),
) -> Result<Report> {
    ensure!(!cancel(), "Drive sync cancelled");
    let root = root.canonicalize()?;
    let initial = drive_snapshot::scan(&root, cancel)?;
    let singz = remote.folder("SingZ", None, cancel)?;
    let mut remote_top = remote.children(&singz, cancel)?;
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
    let protected = drive_snapshot::directory_names(&root, cancel)?;
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
        projects: dirs.len(),
        adopted: adoption.adopted,
        warnings: adoption.warnings,
        ..Default::default()
    };
    let mut catalog = Vec::<Value>::new();
    for (index, name) in dirs.iter().enumerate() {
        ensure!(!cancel(), "Drive sync cancelled");
        progress(
            format!("Syncing {name}…"),
            index as f32 / dirs.len().max(1) as f32,
        );
        capturing(Some(root.join(name)));
        let mut capture = match drive_snapshot::capture(&root, name, &spool.0, cancel) {
            Ok(capture) => capture,
            Err(error) => {
                capturing(None);
                if cancel() {
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
            if cancel() {
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
        report.unchanged += plan.unchanged;
        let mut fresh = BTreeMap::new();
        if !plan.upload.is_empty() || !plan.trash.is_empty() {
            let folder_id = match &theirs.folder_id {
                Some(id) => id.clone(),
                None => remote.folder(name, Some(&singz), cancel)?,
            };
            let stems_id = if plan.upload.iter().any(|s| s.where_ == Location::Stems) {
                Some(match &theirs.stems_id {
                    Some(id) => id.clone(),
                    None => remote.folder("stems", Some(&folder_id), cancel)?,
                })
            } else {
                theirs.stems_id.clone()
            };
            for step in &plan.upload {
                progress(
                    format!("Uploading {name}/{}…", step.name),
                    (index as f32 + 0.5) / dirs.len().max(1) as f32,
                );
                let parent = if step.where_ == Location::Top {
                    &folder_id
                } else {
                    stems_id
                        .as_ref()
                        .context("Missing Drive stems destination")?
                };
                let id = remote.upload_file(
                    &step.path,
                    &step.name,
                    parent,
                    step.existing_id.as_deref(),
                    &step.mime,
                    cancel,
                )?;
                if step.where_ == Location::Top {
                    fresh.insert(step.name.clone(), id);
                }
                report.uploaded += 1;
            }
            for gone in &plan.trash {
                progress(
                    format!("Removing {name}/{}…", gone.entry.name),
                    (index as f32 + 0.75) / dirs.len().max(1) as f32,
                );
                remote.trash(&gone.entry.id, cancel)?;
                report.trashed += 1;
            }
        }
        if capture.snapshot.doc_readable {
            let files=plan.rows.iter().map(|row|{let id=fresh.get(&row.name).or(row.id.as_ref()).context("Drive catalog payload has no published ID")?;Ok(json!({"id":id,"name":row.name,"size":row.size,"md5Checksum":row.md5_checksum}))}).collect::<Result<Vec<_>>>()?;
            catalog.push(json!({"dir":name,"files":files}));
            report
                .synced
                .insert(root.join(name), capture.local_document.clone());
        } else {
            report.skipped.push(root.join(name));
            report.warnings.push(format!(
                "{name}: unreadable project metadata was not added to the catalog"
            ));
        }
    }
    // A root rename/delete during upload is not evidence that remote folders
    // are now unwanted. Retry the whole roster rather than reconcile stale names.
    ensure!(
        drive_snapshot::scan(&root, cancel)? == dirs
            && drive_snapshot::directory_names(&root, cancel)? == protected,
        "Library changed during sync; retry required"
    );
    for orphan in drive_plan::orphan_folders(&remote_top, &protected, FOLDER)? {
        progress(format!("Removing {}…", orphan.name), 0.99);
        remote.trash(&orphan.id, cancel)?;
        report.trashed += 1;
    }
    let manifest =
        serde_json::to_vec(&json!({"format":2,"capabilities":{"adopt":1},"projects":catalog}))?;
    let checksum = format!("{:x}", Md5::digest(&manifest));
    let catalogs = remote_top
        .iter()
        .filter(|f| f.name == "catalog.json" && f.mime_type.as_deref() != Some(FOLDER))
        .collect::<Vec<_>>();
    ensure!(
        catalogs.len() <= 1,
        "Drive has ambiguous catalogs; sync refused"
    );
    let old = catalogs.first();
    if old.and_then(|f| f.md5_checksum.as_deref()) != Some(checksum.as_str()) {
        progress("Updating catalog…".into(), 0.995);
        remote.upload_bytes(
            &manifest,
            "catalog.json",
            &singz,
            old.map(|f| f.id.as_str()),
            "application/json",
            cancel,
        )?;
    }
    ensure!(!cancel(), "Drive sync cancelled");
    progress(
        format!(
            "Done — {} songs, {} uploaded, {} unchanged",
            report.projects, report.uploaded, report.unchanged
        ),
        1.,
    );
    Ok(report)
}

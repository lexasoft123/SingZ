//! Private performance hints, never project documents or publication authority.
use crate::directory_identity::DirectoryIdentity;
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, BTreeSet},
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
};

pub(crate) const LIMIT: u64 = 2 * 1024 * 1024;
const ENTRY_LIMIT: usize = 4096;
#[derive(Serialize, Deserialize)]
#[serde(deny_unknown_fields)]
struct Record {
    version: u32,
    project: PathBuf,
    identity: DirectoryIdentity,
    entries: BTreeMap<String, Value>,
}
pub(crate) struct Cache {
    path: PathBuf,
    record: Record,
    original: BTreeMap<String, Value>,
    seen: BTreeSet<String>,
    moved: bool,
}
fn ordinary_dir(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Unsafe hash cache directory"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "Hash cache directory must be private"
        );
    }
    Ok(())
}
fn ordinary_config(path: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Unsafe configuration directory"
    );
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(_) => ordinary_dir(path),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
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
            match builder.create(path) {
                Ok(()) => {}
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {}
                Err(error) => return Err(error.into()),
            }
            ordinary_dir(path)
        }
        Err(error) => Err(error.into()),
    }
}
fn bounded(path: &Path) -> Result<Vec<u8>> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= LIMIT,
        "Unsafe or oversized hash cache file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::{MetadataExt, PermissionsExt};
        ensure!(
            meta.nlink() == 1 && meta.permissions().mode() & 0o077 == 0,
            "Hash cache file must be private and unlinked"
        );
    }
    let mut bytes = Vec::new();
    File::open(path)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= LIMIT, "Hash cache exceeds limit");
    Ok(bytes)
}
fn read(path: &Path) -> Result<Record> {
    let record: Record = serde_json::from_slice(&bounded(path)?)?;
    ensure!(
        record.version == 1 && record.entries.len() <= ENTRY_LIMIT && record.project.is_absolute(),
        "Invalid hash cache record"
    );
    for (name, entry) in &record.entries {
        let (_, file) = name
            .split_once('/')
            .filter(|(kind, _)| matches!(*kind, "stems" | "source"))
            .context("Invalid hash cache key")?;
        ensure!(
            crate::drive_plan::plain_name(file)
                && entry["md5"]
                    .as_str()
                    .is_some_and(crate::drive_snapshot::valid_md5)
                && entry["size"].as_u64().is_some()
                && entry["mtimeMs"]
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v >= 0.),
            "Invalid hash cache entry"
        );
    }
    Ok(record)
}
fn storage(config: &Path) -> PathBuf {
    config.join("gdrive/hash-cache")
}
#[cfg(test)]
thread_local! {
    pub(crate) static WARNINGS: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
fn warn(error: anyhow::Error) {
    crate::diagnostics::event(
        "sync",
        format!("Local audio hash cache ignored: {error:#}"),
        crate::diagnostics::Level::Warn,
    );
    #[cfg(test)]
    WARNINGS.with(|warnings| warnings.set(warnings.get() + 1));
}
impl Cache {
    pub(crate) fn load(config: &Path, project: &Path, identity: DirectoryIdentity) -> Result<Self> {
        let key = if identity.persistent_eligible() {
            crate::project_store::fingerprint(
                &serde_json::to_vec(&identity.legacy_key())
                    .expect("Directory identity contains only serializable scalar fields"),
            )
        } else {
            crate::project_store::fingerprint(project.as_os_str().as_encoded_bytes())
        };
        let directory = storage(config);
        let path = directory.join(format!("{key}.json"));
        let mut record = Record {
            version: 1,
            project: project.into(),
            identity,
            entries: BTreeMap::new(),
        };
        let loaded = (|| -> Result<Option<Record>> {
            // dev+ino can be recycled after deletion. Without birth identity,
            // neither old path-keyed hints nor new persistent hints are safe.
            if !record.identity.persistent_eligible() {
                return Ok(None);
            }
            if fs::symlink_metadata(config).is_ok() {
                ordinary_config(config)?;
            } else {
                private_dir(config)?;
            }
            private_dir(&config.join("gdrive"))?;
            private_dir(&directory)?;
            match fs::symlink_metadata(&path) {
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(None),
                Err(error) => Err(error.into()),
                Ok(_) => {
                    let old = read(&path)?;
                    ensure!(
                        old.identity.matches_live(&record.identity)?,
                        "Hash cache directory identity changed"
                    );
                    // Identity keys survive a rename; path keys must match exactly.
                    ensure!(
                        record.identity.persistent_eligible() || old.project == project,
                        "Hash cache path changed"
                    );
                    Ok(Some(old))
                }
            }
        })();
        let mut moved = false;
        match loaded {
            Ok(Some(old)) => {
                moved = old.project != project || old.identity != record.identity;
                record.entries = old.entries;
            }
            Ok(None) => {}
            // Advisory hints never defer sync, including an unverifiable generation.
            Err(error) if crate::directory_identity::is_retry(&error) => {},
            Err(error) => warn(error),
        }
        let original = record.entries.clone();
        Ok(Self {
            path,
            record,
            original,
            seen: BTreeSet::new(),
            moved,
        })
    }
    pub(crate) fn get(&self, key: &str) -> &Value {
        self.record.entries.get(key).unwrap_or(&Value::Null)
    }
    pub(crate) fn remember(&mut self, key: String, value: Value) {
        self.seen.insert(key.clone());
        self.record.entries.insert(key, value);
    }
    pub(crate) fn save(mut self) {
        if !self.record.identity.persistent_eligible() {
            return;
        }
        self.record.entries.retain(|key, _| self.seen.contains(key));
        if self.record.entries == self.original && !self.moved {
            return;
        }
        let result = (|| -> Result<()> {
            ensure!(
                self.record.entries.len() <= ENTRY_LIMIT,
                "Too many hash cache entries"
            );
            let bytes = serde_json::to_vec(&self.record)?;
            ensure!(bytes.len() as u64 <= LIMIT, "Hash cache exceeds limit");
            let parent = self.path.parent().context("Hash cache has no parent")?;
            let drive = parent
                .parent()
                .context("Hash cache has no Drive directory")?;
            ordinary_config(
                drive
                    .parent()
                    .context("Hash cache has no configuration directory")?,
            )?;
            ordinary_dir(drive)?;
            ordinary_dir(parent)?;
            // Refuse to replace unsafe existing state; it remains only a hint.
            match fs::symlink_metadata(&self.path) {
                Ok(_) => {
                    bounded(&self.path)?;
                }
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
                Err(error) => return Err(error.into()),
            }
            let temporary = parent.join(format!(".hash-{}.part", crate::drive_http::random_id()?));
            let result = (|| -> Result<()> {
                let mut file = crate::drive_http::private_file(&temporary)?;
                file.write_all(&bytes)?;
                file.sync_all()?;
                drop(file);
                crate::project_store::replace(&temporary, &self.path)?;
                #[cfg(not(windows))]
                File::open(parent)?.sync_all()?;
                Ok(())
            })();
            let _ = fs::remove_file(temporary);
            result
        })();
        if let Err(error) = result {
            warn(error);
        }
    }
}
/// Prune only positively absent directories in this library. Unsafe state is
/// advisory too: it cannot block synchronization or authorize project changes.
pub(crate) fn prune(config: &Path, root: &Path) {
    let result = (|| -> Result<()> {
        let directory = storage(config);
        if !config.join("gdrive").exists() {
            return Ok(());
        }
        ordinary_config(config)?;
        ordinary_dir(&config.join("gdrive"))?;
        match fs::symlink_metadata(&directory) {
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(error) => return Err(error.into()),
            Ok(_) => ordinary_dir(&directory)?,
        }
        for item in fs::read_dir(&directory)? {
            let item = match item {
                Ok(item) => item,
                Err(error) => {
                    warn(error.into());
                    continue;
                }
            };
            let path = item.path();
            let temporary = item.file_name().to_str().is_some_and(|name| {
                name.strip_prefix(".hash-")
                    .and_then(|name| name.strip_suffix(".part"))
                    .is_some_and(|id| {
                        id.len() == 48 && id.bytes().all(|byte| byte.is_ascii_hexdigit())
                    })
            });
            if temporary {
                // Other projects may be writing here. Sweep only old ordinary
                // private files, leaving recent writers and unsafe links alone.
                let cleanup = (|| -> Result<()> {
                    let meta = fs::symlink_metadata(&path)?;
                    if meta
                        .modified()?
                        .elapsed()
                        .is_ok_and(|age| age >= std::time::Duration::from_secs(3600))
                    {
                        bounded(&path)?;
                        fs::remove_file(&path)?;
                    }
                    Ok(())
                })();
                if let Err(error) = cleanup {
                    warn(error);
                }
                continue;
            }
            if path.extension().is_none_or(|ext| ext != "json") {
                continue;
            }
            let record = match read(&item.path()) {
                Ok(record) => record,
                Err(error) => {
                    warn(error);
                    continue;
                }
            };
            if record.project.parent() != Some(root) {
                continue;
            }
            if matches!(fs::symlink_metadata(&record.project), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
            {
                if let Err(error) = fs::remove_file(item.path()) {
                    warn(error.into());
                }
            }
        }
        Ok(())
    })();
    if let Err(error) = result {
        warn(error);
    }
}

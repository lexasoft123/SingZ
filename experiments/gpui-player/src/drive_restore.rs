//! Read-only Drive browser and verified versioned desktop cache.
//! This module never creates/patches/trashes remote files or joins the writer
//! library. A remote revision is published only after every declared payload
//! verifies; cached local edits are preserved in their original directory.
use crate::{
    drive_adopt,
    drive_plan::{self, RemoteEntry},
    drive_remote::{FOLDER, Remote},
    drive_snapshot,
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::{SystemTime, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;

const JSON_LIMIT: u64 = 16 * 1024 * 1024;
const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
const MARKER: &str = ".singz-drive-cache.json";
const CACHE_FORMAT: u32 = 1;

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Row {
    pub id: String,
    pub name: String,
    pub song_path: Option<PathBuf>,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Member {
    path: String,
    id: String,
    md5: String,
    size: u64,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
struct Receipt {
    format: u32,
    id: String,
    name: String,
    revision: String,
    created_ms: u64,
    files: Vec<Member>,
}
trait Reader {
    fn list(&self, query: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>>;
    fn children(&self, id: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>>;
    fn download(
        &self,
        file: &RemoteEntry,
        path: &Path,
        limit: u64,
        cancel: &impl Fn() -> bool,
        progress: &impl Fn(String, f32),
    ) -> Result<()>;
}
impl Reader for Remote {
    fn list(&self, q: &str, c: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        Remote::list(self, q, c)
    }
    fn children(&self, id: &str, c: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        Remote::children(self, id, c)
    }
    fn download(
        &self,
        file: &RemoteEntry,
        path: &Path,
        limit: u64,
        c: &impl Fn() -> bool,
        progress: &impl Fn(String, f32),
    ) -> Result<()> {
        drive_adopt::restore_download(self, file, path, limit, c, progress)?;
        Ok(())
    }
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Drive download cancelled");
    Ok(())
}
fn key(name: &str) -> String {
    name.nfc().collect::<String>().to_lowercase()
}
fn entries(entries: &[RemoteEntry]) -> Result<()> {
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    for file in entries {
        crate::drive_remote::validate_id(&file.id)?;
        drive_plan::validate_portable_name(&file.name)?;
        ensure!(
            names.insert(key(&file.name)) && ids.insert(&file.id),
            "Ambiguous Drive member names or identities"
        );
    }
    Ok(())
}
fn file_hash(file: &RemoteEntry, limit: u64) -> Result<(String, u64)> {
    ensure!(
        file.mime_type.as_deref() != Some(FOLDER),
        "A folder is not a downloadable payload"
    );
    let md5 = file
        .md5_checksum
        .as_ref()
        .filter(|h| drive_snapshot::valid_md5(h))
        .context("Drive member has no valid checksum")?;
    let size = file
        .size
        .as_deref()
        .context("Drive member has no size")?
        .parse::<u64>()?;
    ensure!(size <= limit, "Drive member exceeds supported size");
    Ok((md5.clone(), size))
}
fn project_folders(remote: &impl Reader, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
    check(cancel)?;
    let roots = remote.list(
        &format!("name='SingZ' and mimeType='{FOLDER}' and trashed=false"),
        cancel,
    )?;
    let roots = roots
        .into_iter()
        .filter(|e| {
            e.name == "SingZ"
                && e.mime_type.as_deref() == Some(FOLDER)
                && !drive_plan::is_published(e)
        })
        .collect::<Vec<_>>();
    ensure!(roots.len() <= 1, "Drive has ambiguous SingZ roots");
    let Some(root) = roots.first() else {
        return Ok(Vec::new());
    };
    let folders = remote
        .children(&root.id, cancel)?
        .into_iter()
        .filter(|e| e.mime_type.as_deref() == Some(FOLDER))
        .collect::<Vec<_>>();
    entries(&folders)?;
    for folder in &folders {
        ensure!(
            folder.parents.is_empty() || folder.parents.contains(&root.id),
            "Drive project belongs to another root"
        );
    }
    Ok(folders)
}
fn project_document(files: &[RemoteEntry]) -> Result<&RemoteEntry> {
    entries(files)?;
    let docs = files
        .iter()
        .filter(|e| e.name == "project.json" && e.mime_type.as_deref() != Some(FOLDER))
        .collect::<Vec<_>>();
    ensure!(docs.len() == 1, "Drive project has no unique project.json");
    file_hash(docs[0], JSON_LIMIT)?;
    Ok(docs[0])
}
pub fn list(remote: &Remote, cache_root: &Path, cancel: &impl Fn() -> bool) -> Result<Vec<Row>> {
    list_with(remote, cache_root, cancel)
}
fn list_with(
    remote: &impl Reader,
    cache_root: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<Vec<Row>> {
    let local = cached(cache_root)?
        .into_iter()
        .map(|r| (r.id.clone(), r))
        .collect::<HashMap<_, _>>();
    let mut rows = Vec::new();
    for folder in project_folders(remote, cancel)? {
        check(cancel)?;
        let files = remote.children(&folder.id, cancel)?;
        if !files.iter().any(|e| e.name == "project.json") {
            continue;
        }
        let document = project_document(&files)?;
        let song_path = local
            .get(&folder.id)
            .and_then(|r| r.song_path.clone())
            .filter(|path| cached_document_matches(path, document).unwrap_or(false));
        rows.push(Row {
            id: folder.id.clone(),
            name: folder.name,
            song_path,
        });
    }
    rows.sort_by(|a, b| {
        key(&a.name)
            .cmp(&key(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rows)
}
fn read_json(path: &Path) -> Result<Value> {
    let stat = fs::symlink_metadata(path)?;
    ensure!(
        stat.is_file() && !stat.file_type().is_symlink() && stat.len() <= JSON_LIMIT,
        "Cache metadata must be an ordinary bounded file"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let mut bytes = Vec::new();
    options
        .open(path)?
        .take(JSON_LIMIT + 1)
        .read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= JSON_LIMIT,
        "Cache metadata exceeds limit"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn safe_relative(path: &str) -> Result<PathBuf> {
    if let Some(name) = path.strip_prefix("stems/") {
        drive_plan::validate_portable_name(name)?;
        Ok(PathBuf::from("stems").join(name))
    } else {
        drive_plan::validate_portable_name(path)?;
        Ok(PathBuf::from(path))
    }
}
fn receipt(path: &Path) -> Result<Receipt> {
    let receipt: Receipt = serde_json::from_value(read_json(&path.join(MARKER))?)?;
    ensure!(
        receipt.format == CACHE_FORMAT && receipt.files.len() <= 1024 && !receipt.files.is_empty(),
        "Unsupported Drive cache receipt"
    );
    crate::drive_remote::validate_id(&receipt.id)?;
    drive_plan::validate_portable_name(&receipt.name)?;
    let mut names = HashSet::new();
    for file in &receipt.files {
        safe_relative(&file.path)?;
        ensure!(
            file.path != MARKER
                && names.insert(key(&file.path))
                && drive_snapshot::valid_md5(&file.md5)
                && file.size <= FILE_LIMIT,
            "Invalid Drive cache member receipt"
        );
    }
    ensure!(
        names.contains("project.json"),
        "Cache has no project receipt"
    );
    ensure!(
        receipt.revision == crate::project_store::fingerprint(&serde_json::to_vec(&receipt.files)?),
        "Invalid cache revision receipt"
    );
    Ok(receipt)
}
fn cached_document_matches(path: &Path, remote: &RemoteEntry) -> Result<bool> {
    let guard = drive_adopt::Directory::capture(path.to_owned())?;
    let original = receipt(path)?;
    let (md5, size) = file_hash(remote, JSON_LIMIT)?;
    // Compare remote metadata against the immutable original receipt, allowing
    // a native Save to change the local document without hiding its Open action.
    let matches = original
        .files
        .iter()
        .any(|f| f.path == "project.json" && f.id == remote.id && f.md5 == md5 && f.size == size);
    guard.verify()?;
    Ok(matches)
}
fn cached_entries(cache_root: &Path) -> Result<Vec<(PathBuf, Receipt)>> {
    if !cache_root.exists() {
        return Ok(Vec::new());
    }
    let root = drive_adopt::Directory::capture(cache_root.to_owned())?;
    let mut found = Vec::new();
    for entry in fs::read_dir(cache_root)? {
        root.verify()?;
        let entry = entry?;
        // Native title editing can rename a downloaded project's directory.
        // The private verified receipt, not its generated initial name, owns
        // cache identity. Hidden resumable stages and lease files stay absent.
        if entry.file_name().to_string_lossy().starts_with('.') {
            continue;
        }
        if drive_adopt::Directory::capture(entry.path()).is_err() {
            continue;
        }
        if let Ok(marker) = receipt(&entry.path()) {
            if fs::symlink_metadata(entry.path().join("project.json"))
                .is_ok_and(|m| m.is_file() && !m.file_type().is_symlink())
            {
                found.push((entry.path(), marker));
            }
        }
    }
    root.verify()?;
    Ok(found)
}
pub fn cached(cache_root: &Path) -> Result<Vec<Row>> {
    let mut latest = BTreeMap::<String, (u64, PathBuf, Receipt)>::new();
    for (path, mut receipt) in cached_entries(cache_root)? {
        let Ok(project) = cached_project(&path) else {
            continue;
        };
        receipt.name = project.name;
        if latest
            .get(&receipt.id)
            .is_none_or(|(time, _, _)| *time < receipt.created_ms)
        {
            latest.insert(receipt.id.clone(), (receipt.created_ms, path, receipt));
        }
    }
    let mut rows = latest
        .into_values()
        .map(|(_, path, r)| Row {
            id: r.id,
            name: r.name,
            song_path: Some(path),
        })
        .collect::<Vec<_>>();
    rows.sort_by(|a, b| {
        key(&a.name)
            .cmp(&key(&b.name))
            .then_with(|| a.id.cmp(&b.id))
    });
    Ok(rows)
}
fn cached_project(path: &Path) -> Result<crate::integration::Project> {
    let guard = drive_adopt::Directory::capture(path.to_owned())?;
    for (index, entry) in fs::read_dir(path)?.enumerate() {
        ensure!(index < 1024, "Cached project has too many members");
        let entry = entry?;
        let metadata = fs::symlink_metadata(entry.path())?;
        ensure!(
            !metadata.file_type().is_symlink(),
            "Linked cached project member"
        );
    }
    let raw = read_json(&path.join("project.json"))?;
    if path.join("stems").exists() {
        drive_adopt::Directory::capture(path.join("stems"))?;
        for entry in fs::read_dir(path.join("stems"))? {
            let m = fs::symlink_metadata(entry?.path())?;
            ensure!(
                m.is_file() && !m.file_type().is_symlink(),
                "Unsafe cached stem member"
            );
        }
    }
    if let Some(custom) = raw["settings"]["custom"].as_array() {
        for lane in custom {
            let rel = crate::tracks::normalize_custom_path(
                lane["file"]
                    .as_str()
                    .context("Missing cached custom source")?,
            )
            .context("Invalid cached custom source")?;
            let source = path.join(rel);
            let m = fs::symlink_metadata(&source)?;
            ensure!(
                m.is_file() && !m.file_type().is_symlink() && source.canonicalize()? == source,
                "Unavailable cached custom source"
            );
        }
    }
    let project = crate::integration::read_project(path)?;
    guard.verify()?;
    Ok(project)
}
fn matches_files(path: &Path, files: &[Member], cancel: &impl Fn() -> bool) -> Result<bool> {
    let guard = drive_adopt::Directory::capture(path.to_owned())?;
    let mut top = HashSet::from([MARKER.to_owned()]);
    let mut stems = HashSet::new();
    for file in files {
        if let Some(name) = file.path.strip_prefix("stems/") {
            top.insert("stems".into());
            stems.insert(name.to_owned());
        } else {
            top.insert(file.path.clone());
        }
    }
    for entry in fs::read_dir(path)? {
        let entry = entry?;
        if !top.contains(&entry.file_name().to_string_lossy().into_owned()) {
            return Ok(false);
        }
    }
    if !stems.is_empty() {
        drive_adopt::Directory::capture(path.join("stems"))?;
        for entry in fs::read_dir(path.join("stems"))? {
            let entry = entry?;
            if !stems.contains(&entry.file_name().to_string_lossy().into_owned()) {
                return Ok(false);
            }
        }
    }
    for file in files {
        check(cancel)?;
        guard.verify()?;
        let relative = safe_relative(&file.path)?;
        if relative.components().count() > 1 {
            drive_adopt::Directory::capture(path.join("stems"))?;
        }
        match drive_snapshot::digest(&path.join(relative), cancel) {
            Ok(got) if got.md5 == file.md5 && got.size == file.size => {}
            _ => return Ok(false),
        }
    }
    guard.verify()?;
    Ok(true)
}
fn audio_name(name: &str) -> bool {
    Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .is_some_and(|e| {
            matches!(
                e.to_ascii_lowercase().as_str(),
                "wav" | "flac" | "mp3" | "m4a" | "aac" | "ogg" | "opus" | "aiff" | "aif"
            )
        })
}
fn declared_hash(value: &Value) -> Result<(String, u64)> {
    let md5 = value["md5"]
        .as_str()
        .filter(|v| drive_snapshot::valid_md5(v))
        .context("Project payload has no valid checksum")?;
    let size = value["size"]
        .as_u64()
        .context("Project payload has no exact byte count")?;
    ensure!(size <= FILE_LIMIT, "Project payload exceeds supported size");
    Ok((md5.to_owned(), size))
}
fn declared_payloads(doc: &Value) -> Result<BTreeMap<String, (String, u64)>> {
    ensure!(doc.is_object(), "Drive metadata is not a project");
    let version = doc
        .get("version")
        .filter(|v| !v.is_null())
        .map_or(Some(1.), Value::as_f64);
    ensure!(
        matches!(version, Some(1. | 2.)),
        "Unsupported Drive project version"
    );
    let settings = &doc["settings"];
    ensure!(
        settings.is_null() || settings.is_object(),
        "Invalid Drive project settings"
    );
    for key in ["nativeEmptyTracks", "nativeOriginalDisabled"] {
        ensure!(
            settings.get(key).is_none_or(Value::is_boolean),
            "Invalid explicit empty project flag"
        );
    }
    if settings["nativeEmptyTracks"] == true {
        ensure!(
            settings["nativeOriginalDisabled"] == true
                && settings["custom"].as_array().is_some_and(Vec::is_empty)
                && doc.get("songFile").is_none()
                && doc.get("songHash").is_none()
                && doc.get("graphHash").is_none()
                && doc["stemHashes"]
                    .as_object()
                    .is_some_and(serde_json::Map::is_empty),
            "Malformed explicitly empty Drive project"
        );
    }
    let mut wanted = BTreeMap::new();
    if let Some(stems) = doc.get("stemHashes").filter(|v| !v.is_null()) {
        let stems = stems.as_object().context("Invalid project stem hashes")?;
        ensure!(stems.len() <= 1024, "Too many declared project stems");
        for (name, hash) in stems {
            drive_plan::validate_portable_name(name)?;
            ensure!(audio_name(name), "Unsupported declared stem payload");
            wanted.insert(format!("stems/{name}"), declared_hash(hash)?);
        }
    }
    if let Some(song) = doc.get("songFile") {
        let song = song.as_str().context("Invalid original audio reference")?;
        drive_plan::validate_portable_name(song)?;
        ensure!(audio_name(song), "Unsupported original audio payload");
        match declared_hash(&doc["songHash"]) {
            Ok(hash) => {
                wanted.insert(song.into(), hash);
            }
            Err(error) if wanted.is_empty() => return Err(error),
            Err(_) => {} // Verified stems can be restored without an unavailable original.
        }
    } else {
        ensure!(
            doc.get("songHash").is_none(),
            "Original checksum has no file reference"
        );
    }
    if let Some(custom) = settings.get("custom").filter(|v| !v.is_null()) {
        let custom = custom
            .as_array()
            .context("Invalid custom track references")?;
        ensure!(
            custom.len() <= crate::tracks::MAX_ACTIVE_LANES,
            "Too many custom tracks"
        );
        let mut ids = HashSet::new();
        for lane in custom {
            let id = lane["id"]
                .as_str()
                .context("Missing custom track identity")?;
            crate::tracks::validate_custom_id(id)?;
            ensure!(ids.insert(id), "Duplicate custom track identity");
            let file = lane["file"]
                .as_str()
                .context("Missing custom track source")?;
            ensure!(
                crate::tracks::normalize_custom_path(file).is_some() && wanted.contains_key(file),
                "Custom audio is not hash-declared in stems"
            );
        }
    }
    ensure!(
        settings["nativeEmptyTracks"] == true || wanted.keys().any(|p| audio_name(p)),
        "Drive project has no declared audio or explicit empty intent"
    );
    for (name, field) in [("lyrics.json", "lyricsHash"), ("graph.json", "graphHash")] {
        if let Some(hash) = doc.get(field) {
            wanted.insert(name.into(), declared_hash(hash)?);
        }
    }
    Ok(wanted)
}
struct Stage {
    path: PathBuf,
    guard: drive_adopt::Directory,
}
// Failed/cancelled stages remain private and invisible for a verified retry.
// An external per-revision lease excludes concurrent writers while allowing
// the completed directory to move atomically on Windows.
fn cache_lease(path: &Path) -> Result<crate::file_lease::Lease> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    if let Ok(metadata) = fs::symlink_metadata(path) {
        ensure!(
            metadata.is_file() && !metadata.file_type().is_symlink(),
            "Unsafe Drive cache lease"
        );
    }
    let file = options.open(path)?;
    ensure!(file.metadata()?.is_file(), "Unsafe Drive cache lease");
    Ok(crate::file_lease::Lease::acquire(file)?)
}
fn create_private(path: &Path) -> Result<()> {
    let mut builder = fs::DirBuilder::new();
    #[cfg(unix)]
    {
        use std::os::unix::fs::DirBuilderExt;
        builder.mode(0o700);
    }
    builder.create(path)?;
    Ok(())
}
fn fetch(
    remote: &impl Reader,
    file: &RemoteEntry,
    path: &Path,
    limit: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
) -> Result<Member> {
    let (md5, size) = file_hash(file, limit)?;
    if let Ok(stat) = fs::symlink_metadata(path) {
        ensure!(
            stat.is_file() && !stat.file_type().is_symlink(),
            "Unsafe resumed download target"
        );
        if stat.len() == size {
            let got = drive_snapshot::digest(path, cancel)?;
            if got.md5 == md5 {
                return Ok(Member {
                    path: file.name.clone(),
                    id: file.id.clone(),
                    md5,
                    size,
                });
            }
        }
    }
    remote.download(file, path, limit, cancel, progress)?;
    check(cancel)?;
    let got = drive_snapshot::digest(path, cancel)?;
    ensure!(
        got.md5 == md5 && got.size == size,
        "Drive download integrity mismatch"
    );
    Ok(Member {
        path: file.name.clone(),
        id: file.id.clone(),
        md5,
        size,
    })
}
pub fn download(
    remote: &Remote,
    id: &str,
    cache_root: &Path,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
) -> Result<PathBuf> {
    download_with(remote, id, cache_root, cancel, progress)
}
fn download_with(
    remote: &impl Reader,
    id: &str,
    cache_root: &Path,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
) -> Result<PathBuf> {
    crate::drive_remote::validate_id(id)?;
    check(cancel)?;
    let folder = project_folders(remote, cancel)?
        .into_iter()
        .find(|f| f.id == id)
        .context("Drive project is no longer listed")?;
    let top = remote.children(id, cancel)?;
    let doc_file = project_document(&top)?.clone();
    for file in &top {
        ensure!(
            file.parents.is_empty() || file.parents.iter().any(|p| p == id),
            "Drive member belongs to another project"
        );
    }
    if !cache_root.exists() {
        create_private(cache_root)?;
    }
    let root = drive_adopt::Directory::capture(cache_root.to_owned())?;
    let stage_key = crate::project_store::fingerprint(
        format!("{id}:{}", doc_file.md5_checksum.as_deref().unwrap()).as_bytes(),
    );
    let _lease = cache_lease(&cache_root.join(format!(".download-{stage_key}.lock")))
        .context("This Drive revision is already downloading")?;
    root.verify()?;
    let path = cache_root.join(format!(".singz-download-{stage_key}"));
    if !path.exists() {
        create_private(&path)?;
    }
    let stage = Stage {
        guard: drive_adopt::Directory::capture(path.clone())?,
        path,
    };
    let live = || cancel() || root.verify().is_err() || stage.guard.verify().is_err();
    let mut files = vec![fetch(
        remote,
        &doc_file,
        &stage.path.join("project.json"),
        JSON_LIMIT,
        &live,
        progress,
    )?];
    let doc = read_json(&stage.path.join("project.json"))?;
    let mut wanted = declared_payloads(&doc)?;
    if wanted.keys().any(|p| p.starts_with("stems/")) {
        if let Some(song) = doc["songFile"].as_str() {
            if !top
                .iter()
                .any(|file| file.name == song && file.mime_type.as_deref() != Some(FOLDER))
            {
                wanted.remove(song);
            }
        }
    }
    let stems = top
        .iter()
        .filter(|e| e.name == "stems" && e.mime_type.as_deref() == Some(FOLDER))
        .collect::<Vec<_>>();
    ensure!(stems.len() <= 1, "Ambiguous Drive stems folders");
    let stem_files = if wanted.keys().any(|p| p.starts_with("stems/")) {
        let stem = stems.first().context("Declared stems folder is missing")?;
        let entries = remote.children(&stem.id, &live)?;
        self::entries(&entries)?;
        for file in &entries {
            ensure!(
                file.parents.is_empty() || file.parents.contains(&stem.id),
                "Drive stem belongs to another folder"
            );
        }
        if !stage.path.join("stems").exists() {
            create_private(&stage.path.join("stems"))?;
        }
        drive_adopt::Directory::capture(stage.path.join("stems"))?;
        entries
    } else {
        Vec::new()
    };
    let mut allowed_top = HashSet::from(["project.json".to_owned(), "stems".to_owned()]);
    // A retry retains every already verified declared top-level payload, just
    // as it retains declared stems. Unknown partials still cannot be published.
    allowed_top.extend(
        wanted
            .keys()
            .filter(|name| !name.starts_with("stems/"))
            .cloned(),
    );
    stage.guard.verify()?;
    for entry in fs::read_dir(&stage.path)? {
        let entry = entry?;
        if !allowed_top.contains(&entry.file_name().to_string_lossy().into_owned()) {
            drive_adopt::remove_member(&entry.path())?;
        }
    }
    if stage.path.join("stems").exists() {
        drive_adopt::Directory::capture(stage.path.join("stems"))?;
        for entry in fs::read_dir(stage.path.join("stems"))? {
            let entry = entry?;
            let rel = format!("stems/{}", entry.file_name().to_string_lossy());
            if !wanted.contains_key(&rel) {
                drive_adopt::remove_member(&entry.path())?;
            }
        }
        if !wanted.keys().any(|p| p.starts_with("stems/")) {
            fs::remove_dir(stage.path.join("stems"))?;
        }
    }
    for (index, (relative, (md5, size))) in wanted.iter().enumerate() {
        check(&live)?;
        let relative_path = safe_relative(relative)?;
        let source = if let Some(name) = relative.strip_prefix("stems/") {
            stem_files.iter().find(|e| e.name == name)
        } else {
            top.iter().find(|e| e.name == *relative)
        }
        .context("Declared Drive payload is missing")?;
        let metadata = relative.ends_with(".json");
        let limit = if metadata { JSON_LIMIT } else { FILE_LIMIT };
        ensure!(
            file_hash(source, limit)? == (md5.clone(), *size),
            "Drive listing and project payload checksums disagree"
        );
        progress(
            format!("Downloading {}/{}", folder.name, relative),
            index as f32 / (wanted.len() + 1) as f32,
        );
        let mut member = fetch(
            remote,
            source,
            &stage.path.join(relative_path),
            limit,
            &live,
            progress,
        )?;
        member.path = relative.clone();
        files.push(member);
    }
    if doc.get("lyricsHash").is_some() {
        let lyrics = read_json(&stage.path.join("lyrics.json"))?;
        ensure!(lyrics.is_object(), "Invalid downloaded lyrics document");
    }
    if let Some(graph) = doc.get("graphHash") {
        let format = graph["format"]
            .as_u64()
            .filter(|n| *n > 0 && *n <= u32::MAX as u64)
            .context("Invalid downloaded graph format")?;
        crate::drive_graph::validate(&fs::read(stage.path.join("graph.json"))?, format)?;
    }
    // The existing native project reader must accept the verified document;
    // this catches unsupported graph playback and nonplayable unknown stems.
    let got = files
        .iter()
        .map(|f| {
            (
                f.path.clone(),
                drive_snapshot::Fingerprint {
                    md5: f.md5.clone(),
                    size: f.size,
                },
            )
        })
        .collect();
    drive_adopt::stamp_mtimes(&stage.path, &doc, &got);
    check(&live)?;
    crate::integration::read_project(&stage.path)?;
    let mut payload_ids = HashSet::new();
    ensure!(
        files.iter().all(|f| payload_ids.insert(&f.id)),
        "Drive payload identity aliases another member"
    );
    files.sort_by(|a, b| a.path.cmp(&b.path));
    let revision = crate::project_store::fingerprint(&serde_json::to_vec(&files)?);
    ensure!(
        matches_files(&stage.path, &files, &live)?,
        "Staged cache contains changed or undeclared payloads"
    );
    let mut verified_reuse = HashSet::new();
    for (path, old) in cached_entries(cache_root)? {
        if old.id == id
            && old.revision == revision
            && matches_files(&path, &old.files, &live).unwrap_or(false)
        {
            verified_reuse.insert((path, old.created_ms));
        }
    }
    // Different remote revisions have independent resumable transfers, but a
    // short cache-wide lease serializes final publication and logical order.
    // HTTP, payload hashing, decoding and native admission all finish first;
    // the per-revision lease continues to own the prepared private stage.
    check(&live)?;
    let _publication = cache_lease(&cache_root.join(".publish.lock"))
        .context("Another Drive cache publication is in progress")?;
    check(&live)?;
    let previous_entries = cached_entries(cache_root)?;
    let previous = previous_entries
        .iter()
        .filter(|(_, r)| r.id == id)
        .map(|(_, r)| r.created_ms)
        .max()
        .unwrap_or(0);
    let latest_count = previous_entries
        .iter()
        .filter(|(_, r)| r.id == id && r.created_ms == previous)
        .count();
    for (path, old) in previous_entries {
        // Reopening an older revision (including a remote rollback) must not
        // leave cached() pointing at a later different project. Tied historical
        // receipts also receive a new unique generation instead of guessing.
        if latest_count == 1
            && old.id == id
            && old.created_ms == previous
            && old.revision == revision
            && verified_reuse.contains(&(path.clone(), old.created_ms))
        {
            drive_adopt::remove_stage(&stage.guard);
            progress("Already downloaded".into(), 1.);
            return Ok(path);
        }
    }
    let created_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)?
        .as_millis()
        .min(u64::MAX as u128) as u64;
    let created_ms = created_ms.max(
        previous
            .checked_add(1)
            .context("Cache generation exhausted")?,
    );
    let receipt = Receipt {
        format: CACHE_FORMAT,
        id: id.into(),
        name: folder.name,
        revision,
        created_ms,
        files,
    };
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    check(&live)?;
    let mut marker = options.open(stage.path.join(MARKER))?;
    marker.write_all(&serde_json::to_vec(&receipt)?)?;
    marker.sync_all()?;
    drop(marker);
    #[cfg(unix)]
    File::open(&stage.path)?.sync_all()?;
    check(&live)?;
    let published = cache_root.join(format!(
        "project-{}-{}",
        &receipt.revision[..16],
        crate::drive_http::random_id()?
    ));
    crate::project_library::publish_directory(&stage.path, &published)?;
    #[cfg(unix)]
    File::open(cache_root)?.sync_all()?;
    root.verify()?;
    progress("Downloaded".into(), 1.);
    Ok(published)
}
#[cfg(test)]
#[path = "drive_restore_tests.rs"]
mod tests;

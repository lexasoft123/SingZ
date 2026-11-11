//! Published-phone adoption. Downloaded bytes stay isolated until verified;
//! durable local publication precedes the remote adopted tag.
use crate::{
    drive_plan::{self, RemoteEntry},
    drive_remote::Remote,
    drive_snapshot::{self, Fingerprint},
};
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant, UNIX_EPOCH},
};
use unicode_normalization::UnicodeNormalization;
pub const ADOPT_MARKER: &str = ".singz-adopt.json";
pub const ADOPTING_PREFIX: &str = ".singz-adopting-";
const JSON_LIMIT: u64 = 16 * 1024 * 1024;
const FILE_LIMIT: u64 = 2 * 1024 * 1024 * 1024;
#[derive(Clone, Debug, Default)]
pub struct Adoption {
    pub adopted: Vec<String>,
    pub warnings: Vec<String>,
}
#[derive(Debug)]
struct Refused(String);
impl std::fmt::Display for Refused {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(&self.0)
    }
}
impl std::error::Error for Refused {}
fn refuse(message: impl Into<String>) -> anyhow::Error {
    Refused(message.into()).into()
}
trait Ops {
    fn children(&self, parent: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>>;
    fn patch(&self, id: &str, value: &Value, cancel: &impl Fn() -> bool) -> Result<()>;
    fn download(
        &self,
        id: &str,
        path: &Path,
        limit: u64,
        cancel: &impl Fn() -> bool,
        progress: &impl Fn(u64),
    ) -> Result<u64>;
}
impl Ops for Remote {
    fn children(&self, p: &str, c: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        Remote::children(self, p, c)
    }
    fn patch(&self, id: &str, v: &Value, c: &impl Fn() -> bool) -> Result<()> {
        Remote::patch(self, id, v, c)
    }
    fn download(
        &self,
        id: &str,
        p: &Path,
        n: u64,
        c: &impl Fn() -> bool,
        progress: &impl Fn(u64),
    ) -> Result<u64> {
        Remote::download_with_progress(self, id, p, n, c, progress)
    }
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Drive sync cancelled");
    Ok(())
}
fn key(name: &str) -> String {
    name.trim_end_matches(['.', ' '])
        .nfc()
        .collect::<String>()
        .to_lowercase()
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    #[cfg(unix)]
    dev: u64,
    #[cfg(unix)]
    ino: u64,
    #[cfg(windows)]
    volume: u32,
    #[cfg(windows)]
    index: u64,
    #[cfg(not(any(unix, windows)))]
    created: Option<SystemTime>,
}
fn identity(path: &Path, meta: &Metadata) -> Result<Identity> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let _ = path;
        Ok(Identity {
            dev: meta.dev(),
            ino: meta.ino(),
        })
    }
    #[cfg(windows)]
    {
        use std::os::windows::{fs::OpenOptionsExt, io::AsRawHandle};
        #[repr(C)]
        struct Info {
            attributes: u32,
            created: [u32; 2],
            accessed: [u32; 2],
            written: [u32; 2],
            volume: u32,
            size_high: u32,
            size_low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
        }
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)?;
        let mut info: Info = unsafe { std::mem::zeroed() };
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0,
            "Could not identify project member"
        );
        let _ = meta;
        Ok(Identity {
            volume: info.volume,
            index: ((info.index_high as u64) << 32) | info.index_low as u64,
        })
    }
    #[cfg(not(any(unix, windows)))]
    {
        let _ = path;
        Ok(Identity {
            created: meta.created().ok(),
        })
    }
}
pub(crate) struct Directory {
    path: PathBuf,
    id: Identity,
}
impl Directory {
    pub(crate) fn capture(path: PathBuf) -> Result<Self> {
        let m = fs::symlink_metadata(&path)?;
        ensure!(
            m.file_type().is_dir() && path.canonicalize()? == path,
            "Linked or non-directory adoption folder refused"
        );
        let id = identity(&path, &m)?;
        Ok(Self { path, id })
    }
    pub(crate) fn verify(&self) -> Result<()> {
        let m = fs::symlink_metadata(&self.path)?;
        ensure!(
            m.file_type().is_dir()
                && identity(&self.path, &m)? == self.id
                && self.path.canonicalize()? == self.path,
            "Adoption directory changed during sync"
        );
        Ok(())
    }
}
fn options(read: bool, create: bool) -> OpenOptions {
    let mut options = OpenOptions::new();
    options.read(read);
    if create {
        options.write(true).create_new(true);
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000 | 0x800);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    options
}
fn read_json(path: &Path, limit: u64) -> Result<Value> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.file_type().is_file() && m.len() <= limit,
        "Adoption metadata is not an ordinary bounded file"
    );
    let file = options(true, false).open(path)?;
    ensure!(file.metadata()?.is_file(), "Linked adoption metadata");
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "Adoption metadata exceeds limit"
    );
    Ok(serde_json::from_slice(&bytes)?)
}
fn mkdir(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if !m.file_type().is_dir() {
                remove_member(path)?;
                return mkdir(path);
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            builder.create(path)?;
        }
        Err(e) => return Err(e.into()),
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(path, fs::Permissions::from_mode(0o700))?;
    }
    Ok(())
}
pub(crate) fn remove_member(path: &Path) -> Result<()> {
    let m = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    if m.file_type().is_dir() {
        for entry in fs::read_dir(path)? {
            remove_member(&entry?.path())?;
        }
        fs::remove_dir(path)?;
    } else {
        fs::remove_file(path)?;
    }
    Ok(())
}
pub(crate) fn remove_stage(stage: &Directory) {
    if stage.verify().is_ok() {
        let _ = remove_member(&stage.path);
    }
}
fn local_failure(error: &anyhow::Error) -> bool {
    error
        .chain()
        .filter_map(|e| e.downcast_ref::<std::io::Error>())
        .any(|e| {
            matches!(
                e.kind(),
                std::io::ErrorKind::PermissionDenied | std::io::ErrorKind::AlreadyExists
            ) || e.raw_os_error().is_some_and(|n| {
                matches!(
                    n,
                    1 | 4
                        | 5
                        | 13
                        | 16
                        | 17
                        | 18
                        | 19
                        | 24
                        | 28
                        | 30
                        | 32
                        | 33
                        | 39
                        | 66
                        | 80
                        | 112
                        | 145
                        | 183
                )
            })
        })
}
fn retryable(error: &anyhow::Error) -> bool {
    if local_failure(error) {
        return false;
    }
    let message = error.to_string().to_ascii_lowercase();
    if [
        "not configured",
        "not signed in",
        "sign in again",
        "session changed",
    ]
    .iter()
    .any(|m| message.contains(m))
    {
        return false;
    }
    if let Some(at) = message.find("http ") {
        if let Some(status) = message[at + 5..]
            .split_whitespace()
            .next()
            .and_then(|s| s.parse::<u16>().ok())
        {
            return status == 401 || status == 408 || status == 429 || status >= 500;
        }
    }
    true
}
fn listing_hash(file: &RemoteEntry) -> Result<Option<Fingerprint>> {
    if let Some(md5) = &file.md5_checksum {
        if !drive_snapshot::valid_md5(md5) {
            return Err(refuse(format!(
                "{} has an invalid Drive checksum",
                file.name
            )));
        }
    }
    let size = file
        .size
        .as_deref()
        .map(str::parse::<u64>)
        .transpose()
        .map_err(|_| refuse(format!("{} has an invalid Drive size", file.name)))?;
    if let Some(size) = size {
        if size > FILE_LIMIT {
            return Err(refuse(format!(
                "{} exceeds the supported file size",
                file.name
            )));
        }
    }
    Ok(file
        .md5_checksum
        .as_ref()
        .zip(size)
        .map(|(md5, size)| Fingerprint {
            md5: md5.clone(),
            size,
        }))
}
struct Partial {
    path: PathBuf,
    folder: Directory,
}
impl Drop for Partial {
    fn drop(&mut self) {
        remove_stage(&self.folder);
    }
}
fn partial(parent: &Path) -> Result<Partial> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..32 {
        let path = parent.join(format!(
            ".singz-download-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        match builder.create(&path) {
            Ok(()) => {
                let folder = Directory::capture(path.clone())?;
                return Ok(Partial {
                    path: path.join("payload.part"),
                    folder,
                });
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("Could not create exclusive download staging")
}
fn download_to(
    remote: &impl Ops,
    file: &RemoteEntry,
    out: &Path,
    limit: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
    dir: &str,
    index: usize,
    count: usize,
    retry_delay: Duration,
) -> Result<Fingerprint> {
    check(cancel)?;
    let expected = listing_hash(file)?;
    if file
        .size
        .as_deref()
        .and_then(|s| s.parse::<u64>().ok())
        .is_some_and(|size| size > limit)
    {
        return Err(refuse(format!(
            "{} exceeds supported metadata size",
            file.name
        )));
    }
    if let Ok(m) = fs::symlink_metadata(out) {
        if !m.file_type().is_file() {
            return Err(refuse("linked or non-file adoption download target"));
        }
        if file.md5_checksum.is_some()
            && file
                .size
                .as_deref()
                .is_none_or(|s| s.parse::<u64>().ok() == Some(m.len()))
        {
            let got = drive_snapshot::digest(out, cancel)?;
            if file.md5_checksum.as_deref() == Some(&got.md5) {
                progress(
                    format!("Checking {dir}/{} · verified {} bytes", file.name, got.size),
                    0.02 + 0.4 * index as f32 / count.max(1) as f32,
                );
                return Ok(got);
            }
        }
    }
    for attempt in 1..=3 {
        check(cancel)?;
        let part = partial(out.parent().context("Download destination has no parent")?)?;
        let result = (|| -> Result<Fingerprint> {
            progress(
                format!(
                    "Downloading {dir}/{} ({index}/{count}) · attempt {attempt}",
                    file.name
                ),
                0.02 + 0.4 * (index.saturating_sub(1)) as f32 / count.max(1) as f32,
            );
            let started = Instant::now();
            remote.download(&file.id, &part.path, limit, cancel, &|bytes| {
                if cancel() {
                    return;
                }
                let total = file
                    .size
                    .as_deref()
                    .and_then(|size| size.parse::<u64>().ok())
                    .unwrap_or(0);
                let rate = bytes as f64 / started.elapsed().as_secs_f64().max(0.001);
                let format_bytes = |n: f64| {
                    if n < 1024. * 1024. {
                        format!("{:.0} KB", (n / 1024.).round())
                    } else {
                        format!("{:.1} MB", n / (1024. * 1024.))
                    }
                };
                let detail = crate::i18n::tv(
                    "main.sync.downloadBytes",
                    &[
                        ("got", format_bytes(bytes as f64)),
                        ("total", format_bytes(total as f64)),
                        ("speed", format_bytes(rate)),
                    ],
                );
                let message = crate::i18n::tv(
                    "main.sync.downloadingFile",
                    &[
                        ("dir", dir.into()),
                        ("file", file.name.clone()),
                        ("index", index.to_string()),
                        ("count", count.to_string()),
                        ("detail", detail),
                    ],
                );
                // Transferred bytes do not grant publication authority. The
                // following digest and listing checks still gate every file.
                let fraction = if total > 0 {
                    (bytes as f64 / total as f64).min(1.) as f32
                } else {
                    0.
                };
                progress(
                    message,
                    0.02 + 0.4
                        * ((index.saturating_sub(1) as f32 + fraction) / count.max(1) as f32),
                );
            })?;
            check(cancel)?;
            let got = drive_snapshot::digest(&part.path, cancel)?;
            progress(
                format!("Verifying {dir}/{} · {} bytes", file.name, got.size),
                0.02 + 0.4 * index as f32 / count.max(1) as f32,
            );
            ensure!(
                expected.as_ref().is_none_or(|h| *h == got)
                    && file.md5_checksum.as_ref().is_none_or(|h| *h == got.md5)
                    && file
                        .size
                        .as_ref()
                        .is_none_or(|size| size.parse::<u64>().ok() == Some(got.size)),
                "Drive download integrity check failed for {}",
                file.name
            );
            let m = fs::symlink_metadata(out);
            match m {
                Ok(m) => ensure!(
                    m.file_type().is_file(),
                    "Linked or non-file adoption destination"
                ),
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
                Err(e) => return Err(e.into()),
            };
            // Flushing a completed file requires write access on Windows.
            OpenOptions::new()
                .write(true)
                .open(&part.path)?
                .sync_all()?;
            crate::project_store::replace(&part.path, out)?;
            Ok(got)
        })();
        drop(part);
        match result {
            Ok(got) => return Ok(got),
            Err(error) => {
                check(cancel)?;
                if attempt == 3 || !retryable(&error) {
                    return Err(error);
                }
                progress(
                    format!("Retrying {dir}/{} · attempt {}", file.name, attempt + 1),
                    0.02 + 0.4 * (index.saturating_sub(1)) as f32 / count.max(1) as f32,
                );
                let deadline = Instant::now() + retry_delay * attempt;
                while Instant::now() < deadline {
                    check(cancel)?;
                    thread::sleep(
                        Duration::from_millis(10)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    );
                }
            }
        }
    }
    unreachable!()
}
/// Read-only desktop restore reuses the adoption downloader's private partials,
/// bounded retries, cancellation and checksum verification. Unlike legacy phone
/// adoption, desktop restore requires both listing checksum and exact size.
pub(crate) fn restore_download(
    remote: &Remote,
    file: &RemoteEntry,
    out: &Path,
    limit: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(String, f32),
) -> Result<Fingerprint> {
    listing_hash(file)?.context("Drive restore requires file size and checksum")?;
    download_to(remote, file, out, limit, cancel, progress, "Drive cache", 1, 1, Duration::from_millis(200))
}
fn hash_matches(rel: &str, hash: &Value, got: &HashMap<String, Fingerprint>) -> bool {
    got.get(rel).is_some_and(|f| {
        hash["md5"].as_str() == Some(&f.md5)
            && hash["size"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n == f.size as f64)
    })
}
fn check_adoptable(doc: &Value, got: &HashMap<String, Fingerprint>) -> Result<()> {
    if !doc.is_object() {
        return Err(refuse("its project.json is not a project"));
    }
    let song = doc["songFile"]
        .as_str()
        .filter(|s| drive_plan::plain_name(s))
        .ok_or_else(|| refuse("its song file did not come with it"))?;
    if !got.contains_key(song) {
        return Err(refuse("its song file did not come with it"));
    }
    if !doc["stemHashes"].is_null() {
        let hashes = doc["stemHashes"]
            .as_object()
            .ok_or_else(|| refuse("its stemHashes is not an object"))?;
        for (name, hash) in hashes {
            if !drive_plan::plain_name(name) || !hash_matches(&format!("stems/{name}"), hash, got) {
                return Err(refuse(format!(
                    "stems/{name} does not match its project.json"
                )));
            }
        }
    }
    for (name, field) in [("lyrics.json", "lyricsHash"), ("graph.json", "graphHash")] {
        if !doc[field].is_null() && !hash_matches(name, &doc[field], got) {
            return Err(refuse(format!("{name} does not match its project.json")));
        }
    }
    Ok(())
}
pub(crate) fn stamp_mtimes(root: &Path, doc: &Value, got: &HashMap<String, Fingerprint>) {
    let mut hashes = vec![];
    if let Some(stems) = doc["stemHashes"].as_object() {
        for (name, hash) in stems {
            hashes.push((format!("stems/{name}"), hash));
        }
    }
    for (name, field) in [("lyrics.json", "lyricsHash"), ("graph.json", "graphHash")] {
        hashes.push((name.into(), &doc[field]));
    }
    if let Some(song) = doc["songFile"].as_str() {
        hashes.push((song.into(), &doc["songHash"]));
    }
    for (rel, hash) in hashes {
        let Some(ms) = hash["mtimeMs"]
            .as_f64()
            .filter(|n| n.is_finite() && *n > 0.)
        else {
            continue;
        };
        if !got
            .get(&rel)
            .is_some_and(|fingerprint| hash["md5"].as_str() == Some(fingerprint.md5.as_str()))
        {
            continue;
        }
        let Ok(duration) = Duration::try_from_secs_f64(ms / 1000.) else {
            continue;
        };
        if let Some(time) = UNIX_EPOCH.checked_add(duration) {
            if let Ok(file) = options(false, false).write(true).open(root.join(rel)) {
                let _ = file.set_times(fs::FileTimes::new().set_accessed(time).set_modified(time));
            }
        }
    }
}
fn safe_files(entries: &[RemoteEntry]) -> Result<Vec<RemoteEntry>> {
    let mut names = HashSet::new();
    let mut ids = HashSet::new();
    let mut files = vec![];
    for entry in entries {
        crate::drive_remote::validate_id(&entry.id)
            .map_err(|_| refuse("invalid Drive file identity"))?;
        if !ids.insert(&entry.id) {
            return Err(refuse("duplicate Drive file identity"));
        }
        if !drive_plan::plain_name(&entry.name) {
            continue;
        }
        if !names.insert(key(&entry.name)) {
            return Err(refuse("ambiguous Drive file names"));
        }
        if entry.mime_type.as_deref() == Some(drive_plan::FOLDER_MIME) {
            continue;
        }
        if drive_plan::validate_portable_name(&entry.name).is_err() {
            continue;
        }
        files.push(entry.clone());
    }
    Ok(files)
}
fn finish(
    remote: &impl Ops,
    file: &mut RemoteEntry,
    root: &Directory,
    dir: &str,
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    root.verify()?;
    let path = root.path.join(dir);
    let folder = Directory::capture(path.clone())?;
    ensure!(
        fs::symlink_metadata(path.join("project.json"))?
            .file_type()
            .is_file(),
        "Adopted project disappeared before tagging"
    );
    let mut patch = json!({"appProperties":{"singzState":drive_plan::STATE_ADOPTED}});
    if file.name != dir {
        patch["name"] = json!(dir);
    }
    check(cancel)?;
    remote.patch(&file.id, &patch, cancel)?;
    file.name = dir.into();
    file.app_properties.insert(
        drive_plan::PUBLISH_STATE_KEY.into(),
        drive_plan::STATE_ADOPTED.into(),
    );
    folder.verify()?;
    let marker = path.join(ADOPT_MARKER);
    if fs::symlink_metadata(&marker).is_ok_and(|m| m.file_type().is_file()) {
        let _ = fs::remove_file(marker);
    }
    Ok(())
}
fn directory_names(root: &Directory) -> Result<Vec<String>> {
    root.verify()?;
    let mut out = vec![];
    for entry in fs::read_dir(&root.path)? {
        let entry = entry?;
        if entry.file_type()?.is_dir() {
            if let Some(name) = entry.file_name().to_str() {
                out.push(name.into());
            }
        }
    }
    Ok(out)
}
fn stage_name(id: &str) -> String {
    if id.len() <= 128 {
        format!("{ADOPTING_PREFIX}{id}")
    } else {
        format!(
            "{ADOPTING_PREFIX}{}",
            crate::project_store::fingerprint(id.as_bytes())
        )
    }
}
/// Caller must not hold the native root-import lease. Existing project writer
/// leases are never held during HTTP. Root selection is fenced by the caller.
pub fn adopt(
    remote: &Remote,
    root: &Path,
    remote_top: &mut Vec<RemoteEntry>,
    cancel: &impl Fn() -> bool,
    on_progress: &impl Fn(String, f32),
) -> Result<Adoption> {
    adopt_using(
        remote,
        root,
        remote_top,
        cancel,
        on_progress,
        Duration::from_secs(1),
    )
}
fn adopt_using(
    remote: &impl Ops,
    root: &Path,
    remote_top: &mut Vec<RemoteEntry>,
    cancel: &impl Fn() -> bool,
    on_progress: &impl Fn(String, f32),
    retry_delay: Duration,
) -> Result<Adoption> {
    check(cancel)?;
    let root = Directory::capture(root.canonicalize()?)?;
    let lock = root.path.join(".singz-native-import.lock");
    if let Ok(m) = fs::symlink_metadata(&lock) {
        ensure!(m.file_type().is_file(), "Linked adoption root lease");
    }
    let mut lock_options = options(true, false);
    lock_options.write(true).create(true).truncate(false);
    let _lease = crate::file_lease::Lease::acquire(lock_options.open(lock)?)?;
    let mut result = Adoption::default();
    let mut ids = HashSet::new();
    for file in remote_top.iter() {
        crate::drive_remote::validate_id(&file.id)?;
        ensure!(
            ids.insert(file.id.clone()),
            "Duplicate Drive root identities"
        );
    }
    let mut marked = HashMap::<String, String>::new();
    let mut ambiguous = HashSet::new();
    for dir in directory_names(&root)? {
        if [
            ADOPTING_PREFIX,
            ".native-import-",
            ".native-split-",
            ".singz-native-",
        ]
        .iter()
        .any(|prefix| dir.starts_with(prefix))
        {
            continue;
        }
        let marker = root.path.join(&dir).join(ADOPT_MARKER);
        if !marker.exists() {
            continue;
        }
        let value = match read_json(&marker, 65536) {
            Ok(value) => value,
            Err(_) => {
                result.warnings.push(format!(
                    "{dir}: adoption marker is unreadable; kept for recovery."
                ));
                continue;
            }
        };
        if let Some(id) = value["folderId"].as_str() {
            if crate::drive_remote::validate_id(id).is_err() {
                continue;
            }
            if marked.insert(id.into(), dir).is_some() {
                ambiguous.insert(id.to_owned());
            }
        }
    }
    for (id, dir) in marked {
        check(cancel)?;
        if ambiguous.contains(&id) {
            result.warnings.push(format!(
                "{dir}: duplicate adoption markers; left on Drive for review."
            ));
            continue;
        }
        if let Some(file) = remote_top
            .iter_mut()
            .find(|f| f.id == id && f.mime_type.as_deref() == Some(drive_plan::FOLDER_MIME))
        {
            if drive_plan::is_published(file) {
                match finish(remote, file, &root, &dir, cancel) {
                    Ok(()) => result.adopted.push(dir),
                    Err(error)
                        if local_failure(&error)
                            || error
                                .chain()
                                .filter_map(|e| e.downcast_ref::<std::io::Error>())
                                .any(|e| e.kind() == std::io::ErrorKind::NotFound) =>
                    {
                        check(cancel)?;
                        result.warnings.push(format!("{dir}: could not finish local adoption recovery: {error}; kept for review."));
                        ambiguous.insert(id);
                    }
                    Err(error) => return Err(error),
                }
                continue;
            }
        }
        let marker = root.path.join(dir).join(ADOPT_MARKER);
        if fs::symlink_metadata(&marker).is_ok_and(|m| m.file_type().is_file()) {
            let _ = fs::remove_file(marker);
        }
    }
    for index in 0..remote_top.len() {
        check(cancel)?;
        if remote_top[index].mime_type.as_deref() != Some(drive_plan::FOLDER_MIME)
            || !drive_plan::is_published(&remote_top[index])
            || ambiguous.contains(&remote_top[index].id)
        {
            continue;
        }
        let from = remote_top[index].name.clone();
        let mut taken = directory_names(&root)?;
        taken.extend(
            remote_top
                .iter()
                .filter(|f| {
                    f.mime_type.as_deref() == Some(drive_plan::FOLDER_MIME)
                        && f.id != remote_top[index].id
                })
                .map(|f| f.name.clone()),
        );
        let dir = match drive_plan::adoption_name(&from, &taken) {
            Ok(dir) => dir,
            Err(e) => {
                result.warnings.push(format!(
                    "{from}: not taken in from the phone: {e}; left on Drive for the next sync."
                ));
                continue;
            }
        };
        if dir != remote_top[index].name {
            remote.patch(&remote_top[index].id, &json!({"name":dir}), cancel)?;
            remote_top[index].name = dir.clone();
        }
        on_progress(format!("Adding {dir} from phone"), 0.02);
        let tmp = root.path.join(stage_name(&remote_top[index].id));
        let mut stage = None;
        let attempt = (|| -> Result<()> {
            root.verify()?;
            mkdir(&tmp)?;
            stage = Some(Directory::capture(tmp.clone())?);
            mkdir(&tmp.join("stems"))?;
            let kids = remote.children(&remote_top[index].id, cancel)?;
            let files = safe_files(&kids)?;
            let docs: Vec<_> = files.iter().filter(|f| f.name == "project.json").collect();
            if docs.len() != 1 {
                return Err(refuse("it has no unique project.json"));
            }
            let doc_file = docs[0];
            let stem_dirs: Vec<_> = kids
                .iter()
                .filter(|f| {
                    f.name == "stems" && f.mime_type.as_deref() == Some(drive_plan::FOLDER_MIME)
                })
                .collect();
            if stem_dirs.len() > 1 {
                return Err(refuse("ambiguous stems directory"));
            }
            let stem_files = if let Some(folder) = stem_dirs.first() {
                safe_files(&remote.children(&folder.id, cancel)?)?
            } else {
                vec![]
            };
            for f in files.iter().filter(|f| f.id != doc_file.id) {
                if [
                    "project.json.part",
                    ADOPT_MARKER,
                    "stems",
                    ".singz-native-split.json",
                ]
                .contains(&f.name.as_str())
                {
                    return Err(refuse(format!(
                        "{} conflicts with native adoption metadata",
                        f.name
                    )));
                }
            }
            download_to(
                remote,
                doc_file,
                &tmp.join("project.json.part"),
                JSON_LIMIT,
                cancel,
                on_progress,
                &dir,
                1,
                1,
                retry_delay,
            )?;
            let doc = read_json(&tmp.join("project.json.part"), JSON_LIMIT)
                .map_err(|_| refuse("its project.json is unreadable"))?;
            let transfers: Vec<_> = files
                .iter()
                .filter(|f| f.id != doc_file.id)
                .cloned()
                .map(|f| {
                    let name = f.name.clone();
                    (name, f)
                })
                .chain(
                    stem_files
                        .into_iter()
                        .map(|f| (format!("stems/{}", f.name), f)),
                )
                .collect();
            let mut listed = HashMap::new();
            for (rel, file) in &transfers {
                listing_hash(file)?;
                listed.insert(
                    rel.clone(),
                    Fingerprint {
                        md5: file.md5_checksum.clone().unwrap_or_default(),
                        size: file
                            .size
                            .as_deref()
                            .and_then(|s| s.parse().ok())
                            .unwrap_or(u64::MAX),
                    },
                );
            }
            check_adoptable(&doc, &listed)?;
            let wanted: HashSet<_> = ["project.json.part".to_owned(), "stems".to_owned()]
                .into_iter()
                .chain(transfers.iter().map(|(rel, _)| rel.clone()))
                .collect();
            stage.as_ref().unwrap().verify()?;
            for entry in fs::read_dir(&tmp)? {
                let entry = entry?;
                if !wanted.contains(
                    entry
                        .file_name()
                        .to_str()
                        .ok_or_else(|| refuse("non-Unicode adoption staging name"))?,
                ) {
                    remove_member(&entry.path())?;
                }
            }
            for entry in fs::read_dir(tmp.join("stems"))? {
                let entry = entry?;
                if !wanted.contains(&format!("stems/{}", entry.file_name().to_string_lossy())) {
                    remove_member(&entry.path())?;
                }
            }
            let mut got = HashMap::new();
            for (i, (rel, file)) in transfers.iter().enumerate() {
                root.verify()?;
                stage.as_ref().unwrap().verify()?;
                let fingerprint = download_to(
                    remote,
                    file,
                    &tmp.join(rel),
                    FILE_LIMIT,
                    cancel,
                    on_progress,
                    &dir,
                    i + 1,
                    transfers.len(),
                    retry_delay,
                )?;
                got.insert(rel.clone(), fingerprint);
            }
            check_adoptable(&doc, &got)?;
            stamp_mtimes(&tmp, &doc, &got);
            check(cancel)?;
            root.verify()?;
            stage.as_ref().unwrap().verify()?;
            let marker = json!({"folderId":remote_top[index].id,"publishId":remote_top[index].app_properties.get(drive_plan::PUBLISH_ID_KEY).cloned().unwrap_or_default(),"from":from});
            let mut marker_file = options(false, true).open(tmp.join(ADOPT_MARKER))?;
            marker_file.write_all(&serde_json::to_vec(&marker)?)?;
            marker_file.sync_all()?;
            drop(marker_file);
            crate::project_library::publish_directory(
                &tmp.join("project.json.part"),
                &tmp.join("project.json"),
            )?;
            #[cfg(unix)]
            File::open(&tmp)?.sync_all()?;
            check(cancel)?;
            root.verify()?;
            crate::project_library::publish_directory(&tmp, &root.path.join(&dir))?;
            #[cfg(unix)]
            File::open(&root.path)?.sync_all()?;
            Ok(())
        })();
        if let Err(error) = attempt {
            if error.downcast_ref::<Refused>().is_some() {
                if let Some(stage) = &stage {
                    remove_stage(stage);
                }
            }
            check(cancel)?;
            if error.downcast_ref::<Refused>().is_none() && !local_failure(&error) {
                return Err(error);
            }
            result.warnings.push(format!(
                "{dir}: not taken in from the phone yet: {error}; left on Drive for the next sync."
            ));
            continue;
        }
        match finish(remote, &mut remote_top[index], &root, &dir, cancel) {
            Ok(()) => result.adopted.push(dir),
            Err(error) if local_failure(&error) => {
                check(cancel)?;
                result.warnings.push(format!(
                    "{dir}: local adoption was published, but completion is deferred: {error}"
                ));
            }
            Err(error) => return Err(error),
        }
    }
    Ok(result)
}
#[cfg(test)]
#[path = "drive_adopt_tests.rs"]
mod tests;

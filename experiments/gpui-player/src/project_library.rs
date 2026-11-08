//! Native library inventory and copy-only relocation. No Electron preferences,
//! audio decoder, cloud account, or deletion of the previous library is involved.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, HashSet},
    fs::{self, File, Metadata, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
    },
    thread,
    time::SystemTime,
};

const MAX_ENTRIES: usize = 10_000;
const MAX_FILES: usize = 100_000;
const MAX_BYTES: u64 = 128 * 1024 * 1024 * 1024;
const MAX_MEMBER: u64 = 8 * 1024 * 1024 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Debug)]
pub struct Config {
    pub home: PathBuf,
    pub default_root: PathBuf,
    pub preferences: PathBuf,
    pub override_root: Option<PathBuf>,
    pub one_drive: Option<PathBuf>,
}
impl Default for Config {
    fn default() -> Self {
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_default(),
        );
        Self {
            default_root: home.join("Documents/SingZ"),
            home,
            preferences: crate::audio_devices::directory().join("library.json"),
            override_root: std::env::var_os("SINGZ_GPUI_PROJECTS_ROOT").map(PathBuf::from),
            one_drive: std::env::var_os("OneDrive").map(PathBuf::from),
        }
    }
}
#[derive(Clone, Debug)]
pub struct CloudRoot {
    pub label: String,
    pub path: PathBuf,
}
#[derive(Clone, Debug)]
pub struct ProjectItem {
    pub dir: PathBuf,
    pub name: String,
    pub song_path: PathBuf,
    pub saved_at: String,
    pub has_stems: bool,
    pub stem_count: usize,
    pub has_lyrics: bool,
    pub bytes: u64,
}
#[derive(Clone, Debug)]
pub struct Snapshot {
    pub root: PathBuf,
    pub is_default: bool,
    pub cloud: Vec<CloudRoot>,
    pub projects: Vec<ProjectItem>,
}
#[derive(Clone, Debug)]
pub struct Change {
    pub snapshot: Snapshot,
    pub copied: usize,
}
#[derive(Debug)]
pub struct Event {
    pub generation: u64,
    pub result: std::result::Result<Change, String>,
}
enum Request {
    Refresh(u64),
    SetRoot(u64, Option<PathBuf>),
    Quit,
}
pub struct Service {
    serial: Arc<AtomicU64>,
    tx: SyncSender<Request>,
    events: Receiver<Event>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(config: Config) -> Self {
        let (tx, rx) = mpsc::sync_channel(8);
        let (out, events) = mpsc::channel();
        let serial = Arc::new(AtomicU64::new(0));
        let current = serial.clone();
        let worker = thread::spawn(move || {
            while let Ok(request) = rx.recv() {
                let (id, root) = match request {
                    Request::Refresh(id) => (id, None),
                    Request::SetRoot(id, root) => (id, Some(root)),
                    Request::Quit => break,
                };
                let cancelled = || current.load(Ordering::Acquire) != id;
                if cancelled() {
                    continue;
                }
                let result = match root {
                    Some(root) => set_root(&config, root, &cancelled),
                    None => refresh(&config, &cancelled).map(|snapshot| Change {
                        snapshot,
                        copied: 0,
                    }),
                };
                // A committed relocation still needs its receipt if superseded just
                // after commit; the host generation guard decides what to display.
                let _ = out.send(Event {
                    generation: id,
                    result: result.map_err(|e| format!("{e:#}")),
                });
            }
        });
        Self {
            serial,
            tx,
            events,
            worker: Some(worker),
        }
    }
    fn enqueue(&self, root: Option<Option<PathBuf>>) -> Result<u64> {
        let id = self.serial.fetch_add(1, Ordering::AcqRel) + 1;
        self.tx
            .try_send(match root {
                Some(root) => Request::SetRoot(id, root),
                None => Request::Refresh(id),
            })
            .context("Library command queue is full")?;
        Ok(id)
    }
    pub fn refresh(&self) -> Result<u64> {
        self.enqueue(None)
    }
    pub fn set_root(&self, root: Option<PathBuf>) -> Result<u64> {
        self.enqueue(Some(root))
    }
    pub fn cancel(&self) {
        self.serial.fetch_add(1, Ordering::AcqRel);
    }
    pub fn drain(&self) -> Vec<Event> {
        self.events.try_iter().collect()
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.cancel();
        let _ = self.tx.send(Request::Quit);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Library operation cancelled");
    Ok(())
}
fn read_optional(path: &Path, limit: u64) -> Result<Option<Vec<u8>>> {
    let meta = match fs::symlink_metadata(path) {
        Ok(m) => m,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= limit,
        "Invalid or oversized library metadata"
    );
    let file = File::open(path)?;
    let opened = file.metadata()?;
    ensure!(
        same(&meta, &opened),
        "Library metadata changed while opening"
    );
    let mut bytes = Vec::new();
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= limit,
        "Library metadata exceeds its limit"
    );
    Ok(Some(bytes))
}
fn preferences(config: &Config) -> Result<(Value, Option<Vec<u8>>)> {
    let bytes = read_optional(&config.preferences, 64 * 1024)?;
    let raw = match &bytes {
        Some(b) => serde_json::from_slice(b).context("Invalid native library preferences")?,
        None => json!({}),
    };
    ensure!(raw.is_object(), "Invalid native library preferences");
    Ok((raw, bytes))
}
pub fn resolved_root(config: &Config) -> Result<PathBuf> {
    let (raw, _) = preferences(config)?;
    if let Some(path) = raw
        .get("projectsRoot")
        .and_then(Value::as_str)
        .filter(|s| !s.is_empty())
    {
        let path = PathBuf::from(path);
        if path.is_absolute() && path.is_dir() {
            return Ok(normalize_root(&path));
        }
    }
    Ok(normalize_root(default_root(config)))
}
fn default_root(config: &Config) -> &Path {
    config
        .override_root
        .as_deref()
        .unwrap_or(&config.default_root)
}
fn normalize_root(path: &Path) -> PathBuf {
    // A first Save may create the library after startup. Resolve its existing
    // ancestors now so the catalog identity does not change from /tmp/... to
    // /private/tmp/... merely because the last directory starts to exist.
    let absolute = if path.is_absolute() {
        path.to_owned()
    } else {
        std::env::current_dir()
            .map(|dir| dir.join(path))
            .unwrap_or_else(|_| path.to_owned())
    };
    let mut normalized = PathBuf::new();
    for component in absolute.components() {
        match component {
            Component::CurDir => {}
            Component::ParentDir => {
                normalized.pop();
            }
            other => normalized.push(other.as_os_str()),
        }
    }
    let mut cursor = normalized.as_path();
    let mut missing = vec![];
    loop {
        if let Ok(mut root) = cursor.canonicalize() {
            for part in missing.iter().rev() {
                root.push(part);
            }
            return root;
        }
        let (Some(name), Some(parent)) = (cursor.file_name(), cursor.parent()) else {
            return normalized;
        };
        missing.push(name.to_owned());
        cursor = parent;
    }
}
/// Best-effort accessor for legacy call sites; explicit storage UI calls use
/// resolved_root/refresh so malformed preferences are reported to the user.
pub fn library_root() -> PathBuf {
    let config = Config::default();
    resolved_root(&config).unwrap_or_else(|_| normalize_root(default_root(&config)))
}
fn cloud_roots(config: &Config, cancel: &impl Fn() -> bool) -> Result<Vec<CloudRoot>> {
    let home = &config.home;
    let mut candidates = vec![
        (
            "iCloud Drive",
            home.join("Library/Mobile Documents/com~apple~CloudDocs"),
        ),
        ("iCloud Drive", home.join("iCloudDrive")),
        (
            "OneDrive",
            config.one_drive.clone().unwrap_or(home.join("OneDrive")),
        ),
        ("Google Drive", PathBuf::from("G:/My Drive")),
        ("Google Drive", home.join("Google Drive")),
    ];
    if let Ok(entries) = fs::read_dir(home.join("Library/CloudStorage")) {
        let mut count = 0;
        for entry in entries {
            check(cancel)?;
            count += 1;
            ensure!(count <= MAX_ENTRIES, "Too many cloud folders");
            let entry = entry?;
            if entry
                .file_name()
                .to_string_lossy()
                .starts_with("GoogleDrive-")
            {
                candidates.push(("Google Drive", entry.path().join("My Drive")));
            }
        }
    }
    let mut seen = HashSet::new();
    let mut out = vec![];
    for (label, base) in candidates {
        check(cancel)?;
        if base.is_dir() && seen.insert(label) {
            out.push(CloudRoot {
                label: label.into(),
                path: base.join("SingZ"),
            });
        }
    }
    Ok(out)
}
fn relative(path: &str) -> bool {
    !path.is_empty()
        && Path::new(path)
            .components()
            .all(|c| matches!(c, Component::Normal(_)))
}
fn ordinary(path: &Path) -> Option<Metadata> {
    fs::symlink_metadata(path)
        .ok()
        .filter(|m| m.is_file() && !m.file_type().is_symlink())
}
fn private_project(name: &str) -> bool {
    [
        ".singz-adopting-",
        ".native-import-",
        ".native-split-",
        ".singz-native-",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}
fn project_item(dir: &Path, cancel: &impl Fn() -> bool) -> Result<Option<ProjectItem>> {
    let Some(bytes) = read_optional(&dir.join("project.json"), 8 * 1024 * 1024)? else {
        return Ok(None);
    };
    let raw: Value = serde_json::from_slice(&bytes)?;
    let empty = raw["settings"]["nativeEmptyTracks"] == true;
    let custom = &raw["settings"]["custom"];
    if empty {
        ensure!(
            custom.as_array().is_some_and(|entries| entries.is_empty()),
            "Empty project must declare no custom audio"
        );
    }
    let resolved = if empty {
        None
    } else {
        Some(crate::tracks::resolve_custom(dir, custom)?)
    };
    let has_custom = resolved
        .as_ref()
        .is_some_and(|resolved| !resolved.lanes.is_empty());
    let stems = ["vocals", "drums", "bass", "other", "guitar", "piano"];
    let stems_dir = dir.join("stems");
    let safe_stems =
        fs::symlink_metadata(&stems_dir).is_ok_and(|m| m.is_dir() && !m.file_type().is_symlink());
    let present: Vec<bool> = stems
        .iter()
        .map(|s| {
            !empty
                && safe_stems
                && ["flac", "wav"]
                    .iter()
                    .any(|ext| ordinary(&stems_dir.join(format!("{s}.{ext}"))).is_some_and(|m| m.len() > 0))
        })
        .collect();
    // Validate metadata under both platform separator conventions before a
    // missing original can use the metadata-only Open route. Do not reinterpret
    // the actual filename on this host or change migration path semantics.
    let portable_song = |song: &str| {
        let normalized = song.replace('\\', "/");
        relative(song)
            && !song.contains('\0')
            && relative(&normalized)
            && normalized.split('/').all(|part| {
                !part.is_empty()
                    && part != "."
                    && part != ".."
                    && !(part.as_bytes().get(1) == Some(&b':')
                        && part.as_bytes()[0].is_ascii_alphabetic())
            })
    };
    let ordinary_song = (|| -> Result<Option<PathBuf>> {
        let Some(song) = raw["songFile"].as_str().filter(|s| portable_song(s)) else {
            return Ok(None);
        };
        let mut cursor = dir.to_owned();
        for part in Path::new(song).components() {
            cursor.push(part);
            let meta = match fs::symlink_metadata(&cursor) {
                Ok(meta) => meta,
                Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
                Err(e) => return Err(e.into()),
            };
            ensure!(!meta.file_type().is_symlink(), "Linked library song");
        }
        let path = dir.join(song);
        Ok(ordinary(&path).map(|_| path))
    });
    let song_path = if empty || (has_custom && raw["settings"]["nativeOriginalDisabled"] == true) {
        dir.join("project.json")
    } else if let Some(song) = ordinary_song()? {
        song
    } else if has_custom || present.iter().any(|present| *present) {
        // Missing originals are normal for stem-only/custom-only cloud documents;
        // malformed explicit paths still do not gain access to a project.
        ensure!(
            raw["songFile"].is_null() || raw["songFile"].as_str().is_some_and(portable_song),
            "Invalid library song path"
        );
        dir.join("project.json")
    } else {
        return Ok(None);
    };
    let mut bytes = 0u64;
    for folder in [dir.to_owned(), dir.join("stems")] {
        if folder != dir && fs::symlink_metadata(&folder).is_ok_and(|m| m.file_type().is_symlink())
        {
            continue;
        }
        if let Ok(entries) = fs::read_dir(folder) {
            for (index, entry) in entries.enumerate() {
                check(cancel)?;
                ensure!(index < MAX_FILES, "Too many project files");
                let entry = entry?;
                if let Some(m) = ordinary(&entry.path()) {
                    bytes = bytes
                        .checked_add(m.len())
                        .context("Project size overflow")?;
                }
            }
        }
    }
    Ok(Some(ProjectItem {
        dir: dir.into(),
        name: raw["name"]
            .as_str()
            .unwrap_or_else(|| dir.file_name().and_then(|s| s.to_str()).unwrap_or("Song"))
            .into(),
        song_path,
        saved_at: raw["savedAt"].as_str().unwrap_or("").into(),
        has_stems: present[..4].iter().all(|v| *v),
        stem_count: present.iter().filter(|v| **v).count(),
        has_lyrics: ordinary(&dir.join("lyrics.json")).is_some(),
        bytes,
    }))
}
fn snapshot_at(config: &Config, root: PathBuf, cancel: &impl Fn() -> bool) -> Result<Snapshot> {
    check(cancel)?;
    let mut projects = vec![];
    match fs::read_dir(&root) {
        Ok(entries) => {
            for (index, entry) in entries.enumerate() {
                check(cancel)?;
                ensure!(index < MAX_ENTRIES, "Too many library folders");
                let entry = entry?;
                if private_project(&entry.file_name().to_string_lossy())
                    || !entry.file_type()?.is_dir()
                {
                    continue;
                }
                // Damaged/half-synced projects must not hide the rest of the inventory.
                if let Ok(Some(project)) = project_item(&entry.path(), cancel) {
                    projects.push(project);
                }
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    projects.sort_by(|a, b| {
        b.saved_at
            .cmp(&a.saved_at)
            .then_with(|| a.name.cmp(&b.name))
    });
    let is_default = root == normalize_root(default_root(config));
    Ok(Snapshot {
        root,
        is_default,
        cloud: cloud_roots(config, cancel)?,
        projects,
    })
}
pub fn refresh(config: &Config, cancel: &impl Fn() -> bool) -> Result<Snapshot> {
    snapshot_at(config, resolved_root(config)?, cancel)
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    a.is_file() == b.is_file()
        && a.is_dir() == b.is_dir()
        && a.len() == b.len()
        && a.modified().ok() == b.modified().ok()
        && file_identity(a) == file_identity(b)
}
#[cfg(unix)]
fn file_identity(meta: &Metadata) -> (u64, u64) {
    use std::os::unix::fs::MetadataExt;
    (meta.dev(), meta.ino())
}
#[cfg(not(unix))]
fn file_identity(_: &Metadata) -> (u64, u64) {
    (0, 0)
}
#[derive(Debug, PartialEq)]
struct Stamp {
    directory: bool,
    len: u64,
    modified: Option<SystemTime>,
    identity: (u64, u64),
}
fn manifest(root: &Path, cancel: &impl Fn() -> bool) -> Result<BTreeMap<PathBuf, Stamp>> {
    let mut result = BTreeMap::new();
    let mut todo = vec![PathBuf::new()];
    let mut size = 0u64;
    while let Some(relative) = todo.pop() {
        check(cancel)?;
        let dir = root.join(&relative);
        let meta = fs::symlink_metadata(&dir)?;
        ensure!(
            meta.is_dir() && !meta.file_type().is_symlink(),
            "Linked library folder"
        );
        for entry in fs::read_dir(&dir)? {
            check(cancel)?;
            let entry = entry?;
            let name = entry.file_name();
            let text = name.to_string_lossy();
            if text.starts_with(".singz-native-") || text.starts_with(".native-split-") {
                continue;
            }
            let path = relative.join(name);
            let m = fs::symlink_metadata(entry.path())?;
            ensure!(
                !m.file_type().is_symlink() && (m.is_file() || m.is_dir()),
                "Linked or special project member cannot be migrated"
            );
            ensure!(result.len() < MAX_FILES, "Project has too many files");
            if m.is_dir() {
                todo.push(path.clone());
            } else {
                ensure!(
                    m.len() <= MAX_MEMBER,
                    "Project member exceeds migration limit"
                );
                size = size.checked_add(m.len()).context("Project size overflow")?;
                ensure!(size <= MAX_BYTES, "Project exceeds migration limit");
            }
            result.insert(
                path,
                Stamp {
                    directory: m.is_dir(),
                    len: if m.is_dir() { 0 } else { m.len() },
                    modified: m.modified().ok(),
                    identity: file_identity(&m),
                },
            );
        }
    }
    Ok(result)
}
pub(crate) fn validate_source_tree(root: &Path, cancel: &impl Fn() -> bool) -> Result<()> {
    manifest(root, cancel).map(|_| ())
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn unique() -> String {
    format!(
        "{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    )
}
pub(crate) struct CopiedSource {
    source: PathBuf,
    manifest: BTreeMap<PathBuf, Stamp>,
    _lease: crate::file_lease::Lease,
}
impl CopiedSource {
    pub(crate) fn verify(&self, cancel: &impl Fn() -> bool) -> Result<()> {
        ensure!(
            manifest(&self.source, cancel)? == self.manifest,
            "Source project changed after copying"
        );
        Ok(())
    }
}
fn copy_project(
    source: &Path,
    destination: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<CopiedSource> {
    copy_project_checked(source, destination, cancel, &|_| Ok(()))
}
pub(crate) fn copy_project_checked(
    source: &Path,
    destination: &Path,
    cancel: &impl Fn() -> bool,
    validate: &impl Fn(&Path) -> Result<()>,
) -> Result<CopiedSource> {
    let meta = fs::symlink_metadata(source)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Linked migration source folder"
    );
    let source = source.canonicalize()?;
    let lease = crate::project_publish::lock(&source)?;
    crate::project_publish::recover_locked(&source)?;
    validate(&source)?;
    let before = manifest(&source, cancel)?;
    let parent = destination
        .parent()
        .context("Library destination has no parent")?;
    let staging = parent.join(format!(".singz-adopting-native-{}", unique()));
    fs::create_dir(&staging)?;
    let _pending = Pending(staging.clone());
    for (relative, stamp) in &before {
        check(cancel)?;
        let from = source.join(relative);
        let to = staging.join(relative);
        ensure!(
            from.canonicalize()?.starts_with(&source),
            "Project member leaves source folder"
        );
        if stamp.directory {
            fs::create_dir_all(&to)?;
            continue;
        }
        fs::create_dir_all(to.parent().unwrap())?;
        let m = fs::symlink_metadata(&from)?;
        ensure!(
            m.is_file() && !m.file_type().is_symlink(),
            "Project member became linked"
        );
        let mut input = File::open(&from)?;
        opened_inside(&input, &source)?;
        let opened = input.metadata()?;
        ensure!(
            same(&m, &opened)
                && opened.len() == stamp.len
                && opened.modified().ok() == stamp.modified
                && file_identity(&opened) == stamp.identity,
            "Project changed while copying"
        );
        let mut output = OpenOptions::new().write(true).create_new(true).open(&to)?;
        let mut buffer = [0u8; 65536];
        let mut length = 0u64;
        loop {
            check(cancel)?;
            let n = input.read(&mut buffer)?;
            if n == 0 {
                break;
            }
            length += n as u64;
            ensure!(length <= stamp.len, "Project grew while copying");
            output.write_all(&buffer[..n])?;
        }
        ensure!(
            length == stamp.len && same(&opened, &input.metadata()?),
            "Project changed while copying"
        );
        output.sync_all()?;
    }
    ensure!(
        manifest(&source, cancel)? == before,
        "Project changed during migration"
    );
    check(cancel)?;
    validate(&source)?;
    publish_directory(&staging, destination)?;
    #[cfg(unix)]
    File::open(parent)?.sync_all()?;
    Ok(CopiedSource {
        source,
        manifest: before,
        _lease: lease,
    })
}
#[cfg(not(windows))]
fn opened_inside(_: &File, _: &Path) -> Result<()> {
    Ok(())
}
#[cfg(windows)]
fn opened_inside(file: &File, root: &Path) -> Result<()> {
    use std::os::windows::{ffi::OsStringExt, io::AsRawHandle};
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFinalPathNameByHandleW(
            handle: *mut std::ffi::c_void,
            buffer: *mut u16,
            size: u32,
            flags: u32,
        ) -> u32;
    }
    let mut buffer = vec![0u16; 32768];
    let count = unsafe {
        GetFinalPathNameByHandleW(
            file.as_raw_handle(),
            buffer.as_mut_ptr(),
            buffer.len() as u32,
            0,
        )
    };
    ensure!(
        count > 0 && (count as usize) < buffer.len(),
        "Cannot establish migrated file location"
    );
    let path = PathBuf::from(std::ffi::OsString::from_wide(&buffer[..count as usize]));
    ensure!(
        path.starts_with(root),
        "Opened project member leaves source folder"
    );
    Ok(())
}
#[cfg(target_os = "macos")]
pub(crate) fn publish_directory(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renamex_np(
            from: *const std::ffi::c_char,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    if unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(target_os = "linux")]
pub(crate) fn publish_directory(from: &Path, to: &Path) -> Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn renameat2(
            a: i32,
            from: *const std::ffi::c_char,
            b: i32,
            to: *const std::ffi::c_char,
            flags: u32,
        ) -> i32;
    }
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    if unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) } != 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(windows)]
pub(crate) fn publish_directory(from: &Path, to: &Path) -> Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileW(from: *const u16, to: *const u16) -> i32;
    }
    let from: Vec<u16> = from.as_os_str().encode_wide().chain(Some(0)).collect();
    let to: Vec<u16> = to.as_os_str().encode_wide().chain(Some(0)).collect();
    if unsafe { MoveFileW(from.as_ptr(), to.as_ptr()) } == 0 {
        return Err(std::io::Error::last_os_error().into());
    }
    Ok(())
}
#[cfg(not(any(target_os = "macos", target_os = "linux", windows)))]
pub(crate) fn publish_directory(_: &Path, _: &Path) -> Result<()> {
    bail!("Atomic library migration is unsupported on this platform")
}
pub fn set_root(
    config: &Config,
    requested: Option<PathBuf>,
    cancel: &impl Fn() -> bool,
) -> Result<Change> {
    check(cancel)?;
    let parent = config
        .preferences
        .parent()
        .context("Native library preferences have no parent")?;
    fs::create_dir_all(parent)?;
    let lease = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(parent.join("library.lock"))?;
    let _lease = crate::file_lease::Lease::acquire(lease)
        .context("Library storage is already being changed")?;
    let (mut raw, expected) = preferences(config)?;
    let old = resolved_root(config)?;
    let new = requested
        .clone()
        .unwrap_or_else(|| default_root(config).to_owned());
    ensure!(new.is_absolute(), "Choose an absolute library folder");
    fs::create_dir_all(&new)?;
    let new = new.canonicalize()?;
    let old = if old.exists() {
        old.canonicalize()?
    } else {
        old
    };
    if new == old {
        return Ok(Change {
            snapshot: snapshot_at(config, new, cancel)?,
            copied: 0,
        });
    }
    ensure!(
        !new.starts_with(&old) && !old.starts_with(&new),
        "Library folders must not contain each other"
    );
    let mut copied = 0;
    let mut source_guards = vec![];
    let _import_lease = if old.is_dir() {
        let lock = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .open(old.join(".singz-native-import.lock"))?;
        Some(
            crate::file_lease::Lease::acquire(lock)
                .context("Another song is being saved to the library")?,
        )
    } else {
        None
    };
    let initial_projects = project_dirs(&old, cancel)?;
    let _sync_intent = RootSync::new(
        crate::sync_dirty::Store::new(parent.to_owned()), initial_projects.clone(),
    );
    if old.is_dir() {
        for (index, entry) in fs::read_dir(&old)?.enumerate() {
            check(cancel)?;
            ensure!(index < MAX_ENTRIES, "Too many library folders");
            let entry = entry?;
            if private_project(&entry.file_name().to_string_lossy()) || !entry.file_type()?.is_dir()
            {
                continue;
            }
            let src = entry.path();
            ensure!(
                src.canonicalize()?.parent() == Some(old.as_path()),
                "Migration source leaves the old library"
            );
            if ordinary(&src.join("project.json")).is_none() {
                continue;
            }
            let dst = new.join(entry.file_name());
            if fs::symlink_metadata(&dst).is_ok() {
                continue;
            }
            source_guards.push(copy_project(&src, &dst, cancel)?);
            copied += 1;
        }
    }
    #[cfg(feature = "ui-tests")]
    if let Some(gate) = std::env::var_os("SINGZ_GPUI_PICKER_MOVE_GATE")
        .map(PathBuf::from)
        .filter(|p| p.exists())
    {
        fs::write(gate.with_extension("ready"), b"copied")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while gate.exists() {
            check(cancel)?;
            ensure!(
                std::time::Instant::now() < deadline,
                "Library test gate timed out"
            );
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    // Prepare the entire receipt before the commit point: cancellation or an
    // inventory failure must leave the selected library unchanged.
    let mut snapshot = snapshot_at(config, new.clone(), cancel)?;
    snapshot.is_default = new == normalize_root(default_root(config));
    if requested.is_some() {
        raw["projectsRoot"] = json!(new);
    } else {
        raw.as_object_mut().unwrap().remove("projectsRoot");
    }
    let bytes = serde_json::to_vec_pretty(&raw)?;
    ensure!(
        bytes.len() <= 64 * 1024,
        "Library preferences are too large"
    );
    let temporary = parent.join(format!(".library-{}.tmp", unique()));
    struct PendingFile(PathBuf);
    impl Drop for PendingFile {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let pending = PendingFile(temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending.0)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    check(cancel)?;
    ensure!(
        project_dirs(&old, cancel)? == initial_projects,
        "Projects changed during library migration"
    );
    for source in &source_guards {
        ensure!(
            manifest(&source.source, cancel)? == source.manifest,
            "Project changed before library selection could be committed"
        );
    }
    ensure!(
        read_optional(&config.preferences, 64 * 1024)? == expected,
        "Library preferences changed during migration"
    );
    if expected.is_some() {
        crate::project_store::replace(&pending.0, &config.preferences)?;
    } else {
        fs::hard_link(&pending.0, &config.preferences)
            .context("Library preferences appeared during migration")?;
    }
    #[cfg(unix)]
    let _ = File::open(parent).and_then(|file| file.sync_all());
    // No cancellation after the durable preference publication point.
    Ok(Change { snapshot, copied })
}
// Root migration copies projects and retains the originals. Preserve those
// paths as outside-library intent when the selected root changes.
struct RootSync { store: crate::sync_dirty::Store, old_projects: Vec<PathBuf> }
impl RootSync {
    fn new(store: crate::sync_dirty::Store, old_projects: Vec<PathBuf>) -> Self {
        let value = Self { store, old_projects };
        value.mark("library moved");
        value
    }
    fn mark(&self, reason: &str) {
        let result = (|| -> Result<()> {
            self.store.mark_library_preserving_projects(reason)?;
            for path in &self.old_projects {
                self.store.mark_project(path, "retained old library sync intent")?;
            }
            Ok(())
        })();
        if let Err(error) = result {
            crate::diagnostics::event("sync", format!("Could not record library sync intent: {error:#}"), crate::diagnostics::Level::Warn);
        }
    }
}
impl Drop for RootSync {
    fn drop(&mut self) { self.mark("library moved (finished)"); }
}
fn project_dirs(root: &Path, cancel: &impl Fn() -> bool) -> Result<Vec<PathBuf>> {
    let mut dirs = vec![];
    let entries = match fs::read_dir(root) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(dirs),
        Err(e) => return Err(e.into()),
    };
    for (index, entry) in entries.enumerate() {
        check(cancel)?;
        ensure!(index < MAX_ENTRIES, "Too many library folders");
        let entry = entry?;
        if !private_project(&entry.file_name().to_string_lossy())
            && entry.file_type()?.is_dir()
            && ordinary(&entry.path().join("project.json")).is_some()
        {
            dirs.push(entry.path());
        }
    }
    dirs.sort();
    Ok(dirs)
}

#[cfg(test)]
#[path = "project_library_tests.rs"]
mod tests;

#[cfg(test)]
mod root_sync_tests {
    use super::*;
    #[test]
    fn moving_root_keeps_old_project_intent_and_foreign_files() {
        let base=std::env::temp_dir().join(format!("singz-root-sync-{}",unique()));
        let config=Config { home:base.join("home"), default_root:base.join("old"),
            preferences:base.join("prefs/library.json"), override_root:None, one_drive:None };
        let project=config.default_root.join("Song");
        fs::create_dir_all(&project).unwrap();
        fs::write(project.join("project.json"),br#"{"version":2,"name":"Song","songFile":"song.wav","settings":{}}"#).unwrap();
        fs::write(project.join("song.wav"),b"song").unwrap();
        fs::write(project.join("notes.txt"),b"foreign").unwrap();
        let project=project.canonicalize().unwrap();
        let store=crate::sync_dirty::Store::new(base.join("prefs"));
        let outside=base.join("unrelated-outside");
        store.mark_project(&outside,"earlier unrelated edit").unwrap();
        let captured=store.snapshot().unwrap().seq;
        let change=set_root(&config,Some(base.join("new")),&||false).unwrap();
        assert_eq!(change.copied,1);
        let dirty=store.clear(captured).unwrap();
        assert!(dirty.all_seq>captured);
        assert!(dirty.dirs.contains_key(project.to_str().unwrap()));
        // Existing outside intent is not removed by changing the selected root;
        // its old mark can only be cleared by an actually captured sync.
        assert!(project.join("song.wav").exists());
        assert_eq!(fs::read(change.snapshot.root.join("Song/notes.txt")).unwrap(),b"foreign");
        fs::remove_dir_all(base).unwrap();
    }
}

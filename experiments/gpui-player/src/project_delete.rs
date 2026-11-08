//! Confirmed saved-project deletion. Hiding is reversible until sync intent commits.
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Component, Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant, SystemTime},
};
const MAX_FILES: usize = 100_000;
const MAX_BYTES: u64 = 128 * 1024 * 1024 * 1024;
const MAX_JSON: u64 = 8 * 1024 * 1024;
#[derive(Clone, Debug)]
pub struct Target {
    pub root: PathBuf,
    pub dir: PathBuf,
    pub name: String,
    pub metadata_hash: String,
    pub stem_count: usize,
    pub has_lyrics: bool,
    pub bytes: u64,
    root_identity: Identity,
    project_identity: Identity,
    tree: BTreeMap<PathBuf, Stamp>,
}
#[derive(Clone, Debug)]
pub struct Outcome {
    pub dir: PathBuf,
    pub name: String,
    pub warning: Option<String>,
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
        let file = OpenOptions::new()
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
fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        meta.file_type().is_symlink() || meta.file_attributes() & 0x400 != 0
    }
    #[cfg(not(windows))]
    {
        meta.file_type().is_symlink()
    }
}
fn ordinary_dir(path: &Path) -> Result<Identity> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_dir() && !linked(&meta),
        "Project/library folders must be ordinary directories"
    );
    identity(path, &meta)
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    identity: Identity,
    kind: u8,
    bytes: u64,
    modified: Option<SystemTime>,
    #[cfg(unix)]
    changed: (i64, i64),
    content: Option<String>,
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Project deletion cancelled");
    Ok(())
}
fn anchored(root: &Path, dir: &Path) -> Result<(PathBuf, PathBuf)> {
    ensure!(
        root.is_absolute() && dir.is_absolute(),
        "Choose an absolute saved project folder"
    );
    for path in [root, dir] {
        ensure!(
            path.components()
                .all(|c| !matches!(c, Component::ParentDir | Component::CurDir)),
            "Project path must not contain parent aliases"
        );
    }
    ordinary_dir(root)?;
    let canonical_root = root.canonicalize()?;
    let relative = dir
        .strip_prefix(root)
        .context("Project is outside the current library")?;
    ensure!(
        !relative.as_os_str().is_empty(),
        "The library root cannot be deleted"
    );
    let mut current = root.to_owned();
    for part in relative.components() {
        ensure!(
            matches!(part, Component::Normal(_)),
            "Invalid saved project path"
        );
        current.push(part);
        ordinary_dir(&current)?;
    }
    let canonical = dir.canonicalize()?;
    ensure!(
        canonical != canonical_root && canonical.starts_with(&canonical_root),
        "Project is outside the current library"
    );
    ensure!(
        !canonical
            .file_name()
            .is_some_and(|name| name.to_string_lossy().starts_with('.')),
        "Private library staging cannot be deleted as a project"
    );
    Ok((canonical_root, canonical))
}
fn bounded_bytes(path: &Path) -> Result<Vec<u8>> {
    let before = fs::symlink_metadata(path)?;
    ensure!(
        before.is_file() && !linked(&before) && before.len() <= MAX_JSON,
        "Saved project metadata must be ordinary and bounded"
    );
    let mut options = OpenOptions::new();
    options.read(true);
    no_follow(&mut options);
    let file = options.open(path)?;
    ensure!(
        identity(path, &before)? == identity(path, &file.metadata()?)?,
        "Project metadata changed while opening"
    );
    let mut bytes = vec![];
    file.take(MAX_JSON + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= MAX_JSON,
        "Saved project metadata exceeds limit"
    );
    Ok(bytes)
}
fn bounded_json(path: &Path) -> Result<(serde_json::Value, String)> {
    let bytes = bounded_bytes(path)?;
    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    ensure!(raw.is_object(), "Folder is not a saved project");
    Ok((raw, crate::project_store::fingerprint(&bytes)))
}
fn no_follow(options: &mut OpenOptions) {
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
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
    let _ = options;
}
fn scan(dir: &Path, cancel: &impl Fn() -> bool) -> Result<(BTreeMap<PathBuf, Stamp>, u64)> {
    let mut todo = vec![(PathBuf::new(), 0usize)];
    let mut result = BTreeMap::new();
    let mut bytes = 0u64;
    while let Some((relative, depth)) = todo.pop() {
        check(cancel)?;
        ensure!(
            depth <= 128 && result.len() < MAX_FILES,
            "Project is too large to inspect safely"
        );
        let path = dir.join(&relative);
        let meta = fs::symlink_metadata(&path)?;
        // These exact zero-byte coordination files may be created when acquiring
        // the source writer lease after confirmation. No other member is ignored.
        if relative == Path::new(".singz-native-write.lock")
            && meta.is_file()
            && !linked(&meta)
            && meta.len() == 0
        {
            continue;
        }
        let is_link = linked(&meta);
        let kind = if is_link {
            2
        } else if meta.is_dir() {
            1
        } else if meta.is_file() {
            0
        } else {
            3
        };
        if meta.is_file() && !is_link {
            bytes = bytes
                .checked_add(meta.len())
                .context("Project size overflow")?;
            ensure!(
                bytes <= MAX_BYTES,
                "Project exceeds deletion inspection limit"
            );
        }
        let content =
            if relative == Path::new("project.json") || relative == Path::new("lyrics.json") {
                if kind == 0 {
                    Some(crate::project_store::fingerprint(&bounded_bytes(&path)?))
                } else {
                    None
                }
            } else if is_link {
                Some(fs::read_link(&path)?.to_string_lossy().into_owned())
            } else {
                None
            };
        let identity = identity(&path, &meta)?;
        #[cfg(unix)]
        let changed = {
            use std::os::unix::fs::MetadataExt;
            if kind == 1 {
                (0, 0)
            } else {
                (meta.ctime(), meta.ctime_nsec())
            }
        };
        result.insert(
            relative.clone(),
            Stamp {
                identity,
                kind,
                bytes: if kind == 1 { 0 } else { meta.len() },
                modified: if kind == 1 {
                    None
                } else {
                    meta.modified().ok()
                },
                #[cfg(unix)]
                changed,
                content,
            },
        );
        if kind == 1 {
            for entry in fs::read_dir(&path)? {
                check(cancel)?;
                todo.push((relative.join(entry?.file_name()), depth + 1));
                ensure!(
                    todo.len() + result.len() <= MAX_FILES,
                    "Project has too many members"
                );
            }
        }
    }
    Ok((result, bytes))
}
/// Recovery may accept independently edited metadata, but never a different
/// folder which appeared at the confirmed project's former pathname.
pub fn verify_original_folder(target: &Target) -> Result<()> {
    ensure!(
        ordinary_dir(&target.dir)? == target.project_identity,
        "The original project folder is no longer at this path; refusing to reopen its replacement"
    );
    Ok(())
}
pub fn inspect(root: &Path, dir: &Path) -> Result<Target> {
    inspect_cancel(root, dir, &|| false)
}
pub fn inspect_cancel(root: &Path, dir: &Path, cancel: &impl Fn() -> bool) -> Result<Target> {
    let (root, dir) = anchored(root, dir)?;
    check(cancel)?;
    let root_identity = ordinary_dir(&root)?;
    let project_identity = ordinary_dir(&dir)?;
    let (raw, metadata_hash) = bounded_json(&dir.join("project.json"))?;
    let (tree, bytes) = scan(&dir, cancel)?;
    ensure!(
        tree.get(Path::new("project.json"))
            .and_then(|s| s.content.as_deref())
            == Some(metadata_hash.as_str()),
        "Project changed during inspection"
    );
    let ordinary =
        |path: &Path| fs::symlink_metadata(path).is_ok_and(|m| m.is_file() && !linked(&m));
    let stem_count = crate::integration::STEMS
        .iter()
        .filter(|stem| {
            ["wav", "flac"]
                .iter()
                .any(|ext| ordinary(&dir.join("stems").join(format!("{stem}.{ext}"))))
        })
        .count();
    let has_lyrics = ordinary(&dir.join("lyrics.json"));
    let name = raw["name"]
        .as_str()
        .unwrap_or_else(|| dir.file_name().and_then(|n| n.to_str()).unwrap_or("Song"))
        .to_owned();
    Ok(Target {
        root,
        dir,
        name,
        metadata_hash,
        stem_count,
        has_lyrics,
        bytes,
        root_identity,
        project_identity,
        tree,
    })
}
fn lease(path: &Path, label: &str) -> Result<crate::file_lease::Lease> {
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    no_follow(&mut options);
    let file = options.open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && !linked(&meta) && meta.len() == 0,
        "Invalid native library coordination file"
    );
    crate::file_lease::Lease::acquire(file).with_context(|| label.to_owned())
}
fn validate(target: &Target, cancel: &impl Fn() -> bool) -> Result<()> {
    let (root, dir) = anchored(&target.root, &target.dir)?;
    ensure!(
        root == target.root
            && dir == target.dir
            && ordinary_dir(&root)? == target.root_identity
            && ordinary_dir(&dir)? == target.project_identity,
        "Project/library folder changed since confirmation"
    );
    let (_, hash) = bounded_json(&dir.join("project.json"))?;
    ensure!(
        hash == target.metadata_hash,
        "Project changed since confirmation. Review deletion again."
    );
    let (tree, _) = scan(&dir, cancel)?;
    ensure!(
        tree == target.tree,
        "Project files changed since confirmation. Review deletion again."
    );
    Ok(())
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Point {
    BeforeHide,
    AfterHide,
    BeforeMark,
    AfterMark,
    BeforeCleanup,
}
pub fn delete(target: &Target, configdir: &Path, cancel: &impl Fn() -> bool) -> Result<Outcome> {
    delete_with(target, configdir, cancel, |point, _| gate(point, cancel))
}
fn delete_with(
    target: &Target,
    configdir: &Path,
    cancel: &impl Fn() -> bool,
    mut hook: impl FnMut(Point, &Path) -> Result<()>,
) -> Result<Outcome> {
    check(cancel)?;
    ensure!(
        configdir.is_absolute() && !configdir.starts_with(&target.dir),
        "Cannot delete a folder containing native app preferences"
    );
    fs::create_dir_all(configdir)?;
    ordinary_dir(configdir)?;
    let configdir = configdir.canonicalize()?;
    ensure!(
        !configdir.starts_with(&target.dir),
        "Cannot delete a folder containing native app preferences"
    );
    let configdir = configdir.as_path();
    let _library = lease(
        &configdir.join("library.lock"),
        "Library storage is being changed",
    )?;
    let mut config = crate::project_library::Config::default();
    config.preferences = configdir.join("library.json");
    let current = crate::project_library::resolved_root(&config)?;
    ensure!(
        current.canonicalize()? == target.root,
        "The library folder changed. Review deletion again."
    );
    ensure!(
        ordinary_dir(&target.root)? == target.root_identity,
        "Library folder changed since confirmation"
    );
    let _root = lease(
        &target.root.join(".singz-native-import.lock"),
        "Another project is being added or library storage is changing",
    )?;
    validate(target, cancel)?;
    let writer = target.dir.join(".singz-native-write.lock");
    if let Ok(meta) = fs::symlink_metadata(&writer) {
        ensure!(
            meta.is_file() && !linked(&meta) && meta.len() == 0,
            "Invalid project writer lease"
        );
    }
    let _writer = crate::project_publish::lock(&target.dir)?;
    // Do not silently recover a pending publication into a different document
    // after the user confirmed this one. Its owner must recover it first.
    ensure!(
        fs::symlink_metadata(target.dir.join(".singz-native-split.json"))
            .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound),
        "Project has a pending split publication. Reopen it before deleting."
    );
    hook(Point::BeforeHide, &target.dir)?;
    validate(target, cancel)?;
    check(cancel)?;
    static NEXT: AtomicU64 = AtomicU64::new(0);
    let hidden = target.root.join(format!(
        ".singz-native-delete-{}-{}",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    exclusive_move(&target.dir, &hidden).context("Could not exclusively hide the saved project")?;
    let prepared = (|| {
        sync(&target.root)?;
        if let Some(parent) = target.dir.parent() {
            if parent != target.root {
                sync(parent)?;
            }
        }
        ensure!(
            ordinary_dir(&hidden)? == target.project_identity,
            "Hidden project identity changed"
        );
        hook(Point::AfterHide, &hidden)?;
        check(cancel)?;
        hook(Point::BeforeMark, &hidden)?;
        check(cancel)?;
        ensure!(
            ordinary_dir(&target.root)? == target.root_identity,
            "Library folder changed during deletion"
        );
        ensure!(
            crate::project_library::resolved_root(&config)?.canonicalize()? == target.root,
            "The library folder changed during deletion"
        );
        let (tree, _) = scan(&hidden, cancel)?;
        ensure!(tree == target.tree, "Project files changed during deletion");
        crate::sync_dirty::Store::new(configdir.to_owned()).mark_project(&target.dir, "deleted")
    })();
    if let Err(error) = prepared {
        let rollback = (|| {
            ensure!(
                ordinary_dir(&hidden)? == target.project_identity,
                "Hidden project identity changed"
            );
            exclusive_move(&hidden, &target.dir)?;
            sync(&target.root)?;
            if let Some(parent) = target.dir.parent() {
                if parent != target.root {
                    sync(parent)?;
                }
            }
            Ok::<(), anyhow::Error>(())
        })();
        return match rollback {
            Ok(()) => Err(error),
            Err(rollback) => Err(anyhow::anyhow!(
                "{error:#}; deletion did not commit; project retained at {} because rollback refused: {rollback:#}",
                hidden.display()
            )),
        };
    }
    // Durable dirty intent is the commit boundary. Cancellation/navigation after
    // it cannot turn an accepted deletion into a stale/failed receipt.
    let cleanup = (|| {
        hook(Point::AfterMark, &hidden)?;
        check(cancel)?;
        hook(Point::BeforeCleanup, &hidden)?;
        check(cancel)?;
        ensure!(
            ordinary_dir(&hidden)? == target.project_identity,
            "Hidden project identity changed"
        );
        // std's platform implementation does not follow symlinks, and protects
        // against symlink races while recursively unlinking directory members.
        fs::remove_dir_all(&hidden)?;
        sync(&target.root)
    })();
    let warning = cleanup.err().map(|error| {
        if fs::symlink_metadata(&hidden).is_ok() {
            format!(
                "Project deleted; hidden cleanup remains at {}: {error:#}",
                hidden.display()
            )
        } else {
            format!("Project deleted; cleanup durability warning: {error:#}")
        }
    });
    Ok(Outcome {
        dir: target.dir.clone(),
        name: target.name.clone(),
        warning,
    })
}
fn sync(path: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(path)?.sync_all()?;
    let _ = path;
    Ok(())
}
#[cfg(unix)]
fn exclusive_move(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let result = {
        unsafe extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) }
    };
    #[cfg(target_os = "linux")]
    let result = {
        unsafe extern "C" {
            fn renameat2(
                a: i32,
                from: *const std::ffi::c_char,
                b: i32,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> i32;
        }
        unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) }
    };
    if result == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(windows)]
fn exclusive_move(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let mut from: Vec<_> = from.as_os_str().encode_wide().collect();
    let mut to: Vec<_> = to.as_os_str().encode_wide().collect();
    if from.contains(&0) || to.contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Null project path",
        ));
    }
    from.push(0);
    to.push(0);
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 8) } != 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
fn gate(point: Point, cancel: &impl Fn() -> bool) -> Result<()> {
    #[cfg(feature = "ui-tests")]
    {
        let key = match point {
            Point::BeforeHide => Some("SINGZ_GPUI_DELETE_PREPARE_GATE"),
            Point::AfterHide => Some("SINGZ_GPUI_DELETE_HIDDEN_GATE"),
            Point::AfterMark => Some("SINGZ_GPUI_DELETE_COMMIT_GATE"),
            _ => None,
        };
        if let Some(path) = key.and_then(std::env::var_os) {
            ensure!(
                std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                    && std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                    && std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),
                "Deletion gate requires isolated hidden/muted fixture"
            );
            let path = PathBuf::from(path);
            ensure!(path.is_absolute(), "Deletion gate must be absolute");
            fs::write(path.with_extension("ready"), b"ready")?;
            let start = Instant::now();
            while path.exists() {
                check(cancel)?;
                ensure!(
                    start.elapsed() < Duration::from_secs(15),
                    "Deletion gate timed out"
                );
                std::thread::sleep(Duration::from_millis(5));
            }
        }
    }
    let _ = (point, cancel);
    Ok(())
}
#[cfg(test)]
#[path = "project_delete_tests.rs"]
mod tests;

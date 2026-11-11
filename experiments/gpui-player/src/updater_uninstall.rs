//! Removing an installed payload by its own inventory, for the Windows
//! uninstaller (`--uninstall-payload`).
//!
//! The inventory (`manifest.json`, replaced by every update) says which files
//! to delete; it never decides *where*. Every path is walked one component at
//! a time from a handle on the install directory, refusing any link, junction
//! or reparse point on the way, so neither a tampered inventory nor a
//! directory swapped for a link can reach outside the install.
use anyhow::{Context, Result, ensure};
use std::{collections::BTreeSet, path::Path};

/// The installer's copy of the original inventory (never in an update archive).
pub const ORIGINAL_INVENTORY: &str = ".singz-original-manifest.json";
/// Delete every file the payload's `manifest.json` lists, then the emptied
/// directories, deepest first. Every entry is checked before anything is
/// deleted. `keep` (the running executable) is left for the uninstaller.
/// Entries that pass through a link are skipped and reported; files nobody
/// listed stay, and so does any directory still holding them.
pub fn uninstall_payload(install: &Path, keep: &Path) -> Result<()> {
    let root = walk::Root::open(install).context("open the install directory")?;
    // The current inventory (replaced by each update) and the original one
    // the installer laid down: their union is everything ever installed.
    let mut names: Vec<String> = Vec::new();
    let mut found = false;
    for inventory in ["manifest.json", ORIGINAL_INVENTORY] {
        let bytes = match root.read_file(inventory, 16 << 20) {
            Ok(bytes) => bytes,
            Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => continue,
            Err(error) => return Err(error.context(format!("read {inventory}"))),
        };
        found = true;
        let manifest: serde_json::Value = serde_json::from_slice(&bytes).with_context(|| format!("parse {inventory}"))?;
        for entry in manifest["files"].as_array().with_context(|| format!("{inventory} lists no files"))? {
            let name = entry["path"].as_str().context("an inventory entry has no path")?;
            crate::updater_zip::check_name(name)?;
            if !names.iter().any(|n| n == name) {
                names.push(name.to_owned());
            }
        }
    }
    ensure!(found, "no payload inventory");
    let names: Vec<&str> = names.iter().map(String::as_str).collect();
    let mut dirs = BTreeSet::new();
    let mut refused = Vec::new();
    for name in names {
        let mut parent = Path::new(name).parent();
        while let Some(dir) = parent.filter(|d| !d.as_os_str().is_empty()) {
            dirs.insert(dir.to_string_lossy().replace('\\', "/"));
            parent = dir.parent();
        }
        if Path::new(name) == keep {
            continue;
        }
        // A test may make this entry fail once (a transient sharing violation).
        let removed = crate::updater_swap::kill_point("uninstall-remove").and_then(|_| root.remove_file(name));
        match removed {
            // A missing ancestor (an earlier, partly refused attempt removed
            // that subtree) means the entry is already gone. Links and every
            // other error still refuse.
            Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e| e.kind() == std::io::ErrorKind::NotFound) => {}
            Err(error) => refused.push(format!("{name}: {error:#}")),
            Ok(()) => {}
        }
    }
    // A refusal keeps the inventories (and so the uninstall registration
    // NSIS leaves in place), so a later attempt still knows the payload.
    if refused.is_empty() {
        for name in ["manifest.json", ORIGINAL_INVENTORY, crate::updater_swap::MARKER] {
            let _ = root.remove_file(name);
        }
    }
    let mut dirs: Vec<String> = dirs.into_iter().collect();
    dirs.sort_by_key(|d| std::cmp::Reverse(d.split('/').count()));
    for dir in dirs {
        let _ = root.remove_empty_dir(&dir); // only once empty, never through a link
    }
    ensure!(refused.is_empty(), "left in place: {}", refused.join("; "));
    Ok(())
}

#[cfg(unix)]
mod walk {
    use anyhow::{Result, bail};
    use std::{
        ffi::CString,
        io::{self, Read},
        os::{
            fd::{AsRawFd, FromRawFd, OwnedFd},
            unix::ffi::OsStrExt,
        },
        path::Path,
    };
    const DIR_FLAGS: libc::c_int = libc::O_RDONLY | libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    fn cstr(name: &str) -> io::Result<CString> {
        CString::new(name).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))
    }
    fn check(rc: libc::c_int) -> io::Result<libc::c_int> {
        if rc < 0 { Err(io::Error::last_os_error()) } else { Ok(rc) }
    }
    pub struct Root(OwnedFd);
    impl Root {
        pub fn open(path: &Path) -> io::Result<Root> {
            let c = CString::new(path.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput))?;
            // SAFETY: a valid C string; the descriptor is owned below.
            let fd = check(unsafe { libc::open(c.as_ptr(), DIR_FLAGS) })?;
            // SAFETY: `fd` was just opened and is owned by nothing else.
            Ok(Root(unsafe { OwnedFd::from_raw_fd(fd) }))
        }
        /// The directory holding `name`'s last component, reached without
        /// following any link (`O_NOFOLLOW` at every step).
        fn parent_of<'a>(&self, name: &'a str) -> io::Result<(Option<OwnedFd>, &'a str)> {
            let mut parts: Vec<&str> = name.split('/').collect();
            let leaf = parts.pop().unwrap_or("");
            let mut current: Option<OwnedFd> = None;
            for part in parts {
                let at = current.as_ref().map_or(self.0.as_raw_fd(), |fd| fd.as_raw_fd());
                let c = cstr(part)?;
                // SAFETY: a valid directory descriptor and C string.
                let fd = check(unsafe { libc::openat(at, c.as_ptr(), DIR_FLAGS) })?;
                // SAFETY: `fd` was just opened and is owned by nothing else.
                current = Some(unsafe { OwnedFd::from_raw_fd(fd) });
            }
            Ok((current, leaf))
        }
        fn at(&self, dir: &Option<OwnedFd>) -> libc::c_int {
            dir.as_ref().map_or(self.0.as_raw_fd(), |fd| fd.as_raw_fd())
        }
        pub fn read_file(&self, name: &str, limit: u64) -> Result<Vec<u8>> {
            let (dir, leaf) = self.parent_of(name)?;
            let c = cstr(leaf)?;
            // SAFETY: a valid directory descriptor and C string.
            let fd = check(unsafe { libc::openat(self.at(&dir), c.as_ptr(), libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_CLOEXEC) })?;
            // SAFETY: `fd` was just opened and is owned by nothing else.
            let file = std::fs::File::from(unsafe { OwnedFd::from_raw_fd(fd) });
            let mut bytes = Vec::new();
            file.take(limit + 1).read_to_end(&mut bytes)?;
            if bytes.len() as u64 > limit {
                bail!("{name} is too large");
            }
            Ok(bytes)
        }
        /// Unlink a regular file; a link at that name is refused, not followed.
        pub fn remove_file(&self, name: &str) -> Result<()> {
            let (dir, leaf) = self.parent_of(name)?;
            let c = cstr(leaf)?;
            // SAFETY: zeroed `stat` is a valid out-buffer.
            let mut st: libc::stat = unsafe { std::mem::zeroed() };
            // SAFETY: valid descriptor, C string and out-pointer.
            match check(unsafe { libc::fstatat(self.at(&dir), c.as_ptr(), &mut st, libc::AT_SYMLINK_NOFOLLOW) }) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
                Err(error) => return Err(error.into()),
                Ok(_) => {}
            }
            if st.st_mode & libc::S_IFMT != libc::S_IFREG {
                bail!("not a regular file");
            }
            // SAFETY: valid descriptor and C string; unlinkat never follows the leaf.
            check(unsafe { libc::unlinkat(self.at(&dir), c.as_ptr(), 0) })?;
            Ok(())
        }
        pub fn remove_empty_dir(&self, name: &str) -> Result<()> {
            let (dir, leaf) = self.parent_of(name)?;
            let c = cstr(leaf)?;
            // SAFETY: valid descriptor and C string; AT_REMOVEDIR fails on a link.
            check(unsafe { libc::unlinkat(self.at(&dir), c.as_ptr(), libc::AT_REMOVEDIR) })?;
            Ok(())
        }
    }
}

#[cfg(windows)]
mod walk {
    use anyhow::{Result, ensure};
    use std::{
        ffi::c_void,
        fs::{File, OpenOptions},
        io::{self, Read},
        os::windows::{
            fs::{MetadataExt, OpenOptionsExt},
            io::AsRawHandle,
        },
        path::{Path, PathBuf},
    };
    const DELETE: u32 = 0x0001_0000;
    const FILE_READ_ATTRIBUTES: u32 = 0x0080;
    const GENERIC_READ: u32 = 0x8000_0000;
    const FILE_SHARE_READ: u32 = 0x1;
    const FILE_SHARE_WRITE: u32 = 0x2;
    const FILE_SHARE_DELETE: u32 = 0x4;
    const FILE_FLAG_BACKUP_SEMANTICS: u32 = 0x0200_0000;
    const FILE_FLAG_OPEN_REPARSE_POINT: u32 = 0x0020_0000;
    const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
    const FILE_DISPOSITION_INFO_CLASS: i32 = 4; // FileDispositionInfo
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn SetFileInformationByHandle(file: *mut c_void, class: i32, info: *const c_void, size: u32) -> i32;
    }
    /// Open a directory itself (never a junction's target), and keep it from
    /// being renamed or replaced while the handle lives (no delete sharing).
    fn pin_dir(path: &Path) -> io::Result<File> {
        let file = OpenOptions::new()
            .access_mode(FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE)
            .custom_flags(FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT)
            .open(path)?;
        let meta = file.metadata()?;
        if !meta.is_dir() || meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT != 0 {
            return Err(io::Error::new(io::ErrorKind::InvalidInput, "a link or junction in the path"));
        }
        Ok(file)
    }
    /// Open the entry itself with DELETE access, re-check through that very
    /// handle that it is the kind expected and not a reparse point, and mark
    /// that handle for deletion: nothing is resolved by name afterwards.
    fn delete_entry(path: &Path, directory: bool) -> Result<()> {
        let opened = OpenOptions::new()
            .access_mode(DELETE | FILE_READ_ATTRIBUTES)
            .share_mode(FILE_SHARE_READ | FILE_SHARE_WRITE | FILE_SHARE_DELETE)
            .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT | FILE_FLAG_BACKUP_SEMANTICS)
            .open(path);
        let file = match opened {
            Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(()),
            other => other?,
        };
        let meta = file.metadata()?;
        ensure!(meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0, "a link or junction");
        ensure!(meta.is_dir() == directory, "not the expected kind of entry");
        let delete: u8 = 1; // FILE_DISPOSITION_INFO { DeleteFile: TRUE }
        // SAFETY: a live handle opened with DELETE access and a one-byte FILE_DISPOSITION_INFO.
        let ok = unsafe {
            SetFileInformationByHandle(file.as_raw_handle(), FILE_DISPOSITION_INFO_CLASS, (&delete as *const u8).cast(), 1)
        };
        ensure!(ok != 0, "delete: {}", io::Error::last_os_error());
        Ok(())
    }
    pub struct Root {
        path: PathBuf,
        _pinned: File,
    }
    impl Root {
        pub fn open(path: &Path) -> io::Result<Root> {
            Ok(Root { _pinned: pin_dir(path)?, path: path.to_path_buf() })
        }
        /// Every directory on the way to `name`, pinned and checked.
        fn pin_parents(&self, name: &str) -> io::Result<(Vec<File>, PathBuf)> {
            let mut parts: Vec<&str> = name.split('/').collect();
            let leaf = parts.pop().unwrap_or("");
            let (mut pins, mut current) = (Vec::new(), self.path.clone());
            for part in parts {
                current.push(part);
                pins.push(pin_dir(&current)?);
            }
            current.push(leaf);
            Ok((pins, current))
        }
        pub fn read_file(&self, name: &str, limit: u64) -> Result<Vec<u8>> {
            let (_pins, path) = self.pin_parents(name)?;
            let file = OpenOptions::new()
                .access_mode(GENERIC_READ)
                .share_mode(FILE_SHARE_READ)
                .custom_flags(FILE_FLAG_OPEN_REPARSE_POINT)
                .open(&path)?;
            ensure!(file.metadata()?.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0, "{name} is a link");
            let mut bytes = Vec::new();
            file.take(limit + 1).read_to_end(&mut bytes)?;
            ensure!(bytes.len() as u64 <= limit, "{name} is too large");
            Ok(bytes)
        }
        pub fn remove_file(&self, name: &str) -> Result<()> {
            let (_pins, path) = self.pin_parents(name)?;
            delete_entry(&path, false)
        }
        pub fn remove_empty_dir(&self, name: &str) -> Result<()> {
            let (_pins, path) = self.pin_parents(name)?;
            delete_entry(&path, true)
        }
    }
}

#[cfg(not(any(unix, windows)))]
mod walk {
    pub struct Root;
    impl Root {
        pub fn open(_: &std::path::Path) -> std::io::Result<Root> {
            Err(std::io::Error::from(std::io::ErrorKind::Unsupported))
        }
        pub fn read_file(&self, _: &str, _: u64) -> anyhow::Result<Vec<u8>> {
            unreachable!()
        }
        pub fn remove_file(&self, _: &str) -> anyhow::Result<()> {
            unreachable!()
        }
        pub fn remove_empty_dir(&self, _: &str) -> anyhow::Result<()> {
            unreachable!()
        }
    }
}

#[cfg(test)]
#[path = "updater_uninstall_tests.rs"]
mod tests;

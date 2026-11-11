//! Electron defaults, verified against Electron v38 shell/app/electron_main_delegate.cc
//! (ElectronPathProvider), shell/common/electron_paths.h (DIR_APP_DATA), and
//! Chromium base/base_paths_mac.mm / base_paths_win.cc. Never uses Electron's browser database.
use anyhow::{Result, ensure};
use serde_json::Value;
use std::{
    fs::{self, File, Metadata, OpenOptions},
    io::Read,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug)]
pub(super) enum Platform {
    Mac,
    Windows,
    Linux,
}
/// Explicit inputs make foreign-platform fixture layouts independent of host env.
pub(super) fn profiles(platform: Platform, home: &Path, appdata: Option<&Path>) -> Vec<PathBuf> {
    let base = match platform {
        Platform::Mac => home.join("Library/Application Support"),
        Platform::Windows => appdata
            .map(Path::to_owned)
            .unwrap_or_else(|| home.join("AppData/Roaming")),
        Platform::Linux => appdata
            .map(Path::to_owned)
            .unwrap_or_else(|| home.join(".config")),
    };
    // Prefer the packaged desktop. Never merge profiles or consult SingZ Box.
    ["SingZ", "singz", "Electron"]
        .map(|name| base.join(name))
        .to_vec()
}
/// Case-insensitive filesystems consider `SingZ` and `singz` the same path.
/// Use the actual directory entry to preserve identity and stable provenance.
pub(super) fn profile_exists(path: &Path) -> Result<bool> {
    let Some(parent) = path.parent() else {
        return Ok(false);
    };
    let Some(name) = path.file_name() else {
        return Ok(false);
    };
    let entries = match fs::read_dir(parent) {
        Ok(entries) => entries,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(false),
        Err(e) => return Err(e.into()),
    };
    for entry in entries {
        let entry = entry?;
        if entry.file_name() == name {
            return Ok(path.is_dir());
        }
    }
    Ok(false)
}

fn linked(meta: &Metadata) -> bool {
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        return meta.file_attributes() & 0x400 != 0;
    }
    #[cfg(not(windows))]
    meta.file_type().is_symlink()
}
pub(super) fn ordinary_path(path: &Path) -> Result<()> {
    // HOME and the platform config directory may legitimately be symlinked.
    // Refuse the object we open, not the user's directory topology. Reads also
    // use O_NOFOLLOW / OPEN_REPARSE_POINT and verify the opened file identity.
    let meta = fs::symlink_metadata(path)?;
    ensure!(!linked(&meta), "Linked migration path");
    Ok(())
}
fn same(a: &Metadata, b: &Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        if (a.dev(), a.ino(), a.ctime(), a.ctime_nsec())
            != (b.dev(), b.ino(), b.ctime(), b.ctime_nsec())
        {
            return false;
        }
    }
    a.len() == b.len() && a.modified().ok() == b.modified().ok()
}
/// Missing is terminal; malformed, changing, linked or unreadable is retryable.
/// Reads are bounded even if an Electron writer grows the file after stat.
pub(super) fn read(path: &Path, limit: u64) -> Result<Option<Value>> {
    match fs::symlink_metadata(path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(_) => {}
    }
    ordinary_path(path)?;
    let before = fs::symlink_metadata(path)?;
    ensure!(
        before.is_file() && before.len() > 0 && before.len() <= limit,
        "Invalid source size or type"
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
    let file: File = options.open(path)?;
    let opened = file.metadata()?;
    ensure!(
        !linked(&opened) && opened.is_file() && same(&before, &opened),
        "Source changed while opening"
    );
    let mut bytes = vec![];
    file.take(limit + 1).read_to_end(&mut bytes)?;
    ordinary_path(path)?;
    ensure!(
        bytes.len() as u64 <= limit && same(&before, &fs::symlink_metadata(path)?),
        "Source changed while reading"
    );
    let raw: Value = serde_json::from_slice(&bytes)?;
    ensure!(raw.is_object(), "Source is not a JSON object");
    Ok(Some(raw))
}

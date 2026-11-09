//! Filesystem identity captured before a project can move or be replaced.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use std::{
    fs::{self, File, Metadata},
    path::Path,
    time::{SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct DirectoryIdentity {
    platform: String,
    volume: u64,
    file: u64,
    /// Birth time distinguishes persistent receipts from later inode reuse.
    created: Option<CreationTime>,
}
#[derive(Debug)]
pub struct PersistentIdentityUnavailable;
impl std::fmt::Display for PersistentIdentityUnavailable {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str(
            "Filesystem birth identity is unavailable; persistent retirement is not authorized",
        )
    }
}
impl std::error::Error for PersistentIdentityUnavailable {}
pub fn is_persistent_unavailable(error: &anyhow::Error) -> bool {
    error
        .chain()
        .any(|cause| cause.is::<PersistentIdentityUnavailable>())
}
impl DirectoryIdentity {
    pub fn persistent_eligible(&self) -> bool {
        self.created.is_some()
    }
    pub fn require_persistent(&self) -> Result<()> {
        if !self.persistent_eligible() {
            return Err(PersistentIdentityUnavailable.into());
        }
        Ok(())
    }
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
struct CreationTime {
    before_epoch: bool,
    seconds: u64,
    nanos: u32,
}
fn created(time: std::io::Result<SystemTime>) -> Option<CreationTime> {
    time.ok().map(|time| match time.duration_since(UNIX_EPOCH) {
        Ok(value) => CreationTime {
            before_epoch: false,
            seconds: value.as_secs(),
            nanos: value.subsec_nanos(),
        },
        Err(error) => {
            let value = error.duration();
            CreationTime {
                before_epoch: true,
                seconds: value.as_secs(),
                nanos: value.subsec_nanos(),
            }
        }
    })
}
fn ordinary(meta: &Metadata) -> Result<()> {
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Directory identity requires an ordinary directory"
    );
    Ok(())
}
#[cfg(unix)]
fn from_file(file: &File) -> Result<DirectoryIdentity> {
    use std::os::unix::fs::MetadataExt;
    let meta = file.metadata()?;
    ordinary(&meta)?;
    Ok(DirectoryIdentity {
        platform: std::env::consts::OS.into(),
        volume: meta.dev(),
        file: meta.ino(),
        created: created(meta.created()),
    })
}
#[cfg(windows)]
fn from_file(file: &File) -> Result<DirectoryIdentity> {
    use std::os::windows::io::AsRawHandle;
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
    let mut info: Info = unsafe { std::mem::zeroed() };
    ensure!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0,
        "Could not read directory identity"
    );
    ensure!(
        info.attributes & 0x10 != 0 && info.attributes & 0x400 == 0,
        "Linked directory identity refused"
    );
    Ok(DirectoryIdentity {
        platform: "windows".into(),
        volume: info.volume as u64,
        file: ((info.index_high as u64) << 32) | info.index_low as u64,
        created: created(file.metadata()?.created()),
    })
}
#[cfg(not(any(unix, windows)))]
fn from_file(_file: &File) -> Result<DirectoryIdentity> {
    anyhow::bail!("Stable directory identity is unsupported on this platform")
}
fn open(path: &Path) -> Result<File> {
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        Ok(fs::OpenOptions::new()
            .read(true)
            .custom_flags(0x02000000 | 0x00200000)
            .open(path)?)
    }
    #[cfg(not(windows))]
    {
        Ok(File::open(path)?)
    }
}
pub fn read(path: &Path) -> Result<DirectoryIdentity> {
    ordinary(&fs::symlink_metadata(path)?)?;
    let first = from_file(&open(path)?)?;
    ordinary(&fs::symlink_metadata(path)?)?;
    let current = from_file(&open(path)?)?;
    ensure!(first == current, "Directory changed while identifying it");
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn inode_without_birth_time_cannot_authorize_persistent_retirement() {
        let identity = DirectoryIdentity {
            platform: "unix".into(),
            volume: 1,
            file: 42,
            created: None,
        };
        assert!(!identity.persistent_eligible());
        assert!(is_persistent_unavailable(
            &identity.require_persistent().unwrap_err()
        ));
        let decoded: DirectoryIdentity =
            serde_json::from_slice(&serde_json::to_vec(&identity).unwrap()).unwrap();
        assert!(!decoded.persistent_eligible());
    }
    #[test]
    fn identity_survives_rename_but_not_same_name_replacement() {
        let root = std::env::temp_dir().join(format!(
            "singz-directory-identity-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir_all(root.join("Old")).unwrap();
        let old = read(&root.join("Old")).unwrap();
        fs::rename(root.join("Old"), root.join("Moved")).unwrap();
        assert_eq!(old, read(&root.join("Moved")).unwrap());
        fs::create_dir(root.join("Old")).unwrap();
        assert_ne!(old, read(&root.join("Old")).unwrap());
        let encoded = serde_json::to_vec(&old).unwrap();
        assert_eq!(
            old,
            serde_json::from_slice::<DirectoryIdentity>(&encoded).unwrap()
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn linked_or_regular_file_cannot_supply_directory_authority() {
        use std::os::unix::fs::symlink;
        let root = std::env::temp_dir().join(format!(
            "singz-directory-link-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        fs::write(root.join("file"), b"private").unwrap();
        symlink(&root, root.join("linked")).unwrap();
        assert!(read(&root.join("file")).is_err());
        assert!(read(&root.join("linked")).is_err());
        fs::remove_dir_all(root).unwrap();
    }
}

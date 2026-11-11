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
    /// Birth time alone can repeat within one Linux clock tick on inode reuse.
    created: Option<CreationTime>,
    /// Linux inode incarnation, read from the same open directory as metadata.
    /// Omission preserves old content-addressed records on macOS and Windows.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    generation: Option<u32>,
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
#[derive(Debug)]
pub(crate) struct IdentityRetry;
impl std::fmt::Display for IdentityRetry {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Filesystem identity is temporarily unverifiable; retry later")
    }
}
impl std::error::Error for IdentityRetry {}
pub(crate) fn is_retry(error: &anyhow::Error) -> bool {
    error.is::<IdentityRetry>()
}
/// Directional compatibility, separate from exact, transitive structural Eq.
/// A released record asserts only its saved fields; a missing live generation
/// cannot disprove or authorize a generation-bearing record.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum Comparison {
    Match,
    Different,
    Retry,
}
#[cfg(test)]
thread_local! {
    static TEST_GENERATION: std::cell::Cell<Option<Option<u32>>> = const { std::cell::Cell::new(None) };
}
#[cfg(test)]
pub(crate) fn with_test_generation<T>(generation: Option<u32>, run: impl FnOnce() -> T) -> T {
    struct Restore(Option<Option<u32>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_GENERATION.with(|v| v.set(self.0));
        }
    }
    let _restore = Restore(TEST_GENERATION.with(|v| v.replace(Some(generation))));
    run()
}
fn observe(file: &File) -> Result<DirectoryIdentity> {
    #[allow(unused_mut)]
    let mut identity = from_file(file)?;
    #[cfg(test)]
    TEST_GENERATION.with(|value| {
        if let Some(generation) = value.get() {
            identity.platform = "linux".into();
            identity.generation = generation;
        }
    });
    Ok(identity)
}
impl DirectoryIdentity {
    pub(crate) fn compare_live(&self, live: &Self) -> Comparison {
        if self.platform != live.platform
            || self.volume != live.volume
            || self.file != live.file
            || self.created != live.created
        {
            return Comparison::Different;
        }
        // A missing generation cannot make an already different inode uncertain.
        if self.generation.is_some() && live.generation.is_none() {
            return Comparison::Retry;
        }
        match (self.generation, live.generation) {
            (Some(saved), Some(current)) if saved != current => Comparison::Different,
            _ => Comparison::Match,
        }
    }
    pub(crate) fn matches_live(&self, live: &Self) -> Result<bool> {
        match self.compare_live(live) {
            Comparison::Match => Ok(true),
            Comparison::Different => Ok(false),
            Comparison::Retry => Err(IdentityRetry.into()),
        }
    }
    pub(crate) fn matches_path(&self, path: &Path) -> Result<bool> {
        self.matches_live(&read(path)?)
    }
    /// Two saved records may each predate generation support. Neither missing
    /// field is evidence of a failed live ioctl; compare only shared claims.
    pub(crate) fn compatible_record(&self, other: &Self) -> bool {
        self.legacy_key() == other.legacy_key()
            && (self.generation.is_none()
                || other.generation.is_none()
                || self.generation == other.generation)
    }
    /// Lookup keys retain the released layout; actual records keep generation.
    pub(crate) fn legacy_key(&self) -> Self {
        let mut key = self.clone();
        key.generation = None;
        key
    }
    pub fn persistent_eligible(&self) -> bool {
        // Unsupported Linux filesystems retain the released birth-time rule.
        // Inode-reuse protection is unavailable when the ioctl has no generation.
        self.created.is_some()
    }
    pub fn require_persistent(&self) -> Result<()> {
        if !self.persistent_eligible() {
            return Err(PersistentIdentityUnavailable.into());
        }
        Ok(())
    }
}
#[cfg(target_os = "linux")]
fn inode_generation(file: &File) -> Option<u32> {
    use std::os::fd::AsRawFd;
    // FS_IOC_GETVERSION encodes sizeof(long), but ext4/xfs/btrfs write an int.
    // Preserve all 32 generation bits, including a valid zero generation.
    let mut value: libc::c_int = 0;
    loop {
        // SAFETY: file owns a live descriptor and value is a writable int for
        // the duration of this synchronous ioctl. libc supplies the native ABI
        // request number (including the architecture's sizeof(long)).
        let result = unsafe { libc::ioctl(file.as_raw_fd(), libc::FS_IOC_GETVERSION, &mut value) };
        if result >= 0 {
            return Some(value as u32);
        }
        if std::io::Error::last_os_error().kind() != std::io::ErrorKind::Interrupted {
            // None also represents a denied/unavailable ioctl. compare_live
            // defers a saved Some rather than treating this as replacement.
            return None;
        }
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
        #[cfg(target_os = "linux")]
        generation: inode_generation(file),
        #[cfg(not(target_os = "linux"))]
        generation: None,
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
        generation: None,
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
    let first = observe(&open(path)?)?;
    ordinary(&fs::symlink_metadata(path)?)?;
    let current = observe(&open(path)?)?;
    if first.legacy_key() == current.legacy_key()
        && first.generation.is_some() != current.generation.is_some()
    {
        return Err(IdentityRetry.into());
    }
    ensure!(first == current, "Directory changed while identifying it");
    Ok(first)
}

#[cfg(test)]
mod tests {
    use super::*;
    const OLD_LINUX: &str = r#"{"platform":"linux","volume":168,"file":3447087,"created":{"before_epoch":false,"seconds":1794378511,"nanos":327800163}}"#;
    fn linux_with_generation(generation: u32) -> DirectoryIdentity {
        let mut value: serde_json::Value = serde_json::from_str(OLD_LINUX).unwrap();
        value["generation"] = generation.into();
        serde_json::from_value(value).unwrap()
    }
    #[test]
    fn legacy_linux_record_matches_live_fields_without_weakening_exact_equality() {
        let old: DirectoryIdentity = serde_json::from_str(OLD_LINUX).unwrap();
        let current = linux_with_generation(7);
        assert!(old.persistent_eligible());
        old.require_persistent().unwrap();
        assert_eq!(serde_json::to_string(&old).unwrap(), OLD_LINUX);
        assert!(old.matches_live(&current).unwrap());
        assert_ne!(old, current, "Structural equality must stay exact");
        let mut without_birth = current.clone();
        without_birth.created = None;
        assert!(!without_birth.persistent_eligible());
    }
    #[test]
    fn generation_loss_is_retry_not_replacement() {
        let saved = linux_with_generation(7);
        let live: DirectoryIdentity = serde_json::from_str(OLD_LINUX).unwrap();
        assert_eq!(saved.compare_live(&live), Comparison::Retry);
        let mut different = saved.clone();
        different.file += 1;
        assert_eq!(saved.compare_live(&different), Comparison::Different);
    }
    #[test]
    fn different_inode_without_live_generation_is_different_not_retry() {
        let saved = linux_with_generation(7);
        let mut live: DirectoryIdentity = serde_json::from_str(OLD_LINUX).unwrap();
        live.file += 1;
        assert_eq!(saved.compare_live(&live), Comparison::Different);
    }
    #[test]
    fn linux_generation_distinguishes_identical_inode_and_birth_time() {
        let first = linux_with_generation(7);
        let reused = linux_with_generation(8);
        assert_ne!(first, reused);
        assert!(!first.matches_live(&reused).unwrap());
        assert_eq!(first, linux_with_generation(7));
        assert!(linux_with_generation(0).persistent_eligible());
        assert_ne!(first, linux_with_generation(u32::MAX));
        assert_eq!(
            first,
            serde_json::from_slice::<DirectoryIdentity>(&serde_json::to_vec(&first).unwrap())
                .unwrap()
        );
    }
    #[test]
    fn existing_macos_and_windows_records_round_trip_byte_identically() {
        for platform in ["macos", "windows"] {
            let encoded = OLD_LINUX.replace("linux", platform);
            let identity: DirectoryIdentity = serde_json::from_str(&encoded).unwrap();
            assert!(identity.persistent_eligible());
            assert_eq!(serde_json::to_string(&identity).unwrap(), encoded);
        }
    }
    #[cfg(target_os = "linux")]
    #[test]
    fn linux_immediate_directory_recreation_changes_identity_200_times() {
        // Exercise the checkout's filesystem, rather than a potentially tmpfs
        // /tmp mount that cannot supply FS_IOC_GETVERSION.
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
                "singz-inode-reuse-{}",
                crate::drive_http::random_id().unwrap()
            ));
        fs::create_dir_all(&root).unwrap();
        let path = root.join("Song");
        fs::create_dir(&path).unwrap();
        let mut old = read(&path).unwrap();
        let mut reported_unavailable = false;
        for iteration in 0..200 {
            fs::remove_dir(&path).unwrap();
            fs::create_dir(&path).unwrap();
            let current = read(&path).unwrap();
            if current.generation.is_none() {
                if !reported_unavailable {
                    // Write directly so libtest does not hide this warning on success.
                    std::io::Write::write_all(&mut std::io::stderr().lock(), b"generation unavailable on this filesystem: inode-reuse protection not provable here\n").unwrap();
                    reported_unavailable = true;
                }
                // Check the released-field fallback, rather than promising
                // uniqueness on a filesystem without inode generations.
                let expected = if old.legacy_key() != current.legacy_key() {
                    Comparison::Different
                } else if old.generation.is_some() {
                    Comparison::Retry
                } else {
                    Comparison::Match
                };
                assert_eq!(old.compare_live(&current), expected);
                assert_eq!(current.persistent_eligible(), current.created.is_some());
            } else {
                assert_ne!(
                    old, current,
                    "directory reused identity at iteration {iteration}"
                );
            }
            old = current;
        }
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn inode_without_birth_time_cannot_authorize_persistent_retirement() {
        let identity = DirectoryIdentity {
            platform: "unix".into(),
            volume: 1,
            file: 42,
            created: None,
            generation: None,
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
        let root = Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("target")
            .join(format!(
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

//! Identity-bound recovery of a finalized native WAV, never of live/RAM audio.
//! Only the native recording owner mints these capabilities after finish settles.
use crate::training_recording_store::{ordinary, read_bounded, stamp, valid_name, Stamp};
use anyhow::{ensure, Context, Result};
use sha2::{Digest, Sha256};
use std::{
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::SystemTime,
};

#[derive(Clone, Debug)]
struct PinnedFile(Arc<File>);
impl PartialEq for PinnedFile {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}
impl Eq for PinnedFile {}
/// Linking/unlinking a legitimate name changes ctime, but not these fields.
/// A reserved original handle prevents an unlinked inode identity being reused.
#[derive(Clone, Debug, PartialEq, Eq)]
struct StableStamp {
    identity: (u64, u64),
    bytes: u64,
    modified: Option<SystemTime>,
}
impl StableStamp {
    fn capture(file: &File) -> Result<Self> {
        let meta = file.metadata()?;
        ensure!(
            meta.file_type().is_file(),
            "Pinned recording must be ordinary"
        );
        Ok(Self {
            identity: stamp(file)?.identity,
            bytes: meta.len(),
            modified: meta.modified().ok(),
        })
    }
}

#[derive(Clone, Debug)]
struct Directory {
    path: PathBuf,
    identity: (u64, u64),
    // Reserve the original identity even if a directory is unlinked/replaced.
    handle: Arc<File>,
}
impl PartialEq for Directory {
    fn eq(&self, other: &Self) -> bool {
        self.path == other.path && self.identity == other.identity
    }
}
impl Eq for Directory {}
impl Directory {
    fn capture(path: &Path) -> Result<Self> {
        ensure!(
            fs::symlink_metadata(path)?.file_type().is_dir(),
            "Recovery directory must be ordinary"
        );
        ensure!(
            path.canonicalize()? == path,
            "Recovery directory contains a link or alias"
        );
        let file = open_directory(path)?;
        let identity = directory_identity(&file)?;
        ensure!(
            identity == directory_identity(&open_directory(path)?)?,
            "Recovery directory changed while opening"
        );
        Ok(Self {
            path: path.into(),
            identity,
            handle: Arc::new(file),
        })
    }
    fn validate(&self) -> Result<()> {
        ensure!(
            directory_identity(&self.handle)? == self.identity,
            "Original recovery directory handle changed"
        );
        ensure!(
            *self == Self::capture(&self.path)?,
            "Recovery directory was replaced"
        );
        Ok(())
    }
}
fn open_directory(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW | libc::O_DIRECTORY | libc::O_NONBLOCK);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x02200000); // BACKUP_SEMANTICS | OPEN_REPARSE_POINT
    }
    let file = options.open(path)?;
    ensure!(
        file.metadata()?.is_dir(),
        "Recovery directory handle changed"
    );
    Ok(file)
}
fn directory_identity(file: &File) -> Result<(u64, u64)> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        let meta = file.metadata()?;
        Ok((meta.dev(), meta.ino()))
    }
    #[cfg(windows)]
    {
        use std::os::windows::io::AsRawHandle;
        #[repr(C)]
        struct Info {
            attributes: u32,
            created: [u32; 2],
            accessed: [u32; 2],
            written: [u32; 2],
            volume: u32,
            high: u32,
            low: u32,
            links: u32,
            index_high: u32,
            index_low: u32,
        }
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn GetFileInformationByHandle(file: *mut std::ffi::c_void, info: *mut Info) -> i32;
        }
        let mut info = std::mem::MaybeUninit::<Info>::uninit();
        ensure!(
            unsafe { GetFileInformationByHandle(file.as_raw_handle(), info.as_mut_ptr()) } != 0,
            "Cannot identify recovery directory"
        );
        let info = unsafe { info.assume_init() };
        ensure!(
            info.attributes & 0x400 == 0,
            "Recovery directory is a reparse point"
        );
        Ok((
            info.volume as u64,
            ((info.index_high as u64) << 32) | info.index_low as u64,
        ))
    }
    #[cfg(not(any(unix, windows)))]
    anyhow::bail!("Recovery directory identity is unavailable")
}

#[derive(Clone, Debug, PartialEq, Eq)]
struct Published {
    path: PathBuf,
    expected: StableStamp,
    handle: PinnedFile,
}
#[derive(Clone, Debug, Default)]
struct Publication(Arc<Mutex<Option<Published>>>);
impl PartialEq for Publication {
    fn eq(&self, other: &Self) -> bool {
        Arc::ptr_eq(&self.0, &other.0)
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Recovery {
    root: Directory,
    stage: Directory,
    nested: Option<Directory>,
    source: PathBuf,
    filename: String,
    source_stamp: Stamp,
    source_handle: PinnedFile,
    digest: [u8; 32],
    seconds: f64,
    sample_rate: u32,
    publication: Publication,
}

/// Exact owned direct WAV captured before normal publication begins. This proof
/// is retained across sync/link failure; fallback cannot authorize a new file.
pub(crate) struct SourcePin {
    root: Directory,
    stage: Directory,
    source: PathBuf,
    filename: String,
    expected: StableStamp,
    handle: PinnedFile,
    bytes: Vec<u8>,
    digest: [u8; 32],
    seconds: f64,
    sample_rate: u32,
}
impl std::fmt::Debug for SourcePin {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("SourcePin")
            .field("source", &self.source)
            .field("expected", &self.expected)
            .field("digest", &self.digest)
            .field("seconds", &self.seconds)
            .field("sample_rate", &self.sample_rate)
            .finish_non_exhaustive()
    }
}
impl SourcePin {
    pub(crate) fn seconds(&self) -> f64 {
        self.seconds
    }
    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    fn verify_source(&self) -> Result<()> {
        self.root.validate()?;
        self.stage.validate()?;
        ensure!(
            StableStamp::capture(&self.handle.0)? == self.expected,
            "Original recording handle changed"
        );
        let mut source = ordinary(&self.source)?;
        let before = stamp(&source)?;
        ensure!(
            StableStamp::capture(&source)? == self.expected,
            "Pinned recording source was replaced or modified"
        );
        let bytes = read_bounded(&mut source, &|| false)?;
        ensure!(
            stamp(&source)? == before
                && StableStamp::capture(&ordinary(&self.source)?)? == self.expected
                && bytes == self.bytes
                && <[u8; 32]>::from(Sha256::digest(&bytes)) == self.digest,
            "Pinned recording source content changed"
        );
        self.root.validate()?;
        self.stage.validate()?;
        Ok(())
    }
    pub(crate) fn sync_all(&self) -> Result<()> {
        self.verify_source()?;
        #[cfg(not(windows))]
        self.handle.0.sync_all()?;
        #[cfg(windows)]
        {
            use std::os::windows::fs::OpenOptionsExt;
            // FlushFileBuffers needs write access. Keep the original handle
            // reserved and bind this writable, share-delete handle to it.
            let mut file = OpenOptions::new()
                .read(true)
                .write(true)
                .custom_flags(0x00200000)
                .share_mode(7)
                .open(&self.source)?;
            ensure!(
                StableStamp::capture(&file)? == self.expected,
                "Recording changed before Windows sync"
            );
            ensure!(
                read_bounded(&mut file, &|| false)? == self.bytes,
                "Recording content changed before Windows sync"
            );
            file.sync_all()?;
        }
        self.verify_source()
    }
    pub(crate) fn verify_hard_link(&self, destination: &Path) -> Result<()> {
        self.verify_source()?;
        ensure!(
            destination
                .file_name()
                .is_some_and(|n| n == self.filename.as_str())
                && destination
                    .parent()
                    .context("Recording destination has no parent")?
                    .canonicalize()?
                    == self.root.path,
            "Pinned recording destination changed"
        );
        let mut published = ordinary(destination)?;
        let before = stamp(&published)?;
        ensure!(
            StableStamp::capture(&published)? == self.expected,
            "Published recording does not reference its pinned source"
        );
        ensure!(
            read_bounded(&mut published, &|| false)? == self.bytes
                && stamp(&published)? == before
                && StableStamp::capture(&ordinary(destination)?)? == self.expected,
            "Published recording changed during validation"
        );
        self.verify_source()
    }
    pub(crate) fn require_recovery(&self, recovery: &Recovery) -> Result<()> {
        self.verify_source()?;
        ensure!(
            self.root == recovery.root
                && self.stage == recovery.stage
                && recovery.nested.is_none()
                && self.source == recovery.source
                && self.filename == recovery.filename
                && self.digest == recovery.digest
                && self.seconds == recovery.seconds
                && self.sample_rate == recovery.sample_rate
                && StableStamp::capture(&recovery.source_handle.0)? == self.expected,
            "Recovery no longer matches the original pinned recording"
        );
        ensure!(
            recovery.read_verified(&|| false)? == self.bytes,
            "Recovery content differs from the original pinned recording"
        );
        self.verify_source()
    }
}

/// Proof captured when the host exclusively creates its native recording stage.
/// Later recovery cannot re-authorize a replacement directory at the same path.
#[derive(Clone, Debug, PartialEq, Eq)]
pub(crate) struct OwnedStage {
    root: Directory,
    stage: Directory,
}
impl OwnedStage {
    pub(crate) fn new(root: &Path, stage_dir: &Path) -> Result<Self> {
        let (root, stage) = owned_directories(root, stage_dir)?;
        Ok(Self { root, stage })
    }
    pub(crate) fn capture(&self, filename: &str, take_id: u64) -> Result<Recovery> {
        self.root.validate()?;
        self.stage.validate()?;
        let recovered = capture(&self.root.path, &self.stage.path, filename, take_id)?;
        ensure!(
            recovered.root == self.root && recovered.stage == self.stage,
            "Recording stage changed before recovery"
        );
        self.root.validate()?;
        self.stage.validate()?;
        Ok(recovered)
    }
    pub(crate) fn pin_direct(&self, filename: &str) -> Result<SourcePin> {
        self.root.validate()?;
        self.stage.validate()?;
        ensure!(
            valid_name(Path::new(filename)) && Path::new(filename).components().count() == 1,
            "Invalid pinned native recording filename"
        );
        let source = self.stage.path.join(filename);
        let mut file = ordinary(&source)?;
        let before = stamp(&file)?;
        let expected = StableStamp::capture(&file)?;
        let bytes = read_bounded(&mut file, &|| false)?;
        ensure!(
            stamp(&file)? == before && stamp(&ordinary(&source)?)? == before,
            "Native recording changed while pinning"
        );
        let header: &[u8; 44] = bytes
            .get(..44)
            .context("Incomplete native recording header")?
            .try_into()?;
        let (seconds, sample_rate) = crate::microphone::recording_wav(header, bytes.len() as u64)?;
        let pin = SourcePin {
            root: self.root.clone(),
            stage: self.stage.clone(),
            source,
            filename: filename.into(),
            expected,
            handle: PinnedFile(Arc::new(file)),
            digest: Sha256::digest(&bytes).into(),
            bytes,
            seconds,
            sample_rate,
        };
        pin.verify_source()?;
        Ok(pin)
    }
}

fn owned_directories(root: &Path, stage_dir: &Path) -> Result<(Directory, Directory)> {
    ensure!(
        root.is_absolute()
            && stage_dir.is_absolute()
            && root.file_name().is_some_and(|n| n == "training-recordings"),
        "Invalid recording recovery directory identity"
    );
    ensure!(
        fs::symlink_metadata(root)?.file_type().is_dir(),
        "Recording root must be ordinary"
    );
    let root_path = root.canonicalize()?;
    let stage_name = stage_dir
        .file_name()
        .and_then(|n| n.to_str())
        .context("Recovery stage has no name")?;
    ensure!(
        stage_name.starts_with(".take-")
            && stage_name
                .bytes()
                .all(|n| n.is_ascii_alphanumeric() || matches!(n, b'.' | b'-'))
            && stage_dir
                .parent()
                .context("Recovery stage has no parent")?
                .canonicalize()?
                == root_path,
        "Recovery stage is not a direct owned recording child"
    );
    let root = Directory::capture(&root_path)?;
    let stage = Directory::capture(&root_path.join(stage_name))?;
    Ok((root, stage))
}

/// Caller must have established that this take's native finish is quiescent.
/// Only its two exact generated filenames are inspected, never a recursive scan.
pub(crate) fn capture(
    root: &Path,
    stage_dir: &Path,
    filename: &str,
    take_id: u64,
) -> Result<Recovery> {
    ensure!(
        take_id > 0
            && valid_name(Path::new(filename))
            && Path::new(filename).components().count() == 1,
        "Invalid completed recording recovery identity"
    );
    let (root, stage) = owned_directories(root, stage_dir)?;
    let mut found = vec![];
    let direct = stage.path.join(filename);
    inspect_candidate(&direct, None, &mut found)?;
    let writing = stage.path.join(format!(".writing-{take_id}"));
    match fs::symlink_metadata(&writing) {
        Ok(_) => {
            let nested = Directory::capture(&writing)?;
            inspect_candidate(&writing.join(filename), Some(nested), &mut found)?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    ensure!(
        found.len() == 1,
        "No unique completed native WAV is available for recovery"
    );
    let (source, nested, source_stamp, source_handle, bytes, seconds, sample_rate) =
        found.pop().unwrap();
    let recovery = Recovery {
        root,
        stage,
        nested,
        source,
        filename: filename.into(),
        source_stamp,
        source_handle,
        digest: Sha256::digest(&bytes).into(),
        seconds,
        sample_rate,
        publication: Publication::default(),
    };
    recovery.validate_directories()?;
    recovery.read_verified(&|| false)?;
    Ok(recovery)
}
type Candidate = (
    PathBuf,
    Option<Directory>,
    Stamp,
    PinnedFile,
    Vec<u8>,
    f64,
    u32,
);
fn inspect_candidate(
    path: &Path,
    nested: Option<Directory>,
    found: &mut Vec<Candidate>,
) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(meta) => ensure!(
            meta.file_type().is_file(),
            "Recovery candidate must be an ordinary file"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(error) => return Err(error.into()),
    }
    let mut file = ordinary(path)?;
    let before = stamp(&file)?;
    let bytes = read_bounded(&mut file, &|| false)?;
    ensure!(
        stamp(&file)? == before && stamp(&ordinary(path)?)? == before,
        "Recovery candidate changed during validation"
    );
    // An ordinary incomplete direct sentinel may coexist with the helper's
    // completed .writing-id file after exclusive native publication failed.
    if let Ok(header) = <&[u8; 44]>::try_from(bytes.get(..44).unwrap_or(&[])) {
        if let Ok((seconds, rate)) = crate::microphone::recording_wav(header, bytes.len() as u64) {
            found.push((
                path.into(),
                nested,
                before,
                PinnedFile(Arc::new(file)),
                bytes,
                seconds,
                rate,
            ));
        }
    }
    Ok(())
}

impl Recovery {
    pub(crate) fn capture(
        root: &Path,
        stage_dir: &Path,
        filename: &str,
        take_id: u64,
    ) -> Result<Self> {
        capture(root, stage_dir, filename, take_id)
    }
    pub(crate) fn path(&self) -> &Path {
        &self.source
    }
    pub(crate) fn filename(&self) -> &str {
        &self.filename
    }
    pub(crate) fn seconds(&self) -> f64 {
        self.seconds
    }
    pub(crate) fn sample_rate(&self) -> u32 {
        self.sample_rate
    }
    pub(crate) fn root(&self) -> &Path {
        &self.root.path
    }
    pub(crate) fn source_identity(&self) -> (u64, u64) {
        self.source_stamp.identity
    }
    fn validate_directories(&self) -> Result<()> {
        self.root.validate()?;
        self.stage.validate()?;
        if let Some(nested) = &self.nested {
            nested.validate()?;
        }
        Ok(())
    }
    fn read_verified(&self, cancel: &impl Fn() -> bool) -> Result<Vec<u8>> {
        ensure!(!cancel(), "Cancelled.");
        self.validate_directories()?;
        let mut file = ordinary(&self.source)?;
        let _lease = crate::file_lease::Lease::acquire(file.try_clone()?)
            .context("Completed recording is busy")?;
        ensure!(
            stamp(&self.source_handle.0)? == self.source_stamp
                && stamp(&file)? == self.source_stamp,
            "Recovery source was replaced or modified"
        );
        let bytes = read_bounded(&mut file, cancel)?;
        ensure!(
            stamp(&file)? == self.source_stamp
                && stamp(&ordinary(&self.source)?)? == self.source_stamp
                && <[u8; 32]>::from(Sha256::digest(&bytes)) == self.digest,
            "Recovery source changed during reading"
        );
        self.validate_directories()?;
        Ok(bytes)
    }
    /// Called with the exporter's opened/leased retained source, closing the
    /// path-substitution gap between promotion and ordinary export admission.
    pub(super) fn verify_promoted(
        &self,
        path: &Path,
        opened: &Stamp,
        bytes: &[u8],
        cancel: &impl Fn() -> bool,
    ) -> Result<()> {
        let mut publication = self.publication.0.lock().unwrap_or_else(|e| e.into_inner());
        let published = publication
            .as_mut()
            .context("Recording recovery was not promoted")?;
        ensure!(
            path == published.path
                && opened.identity == published.expected.identity
                && <[u8; 32]>::from(Sha256::digest(bytes)) == self.digest,
            "Recovered recording changed before export admission"
        );
        self.resume_publication(published, bytes, cancel)?;
        ensure!(
            self.read_verified(cancel)? == bytes,
            "Recovery evidence changed before export"
        );
        Ok(())
    }
    pub(crate) fn promote(&self, cancel: &impl Fn() -> bool) -> Result<PathBuf> {
        self.promote_with_hook(cancel, || {})
    }
    fn promote_with_hook(
        &self,
        cancel: &impl Fn() -> bool,
        mut staged: impl FnMut(),
    ) -> Result<PathBuf> {
        self.promote_with_hooks(cancel, &mut staged, |_| Ok(()))
    }
    fn promote_with_hooks(
        &self,
        cancel: &impl Fn() -> bool,
        mut staged: impl FnMut(),
        mut committed: impl FnMut(&Path) -> Result<()>,
    ) -> Result<PathBuf> {
        let mut publication = self.publication.0.lock().unwrap_or_else(|e| e.into_inner());
        let bytes = self.read_verified(cancel)?;
        if let Some(published) = publication.as_mut() {
            return self.resume_publication(published, &bytes, cancel);
        }
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let mut temporary = None;
        for _ in 0..32 {
            ensure!(!cancel(), "Cancelled.");
            let sequence = NEXT.fetch_add(1, Ordering::Relaxed);
            let path = self.root.path.join(format!(
                ".singz-training-recovery-{}-{sequence}",
                std::process::id()
            ));
            let stem = self.filename.strip_suffix(".wav").unwrap();
            let stem = &stem[..stem.len().min(120)];
            let destination = self.root.path.join(format!(
                "{stem}-recovered-{}-{sequence}.wav",
                std::process::id()
            ));
            if fs::symlink_metadata(&destination).is_ok() {
                continue;
            }
            let mut options = OpenOptions::new();
            options.write(true).create_new(true);
            #[cfg(unix)]
            {
                use std::os::unix::fs::OpenOptionsExt;
                options.mode(0o600);
            }
            match options.open(&path) {
                Ok(file) => {
                    temporary = Some((path, destination, file));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        let (path, destination, mut file) =
            temporary.context("Could not allocate private recording recovery")?;
        let cleanup = Temporary {
            path: path.clone(),
            root: self.root.clone(),
            identity: stamp(&file)?.identity,
        };
        for chunk in bytes.chunks(32768) {
            ensure!(!cancel(), "Cancelled.");
            file.write_all(chunk)?;
        }
        file.sync_all()?;
        let expected = stamp(&file)?;
        let stable = StableStamp::capture(&file)?;
        drop(file);
        staged();
        ensure!(
            self.read_verified(cancel)? == bytes,
            "Recovery source changed before publication"
        );
        let mut completed = ordinary(&path)?;
        ensure!(
            stamp(&completed)? == expected
                && read_bounded(&mut completed, cancel)? == bytes
                && stamp(&completed)? == expected,
            "Private recording recovery changed"
        );
        drop(completed);
        self.validate_directories()?;
        let reserved = ordinary(&path)?;
        ensure!(
            stamp(&reserved)? == expected,
            "Private recovery was replaced before publication"
        );
        ensure!(!cancel(), "Cancelled.");
        // Construct the exact committed identity before publication. Nothing
        // after hard_link may fail before its path/identity become persistent.
        let published = Published {
            path: destination.clone(),
            expected: stable,
            handle: PinnedFile(Arc::new(reserved)),
        };
        fs::hard_link(&path, &destination)
            .context("Recovery destination appeared or cannot be published")?;
        *publication = Some(published);
        #[cfg(unix)]
        if let Err(error) = self.root.handle.sync_all() {
            eprintln!("Recording recovery link committed but directory sync failed: {error}");
        }
        // The private file has fully synced before its exclusive visible link.
        // From here a cancellation cannot turn that committed promotion into loss.
        committed(&destination)?;
        drop(cleanup);
        let result = self.resume_publication(publication.as_mut().unwrap(), &bytes, &|| false)?;
        #[cfg(unix)]
        if let Err(error) = File::open(&self.root.path).and_then(|file| file.sync_all()) {
            eprintln!("Recording recovered but directory sync failed: {error}");
        }
        Ok(result)
    }
    fn resume_publication(
        &self,
        published: &mut Published,
        bytes: &[u8],
        cancel: &impl Fn() -> bool,
    ) -> Result<PathBuf> {
        ensure!(!cancel(), "Cancelled.");
        self.validate_directories()?;
        ensure!(
            StableStamp::capture(&published.handle.0)? == published.expected,
            "Original committed recording handle changed"
        );
        let mut file = ordinary(&published.path)?;
        let before = stamp(&file)?;
        ensure!(
            StableStamp::capture(&file)? == published.expected,
            "Previously recovered recording was replaced or modified"
        );
        ensure!(
            read_bounded(&mut file, cancel)? == bytes
                && <[u8; 32]>::from(Sha256::digest(bytes)) == self.digest
                && stamp(&file)? == before
                && StableStamp::capture(&ordinary(&published.path)?)? == published.expected,
            "Previously recovered recording content changed"
        );
        self.validate_directories()?;
        // ctime is intentionally not an authorization key: linking the visible
        // name and cleaning its temporary alias legitimately change it. The
        // reserved inode, size, mtime and complete content remain mandatory.
        Ok(published.path.clone())
    }
}
struct Temporary {
    path: PathBuf,
    root: Directory,
    identity: (u64, u64),
}
impl Drop for Temporary {
    fn drop(&mut self) {
        if self.root.validate().is_ok()
            && ordinary(&self.path)
                .and_then(|f| stamp(&f))
                .is_ok_and(|s| s.identity == self.identity)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    const NAME: &str = "SingZ-microphone-recovery-fixture-7-take-9.wav";
    struct Fixture {
        base: PathBuf,
        root: PathBuf,
        stage: PathBuf,
    }
    impl Fixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let base = std::env::temp_dir().join(format!(
                "singz-recording-recovery-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&base).unwrap();
            let base = base.canonicalize().unwrap();
            let root = base.join("training-recordings");
            fs::create_dir(&root).unwrap();
            let stage = root.join(".take-7-9-1");
            fs::create_dir(&stage).unwrap();
            Self { base, root, stage }
        }
        fn direct(&self) -> PathBuf {
            self.stage.join(NAME)
        }
        fn complete(&self) -> Recovery {
            fs::write(self.direct(), wav()).unwrap();
            capture(&self.root, &self.stage, NAME, 9).unwrap()
        }
        fn published(&self) -> Vec<PathBuf> {
            fs::read_dir(&self.root)
                .unwrap()
                .map(|p| p.unwrap().path())
                .filter(|p| p.extension().is_some_and(|p| p == "wav"))
                .collect()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.base);
        }
    }
    fn wav() -> Vec<u8> {
        let mut bytes = vec![];
        let frames = 1600u32;
        let rate = 16000u32;
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + frames * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(frames * 2).to_le_bytes());
        bytes.resize(44 + frames as usize * 2, 0x5a);
        bytes
    }
    // Windows may prevent a directory move while its children are reserved.
    // Only the observed access/sharing errors represent that safe outcome.
    fn reservation_denied_directory_move(error: &std::io::Error) -> bool {
        #[cfg(windows)]
        {
            matches!(error.raw_os_error(), Some(5 | 32))
        }
        #[cfg(not(windows))]
        {
            let _ = error;
            false
        }
    }
    #[test]
    fn original_owned_stage_proof_rejects_replacement_before_first_capture() {
        for replace_root in [false, true] {
            let f = Fixture::new();
            let proof = OwnedStage::new(&f.root, &f.stage).unwrap();
            fs::write(f.direct(), wav()).unwrap();
            let original = stamp(&ordinary(&f.direct()).unwrap()).unwrap();
            let (from, moved) = if replace_root {
                (&f.root, f.base.join("old-root"))
            } else {
                (&f.stage, f.root.join(".take-original"))
            };
            match fs::rename(from, &moved) {
                Ok(()) => {
                    if replace_root {
                        fs::create_dir(&f.root).unwrap();
                    }
                    fs::create_dir(&f.stage).unwrap();
                    fs::write(f.direct(), wav()).unwrap();
                    assert!(proof.capture(NAME, 9).is_err());
                }
                Err(error) => {
                    assert!(reservation_denied_directory_move(&error), "{error}");
                    assert!(!moved.exists());
                    assert_eq!(Directory::capture(&f.root).unwrap(), proof.root);
                    assert_eq!(Directory::capture(&f.stage).unwrap(), proof.stage);
                    assert_eq!(stamp(&ordinary(&f.direct()).unwrap()).unwrap(), original);
                    assert_eq!(fs::read(f.direct()).unwrap(), wav());
                    let recovered = proof.capture(NAME, 9).unwrap();
                    assert_eq!(recovered.source_stamp, original);
                    assert_eq!(recovered.read_verified(&|| false).unwrap(), wav());
                }
            }
            assert!(f.published().is_empty());
        }
    }
    #[test]
    fn direct_directory_handle_rejects_replaced_root_identity() {
        let f = Fixture::new();
        // No open child handle: the root itself can move on Windows, exercising
        // the identity fence independently of child reservation protection.
        let original = Directory::capture(&f.root).unwrap();
        let moved = f.base.join("old-root");
        fs::rename(&f.root, &moved).unwrap();
        fs::create_dir(&f.root).unwrap();
        let replacement = Directory::capture(&f.root).unwrap();
        assert_ne!(replacement.identity, original.identity);
        assert_eq!(
            directory_identity(&original.handle).unwrap(),
            original.identity
        );
        assert_eq!(
            directory_identity(&open_directory(&moved).unwrap()).unwrap(),
            original.identity
        );
        assert!(original.validate().is_err());
        assert!(f.published().is_empty());
    }
    #[test]
    fn completed_direct_stage_promotes_once_and_preserves_existing_root_file() {
        let f = Fixture::new();
        let recovery = f.complete();
        fs::write(f.root.join(NAME), b"unrelated existing recording").unwrap();
        let result = recovery.promote(&|| false).unwrap();
        assert_eq!(result.parent(), Some(f.root.as_path()));
        assert!(valid_name(&result));
        assert_ne!(result, f.root.join(NAME));
        assert_eq!(fs::read(&result).unwrap(), wav());
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
        assert_eq!(
            fs::read(f.root.join(NAME)).unwrap(),
            b"unrelated existing recording"
        );
        assert_eq!(recovery.clone().promote(&|| false).unwrap(), result);
        assert_eq!(f.published().len(), 2);
        assert_eq!(recovery.seconds(), 0.1);
        assert_eq!(recovery.sample_rate(), 16000);
    }
    #[test]
    fn helper_private_completed_wav_is_recoverable_without_touching_invalid_direct_sentinel() {
        let f = Fixture::new();
        let nested = f.stage.join(".writing-9");
        fs::create_dir(&nested).unwrap();
        fs::write(f.direct(), b"exclusive helper destination collision").unwrap();
        fs::write(nested.join(NAME), wav()).unwrap();
        let recovery = capture(&f.root, &f.stage, NAME, 9).unwrap();
        assert_eq!(recovery.path(), nested.join(NAME));
        let published = recovery.promote(&|| false).unwrap();
        assert_eq!(fs::read(published).unwrap(), wav());
        assert_eq!(
            fs::read(f.direct()).unwrap(),
            b"exclusive helper destination collision"
        );
        assert_eq!(fs::read(nested.join(NAME)).unwrap(), wav());
    }
    #[test]
    fn ambiguous_or_unfinished_native_audio_has_no_recovery_capability() {
        let f = Fixture::new();
        let bytes = wav();
        for bad in [
            bytes[..20].to_vec(),
            bytes[..bytes.len() - 2].to_vec(),
            {
                let mut bad = bytes.clone();
                bad[22] = 2;
                bad
            },
            {
                let mut bad = bytes.clone();
                bad.extend_from_slice(&[0, 0]);
                bad
            },
        ] {
            fs::write(f.direct(), bad).unwrap();
            assert!(capture(&f.root, &f.stage, NAME, 9).is_err());
        }
        fs::write(f.direct(), wav()).unwrap();
        let nested = f.stage.join(".writing-9");
        fs::create_dir(&nested).unwrap();
        fs::write(nested.join(NAME), wav()).unwrap();
        assert!(capture(&f.root, &f.stage, NAME, 9).is_err());
        assert!(f.published().is_empty());
    }
    #[test]
    fn identity_and_hash_revalidation_reject_replaced_or_modified_source() {
        for replace in [false, true] {
            let f = Fixture::new();
            let recovery = f.complete();
            if replace {
                fs::remove_file(f.direct()).unwrap();
                fs::write(f.direct(), wav()).unwrap();
            } else {
                let mut bytes = wav();
                bytes[50] ^= 1;
                fs::write(f.direct(), bytes).unwrap();
            }
            assert!(recovery.promote(&|| false).is_err());
            assert!(f.published().is_empty());
        }
    }
    #[test]
    fn source_or_directory_changes_during_private_copy_refuse_publication() {
        for change in 0..3 {
            let f = Fixture::new();
            let recovery = f.complete();
            let mut denied_move = false;
            let result = recovery.promote_with_hook(&|| false, || {
                if change == 0 {
                    let mut bytes = wav();
                    bytes[60] ^= 1;
                    fs::write(f.direct(), bytes).unwrap();
                    return;
                }
                let (from, moved) = if change == 1 {
                    (&f.stage, f.root.join(".take-original"))
                } else {
                    (&f.root, f.base.join("old-root"))
                };
                match fs::rename(from, &moved) {
                    Ok(()) => {
                        if change == 1 {
                            fs::create_dir(&f.stage).unwrap();
                            fs::write(f.direct(), wav()).unwrap();
                        } else {
                            fs::create_dir(&f.root).unwrap();
                            fs::write(f.root.join("foreign"), b"keep").unwrap();
                        }
                    }
                    Err(error) => {
                        assert!(reservation_denied_directory_move(&error), "{error}");
                        denied_move = true;
                        assert!(!moved.exists());
                        assert_eq!(Directory::capture(&f.root).unwrap(), recovery.root);
                        assert_eq!(Directory::capture(&f.stage).unwrap(), recovery.stage);
                        assert_eq!(
                            stamp(&ordinary(&f.direct()).unwrap()).unwrap(),
                            recovery.source_stamp
                        );
                        assert_eq!(fs::read(f.direct()).unwrap(), wav());
                        assert!(f.published().is_empty());
                    }
                }
            });
            if denied_move {
                let published = result.unwrap();
                assert_eq!(f.published(), vec![published.clone()]);
                assert_eq!(fs::read(published).unwrap(), wav());
                recovery.validate_directories().unwrap();
                assert_eq!(recovery.read_verified(&|| false).unwrap(), wav());
            } else {
                assert!(result.is_err());
                assert!(f.published().is_empty());
                if change == 2 {
                    assert_eq!(fs::read(f.root.join("foreign")).unwrap(), b"keep");
                }
            }
        }
    }
    #[test]
    fn cancellation_before_or_after_copy_preserves_the_original() {
        let f = Fixture::new();
        let recovery = f.complete();
        assert!(recovery.promote(&|| true).is_err());
        assert!(f.published().is_empty());
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        assert!(recovery
            .promote_with_hook(&|| cancelled.load(Ordering::Acquire), || cancelled
                .store(true, Ordering::Release))
            .is_err());
        assert!(f.published().is_empty());
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
        assert_eq!(fs::read_dir(&f.root).unwrap().count(), 1);
    }
    #[test]
    fn exclusive_promotion_refuses_a_destination_that_appears_after_copy() {
        let f = Fixture::new();
        let recovery = f.complete();
        let mut target = None;
        assert!(recovery
            .promote_with_hook(&|| false, || {
                let temporary = fs::read_dir(&f.root)
                    .unwrap()
                    .map(|e| e.unwrap().path())
                    .find(|p| {
                        p.file_name()
                            .unwrap()
                            .to_string_lossy()
                            .starts_with(".singz-training-recovery-")
                    })
                    .unwrap();
                let text = temporary.file_name().unwrap().to_str().unwrap();
                let sequence = text.rsplit('-').next().unwrap();
                let path = f.root.join(format!(
                    "{}-recovered-{}-{sequence}.wav",
                    NAME.strip_suffix(".wav").unwrap(),
                    std::process::id()
                ));
                fs::write(&path, b"unrelated late publication").unwrap();
                target = Some(path);
            })
            .is_err());
        assert_eq!(
            fs::read(target.unwrap()).unwrap(),
            b"unrelated late publication"
        );
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
    }
    #[test]
    fn committed_promotion_survives_post_link_error_and_retries_exactly_one_path() {
        let f = Fixture::new();
        let recovery = f.complete();
        let mut committed = None;
        let first = recovery.promote_with_hooks(
            &|| false,
            || {},
            |path| {
                committed = Some(path.to_path_buf());
                anyhow::bail!("Injected post-link validation failure")
            },
        );
        assert!(first.is_err());
        let committed = committed.unwrap();
        assert_eq!(f.published(), vec![committed.clone()]);
        assert_eq!(fs::read(&committed).unwrap(), wav());
        assert_eq!(
            fs::read_dir(&f.root).unwrap().count(),
            2,
            "private temporary alias must be cleaned after the postcommit error"
        );
        let second = recovery.clone().promote(&|| false).unwrap();
        assert_eq!(second, committed);
        assert_eq!(recovery.promote(&|| false).unwrap(), committed);
        assert_eq!(f.published(), vec![committed]);
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
    }
    #[test]
    fn post_link_replacement_is_not_trusted_and_retry_never_allocates_another_path() {
        let f = Fixture::new();
        let recovery = f.complete();
        let mut committed = None;
        assert!(recovery
            .promote_with_hooks(
                &|| false,
                || {},
                |path| {
                    committed = Some(path.to_path_buf());
                    fs::remove_file(path)?;
                    // A complete byte-identical WAV still has a foreign identity.
                    fs::write(path, wav())?;
                    Ok(())
                }
            )
            .is_err());
        let committed = committed.unwrap();
        assert!(recovery.promote(&|| false).is_err());
        assert!(recovery.clone().promote(&|| false).is_err());
        assert_eq!(f.published(), vec![committed.clone()]);
        assert_eq!(fs::read(&committed).unwrap(), wav());
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
    }
    #[test]
    fn committed_link_can_resume_after_temporary_postcommit_open_failure() {
        let f = Fixture::new();
        let recovery = f.complete();
        let backup = f.root.join(".original-committed-recording");
        let mut committed = None;
        assert!(recovery
            .promote_with_hooks(
                &|| false,
                || {},
                |path| {
                    committed = Some(path.to_path_buf());
                    fs::rename(path, &backup)?;
                    fs::create_dir(path)?;
                    Ok(())
                }
            )
            .is_err());
        let committed = committed.unwrap();
        assert!(recovery.promote(&|| false).is_err());
        fs::remove_dir(&committed).unwrap();
        fs::rename(&backup, &committed).unwrap();
        assert_eq!(recovery.promote(&|| false).unwrap(), committed);
        assert_eq!(f.published(), vec![committed]);
    }
    #[test]
    fn cancellation_after_visible_link_keeps_the_committed_promotion() {
        let f = Fixture::new();
        let recovery = f.complete();
        let cancelled = std::sync::atomic::AtomicBool::new(false);
        let path = recovery
            .promote_with_hooks(
                &|| cancelled.load(Ordering::Acquire),
                || {},
                |_| {
                    cancelled.store(true, Ordering::Release);
                    Ok(())
                },
            )
            .unwrap();
        assert_eq!(f.published(), vec![path.clone()]);
        assert_eq!(recovery.promote(&|| false).unwrap(), path);
    }
    #[test]
    fn source_pin_allows_owned_link_ctime_changes_and_matches_only_original_recovery() {
        let f = Fixture::new();
        let stage = OwnedStage::new(&f.root, &f.stage).unwrap();
        fs::write(f.direct(), wav()).unwrap();
        let pin = stage.pin_direct(NAME).unwrap();
        pin.sync_all().unwrap();
        assert_eq!(pin.seconds(), 0.1);
        assert_eq!(pin.sample_rate(), 16000);
        let destination = f.root.join(NAME);
        fs::hard_link(f.direct(), &destination).unwrap();
        let temporary = f.root.join(".temporary-native-alias");
        fs::hard_link(f.direct(), &temporary).unwrap();
        fs::remove_file(&temporary).unwrap();
        pin.verify_hard_link(&destination).unwrap();
        let recovery = stage.capture(NAME, 9).unwrap();
        pin.require_recovery(&recovery).unwrap();
        assert_eq!(fs::read(&destination).unwrap(), wav());
    }
    #[test]
    fn a_valid_source_replacement_cannot_be_reauthorized_by_fallback_capture() {
        let f = Fixture::new();
        let stage = OwnedStage::new(&f.root, &f.stage).unwrap();
        fs::write(f.direct(), wav()).unwrap();
        let pin = stage.pin_direct(NAME).unwrap();
        // Keep the original named as well as held open, then substitute valid
        // native-shaped bytes at its former path before the normal hard link.
        fs::rename(f.direct(), f.stage.join(".original-source")).unwrap();
        fs::write(f.direct(), wav()).unwrap();
        let destination = f.root.join(NAME);
        fs::hard_link(f.direct(), &destination).unwrap();
        assert!(pin.verify_hard_link(&destination).is_err());
        let replacement = stage.capture(NAME, 9).unwrap();
        assert!(pin.require_recovery(&replacement).is_err());
        assert_eq!(fs::read(f.stage.join(".original-source")).unwrap(), wav());
        assert_eq!(fs::read(&destination).unwrap(), wav());
    }
    #[test]
    fn source_pin_refuses_a_byte_identical_foreign_published_file() {
        let f = Fixture::new();
        let stage = OwnedStage::new(&f.root, &f.stage).unwrap();
        fs::write(f.direct(), wav()).unwrap();
        let pin = stage.pin_direct(NAME).unwrap();
        let destination = f.root.join(NAME);
        fs::write(&destination, wav()).unwrap();
        assert!(pin.verify_hard_link(&destination).is_err());
        assert_eq!(fs::read(&destination).unwrap(), wav());
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
    }
    #[test]
    fn a_changed_cached_publication_is_never_replaced_or_reused() {
        let f = Fixture::new();
        let recovery = f.complete();
        let path = recovery.promote(&|| false).unwrap();
        fs::remove_file(&path).unwrap();
        fs::write(&path, b"foreign replacement").unwrap();
        assert!(recovery.promote(&|| false).is_err());
        assert_eq!(fs::read(&path).unwrap(), b"foreign replacement");
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
    }
    #[cfg(unix)]
    #[test]
    fn symlink_candidates_and_linked_file_substitution_are_refused() {
        use std::os::unix::fs::symlink;
        let f = Fixture::new();
        let outside = f.base.join("outside.wav");
        fs::write(&outside, wav()).unwrap();
        symlink(&outside, f.direct()).unwrap();
        assert!(capture(&f.root, &f.stage, NAME, 9).is_err());
        fs::remove_file(f.direct()).unwrap();
        let recovery = f.complete();
        fs::remove_file(f.direct()).unwrap();
        fs::hard_link(&outside, f.direct()).unwrap();
        assert!(recovery.promote(&|| false).is_err());
        assert!(f.published().is_empty());
    }
    fn await_export(
        service: &crate::training_recording_store::Service,
        id: u64,
    ) -> std::result::Result<PathBuf, String> {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            if let Some(event) = service.drain().into_iter().find(|event| event.id == id) {
                return event.result;
            }
            assert!(
                Instant::now() < deadline,
                "Recovery export receipt timed out"
            );
            std::thread::sleep(Duration::from_millis(5));
        }
    }
    #[test]
    fn worker_promotes_then_exports_and_retries_without_bypassing_flat_root_validation() {
        let f = Fixture::new();
        let recovery = f.complete();
        let service = crate::training_recording_store::Service::new(f.root.clone());
        let first = f.base.join("first.wav");
        let id = service
            .export_recovery(recovery.clone(), first.clone(), false)
            .unwrap();
        assert_eq!(await_export(&service, id).unwrap(), first);
        assert_eq!(fs::read(&first).unwrap(), wav());
        let second = f.base.join("second.wav");
        let id = service
            .export_recovery(recovery.clone(), second.clone(), false)
            .unwrap();
        assert_eq!(await_export(&service, id).unwrap(), second);
        assert_eq!(f.published().len(), 1);
        let direct = f.base.join("untrusted-direct.wav");
        let id = service.export(f.direct(), direct.clone(), false).unwrap();
        assert!(await_export(&service, id).is_err());
        assert!(!direct.exists());
        let id = service
            .export_recovery(recovery.clone(), f.direct(), true)
            .unwrap();
        assert!(await_export(&service, id).is_err());
        assert_eq!(fs::read(f.direct()).unwrap(), wav());
        let elsewhere = Fixture::new();
        let other = crate::training_recording_store::Service::new(elsewhere.root.clone());
        let destination = elsewhere.base.join("wrong-root.wav");
        let id = other
            .export_recovery(recovery, destination.clone(), false)
            .unwrap();
        assert!(await_export(&other, id).is_err());
        assert!(!destination.exists());
    }
    #[cfg(unix)]
    #[test]
    fn recovery_export_cannot_replace_an_external_alias_of_the_staged_original() {
        let f = Fixture::new();
        let _initial = f.complete();
        let alias = f.base.join("alias.wav");
        fs::hard_link(f.direct(), &alias).unwrap();
        // Creating the alias also changes source metadata. Capture its settled
        // identity afresh so this specifically tests destination alias refusal.
        let recovery = capture(&f.root, &f.stage, NAME, 9).unwrap();
        let service = crate::training_recording_store::Service::new(f.root.clone());
        let id = service
            .export_recovery(recovery, alias.clone(), true)
            .unwrap();
        assert!(await_export(&service, id).is_err());
        assert_eq!(fs::read(&alias).unwrap(), wav());
        assert!(f.published().is_empty());
    }
}

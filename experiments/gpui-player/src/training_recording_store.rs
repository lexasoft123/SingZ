//! Export a retained native training take. PCM remains in the native helper;
//! this worker only validates and copies the finished WAV, never deleting it.
use anyhow::{Context, Result, ensure};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, SystemTime},
};

const MAX_BYTES: u64 = 30 * 192_000 * 2 + 65_536;
const MAX_PENDING: usize = 32;
#[derive(Debug)]
pub struct Event {
    pub id: u64,
    pub result: std::result::Result<PathBuf, String>,
}
struct Request {
    id: u64,
    source: Source,
    destination: PathBuf,
    overwrite: bool,
}
enum Source {
    Retained(PathBuf),
    Recovery(crate::recording_recovery::Recovery),
}
struct Shared {
    stopped: AtomicBool,
    serial: AtomicU64,
    pending: Mutex<HashSet<u64>>,
    cancelled: Mutex<HashSet<u64>>,
    events: Mutex<VecDeque<Event>>,
}
pub struct Service {
    tx: SyncSender<Request>,
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    /// No filesystem work occurs on the caller's thread.
    pub fn new(root: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Request>(MAX_PENDING);
        let shared = Arc::new(Shared {
            stopped: AtomicBool::new(false),
            serial: AtomicU64::new(0),
            pending: Mutex::new(HashSet::new()),
            cancelled: Mutex::new(HashSet::new()),
            events: Mutex::new(VecDeque::new()),
        });
        let state = shared.clone();
        let worker = thread::spawn(move || {
            loop {
                let request = if state.stopped.load(Ordering::Acquire) {
                    rx.try_recv().ok()
                } else {
                    rx.recv_timeout(Duration::from_millis(50)).ok()
                };
                let Some(request) = request else {
                    if state.stopped.load(Ordering::Acquire) {
                        break;
                    }
                    continue;
                };
                let cancelled = || {
                    state.stopped.load(Ordering::Acquire)
                        || state.cancelled.lock().unwrap().contains(&request.id)
                };
                let result = (|| -> Result<PathBuf> {
                    let (take, protection) = match &request.source {
                        Source::Retained(path) => (path.clone(), None),
                        Source::Recovery(recovery) => {
                            ensure!(
                                root.canonicalize()? == recovery.root(),
                                "Recovery belongs to another recording root"
                            );
                            recovery_destination(
                                recovery.root(),
                                recovery.source_identity(),
                                &request.destination,
                            )?;
                            (recovery.promote(&cancelled)?, Some(recovery))
                        }
                    };
                    export_with_protection(
                        &root,
                        &take,
                        &request.destination,
                        request.overwrite,
                        &cancelled,
                        |_| {},
                        protection,
                    )
                })()
                .map_err(|e| format!("{e:#}"));
                state.cancelled.lock().unwrap().remove(&request.id);
                state.events.lock().unwrap().push_back(Event {
                    id: request.id,
                    result,
                });
            }
        });
        Self {
            tx,
            shared,
            worker: Some(worker),
        }
    }
    pub fn export(&self, take: PathBuf, destination: PathBuf, overwrite: bool) -> Result<u64> {
        self.enqueue(Source::Retained(take), destination, overwrite)
    }
    /// A recovery capability is validated/promoted on the worker before entering
    /// the ordinary retained-root export path. Staged paths are never admitted.
    pub fn export_recovery(
        &self,
        recovery: crate::recording_recovery::Recovery,
        destination: PathBuf,
        overwrite: bool,
    ) -> Result<u64> {
        self.enqueue(Source::Recovery(recovery), destination, overwrite)
    }
    fn enqueue(&self, source: Source, destination: PathBuf, overwrite: bool) -> Result<u64> {
        ensure!(
            !self.shared.stopped.load(Ordering::Acquire),
            "Training WAV export worker has stopped"
        );
        let mut pending = self.shared.pending.lock().unwrap();
        ensure!(
            pending.len() < MAX_PENDING,
            "Training WAV export queue is full"
        );
        let id = self
            .shared
            .serial
            .fetch_update(Ordering::AcqRel, Ordering::Acquire, |n| n.checked_add(1))
            .map_err(|_| anyhow::anyhow!("Training WAV export sequence exhausted"))?
            + 1;
        pending.insert(id);
        if self
            .tx
            .try_send(Request {
                id,
                source,
                destination,
                overwrite,
            })
            .is_err()
        {
            pending.remove(&id);
            anyhow::bail!("Training WAV export queue is unavailable");
        }
        Ok(id)
    }
    /// Cancellation is effective before publication. A committed export still
    /// reports success and remains on disk, even if cancelled immediately after.
    pub fn cancel(&self, id: u64) {
        if self.shared.pending.lock().unwrap().contains(&id) {
            self.shared.cancelled.lock().unwrap().insert(id);
        }
    }
    pub fn drain(&self) -> Vec<Event> {
        let events: Vec<_> = self.shared.events.lock().unwrap().drain(..).collect();
        let mut pending = self.shared.pending.lock().unwrap();
        let mut cancelled = self.shared.cancelled.lock().unwrap();
        for event in &events {
            pending.remove(&event.id);
            cancelled.remove(&event.id);
        }
        events
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shared.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

fn open_read(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4); // NOFOLLOW | NONBLOCK
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000 | 0x800);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    Ok(options.open(path)?)
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub(super) struct Stamp {
    pub(super) identity: (u64, u64),
    bytes: u64,
    modified: Option<SystemTime>,
    changed: (i64, i64),
}
pub(super) fn stamp(file: &File) -> Result<Stamp> {
    let meta = file.metadata()?;
    ensure!(
        meta.file_type().is_file(),
        "Recording member must be an ordinary file"
    );
    #[cfg(unix)]
    let (identity, changed) = {
        use std::os::unix::fs::MetadataExt;
        ((meta.dev(), meta.ino()), (meta.ctime(), meta.ctime_nsec()))
    };
    #[cfg(windows)]
    let (identity, changed) = {
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
            "Cannot identify training WAV file"
        );
        let info = unsafe { info.assume_init() };
        (
            (
                info.volume as u64,
                ((info.index_high as u64) << 32) | info.index_low as u64,
            ),
            (0, 0),
        )
    };
    #[cfg(not(any(unix, windows)))]
    let (identity, changed) = ((0, 0), (0, 0));
    Ok(Stamp {
        identity,
        bytes: meta.len(),
        modified: meta.modified().ok(),
        changed,
    })
}
pub(super) fn ordinary(path: &Path) -> Result<File> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "Recording member must be an ordinary file"
    );
    let file = open_read(path)?;
    let opened = stamp(&file)?;
    let again = open_read(path)?;
    ensure!(
        opened == stamp(&again)? && fs::symlink_metadata(path)?.file_type().is_file(),
        "Recording member changed while opening"
    );
    Ok(file)
}
pub(super) fn read_bounded(file: &mut File, cancel: &impl Fn() -> bool) -> Result<Vec<u8>> {
    ensure!(
        file.metadata()?.len() <= MAX_BYTES,
        "Training WAV exceeds its bounded size"
    );
    let mut bytes = vec![];
    let mut buffer = [0u8; 32768];
    loop {
        ensure!(!cancel(), "Cancelled.");
        let n = file.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        ensure!(
            bytes.len() + n <= MAX_BYTES as usize,
            "Training WAV exceeds its bounded size"
        );
        bytes.extend_from_slice(&buffer[..n]);
    }
    Ok(bytes)
}
fn validate_wave(bytes: &[u8]) -> Result<()> {
    ensure!(
        bytes.len() >= 44 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WAVE",
        "Recording is not a PCM WAV"
    );
    let u32_at = |at: usize| u32::from_le_bytes(bytes[at..at + 4].try_into().unwrap());
    ensure!(
        u32_at(4) as usize + 8 == bytes.len(),
        "Training WAV is incomplete or has trailing bytes"
    );
    let mut at = 12usize;
    let mut format = None;
    let mut data = None;
    let mut chunks = 0;
    while at < bytes.len() {
        ensure!(at + 8 <= bytes.len(), "Truncated WAV chunk");
        let count = u32_at(at + 4) as usize;
        let end = (at + 8)
            .checked_add(count)
            .context("Invalid WAV chunk size")?;
        ensure!(end <= bytes.len(), "Truncated WAV chunk");
        chunks += 1;
        ensure!(chunks <= 1024, "Too many WAV chunks");
        match &bytes[at..at + 4] {
            b"fmt " => {
                ensure!(format.is_none() && count >= 16, "Invalid WAV format chunk");
                let u16_at = |p| u16::from_le_bytes(bytes[p..p + 2].try_into().unwrap());
                let base = at + 8;
                let rate = u32_at(base + 4);
                ensure!(
                    u16_at(base) == 1 && u16_at(base + 2) == 1 && u16_at(base + 14) == 16,
                    "Recording must be mono PCM16 WAV"
                );
                ensure!(
                    (8000..=192000).contains(&rate)
                        && u16_at(base + 12) == 2
                        && u32_at(base + 8) == rate * 2,
                    "Invalid recording sample rate or PCM alignment"
                );
                format = Some(rate);
            }
            b"data" => {
                ensure!(
                    data.is_none() && count > 0 && count % 2 == 0,
                    "Recording has no complete PCM samples"
                );
                data = Some(count as u64 / 2);
            }
            _ => {}
        }
        at = end + (count & 1);
        ensure!(at <= bytes.len(), "Missing WAV chunk padding");
    }
    let rate = format.context("Recording has no PCM format")?;
    let frames = data.context("Recording has no audio samples")?;
    ensure!(
        frames <= u64::from(rate) * 30,
        "Recording exceeds thirty seconds"
    );
    Ok(())
}
pub(super) fn valid_name(path: &Path) -> bool {
    path.file_name()
        .and_then(|s| s.to_str())
        .is_some_and(|name| {
            name.len() <= 180
                && name.starts_with("SingZ-microphone-")
                && name.ends_with(".wav")
                && name
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || matches!(b, b'-' | b'_' | b'.'))
        })
}
struct Cleanup {
    path: PathBuf,
    identity: (u64, u64),
}
impl Drop for Cleanup {
    fn drop(&mut self) {
        if ordinary(&self.path)
            .and_then(|f| stamp(&f))
            .is_ok_and(|s| s.identity == self.identity)
        {
            let _ = fs::remove_file(&self.path);
        }
    }
}
#[derive(Clone, Copy)]
enum Phase {
    Staged,
}
fn export_with_hook(
    root: &Path,
    take: &Path,
    destination: &Path,
    overwrite: bool,
    cancel: &impl Fn() -> bool,
    hook: impl FnMut(Phase),
) -> Result<PathBuf> {
    export_with_protection(root, take, destination, overwrite, cancel, hook, None)
}
fn recovery_destination(root: &Path, source: (u64, u64), destination: &Path) -> Result<()> {
    let parent = destination
        .parent()
        .context("Export destination has no directory")?
        .canonicalize()?;
    ensure!(
        !parent.starts_with(root),
        "Recovery export cannot replace recording evidence"
    );
    match fs::symlink_metadata(destination) {
        Ok(_) => ensure!(
            stamp(&ordinary(destination)?)?.identity != source,
            "Recovery export cannot replace its source"
        ),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => return Err(error.into()),
    }
    Ok(())
}
fn export_with_protection(
    root: &Path,
    take: &Path,
    destination: &Path,
    overwrite: bool,
    cancel: &impl Fn() -> bool,
    mut hook: impl FnMut(Phase),
    recovery: Option<&crate::recording_recovery::Recovery>,
) -> Result<PathBuf> {
    ensure!(!cancel(), "Cancelled.");
    ensure!(
        root.is_absolute() && take.is_absolute() && destination.is_absolute(),
        "Training WAV paths must be absolute"
    );
    ensure!(
        fs::symlink_metadata(root)?.file_type().is_dir(),
        "Recording root must be an ordinary directory"
    );
    let root = root.canonicalize()?;
    ensure!(
        valid_name(take)
            && take
                .parent()
                .context("Recording has no parent")?
                .canonicalize()?
                == root,
        "Recording is outside the retained training root"
    );
    let take = root.join(take.file_name().unwrap());
    let mut source = ordinary(&take)?;
    let expected = stamp(&source)?;
    let _source_lease = crate::file_lease::Lease::acquire(source.try_clone()?)
        .context("Training recording is busy")?;
    let bytes = read_bounded(&mut source, cancel)?;
    validate_wave(&bytes)?;
    ensure!(
        stamp(&source)? == expected,
        "Training recording changed while reading"
    );
    if let Some(recovery) = recovery {
        recovery.verify_promoted(&take, &expected, &bytes, cancel)?;
    }
    let parent = destination
        .parent()
        .context("Export destination has no directory")?
        .canonicalize()?;
    let dest = parent.join(
        destination
            .file_name()
            .context("Export destination has no filename")?,
    );
    if let Some(recovery) = recovery {
        recovery_destination(recovery.root(), recovery.source_identity(), &dest)?;
    }
    ensure!(dest != take, "Export cannot replace the retained recording");
    let target = match fs::symlink_metadata(&dest) {
        Ok(_) => {
            ensure!(overwrite, "Export destination already exists");
            let file = ordinary(&dest)?;
            let current = stamp(&file)?;
            if let Some(recovery) = recovery {
                ensure!(
                    current.identity != recovery.source_identity(),
                    "Recovery export cannot replace its source"
                );
            }
            ensure!(
                current.identity != expected.identity,
                "Export cannot replace the retained recording"
            );
            let lease = crate::file_lease::Lease::acquire(file.try_clone()?)
                .context("Export destination is busy")?;
            Some((file, current, lease))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    static TEMP: AtomicU64 = AtomicU64::new(0);
    let mut staged = None;
    for _ in 0..32 {
        let path = parent.join(format!(
            ".singz-training-wav-export-{}-{}",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        match options.open(&path) {
            Ok(file) => {
                staged = Some((path, file));
                break;
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    let (temp, mut file) = staged.context("Could not allocate private WAV export")?;
    let temp_identity = stamp(&file)?.identity;
    let _cleanup = Cleanup {
        path: temp.clone(),
        identity: temp_identity,
    };
    for chunk in bytes.chunks(32768) {
        ensure!(!cancel(), "Cancelled.");
        file.write_all(chunk)?;
    }
    file.sync_all()?;
    let staged_stamp = stamp(&file)?;
    drop(file);
    hook(Phase::Staged);
    test_gate(cancel)?;
    ensure!(!cancel(), "Cancelled.");
    ensure!(
        fs::symlink_metadata(&root)?.file_type().is_dir() && root.canonicalize()? == root,
        "Recording root changed before export publication"
    );
    ensure!(
        fs::symlink_metadata(&parent)?.file_type().is_dir() && parent.canonicalize()? == parent,
        "Export directory changed before publication"
    );
    let mut staged_file = ordinary(&temp)?;
    ensure!(
        stamp(&staged_file)? == staged_stamp && read_bounded(&mut staged_file, cancel)? == bytes,
        "Private export changed before publication"
    );
    drop(staged_file);
    let mut current = ordinary(&take)?;
    ensure!(
        stamp(&current)? == expected && stamp(&source)? == expected,
        "Training recording changed before export publication"
    );
    ensure!(
        read_bounded(&mut current, cancel)? == bytes && stamp(&current)? == expected,
        "Training recording content changed before export publication"
    );
    ensure!(
        ordinary(&temp).and_then(|f| stamp(&f))?.identity == temp_identity,
        "Private export changed before publication"
    );
    if let Some((file, expected, _)) = &target {
        ensure!(
            stamp(file)? == *expected && stamp(&ordinary(&dest)?)? == *expected,
            "Export destination changed before publication"
        );
        ensure!(!cancel(), "Cancelled.");
        crate::project_store::replace(&temp, &dest)?;
    } else {
        ensure!(!cancel(), "Cancelled.");
        crate::project_library::publish_directory(&temp, &dest)
            .context("Export destination appeared or exclusive publication failed")?;
    }
    // Never turn a committed, user-visible export into a cancellation error.
    #[cfg(unix)]
    if let Err(error) = File::open(&parent).and_then(|f| f.sync_all()) {
        eprintln!("Training WAV exported but directory sync failed: {error}");
    }
    Ok(dest)
}
fn test_gate(cancel: &impl Fn() -> bool) -> Result<()> {
    #[cfg(feature = "ui-tests")]
    if let Some(path) = std::env::var_os("SINGZ_GPUI_TRAINING_RECORDING_EXPORT_GATE") {
        ensure!(
            std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                && std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),
            "Recording export gate requires isolated hidden/muted test"
        );
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "Recording export gate must be absolute");
        fs::write(path.with_extension("ready"), b"ready")?;
        let start = std::time::Instant::now();
        while path.exists() {
            ensure!(!cancel(), "Cancelled.");
            ensure!(
                start.elapsed() < Duration::from_secs(15),
                "Recording export gate timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = cancel;
    Ok(())
}
#[cfg(test)]
#[path = "training_recording_store_tests.rs"]
mod tests;

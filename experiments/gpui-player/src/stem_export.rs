//! Desktop source-track export. Audio decoding, mixing and encoding stay in zcore.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, Metadata},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Format {
    #[default]
    Mp3,
    Wav,
    Flac,
}
impl Format {
    pub fn extension(self) -> &'static str {
        match self {
            Self::Mp3 => "mp3",
            Self::Wav => "wav",
            Self::Flac => "flac",
        }
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Stems,
    Karaoke,
}
#[derive(Clone, Debug)]
pub struct Item {
    pub label: String,
    pub name: String,
    pub sources: Vec<PathBuf>,
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub format: Format,
    pub items: Vec<Item>,
}
pub fn karaoke_lane(id: &str) -> bool {
    matches!(id, "drums" | "bass" | "other" | "guitar" | "piano")
        || id == "custom-backing-vocals"
        || id
            .strip_prefix("custom-backing-vocals-")
            .is_some_and(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()))
}
pub fn safe_name(name: &str) -> String {
    let cleaned: String = name
        .chars()
        .map(|c| {
            if c <= '\u{1f}' || "<>:\"/\\|?*".contains(c) {
                '_'
            } else {
                c
            }
        })
        .collect();
    let trimmed = cleaned.trim_end_matches(['.', ' ']);
    let utf16: Vec<u16> = trimmed.encode_utf16().take(120).collect();
    let name = String::from_utf16_lossy(&utf16);
    if name.is_empty() {
        "track".into()
    } else {
        name
    }
}
impl Plan {
    /// Pure snapshot, taken before opening the native folder chooser.
    pub fn capture(
        lanes: &[crate::tracks::Lane],
        selected: &[String],
        mode: Mode,
        format: Format,
    ) -> Result<Self> {
        Self::capture_with_karaoke_label(lanes, selected, mode, format, "Karaoke")
    }
    pub fn capture_with_karaoke_label(
        lanes: &[crate::tracks::Lane],
        selected: &[String],
        mode: Mode,
        format: Format,
        karaoke_label: &str,
    ) -> Result<Self> {
        ensure!(lanes.len() <= 64, "Too many export sources");
        let mut ids = HashSet::new();
        for lane in lanes {
            ensure!(
                ids.insert(&lane.id) && lane.file.is_absolute(),
                "Invalid or duplicate export source"
            );
        }
        let groups: Vec<(String, Vec<PathBuf>)> = match mode {
            Mode::Stems => lanes
                .iter()
                .filter(|l| selected.contains(&l.id))
                .map(|l| {
                    (
                        if l.id == "original" {
                            "Original".into()
                        } else {
                            l.label.clone()
                        },
                        vec![l.file.clone()],
                    )
                })
                .collect(),
            Mode::Karaoke => {
                let paths: Vec<_> = lanes
                    .iter()
                    .filter(|l| karaoke_lane(&l.id))
                    .map(|l| l.file.clone())
                    .collect();
                if paths.is_empty() {
                    vec![]
                } else {
                    vec![(karaoke_label.into(), paths)]
                }
            }
        };
        ensure!(!groups.is_empty(), "Choose at least one track to export");
        Ok(Self {
            format,
            items: groups
                .into_iter()
                .enumerate()
                .map(|(i, (label, sources))| Item {
                    name: format!(
                        "{}.{}",
                        safe_name(&format!("{:02}-{label}", i + 1)),
                        format.extension()
                    ),
                    label,
                    sources,
                })
                .collect(),
        })
    }
}
#[derive(Debug)]
pub struct Event {
    pub id: u64,
    pub kind: EventKind,
}
#[derive(Debug)]
pub enum EventKind {
    Progress {
        index: usize,
        total: usize,
        label: String,
    },
    Finished {
        files: Vec<PathBuf>,
        cancelled: bool,
        error: Option<String>,
    },
}
struct Request {
    id: u64,
    plan: Plan,
    destination: PathBuf,
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
    pub fn new(helper: PathBuf) -> Self {
        let (tx, rx) = mpsc::sync_channel::<Request>(16);
        let shared = Arc::new(Shared {
            stopped: AtomicBool::new(false),
            serial: AtomicU64::new(0),
            pending: Mutex::new(HashSet::new()),
            cancelled: Mutex::new(HashSet::new()),
            events: Mutex::new(VecDeque::new()),
        });
        let state = shared.clone();
        let worker = thread::spawn(move || {
            while !state.stopped.load(Ordering::Acquire)
                || !state.pending.lock().unwrap().is_empty()
            {
                let Ok(request) = rx.recv_timeout(Duration::from_millis(30)) else {
                    continue;
                };
                let cancel = || {
                    state.stopped.load(Ordering::Acquire)
                        || state.cancelled.lock().unwrap().contains(&request.id)
                };
                let result = run(
                    &request.plan,
                    &request.destination,
                    &cancel,
                    |path, format, sources, cancel| {
                        #[cfg(feature = "ui-tests")]
                        before_encode_test_gate(cancel)?;
                        encode(&helper, path, format, sources, cancel)
                    },
                    |index, total, label| {
                        state.events.lock().unwrap().push_back(Event {
                            id: request.id,
                            kind: EventKind::Progress {
                                index,
                                total,
                                label,
                            },
                        })
                    },
                );
                state.cancelled.lock().unwrap().remove(&request.id);
                state.pending.lock().unwrap().remove(&request.id);
                state.events.lock().unwrap().push_back(Event {
                    id: request.id,
                    kind: result,
                });
            }
        });
        Self {
            tx,
            shared,
            worker: Some(worker),
        }
    }
    pub fn start(&self, plan: Plan, destination: PathBuf) -> Result<u64> {
        ensure!(
            !self.shared.stopped.load(Ordering::Acquire),
            "Export worker stopped"
        );
        let mut pending = self.shared.pending.lock().unwrap();
        ensure!(pending.len() < 16, "Too many pending exports");
        let id = self
            .shared
            .serial
            .fetch_add(1, Ordering::AcqRel)
            .checked_add(1)
            .context("Export identifier exhausted")?;
        pending.insert(id);
        if self
            .tx
            .try_send(Request {
                id,
                plan,
                destination,
            })
            .is_err()
        {
            pending.remove(&id);
            bail!("Export queue is full");
        }
        Ok(id)
    }
    pub fn cancel(&self, id: u64) {
        if self.shared.pending.lock().unwrap().contains(&id) {
            self.shared.cancelled.lock().unwrap().insert(id);
        }
    }
    pub fn drain(&self) -> Vec<Event> {
        self.shared.events.lock().unwrap().drain(..).collect()
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
#[derive(Clone, Debug, PartialEq, Eq)]
struct Stamp {
    len: u64,
    modified: SystemTime,
    identity: Identity,
    #[cfg(unix)]
    changed: (i64, i64),
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
fn source_stamp(path: &Path) -> Result<Stamp> {
    let m = fs::symlink_metadata(path)?;
    ensure!(
        m.file_type().is_file() && m.len() > 0 && m.len() <= 2 * 1024 * 1024 * 1024,
        "Export source must be an ordinary nonempty file of at most 2 GiB"
    );
    ensure!(
        path.canonicalize()? == path,
        "Export source is linked or not canonical"
    );
    Ok(Stamp {
        len: m.len(),
        modified: m.modified()?,
        identity: identity(path, &m)?,
        #[cfg(unix)]
        changed: {
            use std::os::unix::fs::MetadataExt;
            (m.ctime(), m.ctime_nsec())
        },
    })
}
fn source_path(path: &Path) -> Result<PathBuf> {
    ensure!(path.is_absolute(), "Export source is not absolute");
    match fs::symlink_metadata(path) {
        Ok(_) => Ok(path.to_owned()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let stem = path
                .file_stem()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            ensure!(
                path.extension()
                    .and_then(|s| s.to_str())
                    .is_some_and(|s| s.eq_ignore_ascii_case("wav"))
                    && matches!(
                        stem.as_str(),
                        "vocals" | "drums" | "bass" | "other" | "guitar" | "piano"
                    )
                    && path
                        .parent()
                        .and_then(Path::file_name)
                        .is_some_and(|s| s.to_string_lossy().eq_ignore_ascii_case("stems")),
                "Export source is missing"
            );
            Ok(path.with_extension("flac"))
        }
        Err(e) => Err(e.into()),
    }
}
struct Stage(PathBuf, Identity);
impl Drop for Stage {
    fn drop(&mut self) {
        if fs::symlink_metadata(&self.0)
            .ok()
            .filter(|m| m.is_dir())
            .and_then(|m| identity(&self.0, &m).ok())
            .as_ref()
            == Some(&self.1)
        {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
}
fn stage_dir(root: &Path) -> Result<Stage> {
    static NEXT: AtomicU64 = AtomicU64::new(0);
    for _ in 0..32 {
        let p = root.join(format!(
            ".singz-export-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        let mut b = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            b.mode(0o700);
        }
        match b.create(&p) {
            Ok(()) => {
                let id = identity(&p, &fs::symlink_metadata(&p)?)?;
                return Ok(Stage(p, id));
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
            Err(e) => return Err(e.into()),
        }
    }
    bail!("Cannot create private export staging")
}
fn run(
    plan: &Plan,
    destination: &Path,
    cancel: &dyn Fn() -> bool,
    encode: impl FnMut(&Path, Format, &[PathBuf], &dyn Fn() -> bool) -> Result<()>,
    progress: impl FnMut(usize, usize, String),
) -> EventKind {
    run_with_publication_hook(plan, destination, cancel, encode, progress, |_| {})
}
fn run_with_publication_hook(
    plan: &Plan,
    destination: &Path,
    cancel: &dyn Fn() -> bool,
    mut encode: impl FnMut(&Path, Format, &[PathBuf], &dyn Fn() -> bool) -> Result<()>,
    mut progress: impl FnMut(usize, usize, String),
    mut before_publish: impl FnMut(&Path),
) -> EventKind {
    let mut files = vec![];
    let result = (|| -> Result<()> {
        ensure!(
            !plan.items.is_empty() && plan.items.len() <= 64,
            "Invalid export plan"
        );
        ensure!(!cancel(), "Export cancelled");
        let root = destination
            .canonicalize()
            .context("Export folder is unavailable")?;
        let root_meta = fs::symlink_metadata(&root)?;
        ensure!(root_meta.is_dir(), "Choose an export folder");
        let root_id = identity(&root, &root_meta)?;
        let staging = stage_dir(&root)?;
        for (index, item) in plan.items.iter().enumerate() {
            ensure!(!cancel(), "Export cancelled");
            crate::source_jobs::validate_component(std::ffi::OsStr::new(&item.name))?;
            ensure!(
                !item.sources.is_empty() && item.sources.len() <= 64,
                "Invalid export source count"
            );
            ensure!(
                item.name
                    == format!(
                        "{}.{}",
                        safe_name(&format!("{:02}-{}", index + 1, item.label)),
                        plan.format.extension()
                    ),
                "Invalid export filename"
            );
            progress(index + 1, plan.items.len(), item.label.clone());
            let paths = item
                .sources
                .iter()
                .map(|p| source_path(p))
                .collect::<Result<Vec<_>>>()?;
            let stamps = paths
                .iter()
                .map(|p| source_stamp(p))
                .collect::<Result<Vec<_>>>()?;
            let staged = staging
                .0
                .join(format!("track-{}.{}", index, plan.format.extension()));
            encode(&staged, plan.format, &paths, cancel)?;
            ensure!(!cancel(), "Export cancelled");
            for (path, stamp) in paths.iter().zip(stamps) {
                ensure!(
                    source_stamp(path)? == stamp,
                    "Export source changed while encoding"
                );
            }
            let output = fs::symlink_metadata(&staged)?;
            ensure!(
                output.file_type().is_file() && output.len() > 0,
                "Native exporter produced no ordinary output"
            );
            // Flushing a completed file requires write access on Windows.
            fs::OpenOptions::new()
                .write(true)
                .open(&staged)?
                .sync_all()?;
            let now = fs::symlink_metadata(&root)?;
            ensure!(
                now.is_dir() && identity(&root, &now)? == root_id,
                "Export folder changed while encoding"
            );
            let target = root.join(&item.name);
            before_publish(&target);
            // This is the publication decision. Cancellation after the atomic
            // rename retains the completed file; cancellation before it must
            // never publish a newly completed output.
            ensure!(!cancel(), "Export cancelled");
            crate::project_library::publish_directory(&staged, &target).with_context(|| {
                format!(
                    "Could not publish {} without replacing an existing file",
                    target.display()
                )
            })?;
            files.push(target);
        }
        Ok(())
    })();
    EventKind::Finished {
        files,
        cancelled: cancel(),
        error: result.err().filter(|_| !cancel()).map(|e| format!("{e:#}")),
    }
}
struct Process {
    child: std::process::Child,
    reader: Option<thread::JoinHandle<()>>,
    done: bool,
}
impl Drop for Process {
    fn drop(&mut self) {
        if !self.done {
            #[cfg(unix)]
            {
                unsafe extern "C" {
                    fn kill(pid: i32, signal: i32) -> i32;
                }
                unsafe {
                    kill(-(self.child.id() as i32), 9);
                }
            }
            let _ = self.child.kill();
            let _ = self.child.wait();
        }
        if let Some(reader) = self.reader.take() {
            let _ = reader.join();
        }
    }
}
#[cfg(feature = "ui-tests")]
fn before_encode_test_gate(cancel: &dyn Fn() -> bool) -> Result<()> {
    if std::env::var_os("SINGZ_GPUI_STEM_EXPORT_TEST").is_none() {
        return Ok(());
    }
    let Some(gate) = std::env::var_os("SINGZ_GPUI_STEM_EXPORT_GATE")
        .map(PathBuf::from)
        .filter(|p| p.exists())
    else {
        return Ok(());
    };
    fs::write(gate.with_extension("ready"), b"before-native-encode")?;
    let deadline = Instant::now() + Duration::from_secs(10);
    while gate.exists() {
        ensure!(!cancel(), "Export cancelled");
        ensure!(Instant::now() < deadline, "Export UI test gate timed out");
        thread::sleep(Duration::from_millis(5));
    }
    ensure!(!cancel(), "Export cancelled");
    Ok(())
}
fn encode(
    helper: &Path,
    staged: &Path,
    format: Format,
    sources: &[PathBuf],
    cancel: &dyn Fn() -> bool,
) -> Result<()> {
    ensure!(!cancel(), "Export cancelled");
    let mut command = Command::new(helper);
    command
        .arg("--export-audio")
        .arg(format.extension())
        .arg(staged)
        .args(sources)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000200);
    }
    let child = command
        .spawn()
        .context("Native audio export helper is unavailable")?;
    let mut process = Process {
        child,
        reader: None,
        done: false,
    };
    let output = process
        .child
        .stdout
        .take()
        .context("Missing export receipt pipe")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let overflow = Arc::new(AtomicBool::new(false));
    let overflowing = overflow.clone();
    process.reader = Some(thread::spawn(move || {
        let mut bytes = vec![];
        let result = output.take(65537).read_to_end(&mut bytes).map(|_| {
            if bytes.len() > 65536 {
                overflowing.store(true, Ordering::Release);
            }
            bytes
        });
        let _ = tx.send(result);
    }));
    let deadline = Instant::now() + Duration::from_secs(1800);
    let mut cancel_deadline = None;
    let exit = loop {
        if cancel() && cancel_deadline.is_none() {
            if let Some(input) = process.child.stdin.as_mut() {
                let _ = input.write_all(b"cancel\n");
                let _ = input.flush();
            }
            cancel_deadline = Some(Instant::now() + Duration::from_secs(2));
        }
        ensure!(
            !overflow.load(Ordering::Acquire),
            "Native export receipt exceeded its bound"
        );
        ensure!(Instant::now() < deadline, "Native export timed out");
        if cancel_deadline.is_some_and(|d| Instant::now() >= d) {
            bail!("Export cancelled");
        }
        if let Some(exit) = process.child.try_wait()? {
            break exit;
        }
        thread::sleep(Duration::from_millis(5));
    };
    let bytes = rx
        .recv_timeout(Duration::from_secs(2))
        .context("Missing native export receipt")??;
    ensure!(
        bytes.len() <= 65536,
        "Native export receipt exceeded its bound"
    );
    let value: serde_json::Value =
        serde_json::from_slice(&bytes).context("Malformed native export receipt")?;
    ensure!(!cancel(), "Export cancelled");
    ensure!(
        value["protocol"] == 1 && value["ok"] == true && exit.success(),
        "{}",
        value["error"]
            .as_str()
            .unwrap_or("Native audio export failed")
    );
    let meta = fs::symlink_metadata(staged)?;
    ensure!(
        value["bytes"].as_u64() == Some(meta.len())
            && meta.len() > 0
            && value["sampleRate"]
                .as_u64()
                .is_some_and(|n| n > 0 && n <= 768000)
            && value["channels"].as_u64().is_some_and(|n| n == 1 || n == 2)
            && value["frames"].as_u64().is_some_and(|n| n > 0)
            && value["duration"]
                .as_f64()
                .is_some_and(|n| n.is_finite() && n > 0.),
        "Invalid native export media receipt"
    );
    process.done = true;
    Ok(())
}
#[cfg(test)]
#[path = "stem_export_tests.rs"]
mod tests;

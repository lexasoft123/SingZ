//! Durable native diagnostic sessions. All filesystem work belongs to one worker.
use anyhow::{Context, Result, ensure};
use chrono::{DateTime, Local, SecondsFormat, Utc};
use regex::Regex;
use serde::Serialize;
use std::{
    collections::{HashSet, VecDeque},
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, SyncSender, TrySendError},
    },
    thread,
    time::{Duration, Instant},
};
pub const MAX_ENTRIES: usize = 4000;
pub const MAX_SESSION_BYTES: u64 = 8 * 1024 * 1024;
const READ_LIMIT: u64 = MAX_SESSION_BYTES + 1024;
const FLUSH: Duration = Duration::from_millis(500);
#[derive(Clone, Copy, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Level {
    Info,
    Warn,
    Error,
}
impl Level {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Info => "info",
            Self::Warn => "warn",
            Self::Error => "error",
        }
    }
}
#[derive(Clone, Debug, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct Entry {
    pub timestamp_ms: Option<i64>,
    pub level: Level,
    pub source: String,
    pub line: String,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Session {
    pub name: String,
    pub started_at: i64,
    pub bytes: u64,
    pub current: bool,
}
#[derive(Clone, Debug, Serialize)]
pub struct Past {
    pub entries: Vec<Entry>,
    pub total: usize,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub revision: u64,
    pub entries: Vec<Entry>,
    pub session_name: Option<String>,
    pub session_full: bool,
    pub disk_error: Option<String>,
    pub dropped: u64,
}
#[derive(Clone)]
pub struct Config {
    pub directory: PathBuf,
    pub version: String,
    pub platform: String,
    pub arch: String,
}
impl Config {
    pub fn native(directory: PathBuf, version: impl Into<String>) -> Self {
        Self {
            directory,
            version: version.into(),
            platform: match std::env::consts::OS {
                "macos" => "darwin",
                "windows" => "win32",
                other => other,
            }
            .into(),
            arch: match std::env::consts::ARCH {
                "aarch64" => "arm64",
                "x86_64" => "x64",
                other => other,
            }
            .into(),
        }
    }
}
#[derive(Debug)]
pub enum Reply {
    Sessions(Vec<Session>),
    Read(Past),
    Exported(PathBuf),
}
#[derive(Debug)]
pub struct Event {
    pub id: u64,
    pub result: std::result::Result<Reply, String>,
}
enum Request {
    Line(Entry),
    List(u64),
    Read(u64, String),
    Export(u64, PathBuf, Option<String>, bool),
}
#[derive(Default)]
struct Live {
    entries: VecDeque<Entry>,
}
struct Shared {
    live: Mutex<Live>,
    tx: SyncSender<Request>,
    view: Mutex<Arc<Snapshot>>,
    events: Mutex<VecDeque<Event>>,
    pending: Mutex<HashSet<u64>>,
    cancelled: Mutex<HashSet<u64>>,
    serial: AtomicU64,
    dropped: AtomicU64,
    stopping: AtomicBool,
    revision: AtomicU64,
}
#[derive(Clone)]
pub struct Sink(Arc<Shared>);
impl Sink {
    /// Performs only bounded in-memory work; false means disk-queue refusal.
    /// The latest live entries remain available even when the disk queue is full.
    pub fn log(&self, source: &str, line: &str, level: Level) -> bool {
        if self.0.stopping.load(Ordering::Acquire) || source.len() > 8192 {
            return false;
        }
        let entry = Entry {
            timestamp_ms: Some(Utc::now().timestamp_millis()),
            level,
            source: source.into(),
            line: truncate_line(line),
        };
        append_live(&self.0, entry.clone());
        if self.0.tx.try_send(Request::Line(entry)).is_err() {
            self.0.dropped.fetch_add(1, Ordering::Relaxed);
            false
        } else {
            true
        }
    }
    pub fn log_chunk(&self, source: &str, chunk: &str, skip: Option<&Regex>) {
        static ANSI: OnceLock<Regex> = OnceLock::new();
        let text = chunk.replace('\0', "");
        let clean = ANSI
            .get_or_init(|| Regex::new("\\x1b\\[[0-9;]*m").unwrap())
            .replace_all(&text, "");
        for raw in clean.split(['\r', '\n']) {
            let line = js_trim(raw);
            if !line.is_empty() && !skip.is_some_and(|re| re.is_match(line)) {
                self.log(source, line, Level::Info);
            }
        }
    }
}
fn append_live(shared: &Shared, entry: Entry) {
    let mut live = shared.live.lock().unwrap();
    live.entries.push_back(entry);
    if live.entries.len() > MAX_ENTRIES {
        live.entries.pop_front();
    }
    shared.revision.fetch_add(1, Ordering::Release);
}
pub fn event(source: &str, line: impl Into<String>, level: Level) {
    if let Some(shared) = GLOBAL.get().and_then(|g| g.lock().ok()?.upgrade()) {
        Sink(shared).log(source, &line.into(), level);
    }
}
pub fn chunk(source: &str, text: &str, skip: Option<&Regex>) {
    log_chunk(source, text, skip);
}
static GLOBAL: OnceLock<Mutex<Weak<Shared>>> = OnceLock::new();
pub fn install_global_sink(sink: &Sink) {
    *GLOBAL
        .get_or_init(|| Mutex::new(Weak::new()))
        .lock()
        .unwrap() = Arc::downgrade(&sink.0);
}
pub fn log(source: &str, line: &str, level: Level) {
    if let Some(shared) = GLOBAL.get().and_then(|g| g.lock().ok()?.upgrade()) {
        Sink(shared).log(source, line, level);
    }
}
pub fn log_chunk(source: &str, chunk: &str, skip: Option<&Regex>) {
    if let Some(shared) = GLOBAL.get().and_then(|g| g.lock().ok()?.upgrade()) {
        Sink(shared).log_chunk(source, chunk, skip);
    }
}
pub struct Service {
    shared: Arc<Shared>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(config: Config) -> Self {
        let (tx, rx) = mpsc::sync_channel(256);
        let shared = Arc::new(Shared {
            live: Mutex::new(Live::default()),
            tx,
            view: Mutex::new(Arc::default()),
            events: Mutex::new(VecDeque::new()),
            pending: Mutex::new(HashSet::new()),
            cancelled: Mutex::new(HashSet::new()),
            serial: AtomicU64::new(0),
            dropped: AtomicU64::new(0),
            stopping: AtomicBool::new(false),
            revision: AtomicU64::new(0),
        });
        let state = shared.clone();
        let worker = thread::spawn(move || {
            let mut store = Store::new(config);
            let mut reported_drops = 0;
            store.publish(&state);
            loop {
                let stopping = state.stopping.load(Ordering::Acquire);
                let request = if stopping {
                    rx.try_recv().ok()
                } else {
                    rx.recv_timeout(store.wait()).ok()
                };
                let Some(request) = request else {
                    store.flush();
                    store.publish(&state);
                    if stopping {
                        break;
                    }
                    continue;
                };
                match request {
                    Request::Line(entry) => store.push(entry),
                    request => {
                        let id = match &request {
                            Request::List(id) | Request::Read(id, _) | Request::Export(id, ..) => {
                                *id
                            }
                            _ => unreachable!(),
                        };
                        let cancelled = || {
                            state.stopping.load(Ordering::Acquire)
                                || state.cancelled.lock().unwrap().contains(&id)
                        };
                        let result: Result<Reply> = (|| {
                            ensure!(!cancelled(), "Cancelled.");
                            store.flush();
                            match request {
                                Request::List(_) => {
                                    Ok(Reply::Sessions(store.sessions_cancellable(&cancelled)?))
                                }
                                Request::Read(_, name) => {
                                    test_gate("SINGZ_GPUI_DIAGNOSTICS_READ_GATE", &cancelled)?;
                                    let text = store.read(&name, &cancelled)?;
                                    Ok(Reply::Read(parse_session_cancellable(&text, &cancelled)?))
                                }
                                Request::Export(_, dest, name, overwrite) => {
                                    test_gate("SINGZ_GPUI_DIAGNOSTICS_SAVE_GATE", &cancelled)?;
                                    let text = if let Some(name) = name {
                                        store.read(&name, &cancelled)?
                                    } else {
                                        let live = state.live.lock().unwrap();
                                        store.head()
                                            + &live
                                                .entries
                                                .iter()
                                                .map(format_entry)
                                                .collect::<String>()
                                            + if live.entries.is_empty() { "\n" } else { "" }
                                    };
                                    export(
                                        &store.config.directory,
                                        &dest,
                                        text.as_bytes(),
                                        overwrite,
                                        &cancelled,
                                    )?;
                                    let saved = Entry {
                                        timestamp_ms: Some(Utc::now().timestamp_millis()),
                                        level: Level::Info,
                                        source: "app".into(),
                                        line: truncate_line(&format!(
                                            "log saved to {}",
                                            dest.display()
                                        )),
                                    };
                                    append_live(&state, saved.clone());
                                    store.push(saved);
                                    Ok(Reply::Exported(dest))
                                }
                                _ => unreachable!(),
                            }
                        })();
                        state.cancelled.lock().unwrap().remove(&id);
                        state.events.lock().unwrap().push_back(Event {
                            id,
                            result: result.map_err(|e| format!("{e:#}")),
                        });
                    }
                }
                let dropped = state.dropped.load(Ordering::Relaxed);
                if dropped > reported_drops {
                    let warning = Entry {
                        timestamp_ms: Some(Utc::now().timestamp_millis()),
                        level: Level::Warn,
                        source: "app".into(),
                        line: format!(
                            "{} diagnostic file entries dropped while the bounded worker queue was full; the Log dialog retains the latest entries",
                            dropped - reported_drops
                        ),
                    };
                    reported_drops = dropped;
                    append_live(&state, warning.clone());
                    store.push(warning);
                }
                store.publish(&state);
                if store.pending_since.is_some_and(|t| t.elapsed() >= FLUSH) {
                    store.flush();
                    store.publish(&state);
                }
            }
            store.flush();
            store.publish(&state);
        });
        Self {
            shared,
            worker: Some(worker),
        }
    }
    pub fn sink(&self) -> Sink {
        Sink(self.shared.clone())
    }
    /// Cheap polling stamp; request a snapshot only when this changes.
    pub fn revision(&self) -> u64 {
        self.shared.revision.load(Ordering::Acquire)
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        let revision = self.revision();
        let mut snapshot = (**self.shared.view.lock().unwrap()).clone();
        let live = self.shared.live.lock().unwrap();
        snapshot.revision = revision;
        snapshot.entries = live.entries.iter().cloned().collect();
        snapshot.dropped = self.shared.dropped.load(Ordering::Relaxed);
        Arc::new(snapshot)
    }
    fn request(&self, make: impl FnOnce(u64) -> Request) -> Result<u64> {
        ensure!(
            !self.shared.stopping.load(Ordering::Acquire),
            "Log worker has stopped"
        );
        let mut pending = self.shared.pending.lock().unwrap();
        ensure!(pending.len() < 64, "Log request queue is full");
        let id = self.shared.serial.fetch_add(1, Ordering::Relaxed) + 1;
        pending.insert(id);
        if let Err(error) = self.shared.tx.try_send(make(id)) {
            pending.remove(&id);
            return Err(anyhow::anyhow!(match error {
                TrySendError::Full(_) => "Log request queue is full",
                TrySendError::Disconnected(_) => "Log worker has stopped",
            }));
        }
        Ok(id)
    }
    pub fn list(&self) -> Result<u64> {
        self.request(Request::List)
    }
    pub fn read(&self, name: String) -> Result<u64> {
        self.request(|id| Request::Read(id, name))
    }
    /// overwrite must come from the user's accepted native Save dialog.
    pub fn export(&self, dest: PathBuf, session: Option<String>, overwrite: bool) -> Result<u64> {
        self.request(|id| Request::Export(id, dest, session, overwrite))
    }
    pub fn cancel(&self, id: u64) {
        if self.shared.pending.lock().unwrap().contains(&id) {
            self.shared.cancelled.lock().unwrap().insert(id);
        }
    }
    pub fn drain(&self) -> Vec<Event> {
        let events: Vec<_> = self.shared.events.lock().unwrap().drain(..).collect();
        let mut pending = self.shared.pending.lock().unwrap();
        for event in &events {
            pending.remove(&event.id);
        }
        events
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shared.stopping.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn js_trim(text: &str) -> &str {
    text.trim_matches(|c|matches!(c,'\u{0009}'..='\u{000d}'|' '|'\u{00a0}'|'\u{1680}'|'\u{2000}'..='\u{200a}'|'\u{2028}'|'\u{2029}'|'\u{202f}'|'\u{205f}'|'\u{3000}'|'\u{feff}'))
}
pub fn truncate_line(text: &str) -> String {
    String::from_utf16_lossy(&text.encode_utf16().take(2000).collect::<Vec<_>>())
}
fn iso(ms: i64) -> String {
    DateTime::<Utc>::from_timestamp_millis(ms)
        .unwrap_or_default()
        .to_rfc3339_opts(SecondsFormat::Millis, true)
}
pub fn format_local(ms: Option<i64>) -> String {
    ms.and_then(DateTime::<Utc>::from_timestamp_millis)
        .map(|d| d.with_timezone(&Local).format("%H:%M:%S").to_string())
        .unwrap_or_default()
}
pub fn format_copy(entries: &[Entry]) -> String {
    entries
        .iter()
        .map(|e| {
            format!(
                "{} [{}] {}: {}",
                format_local(e.timestamp_ms),
                e.level.as_str(),
                e.source,
                e.line
            )
        })
        .collect::<Vec<_>>()
        .join("\n")
}
fn format_entry(e: &Entry) -> String {
    format!(
        "{} [{}] {}: {}\n",
        iso(e.timestamp_ms.unwrap_or_default()),
        e.level.as_str(),
        e.source,
        e.line
    )
}
fn session_name(name: &str) -> bool {
    static RE: OnceLock<Regex> = OnceLock::new();
    RE.get_or_init(|| Regex::new(r"^session-[0-9TZ-]+-[0-9]+\.log$").unwrap())
        .is_match(name)
}
fn parse_time(text: &str) -> Option<i64> {
    DateTime::parse_from_rfc3339(text)
        .ok()
        .map(|d| d.timestamp_millis())
        .or_else(|| {
            chrono::NaiveDate::parse_from_str(text, "%Y-%m-%d")
                .ok()?
                .and_hms_opt(0, 0, 0)
                .map(|d| d.and_utc().timestamp_millis())
        })
}
pub fn parse_session(text: &str) -> Past {
    parse_session_cancellable(text, &|| false).expect("noncancellable parser")
}
fn parse_session_cancellable(text: &str, cancel: &impl Fn() -> bool) -> Result<Past> {
    static RE: OnceLock<Regex> = OnceLock::new();
    let re = RE.get_or_init(|| Regex::new(r"^(\S+) \[(info|warn|error)\] ([^:]+): (.*)$").unwrap());
    let mut entries = VecDeque::new();
    let mut total = 0;
    for raw in text.split('\n') {
        ensure!(!cancel(), "Cancelled.");
        let entry = if let Some(m) = re.captures(raw) {
            Some(Entry {
                timestamp_ms: parse_time(&m[1]),
                level: match &m[2] {
                    "warn" => Level::Warn,
                    "error" => Level::Error,
                    _ => Level::Info,
                },
                source: m[3].into(),
                line: m[4].into(),
            })
        } else if !js_trim(raw).is_empty() {
            Some(Entry {
                timestamp_ms: None,
                level: Level::Info,
                source: String::new(),
                line: raw.into(),
            })
        } else {
            None
        };
        if let Some(entry) = entry {
            total += 1;
            entries.push_back(entry);
            if entries.len() > MAX_ENTRIES {
                entries.pop_front();
            }
        }
    }
    Ok(Past {
        entries: entries.into(),
        total,
    })
}
struct Store {
    config: Config,
    ring: VecDeque<Entry>,
    session: Option<(String, File)>,
    bytes: u64,
    full: bool,
    error: Option<String>,
    pending: Vec<u8>,
    pending_since: Option<Instant>,
    revision: u64,
}
impl Store {
    fn new(config: Config) -> Self {
        let mut store = Self {
            config,
            ring: VecDeque::new(),
            session: None,
            bytes: 0,
            full: false,
            error: None,
            pending: vec![],
            pending_since: None,
            revision: 0,
        };
        if let Err(error) = store.start() {
            store.error = Some(format!("{error:#}"));
        }
        store
    }
    fn head(&self) -> String {
        format!(
            "SingZ {} — {}-{}\n",
            self.config.version, self.config.platform, self.config.arch
        )
    }
    fn start(&mut self) -> Result<()> {
        ensure!(
            self.config.directory.is_absolute(),
            "Log directory must be absolute"
        );
        fs::create_dir_all(&self.config.directory)?;
        ensure!(
            fs::symlink_metadata(&self.config.directory)?
                .file_type()
                .is_dir(),
            "Log directory must be ordinary"
        );
        for attempt in 0..32 {
            let stamp = iso(Utc::now().timestamp_millis() + attempt).replace([':', '.'], "-");
            let name = format!("session-{stamp}-{}.log", std::process::id());
            match OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(self.config.directory.join(&name))
            {
                Ok(mut file) => {
                    let head = self.head();
                    file.write_all(head.as_bytes())?;
                    file.flush()?;
                    self.bytes = head.len() as u64;
                    self.session = Some((name, file));
                    break;
                }
                Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(error) => return Err(error.into()),
            }
        }
        ensure!(self.session.is_some(), "Could not allocate a log session");
        let sessions = self.sessions()?;
        for old in sessions.into_iter().skip(11) {
            let path = self.config.directory.join(old.name);
            if let Ok(meta) = fs::symlink_metadata(&path) {
                if meta.file_type().is_file() && meta.len() <= READ_LIMIT {
                    let _ = fs::remove_file(path);
                }
            }
        }
        Ok(())
    }
    fn push(&mut self, entry: Entry) {
        if self.session.is_some() && !self.full && self.error.is_none() {
            self.pending
                .extend_from_slice(format_entry(&entry).as_bytes());
            self.pending_since.get_or_insert_with(Instant::now);
        }
        let immediate = entry.level != Level::Info;
        self.ring.push_back(entry);
        if self.ring.len() > MAX_ENTRIES {
            self.ring.pop_front();
        }
        if immediate || self.pending.len() as u64 >= MAX_SESSION_BYTES {
            self.flush();
        }
    }
    fn wait(&self) -> Duration {
        self.pending_since
            .map(|t| FLUSH.saturating_sub(t.elapsed()))
            .unwrap_or(FLUSH)
    }
    fn flush(&mut self) {
        if self.pending.is_empty() {
            self.pending_since = None;
            return;
        }
        let mut pending = std::mem::take(&mut self.pending);
        self.pending_since = None;
        if self.bytes.saturating_add(pending.len() as u64) > MAX_SESSION_BYTES {
            pending=format!("{} [warn] app: log file reached 8 MB — the rest of this session is only in the Log dialog\n",iso(Utc::now().timestamp_millis())).into_bytes();
            self.full = true;
        }
        if let Some((_, file)) = &mut self.session {
            match file.write_all(&pending).and_then(|_| file.flush()) {
                Ok(()) => self.bytes += pending.len() as u64,
                Err(error) => {
                    self.error = Some(error.to_string());
                    self.full = true;
                }
            }
        }
    }
    fn publish(&mut self, shared: &Shared) {
        let mut view = shared.view.lock().unwrap();
        let name = self.session.as_ref().map(|(name, _)| name.clone());
        let dropped = shared.dropped.load(Ordering::Relaxed);
        if view.session_name == name
            && view.session_full == self.full
            && view.disk_error == self.error
            && view.dropped == dropped
        {
            return;
        }
        self.revision += 1;
        *view = Arc::new(Snapshot {
            revision: self.revision,
            entries: vec![],
            session_name: self.session.as_ref().map(|(name, _)| name.clone()),
            session_full: self.full,
            disk_error: self.error.clone(),
            dropped: shared.dropped.load(Ordering::Relaxed),
        });
        shared.revision.fetch_add(1, Ordering::Release);
    }
    fn format(&self) -> String {
        self.head()
            + &self.ring.iter().map(format_entry).collect::<String>()
            + if self.ring.is_empty() { "\n" } else { "" }
    }
    fn sessions(&self) -> Result<Vec<Session>> {
        self.sessions_cancellable(&|| false)
    }
    fn sessions_cancellable(&self, cancel: &impl Fn() -> bool) -> Result<Vec<Session>> {
        let mut result = vec![];
        for (index, item) in fs::read_dir(&self.config.directory)?.enumerate() {
            ensure!(!cancel(), "Cancelled.");
            ensure!(index < 100000, "Log directory exceeds inventory limit");
            let item = item?;
            let Some(name) = item.file_name().to_str().map(str::to_owned) else {
                continue;
            };
            if !session_name(&name) {
                continue;
            }
            let Ok(meta) = fs::symlink_metadata(item.path()) else {
                continue;
            };
            if !meta.file_type().is_file() || meta.len() > READ_LIMIT {
                continue;
            }
            let stamp = name
                .get(8..32)
                .and_then(|s| {
                    let mut value = s.to_owned();
                    for range in [13..14, 16..17] {
                        value.replace_range(range, ":");
                    }
                    value.replace_range(19..20, ".");
                    DateTime::parse_from_rfc3339(&value).ok()
                })
                .map(|d| d.timestamp_millis());
            let started_at = stamp.unwrap_or_else(|| {
                meta.modified()
                    .ok()
                    .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                    .map(|t| t.as_millis() as i64)
                    .unwrap_or_default()
            });
            result.push(Session {
                name: name.clone(),
                started_at,
                bytes: meta.len(),
                current: self.session.as_ref().is_some_and(|(s, _)| s == &name),
            });
        }
        result.sort_by(|a, b| b.name.cmp(&a.name));
        Ok(result)
    }
    fn read(&self, name: &str, cancel: &impl Fn() -> bool) -> Result<String> {
        ensure!(session_name(name), "That session log is no longer kept.");
        read_text(&self.config.directory.join(name), cancel)
    }
}
fn read_text(path: &Path, cancel: &impl Fn() -> bool) -> Result<String> {
    let before = fs::symlink_metadata(path)?;
    ensure!(
        before.file_type().is_file() && before.len() <= READ_LIMIT,
        "Session log must be ordinary and bounded"
    );
    let mut file = open_read(path)?;
    let after = file.metadata()?;
    ensure!(
        after.file_type().is_file() && same_file(&before, &after),
        "Session changed while opening"
    );
    let mut bytes = vec![];
    let mut chunk = [0u8; 32768];
    loop {
        ensure!(!cancel(), "Cancelled.");
        let n = file.read(&mut chunk)?;
        if n == 0 {
            break;
        }
        ensure!(
            bytes.len() + n <= READ_LIMIT as usize,
            "Session log exceeds limit"
        );
        bytes.extend_from_slice(&chunk[..n]);
    }
    Ok(String::from_utf8_lossy(&bytes).into_owned())
}
fn open_read(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4); // O_NOFOLLOW | O_NONBLOCK
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
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        a.dev() == b.dev() && a.ino() == b.ino() && a.len() == b.len()
    }
    #[cfg(not(unix))]
    {
        a.len() == b.len() && a.modified().ok() == b.modified().ok()
    }
}
fn export(
    log_dir: &Path,
    dest: &Path,
    bytes: &[u8],
    overwrite: bool,
    cancel: &impl Fn() -> bool,
) -> Result<()> {
    ensure!(dest.is_absolute(), "Save destination must be absolute");
    let parent = dest
        .parent()
        .context("Save destination has no parent")?
        .canonicalize()?;
    ensure!(
        parent != log_dir.canonicalize().unwrap_or_default(),
        "Export cannot replace retained session files"
    );
    let dest = parent.join(
        dest.file_name()
            .context("Save destination has no filename")?,
    );
    let before = match fs::symlink_metadata(&dest) {
        Ok(meta) => {
            ensure!(
                overwrite && meta.file_type().is_file(),
                "Save destination already exists or is not ordinary"
            );
            Some(meta)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => None,
        Err(e) => return Err(e.into()),
    };
    static ID: AtomicU64 = AtomicU64::new(1);
    let temp = parent.join(format!(
        ".singz-log-export-{}-{}",
        std::process::id(),
        ID.fetch_add(1, Ordering::Relaxed)
    ));
    struct Cleanup(PathBuf);
    impl Drop for Cleanup {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let _cleanup = Cleanup(temp.clone());
    for chunk in bytes.chunks(32768) {
        ensure!(!cancel(), "Cancelled.");
        file.write_all(chunk)?;
    }
    file.sync_all()?;
    drop(file);
    ensure!(!cancel(), "Cancelled.");
    if let Some(before) = before {
        let now = fs::symlink_metadata(&dest)?;
        ensure!(
            now.file_type().is_file()
                && same_file(&before, &now)
                && before.modified().ok() == now.modified().ok(),
            "Save destination changed"
        );
        fs::rename(&temp, &dest)?;
    } else {
        fs::hard_link(&temp, &dest).context("Save destination appeared before publication")?;
    }
    Ok(())
}
fn test_gate(name: &str, cancel: &impl Fn() -> bool) -> Result<()> {
    #[cfg(feature = "ui-tests")]
    if let Some(path) = std::env::var_os(name) {
        ensure!(
            std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                && std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),
            "Log gate requires isolated hidden/muted test"
        );
        let path = PathBuf::from(path);
        ensure!(path.is_absolute(), "Log gate must be absolute");
        fs::write(path.with_extension("ready"), b"ready")?;
        let start = Instant::now();
        while path.exists() {
            ensure!(!cancel(), "Cancelled.");
            ensure!(
                start.elapsed() < Duration::from_secs(15),
                "Log gate timeout"
            );
            thread::sleep(Duration::from_millis(5));
        }
    }
    let _ = (name, cancel);
    Ok(())
}
#[cfg(test)]
#[path = "diagnostics_tests.rs"]
mod tests;

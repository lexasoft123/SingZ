//! Native file opening and existing local inference orchestration. Working
//! projects are private copies; only an explicit Save publishes into the library.
use crate::{
    integration::STEMS,
    model_catalog::{Config, Flavor},
    model_install::{cancelled, command_observe as run_command_observe},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    cell::RefCell,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Stems,
    Combined,
    Vocals,
}
/// The footer keeps progress through owned inference and native lane loading.
/// Cancellation admission is typed, never inferred from translated copy.
#[derive(Clone, Debug, PartialEq)]
pub struct SplitProgress {
    pub label: String,
    pub percent: f32,
    pub cancellable: bool,
}
impl SplitProgress {
    pub fn running(label: &str, percent: f32, cancelling: bool) -> Self {
        Self {
            label: if cancelling { "Cancelling…".into() } else { split_label(label) },
            percent,
            cancellable: !cancelling,
        }
    }
    pub fn stage(label: &str, percent: f32, mode: Mode, combined: bool, cancelling: bool) -> Self {
        let label = if mode == Mode::Vocals && label != "Loading vocals…" { "Separating vocals" } else { label };
        if !combined || mode == Mode::Combined { return Self::running(label, percent, cancelling); }
        let step = if mode == Mode::Stems { 1 } else { 2 };
        let mut progress = Self::running(label, ((step - 1) as f32 * 100. + percent) / 2., cancelling);
        if !cancelling {
            progress.label = crate::i18n::tv("library.splitWorkflow.combinedLabel", &[("step", step.to_string()), ("label", progress.label)]);
        }
        progress
    }
}
fn split_label(label: &str) -> String {
    let (step, label) = if let Some(label) = label.strip_prefix("1/2 · ") {
        (Some(1), label)
    } else if let Some(label) = label.strip_prefix("2/2 · ") {
        (Some(2), label)
    } else { (None, label) };
    let key = match label {
        "Preparing…" | "Checking splitter…" | "Preparing audio…" => "warmingUp",
        "Splitting stems" => "splittingStems",
        "Separating vocals" => "separatingVocals",
        "Loading stems…" => "loadingStems",
        "Loading vocals…" => "loadingVocals",
        _ => return label.to_owned(),
    };
    let label = crate::i18n::t(&format!("library.splitWorkflow.{key}"));
    step.map_or_else(|| label.clone(), |step| crate::i18n::tv(
        "library.splitWorkflow.combinedLabel", &[("step", step.to_string()), ("label", label.clone())]))
}
fn loading_stage(mode: Mode, vocals: bool) -> (&'static str, f32) {
    match (mode, vocals) {
        (Mode::Combined, false) => ("1/2 · Loading stems…", 49.5),
        (Mode::Combined, true) => ("2/2 · Loading vocals…", 99.5),
        (Mode::Vocals, _) => ("Loading vocals…", 99.),
        _ => ("Loading stems…", 99.),
    }
}
/// Rollback data is captured before replacing the original graph, and can only
/// be requested once by the owner of this exact native load epoch.
#[derive(Clone)]
pub struct SplitHandoff<T> {
    pub epoch: u64,
    pub retired_job: u64,
    pub mode: Mode,
    pub combined: bool,
    pub rollback: T,
    pub cancelling: bool,
}
impl<T: Clone> SplitHandoff<T> {
    pub fn new(epoch: u64, retired_job: u64, mode: Mode, combined: bool, rollback: T) -> Self {
        Self { epoch, retired_job, mode, combined, rollback, cancelling: false }
    }
    pub fn cancel(&mut self, epoch: u64) -> Option<T> {
        if self.epoch != epoch || self.cancelling { return None; }
        self.cancelling = true;
        Some(self.rollback.clone())
    }
    pub fn continue_after_acceptance(&self, epoch: u64) -> bool {
        self.epoch == epoch && self.combined && self.mode == Mode::Stems && !self.cancelling
    }
    pub fn progress(&self, epoch: u64) -> Option<SplitProgress> {
        if self.epoch != epoch { return None; }
        let (label, percent) = loading_stage(if self.combined { Mode::Combined } else { self.mode }, self.mode != Mode::Stems);
        Some(SplitProgress::running(label, percent, self.cancelling))
    }
}
#[derive(Clone, Debug)]
pub struct Target {
    pub dir: PathBuf,
    pub fingerprint: String,
    /// Independent editor Saves do not change project.json. Keep their original
    /// identity so publishing a working re-split cannot overwrite newer words.
    pub lyrics_fingerprint: Option<String>,
}
#[derive(Clone, Debug)]
pub struct Output {
    /// Hash of the exact metadata bytes committed by an owned Save.
    pub publication_hash: Option<String>,
    pub path: PathBuf,
    pub working: bool,
    pub target: Option<Target>,
}
pub enum Job {
    Open(PathBuf),
    /// Reconcile an accepted independent editor Save that completed after a
    /// split's first snapshot. This reuses the computed private output.
    RefreshLyrics {
        source_dir: PathBuf,
        expected: Option<String>,
        output: Output,
    },
    Split {
        dir: PathBuf,
        raw: Value,
        custom: Vec<crate::tracks::Lane>,
        mode: Mode,
        /// Combined UI stage one must validate the vocal model before inference.
        require_vocals: bool,
        target: Option<Target>,
    },
    Save {
        dir: PathBuf,
        raw: Value,
        custom: Vec<crate::tracks::Lane>,
        target: Option<Target>,
    },
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub revision: u64,
    pub generation: u64,
    pub busy: bool,
    pub label: String,
    pub percent: f32,
    pub ready: bool,
    pub engine_status: crate::engine_status::EngineStatus,
    /// Changes only when discovery completes, never for ordinary job progress.
    pub engine_revision: u64,
    /// Monotonic start of the discovery producing engine_revision.
    pub engine_probe_started: Option<Instant>,
    pub result: Option<Output>,
    pub error: Option<String>,
}
enum Request {
    Run(u64, Job),
    Check(u64),
    Quit,
}
pub struct Service {
    serial: Arc<AtomicU64>,
    retired: Arc<AtomicU64>,
    tx: SyncSender<Request>,
    view: Arc<Mutex<Arc<Snapshot>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new() -> Self {
        let service = Self::new_unchecked();
        let _ = service.check();
        service
    }
    /// A separate instance lets dialog rechecks avoid cancelling active source jobs.
    pub fn new_unchecked() -> Self {
        Self::new_with_start_hook(|| {})
    }
    fn new_with_start_hook(start: impl FnOnce() + Send + 'static) -> Self {
        let (tx, rx) = mpsc::sync_channel(8);
        let serial = Arc::new(AtomicU64::new(1));
        let generation = serial.clone();
        let view = Arc::new(Mutex::new(Arc::new(Snapshot::default())));
        let output = view.clone();
        let retired = Arc::new(AtomicU64::new(0));
        let worker_retired = retired.clone();
        let worker = thread::spawn(move || {
            start();
            let config = Config::source();
            let mut state = Snapshot::default();
            while let Ok(req) = rx.recv() {
                if let Request::Check(id) = req {
                    if cancelled(&generation, id).is_ok() {
                        state.generation = id;
                        state.result = None;
                        let started = Instant::now();
                        match crate::engine_status::discover(&config, &generation, id) {
                            Ok(status) if cancelled(&generation, id).is_ok() => {
                                state.ready = status.ok;
                                state.engine_status = status;
                                state.error = None;
                                state.engine_probe_started = Some(started);
                                state.engine_revision += 1;
                                publish(&mut state, &output);
                            }
                            Err(error) if cancelled(&generation, id).is_ok() => {
                                state.ready = false;
                                state.engine_status = crate::engine_status::EngineStatus {
                                    needs_models: false,
                                    message: Some(format!("{error:#}")),
                                    ..Default::default()
                                };
                                state.error = Some(format!("{error:#}"));
                                state.engine_probe_started = Some(started);
                                state.engine_revision += 1;
                                publish(&mut state, &output);
                            }
                            Ok(_) | Err(_) => {}
                        }
                    }
                    continue;
                }
                let Request::Run(id, job) = req else { break };
                if cancelled(&generation, id).is_err() {
                    worker_retired.fetch_max(id, Ordering::Release);
                    continue;
                }
                state.generation = id;
                state.busy = true;
                state.label = "Preparing…".into();
                state.percent = 0.;
                state.error = None;
                state.result = None;
                let description = match &job {
                    Job::Open(path) => format!("Opening {}", path.display()),
                    Job::Split { mode, .. } => format!("Starting {mode:?} separation"),
                    Job::Save { dir, .. } => format!("Saving project {}", dir.display()),
                    Job::RefreshLyrics { .. } => {
                        "Refreshing the working project's accepted lyrics".into()
                    }
                };
                crate::diagnostics::event("projects", description, crate::diagnostics::Level::Info);
                publish(&mut state, &output);
                let mut engine_status = state.engine_status.clone();
                let mut engine_revision = state.engine_revision;
                let mut engine_probe_started = state.engine_probe_started;
                let mut last_stage = String::new();
                // Marks bracket the complete long-running writer, not merely its
                // final UI receipt. A sync racing the copy earns a new sequence.
                let sync_save = match &job {
                    Job::Save { target, .. } => Some(SaveSync::new(
                        crate::sync_dirty::Store::new(crate::audio_devices::directory()),
                        target.as_ref().map(|t| t.dir.clone()),
                    )),
                    _ => None,
                };
                let state_updates = RefCell::new(&mut state);
                let result = execute_with_engine(
                    &config,
                    job,
                    &generation,
                    id,
                    &mut engine_status,
                    &mut engine_revision,
                    &mut engine_probe_started,
                    |status, revision, started| {
                        let mut state = state_updates.borrow_mut();
                        publish_discovery(&mut state, &output, &generation, id, status, revision, started);
                    },
                    |label, percent| {
                        if generation.load(Ordering::Acquire) != id { return; }
                        let mut state = state_updates.borrow_mut();
                        if label != last_stage {
                            crate::diagnostics::event(
                                "splitter",
                                label.to_owned(),
                                crate::diagnostics::Level::Info,
                            );
                            last_stage = label.to_owned();
                        }
                        state.label = label.into();
                        state.percent = percent;
                        publish(&mut state, &output)
                    },
                );
                drop(state_updates);
                if let Some(sync_save) = sync_save {
                    sync_save.finished(result.as_ref().ok().map(|output| output.path.as_path()));
                }
                state.ready = engine_status.ok;
                state.engine_status = engine_status;
                state.engine_revision = engine_revision;
                state.engine_probe_started = engine_probe_started;
                state.busy = false;
                if generation.load(Ordering::Acquire) == id {
                    match result {
                        Ok(result) => {
                            crate::diagnostics::event(
                                "projects",
                                format!("Project operation completed: {}", result.path.display()),
                                crate::diagnostics::Level::Info,
                            );
                            state.result = Some(result);
                        }
                        Err(e) => {
                            crate::diagnostics::event(
                                "projects",
                                format!("{e:#}"),
                                crate::diagnostics::Level::Error,
                            );
                            state.error = Some(format!("{e:#}"));
                        }
                    }
                } else if let Ok(result) = result {
                    if result.working { discard_working_copy(&result.path); }
                }
                publish(&mut state, &output);
                worker_retired.fetch_max(id, Ordering::Release);
            }
        });
        let service = Self {
            serial,
            retired,
            tx,
            view,
            worker: Some(worker),
        };
        service
    }
    pub fn start(&self, job: Job) -> Result<u64> {
        let id = self.serial.fetch_add(1, Ordering::AcqRel) + 1;
        self.tx
            .try_send(Request::Run(id, job))
            .context("Native source queue is full")?;
        Ok(id)
    }
    pub fn check(&self) -> Result<u64> {
        let id = self.serial.fetch_add(1, Ordering::AcqRel) + 1;
        self.tx
            .try_send(Request::Check(id))
            .context("Native source check queue is full")?;
        Ok(id)
    }
    pub fn cancel(&self) {
        self.serial.fetch_add(1, Ordering::AcqRel);
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.view.lock().unwrap().clone()
    }
    pub fn retired(&self, id: u64) -> bool {
        self.retired.load(Ordering::Acquire) >= id
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
fn publish(s: &mut Snapshot, view: &Mutex<Arc<Snapshot>>) {
    s.revision += 1;
    *view.lock().unwrap() = Arc::new(s.clone());
}
fn publish_discovery(
    state: &mut Snapshot,
    view: &Mutex<Arc<Snapshot>>,
    serial: &AtomicU64,
    id: u64,
    status: &crate::engine_status::EngineStatus,
    revision: u64,
    started: Option<Instant>,
) -> bool {
    if state.generation != id || serial.load(Ordering::Acquire) != id { return false; }
    state.ready = status.ok;
    state.engine_status = status.clone();
    state.engine_revision = revision;
    state.engine_probe_started = started;
    publish(state, view);
    true
}
#[cfg(test)]
thread_local! {
    static TEST_CACHE_ROOT: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static TEST_OPEN_RENDER: std::cell::Cell<bool> = const { std::cell::Cell::new(false) };
    static TEST_CACHE_EVENTS: RefCell<Option<Vec<String>>> = const { RefCell::new(None) };
}
fn cache() -> PathBuf {
    #[cfg(test)]
    if let Some(root) = TEST_CACHE_ROOT.with(|root| root.borrow().clone()) { return root; }
    crate::audio_devices::directory().join("source-work")
}
// Working copies retain a lease until the UI discards them. Abandoned copies
// are eligible for age-based pruning only after their owner releases the lease.
thread_local! {
    static WORK_DIRECTORY: RefCell<Option<PathBuf>> = const { RefCell::new(None) };
    static WORK_CHECKED: RefCell<Option<Instant>> = const { RefCell::new(None) };
}
struct WorkBudget;
impl Drop for WorkBudget {
    fn drop(&mut self) {
        WORK_DIRECTORY.with(|path| *path.borrow_mut() = None);
        WORK_CHECKED.with(|checked| *checked.borrow_mut() = None);
    }
}
pub(crate) fn check_work_budget() -> Result<()> {
    let due = WORK_CHECKED.with(|checked| checked.borrow().is_none_or(|time| time.elapsed() >= Duration::from_secs(1)));
    if due {
        WORK_DIRECTORY.with(|path| -> Result<()> {
            if let Some(path) = path.borrow().as_ref() {
                ensure!(cache_size(path)? <= 8 * 1024 * 1024 * 1024,
                    "{}", crate::i18n::t("main.error.sourceCacheFull"));
            }
            Ok(())
        })?;
        WORK_CHECKED.with(|checked| *checked.borrow_mut() = Some(Instant::now()));
    }
    Ok(())
}
fn command_observe(
    command: Command, serial: &AtomicU64, generation: u64, timeout: Duration,
    mut poll: impl FnMut() -> Result<()>,
    observe: impl FnMut(&[u8], &[u8]) -> Result<()>,
) -> Result<Vec<u8>> {
    run_command_observe(command, serial, generation, timeout, || {
        poll()?;
        check_work_budget()
    }, observe)
}
fn cache_leases() -> &'static Mutex<Vec<(PathBuf, crate::file_lease::Lease)>> {
    static LEASES: std::sync::OnceLock<Mutex<Vec<(PathBuf, crate::file_lease::Lease)>>> = std::sync::OnceLock::new();
    LEASES.get_or_init(Default::default)
}
struct CopyValue { path: PathBuf, baseline: Option<Vec<u8>>, retained: bool, split: bool }
fn cache_values() -> &'static Mutex<Vec<CopyValue>> {
    static VALUES: std::sync::OnceLock<Mutex<Vec<CopyValue>>> = std::sync::OnceLock::new();
    VALUES.get_or_init(Default::default)
}
const RETAINED: &str = ".singz-native-source-retained";
fn cache_event(line: String, level: crate::diagnostics::Level) {
    #[cfg(test)]
    TEST_CACHE_EVENTS.with(|events| { if let Some(events) = events.borrow_mut().as_mut() { events.push(line.clone()); } });
    crate::diagnostics::event("projects", line, level);
}
fn cache_skip(action: &str, path: &Path, error: impl std::fmt::Display) {
    cache_event(format!("Could not {action} source cache {}: {error}; skipped", path.display()), crate::diagnostics::Level::Warn);
}
// Old timestamp-only markers remain edited/unknown value. New markers identify
// expensive split outputs; reads are bounded even if a cache marker is corrupt.
fn cache_retention(path: &Path) -> Option<(u8, u128)> {
    let marker = path.join(RETAINED);
    let meta = match fs::symlink_metadata(&marker) {
        Ok(meta) if meta.is_file() && !meta.file_type().is_symlink() => meta,
        // A marker that exists but is a link or not a file, or cannot be inspected,
        // still says "this copy was retained": rank it as an edited copy with no
        // known last use (evicted first among retained copies, never as disposable).
        Ok(_) => return Some((1, 0)),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return None,
        Err(error) => { cache_skip("inspect retention marker for", path, error); return Some((1, 0)); }
    };
    let mut text = String::new();
    if let Err(error) = File::open(&marker).and_then(|file| file.take(128).read_to_string(&mut text)) { cache_skip("read retention marker for", path, error); }
    let (rank, stamp) = if let Some(stamp) = text.strip_prefix("split ") { (2, stamp) }
        else { (1, text.strip_prefix("edited ").unwrap_or(&text)) };
    let used = stamp.trim().parse::<u128>().ok().unwrap_or_else(|| meta.modified().ok()
        .and_then(|time| time.duration_since(std::time::UNIX_EPOCH).ok()).map_or(0, |time| time.as_nanos()));
    Some((rank, used))
}
fn cache_song_title(path: &Path) -> String {
    if fs::symlink_metadata(path.join("project.json")).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink()) {
        if let Ok((raw, _)) = crate::project_store::read(path, "project.json") {
            if let Some(title) = raw["name"].as_str() { return title.to_owned(); }
        }
    }
    path.file_name().unwrap_or_default().to_string_lossy().into_owned()
}
fn value_fingerprint(path: &Path) -> Result<Vec<u8>> {
    let mut digest = Sha256::new();
    for name in ["project.json", "lyrics.json"] {
        let file = path.join(name);
        match fs::symlink_metadata(&file) {
            Ok(meta) => {
                ensure!(meta.is_file() && !meta.file_type().is_symlink(), "Linked working-copy value");
                digest.update(name.as_bytes()); digest.update(fs::read(file)?);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    // Custom-lane creation/replacement changes the metadata or the stems tree.
    // Metadata stamps avoid rehashing potentially multi-gigabyte audio on the UI.
    let mut todo = vec![path.join("stems")]; let mut members = Vec::new();
    while let Some(file) = todo.pop() {
        match fs::symlink_metadata(&file) {
            Ok(meta) => {
                ensure!(!meta.file_type().is_symlink(), "Linked working-copy value");
                members.push((file.strip_prefix(path)?.to_owned(), meta.len(), meta.modified()?));
                ensure!(members.len() <= 32768, "Working-copy value tree is too large");
                if meta.is_dir() { for entry in fs::read_dir(file)? { todo.push(entry?.path()); } }
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    members.sort(); digest.update(format!("{members:?}").as_bytes());
    Ok(digest.finalize().to_vec())
}
fn mark_retained(path: &Path, split: bool) {
    let used = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap_or_default().as_nanos();
    if let Err(error) = fs::write(path.join(RETAINED), format!("{} {used}", if split { "split" } else { "edited" })) {
        crate::diagnostics::event("projects", format!("Could not retain working copy: {error}"), crate::diagnostics::Level::Warn);
    }
}
// Only registered working copies may be released; saved projects never enter this map.
pub(crate) fn discard_working_copy(path: &Path) {
    let mut leases = cache_leases().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(index) = leases.iter().position(|(p, _)| p == path) {
        let value = {
            let mut values = cache_values().lock().unwrap_or_else(|e| e.into_inner());
            values.iter().position(|value| value.path == path).map(|i| values.swap_remove(i))
        };
        // A failed value read is uncertainty, so preserve rather than erase edits.
        let prior = cache_retention(path);
        let split = value.as_ref().is_some_and(|value| value.split) || prior.is_some_and(|(rank, _)| rank == 2);
        let retained = path.join(RETAINED).exists() || value.as_ref().is_some_and(|value| value.retained || value.baseline.is_none()
            || value.baseline.as_ref() != value_fingerprint(path).ok().as_ref());
        if retained { mark_retained(path, split); }
        let (_, lease) = leases.swap_remove(index);
        drop(leases); drop(lease); // Windows closes the marker before directory removal.
        if !retained {
            if let Err(error) = fs::remove_dir_all(path) {
                if error.kind() != std::io::ErrorKind::NotFound {
                    crate::diagnostics::event("projects", format!("Could not remove discarded working copy: {error}"), crate::diagnostics::Level::Warn);
                }
            }
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum OpenAttempt { Deferred, Issued, Failed }
pub(crate) fn discard_failed_source_open(path: &Path, attempt: OpenAttempt, incoming: Option<&Path>, current: Option<&Path>) {
    if attempt == OpenAttempt::Failed { discard_pending_working_copy(path, incoming, current); }
}
#[cfg(test)]
pub(crate) fn adopt_working_copy(path: &Path) { adopt_working_copy_with_value(path, true); }
// A true value denotes completed split output; later UI edits use the edit hook.
pub(crate) fn adopt_working_copy_with_value(path: &Path, valuable: bool) {
    let leases = cache_leases().lock().unwrap_or_else(|e| e.into_inner());
    if !leases.iter().any(|(p, _)| p == path) { return; }
    let mut values = cache_values().lock().unwrap_or_else(|e| e.into_inner());
    let split = valuable || cache_retention(path).is_some_and(|(rank, _)| rank == 2);
    if let Some(value) = values.iter_mut().find(|value| value.path == path) {
        value.retained |= valuable; value.split |= split;
    } else {
        values.push(CopyValue { path: path.to_owned(), baseline: value_fingerprint(path).ok(), retained: valuable, split });
    }
    if valuable || path.join(RETAINED).exists() { mark_retained(path, split); }
    // Keep the eviction lease until navigation/discard, including for retained copies.
}
pub(crate) fn retain_edited_working_copy(path: &Path) {
    let mut values = cache_values().lock().unwrap_or_else(|e| e.into_inner());
    if let Some(value) = values.iter_mut().find(|value| value.path == path) {
        if !value.retained { value.retained = true; mark_retained(path, value.split); }
    }
}
// A cancelled writer can retire after navigation. Release its former UI copy
// only once the source service is idle, preserving all remaining UI references.
pub(crate) fn release_unowned_working_copies(keep: &[PathBuf]) {
    let paths: Vec<_> = cache_values().lock().unwrap_or_else(|e| e.into_inner()).iter()
        .filter(|value| !keep.contains(&value.path)).map(|value| value.path.clone()).collect();
    for path in paths { discard_working_copy(&path); }
}
pub(crate) fn discard_inactive_working_copy(path: &Path, writer_active: bool) {
    if !writer_active { discard_working_copy(path); }
}
pub(crate) fn discard_pending_working_copy(pending: &Path, incoming: Option<&Path>, current: Option<&Path>) {
    if Some(pending) != incoming && Some(pending) != current {
        discard_working_copy(pending);
    }
}
const CACHE_MAX_AGE: Duration = Duration::from_secs(24 * 60 * 60);
const CACHE_BYTES: u64 = 32 * 1024 * 1024 * 1024;
fn cache_size(root: &Path) -> Result<u64> { Ok(cache_usage(root, true)?.0) }
fn cache_usage(root: &Path, bounded: bool) -> Result<(u64, usize)> {
    let mut todo = vec![root.to_owned()]; let mut size = 0u64; let mut count = 0;
    while let Some(path) = todo.pop() {
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
            Err(error) => { cache_skip("inspect", &path, error); continue; }
        };
        count += 1;
        ensure!(!bounded || count <= 32768, "{}", crate::i18n::t("main.error.sourceCacheFull"));
        if meta.file_type().is_symlink() { continue; }
        if meta.is_dir() {
            match fs::read_dir(&path) {
                Ok(entries) => for entry in entries {
                    match entry { Ok(entry) => todo.push(entry.path()), Err(error) => cache_skip("enumerate", &path, error) }
                },
                Err(error) => cache_skip("read", &path, error),
            }
        } else if meta.is_file() {
            size = size.checked_add(meta.len()).context(crate::i18n::t("main.error.sourceCacheFull"))?;
        }
    }
    Ok((size, count))
}
#[cfg(windows)]
fn legacy_owner_alive(pid: u32) -> bool {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn OpenProcess(access: u32, inherit: i32, pid: u32) -> *mut std::ffi::c_void;
        fn GetExitCodeProcess(process: *mut std::ffi::c_void, code: *mut u32) -> i32;
        fn CloseHandle(handle: *mut std::ffi::c_void) -> i32;
    }
    if pid == 0 { return true; }
    let handle = unsafe { OpenProcess(0x1000, 0, pid) }; // QUERY_LIMITED_INFORMATION
    if handle.is_null() {
        // ERROR_INVALID_PARAMETER establishes a nonexistent PID. Access denial
        // or another query failure is not proof that an old owner stopped.
        return std::io::Error::last_os_error().raw_os_error() != Some(87);
    }
    let mut code = 259; // STILL_ACTIVE
    let queried = unsafe { GetExitCodeProcess(handle, &mut code) } != 0;
    unsafe { CloseHandle(handle); }
    !queried || code == 259
}
fn prune_cache(root: &Path) -> Result<usize> {
    prune_cache_at(root, std::time::SystemTime::now())
}
fn prune_cache_at(root: &Path, now: std::time::SystemTime) -> Result<usize> {
    let mut remaining = 0;
    for entry in fs::read_dir(root)? {
        let entry = match entry { Ok(entry) => entry, Err(error) => { cache_skip("enumerate", root, error); remaining += 1; continue; } };
        if entry.file_name() == ".cache.lock" { continue; }
        let text = entry.file_name().to_string_lossy().into_owned();
        let generated = text.split('-').count() == 3
            && text.split('-').all(|s| !s.is_empty() && s.bytes().all(|b| b.is_ascii_digit()));
        let ordinary = match entry.file_type() { Ok(kind) => kind.is_dir(), Err(error) => { cache_skip("inspect", &entry.path(), error); remaining += 1; continue; } };
        if !ordinary { remaining += 1; continue; }
        // Legacy entries have no lease. Preserve them until their owning process
        // is known gone; a long-running old version may still be playing them.
        let marker = entry.path().join(".source-work-active");
        let legacy = !marker.exists();
        #[cfg(unix)]
        let legacy_alive = legacy && text.split('-').next().and_then(|s| s.parse::<i32>().ok())
            .is_none_or(|pid| pid <= 0 || unsafe { libc::kill(pid, 0) } == 0
                || std::io::Error::last_os_error().raw_os_error() != Some(libc::ESRCH));
        #[cfg(windows)]
        let legacy_alive = legacy && text.split('-').next().and_then(|s| s.parse::<u32>().ok()).is_none_or(legacy_owner_alive);
        let expired = legacy || match entry.metadata() {
            Ok(meta) => meta.modified().ok().and_then(|modified| now.duration_since(modified).ok()).is_some_and(|age| age >= CACHE_MAX_AGE),
            Err(error) => { cache_skip("inspect age of", &entry.path(), error); remaining += 1; continue; }
        };
        if generated && ordinary && !legacy_alive && expired && !entry.path().join(".singz-native-source-retained").exists() {
            // Never follow a replaced/symlinked ownership marker.
            if fs::symlink_metadata(&marker).is_ok_and(|m| !m.is_file() || m.file_type().is_symlink()) {
                remaining += 1;
                continue;
            }
            let file = match OpenOptions::new().read(true).write(true).create(true).truncate(false).open(&marker) {
                Ok(file) => file, Err(error) => { cache_skip("open ownership marker for", &entry.path(), error); remaining += 1; continue; }
            };
            match crate::file_lease::Lease::movable(file) {
                Ok(lease) => {
                    // Windows cannot remove a directory containing an open file.
                    // The cache-wide lease excludes cooperating creators/pruners.
                    drop(lease);
                    match fs::remove_dir_all(entry.path()) {
                        Ok(()) => continue,
                        Err(error) => cache_skip("prune", &entry.path(), error),
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
                Err(error) => cache_skip("lock", &entry.path(), error),
            }
        }
        remaining += 1;
    }
    Ok(remaining)
}
// Called only under the cache-wide lease. In-use marker leases take priority
// over LRU, across threads and processes. Under pressure, unaccepted abandoned
// copies are cheapest, then edited copies, then split outputs; each class is LRU.
fn reclaim_cache(root: &Path, budget: u64, reserve: u64) -> Result<()> {
    // Reserve the new directory and ownership marker as well as its byte budget.
    reclaim_cache_limits(root, budget, reserve, 32768 - 2)
}
fn reclaim_cache_limits(root: &Path, budget: u64, reserve: u64, entry_limit: usize) -> Result<()> {
    let capacity = budget.checked_sub(reserve).context(crate::i18n::t("main.error.sourceCacheFull"))?;
    let (mut size, mut entries) = cache_usage(root, false)?;
    if size <= capacity && entries <= entry_limit { return Ok(()); }
    let mut candidates = Vec::new();
    for entry in fs::read_dir(root)? {
        let entry = match entry { Ok(entry) => entry, Err(error) => { cache_skip("enumerate", root, error); continue; } };
        let name = entry.file_name().to_string_lossy().into_owned();
        let ordinary = match entry.file_type() { Ok(kind) => kind.is_dir(), Err(error) => { cache_skip("inspect", &entry.path(), error); continue; } };
        if name.split('-').count() != 3 || !name.split('-').all(|part| !part.is_empty() && part.bytes().all(|c| c.is_ascii_digit())) || !ordinary { continue; }
        let path = entry.path(); let active = path.join(".source-work-active");
        if !fs::symlink_metadata(&active).is_ok_and(|meta| meta.is_file() && !meta.file_type().is_symlink()) { continue; }
        let (rank, used) = cache_retention(&path).unwrap_or((0, 0));
        candidates.push((rank, used, path));
    }
    candidates.sort();
    for (rank, _, path) in candidates {
        let file = match OpenOptions::new().read(true).write(true).open(path.join(".source-work-active")) {
            Ok(file) => file, Err(error) => { cache_skip("open ownership marker for", &path, error); continue; }
        };
        match crate::file_lease::Lease::movable(file) {
            Ok(lease) => {
                let (bytes, removed_entries) = match cache_usage(&path, false) {
                    Ok(usage) => usage, Err(error) => { cache_skip("measure eviction victim", &path, error); continue; }
                };
                let title = (rank > 0).then(|| cache_song_title(&path));
                let reason = if size > capacity { "cache byte budget exceeded" } else { "cache metadata entry limit exceeded" };
                drop(lease); // Windows cannot delete an open marker.
                if let Err(error) = fs::remove_dir_all(&path) {
                    cache_skip("evict", &path, error);
                    // Removal may have made partial progress; measure again
                    // before deciding whether another victim is needed.
                    (size, entries) = cache_usage(root, false)?;
                    if size <= capacity && entries <= entry_limit { return Ok(()); }
                    continue;
                }
                if let Some(title) = title {
                    cache_event(format!("Evicted retained source cache “{title}”: {reason} ({})", if rank == 2 { "split output" } else { "edited copy" }), crate::diagnostics::Level::Info);
                }
                size = size.saturating_sub(bytes);
                entries = entries.saturating_sub(removed_entries);
                if size <= capacity && entries <= entry_limit { return Ok(()); }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            Err(error) => cache_skip("lock eviction victim", &path, error),
        }
    }
    let (size, entries) = cache_usage(root, false)?;
    if size <= capacity && entries <= entry_limit { return Ok(()); }
    anyhow::bail!("{}", crate::i18n::t("main.error.sourceCacheFull"))
}
fn allocate_cache(root: &Path) -> Result<PathBuf> { allocate_cache_with_budget(root, CACHE_BYTES, 8 * 1024 * 1024 * 1024) }
fn allocate_cache_with_budget(root: &Path, budget: u64, reserve: u64) -> Result<PathBuf> {
    fs::create_dir_all(root)?;
    ensure!(!fs::symlink_metadata(root)?.file_type().is_symlink(), "{}", crate::i18n::t("main.error.linkedFilesystemPath"));
    let root = root.canonicalize()?;
    crate::project_publish::writable_filesystem(&root)?;
    let lock_path = root.join(".cache.lock");
    ensure!(!fs::symlink_metadata(&lock_path).is_ok_and(|m| m.file_type().is_symlink()), "{}", crate::i18n::t("main.error.linkedFilesystemPath"));
    let file = OpenOptions::new().read(true).write(true).create(true).truncate(false).open(lock_path)?;
    let _lease = crate::file_lease::Lease::acquire(file)?;
    cache_leases().lock().unwrap_or_else(|e| e.into_inner()).retain(|(path, _)| path.exists());
    prune_cache(&root)?;
    cache_values().lock().unwrap_or_else(|e| e.into_inner()).retain(|value| value.path.exists());
    reclaim_cache(&root, budget, reserve)?;
    let dir = root.join(token());
    fs::create_dir(&dir)?;
    let mut pending = Pending(dir.clone());
    let file = OpenOptions::new().read(true).write(true).create_new(true).open(dir.join(".source-work-active"))?;
    let owner = crate::file_lease::Lease::movable(file)?;
    let mut leases = cache_leases().lock().unwrap_or_else(|e| e.into_inner());
    leases.retain(|(path, _)| path.exists());
    leases.push((dir.clone(), owner));
    pending.0.clear();
    Ok(dir)
}
fn token() -> String {
    static ID: AtomicU64 = AtomicU64::new(1);
    format!(
        "{}-{}-{}",
        std::process::id(),
        crate::training_store::now(),
        ID.fetch_add(1, Ordering::Relaxed)
    )
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        if self
            .0
            .file_name()
            .is_some_and(|n| n.to_string_lossy().starts_with(".native-split-"))
            && self
                .0
                .parent()
                .is_some_and(|p| p.join(".singz-native-split.json").exists())
        {
            return;
        }
        discard_working_copy(&self.0);
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn copy(from: &Path, to: &Path, serial: &AtomicU64, id: u64) -> Result<()> {
    let before = from.metadata()?;
    ensure!(
        before.is_file() && before.len() <= 2 * 1024 * 1024 * 1024,
        "Audio/project member exceeds its size limit"
    );
    fs::create_dir_all(to.parent().unwrap())?;
    let mut input = File::open(from)?;
    let mut output = OpenOptions::new().write(true).create_new(true).open(to)?;
    let mut bytes = [0u8; 65536];
    let mut n = 0;
    let mut digest = Sha256::new();
    loop {
        cancelled(serial, id)?;
        check_work_budget()?;
        let got = input.read(&mut bytes)?;
        if got == 0 {
            break;
        }
        output.write_all(&bytes[..got])?;
        digest.update(&bytes[..got]);
        n += got as u64;
        ensure!(n <= before.len(), "Source changed while copying");
    }
    output.sync_all()?;
    crate::project_store::verify_written_copy(&mut input, to, &digest.finalize(), &|| serial.load(Ordering::Acquire) != id)?;
    let after = input.metadata()?;
    ensure!(
        n == before.len()
            && after.len() == before.len()
            && after.modified()? == before.modified()?,
        "Source changed while copying"
    );
    Ok(())
}
fn clone_project(from: &Path, to: &Path, serial: &AtomicU64, id: u64) -> Result<()> {
    let mut todo = vec![(from.to_owned(), to.to_owned())];
    let mut count = 0;
    let mut size = 0u64;
    while let Some((src, dst)) = todo.pop() {
        fs::create_dir_all(&dst)?;
        for entry in fs::read_dir(src)? {
            cancelled(serial, id)?;
            let entry = entry?;
            let name = entry.file_name();
            if name == ".source-work-active" || name.to_string_lossy().starts_with(".singz-native-")
                || name.to_string_lossy().starts_with(".native-split-")
            {
                continue;
            }
            let meta = fs::symlink_metadata(entry.path())?;
            ensure!(
                !meta.file_type().is_symlink(),
                "Import a project with ordinary files before splitting linked media"
            );
            count += 1;
            ensure!(count <= 4096, "Project has too many files to copy");
            let target = dst.join(name);
            if meta.is_dir() {
                todo.push((entry.path(), target));
            } else {
                size = size
                    .checked_add(meta.len())
                    .context("Project size overflow")?;
                ensure!(size <= 8 * 1024 * 1024 * 1024, "Project copy exceeds 8 GB");
                copy(&entry.path(), &target, serial, id)?;
            }
        }
    }
    Ok(())
}
fn render(input: &Path, dest: &Path, serial: &AtomicU64, id: u64) -> Result<()> {
    // Open lifecycle tests exercise the real job without requiring the separately built audio helper.
    #[cfg(test)]
    if TEST_OPEN_RENDER.with(|fixture| fixture.get()) {
        fs::copy(input, dest)?;
        return Ok(());
    }
    let mut cmd = Command::new(crate::audio_devices::helper());
    cmd.arg("--render-input").arg(input).arg(dest);
    let bytes = command_observe(
        cmd,
        serial,
        id,
        Duration::from_secs(180),
        || Ok(()),
        |_, _| Ok(()),
    )?;
    let value: Value = serde_json::from_slice(&bytes)?;
    ensure!(
        value["ok"] == true
            && value["sampleRate"] == 44100
            && value["channels"] == 2
            && value["frames"].as_u64().is_some_and(|n| n > 0),
        "Invalid native input preparation receipt"
    );
    Ok(())
}
fn python_command(config: &Config) -> Command {
    crate::engine_status::pack_command(config)
}
fn last_progress(bytes: &[u8]) -> Option<f32> {
    let text = String::from_utf8_lossy(bytes);
    let mut pct = None;
    for line in text.split(['\n', '\r']) {
        if let Ok(v) = serde_json::from_str::<Value>(line) {
            if let Some(p) = v["percent"].as_f64().filter(|p| p.is_finite()) {
                pct = Some(p as f32);
            }
        }
        if let Some((before, _)) = line.rsplit_once("%|") {
            let number = before
                .rsplit(|c: char| !c.is_ascii_digit() && c != '.')
                .next()
                .unwrap_or("");
            if let Ok(p) = number.parse::<f32>() {
                pct = Some(p);
            }
        }
        if let Some((_, tail)) = line.rsplit_once("chunk ") {
            if let Some((done, total)) = tail.split_once('/') {
                let total = total
                    .split(|c: char| !c.is_ascii_digit())
                    .next()
                    .unwrap_or("");
                if let (Ok(a), Ok(b)) = (done.parse::<f32>(), total.parse::<f32>()) {
                    if b > 0. {
                        pct = Some(a / b * 100.);
                    }
                }
            }
        }
    }
    pct.map(|p| p.clamp(0., 99.))
}
fn providers(config: &Config) -> Vec<&'static str> {
    if config.flavor == Flavor::Windows
        && config
            .pack
            .join("python/rtx/ep/onnxruntime_providers_nv_tensorrt_rtx.dll")
            .is_file()
        && !config
            .pack
            .parent()
            .unwrap()
            .join("trtrtx-disabled.json")
            .exists()
    {
        vec!["trtrtx", "cpu"]
    } else {
        vec!["cpu"]
    }
}
fn gpu_expired(
    saw_output: bool,
    saw_chunk: bool,
    quiet: Duration,
    total: Duration,
    chunk: Duration,
) -> bool {
    if !saw_output {
        quiet >= Duration::from_secs(240)
    } else if saw_chunk {
        chunk >= Duration::from_secs(300)
    } else {
        total >= Duration::from_secs(600)
    }
}
fn stems(
    config: &Config,
    engine: &crate::engine_status::ResolvedEngine,
    dir: &Path,
    input: &Path,
    serial: &AtomicU64,
    id: u64,
    progress: &mut impl FnMut(&str, f32),
    combined: bool,
) -> Result<()> {
    let onnx = matches!(
        engine,
        crate::engine_status::ResolvedEngine::Pack { onnx: true }
    );
    let runner = dir.join("onnx-runner.py");
    if onnx {
        fs::write(
            &runner,
            include_str!("../../../scripts/onnx_split_runner.py"),
        )?;
    }
    let mut last_error = None;
    for provider in if onnx {
        providers(config)
    } else {
        vec!["torch"]
    } {
        cancelled(serial, id)?;
        if onnx {
            crate::diagnostics::event(
                "splitter",
                format!("ONNX separation: trying provider {provider}"),
                crate::diagnostics::Level::Info,
            );
        }
        let output = dir.join("inference");
        if output.exists() {
            fs::remove_dir_all(&output)?;
        }
        fs::create_dir(&output)?;
        let system = engine.system_command();
        let is_system = system.is_some();
        let mut cmd = system.unwrap_or_else(|| python_command(config));
        if onnx {
            cmd.arg(&runner)
                .arg("separate")
                .arg(input)
                .arg(&output)
                .args([
                    "--model",
                    "htdemucs_6s",
                    "--precision",
                    "fp16weights",
                    "--cache-dir",
                ])
                .arg(config.pack.join("python/model-cache"))
                .args(["--providers", provider, "-v"]);
        } else {
            if !is_system {
                cmd.args(["-m", "demucs"]);
            }
            cmd.args(["-n", "htdemucs_6s", "--filename", "{stem}.{ext}", "-o"])
                .arg(&output)
                .arg(input);
        }
        let mut last_bytes = (0, 0);
        let mut last_output = Instant::now();
        let started = Instant::now();
        let mut last_chunk = Instant::now();
        let mut previous = 0.;
        let result = command_observe(
            cmd,
            serial,
            id,
            Duration::from_secs(7200),
            || Ok(()),
            |out, err| {
                if (out.len(), err.len()) != last_bytes {
                    last_output = Instant::now();
                    last_bytes = (out.len(), err.len());
                }
                let p = last_progress(err)
                    .or_else(|| last_progress(out))
                    .unwrap_or(0.);
                if p != previous {
                    last_chunk = Instant::now();
                    previous = p;
                }
                progress(
                    if combined {
                        "1/2 · Splitting stems"
                    } else {
                        "Splitting stems"
                    },
                    p * 0.98 / if combined { 2. } else { 1. },
                );
                if provider == "trtrtx" {
                    ensure!(
                        !gpu_expired(
                            !out.is_empty() || !err.is_empty(),
                            p > 0.,
                            last_output.elapsed(),
                            started.elapsed(),
                            last_chunk.elapsed()
                        ),
                        "The GPU engine is too slow; switching to CPU"
                    );
                }
                Ok(())
            },
        );
        match result {
            Ok(_) => {
                let from = if onnx {
                    output.clone()
                } else {
                    output.join("htdemucs_6s")
                };
                for stem in &STEMS[..6] {
                    let src = from.join(format!("{stem}.wav"));
                    validate_wav(&src)?;
                    let dst = dir.join("stems").join(format!("{stem}.wav"));
                    if dst.exists() {
                        fs::remove_file(&dst)?;
                    }
                    fs::rename(src, dst)?;
                    let old = dir.join("stems").join(format!("{stem}.flac"));
                    if old.exists() {
                        fs::remove_file(old)?;
                    }
                }
                fs::remove_dir_all(output)?;
                let _ = fs::remove_file(&runner);
                if onnx {
                    crate::diagnostics::event(
                        "splitter",
                        format!("ONNX separation completed using provider {provider}"),
                        crate::diagnostics::Level::Info,
                    );
                }
                return Ok(());
            }
            Err(e) => {
                cancelled(serial, id)?;
                if onnx {
                    crate::diagnostics::event(
                        "splitter",
                        format!("ONNX provider {provider} failed: {e:#}"),
                        crate::diagnostics::Level::Warn,
                    );
                }
                if provider == "trtrtx" {
                    let flag = config.pack.parent().unwrap().join("trtrtx-disabled.json");
                    let temp = dir.join("gpu-disabled.json");
                    fs::write(
                        &temp,
                        serde_json::to_vec_pretty(
                            &json!({"at":chrono::Utc::now().to_rfc3339(),"reason":e.to_string()}),
                        )?,
                    )
                    .map_err(|error| {
                        crate::diagnostics::event(
                            "splitter",
                            format!("Could not prepare the GPU-disable marker: {error}"),
                            crate::diagnostics::Level::Warn,
                        );
                        error
                    })?;
                    match crate::project_store::replace(&temp, &flag) {
                        Ok(()) => crate::diagnostics::event(
                            "splitter",
                            format!("GPU engine disabled; saved marker {}", flag.display()),
                            crate::diagnostics::Level::Warn,
                        ),
                        Err(error) => crate::diagnostics::event(
                            "splitter",
                            format!(
                                "Could not persist the GPU-disable marker {}: {error:#}",
                                flag.display()
                            ),
                            crate::diagnostics::Level::Warn,
                        ),
                    }
                    crate::diagnostics::event(
                        "splitter",
                        "Falling back to the ONNX CPU provider",
                        crate::diagnostics::Level::Info,
                    );
                }
                last_error = Some(e);
            }
        }
    }
    Err(last_error.unwrap_or_else(|| anyhow::anyhow!("No splitter engine")))
}
fn validate_wav(path: &Path) -> Result<()> {
    let mut b = [0u8; 12];
    let mut f =
        File::open(path).with_context(|| format!("Splitter did not produce {}", path.display()))?;
    f.read_exact(&mut b)?;
    ensure!(
        &b[..4] == b"RIFF" && &b[8..] == b"WAVE" && f.metadata()?.len() > 44,
        "Splitter produced an invalid WAV"
    );
    Ok(())
}
fn validate_stem(dir: &Path, stem: &str) -> Result<()> {
    let flac = dir.join("stems").join(format!("{stem}.flac"));
    if flac.is_file() {
        let mut magic = [0u8; 4];
        File::open(&flac)?.read_exact(&mut magic)?;
        ensure!(
            &magic == b"fLaC" && flac.metadata()?.len() > 42,
            "Invalid FLAC stem"
        );
        Ok(())
    } else {
        validate_wav(&dir.join("stems").join(format!("{stem}.wav")))
    }
}
fn compact(dir: &Path, serial: &AtomicU64, id: u64) -> Result<bool> {
    let mut complete = true;
    for stem in &STEMS[..6] {
        cancelled(serial, id)?;
        let wav = dir.join("stems").join(format!("{stem}.wav"));
        if !wav.is_file() {
            continue;
        }
        let mut header = [0u8; 24];
        File::open(&wav)?.read_exact(&mut header)?;
        // UVR's float residuals must remain unquantized, as in production.
        if &header[12..16] == b"fmt " && u16::from_le_bytes([header[20], header[21]]) == 3 {
            continue;
        }
        let flac = dir.join("stems").join(format!("{stem}.flac"));
        let mut cmd = Command::new(crate::audio_devices::helper());
        cmd.arg("--compact-stem").arg(&wav).arg(&flac);
        if command_observe(
            cmd,
            serial,
            id,
            Duration::from_secs(300),
            || Ok(()),
            |_, _| Ok(()),
        )
        .is_err()
        {
            cancelled(serial, id)?;
            complete = false;
        }
    }
    Ok(complete)
}
fn vocals(
    config: &Config,
    dir: &Path,
    serial: &AtomicU64,
    id: u64,
    progress: &mut impl FnMut(&str, f32),
    combined: bool,
    backing_name: &str,
) -> Result<()> {
    let runner = dir.join("vocal-runner.py");
    fs::write(
        &runner,
        include_str!("../../../scripts/vocal_split_runner.py"),
    )?;
    let output = dir.join("vocal-output");
    fs::create_dir(&output)?;
    let mut cmd = python_command(config);
    cmd.arg(&runner)
        .arg("--model")
        .arg(config.pack.join("python/models/uvr/UVR_MDXNET_KARA_2.onnx"))
        .arg("--input")
        .arg(if dir.join("stems/vocals.flac").is_file() {
            dir.join("stems/vocals.flac")
        } else {
            dir.join("stems/vocals.wav")
        })
        .arg("--output")
        .arg(&output);
    command_observe(
        cmd,
        serial,
        id,
        Duration::from_secs(7200),
        || Ok(()),
        |out, _| {
            let p = last_progress(out).unwrap_or(0.);
            progress(
                if combined {
                    "2/2 · Separating vocals"
                } else {
                    "Separating vocals"
                },
                if combined { 50. + p * 0.49 } else { p * 0.98 },
            );
            Ok(())
        },
    )?;
    for name in ["lead", "backing"] {
        validate_wav(&output.join(format!("{name}.wav")))?;
    }
    let vocal = dir.join("stems/vocals.wav");
    if vocal.exists() {
        fs::remove_file(&vocal)?;
    }
    fs::rename(output.join("lead.wav"), vocal)?;
    fs::rename(
        output.join("backing.wav"),
        dir.join("stems").join(backing_name),
    )?;
    let old = dir.join("stems/vocals.flac");
    if old.exists() {
        fs::remove_file(old)?;
    }
    fs::remove_dir_all(output)?;
    fs::remove_file(runner)?;
    Ok(())
}
fn fresh_backing_id(custom: &[crate::tracks::Lane]) -> String {
    let mut id = "custom-backing-vocals".to_owned();
    let mut n = 2;
    while custom.iter().any(|lane| lane.id == id) {
        id = format!("custom-backing-vocals-{n}");
        n += 1;
    }
    id
}
fn publish_target(
    source: &Path,
    raw: &mut Value,
    target: Target,
    custom: &[crate::tracks::Lane],
    serial: &AtomicU64,
    id: u64,
) -> Result<Output> {
    cancelled(serial, id)?;
    let _lease = crate::project_publish::lock(&target.dir)?;
    crate::project_publish::recover_locked(&target.dir)?;
    ensure!(
        crate::lyrics_store::identity(&target.dir)? == target.lyrics_fingerprint,
        "Lyrics changed in the saved project while splitting; reopen it before retrying"
    );
    let key = token();
    let staging = target.dir.join(format!(".native-split-{key}"));
    fs::create_dir(&staging)?;
    struct PublicationStage(PathBuf);
    impl Drop for PublicationStage {
        fn drop(&mut self) {
            if self
                .0
                .parent()
                .is_some_and(|p| fs::symlink_metadata(p.join(".singz-native-split.json")).is_ok())
            {
                return;
            }
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    let guard = PublicationStage(staging.clone());
    let next = staging.join("next");
    fs::create_dir(&next)?;
    let mut files = vec![];
    for stem in &STEMS[..crate::tracks::BUILTIN_SLOTS] {
        for ext in ["wav", "flac"] {
            let relative = format!("stems/{stem}.{ext}");
            let from = source.join(&relative);
            let present = from.is_file();
            if present {
                copy(&from, &next.join(&relative), serial, id)?;
            }
            files.push((relative, present));
        }
    }
    let materialized =
        crate::project_store::materialize_custom(source, &next, raw, custom, &|| {
            serial.load(Ordering::Acquire) != id
        })?;
    for warning in &materialized.warnings {
        crate::diagnostics::event("projects", warning.clone(), crate::diagnostics::Level::Warn);
    }
    files.extend(materialized.files.iter().map(|file| (file.clone(), true)));
    files.extend(
        crate::project_store::unused_custom_files(&target.dir, &materialized.files, &|| {
            serial.load(Ordering::Acquire) != id
        })?
        .into_iter()
        .map(|file| (file, false)),
    );
    let source_lyrics = crate::lyrics_store::identity(&source)?;
    ensure!(
        source_lyrics.is_some() || target.lyrics_fingerprint.is_none(),
        "Working-copy lyrics disappeared before publication"
    );
    if source_lyrics.is_some() {
        copy(
            &source.join("lyrics.json"),
            &next.join("lyrics.json"),
            serial,
            id,
        )?;
        ensure!(
            crate::lyrics_store::identity(&source)? == source_lyrics,
            "Working-copy lyrics changed while saving"
        );
        files.push(("lyrics.json".into(), true));
    }
    raw["version"] = json!(if compact(&next, serial, id)? { 2 } else { 1 });
    for (relative, present) in &mut files {
        *present = next.join(relative).is_file();
    }
    let metadata = serde_json::to_vec_pretty(&raw)?;
    let publication_hash = crate::project_store::fingerprint(&metadata);
    fs::write(next.join("project.json"), metadata)?;
    files.push(("project.json".into(), true));
    cancelled(serial, id)?;
    ensure!(
        crate::lyrics_store::identity(&source)? == source_lyrics,
        "Working-copy lyrics changed while saving"
    );
    ensure!(
        crate::lyrics_store::identity(&target.dir)? == target.lyrics_fingerprint,
        "Lyrics changed in the saved project while saving; reopen it before retrying"
    );
    crate::project_publish::commit(&target.dir, &key, files, &target.fingerprint)?;
    drop(guard);
    Ok(Output {
        publication_hash: Some(publication_hash),
        path: target.dir,
        working: false,
        target: None,
    })
}

/// Finalize lyrics independently of the potentially long inference pass. Only
/// the existing private output is changed; the active source remains untouched.
fn refresh_split_lyrics(
    source_dir: &Path,
    output_dir: &Path,
    expected: Option<&Option<String>>,
    target: &mut Option<Target>,
    serial: &AtomicU64,
    id: u64,
) -> Result<()> {
    cancelled(serial, id)?;
    let source = source_dir.canonicalize()?;
    let output = output_dir.canonicalize()?;
    ensure!(
        source != output,
        "Split lyrics output must be a separate private copy"
    );
    let _source_lease = crate::project_publish::lock(&source)?;
    crate::project_publish::recover_locked(&source)?;
    let _output_lease = crate::project_publish::lock(&output)?;
    crate::project_publish::recover_locked(&output)?;
    let source_bytes = crate::project_store::member_bytes(&source, "lyrics.json")?;
    let source_identity = source_bytes
        .as_ref()
        .map(|bytes| crate::project_store::fingerprint(bytes));
    if let Some(expected) = expected {
        ensure!(
            &source_identity == expected,
            "Lyrics changed after the editor Save; reopen the project before continuing"
        );
    }
    let target_is_source = target.as_ref().is_some_and(|target| target.dir == source);
    let old_identity = crate::lyrics_store::identity(&output)?;
    if source_identity != old_identity {
        let destination = output.join("lyrics.json");
        if let Some(bytes) = source_bytes {
            let temporary = output.join(format!(".lyrics-refresh-{}.part", token()));
            struct PendingLyrics(PathBuf);
            impl Drop for PendingLyrics {
                fn drop(&mut self) {
                    let _ = fs::remove_file(&self.0);
                }
            }
            let pending = PendingLyrics(temporary);
            let mut file = OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(&pending.0)?;
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            cancelled(serial, id)?;
            ensure!(
                crate::lyrics_store::identity(&source)? == source_identity,
                "Lyrics changed while finalizing the split"
            );
            ensure!(
                crate::lyrics_store::identity(&output)? == old_identity,
                "Working-copy lyrics changed while finalizing the split"
            );
            if old_identity.is_none() {
                fs::hard_link(&pending.0, &destination)
                    .context("Working-copy lyrics appeared while finalizing the split")?;
            } else {
                crate::project_store::replace(&pending.0, &destination)?;
            }
        } else {
            cancelled(serial, id)?;
            ensure!(
                crate::lyrics_store::identity(&source)?.is_none(),
                "Lyrics appeared while finalizing the split"
            );
            ensure!(
                crate::lyrics_store::identity(&output)? == old_identity,
                "Working-copy lyrics changed while finalizing the split"
            );
            fs::remove_file(destination)?;
        }
        #[cfg(unix)]
        File::open(&output)?.sync_all()?;
    }
    cancelled(serial, id)?;
    ensure!(
        crate::lyrics_store::identity(&source)? == source_identity,
        "Lyrics changed while finalizing the split"
    );
    if target_is_source {
        // This is the exact saved source whose current bytes we just retained.
        // A different publication target keeps its original conflict identity.
        target.as_mut().unwrap().lyrics_fingerprint = source_identity;
    }
    Ok(())
}
#[cfg(test)]
fn execute(
    config: &Config,
    job: Job,
    serial: &AtomicU64,
    id: u64,
    ready: &mut bool,
    progress: impl FnMut(&str, f32),
) -> Result<Output> {
    let mut status = crate::engine_status::EngineStatus::default();
    status.ok = *ready;
    let result = execute_with_engine(
        config,
        job,
        serial,
        id,
        &mut status,
        &mut 0,
        &mut None,
        |_, _, _| {},
        progress,
    );
    *ready = status.ok;
    result
}
fn execute_with_engine(
    config: &Config,
    job: Job,
    serial: &AtomicU64,
    id: u64,
    engine_status: &mut crate::engine_status::EngineStatus,
    engine_revision: &mut u64,
    engine_probe_started: &mut Option<Instant>,
    mut engine_changed: impl FnMut(&crate::engine_status::EngineStatus, u64, Option<Instant>),
    mut progress: impl FnMut(&str, f32),
) -> Result<Output> {
    cancelled(serial, id)?;
    let job = match job {
        Job::RefreshLyrics {
            source_dir,
            expected,
            mut output,
        } => {
            ensure!(
                output.working,
                "Only a private split output can refresh its lyrics"
            );
            progress("Updating lyrics…", 98.);
            refresh_split_lyrics(
                &source_dir,
                &output.path,
                Some(&expected),
                &mut output.target,
                serial,
                id,
            )?;
            return Ok(output);
        }
        Job::Open(path) => {
            let path = path.canonicalize()?;
            if path.is_dir() || path.file_name().is_some_and(|s| s == "project.json") {
                let project = crate::integration::read_project(&path)?;
                return Ok(Output {
        publication_hash: None,
                    path: project.dir,
                    working: false,
                    target: None,
                });
            }
            ensure!(path.extension().and_then(|s| s.to_str()).is_some_and(|ext|
                ["mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff"].iter().any(|e| ext.eq_ignore_ascii_case(e))),
                "Choose an audio file or a SingZ project");
            if path
                .parent()
                .is_some_and(|p| p.join("project.json").is_file())
            {
                let project = crate::integration::read_project(&path)?;
                return Ok(Output {
        publication_hash: None,
                    path: project.dir,
                    working: false,
                    target: None,
                });
            }
            Job::Open(path)
        }
        Job::Save { dir: source, mut raw, custom, target } => {
            progress("Saving project…", 0.);
            #[cfg(feature = "ui-tests")]
            if let Some(gate) = std::env::var_os("SINGZ_GPUI_SOURCE_SAVE_PREPARE_GATE")
                .map(PathBuf::from)
                .filter(|p| p.exists())
            {
                fs::write(gate.with_extension("ready"), b"saving")?;
                let deadline = Instant::now() + Duration::from_secs(8);
                while gate.exists() && Instant::now() < deadline {
                    cancelled(serial, id)?;
                    thread::sleep(Duration::from_millis(10));
                }
            }
            if let Some(target) = target {
                return publish_target(&source, &mut raw, target, &custom, serial, id);
            }
            Job::Save { dir: source, raw, custom, target: None }
        }
        job => job,
    };
    let dir = if matches!(&job, Job::Save { target: None, .. }) {
        let root = crate::integration::library_root();
        fs::create_dir_all(&root)?;
        crate::project_publish::writable_filesystem(&root)?;
        let dir = root.join(format!(".native-import-{}", token()));
        fs::create_dir(&dir)?;
        dir
    } else {
        allocate_cache(&cache())?
    };
    let dir = dir.canonicalize()?;
    let mut pending = Pending(dir.clone());
    WORK_DIRECTORY.with(|path| *path.borrow_mut() = Some(dir.clone()));
    let _budget = WorkBudget;
    let completed_split = matches!(&job, Job::Split { .. });
    let result = match job {
        Job::Open(path) => {
            let ext = path
                .extension()
                .and_then(|s| s.to_str())
                .unwrap_or("")
                .to_ascii_lowercase();
            ensure!(
                [
                    "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff"
                ]
                .contains(&ext.as_str()),
                "Choose an audio file or a SingZ project"
            );
            progress("Reading audio…", 0.);
            let song = format!("song.{ext}");
            copy(&path, &dir.join(&song), serial, id)?;
            progress("Decoding audio…", 20.);
            let rendered = dir.join("input44k.wav");
            render(&dir.join(&song), &rendered, serial, id)?;
            fs::remove_file(rendered)?;
            let raw = json!({"version":2,"name":path.file_stem().and_then(|s|s.to_str()).unwrap_or("Song"),"sourceFileName":path.file_name().and_then(|s|s.to_str()).unwrap_or("Song"),"songFile":song,"settings":{}});
            fs::write(dir.join("project.json"), serde_json::to_vec_pretty(&raw)?)?;
            Output {
        publication_hash: None,
                path: dir.clone(),
                working: true,
                target: None,
            }
        }
        Job::Split {
            dir: source,
            mut raw,
            custom,
            mode,
            require_vocals,
            mut target,
        } => {
            progress("Checking splitter…", 0.);
            let started = Instant::now();
            let discovered = crate::engine_status::discover(config, serial, id);
            cancelled(serial, id)?;
            *engine_probe_started = Some(started);
            *engine_revision += 1;
            match discovered {
                Ok(status) => *engine_status = status,
                Err(error) => {
                    *engine_status = crate::engine_status::EngineStatus {
                        needs_models: false,
                        message: Some(format!("{error:#}")),
                        ..Default::default()
                    };
                    engine_changed(engine_status, *engine_revision, *engine_probe_started);
                    return Err(error);
                }
            }
            engine_changed(engine_status, *engine_revision, *engine_probe_started);
            ensure!(
                engine_status.ok,
                "{}",
                engine_status
                    .message
                    .as_deref()
                    .unwrap_or("The stem splitter has not been downloaded yet.")
            );
            let engine = engine_status
                .resolved
                .as_ref()
                .context("The splitter has no validated execution command")?;
            if mode != Mode::Stems || require_vocals {
                ensure!(
                    crate::engine_status::validated_pack(config),
                    "Backing-vocal separation requires the installed splitter pack. Download or reinstall it in AI models."
                );
            }
            progress("Preparing audio…", 0.);
            clone_project(&source, &dir, serial, id)?;
            fs::create_dir_all(dir.join("stems"))?;
            let materialized = crate::project_store::materialize_custom(
                &source,
                &dir,
                &mut raw,
                &custom,
                &|| serial.load(Ordering::Acquire) != id,
            )?;
            for warning in &materialized.warnings {
                crate::diagnostics::event(
                    "projects",
                    warning.clone(),
                    crate::diagnostics::Level::Warn,
                );
            }
            for stale in
                crate::project_store::unused_custom_files(&dir, &materialized.files, &|| {
                    serial.load(Ordering::Acquire) != id
                })?
            {
                fs::remove_file(dir.join(stale))?;
            }
            let builtins = if mode == Mode::Vocals {
                STEMS[..crate::tracks::BUILTIN_SLOTS]
                    .iter()
                    .filter(|stem| {
                        ["wav", "flac"]
                            .iter()
                            .any(|ext| source.join("stems").join(format!("{stem}.{ext}")).is_file())
                    })
                    .count()
            } else {
                crate::tracks::BUILTIN_SLOTS
            };
            ensure!(
                builtins + materialized.custom.len() + usize::from(mode != Mode::Stems)
                    <= crate::tracks::MAX_ACTIVE_LANES,
                "Separating this song would exceed the native active-lane limit"
            );
            let backing_id = fresh_backing_id(&materialized.custom);
            let backing_name = format!("{backing_id}.wav");
            if mode != Mode::Vocals {
                let song = raw["songFile"]
                    .as_str()
                    .context("This project has no original song to re-split")?;
                let input = dir.join("input44k.wav");
                let source = dir.join(song).canonicalize()?;
                ensure!(source.starts_with(&dir), "Song leaves its project");
                let inference_input = if engine.needs_pcm() {
                    render(&source, &input, serial, id)?;
                    &input
                } else {
                    &source
                };
                stems(
                    config,
                    engine,
                    &dir,
                    inference_input,
                    serial,
                    id,
                    &mut progress,
                    mode == Mode::Combined,
                )?;
                let (label, percent) = loading_stage(mode, false);
                progress(label, percent);
                if engine.needs_pcm() {
                    fs::remove_file(input)?;
                }
                for key in ["melody", "key", "beat"] {
                    raw["settings"]
                        .as_object_mut()
                        .context("Invalid settings")?
                        .remove(key);
                }
            }
            if mode != Mode::Stems {
                ensure!(
                    mode == Mode::Combined || raw["settings"]["leadVocalSeparated"] != true,
                    "Backing vocals are already separated"
                );
                validate_stem(&dir, "vocals")?;
                vocals(
                    config,
                    &dir,
                    serial,
                    id,
                    &mut progress,
                    mode == Mode::Combined,
                    &backing_name,
                )?;
                let (label, percent) = loading_stage(mode, true);
                progress(label, percent);
                raw["settings"]["leadVocalSeparated"] = json!(true);
                let mut entries = raw["settings"]["custom"]
                    .as_array()
                    .cloned()
                    .unwrap_or_default();
                entries.push(json!({"id":backing_id,"label":"Backing vocals","color":"#c7e06a","file":format!("stems/{backing_name}")}));
                raw["settings"]["custom"] = Value::Array(entries);
                raw["settings"].as_object_mut().unwrap().remove("melody");
            }
            raw.as_object_mut()
                .context("Invalid project")?
                .remove("stemHashes");
            fs::write(dir.join("project.json"), serde_json::to_vec_pretty(&raw)?)?;
            for stem in &STEMS[..crate::tracks::BUILTIN_SLOTS] {
                validate_stem(&dir, stem)?;
            }
            if mode != Mode::Stems {
                validate_wav(&dir.join("stems").join(&backing_name))?;
            }
            refresh_split_lyrics(&source, &dir, None, &mut target, serial, id)?;
            Output {
        publication_hash: None,
                path: dir.clone(),
                working: true,
                target,
            }
        }
        Job::Save {
            dir: source,
            mut raw,
            custom,
            target: _,
        } => {
            clone_project(&source, &dir, serial, id)?;
            let materialized = crate::project_store::materialize_custom(
                &source,
                &dir,
                &mut raw,
                &custom,
                &|| serial.load(Ordering::Acquire) != id,
            )?;
            for warning in &materialized.warnings {
                crate::diagnostics::event(
                    "projects",
                    warning.clone(),
                    crate::diagnostics::Level::Warn,
                );
            }
            for stale in
                crate::project_store::unused_custom_files(&dir, &materialized.files, &|| {
                    serial.load(Ordering::Acquire) != id
                })?
            {
                fs::remove_file(dir.join(stale))?;
            }
            raw["version"] = json!(if compact(&dir, serial, id)? { 2 } else { 1 });
            let metadata = serde_json::to_vec_pretty(&raw)?;
            let publication_hash = crate::project_store::fingerprint(&metadata);
            fs::write(dir.join("project.json"), metadata)?;
            let root = crate::integration::library_root();
            fs::create_dir_all(&root)?;
            let lock = OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(root.join(".singz-native-import.lock"))?;
            let _lease = crate::file_lease::Lease::acquire(lock)
                .context("Another song is being saved to the library")?;
            let name = raw["name"].as_str().unwrap_or("Song");
            let mut suffix = 1;
            let destination = loop {
                cancelled(serial, id)?;
                let candidate = folder_name(name, suffix);
                validate_component(std::ffi::OsStr::new(&candidate))?;
                let p = root.join(candidate);
                match crate::project_library::publish_directory(&dir, &p) {
                    Ok(()) => break p,
                    Err(error) if error.downcast_ref::<std::io::Error>().is_some_and(|e|
                        matches!(e.kind(), std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty)) => suffix += 1,
                    Err(error) => return Err(error).context(crate::project_publish::publish_error(&p)),
                }
            };
            // Publication already succeeded. A directory flush failure must not
            // turn the real saved destination into an apparent failed Save.
            #[cfg(unix)]
            if let Err(error) = File::open(&root).and_then(|file| file.sync_all()) {
                crate::diagnostics::event("projects", format!("Saved project directory flush failed: {error}"), crate::diagnostics::Level::Warn);
            }
            return Ok(Output {
                publication_hash: Some(publication_hash),
                path: destination,
                working: false,
                target: None,
            });
        }
        Job::RefreshLyrics { .. } => anyhow::bail!("Unexpected lyrics refresh dispatch"),
    };
    cancelled(serial, id)?;
    crate::integration::read_project(&dir)?;
    ensure!(cache_size(&dir)? <= 8 * 1024 * 1024 * 1024,
        "{}", crate::i18n::t("main.error.sourceCacheFull"));
    if completed_split && result.working { adopt_working_copy_with_value(&dir, true); }
    pending.0.clear();
    Ok(result)
}
// These helpers are worker-only and accept an explicit store so publication
// tests cannot accidentally write the user's durable sync ledger.
struct SaveSync {
    store: crate::sync_dirty::Store,
    target: Option<PathBuf>,
}
fn sync_warning(result: Result<()>) {
    if let Err(error) = result {
        crate::diagnostics::event("sync", format!("Could not record project sync intent: {error:#}"), crate::diagnostics::Level::Warn);
    }
}
impl SaveSync {
    fn new(store: crate::sync_dirty::Store, target: Option<PathBuf>) -> Self {
        let value = Self { store, target };
        value.mark("saving project");
        value
    }
    fn mark(&self, reason: &str) {
        if let Some(target) = &self.target {
            sync_warning(self.store.mark_project(target, reason));
        } else {
            // The public collision-free name is unknown until encoding ends.
            sync_warning(self.store.mark_library_preserving_projects(reason));
        }
    }
    fn finished(self, published: Option<&Path>) {
        self.mark("saving project (finished)");
        if let Some(path) = published {
            sync_warning(self.store.mark_project(path, "saved project"));
        }
    }
}
// Keep room for collision suffixes and temporary publication filenames.
// Byte and UTF-16 limits both matter when a library is moved between platforms.
fn portable_name_error(name: &str) -> String {
    crate::i18n::tv("main.error.portableName", &[("name", name.into())])
}
pub(crate) fn validate_name(name: &str) -> Result<()> {
    let stem = name.split('.').next().unwrap_or("").trim_end_matches(' ').to_ascii_uppercase();
    let numbered = ["COM", "LPT"].iter().any(|prefix| {
        stem.strip_prefix(prefix).is_some_and(|n| matches!(n, "0"|"1"|"2"|"3"|"4"|"5"|"6"|"7"|"8"|"9"|"¹"|"²"|"³"))
    });
    ensure!(
        !name.is_empty() && !name.ends_with(['.', ' ']) && !name.chars().any(char::is_control)
            && name.len() <= 240 && name.encode_utf16().count() <= 240
            && !matches!(stem.as_str(), "CON"|"PRN"|"AUX"|"NUL"|"CONIN$"|"CONOUT$") && !numbered,
        "{}", portable_name_error(name)
    );
    Ok(())
}
pub(crate) fn validate_component(name: &std::ffi::OsStr) -> Result<()> {
    let name = name.to_str().with_context(|| portable_name_error(&name.to_string_lossy()))?;
    validate_name(name)?;
    ensure!(!name.chars().any(|c| "/\\:*?\"<>|".contains(c)), "{}", portable_name_error(name));
    Ok(())
}
pub(crate) fn checked_name(name: &str) -> Result<String> {
    validate_name(name)?;
    let name = safe_name(name);
    validate_component(std::ffi::OsStr::new(&name))?;
    Ok(name)
}
// New folders are portable independently of their unchanged display title.
// Fit each collision suffix separately, at UTF-8 character boundaries.
pub(crate) fn folder_name(title: &str, suffix: usize) -> String {
    let base = safe_name(title).chars().filter(|c| !c.is_control()).collect::<String>();
    let mut base = base.trim_end_matches(['.', ' ']).to_owned();
    if base.is_empty() { base = "Untitled song".into(); }
    let ending = if suffix == 1 { String::new() } else { format!(" ({suffix})") };
    while base.len() + ending.len() > 240 || base.encode_utf16().count() + ending.encode_utf16().count() > 240 { base.pop(); }
    base = base.trim_end_matches(['.', ' ']).to_owned();
    let mut candidate = format!("{base}{ending}");
    if validate_component(std::ffi::OsStr::new(&candidate)).is_err() {
        // A reserved basename can have an extension: prefixing also fixes CON.txt.
        if base.contains('.') { base.insert(0, '_'); } else { base.push('_'); }
        while base.len() + ending.len() > 240 || base.encode_utf16().count() + ending.encode_utf16().count() > 240 { base.pop(); }
        candidate = format!("{base}{ending}");
    }
    candidate = candidate.trim_end_matches(['.', ' ']).to_owned();
    if validate_component(std::ffi::OsStr::new(&candidate)).is_err() {
        candidate = format!("Untitled song{ending}");
    }
    candidate
}
pub(crate) fn safe_name(name: &str) -> String {
    let mut name = name;
    if let Some((stem, ext)) = name.rsplit_once('.') {
        if [
            "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff",
        ]
        .iter()
        .any(|e| ext.eq_ignore_ascii_case(e))
        {
            name = stem;
        }
    }
    let replaced: String = name
        .chars()
        .map(|c| if "/\\:*?\"<>|".contains(c) { ' ' } else { c })
        .collect();
    let mut cleaned = String::new();
    let mut run = String::new();
    for c in replaced.chars().chain(std::iter::once('\0')) {
        if c.is_whitespace() {
            run.push(c);
            continue;
        }
        if run.chars().count() > 1 {
            cleaned.push(' ');
        } else {
            cleaned.push_str(&run);
        }
        run.clear();
        if c != '\0' {
            cleaned.push(c);
        }
    }
    let cleaned = cleaned
        .trim_start_matches(|c: char| c.is_whitespace() || c == '.')
        .trim();
    if cleaned.is_empty() {
        "Untitled song".into()
    } else {
        cleaned.into()
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn c21_prunes_abandoned_copies_but_preserves_live_owners_and_bounds_admission() {
        let fixture = Fixture::new();
        let root = fixture.0.join("cache");
        fs::create_dir(&root).unwrap();
        let dead = root.join("999999-1-1");
        fs::create_dir(&dead).unwrap();
        fs::write(dead.join(".source-work-active"), b"").unwrap();
        fs::write(dead.join("private-audio"), b"abandoned").unwrap();
        let legacy_live = root.join(format!("{}-1-1", std::process::id()));
        let legacy_dead = root.join("999999-2-2");
        fs::create_dir(&legacy_live).unwrap();
        fs::create_dir(&legacy_dead).unwrap();
        prune_cache_at(&root, std::time::SystemTime::now() + CACHE_MAX_AGE + Duration::from_secs(1)).unwrap();
        let first = allocate_cache(&root).unwrap();
        fs::write(first.join("playing"), b"keep").unwrap();
        assert!(!dead.exists(), "abandoned work survived pruning");
        assert!(!legacy_dead.exists(), "dead legacy work survived pruning");
        assert!(legacy_live.exists(), "live legacy work was evicted");
        // Unix set_len creates a sparse fixture; Windows needs a separate
        // sparse-file API before a large logical length is safe to use here.
        #[cfg(unix)]
        {
            let large = first.join("oversized");
            File::create(&large).unwrap().set_len(CACHE_BYTES - 8 * 1024 * 1024 * 1024 + 1).unwrap();
            assert!(allocate_cache(&root).is_err(), "cache admitted work beyond its byte budget");
            fs::remove_file(large).unwrap();
        }
        for _ in 0..10 { allocate_cache(&root).unwrap(); }
        assert_eq!(fs::read(first.join("playing")).unwrap(), b"keep");
        assert_eq!(prune_cache_at(&root, std::time::SystemTime::now() + CACHE_MAX_AGE + Duration::from_secs(1)).unwrap(), 12);
    }
    #[cfg(unix)]
    struct RestorePermissions(PathBuf);
    #[cfg(unix)]
    impl Drop for RestorePermissions {
        fn drop(&mut self) { use std::os::unix::fs::PermissionsExt; let _=fs::set_permissions(&self.0,fs::Permissions::from_mode(0o700)); }
    }
    fn retained_fixture(root:&Path,title:&str,split:bool)->PathBuf {
        let path=allocate_cache(root).unwrap();
        fs::write(path.join("project.json"),serde_json::to_vec(&json!({"name":title})).unwrap()).unwrap();
        fs::write(path.join("payload"),vec![0;1024]).unwrap();
        adopt_working_copy_with_value(&path,split);
        if !split { retain_edited_working_copy(&path); }
        discard_working_copy(&path);path
    }
    #[cfg(unix)]
    #[test]
    fn c21_round5_odd_retention_marker_still_counts_as_retained() {
        use std::os::unix::fs::symlink;
        let f=Fixture::new();
        let dir=f.0.join("odd-marker");fs::create_dir(&dir).unwrap();
        assert_eq!(cache_retention(&dir),None,"no marker means disposable");
        let target=f.0.join("marker-target");fs::write(&target,b"split 1").unwrap();
        symlink(&target,dir.join(RETAINED)).unwrap();
        assert_eq!(cache_retention(&dir),Some((1,0)),"a linked marker must not read as disposable");
        fs::remove_file(dir.join(RETAINED)).unwrap();fs::create_dir(dir.join(RETAINED)).unwrap();
        assert_eq!(cache_retention(&dir),Some((1,0)),"a directory marker must not read as disposable");
    }
    #[cfg(unix)]
    #[test]
    fn c21_round4_symlink_inside_retained_cache_does_not_block_admission() {
        use std::os::unix::fs::symlink;
        let f=Fixture::new();let root=f.0.join("linked");
        let victim=retained_fixture(&root,"Linked Song",false);
        let outside=f.0.join("outside");fs::create_dir(&outside).unwrap();fs::write(outside.join("keep"),b"keep").unwrap();
        symlink(&outside,victim.join("link")).unwrap();
        let incoming=allocate_cache_with_budget(&root,1536,512).expect("symlink poisoned cache admission");
        assert!(!victim.exists());assert_eq!(fs::read(outside.join("keep")).unwrap(),b"keep");discard_working_copy(&incoming);
    }
    #[cfg(unix)]
    #[test]
    fn c21_round4_unreadable_entry_does_not_block_admission() {
        use std::os::unix::fs::PermissionsExt;
        let f=Fixture::new();let root=f.0.join("unreadable");
        let victim=retained_fixture(&root,"Unreadable Song",false);
        let closed=victim.join("closed");fs::create_dir(&closed).unwrap();fs::write(closed.join("hidden"),b"private").unwrap();
        let _restore=RestorePermissions(closed.clone());fs::set_permissions(&closed,fs::Permissions::from_mode(0)).unwrap();
        assert!(fs::read_dir(&closed).is_err(),"fixture did not deny directory reads");
        let _other=retained_fixture(&root,"Other Song",false);
        let incoming=allocate_cache_with_budget(&root,2048,512).expect("unreadable entry poisoned cache admission");
        discard_working_copy(&incoming);
    }
    #[cfg(unix)]
    #[test]
    fn c21_round4_undeletable_victim_does_not_block_next_candidate() {
        use std::os::unix::fs::PermissionsExt;
        let f=Fixture::new();let root=f.0.join("locked-victim");
        let bad=retained_fixture(&root,"Blocked Song",false);
        let good=retained_fixture(&root,"Removable Song",false);
        fs::write(bad.join(RETAINED),b"1").unwrap();fs::write(good.join(RETAINED),b"2").unwrap();
        let _restore=RestorePermissions(bad.clone());fs::set_permissions(&bad,fs::Permissions::from_mode(0o500)).unwrap();
        let incoming=allocate_cache_with_budget(&root,2048,512).expect("undeletable victim poisoned cache admission");
        assert!(bad.exists());assert!(!good.exists(),"next candidate was not reclaimed");discard_working_copy(&incoming);
    }
    #[cfg(unix)]
    #[test]
    fn c21_round4_prune_skips_undeletable_directory() {
        use std::os::unix::fs::PermissionsExt;
        let f=Fixture::new();let root=f.0.join("prune-locked");
        let bad=allocate_cache(&root).unwrap();let good=allocate_cache(&root).unwrap();fs::write(bad.join("payload"),b"keep").unwrap();
        cache_leases().lock().unwrap().retain(|(path,_)|path!=&bad&&path!=&good);
        let _restore=RestorePermissions(bad.clone());fs::set_permissions(&bad,fs::Permissions::from_mode(0o500)).unwrap();
        assert_eq!(prune_cache_at(&root,std::time::SystemTime::now()+CACHE_MAX_AGE+Duration::from_secs(1)).expect("undeletable directory poisoned age pruning"),1);
        assert!(bad.exists());assert!(!good.exists());
    }
    #[test]
    fn c21_round4_edits_evicted_before_splits_with_title_and_reason_logged() {
        let f=Fixture::new();let root=f.0.join("priority");
        let split=retained_fixture(&root,"Expensive Split Song",true);
        let edited=retained_fixture(&root,"Edited Song",false);
        for (path,text,seconds) in [(&split,"split 1",1),(&edited,"edited 2",2)] {
            fs::write(path.join(RETAINED),text).unwrap();
            File::options().write(true).open(path.join(RETAINED)).unwrap().set_times(fs::FileTimes::new().set_modified(std::time::UNIX_EPOCH+Duration::from_secs(seconds))).unwrap();
        }
        struct Events;impl Drop for Events {fn drop(&mut self){TEST_CACHE_EVENTS.with(|events|*events.borrow_mut()=None);}}
        let _events=Events;TEST_CACHE_EVENTS.with(|events|*events.borrow_mut()=Some(Vec::new()));
        let total=cache_size(&root).unwrap();let incoming=allocate_cache_with_budget(&root,total,512).unwrap();
        assert!(!edited.exists(),"edited copy was kept while an expensive split was evicted");assert!(split.exists());
        assert!(TEST_CACHE_EVENTS.with(|events|events.borrow().as_ref().unwrap().iter().any(|line|line.contains("Edited Song")&&line.contains("byte budget"))),"retained eviction omitted song title or reason");
        discard_working_copy(&incoming);
    }
    #[test]
    fn c21_round3_reserved_limit_cut_at_dot_is_portable() {
        let title=format!("CON.{}.x","a".repeat(234)); assert_eq!(title.len(),240);
        let name=folder_name(&title,1);
        validate_component(std::ffi::OsStr::new(&name)).unwrap();
        assert!(!name.ends_with(['.',' ']));
    }
    #[test]
    fn c21_round3_edited_and_split_copies_survive_release() {
        for kind in ["lyrics", "custom", "controls", "split"] {
            let f=Fixture::new();let root=f.0.join("valuable");let path=allocate_cache(&root).unwrap();
            adopt_working_copy_with_value(&path,kind == "split");
            assert!(cache_leases().lock().unwrap().iter().any(|(p,_)|p==&path),"open valuable copy lost its eviction lease");
            match kind {
                "lyrics" => fs::write(path.join("lyrics.json"),b"edited lyrics").unwrap(),
                "custom" => { fs::create_dir(path.join("stems")).unwrap(); fs::write(path.join("stems/custom-piano.flac"),b"lane").unwrap(); }
                "controls" => retain_edited_working_copy(&path),
                _ => {}
            }
            discard_working_copy(&path);
            assert!(path.exists(),"valuable copy was deleted");
            assert!(path.join(".singz-native-source-retained").exists());
            assert!(!cache_leases().lock().unwrap().iter().any(|(p,_)|p==&path));
        }
    }
    #[test]
    fn c21_round3_lru_reclaims_retained_but_never_open_copy() {
        let f=Fixture::new();let root=f.0.join("lru");
        let old=allocate_cache(&root).unwrap();fs::write(old.join("payload"),vec![0;1024]).unwrap();adopt_working_copy_with_value(&old,true);discard_working_copy(&old);
        let recent=allocate_cache(&root).unwrap();fs::write(recent.join("payload"),vec![0;1024]).unwrap();adopt_working_copy_with_value(&recent,true);discard_working_copy(&recent);
        fs::write(old.join(".singz-native-source-retained"),b"1").unwrap();
        fs::write(recent.join(".singz-native-source-retained"),b"2").unwrap();
        let open=allocate_cache(&root).unwrap();fs::write(open.join("payload"),vec![0;1024]).unwrap();adopt_working_copy_with_value(&open,true);
        fs::write(open.join(".singz-native-source-retained"),b"0").unwrap();
        let total=cache_size(&root).unwrap();
        let incoming=allocate_cache_with_budget(&root,total,512).unwrap();
        assert!(!old.exists(),"least recently used retained copy was not evicted");
        assert!(recent.exists(),"newer retained copy was evicted first");assert!(open.exists(),"open copy was evicted");
        assert!(cache_size(&root).unwrap()+512<=total);
        discard_working_copy(&incoming);
        // Metadata pressure must reclaim too, even with ample byte capacity.
        reclaim_cache_limits(&root,u64::MAX,0,6).unwrap();
        assert!(!recent.exists(),"metadata limit bypassed inactive-copy reclamation");
        assert!(open.exists(),"metadata reclamation evicted the open copy");
        discard_working_copy(&open);
    }
    #[test]
    fn c21_round3_open_copies_over_budget_refuse_clearly() {
        let f=Fixture::new();let root=f.0.join("in-use");let open=allocate_cache(&root).unwrap();
        fs::write(open.join("payload"),vec![0;1024]).unwrap();
        let error=allocate_cache_with_budget(&root,1024,512).expect_err("admitted work beyond the in-use budget");
        assert_eq!(error.to_string(),crate::i18n::t("main.error.sourceCacheFull"));
        assert!(open.exists());discard_working_copy(&open);
    }
    #[test]
    fn c21_rereview_portable_new_folder_candidates() {
        for title in ["aux.mp3".to_owned(), "CON.wav".into(), "Song.".into(), "界".repeat(100), "a".repeat(241), "Good".into()] {
            for suffix in [1, 2, 99999] {
                let name=folder_name(&title,suffix);
                validate_component(std::ffi::OsStr::new(&name)).unwrap_or_else(|error| panic!("invalid candidate {name:?}: {error}"));
                if suffix > 1 { assert!(name.ends_with(&format!(" ({suffix})"))); }
            }
        }
        assert_eq!(folder_name("CON.wav",1),"CON_");
    }
    #[test]
    fn c21_rereview_deferred_open_keeps_fresh_output() {
        let f=Fixture::new();let path=allocate_cache(&f.0.join("deferred")).unwrap();
        discard_failed_source_open(&path,OpenAttempt::Deferred,None,None);
        assert!(path.exists(),"deferred output was discarded before any backend open");
        discard_failed_source_open(&path,OpenAttempt::Failed,None,None);
        assert!(!path.exists(),"real rejected open retained unused output");
    }
    #[test]
    fn c21_rereview_active_writer_keeps_previous_copy() {
        let f=Fixture::new();let path=allocate_cache(&f.0.join("writer")).unwrap();
        discard_inactive_working_copy(&path,true);
        assert!(path.exists(),"active writer lost its source");
        assert!(cache_leases().lock().unwrap().iter().any(|(p,_)|p==&path));
        discard_inactive_working_copy(&path,false);
        assert!(!path.exists());
    }
    #[test]
    fn c21_rereview_adopted_edits_survive_navigation_quit_and_prune() {
        let f=Fixture::new();let root=f.0.join("retained");let path=allocate_cache(&root).unwrap();
        fs::write(path.join("lyrics.json"),b"edited lyrics").unwrap();
        adopt_working_copy(&path);
        discard_working_copy(&path);
        assert!(path.exists(),"accepted unsaved edits were deleted on release");
        assert!(!cache_leases().lock().unwrap().iter().any(|(p,_)|p==&path),"released copy retained its process lease");
        prune_cache_at(&root,std::time::SystemTime::now()+CACHE_MAX_AGE*365).unwrap();
        assert_eq!(fs::read(path.join("lyrics.json")).unwrap(),b"edited lyrics");
    }
    #[test]
    fn c21_review_pending_path_survives_status_replacement_without_losing_incoming_copy() {
        let f=Fixture::new(); let root=f.0.join("pending-owners");
        let old=allocate_cache(&root).unwrap();
        let incoming=allocate_cache(&root).unwrap();
        let current=allocate_cache(&root).unwrap();
        // The status can now point at incoming; cleanup must use the recorded old path.
        discard_pending_working_copy(&old,Some(&incoming),Some(&current));
        assert!(!old.exists(), "superseded pending path retained its lease and directory");
        discard_pending_working_copy(&incoming,Some(&incoming),Some(&current));
        discard_pending_working_copy(&current,Some(&incoming),Some(&current));
        assert!(incoming.exists(), "incoming working copy was deleted");
        assert!(current.exists(), "current project was deleted");
        discard_working_copy(&incoming); discard_working_copy(&current);
    }
    #[test]
    fn c21_review_failed_job_releases_marker_before_removal() {
        let f=Fixture::new();
        let path=allocate_cache(&f.0.join("pending-cache")).unwrap();
        drop(Pending(path.clone()));
        assert!(!cache_leases().lock().unwrap().iter().any(|(p,_)|p==&path), "failed job retained its marker lease");
        assert!(!path.exists());
    }
    #[test]
    fn c21_review_recent_abandoned_cache_has_age_grace() {
        let f=Fixture::new();
        let root=f.0.join("age-cache");fs::create_dir(&root).unwrap();
        let path=root.join("999999-2-3");fs::create_dir(&path).unwrap();
        fs::write(path.join(".source-work-active"),b"").unwrap();
        prune_cache(&root).unwrap();
        assert!(path.exists(), "recent abandoned copy lost its grace period");
    }
    #[cfg(unix)]
    #[test]
    fn c21_review_cache_symlink_error_is_not_capacity() {
        let f=Fixture::new();
        let root=f.0.join("linked-cache");std::os::unix::fs::symlink(&f.0,&root).unwrap();
        let error=allocate_cache(&root).unwrap_err().to_string();
        assert_ne!(error,crate::i18n::t("main.error.sourceCacheFull"));
    }
    #[test]
    fn c21_review_name_error_identifies_rejected_name() {
        assert!(checked_name("CON.txt").unwrap_err().to_string().contains("CON.txt"));
    }
    #[test]
    fn c21_review_ten_open_discard_cycles_release_leases() {
        let fixture = Fixture::new();
        let root = fixture.0.join("cycles");
        let input = fixture.0.join("raw/audio.wav");
        fs::create_dir(input.parent().unwrap()).unwrap();
        let frames=80u32; let rate=8000u32;
        let mut wav=Vec::new();
        wav.extend(b"RIFF"); wav.extend((36+frames*2).to_le_bytes());
        wav.extend(b"WAVEfmt "); wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes()); wav.extend(1u16.to_le_bytes());
        wav.extend(rate.to_le_bytes()); wav.extend((rate*2).to_le_bytes());
        wav.extend(2u16.to_le_bytes()); wav.extend(16u16.to_le_bytes());
        wav.extend(b"data"); wav.extend((frames*2).to_le_bytes());
        wav.resize(44+frames as usize*2,0); fs::write(&input,wav).unwrap();
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) {
            TEST_CACHE_ROOT.with(|root| *root.borrow_mut()=None);
            TEST_OPEN_RENDER.with(|fixture| fixture.set(false));
        } }
        TEST_CACHE_ROOT.with(|path| *path.borrow_mut()=Some(root.clone()));
        TEST_OPEN_RENDER.with(|fixture| fixture.set(true));
        let _reset=Reset;
        for _ in 0..10 {
            let output=execute(&Config::source(), Job::Open(input.clone()), &AtomicU64::new(1), 1, &mut false, |_,_|{}).unwrap();
            assert!(output.working);
            let path=output.path;
            assert_eq!(path.parent(),Some(root.as_path()));
            assert!(path.join("song.wav").is_file());
            discard_working_copy(&path);
            assert!(!path.exists(), "discarded working copy remains");
            assert!(!cache_leases().lock().unwrap().iter().any(|(p, _)| p == &path));
        }
        assert_eq!(fs::read_dir(root).unwrap().count(), 1); // cache lock only
    }
    #[cfg(unix)]
    #[test]
    fn c21_round3_twenty_plain_opens_and_discards_do_not_retain() {
        let fixture = Fixture::new();
        let root = fixture.0.join("cycles");
        let input = fixture.0.join("raw/audio.wav");
        fs::create_dir(input.parent().unwrap()).unwrap();
        let frames=80u32; let rate=8000u32;
        let mut wav=Vec::new();
        wav.extend(b"RIFF"); wav.extend((36+frames*2).to_le_bytes());
        wav.extend(b"WAVEfmt "); wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes()); wav.extend(1u16.to_le_bytes());
        wav.extend(rate.to_le_bytes()); wav.extend((rate*2).to_le_bytes());
        wav.extend(2u16.to_le_bytes()); wav.extend(16u16.to_le_bytes());
        wav.extend(b"data"); wav.extend((frames*2).to_le_bytes());
        wav.resize(44+frames as usize*2,0); fs::write(&input,wav).unwrap();
        struct Reset;
        impl Drop for Reset { fn drop(&mut self) {
            TEST_CACHE_ROOT.with(|root| *root.borrow_mut()=None);
            TEST_OPEN_RENDER.with(|fixture| fixture.set(false));
        } }
        TEST_CACHE_ROOT.with(|path| *path.borrow_mut()=Some(root.clone()));
        TEST_OPEN_RENDER.with(|fixture| fixture.set(true));
        let _reset=Reset;
        for _ in 0..20 {
            let output=execute(&Config::source(), Job::Open(input.clone()), &AtomicU64::new(1), 1, &mut false, |_,_|{}).unwrap();
            assert!(output.working);
            let path=output.path;
            assert_eq!(path.parent(),Some(root.as_path()));
            assert!(path.join("song.wav").is_file());
            adopt_working_copy_with_value(&path,false);
            discard_working_copy(&path);
            assert!(!path.exists(), "discarded working copy remains");
            assert!(!cache_leases().lock().unwrap().iter().any(|(p, _)| p == &path));
        }
        assert_eq!(fs::read_dir(root).unwrap().count(), 1); // cache lock only
    }
    #[cfg(unix)]
    #[test]
    fn c21_review_legacy_titles_and_members_save_and_clone() {
        for title in ["AUX", "Stay."] {
            let source = Fixture::new();
            let target = Fixture::new();
            let mut raw = crate::project_store::read(&source.0, "project.json").unwrap().0;
            raw["name"] = json!(title);
            fs::write(source.0.join("notes."), b"notes").unwrap();
            fs::write(source.0.join("AUX.txt"), b"aux").unwrap();
            let clone = source.0.join("clone");
            // Clone into a sibling to avoid traversing the destination itself.
            let clone = target.0.join(clone.file_name().unwrap());
            let cloned = clone_project(&source.0, &clone, &AtomicU64::new(1), 1);
            let output = execute(&Config::source(), Job::Save { dir: source.0.clone(), raw, custom: vec![], target: Some(target.target()) }, &AtomicU64::new(1), 1, &mut false, |_, _| {});
            assert!(cloned.is_ok() && output.is_ok(), "legacy clone: {cloned:?}; legacy Save: {output:?}");
            assert_eq!(fs::read(clone.join("notes.")).unwrap(), b"notes");
            assert_eq!(fs::read(clone.join("AUX.txt")).unwrap(), b"aux");
            assert_eq!(crate::project_store::read(&target.0, "project.json").unwrap().0["name"], title);
        }
    }
    #[test]
    fn save_marks_survive_sync_captured_during_long_publication() {
        let fixture = Fixture::new();
        let store = crate::sync_dirty::Store::new(fixture.0.join("private-prefs"));
        let old = fixture.0.join("old-library-song");
        store.mark_project(&old, "older edit").unwrap();
        let saving = SaveSync::new(store.clone(), None);
        let captured = store.snapshot().unwrap().seq;
        let destination = fixture.0.join("Published");
        fs::create_dir(&destination).unwrap();
        fs::write(destination.join("project.json"), b"{}").unwrap();
        saving.finished(Some(&destination));
        assert!(store.snapshot().unwrap().dirs.contains_key(old.to_str().unwrap()));
        let remaining = store.clear(captured).unwrap();
        assert!(remaining.all_seq > captured);
        assert!(remaining.dirs.contains_key(destination.to_str().unwrap()));
        let target = SaveSync::new(store.clone(), Some(destination.clone()));
        let captured = store.snapshot().unwrap().seq;
        target.finished(None); // Failed/cancelled attempt still gets finally mark.
        assert!(store.clear(captured).unwrap().dirs.contains_key(destination.to_str().unwrap()));
    }

    #[test]
    fn queued_cancel_retires_without_first_snapshot_and_next_job_still_runs() {
        let (release, blocked) = mpsc::channel();
        let service = Service::new_with_start_hook(move || { blocked.recv().unwrap(); });
        // Hold startup discovery and queue a split behind it. No Run snapshot
        // has ever existed when the UI requests cancellation.
        service.check().unwrap();
        let id = service.start(Job::Split { dir: PathBuf::from("missing-queued-source"),
            raw: json!({}), custom: vec![], mode: Mode::Stems, require_vocals: false, target: None }).unwrap();
        service.cancel();
        let ready = Snapshot { ready: true, engine_revision: 7, ..Default::default() };
        *service.view.lock().unwrap() = Arc::new(ready);
        assert!(!service.retired(id));
        release.send(()).unwrap();
        let deadline = Instant::now() + Duration::from_secs(2);
        while !service.retired(id) {
            assert!(Instant::now() < deadline, "Queued cancellation never retired");
            thread::sleep(Duration::from_millis(2));
        }
        let observed = service.snapshot();
        assert_eq!(observed.generation, 0);
        assert!(observed.ready);
        assert_eq!(observed.engine_revision, 7);
        // A stale retirement receipt must not clear the next owned request.
        let next = service.start(Job::Open(PathBuf::from("missing-next-source.wav"))).unwrap();
        assert!(next > id);
        assert!(!service.retired(next));
        while !service.retired(next) {
            assert!(Instant::now() < deadline, "Next source request did not run");
            thread::sleep(Duration::from_millis(2));
        }
        let observed = service.snapshot();
        assert_eq!(observed.generation, next);
        assert!(!observed.busy && observed.error.is_some());
    }
    #[test]
    fn discovery_is_visible_while_inference_is_still_busy() {
        let serial = AtomicU64::new(9);
        let mut state = Snapshot { generation: 9, busy: true, label: "Preparing audio…".into(), percent: 0., ..Default::default() };
        let view = Mutex::new(Arc::new(state.clone()));
        let status = crate::engine_status::EngineStatus { ok: true, ..Default::default() };
        let started = Instant::now();
        assert!(publish_discovery(&mut state, &view, &serial, 9, &status, 4, Some(started)));
        let observed = view.lock().unwrap().clone();
        assert!(observed.busy && observed.ready && observed.result.is_none());
        assert_eq!(observed.engine_revision, 4);
        assert_eq!(observed.engine_probe_started, Some(started));
        // Later progress must not restore the old "not ready" snapshot.
        state.label = "Splitting stems".into(); state.percent = 33.;
        publish(&mut state, &view);
        assert!(view.lock().unwrap().ready);
    }
    #[test]
    fn stale_discovery_cannot_overwrite_a_newer_request_or_cancel() {
        for (generation, serial) in [(8, 9), (9, 10)] {
            let mut state = Snapshot { generation, busy: true, ..Default::default() };
            let view = Mutex::new(Arc::new(state.clone()));
            assert!(!publish_discovery(&mut state, &view, &AtomicU64::new(serial), 9,
                &crate::engine_status::EngineStatus { ok: true, ..Default::default() }, 1, Some(Instant::now())));
            assert_eq!(state.revision, 0);
            assert!(!view.lock().unwrap().ready);
        }
    }
    #[test]
    fn loading_reserves_the_source_final_percent_in_each_stage() {
        assert_eq!(loading_stage(Mode::Stems, false), ("Loading stems…", 99.));
        assert_eq!(loading_stage(Mode::Vocals, true), ("Loading vocals…", 99.));
        assert_eq!(loading_stage(Mode::Combined, false), ("1/2 · Loading stems…", 49.5));
        assert_eq!(loading_stage(Mode::Combined, true), ("2/2 · Loading vocals…", 99.5));
        assert!(!SplitProgress::running("Loading stems…", 99., true).cancellable);
        assert_eq!(SplitProgress::stage("Splitting stems", 98., Mode::Stems, true, false).percent, 49.);
        assert_eq!(SplitProgress::stage("Separating vocals", 98., Mode::Vocals, true, false).percent, 99.);
    }
    #[test]
    fn handoff_cancel_is_epoch_owned_and_retains_captured_rollback() {
        let original = ("original-project", "accepted-mix-and-dirty-state");
        let mut handoff = SplitHandoff::new(40, 7, Mode::Stems, true, original);
        assert!(handoff.progress(39).is_none());
        assert!(handoff.cancel(39).is_none());
        assert!(handoff.continue_after_acceptance(40));
        assert_eq!(handoff.cancel(40), Some(original));
        assert!(handoff.cancel(40).is_none());
        assert!(!handoff.progress(40).unwrap().cancellable);
        assert!(!handoff.continue_after_acceptance(40));
        handoff.epoch = 41; // Native rollback supersedes the rejected candidate.
        assert!(handoff.progress(40).is_none());
        assert_eq!(handoff.rollback, original);
        assert!(handoff.progress(41).is_some());
    }
    #[test]
    fn combined_continuation_requires_accepted_current_stems() {
        let stems = SplitHandoff::new(10, 4, Mode::Stems, true, "original");
        assert!(!stems.continue_after_acceptance(11));
        assert!(stems.continue_after_acceptance(10));
        // Stage two captures the accepted six-lane project, never the original.
        let mut vocals = SplitHandoff::new(11, 5, Mode::Vocals, true, "accepted-six-lanes");
        assert!(!vocals.continue_after_acceptance(11));
        assert_eq!(vocals.cancel(11), Some("accepted-six-lanes"));
        assert!(!SplitHandoff::new(10, 4, Mode::Stems, false, "original").continue_after_acceptance(10));
    }

    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let dir = std::env::temp_dir().join(format!("singz-source-lyrics-{}", token()));
            fs::create_dir(&dir).unwrap();
            fs::create_dir(dir.join("stems")).unwrap();
            fs::write(
                dir.join("project.json"),
                b"{\"version\":2,\"name\":\"Song\",\"settings\":{}}",
            )
            .unwrap();
            Self(dir.canonicalize().unwrap())
        }
        fn target(&self) -> Target {
            Target {
                dir: self.0.clone(),
                fingerprint: crate::project_store::read(&self.0, "project.json")
                    .unwrap()
                    .1,
                lyrics_fingerprint: crate::lyrics_store::identity(&self.0).unwrap(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn targeted_working_copy_save_carries_edited_lyrics_and_preserves_other_files() {
        for existing in [false, true] {
            let target = Fixture::new();
            let source = Fixture::new();
            if existing {
                fs::write(target.0.join("lyrics.json"), b"old saved words").unwrap();
            }
            let captured = target.target();
            let edited=b"{\"source\":\"edited\",\"credit\":\"Singer\",\"lines\":[{\"start\":0,\"end\":1,\"text\":\"New words\"}]}";
            fs::write(source.0.join("lyrics.json"), edited).unwrap();
            fs::write(target.0.join("notes.txt"), b"private notes").unwrap();
            let mut raw = crate::project_store::read(&source.0, "project.json")
                .unwrap()
                .0;
            let serial = AtomicU64::new(1);
            let output = publish_target(&source.0, &mut raw, captured, &[], &serial, 1).unwrap();
            assert_eq!(output.path, target.0);
            assert!(!output.working);
            assert_eq!(output.publication_hash, Some(crate::project_store::read(&target.0,"project.json").unwrap().1));
            assert_eq!(fs::read(target.0.join("lyrics.json")).unwrap(), edited);
            assert_eq!(
                fs::read(target.0.join("notes.txt")).unwrap(),
                b"private notes"
            );
            assert_eq!(
                crate::lyrics_store::read(&target.0)
                    .unwrap()
                    .document
                    .unwrap()
                    .source,
                "edited"
            );
            assert!(!target.0.join(".singz-native-split.json").exists());
        }
    }
    #[test]
    fn independent_saved_lyrics_conflict_or_cancellation_cannot_publish_working_changes() {
        let target = Fixture::new();
        let source = Fixture::new();
        fs::write(target.0.join("lyrics.json"), b"original words").unwrap();
        fs::write(source.0.join("lyrics.json"), b"working words").unwrap();
        let captured = target.target();
        let metadata = fs::read(target.0.join("project.json")).unwrap();
        fs::write(target.0.join("lyrics.json"), b"external words").unwrap();
        let mut raw = crate::project_store::read(&source.0, "project.json")
            .unwrap()
            .0;
        assert!(publish_target(&source.0, &mut raw, captured, &[], &AtomicU64::new(1), 1).is_err());
        assert_eq!(fs::read(target.0.join("project.json")).unwrap(), metadata);
        assert_eq!(
            fs::read(target.0.join("lyrics.json")).unwrap(),
            b"external words"
        );
        let captured = target.target();
        assert!(publish_target(&source.0, &mut raw, captured, &[], &AtomicU64::new(2), 1).is_err());
        assert_eq!(
            fs::read(target.0.join("lyrics.json")).unwrap(),
            b"external words"
        );
        assert!(!target.0.join(".singz-native-split.json").exists());
        assert!(fs::read_dir(&target.0).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".native-split-")
        }));
    }
    #[test]
    fn disappearing_working_lyrics_never_deletes_the_saved_singers_words() {
        let target = Fixture::new();
        let source = Fixture::new();
        fs::write(target.0.join("lyrics.json"), b"saved words").unwrap();
        let captured = target.target();
        let metadata = fs::read(target.0.join("project.json")).unwrap();
        let mut raw = crate::project_store::read(&source.0, "project.json")
            .unwrap()
            .0;
        assert!(publish_target(&source.0, &mut raw, captured, &[], &AtomicU64::new(1), 1).is_err());
        assert_eq!(
            fs::read(target.0.join("lyrics.json")).unwrap(),
            b"saved words"
        );
        assert_eq!(fs::read(target.0.join("project.json")).unwrap(), metadata);
    }
    fn edited_words(text: &str) -> Value {
        json!([{"start":0.,"end":2.,"text":text,"words":[{"w":text,"s":0.,"e":2.}]}])
    }
    #[test]
    fn split_completion_and_late_refresh_keep_independent_editor_saves_without_recomputing_stems() {
        let source = Fixture::new();
        let output = Fixture::new();
        let first = crate::lyrics_store::save(
            &source.0,
            None,
            &edited_words("Initial words"),
            Some("Singer"),
        )
        .unwrap();
        fs::copy(source.0.join("lyrics.json"), output.0.join("lyrics.json")).unwrap();
        fs::write(output.0.join("stems/keep.bin"), b"computed inference").unwrap();
        let output_metadata = fs::read(output.0.join("project.json")).unwrap();
        let mut target = Some(source.target());
        let second = crate::lyrics_store::save(
            &source.0,
            first.fingerprint.as_deref(),
            &edited_words("Saved during inference"),
            None,
        )
        .unwrap();
        let serial = AtomicU64::new(7);
        refresh_split_lyrics(&source.0, &output.0, None, &mut target, &serial, 7).unwrap();
        assert_eq!(
            crate::lyrics_store::identity(&output.0).unwrap(),
            second.fingerprint
        );
        assert_eq!(
            target.as_ref().unwrap().lyrics_fingerprint,
            second.fingerprint
        );
        let third = crate::lyrics_store::save(
            &source.0,
            second.fingerprint.as_deref(),
            &edited_words("Saved before handoff"),
            None,
        )
        .unwrap();
        let config = Config::source();
        let mut ready = false;
        let mut labels = vec![];
        let refreshed = execute(
            &config,
            Job::RefreshLyrics {
                source_dir: source.0.clone(),
                expected: third.fingerprint.clone(),
                output: Output {
        publication_hash: None,
                    path: output.0.clone(),
                    working: true,
                    target,
                },
            },
            &serial,
            7,
            &mut ready,
            |label, _| labels.push(label.to_owned()),
        )
        .unwrap();
        assert_eq!(refreshed.path, output.0);
        assert_eq!(
            refreshed.target.as_ref().unwrap().lyrics_fingerprint,
            third.fingerprint
        );
        assert_eq!(
            crate::lyrics_store::identity(&output.0).unwrap(),
            third.fingerprint
        );
        assert_eq!(
            crate::lyrics_store::read(&output.0)
                .unwrap()
                .document
                .unwrap()
                .lines[0]
                .text,
            "Saved before handoff"
        );
        assert_eq!(
            fs::read(output.0.join("project.json")).unwrap(),
            output_metadata
        );
        assert_eq!(
            fs::read(output.0.join("stems/keep.bin")).unwrap(),
            b"computed inference"
        );
        assert_eq!(labels, vec!["Updating lyrics…"]);
    }
    #[test]
    fn refresh_uses_accepted_source_identity_and_preserves_computed_output_on_conflict_or_cancel() {
        let source = Fixture::new();
        let output = Fixture::new();
        let original =
            crate::lyrics_store::save(&source.0, None, &edited_words("Original words"), None)
                .unwrap();
        fs::write(output.0.join("lyrics.json"), b"private computed copy").unwrap();
        fs::write(output.0.join("stems/keep.bin"), b"computed inference").unwrap();
        let target = Some(source.target());
        let expected = original.fingerprint.clone();
        let latest = crate::lyrics_store::save(
            &source.0,
            expected.as_deref(),
            &edited_words("Unacknowledged external words"),
            None,
        )
        .unwrap();
        let job = || Job::RefreshLyrics {
            source_dir: source.0.clone(),
            expected: expected.clone(),
            output: Output {
        publication_hash: None,
                path: output.0.clone(),
                working: true,
                target: target.clone(),
            },
        };
        let config = Config::source();
        let mut ready = false;
        assert!(execute(&config, job(), &AtomicU64::new(1), 1, &mut ready, |_, _| {}).is_err());
        assert!(execute(&config, job(), &AtomicU64::new(2), 1, &mut ready, |_, _| {}).is_err());
        assert_eq!(
            crate::lyrics_store::identity(&source.0).unwrap(),
            latest.fingerprint
        );
        assert_eq!(
            fs::read(output.0.join("lyrics.json")).unwrap(),
            b"private computed copy"
        );
        assert_eq!(
            fs::read(output.0.join("stems/keep.bin")).unwrap(),
            b"computed inference"
        );
        assert!(output.0.is_dir());
        assert!(fs::read_dir(&output.0).unwrap().all(|e| {
            !e.unwrap()
                .file_name()
                .to_string_lossy()
                .starts_with(".lyrics-refresh-")
        }));
    }
    #[test]
    fn refreshing_a_working_source_keeps_the_original_target_conflict_identity() {
        let saved = Fixture::new();
        let source = Fixture::new();
        let output = Fixture::new();
        let baseline =
            crate::lyrics_store::save(&saved.0, None, &edited_words("Saved words"), None).unwrap();
        let edited =
            crate::lyrics_store::save(&source.0, None, &edited_words("Working editor words"), None)
                .unwrap();
        let mut target = Some(saved.target());
        refresh_split_lyrics(
            &source.0,
            &output.0,
            Some(&edited.fingerprint),
            &mut target,
            &AtomicU64::new(1),
            1,
        )
        .unwrap();
        assert_eq!(
            target.as_ref().unwrap().lyrics_fingerprint,
            baseline.fingerprint
        );
        assert_eq!(
            crate::lyrics_store::identity(&output.0).unwrap(),
            edited.fingerprint
        );
        let mut raw = crate::project_store::read(&output.0, "project.json")
            .unwrap()
            .0;
        publish_target(
            &output.0,
            &mut raw,
            target.unwrap(),
            &[],
            &AtomicU64::new(1),
            1,
        )
        .unwrap();
        assert_eq!(
            crate::lyrics_store::identity(&saved.0).unwrap(),
            edited.fingerprint
        );
        assert_eq!(
            crate::lyrics_store::read(&saved.0)
                .unwrap()
                .document
                .unwrap()
                .lines[0]
                .text,
            "Working editor words"
        );
    }
    #[test]
    fn source_song_names_keep_real_dots_and_refuse_hidden_parent_names() {
        assert_eq!(safe_name("Mr. Crowley"), "Mr. Crowley");
        assert_eq!(safe_name(" . . AC:DC.MP3 ".trim()), "AC DC");
        assert_eq!(safe_name("...mp3"), "Untitled song");
        assert_eq!(safe_name("a   b?c.wav"), "a b c");
    }
    #[test]
    fn gpu_deadlines_keep_the_source_first_chunk_and_cpu_fallback_rules() {
        let d = Duration::from_secs;
        assert!(gpu_expired(false, false, d(240), d(240), d(240)));
        assert!(!gpu_expired(true, false, d(500), d(599), d(599)));
        assert!(gpu_expired(true, false, d(5), d(600), d(600)));
        assert!(!gpu_expired(true, true, d(200), d(1800), d(299)));
        assert!(gpu_expired(true, true, d(1), d(1800), d(300)));
    }
    #[test]
    fn progress_parses_fragment_tails_and_native_json() {
        assert_eq!(last_progress(b"noise\r 12.5%|stuff"), Some(12.5));
        assert_eq!(last_progress(b"chunk 3/12: 4.1s elapsed"), Some(25.));
        assert_eq!(last_progress(b"{\"percent\":64}\n"), Some(64.));
        assert_eq!(last_progress(b"{\"percent\":100}\n"), Some(99.));
        assert_eq!(safe_name("../a:b"), "a b");
    }
    #[cfg(unix)]
    #[test]
    fn resolved_system_splitter_executes_original_input_without_pack_python_or_pcm_rewrite() {
        use std::os::unix::fs::PermissionsExt;
        let fixture = Fixture::new();
        let input = fixture.0.join("source recording.mp3");
        let mut wav = vec![];
        let frames = 20u32;
        let rate = 8000u32;
        wav.extend(b"RIFF");
        wav.extend((36 + frames * 2).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(rate.to_le_bytes());
        wav.extend((rate * 2).to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend((frames * 2).to_le_bytes());
        wav.resize(44 + frames as usize * 2, 0);
        fs::write(&input, &wav).unwrap();
        let script = fixture.0.join("system-demucs");
        let log = fixture.0.join("system-argv");
        let body = format!(
            "#!/bin/sh\nprintf '%s\\n' \"$@\" > '{}'\n[ \"$1\" = --fixture-system ] || exit 9\nshift\n[ \"$1\" = --help ] && exit 0\nout=\ninput=\nwhile [ \"$#\" -gt 0 ]; do\n case \"$1\" in -o) shift; out=$1;; *) input=$1;; esac\n shift\ndone\n/bin/mkdir -p \"$out/htdemucs_6s\" || exit 10\nfor stem in vocals drums bass other guitar piano; do /bin/cp \"$input\" \"$out/htdemucs_6s/$stem.wav\" || exit 11; done\nprintf '100%%| complete\\n'\n",
            log.display()
        );
        fs::write(&script, body).unwrap();
        fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
        let engine = crate::engine_status::ResolvedEngine::System {
            argv: vec![script.into_os_string(), "--fixture-system".into()],
            path: std::env::var_os("PATH").unwrap_or_default(),
        };
        let mut probe = engine.system_command().unwrap();
        probe.arg("--help");
        command_observe(
            probe,
            &AtomicU64::new(1),
            1,
            Duration::from_secs(2),
            || Ok(()),
            |_, _| Ok(()),
        )
        .unwrap();
        let mut config = Config::source();
        config.pack = fixture.0.join("missing-pack");
        let mut progress = vec![];
        stems(
            &config,
            &engine,
            &fixture.0,
            &input,
            &AtomicU64::new(1),
            1,
            &mut |label, p| progress.push((label.to_owned(), p)),
            false,
        )
        .unwrap();
        let args = fs::read_to_string(log).unwrap();
        assert!(
            args.starts_with("--fixture-system\n-n\nhtdemucs_6s\n--filename\n{stem}.{ext}\n-o\n")
        );
        assert!(args.ends_with(&format!("{}\n", input.display())));
        assert!(!args.contains("-m\ndemucs"));
        for stem in &STEMS[..6] {
            assert_eq!(
                fs::read(fixture.0.join("stems").join(format!("{stem}.wav"))).unwrap(),
                wav
            );
        }
        assert_eq!(fs::read(input).unwrap(), wav);
        assert!(!fixture.0.join("onnx-runner.py").exists());
        assert!(!fixture.0.join("input44k.wav").exists());
        assert!(!progress.is_empty());
    }
    #[test]
    fn working_save_preserves_custom_encoded_audio_and_prunes_only_its_removed_copy() {
        let target = Fixture::new();
        let source = Fixture::new();
        let picked = source.0.join("harmony.MP3");
        fs::write(&picked, b"ID3encoded original bytes").unwrap();
        fs::write(
            target.0.join("stems/custom-removed.ogg"),
            b"old owned track",
        )
        .unwrap();
        fs::write(target.0.join("stems/foreign-notes.txt"), b"leave it").unwrap();
        let captured = target.target();
        let mut raw = crate::project_store::read(&source.0, "project.json")
            .unwrap()
            .0;
        let custom = crate::tracks::Lane {
            slot: 7,
            id: "custom-harmony".into(),
            label: "My harmony".into(),
            color: "#8fd3ff".into(),
            file: picked.clone(),
            custom: true,
        };
        publish_target(
            &source.0,
            &mut raw,
            captured,
            &[custom],
            &AtomicU64::new(1),
            1,
        )
        .unwrap();
        assert_eq!(
            fs::read(target.0.join("stems/custom-harmony.mp3")).unwrap(),
            b"ID3encoded original bytes"
        );
        assert_eq!(fs::read(picked).unwrap(), b"ID3encoded original bytes");
        assert!(!target.0.join("stems/custom-removed.ogg").exists());
        assert_eq!(
            fs::read(target.0.join("stems/foreign-notes.txt")).unwrap(),
            b"leave it"
        );
        assert_eq!(raw["settings"]["custom"][0]["id"], "custom-harmony");
        assert_eq!(
            raw["settings"]["custom"][0]["file"],
            "stems/custom-harmony.mp3"
        );
    }
    #[test]
    fn generated_backing_identity_never_overwrites_a_singers_existing_custom_lane() {
        let lane = crate::tracks::Lane {
            slot: 6,
            id: "custom-backing-vocals".into(),
            label: "My own take".into(),
            color: "#abcdef".into(),
            file: PathBuf::from("/already/picked.wav"),
            custom: true,
        };
        assert_eq!(fresh_backing_id(&[]), "custom-backing-vocals");
        assert_eq!(fresh_backing_id(&[lane.clone()]), "custom-backing-vocals-2");
        let mut second = lane.clone();
        second.id = "custom-backing-vocals-2".into();
        assert_eq!(fresh_backing_id(&[lane, second]), "custom-backing-vocals-3");
    }
    #[test]
    fn empty_working_document_saves_marker_and_lyrics_without_any_audio_source() {
        let target = Fixture::new();
        let source = Fixture::new();
        fs::write(
            target.0.join("stems/custom-removed.mp3"),
            b"previous encoded member",
        )
        .unwrap();
        let lyrics = b"{\"source\":\"edited\",\"lines\":[]}";
        fs::write(source.0.join("lyrics.json"), lyrics).unwrap();
        let captured = target.target();
        let mix = crate::project_store::Mix {
            carry: Default::default(),
            metronome: Default::default(),
            beat: None,
            original: false,
            lanes: vec![],
            custom: vec![],
            gain: [1.; crate::tracks::LANE_SLOTS],
            muted: [false; crate::tracks::LANE_SLOTS],
            solo: [false; crate::tracks::LANE_SLOTS],
            master: 1.,
            transpose: 0,
            tempo: 1.,
            looping: false,
            selection: Some((0., 0.)),
            view: (0., 0.),
        };
        let mut raw = crate::project_store::update_mix(
            crate::project_store::read(&source.0, "project.json")
                .unwrap()
                .0,
            &mix,
        )
        .unwrap();
        let result =
            publish_target(&source.0, &mut raw, captured, &[], &AtomicU64::new(1), 1).unwrap();
        assert_eq!(result.path, target.0);
        let saved = crate::project_store::read(&target.0, "project.json")
            .unwrap()
            .0;
        assert_eq!(saved["settings"]["nativeEmptyTracks"], true);
        assert_eq!(saved["settings"]["nativeOriginalDisabled"], true);
        assert_eq!(saved["settings"]["custom"], json!([]));
        assert!(saved["settings"].get("selection").is_none());
        assert!(!target.0.join("stems/custom-removed.mp3").exists());
        assert_eq!(fs::read(target.0.join("lyrics.json")).unwrap(), lyrics);
    }
}

//! Independent OAuth/sync worker; the GPUI thread only sends intent and reads state.
use crate::{
    drive_auth::{AuthClient, Config, OAuthSession, TokenStore},
    drive_state::{Action, ProgressKind, ProjectState, Snapshot},
    sync_scheduler::{Outcome, Phase, Run, Scheduler},
};
use anyhow::{ensure, Context, Result};
use serde::{Deserialize, Serialize};
use std::{
    collections::BTreeMap,
    fs,
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, SystemTime, UNIX_EPOCH},
};

pub enum Event {
    OpenUrl(u64, String),
    LibraryChanged(u64),
}
enum Command {
    Action(u64, Action),
    Root(u64, PathBuf),
    Suspend(u64),
    Wake(u64),
}
/// Worker turn length while nothing is running or pending.
const IDLE_TURN: Duration = Duration::from_millis(1000);
pub struct Service {
    commands: SyncSender<Command>,
    events: Receiver<Event>,
    snapshot: Arc<Mutex<Snapshot>>,
    epoch: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    running: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn now() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn publish(shared: &Mutex<Snapshot>, change: impl FnOnce(&mut Snapshot)) {
    let mut state = shared.lock().unwrap_or_else(|e| e.into_inner());
    let before = state.clone();
    change(&mut state);
    if *state != before {
        state.revision = before.revision.saturating_add(1);
    }
}
impl Service {
    pub fn new(config_dir: PathBuf, root: PathBuf) -> Self {
        Self::with_config(
            config_dir,
            root,
            Config::from_env_or(include_str!(concat!(env!("OUT_DIR"), "/drive-config.json"))),
        )
    }
    fn with_config(config_dir: PathBuf, root: PathBuf, config: Result<Config>) -> Self {
        let (send, receive) = mpsc::sync_channel(32);
        let (events, out) = mpsc::channel();
        let shared = Arc::new(Mutex::new(Snapshot::default()));
        let alive = Arc::new(AtomicBool::new(true));
        let epoch = Arc::new(AtomicU64::new(1));
        let running = Arc::new(AtomicBool::new(false));
        let (state, live, sequence, busy) = (
            shared.clone(),
            alive.clone(),
            epoch.clone(),
            running.clone(),
        );
        let worker = thread::Builder::new()
            .name("singz-drive".into())
            .spawn(move || {
                if let Err(error) = worker(
                    config_dir, root, config, receive, events, &state, &live, &sequence, &busy,
                ) {
                    publish(&state, |s| {
                        busy.store(false, Ordering::Release);
                        s.scheduler.phase = Phase::Blocked;
                        s.busy = false;
                        s.signing_in = false;
                        s.capture_project = None;
                        s.error = Some(format!("Google Drive is unavailable: {error:#}"));
                    });
                }
            });
        let worker = match worker {
            Ok(worker) => Some(worker),
            Err(error) => {
                publish(&shared, |s| {
                    s.error = Some(format!("Google Drive worker could not start: {error}"))
                });
                None
            }
        };
        Self {
            commands: send,
            events: out,
            snapshot: shared,
            epoch,
            alive,
            running,
            worker,
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .clone()
    }
    pub fn snapshot_since(&self, revision: u64) -> Option<Snapshot> {
        let state = self.snapshot.lock().unwrap_or_else(|e| e.into_inner());
        (state.revision != revision).then(|| state.clone())
    }
    pub fn capture_project(&self) -> Option<PathBuf> {
        self.snapshot
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .capture_project
            .clone()
    }
    pub fn drain(&self) -> Vec<Event> {
        let current = self.epoch.load(Ordering::Acquire);
        self.events
            .try_iter()
            .filter(|event| match event {
                Event::OpenUrl(epoch, _) | Event::LibraryChanged(epoch) => *epoch == current,
            })
            .collect()
    }
    pub fn action(&self, action: Action) -> Result<()> {
        // Source coalesces manual requests into the active run.
        if action == Action::SyncNow && self.running.load(Ordering::Acquire) {
            return Ok(());
        }
        let invalidate = matches!(action, Action::SignIn | Action::SignOut | Action::Cancel);
        let epoch = if invalidate {
            let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
            crate::drive_http::wake_cancelled_requests();
            epoch
        } else {
            self.epoch.load(Ordering::Acquire)
        };
        self.commands
            .try_send(Command::Action(epoch, action))
            .context("Google Drive command queue is full")
    }
    /// Sleep/network recovery only shortens an existing retry/remote block.
    /// Wake never invalidates an account/storage epoch or cancels active IO.
    pub fn notify_wake(&self) -> Result<()> {
        // The source scheduler ignores wake while Syncing. This worker performs
        // IO synchronously, so do not replay that wake after the run finishes.
        if self.running.load(Ordering::Acquire) {
            return Ok(());
        }
        let epoch = self.epoch.load(Ordering::Acquire);
        self.commands
            .try_send(Command::Wake(epoch))
            .context("Google Drive command queue is full")
    }
    pub fn suspend(&self) -> Result<()> {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        crate::drive_http::wake_cancelled_requests();
        self.commands
            .try_send(Command::Suspend(epoch))
            .context("Google Drive command queue is full")
    }
    pub fn set_root(&self, root: PathBuf) -> Result<()> {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        crate::drive_http::wake_cancelled_requests();
        self.commands
            .try_send(Command::Root(epoch, root))
            .context("Google Drive command queue is full")
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.epoch.fetch_add(1, Ordering::AcqRel);
        let _ = self.commands.try_send(Command::Wake(self.epoch.load(Ordering::Acquire)));
        crate::drive_http::wake_cancelled_requests();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}

#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Receipt {
    version: u32,
    token_generation: u64,
    last_sync: Option<u64>,
    projects: BTreeMap<PathBuf, String>,
}
impl Default for Receipt {
    fn default() -> Self {
        Self {
            version: 1,
            token_generation: 0,
            last_sync: None,
            projects: BTreeMap::new(),
        }
    }
}
fn read_receipt(dir: &Path) -> Receipt {
    let path = dir.join("gdrive/sync-state.json");
    let read = (|| -> Result<Receipt> {
        let meta = fs::symlink_metadata(&path)?;
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 2 * 1024 * 1024,
            "Unsafe Drive receipt"
        );
        let mut bytes = Vec::new();
        fs::File::open(path)?
            .take(2 * 1024 * 1024 + 1)
            .read_to_end(&mut bytes)?;
        let receipt: Receipt = serde_json::from_slice(&bytes)?;
        ensure!(receipt.version == 1, "Unknown Drive receipt version");
        Ok(receipt)
    })();
    read.unwrap_or_default()
}
fn save_receipt(dir: &Path, receipt: &Receipt) -> Result<()> {
    let parent = dir.join("gdrive");
    let target = parent.join("sync-state.json");
    let tmp = parent.join(format!(".sync-state-{}", crate::drive_http::random_id()?));
    let result = (|| -> Result<()> {
        let mut file = crate::drive_http::private_file(&tmp)?;
        file.write_all(&serde_json::to_vec(receipt)?)?;
        file.sync_all()?;
        drop(file);
        #[cfg(windows)]
        if target.exists() {
            fs::remove_file(&target)?;
        }
        fs::rename(&tmp, &target)?;
        #[cfg(unix)]
        fs::File::open(&parent)?.sync_all()?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(tmp);
    }
    result
}
fn verify_receipt(
    receipt: &mut Receipt,
    root: &Path,
    ledger: &crate::sync_dirty::Store,
) -> Result<()> {
    let changed = receipt
        .projects
        .iter()
        .filter(|(path, _)| path.starts_with(root))
        .filter_map(|(path, expected)| {
            let actual = (|| -> Result<String> {
                let member = path.join("project.json");
                let meta = fs::symlink_metadata(&member)?;
                ensure!(
                    meta.is_file()
                        && !meta.file_type().is_symlink()
                        && meta.len() <= 16 * 1024 * 1024,
                    "Unavailable saved project"
                );
                let mut bytes = Vec::new();
                fs::File::open(member)?
                    .take(16 * 1024 * 1024 + 1)
                    .read_to_end(&mut bytes)?;
                ensure!(bytes.len() <= 16 * 1024 * 1024, "Oversized saved project");
                Ok(crate::project_store::fingerprint(&bytes))
            })();
            (actual.as_deref().ok() != Some(expected.as_str())).then(|| path.clone())
        })
        .collect::<Vec<_>>();
    for path in changed {
        ledger.mark_project(&path, "changed since last verified Drive sync")?;
        receipt.projects.remove(&path);
    }
    Ok(())
}
fn count(dirty: &crate::sync_dirty::Snapshot) -> i32 {
    if dirty.all_seq > 0 || !dirty.retire_ops.is_empty() {
        // Operation receipts can remain after their directory dirty marks are
        // cleared. They still represent pending library reconciliation.
        -1
    } else {
        dirty.dirs.len().min(i32::MAX as usize) as i32
    }
}
fn enabled(store: &TokenStore, suspended: bool) -> bool {
    !suspended && store.signed_in() && std::env::var("SINGZ_NO_SYNC").as_deref() != Ok("1")
}
fn refresh_state(
    shared: &Mutex<Snapshot>,
    scheduler: &Scheduler,
    store: &TokenStore,
    root: &Path,
    dirty: &crate::sync_dirty::Snapshot,
    receipt: &Receipt,
    running: &AtomicBool,
) {
    // Session locking and disk reads stay outside the UI snapshot mutex.
    let signed_in = store.signed_in_checked();
    publish(shared, |s| {
        s.scheduler = scheduler.status();
        s.busy = s.scheduler.phase == Phase::Syncing;
        running.store(s.busy, Ordering::Release);
        if !s.busy {
            s.capture_project = None;
        }
        match signed_in {
            Ok(value) => s.signed_in = value,
            Err(error) => {
                s.error = Some(error.to_string());
                return;
            }
        }
        if !s.signed_in {
            s.projects.clear();
            return;
        }
        s.projects.retain(|path, _| path.starts_with(root));
        for path in receipt
            .projects
            .keys()
            .filter(|path| path.starts_with(root))
        {
            s.projects
                .entry(path.clone())
                .or_insert(ProjectState::Synced);
        }
        for path in dirty
            .dirs
            .keys()
            .map(PathBuf::from)
            .filter(|path| path.starts_with(root))
        {
            if s.projects.get(&path) != Some(&ProjectState::Blocked) {
                s.projects.insert(path, ProjectState::Pending);
            }
        }
        if dirty.all_seq > 0 {
            for state in s.projects.values_mut() {
                if *state != ProjectState::Blocked {
                    *state = ProjectState::Pending;
                }
            }
        }
    });
}
fn read_dirty(
    ledger: &crate::sync_dirty::Store,
    config_dir: &Path,
) -> Result<crate::sync_dirty::Snapshot> {
    #[cfg(test)]
    {
        let mut conflicts = snapshot_conflicts().lock().unwrap();
        if let Some(remaining) = conflicts.get_mut(config_dir) {
            if *remaining > 0 {
                *remaining -= 1;
                return Err(crate::sync_dirty::SnapshotChanged.into());
            }
        }
    }
    #[cfg(not(test))]
    let _ = config_dir;
    ledger.snapshot()
}
#[cfg(test)]
fn snapshot_conflicts() -> &'static Mutex<BTreeMap<PathBuf, usize>> {
    static CONFLICTS: std::sync::OnceLock<Mutex<BTreeMap<PathBuf, usize>>> =
        std::sync::OnceLock::new();
    CONFLICTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}

#[derive(Clone, Copy, PartialEq, Eq)]
enum ReceiptRead {
    Startup,
    RunStart,
    RunFinish,
}
#[cfg(test)]
struct ReceiptReadFault {
    point: ReceiptRead,
    started: Arc<AtomicBool>,
    finished: Arc<AtomicBool>,
}
#[cfg(test)]
fn receipt_read_faults() -> &'static Mutex<BTreeMap<PathBuf, ReceiptReadFault>> {
    static FAULTS: std::sync::OnceLock<Mutex<BTreeMap<PathBuf, ReceiptReadFault>>> =
        std::sync::OnceLock::new();
    FAULTS.get_or_init(|| Mutex::new(BTreeMap::new()))
}
fn receipt_generation(store: &TokenStore, _config_dir: &Path, _point: ReceiptRead) -> Result<u64> {
    #[cfg(test)]
    let fault = {
        let mut faults = receipt_read_faults().lock().unwrap();
        if faults
            .get(_config_dir)
            .is_some_and(|fault| fault.point == _point)
        {
            faults.remove(_config_dir)
        } else {
            None
        }
    };
    #[cfg(test)]
    let held = fault.as_ref().map(|_| {
        // Hold an independent, real lease across the production read. Each
        // path-scoped fault fires once; no callback replaces its result.
        crate::file_lease::Lease::acquire(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(_config_dir.join("gdrive/session.lock"))
                .unwrap(),
        )
        .unwrap()
    });
    #[cfg(test)]
    if let Some(fault) = &fault {
        fault.started.store(true, Ordering::Release);
    }
    let result = store.persisted_generation();
    #[cfg(test)]
    {
        drop(held);
        if let Some(fault) = fault {
            fault.finished.store(true, Ordering::Release);
        }
    }
    result
}

fn worker(
    config_dir: PathBuf,
    mut root: PathBuf,
    configuration: Result<Config>,
    commands: Receiver<Command>,
    events: mpsc::Sender<Event>,
    shared: &Mutex<Snapshot>,
    alive: &AtomicBool,
    epoch: &AtomicU64,
    running: &AtomicBool,
) -> Result<()> {
    let config = match configuration {
        Ok(config) => config,
        Err(error) => {
            publish(shared, |s| {
                s.configured = false;
                if !error.to_string().contains("not configured") {
                    s.error = Some(error.to_string());
                }
            });
            // Disabled Drive still acknowledges storage-worker fences.
            // It must not break the otherwise independent native picker.
            while alive.load(Ordering::Acquire) {
                // Nothing to schedule: sleep until a command (Drop sends a Wake).
                match commands.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected) {
                    Ok(Command::Suspend(e)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| s.suspended = true)
                    }
                    Ok(Command::Root(e, _)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| s.suspended = false)
                    }
                    Ok(Command::Action(e, _)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| {
                            s.error = Some(crate::i18n::t("library.drive.notConfigured"))
                        })
                    }
                    Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    _ => {}
                }
            }
            return Ok(());
        }
    };
    root = root.canonicalize().unwrap_or(root);
    let store = TokenStore::new(&config_dir)?;
    let ledger = crate::sync_dirty::Store::new(config_dir.clone());
    let mut receipt = read_receipt(&config_dir);
    if !receipt_generation(&store, &config_dir, ReceiptRead::Startup)
        .is_ok_and(|generation| receipt.token_generation == generation)
    {
        receipt = Receipt::default();
    }
    let mut verify_pending = true;
    let mut scheduler = Scheduler::new();
    let mut suspended = false;
    let mut session = store.generation();
    let mut applied_epoch = 1;
    scheduler.start(now(), enabled(&store, suspended), receipt.last_sync);
    publish(shared, |s| s.configured = true);
    let mut manual_requested = false;
    let mut active_run: Option<Run> = None;
    let mut last_dirty = crate::sync_dirty::Snapshot::default();
    let mut snapshot_conflict = false;
    let mut local_failure = false;
    // A command that arrived while the loop slept; handled first next turn.
    let mut deferred: Option<Command> = None;
    while alive.load(Ordering::Acquire) {
        let iteration = (|| -> Result<()> {
            while let Some(command) = deferred.take().or_else(|| commands.try_recv().ok()) {
                let command_epoch = match &command {
                    Command::Action(e, _)
                    | Command::Root(e, _)
                    | Command::Suspend(e)
                    | Command::Wake(e) => *e,
                };
                if command_epoch != epoch.load(Ordering::Acquire) {
                    continue;
                }
                applied_epoch = command_epoch;
                match command {
                    Command::Wake(_) => {
                        // A wake is not user authorization to retry unsafe local
                        // state. Only Sync now/sign-in may clear that block.
                        if !local_failure && enabled(&store, suspended) {
                            scheduler.wake(now());
                        }
                    }
                    Command::Suspend(_) => {
                        manual_requested = false;
                        suspended = true;
                        scheduler.stop();
                        publish(shared, |s| {
                            s.scheduler = scheduler.status();
                            running.store(false, Ordering::Release);
                            s.suspended = true;
                            s.busy = false;
                            s.signing_in = false;
                            s.capture_project = None;
                        });
                    }
                    Command::Root(_, next) => {
                        manual_requested = false;
                        root = next.canonicalize().unwrap_or(next);
                        verify_pending = true;
                        suspended = false;
                        scheduler.stop();
                        scheduler.start(now(), enabled(&store, false), receipt.last_sync);
                        if local_failure {
                            scheduler.block_local(
                                "Local Drive state requires validation; choose Sync now to retry."
                                    .into(),
                            );
                        }
                        publish(shared, |s| {
                            s.scheduler = scheduler.status();
                            s.busy = false;
                            running.store(false, Ordering::Release);
                            s.suspended = false;
                            s.capture_project = None;
                            s.projects.clear();
                        });
                    }
                    Command::Action(_, Action::SignOut) => {
                        manual_requested = false;
                        scheduler.stop();
                        store.sign_out()?;
                        session = store.generation();
                        receipt = Receipt::default();
                        save_receipt(&config_dir, &receipt)?;
                        publish(shared, |s| {
                            s.scheduler = scheduler.status();
                            running.store(false, Ordering::Release);
                            s.signed_in = false;
                            s.signing_in = false;
                            s.busy = false;
                            s.projects.clear();
                            s.progress = crate::i18n::t("library.projectPicker.signedOut");
                            s.progress_kind = ProgressKind::SignedOut;
                            s.error = None;
                        });
                    }
                    Command::Action(_, Action::Cancel) => {
                        manual_requested = false;
                        scheduler.cancel();
                        publish(shared, |s| {
                            s.busy = false;
                            s.signing_in = false;
                            s.capture_project = None;
                            s.scheduler = scheduler.status();
                            running.store(false, Ordering::Release);
                            s.progress = crate::i18n::t("library.dropScreen.syncPaused");
                            s.progress_kind = ProgressKind::Paused;
                            s.error = None;
                        });
                    }
                    Command::Action(_, Action::SignIn) => {
                        manual_requested = false;
                        scheduler.stop();
                        publish(shared, |s| {
                            s.signing_in = true;
                            s.error = None;
                            s.progress = crate::i18n::t("library.common.finishGoogleSignIn");
                            s.progress_kind = ProgressKind::None;
                        });
                        let cancel = || {
                            !alive.load(Ordering::Acquire)
                                || epoch.load(Ordering::Acquire) != command_epoch
                        };
                        let result = (|| -> Result<()> {
                            let login = OAuthSession::start(config.clone(), store.clone())?;
                            events
                                .send(Event::OpenUrl(
                                    command_epoch,
                                    login.authorization_url().into(),
                                ))
                                .context("Drive host disconnected")?;
                            login.finish(&cancel)
                        })();
                        if cancel() {
                            continue;
                        }
                        publish(shared, |s| {
                            s.signing_in = false;
                            s.error = result.as_ref().err().map(|e| e.to_string());
                        });
                        if result.is_ok() {
                            session = store.generation();
                            receipt = Receipt::default();
                            scheduler.start(now(), enabled(&store, suspended), None);
                            manual_requested = true;
                        }
                    }
                    Command::Action(_, Action::SyncNow) => {
                        publish(shared, |s| s.error = None);
                        manual_requested = true;
                    }
                    Command::Action(_, Action::ShowLog) => {}
                }
            }
            // Keep commands (especially storage fences and sign-out) alive,
            // but never retry a hard local IO failure on every polling turn.
            // Sync now or successful sign-in permits one validation attempt.
            if local_failure && !manual_requested {
                return Ok(());
            }
            let current = store.generation();
            if current != session {
                session = current;
                receipt = Receipt::default();
                scheduler.stop();
                scheduler.start(now(), enabled(&store, suspended), None);
                publish(shared, |s| s.projects.clear());
            }
            if verify_pending {
                verify_receipt(&mut receipt, &root, &ledger)?;
                verify_pending = false;
            }
            let dirty = read_dirty(&ledger, &config_dir)?;
            last_dirty = dirty.clone();
            if local_failure {
                scheduler.cancel();
                local_failure = false;
            }
            if snapshot_conflict {
                publish(shared, |s| s.error = None);
                snapshot_conflict = false;
            }
            scheduler.observe_dirty(now(), dirty.seq, count(&dirty));
            let requested = if manual_requested {
                let run = scheduler.request_now(now());
                manual_requested = false;
                run
            } else {
                None
            };
            refresh_state(shared, &scheduler, &store, &root, &dirty, &receipt, running);
            if epoch.load(Ordering::Acquire) != applied_epoch {
                return Ok(());
            }
            if let Some(run) = requested.or_else(|| scheduler.poll(now())) {
                if suspended || !scheduler.owns(run) {
                    return Ok(());
                }
                active_run = Some(run);
                let generation = applied_epoch;
                let cancellation_generation = store.generation();
                let token_generation = match receipt_generation(&store, &config_dir, ReceiptRead::RunStart) {
                    Ok(generation) => generation,
                    Err(error) => {
                        // A session read is advisory here, not a permanent local
                        // ledger failure. Retain intent and retry from a fresh run.
                        scheduler.cancel();
                        active_run = None;
                        ledger.mark_library_preserving_projects(&error.to_string())?;
                        let pending = read_dirty(&ledger, &config_dir)?;
                        last_dirty = pending.clone();
                        scheduler.observe_dirty(now(), pending.seq, count(&pending));
                        refresh_state(shared, &scheduler, &store, &root, &pending, &receipt, running);
                        return Ok(());
                    }
                };
                let cancel = || {
                    !alive.load(Ordering::Acquire)
                        || epoch.load(Ordering::Acquire) != generation
                        || store.generation() != cancellation_generation
                };
                running.store(true, Ordering::Release);
                publish(shared, |s| {
                    s.busy = true;
                    s.error = None;
                    s.fraction = 0.;
                    s.progress = crate::i18n::t("library.drive.checking");
                    s.progress_kind = ProgressKind::None;
                    s.scheduler = scheduler.status();
                });
                let remote = crate::drive_remote::Remote::new(AuthClient::new(
                    config.clone(),
                    store.clone(),
                ));
                let result = crate::drive_sync::run(
                    &remote,
                    &root,
                    &config_dir.join("gdrive/spool"),
                    &cancel,
                    &|message, fraction| {
                        crate::diagnostics::event(
                            "gdrive",
                            message.clone(),
                            crate::diagnostics::Level::Info,
                        );
                        publish(shared, |s| {
                            s.progress = message;
                            s.progress_kind = ProgressKind::None;
                            s.fraction = fraction.clamp(0., 1.);
                        })
                    },
                    &|project| {
                        publish(shared, |s| {
                            if let Some(path) = &project {
                                s.projects.insert(path.clone(), ProjectState::Syncing);
                            }
                            s.capture_project = project;
                        })
                    },
                );
                // Refresh rejection clears its own token generation. That is
                // an authentication result, not a host cancellation. Only the
                // exact generation cleared by this request may cross this fence.
                let expired_generation = if alive.load(Ordering::Acquire)
                    && epoch.load(Ordering::Acquire) == generation
                {
                    match &result {
                        Err(error) => store.current_expired_generation(error)?,
                        Ok(_) => None,
                    }
                } else {
                    None
                };
                if cancel() && expired_generation.is_none() {
                    scheduler.cancel();
                    active_run = None;
                    refresh_state(shared, &scheduler, &store, &root, &dirty, &receipt, running);
                    return Ok(());
                }
                let before = read_dirty(&ledger, &config_dir)?;
                last_dirty = before.clone();
                let new_marks = before.seq > run.captured_seq;
                let mut explicit_follow_up = false;
                let outcome = match result {
                    Ok(report) => {
                        explicit_follow_up = report.follow_up;
                        ledger.clear(run.captured_seq)?;
                        let mut outstanding = dirty.outside_library(&root);
                        outstanding.extend(report.skipped.iter().cloned());
                        outstanding.sort();
                        outstanding.dedup();
                        for path in outstanding {
                            ledger.mark_project(&path, "not reached by Drive sync")?;
                        }
                        if cancel() || !receipt_generation(&store, &config_dir, ReceiptRead::RunFinish)
                            .is_ok_and(|generation| generation == token_generation)
                        {
                            ledger.mark_library_preserving_projects(
                                "Drive account changed during cleanup",
                            )?;
                            scheduler.cancel();
                            active_run = None;
                            refresh_state(
                                shared, &scheduler, &store, &root, &before, &receipt, running,
                            );
                            return Ok(());
                        }
                        receipt.token_generation = token_generation;
                        receipt.version = 1;
                        receipt.last_sync = Some(now());
                        receipt.projects.retain(|path, _| !path.starts_with(&root));
                        receipt.projects.extend(report.synced);
                        let mut warnings = report.warnings;
                        for path in dirty.outside_library(&root) {
                            warnings.push(format!(
                                "{} is outside the selected library and was not synced",
                                path.display()
                            ));
                        }
                        if let Err(error) = save_receipt(&config_dir, &receipt) {
                            warnings.push(format!(
                                "Drive synced, but its status could not be saved: {error}"
                            ));
                        }
                        let clean = warnings.is_empty() && report.skipped.is_empty()
                            && !explicit_follow_up;
                        publish(shared, |s| {
                            for path in &report.skipped {
                                s.projects.insert(path.clone(), if explicit_follow_up {
                                    ProjectState::Pending
                                } else { ProjectState::Blocked });
                            }
                            for path in receipt
                                .projects
                                .keys()
                                .filter(|path| path.starts_with(&root))
                            {
                                s.projects.insert(path.clone(), ProjectState::Synced);
                            }
                            s.progress_kind = if explicit_follow_up { ProgressKind::Finishing } else { ProgressKind::None };
                            s.progress = if explicit_follow_up {
                                crate::i18n::t("library.drive.finishingSync")
                            } else if clean {
                                format!(
                                    "Drive is up to date — {} uploaded, {} unchanged. Your phones see them under Google Drive.",
                                    report.uploaded, report.unchanged
                                )
                            } else {
                                "Some projects are still waiting to sync. See Log for details."
                                    .into()
                            };
                        });
                        let _ = events.send(Event::LibraryChanged(generation));
                        Outcome::Success {
                            warnings,
                            last_sync: receipt.last_sync,
                        }
                    }
                    Err(error) => {
                        // Ledger IO above may have yielded to Cancel, Sign out,
                        // or another account. Never surface a stale auth error.
                        if expired_generation.is_some()
                            && (!alive.load(Ordering::Acquire)
                                || epoch.load(Ordering::Acquire) != generation
                                || store.current_expired_generation(&error)? != expired_generation)
                        {
                            scheduler.cancel();
                            active_run = None;
                            refresh_state(
                                shared, &scheduler, &store, &root, &before, &receipt, running,
                            );
                            return Ok(());
                        }
                        crate::diagnostics::event(
                            "gdrive",
                            error.to_string(),
                            crate::diagnostics::Level::Error,
                        );
                        publish(shared, |s| {
                            s.error = Some(error.to_string());
                            for state in s.projects.values_mut() {
                                if *state == ProjectState::Syncing {
                                    *state = ProjectState::Pending;
                                }
                            }
                        });
                        Outcome::Failure {
                            error: error.to_string(),
                        }
                    }
                };
                let post = read_dirty(&ledger, &config_dir)?;
                last_dirty = post.clone();
                let mut random = [0u8; 8];
                let jitter = if getrandom::fill(&mut random).is_ok() {
                    u64::from_le_bytes(random) as f64 / u64::MAX as f64
                } else {
                    0.5
                };
                scheduler.finish(
                    run.id,
                    outcome,
                    now(),
                    jitter,
                    new_marks || explicit_follow_up,
                    post.seq,
                    count(&post),
                );
                active_run = None;
                refresh_state(shared, &scheduler, &store, &root, &post, &receipt, running);
            }
            Ok(())
        })();
        if let Err(error) = iteration {
            if !crate::sync_dirty::is_snapshot_changed(&error) {
                let message = format!("Google Drive is unavailable: {error:#}");
                scheduler.block_local(message.clone());
                active_run = None;
                manual_requested = false;
                local_failure = true;
                // Repair may restore an older ledger. Recheck saved receipt
                // fingerprints rather than trusting its previous clean state.
                verify_pending = true;
                snapshot_conflict = false;
                crate::diagnostics::event(
                    "gdrive",
                    message.clone(),
                    crate::diagnostics::Level::Error,
                );
                let signed_in = store.signed_in_checked();
                publish(shared, |s| {
                    s.scheduler = scheduler.status();
                    s.busy = false;
                    s.signing_in = false;
                    if let Ok(value) = signed_in {
                        s.signed_in = value;
                    }
                    running.store(false, Ordering::Release);
                    s.capture_project = None;
                    s.error = Some(message);
                    for state in s.projects.values_mut() {
                        if *state == ProjectState::Syncing {
                            *state = ProjectState::Pending;
                        }
                    }
                });
                thread::sleep(Duration::from_millis(25));
                continue;
            }
            // Do not replay mutations or acknowledge uncaptured intent. The
            // next turn still handles cancellation/root commands before reading.
            let message = format!("Library changed during sync; {error}; retry required");
            if let Some(run) = active_run.take() {
                scheduler.finish(
                    run.id,
                    Outcome::Failure {
                        error: message.clone(),
                    },
                    now(),
                    0.5,
                    false,
                    last_dirty.seq,
                    -1,
                );
            }
            snapshot_conflict = true;
            publish(shared, |s| {
                s.scheduler = scheduler.status();
                s.scheduler.dirty = -1; // Unknown is never a clean acknowledgement.
                s.busy = false;
                running.store(false, Ordering::Release);
                s.capture_project = None;
                s.error = Some(message);
                for state in s.projects.values_mut() {
                    if *state == ProjectState::Syncing {
                        *state = ProjectState::Pending;
                    }
                }
            });
        }
        // The scheduler's own clocks are seconds (debounce 4 s, launch 8 s), so
        // with nothing running or pending the ledger is read at IDLE_TURN and a
        // command wakes the loop at once instead of waiting out the sleep.
        let busy = active_run.is_some() || manual_requested || local_failure || verify_pending || snapshot_conflict;
        let turn = if busy { Duration::from_millis(25) } else { IDLE_TURN };
        match commands.recv_timeout(turn) {
            Ok(command) => deferred = Some(command),
            Err(mpsc::RecvTimeoutError::Timeout) => {}
            Err(mpsc::RecvTimeoutError::Disconnected) => thread::sleep(turn),
        }
    }
    scheduler.stop();
    Ok(())
}

#[cfg(test)]
mod tests {
    include!("drive_service_tests.rs");

    struct ReceiptReadProbe {
        started: Arc<AtomicBool>,
        finished: Arc<AtomicBool>,
    }
    fn hold_next_receipt_read(f: &Fixture, point: ReceiptRead) -> ReceiptReadProbe {
        let started = Arc::new(AtomicBool::new(false));
        let finished = Arc::new(AtomicBool::new(false));
        receipt_read_faults().lock().unwrap().insert(
            f.config.clone(),
            ReceiptReadFault {
                point,
                started: started.clone(),
                finished: finished.clone(),
            },
        );
        ReceiptReadProbe { started, finished }
    }
    fn wait_for_receipt_read(probe: &ReceiptReadProbe) {
        let deadline = Instant::now() + Duration::from_secs(5);
        while !probe.finished.load(Ordering::Acquire) {
            assert!(
                Instant::now() < deadline,
                "receipt read never timed out under the held lease"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    fn assert_next_run_proceeds(service: &Service, previous: Option<u64>) {
        wait(service, |s| {
            assert_ne!(
                s.scheduler.phase,
                Phase::Blocked,
                "a transient receipt read permanently blocked the worker: {s:?}"
            );
            s.is_up_to_date() && s.scheduler.last_sync > previous
        });
    }
    #[test]
    fn startup_receipt_lease_timeout_keeps_the_worker_alive() {
        let f = Fixture::new();
        let initial = f.service();
        f.login(&initial);
        drop(initial);
        let finished = hold_next_receipt_read(&f, ReceiptRead::Startup);
        let service = f.service();
        wait_for_receipt_read(&finished);
        wait(&service, |s| {
            assert_ne!(
                s.scheduler.phase,
                Phase::Blocked,
                "startup receipt contention killed the worker: {s:?}"
            );
            s.configured
        });
        assert_eq!(service.snapshot().scheduler.last_sync, None);
        service.action(Action::SyncNow).unwrap();
        assert_next_run_proceeds(&service, None);
    }
    #[test]
    fn run_start_receipt_lease_timeout_reschedules_without_manual_retry() {
        let f = Fixture::new();
        let service = f.service();
        f.login(&service);
        let previous = service.snapshot().scheduler.last_sync;
        let finished = hold_next_receipt_read(&f, ReceiptRead::RunStart);
        f.edit(42);
        service.action(Action::SyncNow).unwrap();
        wait_for_receipt_read(&finished);
        assert_next_run_proceeds(&service, previous);
        assert_eq!(f.remote_doc()["foreign"], 42);
    }
    #[test]
    fn run_finish_receipt_lease_timeout_rechecks_without_manual_retry() {
        let f = Fixture::new();
        let service = f.service();
        f.login(&service);
        let previous = service.snapshot().scheduler.last_sync;
        let session = TokenStore::new(&f.config).unwrap();
        let epoch = session.generation();
        let finished = hold_next_receipt_read(&f, ReceiptRead::RunFinish);
        f.edit(43);
        service.action(Action::SyncNow).unwrap();
        // Sync work has its existing 12-second progress bound. The separate
        // five-second receipt deadline measures the actual held-lease read.
        wait(&service, |_| finished.started.load(Ordering::Acquire));
        wait_for_receipt_read(&finished);
        assert_eq!(
            session.generation(),
            epoch,
            "receipt lease contention fenced the account"
        );
        wait(&service, |s| {
            assert_ne!(
                s.scheduler.phase,
                Phase::Blocked,
                "completed run receipt contention permanently blocked the worker: {s:?}"
            );
            !s.busy
        });
        assert_eq!(service.snapshot().scheduler.last_sync, previous);
        assert!(
            crate::sync_dirty::Store::new(f.config.clone())
                .snapshot()
                .unwrap()
                .all_seq
                > 0,
            "a completed run lost its recheck intent after receipt contention"
        );
        assert_next_run_proceeds(&service, previous);
        assert_eq!(f.remote_doc()["foreign"], 43);
    }
}

#[cfg(test)]
mod receipt_generation_tests {
    use super::*;
    #[test]
    fn receipt_matches_restart_after_lock_timeout_and_transient_observation_fault() {
        struct Directory(PathBuf);
        impl Drop for Directory {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let directory = Directory(std::env::temp_dir().join(format!(
            "singz-receipt-generation-{}",
            crate::drive_http::random_id().unwrap()
        )));
        fs::create_dir(&directory.0).unwrap();
        let store = TokenStore::new(&directory.0).unwrap();
        store.sign_out().unwrap();
        let persisted = store.persisted_generation().unwrap();
        let epoch = store.generation();
        let session = directory.0.join("gdrive/session.json");
        let held = crate::file_lease::Lease::acquire(
            fs::OpenOptions::new()
                .read(true)
                .write(true)
                .open(session.with_extension("lock"))
                .unwrap(),
        )
        .unwrap();
        assert!(store.signed_in_checked().is_err());
        drop(held);
        assert_eq!(
            store.generation(),
            epoch,
            "plain contention retired the session"
        );
        // An independent transient observation fault can retire only the
        // cancellation epoch. It must never become the durable receipt version.
        let bytes = fs::read(&session).unwrap();
        fs::write(&session, b"{").unwrap();
        assert!(store.signed_in_checked().is_err());
        fs::write(&session, &bytes).unwrap();
        store.signed_in_checked().unwrap();
        assert_ne!(store.generation(), epoch);
        let receipt = Receipt {
            token_generation: store.persisted_generation().unwrap(),
            last_sync: Some(123),
            ..Receipt::default()
        };
        save_receipt(&directory.0, &receipt).unwrap();
        drop(store);
        let restarted = TokenStore::new(&directory.0).unwrap();
        let saved = read_receipt(&directory.0);
        assert_eq!(saved.token_generation, persisted);
        assert_eq!(
            saved.token_generation,
            restarted.persisted_generation().unwrap()
        );
        assert_eq!(saved.last_sync, Some(123));
    }
}

#[cfg(test)]
mod host_cancel_tests {
    use super::*;
    #[test]
    fn signout_host_epoch_wakes_an_inflight_wait_without_fallback_polling() {
        use std::{
            io::{BufRead, BufReader},
            net::TcpListener,
            time::Instant,
        };
        let (commands, _receiver) = mpsc::sync_channel(8);
        let (_sender, events) = mpsc::channel();
        let service = Service {
            commands,
            events,
            snapshot: Arc::new(Mutex::new(Snapshot::default())),
            epoch: Arc::new(AtomicU64::new(1)),
            alive: Arc::new(AtomicBool::new(true)),
            running: Arc::new(AtomicBool::new(true)),
            worker: None,
        };
        let epoch = service.epoch.clone();
        let waiting = Arc::new(AtomicBool::new(false));
        let client_waiting = waiting.clone();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let url = format!("http://{}/held", listener.local_addr().unwrap());
        let (ready, read) = mpsc::channel();
        let (release, released) = mpsc::channel();
        let server = thread::spawn(move || {
            let (socket, _) = listener.accept().unwrap();
            let mut reader = BufReader::new(socket);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            ready.send(()).unwrap();
            let _ = released.recv_timeout(Duration::from_secs(2));
        });
        let (done, finished) = mpsc::channel();
        let transfer = thread::spawn(move || {
            let result = crate::drive_http::with_test_network_wait(
                Duration::from_secs(60),
                client_waiting,
                || {
                    crate::drive_http::request(
                        crate::drive_http::Request {
                            method: "GET",
                            url: &url,
                            headers: &[],
                            body: crate::drive_http::Body::Empty,
                            destination: crate::drive_http::Destination::Bytes(512),
                            upload: false,
                            allow_loopback_http: true,
                        },
                        &|| epoch.load(Ordering::Acquire) != 1,
                    )
                },
            );
            done.send((result.is_err(), Instant::now())).unwrap();
        });
        read.recv_timeout(Duration::from_secs(1)).unwrap();
        let until = Instant::now() + Duration::from_secs(1);
        while !waiting.load(Ordering::Acquire) {
            assert!(Instant::now() < until);
            thread::sleep(Duration::from_millis(1));
        }
        let started = Instant::now();
        service.action(Action::SignOut).unwrap();
        let result = finished.recv_timeout(Duration::from_millis(250));
        release.send(()).ok();
        server.join().unwrap();
        transfer.join().unwrap();
        let (cancelled, ended) =
            result.expect("host sign-out waited for the closure polling fallback");
        assert!(cancelled);
        let elapsed = ended.duration_since(started);
        assert!(
            elapsed <= Duration::from_millis(250),
            "host sign-out took {elapsed:?}"
        );
        eprintln!("C12T_R2 host_signout_cancel_us={}", elapsed.as_micros());
    }
}

//! Independent OAuth/sync worker; the GPUI thread only sends intent and reads state.
use crate::{
    drive_auth::{AuthClient, Config, OAuthSession, TokenStore},
    drive_state::{Action, ProjectState, Snapshot},
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
            self.epoch.fetch_add(1, Ordering::AcqRel) + 1
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
        self.commands
            .try_send(Command::Suspend(epoch))
            .context("Google Drive command queue is full")
    }
    pub fn set_root(&self, root: PathBuf) -> Result<()> {
        let epoch = self.epoch.fetch_add(1, Ordering::AcqRel) + 1;
        self.commands
            .try_send(Command::Root(epoch, root))
            .context("Google Drive command queue is full")
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.epoch.fetch_add(1, Ordering::AcqRel);
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
    if dirty.all_seq > 0 {
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
                match commands.recv_timeout(Duration::from_millis(25)) {
                    Ok(Command::Suspend(e)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| s.suspended = true)
                    }
                    Ok(Command::Root(e, _)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| s.suspended = false)
                    }
                    Ok(Command::Action(e, _)) if e == epoch.load(Ordering::Acquire) => {
                        publish(shared, |s| {
                            s.error = Some("Google Drive is not configured".into())
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
    if receipt.token_generation != store.generation() {
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
    while alive.load(Ordering::Acquire) {
        let iteration = (|| -> Result<()> {
            while let Ok(command) = commands.try_recv() {
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
                            s.progress = "Signed out of Google Drive.".into();
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
                            s.progress =
                            "Sync paused. Completed files are kept. Choose Sync now to continue."
                                .into();
                            s.error = None;
                        });
                    }
                    Command::Action(_, Action::SignIn) => {
                        manual_requested = false;
                        scheduler.stop();
                        publish(shared, |s| {
                            s.signing_in = true;
                            s.error = None;
                            s.progress = "Finish signing in to Google in your browser…".into();
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
                let token_generation = store.generation();
                let cancel = || {
                    !alive.load(Ordering::Acquire)
                        || epoch.load(Ordering::Acquire) != generation
                        || store.generation() != token_generation
                };
                running.store(true, Ordering::Release);
                publish(shared, |s| {
                    s.busy = true;
                    s.error = None;
                    s.fraction = 0.;
                    s.progress = "Checking Google Drive…".into();
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
                        if cancel() {
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
                            s.progress = if explicit_follow_up {
                                "Finishing Drive sync…".into()
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
        thread::sleep(Duration::from_millis(25));
    }
    scheduler.stop();
    Ok(())
}

#[cfg(test)]
#[path = "drive_service_tests.rs"]
mod tests;

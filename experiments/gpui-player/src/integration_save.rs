//! Explicit project saves have an independent bounded queue. They outlive
//! navigation, while native command/status polling never waits for disk I/O.
use super::{Event, Project};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    path::PathBuf,
    sync::{
        Arc, Mutex,
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
const BUSY_LIMIT: Duration = Duration::from_secs(30);
const SHUTDOWN_LIMIT: Duration = Duration::from_secs(5);
type Stamps = Vec<(String, (u64, SystemTime))>;
pub(super) type Reanchors = Arc<Mutex<Vec<Reanchor>>>;
pub(super) struct Reanchor {
    pub epoch: u64,
    pub dir: PathBuf,
    pub custom: Vec<crate::tracks::Lane>,
    pub stamps: Stamps,
}
struct Save {
    epoch: u64,
    seq: u64,
    dir: PathBuf,
    expected: String,
    raw: Value,
    mix: crate::project_store::Mix,
    _intent: crate::project_publish::WriteIntentGuard,
}
type Mark = Arc<dyn Fn(&std::path::Path, &dyn Fn() -> bool) -> Result<()> + Send + Sync>;
// Electron's withDirty: the ledger is marked dirty before the project bytes
// are published (a failed mark refuses the save) and again afterwards (a
// failed second mark is a warning, the project is already dirty). Startup
// retires the records earlier builds kept in a separate directory.
struct Hooks {
    mark: Mark,
    startup: Option<Arc<dyn Fn(&dyn Fn() -> bool) + Send + Sync>>,
}
// A commit is acknowledged to the UI only after its ledger mark has finished,
// but the mark runs on its own thread so a busy ledger never delays the
// metadata commit of the saves queued behind it.
enum Outcome {
    Committed(Save, crate::project_store::CustomCommit),
    // A commit was attempted and failed: the bytes may have changed (committed
    // cleanup failure, failed rollback), so the second edge still runs.
    CommitFailed(Save, String),
    // Refused before any commit was attempted.
    Failed(u64, String),
}
pub(super) struct Service {
    requests: Option<SyncSender<Save>>,
    shutdown: Arc<Mutex<Option<Instant>>>,
    worker: Option<thread::JoinHandle<()>>,
    marker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(events: mpsc::Sender<Event>, reanchors: Reanchors) -> Self {
        Self::with_hooks(
            events,
            reanchors,
            Hooks {
                mark: Arc::new(|dir, cancel| {
                    crate::sync_dirty::mark_project_until(dir, "saved", cancel)
                }),
                startup: Some(Arc::new(|cancel| {
                    if let Err(error) = crate::sync_dirty::retire_legacy_intents(cancel) {
                        eprintln!("Legacy sync records remain: {error:#}");
                    }
                })),
            },
        )
    }
    #[cfg(test)]
    fn with_marker(events: mpsc::Sender<Event>, reanchors: Reanchors, mark: Mark) -> Self {
        Self::with_hooks(
            events,
            reanchors,
            Hooks { mark, startup: None },
        )
    }
    fn with_hooks(events: mpsc::Sender<Event>, reanchors: Reanchors, hooks: Hooks) -> Self {
        let (requests, receiver) = mpsc::sync_channel::<Save>(8);
        let (outcomes, outcome_receiver) = mpsc::channel::<Outcome>();
        let shutdown = Arc::new(Mutex::new(None));
        let stopping = shutdown.clone();
        let past_deadline = move || {
            stopping
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .is_some_and(|deadline| Instant::now() >= deadline)
        };
        let commit_cancel = past_deadline.clone();
        let before = hooks.mark.clone();
        let worker = thread::spawn(move || {
            while let Ok(save) = receiver.recv() {
                // First edge: dirty before any project byte is published. A
                // failed or cancelled mark refuses the save.
                let outcome = match before(&save.dir, &commit_cancel) {
                    Err(error) => Outcome::Failed(
                        save.epoch,
                        format!("Pending sync intent could not be recorded; nothing was saved: {error:#}"),
                    ),
                    Ok(()) => match commit(&save, &commit_cancel) {
                        Ok(saved) => Outcome::Committed(save, saved),
                        Err(error) => {
                            let message = failed_receipt(&error);
                            Outcome::CommitFailed(save, message)
                        }
                    },
                };
                if outcomes.send(outcome).is_err() {
                    break;
                }
            }
        });
        let marker = thread::spawn(move || {
            if let Some(startup) = &hooks.startup {
                startup(&past_deadline);
            }
            while let Ok(outcome) = outcome_receiver.recv() {
                let (save, mut saved) = match outcome {
                    Outcome::Committed(save, saved) => (save, saved),
                    Outcome::CommitFailed(save, mut message) => {
                        // Electron's finally: the second edge runs for every
                        // attempted commit, because the bytes may have changed.
                        if let Err(error) = (hooks.mark)(&save.dir, &past_deadline) {
                            message.push_str(&format!(" (its pending sync mark could not be refreshed, it is already marked: {error:#})"));
                        }
                        let _ = events.send(Event::SaveFailed(save.epoch, message));
                        continue;
                    }
                    Outcome::Failed(epoch, message) => {
                        let _ = events.send(Event::SaveFailed(epoch, message));
                        continue;
                    }
                };
                // Second edge: dirty again after the bytes, so a sync that read the
                // folder mid-save gets a corrective run. The project is already
                // dirty from the first edge, so a failure here is a warning.
                if let Err(error) = (hooks.mark)(&save.dir, &past_deadline) {
                    saved.warnings.push(format!("Project was saved, but its pending sync intent could not be refreshed (it is already marked): {error:#}"));
                }
                let mut stamps = vec![];
                for lane in &saved.custom {
                    match crate::project_analysis::stamp(&lane.file) {
                        Ok(stamp) => stamps.push((lane.id.clone(), stamp)),
                        Err(error) => saved.warnings.push(format!("Project was saved, but a custom source changed before its receipt: {error:#}")),
                    }
                }
                // Queue before exposing Saved. Any subsequently issued
                // native command observes the reanchor first, without
                // stat/canonicalize/copy on the native worker.
                reanchors
                    .lock()
                    .unwrap_or_else(|e| e.into_inner())
                    .push(Reanchor {
                        epoch: save.epoch,
                        dir: save.dir.clone(),
                        custom: saved.custom.clone(),
                        stamps: stamps.clone(),
                    });
                let _ = events.send(Event::Saved(
                    save.epoch,
                    save.seq,
                    saved.raw,
                    saved.metadata_hash,
                    saved.custom,
                    saved.warnings,
                    stamps,
                ));
                // The intent remains live through publication and receipt.
            }
        });
        Self {
            requests: Some(requests),
            shutdown,
            worker: Some(worker),
            marker: Some(marker),
        }
    }
    pub fn save(
        &self,
        epoch: u64,
        seq: u64,
        project: &Project,
        mix: crate::project_store::Mix,
    ) -> Result<()> {
        self.enqueue(
            epoch,
            seq,
            project.dir.clone(),
            project.metadata_hash.clone(),
            project.raw.clone(),
            mix,
        )
    }
    fn enqueue(
        &self,
        epoch: u64,
        seq: u64,
        dir: PathBuf,
        expected: String,
        raw: Value,
        mix: crate::project_store::Mix,
    ) -> Result<()> {
        // Register before queue admission. Rejected requests own and drop their
        // guard as well, so captures cannot be starved by phantom intent.
        let intent = crate::project_publish::write_intent(&dir)?;
        let request = Save {
            epoch,
            seq,
            dir,
            expected,
            raw,
            mix,
            _intent: intent,
        };
        self.requests
            .as_ref()
            .context("Project save worker has stopped")?
            .try_send(request)
            .map_err(|_| anyhow::anyhow!("Project save queue is full"))
    }
    pub fn finish(&mut self) {
        self.finish_by(Instant::now() + SHUTDOWN_LIMIT);
    }
    fn finish_by(&mut self, deadline: Instant) {
        if self.worker.is_none() {
            return;
        }
        *self.shutdown.lock().unwrap_or_else(|e| e.into_inner()) = Some(deadline);
        drop(self.requests.take());
        // Commits drain first; their marks finish (or are recorded) by the same deadline.
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        if let Some(marker) = self.marker.take() {
            let _ = marker.join();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.finish();
    }
}
/// A committed-cleanup failure changed the project; every other failure after a
/// commit attempt is reported as not saved.
fn failed_receipt(error: &anyhow::Error) -> String {
    if error
        .downcast_ref::<crate::project_publish::CommittedCleanupFailed>()
        .is_some()
    {
        format!("Project was saved, but its publication cleanup did not finish and will be repaired when the project is next opened: {error:#}")
    } else {
        format!("{error:#}")
    }
}
fn writer_busy(error: &anyhow::Error) -> bool {
    error.chain().any(|cause| {
        cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|e| e.kind() == std::io::ErrorKind::WouldBlock)
    })
}
fn commit(save: &Save, cancel: &impl Fn() -> bool) -> Result<crate::project_store::CustomCommit> {
    let value = crate::project_store::update_mix(save.raw.clone(), &save.mix)?;
    let deadline = Instant::now() + BUSY_LIMIT;
    loop {
        ensure!(!cancel(), "Project save did not finish before shutdown");
        match crate::project_store::commit_custom(
            &save.dir,
            &save.expected,
            &value,
            &save.mix.custom,
            cancel,
        ) {
            Ok(saved) => return Ok(saved),
            Err(error) if writer_busy(&error) && Instant::now() < deadline => {
                thread::sleep(Duration::from_millis(10))
            }
            Err(error) => return Err(error),
        }
    }
}
#[cfg(test)]
#[path = "integration_save_tests.rs"]
mod tests;

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
pub(super) struct Service {
    requests: Option<SyncSender<Save>>,
    shutdown: Arc<Mutex<Option<Instant>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(events: mpsc::Sender<Event>, reanchors: Reanchors) -> Self {
        Self::with_marker(
            events,
            reanchors,
            Arc::new(|dir| crate::sync_dirty::mark_project(dir, "saved")),
        )
    }
    fn with_marker(
        events: mpsc::Sender<Event>,
        reanchors: Reanchors,
        mark: Arc<dyn Fn(&std::path::Path) -> Result<()> + Send + Sync>,
    ) -> Self {
        let (requests, receiver) = mpsc::sync_channel::<Save>(8);
        let shutdown = Arc::new(Mutex::new(None));
        let stopping = shutdown.clone();
        let worker = thread::spawn(move || {
            while let Ok(save) = receiver.recv() {
                let cancel = || {
                    stopping
                        .lock()
                        .unwrap_or_else(|e| e.into_inner())
                        .is_some_and(|deadline| Instant::now() >= deadline)
                };
                let result = commit(&save, &cancel);
                match result {
                    Ok(mut saved) => {
                        if let Err(error) = mark(&save.dir) {
                            saved.warnings.push(format!("Project was saved, but pending sync intent could not be recorded: {error:#}"));
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
                    }
                    Err(error) => {
                        let _ = events.send(Event::SaveFailed(save.epoch, format!("{error:#}")));
                    }
                }
                // The intent remains live through publication and receipt.
            }
        });
        Self {
            requests: Some(requests),
            shutdown,
            worker: Some(worker),
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
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.finish();
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

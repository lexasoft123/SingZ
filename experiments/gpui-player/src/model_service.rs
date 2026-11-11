//! Serialized native model jobs. Cancellation bypasses the request queue and
//! owns the curl/tar processes until they are reaped, including on app exit.
use super::{
    model_catalog::{Config, Entry},
    model_install,
};
use anyhow::{Context, Result, ensure};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU8, AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
};
#[derive(Clone, Debug)]
pub struct Row {
    pub entry: Entry,
    pub present: bool,
    pub download_mb: u64,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub revision: u64,
    pub loaded: bool,
    pub busy: bool,
    pub windows: bool,
    pub cpu_only: bool,
    pub mode_reason: Option<String>,
    pub rows: Vec<Row>,
    pub running: Vec<String>,
    pub progress: BTreeMap<String, f32>,
    pub error: Option<String>,
}
impl Snapshot {
    pub fn required_done(&self) -> bool {
        self.loaded && self.rows.iter().all(|r| r.entry.optional || r.present)
    }
}
enum Request {
    Refresh,
    Mode,
    Download(u64, Option<Vec<String>>),
    Quit,
}
pub struct Service {
    requests: SyncSender<Request>,
    serial: Arc<AtomicU64>,
    pending_mode: Arc<AtomicU8>,
    busy: Arc<AtomicBool>,
    view: Arc<Mutex<Arc<Snapshot>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new() -> Self {
        Self::from_config(config())
    }
    pub fn from_config(config: Config) -> Self {
        let (requests, receiver) = mpsc::sync_channel(8);
        let serial = Arc::new(AtomicU64::new(1));
        let busy = Arc::new(AtomicBool::new(false));
        let pending_mode = Arc::new(AtomicU8::new(0));
        let modes = pending_mode.clone();
        let view = Arc::new(Mutex::new(Arc::new(Snapshot::default())));
        let generation = serial.clone();
        let running = busy.clone();
        let output = view.clone();
        let worker = thread::spawn(move || {
            let mut state = Snapshot::default();
            let valid = config.validate();
            if let Err(error) = valid {
                state.loaded = true;
                state.error = Some(error.to_string());
                publish(&mut state, &output);
                return;
            }
            refresh(&config, &mut state);
            publish(&mut state, &output);
            while let Ok(request) = receiver.recv() {
                match request {
                    Request::Quit => break,
                    Request::Mode => {
                        apply_mode(&config, &modes, &mut state);
                        publish(&mut state, &output);
                    }
                    Request::Refresh => {
                        refresh(&config, &mut state);
                        apply_mode(&config, &modes, &mut state);
                        publish(&mut state, &output);
                    }
                    Request::Download(id, ids) => {
                        if model_install::cancelled(&generation, id).is_err() {
                            running.store(false, Ordering::Release);
                            continue;
                        }
                        let wanted: Vec<_> = state
                            .rows
                            .iter()
                            .filter(|r| {
                                ids.as_ref().map_or(!r.entry.optional && !r.present, |ids| {
                                    ids.contains(&r.entry.id)
                                })
                            })
                            .map(|r| r.entry.clone())
                            .collect();
                        let result = (|| -> Result<()> {
                            if let Some(ids) = &ids {
                                ensure!(
                                    ids.iter()
                                        .all(|id| state.rows.iter().any(|r| r.entry.id == *id)),
                                    "Model is unavailable on this platform"
                                );
                            }
                            Ok(())
                        })();
                        state.busy = true;
                        state.running = wanted.iter().map(|e| e.id.clone()).collect();
                        state.error = None;
                        for e in &wanted {
                            state.progress.insert(e.id.clone(), 0.);
                        }
                        publish(&mut state, &output);
                        let result = result.and_then(|_| {
                            for entry in &wanted {
                                model_install::cancelled(&generation, id)?;
                                model_install::install(
                                    &config,
                                    entry,
                                    &generation,
                                    id,
                                    |percent| {
                                        let mode_changed = apply_mode(&config, &modes, &mut state);
                                        let percent = percent.clamp(0., 100.);
                                        let previous = state.progress.insert(entry.id.clone(), percent);
                                        // The installer polls the transfer every few
                                        // milliseconds; the screen shows whole percents, so
                                        // only a change in that text is worth a revision (and
                                        // a redraw).
                                        if mode_changed || displayed_progress_changed(previous, percent) {
                                            publish(&mut state, &output);
                                        }
                                    },
                                )?;
                                if entry.archive {
                                    set_mode(&config, false)?;
                                }
                            }
                            Ok(())
                        });
                        state.busy = false;
                        state.running.clear();
                        refresh(&config, &mut state);
                        if let Err(error) = result {
                            if generation.load(Ordering::Acquire) == id {
                                state.error = Some(error.to_string());
                            }
                        }
                        publish(&mut state, &output);
                        running.store(false, Ordering::Release);
                    }
                }
            }
        });
        Self {
            requests,
            serial,
            pending_mode,
            busy,
            view,
            worker: Some(worker),
        }
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.view.lock().unwrap().clone()
    }
    pub fn refresh(&self) {
        let _ = self.requests.try_send(Request::Refresh);
    }
    pub fn download(&self, ids: Option<Vec<String>>) -> Result<()> {
        ensure!(self.snapshot().loaded, "Models are still being checked");
        ensure!(
            self.busy
                .compare_exchange(false, true, Ordering::AcqRel, Ordering::Acquire)
                .is_ok(),
            "A model download is already running"
        );
        let id = self.serial.fetch_add(1, Ordering::AcqRel) + 1;
        if self.requests.try_send(Request::Download(id, ids)).is_err() {
            self.busy.store(false, Ordering::Release);
            anyhow::bail!("Model worker is unavailable");
        }
        Ok(())
    }
    pub fn is_running(&self) -> bool {
        self.busy.load(Ordering::Acquire)
    }
    pub fn mode(&self, cpu: bool) -> Result<()> {
        self.pending_mode
            .store(if cpu { 2 } else { 1 }, Ordering::Release);
        // Progress applies it promptly during a transfer. Also wake the worker:
        // the choice may arrive after the job's final progress callback.
        let _ = self.requests.try_send(Request::Mode);
        Ok(())
    }
    pub fn cancel(&self) {
        self.serial.fetch_add(1, Ordering::AcqRel);
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.cancel();
        let _ = self.requests.send(Request::Quit);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn publish(state: &mut Snapshot, view: &Mutex<Arc<Snapshot>>) {
    state.revision += 1;
    *view.lock().unwrap() = Arc::new(state.clone());
}
fn refresh(config: &Config, state: &mut Snapshot) {
    state.error = None;
    state.windows = config.flavor == super::model_catalog::Flavor::Windows;
    let mode = std::fs::read(config.pack.parent().unwrap().join("trtrtx-disabled.json"))
        .ok()
        .filter(|b| b.len() <= 65536)
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    state.cpu_only = mode.is_some();
    state.mode_reason = mode.and_then(|v| v["reason"].as_str().map(str::to_owned));
    state.rows = config
        .entries
        .iter()
        .map(|entry| {
            if let Err(error) = model_install::recover_entry(config, entry) {
                state.error = Some(error.to_string());
            }
            Row {
                entry: entry.clone(),
                present: model_install::present(config, entry),
                download_mb: model_install::missing_mb(config, entry),
            }
        })
        .collect();
    state.loaded = true;
}
fn config() -> Config {
    #[cfg(feature = "ui-tests")]
    if let Some(file) = std::env::var_os("SINGZ_GPUI_MODEL_FIXTURE") {
        let result = (|| -> Result<Config> {
            ensure!(
                std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                    && std::env::var_os("SINGZ_MUTE").is_some(),
                "Model fixture requires hidden/muted UI"
            );
            let dir = std::path::PathBuf::from(
                std::env::var_os("SINGZ_GPUI_CONFIG_DIR")
                    .context("Isolated model fixture config required")?,
            );
            let bytes = std::fs::read(file)?;
            ensure!(bytes.len() <= 65536, "Model fixture catalog too large");
            #[derive(serde::Deserialize)]
            #[serde(deny_unknown_fields)]
            struct Fixture {
                flavor: super::model_catalog::Flavor,
                entries: Vec<Entry>,
            }
            let raw: Fixture = serde_json::from_slice(&bytes)?;
            Ok(Config {
                models: dir.join("models"),
                pack: dir.join("gpu-splitter"),
                flavor: raw.flavor,
                entries: raw.entries,
                fixture: true,
            })
        })();
        return result.expect("valid model fixture catalog");
    }
    Config::source()
}
/// Shared catalog selection for a caller-owned contextual model download.
pub fn configuration() -> Config {config()}

fn set_mode(config: &Config, cpu: bool) -> Result<()> {
    let parent = config.pack.parent().context("Invalid pack directory")?;
    std::fs::create_dir_all(parent)?;
    for name in ["dml-disabled.json", "trtrtx-disabled.json"] {
        let path = parent.join(name);
        if cpu {
            let raw = serde_json::json!({"at":chrono::Utc::now().to_rfc3339(),"reason":"chosen in the model manager"});
            let temporary = path.with_extension(format!(
                "{}.{}.tmp",
                std::process::id(),
                super::training_store::now()
            ));
            let result = (|| -> Result<()> {
                use std::io::Write;
                let mut f = std::fs::OpenOptions::new()
                    .write(true)
                    .create_new(true)
                    .open(&temporary)?;
                f.write_all(&serde_json::to_vec_pretty(&raw)?)?;
                f.sync_all()?;
                super::project_store::replace(&temporary, &path)?;
                Ok(())
            })();
            let _ = std::fs::remove_file(temporary);
            result?;
        } else if let Err(e) = std::fs::remove_file(path) {
            if e.kind() != std::io::ErrorKind::NotFound {
                return Err(e.into());
            }
        }
    }
    Ok(())
}

/// Applies a pending CPU/GPU choice; true when the snapshot changed because of it.
fn apply_mode(config: &Config, pending: &AtomicU8, state: &mut Snapshot) -> bool {
    let value = pending.swap(0, Ordering::AcqRel);
    if value == 0 {
        return false;
    }
    if let Err(error) = set_mode(config, value == 2) {
        state.error = Some(error.to_string());
        return true;
    }
    state.cpu_only = value == 2;
    state.mode_reason = (value == 2).then(|| "chosen in the model manager".into());
    true
}

/// The Models screen prints `{percent:.0}%` and draws a bar a few pixels per
/// percent wide, so progress below a whole percent is invisible.
fn displayed_progress_changed(previous: Option<f32>, next: f32) -> bool {
    previous.is_none_or(|before| format!("{before:.0}") != format!("{next:.0}"))
}

#[cfg(test)]
mod progress_gate_tests {
    use super::displayed_progress_changed;

    #[test]
    fn sub_percent_polls_do_not_publish_a_revision() {
        // The installer reports progress at its poll cadence (~50 Hz); only
        // a change in the displayed whole percent may publish.
        let mut published = 0;
        let mut previous = Some(0.);
        for step in 1..=5000 {
            let next = step as f32 * 0.02; // 0.02% per poll up to 100%
            if displayed_progress_changed(previous, next) { published += 1; }
            previous = Some(next);
        }
        assert!(published <= 101, "{published} publishes for 5000 polls (old behaviour: 5000)");
        assert!(displayed_progress_changed(Some(41.4), 41.6), "41% -> 42% is visible");
        assert!(!displayed_progress_changed(Some(41.6), 41.9));
        assert!(displayed_progress_changed(None, 0.));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    fn wait(service: &Service, predicate: impl Fn(&Snapshot) -> bool) {
        let deadline = Instant::now() + Duration::from_secs(3);
        while !predicate(&service.snapshot()) {
            assert!(
                Instant::now() < deadline,
                "Model worker did not acknowledge request: {:?}",
                service.snapshot()
            );
            thread::sleep(Duration::from_millis(2));
        }
    }
    #[test]
    fn mode_requests_wake_an_idle_worker_without_erasing_download_errors() {
        let root = std::env::temp_dir().join(format!(
            "singz-model-mode-{}-{}",
            std::process::id(),
            super::super::training_store::now()
        ));
        let service = Service::from_config(Config {
            models: root.join("models"),
            pack: root.join("pack"),
            flavor: super::super::model_catalog::Flavor::Windows,
            entries: vec![],
            fixture: true,
        });
        wait(&service, |s| s.loaded);
        service.download(Some(vec!["unavailable".into()])).unwrap();
        wait(&service, |s| !s.busy && s.error.is_some());
        service.mode(true).unwrap();
        wait(&service, |s| s.cpu_only);
        assert!(
            service.snapshot().error.is_some(),
            "Mode change erased a failed download"
        );
        assert!(root.join("trtrtx-disabled.json").is_file());
        service.mode(false).unwrap();
        wait(&service, |s| !s.cpu_only);
        assert!(service.snapshot().error.is_some());
        assert!(!root.join("trtrtx-disabled.json").exists());
        drop(service);
        std::fs::remove_dir_all(root).unwrap();
    }
}

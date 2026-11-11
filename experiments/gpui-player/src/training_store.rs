//! App-owned training ledger. A native worker keeps disk I/O off the UI thread.
//! Completion commits are immutable/no-overwrite; preference jobs coalesce.
use super::training_progress::{Aggregate, Completion, Preferences};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::VecDeque,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Condvar, Mutex,
        atomic::{AtomicU64, Ordering},
    },
    thread,
};
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Program {
    pub level: usize,
    pub started_at: u64,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Controls {
    pub format_version: u8,
    pub sound: usize,
    pub volume: f32,
    pub tolerance: usize,
    pub focus: usize,
    pub program: Option<Program>,
}
impl Default for Controls {
    fn default() -> Self {
        Self {
            format_version: 1,
            sound: 0,
            volume: 0.65,
            tolerance: 1,
            focus: 0,
            program: None,
        }
    }
}
impl Controls {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.format_version == 1
                && self.sound < 4
                && self.volume.is_finite()
                && (0.0..=2.).contains(&self.volume)
                && self.tolerance < 4
                && self.focus <= 12
                && self
                    .program
                    .as_ref()
                    .is_none_or(|p| p.level < 3 && p.started_at <= 9_007_199_254_740_991),
            "Invalid saved training controls"
        );
        Ok(())
    }
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub loaded: bool,
    pub revision: u64,
    pub preferences: Preferences,
    pub controls: Controls,
    pub receipts: Vec<Completion>,
    pub aggregate: Aggregate,
    pub load_error: Option<String>,
    pub preference_error: Option<String>,
    pub completion_error: Option<String>,
    pub pending: usize,
}
impl Snapshot {
    pub fn error(&self) -> Option<&str> {
        self.completion_error
            .as_deref()
            .or(self.preference_error.as_deref())
            .or(self.load_error.as_deref())
    }
}
fn read_json(path: &Path) -> Result<Option<Value>> {
    match fs::symlink_metadata(path) {
        Ok(metadata) => ensure!(metadata.is_file(), "Training data must be a regular file"),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let mut bytes = vec![];
    match File::open(path) {
        Ok(file) => {
            ensure!(
                fs::symlink_metadata(path)?.is_file(),
                "Training data must be a regular file"
            );
            file.take(16385).read_to_end(&mut bytes)?;
            ensure!(
                !bytes.is_empty() && bytes.len() <= 16384,
                "Training data is empty or too large"
            );
            Ok(Some(
                serde_json::from_slice(&bytes).context("Invalid training JSON")?,
            ))
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
fn load_preferences(dir: &Path) -> Result<Preferences> {
    let Some(mut raw) = read_json(&dir.join("training-preferences.json"))? else {
        return Ok(Preferences::default());
    };
    let doc = raw
        .as_object_mut()
        .context("Invalid training preference document")?;
    ensure!(
        doc.len() == 2 && doc.get("formatVersion") == Some(&json!(1)),
        "Unsupported training preference document"
    );
    let mut prefs = doc
        .remove("preferences")
        .context("Missing training preferences")?;
    if prefs["formatVersion"] == 1 {
        let old = prefs.as_object().context("Invalid legacy preferences")?;
        let keys = [
            "formatVersion",
            "range",
            "notation",
            "taskMode",
            "direction",
            "intervalSizes",
            "chordDegrees",
        ];
        ensure!(
            old.len() == keys.len() && keys.iter().all(|k| old.contains_key(*k)),
            "Invalid legacy training preferences"
        );
        let mut upgraded = serde_json::to_value(Preferences::default())?;
        for key in keys.into_iter().filter(|k| *k != "formatVersion") {
            upgraded[key] = old[key].clone();
        }
        prefs = upgraded;
    }
    let prefs: Preferences = serde_json::from_value(prefs)?;
    prefs.validate()?;
    Ok(prefs)
}
fn load_controls(dir: &Path) -> Result<Controls> {
    let Some(raw) = read_json(&dir.join("training-controls.json"))? else {
        return Ok(Controls::default());
    };
    let c: Controls = serde_json::from_value(raw)?;
    c.validate()?;
    Ok(c)
}
fn receipt_name(id: &str) -> String {
    format!("{}.json", super::project_store::fingerprint(id.as_bytes()))
}
fn read_receipt(path: &Path) -> Result<Completion> {
    let receipt: Completion =
        serde_json::from_value(read_json(path)?.context("Missing training receipt")?)?;
    receipt.validate()?;
    Ok(receipt)
}
pub fn load_receipts(dir: &Path) -> Result<Vec<Completion>> {
    let dir = dir.join("training-receipts");
    let entries = match fs::read_dir(&dir) {
        Ok(e) => e,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    let mut receipts = vec![];
    for entry in entries {
        let entry = entry?;
        let name = entry.file_name();
        let name = name.to_str().context("Invalid training receipt filename")?;
        if name.starts_with(".tmp-") {
            continue;
        }
        ensure!(
            name.len() == 69
                && name.ends_with(".json")
                && name[..64]
                    .bytes()
                    .all(|c| c.is_ascii_digit() || (b'a'..=b'f').contains(&c)),
            "Invalid training receipt filename"
        );
        let receipt = read_receipt(&entry.path())?;
        ensure!(
            receipt_name(&receipt.session_id) == name,
            "Training receipt identity does not match its filename"
        );
        receipts.push(receipt);
    }
    receipts.sort_by(|a, b| {
        b.completed_at
            .cmp(&a.completed_at)
            .then(a.session_id.cmp(&b.session_id))
    });
    Ok(receipts)
}
static SERIAL: AtomicU64 = AtomicU64::new(1);
struct Temporary(PathBuf);
impl Drop for Temporary {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn temporary(dir: &Path, bytes: &[u8]) -> Result<Temporary> {
    ensure!(bytes.len() <= 16384, "Training document exceeds size limit");
    fs::create_dir_all(dir)?;
    let path = dir.join(format!(
        ".tmp-{}-{:x}-{:x}",
        std::process::id(),
        now(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let pending = Temporary(path);
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&pending.0)?;
    file.write_all(bytes)?;
    file.sync_all()?;
    Ok(pending)
}
fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    let _ = dir;
    Ok(())
}
pub fn record(dir: &Path, receipt: &Completion) -> Result<bool> {
    receipt.validate()?;
    let directory = dir.join("training-receipts");
    let pending = temporary(&directory, &serde_json::to_vec(receipt)?)?;
    let final_path = directory.join(receipt_name(&receipt.session_id));
    let already = match fs::hard_link(&pending.0, &final_path) {
        Ok(()) => false,
        Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
            ensure!(
                read_receipt(&final_path)? == *receipt,
                "Training session receipt collision"
            );
            true
        }
        Err(e) => return Err(e.into()),
    };
    sync_dir(&directory)?;
    Ok(already)
}
fn save_preferences(dir: &Path, prefs: &Preferences) -> Result<()> {
    prefs.validate()?;
    load_preferences(dir)?;
    let raw = json!({"formatVersion":1,"preferences":prefs});
    let pending = temporary(dir, &serde_json::to_vec_pretty(&raw)?)?;
    super::project_store::replace(&pending.0, &dir.join("training-preferences.json"))?;
    sync_dir(dir)
}
fn save_controls(dir: &Path, controls: &Controls) -> Result<()> {
    controls.validate()?;
    load_controls(dir)?;
    let pending = temporary(dir, &serde_json::to_vec_pretty(controls)?)?;
    super::project_store::replace(&pending.0, &dir.join("training-controls.json"))?;
    sync_dir(dir)
}
pub fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(9_007_199_254_740_991) as u64
}
#[derive(Default)]
struct Jobs {
    preferences: Option<(Preferences, Controls)>,
    completions: VecDeque<Completion>,
    retry: bool,
    stop: bool,
}
pub struct Service {
    jobs: Arc<(Mutex<Jobs>, Condvar)>,
    view: Arc<Mutex<Arc<Snapshot>>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new() -> Self {
        Self::at(super::audio_devices::directory())
    }
    fn at(directory: PathBuf) -> Self {
        let jobs = Arc::new((Mutex::new(Jobs::default()), Condvar::new()));
        let view = Arc::new(Mutex::new(Arc::new(Snapshot::default())));
        let work = jobs.clone();
        let output = view.clone();
        let worker = thread::spawn(move || worker(directory, work, output));
        Self {
            jobs,
            view,
            worker: Some(worker),
        }
    }
    pub fn snapshot(&self) -> Arc<Snapshot> {
        self.view.lock().unwrap().clone()
    }
    pub fn preferences(&self, prefs: Preferences, controls: Controls) {
        let mut jobs = self.jobs.0.lock().unwrap();
        jobs.preferences = Some((prefs, controls));
        self.jobs.1.notify_one();
    }
    pub fn completion(&self, receipt: Completion) {
        let mut jobs = self.jobs.0.lock().unwrap();
        if !jobs
            .completions
            .iter()
            .any(|r| r.session_id == receipt.session_id)
        {
            jobs.completions.push_back(receipt);
        }
        self.jobs.1.notify_one();
    }
    pub fn retry(&self) {
        self.jobs.0.lock().unwrap().retry = true;
        self.jobs.1.notify_one();
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.jobs.0.lock().unwrap().stop = true;
        self.jobs.1.notify_one();
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn read_state(dir: &Path, view: &mut Snapshot) {
    let mut errors = vec![];
    match load_preferences(dir) {
        Ok(p) => view.preferences = p,
        Err(e) => errors.push(format!("Could not read training preferences: {e:#}")),
    }
    match load_controls(dir) {
        Ok(c) => view.controls = c,
        Err(e) => errors.push(format!("Could not read training controls: {e:#}")),
    }
    match load_receipts(dir) {
        Ok(receipts) => {
            view.aggregate = Aggregate::default();
            for r in &receipts {
                view.aggregate.merge(&r.aggregate);
            }
            view.receipts = receipts;
        }
        Err(e) => errors.push(format!("Could not read training history: {e:#}")),
    }
    view.load_error = (!errors.is_empty()).then(|| errors.join(" · "));
    view.loaded = true;
    view.revision += 1;
}
fn worker(dir: PathBuf, jobs: Arc<(Mutex<Jobs>, Condvar)>, view: Arc<Mutex<Arc<Snapshot>>>) {
    let mut state = Snapshot::default();
    read_state(&dir, &mut state);
    *view.lock().unwrap() = Arc::new(state.clone());
    let mut failed_completion = false;
    let mut failed_preferences: Option<(Preferences, Controls)> = None;
    loop {
        let mut queue = jobs.0.lock().unwrap();
        while !queue.stop
            && !queue.retry
            && (queue.completions.is_empty() || failed_completion)
            && queue.preferences.is_none()
        {
            queue = jobs.1.wait(queue).unwrap();
        }
        if queue.retry {
            failed_completion = false;
            queue.retry = false;
            if queue.preferences.is_none() {
                queue.preferences = failed_preferences.take();
            }
            read_state(&dir, &mut state);
        }
        let stop = queue.stop;
        let completion = if !failed_completion {
            queue.completions.front().cloned()
        } else {
            None
        };
        let preference = if completion.is_none() {
            queue.preferences.take()
        } else {
            None
        };
        drop(queue);
        if let Some(receipt) = completion {
            match record(&dir, &receipt) {
                Ok(_) => {
                    jobs.0.lock().unwrap().completions.pop_front();
                    state.completion_error = None;
                    read_state(&dir, &mut state);
                }
                Err(e) => {
                    failed_completion = true;
                    state.completion_error =
                        Some(format!("Could not save completed practice: {e:#}"));
                }
            }
        } else if let Some((preferences, controls)) = preference {
            // A failed profile never prevents the independent receipt commit.
            match save_preferences(&dir, &preferences).and_then(|_| save_controls(&dir, &controls))
            {
                Ok(()) => {
                    state.preferences = preferences;
                    state.controls = controls;
                    state.preference_error = None;
                    failed_preferences = None;
                }
                Err(e) => {
                    state.preference_error =
                        Some(format!("Could not save training settings: {e:#}"));
                    failed_preferences = Some((preferences, controls));
                }
            }
        }
        let queue = jobs.0.lock().unwrap();
        state.pending = queue.completions.len();
        state.revision += 1;
        *view.lock().unwrap() = Arc::new(state.clone());
        if stop
            && (queue.completions.is_empty() || failed_completion)
            && queue.preferences.is_none()
        {
            break;
        }
    }
}

#[cfg(test)]
mod tests {
    use super::super::{
        training_domain::{Kind, Task},
        training_progress::tests::complete,
    };
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            let p = std::env::temp_dir().join(format!(
                "singz-training-store-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(&p).unwrap();
            Self(p)
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn wait(service: &Service, condition: impl Fn(&Snapshot) -> bool) -> Arc<Snapshot> {
        let until = std::time::Instant::now() + std::time::Duration::from_secs(5);
        loop {
            let s = service.snapshot();
            if condition(&s) {
                return s;
            }
            assert!(std::time::Instant::now() < until, "Store timeout: {s:?}");
            thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    #[test]
    fn atomic_completion_deduplicates_across_writers_and_refuses_collisions() {
        let fixture = Fixture::new();
        let receipt = complete(Kind::Note, Task::Imitate, 1, "concurrent", false);
        let mut threads = vec![];
        for _ in 0..8 {
            let dir = fixture.0.clone();
            let r = receipt.clone();
            threads.push(thread::spawn(move || record(&dir, &r).unwrap()));
        }
        assert_eq!(
            threads
                .into_iter()
                .filter_map(|t| (!t.join().unwrap()).then_some(()))
                .count(),
            1
        );
        assert_eq!(load_receipts(&fixture.0).unwrap(), vec![receipt.clone()]);
        let mut collision = receipt.clone();
        collision.completed_at += 1;
        assert!(record(&fixture.0, &collision).is_err());
        assert_eq!(load_receipts(&fixture.0).unwrap(), vec![receipt]);
    }
    #[test]
    fn corrupt_or_future_preferences_are_preserved_and_receipts_still_commit() {
        let f = Fixture::new();
        let path = f.0.join("training-preferences.json");
        let original = b"{not valid json";
        fs::write(&path, original).unwrap();
        let service = Service::at(f.0.clone());
        wait(&service, |s| s.loaded);
        let receipt = complete(Kind::Note, Task::Imitate, 1, "independent", false);
        service.preferences(Preferences::default(), Controls::default());
        service.completion(receipt.clone());
        let snapshot = wait(&service, |s| {
            s.receipts.len() == 1 && s.preference_error.is_some()
        });
        assert_eq!(snapshot.aggregate.sessions, 1);
        assert_eq!(fs::read(&path).unwrap(), original);
        drop(service);
        assert_eq!(load_receipts(&f.0).unwrap(), vec![receipt]);
    }
    #[test]
    fn shutdown_flushes_latest_profile_and_receipts_and_restart_restores_them() {
        let f = Fixture::new();
        let service = Service::at(f.0.clone());
        wait(&service, |s| s.loaded);
        let mut p = Preferences::default();
        for n in 1..=12 {
            p.length = n;
            service.preferences(
                p.clone(),
                Controls {
                    sound: 2,
                    volume: 0.9,
                    program: Some(Program {
                        level: 1,
                        started_at: 100,
                    }),
                    ..Default::default()
                },
            );
        }
        service.completion(complete(Kind::Note, Task::Imitate, 1, "shutdown", false));
        drop(service);
        assert_eq!(load_preferences(&f.0).unwrap().length, 12);
        let restarted = Service::at(f.0.clone());
        let s = wait(&restarted, |s| s.loaded);
        assert_eq!(s.aggregate.sessions, 1);
        assert_eq!(s.controls.sound, 2);
        assert_eq!(s.controls.program.as_ref().unwrap().level, 1);
        assert_eq!(s.preferences.length, 12);
    }
    #[test]
    fn failed_completion_can_retry_after_repair_without_duplicating_or_blocking_profile() {
        let f = Fixture::new();
        fs::write(f.0.join("training-receipts"), b"blocked").unwrap();
        let service = Service::at(f.0.clone());
        wait(&service, |s| s.loaded);
        let r = complete(Kind::Note, Task::Imitate, 1, "retry", false);
        service.completion(r.clone());
        wait(&service, |s| s.completion_error.is_some());
        let p = Preferences {
            length: 30,
            ..Default::default()
        };
        service.preferences(p, Controls::default());
        wait(&service, |s| s.preferences.length == 30);
        fs::remove_file(f.0.join("training-receipts")).unwrap();
        service.retry();
        let s = wait(&service, |s| {
            s.completion_error.is_none() && s.receipts.len() == 1
        });
        assert_eq!(s.aggregate.attempts, 1);
        service.completion(r);
        drop(service);
        assert_eq!(load_receipts(&f.0).unwrap().len(), 1);
    }
    #[test]
    fn legacy_profile_upgrades_without_unknown_field_loss_or_silent_reset() {
        let f = Fixture::new();
        let p = serde_json::to_value(Preferences::default()).unwrap();
        let mut legacy = serde_json::Map::new();
        for k in [
            "formatVersion",
            "range",
            "notation",
            "taskMode",
            "direction",
            "intervalSizes",
            "chordDegrees",
        ] {
            legacy.insert(k.into(), p[k].clone());
        }
        legacy.insert("formatVersion".into(), json!(1));
        legacy.insert("notation".into(), json!("movable-do"));
        fs::write(
            f.0.join("training-preferences.json"),
            serde_json::to_vec(&json!({"formatVersion":1,"preferences":legacy})).unwrap(),
        )
        .unwrap();
        let p = load_preferences(&f.0).unwrap();
        assert_eq!(p.notation, "movable-do");
        assert_eq!(p.format_version, 2);
        save_preferences(&f.0, &p).unwrap();
        assert_eq!(load_preferences(&f.0).unwrap(), p);
    }
    #[test]
    fn history_is_lifetime_even_when_recent_ui_is_limited_to_one_hundred() {
        let f = Fixture::new();
        let base = complete(Kind::Note, Task::Imitate, 1, "lifetime", false);
        for index in 0..105 {
            let mut receipt = base.clone();
            receipt.session_id = format!("lifetime-{index}");
            receipt.completed_at = index;
            record(&f.0, &receipt).unwrap();
        }
        let service = Service::at(f.0.clone());
        let snapshot = wait(&service, |s| s.loaded);
        assert_eq!(snapshot.aggregate.sessions, 105);
        assert_eq!(snapshot.aggregate.attempts, 105);
        assert_eq!(snapshot.receipts.iter().take(100).count(), 100);
        assert_eq!(snapshot.receipts[0].completed_at, 104);
        assert_eq!(snapshot.receipts.last().unwrap().completed_at, 0);
    }
    #[test]
    fn receipt_identity_corruption_and_oversize_are_reported() {
        let f = Fixture::new();
        let r = complete(Kind::Note, Task::Imitate, 1, "bad", false);
        record(&f.0, &r).unwrap();
        let dir = f.0.join("training-receipts");
        fs::rename(
            dir.join(receipt_name(&r.session_id)),
            dir.join(format!("{}.json", "0".repeat(64))),
        )
        .unwrap();
        assert!(load_receipts(&f.0).is_err());
        fs::write(
            dir.join(format!("{}.json", "0".repeat(64))),
            vec![b' '; 16385],
        )
        .unwrap();
        assert!(load_receipts(&f.0).is_err());
    }
}

/// Import only schemas the native store can read, including its v1 upgrade.
pub(crate) fn import_preferences(source: &Value, directory: &Path) -> Result<()> {
    let doc = source.as_object().context("Invalid training preference document")?;
    ensure!(doc.len() == 2 && source["formatVersion"] == 1, "Unsupported training preferences");
    let mut raw = source["preferences"].clone();
    if raw["formatVersion"] == 1 {
        let keys = ["formatVersion", "range", "notation", "taskMode", "direction", "intervalSizes", "chordDegrees"];
        let old = raw.as_object().context("Invalid legacy preferences")?;
        ensure!(old.len() == keys.len() && keys.iter().all(|k| old.contains_key(*k)), "Invalid legacy preferences");
        let mut upgraded = serde_json::to_value(Preferences::default())?;
        for key in keys.into_iter().filter(|k| *k != "formatVersion") { upgraded[key] = raw[key].clone(); }
        raw = upgraded;
    }
    let prefs: Preferences = serde_json::from_value(raw)?;
    save_preferences(directory, &prefs)
}
pub(crate) fn import_controls(directory: &Path, controls: &Controls) -> Result<()> {
    save_controls(directory, controls)
}

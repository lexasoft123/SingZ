//! App-wide metronome view/preferences. Song opens may replace the audio
//! preferences, while grid visibility belongs to this durable app preference.
use crate::beat::Metronome;
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};

const LIMIT: u64 = 64 * 1024;
const VERSION: u64 = 1;
const NAME: &str = "metronome.json";
static SERIAL: AtomicU64 = AtomicU64::new(1);

fn validate(met: &Metronome) -> Result<()> {
    ensure!(
        met.count_in_bars <= 2 && met.volume.is_finite() && (0. ..=1.).contains(&met.volume),
        "Invalid metronome preferences"
    );
    Ok(())
}

fn preferences(raw: &Value) -> Result<Metronome> {
    ensure!(raw.is_object(), "Invalid metronome preference document");
    ensure!(
        raw.get("version").and_then(Value::as_u64) == Some(VERSION),
        "Unsupported metronome preference version"
    );
    // Missing known fields retain the source's defaults for older preferences.
    // An existing native document with invalid values is not silently repaired.
    for key in ["click", "accent", "grid"] {
        ensure!(
            raw.get(key).is_none_or(Value::is_boolean),
            "Invalid saved metronome {key} preference"
        );
    }
    ensure!(
        raw.get("countInBars")
            .is_none_or(|value| value.as_u64().is_some_and(|n| n <= 2)),
        "Invalid saved metronome count-in"
    );
    ensure!(
        raw.get("volume").is_none_or(|value| value
            .as_f64()
            .is_some_and(|n| n.is_finite() && (0. ..=1.).contains(&n))),
        "Invalid saved metronome loudness"
    );
    let met = Metronome::sanitize(raw);
    validate(&met)?;
    Ok(met)
}

struct Document {
    raw: Value,
    bytes: Vec<u8>,
}
fn ordinary(path: &Path) -> Result<()> {
    ensure!(
        fs::symlink_metadata(path)?.is_file(),
        "Metronome preferences must be an ordinary file"
    );
    Ok(())
}
fn read_document(dir: &Path) -> Result<Option<Document>> {
    let path = dir.join(NAME);
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            ensure!(
                meta.is_file(),
                "Metronome preferences must be an ordinary file"
            );
            ensure!(
                meta.len() > 0 && meta.len() <= LIMIT,
                "Metronome preferences are empty or too large"
            );
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    let file = File::open(&path).context("Cannot read metronome preferences")?;
    ensure!(
        file.metadata()?.is_file(),
        "Metronome preferences must be an ordinary file"
    );
    ordinary(&path)?;
    let mut bytes = vec![];
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        !bytes.is_empty() && bytes.len() as u64 <= LIMIT,
        "Metronome preferences are empty or too large"
    );
    let raw: Value = serde_json::from_slice(&bytes).context("Invalid metronome preference JSON")?;
    preferences(&raw)?;
    Ok(Some(Document { raw, bytes }))
}

/// `dir` is the app-owned directory returned by audio_devices::directory().
/// Missing preferences are defaults; existing invalid/future data is an error.
pub fn load(dir: &Path) -> Result<Metronome> {
    read_document(dir)?.map_or_else(|| Ok(Metronome::default()), |doc| preferences(&doc.raw))
}

struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
fn lease(dir: &Path) -> Result<crate::file_lease::Lease> {
    let path = dir.join(".metronome.lock");
    match fs::symlink_metadata(&path) {
        Ok(meta) => ensure!(
            meta.is_file(),
            "Metronome preference lease must be an ordinary file"
        ),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {}
        Err(e) => return Err(e.into()),
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let file = options.open(&path)?;
    ensure!(
        file.metadata()?.is_file(),
        "Metronome preference lease must be an ordinary file"
    );
    ordinary(&path)?;
    crate::file_lease::Lease::acquire(file)
        .context("Metronome preferences are being changed by another app")
}

/// Keep unknown fields in a known-version document; refuse corrupt/future data.
/// The worker calls this after the native audio update is accepted.
pub fn retain(dir: &Path, met: &Metronome) -> Result<()> {
    retain_before_publish(dir, met, || Ok(()))
}
fn retain_before_publish(
    dir: &Path,
    met: &Metronome,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<()> {
    validate(met)?;
    fs::create_dir_all(dir)?;
    let _lease = lease(dir)?;
    let existing = read_document(dir)?;
    let mut raw = existing
        .as_ref()
        .map_or_else(|| json!({"version":VERSION}), |doc| doc.raw.clone());
    let object = raw
        .as_object_mut()
        .context("Invalid metronome preference document")?;
    object.extend(serde_json::to_value(met)?.as_object().unwrap().clone());
    let mut bytes = serde_json::to_vec_pretty(&raw)?;
    bytes.push(b'\n');
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Metronome preferences are too large"
    );
    let pending_path = dir.join(format!(
        ".metronome-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&pending_path)?;
    // Only remove a temporary that this call actually created.
    let pending = Pending(pending_path);
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    before_publish()?;
    // A non-cooperating writer may not take our advisory lease. Refuse a
    // detected edit instead of publishing a patch based on an obsolete document.
    let current = read_document(dir)?;
    ensure!(
        current.as_ref().map(|doc| &doc.bytes) == existing.as_ref().map(|doc| &doc.bytes),
        "Metronome preferences changed while they were being saved"
    );
    crate::project_store::replace(&pending.0, &dir.join(NAME))?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Directory(PathBuf);
    impl Directory {
        fn new() -> Self {
            let stamp = std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let dir = std::env::temp_dir().join(format!(
                "singz-met-prefs-{}-{stamp}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&dir).unwrap();
            Self(dir)
        }
        fn file(&self) -> PathBuf {
            self.0.join(NAME)
        }
    }
    impl Drop for Directory {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn sample() -> Metronome {
        Metronome {
            click: true,
            count_in_bars: 2,
            volume: 0.42,
            accent: false,
            grid: true,
        }
    }
    fn parts(dir: &Path) -> usize {
        fs::read_dir(dir)
            .unwrap()
            .filter_map(Result::ok)
            .filter(|e| e.file_name().to_string_lossy().ends_with(".part"))
            .count()
    }
    #[test]
    fn missing_defaults_and_global_grid_survive_fresh_loads() {
        let dir = Directory::new();
        assert_eq!(load(&dir.0).unwrap(), Metronome::default());
        assert!(!dir.file().exists());
        retain(&dir.0, &sample()).unwrap();
        assert_eq!(load(&dir.0).unwrap(), sample());
        assert_eq!(load(&dir.0.clone()).unwrap(), sample());
        assert_eq!(parts(&dir.0), 0);
        let raw: Value = serde_json::from_slice(&fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(raw["version"], VERSION);
        assert_eq!(raw["grid"], true);
    }
    #[test]
    fn known_version_keeps_unknown_fields_and_defaults_missing_fields() {
        let dir = Directory::new();
        fs::write(dir.file(), r#"{"version":1,"grid":true,"future":{"large":123456789012345678901234567890,"keep":[1,"two"]}}"#).unwrap();
        assert_eq!(
            load(&dir.0).unwrap(),
            Metronome {
                grid: true,
                ..Default::default()
            }
        );
        let old: Value = serde_json::from_slice(&fs::read(dir.file()).unwrap()).unwrap();
        retain(&dir.0, &sample()).unwrap();
        let new: Value = serde_json::from_slice(&fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(new["future"], old["future"]);
        assert_eq!(load(&dir.0).unwrap(), sample());
    }
    #[test]
    fn corrupt_future_and_oversized_existing_documents_are_never_overwritten() {
        let dir = Directory::new();
        for bytes in [
            b"broken".to_vec(),
            b"".to_vec(),
            b"[]".to_vec(),
            br#"{"version":2,"grid":true}"#.to_vec(),
            br#"{"grid":true}"#.to_vec(),
            br#"{"version":1,"grid":"true"}"#.to_vec(),
            br#"{"version":1,"volume":1.1}"#.to_vec(),
            br#"{"version":1,"countInBars":3}"#.to_vec(),
            br#"{"version":1,"accent":null}"#.to_vec(),
            vec![b' '; LIMIT as usize + 1],
        ] {
            fs::write(dir.file(), &bytes).unwrap();
            assert!(load(&dir.0).is_err());
            assert!(retain(&dir.0, &sample()).is_err());
            assert_eq!(fs::read(dir.file()).unwrap(), bytes);
            assert_eq!(parts(&dir.0), 0);
        }
        fs::remove_file(dir.file()).unwrap();
        fs::create_dir(dir.file()).unwrap();
        assert!(load(&dir.0).is_err());
        assert!(retain(&dir.0, &sample()).is_err());
        assert!(dir.file().is_dir());
    }
    #[test]
    fn invalid_update_or_live_lease_does_not_change_saved_preferences() {
        let dir = Directory::new();
        retain(&dir.0, &sample()).unwrap();
        let bytes = fs::read(dir.file()).unwrap();
        let mut invalid = sample();
        invalid.volume = f64::NAN;
        assert!(retain(&dir.0, &invalid).is_err());
        invalid = sample();
        invalid.count_in_bars = 3;
        assert!(retain(&dir.0, &invalid).is_err());
        let lease = lease(&dir.0).unwrap();
        assert!(retain(&dir.0, &Metronome::default()).is_err());
        assert_eq!(fs::read(dir.file()).unwrap(), bytes);
        drop(lease);
        retain(&dir.0, &Metronome::default()).unwrap();
        assert_eq!(load(&dir.0).unwrap(), Metronome::default());
    }
    #[test]
    fn external_edit_before_publication_survives_and_pending_file_is_removed() {
        let dir = Directory::new();
        retain(&dir.0, &sample()).unwrap();
        let external = br#"{"version":1,"grid":false,"external":"preserve"}"#;
        let result = retain_before_publish(&dir.0, &Metronome::default(), || {
            fs::write(dir.file(), external)?;
            Ok(())
        });
        assert!(result.unwrap_err().to_string().contains("changed"));
        assert_eq!(fs::read(dir.file()).unwrap(), external);
        assert_eq!(parts(&dir.0), 0);
    }
    #[test]
    fn concurrent_readers_observe_complete_documents_from_serialized_writers() {
        use std::sync::{
            Arc, Barrier,
            atomic::{AtomicBool, AtomicUsize},
        };
        let dir = Directory::new();
        fs::write(dir.file(), br#"{"version":1,"future":{"keep":true}}"#).unwrap();
        let a = sample();
        let b = Metronome {
            click: false,
            count_in_bars: 1,
            volume: 0.8,
            accent: true,
            grid: false,
        };
        let gate = Arc::new(Barrier::new(3));
        let ready = Arc::new(AtomicBool::new(false));
        let writers = Arc::new(AtomicUsize::new(2));
        struct WriterDone(Arc<AtomicUsize>);
        impl Drop for WriterDone {
            fn drop(&mut self) {
                self.0.fetch_sub(1, Ordering::AcqRel);
            }
        }
        std::thread::scope(|scope| {
            for met in [&a, &b] {
                let gate = gate.clone();
                let ready = ready.clone();
                let writers = writers.clone();
                let path = &dir.0;
                scope.spawn(move || {
                    let _done = WriterDone(writers);
                    gate.wait();
                    while !ready.load(Ordering::Acquire) {
                        std::thread::yield_now();
                    }
                    for _ in 0..8 {
                        let deadline =
                            std::time::Instant::now() + std::time::Duration::from_secs(10);
                        loop {
                            match retain(path, met) {
                                Ok(()) => break,
                                Err(error)
                                    if error
                                        .to_string()
                                        .contains("being changed by another app") =>
                                {
                                    assert!(
                                        std::time::Instant::now() < deadline,
                                        "Preference writer did not acquire the released lease"
                                    );
                                    std::thread::yield_now();
                                }
                                Err(error) => panic!("Preference writer failed: {error:#}"),
                            }
                        }
                    }
                });
            }
            let path = &dir.0;
            let a = &a;
            let b = &b;
            let gate = gate.clone();
            let ready = ready.clone();
            let writers = writers.clone();
            scope.spawn(move || {
                gate.wait();
                let initial = load(path);
                ready.store(true, Ordering::Release);
                assert_eq!(initial.unwrap(), Metronome::default());
                while writers.load(Ordering::Acquire) != 0 {
                    let met = load(path).unwrap();
                    assert!(met == Metronome::default() || met == *a || met == *b);
                }
            });
        });
        let document: Value = serde_json::from_slice(&fs::read(dir.file()).unwrap()).unwrap();
        assert_eq!(document["future"]["keep"], true);
        assert_eq!(parts(&dir.0), 0);
    }
    #[cfg(unix)]
    #[test]
    fn linked_preferences_or_lease_are_refused_without_touching_the_target() {
        use std::os::unix::fs::symlink;
        let dir = Directory::new();
        let target = dir.0.join("foreign.json");
        let bytes = br#"{"version":1,"grid":true}"#;
        fs::write(&target, bytes).unwrap();
        symlink(&target, dir.file()).unwrap();
        assert!(load(&dir.0).is_err());
        assert!(retain(&dir.0, &sample()).is_err());
        assert_eq!(fs::read(&target).unwrap(), bytes);
        fs::remove_file(dir.file()).unwrap();
        fs::remove_file(dir.0.join(".metronome.lock")).unwrap();
        symlink(&target, dir.0.join(".metronome.lock")).unwrap();
        assert!(retain(&dir.0, &sample()).is_err());
        assert_eq!(fs::read(&target).unwrap(), bytes);
    }
}

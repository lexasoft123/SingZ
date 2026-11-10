//! Bundled desktop release highlights and app-owned durable acknowledgement.
//! Mirrors shared/release-highlights.ts and main/whats-new.ts without Node.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    cmp::Ordering,
    collections::HashMap,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicU64, Ordering as AtomicOrdering},
    },
};

pub const CURRENT_VERSION: &str = "0.26.7";
const CONTENT: &str = include_str!("../../../src/shared/release-content.json");
const NAME: &str = "release-highlights.json";
const LIMIT: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Icon {
    News,
    Export,
    Mic,
    Controls,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Highlight {
    pub id: String,
    pub icon: Icon,
    pub title: String,
    pub description: String,
    pub desktop_only: bool,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Entry {
    pub version: String,
    pub highlights: Vec<Highlight>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct ReleaseNotes {
    pub version: String,
    pub entries: Vec<Entry>,
    pub url: String,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct State {
    pub seen: Option<String>,
}
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub loaded: bool,
    pub state: State,
    pub error: Option<String>,
    pub revision: u64,
}
enum Request {
    Acknowledge,
    Quit,
}
pub struct Service {
    requests: std::sync::mpsc::SyncSender<Request>,
    view: std::sync::Arc<std::sync::Mutex<std::sync::Arc<Snapshot>>>,
    worker: Option<std::thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(config_dir: PathBuf) -> Self {
        // Capture whether this installation predates the feature before any
        // later native service can create a preference marker for this launch.
        // Only these bounded metadata probes run here; contents and writes are
        // exclusively handled by the worker below.
        let returning = returning_install(&config_dir);
        let (requests, received) = std::sync::mpsc::sync_channel(16);
        let view = std::sync::Arc::new(std::sync::Mutex::new(std::sync::Arc::new(
            Snapshot::default(),
        )));
        let output = view.clone();
        let worker = std::thread::spawn(move || {
            let mut snapshot = Snapshot::default();
            let mut publish = |result: Result<State>| {
                snapshot.loaded = true;
                snapshot.revision += 1;
                match result {
                    Ok(state) => {
                        snapshot.state = state;
                        snapshot.error = None;
                    }
                    Err(error) => snapshot.error = Some(format!("{error:#}")),
                }
                *output.lock().unwrap_or_else(|e| e.into_inner()) =
                    std::sync::Arc::new(snapshot.clone());
            };
            publish(load(&config_dir, CURRENT_VERSION, returning));
            while let Ok(request) = received.recv() {
                match request {
                    Request::Acknowledge => {
                        publish(acknowledge(&config_dir, CURRENT_VERSION, CURRENT_VERSION))
                    }
                    Request::Quit => break,
                }
            }
        });
        Self {
            requests,
            view,
            worker: Some(worker),
        }
    }
    pub fn snapshot(&self) -> std::sync::Arc<Snapshot> {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn acknowledge(&self) -> Result<()> {
        self.requests
            .try_send(Request::Acknowledge)
            .context("Release acknowledgement queue is full")
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        let _ = self.requests.send(Request::Quit);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn returning_install(dir: &Path) -> bool {
    [
        "settings.json",
        "audio.json",
        "training-preferences.json",
        "training-controls.json",
        "quick-start.json",
        "metronome.json",
        "library.json",
        NAME,
    ]
    .iter()
    .any(|file| fs::symlink_metadata(dir.join(file)).is_ok())
}
#[derive(Deserialize)]
struct Content {
    version: String,
    releases: Vec<BundledEntry>,
}
#[derive(Deserialize)]
struct BundledEntry {
    version: String,
    highlights: Vec<BundledHighlight>,
}
#[derive(Deserialize)]
struct BundledHighlight {
    id: String,
    icon: Icon,
    platforms: Vec<String>,
    text: HashMap<String, Text>,
}
#[derive(Deserialize)]
struct Text {
    title: String,
    description: String,
}
fn content() -> &'static Content {
    static DATA: OnceLock<Content> = OnceLock::new();
    DATA.get_or_init(|| serde_json::from_str(CONTENT).expect("Invalid bundled release content"))
}
/// Resolve presentation copy for the same release/highlight identities. Locale
/// changes do not acknowledge releases or alter the current selection.
pub fn localized(notes: &ReleaseNotes, language: &str) -> ReleaseNotes {
    let language = locale(language);
    let mut translated = notes.clone();
    for entry in &mut translated.entries {
        let Some(source) = content()
            .releases
            .iter()
            .find(|r| r.version == entry.version)
        else {
            continue;
        };
        for item in &mut entry.highlights {
            if let Some(text) = source
                .highlights
                .iter()
                .find(|h| h.id == item.id)
                .and_then(|h| h.text.get(language).or_else(|| h.text.get("en")))
            {
                item.title = text.title.clone();
                item.description = text.description.clone();
            }
        }
    }
    translated
}
pub fn valid_version(version: &str) -> bool {
    let parts: Vec<_> = version.split('.').collect();
    parts.len() == 3
        && parts
            .iter()
            .all(|p| !p.is_empty() && p.bytes().all(|c| c.is_ascii_digit()))
}
fn compare(a: &str, b: &str) -> Ordering {
    // JavaScript Number comparison deliberately permits leading zeroes and
    // rounds oversized components; integer parsing would change that contract.
    for (left, right) in a.split('.').zip(b.split('.')) {
        let left = left.parse::<f64>().unwrap_or(f64::INFINITY);
        let right = right.parse::<f64>().unwrap_or(f64::INFINITY);
        let difference = left - right;
        if !difference.is_nan() && difference != 0. {
            return if difference > 0. {
                Ordering::Greater
            } else {
                Ordering::Less
            };
        }
    }
    Ordering::Equal
}
fn locale(tag: &str) -> &'static str {
    let normalized = tag.to_ascii_lowercase().replace('_', "-");
    let parts: Vec<_> = normalized.split('-').collect();
    match parts[0] {
        "ru" => "ru",
        "hi" => "hi",
        "ja" => "ja",
        "ko" => "ko",
        "th" => "th",
        "id" | "in" => "id",
        "vi" => "vi",
        "fil" | "tl" => "fil",
        "ms" => "ms",
        "tr" => "tr",
        "zh" => {
            if parts.contains(&"hant") {
                return "zh-TW";
            }
            if parts.contains(&"hans") {
                return "zh-CN";
            }
            match parts.iter().skip(1).find(|p| p.len() == 2).copied() {
                Some("tw" | "hk" | "mo") => "zh-TW",
                None | Some("cn" | "sg") => "zh-CN",
                _ => "en",
            }
        }
        _ => "en",
    }
}
/// `previous=None` reopens only the current release. Automatic startup passes
/// the saved acknowledgement to include all bundled skipped desktop releases.
pub fn notes(current: &str, previous: Option<&str>, language: &str) -> Option<ReleaseNotes> {
    if !valid_version(current) {
        return None;
    }
    let seen = previous.filter(|s| valid_version(s));
    let language = locale(language);
    let mut releases: Vec<_> = content()
        .releases
        .iter()
        .filter(|release| {
            compare(&release.version, current) != Ordering::Greater
                && seen.map_or(release.version == current, |seen| {
                    compare(&release.version, seen) == Ordering::Greater
                })
        })
        .collect();
    releases.sort_by(|a, b| compare(&b.version, &a.version));
    let entries: Vec<_> = releases
        .into_iter()
        .filter_map(|release| {
            let highlights: Vec<_> = release
                .highlights
                .iter()
                .filter(|item| item.platforms.iter().any(|p| p == "desktop"))
                .filter_map(|item| {
                    let text = item.text.get(language).or_else(|| item.text.get("en"))?;
                    Some(Highlight {
                        id: item.id.clone(),
                        icon: item.icon,
                        title: text.title.clone(),
                        description: text.description.clone(),
                        desktop_only: false,
                    })
                })
                .collect();
            (!highlights.is_empty()).then(|| Entry {
                version: release.version.clone(),
                highlights,
            })
        })
        .collect();
    (!entries.is_empty()).then(|| ReleaseNotes {
        version: current.into(),
        entries,
        url: format!("https://github.com/lexasoft123/SingZ/releases/tag/v{current}"),
    })
}
struct Document {
    raw: Value,
    bytes: Option<Vec<u8>>,
}
fn read(dir: &Path) -> Result<Document> {
    let path = dir.join(NAME);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            return Ok(Document {
                raw: json!({"version":1}),
                bytes: None,
            });
        }
        Err(e) => return Err(e.into()),
    };
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() > 0 && meta.len() <= LIMIT,
        "Release acknowledgement must be an ordinary bounded file"
    );
    let file = File::open(&path)?;
    let opened = file.metadata()?;
    ensure!(
        same_file(&meta, &opened),
        "Release acknowledgement changed while reading"
    );
    let mut bytes = vec![];
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Release acknowledgement is too large"
    );
    let after = fs::symlink_metadata(&path)?;
    ensure!(
        !after.file_type().is_symlink() && same_file(&meta, &after),
        "Release acknowledgement changed while reading"
    );
    let raw: Value =
        serde_json::from_slice(&bytes).context("Invalid release acknowledgement JSON")?;
    ensure!(
        raw.is_object() && raw.get("version").is_none_or(|v| v.as_u64() == Some(1)),
        "Unsupported release acknowledgement document"
    );
    ensure!(
        raw.get("releaseNotesSeen")
            .is_none_or(|v| v.is_null() || v.is_string()),
        "Invalid release acknowledgement version"
    );
    Ok(Document {
        raw,
        bytes: Some(bytes),
    })
}
fn same_file(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    let same =
        a.is_file() && b.is_file() && a.len() == b.len() && a.modified().ok() == b.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        same && a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        same
    }
}
fn state(document: &Document) -> State {
    State {
        seen: document.raw["releaseNotesSeen"]
            .as_str()
            .filter(|s| !s.is_empty())
            .map(str::to_owned),
    }
}
fn lease(dir: &Path) -> Result<crate::file_lease::Lease> {
    let path = dir.join(".release-highlights.lock");
    let file = match OpenOptions::new()
        .read(true)
        .write(true)
        .create_new(true)
        .open(&path)
    {
        Ok(file) => file,
        Err(error) if error.kind() == std::io::ErrorKind::AlreadyExists => {
            let meta = fs::symlink_metadata(&path)?;
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Invalid release acknowledgement lock"
            );
            let file = OpenOptions::new().read(true).write(true).open(&path)?;
            ensure!(
                same_file(&meta, &file.metadata()?)
                    && !fs::symlink_metadata(&path)?.file_type().is_symlink(),
                "Release acknowledgement lock changed"
            );
            file
        }
        Err(error) => return Err(error.into()),
    };
    crate::file_lease::Lease::acquire(file)
        .context("Release acknowledgement is already being updated")
}
fn publish(dir: &Path, mut document: Document, seen: &str) -> Result<State> {
    document.raw["version"] = json!(1);
    document.raw["releaseNotesSeen"] = json!(seen);
    let bytes = serde_json::to_vec_pretty(&document.raw)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Release acknowledgement is too large"
    );
    let temporary = dir.join(format!(
        ".release-highlights-{}-{}.tmp",
        std::process::id(),
        NEXT.fetch_add(1, AtomicOrdering::Relaxed)
    ));
    struct Pending(PathBuf);
    impl Drop for Pending {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let pending = Pending(temporary);
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending.0)?;
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    ensure!(
        read(dir)?.bytes == document.bytes,
        "Release acknowledgement changed outside this app"
    );
    if document.bytes.is_some() {
        crate::project_store::replace(&pending.0, &dir.join(NAME))?;
    } else {
        fs::hard_link(&pending.0, dir.join(NAME))
            .context("Release acknowledgement appeared while saving")?;
    }
    #[cfg(unix)]
    let _ = File::open(dir).and_then(|file| file.sync_all());
    Ok(State {
        seen: Some(seen.into()),
    })
}
/// Capture `returning` before creating native preferences for this launch.
/// Fresh installs establish a baseline; pre-feature installs show current once.
pub fn load(config_dir: &Path, current: &str, returning: bool) -> Result<State> {
    fs::create_dir_all(config_dir)?;
    let dir = config_dir.canonicalize()?;
    let _lease = lease(&dir)?;
    let document = read(&dir)?;
    let previous = state(&document);
    if !returning && previous.seen.is_none() {
        return publish(&dir, document, current);
    }
    Ok(previous)
}
/// Only the running release's available notes may be acknowledged, and an
/// acknowledgement from a newer application version never moves backwards.
pub fn acknowledge(config_dir: &Path, current: &str, seen: &str) -> Result<State> {
    ensure!(
        seen == current && notes(seen, None, "en").is_some(),
        "Release notes are unavailable"
    );
    fs::create_dir_all(config_dir)?;
    let dir = config_dir.canonicalize()?;
    let _lease = lease(&dir)?;
    let document = read(&dir)?;
    let previous = state(&document);
    if previous
        .seen
        .as_deref()
        .filter(|s| valid_version(s))
        .is_none_or(|old| compare(seen, old) == Ordering::Greater)
    {
        publish(&dir, document, seen)
    } else {
        Ok(previous)
    }
}

#[cfg(test)]
#[path = "release_highlights_tests.rs"]
mod tests;

#[cfg(test)]
mod localization_tests {
    use super::*;
    #[test]
    fn open_release_relocalization_retains_exact_selection_and_ids() {
        let mut selected = notes(CURRENT_VERSION, Some("0.26.1"), "en").unwrap();
        selected.entries.truncate(1);
        selected.entries[0].highlights.truncate(1);
        let original = selected.clone();
        let translated = localized(&selected, "ru");
        assert_eq!(
            selected, original,
            "Relocalization mutated its source selection"
        );
        assert_eq!(translated.version, original.version);
        assert_eq!(translated.url, original.url);
        assert_eq!(translated.entries.len(), 1);
        assert_eq!(translated.entries[0].version, original.entries[0].version);
        let item = &translated.entries[0].highlights[0];
        assert_eq!(item.id, original.entries[0].highlights[0].id);
        assert_eq!(item.icon, original.entries[0].highlights[0].icon);
        assert_eq!(
            item.desktop_only,
            original.entries[0].highlights[0].desktop_only
        );
        let expected = notes(CURRENT_VERSION, Some("0.26.1"), "ru").unwrap();
        assert_eq!(item, &expected.entries[0].highlights[0]);
        assert_ne!(item.title, original.entries[0].highlights[0].title);
        assert_eq!(localized(&translated, "en"), original);
    }
}

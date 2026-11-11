//! First-run read-only Electron adoption. Credentials and dirty-ledger adoption
//! belong to C-41 and are intentionally not inspected or recorded here.
#[path = "migrate_plan.rs"]
mod plan;
#[path = "migrate_source.rs"]
mod source;
use anyhow::{Context, Result, ensure};
use plan::{Entry, Outcome};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File, OpenOptions},
    io::Write,
    path::{Path, PathBuf},
    sync::{
        OnceLock,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
};
static SUMMARY: AtomicUsize = AtomicUsize::new(0);
static DEFERRED_AUDIO: OnceLock<(PathBuf, Vec<PathBuf>)> = OnceLock::new();
static AUDIO_STARTED: AtomicBool = AtomicBool::new(false);
static SERIAL: AtomicU64 = AtomicU64::new(0);
const ITEMS: &[&str] = &[
    "library",
    "language",
    "release-notes",
    "qwen-offer",
    "window",
    "training-preferences",
    "training-receipts",
    "audio",
    "metronome",
    "karaoke",
    "training-controls",
];
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
struct Record {
    version: u8,
    profile: String,
    items: BTreeMap<String, Entry>,
    /// This Electron-only preference currently has no native feature/store.
    /// Keep the boolean for its future owner; never copy arbitrary settings.
    #[serde(default, skip_serializing_if = "Option::is_none")]
    qwen_offer_dismissed: Option<bool>,
    #[serde(default, skip_serializing_if = "is_zero")]
    library_attempts: u8,
}
fn is_zero(value: &u8) -> bool {
    *value == 0
}
impl Record {
    fn new(profile: &Path) -> Self {
        Self {
            version: 1,
            profile: profile
                .file_name()
                .unwrap_or_default()
                .to_string_lossy()
                .into(),
            items: BTreeMap::new(),
            qwen_offer_dismissed: None,
            library_attempts: 0,
        }
    }
}
fn publish(path: &Path, raw: &impl Serialize) -> Result<()> {
    let directory = path.parent().context("Missing native config directory")?;
    let temp = directory.join(format!(
        ".migration-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let result = (|| -> Result<()> {
        let mut options = OpenOptions::new();
        options.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temp)?;
        file.write_all(&serde_json::to_vec_pretty(raw)?)?;
        file.sync_all()?;
        drop(file);
        crate::project_store::replace(&temp, path)?;
        #[cfg(unix)]
        File::open(directory)?.sync_all()?;
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result
}
/// No raw source value/error is persisted: Electron settings can contain tokens.
fn apply(
    record: &mut Record,
    name: &str,
    native: bool,
    valid: Option<bool>,
    writer: impl FnOnce() -> Result<()>,
) {
    let Some(mut entry) = plan::decide(record.items.get(name), native, valid) else {
        return;
    };
    if entry.outcome == Outcome::Import && writer().is_err() {
        entry = Entry::new(Outcome::RetryLater, "native-store-rejected-or-unavailable");
    }
    record.items.insert(name.into(), entry);
}
fn native(dir: &Path, file: &str) -> Result<Value> {
    Ok(source::read(&dir.join(file), 4 * 1024 * 1024)?.unwrap_or_else(|| json!({})))
}
fn nondefault(dir: &Path, file: &str, key: Option<&str>, default: &Value) -> bool {
    match native(dir, file) {
        Err(_) => true, // Preserve corrupt/future native documents too.
        Ok(raw) => {
            let value = key.map_or(&raw, |key| &raw[key]);
            !value.is_null() && value != &json!({}) && value != default
        }
    }
}
fn fields_nondefault(dir: &Path, file: &str, defaults: &Value) -> bool {
    match native(dir, file) {
        Err(_) => true,
        Ok(raw) => defaults.as_object().unwrap().iter().any(|(key, default)| {
            raw.get(key)
                .is_some_and(|value| value != default && !value.is_null())
        }),
    }
}
fn native_exists(dir: &Path, file: &str) -> bool {
    fs::symlink_metadata(dir.join(file)).is_ok()
}
fn safe_destination(config: &Path, profiles: &[PathBuf]) -> Result<()> {
    // Refuse aliases into any Electron profile, including an override set wrong.
    let mut ancestor = config;
    while !ancestor.exists() {
        ancestor = ancestor.parent().context("Missing config ancestor")?;
    }
    let projected = ancestor
        .canonicalize()?
        .join(config.strip_prefix(ancestor)?);
    for profile in profiles {
        ensure!(
            !config.starts_with(profile) && !profile.starts_with(config),
            "Native config overlaps Electron profile"
        );
        if let Ok(real) = profile.canonicalize() {
            ensure!(
                !projected.starts_with(&real) && !real.starts_with(&projected),
                "Native config overlaps Electron profile"
            );
        }
    }
    Ok(())
}
fn run_fresh(
    config: &Path,
    profiles: &[PathBuf],
    inventory: &impl Fn() -> Result<crate::audio_devices::Inventory>,
) -> Result<(Option<Record>, usize)> {
    #[cfg(test)]
    if std::env::var_os("C40_NEGATIVE_CONTROL").is_some() {
        return Ok((None, 0));
    }
    safe_destination(config, profiles)?;
    fs::create_dir_all(config)?;
    source::ordinary_path(config)?;
    // Store writers own these paths. Reject pre-existing indirections before
    // invoking them; in particular a receipts directory link must never send a
    // native temporary file into Electron's profile.
    for name in [
        ".migration.lock",
        "library.lock",
        ".audio.lock",
        ".language.lock",
        ".release-highlights.lock",
        ".metronome.lock",
        "training-receipts",
    ] {
        let path = config.join(name);
        if fs::symlink_metadata(&path).is_ok() {
            source::ordinary_path(&path)?;
        }
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
        options.mode(0o600);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let lock = options.open(config.join(".migration.lock"))?;
    let _lease = crate::file_lease::Lease::acquire(lock)?;
    // Existing record pins the profile, including retries, so a later dev profile
    // cannot replace the originally chosen desktop settings.
    let old: Option<Record> = source::read(&config.join("migration.json"), 4 * 1024 * 1024)?
        .map(serde_json::from_value)
        .transpose()?;
    if let Some(old) = &old {
        ensure!(old.version == 1, "Unknown migration version");
        if old.profile.is_empty()
            || ITEMS
                .iter()
                .all(|key| old.items.get(*key).is_some_and(Entry::terminal))
        {
            return Ok((Some(old.clone()), 0));
        }
    }
    let profile = if let Some(old) = &old {
        profiles.iter().find(|p| {
            p.file_name()
                .is_some_and(|name| name == old.profile.as_str())
        })
    } else {
        let mut found = None;
        for candidate in profiles {
            if source::profile_exists(candidate)? {
                found = Some(candidate);
                break;
            }
        }
        found
    };
    let Some(profile) = profile else {
        if let Some(old) = old {
            return Ok((Some(old), 0));
        }
        // Absence is a first-run outcome too: do not import a profile that only
        // appears after the singer has already started using native settings.
        fs::create_dir_all(config)?;
        source::ordinary_path(config)?;
        let mut record = Record::new(Path::new(""));
        for &key in ITEMS {
            record.items.insert(
                key.into(),
                Entry::new(Outcome::SkipInvalid, "desktop-profile-absent"),
            );
        }
        publish(&config.join("migration.json"), &record)?;
        return Ok((Some(record), 0));
    };
    source::ordinary_path(profile)?;
    let previous = old.clone();
    let mut record = previous.clone().unwrap_or_else(|| Record::new(profile));
    ensure!(
        record.version == 1
            && record.profile == profile.file_name().unwrap_or_default().to_string_lossy(),
        "Migration profile changed"
    );
    let settings = source::read(&profile.join("settings.json"), 4 * 1024 * 1024);
    let field = |key: &str| -> Option<Value> {
        settings
            .as_ref()
            .ok()
            .and_then(|r| r.as_ref())
            .and_then(|r| r.get(key))
            .cloned()
    };
    let validity = |valid| if settings.is_err() { None } else { Some(valid) };
    let root = field("projectsRoot").and_then(|v| v.as_str().map(PathBuf::from));
    import_library(config, profile, &mut record, root, settings.is_err());
    let language =
        field("language").and_then(|v| v.as_str().and_then(crate::i18n::Language::parse));
    apply(
        &mut record,
        "language",
        nondefault(config, "language.json", Some("language"), &json!("system")),
        validity(language.is_some()),
        || crate::locale_service::import_language(config, language.unwrap()),
    );
    let seen = field("releaseNotesSeen").and_then(|v| v.as_str().map(str::to_owned));
    apply(
        &mut record,
        "release-notes",
        nondefault(
            config,
            "release-highlights.json",
            Some("releaseNotesSeen"),
            &Value::Null,
        ),
        validity(
            seen.as_deref()
                .is_some_and(crate::release_highlights::valid_version),
        ),
        || crate::release_highlights::import_baseline(config, seen.as_deref().unwrap()),
    );
    let dismissed = field("qwenOfferDismissed").and_then(|v| v.as_bool());
    let mut adopted_qwen = false;
    apply(
        &mut record,
        "qwen-offer",
        false,
        validity(dismissed.is_some()),
        || {
            adopted_qwen = true;
            Ok(())
        },
    );
    if adopted_qwen {
        record.qwen_offer_dismissed = dismissed;
    }
    let geometry = source::read(&profile.join("window-state.json"), 16 * 1024);
    let window = geometry
        .as_ref()
        .ok()
        .and_then(|v| v.as_ref())
        .and_then(|v| {
            let width = v["width"].as_f64()?;
            let height = v["height"].as_f64()?;
            (width.is_finite()
                && height.is_finite()
                && width > 0.
                && height > 0.
                && v["maximized"].is_boolean())
            .then_some(crate::desktop_window_state::WindowSnapshot {
                normal: crate::desktop_window_state::Bounds {
                    x: 0.,
                    y: 0.,
                    width,
                    height,
                },
                display_uuid: None,
                maximized: v["maximized"] == true,
            })
        });
    apply(
        &mut record,
        "window",
        native_exists(config, "window-state-native.json"),
        if geometry.is_err() {
            None
        } else {
            Some(window.is_some())
        },
        || {
            let mut store = crate::desktop_window_state::StateStore::load(config);
            store.observe(window.clone().unwrap(), std::time::Instant::now());
            ensure!(store.flush(), "Window import failed");
            Ok(())
        },
    );
    let preferences = source::read(&profile.join("training-preferences.json"), 16 * 1024);
    apply(
        &mut record,
        "training-preferences",
        nondefault(
            config,
            "training-preferences.json",
            Some("preferences"),
            &serde_json::to_value(crate::training_progress::Preferences::default())?,
        ),
        if preferences.is_err() {
            None
        } else {
            Some(preferences.as_ref().unwrap().is_some())
        },
        || {
            crate::training_store::import_preferences(
                preferences.as_ref().unwrap().as_ref().unwrap(),
                config,
            )
        },
    );
    import_receipts(profile, config, &mut record);
    import_handover(profile, config, &mut record, inventory);
    let count = new_imports(previous.as_ref(), &record);
    if previous.as_ref() != Some(&record) {
        publish(&config.join("migration.json"), &record)?;
    }
    Ok((Some(record), count))
}
fn import_receipts(profile: &Path, config: &Path, record: &mut Record) {
    if record
        .items
        .get("training-receipts")
        .is_some_and(Entry::terminal)
    {
        return;
    }
    let result = (|| -> Result<()> {
        let dir = profile.join("training-receipts");
        match fs::symlink_metadata(&dir) {
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
            Err(e) => return Err(e.into()),
            Ok(_) => {}
        }
        source::ordinary_path(&dir)?;
        let mut count = 0;
        for entry in fs::read_dir(dir)? {
            count += 1;
            ensure!(count <= 10_000, "Too many receipts");
            let entry = entry?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if name.starts_with(".tmp-") {
                continue;
            }
            if !(name.len() == 69
                && name.ends_with(".json")
                && name.as_bytes()[..64]
                    .iter()
                    .all(|b| b.is_ascii_hexdigit() && !b.is_ascii_uppercase()))
            {
                continue;
            }
            let key = format!("receipt:{name}");
            if record.items.get(&key).is_some_and(Entry::terminal) {
                continue;
            }
            let result = (|| -> Result<bool> {
                let raw = source::read(&entry.path(), 16 * 1024)?;
                let receipt: crate::training_progress::Completion =
                    serde_json::from_value(raw.context("Missing receipt")?)?;
                receipt.validate()?;
                ensure!(
                    name == format!(
                        "{}.json",
                        crate::project_store::fingerprint(receipt.session_id.as_bytes())
                    ),
                    "Receipt identity mismatch"
                );
                crate::training_store::record(config, &receipt)
            })();
            record.items.insert(
                key,
                match result {
                    Ok(false) => Entry::new(Outcome::Import, "validated-receipt"),
                    Ok(true) => Entry::new(Outcome::KeptNative, "receipt-already-present"),
                    Err(_) => Entry::new(Outcome::RetryLater, "receipt-invalid-or-collision"),
                },
            );
        }
        Ok(())
    })();
    // Individual invalid files remain retryable without blocking other receipts.
    let pending = result.is_err()
        || record
            .items
            .iter()
            .any(|(k, v)| k.starts_with("receipt:") && !v.terminal());
    record.items.insert(
        "training-receipts".into(),
        if pending {
            Entry::new(Outcome::RetryLater, "receipt-source-unavailable-or-invalid")
        } else if record
            .items
            .iter()
            .any(|(k, v)| k.starts_with("receipt:") && v.outcome == Outcome::Import)
        {
            Entry::new(Outcome::Import, "compatible-receipts-only")
        } else if record.items.keys().any(|k| k.starts_with("receipt:")) {
            Entry::new(Outcome::KeptNative, "receipts-already-present")
        } else {
            Entry::new(Outcome::SkipInvalid, "compatible-receipts-absent")
        },
    );
}
fn import_handover(
    profile: &Path,
    config: &Path,
    record: &mut Record,
    inventory: &impl Fn() -> Result<crate::audio_devices::Inventory>,
) {
    let exported = source::read(&profile.join("native-handover.json"), 64 * 1024);
    let keys = ["audio", "metronome", "karaoke", "training-controls"];
    let raw = match &exported {
        Ok(Some(raw)) if raw["formatVersion"] == 1 && raw["product"] == "desktop" => raw,
        _ => {
            let reason = match &exported {
                Err(_) => "handover-unreadable-or-changing",
                Ok(None) => "handover-absent",
                _ => "handover-unsupported-version-or-product",
            };
            for key in keys {
                if record.items.get(key).is_none_or(|e| !e.terminal()) {
                    record.items.insert(
                        key.into(),
                        Entry::new(
                            if exported.is_err() {
                                Outcome::RetryLater
                            } else {
                                Outcome::SkipInvalid
                            },
                            reason,
                        ),
                    );
                }
            }
            return;
        }
    };
    let audio = &raw["audio"];
    apply(
        record,
        "audio",
        fields_nondefault(
            config,
            "audio.json",
            &json!({"outputUid":"","inputUid":"","inputChannel":0,"monitorOutputUid":"","monitorOutputChannels":[0,1],"monitorGainDb":-18,"nativeAudioProvider":crate::audio_devices::Provider::platform_default().as_str()}),
        ),
        Some(audio.is_object()),
        || {
            let devices = inventory()?;
            let mut patch = json!({});
            let output = audio["nativeOutputUid"]
                .as_str()
                .or_else(|| {
                    audio["outputId"]
                        .as_str()
                        .and_then(|s| s.strip_prefix("native:"))
                })
                .unwrap_or_default();
            if devices
                .devices
                .iter()
                .any(|d| d.uid == output && d.outputs > 0)
            {
                let provider = crate::audio_devices::Provider::platform_default();
                if crate::audio_devices::validate_output_uid(provider, output, cfg!(windows))
                    .is_ok()
                {
                    patch["outputUid"] = json!(output);
                }
            }
            // Chromium outputId/inputId are origin-scoped hashes, never native IDs.
            // Monitor and input UIDs are OS IDs and can be matched in this inventory.
            let input = audio["nativeInputUid"].as_str().unwrap_or_default();
            let monitor = audio["nativeMonitorOutputUid"].as_str().unwrap_or_default();
            if let Some(device) = devices
                .devices
                .iter()
                .find(|d| d.uid == input && d.inputs > 0)
            {
                patch["inputUid"] = json!(input);
                patch["inputChannel"] = json!(
                    audio["inputChannel"]
                        .as_u64()
                        .filter(|n| *n < device.inputs as u64)
                        .unwrap_or(0)
                );
            }
            if let Some(device) = devices
                .devices
                .iter()
                .find(|d| d.uid == monitor && d.outputs >= 2)
            {
                let channels = audio["nativeMonitorOutputChannels"].as_array();
                if let Some(c) = channels.filter(|c| {
                    c.len() == 2
                        && c[0] != c[1]
                        && c.iter()
                            .all(|n| n.as_u64().is_some_and(|n| n < device.outputs as u64))
                }) {
                    patch["monitorOutputUid"] = json!(monitor);
                    patch["monitorOutputChannels"] = json!(c);
                }
            }
            if let Some(gain) = audio["monitorGainDb"]
                .as_f64()
                .filter(|n| n.is_finite() && (-60. ..=0.).contains(n))
            {
                patch["monitorGainDb"] = json!(gain);
            }
            // No monitor enable/headphone confirmation, provider change or device probe
            // that opens the microphone is imported.
            crate::audio_devices::import_preferences(config, patch)
        },
    );
    let met = serde_json::from_value::<crate::beat::Metronome>(raw["metronome"].clone()).ok();
    apply(
        record,
        "metronome",
        fields_nondefault(
            config,
            "metronome.json",
            &serde_json::to_value(crate::beat::Metronome::default()).unwrap(),
        ),
        Some(met.is_some()),
        || crate::metronome_store::retain(config, met.as_ref().unwrap()),
    );
    apply(
        record,
        "karaoke",
        nondefault(config, "audio.json", Some("karaoke"), &json!(false)),
        Some(raw["karaoke"].is_boolean()),
        || crate::audio_devices::save_karaoke_at(config, raw["karaoke"] == true).map(|_| ()),
    );
    let mut controls_raw = raw["trainingControls"].clone();
    if let Some(object) = controls_raw.as_object_mut() {
        object.retain(|k, _| {
            [
                "formatVersion",
                "sound",
                "volume",
                "tolerance",
                "focus",
                "program",
            ]
            .contains(&k.as_str())
        });
        if let Some(program) = object.get_mut("program").and_then(Value::as_object_mut) {
            program.retain(|k, _| ["level", "startedAt"].contains(&k.as_str()));
        }
    }
    let controls = serde_json::from_value::<crate::training_store::Controls>(controls_raw).ok();
    apply(
        record,
        "training-controls",
        nondefault(
            config,
            "training-controls.json",
            None,
            &serde_json::to_value(crate::training_store::Controls::default()).unwrap(),
        ),
        Some(controls.is_some()),
        || crate::training_store::import_controls(config, controls.as_ref().unwrap()),
    );
}
pub(crate) fn imported_count() -> usize {
    SUMMARY.load(Ordering::Acquire)
}
pub(crate) fn startup() {
    // Fixture/capture launches must never discover the user's real Electron profile.
    if crate::integration::fixture_mode() || std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some() {
        return;
    }
    let home = PathBuf::from(
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    );
    if !home.is_absolute() {
        return;
    }
    let platform = if cfg!(target_os = "macos") {
        source::Platform::Mac
    } else if cfg!(windows) {
        source::Platform::Windows
    } else {
        source::Platform::Linux
    };
    let appdata = std::env::var_os(if cfg!(windows) {
        "APPDATA"
    } else {
        "XDG_CONFIG_HOME"
    })
    .map(PathBuf::from)
    .filter(|path| path.is_absolute());
    let profiles = source::profiles(platform, &home, appdata.as_deref());
    let config = crate::audio_devices::directory();
    let result = run_initial(&config, &profiles);
    if let Ok((_, count)) = result {
        SUMMARY.fetch_add(count, Ordering::AcqRel);
    }
    let _ = DEFERRED_AUDIO.set((config, profiles));
}
#[cfg(test)]
#[path = "migrate_tests.rs"]
mod tests;

fn run(
    config: &Path,
    profiles: &[PathBuf],
    inventory: &impl Fn() -> Result<crate::audio_devices::Inventory>,
) -> Result<Option<Record>> {
    run_fresh(config, profiles, inventory).map(|(record, _)| record)
}
fn run_initial(config: &Path, profiles: &[PathBuf]) -> Result<(Option<Record>, usize)> {
    run_fresh(config, profiles, &|| {
        anyhow::bail!("Audio migration deferred until first frame")
    })
}
#[cfg(test)]
fn run_before_window(
    config: &Path,
    profiles: &[PathBuf],
    _inventory: &impl Fn() -> Result<crate::audio_devices::Inventory>,
) -> Result<Option<Record>> {
    run_initial(config, profiles).map(|(record, _)| record)
}

fn new_imports(previous: Option<&Record>, record: &Record) -> usize {
    record
        .items
        .iter()
        .filter(|(key, entry)| {
            !key.starts_with("receipt:")
                && entry.outcome == Outcome::Import
                && previous
                    .and_then(|old| old.items.get(*key))
                    .is_none_or(|old| old.outcome != Outcome::Import)
        })
        .count()
}
fn root_probe(
    root: PathBuf,
    probe: impl FnOnce(PathBuf) -> Result<PathBuf> + Send + 'static,
) -> Result<PathBuf> {
    let (send, receive) = std::sync::mpsc::sync_channel(1);
    std::thread::Builder::new()
        .name("migration-library-probe".into())
        .spawn(move || {
            let result = probe(root);
            // A timed-out receiver is gone: late results cannot publish preferences.
            let _ = send.send(result);
        })?;
    receive
        .recv_timeout(std::time::Duration::from_secs(2))
        .context("Library probe timed out")?
}
fn import_library(
    config: &Path,
    profile: &Path,
    record: &mut Record,
    root: Option<PathBuf>,
    settings_unreadable: bool,
) {
    if record.items.get("library").is_some_and(Entry::terminal) {
        return;
    }
    if nondefault(config, "library.json", Some("projectsRoot"), &Value::Null) {
        record.items.insert(
            "library".into(),
            Entry::new(Outcome::KeptNative, "native-value"),
        );
        return;
    }
    if settings_unreadable {
        record.items.insert(
            "library".into(),
            Entry::new(Outcome::RetryLater, "source-unreadable-or-changing"),
        );
        return;
    }
    let Some(root) = root.filter(|p| p.is_absolute() && !p.starts_with(profile)) else {
        record.items.insert(
            "library".into(),
            Entry::new(Outcome::SkipInvalid, "missing-or-invalid-value"),
        );
        return;
    };
    record.library_attempts = record.library_attempts.saturating_add(1);
    let source_profile = profile.to_owned();
    let resolved = root_probe(root, move |root| {
        let resolved = crate::project_library::probe_import_root(&root)?;
        let source_profile = source_profile.canonicalize()?;
        if resolved.starts_with(&source_profile) {
            return Err(std::io::Error::from(std::io::ErrorKind::InvalidInput).into());
        }
        Ok(resolved)
    });
    let outcome = match resolved {
        Ok(root) => {
            let cfg = crate::project_library::Config {
                preferences: config.join("library.json"),
                override_root: None,
                ..Default::default()
            };
            if crate::project_library::import_probed_root(&cfg, &root).is_ok() {
                Entry::new(Outcome::Import, "validated-source")
            } else {
                Entry::new(Outcome::RetryLater, "native-store-rejected-or-unavailable")
            }
        }
        Err(error)
            if error.downcast_ref::<std::io::Error>().is_some_and(|e| {
                matches!(
                    e.kind(),
                    std::io::ErrorKind::NotADirectory | std::io::ErrorKind::InvalidInput
                )
            }) =>
        {
            Entry::new(Outcome::SkipInvalid, "invalid-library-root")
        }
        Err(_) if record.library_attempts >= 20 => Entry::new(
            Outcome::SkipInvalid,
            "library-unavailable-after-20-launches",
        ),
        Err(_) => Entry::new(Outcome::RetryLater, "library-unavailable-or-probe-timeout"),
    };
    record.items.insert("library".into(), outcome);
}
/// Called by the window's first-frame callback. Native helper work is never
/// awaited by the UI thread; timeout remains a retryable per-item outcome.
pub(crate) fn after_first_frame() {
    let Some((config, profiles)) = DEFERRED_AUDIO.get().cloned() else {
        return;
    };
    if AUDIO_STARTED.swap(true, Ordering::AcqRel) {
        return;
    }
    let _ = std::thread::Builder::new()
        .name("migration-audio".into())
        .spawn(move || {
            if let Ok(count) = finish_audio(&config, &profiles, &|| {
                crate::audio_devices::inventory(&std::sync::Arc::new(AtomicBool::new(true)))
            }) {
                SUMMARY.fetch_add(count, Ordering::AcqRel);
            }
        });
}
fn finish_audio(
    config: &Path,
    profiles: &[PathBuf],
    inventory: &impl Fn() -> Result<crate::audio_devices::Inventory>,
) -> Result<usize> {
    safe_destination(config, profiles)?;
    source::ordinary_path(config)?;
    let path = config.join(".migration.lock");
    source::ordinary_path(&path)?;
    let mut options = OpenOptions::new();
    options.read(true).write(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    let _lease = crate::file_lease::Lease::acquire(options.open(path)?)?;
    let Some(raw) = source::read(&config.join("migration.json"), 4 * 1024 * 1024)? else {
        return Ok(0);
    };
    let previous: Record = serde_json::from_value(raw)?;
    ensure!(previous.version == 1, "Unknown migration version");
    if previous.items.get("audio").is_none_or(Entry::terminal) {
        return Ok(0);
    }
    let Some(profile) = profiles.iter().find(|p| {
        p.file_name()
            .is_some_and(|n| n == previous.profile.as_str())
    }) else {
        return Ok(0);
    };
    source::ordinary_path(profile)?;
    for name in [".audio.lock", ".metronome.lock"] {
        let p = config.join(name);
        if fs::symlink_metadata(&p).is_ok() {
            source::ordinary_path(&p)?;
        }
    }
    let mut record = previous.clone();
    import_handover(profile, config, &mut record, inventory);
    let count = new_imports(Some(&previous), &record);
    if record != previous {
        publish(&config.join("migration.json"), &record)?;
    }
    Ok(count)
}

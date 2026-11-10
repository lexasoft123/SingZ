//! Native, conflict-checked project writes. No migration or unrelated field loss.
use anyhow::{Context, Result, bail, ensure};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::{
    collections::BTreeSet,
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
const LIMIT: u64 = 8 * 1024 * 1024;
static SERIAL: AtomicU64 = AtomicU64::new(1);
pub fn fingerprint(bytes: &[u8]) -> String {
    Sha256::digest(bytes)
        .iter()
        .map(|b| format!("{b:02x}"))
        .collect()
}
pub fn read(dir: &Path, name: &str) -> Result<(Value, String)> {
    if !matches!(name, "project.json" | "lyrics.json") {
        bail!("Invalid project member")
    }
    let path = dir.join(name).canonicalize()?;
    if !path.starts_with(dir) {
        bail!("Project member leaves its folder")
    }
    let mut bytes = vec![];
    File::open(path)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        bail!("Project metadata is too large")
    }
    let value = serde_json::from_slice(&bytes).context("Invalid project JSON")?;
    Ok((value, fingerprint(&bytes)))
}
#[derive(Clone, Debug)]
pub struct Mix {
    pub carry: crate::carry_line::Desired,
    pub metronome: crate::beat::Metronome,
    pub beat: Option<crate::beat::Beats>,
    pub original: bool,
    pub lanes: Vec<usize>,
    pub custom: Vec<crate::tracks::Lane>,
    pub gain: [f32; crate::tracks::LANE_SLOTS],
    pub muted: [bool; crate::tracks::LANE_SLOTS],
    pub solo: [bool; crate::tracks::LANE_SLOTS],
    pub master: f32,
    pub transpose: i32,
    pub tempo: f32,
    pub looping: bool,
    pub selection: Option<(f64, f64)>,
    pub view: (f64, f64),
}
fn gain(value: f32, max: f32) -> Result<Value> {
    if !value.is_finite() || !(0. ..=max).contains(&value) {
        bail!("Invalid mix value")
    };
    Ok(json!((value as f64 * 1e6).round() / 1e6))
}
pub fn update_mix(mut raw: Value, mix: &Mix) -> Result<Value> {
    let original = raw.clone();
    let empty = !mix.original && mix.lanes.is_empty() && mix.custom.is_empty();
    ensure!(
        empty || !mix.lanes.is_empty(),
        "Missing active lanes is not an explicit empty-track mix"
    );
    let object = raw.as_object_mut().context("Project must be an object")?;
    let settings = object
        .entry("settings")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Invalid project settings")?;
    if mix.original {
        settings.remove("nativeOriginalDisabled");
    } else if empty
        || !mix.custom.is_empty()
        || settings.get("nativeOriginalDisabled") == Some(&Value::Bool(true))
    {
        settings.insert("nativeOriginalDisabled".into(), json!(true));
    }
    let mut carry = mix.carry.clone();
    if empty {
        carry.enabled = false;
    }
    carry.merge_settings(settings.entry("training").or_insert_with(|| json!({})))?;
    settings.insert("masterVolume".into(), gain(mix.master, 4.)?);
    crate::beat::commands(&mix.metronome, mix.beat.as_ref())?;
    // Keep unrelated future metadata while replacing the fields we own.
    let met = settings.entry("metronome").or_insert_with(|| json!({}));
    if !met.is_object() {
        *met = json!({});
    }
    met.as_object_mut().unwrap().extend(
        serde_json::to_value(&mix.metronome)?
            .as_object()
            .unwrap()
            .clone(),
    );
    if let Some(beat) = &mix.beat {
        let mut value = serde_json::to_value(beat)?;
        for t in value["beats"].as_array_mut().unwrap() {
            let n = t.as_f64().unwrap();
            *t = json!((n * 1000.).round() / 1000.);
        }
        let current = settings.entry("beat").or_insert_with(|| json!({}));
        if !current.is_object() {
            *current = json!({});
        }
        let object = current.as_object_mut().unwrap();
        for key in [
            "downbeats",
            "autoDownbeats",
            "userBars",
            "suspectAt",
            "detVersion",
        ] {
            if value.get(key).is_none() {
                object.remove(key);
            }
        }
        object.extend(value.as_object().unwrap().clone());
    } else if settings
        .get("beat")
        .is_some_and(|v| crate::beat::Beats::sanitize(v).is_some())
    {
        // A deliberately cleared accepted grid must not reappear on reopen.
        // Unknown/unusable legacy metadata is left alone until explicitly edited.
        settings.remove("beat");
    }

    if !(-24..=24).contains(&mix.transpose)
        || !mix.tempo.is_finite()
        || !(0.25..=4.).contains(&mix.tempo)
    {
        bail!("Invalid transport setting")
    }
    settings.insert("transpose".into(), json!(mix.transpose));
    settings.insert("tempo".into(), gain(mix.tempo, 4.)?);
    if empty {
        settings.insert("nativeEmptyTracks".into(), json!(true));
        settings.insert("custom".into(), json!([]));
        // A deliberate zero-lane document has no transport interval. Keeping a
        // synthetic range would silently turn missing audio into a fake song.
        for key in ["loop", "selection", "view"] {
            settings.remove(key);
        }
    } else {
        settings.remove("nativeEmptyTracks");
        settings.insert("loop".into(), json!(mix.looping));
        for (name, range) in [("selection", mix.selection), ("view", Some(mix.view))] {
            let Some((start,end))=range else {settings.remove(name);continue;};
            if !start.is_finite() || !end.is_finite() || start < 0. || end <= start {
                bail!("Invalid project time range");
            }
            // View normalization can perturb loaded seconds by an f64 ULP.
            // Compare at the writer's existing microsecond edit precision so
            // an equivalent Save retains the original numbers and spelling.
            let saved_seconds = |seconds: f64| (seconds * 1e6).round() / 1e6;
            if !settings.get(name).is_some_and(|range|
                range["s"].as_f64().map(saved_seconds) == Some(saved_seconds(start))
                    && range["e"].as_f64().map(saved_seconds) == Some(saved_seconds(end)))
            {
                settings.insert(name.into(), json!({"s":saved_seconds(start),"e":saved_seconds(end)}));
            }
        }
    }
    let tracks = settings
        .entry("tracks")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Invalid project tracks")?;
    ensure!(
        mix.lanes.len() <= crate::tracks::MAX_ACTIVE_LANES,
        "Too many active audio lanes"
    );
    let mut slots = BTreeSet::new();
    let mut ids = BTreeSet::new();
    for custom in &mix.custom {
        ensure!(
            custom.custom
                && custom.slot >= crate::tracks::BUILTIN_SLOTS
                && custom.slot < crate::tracks::LANE_SLOTS
                && slots.insert(custom.slot)
                && ids.insert(custom.id.clone()),
            "Invalid custom mix lane identity"
        );
        ensure!(
            mix.lanes.contains(&custom.slot),
            "Inactive custom lane in saved mix"
        );
        crate::tracks::validate_custom_id(&custom.id)?;
    }
    tracks.retain(|id, _| !id.starts_with("custom-") || ids.contains(id));
    let mut active = BTreeSet::new();
    for &lane in &mix.lanes {
        ensure!(
            lane < crate::tracks::LANE_SLOTS && active.insert(lane),
            "Invalid or duplicate lane slot"
        );
        let id = if let Some(custom) = mix.custom.iter().find(|custom| custom.slot == lane) {
            custom.id.as_str()
        } else if mix.original && lane == 5 {
            "original"
        } else {
            *crate::integration::STEMS
                .get(lane)
                .filter(|_| lane < crate::tracks::BUILTIN_SLOTS)
                .context("Missing custom lane identity")?
        };
        let track = tracks
            .entry(id)
            .or_insert_with(|| json!({}))
            .as_object_mut()
            .context("Invalid track")?;
        track.insert("volume".into(), gain(mix.gain[lane], 1.)?);
        track.insert("muted".into(), json!(mix.muted[lane]));
        track.insert("solo".into(), json!(mix.solo[lane]));
    }
    if raw != original {
        raw.as_object_mut().unwrap().insert(
            "savedAt".into(),
            json!(chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)),
        );
    }
    Ok(raw)
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
#[cfg(not(windows))]
pub(crate) fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    fs::rename(from, to)
}
#[cfg(windows)]
pub(crate) fn replace(from: &Path, to: &Path) -> std::io::Result<()> {
    // MoveFileExW(REPLACE_EXISTING | WRITE_THROUGH) fails with AccessDenied
    // under concurrent readers on Windows 10. Flush
    // the completed staging file through its own writable handle, then use
    // the standard atomic same-volume replacement without unlinking `to`.
    OpenOptions::new().write(true).open(from)?.sync_all()?;
    fs::rename(from, to)
}
#[derive(Clone, Debug)]
pub struct CustomCommit {
    pub metadata_hash: String,
    pub raw: Value,
    pub custom: Vec<crate::tracks::Lane>,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug)]
pub struct CustomMaterialized {
    pub files: Vec<String>,
    pub custom: Vec<crate::tracks::Lane>,
    pub warnings: Vec<String>,
}
fn custom_base(id: &str, index: usize) -> String {
    let mut slug = String::new();
    let mut separator = false;
    for c in id.to_lowercase().chars() {
        if c.is_ascii_alphanumeric() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            slug.push(c);
            separator = false;
        } else {
            separator = true;
        }
    }
    let slug = slug.strip_prefix("custom-").unwrap_or(&slug);
    format!(
        "custom-{}",
        if slug.is_empty() {
            (index + 1).to_string()
        } else {
            slug.to_owned()
        }
    )
}
fn custom_cancel(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Custom track save cancelled");
    Ok(())
}
fn ordinary_stems(dir: &Path) -> Result<PathBuf> {
    let stems = dir.join("stems");
    fs::create_dir_all(&stems)?;
    let meta = fs::symlink_metadata(&stems)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Custom tracks need an ordinary stems folder"
    );
    Ok(stems)
}
fn copy_encoded(source: &Path, destination: &Path, cancel: &impl Fn() -> bool) -> Result<()> {
    custom_cancel(cancel)?;
    let before = fs::symlink_metadata(source)?;
    ensure!(
        before.is_file()
            && !before.file_type().is_symlink()
            && before.len() <= 8 * 1024 * 1024 * 1024,
        "Custom audio must be ordinary and bounded"
    );
    if let Ok(meta) = fs::symlink_metadata(destination) {
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Linked custom track destination"
        );
        if source.canonicalize()? == destination.canonicalize()? {
            return Ok(());
        }
    }
    let temp = destination.with_file_name(format!(
        ".native-custom-{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let guard = Pending(temp.clone());
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000 | 0x800);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let mut input = options.open(source)?;
    let opened = input.metadata()?;
    ensure!(
        opened.is_file() && !opened.file_type().is_symlink() && opened.len() == before.len(),
        "Custom source changed while opening"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            before.dev() == opened.dev() && before.ino() == opened.ino(),
            "Custom source replaced while opening"
        );
    }
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temp)?;
    let mut count = 0u64;
    let mut block = [0u8; 65536];
    loop {
        custom_cancel(cancel)?;
        let n = input.read(&mut block)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        ensure!(count <= before.len(), "Custom source changed while saving");
        output.write_all(&block[..n])?;
    }
    let after = fs::symlink_metadata(source)?;
    ensure!(
        after.is_file()
            && !after.file_type().is_symlink()
            && before.len() == after.len()
            && count == after.len()
            && before.modified().ok() == after.modified().ok(),
        "Custom source changed while saving"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        ensure!(
            before.dev() == after.dev() && before.ino() == after.ino(),
            "Custom source replaced while saving"
        );
    }
    output.sync_all()?;
    drop(output);
    custom_cancel(cancel)?;
    replace(&temp, destination)?;
    drop(guard);
    Ok(())
}
/// The only absolute paths admitted here come from captured in-memory lanes,
/// never from project.json. A raw portable custom list is resolved by tracks
/// before reaching this boundary; missing picked files are dropped with warning.
pub fn materialize_custom(
    source_root: &Path,
    destination: &Path,
    raw: &mut Value,
    custom: &[crate::tracks::Lane],
    cancel: &impl Fn() -> bool,
) -> Result<CustomMaterialized> {
    ensure!(
        source_root.is_absolute()
            && destination.is_absolute()
            && custom.len() <= crate::tracks::MAX_ACTIVE_LANES,
        "Invalid custom save inventory"
    );
    let stems = ordinary_stems(destination)?;
    let mut used = BTreeSet::new();
    let mut ids = BTreeSet::new();
    let mut slots = BTreeSet::new();
    let mut saved = vec![];
    let mut files = vec![];
    let mut values = vec![];
    let mut warnings = vec![];
    for (index, lane) in custom.iter().enumerate() {
        custom_cancel(cancel)?;
        ensure!(
            lane.custom
                && lane.slot >= crate::tracks::BUILTIN_SLOTS
                && lane.slot < crate::tracks::LANE_SLOTS
                && slots.insert(lane.slot)
                && ids.insert(lane.id.clone()),
            "Invalid custom save identity"
        );
        crate::tracks::validate_custom_id(&lane.id)?;
        ensure!(
            lane.file.is_absolute(),
            "Custom source must be an explicitly captured absolute path"
        );
        let meta = match fs::symlink_metadata(&lane.file) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                warnings.push(format!(
                    "Custom track \"{}\": {} is gone — not saved",
                    lane.label,
                    lane.file.display()
                ));
                continue;
            }
            Err(error) => return Err(error.into()),
        };
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Custom source must be an ordinary file"
        );
        let extension = lane
            .file
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_lowercase();
        let suffix = if extension.is_empty() {
            String::new()
        } else {
            format!(".{extension}")
        };
        let base = custom_base(&lane.id, index);
        let mut name = format!("{base}{suffix}");
        let mut sequence = 2;
        while used.contains(&name) {
            name = format!("{base}-{sequence}{suffix}");
            sequence += 1;
        }
        used.insert(name.clone());
        let relative = format!("stems/{name}");
        ensure!(
            crate::tracks::normalize_custom_path(&relative).is_some(),
            "Unsafe custom track filename"
        );
        copy_encoded(&lane.file, &stems.join(&name), cancel)?;
        let mut anchored = lane.clone();
        anchored.file = destination.join(&relative);
        saved.push(anchored);
        files.push(relative.clone());
        values.push(json!({"id":lane.id,"label":lane.label,"color":lane.color,"file":relative}));
    }
    let settings = raw
        .as_object_mut()
        .context("Invalid project metadata")?
        .entry("settings")
        .or_insert_with(|| json!({}))
        .as_object_mut()
        .context("Invalid project settings")?;
    if values.is_empty() {
        if settings.get("nativeEmptyTracks") == Some(&Value::Bool(true)) {
            settings.insert("custom".into(), json!([]));
        } else {
            settings.remove("custom");
        }
    } else {
        if settings.get("nativeEmptyTracks") == Some(&Value::Bool(true)) {
            settings.insert("nativeOriginalDisabled".into(), json!(true));
        }
        settings.remove("nativeEmptyTracks");
        settings.insert("custom".into(), Value::Array(values));
    }
    let retained: BTreeSet<_> = saved.iter().map(|lane| lane.id.as_str()).collect();
    if let Some(tracks) = settings.get_mut("tracks").and_then(Value::as_object_mut) {
        tracks.retain(|id, _| !id.starts_with("custom-") || retained.contains(id.as_str()));
    }
    Ok(CustomMaterialized {
        files,
        custom: saved,
        warnings,
    })
}
/// Only exact ordinary custom-* files in this project's stems directory are
/// eligible for pruning. Links, directories and every other namespace survive.
pub fn unused_custom_files(
    dir: &Path,
    kept: &[String],
    cancel: &impl Fn() -> bool,
) -> Result<Vec<String>> {
    let stems = dir.join("stems");
    let meta = match fs::symlink_metadata(&stems) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(vec![]),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Linked stems folder"
    );
    let kept: BTreeSet<_> = kept.iter().map(String::as_str).collect();
    let mut result = vec![];
    for (index, entry) in fs::read_dir(stems)?.enumerate() {
        custom_cancel(cancel)?;
        ensure!(index < 100000, "Too many project stem members");
        let entry = entry?;
        let name = entry.file_name();
        let Some(name) = name.to_str() else {
            continue;
        };
        let relative = format!("stems/{name}");
        if !name.starts_with("custom-")
            || kept.contains(relative.as_str())
            || crate::tracks::normalize_custom_path(&relative).is_none()
        {
            continue;
        }
        let meta = fs::symlink_metadata(entry.path())?;
        if meta.is_file() && !meta.file_type().is_symlink() {
            result.push(relative);
            ensure!(
                result.len() <= 64,
                "Too many obsolete custom tracks; project left unchanged"
            );
        }
    }
    result.sort();
    Ok(result)
}
pub fn commit_custom(
    dir: &Path,
    expected: &str,
    value: &Value,
    custom: &[crate::tracks::Lane],
    cancel: &impl Fn() -> bool,
) -> Result<CustomCommit> {
    let dir = dir.canonicalize()?;
    let _lease = crate::project_publish::lock(&dir)?;
    crate::project_publish::recover_locked(&dir)?;
    ensure!(
        read(&dir, "project.json")?.1 == expected,
        "Project changed outside this app. Reopen it before saving."
    );
    custom_cancel(cancel)?;
    let key = format!(
        "{}-{}",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    );
    let staging = dir.join(format!(".native-split-{key}"));
    fs::create_dir(&staging)?;
    struct Stage(PathBuf);
    impl Drop for Stage {
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
    let guard = Stage(staging.clone());
    let next = staging.join("next");
    fs::create_dir(&next)?;
    let mut raw = value.clone();
    let materialized = materialize_custom(&dir, &next, &mut raw, custom, cancel)?;
    let unchanged: BTreeSet<_> = materialized
        .files
        .iter()
        .zip(&materialized.custom)
        .filter_map(|(name, lane)| {
            let original = custom.iter().find(|original| original.id == lane.id)?;
            (original.file.canonicalize().ok() == dir.join(name).canonicalize().ok()
                && original.file.exists())
            .then(|| name.clone())
        })
        .collect();
    let mut files: Vec<_> = materialized
        .files
        .iter()
        .filter(|name| !unchanged.contains(*name))
        .map(|name| (name.clone(), true))
        .collect();
    // Hash metadata for rewritten/removed custom media must not describe old
    // bytes. Existing immutable project copies retain their source hashes.
    if let Some(hashes) = raw.get_mut("stemHashes").and_then(Value::as_object_mut) {
        hashes.retain(|name, _| {
            !name.starts_with("custom-") || unchanged.contains(&format!("stems/{name}"))
        });
    }
    files.extend(
        unused_custom_files(&dir, &materialized.files, cancel)?
            .into_iter()
            .map(|name| (name, false)),
    );
    let bytes = serde_json::to_vec_pretty(&raw)?;
    ensure!(bytes.len() as u64 <= LIMIT, "Project metadata is too large");
    fs::write(next.join("project.json"), &bytes)?;
    files.push(("project.json".into(), true));
    custom_cancel(cancel)?;
    crate::project_publish::commit(&dir, &key, files, expected)?;
    drop(guard);
    let custom = materialized
        .custom
        .into_iter()
        .map(|mut lane| {
            let relative = lane
                .file
                .strip_prefix(&next)
                .expect("materialized custom root")
                .to_owned();
            lane.file = dir.join(relative);
            lane
        })
        .collect();
    Ok(CustomCommit {
        metadata_hash: fingerprint(&bytes),
        raw,
        custom,
        warnings: materialized.warnings,
    })
}
pub fn commit(dir: &Path, name: &str, expected: &str, value: &Value) -> Result<String> {
    let dir = dir.canonicalize()?;
    if !matches!(name, "project.json" | "lyrics.json") {
        bail!("Invalid project member")
    }
    let _lease = crate::project_publish::lock(&dir)?;
    commit_locked(&dir, name, expected, value)
}
/// Capture an ordinary member's bytes without requiring valid JSON. A malformed
/// lyrics document can then be repaired only against its exact captured identity.
pub(crate) fn member_bytes(dir: &Path, name: &str) -> Result<Option<Vec<u8>>> {
    if !matches!(name, "project.json" | "lyrics.json") {
        bail!("Invalid project member")
    }
    let path = dir.join(name);
    match fs::symlink_metadata(&path) {
        Ok(meta) => {
            if meta.file_type().is_symlink() || !meta.is_file() {
                bail!("Project member is not an ordinary file")
            }
            if meta.len() > LIMIT {
                bail!("Project metadata is too large")
            }
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    }
    if path.canonicalize()? != path {
        bail!("Project member leaves its ordinary path")
    }
    let mut bytes = vec![];
    File::open(&path)?.take(LIMIT + 1).read_to_end(&mut bytes)?;
    if bytes.len() as u64 > LIMIT {
        bail!("Project metadata is too large")
    }
    if fs::symlink_metadata(&path)?.file_type().is_symlink() {
        bail!("Linked project member changed while reading")
    }
    Ok(Some(bytes))
}
pub fn commit_expected(
    dir: &Path,
    name: &str,
    expected: Option<&str>,
    value: &Value,
) -> Result<String> {
    let dir = dir.canonicalize()?;
    let _lease = crate::project_publish::lock(&dir)?;
    crate::project_publish::recover_locked(&dir)?;
    commit_expected_locked(&dir, name, expected, value)
}
pub(crate) fn commit_locked(
    dir: &Path,
    name: &str,
    expected: &str,
    value: &Value,
) -> Result<String> {
    commit_expected_locked(dir, name, Some(expected), value)
}
pub(crate) fn commit_expected_locked(
    dir: &Path,
    name: &str,
    expected: Option<&str>,
    value: &Value,
) -> Result<String> {
    if !matches!(name, "project.json" | "lyrics.json") {
        bail!("Invalid project member")
    }
    let destination = dir.join(name);
    let current_bytes = member_bytes(dir, name)?;
    let current = current_bytes.as_ref().map(|b| fingerprint(b));
    if current.as_deref() != expected {
        bail!("Project changed outside this app. Reopen it before saving.")
    }
    // An unchanged document must not acquire a new formatting-only fingerprint.
    if current_bytes.as_ref().is_some_and(|bytes| {
        serde_json::from_slice::<Value>(bytes).is_ok_and(|old| old == *value)
    }) {
        return Ok(current.unwrap());
    }
    let mut bytes = serde_json::to_vec_pretty(value)?;
    bytes.push(b'\n');
    if bytes.len() as u64 > LIMIT {
        bail!("Project metadata is too large")
    }
    let pending = Pending(dir.join(format!(
        ".{name}.gpui-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )));
    let mut output = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&pending.0)?;
    output.write_all(&bytes)?;
    output.sync_all()?;
    drop(output);
    // Other applications may not participate in our advisory lock.
    // Check again immediately before publishing this complete replacement.
    if member_bytes(dir, name)?.map(|b| fingerprint(&b)).as_deref() != expected {
        bail!("Project changed while saving. Reopen it before saving.")
    }
    if expected.is_none() {
        // An atomic no-replace publication closes the absent-file race even
        // against writers that ignore our advisory project lease.
        fs::hard_link(&pending.0, &destination).context("Project member appeared while saving")?;
    } else {
        replace(&pending.0, &destination)?;
    }
    #[cfg(not(windows))]
    {
        if let Ok(directory) = File::open(&dir) {
            let _ = directory.sync_all();
        }
    }
    Ok(fingerprint(&bytes))
}
#[cfg(test)]
mod tests {
    use super::*;
    include!("project_store_timeline_tests.rs");
    fn mix() -> Mix {
        Mix {
            carry: Default::default(),
            metronome: Default::default(),
            beat: None,
            original: false,
            lanes: vec![0],
            custom: vec![],
            gain: [0.4; crate::tracks::LANE_SLOTS],
            muted: [true; crate::tracks::LANE_SLOTS],
            solo: [false; crate::tracks::LANE_SLOTS],
            master: 0.7,
            transpose: 0,
            tempo: 1.,
            looping: false,
            selection: Some((0., 3.)),
            view: (0., 3.),
        }
    }
    #[test]
    fn clearing_selection_removes_only_its_saved_bounds() {
        let raw=json!({"version":2,"settings":{"selection":{"s":1.,"e":2.},"futureSetting":7}});
        let mut m=mix();
        m.selection=None;
        let cleared=update_mix(raw,&m).unwrap();
        assert!(cleared["settings"].get("selection").is_none());
        assert_eq!(cleared["settings"]["futureSetting"],7);
        m.selection=Some((0.5,2.5));
        let selected=update_mix(cleared,&m).unwrap();
        assert_eq!(selected["settings"]["selection"],json!({"s":0.5,"e":2.5}));
    }
    #[test]
    fn accepted_metronome_and_beat_edits_preserve_foreign_metadata() {
        let raw = json!({"version":2,"settings":{"metronome":{"future":{"token":7},"grid":false},"beat":{"futureBeat":"keep","downbeats":[0,4],"detVersion":999}}});
        let mut m = mix();
        m.metronome.click = true;
        m.metronome.grid = true;
        m.metronome.volume = 0.61;
        m.beat = Some(crate::beat::Beats::constant(120., 0.123456, 3., 4).unwrap());
        let saved = update_mix(raw, &m).unwrap();
        assert_eq!(saved["settings"]["metronome"]["future"]["token"], 7);
        assert_eq!(saved["settings"]["metronome"]["volume"], 0.61);
        assert_eq!(saved["settings"]["beat"]["futureBeat"], "keep");
        assert_eq!(saved["settings"]["beat"]["beats"][0], 0.123);
        assert!(saved["settings"]["beat"].get("downbeats").is_none());
        assert!(saved["settings"]["beat"].get("detVersion").is_none());
        m.beat = None;
        let cleared = update_mix(saved.clone(), &m).unwrap();
        assert!(cleared["settings"].get("beat").is_none());
        assert_eq!(cleared["settings"]["metronome"]["future"]["token"], 7);
        m.metronome.volume = f64::NAN;
        assert!(update_mix(saved, &m).is_err());
    }
    #[test]
    fn mix_save_preserves_unknown_data_and_detects_conflicts() {
        let dir = std::env::temp_dir().join(format!("singz-save-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        let dir = dir.canonicalize().unwrap();
        let source = r#"{"version":2,"name":"Voice","future":{"large":123456789012345678901234567890},"stemHashes":{"vocals.flac":{"md5":"unchanged"}},"settings":{"future":"keep","tracks":{"vocals":{"automation":[1,2]}}}}"#;
        fs::write(dir.join("project.json"), source).unwrap();
        let (raw, hash) = read(&dir, "project.json").unwrap();
        let edited = update_mix(raw.clone(), &mix()).unwrap();
        let next = commit(&dir, "project.json", &hash, &edited).unwrap();
        let (saved, newhash) = read(&dir, "project.json").unwrap();
        assert_eq!(next, newhash);
        assert_eq!(saved["future"], raw["future"]);
        assert_eq!(saved["stemHashes"], raw["stemHashes"]);
        assert_eq!(saved["settings"]["future"], "keep");
        assert_eq!(
            saved["settings"]["tracks"]["vocals"]["automation"],
            json!([1, 2])
        );
        assert_eq!(saved["settings"]["tracks"]["vocals"]["volume"], 0.4);
        assert!(commit(&dir, "project.json", &hash, &raw).is_err());
        assert_eq!(read(&dir, "project.json").unwrap().1, next);
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn source_only_mix_saves_under_original() {
        let mut m = mix();
        m.original = true;
        m.lanes = vec![5];
        m.gain[5] = 0.7;
        let saved = update_mix(json!({"settings":{"tracks":{"other":{"keep":true}}}}), &m).unwrap();
        assert_eq!(saved["settings"]["tracks"]["original"]["volume"], 0.7);
        assert_eq!(saved["settings"]["tracks"]["other"], json!({"keep":true}));
    }
    #[test]
    fn invalid_mix_cannot_produce_a_write() {
        let mut m = mix();
        m.master = f32::NAN;
        assert!(update_mix(json!({}), &m).is_err());
    }
}

#[cfg(test)]
#[path = "project_store_custom_tests.rs"]
mod custom_tests;

#[cfg(test)]
mod carry_persistence_tests {
    use super::*;
    #[test]
    fn update_mix_persists_accepted_carry_and_preserves_foreign_fields() {
        let mut mix = Mix {
            carry: crate::carry_line::Desired {
                enabled: true,
                config: crate::carry_line::Config {
                    mode: crate::carry_line::Mode::Lines,
                    period_sec: 25,
                    hear: 2,
                    sing: 3,
                    stems: vec!["vocals".into()],
                },
            },
            metronome: Default::default(),
            beat: None,
            original: false,
            lanes: vec![0],
            custom: vec![],
            gain: [1.; crate::tracks::LANE_SLOTS],
            muted: [false; crate::tracks::LANE_SLOTS],
            solo: [false; crate::tracks::LANE_SLOTS],
            master: 1.,
            transpose: 0,
            tempo: 1.,
            looping: false,
            selection: Some((0., 10.)),
            view: (0., 10.),
        };
        let raw = serde_json::json!({"version":2,"settings":{"training":{"on":false,"future":{"preserve":7}}}});
        let enabled = update_mix(raw, &mix).unwrap();
        assert_eq!(enabled["settings"]["training"]["on"], true);
        assert_eq!(enabled["settings"]["training"]["periodSec"], 25);
        assert_eq!(enabled["settings"]["training"]["future"]["preserve"], 7);
        mix.carry.enabled = false;
        let disabled = update_mix(enabled, &mix).unwrap();
        assert!(disabled["settings"]["training"].get("on").is_none());
        assert_eq!(disabled["settings"]["training"]["future"]["preserve"], 7);
        mix.carry.enabled = true;
        mix.lanes.clear();
        let empty = update_mix(disabled, &mix).unwrap();
        assert!(empty["settings"]["training"].get("on").is_none());
        assert_eq!(empty["settings"]["nativeEmptyTracks"], true);
        assert_eq!(empty["settings"]["training"]["periodSec"], 25);
    }
}

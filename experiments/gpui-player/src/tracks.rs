//! Stable track identity and portable saved custom-track metadata. Mixer slots
//! are control addresses; the native graph always uses each lane's string ID.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::HashSet,
    fs,
    path::{Path, PathBuf},
};

pub const BUILTIN_SLOTS: usize = 6;
pub const LANE_SLOTS: usize = 22;
pub const MAX_ACTIVE_LANES: usize = 16;
pub const BACKING_ID: &str = "custom-backing-vocals";
pub const CUSTOM_COLORS: [&str; 5] = ["#c7e06a", "#ff9ad5", "#6fd8ff", "#e8dcc0", "#a98cff"];
pub const BUILTIN_IDS: [&str; 6] = ["vocals", "drums", "bass", "guitar", "piano", "other"];
pub const BUILTIN_LABELS: [&str; 6] = ["Vocals", "Drums", "Bass", "Guitar", "Piano", "Instruments"];
pub const BUILTIN_COLORS: [&str; 6] = [
    "#ff5c65", "#ffc53d", "#527dff", "#f98424", "#da81da", "#27e7bb",
];

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Lane {
    pub slot: usize,
    pub id: String,
    pub label: String,
    pub color: String,
    /// Absolute source path in memory; only persistence may emit relative JSON.
    pub file: PathBuf,
    pub custom: bool,
}
impl Lane {
    pub fn builtin(slot: usize, file: PathBuf) -> Result<Self> {
        ensure!(slot < BUILTIN_SLOTS, "Invalid built-in track role");
        Ok(Self {
            slot,
            id: BUILTIN_IDS[slot].into(),
            label: BUILTIN_LABELS[slot].into(),
            color: BUILTIN_COLORS[slot].into(),
            file,
            custom: false,
        })
    }
    pub fn original(file: PathBuf) -> Self {
        Self {
            slot: 5,
            id: "original".into(),
            label: "Full mix".into(),
            color: "#bfb49d".into(),
            file,
            custom: false,
        }
    }
}
pub fn validate_custom_id(id: &str) -> Result<()> {
    ensure!(
        id.len() <= 128 && id.starts_with("custom-"),
        "Invalid custom track ID"
    );
    let slug = &id[7..];
    ensure!(
        !slug.is_empty()
            && !slug.starts_with('-')
            && !slug.contains("--")
            && slug
                .bytes()
                .all(|b| b.is_ascii_lowercase() || b.is_ascii_digit() || b == b'-'),
        "Invalid custom track ID"
    );
    Ok(())
}
/// Match shared/custom-track-path.ts: normalize Windows separators but never
/// normalize away traversal, nested paths, stream names or absolute prefixes.
pub fn normalize_custom_path(value: &str) -> Option<PathBuf> {
    let normalized = value.replace('\\', "/");
    let name = normalized.strip_prefix("stems/")?;
    if name.is_empty()
        || matches!(name, "." | "..")
        || name.chars().any(|c| matches!(c, '/' | ':' | '\0'))
    {
        return None;
    }
    Some(PathBuf::from("stems").join(name))
}
pub fn next_custom_slot(lanes: &[Lane], id: &str) -> Result<usize> {
    validate_custom_id(id)?;
    ensure!(
        lanes.len() < MAX_ACTIVE_LANES,
        "The native player supports at most sixteen active tracks"
    );
    ensure!(
        !lanes.iter().any(|lane| lane.id == id),
        "Duplicate track ID: {id}"
    );
    let used: HashSet<_> = lanes.iter().map(|l| l.slot).collect();
    if id == BACKING_ID {
        ensure!(
            !used.contains(&6),
            "Backing vocal track slot is already in use"
        );
        return Ok(6);
    }
    // Keep slot6 available for a future backing split unless all sixteen
    // custom-only slots are needed. Existing custom mixes then retain slots.
    (7..LANE_SLOTS)
        .chain(std::iter::once(6))
        .find(|slot| !used.contains(slot))
        .context("No native track slot is available")
}
/// Pure picker metadata. Opening/decoding and source identity checks happen on
/// the replacement worker; renaming a label never regenerates this stable ID.
pub fn new_custom(path: PathBuf, existing: &[Lane]) -> Result<Lane> {
    ensure!(path.is_absolute(), "Choose an absolute audio file");
    let extension = path
        .extension()
        .and_then(|s| s.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    ensure!(
        [
            "mp3", "wav", "flac", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff"
        ]
        .contains(&extension.as_str()),
        "Unsupported custom track file extension"
    );
    let name = path
        .file_stem()
        .and_then(|s| s.to_str())
        .context("Invalid custom track filename")?;
    let mut slug = String::new();
    let mut separator = false;
    for c in name.to_lowercase().chars() {
        if c.is_ascii_lowercase() || c.is_ascii_digit() {
            if separator && !slug.is_empty() {
                slug.push('-');
            }
            separator = false;
            slug.push(c);
        } else {
            separator = true;
        }
    }
    slug.truncate(40);
    if slug.is_empty() {
        slug = "track".into();
    }
    let mut id = format!("custom-{slug}");
    let mut suffix = 2;
    while existing.iter().any(|lane| lane.id == id) {
        id = format!("custom-{slug}-{suffix}");
        suffix += 1;
    }
    let mut clean = String::new();
    let mut dash = false;
    for c in name.chars() {
        if matches!(c, '_' | '-') {
            if !dash {
                clean.push(' ');
            }
            dash = true;
        } else {
            dash = false;
            clean.push(c);
        }
    }
    let mut label = String::new();
    let mut whitespace = String::new();
    for c in clean.chars() {
        if crate::lyrics_edit::js_whitespace(c) {
            whitespace.push(c);
        } else {
            if !whitespace.is_empty() {
                if whitespace.chars().count() > 1 {
                    label.push(' ');
                } else {
                    label.push_str(&whitespace);
                }
                whitespace.clear();
            }
            label.push(c);
        }
    }
    label.push_str(&whitespace);
    let label = crate::lyrics_edit::trim_text(&label);
    let label = if label.is_empty() {
        "Untitled track".into()
    } else {
        let mut chars = label.chars();
        chars.next().unwrap().to_uppercase().collect::<String>() + chars.as_str()
    };
    let slot = next_custom_slot(existing, &id)?;
    let count = existing.iter().filter(|lane| lane.custom).count();
    Ok(Lane {
        slot,
        id,
        label,
        color: CUSTOM_COLORS[count % CUSTOM_COLORS.len()].into(),
        file: path,
        custom: true,
    })
}
pub struct ResolvedCustom {
    pub lanes: Vec<Lane>,
    pub warnings: Vec<String>,
}
pub fn resolve_custom(dir: &Path, raw: &Value) -> Result<ResolvedCustom> {
    let mut out = ResolvedCustom {
        lanes: vec![],
        warnings: vec![],
    };
    let Some(entries) = raw.as_array() else {
        return Ok(out);
    };
    ensure!(
        entries.len() <= 4096,
        "Too many saved custom track definitions"
    );
    let root = dir.canonicalize()?;
    let mut ids = HashSet::new();
    let mut pending = vec![];
    for (index, entry) in entries.iter().enumerate() {
        let (Some(id), Some(file)) = (entry["id"].as_str(), entry["file"].as_str()) else {
            out.warnings
                .push("Ignored malformed custom track metadata.".into());
            continue;
        };
        let label = entry["label"].as_str().unwrap_or(id);
        let Some(relative) = normalize_custom_path(file) else {
            out.warnings.push(format!(
                "Custom track \"{label}\" has an unsafe saved path and was not loaded."
            ));
            continue;
        };
        let path = root.join(relative);
        let usable = (|| -> Result<PathBuf> {
            ensure!(
                fs::symlink_metadata(root.join("stems"))?
                    .file_type()
                    .is_dir(),
                "Linked or missing stems folder"
            );
            ensure!(
                fs::symlink_metadata(&path)?.file_type().is_file(),
                "Linked or missing custom track"
            );
            ensure!(
                path.canonicalize()? == path,
                "Custom track leaves its ordinary project path"
            );
            Ok(path)
        })();
        let file = match usable {
            Ok(file) => file,
            Err(_) => {
                out.warnings.push(format!(
                    "Custom track \"{label}\" is missing or unsafe and was not loaded."
                ));
                continue;
            }
        };
        validate_custom_id(id)?;
        ensure!(ids.insert(id.to_owned()), "Duplicate custom track ID: {id}");
        pending.push(Lane {
            slot: usize::MAX,
            id: id.into(),
            label: label.into(),
            color: entry["color"]
                .as_str()
                .unwrap_or(CUSTOM_COLORS[index % CUSTOM_COLORS.len()])
                .into(),
            file,
            custom: true,
        });
    }
    ensure!(
        pending.len() <= MAX_ACTIVE_LANES,
        "The native player supports at most sixteen active tracks"
    );
    // Reserve the exact legacy backing identity even if it occurs last in JSON.
    let backing = pending.iter().find(|lane| lane.id == BACKING_ID).cloned();
    let mut assigned = vec![];
    if let Some(mut lane) = backing {
        lane.slot = 6;
        assigned.push(lane);
    }
    for mut lane in pending.iter().filter(|lane| lane.id != BACKING_ID).cloned() {
        lane.slot = next_custom_slot(&assigned, &lane.id)?;
        assigned.push(lane);
    }
    // Retain source order in the active graph and saved metadata.
    for mut lane in pending {
        lane.slot = assigned.iter().find(|a| a.id == lane.id).unwrap().slot;
        out.lanes.push(lane);
    }
    Ok(out)
}

//! Pure desktop Drive reconciliation, mirroring sync-plan.ts and gdrive.ts guards.
//! No filesystem, account, transport, or publication authority lives here.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{
    collections::{BTreeMap, HashMap, HashSet},
    path::{Component, Path, PathBuf},
};
use unicode_normalization::UnicodeNormalization;
pub const FOLDER_MIME: &str = "application/vnd.google-apps.folder";
pub const PARENTS_PER_QUERY: usize = 50;
pub const MTIME_TOLERANCE_MS: f64 = 2.;
pub const PUBLISH_ID_KEY: &str = "singzPublish";
pub const PUBLISH_STATE_KEY: &str = "singzState";
pub const STATE_PUBLISHED: &str = "published";
pub const STATE_ADOPTED: &str = "adopted";
pub const CATALOG_FORMAT: u32 = 2;
pub const CATALOG_CAPABILITIES: CatalogCapabilities = CatalogCapabilities { adopt: 1 };
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct CatalogCapabilities {
    pub adopt: u32,
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct RemoteEntry {
    pub id: String,
    pub name: String,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub mime_type: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub md5_checksum: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub size: Option<String>,
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub parents: Vec<String>,
    #[serde(default, skip_serializing_if = "BTreeMap::is_empty")]
    pub app_properties: BTreeMap<String, String>,
}
/// A listing is sufficient only when its complete roster equals the positively
/// published roster, including folders and every metadata field. Order is not
/// evidence; duplicate IDs are never a complete observation.
pub fn quiet_members(members: &[RemoteEntry], top: &[RemoteEntry], stems: &[RemoteEntry]) -> bool {
    let by_id = |rows: Vec<&RemoteEntry>| {
        let mut map = BTreeMap::new();
        for entry in rows {
            if map.insert(entry.id.clone(), entry.clone()).is_some() { return None; }
        }
        Some(map)
    };
    match (by_id(members.iter().collect()), by_id(top.iter().chain(stems).collect())) {
        (Some(expected), Some(listed)) => expected == listed,
        _ => false,
    }
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalEntry {
    pub name: String,
    pub path: PathBuf,
    pub mime: String,
    pub md5: String,
    pub size: u64,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectSnapshot {
    pub dir: String,
    pub top: Vec<LocalEntry>,
    pub stems: Vec<LocalEntry>,
    pub doc_readable: bool,
    pub stems_readable: bool,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct RemoteProject {
    pub folder_id: Option<String>,
    pub stems_id: Option<String>,
    pub top: Vec<RemoteEntry>,
    pub stems: Vec<RemoteEntry>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Location {
    Top,
    Stems,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UploadStep {
    pub name: String,
    #[serde(rename = "where")]
    pub where_: Location,
    pub path: PathBuf,
    pub mime: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub existing_id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct TrashStep {
    pub entry: RemoteEntry,
    #[serde(rename = "where")]
    pub where_: Location,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CatalogRow {
    pub name: String,
    pub size: String,
    pub md5_checksum: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub id: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ProjectPlan {
    pub dir: String,
    pub upload: Vec<UploadStep>,
    pub unchanged: usize,
    pub trash: Vec<TrashStep>,
    pub rows: Vec<CatalogRow>,
}
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct SyncPlan {
    pub upload: Vec<String>,
    pub unchanged: Vec<String>,
}
/// Source's plainName, deliberately distinct from a portable creation name.
pub fn plain_name(name: &str) -> bool {
    !name.is_empty()
        && name != "."
        && name != ".."
        && !name.chars().any(|c| matches!(c, '/' | '\\' | '\0'))
}
/// Native creation/upload paths must also remain distinct on NTFS/APFS.
pub fn validate_portable_name(name: &str) -> Result<()> {
    ensure!(
        plain_name(name)
            && !name
                .chars()
                .any(|c| c <= '\u{1f}' || "<>:\"|?*".contains(c))
            && !name.ends_with(['.', ' ']),
        "Unsafe portable Drive member name: {name:?}"
    );
    let stem = name.split('.').next().unwrap_or("").to_ascii_uppercase();
    let reserved = matches!(
        stem.as_str(),
        "CON" | "PRN" | "AUX" | "NUL" | "CONIN$" | "CONOUT$" | "CLOCK$"
    ) || stem
        .strip_prefix("COM")
        .or_else(|| stem.strip_prefix("LPT"))
        .is_some_and(|n| {
            matches!(
                n,
                "1" | "2" | "3" | "4" | "5" | "6" | "7" | "8" | "9" | "¹" | "²" | "³"
            )
        });
    ensure!(!reserved, "Reserved portable Drive member name: {name:?}");
    Ok(())
}
fn name_key(name: &str) -> String {
    name.trim_end_matches(['.', ' '])
        .nfc()
        .collect::<String>()
        .to_lowercase()
}
fn valid_id(id: &str) -> Result<()> {
    ensure!(
        !crate::lyrics_edit::trim_text(id).is_empty()
            && id.len() <= 1024
            && !id.chars().any(char::is_control),
        "Invalid Drive identity"
    );
    Ok(())
}
pub fn escape_query_string(text: &str) -> String {
    text.replace('\\', "\\\\").replace('\'', "\\'")
}
pub fn parents_query(ids: &[String]) -> Result<String> {
    ensure!(
        !ids.is_empty() && ids.len() <= PARENTS_PER_QUERY,
        "Drive parent query requires one to fifty identities"
    );
    for id in ids {
        valid_id(id)?;
    }
    Ok(format!(
        "({}) and trashed=false",
        ids.iter()
            .map(|id| format!("'{}' in parents", escape_query_string(id)))
            .collect::<Vec<_>>()
            .join(" or ")
    ))
}
pub fn chunk_parents(ids: &[String]) -> Result<Vec<Vec<String>>> {
    chunk_parents_with_size(ids, PARENTS_PER_QUERY)
}
pub fn chunk_parents_with_size(ids: &[String], per: usize) -> Result<Vec<Vec<String>>> {
    ensure!(
        per > 0 && per <= PARENTS_PER_QUERY,
        "Invalid Drive parent chunk size"
    );
    for id in ids {
        valid_id(id)?;
    }
    Ok(ids.chunks(per).map(|chunk| chunk.to_vec()).collect())
}
pub fn is_published(entry: &RemoteEntry) -> bool {
    entry
        .app_properties
        .get(PUBLISH_STATE_KEY)
        .is_some_and(|s| s == STATE_PUBLISHED)
}
fn validate_remote(remote: &[RemoteEntry]) -> Result<()> {
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    for entry in remote {
        valid_id(&entry.id)?;
        ensure!(plain_name(&entry.name), "Unsafe remote Drive member name");
        ensure!(ids.insert(&entry.id), "Duplicate remote Drive identity");
        ensure!(
            names.insert(name_key(&entry.name)),
            "Ambiguous remote Drive name"
        );
        for parent in &entry.parents {
            valid_id(parent)?;
        }
    }
    Ok(())
}
fn validate_local(local: &[LocalEntry]) -> Result<()> {
    let mut names = HashSet::new();
    let mut paths = HashSet::new();
    for entry in local {
        validate_portable_name(&entry.name)?;
        ensure!(
            names.insert(name_key(&entry.name)) && paths.insert(&entry.path),
            "Ambiguous local Drive member"
        );
        ensure!(
            entry.path.is_absolute()
                && entry
                    .path
                    .components()
                    .all(|c| !matches!(c, Component::CurDir | Component::ParentDir))
                && entry
                    .path
                    .file_name()
                    .is_some_and(|n| n == entry.name.as_str()),
            "Invalid local Drive member source path"
        );
        ensure!(
            !entry.md5.is_empty()
                && !entry.mime.is_empty()
                && entry.mime.len() <= 256
                && !entry.mime.chars().any(char::is_control),
            "Invalid local Drive checksum or MIME"
        );
    }
    Ok(())
}
fn validate_pair(local: &[LocalEntry], remote: &[RemoteEntry]) -> Result<()> {
    validate_local(local)?;
    validate_remote(remote)?;
    let names: HashMap<_, _> = remote.iter().map(|r| (name_key(&r.name), r)).collect();
    for entry in local {
        if let Some(other) = names.get(&name_key(&entry.name)) {
            ensure!(
                entry.name == other.name,
                "Local and remote names collide after filesystem case folding"
            );
            ensure!(
                other.mime_type.as_deref() != Some(FOLDER_MIME),
                "A remote folder conflicts with a local file"
            );
        }
    }
    Ok(())
}
pub fn plan_sync(local: &[LocalEntry], remote: &[RemoteEntry]) -> Result<SyncPlan> {
    validate_pair(local, remote)?;
    let remote: HashMap<_, _> = remote.iter().map(|r| (r.name.as_str(), r)).collect();
    let mut plan = SyncPlan::default();
    for entry in local {
        if remote
            .get(entry.name.as_str())
            .and_then(|r| r.md5_checksum.as_deref())
            == Some(entry.md5.as_str())
        {
            plan.unchanged.push(entry.name.clone());
        } else {
            plan.upload.push(entry.name.clone());
        }
    }
    Ok(plan)
}
pub fn orphans(local_names: &[String], remote: &[RemoteEntry]) -> Result<Vec<RemoteEntry>> {
    validate_remote(remote)?;
    for name in local_names {
        validate_portable_name(name)?;
    }
    let mut keys = HashMap::new();
    for name in local_names {
        if let Some(previous) = keys.insert(name_key(name), name) {
            ensure!(previous == name, "Ambiguous local orphan member names");
        }
    }
    for entry in remote {
        if let Some(name) = keys.get(&name_key(&entry.name)) {
            ensure!(
                name.as_str() == entry.name,
                "Local and remote orphan names collide after case folding"
            );
        }
    }
    let local: HashSet<_> = local_names.iter().map(String::as_str).collect();
    Ok(remote
        .iter()
        .filter(|r| r.mime_type.as_deref() != Some(FOLDER_MIME) && !local.contains(r.name.as_str()))
        .cloned()
        .collect())
}
fn validate_project(local: &ProjectSnapshot, remote: &RemoteProject) -> Result<()> {
    validate_portable_name(&local.dir)?;
    validate_pair(&local.top, &remote.top)?;
    validate_pair(&local.stems, &remote.stems)?;
    for (where_, entries) in [(Location::Top, &local.top), (Location::Stems, &local.stems)] {
        for entry in entries {
            let parent = entry.path.parent().unwrap();
            let project = if where_ == Location::Stems {
                ensure!(
                    parent.file_name().is_some_and(|n| n == "stems"),
                    "Stem source is outside stems/"
                );
                parent.parent()
            } else {
                Some(parent)
            };
            ensure!(
                project
                    .and_then(Path::file_name)
                    .is_some_and(|n| n == local.dir.as_str()),
                "Local Drive source does not belong to its project"
            );
        }
    }
    for id in [&remote.folder_id, &remote.stems_id].into_iter().flatten() {
        valid_id(id)?;
    }
    ensure!(
        remote.folder_id.is_none() || remote.folder_id != remote.stems_id,
        "Project and stems folder identities are identical"
    );
    ensure!(
        remote.stems_id.is_none() || remote.folder_id.is_some(),
        "Stems folder has no project parent"
    );
    ensure!(
        remote.top.is_empty() || remote.folder_id.is_some(),
        "Remote project files have no folder identity"
    );
    ensure!(
        remote.stems.is_empty() || remote.stems_id.is_some(),
        "Remote stems have no folder identity"
    );
    let mut ids = HashSet::new();
    for (parent, entries) in [
        (&remote.folder_id, &remote.top),
        (&remote.stems_id, &remote.stems),
    ] {
        for entry in entries {
            let listed_stems_folder = entry.mime_type.as_deref() == Some(FOLDER_MIME)
                && entry.name == "stems"
                && Some(&entry.id) == remote.stems_id.as_ref()
                && parent == &remote.folder_id;
            ensure!(
                ids.insert(&entry.id)
                    && Some(&entry.id) != remote.folder_id.as_ref()
                    && (Some(&entry.id) != remote.stems_id.as_ref() || listed_stems_folder),
                "Remote member identity aliases another member or parent"
            );
            if !entry.parents.is_empty() {
                ensure!(
                    parent.as_ref().is_some_and(|p| entry.parents.contains(p)),
                    "Remote member belongs to a different folder"
                );
            }
        }
    }
    Ok(())
}
pub fn plan_project(local: &ProjectSnapshot, remote: &RemoteProject) -> Result<ProjectPlan> {
    validate_project(local, remote)?;
    let mut plan = ProjectPlan {
        dir: local.dir.clone(),
        upload: vec![],
        unchanged: 0,
        trash: vec![],
        rows: vec![],
    };
    for (where_, mine, theirs) in [
        (Location::Top, &local.top, &remote.top),
        (Location::Stems, &local.stems, &remote.stems),
    ] {
        let diff = plan_sync(mine, theirs)?;
        plan.unchanged += diff.unchanged.len();
        for entry in mine {
            let existing = theirs.iter().find(|r| r.name == entry.name);
            if diff.upload.contains(&entry.name) {
                plan.upload.push(UploadStep {
                    name: entry.name.clone(),
                    where_,
                    path: entry.path.clone(),
                    mime: entry.mime.clone(),
                    existing_id: existing.map(|r| r.id.clone()),
                });
            }
        }
        if where_ == Location::Stems && local.stems_readable && !mine.is_empty() {
            let names: Vec<_> = mine.iter().map(|f| f.name.clone()).collect();
            plan.trash.extend(
                orphans(&names, theirs)?
                    .into_iter()
                    .map(|entry| TrashStep { entry, where_ }),
            );
        } else if where_ == Location::Top
            && local.doc_readable
            && !mine.iter().any(|f| f.name == "graph.json")
        {
            plan.trash.extend(
                theirs
                    .iter()
                    .filter(|r| {
                        r.name == "graph.json" && r.mime_type.as_deref() != Some(FOLDER_MIME)
                    })
                    .cloned()
                    .map(|entry| TrashStep { entry, where_ }),
            );
        }
    }
    plan.upload.sort_by_key(|step| {
        if step.where_ == Location::Stems {
            0
        } else if step.name == "project.json" {
            2
        } else {
            1
        }
    });
    plan.rows = local
        .top
        .iter()
        .map(|f| CatalogRow {
            name: f.name.clone(),
            size: f.size.to_string(),
            md5_checksum: f.md5.clone(),
            id: remote
                .top
                .iter()
                .find(|r| r.name == f.name)
                .map(|r| r.id.clone()),
        })
        .collect();
    Ok(plan)
}
pub fn orphan_folders(
    root_children: &[RemoteEntry],
    local_dirs: &[String],
    folder_mime: &str,
) -> Result<Vec<RemoteEntry>> {
    let mut local = HashSet::new();
    for dir in local_dirs {
        validate_portable_name(dir)?;
        ensure!(
            local.insert(name_key(dir)),
            "Ambiguous local project directory names"
        );
    }
    let mut ids = HashSet::new();
    let mut names = HashSet::new();
    let mut out = vec![];
    for entry in root_children {
        valid_id(&entry.id)?;
        ensure!(ids.insert(&entry.id), "Duplicate root Drive identity");
        if entry.mime_type.as_deref() != Some(folder_mime) || is_published(entry) {
            continue;
        }
        ensure!(plain_name(&entry.name), "Unsafe remote project directory");
        ensure!(
            names.insert(name_key(&entry.name)),
            "Ambiguous remote project directory names"
        );
        if local.contains(&name_key(&entry.name)) {
            ensure!(
                local_dirs.contains(&entry.name),
                "Local and remote project case collision"
            );
        } else {
            out.push(entry.clone());
        }
    }
    Ok(out)
}
/// Choose the ordinary writer folder, never a phone's pending published copy.
pub fn select_project_folder<'a>(
    entries: &'a [RemoteEntry],
    name: &str,
) -> Result<Option<&'a RemoteEntry>> {
    validate_portable_name(name)?;
    let mut ids = HashSet::new();
    for entry in entries {
        valid_id(&entry.id)?;
        ensure!(ids.insert(&entry.id), "Ambiguous Drive folder identity");
    }
    let matches: Vec<_> = entries
        .iter()
        .filter(|e| {
            e.mime_type.as_deref() == Some(FOLDER_MIME)
                && !is_published(e)
                && name_key(&e.name) == name_key(name)
        })
        .collect();
    ensure!(
        matches.len() <= 1,
        "Ambiguous writable Drive project folder"
    );
    if let Some(entry) = matches.first() {
        valid_id(&entry.id)?;
        ensure!(
            entry.name == name,
            "Local and remote project case collision"
        );
    }
    Ok(matches.first().copied())
}
pub fn adoption_name(remote_name: &str, taken: &[String]) -> Result<String> {
    let replaced: String = remote_name
        .chars()
        .map(|c| {
            if c <= '\u{1f}' || "/\\:*?\"<>|".contains(c) {
                ' '
            } else {
                c
            }
        })
        .collect();
    let mut collapsed = String::new();
    let chars: Vec<_> = replaced.chars().collect();
    let mut i = 0;
    while i < chars.len() {
        if crate::lyrics_edit::js_whitespace(chars[i]) {
            let start = i;
            while i < chars.len() && crate::lyrics_edit::js_whitespace(chars[i]) {
                i += 1;
            }
            if i - start >= 2 {
                collapsed.push(' ');
            } else {
                collapsed.push(chars[start]);
            }
        } else {
            collapsed.push(chars[i]);
            i += 1;
        }
    }
    let base = collapsed.trim_start_matches(|c| c == '.' || crate::lyrics_edit::js_whitespace(c));
    let base = crate::lyrics_edit::trim_text(base);
    let base = if base.is_empty() {
        "Song from phone"
    } else {
        base
    };
    validate_portable_name(base)?;
    let used: HashSet<_> = taken.iter().map(|name| name_key(name)).collect();
    if !used.contains(&name_key(base)) {
        return Ok(base.into());
    }
    for n in 1..=taken.len() + 1 {
        let candidate = if n == 1 {
            format!("{base} (phone)")
        } else {
            format!("{base} (phone {n})")
        };
        if !used.contains(&name_key(&candidate)) {
            return Ok(candidate);
        }
    }
    unreachable!("finite collision set must leave a suffix")
}
pub fn is_fresh(previous: Option<(u64, f64)>, current: (u64, f64)) -> bool {
    previous.is_some_and(|p| {
        p.0 == current.0
            && p.1.is_finite()
            && current.1.is_finite()
            && (p.1 - current.1).abs() < MTIME_TOLERANCE_MS
    })
}
/// Canonical keys use JavaScript UTF-16 ordering, including supplementary text.
pub fn stable_json(value: &Value) -> Result<String> {
    fn write(value: &Value, out: &mut String) -> Result<()> {
        match value {
            Value::Object(object) => {
                let mut keys: Vec<_> = object.keys().collect();
                keys.sort_by(|a, b| {
                    let index = |s: &str| {
                        s.parse::<u32>()
                            .ok()
                            .filter(|n| *n < u32::MAX && n.to_string() == s)
                    };
                    match (index(a), index(b)) {
                        (Some(a), Some(b)) => a.cmp(&b),
                        (Some(_), None) => std::cmp::Ordering::Less,
                        (None, Some(_)) => std::cmp::Ordering::Greater,
                        (None, None) => a.encode_utf16().cmp(b.encode_utf16()),
                    }
                });
                out.push('{');
                for (i, key) in keys.into_iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    out.push_str(&serde_json::to_string(key)?);
                    out.push(':');
                    write(&object[key], out)?;
                }
                out.push('}');
            }
            Value::Array(values) => {
                out.push('[');
                for (i, value) in values.iter().enumerate() {
                    if i > 0 {
                        out.push(',');
                    }
                    write(value, out)?;
                }
                out.push(']');
            }
            Value::Number(number) => out.push_str(&js_number_json(number)),
            _ => out.push_str(&serde_json::to_string(value)?),
        }
        Ok(())
    }
    let mut out = String::new();
    write(value, &mut out)?;
    Ok(out)
}
fn js_number_json(number: &serde_json::Number) -> String {
    let Some(value) = number.as_f64() else {
        return number.to_string();
    };
    if value == 0. {
        return "0".into();
    }
    let mut rendered = serde_json::to_string(&value).expect("finite JSON number");
    if let Some(index) = rendered.find(['e', 'E']) {
        let exponent: i32 = rendered[index + 1..].parse().unwrap();
        let mantissa = rendered[..index].trim_end_matches(".0");
        if (1e-6..1e21).contains(&value.abs()) {
            let negative = mantissa.starts_with('-');
            let positive = mantissa.trim_start_matches('-');
            let point = positive.find('.').unwrap_or(positive.len()) as i32 + exponent;
            let digits = positive.replace('.', "");
            let mut expanded = if point <= 0 {
                format!("0.{}{}", "0".repeat((-point) as usize), digits)
            } else if point >= digits.len() as i32 {
                format!("{}{}", digits, "0".repeat(point as usize - digits.len()))
            } else {
                format!(
                    "{}.{}",
                    &digits[..point as usize],
                    &digits[point as usize..]
                )
            };
            if negative {
                expanded.insert(0, '-');
            }
            return expanded;
        }
        rendered = format!(
            "{}e{}{exponent}",
            mantissa,
            if exponent >= 0 { "+" } else { "" }
        );
    } else if rendered.ends_with(".0") {
        rendered.truncate(rendered.len() - 2);
    }
    rendered
}
#[cfg(test)]
#[path = "drive_plan_tests.rs"]
mod tests;

#[cfg(test)]
mod quiet_members_tests {
    use super::*;
    fn member() -> RemoteEntry {
        RemoteEntry { id: "member".into(), name: "project.json".into(),
            parents: vec!["project".into()], mime_type: Some("application/json".into()),
            md5_checksum: Some("0123456789abcdef0123456789abcdef".into()), size: Some("12".into()),
            app_properties: BTreeMap::from([("writer".into(), "ours".into())]) }
    }
    #[test]
    fn quiet_members_requires_exact_metadata_and_complete_unique_roster() {
        let original = member();
        let stem = RemoteEntry { id: "stem".into(), name: "vocals.wav".into(), parents: vec!["stems".into()], ..original.clone() };
        assert!(quiet_members(&[original.clone(), stem.clone()], &[original.clone()], &[stem.clone()]));
        assert!(quiet_members(&[stem.clone(), original.clone()], &[original.clone()], &[stem.clone()]));
        let changes: Vec<Box<dyn Fn(&mut RemoteEntry)>> = vec![
            Box::new(|m| m.id = "other".into()), Box::new(|m| m.name = "other.json".into()),
            Box::new(|m| m.parents = vec!["other".into()]), Box::new(|m| m.parents.push("other".into())),
            Box::new(|m| m.mime_type = Some(FOLDER_MIME.into())), Box::new(|m| m.mime_type = None),
            Box::new(|m| m.md5_checksum = Some("ffffffffffffffffffffffffffffffff".into())),
            Box::new(|m| m.md5_checksum = None), Box::new(|m| m.size = Some("13".into())),
            Box::new(|m| m.size = None), Box::new(|m| m.app_properties.clear()),
            Box::new(|m| { m.app_properties.insert("foreign".into(), "yes".into()); }),
        ];
        for (i, change) in changes.into_iter().enumerate() {
            let mut changed = original.clone(); change(&mut changed);
            assert!(!quiet_members(&[original.clone()], &[changed], &[]), "metadata field {i}");
            let mut changed = stem.clone(); change(&mut changed);
            assert!(!quiet_members(&[original.clone(), stem.clone()], &[original.clone()], &[changed]), "stem metadata field {i}");
        }
        assert!(!quiet_members(&[original.clone(), stem.clone()], &[original.clone()], &[]));
        assert!(!quiet_members(&[original.clone()], &[original.clone()], &[stem.clone()]));
        assert!(!quiet_members(&[original.clone()], &[original.clone(), original.clone()], &[]));
        assert!(!quiet_members(&[original.clone(), original.clone()], &[original], &[]));
    }
}

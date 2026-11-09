//! Capture a coherent project locally, then release its writer lease before HTTP.
//! Only changed payloads are spooled; network never reads a live mutable file.
use crate::drive_plan::{LocalEntry, Location, ProjectPlan, ProjectSnapshot};
use anyhow::{Context, Result, ensure};
use md5::{Digest, Md5};
use serde_json::{Value, json};
use std::{
    collections::BTreeMap,
    fs::{self, File},
    io::{Read, Write},
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};

const JSON_LIMIT: u64 = 16 * 1024 * 1024;
const AUDIO_EXT: &[&str] = &[
    "wav", "flac", "mp3", "m4a", "aac", "ogg", "oga", "opus", "aif", "aiff",
];
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Fingerprint {
    pub md5: String,
    pub size: u64,
}
pub struct Capture {
    pub snapshot: ProjectSnapshot,
    /// Local document fingerprint for UI status; the transported document may
    /// gain hash maintenance fields without mutating the editor's CAS base.
    pub local_document: String,
    pub warnings: Vec<String>,
    spool: PathBuf,
    source: PathBuf,
    lease: Option<crate::file_lease::Lease>,
}
impl Drop for Capture {
    fn drop(&mut self) {
        self.lease.take();
        let _ = fs::remove_dir_all(&self.spool);
    }
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Drive sync cancelled");
    Ok(())
}
fn ordinary(path: &Path) -> Result<fs::Metadata> {
    let meta = fs::symlink_metadata(path)?;
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink(),
        "Linked or non-file sync payload refused"
    );
    Ok(meta)
}
pub fn digest(path: &Path, cancel: &impl Fn() -> bool) -> Result<Fingerprint> {
    let before = ordinary(path)?;
    let mut source = File::open(path)?;
    let mut hash = Md5::new();
    let mut size = 0u64;
    let mut buffer = [0u8; 65536];
    loop {
        check(cancel)?;
        let n = source.read(&mut buffer)?;
        if n == 0 {
            break;
        }
        hash.update(&buffer[..n]);
        size = size.checked_add(n as u64).context("Sync file too large")?;
    }
    let after = ordinary(path)?;
    ensure!(
        size == before.len()
            && before.len() == after.len()
            && before.modified()? == after.modified()?,
        "Project file changed while sync read it"
    );
    Ok(Fingerprint {
        md5: format!("{:x}", hash.finalize()),
        size,
    })
}
fn mtime(meta: &fs::Metadata) -> Result<f64> {
    Ok(meta.modified()?.duration_since(UNIX_EPOCH)?.as_secs_f64() * 1000.)
}
fn hash_value(path: &Path, previous: &Value, cancel: &impl Fn() -> bool) -> Result<Value> {
    let meta = ordinary(path)?;
    let modified = mtime(&meta)?;
    if previous["md5"].as_str().is_some_and(valid_md5)
        && previous["size"].as_u64() == Some(meta.len())
        && previous["mtimeMs"]
            .as_f64()
            .is_some_and(|old| old.is_finite() && (old - modified).abs() < 2.)
    {
        return Ok(previous.clone());
    }
    let value = digest(path, cancel)?;
    Ok(json!({"md5":value.md5,"size":value.size,"mtimeMs":modified}))
}
pub fn valid_md5(value: &str) -> bool {
    value.len() == 32
        && value
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn entry(name: &str, path: PathBuf, mime: &str, hash: &Value) -> Result<LocalEntry> {
    Ok(LocalEntry {
        name: name.into(),
        path,
        mime: mime.into(),
        md5: hash["md5"]
            .as_str()
            .filter(|v| valid_md5(v))
            .context("Invalid sync MD5")?
            .into(),
        size: hash["size"].as_u64().context("Invalid sync size")?,
    })
}
pub fn audio_mime(name: &str) -> &'static str {
    match Path::new(name)
        .extension()
        .and_then(|v| v.to_str())
        .unwrap_or("")
        .to_ascii_lowercase()
        .as_str()
    {
        "flac" => "audio/flac",
        "mp3" => "audio/mpeg",
        "aac" | "m4a" => "audio/mp4",
        "ogg" | "oga" | "opus" => "audio/ogg",
        "aif" | "aiff" => "audio/aiff",
        _ => "audio/wav",
    }
}
/// Every ordinary directory protects a same-named remote folder. Missing
/// project.json is not proof that the singer deleted their audio.
pub fn directory_names(root: &Path, cancel: &impl Fn() -> bool) -> Result<Vec<String>> {
    let meta = fs::symlink_metadata(root)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Projects root is unavailable or linked"
    );
    let mut names = Vec::new();
    for item in fs::read_dir(root)? {
        check(cancel)?;
        let item = item?;
        let name = item
            .file_name()
            .into_string()
            .map_err(|_| anyhow::anyhow!("Project name is not Unicode"))?;
        if [".singz-",".native-import-",".native-split-"].iter().any(|prefix|name.starts_with(prefix)) {
            continue;
        }
        let meta = fs::symlink_metadata(item.path())?;
        ensure!(
            !meta.file_type().is_symlink(),
            "Linked library members cannot establish a deletion roster"
        );
        if meta.is_dir() {
            names.push(name);
        }
    }
    names.sort();
    let mut folded = std::collections::BTreeSet::new();
    for name in &names {
        ensure!(
            crate::drive_plan::plain_name(name) && folded.insert(name.to_lowercase()),
            "Ambiguous project folder names; sync refused"
        );
    }
    Ok(names)
}
pub fn scan(root: &Path, cancel: &impl Fn() -> bool) -> Result<Vec<String>> {
    let mut projects = Vec::new();
    for name in directory_names(root, cancel)? {
        match fs::symlink_metadata(root.join(&name).join("project.json")) {
            Ok(meta) => {
                ensure!(
                    meta.is_file() && !meta.file_type().is_symlink(),
                    "Unavailable project metadata cannot establish a deletion roster"
                );
                projects.push(name);
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(projects)
}
pub fn capture(
    root: &Path,
    name: &str,
    spool_root: &Path,
    cancel: &impl Fn() -> bool,
) -> Result<Capture> {capture_inner(root,name,spool_root,cancel,false)}
/// A coherent metadata-only export for the dedicated journaled transaction.
/// Generic writer capture remains guarded until its coordinator is integrated.
pub fn capture_empty(root:&Path,name:&str,spool_root:&Path,cancel:&impl Fn()->bool)->Result<Capture> {
    capture_inner(root,name,spool_root,cancel,true)
}
fn capture_inner(root:&Path,name:&str,spool_root:&Path,cancel:&impl Fn()->bool,allow_empty:bool)->Result<Capture> {
    check(cancel)?;
    ensure!(
        crate::drive_plan::plain_name(name),
        "Unsafe sync project name"
    );
    let root = root.canonicalize()?;
    let source = root.join(name);
    let meta = fs::symlink_metadata(&source)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink() && source.canonicalize()? == source,
        "Linked project cannot sync"
    );
    let user_cancel = cancel;
    let cancel = &|| user_cancel() || crate::project_publish::write_pending(&source);
    check(cancel)?;
    let lease = crate::project_publish::lock(&source)?;
    let spool = spool_root.join(name);
    fs::create_dir_all(&spool)?;
    let bytes = read_bounded(&source.join("project.json"), JSON_LIMIT)?;
    let local_document = crate::project_store::fingerprint(&bytes);
    let parsed = serde_json::from_slice::<Value>(&bytes)
        .ok()
        .filter(Value::is_object);
    let explicit_empty=parsed.as_ref().is_some_and(|doc|doc["settings"]["nativeEmptyTracks"]==true);
    ensure!(!explicit_empty||allow_empty,"Empty native project cannot be published to existing Drive readers yet");
    if allow_empty {
        let doc=parsed.as_ref().context("Unreadable explicit empty project")?;
        ensure!(matches!(doc.get("version").filter(|v|!v.is_null()).map_or(Some(1.),Value::as_f64),Some(1.|2.)),"Unsupported explicit empty project version");
        ensure!(explicit_empty&&doc["settings"]["nativeOriginalDisabled"]==true&&doc["settings"]["custom"].as_array().is_some_and(Vec::is_empty),"Malformed explicit empty project");
    }
    let mut capture = Capture {
        snapshot: ProjectSnapshot {
            dir: name.into(),
            top: Vec::new(),
            stems: Vec::new(),
            doc_readable: parsed.is_some(),
            stems_readable: true,
        },
        local_document,
        warnings: Vec::new(),
        spool,
        source: source.clone(),
        lease: Some(lease),
    };
    let mut doc = parsed.unwrap_or(Value::Null);
    if explicit_empty {
        let object=doc.as_object_mut().context("Invalid empty project document")?;
        for key in ["songFile","songHash","graphHash"] {object.remove(key);}
        object.insert("stemHashes".into(),json!({}));
        let settings=object.get_mut("settings").and_then(Value::as_object_mut).context("Invalid empty project settings")?;
        for key in ["loop","selection","view"] {settings.remove(key);}
    }
    if !explicit_empty {
    let mut hashes = BTreeMap::new();
    match fs::read_dir(source.join("stems")) {
        Ok(items) => {
            for item in items {
                check(cancel)?;
                let item = item?;
                let name = item
                    .file_name()
                    .into_string()
                    .map_err(|_| anyhow::anyhow!("Stem name is not Unicode"))?;
                let ext = Path::new(&name)
                    .extension()
                    .and_then(|v| v.to_str())
                    .unwrap_or("")
                    .to_ascii_lowercase();
                if !AUDIO_EXT.contains(&ext.as_str()) {
                    continue;
                }
                ensure!(crate::drive_plan::plain_name(&name), "Unsafe stem name");
                let hash = hash_value(&item.path(), &doc["stemHashes"][&name], cancel)?;
                capture
                    .snapshot
                    .stems
                    .push(entry(&name, item.path(), audio_mime(&name), &hash)?);
                hashes.insert(name, hash);
            }
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
        Err(error) => {
            capture.snapshot.stems_readable = false;
            capture
                .warnings
                .push(format!("{name}: stems could not be read: {error}"));
        }
    }
    capture.snapshot.stems.sort_by(|a, b| a.name.cmp(&b.name));
    if capture.snapshot.doc_readable {
        // Never publish a document with references to files this snapshot lost.
        if let Some(custom) = doc["settings"]["custom"].as_array() {
            for lane in custom {
                let file = lane["file"]
                    .as_str()
                    .context("Invalid custom audio reference")?;
                let stem = file
                    .strip_prefix("stems/")
                    .filter(|file| crate::drive_plan::plain_name(file))
                    .context("Custom audio leaves stems folder")?;
                ensure!(
                    hashes.contains_key(stem),
                    "Custom audio referenced by project is missing"
                );
            }
        }
        if !capture.snapshot.stems_readable {
            anyhow::bail!("Project audio is unavailable; remote project left untouched");
        }
        if let Some(reference) = doc.get("graphHash") {
            let format = reference["format"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= u32::MAX as u64)
                .context("Invalid graph hash format")?;
            ensure!(
                reference["mtimeMs"]
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v >= 0.),
                "Invalid graph hash timestamp"
            );
            let graph = read_bounded(&source.join("graph.json"), 12 * 1024 * 1024)?;
            let md5 = format!("{:x}", Md5::digest(&graph));
            ensure!(
                reference["md5"].as_str() == Some(&md5)
                    && reference["size"].as_u64() == Some(graph.len() as u64),
                "Referenced graph bytes do not match project"
            );
            crate::drive_graph::validate(&graph, format)?;
            capture.write_top("graph.json", &graph, "application/json")?;
        }
        let song = doc["songFile"].as_str().unwrap_or("").to_owned();
        if !song.is_empty() {
            ensure!(
                crate::drive_plan::plain_name(&song),
                "Source audio leaves project folder"
            );
            match hash_value(&source.join(&song), &doc["songHash"], cancel) {
                Ok(hash) => {
                    doc["songHash"] = hash.clone();
                    if hashes.is_empty() {
                        capture.snapshot.top.push(entry(
                            &song,
                            source.join(&song),
                            audio_mime(&song),
                            &hash,
                        )?);
                    }
                }
                Err(error) if hashes.is_empty() => {
                    return Err(error.context("Project has no available source audio"));
                }
                Err(_) => {}
            }
        }
        ensure!(
            !hashes.is_empty()
                || capture
                    .snapshot
                    .top
                    .iter()
                    .any(|f| f.mime.starts_with("audio/")),
            "Project has no audio to sync"
        );
        doc["stemHashes"] = serde_json::to_value(hashes)?;
    }
    }
    match fs::symlink_metadata(source.join("lyrics.json")) {
        Ok(_) => {
            let lyrics = read_bounded(&source.join("lyrics.json"), JSON_LIMIT)?;
            if capture.snapshot.doc_readable {
                doc["lyricsHash"] = json!({"md5":format!("{:x}",Md5::digest(&lyrics)),"size":lyrics.len(),"mtimeMs":mtime(&ordinary(&source.join("lyrics.json"))?)?});
            }
            capture.write_top("lyrics.json", &lyrics, "application/json")?;
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            if let Some(object) = doc.as_object_mut() {
                object.remove("lyricsHash");
            }
        }
        Err(error) => return Err(error.into()),
    }
    if capture.snapshot.doc_readable {
        capture.write_top(
            "project.json",
            &serde_json::to_vec(&doc)?,
            "application/json",
        )?;
    } else {
        capture.write_top("project.json", &bytes, "application/json")?;
    }
    // External writers do not use our lease. Refuse a mixed document snapshot.
    ensure!(
        crate::project_store::fingerprint(&read_bounded(&source.join("project.json"), JSON_LIMIT)?)
            == capture.local_document,
        "Project metadata changed while preparing sync"
    );
    Ok(capture)
}
impl Capture {
    fn write_top(&mut self, name: &str, bytes: &[u8], mime: &str) -> Result<()> {
        let path = self.spool.join(name);
        let mut file = crate::drive_http::private_file(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        self.snapshot.top.push(LocalEntry {
            name: name.into(),
            path,
            mime: mime.into(),
            md5: format!("{:x}", Md5::digest(bytes)),
            size: bytes.len() as u64,
        });
        Ok(())
    }
    pub fn spool_uploads(
        &mut self,
        plan: &mut ProjectPlan,
        cancel: &impl Fn() -> bool,
    ) -> Result<()> {
        let source = self.source.clone();
        let user_cancel = cancel;
        let cancel = &|| user_cancel() || crate::project_publish::write_pending(&source);
        for step in &mut plan.upload {
            check(cancel)?;
            let list = if step.where_ == Location::Stems {
                &self.snapshot.stems
            } else {
                &self.snapshot.top
            };
            let expected = list
                .iter()
                .find(|file| file.name == step.name)
                .context("Upload is outside captured project")?;
            if step.path.starts_with(&self.spool) {
                continue;
            }
            let target = if step.where_ == Location::Stems {
                self.spool.join("stems").join(&step.name)
            } else {
                self.spool.join(&step.name)
            };
            fs::create_dir_all(target.parent().context("Upload spool has no parent")?)?;
            let mut input = File::open(&step.path)?;
            ordinary(&step.path)?;
            let mut output = crate::drive_http::private_file(&target)?;
            let mut hash = Md5::new();
            let mut count = 0u64;
            let mut buffer = [0u8; 65536];
            loop {
                check(cancel)?;
                let n = input.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                output.write_all(&buffer[..n])?;
                hash.update(&buffer[..n]);
                count = count
                    .checked_add(n as u64)
                    .context("Upload exceeds size limit")?;
                ensure!(count <= expected.size, "Audio changed during sync capture");
            }
            ensure!(
                count == expected.size && format!("{:x}", hash.finalize()) == expected.md5,
                "Audio changed during sync capture"
            );
            output.sync_all()?;
            step.path = target;
        }
        self.lease.take();
        Ok(())
    }
}
fn read_bounded(path: &Path, limit: u64) -> Result<Vec<u8>> {
    let meta = ordinary(path)?;
    ensure!(meta.len() <= limit, "Sync metadata exceeds limit");
    let mut bytes = Vec::new();
    File::open(path)?.take(limit + 1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "Sync metadata exceeds limit");
    Ok(bytes)
}

#[cfg(test)]
#[path = "drive_snapshot_tests.rs"]
mod tests;

#[cfg(test)]
mod empty_projection_tests {
    use super::*;
    #[test]
    fn dedicated_empty_projection_keeps_local_audio_and_original_save_cas_while_generic_writer_refuses() {
        let base=std::env::temp_dir().join(format!("singz-empty-projection-{}",crate::drive_http::random_id().unwrap()));let root=base.join("library");let spool=base.join("spool");
        fs::create_dir_all(root.join("Song/stems")).unwrap();fs::create_dir_all(&spool).unwrap();
        let doc=br#"{"version":2,"name":"Song","songFile":"original.wav","songHash":{"old":true},"graphHash":{"old":true},"stemHashes":{"vocals.wav":{"old":true}},"foreign":{"keep":19},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[],"loop":true,"selection":{"s":0,"e":3},"view":{"s":0,"e":3}}}"#;
        fs::write(root.join("Song/project.json"),doc).unwrap();fs::write(root.join("Song/original.wav"),b"retained original").unwrap();fs::write(root.join("Song/stems/vocals.wav"),b"retained built-in").unwrap();fs::write(root.join("Song/graph.json"),b"retained graph").unwrap();fs::write(root.join("Song/lyrics.json"),b"{\"lines\":[]}").unwrap();
        assert!(capture(&root,"Song",&spool,&||false).is_err());
        let export=capture_empty(&root,"Song",&spool,&||false).unwrap();assert_eq!(export.local_document,crate::project_store::fingerprint(doc));assert!(export.snapshot.stems.is_empty());
        assert_eq!(export.snapshot.top.iter().map(|f|f.name.as_str()).collect::<std::collections::BTreeSet<_>>(),std::collections::BTreeSet::from(["project.json","lyrics.json"]));
        let remote:Value=serde_json::from_slice(&fs::read(&export.snapshot.top.iter().find(|f|f.name=="project.json").unwrap().path).unwrap()).unwrap();
        for key in ["songFile","songHash","graphHash"]{assert!(remote.get(key).is_none());}assert_eq!(remote["stemHashes"],json!({}));assert_eq!(remote["foreign"]["keep"],19);
        for key in ["loop","selection","view"]{assert!(remote["settings"].get(key).is_none());}assert_eq!(remote["lyricsHash"]["md5"],format!("{:x}",Md5::digest(b"{\"lines\":[]}")));
        assert_eq!(fs::read(root.join("Song/project.json")).unwrap(),doc);assert_eq!(fs::read(root.join("Song/original.wav")).unwrap(),b"retained original");assert_eq!(fs::read(root.join("Song/stems/vocals.wav")).unwrap(),b"retained built-in");assert_eq!(fs::read(root.join("Song/graph.json")).unwrap(),b"retained graph");
        drop(export);fs::remove_dir_all(base).unwrap();
    }
    #[test] fn missing_audio_and_malformed_empty_intent_never_authorize_projection() {
        let base=std::env::temp_dir().join(format!("singz-empty-invalid-{}",crate::drive_http::random_id().unwrap()));fs::create_dir_all(base.join("Song")).unwrap();fs::create_dir(base.join("spool")).unwrap();
        for doc in [json!({"settings":{}}),json!({"settings":{"nativeEmptyTracks":"true","nativeOriginalDisabled":true,"custom":[]}}),json!({"settings":{"nativeEmptyTracks":true,"custom":[]}}),json!({"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[{}]}}),json!({"version":3,"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}})] {
            fs::write(base.join("Song/project.json"),serde_json::to_vec(&doc).unwrap()).unwrap();assert!(capture_empty(&base,"Song",&base.join("spool"),&||false).is_err());
        }fs::remove_dir_all(base).unwrap();
    }
}

//! Add an external saved project to the selected native library. Moving is an
//! explicit filesystem operation, not a copy relabelled as a move.
use anyhow::{Context, Result, ensure};
use std::{
    fs::{self, File, OpenOptions},
    path::{Component, Path, PathBuf},
};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Copy,
    Move,
}
#[derive(Clone, Debug)]
pub struct Input {
    pub source: PathBuf,
    pub root: PathBuf,
    pub expected_project: String,
    pub expected_lyrics: Option<String>,
    pub mode: Mode,
}
#[derive(Clone, Debug)]
pub struct Outcome {
    pub dir: PathBuf,
    pub imported: bool,
    pub moved: bool,
    pub warning: Option<String>,
}
fn check(cancel: &impl Fn() -> bool) -> Result<()> {
    ensure!(!cancel(), "Add to library was superseded");
    Ok(())
}
fn validate(input: &Input, source: &Path) -> Result<String> {
    let bytes = crate::project_store::member_bytes(source, "project.json")?
        .context("Save the project before adding it to the library")?;
    ensure!(
        crate::project_store::fingerprint(&bytes) == input.expected_project,
        "Project changed outside this app. Reopen it before adding it to the library."
    );
    ensure!(
        crate::lyrics_store::identity(source)? == input.expected_lyrics,
        "Lyrics changed outside this app. Reopen the project before adding it to the library."
    );
    let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
    ensure!(raw.is_object(), "Invalid saved project");
    let settings = &raw["settings"];
    ensure!(
        settings.is_null() || settings.is_object(),
        "Invalid saved project settings"
    );
    for marker in ["nativeEmptyTracks", "nativeOriginalDisabled"] {
        ensure!(
            settings.get(marker).is_none_or(|value| value.is_boolean()),
            "Invalid saved {marker} flag"
        );
    }
    let empty = settings["nativeEmptyTracks"] == true;
    if empty {
        ensure!(
            settings["custom"].as_array().is_some_and(Vec::is_empty),
            "Invalid explicitly empty project metadata"
        );
    }
    let song_present = if raw["songFile"].is_null() {
        false
    } else {
        let song = raw["songFile"]
            .as_str()
            .context("Invalid saved song file")?;
        ensure!(
            !song.is_empty()
                && Path::new(song)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_))),
            "Song file leaves the project folder"
        );
        ordinary_media(source, Path::new(song))?.is_some()
    };
    // The native reader can play saved stems without the original mix, as is
    // common for a shared/cloud project whose original was not downloaded.
    let stems = ["vocals", "drums", "bass", "other", "guitar", "piano"];
    let mut has_stems = false;
    for stem in stems {
        for ext in ["flac", "wav"] {
            let name = format!("{stem}.{ext}");
            if let Some(meta) = ordinary_media(source, &Path::new("stems").join(&name))? {
                if let Some(expected) = raw["stemHashes"][&name]["size"].as_u64() {
                    ensure!(meta.len() == expected, "Damaged stem: {stem}");
                }
                has_stems = true;
                break;
            }
        }
    }
    let backing = settings["leadVocalSeparated"] == true
        && settings["custom"].as_array().is_some_and(|tracks| {
            tracks.len() == 1
                && tracks[0]["id"] == "custom-backing-vocals"
                && tracks[0]["file"] == "stems/custom-backing-vocals.wav"
        });
    if backing {
        let meta = ordinary_media(source, Path::new("stems/custom-backing-vocals.wav"))?
            .context("Saved project backing vocal stem is missing")?;
        if let Some(expected) = raw["stemHashes"]["custom-backing-vocals.wav"]["size"].as_u64() {
            ensure!(meta.len() == expected, "Damaged backing vocal stem");
        }
        has_stems = true;
    }
    if let Some(hashes) = raw["stemHashes"].as_object() {
        for name in hashes.keys() {
            if stems
                .iter()
                .chain(std::iter::once(&"custom-backing-vocals"))
                .any(|stem| name == &format!("{stem}.flac") || name == &format!("{stem}.wav"))
            {
                ensure!(
                    ordinary_media(source, &Path::new("stems").join(name))?.is_some(),
                    "Saved project stem is missing: {name}"
                );
            }
        }
    }
    // A deliberately empty saved document has no audio to validate. Otherwise
    // customs must resolve to ordinary in-project files, never just metadata or
    // an unrelated file which happens to exist under stems.
    let playable_song = song_present && settings["nativeOriginalDisabled"] != true;
    let has_custom = if !empty && !playable_song && !has_stems {
        !crate::tracks::resolve_custom(source, &settings["custom"])
            .context("Saved project has no playable original or stems")?
            .lanes
            .is_empty()
    } else {
        false
    };
    ensure!(
        empty || playable_song || has_stems || has_custom,
        "Saved project has no playable original or stems"
    );
    Ok(crate::source_jobs::safe_name(
        raw["name"].as_str().unwrap_or_else(|| {
            source
                .file_name()
                .and_then(|s| s.to_str())
                .unwrap_or("Song")
        }),
    ))
}
fn ordinary_media(source: &Path, relative: &Path) -> Result<Option<fs::Metadata>> {
    let mut path = source.to_owned();
    let mut last = None;
    for part in relative.components() {
        path.push(part);
        let meta = match fs::symlink_metadata(&path) {
            Ok(meta) => meta,
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
            Err(error) => return Err(error.into()),
        };
        ensure!(
            !meta.file_type().is_symlink(),
            "Linked project media cannot be imported"
        );
        last = Some(meta);
    }
    Ok(last.filter(|meta| meta.is_file()))
}
fn root_lease(root: &Path) -> Result<crate::file_lease::Lease> {
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join(".singz-native-import.lock"))?;
    crate::file_lease::Lease::acquire(file).context("Another project is being added to the library")
}
pub fn execute(input: &Input, cancel: &impl Fn() -> bool) -> Outcome {
    execute_with_config(
        input,
        &crate::project_library::Config::default(),
        cancel,
        force_copy_move(),
    )
}
fn execute_with_config(
    input: &Input,
    config: &crate::project_library::Config,
    cancel: &impl Fn() -> bool,
    force_copy: bool,
) -> Outcome {
    let mut outcome = Outcome {
        dir: input.source.clone(),
        imported: false,
        moved: false,
        warning: None,
    };
    if let Err(error) = run(input, config, cancel, &mut outcome, force_copy) {
        outcome.warning = Some(format!("{error:#}"));
    }
    outcome
}
fn run(
    input: &Input,
    config: &crate::project_library::Config,
    cancel: &impl Fn() -> bool,
    outcome: &mut Outcome,
    force_copy: bool,
) -> Result<()> {
    check(cancel)?;
    let meta = fs::symlink_metadata(&input.source)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Choose an ordinary saved project folder"
    );
    let source = input.source.canonicalize()?;
    outcome.dir = source.clone();
    let preferences = config
        .preferences
        .parent()
        .context("Missing native library preferences folder")?;
    fs::create_dir_all(preferences)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(preferences.join("library.lock"))?;
    let _config_lease =
        crate::file_lease::Lease::acquire(file).context("Library storage is being changed")?;
    let current = crate::project_library::resolved_root(config)?;
    ensure!(
        current == input.root,
        "The library folder changed. Open Add to library again."
    );
    fs::create_dir_all(&input.root)?;
    let root = input.root.canonicalize()?;
    ensure!(
        !source.starts_with(&root),
        "This project is already in the library"
    );
    ensure!(
        !root.starts_with(&source),
        "The library cannot be inside the project being imported"
    );
    let _root_lease = root_lease(&root)?;
    test_gate("SINGZ_GPUI_IMPORT_PREPARE_GATE", cancel)?;
    check(cancel)?;
    let source_lease = crate::project_publish::lock(&source)?;
    crate::project_publish::recover_locked(&source)?;
    let name = validate(input, &source)?;
    let destination = root.join(name);
    ensure!(
        fs::symlink_metadata(&destination).is_err_and(|e| e.kind() == std::io::ErrorKind::NotFound),
        "A project with this name is already in the library"
    );
    check(cancel)?;
    let _sync_intent = ImportSync::new(
        crate::sync_dirty::Store::new(preferences.to_owned()),
        destination.clone(),
        (input.mode == Mode::Move).then(|| source.clone()),
    );
    if input.mode == Mode::Move && !force_copy {
        crate::project_library::validate_source_tree(&source, cancel)?;
        validate(input, &source)?;
        check(cancel)?;
        // An exclusive rename cannot replace even an empty destination created
        // by a scanner or another process after the collision check.
        match crate::project_library::publish_directory(&source, &destination) {
            Ok(()) => {
                outcome.dir = destination;
                outcome.imported = true;
                outcome.moved = true;
                sync_directory(&root);
                if let Some(parent) = source.parent() {
                    sync_directory(parent);
                }
                return Ok(());
            }
            Err(error) if cross_device(&error) => {}
            Err(error) => return Err(error),
        }
    }
    // Reacquire inside the shared bounded copier; its validation runs under
    // that lease both before reading and immediately before publication.
    drop(source_lease);
    let copied =
        crate::project_library::copy_project_checked(&source, &destination, cancel, &|source| {
            validate(input, source).map(|_| ())
        })?;
    outcome.dir = destination;
    outcome.imported = true;
    if input.mode == Mode::Move {
        test_gate("SINGZ_GPUI_IMPORT_REMOVE_GATE", cancel)?;
        check(cancel)?;
        copied.verify(cancel)?;
        validate(input, &source)?;
        // The complete destination is already durable. A cleanup refusal never
        // sends the host back to a partially removed source directory.
        fs::remove_dir_all(&source).context(
            "Project was copied into the library, but the original could not be fully removed",
        )?;
        outcome.moved = true;
        if let Some(parent) = source.parent() {
            sync_directory(parent);
        }
    }
    Ok(())
}
// The final mark also covers a completed copy whose later Move cleanup is
// cancelled/refused. Both old and new paths are intent, even after rename.
struct ImportSync {
    store: crate::sync_dirty::Store,
    destination: PathBuf,
    source: Option<PathBuf>,
}
impl ImportSync {
    fn new(store: crate::sync_dirty::Store, destination: PathBuf, source: Option<PathBuf>) -> Self {
        let value = Self { store, destination, source };
        value.mark("imported into the library");
        value
    }
    fn mark(&self, reason: &str) {
        for path in std::iter::once(&self.destination).chain(self.source.iter()) {
            if let Err(error) = self.store.mark_project(path, reason) {
                crate::diagnostics::event("sync", format!("Could not record imported project sync intent: {error:#}"), crate::diagnostics::Level::Warn);
            }
        }
    }
}
impl Drop for ImportSync {
    fn drop(&mut self) { self.mark("imported into the library (finished)"); }
}
fn cross_device(error: &anyhow::Error) -> bool {
    error
        .downcast_ref::<std::io::Error>()
        .is_some_and(|e| e.raw_os_error() == Some(if cfg!(windows) { 17 } else { 18 }))
}
fn sync_directory(path: &Path) {
    #[cfg(unix)]
    let _ = File::open(path).and_then(|file| file.sync_all());
    #[cfg(not(unix))]
    let _ = path;
}
fn force_copy_move() -> bool {
    #[cfg(feature = "ui-tests")]
    {
        std::env::var_os("SINGZ_GPUI_IMPORT_FORCE_COPY_MOVE").is_some()
    }
    #[cfg(not(feature = "ui-tests"))]
    {
        false
    }
}
pub(crate) fn test_gate(name: &str, cancel: &impl Fn() -> bool) -> Result<()> {
    #[cfg(feature = "ui-tests")]
    if let Some(path) = std::env::var_os(name)
        .map(PathBuf::from)
        .filter(|p| p.exists())
    {
        fs::write(path.with_extension("ready"), b"ready")?;
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(15);
        while path.exists() {
            check(cancel)?;
            ensure!(
                std::time::Instant::now() < deadline,
                "Import test gate timed out"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
    }
    #[cfg(not(feature = "ui-tests"))]
    let _ = (name, cancel);
    Ok(())
}
#[cfg(test)]
#[path = "project_import_tests.rs"]
mod tests;

#[cfg(test)]
mod sync_publication_tests {
    use super::*;
    #[test]
    fn copy_and_move_mark_real_destination_and_move_source() {
        for mode in [Mode::Copy, Mode::Move] {
            let base = std::env::temp_dir().join(format!("singz-import-sync-{}-{:?}", std::process::id(), mode));
            let _ = fs::remove_dir_all(&base);
            let source = base.join("outside/Song");
            fs::create_dir_all(&source).unwrap();
            fs::write(source.join("project.json"), br#"{"version":2,"name":"Song","songFile":"song.wav","settings":{},"foreign":{"keep":true}}"#).unwrap();
            fs::write(source.join("song.wav"), b"song").unwrap();
            fs::write(source.join("notes.txt"), b"foreign file").unwrap();
            let config = crate::project_library::Config {
                home:base.join("home"), default_root:base.join("library"),
                preferences:base.join("prefs/library.json"), override_root:None, one_drive:None,
            };
            let source=source.canonicalize().unwrap();
            let input=Input { source:source.clone(), root:crate::project_library::resolved_root(&config).unwrap(),
                expected_project:crate::project_store::fingerprint(&fs::read(source.join("project.json")).unwrap()),
                expected_lyrics:crate::lyrics_store::identity(&source).unwrap(), mode };
            let outcome=execute_with_config(&input,&config,&||false,true);
            assert!(outcome.imported, "{:?}", outcome.warning);
            assert_eq!(outcome.moved,mode==Mode::Move);
            let dirty=crate::sync_dirty::Store::new(base.join("prefs")).snapshot().unwrap();
            assert!(dirty.dirs.contains_key(outcome.dir.to_str().unwrap()));
            assert_eq!(dirty.dirs.contains_key(source.to_str().unwrap()),mode==Mode::Move);
            assert!(dirty.seq>=if mode==Mode::Move {4}else{2});
            assert_eq!(fs::read(outcome.dir.join("notes.txt")).unwrap(),b"foreign file");
            fs::remove_dir_all(base).unwrap();
        }
    }
}

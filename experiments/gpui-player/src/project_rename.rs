//! Rename a saved project in its current parent, without replacing a sibling.
use anyhow::{Context, Result, ensure};
use std::{
    fs,
    path::{Path, PathBuf},
};

pub struct Outcome {
    pub dir: PathBuf,
    pub warning: Option<String>,
}

#[cfg(unix)]
fn exclusive_move(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::{ffi::CString, os::unix::ffi::OsStrExt};
    let from = CString::new(from.as_os_str().as_bytes())?;
    let to = CString::new(to.as_os_str().as_bytes())?;
    #[cfg(target_os = "macos")]
    let code = {
        unsafe extern "C" {
            fn renamex_np(
                from: *const std::ffi::c_char,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> std::ffi::c_int;
        }
        // RENAME_EXCL: refuse even an empty existing destination directory.
        unsafe { renamex_np(from.as_ptr(), to.as_ptr(), 4) }
    };
    #[cfg(target_os = "linux")]
    let code = {
        unsafe extern "C" {
            fn renameat2(
                a: std::ffi::c_int,
                from: *const std::ffi::c_char,
                b: std::ffi::c_int,
                to: *const std::ffi::c_char,
                flags: u32,
            ) -> std::ffi::c_int;
        }
        unsafe { renameat2(-100, from.as_ptr(), -100, to.as_ptr(), 1) }
    };
    if code == 0 {
        Ok(())
    } else {
        Err(std::io::Error::last_os_error())
    }
}
#[cfg(windows)]
fn exclusive_move(from: &Path, to: &Path) -> std::io::Result<()> {
    use std::os::windows::ffi::OsStrExt;
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn MoveFileExW(from: *const u16, to: *const u16, flags: u32) -> i32;
    }
    let mut from: Vec<_> = from.as_os_str().encode_wide().collect();
    let mut to: Vec<_> = to.as_os_str().encode_wide().collect();
    if from.contains(&0) || to.contains(&0) {
        return Err(std::io::Error::new(
            std::io::ErrorKind::InvalidInput,
            "Project path contains a null character",
        ));
    }
    from.push(0);
    to.push(0);
    if unsafe { MoveFileExW(from.as_ptr(), to.as_ptr(), 8) } == 0 {
        Err(std::io::Error::last_os_error())
    } else {
        Ok(())
    }
}

pub fn rename(dir: &Path, expected: &str, name: &str) -> Result<Outcome> {
    rename_with_sync(dir, expected, name,
        crate::sync_dirty::Store::new(crate::audio_devices::directory()))
}
fn rename_with_sync(dir: &Path, expected: &str, name: &str, store: crate::sync_dirty::Store) -> Result<Outcome> {
    let old = dir.canonicalize()?;
    let next = old.parent().context("Cannot rename a filesystem root")?
        .join(crate::source_jobs::safe_name(name.trim()));
    let mark = |reason| {
        for path in [&old, &next] {
            if let Err(error) = store.mark_project(path, reason) {
                crate::diagnostics::event("sync", format!("Could not record renamed project sync intent: {error:#}"), crate::diagnostics::Level::Warn);
            }
        }
    };
    mark("rename");
    let result = rename_using_authorized(dir, expected, name, crate::project_store::commit_locked, Some(&store));
    mark("rename (finished)");
    result
}
#[cfg(test)]
fn rename_using(
    dir: &Path,
    expected: &str,
    name: &str,
    publish: impl FnOnce(&Path, &str, &str, &serde_json::Value) -> Result<String>,
) -> Result<Outcome> {
    rename_using_authorized(dir, expected, name, publish, None)
}
fn rename_using_authorized(
    dir: &Path,
    expected: &str,
    name: &str,
    publish: impl FnOnce(&Path, &str, &str, &serde_json::Value) -> Result<String>,
    ledger: Option<&crate::sync_dirty::Store>,
) -> Result<Outcome> {
    ensure!(
        !fs::symlink_metadata(dir)?.file_type().is_symlink(),
        "Linked project directory"
    );
    let dir = dir.canonicalize()?;
    let parent = dir.parent().context("Cannot rename a filesystem root")?;
    let _lease = crate::project_publish::lock(&dir)?;
    crate::project_publish::recover_locked(&dir)?;
    ensure!(
        !fs::symlink_metadata(dir.join("project.json"))?
            .file_type()
            .is_symlink(),
        "Linked project metadata"
    );
    let (mut raw, hash) = crate::project_store::read(&dir, "project.json")?;
    ensure!(
        hash == expected,
        "Project changed outside this app. Reopen it before renaming."
    );
    let name = crate::source_jobs::safe_name(name.trim());
    let next = parent.join(&name);
    raw.as_object_mut()
        .context("Invalid project metadata")?
        .insert("name".into(), serde_json::json!(name));
    // Same-path title changes still use the normal conflict-checked publication.
    if next == dir {
        publish(&dir, "project.json", expected, &raw)?;
        return Ok(Outcome { dir, warning: None });
    }
    let retirement = if let Some(ledger) = ledger {
        let mut config = crate::project_library::Config::default();
        config.preferences = ledger.directory().join("library.json");
        // An unreadable library context is not evidence that this loaded
        // project is external. Otherwise a selected-library Rename could move
        // without its retirement receipt and later enter generic orphan cleanup.
        let selected = crate::project_library::resolved_root(&config)?;
        let selected = match selected.canonicalize() {
            Ok(root) => Some(root),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
            Err(error) => return Err(error).context("Cannot verify the library before renaming"),
        };
        if selected.as_deref() == Some(parent) {
            let binding = crate::drive_retirement::active_binding(
                &ledger.directory().join("gdrive/retirements"), parent)?;
            Some(crate::drive_local_ops::Store::new(ledger.directory().to_owned()).prepare(
                crate::drive_local_ops::Kind::Rename, parent, &dir, &next, expected, binding)?)
        } else { None }
    } else { None };
    let commit_retirement = || retirement.as_ref().and_then(|operation| {
        #[cfg(unix)]
        if let Err(error) = fs::File::open(parent).and_then(|file| file.sync_all()) {
            return Some(format!("Project moved, but directory durability and cloud retirement remain unconfirmed: {error}"));
        }
        match operation.commit(ledger.expect("Prepared rename has a ledger")) {
            Ok(committed) => committed.warning,
            Err(error) => Some(format!("Project moved, but its cloud retirement intent is pending recovery: {error:#}")),
        }
    });
    // An exclusive native move also closes the check-to-rename collision race.
    if let Err(error) = exclusive_move(&dir, &next) {
        if let Some(operation) = &retirement { operation.abort()?; }
        if matches!(
            error.kind(),
            std::io::ErrorKind::AlreadyExists | std::io::ErrorKind::DirectoryNotEmpty
        ) {
            anyhow::bail!("A project called “{name}” already exists.");
        }
        return Err(error).with_context(|| format!("Cannot rename the project to “{name}”"));
    }
    if let Err(error) = publish(&next, "project.json", expected, &raw) {
        // Metadata has not been published on failure. Retain the real path if
        // another writer prevents rollback; never tell the UI it stayed put.
        if exclusive_move(&next, &dir).is_ok() {
            if let Some(operation) = &retirement { operation.abort()?; }
            return Err(error);
        }
        let pending = commit_retirement();
        return Ok(Outcome {
            dir: next,
            warning: Some(format!(
                "Folder moved, but the title could not be saved or the folder restored: {error:#}{}",
                pending.map(|warning| format!("; {warning}")).unwrap_or_default()
            )),
        });
    }
    #[cfg(unix)]
    if let Err(error) = fs::File::open(parent).and_then(|f| f.sync_all()) {
        return Ok(Outcome {
            dir: next,
            warning: Some(format!(
                "Project renamed, but directory durability could not be confirmed: {error}"
            )),
        });
    }
    Ok(Outcome {
        dir: next,
        warning: commit_retirement(),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    // Isolate the public worker wrapper's durable ledger in every fixture.
    fn rename(dir: &Path, expected: &str, name: &str) -> Result<Outcome> {
        rename_with_sync(dir, expected, name,
            crate::sync_dirty::Store::new(dir.parent().unwrap().join("test-sync-prefs")))
    }
    #[test]
    fn rename_retains_both_missing_old_path_and_new_project_intents() {
        let (root, dir, hash) = fixture("sync-intent");
        let root = root.canonicalize().unwrap();
        let dir = dir.canonicalize().unwrap();
        let store = crate::sync_dirty::Store::new(root.join("sync-prefs"));
        store.mark_project(&dir, "earlier edit").unwrap();
        let captured = store.snapshot().unwrap().seq;
        let result = rename_with_sync(&dir, &hash, "New", store.clone()).unwrap();
        let remaining = store.clear(captured).unwrap();
        assert!(remaining.dirs.contains_key(dir.to_str().unwrap()));
        assert!(remaining.dirs.contains_key(result.dir.to_str().unwrap()));
        assert!(!dir.exists());
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_library_rename_commits_exact_directory_operation() {
        let (root, dir, hash) = fixture("selected-operation");
        let root = root.canonicalize().unwrap();
        let dir = dir.canonicalize().unwrap();
        let prefs = root.join("sync-prefs");
        fs::create_dir_all(&prefs).unwrap();
        fs::write(prefs.join("library.json"),
            serde_json::to_vec(&json!({"projectsRoot": root})).unwrap()).unwrap();
        let identity = crate::directory_identity::read(&dir).unwrap();
        let store = crate::sync_dirty::Store::new(prefs.clone());
        let result = rename_with_sync(&dir, &hash, "New", store.clone()).unwrap();
        assert!(result.warning.is_none());
        let operations = crate::drive_local_ops::Store::new(prefs).snapshot(&root).unwrap();
        assert_eq!(operations.entries.len(), 1);
        let entry = &operations.entries[0];
        assert_eq!(entry.operation.kind, crate::drive_local_ops::Kind::Rename);
        assert_eq!(entry.operation.old_path, dir);
        assert_eq!(entry.operation.destination, result.dir);
        assert_eq!(entry.operation.local_identity, identity);
        assert_eq!(entry.operation.local_document, hash);
        assert_eq!(crate::directory_identity::read(&result.dir).unwrap(), identity);
        let crate::drive_local_ops::State::Committed(sequence) = entry.state else {
            panic!("Successful native Rename must commit positive local authority");
        };
        assert_eq!(store.snapshot().unwrap().retire_ops.get(&entry.operation.id), Some(&sequence));
        assert_eq!(crate::project_store::read(&result.dir, "project.json").unwrap().0["name"], "New");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn selected_library_failed_rename_aborts_operation_without_authority() {
        let (root, dir, hash) = fixture("selected-collision");
        let root = root.canonicalize().unwrap();
        let dir = dir.canonicalize().unwrap();
        let prefs = root.join("sync-prefs");
        fs::create_dir_all(&prefs).unwrap();
        fs::write(prefs.join("library.json"),
            serde_json::to_vec(&json!({"projectsRoot": root})).unwrap()).unwrap();
        fs::create_dir(root.join("New")).unwrap();
        fs::write(root.join("New/sentinel"), b"keep").unwrap();
        let store = crate::sync_dirty::Store::new(prefs.clone());
        assert!(rename_with_sync(&dir, &hash, "New", store.clone()).is_err());
        let operations = crate::drive_local_ops::Store::new(prefs).snapshot(&root).unwrap();
        assert_eq!(operations.entries.len(), 1);
        assert_eq!(operations.entries[0].state, crate::drive_local_ops::State::Aborted);
        assert!(store.snapshot().unwrap().retire_ops.is_empty());
        assert_eq!(crate::project_store::read(&dir, "project.json").unwrap().1, hash);
        assert_eq!(fs::read(root.join("New/sentinel")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }

    #[test]
    fn invalid_library_context_cannot_turn_selected_rename_into_external_move() {
        let (root, dir, hash) = fixture("invalid-library-context");
        let root = root.canonicalize().unwrap();
        let dir = dir.canonicalize().unwrap();
        let prefs = root.join("sync-prefs");
        fs::create_dir_all(&prefs).unwrap();
        let store = crate::sync_dirty::Store::new(prefs.clone());
        for bytes in [b"{".as_slice(), b"[]".as_slice()] {
            fs::write(prefs.join("library.json"), bytes).unwrap();
            assert!(rename_with_sync(&dir, &hash, "New", store.clone()).is_err());
            assert!(dir.is_dir());
            assert!(!root.join("New").exists());
            assert_eq!(crate::project_store::read(&dir, "project.json").unwrap().1, hash);
            assert!(store.snapshot().unwrap().retire_ops.is_empty());
            assert!(crate::drive_local_ops::Store::new(prefs.clone())
                .snapshot(&root).unwrap().entries.is_empty());
        }
        // A preferences IO failure must preserve the same original path too.
        fs::remove_file(prefs.join("library.json")).unwrap();
        fs::create_dir(prefs.join("library.json")).unwrap();
        assert!(rename_with_sync(&dir, &hash, "New", store).is_err());
        assert!(dir.is_dir() && !root.join("New").exists());
        assert_eq!(crate::project_store::read(&dir, "project.json").unwrap().1, hash);
        fs::remove_dir_all(root).unwrap();
    }

    fn fixture(tag: &str) -> (PathBuf, PathBuf, String) {
        let root = std::env::temp_dir().join(format!("singz-title-{}-{tag}", std::process::id()));
        let _ = fs::remove_dir_all(&root);
        let dir = root.join("Old");
        fs::create_dir_all(dir.join("stems")).unwrap();
        fs::write(dir.join("project.json"),serde_json::to_vec(&json!({"version":2,"name":"Old","songFile":"song.wav","foreign":{"keep":true},"settings":{"tracks":{"vocals":{"volume":0.42}}}})).unwrap()).unwrap();
        fs::write(dir.join("song.wav"), b"source").unwrap();
        fs::write(dir.join("stems/vocals.flac"), b"stem").unwrap();
        let hash = crate::project_store::read(&dir.canonicalize().unwrap(), "project.json")
            .unwrap()
            .1;
        (root, dir, hash)
    }
    #[cfg(windows)]
    #[test]
    fn null_path_cannot_be_truncated_at_the_native_move_boundary() {
        let (root, dir, _) = fixture("null-path");
        assert!(exclusive_move(&dir, &root.join("Renamed\0suffix")).is_err());
        assert!(dir.join("song.wav").exists());
        assert!(!root.join("Renamed").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn moves_in_current_parent_preserving_media_and_unknown_metadata() {
        let (root, dir, hash) = fixture("move");
        let result = rename(&dir, &hash, " New / title.wav ").unwrap();
        assert_eq!(result.dir.file_name().unwrap(), "New title");
        assert!(!dir.exists());
        assert!(result.warning.is_none());
        let (raw, _) = crate::project_store::read(&result.dir, "project.json").unwrap();
        assert_eq!(raw["name"], "New title");
        assert_eq!(raw["foreign"]["keep"], true);
        assert_eq!(raw["settings"]["tracks"]["vocals"]["volume"], 0.42);
        assert_eq!(fs::read(result.dir.join("song.wav")).unwrap(), b"source");
        assert_eq!(
            fs::read(result.dir.join("stems/vocals.flac")).unwrap(),
            b"stem"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn empty_and_populated_siblings_are_never_replaced() {
        let (root, dir, hash) = fixture("collision");
        for name in ["Empty", "Full"] {
            fs::create_dir(root.join(name)).unwrap();
        }
        fs::write(root.join("Full/keep"), b"keep").unwrap();
        for name in ["Empty", "Full"] {
            assert!(rename(&dir, &hash, name).is_err());
            assert!(dir.join("song.wav").exists());
            assert!(root.join(name).is_dir());
        }
        assert_eq!(fs::read(root.join("Full/keep")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn external_edit_and_active_writer_refuse_before_moving() {
        let (root, dir, hash) = fixture("guard");
        let lease = crate::project_publish::lock(&dir).unwrap();
        assert!(rename(&dir, &hash, "New").is_err());
        drop(lease);
        fs::write(dir.join("project.json"), b"{}").unwrap();
        assert!(rename(&dir, &hash, "New").is_err());
        assert!(!root.join("New").exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn linked_metadata_is_not_moved_or_written() {
        let (root, dir, hash) = fixture("link");
        fs::rename(dir.join("project.json"), root.join("external.json")).unwrap();
        std::os::unix::fs::symlink(root.join("external.json"), dir.join("project.json")).unwrap();
        let bytes = fs::read(root.join("external.json")).unwrap();
        assert!(rename(&dir, &hash, "New").is_err());
        assert_eq!(fs::read(root.join("external.json")).unwrap(), bytes);
        assert!(dir.exists());
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn metadata_failure_restores_original_folder() {
        let (root, dir, hash) = fixture("rollback");
        assert!(
            rename_using(&dir, &hash, "New", |_, _, _, _| anyhow::bail!(
                "injected metadata fault"
            ))
            .is_err()
        );
        assert!(dir.join("song.wav").exists());
        assert!(!root.join("New").exists());
        assert_eq!(
            crate::project_store::read(&dir.canonicalize().unwrap(), "project.json")
                .unwrap()
                .0["name"],
            "Old"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn blocked_rollback_reports_actual_moved_identity() {
        let (root, dir, hash) = fixture("retained");
        let result = rename_using(&dir, &hash, "New", |_, _, _, _| {
            fs::create_dir(&dir)?;
            fs::write(dir.join("foreign"), b"keep")?;
            anyhow::bail!("injected metadata fault")
        })
        .unwrap();
        assert_eq!(result.dir, root.canonicalize().unwrap().join("New"));
        assert!(result.warning.unwrap().contains("could not be saved"));
        assert!(result.dir.join("song.wav").exists());
        assert_eq!(fs::read(dir.join("foreign")).unwrap(), b"keep");
        fs::remove_dir_all(root).unwrap();
    }
}

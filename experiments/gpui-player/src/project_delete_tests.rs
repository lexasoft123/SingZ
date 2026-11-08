use super::*;
use serde_json::json;
struct Fixture {
    home: PathBuf,
    root: PathBuf,
    prefs: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let home = std::env::temp_dir().join(format!(
            "singz-project-delete-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&home).unwrap();
        let home = home.canonicalize().unwrap();
        let root = home.join("library");
        let prefs = home.join("preferences");
        let project = root.join("Saved Song");
        fs::create_dir_all(project.join("stems")).unwrap();
        fs::create_dir_all(&prefs).unwrap();
        fs::write(
            prefs.join("library.json"),
            serde_json::to_vec(&json!({"projectsRoot":root,"foreign":{"preserve":true}})).unwrap(),
        )
        .unwrap();
        fs::write(
            project.join("project.json"),
            br#"{"version":1,"name":"Saved Song","songFile":"song.wav","foreign":{"keep":1}}"#,
        )
        .unwrap();
        fs::write(project.join("song.wav"), b"ordinary owned audio").unwrap();
        fs::write(project.join("stems/vocals.wav"), b"vocal audio").unwrap();
        fs::write(project.join("stems/drums.flac"), b"drum audio").unwrap();
        fs::write(
            project.join("lyrics.json"),
            b"a malformed but still owned lyrics document",
        )
        .unwrap();
        fs::create_dir(project.join("unknown folder")).unwrap();
        fs::write(
            project.join("unknown folder/foreign-to-app.bin"),
            b"owned by this project",
        )
        .unwrap();
        Self {
            home,
            root,
            prefs,
            project,
        }
    }
    fn target(&self) -> Target {
        inspect(&self.root, &self.project).unwrap()
    }
    fn hidden(&self) -> Vec<PathBuf> {
        fs::read_dir(&self.root)
            .unwrap()
            .filter_map(|e| {
                let e = e.ok()?;
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".singz-native-delete-")
                    .then(|| e.path())
            })
            .collect()
    }
    fn dirty(&self) -> crate::sync_dirty::Snapshot {
        crate::sync_dirty::Store::new(self.prefs.clone())
            .snapshot()
            .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.home);
    }
}
#[test]
fn confirmation_describes_actual_saved_folder_and_deletes_unknown_owned_members() {
    let f = Fixture::new();
    let target = f.target();
    assert_eq!(target.name, "Saved Song");
    assert_eq!(target.stem_count, 2);
    assert!(target.has_lyrics);
    assert_eq!(
        target.metadata_hash,
        crate::project_store::fingerprint(&fs::read(f.project.join("project.json")).unwrap())
    );
    assert!(target.bytes > 50);
    let outcome = delete(&target, &f.prefs, &|| false).unwrap();
    assert_eq!(outcome.dir, f.project);
    assert_eq!(outcome.name, "Saved Song");
    assert!(outcome.warning.is_none(), "{:?}", outcome.warning);
    assert!(!f.project.exists());
    assert!(f.hidden().is_empty());
    assert!(f.dirty().dirs.contains_key(f.project.to_str().unwrap()));
    let prefs: serde_json::Value =
        serde_json::from_slice(&fs::read(f.prefs.join("library.json")).unwrap()).unwrap();
    assert_eq!(prefs["foreign"]["preserve"], true);
}
#[test]
fn root_ancestor_outside_private_and_unsaved_paths_cannot_be_confirmed() {
    let f = Fixture::new();
    for dir in [&f.root, &f.home, &f.prefs] {
        assert!(inspect(&f.root, dir).is_err());
    }
    let unsaved = f.root.join("Not Saved");
    fs::create_dir(&unsaved).unwrap();
    assert!(inspect(&f.root, &unsaved).is_err());
    let private = f.root.join(".singz-native-delete-foreign");
    fs::create_dir(&private).unwrap();
    fs::copy(f.project.join("project.json"), private.join("project.json")).unwrap();
    assert!(inspect(&f.root, &private).is_err());
    let mut dotted = f.project.as_os_str().to_owned();
    dotted.push(format!("{0}..{0}Saved Song", std::path::MAIN_SEPARATOR));
    assert!(inspect(&f.root, &PathBuf::from(dotted)).is_err());
    assert!(f.project.exists());
}
#[cfg(unix)]
#[test]
fn linked_roots_projects_metadata_and_nested_aliases_are_refused() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let alias = f.home.join("root-alias");
    symlink(&f.root, &alias).unwrap();
    assert!(inspect(&alias, &alias.join("Saved Song")).is_err());
    let project_alias = f.root.join("Alias");
    symlink(&f.project, &project_alias).unwrap();
    assert!(inspect(&f.root, &project_alias).is_err());
    assert!(inspect(&f.root, &project_alias.join("unknown folder")).is_err());
    let foreign = f.home.join("metadata.json");
    fs::rename(f.project.join("project.json"), &foreign).unwrap();
    symlink(&foreign, f.project.join("project.json")).unwrap();
    assert!(inspect(&f.root, &f.project).is_err());
    assert!(foreign.exists());
}
#[cfg(unix)]
#[test]
fn deleting_project_links_never_touches_external_files_or_directory_contents() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.home.join("outside");
    fs::create_dir(&outside).unwrap();
    fs::write(outside.join("precious.txt"), b"not this project's file").unwrap();
    symlink(&outside, f.project.join("linked directory")).unwrap();
    symlink(outside.join("precious.txt"), f.project.join("linked file")).unwrap();
    symlink(f.home.join("missing"), f.project.join("broken link")).unwrap();
    let target = f.target();
    delete(&target, &f.prefs, &|| false).unwrap();
    assert_eq!(
        fs::read(outside.join("precious.txt")).unwrap(),
        b"not this project's file"
    );
    assert!(!f.project.exists());
}
#[test]
fn changed_metadata_lyrics_unknown_members_and_replaced_folders_require_new_confirmation() {
    for change in 0..5 {
        let f = Fixture::new();
        let target = f.target();
        match change {
            0 => fs::write(f.project.join("project.json"), br#"{"name":"Changed"}"#).unwrap(),
            1 => fs::write(f.project.join("lyrics.json"), b"new words").unwrap(),
            2 => fs::write(f.project.join("unknown folder/added"), b"new").unwrap(),
            3 => {
                fs::rename(&f.project, f.root.join("original")).unwrap();
                fs::create_dir(&f.project).unwrap();
                fs::copy(
                    f.root.join("original/project.json"),
                    f.project.join("project.json"),
                )
                .unwrap();
            }
            _ => {
                let path = f.project.join("song.wav");
                let bytes = fs::read(&path).unwrap();
                // Retain the old inode: Linux can immediately reuse an unlinked
                // inode with identical timestamps within one filesystem tick.
                fs::rename(&path, f.home.join("replaced-song.wav")).unwrap();
                fs::write(&path, bytes).unwrap();
                assert_ne!(
                    identity(&path, &fs::symlink_metadata(&path).unwrap()).unwrap(),
                    target.tree[Path::new("song.wav")].identity,
                    "Fixture must replace the inspected file identity"
                );
            }
        }
        assert!(
            delete(&target, &f.prefs, &|| false).is_err(),
            "change {change}"
        );
        assert!(f.project.exists());
        assert!(f.hidden().is_empty());
        assert!(!f.dirty().is_dirty());
    }
}
#[test]
fn library_root_switch_is_checked_under_the_same_storage_lease() {
    let f = Fixture::new();
    let target = f.target();
    let elsewhere = f.home.join("other library");
    fs::create_dir(&elsewhere).unwrap();
    fs::write(
        f.prefs.join("library.json"),
        serde_json::to_vec(&json!({"projectsRoot":elsewhere})).unwrap(),
    )
    .unwrap();
    assert!(delete(&target, &f.prefs, &|| false).is_err());
    assert!(f.project.exists());
    assert!(f.hidden().is_empty());
}
#[test]
fn active_project_import_or_storage_writer_blocks_deletion() {
    for kind in 0..3 {
        let f = Fixture::new();
        let target = f.target();
        let held = match kind {
            0 => crate::project_publish::lock(&f.project).unwrap(),
            1 => lease(&f.root.join(".singz-native-import.lock"), "root").unwrap(),
            _ => lease(&f.prefs.join("library.lock"), "config").unwrap(),
        };
        assert!(delete(&target, &f.prefs, &|| false).is_err());
        assert!(f.project.exists());
        drop(held);
        delete(&target, &f.prefs, &|| false).unwrap();
        assert!(!f.project.exists());
    }
}
#[test]
fn pending_publication_is_not_silently_recovered_or_removed() {
    let f = Fixture::new();
    fs::write(
        f.project.join(".singz-native-split.json"),
        b"pending recovery",
    )
    .unwrap();
    let target = f.target();
    assert!(delete(&target, &f.prefs, &|| false).is_err());
    assert_eq!(
        fs::read(f.project.join(".singz-native-split.json")).unwrap(),
        b"pending recovery"
    );
}
#[test]
fn cancellation_before_hide_and_after_hide_restore_the_confirmed_project() {
    let f = Fixture::new();
    let target = f.target();
    assert!(delete(&target, &f.prefs, &|| true).is_err());
    assert!(f.project.exists());
    let cancelled = std::sync::atomic::AtomicBool::new(false);
    let result = delete_with(
        &target,
        &f.prefs,
        &|| cancelled.load(Ordering::Acquire),
        |point, _| {
            if point == Point::AfterHide {
                cancelled.store(true, Ordering::Release);
            }
            Ok(())
        },
    );
    assert!(result.is_err());
    assert!(f.project.exists());
    assert!(f.hidden().is_empty());
    assert!(!f.dirty().is_dirty());
}
#[test]
fn precommit_dirty_failure_rolls_back_without_publishing_a_deletion() {
    let f = Fixture::new();
    let target = f.target();
    fs::write(f.prefs.join("sync.json"), b"invalid ledger").unwrap();
    assert!(delete(&target, &f.prefs, &|| false).is_err());
    assert!(f.project.exists());
    assert!(f.hidden().is_empty());
    assert_eq!(
        fs::read(f.project.join("unknown folder/foreign-to-app.bin")).unwrap(),
        b"owned by this project"
    );
}
#[test]
fn rollback_never_replaces_a_new_project_occupying_the_original_name() {
    let f = Fixture::new();
    let target = f.target();
    let result = delete_with(&target, &f.prefs, &|| false, |point, _| {
        if point == Point::AfterHide {
            fs::create_dir(&f.project)?;
            fs::write(f.project.join("foreign.txt"), b"new external project")?;
            anyhow::bail!("injected precommit failure");
        }
        Ok(())
    });
    let message = format!("{:#}", result.unwrap_err());
    assert!(message.contains("rollback refused"));
    assert_eq!(
        fs::read(f.project.join("foreign.txt")).unwrap(),
        b"new external project"
    );
    let hidden = f.hidden();
    assert_eq!(hidden.len(), 1);
    assert!(hidden[0].join("project.json").exists());
    assert!(!f.dirty().is_dirty());
}
#[test]
fn postcommit_cancel_and_cleanup_failure_return_success_with_recovery_warning() {
    for mode in 0..2 {
        let f = Fixture::new();
        let target = f.target();
        let cancel = std::sync::atomic::AtomicBool::new(false);
        let outcome = delete_with(
            &target,
            &f.prefs,
            &|| cancel.load(Ordering::Acquire),
            |point, _| {
                if mode == 0 && point == Point::AfterMark {
                    cancel.store(true, Ordering::Release);
                }
                if mode == 1 && point == Point::BeforeCleanup {
                    anyhow::bail!("injected cleanup refusal");
                }
                Ok(())
            },
        )
        .unwrap();
        assert!(outcome.warning.is_some());
        assert!(!f.project.exists());
        assert_eq!(f.hidden().len(), 1);
        assert!(f.dirty().dirs.contains_key(f.project.to_str().unwrap()));
    }
}
#[test]
fn a_new_project_created_after_commit_survives_cleanup_of_the_hidden_original() {
    let f = Fixture::new();
    let target = f.target();
    let outcome = delete_with(&target, &f.prefs, &|| false, |point, _| {
        if point == Point::AfterMark {
            fs::create_dir(&f.project)?;
            fs::write(f.project.join("new-file"), b"new project")?;
        }
        Ok(())
    })
    .unwrap();
    assert!(outcome.warning.is_none());
    assert_eq!(
        fs::read(f.project.join("new-file")).unwrap(),
        b"new project"
    );
    assert!(f.hidden().is_empty());
}
#[test]
fn metadata_modified_while_hidden_refuses_commit_and_restores_external_edit() {
    let f = Fixture::new();
    let target = f.target();
    let result = delete_with(&target, &f.prefs, &|| false, |point, path| {
        if point == Point::BeforeMark {
            fs::write(path.join("lyrics.json"), b"external late words")?;
        }
        Ok(())
    });
    assert!(result.is_err());
    assert_eq!(
        fs::read(f.project.join("lyrics.json")).unwrap(),
        b"external late words"
    );
    assert!(!f.dirty().is_dirty());
}
#[test]
fn exclusive_hiding_and_rollback_refuse_even_an_empty_foreign_destination() {
    let f = Fixture::new();
    let occupied = f.root.join("occupied");
    fs::create_dir(&occupied).unwrap();
    assert!(exclusive_move(&f.project, &occupied).is_err());
    assert!(f.project.join("project.json").exists());
    assert_eq!(fs::read_dir(occupied).unwrap().count(), 0);
}
#[test]
fn inspection_cancellation_is_checked_during_member_walk() {
    let f = Fixture::new();
    let calls = AtomicU64::new(0);
    assert!(
        inspect_cancel(&f.root, &f.project, &|| calls
            .fetch_add(1, Ordering::Relaxed)
            > 4)
        .is_err()
    );
    assert!(f.project.exists());
    assert!(f.hidden().is_empty());
}
#[test]
fn native_preferences_inside_the_project_cannot_be_deleted() {
    let f = Fixture::new();
    let target = f.target();
    let config = f.project.join("configuration");
    fs::create_dir(&config).unwrap();
    assert!(delete(&target, &config, &|| false).is_err());
    assert!(f.project.exists());
}

#[test]
fn committed_private_cleanup_is_not_listed_as_a_saved_project() {
    let f = Fixture::new();
    let target = f.target();
    delete_with(&target, &f.prefs, &|| false, |point, _| {
        if point == Point::BeforeCleanup {
            anyhow::bail!("leave committed stage for recovery");
        }
        Ok(())
    })
    .unwrap();
    let mut config = crate::project_library::Config::default();
    config.preferences = f.prefs.join("library.json");
    let snapshot = crate::project_library::refresh(&config, &|| false).unwrap();
    assert!(snapshot.projects.is_empty());
    assert_eq!(f.hidden().len(), 1);
}

#[test]
fn recovery_identity_allows_external_metadata_edits_but_refuses_a_replacement_folder() {
    let f = Fixture::new();
    let target = f.target();
    fs::write(
        f.project.join("project.json"),
        br#"{"version":1,"name":"Independently edited","songFile":"song.wav"}"#,
    )
    .unwrap();
    fs::write(f.project.join("lyrics.json"), b"independently saved words").unwrap();
    verify_original_folder(&target)
        .expect("Original folder identity must survive metadata changes");
    let original = f.root.join(".singz-native-delete-recovery-original");
    fs::rename(&f.project, &original).unwrap();
    fs::create_dir(&f.project).unwrap();
    fs::copy(
        original.join("project.json"),
        f.project.join("project.json"),
    )
    .unwrap();
    fs::write(f.project.join("song.wav"), b"foreign replacement audio").unwrap();
    assert!(verify_original_folder(&target).is_err());
    assert_eq!(
        fs::read(f.project.join("song.wav")).unwrap(),
        b"foreign replacement audio"
    );
    assert!(original.join("project.json").exists());
}

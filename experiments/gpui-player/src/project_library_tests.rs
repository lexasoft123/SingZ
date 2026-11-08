use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize};

struct Fixture {
    base: PathBuf,
    config: Config,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!("singz-library-{}", unique()));
        fs::create_dir(&base).unwrap();
        let base = base.canonicalize().unwrap();
        Self {
            config: Config {
                home: base.join("home"),
                default_root: base.join("original"),
                preferences: base.join("config/library.json"),
                override_root: None,
                one_drive: None,
            },
            base,
        }
    }
    fn project(&self, name: &str, saved: &str) -> PathBuf {
        let dir = self.config.default_root.join(name);
        fs::create_dir_all(dir.join("stems")).unwrap();
        fs::write(dir.join("project.json"),serde_json::to_vec(&json!({"version":2,"name":name,"songFile":"song.wav","savedAt":saved,"settings":{},"future":{"keep":true}})).unwrap()).unwrap();
        fs::write(dir.join("song.wav"), b"source-song").unwrap();
        fs::write(
            dir.join("lyrics.json"),
            b"{\"source\":\"edited\",\"credit\":\"Singer\",\"lines\":[]}",
        )
        .unwrap();
        for stem in ["vocals", "drums", "bass", "other"] {
            fs::write(dir.join(format!("stems/{stem}.flac")), stem.as_bytes()).unwrap();
        }
        dir
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn inventory_sorts_and_counts_without_decoding_or_following_foreign_song_paths() {
    let f = Fixture::new();
    f.project("Older", "2024");
    let newer = f.project("Newer", "2025");
    fs::create_dir_all(f.config.default_root.join(".singz-adopting-hidden")).unwrap();
    fs::write(
        f.config
            .default_root
            .join(".singz-adopting-hidden/project.json"),
        b"{}",
    )
    .unwrap();
    let bad = f.config.default_root.join("Foreign");
    fs::create_dir(&bad).unwrap();
    fs::write(
        bad.join("project.json"),
        br#"{"songFile":"../../secret.wav"}"#,
    )
    .unwrap();
    let snapshot = refresh(&f.config, &|| false).unwrap();
    assert!(snapshot.is_default);
    assert_eq!(snapshot.projects.len(), 2);
    let item = &snapshot.projects[0];
    assert_eq!(item.name, "Newer");
    assert_eq!(item.song_path, newer.join("song.wav"));
    assert!(item.has_stems);
    assert_eq!(item.stem_count, 4);
    assert!(item.has_lyrics);
    assert!(item.bytes > 11);
}
#[test]
fn legitimate_hidden_projects_and_their_private_notes_are_preserved() {
    let f = Fixture::new();
    let source = f.project(".Hidden song", "2025");
    fs::write(source.join(".notes"), b"singer notes").unwrap();
    assert_eq!(refresh(&f.config, &|| false).unwrap().projects.len(), 1);
    let target = f.base.join("new");
    let result = set_root(&f.config, Some(target.clone()), &|| false).unwrap();
    assert_eq!(result.copied, 1);
    assert_eq!(result.snapshot.projects[0].name, ".Hidden song");
    assert_eq!(
        fs::read(target.join(".Hidden song/.notes")).unwrap(),
        b"singer notes"
    );
}
#[test]
fn relocation_copies_exact_members_skips_collisions_and_never_deletes_old_library() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    f.project("B", "2024");
    fs::create_dir_all(f.config.preferences.parent().unwrap()).unwrap();
    fs::write(
        &f.config.preferences,
        br#"{"future":{"large":1234567890123456789}}"#,
    )
    .unwrap();
    let target = f.base.join("cloud/SingZ");
    fs::create_dir_all(target.join("B")).unwrap();
    fs::write(target.join("B/keep"), b"target wins").unwrap();
    let changed = set_root(&f.config, Some(target.clone()), &|| false).unwrap();
    assert_eq!(changed.copied, 1);
    assert_eq!(resolved_root(&f.config).unwrap(), target);
    assert!(!changed.snapshot.is_default);
    for member in [
        "project.json",
        "lyrics.json",
        "song.wav",
        "stems/vocals.flac",
    ] {
        assert_eq!(
            fs::read(a.join(member)).unwrap(),
            fs::read(target.join("A").join(member)).unwrap()
        );
    }
    assert_eq!(fs::read(target.join("B/keep")).unwrap(), b"target wins");
    assert!(!target.join("B/project.json").exists());
    assert!(a.is_dir());
    let (raw, _) = preferences(&f.config).unwrap();
    assert_eq!(raw["future"]["large"], json!(1234567890123456789u64));
    let reset = set_root(&f.config, None, &|| false).unwrap();
    assert!(reset.snapshot.is_default);
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert!(target.join("A/song.wav").exists());
}
#[test]
fn cancellation_during_copy_leaves_selected_root_and_no_partial_project() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    fs::write(a.join("large.bin"), vec![7; 1024 * 1024]).unwrap();
    let target = f.base.join("new");
    let polls = AtomicUsize::new(0);
    assert!(
        set_root(&f.config, Some(target.clone()), &|| polls
            .fetch_add(1, Ordering::Relaxed)
            > 15)
        .is_err()
    );
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert!(!f.config.preferences.exists());
    assert!(!target.join("A").exists());
    assert!(fs::read_dir(&target).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".singz-adopting-")
    }));
    assert_eq!(
        fs::metadata(a.join("large.bin")).unwrap().len(),
        1024 * 1024
    );
}
#[cfg(unix)]
#[test]
fn linked_or_special_members_refuse_migration_and_keep_preferences() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    let secret = f.base.join("secret");
    fs::write(&secret, b"private").unwrap();
    std::os::unix::fs::symlink(&secret, a.join("linked.txt")).unwrap();
    let target = f.base.join("new");
    assert!(set_root(&f.config, Some(target.clone()), &|| false).is_err());
    assert!(!target.join("A").exists());
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert_eq!(fs::read(secret).unwrap(), b"private");
}
#[test]
fn external_preferences_change_during_migration_refuses_root_switch() {
    let f = Fixture::new();
    f.project("A", "2025");
    let target = f.base.join("new");
    let changed = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        if target.join("A").exists() && !changed.swap(true, Ordering::AcqRel) {
            fs::write(&f.config.preferences, b"{\"future\":\"external\"}").unwrap();
        }
        false
    });
    assert!(result.is_err());
    assert!(changed.load(Ordering::Acquire));
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert_eq!(
        fs::read(&f.config.preferences).unwrap(),
        b"{\"future\":\"external\"}"
    );
    assert!(target.join("A/song.wav").is_file());
}
#[test]
fn exclusive_publish_never_replaces_an_existing_empty_directory() {
    let f = Fixture::new();
    let staged = f.base.join("stage");
    let target = f.base.join("collision");
    fs::create_dir(&staged).unwrap();
    fs::write(staged.join("new"), b"new").unwrap();
    fs::create_dir(&target).unwrap();
    assert!(publish_directory(&staged, &target).is_err());
    assert!(!target.join("new").exists());
    assert!(staged.join("new").exists());
}
#[test]
fn detects_cloud_folders_once_per_provider_and_only_when_present() {
    let mut f = Fixture::new();
    fs::create_dir_all(f.config.home.join("iCloudDrive")).unwrap();
    fs::create_dir_all(
        f.config
            .home
            .join("Library/CloudStorage/GoogleDrive-account/My Drive"),
    )
    .unwrap();
    f.config.one_drive = Some(f.base.join("OneDrive-personal"));
    fs::create_dir_all(f.config.one_drive.as_ref().unwrap()).unwrap();
    let roots = cloud_roots(&f.config, &|| false).unwrap();
    assert_eq!(roots.len(), 3);
    assert_eq!(roots[0].label, "iCloud Drive");
    assert_eq!(roots[0].path, f.config.home.join("iCloudDrive/SingZ"));
    assert_eq!(roots[2].label, "Google Drive");
}
#[test]
fn rejects_nested_library_migrations_before_copying() {
    let f = Fixture::new();
    f.project("A", "2025");
    assert!(
        set_root(
            &f.config,
            Some(f.config.default_root.join("nested")),
            &|| false
        )
        .is_err()
    );
    assert!(!f.config.preferences.exists());
}
#[test]
fn persisted_selection_overrides_isolated_default_and_reset_restores_it() {
    let mut f = Fixture::new();
    let isolated = f.base.join("isolated");
    fs::create_dir(&isolated).unwrap();
    f.config.override_root = Some(isolated.clone());
    assert_eq!(resolved_root(&f.config).unwrap(), isolated);
    assert!(refresh(&f.config, &|| false).unwrap().is_default);
    let custom = f.base.join("chosen");
    let changed = set_root(&f.config, Some(custom.clone()), &|| false).unwrap();
    assert_eq!(changed.snapshot.root, custom);
    assert_eq!(resolved_root(&f.config).unwrap(), custom);
    let reset = set_root(&f.config, None, &|| false).unwrap();
    assert!(reset.snapshot.is_default);
    assert_eq!(resolved_root(&f.config).unwrap(), isolated);
}
#[test]
fn source_change_after_copy_refuses_publication_and_keeps_old_root() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    let target = f.base.join("new");
    let changed = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        let staged = fs::read_dir(&target).ok().and_then(|mut entries| {
            entries.find_map(|entry| {
                entry.ok().filter(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(".singz-adopting-")
                })
            })
        });
        if staged.is_some_and(|entry| entry.path().join("stems/vocals.flac").exists())
            && !changed.swap(true, Ordering::AcqRel)
        {
            fs::write(a.join("project.json"), b"changed metadata").unwrap();
        }
        false
    });
    assert!(changed.load(Ordering::Acquire));
    assert!(result.is_err());
    assert!(!target.join("A").exists());
    assert!(!f.config.preferences.exists());
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
}
#[test]
fn target_appearing_during_copy_is_never_overwritten_or_selected() {
    let f = Fixture::new();
    f.project("A", "2025");
    let target = f.base.join("new");
    let collided = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        let copying = fs::read_dir(&target).is_ok_and(|entries| {
            entries.filter_map(|e| e.ok()).any(|e| {
                e.file_name()
                    .to_string_lossy()
                    .starts_with(".singz-adopting-")
            })
        });
        if copying && !collided.swap(true, Ordering::AcqRel) {
            fs::create_dir(target.join("A")).unwrap();
            fs::write(target.join("A/external"), b"winner").unwrap();
        }
        false
    });
    assert!(result.is_err());
    assert!(collided.load(Ordering::Acquire));
    assert_eq!(fs::read(target.join("A/external")).unwrap(), b"winner");
    assert!(!target.join("A/project.json").exists());
    assert!(!f.config.preferences.exists());
}
#[test]
fn oversize_metadata_refuses_before_reading_and_sparse_members_before_copying() {
    let f = Fixture::new();
    fs::create_dir_all(f.config.preferences.parent().unwrap()).unwrap();
    File::create(&f.config.preferences)
        .unwrap()
        .set_len(65537)
        .unwrap();
    assert!(refresh(&f.config, &|| false).is_err());
    fs::remove_file(&f.config.preferences).unwrap();
    let a = f.project("A", "2025");
    File::create(a.join("oversize.bin"))
        .unwrap()
        .set_len(MAX_MEMBER + 1)
        .unwrap();
    assert!(set_root(&f.config, Some(f.base.join("new")), &|| false).is_err());
    assert!(!f.config.preferences.exists());
}
#[test]
fn late_external_source_edit_keeps_old_selection_and_complete_copied_project() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    let target = f.base.join("new");
    let changed = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        if target.join("A/project.json").exists() && !changed.swap(true, Ordering::AcqRel) {
            fs::write(a.join("lyrics.json"), b"newer accepted external text").unwrap();
        }
        false
    });
    assert!(changed.load(Ordering::Acquire));
    assert!(result.is_err());
    assert!(!f.config.preferences.exists());
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert!(target.join("A/song.wav").exists());
    assert_eq!(
        fs::read(a.join("lyrics.json")).unwrap(),
        b"newer accepted external text"
    );
}
#[test]
fn completed_copies_keep_native_source_writer_leases_until_root_commit() {
    let f = Fixture::new();
    let a = f.project("A", "2025");
    let target = f.base.join("new");
    let probed = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        if target.join("A/project.json").exists() && !probed.swap(true, Ordering::AcqRel) {
            assert!(crate::project_publish::lock(&a).is_err());
        }
        false
    })
    .unwrap();
    assert_eq!(result.copied, 1);
    assert!(probed.load(Ordering::Acquire));
    assert!(crate::project_publish::lock(&a).is_ok());
}
#[test]
fn a_project_added_after_copy_refuses_switch_instead_of_orphaning_the_new_song() {
    let f = Fixture::new();
    f.project("A", "2025");
    let target = f.base.join("new");
    let added = AtomicBool::new(false);
    let result = set_root(&f.config, Some(target.clone()), &|| {
        if target.join("A/project.json").exists() && !added.swap(true, Ordering::AcqRel) {
            f.project("Late arrival", "2026");
        }
        false
    });
    assert!(result.is_err());
    assert!(added.load(Ordering::Acquire));
    assert_eq!(resolved_root(&f.config).unwrap(), f.config.default_root);
    assert!(
        f.config
            .default_root
            .join("Late arrival/song.wav")
            .is_file()
    );
}
#[test]
fn missing_root_keeps_the_same_identity_after_its_first_project_save() {
    let mut f = Fixture::new();
    f.config.override_root = Some(f.base.join("not-created/nested/library"));
    let before = resolved_root(&f.config).unwrap();
    let initial = refresh(&f.config, &|| false).unwrap();
    assert_eq!(initial.root, before);
    assert!(initial.is_default);
    fs::create_dir_all(&before).unwrap();
    assert_eq!(resolved_root(&f.config).unwrap(), before);
    assert_eq!(refresh(&f.config, &|| false).unwrap().root, before);
}
#[cfg(unix)]
#[test]
fn missing_library_under_a_symlinked_ancestor_has_canonical_identity_before_creation() {
    let mut f = Fixture::new();
    let real = f.base.join("real");
    let alias = f.base.join("alias");
    fs::create_dir(&real).unwrap();
    std::os::unix::fs::symlink(&real, &alias).unwrap();
    f.config.override_root = Some(alias.join("missing/SingZ"));
    let expected = real.join("missing/SingZ");
    assert_eq!(resolved_root(&f.config).unwrap(), expected);
    assert_eq!(refresh(&f.config, &|| false).unwrap().root, expected);
    fs::create_dir_all(alias.join("missing/SingZ")).unwrap();
    assert_eq!(resolved_root(&f.config).unwrap(), expected);
}
#[cfg(unix)]
#[test]
fn tmp_library_alias_is_stable_before_and_after_creation() {
    let path = PathBuf::from("/tmp").join(format!("singz-library-missing-{}", unique()));
    let _cleanup = Pending(path.clone());
    let expected = Path::new("/tmp")
        .canonicalize()
        .unwrap()
        .join(path.file_name().unwrap())
        .join("nested");
    assert_eq!(normalize_root(&path.join("nested")), expected);
    fs::create_dir_all(path.join("nested")).unwrap();
    assert_eq!(normalize_root(&path.join("nested")), expected);
}
#[test]
fn explicit_empty_documents_are_listed_by_project_path_without_resurrecting_retained_audio() {
    let f = Fixture::new();
    let dir = f.project("Empty document", "2026");
    let mut raw: Value =
        serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap();
    raw["settings"] = json!({"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    let original = fs::read(dir.join("song.wav")).unwrap();
    let item = project_item(&dir, &|| false).unwrap().unwrap();
    assert_eq!(item.song_path, dir.join("project.json"));
    assert!(!item.has_stems);
    assert_eq!(item.stem_count, 0);
    assert!(item.has_lyrics);
    assert_eq!(fs::read(dir.join("song.wav")).unwrap(), original);
    assert_eq!(refresh(&f.config, &|| false).unwrap().projects.len(), 1);
}
#[test]
fn custom_only_documents_without_original_audio_use_real_metadata_open_target() {
    let f = Fixture::new();
    let dir = f.project("Custom only", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for stem in ["vocals", "drums", "bass", "other"] {
        fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
    }
    fs::write(
        dir.join("stems/custom-harmony.mp3"),
        b"ID3 actual stored custom member",
    )
    .unwrap();
    let raw = json!({"version":2,"name":"Custom only","songFile":"missing-original.wav","settings":{"nativeOriginalDisabled":true,"custom":[{"id":"custom-harmony","label":"Harmony","color":"#8fd3ff","file":"stems/custom-harmony.mp3"}]}});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    let item = project_item(&dir, &|| false).unwrap().unwrap();
    assert_eq!(item.song_path, dir.join("project.json"));
    assert_eq!(item.stem_count, 0);
    assert!(dir.join("stems/custom-harmony.mp3").is_file());
}
#[test]
fn corrupt_or_legacy_missing_audio_never_becomes_an_implicit_empty_document() {
    let f = Fixture::new();
    let dir = f.project("Broken", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for stem in ["vocals", "drums", "bass", "other"] {
        fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
    }
    assert!(project_item(&dir, &|| false).unwrap().is_none());
    let mut raw: Value =
        serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap();
    raw["settings"] = json!({"nativeEmptyTracks":true,"custom":"malformed"});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(project_item(&dir, &|| false).is_err());
    raw["settings"] = json!({"custom":[{"id":"custom-forged","file":"../outside.mp3"}]});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(project_item(&dir, &|| false).unwrap().is_none());
    fs::write(dir.join("stems/custom-present.mp3"), b"ID3 data").unwrap();
    raw["settings"] = json!({"nativeEmptyTracks":true,"custom":[{"id":"custom-present","file":"stems/custom-present.mp3"}]});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(project_item(&dir, &|| false).is_err());
}
#[cfg(unix)]
#[test]
fn linked_custom_media_cannot_make_a_missing_audio_document_appear_playable() {
    let f = Fixture::new();
    let dir = f.project("Linked custom", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for stem in ["vocals", "drums", "bass", "other"] {
        fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
    }
    let outside = f.base.join("outside.mp3");
    fs::write(&outside, b"foreign audio").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("stems/custom-linked.mp3")).unwrap();
    let raw = json!({"version":2,"songFile":"missing.wav","settings":{"nativeOriginalDisabled":true,"custom":[{"id":"custom-linked","file":"stems/custom-linked.mp3"}]}});
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert!(project_item(&dir, &|| false).unwrap().is_none());
    assert_eq!(fs::read(outside).unwrap(), b"foreign audio");
}

#[test]
fn ordinary_stem_only_projects_without_or_with_missing_original_use_metadata_target() {
    let f = Fixture::new();
    for (name, song) in [
        ("No original", None),
        ("Missing original", Some("missing.wav")),
    ] {
        let dir = f.project(name, "2026");
        fs::remove_file(dir.join("song.wav")).unwrap();
        for stem in ["vocals", "drums", "bass", "other"] {
            fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
        }
        // A real, minimal PCM16 mono WAV; inventory itself performs no decode.
        let mut wav = b"RIFF".to_vec();
        wav.extend_from_slice(&38u32.to_le_bytes());
        wav.extend_from_slice(b"WAVEfmt ");
        wav.extend_from_slice(&16u32.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&1u16.to_le_bytes());
        wav.extend_from_slice(&8000u32.to_le_bytes());
        wav.extend_from_slice(&16000u32.to_le_bytes());
        wav.extend_from_slice(&2u16.to_le_bytes());
        wav.extend_from_slice(&16u16.to_le_bytes());
        wav.extend_from_slice(b"data");
        wav.extend_from_slice(&2u32.to_le_bytes());
        wav.extend_from_slice(&0i16.to_le_bytes());
        fs::write(dir.join("stems/vocals.wav"), &wav).unwrap();
        fs::write(dir.join("stems/drums.wav"), &wav).unwrap();
        let mut raw: Value =
            serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap();
        if let Some(song) = song {
            raw["songFile"] = json!(song);
        } else {
            raw.as_object_mut().unwrap().remove("songFile");
        }
        fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
        let item = project_item(&dir, &|| false).unwrap().unwrap();
        assert_eq!(item.song_path, dir.join("project.json"));
        assert_eq!(item.stem_count, 2);
        assert!(!item.has_stems);
    }
    let snapshot = refresh(&f.config, &|| false).unwrap();
    assert_eq!(snapshot.projects.len(), 2);
    assert!(
        snapshot
            .projects
            .iter()
            .all(|p| p.song_path == p.dir.join("project.json"))
    );
}
#[test]
fn valid_stems_do_not_admit_malformed_explicit_original_paths() {
    let f = Fixture::new();
    let dir = f.project("Unsafe original", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for song in [
        json!("../outside.wav"),
        json!("..\\outside.wav"),
        json!("C:\\outside.wav"),
        json!("C:outside.wav"),
        json!("\\\\server\\outside.wav"),
        json!("nested/..\\outside.wav"),
        json!("nested/C:/outside.wav"),
        json!("nested\\D:outside.wav"),
        json!("nested/./outside.wav"),
        json!("nested\\.\\outside.wav"),
        json!("nested\0outside.wav"),
        json!(f.base.join("outside.wav")),
        json!(3),
        json!(""),
    ] {
        let raw = json!({"version":2,"songFile":song,"settings":{}});
        fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
        assert!(project_item(&dir, &|| false).is_err(), "{song}");
    }
}
#[test]
fn empty_or_unrecognized_stem_files_cannot_admit_missing_audio_project() {
    let f = Fixture::new();
    let dir = f.project("No playable stems", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for stem in ["vocals", "drums", "bass", "other"] {
        fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
    }
    fs::write(dir.join("stems/vocals.wav"), []).unwrap();
    fs::write(dir.join("stems/unrelated.wav"), b"unrelated media").unwrap();
    assert!(project_item(&dir, &|| false).unwrap().is_none());
}
#[cfg(unix)]
#[test]
fn linked_stem_file_or_directory_cannot_admit_missing_original() {
    let f = Fixture::new();
    let dir = f.project("Linked stems", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    for stem in ["vocals", "drums", "bass", "other"] {
        fs::remove_file(dir.join(format!("stems/{stem}.flac"))).unwrap();
    }
    let outside = f.base.join("outside.wav");
    fs::write(&outside, b"external media").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("stems/vocals.wav")).unwrap();
    assert!(project_item(&dir, &|| false).unwrap().is_none());
    fs::remove_file(dir.join("stems/vocals.wav")).unwrap();
    fs::remove_dir(dir.join("stems")).unwrap();
    let external_stems = f.base.join("external-stems");
    fs::create_dir(&external_stems).unwrap();
    fs::write(external_stems.join("vocals.wav"), b"external stem").unwrap();
    std::os::unix::fs::symlink(&external_stems, dir.join("stems")).unwrap();
    assert!(project_item(&dir, &|| false).unwrap().is_none());
    assert_eq!(fs::read(outside).unwrap(), b"external media");
}
#[cfg(unix)]
#[test]
fn linked_original_is_refused_even_with_ordinary_available_stems() {
    let f = Fixture::new();
    let dir = f.project("Linked original", "2026");
    fs::remove_file(dir.join("song.wav")).unwrap();
    let outside = f.base.join("original.wav");
    fs::write(&outside, b"external original").unwrap();
    std::os::unix::fs::symlink(&outside, dir.join("song.wav")).unwrap();
    assert!(project_item(&dir, &|| false).is_err());
}

#[test]
fn safe_nested_original_paths_remain_available_and_missing_nested_paths_use_stems() {
    let f = Fixture::new();
    let dir = f.project("Nested original", "2026");
    fs::create_dir(dir.join("audio")).unwrap();
    fs::rename(dir.join("song.wav"), dir.join("audio/song.wav")).unwrap();
    let mut raw: Value =
        serde_json::from_slice(&fs::read(dir.join("project.json")).unwrap()).unwrap();
    raw["songFile"] = json!("audio/song.wav");
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert_eq!(
        project_item(&dir, &|| false).unwrap().unwrap().song_path,
        dir.join("audio/song.wav")
    );
    fs::remove_file(dir.join("audio/song.wav")).unwrap();
    assert_eq!(
        project_item(&dir, &|| false).unwrap().unwrap().song_path,
        dir.join("project.json")
    );
    // Relative Windows separators are safe references too. On Unix the
    // original is unavailable under that spelling, so ordinary stems admit it.
    raw["songFile"] = json!("audio\\song.wav");
    fs::write(dir.join("project.json"), serde_json::to_vec(&raw).unwrap()).unwrap();
    assert_eq!(
        project_item(&dir, &|| false).unwrap().unwrap().song_path,
        dir.join("project.json")
    );
}

use super::*;
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
static NEXT: AtomicUsize = AtomicUsize::new(0);
struct Fixture {
    base: PathBuf,
    config: crate::project_library::Config,
    source: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "singz-project-import-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let source = base.join("shared/Source");
        fs::create_dir_all(source.join("stems")).unwrap();
        fs::write(source.join("project.json"),br#"{ "version":2,"name":"Singer: Song.mp3","songFile":"song.wav","settings":{"custom":[{"id":"my-track","file":"stems/mine.wav"}]},"future":{"large":1234567890123456789} }"#).unwrap();
        fs::write(source.join("song.wav"), b"song").unwrap();
        fs::write(source.join("stems/mine.wav"), b"private custom track").unwrap();
        fs::write(
            source.join("lyrics.json"),
            b"{\"credit\":\"Singer\",\"source\":\"edited\",\"lines\":[]}",
        )
        .unwrap();
        fs::write(source.join(".notes"), b"notes").unwrap();
        let config = crate::project_library::Config {
            home: base.join("home"),
            default_root: base.join("library"),
            preferences: base.join("config/library.json"),
            override_root: None,
            one_drive: None,
        };
        Self {
            base,
            config,
            source,
        }
    }
    fn input(&self, mode: Mode) -> Input {
        Input {
            source: self.source.clone(),
            root: crate::project_library::resolved_root(&self.config).unwrap(),
            expected_project: crate::project_store::fingerprint(
                &fs::read(self.source.join("project.json")).unwrap(),
            ),
            expected_lyrics: crate::lyrics_store::identity(&self.source).unwrap(),
            mode,
        }
    }
    fn execute(&self, input: &Input, force_copy: bool) -> Outcome {
        execute_with_config(input, &self.config, &|| false, force_copy)
    }
    fn destination(&self) -> PathBuf {
        self.config.default_root.join("Singer Song")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}

#[test]
fn copy_preserves_raw_metadata_lyrics_custom_files_and_original() {
    let f = Fixture::new();
    let input = f.input(Mode::Copy);
    let result = f.execute(&input, false);
    assert!(result.imported);
    assert!(!result.moved);
    assert!(result.warning.is_none());
    assert_eq!(result.dir, f.destination());
    for file in [
        "project.json",
        "lyrics.json",
        "song.wav",
        "stems/mine.wav",
        ".notes",
    ] {
        assert_eq!(
            fs::read(f.source.join(file)).unwrap(),
            fs::read(result.dir.join(file)).unwrap()
        );
    }
    assert!(f.source.exists());
    assert!(!f.config.preferences.exists());
}
#[test]
fn move_relocates_the_actual_source_directory_without_copying_on_the_same_volume() {
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    let before = fs::metadata(f.source.join("song.wav")).unwrap();
    let result = f.execute(&input, false);
    assert!(result.imported && result.moved);
    assert!(result.warning.is_none());
    assert!(!f.source.exists());
    assert_eq!(
        fs::read(result.dir.join("stems/mine.wav")).unwrap(),
        b"private custom track"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(
            before.ino(),
            fs::metadata(result.dir.join("song.wav")).unwrap().ino()
        );
    }
    #[cfg(not(unix))]
    let _ = before;
}
#[test]
fn cross_device_move_copies_completely_then_removes_the_original() {
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    let raw = fs::read(f.source.join("project.json")).unwrap();
    let result = f.execute(&input, true);
    assert!(result.imported && result.moved);
    assert!(result.warning.is_none());
    assert!(!f.source.exists());
    assert_eq!(fs::read(result.dir.join("project.json")).unwrap(), raw);
}
#[test]
fn existing_name_is_a_conflict_without_suffix_or_replacement() {
    for mode in [Mode::Copy, Mode::Move] {
        let f = Fixture::new();
        fs::create_dir_all(f.destination()).unwrap();
        fs::write(f.destination().join("existing"), b"keep").unwrap();
        let result = f.execute(&f.input(mode), false);
        assert!(!result.imported && !result.moved);
        assert_eq!(result.dir, f.source);
        assert!(result.warning.unwrap().contains("already in the library"));
        assert_eq!(fs::read(f.destination().join("existing")).unwrap(), b"keep");
        assert!(!f.destination().join("song.wav").exists());
        assert!(!f.config.default_root.join("Singer Song (1)").exists());
    }
}
#[test]
fn independently_changed_project_or_lyrics_refuses_both_import_modes() {
    for mode in [Mode::Copy, Mode::Move] {
        for file in ["project.json", "lyrics.json"] {
            let f = Fixture::new();
            let input = f.input(mode);
            fs::write(f.source.join(file), b"external edit").unwrap();
            let result = f.execute(&input, false);
            assert!(!result.imported);
            assert_eq!(result.dir, f.source);
            assert!(result.warning.unwrap().contains("changed outside"));
            assert!(!f.destination().exists());
            assert_eq!(fs::read(f.source.join(file)).unwrap(), b"external edit");
        }
    }
}
#[test]
fn changed_library_selection_refuses_instead_of_importing_to_a_different_root() {
    let f = Fixture::new();
    let input = f.input(Mode::Copy);
    crate::project_library::set_root(&f.config, Some(f.base.join("other-library")), &|| false)
        .unwrap();
    let result = f.execute(&input, false);
    assert!(!result.imported);
    assert!(result.warning.unwrap().contains("library folder changed"));
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
}
#[test]
fn cancellation_during_staged_copy_cleans_private_temps_and_preserves_source() {
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    fs::write(f.source.join("large.bin"), vec![0; 1024 * 1024]).unwrap();
    let count = AtomicUsize::new(0);
    let result = execute_with_config(
        &input,
        &f.config,
        &|| count.fetch_add(1, Ordering::Relaxed) > 12,
        true,
    );
    assert!(!result.imported);
    assert_eq!(result.dir, f.source);
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
    assert!(fs::read_dir(&f.config.default_root).unwrap().all(|e| {
        !e.unwrap()
            .file_name()
            .to_string_lossy()
            .starts_with(".singz-adopting-")
    }));
}
#[test]
fn cancellation_after_cross_device_publication_retains_both_valid_projects() {
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    let result = execute_with_config(
        &input,
        &f.config,
        &|| f.destination().join("project.json").exists(),
        true,
    );
    assert!(result.imported);
    assert!(!result.moved);
    assert!(result.warning.is_some());
    assert_eq!(result.dir, f.destination());
    for dir in [&f.source, &result.dir] {
        assert_eq!(fs::read(dir.join("song.wav")).unwrap(), b"song");
    }
}
#[test]
fn source_edit_after_publication_is_preserved_instead_of_deleted_by_move_cleanup() {
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    let changed = AtomicBool::new(false);
    let result = execute_with_config(
        &input,
        &f.config,
        &|| {
            if f.destination().join("project.json").exists()
                && !changed.swap(true, Ordering::AcqRel)
            {
                fs::write(f.source.join("lyrics.json"), b"new correction").unwrap();
            }
            false
        },
        true,
    );
    assert!(changed.load(Ordering::Acquire));
    assert!(result.imported && !result.moved);
    assert!(result.warning.is_some());
    assert_eq!(result.dir, f.destination());
    assert_eq!(
        fs::read(f.source.join("lyrics.json")).unwrap(),
        b"new correction"
    );
    assert!(result.dir.join("song.wav").exists());
}
#[cfg(unix)]
#[test]
fn linked_foreign_members_are_refused_for_copy_and_move() {
    for mode in [Mode::Copy, Mode::Move] {
        let f = Fixture::new();
        let external = f.base.join("external");
        fs::write(&external, b"private").unwrap();
        std::os::unix::fs::symlink(&external, f.source.join("foreign")).unwrap();
        let result = f.execute(&f.input(mode), false);
        assert!(!result.imported);
        assert!(result.warning.is_some());
        assert!(f.source.is_dir());
        assert!(!f.destination().exists());
        assert_eq!(fs::read(external).unwrap(), b"private");
    }
}
#[test]
fn already_in_library_and_busy_native_writer_are_refused_without_changes() {
    let f = Fixture::new();
    let mut input = f.input(Mode::Copy);
    fs::create_dir_all(&f.config.default_root).unwrap();
    let in_library = f.config.default_root.join("Existing");
    fs::rename(&f.source, &in_library).unwrap();
    input.source = in_library.clone();
    let result = f.execute(&input, false);
    assert!(!result.imported);
    assert!(result.warning.unwrap().contains("already in the library"));
    assert!(in_library.join("song.wav").exists());
    let f = Fixture::new();
    let input = f.input(Mode::Move);
    let _lease = crate::project_publish::lock(&f.source).unwrap();
    let result = f.execute(&input, false);
    assert!(!result.imported);
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
}
#[test]
fn absent_lyrics_identity_is_not_permission_to_overwrite_new_external_lyrics() {
    let f = Fixture::new();
    fs::remove_file(f.source.join("lyrics.json")).unwrap();
    let input = f.input(Mode::Copy);
    assert!(input.expected_lyrics.is_none());
    fs::write(f.source.join("lyrics.json"), b"new external lyrics").unwrap();
    let result = f.execute(&input, false);
    assert!(!result.imported);
    assert_eq!(result.dir, f.source);
    assert!(!f.destination().exists());
    assert_eq!(
        fs::read(f.source.join("lyrics.json")).unwrap(),
        b"new external lyrics"
    );
}
#[test]
fn a_destination_created_during_staging_is_not_replaced() {
    let f = Fixture::new();
    let input = f.input(Mode::Copy);
    let conflicted = AtomicBool::new(false);
    let result = execute_with_config(
        &input,
        &f.config,
        &|| {
            let copying = fs::read_dir(&f.config.default_root).is_ok_and(|entries| {
                entries.filter_map(|e| e.ok()).any(|e| {
                    e.file_name()
                        .to_string_lossy()
                        .starts_with(".singz-adopting-")
                })
            });
            if copying && !conflicted.swap(true, Ordering::AcqRel) {
                fs::create_dir(f.destination()).unwrap();
                fs::write(f.destination().join("external"), b"keep").unwrap();
            }
            false
        },
        false,
    );
    assert!(conflicted.load(Ordering::Acquire));
    assert!(!result.imported);
    assert!(f.source.join("song.wav").is_file());
    assert_eq!(fs::read(f.destination().join("external")).unwrap(), b"keep");
    assert!(!f.destination().join("project.json").exists());
}
#[test]
fn native_root_publication_lease_refuses_parallel_import() {
    let f = Fixture::new();
    fs::create_dir_all(&f.config.default_root).unwrap();
    let _lease = root_lease(&f.config.default_root).unwrap();
    let result = f.execute(&f.input(Mode::Move), false);
    assert!(!result.imported);
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
}
#[test]
fn oversized_source_members_refuse_even_a_same_volume_move() {
    let f = Fixture::new();
    File::create(f.source.join("oversize.bin"))
        .unwrap()
        .set_len(8 * 1024 * 1024 * 1024 + 1)
        .unwrap();
    let result = f.execute(&f.input(Mode::Move), false);
    assert!(!result.imported);
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
    assert!(result.warning.unwrap().contains("limit"));
}
#[test]
fn shared_stem_only_project_copies_and_moves_without_an_original_mix() {
    for (mode, force_copy) in [(Mode::Copy, false), (Mode::Move, false), (Mode::Move, true)] {
        let f = Fixture::new();
        fs::remove_file(f.source.join("song.wav")).unwrap();
        for stem in ["vocals", "drums", "bass", "other"] {
            fs::write(f.source.join(format!("stems/{stem}.flac")), stem.as_bytes()).unwrap();
        }
        let input = f.input(mode);
        let raw = fs::read(f.source.join("project.json")).unwrap();
        let result = f.execute(&input, force_copy);
        assert!(result.imported);
        assert_eq!(result.moved, mode == Mode::Move);
        assert!(result.warning.is_none());
        assert!(!result.dir.join("song.wav").exists());
        assert_eq!(fs::read(result.dir.join("project.json")).unwrap(), raw);
        for stem in ["vocals", "drums", "bass", "other"] {
            assert_eq!(
                fs::read(result.dir.join(format!("stems/{stem}.flac"))).unwrap(),
                stem.as_bytes()
            );
        }
        assert_eq!(f.source.exists(), mode == Mode::Copy);
    }
}
#[test]
fn missing_all_native_audio_is_refused_even_with_an_unrelated_custom_file() {
    for mode in [Mode::Copy, Mode::Move] {
        let f = Fixture::new();
        fs::remove_file(f.source.join("song.wav")).unwrap();
        let result = f.execute(&f.input(mode), false);
        assert!(!result.imported);
        assert!(!result.moved);
        assert_eq!(result.dir, f.source);
        assert!(result.warning.unwrap().contains("no playable"));
        assert!(!f.destination().exists());
        assert!(f.source.join("stems/mine.wav").exists());
    }
}
#[test]
fn missing_original_never_waives_an_escaping_song_path_or_damaged_stem_hash() {
    for bad in [
        serde_json::json!({"songFile":"../outside.wav"}),
        serde_json::json!({"stemHashes":{"vocals.flac":{"size":999}}}),
    ] {
        let f = Fixture::new();
        fs::remove_file(f.source.join("song.wav")).unwrap();
        fs::write(f.source.join("stems/vocals.flac"), b"vocals").unwrap();
        let mut raw: serde_json::Value =
            serde_json::from_slice(&fs::read(f.source.join("project.json")).unwrap()).unwrap();
        raw.as_object_mut()
            .unwrap()
            .extend(bad.as_object().unwrap().clone());
        fs::write(
            f.source.join("project.json"),
            serde_json::to_vec(&raw).unwrap(),
        )
        .unwrap();
        let result = f.execute(&f.input(Mode::Move), false);
        assert!(!result.imported);
        assert!(result.warning.is_some());
        assert!(f.source.join("stems/vocals.flac").exists());
        assert!(!f.destination().exists());
    }
}

#[test]
fn explicitly_empty_documents_copy_and_move_without_creating_audio() {
    for (mode, force_copy) in [(Mode::Copy, false), (Mode::Move, false), (Mode::Move, true)] {
        let f = Fixture::new();
        fs::remove_file(f.source.join("song.wav")).unwrap();
        let raw = serde_json::json!({"version":2,"name":"Singer: Song.mp3","songFile":"song.wav",
            "settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]},
            "future":{"untouched":true}});
        let bytes = serde_json::to_vec(&raw).unwrap();
        fs::write(f.source.join("project.json"), &bytes).unwrap();
        let lyrics = fs::read(f.source.join("lyrics.json")).unwrap();
        let result = f.execute(&f.input(mode), force_copy);
        assert!(result.imported && result.warning.is_none(), "{:?}", result);
        assert_eq!(result.moved, mode == Mode::Move);
        assert_eq!(fs::read(result.dir.join("project.json")).unwrap(), bytes);
        assert_eq!(fs::read(result.dir.join("lyrics.json")).unwrap(), lyrics);
        assert!(!result.dir.join("song.wav").exists());
        assert_eq!(
            fs::read(result.dir.join("stems/mine.wav")).unwrap(),
            b"private custom track"
        );
        assert_eq!(f.source.exists(), mode == Mode::Copy);
    }
}

#[test]
fn arbitrary_encoded_custom_only_documents_copy_and_move_with_stable_metadata() {
    for (mode, force_copy) in [(Mode::Copy, false), (Mode::Move, false), (Mode::Move, true)] {
        let f = Fixture::new();
        fs::remove_file(f.source.join("song.wav")).unwrap();
        fs::write(
            f.source.join("stems/custom-voice.ogg"),
            b"original encoded ogg",
        )
        .unwrap();
        let raw = serde_json::json!({"version":2,"name":"Singer: Song.mp3","songFile":"song.wav",
            "settings":{"nativeOriginalDisabled":true,"custom":[
                {"id":"custom-voice","file":"stems/custom-voice.ogg","label":"My Voice","color":"#123456"}]}});
        let bytes = serde_json::to_vec(&raw).unwrap();
        fs::write(f.source.join("project.json"), &bytes).unwrap();
        let result = f.execute(&f.input(mode), force_copy);
        assert!(result.imported && result.warning.is_none(), "{:?}", result);
        assert_eq!(fs::read(result.dir.join("project.json")).unwrap(), bytes);
        assert_eq!(
            fs::read(result.dir.join("stems/custom-voice.ogg")).unwrap(),
            b"original encoded ogg"
        );
        assert_eq!(f.source.exists(), mode == Mode::Copy);
    }
}

#[test]
fn empty_admission_requires_an_explicit_consistent_marker_not_missing_audio() {
    for settings in [
        serde_json::json!({"custom":[]}),
        serde_json::json!({"nativeEmptyTracks":true}),
        serde_json::json!({"nativeEmptyTracks":true,"custom":[{"id":"custom-missing","file":"stems/missing.wav"}]}),
        serde_json::json!({"nativeEmptyTracks":"true","custom":[]}),
        serde_json::json!({"nativeEmptyTracks":true,"nativeOriginalDisabled":"true","custom":[]}),
        serde_json::json!({"custom":[{"id":"custom-missing","file":"stems/missing.wav"}]}),
        serde_json::json!({"custom":[{"id":"custom-outside","file":"../outside.wav"}]}),
    ] {
        for mode in [Mode::Copy, Mode::Move] {
            let f = Fixture::new();
            fs::remove_file(f.source.join("song.wav")).unwrap();
            fs::write(
                f.source.join("project.json"),
                serde_json::to_vec(&serde_json::json!({
                    "version":2,"name":"Singer: Song.mp3","songFile":"song.wav","settings":settings
                }))
                .unwrap(),
            )
            .unwrap();
            let before = fs::read(f.source.join("project.json")).unwrap();
            let result = f.execute(&f.input(mode), false);
            assert!(
                !result.imported && !result.moved && result.warning.is_some(),
                "{:?}",
                result
            );
            assert_eq!(fs::read(f.source.join("project.json")).unwrap(), before);
            assert!(f.source.join("lyrics.json").exists());
            assert!(!f.destination().exists());
        }
    }
}

#[cfg(unix)]
#[test]
fn linked_custom_file_never_admits_a_custom_only_document() {
    let f = Fixture::new();
    fs::remove_file(f.source.join("song.wav")).unwrap();
    fs::write(f.base.join("outside.ogg"), b"foreign").unwrap();
    std::os::unix::fs::symlink(
        f.base.join("outside.ogg"),
        f.source.join("stems/custom-link.ogg"),
    )
    .unwrap();
    fs::write(f.source.join("project.json"), br#"{"version":2,"name":"Singer: Song.mp3","settings":{"custom":[{"id":"custom-link","file":"stems/custom-link.ogg"}]}}"#).unwrap();
    let result = f.execute(&f.input(Mode::Move), false);
    assert!(!result.imported && !result.moved);
    assert!(f.source.exists());
    assert_eq!(fs::read(f.base.join("outside.ogg")).unwrap(), b"foreign");
    assert!(!f.destination().exists());
}

#[test]
fn retained_disabled_original_cannot_admit_missing_custom_audio() {
    let f = Fixture::new();
    fs::write(f.source.join("project.json"), br#"{"version":2,"name":"Singer: Song.mp3","songFile":"song.wav","settings":{"nativeOriginalDisabled":true,"custom":[{"id":"custom-missing","file":"stems/missing.wav"}]}}"#).unwrap();
    let result = f.execute(&f.input(Mode::Move), false);
    assert!(!result.imported && !result.moved);
    assert!(f.source.join("song.wav").exists());
    assert!(!f.destination().exists());
}

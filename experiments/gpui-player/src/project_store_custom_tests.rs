use super::*;
use crate::tracks::Lane;
struct Fixture {
    root: PathBuf,
    project: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let root = std::env::temp_dir().join(format!(
            "singz-custom-store-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let project = root.join("project");
        fs::create_dir(&project).unwrap();
        fs::create_dir(project.join("stems")).unwrap();
        fs::write(
            project.join("project.json"),
            br#"{"version":2,"foreign":{"keep":true},"settings":{"futureSetting":9}}"#,
        )
        .unwrap();
        Self { root, project }
    }
    fn lane(&self, id: &str, file: &str, body: &[u8]) -> Lane {
        let file = self.root.join(file);
        fs::write(&file, body).unwrap();
        Lane {
            slot: 7,
            id: id.into(),
            label: "Harmony take 2".into(),
            color: "#8fd3ff".into(),
            file,
            custom: true,
        }
    }
    fn save(&self, custom: &[Lane]) -> CustomCommit {
        let (raw, hash) = read(&self.project, "project.json").unwrap();
        commit_custom(&self.project, &hash, &raw, custom, &|| false).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
#[test]
fn custom_save_copies_encoded_bytes_and_portable_metadata_without_touching_source() {
    let f = Fixture::new();
    let bytes = b"ID3original encoded MP3 bytes\0\xff";
    let lane = f.lane("custom-harmony", "Harmony.MP3", bytes);
    let saved = f.save(&[lane.clone()]);
    assert!(saved.warnings.is_empty());
    assert_eq!(
        saved.raw["settings"]["custom"][0]["file"],
        "stems/custom-harmony.mp3"
    );
    assert_eq!(saved.raw["foreign"]["keep"], true);
    assert_eq!(saved.raw["settings"]["futureSetting"], 9);
    assert_eq!(fs::read(&saved.custom[0].file).unwrap(), bytes);
    assert_eq!(fs::read(&lane.file).unwrap(), bytes);
    assert_eq!(
        read(&f.project, "project.json").unwrap().1,
        saved.metadata_hash
    );
    assert_eq!(saved.custom[0].id, lane.id);
}
#[test]
fn label_only_rename_keeps_project_audio_identity_path_and_encoded_bytes() {
    let f = Fixture::new();
    let lane = f.lane("custom-harmony", "take.flac", b"fLaCoriginal bytes");
    let first = f.save(&[lane]);
    let path = first.custom[0].file.clone();
    let before = fs::metadata(&path).unwrap();
    let mut renamed = first.custom;
    renamed[0].label = "Новая гармония 🦀".into();
    let second = f.save(&renamed);
    assert_eq!(second.custom[0].file, path);
    assert_eq!(
        second.raw["settings"]["custom"][0]["label"],
        "Новая гармония 🦀"
    );
    let after = fs::metadata(&path).unwrap();
    assert_eq!(before.modified().unwrap(), after.modified().unwrap());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        assert_eq!(before.ino(), after.ino());
    }
    assert_eq!(fs::read(path).unwrap(), b"fLaCoriginal bytes");
}
#[test]
fn remove_prunes_only_unused_ordinary_custom_namespace_after_metadata_commit() {
    let f = Fixture::new();
    let lane = f.lane("custom-harmony", "take.wav", b"original WAV bytes");
    let first = f.save(&[lane.clone()]);
    let removed = first.custom[0].file.clone();
    let stems = f.project.join("stems");
    fs::write(stems.join("vocals.wav"), b"builtin").unwrap();
    fs::write(stems.join("notes.txt"), b"foreign").unwrap();
    fs::create_dir(stems.join("custom-directory")).unwrap();
    #[cfg(unix)]
    {
        std::os::unix::fs::symlink(&lane.file, stems.join("custom-linked.wav")).unwrap();
    }
    let saved = f.save(&[]);
    assert!(saved.raw["settings"].get("custom").is_none());
    assert!(!removed.exists());
    assert_eq!(fs::read(lane.file).unwrap(), b"original WAV bytes");
    assert_eq!(fs::read(stems.join("vocals.wav")).unwrap(), b"builtin");
    assert_eq!(fs::read(stems.join("notes.txt")).unwrap(), b"foreign");
    assert!(stems.join("custom-directory").is_dir());
    #[cfg(unix)]
    assert!(
        fs::symlink_metadata(stems.join("custom-linked.wav"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
}
#[test]
fn missing_custom_source_warns_and_drops_only_that_definition() {
    let f = Fixture::new();
    let mut missing = f.lane("custom-missing", "gone.mp3", b"gone");
    fs::remove_file(&missing.file).unwrap();
    let good = f.lane("custom-good", "good.ogg", b"OggSencoded");
    missing.slot = 8;
    let saved = f.save(&[missing, good]);
    assert_eq!(saved.warnings.len(), 1);
    assert_eq!(saved.custom.len(), 1);
    assert_eq!(saved.custom[0].id, "custom-good");
    assert_eq!(saved.raw["settings"]["custom"].as_array().unwrap().len(), 1);
}
#[test]
fn cancelled_or_conflicting_save_never_prunes_old_audio_or_publishes_new_metadata() {
    let f = Fixture::new();
    let lane = f.lane("custom-harmony", "take.mp3", b"encoded");
    let first = f.save(&[lane]);
    let before = fs::read(f.project.join("project.json")).unwrap();
    assert!(commit_custom(&f.project, &first.metadata_hash, &first.raw, &[], &|| true).is_err());
    assert_eq!(fs::read(f.project.join("project.json")).unwrap(), before);
    assert!(first.custom[0].file.exists());
    assert!(commit_custom(&f.project, "stale fingerprint", &first.raw, &[], &|| false).is_err());
    assert!(first.custom[0].file.exists());
}
#[test]
fn absolute_paths_in_raw_metadata_cannot_bypass_explicit_captured_inventory() {
    let f = Fixture::new();
    let foreign = f.root.join("secret.mp3");
    fs::write(&foreign, b"foreign secret").unwrap();
    let (raw, hash) = read(&f.project, "project.json").unwrap();
    let mut incoming = raw;
    incoming["settings"]["custom"] = json!([{"id":"custom-forged","file":foreign}]);
    let saved = commit_custom(&f.project, &hash, &incoming, &[], &|| false).unwrap();
    assert!(saved.custom.is_empty());
    assert!(saved.raw["settings"].get("custom").is_none());
    assert!(!f.project.join("stems/custom-forged.mp3").exists());
    assert_eq!(fs::read(foreign).unwrap(), b"foreign secret");
}
#[test]
fn slot_ids_drive_mix_keys_and_custom_controls_do_not_alias_builtin_role() {
    let f = Fixture::new();
    let lane = f.lane("custom-vocals", "vocals.wav", b"own vocals");
    let mut mix = Mix {
        carry: Default::default(),
        metronome: Default::default(),
        beat: None,
        original: false,
        lanes: vec![],
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
    };
    mix.lanes = vec![0, 7];
    mix.custom = vec![lane];
    mix.gain[7] = 0.23;
    mix.muted[7] = false;
    mix.solo[7] = true;
    let raw = update_mix(
        json!({"settings":{"tracks":{"custom-removed":{"volume":0.9},"vocals":{"foreign":7}}}}),
        &mix,
    )
    .unwrap();
    assert_eq!(raw["settings"]["tracks"]["custom-vocals"]["volume"], 0.23);
    assert_eq!(raw["settings"]["tracks"]["vocals"]["volume"], 0.4);
    assert_eq!(raw["settings"]["tracks"]["vocals"]["foreign"], 7);
    assert!(raw["settings"]["tracks"].get("custom-removed").is_none());
}
#[test]
fn custom_publication_handles_all_sixteen_active_custom_only_lanes() {
    let f = Fixture::new();
    let lanes: Vec<_> = (0..16)
        .map(|i| {
            let mut lane = f.lane(
                &format!("custom-{i}"),
                &format!("picked-{i}.mp3"),
                format!("encoded-{i}").as_bytes(),
            );
            lane.slot = 6 + i;
            lane
        })
        .collect();
    let saved = f.save(&lanes);
    assert_eq!(saved.custom.len(), 16);
    for (i, lane) in saved.custom.iter().enumerate() {
        assert_eq!(
            fs::read(&lane.file).unwrap(),
            format!("encoded-{i}").as_bytes()
        );
    }
    let removed = f.save(&[]);
    assert!(removed.custom.is_empty());
    assert_eq!(fs::read_dir(f.project.join("stems")).unwrap().count(), 0);
}
#[test]
fn unsafe_ids_relative_sources_and_linked_sources_cannot_mutate_a_saved_project() {
    let f = Fixture::new();
    let mut lane = f.lane("custom-valid", "picked.wav", b"source");
    let (raw, hash) = read(&f.project, "project.json").unwrap();
    lane.id = "custom-../../outside".into();
    assert!(commit_custom(&f.project, &hash, &raw, &[lane.clone()], &|| false).is_err());
    lane.id = "custom-valid".into();
    lane.file = PathBuf::from("stems/picked.wav");
    assert!(commit_custom(&f.project, &hash, &raw, &[lane], &|| false).is_err());
    assert_eq!(read(&f.project, "project.json").unwrap().1, hash);
    #[cfg(unix)]
    {
        let original = f.root.join("picked.wav");
        let alias = f.root.join("alias.wav");
        std::os::unix::fs::symlink(original, &alias).unwrap();
        let lane = Lane {
            slot: 7,
            id: "custom-linked".into(),
            label: "Linked".into(),
            color: "#abcdef".into(),
            file: alias,
            custom: true,
        };
        assert!(commit_custom(&f.project, &hash, &raw, &[lane], &|| false).is_err());
        assert_eq!(read(&f.project, "project.json").unwrap().1, hash);
    }
}
fn empty_mix() -> Mix {
    Mix {
        carry: Default::default(),
        metronome: Default::default(),
        beat: None,
        original: false,
        lanes: vec![],
        custom: vec![],
        gain: [1.; crate::tracks::LANE_SLOTS],
        muted: [false; crate::tracks::LANE_SLOTS],
        solo: [false; crate::tracks::LANE_SLOTS],
        master: 0.7,
        transpose: 0,
        tempo: 1.,
        looping: true,
        selection: Some((0., 0.)),
        view: (0., 0.),
    }
}
#[test]
fn deliberate_empty_save_prunes_owned_audio_and_persists_no_fake_transport_range() {
    let f = Fixture::new();
    let lane = f.lane("custom-only", "only.mp3", b"encoded source retained");
    let first = f.save(&[lane.clone()]);
    fs::write(f.project.join("lyrics.json"), b"saved independent words").unwrap();
    fs::write(f.project.join("stems/foreign.bin"), b"foreign project data").unwrap();
    let mut raw = first.raw.clone();
    raw["settings"]["loop"] = json!(true);
    raw["settings"]["selection"] = json!({"s":0,"e":10});
    raw["settings"]["view"] = json!({"s":0,"e":10});
    let empty = update_mix(raw, &empty_mix()).unwrap();
    let committed =
        commit_custom(&f.project, &first.metadata_hash, &empty, &[], &|| false).unwrap();
    let (reopened, hash) = read(&f.project, "project.json").unwrap();
    assert_eq!(hash, committed.metadata_hash);
    assert_eq!(reopened["settings"]["nativeEmptyTracks"], true);
    assert_eq!(reopened["settings"]["custom"], json!([]));
    for field in ["loop", "selection", "view"] {
        assert!(reopened["settings"].get(field).is_none(), "{field}");
    }
    assert_eq!(reopened["foreign"]["keep"], true);
    assert_eq!(reopened["settings"]["futureSetting"], 9);
    assert!(!first.custom[0].file.exists());
    assert_eq!(fs::read(lane.file).unwrap(), b"encoded source retained");
    assert_eq!(
        fs::read(f.project.join("lyrics.json")).unwrap(),
        b"saved independent words"
    );
    assert_eq!(
        fs::read(f.project.join("stems/foreign.bin")).unwrap(),
        b"foreign project data"
    );
    assert!(committed.custom.is_empty());
}
#[test]
fn readding_audio_clears_empty_marker_and_restores_real_ranges_on_save() {
    let f = Fixture::new();
    let (raw, hash) = read(&f.project, "project.json").unwrap();
    let empty = update_mix(raw, &empty_mix()).unwrap();
    let empty = commit_custom(&f.project, &hash, &empty, &[], &|| false).unwrap();
    let lane = f.lane("custom-returned", "returned.flac", b"fLaCnew actual audio");
    let mut mix = empty_mix();
    mix.lanes = vec![lane.slot];
    mix.custom = vec![lane.clone()];
    mix.selection = Some((0., 4.));
    mix.view = (0., 4.);
    mix.looping = false;
    let value = update_mix(empty.raw, &mix).unwrap();
    assert!(value["settings"].get("nativeEmptyTracks").is_none());
    let saved = commit_custom(
        &f.project,
        &empty.metadata_hash,
        &value,
        &mix.custom,
        &|| false,
    )
    .unwrap();
    assert!(saved.raw["settings"].get("nativeEmptyTracks").is_none());
    assert_eq!(saved.raw["settings"]["selection"]["e"], 4.);
    assert_eq!(saved.custom.len(), 1);
    assert_eq!(
        fs::read(&saved.custom[0].file).unwrap(),
        b"fLaCnew actual audio"
    );
}
#[test]
fn missing_custom_file_and_damaged_original_mix_never_auto_convert_to_empty() {
    let f = Fixture::new();
    let mut lane = f.lane("custom-missing", "vanished.wav", b"gone");
    fs::remove_file(&lane.file).unwrap();
    let (raw, hash) = read(&f.project, "project.json").unwrap();
    let mut mix = empty_mix();
    mix.lanes = vec![7];
    lane.slot = 7;
    mix.custom = vec![lane];
    mix.selection = Some((0., 8.));
    mix.view = (0., 8.);
    let value = update_mix(raw, &mix).unwrap();
    let saved = commit_custom(&f.project, &hash, &value, &mix.custom, &|| false).unwrap();
    assert_eq!(saved.warnings.len(), 1);
    assert!(saved.raw["settings"].get("nativeEmptyTracks").is_none());
    let mut damaged = empty_mix();
    damaged.original = true;
    assert!(update_mix(saved.raw, &damaged).is_err());
}
#[test]
fn empty_save_keeps_compare_and_swap_and_link_foreign_preservation() {
    let f = Fixture::new();
    let lane = f.lane("custom-only", "only.wav", b"owned audio");
    let first = f.save(&[lane.clone()]);
    #[cfg(unix)]
    std::os::unix::fs::symlink(&lane.file, f.project.join("stems/custom-linked.wav")).unwrap();
    let value = update_mix(first.raw, &empty_mix()).unwrap();
    assert!(commit_custom(&f.project, "stale document", &value, &[], &|| false).is_err());
    assert!(first.custom[0].file.exists());
    let saved = commit_custom(&f.project, &first.metadata_hash, &value, &[], &|| false).unwrap();
    assert_eq!(saved.raw["settings"]["nativeEmptyTracks"], true);
    #[cfg(unix)]
    assert!(
        fs::symlink_metadata(f.project.join("stems/custom-linked.wav"))
            .unwrap()
            .file_type()
            .is_symlink()
    );
    assert_eq!(fs::read(lane.file).unwrap(), b"owned audio");
}
#[test]
fn working_copy_materialization_preserves_explicit_empty_but_actual_audio_clears_it() {
    let f = Fixture::new();
    let stage = f.root.join("working");
    fs::create_dir(&stage).unwrap();
    let mut raw = update_mix(
        json!({"name":"Empty working","settings":{"future":42}}),
        &empty_mix(),
    )
    .unwrap();
    let empty = materialize_custom(&f.project, &stage, &mut raw, &[], &|| false).unwrap();
    assert!(empty.custom.is_empty());
    assert_eq!(raw["settings"]["nativeEmptyTracks"], true);
    assert!(raw["settings"].get("selection").is_none());
    let lane = f.lane("custom-added", "fresh.ogg", b"OggSsource");
    let added = materialize_custom(&f.project, &stage, &mut raw, &[lane], &|| false).unwrap();
    assert_eq!(added.custom.len(), 1);
    assert!(raw["settings"].get("nativeEmptyTracks").is_none());
    assert_eq!(raw["settings"]["future"], 42);
}
#[test]
fn empty_then_readded_custom_does_not_restore_the_retired_original_intent() {
    let f = Fixture::new();
    let (raw, hash) = read(&f.project, "project.json").unwrap();
    let empty = update_mix(raw, &empty_mix()).unwrap();
    assert_eq!(empty["settings"]["nativeOriginalDisabled"], true);
    let empty = commit_custom(&f.project, &hash, &empty, &[], &|| false).unwrap();
    let lane = f.lane("custom-next", "next.mp3", b"new custom bytes");
    let mut mix = empty_mix();
    mix.lanes = vec![7];
    mix.custom = vec![lane];
    mix.selection = Some((0., 2.));
    mix.view = (0., 2.);
    let next = update_mix(empty.raw, &mix).unwrap();
    assert!(next["settings"].get("nativeEmptyTracks").is_none());
    assert_eq!(next["settings"]["nativeOriginalDisabled"], true);
    mix.original = true;
    mix.lanes.insert(0, 5);
    let original = update_mix(next, &mix).unwrap();
    assert!(original["settings"].get("nativeOriginalDisabled").is_none());
    assert!(original["settings"].get("nativeEmptyTracks").is_none());
}

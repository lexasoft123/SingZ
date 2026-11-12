use super::*;
use crate::{
    audio_devices::{Device, Inventory},
    training_domain::{Kind, Task},
};
struct Fixture {
    root: PathBuf,
    config: PathBuf,
    profiles: Vec<PathBuf>,
    profile: PathBuf,
    library: PathBuf,
}
impl Fixture {
    fn new(platform: source::Platform, identity: &str) -> Self {
        Self::with_audio_policy(platform, identity, cfg!(windows))
    }
    fn with_audio_policy(platform: source::Platform, identity: &str, windows: bool) -> Self {
        let root = std::env::temp_dir().join(format!(
            "c40-{}-{}",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir_all(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let home = root.join("home");
        fs::create_dir_all(&home).unwrap();
        let appdata = root.join("Roaming");
        let profiles = source::profiles(platform, &home, Some(&appdata));
        let profile = profiles
            .iter()
            .find(|p| p.file_name().unwrap() == identity)
            .unwrap()
            .clone();
        fs::create_dir_all(&profile).unwrap();
        let config = root.join("native");
        let library = root.join("Songs");
        fs::create_dir(&library).unwrap();
        let f = Self {
            root,
            config,
            profiles,
            profile,
            library,
        };
        f.write("settings.json",json!({"projectsRoot":f.library,"language":"ru","releaseNotesSeen":"0.10.0","qwenOfferDismissed":true,"gdrive":{"refreshToken":"DO-NOT-COPY"},"gdriveDirty":{"seq":999}}));
        f.write(
            "window-state.json",
            json!({"x":-100000,"y":-100000,"width":1100,"height":720,"maximized":true}),
        );
        let mut prefs = crate::training_progress::Preferences::default();
        prefs.notation = "movable-do".into();
        f.write(
            "training-preferences.json",
            json!({"formatVersion":1,"preferences":prefs}),
        );
        let receipt = crate::training_progress::tests::complete(
            Kind::Note,
            Task::Imitate,
            1,
            "electron-session",
            false,
        );
        f.write(
            &format!(
                "training-receipts/{}.json",
                crate::project_store::fingerprint(receipt.session_id.as_bytes())
            ),
            serde_json::to_value(receipt).unwrap(),
        );
        f.write("native-handover.json",json!({"formatVersion":1,"product":"desktop","audio":{"nativeOutputUid":playback_uid(windows),"outputId":"chromium-hash","nativeInputUid":"mic","inputChannel":1,"nativeMonitorOutputUid":"speaker","nativeMonitorOutputChannels":[1,0],"monitorGainDb":-12},"karaoke":true,"metronome":{"click":true,"countInBars":1,"volume":0.4,"accent":false,"grid":true},"trainingControls":{"formatVersion":1,"sound":2,"volume":0.8,"tolerance":2,"focus":1,"program":null}}));
        f
    }
    fn write(&self, name: &str, value: Value) {
        let path = self.profile.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, serde_json::to_vec(&value).unwrap()).unwrap();
    }
    fn import(&self) -> Record {
        run(&self.config, &self.profiles, &inventory)
            .unwrap()
            .expect("Importer must record this Electron fixture")
    }
    fn raw(&self, name: &str) -> Value {
        serde_json::from_slice(&fs::read(self.config.join(name)).unwrap()).unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.root);
    }
}
fn playback_uid(windows: bool) -> &'static str {
    if windows { "wasapi:speaker" } else { "speaker" }
}
fn inventory() -> Result<Inventory> {
    inventory_for(cfg!(windows))
}
fn inventory_for(windows: bool) -> Result<Inventory> {
    let mut inventory = Inventory {
        devices: vec![
            Device {
                uid: "speaker".into(),
                label: "Speaker".into(),
                inputs: 0,
                outputs: 2,
                input_probe_busy: false,
                output_probe_busy: false,
            },
            Device {
                uid: "mic".into(),
                label: "Mic".into(),
                inputs: 2,
                outputs: 0,
                input_probe_busy: false,
                output_probe_busy: false,
            },
        ],
        default_output: playback_uid(windows).into(),
        default_input: "mic".into(),
    };
    if windows {
        // Real Windows inventory has a separate provider-scoped playback row;
        // the raw speaker row above belongs to independent monitoring.
        let mut playback = inventory.devices[0].clone();
        playback.uid = playback_uid(true).into();
        inventory.devices.push(playback);
    }
    Ok(inventory)
}
// Exercise the Windows fixture contract even on macOS/Linux: playback is
// provider-scoped, while WASAPI capture and independent monitor IDs stay raw.
#[test]
fn windows_audio_fixture_imports_scoped_playback_and_raw_capture() {
    let f = Fixture::with_audio_policy(source::Platform::Windows, "SingZ", true);
    let devices = inventory_for(true).unwrap();
    let handover: Value =
        serde_json::from_slice(&fs::read(f.profile.join("native-handover.json")).unwrap()).unwrap();
    let output = handover["audio"]["nativeOutputUid"].as_str().unwrap();
    crate::audio_devices::validate_output_uid(crate::audio_devices::Provider::Wasapi, output, true)
        .expect("Windows fixture playback must satisfy the production UID policy");
    assert!(
        devices
            .devices
            .iter()
            .any(|d| d.uid == output && d.outputs == 2)
    );
    assert!(
        devices
            .devices
            .iter()
            .any(|d| d.uid == "speaker" && d.outputs == 2)
    );
    run(&f.config, &f.profiles, &|| Ok(devices.clone())).unwrap();
    let audio = f.raw("audio.json");
    assert_eq!(audio["outputUid"], "wasapi:speaker");
    assert_eq!(audio["inputUid"], "mic");
    assert_eq!(audio["monitorOutputUid"], "speaker");
    assert_eq!(audio["monitorOutputChannels"], json!([1, 0]));
}
fn bytes(root: &Path) -> BTreeMap<PathBuf, Vec<u8>> {
    fn visit(root: &Path, p: &Path, out: &mut BTreeMap<PathBuf, Vec<u8>>) {
        if let Ok(entries) = fs::read_dir(p) {
            for entry in entries {
                let path = entry.unwrap().path();
                if path.is_dir() {
                    visit(root, &path, out)
                } else {
                    out.insert(
                        path.strip_prefix(root).unwrap().to_owned(),
                        fs::read(path).unwrap(),
                    );
                }
            }
        }
    }
    let mut out = BTreeMap::new();
    visit(root, root, &mut out);
    out
}
fn complete_profile(platform: source::Platform, identity: &str) {
    let f = Fixture::new(platform, identity);
    let before = bytes(&f.profile);
    let library_before = bytes(&f.library);
    let record = f.import();
    assert_eq!(record.profile, identity);
    assert_eq!(f.raw("library.json")["projectsRoot"], json!(f.library));
    assert_eq!(f.raw("language.json")["language"], "ru");
    assert_eq!(
        f.raw("release-highlights.json")["releaseNotesSeen"],
        "0.10.0"
    );
    let window = f.raw("window-state-native.json");
    assert_eq!(
        window["normal"],
        json!({"x":0.0,"y":0.0,"width":1100.0,"height":720.0})
    );
    assert_eq!(window["maximized"], true);
    assert_eq!(f.raw("audio.json")["inputUid"], "mic");
    assert_eq!(
        f.raw("audio.json")["outputUid"],
        playback_uid(cfg!(windows))
    );
    assert_eq!(f.raw("audio.json")["karaoke"], true);
    assert_eq!(f.raw("metronome.json")["volume"], 0.4);
    assert_eq!(f.raw("training-controls.json")["sound"], 2);
    assert_eq!(
        f.raw("training-preferences.json")["preferences"]["notation"],
        "movable-do"
    );
    assert_eq!(
        crate::training_store::load_receipts(&f.config)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(record.qwen_offer_dismissed, Some(true));
    assert!(
        !String::from_utf8(fs::read(f.config.join("migration.json")).unwrap())
            .unwrap()
            .contains("DO-NOT-COPY")
    );
    assert!(!f.config.join("gdrive").exists());
    assert_eq!(bytes(&f.profile), before);
    assert_eq!(bytes(&f.library), library_before);
}
macro_rules! profile_test {
    ($name:ident,$platform:ident,$identity:literal) => {
        #[test]
        fn $name() {
            complete_profile(source::Platform::$platform, $identity)
        }
    };
}
profile_test!(mac_packaged_profile, Mac, "SingZ");
profile_test!(mac_development_profile, Mac, "singz");
profile_test!(mac_driver_profile, Mac, "Electron");
profile_test!(windows_packaged_profile, Windows, "SingZ");
profile_test!(windows_development_profile, Windows, "singz");
profile_test!(windows_driver_profile, Windows, "Electron");
#[test]
fn rerun_keeps_native_and_source_bytes_even_after_electron_changes() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.import();
    let native = bytes(&f.config);
    f.write(
        "settings.json",
        json!({"language":"ja","projectsRoot":f.root}),
    );
    let electron = bytes(&f.profile);
    f.import();
    assert_eq!(bytes(&f.config), native);
    assert_eq!(bytes(&f.profile), electron);
}
#[test]
fn corrupt_settings_retry_other_items_succeed_then_recover() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::write(f.profile.join("settings.json"), b"{\"language\":").unwrap();
    let r = f.import();
    assert_eq!(r.items["language"].outcome, Outcome::RetryLater);
    assert!(!f.config.join("language.json").exists());
    assert_eq!(f.raw("audio.json")["inputUid"], "mic");
    f.write("settings.json", json!({"language":"ja"}));
    assert_eq!(f.import().items["language"].outcome, Outcome::Import);
    assert_eq!(f.raw("language.json")["language"], "ja");
}
#[test]
fn preserves_native_choices_and_unknown_fields() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::create_dir_all(&f.config).unwrap();
    fs::write(
        f.config.join("language.json"),
        br#"{"version":1,"language":"ja","future":true}"#,
    )
    .unwrap();
    fs::write(
        f.config.join("audio.json"),
        br#"{"outputUid":"native-choice","future":true}"#,
    )
    .unwrap();
    let lang = fs::read(f.config.join("language.json")).unwrap();
    let r = f.import();
    assert_eq!(r.items["language"].outcome, Outcome::KeptNative);
    assert_eq!(r.items["audio"].outcome, Outcome::KeptNative);
    assert_eq!(fs::read(f.config.join("language.json")).unwrap(), lang);
    assert_eq!(f.raw("audio.json")["future"], true);
    assert_eq!(f.raw("audio.json")["outputUid"], "native-choice");
}
#[test]
fn defaults_can_be_replaced_and_legacy_training_upgrades() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::create_dir_all(&f.config).unwrap();
    fs::write(
        f.config.join("language.json"),
        br#"{"version":1,"language":"system","extra":4}"#,
    )
    .unwrap();
    f.write("training-preferences.json",json!({"formatVersion":1,"preferences":{"formatVersion":1,"range":{"lowMidi":45,"highMidi":75},"notation":"movable-do","taskMode":"imitate","direction":"both","intervalSizes":[2,3],"chordDegrees":[1,3,5]}}));
    f.import();
    assert_eq!(f.raw("language.json")["language"], "ru");
    assert_eq!(f.raw("language.json")["extra"], 4);
    assert_eq!(
        f.raw("training-preferences.json")["preferences"]["range"]["lowMidi"],
        45
    );
}
#[test]
fn missing_export_is_recorded_and_never_reimported() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::remove_file(f.profile.join("native-handover.json")).unwrap();
    let r = f.import();
    assert_eq!(r.items["audio"].reason, "handover-absent");
    assert!(!f.config.join("audio.json").exists());
    f.write(
        "native-handover.json",
        json!({"formatVersion":1,"product":"desktop","karaoke":true}),
    );
    let native = bytes(&f.config);
    f.import();
    assert_eq!(bytes(&f.config), native);
}
#[test]
fn unknown_export_version_is_skipped_without_using_its_fields() {
    let f = Fixture::new(source::Platform::Windows, "SingZ");
    f.write("native-handover.json",json!({"formatVersion":999,"product":"desktop","audio":{"nativeInputUid":"mic"},"karaoke":true}));
    let r = f.import();
    assert_eq!(
        r.items["audio"].reason,
        "handover-unsupported-version-or-product"
    );
    assert!(!f.config.join("audio.json").exists());
}
#[test]
fn stale_devices_and_chromium_ids_are_never_native_routes() {
    let f = Fixture::new(source::Platform::Windows, "SingZ");
    f.write("native-handover.json",json!({"formatVersion":1,"product":"desktop","audio":{"outputId":"speaker","inputId":"mic","nativeInputUid":"gone","nativeMonitorOutputUid":"gone"}}));
    f.import();
    let audio = f.raw("audio.json");
    assert!(audio.get("outputUid").is_none());
    assert!(audio.get("inputUid").is_none());
    assert!(audio.get("monitorOutputUid").is_none());
}
#[test]
fn invalid_roots_are_skipped_and_packaged_profile_wins() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    for other in f.profiles.iter().skip(1) {
        fs::create_dir_all(other).unwrap();
        fs::write(other.join("settings.json"), br#"{"language":"ja"}"#).unwrap();
    }
    f.write(
        "settings.json",
        json!({"language":"ru","projectsRoot":"relative"}),
    );
    let r = f.import();
    assert_eq!(r.items["library"].outcome, Outcome::SkipInvalid);
    assert_eq!(f.raw("language.json")["language"], "ru");
    assert!(!f.config.join("library.json").exists());
}
#[test]
fn missing_library_is_not_created() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let root = f.root.join("not-created");
    f.write("settings.json", json!({"projectsRoot":root}));
    let r = f.import();
    assert_eq!(r.items["library"].outcome, Outcome::RetryLater);
    assert!(!root.exists());
}
#[test]
fn box_is_ignored_even_when_it_has_a_complete_profile() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let box_path = f.profile.with_file_name("SingZ Box");
    fs::rename(&f.profile, &box_path).unwrap();
    // An empty driver profile records skips; Box's valid preferences must not win.
    fs::create_dir_all(&f.profiles[2]).unwrap();
    let r = f.import();
    assert_eq!(r.profile, "Electron");
    assert!(!f.config.join("language.json").exists());
    assert_eq!(r.items["language"].outcome, Outcome::SkipInvalid);
}
#[cfg(unix)]
#[test]
fn linked_source_is_never_opened_and_can_retry() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let target = f.root.join("external.json");
    fs::write(&target, br#"{"language":"ja"}"#).unwrap();
    fs::remove_file(f.profile.join("settings.json")).unwrap();
    symlink(&target, f.profile.join("settings.json")).unwrap();
    let r = f.import();
    assert_eq!(r.items["language"].outcome, Outcome::RetryLater);
    assert!(!f.config.join("language.json").exists());
    assert_eq!(fs::read(target).unwrap(), br#"{"language":"ja"}"#);
}
#[test]
fn corrupt_receipt_does_not_hide_compatible_receipts() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::write(
        f.profile
            .join("training-receipts")
            .join(format!("{}.json", "a".repeat(64))),
        b"{",
    )
    .unwrap();
    let before = bytes(&f.profile);
    let r = f.import();
    assert_eq!(r.items["training-receipts"].outcome, Outcome::RetryLater);
    assert_eq!(
        crate::training_store::load_receipts(&f.config)
            .unwrap()
            .len(),
        1
    );
    assert_eq!(bytes(&f.profile), before);
}
#[test]
fn config_alias_into_electron_is_refused_before_any_write() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.import(); // control proves the importer is enabled
    let before = bytes(&f.profile);
    assert!(run(&f.profile, &f.profiles, &inventory).is_err());
    assert_eq!(bytes(&f.profile), before);
}
#[cfg(unix)]
#[test]
fn linked_native_receipt_directory_cannot_write_electron() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.import();
    let other = f.root.join("native-alias");
    fs::create_dir(&other).unwrap();
    std::os::unix::fs::symlink(
        f.profile.join("training-receipts"),
        other.join("training-receipts"),
    )
    .unwrap();
    let before = bytes(&f.profile);
    assert!(run(&other, &f.profiles, &inventory).is_err());
    assert_eq!(bytes(&f.profile), before);
}
#[test]
fn oversized_settings_retry_without_touching_electron() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::write(
        f.profile.join("settings.json"),
        vec![b' '; 4 * 1024 * 1024 + 1],
    )
    .unwrap();
    let before = bytes(&f.profile);
    let r = f.import();
    assert_eq!(r.items["language"].outcome, Outcome::RetryLater);
    assert_eq!(bytes(&f.profile), before);
}
#[test]
fn unknown_handover_fields_are_ignored_and_invalid_channels_fall_back() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let mut raw: Value =
        serde_json::from_slice(&fs::read(f.profile.join("native-handover.json")).unwrap()).unwrap();
    raw["future"] = true.into();
    raw["audio"]["inputChannel"] = 999.into();
    raw["audio"]["nativeMonitorOutputChannels"] = json!([0, 0]);
    raw["trainingControls"]["future"] = true.into();
    f.write("native-handover.json", raw);
    f.import();
    assert_eq!(f.raw("audio.json")["inputChannel"], 0);
    assert!(f.raw("audio.json").get("monitorOutputUid").is_none());
    assert_eq!(f.raw("training-controls.json")["sound"], 2);
}
#[test]
fn existing_default_audio_and_metronome_allow_import_and_keep_unknown_fields() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::create_dir_all(&f.config).unwrap();
    fs::write(
        f.config.join("audio.json"),
        br#"{"outputUid":"","inputUid":"","inputChannel":0,"future":9}"#,
    )
    .unwrap();
    let mut met = serde_json::to_value(crate::beat::Metronome::default()).unwrap();
    met["version"] = 1.into();
    met["future"] = 9.into();
    fs::write(
        f.config.join("metronome.json"),
        serde_json::to_vec(&met).unwrap(),
    )
    .unwrap();
    let r = f.import();
    assert_eq!(r.items["audio"].outcome, Outcome::Import);
    assert_eq!(r.items["metronome"].outcome, Outcome::Import);
    assert_eq!(f.raw("audio.json")["future"], 9);
    assert_eq!(f.raw("audio.json")["inputUid"], "mic");
    assert_eq!(f.raw("metronome.json")["future"], 9);
    assert_eq!(f.raw("metronome.json")["click"], true);
}
#[test]
fn native_library_release_training_and_window_are_retained() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::create_dir_all(&f.config).unwrap();
    let native_library = f.root.join("native-songs");
    fs::create_dir(&native_library).unwrap();
    fs::write(
        f.config.join("library.json"),
        serde_json::to_vec(&json!({"projectsRoot":native_library})).unwrap(),
    )
    .unwrap();
    fs::write(
        f.config.join("release-highlights.json"),
        br#"{"version":1,"releaseNotesSeen":"0.26.7"}"#,
    )
    .unwrap();
    let mut prefs = crate::training_progress::Preferences::default();
    prefs.notation = "scale-degrees".into();
    fs::write(
        f.config.join("training-preferences.json"),
        serde_json::to_vec(&json!({"formatVersion":1,"preferences":prefs})).unwrap(),
    )
    .unwrap();
    fs::write(
        f.config.join("window-state-native.json"),
        br#"{"version":1,"normal":{"x":10,"y":20,"width":1240,"height":820},"maximized":false}"#,
    )
    .unwrap();
    let before = bytes(&f.config);
    let r = f.import();
    for key in ["library", "release-notes", "training-preferences", "window"] {
        assert_eq!(r.items[key].outcome, Outcome::KeptNative);
    }
    let after = bytes(&f.config);
    for (path, original) in before {
        assert_eq!(after[&path], original);
    }
}
#[test]
fn no_desktop_profile_is_a_durable_first_run_outcome() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::rename(&f.profile, f.profile.with_file_name("SingZ Box")).unwrap();
    let r = f.import();
    assert_eq!(r.items["language"].reason, "desktop-profile-absent");
    let before = bytes(&f.config);
    fs::create_dir_all(&f.profile).unwrap();
    f.write("settings.json", json!({"language":"ja"}));
    f.import();
    assert_eq!(bytes(&f.config), before);
    assert!(!f.config.join("language.json").exists());
}
#[test]
fn completed_import_survives_removal_of_electron_profile() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let first = f.import();
    let before = bytes(&f.config);
    fs::remove_dir_all(&f.profile).unwrap();
    assert_eq!(f.import(), first);
    assert_eq!(bytes(&f.config), before);
}
#[test]
fn adoption_never_copies_an_existing_native_library() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.import();
    let old = f.root.join("old-native-library");
    fs::create_dir(&old).unwrap();
    fs::write(old.join("keep.txt"), b"never relocate me").unwrap();
    let before = bytes(&old);
    let config = crate::project_library::Config {
        home: f.root.clone(),
        default_root: old.clone(),
        preferences: f.root.join("second-native/library.json"),
        override_root: None,
        one_drive: None,
    };
    crate::project_library::import_root(&config, &f.library).unwrap();
    assert_eq!(bytes(&old), before);
    assert!(!f.library.join("keep.txt").exists());
    assert!(bytes(&f.library).is_empty());
}
#[test]
fn receipt_collision_keeps_native_history_and_records_retry() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let mut receipt = crate::training_progress::tests::complete(
        Kind::Note,
        Task::Imitate,
        1,
        "electron-session",
        false,
    );
    receipt.completed_at += 1;
    crate::training_store::record(&f.config, &receipt).unwrap();
    let before = bytes(&f.config.join("training-receipts"));
    let r = f.import();
    assert_eq!(r.items["training-receipts"].outcome, Outcome::RetryLater);
    assert_eq!(bytes(&f.config.join("training-receipts")), before);
    assert_eq!(
        crate::training_store::load_receipts(&f.config).unwrap(),
        vec![receipt]
    );
}

#[test]
fn review_large_electron_settings_imports_without_copying_secrets() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let mut settings: Value =
        serde_json::from_slice(&fs::read(f.profile.join("settings.json")).unwrap()).unwrap();
    settings["gdriveDirty"]["dirs"] = json!({"long-path": "x".repeat(300*1024)});
    f.write("settings.json", settings);
    let before = bytes(&f.profile);
    let record = f.import();
    assert_eq!(record.items["language"].outcome, Outcome::Import);
    assert_eq!(f.raw("language.json")["language"], "ru");
    assert_eq!(bytes(&f.profile), before);
    assert!(fs::metadata(f.config.join("migration.json")).unwrap().len() < 16384);
}
#[cfg(unix)]
#[test]
fn review_symlinked_ancestor_is_supported_but_final_links_stay_refused() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let alias = f.root.join("linked-home");
    std::os::unix::fs::symlink(f.profile.parent().unwrap(), &alias).unwrap();
    let record = run(&f.config, &[alias.join("SingZ")], &inventory)
        .unwrap()
        .unwrap();
    assert_eq!(record.items["language"].outcome, Outcome::Import);
    let real = f.root.join("real-native");
    fs::create_dir(&real).unwrap();
    let config_alias = f.root.join("config-ancestor");
    std::os::unix::fs::symlink(&real, &config_alias).unwrap();
    assert!(run(&config_alias.join("native"), &f.profiles, &inventory).is_ok());
}
#[test]
fn review_unmounted_library_retries_then_imports_when_available() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let root = f.root.join("external-volume/Songs");
    f.write("settings.json", json!({"projectsRoot":root}));
    assert_eq!(f.import().items["library"].outcome, Outcome::RetryLater);
    assert!(!root.exists());
    fs::create_dir_all(&root).unwrap();
    assert_eq!(f.import().items["library"].outcome, Outcome::Import);
    assert_eq!(f.raw("library.json")["projectsRoot"], json!(root));
}
#[test]
fn review_library_retry_budget_is_terminal_after_twenty_launches() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.write(
        "settings.json",
        json!({"projectsRoot":f.root.join("absent")}),
    );
    let mut record = serde_json::to_value(f.import()).unwrap();
    record["items"]["library"] = json!({"outcome":"retry-later","reason":"library-unavailable"});
    record["library_attempts"] = 19.into();
    fs::write(
        f.config.join("migration.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    let record = f.import();
    assert_eq!(record.items["library"].outcome, Outcome::SkipInvalid);
    assert_eq!(
        record.items["library"].reason,
        "library-unavailable-after-20-launches"
    );
}
#[test]
fn review_library_probe_executes_off_the_calling_thread() {
    let caller = std::thread::current().id();
    let result = root_probe(PathBuf::from("/fixture"), move |root| {
        assert_ne!(std::thread::current().id(), caller);
        Ok(root)
    });
    assert!(result.is_ok());
}
#[test]
fn review_library_probe_deadline_discards_late_result() {
    let start = std::time::Instant::now();
    let result = root_probe(PathBuf::from("/fixture"), |root| {
        std::thread::sleep(std::time::Duration::from_secs(3));
        Ok(root)
    });
    assert!(start.elapsed() < std::time::Duration::from_millis(2800));
    assert!(result.is_err());
}
#[test]
fn review_before_window_does_not_query_audio_inventory() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let queried = std::cell::Cell::new(false);
    let record = run_before_window(&f.config, &f.profiles, &|| {
        queried.set(true);
        inventory()
    })
    .unwrap()
    .unwrap();
    assert!(!queried.get());
    assert_eq!(record.items["audio"].outcome, Outcome::RetryLater);
    assert!(!f.config.join("audio.json").exists() || f.raw("audio.json").get("inputUid").is_none());
    assert_eq!(finish_audio(&f.config, &f.profiles, &inventory).unwrap(), 1);
    assert_eq!(f.raw("audio.json")["inputUid"], "mic");
    let raced = Fixture::new(source::Platform::Mac, "SingZ");
    run_before_window(&raced.config, &raced.profiles, &inventory).unwrap();
    finish_audio(&raced.config, &raced.profiles, &|| {
        fs::write(
            raced.config.join("audio.json"),
            br#"{"outputUid":"singer-choice"}"#,
        )?;
        inventory()
    })
    .unwrap();
    assert_eq!(raced.raw("audio.json")["outputUid"], "singer-choice");
    assert!(raced.raw("audio.json").get("inputUid").is_none());
}
#[test]
fn review_changed_profile_candidates_preserve_history_and_pending_items() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let mut record = f.import();
    record.items.insert(
        "audio".into(),
        Entry::new(Outcome::RetryLater, "pending-audio"),
    );
    fs::write(
        f.config.join("migration.json"),
        serde_json::to_vec(&record).unwrap(),
    )
    .unwrap();
    let before = bytes(&f.config);
    let other = f.root.join("other-config/Electron");
    let result = run(&f.config, &[other], &inventory).unwrap().unwrap();
    assert_eq!(result, record);
    assert_eq!(bytes(&f.config), before);
}
#[test]
fn review_imported_window_is_centered_on_the_native_display() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.import();
    let window = crate::desktop_window_state::StateStore::load(&f.config).resolve(&[
        crate::desktop_window_state::DisplaySnapshot {
            uuid: "primary".into(),
            visible: crate::desktop_window_state::Bounds {
                x: 0.,
                y: 0.,
                width: 2000.,
                height: 1200.,
            },
            primary: true,
        },
    ]);
    assert_eq!(window.normal.x, 450.);
    assert_eq!(window.normal.y, 240.);
    let mut store = crate::desktop_window_state::StateStore::load(&f.config);
    store.observe(
        crate::desktop_window_state::WindowSnapshot {
            normal: window.normal,
            display_uuid: window.display_uuid,
            maximized: window.maximized,
        },
        std::time::Instant::now(),
    );
    assert!(store.flush());
    let normal = f.raw("window-state-native.json")["normal"].clone();
    assert_eq!(normal["x"], 450.);
    assert_eq!(normal["y"], 240.);
}
#[test]
fn review_stray_receipt_files_do_not_block_history() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    f.write("training-receipts/.DS_Store", json!({}));
    let record = f.import();
    assert_eq!(record.items["training-receipts"].outcome, Outcome::Import);
    assert_eq!(
        crate::training_store::load_receipts(&f.config)
            .unwrap()
            .len(),
        1
    );
}
#[test]
fn review_summary_counts_only_new_imports_in_this_run() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    let (_, first) = run_fresh(&f.config, &f.profiles, &inventory).unwrap();
    assert!(first > 0);
    let (_, again) = run_fresh(&f.config, &f.profiles, &inventory).unwrap();
    assert_eq!(again, 0);
}
// C-44 round trip: the committed fixture is exactly what the Electron writer
// (src/main/native-handover-file.ts) produced, checked by tests/unit/native-handover.test.ts.
#[test]
fn electron_writer_export_is_imported_with_its_exact_values() {
    let f = Fixture::new(source::Platform::Mac, "SingZ");
    fs::write(
        f.profile.join("native-handover.json"),
        include_bytes!("../tests/fixtures/electron-native-handover.json"),
    )
    .unwrap();
    let r = f.import();
    for item in ["audio", "metronome", "karaoke", "training-controls"] {
        assert_eq!(r.items[item].outcome, Outcome::Import, "{item}");
    }
    let audio = f.raw("audio.json");
    assert_eq!(audio["inputUid"], "mic");
    assert_eq!(audio["inputChannel"], 1);
    assert_eq!(audio["monitorOutputUid"], "speaker");
    assert_eq!(audio["monitorOutputChannels"], json!([1, 0]));
    assert_eq!(audio["monitorGainDb"], -12.0);
    assert_eq!(audio["karaoke"], true);
    let met = f.raw("metronome.json");
    assert_eq!(
        (met["click"].clone(), met["countInBars"].clone(), met["volume"].clone(), met["accent"].clone(), met["grid"].clone()),
        (json!(true), json!(1), json!(0.4), json!(false), json!(true))
    );
    let controls = f.raw("training-controls.json");
    assert_eq!(controls["sound"], 2);
    assert_eq!(controls["volume"].as_f64().map(|v| (v * 100.).round()), Some(80.));
    assert_eq!(controls["tolerance"], 2);
    assert_eq!(controls["focus"], 0);
    assert_eq!(controls["program"], json!({"level":1,"startedAt":1700000000000u64}));
}

use super::*;
use crate::drive_plan::{self, RemoteEntry, RemoteProject};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    spool: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        // Use the checkout mount: container /tmp may be overlayfs without
        // FS_IOC_GETVERSION even when the checkout is an ext4 bind mount.
        let base = Path::new(env!("CARGO_MANIFEST_DIR")).join("target").join(format!(
            "singz-drive-snapshot-{}",
            crate::drive_http::random_id().unwrap()
        ));
        let root = base.join("library");
        let spool = base.join("spool");
        fs::create_dir_all(root.join("Song/stems")).unwrap();
        fs::create_dir_all(&spool).unwrap();
        fs::write(
            root.join("Song/project.json"),
            br#"{"name":"Song","foreign":{"large":123456789012345678901234567890},"settings":{}}"#,
        )
        .unwrap();
        fs::write(
            root.join("Song/stems/vocals.wav"),
            b"immutable source audio",
        )
        .unwrap();
        Self { base, root, spool }
    }
    fn capture(&self) -> Result<Capture> {
        capture_with_config(
            &self.root, "Song", &self.spool, &self.base.join("preferences"), &|| false,
        )
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn empty_remote() -> RemoteProject {
    RemoteProject {
        folder_id: None,
        stems_id: None,
        top: Vec::new(),
        stems: Vec::new(),
    }
}

#[test]
fn transport_hash_maintenance_does_not_change_live_editor_cas_base() {
    let f = Fixture::new();
    let before = fs::read(f.root.join("Song/project.json")).unwrap();
    let capture = f.capture().unwrap();
    let transported = capture
        .snapshot
        .top
        .iter()
        .find(|entry| entry.name == "project.json")
        .unwrap();
    let doc: Value = serde_json::from_slice(&fs::read(&transported.path).unwrap()).unwrap();
    assert_eq!(
        doc["stemHashes"]["vocals.wav"]["md5"],
        format!("{:x}", Md5::digest(b"immutable source audio"))
    );
    assert_eq!(
        doc["foreign"]["large"].to_string(),
        "123456789012345678901234567890"
    );
    assert_eq!(fs::read(f.root.join("Song/project.json")).unwrap(), before);
    assert_eq!(
        capture.local_document,
        crate::project_store::fingerprint(&before)
    );
}
#[test]
fn only_changed_payloads_are_immutable_before_network_and_lease_is_released() {
    let f = Fixture::new();
    let mut capture = f.capture().unwrap();
    let source = f.root.canonicalize().unwrap().join("Song");
    assert!(crate::project_publish::lock(&source).is_err());
    let mut plan = drive_plan::plan_project(&capture.snapshot, &empty_remote()).unwrap();
    capture.spool_uploads(&mut plan, &|| false).unwrap();
    let _writer = crate::project_publish::lock(&source).unwrap();
    fs::write(
        source.join("stems/vocals.wav"),
        b"changed while network works",
    )
    .unwrap();
    let step = plan
        .upload
        .iter()
        .find(|step| step.where_ == Location::Stems)
        .unwrap();
    assert_eq!(fs::read(&step.path).unwrap(), b"immutable source audio");
    assert_eq!(plan.upload.last().unwrap().name, "project.json");
}
#[test]
fn external_audio_change_is_refused_before_any_upload() {
    let f = Fixture::new();
    let mut capture = f.capture().unwrap();
    let mut plan = drive_plan::plan_project(&capture.snapshot, &empty_remote()).unwrap();
    fs::write(f.root.join("Song/stems/vocals.wav"), b"different source").unwrap();
    assert!(capture.spool_uploads(&mut plan, &|| false).is_err());
    drop(capture);
    assert!(!f.spool.join("Song").exists());
}
#[test]
fn clean_remote_does_not_spool_audio_but_releases_writer() {
    let f = Fixture::new();
    let mut capture = f.capture().unwrap();
    let remote_file = |entry: &LocalEntry, index: usize| RemoteEntry {
        id: format!("id{index}"),
        name: entry.name.clone(),
        mime_type: Some(entry.mime.clone()),
        md5_checksum: Some(entry.md5.clone()),
        size: Some(entry.size.to_string()),
        parents: Vec::new(),
        app_properties: Default::default(),
    };
    let remote = RemoteProject {
        folder_id: Some("project".into()),
        stems_id: Some("stems".into()),
        top: capture
            .snapshot
            .top
            .iter()
            .enumerate()
            .map(|(i, e)| remote_file(e, i))
            .collect(),
        stems: capture
            .snapshot
            .stems
            .iter()
            .enumerate()
            .map(|(i, e)| remote_file(e, i + 100))
            .collect(),
    };
    let mut plan = drive_plan::plan_project(&capture.snapshot, &remote).unwrap();
    assert!(plan.upload.is_empty());
    capture.spool_uploads(&mut plan, &|| false).unwrap();
    assert!(!f.spool.join("Song/stems").exists());
    assert!(crate::project_publish::lock(&f.root.join("Song")).is_ok());
}
#[test]
fn missing_custom_reference_and_empty_native_intent_cannot_publish_missing_audio() {
    let f = Fixture::new();
    fs::write(
        f.root.join("Song/project.json"),
        br#"{"settings":{"custom":[{"file":"stems/custom-missing.wav"}]}}"#,
    )
    .unwrap();
    assert!(f.capture().is_err());
    fs::write(
        f.root.join("Song/project.json"),
        br#"{"settings":{"nativeEmptyTracks":true,"custom":[]}}"#,
    )
    .unwrap();
    assert!(
        f.capture()
            .err()
            .unwrap()
            .to_string()
            .contains("Empty native")
    );
}
#[test]
fn absent_lyrics_remove_transport_hash_without_touching_foreign_data() {
    let f = Fixture::new();
    fs::write(
        f.root.join("Song/project.json"),
        br#"{"foreign":7,"lyricsHash":{"md5":"old"},"settings":{}}"#,
    )
    .unwrap();
    let capture = f.capture().unwrap();
    let doc: Value = serde_json::from_slice(
        &fs::read(
            &capture
                .snapshot
                .top
                .iter()
                .find(|entry| entry.name == "project.json")
                .unwrap()
                .path,
        )
        .unwrap(),
    )
    .unwrap();
    assert!(doc.get("lyricsHash").is_none());
    assert_eq!(doc["foreign"], 7);
}

#[test]
fn lyrics_hash_names_the_exact_private_bytes_even_after_live_lyrics_change() {
    let f = Fixture::new();
    let old = br#"{"lines":[{"text":"Old words"}]}"#;
    fs::write(f.root.join("Song/lyrics.json"), old).unwrap();
    let mut capture = f.capture().unwrap();
    fs::write(
        f.root.join("Song/lyrics.json"),
        br#"{"lines":[{"text":"New words"}]}"#,
    )
    .unwrap();
    let mut plan = drive_plan::plan_project(&capture.snapshot, &empty_remote()).unwrap();
    capture.spool_uploads(&mut plan, &|| false).unwrap();
    let uploaded = fs::read(
        &plan
            .upload
            .iter()
            .find(|s| s.name == "lyrics.json")
            .unwrap()
            .path,
    )
    .unwrap();
    let doc: Value = serde_json::from_slice(
        &fs::read(
            &plan
                .upload
                .iter()
                .find(|s| s.name == "project.json")
                .unwrap()
                .path,
        )
        .unwrap(),
    )
    .unwrap();
    assert_eq!(uploaded, old);
    assert_eq!(
        doc["lyricsHash"]["md5"],
        format!("{:x}", Md5::digest(&uploaded))
    );
    assert_eq!(doc["lyricsHash"]["size"], uploaded.len());
}

#[test]
fn missing_metadata_does_not_authorize_trashing_its_existing_remote_folder() {
    let f = Fixture::new();
    fs::remove_file(f.root.join("Song/project.json")).unwrap();
    assert!(scan(&f.root, &|| false).unwrap().is_empty());
    let protected = directory_names(&f.root, &|| false).unwrap();
    assert_eq!(protected, vec!["Song"]);
    let folder = RemoteEntry {
        id: "remoteSong".into(),
        name: "Song".into(),
        mime_type: Some(crate::drive_remote::FOLDER.into()),
        md5_checksum: None,
        size: None,
        parents: Vec::new(),
        app_properties: Default::default(),
    };
    assert!(
        drive_plan::orphan_folders(&[folder], &protected, crate::drive_remote::FOLDER)
            .unwrap()
            .is_empty()
    );
}
#[test]
fn nonregular_metadata_refuses_the_complete_roster_instead_of_omitting_a_song() {
    let f = Fixture::new();
    fs::remove_file(f.root.join("Song/project.json")).unwrap();
    fs::create_dir(f.root.join("Song/project.json")).unwrap();
    fs::create_dir_all(f.root.join("Readable")).unwrap();
    fs::write(f.root.join("Readable/project.json"), b"{}").unwrap();
    assert!(scan(&f.root, &|| false).is_err());
}
#[test]
fn accepted_save_intent_yields_capture_and_releases_its_writer_lease() {
    let f = Fixture::new();
    let mut capture = f.capture().unwrap();
    let mut plan = drive_plan::plan_project(&capture.snapshot, &empty_remote()).unwrap();
    let source = f.root.canonicalize().unwrap().join("Song");
    let intent = crate::project_publish::write_intent(&source).unwrap();
    assert!(capture.spool_uploads(&mut plan, &|| false).is_err());
    drop(capture);
    assert!(crate::project_publish::lock(&source).is_ok());
    drop(intent);
}

#[test]
fn native_publication_and_adoption_staging_never_enter_the_cloud_library() {
    let f = Fixture::new();
    for name in [
        ".singz-adopting-phone",
        ".singz-native-copy",
        ".native-import-working",
        ".native-split-working",
    ] {
        fs::create_dir_all(f.root.join(name)).unwrap();
        fs::write(f.root.join(name).join("project.json"), b"{}").unwrap();
    }
    assert_eq!(scan(&f.root, &|| false).unwrap(), vec!["Song"]);
    assert_eq!(directory_names(&f.root, &|| false).unwrap(), vec!["Song"]);
}
#[cfg(unix)]
#[test]
fn linked_audio_is_not_read_or_published() {
    let f = Fixture::new();
    let path = f.root.join("Song/stems/vocals.wav");
    fs::remove_file(&path).unwrap();
    std::os::unix::fs::symlink(f.root.join("Song/project.json"), path).unwrap();
    assert!(f.capture().is_err());
}

#[test]
fn surrogate_named_portable_graph_is_hash_bound_and_spooled_without_rewriting() {
    let f = Fixture::new();
    let source = f.root.join("Song");
    let graph = include_bytes!("../../../tests/shared/graph-document-utf16.json");
    fs::write(source.join("graph.json"), graph).unwrap();
    let metadata = source.join("project.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&metadata).unwrap()).unwrap();
    doc["graphHash"] = serde_json::json!({"format":1,"md5":format!("{:x}",Md5::digest(graph)),"size":graph.len(),"mtimeMs":0});
    let original = serde_json::to_vec(&doc).unwrap();
    fs::write(&metadata, &original).unwrap();
    let mut capture = f.capture().unwrap();
    let mut plan = drive_plan::plan_project(&capture.snapshot, &empty_remote()).unwrap();
    capture.spool_uploads(&mut plan, &|| false).unwrap();
    let upload = plan
        .upload
        .iter()
        .find(|step| step.name == "graph.json")
        .unwrap();
    assert_eq!(fs::read(&upload.path).unwrap(), graph);
    assert_eq!(fs::read(source.join("graph.json")).unwrap(), graph);
    assert_eq!(fs::read(&metadata).unwrap(), original);
    let transported = plan
        .upload
        .iter()
        .find(|step| step.name == "project.json")
        .unwrap();
    let transported: Value = serde_json::from_slice(&fs::read(&transported.path).unwrap()).unwrap();
    assert_eq!(transported["graphHash"], doc["graphHash"]);
    drop(capture);
    // A valid wire name is not authority to publish different graph bytes.
    fs::write(source.join("graph.json"), b"{}").unwrap();
    assert!(
        f.capture()
            .err()
            .unwrap()
            .to_string()
            .contains("graph bytes do not match")
    );
}

fn fixed_mtime(path: &Path, millis: f64) {
    let time = UNIX_EPOCH + std::time::Duration::from_secs_f64(millis / 1000.);
    File::options()
        .write(true)
        .open(path)
        .unwrap()
        .set_times(fs::FileTimes::new().set_modified(time))
        .unwrap();
}
fn transport(capture: &Capture) -> Vec<u8> {
    fs::read(
        &capture
            .snapshot
            .top
            .iter()
            .find(|e| e.name == "project.json")
            .unwrap()
            .path,
    )
    .unwrap()
}
#[test]
fn c11_transport_md5_matches_base_commit_golden() {
    let f = Fixture::new();
    fixed_mtime(&f.root.join("Song/stems/vocals.wav"), 1_700_000_000_000.);
    let cold = f.capture().unwrap();
    let bytes = transport(&cold);
    // Captured from b644c20a's unchanged snapshot logic with this fixed mtime.
    const BASE_MD5: &str = "365518dc1621234b1a0c45e42445943c";
    assert_eq!(format!("{:x}", Md5::digest(&bytes)), BASE_MD5);
    drop(cold);
    let warm = f.capture().unwrap();
    assert_eq!(transport(&warm), bytes);
    assert_eq!(format!("{:x}", Md5::digest(transport(&warm))), BASE_MD5);
}

fn cache_path(f: &Fixture) -> PathBuf {
    fs::read_dir(f.base.join("preferences/gdrive/hash-cache"))
        .unwrap()
        .map(|entry| entry.unwrap().path())
        .find(|path| path.extension().is_some_and(|ext| ext == "json"))
        .expect("persistent hash cache")
}
fn reset_digest_bytes() {
    DIGEST_BYTES.with(|bytes| bytes.set(0));
}
fn digest_bytes() -> u64 {
    DIGEST_BYTES.with(std::cell::Cell::get)
}
fn assert_second_capture_reads_zero(f: &Fixture) {
    reset_digest_bytes();
    drop(f.capture().unwrap());
    assert!(digest_bytes() > 0, "cold capture must digest audio");
    reset_digest_bytes();
    drop(f.capture().unwrap());
    assert_eq!(
        digest_bytes(),
        0,
        "second capture must digest zero audio bytes"
    );
}
#[test]
fn c11_second_capture_reloads_hashes_for_native_split_without_document_entries() {
    let f = Fixture::new();
    let doc = fs::read(f.root.join("Song/project.json")).unwrap();
    assert!(
        serde_json::from_slice::<Value>(&doc)
            .unwrap()
            .get("stemHashes")
            .is_none()
    );
    // Exercise the source hash too, even though stems suppress source upload.
    let mut document: Value = serde_json::from_slice(&doc).unwrap();
    document["songFile"] = json!("original.wav");
    fs::write(
        f.root.join("Song/project.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    fs::write(f.root.join("Song/original.wav"), b"original source bytes").unwrap();
    assert_second_capture_reads_zero(&f);
    let cache = cache_path(&f);
    let before = fs::metadata(&cache).unwrap().modified().unwrap();
    drop(f.capture().unwrap());
    assert_eq!(
        fs::metadata(cache).unwrap().modified().unwrap(),
        before,
        "unchanged cache must not be rewritten"
    );
}
#[test]
#[should_panic(expected = "second capture must digest zero audio bytes")]
fn c11_negative_control_without_cache_save_rejects_zero_read_claim() {
    struct Restore;
    impl Drop for Restore {
        fn drop(&mut self) {
            DISABLE_CACHE_SAVE.with(|value| value.set(false));
        }
    }
    let _restore = Restore;
    DISABLE_CACHE_SAVE.with(|value| value.set(true));
    assert_second_capture_reads_zero(&Fixture::new());
}
#[test]
fn c11_mtime_boundary_reuses_at_1_5ms_and_digests_at_2_5ms() {
    let f = Fixture::new();
    let path = f.root.join("Song/stems/vocals.wav");
    let original = fs::read(&path).unwrap();
    let stamp = 1_700_000_000_000.;
    fixed_mtime(&path, stamp);
    let cold = f.capture().unwrap();
    let old_md5 = cold.snapshot.stems[0].md5.clone();
    drop(cold);
    fs::write(&path, vec![b'x'; original.len()]).unwrap();
    fixed_mtime(&path, stamp + 1.5);
    reset_digest_bytes();
    let within = f.capture().unwrap();
    assert_eq!(digest_bytes(), 0, "1.5 ms must reuse sidecar hash");
    assert_eq!(within.snapshot.stems[0].md5, old_md5);
    drop(within);
    fixed_mtime(&path, stamp + 2.5);
    reset_digest_bytes();
    let outside = f.capture().unwrap();
    assert_eq!(digest_bytes(), original.len() as u64);
    assert_ne!(outside.snapshot.stems[0].md5, old_md5);
}
#[test]
fn c11_recreated_directory_does_not_inherit_old_hash() {
    let f = Fixture::new();
    let project = f.root.join("Song");
    let bytes = fs::read(project.join("project.json")).unwrap();
    let stamp = 1_700_000_000_000.;
    fixed_mtime(&project.join("stems/vocals.wav"), stamp);
    let old = f.capture().unwrap();
    let old_md5 = old.snapshot.stems[0].md5.clone();
    let identity = old.local_identity.clone();
    drop(old);
    let old_cache = cache_path(&f);
    let old_record = fs::read(&old_cache).unwrap();
    fs::remove_dir_all(&project).unwrap();
    fs::create_dir_all(project.join("stems")).unwrap();
    fs::write(project.join("project.json"), bytes).unwrap();
    fs::write(
        project.join("stems/vocals.wav"),
        vec![b'x'; b"immutable source audio".len()],
    )
    .unwrap();
    fixed_mtime(&project.join("stems/vocals.wav"), stamp);
    let current = crate::directory_identity::read(&project).unwrap();
    #[cfg(target_os = "linux")]
    if current == current.legacy_key() {
        // Write directly so libtest does not hide this warning on success.
        std::io::Write::write_all(&mut std::io::stderr().lock(), b"generation unavailable on this filesystem: inode-reuse protection not provable here\n").unwrap();
        // Unsupported generation retains the released dev+ino+birth rule.
        // With every released field reused, even this stale hash is reusable;
        // asserting a rehash here would promise protection the FS cannot give.
        assert_eq!(identity, identity.legacy_key());
        assert_eq!(identity.matches_live(&current).unwrap(), identity == current);
        if identity == current {
            assert!(identity.persistent_eligible());
            reset_digest_bytes();
            let fallback = f.capture().unwrap();
            assert_eq!(digest_bytes(), 0, "released identity must retain its cache behavior");
            assert_eq!(fallback.snapshot.stems[0].md5, old_md5);
            drop(fallback);
            fs::remove_dir_all(&project).unwrap();
            crate::drive_hash_cache::prune(&f.base.join("preferences"), &f.root.canonicalize().unwrap());
            assert!(!old_cache.exists());
            return;
        }
    }
    assert_ne!(current, identity);
    reset_digest_bytes();
    let recreated = f.capture().unwrap();
    assert!(digest_bytes() > 0);
    assert_ne!(recreated.snapshot.stems[0].md5, old_md5);
    drop(recreated);
    // Put the old identity's record at the new key, to exercise load validation
    // independently of the identity-key separation above (and path fallback).
    let new_cache = fs::read_dir(old_cache.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().path())
        .find(|path| path != &old_cache)
        .unwrap_or(old_cache.clone());
    fs::write(&new_cache, old_record).unwrap();
    reset_digest_bytes();
    let checked = f.capture().unwrap();
    assert!(digest_bytes() > 0);
    assert_ne!(checked.snapshot.stems[0].md5, old_md5);
    assert!(crate::drive_hash_cache::WARNINGS.with(std::cell::Cell::get) > 0);
    drop(checked);
    fs::remove_dir_all(&project).unwrap();
    crate::drive_hash_cache::prune(&f.base.join("preferences"), &f.root.canonicalize().unwrap());
    assert!(!new_cache.exists());
}
#[test]
fn c11_legacy_linux_identity_reuses_released_hash_cache() {
    let f = Fixture::new();
    let project = f.root.join("Song").canonicalize().unwrap();
    let config = f.base.join("preferences");
    let directory = config.join("gdrive/hash-cache");
    fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&config, &config.join("gdrive"), &directory] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let old: Value = serde_json::from_str(r#"{"platform":"linux","volume":168,"file":3447087,"created":{"before_epoch":false,"seconds":1794378511,"nanos":327800163}}"#).unwrap();
    let mut current = old.clone();
    current["generation"] = 7.into();
    let identity: crate::directory_identity::DirectoryIdentity =
        serde_json::from_value(current).unwrap();
    let legacy_identity: crate::directory_identity::DirectoryIdentity = serde_json::from_value(old.clone()).unwrap();
    let key = crate::project_store::fingerprint(&serde_json::to_vec(&legacy_identity).unwrap());
    let path = directory.join(format!("{key}.json"));
    // The released filename and identity remain usable after upgrading.
    let bytes = serde_json::to_vec(&serde_json::json!({"version":1,"project":project,
        "identity":old,"entries":{"stems/vocals.wav":{"md5":"00000000000000000000000000000000",
        "size":21,"mtimeMs":1700000000000u64}}}))
    .unwrap();
    use std::io::Write;
    crate::drive_http::private_file(&path)
        .unwrap()
        .write_all(&bytes)
        .unwrap();
    let cache = crate::drive_hash_cache::Cache::load(&config, &project, identity.clone()).unwrap();
    assert!(
        cache.get("stems/vocals.wav")["md5"] == "00000000000000000000000000000000",
        "legacy identity must retain released cache behavior"
    );
    let mut strong_record: Value = serde_json::from_slice(&bytes).unwrap();
    strong_record["identity"]["generation"] = 8.into();
    fs::write(&path, serde_json::to_vec(&strong_record).unwrap()).unwrap();
    let changed = crate::drive_hash_cache::Cache::load(&config, &project, identity.clone()).unwrap();
    assert!(changed.get("stems/vocals.wav").is_null(), "Two differing generations must force a digest");
    strong_record["identity"]["generation"] = 7.into();
    let strong_bytes = serde_json::to_vec(&strong_record).unwrap();
    fs::write(&path, &strong_bytes).unwrap();
    let weak = serde_json::from_value(old).unwrap();
    let unavailable = crate::drive_hash_cache::Cache::load(&config, &project, weak).unwrap();
    assert!(unavailable.get("stems/vocals.wav").is_null(),
        "An unverifiable advisory cache must miss without deferring sync");
    assert_eq!(fs::read(&path).unwrap(), strong_bytes);
}
#[test]
fn c11_cache_generation_loss_rehashes_instead_of_deferring_capture() {
    crate::directory_identity::with_test_generation(Some(7), || {
        let f = Fixture::new();
        let first = f.capture().unwrap();
        let md5 = first.snapshot.stems[0].md5.clone();
        drop(first);
        crate::directory_identity::with_test_generation(None, || {
            reset_digest_bytes();
            let current = f.capture().unwrap();
            assert!(digest_bytes() > 0);
            assert_eq!(current.snapshot.stems[0].md5, md5);
        });
    });
}
#[test]
fn c11_disagreeing_fresh_electron_and_sidecar_entries_force_digest() {
    let f = Fixture::new();
    let cold = f.capture().unwrap();
    let mut document: Value = serde_json::from_slice(&transport(&cold)).unwrap();
    let actual = cold.snapshot.stems[0].md5.clone();
    drop(cold);
    document["stemHashes"]["vocals.wav"]["md5"] = json!("00000000000000000000000000000000");
    fs::write(
        f.root.join("Song/project.json"),
        serde_json::to_vec(&document).unwrap(),
    )
    .unwrap();
    reset_digest_bytes();
    let conflict = f.capture().unwrap();
    assert_eq!(digest_bytes(), b"immutable source audio".len() as u64);
    assert_eq!(conflict.snapshot.stems[0].md5, actual);
    drop(conflict);
    // Fresh Electron entries still take precedence when the sidecar is absent.
    fs::remove_file(cache_path(&f)).unwrap();
    reset_digest_bytes();
    let electron = f.capture().unwrap();
    assert_eq!(digest_bytes(), 0);
    assert_eq!(
        electron.snapshot.stems[0].md5,
        "00000000000000000000000000000000"
    );
}
#[test]
fn c11_corrupt_oversized_or_linked_cache_is_only_a_warning() {
    let f = Fixture::new();
    drop(f.capture().unwrap());
    let path = cache_path(&f);
    for bytes in [
        b"invalid JSON".to_vec(),
        vec![b' '; crate::drive_hash_cache::LIMIT as usize + 1],
    ] {
        fs::write(&path, bytes).unwrap();
        reset_digest_bytes();
        crate::drive_hash_cache::WARNINGS.with(|warnings| warnings.set(0));
        let capture = f.capture().unwrap();
        assert_eq!(
            capture.snapshot.stems[0].md5,
            format!("{:x}", Md5::digest(b"immutable source audio"))
        );
        assert!(crate::drive_hash_cache::WARNINGS.with(std::cell::Cell::get) > 0);
        assert!(digest_bytes() > 0);
        drop(capture);
    }
    #[cfg(unix)]
    {
        fs::remove_file(&path).unwrap();
        let target = f.base.join("keep.json");
        fs::write(&target, b"untouched target").unwrap();
        std::os::unix::fs::symlink(&target, &path).unwrap();
        reset_digest_bytes();
        crate::drive_hash_cache::WARNINGS.with(|warnings| warnings.set(0));
        let capture = f.capture().unwrap();
        assert!(crate::drive_hash_cache::WARNINGS.with(std::cell::Cell::get) > 0);
        assert!(digest_bytes() > 0);
        assert_eq!(fs::read(&target).unwrap(), b"untouched target");
        assert!(
            fs::symlink_metadata(&path)
                .unwrap()
                .file_type()
                .is_symlink()
        );
        drop(capture);
        fs::remove_file(&path).unwrap();
        let drive = f.base.join("preferences/gdrive");
        let outside = f.base.join("outside-drive");
        fs::rename(&drive, &outside).unwrap();
        std::os::unix::fs::symlink(&outside, &drive).unwrap();
        reset_digest_bytes();
        crate::drive_hash_cache::WARNINGS.with(|warnings| warnings.set(0));
        let capture = f.capture().unwrap();
        assert!(digest_bytes() > 0);
        assert!(crate::drive_hash_cache::WARNINGS.with(std::cell::Cell::get) > 0);
        assert_eq!(fs::read_dir(outside.join("hash-cache")).unwrap().count(), 0,
            "unsafe storage must not receive a cache write after load was refused");
        drop(capture);
    }
}

#[test]
fn c11_review_sidecar_extra_fields_never_reach_transport_hashes() {
    let f = Fixture::new();
    let project = f.root.join("Song");
    fs::write(
        project.join("project.json"),
        br#"{"name":"Song","songFile":"original.wav","settings":{}}"#,
    )
    .unwrap();
    fs::write(project.join("original.wav"), b"original source bytes").unwrap();
    drop(f.capture().unwrap());
    let path = cache_path(&f);
    let mut record: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    for key in ["stems/vocals.wav", "source/original.wav"] {
        record["entries"][key]["privateSidecarField"] = json!({"mustNotUpload": true});
    }
    fs::write(&path, serde_json::to_vec(&record).unwrap()).unwrap();
    reset_digest_bytes();
    let warm = f.capture().unwrap();
    assert_eq!(
        digest_bytes(),
        0,
        "valid cached hash facts still avoid audio IO"
    );
    let transported: Value = serde_json::from_slice(&transport(&warm)).unwrap();
    for entry in [
        &transported["stemHashes"]["vocals.wav"],
        &transported["songHash"],
    ] {
        let fields = entry
            .as_object()
            .unwrap()
            .keys()
            .map(String::as_str)
            .collect::<std::collections::BTreeSet<_>>();
        assert_eq!(
            fields,
            std::collections::BTreeSet::from(["md5", "size", "mtimeMs"])
        );
    }
}

#[test]
fn c11_review_birthless_recreated_directory_with_reused_inode_is_digested() {
    let f = Fixture::new();
    let project = f.root.canonicalize().unwrap().join("Song");
    let stem = project.join("stems/vocals.wav");
    fixed_mtime(&stem, 1_700_000_000_000.);
    // Model a birthless filesystem reusing the same dev+ino at the same path.
    let mut identity =
        serde_json::to_value(crate::directory_identity::read(&project).unwrap()).unwrap();
    identity["created"] = Value::Null;
    let identity: crate::directory_identity::DirectoryIdentity =
        serde_json::from_value(identity).unwrap();
    assert!(!identity.persistent_eligible());
    let config = f.base.join("preferences");
    let hash = hash_value(&stem, &Value::Null, &Value::Null, &|| false).unwrap();
    let mut cache = crate::drive_hash_cache::Cache::load(&config, &project, identity.clone()).unwrap();
    cache.remember("stems/vocals.wav".into(), hash.clone());
    cache.save();
    let directory = config.join("gdrive/hash-cache");
    let path = directory.join(format!(
        "{}.json",
        crate::project_store::fingerprint(project.as_os_str().as_encoded_bytes())
    ));
    let persisted = path.exists();
    // Seed a pre-fix path-keyed record too: upgrading must not trust old entries.
    fs::create_dir_all(&directory).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        for path in [&config, &config.join("gdrive"), &directory] {
            fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
        }
    }
    let legacy = serde_json::to_vec(&json!({"version":1,"project":project,"identity":identity,"entries":{"stems/vocals.wav":hash}})).unwrap();
    if path.exists() {
        fs::remove_file(&path).unwrap();
    }
    let mut file = crate::drive_http::private_file(&path).unwrap();
    file.write_all(&legacy).unwrap();
    drop(file);
    fs::remove_dir_all(&project).unwrap();
    fs::create_dir_all(project.join("stems")).unwrap();
    let changed = vec![b'x'; b"immutable source audio".len()];
    fs::write(&stem, &changed).unwrap();
    fixed_mtime(&stem, 1_700_000_000_000.);
    let cache = crate::drive_hash_cache::Cache::load(&config, &project, identity).unwrap();
    reset_digest_bytes();
    let current = hash_value(&stem, &Value::Null, cache.get("stems/vocals.wav"), &|| {
        false
    })
    .unwrap();
    assert_eq!(
        digest_bytes(),
        changed.len() as u64,
        "a recycled birthless inode must not reuse a persisted hash"
    );
    assert_eq!(current["md5"], format!("{:x}", Md5::digest(&changed)));
    assert!(!persisted, "birthless identities must not persist sidecars");
    assert_eq!(
        fs::read(path).unwrap(),
        legacy,
        "legacy hints must remain unused"
    );
}

#[test]
fn c11_review_prune_sweeps_only_old_owned_temporary_files() {
    let f = Fixture::new();
    drop(f.capture().unwrap());
    let directory = cache_path(&f).parent().unwrap().to_owned();
    let old = directory.join(format!(".hash-{}.part", "a".repeat(48)));
    let recent = directory.join(format!(".hash-{}.part", "b".repeat(48)));
    let unrelated = directory.join(".hash-unrelated.part");
    for path in [&old, &recent, &unrelated] {
        let mut file = crate::drive_http::private_file(path).unwrap();
        file.write_all(b"interrupted cache write").unwrap();
    }
    let old_time = std::time::SystemTime::now() - std::time::Duration::from_secs(7200);
    for path in [&old, &unrelated] {
        File::options()
            .write(true)
            .open(path)
            .unwrap()
            .set_times(fs::FileTimes::new().set_modified(old_time))
            .unwrap();
    }
    crate::drive_hash_cache::prune(&f.base.join("preferences"), &f.root.canonicalize().unwrap());
    assert!(!old.exists(), "orphaned cache temporary must be swept");
    assert!(recent.exists(), "a recent writer's temporary must remain");
    assert!(
        unrelated.exists(),
        "unrecognized temporary names must remain"
    );
}

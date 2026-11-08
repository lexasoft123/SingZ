use super::*;
use crate::drive_plan::{self, RemoteEntry, RemoteProject};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    spool: PathBuf,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
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
        capture(&self.root, "Song", &self.spool, &|| false)
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

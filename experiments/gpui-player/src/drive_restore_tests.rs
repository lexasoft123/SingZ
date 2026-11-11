use super::*;
use md5::{Digest, Md5};
use serde_json::json;
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        let p = std::env::temp_dir().join(format!(
            "singz-drive-restore-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir(&p).unwrap();
        Self(p.canonicalize().unwrap())
    }
    fn cache(&self) -> PathBuf {
        self.0.join("cache")
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[derive(Default)]
struct Fake {
    roots: Vec<RemoteEntry>,
    children: HashMap<String, Vec<RemoteEntry>>,
    bytes: HashMap<String, Vec<u8>>,
    calls: Mutex<Vec<String>>,
    fail: Mutex<Option<String>>,
    corrupt: AtomicBool,
}
impl Reader for Fake {
    fn list(&self, _: &str, c: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        check(c)?;
        self.calls.lock().unwrap().push("LIST roots".into());
        Ok(self.roots.clone())
    }
    fn children(&self, id: &str, c: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        check(c)?;
        self.calls.lock().unwrap().push(format!("LIST {id}"));
        Ok(self.children.get(id).cloned().unwrap_or_default())
    }
    fn download(
        &self,
        file: &RemoteEntry,
        path: &Path,
        limit: u64,
        c: &impl Fn() -> bool,
        _: &impl Fn(String, f32),
    ) -> Result<()> {
        check(c)?;
        self.calls.lock().unwrap().push(format!("GET {}", file.id));
        if self.fail.lock().unwrap().as_deref() == Some(&file.id) {
            anyhow::bail!("simulated interrupted GET");
        }
        let mut bytes = self
            .bytes
            .get(&file.id)
            .context("missing fake bytes")?
            .clone();
        ensure!(bytes.len() as u64 <= limit, "test response exceeds limit");
        if self.corrupt.load(Ordering::Acquire) {
            bytes.push(0);
        }
        fs::write(path, bytes)?;
        Ok(())
    }
}
fn folder(id: &str, name: &str, parent: &str) -> RemoteEntry {
    RemoteEntry {
        id: id.into(),
        name: name.into(),
        mime_type: Some(FOLDER.into()),
        parents: vec![parent.into()],
        ..Default::default()
    }
}
fn file(id: &str, name: &str, parent: &str, bytes: &[u8]) -> RemoteEntry {
    RemoteEntry {
        id: id.into(),
        name: name.into(),
        mime_type: Some("application/octet-stream".into()),
        md5_checksum: Some(format!("{:x}", Md5::digest(bytes))),
        size: Some(bytes.len().to_string()),
        parents: vec![parent.into()],
        ..Default::default()
    }
}
fn hash(bytes: &[u8]) -> Value {
    json!({"md5":format!("{:x}",Md5::digest(bytes)),"size":bytes.len(),"mtimeMs":0})
}
fn audio() -> Vec<u8> {
    let mut v = Vec::new();
    v.extend(b"RIFF");
    v.extend(68u32.to_le_bytes());
    v.extend(b"WAVEfmt ");
    v.extend(16u32.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(1u16.to_le_bytes());
    v.extend(16000u32.to_le_bytes());
    v.extend(32000u32.to_le_bytes());
    v.extend(2u16.to_le_bytes());
    v.extend(16u16.to_le_bytes());
    v.extend(b"data");
    v.extend(32u32.to_le_bytes());
    v.extend([0u8; 32]);
    v
}
fn setup(doc: Value, payloads: Vec<(&str, &str, Vec<u8>)>) -> Fake {
    let mut r = Fake {
        roots: vec![folder("root", "SingZ", "drive")],
        ..Default::default()
    };
    r.children.insert(
        "root".into(),
        vec![folder("project", "Remote song", "root")],
    );
    let bytes = serde_json::to_vec(&doc).unwrap();
    r.bytes.insert("doc".into(), bytes.clone());
    let mut top = vec![file("doc", "project.json", "project", &bytes)];
    let mut stems = Vec::new();
    for (id, rel, bytes) in payloads {
        r.bytes.insert(id.into(), bytes.clone());
        if let Some(name) = rel.strip_prefix("stems/") {
            stems.push(file(id, name, "stems", &bytes));
        } else {
            top.push(file(id, rel, "project", &bytes));
        }
    }
    if !stems.is_empty() {
        top.push(folder("stems", "stems", "project"));
        r.children.insert("stems".into(), stems);
    }
    r.children.insert("project".into(), top);
    r
}
fn stem_only() -> Fake {
    let bytes = audio();
    setup(
        json!({"version":2,"name":"Remote song","stemHashes":{"vocals.wav":hash(&bytes)},"settings":{}}),
        vec![("vocals", "stems/vocals.wav", bytes)],
    )
}
fn empty() -> Fake {
    setup(
        json!({"version":2,"name":"Empty song","stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}}),
        Vec::new(),
    )
}
#[test]
fn absent_remote_root_is_read_only_and_not_created() {
    let f = Fixture::new();
    let r = Fake::default();
    assert!(list_with(&r, &f.cache(), &|| false).unwrap().is_empty());
    assert_eq!(*r.calls.lock().unwrap(), vec!["LIST roots"]);
    assert!(!f.cache().exists());
}
#[test]
fn stem_only_restore_downloads_only_declared_audio_and_survives_offline() {
    let f = Fixture::new();
    let mut r = stem_only();
    let old = audio();
    r.children
        .get_mut("stems")
        .unwrap()
        .push(file("old", "drums.wav", "stems", &old));
    r.bytes.insert("old".into(), old);
    let rows = list_with(&r, &f.cache(), &|| false).unwrap();
    assert_eq!(rows.len(), 1);
    assert!(rows[0].song_path.is_none());
    let restored = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(restored.join("stems/vocals.wav").is_file());
    assert!(!restored.join("stems/drums.wav").exists());
    assert!(!r.calls.lock().unwrap().iter().any(|c| c == "GET old"));
    let p = crate::integration::read_project(&restored).unwrap();
    assert!(!p.original && !p.empty_tracks && p.lanes.len() == 1);
    assert_eq!(cached(&f.cache()).unwrap()[0].song_path, Some(restored));
}
#[test]
fn empty_restore_never_enumerates_or_downloads_old_remote_audio() {
    let f = Fixture::new();
    let mut r = empty();
    let old = audio();
    r.children
        .get_mut("project")
        .unwrap()
        .push(folder("old-stems", "stems", "project"));
    r.children.insert(
        "old-stems".into(),
        vec![file("old", "vocals.wav", "old-stems", &old)],
    );
    let restored = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(!restored.join("stems").exists());
    let p = crate::integration::read_project(&restored).unwrap();
    assert!(p.empty_tracks && p.lanes.is_empty());
    assert!(!r.calls.lock().unwrap().iter().any(|c| c.contains("old")));
}
#[test]
fn implicit_or_malformed_empty_projects_are_rejected() {
    for doc in [
        json!({"settings":{}}),
        json!({"settings":{"nativeEmptyTracks":true,"custom":[]}}),
        json!({"stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[{}]}}),
        json!({"songFile":"old.wav","stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}}),
        json!({"stemHashes":{},"settings":{"nativeEmptyTracks":"true","nativeOriginalDisabled":true,"custom":[]}}),
    ] {
        assert!(declared_payloads(&doc).is_err(), "accepted {doc}");
    }
}
#[test]
fn local_edits_and_undeclared_files_never_get_overwritten_or_reused() {
    let f = Fixture::new();
    let r = stem_only();
    let first = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_eq!(
        first,
        download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap()
    );
    fs::write(first.join("project.json"), br#"{"name":"My local edit"}"#).unwrap();
    // Deliberate metadata edits remain available offline if the project still opens.
    assert_eq!(cached(&f.cache()).unwrap().len(), 1); // Retained builtin stems keep the edited project playable.
    let second = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(first, second);
    assert_eq!(
        read_json(&first.join("project.json")).unwrap()["name"],
        "My local edit"
    );
    fs::write(second.join("stems/drums.wav"), audio()).unwrap();
    assert_eq!(cached(&f.cache()).unwrap().len(), 1); // A valid local added stem is an edit, not remote-cache reuse.
    let third = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(third, second);
    assert!(second.join("stems/drums.wav").is_file());
}
#[test]
fn interrupted_download_is_private_and_resumes_verified_members() {
    let f = Fixture::new();
    let r = stem_only();
    *r.fail.lock().unwrap() = Some("vocals".into());
    assert!(download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).is_err());
    assert!(cached(&f.cache()).unwrap().is_empty());
    assert_eq!(
        r.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() == "GET doc")
            .count(),
        1
    );
    *r.fail.lock().unwrap() = None;
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(path.join("project.json").is_file());
    assert_eq!(
        r.calls
            .lock()
            .unwrap()
            .iter()
            .filter(|c| c.as_str() == "GET doc")
            .count(),
        1,
        "verified metadata should resume without GET"
    );
}
#[test]
fn corruption_and_listing_mismatch_do_not_publish_a_cache_row() {
    let f = Fixture::new();
    let mut r = stem_only();
    r.children.get_mut("stems").unwrap()[0].md5_checksum = Some("0".repeat(32));
    assert!(download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).is_err());
    assert!(cached(&f.cache()).unwrap().is_empty());
    let f = Fixture::new();
    let r = stem_only();
    r.corrupt.store(true, Ordering::Release);
    assert!(download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).is_err());
    assert!(cached(&f.cache()).unwrap().is_empty());
}
#[test]
fn cancel_does_not_publish_or_change_existing_cached_copy() {
    let f = Fixture::new();
    let r = stem_only();
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let before = fs::read(path.join("project.json")).unwrap();
    assert!(download_with(&r, "project", &f.cache(), &|| true, &|_, _| {}).is_err());
    assert_eq!(fs::read(path.join("project.json")).unwrap(), before);
}
#[test]
fn unsafe_declared_paths_and_remote_collisions_are_rejected() {
    for path in [
        "../outside.wav",
        "stems/../../outside.wav",
        "stems/a/other.wav",
        "C:\\outside.wav",
    ] {
        let doc = json!({"stemHashes":{"custom-a.wav":hash(&audio())},"settings":{"custom":[{"id":"custom-a","file":path}]}});
        assert!(declared_payloads(&doc).is_err());
    }
    let f = Fixture::new();
    let mut r = stem_only();
    let duplicate = file("other", "PROJECT.JSON", "project", b"{}");
    r.children.get_mut("project").unwrap().push(duplicate);
    assert!(list_with(&r, &f.cache(), &|| false).is_err());
    assert!(!f.cache().exists());
}
#[cfg(unix)]
#[test]
fn linked_cache_or_resume_directory_cannot_redirect_downloads() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = f.0.join("outside");
    fs::create_dir(&outside).unwrap();
    symlink(&outside, f.cache()).unwrap();
    let r = stem_only();
    assert!(download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).is_err());
    assert!(fs::read_dir(&outside).unwrap().next().is_none());
}

#[test]
fn actual_remote_rest_restore_is_get_only_and_retries_private_payloads() {
    use crate::drive_auth::{AuthClient, Config, TokenStore};
    use std::{
        io::{BufRead, BufReader},
        net::TcpListener,
        sync::Arc,
        thread,
        time::Duration,
    };
    struct Server {
        stop: Arc<AtomicBool>,
        worker: Option<thread::JoinHandle<()>>,
    }
    impl Drop for Server {
        fn drop(&mut self) {
            self.stop.store(true, Ordering::Release);
            if let Some(t) = self.worker.take() {
                t.join().unwrap();
            }
        }
    }
    let f = Fixture::new();
    let fixture = stem_only();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server_base = base.clone();
    let calls = Arc::new(Mutex::new(Vec::<String>::new()));
    let received = calls.clone();
    let stop = Arc::new(AtomicBool::new(false));
    let stopped = stop.clone();
    let worker = thread::spawn(move || {
        let mut first_audio = true;
        while !stopped.load(Ordering::Acquire) {
            let (mut stream, _) = match listener.accept() {
                Ok(p) => p,
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(2));
                    continue;
                }
                Err(e) => panic!("{e}"),
            };
            stream.set_nonblocking(false).unwrap();
            stream
                .set_read_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            stream
                .set_write_timeout(Some(Duration::from_secs(5)))
                .unwrap();
            let mut input = BufReader::new(stream.try_clone().unwrap());
            let mut first = String::new();
            input.read_line(&mut first).unwrap();
            let parts = first.split_whitespace().collect::<Vec<_>>();
            assert_eq!(parts[0], "GET", "Restore must not mutate remote state");
            let url = url::Url::parse(&format!("{server_base}{}", parts[1])).unwrap();
            let mut auth = false;
            loop {
                let mut line = String::new();
                assert!(input.read_line(&mut line).unwrap() > 0);
                if line == "\r\n" {
                    break;
                }
                if line
                    .trim()
                    .eq_ignore_ascii_case("Authorization: Bearer restore-unit-access")
                {
                    auth = true;
                }
            }
            assert!(auth);
            received.lock().unwrap().push(url.to_string());
            let (status, bytes) = if url.path() == "/drive/v3/files" {
                let query = url
                    .query_pairs()
                    .find(|(k, _)| k == "q")
                    .unwrap()
                    .1
                    .into_owned();
                let files = if query.contains("name='SingZ'") {
                    fixture.roots.clone()
                } else {
                    fixture
                        .children
                        .iter()
                        .find(|(id, _)| query.contains(&format!("'{id}' in parents")))
                        .map(|(_, v)| v.clone())
                        .unwrap_or_default()
                };
                (200, serde_json::to_vec(&json!({"files":files})).unwrap())
            } else {
                let id = url.path().strip_prefix("/drive/v3/files/").unwrap();
                assert!(url.query_pairs().any(|(k, v)| k == "alt" && v == "media"));
                if id == "vocals" && first_audio {
                    first_audio = false;
                    (503, b"retry".to_vec())
                } else {
                    (200, fixture.bytes[id].clone())
                }
            };
            write!(
                stream,
                "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                bytes.len()
            )
            .unwrap();
            stream.write_all(&bytes).unwrap();
        }
    });
    let _server = Server {
        stop,
        worker: Some(worker),
    };
    let config = Config::from_json(
        &json!({"clientId":"restore-unit-client","authBase":base,"apiBase":base,"uploadBase":base})
            .to_string(),
    )
    .unwrap();
    let _store = TokenStore::new(&f.0).unwrap();
    let session = f.0.join("gdrive/session.json");
    let expiry = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 3_600_000;
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options.open(&session).unwrap().write_all(&serde_json::to_vec(&json!({"generation":1,"tokens":{"access":"restore-unit-access","refresh":"restore-unit-refresh","expiresAt":expiry}})).unwrap()).unwrap();
    let remote = Remote::new(AuthClient::new(config, TokenStore::new(&f.0).unwrap()));
    let rows = list(&remote, &f.cache(), &|| false).unwrap();
    assert_eq!(rows.len(), 1);
    let path = download(&remote, &rows[0].id, &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(path.join("stems/vocals.wav").is_file());
    assert_eq!(cached(&f.cache()).unwrap().len(), 1);
    assert_eq!(
        calls
            .lock()
            .unwrap()
            .iter()
            .filter(|u| u.contains("/vocals?alt=media"))
            .count(),
        2,
        "real downloader should retry 503"
    );
}

#[test]
fn saved_local_metadata_edit_remains_openable_offline_but_download_uses_fresh_copy() {
    let f = Fixture::new();
    let r = stem_only();
    let first = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let mut doc = read_json(&first.join("project.json")).unwrap();
    doc["name"] = json!("My saved local title");
    doc["settings"]["masterVolume"] = json!(0.25);
    fs::write(
        first.join("project.json"),
        serde_json::to_vec(&doc).unwrap(),
    )
    .unwrap();
    let rows = cached(&f.cache()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].name, "My saved local title");
    assert_eq!(rows[0].song_path.as_ref(), Some(&first));
    let next = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(first, next);
    assert_eq!(
        read_json(&first.join("project.json")).unwrap()["name"],
        "My saved local title"
    );
}
#[test]
fn desktop_stem_metadata_can_retain_an_unavailable_original_reference() {
    let f = Fixture::new();
    let bytes = audio();
    let doc = json!({"version":2,"name":"Stem-only copy","songFile":"original.m4a","songHash":hash(b"not uploaded"),"stemHashes":{"vocals.wav":hash(&bytes)},"settings":{}});
    let r = setup(doc, vec![("vocals", "stems/vocals.wav", bytes)]);
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(!path.join("original.m4a").exists());
    assert_eq!(
        crate::integration::read_project(&path).unwrap().lanes.len(),
        1
    );
}

#[test]
fn cached_corrupt_metadata_or_missing_custom_reference_is_not_openable() {
    let f = Fixture::new();
    let r = stem_only();
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let original = read_json(&path.join("project.json")).unwrap();
    fs::write(path.join("project.json"), b"not json").unwrap();
    assert!(cached(&f.cache()).unwrap().is_empty());
    let mut broken = original;
    broken["settings"]["custom"] =
        json!([{"id":"custom-missing","label":"Missing","file":"stems/custom-missing.wav"}]);
    fs::write(
        path.join("project.json"),
        serde_json::to_vec(&broken).unwrap(),
    )
    .unwrap();
    assert!(cached(&f.cache()).unwrap().is_empty());
}

#[test]
fn interrupted_restore_reuses_verified_lyrics_graph_and_original_audio() {
    let f = Fixture::new();
    let bytes = audio();
    let graph = include_bytes!("../../../tests/shared/native-playback-graph.json").to_vec();
    let lyrics = serde_json::to_vec(
        &json!({"source":"edited","lines":[{"start":0,"end":1,"text":"Private restore"}]}),
    )
    .unwrap();
    let mut graph_hash = hash(&graph);
    graph_hash["format"] = json!(1);
    let doc = json!({"version":2,"name":"Resumed full project","songFile":"original.wav","songHash":hash(&bytes),
        "stemHashes":{"vocals.wav":hash(&bytes)},"graphHash":graph_hash,"lyricsHash":hash(&lyrics),"settings":{}});
    let r = setup(
        doc,
        vec![
            ("graph", "graph.json", graph.clone()),
            ("lyrics", "lyrics.json", lyrics.clone()),
            ("original", "original.wav", bytes.clone()),
            ("vocals", "stems/vocals.wav", bytes),
        ],
    );
    *r.fail.lock().unwrap() = Some("vocals".into());
    assert!(download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).is_err());
    assert!(cached(&f.cache()).unwrap().is_empty());
    for id in ["doc", "graph", "lyrics", "original"] {
        assert_eq!(
            r.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.as_str() == format!("GET {id}"))
                .count(),
            1,
            "{id} was not verified before interruption"
        );
    }
    *r.fail.lock().unwrap() = None;
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    for id in ["doc", "graph", "lyrics", "original"] {
        assert_eq!(
            r.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.as_str() == format!("GET {id}"))
                .count(),
            1,
            "verified {id} was downloaded again"
        );
    }
    assert_eq!(fs::read(path.join("graph.json")).unwrap(), graph);
    assert_eq!(fs::read(path.join("lyrics.json")).unwrap(), lyrics);
    assert!(
        crate::integration::read_project(&path)
            .unwrap()
            .graph
            .is_some()
    );
    assert_eq!(cached(&f.cache()).unwrap().len(), 1);
}
#[cfg(unix)]
#[test]
fn cached_top_level_links_are_refused_even_when_the_project_reader_would_ignore_them() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let r = stem_only();
    let path = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let outside = f.0.join("outside-lyrics.json");
    fs::write(&outside, b"{}").unwrap();
    symlink(&outside, path.join("lyrics.json")).unwrap();
    assert!(cached(&f.cache()).unwrap().is_empty());
    assert_eq!(fs::read(&outside).unwrap(), b"{}");
    fs::remove_file(path.join("lyrics.json")).unwrap();
    assert_eq!(cached(&f.cache()).unwrap().len(), 1);
    symlink(f.0.join("not-present.wav"), path.join("original.wav")).unwrap();
    assert!(cached(&f.cache()).unwrap().is_empty());
}

#[test]
fn renamed_cached_project_keeps_remote_identity_and_saved_local_title_offline() {
    let f = Fixture::new();
    let r = stem_only();
    let original = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let renamed = f.cache().join("My renamed cached song");
    crate::project_library::publish_directory(&original, &renamed).unwrap();
    let mut doc = read_json(&renamed.join("project.json")).unwrap();
    doc["name"] = json!("My renamed cached song");
    doc["settings"]["masterVolume"] = json!(0.5);
    fs::write(
        renamed.join("project.json"),
        serde_json::to_vec(&doc).unwrap(),
    )
    .unwrap();
    let before = fs::read(renamed.join("project.json")).unwrap();
    let rows = cached(&f.cache()).unwrap();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0].id, "project");
    assert_eq!(rows[0].name, "My renamed cached song");
    assert_eq!(rows[0].song_path.as_ref(), Some(&renamed));
    let fresh = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(fresh, renamed);
    assert_eq!(fs::read(renamed.join("project.json")).unwrap(), before);
    assert_eq!(
        crate::integration::read_project(&renamed).unwrap().name,
        "My renamed cached song"
    );
    assert!(fresh.join("stems/vocals.wav").is_file());
    assert!(!original.exists());
}

#[test]
fn changed_remote_document_offers_download_without_losing_saved_local_edits() {
    let f = Fixture::new();
    let mut r = stem_only();
    let first = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let mut local = read_json(&first.join("project.json")).unwrap();
    local["name"] = json!("Saved local edit");
    fs::write(
        first.join("project.json"),
        serde_json::to_vec(&local).unwrap(),
    )
    .unwrap();
    assert_eq!(
        list_with(&r, &f.cache(), &|| false).unwrap()[0]
            .song_path
            .as_ref(),
        Some(&first),
        "unchanged cloud document must allow Open of local edits"
    );
    let mut cloud: Value = serde_json::from_slice(&r.bytes["doc"]).unwrap();
    cloud["name"] = json!("Updated cloud project");
    let cloud = serde_json::to_vec(&cloud).unwrap();
    r.bytes.insert("doc".into(), cloud.clone());
    r.children.get_mut("project").unwrap()[0] = file("doc", "project.json", "project", &cloud);
    assert!(
        list_with(&r, &f.cache(), &|| false).unwrap()[0]
            .song_path
            .is_none(),
        "changed MD5/size must offer Download"
    );
    assert_eq!(
        cached(&f.cache()).unwrap()[0].song_path.as_ref(),
        Some(&first),
        "previous local edit remains available offline"
    );
    let updated = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(first, updated);
    assert_eq!(
        list_with(&r, &f.cache(), &|| false).unwrap()[0]
            .song_path
            .as_ref(),
        Some(&updated)
    );
    assert_eq!(
        cached(&f.cache()).unwrap()[0].song_path.as_ref(),
        Some(&updated)
    );
    assert_eq!(
        read_json(&first.join("project.json")).unwrap()["name"],
        "Saved local edit"
    );
    r.bytes.insert("reissued-doc".into(), cloud.clone());
    r.children.get_mut("project").unwrap()[0] =
        file("reissued-doc", "project.json", "project", &cloud);
    assert!(
        list_with(&r, &f.cache(), &|| false).unwrap()[0]
            .song_path
            .is_none(),
        "a changed remote file identity must offer Download even with identical bytes"
    );
}

#[test]
fn publication_advances_beyond_tied_future_receipts_and_opens_the_new_copy() {
    let f = Fixture::new();
    let r = stem_only();
    let first = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    let duplicate = f.cache().join("Duplicated cached revision");
    create_private(&duplicate).unwrap();
    create_private(&duplicate.join("stems")).unwrap();
    let mut original = receipt(&first).unwrap();
    original.created_ms = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_millis() as u64
        + 3_600_000;
    for member in &original.files {
        fs::copy(first.join(&member.path), duplicate.join(&member.path)).unwrap();
    }
    let marker = serde_json::to_vec(&original).unwrap();
    fs::write(first.join(MARKER), &marker).unwrap();
    fs::write(duplicate.join(MARKER), &marker).unwrap();
    let published = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert_ne!(published, first);
    assert_ne!(published, duplicate);
    assert!(
        receipt(&published).unwrap().created_ms > original.created_ms,
        "logical publication order must advance past a clock rollback and tie"
    );
    assert_eq!(
        cached(&f.cache()).unwrap()[0].song_path.as_ref(),
        Some(&published)
    );
    assert_eq!(
        list_with(&r, &f.cache(), &|| false).unwrap()[0]
            .song_path
            .as_ref(),
        Some(&published)
    );
    assert!(first.join("project.json").is_file() && duplicate.join("project.json").is_file());
}

#[test]
fn cache_publication_lease_excludes_competing_publishers_and_retry_resumes() {
    let f = Fixture::new();
    let r = stem_only();
    create_private(&f.cache()).unwrap();
    let held = cache_lease(&f.cache().join(".publish.lock")).unwrap();
    let error = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap_err();
    assert!(error.to_string().contains("publication"));
    assert!(cached(&f.cache()).unwrap().is_empty());
    drop(held);
    let published = download_with(&r, "project", &f.cache(), &|| false, &|_, _| {}).unwrap();
    assert!(published.join("stems/vocals.wav").is_file());
    for id in ["doc", "vocals"] {
        assert_eq!(
            r.calls
                .lock()
                .unwrap()
                .iter()
                .filter(|c| c.as_str() == format!("GET {id}"))
                .count(),
            1,
            "verified payload must survive a competing publication"
        );
    }
}

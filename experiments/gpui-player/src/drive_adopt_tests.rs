//! Filesystem policy fixtures plus the actual native REST client on loopback.
use super::*;
use md5::{Digest, Md5};
use std::{
    collections::BTreeMap,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
};
#[derive(Clone, Debug, PartialEq)]
enum Call {
    List(String),
    Get(String),
    Patch(String, Value),
}
#[derive(Default)]
struct State {
    children: HashMap<String, Vec<RemoteEntry>>,
    bytes: HashMap<String, Vec<u8>>,
    calls: Vec<Call>,
    network_fail: HashMap<String, usize>,
    corrupt: HashMap<String, usize>,
    deny: HashSet<String>,
    tag_fail: usize,
    held_download: Option<(String, std::sync::mpsc::Receiver<()>)>,
}
#[derive(Default)]
struct Fake(Mutex<State>);
impl Ops for Fake {
    fn children(&self, parent: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        check(cancel)?;
        let mut s = self.0.lock().unwrap();
        s.calls.push(Call::List(parent.into()));
        Ok(s.children.get(parent).cloned().unwrap_or_default())
    }
    fn patch(&self, id: &str, value: &Value, cancel: &impl Fn() -> bool) -> Result<()> {
        check(cancel)?;
        let mut s = self.0.lock().unwrap();
        s.calls.push(Call::Patch(id.into(), value.clone()));
        if value["appProperties"]["singzState"] == "adopted" && s.tag_fail > 0 {
            s.tag_fail -= 1;
            bail!("Drive API 503");
        }
        Ok(())
    }
    fn download(
        &self,
        id: &str,
        path: &Path,
        limit: u64,
        cancel: &impl Fn() -> bool,
        progress: &impl Fn(u64),
    ) -> Result<u64> {
        check(cancel)?;
        let mut s = self.0.lock().unwrap();
        s.calls.push(Call::Get(id.into()));
        if s.deny.contains(id) {
            return Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied).into());
        }
        if s.network_fail.get(id).copied().unwrap_or(0) > 0 {
            *s.network_fail.get_mut(id).unwrap() -= 1;
            fs::write(path, b"partial network bytes")?;
            bail!("Drive download HTTP 503");
        }
        let mut bytes = s.bytes.get(id).context("fixture file missing")?.clone();
        if s.corrupt.get(id).copied().unwrap_or(0) > 0 {
            *s.corrupt.get_mut(id).unwrap() -= 1;
            bytes.push(0);
        }
        ensure!(bytes.len() as u64 <= limit, "Drive response exceeds limit");
        let mut file = OpenOptions::new().write(true).create_new(true).open(path)?;
        file.write_all(&bytes)?;
        progress(bytes.len() as u64);
        Ok(bytes.len() as u64)
    }
}
fn hash(bytes: &[u8]) -> String {
    format!("{:x}", Md5::digest(bytes))
}
fn entry(name: &str, id: &str, bytes: &[u8]) -> RemoteEntry {
    RemoteEntry {
        id: id.into(),
        name: name.into(),
        mime_type: Some("application/octet-stream".into()),
        md5_checksum: Some(hash(bytes)),
        size: Some(bytes.len().to_string()),
        ..Default::default()
    }
}
fn published(name: &str, id: &str) -> RemoteEntry {
    let mut f = RemoteEntry {
        id: id.into(),
        name: name.into(),
        mime_type: Some(drive_plan::FOLDER_MIME.into()),
        ..Default::default()
    };
    f.app_properties.insert(
        drive_plan::PUBLISH_STATE_KEY.into(),
        drive_plan::STATE_PUBLISHED.into(),
    );
    f.app_properties
        .insert(drive_plan::PUBLISH_ID_KEY.into(), format!("publish-{id}"));
    f
}
fn install(fake: &Fake, name: &str, id: &str) -> (RemoteEntry, Vec<u8>) {
    let song = b"original song bytes";
    let vocal = b"encoded voice fixture";
    let lyrics = br#"{"source":"edited","lines":[]}"#;
    let doc=serde_json::to_vec(&json!({"version":2,"name":"Phone title","songFile":"original.wav","songHash":{"md5":hash(song),"size":song.len(),"mtimeMs":1700000000000u64},"stemHashes":{"vocals.flac":{"md5":hash(vocal),"size":vocal.len(),"mtimeMs":1700000000100u64}},"lyricsHash":{"md5":hash(lyrics),"size":lyrics.len()},"foreign":{"keep":[3,1,2]}})).unwrap();
    let stem_id = format!("stems-{id}");
    let children = vec![
        entry("project.json", &format!("doc-{id}"), &doc),
        entry("original.wav", &format!("song-{id}"), song),
        entry("lyrics.json", &format!("lyrics-{id}"), lyrics),
        entry(
            "notes — текст.txt",
            &format!("notes-{id}"),
            b"unknown preserved",
        ),
        RemoteEntry {
            id: stem_id.clone(),
            name: "stems".into(),
            mime_type: Some(drive_plan::FOLDER_MIME.into()),
            ..Default::default()
        },
    ];
    let stem = entry("vocals.flac", &format!("vocal-{id}"), vocal);
    let mut state = fake.0.lock().unwrap();
    state.children.insert(id.into(), children);
    state.children.insert(stem_id, vec![stem]);
    for (key, bytes) in [
        (format!("doc-{id}"), doc.clone()),
        (format!("song-{id}"), song.to_vec()),
        (format!("lyrics-{id}"), lyrics.to_vec()),
        (format!("notes-{id}"), b"unknown preserved".to_vec()),
        (format!("vocal-{id}"), vocal.to_vec()),
    ] {
        state.bytes.insert(key, bytes);
    }
    drop(state);
    (published(name, id), doc)
}
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static NEXT: AtomicU64 = AtomicU64::new(0);
        let root = std::env::temp_dir().join(format!(
            "singz-drive-adopt-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root).unwrap();
        Self(root.canonicalize().unwrap())
    }
    fn run(&self, fake: &Fake, top: &mut Vec<RemoteEntry>) -> Result<Adoption> {
        adopt_using(fake, &self.0, top, &|| false, &|_, _| {}, Duration::ZERO)
    }
    fn no_parts(&self) {
        fn walk(p: &Path) {
            for e in fs::read_dir(p).unwrap() {
                let e = e.unwrap();
                assert!(
                    !e.file_name()
                        .to_string_lossy()
                        .starts_with(".singz-download-")
                );
                if e.file_type().unwrap().is_dir() {
                    walk(&e.path());
                }
            }
        }
        walk(&self.0);
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[test]
fn complete_adoption_publishes_verified_bytes_before_tag_and_preserves_unknown_files() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, doc) = install(&fake, "Песня 🎤", "phone");
    let mut top = vec![phone];
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["Песня 🎤"]);
    assert!(result.warnings.is_empty());
    let dir = f.0.join("Песня 🎤");
    assert_eq!(fs::read(dir.join("project.json")).unwrap(), doc);
    assert_eq!(
        fs::read(dir.join("notes — текст.txt")).unwrap(),
        b"unknown preserved"
    );
    assert!(!dir.join(ADOPT_MARKER).exists());
    assert!(!dir.join("project.json.part").exists());
    assert_eq!(
        top[0].app_properties[drive_plan::PUBLISH_STATE_KEY],
        "adopted"
    );
    assert!(!f.0.join(stage_name("phone")).exists());
    let calls = &fake.0.lock().unwrap().calls;
    let gets: Vec<_> = calls
        .iter()
        .filter_map(|c| {
            if let Call::Get(id) = c {
                Some(id.as_str())
            } else {
                None
            }
        })
        .collect();
    assert_eq!(gets[0], "doc-phone");
    assert!(
        matches!(calls.last(),Some(Call::Patch(_,body))if body["appProperties"]["singzState"]=="adopted")
    );
    f.no_parts();
}
#[test]
fn only_published_folders_are_adopted_and_collision_is_renamed_remotely_first() {
    let f = Fixture::new();
    fs::create_dir(f.0.join("Song")).unwrap();
    fs::write(f.0.join("Song/sentinel"), b"local").unwrap();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "song", "phone");
    let mut ordinary = published("Ignored", "ignored");
    ordinary.app_properties.insert(
        drive_plan::PUBLISH_STATE_KEY.into(),
        drive_plan::STATE_ADOPTED.into(),
    );
    let mut top = vec![phone, ordinary];
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["song (phone)"]);
    assert_eq!(top[0].name, "song (phone)");
    assert_eq!(fs::read(f.0.join("Song/sentinel")).unwrap(), b"local");
    assert!(
        matches!(&fake.0.lock().unwrap().calls[0],Call::Patch(id,body)if id=="phone"&&body["name"]=="song (phone)")
    );
}
#[test]
fn listing_hash_mismatch_refuses_after_document_only_without_downloading_song() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0
        .lock()
        .unwrap()
        .children
        .get_mut("stems-phone")
        .unwrap()[0]
        .md5_checksum = Some("0".repeat(32));
    let mut top = vec![phone];
    let result = f.run(&fake, &mut top).unwrap();
    assert!(result.adopted.is_empty());
    assert_eq!(result.warnings.len(), 1);
    assert!(!f.0.join(stage_name("phone")).exists());
    assert_eq!(
        fake.0
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| matches!(c, Call::Get(_)))
            .count(),
        1
    );
    assert!(drive_plan::is_published(&top[0]));
}
#[test]
fn source_contract_requires_original_song_even_for_native_playable_stem_only() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0
        .lock()
        .unwrap()
        .children
        .get_mut("phone")
        .unwrap()
        .retain(|e| e.name != "original.wav");
    let result = f.run(&fake, &mut vec![phone]).unwrap();
    assert!(result.adopted.is_empty());
    assert!(result.warnings[0].contains("song file"));
}
#[test]
fn retry_integrity_failure_three_attempts_retains_verified_files_for_resume() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0
        .lock()
        .unwrap()
        .corrupt
        .insert("vocal-phone".into(), 3);
    let mut top = vec![phone];
    assert!(f.run(&fake, &mut top).is_err());
    let stage = f.0.join(stage_name("phone"));
    assert!(stage.join("project.json.part").exists());
    assert!(stage.join("original.wav").exists());
    assert!(!stage.join("project.json").exists());
    f.no_parts();
    let before = fake.0.lock().unwrap().calls.clone();
    assert_eq!(
        before
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="vocal-phone"))
            .count(),
        3
    );
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["Song"]);
    let calls = &fake.0.lock().unwrap().calls;
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="doc-phone"))
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="song-phone"))
            .count(),
        1
    );
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="vocal-phone"))
            .count(),
        4
    );
}
#[test]
fn network_failure_aborts_run_without_trashing_or_losing_verified_downloads() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0
        .lock()
        .unwrap()
        .network_fail
        .insert("vocal-phone".into(), 3);
    let mut top = vec![phone];
    assert!(f.run(&fake, &mut top).is_err());
    assert!(f.0.join(stage_name("phone")).join("original.wav").exists());
    assert!(drive_plan::is_published(&top[0]));
    assert!(
        !fake.0.lock().unwrap().calls.iter().any(
            |c| matches!(c,Call::Patch(_,body)if body["appProperties"]["singzState"]=="adopted")
        )
    );
    f.no_parts();
}
#[test]
fn cancellation_retains_verified_files_and_resume_reuses_them() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let mut top = vec![phone];
    let cancelled = AtomicBool::new(false);
    let result = adopt_using(
        &fake,
        &f.0,
        &mut top,
        &|| cancelled.load(Ordering::Acquire),
        &|message, _| {
            if message.starts_with("Verifying Song/original.wav") {
                cancelled.store(true, Ordering::Release);
            }
        },
        Duration::ZERO,
    );
    assert!(result.is_err());
    let stage = f.0.join(stage_name("phone"));
    assert!(stage.join("original.wav").exists());
    assert!(!f.0.join("Song").exists());
    f.no_parts();
    f.run(&fake, &mut top).unwrap();
    assert_eq!(
        fake.0
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="song-phone"))
            .count(),
        1
    );
}
#[test]
fn marker_recovers_tag_after_publish_failure_without_duplicate_or_download() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0.lock().unwrap().tag_fail = 1;
    let mut top = vec![phone];
    assert!(f.run(&fake, &mut top).is_err());
    assert!(f.0.join("Song/project.json").exists());
    assert!(f.0.join("Song").join(ADOPT_MARKER).exists());
    let gets = fake
        .0
        .lock()
        .unwrap()
        .calls
        .iter()
        .filter(|c| matches!(c, Call::Get(_)))
        .count();
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["Song"]);
    assert!(!f.0.join("Song (phone)").exists());
    assert!(!f.0.join("Song").join(ADOPT_MARKER).exists());
    assert_eq!(
        fake.0
            .lock()
            .unwrap()
            .calls
            .iter()
            .filter(|c| matches!(c, Call::Get(_)))
            .count(),
        gets
    );
}
#[test]
fn local_disk_failure_warns_and_continues_to_next_published_song() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (a, _) = install(&fake, "Bad", "a");
    let (b, _) = install(&fake, "Good", "b");
    fake.0.lock().unwrap().deny.insert("song-a".into());
    let mut top = vec![a, b];
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["Good"]);
    assert_eq!(result.warnings.len(), 1);
    assert!(drive_plan::is_published(&top[0]));
    assert!(!drive_plan::is_published(&top[1]));
    assert!(f.0.join(stage_name("a")).join("project.json.part").exists());
}
#[test]
fn destination_appearing_before_publish_is_never_overwritten() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let mut top = vec![phone];
    let result = adopt_using(
        &fake,
        &f.0,
        &mut top,
        &|| false,
        &|message, _| {
            if message.starts_with("Verifying Song/vocals.flac") {
                fs::create_dir(f.0.join("Song")).unwrap();
                fs::write(f.0.join("Song/sentinel"), b"foreign").unwrap();
            }
        },
        Duration::ZERO,
    )
    .unwrap();
    assert!(result.adopted.is_empty());
    assert_eq!(result.warnings.len(), 1);
    assert_eq!(fs::read(f.0.join("Song/sentinel")).unwrap(), b"foreign");
    assert!(f.0.join(stage_name("phone")).join("project.json").exists());
    assert!(drive_plan::is_published(&top[0]));
}
#[test]
fn unknown_obsolete_cache_files_are_cleaned_but_remote_unknown_payloads_are_kept() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let stage = f.0.join(stage_name("phone"));
    fs::create_dir_all(stage.join("stems")).unwrap();
    fs::write(stage.join("obsolete.part"), b"partial").unwrap();
    fs::write(stage.join("stems/removed.flac"), b"obsolete").unwrap();
    f.run(&fake, &mut vec![phone]).unwrap();
    assert!(!f.0.join("Song/obsolete.part").exists());
    assert!(!f.0.join("Song/stems/removed.flac").exists());
    assert!(f.0.join("Song/notes — текст.txt").exists());
}
#[test]
fn case_colliding_remote_files_are_refused_before_media_publication() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    fake.0
        .lock()
        .unwrap()
        .children
        .get_mut("phone")
        .unwrap()
        .push(entry("ORIGINAL.WAV", "other-song", b"other"));
    let result = f.run(&fake, &mut vec![phone]).unwrap();
    assert!(result.adopted.is_empty());
    assert!(result.warnings[0].contains("ambiguous"));
    assert!(!f.0.join("Song").exists());
}
#[cfg(unix)]
#[test]
fn staging_symlinks_are_removed_without_following_them() {
    use std::os::unix::fs::symlink;
    let f = Fixture::new();
    let outside = Fixture::new();
    fs::write(outside.0.join("sentinel"), b"outside").unwrap();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let stage = f.0.join(stage_name("phone"));
    fs::create_dir(&stage).unwrap();
    symlink(&outside.0, stage.join("stems")).unwrap();
    f.run(&fake, &mut vec![phone]).unwrap();
    assert_eq!(fs::read(outside.0.join("sentinel")).unwrap(), b"outside");
    assert_eq!(fs::read_dir(&outside.0).unwrap().count(), 1);
}
#[test]
fn source_hash_mtimes_are_restored_and_extreme_untrusted_time_does_not_panic() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    f.run(&fake, &mut vec![phone]).unwrap();
    let ms = fs::metadata(f.0.join("Song/stems/vocals.flac"))
        .unwrap()
        .modified()
        .unwrap()
        .duration_since(UNIX_EPOCH)
        .unwrap()
        .as_secs_f64()
        * 1000.;
    assert!((ms - 1700000000100.).abs() < 2.);
    let got = HashMap::from([(
        "lyrics.json".into(),
        Fingerprint {
            md5: "hash".into(),
            size: 1,
        },
    )]);
    stamp_mtimes(
        &f.0,
        &json!({"lyricsHash":{"md5":"hash","size":1,"mtimeMs":1e300}}),
        &got,
    );
}
struct HttpFixture {
    remote: Remote,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl HttpFixture {
    fn new(directory: &Path, library: &Path, state: Arc<Mutex<State>>) -> Self {
        use std::{
            io::{BufRead, BufReader},
            net::TcpListener,
        };
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let config=crate::drive_auth::Config::from_json(&json!({"clientId":"adoption-restored-fixture-client","authBase":base,"apiBase":base,"uploadBase":base}).to_string()).unwrap();
        let session_dir = directory.join("gdrive");
        fs::create_dir_all(&session_dir).unwrap();
        let mut session = OpenOptions::new();
        session.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            session.mode(0o600);
        }
        session.open(session_dir.join("session.json")).unwrap().write_all(&serde_json::to_vec(&json!({"generation":0,"tokens":{"access":"adoption-fixture-token","refresh":"adoption-fixture-refresh","expiresAt":4102444800000u64}})).unwrap()).unwrap();
        let store = crate::drive_auth::TokenStore::new(directory).unwrap();
        assert!(store.signed_in());
        let remote = Remote::new(crate::drive_auth::AuthClient::new(config, store));
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let library = library.to_owned();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(e) => panic!("fixture accept: {e}"),
                };
                // BSD/Darwin accepts inherit O_NONBLOCK from this listener;
                // socket timeouts alone do not make request reads blocking.
                stream.set_nonblocking(false).unwrap();
                stream
                    .set_read_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                stream
                    .set_write_timeout(Some(Duration::from_secs(5)))
                    .unwrap();
                let mut reader = BufReader::new(stream.try_clone().unwrap());
                let mut first = String::new();
                reader.read_line(&mut first).unwrap();
                let first: Vec<_> = first.split_whitespace().collect();
                assert!(first.len() >= 2);
                let method = first[0];
                let url = url::Url::parse(&format!("{base}{}", first[1])).unwrap();
                let mut headers = BTreeMap::new();
                loop {
                    let mut line = String::new();
                    assert!(reader.read_line(&mut line).unwrap() > 0);
                    if line == "\r\n" {
                        break;
                    }
                    let (key, value) = line.split_once(':').unwrap();
                    headers.insert(key.to_ascii_lowercase(), value.trim().to_owned());
                }
                assert_eq!(
                    headers.get("authorization").map(String::as_str),
                    Some("Bearer adoption-fixture-token")
                );
                if headers
                    .get("expect")
                    .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
                {
                    stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
                }
                let length = headers
                    .get("content-length")
                    .map_or(0, |n| n.parse::<usize>().unwrap());
                assert!(length <= 65536);
                let mut body = vec![0; length];
                reader.read_exact(&mut body).unwrap();
                let mut s = state.lock().unwrap();
                let bytes = if method == "GET"
                    && url
                        .query_pairs()
                        .any(|(key, value)| key == "alt" && value == "media")
                {
                    let id = url.path_segments().unwrap().next_back().unwrap().to_owned();
                    s.calls.push(Call::Get(id.clone()));
                    let mut bytes = s.bytes[&id].clone();
                    if s.corrupt.get(&id).copied().unwrap_or(0) > 0 {
                        *s.corrupt.get_mut(&id).unwrap() -= 1;
                        bytes.push(0);
                    }
                    bytes
                } else if method == "GET" {
                    let query = url
                        .query_pairs()
                        .find(|(key, _)| key == "q")
                        .unwrap()
                        .1
                        .into_owned();
                    let parent = query.split('\'').nth(1).unwrap().to_owned();
                    s.calls.push(Call::List(parent.clone()));
                    serde_json::to_vec(
                        &json!({"files":s.children.get(&parent).cloned().unwrap_or_default()}),
                    )
                    .unwrap()
                } else {
                    assert_eq!(method, "PATCH");
                    let value: Value = serde_json::from_slice(&body).unwrap();
                    let id = url.path_segments().unwrap().next_back().unwrap().to_owned();
                    if value["appProperties"]["singzState"] == "adopted" {
                        assert!(
                            library.join("Song/project.json").is_file(),
                            "adopted tag preceded local publication"
                        );
                        assert!(
                            library.join("Song").join(ADOPT_MARKER).is_file(),
                            "durable recovery marker missing before adopted tag"
                        );
                    }
                    s.calls.push(Call::Patch(id, value));
                    b"{}".to_vec()
                };
                let held = s
                    .held_download
                    .as_ref()
                    .is_some_and(|(id, _)| url.path().ends_with(&format!("/{id}")));
                let release = if held {
                    s.held_download.take().map(|(_, wait)| wait)
                } else {
                    None
                };
                drop(s);
                write!(stream,"HTTP/1.1 200 Fixture\r\nContent-Length: {}\r\nConnection: close\r\nContent-Type: application/json\r\n\r\n",bytes.len()).unwrap();
                if let Some(release) = release {
                    let split = bytes.len() / 2;
                    stream.write_all(&bytes[..split]).unwrap();
                    stream.flush().unwrap();
                    release
                        .recv_timeout(Duration::from_secs(3))
                        .expect("Adoption did not publish streaming progress before EOF");
                    let _ = stream.write_all(&bytes[split..]);
                } else {
                    let _ = stream.write_all(&bytes);
                }
            }
        });
        Self {
            remote,
            stop,
            worker: Some(worker),
        }
    }
}
impl Drop for HttpFixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let joined = worker.join();
            if !thread::panicking() {
                joined.expect("HTTP fixture failed");
            }
        }
    }
}
#[test]
fn authenticated_adoption_exposes_partial_bytes_before_verified_song_publication() {
    let f = Fixture::new();
    let library = f.0.join("library");
    let config = f.0.join("config");
    fs::create_dir(&library).unwrap();
    fs::create_dir(&config).unwrap();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let state = Arc::new(Mutex::new(std::mem::take(&mut *fake.0.lock().unwrap())));
    let (release, wait) = std::sync::mpsc::channel();
    let audio = vec![9; 131072];
    {
        let mut s = state.lock().unwrap();
        let mut doc: Value = serde_json::from_slice(&s.bytes["doc-phone"]).unwrap();
        doc["songHash"] = json!({"md5":hash(&audio),"size":audio.len(),"mtimeMs":1700000000000u64});
        let doc = serde_json::to_vec(&doc).unwrap();
        s.bytes.insert("song-phone".into(), audio.clone());
        s.bytes.insert("doc-phone".into(), doc.clone());
        for files in s.children.values_mut() {
            for file in files {
                let bytes = if file.id == "song-phone" {
                    Some(&audio)
                } else if file.id == "doc-phone" {
                    Some(&doc)
                } else {
                    None
                };
                if let Some(bytes) = bytes {
                    file.md5_checksum = Some(hash(bytes));
                    file.size = Some(bytes.len().to_string());
                }
            }
        }
        s.held_download = Some(("song-phone".into(), wait));
    }
    let http = HttpFixture::new(&config, &library, state.clone());
    let partial = std::cell::Cell::new(false);
    let messages = std::cell::RefCell::new(Vec::new());
    let result = adopt_using(
        &http.remote,
        &library,
        &mut vec![phone],
        &|| false,
        &|message, fraction| {
            if message.contains("original.wav") && message.contains("64 KB") && !partial.get() {
                assert!(
                    !library.join("Song").exists(),
                    "Transfer bytes published an unverified song"
                );
                assert!(fraction > 0.02 && fraction < 0.42);
                partial.set(true);
                release.send(()).unwrap();
            }
            messages.borrow_mut().push(message);
        },
        Duration::ZERO,
    )
    .unwrap();
    assert!(partial.get());
    assert_eq!(result.adopted, vec!["Song"]);
    assert_eq!(fs::read(library.join("Song/original.wav")).unwrap(), audio);
    assert!(messages.borrow().iter().any(|m| m.contains("128 KB")));
    assert!(state.lock().unwrap().calls.iter().any(|call|matches!(call,Call::Patch(_,value) if value["appProperties"]["singzState"]=="adopted")));
}
#[test]
fn genuine_restored_native_session_downloads_and_tags_over_real_http_after_integrity_retries() {
    let f = Fixture::new();
    let library = f.0.join("library");
    fs::create_dir(&library).unwrap();
    let config = f.0.join("config");
    fs::create_dir(&config).unwrap();
    let fake = Fake::default();
    let (phone, doc) = install(&fake, "Song", "phone");
    let state = Arc::new(Mutex::new(std::mem::take(&mut *fake.0.lock().unwrap())));
    state
        .lock()
        .unwrap()
        .corrupt
        .insert("vocal-phone".into(), 2);
    let http = HttpFixture::new(&config, &library, state.clone());
    let mut top = vec![phone];
    let result = adopt_using(
        &http.remote,
        &library,
        &mut top,
        &|| false,
        &|_, _| {},
        Duration::ZERO,
    )
    .unwrap();
    assert_eq!(result.adopted, ["Song"]);
    assert_eq!(fs::read(library.join("Song/project.json")).unwrap(), doc);
    assert!(!library.join("Song").join(ADOPT_MARKER).exists());
    assert!(!drive_plan::is_published(&top[0]));
    let calls = &state.lock().unwrap().calls;
    assert_eq!(
        calls
            .iter()
            .filter(|c| matches!(c,Call::Get(id)if id=="vocal-phone"))
            .count(),
        3
    );
    assert!(
        matches!(calls.last(),Some(Call::Patch(id,body))if id=="phone"&&body["appProperties"]["singzState"]=="adopted")
    );
}
#[test]
fn native_private_staging_markers_never_tag_unpublished_local_content_as_complete() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    let private = f.0.join(".singz-native-import-unfinished");
    fs::create_dir(&private).unwrap();
    fs::write(
        private.join(ADOPT_MARKER),
        serde_json::to_vec(&json!({"folderId":"phone"})).unwrap(),
    )
    .unwrap();
    fs::write(private.join("project.json"), b"incomplete source fixture").unwrap();
    let mut top = vec![phone];
    let result = f.run(&fake, &mut top).unwrap();
    assert_eq!(result.adopted, ["Song"]);
    assert!(private.join(ADOPT_MARKER).exists());
    assert!(f.0.join("Song/original.wav").exists());
}
#[test]
fn duplicated_marker_identity_is_kept_for_review_without_duplicate_adoption() {
    let f = Fixture::new();
    let fake = Fake::default();
    let (phone, _) = install(&fake, "Song", "phone");
    for name in ["One", "Two"] {
        fs::create_dir(f.0.join(name)).unwrap();
        fs::write(
            f.0.join(name).join(ADOPT_MARKER),
            serde_json::to_vec(&json!({"folderId":"phone"})).unwrap(),
        )
        .unwrap();
        fs::write(f.0.join(name).join("project.json"), b"fixture").unwrap();
    }
    let mut top = vec![phone];
    let result = f.run(&fake, &mut top).unwrap();
    assert!(result.adopted.is_empty());
    assert_eq!(result.warnings.len(), 1);
    assert!(fake.0.lock().unwrap().calls.is_empty());
    assert!(drive_plan::is_published(&top[0]));
}

#[test]
fn an_unlinked_folder_is_accepted_in_the_spelling_the_user_gave() {
    // Windows hands the app `C:\...` (and the app joins `gdrive/downloads` with a forward slash) while
    // canonicalize returns `\\?\C:\...`; refusing those spellings refused every Drive download into an ordinary folder.
    let base = std::env::temp_dir().join(format!("singz-canonical-{}", std::process::id()));
    fs::create_dir_all(base.join("gdrive").join("downloads")).unwrap();
    let spelled = if cfg!(windows) {
        let mixed = PathBuf::from(format!("{}/gdrive/downloads", base.display()));
        // The premise: the old `canonicalize()? == path` test compared these two and refused the folder.
        assert_ne!(mixed.canonicalize().unwrap(), mixed, "a plain, mixed-separator Windows spelling must differ from the canonical one");
        mixed
    } else {
        base.join("gdrive").join("downloads").canonicalize().unwrap()
    };
    let accepted = is_canonical(&spelled).unwrap() && Directory::capture(spelled.clone()).is_ok();
    fs::remove_dir_all(&base).unwrap();
    assert!(accepted, "an unlinked folder spelled {spelled:?} was refused");
}

#[cfg(unix)]
#[test]
fn a_symlinked_parent_is_refused_even_though_its_leaf_is_ordinary() {
    use std::os::unix::fs::symlink;
    let base = std::env::temp_dir().join(format!("singz-linked-parent-{}", std::process::id())).canonicalize().unwrap_or_else(|_| {
        let base = std::env::temp_dir().join(format!("singz-linked-parent-{}", std::process::id()));
        fs::create_dir_all(&base).unwrap();
        base.canonicalize().unwrap()
    });
    fs::create_dir_all(base.join("real").join("downloads")).unwrap();
    symlink(base.join("real"), base.join("alias")).unwrap();
    let through_link = base.join("alias").join("downloads");
    let direct = base.join("real").join("downloads");
    let refused = !is_canonical(&through_link).unwrap() && Directory::capture(through_link.clone()).is_err();
    let accepted = is_canonical(&direct).unwrap() && Directory::capture(direct.clone()).is_ok();
    fs::remove_dir_all(&base).unwrap();
    assert!(refused, "a path through a symlinked parent must be refused");
    assert!(accepted, "the same folder reached directly must be accepted");
}

#[cfg(windows)]
mod windows_links {
    use super::*;
    use std::process::Command;

    fn junction(link: &Path, target: &Path) {
        let status = Command::new("cmd").args(["/C", "mklink", "/J"]).arg(link).arg(target)
            .output().expect("cmd runs").status;
        assert!(status.success(), "mklink /J {link:?} {target:?} failed");
    }
    fn scratch(name: &str) -> PathBuf {
        let base = std::env::temp_dir().join(format!("singz-{name}-{}", std::process::id()));
        let _ = fs::remove_dir_all(&base);
        fs::create_dir_all(&base).unwrap();
        base
    }

    #[test]
    fn spelling_ignores_only_prefix_drive_case_separators_and_a_trailing_separator() {
        assert!(same_spelling(Path::new(r"\\?\C:\a\b"), Path::new("c:/a/b/")));
        assert!(same_spelling(Path::new(r"\\?\UNC\h\s\a"), Path::new(r"\\h\s\a")));
        assert!(!same_spelling(Path::new(r"\\?\C:\a\b"), Path::new(r"C:\a\c")));
        assert!(!same_spelling(Path::new(r"\\?\C:\songs\x"), Path::new(r"C:\Songs\x")), "a differing case is a different name, not a spelling");
        assert!(!same_spelling(Path::new(r"\\?\C:\a\b"), Path::new(r"C:\a\..\a\b")), "a dot component is refused, not resolved");
    }

    #[test]
    fn a_junctioned_parent_is_refused_and_the_real_folder_is_accepted() {
        let base = scratch("junction");
        fs::create_dir_all(base.join("real").join("downloads")).unwrap();
        junction(&base.join("alias"), &base.join("real"));
        assert!(is_link(&fs::symlink_metadata(base.join("alias")).unwrap()), "a junction is a link whatever its spelling");
        assert!(!is_link(&fs::symlink_metadata(base.join("real")).unwrap()));
        let through_link = base.join("alias").join("downloads");
        let direct = base.join("real").join("downloads");
        let refused = !is_canonical(&through_link).unwrap() && Directory::capture(through_link.clone()).is_err();
        let accepted = is_canonical(&direct).unwrap() && Directory::capture(direct.clone()).is_ok();
        let _ = Command::new("cmd").args(["/C", "rmdir"]).arg(base.join("alias")).output();
        fs::remove_dir_all(&base).unwrap();
        assert!(refused, "a path through a junctioned parent must be refused");
        assert!(accepted, "the same folder reached directly must be accepted");
    }

    /// The case-alias hole: in a case-sensitive directory `songs` is a real folder and `Songs` a junction to it, so
    /// `Songs\downloads` canonicalizes to `songs\downloads`, a spelling that differs only in case. A comparison that
    /// ignores case accepts it; the link walk refuses it. Skipped (loudly) where per-directory case sensitivity
    /// cannot be enabled (it needs the fsutil support and rights of the machine).
    #[test]
    fn a_case_alias_junction_in_a_case_sensitive_directory_is_refused() {
        let base = scratch("casealias");
        let enabled = Command::new("fsutil").args(["file", "setCaseSensitiveInfo"]).arg(&base).arg("enable")
            .output().map(|o| o.status.success()).unwrap_or(false);
        if !enabled {
            eprintln!("SKIPPED: per-directory case sensitivity could not be enabled on {base:?}");
            fs::remove_dir_all(&base).unwrap();
            return;
        }
        fs::create_dir_all(base.join("songs").join("downloads")).unwrap();
        junction(&base.join("Songs"), &base.join("songs"));
        let alias_leaf = base.join("Songs").join("downloads");
        let refused = !is_canonical(&alias_leaf).unwrap() && Directory::capture(alias_leaf.clone()).is_err();
        let real_leaf = base.join("songs").join("downloads");
        let accepted = Directory::capture(real_leaf.clone()).is_ok();
        let _ = Command::new("cmd").args(["/C", "rmdir"]).arg(base.join("Songs")).output();
        let _ = fs::remove_dir_all(&base);
        assert!(refused, "a junction that aliases an ordinary folder by case must be refused");
        assert!(accepted, "the real folder in the case-sensitive directory must still be accepted");
    }
}

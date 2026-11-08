//! Real native curl + OAuth mechanisms against an isolated loopback account.
//! These tests do not qualify live Google behavior or the desktop sign-in UX.
use super::*;
use crate::drive_auth::{Config, OAuthSession, TokenStore};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{BufRead, BufReader, Read, Write},
    net::{TcpListener, TcpStream},
    path::PathBuf,
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::Duration,
};

#[derive(Clone)]
struct Incoming {
    method: String,
    url: url::Url,
    headers: BTreeMap<String, String>,
    body: Vec<u8>,
}
impl Incoming {
    fn query(&self, name: &str) -> Option<String> {
        self.url
            .query_pairs()
            .find(|(key, _)| key == name)
            .map(|(_, value)| value.into_owned())
    }
}
struct Reply {
    status: u16,
    headers: Vec<(String, String)>,
    body: Vec<u8>,
}
impl Reply {
    fn json(value: Value) -> Self {
        Self {
            status: 200,
            headers: vec![("Content-Type".into(), "application/json".into())],
            body: serde_json::to_vec(&value).unwrap(),
        }
    }
    fn status(status: u16) -> Self {
        Self {
            status,
            ..Self::json(json!({}))
        }
    }
    fn location(location: String) -> Self {
        Self {
            headers: vec![("Location".into(), location)],
            ..Self::json(json!({}))
        }
    }
}
struct Fixture {
    directory: PathBuf,
    remote: Remote,
    received: Arc<Mutex<Vec<Incoming>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
fn incoming(stream: &mut TcpStream, base: &str) -> Incoming {
    // Darwin can inherit O_NONBLOCK from the accepting listener. Request
    // parsing is bounded by socket timeouts and must wait for actual bytes.
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
    let mut first = first.split_whitespace();
    let method = first.next().unwrap().to_owned();
    let path = first.next().unwrap();
    let url = url::Url::parse(&format!("{base}{path}")).unwrap();
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
    if headers
        .get("expect")
        .is_some_and(|v| v.eq_ignore_ascii_case("100-continue"))
    {
        stream.write_all(b"HTTP/1.1 100 Continue\r\n\r\n").unwrap();
    }
    assert!(
        !headers.contains_key("transfer-encoding"),
        "Regular fixture files must use bounded Content-Length"
    );
    let size = headers
        .get("content-length")
        .map_or(0, |v| v.parse::<usize>().unwrap());
    assert!(size <= 1024 * 1024);
    let mut body = vec![0u8; size];
    reader.read_exact(&mut body).unwrap();
    Incoming {
        method,
        url,
        headers,
        body,
    }
}
fn respond(stream: &mut TcpStream, reply: Reply) {
    write!(
        stream,
        "HTTP/1.1 {} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n",
        reply.status,
        reply.body.len()
    )
    .unwrap();
    for (key, value) in reply.headers {
        write!(stream, "{key}: {value}\r\n").unwrap();
    }
    stream.write_all(b"\r\n").unwrap();
    // A bounded download deliberately closes the pipe before its oversized
    // fixture response is complete.
    let _ = stream.write_all(&reply.body);
}
#[cfg(unix)]
fn secrets_are_not_in_process_arguments(access: &str, client_secret: &str) {
    let output = std::process::Command::new("/bin/ps")
        .args(["-axo", "command="])
        .output()
        .unwrap();
    assert!(output.status.success());
    let commands = String::from_utf8_lossy(&output.stdout);
    assert!(
        !commands.contains(access),
        "Bearer fixture appeared in process arguments"
    );
    assert!(
        !commands.contains(client_secret),
        "OAuth fixture secret appeared in process arguments"
    );
}
#[cfg(not(unix))]
fn secrets_are_not_in_process_arguments(_access: &str, _client_secret: &str) {}
impl Fixture {
    fn new(mut handle: impl FnMut(&Incoming, &str) -> Reply + Send + 'static) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "singz-drive-remote-test-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir(&directory).unwrap();
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let base = format!("http://{}", listener.local_addr().unwrap());
        let client_secret = format!("remote-secret-{}", crate::drive_http::random_id().unwrap());
        let access = format!("remote-access-{}", crate::drive_http::random_id().unwrap());
        let config=Config::from_json(&json!({"clientId":"remote-fixture-client","clientSecret":client_secret,"authBase":base,"apiBase":base,"uploadBase":base}).to_string()).unwrap();
        let received = Arc::new(Mutex::new(Vec::new()));
        let requests = received.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let stopped = stop.clone();
        let auth_proof = Arc::new(Mutex::new(None::<(String, String)>));
        let expected = auth_proof.clone();
        let worker = thread::spawn(move || {
            while !stopped.load(Ordering::Acquire) {
                let (mut stream, _) = match listener.accept() {
                    Ok(pair) => pair,
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2));
                        continue;
                    }
                    Err(error) => panic!("Fixture accept failed: {error}"),
                };
                let req = incoming(&mut stream, &base);
                secrets_are_not_in_process_arguments(&access, &client_secret);
                let reply = if req.url.path() == "/token" {
                    assert_eq!(req.method, "POST");
                    let fields = url::form_urlencoded::parse(&req.body)
                        .into_owned()
                        .collect::<BTreeMap<_, _>>();
                    assert_eq!(fields.get("client_secret"), Some(&client_secret));
                    assert_eq!(
                        fields.get("grant_type").map(String::as_str),
                        Some("authorization_code")
                    );
                    assert_eq!(
                        fields.get("code").map(String::as_str),
                        Some("remote-fixture-code")
                    );
                    let (redirect, challenge) = expected
                        .lock()
                        .unwrap()
                        .clone()
                        .expect("OAuth challenge not installed");
                    assert_eq!(fields["redirect_uri"], redirect);
                    assert_eq!(
                        URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes())),
                        challenge
                    );
                    Reply::json(
                        json!({"access_token":access,"refresh_token":"remote-fixture-refresh","expires_in":3600}),
                    )
                } else {
                    assert_eq!(
                        req.headers.get("authorization").map(String::as_str),
                        Some(format!("Bearer {access}").as_str())
                    );
                    handle(&req, &base)
                };
                requests.lock().unwrap().push(req);
                respond(&mut stream, reply);
            }
        });
        let store = TokenStore::new(&directory).unwrap();
        let session = OAuthSession::start(config.clone(), store.clone()).unwrap();
        let authorization = url::Url::parse(session.authorization_url()).unwrap();
        let pairs = authorization
            .query_pairs()
            .into_owned()
            .collect::<BTreeMap<_, _>>();
        let redirect = pairs["redirect_uri"].clone();
        *auth_proof.lock().unwrap() = Some((redirect.clone(), pairs["code_challenge"].clone()));
        let finish = thread::spawn(move || session.finish(&|| false));
        let redirect = url::Url::parse(&redirect).unwrap();
        let host = format!(
            "{}:{}",
            redirect.host_str().unwrap(),
            redirect.port().unwrap()
        );
        let mut callback = TcpStream::connect(&host).unwrap();
        callback
            .set_read_timeout(Some(Duration::from_secs(5)))
            .unwrap();
        let mut query = url::form_urlencoded::Serializer::new(String::new());
        query
            .append_pair("state", &pairs["state"])
            .append_pair("code", "remote-fixture-code");
        write!(
            callback,
            "GET {}?{} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
            redirect.path(),
            query.finish()
        )
        .unwrap();
        let mut answer = String::new();
        callback.read_to_string(&mut answer).unwrap();
        assert!(answer.starts_with("HTTP/1.1 200"));
        finish.join().unwrap().unwrap();
        assert!(store.signed_in());
        Self {
            directory,
            remote: Remote::new(AuthClient::new(config, store)),
            received,
            stop,
            worker: Some(worker),
        }
    }
    fn api_requests(&self) -> Vec<Incoming> {
        self.received
            .lock()
            .unwrap()
            .iter()
            .filter(|r| r.url.path() != "/token")
            .cloned()
            .collect()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
        let _ = fs::remove_dir_all(&self.directory);
    }
}
fn file(id: &str, parent: &str) -> Value {
    json!({"id":id,"name":format!("{id}.json"),"mimeType":"application/json","parents":[parent]})
}

#[test]
fn pagination_repeated_token_and_duplicate_id_use_real_authorized_rest() {
    let fixture = Fixture::new(|req, _| {
        assert_eq!(req.method, "GET");
        assert_eq!(req.query("pageSize").as_deref(), Some("1000"));
        let query = req.query("q").unwrap();
        match query.as_str() {
            "pages" if req.query("pageToken").is_none() => {
                Reply::json(json!({"files":[file("first","parent")],"nextPageToken":"next-page"}))
            }
            "pages" => {
                assert_eq!(req.query("pageToken").as_deref(), Some("next-page"));
                Reply::json(json!({"files":[file("second","parent")]}))
            }
            "repeat" => Reply::json(json!({"files":[],"nextPageToken":"same-page"})),
            "duplicate" => {
                Reply::json(json!({"files":[file("same","parent"),file("same","parent")]}))
            }
            _ => panic!("Unexpected listing query"),
        }
    });
    let files = fixture.remote.list("pages", &|| false).unwrap();
    assert_eq!(
        files.iter().map(|f| f.id.as_str()).collect::<Vec<_>>(),
        ["first", "second"]
    );
    assert!(
        fixture
            .remote
            .list("repeat", &|| false)
            .unwrap_err()
            .to_string()
            .contains("repeated")
    );
    assert!(
        fixture
            .remote
            .list("duplicate", &|| false)
            .unwrap_err()
            .to_string()
            .contains("duplicate")
    );
    assert_eq!(fixture.api_requests().len(), 5);
}
#[test]
fn parents_are_queried_in_fifty_item_batches_and_grouped_by_returned_parents() {
    let fixture = Fixture::new(|req, _| {
        let query = req.query("q").unwrap();
        let parents = query.split('\'').skip(1).step_by(2).collect::<Vec<_>>();
        assert!(!parents.is_empty() && parents.len() <= 50);
        let files = parents
            .iter()
            .map(|parent| file(&format!("child-{parent}"), parent))
            .collect::<Vec<_>>();
        Reply::json(json!({"files":files}))
    });
    let parents = (0..101).map(|i| format!("parent-{i}")).collect::<Vec<_>>();
    let grouped = fixture.remote.children_of(&parents, &|| false).unwrap();
    assert_eq!(grouped.len(), 101);
    for parent in &parents {
        assert_eq!(grouped[parent].len(), 1);
        assert_eq!(grouped[parent][0].id, format!("child-{parent}"));
    }
    let sizes = fixture
        .api_requests()
        .iter()
        .map(|req| req.query("q").unwrap().matches(" in parents").count())
        .collect::<Vec<_>>();
    assert_eq!(sizes, [50, 50, 1]);
}
#[test]
fn resumable_post_and_patch_stream_bytes_and_file_put_with_private_credentials() {
    let fixture = Fixture::new(|req, base| {
        if req.url.path().starts_with("/upload/drive/v3/files") {
            assert_eq!(req.query("uploadType").as_deref(), Some("resumable"));
            let metadata: Value = serde_json::from_slice(&req.body).unwrap();
            if req.method == "POST" {
                assert_eq!(
                    metadata,
                    json!({"name":"project.json","parents":["parent"]})
                );
                Reply::location(format!("{base}/upload-session/new"))
            } else {
                assert_eq!(req.method, "PATCH");
                assert!(req.url.path().ends_with("existing"));
                assert_eq!(metadata, json!({}));
                Reply::location(format!("{base}/upload-session/existing"))
            }
        } else {
            assert_eq!(req.method, "PUT");
            if req.url.path().ends_with("new") {
                assert_eq!(req.body, b"{\"version\":2}");
                assert_eq!(req.headers["content-type"], "application/json");
                Reply::json(json!({"id":"created"}))
            } else {
                assert_eq!(req.body, vec![71u8; 200000]);
                assert_eq!(req.headers["content-type"], "audio/wav");
                Reply::json(json!({"id":"existing"}))
            }
        }
    });
    assert_eq!(
        fixture
            .remote
            .upload_bytes(
                b"{\"version\":2}",
                "project.json",
                "parent",
                None,
                "application/json",
                &|| false
            )
            .unwrap(),
        "created"
    );
    let path = fixture.directory.join("voice.wav");
    fs::write(&path, vec![71u8; 200000]).unwrap();
    assert_eq!(
        fixture
            .remote
            .upload_file(
                &path,
                "voice.wav",
                "parent",
                Some("existing"),
                "audio/wav",
                &|| false
            )
            .unwrap(),
        "existing"
    );
    assert_eq!(
        fixture
            .api_requests()
            .iter()
            .map(|r| r.method.as_str())
            .collect::<Vec<_>>(),
        ["POST", "PUT", "PATCH", "PUT"]
    );
}
#[test]
fn unsafe_upload_session_origin_is_refused_before_sending_bearer_or_body() {
    let attacker = TcpListener::bind("127.0.0.1:0").unwrap();
    attacker.set_nonblocking(true).unwrap();
    let stolen = format!("http://{}/steal", attacker.local_addr().unwrap());
    let fixture = Fixture::new(move |req, _| {
        assert_eq!(req.method, "POST");
        Reply::location(stolen.clone())
    });
    let error = fixture
        .remote
        .upload_bytes(
            b"private-file-fixture",
            "project.json",
            "parent",
            None,
            "application/json",
            &|| false,
        )
        .unwrap_err();
    assert!(error.to_string().contains("outside configured endpoints"));
    assert_eq!(fixture.api_requests().len(), 1);
    assert!(matches!(attacker.accept(),Err(e)if e.kind()==std::io::ErrorKind::WouldBlock));
}
#[test]
fn downloads_stream_real_files_and_remove_http_error_or_overflow_partials() {
    let fixture = Fixture::new(|req, _| {
        assert_eq!(req.method, "GET");
        assert_eq!(req.query("alt").as_deref(), Some("media"));
        if req.url.path().ends_with("missing") {
            Reply::status(503)
        } else {
            Reply {
                status: 200,
                headers: vec![],
                body: vec![19u8; 131072],
            }
        }
    });
    let output = fixture.directory.join("download.wav");
    assert_eq!(
        fixture
            .remote
            .download("audio", &output, 200000, &|| false)
            .unwrap(),
        131072
    );
    assert_eq!(fs::read(output).unwrap(), vec![19u8; 131072]);
    let missing = fixture.directory.join("missing");
    assert!(
        fixture
            .remote
            .download("missing", &missing, 200000, &|| false)
            .is_err()
    );
    assert!(!missing.exists());
    let partial = fixture.directory.join("partial");
    assert!(
        fixture
            .remote
            .download("audio", &partial, 1024, &|| false)
            .is_err()
    );
    assert!(!partial.exists());
}
#[test]
fn folder_selection_excludes_published_and_refuses_ambiguous_duplicates() {
    let fixture = Fixture::new(|req, _| {
        if req.method == "POST" {
            let body: Value = serde_json::from_slice(&req.body).unwrap();
            assert_eq!(
                body,
                json!({"name":"PublishedOnly","mimeType":FOLDER,"parents":["parent"]})
            );
            return Reply::json(json!({"id":"new-private"}));
        }
        let query = req.query("q").unwrap();
        assert!(query.contains("'parent' in parents"));
        let published = |name: &str| json!({"id":"published","name":name,"mimeType":FOLDER,"appProperties":{"singzState":"published"}});
        if query.contains("name='SingZ'") {
            Reply::json(
                json!({"files":[published("SingZ"),{"id":"private","name":"SingZ","mimeType":FOLDER}]}),
            )
        } else if query.contains("name='PublishedOnly'") {
            Reply::json(json!({"files":[published("PublishedOnly")]}))
        } else {
            Reply::json(
                json!({"files":[{"id":"one","name":"Duplicate","mimeType":FOLDER},{"id":"two","name":"Duplicate","mimeType":FOLDER}]}),
            )
        }
    });
    assert_eq!(
        fixture
            .remote
            .folder("SingZ", Some("parent"), &|| false)
            .unwrap(),
        "private"
    );
    assert_eq!(
        fixture
            .remote
            .folder("PublishedOnly", Some("parent"), &|| false)
            .unwrap(),
        "new-private"
    );
    assert!(
        fixture
            .remote
            .folder("Duplicate", Some("parent"), &|| false)
            .unwrap_err()
            .to_string()
            .contains("duplicate folders")
    );
    assert_eq!(
        fixture
            .api_requests()
            .iter()
            .filter(|r| r.method == "POST")
            .count(),
        1
    );
}

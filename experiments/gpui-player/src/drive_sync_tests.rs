#![cfg(test)]

use crate::drive_auth::{AuthClient, Config, OAuthSession, TokenStore};
use crate::drive_remote::Remote;
use serde_json::{json, Value};
use std::collections::BTreeMap;
use std::fs;
use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// Owns the fixture server and temp dir from the moment the server spawns, so a
/// panic anywhere in setup still kills the process and removes the directory.
struct ServerGuard {
    child: Child,
    base: PathBuf,
}

impl Drop for ServerGuard {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
        let _ = fs::remove_dir_all(&self.base);
    }
}

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    _server: ServerGuard,
    remote: Remote,
    url: String,
}

impl Fixture {
    fn new(projects: usize) -> Self {
        let base = std::env::temp_dir().join(format!(
            "singz-drive-count-{}",
            crate::drive_http::random_id().unwrap()
        ));
        let root = base.join("library");
        fs::create_dir_all(&base).unwrap();
        build_library(&root, projects);
        let child = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py"))
            .arg(base.join("remote"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut server = ServerGuard { child, base: base.clone() };
        let mut line = String::new();
        BufReader::new(server.child.stdout.take().unwrap())
            .read_line(&mut line)
            .unwrap();
        let url = serde_json::from_str::<Value>(&line).unwrap()["base"]
            .as_str()
            .unwrap()
            .to_owned();
        let config = Config::from_json(&json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":url,"apiBase":url,"uploadBase":url}).to_string()).unwrap();
        let store = TokenStore::new(&base.join("preferences")).unwrap();
        let session = OAuthSession::start(config.clone(), store.clone()).unwrap();
        let response = crate::drive_http::request(
            crate::drive_http::Request {
                method: "GET",
                url: session.authorization_url(),
                headers: &[],
                body: crate::drive_http::Body::Empty,
                destination: crate::drive_http::Destination::Bytes(4096),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        let callback = response.header("location").unwrap().to_owned();
        let finish = std::thread::spawn(move || session.finish(&|| false));
        let response = crate::drive_http::request(
            crate::drive_http::Request {
                method: "GET",
                url: &callback,
                headers: &[],
                body: crate::drive_http::Body::Empty,
                destination: crate::drive_http::Destination::Bytes(4096),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(response.status, 200);
        finish.join().unwrap().unwrap();
        let remote = Remote::new(AuthClient::new(config, store));
        Self {
            base,
            root,
            _server: server,
            remote,
            url,
        }
    }

    fn state(&self) -> Value {
        let response = crate::drive_http::request(
            crate::drive_http::Request {
                method: "GET",
                url: &format!("{}/state", self.url),
                headers: &[],
                body: crate::drive_http::Body::Empty,
                destination: crate::drive_http::Destination::Bytes(16 * 1024 * 1024),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        response.json().unwrap()
    }

    fn control(&self, value: Value) {
        let bytes = serde_json::to_vec(&value).unwrap();
        let response = crate::drive_http::request(
            crate::drive_http::Request {
                method: "POST",
                url: &format!("{}/control", self.url),
                headers: &[("Content-Type", "application/json")],
                body: crate::drive_http::Body::Bytes(&bytes),
                destination: crate::drive_http::Destination::Bytes(4096),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(response.status, 200);
    }

    fn run_and_requests(&self) -> Vec<Value> {
        let before = self.state()["requests"].as_array().unwrap().len();
        crate::drive_sync::run(
            &self.remote,
            &self.root,
            &self.base.join("preferences/gdrive/spool"),
            &|| false,
            &|_, _| {},
            &|_| {},
        )
        .expect("drive sync run failed (setup or measured run), not a count mismatch");
        self.state()["requests"].as_array().unwrap()[before..].to_vec()
    }
}

fn build_library(root: &Path, projects: usize) {
    let wav =
        b"RIFF$\0\0\0WAVEfmt \x10\0\0\0\x01\0\x01\0@\x1f\0\0\x80>\0\0\x02\0\x10\0data\0\0\0\0";
    for index in 0..projects {
        let name = format!("Project-{index:03}");
        let dir = root.join(&name);
        fs::create_dir_all(dir.join("stems")).unwrap();
        fs::write(dir.join("original.wav"), wav).unwrap();
        let mut hashes = serde_json::Map::new();
        for stem in ["drums", "bass", "other", "vocals", "piano", "guitar"] {
            let file = format!("{stem}.wav");
            fs::write(dir.join("stems").join(&file), stem.as_bytes()).unwrap();
            hashes.insert(file, json!({}));
        }
        fs::write(dir.join("project.json"), serde_json::to_vec(&json!({
            "version": 2, "name": name, "songFile": "original.wav", "settings": {"custom": []}, "stemHashes": hashes
        })).unwrap()).unwrap();
        fs::write(dir.join("lyrics.json"), br#"{"lines":[]}"#).unwrap();
    }
}

fn grouped(requests: &[Value]) -> BTreeMap<String, usize> {
    let mut result = BTreeMap::new();
    for request in requests {
        let method = request["method"].as_str().unwrap();
        let path = request["path"]
            .as_str()
            .unwrap()
            .split('/')
            .map(|segment| {
                if segment.starts_with("file-") {
                    "{file-id}"
                } else if segment.starts_with("session-") {
                    "{session}"
                } else {
                    segment
                }
            })
            .collect::<Vec<_>>()
            .join("/");
        *result.entry(format!("{method} {path}")).or_insert(0) += 1;
    }
    result
}

fn measure(projects: usize, changed: bool) -> (usize, BTreeMap<String, usize>) {
    let fixture = Fixture::new(projects);
    fixture.run_and_requests();
    fixture.control(json!({"resetLedger": true}));
    if changed {
        fs::write(fixture.root.join("Project-000/project.json"), br#"{"version":2,"name":"changed","songFile":"original.wav","settings":{"custom":[]},"stemHashes":{}}"#).unwrap();
    }
    let requests = fixture.run_and_requests();
    (requests.len(), grouped(&requests))
}

fn kinds(entries: &[(&str, usize)]) -> BTreeMap<String, usize> {
    entries
        .iter()
        .map(|(key, value)| ((*key).into(), *value))
        .collect()
}

fn expected_clean(projects: usize) -> (usize, BTreeMap<String, usize>) {
    match projects {
        1 => (
            84,
            kinds(&[
                ("GET /drive/v3/about", 6),
                ("GET /drive/v3/files", 18),
                ("GET /drive/v3/files/{file-id}", 60),
            ]),
        ),
        10 => (
            750,
            kinds(&[
                ("GET /drive/v3/about", 42),
                ("GET /drive/v3/files", 126),
                ("GET /drive/v3/files/{file-id}", 582),
            ]),
        ),
        50 => (
            3710,
            kinds(&[
                ("GET /drive/v3/about", 202),
                ("GET /drive/v3/files", 606),
                ("GET /drive/v3/files/{file-id}", 2902),
            ]),
        ),
        51 => (
            3786,
            kinds(&[
                ("GET /drive/v3/about", 206),
                ("GET /drive/v3/files", 620),
                ("GET /drive/v3/files/{file-id}", 2960),
            ]),
        ),
        _ => panic!("unsupported project count"),
    }
}

fn expected_changed(projects: usize) -> (usize, BTreeMap<String, usize>) {
    match projects {
        1 => (
            162,
            kinds(&[
                ("GET /drive/v3/about", 7),
                ("GET /drive/v3/files", 37),
                ("GET /drive/v3/files/{file-id}", 114),
                ("PATCH /upload/drive/v3/files/{file-id}", 2),
                ("PUT /upload-session/{session}", 2),
            ]),
        ),
        10 => (
            830,
            kinds(&[
                ("GET /drive/v3/about", 43),
                ("GET /drive/v3/files", 145),
                ("GET /drive/v3/files/{file-id}", 636),
                ("PATCH /upload/drive/v3/files/{file-id}", 3),
                ("PUT /upload-session/{session}", 3),
            ]),
        ),
        50 => (
            3790,
            kinds(&[
                ("GET /drive/v3/about", 203),
                ("GET /drive/v3/files", 625),
                ("GET /drive/v3/files/{file-id}", 2956),
                ("PATCH /upload/drive/v3/files/{file-id}", 3),
                ("PUT /upload-session/{session}", 3),
            ]),
        ),
        51 => (
            3866,
            kinds(&[
                ("GET /drive/v3/about", 207),
                ("GET /drive/v3/files", 639),
                ("GET /drive/v3/files/{file-id}", 3014),
                ("PATCH /upload/drive/v3/files/{file-id}", 3),
                ("PUT /upload-session/{session}", 3),
            ]),
        ),
        _ => panic!("unsupported project count"),
    }
}

/// Collects every mismatch across the given project counts, so one failing P
/// does not hide the others, and prints the measured breakdown in the panic.
fn check(projects: &[usize], changed: bool) {
    let mut failures = Vec::new();
    for &p in projects {
        let (count, kinds) = measure(p, changed);
        let (expected_count, expected_kinds) =
            if changed { expected_changed(p) } else { expected_clean(p) };
        if count != expected_count || kinds != expected_kinds {
            failures.push(format!(
                "P={p} changed={changed}: measured {count} {kinds:?}, expected {expected_count} {expected_kinds:?}"
            ));
        }
    }
    assert!(failures.is_empty(), "Drive request counts moved:\n{}", failures.join("\n"));
}

#[test]
fn clean_second_sync_request_counts() {
    check(&[1, 10], false);
}

#[test]
fn one_changed_project_request_counts() {
    check(&[1, 10], true);
}

// P=50 and P=51 each run thousands of requests (over a minute apiece), which
// loads the parallel suite. They are the C-12 before/after baseline: run with
// `cargo test drive_sync_tests -- --ignored`.
#[test]
#[ignore = "slow: Drive request-count baseline for 50 and 51 projects; run with --ignored"]
fn large_library_request_counts() {
    check(&[50, 51], false);
    check(&[50, 51], true);
}

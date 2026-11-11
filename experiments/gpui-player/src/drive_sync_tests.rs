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
        Self::with_server(projects, &Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py"))
    }

    fn with_server(projects: usize, script: &Path) -> Self {
        let base = std::env::temp_dir().join(format!(
            "singz-drive-count-{}",
            crate::drive_http::random_id().unwrap()
        ));
        fs::create_dir_all(&base).unwrap();
        let base = base.canonicalize().unwrap();
        let root = base.join("library");
        build_library(&root, projects);
        let child = Command::new("python3")
            .arg(script)
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

pub(crate) fn assert_electron_catalog_encoding(remote: &Remote, singz: &str, scratch: &Path) {
    use std::io::Write;
    let catalog = remote.children(singz, &|| false).unwrap().into_iter()
        .find(|entry| entry.name == "catalog.json").unwrap();
    let path = scratch.join("catalog-encoding.json");
    remote.download(&catalog.id, &path, 16 * 1024 * 1024, &|| false).unwrap();
    let bytes = fs::read(path).unwrap();
    let mut node = Command::new("node")
        .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/roundtrip/catalog-encoding.cjs"))
        .stdin(Stdio::piped()).stdout(Stdio::piped()).spawn().unwrap();
    node.stdin.take().unwrap().write_all(&bytes).unwrap();
    let output = node.wait_with_output().unwrap();
    assert!(output.status.success());
    assert_eq!(String::from_utf8(bytes).unwrap(), String::from_utf8(output.stdout).unwrap(),
        "native writer differs from Electron's encoding of the same catalog");
}

// Bundles the real Electron sync with esbuild, so it needs the repository's
// node_modules (`npm ci`). The gpui-native CI jobs and the VM runs don't install
// them; run it explicitly: `cargo test -- --ignored two_desktops_roundtrip`.
#[test]
#[ignore = "needs node_modules (npm ci); run with --ignored"]
fn two_desktops_roundtrip() {
    for first in ["electron", "native"] {
        let fixture = Fixture::with_server(2, &Path::new(env!("CARGO_MANIFEST_DIR"))
            .join("../../tests/roundtrip/two-desktops-drive.py"));
        let run = Command::new("node")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("../../tests/roundtrip/two-desktops.cjs"))
            .env("SINGZ_CROSS_BASE", &fixture.base)
            .env("SINGZ_CROSS_URL", &fixture.url)
            .env("SINGZ_CROSS_BINARY", std::env::current_exe().unwrap())
            .env("SINGZ_CROSS_FIRST", first)
            .env("SINGZ_MUTE", "1")
            .output().unwrap();
        assert!(run.status.success(), "{}\n{}", String::from_utf8_lossy(&run.stdout), String::from_utf8_lossy(&run.stderr));
    }
}

#[test]
#[ignore = "Node cross-writer runner invokes this one full sync in a separate native process"]
fn cross_writer_native_step() {
    let base = PathBuf::from(std::env::var_os("SINGZ_CROSS_BASE").unwrap());
    let config = Config::from_json(&std::env::var("SINGZ_GDRIVE_CONFIG").unwrap()).unwrap();
    let preferences = base.join("preferences");
    let store = TokenStore::new(&preferences).unwrap();
    let ledger = crate::sync_dirty::Store::new(preferences.clone());
    assert!(!ledger.snapshot().unwrap().is_dirty(), "native ledger must be clean");
    if std::env::var_os("SINGZ_CROSS_NATIVE_EDIT").is_some() {
        let project = base.join("library/Project-000");
        let (mut doc, expected) = crate::project_store::read(&project, "project.json").unwrap();
        doc["settings"]["masterVolume"] = json!(0.625);
        crate::project_store::commit(&project, "project.json", &expected, &doc).unwrap();
        return;
    }
    if std::env::var_os("SINGZ_CROSS_NATIVE_EMPTY").is_some() {
        let project = base.join("library/Project-001");
        let (doc, expected) = crate::project_store::read(&project, "project.json").unwrap();
        crate::project_store::commit(&project, "project.json", &expected, &doc).unwrap();
        return;
    }
    let remote = Remote::new(AuthClient::new(config, store));
    // A native full sync follows the explicit-empty transaction's fresh-roster
    // continuation, as the production service does. Bound it to two passes.
    for pass in 0..2 {
        let report = crate::drive_sync::run(&remote, &base.join("library"),
            &preferences.join("gdrive/spool"), &|| false, &|_, _| {}, &|_| {}).unwrap();
        if report.follow_up { assert_eq!(pass, 0, "sync did not settle in two passes"); continue; }
        assert!(report.skipped.is_empty(), "skipped {:?}: {:?}", report.skipped, report.warnings);
        if std::env::var("SINGZ_CROSS_ASSERT_RETIRED").as_deref() == Ok("1") {
            let root = base.join("library");
            let config = crate::project_library::Config { home: base.clone(), default_root: root.clone(),
                preferences: preferences.join("library.json"), override_root: Some(root.clone()), one_drive: None };
            let library = crate::project_library::refresh(&config, &|| false).unwrap();
            let project = library.projects.iter().find(|item| item.dir == root.join("Project-001")).unwrap();
            assert_eq!(project.song_path, project.dir.join("project.json"), "native reopened the retired original");
        }
        return;
    }
    panic!("native full sync did not complete");
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
    measure_existing(&fixture, changed)
}

fn measure_existing(fixture: &Fixture, changed: bool) -> (usize, BTreeMap<String, usize>) {
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
    let lists = 2 + 2 * projects.div_ceil(50);
    (lists + 1, kinds(&[("GET /drive/v3/about", 1), ("GET /drive/v3/files", lists)]))
}

fn expected_changed(projects: usize) -> (usize, BTreeMap<String, usize>) {
    // Publication already writes the sorted Electron catalog; cleanup no
    // longer rereads and uploads it just to restore project ordering.
    let lists = 36 + 2 * (projects.div_ceil(50) - 1);
    let exact_gets = 114;
    let uploads = 2;
    (1 + lists + exact_gets + 2 * uploads, kinds(&[
        ("GET /drive/v3/about", 1), ("GET /drive/v3/files", lists),
        ("GET /drive/v3/files/{file-id}", exact_gets),
        ("PATCH /upload/drive/v3/files/{file-id}", uploads),
        ("PUT /upload-session/{session}", uploads),
    ]))
}

/// Collects every mismatch across the given project counts, so one failing P
/// does not hide the others, and prints the measured breakdown in the panic.
fn check(projects: &[usize], changed: bool) {
    let mut failures = Vec::new();
    for &p in projects {
        let (count, kinds) = measure(p, changed);
        eprintln!("P={p} changed={changed}: {count} {kinds:?}");
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

// The first publication of P=50 and P=51 still runs thousands of requests.
// Keep those setup-heavy boundary cases opt-in: run with
// `cargo test drive_sync_tests -- --ignored`.
#[test]
#[ignore = "slow: Drive request-count baseline for 50 and 51 projects; run with --ignored"]
fn large_library_request_counts() {
    let mut failures = Vec::new();
    for p in [50, 51] {
        let f = Fixture::new(p);
        f.run_and_requests();
        for changed in [false, true] {
            let measured = measure_existing(&f, changed);
            let expected = if changed { expected_changed(p) } else { expected_clean(p) };
            eprintln!("P={p} changed={changed}: {measured:?}");
            if measured != expected { failures.push(format!("P={p} changed={changed}: {measured:?}, expected {expected:?}")); }
            if !changed {
                let cache = f.base.join("preferences/gdrive/catalog-cache");
                if cache.exists() { fs::remove_dir_all(cache).unwrap(); }
                let cold = measure_existing(&f, false);
                let (count, mut breakdown) = expected_clean(p);
                breakdown.insert("GET /drive/v3/files/{file-id}".into(), 1);
                let expected_cold = (count + 1, breakdown);
                eprintln!("P={p} cold catalog: {cold:?}");
                if cold != expected_cold { failures.push(format!("P={p} cold: {cold:?}, expected {expected_cold:?}")); }
            }
        }
    }
    assert!(failures.is_empty(), "Drive request counts moved:\n{}", failures.join("\n"));
}

fn assert_quiet(f: &Fixture) {
    let requests = f.run_and_requests();
    assert_eq!((requests.len(), grouped(&requests)), expected_clean(1));
    assert!(requests.iter().all(|r| r["method"] == "GET"));
}

#[test]
fn quiet_final_state_and_report_golden() {
    let f = Fixture::new(1);
    f.run_and_requests();
    let before = f.state()["files"].clone();
    let report = crate::drive_sync::run(&f.remote, &f.root,
        &f.base.join("preferences/gdrive/spool"), &|| false, &|_, _| {}, &|_| {}).unwrap();
    assert_eq!(f.state()["files"], before);
    assert_eq!((report.projects, report.uploaded, report.unchanged, report.trashed), (1, 0, 0, 0));
    assert!(!report.follow_up && report.warnings.is_empty() && report.skipped.is_empty() && report.adopted.is_empty());
    assert_eq!(report.synced.len(), 1);
    assert_eq!(report.synced[&f.root.join("Project-000")],
        crate::project_store::fingerprint(&fs::read(f.root.join("Project-000/project.json")).unwrap()));
    assert_quiet(&f);
}

#[derive(Clone, Copy, Debug)]
enum Tamper { Md5, Trashed, ForeignTop, ForeignStem, FolderId, CatalogRow, CatalogId,
    Cache, Retirement, Rename, Token }

fn tamper(case: Tamper) {
    use base64::Engine;
    let f = Fixture::new(1);
    f.run_and_requests();
    // Check the budget after the semantic assertions: on the old implementation
    // we exercise the very same tamper before rejecting its expensive prelude.
    let clean = f.run_and_requests();
    let rename_guard = std::cell::RefCell::new(None);
    let state = f.state();
    let files = state["files"].as_array().unwrap();
    let folder = files.iter().find(|r| r["name"] == "Project-000").unwrap();
    let stems = files.iter().find(|r| r["name"] == "stems").unwrap();
    let catalog = files.iter().find(|r| r["name"] == "catalog.json").unwrap();
    let mut changed = Vec::new();
    match case {
        Tamper::Md5 | Tamper::Trashed => {
            let mut member = files.iter().find(|r| r["name"] == "vocals.wav").unwrap().clone();
            if matches!(case, Tamper::Md5) { member["contentBase64"] = json!("Y2hhbmdlZA=="); }
            else { member["trashed"] = json!(true); }
            changed.push(member);
        }
        Tamper::ForeignTop | Tamper::ForeignStem => changed.push(json!({"id":"foreign",
            "name":"foreign.bin","parents":[if matches!(case,Tamper::ForeignTop) { &folder["id"] } else { &stems["id"] }],
            "contentBase64":"eA=="})),
        Tamper::FolderId => {
            let mut old = folder.clone(); old["trashed"] = json!(true); changed.push(old);
            let mut new = folder.clone(); new["id"] = json!("replacement-folder"); changed.push(new);
        }
        Tamper::CatalogRow | Tamper::CatalogId => {
            let mut new = catalog.clone();
            if matches!(case,Tamper::CatalogRow) {
                let bytes = base64::engine::general_purpose::STANDARD.decode(new["contentBase64"].as_str().unwrap()).unwrap();
                let mut doc: Value = serde_json::from_slice(&bytes).unwrap();
                doc["projects"][0]["files"][0]["md5Checksum"] = json!("00000000000000000000000000000000");
                new["contentBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&doc).unwrap()));
            } else {
                let mut old = catalog.clone(); old["trashed"] = json!(true); changed.push(old);
                new["id"] = json!("replacement-catalog");
            }
            changed.push(new);
        }
        Tamper::Cache => {
            let cache = f.base.join("preferences/gdrive/catalog-cache");
            fn corrupt(dir: &Path) {
                for entry in fs::read_dir(dir).unwrap() {
                    let path = entry.unwrap().path();
                    if path.is_dir() { corrupt(&path); } else { fs::write(path, b"corrupt").unwrap(); }
                }
            }
            if cache.exists() { corrupt(&cache); }
        }
        Tamper::Retirement => {
            // Finish a real retirement, then restore the exact local/remote
            // generation. Every quiet fact matches except its terminal guard.
            let ops = crate::drive_local_ops::Store::new(f.base.join("preferences"));
            let source = f.root.join("Project-000");
            let hidden = f.root.join(".deleted-project");
            let expected = crate::project_store::fingerprint(&fs::read(source.join("project.json")).unwrap());
            let binding = crate::drive_retirement::active_binding(
                &f.base.join("preferences/gdrive/retirements"), &f.root).unwrap().unwrap();
            let operation = ops.prepare(crate::drive_local_ops::Kind::Delete, &f.root,
                &source, &hidden, &expected, Some(binding)).unwrap();
            fs::rename(&source, &hidden).unwrap();
            operation.commit(&crate::sync_dirty::Store::new(f.base.join("preferences"))).unwrap();
            drop(operation);
            f.run_and_requests();
            fs::rename(&hidden, &source).unwrap();
            f.control(json!({"files": files}));
        }
        Tamper::Rename => {}
        Tamper::Token => {}
    }
    if !changed.is_empty() { f.control(json!({"files":changed})); }
    let preserved = f.state()["files"].clone();
    let before = f.state()["requests"].as_array().unwrap().len();
    let stop = std::cell::Cell::new(false);
    let result = crate::drive_sync::run(&f.remote, &f.root,
        &f.base.join("preferences/gdrive/spool"), &|| false,
        &|_, _| {
            if matches!(case,Tamper::Token) && !stop.replace(true) { f.remote.auth.store.sign_out().unwrap(); }
            if matches!(case,Tamper::Rename) && !stop.replace(true) {
                // Begin after the run's recovery/epoch snapshot, so admission
                // itself must notice the newly unfinished operation.
                let ops = crate::drive_local_ops::Store::new(f.base.join("preferences"));
                let source = f.root.join("Project-000");
                let expected = crate::project_store::fingerprint(&fs::read(source.join("project.json")).unwrap());
                *rename_guard.borrow_mut() = Some(ops.prepare(crate::drive_local_ops::Kind::Rename,
                    &f.root, &source, &f.root.join("Renamed"), &expected, None).unwrap());
            }
        }, &|_| {});
    let requests = f.state()["requests"].as_array().unwrap()[before..].to_vec();
    if matches!(case, Tamper::Rename) {
        assert!(result.as_ref().unwrap_err().to_string().contains("unfinished local retirement intent"), "{result:?}");
    }
    match case {
        Tamper::Retirement | Tamper::Rename | Tamper::Token | Tamper::CatalogRow => assert!(result.is_err(), "{case:?} unexpectedly published: {result:?}"),
        _ => {
            let report = result.unwrap();
            let expected = match case {
                Tamper::Md5 | Tamper::Trashed => (1, 7, 0, 0),
                Tamper::ForeignTop => (0, 0, 0, 1),
                Tamper::ForeignStem => (0, 8, 1, 0),
                Tamper::FolderId => (8, 0, 0, 0),
                _ => (0, 0, 0, 0),
            };
            assert_eq!((report.uploaded, report.unchanged, report.trashed, report.warnings.len()), expected, "{case:?}");
            assert!(!report.follow_up && report.skipped.is_empty());
            let after = f.state();
            if matches!(case, Tamper::ForeignTop) {
                assert!(after["files"].as_array().unwrap().iter().any(|r| r["id"] == "foreign" && r["trashed"] == false));
            }
            if matches!(case, Tamper::ForeignStem) {
                assert!(after["files"].as_array().unwrap().iter().any(|r| r["id"] == "foreign" && r["trashed"] == true));
            }
        }
    }
    if !matches!(case,Tamper::Retirement | Tamper::Rename | Tamper::Token) {
        assert!(requests.len() > 6, "{case:?} did not leave quiet path: {requests:?}");
    }
    if matches!(case, Tamper::Token | Tamper::CatalogRow | Tamper::Rename | Tamper::Retirement) {
        assert!(requests.iter().all(|r| r["method"] == "GET"), "{case:?} mutated Drive");
        assert_eq!(f.state()["files"], preserved, "{case:?} changed a preserved generation");
    }
    drop(rename_guard);
    assert_eq!((clean.len(), grouped(&clean)), expected_clean(1), "{case:?} clean precondition");
}

macro_rules! tamper_tests { ($($name:ident: $case:ident),* $(,)?) => { $(
    #[test] fn $name() { tamper(Tamper::$case); }
)* }; }
tamper_tests! {
    quiet_tamper_md5: Md5, quiet_tamper_trashed: Trashed,
    quiet_tamper_foreign_top: ForeignTop, quiet_tamper_foreign_stems: ForeignStem,
    quiet_tamper_folder_id: FolderId, quiet_tamper_catalog_row: CatalogRow,
    quiet_tamper_catalog_id: CatalogId, quiet_tamper_cache: Cache,
    quiet_tamper_retirement: Retirement, quiet_tamper_rename: Rename, quiet_tamper_token: Token,
}

#[test]
fn cold_catalog_cache_costs_one_download() {
    for p in [1, 10] {
        let f = Fixture::new(p);
        f.run_and_requests();
        let cache = f.base.join("preferences/gdrive/catalog-cache");
        if cache.exists() { fs::remove_dir_all(cache).unwrap(); }
        let requests = f.run_and_requests();
        let (count, mut breakdown) = expected_clean(p);
        breakdown.insert("GET /drive/v3/files/{file-id}".into(), 1);
        assert_eq!((requests.len(), grouped(&requests)), (count + 1, breakdown));
        assert!(requests.iter().all(|r| r["method"] == "GET"));
        let warm = f.run_and_requests();
        assert_eq!((warm.len(), grouped(&warm)), expected_clean(p));
    }
}

#[test]
fn quiet_legacy_mime_matches_recorded_metadata_not_inferred_mime() {
    let f = Fixture::new(1);
    let singz = f.remote.folder("SingZ", None, &|| false).unwrap();
    let project = f.remote.folder("Project-000", Some(&singz), &|| false).unwrap();
    let stems = f.remote.folder("stems", Some(&project), &|| false).unwrap();
    let spool = f.base.join("legacy-seed");
    fs::create_dir_all(&spool).unwrap();
    let mut capture = crate::drive_snapshot::capture_with_config(&f.root, "Project-000",
        &spool, &f.base.join("preferences"), &|| false).unwrap();
    let mut plan = crate::drive_plan::plan_project(&capture.snapshot,
        &crate::drive_plan::RemoteProject::default()).unwrap();
    capture.spool_uploads(&mut plan, &|| false).unwrap();
    for step in &plan.upload {
        let parent = if step.where_ == crate::drive_plan::Location::Top { &project } else { &stems };
        f.remote.upload_file(&step.path, &step.name, parent, None,
            "application/octet-stream", &|| false).unwrap();
    }
    drop(capture);
    f.run_and_requests();
    let before = f.state()["files"].clone();
    assert!(before.as_array().unwrap().iter().any(|f| f["name"] == "project.json"
        && f["mimeType"] == "application/octet-stream"));
    assert_quiet(&f);
    assert_eq!(f.state()["files"], before);
}

// V-01: exercise cleanup, concurrent catalog publication and full listing
// observations with quiet projects present, not merely a request total.
fn review_catalog(state: &Value) -> Value {
    use base64::Engine;
    let file = state["files"].as_array().unwrap().iter()
        .find(|f| f["name"] == "catalog.json" && f["trashed"] == false).unwrap();
    serde_json::from_slice(&base64::engine::general_purpose::STANDARD
        .decode(file["contentBase64"].as_str().unwrap()).unwrap()).unwrap()
}
fn review_replace_catalog(f: &Fixture, document: &Value) {
    use base64::Engine;
    let state = f.state();
    let mut file = state["files"].as_array().unwrap().iter()
        .find(|f| f["name"] == "catalog.json" && f["trashed"] == false).unwrap().clone();
    file["contentBase64"] = json!(base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(document).unwrap()));
    f.control(json!({"files":[file]}));
}
fn review_run(f: &Fixture, progress: &dyn Fn(String, f32))
    -> (anyhow::Result<crate::drive_sync::Report>, Vec<Value>) {
    let start = f.state()["requests"].as_array().unwrap().len();
    let result = crate::drive_sync::run(&f.remote, &f.root,
        &f.base.join("preferences/gdrive/spool"), &|| false, &|message, value| progress(message, value), &|_| {});
    let requests = f.state()["requests"].as_array().unwrap()[start..].to_vec();
    (result, requests)
}
fn review_folder<'a>(state: &'a Value, name: &str) -> &'a Value {
    let files = state["files"].as_array().unwrap();
    let parent = if name == "SingZ" { json!("root") } else {
        files.iter().find(|f| f["name"] == "SingZ" && f["trashed"] == false).unwrap()["id"].clone()
    };
    files.iter().find(|f| f["name"] == name && f["parents"] == json!([parent])
        && f["mimeType"] == crate::drive_remote::FOLDER && f["trashed"] == false).unwrap()
}
fn review_roster(state: &Value, name: &str) -> BTreeMap<String, Value> {
    let folder = review_folder(state, name);
    let mut ids = vec![folder["id"].as_str().unwrap().to_owned()];
    let files = state["files"].as_array().unwrap();
    for f in files.iter().filter(|f| f["parents"] == json!([folder["id"]]) && f["trashed"] == false) {
        ids.push(f["id"].as_str().unwrap().to_owned());
        if f["name"] == "stems" {
            ids.extend(files.iter().filter(|child| child["parents"] == json!([f["id"]]) && child["trashed"] == false)
                .map(|child| child["id"].as_str().unwrap().to_owned()));
        }
    }
    files.iter().filter(|f| ids.contains(&f["id"].as_str().unwrap().to_owned()))
        .map(|f| (f["id"].as_str().unwrap().to_owned(), f.clone())).collect()
}
fn review_assert_quiet_project(before: &Value, after: &Value, requests: &[Value], name: &str) {
    let roster = review_roster(before, name);
    assert_eq!(review_roster(after, name), roster, "Quiet {name} remote generation changed");
    for id in roster.keys() {
        assert!(requests.iter().all(|r| r["path"] != format!("/drive/v3/files/{id}")),
            "Quiet {name} took an exact-ID protocol: {requests:?}");
    }
}
fn review_assert_catalog(state: &Value, names: &[&str]) {
    let doc = review_catalog(state);
    let rows = doc["projects"].as_array().unwrap();
    assert_eq!(rows.iter().map(|r| r["dir"].as_str().unwrap()).collect::<std::collections::BTreeSet<_>>(),
        names.iter().copied().collect());
    for row in rows {
        let folder = review_folder(state, row["dir"].as_str().unwrap());
        for entry in row["files"].as_array().unwrap() {
            let actual = state["files"].as_array().unwrap().iter().find(|f| f["id"] == entry["id"]).unwrap();
            assert_eq!(actual["trashed"], false);
            assert_eq!(actual["parents"], json!([folder["id"]]));
            assert_eq!(actual["name"], entry["name"]);
            assert_eq!(actual["md5Checksum"], entry["md5Checksum"]);
            assert_eq!(actual["size"], entry["size"]);
        }
    }
}

fn review_concurrent_catalog(when: &str) {
    let f = Fixture::new(3);
    f.run_and_requests();
    fs::remove_dir_all(f.root.join("Project-002")).unwrap();
    let before = f.state();
    let singz = review_folder(&before, "SingZ")["id"].clone();
    let injected = std::cell::Cell::new(false);
    let phone = json!({"dir":"Phone-new","files":[],"phoneOnly":{"keep":17}});
    let (result, requests) = review_run(&f, &|message, _| {
        if message == when && !injected.replace(true) {
            let mut document = review_catalog(&f.state());
            document["projects"].as_array_mut().unwrap().push(phone.clone());
            document["phoneTopLevel"] = json!({"keep":23});
            review_replace_catalog(&f, &document);
            f.control(json!({"files":[{"id":"phone-new","name":"Phone-new","mimeType":crate::drive_remote::FOLDER,
                "parents":[singz],"appProperties":{"singzState":"published"}}]}));
        }
    });
    assert!(injected.get());
    let report = result.unwrap();
    assert_eq!((report.projects, report.uploaded, report.trashed, report.synced.len()), (2, 0, 1, 2));
    let after = f.state();
    let document = review_catalog(&after);
    assert_eq!(document["projects"].as_array().unwrap().iter().find(|r| r["dir"] == "Phone-new"),
        Some(&phone), "Cleanup overwrote the concurrent phone row");
    assert_eq!(document["phoneTopLevel"], json!({"keep":23}));
    assert!(!document["projects"].as_array().unwrap().iter().any(|r| r["dir"] == "Project-002"));
    assert!(after["files"].as_array().unwrap().iter().any(|r| r["id"] == "phone-new" && r["trashed"] == false));
    for name in ["Project-000", "Project-001"] {
        review_assert_quiet_project(&before, &after, &requests, name);
    }
}
#[test]
fn review_cleanup_catalog_refresh_preserves_phone_row_from_project_loop() {
    review_concurrent_catalog("Syncing Project-000…");
}
#[test]
fn review_cleanup_catalog_refresh_preserves_phone_row_during_orphan_pass() {
    review_concurrent_catalog("Removing Project-002…");
}

#[test]
fn review_quiet_orphan_cleanup_keeps_published_folders_and_other_generations() {
    let f = Fixture::new(3);
    f.run_and_requests();
    fs::remove_dir_all(f.root.join("Project-002")).unwrap();
    let state = f.state();
    let root = review_folder(&state, "SingZ")["id"].clone();
    // An incomplete phone publication is retained, never adopted or treated as
    // ordinary writer-owned orphan deletion authority.
    f.control(json!({"files":[{"id":"published-keep","name":"Phone pending","mimeType":crate::drive_remote::FOLDER,
        "parents":[root],"appProperties":{"singzState":"published"}}]}));
    let before = f.state();
    let (result, requests) = review_run(&f, &|_, _| {});
    let report = result.unwrap();
    assert_eq!((report.projects, report.uploaded, report.trashed, report.synced.len()), (2, 0, 1, 2));
    assert!(report.adopted.is_empty());
    let after = f.state();
    let old = review_folder(&before, "Project-002");
    assert!(after["files"].as_array().unwrap().iter().any(|r| r["id"] == old["id"] && r["trashed"] == true));
    assert_eq!(after["files"].as_array().unwrap().iter().find(|r| r["id"] == "published-keep"),
        before["files"].as_array().unwrap().iter().find(|r| r["id"] == "published-keep"));
    for name in ["Project-000", "Project-001"] { review_assert_quiet_project(&before, &after, &requests, name); }
    review_assert_catalog(&after, &["Project-000", "Project-001"]);
}

#[test]
fn review_mixed_quiet_and_changed_projects_preserve_state_and_catalog_rows() {
    let f = Fixture::new(3);
    f.run_and_requests();
    let before = f.state();
    let path = f.root.join("Project-002/project.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["foreignMixEdit"] = json!(29);
    fs::write(&path, serde_json::to_vec(&doc).unwrap()).unwrap();
    let (result, requests) = review_run(&f, &|_, _| {});
    let report = result.unwrap();
    assert_eq!((report.projects, report.uploaded, report.unchanged, report.trashed, report.synced.len()), (3, 1, 7, 0, 3));
    let after = f.state();
    for name in ["Project-000", "Project-001"] {
        review_assert_quiet_project(&before, &after, &requests, name);
        assert_eq!(review_catalog(&before)["projects"].as_array().unwrap().iter().find(|r| r["dir"] == name),
            review_catalog(&after)["projects"].as_array().unwrap().iter().find(|r| r["dir"] == name));
    }
    let original = review_roster(&before, "Project-002");
    let actual = review_roster(&after, "Project-002");
    for (id, file) in original {
        if file["name"] == "project.json" { assert_ne!(actual[&id]["md5Checksum"], file["md5Checksum"]); }
        else { assert_eq!(actual[&id], file); }
    }
    review_assert_catalog(&after, &["Project-000", "Project-001", "Project-002"]);
}

#[test]
fn review_multi_page_listings_feed_complete_quiet_rosters() {
    let f = Fixture::new(3);
    f.run_and_requests();
    f.control(json!({"pageSize":2}));
    let before = f.state();
    let (result, requests) = review_run(&f, &|_, _| {});
    let report = result.unwrap();
    assert_eq!((report.projects, report.uploaded, report.trashed, report.synced.len()), (3, 0, 0, 3));
    assert_eq!(f.state()["files"], before["files"]);
    assert_eq!(grouped(&requests), kinds(&[("GET /drive/v3/about",1),("GET /drive/v3/files",17)]));
    assert!(requests.iter().any(|r| r["query"].get("pageToken").is_some()));
    review_assert_catalog(&f.state(), &["Project-000", "Project-001", "Project-002"]);
}

#[derive(Clone, Copy, Debug)]
enum ReviewRosterChange { StemsReplaced, StemsMoved, ProjectMoved, DuplicateProject, AppProperties }
fn review_roster_change(case: ReviewRosterChange) {
    let f = Fixture::new(2);
    f.run_and_requests();
    let state = f.state();
    let folder = review_folder(&state, "Project-001");
    let stems = state["files"].as_array().unwrap().iter().find(|r| r["name"] == "stems"
        && r["parents"] == json!([folder["id"]])).unwrap();
    let mut changed = vec![json!({"id":"outside","name":"Outside","mimeType":crate::drive_remote::FOLDER,"parents":["root"]})];
    match case {
        ReviewRosterChange::StemsReplaced => {
            let mut old = stems.clone(); old["trashed"] = json!(true); changed.push(old);
            let mut new = stems.clone(); new["id"] = json!("replacement-stems"); changed.push(new);
        }
        ReviewRosterChange::StemsMoved => { let mut old = stems.clone(); old["parents"] = json!(["outside"]); changed.push(old); }
        ReviewRosterChange::ProjectMoved => { let mut old = folder.clone(); old["parents"] = json!(["outside"]); changed.push(old); }
        ReviewRosterChange::DuplicateProject => { let mut new = folder.clone(); new["id"] = json!("duplicate-project"); changed.push(new); }
        ReviewRosterChange::AppProperties => {
            let mut member = state["files"].as_array().unwrap().iter().find(|r| r["name"] == "vocals.wav"
                && r["parents"] == json!([stems["id"]])).unwrap().clone();
            member["appProperties"]["anotherWriter"] = json!("changed"); changed.push(member);
        }
    }
    f.control(json!({"files":changed}));
    let preserved = f.state();
    let (result, requests) = review_run(&f, &|_, _| {});
    let after = f.state();
    if matches!(case, ReviewRosterChange::ProjectMoved) {
        let report = result.unwrap();
        assert_eq!(report.uploaded, 8);
        assert_ne!(review_folder(&after, "Project-001")["id"], folder["id"]);
        assert_eq!(after["files"].as_array().unwrap().iter().find(|r| r["id"] == folder["id"]),
            preserved["files"].as_array().unwrap().iter().find(|r| r["id"] == folder["id"]));
    } else if matches!(case, ReviewRosterChange::StemsReplaced | ReviewRosterChange::StemsMoved) {
        let report = result.unwrap();
        assert_eq!((report.uploaded, report.unchanged, report.trashed), (6, 2, 0));
        let active_stems = after["files"].as_array().unwrap().iter().find(|r| r["name"] == "stems"
            && r["parents"] == json!([folder["id"]]) && r["trashed"] == false).unwrap();
        assert_ne!(active_stems["id"], stems["id"]);
        for old in state["files"].as_array().unwrap().iter().filter(|r| r["parents"] == json!([stems["id"]])) {
            assert_eq!(after["files"].as_array().unwrap().iter().find(|r| r["id"] == old["id"]), Some(old));
            let repaired = after["files"].as_array().unwrap().iter().find(|r| r["parents"] == json!([active_stems["id"]]) && r["name"] == old["name"]).unwrap();
            assert_ne!(repaired["id"], old["id"]);
            assert_eq!(repaired["md5Checksum"], old["md5Checksum"]);
            assert_eq!(repaired["size"], old["size"]);
        }
        review_assert_catalog(&after, &["Project-000", "Project-001"]);
    } else {
        assert!(result.is_err(), "{case:?} unexpectedly accepted a quiet generation: {result:?}");
        assert_eq!(after["files"], preserved["files"], "{case:?} mutated the changed remote generation");
        assert!(requests.iter().all(|r| r["method"] == "GET"));
    }
    if !matches!(case, ReviewRosterChange::DuplicateProject) {
        assert!(requests.iter().any(|r| r["method"] == "GET" && r["path"].as_str().unwrap().starts_with("/drive/v3/files/file-")),
            "{case:?} did not take live exact-ID verification");
        review_assert_quiet_project(&preserved, &after, &requests, "Project-000");
    }
}
macro_rules! review_roster_tests { ($($name:ident:$case:ident),* $(,)?) => { $(
    #[test] fn $name() { review_roster_change(ReviewRosterChange::$case); }
)* }; }
review_roster_tests! {
    review_stems_folder_replacement_leaves_quiet:StemsReplaced,
    review_stems_folder_move_leaves_quiet:StemsMoved,
    review_project_folder_move_leaves_quiet:ProjectMoved,
    review_duplicate_project_folder_refuses_quiet:DuplicateProject,
    review_app_properties_only_change_leaves_quiet:AppProperties,
}

#[test]
fn review_remote_change_after_listing_waits_one_sync_then_repairs() {
    let f = Fixture::new(2);
    f.run_and_requests();
    let before = f.state();
    let folder = review_folder(&before, "Project-001");
    let stems = before["files"].as_array().unwrap().iter().find(|r| r["name"] == "stems"
        && r["parents"] == json!([folder["id"]])).unwrap();
    let member = before["files"].as_array().unwrap().iter().find(|r| r["name"] == "vocals.wav"
        && r["parents"] == json!([stems["id"]])).unwrap();
    let injected = std::cell::Cell::new(false);
    let (result, requests) = review_run(&f, &|message, _| {
        if message == "Syncing Project-000…" && !injected.replace(true) {
            let mut changed = member.clone(); changed["contentBase64"] = json!("Y2hhbmdlZA==");
            f.control(json!({"files":[changed]}));
        }
    });
    assert!(injected.get());
    assert_eq!(result.unwrap().uploaded, 0);
    assert_eq!((requests.len(), grouped(&requests)), expected_clean(2));
    let changed = f.state();
    assert_ne!(changed["files"].as_array().unwrap().iter().find(|r| r["id"] == member["id"]).unwrap()["md5Checksum"], member["md5Checksum"]);
    let (result, _) = review_run(&f, &|_, _| {});
    assert_eq!(result.unwrap().uploaded, 1);
    assert_eq!(f.state()["files"], before["files"]);
}

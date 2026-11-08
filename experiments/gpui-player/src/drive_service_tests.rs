use super::*;
use crate::drive_http::{self, Body, Destination, Request};
use serde_json::{json, Value};
use std::{
    io::{BufRead, BufReader},
    process::{Child, Command, Stdio},
    time::Instant,
};

struct Fixture {
    base: PathBuf,
    root: PathBuf,
    config: PathBuf,
    server: Child,
    url: String,
}
impl Fixture {
    fn new() -> Self {
        let base = std::env::temp_dir().join(format!(
            "singz-drive-service-{}",
            drive_http::random_id().unwrap()
        ));
        let root = base.join("library");
        let config = base.join("preferences");
        fs::create_dir_all(root.join("Song/stems")).unwrap();
        fs::write(
            root.join("Song/project.json"),
            br#"{"name":"Song","foreign":1,"settings":{}}"#,
        )
        .unwrap();
        fs::write(
            root.join("Song/stems/vocals.wav"),
            b"native sync fixture encoded bytes",
        )
        .unwrap();
        let mut server = Command::new("python3")
            .arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py"))
            .arg(base.join("remote"))
            .stdin(Stdio::null())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut line = String::new();
        BufReader::new(server.stdout.take().unwrap())
            .take(4096)
            .read_line(&mut line)
            .unwrap();
        let url = serde_json::from_str::<Value>(&line).unwrap()["base"]
            .as_str()
            .unwrap()
            .to_owned();
        Self {
            base,
            root,
            config,
            server,
            url,
        }
    }
    fn service(&self) -> Service {
        Service::with_config(self.config.clone(),self.root.clone(),Config::from_json(&json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":self.url,"apiBase":self.url,"uploadBase":self.url}).to_string()))
    }
    fn request(&self, method: &str, path: &str, body: Option<Value>) -> Value {
        let bytes = body.map(|v| serde_json::to_vec(&v).unwrap());
        let url = format!("{}{}", self.url, path);
        let response = drive_http::request(
            Request {
                method,
                url: &url,
                headers: &[("Content-Type", "application/json")],
                body: bytes.as_deref().map_or(Body::Empty, Body::Bytes),
                destination: Destination::Bytes(16 * 1024 * 1024),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(response.status, 200);
        response.json().unwrap()
    }
    fn state(&self) -> Value {
        self.request("GET", "/state", None)
    }
    fn control(&self, body: Value) {
        self.request("POST", "/control", Some(body));
    }
    fn login(&self, service: &Service) {
        wait(service, |s| s.configured);
        service.action(Action::SignIn).unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        let url = loop {
            if let Some(url) = service.drain().into_iter().find_map(|e| match e {
                Event::OpenUrl(_, url) => Some(url),
                _ => None,
            }) {
                break url;
            }
            assert!(
                Instant::now() < deadline,
                "OAuth URL not produced: {:?}",
                service.snapshot()
            );
            thread::sleep(Duration::from_millis(10));
        };
        let response = drive_http::request(
            Request {
                method: "GET",
                url: &url,
                headers: &[],
                body: Body::Empty,
                destination: Destination::Bytes(65536),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(response.status, 302);
        let location = response.header("location").unwrap();
        let callback = drive_http::request(
            Request {
                method: "GET",
                url: location,
                headers: &[],
                body: Body::Empty,
                destination: Destination::Bytes(65536),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
        assert_eq!(callback.status, 200);
        wait(service, |s| {
            s.signed_in
                && !s.signing_in
                && !s.busy
                && s.scheduler.last_sync.is_some()
                && s.scheduler.dirty == 0
        });
    }
    fn edit(&self, n: u64) {
        let path = self.root.join("Song/project.json");
        let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
        doc["foreign"] = json!(n);
        fs::write(path, serde_json::to_vec(&doc).unwrap()).unwrap();
        crate::sync_dirty::Store::new(self.config.clone())
            .mark_project(
                &self.root.canonicalize().unwrap().join("Song"),
                "fixture edit",
            )
            .unwrap();
    }
    fn remote_doc(&self) -> Value {
        use base64::Engine;
        let state = self.state();
        let bytes = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|f| f["name"] == "project.json")
            .unwrap()["contentBase64"]
            .as_str()
            .unwrap();
        serde_json::from_slice(
            &base64::engine::general_purpose::STANDARD
                .decode(bytes)
                .unwrap(),
        )
        .unwrap()
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        snapshot_conflicts().lock().unwrap().remove(&self.config);
        let _ = self.server.kill();
        let _ = self.server.wait();
        let _ = fs::remove_dir_all(&self.base);
    }
}
fn wait(service: &Service, predicate: impl Fn(&Snapshot) -> bool) {
    let deadline = Instant::now() + Duration::from_secs(12);
    loop {
        let s = service.snapshot();
        assert_eq!(
            s.busy,
            s.scheduler.phase == crate::sync_scheduler::Phase::Syncing,
            "Drive published a partial run transition: {s:?}"
        );
        if predicate(&s) {
            break;
        }
        assert!(Instant::now() < deadline, "Drive worker timeout: {s:?}");
        thread::sleep(Duration::from_millis(10));
    }
}
fn wait_gate(f: &Fixture) {
    wait_named_gate(f, "upload");
}
fn wait_named_gate(f: &Fixture, gate: &str) {
    let deadline = Instant::now() + Duration::from_secs(5);
    loop {
        if f.state()["gates"][gate]["waiting"].as_u64().unwrap_or(0) > 0 {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Native request did not reach fixture {gate} gate"
        );
        thread::sleep(Duration::from_millis(10));
    }
}

#[test]
fn unconfigured_drive_keeps_independent_storage_fences_alive() {
    let base = std::env::temp_dir().join(format!(
        "singz-drive-off-{}",
        drive_http::random_id().unwrap()
    ));
    let service = Service::with_config(
        base.join("preferences"),
        base.join("library"),
        Err(anyhow::anyhow!("not configured")),
    );
    service.suspend().unwrap();
    wait(&service, |s| s.suspended);
    service.set_root(base.join("other")).unwrap();
    wait(&service, |s| !s.suspended);
    let before_wake = service.snapshot();
    let epoch = service.epoch.load(Ordering::Acquire);
    service.notify_wake().unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert_eq!(service.snapshot(), before_wake);
    assert!(!service.snapshot().configured);
    assert!(!base.exists());
    drop(service);
}
#[test]
fn actual_oauth_worker_syncs_and_clean_repeat_publishes_no_payloads() {
    let f = Fixture::new();
    let service = f.service();
    f.edit(1);
    f.login(&service);
    assert_eq!(f.remote_doc()["foreign"], 1);
    assert!(!crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
    let first = f.state();
    assert_eq!(first["oauth"]["codeExchanges"], 1);
    let published = first["requests"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|r| r["method"] == "PUT")
        .count();
    assert!(published >= 3);
    f.control(json!({"resetLedger":true}));
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| s.busy);
    wait(&service, |s| {
        !s.busy && s.scheduler.last_sync.is_some() && s.error.is_none()
    });
    assert_eq!(
        f.state()["requests"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|r| r["method"] == "PUT")
            .count(),
        0,
        "Clean sync uploaded unchanged bytes"
    );
}
#[test]
fn signout_cancels_native_upload_and_cannot_clear_pending_save_marks() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(2);
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    service.action(Action::SignOut).unwrap();
    wait(&service, |s| {
        !s.signed_in && !s.busy && s.progress == "Signed out of Google Drive."
    });
    f.control(json!({"release":["upload"]}));
    assert!(crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
    assert_eq!(f.remote_doc()["foreign"], 1);
    assert!(!TokenStore::new(&f.config).unwrap().signed_in());
}
#[test]
fn real_edit_during_upload_keeps_intent_and_automatically_follows_up() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(2);
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    f.edit(3);
    f.control(json!({"release":["upload"]}));
    wait(&service, |s| {
        !s.busy && s.scheduler.phase == crate::sync_scheduler::Phase::Idle && s.scheduler.dirty == 0
    });
    assert_eq!(f.remote_doc()["foreign"], 3);
}
#[test]
fn switched_empty_library_never_trashes_existing_remote_projects() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    let empty = f.base.join("empty");
    fs::create_dir(&empty).unwrap();
    service.suspend().unwrap();
    wait(&service, |s| s.suspended);
    service.set_root(empty).unwrap();
    wait(&service, |s| !s.suspended);
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        !s.busy
            && s.error
                .as_ref()
                .is_some_and(|e| e.contains("library looks empty"))
    });
    assert!(f.state()["files"]
        .as_array()
        .unwrap()
        .iter()
        .filter(|f| f["name"] == "Song")
        .all(|f| f["trashed"] != true));
}

#[test]
fn restored_account_receipt_does_not_green_an_externally_changed_project() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    drop(service);
    let path = f.root.join("Song/project.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&path).unwrap()).unwrap();
    doc["foreign"] = json!(9);
    fs::write(path, serde_json::to_vec(&doc).unwrap()).unwrap();
    assert!(!crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
    let restarted = f.service();
    wait(&restarted, |s| {
        s.configured && s.signed_in && s.scheduler.dirty > 0
    });
    assert_ne!(
        restarted
            .snapshot()
            .projects
            .get(&f.root.canonicalize().unwrap().join("Song")),
        Some(&ProjectState::Synced)
    );
    assert!(crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
}
#[test]
fn acknowledged_suspend_never_starts_an_older_pending_sync() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    for _ in 0..6 {
        service.action(Action::SyncNow).unwrap();
        service.suspend().unwrap();
        wait(&service, |s| s.suspended && !s.busy);
        let count = f.state()["requests"].as_array().unwrap().len();
        thread::sleep(Duration::from_millis(60));
        assert_eq!(
            f.state()["requests"].as_array().unwrap().len(),
            count,
            "An older manual run started after suspension acknowledgement"
        );
        service.set_root(f.root.clone()).unwrap();
        wait(&service, |s| !s.suspended);
    }
}

#[test]
fn refresh_publishes_run_ownership_and_terminal_scheduler_atomically() {
    let f = Fixture::new();
    let store = TokenStore::new(&f.config).unwrap();
    let shared = Mutex::new(Snapshot::default());
    let running = AtomicBool::new(false);
    let mut scheduler = Scheduler::new();
    scheduler.start(100, true, Some(50));
    let run = scheduler.request_now(100).unwrap();
    let dirty = crate::sync_dirty::Snapshot::default();
    let receipt = Receipt::default();
    refresh_state(
        &shared, &scheduler, &store, &f.root, &dirty, &receipt, &running,
    );
    assert!(shared.lock().unwrap().busy);
    assert!(running.load(Ordering::Acquire));
    // Completion work may publish progress, but cannot release ownership before
    // the scheduler has installed its terminal receipt.
    publish(&shared, |s| s.progress = "Saving verified receipt".into());
    assert!(shared.lock().unwrap().busy);
    scheduler.finish(
        run.id,
        Outcome::Success {
            warnings: vec![],
            last_sync: Some(200),
        },
        200,
        0.5,
        false,
        0,
        0,
    );
    refresh_state(
        &shared, &scheduler, &store, &f.root, &dirty, &receipt, &running,
    );
    let terminal = shared.lock().unwrap();
    assert!(!terminal.busy);
    assert!(!running.load(Ordering::Acquire));
    assert_eq!(terminal.scheduler.phase, Phase::Idle);
    assert_eq!(terminal.scheduler.last_sync, Some(200));
}

#[test]
fn concurrent_save_and_exhausted_snapshot_reads_preserve_intent_and_command_recovery() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(2);
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    // A real durable writer publishes newer intent while the old captured
    // upload is in flight. Exhausted read retries must not acknowledge it.
    f.edit(3);
    let ledger = crate::sync_dirty::Store::new(f.config.clone());
    let captured = ledger.snapshot().unwrap();
    snapshot_conflicts()
        .lock()
        .unwrap()
        .insert(f.config.clone(), 10_000);
    f.control(json!({"release":["upload"]}));
    wait(&service, |s| {
        !s.busy
            && s.error
                .as_ref()
                .is_some_and(|e| e.contains("Sync intent changed while reading"))
    });
    let failed = service.snapshot();
    assert_eq!(failed.scheduler.phase, Phase::Retrying);
    assert_eq!(failed.scheduler.dirty, -1);
    assert_eq!(ledger.snapshot().unwrap(), captured);
    // Persistent read churn cannot kill the worker or starve storage fences.
    service.suspend().unwrap();
    wait(&service, |s| s.suspended && !s.busy);
    snapshot_conflicts().lock().unwrap().remove(&f.config);
    service.set_root(f.root.clone()).unwrap();
    wait(&service, |s| !s.suspended && s.scheduler.dirty > 0);
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| s.busy);
    wait(&service, |s| {
        !s.busy && s.scheduler.phase == Phase::Idle && s.error.is_none() && s.scheduler.dirty == 0
    });
    assert_eq!(f.remote_doc()["foreign"], 3);
    assert!(!ledger.snapshot().unwrap().is_dirty());
}

#[test]
fn malformed_intent_stays_blocked_until_explicit_repair_then_preserves_newer_edits() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(2);
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    let path = f.config.join("sync.json");
    let original = fs::read(&path).unwrap();
    fs::write(&path, b"{malformed fixture").unwrap();
    f.control(json!({"release":["upload"]}));
    wait(&service, |s| {
        !s.busy
            && s.error
                .as_ref()
                .is_some_and(|e| e.contains("Google Drive is unavailable"))
    });
    assert_eq!(fs::read(&path).unwrap(), b"{malformed fixture");
    assert_eq!(service.snapshot().scheduler.phase, Phase::Blocked);
    assert_eq!(service.snapshot().scheduler.dirty, -1);
    let requests = f.state()["requests"].as_array().unwrap().len();
    let revision = service.snapshot().revision;
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        s.revision > revision && s.error.is_some() && s.scheduler.phase == Phase::Blocked
    });
    assert_eq!(fs::read(&path).unwrap(), b"{malformed fixture");
    assert_eq!(f.state()["requests"].as_array().unwrap().len(), requests);
    assert!(service.snapshot().scheduler.run_at.is_none());
    let stable = service.snapshot().revision;
    let epoch = service.epoch.load(Ordering::Acquire);
    service.notify_wake().unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(service.snapshot().revision, stable);
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(service.snapshot().scheduler.run_at.is_none());
    assert_eq!(f.state()["requests"].as_array().unwrap().len(), requests);
    assert_eq!(fs::read(&path).unwrap(), b"{malformed fixture");
    // Hard failure must not strand storage fences or start background retries.
    service.suspend().unwrap();
    wait(&service, |s| s.suspended && !s.busy);
    service.set_root(f.root.clone()).unwrap();
    wait(&service, |s| !s.suspended);
    fs::write(&path, original).unwrap();
    f.edit(3);
    let ledger = crate::sync_dirty::Store::new(f.config.clone());
    let pending = ledger.snapshot().unwrap();
    assert!(pending.is_dirty());
    assert_eq!(f.state()["requests"].as_array().unwrap().len(), requests);
    let previous = service.snapshot().scheduler.last_sync;
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    f.edit(4);
    let newer = ledger.snapshot().unwrap();
    assert!(newer.seq > pending.seq);
    f.control(json!({"release":["upload"]}));
    wait(&service, |s| {
        !s.busy && s.scheduler.last_sync > previous && s.scheduler.dirty > 0
    });
    assert_eq!(f.remote_doc()["foreign"], 3);
    assert!(ledger.snapshot().unwrap().is_dirty());
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        !s.busy && s.error.is_none() && s.scheduler.phase == Phase::Idle && s.scheduler.dirty == 0
    });
    assert_eq!(f.remote_doc()["foreign"], 4);
    assert!(!ledger.snapshot().unwrap().is_dirty());
}

#[test]
fn startup_ledger_repair_rechecks_receipt_and_preserves_outside_intent() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    drop(service);
    let path = f.config.join("sync.json");
    let original = fs::read(&path).unwrap();
    fs::write(&path, b"{broken at startup").unwrap();
    let service = f.service();
    wait(&service, |s| s.error.is_some());
    assert_eq!(service.snapshot().scheduler.phase, Phase::Blocked);
    // A saved project changes while its ledger cannot accept marks. Repairing
    // the old clean ledger must not suppress receipt fingerprint verification.
    let project = f.root.join("Song/project.json");
    let mut doc: Value = serde_json::from_slice(&fs::read(&project).unwrap()).unwrap();
    doc["foreign"] = json!(9);
    fs::write(&project, serde_json::to_vec(&doc).unwrap()).unwrap();
    fs::write(&path, original).unwrap();
    let outside = f.base.join("other-library/Outside");
    fs::create_dir_all(&outside).unwrap();
    let outside = outside.canonicalize().unwrap();
    let ledger = crate::sync_dirty::Store::new(f.config.clone());
    ledger.mark_project(&outside, "outside edit").unwrap();
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        !s.busy && s.error.is_none() && s.scheduler.phase == Phase::Idle && s.scheduler.dirty == 1
    });
    assert_eq!(f.remote_doc()["foreign"], 9);
    let pending = ledger.snapshot().unwrap();
    assert_eq!(pending.dirs.len(), 1);
    assert!(pending
        .dirs
        .contains_key(&outside.to_string_lossy().to_string()));
}

#[test]
fn surrogate_graph_publishes_exact_http_bytes_and_invalid_replacement_stays_local() {
    use base64::Engine;
    use md5::{Digest, Md5};
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    let graph = include_bytes!("../../../tests/shared/graph-document-utf16.json");
    let graph_path = f.root.join("Song/graph.json");
    let project_path = f.root.join("Song/project.json");
    let update = |bytes: &[u8], edit| {
        fs::write(&graph_path, bytes).unwrap();
        let mut doc: Value = serde_json::from_slice(&fs::read(&project_path).unwrap()).unwrap();
        doc["graphHash"] = json!({"format":1,"md5":format!("{:x}",Md5::digest(bytes)),"size":bytes.len(),"mtimeMs":0});
        fs::write(&project_path, serde_json::to_vec(&doc).unwrap()).unwrap();
        f.edit(edit);
    };
    update(graph, 10);
    let original = fs::read(&project_path).unwrap();
    let previous = service.snapshot().scheduler.last_sync;
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        !s.busy && s.scheduler.last_sync > previous && s.scheduler.dirty == 0
    });
    let remote_graph = || {
        let state = f.state();
        let file = state["files"]
            .as_array()
            .unwrap()
            .iter()
            .find(|file| file["name"] == "graph.json" && file["trashed"] != true)
            .unwrap();
        base64::engine::general_purpose::STANDARD
            .decode(file["contentBase64"].as_str().unwrap())
            .unwrap()
    };
    assert_eq!(remote_graph(), graph);
    assert_eq!(fs::read(&project_path).unwrap(), original);
    let remote_project = f.remote_doc();
    assert_eq!(
        remote_project["graphHash"]["md5"],
        format!("{:x}", Md5::digest(graph))
    );
    assert_eq!(remote_project["graphHash"]["size"], graph.len());
    // The raw hash is valid, but this distinct endpoint is absent. Wire string
    // compatibility must not grant publication authority to an invalid graph.
    let invalid = String::from_utf8(graph.to_vec()).unwrap().replace(
        "\"from\": {\"node\": \"1\", \"port\": \"\\ud800\"}",
        "\"from\": {\"node\": \"1\", \"port\": \"\\ud801\"}",
    );
    assert_ne!(invalid.as_bytes(), graph);
    update(invalid.as_bytes(), 11);
    let previous = service.snapshot().scheduler.last_sync;
    service.action(Action::SyncNow).unwrap();
    let project = f.root.canonicalize().unwrap().join("Song");
    wait(&service, |s| {
        !s.busy
            && s.scheduler.last_sync > previous
            && s.projects.get(&project) == Some(&ProjectState::Blocked)
    });
    assert_eq!(remote_graph(), graph);
    assert_eq!(f.remote_doc(), remote_project);
    assert_eq!(fs::read(&graph_path).unwrap(), invalid.as_bytes());
    assert!(crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
}

#[test]
fn unsafe_ledger_keeps_cancel_and_signout_responsive_and_reauth_recovers() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(5);
    drop(service);
    let path = f.config.join("sync.json");
    let backup = f.config.join("sync-repair.json");
    fs::rename(&path, &backup).unwrap();
    fs::create_dir(&path).unwrap();
    let service = f.service();
    wait(&service, |s| s.error.is_some());
    assert_eq!(service.snapshot().scheduler.dirty, -1);
    assert!(path.is_dir());
    service.action(Action::Cancel).unwrap();
    wait(&service, |s| s.error.is_none() && !s.busy);
    service.action(Action::SignOut).unwrap();
    wait(&service, |s| !s.signed_in && s.error.is_none());
    assert!(path.is_dir());
    assert!(backup.is_file());
    fs::remove_dir(&path).unwrap();
    fs::rename(&backup, &path).unwrap();
    f.login(&service);
    assert_eq!(f.remote_doc()["foreign"], 5);
    assert!(!crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
}

#[test]
fn rejected_refresh_reports_sign_in_again_and_preserves_dirty_intent() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(7);
    let ledger = crate::sync_dirty::Store::new(f.config.clone());
    let pending = ledger.snapshot().unwrap();
    let previous_sync = service.snapshot().scheduler.last_sync;
    // The existing bearer is rejected by the real fixture API. Its native
    // refresh then receives invalid_grant/400; no token document is edited.
    f.control(json!({"resetAuth":true,"gates":{"token":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_named_gate(&f, "token");
    assert!(service.snapshot().busy);
    f.control(json!({"release":["token"]}));
    wait(&service, |s| {
        !s.busy
            && !s.signed_in
            && s.error
                .as_ref()
                .is_some_and(|e| e.contains("sign in again"))
    });
    let expired = service.snapshot();
    assert_ne!(expired.scheduler.phase, Phase::Idle);
    assert!(
        expired
            .scheduler
            .last_sync
            .is_none_or(|last| Some(last) == previous_sync),
        "Refresh rejection advanced the success receipt"
    );
    assert!(expired.projects.is_empty());
    assert!(!TokenStore::new(&f.config).unwrap().signed_in());
    assert_eq!(ledger.snapshot().unwrap(), pending);
    // A new explicit OAuth session recovers without losing the pending save.
    f.login(&service);
    assert_eq!(f.remote_doc()["foreign"], 7);
    assert!(!ledger.snapshot().unwrap().is_dirty());
}

#[test]
fn explicit_cancel_and_signout_suppress_late_refresh_rejection() {
    for action in [Action::Cancel, Action::SignOut] {
        let f = Fixture::new();
        let service = f.service();
        f.login(&service);
        f.edit(8);
        let ledger = crate::sync_dirty::Store::new(f.config.clone());
        let pending = ledger.snapshot().unwrap();
        f.control(json!({"resetAuth":true,"gates":{"token":true}}));
        service.action(Action::SyncNow).unwrap();
        wait_named_gate(&f, "token");
        service.action(action).unwrap();
        wait(&service, |s| {
            !s.busy
                && s.error.is_none()
                && match action {
                    Action::Cancel => s.progress.contains("Sync paused"),
                    Action::SignOut => !s.signed_in && s.progress == "Signed out of Google Drive.",
                    _ => unreachable!(),
                }
        });
        f.control(json!({"release":["token"]}));
        // The live command worker acknowledges a later fence, proving the old
        // request cannot publish its auth failure after the explicit action.
        service.suspend().unwrap();
        wait(&service, |s| s.suspended && !s.busy);
        assert!(service.snapshot().error.is_none());
        assert_eq!(ledger.snapshot().unwrap(), pending);
        assert_eq!(
            TokenStore::new(&f.config).unwrap().signed_in(),
            action == Action::Cancel
        );
    }
}

#[test]
fn wake_shortens_native_retry_without_invalidating_session_and_syncs_pending_edit() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(12);
    f.control(json!({"failNext":[{"method":"GET","path":"/drive/v3/files","status":503}]}));
    service.action(Action::SyncNow).unwrap();
    wait(&service, |s| {
        !s.busy && s.scheduler.phase == Phase::Retrying
    });
    let failed = service.snapshot();
    let old_deadline = failed.scheduler.run_at.unwrap();
    let epoch = service.epoch.load(Ordering::Acquire);
    let woke_at = now();
    assert!(old_deadline > woke_at + 2_000);
    service.notify_wake().unwrap();
    wait(&service, |s| {
        s.scheduler.phase == Phase::Pending
            && s.scheduler.run_at.is_some_and(|at| at < old_deadline)
    });
    let pending = service.snapshot();
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert_eq!(pending.scheduler.attempt, failed.scheduler.attempt);
    assert_eq!(pending.scheduler.last_error, failed.scheduler.last_error);
    assert!(pending.scheduler.run_at.unwrap() >= woke_at + 2_000);
    assert!(pending.scheduler.run_at.unwrap() <= now() + 2_000);
    wait(&service, |s| {
        !s.busy && s.scheduler.phase == Phase::Idle && s.scheduler.dirty == 0 && s.error.is_none()
    });
    assert_eq!(f.remote_doc()["foreign"], 12);
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(!crate::sync_dirty::Store::new(f.config.clone())
        .snapshot()
        .unwrap()
        .is_dirty());
}

#[test]
fn wake_during_active_native_upload_never_cancels_or_adds_follow_up() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    f.edit(13);
    f.control(json!({"gates":{"upload":true}}));
    service.action(Action::SyncNow).unwrap();
    wait_gate(&f);
    let epoch = service.epoch.load(Ordering::Acquire);
    let active = service.snapshot();
    assert!(active.busy);
    service.notify_wake().unwrap();
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(service.snapshot().busy);
    f.control(json!({"release":["upload"]}));
    wait(&service, |s| {
        !s.busy && s.scheduler.phase == Phase::Idle && s.scheduler.dirty == 0 && s.error.is_none()
    });
    assert_eq!(f.remote_doc()["foreign"], 13);
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(service.snapshot().scheduler.run_at.is_none());
}

#[test]
fn wake_keeps_native_worker_suspended_or_signed_out() {
    let f = Fixture::new();
    let service = f.service();
    f.login(&service);
    service.suspend().unwrap();
    wait(&service, |s| s.suspended && !s.busy);
    let epoch = service.epoch.load(Ordering::Acquire);
    let requests = f.state()["requests"].as_array().unwrap().len();
    service.notify_wake().unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(service.snapshot().suspended);
    assert!(service.snapshot().scheduler.run_at.is_none());
    assert_eq!(f.state()["requests"].as_array().unwrap().len(), requests);
    service.set_root(f.root.clone()).unwrap();
    wait(&service, |s| !s.suspended);
    service.action(Action::SignOut).unwrap();
    wait(&service, |s| {
        !s.signed_in && !s.suspended && !s.busy && s.progress == "Signed out of Google Drive."
    });
    let epoch = service.epoch.load(Ordering::Acquire);
    service.notify_wake().unwrap();
    thread::sleep(Duration::from_millis(100));
    assert_eq!(service.epoch.load(Ordering::Acquire), epoch);
    assert!(!service.snapshot().signed_in);
    assert!(service.snapshot().scheduler.run_at.is_none());
    assert_eq!(f.state()["requests"].as_array().unwrap().len(), requests);
}

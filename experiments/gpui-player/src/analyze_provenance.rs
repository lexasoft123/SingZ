//! Analyzer-only advisory provenance. Never waits on or refuses analysis.
use crate::diagnostics::{self, Level};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::VecDeque,
    fs::{self, File},
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::{
        Arc, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
const OUTPUT_LIMIT: usize = 16384;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EXECUTABLE: u64 = 512 * 1024 * 1024;
const MEMO_LIMIT: usize = 64;
static CHECKS: OnceLock<Option<Service>> = OnceLock::new();

struct Service {
    stopped: Arc<AtomicBool>,
    sender: SyncSender<PathBuf>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
}
impl Service {
    fn start() -> Option<Self> {
        let (sender, receiver) = mpsc::sync_channel::<PathBuf>(16);
        let stopped = Arc::new(AtomicBool::new(false));
        let cancel = stopped.clone();
        let worker = thread::Builder::new()
            .name("analyzer-provenance".into())
            .spawn(move || {
                let cancelled = || cancel.load(Ordering::Acquire);
                let mut memo = VecDeque::new();
                while !cancelled() {
                    let path = match receiver.recv_timeout(Duration::from_millis(20)) {
                        Ok(path) => path,
                        Err(mpsc::RecvTimeoutError::Timeout) => continue,
                        Err(mpsc::RecvTimeoutError::Disconnected) => break,
                    };
                    if cancelled() {
                        break;
                    }
                    if let Some(verdict) =
                        check_cancellable(&path, expected(), &mut memo, &cancelled)
                    {
                        if !cancelled() {
                            diagnostics::log(
                                "analyze",
                                &format!("[{}] {}", verdict.state, verdict.line),
                                verdict.level,
                            );
                        }
                    }
                }
            })
            .ok()?;
        Some(Self {
            stopped,
            sender,
            worker: Mutex::new(Some(worker)),
        })
    }
    fn enqueue(&self, path: PathBuf) {
        if !self.stopped.load(Ordering::Acquire) {
            let _ = self.sender.try_send(path);
        }
    }
    fn shutdown(&self) {
        self.stopped.store(true, Ordering::Release);
        if let Some(worker) = self.worker.lock().unwrap_or_else(|e| e.into_inner()).take() {
            // The active probe checks cancellation every 20ms, retires its owned
            // tree and joins its pipe readers before this worker can settle.
            let _ = worker.join();
        }
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.shutdown();
    }
}

/// Called by graceful desktop teardown before the diagnostic sink is drained.
/// Initializing an unused slot to None also prevents probes after shutdown.
pub(crate) fn shutdown() {
    if let Some(service) = CHECKS.get_or_init(|| None) {
        service.shutdown();
    }
}

pub(crate) fn resolve() -> Result<PathBuf> {
    let path = resolve_path(
        gated_env!("SINGZ_GPUI_ANALYZER").map(PathBuf::from),
        std::env::current_exe().context("Cannot locate native analyzer")?,
    );
    // The queue, hashing, probe and log belong to one background worker. A full
    // diagnostic queue cannot delay pitch, key or beat analysis.
    if let Some(service) = CHECKS.get_or_init(Service::start) {
        service.enqueue(path.clone());
    }
    Ok(path)
}
fn resolve_path(override_path: Option<PathBuf>, app: PathBuf) -> PathBuf {
    override_path.unwrap_or_else(|| {
        app.with_file_name(if cfg!(windows) {
            "singz-analyze.exe"
        } else {
            "singz-analyze"
        })
    })
}
fn valid_hash(hash: &str) -> bool {
    hash.len() == 40
        && hash
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
}
fn expected() -> Option<&'static str> {
    option_env!("SINGZ_EXPECTED_ANALYZE_SOURCE_HASH").filter(|hash| valid_hash(hash))
}
#[derive(Debug, PartialEq)]
struct Reported {
    hash: Option<String>,
}
fn parse(bytes: &[u8]) -> Option<Reported> {
    let value: Value = std::str::from_utf8(bytes)
        .ok()?
        .lines()
        .rev()
        .find_map(|line| serde_json::from_str::<Value>(line).ok())?;
    if value["version"] != 1 {
        return None;
    }
    let hash = match value.get("sourceHash")? {
        Value::Null => None,
        Value::String(hash) if valid_hash(hash) => Some(hash.clone()),
        _ => return None,
    };
    Some(Reported { hash })
}
#[derive(Debug)]
struct Verdict {
    state: &'static str,
    level: Level,
    line: String,
}
fn verdict(reported: Option<&Reported>, sidecar: Option<&str>, expected: Option<&str>) -> Verdict {
    // An answered-null helper cannot borrow a neighboring binary's stamp.
    let actual = reported.map_or(sidecar, |info| info.hash.as_deref());
    let state = if expected.is_none() {
        "unchecked"
    } else if actual.is_none() {
        "unknown-source"
    } else if reported
        .and_then(|info| info.hash.as_deref())
        .zip(sidecar)
        .is_some_and(|(a, b)| a != b)
    {
        "sidecar-drift"
    } else if actual != expected {
        "mismatch"
    } else {
        "match"
    };
    let level = match state {
        "mismatch" | "sidecar-drift" => Level::Error,
        "unknown-source" => Level::Warn,
        _ => Level::Info,
    };
    Verdict {
        state,
        level,
        line: format!(
            "core singz-analyze provenance {state}: reported {}, expected {}. Analysis continues.",
            actual.map(|hash| &hash[..12]).unwrap_or("unrecorded"),
            expected.map(|hash| &hash[..12]).unwrap_or("unavailable")
        ),
    }
}
#[derive(Clone, Debug, PartialEq, Eq)]
struct Identity {
    path: PathBuf,
    digest: Vec<u8>,
    sidecar: Option<String>,
}
fn sidecar(path: &Path) -> Option<String> {
    let mut name = path.as_os_str().to_os_string();
    name.push(".source-hash");
    let mut bytes = vec![];
    File::open(PathBuf::from(name))
        .ok()?
        .take(256)
        .read_to_end(&mut bytes)
        .ok()?;
    let text = std::str::from_utf8(&bytes).ok()?.trim();
    valid_hash(text).then(|| text.to_owned())
}
#[cfg(test)]
fn identity(path: &Path) -> Result<Identity> {
    identity_cancellable(path, &|| false)
}
fn identity_cancellable(path: &Path, cancel: &impl Fn() -> bool) -> Result<Identity> {
    ensure!(!cancel(), "Analyzer provenance stopped");
    let path = path.canonicalize()?;
    let mut file = File::open(&path)?;
    let before = file.metadata()?;
    ensure!(
        before.is_file() && before.len() <= MAX_EXECUTABLE,
        "Analyzer identity exceeds budget"
    );
    let deadline = Instant::now() + TIMEOUT;
    let mut hash = Sha256::new();
    let mut bytes = [0; 65536];
    let mut count = 0;
    loop {
        ensure!(!cancel(), "Analyzer provenance stopped");
        ensure!(Instant::now() < deadline, "Analyzer identity timed out");
        let n = file.read(&mut bytes)?;
        if n == 0 {
            break;
        }
        count += n as u64;
        ensure!(count <= MAX_EXECUTABLE, "Analyzer identity exceeds budget");
        hash.update(&bytes[..n]);
    }
    let after = fs::metadata(&path)?;
    ensure!(
        count == before.len()
            && before.len() == after.len()
            && before.modified()? == after.modified()?,
        "Analyzer changed during identity check"
    );
    let sidecar = sidecar(&path);
    Ok(Identity {
        path,
        digest: hash.finalize().to_vec(),
        sidecar,
    })
}
#[cfg(test)]
fn check(path: &Path, expected: Option<&str>, memo: &mut VecDeque<Identity>) -> Option<Verdict> {
    check_cancellable(path, expected, memo, &|| false)
}
fn check_cancellable(
    path: &Path,
    expected: Option<&str>,
    memo: &mut VecDeque<Identity>,
    cancel: &impl Fn() -> bool,
) -> Option<Verdict> {
    if cancel() {
        return None;
    }
    let before = match identity_cancellable(path, cancel) {
        Ok(identity) => identity,
        Err(_) => return Some(Verdict { state: "unchecked", level: Level::Warn, line: "core singz-analyze provenance unchecked: executable identity unavailable. Analysis continues.".into() }),
    };
    if memo.contains(&before) {
        return None;
    }
    let mut cmd = Command::new(&before.path);
    cmd.arg("build-info");
    let reported =
        crate::lyrics_align::diagnostic_command_cancellable(cmd, TIMEOUT, OUTPUT_LIMIT, cancel)
            .ok()
            .and_then(|bytes| parse(&bytes));
    // An in-place replacement while probing must never inherit a green match.
    if cancel() {
        return None;
    }
    if identity_cancellable(path, cancel).ok().as_ref() != Some(&before) {
        return Some(Verdict { state: "unchecked", level: Level::Warn, line: "core singz-analyze provenance unchecked: executable changed during probe. Analysis continues.".into() });
    }
    let result = verdict(reported.as_ref(), before.sidecar.as_deref(), expected);
    if memo.len() == MEMO_LIMIT {
        memo.pop_front();
    }
    memo.push_back(before);
    Some(result)
}

#[cfg(test)]
mod tests {
    use super::*;
    const CURRENT: &str = "0123456789abcdef0123456789abcdef01234567";
    const FOREIGN: &str = "abcdef0123456789abcdef0123456789abcdef01";
    #[test]
    fn same_detector_versions_do_not_vouch_for_foreign_sources() {
        let info = parse(format!(r#"{{"version":1,"sourceHash":"{FOREIGN}","pitchDetectVersion":4,"keyDetectVersion":2,"beatDetectVersion":23}}"#).as_bytes()).unwrap();
        assert_eq!(verdict(Some(&info), None, Some(CURRENT)).state, "mismatch");
        assert_eq!(
            verdict(
                Some(&Reported {
                    hash: Some(CURRENT.into())
                }),
                None,
                Some(CURRENT)
            )
            .state,
            "match"
        );
    }
    #[test]
    fn answered_null_never_borrows_sidecar_and_unknown_expectation_never_matches() {
        let info = parse(br#"{"version":1,"sourceHash":null}"#).unwrap();
        assert_eq!(
            verdict(Some(&info), Some(CURRENT), Some(CURRENT)).state,
            "unknown-source"
        );
        assert_eq!(verdict(None, Some(CURRENT), Some(CURRENT)).state, "match");
        assert_eq!(verdict(None, Some(CURRENT), None).state, "unchecked");
        assert_eq!(
            verdict(
                Some(&Reported {
                    hash: Some(CURRENT.into())
                }),
                Some(FOREIGN),
                Some(CURRENT)
            )
            .state,
            "sidecar-drift"
        );
    }
    #[test]
    fn malformed_and_future_protocols_cannot_claim_a_binary_answer() {
        for bytes in [
            b"old helper".as_slice(),
            br#"{"sourceHash":null}"#,
            br#"{"version":2,"sourceHash":null}"#,
            br#"{"version":1,"sourceHash":"garbage"}"#,
        ] {
            assert!(parse(bytes).is_none());
        }
    }
    #[test]
    fn override_is_preserved_without_changing_analysis_admission() {
        let app = PathBuf::from("app/player");
        assert_eq!(
            resolve_path(Some("foreign/custom-helper".into()), app.clone()),
            PathBuf::from("foreign/custom-helper")
        );
        assert_eq!(
            resolve_path(None, app).file_name().unwrap(),
            if cfg!(windows) {
                "singz-analyze.exe"
            } else {
                "singz-analyze"
            }
        );
    }
    #[cfg(unix)]
    #[test]
    fn actual_helper_answer_and_replacement_override_neighbor_stamp() {
        use std::os::unix::fs::PermissionsExt;
        let root = std::env::temp_dir().join(format!(
            "singz-provenance-probe-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("analyzer");
        let write = |hash: &str| {
            fs::write(
                &path,
                format!("#!/bin/sh\nprintf '%s\\n' '{{\"version\":1,\"sourceHash\":{hash}}}'\n"),
            )
            .unwrap();
            fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        };
        let mut memo = VecDeque::new();
        write(&format!("\"{CURRENT}\""));
        assert_eq!(
            check(&path, Some(CURRENT), &mut memo).unwrap().state,
            "match"
        );
        assert!(check(&path, Some(CURRENT), &mut memo).is_none());
        write(&format!("\"{FOREIGN}\""));
        assert_eq!(
            check(&path, Some(CURRENT), &mut memo).unwrap().state,
            "mismatch"
        );
        fs::write(root.join("analyzer.source-hash"), CURRENT).unwrap();
        write("null");
        assert_eq!(
            check(&path, Some(CURRENT), &mut memo).unwrap().state,
            "unknown-source"
        );
        fs::remove_dir_all(root).unwrap();
    }
    #[cfg(unix)]
    #[test]
    fn diagnostic_child_hang_and_output_overflow_retire_without_blocking_analysis() {
        let mut hang = Command::new("/bin/sh");
        hang.args(["-c", "sleep 30 & wait"]);
        let start = Instant::now();
        assert!(
            crate::lyrics_align::diagnostic_command(hang, Duration::from_millis(100), OUTPUT_LIMIT)
                .is_err()
        );
        assert!(start.elapsed() < Duration::from_secs(3));
        let mut overflow = Command::new("/bin/sh");
        overflow.args(["-c", "while :; do printf '0123456789abcdef'; done"]);
        assert!(
            crate::lyrics_align::diagnostic_command(overflow, Duration::from_secs(3), 64).is_err()
        );
        let mut good = Command::new("/bin/sh");
        good.args(["-c", "printf '{\"version\":1,\"sourceHash\":null}\\n'"]);
        let bytes =
            crate::lyrics_align::diagnostic_command(good, Duration::from_secs(3), OUTPUT_LIMIT)
                .unwrap();
        assert!(parse(&bytes).is_some());
    }
    #[cfg(unix)]
    #[test]
    fn shutdown_retires_started_probe_tree_and_suppresses_queued_and_future_work() {
        use std::os::unix::fs::PermissionsExt;
        fn process(pid: u32) -> Option<Vec<String>> {
            let output = Command::new("/bin/ps")
                .env("LC_ALL", "C")
                .args([
                    "-p",
                    &pid.to_string(),
                    "-o",
                    "pid=",
                    "-o",
                    "pgid=",
                    "-o",
                    "lstart=",
                    "-o",
                    "stat=",
                ])
                .output()
                .unwrap();
            if !output.status.success() {
                return None;
            }
            let fields = String::from_utf8(output.stdout)
                .unwrap()
                .split_whitespace()
                .map(str::to_owned)
                .collect::<Vec<_>>();
            (fields.len() >= 8).then_some(fields)
        }
        fn retired(pid: u32, owned: &[String]) -> bool {
            match process(pid) {
                None => true,
                Some(now) => now[..7] != owned[..7] || now[7].starts_with('Z'),
            }
        }
        let root = std::env::temp_dir().join(format!(
            "singz-provenance-shutdown-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("probe");
        let receipt = root.join("started");
        // Record both owned PIDs only after the descendant exists. The private
        // process group and ps start identity establish ownership before Quit.
        fs::write(&path, format!("#!/bin/sh\nsleep 30 &\nchild=$!\nprintf '%s %s\\n' \"$$\" \"$child\" > '{}'\nwait\n", receipt.display())).unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).unwrap();
        let queued = root.join("queued");
        let queued_receipt = root.join("unexpected");
        fs::write(
            &queued,
            format!(
                "#!/bin/sh\nprintf unexpected > '{}'\n",
                queued_receipt.display()
            ),
        )
        .unwrap();
        fs::set_permissions(&queued, fs::Permissions::from_mode(0o700)).unwrap();
        let service = Service::start().unwrap();
        service.enqueue(path);
        let deadline = Instant::now() + Duration::from_secs(5);
        let pids = loop {
            if let Ok(text) = fs::read_to_string(&receipt) {
                let values = text
                    .split_whitespace()
                    .filter_map(|p| p.parse::<u32>().ok())
                    .collect::<Vec<_>>();
                if values.len() == 2 {
                    break values;
                }
            }
            assert!(
                Instant::now() < deadline,
                "Probe never reported its child start"
            );
            thread::sleep(Duration::from_millis(10));
        };
        let owned = pids
            .iter()
            .map(|pid| process(*pid).expect("Owned probe process already stopped"))
            .collect::<Vec<_>>();
        for identity in &owned {
            assert_eq!(
                identity[1],
                pids[0].to_string(),
                "Probe escaped its private process group"
            );
        }
        service.enqueue(queued.clone());
        let shutdown_start = Instant::now();
        service.shutdown();
        assert!(
            shutdown_start.elapsed() < Duration::from_secs(3),
            "Shutdown ignored active probe cancellation"
        );
        assert!(service.worker.lock().unwrap().is_none());
        assert!(service.stopped.load(Ordering::Acquire));
        let deadline = Instant::now() + Duration::from_secs(3);
        while !pids
            .iter()
            .zip(&owned)
            .all(|(pid, identity)| retired(*pid, identity))
        {
            assert!(
                Instant::now() < deadline,
                "Owned diagnostic descendant survived shutdown"
            );
            thread::sleep(Duration::from_millis(10));
        }
        service.enqueue(queued);
        service.shutdown(); // Idempotent; a local service never resets globals.
        assert!(!queued_receipt.exists(), "Probe ran after retirement began");
        fs::remove_dir_all(root).unwrap();
    }
    #[test]
    fn in_place_replacement_with_same_size_changes_memo_identity() {
        let root = std::env::temp_dir().join(format!(
            "singz-provenance-{}-{}",
            std::process::id(),
            getrandom::u64().unwrap()
        ));
        fs::create_dir(&root).unwrap();
        let path = root.join("analyzer");
        fs::write(&path, b"first bytes").unwrap();
        let first = identity(&path).unwrap();
        fs::write(&path, b"other bytes").unwrap();
        let second = identity(&path).unwrap();
        assert_ne!(first, second);
        fs::remove_dir_all(root).unwrap();
    }
}

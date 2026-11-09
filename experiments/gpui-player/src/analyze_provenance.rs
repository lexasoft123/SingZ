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
        OnceLock,
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
const OUTPUT_LIMIT: usize = 16384;
const TIMEOUT: Duration = Duration::from_secs(10);
const MAX_EXECUTABLE: u64 = 512 * 1024 * 1024;
const MEMO_LIMIT: usize = 64;
static CHECKS: OnceLock<Option<SyncSender<PathBuf>>> = OnceLock::new();

pub(crate) fn resolve() -> Result<PathBuf> {
    let path = resolve_path(
        std::env::var_os("SINGZ_GPUI_ANALYZER").map(PathBuf::from),
        std::env::current_exe().context("Cannot locate native analyzer")?,
    );
    // The queue, hashing, probe and log belong to one background worker. A full
    // diagnostic queue cannot delay pitch, key or beat analysis.
    if let Some(sender) = CHECKS.get_or_init(|| {
        let (tx, rx) = mpsc::sync_channel::<PathBuf>(16);
        thread::Builder::new()
            .name("analyzer-provenance".into())
            .spawn(move || {
                let mut memo = VecDeque::new();
                for path in rx {
                    let result = check(&path, expected(), &mut memo);
                    if let Some(verdict) = result {
                        diagnostics::log(
                            "analyze",
                            &format!("[{}] {}", verdict.state, verdict.line),
                            verdict.level,
                        );
                    }
                }
            })
            .ok()
            .map(|_| tx)
    }) {
        let _ = sender.try_send(path.clone());
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
fn identity(path: &Path) -> Result<Identity> {
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
fn check(path: &Path, expected: Option<&str>, memo: &mut VecDeque<Identity>) -> Option<Verdict> {
    let before = match identity(path) {
        Ok(identity) => identity,
        Err(_) => return Some(Verdict { state: "unchecked", level: Level::Warn, line: "core singz-analyze provenance unchecked: executable identity unavailable. Analysis continues.".into() }),
    };
    if memo.contains(&before) {
        return None;
    }
    let mut cmd = Command::new(&before.path);
    cmd.arg("build-info");
    let reported = crate::lyrics_align::diagnostic_command(cmd, TIMEOUT, OUTPUT_LIMIT)
        .ok()
        .and_then(|bytes| parse(&bytes));
    // An in-place replacement while probing must never inherit a green match.
    if identity(path).ok().as_ref() != Some(&before) {
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

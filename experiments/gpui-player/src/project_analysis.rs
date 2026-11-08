//! Independent cancellable native melody and harmonic-key analysis.
use crate::integration::Project;
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::Path,
    process::{Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc, Arc,
    },
    thread,
    time::{Duration, Instant},
};
const LIMIT: u64 = 8 * 1024 * 1024;
#[derive(Debug, Default)]
pub struct Output {
    pub melody: Option<Value>,
    pub key: Option<crate::project_key::Outcome>,
    pub warnings: Vec<String>,
}
pub fn melody_needed(project: &Project) -> bool {
    project.pitch.det_version <= 4
        && (project.pitch.det_version < 4 || project.pitch.f0.is_empty())
        && project.lanes.iter().any(|(i, _)| *i == 0)
}
pub fn needed(project: &Project) -> bool {
    melody_needed(project) || crate::project_key::needed(project)
}
pub(crate) fn stamp(path: &Path) -> Result<(u64, std::time::SystemTime)> {
    let m = path.metadata()?;
    ensure!(m.is_file(), "Analysis source is not a regular file");
    Ok((m.len(), m.modified()?))
}
pub fn run(
    project: &Project,
    epoch: u64,
    latest: &Arc<AtomicU64>,
    alive: &Arc<AtomicBool>,
) -> Result<Output> {
    run_with_progress(project, epoch, latest, alive, Arc::new(|_| {}))
}
pub fn run_with_progress(
    project: &Project,
    epoch: u64,
    latest: &Arc<AtomicU64>,
    alive: &Arc<AtomicBool>,
    on_progress: Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<Output> {
    let cancel = || !alive.load(Ordering::Acquire) || latest.load(Ordering::Acquire) != epoch;
    ensure!(!cancel(), "Project analysis superseded");
    let melody_source = if melody_needed(project) {
        let source = &project
            .lanes
            .iter()
            .find(|(slot, _)| *slot == 0)
            .context("No vocal source")?
            .1;
        let before = stamp(source)?;
        ensure!(
            project.vocal_stamp == Some(before),
            "Vocal source changed after project loading"
        );
        Some((source, before))
    } else {
        None
    };
    let key_inputs = crate::project_key::needed(project)
        .then(|| crate::project_key::Inputs::capture(project))
        .transpose()?;
    let check = || -> Result<()> {
        ensure!(!cancel(), "Project analysis superseded");
        if let Some((source, before)) = &melody_source {
            ensure!(
                stamp(source)? == *before,
                "Vocal source changed during project analysis"
            );
        }
        if let Some(inputs) = &key_inputs {
            inputs.check(&cancel)?;
        }
        Ok(())
    };
    run_parts(
        &check,
        melody_source
            .is_some()
            .then(|| move || run_melody(project, epoch, latest, alive, on_progress)),
        key_inputs
            .as_ref()
            .map(|inputs| move || crate::project_key::run(inputs, &cancel)),
    )
}
fn run_parts<M, K>(
    check: &impl Fn() -> Result<()>,
    melody: Option<M>,
    key: Option<K>,
) -> Result<Output>
where
    M: FnOnce() -> Result<Value>,
    K: FnOnce() -> Result<crate::project_key::Outcome>,
{
    let mut output = Output::default();
    check()?;
    if let Some(run) = melody {
        match run() {
            Ok(melody) => output.melody = Some(melody),
            Err(error) => output.warnings.push(format!("Melody analysis: {error:#}")),
        }
        check()?;
    }
    if let Some(run) = key {
        match run() {
            Ok(key) => output.key = Some(key),
            Err(error) => output.warnings.push(format!("Key analysis: {error:#}")),
        }
    }
    // A detector failure is local to that part. Changed/superseded input makes
    // the entire combined result unsafe, even if another detector succeeded.
    check()?;
    Ok(output)
}
fn run_melody(
    project: &Project,
    epoch: u64,
    latest: &Arc<AtomicU64>,
    alive: &Arc<AtomicBool>,
    on_progress: Arc<dyn Fn(f32) + Send + Sync>,
) -> Result<Value> {
    let source = &project
        .lanes
        .iter()
        .find(|(i, _)| *i == 0)
        .context("No vocal source")?
        .1;
    let before = stamp(source)?;
    ensure!(
        project.vocal_stamp == Some(before),
        "Vocal source changed after project loading"
    );
    let exe = std::env::var_os("SINGZ_GPUI_ANALYZER")
        .map(std::path::PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "singz-analyze.exe"
        } else {
            "singz-analyze"
        }));
    let mut command = Command::new(exe);
    command
        .args(["analyze", "--melody", "--vocals"])
        .arg(source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000); // CREATE_NO_WINDOW, as for playback.
    }
    let mut child = command
        .spawn()
        .context("Cannot start native pitch analysis; rebuild the native tools")?;
    let stdout = child.stdout.take().context("Missing analyzer stdout")?;
    let stderr = child.stderr.take().context("Missing analyzer progress")?;
    let progress_reader = thread::spawn(move || read_progress(stderr, &*on_progress));
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = vec![];
        let result = stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    let result = (|| -> Result<Value> {
        loop {
            ensure!(
                alive.load(Ordering::Acquire) && latest.load(Ordering::Acquire) == epoch,
                "Pitch analysis superseded"
            );
            if let Some(status) = child.try_wait()? {
                ensure!(status.success(), "Native pitch analysis failed ({status})");
                break;
            }
            ensure!(Instant::now() < deadline, "Native pitch analysis timed out");
            thread::sleep(Duration::from_millis(20));
        }
        let bytes = rx
            .recv_timeout(Duration::from_secs(2))
            .context("Missing native pitch result")??;
        ensure!(
            bytes.len() <= LIMIT as usize,
            "Native pitch result is too large"
        );
        ensure!(
            stamp(source)? == before,
            "Vocal source changed during analysis"
        );
        let raw: Value = serde_json::from_slice(&bytes)?;
        encode(&raw["melody"], project.pitch.analysis_duration())
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    let _ = progress_reader.join();
    result
}
fn progress_value(line: &[u8]) -> Option<f32> {
    let value = std::str::from_utf8(line)
        .ok()?
        .strip_prefix("progress melody ")?;
    if value.is_empty() || !value.bytes().all(|b| b.is_ascii_digit() || b == b'.') {
        return None;
    }
    value
        .parse::<f32>()
        .ok()
        .filter(|p| p.is_finite())
        .map(|p| p.min(1.))
}
fn read_progress(mut source: impl Read, emit: &dyn Fn(f32)) {
    // Drain diagnostics without retaining arbitrary log lines or blocking the
    // analyzer's progress pipe. Only its existing melody protocol is adopted.
    let mut chunk = [0u8; 1024];
    let mut line = Vec::with_capacity(256);
    let mut overflow = false;
    let mut last = None;
    loop {
        let count = match source.read(&mut chunk) {
            Ok(0) | Err(_) => break,
            Ok(n) => n,
        };
        for byte in &chunk[..count] {
            if *byte == b'\n' {
                if !overflow {
                    if line.last() == Some(&b'\r') {
                        line.pop();
                    }
                    if let Some(value) =
                        progress_value(&line).filter(|p| last.is_none_or(|old| *p > old))
                    {
                        last = Some(value);
                        emit(value);
                    }
                }
                line.clear();
                overflow = false;
            } else if line.len() < 256 && !overflow {
                line.push(*byte);
            } else {
                overflow = true;
            }
        }
    }
}
fn encode(raw: &Value, duration: f32) -> Result<Value> {
    ensure!(
        raw["detVersion"].as_u64() == Some(4),
        "Unsupported native pitch detector version"
    );
    let hop = raw["hopSec"].as_f64().context("Missing analysis hop")?;
    ensure!(hop > 0.001 && hop < 0.5, "Invalid analysis hop");
    let frames = raw["f0"].as_array().context("Missing analysis frames")?;
    ensure!(
        !frames.is_empty() && frames.len() <= 200000,
        "Invalid analysis frame count"
    );
    ensure!(
        (frames.len() as f64 * hop - duration as f64).abs() <= 2.,
        "Pitch coverage differs from the loaded song"
    );
    let mut tokens = vec![];
    let mut gap = 0;
    let flush = |gap: &mut usize, tokens: &mut Vec<String>| {
        if *gap > 0 {
            tokens.push(if *gap == 1 {
                "x".into()
            } else {
                format!("x{}", *gap)
            });
            *gap = 0;
        }
    };
    for hz in frames {
        let hz = hz.as_f64().context("Invalid pitch frequency")?;
        ensure!(
            hz.is_finite() && (0. ..=5600.).contains(&hz),
            "Invalid pitch frequency"
        );
        if hz == 0. {
            gap += 1;
            continue;
        }
        flush(&mut gap, &mut tokens);
        let cents = (1200. * (hz / 55.).log2()).round().max(0.);
        if cents > 8000. {
            bail!("Pitch is outside the saved format");
        }
        tokens.push(format!("{cents:.0}"));
    }
    flush(&mut gap, &mut tokens);
    Ok(json!({"detVersion":4,"hopSec":(hop*1e7).round()/1e7,"f0":tokens.join(" ")}))
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn independent_parts_keep_success_but_source_guard_invalidates_everything() {
        let result = run_parts(
            &|| Ok(()),
            Some(|| Ok(json!({"detVersion":4}))),
            Some(|| anyhow::bail!("key helper unavailable")),
        )
        .unwrap();
        assert!(result.melody.is_some());
        assert!(result.key.is_none());
        assert_eq!(result.warnings.len(), 1);
        let result = run_parts(
            &|| Ok(()),
            Some(|| anyhow::bail!("melody helper unavailable")),
            Some(|| {
                Ok(crate::project_key::Outcome::Detected {
                    pc: 7,
                    minor: false,
                })
            }),
        )
        .unwrap();
        assert!(result.melody.is_none());
        assert!(result.key.is_some());
        assert_eq!(result.warnings.len(), 1);
        let checks = std::cell::Cell::new(0);
        let guard = || {
            checks.set(checks.get() + 1);
            ensure!(checks.get() < 3, "Source replaced before final adoption");
            Ok(())
        };
        assert!(run_parts(
            &guard,
            Some(|| Ok(json!({"detVersion":4}))),
            Some(|| Ok(crate::project_key::Outcome::NoKey))
        )
        .is_err());
    }
    #[test]
    fn progress_stream_is_bounded_monotonic_and_melody_only() {
        let mut bytes = vec![b'x'; 4096];
        bytes.extend_from_slice(b"\nprogress beats 0.9\nprogress melody NaN\nprogress melody -0.2\nprogress melody 0.000\nprogress melody 0.420\r\nprogress melody 0.300\nprogress melody 0.420\nprogress melody 2.0\nprogress melody 0.8\n");
        let values = std::cell::RefCell::new(Vec::new());
        read_progress(bytes.as_slice(), &|p| values.borrow_mut().push(p));
        assert_eq!(*values.borrow(), vec![0., 0.42, 1.]);
        assert_eq!(progress_value(b"progress melody .5"), Some(0.5));
        assert_eq!(progress_value(b"progress melody 1e-2"), None);
        assert_eq!(progress_value(b"progress melody 0.5 extra"), None);
    }
    #[test]
    fn native_result_uses_saved_format_and_coverage_guards() {
        let raw = json!({"detVersion":4,"hopSec":0.025,"f0":[0,0,110,220,0]});
        let saved = encode(&raw, 0.125).unwrap();
        assert_eq!(saved["f0"], "x2 1200 2400 x");
        assert!(encode(&raw, 5.).is_err());
        let mut future = raw.clone();
        future["detVersion"] = json!(5);
        assert!(encode(&future, 0.125).is_err());
    }
}

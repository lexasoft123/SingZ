//! Cancellable beat analysis through the existing native detector and installed
//! Beat This pack. No decoder, resampler, detector or neural inference lives here.
use crate::{
    beat::Beats,
    model_catalog::{Config, Flavor},
};
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};

const OUTPUT_LIMIT: usize = 32 * 1024 * 1024;
const NATIVE_LINE_LIMIT: usize = 2 * 1024 * 1024;
const ML_LINE_LIMIT: usize = OUTPUT_LIMIT;
const MAX_DURATION: f64 = 43_200.;
const CONTRACT: &str = include_str!("../../../src/renderer/src/audio/analysis-contract.ts");

pub fn version() -> u64 {
    CONTRACT
        .split("export const BEAT_DETECT_VERSION = ")
        .nth(1)
        .and_then(|s| s.lines().next())
        .and_then(|s| s.trim().parse().ok())
        .expect("embedded source beat detector stamp")
}

/// Source's stale predicate never downgrades a newer stamped automatic grid.
pub fn needed(grid: Option<&Beats>) -> bool {
    grid.is_none_or(|g| {
        g.source == "auto"
            && g.det_version
                .is_none_or(|v| !v.is_finite() || v < version() as f64)
    })
}

#[derive(Clone, Debug)]
struct Source {
    lane: usize,
    path: PathBuf,
    stamp: (u64, SystemTime),
}
#[derive(Clone, Debug)]
pub struct Inputs {
    pub epoch: u64,
    pub revision: u64,
    pub duration: f64,
    sources: Vec<Source>,
    line_starts: Vec<f64>,
    words: Vec<(f64, f64)>,
}
#[derive(Debug)]
pub struct Output {
    pub epoch: u64,
    pub revision: u64,
    /// None means the detector found no steady beat; keep the accepted old grid.
    pub grid: Option<Beats>,
    pub warnings: Vec<String>,
    pub used_ml: bool,
}
fn stamp(path: &Path) -> Result<(u64, SystemTime)> {
    let meta = fs::metadata(path)?;
    ensure!(meta.is_file(), "Beat input is not a regular file");
    Ok((meta.len(), meta.modified()?))
}
pub fn capture(
    lanes: Vec<(usize, PathBuf)>,
    duration: f64,
    epoch: u64,
    revision: u64,
    line_starts: Vec<f64>,
    words: Vec<(f64, f64)>,
) -> Result<Inputs> {
    ensure!(
        duration.is_finite() && duration > 0. && duration <= MAX_DURATION,
        "Invalid beat input duration"
    );
    ensure!(
        !lanes.is_empty() && lanes.len() <= crate::tracks::BUILTIN_SLOTS,
        "Invalid beat input lanes"
    );
    ensure!(
        line_starts.len() <= 10_000 && words.len() <= 100_000,
        "Too many lyric beat cues"
    );
    let valid = |v: f64| v.is_finite() && (0. ..=MAX_DURATION).contains(&v);
    ensure!(
        line_starts.iter().all(|v| valid(*v))
            && words.iter().all(|(s, e)| valid(*s) && valid(*e) && e >= s),
        "Invalid lyric beat cues"
    );
    let mut sources = vec![];
    for (lane, path) in lanes {
        ensure!(
            lane < crate::tracks::BUILTIN_SLOTS && !sources.iter().any(|s: &Source| s.lane == lane),
            "Duplicate or unknown beat lane"
        );
        let path = path.canonicalize().context("Beat input is missing")?;
        let before = stamp(&path)?;
        sources.push(Source {
            lane,
            path,
            stamp: before,
        });
    }
    ensure!(
        sources.iter().any(|s| s.lane == 1),
        "Beat detection needs a drums lane"
    );
    Ok(Inputs {
        epoch,
        revision,
        duration,
        sources,
        line_starts,
        words,
    })
}
impl Inputs {
    /// Fence capture against the sources loaded into the accepted project. A
    /// second call after run also rejects changed/replaced inputs before adoption.
    /// Custom/backing lanes do not enter the source beat mix. Match the exact
    /// captured built-in role set against the full parallel loaded inventory,
    /// rather than assuming custom edits leave dense ordinals unchanged.
    pub fn verify_loaded(
        &self,
        lanes: &[(usize, PathBuf)],
        stamps: &[(u64, SystemTime)],
    ) -> Result<()> {
        ensure!(
            lanes.len() == stamps.len() && lanes.len() <= crate::tracks::MAX_ACTIVE_LANES,
            "Loaded beat input inventory changed"
        );
        let mut slots = std::collections::BTreeSet::new();
        for (slot, _) in lanes {
            ensure!(
                *slot < crate::tracks::LANE_SLOTS && slots.insert(*slot),
                "Duplicate or unknown loaded lane"
            );
        }
        let builtins: Vec<_> = lanes
            .iter()
            .zip(stamps)
            .filter(|((slot, _), _)| *slot < crate::tracks::BUILTIN_SLOTS)
            .collect();
        ensure!(
            self.sources.len() == builtins.len(),
            "Loaded beat source roles changed"
        );
        for source in &self.sources {
            let ((_, path), loaded_stamp) = builtins
                .iter()
                .copied()
                .find(|((slot, _), _)| *slot == source.lane)
                .context("Loaded beat role is missing")?;
            ensure!(
                source.path
                    == path
                        .canonicalize()
                        .context("Loaded beat input is missing")?
                    && source.stamp == *loaded_stamp,
                "Beat input changed after project loading"
            );
        }
        self.check(&|| false)
    }
    fn check(&self, cancel: &impl Fn() -> bool) -> Result<()> {
        ensure!(!cancel(), "Beat analysis superseded");
        for s in &self.sources {
            ensure!(
                stamp(&s.path)? == s.stamp,
                "Beat input changed during analysis"
            );
        }
        Ok(())
    }
}

/// Conversion is intentionally separate from adopting a result: the app must
/// fence epoch/revision and fold LIVE user-bar corrections after audio accepts it.
pub fn grid_from_detection(raw: &Value, duration: f64) -> Result<Option<Beats>> {
    ensure!(
        duration.is_finite() && duration > 0. && duration <= MAX_DURATION,
        "Invalid beat result duration"
    );
    ensure!(
        raw["detVersion"].as_u64() == Some(version()),
        "Native beat detector version differs from the app"
    );
    ensure!(raw["ok"].is_boolean(), "Missing beat detector status");
    if raw["ok"] == false {
        if let Some(detail) = raw["error"].as_str().filter(|s| !s.trim().is_empty()) {
            let detail = detail.chars().take(400).collect::<String>();
            anyhow::bail!("Native beat detection failed: {detail}");
        }
        // Shared detectBeats returns its default {ok:false, beats:[]} for
        // unsteady/rubato material as well as a silent drum frontend. This is
        // a musical refusal, not a crashed analysis or a replacement grid.
        ensure!(
            raw["beatsSec"].as_array().is_some_and(Vec::is_empty),
            "Native beat detector returned an inconsistent refused grid"
        );
        return Ok(None);
    }
    let times = raw["beatsSec"]
        .as_array()
        .context("Missing native beat times")?;
    ensure!(
        times.len() <= crate::beat::MAX_BEATS,
        "Too many native beats"
    );
    if times.is_empty() {
        return Ok(None);
    }
    let bpm = raw["bpm"].as_f64().context("Missing native beat tempo")?;
    let meter = raw["beatsPerBar"]
        .as_u64()
        .context("Missing native beat meter")?;
    let downbeat = raw["downbeat"]
        .as_u64()
        .context("Missing native beat phase")?;
    ensure!(
        bpm.is_finite() && (30. ..=300.).contains(&bpm),
        "Invalid native beat tempo"
    );
    ensure!(
        crate::beat::METERS.contains(&(meter as usize)) && downbeat < meter,
        "Invalid native beat meter or phase"
    );
    let mut saved = serde_json::json!({
        "beats": times, "beatsPerBar": raw["beatsPerBar"], "downbeat": raw["downbeat"],
        "source": "auto", "detVersion": version(),
    });
    // Validate before sanitization, so malformed native arrays cannot silently
    // drop/reorder beats while retaining downbeat indexes from a different map.
    let mut previous = None;
    for t in times {
        let t = t.as_f64().context("Invalid native beat time")?;
        ensure!(
            t.is_finite() && t >= 0. && t <= duration + 1. && previous.is_none_or(|p| t - p > 0.05),
            "Invalid native beat sequence"
        );
        previous = Some(t);
    }
    if raw["hasDownbeats"] == true {
        let bars = raw["downbeats"].as_array().context("Missing native bars")?;
        ensure!(
            !bars.is_empty() && bars.len() <= times.len(),
            "Invalid native bar count"
        );
        let mut previous = None;
        for v in bars {
            let i = v.as_u64().context("Invalid native bar index")? as usize;
            ensure!(
                i < times.len() && previous.is_none_or(|p| i > p),
                "Invalid native bar map"
            );
            previous = Some(i);
        }
        saved["downbeats"] = Value::Array(bars.clone());
        saved["autoDownbeats"] = Value::Array(bars.clone());
    }
    if let Some(suspect) = raw["suspectAt"].as_array().filter(|s| !s.is_empty()) {
        ensure!(
            suspect.len() <= times.len()
                && suspect.iter().all(|t| t
                    .as_f64()
                    .is_some_and(|v| v.is_finite() && v >= 0. && v <= duration + 1.)),
            "Invalid native suspect bars"
        );
        saved["suspectAt"] = Value::Array(suspect.clone());
    }
    let mut grid =
        Beats::sanitize(&saved).context("Native detector returned an unusable beat grid")?;
    // Fresh detector conversion retains its own tempo, as gridFromDetection
    // does. Saved-data sanitization recomputes median tempo only on reload.
    grid.bpm = bpm;
    grid.validate_audio()?;
    Ok(Some(grid))
}

fn regular(path: &Path) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() > 0)
}
fn pack_python(config: &Config) -> PathBuf {
    config.pack.join(if config.flavor == Flavor::Windows {
        "python/python.exe"
    } else {
        "python/bin/python3"
    })
}
fn pack_available(config: &Config) -> bool {
    let raw: Value = File::open(config.pack.join("python/pack.json"))
        .ok()
        .and_then(|file| {
            let mut bytes = vec![];
            file.take(64 * 1024 + 1).read_to_end(&mut bytes).ok()?;
            Some(bytes)
        })
        .filter(|b| b.len() < 64 * 1024)
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let onnx = matches!(config.flavor, Flavor::Windows | Flavor::IntelMac)
        || raw["target"] == "darwin-x64";
    raw["formatVersion"].as_u64().is_some_and(|v| v >= 4)
        && regular(&pack_python(config))
        && regular(&config.pack.join("python/beat_runner.py"))
        && if onnx {
            regular(&config.pack.join("python/models/beat_this/beat_this.onnx"))
                && regular(&config.pack.join("python/models/beat_this/logmel.onnx"))
        } else {
            regular(&config.pack.join("python/models/beat_this/final0.ckpt"))
        }
}

static TEMP_SERIAL: AtomicU64 = AtomicU64::new(0);
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        for _ in 0..32 {
            let id = TEMP_SERIAL.fetch_add(1, Ordering::Relaxed);
            let path = std::env::temp_dir().join(format!(
                "singz-native-beats-{}-{}-{id}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)?
                    .as_nanos()
            ));
            let mut builder = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                builder.mode(0o700);
            }
            match builder.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        anyhow::bail!("Cannot create private beat-analysis workspace")
    }
    fn token_file(&self, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.0.join("lattice.txt");
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut file = opts.open(&path)?;
        file.write_all(bytes)?;
        file.sync_all()?;
        Ok(path)
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

struct Running {
    child: Child,
    readers: Vec<thread::JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        // Kill the task-owned group even if its parent exited first: Python
        // grandchildren must not retain the pipes and wedge cancellation.
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            unsafe {
                kill(-(self.child.id() as i32), 9);
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        for r in self.readers.drain(..) {
            let _ = r.join();
        }
    }
}
fn command(
    mut cmd: Command,
    input: Option<File>,
    timeout: Duration,
    cancel: &impl Fn() -> bool,
    label: &str,
) -> Result<Vec<u8>> {
    ensure!(!cancel(), "Beat analysis superseded");
    cmd.stdin(input.map_or_else(Stdio::null, Stdio::from))
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000200);
    }
    let mut child = cmd
        .spawn()
        .with_context(|| format!("Cannot start {label}"))?;
    let bytes = Arc::new(Mutex::new(Vec::<u8>::new()));
    let errors = Arc::new(Mutex::new(Vec::<u8>::new()));
    let overflow = Arc::new(AtomicBool::new(false));
    let stdout = child.stdout.take().context("Missing beat stdout")?;
    let stderr = child.stderr.take().context("Missing beat stderr")?;
    let mut readers = vec![];
    for (mut input, retain) in [
        (Box::new(stdout) as Box<dyn Read + Send>, true),
        (Box::new(stderr) as Box<dyn Read + Send>, false),
    ] {
        let data = if retain {
            bytes.clone()
        } else {
            errors.clone()
        };
        let overflow = overflow.clone();
        readers.push(thread::spawn(move || {
            let mut block = [0u8; 8192];
            while let Ok(n) = input.read(&mut block) {
                if n == 0 {
                    break;
                }
                if retain {
                    let mut b = data.lock().unwrap();
                    if b.len() + n > OUTPUT_LIMIT {
                        overflow.store(true, Ordering::Release);
                        break;
                    }
                    b.extend_from_slice(&block[..n]);
                } else {
                    let mut b = data.lock().unwrap();
                    let drop = (b.len() + n).saturating_sub(8192);
                    if drop > 0 {
                        b.drain(..drop);
                    }
                    b.extend_from_slice(&block[..n]);
                }
            }
        }));
    }
    let mut process = Running { child, readers };
    let start = Instant::now();
    let status = loop {
        ensure!(!cancel(), "Beat analysis superseded");
        ensure!(
            !overflow.load(Ordering::Acquire),
            "{label} output exceeded its bound"
        );
        ensure!(start.elapsed() < timeout, "{label} timed out");
        if let Some(status) = process.child.try_wait()? {
            if process.readers.iter().all(|r| r.is_finished()) {
                break status;
            }
        }
        thread::sleep(Duration::from_millis(25));
    };
    for reader in process.readers.drain(..) {
        let _ = reader.join();
    }
    let tail = String::from_utf8_lossy(&errors.lock().unwrap())
        .lines()
        .rev()
        .take(3)
        .collect::<Vec<_>>()
        .into_iter()
        .rev()
        .collect::<Vec<_>>()
        .join(" — ");
    // Never print commands or environment. Only the task's bounded diagnostic
    // tail is retained, including the native 44.1kHz mix-contract refusal.
    let tail = tail.chars().take(400).collect::<String>();
    ensure!(status.success(), "{label} failed ({status}): {tail}");
    ensure!(
        !overflow.load(Ordering::Acquire),
        "{label} output exceeded its bound"
    );
    let output = bytes.lock().unwrap().clone();
    Ok(output)
}

/// Per-part NDJSON is parsed as separate records, never as one JSON document.
fn json_lines(bytes: &[u8], line_limit: usize) -> Result<Vec<Value>> {
    let mut records = vec![];
    for line in bytes
        .split(|b| *b == b'\n')
        .filter(|line| line.iter().any(|c| !c.is_ascii_whitespace()))
    {
        ensure!(line.len() <= line_limit, "Beat result line is too large");
        ensure!(records.len() < 64, "Too many beat result records");
        records.push(serde_json::from_slice(line).context("Invalid beat result record")?);
    }
    Ok(records)
}
fn ml_record(bytes: &[u8]) -> Result<Value> {
    // The installed runner may print dependency notices before its last JSON
    // line. Match beats-ml.ts: those notices are not NDJSON result records.
    let line = bytes
        .split(|b| *b == b'\n')
        .filter(|line| line.iter().find(|b| !b.is_ascii_whitespace()) == Some(&b'{'))
        .next_back()
        .context("Beat model returned no lattice")?;
    ensure!(
        line.len() <= ML_LINE_LIMIT,
        "Beat model result line is too large"
    );
    serde_json::from_slice(line).context("Invalid beat model lattice record")
}
fn ml_tokens(raw: &Value, duration: f64) -> Result<Vec<u8>> {
    let fps = raw["fps"]
        .as_f64()
        .context("Missing beat lattice frame rate")?;
    ensure!(
        fps.is_finite() && fps.fract() == 0. && (1. ..=200.).contains(&fps),
        "Invalid beat lattice frame rate"
    );
    let mut out = format!("fps {fps}\n");
    let mut probabilities = None;
    for (key, token, times) in [
        ("beats", "beats", true),
        ("downbeats", "downbeats", true),
        ("beat_prob", "beatProb", false),
        ("downbeat_prob", "downbeatProb", false),
    ] {
        let values = raw[key]
            .as_array()
            .with_context(|| format!("Missing beat lattice {key}"))?;
        let max = if times {
            crate::beat::MAX_BEATS
        } else {
            (duration * fps).ceil() as usize + fps as usize * 2
        };
        ensure!(values.len() <= max, "Beat lattice exceeds song bounds");
        if !times {
            if let Some(n) = probabilities {
                ensure!(values.len() == n, "Mismatched beat lattice probabilities");
            }
            probabilities = Some(values.len());
        }
        out.push_str(&format!("{token} {}", values.len()));
        let mut previous = None;
        for value in values {
            let n = value.as_f64().context("Invalid beat lattice value")?;
            ensure!(
                n.is_finite() && n >= 0. && n <= if times { duration + 1. } else { 1. },
                "Beat lattice value outside bounds"
            );
            if times {
                ensure!(
                    previous.is_none_or(|p| n > p),
                    "Beat lattice times not increasing"
                );
                previous = Some(n);
            }
            out.push(' ');
            out.push_str(&n.to_string());
        }
        out.push('\n');
        ensure!(
            out.len() <= OUTPUT_LIMIT,
            "Beat lattice token payload too large"
        );
    }
    Ok(out.into_bytes())
}

pub fn run(inputs: &Inputs, cancel: &impl Fn() -> bool) -> Result<Output> {
    run_with_progress(inputs, cancel, &|_| {})
}
pub fn run_with_progress(
    inputs: &Inputs,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(f32),
) -> Result<Output> {
    inputs.check(cancel)?;
    progress(0.02);
    let exe = std::env::var_os("SINGZ_GPUI_ANALYZER")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "singz-analyze.exe"
        } else {
            "singz-analyze"
        }));
    let config = Config::source();
    let scratch = Scratch::new()?;
    let helper = std::env::var_os("SINGZ_GPUI_AUDIO_HELPER")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "singz-gpui-audio.exe"
        } else {
            "singz-gpui-audio"
        }));
    let mut audible = [true; crate::tracks::BUILTIN_SLOTS];
    for source in inputs.sources.iter().filter(|s| matches!(s.lane, 3 | 4)) {
        let mut cmd = Command::new(&helper);
        cmd.arg("--measure-input").arg(&source.path);
        let bytes = command(
            cmd,
            None,
            Duration::from_secs(120),
            cancel,
            "Native harmonic measurement",
        )?;
        let records = json_lines(&bytes, NATIVE_LINE_LIMIT)?;
        let measurement = records
            .last()
            .context("Missing native harmonic measurement")?;
        ensure!(
            measurement["protocol"] == 1 && measurement["ok"] == true,
            "Native harmonic measurement refused"
        );
        let rms = measurement["rms"]
            .as_f64()
            .context("Missing native harmonic RMS")?;
        ensure!(rms.is_finite() && rms >= 0., "Invalid native harmonic RMS");
        audible[source.lane] = rms >= 0.004;
        inputs.check(cancel)?;
    }
    let mut warnings = vec![];
    let mut lattice = None;
    if pack_available(&config) {
        let ml = (|| -> Result<Vec<u8>> {
            let mix = scratch.0.join("mix.f32");
            let mut cmd = Command::new(&exe);
            cmd.arg("mlmix").arg(&mix);
            for source in inputs.sources.iter().filter(|s| audible[s.lane]) {
                cmd.arg(&source.path);
            }
            command(
                cmd,
                None,
                Duration::from_secs(120),
                cancel,
                "Native beat-model mix",
            )?;
            inputs.check(cancel)?;
            let size = fs::metadata(&mix)?.len();
            ensure!(
                size > 0 && size % 4 == 0 && size <= ((inputs.duration + 2.) * 22_050. * 4.) as u64,
                "Native model mix size differs from song"
            );
            let mut cmd = Command::new(pack_python(&config));
            cmd.arg(config.pack.join("python/beat_runner.py"))
                .arg("--f32")
                .arg(&mix)
                .args(["--sr", "22050"])
                .env("PYTHONUNBUFFERED", "1")
                .env("PYTHONUTF8", "1")
                .env("PYTHONDONTWRITEBYTECODE", "1")
                .env("HF_HUB_OFFLINE", "1")
                .env("HF_DATASETS_OFFLINE", "1")
                .env("TORCH_HOME", config.pack.join("python/torch-home"))
                .env("HF_HOME", config.pack.join("python/hf-home"));
            let bytes = command(
                cmd,
                None,
                Duration::from_secs(180),
                cancel,
                "Installed beat model",
            )?;
            let raw = ml_record(&bytes)?;
            ml_tokens(&raw, inputs.duration)
        })();
        inputs.check(cancel)?;
        match ml {
            Ok(path) => lattice = Some(path),
            Err(error) => warnings.push(format!(
                "Installed beat model unavailable: {error}. Using the native detector without ML."
            )),
        }
    } else {
        warnings.push(
            "Installed pack has no usable beat model; using the native detector without ML.".into(),
        );
    }
    inputs.check(cancel)?;
    progress(0.97);
    let mut cmd = Command::new(&exe);
    cmd.args(["analyze", "--beats"]);
    for s in &inputs.sources {
        let flag = match s.lane {
            0 => Some("--vocals"),
            1 => Some("--drums"),
            2 => Some("--bass"),
            3 | 4 if audible[s.lane] => Some("--inst"),
            5 | 6 => Some("--inst"),
            _ => None,
        };
        if let Some(flag) = flag {
            cmd.arg(flag).arg(&s.path);
        }
    }
    let used_ml = lattice.is_some();
    let mut tokens = lattice.unwrap_or_default();
    write!(tokens, "lineStarts {}", inputs.line_starts.len())?;
    for time in &inputs.line_starts {
        write!(tokens, " {time}")?;
    }
    write!(tokens, "\nwords {}", inputs.words.len() * 2)?;
    for (start, end) in &inputs.words {
        write!(tokens, " {start} {end}")?;
    }
    writeln!(tokens)?;
    ensure!(
        tokens.len() <= OUTPUT_LIMIT,
        "Beat analysis aux payload too large"
    );
    let stdin = scratch.token_file(&tokens)?;
    cmd.arg("--ml-stdin");
    let bytes = command(
        cmd,
        Some(File::open(stdin)?),
        Duration::from_secs(180),
        cancel,
        "Native beat detector",
    )?;
    inputs.check(cancel)?;
    let mut result = None;
    for record in json_lines(&bytes, NATIVE_LINE_LIMIT)? {
        if let Some(raw) = record.get("beats") {
            ensure!(result.is_none(), "Duplicate native beat result");
            result = Some(grid_from_detection(raw, inputs.duration)?);
        }
    }
    Ok(Output {
        epoch: inputs.epoch,
        revision: inputs.revision,
        grid: result.context("Missing native beat result")?,
        warnings,
        used_ml,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn stale_and_future_stamps_follow_source_contract() {
        let mut grid = Beats::constant(120., 0., 10., 4).unwrap();
        assert!(!needed(Some(&grid)));
        assert!(needed(None));
        grid.source = "auto".into();
        assert!(needed(Some(&grid)));
        grid.det_version = Some(version() as f64);
        assert!(!needed(Some(&grid)));
        grid.det_version = Some(version() as f64 + 1.);
        assert!(!needed(Some(&grid)));
        grid.det_version = Some(version() as f64 - 1.);
        assert!(needed(Some(&grid)));
    }
    #[test]
    fn ndjson_parts_are_separate_and_bounded() {
        let records = json_lines(b"{\"melody\":{}}\n{\"beats\":{}}\n", 64).unwrap();
        assert_eq!(records.len(), 2);
        assert!(records[1].get("beats").is_some());
        assert!(json_lines(b"{\"beats\":{}}", 4).is_err());
        assert!(json_lines(b"garbage\n", 64).is_err());
    }
    #[test]
    fn detector_conversion_preserves_base_and_rejects_index_drift() {
        let raw = json!({"detVersion":version(),"ok":true,"bpm":119.8,"beatsSec":[0.,0.5,1.,1.5,2.,2.5],"beatsPerBar":4,"downbeat":0,"hasDownbeats":true,"downbeats":[0,4],"suspectAt":[2.]});
        let grid = grid_from_detection(&raw, 3.).unwrap().unwrap();
        assert_eq!(grid.source, "auto");
        assert_eq!(grid.bpm, 119.8);
        assert_eq!(grid.auto_downbeats, Some(vec![0, 4]));
        assert_eq!(grid.downbeats, grid.auto_downbeats);
        let mut bad = raw.clone();
        bad["beatsSec"] = json!([0., 0.5, 0.501, 1., 1.5]);
        assert!(grid_from_detection(&bad, 3.).is_err());
        bad = raw.clone();
        bad["detVersion"] = json!(version() + 1);
        assert!(grid_from_detection(&bad, 3.).is_err());
        bad = raw.clone();
        bad["downbeats"] = json!([4, 0]);
        assert!(grid_from_detection(&bad, 3.).is_err());
        assert!(
            grid_from_detection(
                &json!({"detVersion":version(),"ok":false,"error":"fixture failure"}),
                3.
            )
            .unwrap_err()
            .to_string()
            .contains("fixture failure")
        );
        assert!(
            grid_from_detection(
                &json!({"detVersion":version(),"ok":false,"beatsSec":[]}),
                3.
            )
            .unwrap()
            .is_none()
        );
        assert!(
            grid_from_detection(
                &json!({"detVersion":version(),"ok":false,"beatsSec":[0.,0.5]}),
                3.
            )
            .is_err()
        );
        assert!(
            grid_from_detection(&json!({"detVersion":version(),"ok":true,"beatsSec":[]}), 3.)
                .unwrap()
                .is_none()
        );
    }
    #[test]
    fn ml_tokens_validate_frame_probabilities_and_timing() {
        let raw = json!({"fps":50,"beats":[0.5,1.],"downbeats":[0.5],"beat_prob":[0.,0.5,1.],"downbeat_prob":[0.,0.1,0.2]});
        let tokens = String::from_utf8(ml_tokens(&raw, 2.).unwrap()).unwrap();
        assert!(tokens.contains("beatProb 3 0 0.5 1\n"));
        let mut bad = raw.clone();
        bad["downbeat_prob"] = json!([0.]);
        assert!(ml_tokens(&bad, 2.).is_err());
        bad = raw.clone();
        bad["beat_prob"] = json!([0., -1., 0.]);
        assert!(ml_tokens(&bad, 2.).is_err());
        bad = raw.clone();
        bad["beats"] = json!([1., 0.5]);
        assert!(ml_tokens(&bad, 2.).is_err());
    }
    #[test]
    fn model_notices_do_not_replace_the_last_json_record() {
        assert_eq!(
            ml_record(b"Using CPU\n{\"fps\":50}\nDone\n").unwrap()["fps"],
            50
        );
        assert!(ml_record(b"Using CPU\n").is_err());
    }
    #[test]
    fn input_capture_and_job_guard_refuse_changed_sources() {
        let scratch = Scratch::new().unwrap();
        let drums = scratch.0.join("drums.wav");
        fs::write(&drums, b"fixture").unwrap();
        let input = capture(
            vec![(1, drums.clone())],
            10.,
            7,
            9,
            vec![0.],
            vec![(0., 1.)],
        )
        .unwrap();
        assert_eq!((input.epoch, input.revision), (7, 9));
        assert!(input.check(&|| false).is_ok());
        assert!(input.check(&|| true).is_err());
        fs::write(&drums, b"changed fixture length").unwrap();
        assert!(input.check(&|| false).is_err());
        assert!(capture(vec![(0, drums.clone())], 10., 7, 9, vec![], vec![]).is_err());
        assert!(
            capture(
                vec![(1, drums.clone()), (1, drums)],
                10.,
                7,
                9,
                vec![],
                vec![]
            )
            .is_err()
        );
    }
    #[test]
    fn loaded_stamp_fence_rejects_capture_after_a_source_replacement() {
        let scratch = Scratch::new().unwrap();
        let drums = scratch.0.join("drums.wav");
        fs::write(&drums, b"loaded fixture").unwrap();
        let lanes = vec![(1, drums.clone())];
        let loaded = vec![stamp(&drums).unwrap()];
        let accepted = capture(lanes.clone(), 10., 7, 9, vec![], vec![]).unwrap();
        assert!(accepted.verify_loaded(&lanes, &loaded).is_ok());
        assert!(accepted.verify_loaded(&lanes, &[]).is_err());
        assert!(
            accepted
                .verify_loaded(&[(0, drums.clone())], &loaded)
                .is_err()
        );
        fs::write(&drums, b"replaced between loading and capture").unwrap();
        let newer = capture(lanes.clone(), 10., 7, 9, vec![], vec![]).unwrap();
        assert!(newer.verify_loaded(&lanes, &loaded).is_err());
        assert!(accepted.verify_loaded(&lanes, &loaded).is_err());
    }
    /// Explicit installed-tool evidence, separate from fake protocol/Root tests.
    /// The caller owns the selected project and a fresh artifact directory.
    #[test]
    #[ignore = "requires installed native tools and Beat This pack"]
    fn installed_runner_real() -> Result<()> {
        use sha2::{Digest, Sha256};
        let project_path = PathBuf::from(
            std::env::var_os("SINGZ_GPUI_BEAT_REAL_PROJECT")
                .context("Set SINGZ_GPUI_BEAT_REAL_PROJECT for the installed-runner test")?,
        );
        let out = PathBuf::from(
            std::env::var_os("SINGZ_GPUI_BEAT_REAL_OUT")
                .context("Set SINGZ_GPUI_BEAT_REAL_OUT for the installed-runner test")?,
        );
        let duration: f64 = std::env::var("SINGZ_GPUI_BEAT_REAL_DURATION")
            .context("Set SINGZ_GPUI_BEAT_REAL_DURATION in original song seconds")?
            .parse()?;
        ensure!(
            !out.exists(),
            "Real beat evidence destination already exists"
        );
        fs::create_dir_all(&out)?;
        let hash = |path: &Path| -> Result<String> {
            let mut file = File::open(path)?;
            let mut digest = Sha256::new();
            let mut buffer = [0u8; 65_536];
            loop {
                let n = file.read(&mut buffer)?;
                if n == 0 {
                    break;
                }
                digest.update(&buffer[..n]);
            }
            Ok(digest
                .finalize()
                .iter()
                .map(|v| format!("{v:02x}"))
                .collect())
        };
        let project = crate::integration::read_project(&project_path)?;
        let mut lines = vec![];
        let mut words = vec![];
        if let Some(lyrics) = &project.lyrics {
            for line in &lyrics.lines {
                lines.push(line.words.first().map_or(line.start, |w| w.start) as f64);
                words.extend(line.words.iter().map(|w| (w.start as f64, w.end as f64)));
            }
        }
        let inputs = capture(project.lanes.clone(), duration, 701, 901, lines, words)?;
        inputs.verify_loaded(&project.lanes, &project.lane_stamps)?;
        let config = Config::source();
        ensure!(
            pack_available(&config),
            "Installed pack is not Beat This capable"
        );
        let mut artifacts = vec![];
        for env in ["SINGZ_GPUI_ANALYZER", "SINGZ_GPUI_AUDIO_HELPER"] {
            let path = PathBuf::from(
                std::env::var_os(env)
                    .with_context(|| format!("Set {env} to the real installed native tool"))?,
            );
            ensure!(regular(&path), "Installed native tool is missing");
            artifacts.push(serde_json::json!({"kind":env,"path":path,"sha256":hash(&path)?}));
        }
        for source in &inputs.sources {
            artifacts.push(serde_json::json!({"kind":"source","lane":source.lane,"path":source.path,"sha256":hash(&source.path)?,"bytes":source.stamp.0}));
        }
        let python = pack_python(&config);
        artifacts
            .push(serde_json::json!({"kind":"packPython","path":python,"sha256":hash(&python)?}));
        for relative in [
            "python/pack.json",
            "python/beat_runner.py",
            "python/models/beat_this/final0.ckpt",
            "python/models/beat_this/beat_this.onnx",
            "python/models/beat_this/logmel.onnx",
        ] {
            let path = config.pack.join(relative);
            if regular(&path) {
                artifacts.push(
                    serde_json::json!({"kind":"installedPack","path":path,"sha256":hash(&path)?}),
                );
                if relative == "python/pack.json" || relative == "python/beat_runner.py" {
                    fs::copy(
                        &path,
                        out.join(
                            path.file_name()
                                .context("Missing model artifact filename")?,
                        ),
                    )?;
                }
            }
        }
        let manifest = serde_json::json!({"scope":"real installed native analyzer plus installed Beat This model; no GPUI or audio output","version":version(),"duration":duration,"epoch":inputs.epoch,"revision":inputs.revision,"project":project.dir,"projectMetadataHash":project.metadata_hash,"lineCount":inputs.line_starts.len(),"wordCount":inputs.words.len(),"noNode":true,"offlineModel":true,"artifacts":artifacts});
        fs::write(
            out.join("manifest.json"),
            serde_json::to_vec_pretty(&manifest)?,
        )?;
        let progress = Mutex::new(Vec::<f32>::new());
        let result = run_with_progress(&inputs, &|| false, &|p| progress.lock().unwrap().push(p));
        if let Err(error) = &result {
            fs::write(out.join("failure.txt"), format!("{error:#}\n"))?;
        }
        let output = result?;
        inputs.verify_loaded(&project.lanes, &project.lane_stamps)?;
        let grid = output
            .grid
            .as_ref()
            .context("Real detector found no steady beat in the selected fixture")?;
        grid.validate_audio()?;
        ensure!(
            output.used_ml,
            "Installed model was not used: {}",
            output.warnings.join("; ")
        );
        fs::write(
            out.join("result.json"),
            serde_json::to_vec_pretty(
                &serde_json::json!({"version":version(),"epoch":output.epoch,"revision":output.revision,"grid":grid,"warnings":output.warnings,"usedMl":output.used_ml,"progress":*progress.lock().unwrap(),"inputStampsUnchanged":true}),
            )?,
        )?;
        Ok(())
    }
}

#[cfg(test)]
#[path = "beat_custom_sources_tests.rs"]
mod custom_source_tests;

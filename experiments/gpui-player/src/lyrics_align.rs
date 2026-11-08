//! Native, cancellable draft alignment. The same shipped Qwen runtimes and
//! source MMS Python perform inference. This module never writes lyrics.json.
use crate::{
    alignmentoutcome_domain as domain,
    integration::Project,
    lyrics_edit::{Line, Word, distribute_row_words, js_whitespace, trim_text},
    model_catalog::{Config, Flavor},
};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use sha1::Digest as _;
use std::{
    collections::{HashMap, HashSet},
    fs::{self, File, OpenOptions},
    io::{Read, Seek, SeekFrom, Write},
    net::TcpListener,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
const LIMIT: usize = 16 * 1024 * 1024;
const RATE: u64 = 16000;
const FRAME: usize = 800;
const ASR: &str = "Qwen3-ASR-1.7B-Q8_0.gguf";
const MMPROJ: &str = "mmproj-Qwen3-ASR-1.7B-Q8_0.gguf";
const ALIGNER: &str = "qwen3-forced-aligner-0.6b-q8_0.gguf";
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Tier {
    Align,
    Precise,
}
#[derive(Clone, Debug, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct NeedModel {
    pub id: String,
    pub size_mb: u64,
    pub required_files: Vec<String>,
    pub flavor: Flavor,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Capabilities {
    pub can_align: bool,
    pub can_precise: bool,
    pub missing_engines: Vec<String>,
    pub precise_flavor: Flavor,
}
#[derive(Clone, Debug, Serialize)]
pub struct Progress {
    pub stage: String,
    pub percent: f32,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Output {
    pub lines: Vec<Line>,
    pub check: domain::Check,
    pub aligned: bool,
    pub cached_heard: bool,
    pub warnings: Vec<String>,
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Transcription {
    pub lines: Vec<Line>,
    pub cached_heard: bool,
    pub warnings: Vec<String>,
}
#[derive(Debug)]
pub enum Failure {
    Cancelled,
    NeedsModel(Vec<NeedModel>),
    NeedsEngine(Vec<String>),
    Error(String),
}
impl std::fmt::Display for Failure {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        match self {
            Self::Cancelled => write!(f, "Alignment cancelled"),
            Self::NeedsModel(_) => write!(f, "Alignment models are not installed"),
            Self::NeedsEngine(m) => write!(f, "Missing alignment runtime: {}", m.join(", ")),
            Self::Error(e) => f.write_str(e),
        }
    }
}
impl std::error::Error for Failure {}
#[derive(Clone)]
pub struct Inputs {
    root: PathBuf,
    vocals: PathBuf,
    stamp: (u64, SystemTime),
    original: Option<(PathBuf, (u64, SystemTime))>,
    legacy_heard: Option<PathBuf>,
    pub duration: f64,
    pub draft: Vec<Line>,
    pub tier: Tier,
    config: Config,
}
fn stamp(path: &Path) -> Result<(u64, SystemTime)> {
    let m = path.metadata()?;
    ensure!(m.is_file(), "Vocal source is not a regular file");
    Ok((m.len(), m.modified()?))
}
pub fn capture(project: &Project, draft: Vec<Line>, duration: f64, tier: Tier) -> Result<Inputs> {
    capture_inner(project, draft, duration, tier, false)
}
/// Only transcription admits an empty draft; the vocal identity checks are shared.
pub fn capture_transcription(project: &Project, duration: f64) -> Result<Inputs> {
    capture_inner(project, Vec::new(), duration, Tier::Align, true)
}
fn capture_inner(
    project: &Project,
    mut draft: Vec<Line>,
    duration: f64,
    tier: Tier,
    transcription: bool,
) -> Result<Inputs> {
    ensure!(
        duration.is_finite() && duration > 0. && duration <= 43200.,
        "Invalid alignment duration"
    );
    ensure!(
        (transcription || !draft.is_empty()) && draft.len() <= 10000,
        "No lines to align or too many draft rows"
    );
    let root = project.dir.canonicalize()?;
    let vocals = project
        .lanes
        .iter()
        .find(|(i, _)| *i == 0)
        .context("Split the song into vocal stems before aligning lyrics")?
        .1
        .canonicalize()?;
    let before = stamp(&vocals)?;
    ensure!(
        project.vocal_stamp == Some(before),
        "Vocal source changed after project loading"
    );
    let mut words = 0;
    let mut text_bytes = 0;
    for l in &mut draft {
        ensure!(
            l.start.is_finite()
                && l.end.is_finite()
                && l.start >= 0.
                && l.end >= l.start
                && l.end <= duration + 2.,
            "Invalid draft line timing"
        );
        l.text = trim_text(&l.text).into();
        text_bytes += l.text.len();
        for w in &mut l.words {
            w.w = trim_text(&w.w).into();
            text_bytes += w.w.len();
            ensure!(
                w.w.chars().count() <= 1024,
                "A word exceeds the alignment text budget"
            );
            ensure!(
                w.s.is_finite()
                    && w.e.is_finite()
                    && w.s >= 0.
                    && w.e >= w.s
                    && w.e <= duration + 2.,
                "Invalid draft word timing"
            );
        }
        l.words.retain(|w| !w.w.is_empty());
        if l.words.is_empty() && !l.text.is_empty() {
            l.words = distribute_row_words(&l.text, l.start, l.end);
        }
        words += l.words.len();
    }
    ensure!(
        words <= 100000 && text_bytes <= 4 * 1024 * 1024,
        "Draft is too large for alignment"
    );
    draft.retain(|l| !l.text.is_empty());
    ensure!(transcription || !draft.is_empty(), "No lines to align");
    draft.sort_by(|a, b| a.start.total_cmp(&b.start));
    let original = project.raw["songFile"].as_str().and_then(|name| {
        let path = root.join(name).canonicalize().ok()?;
        if !path.starts_with(&root) {
            return None;
        }
        let stamp = stamp(&path).ok()?;
        Some((path, stamp))
    });
    Ok(Inputs {
        root,
        vocals,
        stamp: before,
        original,
        legacy_heard: None,
        duration,
        draft,
        tier,
        config: Config::source(),
    })
}
impl Inputs {
    fn check(&self, cancel: &impl Fn() -> bool) -> Result<()> {
        ensure!(!cancel(), "Alignment cancelled");
        ensure!(
            stamp(&self.vocals)? == self.stamp,
            "Vocal source changed during alignment"
        );
        if let Some((path, expected)) = &self.original {
            ensure!(
                stamp(path)? == *expected,
                "Original song changed during alignment"
            );
        }
        Ok(())
    }
}
fn regular(path: &Path) -> bool {
    path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0)
}
fn bounded_read(path: &Path, limit: usize) -> Result<Vec<u8>> {
    ensure!(
        fs::symlink_metadata(path)?.file_type().is_file(),
        "Alignment file is not an ordinary file"
    );
    let file = File::open(path)?;
    let meta = file.metadata()?;
    ensure!(
        meta.is_file() && meta.len() <= limit as u64,
        "Alignment file exceeds its read budget"
    );
    let mut bytes = Vec::new();
    file.take(limit as u64 + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() <= limit,
        "Alignment file grew beyond its read budget"
    );
    Ok(bytes)
}
fn python(config: &Config) -> PathBuf {
    config.pack.join(if cfg!(windows) {
        "python/python.exe"
    } else {
        "python/bin/python3"
    })
}
fn precise_flavor(config: &Config) -> Flavor {
    let raw = bounded_read(&config.pack.join("python/pack.json"), 65536)
        .ok()
        .filter(|b| b.len() <= 65536)
        .and_then(|b| serde_json::from_slice::<Value>(&b).ok());
    if config.flavor == Flavor::AppleSilicon && raw.is_some_and(|v| v["target"] == "darwin-x64") {
        Flavor::IntelMac
    } else {
        config.flavor
    }
}
fn resolve_engine(env: &str, name: &str) -> Option<PathBuf> {
    if let Some(path) = std::env::var_os(env).map(PathBuf::from) {
        return regular(&path).then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    let file = if cfg!(windows) {
        format!("{name}.exe")
    } else {
        name.into()
    };
    let platform = if cfg!(windows) {
        "win32"
    } else if cfg!(target_os = "macos") {
        "darwin"
    } else {
        "linux"
    };
    let arch = if cfg!(target_arch = "aarch64") {
        "arm64"
    } else {
        "x64"
    };
    let mut candidates = vec![
        dir.join(&file),
        dir.join("engines").join(&file),
        dir.join("../Resources/engines").join(&file),
        PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../vendor")
            .join(format!("{platform}-{arch}"))
            .join(&file),
    ];
    if cfg!(target_os = "macos") {
        candidates
            .push(PathBuf::from("/Applications/SingZ.app/Contents/Resources/engines").join(&file));
    }
    candidates.into_iter().find(|p| regular(p))
}
fn capability_for(config: &Config) -> Capabilities {
    let mut missing = vec![];
    if resolve_engine("SINGZ_LLAMA_SERVER", "llama-server").is_none() {
        missing.push("llama-server".into());
    }
    if resolve_engine("SINGZ_CRISPASR", "crispasr").is_none() {
        missing.push("crispasr".into());
    }
    Capabilities {
        can_align: missing.is_empty(),
        can_precise: regular(&python(config)),
        missing_engines: missing,
        precise_flavor: precise_flavor(config),
    }
}
pub fn capability() -> Capabilities {
    capability_for(&Config::source())
}
fn needed(config: &Config, tier: Tier) -> Vec<NeedModel> {
    let flavor = if tier == Tier::Precise {
        if precise_flavor(config) == Flavor::Linux {
            Flavor::AppleSilicon
        } else {
            precise_flavor(config)
        }
    } else {
        config.flavor
    };
    let id = if tier == Tier::Precise {
        "aligner"
    } else {
        "qwen-asr"
    };
    let entries = crate::model_catalog::registry(flavor, "unused");
    let Some(entry) = entries.iter().find(|e| e.id == id) else {
        return vec![];
    };
    let missing: Vec<_> = entry
        .parts
        .iter()
        .filter(|p| !crate::model_install::valid_part(&config.models.join(&p.file), p))
        .collect();
    if missing.is_empty() {
        vec![]
    } else {
        vec![NeedModel {
            id: id.into(),
            size_mb: missing.iter().map(|p| p.mb).sum(),
            required_files: missing
                .iter()
                .map(|p| p.file.to_string_lossy().into_owned())
                .collect(),
            flavor,
        }]
    }
}
pub fn needs_models(tier: Tier) -> Vec<NeedModel> {
    needed(&Config::source(), tier)
}
fn report(progress: &impl Fn(Progress), stage: &str, percent: f32) {
    progress(Progress {
        stage: stage.into(),
        percent: percent.clamp(0., 100.),
    });
}
pub fn run(
    input: &Inputs,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> std::result::Result<Output, Failure> {
    preflight(input, cancel)?;
    let result = run_inner(input, cancel, progress);
    match result {
        Ok(v) => Ok(v),
        Err(_) if cancel() => Err(Failure::Cancelled),
        Err(e) => Err(Failure::Error(format!("{e:#}"))),
    }
}
fn preflight(input: &Inputs, cancel: &impl Fn() -> bool) -> std::result::Result<(), Failure> {
    if cancel() {
        return Err(Failure::Cancelled);
    }
    let caps = capability_for(&input.config);
    if input.tier == Tier::Align && !caps.can_align {
        return Err(Failure::NeedsEngine(caps.missing_engines));
    }
    if input.tier == Tier::Precise && !caps.can_precise {
        return Err(Failure::NeedsEngine(vec!["stem splitter Python".into()]));
    }
    let missing = needed(&input.config, input.tier);
    if !missing.is_empty() {
        return Err(Failure::NeedsModel(missing));
    }
    Ok(())
}
/// Hear and time the vocal stem, without publishing lyrics.json. Unlike draft
/// alignment this path accepts no reference text and asks Qwen to infer language.
pub fn transcribe(
    project: &Project,
    duration: f64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> std::result::Result<Transcription, Failure> {
    if cancel() {
        return Err(Failure::Cancelled);
    }
    let input =
        capture_transcription(project, duration).map_err(|e| Failure::Error(format!("{e:#}")))?;
    run_transcription(&input, cancel, progress)
}
fn run_transcription(
    input: &Inputs,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> std::result::Result<Transcription, Failure> {
    preflight(input, cancel)?;
    match transcribe_inner(input, cancel, progress) {
        Ok(output) => Ok(output),
        Err(_) if cancel() => Err(Failure::Cancelled),
        Err(error) => Err(Failure::Error(format!("{error:#}"))),
    }
}
fn transcribe_inner(
    input: &Inputs,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<Transcription> {
    input.check(cancel)?;
    report(progress, "preparing", 0.);
    let mut work = input.clone();
    work.legacy_heard = legacy_heard_path(input, cancel)?;
    let scratch = Scratch::new()?;
    let (pcm, frames) = prepare_pcm(&work, &scratch, cancel)?;
    let (env, p90) = level_envelope(&pcm, frames, cancel)?;
    let chunks = plan_chunks(&env, p90);
    ensure!(!chunks.is_empty(), "No words detected in the vocal stem");
    let mut warnings = vec![];
    let (texts, cached_heard) = hear_chunks(
        &work,
        &scratch,
        &pcm,
        frames,
        &chunks,
        None,
        70.,
        &mut warnings,
        cancel,
        progress,
    )?;
    work.draft = domain::lines_from_chunks(&texts);
    ensure!(
        !work.draft.is_empty(),
        "No words detected in the vocal stem"
    );
    // The source first tries an already installed CTC model; it never prompts
    // for an optional aligner merely to time newly transcribed words.
    let has_precise =
        regular(&python(&work.config)) && needed(&work.config, Tier::Precise).is_empty();
    let lines = time_transcription(
        &work.draft,
        work.duration,
        cancel,
        has_precise.then_some(|| {
            precise_ctc(&work, &scratch, &pcm, frames, cancel, &|p| {
                report(progress, &p.stage, 70. + p.percent * 0.3)
            })
        }),
        || {
            work.check(cancel)?;
            let flat = flat_words(&work.draft);
            let assigned = chunk_of_each_word(&work.draft, &chunks);
            let runtime =
                resolve_engine("SINGZ_CRISPASR", "crispasr").context("Word aligner is missing")?;
            let mut warnings = vec![];
            let placed = place_chunks(
                &work,
                &scratch,
                &pcm,
                frames,
                &chunks,
                &flat,
                &assigned,
                &HashSet::new(),
                domain::guess_language(&work.draft),
                70.,
                30.,
                &runtime,
                &mut warnings,
                cancel,
                progress,
            )?;
            Ok((placed, warnings))
        },
        &mut warnings,
    )?;
    work.check(cancel)?;
    report(progress, "transcribing", 100.);
    Ok(Transcription {
        lines,
        cached_heard,
        warnings,
    })
}
fn flat_words(lines: &[Line]) -> Vec<(usize, usize, String)> {
    lines
        .iter()
        .enumerate()
        .flat_map(|(li, line)| {
            line.words
                .iter()
                .enumerate()
                .map(move |(wi, word)| (li, wi, word.w.clone()))
        })
        .collect()
}
/// Source chunkOfEachWord: preserve the known provenance of each transcribed
/// word instead of matching the provisional transcript against itself.
fn chunk_of_each_word(lines: &[Line], chunks: &[Chunk]) -> Vec<usize> {
    lines
        .iter()
        .flat_map(|l| l.words.iter())
        .map(|word| {
            chunks
                .partition_point(|chunk| chunk.start <= word.s + 1e-6)
                .saturating_sub(1)
        })
        .collect()
}
fn time_transcription<C, F>(
    reference: &[Line],
    duration: f64,
    cancel: &impl Fn() -> bool,
    precise: Option<C>,
    force: F,
    warnings: &mut Vec<String>,
) -> Result<Vec<Line>>
where
    C: FnOnce() -> Result<domain::Outcome>,
    F: FnOnce() -> Result<(Vec<domain::Anchor>, Vec<String>)>,
{
    ensure!(!cancel(), "Alignment cancelled");
    if let Some(precise) = precise {
        let outcome = precise();
        // Cancellation is authoritative even when the runtime returned an
        // error or an unusable outcome; never start a fallback after Cancel.
        ensure!(!cancel(), "Alignment cancelled");
        match outcome {
            Ok(outcome) if outcome.check.verdict != "mismatch" => return Ok(outcome.lines),
            Ok(_) => warnings
                .push("Precise timing was unusable; timing transcribed words with Qwen".into()),
            Err(error) => warnings.push(format!(
                "Precise timing failed; timing transcribed words with Qwen: {error:#}"
            )),
        }
    }
    ensure!(!cancel(), "Alignment cancelled");
    let (placed, chunk_warnings) = force()?;
    warnings.extend(chunk_warnings);
    ensure!(!cancel(), "Alignment cancelled");
    ensure!(
        !placed.is_empty(),
        "Could not time the transcribed words against the vocals"
    );
    let lines = domain::retime(reference, &placed, duration);
    ensure!(!cancel(), "Alignment cancelled");
    Ok(lines)
}
static TEMP: AtomicU64 = AtomicU64::new(0);
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        for _ in 0..32 {
            let path = std::env::temp_dir().join(format!(
                "singz-lyrics-align-{}-{}-{}",
                std::process::id(),
                SystemTime::now()
                    .duration_since(SystemTime::UNIX_EPOCH)?
                    .as_nanos(),
                TEMP.fetch_add(1, Ordering::Relaxed)
            ));
            let mut d = fs::DirBuilder::new();
            #[cfg(unix)]
            {
                use std::os::unix::fs::DirBuilderExt;
                d.mode(0o700);
            }
            match d.create(&path) {
                Ok(()) => return Ok(Self(path)),
                Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => continue,
                Err(e) => return Err(e.into()),
            }
        }
        anyhow::bail!("Cannot create private alignment workspace")
    }
    fn write(&self, name: &str, bytes: &[u8]) -> Result<PathBuf> {
        let path = self.0.join(name);
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let mut f = opts.open(&path)?;
        f.write_all(bytes)?;
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
    stdout: Arc<Mutex<Vec<u8>>>,
    stderr: Arc<Mutex<Vec<u8>>>,
    overflow: Arc<AtomicBool>,
    readers: Vec<thread::JoinHandle<()>>,
    tree_stopped: bool,
    #[cfg(windows)]
    job: Option<windows_job::Job>,
}
impl Running {
    fn spawn(mut cmd: Command, tail_only: bool) -> Result<Self> {
        cmd.stdin(Stdio::null())
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
            cmd.creation_flags(0x08000000 | 0x00000200);
        }
        #[cfg(windows)]
        let job = windows_job::Job::new()?;
        let mut child = cmd.spawn().context("Cannot start alignment runtime")?;
        #[cfg(windows)]
        if let Err(error) = job.attach(&child) {
            let _ = child.kill();
            let _ = child.wait();
            return Err(error);
        }
        let stdout = Arc::new(Mutex::new(vec![]));
        let stderr = Arc::new(Mutex::new(vec![]));
        let overflow = Arc::new(AtomicBool::new(false));
        let mut readers = vec![];
        for (mut pipe, bytes, tail) in [
            (
                Box::new(child.stdout.take().context("Missing child stdout")?)
                    as Box<dyn Read + Send>,
                stdout.clone(),
                tail_only,
            ),
            (
                Box::new(child.stderr.take().context("Missing child stderr")?)
                    as Box<dyn Read + Send>,
                stderr.clone(),
                true,
            ),
        ] {
            let overflow = overflow.clone();
            readers.push(thread::spawn(move || {
                let mut block = [0u8; 8192];
                loop {
                    match pipe.read(&mut block) {
                        Ok(0) | Err(_) => break,
                        Ok(n) => {
                            let mut output = bytes.lock().unwrap_or_else(|e| e.into_inner());
                            if !tail && output.len() + n > LIMIT {
                                overflow.store(true, Ordering::Release);
                                break;
                            }
                            output.extend_from_slice(&block[..n]);
                            if tail && output.len() > 65536 {
                                let keep = output.len() - 65536;
                                output.drain(..keep);
                            }
                        }
                    }
                }
            }));
        }
        Ok(Self {
            child,
            stdout,
            stderr,
            overflow,
            readers,
            tree_stopped: false,
            #[cfg(windows)]
            job: Some(job),
        })
    }
    fn stop_tree(&mut self) {
        if self.tree_stopped {
            return;
        }
        self.tree_stopped = true;
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
            drop(self.job.take());
        }
        let _ = self.child.kill();
    }
    fn tail(&self) -> String {
        let b = self.stderr.lock().unwrap_or_else(|e| e.into_inner());
        let t = String::from_utf8_lossy(&b);
        t.chars()
            .rev()
            .take(2000)
            .collect::<String>()
            .chars()
            .rev()
            .collect()
    }
    fn progress(&self) -> Option<f32> {
        let text = self.tail().replace("\\n", "\n");
        text.lines()
            .filter_map(|s| s.strip_prefix("P ")?.trim().parse::<f32>().ok())
            .filter(|v| v.is_finite())
            .last()
    }
}
impl Drop for Running {
    fn drop(&mut self) {
        self.stop_tree();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}

fn command(
    cmd: Command,
    timeout: Duration,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(f32),
) -> Result<Vec<u8>> {
    ensure!(!cancel(), "Alignment cancelled");
    let mut task = Running::spawn(cmd, false)?;
    let deadline = Instant::now() + timeout;
    let mut last = None;
    loop {
        ensure!(!cancel(), "Alignment cancelled");
        ensure!(
            !task.overflow.load(Ordering::Acquire),
            "Alignment runtime output is too large"
        );
        if let Some(p) = task.progress().map(|p| p.clamp(0., 99.)) {
            if last != Some(p) {
                progress(p);
                last = Some(p);
            }
        }
        if let Some(status) = task.child.try_wait()? {
            ensure!(
                status.success(),
                "Alignment runtime failed ({status}): {}",
                task.tail()
            );
            break;
        }
        ensure!(
            Instant::now() < deadline,
            "Alignment runtime timed out: {}",
            task.tail()
        );
        thread::sleep(Duration::from_millis(20));
    }
    // Wait/reap before reading; reader completion is bounded by dropping the
    // task-owned group (including descendants retaining inherited pipes).
    task.stop_tree();
    for reader in task.readers.drain(..) {
        let _ = reader.join();
    }
    ensure!(
        !task.overflow.load(Ordering::Acquire),
        "Alignment runtime output is too large"
    );
    let bytes = task
        .stdout
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .clone();
    Ok(bytes)
}
fn last_json(bytes: &[u8]) -> Result<Value> {
    ensure!(bytes.len() <= LIMIT, "Alignment JSON is too large");
    std::str::from_utf8(bytes)?
        .lines()
        .rev()
        .find_map(|l| serde_json::from_str(l).ok())
        .context("Alignment runtime returned no JSON result")
}
fn run_inner(
    input: &Inputs,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<Output> {
    input.check(cancel)?;
    report(progress, "preparing", 0.);
    let mut work = input.clone();
    work.legacy_heard = legacy_heard_path(input, cancel)?;
    let input = &work;
    let scratch = Scratch::new()?;
    let (pcm, frames) = prepare_pcm(input, &scratch, cancel)?;
    if input.tier == Tier::Precise {
        return precise(input, &scratch, &pcm, frames, cancel, progress);
    }
    fast(input, &scratch, &pcm, frames, cancel, progress)
}
fn prepare_pcm(
    input: &Inputs,
    scratch: &Scratch,
    cancel: &impl Fn() -> bool,
) -> Result<(PathBuf, u64)> {
    let pcm = scratch.0.join("vocals.f32");
    let helper = std::env::var_os("SINGZ_GPUI_AUDIO_HELPER")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "singz-gpui-audio.exe"
        } else {
            "singz-gpui-audio"
        }));
    let mut cmd = Command::new(helper);
    cmd.arg("--render-lyrics-input")
        .arg(&input.vocals)
        .arg(&pcm);
    let raw = last_json(&command(cmd, Duration::from_secs(180), cancel, &|_| {})?)?;
    ensure!(
        raw["protocol"] == 1
            && raw["ok"] == true
            && raw["sampleRate"] == RATE
            && raw["channels"] == 1,
        "Native lyric input preparation refused"
    );
    let frames = raw["frames"]
        .as_u64()
        .context("Missing native lyric input frames")?;
    ensure!(
        frames > 0 && frames <= RATE * 3600,
        "Native lyric input exceeds the one-hour decode budget"
    );
    let pcm_bytes = frames
        .checked_mul(4)
        .context("Native lyric frame count overflow")?;
    ensure!(
        pcm.metadata()?.len() == pcm_bytes,
        "Invalid native lyric input length"
    );
    ensure!(
        (frames as f64 / RATE as f64 - input.duration).abs() < 2.,
        "Vocal coverage differs from the loaded song"
    );
    input.check(cancel)?;
    Ok((pcm, frames))
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
struct Chunk {
    start: f64,
    end: f64,
}
fn level_envelope(path: &Path, frames: u64, cancel: &impl Fn() -> bool) -> Result<(Vec<f32>, f32)> {
    let mut f = File::open(path)?;
    let count = frames as usize / FRAME;
    let mut env = Vec::with_capacity(count);
    let mut block = [0u8; FRAME * 4];
    for _ in 0..count {
        ensure!(!cancel(), "Alignment cancelled");
        f.read_exact(&mut block)?;
        let mut sum = 0.;
        for b in block.chunks_exact(4) {
            let v = f32::from_le_bytes(b.try_into().unwrap());
            ensure!(v.is_finite(), "Non-finite vocal sample");
            sum += f64::from(v) * f64::from(v);
        }
        env.push((sum / FRAME as f64).sqrt() as f32);
    }
    let mut sorted = env.clone();
    sorted.sort_by(f32::total_cmp);
    let p90 = sorted
        .get((sorted.len() as f64 * 0.9).floor() as usize)
        .copied()
        .unwrap_or(0.);
    Ok((env, p90))
}
fn plan_chunks(env: &[f32], p90: f32) -> Vec<Chunk> {
    if env.is_empty() || p90 <= 0. {
        return vec![];
    }
    let mut runs = vec![];
    let mut k = 0;
    while k < env.len() {
        if f64::from(env[k]) >= f64::from(p90) * 0.05 {
            k += 1;
            continue;
        }
        let mut j = k;
        while j < env.len() && f64::from(env[j]) < f64::from(p90) * 0.05 {
            j += 1;
        }
        runs.push((k, j));
        k = j;
    }
    let mut regions = vec![];
    let mut cur = 0;
    for &(a, b) in &runs {
        if b - a >= 40 {
            if a > cur {
                regions.push((cur, a));
            }
            cur = b;
        }
    }
    if cur < env.len() {
        regions.push((cur, env.len()));
    }
    let mut out = vec![];
    let mut push = |a: usize, b: usize| {
        if (b - a) as f64 / 20. < 1.5 {
            return;
        }
        if env[a..b]
            .iter()
            .filter(|v| f64::from(**v) >= f64::from(p90) * 0.1)
            .count()
            < 4
        {
            return;
        }
        out.push(Chunk {
            start: a as f64 / 20.,
            end: b as f64 / 20.,
        });
    };
    for (mut a, mut b) in regions {
        a = a.saturating_sub(6);
        b = (b + 6).min(env.len());
        while b - a > 600 {
            let lo = a as f64 + 360.;
            let hi = a + 600;
            let best = runs.iter().filter(|r| r.0 as f64 > lo && r.1 < hi).fold(
                None,
                |best: Option<&(usize, usize)>, r| {
                    if best.is_none_or(|b| r.1 - r.0 >= b.1 - b.0) {
                        Some(r)
                    } else {
                        best
                    }
                },
            );
            let cut = best.map_or(hi, |r| (r.0 + r.1) / 2);
            push(a, cut);
            a = cut;
        }
        push(a, b);
    }
    out
}
fn wave_header(bytes: u32, float: bool) -> Vec<u8> {
    let sample_bytes = if float { 4u16 } else { 2 };
    let mut h = vec![];
    h.extend_from_slice(b"RIFF");
    h.extend_from_slice(&(36 + bytes).to_le_bytes());
    h.extend_from_slice(b"WAVEfmt ");
    h.extend_from_slice(&16u32.to_le_bytes());
    h.extend_from_slice(&(if float { 3u16 } else { 1 }).to_le_bytes());
    h.extend_from_slice(&1u16.to_le_bytes());
    h.extend_from_slice(&(RATE as u32).to_le_bytes());
    h.extend_from_slice(&(RATE as u32 * sample_bytes as u32).to_le_bytes());
    h.extend_from_slice(&sample_bytes.to_le_bytes());
    h.extend_from_slice(&(sample_bytes * 8).to_le_bytes());
    h.extend_from_slice(b"data");
    h.extend_from_slice(&bytes.to_le_bytes());
    h
}
fn chunk_wav(path: &Path, frames: u64, chunk: Chunk) -> Result<Vec<u8>> {
    let start = (chunk.start * RATE as f64).floor().max(0.) as u64;
    let end = ((chunk.end * RATE as f64).ceil() as u64).min(frames);
    let n = end.saturating_sub(start);
    ensure!(n <= RATE * 31, "ASR chunk exceeds model window");
    let mut f = File::open(path)?;
    f.seek(SeekFrom::Start(start * 4))?;
    let mut bytes = vec![0; n as usize * 4];
    f.read_exact(&mut bytes)?;
    let mut wav = wave_header(n as u32 * 2, false);
    for b in bytes.chunks_exact(4) {
        let sample = f32::from_le_bytes(b.try_into().unwrap());
        ensure!(sample.is_finite(), "Non-finite vocal sample");
        let sample = (f64::from(sample).clamp(-1., 1.) * 32767. + 0.5).floor() as i16;
        wav.extend_from_slice(&sample.to_le_bytes());
    }
    Ok(wav)
}
fn float_wav(pcm: &Path, out: &Path, frames: u64) -> Result<()> {
    let byte_count = frames
        .checked_mul(4)
        .context("Vocal frame count overflow")?;
    ensure!(byte_count <= u32::MAX as u64 - 36, "Vocal WAV is too large");
    let mut f = OpenOptions::new().write(true).create_new(true).open(out)?;
    f.write_all(&wave_header(byte_count as u32, true))?;
    std::io::copy(&mut File::open(pcm)?, &mut f)?;
    Ok(())
}
fn b64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (chunk[0] as u32) << 16
            | ((chunk.get(1).copied().unwrap_or(0) as u32) << 8)
            | chunk.get(2).copied().unwrap_or(0) as u32;
        for shift in [18, 12] {
            out.push(TABLE[((n >> shift) & 63) as usize] as char);
        }
        out.push(if chunk.len() > 1 {
            TABLE[((n >> 6) & 63) as usize] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[(n & 63) as usize] as char
        } else {
            '='
        });
    }
    out
}
fn curl(url: &str, data: Option<&Path>, cancel: &impl Fn() -> bool) -> Result<Vec<u8>> {
    let mut cmd = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    cmd.args([
        "--fail",
        "--silent",
        "--show-error",
        "--noproxy",
        "*",
        "--connect-timeout",
        "2",
        "--max-time",
        if data.is_some() { "600" } else { "2" },
    ]);
    if let Some(data) = data {
        cmd.args(["-H", "Content-Type: application/json", "--data-binary"])
            .arg(format!("@{}", data.to_string_lossy()));
    }
    cmd.arg(url);
    command(
        cmd,
        Duration::from_secs(if data.is_some() { 610 } else { 4 }),
        cancel,
        &|_| {},
    )
}
struct Server {
    running: Running,
    port: u16,
}
impl Server {
    fn start(input: &Inputs, cancel: &impl Fn() -> bool) -> Result<Self> {
        let port = TcpListener::bind(("127.0.0.1", 0))?.local_addr()?.port();
        let exe = resolve_engine("SINGZ_LLAMA_SERVER", "llama-server")
            .context("llama-server is missing")?;
        let mut cmd = Command::new(exe);
        cmd.arg("-m")
            .arg(input.config.models.join(ASR))
            .arg("--mmproj")
            .arg(input.config.models.join(MMPROJ))
            .args([
                "--host",
                "127.0.0.1",
                "--port",
                &port.to_string(),
                "-c",
                "16384",
                "--parallel",
                "1",
                "--no-webui",
            ]);
        let mut server = Self {
            running: Running::spawn(cmd, true)?,
            port,
        };
        let deadline = Instant::now() + Duration::from_secs(180);
        loop {
            input.check(cancel)?;
            if let Some(status) = server.running.child.try_wait()? {
                anyhow::bail!("llama-server stopped ({status}): {}", server.running.tail());
            }
            if curl(&format!("http://127.0.0.1:{port}/health"), None, cancel).is_ok() {
                return Ok(server);
            }
            ensure!(
                Instant::now() < deadline,
                "llama-server did not become ready: {}",
                server.running.tail()
            );
            thread::sleep(Duration::from_millis(100));
        }
    }
    fn ask(
        &self,
        scratch: &Scratch,
        serial: usize,
        wav: &[u8],
        seconds: f64,
        language: Option<&str>,
        cancel: &impl Fn() -> bool,
    ) -> Result<(String, Option<String>, Option<String>)> {
        let mut messages = vec![
            json!({"role":"system","content":""}),
            json!({"role":"user","content":[{"type":"input_audio","input_audio":{"data":b64(wav),"format":"wav"}}]}),
        ];
        if let Some(language) = language {
            messages.push(
                json!({"role":"assistant","content":format!("language {language}<asr_text>")}),
            );
        }
        let request=scratch.write(&format!("request-{serial}.json"),&serde_json::to_vec(&json!({"messages":messages,"temperature":0,"max_tokens":(seconds*8.).ceil()as u64+20,"cache_prompt":false}))?)?;
        let raw: Value = serde_json::from_slice(&curl(
            &format!("http://127.0.0.1:{}/v1/chat/completions", self.port),
            Some(&request),
            cancel,
        )?)?;
        let value = raw["choices"][0]["message"]["content"]
            .as_str()
            .unwrap_or("");
        ensure!(
            value.len() <= 1024 * 1024,
            "Speech runtime text exceeds its chunk budget"
        );
        let finish = raw["choices"][0]["finish_reason"]
            .as_str()
            .map(str::to_owned);
        static LANGUAGE: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
        let label = LANGUAGE
            .get_or_init(|| regex::Regex::new(r"language\s+([A-Za-z]+)\s*<asr_text>").unwrap())
            .captures(value)
            .map(|c| c[1].to_owned());
        let text = trim_text(
            value
                .rsplit_once("<asr_text>")
                .map_or(value, |(_, text)| text),
        )
        .to_owned();
        text_word_count(&text)?;
        Ok((text, label, finish))
    }
}
#[derive(Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct HeardStamp {
    size: u64,
    mtime_ms: f64,
}
fn mtime_ms(time: SystemTime) -> f64 {
    time.duration_since(SystemTime::UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs_f64()
        * 1000.
}
fn legacy_heard_path(input: &Inputs, cancel: &impl Fn() -> bool) -> Result<Option<PathBuf>> {
    let Some((path, expected)) = &input.original else {
        return Ok(None);
    };
    ensure!(
        stamp(path)? == *expected,
        "Original song changed before cached-listen lookup"
    );
    let mut f = File::open(path)?;
    let mut hash = sha1::Sha1::new();
    let mut block = [0u8; 512 * 1024];
    loop {
        input.check(cancel)?;
        let n = f.read(&mut block)?;
        if n == 0 {
            break;
        }
        hash.update(&block[..n]);
    }
    input.check(cancel)?;
    let hex = format!("{:x}", hash.finalize());
    Ok(Some(
        crate::audio_devices::directory()
            .join("stems")
            .join(&hex[..16])
            .join("heard-words.json"),
    ))
}
fn text_word_count(text: &str) -> Result<usize> {
    let mut count = 0;
    for word in text.split(js_whitespace).filter(|w| !w.is_empty()) {
        ensure!(
            word.chars().count() <= 1024,
            "A speech word exceeds the saved 1024-scalar limit"
        );
        count += 1;
        ensure!(count <= 100000, "Speech runtime returned too many words");
    }
    Ok(count)
}
fn chunk_text_budget(chunks: &[domain::ChunkText]) -> Result<()> {
    let mut bytes = 0;
    let mut words = 0;
    for c in chunks {
        bytes += c.text.len();
        ensure!(
            bytes <= 4 * 1024 * 1024,
            "Speech result exceeds its text budget"
        );
        words += text_word_count(&c.text)?;
        ensure!(words <= 100000, "Speech runtime returned too many words");
        ensure!(
            c.label.as_ref().is_none_or(|l| l.len() <= 256),
            "Invalid speech language label"
        );
    }
    Ok(())
}
fn read_heard(input: &Inputs, language: Option<Option<&str>>) -> Option<Vec<domain::ChunkText>> {
    std::iter::once(input.root.join("heard-words.json"))
        .chain(input.legacy_heard.clone())
        .find_map(|path| read_heard_path(input, &path, language))
}
fn read_heard_path(
    input: &Inputs,
    path: &Path,
    language: Option<Option<&str>>,
) -> Option<Vec<domain::ChunkText>> {
    if !fs::symlink_metadata(path).ok()?.file_type().is_file() {
        return None;
    }
    let bytes = bounded_read(path, 8 * 1024 * 1024).ok()?;
    let raw: Value = serde_json::from_slice(&bytes).ok()?;
    if raw["version"] != 1
        || raw["engine"] != "qwen3-asr-1.7b"
        || raw["vocals"]["size"].as_u64() != Some(input.stamp.0)
        || (raw["vocals"]["mtimeMs"].as_f64()? - mtime_ms(input.stamp.1)).abs() > 2.
    {
        return None;
    }
    if let Some(language) = language {
        if raw["language"].as_str() != language {
            return None;
        }
    }
    if raw["chunks"].as_array()?.len() > 10000 {
        return None;
    }
    let chunks: Vec<domain::ChunkText> = serde_json::from_value(raw["chunks"].clone()).ok()?;
    if chunks.len() > 10000
        || chunks.iter().any(|c| {
            !c.start.is_finite()
                || !c.end.is_finite()
                || c.start < 0.
                || c.end < c.start
                || c.end > input.duration + 2.
                || c.text.len() > 1024 * 1024
        })
    {
        return None;
    }
    chunk_text_budget(&chunks).ok()?;
    Some(chunks)
}
fn write_heard(
    input: &Inputs,
    language: Option<&str>,
    chunks: &[domain::ChunkText],
    warnings: &mut Vec<String>,
    cancel: &impl Fn() -> bool,
) {
    if let Err(error) = chunk_text_budget(chunks) {
        warnings.push(format!("Heard words were not cached: {error}"));
        return;
    }
    let path = input.root.join("heard-words.json");
    if fs::symlink_metadata(&path).is_ok_and(|m| !m.file_type().is_file()) {
        warnings.push("An unowned heard-word cache path was retained".into());
        return;
    }
    if path.exists() && bounded_read(&path, 8 * 1024 * 1024).is_err() {
        warnings.push("An unreadable heard-word cache was retained".into());
        return;
    }
    if let Ok(bytes) = bounded_read(&path, 8 * 1024 * 1024) {
        if let Ok(raw) = serde_json::from_slice::<Value>(&bytes) {
            if raw["version"].as_u64().is_some_and(|v| v > 1)
                || raw["engine"]
                    .as_str()
                    .is_some_and(|e| e != "qwen3-asr-1.7b")
            {
                warnings.push("A newer heard-word cache was retained".into());
                return;
            }
        } else {
            warnings.push("A corrupt heard-word cache was retained".into());
            return;
        }
    }
    let result = (|| -> Result<()> {
        input.check(cancel)?;
        let tmp = input.root.join(format!(
            ".heard-words-{}-{}.part",
            std::process::id(),
            TEMP.fetch_add(1, Ordering::Relaxed)
        ));
        let bytes = serde_json::to_vec(
            &json!({"version":1,"engine":"qwen3-asr-1.7b","language":language,"vocals":HeardStamp{size:input.stamp.0,mtime_ms:mtime_ms(input.stamp.1)},"chunks":chunks}),
        )?;
        ensure!(
            bytes.len() <= 8 * 1024 * 1024,
            "Heard-word cache exceeds its storage budget"
        );
        let mut opts = OpenOptions::new();
        opts.write(true).create_new(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            opts.mode(0o600);
        }
        let result = (|| -> Result<()> {
            let mut f = opts.open(&tmp)?;
            f.write_all(&bytes)?;
            f.sync_all()?;
            drop(f);
            input.check(cancel)?;
            fs::rename(&tmp, &path)?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result
    })();
    if let Err(e) = result {
        warnings.push(format!("Could not retain heard words: {e:#}"));
    }
}
fn qwen_language(code: Option<&str>) -> Option<&'static str> {
    match code {
        Some("en") => Some("English"),
        Some("de") => Some("German"),
        Some("ru") => Some("Russian"),
        Some("fr") => Some("French"),
        Some("es") => Some("Spanish"),
        Some("it") => Some("Italian"),
        _ => None,
    }
}
fn hear_chunks(
    input: &Inputs,
    scratch: &Scratch,
    pcm: &Path,
    frames: u64,
    chunks: &[Chunk],
    language: Option<&str>,
    end: f32,
    warnings: &mut Vec<String>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<(Vec<domain::ChunkText>, bool)> {
    let cache = read_heard(input, Some(language));
    let cached_heard = cache.as_ref().is_some_and(|v| {
        v.len() == chunks.len()
            && v.iter()
                .zip(chunks)
                .all(|(c, w)| (c.start - w.start).abs() < 1e-3)
    });
    let texts = if cached_heard {
        report(progress, "transcribing", end);
        cache.unwrap()
    } else {
        let server = Server::start(input, cancel)?;
        let mut texts = vec![];
        let mut serial = 0;
        for (i, chunk) in chunks.iter().enumerate() {
            input.check(cancel)?;
            let wav = chunk_wav(pcm, frames, *chunk)?;
            let (text, label, finish) =
                server.ask(scratch, serial, &wav, chunk.end - chunk.start, None, cancel)?;
            serial += 1;
            let text = if label.as_deref() == Some("None")
                || domain::looks_looped(&text, finish.as_deref())
            {
                String::new()
            } else {
                text
            };
            texts.push(domain::ChunkText {
                start: chunk.start,
                end: chunk.end,
                text,
                label,
            });
            ensure!(
                texts.iter().map(|c| c.text.len()).sum::<usize>() <= 4 * 1024 * 1024,
                "Speech result exceeds its text budget"
            );
            report(
                progress,
                "transcribing",
                (i + 1) as f32 / chunks.len() as f32 * (end / 2.),
            );
        }
        let want = language
            .map(str::to_owned)
            .or_else(|| domain::majority_language(&texts));
        let retry: Vec<_> = texts
            .iter()
            .enumerate()
            .filter(|(_, c)| {
                c.label
                    .as_deref()
                    .is_some_and(|l| l != "None" && Some(l) != want.as_deref())
            })
            .map(|(i, _)| i)
            .collect();
        if let Some(want) = want {
            for (n, i) in retry.iter().copied().enumerate() {
                input.check(cancel)?;
                let chunk = chunks[i];
                let wav = chunk_wav(pcm, frames, chunk)?;
                let (text, _, finish) = server.ask(
                    scratch,
                    serial,
                    &wav,
                    chunk.end - chunk.start,
                    Some(&want),
                    cancel,
                )?;
                serial += 1;
                if !domain::looks_looped(&text, finish.as_deref()) {
                    texts[i].text = text;
                    ensure!(
                        texts.iter().map(|c| c.text.len()).sum::<usize>() <= 4 * 1024 * 1024,
                        "Speech result exceeds its text budget"
                    );
                }
                report(
                    progress,
                    "transcribing",
                    (end / 2.) + (n + 1) as f32 / retry.len() as f32 * (end / 2.),
                );
            }
        }
        input.check(cancel)?;
        write_heard(input, language, &texts, warnings, cancel);
        report(progress, "transcribing", end);
        texts
    };
    chunk_text_budget(&texts)?;
    Ok((texts, cached_heard))
}
fn fast(
    input: &Inputs,
    scratch: &Scratch,
    pcm: &Path,
    frames: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<Output> {
    let (env, p90) = level_envelope(pcm, frames, cancel)?;
    let chunks = plan_chunks(&env, p90);
    ensure!(!chunks.is_empty(), "No singing was found in the vocal stem");
    let code = domain::guess_language(&input.draft);
    let language = qwen_language(code);
    let mut warnings = vec![];
    let (texts, cached_heard) = hear_chunks(
        input,
        scratch,
        pcm,
        frames,
        &chunks,
        language,
        60.,
        &mut warnings,
        cancel,
        progress,
    )?;
    chunk_text_budget(&texts)?;
    let heard: Vec<Word> = domain::lines_from_chunks(&texts)
        .into_iter()
        .flat_map(|l| l.words)
        .collect();
    let ref_count = input.draft.iter().map(|l| l.words.len()).sum();
    ensure!(
        domain::transcription_usable(&heard, ref_count),
        "Could not make out enough of the vocals to check these lyrics"
    );
    let judged = domain::align_to_transcription_cancellable(
        &input.draft,
        &heard,
        input.duration,
        "qwen",
        cancel,
    )?;
    if judged.check.verdict == "mismatch" {
        input.check(cancel)?;
        return Ok(Output {
            lines: input.draft.clone(),
            check: judged.check,
            aligned: false,
            cached_heard,
            warnings,
        });
    }
    let hyp = domain::sanitize_hyp(&heard);
    let anchors = domain::global_anchors_cancellable(&input.draft, &hyp, cancel)?;
    let flat = flat_words(&input.draft);
    let index: HashMap<_, _> = flat
        .iter()
        .enumerate()
        .map(|(i, (li, wi, _))| ((*li, *wi), i))
        .collect();
    let mut anchor_chunk = HashMap::new();
    for a in anchors {
        if let Some(&k) = index.get(&(a.li, a.wi)) {
            let ci = chunks
                .iter()
                .enumerate()
                .filter(|(_, c)| c.start <= a.s)
                .map(|(i, _)| i)
                .last()
                .unwrap_or(0);
            anchor_chunk.insert(k, ci);
        }
    }
    let assigned = domain::assign_words_to_chunks(flat.len(), &anchor_chunk);
    let runtime =
        resolve_engine("SINGZ_CRISPASR", "crispasr").context("Word aligner is missing")?;
    let bad_lines: HashSet<_> = judged.check.bad_lines.iter().copied().collect();
    let placed = place_chunks(
        input,
        scratch,
        pcm,
        frames,
        &chunks,
        &flat,
        &assigned,
        &bad_lines,
        code,
        60.,
        40.,
        &runtime,
        &mut warnings,
        cancel,
        progress,
    )?;
    ensure!(
        !placed.is_empty(),
        "Could not time the lyric words against the vocals"
    );
    let lines = domain::retime(&input.draft, &placed, input.duration);
    let timed: HashSet<_> = placed.iter().map(|a| a.li).collect();
    let mut shifts: Vec<_> = lines
        .iter()
        .enumerate()
        .filter(|(i, _)| timed.contains(i))
        .map(|(i, l)| l.start - input.draft[i].start)
        .collect();
    shifts.sort_by(f64::total_cmp);
    let shift = shifts.get(shifts.len() / 2).copied().unwrap_or(0.);
    let mut check = judged.check;
    check.median_shift = (shift * 100. + 0.5).floor() / 100.;
    check.verdict =
        if shift.abs() <= 0.35 && check.bad_lines.is_empty() && check.matched_pct >= 70. {
            "match"
        } else {
            "retimed"
        }
        .into();
    input.check(cancel)?;
    Ok(Output {
        lines,
        check,
        aligned: true,
        cached_heard,
        warnings,
    })
}
fn place_chunks(
    input: &Inputs,
    scratch: &Scratch,
    pcm: &Path,
    frames: u64,
    chunks: &[Chunk],
    flat: &[(usize, usize, String)],
    assigned: &[usize],
    bad_lines: &HashSet<usize>,
    code: Option<&str>,
    offset: f32,
    span: f32,
    runtime: &Path,
    warnings: &mut Vec<String>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<Vec<domain::Anchor>> {
    ensure!(
        assigned.len() == flat.len() && assigned.iter().all(|i| *i < chunks.len()),
        "Invalid word chunk assignment"
    );
    let mut grouped = vec![Vec::new(); chunks.len()];
    for (i, (word, chunk)) in flat.iter().zip(assigned).enumerate() {
        if i % 256 == 0 {
            input.check(cancel)?;
        }
        grouped[*chunk].push(word);
    }
    let mut placed = vec![];
    for (ci, chunk) in chunks.iter().enumerate() {
        input.check(cancel)?;
        let mine = &grouped[ci];
        if mine.is_empty() {
            continue;
        }
        let wav = scratch.write(&format!("chunk-{ci}.wav"), &chunk_wav(pcm, frames, *chunk)?)?;
        let out = scratch.0.join(format!("placed-{ci}.json"));
        let text = mine
            .iter()
            .map(|w| w.2.split(js_whitespace).collect::<String>())
            .collect::<Vec<_>>()
            .join(" ");
        ensure!(
            text.len() <= 64 * 1024,
            "Alignment chunk text exceeds native argument budget"
        );
        let mut cmd = Command::new(runtime);
        cmd.arg("--align-only")
            .arg("-am")
            .arg(input.config.models.join(ALIGNER))
            .arg("-f")
            .arg(&wav)
            .arg("--ref-text")
            .arg(text)
            .arg("-l")
            .arg(code.unwrap_or("en"))
            .args(["--align-format", "json", "--align-output"])
            .arg(&out);
        let result = command(cmd, Duration::from_secs(600), cancel, &|_| {});
        input.check(cancel)?;
        report(
            progress,
            "transcribing",
            offset + (ci + 1) as f32 / chunks.len() as f32 * span,
        );
        if let Err(e) = result {
            warnings.push(format!("Chunk {ci} could not place its words: {e:#}"));
            continue;
        }
        let parsed = bounded_read(&out, LIMIT)
            .ok()
            .filter(|b| b.len() <= LIMIT)
            .and_then(|b| serde_json::from_slice::<Vec<Placed>>(&b).ok());
        let Some(parsed) = parsed.filter(|v| v.len() == mine.len()) else {
            warnings.push(format!("Chunk {ci} returned a different word count"));
            continue;
        };
        for (p, src) in parsed.into_iter().zip(mine) {
            let (s, e) = placement_span(*chunk, p.start, p.end, input.duration)?;
            if bad_lines.contains(&src.0) {
                continue;
            }
            placed.push(domain::Anchor {
                li: src.0,
                wi: src.1,
                s,
                e,
                sim: 1.,
            });
        }
    }
    Ok(placed)
}
fn placement_span(chunk: Chunk, start: f64, end: f64, duration: f64) -> Result<(f64, f64)> {
    let limit = chunk.end - chunk.start + 2.;
    let effective_end = end.max(start + 0.05);
    let absolute_start = chunk.start + start;
    let absolute_end = chunk.start + effective_end;
    ensure!(
        start.is_finite()
            && end.is_finite()
            && start >= 0.
            && end >= 0.
            && start <= limit
            && end <= limit
            && effective_end.is_finite()
            && effective_end <= limit
            && absolute_start.is_finite()
            && absolute_end.is_finite()
            && absolute_start >= 0.
            && absolute_end <= duration + 2.,
        "Word aligner returned invalid or out-of-window timing"
    );
    Ok((absolute_start, absolute_end))
}
#[derive(Deserialize)]
struct Placed {
    start: f64,
    end: f64,
}
fn source_script(onnx: bool) -> Result<&'static str> {
    let source = include_str!("../../../src/main/align-mms.ts");
    let prefix = if onnx {
        "const ALIGN_ONNX_PY = String.raw`"
    } else {
        "const ALIGN_PY = String.raw`"
    };
    source
        .split_once(prefix)
        .and_then(|(_, s)| s.split_once("\n`\n").map(|(script, _)| script))
        .context("Embedded source MMS script is missing")
}
fn precise_ctc(
    input: &Inputs,
    scratch: &Scratch,
    pcm: &Path,
    frames: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<domain::Outcome> {
    let flat: Vec<_> = input
        .draft
        .iter()
        .enumerate()
        .flat_map(|(li, l)| {
            l.words
                .iter()
                .enumerate()
                .map(move |(wi, w)| (li, wi, domain::romanize(&w.w)))
        })
        .collect();
    let tokens: Vec<_> = flat
        .iter()
        .enumerate()
        .map(|(i, (li, _, t))| json!({"i":i,"t":t,"l":li}))
        .collect();
    let token_file = scratch.write("tokens.json", &serde_json::to_vec(&tokens)?)?;
    let wav = scratch.0.join("vocals.wav");
    float_wav(pcm, &wav, frames)?;
    let flavor = precise_flavor(&input.config);
    let onnx = matches!(flavor, Flavor::IntelMac | Flavor::Windows);
    let script = scratch.write("align.py", source_script(onnx)?.as_bytes())?;
    let mut cmd = Command::new(python(&input.config));
    cmd.arg(&script).arg(&wav).arg(&token_file);
    if onnx {
        cmd.arg(input.config.models.join("mms-fa.onnx"));
    }
    cmd.env("PYTHONUNBUFFERED", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("PYTHONUTF8", "1")
        .env("TORCH_HOME", input.config.models.join("torch-home"))
        .env("HF_HUB_OFFLINE", "1")
        .env("HF_DATASETS_OFFLINE", "1");
    report(progress, "transcribing", 0.);
    let raw = last_json(&command(cmd, Duration::from_secs(1800), cancel, &|p| {
        report(progress, "transcribing", p)
    })?)?;
    if let Some(error) = raw["error"].as_str() {
        anyhow::bail!(
            "Precise alignment failed: {}",
            error.chars().take(1000).collect::<String>()
        );
    }
    let words = raw["words"]
        .as_array()
        .context("Precise aligner returned no words")?;
    ensure!(
        words.len() <= flat.len(),
        "Precise aligner returned too many words"
    );
    let mut ctc = vec![];
    let mut seen = HashSet::new();
    let mut previous_index = None;
    for w in words {
        let i = w["i"].as_u64().context("Invalid precise word index")? as usize;
        let (src_li, src_wi, _) = flat.get(i).context("Precise word index leaves draft")?;
        ensure!(
            seen.insert(i) && previous_index.is_none_or(|old| i > old),
            "Duplicate or unordered precise word index"
        );
        previous_index = Some(i);
        let s = w["s"].as_f64().context("Invalid precise start")?;
        let e = w["e"].as_f64().context("Invalid precise end")?;
        let score = w["score"].as_f64().context("Invalid precise score")?;
        let voiced = w
            .get("v")
            .map(|v| v.as_f64().context("Invalid precise vocal level"))
            .transpose()?;
        ensure!(
            s.is_finite()
                && e.is_finite()
                && s >= 0.
                && e >= s
                && e <= input.duration + 2.
                && score.is_finite()
                && score >= 0.
                && voiced.is_none_or(|v| v.is_finite() && v >= 0.),
            "Invalid precise alignment result"
        );
        ctc.push(domain::CtcWord {
            li: *src_li,
            wi: *src_wi,
            s,
            e,
            score,
            voiced,
        });
    }
    let outcome = domain::ctc_outcome_cancellable(&input.draft, &ctc, input.duration, cancel)?;
    input.check(cancel)?;
    Ok(outcome)
}
fn precise(
    input: &Inputs,
    scratch: &Scratch,
    pcm: &Path,
    frames: u64,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(Progress),
) -> Result<Output> {
    let flat_count = input.draft.iter().map(|l| l.words.len()).sum();
    let mut outcome = precise_ctc(input, scratch, pcm, frames, cancel, progress)?;
    let heard = read_heard(input, None)
        .map(|c| {
            domain::lines_from_chunks(&c)
                .into_iter()
                .flat_map(|l| l.words)
                .collect::<Vec<_>>()
        })
        .unwrap_or_default();
    if !heard.is_empty()
        && domain::transcription_usable(&heard, flat_count)
        && outcome.check.verdict != "mismatch"
    {
        let mut check = domain::align_to_transcription_cancellable(
            &input.draft,
            &heard,
            input.duration,
            "qwen",
            cancel,
        )?
        .check;
        check.method = "ctc".into();
        check.median_shift = outcome.check.median_shift;
        outcome.check = check;
    }
    let aligned = outcome.check.verdict != "mismatch";
    let warnings = if outcome.slipped.is_empty() {
        vec![]
    } else {
        vec![format!(
            "Precise alignment interpolated slipped lines: {:?}",
            outcome.slipped
        )]
    };
    input.check(cancel)?;
    report(progress, "transcribing", 100.);
    Ok(Output {
        lines: if aligned {
            outcome.lines
        } else {
            input.draft.clone()
        },
        check: outcome.check,
        aligned,
        cached_heard: !heard.is_empty(),
        warnings,
    })
}

#[cfg(test)]
#[path = "lyrics_align_tests.rs"]
mod tests;

// A job handle retains child-tree identity even after the parent exits. Closing
// it retires descendants before pipe-reader joins. See Microsoft's Job Objects
// and JOBOBJECT_EXTENDED_LIMIT_INFORMATION contracts.
#[cfg(windows)]
mod windows_job {
    use super::*;
    use std::{ffi::c_void, os::windows::io::AsRawHandle};
    #[repr(C)]
    #[derive(Default)]
    struct Basic {
        process_time: i64,
        job_time: i64,
        flags: u32,
        min_ws: usize,
        max_ws: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Io {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    #[derive(Default)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: *const c_void, name: *const u16) -> *mut c_void;
        fn SetInformationJobObject(
            job: *mut c_void,
            class: i32,
            info: *const c_void,
            len: u32,
        ) -> i32;
        fn AssignProcessToJobObject(job: *mut c_void, process: *mut c_void) -> i32;
        fn CloseHandle(handle: *mut c_void) -> i32;
    }
    pub struct Job(*mut c_void);
    impl Job {
        pub fn new() -> Result<Self> {
            let handle = unsafe { CreateJobObjectW(std::ptr::null(), std::ptr::null()) };
            ensure!(
                !handle.is_null(),
                "Cannot create alignment process job: {}",
                std::io::Error::last_os_error()
            );
            let job = Self(handle);
            let mut limit = Extended::default();
            limit.basic.flags = 0x2000;
            ensure!(
                unsafe {
                    SetInformationJobObject(
                        handle,
                        9,
                        (&limit as *const Extended).cast(),
                        std::mem::size_of::<Extended>() as u32,
                    )
                } != 0,
                "Cannot fence alignment process job: {}",
                std::io::Error::last_os_error()
            );
            Ok(job)
        }
        pub fn attach(&self, child: &Child) -> Result<()> {
            ensure!(
                unsafe { AssignProcessToJobObject(self.0, child.as_raw_handle().cast()) } != 0,
                "Cannot attach alignment child to its job: {}",
                std::io::Error::last_os_error()
            );
            Ok(())
        }
    }
    impl Drop for Job {
        fn drop(&mut self) {
            unsafe {
                CloseHandle(self.0);
            }
        }
    }
}

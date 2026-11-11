//! Native input/monitor process owner. Scalar telemetry only; no PCM or DSP in Rust.
use anyhow::{bail, ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    collections::VecDeque,
    fs,
    io::{BufRead, BufReader, Read, Write},
    path::Path,
    path::PathBuf,
    process::{Child, ChildStdin, Command, Stdio},
    sync::{
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc::{self, Receiver, SyncSender},
        Arc, Mutex,
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Clone, Debug, PartialEq)]
pub struct Prefs {
    pub input: String,
    pub channel: usize,
    pub monitor_output: String,
    pub outputs: [usize; 2],
    pub gain: f32,
    pub headphones: bool,
}
impl Default for Prefs {
    fn default() -> Self {
        Self {
            input: String::new(),
            channel: 0,
            monitor_output: String::new(),
            outputs: [0, 1],
            gain: -18.,
            headphones: false,
        }
    }
}
impl Prefs {
    pub fn read(raw: &Value) -> Result<Self> {
        let mut p = Self::default();
        for (key, target) in [
            ("inputUid", &mut p.input),
            ("monitorOutputUid", &mut p.monitor_output),
        ] {
            if let Some(v) = raw.get(key) {
                let uid = v.as_str().context("Invalid microphone device preference")?;
                ensure!(
                    uid.len() <= 2000 && !uid.contains('\0'),
                    "Invalid microphone device preference"
                );
                *target = uid.into();
            }
        }
        if let Some(v) = raw.get("inputChannel") {
            p.channel = v
                .as_u64()
                .filter(|v| *v < 1024)
                .context("Invalid microphone channel")? as usize;
        }
        if let Some(v) = raw.get("monitorOutputChannels") {
            let list = v.as_array().context("Invalid monitor channel map")?;
            ensure!(list.len() == 2, "Invalid monitor channel map");
            for (i, n) in list.iter().enumerate() {
                p.outputs[i] =
                    n.as_u64()
                        .filter(|n| *n < 1024)
                        .context("Invalid monitor output channel")? as usize;
            }
            ensure!(
                p.outputs[0] != p.outputs[1],
                "Monitor output channels must differ"
            );
        }
        if let Some(v) = raw.get("monitorGainDb") {
            p.gain = v
                .as_f64()
                .filter(|v| v.is_finite() && (-60. ..=0.).contains(v))
                .context("Invalid monitor gain")? as f32;
        }
        // Headphone confirmation is transient, as in SettingsModal. Never trust
        // a saved confirmation after reopening or changing a physical route.
        Ok(p)
    }
    pub fn patch(&self) -> Value {
        json!({"inputUid":self.input,"inputChannel":self.channel,"monitorOutputUid":self.monitor_output,"monitorOutputChannels":self.outputs,"monitorGainDb":self.gain})
    }
}
#[derive(Clone, Debug, PartialEq)]
pub enum Phase {
    Off,
    Starting,
    Stopping,
    Live,
    Permission,
    Error,
    Monitoring,
}
#[derive(Clone, Debug)]
pub struct View {
    pub capture_host_ns: u64,
    pub detector_resets: u64,
    pub frame_age: Duration,
    pub generation: u64,
    pub owner: u8,
    pub revision: u64,
    pub phase: Phase,
    pub error: Option<String>,
    pub label: String,
    pub device: String,
    pub channel: usize,
    pub channels: usize,
    pub frequency: f32,
    pub clarity: f32,
    pub rms: f32,
    pub peak: f32,
    pub post_rms: f32,
    pub post_peak: f32,
    pub sample_rate: f32,
    pub buffer_frames: usize,
    pub gain: f32,
    pub monitor_enabled: bool,
    pub sequence: u64,
    pub sampled_at: Instant,
    pub fixture: bool,
}
impl Default for View {
    fn default() -> Self {
        Self {
            capture_host_ns: 0,
            detector_resets: 0,
            frame_age: Duration::ZERO,
            generation: 0,
            owner: 0,
            revision: 0,
            phase: Phase::Off,
            error: None,
            label: String::new(),
            device: String::new(),
            channel: 0,
            channels: 0,
            frequency: 0.,
            clarity: 0.,
            rms: 0.,
            peak: 0.,
            post_rms: 0.,
            post_peak: 0.,
            sample_rate: 0.,
            buffer_frames: 0,
            gain: 0.,
            monitor_enabled: false,
            sequence: 0,
            sampled_at: Instant::now(),
            fixture: false,
        }
    }
}
impl View {
    fn parse(v: &Value) -> Result<Self> {
        ensure!(v["protocol"] == 1, "Unsupported native input protocol");
        if v["ok"] != true {
            let permission = v["permission"].as_str().unwrap_or("");
            return Ok(Self {
                phase: if matches!(permission, "required" | "denied" | "restricted" | "timeout") {
                    Phase::Permission
                } else {
                    Phase::Error
                },
                error: Some(v["error"].as_str().unwrap_or("Native input failed").into()),
                ..Self::default()
            });
        }
        let number = |key: &str, max: f64| -> Result<f32> {
            let n = v[key].as_f64().unwrap_or(0.);
            ensure!(
                n.is_finite() && n >= 0. && n <= max,
                "Invalid native input telemetry"
            );
            Ok(n as f32)
        };
        if v["active"] == true {
            let uid = v["deviceUid"]
                .as_str()
                .context("Missing effective microphone device")?;
            let channels = number("deviceChannels", 1024.)?;
            ensure!(
                !uid.is_empty()
                    && uid.len() <= 2000
                    && channels > 0.
                    && number("channel", 1023.)? < channels,
                "Invalid effective microphone route"
            );
        }
        Ok(Self {
            capture_host_ns: v["hostTimeNs"].as_u64().unwrap_or(0),
            detector_resets: v["resets"].as_u64().unwrap_or(0),
            frame_age: Duration::from_secs_f64(number("frameAgeMs", 3_600_000.)? as f64 / 1000.),
            phase: if v["active"] == true {
                if v["monitoring"] == true {
                    Phase::Monitoring
                } else {
                    Phase::Live
                }
            } else {
                Phase::Off
            },
            label: v["deviceLabel"].as_str().unwrap_or("").into(),
            device: v["deviceUid"].as_str().unwrap_or("").into(),
            channel: number("channel", 1023.)? as usize,
            channels: number("deviceChannels", 1024.)? as usize,
            frequency: number("frequency", 10000.)?,
            clarity: number("clarity", 1.)?,
            rms: number("rms", 32.)?,
            peak: number("peak", 32.)?,
            post_rms: number("postRms", 32.)?,
            post_peak: number("postPeak", 32.)?,
            sample_rate: number("sampleRate", 384000.)?,
            buffer_frames: number("bufferFrames", 65536.)? as usize,
            gain: v["gainDb"]
                .as_f64()
                .filter(|g| g.is_finite() && (-60. ..=12.).contains(g))
                .unwrap_or(0.) as f32,
            monitor_enabled: v["monitorEnabled"] == true,
            sequence: v["sequence"].as_u64().unwrap_or(0),
            fixture: v["fixture"] == true,
            ..Self::default()
        })
    }
    pub fn fresh(&self) -> bool {
        matches!(self.phase, Phase::Live | Phase::Monitoring)
            && self.sequence > 0
            && self.sampled_at.elapsed() + self.frame_age < Duration::from_millis(500)
    }
}
#[derive(Clone, Debug, PartialEq)]
pub struct Intent {
    pub prefs: Prefs,
    pub request_permission: bool,
    pub owner: u8,
    pub serial: u64,
    pub monitor: bool,
}
#[derive(Clone, Debug)]
pub enum RecordingState {
    Started,
    Finished {
        path: PathBuf,
        filename: String,
        seconds: f64,
        sample_rate: u32,
    },
    Error {
        message: String,
    },
    Recoverable {
        recovery: super::recording_recovery::Recovery,
        message: String,
    },
}
#[cfg(feature = "ui-tests")]
pub struct RecordingPaths {
    pub staged: PathBuf,
    pub directory: PathBuf,
    pub filename: String,
}
#[derive(Clone, Debug)]
pub struct RecordingEvent {
    pub generation: u64,
    pub take_id: u64,
    pub state: RecordingState,
}
type RecordingEvents = Arc<Mutex<VecDeque<RecordingEvent>>>;
fn recording_owner(ready: bool, monitor: bool, owner: u8) -> Result<()> {
    ensure!(
        ready && !monitor && owner == crate::training_capture::TRAINING_OWNER,
        "Recording requires the live training microphone owner"
    );
    Ok(())
}
fn recording_event(events: &RecordingEvents, generation: u64, take_id: u64, state: RecordingState) {
    events
        .lock()
        .unwrap_or_else(|e| e.into_inner())
        .push_back(RecordingEvent {
            generation,
            take_id,
            state,
        });
}
enum Request {
    Start(u64, Intent),
    Stop(u64),
    Gain(u64, f32),
    Record(u64, u64, PathBuf),
    Finish(u64, u64),
    #[cfg(feature = "ui-tests")]
    OwnedCapture(u64, bool, mpsc::Sender<std::result::Result<u32, String>>),
    #[cfg(feature = "ui-tests")]
    OwnedRecording(
        u64,
        u64,
        mpsc::Sender<std::result::Result<RecordingPaths, String>>,
    ),
}
pub struct Service {
    requests: SyncSender<Request>,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    view: Arc<Mutex<View>>,
    worker: Option<thread::JoinHandle<()>>,
    recordings: RecordingEvents,
}
impl Service {
    #[cfg(feature = "ui-tests")]
    pub fn owned_recording(
        &self,
        generation: u64,
        take_id: u64,
    ) -> Result<Receiver<std::result::Result<RecordingPaths, String>>> {
        ensure!(
            generation > 0
                && take_id > 0
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some()
                && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"),
            "Recording inspection requires hidden muted owned fixture capture"
        );
        let (tx, rx) = mpsc::channel();
        self.requests
            .try_send(Request::OwnedRecording(generation, take_id, tx))
            .context("Native microphone command queue is full")?;
        Ok(rx)
    }
    #[cfg(feature = "ui-tests")]
    fn capture_request(
        &self,
        generation: u64,
        fail: bool,
    ) -> Result<Receiver<std::result::Result<u32, String>>> {
        ensure!(
            std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some()
                && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"),
            "Owned capture inspection requires hidden muted fixture capture"
        );
        ensure!(generation > 0, "No capture generation selected");
        let (tx, rx) = mpsc::channel();
        self.requests
            .try_send(Request::OwnedCapture(generation, fail, tx))
            .context("Native microphone command queue is full")?;
        Ok(rx)
    }
    #[cfg(feature = "ui-tests")]
    pub fn owned_capture(
        &self,
        generation: u64,
    ) -> Result<Receiver<std::result::Result<u32, String>>> {
        self.capture_request(generation, false)
    }
    #[cfg(feature = "ui-tests")]
    pub fn fail_owned_capture(
        &self,
        generation: u64,
    ) -> Result<Receiver<std::result::Result<u32, String>>> {
        self.capture_request(generation, true)
    }
    pub fn new() -> Self {
        let (tx, rx) = mpsc::sync_channel(32);
        let latest = Arc::new(AtomicU64::new(0));
        let alive = Arc::new(AtomicBool::new(true));
        let view = Arc::new(Mutex::new(View::default()));
        let a = alive.clone();
        let l = latest.clone();
        let v = view.clone();
        let recordings = Arc::new(Mutex::new(VecDeque::new()));
        let events = recordings.clone();
        let worker = thread::spawn(move || worker(rx, a, l, v, events));
        Self {
            requests: tx,
            latest,
            alive,
            view,
            worker: Some(worker),
            recordings,
        }
    }
    pub fn start(&self, intent: Intent) -> Result<()> {
        let generation = self.latest.fetch_add(1, Ordering::AcqRel) + 1;
        publish(
            &self.view,
            &self.latest,
            generation,
            View {
                phase: Phase::Starting,
                owner: intent.owner,
                ..View::default()
            },
        );
        self.requests
            .try_send(Request::Start(generation, intent))
            .context("Native microphone command queue is full")
    }
    pub fn stop(&self) -> Result<()> {
        let generation = self.latest.fetch_add(1, Ordering::AcqRel) + 1;
        publish(
            &self.view,
            &self.latest,
            generation,
            View {
                phase: Phase::Stopping,
                ..View::default()
            },
        );
        self.requests
            .try_send(Request::Stop(generation))
            .context("Native microphone command queue is full")
    }
    pub fn gain(&self, gain: f32) -> Result<()> {
        ensure!(
            gain.is_finite() && (-60. ..=0.).contains(&gain),
            "Invalid monitor gain"
        );
        self.requests
            .try_send(Request::Gain(self.latest.load(Ordering::Acquire), gain))
            .context("Native microphone command queue is full")
    }
    pub fn record(&self, expected_generation: u64, take_id: u64, directory: PathBuf) -> Result<()> {
        ensure!(
            expected_generation > 0 && take_id > 0,
            "Invalid recording identity"
        );
        ensure!(
            self.alive.load(Ordering::Acquire)
                && self.latest.load(Ordering::Acquire) == expected_generation,
            "Microphone request superseded"
        );
        let view = self.snapshot();
        ensure!(
            view.generation == expected_generation,
            "Microphone request superseded"
        );
        recording_owner(
            view.phase == Phase::Live,
            view.phase == Phase::Monitoring,
            view.owner,
        )?;
        ensure!(
            self.recordings
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                < 64,
            "Drain previous microphone recording receipts first"
        );
        self.requests
            .try_send(Request::Record(expected_generation, take_id, directory))
            .context("Native microphone command queue is full")
    }
    pub fn finish_recording(&self, expected_generation: u64, take_id: u64) -> Result<()> {
        ensure!(
            expected_generation > 0 && take_id > 0,
            "Invalid recording identity"
        );
        ensure!(
            self.recordings
                .lock()
                .unwrap_or_else(|e| e.into_inner())
                .len()
                < 64,
            "Drain previous microphone recording receipts first"
        );
        self.requests
            .try_send(Request::Finish(expected_generation, take_id))
            .context("Native microphone command queue is full")
    }
    pub fn drain_recordings(&self) -> Vec<RecordingEvent> {
        self.recordings
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .drain(..)
            .collect()
    }
    pub fn snapshot(&self) -> View {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.alive.store(false, Ordering::Release);
        self.latest.fetch_add(1, Ordering::AcqRel);
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct RecordingTake {
    id: u64,
    directory: PathBuf,
    stage_dir: PathBuf,
    staged: PathBuf,
    filename: String,
    retained: bool,
    publication_ready: bool,
    publication_source: Option<super::recording_recovery::SourcePin>,
    ownership: super::recording_recovery::OwnedStage,
}
impl RecordingTake {
    fn prepare(directory: PathBuf, generation: u64, id: u64) -> Result<Self> {
        Self::prepare_at(
            &crate::audio_devices::directory(),
            directory,
            generation,
            id,
        )
    }
    fn prepare_at(root: &Path, directory: PathBuf, generation: u64, id: u64) -> Result<Self> {
        ensure!(
            root.is_absolute() && directory == root.join("training-recordings"),
            "Invalid training recording directory"
        );
        fs::create_dir_all(root)?;
        ensure!(
            fs::symlink_metadata(root)?.file_type().is_dir(),
            "Recording config root must be ordinary"
        );
        fs::create_dir_all(&directory)?;
        ensure!(
            fs::symlink_metadata(&directory)?.file_type().is_dir(),
            "Training recording directory must be ordinary"
        );
        let stamp = chrono::Utc::now()
            .to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
            .replace(['-', ':', '.'], "");
        let filename = format!("SingZ-microphone-{stamp}-{generation}-take-{id}.wav");
        static SEQUENCE: AtomicU64 = AtomicU64::new(0);
        let stage_dir = directory.join(format!(
            ".take-{}-{}-{}",
            std::process::id(),
            generation,
            SEQUENCE.fetch_add(1, Ordering::Relaxed)
        ));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&stage_dir)?;
        let ownership = super::recording_recovery::OwnedStage::new(&directory, &stage_dir)?;
        Ok(Self {
            id,
            directory,
            staged: stage_dir.join(&filename),
            stage_dir,
            filename,
            retained: false,
            publication_ready: false,
            publication_source: None,
            ownership,
        })
    }
    fn publish(&mut self, packet: &Value) -> Result<(PathBuf, String, f64, u32)> {
        self.publish_with_hook(packet, || {})
    }
    fn publish_with_hook(
        &mut self,
        packet: &Value,
        before_link: impl FnOnce(),
    ) -> Result<(PathBuf, String, f64, u32)> {
        self.publication_ready = false;
        self.publication_source = None;
        ensure!(
            packet["path"].as_str() == self.staged.to_str()
                && packet["filename"].as_str() == Some(self.filename.as_str()),
            "Invalid microphone recording path receipt"
        );
        // Capture full identity/content from one owned source before trusting the
        // native format receipt. The same proof fences publication and recovery.
        let pin = self.ownership.pin_direct(&self.filename)?;
        let seconds = pin.seconds();
        let sample_rate = pin.sample_rate();
        let reported = packet["seconds"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0. && *v <= 30.)
            .context("Invalid recording duration")?;
        ensure!(
            packet["sampleRate"].as_f64() == Some(sample_rate as f64)
                && (seconds - reported).abs() <= 1. / sample_rate as f64,
            "Invalid recording format receipt"
        );
        self.publication_ready = true;
        self.publication_source = Some(pin);
        let pin = self.publication_source.as_ref().unwrap();
        pin.sync_all()?;
        before_link();
        let destination = self.directory.join(&self.filename);
        fs::hard_link(&self.staged, &destination)
            .context("Microphone recording destination already exists or cannot be published")?;
        pin.verify_hard_link(&destination)?;
        #[cfg(unix)]
        if let Err(error) = fs::File::open(&self.directory).and_then(|file| file.sync_all()) {
            // Audio is published, but keep the original link until durability is
            // established rather than deleting our only pre-publication name.
            self.retained = true;
            crate::diagnostics::event(
                "training-recording",
                format!(
                    "Recording published; original retained after directory sync failure: {error}"
                ),
                crate::diagnostics::Level::Warn,
            );
        }
        crate::diagnostics::event(
            "training-recording",
            format!(
                "saved · {} · {:.1} s · {} Hz · mono PCM16",
                self.filename, seconds, sample_rate
            ),
            crate::diagnostics::Level::Info,
        );
        Ok((destination, self.filename.clone(), seconds, sample_rate))
    }
    fn retain_if_audio(&mut self) {
        self.retain_if_audio_with(|path| fs::read_dir(path));
    }
    fn retain_if_audio_with(
        &mut self,
        inspect: impl FnOnce(&Path) -> std::io::Result<fs::ReadDir>,
    ) {
        // Enumeration failure is not proof of an empty stage. In particular,
        // directory write/search permission may still allow Drop to unlink audio.
        self.retained = match inspect(&self.stage_dir) {
            Ok(mut entries) => entries.next().is_some(),
            Err(_) => true,
        };
    }
    fn capture_recovery(&self) -> Result<super::recording_recovery::Recovery> {
        let recovery = self.ownership.capture(&self.filename, self.id)?;
        if let Some(pin) = &self.publication_source {
            pin.require_recovery(&recovery)?;
        }
        Ok(recovery)
    }
}
impl Drop for RecordingTake {
    fn drop(&mut self) {
        if !self.retained {
            let _ = fs::remove_file(&self.staged);
            let _ = fs::remove_dir(&self.stage_dir);
        }
    }
}
fn quote_path(path: &Path) -> Result<String> {
    let text = path.to_str().context("Recording path must be UTF-8")?;
    ensure!(
        text.len() <= 3000 && !text.chars().any(char::is_control),
        "Invalid microphone recording path"
    );
    let quoted = serde_json::to_string(text)?;
    ensure!(
        quoted.len() <= 3500,
        "Microphone recording command exceeds its encoded limit"
    );
    Ok(quoted)
}
pub(crate) fn recording_wav(header: &[u8; 44], bytes: u64) -> Result<(f64, u32)> {
    let u32_at = |i| u32::from_le_bytes(header[i..i + 4].try_into().unwrap());
    let u16_at = |i| u16::from_le_bytes(header[i..i + 2].try_into().unwrap());
    let rate = u32_at(24);
    let data = u32_at(40) as u64;
    ensure!(
        &header[..4] == b"RIFF"
            && &header[8..16] == b"WAVEfmt "
            && u32_at(16) == 16
            && u16_at(20) == 1
            && u16_at(22) == 1
            && rate >= 8000
            && rate <= 192000
            && u32_at(28) == rate * 2
            && u16_at(32) == 2
            && u16_at(34) == 16
            && &header[36..40] == b"data"
            && data > 0
            && data % 2 == 0
            && data + 44 == bytes
            && u32_at(4) as u64 + 8 == bytes
            && data / 2 <= 30 * rate as u64,
        "Invalid raw mono PCM16 recording"
    );
    Ok(((data / 2) as f64 / rate as f64, rate))
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum FinishProof {
    Pending,
    Finished,
    Failed,
    Invalid,
}
impl FinishProof {
    fn can_recover(self, validated_receipt: bool, child_exited: bool) -> bool {
        match self {
            Self::Finished => validated_receipt,
            Self::Failed => true,
            Self::Pending => child_exited,
            Self::Invalid => false,
        }
    }
}
// A packaged app keeps data out of the signed code directory. Loose native
// runtimes retain the existing adjacent-assets layout on every platform.
fn bundled_pitch_model(executable: &Path) -> PathBuf {
    if let Some(directory) = executable.parent() {
        if directory.file_name().is_some_and(|n| n == "MacOS") {
            if let Some(contents) = directory.parent().filter(|p| p.file_name().is_some_and(|n| n == "Contents")) {
                return contents.join("Resources").join("pitch").join("crepe-tiny.bin");
            }
        }
    }
    executable.with_file_name("pitch").join("crepe-tiny.bin")
}
struct Session {
    ready: bool,
    child: Child,
    registration: super::process_registry::Registration,
    input: ChildStdin,
    replies: Receiver<Result<Value>>,
    generation: u64,
    owner: u8,
    latest: Arc<AtomicU64>,
    alive: Arc<AtomicBool>,
    monitor: bool,
    recording: Option<RecordingTake>,
    recording_events: RecordingEvents,
    recording_finish: FinishProof,
}
impl Drop for Session {
    fn drop(&mut self) {
        self.finish_take();
        if self.ready {
            let _ = writeln!(self.input, "stop");
            let _ = self.input.flush();
            let deadline = Instant::now() + Duration::from_millis(750);
            while Instant::now() < deadline {
                match self.registration.try_wait(&mut self.child) {
                    Ok(Some(_)) => return,
                    Err(_) => break,
                    _ => {}
                }
                let _ = self.replies.recv_timeout(Duration::from_millis(20));
            }
        }
        let _ = self.child.kill();
        let _ = self.registration.wait(&mut self.child);
    }
}
impl Session {
    fn open(
        generation: u64,
        intent: &Intent,
        latest: Arc<AtomicU64>,
        alive: Arc<AtomicBool>,
        recording_events: RecordingEvents,
    ) -> Result<(Self, View)> {
        let exe = std::env::var_os("SINGZ_GPUI_INPUT_HELPER")
            .map(PathBuf::from)
            .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
                "singz-gpui-input.exe"
            } else {
                "singz-gpui-input"
            }));
        let model = std::env::var_os("SINGZ_GPUI_PITCH_MODEL")
            .map(PathBuf::from)
            .unwrap_or_else(|| bundled_pitch_model(&exe));
        let mut command = Command::new(exe);
        command
            .arg("--generation")
            .arg(generation.to_string())
            .arg("--device")
            .arg(&intent.prefs.input)
            .arg("--channel")
            .arg(intent.prefs.channel.to_string())
            .arg("--model")
            .arg(model);
        if intent.request_permission {
            command.arg("--request-permission");
        }
        if intent.monitor {
            command
                .arg("--monitor")
                .arg("--output")
                .arg(&intent.prefs.monitor_output)
                .arg("--left")
                .arg(intent.prefs.outputs[0].to_string())
                .arg("--right")
                .arg(intent.prefs.outputs[1].to_string());
        }
        #[cfg(feature = "ui-tests")]
        if let Some(path) = std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE") {
            ensure!(
                std::env::var_os("SINGZ_MUTE").is_some(),
                "Capture fixtures must be silent"
            );
            if intent.monitor {
                command.arg("--test-fake-host");
            } else {
                command.arg("--test-input").arg(path);
            }
        }
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .context("Cannot start native microphone service")?;
        let mut registration = match super::process_registry::Registration::new(&child) {
            Ok(registration) => registration,
            Err(error) => { let _ = child.kill(); let _ = child.wait(); return Err(error.into()); }
        };
        let (input, stdout) = match (child.stdin.take(), child.stdout.take()) {
            (Some(input), Some(stdout)) => (input, stdout),
            _ => {
                let _ = child.kill();
                let _ = registration.wait(&mut child);
                anyhow::bail!("Missing microphone pipes");
            }
        };
        let (tx, rx) = mpsc::sync_channel(1);
        thread::spawn(move || {
            let mut reader = BufReader::new(stdout);
            loop {
                let mut bytes = vec![];
                let result = reader.by_ref().take(65537).read_until(b'\n', &mut bytes);
                let value = match result {
                    Ok(0) => Err(anyhow::anyhow!("Native microphone disconnected")),
                    Ok(_) if bytes.len() > 65536 || bytes.last() != Some(&b'\n') => {
                        Err(anyhow::anyhow!("Invalid native microphone packet"))
                    }
                    Ok(_) => serde_json::from_slice(&bytes).map_err(Into::into),
                    Err(e) => Err(e.into()),
                };
                let failed = value.is_err();
                if tx.send(value).is_err() || failed {
                    break;
                }
            }
        });
        let mut session = Self {
            ready: false,
            child,
            registration,
            input,
            replies: rx,
            generation,
            owner: intent.owner,
            latest,
            alive,
            monitor: intent.monitor,
            recording: None,
            recording_events,
            recording_finish: FinishProof::Pending,
        };
        let value = session.read(Duration::from_secs(if intent.request_permission {
            125
        } else {
            15
        }))?;
        let mut view = View::parse(&value)?;
        view.generation = generation;
        view.owner = intent.owner;
        session.ready = matches!(view.phase, Phase::Live | Phase::Monitoring);
        if matches!(view.phase, Phase::Monitoring) {
            let view = session.command(&format!("gain {}", intent.prefs.gain))?;
            Ok((session, view))
        } else {
            Ok((session, view))
        }
    }
    fn recording_command(&mut self, command: &str, take_id: u64) -> Result<Value> {
        self.recording_finish = FinishProof::Pending;
        // A helper stopping after a device error may already have queued its
        // automatic finish receipt before closing stdin. Drain that receipt
        // even if sending the redundant explicit finish now fails.
        let write_error = writeln!(self.input, "{command}")
            .and_then(|_| self.input.flush())
            .err();
        let deadline = Instant::now() + Duration::from_secs(8);
        loop {
            match self.replies.recv_timeout(Duration::from_millis(20)) {
                Ok(value) => {
                    let value = value?;
                    if let Some(packet) = value.get("recording") {
                        self.recording_finish = FinishProof::Invalid;
                        ensure!(
                            value["protocol"] == 1
                                && packet["generation"].as_u64() == Some(self.generation)
                                && packet["takeId"].as_u64() == Some(take_id),
                            "Mismatched native recording receipt"
                        );
                        if command.starts_with("finish ") {
                            self.recording_finish =
                                match (value["ok"].as_bool(), packet["state"].as_str()) {
                                    (Some(true), Some("finished")) => FinishProof::Finished,
                                    (Some(false), Some("error")) => FinishProof::Failed,
                                    _ => FinishProof::Invalid,
                                };
                        }
                        ensure!(
                            value["ok"] == true,
                            "{}",
                            value["error"]
                                .as_str()
                                .unwrap_or("Native microphone recording failed")
                        );
                        return Ok(packet.clone());
                    }
                }
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    bail!(
                        "Native microphone disconnected while finishing recording{}",
                        write_error
                            .as_ref()
                            .map(|e| format!(": {e}"))
                            .unwrap_or_default()
                    )
                }
                Err(_) => {}
            }
            // Finishing an accepted take intentionally ignores latest/alive: stop,
            // route replacement and navigation revoke telemetry, never its audio.
            ensure!(
                Instant::now() < deadline,
                "Native microphone recording command timed out"
            );
        }
    }
    fn start_take(&mut self, take_id: u64, directory: PathBuf) -> Result<()> {
        recording_owner(self.ready, self.monitor, self.owner)?;
        ensure!(
            self.recording.is_none(),
            "A microphone recording is already active"
        );
        let take = RecordingTake::prepare(directory, self.generation, take_id)?;
        ensure!(
            self.latest.load(Ordering::Acquire) == self.generation
                && self.alive.load(Ordering::Acquire),
            "Microphone request superseded"
        );
        let command = format!(
            "record {} {} {}",
            self.generation,
            take_id,
            quote_path(&take.staged)?
        );
        self.recording = Some(take);
        let packet = self.recording_command(&command, take_id)?;
        ensure!(
            packet["state"] == "started",
            "Invalid native recording start receipt"
        );
        crate::diagnostics::event(
            "training-recording",
            format!(
                "started · {} · maximum 30 s · raw native microphone",
                self.recording.as_ref().unwrap().filename
            ),
            crate::diagnostics::Level::Info,
        );
        recording_event(
            &self.recording_events,
            self.generation,
            take_id,
            RecordingState::Started,
        );
        Ok(())
    }
    fn finish_take(&mut self) {
        let Some(mut take) = self.recording.take() else {
            return;
        };
        let result = (|| {
            let packet = self
                .recording_command(&format!("finish {} {}", self.generation, take.id), take.id)?;
            ensure!(
                packet["state"] == "finished",
                "Invalid native recording completion"
            );
            take.publish(&packet)
        })();
        let state = match result {
            Ok((path, filename, seconds, sample_rate)) => RecordingState::Finished {
                path,
                filename,
                seconds,
                sample_rate,
            },
            Err(error) => {
                take.retain_if_audio();
                let child_exited = self.registration.try_wait(&mut self.child).is_ok_and(|status| status.is_some());
                let writer_finished = self
                    .recording_finish
                    .can_recover(take.publication_ready, child_exited);
                let recovery = writer_finished
                    .then(|| take.capture_recovery())
                    .and_then(Result::ok);
                if let Some(recovery) = recovery {
                    take.retained = true;
                    RecordingState::Recoverable {
                        recovery,
                        message: format!("{error:#}"),
                    }
                } else {
                    RecordingState::Error {
                        message: format!(
                            "{error:#}{}",
                            if take.retained {
                                format!(
                                    "; recording stage left untouched: {}",
                                    take.stage_dir.display()
                                )
                            } else {
                                String::new()
                            }
                        ),
                    }
                }
            }
        };
        recording_event(&self.recording_events, self.generation, take.id, state);
    }
    fn read(&mut self, timeout: Duration) -> Result<Value> {
        let deadline = Instant::now() + timeout;
        loop {
            ensure!(
                self.alive.load(Ordering::Acquire)
                    && self.latest.load(Ordering::Acquire) == self.generation,
                "Microphone request superseded"
            );
            match self.replies.recv_timeout(Duration::from_millis(20)) {
                Ok(value) => return value,
                Err(mpsc::RecvTimeoutError::Disconnected) => {
                    bail!("Native microphone disconnected")
                }
                Err(_) => {}
            }
            ensure!(
                Instant::now() < deadline,
                "Native microphone command timed out"
            );
        }
    }
    fn command(&mut self, command: &str) -> Result<View> {
        writeln!(self.input, "{command}")?;
        self.input.flush()?;
        let mut view = View::parse(&self.read(Duration::from_secs(3))?)?;
        view.generation = self.generation;
        view.owner = self.owner;
        Ok(view)
    }
}
fn publish(slot: &Mutex<View>, latest: &AtomicU64, generation: u64, mut value: View) {
    let mut current = slot.lock().unwrap_or_else(|e| e.into_inner());
    if generation != latest.load(Ordering::Acquire) {
        return;
    }
    value.generation = generation;
    if value.phase == current.phase
        && value.sequence == current.sequence
        && value.device == current.device
        && matches!(value.phase, Phase::Live | Phase::Monitoring)
    {
        value.sampled_at = current.sampled_at;
        value.frame_age = current.frame_age;
    }
    value.revision = current.revision + 1;
    *current = value;
}

fn worker(
    requests: Receiver<Request>,
    alive: Arc<AtomicBool>,
    latest: Arc<AtomicU64>,
    view: Arc<Mutex<View>>,
    recording_events: RecordingEvents,
) {
    let mut session: Option<Session> = None;
    let mut poll = Instant::now();
    while alive.load(Ordering::Acquire) {
        match requests.recv_timeout(Duration::from_millis(20)) {
            #[cfg(feature = "ui-tests")]
            Ok(Request::OwnedRecording(generation, take_id, reply)) => {
                let result = (|| -> Result<RecordingPaths> {
                    ensure!(
                        generation == latest.load(Ordering::Acquire),
                        "Capture generation superseded"
                    );
                    let child = session
                        .as_mut()
                        .filter(|child| {
                            child.generation == generation
                                && child.owner == super::training_capture::TRAINING_OWNER
                                && !child.monitor
                        })
                        .context("No owned training capture")?;
                    ensure!(
                        child.registration.try_wait(&mut child.child)?.is_none(),
                        "Owned capture already exited"
                    );
                    let take = child
                        .recording
                        .as_ref()
                        .filter(|take| take.id == take_id)
                        .context("No matching owned recording")?;
                    Ok(RecordingPaths {
                        staged: take.staged.clone(),
                        directory: take.directory.clone(),
                        filename: take.filename.clone(),
                    })
                })()
                .map_err(|error| format!("{error:#}"));
                let _ = reply.send(result);
            }
            #[cfg(feature = "ui-tests")]
            Ok(Request::OwnedCapture(generation, fail, reply)) => {
                let result = (|| -> Result<u32> {
                    ensure!(
                        generation == latest.load(Ordering::Acquire),
                        "Capture generation superseded"
                    );
                    let child = session
                        .as_mut()
                        .filter(|child| {
                            child.generation == generation
                                && child.owner == super::training_capture::TRAINING_OWNER
                                && !child.monitor
                        })
                        .context("No owned training capture")?;
                    let pid = child.child.id();
                    ensure!(
                        child.registration.try_wait(&mut child.child)?.is_none(),
                        "Owned capture already exited"
                    );
                    if fail {
                        child
                            .child
                            .kill()
                            .context("Cannot fault owned training capture")?;
                    }
                    Ok(pid)
                })()
                .map_err(|error| format!("{error:#}"));
                let _ = reply.send(result);
            }
            Ok(Request::Start(g, intent)) if g == latest.load(Ordering::Acquire) => {
                drop(session.take());
                publish(
                    &view,
                    &latest,
                    g,
                    View {
                        phase: Phase::Starting,
                        ..View::default()
                    },
                );
                let result = Session::open(
                    g,
                    &intent,
                    latest.clone(),
                    alive.clone(),
                    recording_events.clone(),
                );
                if g != latest.load(Ordering::Acquire) {
                    continue;
                }
                match result {
                    Ok((child, value)) => {
                        if matches!(value.phase, Phase::Live | Phase::Monitoring) {
                            session = Some(child);
                        }
                        publish(&view, &latest, g, value);
                    }
                    Err(error) => publish(
                        &view,
                        &latest,
                        g,
                        View {
                            phase: Phase::Error,
                            error: Some(format!("{error:#}")),
                            ..View::default()
                        },
                    ),
                }
            }
            Ok(Request::Gain(g, gain)) if g == latest.load(Ordering::Acquire) => {
                if let Some(child) = session.as_mut().filter(|s| s.generation == g) {
                    match child.command(&format!("gain {gain}")) {
                        Ok(frame) => publish(&view, &latest, g, frame),
                        Err(error) => {
                            drop(session.take());
                            publish(
                                &view,
                                &latest,
                                g,
                                View {
                                    phase: Phase::Error,
                                    error: Some(format!("{error:#}")),
                                    ..Default::default()
                                },
                            );
                        }
                    }
                }
            }
            Ok(Request::Stop(g)) if g == latest.load(Ordering::Acquire) => {
                drop(session.take());
                publish(&view, &latest, g, View::default());
            }
            Ok(Request::Record(g, id, directory)) => {
                let had_take = session
                    .as_ref()
                    .is_some_and(|child| child.recording.is_some());
                let result = if g != latest.load(Ordering::Acquire) {
                    Err(anyhow::anyhow!("Microphone request superseded"))
                } else if let Some(child) = session.as_mut().filter(|s| s.generation == g) {
                    child.start_take(id, directory)
                } else {
                    Err(anyhow::anyhow!("The microphone is unavailable."))
                };
                if let Err(error) = result {
                    recording_event(
                        &recording_events,
                        g,
                        id,
                        RecordingState::Error {
                            message: format!("{error:#}"),
                        },
                    );
                    if !had_take {
                        if let Some(child) = session.as_mut().filter(|s| s.generation == g) {
                            child.finish_take();
                        }
                    }
                }
            }
            Ok(Request::Finish(g, id)) => {
                if let Some(child) = session.as_mut().filter(|s| {
                    s.generation == g && s.recording.as_ref().is_some_and(|take| take.id == id)
                }) {
                    child.finish_take();
                } else {
                    recording_event(
                        &recording_events,
                        g,
                        id,
                        RecordingState::Error {
                            message: "No matching microphone recording is active".into(),
                        },
                    );
                }
            }
            Err(mpsc::RecvTimeoutError::Disconnected) => break,
            _ => {}
        }
        if poll.elapsed() >= Duration::from_millis(40) {
            poll = Instant::now();
            if let Some(child) = session.as_mut() {
                match child.command("status") {
                    Ok(frame) => {
                        let running = matches!(frame.phase, Phase::Live | Phase::Monitoring);
                        publish(&view, &latest, child.generation, frame);
                        if !running {
                            drop(session.take());
                        }
                    }
                    Err(error) => {
                        if child.generation == latest.load(Ordering::Acquire) {
                            publish(
                                &view,
                                &latest,
                                child.generation,
                                View {
                                    phase: Phase::Error,
                                    error: Some(format!("{error:#}")),
                                    ..View::default()
                                },
                            );
                        }
                        drop(session.take());
                    }
                }
            }
        }
    }
    drop(session);
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn recovery_requires_a_terminal_matching_finish_or_the_owned_child_exit() {
        for validated in [false, true] {
            for exited in [false, true] {
                assert_eq!(FinishProof::Pending.can_recover(validated, exited), exited);
                assert_eq!(
                    FinishProof::Finished.can_recover(validated, exited),
                    validated
                );
                assert!(FinishProof::Failed.can_recover(validated, exited));
                assert!(!FinishProof::Invalid.can_recover(validated, exited));
            }
        }
    }
    #[test]
    fn capture_host_clock_keeps_integer_precision_for_training() {
        let value = View::parse(
            &json!({"protocol":1,"ok":true,"hostTimeNs":9007199254740993u64,"resets":3}),
        )
        .unwrap();
        assert_eq!(value.capture_host_ns, 9007199254740993);
        assert_eq!(value.detector_resets, 3);
    }
    #[test]
    fn superseded_generations_and_repeated_frames_cannot_publish_fresh_data() {
        let slot = Mutex::new(View::default());
        let latest = AtomicU64::new(1);
        publish(
            &slot,
            &latest,
            1,
            View {
                phase: Phase::Live,
                device: "one".into(),
                sequence: 4,
                ..Default::default()
            },
        );
        let timestamp = slot.lock().unwrap().sampled_at;
        publish(
            &slot,
            &latest,
            1,
            View {
                phase: Phase::Live,
                device: "one".into(),
                sequence: 4,
                ..Default::default()
            },
        );
        assert_eq!(slot.lock().unwrap().sampled_at, timestamp);
        latest.store(2, Ordering::Release);
        publish(
            &slot,
            &latest,
            2,
            View {
                phase: Phase::Starting,
                ..Default::default()
            },
        );
        publish(
            &slot,
            &latest,
            1,
            View {
                phase: Phase::Live,
                ..Default::default()
            },
        );
        assert_eq!(slot.lock().unwrap().phase, Phase::Starting);
    }
    #[test]
    fn input_preferences_and_scalar_frames_are_bounded() {
        let prefs = Prefs::read(
            &json!({"inputUid":"opaque uid","inputChannel":7,"monitorOutputChannels":[2,3]}),
        )
        .unwrap();
        assert_eq!(Prefs::read(&prefs.patch()).unwrap(), prefs);
        assert!(!Prefs::read(&json!({"headphones":true})).unwrap().headphones);
        assert!(prefs.patch().get("headphones").is_none());
        assert!(Prefs::read(&json!({"inputChannel":-1})).is_err());
        assert!(Prefs::read(&json!({"monitorOutputChannels":[1,1]})).is_err());
        assert!(View::parse(&json!({"protocol":1,"ok":true,"frequency":-1})).is_err());
        let permission = View::parse(
            &json!({"protocol":1,"ok":false,"permission":"required","error":"permission needed"}),
        )
        .unwrap();
        assert_eq!(permission.phase, Phase::Permission);
        let late=View::parse(&json!({"protocol":1,"ok":true,"active":true,"deviceUid":"mic","deviceChannels":1,"channel":0,"sequence":9,"frameAgeMs":1200})).unwrap();
        assert!(!late.fresh());
    }
    struct RecordingFixture(PathBuf);
    impl RecordingFixture {
        fn new() -> Self {
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let root = std::env::temp_dir().join(format!(
                "singz-mic-recording-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&root).unwrap();
            Self(root)
        }
        fn take(&self) -> RecordingTake {
            RecordingTake::prepare_at(&self.0, self.0.join("training-recordings"), 41, 9).unwrap()
        }
    }
    impl Drop for RecordingFixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    fn recording_bytes(rate: u32, frames: u32) -> Vec<u8> {
        let mut bytes = vec![];
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + frames * 2).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&rate.to_le_bytes());
        bytes.extend_from_slice(&(rate * 2).to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&(frames * 2).to_le_bytes());
        bytes.resize(44 + frames as usize * 2, 0);
        bytes
    }
    fn recording_packet(take: &RecordingTake, rate: u32, frames: u32) -> Value {
        json!({"path":take.staged,"filename":take.filename,"seconds":frames as f64/rate as f64,"sampleRate":rate})
    }
    #[test]
    fn recording_publication_retains_raw_native_rate_and_publishes_exclusively() {
        let fixture = RecordingFixture::new();
        let mut take = fixture.take();
        let bytes = recording_bytes(48000, 4800);
        fs::write(&take.staged, &bytes).unwrap();
        let stage = take.stage_dir.clone();
        let packet = recording_packet(&take, 48000, 4800);
        let (path, name, seconds, rate) = take.publish(&packet).unwrap();
        assert_eq!(rate, 48000);
        assert_eq!(seconds, 0.1);
        assert!(name.starts_with("SingZ-microphone-"));
        assert!(name.ends_with("-41-take-9.wav"));
        assert_eq!(fs::read(&path).unwrap(), bytes);
        drop(take);
        assert!(!stage.exists());
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
    #[test]
    fn recording_collision_preserves_both_existing_file_and_recoverable_take() {
        let fixture = RecordingFixture::new();
        let mut take = fixture.take();
        let bytes = recording_bytes(44100, 4410);
        fs::write(&take.staged, &bytes).unwrap();
        let destination = take.directory.join(&take.filename);
        fs::write(&destination, b"foreign recording").unwrap();
        let packet = recording_packet(&take, 44100, 4410);
        assert!(take.publish(&packet).is_err());
        take.retain_if_audio();
        let stage = take.staged.clone();
        drop(take);
        assert_eq!(fs::read(destination).unwrap(), b"foreign recording");
        assert_eq!(fs::read(stage).unwrap(), bytes);
    }
    #[test]
    fn unreadable_private_stage_is_retained_instead_of_unlinked() {
        let fixture = RecordingFixture::new();
        let mut take = fixture.take();
        let bytes = recording_bytes(16000, 1600);
        fs::write(&take.staged, &bytes).unwrap();
        let staged = take.staged.clone();
        take.retain_if_audio_with(|_| {
            Err(std::io::Error::from(std::io::ErrorKind::PermissionDenied))
        });
        drop(take);
        assert_eq!(fs::read(staged).unwrap(), bytes);
        let mut empty = fixture.take();
        let directory = empty.stage_dir.clone();
        empty.retain_if_audio();
        drop(empty);
        assert!(!directory.exists());
    }
    #[test]
    fn publication_and_fallback_recovery_refuse_a_substituted_valid_wav() {
        for collision in [false, true] {
            let fixture = RecordingFixture::new();
            let mut take = fixture.take();
            let bytes = recording_bytes(16000, 1600);
            fs::write(&take.staged, &bytes).unwrap();
            let staged = take.staged.clone();
            let destination = take.directory.join(&take.filename);
            if collision {
                fs::write(&destination, b"unrelated").unwrap();
            }
            let packet = recording_packet(&take, 16000, 1600);
            let replacement = recording_bytes(16000, 3200);
            assert!(take
                .publish_with_hook(&packet, || {
                    fs::remove_file(&staged).unwrap();
                    fs::write(&staged, &replacement).unwrap();
                })
                .is_err());
            assert!(take.publication_ready);
            // A fresh directory-authorized capture would accept this valid WAV,
            // but it is not the completed source validated for this publication.
            assert!(take.ownership.capture(&take.filename, take.id).is_ok());
            assert!(take.capture_recovery().is_err());
            take.retain_if_audio();
            drop(take);
            assert_eq!(fs::read(staged).unwrap(), replacement);
            if collision {
                assert_eq!(fs::read(destination).unwrap(), b"unrelated");
            }
        }
    }
    #[test]
    fn publication_rejects_same_inode_pcm_edits_even_with_restored_mtime() {
        let fixture = RecordingFixture::new();
        let mut take = fixture.take();
        let bytes = recording_bytes(16000, 1600);
        fs::write(&take.staged, &bytes).unwrap();
        let staged = take.staged.clone();
        let original_modified = fs::metadata(&staged).unwrap().modified().unwrap();
        let packet = recording_packet(&take, 16000, 1600);
        assert!(take
            .publish_with_hook(&packet, || {
                let mut edited = bytes.clone();
                *edited.last_mut().unwrap() = 1;
                fs::write(&staged, edited).unwrap();
                fs::File::options()
                    .write(true)
                    .open(&staged)
                    .unwrap()
                    .set_times(fs::FileTimes::new().set_modified(original_modified))
                    .unwrap();
            })
            .is_err());
        assert!(take.capture_recovery().is_err());
        take.retain_if_audio();
    }
    #[test]
    fn recording_refuses_external_directory_and_linked_storage_without_mutating_it() {
        let fixture = RecordingFixture::new();
        let outside = fixture.0.join("elsewhere");
        assert!(RecordingTake::prepare_at(&fixture.0, outside.clone(), 1, 1).is_err());
        assert!(!outside.exists());
        #[cfg(unix)]
        {
            fs::create_dir(&outside).unwrap();
            std::os::unix::fs::symlink(&outside, fixture.0.join("training-recordings")).unwrap();
            assert!(RecordingTake::prepare_at(
                &fixture.0,
                fixture.0.join("training-recordings"),
                1,
                1
            )
            .is_err());
            assert_eq!(fs::read_dir(outside).unwrap().count(), 0);
        }
    }
    #[test]
    fn forged_path_duration_and_format_receipts_cannot_publish_recordings() {
        let fixture = RecordingFixture::new();
        let mut take = fixture.take();
        fs::write(&take.staged, recording_bytes(16000, 1600)).unwrap();
        let mut packet = recording_packet(&take, 16000, 1600);
        packet["path"] = json!(fixture.0.join("elsewhere.wav"));
        assert!(take.publish(&packet).is_err());
        packet = recording_packet(&take, 16000, 1600);
        packet["seconds"] = json!(15.);
        assert!(take.publish(&packet).is_err());
        packet = recording_packet(&take, 16000, 1600);
        packet["sampleRate"] = json!(48000);
        assert!(take.publish(&packet).is_err());
        assert!(!take.directory.join(&take.filename).exists());
    }
    #[test]
    fn recording_wav_rejects_stereo_float_empty_truncated_overlong_and_rate_mismatch() {
        let bytes = recording_bytes(48000, 4800);
        let header: [u8; 44] = bytes[..44].try_into().unwrap();
        assert_eq!(
            recording_wav(&header, bytes.len() as u64).unwrap(),
            (0.1, 48000)
        );
        for (offset, value) in [(20, 3u16), (22, 2u16), (32, 4u16), (34, 32u16)] {
            let mut bad = header;
            bad[offset..offset + 2].copy_from_slice(&value.to_le_bytes());
            assert!(recording_wav(&bad, bytes.len() as u64).is_err());
        }
        assert!(recording_wav(&header, bytes.len() as u64 - 1).is_err());
        let empty = recording_bytes(48000, 0);
        assert!(recording_wav(empty[..44].try_into().unwrap(), 44).is_err());
        let long = recording_bytes(8000, 31 * 8000);
        assert!(recording_wav(long[..44].try_into().unwrap(), long.len() as u64).is_err());
    }
    #[test]
    fn recording_staged_symlink_never_overwrites_or_reads_foreign_audio() {
        #[cfg(unix)]
        {
            let fixture = RecordingFixture::new();
            let mut take = fixture.take();
            let foreign = fixture.0.join("foreign.wav");
            let bytes = recording_bytes(16000, 160);
            fs::write(&foreign, &bytes).unwrap();
            std::os::unix::fs::symlink(&foreign, &take.staged).unwrap();
            assert!(take.publish(&recording_packet(&take, 16000, 160)).is_err());
            assert_eq!(fs::read(foreign).unwrap(), bytes);
            assert!(!take.directory.join(&take.filename).exists());
        }
    }
    #[test]
    fn recording_command_quoting_keeps_unicode_spaces_and_backslashes_but_refuses_controls() {
        let text = r#"/tmp/голос \"take\"\rec.wav"#;
        assert_eq!(
            quote_path(Path::new(text)).unwrap(),
            serde_json::to_string(text).unwrap()
        );
        assert!(quote_path(Path::new("/tmp/bad\nname.wav")).is_err());
        let valid = "\\".repeat(1749);
        assert_eq!(quote_path(Path::new(&valid)).unwrap().len(), 3500);
        let oversized = "\\".repeat(1750);
        assert!(oversized.len() < 3000);
        assert!(quote_path(Path::new(&oversized)).is_err());
    }
    #[test]
    fn recording_receipts_keep_take_identity_when_telemetry_generation_is_revoked() {
        let events = Arc::new(Mutex::new(VecDeque::new()));
        recording_event(&events, 41, 9, RecordingState::Started);
        recording_event(
            &events,
            41,
            9,
            RecordingState::Finished {
                path: PathBuf::from("saved.wav"),
                filename: "saved.wav".into(),
                seconds: 1.,
                sample_rate: 48000,
            },
        );
        let rows = events.lock().unwrap();
        assert!(rows
            .iter()
            .all(|row| row.generation == 41 && row.take_id == 9));
        assert!(matches!(
            rows[1].state,
            RecordingState::Finished {
                sample_rate: 48000,
                ..
            }
        ));
    }
    #[test]
    fn recording_admission_refuses_player_settings_and_monitor_owners() {
        for owner in [0, 1, 2, 3, 5] {
            assert!(recording_owner(true, false, owner).is_err());
        }
        assert!(recording_owner(true, false, crate::training_capture::TRAINING_OWNER).is_ok());
        assert!(recording_owner(false, false, crate::training_capture::TRAINING_OWNER).is_err());
        assert!(recording_owner(true, true, crate::training_capture::TRAINING_OWNER).is_err());
    }
}

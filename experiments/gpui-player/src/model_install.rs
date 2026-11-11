//! Cancellable native downloader and recoverable cache publication. curl/tar
//! are invoked directly (no shell, Node, Electron or downloaded code execution).
use super::model_catalog::{Config, Entry, FileKind, Flavor, Part};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
#[cfg(test)]
use std::sync::Arc;
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Command, Stdio},
    sync::atomic::{AtomicU64, Ordering},
    thread,
    time::{Duration, Instant},
};
static SERIAL: AtomicU64 = AtomicU64::new(1);
pub fn cancelled(serial: &AtomicU64, generation: u64) -> Result<()> {
    ensure!(
        serial.load(Ordering::Acquire) == generation,
        "Model download cancelled"
    );
    Ok(())
}
fn token() -> String {
    format!(
        "{}-{}-{}",
        std::process::id(),
        super::training_store::now(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    )
}
fn sibling(path: &Path, id: &str, kind: &str) -> PathBuf {
    path.with_file_name(format!(
        ".{}.gpui-{id}.{kind}",
        path.file_name().unwrap().to_string_lossy()
    ))
}
fn remove(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) => {
            if m.is_dir() && !m.file_type().is_symlink() {
                fs::remove_dir_all(path)?;
            } else {
                fs::remove_file(path)?;
            }
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e.into()),
    }
}
fn sync_dir(dir: &Path) -> Result<()> {
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    let _ = dir;
    Ok(())
}
fn regular(path: &Path, min: u64) -> bool {
    fs::metadata(path).is_ok_and(|m| m.is_file() && m.len() >= min)
}
pub fn valid_part(path: &Path, part: &Part) -> bool {
    if !regular(path, part.min_bytes) {
        return false;
    }
    let mut magic = [0u8; 4];
    if File::open(path)
        .and_then(|mut f| f.read_exact(&mut magic))
        .is_err()
    {
        return false;
    }
    match part.kind {
        FileKind::Gguf => magic == *b"GGUF",
        FileKind::Archive => magic[0..2] == [0x1f, 0x8b],
        FileKind::Torch => magic[0..2] == *b"PK" || magic[0] == 0x80,
        FileKind::Onnx => true,
    }
}
pub fn pack_format_compatible(config: &Config, root: &Path) -> bool {
    let raw = fs::read(root.join("python/pack.json"))
        .ok()
        .filter(|b| b.len() <= 65536)
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok());
    if config.flavor == Flavor::Linux {
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else if cfg!(target_arch = "x86_64") { "x64" } else { return false; };
        let expected = format!("linux-{arch}");
        if raw.as_ref().and_then(|value| value["target"].as_str()) != Some(expected.as_str()) {
            return false;
        }
    }
    raw.as_ref()
        .and_then(|v| v["formatVersion"].as_u64())
        .unwrap_or(0)
        >= config.flavor.pack_format()
}
pub fn pack_complete(config: &Config, root: &Path) -> bool {
    let python = if config.flavor == Flavor::Windows {
        root.join("python/python.exe")
    } else {
        root.join("python/bin/python3")
    };
    if !regular(&python, 1) || !regular(&root.join("python/models/uvr/UVR_MDXNET_KARA_2.onnx"), 1) {
        return false;
    }
    if !pack_format_compatible(config, root) {
        return false;
    }
    if config.flavor == Flavor::AppleSilicon {
        return true;
    }
    let snapshots = root.join("python/model-cache/models--StemSplitio--htdemucs-6s-onnx/snapshots");
    fs::read_dir(snapshots).ok().is_some_and(|entries| {
        entries.take(10000).filter_map(Result::ok).any(|e| {
            regular(
                &e.path().join("htdemucs_6s_fp16weights.onnx"),
                if config.fixture { 1 } else { 100_000_001 },
            )
        })
    })
}
pub fn present(config: &Config, entry: &Entry) -> bool {
    if entry.archive {
        pack_complete(config, &config.pack)
    } else {
        entry
            .parts
            .iter()
            .all(|p| valid_part(&config.models.join(&p.file), p))
    }
}
pub fn missing_mb(config: &Config, entry: &Entry) -> u64 {
    if entry.archive {
        return entry.mb();
    }
    let mb = entry
        .parts
        .iter()
        .filter(|p| !valid_part(&config.models.join(&p.file), p))
        .map(|p| p.mb)
        .sum::<u64>();
    if mb == 0 { entry.mb() } else { mb }
}
// A child may exit while a descendant still owns its pipes. Readers must stay
// interruptible independently of the direct child's lifetime.
trait PipeRead: Read + Send {
    fn ready(&self) -> std::io::Result<bool>;
}
#[cfg(unix)]
impl<T: Read + Send + std::os::fd::AsRawFd> PipeRead for T {
    fn ready(&self) -> std::io::Result<bool> {
        #[repr(C)]
        struct PollFd {
            fd: i32,
            events: i16,
            revents: i16,
        }
        #[cfg(target_os = "macos")]
        type Nfds = u32;
        #[cfg(not(target_os = "macos"))]
        type Nfds = usize;
        unsafe extern "C" {
            fn poll(fds: *mut PollFd, nfds: Nfds, timeout: i32) -> i32;
        }
        let mut fd = PollFd {
            fd: self.as_raw_fd(),
            events: 1,
            revents: 0,
        };
        let result = unsafe { poll(&mut fd, 1, 0) };
        if result < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() == std::io::ErrorKind::Interrupted {
                Ok(false)
            } else {
                Err(error)
            }
        } else {
            Ok(result > 0)
        }
    }
}
#[cfg(windows)]
impl<T: Read + Send + std::os::windows::io::AsRawHandle> PipeRead for T {
    fn ready(&self) -> std::io::Result<bool> {
        #[link(name = "kernel32")]
        unsafe extern "system" {
            fn PeekNamedPipe(
                pipe: *mut std::ffi::c_void,
                buffer: *mut std::ffi::c_void,
                size: u32,
                read: *mut u32,
                available: *mut u32,
                left: *mut u32,
            ) -> i32;
        }
        let mut available = 0;
        if unsafe {
            PeekNamedPipe(
                self.as_raw_handle(),
                std::ptr::null_mut(),
                0,
                std::ptr::null_mut(),
                &mut available,
                std::ptr::null_mut(),
            )
        } != 0
        {
            Ok(available > 0)
        } else {
            let error = std::io::Error::last_os_error();
            if error.raw_os_error() == Some(109) {
                Ok(true)
            } else {
                Err(error)
            }
        }
    }
}
struct Process {
    child: std::process::Child,
    retired: bool,
    #[cfg(unix)]
    pid_reserved: bool,
    #[cfg(unix)]
    group_gone: bool,
    #[cfg(all(test, unix))]
    last_waitid: Option<(i32, i32, i32)>,
}
impl Process {
    fn exit_status(&mut self) -> std::io::Result<Option<std::process::ExitStatus>> {
        #[cfg(unix)]
        {
            use std::os::unix::process::ExitStatusExt;
            let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
            let result = unsafe {
                libc::waitid(
                    libc::P_PID,
                    self.child.id() as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            };
            #[cfg(test)]
            {
                self.last_waitid = Some((unsafe { info.si_pid() }, info.si_code, unsafe {
                    info.si_status()
                }));
            }
            if result != 0 {
                let error = std::io::Error::last_os_error();
                if error.kind() == std::io::ErrorKind::Interrupted {
                    return Ok(None);
                }
                if error.raw_os_error() == Some(libc::ECHILD) {
                    self.pid_reserved = false;
                }
                return Err(error);
            }
            if unsafe { info.si_pid() } == 0 {
                return Ok(None);
            }
            let code = unsafe { info.si_status() };
            let raw = match info.si_code {
                libc::CLD_EXITED => code << 8,
                libc::CLD_KILLED => code,
                libc::CLD_DUMPED => code | 0x80,
                _ => return Ok(None),
            };
            return Ok(Some(std::process::ExitStatus::from_raw(raw)));
        }
        #[cfg(not(unix))]
        self.child.try_wait()
    }
    fn retire(&mut self, budget: Duration) {
        #[cfg(unix)]
        {
            if !self.pid_reserved {
                return;
            }
            let deadline = Instant::now() + budget;
            while !self.group_gone {
                // WNOWAIT retains the direct child's PID throughout cleanup.
                // Stop revisiting the numeric group immediately after ESRCH.
                let result =
                    unsafe { libc::kill(-(self.child.id() as libc::pid_t), libc::SIGKILL) };
                if result != 0
                    && std::io::Error::last_os_error().raw_os_error() == Some(libc::ESRCH)
                {
                    self.group_gone = true;
                    break;
                }
                if Instant::now() >= deadline {
                    break;
                }
                thread::sleep(
                    Duration::from_millis(5)
                        .min(deadline.saturating_duration_since(Instant::now())),
                );
            }
            if !self.retired {
                let _ = self.child.kill();
            }
        }
        #[cfg(not(unix))]
        {
            let _ = budget;
            if !self.retired {
                let _ = self.child.kill();
            }
        }
        self.retired = true;
    }
}
impl Drop for Process {
    fn drop(&mut self) {
        #[cfg(unix)]
        if !self.pid_reserved {
            return;
        }
        // A late fork can register after an earlier signal. Make the final
        // bounded group pass while the leader still reserves its PID, then reap.
        self.retire(Duration::from_millis(100));
        let _ = self.child.wait();
        #[cfg(unix)]
        {
            self.pid_reserved = false;
        }
    }
}
struct CapturedPipe<R> {
    input: R,
    bytes: Vec<u8>,
    limit: usize,
    fail_on_overflow: bool,
    diagnostic_line: Vec<u8>,
    eof: bool,
}
impl<R: PipeRead> CapturedPipe<R> {
    fn new(input: R, limit: usize, fail_on_overflow: bool) -> Self {
        Self {
            input,
            bytes: Vec::new(),
            limit,
            fail_on_overflow,
            diagnostic_line: Vec::new(),
            eof: false,
        }
    }
    fn drain(&mut self) -> Result<bool> {
        let mut received = false;
        let mut buffer = [0u8; 8192];
        // Fair bounded rounds keep both pipes flowing and cancellation/progress
        // callbacks live even when one stream writes continuously.
        for _ in 0..64 {
            if self.eof || !self.input.ready()? {
                break;
            }
            let n = match self.input.read(&mut buffer) {
                Ok(0) => {
                    self.eof = true;
                    break;
                }
                Ok(n) => n,
                Err(error)
                    if matches!(
                        error.kind(),
                        std::io::ErrorKind::Interrupted | std::io::ErrorKind::WouldBlock
                    ) =>
                {
                    continue;
                }
                Err(error) if error.kind() == std::io::ErrorKind::BrokenPipe => {
                    self.eof = true;
                    break;
                }
                Err(error) => return Err(error.into()),
            };
            received = true;
            if self.bytes.len() + n > self.limit {
                ensure!(
                    !self.fail_on_overflow,
                    "Native tool output exceeded its bound"
                );
                let keep = self.limit.saturating_sub(n);
                self.bytes.drain(..self.bytes.len().saturating_sub(keep));
            }
            self.bytes.extend_from_slice(&buffer[..n]);
            if !self.fail_on_overflow {
                for byte in &buffer[..n] {
                    if matches!(*byte, b'\r' | b'\n') {
                        diagnostic_stderr(&self.diagnostic_line);
                        self.diagnostic_line.clear();
                    } else {
                        self.diagnostic_line.push(*byte);
                        if self.diagnostic_line.len() >= 8192 {
                            diagnostic_stderr(&self.diagnostic_line);
                            self.diagnostic_line.clear();
                        }
                    }
                }
            }
        }
        if self.eof {
            self.finish_diagnostics();
        }
        Ok(received)
    }
}
impl<R> CapturedPipe<R> {
    fn finish_diagnostics(&mut self) {
        if !self.fail_on_overflow {
            diagnostic_stderr(&self.diagnostic_line);
            self.diagnostic_line.clear();
        }
    }
}
impl<R> Drop for CapturedPipe<R> {
    fn drop(&mut self) {
        self.finish_diagnostics();
    }
}
fn wait_for_pipes(
    stdout: &CapturedPipe<std::process::ChildStdout>,
    stderr: &CapturedPipe<std::process::ChildStderr>,
) -> std::io::Result<()> {
    #[cfg(unix)]
    {
        use std::os::fd::AsRawFd;
        // Small Linux pipes can become empty before the writer is scheduled
        // again. Wake on either stream instead of adding a fixed sleep to
        // every producer/consumer handoff. The cancellation bound stays 5 ms.
        let mut descriptors = [
            libc::pollfd {
                fd: if stdout.eof { -1 } else { stdout.input.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
            libc::pollfd {
                fd: if stderr.eof { -1 } else { stderr.input.as_raw_fd() },
                events: libc::POLLIN,
                revents: 0,
            },
        ];
        if unsafe { libc::poll(descriptors.as_mut_ptr(), descriptors.len() as libc::nfds_t, 5) } < 0 {
            let error = std::io::Error::last_os_error();
            if error.kind() != std::io::ErrorKind::Interrupted {
                return Err(error);
            }
        }
    }
    #[cfg(not(unix))]
    {
        let _ = (stdout, stderr);
        thread::sleep(Duration::from_millis(5));
    }
    Ok(())
}
fn command(
    command: Command,
    serial: &AtomicU64,
    generation: u64,
    timeout: Duration,
    poll: impl FnMut() -> Result<()>,
) -> Result<Vec<u8>> {
    command_observe(command, serial, generation, timeout, poll, |_, _| Ok(()))
}
#[cfg(test)]
#[derive(Default)]
struct CommandTrace {
    rounds: u64,
    last_round: Option<Instant>,
    longest_round_gap: Duration,
    poll: Duration,
    stdout: Duration,
    stderr: Duration,
    observe: Duration,
    exit: Duration,
    retire: Duration,
}
#[cfg(test)]
fn command_timeout_detail(
    process: &Process,
    stdout_eof: bool,
    stderr_eof: bool,
    stdout_bytes: usize,
    stderr_bytes: usize,
    exit_seen: bool,
    trace: &CommandTrace,
) -> String {
    let mut state = String::from("unavailable");
    #[cfg(target_os = "macos")]
    {
        let mut info: libc::proc_bsdinfo = unsafe { std::mem::zeroed() };
        let size = std::mem::size_of::<libc::proc_bsdinfo>();
        if unsafe {
            libc::proc_pidinfo(
                process.child.id() as i32,
                libc::PROC_PIDTBSDINFO,
                0,
                (&mut info as *mut libc::proc_bsdinfo).cast(),
                size as i32,
            )
        } == size as i32
        {
            state = format!(
                "status:{} ppid:{} pgid:{}",
                info.pbi_status, info.pbi_ppid, info.pbi_pgid
            );
        }
    }
    #[cfg(target_os = "linux")]
    {
        if let Ok(stat) = fs::read_to_string(format!("/proc/{}/stat", process.child.id())) {
            if let Some((_, fields)) = stat.rsplit_once(')') {
                let values = fields.split_whitespace().collect::<Vec<_>>();
                if values.len() >= 3 {
                    state = format!("status:{} ppid:{} pgid:{}", values[0], values[1], values[2]);
                }
            }
        }
    }
    #[cfg(unix)]
    let wait = format!("{:?}", process.last_waitid);
    #[cfg(not(unix))]
    let wait = String::from("owned process handle");
    format!(
        "Native download/extraction timed out (pid:{} exit_seen:{exit_seen} stdout_eof:{stdout_eof} stderr_eof:{stderr_eof} stdout_bytes:{stdout_bytes} stderr_bytes:{stderr_bytes} retired:{} rounds:{} longest_round_gap:{:?} poll:{:?} stdout_drain:{:?} stderr_drain:{:?} observe:{:?} exit_poll:{:?} retire:{:?} last_waitid:{wait} os:{state})",
        process.child.id(),
        process.retired,
        trace.rounds,
        trace.longest_round_gap,
        trace.poll,
        trace.stdout,
        trace.stderr,
        trace.observe,
        trace.exit,
        trace.retire
    )
}
/// Completion is the actual direct tool's exit status plus drained output, not
/// proof that a descriptor inherited by an escaped/unrelated process reached EOF.
/// Its currently buffered bytes are retained after owned descendants are retired.
pub(super) fn command_observe(
    mut command: Command,
    serial: &AtomicU64,
    generation: u64,
    timeout: Duration,
    mut poll: impl FnMut() -> Result<()>,
    mut observe: impl FnMut(&[u8], &[u8]) -> Result<()>,
) -> Result<Vec<u8>> {
    cancelled(serial, generation)?;
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        command.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let child = command
        .spawn()
        .context("Could not start the native download/extraction tool")?;
    let mut process = Process {
        child,
        retired: false,
        #[cfg(unix)]
        pid_reserved: true,
        #[cfg(unix)]
        group_gone: false,
        #[cfg(all(test, unix))]
        last_waitid: None,
    };
    let mut stdout = CapturedPipe::new(
        process
            .child
            .stdout
            .take()
            .context("Native tool stdout missing")?,
        16 * 1024 * 1024,
        true,
    );
    let mut stderr = CapturedPipe::new(
        process
            .child
            .stderr
            .take()
            .context("Native tool stderr missing")?,
        64 * 1024,
        false,
    );
    let deadline = Instant::now() + timeout;
    let mut exited = None;
    let mut exited_at = None;
    let mut quiet_since = None;
    #[cfg(test)]
    let mut trace = CommandTrace::default();
    macro_rules! phase {
        ($field:ident, $expression:expr) => {{
            #[cfg(test)]
            let began = Instant::now();
            let value = $expression;
            #[cfg(test)]
            {
                trace.$field += began.elapsed();
            }
            value
        }};
    }
    let status = loop {
        cancelled(serial, generation)?;
        #[cfg(test)]
        {
            trace.rounds += 1;
            if let Some(previous) = trace.last_round.replace(Instant::now()) {
                trace.longest_round_gap = trace.longest_round_gap.max(previous.elapsed());
            }
        }
        if Instant::now() >= deadline {
            #[cfg(test)]
            anyhow::bail!(
                "{}",
                command_timeout_detail(
                    &process,
                    stdout.eof,
                    stderr.eof,
                    stdout.bytes.len(),
                    stderr.bytes.len(),
                    exited.is_some(),
                    &trace
                )
            );
            #[cfg(not(test))]
            anyhow::bail!("Native download/extraction timed out");
        }
        phase!(poll, poll())?;
        let out = phase!(stdout, stdout.drain())?;
        let err = phase!(stderr, stderr.drain())?;
        phase!(observe, observe(&stdout.bytes, &stderr.bytes))?;
        if exited.is_none() {
            exited = phase!(exit, process.exit_status())?;
            if exited.is_some() {
                exited_at = Some(Instant::now());
            }
        }
        if let Some(status) = exited {
            if stdout.eof && stderr.eof {
                break status;
            }
            // Preserve tools which finish a last short-lived writer after the
            // direct process exits. The caller's existing deadline remains hard.
            if !process.retired
                && exited_at.is_some_and(|at| at.elapsed() >= Duration::from_millis(500))
            {
                phase!(
                    retire,
                    process.retire(
                        Duration::from_millis(100)
                            .min(deadline.saturating_duration_since(Instant::now())),
                    )
                );
            }
            if process.retired {
                if out || err {
                    quiet_since = None;
                } else {
                    let quiet = quiet_since.get_or_insert_with(Instant::now);
                    if quiet.elapsed() >= Duration::from_millis(20) {
                        break status;
                    }
                }
            }
        }
        if !out && !err {
            wait_for_pipes(&stdout, &stderr)?;
        }
    };
    stdout.finish_diagnostics();
    stderr.finish_diagnostics();
    observe(&stdout.bytes, &stderr.bytes)?;
    let error = String::from_utf8_lossy(&stderr.bytes)
        .chars()
        .rev()
        .take(2000)
        .collect::<String>()
        .chars()
        .rev()
        .collect::<String>();
    ensure!(
        status.success(),
        "{}",
        if error.trim().is_empty() {
            "Native download/extraction failed"
        } else {
            error.trim()
        }
    );
    Ok(std::mem::take(&mut stdout.bytes))
}
fn diagnostic_stderr(bytes: &[u8]) {
    if bytes.is_empty() {
        return;
    }
    static SKIP: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    let skip = SKIP.get_or_init(|| {
        regex::Regex::new(r"(?i)(^\s*p\s+\d+(?:\.\d+)?\s*$|\d{1,3}%\||^\s*chunk\s+\d+\s*/\s*\d+)")
            .unwrap()
    });
    crate::diagnostics::chunk("engine", &String::from_utf8_lossy(bytes), Some(skip));
}
fn fetch(
    part: &Part,
    destination: &Path,
    fixture: bool,
    serial: &AtomicU64,
    generation: u64,
    mut progress: impl FnMut(f32),
) -> Result<()> {
    let parent = destination.parent().context("Invalid model destination")?;
    fs::create_dir_all(parent)?;
    let mut curl = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    curl.args([
        "--location",
        "--fail",
        "--silent",
        "--show-error",
        "--connect-timeout",
        "20",
        "--max-time",
        "7200",
        "--retry",
        "2",
        "--retry-delay",
        "1",
        "--proto",
        if fixture { "=http,https" } else { "=https" },
        "--proto-redir",
        if fixture { "=http,https" } else { "=https" },
        "--output",
    ])
    .arg(destination)
    .args(["--write-out", "%{http_code}", "--url"])
    .arg(&part.url);
    let maximum = (part.mb * 1_000_000 * 3).max(part.min_bytes);
    let result = command(curl, serial, generation, Duration::from_secs(7250), || {
        let bytes = fs::metadata(destination).map_or(0, |m| m.len());
        ensure!(
            bytes <= maximum,
            "Model download exceeded its expected size"
        );
        progress((bytes as f64 / (part.mb as f64 * 1e6) * 99.).min(99.) as f32);
        Ok(())
    })?;
    ensure!(
        result == b"200",
        "Unexpected HTTP response while downloading model"
    );
    ensure!(
        valid_part(destination, part),
        "Downloaded model is incomplete or has an incompatible format"
    );
    // Flushing a completed file requires write access on Windows.
    OpenOptions::new()
        .write(true)
        .open(destination)?
        .sync_all()?;
    cancelled(serial, generation)?;
    Ok(())
}
fn extract(
    archive: &Path,
    destination: &Path,
    serial: &AtomicU64,
    generation: u64,
    progress: &mut impl FnMut(f32),
) -> Result<()> {
    let mut list = Command::new("tar");
    list.arg("-tzf").arg(archive);
    let entries = command(list, serial, generation, Duration::from_secs(600), || {
        progress(92.);
        Ok(())
    })?;
    let names = std::str::from_utf8(&entries).context("Invalid archive entry names")?;
    ensure!(!names.is_empty(), "Downloaded pack is empty");
    for name in names.lines() {
        let normalized = name.replace('\\', "/");
        ensure!(
            !normalized.contains(':')
                && Path::new(&normalized)
                    .components()
                    .all(|c| matches!(c, Component::Normal(_) | Component::CurDir)),
            "Pack contains a path outside its installation folder"
        );
    }
    fs::create_dir_all(destination)?;
    let mut tar = Command::new("tar");
    tar.arg("-xzf").arg(archive).arg("-C").arg(destination);
    command(tar, serial, generation, Duration::from_secs(1200), || {
        progress(92.);
        Ok(())
    })?;
    let root = destination.canonicalize()?;
    let mut stack = vec![root.clone()];
    let mut bytes = 0u64;
    let mut count = 0;
    while let Some(dir) = stack.pop() {
        cancelled(serial, generation)?;
        for entry in fs::read_dir(dir)? {
            let entry = entry?;
            count += 1;
            ensure!(count <= 250_000, "Pack contains too many files");
            let meta = fs::symlink_metadata(entry.path())?;
            if meta.file_type().is_symlink() {
                ensure!(
                    entry.path().canonicalize()?.starts_with(&root),
                    "Pack contains a link outside its installation folder"
                );
            } else if meta.is_dir() {
                stack.push(entry.path());
            } else {
                ensure!(
                    meta.is_file(),
                    "Pack contains an unsupported filesystem entry"
                );
                bytes = bytes
                    .checked_add(meta.len())
                    .context("Pack size overflow")?;
                ensure!(bytes <= 20_000_000_000, "Expanded pack exceeds size limit");
            }
        }
    }
    Ok(())
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Change {
    file: PathBuf,
    old: bool,
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct Journal {
    version: u8,
    id: String,
    committed: bool,
    changes: Vec<Change>,
}
fn location(config: &Config, entry: &Entry, file: &Path) -> PathBuf {
    if entry.archive {
        config.pack.clone()
    } else {
        config.models.join(file)
    }
}
fn journal_path(config: &Config, entry: &Entry) -> PathBuf {
    let parent = if entry.archive {
        config.pack.parent().unwrap()
    } else {
        &config.models
    };
    parent.join(format!(".gpui-model-{}.transaction.json", entry.id))
}
fn publish_journal(path: &Path, journal: &Journal) -> Result<()> {
    let temporary = sibling(path, &journal.id, "journal");
    let mut file = OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(&temporary)?;
    let result = (|| {
        file.write_all(&serde_json::to_vec(journal)?)?;
        file.sync_all()?;
        super::project_store::replace(&temporary, path)?;
        sync_dir(path.parent().unwrap())
    })();
    let _ = remove(&temporary);
    result
}
fn finish(config: &Config, entry: &Entry, journal: &Journal) -> Result<()> {
    for change in &journal.changes {
        let dest = location(config, entry, &change.file);
        let previous = sibling(&dest, &journal.id, "previous");
        let incoming = sibling(&dest, &journal.id, "incoming");
        if !journal.committed {
            if previous.exists() {
                remove(&dest)?;
                fs::rename(&previous, &dest)?;
            } else if !change.old && !incoming.exists() {
                remove(&dest)?;
            }
        }
        remove(&incoming)?;
        remove(&previous)?;
        sync_dir(dest.parent().unwrap())?;
    }
    remove(&journal_path(config, entry))?;
    sync_dir(journal_path(config, entry).parent().unwrap())
}
fn recover(config: &Config, entry: &Entry) -> Result<()> {
    let path = journal_path(config, entry);
    let file = match File::open(&path) {
        Ok(f) => f,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
        Err(e) => return Err(e.into()),
    };
    let mut bytes = vec![];
    file.take(16385).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 16384, "Invalid model transaction journal");
    let journal: Journal = serde_json::from_slice(&bytes)?;
    ensure!(
        journal.version == 1
            && !journal.id.is_empty()
            && journal.id.len() < 80
            && journal.id.bytes().all(|b| b.is_ascii_digit() || b == b'-')
            && !journal.changes.is_empty()
            && journal.changes.len() <= 3,
        "Invalid model transaction identity"
    );
    let mut files = std::collections::BTreeSet::new();
    for change in &journal.changes {
        ensure!(
            entry.parts.iter().any(|p| p.file == change.file) && files.insert(&change.file),
            "Model transaction contains an unrelated path"
        );
    }
    finish(config, entry, &journal)
}
pub fn cache_lock(config: &Config, entry: &Entry) -> Result<crate::file_lease::Lease> {
    let dir = if entry.archive {
        config.pack.parent().unwrap()
    } else {
        &config.models
    };
    fs::create_dir_all(dir)?;
    let file = OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(dir.join(format!(".gpui-model-{}.lock", entry.id)))?;
    crate::file_lease::Lease::acquire(file)
        .context("Another SingZ instance is installing this model")
}
pub fn recover_entry(config: &Config, entry: &Entry) -> Result<()> {
    let _lock = cache_lock(config, entry)?;
    recover(config, entry)
}
fn publish_pack(config: &Config, staging: &Path) -> Result<()> {
    if pack_complete(config, &config.pack) {
        remove(staging)?;
        return Ok(());
    }
    ensure!(
        !fs::symlink_metadata(&config.pack)
            .is_ok_and(|meta| meta.is_dir() || meta.file_type().is_symlink()),
        "An incomplete splitter pack already exists; it was left untouched"
    );
    ensure!(pack_complete(config, staging), "Downloaded splitter pack is incompatible with this build");
    fs::rename(staging, &config.pack).context("Could not publish the verified splitter pack")?;
    sync_dir(config.pack.parent().unwrap())
}

fn install_pack(
    config: &Config,
    part: &Part,
    serial: &AtomicU64,
    generation: u64,
    progress: &mut impl FnMut(f32),
) -> Result<()> {
    if pack_complete(config, &config.pack) { return Ok(()); }
    ensure!(
        !fs::symlink_metadata(&config.pack)
            .is_ok_and(|meta| meta.is_dir() || meta.file_type().is_symlink()),
        "An incomplete splitter pack already exists; it was left untouched"
    );
    let id = token();
    let archive = sibling(&config.pack, &id, "tar.gz");
    let staging = sibling(&config.pack, &id, "incoming");
    // Reserve this exact unique sibling before any cleanup can own it.
    fs::create_dir(&staging)?;
    let result = (|| {
        fetch(part, &archive, config.fixture, serial, generation, |p| progress(p * 0.9))?;
        progress(92.);
        extract(&archive, &staging, serial, generation, progress)?;
        ensure!(pack_complete(config, &staging), "Downloaded splitter pack is incompatible with this build");
        cancelled(serial, generation)?;
        publish_pack(config, &staging)?;
        Ok(())
    })();
    let _ = remove(&archive);
    if result.is_err() { let _ = remove(&staging); }
    result
}

pub fn install(
    config: &Config,
    entry: &Entry,
    serial: &AtomicU64,
    generation: u64,
    mut progress: impl FnMut(f32),
) -> Result<()> {
    let _lock = cache_lock(config, entry)?;
    recover(config, entry)?;
    cancelled(serial, generation)?;
    if entry.archive {
        let part = entry.parts.first().context("Splitter pack has no archive")?;
        install_pack(config, part, serial, generation, &mut progress)?;
        progress(100.);
        return Ok(());
    }
    let id = token();
    let was_present = present(config, entry);
    let wanted: Vec<_> = entry
        .parts
        .iter()
        .filter(|p| entry.archive || was_present || !valid_part(&config.models.join(&p.file), p))
        .collect();
    let total = wanted.iter().map(|p| p.mb).sum::<u64>().max(1);
    let mut journal = Journal {
        version: 1,
        id,
        committed: false,
        changes: vec![],
    };
    let mut completed = 0u64;
    let mut archive_file = None;
    let result = (|| {
        for part in wanted {
            cancelled(serial, generation)?;
            let dest = location(config, entry, &part.file);
            fs::create_dir_all(dest.parent().unwrap())?;
            let incoming = sibling(&dest, &journal.id, "incoming");
            journal.changes.push(Change {
                file: part.file.clone(),
                old: dest.exists(),
            });
            if entry.archive {
                let archive = sibling(&dest, &journal.id, "tar.gz");
                archive_file = Some(archive.clone());
                fetch(part, &archive, config.fixture, serial, generation, |p| {
                    progress(p * 0.9)
                })?;
                progress(92.);
                extract(&archive, &incoming, serial, generation, &mut progress)?;
                ensure!(
                    pack_complete(config, &incoming),
                    "Downloaded splitter pack is incompatible with this build"
                );
            } else {
                fetch(part, &incoming, config.fixture, serial, generation, |p| {
                    progress(
                        ((completed as f64 + part.mb as f64 * p as f64 / 100.) / total as f64 * 99.)
                            as f32,
                    )
                })?;
                completed += part.mb;
            }
        }
        cancelled(serial, generation)?;
        if journal.changes.is_empty() {
            return Ok(());
        }
        publish_journal(&journal_path(config, entry), &journal)?;
        for change in &journal.changes {
            let dest = location(config, entry, &change.file);
            if change.old {
                fs::rename(&dest, sibling(&dest, &journal.id, "previous"))?;
            }
            fs::rename(sibling(&dest, &journal.id, "incoming"), &dest)?;
            sync_dir(dest.parent().unwrap())?;
        }
        journal.committed = true;
        publish_journal(&journal_path(config, entry), &journal)?;
        Ok(())
    })();
    // Only transaction-owned files are ever removed. A pre-publication error
    // leaves existing destinations intact; a published partial group rolls back.
    let cleanup = if journal_path(config, entry).exists() {
        recover(config, entry)
    } else {
        for change in &journal.changes {
            let _ = remove(&sibling(
                &location(config, entry, &change.file),
                &journal.id,
                "incoming",
            ));
        }
        Ok(())
    };
    if let Some(archive) = archive_file {
        let _ = remove(&archive);
    }
    result?;
    cleanup?;
    progress(100.);
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(Config, Entry);
    impl Fixture {
        fn new() -> Self {
            let root = std::env::temp_dir().join(format!(
                "singz-model-install-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir_all(root.join("models")).unwrap();
            let parts = ["one.gguf", "two.gguf", "three.gguf"]
                .into_iter()
                .map(|file| Part {
                    file: file.into(),
                    url: format!("https://example.invalid/{file}"),
                    mb: 1,
                    min_bytes: 4,
                    kind: FileKind::Gguf,
                })
                .collect();
            let entry = Entry {
                id: "qwen-asr".into(),
                label: "Speech".into(),
                description: "Fixture".into(),
                optional: true,
                parts,
                archive: false,
            };
            let config = Config {
                models: root.join("models"),
                pack: root.join("pack"),
                flavor: Flavor::AppleSilicon,
                entries: vec![entry.clone()],
                fixture: true,
            };
            Self(config, entry)
        }
        fn journal(&self, id: &str) -> Journal {
            Journal {
                version: 1,
                id: id.into(),
                committed: false,
                changes: self
                    .1
                    .parts
                    .iter()
                    .map(|p| Change {
                        file: p.file.clone(),
                        old: true,
                    })
                    .collect(),
            }
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(self.0.models.parent().unwrap());
        }
    }
    #[test]
    fn interrupted_multipart_publication_restores_the_entire_working_set() {
        let f = Fixture::new();
        let journal = f.journal("1-2-3");
        for part in &f.1.parts {
            let dest = f.0.models.join(&part.file);
            fs::write(&dest, b"GGUFold").unwrap();
            fs::write(sibling(&dest, &journal.id, "incoming"), b"GGUFnew").unwrap();
        }
        publish_journal(&journal_path(&f.0, &f.1), &journal).unwrap();
        let first = f.0.models.join(&f.1.parts[0].file);
        fs::rename(&first, sibling(&first, &journal.id, "previous")).unwrap();
        fs::rename(sibling(&first, &journal.id, "incoming"), &first).unwrap();
        recover_entry(&f.0, &f.1).unwrap();
        for part in &f.1.parts {
            assert_eq!(fs::read(f.0.models.join(&part.file)).unwrap(), b"GGUFold");
        }
        assert!(!journal_path(&f.0, &f.1).exists());
    }
    #[test]
    fn committed_recovery_keeps_new_models_and_cleans_only_its_own_backups() {
        let f = Fixture::new();
        let mut journal = f.journal("3-2-1");
        journal.committed = true;
        for part in &f.1.parts {
            let dest = f.0.models.join(&part.file);
            fs::write(&dest, b"GGUFnew").unwrap();
            fs::write(sibling(&dest, &journal.id, "previous"), b"GGUFold").unwrap();
        }
        let other = f.0.models.join("other-app.incoming");
        fs::write(&other, b"owned by another job").unwrap();
        publish_journal(&journal_path(&f.0, &f.1), &journal).unwrap();
        recover_entry(&f.0, &f.1).unwrap();
        assert!(other.exists());
        for part in &f.1.parts {
            let dest = f.0.models.join(&part.file);
            assert_eq!(fs::read(&dest).unwrap(), b"GGUFnew");
            assert!(!sibling(&dest, &journal.id, "previous").exists());
        }
    }
    #[test]
    fn untrusted_journal_paths_are_preserved_and_never_replayed() {
        let f = Fixture::new();
        let mut journal = f.journal("1-2");
        journal.changes[0].file = "../outside".into();
        publish_journal(&journal_path(&f.0, &f.1), &journal).unwrap();
        assert!(recover_entry(&f.0, &f.1).is_err());
        assert!(journal_path(&f.0, &f.1).exists());
    }
    #[test]
    fn multipart_presence_requires_all_headers_and_missing_size_is_not_full_size() {
        let f = Fixture::new();
        for part in &f.1.parts[..2] {
            fs::write(f.0.models.join(&part.file), b"GGUFdata").unwrap();
        }
        assert!(!present(&f.0, &f.1));
        assert_eq!(missing_mb(&f.0, &f.1), 1);
        fs::write(f.0.models.join(&f.1.parts[2].file), b"HTMLerror").unwrap();
        assert!(!present(&f.0, &f.1));
        fs::write(f.0.models.join(&f.1.parts[2].file), b"GGUFcomplete").unwrap();
        assert!(present(&f.0, &f.1));
        assert_eq!(missing_mb(&f.0, &f.1), 3);
    }
    #[test]
    fn linux_pack_manifest_must_match_electron_target() {
        let f = Fixture::new();
        let mut config = f.0.clone();
        config.flavor = Flavor::Linux;
        fs::create_dir_all(config.pack.join("python")).unwrap();
        fs::write(config.pack.join("python/pack.json"), br#"{"formatVersion":10,"target":"linux-wrong"}"#).unwrap();
        assert!(!pack_format_compatible(&config, &config.pack));
        let arch = if cfg!(target_arch = "aarch64") { "arm64" } else { "x64" };
        fs::write(config.pack.join("python/pack.json"), format!(r#"{{"formatVersion":10,"target":"linux-{arch}"}}"#)).unwrap();
        assert!(pack_format_compatible(&config, &config.pack));
    }
    #[test]
    fn foreign_incomplete_pack_is_never_used_or_removed() {
        let f = Fixture::new();
        let foreign = f.0.pack.join("python/partial");
        fs::create_dir_all(&foreign).unwrap();
        fs::write(foreign.join("marker"), b"foreign partial install").unwrap();
        let staging = sibling(&f.0.pack, "2-3-4", "incoming");
        fs::create_dir_all(&staging).unwrap();
        assert!(publish_pack(&f.0, &staging).is_err());
        assert_eq!(fs::read(foreign.join("marker")).unwrap(), b"foreign partial install");
        assert!(staging.exists());
    }
    #[test]
    fn cache_lock_is_live_os_ownership_and_is_released_on_drop() {
        let f = Fixture::new();
        let lock = cache_lock(&f.0, &f.1).unwrap();
        assert!(cache_lock(&f.0, &f.1).is_err());
        drop(lock);
        assert!(cache_lock(&f.0, &f.1).is_ok());
    }
    #[test]
    fn native_install_lock_child() {
        let Some(root) = std::env::var_os("SINGZ_TEST_NATIVE_MODEL_LOCK_ROOT") else { return; };
        let root = PathBuf::from(root);
        let config = Config {
            models: root.join("models"),
            pack: root.join("pack"),
            flavor: Flavor::AppleSilicon,
            entries: vec![],
            fixture: true,
        };
        let entry = Entry {
            id: "shared-pack".into(),
            label: "Shared pack".into(),
            description: "Fixture".into(),
            optional: false,
            parts: vec![],
            archive: true,
        };
        let _lock = cache_lock(&config, &entry).unwrap();
        fs::write(root.join("lock-ready"), b"held").unwrap();
        thread::sleep(Duration::from_secs(1));
    }
    #[test]
    fn concurrent_installers_serialize_on_the_shared_native_lock() {
        use std::process::{Command, Stdio};
        let f = Fixture::new();
        let root = f.0.models.parent().unwrap();
        let config = Config {
            models: root.join("models"),
            pack: root.join("pack"),
            flavor: Flavor::AppleSilicon,
            entries: vec![],
            fixture: true,
        };
        let entry = Entry {
            id: "shared-pack".into(),
            label: "Shared pack".into(),
            description: "Fixture".into(),
            optional: false,
            parts: vec![],
            archive: true,
        };
        let ready = root.join("lock-ready");
        let _ = fs::remove_file(&ready);
        let mut child = Command::new(std::env::current_exe().unwrap())
            .args(["--exact", "model_install::tests::native_install_lock_child"])
            .env("SINGZ_TEST_NATIVE_MODEL_LOCK_ROOT", root)
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn().unwrap();
        let deadline = Instant::now() + Duration::from_secs(5);
        while !ready.exists() {
            assert!(child.try_wait().unwrap().is_none(), "lock owner child exited before holding the lock");
            assert!(Instant::now() < deadline, "lock owner child did not acquire the shared pack lock");
            thread::sleep(Duration::from_millis(5));
        }
        assert!(cache_lock(&config, &entry).is_err(), "second installer entered while the child owned the pack lock");
        child.wait().unwrap();
        cache_lock(&config, &entry).expect("installer lock did not recover after owner exit");
    }
    #[test]
    fn native_child_cancellation_is_bounded_and_drains_readers() {
        let serial = Arc::new(AtomicU64::new(1));
        let cancellation = serial.clone();
        let worker = thread::spawn(move || {
            thread::sleep(Duration::from_millis(120));
            cancellation.store(2, Ordering::Release);
        });
        let start = Instant::now();
        let mut sleep = Command::new(if cfg!(windows) { "ping" } else { "sleep" });
        if cfg!(windows) {
            sleep.args(["-n", "20", "127.0.0.1"]);
        } else {
            sleep.arg("20");
        }
        assert!(command(sleep, &serial, 1, Duration::from_secs(5), || Ok(())).is_err());
        assert!(start.elapsed() < Duration::from_secs(2));
        worker.join().unwrap();
    }
    #[cfg(unix)]
    struct DescendantGuard(std::path::PathBuf);
    #[cfg(unix)]
    impl Drop for DescendantGuard {
        fn drop(&mut self) {
            if let Ok(text) = fs::read_to_string(&self.0) {
                if let Some(group) = text
                    .split_whitespace()
                    .next()
                    .and_then(|s| s.parse::<i32>().ok())
                {
                    // Never signal a stale/reused group after command() has
                    // reaped its leader; normal cleanup has already retired it.
                    let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
                    if unsafe {
                        libc::waitid(
                            libc::P_PID,
                            group as libc::id_t,
                            &mut info,
                            libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                        )
                    } == 0
                    {
                        unsafe {
                            libc::kill(-group, libc::SIGKILL);
                        }
                    }
                }
            }
        }
    }
    #[cfg(unix)]
    fn inherited_pipes_command(marker: &Path) -> Command {
        let mut cmd = Command::new("/bin/sh");
        // Both output descriptors intentionally remain open in the background
        // child after the shell exits successfully.
        cmd.args([
            "-c",
            "/bin/sleep 30 & printf '%s %s\n' \"$$\" \"$!\" > \"$1\"; exit 0",
            "diagnostic-descendant",
        ])
        .arg(marker);
        cmd
    }
    #[cfg(unix)]
    fn assert_descendant_stopped(marker: &Path) {
        let text = fs::read_to_string(marker).unwrap();
        let pid = text.split_whitespace().nth(1).unwrap();
        let start = Instant::now();
        loop {
            let output = Command::new("/bin/ps")
                .args(["-p", pid, "-o", "stat="])
                .output()
                .unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            // Some container init implementations delay reaping orphan zombies;
            // a zombie has no running code or open pipe descriptors.
            if !output.status.success() || state.trim().is_empty() || state.trim().starts_with('Z')
            {
                break;
            }
            assert!(
                start.elapsed() < Duration::from_secs(2),
                "owned descendant still runs: {pid} {state}"
            );
            thread::sleep(Duration::from_millis(10));
        }
    }
    #[cfg(unix)]
    #[test]
    fn direct_child_exit_does_not_disable_timeout_for_inherited_pipes() {
        let fixture = Fixture::new();
        let marker = fixture.0.models.join("timeout-child.pid");
        let _cleanup = DescendantGuard(marker.clone());
        let serial = AtomicU64::new(1);
        let start = Instant::now();
        let error = command(
            inherited_pipes_command(&marker),
            &serial,
            1,
            Duration::from_millis(180),
            || Ok(()),
        )
        .unwrap_err();
        assert!(error.to_string().contains("timed out"), "{error:#}");
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_descendant_stopped(&marker);
    }
    #[cfg(unix)]
    #[test]
    fn cancellation_after_direct_exit_stops_inherited_readers_and_owned_descendants() {
        let fixture = Fixture::new();
        let marker = fixture.0.models.join("cancel-child.pid");
        let _cleanup = DescendantGuard(marker.clone());
        let serial = Arc::new(AtomicU64::new(1));
        let cancellation = serial.clone();
        let path = marker.clone();
        let cancel = thread::spawn(move || {
            let start = Instant::now();
            while !path.exists() && start.elapsed() < Duration::from_secs(2) {
                thread::sleep(Duration::from_millis(5));
            }
            thread::sleep(Duration::from_millis(80));
            cancellation.store(2, Ordering::Release);
        });
        let start = Instant::now();
        let error = command(
            inherited_pipes_command(&marker),
            &serial,
            1,
            Duration::from_secs(5),
            || Ok(()),
        )
        .unwrap_err();
        cancel.join().unwrap();
        assert!(error.to_string().contains("cancelled"), "{error:#}");
        assert!(start.elapsed() < Duration::from_secs(2));
        assert_descendant_stopped(&marker);
    }
    #[cfg(unix)]
    #[test]
    fn successful_exit_waits_for_complete_delayed_stdout_and_stderr() {
        let serial = AtomicU64::new(1);
        let mut cmd = Command::new("/bin/sh");
        cmd.args(["-c","printf 'head-'; (/bin/sleep 0.08; printf 'tail'; printf 'delayed stderr' >&2) & exit 0"]);
        let mut observed = Vec::new();
        let output = command_observe(
            cmd,
            &serial,
            1,
            Duration::from_secs(2),
            || Ok(()),
            |_, err| {
                observed = err.to_vec();
                Ok(())
            },
        )
        .unwrap();
        assert_eq!(output, b"head-tail");
        assert_eq!(observed, b"delayed stderr");
    }
    #[cfg(unix)]
    #[test]
    fn exited_tool_retains_final_json_and_stderr_tail_without_waiting_for_escaped_pipes() {
        let fixture = Fixture::new();
        let escaped_pid = fixture.0.models.join("escaped-output.pid");
        let progress_observed = fixture.0.models.join("progress-observed");
        struct EscapedOwner(PathBuf);
        impl Drop for EscapedOwner {
            fn drop(&mut self) {
                if let Some(pid) = fs::read_to_string(&self.0)
                    .ok()
                    .and_then(|value| value.parse::<libc::pid_t>().ok())
                    .filter(|pid| *pid > 1)
                {
                    // This fixture deliberately escaped the invocation's group
                    // and sleeps30s; it remains this test's live child to stop.
                    unsafe {
                        libc::kill(pid, libc::SIGKILL);
                    }
                }
            }
        }
        let escaped_owner = EscapedOwner(escaped_pid.clone());
        let mut cmd = Command::new("python3");
        cmd.args([
            "-c",
            r#"
import json, os, sys, time
sys.stderr.write('p 0.25\n')
sys.stderr.flush()
while not os.path.exists(sys.argv[2]):
    time.sleep(0.005)
sys.stdout.write(json.dumps({'complete': True, 'payload': 'z' * 65536}))
sys.stdout.flush()
sys.stderr.write('d' * 80000 + '\nfinal diagnostic tail\n')
sys.stderr.flush()
child = os.fork()
if child == 0:
    os.setsid()
    with open(sys.argv[1], 'w') as marker:
        marker.write(str(os.getpid()))
    time.sleep(30)
    os._exit(0)
os._exit(0)
"#,
        ])
        .arg(&escaped_pid)
        .arg(&progress_observed);
        let serial = AtomicU64::new(1);
        let mut progress_seen = false;
        let mut final_stderr = Vec::new();
        let started = Instant::now();
        let bytes = command_observe(
            cmd,
            &serial,
            1,
            Duration::from_secs(2),
            || Ok(()),
            |_, err| {
                if err.windows(b"p 0.25".len()).any(|value| value == b"p 0.25") {
                    progress_seen = true;
                    fs::write(&progress_observed, b"actual progress observed")?;
                }
                final_stderr = err.to_vec();
                Ok(())
            },
        )
        .unwrap();
        assert!(started.elapsed() < Duration::from_secs(2));
        let result: serde_json::Value = serde_json::from_slice(&bytes).unwrap();
        assert_eq!(result["complete"], true);
        assert_eq!(result["payload"].as_str().unwrap().len(), 65536);
        assert!(progress_seen);
        let tail = b"\nfinal diagnostic tail\n";
        let mut expected = vec![b'd'; 64 * 1024 - tail.len()];
        expected.extend_from_slice(tail);
        assert_eq!(final_stderr, expected);
        let pid = fs::read_to_string(&escaped_pid)
            .unwrap()
            .parse::<libc::pid_t>()
            .unwrap();
        assert_eq!(
            unsafe { libc::kill(pid, 0) },
            0,
            "fixture did not retain escaped output ownership"
        );
        // The actual parent exit and drained output are complete, not its
        // escaped descendant; teardown retains explicit responsibility for it.
        drop(escaped_owner);
    }
    #[cfg(unix)]
    #[test]
    fn command_timeout_still_retires_a_direct_tool_that_is_alive() {
        let serial = AtomicU64::new(1);
        let mut cmd = Command::new("/bin/sleep");
        cmd.arg("20");
        let mut polls = 0;
        let started = Instant::now();
        let error = command(cmd, &serial, 1, Duration::from_millis(150), || {
            polls += 1;
            Ok(())
        })
        .unwrap_err();
        assert!(error.to_string().contains("timed out"));
        assert!(polls > 0);
        assert!(started.elapsed() < Duration::from_secs(2));
    }
    #[cfg(unix)]
    #[test]
    fn command_stdout_limit_refuses_overflow_without_waiting_for_writer_exit() {
        let serial = AtomicU64::new(1);
        let mut cmd = Command::new("python3");
        cmd.args(["-c", "import sys,time;sys.stdout.buffer.write(b'x'*(16*1024*1024+1));sys.stdout.flush();time.sleep(20)"]);
        let started = Instant::now();
        let error = command(cmd, &serial, 1, Duration::from_secs(5), || Ok(())).unwrap_err();
        assert!(error.to_string().contains("exceeded its bound"), "{error:#}");
        assert!(started.elapsed() < Duration::from_secs(5));
    }
    #[cfg(unix)]
    #[test]
    fn command_exit_peek_reserves_leader_pid_until_the_last_group_signal() {
        use std::os::unix::process::CommandExt;
        let child = Command::new("/bin/sh")
            .args(["-c", "exit 0"])
            .process_group(0)
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .spawn()
            .unwrap();
        let mut process = Process {
            child,
            retired: false,
            pid_reserved: true,
            group_gone: false,
            last_waitid: None,
        };
        let pid = process.child.id();
        let deadline = Instant::now() + Duration::from_secs(2);
        loop {
            if let Some(status) = process.exit_status().unwrap() {
                assert!(status.success());
                break;
            }
            assert!(Instant::now() < deadline);
            thread::sleep(Duration::from_millis(5));
        }
        let mut info: libc::siginfo_t = unsafe { std::mem::zeroed() };
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            0
        );
        assert_eq!(unsafe { info.si_pid() }, pid as libc::pid_t);
        assert!(process.pid_reserved);
        drop(process);
        assert_eq!(
            unsafe {
                libc::waitid(
                    libc::P_PID,
                    pid as libc::id_t,
                    &mut info,
                    libc::WEXITED | libc::WNOHANG | libc::WNOWAIT,
                )
            },
            -1
        );
        assert_eq!(
            std::io::Error::last_os_error().raw_os_error(),
            Some(libc::ECHILD)
        );
    }
}

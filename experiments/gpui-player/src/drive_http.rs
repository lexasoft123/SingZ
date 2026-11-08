//! Worker-only Drive HTTP. Secrets travel in curl's stdin configuration, never argv.
use anyhow::{Context, Result, bail, ensure};
use std::{
    fs::{self, File, OpenOptions},
    io::{BufRead, BufReader, Read, Write},
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

#[derive(Clone, Copy)]
pub enum Body<'a> {
    Empty,
    Bytes(&'a [u8]),
    File(&'a Path),
}
#[derive(Clone, Copy)]
pub enum Destination<'a> {
    Bytes(usize),
    File(&'a Path, u64),
}
#[derive(Clone, Copy)]
pub struct Request<'a> {
    pub method: &'a str,
    pub url: &'a str,
    pub headers: &'a [(&'a str, &'a str)],
    pub body: Body<'a>,
    pub destination: Destination<'a>,
    pub upload: bool,
    pub allow_loopback_http: bool,
}
pub struct Response {
    pub status: u16,
    pub headers: Vec<(String, String)>,
    pub body: Vec<u8>,
    pub bytes: u64,
}
impl Response {
    pub fn json(&self) -> Result<serde_json::Value> {
        serde_json::from_slice(&self.body).context("Drive returned invalid JSON")
    }
    pub fn header(&self, name: &str) -> Option<&str> {
        self.headers
            .iter()
            .rev()
            .find(|(k, _)| k.eq_ignore_ascii_case(name))
            .map(|(_, v)| v.as_str())
    }
}
pub fn validate_url(raw: &str, allow_loopback_http: bool) -> Result<url::Url> {
    ensure!(
        raw.len() <= 16384 && !raw.chars().any(char::is_control),
        "Invalid Drive URL"
    );
    let u = url::Url::parse(raw).map_err(|_| anyhow::anyhow!("Invalid Drive URL"))?;
    ensure!(
        u.username().is_empty()
            && u.password().is_none()
            && u.fragment().is_none()
            && u.host_str().is_some(),
        "Invalid Drive URL"
    );
    let loopback = u
        .host_str()
        .is_some_and(|h| h == "127.0.0.1" || h == "[::1]" || h == "::1");
    ensure!(
        u.scheme() == "https" || (allow_loopback_http && loopback && u.scheme() == "http"),
        "Drive requires HTTPS"
    );
    Ok(u)
}
fn quote(value: &str) -> Result<String> {
    ensure!(
        !value.chars().any(|c| c == '\0' || c == '\r' || c == '\n'),
        "Invalid Drive HTTP option"
    );
    Ok(format!(
        "\"{}\"",
        value.replace('\\', "\\\\").replace('"', "\\\"")
    ))
}
pub(crate) fn random_id() -> Result<String> {
    let mut bytes = [0u8; 24];
    getrandom::fill(&mut bytes).map_err(|_| anyhow::anyhow!("Secure random source unavailable"))?;
    Ok(bytes.iter().map(|b| format!("{b:02x}")).collect())
}
pub(crate) fn private_file(path: &Path) -> Result<File> {
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    options
        .open(path)
        .context("Could not create private Drive file")
}
struct Scratch(PathBuf);
impl Scratch {
    fn new() -> Result<Self> {
        let p = std::env::temp_dir().join(format!("singz-drive-{}", random_id()?));
        let mut builder = fs::DirBuilder::new();
        #[cfg(unix)]
        {
            use std::os::unix::fs::DirBuilderExt;
            builder.mode(0o700);
        }
        builder.create(&p)?;
        Ok(Self(p))
    }
}
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
struct Running(Child);
impl Drop for Running {
    fn drop(&mut self) {
        let _ = self.0.kill();
        let _ = self.0.wait();
    }
}
fn read_response(
    input: impl Read,
    destination: Destination<'_>,
    overflow: &AtomicBool,
    created: &AtomicBool,
    received: &AtomicU64,
) -> Result<Response> {
    let mut reader = BufReader::new(input);
    let mut header_bytes = 0usize;
    let (status, headers) = loop {
        let mut headers = Vec::new();
        let mut line = String::new();
        let n = reader.by_ref().take(65537).read_line(&mut line)?;
        header_bytes += n;
        ensure!(
            n > 0 && header_bytes <= 65536 && line.starts_with("HTTP/"),
            "Invalid Drive HTTP response"
        );
        let status = line
            .split_whitespace()
            .nth(1)
            .and_then(|s| s.parse::<u16>().ok())
            .filter(|s| (100..=599).contains(s))
            .context("Invalid Drive HTTP status")?;
        loop {
            line.clear();
            let n = reader
                .by_ref()
                .take((65537 - header_bytes) as u64)
                .read_line(&mut line)?;
            header_bytes += n;
            ensure!(
                n > 0 && header_bytes <= 65536,
                "Drive response headers exceed limit"
            );
            if line == "\r\n" || line == "\n" {
                break;
            }
            let (key, value) = line
                .split_once(':')
                .context("Invalid Drive response header")?;
            ensure!(
                !key.is_empty() && key.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
                "Invalid Drive response header"
            );
            headers.push((key.to_ascii_lowercase(), value.trim().to_owned()));
        }
        if status >= 200 {
            break (status, headers);
        }
    };
    let mut body = Vec::new();
    let mut file = None;
    let limit = match destination {
        Destination::Bytes(limit) => limit as u64,
        Destination::File(path, limit) => {
            file = Some(private_file(path)?);
            created.store(true, Ordering::Release);
            limit
        }
    };
    let mut bytes = 0u64;
    let mut chunk = [0u8; 32768];
    loop {
        let count = reader.read(&mut chunk)?;
        if count == 0 {
            break;
        }
        bytes = bytes
            .checked_add(count as u64)
            .context("Drive response exceeds limit")?;
        if bytes > limit {
            overflow.store(true, Ordering::Release);
            bail!("Drive response exceeds limit");
        }
        if let Some(file) = file.as_mut() {
            file.write_all(&chunk[..count])?;
        } else {
            body.extend_from_slice(&chunk[..count]);
        }
        // Only accepted response payload counts. Error/expired-token bodies
        // must never masquerade as downloaded project audio.
        if (200..300).contains(&status) {
            received.store(bytes, Ordering::Release);
        }
    }
    if let Some(file) = file {
        file.sync_all()?;
    }
    Ok(Response {
        status,
        headers,
        body,
        bytes,
    })
}
/// No redirects: a bearer token is never forwarded to a Location supplied by a server.
/// File destinations must not exist. A failed/cancelled request removes its partial file.
pub fn request(req: Request<'_>, cancel: &impl Fn() -> bool) -> Result<Response> {
    request_with_progress(req, cancel, &|_| {})
}
/// Reports received payload bytes on the calling worker, at most five times a
/// second plus the final count. This is transfer progress, not integrity proof.
/// No observer runs on the pipe-reader thread or after the request returns.
pub fn request_with_progress(
    req: Request<'_>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(u64),
) -> Result<Response> {
    ensure!(!cancel(), "Drive request cancelled");
    validate_url(req.url, req.allow_loopback_http)?;
    ensure!(
        matches!(
            req.method,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
        ),
        "Invalid Drive HTTP method"
    );
    let scratch = Scratch::new()?;
    let mut config = format!(
        "url = {}\nrequest = {}\n",
        quote(req.url)?,
        quote(req.method)?
    );
    for (name, value) in req.headers {
        ensure!(
            !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "Invalid Drive request header"
        );
        config.push_str(&format!(
            "header = {}\n",
            quote(&format!("{name}: {value}"))?
        ));
    }
    match req.body {
        Body::Empty => {}
        Body::Bytes(bytes) => {
            let path = scratch.0.join("body");
            let mut file = private_file(&path)?;
            file.write_all(bytes)?;
            drop(file);
            config.push_str(&format!(
                "upload-file = {}\n",
                quote(&format!(
                    "{}",
                    path.to_str().context("Invalid Drive temporary path")?
                ))?
            ));
        }
        Body::File(path) => {
            ensure!(path.is_file(), "Drive upload file missing");
            config.push_str(&format!(
                "upload-file = {}\n",
                quote(&format!(
                    "{}",
                    path.to_str().context("Invalid Drive upload path")?
                ))?
            ));
        }
    }
    ensure!(
        config.len() <= 65536,
        "Drive request configuration exceeds limit"
    );
    let seconds = if req.upload { 300 } else { 30 };
    let mut command = Command::new(if cfg!(windows) { "curl.exe" } else { "curl" });
    command
        .args([
            "--disable",
            "--silent",
            "--show-error",
            "--include",
            "--suppress-connect-headers",
            "--no-buffer",
            "--connect-timeout",
            "10",
            "--max-time",
            if req.upload { "300" } else { "30" },
            "--speed-limit",
            "1",
            "--speed-time",
            "25",
            "--proto",
            if req.allow_loopback_http {
                "=http,https"
            } else {
                "=https"
            },
            "--config",
            "-",
        ])
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    if req.method == "HEAD" {
        command.arg("--head");
    }
    let mut child = Running(
        command
            .spawn()
            .context("Could not start Drive HTTP transport")?,
    );
    let mut stdin = child.0.stdin.take().context("Drive HTTP stdin missing")?;
    // The configuration is bounded and contains no large request body.
    stdin
        .write_all(config.as_bytes())
        .context("Could not configure Drive HTTP transport")?;
    drop(stdin);
    drop(config);
    let stdout = child.0.stdout.take().context("Drive HTTP stdout missing")?;
    let stderr = child.0.stderr.take().context("Drive HTTP stderr missing")?;
    let output_path = match &req.destination {
        Destination::File(path, _) => Some(path.to_path_buf()),
        _ => None,
    };
    let created = Arc::new(AtomicBool::new(false));
    let created_output = created.clone();
    let overflow = Arc::new(AtomicBool::new(false));
    let full = overflow.clone();
    let received = Arc::new(AtomicU64::new(0));
    let reader_received = received.clone();
    let destination = match req.destination {
        Destination::Bytes(limit) => OwnedDestination::Bytes(limit),
        Destination::File(path, limit) => OwnedDestination::File(path.to_path_buf(), limit),
    };
    let reader = thread::spawn(move || {
        let result = read_response(
            stdout,
            destination.borrow(),
            &full,
            &created_output,
            &reader_received,
        );
        if result.is_err() {
            full.store(true, Ordering::Release);
        }
        result
    });
    let errors = thread::spawn(move || {
        let mut input = stderr;
        let mut total = 0usize;
        let mut chunk = [0u8; 4096];
        while let Ok(n) = input.read(&mut chunk) {
            if n == 0 {
                break;
            }
            total = total.saturating_add(n);
        }
        total
    });
    let deadline = Instant::now() + Duration::from_secs(seconds + 2);
    let mut reported = 0;
    let mut last_report = Instant::now();
    let result = (|| -> Result<()> {
        loop {
            ensure!(!cancel(), "Drive request cancelled");
            ensure!(
                !overflow.load(Ordering::Acquire),
                "Drive response could not be received within bounds"
            );
            let bytes = received.load(Ordering::Acquire);
            if bytes != reported && last_report.elapsed() >= Duration::from_millis(200) {
                progress(bytes);
                reported = bytes;
                last_report = Instant::now();
                ensure!(!cancel(), "Drive request cancelled");
            }
            if let Some(status) = child.0.try_wait()? {
                ensure!(status.success(), "Google Drive network transport failed");
                break;
            }
            ensure!(Instant::now() < deadline, "Google Drive network timeout");
            thread::sleep(Duration::from_millis(5));
        }
        Ok(())
    })();
    if result.is_err() {
        let _ = child.0.kill();
    }
    let _ = child.0.wait();
    let response = reader
        .join()
        .map_err(|_| anyhow::anyhow!("Drive HTTP reader stopped"));
    let _ = errors.join();
    // Preserve a local destination IO failure (ENOSPC/EACCES), rather than
    // relabelling it as a network failure and aborting every other adoption.
    let response = response.and_then(|value| value);
    let mut result = match (result, response) {
        (Err(error), Err(reader))
            if error.to_string() == "Drive response could not be received within bounds" =>
        {
            Err(reader)
        }
        (Err(error), _) => Err(error),
        (Ok(()), response) => response,
    };
    if let Ok(response) = &result {
        if (200..300).contains(&response.status) && response.bytes != reported && !cancel() {
            progress(response.bytes);
        }
    }
    if result.is_ok() && cancel() {
        result = Err(anyhow::anyhow!("Drive request cancelled"));
    }
    if result.is_err() && created.load(Ordering::Acquire) {
        if let Some(path) = output_path {
            let _ = fs::remove_file(path);
        }
    }
    result
}
enum OwnedDestination {
    Bytes(usize),
    File(PathBuf, u64),
}
impl OwnedDestination {
    fn borrow(&self) -> Destination<'_> {
        match self {
            Self::Bytes(n) => Destination::Bytes(*n),
            Self::File(p, n) => Destination::File(p, *n),
        }
    }
}

#[cfg(test)]
#[path = "drive_http_tests.rs"]
mod tests;

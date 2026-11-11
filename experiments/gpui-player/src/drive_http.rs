//! Worker-only Drive HTTP, with platform TLS and an in-process connection pool.
use anyhow::{Context, Result, bail, ensure};
use futures_lite::{AsyncReadExt, AsyncWriteExt};
use std::{
    cell::{Cell, RefCell},
    fs::{self, File, OpenOptions},
    future::Future,
    io::{Read, Write},
    net::TcpStream,
    path::Path,
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicU64, Ordering},
    },
    time::{Duration, Instant},
};
#[cfg(test)]
use std::{
    io::{BufRead, BufReader},
    path::PathBuf,
    sync::atomic::AtomicBool,
    thread,
};
use ureq::unversioned::{
    resolver::{DefaultResolver, ResolvedSocketAddrs, Resolver},
    transport::{
        Buffers, ConnectProxyConnector, ConnectionDetails, Connector, LazyBuffers,
        NativeTlsConnector, NextTimeout, Transport,
    },
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
#[cfg(test)]
struct Scratch(PathBuf);
#[cfg(test)]
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
#[cfg(test)]
impl Drop for Scratch {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

// Session changes wake the wait immediately. Only arbitrary caller closures
// need this fallback; no 2 ms timer runs throughout a held network request.
const POLL_INTERVAL: Duration = Duration::from_millis(20);
#[cfg(test)]
thread_local! {
    static TEST_CALLER_POLL_INTERVAL: Cell<Option<Duration>> = const { Cell::new(None) };
    static TEST_WAITING: RefCell<Option<Arc<std::sync::atomic::AtomicBool>>> = const { RefCell::new(None) };
}
#[cfg(test)]
pub(crate) fn with_test_network_wait<T>(
    interval: Duration,
    waiting: Arc<std::sync::atomic::AtomicBool>,
    run: impl FnOnce() -> T,
) -> T {
    struct Restore(Option<Duration>, Option<Arc<std::sync::atomic::AtomicBool>>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_CALLER_POLL_INTERVAL.with(|v| v.set(self.0));
            TEST_WAITING.with(|v| *v.borrow_mut() = self.1.take());
        }
    }
    let _restore = Restore(
        TEST_CALLER_POLL_INTERVAL.with(|v| v.replace(Some(interval))),
        TEST_WAITING.with(|v| v.replace(Some(waiting))),
    );
    run()
}

#[derive(Default)]
struct CancelWake {
    version: AtomicU64,
    waker: Mutex<Option<std::task::Waker>>,
}
fn cancel_waiters() -> &'static Mutex<Vec<Weak<CancelWake>>> {
    static WAITERS: OnceLock<Mutex<Vec<Weak<CancelWake>>>> = OnceLock::new();
    WAITERS.get_or_init(|| Mutex::new(Vec::new()))
}
impl CancelWake {
    fn register() -> Arc<Self> {
        let event = Arc::new(Self::default());
        let mut waiters = cancel_waiters().lock().unwrap_or_else(|e| e.into_inner());
        waiters.retain(|entry| entry.strong_count() != 0);
        waiters.push(Arc::downgrade(&event));
        event
    }
    fn changed(&self, version: u64) -> WakeChanged<'_> {
        WakeChanged {
            event: self,
            version,
        }
    }
}
struct WakeChanged<'a> {
    event: &'a CancelWake,
    version: u64,
}
impl Future for WakeChanged<'_> {
    type Output = ();
    fn poll(
        self: std::pin::Pin<&mut Self>,
        cx: &mut std::task::Context<'_>,
    ) -> std::task::Poll<()> {
        if self.event.version.load(Ordering::Acquire) != self.version {
            return std::task::Poll::Ready(());
        }
        let mut waker = self.event.waker.lock().unwrap_or_else(|e| e.into_inner());
        *waker = Some(cx.waker().clone());
        // Close the notification/registration race without polling a timer.
        if self.event.version.load(Ordering::Acquire) != self.version {
            std::task::Poll::Ready(())
        } else {
            #[cfg(test)]
            TEST_WAITING.with(|waiting| {
                if let Some(waiting) = waiting.borrow().as_ref() {
                    if TICK.with(|io| io.attempt.sent.get() > 0) {
                        waiting.store(true, Ordering::Release);
                    }
                }
            });
            std::task::Poll::Pending
        }
    }
}
impl Drop for WakeChanged<'_> {
    fn drop(&mut self) {
        self.event
            .waker
            .lock()
            .unwrap_or_else(|e| e.into_inner())
            .take();
    }
}
/// Wake active network waits after changing cancellation state. Notifications
/// carry no credentials/callbacks and merely ask each caller to recheck its fence.
pub(crate) fn wake_cancelled_requests() {
    let mut ready = Vec::new();
    {
        let mut waiters = cancel_waiters().lock().unwrap_or_else(|e| e.into_inner());
        waiters.retain(|entry| {
            if let Some(event) = entry.upgrade() {
                ready.push(event);
                true
            } else {
                false
            }
        });
    }
    for event in ready {
        event.version.fetch_add(1, Ordering::Release);
        let waker = event.waker.lock().unwrap_or_else(|e| e.into_inner()).take();
        if let Some(waker) = waker {
            waker.wake();
        }
    }
}

// ureq's blocking API delegates every network wait (including TLS and CONNECT)
// to this transport. Scoped storage borrows the caller's callbacks only until
// request() returns; pooled sockets never retain callbacks or OAuth headers.
#[derive(Clone, Copy)]
struct RequestIo<'a> {
    tick: &'a dyn Fn() -> std::result::Result<(), ureq::Error>,
    head: &'a RefCell<ResponseHead>,
    connector_depth: &'a Cell<usize>,
    connect_deadline: Instant,
    attempt: &'a AttemptIo,
    wake: &'a CancelWake,
    poll_interval: Duration,
    deadline: Instant,
}
scoped_tls_hkt::scoped_thread_local!(static TICK: for<'a> RequestIo<'a>);

// Count successful socket writes, including partial writes. Any method can
// retry a pooled first-write failure that sent no bytes; GET/HEAD also permit
// a closed pooled socket before response bytes. Counting TLS/control writes
// is conservative: it can only prevent the zero-byte retry.
#[derive(Default)]
struct AttemptIo {
    connected: Cell<bool>,
    sent: Cell<usize>,
    write_failed: Cell<bool>,
    read_closed: Cell<bool>,
}
impl AttemptIo {
    fn record_write(&self, result: std::io::Result<usize>) -> std::io::Result<usize> {
        match result {
            Ok(0) => {
                self.write_failed.set(true);
                Err(std::io::ErrorKind::WriteZero.into())
            }
            Ok(count) => {
                self.sent.set(self.sent.get().saturating_add(count));
                Ok(count)
            }
            Err(error) => {
                // This is an actual socket-write error, not a wait timeout
                // or observer error. Zero successful writes proves replay is
                // safe regardless of the platform's particular error mapping.
                self.write_failed.set(true);
                Err(error)
            }
        }
    }
    fn reset(&self) {
        self.connected.set(false);
        self.sent.set(0);
        self.write_failed.set(false);
        self.read_closed.set(false);
    }
    fn retryable(&self) -> bool {
        !self.connected.get() && self.sent.get() == 0 && self.write_failed.get()
    }
}

// Secure Transport invokes these observers through C read/write callbacks.
// Never unwind through that boundary: finish unwinding the HTTP/TLS stack first
// and resume the original payload on the calling worker, outside TICK.set().
#[derive(Default)]
struct ObserverPanic(RefCell<Option<Box<dyn std::any::Any + Send>>>);
impl ObserverPanic {
    fn call<T>(&self, callback: impl FnOnce() -> T) -> std::result::Result<T, ureq::Error> {
        if self.0.borrow().is_none() {
            match std::panic::catch_unwind(std::panic::AssertUnwindSafe(callback)) {
                Ok(value) => return Ok(value),
                Err(payload) => *self.0.borrow_mut() = Some(payload),
            }
        }
        Err(ureq::Error::Io(std::io::Error::other(
            "Google Drive network transport failed",
        )))
    }
}

// ureq limits each individual response head. The previous transport instead
// shared one 64 KiB budget across every informational head and the final head.
#[derive(Default)]
struct ResponseHead {
    bytes: usize,
    block: Vec<u8>,
    complete: bool,
}
impl ResponseHead {
    fn invalid() -> ureq::Error {
        ureq::Error::Io(std::io::Error::new(
            std::io::ErrorKind::InvalidData,
            "Invalid Drive HTTP response",
        ))
    }
    fn accept(&mut self, input: &[u8]) -> std::result::Result<(), ureq::Error> {
        for byte in input {
            if self.complete {
                break;
            }
            self.bytes += 1;
            if self.bytes > 65536 {
                return Err(ureq::Error::LargeResponseHeader(self.bytes, 65536));
            }
            self.block.push(*byte);
            if self.block.ends_with(b"\r\n\r\n") || self.block.ends_with(b"\n\n") {
                let head = std::str::from_utf8(&self.block).map_err(|_| Self::invalid())?;
                let mut lines = head.lines();
                let status = lines
                    .next()
                    .filter(|line| line.starts_with("HTTP/"))
                    .and_then(|line| line.split_whitespace().nth(1))
                    .and_then(|status| status.parse::<u16>().ok())
                    .filter(|status| (100..=599).contains(status))
                    .ok_or_else(Self::invalid)?;
                // Keep the old parser's strict first line and header names even
                // for informational responses discarded by the HTTP library.
                for line in lines.take_while(|line| !line.is_empty()) {
                    let (name, _) = line.split_once(':').ok_or_else(Self::invalid)?;
                    if name.is_empty()
                        || !name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-')
                    {
                        return Err(Self::invalid());
                    }
                }
                self.complete = status >= 200;
                self.block.clear();
            }
        }
        Ok(())
    }
}

#[derive(Debug)]
struct RequestConnector<C>(C);
impl<C: Connector> Connector for RequestConnector<C> {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<()>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        let outer = TICK.with(|io| {
            let depth = io.connector_depth.get();
            io.connector_depth.set(depth + 1);
            if depth == 0 {
                io.attempt.connected.set(true);
            }
            depth == 0
        });
        struct Depth;
        impl Drop for Depth {
            fn drop(&mut self) {
                TICK.with(|io| io.connector_depth.set(io.connector_depth.get() - 1));
            }
        }
        let _depth = Depth;
        Ok(self.0.connect(details, chained)?.map(|inner| {
            // CONNECT recursively opens the proxy transport. Give proxy heads
            // their own bounded budget; the endpoint's scoped budget resets on
            // every request, including requests using an already-pooled socket.
            Box::new(HeaderTransport {
                inner: inner.boxed(),
                proxy_head: if outer {
                    None
                } else {
                    Some(ResponseHead::default())
                },
            }) as Self::Out
        }))
    }
}
struct HeaderTransport {
    inner: Box<dyn Transport>,
    proxy_head: Option<ResponseHead>,
}
impl std::fmt::Debug for HeaderTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never format buffers, which can contain credentials or upload URLs.
        f.debug_struct("HeaderTransport").finish_non_exhaustive()
    }
}
impl Transport for HeaderTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }
    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        self.inner.transmit_output(amount, timeout)
    }
    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        let before = self.inner.buffers().input().len();
        let progress = self.inner.await_input(timeout)?;
        let incoming = &self.inner.buffers().input()[before..];
        if let Some(head) = self.proxy_head.as_mut() {
            // After CONNECT's final head, accept() stops counting the tunnel's
            // TLS records. The outer guard counts decrypted endpoint headers.
            head.accept(incoming)?;
        } else {
            TICK.with(|io| io.head.borrow_mut().accept(incoming))?;
        }
        Ok(progress)
    }
    fn is_open(&mut self) -> bool {
        self.inner.is_open()
    }
    fn is_tls(&self) -> bool {
        self.inner.is_tls()
    }
}

fn wait_io<T>(
    operation: impl Future<Output = std::io::Result<T>>,
    timeout: NextTimeout,
) -> std::result::Result<T, ureq::Error> {
    TICK.with(|io| (io.tick)())?;
    let mut timeout = timeout;
    if matches!(
        timeout.reason,
        ureq::Timeout::Resolve | ureq::Timeout::Connect
    ) {
        // curl's ten-second setup budget includes DNS, proxy negotiation and TLS.
        // ureq otherwise starts separate resolve/connect phase budgets.
        let left = TICK.with(|io| {
            io.connect_deadline
                .saturating_duration_since(Instant::now())
        });
        timeout.after = (*timeout.after).min(left).into();
    }
    if timeout.after.is_zero() {
        return Err(ureq::Error::Timeout(timeout.reason));
    }
    let started = Instant::now();
    TICK.with(|io| {
        futures_lite::future::block_on(futures_lite::future::or(
            async {
                let (wake, poll_interval, deadline) = (io.wake, io.poll_interval, io.deadline);
                let mut version = wake.version.load(Ordering::Acquire);
                loop {
                    TICK.with(|io| (io.tick)())?;
                    let left = timeout
                        .after
                        .saturating_sub(started.elapsed())
                        .min(deadline.saturating_duration_since(Instant::now()));
                    if left.is_zero() {
                        return Err(ureq::Error::Timeout(timeout.reason));
                    }
                    futures_lite::future::or(
                        async {
                            wake.changed(version).await;
                        },
                        async {
                            async_io::Timer::after(poll_interval.min(left)).await;
                        },
                    )
                    .await;
                    version = wake.version.load(Ordering::Acquire);
                }
            },
            async { operation.await.map_err(ureq::Error::Io) },
        ))
    })
}

#[derive(Debug)]
struct DriveResolver;
impl Resolver for DriveResolver {
    fn resolve(
        &self,
        uri: &ureq::http::Uri,
        config: &ureq::config::Config,
        timeout: NextTimeout,
    ) -> std::result::Result<ResolvedSocketAddrs, ureq::Error> {
        let host = DefaultResolver::host_and_port(
            uri.scheme().ok_or(ureq::Error::HostNotFound)?,
            uri.authority().ok_or(ureq::Error::HostNotFound)?,
        )
        .ok_or(ureq::Error::HostNotFound)?;
        // async-net uses the existing bounded blocking pool for system DNS.
        // Dropping a cancelled lookup never leaves a request/secret/file worker.
        let addresses = wait_io(async_net::resolve(host), timeout)?;
        let mut resolved = self.empty();
        for address in config
            .ip_family()
            .keep_wanted(addresses.into_iter())
            .take(16)
        {
            resolved.push(address);
        }
        if resolved.is_empty() {
            return Err(ureq::Error::HostNotFound);
        }
        Ok(resolved)
    }
}

#[derive(Debug)]
struct DriveConnector;
impl<In: Transport> Connector<In> for DriveConnector {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<In>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        if let Some(transport) = chained {
            return Ok(Some(transport.boxed()));
        }
        if details.config.proxy().is_some_and(|proxy| {
            !proxy.is_no_proxy(details.uri)
                && !matches!(
                    proxy.protocol(),
                    ureq::ProxyProtocol::Http | ureq::ProxyProtocol::Https
                )
        }) {
            return Err(ureq::Error::ConnectionFailed);
        }
        // One shared connect budget across addresses, not ten seconds per IP.
        let started = Instant::now();
        let mut last = ureq::Error::ConnectionFailed;
        for (index, address) in details.addrs.iter().enumerate() {
            let mut timeout = details.timeout;
            let left = timeout.after.saturating_sub(started.elapsed());
            // Leave time for IPv4 when an IPv6 route silently drops packets.
            timeout.after = (left / (details.addrs.len() - index) as u32).into();
            match wait_io(async_io::Async::<TcpStream>::connect(*address), timeout) {
                Ok(stream) => {
                    stream.get_ref().set_nodelay(details.config.no_delay())?;
                    return Ok(Some(Box::new(DriveTransport {
                        stream,
                        buffers: LazyBuffers::new(
                            details.config.input_buffer_size(),
                            details.config.output_buffer_size(),
                        ),
                    })));
                }
                Err(error) => {
                    // A cancellation is never retried against another IP.
                    TICK.with(|io| (io.tick)())?;
                    last = error;
                }
            }
        }
        Err(last)
    }
}
#[derive(Debug)]
struct DriveTransport {
    stream: async_io::Async<TcpStream>,
    buffers: LazyBuffers,
}
impl Transport for DriveTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        &mut self.buffers
    }
    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        wait_io(
            async {
                let mut sent = 0;
                while sent < amount {
                    let result = self
                        .stream
                        .write(&self.buffers.output()[sent..amount])
                        .await;
                    sent += TICK.with(|io| io.attempt.record_write(result))?;
                }
                Ok(())
            },
            timeout.for_write(),
        )
    }
    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        let count = wait_io(
            async {
                let result = self.stream.read(self.buffers.input_append_buf()).await;
                if matches!(&result, Ok(0))
                    || result.as_ref().is_err_and(|error| {
                        matches!(
                            error.kind(),
                            std::io::ErrorKind::ConnectionReset
                                | std::io::ErrorKind::ConnectionAborted
                                | std::io::ErrorKind::UnexpectedEof
                                | std::io::ErrorKind::BrokenPipe
                        )
                    })
                {
                    TICK.with(|io| io.attempt.read_closed.set(true));
                }
                result
            },
            timeout.for_read(),
        )?;
        self.buffers.input_appended(count);
        Ok(count > 0)
    }
    fn is_open(&mut self) -> bool {
        // A pooled connection is reusable only when no unread data/EOF is waiting.
        let mut byte = [0];
        matches!(self.stream.get_ref().peek(&mut byte), Err(error) if error.kind() == std::io::ErrorKind::WouldBlock)
    }
}
fn agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| build_agent(8))
}
fn fresh_agent() -> &'static ureq::Agent {
    static AGENT: OnceLock<ureq::Agent> = OnceLock::new();
    AGENT.get_or_init(|| build_agent(0))
}
fn build_agent(idle_connections: usize) -> ureq::Agent {
    let config = ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .user_agent(concat!("SingZ/", env!("CARGO_PKG_VERSION"), " (native)"))
        .max_redirects(0)
        .http_status_as_error(false)
        .max_response_header_size(65536)
        .timeout_resolve(Some(Duration::from_secs(10)))
        .timeout_connect(Some(Duration::from_secs(10)))
        .timeout_per_read(Some(Duration::from_secs(25)))
        .timeout_per_write(Some(Duration::from_secs(25)))
        .max_idle_age(Duration::from_secs(4))
        .max_idle_connections(idle_connections)
        .max_idle_connections_per_host(2)
        .build();
    let connector =
        ().chain(ConnectProxyConnector::default())
            .chain(DriveConnector)
            .chain(NativeTlsConnector::default());
    ureq::Agent::with_parts(config, RequestConnector(connector), DriveResolver)
}

// Validate independently of ureq's cached environment selection, which treats
// malformed proxy URLs as unset. Never include the value: it may be a secret.
fn validate_proxy_environment() -> Result<()> {
    for name in [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        match std::env::var(name) {
            Ok(value) if !value.is_empty() => {
                let proxy = ureq::Proxy::new(&value)
                    .map_err(|_| anyhow::anyhow!("Invalid Drive proxy configuration ({name})"))?;
                ensure!(
                    matches!(
                        proxy.protocol(),
                        ureq::ProxyProtocol::Http | ureq::ProxyProtocol::Https
                    ),
                    "SOCKS proxy not supported"
                );
            }
            Err(std::env::VarError::NotUnicode(_)) => {
                bail!("Invalid Drive proxy configuration ({name})")
            }
            _ => {}
        }
    }
    Ok(())
}

// Retain the destination's typed I/O errors and delete only files we created,
// including on an observer panic. Drop the handle before removing it on Windows.
struct Output<'a> {
    file: Option<File>,
    path: Option<&'a Path>,
    complete: bool,
}
impl Drop for Output<'_> {
    fn drop(&mut self) {
        drop(self.file.take());
        if !self.complete {
            if let Some(path) = self.path {
                let _ = fs::remove_file(path);
            }
        }
    }
}

struct UploadReader<'a> {
    input: Box<dyn Read + 'a>,
    transferred: &'a Cell<u64>,
}
impl Read for UploadReader<'_> {
    fn read(&mut self, bytes: &mut [u8]) -> std::io::Result<usize> {
        let count = self.input.read(bytes)?;
        self.transferred
            .set(self.transferred.get().saturating_add(count as u64));
        Ok(count)
    }
}

/// No redirects: a bearer token is never forwarded to a Location supplied by a server.
/// File destinations must not exist. A failed/cancelled request removes its partial file.
pub fn request(req: Request<'_>, cancel: &impl Fn() -> bool) -> Result<Response> {
    request_with_progress(req, cancel, &|_| {})
}
/// Reports received payload bytes on the calling worker, at most five times a
/// second plus the final count. No observer runs after the request returns.
pub fn request_with_progress(
    req: Request<'_>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(u64),
) -> Result<Response> {
    validate_proxy_environment()?;
    request_using_agents(req, cancel, progress, agent(), fresh_agent())
}

#[cfg(test)]
fn request_using_agent(
    req: Request<'_>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(u64),
    agent: &ureq::Agent,
) -> Result<Response> {
    // Custom fixture connectors own their own pool; failed sockets are removed.
    request_using_agents(req, cancel, progress, agent, agent)
}
fn request_using_agents(
    req: Request<'_>,
    cancel: &impl Fn() -> bool,
    progress: &impl Fn(u64),
    agent: &ureq::Agent,
    retry_agent: &ureq::Agent,
) -> Result<Response> {
    ensure!(!cancel(), "Drive request cancelled");
    let url = validate_url(req.url, req.allow_loopback_http)?;
    ensure!(
        matches!(
            req.method,
            "GET" | "POST" | "PUT" | "PATCH" | "DELETE" | "HEAD"
        ),
        "Invalid Drive HTTP method"
    );
    // Keep the previous escaped configuration bound, without creating a scratch
    // file or process. No URL, header, body or transport error is formatted into
    // a network diagnostic, since any of them can carry OAuth credentials.
    let mut option_bytes = quote(req.url)?.len() + quote(req.method)?.len() + 18;
    for (name, value) in req.headers {
        ensure!(
            !name.is_empty() && name.bytes().all(|c| c.is_ascii_alphanumeric() || c == b'-'),
            "Invalid Drive request header"
        );
        option_bytes = option_bytes
            .checked_add(quote(&format!("{name}: {value}"))?.len() + 10)
            .context("Drive request configuration exceeds limit")?;
        ensure!(
            option_bytes <= 65536,
            "Drive request configuration exceeds limit"
        );
    }
    if matches!(req.body, Body::Bytes(_)) {
        let old_scratch_path = std::env::temp_dir()
            .join(format!("singz-drive-{}", "0".repeat(48)))
            .join("body");
        option_bytes += quote(
            old_scratch_path
                .to_str()
                .context("Invalid Drive temporary path")?,
        )?
        .len()
            + 15;
    }
    let mut upload = None;
    if let Body::File(path) = req.body {
        let file = File::open(path).context("Drive upload file missing")?;
        ensure!(file.metadata()?.is_file(), "Drive upload file missing");
        option_bytes += quote(path.to_str().context("Invalid Drive upload path")?)?.len() + 15;
        upload = Some(file);
    }
    ensure!(
        option_bytes <= 65536,
        "Drive request configuration exceeds limit"
    );
    let started = Instant::now();
    let deadline = started + Duration::from_secs(if req.upload { 300 } else { 30 });
    let transferred = Cell::new(0u64);
    let speed_checked_at = Cell::new(started);
    let speed_checked_bytes = Cell::new(0u64);
    let received = Cell::new(0);
    let reported = Cell::new(0);
    let last_report = Cell::new(started);
    let cancelled = Cell::new(false);
    let observer_panic = ObserverPanic::default();
    let tick = || {
        if observer_panic.call(cancel)? {
            cancelled.set(true);
            return Err(ureq::Error::Io(std::io::Error::other(
                "Drive request cancelled",
            )));
        }
        let now = Instant::now();
        if now >= deadline {
            return Err(ureq::Error::Timeout(ureq::Timeout::Global));
        }
        // Retain curl's minimum payload rate of one byte/second over 25 s.
        let elapsed = now.duration_since(speed_checked_at.get());
        if elapsed >= Duration::from_secs(25) {
            if (transferred.get() - speed_checked_bytes.get()) as f64 / elapsed.as_secs_f64() < 1.0
            {
                return Err(ureq::Error::Timeout(ureq::Timeout::Global));
            }
            speed_checked_at.set(now);
            speed_checked_bytes.set(transferred.get());
        }
        if received.get() != reported.get()
            && last_report.get().elapsed() >= Duration::from_millis(200)
        {
            observer_panic.call(|| progress(received.get()))?;
            reported.set(received.get());
            last_report.set(Instant::now());
            if observer_panic.call(cancel)? {
                cancelled.set(true);
                return Err(ureq::Error::Io(std::io::Error::other(
                    "Drive request cancelled",
                )));
            }
        }
        Ok(())
    };
    let head = RefCell::new(ResponseHead::default());
    let connector_depth = Cell::new(0);
    let attempt = AttemptIo::default();
    let wake = CancelWake::register();
    #[cfg(test)]
    let poll_interval = TEST_CALLER_POLL_INTERVAL
        .with(|interval| interval.get())
        .unwrap_or(POLL_INTERVAL);
    #[cfg(not(test))]
    let poll_interval = POLL_INTERVAL;
    let io = RequestIo {
        tick: &tick,
        head: &head,
        connector_depth: &connector_depth,
        connect_deadline: started + Duration::from_secs(10),
        attempt: &attempt,
        wake: &wake,
        poll_interval,
        deadline,
    };
    let result = TICK.set(io, || -> Result<Response> {
        let mut response = None;
        for retry in 0..2 {
            attempt.reset();
            *head.borrow_mut() = ResponseHead::default();
            if retry != 0 {
                // A reader may have buffered before failure. Rewind only after the
                // zero-byte or idempotent/no-response retry guard accepted it.
                if let Some(file) = upload.as_mut() {
                    std::io::Seek::rewind(file)?;
                }
            }
            let agent = if retry == 0 { agent } else { retry_agent };
            let mut builder = match req.method {
                "GET" => agent.get(url.as_str()).force_send_body(),
                "DELETE" => agent.delete(url.as_str()).force_send_body(),
                "HEAD" => agent.head(url.as_str()).force_send_body(),
                "POST" => agent.post(url.as_str()),
                "PUT" => agent.put(url.as_str()),
                "PATCH" => agent.patch(url.as_str()),
                _ => unreachable!(),
            };
            for (name, value) in req.headers {
                builder = builder.header_raw(name, value.as_bytes());
            }
            let size = match req.body {
                Body::File(_) => Some(upload.as_ref().unwrap().metadata()?.len()),
                Body::Bytes(bytes) => Some(bytes.len() as u64),
                Body::Empty => None,
            };
            if let Some(size) = size {
                if size >= 1024 * 1024
                    && !req
                        .headers
                        .iter()
                        .any(|(name, _)| name.eq_ignore_ascii_case("expect"))
                {
                    builder = builder.header_raw("Expect", b"100-continue");
                }
                if !req
                    .headers
                    .iter()
                    .any(|(name, _)| name.eq_ignore_ascii_case("content-length"))
                {
                    builder = builder.header_raw("Content-Length", size.to_string().as_bytes());
                }
            }
            let input: Box<dyn Read + '_> = match req.body {
                Body::File(_) => Box::new(upload.as_mut().unwrap()),
                Body::Bytes(bytes) => Box::new(std::io::Cursor::new(bytes)),
                Body::Empty => Box::new(std::io::empty()),
            };
            let mut input = UploadReader {
                input,
                transferred: &transferred,
            };
            let sent = if size.is_some() {
                builder.send(ureq::SendBody::from_reader(&mut input))
            } else {
                builder.send_empty()
            };
            match sent {
                Ok(value) => {
                    response = Some(value);
                    break;
                }
                Err(_)
                    if retry == 0
                        && tick().is_ok()
                        && (attempt.retryable()
                            || (matches!(req.method, "GET" | "HEAD")
                                && !attempt.connected.get()
                                && attempt.read_closed.get()
                                && head.borrow().bytes == 0)) =>
                {
                    continue;
                }
                Err(_) => bail!("Google Drive network transport failed"),
            }
        }
        let response = response.expect("successful attempt returned a response");
        let status = response.status().as_u16();
        ensure!((200..=599).contains(&status), "Invalid Drive HTTP status");
        let mut headers = Vec::new();
        for (name, value) in response.headers() {
            ensure!(
                name.as_str()
                    .bytes()
                    .all(|c| c.is_ascii_alphanumeric() || c == b'-'),
                "Invalid Drive response header"
            );
            let value =
                std::str::from_utf8(value.as_bytes()).context("Invalid Drive response header")?;
            headers.push((name.as_str().to_owned(), value.trim().to_owned()));
        }
        let mut output = Output {
            file: None,
            path: None,
            complete: false,
        };
        let limit = match req.destination {
            Destination::Bytes(limit) => limit as u64,
            Destination::File(path, limit) => {
                output.file = Some(private_file(path)?);
                output.path = Some(path);
                limit
            }
        };
        let mut reader = response.into_body().into_reader();
        let mut body = Vec::new();
        let mut bytes = 0u64;
        let mut chunk = [0u8; 32768];
        loop {
            tick().map_err(|_| anyhow::anyhow!("Google Drive network transport failed"))?;
            let count = reader
                .read(&mut chunk)
                .map_err(|_| anyhow::anyhow!("Google Drive network transport failed"))?;
            if count == 0 {
                break;
            }
            bytes = bytes
                .checked_add(count as u64)
                .context("Drive response exceeds limit")?;
            ensure!(bytes <= limit, "Drive response exceeds limit");
            if let Some(file) = output.file.as_mut() {
                file.write_all(&chunk[..count])?;
            } else {
                body.extend_from_slice(&chunk[..count]);
            }
            transferred.set(transferred.get().saturating_add(count as u64));
            if (200..300).contains(&status) {
                received.set(bytes);
            }
        }
        if let Some(file) = output.file.as_mut() {
            file.sync_all()?;
        }
        tick().map_err(|_| anyhow::anyhow!("Google Drive network transport failed"))?;
        if (200..300).contains(&status) && bytes != reported.get() {
            observer_panic
                .call(|| progress(bytes))
                .map_err(|_| anyhow::anyhow!("Google Drive network transport failed"))?;
            reported.set(bytes);
        }
        tick().map_err(|_| anyhow::anyhow!("Google Drive network transport failed"))?;
        output.complete = true;
        Ok(Response {
            status,
            headers,
            body,
            bytes,
        })
    });
    if let Some(payload) = observer_panic.0.into_inner() {
        std::panic::resume_unwind(payload);
    }
    if cancelled.get() {
        bail!("Drive request cancelled");
    }
    result
}

#[cfg(test)]
#[path = "drive_http_tests.rs"]
mod tests;

use super::*;
use std::net::TcpListener;

fn fixture(body: Vec<u8>, status: u16) -> (String, thread::JoinHandle<Vec<u8>>) {
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = server.local_addr().unwrap();
    let worker = thread::spawn(move || {
        let (mut socket, _) = server.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut request = Vec::new();
        let mut length = 0;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            request.extend_from_slice(line.as_bytes());
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                length = value.trim().parse().unwrap();
            }
            if line == "\r\n" {
                break;
            }
        }
        let mut data = vec![0; length];
        reader.read_exact(&mut data).unwrap();
        request.extend_from_slice(&data);
        write!(socket,"HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nX-Fixture: yes\r\nConnection: close\r\n\r\n",body.len()).unwrap();
        let _ = socket.write_all(&body);
        request
    });
    (format!("http://{address}/fixture"), worker)
}
fn get<'a>(url: &'a str, destination: Destination<'a>) -> Request<'a> {
    Request {
        method: "GET",
        url,
        headers: &[],
        body: Body::Empty,
        destination,
        upload: false,
        allow_loopback_http: true,
    }
}
// The server cannot finish until the request observer sees a partial body.
// This proves streaming rather than an EOF-only synthetic progress event.
fn held_body() -> (String, std::sync::mpsc::Sender<()>, thread::JoinHandle<()>) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let address = listener.local_addr().unwrap();
    let (release, wait) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 131072\r\nConnection: close\r\n\r\n")
            .unwrap();
        socket.write_all(&vec![9; 65536]).unwrap();
        socket.flush().unwrap();
        wait.recv_timeout(Duration::from_secs(3))
            .expect("No progress before EOF");
        let _ = socket.write_all(&vec![9; 65536]);
    });
    (format!("http://{address}/held"), release, server)
}
#[test]
fn actual_stream_reports_partial_bytes_on_caller_before_eof_and_final_exact_count() {
    let directory = Scratch::new().unwrap();
    let output = directory.0.join("download");
    let (url, release, server) = held_body();
    let caller = thread::current().id();
    let observed = std::cell::RefCell::new(Vec::new());
    let response = request_with_progress(
        get(&url, Destination::File(&output, 200000)),
        &|| false,
        &|bytes| {
            assert_eq!(thread::current().id(), caller);
            let mut values = observed.borrow_mut();
            if values.is_empty() {
                assert!(bytes > 0 && bytes < 131072);
                release.send(()).unwrap();
            }
            if let Some(last) = values.last() {
                assert!(bytes > *last);
            }
            values.push(bytes);
        },
    )
    .unwrap();
    server.join().unwrap();
    assert_eq!(observed.borrow().last(), Some(&131072));
    assert_eq!(response.bytes, 131072);
    assert_eq!(fs::read(output).unwrap(), vec![9; 131072]);
}
#[test]
fn cancellation_from_stream_progress_removes_partial_file_without_completion_callback() {
    let directory = Scratch::new().unwrap();
    let output = directory.0.join("download");
    let (url, release, server) = held_body();
    let cancelled = std::cell::Cell::new(false);
    let calls = std::cell::Cell::new(0);
    let error = request_with_progress(
        get(&url, Destination::File(&output, 200000)),
        &|| cancelled.get(),
        &|bytes| {
            assert!(!cancelled.get());
            assert!(bytes > 0 && bytes < 131072);
            calls.set(calls.get() + 1);
            cancelled.set(true);
            release.send(()).unwrap();
        },
    )
    .err()
    .unwrap();
    server.join().unwrap();
    assert!(error.to_string().contains("cancelled"));
    assert_eq!(calls.get(), 1);
    assert!(!output.exists());
}
#[test]
fn unauthorized_response_bytes_are_not_download_progress() {
    let (url, server) = fixture(vec![7; 131072], 401);
    let observed = std::cell::RefCell::new(Vec::new());
    let response =
        request_with_progress(get(&url, Destination::Bytes(200000)), &|| false, &|bytes| {
            observed.borrow_mut().push(bytes)
        })
        .unwrap();
    server.join().unwrap();
    assert_eq!(response.status, 401);
    assert!(observed.borrow().is_empty());
}
#[test]
fn loopback_is_explicit_and_url_credentials_never_allowed() {
    assert!(validate_url("http://127.0.0.1:1234/test", false).is_err());
    assert!(validate_url("http://example.com/test", true).is_err());
    assert!(validate_url("https://secret@example.com/test", true).is_err());
    assert!(validate_url("https://example.com/test", false).is_ok());
    assert!(quote("Bearer secret\r\nInjected: yes").is_err());
}
#[test]
fn native_curl_posts_private_body_and_keeps_non_success_status() {
    let (url, server) = fixture(br#"{"error":"expired"}"#.to_vec(), 401);
    let response = request(
        Request {
            method: "POST",
            headers: &[
                ("Authorization", "Bearer fixture-secret"),
                ("Content-Type", "application/x-www-form-urlencoded"),
            ],
            body: Body::Bytes(b"client_secret=fixture-only&code=abc"),
            ..get(&url, Destination::Bytes(4096))
        },
        &|| false,
    )
    .unwrap();
    assert_eq!(response.status, 401);
    assert_eq!(response.header("X-Fixture"), Some("yes"));
    assert_eq!(response.json().unwrap()["error"], "expired");
    let received = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(received.starts_with("POST /fixture "));
    assert!(received.contains("Authorization: Bearer fixture-secret"));
    assert!(received.ends_with("client_secret=fixture-only&code=abc"));
}
#[test]
fn bounded_download_streams_and_never_deletes_preexisting_destination() {
    let directory = Scratch::new().unwrap();
    let output = directory.0.join("download");
    let (url, server) = fixture(vec![3u8; 131072], 200);
    let response = request(get(&url, Destination::File(&output, 200000)), &|| false).unwrap();
    server.join().unwrap();
    assert_eq!(response.bytes, 131072);
    assert!(response.body.is_empty());
    assert_eq!(fs::read(&output).unwrap(), vec![3u8; 131072]);
    let (url, server) = fixture(vec![8u8; 1024], 200);
    let error = request(get(&url, Destination::File(&output, 200000)), &|| false)
        .err()
        .expect("An existing download destination must be refused");
    assert!(
        error.chain().any(|cause| cause
            .downcast_ref::<std::io::Error>()
            .is_some_and(|io| io.kind() == std::io::ErrorKind::AlreadyExists)),
        "Destination I/O failure must retain its typed cause"
    );
    server.join().unwrap();
    assert_eq!(fs::read(&output).unwrap(), vec![3u8; 131072]);
    let partial = directory.0.join("partial");
    let (url, server) = fixture(vec![8u8; 1024], 200);
    assert!(request(get(&url, Destination::File(&partial, 12)), &|| false).is_err());
    server.join().unwrap();
    assert!(!partial.exists());
}
#[test]
fn oversized_json_is_refused_and_pending_process_is_cancelled() {
    let (url, server) = fixture(vec![b'x'; 200000], 200);
    assert!(request(get(&url, Destination::Bytes(512)), &|| false).is_err());
    server.join().unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/stall", server.local_addr().unwrap());
    let worker = thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        stream
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut data = [0u8; 4096];
        let _ = stream.read(&mut data);
        let mut one = [0];
        stream.read(&mut one).unwrap_or(0)
    });
    let started = Instant::now();
    assert!(
        request(get(&url, Destination::Bytes(512)), &|| started.elapsed()
            > Duration::from_millis(100))
        .is_err()
    );
    assert!(started.elapsed() < Duration::from_secs(2));
    assert_eq!(worker.join().unwrap(), 0);
}

// A persistent HTTP/1.1 peer: count accepted sockets, not HTTP requests.
struct KeepAliveFixture {
    url: String,
    connections: Arc<AtomicU64>,
    stopped: Arc<AtomicBool>,
    server: Option<thread::JoinHandle<()>>,
}
impl KeepAliveFixture {
    fn new() -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let address = listener.local_addr().unwrap();
        let connections = Arc::new(AtomicU64::new(0));
        let count = connections.clone();
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let server = thread::spawn(move || {
            let mut clients = Vec::new();
            for incoming in listener.incoming() {
                let socket = incoming.unwrap();
                if stop.load(Ordering::Acquire) {
                    break;
                }
                count.fetch_add(1, Ordering::Relaxed);
                let stop = stop.clone();
                clients.push(thread::spawn(move || {
                    socket
                        .set_read_timeout(Some(Duration::from_millis(100)))
                        .unwrap();
                    let mut reader = BufReader::new(socket);
                    loop {
                        let mut line = String::new();
                        match reader.read_line(&mut line) {
                            Ok(0) => break,
                            Err(error)
                                if matches!(
                                    error.kind(),
                                    std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                                ) =>
                            {
                                if stop.load(Ordering::Acquire) {
                                    break;
                                }
                                continue;
                            }
                            Err(_) => break,
                            Ok(_) => {}
                        }
                        loop {
                            line.clear();
                            if reader.read_line(&mut line).unwrap_or(0) == 0 {
                                return;
                            }
                            if line == "\r\n" {
                                break;
                            }
                        }
                        if reader
                            .get_mut()
                            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                            .is_err()
                        {
                            break;
                        }
                    }
                }));
            }
            for client in clients {
                client.join().unwrap();
            }
        });
        Self {
            url: format!("http://{address}/drive/v3/files"),
            connections,
            stopped,
            server: Some(server),
        }
    }
}
impl Drop for KeepAliveFixture {
    fn drop(&mut self) {
        self.stopped.store(true, Ordering::Release);
        let address = url::Url::parse(&self.url)
            .unwrap()
            .socket_addrs(|| None)
            .unwrap()[0];
        let _ = std::net::TcpStream::connect(address);
        self.server.take().unwrap().join().unwrap();
    }
}
#[test]
fn sequential_requests_reuse_connections() {
    let fixture = KeepAliveFixture::new();
    for _ in 0..12 {
        let response = request(get(&fixture.url, Destination::Bytes(512)), &|| false).unwrap();
        assert_eq!(response.body, b"{}");
    }
    assert!(
        fixture.connections.load(Ordering::Relaxed) < 12,
        "12 requests opened 12 connections"
    );
}
#[test]
#[ignore = "manual 200-request transport measurement"]
fn local_fake_drive_request_median() {
    let fixture = KeepAliveFixture::new();
    let mut samples = Vec::new();
    for _ in 0..200 {
        let started = Instant::now();
        assert_eq!(
            request(get(&fixture.url, Destination::Bytes(512)), &|| false)
                .unwrap()
                .status,
            200
        );
        samples.push(started.elapsed());
    }
    samples.sort();
    eprintln!(
        "C12T median_us={} requests=200 connections={}",
        (samples[99].as_secs_f64() + samples[100].as_secs_f64()) * 500000.0,
        fixture.connections.load(Ordering::Relaxed)
    );
}
#[test]
fn redirect_does_not_contact_another_host_or_forward_bearer() {
    let target = TcpListener::bind("127.0.0.1:0").unwrap();
    target.set_nonblocking(true).unwrap();
    let target_port = target.local_addr().unwrap().port();
    let target_done = Arc::new(AtomicBool::new(false));
    let done = target_done.clone();
    let redirected = thread::spawn(move || {
        let deadline = Instant::now() + Duration::from_secs(3);
        loop {
            match target.accept() {
                Ok((mut socket, _)) => {
                    socket
                        .set_read_timeout(Some(Duration::from_secs(3)))
                        .unwrap();
                    let mut reader = BufReader::new(socket.try_clone().unwrap());
                    let mut seen = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 {
                            break;
                        }
                        seen.push_str(&line);
                        if line == "\r\n" {
                            break;
                        }
                    }
                    let _ = socket.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                    return Some(seen);
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    if done.load(Ordering::Acquire) || Instant::now() >= deadline {
                        return None;
                    }
                    thread::sleep(Duration::from_millis(1));
                }
                Err(error) => panic!("redirect target: {error}"),
            }
        }
    });
    let source = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/redirect", source.local_addr().unwrap());
    let location = format!("http://localhost:{}/target", target_port);
    let server = thread::spawn(move || {
        let (mut socket, _) = source.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut seen = String::new();
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            seen.push_str(&line);
            if line == "\r\n" {
                break;
            }
        }
        assert!(
            seen.to_ascii_lowercase()
                .contains("authorization: bearer fixture-secret")
        );
        write!(socket, "HTTP/1.1 302 Found\r\nLocation: {location}\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let response = request(
        Request {
            headers: &[("Authorization", "Bearer fixture-secret")],
            ..get(&url, Destination::Bytes(512))
        },
        &|| false,
    )
    .unwrap();
    server.join().unwrap();
    target_done.store(true, Ordering::Release);
    let target_request = redirected.join().unwrap();
    assert!(
        target_request.is_none(),
        "redirect target received a request: {target_request:?}"
    );
    assert_eq!(response.status, 302);
}

fn cancellation_at_phase(phase: &str) {
    let directory = Scratch::new().unwrap();
    let output = directory.0.join("partial");
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!(
        "{}://{}/held",
        if phase == "connect" { "https" } else { "http" },
        listener.local_addr().unwrap()
    );
    let (ready, reached) = std::sync::mpsc::channel();
    let (release, wait) = std::sync::mpsc::channel();
    let body = phase == "body";
    let output_on_server = output.clone();
    let connect = phase == "connect";
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        if connect {
            // Wait for a TLS ClientHello, then hold the TLS connect handshake.
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            assert_eq!(byte[0], 22);
        } else {
            let mut reader = BufReader::new(socket.try_clone().unwrap());
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            if body {
                socket
                    .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 1000000\r\n\r\npartial")
                    .unwrap();
            }
        }
        if body {
            let deadline = Instant::now() + Duration::from_secs(3);
            while !output_on_server.metadata().is_ok_and(|m| m.len() > 0) {
                assert!(
                    Instant::now() < deadline,
                    "body never reached the destination"
                );
                thread::sleep(Duration::from_millis(1));
            }
        }
        // Timestamp the cancellation request on the fixture thread, so the
        // assertion includes the explicit wake and all TLS/socket teardown.
        ready.send(Instant::now()).unwrap();
        wake_cancelled_requests();
        let _ = wait.recv_timeout(Duration::from_secs(3));
    });
    let noticed = std::cell::Cell::new(None);
    let error = with_test_network_wait(
        Duration::from_secs(60),
        Arc::new(AtomicBool::new(false)),
        || {
            request(get(&url, Destination::File(&output, 2000000)), &|| {
                if noticed.get().is_some() {
                    return true;
                }
                if let Ok(requested_at) = reached.try_recv() {
                    noticed.set(Some(requested_at));
                    return true;
                }
                false
            })
        },
    )
    .err()
    .expect("held request must cancel");
    let latency = noticed.get().expect("phase was never reached").elapsed();
    let _ = release.send(());
    server.join().unwrap();
    assert!(
        latency <= Duration::from_millis(250),
        "{phase} cancellation took {latency:?}"
    );
    assert!(error.to_string().contains("cancelled"), "{error:#}");
    eprintln!("C12T {phase} cancellation_us={}", latency.as_micros());
    assert!(!output.exists(), "cancelled {phase} left a partial file");
}
#[test]
fn cancel_during_connect_returns_within_poll_interval() {
    cancellation_at_phase("connect");
}
#[test]
fn cancel_during_headers_returns_within_poll_interval() {
    cancellation_at_phase("headers");
}
#[test]
fn cancel_during_body_returns_within_poll_interval() {
    cancellation_at_phase("body");
}

#[test]
fn informational_headers_share_the_same_64k_budget() {
    for prefix in [
        b"".as_slice(),
        b"HTTP/1.1 103 Early Hints\r\nX-Invalid: \xff\r\n\r\n".as_slice(),
        b"\r\n".as_slice(),
    ] {
        informational_headers_budget(prefix);
    }
}
fn informational_headers_budget(prefix: &'static [u8]) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/hints", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        if socket.write_all(prefix).is_err() {
            return;
        }
        let hint = format!(
            "HTTP/1.1 103 Early Hints\r\nX-Padding: {}\r\n\r\n",
            "x".repeat(1024)
        );
        for _ in 0..80 {
            if socket.write_all(hint.as_bytes()).is_err() {
                return;
            }
        }
        let _ = socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}");
    });
    let result = request(get(&url, Destination::Bytes(512)), &|| false);
    server.join().unwrap();
    assert!(
        result.is_err(),
        "informational responses bypassed the cumulative header limit"
    );
}

#[test]
fn bearer_is_not_dumped_even_when_trace_logging_is_requested() {
    struct WireLog;
    static LEAKED: AtomicBool = AtomicBool::new(false);
    static LOGGER: WireLog = WireLog;
    impl log::Log for WireLog {
        fn enabled(&self, _: &log::Metadata<'_>) -> bool {
            true
        }
        fn log(&self, record: &log::Record<'_>) {
            if record.target().starts_with("ureq_proto")
                && record.args().to_string().contains("zzzzzzzzzzzzzzzz")
            {
                LEAKED.store(true, Ordering::Release);
            }
        }
        fn flush(&self) {}
    }
    log::set_logger(&LOGGER).unwrap();
    struct RestoreLog(log::LevelFilter);
    impl Drop for RestoreLog {
        fn drop(&mut self) {
            log::set_max_level(self.0);
        }
    }
    let _restore = RestoreLog(log::max_level());
    log::set_max_level(log::LevelFilter::Trace);
    let token = format!("Bearer {}", "z".repeat(64));
    let (url, server) = fixture(b"{}".to_vec(), 200);
    let response = request(
        Request {
            headers: &[("Authorization", &token)],
            ..get(&url, Destination::Bytes(512))
        },
        &|| false,
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert!(
        String::from_utf8(server.join().unwrap())
            .unwrap()
            .contains(&token)
    );
    assert!(
        !LEAKED.load(Ordering::Acquire),
        "bearer token reached the HTTP wire trace logger"
    );
}

#[test]
fn oversized_connect_proxy_headers_are_bounded_before_endpoint_tls() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let proxy_url = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        let mut first = String::new();
        reader.read_line(&mut first).unwrap();
        assert!(first.starts_with("CONNECT "));
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        let response = format!(
            "HTTP/1.1 200 Connection Established\r\nX-Padding: {}\r\n\r\n",
            "x".repeat(80000)
        );
        let _ = socket.write_all(response.as_bytes());
        let mut hello = [0];
        socket.read(&mut hello).unwrap_or(0)
    });
    let config = ureq::Agent::config_builder()
        .proxy(Some(ureq::Proxy::new(&proxy_url).unwrap()))
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .timeout_global(Some(Duration::from_secs(3)))
        .build();
    let connector =
        ().chain(ConnectProxyConnector::default())
            .chain(DriveConnector)
            .chain(NativeTlsConnector::default());
    let client = ureq::Agent::with_parts(config, RequestConnector(connector), DriveResolver);
    let head = RefCell::new(ResponseHead::default());
    let depth = Cell::new(0);
    let tick = || Ok(());
    let io = RequestIo {
        tick: &tick,
        head: &head,
        connector_depth: &depth,
        connect_deadline: Instant::now() + Duration::from_secs(3),
        attempt: &AttemptIo::default(),
        wake: &CancelWake::register(),
        cancelled: &Cell::new(false),
        poll_interval: POLL_INTERVAL,
        deadline: Instant::now() + Duration::from_secs(3),
    };
    assert!(
        TICK.set(io, || client.get("https://127.0.0.1:1/fixture").call())
            .is_err()
    );
    assert_eq!(
        server.join().unwrap(),
        0,
        "endpoint TLS started after an oversized CONNECT head"
    );
}

#[test]
fn native_user_agent_identifies_singz() {
    let (url, server) = fixture(b"{}".to_vec(), 200);
    request(get(&url, Destination::Bytes(512)), &|| false).unwrap();
    let raw = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(
        raw.lines().any(|line| line.eq_ignore_ascii_case(concat!(
            "User-Agent: SingZ/",
            env!("CARGO_PKG_VERSION"),
            " (native)"
        ))),
        "missing native SingZ user agent: {raw}"
    );
}

#[test]
fn large_upload_returns_early_unauthorized_without_sending_body() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        // Read one byte at a time so a buffered reader cannot hide body bytes.
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            socket.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        socket
            .write_all(
                b"HTTP/1.1 401 Unauthorized\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
            )
            .unwrap();
        // Closing with an upload in flight can reset the socket; Expect must
        // preserve the final status and keep the body off the wire entirely.
        let mut byte = [0];
        socket
            .set_read_timeout(Some(Duration::from_millis(100)))
            .unwrap();
        let body_bytes = socket.read(&mut byte).unwrap_or(0);
        (String::from_utf8(head).unwrap(), body_bytes)
    });
    let body = vec![0x5a; 8 * 1024 * 1024];
    let response = request(
        Request {
            method: "POST",
            body: Body::Bytes(&body),
            upload: true,
            ..get(&url, Destination::Bytes(512))
        },
        &|| false,
    );
    let (head, sent) = server.join().unwrap();
    assert_eq!(response.unwrap().status, 401);
    assert!(
        head.lines()
            .any(|line| line.eq_ignore_ascii_case("Expect: 100-continue"))
    );
    assert_eq!(sent, 0, "upload body sent before the early 401");
}

#[test]
fn resume_incomplete_308_without_location_is_a_response() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        reader.get_mut().write_all(b"HTTP/1.1 308 Resume Incomplete\r\nRange: bytes=0-1048575\r\nContent-Length: 0\r\nConnection: close\r\n\r\n").unwrap();
    });
    let response = request(get(&url, Destination::Bytes(512)), &|| false).unwrap();
    server.join().unwrap();
    assert_eq!(response.status, 308);
    assert_eq!(response.header("Range"), Some("bytes=0-1048575"));
    assert_eq!(response.header("Location"), None);
}

#[test]
fn normalized_url_reaches_the_server() {
    let (url, server) = fixture(b"{}".to_vec(), 200);
    let url = format!("{url}/../résumé");
    request(get(&url, Destination::Bytes(512)), &|| false).unwrap();
    let raw = String::from_utf8(server.join().unwrap()).unwrap();
    assert!(
        raw.starts_with("GET /r%C3%A9sum%C3%A9 HTTP/1.1\r\n"),
        "{raw}"
    );
}

#[test]
fn requests_survive_server_idle_close() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/idle", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        for _ in 0..2 {
            let (socket, _) = listener.accept().unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(1)))
                .unwrap();
            let mut reader = BufReader::new(socket);
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                if line == "\r\n" {
                    break;
                }
            }
            reader
                .get_mut()
                .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\n\r\n{}")
                .unwrap();
            // The server's idle policy closes the first connection at 1 s.
            let mut byte = [0];
            let _ = reader.read(&mut byte);
        }
    });
    for index in 0..2 {
        if index != 0 {
            thread::sleep(Duration::from_secs(2));
        }
        assert_eq!(
            request(get(&url, Destination::Bytes(512)), &|| false)
                .unwrap()
                .status,
            200
        );
    }
    server.join().unwrap();
}

#[test]
fn invalid_proxy_configuration_is_refused_without_contacting_drive() {
    const CHILD: &str = "SINGZ_TEST_INVALID_PROXY";
    if std::env::var_os(CHILD).is_some() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/proxy-check", listener.local_addr().unwrap());
        let stopped = Arc::new(AtomicBool::new(false));
        let stop = stopped.clone();
        let contacted = Arc::new(AtomicBool::new(false));
        let contact = contacted.clone();
        let server = thread::spawn(move || {
            while !stop.load(Ordering::Acquire) {
                if let Ok((mut socket, _)) = listener.accept() {
                    contact.store(true, Ordering::Release);
                    let _ = socket.write_all(
                        b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n",
                    );
                }
                thread::sleep(Duration::from_millis(1));
            }
        });
        let result = request(get(&url, Destination::Bytes(512)), &|| false);
        stopped.store(true, Ordering::Release);
        server.join().unwrap();
        let error = result
            .err()
            .expect("invalid proxy silently went direct")
            .to_string();
        assert!(
            error.contains("proxy") && error.contains("configuration"),
            "{error}"
        );
        assert!(!contacted.load(Ordering::Acquire));
        assert!(
            !error.contains("secret"),
            "proxy credentials leaked into the diagnostic"
        );
        return;
    }
    // Environment belongs to isolated children, never to the parallel test runner.
    for variable in ["HTTPS_PROXY", "HTTP_PROXY"] {
        let mut child = std::process::Command::new(std::env::current_exe().unwrap());
        child
            .arg("invalid_proxy_configuration_is_refused_without_contacting_drive")
            .arg("--nocapture")
            .env(CHILD, "1");
        for name in [
            "ALL_PROXY",
            "all_proxy",
            "HTTPS_PROXY",
            "https_proxy",
            "HTTP_PROXY",
            "http_proxy",
        ] {
            child.env_remove(name);
        }
        let output = child
            .env(variable, "http://secret:secret@ invalid")
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{variable}: {}{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        );
    }
}

#[test]
fn idle_connections_expire_before_five_seconds() {
    let fixture = KeepAliveFixture::new();
    request(get(&fixture.url, Destination::Bytes(512)), &|| false).unwrap();
    thread::sleep(Duration::from_millis(4500));
    request(get(&fixture.url, Destination::Bytes(512)), &|| false).unwrap();
    assert_eq!(fixture.connections.load(Ordering::Acquire), 2);
}

// Deterministically model a peer disappearing between the pool's open probe
// and the write. Real TCP timing cannot reliably exercise this narrow race.
#[derive(Debug)]
struct RaceConnector {
    opened: Arc<AtomicU64>,
    partial: bool,
    fail_fresh: bool,
}
impl Connector for RaceConnector {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<()>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        let number = self.opened.fetch_add(1, Ordering::AcqRel);
        Ok(DriveConnector.connect(details, chained)?.map(|inner| {
            Box::new(RaceTransport {
                inner,
                armed: self.fail_fresh,
                fail_on_probe: number == 0,
                partial: self.partial,
            }) as Self::Out
        }))
    }
}
struct RaceTransport {
    inner: Box<dyn Transport>,
    armed: bool,
    fail_on_probe: bool,
    partial: bool,
}
impl std::fmt::Debug for RaceTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("RaceTransport").finish_non_exhaustive()
    }
}
impl Transport for RaceTransport {
    fn buffers(&mut self) -> &mut dyn Buffers {
        self.inner.buffers()
    }
    fn await_input(&mut self, timeout: NextTimeout) -> std::result::Result<bool, ureq::Error> {
        self.inner.await_input(timeout)
    }
    fn transmit_output(
        &mut self,
        amount: usize,
        timeout: NextTimeout,
    ) -> std::result::Result<(), ureq::Error> {
        if self.armed {
            if self.partial {
                self.inner.transmit_output(1, timeout)?;
            }
            let error = TICK.with(|io| {
                io.attempt
                    .record_write(Err(std::io::ErrorKind::BrokenPipe.into()))
            });
            return error.map(|_| ()).map_err(ureq::Error::Io);
        }
        self.inner.transmit_output(amount, timeout)
    }
    fn is_open(&mut self) -> bool {
        let open = self.inner.is_open();
        self.armed = self.fail_on_probe;
        open
    }
}
fn race_agent(opened: Arc<AtomicU64>, partial: bool, fail_fresh: bool) -> ureq::Agent {
    ureq::Agent::with_parts(
        ureq::Agent::config_builder()
            .proxy(None)
            .http_status_as_error(false)
            .build(),
        RequestConnector(RaceConnector {
            opened,
            partial,
            fail_fresh,
        }),
        DriveResolver,
    )
}

#[test]
fn pooled_post_retries_once_only_before_any_socket_write() {
    let fixture = KeepAliveFixture::new();
    let opened = Arc::new(AtomicU64::new(0));
    let client = race_agent(opened.clone(), false, false);
    // Empty POST/PATCH requests are enough to prove that replay safety does
    // not depend on ureq's method-based idempotency rules.
    for method in ["POST", "PATCH"] {
        let req = Request {
            method,
            ..get(&fixture.url, Destination::Bytes(512))
        };
        assert_eq!(
            request_using_agent(req, &|| false, &|_| {}, &client)
                .unwrap()
                .status,
            200
        );
    }
    assert_eq!(opened.load(Ordering::Acquire), 2);
}

#[test]
fn a_partial_or_fresh_failed_write_is_never_retried() {
    for (partial, fresh) in [(true, false), (false, true)] {
        let fixture = KeepAliveFixture::new();
        let opened = Arc::new(AtomicU64::new(0));
        let client = race_agent(opened.clone(), partial, fresh);
        let req = Request {
            method: "POST",
            ..get(&fixture.url, Destination::Bytes(512))
        };
        if !fresh {
            request_using_agent(req, &|| false, &|_| {}, &client).unwrap();
        }
        assert!(request_using_agent(req, &|| false, &|_| {}, &client).is_err());
        assert_eq!(opened.load(Ordering::Acquire), 1);
    }
}

// Public, synthetic RSA key: SChannel's native-tls identity importer requires
// RSA PKCS#8. Generate fresh certificates at runtime so Secure Transport's
// maximum validity rules and calendar expiry cannot make this fixture stale.
fn tls_fixture_identity() -> (native_tls::Identity, ureq::tls::Certificate<'static>) {
    let leaf_key = rcgen::KeyPair::from_pem(
        r#"-----BEGIN PRIVATE KEY-----
MIIEvAIBADANBgkqhkiG9w0BAQEFAASCBKYwggSiAgEAAoIBAQDO2G5zT2i/qVNI
nilk46CFBvpydK0dFumMGhxuDZKAXZgGqT0jfGeqqgAgzxV5UXgC7cXtdlTZVlRx
5AgawDIhA/S0IR48VlEnaURi79i5pcPd3MGwxEazYUqEIio0aqBx1cTQf3IuP9U3
61Gtgda2wo3fHt8UVwy9uRSz8rVHBEwkwSdLHaHj/MciGB8v86Fg2RYsxbnF4mTN
7NKP0eSUiNqTjFgmg1vteaXkU1Dkz9/37S/pEAC8d8NgmUnaiKKtk12Ta15ug7JR
pwGuTKaoWAwDP8XQU+C4KG97FNOtLlh/b65TUklELOn1CHLushYGS01DFaM2F4F3
gLblzhkRAgMBAAECggEAKMiv7niH1NKUI0tcKhJfwhsAIrUytPuhjQhQ9roiWsEZ
iqav8WFEJ3hhkhaCy2ru2NT9I7cjP78v40zs9ClVOQFIrIOjLI5wbe7plwBnoSM4
HXS7lBj/P7s9MBR0ceVcQVW++sVGRCw95Eq3zhg9t8dgpc+2eJI5ZucpV9nROHEb
ueShbcWn3ZkCAm8p+IaCn6oruNDEW3WMG3qU3HZZCTz1m5hf8DffD61w43l2VMlO
Ri3dKCfZmA1W9v3p7l1RL5czvFLHLjDFNJBfcNe3/GzEjKiEG61bgK4YUvPajfcG
SE9DBRyI4aYuaJdh9SP319NvsgjLAAEtr2aWciTIgQKBgQDo8veBMfxMLi8FjfXm
tjzMlAsCoyCv/pB+JQhtvsROjoZTzosXjcpdX4vXHUtcHqjg1bGv/1X+ZcoGvF7E
YFWUnCnibH88sB/xBMzKlKJv/U2IhJT4dBEEmGjnFAl6A0fQlu9Z6PZLtMeeFRdm
5aLr8bxsCfzx3d+3X5WWN36tuQKBgQDjUDXpF3HQoixh0o4k1DO83Vn0krVhBcRC
e+g6/o4hgJn8ZbanFnzcpYiuJm9LisP/vP6c/tNLDCuOrEtNkI+zbwgukkntgJRs
XPKLE1eLfyoIoyNlvn7dRbbgEObeKhZPf8nXrUpRrLwbmXUjFdGwzOVEF14/xWng
0z9eKQkyGQKBgCvk5GhOv+im5ytXxZcUjb5KwwxbKqSfBiEO31i2kozu5DbUe3cT
u6b+gv4kwfd4u3+qJJIyPcTy7y93vS+pq1aWWnoU0aDg2xPyQJiHi1go1bw8p0lt
rWs9QL8SEnsQNS8D0dQSRp6bUOXjuYYlDR8CbOu6shPtJ+OIukoU6OTZAoGAAOX5
QJGSJpPtfvl5DFY2WiG50EigJOED9ItO0KTe5O0ALsosHZ7uIWUaFC4ctHy455LU
osQzC5Hhvi+aIJVYrAndS2nSlviyHXeEkd4is29uOBiE9Er7b15uKZaHgwtBiVDk
+FA8AfSfzbAekWPtrzgwE8PP4IqkL3pGPtYErkkCgYA3hQ6DuILrTtfGSHD6L3tp
y+fX8lutnBXJwbWd1DAD4A6/C9c0aBSoUPsLuvDqlbgpvCe38Ns3BuYab7ohMjBu
BC14vY0atz7yKs8ow4dmSZ5wQPeNuGw5YcukhsQ9qsqpLGGaedWyd2Yr9Cr5UieG
KYa4darlEF+99/56k+U57g==
-----END PRIVATE KEY-----
"#,
    )
    .unwrap();
    let ca_key = rcgen::KeyPair::generate().unwrap();
    let now = std::time::SystemTime::now();
    let mut ca_params = rcgen::CertificateParams::new(Vec::<String>::new()).unwrap();
    ca_params.not_before = (now - Duration::from_secs(86400)).into();
    ca_params.not_after = (now + Duration::from_secs(7 * 86400)).into();
    ca_params.is_ca = rcgen::IsCa::Ca(rcgen::BasicConstraints::Unconstrained);
    ca_params.key_usages = vec![rcgen::KeyUsagePurpose::KeyCertSign];
    ca_params
        .distinguished_name
        .push(rcgen::DnType::CommonName, "SingZ local test CA");
    let ca = ca_params.self_signed(&ca_key).unwrap();
    let issuer = rcgen::Issuer::new(ca_params, ca_key);
    let mut leaf_params =
        rcgen::CertificateParams::new(vec!["127.0.0.1".into(), "localhost".into()]).unwrap();
    leaf_params.not_before = (now - Duration::from_secs(86400)).into();
    leaf_params.not_after = (now + Duration::from_secs(7 * 86400)).into();
    leaf_params.is_ca = rcgen::IsCa::ExplicitNoCa;
    leaf_params.extended_key_usages = vec![rcgen::ExtendedKeyUsagePurpose::ServerAuth];
    leaf_params.key_usages = vec![
        rcgen::KeyUsagePurpose::DigitalSignature,
        rcgen::KeyUsagePurpose::KeyEncipherment,
    ];
    let leaf = leaf_params.signed_by(&leaf_key, &issuer).unwrap();
    // The client owns the root; the server needs no intermediate/root chain.
    (
        native_tls::Identity::from_pkcs8(
            leaf.pem().as_bytes(),
            leaf_key.serialize_pem().as_bytes(),
        )
        .unwrap(),
        ureq::tls::Certificate::from_der(ca.der().as_ref()).to_owned(),
    )
}

#[test]
fn tls_observer_panics_unwind_and_remove_partial_files() {
    const CHILD: &str = "SINGZ_TEST_TLS_OBSERVER_PANIC";
    let Ok(mode) = std::env::var(CHILD) else {
        for mode in ["progress", "cancel"] {
            // Own even native-tls's temporary keychain and a negative control's
            // abandoned partial file when an unsafe callback aborts its child.
            let scratch = Scratch::new().unwrap();
            let output = std::process::Command::new(std::env::current_exe().unwrap())
                .arg("tls_observer_panics_unwind_and_remove_partial_files")
                .arg("--nocapture")
                .env(CHILD, mode)
                .env("TMPDIR", &scratch.0)
                .env("TMP", &scratch.0)
                .env("TEMP", &scratch.0)
                .output()
                .unwrap();
            assert!(
                output.status.success(),
                "{mode} child did not unwind safely: {}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
        }
        return;
    };
    let (identity, certificate) = tls_fixture_identity();
    let acceptor = native_tls::TlsAcceptor::new(identity).unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("https://{}/download", listener.local_addr().unwrap());
    let ready = Arc::new(AtomicBool::new(false));
    let flag = ready.clone();
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut stream = acceptor.accept(socket).unwrap();
        let mut head = Vec::new();
        while !head.ends_with(b"\r\n\r\n") {
            let mut byte = [0];
            stream.read_exact(&mut byte).unwrap();
            head.push(byte[0]);
        }
        stream
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 65536\r\nConnection: close\r\n\r\n")
            .unwrap();
        stream.write_all(&vec![0x5a; 32768]).unwrap();
        // A pending native TLS read calls tick() after the first payload is
        // written to disk, exercising the C boundary rather than final progress.
        thread::sleep(Duration::from_millis(300));
        flag.store(true, Ordering::Release);
        thread::sleep(Duration::from_millis(100));
        let _ = stream.write_all(&vec![0x5a; 32768]);
    });
    let config = ureq::Agent::config_builder()
        .proxy(None)
        .max_redirects(0)
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs([certificate].into())
                .build(),
        )
        .build();
    let connector =
        ().chain(ConnectProxyConnector::default())
            .chain(DriveConnector)
            .chain(NativeTlsConnector::default());
    let client = ureq::Agent::with_parts(config, RequestConnector(connector), DriveResolver);
    let scratch = Scratch::new().unwrap();
    let path = scratch.0.join("tls-partial");
    let saw_partial = Cell::new(false);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
        request_using_agent(
            get(&url, Destination::File(&path, 131072)),
            &|| {
                if mode == "cancel" && ready.load(Ordering::Acquire) {
                    saw_partial.set(path.metadata().unwrap().len() > 0);
                    panic!("TLS cancellation observer panic");
                }
                false
            },
            &|bytes| {
                if mode == "progress" {
                    saw_partial.set(bytes > 0 && path.metadata().unwrap().len() > 0);
                    panic!("TLS progress observer panic");
                }
            },
            &client,
        )
    }));
    server.join().unwrap();
    let payload = result.err().expect("observer did not unwind to its caller");
    assert!(
        payload
            .downcast_ref::<&str>()
            .unwrap()
            .contains("observer panic")
    );
    assert!(
        saw_partial.get(),
        "panic did not occur during a partial download"
    );
    assert!(
        !path.exists(),
        "panicking TLS observer left its partial file"
    );
}

#[test]
fn large_upload_honors_continue_before_streaming() {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/upload", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(3)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        let mut expect = false;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
            expect |= line.trim().eq_ignore_ascii_case("Expect: 100-continue");
        }
        reader
            .get_mut()
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .unwrap();
        let mut body = vec![0; 1024 * 1024];
        reader.read_exact(&mut body).unwrap();
        assert!(body.iter().all(|byte| *byte == 0x5a));
        reader
            .get_mut()
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{}")
            .unwrap();
        expect
    });
    let body = vec![0x5a; 1024 * 1024];
    let response = request(
        Request {
            method: "PUT",
            body: Body::Bytes(&body),
            upload: true,
            ..get(&url, Destination::Bytes(512))
        },
        &|| false,
    )
    .unwrap();
    assert_eq!(response.status, 200);
    assert!(
        server.join().unwrap(),
        "missing Expect at the 1 MiB threshold"
    );
}

#[test]
#[cfg(unix)]
#[ignore = "manual 25-second held-server CPU measurement"]
fn local_fake_drive_25s_idle_wait_cpu() {
    fn cpu() -> f64 {
        let mut usage = std::mem::MaybeUninit::<libc::rusage>::uninit();
        assert_eq!(
            unsafe { libc::getrusage(libc::RUSAGE_SELF, usage.as_mut_ptr()) },
            0
        );
        let usage = unsafe { usage.assume_init() };
        usage.ru_utime.tv_sec as f64
            + usage.ru_utime.tv_usec as f64 / 1e6
            + usage.ru_stime.tv_sec as f64
            + usage.ru_stime.tv_usec as f64 / 1e6
    }
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/held", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(socket.try_clone().unwrap());
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        thread::sleep(Duration::from_secs(25));
        let _ =
            socket.write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 0\r\nConnection: close\r\n\r\n");
    });
    let checks = Cell::new(0u64);
    let began = Instant::now();
    let before = cpu();
    let _result = request(get(&url, Destination::Bytes(512)), &|| {
        checks.set(checks.get() + 1);
        false
    });
    let used = cpu() - before;
    let wall = began.elapsed().as_secs_f64();
    server.join().unwrap();
    eprintln!(
        "C12T_R2 idle_wall_s={wall:.6} process_cpu_s={used:.6} cpu_percent={:.3} cancel_checks={} checks_per_s={:.3}",
        100.0 * used / wall,
        checks.get(),
        checks.get() as f64 / wall
    );
}

#[test]
fn cancelled_network_wait_wakes_without_a_poll_timer() {
    cancellation_wait_fixture(true);
}
#[test]
fn caller_only_cancellation_retains_a_bounded_timer_fallback() {
    cancellation_wait_fixture(false);
}
fn cancellation_wait_fixture(notify: bool) {
    struct Restore(Option<Duration>);
    impl Drop for Restore {
        fn drop(&mut self) {
            TEST_CALLER_POLL_INTERVAL.with(|v| v.set(self.0));
        }
    }
    let _restore = Restore(TEST_CALLER_POLL_INTERVAL.with(|v| {
        v.replace(if notify {
            Some(Duration::from_secs(60))
        } else {
            None
        })
    }));
    let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/held", listener.local_addr().unwrap());
    let cancelled = Arc::new(AtomicBool::new(false));
    let flag = cancelled.clone();
    let (began, started) = std::sync::mpsc::channel();
    let (release, released) = std::sync::mpsc::channel();
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        let mut reader = BufReader::new(socket);
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            if line == "\r\n" {
                break;
            }
        }
        thread::sleep(Duration::from_millis(30));
        let at = Instant::now();
        flag.store(true, Ordering::Release);
        began.send(at).unwrap();
        if notify {
            wake_cancelled_requests();
        }
        let _ = released.recv_timeout(Duration::from_secs(1));
    });
    let checks = Cell::new(0u64);
    let result = request(get(&url, Destination::Bytes(512)), &|| {
        checks.set(checks.get() + 1);
        cancelled.load(Ordering::Acquire)
    });
    let elapsed = started.recv().unwrap().elapsed();
    release.send(()).ok();
    server.join().unwrap();
    assert!(
        result
            .err()
            .expect("wait must cancel")
            .to_string()
            .contains("cancelled")
    );
    // Event cancellation gets scheduling margin on loaded runners; its 60 s
    // timer override still proves the notification path. A plain closure uses
    // a 20 ms timer, plus the Windows tick and teardown/scheduling margin.
    let budget = if notify {
        250
    } else if cfg!(windows) {
        50
    } else {
        25
    };
    assert!(
        elapsed <= Duration::from_millis(budget),
        "notify={notify} cancellation took {elapsed:?}"
    );
    // Other tests may legitimately notify the process-wide signal. The
    // 60-second override, rather than a global wake count, excludes timer
    // polling from the signalled case; the isolated benchmark counts checks.
    eprintln!(
        "C12T_R2 notify={} cancel_us={} checks={}",
        notify,
        elapsed.as_micros(),
        checks.get()
    );
}

#[derive(Debug)]
struct ConfigLevelConnector(Arc<Mutex<Vec<bool>>>);
impl Connector for ConfigLevelConnector {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<()>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        self.0.lock().unwrap().push(details.request_level);
        DriveConnector.connect(details, chained)
    }
}
#[test]
fn new_connections_keep_agent_level_tls_configuration() {
    let fixture = KeepAliveFixture::new();
    let levels = Arc::new(Mutex::new(Vec::new()));
    let client = ureq::Agent::with_parts(
        ureq::Agent::config_builder()
            .proxy(None)
            .max_idle_connections(0)
            .build(),
        RequestConnector(ConfigLevelConnector(levels.clone())),
        DriveResolver,
    );
    for _ in 0..2 {
        request_using_agent(
            get(&fixture.url, Destination::Bytes(512)),
            &|| false,
            &|_| {},
            &client,
        )
        .unwrap();
    }
    assert_eq!(
        *levels.lock().unwrap(),
        vec![false, false],
        "per-request config bypassed native TLS connector caching"
    );
    assert_eq!(fresh_agent().config().max_idle_connections(), 0);
}

#[derive(Debug)]
struct ReadRaceConnector {
    opened: Arc<AtomicU64>,
    reset: bool,
    partial: bool,
    fail_fresh: bool,
    fail_retry: bool,
}
impl Connector for ReadRaceConnector {
    type Out = Box<dyn Transport>;
    fn connect(
        &self,
        details: &ConnectionDetails<'_>,
        chained: Option<()>,
    ) -> std::result::Result<Option<Self::Out>, ureq::Error> {
        let number = self.opened.fetch_add(1, Ordering::AcqRel);
        Ok(DriveConnector.connect(details, chained)?.map(|inner| {
            Box::new(ReadRaceTransport {
                inner,
                armed: self.fail_fresh || (self.fail_retry && number > 0),
                fail_on_probe: number == 0,
                reset: self.reset,
                partial: self.partial,
                sent_partial: false,
            }) as Self::Out
        }))
    }
}
struct ReadRaceTransport {
    inner: Box<dyn Transport>,
    armed: bool,
    fail_on_probe: bool,
    reset: bool,
    partial: bool,
    sent_partial: bool,
}
impl std::fmt::Debug for ReadRaceTransport {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("ReadRaceTransport").finish_non_exhaustive()
    }
}
impl Transport for ReadRaceTransport {
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
        if self.armed {
            if self.partial && !self.sent_partial {
                self.sent_partial = true;
                let bytes = b"HTTP/1.1 ";
                self.inner.buffers().input_append_buf()[..bytes.len()].copy_from_slice(bytes);
                self.inner.buffers().input_appended(bytes.len());
                return Ok(true);
            }
            TICK.with(|io| io.attempt.read_closed.set(true));
            return if self.reset {
                Err(ureq::Error::Io(std::io::ErrorKind::ConnectionReset.into()))
            } else {
                Ok(false)
            };
        }
        self.inner.await_input(timeout)
    }
    fn is_open(&mut self) -> bool {
        let open = self.inner.is_open();
        self.armed |= self.fail_on_probe;
        open
    }
}
fn read_race_agent(
    opened: Arc<AtomicU64>,
    reset: bool,
    partial: bool,
    fail_fresh: bool,
    fail_retry: bool,
    idle: usize,
) -> ureq::Agent {
    ureq::Agent::with_parts(
        ureq::Agent::config_builder()
            .proxy(None)
            .http_status_as_error(false)
            .max_idle_connections(idle)
            .build(),
        RequestConnector(ReadRaceConnector {
            opened,
            reset,
            partial,
            fail_fresh,
            fail_retry,
        }),
        DriveResolver,
    )
}
#[test]
fn pooled_get_and_head_retry_eof_or_reset_before_response_bytes() {
    for method in ["GET", "HEAD"] {
        for reset in [false, true] {
            let fixture = KeepAliveFixture::new();
            let opened = Arc::new(AtomicU64::new(0));
            let client = read_race_agent(opened.clone(), reset, false, false, false, 8);
            let fresh = read_race_agent(opened.clone(), reset, false, false, false, 0);
            request_using_agents(
                get(&fixture.url, Destination::Bytes(512)),
                &|| false,
                &|_| {},
                &client,
                &fresh,
            )
            .unwrap();
            let req = Request {
                method,
                ..get(&fixture.url, Destination::Bytes(512))
            };
            assert_eq!(
                request_using_agents(req, &|| false, &|_| {}, &client, &fresh)
                    .unwrap()
                    .status,
                200
            );
            assert_eq!(opened.load(Ordering::Acquire), 2);
        }
    }
}
#[test]
fn response_read_retry_never_replays_writes_partial_headers_or_fresh_failures() {
    for (method, partial, fresh_failure, retry_failure, expected) in [
        ("POST", false, false, false, 1),
        ("PATCH", false, false, false, 1),
        ("GET", true, false, false, 1),
        ("GET", false, true, false, 1),
        ("GET", false, false, true, 2),
    ] {
        let fixture = KeepAliveFixture::new();
        let opened = Arc::new(AtomicU64::new(0));
        let client = read_race_agent(
            opened.clone(),
            true,
            partial,
            fresh_failure,
            retry_failure,
            8,
        );
        let fresh = read_race_agent(
            opened.clone(),
            true,
            partial,
            fresh_failure,
            retry_failure,
            0,
        );
        if !fresh_failure {
            request_using_agents(
                get(&fixture.url, Destination::Bytes(512)),
                &|| false,
                &|_| {},
                &client,
                &fresh,
            )
            .unwrap();
        }
        let req = Request {
            method,
            ..get(&fixture.url, Destination::Bytes(512))
        };
        assert!(request_using_agents(req, &|| false, &|_| {}, &client, &fresh).is_err());
        assert_eq!(
            opened.load(Ordering::Acquire),
            expected,
            "{method} partial={partial} fresh={fresh_failure}"
        );
    }
}

#[test]
fn socks_proxy_reports_unsupported_without_exposing_credentials() {
    const CHILD: &str = "SINGZ_TEST_SOCKS_PROXY";
    if std::env::var_os(CHILD).is_some() {
        let error = request(
            get("https://drive.invalid/", Destination::Bytes(512)),
            &|| false,
        )
        .err()
        .unwrap();
        assert_eq!(error.to_string(), "SOCKS proxy not supported");
        assert!(!format!("{error:#}").contains("fixture-secret"));
        return;
    }
    let mut child = std::process::Command::new(std::env::current_exe().unwrap());
    child
        .arg("socks_proxy_reports_unsupported_without_exposing_credentials")
        .arg("--nocapture")
        .env(CHILD, "1");
    for name in [
        "ALL_PROXY",
        "all_proxy",
        "HTTPS_PROXY",
        "https_proxy",
        "HTTP_PROXY",
        "http_proxy",
    ] {
        child.env_remove(name);
    }
    let result = child
        .env("HTTPS_PROXY", "socks5://user:fixture-secret@127.0.0.1:1")
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "{}{}",
        String::from_utf8_lossy(&result.stdout),
        String::from_utf8_lossy(&result.stderr)
    );
}

use super::*;
use std::{
    io::{BufRead, BufReader},
    sync::mpsc,
};

struct Directory(PathBuf);
impl Directory {
    fn new() -> Self {
        let path = std::env::temp_dir().join(format!(
            "singz-drive-auth-test-{}",
            drive_http::random_id().unwrap()
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
}
impl Drop for Directory {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn config(base: &str) -> Config {
    Config::from_json(&serde_json::json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":base,"apiBase":base}).to_string()).unwrap()
}
#[test]
fn empty_baked_endpoints_use_google_defaults_and_disk_generation_fences_stale_store() {
    let cfg=Config::from_json(r#"{"clientId":"fixture","clientSecret":"","authBase":"","apiBase":"","uploadBase":"","tokenUrl":""}"#).unwrap();
    assert_eq!(cfg.auth_base, "https://accounts.google.com");
    assert_eq!(cfg.api_base, "https://www.googleapis.com");
    assert_eq!(cfg.token_url, "https://oauth2.googleapis.com/token");
    let directory = Directory::new();
    let first = TokenStore::new(&directory.0).unwrap();
    let second = TokenStore::new(&directory.0).unwrap();
    let before = first.generation();
    second.sign_out().unwrap();
    assert!(
        first
            .adopt(
                before,
                Tokens {
                    access: "late".into(),
                    refresh: "late-refresh".into(),
                    expires_at: u64::MAX
                }
            )
            .is_err()
    );
    assert!(!first.signed_in());
    assert_eq!(first.generation(), second.generation());
}

#[test]
fn held_session_lease_is_bounded_and_does_not_erase_saved_credentials() {
    let directory = Directory::new();
    let mut first = TokenStore::new(&directory.0).unwrap();
    Arc::get_mut(&mut first.0).unwrap().lock_timeout = Duration::from_millis(80);
    first
        .adopt(
            0,
            Tokens {
                access: "private-fixture-access".into(),
                refresh: "private-fixture-refresh".into(),
                expires_at: u64::MAX,
            },
        )
        .unwrap();
    let second = TokenStore::new(&directory.0).unwrap();
    let path = directory.0.join("gdrive/session.json");
    let original = fs::read(&path).unwrap();
    let held = second.lock().unwrap();
    let started = Instant::now();
    let error = first
        .signed_in_checked()
        .err()
        .expect("Held lease must report an error");
    assert!(
        started.elapsed() < Duration::from_secs(1),
        "Session lock wait exceeded its injected deadline"
    );
    let message = error.to_string();
    assert!(message.contains("busy"));
    assert!(
        !message.contains("private-fixture-access") && !message.contains("private-fixture-refresh")
    );
    assert!(first.sign_out().is_err());
    assert_eq!(first.generation(), u64::MAX);
    assert!(
        fs::read(&path).unwrap() == original,
        "A failed session lease changed the private file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    drop(held);
    assert!(first.signed_in_checked().unwrap());
    assert!(
        first
            .access_token(&config("http://127.0.0.1:1"), false, &|| false)
            .is_ok()
    );
    assert!(
        fs::read(&path).unwrap() == original,
        "Reading a released session changed the private file"
    );
}

#[test]
fn same_store_mutex_wait_uses_the_same_bounded_deadline() {
    let directory = Directory::new();
    let mut store = TokenStore::new(&directory.0).unwrap();
    Arc::get_mut(&mut store.0).unwrap().lock_timeout = Duration::from_millis(50);
    let held = store.lock().unwrap();
    let started = Instant::now();
    assert!(store.signed_in_checked().is_err());
    assert!(started.elapsed() < Duration::from_secs(1));
    drop(held);
    assert!(!store.signed_in_checked().unwrap());
}
fn read_request(stream: &TcpStream) -> (String, String) {
    let mut reader = BufReader::new(stream.try_clone().unwrap());
    let mut head = String::new();
    let mut size = 0;
    loop {
        let mut line = String::new();
        reader.read_line(&mut line).unwrap();
        assert!(!line.is_empty());
        head.push_str(&line);
        if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
            size = value.trim().parse().unwrap();
        }
        if line == "\r\n" {
            break;
        }
    }
    let mut body = vec![0u8; size];
    reader.read_exact(&mut body).unwrap();
    (head, String::from_utf8(body).unwrap())
}
fn response(stream: &mut TcpStream, status: u16, body: &str) {
    write!(
        stream,
        "HTTP/1.1 {status} Fixture\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
        body.len()
    )
    .unwrap();
}
fn callback(redirect: &str, query: &str) -> String {
    let target = url::Url::parse(redirect).unwrap();
    let host = format!("{}:{}", target.host_str().unwrap(), target.port().unwrap());
    let mut stream = TcpStream::connect(&host).unwrap();
    stream
        .set_read_timeout(Some(Duration::from_secs(3)))
        .unwrap();
    write!(
        stream,
        "GET {}?{query} HTTP/1.1\r\nHost: {host}\r\nConnection: close\r\n\r\n",
        target.path()
    )
    .unwrap();
    let mut reply = String::new();
    stream.read_to_string(&mut reply).unwrap();
    reply
}
#[test]
fn oauth_uses_state_pkce_and_exact_callback_then_private_tokens() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let cfg = config(&format!("http://{}", server.local_addr().unwrap()));
    let session = OAuthSession::start(cfg, store.clone()).unwrap();
    let auth = url::Url::parse(session.authorization_url()).unwrap();
    let pairs = auth
        .query_pairs()
        .into_owned()
        .collect::<std::collections::HashMap<_, _>>();
    assert_eq!(pairs["code_challenge_method"], "S256");
    assert_eq!(pairs["scope"], "https://www.googleapis.com/auth/drive.file");
    let challenge = pairs["code_challenge"].clone();
    let redirect = pairs["redirect_uri"].clone();
    let expected_redirect = redirect.clone();
    let state = pairs["state"].clone();
    let token_server = thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        let (head, body) = read_request(&stream);
        assert!(head.starts_with("POST /token "));
        let fields = url::form_urlencoded::parse(body.as_bytes())
            .into_owned()
            .collect::<std::collections::HashMap<_, _>>();
        assert_eq!(fields["client_secret"], "fixture-secret");
        assert_eq!(fields["redirect_uri"], expected_redirect);
        assert_eq!(fields["code"], "fixture-code");
        assert_eq!(
            URL_SAFE_NO_PAD.encode(Sha256::digest(fields["code_verifier"].as_bytes())),
            challenge
        );
        response(
            &mut stream,
            200,
            r#"{"access_token":"access-fixture","refresh_token":"refresh-fixture","expires_in":3600}"#,
        );
    });
    let finish = thread::spawn(move || session.finish(&|| false));
    assert!(callback(&redirect, "state=wrong&code=untrusted").starts_with("HTTP/1.1 400"));
    assert!(!store.signed_in());
    let mut query_form = url::form_urlencoded::Serializer::new(String::new());
    query_form
        .append_pair("state", &state)
        .append_pair("code", "fixture-code");
    let query = query_form.finish();
    assert!(callback(&redirect, &query).starts_with("HTTP/1.1 200"));
    finish.join().unwrap().unwrap();
    token_server.join().unwrap();
    assert!(store.signed_in());
    let session_file = directory.0.join("gdrive/session.json");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(
            fs::metadata(&session_file).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }
    assert!(
        !fs::read_to_string(session_file)
            .unwrap()
            .contains("fixture-secret")
    );
    store.sign_out().unwrap();
    assert!(!TokenStore::new(&directory.0).unwrap().signed_in());
}

#[test]
fn fragmented_callback_waits_without_spinning_and_remains_cancellable() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let session = OAuthSession::start(config("http://127.0.0.1:9"), store.clone()).unwrap();
    let mut client = TcpStream::connect(session.listener.local_addr().unwrap()).unwrap();
    client.write_all(b"GET /oauth2/callback?partial").unwrap();
    // A completed client connect does not guarantee that this nonblocking
    // listener can accept immediately (observed under the full suite load).
    // Keep its mode so the callback still exercises inherited O_NONBLOCK.
    let accept_deadline = Instant::now() + Duration::from_secs(2);
    let mut stream = loop {
        match session.listener.accept() {
            Ok((stream, _)) => break stream,
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                assert!(
                    Instant::now() < accept_deadline,
                    "Callback connection was not accepted"
                );
                thread::sleep(Duration::from_millis(2));
            }
            Err(error) => panic!("Callback accept failed: {error}"),
        }
    };
    let started = Instant::now();
    let calls = std::cell::Cell::new(0);
    let result = session.callback(&mut stream, &|| {
        calls.set(calls.get() + 1);
        assert!(
            calls.get() < 128,
            "Fragmented callback busy-spun instead of honoring its bounded socket read"
        );
        started.elapsed() >= Duration::from_millis(120)
    });
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    assert!(!store.signed_in());
}
#[test]
fn sign_out_and_latest_sign_in_cancel_older_callback_without_network() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let cfg = config("http://127.0.0.1:1");
    let first = OAuthSession::start(cfg.clone(), store.clone()).unwrap();
    let second = OAuthSession::start(cfg, store.clone()).unwrap();
    assert!(first.finish(&|| false).is_err());
    store.sign_out().unwrap();
    assert!(second.finish(&|| false).is_err());
    assert!(!store.signed_in());
}
#[test]
fn refresh_completion_cannot_resurrect_signed_out_session() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store
        .adopt(
            0,
            Tokens {
                access: "expired".into(),
                refresh: "fixture-refresh".into(),
                expires_at: 0,
            },
        )
        .unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let cfg = config(&format!("http://{}", server.local_addr().unwrap()));
    let (ready, wait) = mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        read_request(&stream);
        ready.send(()).unwrap();
        thread::sleep(Duration::from_millis(100));
        let _ = write!(
            stream,
            "HTTP/1.1 200 OK\r\nContent-Length: 58\r\nConnection: close\r\n\r\n{{\"access_token\":\"late-fixture-token\",\"expires_in\":3600}}"
        );
    });
    let renewing = store.clone();
    let renewal = thread::spawn(move || renewing.access_token(&cfg, false, &|| false));
    wait.recv_timeout(Duration::from_secs(3)).unwrap();
    TokenStore::new(&directory.0).unwrap().sign_out().unwrap();
    let error = renewal
        .join()
        .unwrap()
        .err()
        .expect("Signed-out refresh must fail");
    assert_eq!(session_expired_generation(&error), None);
    worker.join().unwrap();
    assert!(!store.signed_in());
    assert!(!TokenStore::new(&directory.0).unwrap().signed_in());
}

#[test]
fn rejected_refresh_reports_only_the_exact_generation_it_cleared() {
    for (status, body) in [
        (400, r#"{"error":"invalid_grant"}"#),
        (401, r#"{"error":"invalid_grant"}"#),
        (200, r#"{"expires_in":3600}"#),
    ] {
        let directory = Directory::new();
        let store = TokenStore::new(&directory.0).unwrap();
        store
            .adopt(
                0,
                Tokens {
                    access: "expired-fixture".into(),
                    refresh: "refresh-fixture".into(),
                    expires_at: 0,
                },
            )
            .unwrap();
        let server = TcpListener::bind("127.0.0.1:0").unwrap();
        let cfg = config(&format!("http://{}", server.local_addr().unwrap()));
        let worker = thread::spawn(move || {
            let (mut stream, _) = server.accept().unwrap();
            let (head, form) = read_request(&stream);
            assert!(head.starts_with("POST /token "));
            assert!(form.contains("grant_type=refresh_token"));
            response(&mut stream, status, body);
        });
        let error = store
            .access_token(&cfg, false, &|| false)
            .err()
            .expect("Rejected refresh must fail");
        worker.join().unwrap();
        assert_eq!(session_expired_generation(&error), Some(1));
        assert_eq!(
            error
                .downcast_ref::<SessionExpired>()
                .unwrap()
                .cleared_generation(),
            1
        );
        assert_eq!(store.current_expired_generation(&error).unwrap(), Some(1));
        assert!(!store.signed_in_checked().unwrap());
        assert_eq!(store.generation(), 1);
        assert!(!error.to_string().contains("expired-fixture"));
        let error = error.context("Drive run failed");
        assert_eq!(session_expired_generation(&error), Some(1));
        // A subsequent explicit sign-out changes ownership even though the
        // earlier error keeps its historical, actually-cleared generation.
        TokenStore::new(&directory.0).unwrap().sign_out().unwrap();
        assert_eq!(store.current_expired_generation(&error).unwrap(), None);
        assert_eq!(session_expired_generation(&error), Some(1));
    }
}

#[test]
fn external_session_change_cannot_be_reported_as_this_refresh_expiring() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store
        .adopt(
            0,
            Tokens {
                access: "expired-fixture".into(),
                refresh: "refresh-fixture".into(),
                expires_at: 0,
            },
        )
        .unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let cfg = config(&format!("http://{}", server.local_addr().unwrap()));
    let (ready, ready_rx) = mpsc::channel();
    let (release, release_rx) = mpsc::channel();
    let worker = thread::spawn(move || {
        let (mut stream, _) = server.accept().unwrap();
        read_request(&stream);
        ready.send(()).unwrap();
        release_rx.recv_timeout(Duration::from_secs(3)).unwrap();
        let body = r#"{"error":"invalid_grant"}"#;
        let _ = write!(
            stream,
            "HTTP/1.1 400 Rejected\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
            body.len()
        );
    });
    let renewing = store.clone();
    let renewal = thread::spawn(move || renewing.access_token(&cfg, false, &|| false));
    ready_rx.recv_timeout(Duration::from_secs(3)).unwrap();
    TokenStore::new(&directory.0).unwrap().sign_out().unwrap();
    release.send(()).unwrap();
    let error = renewal
        .join()
        .unwrap()
        .err()
        .expect("Concurrent sign-out must fence refresh");
    worker.join().unwrap();
    assert_eq!(session_expired_generation(&error), None);
    assert_eq!(store.current_expired_generation(&error).unwrap(), None);
    assert_eq!(store.generation(), 1);
    // Also cover the exact compare-and-clear race after HTTP validation: this
    // stale generation did not remove the credentials and cannot claim expiry.
    assert_eq!(store.clear_if(0).unwrap(), None);
    assert_eq!(session_expired_generation(&store.expired(0)), None);
}
#[test]
fn authorized_request_refreshes_only_once_on_401() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store
        .adopt(
            0,
            Tokens {
                access: "old-fixture-token".into(),
                refresh: "fixture-refresh".into(),
                expires_at: u64::MAX,
            },
        )
        .unwrap();
    let server = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", server.local_addr().unwrap());
    let cfg = config(&base);
    let worker = thread::spawn(move || {
        for step in 0..3 {
            let (mut stream, _) = server.accept().unwrap();
            let (head, body) = read_request(&stream);
            match step {
                0 => {
                    assert!(head.contains("Authorization: Bearer old-fixture-token"));
                    response(&mut stream, 401, "{}");
                }
                1 => {
                    assert!(head.starts_with("POST /token "));
                    assert!(body.contains("grant_type=refresh_token"));
                    response(
                        &mut stream,
                        200,
                        r#"{"access_token":"new-fixture-token","expires_in":3600}"#,
                    );
                }
                _ => {
                    assert!(head.contains("Authorization: Bearer new-fixture-token"));
                    response(&mut stream, 401, "{}");
                }
            }
        }
    });
    let url = format!("{base}/drive/v3/files");
    let reply = AuthClient::new(cfg, store)
        .request(
            Request {
                method: "GET",
                url: &url,
                headers: &[],
                body: Body::Empty,
                destination: Destination::Bytes(4096),
                upload: false,
                allow_loopback_http: true,
            },
            &|| false,
        )
        .unwrap();
    assert_eq!(reply.status, 401);
    worker.join().unwrap();
}

#[test]
fn steady_cancel_generation_has_no_filesystem_or_lock_operations() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let _observation = store.observe().unwrap();
    let expected = store.generation();
    let before = AUTH_IO_COUNTS.with(|count| count.get());
    for _ in 0..10000 {
        assert_eq!(store.generation(), expected);
    }
    let after = AUTH_IO_COUNTS.with(|count| count.get());
    assert_eq!(
        after, before,
        "cancel checks performed filesystem/locking operations"
    );
}

#[cfg(unix)]
fn process_cpu_seconds() -> f64 {
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

#[test]
#[cfg(unix)]
#[ignore = "manual 30-second active-upload CPU measurement"]
fn local_fake_drive_30s_upload_cpu() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store
        .adopt(
            0,
            Tokens {
                access: "fixture-access".into(),
                refresh: "fixture-refresh".into(),
                expires_at: u64::MAX,
            },
        )
        .unwrap();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        socket
            .set_read_timeout(Some(Duration::from_secs(35)))
            .unwrap();
        let mut reader = BufReader::new(socket);
        let mut size = None;
        loop {
            let mut line = String::new();
            reader.read_line(&mut line).unwrap();
            assert!(!line.is_empty());
            if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                size = Some(value.trim().parse::<usize>().unwrap());
            }
            if line == "\r\n" {
                break;
            }
        }
        let size = size.unwrap();
        reader
            .get_mut()
            .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
            .unwrap();
        let started = Instant::now();
        let mut bytes = 0;
        let mut chunk = [0; 32768];
        while bytes < size {
            let take = chunk.len().min(size - bytes);
            reader.read_exact(&mut chunk[..take]).unwrap();
            bytes += take;
            let target = Duration::from_secs(30).mul_f64(bytes as f64 / size as f64);
            if let Some(left) = target.checked_sub(started.elapsed()) {
                thread::sleep(left);
            }
        }
        response(reader.get_mut(), 200, "{}");
        bytes
    });
    let body = vec![0x5a; 8 * 1024 * 1024];
    let url = format!("{base}/upload");
    let client = AuthClient::new(config(&base), store.clone());
    let expected = store.generation();
    let counts = AUTH_IO_COUNTS.with(|count| count.get());
    let cpu = process_cpu_seconds();
    let wall = Instant::now();
    let reply = client
        .request(
            Request {
                method: "PUT",
                url: &url,
                headers: &[],
                body: Body::Bytes(&body),
                destination: Destination::Bytes(512),
                upload: true,
                allow_loopback_http: true,
            },
            &|| store.generation() != expected,
        )
        .unwrap();
    let wall = wall.elapsed();
    let cpu = process_cpu_seconds() - cpu;
    assert_eq!(reply.status, 200);
    assert_eq!(server.join().unwrap(), body.len());
    let after = AUTH_IO_COUNTS.with(|count| count.get());
    eprintln!(
        "C12T_AUTH upload_wall_s={:.6} process_cpu_s={:.6} cpu_percent={:.3} caller_fs_ops={} caller_lock_ops={}",
        wall.as_secs_f64(),
        cpu,
        100.0 * cpu / wall.as_secs_f64(),
        after.0 - counts.0,
        after.1 - counts.1
    );
}

fn fixture_tokens(refresh: &str) -> Tokens {
    Tokens {
        access: "fixture-access".into(),
        refresh: refresh.into(),
        expires_at: u64::MAX,
    }
}
fn wait_for(mut condition: impl FnMut() -> bool) {
    let until = Instant::now() + Duration::from_secs(1);
    while !condition() {
        assert!(
            Instant::now() < until,
            "observer did not reach its expected state"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[test]
fn in_process_signout_cancels_transfer_before_waiting_for_lease() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    let generation = store.generation();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/download", listener.local_addr().unwrap());
    let (ready, waiting) = mpsc::channel();
    let (release, released) = mpsc::channel();
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&socket);
        socket
            .write_all(b"HTTP/1.1 200 OK\r\nContent-Length: 131072\r\n\r\n")
            .unwrap();
        socket.write_all(&vec![0x5a; 65536]).unwrap();
        ready.send(()).unwrap();
        released.recv_timeout(Duration::from_secs(3)).unwrap();
    });
    let path = directory.0.join("partial-download");
    let output = path.clone();
    let downloading = store.clone();
    let client = AuthClient::new(
        config(
            url::Url::parse(&url)
                .unwrap()
                .origin()
                .ascii_serialization()
                .as_str(),
        ),
        store.clone(),
    );
    let (done, finished) = mpsc::channel();
    let transfer = thread::spawn(move || {
        let result = drive_http::with_test_network_wait(
            Duration::from_secs(60),
            Arc::new(AtomicBool::new(false)),
            || {
                client.request(
                    Request {
                        method: "GET",
                        url: &url,
                        headers: &[],
                        body: Body::Empty,
                        destination: Destination::File(&output, 200000),
                        upload: false,
                        allow_loopback_http: true,
                    },
                    &|| downloading.generation() != generation,
                )
            },
        );
        done.send((result.is_err(), Instant::now())).unwrap();
    });
    waiting.recv_timeout(Duration::from_secs(3)).unwrap();
    wait_for(|| path.metadata().is_ok_and(|meta| meta.len() > 0));
    let held = store.lock().unwrap();
    let signing_out = store.clone();
    let (started, start) = mpsc::channel();
    let signout = thread::spawn(move || {
        started.send(Instant::now()).unwrap();
        signing_out.sign_out()
    });
    let start = start.recv_timeout(Duration::from_secs(1)).unwrap();
    let result = finished.recv_timeout(Duration::from_millis(250));
    // Always release the held lease and join fixture threads, even for the
    // before-fix failure; a deadline assertion must not leave a live request.
    drop(held);
    signout.join().unwrap().unwrap();
    release.send(()).unwrap();
    server.join().unwrap();
    transfer.join().unwrap();
    if result.is_err() {
        if let Ok((_, ended)) = finished.try_recv() {
            eprintln!(
                "C12T_AUTH late_signout_cancel_us={}",
                ended.duration_since(start).as_micros()
            );
        }
    }
    let (cancelled, ended) = result.expect("sign-out cancellation waited for the session lease");
    let latency = ended.duration_since(start);
    assert!(cancelled);
    assert!(
        latency <= Duration::from_millis(250),
        "sign-out cancellation took {latency:?}"
    );
    assert!(
        !path.exists(),
        "cancelled transfer retained its partial file"
    );
    eprintln!(
        "C12T_AUTH in_process_signout_cancel_us={}",
        latency.as_micros()
    );
}

#[test]
fn direct_disk_signout_is_observed_without_lease_within_observer_bound() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    let generation = store.generation();
    // A writer may still own its lease after changing the file. Observations
    // cannot wait for that lease; writes still must do so.
    let held = crate::file_lease::Lease::acquire(
        fs::OpenOptions::new()
            .read(true)
            .write(true)
            .open(store.0.path.with_extension("lock"))
            .unwrap(),
    )
    .unwrap();
    fs::write(
        &store.0.path,
        serde_json::to_vec(&State {
            generation: 0,
            tokens: None,
        })
        .unwrap(),
    )
    .unwrap();
    let started = Instant::now();
    let changed = loop {
        if store.generation() != generation {
            break true;
        }
        if started.elapsed() > (OBSERVATION_MAX_AGE + Duration::from_millis(500)) {
            break false;
        }
        thread::sleep(Duration::from_millis(2));
    };
    let latency = started.elapsed();
    let observed = store.generation();
    drop(held);
    assert_ne!(
        observed,
        u64::MAX,
        "file change was not read before the freshness deadline"
    );
    assert!(
        changed && latency <= (OBSERVATION_MAX_AGE + Duration::from_millis(500)),
        "disk change detection took {latency:?}"
    );
    eprintln!("C12T_AUTH disk_change_cancel_us={}", latency.as_micros());
}

#[test]
fn token_write_guard_reads_disk_inside_observation_debounce() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    store.0.observer.core.pause.store(true, Ordering::Release);
    let expected = store.generation();
    let bytes = serde_json::to_vec(&State {
        generation: 1,
        tokens: None,
    })
    .unwrap();
    fs::write(&store.0.path, &bytes).unwrap();
    assert_eq!(
        store.generation(),
        expected,
        "fixture missed the debounce window"
    );
    assert!(
        store.adopt(0, fixture_tokens("late-refresh")).is_err(),
        "cached write guard overwrote a new session"
    );
    assert_eq!(fs::read(&store.0.path).unwrap(), bytes);
    store.0.observer.core.pause.store(false, Ordering::Release);
}

#[test]
fn stale_observer_fails_closed_and_does_not_resume_the_old_epoch() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let _observation = store.observe().unwrap();
    store.0.observer.core.pause.store(true, Ordering::Release);
    let expected = store.generation();
    let start = Instant::now();
    while store.generation() == expected
        && start.elapsed() <= (OBSERVATION_MAX_AGE + Duration::from_millis(500))
    {
        // The two-second age plus 50 ms covers one Windows 15.6 ms tick
        // and scheduling/teardown; no timer-resolution request is required.
        thread::sleep(Duration::from_millis(1));
    }
    let changed = store.generation();
    let elapsed = start.elapsed();
    store.0.observer.core.pause.store(false, Ordering::Release);
    assert_eq!(
        changed,
        u64::MAX,
        "an overdue observation kept authorizing the old session"
    );
    assert!(
        elapsed <= (OBSERVATION_MAX_AGE + Duration::from_millis(500)),
        "freshness fence took {elapsed:?}"
    );
    wait_for(|| store.generation() != u64::MAX);
    assert_ne!(
        store.generation(),
        expected,
        "freshness recovery resurrected the cancelled epoch"
    );
}

#[test]
fn observer_parks_without_filesystem_work_when_drive_is_idle() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    assert!(store.0.observer.core.thread.get().is_none());
    let observation = store.observe().unwrap();
    wait_for(|| store.0.observer.core.probes.load(Ordering::Acquire) != 0);
    drop(observation);
    wait_for(|| store.0.observer.core.parked.load(Ordering::Acquire));
    let before = store.0.observer.core.probes.load(Ordering::Acquire);
    thread::sleep(Duration::from_millis(500));
    assert!(store.0.observer.core.parked.load(Ordering::Acquire));
    assert_eq!(
        store.0.observer.core.probes.load(Ordering::Acquire),
        before,
        "idle observer kept probing the session file"
    );
}

#[test]
fn refresh_token_replacement_fences_all_stores_for_the_same_file() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("first-refresh")).unwrap();
    let other = TokenStore::new(&directory.0).unwrap();
    let before = store.generation();
    other
        .adopt(0, fixture_tokens("replacement-refresh"))
        .unwrap();
    assert_ne!(
        store.generation(),
        before,
        "refresh-token replacement did not retire the old session"
    );
    assert_eq!(store.generation(), other.generation());
    assert!(store.adopt(0, fixture_tokens("late-refresh")).is_err());
}

#[test]
fn upload_401_refresh_with_same_refresh_token_keeps_operation_alive() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("same-refresh")).unwrap();
    let generation = store.generation();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let base = format!("http://{}", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        listener.set_nonblocking(true).unwrap();
        for step in 0..3 {
            let until = Instant::now() + Duration::from_secs(3);
            let socket = loop {
                match listener.accept() {
                    Ok((socket, _)) => break socket,
                    Err(error)
                        if error.kind() == std::io::ErrorKind::WouldBlock
                            && Instant::now() < until =>
                    {
                        thread::sleep(Duration::from_millis(1))
                    }
                    Err(_) => return,
                }
            };
            // Darwin's accepted socket inherits the listener's O_NONBLOCK.
            socket.set_nonblocking(false).unwrap();
            socket
                .set_read_timeout(Some(Duration::from_secs(3)))
                .unwrap();
            if step == 1 {
                let (_, body) = read_request(&socket);
                assert!(body.contains("grant_type=refresh_token"));
                response(
                    &mut { socket },
                    200,
                    r#"{"access_token":"renewed-access","expires_in":3600}"#,
                );
                continue;
            }
            let mut reader = BufReader::new(socket);
            let mut size = 0;
            let mut expect = false;
            loop {
                let mut line = String::new();
                reader.read_line(&mut line).unwrap();
                assert!(!line.is_empty());
                if let Some(value) = line.to_ascii_lowercase().strip_prefix("content-length:") {
                    size = value.trim().parse::<usize>().unwrap();
                }
                expect |= line.trim().eq_ignore_ascii_case("Expect: 100-continue");
                if line == "\r\n" {
                    break;
                }
            }
            assert!(expect);
            if step == 0 {
                response(reader.get_mut(), 401, "{}");
            } else {
                reader
                    .get_mut()
                    .write_all(b"HTTP/1.1 100 Continue\r\n\r\n")
                    .unwrap();
                let mut body = vec![0; size];
                reader.read_exact(&mut body).unwrap();
                assert_eq!(body, vec![0x5a; 1024 * 1024]);
                response(reader.get_mut(), 200, "{}");
            }
        }
    });
    let client = AuthClient::new(config(&base), store.clone());
    let url = format!("{base}/upload");
    let body = vec![0x5a; 1024 * 1024];
    let result = client.request(
        Request {
            method: "PUT",
            url: &url,
            headers: &[],
            body: Body::Bytes(&body),
            destination: Destination::Bytes(512),
            upload: true,
            allow_loopback_http: true,
        },
        &|| store.generation() != generation,
    );
    assert_eq!(result.unwrap().status, 200);
    assert_eq!(store.generation(), generation);
    server.join().unwrap();
}

#[test]
fn pending_signout_does_not_authorize_a_new_observation() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let old = store.generation();
    let held = store.lock().unwrap();
    let signing_out = store.clone();
    let worker = thread::spawn(move || signing_out.sign_out());
    let until = Instant::now() + Duration::from_secs(1);
    while store.0.observer.core.signing_out.load(Ordering::Acquire) == 0 && Instant::now() < until {
        thread::sleep(Duration::from_millis(1));
    }
    let during = store.generation();
    drop(held);
    worker.join().unwrap().unwrap();
    assert_eq!(during, u64::MAX, "pending sign-out exposed a valid session");
    assert_ne!(store.generation(), old);
    assert_ne!(store.generation(), u64::MAX);
}

#[test]
fn rejected_refresh_cannot_clear_a_replacement_inside_debounce() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("first-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    store.0.observer.core.pause.store(true, Ordering::Release);
    let expected = store.generation();
    let bytes = serde_json::to_vec(&State {
        generation: 0,
        tokens: Some(fixture_tokens("other-account-refresh")),
    })
    .unwrap();
    fs::write(&store.0.path, &bytes).unwrap();
    assert_eq!(store.generation(), expected);
    let error = store.expired_observed(0, expected);
    assert_eq!(session_expired_generation(&error), None);
    assert_eq!(
        fs::read(&store.0.path).unwrap(),
        bytes,
        "stale refresh rejection erased another account's tokens"
    );
    store.0.observer.core.pause.store(false, Ordering::Release);
}

#[test]
fn plain_session_lock_timeout_does_not_retire_cancellation_epoch() {
    let directory = Directory::new();
    let mut store = TokenStore::new(&directory.0).unwrap();
    Arc::get_mut(&mut store.0).unwrap().lock_timeout = Duration::from_millis(80);
    let generation = store.generation();
    let held = store.lock().unwrap();
    assert!(store.signed_in_checked().is_err());
    drop(held);
    assert_eq!(
        store.generation(),
        generation,
        "a plain busy lease retired the session"
    );
}

#[test]
fn observer_stalled_600ms_keeps_an_unchanged_transfer_alive() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    store.0.observer.core.pause.store(true, Ordering::Release);
    let generation = store.generation();
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/held", listener.local_addr().unwrap());
    let server = thread::spawn(move || {
        let (mut socket, _) = listener.accept().unwrap();
        read_request(&socket);
        thread::sleep(Duration::from_millis(650));
        let _ = write!(
            socket,
            "HTTP/1.1 200 OK\r\nContent-Length: 2\r\nConnection: close\r\n\r\n{{}}"
        );
    });
    let began = Instant::now();
    let result = drive_http::request(
        Request {
            method: "GET",
            url: &url,
            headers: &[],
            body: Body::Empty,
            destination: Destination::Bytes(512),
            upload: false,
            allow_loopback_http: true,
        },
        &|| store.generation() != generation,
    );
    server.join().unwrap();
    store.0.observer.core.pause.store(false, Ordering::Release);
    assert_eq!(
        result
            .expect("unchanged observer stall cancelled the transfer")
            .status,
        200
    );
    assert_eq!(store.generation(), generation);
    eprintln!(
        "C12T_R2 unchanged_stall_transfer_ms={}",
        began.elapsed().as_millis()
    );
}

#[test]
fn stale_outer_generation_capture_cancels_at_first_observe() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    let generation = store.generation();
    let cancelled = || store.generation() != generation;
    let bytes = serde_json::to_vec(&State {
        generation: 1,
        tokens: None,
    })
    .unwrap();
    let file = drive_http::private_file(&store.0.path).unwrap();
    drop(file);
    fs::write(&store.0.path, bytes).unwrap();
    assert!(
        !cancelled(),
        "between-request observation should remain cached"
    );
    let _observation = store.observe().unwrap();
    assert!(
        cancelled(),
        "the first leased observation did not retire stale outer work"
    );
}

#[test]
fn observer_detects_real_signout_after_a_600ms_stall() {
    let directory = Directory::new();
    let store = TokenStore::new(&directory.0).unwrap();
    store.adopt(0, fixture_tokens("fixture-refresh")).unwrap();
    let _observation = store.observe().unwrap();
    let generation = store.generation();
    store.0.observer.core.pause.store(true, Ordering::Release);
    fs::write(
        &store.0.path,
        serde_json::to_vec(&State {
            generation: 0,
            tokens: None,
        })
        .unwrap(),
    )
    .unwrap();
    let core = store.0.observer.core.clone();
    let unpause = thread::spawn(move || {
        thread::sleep(Duration::from_millis(650));
        core.pause.store(false, Ordering::Release);
        core.unpark();
    });
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let url = format!("http://{}/held", listener.local_addr().unwrap());
    let (release, released) = mpsc::channel();
    let server = thread::spawn(move || {
        let (socket, _) = listener.accept().unwrap();
        read_request(&socket);
        let _ = released.recv_timeout(Duration::from_secs(3));
    });
    let started = Instant::now();
    let result = drive_http::request(
        Request {
            method: "GET",
            url: &url,
            headers: &[],
            body: Body::Empty,
            destination: Destination::Bytes(512),
            upload: false,
            allow_loopback_http: true,
        },
        &|| store.generation() != generation,
    );
    let elapsed = started.elapsed();
    let observed = store.generation();
    release.send(()).ok();
    server.join().unwrap();
    unpause.join().unwrap();
    assert!(result.is_err());
    assert_ne!(
        observed,
        u64::MAX,
        "transient observer staleness retired the epoch before reading the real sign-out"
    );
    assert_ne!(observed, generation);
    assert!(
        elapsed <= OBSERVATION_MAX_AGE + Duration::from_millis(500),
        "stalled change detection took {elapsed:?}"
    );
    eprintln!("C12T_R2 stalled_real_signout_ms={}", elapsed.as_millis());
}

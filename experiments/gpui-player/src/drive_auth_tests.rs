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

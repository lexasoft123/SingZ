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

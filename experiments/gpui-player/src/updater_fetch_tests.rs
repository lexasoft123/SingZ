use super::*;
use std::{
    io::{BufRead, BufReader},
    net::TcpListener,
    sync::atomic::{AtomicUsize, Ordering},
};

/// Local HTTP server: every request gets `head` (status line + headers) and `body`.
fn serve_raw(head: String, body: Vec<u8>) -> u16 {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            let mut reader = BufReader::new(stream.try_clone().unwrap());
            let mut line = String::new();
            while reader.read_line(&mut line).is_ok_and(|n| n > 2) {
                line.clear();
            }
            let mut stream = stream;
            let _ = write!(stream, "{head}Content-Length: {}\r\nConnection: close\r\n\r\n", body.len());
            let _ = stream.write_all(&body);
        }
    });
    port
}
fn serve(body: Vec<u8>) -> String {
    format!("http://127.0.0.1:{}/payload.zip", serve_raw("HTTP/1.1 200 OK\r\n".into(), body))
}
fn sha(bytes: &[u8]) -> String {
    Sha256::digest(bytes).iter().map(|b| format!("{b:02x}")).collect()
}
fn candidate(url: String, bytes: &[u8], declared_len: u64, digest: String) -> Candidate {
    Candidate {
        archive_url: url,
        manifest: Manifest {
            schema: 1,
            version: "2.0.0".into(),
            channel: Channel::Stable,
            target: target().into(),
            archive: updater_manifest::Archive { name: "payload.zip".into(), bytes: declared_len.max(bytes.len() as u64), sha256: digest },
            min_os: None,
            rollback_floor: "1.0.0".into(),
            notes_url: None,
        },
        raw_manifest: vec![],
        signature: vec![],
    }
}
fn dest(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("singz-fetch-{name}-{}", std::process::id()));
    fs::create_dir_all(&dir).unwrap();
    dir.join("payload.zip")
}
fn fetch(c: &Candidate, to: &Path, progress: &mut dyn FnMut(u64, u64) -> bool) -> Result<()> {
    download_with(c, to, progress, true) // loopback HTTP stands in for the CDN in tests
}

#[test]
fn a_matching_download_is_published_and_reports_progress() {
    let body = vec![7u8; 200_000];
    let c = candidate(serve(body.clone()), &body, 0, sha(&body));
    let to = dest("good");
    let calls = AtomicUsize::new(0);
    fetch(&c, &to, &mut |_, total| {
        assert_eq!(total, 200_000);
        calls.fetch_add(1, Ordering::Relaxed);
        true
    })
    .unwrap();
    assert_eq!(fs::read(&to).unwrap(), body);
    assert!(calls.load(Ordering::Relaxed) >= 2);
}
#[test]
fn a_tampered_archive_is_refused_and_leaves_nothing_behind() {
    let body = vec![7u8; 4096];
    let mut served = body.clone();
    served[100] ^= 1; // one flipped byte, same length
    let c = candidate(serve(served), &body, 0, sha(&body));
    let to = dest("tampered");
    let error = fetch(&c, &to, &mut |_, _| true).unwrap_err();
    assert!(error.to_string().contains("SHA-256"), "{error}");
    assert!(!to.exists() && !to.with_extension("download").exists());
}
#[test]
fn an_archive_longer_or_shorter_than_signed_is_refused() {
    let body = vec![1u8; 4096];
    let too_long = candidate(serve(body.clone()), &body, 0, sha(&body));
    let mut shorter = too_long.clone();
    shorter.manifest.archive.bytes = 100;
    assert!(fetch(&shorter, &dest("long"), &mut |_, _| true).unwrap_err().to_string().contains("exceeds"));
    let mut longer = too_long;
    longer.manifest.archive.bytes = 5000;
    assert!(fetch(&longer, &dest("short"), &mut |_, _| true).unwrap_err().to_string().contains("length"));
}
#[test]
fn the_progress_hook_can_hold_the_download_while_the_transport_is_busy() {
    let body = vec![3u8; 150_000];
    let c = candidate(serve(body.clone()), &body, 0, sha(&body));
    let to = dest("defer");
    let busy = AtomicUsize::new(3);
    fetch(&c, &to, &mut |_, _| {
        // Playback is active for the first three chunks: nothing is written yet.
        while busy.load(Ordering::Relaxed) > 0 {
            assert!(!to.with_extension("download").metadata().is_ok_and(|m| m.len() > 0));
            busy.fetch_sub(1, Ordering::Relaxed);
        }
        true
    })
    .unwrap();
    assert_eq!(fs::read(&to).unwrap().len(), body.len());
}
#[test]
fn quitting_cancels_a_download_in_flight_and_removes_the_partial_file() {
    let body = vec![9u8; 400_000];
    let c = candidate(serve(body.clone()), &body, 0, sha(&body));
    let to = dest("cancel");
    let chunks = AtomicUsize::new(0);
    let error = fetch(&c, &to, &mut |_, _| chunks.fetch_add(1, Ordering::Relaxed) < 2).unwrap_err();
    assert!(error.to_string().contains("cancelled"), "{error}");
    assert!(!to.exists() && !to.with_extension("download").exists(), "no partial archive may survive a cancel");
}
#[test]
fn the_transport_policy_is_https_only_with_loopback_http_for_tests_alone() {
    assert!(url_allowed("https://github.com/x", false));
    assert!(!url_allowed("http://github.com/x", false));
    assert!(!url_allowed("http://127.0.0.1:80/x", false), "production never admits loopback HTTP");
    assert!(url_allowed("http://127.0.0.1:8080/x", true));
    assert!(url_allowed("http://localhost:8080/x", true));
    assert!(!url_allowed("http://example.com/x", true), "test mode admits loopback only");
    assert!(!url_allowed("ftp://example.com/x", true));
    assert!(!url_allowed("file:///etc/passwd", true));
}
#[test]
fn an_https_request_is_an_ordinary_error_not_a_panic() {
    // A listener that accepts and hangs up: the TLS handshake fails. With the
    // default (Rustls) provider the connector would panic before connecting.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let port = listener.local_addr().unwrap().port();
    std::thread::spawn(move || {
        for stream in listener.incoming().flatten() {
            drop(stream);
        }
    });
    let result = std::panic::catch_unwind(|| read_url(&format!("https://127.0.0.1:{port}/x"), 1024, false));
    assert!(result.expect("the production TLS provider must not panic").is_err());
}
#[test]
fn a_redirect_to_cleartext_is_refused_before_any_connection_is_made() {
    // The first hop is admitted (loopback test server); it redirects to plain HTTP elsewhere.
    let port = serve_raw("HTTP/1.1 302 Found\r\nLocation: http://downgrade.invalid/payload.zip\r\n".into(), vec![]);
    let error = read_url(&format!("http://127.0.0.1:{port}/start"), 1024, true).unwrap_err();
    assert!(format!("{error:#}").contains("HTTPS"), "{error:#}");
    // And a redirect loop is bounded.
    let looping = serve_raw("HTTP/1.1 302 Found\r\nLocation: /again\r\n".into(), vec![]);
    assert!(read_url(&format!("http://127.0.0.1:{looping}/start"), 1024, true).is_err());
}

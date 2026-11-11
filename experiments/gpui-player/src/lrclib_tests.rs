use super::*;
use serde_json::json;
use std::{
    net::TcpListener,
    sync::{Arc, atomic::AtomicBool},
};
struct Reply {
    status: u16,
    body: String,
    retry: Option<String>,
    delay: Duration,
}
impl Reply {
    fn json(status: u16, body: Value) -> Self {
        Self {
            status,
            body: body.to_string(),
            retry: None,
            delay: Duration::ZERO,
        }
    }
    fn retry(status: u16, seconds: &str) -> Self {
        Self {
            status,
            body: "{}".into(),
            retry: Some(seconds.into()),
            delay: Duration::ZERO,
        }
    }
}
struct Server {
    url: String,
    requests: Arc<Mutex<Vec<String>>>,
    stop: Arc<AtomicBool>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Server {
    fn new(replies: Vec<Reply>) -> Self {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let url = format!("http://{}/api", listener.local_addr().unwrap());
        let requests = Arc::new(Mutex::new(vec![]));
        let out = requests.clone();
        let stop = Arc::new(AtomicBool::new(false));
        let quit = stop.clone();
        let worker = thread::spawn(move || {
            let mut replies = replies.into_iter();
            while !quit.load(Ordering::Acquire) {
                match listener.accept() {
                    Ok((mut stream, _)) => {
                        // macOS inherits O_NONBLOCK from the listener. A read
                        // timeout alone does not make accepted sockets blocking:
                        // curl can connect before it has written its headers.
                        stream.set_nonblocking(false).unwrap();
                        stream
                            .set_read_timeout(Some(Duration::from_millis(20)))
                            .unwrap();
                        stream
                            .set_write_timeout(Some(Duration::from_secs(1)))
                            .unwrap();
                        let mut data = vec![];
                        let mut buffer = [0; 2048];
                        let header_deadline = Instant::now() + Duration::from_secs(5);
                        while !data.windows(4).any(|w| w == b"\r\n\r\n")
                            && data.len() < 32768
                            && !quit.load(Ordering::Acquire)
                            && Instant::now() < header_deadline
                        {
                            let limit = buffer.len().min(32768 - data.len());
                            match stream.read(&mut buffer[..limit]) {
                                Ok(0) => break,
                                Ok(n) => data.extend_from_slice(&buffer[..n]),
                                Err(error)
                                    if matches!(
                                        error.kind(),
                                        std::io::ErrorKind::WouldBlock
                                            | std::io::ErrorKind::TimedOut
                                            | std::io::ErrorKind::Interrupted
                                    ) =>
                                {
                                    continue;
                                }
                                Err(_) => break,
                            }
                        }
                        // Cancelled/partial requests do not spend a fixture
                        // response or shift subsequent expected request paths.
                        if !data.windows(4).any(|w| w == b"\r\n\r\n") {
                            continue;
                        }
                        out.lock()
                            .unwrap()
                            .push(String::from_utf8_lossy(&data).into_owned());
                        let response = replies
                            .next()
                            .unwrap_or_else(|| Reply::json(404, json!({})));
                        let deadline = Instant::now() + response.delay;
                        while Instant::now() < deadline && !quit.load(Ordering::Acquire) {
                            thread::sleep(Duration::from_millis(5));
                        }
                        if quit.load(Ordering::Acquire) {
                            break;
                        }
                        let retry = response
                            .retry
                            .map(|v| format!("Retry-After: {v}\r\n"))
                            .unwrap_or_default();
                        let wire = format!(
                            "HTTP/1.1 {} Response\r\nContent-Type: application/json\r\nContent-Length: {}\r\n{retry}Connection: close\r\n\r\n{}",
                            response.status,
                            response.body.len(),
                            response.body
                        );
                        let _ = stream.write_all(wire.as_bytes());
                    }
                    Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                        thread::sleep(Duration::from_millis(2))
                    }
                    Err(error) => panic!("{error}"),
                }
            }
        });
        Self {
            url,
            requests,
            stop,
            worker: Some(worker),
        }
    }
    fn client(&self) -> Client {
        Client::with_base_url(&self.url).unwrap()
    }
    fn paths(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|request| {
                request
                    .lines()
                    .next()
                    .unwrap()
                    .split_whitespace()
                    .nth(1)
                    .unwrap()
                    .into()
            })
            .collect()
    }
}
impl Drop for Server {
    fn drop(&mut self) {
        self.stop.store(true, Ordering::Release);
        if let Some(worker) = self.worker.take() {
            worker.join().unwrap();
        }
    }
}
fn record(id: u64, artist: &str, duration: f64) -> Value {
    json!({"id":id,"trackName":"Song","artistName":artist,"duration":duration,"syncedLyrics":"[00:01.25] Sing these words"})
}
fn meta(artist: Option<&str>) -> TrackMeta {
    TrackMeta {
        artist: artist.map(str::to_owned),
        title: "Song".into(),
        album: None,
        duration_sec: 100.,
        alt_title: None,
    }
}

#[test]
fn http_fixture_waits_for_delayed_headers_on_a_nonblocking_listener() {
    let server = Server::new(vec![Reply::json(200, json!({"slot":"delayed"}))]);
    let address = server
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    // Exceeds the old 100ms timeout as well as exposing Darwin's immediate
    // inherited-WouldBlock case, without relying on scheduler contention.
    thread::sleep(Duration::from_millis(150));
    socket
        .write_all(
            b"GET /api/search?delayed HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
    let mut response = String::new();
    socket.take(4096).read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 "));
    assert!(response.contains("\"slot\":\"delayed\""));
    assert_eq!(server.paths(), vec!["/api/search?delayed"]);
}
#[test]
fn http_fixture_does_not_consume_a_response_for_a_cancelled_partial_request() {
    let server = Server::new(vec![Reply::json(200, json!({"slot":"first"}))]);
    let address = server
        .url
        .strip_prefix("http://")
        .unwrap()
        .split('/')
        .next()
        .unwrap();
    let mut partial = std::net::TcpStream::connect(address).unwrap();
    partial
        .write_all(b"GET /api/get?cancelled HTTP/1.1\r\n")
        .unwrap();
    drop(partial);
    let mut socket = std::net::TcpStream::connect(address).unwrap();
    socket
        .set_read_timeout(Some(Duration::from_secs(2)))
        .unwrap();
    socket
        .write_all(
            b"GET /api/search?complete HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n",
        )
        .unwrap();
    let mut response = String::new();
    socket.take(4096).read_to_string(&mut response).unwrap();
    assert!(response.starts_with("HTTP/1.1 200 "));
    assert!(response.contains("\"slot\":\"first\""));
    assert_eq!(server.paths(), vec!["/api/search?complete"]);
}

#[test]
fn shared_lrc_fixture_has_exact_source_text_and_f64_timing() {
    let fixture: Value =
        serde_json::from_str(include_str!("../../../tests/shared/lrc-fixture.json")).unwrap();
    assert_eq!(
        parse_lrc(
            fixture["lrc"].as_str().unwrap(),
            fixture["duration"].as_f64().unwrap()
        )
        .unwrap(),
        serde_json::from_value::<Vec<Line>>(fixture["lines"].clone()).unwrap()
    );
}
#[test]
fn lrc_keeps_gap_bounds_repeated_stamps_utf16_weights_and_javascript_whitespace() {
    let lines = parse_lrc(
        "[00:01:250][00:05.0]😀 a\n[00:02]\n[00:08]\u{feff}One\u{0085}two\u{feff}界\u{feff}",
        20.,
    )
    .unwrap();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0].start, 1.25);
    assert_eq!(lines[0].end, 2.05);
    assert_eq!(lines[0].words[0].w, "😀");
    assert_eq!(lines[0].words[0].e, 1.73);
    assert_eq!(lines[1].start, 5.);
    assert_eq!(
        lines[2]
            .words
            .iter()
            .map(|word| word.w.as_str())
            .collect::<Vec<_>>(),
        vec!["One\u{0085}two", "界"]
    );
    assert_eq!(fixed3(1.2345), 1.234);
    assert_eq!(fixed3(1.125), 1.125);
}
#[test]
fn tag_repair_and_metadata_fallback_match_russian_rips_without_corrupting_latin_names() {
    assert_eq!(fix_tag_encoding("Àðèÿ"), "Ария");
    assert_eq!(fix_tag_encoding("Ìåëüíèöà"), "Мельница");
    for name in ["Motörhead", "Für Elise", "Ария", "Sixteen Tons"] {
        assert_eq!(fix_tag_encoding(name), name);
    }
    assert!(real_artist(Some("Unknown Artist")).is_none());
    assert!(real_artist(Some("Артист")).is_none());
    let (tag, file) = metadata(
        "Merle Travis - Sixteen Tons.flac",
        Some(" Unknown "),
        Some("08. Sixteen Tons [Am +2st]"),
        Some(" Àðèÿ "),
        156.,
    );
    assert_eq!(tag.artist.as_deref(), Some("Merle Travis"));
    assert_eq!(tag.title, "Sixteen Tons");
    assert_eq!(tag.alt_title.as_deref(), Some("08. Sixteen Tons"));
    assert_eq!(tag.album.as_deref(), Some("Ария"));
    assert_eq!(file.title, "Sixteen Tons");
    let numeric = meta_from_filename("212-85-06.mp3", 100.);
    assert_eq!(numeric.title, "85-06");
    assert_eq!(numeric.alt_title.as_deref(), Some("212-85-06"));
}
#[test]
fn artist_reductions_are_bounded_ordered_and_do_not_rewrite_real_names_up_front() {
    for (input, expected) in [
        ("Женя Трофимов feat. Nansi & Sidorov", "Женя Трофимов"),
        ("Дискотека Авария и Жанна Фриске", "Дискотека Авария"),
        ("Bob Dylan with The Band", "Bob Dylan"),
        ("AC/DC", "AC"),
    ] {
        assert_eq!(primary_artist(Some(input)).as_deref(), Some(expected));
    }
    for name in ["Maxx", "Aerosmith", "M x Y", "A vſ B"] {
        assert!(primary_artist(Some(name)).is_none());
    }
    for (input, expected) in [
        (
            "AudioCleaner_Download_Notre Dame de Paris",
            "Notre Dame de Paris",
        ),
        ("get-mp3-Ария", "Ария"),
        ("Muzoi.net - Артист", "Артист"),
        ("[muzmo.ru] Ария", "Ария"),
        ("(sefon.pro) Ария", "Ария"),
        ("www.muzmo.ru | Кино", "Кино"),
    ] {
        assert_eq!(strip_site_prefix(Some(input)).as_deref(), Some(expected));
        assert!(strip_site_prefix(Some(expected)).is_none());
    }
    for name in ["will.i.am", "Fifty Foot Mp3", "muzmo.ru", "muzmo.ru - 128"] {
        assert!(strip_site_prefix(Some(name)).is_none());
    }
}
#[test]
fn exact_lookup_preserves_query_order_album_rounding_and_versioned_native_headers() {
    let server = Server::new(vec![Reply::json(200, record(7, "Singer", 100.))]);
    let client = server.client();
    let mut input = meta(Some("A & B"));
    input.title = "Café + Song".into();
    input.album = Some("Album / One".into());
    input.duration_sec = 100.5;
    let Lookup::Hit { lines, credit } = client.lookup(&input, &|| false).unwrap() else {
        panic!("expected hit")
    };
    assert_eq!(credit, "Singer — Song");
    assert_eq!(lines[0].start, 1.25);
    assert_eq!(
        server.paths(),
        vec![
            "/api/get?artist_name=A+%26+B&track_name=Caf%C3%A9+%2B+Song&duration=101&album_name=Album+%2F+One"
        ]
    );
    let request = server.requests.lock().unwrap()[0].to_ascii_lowercase();
    let package: Value = serde_json::from_str(include_str!("../../../package.json")).unwrap();
    let version = package["version"].as_str().unwrap().to_ascii_lowercase();
    assert!(request.contains(&format!("lrclib-client: singz/{version}")));
    assert!(request.contains(&format!("user-agent: singz/{version}")));
    assert!(request.contains("accept: application/json"));
}
#[test]
fn search_fallback_uses_duration_tolerance_and_synced_candidates_only() {
    let server = Server::new(vec![
        Reply::json(404, json!({})),
        Reply::json(
            200,
            json!([record(1,"Wrong length",106.),record(2,"Near",104.9),{"id":3,"duration":100,"instrumental":true,"syncedLyrics":"[00:01] Instrumental"}]),
        ),
    ]);
    assert!(
        matches!(server.client().lookup(&meta(Some("Full artist")),&||false).unwrap(),Lookup::Hit{credit,..} if credit=="Near — Song")
    );
    assert_eq!(server.paths().len(), 2);
    let server = Server::new(vec![Reply::json(
        200,
        json!([record(1, "Outside", 105.01)]),
    )]);
    assert!(matches!(
        server.client().lookup(&meta(None), &|| false).unwrap(),
        Lookup::Miss
    ));
}
#[test]
fn collaboration_and_site_ladder_retries_full_credit_before_reduced_artist() {
    let server = Server::new(vec![
        Reply::json(404, json!({})),
        Reply::json(200, json!([])),
        Reply::json(200, record(8, "Notre Dame de Paris", 100.)),
    ]);
    let client = server.client();
    assert!(matches!(
        client
            .lookup(
                &meta(Some(
                    "AudioCleaner_Download_Notre Dame de Paris feat. Guest"
                )),
                &|| false
            )
            .unwrap(),
        Lookup::Hit { .. }
    ));
    let paths = server.paths();
    assert!(paths[0].contains("AudioCleaner_Download_Notre+Dame+de+Paris+feat.+Guest"));
    assert!(paths[1].starts_with("/api/search?"));
    assert!(paths[2].contains("artist_name=AudioCleaner_Download_Notre+Dame+de+Paris&"));
}
#[test]
fn alternate_title_restarts_artist_ladder_and_can_recover_a_cleaned_numeric_title() {
    let server = Server::new(vec![
        Reply::json(404, json!({})),
        Reply::json(200, json!([])),
        Reply::json(200, record(7, "Singer", 100.)),
    ]);
    let client = server.client();
    let mut input = meta(Some("Singer"));
    input.title = "85-06".into();
    input.alt_title = Some("212-85-06".into());
    assert!(matches!(
        client.lookup(&input, &|| false).unwrap(),
        Lookup::Hit { .. }
    ));
    assert!(server.paths()[2].contains("track_name=212-85-06"));
}
#[test]
fn endpoint_failure_does_not_poison_search_but_unknown_verdict_remains_down() {
    let server = Server::new(vec![
        Reply::json(500, json!({})),
        Reply::json(200, json!([])),
    ]);
    let client = server.client();
    assert!(matches!(
        client.lookup(&meta(Some("Singer")), &|| false).unwrap(),
        Lookup::Down
    ));
    assert_eq!(server.paths().len(), 2);
    let server = Server::new(vec![
        Reply::json(500, json!({})),
        Reply::json(200, json!([record(4, "Healthy search", 100.)])),
    ]);
    assert!(matches!(
        server
            .client()
            .lookup(&meta(Some("Singer")), &|| false)
            .unwrap(),
        Lookup::Hit { .. }
    ));
}
#[test]
fn manual_candidates_sort_synced_then_duration_and_cap_fifteen_with_stable_ties() {
    let mut records =
        vec![json!({"id":99,"trackName":"Plain","duration":100,"plainLyrics":"Words"})];
    for id in 1..=20 {
        records.push(record(id, "Singer", 100. + id as f64 / 10.));
    }
    let server = Server::new(vec![Reply::json(200, Value::Array(records))]);
    let query = SearchQuery {
        free: Some("Singer Song".into()),
        artist: Some("ignored".into()),
        title: None,
    };
    let candidates = server.client().search(&query, 100., &|| false).unwrap();
    assert_eq!(candidates.len(), 15);
    assert_eq!(candidates[0].id, 1);
    assert!(candidates.iter().all(|c| c.synced));
    assert_eq!(server.paths(), vec!["/api/search?q=Singer+Song"]);
}
#[test]
fn by_id_accepts_synced_lrc_even_when_instrumental_flag_is_set_and_does_not_search() {
    let mut response = record(12, "Singer", 100.);
    response["instrumental"] = json!(true);
    let server = Server::new(vec![Reply::json(200, response)]);
    let hit = server.client().by_id(12, 100., &|| false).unwrap().unwrap();
    assert_eq!(hit.credit, "Singer — Song");
    assert_eq!(server.paths(), vec!["/api/get/12"]);
}
#[test]
fn manual_retry_clears_endpoint_cooldown_but_never_server_retry_after() {
    let server = Server::new(vec![
        Reply::json(500, json!({})),
        Reply::json(200, json!([])),
    ]);
    let client = server.client();
    let query = SearchQuery {
        free: Some("Song".into()),
        ..Default::default()
    };
    assert!(client.search(&query, 100., &|| false).unwrap().is_empty());
    assert!(client.search(&query, 100., &|| false).unwrap().is_empty());
    assert_eq!(server.paths().len(), 1);
    client.retry_now().unwrap();
    client.search(&query, 100., &|| false).unwrap();
    assert_eq!(server.paths().len(), 2);
    let server = Server::new(vec![Reply::retry(429, "60")]);
    let client = server.client();
    client.search(&query, 100., &|| false).unwrap();
    client.retry_now().unwrap();
    client.by_id(1, 100., &|| false).unwrap();
    assert_eq!(server.paths().len(), 1);
}
#[test]
fn short_explicit_503_retries_at_most_three_times_and_long_wait_never_blocks() {
    let server = Server::new(vec![
        Reply::retry(503, "0"),
        Reply::retry(503, "0"),
        Reply::json(200, record(1, "Recovered", 100.)),
    ]);
    assert!(matches!(
        server
            .client()
            .lookup(&meta(Some("Singer")), &|| false)
            .unwrap(),
        Lookup::Hit { .. }
    ));
    assert_eq!(server.paths().len(), 3);
    let server = Server::new(vec![Reply::retry(503, "30")]);
    let start = Instant::now();
    assert!(matches!(
        server
            .client()
            .lookup(&meta(Some("Singer")), &|| false)
            .unwrap(),
        Lookup::Down
    ));
    assert!(start.elapsed() < Duration::from_secs(2));
    assert_eq!(server.paths().len(), 1);
}
#[test]
fn invalid_json_is_down_and_cooldown_get_ids_share_a_family() {
    let server = Server::new(vec![Reply {
        status: 200,
        body: "<html>Shield</html>".into(),
        retry: None,
        delay: Duration::ZERO,
    }]);
    let client = server.client();
    assert!(matches!(
        client.lookup(&meta(None), &|| false).unwrap(),
        Lookup::Down
    ));
    assert!(matches!(
        client.lookup(&meta(None), &|| false).unwrap(),
        Lookup::Down
    ));
    assert_eq!(server.paths().len(), 1);
    let server = Server::new(vec![Reply::json(500, json!({}))]);
    let client = server.client();
    assert!(client.by_id(1, 100., &|| false).unwrap().is_none());
    assert!(client.by_id(2, 100., &|| false).unwrap().is_none());
    assert_eq!(server.paths().len(), 1);
}
#[test]
fn cancellation_reaps_pending_curl_and_does_not_cache_a_final_miss() {
    let server = Server::new(vec![
        Reply {
            status: 200,
            body: "[]".into(),
            retry: None,
            delay: Duration::from_secs(2),
        },
        Reply::json(200, json!([])),
    ]);
    let client = server.client();
    let start = Instant::now();
    let result = client.lookup(&meta(None), &|| {
        start.elapsed() > Duration::from_millis(100)
    });
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_secs(1));
    assert!(client.state.lock().unwrap().failures.is_empty());
}
#[test]
fn retry_after_and_test_override_refuse_malformed_or_remote_inputs() {
    let now = SystemTime::UNIX_EPOCH + Duration::from_secs(0);
    assert_eq!(retry_after("1.5", now), Some(Duration::from_millis(1500)));
    assert_eq!(
        retry_after("Thu, 01 Jan 1970 00:00:02 GMT", now),
        Some(Duration::from_secs(2))
    );
    for bad in ["", "-1", "+2", "1e3", "NaN", "later"] {
        assert!(retry_after(bad, now).is_none());
    }
    for bad in [
        "http://example.com/api",
        "https://127.0.0.1/api",
        "http://127.0.0.1@evil/api",
    ] {
        assert!(Client::with_base_url(bad).is_err());
    }
}
#[test]
fn lrc_expansion_and_large_words_refuse_without_allocating_repeated_megabytes() {
    let input = format!("{}{}", "[00:01]".repeat(20000), "word ".repeat(2000));
    assert!(parse_lrc(&input, 100.).is_err());
    assert!(parse_lrc(&format!("[00:01]{}", "a".repeat(1025)), 100.).is_err());
}

#[test]
fn timeout_holds_host_and_manual_retry_obeys_floor() {
    let client = Client::default();
    let start = Instant::now();
    let time = std::cell::Cell::new(start);
    let calls = std::cell::Cell::new(0);
    let fetch = |_: &str| {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            Err(RequestTimeout.into())
        } else {
            Ok(Response {
                status: 200,
                headers: HashMap::new(),
                body: b"[]".to_vec(),
            })
        }
    };
    let request = |path| {
        client
            .request_with(path, &|| false, &|| time.get(), &fetch)
            .unwrap()
    };
    assert!(matches!(request("/get?a"), Answer::Down));
    client.state.lock().unwrap().last_finished = None;
    assert!(matches!(request("/search?a"), Answer::Down));
    assert!(matches!(request("/get/42"), Answer::Down));
    assert_eq!(calls.get(), 1);
    time.set(start + Duration::from_millis(14_999));
    client.retry_with(&|| time.get()).unwrap();
    assert!(matches!(request("/search?a"), Answer::Down));
    assert_eq!(calls.get(), 1);
    time.set(start + Duration::from_secs(15));
    client.retry_with(&|| time.get()).unwrap();
    assert!(matches!(request("/search?a"), Answer::Json(_)));
    assert_eq!(calls.get(), 2);
    assert!(client.state.lock().unwrap().host_since.is_none());
}

#[test]
fn timeout_expires_after_sixty_seconds() {
    let client = Client::default();
    let start = Instant::now();
    let time = std::cell::Cell::new(start);
    let calls = std::cell::Cell::new(0);
    let fetch = |_: &str| {
        calls.set(calls.get() + 1);
        if calls.get() == 1 {
            Err(RequestTimeout.into())
        } else {
            Ok(Response {
                status: 200,
                headers: HashMap::new(),
                body: b"[]".to_vec(),
            })
        }
    };
    let request = |path| {
        client
            .request_with(path, &|| false, &|| time.get(), &fetch)
            .unwrap()
    };
    assert!(matches!(request("/get?a"), Answer::Down));
    time.set(start + Duration::from_millis(59_999));
    assert!(matches!(request("/search?a"), Answer::Down));
    time.set(start + Duration::from_secs(60));
    assert!(matches!(request("/search?a"), Answer::Json(_)));
    assert_eq!(calls.get(), 2);
    assert!(client.state.lock().unwrap().host_since.is_none());
}

#[test]
fn manual_retry_retains_a_young_timeout_and_clears_it_at_the_floor() {
    let client = Client::default();
    let start = Instant::now();
    client.state.lock().unwrap().host_since = Some(start);
    client
        .retry_with(&|| start + Duration::from_millis(14_999))
        .unwrap();
    assert!(client.state.lock().unwrap().host_since.is_some());
    client
        .retry_with(&|| start + Duration::from_secs(15))
        .unwrap();
    assert!(client.state.lock().unwrap().host_since.is_none());
}

#[test]
fn retry_during_an_in_flight_fetch_returns_at_once_and_applies_on_the_next_request() {
    let client = Client::default();
    let start = Instant::now();
    client.state.lock().unwrap().host_since = Some(start);
    std::thread::scope(|scope| {
        // A fetch holds the state lock for its whole timeout.
        let held = client.state.lock().unwrap();
        let (done, finished) = std::sync::mpsc::channel();
        let client = &client;
        scope.spawn(move || {
            client
                .retry_with(&|| start + Duration::from_secs(15))
                .unwrap();
            let _ = done.send(());
        });
        // Release the lock either way, so a blocking retry fails here
        // instead of deadlocking the test.
        let returned = finished.recv_timeout(Duration::from_millis(250)).is_ok();
        drop(held);
        assert!(returned, "Retry waited for the in-flight fetch");
    });
    assert!(client.state.lock().unwrap().host_since.is_some());
    // The next request applies the recorded retry before checking the hold.
    let answer = client
        .request_with(
            "/search?a",
            &|| false,
            &|| start + Duration::from_secs(16),
            &|_: &str| {
                Ok(Response {
                    status: 200,
                    headers: HashMap::new(),
                    body: b"[]".to_vec(),
                })
            },
        )
        .unwrap();
    assert!(matches!(answer, Answer::Json(_)));
    assert!(client.state.lock().unwrap().host_since.is_none());
}

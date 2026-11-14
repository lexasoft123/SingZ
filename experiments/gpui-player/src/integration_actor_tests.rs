//! Exercise the real facade, actor, Connection reader and typed receipts. The
//! fixture replaces only the external audio endpoint, not queueing or delivery.
use super::*;

fn fixture_connection(backend: &Backend, log: Option<&Path>) -> Connection {
    fixture_connection_mode(backend, log, "")
}
fn fixture_connection_mode(backend: &Backend, log: Option<&Path>, mode: &str) -> Connection {
    #[cfg(feature = "ui-tests")]
    if std::env::var_os("SINGZ_C17_NATIVE_LATENCY").is_some() && log.is_none() {
        let root = crate::audio_devices::directory().join("native-latency");
        fs::create_dir_all(root.join("stems")).unwrap();
        // A 120-second deterministic tone; all native output remains muted by
        // SINGZ_MUTE. This run measures receipts, not audible qualification.
        let rate = 16000u32;
        let frames = rate * 120;
        let bytes = frames * 2;
        let mut wave = Vec::with_capacity(bytes as usize + 44);
        wave.extend_from_slice(b"RIFF");
        wave.extend_from_slice(&(bytes + 36).to_le_bytes());
        wave.extend_from_slice(b"WAVEfmt ");
        wave.extend_from_slice(&16u32.to_le_bytes());
        wave.extend_from_slice(&1u16.to_le_bytes());
        wave.extend_from_slice(&1u16.to_le_bytes());
        wave.extend_from_slice(&rate.to_le_bytes());
        wave.extend_from_slice(&(rate * 2).to_le_bytes());
        wave.extend_from_slice(&2u16.to_le_bytes());
        wave.extend_from_slice(&16u16.to_le_bytes());
        wave.extend_from_slice(b"data");
        wave.extend_from_slice(&bytes.to_le_bytes());
        for frame in 0..frames {
            let sample = ((frame as f64 * 220. * std::f64::consts::TAU / rate as f64).sin() * 1000.)
                .round() as i16;
            wave.extend_from_slice(&sample.to_le_bytes());
        }
        fs::write(root.join("stems/vocals.wav"), wave).unwrap();
        fs::write(
            root.join("project.json"),
            br#"{"version":2,"name":"Native latency","settings":{}}"#,
        )
        .unwrap();
        let project = read_project(&root).unwrap();
        return Connection::open(
            Some(&project),
            1,
            backend.epoch.clone(),
            backend.alive.clone(),
            backend.copy_handoff.clone(),
            "",
            crate::audio_devices::Provider::platform_default(),
            backend.provider_retired.clone(),
            None,
        )
        .unwrap()
        .0;
    }
    let script = r#"import sys,json,time
v={"protocol":1,"provider":"coreaudio","backendProvider":"fake","fixture":True,"ok":True,"state":3,"duration":600,"position":2,"playing":False,"graphGeneration":1,"laneSetRevision":1,"carryRevision":1,"transportGeneration":1,"transportCommandsQueued":0,"transportCommandsApplied":0,"cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":False,"cueOutputLatencyMs":0,"cueNotes":[]}
v['provider']=sys.argv[1]
mode=sys.argv[3] if len(sys.argv)>3 else ''
for line in sys.stdin:
 c=line.strip()
 if len(sys.argv)>2 and sys.argv[2]!='-':
  with open(sys.argv[2],"a") as log:print(c,file=log,flush=True)
 if c=='quit':sys.exit(0)
 if mode=='stall-status' and c=='status':time.sleep(.1)
 if not mode or mode=='stall-status':
  if c in ('play','pause'):
   v['playing']=c=='play';v['transportCommandsQueued']+=1;v['transportCommandsApplied']=v['transportCommandsQueued']
  if c.startswith('seek '):v['position']=float(c.split()[1]);v['seekCount']=v.get('seekCount',0)+1
 reply=v.copy()
 if mode and mode!='stall-status' and (c.startswith(('seek ','cue ','cue-timed ')) or c in ('play','met-apply') or (mode=='met-first' and c.startswith('met-begin '))):
  reply['ok']=False;reply['error']='scripted command refusal'
  if c=='met-apply':reply['error']='Metronome count-in exceeds the cue event limit'
  if c.startswith(('cue ','cue-timed ')):reply['error']='Native training cue capacity exceeded'
  if mode=='malformed':print('{',flush=True);continue
  if mode in ('6','7'):reply['state']=int(mode)
  if mode=='ownership':v['graphGeneration']+=1
  if mode=='loop-drift':reply.update(looping=True,loopStart=1,loopEnd=4)
  if mode=='region-drift':v.update(regionEnabled=True,regionStart=1,regionEnd=4)
 print(json.dumps(reply),flush=True)
"#;
    let mut command = Command::new("python3");
    command
        .args(["-u", "-c", script])
        .arg(crate::audio_devices::Provider::platform_default().as_str());
    command.arg(log.unwrap_or_else(||Path::new("-"))).arg(mode);
    let child = command
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let (helper, output) = Helper::adopt(child, backend.provider_retired.clone()).unwrap();
    let (tx, replies) = mpsc::channel();
    thread::spawn(move || {
        for line in BufReader::new(output).lines() {
            let result = line
                .map_err(anyhow::Error::from)
                .and_then(|line| serde_json::from_str(&line).map_err(Into::into));
            if tx.send(result).is_err() {
                break;
            }
        }
    });
    Connection {
        provider: crate::audio_devices::Provider::platform_default(),
        pending_inventory: None,
        carry_revision: 0,
        lane_revision: 0,
        loaded_lanes: vec![],
        loaded_stamps: vec![],
        project_dir: None,
        helper,
        ownership: serde_json::json!({"graphGeneration":1,"laneSetRevision":1,"carryRevision":1}),
        replies,
        epoch: 1,
        latest: backend.epoch.clone(),
        alive: backend.alive.clone(),
        copy_handoff: backend.copy_handoff.clone(),
    }
}

#[test]
fn held_job_transport_round_trip_bound() {
    measure_transport_load(false);
}
#[test]
fn catalog_load_transport_round_trip_bound() {
    measure_transport_load(true);
}
fn measure_transport_load(catalog: bool) {
    let name = if catalog {
        "catalog_load_transport_round_trip_bound"
    } else {
        "held_job_transport_round_trip_bound"
    };
    let Some(root) = isolated(name) else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(417), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    let (ack, ready) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(
            fixture_connection(&backend, None),
            ack,
        ))
        .unwrap();
    ready.recv_timeout(Duration::from_secs(10)).unwrap();
    if catalog {
        let library = library_root();
        for index in 0..512 {
            let dir = library.join(format!("catalog-{index:04}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("project.json"),
                format!(r#"{{"version":2,"name":"Catalog {index}","settings":{{"nativeEmptyTracks":true,"custom":[]}}}}"#),
            )
            .unwrap();
        }
    }
    let mut catalog_receipts = 0;
    let mut metrics = vec![];
    let mut serial = 0;
    // Both phases begin with the same settled endpoint. Native output startup
    // and graph warm-up are helper-side work, outside the C-17 queueing bound.
    for _ in 0..5 {
        for command in ["play", "pause", "seek 17"] {
            serial += 1;
            if command == "seek 17" {
                backend.control(1, command.into()).unwrap();
            } else {
                backend.playback(1, serial, command.into()).unwrap();
            }
            let (tx, rx) = mpsc::sync_channel(1);
            backend
                .requests
                .send(Request::ReceiptFence(1, serial, tx))
                .unwrap();
            rx.recv_timeout(Duration::from_secs(3)).unwrap();
            backend.drain();
        }
    }
    for held in [false, true] {
        let mut samples: [Vec<f64>; 3] = Default::default();
        let mut held_throughout = true;
        // Four batches retain 200 samples per command while keeping every
        // native command inside a live two-second job gate. No timeout grows.
        for _batch in 0..4 {
            let (release, gate) = mpsc::channel();
            if held && !catalog {
                let (entered, ready) = mpsc::sync_channel(1);
                backend
                    .requests
                    .send(Request::HoldJob(entered, gate))
                    .unwrap();
                ready.recv_timeout(Duration::from_secs(5)).unwrap();
            }
            // 200 alternating play/pause/seek cycles, including an exact queue fence
            // for Control's telemetry-only receipt (there is no public seek event).
            for cycle in 0..50 {
                if held && catalog && cycle % 5 == 0 {
                    backend.catalog();
                }
                for (index, command) in ["play", "pause", "seek 17"].into_iter().enumerate() {
                    serial += 1;
                    let started = Instant::now();
                    if index < 2 {
                        backend.playback(1, serial, command.into()).unwrap();
                    } else {
                        backend.control(1, command.into()).unwrap();
                    }
                    let (tx, rx) = mpsc::sync_channel(1);
                    backend
                        .requests
                        .send(Request::ReceiptFence(1, serial, tx))
                        .unwrap();
                    let receipt = rx.recv_timeout(Duration::from_secs(3)).unwrap();
                    let elapsed = started.elapsed().as_secs_f64() * 1000.;
                    assert_eq!((receipt.0, receipt.1), (1, serial));
                    if index < 2 {
                        assert_eq!(receipt.2.playing, index == 0);
                        let mut found = false;
                        for event in backend.drain() {
                            if let Event::Catalog(_, _, projects) = &event {
                                assert_eq!(
                                    projects.len(),
                                    512,
                                    "real Catalog load did not enumerate its fixture"
                                );
                                catalog_receipts += 1;
                            }
                            if let Event::Playback(epoch, id, status) = event {
                                assert_eq!((epoch, id), (1, serial));
                                assert_eq!(status.playing, index == 0);
                                found = true;
                            }
                        }
                        assert!(found, "typed playback receipt missing");
                    } else if std::env::var_os("SINGZ_C17_NATIVE_LATENCY").is_none() {
                        assert_eq!(receipt.2.position, 17.);
                    }
                    samples[index].push(elapsed);
                }
            }
            held_throughout &= !held || catalog || release.send(()).is_ok();
        }
        let stats = samples.map(|mut values| {
            values.sort_by(f64::total_cmp);
            [values[99], values[197], values[199]]
        });
        for (command, [p50, p99, max]) in ["play", "pause", "seek"].into_iter().zip(stats) {
            println!(
                "C17 load={} held={held} command={command} n=200 p50_ms={p50:.3} p99_ms={p99:.3} max_ms={max:.3}",
                if catalog { "catalog" } else { "job" }
            );
        }
        metrics.push((stats, held_throughout));
    }
    for (stats, _) in &metrics {
        for [_, p99, max] in stats {
            assert!(*p99 <= 30., "p99 {p99} > 30ms");
            assert!(*max <= 100., "max {max} > 100ms");
        }
    }
    // The bound is that a held job never makes a command more than 5 ms slower
    // at p99. A held phase that happens to be faster (the unheld phase caught
    // unrelated machine load) is not a regression, so this is one-sided.
    for index in 0..3 {
        let (unheld, held) = (metrics[0].0[index][1], metrics[1].0[index][1]);
        assert!(
            held - unheld <= 5.,
            "held job slowed p99 by more than 5ms ({unheld} -> {held})"
        );
    }
    assert!(
        metrics.iter().all(|(_, held)| *held),
        "job gate expired before the command run ended"
    );
    if catalog {
        // The deterministic pipe can finish its samples before the final scan
        // publishes; still require the actual 512-project scan to finish.
        let deadline = Instant::now() + Duration::from_secs(2);
        while catalog_receipts == 0 {
            for event in backend.drain() {
                if let Event::Catalog(_, _, projects) = event {
                    assert_eq!(projects.len(), 512);
                    catalog_receipts += 1;
                }
            }
            assert!(
                Instant::now() < deadline,
                "real Catalog load did not finish"
            );
            thread::sleep(Duration::from_millis(2));
        }
        println!("C17 actual_catalog_receipts={catalog_receipts} projects=512");
    }
    // Accepted visible preferences must survive shutdown even with a held job
    // ahead of them. Audio intent admitted after the preference is not applied.
    let (release, gate) = mpsc::channel();
    let (entered, ready) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::HoldJob(entered, gate))
        .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let met = crate::beat::Metronome {
        volume: 0.42,
        ..Default::default()
    };
    backend.adopt_metronome_preferences(1, met.clone()).unwrap();
    backend.karaoke_pref(1, true).unwrap();
    let input = crate::microphone::Prefs {
        gain: -21.,
        ..Default::default()
    };
    backend.input_prefs(1, input.clone()).unwrap();
    backend.control(1, "seek 99".into()).unwrap();
    backend.alive.store(false, Ordering::Release);
    release.send(()).unwrap();
    drop(backend);
    assert_eq!(crate::metronome_store::load(&root).unwrap(), met);
    assert!(crate::audio_devices::karaoke(
        &crate::audio_devices::load().unwrap()
    ));
    assert_eq!(
        crate::microphone::Prefs::read(&crate::audio_devices::load().unwrap())
            .unwrap()
            .gain,
        input.gain
    );
}

#[test]
fn actor_exit_guard_revokes_admission_and_reports_the_owned_epoch() {
    let (events, receipts) = mpsc::channel();
    let latest = Arc::new(AtomicU64::new(7));
    let alive = Arc::new(AtomicBool::new(true));
    let args = (events, latest.clone(), alive.clone());
    assert!(
        thread::spawn(move || {
            let (events, latest, alive) = args;
            let _exit = ActorExit::new(events, latest, alive);
            panic!("C17 actor exit negative control");
        })
        .join()
        .is_err()
    );
    assert!(
        !alive.load(Ordering::Acquire),
        "a dead actor still admits requests"
    );
    assert_ne!(
        latest.load(Ordering::Acquire),
        7,
        "jobs in the dead actor's epoch remain current"
    );
    assert!(matches!(
        receipts.recv_timeout(Duration::from_millis(100)),
        Ok(Event::TransportFailed(7, _))
    ));
    assert!(
        receipts.try_recv().is_err(),
        "actor published duplicate exit events"
    );
}

// Every subprocess has an isolated profile and a total deadline; a deadlock in
// either actor cannot strand the test runner or access real user preferences.
fn isolated(name: &str) -> Option<PathBuf> {
    if std::env::var("SINGZ_C17_CASE").as_deref() == Ok(name) {
        return Some(PathBuf::from(
            std::env::var_os("SINGZ_GPUI_CONFIG_DIR").unwrap(),
        ));
    }
    let root = std::env::temp_dir().join(format!("singz-c17-{}-{name}", std::process::id()));
    fs::create_dir_all(&root).unwrap();
    let log = fs::File::create(root.join("test.log")).unwrap();
    let mut child = Command::new(std::env::current_exe().unwrap())
        .args([
            "--exact",
            &format!("integration::actor_tests::{name}"),
            "--nocapture",
            "--include-ignored",
        ])
        .env("SINGZ_C17_CASE", name)
        .env("SINGZ_GPUI_CONFIG_DIR", &root)
        .env("SINGZ_GPUI_PROJECTS_ROOT", root.join("library"))
        .env("SINGZ_MUTE", "1")
        .env("SINGZ_NO_SYNC", "1")
        .stdout(log.try_clone().unwrap())
        .stderr(log)
        .spawn()
        .unwrap();
    let deadline = Instant::now() + Duration::from_secs(20);
    let result = loop {
        if let Some(result) = child.try_wait().unwrap() {
            break result;
        }
        if Instant::now() >= deadline {
            let _ = child.kill();
            let _ = child.wait();
            panic!("C17 {name} exceeded its 20-second deadline");
        }
        thread::sleep(Duration::from_millis(5));
    };
    let log = fs::read_to_string(root.join("test.log")).unwrap();
    let _ = fs::remove_dir_all(root);
    print!("{log}");
    assert!(result.success(), "{log}");
    None
}

#[test]
fn superseded_open_lane_and_import_handoffs_do_not_touch_the_helper() {
    let Some(root) = isolated("superseded_open_lane_and_import_handoffs_do_not_touch_the_helper")
    else {
        return;
    };
    let dir = root.join("project");
    fs::create_dir_all(dir.join("stems")).unwrap();
    fs::write(
        dir.join("stems/vocals.wav"),
        b"identity fixture, never decoded",
    )
    .unwrap();
    fs::write(
        dir.join("project.json"),
        br#"{"version":2,"name":"Handoff fixture","settings":{}}"#,
    )
    .unwrap();
    let project = read_project(&dir).unwrap();
    let log = root.join("commands.log");
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(418), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(2, Ordering::Release);
    let mut child = fixture_connection(&backend, Some(&log));
    child.project_dir = Some(project.dir.clone());
    child.loaded_lanes = project.lane_specs.clone();
    child.loaded_stamps = project.lane_stamps.clone();
    let (ack, ready) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(child, ack))
        .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    // Prepare epoch 1, then navigate to epoch 2 before any adoption. The stale
    // connection deliberately remains installed, making a missing fence observable.
    backend
        .requests
        .transport
        .send(Request::AdoptOpen(jobs::Open {
            admission: None,
            epoch: 1,
            path: project.dir.clone(),
            confirmed: None,
            project: project.clone(),
            met_commands: vec![],
            manifest: None,
            pending: None,
        }))
        .unwrap();
    backend
        .requests
        .transport
        .send(Request::AdoptLanes(jobs::Lanes {
            epoch: 1,
            serial: 3,
            candidate: project.clone(),
            additions: vec![],
            intent: Arc::new(AtomicU64::new(3)),
            previous: project.lane_specs.clone(),
            stamps: project.lane_stamps.clone(),
            refused: None,
        }))
        .unwrap();
    backend
        .requests
        .transport
        .send(Request::ImportCompleted(
            1,
            crate::project_import::Outcome {
                dir: project.dir.clone(),
                imported: true,
                moved: false,
                warning: None,
            },
            true,
            None,
        ))
        .unwrap();
    let (ack, ready) = mpsc::sync_channel(1);
    backend.requests.send(Request::ActorBarrier(ack)).unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(
        backend.provider_retired.load(Ordering::Acquire),
        1,
        "stale handoff retired or replaced the owned helper"
    );
    assert!(
        !log.exists(),
        "stale handoff touched the helper: {}",
        fs::read_to_string(&log).unwrap_or_default()
    );
    assert!(
        !backend.drain().iter().any(|event| matches!(
            event,
            Event::Opened(..)
                | Event::ImportedLibrary(..)
                | Event::LanesReplaced(..)
                | Event::Error(..)
        )),
        "stale preparation published an adoption receipt"
    );
    // Same-epoch lane edits also need the exact serial. Re-label only the test
    // connection; source identity and the stale candidate remain identical.
    let mut child = fixture_connection(&backend, Some(&log));
    child.epoch = 2;
    child.project_dir = Some(project.dir.clone());
    child.loaded_lanes = project.lane_specs.clone();
    child.loaded_stamps = project.lane_stamps.clone();
    let (ack, ready) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(child, ack))
        .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    backend
        .requests
        .transport
        .send(Request::AdoptLanes(jobs::Lanes {
            epoch: 2,
            serial: 3,
            candidate: project.clone(),
            additions: vec![],
            intent: Arc::new(AtomicU64::new(4)),
            previous: project.lane_specs.clone(),
            stamps: project.lane_stamps.clone(),
            refused: None,
        }))
        .unwrap();
    let (ack, ready) = mpsc::sync_channel(1);
    backend.requests.send(Request::ActorBarrier(ack)).unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 1);
    assert!(
        fs::read_to_string(&log)
            .unwrap_or_default()
            .lines()
            .all(|line| line == "status"),
        "superseded serial issued a helper mutation"
    );
    assert!(!backend.drain().iter().any(|event| matches!(
        event,
        Event::LanesReplaced(..)
            | Event::LanesCommittedFailed(..)
            | Event::LanesTransportFailed(..)
    )));
}

/// Hooks park the real operation at its I/O/join boundary, not its dispatcher.
#[derive(Default)]
pub(super) struct Hooks {
    gates:
        Mutex<std::collections::HashMap<&'static str, (mpsc::SyncSender<()>, Receiver<()>, bool)>>,
    pub wakes: AtomicU64,
    pub idle_recv: AtomicBool,
    pub met_writes: AtomicU64,
}
impl Hooks {
    fn hold(&self, operation: &'static str, cancellable: bool) -> (Receiver<()>, mpsc::Sender<()>) {
        let (entered, ready) = mpsc::sync_channel(1);
        let (release, gate) = mpsc::channel();
        assert!(
            self.gates
                .lock()
                .unwrap()
                .insert(operation, (entered, gate, cancellable))
                .is_none()
        );
        (ready, release)
    }
    pub fn enter(&self, operation: &'static str, alive: &AtomicBool) {
        let gate = self.gates.lock().unwrap().remove(operation);
        if let Some((entered, gate, cancellable)) = gate {
            let _ = entered.send(());
            let deadline = Instant::now() + Duration::from_secs(2);
            while (!cancellable || alive.load(Ordering::Acquire)) && Instant::now() < deadline {
                match gate.recv_timeout(Duration::from_millis(5)) {
                    Err(mpsc::RecvTimeoutError::Timeout) => {}
                    _ => break,
                }
            }
        }
    }
}
fn actor_barrier(backend: &Backend) {
    let (tx, rx) = mpsc::sync_channel(1);
    backend.requests.send(Request::ActorBarrier(tx)).unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
}
#[test]
fn idle_transport_has_zero_timer_wakeups_without_a_helper() {
    let Some(_root) = isolated("idle_transport_has_zero_timer_wakeups_without_a_helper") else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(419), None);
    let backend = Backend::new(cx.text_system().clone());
    actor_barrier(&backend);
    let before = backend.requests.jobs.hooks.wakes.load(Ordering::Relaxed);
    thread::sleep(Duration::from_secs(1));
    let wakes = backend.requests.jobs.hooks.wakes.load(Ordering::Relaxed) - before;
    assert_eq!(wakes, 0, "idle transport woke {wakes} times in one second");
}
#[test]
fn quit_skips_a_queued_slow_probe_but_retains_preferences() {
    let Some(root) = isolated("quit_skips_a_queued_slow_probe_but_retains_preferences") else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(420), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    let (tx, rx) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(
            fixture_connection(&backend, None),
            tx,
        ))
        .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    let retired = backend.provider_retired.clone();
    let (ready, release) = backend.requests.jobs.hooks.hold("preparation", false);
    backend
        .read_publication(
            1,
            1,
            Publication {
                path: root.join("missing-publication"),
                metadata_hash: String::new(),
            },
        )
        .unwrap();
    ready.recv_timeout(Duration::from_secs(5)).unwrap();
    let (probe_entered, _probe_release) = backend.requests.jobs.hooks.hold("output-probe", false);
    backend
        .requests
        .jobs
        .send(jobs::Job::OutputProbe(String::new()))
        .unwrap();
    backend.karaoke_pref(7, true).unwrap();
    let (finished, done) = mpsc::channel();
    let alive = backend.alive.clone();
    let started = Instant::now();
    let deadline = started + Duration::from_millis(750);
    let quitting = thread::spawn(move || {
        drop(backend);
        let _ = finished.send(());
    });
    // Keep the probe queued until shutdown actually starts, even if the quit
    // thread is delayed by the scheduler. Include that delay in the budget.
    while alive.load(Ordering::Acquire) && Instant::now() < deadline {
        thread::yield_now();
    }
    let _ = release.send(());
    let result = done.recv_timeout(deadline.saturating_duration_since(Instant::now()));
    quitting.join().unwrap();
    assert!(
        result.is_ok(),
        "queued slow probe delayed quit beyond 750 ms: {:?}",
        started.elapsed()
    );
    assert_eq!(
        retired.load(Ordering::Acquire),
        0,
        "quit retained the helper"
    );
    assert!(
        probe_entered.try_recv().is_err(),
        "quit executed an unstarted probe"
    );
    assert_eq!(
        crate::audio_devices::karaoke(
            &serde_json::from_slice(&fs::read(root.join("audio.json")).unwrap()).unwrap()
        ),
        true
    );
}

#[cfg(feature = "ui-tests")]
fn native_backend() -> (gpui_kit::TestAppContext, Backend, Project) {
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(421), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    // This test mode uses the actual muted native helper, as the latency run does.
    assert!(
        std::env::var_os("SINGZ_C17_NATIVE_LATENCY").is_some(),
        "run native actor cases with SINGZ_C17_NATIVE_LATENCY=1"
    );
    // The native helper plays a long tone; never run it unmuted, even when a
    // case is invoked directly rather than through `isolated()`.
    assert_eq!(
        std::env::var("SINGZ_MUTE").as_deref(),
        Ok("1"),
        "native actor cases require SINGZ_MUTE=1"
    );
    let child = fixture_connection(&backend, None);
    let project = read_project(&crate::audio_devices::directory().join("native-latency")).unwrap();
    let (tx, rx) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(child, tx))
        .unwrap();
    rx.recv_timeout(Duration::from_secs(5)).unwrap();
    (cx, backend, project)
}
#[cfg(feature = "ui-tests")]
fn wait_open(backend: &Backend, epoch: u64) -> Project {
    let deadline = Instant::now() + Duration::from_millis(560);
    loop {
        for event in backend.drain() {
            match event {
                Event::Opened(e, project, _, _) if e == epoch => return project,
                Event::Error(e, message, _) | Event::TransportFailed(e, message) if e == epoch => {
                    panic!("Open failed: {message}")
                }
                _ => {}
            }
        }
        assert!(
            Instant::now() < deadline,
            "Open waited behind unrelated I/O or join for more than N13's 560 ms"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
#[cfg(feature = "ui-tests")]
fn open_while_held(name: &str, operation: &'static str) {
    let Some(_root) = isolated(name) else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold(operation, true);
    match operation {
        "catalog" => backend.catalog(),
        "inventory" => backend.inventory(),
        "inspect" => backend
            .inspect_delete(project.dir.clone(), project.dir.clone(), 1)
            .unwrap(),
        "lanes" => backend.replace_lanes(1, 1, project.clone()).unwrap(),
        _ => unreachable!(),
    }
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let epoch = backend.open(project.dir.clone()).unwrap();
    assert_eq!(wait_open(&backend, epoch).dir, project.dir);
    assert!(
        release.send(()).is_ok(),
        "the held operation expired before Open"
    );
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn catalog_scan_does_not_delay_open() {
    open_while_held("catalog_scan_does_not_delay_open", "catalog");
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn inventory_probe_does_not_delay_open() {
    open_while_held("inventory_probe_does_not_delay_open", "inventory");
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn delete_inspection_does_not_delay_open() {
    open_while_held("delete_inspection_does_not_delay_open", "inspect");
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn lane_join_does_not_delay_open() {
    open_while_held("lane_join_does_not_delay_open", "lanes");
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn commands_before_open_adoption_replay_without_transport_failure() {
    let Some(_root) = isolated("commands_before_open_adoption_replay_without_transport_failure")
    else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("open-adopt", true);
    let epoch = backend.open(project.dir.clone()).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend.playback(epoch, 1, "play".into()).unwrap();
    backend.control(epoch, "seek 8".into()).unwrap();
    backend.rate(epoch, 2, 1.1, 0).unwrap();
    backend
        .metronome(epoch, 3, crate::beat::Metronome::default(), None)
        .unwrap();
    actor_barrier(&backend);
    assert!(
        !backend
            .drain()
            .iter()
            .any(|e| matches!(e, Event::TransportFailed(..))),
        "pending adoption was treated as a dead transport"
    );
    release.send(()).unwrap();
    wait_open(&backend, epoch);
    actor_barrier(&backend);
    let probe = backend
        .probe_owned_audio(epoch)
        .unwrap()
        .recv_timeout(Duration::from_secs(2))
        .unwrap()
        .unwrap();
    assert!(probe.status.seek_count >= 1);
    assert!((probe.status.rate - 1.1).abs() < 0.0001);
}

#[cfg(feature = "ui-tests")]
fn recovery_request(project: Project) -> AudioRecovery {
    let mix = crate::project_store::Mix {
        carry: project.carry.clone(),
        metronome: project.metronome.clone(),
        beat: project.beat.clone(),
        original: project.original,
        lanes: project.lanes.iter().map(|(slot, _)| *slot).collect(),
        custom: project.custom_tracks(),
        gain: project.gain,
        muted: project.muted,
        solo: project.solo,
        master: project.master,
        transpose: project.transpose,
        tempo: project.tempo,
        looping: project.looping,
        selection: project.selection,
        view: project.view.unwrap_or((0., 1.)),
    };
    AudioRecovery {
        replace: true,
        project,
        mix,
        position: 0.,
    }
}
#[cfg(feature = "ui-tests")]
fn wait_recovery(backend: &Backend, serial: u64) {
    let deadline = Instant::now() + Duration::from_millis(560);
    loop {
        for event in backend.drain() {
            if let Event::OutputRecovered(_, s, _, result) = event {
                if s == serial {
                    assert!(result.is_ok(), "recovery failed: {:?}", result.err());
                    return;
                }
            }
        }
        assert!(
            Instant::now() < deadline,
            "recovery queued behind unrelated work for more than 560 ms"
        );
        thread::sleep(Duration::from_millis(2));
    }
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn inventory_probe_does_not_delay_output_recovery() {
    let Some(_root) = isolated("inventory_probe_does_not_delay_output_recovery") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("inventory", true);
    backend.inventory();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend
        .recover_output(1, 9, recovery_request(project), String::new())
        .unwrap();
    wait_recovery(&backend, 9);
    assert!(
        release.send(()).is_ok(),
        "inventory gate expired before recovery"
    );
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn recovery_helper_stays_unpublished_until_media_verification() {
    let Some(_root) = isolated("recovery_helper_stays_unpublished_until_media_verification") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("verify", true);
    backend
        .recover_output(1, 10, recovery_request(project), String::new())
        .unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let probe = backend
        .probe_owned_audio(1)
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap();
    assert!(
        probe.is_err(),
        "unverified helper became publicly commandable"
    );
    release.send(()).unwrap();
    wait_recovery(&backend, 10);
    assert!(
        backend
            .probe_owned_audio(1)
            .unwrap()
            .recv_timeout(Duration::from_secs(1))
            .unwrap()
            .is_ok()
    );
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn metronome_preference_precedes_open_and_coalesces_disk_writes() {
    let Some(_root) = isolated("metronome_preference_precedes_open_and_coalesces_disk_writes")
    else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("met-write", true);
    let mut met = crate::beat::Metronome::default();
    met.count_in_bars = 1;
    backend.metronome(1, 1, met.clone(), None).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    for serial in 2..=6 {
        met.volume = serial as f64 / 10.;
        backend.metronome(1, serial, met.clone(), None).unwrap();
        actor_barrier(&backend);
    }
    let epoch = backend.open(project.dir.clone()).unwrap();
    let adopted = wait_open(&backend, epoch);
    assert_eq!(
        adopted.metronome, met,
        "Open inherited an older accepted metronome preference"
    );
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    loop {
        if crate::metronome_store::load(&crate::audio_devices::directory())
            .is_ok_and(|saved| saved == met)
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "latest metronome preference was not retained"
        );
        thread::sleep(Duration::from_millis(5));
    }
    assert!(
        backend
            .requests
            .jobs
            .hooks
            .met_writes
            .load(Ordering::Relaxed)
            <= 2,
        "each intermediate metronome preference was fsynced"
    );
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn command_for_a_new_lane_waits_for_lane_adoption() {
    let Some(_root) = isolated("command_for_a_new_lane_waits_for_lane_adoption") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    fs::copy(
        project.dir.join("stems/vocals.wav"),
        project.dir.join("stems/bass.wav"),
    )
    .unwrap();
    let candidate = read_project(&project.dir).unwrap();
    assert_eq!(candidate.lanes.len(), 2);
    let (entered, release) = backend.requests.jobs.hooks.hold("lanes", true);
    backend.replace_lanes(1, 1, candidate).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend.control(1, "lane 1 0.42 1 0".into()).unwrap();
    actor_barrier(&backend);
    assert!(
        !backend
            .drain()
            .iter()
            .any(|e| matches!(e, Event::TransportFailed(..))),
        "new-lane control was sent to the old graph"
    );
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut replaced = false;
    while !replaced {
        for event in backend.drain() {
            match event {
                Event::LanesReplaced(_, 1, result) => {
                    assert!(
                        result.is_ok(),
                        "lane replacement failed: {:?}",
                        result.err()
                    );
                    replaced = true;
                }
                Event::TransportFailed(_, m) => panic!("queued lane command failed: {m}"),
                _ => {}
            }
        }
        assert!(Instant::now() < deadline, "lane adoption did not finish");
        thread::sleep(Duration::from_millis(2));
    }
    actor_barrier(&backend);
    let probe = backend
        .probe_owned_audio(1)
        .unwrap()
        .recv_timeout(Duration::from_secs(1))
        .unwrap()
        .unwrap();
    let lane = &probe.status.observed_lanes[1];
    assert_eq!(
        lane["muted"], true,
        "queued mute was not applied to the adopted graph"
    );
    assert!(
        (lane["gain"].as_f64().unwrap() - 0.42).abs() < 0.0001,
        "queued gain was not applied to the adopted graph: {lane}"
    );
}

#[test]
fn uncounted_job_continuations_cannot_underflow_admission_slots() {
    let (sender, _mailboxes) =
        jobs::mailboxes(Arc::new(AtomicU64::new(0)), mpsc::sync_channel(1).0);
    // Internal continuations do not consume a facade admission. Releasing one
    // at the empty boundary must not turn zero into u64::MAX.
    jobs::release_slot(&sender.slots);
    assert_eq!(sender.slots.load(Ordering::Acquire), 0);
}

#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn live_transport_does_not_wait_for_a_pending_lane_join() {
    let Some(_root) = isolated("live_transport_does_not_wait_for_a_pending_lane_join") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    for serial in 1..=10 {
        backend
            .playback(
                1,
                serial,
                if serial % 2 == 1 { "play" } else { "pause" }.into(),
            )
            .unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        backend
            .requests
            .send(Request::ReceiptFence(1, serial, tx))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(3)).unwrap();
        backend.drain();
    }
    fs::copy(
        project.dir.join("stems/vocals.wav"),
        project.dir.join("stems/bass.wav"),
    )
    .unwrap();
    let candidate = read_project(&project.dir).unwrap();
    let (entered, release) = backend.requests.jobs.hooks.hold("lanes", true);
    backend.replace_lanes(1, 1, candidate).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut samples: [Vec<f64>; 3] = Default::default();
    for cycle in 0..30 {
        for (index, command) in ["play", "pause", "seek 8"].into_iter().enumerate() {
            let serial = cycle * 3 + index as u64 + 11;
            let started = Instant::now();
            if index < 2 {
                backend.playback(1, serial, command.into()).unwrap();
            } else {
                backend.control(1, command.into()).unwrap();
            }
            let (tx, rx) = mpsc::sync_channel(1);
            backend
                .requests
                .send(Request::ReceiptFence(1, serial, tx))
                .unwrap();
            let (_, _, mut status) = rx
                .recv_timeout(Duration::from_millis(100))
                .expect("live transport waited behind lane joins");
            if index < 2 {
                assert_eq!(status.playing, index == 0);
            } else {
                // The helper acknowledges enqueue before the render callback
                // applies Seek. Observe its actual seekCount receipt within
                // the same 100 ms bound, without accepting a stale fence.
                while status.seek_count < cycle + 1 {
                    let remaining = Duration::from_millis(100)
                        .checked_sub(started.elapsed())
                        .expect("seek did not reach the adopted graph within 100 ms");
                    status = backend
                        .probe_owned_audio(1)
                        .unwrap()
                        .recv_timeout(remaining)
                        .expect("seek did not reach the adopted graph within 100 ms")
                        .unwrap()
                        .status;
                    thread::sleep(Duration::from_millis(1));
                }
                assert!(
                    status.seek_count >= cycle + 1,
                    "seek did not reach the adopted graph"
                );
            }
            samples[index].push(started.elapsed().as_secs_f64() * 1000.);
        }
    }
    for (command, mut values) in ["play", "pause", "seek"].into_iter().zip(samples) {
        values.sort_by(f64::total_cmp);
        println!(
            "C17 load=lane-join held=true command={command} n=30 p50_ms={:.3} p99_ms={:.3} max_ms={:.3}",
            values[14], values[29], values[29]
        );
        assert!(
            values[29] <= 30.,
            "live lane-join p99 {} > 30ms",
            values[29]
        );
        assert!(values[29] <= 100.);
    }
    backend.rate(1, 4, 1.1, 0).unwrap();
    let met = crate::beat::Metronome {
        volume: 0.37,
        ..Default::default()
    };
    backend.metronome(1, 5, met.clone(), None).unwrap();
    actor_barrier(&backend);
    let events = backend.drain();
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::Rate(1, 4, Ok(_)))),
        "Rate waited behind lane joins"
    );
    assert!(
        events
            .iter()
            .any(|event| matches!(event, Event::Metronome(1, 5, _, _, Ok(_)))),
        "Metronome waited behind lane joins"
    );
    assert!(release.send(()).is_ok());
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        let mut adopted = false;
        for event in backend.drain() {
            if let Event::LanesReplaced(1, 1, result) = event {
                let (candidate, status, _) = result.unwrap();
                assert!((status.rate - 1.1).abs() < 0.0001);
                assert!((candidate.tempo - 1.1).abs() < 0.0001);
                assert_eq!(
                    candidate.metronome, met,
                    "lane adoption lost live metronome intent"
                );
                adopted = true;
            }
        }
        if adopted {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "live lane transaction never adopted"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn failed_lane_preparation_rejects_every_buffered_edit() {
    let Some(_root) = isolated("failed_lane_preparation_rejects_every_buffered_edit") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let bass = project.dir.join("stems/bass.wav");
    fs::copy(project.dir.join("stems/vocals.wav"), &bass).unwrap();
    let candidate = read_project(&project.dir).unwrap();
    let (entered, release) = backend.requests.jobs.hooks.hold("lanes", true);
    backend.replace_lanes(1, 1, candidate).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend.control(1, "lane 1 0.42 1 0".into()).unwrap();
    backend.control(1, "lane 1 0.52 0 1".into()).unwrap();
    actor_barrier(&backend);
    fs::remove_file(bass).unwrap();
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut failures = 0;
    while failures == 0 {
        for event in backend.drain() {
            match event {
                Event::LanesReplaced(1, 1, Err(_)) => failures += 1,
                Event::TransportFailed(..) => panic!("not-ready edits killed the transport"),
                _ => {}
            }
        }
        assert!(
            Instant::now() < deadline,
            "buffered edits were silently dropped: only {failures} failure receipts"
        );
        thread::sleep(Duration::from_millis(2));
    }
    actor_barrier(&backend);
    failures += backend
        .drain()
        .iter()
        .filter(|event| matches!(event, Event::LanesReplaced(1, 1, Err(_))))
        .count();
    assert_eq!(
        failures, 1,
        "one failed lane transaction produced duplicate notices"
    );
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 1);
}

#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn superseded_open_rejects_each_queued_operation() {
    let Some(_root) = isolated("superseded_open_rejects_each_queued_operation") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("open-adopt", true);
    let epoch = backend.open(project.dir.clone()).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend.playback(epoch, 1, "play".into()).unwrap();
    backend.control(epoch, "seek 8".into()).unwrap();
    backend.rate(epoch, 2, 1.1, 0).unwrap();
    backend
        .metronome(epoch, 3, crate::beat::Metronome::default(), None)
        .unwrap();
    actor_barrier(&backend);
    backend.open(project.dir).unwrap();
    actor_barrier(&backend);
    let events = backend.drain();
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::Rate(e,2,Err(_)) if *e==epoch)),
        "superseded Rate was silently dropped"
    );
    assert!(
        events
            .iter()
            .any(|e| matches!(e, Event::Metronome(e,3,_,_,Err(_)) if *e==epoch)),
        "superseded Metronome was silently dropped"
    );
    assert_eq!(
        events
            .iter()
            .filter(|e| matches!(e, Event::Error(e,_,_) if *e==epoch))
            .count(),
        1,
        "one superseded Open produced duplicate playback/seek notices"
    );
    assert!(
        !events
            .iter()
            .any(|e| matches!(e, Event::TransportFailed(..)))
    );
    let _ = release.send(());
}

#[test]
fn pending_metronome_writes_keep_only_latest_value_and_all_receipts() {
    let Some(root) = isolated("pending_metronome_writes_keep_only_latest_value_and_all_receipts")
    else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(422), None);
    let backend = Backend::new(cx.text_system().clone());
    let (entered, release) = backend.requests.jobs.hooks.hold("met-write", true);
    let mut met = crate::beat::Metronome {
        volume: 0.1,
        ..Default::default()
    };
    backend.adopt_metronome_preferences(7, met.clone()).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    for step in 2..=6 {
        met.volume = step as f64 / 10.;
        backend.adopt_metronome_preferences(7, met.clone()).unwrap();
    }
    actor_barrier(&backend);
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(1);
    let mut receipts = 0;
    while receipts < 6 {
        for event in backend.drain() {
            if let Event::MetronomePrefsSaved(7, 0, error) = event {
                assert!(
                    error.is_none(),
                    "accepted preference was not retained: {error:?}"
                );
                receipts += 1;
            }
        }
        assert!(
            Instant::now() < deadline,
            "coalescing lost a preference receipt: {receipts}/6"
        );
        thread::sleep(Duration::from_millis(2));
    }
    assert_eq!(receipts, 6);
    assert_eq!(crate::metronome_store::load(&root).unwrap(), met);
    assert_eq!(
        backend
            .requests
            .jobs
            .hooks
            .met_writes
            .load(Ordering::Relaxed),
        1,
        "intermediate metronome preferences were written to disk"
    );
}

#[test]
fn idle_provider_snapshot_refreshes_after_renderer_lease_changes() {
    let Some(_root) = isolated("idle_provider_snapshot_refreshes_after_renderer_lease_changes")
    else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(423), None);
    let backend = Backend::new(cx.text_system().clone());
    actor_barrier(&backend);
    backend.drain();
    let ready = Instant::now() + Duration::from_secs(1);
    while !backend
        .requests
        .jobs
        .hooks
        .idle_recv
        .load(Ordering::Acquire)
    {
        assert!(Instant::now() < ready, "transport did not enter idle recv");
        thread::sleep(Duration::from_millis(1));
    }
    // No request follows this out-of-band lease update. It must wake the
    // sleeping actor itself; periodic status polling is deliberately absent.
    let revision = backend.provider_renderer_busy(false);
    let deadline = Instant::now() + Duration::from_millis(100);
    loop {
        if backend.drain().iter().any(|event| matches!(event, Event::Provider(snapshot) if snapshot.renderer_revision == revision)) { break; }
        assert!(
            Instant::now() < deadline,
            "idle renderer lease change did not publish its provider revision"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let ready = Instant::now() + Duration::from_secs(1);
    while !backend
        .requests
        .jobs
        .hooks
        .idle_recv
        .load(Ordering::Acquire)
    {
        assert!(
            Instant::now() < ready,
            "transport did not return to idle recv"
        );
        thread::sleep(Duration::from_millis(1));
    }
    let wakes = backend.requests.jobs.hooks.wakes.load(Ordering::Acquire);
    backend.provider_pending.fetch_add(1, Ordering::AcqRel);
    let work = provider_control::PendingWork(
        backend.provider_pending.clone(),
        backend.requests.transport.clone(),
    );
    thread::spawn(move || drop(work)).join().unwrap();
    assert_eq!(backend.provider_pending.load(Ordering::Acquire), 0);
    let deadline = Instant::now() + Duration::from_millis(100);
    while backend.requests.jobs.hooks.wakes.load(Ordering::Acquire) == wakes {
        assert!(
            Instant::now() < deadline,
            "completed provider work did not wake the idle actor"
        );
        thread::sleep(Duration::from_millis(1));
    }
}

#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn failed_lane_transaction_cannot_restore_an_old_metronome() {
    let Some(_root) = isolated("failed_lane_transaction_cannot_restore_an_old_metronome") else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let bass = project.dir.join("stems/bass.wav");
    fs::copy(project.dir.join("stems/vocals.wav"), &bass).unwrap();
    let candidate = read_project(&project.dir).unwrap();
    let (entered, release) = backend.requests.jobs.hooks.hold("lanes", true);
    backend.replace_lanes(1, 1, candidate.clone()).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    let mut met = crate::beat::Metronome {
        volume: 0.25,
        ..Default::default()
    };
    backend.metronome(1, 2, met.clone(), None).unwrap();
    actor_barrier(&backend);
    fs::remove_file(&bass).unwrap();
    release.send(()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        if backend
            .drain()
            .iter()
            .any(|e| matches!(e, Event::LanesReplaced(1, 1, Err(_))))
        {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "first lane preparation did not fail"
        );
        thread::sleep(Duration::from_millis(2));
    }
    met.volume = 0.75;
    backend.metronome(1, 3, met.clone(), None).unwrap();
    actor_barrier(&backend);
    fs::copy(project.dir.join("stems/vocals.wav"), &bass).unwrap();
    let mut candidate = read_project(&project.dir).unwrap();
    candidate.metronome = met.clone();
    backend.replace_lanes(1, 3, candidate).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    loop {
        for event in backend.drain() {
            match event {
                Event::LanesReplaced(1, 3, Ok((candidate, _, _))) => {
                    assert_eq!(
                        candidate.metronome, met,
                        "failed lane transaction restored its stale metronome"
                    );
                    return;
                }
                Event::LanesReplaced(1, 3, Err(error)) | Event::TransportFailed(_, error) => {
                    panic!("{error}")
                }
                _ => {}
            }
        }
        assert!(
            Instant::now() < deadline,
            "successor lane adoption did not finish"
        );
        thread::sleep(Duration::from_millis(2));
    }
}

#[cfg(feature = "ui-tests")]
fn failed_open_notice(name: &str, monitoring: bool) {
    let Some(_root) = isolated(name) else {
        return;
    };
    let (_cx, backend, project) = native_backend();
    let (entered, release) = backend.requests.jobs.hooks.hold("open-adopt", true);
    let epoch = backend.open(project.dir).unwrap();
    entered.recv_timeout(Duration::from_secs(5)).unwrap();
    backend.playback(epoch, 1, "play".into()).unwrap();
    backend.control(epoch, "seek 8".into()).unwrap();
    backend.rate(epoch, 2, 1.1, 0).unwrap();
    actor_barrier(&backend);
    let error = if monitoring {
        let (tx, rx) = mpsc::sync_channel(1);
        backend
            .requests
            .send(Request::SetTestMonitor(true, tx))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(1)).unwrap();
        release.send(()).unwrap();
        "Stop microphone monitoring before opening a project"
    } else {
        backend
            .requests
            .send(Request::OpenPreparationFailed(
                epoch,
                "fixture Open preparation failure".into(),
            ))
            .unwrap();
        "fixture Open preparation failure"
    };
    let deadline = Instant::now() + Duration::from_secs(2);
    let mut messages = Vec::new();
    let mut rate_errors = Vec::new();
    loop {
        for event in backend.drain() {
            match event {
                Event::Error(e, message, _) if e == epoch => messages.push(message),
                Event::Rate(e, 2, Err(message)) if e == epoch => rate_errors.push(message),
                Event::TransportFailed(_, error) => {
                    panic!("readiness failure killed transport: {error}")
                }
                _ => {}
            }
        }
        if !messages.is_empty() {
            break;
        }
        assert!(
            Instant::now() < deadline,
            "Open failure notice never arrived"
        );
        thread::sleep(Duration::from_millis(2));
    }
    actor_barrier(&backend);
    for event in backend.drain() {
        match event {
            Event::Error(e, message, _) if e == epoch => messages.push(message),
            Event::Rate(e, 2, Err(message)) if e == epoch => rate_errors.push(message),
            _ => {}
        }
    }
    assert_eq!(
        rate_errors,
        vec![error.to_owned()],
        "deferred Rate must preserve the real Open failure"
    );
    assert_eq!(
        messages,
        vec![error.to_owned()],
        "failed Open must report its actual error once"
    );
    if !monitoring {
        let _ = release.send(());
    }
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn failed_open_reports_one_notice_for_all_deferred_commands() {
    failed_open_notice(
        "failed_open_reports_one_notice_for_all_deferred_commands",
        false,
    );
}
#[cfg(feature = "ui-tests")]
#[test]
#[ignore = "requires real muted native helpers; run explicitly with SINGZ_C17_NATIVE_LATENCY=1"]
fn monitor_refused_open_reports_the_real_error_once() {
    failed_open_notice("monitor_refused_open_reports_the_real_error_once", true);
}


fn c18_refusal_row(name: &str, row: &str) {
    let Some(_root) = isolated(name) else {
        return;
    };
    {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(440), None);
        let backend = Backend::new(cx.text_system().clone());
        backend.epoch.store(1, Ordering::Release);
        let child = fixture_connection_mode(&backend, None, if row == "metronome" {"met-first"} else {"refusal"});
        let pid = child.helper.id().unwrap();
        let (tx, rx) = mpsc::sync_channel(1);
        backend
            .requests
            .send(Request::InstallTestConnection(child, tx))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        backend.control(1, "status".into()).unwrap();
        actor_barrier(&backend);
        backend.drain();
        match row {
            "seek" => backend.control(1, "seek 999999".into()).unwrap(),
            "play" => backend.playback(1, 1, "play".into()).unwrap(),
            "metronome" => backend
                .metronome(1, 1, crate::beat::Metronome::default(), None)
                .unwrap(),
            "cue" => {
                backend.training_intent.store(1, Ordering::Release);
                backend
                    .requests
                    .send(Request::Training(
                        1,
                        crate::training_audio::Phrase {
                            generation: 1,
                            instrument: crate::training_audio::Instrument::Piano,
                            gain: 0.,
                            timing: Some(crate::training_audio::Timing {
                                note_duration: 10.,
                                ..Default::default()
                            }),
                            cues: vec![
                                crate::training_audio::Cue {
                                    purpose: crate::training_audio::Purpose::Question,
                                    together: false,
                                    notes: vec![60; 32]
                                };
                                8
                            ],
                        },
                    ))
                    .unwrap();
            }
            _ => unreachable!(),
        }
        actor_barrier(&backend);
        let events = backend.drain();
        assert!(
            !events
                .iter()
                .any(|e| matches!(e, Event::TransportFailed(..))),
            "{row}: refusal killed helper"
        );
        assert!(
            events.iter().any(|e| matches!(
                e,
                Event::Error(..)
                    | Event::Metronome(_, _, _, _, Err(_))
                    | Event::Training(_, _, Err(_))
            )),
            "{row}: refusal was not reported"
        );
        assert_eq!(
            backend.provider_retired.load(Ordering::Acquire),
            1,
            "{row}: helper retired"
        );
        #[cfg(unix)]
        assert_eq!(
            unsafe { libc::kill(pid as libc::pid_t, 0) },
            0,
            "{row}: original PID changed"
        );
        #[cfg(not(unix))]
        let _ = pid;
        if row == "play" {
            assert!(
                events.iter().any(|e| matches!(e, Event::Playback(1, 1, _))),
                "refused Play did not settle its intent"
            );
        }
        backend.control(1, "status".into()).unwrap();
        actor_barrier(&backend);
        let telemetry = backend.telemetry.lock().unwrap();
        let status = &telemetry.as_ref().expect("next status failed").1;
        assert_eq!(
            (status.lane_revision, status.carry_revision),
            (1, 1),
            "{row}: revisions changed"
        );
    }
}

#[test]
fn c18_refused_seek_survives() {
    c18_refusal_row("c18_refused_seek_survives", "seek");
}
#[test]
fn c18_refused_metronome_survives() {
    c18_refusal_row("c18_refused_metronome_survives", "metronome");
}
#[test]
fn c18_refused_cue_survives() {
    c18_refusal_row("c18_refused_cue_survives", "cue");
}
#[test]
fn c18_refused_play_survives() {
    c18_refusal_row("c18_refused_play_survives", "play");
}

#[test]
fn c18_fault_table_retires_and_publishes() {
    let Some(_root) = isolated("c18_fault_table_retires_and_publishes") else {
        return;
    };
    for mode in ["malformed", "6", "7", "ownership"] {
        let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(441), None);
        let backend = Backend::new(cx.text_system().clone());
        backend.epoch.store(1, Ordering::Release);
        let child = fixture_connection_mode(&backend, None, mode);
        let (tx, rx) = mpsc::sync_channel(1);
        backend
            .requests
            .send(Request::InstallTestConnection(child, tx))
            .unwrap();
        rx.recv_timeout(Duration::from_secs(2)).unwrap();
        backend.control(1, "status".into()).unwrap();
        actor_barrier(&backend);
        backend.drain();
        backend.control(1, "seek 999999".into()).unwrap();
        actor_barrier(&backend);
        assert!(
            backend
                .drain()
                .iter()
                .any(|e| matches!(e, Event::TransportFailed(1, _))),
            "{mode}: fault not published"
        );
        assert_eq!(
            backend.provider_retired.load(Ordering::Acquire),
            0,
            "{mode}: helper not reaped"
        );
    }
}

#[cfg(all(unix, feature = "ui-tests"))]
fn c18_retirement_case(name: &str, mode: &str, expected: helper::Retirement) {
    let Some(root) = isolated(name) else {
        return;
    };
    use std::os::unix::fs::PermissionsExt;
    let script = root.join("fake-helper");
    let receipt = root.join("quit.receipt");
    let python = Command::new("which").arg("python3").output().unwrap();
    let python = String::from_utf8(python.stdout).unwrap();
    fs::write(&script,format!(r#"#!{}
import sys,json,time
v={{"protocol":1,"provider":"coreaudio","fixture":True,"backendProvider":"fake","ok":True,"state":0,"duration":0,"position":0,"playing":False,"trainingOnly":True,"cueGeneration":0,"cueStartHostNs":"0","cueEndHostNs":"0","cueNowHostNs":"0","cueActive":False,"cueOutputLatencyMs":0,"cueNotes":[]}}
print(json.dumps(v),flush=True)
for line in sys.stdin:
 if line.strip()=='quit':
  open({:?},'w').write('quit')
  if {:?}=='ignore':
   while True:time.sleep(60)
  sys.exit(1 if {:?}=='unclean' else 0)
"#,python.trim(),receipt.to_str().unwrap(),mode,mode)).unwrap();
    fs::set_permissions(&script, fs::Permissions::from_mode(0o700)).unwrap();
    unsafe {
        std::env::set_var("SINGZ_GPUI_AUDIO_HELPER", &script);
    }
    let retired = Arc::new(AtomicU64::new(0));
    let (mut child, _) = Connection::open(
        None,
        1,
        Arc::new(AtomicU64::new(1)),
        Arc::new(AtomicBool::new(true)),
        Arc::new(AtomicU64::new(0)),
        "",
        crate::audio_devices::Provider::platform_default(),
        retired.clone(),
        None,
    )
    .unwrap();
    assert_eq!(retired.load(Ordering::Acquire), 1);
    let started = Instant::now();
    assert_eq!(child.helper.retire().unwrap(), expected);
    let elapsed = started.elapsed();
    if expected == helper::Retirement::Killed {
        assert!(elapsed >= helper::QUIT_BOUND);
        assert!(
            elapsed <= helper::QUIT_BOUND + Duration::from_millis(100),
            "kill fallback took {elapsed:?}"
        );
    } else {
        assert!(elapsed < helper::QUIT_BOUND);
    }
    assert!(receipt.exists(), "quit was not written");
    assert_eq!(
        retired.load(Ordering::Acquire),
        0,
        "provider released before reaping"
    );
    drop(child);
    assert_eq!(
        retired.load(Ordering::Acquire),
        0,
        "Drop decremented retirement twice"
    );
}
#[cfg(all(unix, feature = "ui-tests"))]
#[test]
fn c18_clean_retirement() {
    c18_retirement_case("c18_clean_retirement", "clean", helper::Retirement::Clean);
}
#[cfg(all(unix, feature = "ui-tests"))]
#[test]
fn c18_unclean_retirement() {
    c18_retirement_case(
        "c18_unclean_retirement",
        "unclean",
        helper::Retirement::Unclean,
    );
}
#[cfg(all(unix, feature = "ui-tests"))]
#[test]
fn c18_killed_retirement() {
    c18_retirement_case(
        "c18_killed_retirement",
        "ignore",
        helper::Retirement::Killed,
    );
}

#[test]
fn c18_quit_during_status_read_is_graceful() {
    let name = "c18_quit_during_status_read_is_graceful";
    let Some(root) = isolated(name) else {
        return;
    };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(442), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    let log = root.join("commands.log");
    let child = fixture_connection_mode(&backend, Some(&log), "stall-status");
    let retired = backend.provider_retired.clone();
    let (tx, rx) = mpsc::sync_channel(1);
    backend
        .requests
        .send(Request::InstallTestConnection(child, tx))
        .unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    backend.control(1, "status".into()).unwrap();
    let deadline = Instant::now() + Duration::from_secs(2);
    while !fs::read_to_string(&log)
        .unwrap_or_default()
        .contains("status")
    {
        assert!(Instant::now() < deadline, "helper never received status");
        thread::sleep(Duration::from_millis(1));
    }
    let started = Instant::now();
    drop(backend);
    assert!(started.elapsed() < helper::QUIT_BOUND);
    assert_eq!(retired.load(Ordering::Acquire), 0);
    assert!(
        fs::read_to_string(log)
            .unwrap()
            .lines()
            .any(|line| line == "quit"),
        "quit during read force-killed helper"
    );
}


fn c18_v01_backend(mode: &str, log: Option<&Path>) -> (gpui_kit::TestAppContext, Backend) {
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(445), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    let child = fixture_connection_mode(&backend, log, mode);
    let (tx, rx) = mpsc::sync_channel(1);
    backend.requests.send(Request::InstallTestConnection(child, tx)).unwrap();
    rx.recv_timeout(Duration::from_secs(2)).unwrap();
    backend.control(1, "status".into()).unwrap();
    actor_barrier(&backend);
    backend.drain();
    (cx, backend)
}

#[test]
fn c18_v01_control_refusal_identifies_seek_target() {
    let Some(_root) = isolated("c18_v01_control_refusal_identifies_seek_target") else { return; };
    let (_cx, backend) = c18_v01_backend("refusal", None);
    backend.control(1, "seek 999999.125".into()).unwrap();
    actor_barrier(&backend);
    let events = backend.drain();
    assert!(events.iter().any(|event| matches!(event,
        Event::Error(1, _, Severity::Refused(RefusedCommand::Seek { target })) if *target == 999999.125)),
        "seek refusal did not identify the requested target");
    backend.control(1, "play".into()).unwrap();
    actor_barrier(&backend);
    assert!(backend.drain().iter().any(|event| matches!(event,
        Event::Error(1, _, Severity::Refused(RefusedCommand::Other)))),
        "non-seek Control refusal was mislabeled");
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 1);
}

#[test]
fn c18_v01_second_metronome_refusal_is_fatal() {
    let Some(root) = isolated("c18_v01_second_metronome_refusal_is_fatal") else { return; };
    let log = root.join("metronome.log");
    let (_cx, backend) = c18_v01_backend("met-second", Some(&log));
    backend.metronome(1, 1, crate::beat::Metronome::default(), None).unwrap();
    actor_barrier(&backend);
    let commands = fs::read_to_string(log).unwrap();
    let commands: Vec<_> = commands.lines().filter(|line| line.starts_with("met-")).collect();
    assert_eq!(commands.len(), 2);
    assert!(commands[0].starts_with("met-begin "));
    assert_eq!(commands[1], "met-apply");
    assert!(backend.drain().iter().any(|event| matches!(event, Event::TransportFailed(1, _))),
        "mid-transaction metronome refusal retained the helper");
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 0);
}

fn c18_v01_ownership_fault(name: &str, mode: &str) {
    let Some(_root) = isolated(name) else { return; };
    let (_cx, backend) = c18_v01_backend(mode, None);
    backend.control(1, "seek 999999".into()).unwrap();
    actor_barrier(&backend);
    assert!(backend.drain().iter().any(|event| matches!(event, Event::TransportFailed(1, _))),
        "{mode}: changed loop or region survived a refusal");
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 0);
}
#[test]
fn c18_v01_loop_ownership_refusal_fault() {
    c18_v01_ownership_fault("c18_v01_loop_ownership_refusal_fault", "loop-drift");
}
#[test]
fn c18_v01_region_ownership_refusal_fault() {
    c18_v01_ownership_fault("c18_v01_region_ownership_refusal_fault", "region-drift");
}

#[test]
fn c18_v01_command_after_read_cancel_returns_error() {
    let Some(_root) = isolated("c18_v01_command_after_read_cancel_returns_error") else { return; };
    let cx = gpui_kit::TestAppContext::build(gpui_kit::TestDispatcher::new(446), None);
    let backend = Backend::new(cx.text_system().clone());
    backend.epoch.store(1, Ordering::Release);
    let mut child = fixture_connection(&backend, None);
    backend.epoch.store(2, Ordering::Release);
    assert!(child.command("status").unwrap_err().is::<ReadCancelled>());
    assert_eq!(backend.provider_retired.load(Ordering::Acquire), 0);
    let followup = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| child.command("lanes-cancel")));
    assert!(followup.is_ok(), "post-cancel command panicked");
    let error = followup.unwrap().unwrap_err();
    assert_eq!(error.downcast_ref::<std::io::Error>().unwrap().kind(), std::io::ErrorKind::BrokenPipe);
    assert_eq!(child.helper.id().unwrap_err().kind(), std::io::ErrorKind::BrokenPipe);
    assert_eq!(child.helper.kill().unwrap_err().kind(), std::io::ErrorKind::BrokenPipe);
}

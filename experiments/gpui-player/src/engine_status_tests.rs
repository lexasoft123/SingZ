use super::*;
use std::{
    fs,
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc,
    },
    thread,
    time::Instant,
};
struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Self {
        static ID: AtomicU64 = AtomicU64::new(1);
        let path = std::env::temp_dir().join(format!(
            "singz-engine-status-{}-{}",
            std::process::id(),
            ID.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&path).unwrap();
        Self(path)
    }
    fn config(&self, flavor: Flavor) -> Config {
        let mut config = Config::source();
        config.pack = self.0.join("pack");
        config.models = self.0.join("models");
        config.flavor = flavor;
        config.fixture = true;
        config
    }
    fn environment(&self) -> Environment {
        Environment {
            home: self.0.join("home"),
            path: OsString::new(),
            override_command: None,
            no_system: false,
            platform: Platform::Other,
            timeout: Duration::from_secs(2),
            fixture_candidates: Some(vec![]),
        }
    }
    #[cfg(unix)]
    fn script(&self, path: &std::path::Path, body: &str) {
        use std::os::unix::fs::PermissionsExt;
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, format!("#!/bin/sh\n{body}\n")).unwrap();
        fs::set_permissions(path, fs::Permissions::from_mode(0o700)).unwrap();
    }
    #[cfg(unix)]
    fn pack(&self, config: &Config, body: &str) {
        self.script(&pack_python(config), body);
        let uvr = config.pack.join("python/models/uvr");
        fs::create_dir_all(&uvr).unwrap();
        fs::write(uvr.join("UVR_MDXNET_KARA_2.onnx"), b"fixture model").unwrap();
        fs::write(
            config.pack.join("python/pack.json"),
            format!("{{\"formatVersion\":{}}}", config.flavor.pack_format()),
        )
        .unwrap();
        if config.flavor != Flavor::AppleSilicon {
            let snapshots = config
                .pack
                .join("python/model-cache/models--StemSplitio--htdemucs-6s-onnx/snapshots/fixture");
            fs::create_dir_all(&snapshots).unwrap();
            fs::write(
                snapshots.join("htdemucs_6s_fp16weights.onnx"),
                b"fixture ONNX",
            )
            .unwrap();
        }
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
fn args(commands: Vec<Vec<OsString>>) -> Vec<Vec<String>> {
    commands
        .into_iter()
        .map(|c| {
            c.into_iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect()
        })
        .collect()
}
#[test]
fn source_candidate_order_keeps_override_local_bins_and_python_launchers() {
    let fixture = Fixture::new();
    let mut env = fixture.environment();
    env.fixture_candidates = None;
    env.override_command = Some("python3   -m demucs\tmodule".into());
    env.platform = Platform::Mac;
    let commands = args(env.candidates());
    assert_eq!(commands[0], ["python3", "-m", "demucs\tmodule"]);
    assert_eq!(commands[1], ["demucs"]);
    assert_eq!(
        commands[2],
        [env.home.join(".local/bin/demucs").display().to_string()]
    );
    assert_eq!(commands[3], ["/opt/homebrew/bin/demucs"]);
    assert_eq!(commands[4], ["/usr/local/bin/demucs"]);
    assert_eq!(commands[5], ["python3", "-m", "demucs"]);
    assert_eq!(commands[6], ["python", "-m", "demucs"]);
    env.platform = Platform::Windows;
    assert_eq!(
        args(env.candidates()).last().unwrap(),
        &["py", "-m", "demucs"]
    );
}
#[test]
fn gui_path_preserves_existing_locations_then_appends_source_locations() {
    let fixture = Fixture::new();
    let mut env = fixture.environment();
    env.path = std::env::join_paths([fixture.0.join("first"), fixture.0.join("second")]).unwrap();
    assert_eq!(
        std::env::split_paths(&env.expanded_path().unwrap()).collect::<Vec<_>>(),
        [
            fixture.0.join("first"),
            fixture.0.join("second"),
            env.home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin")
        ]
    );
}
#[test]
fn exhausted_discovery_has_source_models_needed_status_and_no_execution() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let status = discover_in(&config, &fixture.environment(), &AtomicU64::new(7), 7).unwrap();
    assert!(!status.ok && status.needs_models && !status.needs_pcm && status.resolved.is_none());
    assert!(status.command.is_none());
    assert_eq!(
        status.message.as_deref(),
        Some("The stem splitter has not been downloaded yet.")
    );
    let json = serde_json::to_value(status).unwrap();
    assert_eq!(json["needsModels"], true);
    assert!(json.get("resolved").is_none());
}
#[cfg(unix)]
#[test]
fn real_system_probe_wins_over_valid_pack_and_retains_exact_execution_argv() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let pack_log = fixture.0.join("pack-called");
    fixture.pack(
        &config,
        &format!("printf pack > '{}'; exit 0", pack_log.display()),
    );
    let script = fixture.0.join("system-engine");
    let log = fixture.0.join("args");
    fixture.script(
        &script,
        &format!("printf '%s\\n' \"$*\" > '{}'; exit 0", log.display()),
    );
    let mut env = fixture.environment();
    env.fixture_candidates = Some(vec![vec![
        script.clone().into_os_string(),
        "-m".into(),
        "demucs".into(),
    ]]);
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(status.ok && !status.needs_models && !status.needs_pcm);
    assert!(!pack_log.exists());
    assert_eq!(fs::read_to_string(log).unwrap(), "-m demucs --help\n");
    let engine = status.resolved.unwrap();
    let command = engine.system_command().unwrap();
    assert_eq!(command.get_program(), script.as_os_str());
    assert_eq!(
        command.get_args().collect::<Vec<_>>(),
        [OsStr::new("-m"), OsStr::new("demucs")]
    );
    assert!(!engine.needs_pcm());
    assert!(command
        .get_envs()
        .any(|(name, value)| name == "PATH"
            && value == Some(env.expanded_path().unwrap().as_os_str())));
}
#[cfg(unix)]
#[test]
fn failure_advances_to_next_actual_candidate_and_no_system_disables_all_candidates() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let first = fixture.0.join("first");
    let second = fixture.0.join("second");
    let called = fixture.0.join("second-called");
    fixture.script(&first, "exit 9");
    fixture.script(
        &second,
        &format!("printf called > '{}'; exit 0", called.display()),
    );
    let mut env = fixture.environment();
    env.fixture_candidates = Some(vec![
        vec![first.into_os_string()],
        vec![second.clone().into_os_string()],
    ]);
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(status.ok);
    assert_eq!(status.command, Some(second.display().to_string()));
    assert!(called.exists());
    fs::remove_file(&called).unwrap();
    env.no_system = true;
    let missing = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(!missing.ok && missing.needs_models);
    assert!(!called.exists());
}
#[cfg(unix)]
#[test]
fn validated_torch_and_onnx_packs_are_probed_with_their_real_entrypoints() {
    for flavor in [Flavor::AppleSilicon, Flavor::IntelMac] {
        let fixture = Fixture::new();
        let config = fixture.config(flavor);
        let log = fixture.0.join("args");
        fixture.pack(
            &config,
            &format!("printf '%s\\n' \"$*\" > '{}'; exit 0", log.display()),
        );
        let mut env = fixture.environment();
        env.no_system = true;
        let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
        assert!(status.ok && status.needs_pcm && !status.needs_models);
        let args = fs::read_to_string(log).unwrap();
        if flavor == Flavor::IntelMac {
            assert_eq!(args, format!("-c {ONNX_SHIM} --help\n"));
            assert_eq!(status.command.as_deref(), Some("splitter pack (ONNX)"));
        } else {
            assert_eq!(args, "-m demucs --help\n");
        }
        assert!(matches!(status.resolved, Some(ResolvedEngine::Pack { .. })));
    }
}
#[cfg(unix)]
#[test]
fn incomplete_onnx_models_and_broken_python_never_fake_readiness() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::IntelMac);
    let log = fixture.0.join("called");
    fixture.pack(
        &config,
        &format!("printf called > '{}'; exit 0", log.display()),
    );
    fs::remove_dir_all(config.pack.join("python/model-cache")).unwrap();
    let mut env = fixture.environment();
    env.no_system = true;
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(!status.ok && status.needs_models);
    assert!(!log.exists());
    let config = fixture.config(Flavor::AppleSilicon);
    fixture.pack(&config, "printf 'missing runtime library' >&2; exit 7");
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(!status.ok && status.needs_models && status.resolved.is_none());
}
#[cfg(unix)]
#[test]
fn cancelling_a_running_probe_reaps_owned_process_tree_instead_of_falling_back() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let script = fixture.0.join("slow");
    let receipt = fixture.0.join("started");
    fixture.script(
        &script,
        r#"/bin/sleep 30 & child=$!; printf '%s %s\n' "$$" "$child" > "$1"; wait"#,
    );
    let mut env = fixture.environment();
    env.timeout = Duration::from_secs(40);
    // Execute the stable interpreter, not a newly written executable that can
    // encounter ETXTBSY when another test's fork inherits its writable FD.
    env.fixture_candidates = Some(vec![vec![
        OsString::from("/bin/sh"),
        script.into_os_string(),
        receipt.clone().into_os_string(),
    ]]);
    let serial = Arc::new(AtomicU64::new(1));
    let cancel = serial.clone();
    let thread = thread::spawn(move || {
        let started = Instant::now();
        while started.elapsed() < Duration::from_secs(2) {
            if let Ok(text) = fs::read_to_string(&receipt) {
                if let Ok(pids) = text.split_whitespace().map(str::parse::<libc::pid_t>)
                    .collect::<std::result::Result<Vec<_>, _>>()
                {
                    if pids.len() == 2 && pids[0] != pids[1] && pids.iter().all(|pid| *pid > 1) {
                        let running = pids.iter().all(|pid| unsafe {
                            libc::kill(*pid, 0) == 0 && libc::getpgid(*pid) == pids[0]
                        });
                        cancel.store(2, Ordering::Release);
                        return Some((pids, running));
                    }
                }
            }
            thread::sleep(Duration::from_millis(5));
        }
        // Also retire an invocation whose startup failed to produce evidence.
        cancel.store(2, Ordering::Release);
        None
    });
    let started = Instant::now();
    let result = discover_in(&config, &env, &serial, 1);
    let (pids, running) = thread.join().unwrap().expect("Probe did not publish its startup receipt");
    assert!(running, "Probe and background descendant must run before cancellation");
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    loop {
        let stopped = pids.iter().all(|pid| {
            let output = Command::new("/bin/ps").args(["-p", &pid.to_string(), "-o", "stat="])
                .output().unwrap();
            let state = String::from_utf8_lossy(&output.stdout);
            // Container init may retain orphan zombies, which execute no code
            // and hold no output descriptors. Never signal a reaped PID here.
            !output.status.success() || state.trim().is_empty() || state.trim().starts_with('Z')
        });
        if stopped { break; }
        assert!(started.elapsed() < Duration::from_secs(3), "Owned probe tree still runs");
        thread::sleep(Duration::from_millis(10));
    }
    assert!(started.elapsed() < Duration::from_secs(3));
}
#[cfg(unix)]
#[test]
fn timed_out_probe_is_models_needed_failure_not_a_ready_or_unbounded_process() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let script = fixture.0.join("slow");
    fixture.script(&script, "/bin/sleep 30 & wait");
    let mut env = fixture.environment();
    env.timeout = Duration::from_millis(60);
    env.fixture_candidates = Some(vec![vec![script.into_os_string()]]);
    let started = Instant::now();
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(!status.ok && status.needs_models);
    assert!(started.elapsed() < Duration::from_secs(3));
}

#[cfg(all(unix, target_os = "macos"))]
#[test]
fn intel_pack_shared_with_arm_host_still_requires_embedded_onnx_weights() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    fixture.pack(&config, "exit 0");
    fs::write(
        config.pack.join("python/pack.json"),
        br#"{"formatVersion":6,"target":"darwin-x64"}"#,
    )
    .unwrap();
    assert!(onnx_pack(&config));
    assert!(!validated_pack(&config));
    let path = config
        .pack
        .join("python/model-cache/models--StemSplitio--htdemucs-6s-onnx/snapshots/fixture");
    fs::create_dir_all(&path).unwrap();
    fs::write(
        path.join("htdemucs_6s_fp16weights.onnx"),
        b"fixture ONNX weights",
    )
    .unwrap();
    assert!(validated_pack(&config));
}

#[test]
fn system_engine_is_always_offline() {
    let engine = ResolvedEngine::System {
        argv: vec!["demucs".into()],
        path: "".into(),
    };
    let fixture = Fixture::new();
    for command in [engine.system_command().unwrap(), pack_command(&fixture.config(Flavor::AppleSilicon)), offline_engine_command("llama-server"), offline_engine_command("crispasr")] {
        assert_eq!(
            command.get_envs().find(|(k, _)| *k == "HF_HUB_OFFLINE").and_then(|(_, v)| v),
            Some(std::ffi::OsStr::new("1"))
        );
    }
}

#[test]
fn linux_uses_electron_pack_format() {
    assert_eq!(Flavor::Linux.pack_format(), 10);
}

#[test]
fn shipped_and_developer_engine_candidates_are_platform_specific() {
    for (exe_dir, windows, expected, file) in [
        (
            "/SingZ.app/Contents/MacOS",
            false,
            "/SingZ.app/Contents/MacOS/../Resources/engines/llama-server",
            "llama-server",
        ),
        (
            "/install",
            true,
            "/install/engines/llama-server.exe",
            "llama-server.exe",
        ),
    ] {
        let vendor = Path::new("/checkout/vendor/target");
        let shipped = engine_candidates(Path::new(exe_dir), "llama-server", windows, None);
        assert!(shipped.contains(&PathBuf::from(expected)));
        assert!(!shipped.iter().any(|p| p.starts_with(vendor)));
        let development =
            engine_candidates(Path::new(exe_dir), "llama-server", windows, Some(vendor));
        assert!(development.contains(&vendor.join(file)));
    }
    let fixture = Fixture::new();
    for (windows, exe_suffix, bundled_suffix) in [(false, "SingZ.app/Contents/MacOS", "../Resources/engines/llama-server"), (true, "install", "engines/llama-server.exe")] {
        let exe = fixture.0.join(exe_suffix);
        let vendor = fixture.0.join("vendor");
        fs::create_dir_all(&exe).unwrap();
        fs::create_dir_all(&vendor).unwrap();
        let file = if windows { "llama-server.exe" } else { "llama-server" };
        fs::write(vendor.join(file), b"developer").unwrap();
        assert!(choose_engine(engine_candidates(&exe, "llama-server", windows, None)).is_none());
        assert_eq!(choose_engine(engine_candidates(&exe, "llama-server", windows, Some(&vendor))), Some(vendor.join(file)));
        let bundled = exe.join(bundled_suffix);
        fs::create_dir_all(bundled.parent().unwrap()).unwrap();
        fs::write(&bundled, b"shipped").unwrap();
        assert_eq!(choose_engine(engine_candidates(&exe, "llama-server", windows, None)), Some(bundled));
    }
}

#[cfg(unix)]
#[test]
fn incompatible_pack_never_starts() {
    let fixture = Fixture::new();
    let config = fixture.config(Flavor::AppleSilicon);
    let called = fixture.0.join("called");
    fixture.pack(
        &config,
        &format!("printf called > '{}'; exit 0", called.display()),
    );
    fs::write(
        config.pack.join("python/pack.json"),
        b"{\"formatVersion\":5}",
    )
    .unwrap();
    assert!(!crate::model_install::pack_format_compatible(
        &config,
        &config.pack
    ));
    let mut env = fixture.environment();
    env.no_system = true;
    let status = discover_in(&config, &env, &AtomicU64::new(1), 1).unwrap();
    assert!(!status.ok);
    assert_eq!(status.message, Some(crate::i18n::t("main.error.splitterPackIncompatible")));
    assert!(!called.exists());
}

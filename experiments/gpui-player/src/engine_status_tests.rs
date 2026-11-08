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
    fixture.script(&script, "/bin/sleep 30 & wait");
    let mut env = fixture.environment();
    env.timeout = Duration::from_secs(40);
    env.fixture_candidates = Some(vec![vec![script.into_os_string()]]);
    let serial = Arc::new(AtomicU64::new(1));
    let cancel = serial.clone();
    let thread = thread::spawn(move || {
        thread::sleep(Duration::from_millis(80));
        cancel.store(2, Ordering::Release);
    });
    let started = Instant::now();
    assert!(discover_in(&config, &env, &serial, 1).is_err());
    thread.join().unwrap();
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

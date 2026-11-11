//! Source-faithful splitter discovery, shared by setup and actual separation.
//! Probes execute directly, never via a shell and never install packages/models.
use crate::{
    model_catalog::{Config, Flavor},
    model_install::{cancelled, command_observe},
};
use anyhow::{Context, Result, ensure};
use serde::Serialize;
use std::{
    ffi::{OsStr, OsString},
    fs::File,
    io::Read,
    path::{Path, PathBuf},
    process::Command,
    sync::atomic::AtomicU64,
    time::Duration,
};
// The package layout is independent of the machine performing the lookup.
fn engine_candidates(
    exe_dir: &Path,
    name: &str,
    windows: bool,
    developer: Option<&Path>,
) -> Vec<PathBuf> {
    let file = if windows {
        format!("{name}.exe")
    } else {
        name.to_owned()
    };
    let mut candidates = vec![exe_dir.join("engines").join(&file)];
    if !windows {
        candidates.push(exe_dir.join("../Resources/engines").join(&file));
    }
    if let Some(vendor) = developer {
        candidates.push(exe_dir.join(&file));
        candidates.push(vendor.join(&file));
    }
    candidates
}
fn choose_engine(candidates: Vec<PathBuf>) -> Option<PathBuf> {
    candidates
        .into_iter()
        .find(|p| p.metadata().is_ok_and(|m| m.is_file() && m.len() > 0))
}
pub fn resolve_bundled_engine(override_path: Option<OsString>, name: &str) -> Option<PathBuf> {
    let regular = |path: &Path| path.metadata().is_ok_and(|m| m.is_file() && m.len() > 0);
    if let Some(path) = override_path.map(PathBuf::from) {
        return regular(&path).then_some(path);
    }
    let exe = std::env::current_exe().ok()?;
    let dir = exe.parent()?;
    #[cfg(any(debug_assertions, feature = "ui-tests"))]
    let developer = {
        let platform = if cfg!(windows) {
            "win32"
        } else if cfg!(target_os = "macos") {
            "darwin"
        } else {
            "linux"
        };
        let arch = if cfg!(target_arch = "aarch64") {
            "arm64"
        } else {
            "x64"
        };
        Some(
            PathBuf::from(env!("CARGO_MANIFEST_DIR"))
                .join("../../vendor")
                .join(format!("{platform}-{arch}")),
        )
    };
    #[cfg(not(any(debug_assertions, feature = "ui-tests")))]
    let developer: Option<PathBuf> = None;
    choose_engine(engine_candidates(
        dir, name, cfg!(windows), developer.as_deref(),
    ))
}
pub fn offline_engine_command(program: impl AsRef<OsStr>) -> Command {
    let mut command = Command::new(program);
    command.env("HF_HUB_OFFLINE", "1");
    command
}
pub const ONNX_SHIM: &str = "import sys; from demucs_onnx.cli import main; sys.exit(main())";
#[derive(Clone, Debug)]
pub enum ResolvedEngine {
    System { argv: Vec<OsString>, path: OsString },
    Pack { onnx: bool },
}
impl ResolvedEngine {
    pub fn needs_pcm(&self) -> bool {
        matches!(self, Self::Pack { .. })
    }
    pub fn system_command(&self) -> Option<Command> {
        let Self::System { argv, path } = self else {
            return None;
        };
        let mut command = offline_engine_command(argv.first()?);
        command.args(&argv[1..]).env("PATH", path);
        Some(command)
    }
}
#[derive(Clone, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub ok: bool,
    pub command: Option<String>,
    pub needs_models: bool,
    pub needs_pcm: bool,
    pub message: Option<String>,
    #[serde(skip)]
    pub resolved: Option<ResolvedEngine>,
}
impl Default for EngineStatus {
    fn default() -> Self {
        Self {
            ok: false,
            command: None,
            needs_models: true,
            needs_pcm: false,
            message: Some(crate::i18n::t("main.error.splitterNotDownloaded")),
            resolved: None,
        }
    }
}
#[derive(Clone, Copy)]
enum Platform {
    Mac,
    Windows,
    Other,
}
impl Platform {
    fn host() -> Self {
        if cfg!(target_os = "macos") {
            Self::Mac
        } else if cfg!(windows) {
            Self::Windows
        } else {
            Self::Other
        }
    }
}
struct Environment {
    home: PathBuf,
    path: OsString,
    override_command: Option<String>,
    no_system: bool,
    platform: Platform,
    timeout: Duration,
    fixture_candidates: Option<Vec<Vec<OsString>>>,
}
impl Environment {
    fn source() -> Result<Self> {
        let home = PathBuf::from(
            std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" })
                .unwrap_or_default(),
        );
        let mut environment = Self {
            home,
            path: std::env::var_os("PATH").unwrap_or_default(),
            override_command: std::env::var("SINGZ_DEMUCS").ok(),
            no_system: std::env::var_os("SINGZ_NO_SYSTEM_ENGINES").is_some_and(|v| !v.is_empty()),
            platform: Platform::host(),
            timeout: Duration::from_secs(45),
            fixture_candidates: None,
        };
        #[cfg(feature = "ui-tests")]
        if let Some(path) = std::env::var_os("SINGZ_GPUI_ENGINE_CANDIDATES") {
            ensure!(
                std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                    && std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                    && std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some(),
                "Engine candidate fixture requires isolated hidden/muted UI"
            );
            let path = PathBuf::from(path);
            ensure!(
                path.is_absolute(),
                "Engine candidate fixture must be absolute"
            );
            let metadata = std::fs::symlink_metadata(&path)?;
            ensure!(
                metadata.file_type().is_file() && metadata.len() <= 65536,
                "Engine candidate fixture must be ordinary and bounded"
            );
            let mut bytes = vec![];
            File::open(path)?.take(65537).read_to_end(&mut bytes)?;
            ensure!(
                bytes.len() <= 65536,
                "Engine candidate fixture exceeds limit"
            );
            let commands: Vec<Vec<String>> = serde_json::from_slice(&bytes)?;
            ensure!(
                commands.len() <= 32
                    && commands.iter().all(|cmd| !cmd.is_empty()
                        && cmd.len() <= 32
                        && cmd
                            .iter()
                            .all(|arg| !arg.contains('\0') && arg.len() <= 8192)
                        && !cmd[0].is_empty()),
                "Invalid engine fixture arguments"
            );
            environment.fixture_candidates = Some(
                commands
                    .into_iter()
                    .map(|args| args.into_iter().map(OsString::from).collect())
                    .collect(),
            );
        }
        Ok(environment)
    }
    fn expanded_path(&self) -> Result<OsString> {
        let mut paths: Vec<_> = if self.path.is_empty() {
            vec![]
        } else {
            std::env::split_paths(&self.path).collect()
        };
        paths.extend([
            self.home.join(".local/bin"),
            PathBuf::from("/opt/homebrew/bin"),
            PathBuf::from("/usr/local/bin"),
        ]);
        std::env::join_paths(paths).context("Cannot expand GUI engine PATH")
    }
    fn candidates(&self) -> Vec<Vec<OsString>> {
        if let Some(commands) = &self.fixture_candidates {
            return commands.clone();
        }
        let mut result = vec![];
        if let Some(command) = &self.override_command {
            let args: Vec<_> = command
                .split(' ')
                .filter(|arg| !arg.is_empty())
                .map(OsString::from)
                .collect();
            if !args.is_empty() {
                result.push(args);
            }
        }
        result.push(vec!["demucs".into()]);
        result.push(vec![self.home.join(".local/bin/demucs").into_os_string()]);
        if matches!(self.platform, Platform::Mac) {
            result.push(vec!["/opt/homebrew/bin/demucs".into()]);
            result.push(vec!["/usr/local/bin/demucs".into()]);
        }
        result.extend([
            vec!["python3".into(), "-m".into(), "demucs".into()],
            vec!["python".into(), "-m".into(), "demucs".into()],
        ]);
        if matches!(self.platform, Platform::Windows) {
            result.push(vec!["py".into(), "-m".into(), "demucs".into()]);
        }
        result
    }
}
pub fn pack_python(config: &Config) -> PathBuf {
    config.pack.join(if config.flavor == Flavor::Windows {
        "python/python.exe"
    } else {
        "python/bin/python3"
    })
}
pub fn pack_command(config: &Config) -> Command {
    let mut command = offline_engine_command(pack_python(config));
    command
        .env("PYTHONUNBUFFERED", "1")
        .env("PYTHONUTF8", "1")
        .env("PYTHONDONTWRITEBYTECODE", "1")
        .env("HF_HUB_OFFLINE", "1")
        .env("TORCH_HOME", config.pack.join("python/torch-home"))
        .env("HF_HOME", config.pack.join("python/hf-home"));
    command
}
pub fn onnx_pack(config: &Config) -> bool {
    if matches!(config.flavor, Flavor::Windows | Flavor::IntelMac) {
        return true;
    }
    if !cfg!(target_os = "macos") {
        return false;
    }
    let path = config.pack.join("python/pack.json");
    let result = (|| -> Result<bool> {
        let meta = std::fs::symlink_metadata(&path)?;
        ensure!(
            meta.file_type().is_file() && meta.len() <= 65536,
            "Invalid pack descriptor"
        );
        let mut bytes = vec![];
        File::open(path)?.take(65537).read_to_end(&mut bytes)?;
        ensure!(bytes.len() <= 65536, "Pack descriptor exceeds limit");
        let raw: serde_json::Value = serde_json::from_slice(&bytes)?;
        Ok(raw["target"] == "darwin-x64")
    })();
    result.unwrap_or(false)
}
pub fn validated_pack(config: &Config) -> bool {
    if !crate::model_install::pack_complete(config, &config.pack) {
        return false;
    }
    // An Intel pack shared with an ARM app still needs its actual embedded
    // ONNX weights, rather than merely the ARM pack's interpreter/UVR marker.
    if onnx_pack(config) && config.flavor == Flavor::AppleSilicon {
        let mut actual = config.clone();
        actual.flavor = Flavor::IntelMac;
        return crate::model_install::pack_complete(&actual, &config.pack);
    }
    true
}
fn described_pack(config: &Config, onnx: bool) -> String {
    if !onnx {
        return format!("{} -m demucs", pack_python(config).display());
    }
    if config.flavor != Flavor::Windows {
        return "splitter pack (ONNX)".into();
    }
    if !config
        .pack
        .join("python/rtx/ep/onnxruntime_providers_nv_tensorrt_rtx.dll")
        .is_file()
    {
        return "splitter pack (CPU — this pack has no GPU engine, update it in the model manager)"
            .into();
    }
    if config
        .pack
        .parent()
        .is_some_and(|p| p.join("trtrtx-disabled.json").exists())
    {
        "splitter pack (CPU — the GPU engine is switched off here)".into()
    } else {
        "splitter pack (TensorRT RTX)".into()
    }
}
fn probe(
    mut command: Command,
    path: &OsStr,
    serial: &AtomicU64,
    id: u64,
    timeout: Duration,
) -> Result<()> {
    command.arg("--help").env("PATH", path);
    command_observe(command, serial, id, timeout, || Ok(()), |_, _| Ok(())).map(|_| ())
}
pub fn discover(config: &Config, serial: &AtomicU64, id: u64) -> Result<EngineStatus> {
    discover_in(config, &Environment::source()?, serial, id)
}
fn discover_in(
    config: &Config,
    environment: &Environment,
    serial: &AtomicU64,
    id: u64,
) -> Result<EngineStatus> {
    cancelled(serial, id)?;
    let path = environment.expanded_path()?;
    if !environment.no_system {
        for argv in environment.candidates() {
            cancelled(serial, id)?;
            let resolved = ResolvedEngine::System {
                argv: argv.clone(),
                path: path.clone(),
            };
            match probe(
                resolved.system_command().unwrap(),
                &path,
                serial,
                id,
                environment.timeout,
            ) {
                Ok(()) => {
                    crate::diagnostics::event(
                        "splitter",
                        format!(
                            "Using system Demucs: {}",
                            argv.iter()
                                .map(|a| a.to_string_lossy())
                                .collect::<Vec<_>>()
                                .join(" ")
                        ),
                        crate::diagnostics::Level::Info,
                    );
                    return Ok(EngineStatus {
                        ok: true,
                        command: Some(
                            argv.iter()
                                .map(|arg| arg.to_string_lossy())
                                .collect::<Vec<_>>()
                                .join(" "),
                        ),
                        needs_models: false,
                        needs_pcm: false,
                        message: None,
                        resolved: Some(resolved),
                    });
                }
                Err(error) => {
                    cancelled(serial, id)?;
                    eprintln!(
                        "Splitter candidate {} could not start: {error:#}",
                        argv[0].to_string_lossy()
                    );
                }
            }
        }
    }
    cancelled(serial, id)?;
    if validated_pack(config) {
        let onnx = onnx_pack(config);
        let mut command = pack_command(config);
        if onnx {
            command.args(["-c", ONNX_SHIM]);
        } else {
            command.args(["-m", "demucs"]);
        }
        match probe(command, &path, serial, id, environment.timeout) {
            Ok(()) => {
                crate::diagnostics::event(
                    "splitter",
                    format!("Using {}", described_pack(config, onnx)),
                    crate::diagnostics::Level::Info,
                );
                return Ok(EngineStatus {
                    ok: true,
                    command: Some(described_pack(config, onnx)),
                    needs_models: false,
                    needs_pcm: true,
                    message: None,
                    resolved: Some(ResolvedEngine::Pack { onnx }),
                });
            }
            Err(error) => {
                cancelled(serial, id)?;
                eprintln!("Splitter pack could not start; reinstall it in AI models: {error:#}");
                crate::diagnostics::event(
                    "splitter",
                    format!("Splitter pack could not start; reinstall it in AI models: {error:#}"),
                    crate::diagnostics::Level::Warn,
                );
            }
        }
    }
    cancelled(serial, id)?;
    if (pack_python(config).exists() || config.pack.join("python/pack.json").exists())
        && !crate::model_install::pack_format_compatible(config, &config.pack)
    {
        crate::diagnostics::event(
            "splitter",
            format!("Installed splitter pack format is incompatible; this build requires version {}", config.flavor.pack_format()),
            crate::diagnostics::Level::Warn,
        );
        return Ok(EngineStatus {
            message: Some(crate::i18n::t("main.error.splitterPackIncompatible")),
            ..EngineStatus::default()
        });
    }
    crate::diagnostics::event(
        "splitter",
        "No usable stem splitter found; download a splitter pack or finish engine setup",
        crate::diagnostics::Level::Warn,
    );
    Ok(EngineStatus::default())
}
#[cfg(test)]
#[path = "engine_status_tests.rs"]
mod tests;

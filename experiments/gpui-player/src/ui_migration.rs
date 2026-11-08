//! Hidden released-model installation followed by the existing real source flow.
//! This qualifies a fresh model cache, not a newly provisioned operating system.
use super::ui_training_run::{click, draw};
use super::*;
use anyhow::Context as _;
use std::{path::PathBuf, time::Duration};

fn required_path(name: &str) -> anyhow::Result<PathBuf> {
    let path = PathBuf::from(std::env::var_os(name).with_context(|| format!("Missing {name}"))?);
    anyhow::ensure!(path.is_absolute(), "{name} must be absolute");
    Ok(path)
}

pub(super) fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some()
                && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"), "Migration requires hidden/muted UI");
            anyhow::ensure!(!integration::fixture_mode(), "Migration requires the real native backend");
            anyhow::ensure!(std::env::var("SINGZ_NO_SYSTEM_ENGINES").as_deref() == Ok("1"),
                "Migration must use the downloaded pack, not an existing system engine");
            for name in ["SINGZ_GPUI_MODEL_FIXTURE", "SINGZ_GPUI_MODEL_CONTROL", "SINGZ_GPUI_SOURCE_CONTROL",
                "SINGZ_GPU_PACK_URL", "SINGZ_DEMUCS", "SINGZ_GPUI_ENGINE_CANDIDATES"] {
                anyhow::ensure!(std::env::var_os(name).is_none(), "Real model migration refuses {name}");
            }
            let config_dir = required_path("SINGZ_GPUI_CONFIG_DIR")?;
            let library = required_path("SINGZ_GPUI_PROJECTS_ROOT")?;
            let source = required_path("SINGZ_GPUI_SOURCE_FILE")?;
            anyhow::ensure!(source.is_file(), "Migration source audio is missing");
            let config = model_catalog::Config::source();
            config.validate()?;
            anyhow::ensure!(!config.fixture && !config.pack.exists(),
                "Migration requires an absent, private pack directory at startup");
            // Initial production cache recovery creates zero-byte lease files
            // before this async driver runs. They are bookkeeping, not models.
            if config.models.exists() {
                for file in std::fs::read_dir(&config.models)? {
                    let file = file?;
                    let metadata = file.path().symlink_metadata()?;
                    anyhow::ensure!(metadata.file_type().is_file() && metadata.len() == 0
                        && config.entries.iter().filter(|entry| !entry.archive).any(|entry|
                            file.file_name() == std::ffi::OsStr::new(&format!(".gpui-model-{}.lock", entry.id))),
                        "Migration model cache already contains payloads or unrelated files");
                }
            }
            anyhow::ensure!(config.pack != config_dir && config.models != config_dir
                && library != config_dir && library != config.pack && library != config.models,
                "Migration storage roots must be distinct");
            if library.exists() {
                anyhow::ensure!(std::fs::read_dir(&library)?.next().is_none(), "Migration library must be empty");
            }
            let entry = config.entries.iter().find(|entry| entry.id == "gpu-splitter")
                .context("This host has no released splitter pack in the production registry")?;
            let expected_target = match config.flavor {
                model_catalog::Flavor::AppleSilicon => "darwin-arm64",
                model_catalog::Flavor::IntelMac => "darwin-x64",
                model_catalog::Flavor::Windows => "win32-x64",
                model_catalog::Flavor::Linux => anyhow::bail!("No released Linux splitter pack"),
            };
            let version: serde_json::Value = serde_json::from_str(include_str!("../../../package.json"))?;
            let expected_url = format!("https://github.com/lexasoft123/SingZ/releases/download/v{}/gpu-splitter-{expected_target}.tar.gz",
                version["version"].as_str().context("Missing packaged release version")?);
            anyhow::ensure!(entry.archive && entry.parts.len() == 1 && entry.parts[0].url == expected_url,
                "Migration must install the released host registry artifact");
            std::fs::create_dir_all(&out)?;

            // Wait for the ordinary model worker to finish its initial cache scan.
            let deadline = Instant::now() + Duration::from_secs(30);
            loop {
                cx.background_executor().timer(Duration::from_millis(40)).await;
                let loaded = handle.update(cx, |_, window, cx| -> anyhow::Result<bool> {
                    anyhow::ensure!(!window.is_visible() && !window.is_window_active(), "Migration activated its window");
                    let p = view.read(cx);
                    let snapshot = p.model_service.as_ref().context("Missing native model worker")?.snapshot();
                    anyhow::ensure!(snapshot.error.is_none(), "Initial model scan failed: {:?}", snapshot.error);
                    if snapshot.loaded {
                        anyhow::ensure!(snapshot.rows.iter().any(|row| row.entry.id == "gpu-splitter" && !row.present),
                            "Splitter was already installed in the fresh model cache");
                    }
                    Ok(snapshot.loaded)
                })??;
                if loaded { break; }
                anyhow::ensure!(Instant::now() < deadline, "Initial model scan timed out");
            }
            // The actual Get button emits the production Models Download event.
            handle.update(cx, |_, window, cx| {
                window.resize(size(px(1280.), px(800.)));
                view.update(cx, |p, cx| p.open_models(models::Origin::Manual, cx));
                draw(window, cx);
            })?;
            cx.background_executor().timer(Duration::from_millis(100)).await;
            handle.update(cx, |_, window, cx| -> anyhow::Result<()> {
                draw(window, cx);
                let bounds = view.read(cx).models.read(cx).bounds("model-get-gpu-splitter")
                    .context("Released splitter Get button was not laid out")?;
                anyhow::ensure!(bounds.top() >= px(45.) && bounds.bottom() <= window.viewport_size().height - px(35.),
                    "Splitter Get button is outside the viewport");
                click(window, cx, bounds.center());
                Ok(())
            })??;
            let deadline = Instant::now() + Duration::from_secs(900);
            let mut download_observed = false;
            let mut last_progress = -1;
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let snapshot = handle.update(cx, |_, _, cx| {
                    view.read(cx).model_service.as_ref().unwrap().snapshot()
                })?;
                download_observed |= snapshot.busy || snapshot.running.iter().any(|id| id == "gpu-splitter");
                anyhow::ensure!(snapshot.error.is_none(), "Released model installation failed: {:?}", snapshot.error);
                let progress = snapshot.progress.get("gpu-splitter").copied().unwrap_or(0.) as i32;
                if progress / 10 != last_progress {
                    last_progress = progress / 10;
                    eprintln!("MIGRATION_MODELS released pack progress {progress}%");
                }
                if !snapshot.busy && snapshot.rows.iter().any(|row| row.entry.id == "gpu-splitter" && row.present) { break; }
                anyhow::ensure!(Instant::now() < deadline, "Released model installation timed out");
            }
            anyhow::ensure!(download_observed && model_install::pack_complete(&config, &config.pack),
                "Released pack did not complete through the real download worker");
            let descriptor = config.pack.join("python/pack.json");
            anyhow::ensure!(descriptor.metadata()?.len() <= 65536, "Pack descriptor exceeds limit");
            let installed: serde_json::Value = serde_json::from_slice(&std::fs::read(&descriptor)?)?;
            anyhow::ensure!(installed["target"] == expected_target, "Installed pack has a different target");

            // Refresh readiness through the same engine setup Recheck event a
            // user invokes, then require acceptance of the downloaded Pack route.
            let recheck_started = Instant::now();
            handle.update(cx, |_, _, cx| {
                let models = view.read(cx).models.clone();
                models.update(cx, |_, cx| cx.emit(models::Event::Close));
            })?;
            handle.update(cx, |_, _, cx| {
                view.update(cx, |p, cx| p.open_engine_setup(cx));
                let setup = view.read(cx).engine_setup.clone();
                setup.update(cx, |_, cx| cx.emit(engine_setup::Event::Recheck));
            })?;
            let deadline = Instant::now() + Duration::from_secs(120);
            loop {
                cx.background_executor().timer(Duration::from_millis(100)).await;
                let ready = handle.update(cx, |_, _, cx| -> anyhow::Result<bool> {
                    let p = view.read(cx);
                    anyhow::ensure!(p.notice.is_none(), "Engine setup failed: {:?}", p.notice);
                    Ok(p.engine_setup_check.is_none()
                        && p.engine_status_started.is_some_and(|at| at >= recheck_started)
                        && p.engine_status.as_ref().is_some_and(|status| status.ok
                            && matches!(status.resolved.as_ref(), Some(engine_status::ResolvedEngine::Pack { .. })))
                        && p.source_service.as_ref().is_some_and(|service| {
                            let source = service.snapshot();
                            source.ready && source.engine_status.ok
                                && matches!(source.engine_status.resolved.as_ref(), Some(engine_status::ResolvedEngine::Pack { .. }))
                        }))
                })??;
                if ready { break; }
                anyhow::ensure!(Instant::now() < deadline, "Downloaded pack never became the accepted ready engine");
            }
            std::fs::write(out.join("migration-models.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "scope":"fresh model cache with existing native app/helper runtime",
                "freshModels":true,"releasedHostPack":true,"fixtureModels":false,
                "installed":true,"engineReady":true,"resolvedEngine":"pack",
                "modelId":"gpu-splitter","target":expected_target,"urls":[expected_url],
                "packDirectory":config.pack,"modelsDirectory":config.models,
                "configDirectory":config_dir,"libraryDirectory":library,
                "downloadObserved":download_observed,"hidden":true,"muted":true
            }))?)?;
            eprintln!("MIGRATION_MODELS released pack accepted; handing off real split/Save/reopen");
            cx.update(|cx| ui_source::run(handle, view.clone(), out.clone(), cx));
            Ok(())
        }.await;
        if let Err(error) = result {
            eprintln!("MIGRATION_MODELS failed: {error:#}");
            let _ = std::fs::create_dir_all(&out);
            let _ = std::fs::write(out.join("migration-error.txt"), format!("{error:#}\n"));
            let _ = cx.update(|cx| cx.quit());
        }
    }).detach();
}

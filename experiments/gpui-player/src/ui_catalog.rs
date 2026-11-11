//! Opt-in hidden catalog refresh and keyboard journey over an owned fixture library.
use super::*;
use std::{path::{Path, PathBuf}, sync::mpsc, time::Duration};

fn key(w: &mut Window, cx: &mut App, value: &'static str) {
    w.dispatch_event(PlatformInput::KeyDown(KeyDownEvent {
        keystroke: Keystroke::parse(value).unwrap(), is_held: false,
        prefer_character_input: false,
    }), cx);
}
fn catalog(view: &Entity<Player>, cx: &mut App) {
    view.read(cx).header.clone().update(cx, |_, cx| cx.emit(header::HeaderEvent::Catalog));
}
fn contains(p: &Player, cx: &App, path: &Path) -> bool {
    p.library.read(cx).project_snapshot().as_array().is_some_and(|rows|
        rows.iter().any(|row| row["dir"].as_str().is_some_and(|s| Path::new(s) == path)))
}
fn search(w: &mut Window, cx: &mut App, value: &str) {
    w.dispatch_keystroke(Keystroke::parse(if cfg!(target_os="macos") {"cmd-a"} else {"ctrl-a"}).unwrap(), cx);
    w.dispatch_keystroke(Keystroke::parse("backspace").unwrap(), cx);
    for ch in value.chars() {
        w.dispatch_keystroke(Keystroke {
            key: ch.to_string(), key_char: Some(ch.to_string()), ..Default::default()
        }, cx);
    }
}
fn copy_fixture(source: &Path, target: &Path) -> anyhow::Result<()> {
    fn copy_tree(source: &Path, target: &Path, depth: usize, count: &mut usize,
        total: &mut u64) -> anyhow::Result<()> {
        anyhow::ensure!(depth <= 8, "Catalog fixture tree is too deep");
        let directory = std::fs::symlink_metadata(source)?;
        anyhow::ensure!(directory.is_dir() && !directory.file_type().is_symlink(),
            "Catalog fixture directory must be ordinary: {}", source.display());
        // Exclusive creation prevents retries from changing an existing sibling.
        std::fs::create_dir(target)?;
        for entry in std::fs::read_dir(source)? {
            *count += 1;
            anyhow::ensure!(*count <= 256, "Catalog fixture has too many entries");
            let entry = entry?;
            let path = entry.path();
            let destination = target.join(entry.file_name());
            let metadata = std::fs::symlink_metadata(&path)?;
            anyhow::ensure!(!metadata.file_type().is_symlink(),
                "Catalog fixture must not contain links: {}", path.display());
            if metadata.is_dir() {
                copy_tree(&path, &destination, depth + 1, count, total)?;
            } else {
                anyhow::ensure!(metadata.is_file(), "Catalog fixture file must be ordinary: {}", path.display());
                *total = total.checked_add(metadata.len()).ok_or_else(|| anyhow::anyhow!("Fixture size overflow"))?;
                anyhow::ensure!(*total <= 1024 * 1024 * 1024, "Catalog fixture exceeds 1 GiB");
                let mut options = std::fs::OpenOptions::new();
                options.read(true);
                #[cfg(unix)] {
                    use std::os::unix::fs::OpenOptionsExt;
                    options.custom_flags(libc::O_NOFOLLOW);
                }
                #[cfg(windows)] {
                    use std::os::windows::fs::OpenOptionsExt;
                    options.custom_flags(0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
                }
                let file = options.open(&path)?;
                let opened = file.metadata()?;
                anyhow::ensure!(opened.is_file() && !opened.file_type().is_symlink()
                    && opened.len() == metadata.len(), "Catalog fixture changed while opening");
                let mut output = std::fs::OpenOptions::new().write(true).create_new(true).open(destination)?;
                let copied = std::io::copy(&mut std::io::Read::take(file, metadata.len() + 1), &mut output)?;
                anyhow::ensure!(copied == metadata.len(), "Catalog fixture changed while copying");
            }
        }
        Ok(())
    }
    let mut count = 0;
    let mut total = 0;
    copy_tree(source, target, 0, &mut count, &mut total)?;
    anyhow::ensure!((target.join("stems/vocals.wav").is_file() || target.join("vocals.wav").is_file())
        && target.join("project.json").is_file(), "Catalog fixture requires vocals audio and project.json");
    let path = target.join("project.json");
    let mut metadata: serde_json::Value = serde_json::from_slice(&std::fs::read(&path)?)?;
    metadata["name"] = "External catalog fixture".into();
    std::fs::write(path, serde_json::to_vec_pretty(&metadata)?)?;
    Ok(())
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, project: PathBuf,
    out: PathBuf, cx: &mut App) -> mpsc::Receiver<Result<(), String>> {
    let (tx, rx) = mpsc::channel();
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            anyhow::ensure!(std::env::var("SINGZ_MUTE").as_deref() == Ok("1")
                && std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some(), "Catalog test must be hidden and muted");
            std::fs::create_dir_all(&out)?;
            let project = project.canonicalize()?;
            let library = project.parent().ok_or_else(|| anyhow::anyhow!("Missing fixture library"))?.to_path_buf();
            let declared = PathBuf::from(std::env::var_os("SINGZ_GPUI_PROJECTS_ROOT")
                .ok_or_else(|| anyhow::anyhow!("Catalog test requires an explicit private SINGZ_GPUI_PROJECTS_ROOT"))?).canonicalize()?;
            anyhow::ensure!(library == declared, "Catalog fixture is outside the explicit private library");
            let external = library.join("External catalog fixture");
            let renamed = library.join("External catalog renamed");
            anyhow::ensure!(!external.try_exists()? && !renamed.try_exists()?, "Catalog fixture sibling already exists");
            macro_rules! wait {($p:ident,$w:ident,$app:ident => $condition:expr) => {{
                let deadline = Instant::now() + Duration::from_secs(20);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    let ready = handle.update(cx, |_, $w, $app| -> anyhow::Result<bool> {
                        super::ui_training_run::draw($w,$app);
                        let $p = view.read($app);
                        anyhow::ensure!(!$w.is_visible() && !$w.is_window_active() && $p.notice.is_none(),
                            "Catalog test activated a window or raised a notice: {:?}", $p.notice);
                        Ok($condition)
                    })??;
                    if ready { break; }
                    if Instant::now() >= deadline {
                        let state=handle.update(cx,|_,w,app| {
                            let p=view.read(app);let library=p.library.read(app);
                            serde_json::json!({"focusedProject":library.focused_project(w),
                                "searchFocused":library.search_focused(w,app),
                                "catalog":library.review_snapshot(),"projects":library.project_snapshot()})
                        })?;
                        anyhow::bail!("Catalog timeout: {}: {state}",stringify!($condition));
                    }
                }
            }}; }
            macro_rules! reopen {() => {{
                let epoch = handle.update(cx, |_, _, cx| view.read(cx).native_epoch)?;
                handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(project.clone(), cx)))?;
                wait!(p,w,app => !p.loading && p.native_epoch > epoch && p.screen == Screen::Player
                    && p.project.as_ref().is_some_and(|s| s.dir == project) && !p.playing);
            }}; }
            macro_rules! open_catalog {() => {{
                handle.update(cx, |_, _, cx| catalog(&view, cx))?;
                wait!(p,w,app => p.screen == Screen::Library && !p.playing);
            }}; }
            macro_rules! query {($value:expr) => {{
                handle.update(cx, |_, w, cx| {
                    super::ui_training_run::draw(w, cx);
                    key(w, cx, if cfg!(target_os="macos") {"cmd-f"} else {"ctrl-f"});
                })?;
                wait!(p,w,app => p.library.read(app).search_focused(w, app));
                handle.update(cx, |_, w, cx| search(w, cx, $value))?;
                wait!(p,w,app => p.library.read(app).review_snapshot()["query"] == $value);
            }}; }
            macro_rules! focus_card {($path:expr) => {{
                handle.update(cx, |_, w, cx| {super::ui_training_run::draw(w,cx);key(w,cx,"tab");})?;
                wait!(p,w,app => p.library.read(app).focused_project(w) == Some(($path.clone(),false)));
            }}; }
            handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                let p = view.read(cx);
                anyhow::ensure!(p.backend.is_some() && p.catalog_root.canonicalize()? == library
                    && p.screen == Screen::Player && !p.playing
                    && p.project.as_ref().is_some_and(|s| s.dir == project), "Catalog baseline is not the private paused Player");
                Ok(())
            })??;
            // The copy happens after the initial catalog scan, outside the application.
            copy_fixture(&project, &external)?;
            open_catalog!();
            wait!(p,w,app => contains(p,app,&external));
            query!("External"); focus_card!(external);
            handle.update(cx,|_,w,cx|key(w,cx,"shift-tab"))?;
            wait!(p,w,app => p.library.read(app).search_focused(w,app));
            focus_card!(external);
            handle.update(cx, |_, w, cx| key(w,cx,"enter"))?;
            wait!(p,w,app => !p.loading && p.screen == Screen::Player
                && p.project.as_ref().is_some_and(|s|s.dir==external) && !p.playing);
            reopen!();
            // Rename while the catalog is closed: entry must rescan, rather than reuse rows.
            std::fs::rename(&external,&renamed)?;
            open_catalog!();
            wait!(p,w,app => contains(p,app,&renamed) && !contains(p,app,&external));
            for width in [1280.,1060.] {
                handle.update(cx,|_,w,_|w.resize(size(px(width),px(if width==1280. {800.} else {640.}))))?;
                wait!(p,w,app => w.viewport_size().width == px(width));
                query!("External"); focus_card!(renamed);
                handle.update(cx,|_,w,cx|{super::ui_training_run::draw(w,cx);key(w,cx,"tab");})?;
                wait!(p,w,app => p.library.read(app).focused_project(w)==Some((renamed.clone(),true)));
                handle.update(cx,|_,w,cx|key(w,cx,"enter"))?;
                wait!(p,w,app => p.delete_flight.delete_inspect.is_none() && p.project_delete.read(app).is_open());
                handle.update(cx,|_,w,cx|key(w,cx,"escape"))?;
                wait!(p,w,app => !p.project_delete.read(app).is_open());
                anyhow::ensure!(renamed.is_dir(),"Escape removed the catalog fixture");
                query!("External"); focus_card!(renamed);
                handle.update(cx,|_,w,cx|->anyhow::Result<()> {
                    super::ui_training_run::draw(w,cx);
                    let p = view.read(cx);
                    let viewport = w.viewport_size();
                    let scale = w.scale_factor();
                    anyhow::ensure!(viewport == size(px(width), px(if width == 1280. {800.} else {640.}))
                        && !w.is_visible() && !w.is_window_active(), "Catalog capture geometry/hidden state changed");
                    let image = w.render_to_image()?;
                    anyhow::ensure!(image.width() == (f32::from(viewport.width) * scale).round() as u32
                        && image.height() == (f32::from(viewport.height) * scale).round() as u32,
                        "Catalog raster does not match its viewport");
                    let name = format!("catalog-keyboard-{}", width as u32);
                    image.save(out.join(format!("{name}.png")))?;
                    std::fs::write(out.join(format!("{name}.json")), serde_json::to_vec_pretty(&serde_json::json!({
                        "viewport":[f32::from(viewport.width),f32::from(viewport.height)],"scale":scale,
                        "hidden":!w.is_visible()&&!w.is_window_active(),"muted":std::env::var("SINGZ_MUTE").as_deref()==Ok("1"),
                        "sourceProject":project,"library":library,"fixture":renamed,"fixtureExists":renamed.is_dir(),
                        "openedProject":p.project.as_ref().map(|s|&s.dir),"playing":p.playing,"position":p.playhead.position(),
                        "searchFocused":p.library.read(cx).search_focused(w,cx),
                        "focusedProject":p.library.read(cx).focused_project(w),
                        "catalog":p.library.read(cx).project_snapshot(),"search":p.library.read(cx).review_snapshot()["query"],
                        "scope":"hidden native catalog candidate; visual reference and frame cadence unqualified"
                    }))?)?;
                    Ok(())
                })??;
            }
            // Removal while Player is active must also be discovered on catalog entry.
            reopen!();
            std::fs::remove_dir_all(&renamed)?;
            open_catalog!();
            wait!(p,w,app => !contains(p,app,&renamed) && !contains(p,app,&external));
            handle.update(cx,|_,_,cx|catalog(&view,cx))?;
            wait!(p,w,app => p.screen==Screen::Player);
            copy_fixture(&project,&external)?;
            open_catalog!();
            wait!(p,w,app => contains(p,app,&external));
            query!("External"); focus_card!(external);
            // A real refresh must move focus away from a vanished focused card.
            std::fs::remove_dir_all(&external)?;
            handle.update(cx,|_,_,cx|view.read(cx).backend.as_ref().unwrap().catalog())?;
            wait!(p,w,app => !contains(p,app,&renamed) && !contains(p,app,&external)
                && p.library.read(app).focused_project(w).is_none() && p.library.read(app).search_focused(w,app));
            let refreshed = handle.update(cx,|_,_,cx|view.read(cx).library.read(cx).project_snapshot())?;
            reopen!();
            open_catalog!();
            wait!(p,w,app => !contains(p,app,&renamed) && !contains(p,app,&external));
            query!("");
            handle.update(cx,|_,_,cx|catalog(&view,cx))?;
            handle.update(cx,|_,w,_|w.resize(size(px(1280.),px(800.))))?;
            wait!(p,w,app => p.screen==Screen::Player && !p.playing && !p.loading && p.playhead.position().abs()<0.03
                && p.project.as_ref().is_some_and(|s|s.dir==project) && w.viewport_size()==size(px(1280.),px(800.)));
            anyhow::ensure!(!external.try_exists()? && !renamed.try_exists()?,"Catalog fixture was not cleaned up");
            std::fs::write(out.join("catalog.json"),serde_json::to_vec_pretty(&serde_json::json!({
                "externalCreationRescanned":true,"searchShortcut":true,"actualKeyboardOpen":true,
                "externalRenameRescanned":true,"keyboardDeleteConfirmation":true,"escapePreservesProject":true,
                "vanishedFocusedCardFallsBackToSearch":true,"externalRemovalRescanned":true,
                "sizes":[[1280,800],[1060,640]],"hidden":true,"muted":true,"restoredBaseline":true,
                "project":project,"finalProjects":refreshed,
                "scope":"real backend catalog scans; Header production event; app-local search, Tab, Enter and Escape; no physical keyboard or visual parity qualification"
            }))?)?;
            Ok(())
        }.await;
        let _ = tx.send(result.map_err(|error|format!("{error:#}")));
    }).detach();
    rx
}

//! Native window creation is shared by startup and macOS Dock reopen.
use super::*;
use desktop_window_state::{Bounds as SavedBounds, DisplaySnapshot, StateStore, WindowSnapshot};
use std::sync::atomic::{AtomicBool, Ordering};

static STARTUP_CONSUMED: AtomicBool = AtomicBool::new(false);

pub(super) fn startup_args() -> std::vec::IntoIter<std::ffi::OsString> {
    if STARTUP_CONSUMED.swap(true, Ordering::Relaxed) {
        Vec::new().into_iter()
    } else {
        std::env::args_os().skip(1).collect::<Vec<_>>().into_iter()
    }
}

#[derive(Default)]
struct DesktopWindow(Option<WeakEntity<Player>>);
impl Global for DesktopWindow {}

actions!(desktop, [DesktopSettings, DesktopClose, DesktopQuit]);

pub(super) fn install_actions(cx: &mut App) {
    cx.set_global(DesktopWindow::default());
    cx.on_action(|_: &DesktopQuit, cx| cx.quit());
    cx.on_action(|_: &DesktopSettings, cx| {
        if let Some(view) = cx.global::<DesktopWindow>().0.clone() {
            // Global actions also run inside a window's input dispatch. Reenter
            // that window only after GPUI has returned it to the application.
            cx.defer(move |cx| {
                let _ = view.update_in(cx, |view, window, cx| {
                    view.open_desktop_settings(window, cx)
                });
            });
        }
    });
    cx.on_action(|_: &DesktopClose, cx| {
        if let Some(view) = cx.global::<DesktopWindow>().0.clone() {
            cx.defer(move |cx| {
                let _ = view.update_in(cx, |_, window, _| window.remove_window());
            });
        }
    });
    #[cfg(target_os = "macos")]
    {
        cx.bind_keys([
            KeyBinding::new("cmd-q", DesktopQuit, None),
            KeyBinding::new("cmd-w", DesktopClose, None),
            KeyBinding::new("cmd-,", DesktopSettings, None),
        ]);
        install_menus(cx);
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn install_menus(_: &mut App) {}

/// The macOS application menu in the current UI language. The locale arrives
/// after startup, so the caller that applies a locale change must call this
/// again; `set_menus` replaces the whole bar.
#[cfg(target_os = "macos")]
pub(super) fn install_menus(cx: &mut App) {
    use crate::i18n::t;
    cx.set_menus([
        Menu::new("SingZ").items([
            MenuItem::action(t("main.menu.settings"), DesktopSettings),
            MenuItem::separator(),
            MenuItem::os_submenu("Services", SystemMenuType::Services),
            MenuItem::separator(),
            MenuItem::action(t("main.menu.quit"), DesktopQuit),
        ]),
        Menu::new(t("main.menu.window"))
            .items([MenuItem::action(t("main.menu.closeWindow"), DesktopClose)]),
    ]);
}

fn saved(bounds: Bounds<Pixels>) -> SavedBounds {
    SavedBounds {
        x: f32::from(bounds.origin.x) as f64,
        y: f32::from(bounds.origin.y) as f64,
        width: f32::from(bounds.size.width) as f64,
        height: f32::from(bounds.size.height) as f64,
    }
}

pub(super) fn observe(store: &mut StateStore, window: &Window, cx: &App) {
    // Fullscreen is temporary and must not replace the normal frame.
    if window.is_fullscreen() || matches!(window.window_bounds(), WindowBounds::Fullscreen(_)) {
        return;
    }
    store.observe(
        WindowSnapshot {
            normal: saved(window.window_bounds().get_bounds()),
            display_uuid: window
                .display(cx)
                .and_then(|d| d.uuid().ok())
                .map(|id| id.to_string()),
            maximized: window.is_maximized(),
        },
        Instant::now(),
    );
}

pub(super) fn open_player_window(
    cx: &mut App,
) -> anyhow::Result<(AnyWindowHandle, Entity<Player>)> {
    let background = std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some();
    let mut store = StateStore::load(&audio_devices::directory());
    let primary = cx.primary_display().map(|d| d.id());
    let displays = cx.displays();
    let snapshots = displays
        .iter()
        .filter_map(|display| {
            Some(DisplaySnapshot {
                uuid: display.uuid().ok()?.to_string(),
                visible: saved(display.visible_bounds()),
                primary: Some(display.id()) == primary,
            })
        })
        .collect::<Vec<_>>();
    let resolved = store.resolve(&snapshots);
    let display_id = displays
        .iter()
        .find(|d| d.uuid().ok().map(|id| id.to_string()) == resolved.display_uuid)
        .map(|d| d.id());
    let normal = Bounds {
        origin: point(px(resolved.normal.x as f32), px(resolved.normal.y as f32)),
        size: size(
            px(resolved.normal.width as f32),
            px(resolved.normal.height as f32),
        ),
    };
    // Seed the normal frame before a maximized window can publish its frame.
    store.observe(
        WindowSnapshot {
            normal: resolved.normal,
            display_uuid: resolved.display_uuid,
            maximized: resolved.maximized,
        },
        Instant::now(),
    );
    let result = gpui_kit::open_window(
        WindowOptions {
            focus: !background,
            show: !background,
            display_id,
            window_min_size: Some(size(px(940.), px(600.))),
            window_bounds: Some(if resolved.maximized {
                WindowBounds::Maximized(normal)
            } else {
                WindowBounds::Windowed(normal)
            }),
            ..window_chrome::options()
        },
        cx,
        |window, cx| {
            window.set_layout_precision(LayoutPrecision::CssPixels);
            cx.new(|cx| {
                let mut player = Player::new(window, cx);
                player.desktop_window_state = Some(store);
                player
            })
        },
    )?;
    cx.global_mut::<DesktopWindow>().0 = Some(result.1.downgrade());
    Ok(result)
}

/// The application reopen callback uses this same path; no test-only factory.
pub(super) fn reopen(cx: &mut App) {
    if cx.windows().is_empty() {
        if let Err(error) = open_player_window(cx) {
            diagnostics::event(
                "app",
                format!("Could not reopen window: {error}"),
                diagnostics::Level::Error,
            );
        }
    }
}

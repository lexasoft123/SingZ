//! Explicit opt-in crash injection for isolated hidden UI runs only.
use super::*;
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};
fn mode() -> Option<String> {
    let mode = std::env::var("SINGZ_GPUI_CRASH_TEST").ok()?;
    assert!(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some());
    assert_eq!(std::env::var("SINGZ_MUTE").as_deref(), Ok("1"));
    assert!(std::env::var_os("SINGZ_GPUI_CONFIG_DIR").is_some());
    Some(mode)
}
fn output() -> PathBuf {
    std::env::var_os("SINGZ_GPUI_CRASH_OUTPUT")
        .expect("missing crash test output")
        .into()
}
#[cfg(unix)]
pub fn before_start() {
    if mode().as_deref() != Some("main") {
        return;
    }
    use std::process::{Command, Stdio};
    let dir = output();
    std::fs::create_dir_all(&dir).unwrap();
    let dummy = Command::new("sleep")
        .arg("60")
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    let registration = process_registry::Registration::new(&dummy).unwrap();
    std::fs::write(dir.join("dummy.pid"), dummy.id().to_string()).unwrap();
    let eof = Command::new("sh")
        .args(["-c", "cat >/dev/null"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .unwrap();
    std::fs::write(dir.join("eof.pid"), eof.id().to_string()).unwrap();
    // Exercise the real input-service registration with a caller-provided fake
    // helper; no physical capture is started in this hidden, muted fixture.
    let microphone = if std::env::var_os("SINGZ_C22_INPUT_PID").is_some() {
        let service = microphone::Service::new();
        service
            .start(microphone::Intent {
                prefs: microphone::Prefs::default(),
                request_permission: false,
                owner: 1,
                serial: 1,
                monitor: false,
            })
            .unwrap();
        let deadline = Instant::now() + Duration::from_secs(10);
        while service.snapshot().phase != microphone::Phase::Live {
            assert!(Instant::now() < deadline, "fake input helper did not start");
            std::thread::sleep(Duration::from_millis(10));
        }
        Some(service)
    } else {
        None
    };
    // Keep the children and their stdin alive until the panic hook runs.
    std::hint::black_box((&dummy, &registration, &eof, &microphone));
    // Keep the fixture service alive even if the hook is disabled, so only
    // registry termination can stop a helper that ignores stdin EOF.
    std::mem::forget(microphone);
    panic!("injected main panic");
}
#[cfg(not(unix))]
pub fn before_start() {
    if mode().as_deref() == Some("main") {
        panic!("injected main panic");
    }
}
pub fn run(handle: AnyWindowHandle, view: Entity<Player>, cx: &mut App) {
    let Some(mode) = mode() else { return };
    if mode == "worker" {
        std::thread::spawn(|| panic!("injected worker panic"));
    }
    if mode != "worker" && mode != "observe" {
        return;
    }
    let expected = std::env::var("SINGZ_C22_EXPECT_NOTICE").unwrap_or_else(|_| {
        if mode == "worker" {
            "internal".into()
        } else {
            "previous".into()
        }
    });
    cx.spawn(async move |cx| {
        let start = Instant::now();
        let mut locale_ready_at = None;
        loop {
            cx.background_executor()
                .timer(Duration::from_millis(50))
                .await;
            let state = handle.update(cx, |_, window, cx| {
                window.simulate_next_frame(cx);
                window.refresh();
                let _ = window.draw(cx);
                let player = view.read(cx);
                (player.notice.clone(), player.language_state.is_some())
            });
            let Ok((notice, locale_ready)) = state else {
                let _ = std::fs::create_dir_all(output());
                let _ = std::fs::write(output().join("failure.txt"), "test window closed");
                let _ = cx.update(|cx| cx.quit());
                break;
            };
            if locale_ready && locale_ready_at.is_none() {
                locale_ready_at = Some(Instant::now());
            }
            let quiet_complete = expected == "none"
                && locale_ready_at.is_some_and(|ready| ready.elapsed() >= Duration::from_secs(2));
            let timed_out = start.elapsed() >= Duration::from_secs(15);
            if notice.is_some() || quiet_complete || timed_out {
                let wanted = match expected.as_str() {
                    "previous" => Some(i18n::t("app.crash.previous")),
                    "internal" => Some(i18n::t("app.crash.internal")),
                    "none" => None,
                    _ => Some("invalid crash test expectation".into()),
                };
                let _ = std::fs::create_dir_all(output());
                let _ = std::fs::write(
                    output().join("notice.json"),
                    serde_json::to_vec(&notice).unwrap(),
                );
                if notice != wanted || (expected == "none" && !quiet_complete) {
                    let _ = std::fs::write(
                        output().join("failure.txt"),
                        format!("expected {wanted:?}, got {notice:?}"),
                    );
                }
                let _ = cx.update(|cx| cx.quit());
                break;
            }
        }
    })
    .detach();
}

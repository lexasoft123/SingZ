//! The updater service: Electron's six update states (src/main/updater.ts) on
//! top of the signed feed, the stager and the applier. Everything slow runs on
//! one background thread; the UI only reads a snapshot.
//!
//! Ownership: one process per install holds the instance lease; a second
//! instance of an installed app exits at once (D-04: the single-instance guard
//! the updater depends on). The owner reads and writes the install's journal
//! only while no applier holds `apply.lock`.
use crate::{
    updater_apply as apply, updater_fetch as fetch, updater_lock as lock,
    updater_manifest::{self, Channel},
    updater_stage as stage, updater_state as state, updater_swap as swap,
};
use anyhow::{Context, Result, ensure};
use std::{
    path::PathBuf,
    sync::{
        Arc, Condvar, Mutex, OnceLock,
        atomic::{AtomicBool, Ordering},
    },
    time::{Duration, Instant},
};

/// D-04: first check no sooner than 10 s after the first interactive frame,
/// then every 6 h (Electron's cadence).
const FIRST_CHECK: Duration = Duration::from_secs(10);
const PERIOD: Duration = Duration::from_secs(6 * 60 * 60);
/// A swapped-in version must survive this long past its first frame, with its
/// audio helper answering, before it may confirm.
const CONFIRM_AFTER: Duration = Duration::from_secs(20);
/// How long quit waits for a running update step to stop.
const QUIT_SETTLE: Duration = Duration::from_secs(3);

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum View {
    None,
    Checking,
    Available { version: String, url: String },
    Downloading { version: String, percent: u8 },
    Ready { version: String },
    Error { message: String },
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Snapshot {
    pub view: View,
    pub beta: bool,
    /// Set when the last swapped-in version failed its first launch.
    pub rolled_back: Option<String>,
    pub revision: u64,
}

pub fn config_dir() -> PathBuf {
    crate::audio_devices::directory()
}
/// The version this process reports. A `test-hooks` build reads it from a file
/// in the payload so one binary can stand in for N and N+1: in a macOS bundle
/// from `Contents/Resources` (sealed by the bundle signature; a data file in
/// `Contents/MacOS` would carry its signature in extended attributes, which
/// update archives do not keep), elsewhere beside the executable.
pub fn running_version() -> String {
    #[cfg(feature = "test-hooks")]
    if let Some(version) = std::env::current_exe()
        .ok()
        .and_then(|exe| {
            let dir = exe.parent()?.to_path_buf();
            std::fs::read_to_string(dir.join("../Resources/singz-test-version.txt"))
                .or_else(|_| std::fs::read_to_string(dir.join("singz-test-version.txt")))
                .ok()
        })
        .map(|v| v.trim().to_owned())
        .filter(|v| updater_manifest::valid_version(v))
    {
        return version;
    }
    crate::release_highlights::CURRENT_VERSION.to_owned()
}
/// Timing override for local end-to-end runs. The variable name is only
/// compiled into a `test-hooks` build, never into a shipped binary.
macro_rules! hook_ms {
    ($name:literal, $default:expr) => {{
        #[cfg(feature = "test-hooks")]
        let value = std::env::var($name)
            .ok()
            .and_then(|v| v.parse::<u64>().ok())
            .map_or($default, Duration::from_millis);
        #[cfg(not(feature = "test-hooks"))]
        let value: Duration = $default;
        value
    }};
}
fn feed_override() -> Option<String> {
    #[cfg(feature = "test-hooks")]
    return std::env::var("SINGZ_UPDATE_FEED").ok().filter(|v| !v.is_empty());
    #[cfg(not(feature = "test-hooks"))]
    None
}

// ---- channel setting ------------------------------------------------------
fn settings_path() -> PathBuf {
    config_dir().join("updates/settings.json")
}
/// Beta is a setting, on by default when this build is itself a prerelease.
pub fn load_beta(running: &str) -> bool {
    std::fs::read(settings_path())
        .ok()
        .and_then(|b| serde_json::from_slice::<serde_json::Value>(&b).ok())
        .and_then(|v| v["beta"].as_bool())
        .unwrap_or_else(|| running.contains('-'))
}
fn save_beta(beta: bool) -> Result<()> {
    let path = settings_path();
    std::fs::create_dir_all(path.parent().context("settings parent")?)?;
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, serde_json::to_vec(&serde_json::json!({ "beta": beta }))?)?;
    crate::project_store::replace(&tmp, &path)?;
    Ok(())
}

// ---- this install ---------------------------------------------------------
struct Ctx {
    install: PathBuf,
    exe_rel: PathBuf,
    /// [`updater_dir`]: journal, ledger, archive, leases, logs.
    dir: PathBuf,
    /// Why this install cannot replace itself, if it cannot.
    manual: Option<&'static str>,
}
/// Where an install's updater state lives. An updatable install keeps it
/// beside itself, keyed by the install alone, so processes running with
/// different profiles still share one instance lease, one apply lease and one
/// journal (R1). An install that cannot update itself only logs, per profile.
pub fn updater_dir(config: &std::path::Path, install: &std::path::Path, updatable: bool) -> Option<PathBuf> {
    if updatable { state::coordination_dir(install).ok() } else { Some(state::dir(config, install)) }
}
/// The updater directory this process may use, and whether it must fall back
/// to offering the download link: an updatable install whose coordination
/// directory cannot be trusted (or whose lease cannot be opened) is treated
/// as one that cannot update itself, never silently ignored.
pub fn resolve_dir(
    config: &std::path::Path,
    install: &std::path::Path,
    manual: Option<&'static str>,
) -> (PathBuf, Option<&'static str>, Option<String>) {
    if let Some(reason) = manual {
        return (state::dir(config, install), Some(reason), None);
    }
    match state::secure_coordination_dir(install).and_then(|dir| lock::try_acquire(&apply::instance_lock(&dir)).map(|_| dir)) {
        Ok(dir) => (dir, None, None),
        Err(error) => (
            state::dir(config, install),
            Some("update-directory-untrusted"),
            Some(format!("the update directory is not trusted ({error:#}); offering the download link")),
        ),
    }
}
fn ctx() -> Option<&'static Ctx> {
    static CTX: OnceLock<Option<Ctx>> = OnceLock::new();
    CTX.get_or_init(|| {
        let exe = std::env::current_exe().ok()?;
        let (install, exe_rel, manual) = match stage::eligibility(&exe) {
            stage::Eligibility::Updatable { install, exe_rel } => (install, exe_rel, None),
            stage::Eligibility::Manual(reason) => {
                let (install, exe_rel) = stage::payload_layout(&exe)?;
                (install, exe_rel, Some(reason))
            }
            stage::Eligibility::NotInstalled => return None, // a development run
        };
        // One install, one identity: resolve links so two spellings of the
        // same path cannot become two transactions.
        let install = std::fs::canonicalize(&install).unwrap_or(install);
        // The shared coordination directory must be provably ours (private,
        // owned, not a link) and its lease openable; otherwise this install
        // offers the download link instead of updating itself (F2).
        let (dir, manual, note) = resolve_dir(&config_dir(), &install, manual);
        if let Some(note) = note {
            let _ = TRUST_NOTE.set(note);
        }
        Some(Ctx { dir, install, exe_rel, manual })
    })
    .as_ref()
}

// ---- first launch, confirmation and the second line of rollback -----------
static FIRST_LAUNCH: AtomicBool = AtomicBool::new(false);
static OWNER: OnceLock<lock::Lock> = OnceLock::new();
/// Set when this install turned out not to be updatable after all (its lease
/// could not be opened): the service still runs and offers the download link.
static FORCED_MANUAL: OnceLock<&'static str> = OnceLock::new();
static TRUST_NOTE: OnceLock<String> = OnceLock::new();
fn manual_reason(ctx: &Ctx) -> Option<&'static str> {
    ctx.manual.or_else(|| FORCED_MANUAL.get().copied())
}
static STOPPING: AtomicBool = AtomicBool::new(false);
static HANDOFF: AtomicBool = AtomicBool::new(false);
static JOURNAL_ERROR: Mutex<Option<String>> = Mutex::new(None);

/// What a pending first launch must show before it may confirm: its window
/// presented, its audio helper answering, and the full survival interval.
#[derive(Clone, Copy, Debug, Default)]
pub struct Gate {
    pub frame: Option<Instant>,
    pub audio: bool,
}
impl Gate {
    pub fn ready(&self, now: Instant, survive: Duration) -> bool {
        self.audio && self.frame.is_some_and(|at| now.saturating_duration_since(at) >= survive)
    }
}
static GATE: Mutex<Gate> = Mutex::new(Gate { frame: None, audio: false });

/// Whether a periodic check may start a download now (pure).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Admission {
    Download,
    /// A verified update already waits for a restart.
    Ready,
    /// A transaction is in flight, or an applier (a watchdog that has not yet
    /// seen its confirmation) is alive: leave the journal alone.
    Wait,
}
pub fn admission(journal: &state::State, applier_alive: bool) -> Admission {
    if applier_alive {
        Admission::Wait
    } else if journal.phase == state::Phase::Ready {
        Admission::Ready
    } else if journal.can_download() {
        Admission::Download
    } else {
        Admission::Wait
    }
}

fn set_journal_error(message: String) {
    if let Some(ctx) = ctx() {
        apply::log(&ctx.dir, &format!("updater disabled: {message}"));
    }
    *JOURNAL_ERROR.lock().unwrap() = Some(message);
}
/// Called by `main()` before any window exists.
pub fn startup() {
    let Some(ctx) = ctx() else { return };
    let running = running_version();
    if let Some(note) = TRUST_NOTE.get() {
        apply::log(&ctx.dir, note);
    }
    match lock::try_acquire(&apply::instance_lock(&ctx.dir)) {
        Ok(Some(lease)) => {
            let _ = OWNER.set(lease);
        }
        Ok(None) => {
            // Another instance (or an applier moving this install's payload)
            // owns it: this process must not run beside it.
            apply::log(&ctx.dir, "another instance owns this install; exiting");
            std::process::exit(0);
        }
        Err(error) => {
            // Never silent: run without touching the install, offering the link.
            let _ = FORCED_MANUAL.set("install-lease-unavailable");
            apply::log(&ctx.dir, &format!("the install lease is unavailable ({error:#}); offering the download link"));
            return;
        }
    }
    match apply::reconcile_at_startup(&ctx.dir, &ctx.install, &running) {
        apply::Boot::Normal => {}
        apply::Boot::FirstLaunch => begin_first_launch(),
        apply::Boot::Delegate(job) => {
            apply::log(&ctx.dir, &format!("restoring {} before starting", job.plan.from));
            if manual_reason(ctx).is_none() && apply::spawn(&job).is_ok() {
                std::process::exit(0);
            }
            set_journal_error("an interrupted update could not be finished".into());
        }
        apply::Boot::Disabled(message) => set_journal_error(message),
    }
}
fn begin_first_launch() {
    FIRST_LAUNCH.store(true, Ordering::SeqCst);
    #[cfg(feature = "test-hooks")]
    if std::env::var_os("SINGZ_UPDATE_FAIL_FIRST_LAUNCH").is_some() {
        // Forced failure: die before confirming, as a crashing build would.
        std::process::exit(42);
    }
}
fn confirm() {
    if FIRST_LAUNCH.swap(false, Ordering::SeqCst) {
        if let Some(ctx) = ctx() {
            if let Err(error) = state::confirm(&ctx.dir, &running_version()) {
                apply::log(&ctx.dir, &format!("confirmation could not be recorded: {error:#}"));
            }
        }
    }
}
/// The audio helper answered its device inventory: part of "healthy".
pub fn audio_ready() {
    GATE.lock().unwrap().audio = true;
}
/// Called once the first interactive frame has been presented.
pub fn after_first_frame() {
    GATE.lock().unwrap().frame.get_or_insert_with(Instant::now);
    if FIRST_LAUNCH.load(Ordering::SeqCst) {
        std::thread::spawn(|| {
            let survive = hook_ms!("SINGZ_UPDATE_CONFIRM_MS", CONFIRM_AFTER);
            while !STOPPING.load(Ordering::SeqCst) {
                if GATE.lock().unwrap().ready(Instant::now(), survive) {
                    confirm();
                    return;
                }
                std::thread::sleep(Duration::from_millis(250));
            }
        });
    }
    start_service();
}
/// Orderly quit: stop updater work, then hand a staged update to the applier.
/// Quitting never confirms a first launch: only the health gate does.
pub fn on_quit() {
    STOPPING.store(true, Ordering::SeqCst);
    if let Some(shared) = SERVICE.get() {
        shared.wake.notify_all();
        let deadline = Instant::now() + QUIT_SETTLE;
        while shared.active.load(Ordering::SeqCst) && Instant::now() < deadline {
            std::thread::sleep(Duration::from_millis(25));
        }
    }
    if let Some(ctx) = ctx() {
        if manual_reason(ctx).is_none() && !HANDOFF.load(Ordering::SeqCst) {
            if state::load(&ctx.dir).is_ok_and(|s| s.phase == state::Phase::Ready) {
                let _ = begin_install();
            }
        }
    }
}

// ---- the service ----------------------------------------------------------
struct Inner {
    snapshot: Snapshot,
    check_requested: bool,
}
struct Shared {
    inner: Mutex<Inner>,
    wake: Condvar,
    busy: AtomicBool,
    active: AtomicBool,
}
static SERVICE: OnceLock<Arc<Shared>> = OnceLock::new();

fn start_service() {
    let running = running_version();
    let Some(ctx) = ctx() else { return };
    let broken = JOURNAL_ERROR.lock().unwrap().clone();
    let journal = state::load(&ctx.dir).unwrap_or_default();
    let view = match &broken {
        Some(message) => View::Error { message: message.clone() },
        None => staged_view(ctx, &journal, &running).unwrap_or(View::None),
    };
    let shared = Arc::new(Shared {
        inner: Mutex::new(Inner {
            snapshot: Snapshot {
                view,
                beta: load_beta(&running),
                rolled_back: (journal.phase == state::Phase::RolledBack)
                    .then(|| journal.version.clone())
                    .flatten(),
                revision: 1,
            },
            check_requested: false,
        }),
        wake: Condvar::new(),
        busy: AtomicBool::new(false),
        active: AtomicBool::new(false),
    });
    if SERVICE.set(shared.clone()).is_err() || broken.is_some() {
        return; // a damaged journal disables automatic updates
    }
    std::thread::spawn(move || worker(&shared, ctx, &running));
}
/// An archive staged by an earlier run is offered again without a new download.
fn staged_view(ctx: &Ctx, journal: &state::State, running: &str) -> Option<View> {
    let version = journal.version.as_deref()?;
    (journal.phase == state::Phase::Ready
        && ctx.dir.join(apply::ARCHIVE).exists()
        && updater_manifest::compare(version, running).is_gt()
        && !journal.is_blocked(version))
    .then(|| View::Ready { version: version.to_owned() })
}
fn set_view(shared: &Shared, view: View) {
    let mut inner = shared.inner.lock().unwrap();
    if inner.snapshot.view != view {
        inner.snapshot.view = view;
        inner.snapshot.revision += 1;
    }
}
fn worker(shared: &Arc<Shared>, ctx: &'static Ctx, running: &str) {
    let mut wait = hook_ms!("SINGZ_UPDATE_FIRST_CHECK_MS", FIRST_CHECK);
    loop {
        let manual = {
            let guard = shared.inner.lock().unwrap();
            let (mut guard, _) = shared
                .wake
                .wait_timeout_while(guard, wait, |i| !i.check_requested && !STOPPING.load(Ordering::SeqCst))
                .unwrap();
            std::mem::take(&mut guard.check_requested)
        };
        if STOPPING.load(Ordering::SeqCst) {
            return; // no new cycles once shutdown starts
        }
        wait = PERIOD;
        shared.active.store(true, Ordering::SeqCst);
        let outcome = cycle(shared, ctx, running, manual);
        shared.active.store(false, Ordering::SeqCst);
        match outcome {
            Ok(Admission::Wait) => wait = Duration::from_secs(30), // look again after the transaction settles
            Ok(_) => {}
            Err(error) => {
                let message: String = format!("{error:#}").chars().take(200).collect();
                apply::log(&ctx.dir, &format!("update check failed: {message}"));
                if !STOPPING.load(Ordering::SeqCst) {
                    set_view(shared, View::Error { message });
                }
            }
        }
    }
}
/// Called with `apply.lock` held by this process, so no applier runs.
fn clean_download(ctx: &Ctx) {
    let _ = std::fs::remove_file(ctx.dir.join("update.download"));
    if state::load(&ctx.dir).is_ok_and(|s| s.phase.is_settled() && s.phase != state::Phase::Ready) {
        let _ = std::fs::remove_file(ctx.dir.join(apply::ARCHIVE));
    }
    let _ = swap::check_path(&ctx.install).map(|p| swap::remove_tree(&p));
}
/// Flushed before it counts: the applier verifies these after a restart.
fn write_file(path: &std::path::Path, bytes: &[u8]) -> Result<()> {
    state::write_atomic(path, bytes)
}
fn cycle(shared: &Arc<Shared>, ctx: &'static Ctx, running: &str, manual: bool) -> Result<Admission> {
    if manual_reason(ctx).is_some() {
        // Never downloads: no lease or journal needed to offer the link.
        return cycle_locked(shared, ctx, running, manual);
    }
    // Holding `apply.lock` for the whole cycle keeps any applier (and its
    // watchdog) and this download apart.
    let Some(_apply) = lock::try_acquire(&apply::apply_lock(&ctx.dir))? else {
        return Ok(Admission::Wait);
    };
    let result = cycle_locked(shared, ctx, running, manual);
    if result.is_err() {
        clean_download(ctx);
        if state::load(&ctx.dir).is_ok_and(|s| s.phase == state::Phase::Downloading) {
            let _ = state::update(&ctx.dir, state::State::abort);
        }
    }
    drop(_apply);
    #[cfg(feature = "test-hooks")]
    if result.is_ok() && state::load(&ctx.dir).is_ok_and(|s| s.phase == state::Phase::Ready) {
        if std::env::var_os("SINGZ_UPDATE_AUTO_INSTALL").is_some() {
            begin_install()?;
            std::process::exit(0);
        }
        if std::env::var_os("SINGZ_UPDATE_QUIT_WHEN_READY").is_some() {
            // An ordinary quit, without the "Restart to update" button.
            shared.active.store(false, Ordering::SeqCst);
            on_quit();
            std::process::exit(0);
        }
    }
    result
}
fn cycle_locked(shared: &Arc<Shared>, ctx: &'static Ctx, running: &str, manual: bool) -> Result<Admission> {
    let journal = match manual_reason(ctx) {
        Some(_) => state::load(&ctx.dir).unwrap_or_default(), // only its blocked list is used
        None => state::load(&ctx.dir)?, // a damaged journal is an error, never a reset
    };
    let admission = admission(&journal, false);
    if admission != Admission::Download {
        return Ok(admission);
    }
    if manual {
        set_view(shared, View::Checking);
    }
    let beta = shared.inner.lock().unwrap().snapshot.beta;
    let channel = if beta { Channel::Beta } else { Channel::Stable };
    let Some(found) = fetch::check(channel, running, &journal.blocked, feed_override().as_deref())? else {
        set_view(shared, View::None);
        return Ok(admission);
    };
    let version = found.manifest.version.clone();
    apply::log(&ctx.dir, &format!("update {version} found (running {running})"));
    let link = found.manifest.notes_url.clone().unwrap_or_else(|| fetch::RELEASES_PAGE.to_owned());
    let host_os = updater_manifest::host_os_version();
    match updater_manifest::compat(&found.manifest, running, host_os.as_deref()) {
        updater_manifest::Compat::Ok => {}
        updater_manifest::Compat::BelowFloor => {
            apply::log(&ctx.dir, &format!("{version} needs a newer base than {running}; offering the download link"));
            set_view(shared, View::Available { version, url: link });
            return Ok(admission);
        }
        updater_manifest::Compat::UnsupportedOs => {
            apply::log(&ctx.dir, &format!("{version} does not support this operating system"));
            set_view(shared, View::None);
            return Ok(admission);
        }
    }
    if let Some(reason) = manual_reason(ctx) {
        apply::log(&ctx.dir, &format!("{version} is available but this install cannot update itself ({reason}); offering the download link"));
        set_view(shared, View::Available { version, url: link });
        return Ok(admission);
    }
    let archive = ctx.dir.join(apply::ARCHIVE);
    let mut txn = 0;
    state::update_checked(&ctx.dir, |s| {
        txn = s.begin_download(&version)?;
        Ok(())
    })?;
    state::prune_receipts(&ctx.dir, txn);
    set_view(shared, View::Downloading { version: version.clone(), percent: 0 });
    let mut last = 0u8;
    fetch::download(&found, &archive, &mut |done, total| {
        // Download and hashing wait for an idle transport (N7/N11).
        while shared.busy.load(Ordering::Relaxed) {
            if STOPPING.load(Ordering::SeqCst) {
                return false;
            }
            std::thread::sleep(Duration::from_millis(200));
        }
        let percent = ((done.saturating_mul(100)) / total.max(1)).min(100) as u8;
        if percent != last {
            last = percent;
            set_view(shared, View::Downloading { version: version.clone(), percent });
        }
        !STOPPING.load(Ordering::SeqCst)
    })?;
    // Prove the archive can be staged now, so "ready" is honest; the applier
    // extracts it again after verifying it once more.
    stage::check_archive(&archive, &ctx.install, &ctx.exe_rel, &|| STOPPING.load(Ordering::SeqCst))?;
    write_file(&ctx.dir.join(apply::MANIFEST), &found.raw_manifest)?;
    write_file(&ctx.dir.join(apply::SIGNATURE), &found.signature)?;
    state::update_checked(&ctx.dir, |s| s.ready(found.manifest.notes_url.clone()))?;
    set_view(shared, View::Ready { version });
    Ok(admission)
}

// ---- UI-facing API --------------------------------------------------------
pub fn snapshot() -> Option<Snapshot> {
    SERVICE.get().map(|s| s.inner.lock().unwrap().snapshot.clone())
}
pub fn check_now() {
    if let Some(s) = SERVICE.get() {
        s.inner.lock().unwrap().check_requested = true;
        s.wake.notify_all();
    }
}
pub fn set_beta(beta: bool) {
    if let Some(s) = SERVICE.get() {
        let _ = save_beta(beta);
        let mut inner = s.inner.lock().unwrap();
        inner.snapshot.beta = beta;
        inner.snapshot.revision += 1;
        inner.check_requested = true;
        s.wake.notify_all();
    }
}
/// The transport is playing or recording: hold downloads until it is idle.
pub fn set_busy(busy: bool) {
    if let Some(s) = SERVICE.get() {
        s.busy.store(busy, Ordering::Relaxed);
    }
}
/// "Restart to update" (and install-on-quit): hand the staged archive to the
/// applier exactly once. The caller quits right after `Ok`.
pub fn begin_install() -> Result<()> {
    let ctx = ctx().context("not an installed app")?;
    ensure!(manual_reason(ctx).is_none(), "this install cannot update itself");
    if HANDOFF.swap(true, Ordering::SeqCst) {
        return Ok(()); // already handed off by the button or an earlier quit
    }
    let result = (|| -> Result<()> {
        let job = apply::handoff(&ctx.dir, &ctx.install, &ctx.exe_rel, &running_version(), state::Layout::native())?;
        if let Err(error) = apply::spawn(&job) {
            // Nothing has moved yet: the update stays ready for the next restart.
            let _ = state::update(&ctx.dir, |s| {
                s.phase = state::Phase::Ready;
                s.plan = None;
            });
            return Err(error);
        }
        Ok(())
    })();
    if result.is_err() {
        HANDOFF.store(false, Ordering::SeqCst);
    }
    result
}

#[cfg(test)]
#[path = "updater_host_tests.rs"]
mod tests;

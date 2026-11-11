//! The whole transaction, for real: a signed manifest and retained archive,
//! the handoff, the applier, payload moves on disk in the macOS (`Exchange`)
//! and Windows (`TwoRename`) layouts, and a simulated app that runs the same
//! startup reconciliation as the real one. The kill sweep stops the applier
//! at every phase boundary and checks that the next start ends with the old
//! or the new app installed, launchable, and a settled, consistent journal.
use super::*;
use crate::updater_swap::{FAULTS, Faults};
use ed25519_dalek::{Signer, SigningKey};
use std::sync::{
    Arc, Mutex,
    atomic::{AtomicBool, Ordering},
};
use std::thread::JoinHandle;

const OLD: &str = "1.0.0";
const NEW: &str = "2.0.0";
const ARCHIVE_BYTES: &[u8] = b"pretend this is the signed update archive";

fn temp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "singz-apply-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}
fn write_payload(dir: &Path, version: &str, executable: bool) {
    fs::create_dir_all(dir.join("bin")).unwrap();
    fs::write(dir.join("version"), version).unwrap();
    let exe = dir.join("bin").join("app");
    fs::write(&exe, "#!/bin/sh\nexit 0\n").unwrap();
    // Windows has no execute bit: a sidecar stands for "the loader refuses it".
    if !executable && cfg!(not(unix)) {
        fs::write(dir.join("unlaunchable"), "").unwrap();
    }
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(&exe, fs::Permissions::from_mode(if executable { 0o755 } else { 0o644 })).unwrap();
    }
}
fn launchable(dir: &Path) -> bool {
    let meta = fs::metadata(dir.join("bin").join("app"));
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        meta.is_ok_and(|m| m.is_file() && m.permissions().mode() & 0o111 != 0)
    }
    #[cfg(not(unix))]
    {
        meta.is_ok_and(|m| m.is_file()) && !dir.join("unlaunchable").exists()
    }
}
fn quiet_kills() {
    static ONCE: std::sync::Once = std::sync::Once::new();
    ONCE.call_once(|| {
        let default = std::panic::take_hook();
        std::panic::set_hook(Box::new(move |info| {
            let killed = info.payload().downcast_ref::<String>().is_some_and(|m| m.starts_with("killed at "));
            if !killed {
                default(info);
            }
        }));
    });
}

/// How the simulated new version behaves on its first launch.
#[derive(Clone, Copy, PartialEq, Eq, Debug)]
enum NewApp {
    Healthy,
    Crashes,
    /// Confirms, then a check starts the next download at once (M4).
    ConfirmsThenDownloads,
    /// Damages the journal and the ledger, then crashes (M3).
    DamagesJournalThenCrashes,
    /// Dies between writing its confirmation receipt and the journal (R2).
    KilledAfterReceipt,
}
fn healthy(new_app: NewApp) -> bool {
    matches!(new_app, NewApp::Healthy | NewApp::ConfirmsThenDownloads | NewApp::KilledAfterReceipt)
}
struct Opts {
    layout: Layout,
    new_app: NewApp,
    min_os: Option<&'static str>,
    floor: &'static str,
    target: Option<&'static str>,
    executable: bool,
}
impl Opts {
    fn new(layout: Layout, new_app: NewApp) -> Opts {
        Opts { layout, new_app, min_os: None, floor: OLD, target: None, executable: true }
    }
}
struct World {
    root: PathBuf,
    dir: PathBuf,
    install: PathBuf,
    key: SigningKey,
    layout: Layout,
    new_app: NewApp,
    executable: bool,
    /// Versions launched, in order (by the applier or by a start).
    launched: Arc<Mutex<Vec<String>>>,
    apps: Arc<Mutex<Vec<JoinHandle<()>>>>,
    recovery: Arc<Mutex<bool>>,
    fail_recovery: AtomicBool,
    materialized: Mutex<u32>,
}
fn layouts() -> Vec<Layout> {
    if cfg!(target_os = "macos") { vec![Layout::Exchange, Layout::TwoRename] } else { vec![Layout::TwoRename] }
}
fn world(name: &str, opts: Opts) -> World {
    quiet_kills();
    let root = temp(name);
    let config = root.join("config");
    fs::create_dir_all(root.join("library")).unwrap();
    fs::write(root.join("library/song.json"), "mine").unwrap();
    fs::create_dir_all(&config).unwrap();
    fs::write(config.join("settings.json"), "{\"keep\":true}").unwrap();
    let install = root.join("apps").join("install");
    write_payload(&install, OLD, true);
    fs::write(install.join("Uninstall.exe"), "installer-owned").unwrap(); // in no update archive
    let dir = state::coordination_dir(&install).unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join(ARCHIVE), ARCHIVE_BYTES).unwrap();
    let digest: String = Sha256::digest(ARCHIVE_BYTES).iter().map(|b| format!("{b:02x}")).collect();
    let manifest_json = serde_json::json!({
        "schema": 1, "version": NEW, "channel": "stable",
        "target": opts.target.unwrap_or(crate::updater_fetch::target()),
        "archive": {"name": "update.zip", "bytes": ARCHIVE_BYTES.len(), "sha256": digest},
        "rollbackFloor": opts.floor, "minOs": opts.min_os,
    })
    .to_string();
    let key = SigningKey::from_bytes(&[5; 32]);
    fs::write(dir.join(MANIFEST), manifest_json.as_bytes()).unwrap();
    fs::write(dir.join(SIGNATURE), key.sign(manifest_json.as_bytes()).to_bytes()).unwrap();
    // The journal as the app leaves it once the archive is verified and retained.
    let mut journal = State::default();
    journal.begin_download(NEW).unwrap();
    journal.ready(None).unwrap();
    state::save(&dir, &journal).unwrap();
    World {
        root,
        dir,
        install,
        key,
        layout: opts.layout,
        new_app: opts.new_app,
        executable: opts.executable,
        launched: Arc::default(),
        apps: Arc::default(),
        recovery: Arc::default(),
        fail_recovery: AtomicBool::new(false),
        materialized: Mutex::new(0),
    }
}

/// A launched app: a thread that takes the instance lease and runs the real
/// startup reconciliation, as `updater_host::startup` does.
struct Sim {
    exit: Arc<Mutex<Option<String>>>,
    kill: Arc<AtomicBool>,
}
impl Proc for Sim {
    fn exited(&mut self) -> Result<Option<String>> {
        Ok(self.exit.lock().unwrap().clone())
    }
    fn kill(&mut self) {
        self.kill.store(true, Ordering::SeqCst);
        while self.exit.lock().unwrap().is_none() {
            std::thread::sleep(Duration::from_millis(5));
        }
    }
}
impl World {
    fn version(&self) -> String {
        fs::read_to_string(self.install.join("version")).unwrap()
    }
    fn journal(&self) -> State {
        state::load(&self.dir).unwrap()
    }
    fn job(&self) -> Job {
        serde_json::from_slice(&fs::read(job_path(&self.dir)).unwrap()).unwrap()
    }
    fn handoff(&self) -> Result<Job> {
        handoff(&self.dir, &self.install, Path::new("bin/app"), OLD, self.layout)
    }
    fn launch(&self, plan: &Plan) -> Result<Box<dyn Proc>> {
        ensure!(launchable(&plan.install), "launch {}: permission denied", plan.install.display());
        let version = fs::read_to_string(plan.install.join("version"))?;
        self.launched.lock().unwrap().push(version.clone());
        let (exit, kill) = (Arc::new(Mutex::new(None)), Arc::new(AtomicBool::new(false)));
        let (dir, install, new_app, recovery) = (self.dir.clone(), plan.install.clone(), self.new_app, self.recovery.clone());
        if new_app == NewApp::ConfirmsThenDownloads && version == NEW {
            // The watchdog is "suspended" until the confirmed app has already
            // started the next transaction (the review's M4 sequence).
            *exit.lock().unwrap() = Some(sim_app(&dir, &install, &version, new_app, &recovery, &kill));
            return Ok(Box::new(Sim { exit, kill }));
        }
        let (e, k) = (exit.clone(), kill.clone());
        let handle = std::thread::spawn(move || {
            let code = sim_app(&dir, &install, &version, new_app, &recovery, &k);
            *e.lock().unwrap() = Some(code);
        });
        self.apps.lock().unwrap().push(handle);
        Ok(Box::new(Sim { exit, kill }))
    }
    fn join_apps(&self) {
        let handles: Vec<_> = self.apps.lock().unwrap().drain(..).collect();
        for handle in handles {
            handle.join().unwrap();
        }
    }
    fn hooks(&self) -> Hooks<'_> {
        Hooks {
            keys: vec![self.key.verifying_key().to_bytes()],
            host_os: Some("15.0".into()),
            target: crate::updater_fetch::target().to_owned(),
            materialize: Box::new(move |plan, archive| {
                assert_eq!(fs::read(archive).unwrap(), ARCHIVE_BYTES);
                *self.materialized.lock().unwrap() += 1;
                let root = plan.extract.join("payload");
                let _ = fs::remove_dir_all(&plan.extract);
                write_payload(&root, NEW, self.executable);
                Ok(root)
            }),
            launch: Box::new(move |plan| self.launch(plan)),
            recovery: Box::new(move |_job, enable| {
                swap::event(if enable { "recovery-on" } else { "recovery-off" }, &self.install);
                ensure!(!(enable && self.fail_recovery.load(Ordering::SeqCst)), "registry policy denies the Run key");
                *self.recovery.lock().unwrap() = enable;
                Ok(())
            }),
            app_exit_wait: Duration::from_secs(5),
            deadline: Duration::from_secs(5),
        }
    }
    /// Hand over and apply, as "Restart to update" does.
    fn apply(&self) -> Result<()> {
        let job = self.handoff()?;
        drive(&job, &self.hooks())
    }
    /// What happens after a crash: the user starts whatever is installed (or,
    /// with the install path missing, sign-in runs the recovery entry), until
    /// a start runs normally.
    fn next_starts(&self) {
        for _ in 0..8 {
            self.join_apps();
            if !self.install.exists() {
                assert!(*self.recovery.lock().unwrap(), "the install is missing and no recovery entry is registered");
                let _ = drive(&self.job(), &self.hooks());
                continue;
            }
            let version = self.version();
            let lease = lock::try_acquire(&instance_lock(&self.dir)).unwrap().expect("no app is running");
            self.launched.lock().unwrap().push(version.clone());
            match start(&self.dir, &self.install, &version, &self.recovery) {
                Boot::Normal => return,
                Boot::FirstLaunch => {
                    if healthy(self.new_app) {
                        state::confirm(&self.dir, &version).unwrap();
                        return;
                    }
                }
                Boot::Delegate(job) => {
                    drop(lease);
                    let _ = drive(&job, &self.hooks());
                    continue;
                }
                Boot::Disabled(why) => panic!("a start disabled the updater: {why}"),
            }
        }
        panic!("the transaction never settled: {:?}", self.journal());
    }
    /// The end state every interruption must reach.
    fn assert_settled(&self, context: &str) {
        self.join_apps();
        assert!(self.install.is_dir(), "{context}: the install is missing");
        assert!(launchable(&self.install), "{context}: the installed app is not launchable");
        let journal = self.journal();
        assert!(journal.phase.is_settled(), "{context}: unsettled journal {journal:?}");
        let version = self.version();
        let plan = journal.plan.clone();
        match (version.as_str(), journal.phase) {
            (NEW, Phase::Confirmed) => {
                assert_ne!(self.new_app, NewApp::Crashes, "{context}: a crashing build was confirmed");
                let previous = plan.unwrap().previous;
                assert_eq!(fs::read_to_string(previous.join("version")).ok().as_deref(), Some(OLD), "{context}: previous not retained");
                assert_eq!(fs::read_to_string(self.install.join("Uninstall.exe")).unwrap(), "installer-owned");
            }
            (OLD, Phase::RolledBack) => {
                assert_ne!(self.new_app, NewApp::Healthy, "{context}: a healthy build was rolled back");
                assert!(journal.is_blocked(NEW), "{context}: the failed version is not blocked");
            }
            (OLD, Phase::Aborted) => assert!(!journal.is_blocked(NEW), "{context}: an interrupted swap blamed the version"),
            // Killed before the handoff committed: the update simply stays ready.
            (OLD, Phase::Ready) => assert!(journal.plan.is_none(), "{context}"),
            other => panic!("{context}: installed {} with journal {:?}", other.0, other.1),
        }
        if let Some(plan) = journal.plan {
            assert!(!plan.staged.exists() && !plan.extract.exists(), "{context}: staging left behind");
        }
        assert!(!*self.recovery.lock().unwrap(), "{context}: the recovery entry was left registered");
        // Another start changes nothing.
        let lease = lock::try_acquire(&instance_lock(&self.dir)).unwrap().unwrap();
        assert_eq!(start(&self.dir, &self.install, &version, &self.recovery), Boot::Normal, "{context}");
        drop(lease);
        assert_eq!(fs::read_to_string(self.root.join("library/song.json")).unwrap(), "mine");
        assert_eq!(fs::read_to_string(self.root.join("config/settings.json")).unwrap(), "{\"keep\":true}");
    }
    fn done(self) {
        self.join_apps();
        fs::remove_dir_all(self.root).unwrap();
    }
}
/// The real startup reconciliation, with the recovery entry recorded.
fn start(dir: &Path, install: &Path, version: &str, recovery: &Arc<Mutex<bool>>) -> Boot {
    reconcile_with(dir, install, version, &|_, enable| {
        *recovery.lock().unwrap() = enable;
        Ok(())
    })
}
fn sim_app(dir: &Path, install: &Path, version: &str, new_app: NewApp, recovery: &Arc<Mutex<bool>>, kill: &AtomicBool) -> String {
    let deadline = Instant::now() + Duration::from_secs(5);
    let lease = loop {
        if kill.load(Ordering::SeqCst) || Instant::now() > deadline {
            return "killed before start".into();
        }
        if let Ok(Some(lease)) = lock::try_acquire(&instance_lock(dir)) {
            break lease;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let boot = start(dir, install, version, recovery);
    if version != NEW || boot != Boot::FirstLaunch {
        drop(lease);
        return format!("exit 0 ({boot:?})");
    }
    match new_app {
        NewApp::Healthy => {
            state::confirm(dir, version).unwrap();
            "exit 0".into()
        }
        NewApp::ConfirmsThenDownloads => {
            state::confirm(dir, version).unwrap();
            // The review's M4 race: a check starts N+2 before the watchdog looks.
            state::update(dir, |s| {
                s.begin_download("3.0.0").unwrap();
            })
            .unwrap();
            "exit 0".into()
        }
        NewApp::Crashes => "exit status: 7".into(),
        NewApp::KilledAfterReceipt => {
            let (r, _) = with_faults(Faults { kill_at: Some(0), ..Faults::default() }, || state::confirm(dir, version));
            assert!(r.is_err(), "the confirmation must be killed after its receipt");
            assert!(state::is_confirmed(dir, state::load(dir).unwrap().txn));
            "killed".into()
        }
        NewApp::DamagesJournalThenCrashes => {
            fs::write(dir.join("blocked.json"), b"[\"0.9.0\",\"0.").unwrap();
            fs::write(state::path(dir), b"{\"phase\":\"pend").unwrap();
            "exit status: 7".into()
        }
    }
}
fn start_w(w: &World, version: &str) -> Boot {
    start(&w.dir, &w.install, version, &w.recovery)
}
fn with_faults<T>(faults: Faults, run: impl FnOnce() -> T) -> (std::thread::Result<T>, Faults) {
    FAULTS.with(|f| *f.borrow_mut() = faults);
    let result = std::panic::catch_unwind(std::panic::AssertUnwindSafe(run));
    (result, FAULTS.with(|f| std::mem::take(&mut *f.borrow_mut())))
}

// ---- complete runs ------------------------------------------------------------------
#[test]
fn a_healthy_update_confirms_and_keeps_the_previous_payload() {
    for layout in layouts() {
        let w = world("ok", Opts::new(layout, NewApp::Healthy));
        w.apply().unwrap();
        assert_eq!(w.version(), NEW);
        assert_eq!(*w.launched.lock().unwrap(), vec![NEW.to_string()], "{layout:?}: launched exactly the new version");
        w.assert_settled(&format!("{layout:?}"));
        w.done();
    }
}
#[test]
fn a_first_launch_that_crashes_is_rolled_back_and_blocked() {
    for layout in layouts() {
        let w = world("crash", Opts::new(layout, NewApp::Crashes));
        w.apply().unwrap();
        assert_eq!(w.version(), OLD);
        assert_eq!(*w.launched.lock().unwrap(), vec![NEW.to_string(), OLD.to_string()], "{layout:?}");
        w.assert_settled(&format!("{layout:?}"));
        w.done();
    }
}
#[test]
fn a_replacement_that_cannot_be_launched_is_rolled_back_not_stranded() {
    for layout in layouts() {
        let w = world("noexec", Opts { executable: false, ..Opts::new(layout, NewApp::Crashes) });
        w.apply().unwrap();
        assert_eq!(w.version(), OLD, "{layout:?}");
        w.assert_settled(&format!("{layout:?}"));
        w.done();
    }
}

// ---- the kill sweep -------------------------------------------------------------------
#[test]
fn killing_the_applier_at_any_point_ends_with_one_whole_app_and_a_settled_journal() {
    for layout in layouts() {
        for new_app in [NewApp::Healthy, NewApp::Crashes] {
            // Record every kill point a clean run passes.
            let w = world("record", Opts::new(layout, new_app));
            let (result, faults) = with_faults(Faults::default(), || w.apply());
            result.unwrap().unwrap();
            w.done();
            let points = faults.hits;
            assert!(points.len() >= 12, "{layout:?}/{new_app:?}: {points:?}");
            for (n, point) in points.iter().enumerate() {
                let context = format!("{layout:?}/{new_app:?} killed at #{n} {point}");
                let w = world("kill", Opts::new(layout, new_app));
                let (result, _) = with_faults(Faults { kill_at: Some(n), ..Faults::default() }, || w.apply());
                assert!(result.is_err(), "{context}: the kill point was not reached");
                w.next_starts();
                w.assert_settled(&context);
                w.done();
            }
        }
    }
}

// ---- review regressions -----------------------------------------------------------------
#[test]
fn b1_a_completed_windows_swap_is_recognised_on_replay_not_re_extracted() {
    let w = world("b1", Opts::new(Layout::TwoRename, NewApp::Healthy));
    let job = w.handoff().unwrap();
    // Kill right after the second rename, before `swapped` is journaled.
    let (recorded, faults) = with_faults(Faults::default(), || drive(&job, &w.hooks()));
    recorded.unwrap().unwrap();
    w.done();
    let n = faults.hits.iter().enumerate().filter(|(_, p)| *p == "after-rename").map(|(i, _)| i).nth(1).unwrap();
    let w = world("b1", Opts::new(Layout::TwoRename, NewApp::Healthy));
    let job = w.handoff().unwrap();
    let (killed, _) = with_faults(Faults { kill_at: Some(n), ..Faults::default() }, || drive(&job, &w.hooks()));
    assert!(killed.is_err());
    assert_eq!((w.version(), w.journal().phase), (NEW.to_string(), Phase::Swapping));
    // The replay (the recovery entry, or a start) finishes from the markers.
    drive(&w.job(), &w.hooks()).unwrap();
    assert_eq!(*w.materialized.lock().unwrap(), 1, "the completed swap was extracted over again");
    let previous = w.journal().plan.unwrap().previous;
    assert_eq!(fs::read_to_string(previous.join("version")).unwrap(), OLD, "the original previous payload was replaced");
    w.assert_settled("b1");
    w.done();
}
#[test]
fn b2_rollback_is_journaled_first_and_recovery_stays_until_it_is_durable() {
    for layout in layouts() {
        let w = world("b2-record", Opts::new(layout, NewApp::Crashes));
        let (r, faults) = with_faults(Faults::default(), || w.apply());
        r.unwrap().unwrap();
        w.done();
        let rolling = faults.hits.iter().position(|p| p == "journal-RollingBack").expect("rollback journaled");
        let moved = faults.hits[rolling..].iter().position(|p| p.starts_with("after-")).unwrap() + rolling;
        // Killed with the first rollback move done (Windows: install renamed away).
        let w = world("b2", Opts::new(layout, NewApp::Crashes));
        let (r, _) = with_faults(Faults { kill_at: Some(moved), ..Faults::default() }, || w.apply());
        assert!(r.is_err());
        assert_eq!(w.journal().phase, Phase::RollingBack, "{layout:?}: the rollback must be journaled before it moves anything");
        if layout == Layout::TwoRename {
            assert!(!w.install.exists() && *w.recovery.lock().unwrap(), "the recovery entry must outlive the missing install");
        } else {
            assert_eq!(w.version(), OLD, "the exchange restored the old bundle");
        }
        w.next_starts();
        w.assert_settled(&format!("b2 {layout:?}"));
        w.done();
    }
}
#[test]
fn b2_a_restored_old_app_with_a_pending_journal_records_the_rollback() {
    // The state the old applier could leave: the old bundle back in place,
    // the journal still pending-confirm for the new version.
    for layout in layouts() {
        let w = world("b2-record", Opts::new(layout, NewApp::Crashes));
        let job = w.handoff().unwrap();
        let (r, faults) = with_faults(Faults::default(), || drive(&job, &w.hooks()));
        r.unwrap().unwrap();
        w.done();
        let pending = faults.hits.iter().position(|p| p == "journal-PendingConfirm").unwrap();
        let w = world("b2-pending", Opts::new(layout, NewApp::Crashes));
        let job = w.handoff().unwrap();
        let (r, _) = with_faults(Faults { kill_at: Some(pending), ..Faults::default() }, || drive(&job, &w.hooks()));
        assert!(r.is_err());
        state::update(&w.dir, |s| s.attempts = 1).unwrap();
        swap::converge(&job.plan, w.journal().new_id, false).unwrap(); // an unjournaled restore
        assert_eq!((w.version(), w.journal().phase), (OLD.to_string(), Phase::PendingConfirm));
        let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
        assert_eq!(start_w(&w, OLD), Boot::Normal);
        drop(lease);
        let journal = w.journal();
        assert_eq!(journal.phase, Phase::RolledBack, "{layout:?}: pending for another version forever");
        assert!(journal.is_blocked(NEW));
        w.assert_settled(&format!("b2 pending {layout:?}"));
        w.done();
    }
}
#[test]
fn b3_an_error_after_the_swap_is_reconciled_from_the_disk() {
    for layout in layouts() {
        let w = world("b3-record", Opts::new(layout, NewApp::Healthy));
        let (r, faults) = with_faults(Faults::default(), || w.apply());
        r.unwrap().unwrap();
        w.done();
        // The first payload move of the swap succeeds, then the step reports an error.
        let first_move = faults.hits.iter().position(|p| p == "after-exchange" || p == "after-rename").unwrap();
        let w = world("b3", Opts::new(layout, NewApp::Healthy));
        let (r, _) = with_faults(Faults { fail_at: Some(first_move), ..Faults::default() }, || w.apply());
        assert!(r.is_ok(), "{layout:?}: the applier must settle, not panic");
        assert_eq!(w.version(), OLD, "{layout:?}");
        assert_eq!(
            *w.launched.lock().unwrap(),
            vec![OLD.to_string()],
            "{layout:?}: only the old version may be launched; never the new one without a watchdog"
        );
        w.assert_settled(&format!("b3 {layout:?}"));
        w.done();
    }
}
#[test]
fn b4_no_payload_moves_until_recovery_is_registered() {
    let w = world("b4", Opts::new(Layout::TwoRename, NewApp::Healthy));
    w.fail_recovery.store(true, Ordering::SeqCst);
    let (r, faults) = with_faults(Faults::default(), || w.apply());
    let error = r.unwrap().unwrap_err();
    assert!(format!("{error:#}").contains("recovery entry could not be registered"), "{error:#}");
    assert!(!faults.events.iter().any(|e| e.starts_with("move ")), "a payload moved without recovery: {:?}", faults.events);
    assert_eq!(w.version(), OLD);
    assert_eq!(*w.launched.lock().unwrap(), vec![OLD.to_string()], "the old version is started again");
    w.assert_settled("b4");
    w.done();
    // And with registration working, it precedes every move and is removed
    // only once the install is whole again.
    let w = world("b4-order", Opts::new(Layout::TwoRename, NewApp::Healthy));
    let (r, faults) = with_faults(Faults::default(), || w.apply());
    r.unwrap().unwrap();
    let events = faults.events;
    let on = events.iter().position(|e| e.starts_with("recovery-on")).unwrap();
    let moves: Vec<usize> = events.iter().enumerate().filter(|(_, e)| e.starts_with("move ")).map(|(i, _)| i).collect();
    let off = events.iter().position(|e| e.starts_with("recovery-off")).unwrap();
    assert!(on < moves[0] && *moves.last().unwrap() < off, "{events:?}");
    w.done();
}
#[test]
fn b5_and_m6_the_staged_tree_is_flushed_before_it_is_published() {
    let w = world("m6", Opts::new(Layout::TwoRename, NewApp::Healthy));
    let (r, faults) = with_faults(Faults::default(), || w.apply());
    r.unwrap().unwrap();
    let events = faults.events;
    let staged = w.journal().plan.unwrap().staged;
    let publish = crate::updater_swap::tests::event_at(&events, "publish", &staged).expect("published");
    let extract = w.journal().plan.unwrap().extract.join("payload");
    for path in [extract.join("bin").join("app"), extract.join("version"), extract.join("bin"), extract.join(swap::MARKER), extract.clone()] {
        let synced = crate::updater_swap::tests::event_at(&events, "sync", &path);
        assert!(synced.is_some_and(|i| i < publish), "{} was not flushed before publishing: {events:?}", path.display());
    }
    w.done();
}
#[test]
fn m3_a_damaged_journal_and_ledger_during_the_watch_still_block_the_failed_version() {
    let w = world("m3", Opts::new(Layout::native(), NewApp::DamagesJournalThenCrashes));
    w.apply().unwrap();
    assert_eq!(w.version(), OLD);
    let journal = w.journal();
    assert_eq!(journal.phase, Phase::RolledBack);
    assert!(journal.is_blocked(NEW) && journal.is_blocked("0.9.0"), "{:?}", journal.blocked);
    assert_eq!(fs::read(w.dir.join("blocked.damaged-0.json")).unwrap(), b"[\"0.9.0\",\"0.");
    w.done();
}
#[test]
fn m4_a_confirmation_survives_the_next_transaction_starting() {
    let w = world("m4", Opts::new(Layout::native(), NewApp::ConfirmsThenDownloads));
    w.apply().unwrap();
    w.join_apps();
    assert_eq!(w.version(), NEW, "a healthy, confirmed version was rolled back");
    let journal = w.journal();
    assert_eq!((journal.phase, journal.version.as_deref()), (Phase::Downloading, Some("3.0.0")), "the next transaction was disturbed");
    assert!(!journal.is_blocked("3.0.0") && !journal.is_blocked(NEW));
    w.done();
}
#[test]
fn m5_and_revalidation_refuse_before_anything_moves() {
    let cases: Vec<(&str, Opts, Box<dyn Fn(&World)>, &str)> = vec![
        ("target", Opts { target: Some("windows-arm64"), ..Opts::new(Layout::native(), NewApp::Healthy) }, Box::new(|_| {}), "target"),
        ("key", Opts::new(Layout::native(), NewApp::Healthy), Box::new(|w| fs::write(w.dir.join(SIGNATURE), [0u8; 64]).unwrap()), "signature"),
        ("tamper", Opts::new(Layout::native(), NewApp::Healthy), Box::new(|w| fs::write(w.dir.join(ARCHIVE), b"pretend this is the signed update archivE").unwrap()), "no longer matches"),
        ("blocked", Opts::new(Layout::native(), NewApp::Healthy), Box::new(|w| { state::update(&w.dir, |s| s.blocked.push(NEW.into())).unwrap(); }), "blocked"),
        ("floor", Opts { floor: "1.5.0", ..Opts::new(Layout::native(), NewApp::Healthy) }, Box::new(|_| {}), "BelowFloor"),
        ("os", Opts { min_os: Some("9999.0"), ..Opts::new(Layout::native(), NewApp::Healthy) }, Box::new(|_| {}), "UnsupportedOs"),
    ];
    for (name, opts, tamper, needle) in cases {
        let w = world(name, opts);
        let job = w.handoff().unwrap();
        tamper(&w);
        let error = drive(&job, &w.hooks()).unwrap_err();
        assert!(format!("{error:#}").contains(needle), "{name}: {error:#}");
        assert_eq!(*w.materialized.lock().unwrap(), 0, "{name}: extracted an unverified archive");
        assert_eq!(w.version(), OLD, "{name}");
        let journal = w.journal();
        assert_eq!(journal.phase, Phase::Aborted, "{name}");
        assert!(!journal.is_blocked(NEW) || name == "blocked", "{name}: a refusal is not a bad version");
        w.done();
    }
}
#[test]
fn a_fabricated_job_or_plan_is_never_acted_on() {
    let w = world("forged", Opts::new(Layout::native(), NewApp::Healthy));
    let job = w.handoff().unwrap();
    let mut other_txn = job.clone();
    other_txn.txn ^= 1;
    other_txn.plan.txn ^= 1;
    assert!(drive(&other_txn, &w.hooks()).is_err());
    let elsewhere = w.root.join("apps").join("elsewhere");
    write_payload(&elsewhere, "0.0.1", true);
    let mut moved = job.clone();
    moved.plan.install = elsewhere.clone();
    assert!(drive(&moved, &w.hooks()).is_err(), "an install that is not this directory's");
    let mut escaping = job.clone();
    escaping.plan.exe_rel = "../../bin/sh".into();
    assert!(drive(&escaping, &w.hooks()).is_err());
    let mut sibling = job.clone();
    sibling.plan.previous = w.root.join("library");
    assert!(drive(&sibling, &w.hooks()).is_err(), "a sibling path that is user data");
    assert_eq!(fs::read_to_string(elsewhere.join("version")).unwrap(), "0.0.1");
    assert_eq!((w.version(), *w.materialized.lock().unwrap()), (OLD.to_string(), 0));
    assert_eq!(fs::read_to_string(w.root.join("library/song.json")).unwrap(), "mine");
    w.done();
}
#[test]
fn the_swap_waits_for_the_running_app_and_postpones_when_it_stays() {
    let w = world("lease", Opts::new(Layout::native(), NewApp::Healthy));
    let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
    let hooks = Hooks { app_exit_wait: Duration::from_millis(600), ..w.hooks() };
    let job = w.handoff().unwrap();
    assert!(drive(&job, &hooks).is_err());
    assert_eq!(w.version(), OLD, "the payload must not move while the app still runs");
    let journal = w.journal();
    assert_eq!((journal.phase, journal.plan.is_none()), (Phase::Ready, true), "postponed: ready for the next restart");
    assert!(!swap::sibling_paths(&w.install).unwrap().0.exists());
    drop(lease);
    w.apply().unwrap();
    assert_eq!(w.version(), NEW);
    drop(hooks);
    w.done();
}

// ---- the app's start ---------------------------------------------------------------------
#[test]
fn m1_a_start_never_cleans_up_under_a_live_applier() {
    let w = world("m1", Opts::new(Layout::native(), NewApp::Healthy));
    let job = w.handoff().unwrap();
    fs::create_dir_all(job.plan.extract.join("payload")).unwrap();
    let applier = lock::try_acquire(&apply_lock(&w.dir)).unwrap().unwrap();
    let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
    assert_eq!(start_w(&w, OLD), Boot::Normal);
    assert!(job.plan.extract.join("payload").exists(), "a live applier's extraction was deleted");
    assert_eq!(w.journal().phase, Phase::Planned, "a live applier's journal was changed");
    drop((applier, lease));
    w.done();
}
#[test]
fn m2_an_interrupted_download_is_recovered_at_the_next_start() {
    let w = world("m2", Opts::new(Layout::native(), NewApp::Healthy));
    state::save(&w.dir, &State { phase: Phase::Downloading, version: Some(NEW.into()), txn: 9, ..State::default() }).unwrap();
    fs::write(w.dir.join("update.download"), b"partial").unwrap();
    let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
    assert_eq!(start_w(&w, OLD), Boot::Normal);
    drop(lease);
    assert!(w.journal().can_download(), "an interrupted download must not hold off checks forever");
    assert!(!w.dir.join("update.download").exists());
    w.done();
}
#[test]
fn a_second_unconfirmed_start_rolls_back_and_a_stuck_rollback_gives_up() {
    let w = world("second", Opts::new(Layout::native(), NewApp::Crashes));
    let job = w.handoff().unwrap();
    let (recorded, faults) = with_faults(Faults::default(), || drive(&job, &w.hooks()));
    recorded.unwrap().unwrap();
    w.done();
    let pending = faults.hits.iter().position(|p| p == "journal-PendingConfirm").unwrap();
    let w = world("second", Opts::new(Layout::native(), NewApp::Crashes));
    let job = w.handoff().unwrap();
    let (r, _) = with_faults(Faults { kill_at: Some(pending), ..Faults::default() }, || drive(&job, &w.hooks()));
    assert!(r.is_err());
    let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
    assert_eq!(start_w(&w, NEW), Boot::FirstLaunch, "first start of the new version");
    assert!(matches!(start_w(&w, NEW), Boot::Delegate(_)), "second unconfirmed start");
    // If the delegated rollback keeps failing, a start stops handing it over.
    for _ in 1..MAX_RESUMES {
        assert!(matches!(start_w(&w, NEW), Boot::Delegate(_)));
    }
    assert!(matches!(start_w(&w, NEW), Boot::Disabled(_)));
    drop(lease);
    drive(&w.job(), &w.hooks()).unwrap();
    assert_eq!(w.version(), OLD);
    w.assert_settled("second line");
    w.done();
}

// ---- round 3 -------------------------------------------------------------------------------
#[test]
fn r2_a_watched_confirmation_killed_after_its_receipt_settles_the_journal() {
    for layout in layouts() {
        let w = world("r2-watch", Opts::new(layout, NewApp::KilledAfterReceipt));
        w.apply().unwrap();
        w.join_apps();
        let journal = w.journal();
        assert_eq!((w.version(), journal.phase), (NEW.to_string(), Phase::Confirmed), "{layout:?}: the receipt was not settled");
        w.assert_settled(&format!("r2 watch {layout:?}"));
        w.done();
    }
}
#[test]
fn r2_a_receipt_without_its_journal_update_is_never_rolled_back_later() {
    for layout in layouts() {
        // The applier dies before launching; the user starts the new version,
        // which confirms but is killed between the receipt and the journal.
        let w = world("r2-record", Opts::new(layout, NewApp::Healthy));
        let job = w.handoff().unwrap();
        let (r, faults) = with_faults(Faults::default(), || drive(&job, &w.hooks()));
        r.unwrap().unwrap();
        w.done();
        let pending = faults.hits.iter().position(|p| p == "journal-PendingConfirm").unwrap();
        let w = world("r2", Opts::new(layout, NewApp::Healthy));
        let job = w.handoff().unwrap();
        assert!(with_faults(Faults { kill_at: Some(pending), ..Faults::default() }, || drive(&job, &w.hooks())).0.is_err());
        let lease = lock::try_acquire(&instance_lock(&w.dir)).unwrap().unwrap();
        assert_eq!(start_w(&w, NEW), Boot::FirstLaunch);
        let (r, faults) = with_faults(Faults { kill_at: Some(0), ..Faults::default() }, || state::confirm(&w.dir, NEW));
        assert!(r.is_err() && faults.hits == ["confirm-receipt"], "{:?}", faults.hits);
        assert_eq!((w.journal().phase, w.journal().attempts), (Phase::PendingConfirm, 1));
        // The next start would count a second unconfirmed launch: the receipt says otherwise.
        assert_eq!(start_w(&w, NEW), Boot::Normal, "{layout:?}: a confirmed version was handed to rollback");
        drop(lease);
        assert_eq!(w.journal().phase, Phase::Confirmed);
        assert!(!w.journal().is_blocked(NEW));
        w.assert_settled(&format!("r2 {layout:?}"));
        w.done();
    }
}
#[test]
fn r4_uninstall_removes_the_current_payload_inventory_and_nothing_else() {
    let root = temp("r4");
    let install = root.join("SingZ Native");
    let files = ["singz-gpui-player.exe", "old.dll", "engines/llama-server.exe", "added/in/n1/new.dll", "README.txt"];
    for name in files {
        let path = install.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, name).unwrap();
    }
    fs::write(install.join(swap::MARKER), "{}").unwrap();
    fs::write(install.join("Uninstall.exe"), "nsis").unwrap(); // removed by the uninstaller itself
    fs::create_dir_all(install.join("added/user")).unwrap();
    fs::write(install.join("added/user/notes.txt"), "mine").unwrap(); // in no inventory
    fs::write(root.join("outside.txt"), "keep").unwrap();
    let inventory = |names: &[&str]| {
        let files: Vec<_> = names.iter().map(|n| serde_json::json!({"path": n})).collect();
        fs::write(install.join("manifest.json"), serde_json::json!({"schema": 1, "files": files}).to_string()).unwrap();
    };
    // An inventory with one unsafe path is refused before anything is deleted.
    inventory(&["old.dll", "../outside.txt"]);
    assert!(uninstall_payload(&install, Path::new("singz-gpui-player.exe")).is_err());
    assert!(install.join("old.dll").exists() && root.join("outside.txt").exists());
    // The N+1 inventory (after an update that added a nested file).
    inventory(&files);
    uninstall_payload(&install, Path::new("singz-gpui-player.exe")).unwrap();
    for gone in ["old.dll", "engines", "added/in", "README.txt", "manifest.json", swap::MARKER] {
        assert!(!install.join(gone).exists(), "{gone} was left behind");
    }
    assert!(install.join("singz-gpui-player.exe").exists(), "the running executable is the uninstaller's to delete");
    assert_eq!(fs::read_to_string(install.join("added/user/notes.txt")).unwrap(), "mine");
    assert_eq!(fs::read_to_string(root.join("outside.txt")).unwrap(), "keep");
    fs::remove_dir_all(root).unwrap();
}

// ---- round 4 -------------------------------------------------------------------------------
/// An app that neither confirms nor exits on its own.
struct Silent;
impl Proc for Silent {
    fn exited(&mut self) -> Result<Option<String>> {
        Ok(None)
    }
    fn kill(&mut self) {}
}
#[test]
fn f5_a_receipt_published_after_the_last_watch_check_wins_over_the_rollback() {
    use crate::updater_swap::PAUSE;
    use std::sync::Barrier;
    for layout in layouts() {
        let w = world("f5", Opts::new(layout, NewApp::Healthy));
        let job = w.handoff().unwrap();
        let barriers = Arc::new((Barrier::new(2), Barrier::new(2)));
        std::thread::scope(|scope| {
            let (w, job, b) = (&w, &job, barriers.clone());
            let applier = scope.spawn(move || {
                PAUSE.with(|p| *p.borrow_mut() = Some(("watch-expired", b)));
                let hooks = Hooks {
                    launch: Box::new(|_| Ok(Box::new(Silent) as Box<dyn Proc>)),
                    deadline: Duration::from_millis(300),
                    ..w.hooks()
                };
                drive(job, &hooks)
            });
            barriers.0.wait(); // the watch gave up; the rollback is not journaled yet
            // The app confirms now and dies between its receipt and the journal.
            let (r, _) = with_faults(Faults { kill_at: Some(0), ..Faults::default() }, || state::confirm(&w.dir, NEW));
            assert!(r.is_err());
            barriers.1.wait();
            applier.join().unwrap().unwrap();
        });
        let journal = w.journal();
        assert_eq!((w.version(), journal.phase), (NEW.to_string(), Phase::Confirmed), "{layout:?}: a confirmed version was rolled back");
        assert!(!journal.is_blocked(NEW), "{layout:?}: a confirmed version was blocked");
        w.done();
    }
}

//! The applier and the transaction it drives.
//!
//! The applier is a copy of this executable, outside the payload being
//! replaced. It reads one job (`<updates>/<id>/job.json`: the install-scoped
//! directory, the transaction id and its immutable plan) and drives the
//! journal's phase to an end: verify and stage, wait for the app to exit,
//! swap, launch the new version and watch it until it confirms, or restore
//! the old payload. Each phase is written before the mutation it guards, and
//! every move is chosen from the payloads observed on disk
//! ([`swap::converge`]), so a run killed at any point is finished or reversed
//! by the next one, or by the app's next start ([`reconcile_at_startup`]).
use crate::{
    updater_lock as lock, updater_manifest as manifest, updater_stage as stage,
    updater_state::{self as state, Layout, Phase, Plan, State},
    updater_swap::{self as swap, Role, Slot, Who, kill_point},
};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::{Component, Path, PathBuf},
    process::{Child, Command, Stdio},
    time::{Duration, Instant},
};

pub const FLAG: &str = "--apply-update";
/// Run by the Windows uninstaller: delete what the installed payload's own
/// inventory lists (an update replaces it, so it is always current).
pub const UNINSTALL_FLAG: &str = "--uninstall-payload";
/// D-04: the new version has 60 s to confirm its first launch.
const WATCHDOG_DEADLINE: Duration = Duration::from_secs(60);
/// How long the applier waits for the app to release its install lease.
const APP_EXIT_WAIT: Duration = Duration::from_secs(120);
/// How often a start may hand an unfinished rollback back to the applier.
const MAX_RESUMES: u8 = 3;
pub const ARCHIVE: &str = "update.zip";
pub const MANIFEST: &str = "manifest.json";
pub const SIGNATURE: &str = "manifest.sig";

/// What the app hands the applier. Everything else is checked against the
/// install-scoped journal this file sits in.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Job {
    pub dir: PathBuf,
    pub txn: u64,
    pub plan: Plan,
}

pub(crate) fn log(dir: &Path, line: &str) {
    let _ = fs::create_dir_all(dir);
    if let Ok(mut file) = state::no_follow(fs::OpenOptions::new().create(true).append(true)).open(dir.join("applier.log")) {
        let secs = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let _ = writeln!(file, "{secs} {line}");
    }
}
pub fn job_path(dir: &Path) -> PathBuf {
    dir.join("job.json")
}
pub fn instance_lock(dir: &Path) -> PathBuf {
    dir.join("instance.lock")
}
pub fn apply_lock(dir: &Path) -> PathBuf {
    dir.join("apply.lock")
}

// ---- processes ----------------------------------------------------------------
/// A launched app, as the watchdog sees it.
pub trait Proc {
    /// `Some(status)` once it has exited.
    fn exited(&mut self) -> Result<Option<String>>;
    fn kill(&mut self);
}
impl Proc for Child {
    fn exited(&mut self) -> Result<Option<String>> {
        Ok(self.try_wait()?.map(|status| status.to_string()))
    }
    fn kill(&mut self) {
        let _ = Child::kill(self);
        let _ = self.wait();
    }
}
fn launch_child(plan: &Plan) -> Result<Box<dyn Proc>> {
    let exe = plan.install.join(&plan.exe_rel);
    let child = Command::new(&exe)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .with_context(|| format!("launch {}", exe.display()))?;
    Ok(Box::new(child))
}

/// The applier's environment. Production fills it in [`production`]; tests
/// substitute the archive, the launched app and the recovery registration.
pub struct Hooks<'a> {
    pub keys: Vec<[u8; 32]>,
    pub host_os: Option<String>,
    /// The update target this build accepts.
    pub target: String,
    /// Place the verified payload inside `plan.extract`; returns its root.
    pub materialize: Box<dyn Fn(&Plan, &Path) -> Result<PathBuf> + 'a>,
    pub launch: Box<dyn Fn(&Plan) -> Result<Box<dyn Proc>> + 'a>,
    /// Register (`true`) or remove the sign-in recovery entry, verified.
    pub recovery: Box<dyn Fn(&Job, bool) -> Result<()> + 'a>,
    pub app_exit_wait: Duration,
    pub deadline: Duration,
}
fn production_materialize(plan: &Plan, archive: &Path) -> Result<PathBuf> {
    stage::materialize(archive, &plan.install, &plan.exe_rel, &plan.extract, &|| false)
}
pub fn production() -> Hooks<'static> {
    Hooks {
        keys: manifest::trusted_keys(),
        host_os: manifest::host_os_version(),
        target: crate::updater_fetch::target().to_owned(),
        materialize: Box::new(production_materialize),
        launch: Box::new(launch_child),
        recovery: Box::new(recovery_entry),
        app_exit_wait: APP_EXIT_WAIT,
        deadline: WATCHDOG_DEADLINE,
    }
}

// ---- sign-in recovery (Windows) ------------------------------------------------------
/// Windows has no atomic directory exchange, so while payloads move the install
/// path can be briefly absent. A per-user Run entry re-runs this job at the
/// next sign-in if the applier dies then. It is registered and read back
/// before any rename, and removed only once the install is whole again.
#[cfg(windows)]
pub fn recovery_entry(job: &Job, enable: bool) -> Result<()> {
    let key = r"HKCU\Software\Microsoft\Windows\CurrentVersion\Run";
    let value = format!("SingZUpdateRecover-{}", job.dir.file_name().and_then(|n| n.to_str()).unwrap_or("x"));
    let query = || Command::new("reg").args(["query", key, "/v", &value]).stdin(Stdio::null()).output();
    if enable {
        let exe = std::env::current_exe()?;
        let data = format!("\"{}\" {FLAG} \"{}\"", exe.display(), job_path(&job.dir).display());
        let status = Command::new("reg")
            .args(["add", key, "/v", &value, "/t", "REG_SZ", "/d", &data, "/f"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .context("run reg add")?;
        ensure!(status.success(), "registering the recovery entry failed: {status}");
        let read = query().context("run reg query")?;
        ensure!(
            read.status.success() && String::from_utf8_lossy(&read.stdout).contains(&data),
            "the recovery entry did not read back"
        );
    } else {
        let _ = Command::new("reg")
            .args(["delete", key, "/v", &value, "/f"])
            .stdin(Stdio::null())
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status();
        ensure!(!query().context("run reg query")?.status.success(), "the recovery entry is still registered");
    }
    flush_run_key()
}
/// Make the Run key durable now rather than at the next lazy hive flush.
#[cfg(windows)]
fn flush_run_key() -> Result<()> {
    #[link(name = "advapi32")]
    unsafe extern "system" {
        fn RegOpenKeyExW(key: isize, sub_key: *const u16, options: u32, sam: u32, result: *mut isize) -> i32;
        fn RegFlushKey(key: isize) -> i32;
        fn RegCloseKey(key: isize) -> i32;
    }
    const HKEY_CURRENT_USER: isize = 0x8000_0001_u32 as i32 as isize;
    const KEY_READ: u32 = 0x2_0019;
    let sub: Vec<u16> = r"Software\Microsoft\Windows\CurrentVersion\Run".encode_utf16().chain(Some(0)).collect();
    let mut key: isize = 0;
    // SAFETY: a NUL-terminated wide string and a valid out-pointer.
    let rc = unsafe { RegOpenKeyExW(HKEY_CURRENT_USER, sub.as_ptr(), 0, KEY_READ, &mut key) };
    ensure!(rc == 0, "open the Run key: error {rc}");
    // SAFETY: `key` was just opened and is closed once.
    let rc = unsafe { RegFlushKey(key) };
    unsafe { RegCloseKey(key) };
    ensure!(rc == 0, "flush the Run key: error {rc}");
    Ok(())
}
/// macOS exchanges atomically: the install path is never absent.
#[cfg(not(windows))]
pub fn recovery_entry(_job: &Job, _enable: bool) -> Result<()> {
    Ok(())
}

// ---- the app's side: hand over, and spawn ----------------------------------------------
/// Fix the plan and commit the handoff (`ready -> planned`). Nothing on disk
/// moves until the applier has read it back.
pub fn handoff(dir: &Path, install: &Path, exe_rel: &Path, running: &str, layout: Layout) -> Result<Job> {
    let _applier = lock::try_acquire(&apply_lock(dir))?.context("an update is already being applied")?;
    let _journal = state::journal_lock(dir)?;
    let journal = state::load(dir)?;
    ensure!(journal.phase == Phase::Ready, "no staged update");
    ensure!(dir.join(ARCHIVE).is_file(), "the staged archive is missing");
    let signed = manifest::parse(&fs::read(dir.join(MANIFEST)).context("read saved manifest")?)?;
    ensure!(journal.version.as_deref() == Some(signed.version.as_str()), "saved manifest is for another version");
    let (staged, previous) = swap::sibling_paths(install)?;
    let plan = Plan {
        txn: journal.txn,
        from: running.to_owned(),
        to: signed.version.clone(),
        target: signed.target.clone(),
        archive_sha256: signed.archive.sha256.to_ascii_lowercase(),
        archive_bytes: signed.archive.bytes,
        install: install.to_path_buf(),
        exe_rel: exe_rel.to_path_buf(),
        staged,
        previous,
        failed: swap::failed_path(install)?,
        extract: swap::extract_path(install)?,
        layout,
        old_id: match layout {
            Layout::Exchange => Some(swap::dir_id(install).context("the install has no directory identity")?),
            Layout::TwoRename => None,
        },
    };
    validate_plan(dir, &plan)?;
    if layout == Layout::TwoRename {
        // Inert until the journal names this transaction.
        swap::write_marker(install, &plan, Role::Old)?;
    }
    kill_point("handoff-marked")?;
    let job = Job { dir: dir.to_path_buf(), txn: plan.txn, plan: plan.clone() };
    state::write_atomic(&job_path(dir), &serde_json::to_vec(&job)?)?;
    kill_point("handoff-job")?;
    let mut journal = journal;
    journal.planned(plan)?;
    state::save(dir, &journal)?;
    kill_point("handoff-planned")?;
    Ok(job)
}
/// Copy this executable aside and start it on the job. The caller then quits;
/// the applier waits on the install's instance lease, which the OS releases
/// when the app exits or dies.
pub fn spawn(job: &Job) -> Result<()> {
    let applier_dir = job.dir.join("applier");
    state::secure_dir(&job.dir)?;
    state::secure_dir(&applier_dir)?;
    let exe = std::env::current_exe()?;
    let name = format!("singz-applier-{}", job.dir.file_name().and_then(|n| n.to_str()).unwrap_or("x"));
    let copy = applier_dir.join(if cfg!(windows) { format!("{name}.exe") } else { name });
    if copy != exe {
        let _ = fs::remove_file(&copy);
        copy_new(&exe, &copy).context("copy applier executable")?;
        if cfg!(windows) {
            // Load-time dependencies sit beside the executable on Windows.
            if let Some(source) = exe.parent() {
                for entry in fs::read_dir(source)?.flatten() {
                    if entry.path().extension().is_some_and(|e| e.eq_ignore_ascii_case("dll")) {
                        let target = applier_dir.join(entry.file_name());
                        let _ = fs::remove_file(&target);
                        let _ = copy_new(&entry.path(), &target);
                    }
                }
            }
        }
    }
    let path = job_path(&job.dir);
    state::write_atomic(&path, &serde_json::to_vec(job)?)?;
    Command::new(&copy)
        .arg(FLAG)
        .arg(&path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .spawn()
        .context("start applier")?;
    Ok(())
}

/// Copy into a file this call creates (never through an existing name).
fn copy_new(from: &Path, to: &Path) -> Result<()> {
    let mut options = fs::OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::mode(&mut options, 0o700);
    let mut out = state::no_follow(&mut options).open(to)?;
    std::io::copy(&mut fs::File::open(from)?, &mut out)?;
    out.sync_all()?;
    Ok(())
}
/// `main()` calls this first; it returns only when this is a normal launch.
pub fn run_if_requested() {
    let mut args = std::env::args_os();
    let first = args.nth(1);
    if first.as_deref() == Some(std::ffi::OsStr::new(UNINSTALL_FLAG)) {
        let code = match std::env::current_exe().map_err(anyhow::Error::from).and_then(|exe| {
            let dir = exe.parent().context("executable has no directory")?.to_path_buf();
            uninstall_payload(&dir, exe.file_name().map(Path::new).context("executable has no name")?)
        }) {
            Ok(()) => 0,
            Err(error) => {
                eprintln!("payload removal failed: {error:#}");
                1
            }
        };
        std::process::exit(code);
    }
    if first.as_deref() != Some(std::ffi::OsStr::new(FLAG)) {
        return;
    }
    let code = match args.next().map(PathBuf::from).map(|p| run(&p)) {
        Some(Ok(())) => 0,
        Some(Err(error)) => {
            eprintln!("update applier failed: {error:#}");
            1
        }
        None => 2,
    };
    std::process::exit(code);
}
fn run(job_file: &Path) -> Result<()> {
    let job: Job = serde_json::from_slice(&fs::read(job_file)?).context("read update job")?;
    ensure!(job_file.parent() == Some(job.dir.as_path()), "job is not in its own updater directory");
    // Act only from a directory proven to be this user's private one.
    state::secure_dir(&job.dir).context("the update directory is not trusted")?;
    let outcome = drive(&job, &production());
    if let Err(error) = &outcome {
        log(&job.dir, &format!("applier error: {error:#}"));
    }
    outcome
}

pub use crate::updater_uninstall::uninstall_payload;

// ---- checks ---------------------------------------------------------------------------
/// Every path in a plan must be the one this updater directory implies.
pub fn validate_plan(dir: &Path, plan: &Plan) -> Result<()> {
    ensure!(plan.txn != 0, "plan has no transaction");
    ensure!(plan.install.is_absolute(), "journal install is not absolute");
    ensure!(dir == state::coordination_dir(&plan.install)?, "updater directory does not belong to the journal's install");
    ensure!(
        !plan.exe_rel.as_os_str().is_empty() && plan.exe_rel.components().all(|c| matches!(c, Component::Normal(_))),
        "journal executable path is not relative"
    );
    let (staged, previous) = swap::sibling_paths(&plan.install)?;
    ensure!(
        plan.staged == staged
            && plan.previous == previous
            && plan.failed == swap::failed_path(&plan.install)?
            && plan.extract == swap::extract_path(&plan.install)?,
        "plan paths are not this install's siblings"
    );
    ensure!(manifest::valid_version(&plan.from) && manifest::valid_version(&plan.to), "plan versions are invalid");
    ensure!(plan.layout != Layout::Exchange || plan.old_id.is_some(), "plan has no install identity");
    Ok(())
}
/// Signature, target, version, blocked list, compatibility and archive digest,
/// again, at the apply boundary.
fn revalidate(dir: &Path, plan: &Plan, journal: &State, hooks: &Hooks) -> Result<()> {
    let raw = fs::read(dir.join(MANIFEST)).context("read saved manifest")?;
    let signature = fs::read(dir.join(SIGNATURE)).context("read saved signature")?;
    manifest::verify(&raw, &signature, &hooks.keys)?;
    let signed = manifest::parse(&raw)?;
    ensure!(
        signed.target == hooks.target && plan.target == hooks.target,
        "update is for target {} but this build is {}",
        signed.target,
        hooks.target
    );
    ensure!(signed.version == plan.to, "saved manifest is for another version");
    ensure!(
        signed.archive.sha256.eq_ignore_ascii_case(&plan.archive_sha256) && signed.archive.bytes == plan.archive_bytes,
        "saved manifest does not match the plan"
    );
    ensure!(!journal.is_blocked(&plan.to), "this version is blocked");
    ensure!(manifest::compare(&signed.version, &plan.from).is_gt(), "update is not newer than the running version");
    match manifest::compat(&signed, &plan.from, hooks.host_os.as_deref()) {
        manifest::Compat::Ok => {}
        other => bail!("update is not compatible with this install: {other:?}"),
    }
    let mut file = fs::File::open(dir.join(ARCHIVE)).context("open retained archive")?;
    let (mut hash, mut bytes, mut buf) = (Sha256::new(), 0u64, vec![0u8; 64 * 1024]);
    loop {
        let n = file.read(&mut buf)?;
        if n == 0 {
            break;
        }
        bytes += n as u64;
        hash.update(&buf[..n]);
    }
    let digest: String = hash.finalize().iter().map(|b| format!("{b:02x}")).collect();
    ensure!(
        bytes == signed.archive.bytes && digest.eq_ignore_ascii_case(&signed.archive.sha256),
        "retained archive no longer matches the signed manifest"
    );
    Ok(())
}

// ---- the transaction -----------------------------------------------------------------
/// Extract, verify, mark, flush and publish the new payload at `staged`.
/// Returns its identity (`Exchange`).
fn stage_payload(job: &Job, journal: &State, hooks: &Hooks) -> Result<Option<u64>> {
    let (dir, plan) = (&job.dir, &job.plan);
    revalidate(dir, plan, journal, hooks)?;
    let disk = swap::observe(plan, None);
    ensure!(disk.get(Slot::Install) == Who::Old, "the install is not the payload this update was planned against");
    // A partial or unjournaled staging attempt is redone from the archive.
    ensure!(disk.get(Slot::Staged) != Who::Old, "the old payload sits at the staging path");
    swap::remove_tree(&plan.staged)?;
    let root = (hooks.materialize)(plan, &dir.join(ARCHIVE))?;
    ensure!(root.starts_with(&plan.extract), "the payload was not extracted into the scratch directory");
    ensure!(root.join(&plan.exe_rel).is_file(), "update payload does not contain the application executable");
    if plan.layout == Layout::TwoRename {
        swap::write_marker(&root, plan, Role::New)?;
    }
    // Everything inside must be durable before the name makes it visible.
    swap::sync_tree(&root)?;
    kill_point("stage-flushed")?;
    fs::rename(&root, &plan.staged).context("publish staged payload")?;
    swap::event("publish", &plan.staged);
    swap::sync_dir(plan.staged.parent().context("staging parent")?)?;
    let _ = swap::remove_tree(&plan.extract);
    kill_point("stage-published")?;
    let new_id = match plan.layout {
        Layout::Exchange => Some(swap::dir_id(&plan.staged).context("staged payload has no identity")?),
        Layout::TwoRename => None,
    };
    state::record_new_id(dir, plan.txn, new_id)?;
    Ok(new_id)
}
/// Files the installer wrote beside the payload (not part of any update
/// archive) must survive a swap, or Windows uninstall would be lost (D-04 s5).
fn carry_over_installer_files(plan: &Plan) -> Result<()> {
    for name in ["Uninstall.exe"] {
        let (from, to) = (plan.previous.join(name), plan.install.join(name));
        if from.is_file() && !to.exists() {
            let tmp = plan.install.join(format!("{name}.carry"));
            fs::copy(&from, &tmp)?;
            swap::sync_tree(&tmp)?;
            fs::rename(&tmp, &to)?;
            swap::sync_dir(&plan.install)?;
        }
    }
    Ok(())
}
fn watch(dir: &Path, plan: &Plan, child: &mut Box<dyn Proc>, deadline: Duration) -> Result<()> {
    let started = Instant::now();
    loop {
        // The receipt is the transaction's own: a later download cannot erase it.
        if state::is_confirmed(dir, plan.txn) {
            return Ok(());
        }
        if let Some(status) = child.exited()? {
            if state::is_confirmed(dir, plan.txn) {
                return Ok(());
            }
            bail!("exited before confirming: {status}");
        }
        ensure!(started.elapsed() <= deadline, "no confirmation within the deadline");
        std::thread::sleep(Duration::from_millis(100));
    }
}
/// Under the journal lock (inside `update_txn`): a receipt published before
/// this moment wins; otherwise the new version is blamed and rolled back.
/// Confirmation takes the same lock, so the two can never both succeed.
fn fail_unless_confirmed(dir: &Path, s: &mut State) -> Result<()> {
    if state::settle_in(dir, s) {
        log(dir, "a confirmation arrived before the rollback; keeping the new version");
        return Ok(());
    }
    s.rolling_back(true)
}
/// The journal phase a damaged journal is rebuilt with, from the disk.
fn fallback_phase(dir: &Path, plan: &Plan) -> Phase {
    if state::is_confirmed(dir, plan.txn) {
        return Phase::Confirmed;
    }
    // Anything but the old payload is treated as a swap to undo.
    match swap::observe(plan, state::recorded_new_id(dir, plan.txn)).get(Slot::Install) {
        Who::Old => Phase::Aborted,
        _ => Phase::RollingBack,
    }
}
fn relaunch_old(job: &Job, hooks: &Hooks, held: Option<lock::Lock>) {
    // Launch only once the app that handed over is gone, or the new process
    // would find the instance taken and leave.
    let lease = held.map(Ok).unwrap_or_else(|| lock::acquire_wait(&instance_lock(&job.dir), hooks.app_exit_wait));
    match lease {
        Ok(lease) => {
            drop(lease);
            if let Err(error) = (hooks.launch)(&job.plan) {
                log(&job.dir, &format!("could not relaunch the previous version: {error:#}"));
            }
        }
        Err(error) => log(&job.dir, &format!("not relaunching: {error:#}")),
    }
}

/// Drive the transaction from whatever phase the journal is in to an end.
pub fn drive(job: &Job, hooks: &Hooks) -> Result<()> {
    let (dir, plan) = (job.dir.as_path(), &job.plan);
    ensure!(job.txn == plan.txn, "job and plan disagree on the transaction");
    validate_plan(dir, plan)?;
    let _apply = lock::acquire_wait(&apply_lock(dir), Duration::from_secs(60))?;
    let mut instance: Option<lock::Lock> = None;
    let mut child: Option<Box<dyn Proc>> = None;
    let set = |change: &dyn Fn(&mut State) -> Result<()>| -> Result<State> {
        let state = state::update_txn(dir, plan, fallback_phase(dir, plan), |s| change(s))?;
        kill_point(&format!("journal-{:?}", state.phase))?;
        Ok(state)
    };
    for _ in 0..32 {
        let journal = state::load_txn(dir, plan, fallback_phase(dir, plan))?;
        ensure!(journal.plan.as_ref().is_none_or(|p| p == plan), "the job's plan differs from the journal's");
        match journal.phase {
            Phase::Planned => {
                log(dir, &format!("applier start {} -> {}", plan.from, plan.to));
                match stage_payload(job, &journal, hooks) {
                    Ok(new_id) => {
                        set(&|s| s.staged(new_id))?;
                    }
                    Err(error) => {
                        log(dir, &format!("update refused before the swap: {error:#}"));
                        let _ = swap::remove_tree(&plan.extract);
                        set(&|s| {
                            s.abort();
                            Ok(())
                        })?;
                        let _ = swap::discard_staged(plan, journal.new_id);
                        relaunch_old(job, hooks, instance.take());
                        return Err(error);
                    }
                }
            }
            Phase::Staged => {
                if instance.is_none() {
                    match lock::acquire_wait(&instance_lock(dir), hooks.app_exit_wait) {
                        Ok(lease) => instance = Some(lease),
                        Err(error) => {
                            log(dir, &format!("the app did not exit; update postponed: {error:#}"));
                            set(&|s| {
                                s.phase = Phase::Ready;
                                s.plan = None;
                                s.new_id = None;
                                Ok(())
                            })?;
                            let _ = swap::discard_staged(plan, journal.new_id);
                            return Err(error);
                        }
                    }
                }
                let disk = swap::observe(plan, journal.new_id);
                let registered = if disk.get(Slot::Install) != Who::Old || disk.get(Slot::Staged) != Who::New {
                    Err(anyhow::anyhow!("the staged or installed payload changed before the swap"))
                } else {
                    (hooks.recovery)(job, true).context("the recovery entry could not be registered")
                };
                if let Err(error) = registered {
                    log(dir, &format!("update refused before the swap: {error:#}"));
                    set(&|s| {
                        s.abort();
                        Ok(())
                    })?;
                    let _ = swap::discard_staged(plan, journal.new_id);
                    let _ = (hooks.recovery)(job, false);
                    relaunch_old(job, hooks, instance.take());
                    return Err(error);
                }
                set(&|s| s.swapping())?;
            }
            Phase::Swapping => {
                if instance.is_none() {
                    instance = Some(lock::acquire_wait(&instance_lock(dir), hooks.app_exit_wait)?);
                }
                match swap::converge(plan, journal.new_id, true) {
                    Ok(()) => {
                        set(&|s| s.swapped())?;
                    }
                    Err(error) => {
                        log(dir, &format!("swap failed, restoring the previous payload: {error:#}"));
                        set(&|s| s.rolling_back(false))?;
                    }
                }
            }
            Phase::Swapped => {
                if let Err(error) = carry_over_installer_files(plan) {
                    log(dir, &format!("installer files were not carried over: {error:#}"));
                }
                set(&|s| s.pending(0))?;
            }
            Phase::PendingConfirm => {
                // A confirmation that reached its receipt but not the journal
                // counts: settle it before any launch or rollback decision.
                if state::settle_receipt(dir, plan.txn)? {
                    log(dir, "confirmed");
                    let _ = (hooks.recovery)(job, false);
                    return Ok(());
                }
                // Identities, not the last error, decide what happens next.
                if swap::observe(plan, journal.new_id).get(Slot::Install) != Who::New {
                    log(dir, "the install no longer holds the new version");
                    set(&|s| s.rolling_back(false))?;
                    continue;
                }
                if child.is_none() {
                    if journal.attempts > 0 {
                        // It already started once without confirming (second line).
                        log(dir, "rolling back: the new version never confirmed its first launch");
                        set(&|s| fail_unless_confirmed(dir, s))?;
                        continue;
                    }
                    if let Err(error) = (hooks.recovery)(job, false) {
                        log(dir, &format!("the recovery entry could not be removed: {error:#}"));
                    }
                    drop(instance.take());
                    match (hooks.launch)(plan) {
                        Ok(launched) => {
                            child = Some(launched);
                            log(dir, "new version launched; watching");
                        }
                        Err(error) => {
                            log(dir, &format!("rolling back: {error:#}"));
                            set(&|s| fail_unless_confirmed(dir, s))?;
                            continue;
                        }
                    }
                }
                // Straight into the watch: the journal may already belong to
                // the next transaction; only this transaction's receipt counts.
                let running = child.as_mut().expect("launched above");
                match watch(dir, plan, running, hooks.deadline) {
                    Ok(()) => {
                        // Settle the journal from the receipt, unless the next
                        // transaction already owns it.
                        state::settle_receipt(dir, plan.txn)?;
                        log(dir, "confirmed");
                        return Ok(());
                    }
                    Err(error) => {
                        // A receipt may land right now; the lock decides.
                        swap::pause_point("watch-expired");
                        log(dir, &format!("rolling back: {error:#}"));
                        set(&|s| fail_unless_confirmed(dir, s))?;
                    }
                }
            }
            Phase::RollingBack => {
                if let Some(mut running) = child.take() {
                    running.kill();
                }
                if instance.is_none() {
                    instance = Some(lock::acquire_wait(&instance_lock(dir), hooks.app_exit_wait)?);
                }
                (hooks.recovery)(job, true).context("the recovery entry could not be registered; not moving payloads")?;
                swap::converge(plan, journal.new_id, false)?;
                // The old payload is whole and flushed: sign-in recovery is no
                // longer needed. A start finishes the journal if we die now.
                if let Err(error) = (hooks.recovery)(job, false) {
                    log(dir, &format!("the recovery entry could not be removed: {error:#}"));
                }
                set(&|s| {
                    s.rolled_back();
                    Ok(())
                })?;
                log(dir, "previous version restored");
                let _ = swap::remove_tree(&plan.failed);
                relaunch_old(job, hooks, instance.take());
                return Ok(());
            }
            Phase::Confirmed | Phase::RolledBack | Phase::Aborted => {
                // Settled (by this run or an earlier one): nothing left to move.
                if child.is_some() {
                    log(dir, "confirmed");
                }
                let _ = (hooks.recovery)(job, false);
                return Ok(());
            }
            Phase::Idle | Phase::Downloading | Phase::Ready => bail!("the journal has no transaction to apply"),
        }
    }
    bail!("the update transaction did not settle")
}

// ---- the app's start ----------------------------------------------------------------
/// What the app must do before it creates a window.
#[derive(Debug, PartialEq, Eq)]
pub enum Boot {
    Normal,
    /// First launch of a freshly swapped-in version: confirm when healthy.
    FirstLaunch,
    /// Payloads must move under the running app: start the applier and exit.
    Delegate(Job),
    /// The journal cannot be trusted: run, but never update.
    Disabled(String),
}
/// Reconcile the journal with the disk at every start. The caller holds the
/// install's instance lease, so no other app runs; an applier may.
pub fn reconcile_at_startup(dir: &Path, install: &Path, running: &str) -> Boot {
    reconcile_with(dir, install, running, &recovery_entry)
}
pub fn reconcile_with(dir: &Path, install: &Path, running: &str, recovery: &dyn Fn(&Job, bool) -> Result<()>) -> Boot {
    reconcile(dir, install, running, recovery).unwrap_or_else(|error| Boot::Disabled(format!("{error:#}")))
}
fn reconcile(dir: &Path, install: &Path, running: &str, recovery: &dyn Fn(&Job, bool) -> Result<()>) -> Result<Boot> {
    // The whole decision is one locked step: no confirmation, watchdog or
    // download can change the journal between what is read and what is saved.
    let _journal = state::journal_lock(dir)?;
    let mutate = |change: &dyn Fn(&mut State)| -> Result<()> {
        let mut next = state::load(dir)?;
        change(&mut next);
        state::save(dir, &next)
    };
    let mut journal = state::load(dir).context("update state is unreadable")?;
    let applier = lock::try_acquire(&apply_lock(dir))?;
    if applier.is_some() && state::settle_in(dir, &mut journal) {
        // Confirmed by its receipt; the journal write was interrupted.
        state::save(dir, &journal)?;
    }
    if journal.phase == Phase::Downloading {
        // Downloads run inside the app; the process that ran this one is gone.
        let _ = fs::remove_file(dir.join("update.download"));
        mutate(&State::abort)?;
        return Ok(Boot::Normal);
    }
    if journal.phase.is_settled() {
        if applier.is_some() {
            // Nobody is extracting or moving payloads: scratch can go.
            swap::clean_leftovers(install);
            if journal.phase != Phase::Ready {
                let _ = fs::remove_file(dir.join(ARCHIVE));
            }
            if journal.phase != Phase::Confirmed || state::is_confirmed(dir, journal.txn) {
                state::prune_receipts(dir, journal.txn);
            }
        }
        return Ok(Boot::Normal);
    }
    let plan = journal.plan.clone().context("the journal names no plan")?;
    ensure!(plan.install == install, "the journal belongs to another install");
    validate_plan(dir, &plan)?;
    let Some(_applier) = applier else {
        // The applier is alive. Only the launch it is watching may proceed.
        if journal.phase == Phase::PendingConfirm && running == plan.to && journal.attempts == 0 {
            mutate(&State::first_launch)?;
            return Ok(Boot::FirstLaunch);
        }
        return Ok(Boot::Normal);
    };
    let job = Job { dir: dir.to_path_buf(), txn: plan.txn, plan: plan.clone() };
    let new_id = journal.new_id;
    match swap::observe(&plan, new_id).get(Slot::Install) {
        Who::Other | Who::Missing => {
            // Replaced outside the updater (a manual reinstall): the transaction is moot.
            mutate(&State::abort)?;
            let _ = recovery(&job, false);
            Ok(Boot::Normal)
        }
        Who::Old => {
            // The old payload runs: undo whatever was moving beside it. The
            // reverse steps only discard the new payload; the install stays.
            swap::converge(&plan, new_id, false)?;
            swap::discard_staged(&plan, new_id)?;
            let _ = swap::remove_tree(&plan.extract);
            let to_blame = journal.phase == Phase::PendingConfirm;
            mutate(&|s| {
                if matches!(s.phase, Phase::Swapped | Phase::PendingConfirm | Phase::RollingBack) {
                    s.block_on_rollback |= to_blame;
                    s.phase = Phase::RollingBack;
                    s.rolled_back();
                } else {
                    s.abort();
                }
            })?;
            let _ = recovery(&job, false);
            Ok(Boot::Normal)
        }
        Who::New => {
            ensure!(running == plan.to, "the install holds {} but {running} is running", plan.to);
            match journal.phase {
                Phase::Swapping | Phase::Swapped => {
                    // The applier died after the swap. Retain the old payload
                    // (never touching the running install) and count this
                    // start as the first launch.
                    swap::converge(&plan, new_id, true)?;
                    if let Err(error) = carry_over_installer_files(&plan) {
                        log(dir, &format!("installer files were not carried over: {error:#}"));
                    }
                    let mut next = journal.clone();
                    next.phase = Phase::Swapped;
                    next.pending(1)?;
                    state::save(dir, &next)?;
                    let _ = recovery(&job, false);
                    Ok(Boot::FirstLaunch)
                }
                Phase::PendingConfirm if journal.attempts == 0 => {
                    mutate(&State::first_launch)?;
                    // The install is whole: a recovery entry is no longer needed.
                    let _ = recovery(&job, false);
                    Ok(Boot::FirstLaunch)
                }
                Phase::PendingConfirm | Phase::RollingBack => {
                    ensure!(journal.resumes < MAX_RESUMES, "the failed update could not be rolled back");
                    let blame = journal.phase == Phase::PendingConfirm;
                    let mut next = journal.clone();
                    next.rolling_back(blame)?;
                    next.resumes += 1;
                    state::save(dir, &next)?;
                    Ok(Boot::Delegate(job))
                }
                phase => bail!("the new payload is installed but the journal says {phase:?}"),
            }
        }
    }
}

#[cfg(test)]
#[path = "updater_apply_tests.rs"]
mod tests;

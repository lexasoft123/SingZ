//! Durable updater journal, scoped to one install: `<config>/updates/<id>/`.
//! It names only app payload paths and update bookkeeping; never user data.
//!
//! An apply is one transaction with an immutable [`Plan`] written before the
//! first mutation, and a phase written before each further mutation:
//!
//! ```text
//! idle -> downloading -> ready -> planned -> staged -> swapping -> swapped
//!      -> pending-confirm -> confirmed
//!                         \-> rolling-back -> rolled-back (version blocked)
//! any phase before swapping, or a swap that cannot finish  -> aborted
//! ```
//!
//! The blocked-version ledger lives in its own file so damage to the journal
//! can never make a rolled-back version installable again. Confirmation also
//! leaves a per-transaction receipt that a later transaction cannot overwrite.
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Phase {
    #[default]
    Idle,
    Downloading,
    /// A signed, verified archive is retained and waits for a restart.
    Ready,
    /// The app handed the transaction to the applier; the plan is fixed.
    Planned,
    /// The verified payload is extracted, flushed and published beside the install.
    Staged,
    /// The app has exited and recovery is registered; payloads are moving.
    Swapping,
    /// The install holds the new payload and the previous one is retained.
    Swapped,
    PendingConfirm,
    Confirmed,
    /// Restoring the previous payload; `block_on_rollback` says whether the
    /// new version is to blame.
    RollingBack,
    RolledBack,
    Aborted,
}
impl Phase {
    /// No transaction is in flight: nothing on disk is owed to a plan.
    pub fn is_settled(self) -> bool {
        matches!(self, Phase::Idle | Phase::Ready | Phase::Confirmed | Phase::RolledBack | Phase::Aborted)
    }
}

/// How a platform exchanges payloads, and how it recognises them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Layout {
    /// macOS: one atomic `renamex_np(RENAME_SWAP)`; payloads are recognised by
    /// directory identity (device and inode survive a rename).
    Exchange,
    /// Windows: two renames; payloads are recognised by a marker file bound
    /// to the transaction, because Windows has no directory identity.
    TwoRename,
}
impl Layout {
    pub fn native() -> Layout {
        if cfg!(target_os = "macos") { Layout::Exchange } else { Layout::TwoRename }
    }
}

/// Everything the applier may act on, fixed before the first mutation.
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Plan {
    pub txn: u64,
    pub from: String,
    pub to: String,
    pub target: String,
    pub archive_sha256: String,
    pub archive_bytes: u64,
    pub install: PathBuf,
    pub exe_rel: PathBuf,
    pub staged: PathBuf,
    pub previous: PathBuf,
    pub failed: PathBuf,
    pub extract: PathBuf,
    pub layout: Layout,
    /// `Exchange`: identity of the install directory when the plan was made.
    pub old_id: Option<u64>,
}

#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", default)]
pub struct State {
    pub phase: Phase,
    /// The version in flight, or most recently installed.
    pub version: Option<String>,
    pub previous_version: Option<String>,
    /// Versions that failed their first launch. Persisted in `blocked.json`.
    #[serde(skip)]
    pub blocked: Vec<String>,
    /// Launches of the new version since the swap. The applier's own launch
    /// is attempt 1; a second unconfirmed start rolls back.
    pub attempts: u8,
    /// Identity of this transaction (set when its download starts).
    pub txn: u64,
    pub plan: Option<Plan>,
    /// `Exchange`: identity of the staged payload, recorded with `staged`.
    pub new_id: Option<u64>,
    pub block_on_rollback: bool,
    /// How often a start handed this transaction back to the applier.
    pub resumes: u8,
    pub notes_url: Option<String>,
}

impl State {
    pub fn is_blocked(&self, version: &str) -> bool {
        self.blocked.iter().any(|b| b == version)
    }
    /// A new download may only start when no transaction is in flight.
    pub fn can_download(&self) -> bool {
        matches!(self.phase, Phase::Idle | Phase::Confirmed | Phase::Aborted | Phase::RolledBack)
    }
    pub fn begin_download(&mut self, version: &str) -> Result<u64> {
        ensure!(self.can_download(), "an update transaction is already in flight");
        let blocked = std::mem::take(&mut self.blocked);
        *self = State { phase: Phase::Downloading, version: Some(version.to_owned()), txn: new_txn(), blocked, ..State::default() };
        Ok(self.txn)
    }
    pub fn ready(&mut self, notes_url: Option<String>) -> Result<()> {
        ensure!(self.phase == Phase::Downloading, "nothing was downloading");
        self.phase = Phase::Ready;
        self.notes_url = notes_url;
        Ok(())
    }
    /// The commit point of a handoff: from here the plan never changes.
    pub fn planned(&mut self, plan: Plan) -> Result<()> {
        ensure!(self.phase == Phase::Ready, "no ready update to install");
        ensure!(plan.txn == self.txn && self.version.as_deref() == Some(plan.to.as_str()), "plan does not belong to this transaction");
        self.version = Some(plan.to.clone());
        self.previous_version = Some(plan.from.clone());
        self.plan = Some(plan);
        self.phase = Phase::Planned;
        Ok(())
    }
    pub fn staged(&mut self, new_id: Option<u64>) -> Result<()> {
        ensure!(self.phase == Phase::Planned, "staging outside a planned transaction");
        self.new_id = new_id;
        self.phase = Phase::Staged;
        Ok(())
    }
    pub fn swapping(&mut self) -> Result<()> {
        ensure!(self.phase == Phase::Staged, "nothing is staged");
        self.phase = Phase::Swapping;
        Ok(())
    }
    pub fn swapped(&mut self) -> Result<()> {
        ensure!(matches!(self.phase, Phase::Swapping | Phase::Swapped), "swap was not started");
        self.phase = Phase::Swapped;
        Ok(())
    }
    pub fn pending(&mut self, attempts: u8) -> Result<()> {
        ensure!(self.phase == Phase::Swapped, "the swap is not complete");
        self.phase = Phase::PendingConfirm;
        self.attempts = attempts;
        Ok(())
    }
    pub fn first_launch(&mut self) {
        self.attempts = self.attempts.saturating_add(1);
    }
    /// Only the swapped-in version itself may confirm, and only while pending.
    pub fn confirm(&mut self, running: &str) -> bool {
        if self.phase == Phase::PendingConfirm && self.version.as_deref() == Some(running) {
            self.phase = Phase::Confirmed;
            true
        } else {
            false
        }
    }
    pub fn rolling_back(&mut self, block: bool) -> Result<()> {
        ensure!(
            matches!(self.phase, Phase::Swapping | Phase::Swapped | Phase::PendingConfirm | Phase::RollingBack),
            "nothing to roll back"
        );
        self.block_on_rollback |= block;
        self.phase = Phase::RollingBack;
        Ok(())
    }
    /// The old payload is back. A version that failed its first launch is
    /// never offered again; a swap that merely could not finish is an abort.
    pub fn rolled_back(&mut self) {
        if self.block_on_rollback {
            if let Some(version) = self.plan.as_ref().map(|p| p.to.clone()).or_else(|| self.version.clone()) {
                if !self.is_blocked(&version) {
                    self.blocked.push(version);
                }
            }
            self.phase = Phase::RolledBack;
        } else {
            self.phase = Phase::Aborted;
        }
    }
    pub fn abort(&mut self) {
        self.phase = Phase::Aborted;
    }
}

fn new_txn() -> u64 {
    let mut seed = [0u8; 16];
    let _ = getrandom::fill(&mut seed);
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    let mut hash = Sha256::new();
    hash.update(seed);
    hash.update(nanos.to_le_bytes());
    hash.update(std::process::id().to_le_bytes());
    u64::from_le_bytes(hash.finalize()[..8].try_into().expect("eight bytes")).max(1)
}
/// Stable identity of an install location (siblings and journal are keyed by it).
pub fn install_id(install: &Path) -> String {
    let digest = Sha256::digest(install.to_string_lossy().as_bytes());
    digest[..6].iter().map(|b| format!("{b:02x}")).collect()
}
/// `<config>/updates/<id>/`: only for an install that cannot update itself
/// (its notes and logs; no transaction ever runs from here).
pub fn dir(config: &Path, install: &Path) -> PathBuf {
    config.join("updates").join(install_id(install))
}
/// The one coordination directory of an updatable install, beside it on the
/// same volume as its staged and previous payloads: journal, ledger, leases,
/// archive, applier. It depends only on the install path, never on which
/// profile (`SINGZ_GPUI_CONFIG_DIR`) a process runs with, so every process
/// that could move this install's payloads meets the same leases.
pub fn coordination_dir(install: &Path) -> Result<PathBuf> {
    let parent = install.parent().context("install directory has no parent")?;
    Ok(parent.join(format!(".singz-update-{}", install_id(install))))
}
/// Open the coordination directory (and its applier folder) only once it is
/// proven to be this user's own private, real directory: created `0700` if
/// missing (Windows: a protected DACL for the user, SYSTEM and Administrators
/// only); refused when it is a link or reparse point, another user owns it,
/// or others can reach it (mode bits, a macOS ACL, a Windows DACL that is not
/// protected and private). An unsafe directory is left untouched; callers
/// fall back to the manual download.
pub fn secure_coordination_dir(install: &Path) -> Result<PathBuf> {
    let dir = coordination_dir(install)?;
    secure_dir(&dir)?;
    secure_dir(&dir.join("applier"))?;
    Ok(dir)
}
pub fn secure_dir(dir: &Path) -> Result<()> {
    match fs::symlink_metadata(dir) {
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            create_private_dir(dir).with_context(|| format!("create {}", dir.display()))?
        }
        Err(error) => return Err(error).with_context(|| format!("inspect {}", dir.display())),
        Ok(_) => {}
    }
    verify_private_dir(dir)
}
#[cfg(unix)]
fn create_private_dir(dir: &Path) -> Result<()> {
    use std::os::unix::fs::DirBuilderExt;
    fs::DirBuilder::new().mode(0o700).create(dir)?;
    Ok(())
}
#[cfg(windows)]
fn create_private_dir(dir: &Path) -> Result<()> {
    crate::updater_winsec::create_private_dir(dir)
}
#[cfg(not(any(unix, windows)))]
fn create_private_dir(dir: &Path) -> Result<()> {
    fs::create_dir(dir)?;
    Ok(())
}
/// Verify only; an unsafe directory is never repaired or emptied here, it is
/// refused and left exactly as found (the caller offers the download link).
fn verify_private_dir(dir: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(dir)?;
    ensure!(meta.file_type().is_dir(), "{} is not a real directory", dir.display());
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        // SAFETY: geteuid has no preconditions.
        ensure!(meta.uid() == unsafe { libc::geteuid() }, "{} belongs to another user", dir.display());
        ensure!(meta.mode() & 0o077 == 0, "{} is open to other users (mode {:o})", dir.display(), meta.mode() & 0o777);
        #[cfg(target_os = "macos")]
        ensure!(!has_extended_acl(dir)?, "{} carries an access control list", dir.display());
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::MetadataExt;
        const FILE_ATTRIBUTE_REPARSE_POINT: u32 = 0x400;
        ensure!(meta.file_attributes() & FILE_ATTRIBUTE_REPARSE_POINT == 0, "{} is a reparse point", dir.display());
        crate::updater_winsec::verify_private_dir(dir)?;
    }
    Ok(())
}
/// Does `path` carry an extended (macOS) ACL with at least one entry?
#[cfg(target_os = "macos")]
fn has_extended_acl(path: &Path) -> Result<bool> {
    use std::{ffi::{CString, c_void}, os::unix::ffi::OsStrExt};
    unsafe extern "C" {
        fn acl_get_link_np(path: *const libc::c_char, kind: libc::c_int) -> *mut c_void;
        fn acl_get_entry(acl: *mut c_void, id: libc::c_int, entry: *mut *mut c_void) -> libc::c_int;
        fn acl_free(object: *mut c_void) -> libc::c_int;
    }
    const ACL_TYPE_EXTENDED: libc::c_int = 0x0000_0100;
    const ACL_FIRST_ENTRY: libc::c_int = 0;
    let c = CString::new(path.as_os_str().as_bytes())?;
    // SAFETY: a valid C string; the returned ACL is freed below.
    let acl = unsafe { acl_get_link_np(c.as_ptr(), ACL_TYPE_EXTENDED) };
    if acl.is_null() {
        let error = std::io::Error::last_os_error();
        return if error.raw_os_error() == Some(libc::ENOENT) { Ok(false) } else { Err(error).context("read the directory ACL") };
    }
    let mut entry = std::ptr::null_mut();
    // SAFETY: `acl` is a live ACL and `entry` a valid out-pointer.
    let has_entry = unsafe { acl_get_entry(acl, ACL_FIRST_ENTRY, &mut entry) } == 0;
    // SAFETY: freeing the ACL obtained above, once.
    unsafe { acl_free(acl) };
    Ok(has_entry)
}
/// Which owner of the Windows coordination directory is trusted (pure): the
/// current user, LocalSystem, or Administrators while this process is an
/// enabled member of that group (elevated). Everyone else is refused.
pub fn owner_trusted(is_user: bool, is_admins: bool, admin_member: bool, is_system: bool) -> bool {
    is_user || is_system || (is_admins && admin_member)
}
/// The DACL rule for the Windows coordination directory, over its SDDL form:
/// protected (no inheritance), and only allow entries for the current user,
/// SYSTEM and Administrators. Pure, so it is tested on every platform.
///
/// SDDL prints some well-known account SIDs as abbreviations (`LA` is the LOCAL machine's built-in Administrator,
/// `LG` its Guest): a trustee that is not a numeric SID is resolved by `resolve` (on Windows
/// `ConvertStringSidToSidW`, which gives the SID the abbreviation really means on this machine) and accepted only
/// if that is exactly the user's SID. An alias that does not resolve, or resolves to anyone else (a domain
/// Administrator is not the local `LA`), is refused. The explicit allowed set (SYSTEM, Administrators) is unchanged.
pub fn check_private_dacl(sddl: &str, user_sid: &str, resolve: &dyn Fn(&str) -> Option<String>) -> Result<()> {
    let dacl = sddl.strip_prefix("D:").context("no DACL")?;
    let (flags, aces) = dacl.split_at(dacl.find('(').unwrap_or(dacl.len()));
    ensure!(flags.contains('P'), "the DACL inherits from its parent");
    // Fail closed on anything but an empty DACL or a well-formed `(ace)(ace)…`
    // run: a missing parenthesis or trailing descriptor fields must not read as
    // "no access entries".
    let entries: Vec<&str> = if aces.is_empty() {
        Vec::new()
    } else {
        let inner = aces
            .strip_prefix('(')
            .and_then(|a| a.strip_suffix(')'))
            .with_context(|| format!("unreadable access entries ({aces})"))?;
        inner.split(")(").collect()
    };
    for ace in entries {
        ensure!(!ace.contains(['(', ')']), "unreadable access entry ({ace})");
        let fields: Vec<&str> = ace.split(';').collect();
        ensure!(fields.len() == 6, "unreadable access entry ({ace})");
        ensure!(fields[0] == "A", "an access entry that is not a plain allow ({ace})");
        ensure!(!fields[1].contains("ID"), "an inherited access entry ({ace})");
        let trustee = fields[5];
        ensure!(
            trustee == user_sid
                || matches!(trustee, "SY" | "BA" | "S-1-5-18" | "S-1-5-32-544")
                || (!trustee.starts_with("S-1-") && resolve(trustee).as_deref() == Some(user_sid)),
            "access granted to someone else ({trustee})"
        );
    }
    Ok(())
}
/// Opens that never follow a link at the final component (`O_NOFOLLOW`, or
/// the reparse point itself on Windows). Inside a verified directory this is
/// defence in depth against anything planted before it was secured.
pub(crate) fn no_follow(options: &mut fs::OpenOptions) -> &mut fs::OpenOptions {
    #[cfg(unix)]
    std::os::unix::fs::OpenOptionsExt::custom_flags(options, libc::O_NOFOLLOW);
    #[cfg(windows)]
    std::os::windows::fs::OpenOptionsExt::custom_flags(options, 0x0020_0000); // FILE_FLAG_OPEN_REPARSE_POINT
    options
}
pub fn path(dir: &Path) -> PathBuf {
    dir.join("state.json")
}
fn blocked_path(dir: &Path) -> PathBuf {
    dir.join("blocked.json")
}
/// Written by the confirming build; the watchdog of that transaction looks
/// only at this, so a later transaction can never erase its evidence.
pub fn receipt_path(dir: &Path, txn: u64) -> PathBuf {
    dir.join(format!("confirmed-{txn:016x}"))
}
/// `Exchange`: the staged payload's identity, also kept outside the journal
/// so a damaged journal can still be rebuilt into a recognisable transaction.
fn staged_id_path(dir: &Path, txn: u64) -> PathBuf {
    dir.join(format!("staged-{txn:016x}.id"))
}
pub fn record_new_id(dir: &Path, txn: u64, id: Option<u64>) -> Result<()> {
    match id {
        Some(id) => write_atomic(&staged_id_path(dir, txn), id.to_string().as_bytes()),
        None => Ok(()),
    }
}
pub fn recorded_new_id(dir: &Path, txn: u64) -> Option<u64> {
    fs::read_to_string(staged_id_path(dir, txn)).ok()?.trim().parse().ok()
}
fn read_optional(path: &Path) -> Result<Option<Vec<u8>>> {
    match fs::read(path) {
        Ok(bytes) => Ok(Some(bytes)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e).with_context(|| format!("read {}", path.display())),
    }
}
/// The ledger, unioned with every version the preserved copies of earlier
/// damaged ledgers still name: evidence is never forgotten, whatever was
/// interrupted between preserving it and replacing the ledger.
fn load_blocked(dir: &Path) -> Result<Vec<String>> {
    let mut list: Vec<String> = match read_optional(&blocked_path(dir))? {
        None => vec![],
        Some(bytes) => serde_json::from_slice(&bytes).context("parse blocked versions")?,
    };
    for version in damaged_history(dir) {
        if !list.contains(&version) {
            list.push(version);
        }
    }
    Ok(list)
}
fn damaged_copies(dir: &Path) -> Vec<PathBuf> {
    let mut copies: Vec<PathBuf> = fs::read_dir(dir)
        .into_iter()
        .flatten()
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.file_name().and_then(|n| n.to_str()).is_some_and(|n| n.starts_with("blocked.damaged-") && n.ends_with(".json")))
        .collect();
    copies.sort();
    copies
}
fn damaged_history(dir: &Path) -> Vec<String> {
    let mut found = Vec::new();
    for copy in damaged_copies(dir) {
        for version in fs::read(&copy).map(|b| salvage_versions(&b)).unwrap_or_default() {
            if !found.contains(&version) {
                found.push(version);
            }
        }
    }
    found
}
/// Every version-shaped string in a damaged ledger, so damage never unblocks.
pub fn salvage_versions(bytes: &[u8]) -> Vec<String> {
    let text = String::from_utf8_lossy(bytes);
    let mut found: Vec<String> = Vec::new();
    for token in text.split(|c: char| !(c.is_ascii_alphanumeric() || matches!(c, '.' | '-' | '+'))) {
        if crate::updater_manifest::valid_version(token) && !found.iter().any(|f| f == token) {
            found.push(token.to_owned());
        }
    }
    found
}
/// Fails closed: a damaged journal or ledger is an error, never an empty one.
pub fn load(dir: &Path) -> Result<State> {
    let mut state: State = match read_optional(&path(dir))? {
        None => State::default(),
        Some(bytes) => serde_json::from_slice(&bytes).context("parse updater state")?,
    };
    state.blocked = load_blocked(dir)?;
    Ok(state)
}
pub(crate) fn write_atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    use std::io::Write;
    let parent = path.parent().context("journal parent")?;
    fs::create_dir_all(parent)?;
    // Unique per write: two threads of one process (the confirming app and a
    // check, or a watchdog settling a receipt) must never share a temp file.
    static SEQ: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
    let seq = SEQ.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
    let name = path.file_name().context("journal file name")?.to_string_lossy().into_owned();
    let tmp = parent.join(format!(".{name}.{}-{seq}.tmp", std::process::id()));
    let _ = fs::remove_file(&tmp);
    let mut f = fs::OpenOptions::new().write(true).create_new(true).open(&tmp)?;
    f.write_all(bytes)?;
    f.sync_all()?;
    drop(f);
    crate::project_store::replace(&tmp, path)?;
    crate::updater_swap::sync_dir(parent)
}
/// Never shrink the ledger. A damaged ledger is moved aside, never
/// overwritten, and every version it still names stays blocked.
pub fn save(dir: &Path, state: &State) -> Result<()> {
    let mut replace_ledger = false;
    let mut blocked = match load_blocked(dir) {
        Ok(list) => list,
        Err(_) => {
            // Copy the evidence durably first; the damaged ledger itself stays
            // in place until the atomic replacement below.
            let bytes = read_optional(&blocked_path(dir))?.unwrap_or_default();
            let mut salvaged = salvage_versions(&bytes);
            let already = damaged_copies(dir).iter().any(|c| fs::read(c).is_ok_and(|b| b == bytes));
            if !already {
                let aside = (0..).map(|n| dir.join(format!("blocked.damaged-{n}.json"))).find(|c| !c.exists()).expect("a free name");
                write_atomic(&aside, &bytes).context("preserve the damaged blocked ledger")?;
            }
            crate::updater_swap::kill_point("ledger-preserved")?;
            for version in damaged_history(dir) {
                if !salvaged.contains(&version) {
                    salvaged.push(version);
                }
            }
            replace_ledger = true;
            salvaged
        }
    };
    let before = blocked.len();
    for version in &state.blocked {
        if !blocked.contains(version) {
            blocked.push(version.clone());
        }
    }
    if replace_ledger || blocked.len() != before || (!blocked.is_empty() && read_optional(&blocked_path(dir))?.is_none()) {
        write_atomic(&blocked_path(dir), &serde_json::to_vec(&blocked)?)?;
    }
    write_atomic(&path(dir), &serde_json::to_vec(state)?)
}
/// Load strictly, change, save. A damaged journal is an error, not a reset.
pub fn update(dir: &Path, change: impl FnOnce(&mut State)) -> Result<State> {
    update_checked(dir, |s| {
        change(s);
        Ok(())
    })
}
/// Every read-modify-write of the journal (and the receipt it arbitrates
/// with) happens under this short-lived lease, across processes and threads,
/// so no writer ever saves a stale copy over a newer transaction.
pub fn journal_lock(dir: &Path) -> Result<crate::updater_lock::Lock> {
    let path = dir.join("journal.lock");
    let deadline = std::time::Instant::now() + std::time::Duration::from_secs(30);
    loop {
        if let Some(lease) = crate::updater_lock::try_acquire(&path)? {
            return Ok(lease);
        }
        ensure!(std::time::Instant::now() < deadline, "the update journal stayed locked");
        std::thread::sleep(std::time::Duration::from_millis(2));
    }
}
/// Load strictly, change (or refuse), save: one locked step.
pub fn update_checked(dir: &Path, change: impl FnOnce(&mut State) -> Result<()>) -> Result<State> {
    let _journal = journal_lock(dir)?;
    let mut state = load(dir)?;
    change(&mut state)?;
    save(dir, &state)?;
    Ok(state)
}
/// The applier's view of the journal for its own transaction. A damaged
/// journal is rebuilt from the plan the applier holds (phase `fallback`), and
/// the blocked history is salvaged; a journal that has moved on to another
/// transaction is never touched.
pub fn load_txn(dir: &Path, plan: &Plan, fallback: Phase) -> Result<State> {
    match load(dir) {
        Ok(state) if state.txn == plan.txn => Ok(state),
        Ok(state) => bail!("the journal has moved on to transaction {:x}", state.txn),
        Err(_) => {
            let blocked = match load_blocked(dir) {
                Ok(list) => list,
                Err(_) => {
                    let mut list = salvage_versions(&read_optional(&blocked_path(dir))?.unwrap_or_default());
                    list.extend(damaged_history(dir).into_iter().filter(|v| !list.contains(v)).collect::<Vec<_>>());
                    list
                }
            };
            Ok(State {
                phase: fallback,
                version: Some(plan.to.clone()),
                previous_version: Some(plan.from.clone()),
                txn: plan.txn,
                plan: Some(plan.clone()),
                new_id: recorded_new_id(dir, plan.txn),
                blocked,
                ..State::default()
            })
        }
    }
}
pub fn update_txn(dir: &Path, plan: &Plan, fallback: Phase, change: impl FnOnce(&mut State) -> Result<()>) -> Result<State> {
    let _journal = journal_lock(dir)?;
    let mut state = load_txn(dir, plan, fallback)?;
    change(&mut state)?;
    save(dir, &state)?;
    Ok(state)
}
/// Durable confirmation of `txn`, then the journal.
/// Receipt and journal are written under the journal lock, so a rollback
/// decision (taken under the same lock) sees either both or neither.
pub fn confirm(dir: &Path, running: &str) -> Result<bool> {
    let _journal = journal_lock(dir)?;
    let mut state = load(dir)?;
    if state.phase != Phase::PendingConfirm || state.version.as_deref() != Some(running) {
        return Ok(false);
    }
    crate::updater_swap::pause_point("confirm-loaded");
    write_atomic(&receipt_path(dir, state.txn), running.as_bytes())?;
    // A process killed here has confirmed: every reader settles the journal
    // from the receipt before deciding anything else (`settle_receipt`).
    crate::updater_swap::kill_point("confirm-receipt")?;
    state.confirm(running);
    save(dir, &state)?;
    Ok(true)
}
/// A pending transaction whose receipt exists is confirmed, whatever the
/// journal had time to say. Reads the journal afresh under the lock; only
/// settles transaction `txn`. Returns whether it settled the journal now.
pub fn settle_receipt(dir: &Path, txn: u64) -> Result<bool> {
    let _journal = journal_lock(dir)?;
    let mut state = load(dir)?;
    if state.txn != txn || !settle_in(dir, &mut state) {
        return Ok(false);
    }
    save(dir, &state)?;
    Ok(true)
}
/// Under the journal lock: a pending journal with its receipt is confirmed.
pub fn settle_in(dir: &Path, state: &mut State) -> bool {
    if state.phase == Phase::PendingConfirm && is_confirmed(dir, state.txn) {
        state.phase = Phase::Confirmed;
        true
    } else {
        false
    }
}
pub fn is_confirmed(dir: &Path, txn: u64) -> bool {
    receipt_path(dir, txn).is_file()
}
/// Receipts and identities of earlier transactions, once nothing can be
/// watching them.
pub fn prune_receipts(dir: &Path, keep: u64) {
    let keep = [receipt_path(dir, keep), staged_id_path(dir, keep)];
    for entry in fs::read_dir(dir).into_iter().flatten().flatten() {
        let (path, name) = (entry.path(), entry.file_name().to_string_lossy().into_owned());
        if !keep.contains(&path) && (name.starts_with("confirmed-") || (name.starts_with("staged-") && name.ends_with(".id"))) {
            let _ = fs::remove_file(path);
        }
    }
}

#[cfg(test)]
#[path = "updater_state_tests.rs"]
pub(crate) mod tests;

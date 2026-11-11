//! Payload moves, decided from what is on disk, never from what failed.
//!
//! Four same-volume slots belong to one install: the install itself, the
//! staged payload, the retained previous payload and a failed payload. Each
//! holds the transaction's old payload, its new payload, something else, or
//! nothing ([`Who`]). macOS recognises payloads by directory identity;
//! Windows by a marker file bound to the transaction (it has no directory
//! identity). [`forward_step`] and [`reverse_step`] are pure: given the
//! observed slots they name the single next move, so a replay after a crash
//! at any point continues from where the disk is. Nothing here knows about
//! user data.
use crate::updater_state::{Layout, Plan};
use anyhow::{Context, Result, bail, ensure};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs, io,
    path::{Path, PathBuf},
    thread::sleep,
    time::Duration,
};

// ---- fault injection (tests only) ------------------------------------------
#[cfg(test)]
#[derive(Default)]
pub(crate) struct Faults {
    /// Kill (panic) at the n-th kill point this thread reaches.
    pub kill_at: Option<usize>,
    /// Fail (return an error) at the n-th kill point instead.
    pub fail_at: Option<usize>,
    pub hits: Vec<String>,
    /// Durability events, in order: `sync <path>` and `publish <path>`.
    pub events: Vec<String>,
}
#[cfg(test)]
thread_local! {
    pub(crate) static FAULTS: std::cell::RefCell<Faults> = std::cell::RefCell::new(Faults::default());
}
/// A place where a process may die. Tests kill the applier here (or make the
/// step fail), then start it or the app again and check that reconciliation
/// converges. Production builds compile this to nothing.
pub(crate) fn kill_point(name: &str) -> Result<()> {
    #[cfg(test)]
    {
        let (kill, fail) = FAULTS.with(|f| {
            let mut f = f.borrow_mut();
            let n = f.hits.len();
            f.hits.push(name.to_owned());
            (f.kill_at == Some(n), f.fail_at == Some(n))
        });
        if kill {
            std::panic::panic_any(format!("killed at {name}"));
        }
        ensure!(!fail, "injected failure at {name}");
    }
    let _ = name;
    Ok(())
}
// Tests park a thread here (between two barriers) to force an interleaving.
#[cfg(test)]
thread_local! {
    pub(crate) static PAUSE: std::cell::RefCell<Option<(&'static str, std::sync::Arc<(std::sync::Barrier, std::sync::Barrier)>)>> = const { std::cell::RefCell::new(None) };
}
pub(crate) fn pause_point(name: &str) {
    #[cfg(test)]
    if let Some(barriers) = PAUSE.with(|p| p.borrow().as_ref().filter(|(at, _)| *at == name).map(|(_, b)| b.clone())) {
        barriers.0.wait(); // reached
        barriers.1.wait(); // released
    }
    let _ = name;
}
pub(crate) fn event(what: &str, path: &Path) {
    #[cfg(test)]
    FAULTS.with(|f| f.borrow_mut().events.push(format!("{what} {}", path.display())));
    let _ = (what, path);
}

// ---- durability -------------------------------------------------------------
/// Flush a directory's entries so a rename survives power loss. Windows
/// (NTFS) journals directory metadata itself; there this is a no-op.
pub fn sync_dir(dir: &Path) -> Result<()> {
    event("sync", dir);
    #[cfg(unix)]
    fs::File::open(dir)
        .and_then(|f| f.sync_all())
        .with_context(|| format!("flush directory {}", dir.display()))?;
    Ok(())
}
/// Flush every file and directory below `root` (links are not followed).
pub fn sync_tree(root: &Path) -> Result<()> {
    let meta = fs::symlink_metadata(root)?;
    if meta.is_dir() {
        for entry in fs::read_dir(root)? {
            sync_tree(&entry?.path())?;
        }
        sync_dir(root)
    } else if meta.is_file() {
        event("sync", root);
        // Windows needs write access to flush a file's buffers.
        let file = if cfg!(windows) { fs::OpenOptions::new().write(true).open(root) } else { fs::File::open(root) };
        file.and_then(|f| f.sync_all()).with_context(|| format!("flush {}", root.display()))
    } else {
        Ok(())
    }
}

// ---- identity -----------------------------------------------------------------
/// Stable identity of a directory (device and inode), used by `Exchange`.
pub fn dir_id(path: &Path) -> Option<u64> {
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        fs::symlink_metadata(path).ok().filter(|m| m.is_dir()).map(|m| m.ino() ^ (m.dev() << 40))
    }
    #[cfg(not(unix))]
    {
        let _ = path;
        None
    }
}
pub const MARKER: &str = crate::updater_zip::RESERVED_NAME;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Role {
    Old,
    New,
}
#[derive(Serialize, Deserialize)]
struct Marker {
    txn: u64,
    role: Role,
    tag: String,
}
/// Binds a marker to one transaction, its archive and its role.
fn marker_tag(plan: &Plan, role: Role) -> String {
    let mut hash = Sha256::new();
    hash.update(b"singz-payload-marker\0");
    hash.update(plan.txn.to_le_bytes());
    hash.update(plan.archive_sha256.as_bytes());
    hash.update(plan.from.as_bytes());
    hash.update([0]);
    hash.update(plan.to.as_bytes());
    hash.update([role as u8]);
    hash.finalize().iter().map(|b| format!("{b:02x}")).collect()
}
/// Mark a payload directory as this transaction's old or new payload, durably.
pub fn write_marker(payload: &Path, plan: &Plan, role: Role) -> Result<()> {
    let marker = Marker { txn: plan.txn, role, tag: marker_tag(plan, role) };
    crate::updater_state::write_atomic(&payload.join(MARKER), &serde_json::to_vec(&marker)?)
}
fn read_marker(payload: &Path, plan: &Plan) -> Option<Role> {
    let marker: Marker = serde_json::from_slice(&fs::read(payload.join(MARKER)).ok()?).ok()?;
    (marker.txn == plan.txn && marker.tag == marker_tag(plan, marker.role)).then_some(marker.role)
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Who {
    Missing,
    Old,
    New,
    /// A payload that belongs to no part of this transaction (a stale
    /// previous payload, a partial extraction, a manual reinstall).
    Other,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Slot {
    Install,
    Staged,
    Previous,
    Failed,
}
const SLOTS: [Slot; 4] = [Slot::Install, Slot::Staged, Slot::Previous, Slot::Failed];
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Disk(pub [Who; 4]);
impl Disk {
    pub fn get(&self, slot: Slot) -> Who {
        self.0[slot as usize]
    }
    pub fn find(&self, who: Who) -> Option<Slot> {
        SLOTS.into_iter().find(|s| self.get(*s) == who)
    }
}
pub fn slot_path(plan: &Plan, slot: Slot) -> &Path {
    match slot {
        Slot::Install => &plan.install,
        Slot::Staged => &plan.staged,
        Slot::Previous => &plan.previous,
        Slot::Failed => &plan.failed,
    }
}
pub fn identify(plan: &Plan, new_id: Option<u64>, path: &Path) -> Who {
    if fs::symlink_metadata(path).is_err() {
        return Who::Missing;
    }
    match plan.layout {
        Layout::Exchange => match dir_id(path) {
            Some(id) if Some(id) == plan.old_id => Who::Old,
            Some(id) if Some(id) == new_id => Who::New,
            _ => Who::Other,
        },
        Layout::TwoRename => match read_marker(path, plan) {
            Some(Role::Old) => Who::Old,
            Some(Role::New) => Who::New,
            None => Who::Other,
        },
    }
}
pub fn observe(plan: &Plan, new_id: Option<u64>) -> Disk {
    Disk(SLOTS.map(|slot| identify(plan, new_id, slot_path(plan, slot))))
}

// ---- the pure step rules --------------------------------------------------------
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Step {
    Done,
    /// Delete what the slot holds (never the install, never the old payload).
    Remove(Slot),
    Rename(Slot, Slot),
    /// `Exchange` only: swap two slots atomically.
    Exchange(Slot, Slot),
    /// The disk is in a state this transaction cannot move from.
    Stuck(&'static str),
}
/// Empty `slot` first if it holds something disposable.
fn make_room(d: &Disk, slot: Slot) -> Option<Step> {
    match d.get(slot) {
        Who::Missing => None,
        Who::Other => Some(Step::Remove(slot)),
        _ => Some(Step::Stuck("a payload occupies the slot it must move to")),
    }
}
/// Goal: the install holds the new payload and the old one is retained as
/// `previous`.
pub fn forward_step(layout: Layout, d: &Disk) -> Step {
    match d.get(Slot::Install) {
        Who::New => match d.find(Who::Old) {
            Some(Slot::Previous) => {
                if d.get(Slot::Staged) == Who::Other { Step::Remove(Slot::Staged) } else { Step::Done }
            }
            Some(from) => make_room(d, Slot::Previous).unwrap_or(Step::Rename(from, Slot::Previous)),
            None => Step::Stuck("the previous payload is missing"),
        },
        Who::Old => {
            if d.find(Who::New) != Some(Slot::Staged) {
                return Step::Stuck("the staged payload is missing");
            }
            if let Some(step) = make_room(d, Slot::Previous) {
                return step;
            }
            match layout {
                Layout::Exchange => Step::Exchange(Slot::Install, Slot::Staged),
                Layout::TwoRename => Step::Rename(Slot::Install, Slot::Previous),
            }
        }
        Who::Missing => match d.find(Who::New) {
            Some(from) => Step::Rename(from, Slot::Install),
            None => Step::Stuck("the new payload is missing"),
        },
        Who::Other => Step::Stuck("the install was replaced outside the updater"),
    }
}
/// Goal: the install holds the old payload again; the new one is discarded.
pub fn reverse_step(layout: Layout, d: &Disk) -> Step {
    match d.get(Slot::Install) {
        Who::Old => [Slot::Staged, Slot::Previous, Slot::Failed]
            .into_iter()
            .find(|s| d.get(*s) == Who::New)
            .map_or(Step::Done, Step::Remove),
        Who::New => match (d.find(Who::Old), layout) {
            (None, _) => Step::Stuck("the previous payload is missing"),
            (Some(old), Layout::Exchange) => Step::Exchange(Slot::Install, old),
            (Some(old), Layout::TwoRename) => {
                let aside = if old == Slot::Failed { Slot::Staged } else { Slot::Failed };
                make_room(d, aside).unwrap_or(Step::Rename(Slot::Install, aside))
            }
        },
        // Never leave the install missing: the old payload, else the new one.
        Who::Missing => match d.find(Who::Old).or_else(|| d.find(Who::New)) {
            Some(from) => Step::Rename(from, Slot::Install),
            None => Step::Stuck("no payload is left to install"),
        },
        Who::Other => Step::Stuck("the install was replaced outside the updater"),
    }
}

// ---- executing one step ----------------------------------------------------------
/// Windows refuses to rename a directory while any child handle is open (V23),
/// so a rename there retries for a bounded time. Elsewhere one attempt is enough.
fn rename_retry(from: &Path, to: &Path) -> io::Result<()> {
    let attempts = if cfg!(windows) { 150 } else { 1 };
    let mut last = None;
    for attempt in 0..attempts {
        match fs::rename(from, to) {
            Ok(()) => return Ok(()),
            Err(e) => last = Some(e),
        }
        if attempt + 1 < attempts {
            sleep(Duration::from_millis(200));
        }
    }
    Err(last.expect("at least one attempt"))
}
#[cfg(target_os = "macos")]
fn exchange(a: &Path, b: &Path) -> io::Result<()> {
    use std::os::unix::ffi::OsStrExt;
    let c = |p: &Path| std::ffi::CString::new(p.as_os_str().as_bytes()).map_err(|_| io::Error::from(io::ErrorKind::InvalidInput));
    let (a, b) = (c(a)?, c(b)?);
    // SAFETY: both pointers are valid NUL-terminated paths for the call.
    let rc = unsafe { libc::renamex_np(a.as_ptr(), b.as_ptr(), libc::RENAME_SWAP) };
    if rc == 0 { Ok(()) } else { Err(io::Error::last_os_error()) }
}
#[cfg(not(target_os = "macos"))]
fn exchange(_: &Path, _: &Path) -> io::Result<()> {
    Err(io::Error::new(io::ErrorKind::Unsupported, "atomic exchange is macOS-only"))
}
pub fn remove_tree(path: &Path) -> Result<()> {
    match fs::symlink_metadata(path) {
        Ok(m) if m.is_dir() => fs::remove_dir_all(path).with_context(|| format!("remove {}", path.display())),
        Ok(_) => fs::remove_file(path).with_context(|| format!("remove {}", path.display())),
        Err(_) => Ok(()),
    }
}
fn parent(plan: &Plan) -> Result<&Path> {
    plan.install.parent().context("install directory has no parent")
}
/// Perform one step, re-checking the slots it touches first. Every move is
/// followed by a flush of the parent directory before it counts as done.
pub fn execute(plan: &Plan, new_id: Option<u64>, step: Step) -> Result<()> {
    let who = |slot| identify(plan, new_id, slot_path(plan, slot));
    match step {
        Step::Done => return Ok(()),
        Step::Stuck(why) => bail!("{why}"),
        Step::Remove(slot) => {
            ensure!(slot != Slot::Install && !matches!(who(slot), Who::Old), "refusing to delete the install or the old payload");
            kill_point("before-remove")?;
            remove_tree(slot_path(plan, slot))?;
        }
        Step::Rename(from, to) => {
            ensure!(who(to) == Who::Missing, "rename target is occupied");
            kill_point("before-rename")?;
            rename_retry(slot_path(plan, from), slot_path(plan, to))
                .with_context(|| format!("move {from:?} payload to {to:?}"))?;
            event("move", slot_path(plan, to));
            sync_dir(parent(plan)?)?;
            kill_point("after-rename")?;
        }
        Step::Exchange(a, b) => {
            ensure!(plan.layout == Layout::Exchange, "this layout cannot exchange payloads");
            kill_point("before-exchange")?;
            exchange(slot_path(plan, a), slot_path(plan, b)).with_context(|| format!("exchange {a:?} and {b:?} payloads"))?;
            event("move", slot_path(plan, a));
            sync_dir(parent(plan)?)?;
            kill_point("after-exchange")?;
        }
    }
    sync_dir(parent(plan)?)
}
/// Drop whatever sits at the staging path, unless it is the old payload.
pub fn discard_staged(plan: &Plan, new_id: Option<u64>) -> Result<()> {
    match identify(plan, new_id, &plan.staged) {
        Who::Missing | Who::Old => Ok(()),
        _ => {
            remove_tree(&plan.staged)?;
            sync_dir(parent(plan)?)
        }
    }
}
/// Run steps toward a goal until the disk says it is reached.
pub fn converge(plan: &Plan, new_id: Option<u64>, forward: bool) -> Result<()> {
    for _ in 0..12 {
        let disk = observe(plan, new_id);
        let step = if forward { forward_step(plan.layout, &disk) } else { reverse_step(plan.layout, &disk) };
        if step == Step::Done {
            return Ok(());
        }
        execute(plan, new_id, step)?;
    }
    bail!("payload moves did not converge")
}

// ---- sibling paths ---------------------------------------------------------------
fn sibling(install: &Path, kind: &str) -> Result<PathBuf> {
    let parent = install.parent().context("install directory has no parent")?;
    Ok(parent.join(format!(".singz-{kind}-{}", crate::updater_state::install_id(install))))
}
/// Same-volume siblings of one install, namespaced by its identity so two
/// native installs sharing a parent folder never touch each other's files.
pub fn sibling_paths(install: &Path) -> Result<(PathBuf, PathBuf)> {
    Ok((sibling(install, "staged")?, sibling(install, "previous")?))
}
pub fn failed_path(install: &Path) -> Result<PathBuf> {
    sibling(install, "failed")
}
/// The applier's extraction scratch.
pub fn extract_path(install: &Path) -> Result<PathBuf> {
    sibling(install, "extract")
}
/// The app's own pre-flight extraction scratch (checks an archive before
/// offering it); never shared with the applier.
pub fn check_path(install: &Path) -> Result<PathBuf> {
    sibling(install, "check")
}
/// Delete scratch an earlier run left behind. Only called while no applier is
/// alive and no transaction is in flight; never touches the install or the
/// retained previous payload.
pub fn clean_leftovers(install: &Path) {
    for path in [failed_path(install), extract_path(install), check_path(install), sibling_paths(install).map(|p| p.0)]
        .into_iter()
        .flatten()
    {
        let _ = remove_tree(&path);
    }
}

#[cfg(test)]
#[path = "updater_swap_tests.rs"]
pub(crate) mod tests;

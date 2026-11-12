use super::*;
use crate::updater_state::install_id;
use Who::{Missing as M, New as N, Old as O, Other as X};

struct Fixture {
    root: PathBuf,
    plan: Plan,
}
fn fixture(layout: Layout) -> Fixture {
    let root = std::env::temp_dir().join(format!(
        "singz-swap-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        {
            // Parallel tests can read the same clock value (macOS reports microseconds).
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        }
    ));
    let install = root.join("app");
    fs::create_dir_all(&install).unwrap();
    fs::write(install.join("version"), "old").unwrap();
    let (staged, previous) = sibling_paths(&install).unwrap();
    fs::create_dir_all(&staged).unwrap();
    fs::write(staged.join("version"), "new").unwrap();
    // Neighbours a swap must never touch: user data lives outside the payload.
    fs::create_dir_all(root.join("user-data")).unwrap();
    fs::write(root.join("user-data/library.json"), "mine").unwrap();
    let plan = Plan {
        txn: 7,
        from: "1.0.0".into(),
        to: "2.0.0".into(),
        target: "t".into(),
        archive_sha256: "cd".repeat(32),
        archive_bytes: 1,
        failed: failed_path(&install).unwrap(),
        extract: extract_path(&install).unwrap(),
        old_id: dir_id(&install),
        install,
        exe_rel: "version".into(),
        staged,
        previous,
        layout,
    };
    if layout == Layout::TwoRename {
        write_marker(&plan.install, &plan, Role::Old).unwrap();
        write_marker(&plan.staged, &plan, Role::New).unwrap();
    }
    Fixture { root, plan }
}
impl Fixture {
    fn new_id(&self) -> Option<u64> {
        // Exchange: the staged directory's identity, as the journal records it.
        if self.plan.layout == Layout::Exchange { dir_id(&self.plan.staged) } else { None }
    }
    fn version(&self, slot: Slot) -> String {
        fs::read_to_string(slot_path(&self.plan, slot).join("version")).unwrap()
    }
    fn done(self) {
        assert_eq!(fs::read_to_string(self.root.join("user-data/library.json")).unwrap(), "mine");
        fs::remove_dir_all(self.root).unwrap();
    }
}
/// Index of the event `kind <path>` whose path equals `path` component by
/// component (Windows records `\`, fixtures may spell `/`).
pub(crate) fn event_at(events: &[String], kind: &str, path: &Path) -> Option<usize> {
    events.iter().position(|e| {
        e.strip_prefix(kind)
            .and_then(|rest| rest.strip_prefix(' '))
            .is_some_and(|rest| Path::new(rest).components().eq(path.components()))
    })
}
fn d(slots: [Who; 4]) -> Disk {
    Disk(slots)
}

#[test]
fn forward_rules_finish_a_swap_from_every_intermediate_state() {
    use Layout::*;
    use Slot::*;
    // [install, staged, previous, failed]
    assert_eq!(forward_step(Exchange, &d([O, N, M, M])), Step::Exchange(Install, Staged));
    assert_eq!(forward_step(Exchange, &d([O, N, X, M])), Step::Remove(Previous), "a stale previous payload goes first");
    assert_eq!(forward_step(Exchange, &d([N, O, M, M])), Step::Rename(Staged, Previous));
    assert_eq!(forward_step(Exchange, &d([N, M, O, M])), Step::Done);
    assert_eq!(forward_step(TwoRename, &d([O, N, M, M])), Step::Rename(Install, Previous));
    assert_eq!(forward_step(TwoRename, &d([M, N, O, M])), Step::Rename(Staged, Install), "killed between the two renames");
    // B1: a completed Windows swap is recognised and left alone, never re-extracted over.
    assert_eq!(forward_step(TwoRename, &d([N, M, O, M])), Step::Done);
    assert_eq!(forward_step(TwoRename, &d([N, X, O, M])), Step::Remove(Staged));
    for broken in [d([O, M, M, M]), d([X, N, M, M]), d([M, M, O, M])] {
        assert!(matches!(forward_step(TwoRename, &broken), Step::Stuck(_)), "{broken:?}");
    }
}
#[test]
fn reverse_rules_restore_the_old_payload_and_never_leave_the_install_empty() {
    use Layout::*;
    use Slot::*;
    assert_eq!(reverse_step(Exchange, &d([N, M, O, M])), Step::Exchange(Install, Previous));
    assert_eq!(reverse_step(Exchange, &d([N, O, M, M])), Step::Exchange(Install, Staged), "killed between exchange and retain");
    assert_eq!(reverse_step(Exchange, &d([O, M, N, M])), Step::Remove(Previous));
    assert_eq!(reverse_step(TwoRename, &d([N, M, O, M])), Step::Rename(Install, Failed));
    assert_eq!(reverse_step(TwoRename, &d([N, M, O, X])), Step::Remove(Failed));
    assert_eq!(reverse_step(TwoRename, &d([M, M, O, N])), Step::Rename(Previous, Install), "killed between the two renames");
    assert_eq!(reverse_step(TwoRename, &d([O, M, M, N])), Step::Remove(Failed));
    assert_eq!(reverse_step(TwoRename, &d([O, X, X, M])), Step::Done, "unrelated leftovers are not the transaction's");
    // Old payload lost: put the new one back rather than leave nothing.
    assert_eq!(reverse_step(TwoRename, &d([M, N, M, M])), Step::Rename(Staged, Install));
    assert!(matches!(reverse_step(TwoRename, &d([X, M, O, M])), Step::Stuck(_)), "a manual reinstall is not ours to replace");
}
#[test]
fn both_layouts_swap_and_restore_on_disk() {
    let layouts: &[Layout] = if cfg!(target_os = "macos") { &[Layout::Exchange, Layout::TwoRename] } else { &[Layout::TwoRename] };
    for &layout in layouts {
        let f = fixture(layout);
        let id = f.new_id();
        converge(&f.plan, id, true).unwrap();
        assert_eq!((f.version(Slot::Install), f.version(Slot::Previous)), ("new".into(), "old".into()), "{layout:?}");
        assert_eq!(observe(&f.plan, id), Disk([N, M, O, M]));
        converge(&f.plan, id, true).unwrap(); // a replay changes nothing
        assert_eq!(observe(&f.plan, id), Disk([N, M, O, M]));
        converge(&f.plan, id, false).unwrap();
        assert_eq!(f.version(Slot::Install), "old");
        assert_eq!(observe(&f.plan, id), Disk([O, M, M, M]), "{layout:?}");
        f.done();
    }
}
#[test]
fn windows_markers_are_bound_to_one_transaction() {
    let f = fixture(Layout::TwoRename);
    assert_eq!(observe(&f.plan, None), Disk([O, N, M, M]));
    // The same directories seen by another transaction are nobody's payloads.
    let other = Plan { txn: 8, ..f.plan.clone() };
    assert_eq!(observe(&other, None), Disk([X, X, M, M]));
    // A forged marker (right txn, wrong tag) does not count either.
    fs::write(f.plan.staged.join(MARKER), br#"{"txn":7,"role":"new","tag":"00"}"#).unwrap();
    assert_eq!(identify(&f.plan, None, &f.plan.staged), X);
    f.done();
}
#[test]
fn removal_never_takes_the_install_or_the_old_payload() {
    let f = fixture(Layout::TwoRename);
    assert!(execute(&f.plan, None, Step::Remove(Slot::Install)).is_err());
    fs::rename(&f.plan.install, &f.plan.previous).unwrap();
    assert!(execute(&f.plan, None, Step::Remove(Slot::Previous)).is_err());
    assert_eq!(f.version(Slot::Previous), "old");
    assert!(execute(&f.plan, None, Step::Rename(Slot::Staged, Slot::Previous)).is_err(), "occupied target");
    f.done();
}
#[test]
fn flushing_reaches_every_file_and_directory() {
    let f = fixture(Layout::TwoRename);
    fs::create_dir_all(f.plan.staged.join("a/b")).unwrap();
    fs::write(f.plan.staged.join("a/b/c"), "x").unwrap();
    FAULTS.with(|x| x.borrow_mut().events.clear());
    sync_tree(&f.plan.staged).unwrap();
    let events = FAULTS.with(|x| x.borrow().events.clone());
    for path in [f.plan.staged.join("a/b/c"), f.plan.staged.join("a/b"), f.plan.staged.join("a"), f.plan.staged.join("version"), f.plan.staged.clone()] {
        assert!(event_at(&events, "sync", &path).is_some(), "{} not flushed: {events:?}", path.display());
    }
    // A flush that cannot happen is an error, not a shrug (NTFS needs none).
    #[cfg(unix)]
    assert!(sync_dir(&f.root.join("does-not-exist")).is_err());
    f.done();
}
#[test]
fn two_installs_in_one_folder_never_share_siblings() {
    let parent = Path::new("/apps");
    let (a, b) = (parent.join("SingZ.app"), parent.join("SingZ Beta.app"));
    assert_ne!(sibling_paths(&a).unwrap(), sibling_paths(&b).unwrap());
    assert_ne!(failed_path(&a).unwrap(), failed_path(&b).unwrap());
    assert_ne!(extract_path(&a).unwrap(), check_path(&a).unwrap());
    assert!(sibling_paths(&a).unwrap().0.to_string_lossy().contains(&install_id(&a)));
}

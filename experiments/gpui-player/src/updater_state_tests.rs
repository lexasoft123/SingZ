use super::*;

fn scratch(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "updater-state-{name}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos()
    ));
    fs::create_dir_all(&p).unwrap();
    p
}
const INSTALL: &str = "/Applications/SingZ.app";
fn plan(txn: u64) -> Plan {
    let install = PathBuf::from(INSTALL);
    let sib = |k: &str| install.parent().unwrap().join(format!(".singz-{k}-{}", install_id(&install)));
    Plan {
        txn,
        from: "1.2.2".into(),
        to: "1.2.3".into(),
        target: "macos-arm64".into(),
        archive_sha256: "ab".repeat(32),
        archive_bytes: 10,
        staged: sib("staged"),
        previous: sib("previous"),
        failed: sib("failed"),
        extract: sib("extract"),
        install,
        exe_rel: "Contents/MacOS/app".into(),
        layout: Layout::Exchange,
        old_id: Some(1),
    }
}
/// A journal walked through the real transitions up to `phase`.
fn journal_at(phase: Phase) -> State {
    let mut s = State::default();
    let txn = s.begin_download("1.2.3").unwrap();
    if phase == Phase::Downloading {
        return s;
    }
    s.ready(None).unwrap();
    if phase == Phase::Ready {
        return s;
    }
    s.planned(plan(txn)).unwrap();
    for (step, next) in [
        (Phase::Planned, Phase::Staged),
        (Phase::Staged, Phase::Swapping),
        (Phase::Swapping, Phase::Swapped),
        (Phase::Swapped, Phase::PendingConfirm),
    ] {
        if phase == step {
            return s;
        }
        match next {
            Phase::Staged => s.staged(Some(2)).unwrap(),
            Phase::Swapping => s.swapping().unwrap(),
            Phase::Swapped => s.swapped().unwrap(),
            _ => s.pending(0).unwrap(),
        }
    }
    s
}

#[test]
fn transitions_are_ordered_and_the_plan_is_fixed_at_handoff() {
    let s = journal_at(Phase::PendingConfirm);
    assert_eq!((s.phase, s.version.as_deref(), s.previous_version.as_deref()), (Phase::PendingConfirm, Some("1.2.3"), Some("1.2.2")));
    assert_eq!(s.plan.as_ref().unwrap().txn, s.txn);
    // Out-of-order steps are refused.
    assert!(State::default().ready(None).is_err());
    assert!(journal_at(Phase::Downloading).planned(plan(1)).is_err());
    let mut ready = journal_at(Phase::Ready);
    assert!(ready.planned(plan(ready.txn ^ 1)).is_err(), "a plan for another transaction");
    assert!(journal_at(Phase::Planned).swapping().is_err(), "nothing staged yet");
    assert!(journal_at(Phase::Staged).pending(0).is_err());
    assert!(journal_at(Phase::Planned).rolling_back(true).is_err(), "nothing has moved yet");
}
#[test]
fn a_rollback_blocks_only_a_version_that_failed_to_launch() {
    let mut failed = journal_at(Phase::PendingConfirm);
    failed.rolling_back(true).unwrap();
    failed.rolled_back();
    assert_eq!((failed.phase, failed.blocked.clone()), (Phase::RolledBack, vec!["1.2.3".to_string()]));
    let mut interrupted = journal_at(Phase::Swapping);
    interrupted.rolling_back(false).unwrap();
    interrupted.rolled_back();
    assert_eq!((interrupted.phase, interrupted.blocked.is_empty()), (Phase::Aborted, true));
}
#[test]
fn a_transaction_in_flight_cannot_start_another_download() {
    for phase in [Phase::Downloading, Phase::Ready, Phase::Planned, Phase::Staged, Phase::Swapping, Phase::Swapped, Phase::PendingConfirm, Phase::RollingBack] {
        let mut s = State { phase, ..journal_at(Phase::PendingConfirm) };
        let before = s.clone();
        assert!(s.begin_download("1.2.4").is_err(), "{phase:?}");
        assert_eq!(s, before, "{phase:?}: the transaction must be left exactly as it was");
    }
    for phase in [Phase::Idle, Phase::Confirmed, Phase::Aborted, Phase::RolledBack] {
        let mut s = State { phase, blocked: vec!["0.9.0".into()], ..journal_at(Phase::PendingConfirm) };
        let old = s.txn;
        s.begin_download("1.2.4").unwrap();
        assert!(s.txn != old && s.plan.is_none() && s.blocked == vec!["0.9.0".to_string()], "{phase:?}");
    }
}
#[test]
fn only_the_swapped_in_version_can_confirm_and_it_leaves_a_receipt() {
    let root = scratch("confirm");
    let s = journal_at(Phase::PendingConfirm);
    save(&root, &s).unwrap();
    assert!(!confirm(&root, "1.2.2").unwrap());
    assert!(!is_confirmed(&root, s.txn));
    assert!(confirm(&root, "1.2.3").unwrap());
    assert!(is_confirmed(&root, s.txn));
    assert_eq!(load(&root).unwrap().phase, Phase::Confirmed);
    // The next transaction rewrites the journal; the receipt of this one stays
    // until it is pruned (only once no watchdog can be looking).
    update(&root, |j| {
        j.begin_download("1.2.4").unwrap();
    })
    .unwrap();
    assert!(is_confirmed(&root, s.txn), "a later transaction must not erase the confirmation");
    prune_receipts(&root, load(&root).unwrap().txn);
    assert!(!is_confirmed(&root, s.txn));
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_damaged_journal_fails_closed_and_the_applier_rebuilds_from_its_plan() {
    let root = scratch("torn");
    let mut s = journal_at(Phase::PendingConfirm);
    s.blocked = vec!["1.0.9".into()];
    save(&root, &s).unwrap();
    fs::write(path(&root), b"{\"phase\":\"pending-conf").unwrap();
    assert!(load(&root).is_err(), "a damaged journal is an error, not an empty state");
    let damaged = fs::read(path(&root)).unwrap();
    assert!(update(&root, |j| j.phase = Phase::Idle).is_err(), "strict updates refuse a damaged journal");
    assert_eq!(fs::read(path(&root)).unwrap(), damaged, "the damaged file is preserved, not replaced");
    // The applier, holding the immutable plan, finishes its rollback anyway
    // and the failed version is blocked.
    let p = s.plan.clone().unwrap();
    let rebuilt = update_txn(&root, &p, Phase::RollingBack, |j| {
        j.block_on_rollback = true;
        j.rolled_back();
        Ok(())
    })
    .unwrap();
    assert_eq!(rebuilt.phase, Phase::RolledBack);
    let after = load(&root).unwrap();
    assert_eq!(after.blocked, vec!["1.0.9".to_string(), "1.2.3".to_string()], "history kept and the failed version added");
    // A journal that moved on to another transaction is never touched.
    let mut other = p.clone();
    other.txn ^= 1;
    assert!(update_txn(&root, &other, Phase::RollingBack, |_| Ok(())).is_err());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_damaged_ledger_is_set_aside_and_every_version_it_names_stays_blocked() {
    let root = scratch("ledger");
    let mut s = journal_at(Phase::PendingConfirm);
    s.blocked = vec!["1.0.1".into(), "1.1.0-beta.2".into()];
    save(&root, &s).unwrap();
    let torn = b"[\"1.0.1\",\"1.1.0-beta.2\",\"1.2";
    fs::write(root.join("blocked.json"), torn).unwrap();
    assert!(load(&root).is_err(), "strict readers refuse a damaged ledger");
    // The rollback of 1.2.3 must record it without losing the damaged history.
    let p = s.plan.clone().unwrap();
    update_txn(&root, &p, Phase::RollingBack, |j| {
        j.phase = Phase::RollingBack;
        j.block_on_rollback = true;
        j.rolled_back();
        Ok(())
    })
    .unwrap();
    let blocked = load(&root).unwrap().blocked;
    for version in ["1.0.1", "1.1.0-beta.2", "1.2.3"] {
        assert!(blocked.iter().any(|b| b == version), "{version} must stay blocked: {blocked:?}");
    }
    assert_eq!(fs::read(root.join("blocked.damaged-0.json")).unwrap(), torn, "the damaged ledger is kept verbatim");
    // Saving with a smaller in-memory list never shrinks the ledger.
    save(&root, &State::default()).unwrap();
    assert_eq!(load(&root).unwrap().blocked.len(), 3);
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn unknown_fields_are_ignored_and_journals_are_scoped_to_one_install() {
    let root = scratch("fields");
    fs::write(path(&root), br#"{"phase":"confirmed","version":"1.0.0","fromTheFuture":1}"#).unwrap();
    assert_eq!(load(&root).unwrap().phase, Phase::Confirmed);
    fs::remove_dir_all(root).unwrap();
    let (a, b) = (Path::new("/Applications/SingZ.app"), Path::new("/Users/x/Apps/SingZ Beta.app"));
    assert_ne!(install_id(a), install_id(b));
    assert_ne!(dir(Path::new("/c"), a), dir(Path::new("/c"), b));
}

#[test]
fn r3_a_kill_while_salvaging_the_ledger_never_unblocks_anything() {
    use crate::updater_swap::{FAULTS, Faults};
    let root = scratch("r3");
    let mut s = journal_at(Phase::PendingConfirm);
    s.blocked = vec!["1.0.1".into()];
    save(&root, &s).unwrap();
    let torn = b"[\"1.0.1\",\"1.1.0";
    fs::write(root.join("blocked.json"), torn).unwrap();
    s.blocked.push("1.2.3".into());
    FAULTS.with(|f| *f.borrow_mut() = Faults { kill_at: Some(0), ..Faults::default() });
    let killed = std::panic::catch_unwind(|| save(&root, &s));
    let faults = FAULTS.with(|f| std::mem::take(&mut *f.borrow_mut()));
    assert!(killed.is_err() && faults.hits == ["ledger-preserved"], "{:?}", faults.hits);
    assert_eq!(fs::read(root.join("blocked.json")).unwrap(), torn, "the only ledger was moved away before its replacement");
    assert_eq!(fs::read(root.join("blocked.damaged-0.json")).unwrap(), torn);
    assert!(load(&root).is_err(), "still damaged: still fails closed");
    // Even with the ledger gone entirely, the preserved evidence still blocks.
    let kept = fs::read(root.join("blocked.json")).unwrap();
    fs::remove_file(root.join("blocked.json")).unwrap();
    assert!(load(&root).unwrap().is_blocked("1.0.1"), "a missing ledger forgot the preserved history");
    fs::write(root.join("blocked.json"), kept).unwrap();
    // The interrupted save completes on the next attempt.
    save(&root, &s).unwrap();
    let blocked = load(&root).unwrap().blocked;
    assert!(blocked.contains(&"1.0.1".to_string()) && blocked.contains(&"1.2.3".to_string()), "{blocked:?}");
    assert!(!root.join("blocked.damaged-1.json").exists(), "the same evidence is preserved once");
    fs::remove_dir_all(root).unwrap();
}

#[test]
fn f4_a_paused_confirmation_never_overwrites_the_next_transaction() {
    use crate::updater_swap::PAUSE;
    use std::sync::{Arc, Barrier};
    let root = scratch("f4");
    let pending = journal_at(Phase::PendingConfirm);
    save(&root, &pending).unwrap();
    let barriers = Arc::new((Barrier::new(2), Barrier::new(2)));
    let (dir, b) = (root.clone(), barriers.clone());
    let confirmer = std::thread::spawn(move || {
        PAUSE.with(|p| *p.borrow_mut() = Some(("confirm-loaded", b)));
        confirm(&dir, "1.2.3").unwrap()
    });
    barriers.0.wait(); // transaction N is loaded; the confirmation is paused
    // Meanwhile the watchdog settles and the service starts N+1.
    let dir = root.clone();
    let next = std::thread::spawn(move || {
        update(&dir, |j| {
            j.phase = Phase::Confirmed;
            j.begin_download("1.2.4").unwrap();
        })
        .unwrap()
        .txn
    });
    std::thread::sleep(std::time::Duration::from_millis(300));
    assert!(!next.is_finished(), "another writer changed the journal inside a confirmation");
    barriers.1.wait();
    assert!(confirmer.join().unwrap());
    let n1 = next.join().unwrap();
    let journal = load(&root).unwrap();
    assert_eq!((journal.txn, journal.phase, journal.version.as_deref()), (n1, Phase::Downloading, Some("1.2.4")), "N+1 was overwritten");
    assert!(n1 != pending.txn && is_confirmed(&root, pending.txn));
    fs::remove_dir_all(root).unwrap();
}
/// A directory link a normal user may create: a symlink, or a junction.
pub(crate) fn dir_link(target: &Path, link: &Path) {
    #[cfg(unix)]
    std::os::unix::fs::symlink(target, link).unwrap();
    #[cfg(windows)]
    assert!(
        std::process::Command::new("cmd").arg("/C").arg("mklink").arg("/J").arg(link).arg(target).output().unwrap().status.success(),
        "mklink /J"
    );
}
#[test]
fn f2_a_fresh_coordination_directory_is_private_and_a_link_is_refused() {
    let root = scratch("f2");
    let install = root.join("SingZ.app");
    fs::create_dir_all(&install).unwrap();
    let dir = secure_coordination_dir(&install).unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o700);
    }
    secure_coordination_dir(&install).unwrap(); // reopening our own private directory is fine
    // A link (or junction) in its place is refused, and nothing is written through it.
    fs::remove_dir_all(&dir).unwrap();
    fs::create_dir_all(root.join("theirs")).unwrap();
    dir_link(&root.join("theirs"), &dir);
    assert!(secure_coordination_dir(&install).is_err());
    assert!(fs::read_dir(root.join("theirs")).unwrap().next().is_none());
    fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(unix)]
fn f2_an_unsafe_existing_directory_is_refused_and_left_untouched() {
    use std::os::unix::fs::{PermissionsExt, symlink};
    let root = scratch("f2-unsafe");
    let install = root.join("SingZ.app");
    fs::create_dir_all(&install).unwrap();
    let dir = coordination_dir(&install).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o777)).unwrap();
    let victim = root.join("victim.txt");
    fs::write(&victim, "precious").unwrap();
    symlink(&victim, dir.join("update.download")).unwrap();
    let error = secure_coordination_dir(&install).unwrap_err();
    assert!(format!("{error:#}").contains("open to other users"), "{error:#}");
    // Not repaired, not purged: exactly as found.
    assert_eq!(fs::metadata(&dir).unwrap().permissions().mode() & 0o777, 0o777);
    assert!(fs::symlink_metadata(dir.join("update.download")).unwrap().file_type().is_symlink());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
    // Another user's directory is refused before anything is touched.
    assert!(format!("{:#}", secure_dir(Path::new("/usr")).unwrap_err()).contains("another user"));
    // A lease file planted as a link is never followed (a private directory of ours).
    fs::set_permissions(&dir, fs::Permissions::from_mode(0o700)).unwrap();
    fs::remove_file(dir.join("update.download")).unwrap();
    symlink(&victim, dir.join("journal.lock")).unwrap();
    assert!(journal_lock(&dir).is_err());
    assert_eq!(fs::read_to_string(&victim).unwrap(), "precious");
    fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(target_os = "macos")]
fn f2_a_directory_carrying_an_extended_acl_is_refused() {
    let root = scratch("f2-acl");
    let install = root.join("SingZ.app");
    fs::create_dir_all(&install).unwrap();
    let dir = secure_coordination_dir(&install).unwrap();
    let granted = std::process::Command::new("/bin/chmod").args(["+a", "everyone allow list,add_file,search,delete_child"]).arg(&dir).status().unwrap();
    assert!(granted.success());
    let error = secure_coordination_dir(&install).unwrap_err();
    assert!(format!("{error:#}").contains("access control list"), "{error:#}");
    fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(windows)]
fn f2_a_windows_directory_without_a_protected_private_dacl_is_refused() {
    let root = scratch("f2-dacl");
    let install = root.join("SingZ Native");
    fs::create_dir_all(&install).unwrap();
    // Ours (owned by the user, or by Administrators when this process runs
    // elevated: both trusted owners), but created with the parent's inherited
    // DACL: refused for its DACL, whatever the elevation, and left untouched.
    let dir = coordination_dir(&install).unwrap();
    fs::create_dir(&dir).unwrap();
    fs::write(dir.join("left.txt"), "as found").unwrap();
    let error = secure_coordination_dir(&install).unwrap_err();
    assert!(format!("{error:#}").contains("not private"), "{error:#}");
    assert_eq!(fs::read_to_string(dir.join("left.txt")).unwrap(), "as found");
    // Created by the updater: protected and private, so it reopens.
    fs::remove_dir_all(&dir).unwrap();
    secure_coordination_dir(&install).unwrap();
    secure_coordination_dir(&install).unwrap();
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn f2_the_private_dacl_rule() {
    let me = "S-1-5-21-1-2-3-1001";
    check_private_dacl(&format!("D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;SY)(A;OICI;FA;;;BA)"), me).unwrap();
    check_private_dacl(&format!("D:PAI(A;OICI;FA;;;{me})"), me).unwrap();
    for bad in [
        format!("D:(A;OICI;FA;;;{me})"),                       // not protected: inherits
        format!("D:AI(A;OICIID;FA;;;{me})"),                   // inherited entries
        format!("D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;WD)"),      // Everyone
        format!("D:P(A;OICI;FA;;;{me})(A;OICI;FA;;;BU)"),      // all local users
        format!("D:P(A;OICI;FA;;;S-1-5-21-1-2-3-1002)"),       // another user
        format!("D:P(OA;;CC;;;{me})"),                         // not a plain allow
        "O:BA".to_string(),                                    // no DACL at all
    ] {
        assert!(check_private_dacl(&bad, me).is_err(), "{bad}");
    }
}
#[test]
fn trusted_owners_are_the_user_system_and_administrators_only_when_elevated() {
    assert!(owner_trusted(true, false, false, false), "the user");
    assert!(owner_trusted(false, false, false, true), "LocalSystem");
    assert!(owner_trusted(false, true, true, false), "Administrators, for an elevated administrator");
    assert!(!owner_trusted(false, true, false, false), "Administrators, for a token that is not an enabled member");
    assert!(!owner_trusted(false, false, true, false), "another user");
}

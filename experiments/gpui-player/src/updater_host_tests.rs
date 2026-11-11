use super::*;

#[test]
fn confirmation_needs_the_window_the_audio_helper_and_the_full_interval() {
    let t0 = Instant::now();
    let survive = Duration::from_secs(20);
    // Nothing yet.
    assert!(!Gate::default().ready(t0, survive));
    // The window appeared and 25 s passed, but the audio helper never answered
    // (a missing or hung helper must never become a confirmed build).
    let no_audio = Gate { frame: Some(t0), audio: false };
    assert!(!no_audio.ready(t0 + Duration::from_secs(25), survive));
    // Audio answered at once, but the interval has not elapsed (an early quit or check).
    let healthy = Gate { frame: Some(t0), audio: true };
    assert!(!healthy.ready(t0 + Duration::from_secs(1), survive));
    assert!(!healthy.ready(t0 + Duration::from_secs(19), survive));
    assert!(healthy.ready(t0 + Duration::from_secs(20), survive));
    // Audio without a presented window is not a launch either.
    assert!(!Gate { frame: None, audio: true }.ready(t0 + Duration::from_secs(60), survive));
}
#[test]
fn a_transaction_or_a_live_applier_holds_off_the_periodic_check() {
    use state::{Phase, State};
    let in_phase = |phase| State { phase, version: Some("1.0.1".into()), attempts: 1, ..State::default() };
    for phase in [Phase::Downloading, Phase::Planned, Phase::Staged, Phase::Swapping, Phase::Swapped, Phase::PendingConfirm, Phase::RollingBack] {
        assert_eq!(admission(&in_phase(phase), false), Admission::Wait, "{phase:?}");
    }
    assert_eq!(admission(&in_phase(Phase::Ready), false), Admission::Ready);
    for phase in [Phase::Idle, Phase::Confirmed, Phase::Aborted, Phase::RolledBack] {
        assert_eq!(admission(&in_phase(phase), false), Admission::Download, "{phase:?}");
        // M4: a watchdog that has not yet seen its confirmation is still alive.
        assert_eq!(admission(&in_phase(phase), true), Admission::Wait, "{phase:?}");
    }
}
#[test]
fn r1_every_profile_meets_the_same_leases_for_one_install() {
    let install = std::path::Path::new("/Applications/SingZ.app");
    let (a, b) = (std::path::Path::new("/Users/a/profile-1"), std::path::Path::new("/Users/a/profile-2"));
    let (da, db) = (updater_dir(a, install, true).unwrap(), updater_dir(b, install, true).unwrap());
    assert_eq!(da, db, "two profiles must coordinate through one directory");
    assert_eq!(da.parent(), install.parent(), "beside the install, with its staged and previous payloads");
    assert_ne!(updater_dir(a, std::path::Path::new("/Applications/SingZ Beta.app"), true).unwrap(), da);
    // An install that cannot update itself never applies; it only logs per profile.
    assert!(updater_dir(a, install, false).unwrap().starts_with(a));
}
#[test]
fn f2_an_untrusted_coordination_directory_falls_back_to_the_download_link() {
    let root = std::env::temp_dir().join(format!("singz-host-f2-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    let install = root.join("SingZ.app");
    std::fs::create_dir_all(&install).unwrap();
    std::fs::create_dir_all(root.join("elsewhere")).unwrap();
    crate::updater_state::tests::dir_link(&root.join("elsewhere"), &state::coordination_dir(&install).unwrap());
    let config = root.join("profile");
    let (dir, manual, note) = resolve_dir(&config, &install, None);
    assert_eq!(manual, Some("update-directory-untrusted"), "not silent: the link is offered instead");
    assert!(dir.starts_with(&config) && note.is_some());
    assert!(std::fs::read_dir(root.join("elsewhere")).unwrap().next().is_none(), "nothing was written through the link");
    std::fs::remove_dir_all(&root).unwrap();
}

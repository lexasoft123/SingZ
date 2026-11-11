use super::*;

#[test]
#[cfg(unix)]
fn extracted_links_may_not_leave_the_payload() {
    let root = std::env::temp_dir().join(format!("singz-links-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(root.join("Frameworks/V")).unwrap();
    std::os::unix::fs::symlink("V", root.join("Frameworks/Current")).unwrap();
    std::os::unix::fs::symlink("../V", root.join("Frameworks/V/up")).unwrap();
    check_tree(&root).unwrap();
    std::os::unix::fs::symlink("../../../outside", root.join("Frameworks/V/escape")).unwrap();
    assert!(check_tree(&root).is_err());
    std::fs::remove_file(root.join("Frameworks/V/escape")).unwrap();
    std::os::unix::fs::symlink("/etc/passwd", root.join("abs")).unwrap();
    assert!(check_tree(&root).is_err());
    std::fs::remove_file(root.join("abs")).unwrap();
    // R5: each link passes the lexical rule, but composed they leave the payload.
    std::os::unix::fs::symlink(".", root.join("Frameworks/a")).unwrap();
    check_tree(&root).unwrap();
    std::os::unix::fs::symlink("a/../..", root.join("Frameworks/escape")).unwrap();
    assert!(format!("{:#}", check_tree(&root).unwrap_err()).contains("resolves outside"));
    std::fs::remove_dir_all(root).unwrap();
}
#[test]
#[cfg(target_os = "macos")]
fn payload_root_is_the_app_bundle() {
    let exe = Path::new("/Applications/SingZ Preview.app/Contents/MacOS/singz-gpui-player");
    let (install, rel) = payload_layout(exe).unwrap();
    assert_eq!(install, Path::new("/Applications/SingZ Preview.app"));
    assert_eq!(rel, Path::new("Contents/MacOS/singz-gpui-player"));
    assert!(payload_layout(Path::new("/tmp/target/debug/singz-gpui-player")).is_none());
    assert_eq!(eligibility(Path::new("/tmp/target/debug/singz-gpui-player")), Eligibility::NotInstalled);
}
#[test]
#[cfg(target_os = "macos")]
fn translocated_and_read_only_installs_fall_back_to_the_download_link() {
    let moved = Path::new("/private/var/folders/x/AppTranslocation/ABC/d/SingZ.app/Contents/MacOS/singz-gpui-player");
    assert_eq!(eligibility(moved), Eligibility::Manual("translocated"));
    let root = std::env::temp_dir().join(format!("singz-stage-ro-{}", std::process::id()));
    let exe = root.join("SingZ.app/Contents/MacOS/singz-gpui-player");
    std::fs::create_dir_all(exe.parent().unwrap()).unwrap();
    assert!(matches!(eligibility(&exe), Eligibility::Updatable { .. }));
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
    let writable_anyway = std::fs::write(root.join("probe"), b"").is_ok(); // running as root
    let result = eligibility(&exe);
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    let _ = std::fs::remove_file(root.join("probe"));
    std::fs::remove_dir_all(&root).unwrap();
    if !writable_anyway {
        assert_eq!(result, Eligibility::Manual("not-writable"));
    }
}
#[test]
fn the_publisher_pin_is_provisioned_and_names_the_apple_team() {
    assert_eq!(PINNED_TEAM_ID, "USJ7H3X44X");
    assert_eq!(
        publisher_requirement("USJ7H3X44X"),
        "anchor apple generic and certificate leaf[subject.OU] = \"USJ7H3X44X\""
    );
}
#[cfg(target_os = "macos")]
fn ad_hoc_bundle(name: &str) -> PathBuf {
    let app = std::env::temp_dir().join(format!("singz-pin-{name}-{}/Other.app", std::process::id()));
    let _ = std::fs::remove_dir_all(app.parent().unwrap());
    std::fs::create_dir_all(app.join("Contents/MacOS")).unwrap();
    std::fs::copy("/usr/bin/true", app.join("Contents/MacOS/app")).unwrap();
    std::fs::write(
        app.join("Contents/Info.plist"),
        r#"<?xml version="1.0" encoding="UTF-8"?><plist version="1.0"><dict><key>CFBundleIdentifier</key><string>com.lexasoft.singz.gpui.preview</string><key>CFBundleExecutable</key><string>app</string></dict></plist>"#,
    )
    .unwrap();
    assert!(Command::new("codesign").args(["--force", "--sign", "-"]).arg(&app).status().unwrap().success());
    app
}
#[test]
#[cfg(target_os = "macos")]
fn a_bundle_from_another_team_is_rejected_even_with_the_right_bundle_id() {
    // Same bundle identifier, validly (ad-hoc) signed, but not by the pinned team.
    let app = ad_hoc_bundle("other-team");
    assert!(verify_publisher(&app, PINNED_TEAM_ID).is_err());
    assert!(verify_publisher(&app, "AAAAAAAAAA").is_err());
    std::fs::remove_dir_all(app.parent().unwrap()).unwrap();
}
#[test]
#[cfg(all(target_os = "macos", not(feature = "test-hooks")))]
fn without_a_provisioned_pin_a_shipped_build_refuses_to_install() {
    let app = ad_hoc_bundle("no-pin");
    assert!(verify_publisher(&app, "").is_err(), "an empty pin must fail closed");
    std::fs::remove_dir_all(app.parent().unwrap()).unwrap();
}
#[test]
#[cfg(unix)]
fn f3_the_writability_probe_never_opens_a_planted_name() {
    let root = std::env::temp_dir().join(format!("singz-probe-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&root);
    std::fs::create_dir_all(&root).unwrap();
    let victim = root.join("victim.txt");
    std::fs::write(&victim, "precious").unwrap();
    // The old, predictable name, planted as a link to someone's document.
    std::os::unix::fs::symlink(&victim, root.join(format!(".singz-write-probe-{}", std::process::id()))).unwrap();
    assert!(probe_writable(&root));
    assert_eq!(std::fs::read_to_string(&victim).unwrap(), "precious", "the probe truncated a planted target");
    let names: Vec<_> = std::fs::read_dir(&root).unwrap().map(|e| e.unwrap().file_name()).collect();
    assert_eq!(names.len(), 2, "the probe removes only what it created: {names:?}");
    use std::os::unix::fs::PermissionsExt;
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o555)).unwrap();
    let writable_anyway = unsafe { libc::geteuid() } == 0;
    let result = probe_writable(&root);
    std::fs::set_permissions(&root, std::fs::Permissions::from_mode(0o755)).unwrap();
    if !writable_anyway {
        assert!(!result);
    }
    std::fs::remove_dir_all(&root).unwrap();
}

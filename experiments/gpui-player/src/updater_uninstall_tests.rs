use super::*;
use std::fs;
use std::path::PathBuf;

fn temp(name: &str) -> PathBuf {
    let p = std::env::temp_dir().join(format!(
        "singz-uninstall-{name}-{}-{}-{}",
        std::process::id(),
        std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).unwrap().as_nanos(),
        {
            // Parallel tests can read the same clock value (macOS reports microseconds).
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        }
    ));
    fs::create_dir_all(&p).unwrap();
    p
}
fn inventory(install: &Path, names: &[&str]) {
    let files: Vec<_> = names.iter().map(|n| serde_json::json!({"path": n})).collect();
    fs::write(install.join("manifest.json"), serde_json::json!({"schema": 1, "files": files}).to_string()).unwrap();
}

#[test]
#[cfg(unix)]
fn f1_a_tampered_inventory_cannot_reach_through_an_intermediate_link() {
    use std::os::unix::fs::symlink;
    let root = temp("f1");
    let install = root.join("SingZ Native");
    let user = root.join("Documents");
    fs::create_dir_all(user.join("deep")).unwrap();
    fs::write(user.join("private.txt"), "mine").unwrap();
    fs::write(user.join("deep/c.dll"), "mine too").unwrap();
    fs::create_dir_all(install.join("a")).unwrap();
    fs::write(install.join("app.exe"), "x").unwrap();
    fs::write(install.join("real.dll"), "x").unwrap();
    // `engines` and `a/b` were swapped for links into the user's documents;
    // `leaf.dll` is a link to a user file; `empty` links to an empty user folder.
    symlink(&user, install.join("engines")).unwrap();
    symlink(&user, install.join("a/b")).unwrap();
    symlink(user.join("private.txt"), install.join("leaf.dll")).unwrap();
    fs::create_dir_all(root.join("EmptyUserFolder")).unwrap();
    symlink(root.join("EmptyUserFolder"), install.join("empty")).unwrap();
    inventory(&install, &["app.exe", "real.dll", "engines/private.txt", "a/b/deep/c.dll", "leaf.dll", "empty/x.txt"]);
    let result = uninstall_payload(&install, Path::new("app.exe"));
    assert_eq!(fs::read_to_string(user.join("private.txt")).ok().as_deref(), Some("mine"), "deleted through a directory link");
    assert_eq!(fs::read_to_string(user.join("deep/c.dll")).ok().as_deref(), Some("mine too"), "deleted through a nested link");
    assert!(root.join("EmptyUserFolder").is_dir(), "removed a directory through a link");
    let error = result.unwrap_err();
    assert!(format!("{error:#}").contains("left in place"), "{error:#}");
    assert!(!install.join("real.dll").exists(), "the real payload file is still removed");
    assert!(install.join("app.exe").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn f1_an_install_path_that_is_itself_a_link_is_refused() {
    let root = temp("f1-root");
    fs::create_dir_all(root.join("elsewhere")).unwrap();
    fs::write(root.join("elsewhere/x.dll"), "keep").unwrap();
    inventory(&root.join("elsewhere"), &["x.dll"]);
    crate::updater_state::tests::dir_link(&root.join("elsewhere"), &root.join("install"));
    assert!(uninstall_payload(&root.join("install"), Path::new("app.exe")).is_err());
    assert_eq!(fs::read_to_string(root.join("elsewhere/x.dll")).unwrap(), "keep");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn f1_directory_links_and_junctions_are_never_crossed() {
    use crate::updater_state::tests::dir_link;
    let root = temp("f1-junction");
    let install = root.join("SingZ Native");
    let user = root.join("Documents");
    fs::create_dir_all(user.join("deep")).unwrap();
    fs::write(user.join("private.txt"), "mine").unwrap();
    fs::write(user.join("deep").join("c.dll"), "mine too").unwrap();
    fs::create_dir_all(install.join("a")).unwrap();
    fs::write(install.join("real.dll"), "x").unwrap();
    dir_link(&user, &install.join("engines"));
    dir_link(&user, &install.join("a").join("b"));
    inventory(&install, &["real.dll", "engines/private.txt", "a/b/deep/c.dll", "engines/deep/c.dll"]);
    let result = uninstall_payload(&install, Path::new("app.exe"));
    assert_eq!(fs::read_to_string(user.join("private.txt")).ok().as_deref(), Some("mine"), "deleted through a link");
    assert_eq!(fs::read_to_string(user.join("deep").join("c.dll")).ok().as_deref(), Some("mine too"));
    assert!(user.join("deep").is_dir(), "a directory behind a link was removed");
    assert!(!install.join("real.dll").exists(), "the real payload file is still removed");
    assert!(format!("{:#}", result.unwrap_err()).contains("left in place"), "a refusal must fail the uninstall step");
    // A refusal leaves the inventory behind, so nothing is forgotten.
    assert!(install.join("manifest.json").exists(), "the inventory was deleted after a refusal");
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn the_original_and_the_current_inventories_are_both_removed() {
    let root = temp("inventories");
    let install = root.join("SingZ Native");
    for name in ["app.exe", "old-only.dll", "shared.dll", "nested/new-in-n1.dll"] {
        let path = install.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, name).unwrap();
    }
    fs::write(install.join("notes.txt"), "the user's").unwrap();
    inventory(&install, &["app.exe", "shared.dll", "nested/new-in-n1.dll"]); // N+1, after an update
    let original: Vec<_> = ["app.exe", "old-only.dll", "shared.dll"].iter().map(|n| serde_json::json!({"path": n})).collect();
    fs::write(install.join(ORIGINAL_INVENTORY), serde_json::json!({"files": original}).to_string()).unwrap();
    uninstall_payload(&install, Path::new("app.exe")).unwrap();
    for gone in ["old-only.dll", "shared.dll", "nested", "manifest.json", ORIGINAL_INVENTORY] {
        assert!(!install.join(gone).exists(), "{gone} was left behind");
    }
    assert!(install.join("app.exe").exists() && install.join("notes.txt").exists());
    fs::remove_dir_all(root).unwrap();
}
#[test]
fn a_retry_after_a_partly_refused_uninstall_completes() {
    use crate::updater_swap::{FAULTS, Faults};
    let root = temp("retry");
    let install = root.join("SingZ Native");
    for name in ["app.exe", "busy.dll", "sub/deep/a.dll", "sub/b.dll"] {
        let path = install.join(name);
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(path, name).unwrap();
    }
    inventory(&install, &["app.exe", "busy.dll", "sub/deep/a.dll", "sub/b.dll"]);
    // First pass: busy.dll is held open (a transient refusal); the `sub`
    // subtree is removed with its directories; the inventory is kept.
    FAULTS.with(|f| *f.borrow_mut() = Faults { fail_at: Some(0), ..Faults::default() });
    let first = uninstall_payload(&install, Path::new("app.exe"));
    FAULTS.with(|f| *f.borrow_mut() = Faults::default());
    assert!(format!("{:#}", first.unwrap_err()).contains("busy.dll"));
    assert!(install.join("busy.dll").exists() && !install.join("sub").exists());
    assert!(install.join("manifest.json").exists(), "the inventory must survive a refusal");
    // Second pass: the listed subtree is already gone; that is not an error.
    uninstall_payload(&install, Path::new("app.exe")).unwrap();
    assert!(!install.join("busy.dll").exists() && !install.join("manifest.json").exists());
    assert!(install.join("app.exe").exists());
    fs::remove_dir_all(root).unwrap();
}

//! Safe payload extraction, platform publisher checks and self-update
//! eligibility (writability, translocation, read-only volumes).
use crate::updater_zip as zip;
use anyhow::{Context, Result, ensure};
use std::{
    path::{Component, Path, PathBuf},
    process::Command,
};

/// The Apple Team ID the staged app must be signed by (D-04 section 6).
pub const PINNED_TEAM_ID: &str = "USJ7H3X44X";

/// The running install this process could replace, or why it cannot.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Eligibility {
    /// `install` is the app payload directory (the `.app`, or the Windows
    /// payload folder); `exe_rel` is the running executable inside it.
    Updatable { install: PathBuf, exe_rel: PathBuf },
    /// Offer the download link instead (Electron's `available` state).
    Manual(&'static str),
    /// Not an installed app (a development run): no updater at all.
    NotInstalled,
}

/// Pure layout rule: where the payload root is for an executable path.
pub fn payload_layout(exe: &Path) -> Option<(PathBuf, PathBuf)> {
    if cfg!(target_os = "macos") {
        // <X>.app/Contents/MacOS/<exe>
        let install = exe
            .ancestors()
            .find(|p| p.extension().is_some_and(|e| e == "app"))?;
        Some((install.to_path_buf(), exe.strip_prefix(install).ok()?.to_path_buf()))
    } else {
        let install = exe.parent()?;
        Some((install.to_path_buf(), PathBuf::from(exe.file_name()?)))
    }
}
pub fn eligibility(exe: &Path) -> Eligibility {
    let Some((install, exe_rel)) = payload_layout(exe) else {
        return Eligibility::NotInstalled;
    };
    if cfg!(target_os = "linux") {
        return Eligibility::NotInstalled; // preview target: check and offer only
    }
    if cfg!(target_os = "macos") && install.to_string_lossy().contains("/AppTranslocation/") {
        return Eligibility::Manual("translocated");
    }
    let Some(parent) = install.parent() else {
        return Eligibility::Manual("no-parent");
    };
    // The probe is created in the install's parent: staging, the swap and the
    // retained previous payload all live there, on the same volume.
    if !probe_writable(parent) {
        return Eligibility::Manual("not-writable");
    }
    Eligibility::Updatable { install, exe_rel }
}
/// Can this process create entries in `dir`? The probe has an unpredictable
/// name and is created with `create_new` and no-follow, so nothing planted in
/// advance (a link to someone's document) is ever opened or truncated, and
/// only the file this call created is removed.
pub fn probe_writable(dir: &Path) -> bool {
    let mut nonce = [0u8; 16];
    if getrandom::fill(&mut nonce).is_err() {
        return false;
    }
    let name: String = nonce.iter().map(|b| format!("{b:02x}")).collect();
    let probe = dir.join(format!(".singz-write-probe-{name}"));
    let created = crate::updater_state::no_follow(std::fs::OpenOptions::new().write(true).create_new(true)).open(&probe);
    match created {
        Ok(file) => {
            drop(file);
            let _ = std::fs::remove_file(&probe);
            true
        }
        Err(_) => false,
    }
}

/// After extraction: no link may leave the payload root (and none at all on Windows).
pub fn check_tree(root: &Path) -> Result<()> {
    fn walk(root: &Path, dir: &Path) -> Result<()> {
        for entry in std::fs::read_dir(dir)? {
            let path = entry?.path();
            let meta = std::fs::symlink_metadata(&path)?;
            if meta.file_type().is_symlink() {
                ensure!(!cfg!(windows), "payload contains a link");
                zip::check_resolved(root, &path)?;
                let target = std::fs::read_link(&path)?;
                let mut depth = path.strip_prefix(root)?.components().count() as i64 - 1;
                ensure!(!target.is_absolute(), "payload link points outside the payload");
                for part in target.components() {
                    match part {
                        Component::ParentDir => depth -= 1,
                        Component::Normal(_) => depth += 1,
                        _ => {}
                    }
                    ensure!(depth >= 0, "payload link points outside the payload");
                }
            } else if meta.is_dir() {
                walk(root, &path)?;
            }
        }
        Ok(())
    }
    walk(root, root)
}
/// Extract `archive` into `scratch` (made empty first) and check the result:
/// one bounded Rust reader on every platform, then the link rule, the
/// application executable, and the platform publisher check. Returns the
/// payload root inside `scratch`. `cancelled` is polled while writing.
pub fn materialize(
    archive: &Path,
    install: &Path,
    exe_rel: &Path,
    scratch: &Path,
    cancelled: &dyn Fn() -> bool,
) -> Result<PathBuf> {
    let mut zip = zip::open(archive, &zip::LIMITS, !cfg!(windows))?;
    crate::updater_swap::remove_tree(scratch)?;
    std::fs::create_dir(scratch).context("create extraction scratch")?;
    let payload = zip.extract(scratch, cancelled)?;
    ensure!(!cancelled(), "update cancelled");
    ensure!(payload.join(exe_rel).is_file(), "update payload does not contain the application executable");
    check_tree(&payload)?;
    verify_platform(&payload, install)?;
    Ok(payload)
}
/// The app's pre-flight: prove a downloaded archive can be staged before
/// offering "Restart to update", then discard the extraction.
pub fn check_archive(archive: &Path, install: &Path, exe_rel: &Path, cancelled: &dyn Fn() -> bool) -> Result<()> {
    let scratch = crate::updater_swap::check_path(install)?;
    let result = materialize(archive, install, exe_rel, &scratch, cancelled).map(|_| ());
    let _ = crate::updater_swap::remove_tree(&scratch);
    result
}
#[cfg(target_os = "macos")]
fn plist_value(app: &Path, key: &str) -> Option<String> {
    let out = Command::new("/usr/libexec/PlistBuddy")
        .arg("-c")
        .arg(format!("Print :{key}"))
        .arg(app.join("Contents/Info.plist"))
        .output()
        .ok()?;
    out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned())
}
/// The designated requirement every staged macOS bundle must satisfy.
pub fn publisher_requirement(team: &str) -> String {
    format!("anchor apple generic and certificate leaf[subject.OU] = \"{team}\"")
}
/// `codesign` must accept the bundle under the publisher requirement. An empty
/// team fails closed outside local test builds (ad-hoc bundles are test-only).
pub fn verify_publisher(payload: &Path, team: &str) -> Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut verify = Command::new("codesign");
        verify.args(["--verify", "--deep", "--strict"]);
        if team.is_empty() {
            ensure!(cfg!(feature = "test-hooks"), "no publisher pin is provisioned; refusing to install");
        } else {
            verify.arg(format!("-R={}", publisher_requirement(team)));
        }
        ensure!(
            verify.arg(payload).status()?.success(),
            "staged application is not signed by the pinned publisher"
        );
    }
    let _ = (payload, team);
    Ok(())
}
pub fn verify_platform(payload: &Path, install: &Path) -> Result<()> {
    ensure!(payload.exists(), "staged payload is missing");
    #[cfg(target_os = "macos")]
    {
        ensure!(
            plist_value(payload, "CFBundleIdentifier").is_some()
                && plist_value(payload, "CFBundleIdentifier") == plist_value(install, "CFBundleIdentifier"),
            "staged application has a different bundle identifier"
        );
        // Local ad-hoc test bundles cannot satisfy a Developer ID requirement;
        // only a `test-hooks` build skips the pin, a shipped binary never does.
        let team = if cfg!(feature = "test-hooks") { "" } else { PINNED_TEAM_ID };
        verify_publisher(payload, team)?;
        #[cfg(not(feature = "test-hooks"))]
        ensure!(
            Command::new("spctl")
                .args(["-a", "-t", "exec", "--context", "context:primary-signature"])
                .arg(payload)
                .status()?
                .success(),
            "Gatekeeper rejected staged application"
        );
    }
    // Windows has no publisher certificate in C-31: the already-verified
    // manifest signature and archive digest are its authenticity anchor.
    let _ = install;
    Ok(())
}
#[cfg(test)]
#[path = "updater_stage_tests.rs"]
mod tests;

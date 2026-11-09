//! Reuse the desktop OAuth application configuration without executing Node.
//! This is application configuration, never access/refresh tokens or account data.
use std::{env, fs, path::PathBuf};
mod build_config;
mod build_i18n;

fn main() {
    let i18n_root =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../../src/shared/i18n");
    println!("cargo:rerun-if-changed=build_i18n.rs");
    println!("cargo:rerun-if-changed={}", i18n_root.display());
    let dictionaries = build_i18n::extract(&i18n_root)
        .expect("Source i18n dictionaries must remain literal string objects");
    fs::write(
        PathBuf::from(env::var_os("OUT_DIR").unwrap()).join("i18n.json"),
        serde_json::to_vec(&dictionaries).unwrap(),
    )
    .unwrap();
    println!("cargo:rerun-if-changed=build_config.rs");
    let root = PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").unwrap()).join("../..");
    embed_analyzer_source_hash(&root);
    for directive in build_config::rerun_directives(&root) {
        println!("{directive}");
    }
    let canonical = build_config::read_source(&root.join(build_config::CANONICAL_PATH));
    let legacy = build_config::read_source(&root.join(build_config::LEGACY_PATH));
    let selected = build_config::select(&canonical, &legacy);
    let required =
        env::var_os(build_config::REQUIRE_ENV).as_deref() == Some(std::ffi::OsStr::new("1"));
    if let Err(message) = build_config::require_config(required, &selected) {
        panic!("{message}");
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let destination = output.join("drive-config.json");
    fs::write(&destination, selected.config_json.as_bytes())
        .expect("Could not write baked Drive application configuration");
    fs::write(
        output.join("drive-config-metadata.json"),
        selected.metadata_json(),
    )
    .expect("Could not write safe Drive build metadata");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

// Use the same established source fingerprint as the native helper producer.
// A missing tool/source tree leaves the diagnostic unchecked; it never makes
// analyzer execution dependent on having a checkout on the singer's machine.
fn embed_analyzer_source_hash(root: &std::path::Path) {
    for input in [
        "zcore",
        "zdsp",
        "third_party/native",
        "tools/native",
        "cmake",
        "CMakeLists.txt",
        "scripts/vendor-analyze.sh",
        "scripts/analyze-source-hash.sh",
    ] {
        println!("cargo:rerun-if-changed={}", root.join(input).display());
    }
    let mut command = std::process::Command::new("bash");
    if cfg!(windows) {
        command.args(["-c", "export PATH=\"/usr/bin:$PATH\"; root=$(cygpath -u \"$1\") || exit; exec bash \"$root/scripts/analyze-source-hash.sh\" \"$root\"", "gpui-analyze-hash"])
            .arg(root);
    } else {
        command
            .arg(root.join("scripts/analyze-source-hash.sh"))
            .arg(root);
    }
    let hash = command
        .output()
        .ok()
        .filter(|out| out.status.success())
        .and_then(|out| String::from_utf8(out.stdout).ok())
        .map(|hash| hash.trim().to_owned())
        .filter(|hash| {
            hash.len() == 40
                && hash
                    .bytes()
                    .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
        });
    if let Some(hash) = hash {
        println!("cargo:rustc-env=SINGZ_EXPECTED_ANALYZE_SOURCE_HASH={hash}");
    } else {
        println!("cargo:rustc-env=SINGZ_EXPECTED_ANALYZE_SOURCE_HASH=");
        println!(
            "cargo:warning=Analyzer source fingerprint unavailable; runtime provenance will be unchecked"
        );
    }
}

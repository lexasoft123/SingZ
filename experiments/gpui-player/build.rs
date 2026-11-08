//! Reuse the desktop OAuth application configuration without executing Node.
//! This is application configuration, never access/refresh tokens or account data.
use std::{env, fs, path::PathBuf};
mod build_i18n;
mod build_config;

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
    for directive in build_config::rerun_directives(&root) {
        println!("{directive}");
    }
    let canonical = build_config::read_source(&root.join(build_config::CANONICAL_PATH));
    let legacy = build_config::read_source(&root.join(build_config::LEGACY_PATH));
    let selected = build_config::select(&canonical, &legacy);
    let required = env::var_os(build_config::REQUIRE_ENV).as_deref() == Some(std::ffi::OsStr::new("1"));
    if let Err(message) = build_config::require_config(required, &selected) {
        panic!("{message}");
    }
    let output = PathBuf::from(env::var_os("OUT_DIR").unwrap());
    let destination = output.join("drive-config.json");
    fs::write(&destination, selected.config_json.as_bytes()).expect("Could not write baked Drive application configuration");
    fs::write(output.join("drive-config-metadata.json"), selected.metadata_json())
        .expect("Could not write safe Drive build metadata");
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(destination, fs::Permissions::from_mode(0o600)).unwrap();
    }
}

use super::*;
use ed25519_dalek::{Signer, SigningKey};

#[test]
fn signature_accepts_only_bytes_signed_by_a_trusted_key() {
    let good = SigningKey::from_bytes(&[7; 32]);
    let wrong = SigningKey::from_bytes(&[8; 32]);
    let bytes = br#"{"version":"1.2.3"}"#;
    let sig = good.sign(bytes).to_bytes();
    assert!(verify(bytes, &sig, &[good.verifying_key().to_bytes()]).is_ok());
    assert!(verify(bytes, &sig, &[wrong.verifying_key().to_bytes()]).is_err());
    let mut changed = bytes.to_vec();
    changed[10] ^= 1;
    assert!(verify(&changed, &sig, &[good.verifying_key().to_bytes()]).is_err());
}
#[test]
fn manifest_rejects_unsafe_archive_paths_and_invalid_hashes() {
    let raw=br#"{"schema":1,"version":"1.2.3","channel":"stable","target":"macos-arm64","archive":{"name":"../payload.zip","bytes":8,"sha256":"0000000000000000000000000000000000000000000000000000000000000000"},"rollbackFloor":"1.0.0"}"#;
    assert!(parse(raw).is_err());
}
#[test]
fn versions_order_prereleases_and_channel_selection_is_strict() {
    assert_eq!(compare("0.27.0-beta.2", "0.27.0"), std::cmp::Ordering::Less);
    assert!(valid_version("0.27.0-beta.2"));
    assert!(!valid_version("0.27.0-"));
    assert!(!valid_version("01.2.3"));
    assert!(valid_version("0.27.0+build.4"));
    assert_eq!(
        compare("0.27.0+one", "0.27.0+two"),
        std::cmp::Ordering::Equal
    );
    let make = |version: &str, channel| Manifest {
        schema: 1,
        version: version.into(),
        channel,
        target: "macos-arm64".into(),
        archive: Archive {
            name: "payload.zip".into(),
            bytes: 1,
            sha256: "0".repeat(64),
        },
        min_os: None,
        rollback_floor: "0.26.0".into(),
        notes_url: None,
    };
    let list = vec![
        make("0.27.0-beta.2", Channel::Beta),
        make("0.27.0", Channel::Stable),
        make("0.28.0", Channel::Stable),
    ];
    // Beta sees both channels and takes the highest version carrying the target.
    assert_eq!(
        select(&list, Channel::Beta, "macos-arm64", "0.27.0-beta.1", &[])
            .unwrap()
            .version,
        "0.28.0"
    );
    assert_eq!(
        select(&list[..1], Channel::Beta, "macos-arm64", "0.27.0-beta.1", &[])
            .unwrap()
            .version,
        "0.27.0-beta.2"
    );
    assert!(select(&list[..1], Channel::Stable, "macos-arm64", "0.26.0", &[]).is_none());
    assert_eq!(
        select(&list, Channel::Stable, "macos-arm64", "0.27.0", &[])
            .unwrap()
            .version,
        "0.28.0"
    );
    assert!(select(&list, Channel::Stable, "windows-x64", "0.26.0", &[]).is_none());
    assert_eq!(
        select(
            &list,
            Channel::Stable,
            "macos-arm64",
            "0.26.0",
            &["0.28.0".into()]
        )
        .unwrap()
        .version,
        "0.27.0"
    );
}

#[test]
fn an_unprovisioned_zero_key_never_verifies_even_a_forged_signature() {
    // The all-zero slot decodes to a small-order point. Lenient verification of
    // such a key accepts forgeries; the placeholder must be inert instead.
    let bytes = b"anything";
    let forged = [0u8; 64];
    assert!(verify(bytes, &forged, &PUBLIC_KEYS).is_err());
    assert!(verify(bytes, &forged, &[[0; 32]]).is_err());
    let identity = {
        let mut y = [0u8; 32];
        y[0] = 1; // the identity point: every signature "verifies" without strict checks
        y
    };
    let mut sig = [0u8; 64];
    sig[0] = 1; // R = identity, S = 0
    assert!(verify(bytes, &sig, &[identity]).is_err());
}
#[test]
fn a_shipped_build_trusts_only_the_baked_keys() {
    #[cfg(not(feature = "test-hooks"))]
    assert_eq!(trusted_keys(), PUBLIC_KEYS.to_vec());
}
#[test]
fn archive_size_is_bounded_whatever_the_signed_manifest_claims() {
    let raw = |bytes: &str| {
        format!(r#"{{"schema":1,"version":"1.2.3","channel":"stable","target":"macos-arm64","archive":{{"name":"p.zip","bytes":{bytes},"sha256":"{}"}},"rollbackFloor":"1.0.0"}}"#, "0".repeat(64))
    };
    assert!(parse(raw("1048576").as_bytes()).is_ok());
    assert!(parse(raw("0").as_bytes()).is_err());
    assert!(parse(raw("99999999999999").as_bytes()).is_err());
}

fn manifest_with(min_os: Option<&str>, floor: &str) -> Manifest {
    Manifest {
        schema: 1,
        version: "0.28.0".into(),
        channel: Channel::Stable,
        target: "macos-arm64".into(),
        archive: Archive { name: "p.zip".into(), bytes: 1, sha256: "0".repeat(64) },
        min_os: min_os.map(Into::into),
        rollback_floor: floor.into(),
        notes_url: None,
    }
}
#[test]
fn os_versions_compare_numerically_part_by_part() {
    assert!(os_at_least("14.2", "13.0"));
    assert!(os_at_least("13.0", "13.0.0"));
    assert!(os_at_least("10.0.19045", "10.0.17763"));
    assert!(!os_at_least("12.7.6", "13.0"));
    assert!(!os_at_least("9.0", "10.0"), "numeric, not lexical");
    assert!(!os_at_least("garbage", "13.0"));
}
#[test]
fn a_running_version_below_the_rollback_floor_gets_the_download_link_not_a_swap() {
    let m = manifest_with(None, "0.27.0");
    assert_eq!(compat(&m, "0.26.9", Some("14.0")), Compat::BelowFloor);
    assert_eq!(compat(&m, "0.27.0", Some("14.0")), Compat::Ok);
    assert_eq!(compat(&m, "0.27.1-beta.1", Some("14.0")), Compat::Ok);
    assert_eq!(compat(&m, "0.27.0-beta.1", Some("14.0")), Compat::BelowFloor, "a prerelease precedes its release");
}
#[test]
fn an_unsupported_or_unknown_operating_system_is_never_offered_the_update() {
    let m = manifest_with(Some("15.0"), "0.26.0");
    assert_eq!(compat(&m, "0.27.0", Some("14.6")), Compat::UnsupportedOs);
    assert_eq!(compat(&m, "0.27.0", None), Compat::UnsupportedOs, "unknown host fails closed");
    assert_eq!(compat(&m, "0.27.0", Some("15.1")), Compat::Ok);
    assert_eq!(compat(&manifest_with(None, "0.26.0"), "0.27.0", None), Compat::Ok, "no minOs, no check");
}

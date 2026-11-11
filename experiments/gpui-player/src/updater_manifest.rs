//! Pure validation for the signed native update feed.
use anyhow::{Result, ensure};
use ed25519_dalek::{Signature, VerifyingKey};
use serde::{Deserialize, Serialize};

/// Two baked Ed25519 trust slots (D-04: ship the next key one release ahead to
/// rotate). All-zero slots are unprovisioned placeholders and never verify.
/// PLACEHOLDER: the coordinator replaces both before the first signed release.
pub const PUBLIC_KEYS: [[u8; 32]; 2] = [[0; 32], [0; 32]];
/// Largest update archive the app will download, whatever the manifest claims.
pub const MAX_ARCHIVE_BYTES: u64 = 2 << 30;

/// Keys the running binary trusts. Only a `test-hooks` build may add one more
/// from the environment; a shipped binary has no such path.
pub fn trusted_keys() -> Vec<[u8; 32]> {
    #[allow(unused_mut)]
    let mut keys = PUBLIC_KEYS.to_vec();
    #[cfg(feature = "test-hooks")]
    if let Some(key) = std::env::var("SINGZ_UPDATE_TEST_PUBLIC_KEY")
        .ok()
        .and_then(|hex| decode_hex32(&hex))
    {
        keys.push(key);
    }
    keys
}
#[cfg(feature = "test-hooks")]
fn decode_hex32(hex: &str) -> Option<[u8; 32]> {
    let hex = hex.trim();
    if hex.len() != 64 || !hex.is_ascii() {
        return None;
    }
    let mut out = [0u8; 32];
    for (i, byte) in out.iter_mut().enumerate() {
        *byte = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).ok()?;
    }
    Some(out)
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Manifest {
    pub schema: u32,
    pub version: String,
    pub channel: Channel,
    pub target: String,
    pub archive: Archive,
    pub min_os: Option<String>,
    pub rollback_floor: String,
    pub notes_url: Option<String>,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Archive {
    pub name: String,
    pub bytes: u64,
    pub sha256: String,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Channel {
    Stable,
    Beta,
}

pub fn verify(bytes: &[u8], sig: &[u8], keys: &[[u8; 32]]) -> Result<()> {
    let sig = Signature::from_slice(sig)?;
    // `verify_strict` rejects small-order (weak) public keys, so an
    // unprovisioned all-zero slot can never accept a forged signature.
    ensure!(
        keys.iter().any(|raw| *raw != [0; 32]
            && VerifyingKey::from_bytes(raw)
                .is_ok_and(|key| key.verify_strict(bytes, &sig).is_ok())),
        "manifest signature is invalid"
    );
    Ok(())
}
pub fn parse(bytes: &[u8]) -> Result<Manifest> {
    let manifest: Manifest = serde_json::from_slice(bytes)?;
    ensure!(manifest.schema == 1, "unsupported update manifest schema");
    ensure!(
        valid_version(&manifest.version) && valid_version(&manifest.rollback_floor),
        "invalid update version"
    );
    ensure!(
        !manifest.archive.name.is_empty()
            && !manifest.archive.name.contains('/')
            && !manifest.archive.name.contains('\\'),
        "invalid update archive name"
    );
    ensure!(
        manifest.archive.bytes > 0 && manifest.archive.bytes <= MAX_ARCHIVE_BYTES,
        "invalid update archive size"
    );
    ensure!(
        manifest.archive.sha256.len() == 64
            && manifest
                .archive
                .sha256
                .bytes()
                .all(|b| b.is_ascii_hexdigit()),
        "invalid update archive digest"
    );
    Ok(manifest)
}
pub fn valid_version(s: &str) -> bool {
    let core = s.strip_prefix('v').unwrap_or(s);
    let (without_build, build) = core
        .split_once('+')
        .map_or((core, None), |(a, b)| (a, Some(b)));
    let (base, pre) = without_build
        .split_once('-')
        .map_or((without_build, None), |(a, b)| (a, Some(b)));
    let parts: Vec<_> = base.split('.').collect();
    let numeric = |x: &str| {
        !x.is_empty() && x.bytes().all(|b| b.is_ascii_digit()) && (x == "0" || !x.starts_with('0'))
    };
    let labels = |value: &str| {
        !value.is_empty()
            && value
                .split('.')
                .all(|x| !x.is_empty() && x.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'-'))
    };
    parts.len() == 3
        && parts.iter().all(|x| numeric(x))
        && pre.is_none_or(|p| {
            labels(p)
                && p.split('.').all(|x| {
                    !x.bytes().all(|b| b.is_ascii_digit()) || x == "0" || !x.starts_with('0')
                })
        })
        && build.is_none_or(labels)
}
fn identifiers(s: &str) -> Vec<&str> {
    s.split('.').collect()
}
pub fn compare(a: &str, b: &str) -> std::cmp::Ordering {
    use std::cmp::Ordering::*;
    let a = a.split('+').next().unwrap_or(a);
    let b = b.split('+').next().unwrap_or(b);
    let (av, ap) = a.split_once('-').map_or((a, None), |(x, y)| (x, Some(y)));
    let (bv, bp) = b.split_once('-').map_or((b, None), |(x, y)| (x, Some(y)));
    for (x, y) in av.split('.').zip(bv.split('.')) {
        let o = x
            .parse::<u64>()
            .unwrap_or(0)
            .cmp(&y.parse::<u64>().unwrap_or(0));
        if o != Equal {
            return o;
        }
    }
    match (ap, bp) {
        (None, None) => Equal,
        (None, Some(_)) => Greater,
        (Some(_), None) => Less,
        (Some(x), Some(y)) => {
            let xi = identifiers(x);
            let yi = identifiers(y);
            for (x, y) in xi.iter().zip(&yi) {
                let o = match (x.parse::<u64>(), y.parse::<u64>()) {
                    (Ok(a), Ok(b)) => a.cmp(&b),
                    (Ok(_), Err(_)) => Less,
                    (Err(_), Ok(_)) => Greater,
                    _ => x.cmp(y),
                };
                if o != Equal {
                    return o;
                }
            }
            xi.len().cmp(&yi.len())
        }
    }
}
/// Stable users see only stable releases; beta users see the highest version of
/// either channel (D-04: "highest version that carries the manifest").
pub fn channel_allows(user: Channel, manifest: Channel) -> bool {
    user == Channel::Beta || manifest == Channel::Stable
}
/// Whether this running build may take a manifest at all.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Compat {
    Ok,
    /// The running version is older than `rollbackFloor`: the new release may
    /// write state it cannot read back, so a failed launch could not be undone.
    /// Offer the download link instead of swapping in place.
    BelowFloor,
    /// The host OS is older than `minOs` (or its version cannot be determined).
    UnsupportedOs,
}
/// Dotted numeric version compare, `13.0` vs `13.0.1`; missing parts are zero.
pub fn os_at_least(host: &str, minimum: &str) -> bool {
    let parts = |v: &str| -> Option<Vec<u64>> { v.trim().split('.').map(|p| p.parse().ok()).collect() };
    let (Some(host), Some(minimum)) = (parts(host), parts(minimum)) else {
        return false;
    };
    for i in 0..host.len().max(minimum.len()) {
        let (a, b) = (host.get(i).copied().unwrap_or(0), minimum.get(i).copied().unwrap_or(0));
        if a != b {
            return a > b;
        }
    }
    true
}
pub fn compat(manifest: &Manifest, running: &str, host_os: Option<&str>) -> Compat {
    if let Some(minimum) = &manifest.min_os {
        if !host_os.is_some_and(|host| os_at_least(host, minimum)) {
            return Compat::UnsupportedOs;
        }
    }
    if compare(running, &manifest.rollback_floor).is_lt() {
        return Compat::BelowFloor;
    }
    Compat::Ok
}
/// The host OS version string `minOs` is compared against.
pub fn host_os_version() -> Option<String> {
    #[cfg(target_os = "macos")]
    {
        let out = std::process::Command::new("/usr/bin/sw_vers").arg("-productVersion").output().ok()?;
        return out.status.success().then(|| String::from_utf8_lossy(&out.stdout).trim().to_owned());
    }
    #[cfg(target_os = "windows")]
    {
        let out = std::process::Command::new("cmd").args(["/C", "ver"]).output().ok()?;
        let text = String::from_utf8_lossy(&out.stdout).into_owned();
        let start = text.find(|c: char| c.is_ascii_digit())?;
        let version: String = text[start..].chars().take_while(|c| c.is_ascii_digit() || *c == '.').collect();
        return (!version.is_empty()).then_some(version);
    }
    #[allow(unreachable_code)]
    None
}
pub fn select<'a>(
    manifests: &'a [Manifest],
    channel: Channel,
    target: &str,
    running: &str,
    blocked: &[String],
) -> Option<&'a Manifest> {
    manifests
        .iter()
        .filter(|m| {
            channel_allows(channel, m.channel)
                && m.target == target
                && compare(&m.version, running) == std::cmp::Ordering::Greater
                && !blocked.contains(&m.version)
        })
        .max_by(|a, b| compare(&a.version, &b.version))
}

#[cfg(test)]
#[path = "updater_manifest_tests.rs"]
mod tests;

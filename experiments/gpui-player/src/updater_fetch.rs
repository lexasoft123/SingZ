//! Signed feed lookup and bounded, streaming archive verification.
use crate::updater_manifest::{self, Channel, Manifest};
use anyhow::{Context, Result, bail, ensure};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    path::Path,
    time::Duration,
};

const LATEST_BASE: &str = "https://github.com/lexasoft123/SingZ/releases/latest/download";
const RELEASES_API: &str = "https://api.github.com/repos/lexasoft123/SingZ/releases?per_page=10";
/// Where a user is sent when this install cannot update itself.
pub const RELEASES_PAGE: &str = "https://github.com/lexasoft123/SingZ/releases";
const MANIFEST_LIMIT: u64 = 64 * 1024;

#[derive(Clone, Debug)]
pub struct Candidate {
    pub manifest: Manifest,
    pub archive_url: String,
    /// The exact signed bytes and detached signature, kept so the applier can
    /// verify them again at the apply boundary.
    pub raw_manifest: Vec<u8>,
    pub signature: Vec<u8>,
}
pub fn target() -> &'static str {
    if cfg!(target_os = "macos") {
        if cfg!(target_arch = "aarch64") {
            "macos-arm64"
        } else {
            "macos-x64"
        }
    } else if cfg!(target_os = "windows") {
        "windows-x64"
    } else {
        "linux-x64"
    }
}
fn asset(base: &str, name: &str) -> String {
    format!("{}/{}", base.trim_end_matches('/'), name)
}
fn manifest_name(target: &str) -> String {
    format!("singz-native-{target}.update.json")
}
/// Production policy: HTTPS only, no automatic redirects (each hop is checked
/// by `open_url`). A `test-hooks` build additionally admits loopback HTTP.
fn loopback_http_allowed() -> bool {
    cfg!(feature = "test-hooks")
}
fn agent(total: Duration) -> ureq::Agent {
    // The native TLS provider is the only one compiled in; leaving the default
    // (Rustls) would panic on the first HTTPS request.
    ureq::Agent::config_builder()
        .tls_config(
            ureq::tls::TlsConfig::builder()
                .provider(ureq::tls::TlsProvider::NativeTls)
                .root_certs(ureq::tls::RootCerts::PlatformVerifier)
                .build(),
        )
        .https_only(false) // checked per hop below so loopback tests stay possible
        .max_redirects(0)
        .http_status_as_error(false)
        .timeout_global(Some(total))
        .timeout_connect(Some(Duration::from_secs(15)))
        // Short enough that a stalled read cannot outlive a quit by much; an
        // interrupted download is recovered to `aborted` at the next start.
        .timeout_per_read(Some(Duration::from_secs(10)))
        .build()
        .into()
}
/// Is this URL acceptable under the transport policy?
pub fn url_allowed(url: &str, loopback_http: bool) -> bool {
    if url.starts_with("https://") {
        return true;
    }
    loopback_http
        && url
            .strip_prefix("http://")
            .is_some_and(|rest| rest.starts_with("127.0.0.1:") || rest.starts_with("localhost:") || rest.starts_with("[::1]:"))
}
fn open_url(url: &str, total: Duration, loopback_http: bool) -> Result<Box<dyn Read + Send + Sync>> {
    #[cfg(feature = "test-hooks")]
    if let Some(path) = url.strip_prefix("file://") {
        return Ok(Box::new(fs::File::open(path)?));
    }
    let agent = agent(total);
    let mut current = url.to_owned();
    for _ in 0..5 {
        ensure!(
            url_allowed(&current, loopback_http),
            "update transport must be HTTPS (refusing {current})"
        );
        let response = agent
            .get(&current)
            .header("User-Agent", "singz-native-updater")
            .call()
            .with_context(|| format!("fetch update asset {current}"))?;
        let status = response.status().as_u16();
        if (300..400).contains(&status) {
            let location = response
                .headers()
                .get("location")
                .and_then(|v| v.to_str().ok())
                .context("redirect without a location")?
                .to_owned();
            current = if location.starts_with('/') {
                let base = current.splitn(4, '/').take(3).collect::<Vec<_>>().join("/");
                format!("{base}{location}")
            } else {
                location
            };
            continue;
        }
        ensure!(status == 200, "fetch update asset {current}: http status: {status}");
        return Ok(Box::new(response.into_body().into_reader()));
    }
    bail!("too many redirects fetching {url}")
}
fn read_url(url: &str, limit: u64, loopback_http: bool) -> Result<Vec<u8>> {
    let mut bytes = Vec::new();
    open_url(url, Duration::from_secs(30), loopback_http)?
        .take(limit + 1)
        .read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64 <= limit, "update asset is too large");
    Ok(bytes)
}
/// Fetch a manifest and its detached signature, verify, and parse. Nothing in
/// an unverified manifest is read before the signature passes.
fn read_signed(url: &str, target: &str) -> Result<(Manifest, Vec<u8>, Vec<u8>)> {
    let loopback = loopback_http_allowed();
    let bytes = read_url(url, MANIFEST_LIMIT, loopback)?;
    let signature = read_url(&format!("{url}.sig"), 1024, loopback)?;
    updater_manifest::verify(&bytes, &signature, &updater_manifest::trusted_keys())?;
    let manifest = updater_manifest::parse(&bytes)?;
    ensure!(manifest.target == target, "update feed target mismatch");
    Ok((manifest, bytes, signature))
}
fn candidate(
    signed: (Manifest, Vec<u8>, Vec<u8>),
    base: &str,
    channel: Channel,
    running: &str,
    blocked: &[String],
) -> Option<Candidate> {
    let (manifest, raw_manifest, signature) = signed;
    let target = manifest.target.clone();
    let list = [manifest];
    updater_manifest::select(&list, channel, &target, running, blocked).map(|m| Candidate {
        archive_url: asset(base, &m.archive.name),
        manifest: m.clone(),
        raw_manifest,
        signature,
    })
}
/// `base` overrides the feed only in a `test-hooks` build (file:// or http://).
pub fn check(
    channel: Channel,
    running: &str,
    blocked: &[String],
    base: Option<&str>,
) -> Result<Option<Candidate>> {
    let target = target();
    #[cfg(not(feature = "test-hooks"))]
    let base: Option<&str> = {
        let _ = base;
        None
    };
    if let Some(base) = base {
        let manifest = read_signed(&asset(base, &manifest_name(target)), target)?;
        return Ok(candidate(manifest, base, channel, running, blocked));
    }
    if channel == Channel::Stable {
        // A 404 means "latest has no native build": up to date, not an error.
        let url = asset(LATEST_BASE, &manifest_name(target));
        return match read_signed(&url, target) {
            Ok(manifest) => Ok(candidate(manifest, LATEST_BASE, channel, running, blocked)),
            Err(error) if format!("{error:#}").contains("404") => Ok(None),
            Err(error) => Err(error),
        };
    }
    let releases: Vec<serde_json::Value> =
        serde_json::from_slice(&read_url(RELEASES_API, 1 << 20, false)?)?;
    let mut best: Option<Candidate> = None;
    let mut failure = None;
    for release in releases {
        let Some(url) = release["assets"].as_array().and_then(|assets| {
            assets
                .iter()
                .find(|a| a["name"] == manifest_name(target))
                .and_then(|a| a["browser_download_url"].as_str())
        }) else {
            continue;
        };
        match read_signed(url, target) {
            Ok(manifest) => {
                let base = url.rsplit_once('/').map_or("", |(a, _)| a);
                if let Some(found) = candidate(manifest, base, channel, running, blocked) {
                    if best.as_ref().is_none_or(|b| {
                        updater_manifest::compare(&found.manifest.version, &b.manifest.version)
                            .is_gt()
                    }) {
                        best = Some(found);
                    }
                }
            }
            Err(error) => failure = Some(error),
        }
    }
    match (best, failure) {
        (Some(found), _) => Ok(Some(found)),
        (None, Some(error)) => Err(error),
        (None, None) => Ok(None),
    }
}
/// Stream the archive to `destination`, enforcing the signed length and
/// SHA-256 while it is written.
pub fn download(
    candidate: &Candidate,
    destination: &Path,
    progress: &mut dyn FnMut(u64, u64) -> bool,
) -> Result<()> {
    download_with(candidate, destination, progress, loopback_http_allowed())
}
/// `progress(done, total)` runs before every chunk, may block, and returns
/// `false` to cancel (the host does when the app is quitting).
pub(crate) fn download_with(
    candidate: &Candidate,
    destination: &Path,
    progress: &mut dyn FnMut(u64, u64) -> bool,
    loopback_http: bool,
) -> Result<()> {
    let total = candidate.manifest.archive.bytes;
    let tmp = destination.with_extension("download");
    let result = (|| -> Result<()> {
        // Never write through anything left at this name: a fresh file only.
        match fs::remove_file(&tmp) {
            Err(error) if error.kind() != std::io::ErrorKind::NotFound => return Err(error.into()),
            _ => {}
        }
        let mut file = crate::updater_state::no_follow(fs::OpenOptions::new().write(true).create_new(true)).open(&tmp)?;
        let mut hash = Sha256::new();
        let mut bytes = 0u64;
        let mut source = open_url(&candidate.archive_url, Duration::from_secs(60 * 60), loopback_http)?;
        let mut buf = [0u8; 64 * 1024];
        loop {
            ensure!(progress(bytes, total), "update download cancelled");
            let n = source.read(&mut buf)?;
            if n == 0 {
                break;
            }
            bytes += n as u64;
            ensure!(bytes <= total, "update archive exceeds signed size");
            hash.update(&buf[..n]);
            file.write_all(&buf[..n])?;
        }
        file.sync_all()?;
        ensure!(bytes == total, "update archive length mismatch");
        let digest = hash
            .finalize()
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        ensure!(
            digest.eq_ignore_ascii_case(&candidate.manifest.archive.sha256),
            "update archive SHA-256 mismatch"
        );
        fs::rename(&tmp, destination)?;
        Ok(())
    })();
    if result.is_err() {
        let _ = fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
#[path = "updater_fetch_tests.rs"]
mod tests;

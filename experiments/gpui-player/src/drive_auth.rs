//! Native installed-app OAuth. This module never launches a browser or logs credentials.
use crate::drive_http::{self, Body, Destination, Request, Response};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    collections::HashMap,
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex, OnceLock, Weak,
        atomic::{AtomicBool, AtomicU64, AtomicUsize, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

#[derive(Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub client_id: String,
    #[serde(default)]
    pub client_secret: String,
    #[serde(default = "default_auth")]
    pub auth_base: String,
    #[serde(default = "default_api")]
    pub api_base: String,
    #[serde(default)]
    pub upload_base: String,
    #[serde(default)]
    pub token_url: String,
    #[serde(skip)]
    allow_loopback_http: bool,
}
fn default_auth() -> String {
    "https://accounts.google.com".into()
}
fn default_api() -> String {
    "https://www.googleapis.com".into()
}
impl Config {
    pub fn from_json(raw: &str) -> Result<Self> {
        ensure!(raw.len() <= 65536, "Drive configuration exceeds limit");
        let mut cfg: Self = serde_json::from_str(raw)
            .map_err(|_| anyhow::anyhow!("Invalid Drive configuration"))?;
        // Only explicit test builds accept a loopback HTTP fixture. Shipped
        // configurations always require HTTPS, including custom OAuth clients.
        cfg.allow_loopback_http = cfg!(any(test, feature = "ui-tests"));
        if cfg.auth_base.is_empty() {
            cfg.auth_base = default_auth();
        }
        if cfg.api_base.is_empty() {
            cfg.api_base = default_api();
        }
        if cfg.upload_base.is_empty() {
            cfg.upload_base = cfg.api_base.clone();
        }
        if cfg.token_url.is_empty() {
            cfg.token_url = if cfg.api_base != default_api() {
                format!("{}/token", cfg.api_base.trim_end_matches('/'))
            } else {
                "https://oauth2.googleapis.com/token".into()
            };
        }
        cfg.validate()?;
        Ok(cfg)
    }
    pub fn from_env_or(baked: &str) -> Result<Self> {
        Self::from_override_or(baked, gated_env!("SINGZ_GDRIVE_CONFIG").map(|s| s.into_string().map_err(std::env::VarError::NotUnicode)).unwrap_or(Err(std::env::VarError::NotPresent)))
    }
    fn from_override_or(
        baked: &str,
        override_config: std::result::Result<String, std::env::VarError>,
    ) -> Result<Self> {
        match override_config {
            Ok(raw) => Self::from_json(&raw),
            Err(std::env::VarError::NotPresent) => Self::from_json(baked),
            Err(_) => bail!("Invalid Drive configuration override"),
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            !self.client_id.trim().is_empty()
                && self.client_id.len() <= 4096
                && self.client_secret.len() <= 8192
                && !self.client_id.chars().any(char::is_control)
                && !self.client_secret.chars().any(char::is_control),
            "Drive OAuth client is not configured"
        );
        for endpoint in [
            &self.auth_base,
            &self.api_base,
            &self.upload_base,
            &self.token_url,
        ] {
            let u = drive_http::validate_url(endpoint, self.allow_loopback_http)?;
            ensure!(u.query().is_none(), "Invalid Drive endpoint");
        }
        Ok(())
    }
    pub fn allow_loopback_http(&self) -> bool {
        self.allow_loopback_http
    }
}
/// Public build provenance contains only fixed labels and a boolean. It is
/// independent of per-process overrides, sign-in state and account token files.
#[derive(Clone, Copy, Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BakedConfigMetadata {
    pub configured: bool,
    pub source: &'static str,
    pub status: &'static str,
}

pub fn baked_configured() -> bool {
    baked_metadata().configured
}

pub fn baked_metadata() -> BakedConfigMetadata {
    let metadata: serde_json::Value = serde_json::from_str(include_str!(concat!(
        env!("OUT_DIR"),
        "/drive-config-metadata.json"
    )))
    .unwrap_or(serde_json::Value::Null);
    let configured = metadata["configured"] == true
        && Config::from_json(include_str!(concat!(env!("OUT_DIR"), "/drive-config.json"))).is_ok();
    let source = match metadata["source"].as_str() {
        Some("canonical-json") => "canonical-json",
        Some("legacy-typescript") => "legacy-typescript",
        Some("none") => "none",
        _ => "unknown",
    };
    let status = match metadata["status"].as_str() {
        Some("configured") if configured => "configured",
        Some("missing") => "missing",
        Some("unreadable") => "unreadable",
        Some("malformed") => "malformed",
        _ => "invalid",
    };
    BakedConfigMetadata {
        configured,
        source,
        status,
    }
}

#[cfg(test)]
mod config_loading_tests {
    use super::*;
    #[test]
    fn override_precedence_is_preserved_without_mutating_process_environment() {
        let baked = serde_json::json!({"clientId":"baked-marker"}).to_string();
        let override_value = serde_json::json!({"clientId":"override-marker"}).to_string();
        let selected = Config::from_override_or(&baked, Ok(override_value)).unwrap();
        assert!(selected.client_id == "override-marker");
        let selected =
            Config::from_override_or(&baked, Err(std::env::VarError::NotPresent)).unwrap();
        assert!(selected.client_id == "baked-marker");
        assert!(Config::from_override_or(&baked, Ok(String::new())).is_err());
        assert!(Config::from_override_or(&baked, Ok("{malformed".into())).is_err());
    }
    #[test]
    fn baked_metadata_is_fixed_label_only_and_ignores_runtime_state() {
        let metadata = baked_metadata();
        let json = serde_json::to_value(metadata).unwrap();
        let object = json.as_object().unwrap();
        assert_eq!(object.len(), 3);
        assert!(
            object.contains_key("configured")
                && object.contains_key("source")
                && object.contains_key("status")
        );
        assert!(matches!(
            metadata.source,
            "canonical-json" | "legacy-typescript" | "none" | "unknown"
        ));
        assert!(matches!(
            metadata.status,
            "configured" | "missing" | "unreadable" | "malformed" | "invalid"
        ));
        assert_eq!(baked_configured(), metadata.configured);
        assert_eq!(
            metadata.configured,
            Config::from_json(include_str!(concat!(env!("OUT_DIR"), "/drive-config.json"))).is_ok()
        );
    }
}

#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Tokens {
    access: String,
    refresh: String,
    expires_at: u64,
}
#[derive(Clone, Serialize, Deserialize)]
struct State {
    generation: u64,
    tokens: Option<Tokens>,
}
// Count real auth filesystem/locking operations on the calling thread. The
// observer runs on another thread, so these hooks pin the cancellation path.
#[cfg(test)]
thread_local! {
    static AUTH_IO_COUNTS: std::cell::Cell<(u64, u64)> = const { std::cell::Cell::new((0, 0)) };
    static SLOW_SESSION_READ: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
    static AUTH_LEASE_WAIT: std::cell::Cell<Duration> = const { std::cell::Cell::new(Duration::ZERO) };
    static AUTH_PHASE_TIME: std::cell::Cell<[Duration; 2]> = const { std::cell::Cell::new([Duration::ZERO; 2]) };
}
#[cfg(test)]
struct AuthPhaseTiming(usize, Instant);
#[cfg(test)]
impl Drop for AuthPhaseTiming {
    fn drop(&mut self) {
        AUTH_PHASE_TIME.with(|time| {
            let mut next = time.get();
            next[self.0] += self.1.elapsed();
            time.set(next);
        });
    }
}
#[inline]
fn note_auth_fs() {
    #[cfg(test)]
    AUTH_IO_COUNTS.with(|count| {
        let (fs, locks) = count.get();
        count.set((fs + 1, locks));
        static DELAY: OnceLock<Duration> = OnceLock::new();
        let delay = DELAY.get_or_init(|| {
            Duration::from_millis(
                std::env::var("SINGZ_TEST_DRIVE_IO_MS")
                    .ok()
                    .and_then(|v| v.parse().ok())
                    .unwrap_or(0),
            )
        });
        if !delay.is_zero() {
            thread::sleep(*delay);
        }
    });
}
#[inline]
fn note_auth_lock() {
    #[cfg(test)]
    AUTH_IO_COUNTS.with(|count| {
        let (fs, locks) = count.get();
        count.set((fs, locks + 1));
    });
}

// The observation epoch is only a cancellation fence, never write permission.
// A stale sample requests leased verification; age alone cannot retire work.
// Normal sampling stays unleased so a real change is observed even while its
// writer still owns the lease. Writes always re-read under that lease.
const OBSERVATION_MAX_AGE: Duration = Duration::from_secs(2);
const OBSERVATION_INTERVAL: Duration = Duration::from_millis(200);
const REVERIFICATION_LEASE_WAIT: Duration = Duration::from_millis(50);

#[derive(Clone, Debug, PartialEq, Eq)]
struct SessionIdentity {
    length: u64,
    modified: Option<SystemTime>,
    created: Option<SystemTime>,
    file: (u64, u64),
    #[cfg(unix)]
    changed: (i64, i64),
    #[cfg(unix)]
    mode: u32,
}
fn session_metadata(meta: &fs::Metadata) -> Result<()> {
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 65536,
        "Unsafe Drive session file"
    );
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        ensure!(
            meta.permissions().mode() & 0o077 == 0,
            "Drive session file is not private"
        );
    }
    Ok(())
}
#[cfg(windows)]
fn session_file_id(file: &fs::File) -> Result<(u64, u64)> {
    use std::os::windows::io::AsRawHandle;
    #[repr(C)]
    struct Info {
        attributes: u32,
        created: [u32; 2],
        accessed: [u32; 2],
        written: [u32; 2],
        volume: u32,
        size_high: u32,
        size_low: u32,
        links: u32,
        index_high: u32,
        index_low: u32,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetFileInformationByHandle(handle: *mut std::ffi::c_void, info: *mut Info) -> i32;
    }
    let mut info: Info = unsafe { std::mem::zeroed() };
    note_auth_fs();
    ensure!(
        unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } != 0,
        "Unsafe Drive session file"
    );
    ensure!(
        info.attributes & (0x10 | 0x400) == 0,
        "Unsafe Drive session file"
    );
    Ok((
        info.volume as u64,
        ((info.index_high as u64) << 32) | info.index_low as u64,
    ))
}
fn session_open(path: &Path) -> Result<fs::File> {
    let mut options = fs::OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.custom_flags(libc::O_NOFOLLOW);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000); // FILE_FLAG_OPEN_REPARSE_POINT
    }
    note_auth_fs();
    Ok(options.open(path)?)
}
fn session_identity(meta: &fs::Metadata, _file: Option<&fs::File>) -> Result<SessionIdentity> {
    session_metadata(meta)?;
    #[cfg(unix)]
    let file = {
        use std::os::unix::fs::MetadataExt;
        (meta.dev(), meta.ino())
    };
    #[cfg(windows)]
    let file = session_file_id(_file.context("Unsafe Drive session file")?)?;
    #[cfg(not(any(unix, windows)))]
    let file = (0, 0);
    Ok(SessionIdentity {
        length: meta.len(),
        modified: meta.modified().ok(),
        created: meta.created().ok(),
        file,
        #[cfg(unix)]
        changed: {
            use std::os::unix::fs::MetadataExt;
            (meta.ctime(), meta.ctime_nsec())
        },
        #[cfg(unix)]
        mode: {
            use std::os::unix::fs::MetadataExt;
            meta.mode()
        },
    })
}
#[cfg(test)]
thread_local! {
    // Only the exercising thread injects the Windows metadata race. Parallel
    // fixtures and the background observer continue probing real metadata.
    static PROBE_MISMATCHES: std::cell::Cell<usize> = const { std::cell::Cell::new(0) };
}
#[cfg(any(windows, test))]
fn check_probe_metadata(matches: bool) -> Result<()> {
    if !matches {
        return Err(SessionProbeMismatch.into());
    }
    Ok(())
}
fn probe_session(path: &Path) -> Result<Option<SessionIdentity>> {
    note_auth_fs();
    let metadata = match fs::symlink_metadata(path) {
        Ok(meta) => meta,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error.into()),
    };
    session_metadata(&metadata)?;
    #[cfg(test)]
    PROBE_MISMATCHES.with(|remaining| {
        if remaining.get() != 0 {
            remaining.set(remaining.get() - 1);
            check_probe_metadata(false)?;
        }
        Ok::<(), anyhow::Error>(())
    })?;
    #[cfg(windows)]
    {
        let file = session_open(path)?;
        note_auth_fs();
        let opened = file.metadata()?;
        check_probe_metadata(
            metadata.len() == opened.len() && metadata.modified().ok() == opened.modified().ok(),
        )?;
        session_identity(&opened, Some(&file)).map(Some)
    }
    #[cfg(not(windows))]
    {
        session_identity(&metadata, None).map(Some)
    }
}
fn read_session(path: &Path, identity: Option<SessionIdentity>) -> Result<State> {
    #[cfg(test)]
    SLOW_SESSION_READ.with(|delay| {
        let delay = delay.replace(Duration::ZERO);
        if !delay.is_zero() {
            thread::sleep(delay);
        }
    });
    let Some(identity) = identity else {
        return Ok(State {
            generation: 0,
            tokens: None,
        });
    };
    let mut file = session_open(path)?;
    note_auth_fs();
    ensure!(
        session_identity(&file.metadata()?, Some(&file))? == identity,
        "Drive session changed on disk"
    );
    let mut bytes = Vec::new();
    note_auth_fs();
    (&mut file).take(65537).read_to_end(&mut bytes)?;
    ensure!(bytes.len() <= 65536, "Unsafe Drive session file");
    note_auth_fs();
    ensure!(
        session_identity(&file.metadata()?, Some(&file))? == identity
            && probe_session(path)?.as_ref() == Some(&identity),
        "Drive session changed on disk"
    );
    let state: State = serde_json::from_slice(&bytes)
        .map_err(|_| anyhow::anyhow!("Invalid saved Drive session"))?;
    if let Some(tokens) = &state.tokens {
        check_secret(&tokens.access)?;
        check_secret(&tokens.refresh)?;
    }
    Ok(state)
}
#[derive(Clone, PartialEq, Eq)]
struct SessionStamp {
    generation: u64,
    refresh: Option<[u8; 32]>,
}
impl SessionStamp {
    fn new(state: &State) -> Self {
        Self {
            generation: state.generation,
            refresh: state
                .tokens
                .as_ref()
                .map(|tokens| Sha256::digest(tokens.refresh.as_bytes()).into()),
        }
    }
}
struct ObservedFile {
    identity: Option<SessionIdentity>,
    session: SessionStamp,
}
struct ObservationCore {
    path: PathBuf,
    clock: Instant,
    epoch: AtomicU64,
    invalid: AtomicBool,
    checked_at: AtomicU64,
    // Once sampling has stalled, keep checking at the normal cadence until a
    // successful background sample proves the observer is running again.
    reverifying: AtomicBool,
    next_verification_at: AtomicU64,
    active: AtomicUsize,
    signing_out: AtomicUsize,
    revision: AtomicU64,
    stop: AtomicBool,
    parked: AtomicBool,
    thread: OnceLock<thread::Thread>,
    file: Mutex<ObservedFile>,
    #[cfg(test)]
    probes: AtomicU64,
    #[cfg(test)]
    pause: AtomicBool,
}
impl ObservationCore {
    fn now(&self) -> u64 {
        self.clock.elapsed().as_nanos().min(u64::MAX as u128) as u64
    }
    fn fence(&self) -> u64 {
        let generation =
            match self
                .epoch
                .fetch_update(Ordering::AcqRel, Ordering::Acquire, |value| {
                    value.checked_add(1)
                }) {
                Ok(value) => value + 1,
                Err(_) => {
                    self.invalid.store(true, Ordering::Release);
                    u64::MAX
                }
            };
        #[cfg(test)]
        if drive_http::test_profile_enabled() {
            eprintln!(
                "DRIVE_EPOCH generation={generation} invalid={} signing_out={}",
                self.invalid.load(Ordering::Acquire),
                self.signing_out.load(Ordering::Acquire)
            );
        }
        drive_http::wake_cancelled_requests();
        generation
    }
    fn invalidate(&self) {
        if !self.invalid.swap(true, Ordering::AcqRel) {
            self.fence();
        }
    }
    fn generation(&self) -> u64 {
        if self.signing_out.load(Ordering::Acquire) != 0 {
            return u64::MAX;
        }
        if self.invalid.load(Ordering::Acquire) {
            return u64::MAX;
        }
        self.epoch.load(Ordering::Acquire)
    }
    fn claim_verification(&self) -> bool {
        if self.active.load(Ordering::Acquire) == 0 {
            return false;
        }
        let now = self.now();
        if now.saturating_sub(self.checked_at.load(Ordering::Acquire))
            >= OBSERVATION_MAX_AGE.as_nanos() as u64
        {
            self.reverifying.store(true, Ordering::Release);
        }
        // Never recursively acquire a lease from an authoritative operation.
        if !self.reverifying.load(Ordering::Acquire)
            || self.revision.load(Ordering::Acquire) & 1 != 0
            // A normal authoritative read also verified the persisted stamp.
            // Do not immediately repeat that I/O from a cancellation callback,
            // even if the observer has not yet cleared fallback mode.
            || now.saturating_sub(self.checked_at.load(Ordering::Acquire))
                < OBSERVATION_INTERVAL.as_nanos() as u64
        {
            return false;
        }
        let next = self.next_verification_at.load(Ordering::Acquire);
        now >= next
            && self
                .next_verification_at
                .compare_exchange(
                    next,
                    now.saturating_add(OBSERVATION_INTERVAL.as_nanos() as u64),
                    Ordering::AcqRel,
                    Ordering::Acquire,
                )
                .is_ok()
    }
    fn publish(
        &self,
        file: &mut ObservedFile,
        state: &State,
        identity: Option<SessionIdentity>,
        checked_at: u64,
        fenced: bool,
    ) -> Result<()> {
        if state.generation < file.session.generation {
            self.invalidate(); // A verified rollback is a real change.
        }
        ensure!(
            state.generation >= file.session.generation,
            "Drive session changed on disk"
        );
        let session = SessionStamp::new(state);
        if file.session != session && !fenced {
            self.fence();
        }
        *file = ObservedFile { identity, session };
        // Publish the freshness timestamp before removing the fail-closed flag.
        self.checked_at.store(checked_at, Ordering::Release);
        self.invalid.store(false, Ordering::Release);
        Ok(())
    }
    fn publish_authoritative(
        &self,
        state: &State,
        identity: Option<SessionIdentity>,
        checked_at: u64,
        fenced: bool,
    ) -> Result<()> {
        note_auth_lock();
        let mut file = self
            .file
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive session state unavailable"))?;
        self.publish(&mut file, state, identity, checked_at, fenced)
    }
    fn unpark(&self) {
        if let Some(thread) = self.thread.get() {
            thread.unpark();
        }
    }
    fn refresh(&self) {
        let revision = self.revision.load(Ordering::Acquire);
        if revision & 1 != 0 {
            return;
        }
        #[cfg(test)]
        if self.pause.load(Ordering::Acquire) {
            return;
        }
        // A resumed observer must also verify a stale snapshot under the lease;
        // a metadata-only sample must not hide a missed verification deadline.
        let verify = self
            .now()
            .saturating_sub(self.checked_at.load(Ordering::Acquire))
            >= OBSERVATION_MAX_AGE.as_nanos() as u64;
        if verify && !self.claim_verification() {
            return;
        }
        let result = (|| -> Result<()> {
            let _lease = if verify {
                Some(session_lease(
                    &self.path,
                    Instant::now() + REVERIFICATION_LEASE_WAIT,
                )?)
            } else {
                None
            };
            note_auth_lock();
            let previous = self
                .file
                .lock()
                .map_err(|_| anyhow::anyhow!("Drive session state unavailable"))?
                .identity
                .clone();
            #[cfg(test)]
            self.probes.fetch_add(1, Ordering::Relaxed);
            let sample = (|| -> Result<_> {
                let identity = probe_session(&self.path)?;
                let state = if verify || identity != previous {
                    Some(read_session(&self.path, identity.clone())?)
                } else {
                    None
                };
                Ok((identity, state))
            })();
            let (identity, state) = match sample {
                Err(error) if error.is::<SessionProbeMismatch>() => {
                    // A racing path/handle metadata pair is inconclusive. On
                    // this observer thread, retry once with the lease, and
                    // compare the persisted stamp even if metadata now agrees.
                    let _retry_lease = if verify {
                        None // The stale observation already holds the lease.
                    } else {
                        Some(session_lease(
                            &self.path,
                            Instant::now() + REVERIFICATION_LEASE_WAIT,
                        )?)
                    };
                    let identity = probe_session(&self.path)?;
                    let state = read_session(&self.path, identity.clone())?;
                    (identity, Some(state))
                }
                result => result?,
            };
            note_auth_lock();
            let mut file = self
                .file
                .lock()
                .map_err(|_| anyhow::anyhow!("Drive session state unavailable"))?;
            // A leased read/write raced this unleased observation. Its snapshot
            // wins; never restore an older generation or stale identity.
            if self.revision.load(Ordering::Acquire) != revision {
                return Ok(());
            }
            let checked_at = self.now();
            if let Some(state) = state {
                self.publish(&mut file, &state, identity, checked_at, false)?;
            } else {
                self.checked_at.store(checked_at, Ordering::Release);
                self.invalid.store(false, Ordering::Release);
            }
            Ok(())
        })();
        if self.revision.load(Ordering::Acquire) == revision {
            match result {
                Ok(()) => self.reverifying.store(false, Ordering::Release),
                Err(error) if !verification_pending(&error) => self.invalidate(),
                Err(_) => {}
            }
        }
        // An I/O failure or inconclusive metadata pair is not evidence of a
        // changed session. Leave checked_at alone until verification succeeds.
    }
    fn run(&self) {
        let mut attempted_at = 0;
        while !self.stop.load(Ordering::Acquire) {
            if self.active.load(Ordering::Acquire) == 0 {
                self.parked.store(true, Ordering::Release);
                if self.active.load(Ordering::Acquire) == 0 && !self.stop.load(Ordering::Acquire) {
                    thread::park(); // No timer, filesystem access, or idle loop.
                }
                self.parked.store(false, Ordering::Release);
                continue;
            }
            self.parked.store(false, Ordering::Release);
            // A caller's successful fallback must not keep pushing sampling's
            // wakeup forward. Let the resumed worker clear the fallback mode.
            let latest = if self.reverifying.load(Ordering::Acquire) {
                attempted_at
            } else {
                self.checked_at.load(Ordering::Acquire).max(attempted_at)
            };
            let due = latest.saturating_add(OBSERVATION_INTERVAL.as_nanos() as u64);
            let now = self.now();
            if due > now {
                thread::park_timeout(Duration::from_nanos(due - now));
                continue;
            }
            attempted_at = now;
            self.refresh();
        }
    }
}
struct SessionObserver {
    core: Arc<ObservationCore>,
    worker: Mutex<Option<thread::JoinHandle<()>>>,
    authoritative: Mutex<()>,
}
impl SessionObserver {
    fn shared(path: &Path, state: &State, identity: Option<SessionIdentity>) -> Result<Arc<Self>> {
        static REGISTRY: OnceLock<Mutex<HashMap<PathBuf, Weak<SessionObserver>>>> = OnceLock::new();
        note_auth_lock();
        let mut registry = REGISTRY
            .get_or_init(|| Mutex::new(HashMap::new()))
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive session state unavailable"))?;
        registry.retain(|_, value| value.strong_count() != 0);
        if let Some(observer) = registry.get(path).and_then(Weak::upgrade) {
            return Ok(observer);
        }
        let observer = Arc::new(Self {
            core: Arc::new(ObservationCore {
                path: path.to_owned(),
                clock: Instant::now(),
                epoch: AtomicU64::new(state.generation),
                invalid: AtomicBool::new(false),
                checked_at: AtomicU64::new(0),
                reverifying: AtomicBool::new(false),
                next_verification_at: AtomicU64::new(0),
                active: AtomicUsize::new(0),
                signing_out: AtomicUsize::new(0),
                revision: AtomicU64::new(0),
                stop: AtomicBool::new(false),
                parked: AtomicBool::new(true),
                thread: OnceLock::new(),
                file: Mutex::new(ObservedFile {
                    identity,
                    session: SessionStamp::new(state),
                }),
                #[cfg(test)]
                probes: AtomicU64::new(0),
                #[cfg(test)]
                pause: AtomicBool::new(false),
            }),
            worker: Mutex::new(None),
            authoritative: Mutex::new(()),
        });
        registry.insert(path.to_owned(), Arc::downgrade(&observer));
        Ok(observer)
    }
    fn start(self: &Arc<Self>) -> Result<GenerationObservation> {
        #[cfg(test)]
        let _timing =
            drive_http::test_profile_enabled().then(|| AuthPhaseTiming(1, Instant::now()));
        note_auth_lock();
        let mut worker = self
            .worker
            .lock()
            .map_err(|_| anyhow::anyhow!("Drive session state unavailable"))?;
        if worker.is_none() {
            let core = self.core.clone();
            let handle = thread::Builder::new()
                .name("drive-session-observer".into())
                .spawn(move || core.run())
                .context("Drive session state unavailable")?;
            let _ = self.core.thread.set(handle.thread().clone());
            *worker = Some(handle);
        }
        self.core.active.fetch_add(1, Ordering::AcqRel);
        self.core.unpark();
        Ok(GenerationObservation(self.clone()))
    }
}
impl Drop for SessionObserver {
    fn drop(&mut self) {
        self.core.stop.store(true, Ordering::Release);
        self.core.unpark();
        if let Some(worker) = self
            .worker
            .get_mut()
            .unwrap_or_else(|e| e.into_inner())
            .take()
        {
            let _ = worker.join();
        }
    }
}
struct GenerationObservation(Arc<SessionObserver>);
impl Drop for GenerationObservation {
    fn drop(&mut self) {
        if self.0.core.active.fetch_sub(1, Ordering::AcqRel) == 1 {
            self.0.core.unpark();
        }
    }
}
// Keep new observations invalid until a pending sign-out has cleared disk.
// Otherwise a request could capture the early fence while old tokens remain.
struct PendingSignout<'a>(&'a ObservationCore);
impl Drop for PendingSignout<'_> {
    fn drop(&mut self) {
        self.0.signing_out.fetch_sub(1, Ordering::AcqRel);
    }
}
struct AuthoritativeRevision<'a>(&'a ObservationCore);
impl Drop for AuthoritativeRevision<'_> {
    fn drop(&mut self) {
        self.0.revision.fetch_add(1, Ordering::Release);
    }
}

#[derive(Debug)]
struct SessionBusy;
impl std::fmt::Display for SessionBusy {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("Drive session is busy; retry shortly")
    }
}
impl std::error::Error for SessionBusy {}

// Only the Windows path/handle size/mtime comparison uses this pending error;
// the other session identity, safety and rollback checks remain hard fences.
#[derive(Debug)]
struct SessionProbeMismatch;
impl std::fmt::Display for SessionProbeMismatch {
    fn fmt(&self, out: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        out.write_str("Drive session changed on disk")
    }
}
impl std::error::Error for SessionProbeMismatch {}

fn verification_pending(error: &anyhow::Error) -> bool {
    error.is::<SessionBusy>() || error.is::<SessionProbeMismatch>() || error.is::<std::io::Error>()
}

// The caller must hold the session lease throughout both attempts. In
// particular, retry a mismatch in read_session's final probe as a whole read,
// rather than authorizing a write using bytes from an inconclusive snapshot.
fn retry_probe_under_lease<T>(mut read: impl FnMut() -> Result<T>) -> Result<T> {
    match read() {
        Err(error) if error.is::<SessionProbeMismatch>() => read(),
        result => result,
    }
}

fn session_mutex<T>(mutex: &Mutex<T>, deadline: Instant) -> Result<std::sync::MutexGuard<'_, T>> {
    loop {
        note_auth_lock();
        match mutex.try_lock() {
            Ok(state) => return Ok(state),
            Err(std::sync::TryLockError::WouldBlock) => {
                if Instant::now() >= deadline {
                    return Err(SessionBusy.into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(std::sync::TryLockError::Poisoned(_)) => {
                bail!("Drive session state unavailable")
            }
        }
    }
}

fn session_lease(path: &Path, deadline: Instant) -> Result<crate::file_lease::Lease> {
    #[cfg(test)]
    let began = Instant::now();
    let lock_path = path.with_extension("lock");
    note_auth_fs();
    if let Ok(meta) = fs::symlink_metadata(&lock_path) {
        ensure!(
            meta.is_file() && !meta.file_type().is_symlink(),
            "Unsafe Drive session lock"
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            ensure!(
                meta.permissions().mode() & 0o077 == 0,
                "Drive session lock is not private"
            );
        }
    }
    let mut options = fs::OpenOptions::new();
    options.read(true).write(true).create(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    note_auth_fs();
    let file = options
        .open(lock_path)
        .context("Could not open Drive session lock")?;
    loop {
        note_auth_lock();
        note_auth_fs();
        match crate::file_lease::Lease::acquire(file.try_clone()?) {
            Ok(lease) => {
                #[cfg(test)]
                AUTH_LEASE_WAIT.with(|time| time.set(time.get() + began.elapsed()));
                return Ok(lease);
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                if Instant::now() >= deadline {
                    return Err(SessionBusy.into());
                }
                thread::sleep(Duration::from_millis(10));
            }
            Err(error) => return Err(error).context("Could not lock Drive session"),
        }
    }
}

struct Store {
    path: PathBuf,
    state: Mutex<State>,
    observer: Arc<SessionObserver>,
    #[cfg(test)]
    lock_timeout: Duration,
}
struct Locked<'a> {
    state: std::sync::MutexGuard<'a, State>,
    _revision: AuthoritativeRevision<'a>,
    _authoritative: std::sync::MutexGuard<'a, ()>,
    _lease: crate::file_lease::Lease,
}
impl std::ops::Deref for Locked<'_> {
    type Target = State;
    fn deref(&self) -> &State {
        &self.state
    }
}
impl std::ops::DerefMut for Locked<'_> {
    fn deref_mut(&mut self) -> &mut State {
        &mut self.state
    }
}
#[derive(Clone)]
pub struct TokenStore(Arc<Store>);

/// A refresh request itself retired this exact persisted session generation.
/// Explicit sign-out and another account's replacement never create this error.
#[derive(Debug)]
pub struct SessionExpired {
    cleared_generation: u64,
}
impl SessionExpired {
    pub fn cleared_generation(&self) -> u64 {
        self.cleared_generation
    }
}
impl std::fmt::Display for SessionExpired {
    fn fmt(&self, formatter: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        formatter.write_str("Google Drive session expired; sign in again")
    }
}
impl std::error::Error for SessionExpired {}
pub fn session_expired_generation(error: &anyhow::Error) -> Option<u64> {
    error
        .downcast_ref::<SessionExpired>()
        .map(SessionExpired::cleared_generation)
}
fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_millis()
        .min(u64::MAX as u128) as u64
}
fn check_secret(value: &str) -> Result<()> {
    ensure!(
        !value.is_empty() && value.len() <= 16384 && value.bytes().all(|b| b.is_ascii_graphic()),
        "Drive returned invalid session credentials"
    );
    Ok(())
}
impl TokenStore {
    /// Explicit application config directory; nothing reads Electron settings.
    pub fn new(config_dir: &Path) -> Result<Self> {
        let dir = config_dir.join("gdrive");
        if let Ok(meta) = fs::symlink_metadata(&dir) {
            ensure!(
                meta.is_dir() && !meta.file_type().is_symlink(),
                "Unsafe Drive session directory"
            );
        } else {
            fs::create_dir_all(&dir)?;
        }
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            fs::set_permissions(&dir, fs::Permissions::from_mode(0o700))?;
        }
        let path = dir.canonicalize()?.join("session.json");
        let identity = probe_session(&path)?;
        let state = read_session(&path, identity.clone())?;
        let observer = SessionObserver::shared(&path, &state, identity)?;
        Ok(Self(Arc::new(Store {
            path,
            state: Mutex::new(state),
            observer,
            #[cfg(test)]
            lock_timeout: Duration::from_secs(2),
        })))
    }
    fn lock(&self) -> Result<Locked<'_>> {
        #[cfg(not(test))]
        let timeout = Duration::from_secs(2);
        #[cfg(test)]
        let timeout = self.0.lock_timeout;
        let result = self.lock_inner(timeout);
        if result
            .as_ref()
            .is_err_and(|error| !verification_pending(error))
        {
            self.0.observer.core.invalidate();
        }
        result
    }
    fn lock_inner(&self, timeout: Duration) -> Result<Locked<'_>> {
        #[cfg(test)]
        let _timing =
            drive_http::test_profile_enabled().then(|| AuthPhaseTiming(0, Instant::now()));
        let deadline = Instant::now() + timeout;
        let mut state = session_mutex(&self.0.state, deadline)?;
        let lease = session_lease(&self.0.path, deadline)?;
        // Serialize authoritative readers/writers in this process through the
        // shared observer as well as the file lease (separate TokenStore values
        // may name the same file). The sampling thread never holds this gate
        // during I/O.
        let authoritative = session_mutex(&self.0.observer.authoritative, deadline)?;
        self.0.observer.core.revision.fetch_add(1, Ordering::AcqRel);
        let revision = AuthoritativeRevision(&self.0.observer.core);
        let (identity, disk) = retry_probe_under_lease(|| {
            let identity = probe_session(&self.0.path)?;
            let disk = read_session(&self.0.path, identity.clone())?;
            Ok((identity, disk))
        })?;
        if disk.generation < state.generation {
            self.0.observer.core.invalidate();
        }
        ensure!(
            disk.generation >= state.generation,
            "Drive session changed on disk"
        );
        if let Some(tokens) = &disk.tokens {
            check_secret(&tokens.access)?;
            check_secret(&tokens.refresh)?;
        }
        let mut observed = session_mutex(&self.0.observer.core.file, deadline)?;
        let checked_at = self.0.observer.core.now();
        self.0
            .observer
            .core
            .publish(&mut observed, &disk, identity, checked_at, false)?;
        drop(observed);
        *state = disk;
        Ok(Locked {
            state,
            _lease: lease,
            _revision: revision,
            _authoritative: authoritative,
        })
    }
    fn persist(&self, state: &State) -> Result<()> {
        let parent = self
            .0
            .path
            .parent()
            .context("Drive session directory missing")?;
        let tmp = parent.join(format!(".session-{}", drive_http::random_id()?));
        let result = (|| -> Result<()> {
            let mut file = drive_http::private_file(&tmp)?;
            file.write_all(&serde_json::to_vec(state)?)?;
            file.sync_all()?;
            drop(file);
            // Windows rename cannot replace an existing destination. The old
            // token file is removed while holding the generation mutex.
            #[cfg(windows)]
            if self.0.path.exists() {
                fs::remove_file(&self.0.path)?;
            }
            fs::rename(&tmp, &self.0.path)?;
            #[cfg(unix)]
            fs::File::open(parent)?.sync_all()?;
            Ok(())
        })();
        if result.is_err() {
            let _ = fs::remove_file(tmp);
        }
        result
    }
    /// Cancellation epoch, not permission to commit a write. Call on a Drive
    /// request/service worker: after a stalled sample, one caller per 200 ms
    /// re-reads the bounded session file with at most a 50 ms mutex/lease wait.
    /// Steady checks remain atomic-only. An unavailable verification returns the last
    /// epoch (not verified yet); check_generation still requires a leased read.
    /// Between requests this is cached until observe() refreshes the session.
    pub fn generation(&self) -> u64 {
        let core = &self.0.observer.core;
        if core.generation() != u64::MAX && core.claim_verification() {
            // Busy leases and I/O failures leave verification pending. A
            // completed read still publishes/fences a real or unsafe change.
            if let Err(error) = self.lock_inner(REVERIFICATION_LEASE_WAIT) {
                if !verification_pending(&error) {
                    core.invalidate();
                }
            }
        }
        core.generation()
    }
    /// Persistent compare-and-write version, for receipts and durable records.
    /// This authoritative leased read is deliberately separate from cancellation.
    pub fn persisted_generation(&self) -> Result<u64> {
        Ok(self.lock()?.generation)
    }
    fn observe(&self) -> Result<GenerationObservation> {
        drop(self.lock()?);
        self.0.observer.start()
    }
    fn check_generation(&self, expected: u64) -> Result<()> {
        let _state = self.lock()?;
        ensure!(
            expected != u64::MAX && self.generation() == expected,
            "Drive session changed"
        );
        Ok(())
    }
    fn publish_write(&self, state: &State, fenced: bool) -> Result<()> {
        let identity = probe_session(&self.0.path)?;
        let checked_at = self.0.observer.core.now();
        self.0
            .observer
            .core
            .publish_authoritative(state, identity, checked_at, fenced)
    }
    pub fn signed_in(&self) -> bool {
        self.signed_in_checked().unwrap_or(false)
    }
    pub fn signed_in_checked(&self) -> Result<bool> {
        Ok(self.lock()?.tokens.is_some())
    }
    fn advance(&self, clear: bool) -> Result<(u64, u64)> {
        // A user's sign-out retires active transfers before waiting for either
        // mutex or a lease held by another instance. Failures retain that fence.
        let pending_signout = clear.then(|| {
            self.0
                .observer
                .core
                .signing_out
                .fetch_add(1, Ordering::AcqRel);
            PendingSignout(&self.0.observer.core)
        });
        let early_fence = pending_signout
            .as_ref()
            .map(|_| self.0.observer.core.fence());
        let mut state = match self.lock() {
            Ok(state) => state,
            Err(error) => {
                // A failed sign-out is an explicit cancellation intent, unlike
                // a plain read timing out on another writer's lease.
                if clear {
                    self.0.observer.core.invalidate();
                }
                return Err(error);
            }
        };
        let observed_generation = early_fence.unwrap_or_else(|| self.0.observer.core.fence());
        let mut next = state.clone();
        next.generation = next
            .generation
            .checked_add(1)
            .context("Drive session generation exhausted")?;
        if clear {
            next.tokens = None;
            *state = next.clone();
        }
        let result = self
            .persist(&next)
            .and_then(|_| self.publish_write(&next, true));
        if result.is_err() {
            self.0.observer.core.invalidate();
        }
        result?;
        *state = next;
        Ok((state.generation, observed_generation))
    }
    pub fn sign_out(&self) -> Result<()> {
        self.advance(true).map(|_| ())
    }
    #[cfg(test)]
    fn adopt(&self, generation: u64, tokens: Tokens) -> Result<()> {
        self.adopt_observed(generation, self.generation(), tokens)
    }
    fn adopt_observed(
        &self,
        generation: u64,
        observed_generation: u64,
        tokens: Tokens,
    ) -> Result<()> {
        let mut state = self.lock()?;
        ensure!(
            state.generation == generation
                && observed_generation != u64::MAX
                && self.generation() == observed_generation,
            "Drive session changed"
        );
        let replacement = state
            .tokens
            .as_ref()
            .is_some_and(|old| old.refresh != tokens.refresh);
        let next = State {
            generation: if replacement {
                generation
                    .checked_add(1)
                    .context("Drive session generation exhausted")?
            } else {
                generation
            },
            tokens: Some(tokens),
        };
        if replacement {
            self.0.observer.core.fence();
        }
        let result = self
            .persist(&next)
            .and_then(|_| self.publish_write(&next, true));
        if result.is_err() {
            self.0.observer.core.invalidate();
        }
        result?;
        *state = next;
        Ok(())
    }
    #[cfg(test)]
    fn clear_if(&self, generation: u64) -> Result<Option<u64>> {
        self.clear_if_observed(generation, self.generation())
    }
    fn clear_if_observed(&self, generation: u64, observed_generation: u64) -> Result<Option<u64>> {
        let mut state = self.lock()?;
        if state.generation == generation
            && state.tokens.is_some()
            && observed_generation != u64::MAX
            && self.generation() == observed_generation
        {
            state.tokens = None;
            state.generation = state
                .generation
                .checked_add(1)
                .context("Drive session generation exhausted")?;
            self.0.observer.core.fence();
            let result = self
                .persist(&state)
                .and_then(|_| self.publish_write(&state, true));
            if result.is_err() {
                self.0.observer.core.invalidate();
            }
            result?;
            return Ok(Some(state.generation));
        }
        Ok(None)
    }
    /// Inspect one fresh leased snapshot; a later host Cancel still needs its
    /// independent epoch fence before publishing this account error.
    pub fn current_expired_generation(&self, error: &anyhow::Error) -> Result<Option<u64>> {
        let Some(generation) = session_expired_generation(error) else {
            return Ok(None);
        };
        let state = self.lock()?;
        Ok((state.generation == generation && state.tokens.is_none()).then_some(generation))
    }
    #[cfg(test)]
    fn expired(&self, generation: u64) -> anyhow::Error {
        self.expired_observed(generation, self.generation())
    }
    fn expired_observed(&self, generation: u64, observed_generation: u64) -> anyhow::Error {
        match self.clear_if_observed(generation, observed_generation) {
            Ok(Some(cleared_generation)) => SessionExpired { cleared_generation }.into(),
            Ok(None) => anyhow::anyhow!("Drive session changed"),
            Err(error) => error,
        }
    }
    pub fn access_token(
        &self,
        cfg: &Config,
        renew: bool,
        cancel: &impl Fn() -> bool,
    ) -> Result<String> {
        let (generation, observed_generation, tokens) = {
            let state = self.lock()?;
            (
                state.generation,
                self.generation(),
                state
                    .tokens
                    .clone()
                    .context("Not signed in to Google Drive")?,
            )
        };
        ensure!(
            observed_generation != u64::MAX && !cancel(),
            "Drive request cancelled"
        );
        if !renew && now_ms() < tokens.expires_at {
            return Ok(tokens.access);
        }
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("refresh_token", &tokens.refresh)
            .append_pair("client_id", &cfg.client_id)
            .append_pair("client_secret", &cfg.client_secret)
            .append_pair("grant_type", "refresh_token");
        let body = form.finish();
        let _observation = self.0.observer.start()?;
        let cancelled = || cancel() || self.generation() != observed_generation;
        let response = drive_http::request(
            Request {
                method: "POST",
                url: &cfg.token_url,
                headers: &[("Content-Type", "application/x-www-form-urlencoded")],
                body: Body::Bytes(body.as_bytes()),
                destination: Destination::Bytes(65536),
                upload: false,
                allow_loopback_http: cfg.allow_loopback_http,
            },
            &cancelled,
        )?;
        ensure!(!cancelled(), "Drive session changed");
        if response.status == 400 || response.status == 401 {
            return Err(self.expired_observed(generation, observed_generation));
        }
        ensure!(
            (200..300).contains(&response.status),
            "Drive session renewal failed (HTTP {})",
            response.status
        );
        let json = response.json()?;
        let Some(access) = json["access_token"].as_str() else {
            return Err(self.expired_observed(generation, observed_generation));
        };
        check_secret(access)?;
        let updated = Tokens {
            access: access.into(),
            refresh: tokens.refresh,
            expires_at: expires_at(&json),
        };
        self.adopt_observed(generation, observed_generation, updated.clone())?;
        Ok(updated.access)
    }
}
fn expires_at(json: &serde_json::Value) -> u64 {
    now_ms()
        .saturating_add(json["expires_in"].as_u64().unwrap_or(3600).min(86400) * 1000)
        .saturating_sub(60000)
}

pub struct OAuthSession {
    config: Config,
    store: TokenStore,
    generation: u64,
    observed_generation: u64,
    listener: TcpListener,
    url: String,
    redirect: String,
    state: String,
    verifier: String,
    deadline: Instant,
}
impl OAuthSession {
    /// Call on a worker. Pass authorization_url() to the host's browser opener.
    pub fn start(config: Config, store: TokenStore) -> Result<Self> {
        config.validate()?;
        let listener = TcpListener::bind((std::net::Ipv4Addr::LOCALHOST, 0))
            .context("Could not open Google sign-in callback")?;
        listener.set_nonblocking(true)?;
        let redirect = format!(
            "http://127.0.0.1:{}/oauth2/callback",
            listener.local_addr()?.port()
        );
        let state = drive_http::random_id()?;
        let mut verifier_bytes = [0u8; 32];
        getrandom::fill(&mut verifier_bytes)
            .map_err(|_| anyhow::anyhow!("Secure random source unavailable"))?;
        let verifier = URL_SAFE_NO_PAD.encode(verifier_bytes);
        let challenge = URL_SAFE_NO_PAD.encode(Sha256::digest(verifier.as_bytes()));
        let mut url = url::Url::parse(&format!(
            "{}/o/oauth2/v2/auth",
            config.auth_base.trim_end_matches('/')
        ))?;
        url.query_pairs_mut()
            .append_pair("client_id", &config.client_id)
            .append_pair("redirect_uri", &redirect)
            .append_pair("response_type", "code")
            .append_pair("scope", "https://www.googleapis.com/auth/drive.file")
            .append_pair("access_type", "offline")
            .append_pair("prompt", "consent")
            .append_pair("state", &state)
            .append_pair("code_challenge", &challenge)
            .append_pair("code_challenge_method", "S256");
        let (generation, observed_generation) = store.advance(false)?;
        Ok(Self {
            config,
            store,
            generation,
            observed_generation,
            listener,
            url: url.to_string(),
            redirect,
            state,
            verifier,
            deadline: Instant::now() + Duration::from_secs(300),
        })
    }
    pub fn authorization_url(&self) -> &str {
        &self.url
    }
    /// Bounded blocking callback + exchange; cancellation/sign-out reaps the
    /// HTTP child and prevents late exchange success from restoring tokens.
    pub fn finish(self, cancel: &impl Fn() -> bool) -> Result<()> {
        let _observation = self.store.observe()?;
        let cancelled = || cancel() || self.store.generation() != self.observed_generation;
        let code = loop {
            ensure!(!cancelled(), "Google sign-in cancelled");
            ensure!(Instant::now() < self.deadline, "Google sign-in timed out");
            match self.listener.accept() {
                Ok((mut stream, peer)) => {
                    if !peer.ip().is_loopback() {
                        continue;
                    }
                    match self.callback(&mut stream, &cancelled) {
                        Ok(Some(code)) => break code,
                        Ok(None) => bail!("Google sign-in was cancelled"),
                        Err(_) => {
                            let _ = reply(
                                &mut stream,
                                400,
                                &crate::i18n::t("drive.auth.callbackInvalid"),
                            );
                        }
                    }
                }
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    thread::sleep(Duration::from_millis(10))
                }
                Err(_) => bail!("Google sign-in callback failed"),
            }
        };
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("code", &code)
            .append_pair("client_id", &self.config.client_id)
            .append_pair("client_secret", &self.config.client_secret)
            .append_pair("redirect_uri", &self.redirect)
            .append_pair("code_verifier", &self.verifier)
            .append_pair("grant_type", "authorization_code");
        let body = form.finish();
        let response = drive_http::request(
            Request {
                method: "POST",
                url: &self.config.token_url,
                headers: &[("Content-Type", "application/x-www-form-urlencoded")],
                body: Body::Bytes(body.as_bytes()),
                destination: Destination::Bytes(65536),
                upload: false,
                allow_loopback_http: self.config.allow_loopback_http,
            },
            &cancelled,
        )?;
        ensure!(!cancelled(), "Google sign-in cancelled");
        ensure!(
            (200..300).contains(&response.status),
            "Google sign-in token exchange failed (HTTP {})",
            response.status
        );
        let json = response.json()?;
        let access = json["access_token"]
            .as_str()
            .context("Google sign-in did not return session credentials")?;
        let refresh = json["refresh_token"]
            .as_str()
            .context("Google sign-in did not return offline session credentials")?;
        check_secret(access)?;
        check_secret(refresh)?;
        self.store.adopt_observed(
            self.generation,
            self.observed_generation,
            Tokens {
                access: access.into(),
                refresh: refresh.into(),
                expires_at: expires_at(&json),
            },
        )
    }
    fn callback(
        &self,
        stream: &mut TcpStream,
        cancel: &impl Fn() -> bool,
    ) -> Result<Option<String>> {
        // Darwin accepts inherit the listener's O_NONBLOCK. The existing
        // bounded reads must wait, rather than spin on WouldBlock until a
        // fragmented browser callback arrives or cancellation is requested.
        stream.set_nonblocking(false)?;
        stream.set_read_timeout(Some(Duration::from_millis(50)))?;
        stream.set_write_timeout(Some(Duration::from_millis(500)))?;
        let deadline = Instant::now() + Duration::from_secs(2);
        let mut bytes = Vec::new();
        let mut chunk = [0u8; 1024];
        loop {
            ensure!(!cancel(), "Google sign-in cancelled");
            ensure!(Instant::now() < deadline, "Sign-in callback read timed out");
            match stream.read(&mut chunk) {
                Ok(0) => bail!("Incomplete sign-in callback"),
                Ok(n) => {
                    bytes.extend_from_slice(&chunk[..n]);
                    ensure!(bytes.len() <= 16384, "Sign-in callback exceeds limit");
                    if bytes.windows(4).any(|x| x == b"\r\n\r\n") {
                        break;
                    }
                }
                Err(e)
                    if matches!(
                        e.kind(),
                        std::io::ErrorKind::WouldBlock | std::io::ErrorKind::TimedOut
                    ) => {}
                Err(_) => bail!("Sign-in callback read failed"),
            }
        }
        let request = std::str::from_utf8(&bytes).context("Invalid sign-in callback")?;
        let line = request.split("\r\n").next().unwrap_or("");
        let fields: Vec<_> = line.split_whitespace().collect();
        ensure!(
            fields.len() == 3
                && fields[0] == "GET"
                && matches!(fields[2], "HTTP/1.0" | "HTTP/1.1")
                && fields[1].starts_with('/')
                && !fields[1].starts_with("//"),
            "Invalid sign-in callback"
        );
        let headers = request
            .split("\r\n")
            .skip(1)
            .take_while(|line| !line.is_empty())
            .map(|line| line.split_once(':').context("Invalid callback header"))
            .collect::<Result<Vec<_>>>()?;
        let hosts = headers
            .iter()
            .filter(|(name, _)| name.eq_ignore_ascii_case("host"))
            .map(|(_, value)| value.trim())
            .collect::<Vec<_>>();
        let authority = self
            .redirect
            .strip_prefix("http://")
            .unwrap_or("")
            .split('/')
            .next()
            .unwrap_or("");
        ensure!(
            hosts.len() == 1
                && hosts[0] == authority
                && !headers.iter().any(|(name, value)| name
                    .eq_ignore_ascii_case("transfer-encoding")
                    || (name.eq_ignore_ascii_case("content-length") && value.trim() != "0")),
            "Invalid callback request framing"
        );
        let target = url::Url::parse(&format!("http://127.0.0.1{}", fields[1]))?;
        ensure!(
            target.path() == "/oauth2/callback" && target.fragment().is_none(),
            "Unexpected sign-in callback path"
        );
        let pairs: Vec<_> = target.query_pairs().collect();
        let values = |key: &str| {
            pairs
                .iter()
                .filter(|(k, _)| k == key)
                .map(|(_, v)| v.as_ref())
                .collect::<Vec<_>>()
        };
        let state = values("state");
        ensure!(
            state.len() == 1 && state[0] == self.state,
            "Sign-in callback state mismatch"
        );
        let codes = values("code");
        if !values("error").is_empty() {
            reply(
                stream,
                200,
                "Sign-in was cancelled. You can close this window.",
            )?;
            return Ok(None);
        }
        ensure!(
            codes.len() == 1
                && !codes[0].is_empty()
                && codes[0].len() <= 4096
                && !codes[0].chars().any(char::is_control),
            "Missing sign-in code"
        );
        reply(
            stream,
            200,
            "Sign-in received. Return to SingZ; you can close this window.",
        )?;
        Ok(Some(codes[0].to_owned()))
    }
}
fn reply(stream: &mut TcpStream, status: u16, text: &str) -> Result<()> {
    write!(
        stream,
        "HTTP/1.1 {status} {}\r\nContent-Type: text/plain; charset=utf-8\r\nContent-Length: {}\r\nCache-Control: no-store\r\nConnection: close\r\n\r\n{text}",
        if status == 200 { "OK" } else { "Bad Request" },
        text.len()
    )?;
    Ok(())
}

#[derive(Clone)]
pub struct AuthClient {
    pub config: Config,
    pub store: TokenStore,
}
impl AuthClient {
    pub fn new(config: Config, store: TokenStore) -> Self {
        Self { config, store }
    }
    pub fn request(&self, req: Request<'_>, cancel: &impl Fn() -> bool) -> Result<Response> {
        self.request_with_progress(req, cancel, &|_| {})
    }
    pub fn request_with_progress(
        &self,
        req: Request<'_>,
        cancel: &impl Fn() -> bool,
        progress: &impl Fn(u64),
    ) -> Result<Response> {
        #[cfg(test)]
        let _timing = AuthRequestTiming::new();
        // A caller cannot redirect credentials to an arbitrary endpoint.
        let url = drive_http::validate_url(req.url, self.config.allow_loopback_http)?;
        let allowed = [&self.config.api_base, &self.config.upload_base]
            .iter()
            .any(|base| {
                url::Url::parse(base).is_ok_and(|base| {
                    let prefix = base.path().trim_end_matches('/');
                    base.origin() == url.origin()
                        && (prefix.is_empty()
                            || url.path() == prefix
                            || url
                                .path()
                                .strip_prefix(prefix)
                                .is_some_and(|suffix| suffix.starts_with('/')))
                })
            });
        ensure!(allowed, "Drive request is outside configured endpoints");
        let _observation = self.store.0.observer.start()?;
        let mut expected = None;
        for retry in 0..2 {
            // Run caller callbacks before the authoritative preflight; never
            // hold the session mutex/lease while invoking arbitrary code.
            ensure!(!cancel(), "Drive session changed");
            let (generation, token) = {
                // Supply the token and its epoch in the same leased snapshot,
                // instead of the old observe/access_token/preflight triple read.
                let state = self.store.lock()?;
                let generation = self.store.generation();
                ensure!(
                    generation != u64::MAX && expected.is_none_or(|old| old == generation),
                    "Drive session changed"
                );
                let tokens = state
                    .tokens
                    .as_ref()
                    .context("Not signed in to Google Drive")?;
                let token =
                    (retry == 0 && now_ms() < tokens.expires_at).then(|| tokens.access.clone());
                (generation, token)
            };
            expected = Some(generation);
            let cancelled = || cancel() || self.store.generation() != generation;
            let renewed = token.is_none();
            let token = match token {
                Some(token) => token,
                None => self
                    .store
                    .access_token(&self.config, retry == 1, &cancelled)?,
            };
            let authorization = format!("Bearer {token}");
            let mut headers = req
                .headers
                .iter()
                .copied()
                .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
                .collect::<Vec<_>>();
            headers.push(("Authorization", &authorization));
            // Fresh tokens were just verified under the lease, with no caller
            // callbacks since that read. Renewal involved network I/O/callbacks,
            // so it still needs the separate leased preflight before sending.
            if renewed {
                self.store.check_generation(generation)?;
            }
            let response = drive_http::request_with_progress(
                Request {
                    method: req.method,
                    url: req.url,
                    headers: &headers,
                    body: req.body,
                    destination: req.destination,
                    upload: req.upload,
                    allow_loopback_http: self.config.allow_loopback_http,
                },
                &cancelled,
                progress,
            )?;
            self.store.check_generation(generation)?;
            ensure!(!cancelled(), "Drive session changed");
            if response.status != 401 || retry == 1 {
                return Ok(response);
            }
            if let Destination::File(path, _) = req.destination {
                fs::remove_file(path).context("Could not discard expired Drive response")?;
            }
        }
        unreachable!()
    }
}

#[cfg(test)]
struct AuthRequestTiming {
    start: Instant,
    counts: (u64, u64),
    lease: Duration,
    network: [u64; 6],
    phases: [Duration; 2],
}
#[cfg(test)]
impl AuthRequestTiming {
    fn new() -> Option<Self> {
        drive_http::test_profile_enabled().then(|| Self {
            start: Instant::now(),
            counts: AUTH_IO_COUNTS.with(|v| v.get()),
            lease: AUTH_LEASE_WAIT.with(|v| v.get()),
            network: drive_http::test_io_timings(),
            phases: AUTH_PHASE_TIME.with(|v| v.get()),
        })
    }
}
#[cfg(test)]
impl Drop for AuthRequestTiming {
    fn drop(&mut self) {
        let counts = AUTH_IO_COUNTS.with(|v| v.get());
        let lease = AUTH_LEASE_WAIT.with(|v| v.get()) - self.lease;
        let network = drive_http::test_io_timings();
        let delta: [u64; 6] = std::array::from_fn(|i| network[i] - self.network[i]);
        let phases = AUTH_PHASE_TIME.with(|v| v.get());
        eprintln!(
            "DRIVE_TIMING total_us={} fs={} locks={} auth_us={} observer_us={} lease_us={} dns_us={} tcp_us={} tls_us={} io_wait_us={} cancel_us={} poll_wakes={}",
            self.start.elapsed().as_micros(),
            counts.0 - self.counts.0,
            counts.1 - self.counts.1,
            (phases[0] - self.phases[0]).as_micros(),
            (phases[1] - self.phases[1]).as_micros(),
            lease.as_micros(),
            delta[0] / 1000,
            delta[1] / 1000,
            delta[2].saturating_sub(delta[1]) / 1000,
            delta[3] / 1000,
            delta[4] / 1000,
            delta[5]
        );
    }
}

#[cfg(test)]
#[path = "drive_auth_tests.rs"]
mod tests;

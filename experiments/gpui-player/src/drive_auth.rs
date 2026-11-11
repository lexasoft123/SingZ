//! Native installed-app OAuth. This module never launches a browser or logs credentials.
use crate::drive_http::{self, Body, Destination, Request, Response};
use anyhow::{Context, Result, bail, ensure};
use base64::{Engine, engine::general_purpose::URL_SAFE_NO_PAD};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::{
    fs,
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    path::{Path, PathBuf},
    sync::{Arc, Mutex},
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
    fn from_override_or(baked: &str, override_config: std::result::Result<String, std::env::VarError>) -> Result<Self> {
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
    let metadata: serde_json::Value = serde_json::from_str(include_str!(concat!(env!("OUT_DIR"), "/drive-config-metadata.json")))
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
    BakedConfigMetadata { configured, source, status }
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
        let selected = Config::from_override_or(&baked, Err(std::env::VarError::NotPresent)).unwrap();
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
        assert!(object.contains_key("configured") && object.contains_key("source") && object.contains_key("status"));
        assert!(matches!(metadata.source, "canonical-json" | "legacy-typescript" | "none" | "unknown"));
        assert!(matches!(metadata.status, "configured" | "missing" | "unreadable" | "malformed" | "invalid"));
        assert_eq!(baked_configured(), metadata.configured);
        assert_eq!(metadata.configured, Config::from_json(include_str!(concat!(env!("OUT_DIR"), "/drive-config.json"))).is_ok());
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
struct Store {
    path: PathBuf,
    state: Mutex<State>,
    #[cfg(test)]
    lock_timeout: Duration,
}
struct Locked<'a> {
    state: std::sync::MutexGuard<'a, State>,
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
        let path = dir.join("session.json");
        let state = if path.exists() {
            let meta = fs::symlink_metadata(&path)?;
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
            let state: State = serde_json::from_slice(&fs::read(&path)?)
                .map_err(|_| anyhow::anyhow!("Invalid saved Drive session"))?;
            if let Some(tokens) = &state.tokens {
                check_secret(&tokens.access)?;
                check_secret(&tokens.refresh)?;
            }
            state
        } else {
            State {
                generation: 0,
                tokens: None,
            }
        };
        Ok(Self(Arc::new(Store {
            path,
            state: Mutex::new(state),
            #[cfg(test)]
            lock_timeout: Duration::from_secs(2),
        })))
    }
    fn lock(&self) -> Result<Locked<'_>> {
        #[cfg(not(test))]
        let timeout = Duration::from_secs(2);
        #[cfg(test)]
        let timeout = self.0.lock_timeout;
        let deadline = Instant::now() + timeout;
        let mut state = loop {
            match self.0.state.try_lock() {
                Ok(state) => break state,
                Err(std::sync::TryLockError::WouldBlock) => {
                    ensure!(
                        Instant::now() < deadline,
                        "Drive session is busy; retry shortly"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(std::sync::TryLockError::Poisoned(_)) => {
                    bail!("Drive session state unavailable")
                }
            }
        };
        let lock_path = self.0.path.with_extension("lock");
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
        let file = options
            .open(lock_path)
            .context("Could not open Drive session lock")?;
        let lease = loop {
            match crate::file_lease::Lease::acquire(file.try_clone()?) {
                Ok(lease) => break lease,
                Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                    ensure!(
                        Instant::now() < deadline,
                        "Drive session is busy; retry shortly"
                    );
                    thread::sleep(Duration::from_millis(10));
                }
                Err(error) => return Err(error).context("Could not lock Drive session"),
            }
        };
        let disk = if self.0.path.exists() {
            let meta = fs::symlink_metadata(&self.0.path)?;
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
            serde_json::from_slice::<State>(&fs::read(&self.0.path)?)
                .map_err(|_| anyhow::anyhow!("Invalid saved Drive session"))?
        } else {
            State {
                generation: 0,
                tokens: None,
            }
        };
        ensure!(
            disk.generation >= state.generation,
            "Drive session changed on disk"
        );
        if let Some(tokens) = &disk.tokens {
            check_secret(&tokens.access)?;
            check_secret(&tokens.refresh)?;
        }
        *state = disk;
        Ok(Locked {
            state,
            _lease: lease,
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
    pub fn generation(&self) -> u64 {
        self.lock().map(|s| s.generation).unwrap_or(u64::MAX)
    }
    pub fn signed_in(&self) -> bool {
        self.signed_in_checked().unwrap_or(false)
    }
    pub fn signed_in_checked(&self) -> Result<bool> {
        Ok(self.lock()?.tokens.is_some())
    }
    fn advance(&self, clear: bool) -> Result<u64> {
        let mut state = self.lock()?;
        let mut next = state.clone();
        next.generation = next
            .generation
            .checked_add(1)
            .context("Drive session generation exhausted")?;
        if clear {
            next.tokens = None;
        }
        // Sign-out fences running work even when the disk write fails.
        if clear {
            *state = next.clone();
            self.persist(&next)?;
        } else {
            self.persist(&next)?;
            *state = next;
        }
        Ok(state.generation)
    }
    pub fn sign_out(&self) -> Result<()> {
        self.advance(true).map(|_| ())
    }
    fn adopt(&self, generation: u64, tokens: Tokens) -> Result<()> {
        let mut state = self.lock()?;
        ensure!(state.generation == generation, "Drive session changed");
        let next = State {
            generation,
            tokens: Some(tokens),
        };
        self.persist(&next)?;
        *state = next;
        Ok(())
    }
    fn clear_if(&self, generation: u64) -> Result<Option<u64>> {
        let mut state = self.lock()?;
        if state.generation == generation && state.tokens.is_some() {
            state.tokens = None;
            state.generation = state
                .generation
                .checked_add(1)
                .context("Drive session generation exhausted")?;
            self.persist(&state)?;
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
    fn expired(&self, generation: u64) -> anyhow::Error {
        match self.clear_if(generation) {
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
        let (generation, tokens) = {
            let state = self.lock()?;
            (
                state.generation,
                state
                    .tokens
                    .clone()
                    .context("Not signed in to Google Drive")?,
            )
        };
        ensure!(!cancel(), "Drive request cancelled");
        if !renew && now_ms() < tokens.expires_at {
            return Ok(tokens.access);
        }
        let mut form = url::form_urlencoded::Serializer::new(String::new());
        form.append_pair("refresh_token", &tokens.refresh)
            .append_pair("client_id", &cfg.client_id)
            .append_pair("client_secret", &cfg.client_secret)
            .append_pair("grant_type", "refresh_token");
        let body = form.finish();
        let cancelled = || cancel() || self.generation() != generation;
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
            return Err(self.expired(generation));
        }
        ensure!(
            (200..300).contains(&response.status),
            "Drive session renewal failed (HTTP {})",
            response.status
        );
        let json = response.json()?;
        let Some(access) = json["access_token"].as_str() else {
            return Err(self.expired(generation));
        };
        check_secret(access)?;
        let updated = Tokens {
            access: access.into(),
            refresh: tokens.refresh,
            expires_at: expires_at(&json),
        };
        self.adopt(generation, updated.clone())?;
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
        let generation = store.advance(false)?;
        Ok(Self {
            config,
            store,
            generation,
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
        let cancelled = || cancel() || self.store.generation() != self.generation;
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
        self.store.adopt(
            self.generation,
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
        let generation = self.store.generation();
        let cancelled = || cancel() || self.store.generation() != generation;
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
        for retry in 0..2 {
            ensure!(!cancelled(), "Drive session changed");
            let token = self
                .store
                .access_token(&self.config, retry == 1, &cancelled)?;
            let authorization = format!("Bearer {token}");
            let mut headers = req
                .headers
                .iter()
                .copied()
                .filter(|(name, _)| !name.eq_ignore_ascii_case("authorization"))
                .collect::<Vec<_>>();
            headers.push(("Authorization", &authorization));
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
#[path = "drive_auth_tests.rs"]
mod tests;

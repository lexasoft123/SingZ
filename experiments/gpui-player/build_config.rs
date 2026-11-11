//! Build-time OAuth application configuration selection, with value-free metadata.
//! This module is shared with unit tests; it never reads account/token stores.
use serde_json::{Map, Value, json};
use std::{fs, io, path::Path};

pub const CANONICAL_PATH: &str = "mobile/gdrive.config.json";
pub const LEGACY_PATH: &str = "src/main/gdrive-config.ts";
pub const REQUIRE_ENV: &str = "SINGZ_GPUI_REQUIRE_DRIVE_CONFIG";
const MAX_CONFIG_BYTES: usize = 65_536;
const KEYS: [&str; 6] = ["clientId", "clientSecret", "authBase", "apiBase", "uploadBase", "tokenUrl"];
const LEGACY_KEYS: [&str; 5] = ["clientId", "clientSecret", "authBase", "apiBase", "uploadBase"];

pub enum Input {
    Missing,
    Text(String),
    Unreadable,
}

// Deliberately no Debug implementation: selected configuration contains values.
pub struct Selected {
    pub config_json: String,
    pub configured: bool,
    pub source: &'static str,
    pub status: &'static str,
}
impl Selected {
    pub fn metadata_json(&self) -> String {
        json!({"schema":1,"configured":self.configured,"source":self.source,"status":self.status}).to_string()
    }
}

pub fn rerun_directives(root: &Path) -> Vec<String> {
    vec![
        format!("cargo:rerun-if-changed={}", root.join(CANONICAL_PATH).display()),
        format!("cargo:rerun-if-changed={}", root.join(LEGACY_PATH).display()),
        format!("cargo:rerun-if-env-changed={REQUIRE_ENV}"),
    ]
}

pub fn read_source(path: &Path) -> Input {
    match fs::read_to_string(path) {
        Ok(text) => Input::Text(text),
        // A dangling canonical link is present but unreadable, not permission
        // to select an unrelated old generated module instead.
        Err(error) if error.kind() == io::ErrorKind::NotFound => {
            match fs::symlink_metadata(path) {
                Err(error) if error.kind() == io::ErrorKind::NotFound => Input::Missing,
                _ => Input::Unreadable,
            }
        }
        Err(_) => Input::Unreadable,
    }
}

fn empty() -> Map<String, Value> {
    KEYS.iter().map(|key| ((*key).into(), Value::String(String::new()))).collect()
}

fn canonical(text: &str) -> Result<Map<String, Value>, &'static str> {
    if text.len() > MAX_CONFIG_BYTES { return Err("invalid"); }
    let parsed: Value = serde_json::from_str(text).map_err(|_| "malformed")?;
    let object = parsed.as_object().ok_or("invalid")?;
    let mut selected = empty();
    for key in KEYS {
        if let Some(value) = object.get(key) {
            if !value.is_string() { return Err("invalid"); }
            selected.insert(key.into(), value.clone());
        }
    }
    // Unknown members are never baked: in particular this application-only
    // document cannot accidentally embed account tokens from extra properties.
    Ok(selected)
}

fn legacy(text: &str) -> Result<Map<String, Value>, &'static str> {
    if text.len() > MAX_CONFIG_BYTES { return Err("invalid"); }
    let mut selected = empty();
    for key in LEGACY_KEYS {
        let mut found = false;
        for line in text.lines() {
            let Some(rest) = line.trim().strip_prefix(key).and_then(|v| v.strip_prefix(':')) else { continue; };
            if found { return Err("malformed"); }
            found = true;
            let rest = rest.trim();
            let value: Value = serde_json::from_str(rest.strip_suffix(',').unwrap_or(rest)).map_err(|_| "malformed")?;
            if !value.is_string() { return Err("invalid"); }
            selected.insert(key.into(), value);
        }
    }
    Ok(selected)
}

fn valid(config: &Map<String, Value>) -> bool {
    let value = |key: &str| config.get(key).and_then(Value::as_str).unwrap_or("");
    let (client, secret) = (value("clientId"), value("clientSecret"));
    if client.trim().is_empty() || client.len() > 4096 || secret.len() > 8192
        || client.chars().chain(secret.chars()).any(char::is_control) {
        return false;
    }
    let auth = if value("authBase").is_empty() { "https://accounts.google.com" } else { value("authBase") };
    let api = if value("apiBase").is_empty() { "https://www.googleapis.com" } else { value("apiBase") };
    let upload = if value("uploadBase").is_empty() { api } else { value("uploadBase") };
    let default_token = if api == "https://www.googleapis.com" { "https://oauth2.googleapis.com/token".into() } else { format!("{}/token", api.trim_end_matches('/')) };
    let token = if value("tokenUrl").is_empty() { default_token.as_str() } else { value("tokenUrl") };
    [auth, api, upload, token].iter().all(|endpoint| {
        endpoint.len() <= 16384 && !endpoint.chars().any(char::is_control)
            && url::Url::parse(endpoint).is_ok_and(|url| url.scheme() == "https"
                && url.host_str().is_some() && url.username().is_empty()
                && url.password().is_none() && url.fragment().is_none() && url.query().is_none())
    })
}

pub fn select(canonical_input: &Input, legacy_input: &Input) -> Selected {
    let (input, source, parser): (&Input, &'static str, fn(&str) -> Result<Map<String, Value>, &'static str>) =
        if matches!(canonical_input, Input::Missing) {
            if matches!(legacy_input, Input::Missing) { (legacy_input, "none", legacy) }
            else { (legacy_input, "legacy-typescript", legacy) }
        } else { (canonical_input, "canonical-json", canonical) };
    let result = match input {
        Input::Missing => Err("missing"),
        Input::Unreadable => Err("unreadable"),
        Input::Text(text) => parser(text).and_then(|config| if valid(&config) { Ok(config) } else { Err("invalid") }),
    };
    match result {
        Ok(config) => Selected { config_json: Value::Object(config).to_string(), configured: true, source, status: "configured" },
        Err(status) => Selected { config_json: Value::Object(empty()).to_string(), configured: false, source, status },
    }
}

pub fn require_config(required: bool, selected: &Selected) -> Result<(), &'static str> {
    if required && !selected.configured {
        Err("Required Drive OAuth application configuration is missing or invalid. Stage mobile/gdrive.config.json (or the compatible generated legacy module) before building. Configuration values are not printed.")
    } else { Ok(()) }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn good(marker: &str) -> Input { Input::Text(json!({"clientId":marker}).to_string()) }
    fn old(marker: &str) -> Input { Input::Text(format!("export default {{\n  clientId: {},\n  clientSecret: \"\",\n  authBase: \"\",\n  apiBase: \"\",\n  uploadBase: \"\"\n}}\n", json!(marker))) }
    #[test]
    fn canonical_wins_and_only_absence_permits_legacy_fallback() {
        let selected = select(&good("canonical-marker"), &old("legacy-marker"));
        assert!(selected.configured);
        assert_eq!(selected.source, "canonical-json");
        assert!(serde_json::from_str::<Value>(&selected.config_json).unwrap()["clientId"] == "canonical-marker");
        let selected = select(&Input::Missing, &old("legacy-marker"));
        assert!(selected.configured);
        assert_eq!(selected.source, "legacy-typescript");
    }
    #[test]
    fn present_bad_canonical_never_uses_valid_legacy() {
        for (input, status) in [(Input::Text("{bad".into()), "malformed"), (good(""), "invalid"), (Input::Unreadable, "unreadable"), (Input::Text("[]".into()), "invalid"), (Input::Text(json!({"clientId":1}).to_string()), "invalid")] {
            let selected = select(&input, &old("legacy-marker"));
            assert!(!selected.configured);
            assert_eq!(selected.source, "canonical-json");
            assert_eq!(selected.status, status);
        }
    }
    #[test]
    fn ordinary_missing_dev_configuration_is_supported_but_required_build_fails() {
        let selected = select(&Input::Missing, &Input::Missing);
        assert_eq!(selected.source, "none");
        assert_eq!(selected.status, "missing");
        assert!(!selected.configured);
        assert!(require_config(false, &selected).is_ok());
        assert!(require_config(true, &selected).is_err());
        assert!(require_config(true, &select(&good("marker"), &Input::Missing)).is_ok());
    }
    #[test]
    fn source_escaping_is_data_not_typescript_or_build_output() {
        let secret = "quotation\" slash\\ Unicode Ω 日本語";
        let raw = json!({"clientId":"marker","clientSecret":secret}).to_string();
        let selected = select(&Input::Text(raw), &Input::Missing);
        assert!(selected.configured);
        assert!(serde_json::from_str::<Value>(&selected.config_json).unwrap()["clientSecret"] == secret);
        let generated = format!("clientId: \"marker\",\nclientSecret: {},\n", json!(secret));
        let selected = select(&Input::Missing, &Input::Text(generated));
        assert!(selected.configured);
        assert!(serde_json::from_str::<Value>(&selected.config_json).unwrap()["clientSecret"] == secret);
        assert!(!selected.metadata_json().contains(secret));
    }
    #[test]
    fn errors_and_metadata_never_echo_sensitive_input() {
        let marker = "sensitive-canary-not-a-real-credential";
        for input in [Input::Text(format!("{{\"clientId\":\"{marker}\",bad")), Input::Text(json!({"clientId":marker,"authBase":"http://example.invalid"}).to_string())] {
            let selected = select(&input, &old(marker));
            assert!(!selected.configured);
            assert!(!selected.metadata_json().contains(marker));
            assert!(!selected.config_json.contains(marker));
            assert!(!require_config(true, &selected).unwrap_err().contains(marker));
        }
    }
    #[test]
    fn unknown_account_members_are_not_baked() {
        let selected = select(&Input::Text(json!({"clientId":"marker","refresh":"not-an-account-token","access":"not-an-account-token"}).to_string()), &Input::Missing);
        assert!(selected.configured);
        let config: Value = serde_json::from_str(&selected.config_json).unwrap();
        assert!(config.get("refresh").is_none() && config.get("access").is_none());
    }
    #[test]
    fn endpoint_and_client_validation_matches_shipping_https_policy() {
        for endpoint in ["http://127.0.0.1", "https://user@example.invalid", "https://example.invalid?query", "https://example.invalid/#fragment", "not-a-url"] {
            let selected = select(&Input::Text(json!({"clientId":"marker","apiBase":endpoint}).to_string()), &Input::Missing);
            assert!(!selected.configured);
        }
        assert!(!select(&good("has\ncontrol"), &Input::Missing).configured);
        assert!(!select(&good(&"x".repeat(4097)), &Input::Missing).configured);
        assert!(select(&good("marker"), &Input::Missing).configured);
        assert!(select(&Input::Text(json!({"clientId":"marker","apiBase":"https://example.invalid/custom","tokenUrl":"https://example.invalid/oauth"}).to_string()), &Input::Missing).configured);
    }
    #[test]
    fn malformed_legacy_and_duplicate_properties_are_not_executed() {
        for text in ["clientId: 'not-a-json-string'", "clientId: 7", "clientId: \"first\",\nclientId: \"second\",", "export default {}"] {
            assert!(!select(&Input::Missing, &Input::Text(text.into())).configured);
        }
    }
    #[test]
    fn both_sources_and_requirement_flag_are_cargo_rerun_inputs() {
        let root = Path::new("repository with spaces");
        let directives = rerun_directives(root);
        assert!(directives.contains(&format!("cargo:rerun-if-changed={}", root.join(CANONICAL_PATH).display())));
        assert!(directives.contains(&format!("cargo:rerun-if-changed={}", root.join(LEGACY_PATH).display())));
        assert!(directives.contains(&format!("cargo:rerun-if-env-changed={REQUIRE_ENV}")));
        assert!(!directives.iter().any(|line| line.contains("SINGZ_GDRIVE_CONFIG")));
    }
    #[test]
    fn file_presence_read_failures_and_dangling_links_do_not_masquerade_as_absence() {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let dir = std::env::temp_dir().join(format!("singz-build-config-{}-{}", std::process::id(), NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)));
        fs::create_dir(&dir).unwrap();
        struct Cleanup(std::path::PathBuf);
        impl Drop for Cleanup { fn drop(&mut self) { let _ = fs::remove_dir_all(&self.0); } }
        let _cleanup = Cleanup(dir.clone());
        assert!(matches!(read_source(&dir.join("missing")), Input::Missing));
        assert!(matches!(read_source(&dir), Input::Unreadable));
        let valid = dir.join("config.json");
        fs::write(&valid, json!({"clientId":"marker"}).to_string()).unwrap();
        assert!(select(&read_source(&valid), &Input::Missing).configured);
        #[cfg(unix)] {
            let link = dir.join("dangling.json");
            std::os::unix::fs::symlink(dir.join("absent-target"), &link).unwrap();
            assert!(matches!(read_source(&link), Input::Unreadable));
        }
    }
}

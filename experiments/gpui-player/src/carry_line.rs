//! Carry the line: production training preferences and native ducking plans.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
};
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Mode {
    #[default]
    Time,
    Lines,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Config {
    pub mode: Mode,
    pub period_sec: u32,
    pub hear: u32,
    pub sing: u32,
    pub stems: Vec<String>,
}
impl Default for Config {
    fn default() -> Self {
        Self {
            mode: Mode::Time,
            period_sec: 10,
            hear: 1,
            sing: 1,
            stems: vec!["vocals".into()],
        }
    }
}
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Desired {
    pub enabled: bool,
    pub config: Config,
}
fn array_string(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(s) => s.clone(),
        Value::Array(a) => a.iter().map(array_string).collect::<Vec<_>>().join(","),
        Value::Object(_) => "[object Object]".into(),
        _ => value.to_string(),
    }
}
fn js_number(value: &Value) -> Option<f64> {
    match value {
        Value::Null => Some(0.),
        Value::Bool(b) => Some(if *b { 1. } else { 0. }),
        Value::Number(n) => n.as_f64(),
        Value::Object(_) => None,
        Value::Array(_) => js_number(&Value::String(array_string(value))),
        Value::String(s) => {
            let s = crate::lyrics_edit::trim_text(s);
            if s.is_empty() {
                return Some(0.);
            }
            let radix = if s.starts_with("0x") || s.starts_with("0X") {
                Some(16)
            } else if s.starts_with("0b") || s.starts_with("0B") {
                Some(2)
            } else if s.starts_with("0o") || s.starts_with("0O") {
                Some(8)
            } else {
                None
            };
            if let Some(radix) = radix {
                let digits = &s[2..];
                if digits.is_empty() {
                    return None;
                }
                digits.chars().try_fold(0., |n, c| {
                    c.to_digit(radix).map(|d| n * radix as f64 + d as f64)
                })
            } else {
                s.parse().ok()
            }
        }
    }
    .filter(|v| v.is_finite())
}
impl Config {
    pub fn sanitize(raw: &Value) -> Self {
        let int = |key: &str, lo: f64, hi: f64, default: u32| {
            raw.get(key)
                .and_then(js_number)
                .map(|v| (v + 0.5).floor().clamp(lo, hi) as u32)
                .unwrap_or(default)
        };
        let stems: Vec<_> = raw["stems"]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(Value::as_str)
                    .map(str::to_owned)
                    .collect()
            })
            .unwrap_or_default();
        Self {
            mode: if raw["mode"] == "lines" {
                Mode::Lines
            } else {
                Mode::Time
            },
            period_sec: int("periodSec", 5., 60., 10),
            hear: int("hear", 1., 8., 1),
            sing: int("sing", 1., 8., 1),
            stems: if stems.is_empty() {
                vec!["vocals".into()]
            } else {
                stems
            },
        }
    }
    pub fn validate(&self) -> Result<()> {
        ensure!(
            (5..=60).contains(&self.period_sec)
                && (1..=8).contains(&self.hear)
                && (1..=8).contains(&self.sing),
            "Invalid Carry the line configuration"
        );
        Ok(())
    }
}
impl Desired {
    pub fn from_settings(raw: &Value) -> Self {
        Self {
            enabled: raw["on"] == true,
            config: Config::sanitize(raw),
        }
    }
    pub fn merge_settings(&self, raw: &mut Value) -> Result<()> {
        self.config.validate()?;
        if !raw.is_object() {
            *raw = json!({});
        }
        let object = raw.as_object_mut().unwrap();
        object.extend(
            serde_json::to_value(&self.config)?
                .as_object()
                .unwrap()
                .clone(),
        );
        if self.enabled {
            object.insert("on".into(), json!(true));
        } else {
            object.remove("on");
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub struct Window {
    pub s: f64,
    pub e: f64,
}
pub fn training_windows(
    lines: &[crate::project_lyrics::Line],
    hear: u32,
    sing: u32,
    duration: f64,
) -> Vec<Window> {
    let cycle = hear.max(1) as usize + sing.max(1) as usize;
    let mut windows = vec![];
    let mut i = 0;
    while i < lines.len() {
        if i % cycle < hear as usize {
            i += 1;
            continue;
        }
        let mut j = i;
        while j + 1 < lines.len() && (j + 1) % cycle >= hear as usize {
            j += 1;
        }
        let s = (lines[i].start as f64 - 0.15).max(0.);
        let e = if j + 1 < lines.len() {
            (lines[j + 1].start as f64 - 0.15).max(0.)
        } else {
            duration
        };
        if e > s {
            windows.push(Window { s, e });
        }
        i = j + 1;
    }
    windows
}
pub fn sing_mask(enabled: bool, config: &Config, line_count: usize) -> Option<Vec<bool>> {
    if !enabled || config.mode != Mode::Lines {
        return None;
    }
    let cycle = config.hear as usize + config.sing as usize;
    if cycle == 0 {
        return None;
    }
    Some(
        (0..line_count)
            .map(|i| i % cycle >= config.hear as usize)
            .collect(),
    )
}
#[derive(Clone, Debug)]
pub struct Plan {
    pub desired: Desired,
    pub on: bool,
    pub mode: u8,
    pub period_sec: f64,
    pub lane_ids: Vec<String>,
    pub windows: Vec<Window>,
}
impl Plan {
    pub fn capture(
        desired: Desired,
        available: &[crate::tracks::Lane],
        lines: Option<&[crate::project_lyrics::Line]>,
        duration: f64,
        split: bool,
    ) -> Result<Self> {
        desired.config.validate()?;
        ensure!(
            available.len() <= crate::tracks::MAX_ACTIVE_LANES,
            "Too many Carry the line tracks"
        );
        let mut lane_ids = vec![];
        for id in &desired.config.stems {
            if available.iter().any(|lane| lane.id == *id) && !lane_ids.contains(id) {
                ensure!(
                    !id.is_empty() && id.len() <= 128 && !id.chars().any(char::is_control),
                    "Invalid Carry the line track identity"
                );
                lane_ids.push(id.clone());
            }
        }
        let line_mode = desired.config.mode == Mode::Lines && lines.is_some_and(|l| !l.is_empty());
        let mut windows = if line_mode {
            training_windows(
                lines.unwrap(),
                desired.config.hear,
                desired.config.sing,
                duration,
            )
        } else {
            vec![]
        };
        ensure!(windows.len() <= 16384, "Too many Carry the line windows");
        let on = desired.enabled && split && !available.is_empty();
        if !on {
            lane_ids.clear();
            windows.clear();
        }
        if on && line_mode {
            let mut last = 0.;
            for window in &windows {
                ensure!(
                    window.s.is_finite()
                        && window.e.is_finite()
                        && window.s >= last
                        && window.e > window.s
                        && window.e <= 3600.,
                    "Invalid Carry the line lyric windows"
                );
                last = window.e;
            }
        }
        let period_sec = desired.config.period_sec as f64;
        Ok(Self {
            desired,
            on,
            mode: if on && line_mode { 1 } else { 0 },
            period_sec,
            lane_ids,
            windows,
        })
    }
    pub fn commands(&self) -> Result<Vec<String>> {
        self.commands_with_arming(true)
    }
    /// Restoring a saved enabled schedule must preserve its saved manual mutes.
    /// Source restoration sets state directly; only an explicit arm unmutes.
    pub fn restore_commands(&self) -> Result<Vec<String>> {
        self.commands_with_arming(false)
    }
    fn commands_with_arming(&self, arm: bool) -> Result<Vec<String>> {
        self.desired.config.validate()?;
        ensure!(
            self.lane_ids.len() <= 16 && self.windows.len() <= 16384,
            "Carry the line plan exceeds native limits"
        );
        ensure!(
            self.mode <= 1
                && self.period_sec.is_finite()
                && self.period_sec > 0.
                && self.period_sec <= 3600.,
            "Invalid Carry the line native mode or period"
        );
        let mut ids = std::collections::HashSet::new();
        for id in &self.lane_ids {
            ensure!(
                !id.is_empty()
                    && id.len() <= 128
                    && !id.chars().any(char::is_control)
                    && ids.insert(id),
                "Invalid Carry the line native lane IDs"
            );
        }
        let mut last = 0.;
        for window in &self.windows {
            ensure!(
                window.s.is_finite()
                    && window.e.is_finite()
                    && window.s >= last
                    && window.e > window.s
                    && window.e <= 3600.,
                "Invalid Carry the line native windows"
            );
            last = window.e;
        }
        let mut commands = vec![format!(
            "carry-begin {} {} {} {} {}",
            u8::from(self.on),
            self.mode,
            self.period_sec,
            self.lane_ids.len(),
            self.windows.len()
        )];
        if !arm {
            commands[0].push_str(" 0");
        }
        for id in &self.lane_ids {
            use std::fmt::Write;
            let mut encoded = String::new();
            for b in id.bytes() {
                write!(&mut encoded, "{b:02x}").unwrap();
            }
            commands.push(format!("carry-lane {encoded}"));
        }
        for window in &self.windows {
            commands.push(format!("carry-window {} {}", window.s, window.e));
        }
        commands.push("carry-apply".into());
        Ok(commands)
    }
}
const NAME: &str = "carry-line.json";
const LIMIT: u64 = 64 * 1024;
fn read_bytes(dir: &Path) -> Result<Option<Vec<u8>>> {
    let path = dir.join(NAME);
    match fs::symlink_metadata(&path) {
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
        Ok(m) => ensure!(
            m.file_type().is_file() && m.len() > 0 && m.len() <= LIMIT,
            "Carry the line preferences must be an ordinary bounded JSON file"
        ),
    };
    let mut bytes = vec![];
    let mut options = OpenOptions::new();
    options.read(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100 | 0x4);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000 | 0x800);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let file = options.open(&path)?;
    ensure!(
        file.metadata()?.is_file(),
        "Carry the line preferences must be ordinary"
    );
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        bytes.len() as u64 <= LIMIT && fs::symlink_metadata(path)?.file_type().is_file(),
        "Carry the line preferences changed while reading"
    );
    Ok(Some(bytes))
}
fn document(bytes: &[u8]) -> Result<Value> {
    let raw: Value = serde_json::from_slice(bytes)?;
    ensure!(
        raw.is_object() && raw["version"] == 1,
        "Unsupported Carry the line preferences"
    );
    Ok(raw)
}
pub fn load(dir: &Path) -> Result<Config> {
    match read_bytes(dir)? {
        None => Ok(Config::default()),
        Some(bytes) => Ok(Config::sanitize(&document(&bytes)?)),
    }
}
struct Pending(PathBuf);
impl Drop for Pending {
    fn drop(&mut self) {
        let _ = fs::remove_file(&self.0);
    }
}
pub fn retain(dir: &Path, config: &Config) -> Result<()> {
    retain_before_publish(dir, config, || Ok(()))
}
fn retain_before_publish(
    dir: &Path,
    config: &Config,
    before_publish: impl FnOnce() -> Result<()>,
) -> Result<()> {
    config.validate()?;
    fs::create_dir_all(dir)?;
    let lock_path = dir.join(".carry-line.lock");
    if let Ok(m) = fs::symlink_metadata(&lock_path) {
        ensure!(m.file_type().is_file(), "Linked Carry preference lease");
    }
    let mut options = OpenOptions::new();
    options.read(true).write(true).create(true).truncate(false);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
        #[cfg(target_os = "macos")]
        options.custom_flags(0x100);
        #[cfg(target_os = "linux")]
        options.custom_flags(0x20000);
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        options.custom_flags(0x00200000);
    }
    let _lease = crate::file_lease::Lease::acquire(options.open(&lock_path)?)?;
    let previous = read_bytes(dir)?;
    let mut raw = previous
        .as_ref()
        .map(|b| document(b))
        .transpose()?
        .unwrap_or(json!({"version":1}));
    raw.as_object_mut()
        .unwrap()
        .extend(serde_json::to_value(config)?.as_object().unwrap().clone());
    let bytes = serde_json::to_vec_pretty(&raw)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Carry the line preferences are too large"
    );
    static SERIAL: AtomicU64 = AtomicU64::new(0);
    let path = dir.join(format!(
        ".carry-line-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut options = OpenOptions::new();
    options.write(true).create_new(true);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options.mode(0o600);
    }
    let mut file = options.open(&path)?;
    let pending = Pending(path);
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    before_publish()?;
    ensure!(
        read_bytes(dir)? == previous,
        "Carry the line preferences changed while saving"
    );
    crate::project_store::replace(&pending.0, &dir.join(NAME))
        .context("Could not save Carry the line preferences")?;
    #[cfg(unix)]
    File::open(dir)?.sync_all()?;
    Ok(())
}
#[cfg(test)]
#[path = "carry_line_tests.rs"]
mod tests;

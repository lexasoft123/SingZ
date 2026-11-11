//! Native display-local window placement. Never reads Electron's global geometry.
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::atomic::{AtomicU64, Ordering},
    time::{Duration, Instant},
};

const FILE_NAME: &str = "window-state-native.json";
const MAX_BYTES: u64 = 16 * 1024;
const SAVE_DELAY: Duration = Duration::from_millis(400);
pub(crate) const DEFAULT_WIDTH: f64 = 1240.;
pub(crate) const DEFAULT_HEIGHT: f64 = 820.;
pub(crate) const MIN_WIDTH: f64 = 940.;
pub(crate) const MIN_HEIGHT: f64 = 600.;

#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct Bounds {
    pub x: f64,
    pub y: f64,
    pub width: f64,
    pub height: f64,
}
impl Bounds {
    fn valid(self) -> bool {
        [self.x, self.y, self.width, self.height]
            .into_iter()
            .all(f64::is_finite)
            && self.width > 0.
            && self.height > 0.
    }
}

/// Visible work area in this display's logical, LOCAL coordinates, including
/// any local top/left inset. The caller converts GPUI display geometry once.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct DisplaySnapshot {
    pub uuid: String,
    pub visible: Bounds,
    pub primary: bool,
}
impl DisplaySnapshot {
    fn valid(&self) -> bool {
        valid_uuid(&self.uuid)
            && self.visible.valid()
            && (self.visible.x + self.visible.width).is_finite()
            && (self.visible.y + self.visible.height).is_finite()
    }
}

/// `normal` is always the last nonmaximized geometry, never maximized bounds.
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct WindowSnapshot {
    pub normal: Bounds,
    #[serde(default)]
    pub display_uuid: Option<String>,
    #[serde(default)]
    pub maximized: bool,
}
impl WindowSnapshot {
    fn valid(&self) -> bool {
        self.normal.valid() && self.display_uuid.as_deref().is_none_or(valid_uuid)
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub(crate) struct ResolvedWindow {
    pub normal: Bounds,
    pub display_uuid: Option<String>,
    pub maximized: bool,
}
fn valid_uuid(uuid: &str) -> bool {
    !uuid.is_empty() && uuid.len() <= 512 && !uuid.chars().any(char::is_control)
}

/// Select the saved display if connected, otherwise the primary (then first
/// usable) display. All clamping remains in that display's local coordinate space.
pub(crate) fn resolve(
    snapshot: Option<&WindowSnapshot>,
    displays: &[DisplaySnapshot],
) -> ResolvedWindow {
    let snapshot = snapshot.filter(|s| s.valid());
    let selected = snapshot
        .and_then(|s| s.display_uuid.as_deref())
        .and_then(|uuid| displays.iter().find(|d| d.valid() && d.uuid == uuid))
        .or_else(|| displays.iter().find(|d| d.valid() && d.primary))
        .or_else(|| displays.iter().find(|d| d.valid()));
    let Some(display) = selected else {
        // No trustworthy screen geometry: let the window factory choose its
        // default display. Do not restore a stale potentially offscreen origin.
        return ResolvedWindow {
            normal: Bounds {
                x: 0.,
                y: 0.,
                width: DEFAULT_WIDTH,
                height: DEFAULT_HEIGHT,
            },
            display_uuid: None,
            maximized: snapshot.is_some_and(|s| s.maximized),
        };
    };
    let area = display.visible;
    let width = snapshot
        .map_or(DEFAULT_WIDTH, |s| s.normal.width)
        .round()
        .max(MIN_WIDTH)
        .min(area.width);
    let height = snapshot
        .map_or(DEFAULT_HEIGHT, |s| s.normal.height)
        .round()
        .max(MIN_HEIGHT)
        .min(area.height);
    // A size-only migration has no native display identity or position.
    let positioned = snapshot.filter(|s| s.display_uuid.is_some());
    let x = positioned
        .map_or(area.x + (area.width - width) / 2., |s| s.normal.x.round())
        .clamp(area.x, area.x + area.width - width);
    let y = positioned
        .map_or(area.y + (area.height - height) / 2., |s| s.normal.y.round())
        .clamp(area.y, area.y + area.height - height);
    ResolvedWindow {
        normal: Bounds {
            x,
            y,
            width,
            height,
        },
        display_uuid: Some(display.uuid.clone()),
        maximized: snapshot.is_some_and(|s| s.maximized),
    }
}

/// Call observe on move/resize/maximize, save_if_due from the caller's debounce
/// callback, and flush on release. Failure never prevents opening/closing a window.
pub(crate) struct StateStore {
    path: PathBuf,
    snapshot: Option<WindowSnapshot>,
    extra: Map<String, Value>,
    due: Option<Instant>,
}
impl StateStore {
    pub(crate) fn load(config: &Path) -> Self {
        let path = config.join(FILE_NAME);
        let loaded = (|| -> Option<(WindowSnapshot, Map<String, Value>)> {
            let mut bytes = vec![];
            File::open(&path)
                .ok()?
                .take(MAX_BYTES + 1)
                .read_to_end(&mut bytes)
                .ok()?;
            if bytes.len() as u64 > MAX_BYTES {
                return None;
            }
            let mut raw: Map<String, Value> = serde_json::from_slice(&bytes).ok()?;
            if raw.get("version").and_then(Value::as_u64) != Some(1) {
                return None;
            }
            let snapshot: WindowSnapshot =
                serde_json::from_value(Value::Object(raw.clone())).ok()?;
            if !snapshot.valid() {
                return None;
            }
            for name in ["version", "normal", "display_uuid", "maximized"] {
                raw.remove(name);
            }
            Some((snapshot, raw))
        })();
        let (snapshot, extra) = match loaded {
            Some((snapshot, extra)) => (Some(snapshot), extra),
            None => (None, Map::new()),
        };
        Self {
            path,
            snapshot,
            extra,
            due: None,
        }
    }
    pub(crate) fn resolve(&self, displays: &[DisplaySnapshot]) -> ResolvedWindow {
        resolve(self.snapshot.as_ref(), displays)
    }
    pub(crate) fn observe(&mut self, mut snapshot: WindowSnapshot, now: Instant) {
        // Maximization notifications can include maximized frame bounds. Preserve
        // the prior normal rectangle instead of persisting the maximized frame.
        // The current display must follow a maximized cross-monitor move.
        if snapshot.maximized {
            if let Some(previous) = self.snapshot.as_ref().filter(|s| s.display_uuid.is_some()) {
                snapshot.normal = previous.normal;
            }
        }
        if !snapshot.valid() || self.snapshot.as_ref() == Some(&snapshot) {
            return;
        }
        self.snapshot = Some(snapshot);
        self.due = now.checked_add(SAVE_DELAY);
    }
    pub(crate) fn save_if_due(&mut self, now: Instant) -> bool {
        if self.due.is_none_or(|due| now < due) {
            return false;
        }
        self.flush()
    }
    /// Returns true only when pending geometry was successfully committed.
    /// A failed write stays pending so a later debounce/close can retry it.
    pub(crate) fn flush(&mut self) -> bool {
        if self.due.is_none() {
            return false;
        }
        if self.save().is_ok() {
            self.due = None;
            true
        } else {
            false
        }
    }
    fn save(&self) -> anyhow::Result<()> {
        let Some(snapshot) = &self.snapshot else {
            return Ok(());
        };
        let mut raw = self.extra.clone();
        raw.insert("version".into(), Value::from(1));
        let Value::Object(fields) = serde_json::to_value(snapshot)? else {
            unreachable!()
        };
        raw.extend(fields);
        let bytes = serde_json::to_vec(&raw)?;
        anyhow::ensure!(
            bytes.len() as u64 <= MAX_BYTES,
            "Window state exceeds size limit"
        );
        let config = self
            .path
            .parent()
            .ok_or_else(|| anyhow::anyhow!("Missing config directory"))?;
        fs::create_dir_all(config)?;
        static SERIAL: AtomicU64 = AtomicU64::new(0);
        let temporary = config.join(format!(
            ".window-state-native-{}-{}.part",
            std::process::id(),
            SERIAL.fetch_add(1, Ordering::Relaxed)
        ));
        let mut options = OpenOptions::new();
        options.create_new(true).write(true);
        #[cfg(unix)]
        {
            use std::os::unix::fs::OpenOptionsExt;
            options.mode(0o600);
        }
        let mut file = options.open(&temporary)?;
        let result = (|| -> anyhow::Result<()> {
            file.write_all(&bytes)?;
            file.sync_all()?;
            drop(file);
            crate::project_store::replace(&temporary, &self.path)?;
            #[cfg(unix)]
            if let Ok(directory) = File::open(config) {
                let _ = directory.sync_all();
            }
            Ok(())
        })();
        let _ = fs::remove_file(&temporary);
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn display(uuid: &str, width: f64, height: f64, primary: bool) -> DisplaySnapshot {
        DisplaySnapshot {
            uuid: uuid.into(),
            visible: Bounds {
                x: 0.,
                y: 24.,
                width,
                height,
            },
            primary,
        }
    }
    fn snapshot(uuid: &str) -> WindowSnapshot {
        WindowSnapshot {
            normal: Bounds {
                x: 9000.,
                y: -50.,
                width: 800.,
                height: 400.,
            },
            display_uuid: Some(uuid.into()),
            maximized: false,
        }
    }
    #[test]
    fn restores_display_local_bounds_and_clamps_small_work_area() {
        let displays = [
            display("primary", 1600., 1000., true),
            display("other", 800., 500., false),
        ];
        let result = resolve(Some(&snapshot("other")), &displays);
        assert_eq!(result.display_uuid.as_deref(), Some("other"));
        assert_eq!(
            result.normal,
            Bounds {
                x: 0.,
                y: 24.,
                width: 800.,
                height: 500.
            }
        );
        let result = resolve(Some(&snapshot("disconnected")), &displays);
        assert_eq!(result.display_uuid.as_deref(), Some("primary"));
        assert_eq!(
            result.normal,
            Bounds {
                x: 660.,
                y: 24.,
                width: 940.,
                height: 600.
            }
        );
    }
    #[test]
    fn invalid_geometry_defaults_to_center_of_primary_work_area() {
        let mut bad = snapshot("primary");
        bad.normal.x = f64::NAN;
        bad.maximized = true;
        let result = resolve(Some(&bad), &[display("primary", 1600., 1000., true)]);
        assert_eq!(
            result.normal,
            Bounds {
                x: 180.,
                y: 114.,
                width: 1240.,
                height: 820.
            }
        );
        assert!(!result.maximized);
    }
    struct TemporaryConfig(PathBuf);
    impl TemporaryConfig {
        fn new() -> Self {
            static SERIAL: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "singz-native-window-state-{}-{}",
                std::process::id(),
                SERIAL.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
    }
    impl Drop for TemporaryConfig {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn debounce_persists_maximize_and_last_normal_without_reading_electron_state() {
        let config = TemporaryConfig::new();
        fs::write(
            config.0.join("window-state.json"),
            br#"{"width":99,"height":99}"#,
        )
        .unwrap();
        let mut store = StateStore::load(&config.0);
        assert!(store.snapshot.is_none());
        let now = Instant::now();
        let normal = snapshot("primary");
        store.observe(normal.clone(), now);
        assert!(!store.save_if_due(now + Duration::from_millis(399)));
        let mut maximized = snapshot("other");
        maximized.maximized = true;
        maximized.normal.width = 1900.;
        store.observe(maximized, now + Duration::from_millis(100));
        assert!(!store.save_if_due(now + Duration::from_millis(400)));
        assert!(store.save_if_due(now + Duration::from_millis(500)));
        let saved = StateStore::load(&config.0).snapshot.unwrap();
        assert_eq!(saved.normal, normal.normal);
        assert_eq!(saved.display_uuid.as_deref(), Some("other"));
        assert!(saved.maximized);
        assert!(!store.flush());
    }
    #[test]
    fn corrupt_or_oversized_state_defaults_and_unknown_fields_survive_save() {
        let config = TemporaryConfig::new();
        for bytes in [b"{bad".to_vec(), vec![b' '; MAX_BYTES as usize + 1]] {
            fs::write(config.0.join(FILE_NAME), bytes).unwrap();
            assert!(StateStore::load(&config.0).snapshot.is_none());
        }
        let mut raw = serde_json::to_value(snapshot("primary")).unwrap();
        raw["version"] = Value::from(1);
        raw["future"] = serde_json::json!({"theme": "dark"});
        fs::write(config.0.join(FILE_NAME), serde_json::to_vec(&raw).unwrap()).unwrap();
        let mut store = StateStore::load(&config.0);
        let mut next = snapshot("primary");
        next.normal.x = 10.;
        store.observe(next, Instant::now());
        assert!(store.flush());
        let saved: Value =
            serde_json::from_slice(&fs::read(config.0.join(FILE_NAME)).unwrap()).unwrap();
        assert_eq!(saved["future"], raw["future"]);
    }
}

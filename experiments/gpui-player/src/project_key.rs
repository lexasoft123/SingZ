//! Native harmonic-key analysis, independent of whether melody needs tracking.
use crate::integration::Project;
use anyhow::{ensure, Context, Result};
use serde_json::{json, Value};
use std::{
    io::Read,
    path::PathBuf,
    process::{Command, Stdio},
    sync::mpsc,
    thread,
    time::{Duration, Instant, SystemTime},
};
const LIMIT: u64 = 64 * 1024;
const VERSION: u64 = 2;

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Detected {
        pc: u8,
        minor: bool,
    },
    /// A valid completed native answer, distinct from unrequested/failed work.
    NoKey,
}
impl Outcome {
    pub fn saved(&self) -> Option<Value> {
        match self {
            Self::Detected { pc, minor } => {
                Some(json!({"pc":pc,"minor":minor,"detVersion":VERSION}))
            }
            Self::NoKey => None,
        }
    }
}
pub fn stored_current(raw: &Value) -> bool {
    raw["pc"].as_u64().is_some_and(|pc| pc < 12)
        && raw["minor"].is_boolean()
        && raw["detVersion"]
            .as_f64()
            .is_some_and(|v| v.is_finite() && v >= VERSION as f64)
}
fn harmonic(project: &Project, slot: usize, path: &std::path::Path) -> bool {
    (2..=5).contains(&slot)
        && project.lane_specs.iter().any(|lane| {
            lane.slot == slot
                && lane.file == path
                && !lane.custom
                && lane.id == crate::integration::STEMS[slot]
        })
}
pub fn needed(project: &Project) -> bool {
    let raw = &project.raw["settings"]["key"];
    !stored_current(raw)
        // An unknown future format is preserved even when this reader cannot
        // display it. Analysis must never downgrade its detector stamp.
        && !raw["detVersion"].as_f64().is_some_and(|v| v.is_finite() && v > VERSION as f64)
        && project.lanes.iter().any(|(slot, path)| harmonic(project, *slot, path))
}
#[derive(Clone, Debug)]
struct Source {
    slot: usize,
    path: PathBuf,
    stamp: (u64, SystemTime),
}
pub(crate) struct Inputs {
    sources: Vec<Source>,
}
impl Inputs {
    pub(crate) fn capture(project: &Project) -> Result<Self> {
        ensure!(
            project.lanes.len() == project.lane_stamps.len(),
            "Missing loaded harmonic source stamps"
        );
        let mut sources = Vec::new();
        for ((slot, path), loaded) in project.lanes.iter().zip(&project.lane_stamps) {
            if harmonic(project, *slot, path) {
                ensure!(
                    crate::project_analysis::stamp(path)? == *loaded,
                    "Harmonic source changed after project loading"
                );
                ensure!(
                    !sources.iter().any(|s: &Source| s.slot == *slot),
                    "Duplicate harmonic role"
                );
                sources.push(Source {
                    slot: *slot,
                    path: path.clone(),
                    stamp: *loaded,
                });
            }
        }
        ensure!(
            !sources.is_empty() && sources.len() <= 4,
            "No builtin harmonic sources"
        );
        Ok(Self { sources })
    }
    pub(crate) fn check(&self, cancel: &impl Fn() -> bool) -> Result<()> {
        ensure!(!cancel(), "Key analysis superseded");
        for source in &self.sources {
            ensure!(
                crate::project_analysis::stamp(&source.path)? == source.stamp,
                "Harmonic source changed during analysis"
            );
        }
        Ok(())
    }
}
fn parse(bytes: &[u8]) -> Result<Outcome> {
    // Standalone `key` produces exactly one JSON document. Do not accidentally
    // treat analyze's independent JSON-line melody/key records as one object.
    let raw: Value = serde_json::from_slice(bytes)?;
    ensure!(
        raw["detVersion"].as_u64() == Some(VERSION),
        "Unsupported native key detector version"
    );
    let key = raw.get("key").context("Missing native key result")?;
    if key.is_null() {
        return Ok(Outcome::NoKey);
    }
    let pc = key["pc"]
        .as_u64()
        .filter(|pc| *pc < 12)
        .context("Invalid native key pitch class")?;
    let minor = key["minor"].as_bool().context("Invalid native key mode")?;
    Ok(Outcome::Detected {
        pc: pc as u8,
        minor,
    })
}
fn command(mut command: Command, cancel: &impl Fn() -> bool) -> Result<Vec<u8>> {
    command
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    ensure!(!cancel(), "Key analysis superseded");
    let mut child = command
        .spawn()
        .context("Cannot start native harmonic analysis")?;
    let stdout = child.stdout.take().context("Missing native key output")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = Vec::new();
        let result = stdout
            .take(LIMIT + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(180);
    let result = (|| -> Result<Vec<u8>> {
        loop {
            ensure!(!cancel(), "Key analysis superseded");
            if let Some(status) = child.try_wait()? {
                ensure!(
                    status.success(),
                    "Native harmonic analysis failed ({status})"
                );
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "Native harmonic analysis timed out"
            );
            thread::sleep(Duration::from_millis(20));
        }
        let bytes = rx
            .recv_timeout(Duration::from_secs(2))
            .context("Missing native harmonic result")??;
        ensure!(
            bytes.len() <= LIMIT as usize,
            "Native harmonic result exceeds limit"
        );
        ensure!(!cancel(), "Key analysis superseded");
        Ok(bytes)
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}
pub(crate) fn run(inputs: &Inputs, cancel: &impl Fn() -> bool) -> Result<Outcome> {
    inputs.check(cancel)?;
    let executable = crate::analyze_provenance::resolve()?;
    let helper = std::env::var_os("SINGZ_GPUI_AUDIO_HELPER")
        .map(PathBuf::from)
        .unwrap_or(std::env::current_exe()?.with_file_name(if cfg!(windows) {
            "singz-gpui-audio.exe"
        } else {
            "singz-gpui-audio"
        }));
    let mut audible = [true; 6];
    // Match source admission: guitar/piano placeholders below RMS .004 are
    // omitted, while bass and other remain harmonic detector candidates.
    for source in inputs
        .sources
        .iter()
        .filter(|source| matches!(source.slot, 3 | 4))
    {
        let mut measure = Command::new(&helper);
        measure.arg("--measure-input").arg(&source.path);
        let bytes = command(measure, cancel)?;
        let mut records = bytes
            .split(|b| *b == b'\n')
            .filter(|line| !line.iter().all(u8::is_ascii_whitespace));
        let mut last = None;
        for line in &mut records {
            last = Some(serde_json::from_slice::<Value>(line)?);
        }
        let raw = last.context("Missing harmonic RMS measurement")?;
        ensure!(
            raw["protocol"] == 1 && raw["ok"] == true,
            "Native harmonic measurement refused"
        );
        let rms = raw["rms"].as_f64().context("Missing harmonic RMS")?;
        ensure!(rms.is_finite() && rms >= 0., "Invalid harmonic RMS");
        audible[source.slot] = rms >= 0.004;
        inputs.check(cancel)?;
    }
    let mut detect = Command::new(executable);
    detect.arg("key");
    let mut admitted = 0;
    for source in &inputs.sources {
        if audible[source.slot] {
            detect
                .arg(if source.slot == 2 { "--bass" } else { "--inst" })
                .arg(&source.path);
            admitted += 1;
        }
    }
    if admitted == 0 {
        inputs.check(cancel)?;
        return Ok(Outcome::NoKey);
    }
    let bytes = command(detect, cancel)?;
    inputs.check(cancel)?;
    parse(&bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    struct Fixture(PathBuf);
    impl Fixture {
        fn new(roles: &[&str]) -> Self {
            use std::sync::atomic::{AtomicU64, Ordering};
            static NEXT: AtomicU64 = AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "singz-project-key-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, Ordering::Relaxed)
            ));
            std::fs::create_dir(&path).unwrap();
            std::fs::create_dir(path.join("stems")).unwrap();
            for role in roles {
                std::fs::write(
                    path.join(format!("stems/{role}.wav")),
                    b"fixture; metadata reader does not decode",
                )
                .unwrap();
            }
            std::fs::write(path.join("project.json"), br#"{"version":2,"settings":{}}"#).unwrap();
            Self(path)
        }
        fn project(&self) -> Project {
            crate::integration::read_project(&self.0).unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = std::fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn key_need_is_independent_of_current_or_future_melody_and_allows_harmonic_only() {
        let fixture = Fixture::new(&["vocals", "bass"]);
        let mut project = fixture.project();
        for melody_version in [4, 8] {
            let pitch = std::sync::Arc::make_mut(&mut project.pitch);
            pitch.det_version = melody_version;
            pitch.f0 = vec![110.];
            assert!(!crate::project_analysis::melody_needed(&project));
            assert!(crate::project_analysis::needed(&project));
            project.raw["settings"]["key"] = json!({"pc":0,"minor":false,"detVersion":2});
            assert!(!crate::project_analysis::needed(&project));
            project.raw["settings"]["key"] = json!({"pc":0,"minor":false,"detVersion":1});
            assert!(crate::project_analysis::needed(&project));
            project.raw["settings"]["key"] = Value::Null;
        }
        let harmonic_only = Fixture::new(&["bass"]);
        let mut project = harmonic_only.project();
        assert!(needed(&project));
        assert!(!crate::project_analysis::melody_needed(&project));
        assert_eq!(Inputs::capture(&project).unwrap().sources.len(), 1);
        project.raw["settings"]["key"] = json!({"futureShape":true,"detVersion":3});
        assert!(
            !needed(&project),
            "Unknown future stamps must not be overwritten"
        );
    }
    #[test]
    fn captures_only_builtin_harmonics_and_rejects_changed_loaded_input() {
        let fixture = Fixture::new(&["vocals", "drums", "bass", "guitar", "piano", "other"]);
        let mut project = fixture.project();
        // Slot five original/full-mix is not the builtin 'other' role.
        let other = project
            .lanes
            .iter()
            .find(|(slot, _)| *slot == 5)
            .unwrap()
            .1
            .clone();
        *project
            .lane_specs
            .iter_mut()
            .find(|lane| lane.slot == 5)
            .unwrap() = crate::tracks::Lane::original(other);
        // Likewise a custom lane cannot claim a harmonic role through its slot.
        project
            .lane_specs
            .iter_mut()
            .find(|lane| lane.slot == 3)
            .unwrap()
            .custom = true;
        let inputs = Inputs::capture(&project).unwrap();
        assert_eq!(
            inputs.sources.iter().map(|s| s.slot).collect::<Vec<_>>(),
            vec![2, 4]
        );
        inputs.check(&|| false).unwrap();
        assert!(inputs.check(&|| true).is_err());
        std::fs::write(&inputs.sources[0].path, b"changed-length harmonic input").unwrap();
        assert!(inputs.check(&|| false).is_err());
        assert!(Inputs::capture(&project).is_err());
    }
    #[test]
    fn native_null_is_completed_but_never_saved_as_v2_detection() {
        let outcome = parse(br#"{"detVersion":2,"key":null}"#).unwrap();
        assert_eq!(outcome, Outcome::NoKey);
        assert!(outcome.saved().is_none());
        let answer = parse(br#"{"detVersion":2,"key":{"pc":8,"minor":true}}"#).unwrap();
        assert_eq!(
            answer.saved().unwrap(),
            json!({"pc":8,"minor":true,"detVersion":2})
        );
        for raw in [
            br#"{"detVersion":2}"#.as_slice(),
            br#"{"detVersion":3,"key":null}"#,
            br#"{"detVersion":2,"key":{"pc":12,"minor":true}}"#,
            br#"{"detVersion":2,"key":{"pc":1,"minor":0}}"#,
            b"{\"detVersion\":2,\"key\":null}\n{\"key\":null}",
        ] {
            assert!(parse(raw).is_err());
        }
    }
    #[test]
    fn stored_key_freshness_preserves_future_stamps_but_requires_strict_shape() {
        assert!(stored_current(
            &json!({"pc":3,"minor":false,"detVersion":2})
        ));
        assert!(stored_current(&json!({"pc":3,"minor":true,"detVersion":8})));
        for raw in [
            json!({"pc":3,"minor":false,"detVersion":1}),
            json!({"pc":3,"minor":0,"detVersion":2}),
            json!({"pc":12,"minor":false,"detVersion":2}),
            json!({"pc":3,"minor":false}),
        ] {
            assert!(!stored_current(&raw));
        }
    }
}

//! Cancellable source-rate vocal energy. The shared native decoder owns PCM;
//! this worker validates its bounded envelope result and loaded-source identity.
use anyhow::{Context, Result, ensure};
use serde_json::Value;
use std::{
    io::Read,
    path::{Path, PathBuf},
    process::{Child, Command, Stdio},
    sync::{
        Arc, Mutex,
        atomic::{AtomicBool, Ordering},
    },
    thread,
    time::{Duration, Instant, SystemTime},
};
const LIMIT: usize = 16 * 1024 * 1024;

#[derive(Clone, Debug)]
pub struct Envelopes {
    pub coarse: Arc<crate::lyrics_edit::VocalEnvelope>,
    pub fine: Arc<crate::lyrics_edit::VocalEnvelope>,
    pub sample_rate: u32,
    pub channels: u32,
    pub frames: u64,
    pub source: PathBuf,
    pub stamp: (u64, SystemTime),
}
fn stamp(path: &Path) -> Result<(u64, SystemTime)> {
    let meta = std::fs::metadata(path)?;
    ensure!(
        meta.is_file(),
        "Vocal envelope source is not an ordinary file"
    );
    Ok((meta.len(), meta.modified()?))
}
struct Running {
    child: Child,
    readers: Vec<thread::JoinHandle<()>>,
}
impl Drop for Running {
    fn drop(&mut self) {
        #[cfg(unix)]
        {
            unsafe extern "C" {
                fn kill(pid: i32, sig: i32) -> i32;
            }
            unsafe {
                kill(-(self.child.id() as i32), 9);
            }
        }
        #[cfg(windows)]
        {
            let _ = Command::new("taskkill")
                .args(["/PID", &self.child.id().to_string(), "/T", "/F"])
                .stdout(Stdio::null())
                .stderr(Stdio::null())
                .status();
        }
        let _ = self.child.kill();
        let _ = self.child.wait();
        for reader in self.readers.drain(..) {
            let _ = reader.join();
        }
    }
}
fn decode(raw: &Value, source: PathBuf, expected: (u64, SystemTime)) -> Result<Envelopes> {
    ensure!(
        raw["protocol"] == 1 && raw["ok"] == true,
        "Native vocal envelope refused"
    );
    let sample_rate = raw["sampleRate"]
        .as_u64()
        .context("Missing vocal sample rate")?;
    let channels = raw["channels"]
        .as_u64()
        .context("Missing vocal channel count")?;
    let frames = raw["frames"]
        .as_u64()
        .context("Missing vocal frame count")?;
    ensure!(
        (8000..=768000).contains(&sample_rate)
            && (1..=64).contains(&channels)
            && frames > 0
            && frames <= sample_rate * 3600,
        "Invalid native vocal envelope inventory"
    );
    let envelope = |key: &str, hop: f64| -> Result<crate::lyrics_edit::VocalEnvelope> {
        let raw = &raw[key];
        ensure!(
            raw["hop"].as_f64() == Some(hop),
            "Invalid vocal envelope hop"
        );
        let values = raw["env"]
            .as_array()
            .context("Missing vocal envelope frames")?;
        let hop_samples = ((sample_rate as f64 * hop + 0.5).floor() as u64).max(1);
        ensure!(
            values.len() as u64 == frames.div_ceil(hop_samples),
            "Vocal envelope coverage differs from source"
        );
        let env = values
            .iter()
            .map(|n| -> Result<f32> {
                let n = n.as_f64().context("Invalid vocal envelope value")?;
                ensure!(
                    n.is_finite() && n >= 0. && (n as f32).is_finite(),
                    "Non-finite vocal envelope value"
                );
                Ok(n as f32)
            })
            .collect::<Result<Vec<_>>>()?;
        Ok(crate::lyrics_edit::VocalEnvelope { hop, env })
    };
    Ok(Envelopes {
        coarse: Arc::new(envelope("coarse", 0.05)?),
        fine: Arc::new(envelope("fine", 0.01)?),
        sample_rate: sample_rate as u32,
        channels: channels as u32,
        frames,
        source,
        stamp: expected,
    })
}

pub fn run(
    source: &Path,
    loaded_stamp: (u64, SystemTime),
    cancel: &impl Fn() -> bool,
) -> Result<Arc<Envelopes>> {
    run_with_helper(
        source,
        loaded_stamp,
        cancel,
        &crate::audio_devices::helper(),
    )
}
fn run_with_helper(
    source: &Path,
    loaded_stamp: (u64, SystemTime),
    cancel: &impl Fn() -> bool,
    helper: &Path,
) -> Result<Arc<Envelopes>> {
    ensure!(!cancel(), "Vocal envelope request superseded");
    let source = source.canonicalize()?;
    ensure!(
        stamp(&source)? == loaded_stamp,
        "Vocal source changed after project loading"
    );
    let mut cmd = Command::new(helper);
    cmd.arg("--vocal-envelope")
        .arg(&source)
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped());
    #[cfg(unix)]
    {
        use std::os::unix::process::CommandExt;
        cmd.process_group(0);
    }
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        cmd.creation_flags(0x08000200);
    }
    let mut child = cmd
        .spawn()
        .context("Cannot start native vocal envelope; rebuild the audio helper")?;
    let stdout = child
        .stdout
        .take()
        .context("Missing vocal envelope stdout")?;
    let stderr = child
        .stderr
        .take()
        .context("Missing vocal envelope stderr")?;
    let bytes = Arc::new(Mutex::new(Vec::new()));
    let errors = Arc::new(Mutex::new(Vec::new()));
    let overflow = Arc::new(AtomicBool::new(false));
    let mut readers = vec![];
    for (mut input, retain) in [
        (Box::new(stdout) as Box<dyn Read + Send>, true),
        (Box::new(stderr) as Box<dyn Read + Send>, false),
    ] {
        let data = if retain {
            bytes.clone()
        } else {
            errors.clone()
        };
        let overflow = overflow.clone();
        readers.push(thread::spawn(move || {
            let mut block = [0u8; 8192];
            loop {
                let n = match input.read(&mut block) {
                    Ok(0) | Err(_) => break,
                    Ok(n) => n,
                };
                let mut data = data.lock().unwrap_or_else(|e| e.into_inner());
                if retain {
                    if data.len() + n > LIMIT {
                        overflow.store(true, Ordering::Release);
                        break;
                    }
                } else {
                    let remove = (data.len() + n).saturating_sub(8192);
                    if remove > 0 {
                        data.drain(..remove);
                    }
                }
                data.extend_from_slice(&block[..n]);
            }
        }));
    }
    let mut running = Running { child, readers };
    let deadline = Instant::now() + Duration::from_secs(120);
    loop {
        ensure!(!cancel(), "Vocal envelope request superseded");
        ensure!(
            !overflow.load(Ordering::Acquire),
            "Native vocal envelope is too large"
        );
        ensure!(Instant::now() < deadline, "Native vocal envelope timed out");
        if let Some(status) = running.child.try_wait()? {
            ensure!(
                status.success(),
                "Native vocal envelope failed ({status}): {}",
                String::from_utf8_lossy(&errors.lock().unwrap_or_else(|e| e.into_inner()))
            );
            break;
        }
        thread::sleep(Duration::from_millis(20));
    }
    // Joining inside the task-owned guard also releases stderr/stdout. Its Drop
    // kills any descendant still retaining a pipe before joining the readers.
    drop(running);
    ensure!(!cancel(), "Vocal envelope request superseded");
    ensure!(
        !overflow.load(Ordering::Acquire),
        "Native vocal envelope is too large"
    );
    ensure!(
        stamp(&source)? == loaded_stamp,
        "Vocal source changed while reading its envelope"
    );
    let bytes = bytes.lock().unwrap_or_else(|e| e.into_inner());
    let raw: Value =
        serde_json::from_slice(&bytes).context("Invalid native vocal envelope JSON")?;
    Ok(Arc::new(decode(&raw, source, loaded_stamp)?))
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    fn valid() -> Value {
        json!({"protocol":1,"ok":true,"sampleRate":8000,"channels":2,"frames":800,
        "coarse":{"hop":0.05,"env":[0.,1.]},"fine":{"hop":0.01,"env":[0.,0.,0.,0.,0.,1.,1.,1.,1.,1.]}})
    }
    #[test]
    fn envelope_boundary_checks_source_inventory_coverage_and_values() {
        let key = (1, SystemTime::UNIX_EPOCH);
        let data = decode(&valid(), PathBuf::from("source"), key).unwrap();
        assert_eq!(data.coarse.env, vec![0., 1.]);
        assert_eq!(data.fine.env.len(), 10);
        assert_eq!(data.stamp, key);
        let mut bad = valid();
        bad["fine"]["env"].as_array_mut().unwrap().pop();
        assert!(decode(&bad, PathBuf::new(), key).is_err());
        let mut bad = valid();
        bad["coarse"]["hop"] = json!(0.051);
        assert!(decode(&bad, PathBuf::new(), key).is_err());
        let mut bad = valid();
        bad["fine"]["env"][0] = json!(-1);
        assert!(decode(&bad, PathBuf::new(), key).is_err());
        let mut bad = valid();
        bad["frames"] = json!(8000u64 * 3600 + 1);
        assert!(decode(&bad, PathBuf::new(), key).is_err());
        let mut bad = valid();
        bad["fine"]["env"][0] = json!(1e100);
        assert!(decode(&bad, PathBuf::new(), key).is_err());
    }
    #[test]
    fn cancelled_request_never_starts_helper_or_accepts_a_missing_source() {
        assert!(
            run(
                Path::new("not-a-source"),
                (0, SystemTime::UNIX_EPOCH),
                &|| true
            )
            .unwrap_err()
            .to_string()
            .contains("superseded")
        );
    }
    #[cfg(unix)]
    #[test]
    fn pending_helper_is_reaped_and_changed_source_cannot_adopt_its_result() {
        use std::{cell::Cell, fs, os::unix::fs::PermissionsExt, sync::atomic::AtomicU64};
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let dir = std::env::temp_dir().join(format!(
            "singz-envelope-job-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&dir).unwrap();
        struct Cleanup(PathBuf);
        impl Drop for Cleanup {
            fn drop(&mut self) {
                let _ = fs::remove_dir_all(&self.0);
            }
        }
        let _cleanup = Cleanup(dir.clone());
        let source = dir.join("source");
        fs::write(&source, b"loaded source").unwrap();
        let expected = stamp(&source).unwrap();
        let helper = dir.join("helper");
        let marker = dir.join("pid");
        let quote = |p: &Path| format!("'{}'", p.to_string_lossy().replace('\'', "'\\''"));
        fs::write(
            &helper,
            format!(
                "#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\nexec sleep 30\n",
                quote(&marker)
            ),
        )
        .unwrap();
        fs::set_permissions(&helper, fs::Permissions::from_mode(0o700)).unwrap();
        // Creating a redirected file precedes printf's write. Wait for the
        // complete newline-terminated PID before cancelling the announced child.
        let announced_pid = || {
            fs::read_to_string(&marker)
                .ok()
                .and_then(|text| text.strip_suffix('\n')?.parse::<i32>().ok())
                .filter(|pid| *pid > 0)
        };
        let seen_pid = Cell::new(None);
        let deadline = Instant::now() + Duration::from_secs(3);
        let error = run_with_helper(
            &source,
            expected,
            &|| {
                if let Some(pid) = announced_pid() {
                    seen_pid.set(Some(pid));
                    true
                } else {
                    Instant::now() >= deadline
                }
            },
            &helper,
        )
        .unwrap_err();
        assert!(error.to_string().contains("superseded"));
        let pid = seen_pid
            .get()
            .expect("Envelope helper did not announce a complete PID within3seconds");
        unsafe extern "C" {
            fn kill(pid: i32, sig: i32) -> i32;
        }
        assert_ne!(
            unsafe { kill(pid, 0) },
            0,
            "Cancelled envelope helper survived its owner"
        );
        fs::remove_file(&marker).unwrap();
        let release = dir.join("release");
        fs::write(&helper,format!("#!/bin/sh\nprintf '%s\\n' \"$$\" > {}\nwhile [ ! -e {} ]; do sleep 0.02; done\nprintf '%s' '{}'\n",quote(&marker),quote(&release),valid())).unwrap();
        let changed = AtomicBool::new(false);
        let deadline = Instant::now() + Duration::from_secs(3);
        let error = run_with_helper(
            &source,
            expected,
            &|| {
                if announced_pid().is_some() && !changed.swap(true, Ordering::AcqRel) {
                    fs::write(&source, b"changed source bytes").unwrap();
                    fs::write(&release, b"go").unwrap();
                }
                Instant::now() >= deadline
            },
            &helper,
        )
        .unwrap_err();
        assert!(error.to_string().contains("changed"));
    }
}

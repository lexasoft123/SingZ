//! Native device inventory and app-owned preferences; no Electron configuration.
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicBool, AtomicU64, Ordering},
        mpsc,
    },
    thread,
    time::{Duration, Instant},
};
#[derive(Clone, Debug)]
pub struct Device {
    pub uid: String,
    pub label: String,
    pub inputs: usize,
    pub outputs: usize,
    pub input_probe_busy: bool,
    pub output_probe_busy: bool,
}
#[derive(Clone, Debug, Default)]
pub struct Inventory {
    pub devices: Vec<Device>,
    pub default_output: String,
    pub default_input: String,
}
impl Inventory {
    pub fn parse(raw: &Value) -> Result<Self> {
        ensure!(
            raw["protocol"] == 1 && raw["ok"] == true,
            "Native audio inventory failed"
        );
        let list = raw["devices"]
            .as_array()
            .context("Missing native device inventory")?;
        ensure!(list.len() <= 1024, "Native device inventory is too large");
        let mut devices = vec![];
        let mut seen = std::collections::HashSet::new();
        for d in list {
            let uid = d["uid"].as_str().context("Missing device UID")?;
            let label = d["label"].as_str().context("Missing device name")?;
            ensure!(
                !uid.is_empty() && uid.len() <= 2000 && !uid.contains('\0') && label.len() <= 4096,
                "Invalid native device"
            );
            ensure!(seen.insert(uid), "Ambiguous native device UID");
            let channels = |name: &str| -> Result<usize> {
                let n = d[name].as_u64().context("Invalid device channel count")?;
                ensure!(n <= 1024, "Too many device channels");
                Ok(n as usize)
            };
            devices.push(Device {
                uid: uid.into(),
                label: label.into(),
                inputs: channels("inputChannels")?,
                outputs: channels("outputChannels")?,
                input_probe_busy: d["inputProbeBusy"].as_bool().unwrap_or(false),
                output_probe_busy: d["outputProbeBusy"].as_bool().unwrap_or(false),
            });
        }
        Ok(Self {
            devices,
            default_output: raw["defaultOutputUid"].as_str().unwrap_or("").into(),
            default_input: raw["defaultInputUid"].as_str().unwrap_or("").into(),
        })
    }
    pub fn output(&self, uid: &str) -> Result<&Device> {
        let uid = if uid.is_empty() {
            &self.default_output
        } else {
            uid
        };
        self.devices
            .iter()
            .find(|d| d.uid == uid && d.outputs > 0)
            .context("Selected native output device is unavailable")
    }
}
// ALSA capabilities are probed by opening an exclusive PCM. The playback helper
// has proven facts that a fresh inventory subprocess cannot discover while that
// PCM is running. Share only those facts inside this application, never persist
// them, and restore them only for an explicitly busy, still-present endpoint.
#[cfg(any(target_os = "linux", test))]
fn retain_linux_capabilities(inventory: &mut Inventory, cache: &mut std::collections::HashMap<String, Device>) {
    cache.retain(|uid, _| inventory.devices.iter().any(|d| &d.uid == uid));
    for device in &mut inventory.devices {
        if let Some(known) = cache.get(&device.uid) {
            if device.input_probe_busy && device.inputs == 0 { device.inputs = known.inputs; }
            if device.output_probe_busy && device.outputs == 0 { device.outputs = known.outputs; }
        }
        cache.insert(device.uid.clone(), device.clone());
    }
    // Restoring a busy direction can make a formerly unique default ambiguous.
    let unique = |input: bool| {
        let mut devices = inventory.devices.iter().filter(|d| if input { d.inputs > 0 } else { d.outputs > 0 });
        let first = devices.next();
        if devices.next().is_none() { first.map(|d| d.uid.clone()).unwrap_or_default() } else { String::new() }
    };
    inventory.default_input = unique(true);
    inventory.default_output = unique(false);
}
#[cfg(target_os = "linux")]
fn capability_cache() -> &'static std::sync::Mutex<std::collections::HashMap<String, Device>> {
    static CACHE: std::sync::OnceLock<std::sync::Mutex<std::collections::HashMap<String, Device>>> = std::sync::OnceLock::new();
    CACHE.get_or_init(Default::default)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SnapshotKind { Current, Retained }

#[cfg(any(target_os = "linux", test))]
fn replay_linux_capabilities(inventory: &Inventory, cache: &mut std::collections::HashMap<String, Device>) {
    let incoming: std::collections::HashSet<_> = inventory.devices.iter().map(|d| d.uid.as_str()).collect();
    for device in &inventory.devices {
        if device.inputs == 0 && device.outputs == 0 { continue; }
        if let Some(known) = cache.get_mut(&device.uid) {
            if known.input_probe_busy && known.inputs == 0 { known.inputs = device.inputs; }
            if known.output_probe_busy && known.outputs == 0 { known.outputs = device.outputs; }
        } else {
            if cache.len() >= 1024 {
                if let Some(old) = cache.keys().find(|uid| !incoming.contains(uid.as_str())).cloned() { cache.remove(&old); }
                else { continue; }
            }
            cache.insert(device.uid.clone(), device.clone());
        }
    }
}
pub(crate) fn remember_native_inventory(reply: &Value, kind: SnapshotKind, is_current: impl Fn() -> bool) -> Result<()> {
    #[cfg(target_os = "linux")]
    if let Some(raw) = reply.get("deviceInventory") {
        let mut inventory = Inventory::parse(raw)?;
        let mut cache=capability_cache().lock().unwrap_or_else(|e| e.into_inner());
        if is_current(){match kind {
            SnapshotKind::Current => retain_linux_capabilities(&mut inventory, &mut cache),
            // A retained helper proves these facts, but its older inventory
            // cannot evict newer endpoints or overwrite newer known counts.
            SnapshotKind::Retained => replay_linux_capabilities(&inventory, &mut cache),
        }}
    }
    #[cfg(not(target_os = "linux"))]
    let _ = (reply,kind,is_current);
    Ok(())
}
pub fn helper() -> PathBuf {
    std::env::var_os("SINGZ_GPUI_AUDIO_HELPER")
        .map(PathBuf::from)
        .unwrap_or_else(|| {
            std::env::current_exe()
                .unwrap_or_default()
                .with_file_name(if cfg!(windows) {
                    "singz-gpui-audio.exe"
                } else {
                    "singz-gpui-audio"
                })
        })
}
pub fn inventory(alive: &Arc<AtomicBool>) -> Result<Inventory> {
    let mut command = Command::new(helper());
    command
        .arg("--devices")
        .stdin(Stdio::null())
        .stdout(Stdio::piped())
        .stderr(Stdio::null());
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x08000000);
    }
    let mut child = command
        .spawn()
        .context("Cannot start native audio inventory")?;
    let stdout = child.stdout.take().context("Missing inventory stdout")?;
    let (tx, rx) = mpsc::sync_channel(1);
    let reader = thread::spawn(move || {
        let mut bytes = vec![];
        let result = stdout
            .take(1024 * 1024 + 1)
            .read_to_end(&mut bytes)
            .map(|_| bytes);
        let _ = tx.send(result);
    });
    let deadline = Instant::now() + Duration::from_secs(10);
    let result = (|| -> Result<Inventory> {
        loop {
            ensure!(alive.load(Ordering::Acquire), "Inventory cancelled");
            if let Some(status) = child.try_wait()? {
                ensure!(status.success(), "Native inventory process failed");
                break;
            }
            ensure!(
                Instant::now() < deadline,
                "Native device inventory timed out"
            );
            thread::sleep(Duration::from_millis(20));
        }
        let bytes = rx
            .recv_timeout(Duration::from_secs(2))
            .context("Missing native inventory reply")??;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "Native device inventory reply is too large"
        );
        let inventory = Inventory::parse(&serde_json::from_slice(&bytes)?)?;
        #[cfg(target_os = "linux")]
        let inventory = {
            let mut inventory = inventory;
            retain_linux_capabilities(&mut inventory, &mut capability_cache().lock().unwrap_or_else(|e| e.into_inner()));
            inventory
        };
        Ok(inventory)
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}
pub fn encode_uid(uid: &str) -> String {
    if uid.is_empty() {
        return "default".into();
    }
    uid.as_bytes().iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn directory() -> PathBuf {
    if let Some(path) = std::env::var_os("SINGZ_GPUI_CONFIG_DIR") {
        return path.into();
    }
    let home = PathBuf::from(
        std::env::var_os(if cfg!(windows) { "USERPROFILE" } else { "HOME" }).unwrap_or_default(),
    );
    if cfg!(target_os = "macos") {
        home.join("Library/Application Support/SingZ-GPUI")
    } else if cfg!(windows) {
        std::env::var_os("APPDATA")
            .map(PathBuf::from)
            .unwrap_or(home.join("AppData/Roaming"))
            .join("SingZ-GPUI")
    } else {
        std::env::var_os("XDG_CONFIG_HOME")
            .map(PathBuf::from)
            .unwrap_or(home.join(".config"))
            .join("singz-gpui")
    }
}
pub fn load() -> Result<Value> {
    load_at(&directory())
}
fn load_at(dir: &Path) -> Result<Value> {
    let path = dir.join("audio.json");
    let mut bytes = vec![];
    match File::open(path) {
        Ok(file) => {
            file.take(65537).read_to_end(&mut bytes)?;
            ensure!(bytes.len() <= 65536, "Audio preferences are too large");
            let raw: Value = serde_json::from_slice(&bytes)?;
            ensure!(raw.is_object(), "Invalid audio preferences");
            let _ = output_uid(&raw)?;
            Ok(raw)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({})),
        Err(e) => Err(e.into()),
    }
}
pub fn output_uid(raw: &Value) -> Result<String> {
    match raw.get("outputUid") {
        None | Some(Value::Null) => Ok(String::new()),
        Some(v) => {
            let uid = v.as_str().context("Invalid saved output device")?;
            ensure!(
                uid.len() <= 2000 && !uid.contains('\0'),
                "Invalid saved output device"
            );
            Ok(uid.into())
        }
    }
}
static SERIAL: AtomicU64 = AtomicU64::new(1);
pub fn save(uid: &str) -> Result<Value> {
    save_at(&directory(), uid)
}
fn save_at(dir: &Path, uid: &str) -> Result<Value> {
    ensure!(
        uid.len() <= 2000 && !uid.contains('\0'),
        "Invalid output device"
    );
    patch_at(dir, json!({"outputUid":uid}))
}
pub fn save_input(prefs: &crate::microphone::Prefs) -> Result<Value> {
    let _ = crate::microphone::Prefs::read(&prefs.patch())?;
    patch_at(&directory(), prefs.patch())
}
pub fn karaoke(raw: &Value) -> bool {
    raw.get("karaoke").and_then(Value::as_bool).unwrap_or(false)
}
pub fn save_karaoke(enabled: bool) -> Result<Value> {
    save_karaoke_at(&directory(), enabled)
}
pub(crate) fn save_karaoke_at(directory: &Path, enabled: bool) -> Result<Value> {
    patch_at(directory, json!({"karaoke":enabled}))
}
fn patch_at(dir: &Path, patch: Value) -> Result<Value> {
    fs::create_dir_all(dir)?;
    let lock = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(".audio.lock"))?;
    lock.try_lock()
        .context("Audio preferences are being changed by another app")?;
    let mut raw = load_at(dir)?;
    for (key, value) in patch
        .as_object()
        .context("Invalid audio preference update")?
    {
        raw[key] = value.clone();
    }
    let temp = dir.join(format!(
        ".audio-{}-{}.part",
        std::process::id(),
        SERIAL.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = OpenOptions::new()
        .create_new(true)
        .write(true)
        .open(&temp)?;
    let result = (|| -> Result<()> {
        file.write_all(&serde_json::to_vec_pretty(&raw)?)?;
        file.sync_all()?;
        crate::project_store::replace(&temp, &dir.join("audio.json"))?;
        if let Ok(dir) = File::open(dir) {
            let _ = dir.sync_all();
        }
        Ok(())
    })();
    let _ = fs::remove_file(temp);
    result?;
    Ok(raw)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn karaoke_preference_defaults_off_and_patches_without_losing_audio_choices() {
        assert!(!karaoke(&json!({})));
        assert!(!karaoke(&json!({"karaoke":"1"})));
        let dir=std::env::temp_dir().join(format!("singz-karaoke-prefs-{}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("audio.json"),br#"{"outputUid":"keep","inputUid":"mic","future":{"token":7}}"#).unwrap();
        patch_at(&dir,json!({"karaoke":true})).unwrap();
        let reopened=load_at(&dir).unwrap();
        assert!(karaoke(&reopened));
        assert_eq!(reopened["outputUid"],"keep");assert_eq!(reopened["inputUid"],"mic");
        assert_eq!(reopened["future"]["token"],7);
        save_at(&dir,"new output").unwrap();
        assert!(karaoke(&load_at(&dir).unwrap()));
        patch_at(&dir,json!({"karaoke":false})).unwrap();
        assert!(!karaoke(&load_at(&dir).unwrap()));
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn saved_output_preserves_preferences_and_rejects_corrupt_data() {
        let dir = std::env::temp_dir().join(format!("singz-audio-prefs-{}", std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(
            dir.join("audio.json"),
            r#"{"future":{"large":123456789012345678901234567890},"inputUid":"keep"}"#,
        )
        .unwrap();
        let saved = save_at(&dir, "Output with spaces —").unwrap();
        assert_eq!(load_at(&dir).unwrap(), saved);
        assert_eq!(saved["inputUid"], "keep");
        assert!(
            saved["future"]["large"]
                .to_string()
                .contains("123456789012345678901234567890")
        );
        fs::write(dir.join("audio.json"), b"broken").unwrap();
        assert!(save_at(&dir, "").is_err());
        assert_eq!(fs::read(dir.join("audio.json")).unwrap(), b"broken");
        fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn native_inventory_preserves_opaque_uids_and_checks_direction() {
        let raw = json!({"protocol":1,"ok":true,"defaultOutputUid":"uid with space —","devices":[{"uid":"uid with space —","label":"Speakers","inputChannels":0,"outputChannels":2},{"uid":"mic","label":"Input","inputChannels":2,"outputChannels":0}]});
        let inventory = Inventory::parse(&raw).unwrap();
        assert_eq!(inventory.output("").unwrap().label, "Speakers");
        assert!(inventory.output("mic").is_err());
        assert!(inventory.output("missing").is_err());
        assert_eq!(encode_uid(" A"), "2041");
        assert_eq!(encode_uid(""), "default");
    }
    #[test]
    fn busy_linux_inventory_uses_proven_facts_without_resurrecting_endpoints() {
        let inventory = |rows: Value| Inventory::parse(&json!({"protocol":1,"ok":true,"devices":rows})).unwrap();
        let endpoint = |uid: &str, inputs: usize, outputs: usize, input_busy: bool, output_busy: bool| json!({
            "uid":uid,"label":"Current kernel label","inputChannels":inputs,"outputChannels":outputs,
            "inputProbeBusy":input_busy,"outputProbeBusy":output_busy});
        let mut cache = std::collections::HashMap::new();
        let mut known = inventory(json!([endpoint("opaque owner UID —",8,2,false,false)]));
        retain_linux_capabilities(&mut known,&mut cache);
        let mut busy = inventory(json!([endpoint("opaque owner UID —",0,0,true,true)]));
        retain_linux_capabilities(&mut busy,&mut cache);
        assert_eq!(busy.devices[0].inputs,8);
        assert_eq!(busy.output("").unwrap().outputs,2);
        let mut ambiguous = inventory(json!([endpoint("opaque owner UID —",0,0,true,true),endpoint("opaque other UID",0,2,false,false)]));
        retain_linux_capabilities(&mut ambiguous,&mut cache);
        assert!(ambiguous.default_output.is_empty());
        assert!(ambiguous.output("").is_err());
        assert_eq!(ambiguous.output("opaque owner UID —").unwrap().outputs,2);
        let mut not_busy = inventory(json!([endpoint("opaque owner UID —",0,0,false,false)]));
        retain_linux_capabilities(&mut not_busy,&mut cache);
        assert!(not_busy.output("opaque owner UID —").is_err());
        let mut removed = inventory(json!([]));
        retain_linux_capabilities(&mut removed,&mut cache);
        assert!(cache.is_empty());
        let mut reconnected_busy = inventory(json!([endpoint("opaque owner UID —",0,0,true,true)]));
        retain_linux_capabilities(&mut reconnected_busy,&mut cache);
        assert!(reconnected_busy.output("opaque owner UID —").is_err());
        assert!(Inventory::parse(&json!({"protocol":1,"ok":true,"devices":[endpoint("duplicate opaque UID",0,2,false,false),endpoint("duplicate opaque UID",0,2,false,false)]})).is_err());
    }
    #[test]
    fn retained_helper_facts_fill_unknown_busy_counts_without_replacing_newer_inventory() {
        let endpoint=|uid:&str,outputs:usize,busy:bool|json!({"uid":uid,"label":uid,"inputChannels":0,"outputChannels":outputs,"outputProbeBusy":busy});
        let inventory=|rows:Value|Inventory::parse(&json!({"protocol":1,"ok":true,"devices":rows})).unwrap();
        let mut fresh=inventory(json!([endpoint("existing",4,false),endpoint("newer endpoint",2,false),endpoint("busy unknown",0,true),endpoint("unsupported",0,false)]));
        let mut cache=std::collections::HashMap::new();retain_linux_capabilities(&mut fresh,&mut cache);
        let retained=inventory(json!([endpoint("existing",8,false),endpoint("busy unknown",8,false),endpoint("unsupported",8,false),endpoint("missing proof",2,false)]));
        replay_linux_capabilities(&retained,&mut cache);
        assert_eq!(cache["existing"].outputs,4);assert_eq!(cache["newer endpoint"].outputs,2);
        assert_eq!(cache["busy unknown"].outputs,8);assert_eq!(cache["unsupported"].outputs,0);assert_eq!(cache["missing proof"].outputs,2);
        let row=cache["existing"].clone();cache.clear();
        for n in 0..1024{let mut row=row.clone();row.uid=format!("older-{n}");cache.insert(row.uid.clone(),row);}
        replay_linux_capabilities(&retained,&mut cache);
        assert_eq!(cache.len(),1024);assert_eq!(cache["busy unknown"].outputs,8);assert_eq!(cache["missing proof"].outputs,2);
    }
}

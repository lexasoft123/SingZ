//! Native device inventory and app-owned preferences; no Electron configuration.
use crate::file_lease::Lease;
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
#[path="audio_provider.rs"]
mod provider;
pub use provider::{Provider,ProviderAvailability,Providers,ProviderSnapshot,windows_provider,restored_provider,validate_output_uid,scoped_output_uid,verify_provider_receipt};

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
    fn role_outputs(&self,playback:bool,windows:bool)->impl Iterator<Item=&Device> {
        self.devices.iter().filter(move |d|d.outputs>0&&(!windows||(d.uid.starts_with("wasapi:")||d.uid.starts_with("asio:"))==playback))
    }
    pub fn playback_outputs(&self)->impl Iterator<Item=&Device> {self.role_outputs(true,cfg!(windows))}
    pub fn monitor_outputs(&self)->impl Iterator<Item=&Device> {self.role_outputs(false,cfg!(windows))}
    pub fn monitor_output(&self,uid:&str)->Result<&Device> {
        if cfg!(windows) {
            // The independently probed WASAPI default is first among RAW
            // monitor rows. ASIO identifiers are never translated to capture.
            self.monitor_outputs().find(|d|uid.is_empty()||d.uid==uid).context("Selected native monitor output device is unavailable")
        } else {self.output(uid)}
    }
    pub fn output(&self, uid: &str) -> Result<&Device> {
        let uid=if uid.is_empty(){&self.default_output}else{uid};
        self.playback_outputs().find(|d|d.uid==uid).context("Selected native output device is unavailable")
    }
}
/// Build roles from separate native probes, preserving opaque backend IDs.
/// Only the actual WASAPI probe contributes input and independent monitor rows.
fn windows_roles(wasapi:&Inventory,playback:Option<&Inventory>)->Result<Inventory> {
    let mut devices:Vec<Device>=vec![];
    for source in &wasapi.devices {
        if source.inputs>0 {let mut d=source.clone();d.outputs=0;devices.push(d);}
    }
    let default_monitor=wasapi.default_output.strip_prefix("wasapi:").unwrap_or("");
    for source in &wasapi.devices {
        if source.outputs==0 {continue;}
        let uid=source.uid.strip_prefix("wasapi:").context("Independent monitor probe returned a non-WASAPI output")?;
        if let Some(d)=devices.iter_mut().find(|d|d.uid==uid){d.outputs=source.outputs;d.output_probe_busy=source.output_probe_busy;}
        else {let mut d=source.clone();d.uid=uid.into();d.inputs=0;devices.push(d);}
    }
    devices.sort_by_key(|d|!(d.outputs>0&&d.uid==default_monitor));
    if let Some(playback)=playback {for source in &playback.devices {if source.outputs>0 {let mut d=source.clone();d.inputs=0;ensure!(!devices.iter().any(|old|old.uid==d.uid),"Ambiguous playback/capture UID");devices.push(d);}}}
    Ok(Inventory{devices,default_input:wasapi.default_input.clone(),default_output:playback.map(|p|p.default_output.clone()).unwrap_or_default()})

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
fn helper_json(alive: &Arc<AtomicBool>,args:&[String]) -> Result<Value> {
    let mut command = Command::new(helper());
    command
        .args(args)
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
    let result = (|| -> Result<Value> {
        let exit_status=loop {
            ensure!(alive.load(Ordering::Acquire), "Inventory cancelled");
            if let Some(status) = child.try_wait()? {
                break status;
            }
            ensure!(
                Instant::now() < deadline,
                "Native device inventory timed out"
            );
            thread::sleep(Duration::from_millis(20));
        };
        let bytes = rx
            .recv_timeout(Duration::from_secs(2))
            .context("Missing native inventory reply")??;
        ensure!(
            bytes.len() <= 1024 * 1024,
            "Native device inventory reply is too large"
        );
        let raw:Value=serde_json::from_slice(&bytes)?;
        ensure!(raw["protocol"]==1&&raw["ok"]==true,"{}",raw["detail"].as_str().or_else(||raw["error"].as_str()).unwrap_or("Native audio query failed"));
        ensure!(exit_status.success(),"Native audio query exited unsuccessfully");
        Ok(raw)
    })();
    if result.is_err() {
        let _ = child.kill();
    }
    let _ = child.wait();
    let _ = reader.join();
    result
}
pub fn providers(alive:&Arc<AtomicBool>)->Result<Providers> {
    Providers::parse(&helper_json(alive,&["--providers".into()])?)
}
pub fn inventory(alive:&Arc<AtomicBool>)->Result<Inventory> {
    let selected=if cfg!(windows){restored_provider(&load()?)?}else{Provider::platform_default()};
    inventory_with_provider(alive,selected)
}
fn native_inventory(alive:&Arc<AtomicBool>,selected:Provider,windows:bool)->Result<Inventory> {
    let mut args=vec![];
    if windows {ensure!(matches!(selected,Provider::Wasapi|Provider::Asio),"Invalid Windows playback provider");args.extend(["--provider".into(),selected.as_str().into()]);}
    args.push("--devices".into());
    let raw=helper_json(alive,&args)?;verify_provider_receipt(&raw,selected)?;
    let inventory=Inventory::parse(&raw)?;
    if windows {validate_output_uid(selected,&inventory.default_output,true)?;for device in &inventory.devices {if device.outputs>0 {validate_output_uid(selected,&device.uid,true)?;}}}
    Ok(inventory)
}
pub fn inventory_with_provider(alive:&Arc<AtomicBool>,selected:Provider)->Result<Inventory> {
    if cfg!(windows) {
        let wasapi=native_inventory(alive,Provider::Wasapi,true)?;
        if selected==Provider::Wasapi {return windows_roles(&wasapi,Some(&wasapi));}
        // Unavailable playback never substitutes WASAPI playback. Independent
        // capture/monitor devices remain actual WASAPI facts.
        let playback=native_inventory(alive,selected,true).ok();
        return windows_roles(&wasapi,playback.as_ref());
    }
    let mut inventory=native_inventory(alive,selected,false)?;
    #[cfg(target_os="linux")]
    retain_linux_capabilities(&mut inventory,&mut capability_cache().lock().unwrap_or_else(|e|e.into_inner()));
    Ok(inventory)
}
pub fn raw_monitor_uid(uid:&str)->String {
    if cfg!(windows) {uid.strip_prefix("wasapi:").unwrap_or(uid).into()}else{uid.into()}
}
/// Holds the preference file lease through publication and any rollback.
/// Its filesystem operations must never run under the UI admission gate.
pub(crate) struct ProviderPreference {
    dir:PathBuf, _lease:Lease, previous:Option<Vec<u8>>, next:Vec<u8>, published:bool,
}
impl ProviderPreference {
    pub(crate) fn prepare(selected:Provider)->Result<Self> {Self::prepare_at(&directory(),selected)}
    fn prepare_at(dir:&Path,selected:Provider)->Result<Self> {
        ensure!(matches!(selected,Provider::Wasapi|Provider::Asio),"Invalid saved Windows audio provider");
        fs::create_dir_all(dir)?;
        let lease_file=OpenOptions::new().create(true).truncate(false).read(true).write(true).open(dir.join(".audio.lock"))?;
        let lease=Lease::acquire(lease_file).context("Audio preferences are being changed by another app")?;
        let previous=match File::open(dir.join("audio.json")){Ok(file)=>{let mut bytes=vec![];file.take(65537).read_to_end(&mut bytes)?;ensure!(bytes.len()<=65536,"Audio preferences are too large");Some(bytes)},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>None,Err(e)=>return Err(e.into())};
        let mut raw=load_at(dir)?;raw["nativeAudioProvider"]=selected.as_str().into();raw["outputUid"]="".into();
        Ok(Self{dir:dir.into(),_lease:lease,previous,next:serde_json::to_vec_pretty(&raw)?,published:false})
    }
    fn write(&self,bytes:&[u8])->Result<()> {
        let temp=self.dir.join(format!(".audio-provider-{}-{}.part",std::process::id(),SERIAL.fetch_add(1,Ordering::Relaxed)));
        let result=(||->Result<()> {let mut file=OpenOptions::new().create_new(true).write(true).open(&temp)?;
            file.write_all(bytes)?;file.sync_all()?;crate::project_store::replace(&temp,&self.dir.join("audio.json"))?;Ok(())})();
        let _=fs::remove_file(temp);result
    }
    fn sync_directory(&self)->Result<()> {
        // Windows replacement uses the existing flushed-file atomic replace
        // contract; ordinary directory File handles cannot be opened there.
        #[cfg(not(windows))]
        File::open(&self.dir)?.sync_all()?;
        Ok(())
    }
    pub(crate) fn publish(&mut self)->Result<()> {
        // An error after replacement still requires rollback under our lease.
        self.published=true;self.write(&self.next)?;self.sync_directory()?;Ok(())
    }
    pub(crate) fn rollback(&mut self)->Result<()> {
        if !self.published{return Ok(());}
        if let Some(previous)=&self.previous {self.write(previous)?;}
        else {match fs::remove_file(self.dir.join("audio.json")){Ok(())=>{},Err(e) if e.kind()==std::io::ErrorKind::NotFound=>{},Err(e)=>return Err(e.into())}}
        self.sync_directory()?;self.published=false;Ok(())
    }
}
pub fn save_provider(selected:Provider)->Result<Value> {save_provider_at(&directory(),selected)}
fn save_provider_at(dir:&Path,selected:Provider)->Result<Value> {
    ensure!(matches!(selected,Provider::Wasapi|Provider::Asio),"Invalid saved Windows audio provider");
    patch_at(dir,json!({"nativeAudioProvider":selected.as_str(),"outputUid":""}))
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
    let lock_file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(dir.join(".audio.lock"))?;
    let _lock = Lease::acquire(lock_file)
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
    #[cfg(unix)]
    #[test]
    fn preference_lease_unlocks_before_a_forked_child_drops_its_descriptor() {
        let dir = std::env::temp_dir().join(format!("singz-audio-lease-fork-{}", std::process::id()));
        let _ = fs::remove_dir_all(&dir);
        fs::create_dir_all(&dir).unwrap();
        fs::write(&dir.join("audio.json"), br#"{"outputUid":"keep"}"#).unwrap();
        let tx = ProviderPreference::prepare_at(&dir, Provider::Asio).unwrap();
        let child = unsafe { libc::fork() };
        assert!(child >= 0, "fork failed: {}", std::io::Error::last_os_error());
        if child == 0 {
            unsafe {
                libc::usleep(200_000);
                libc::_exit(0);
            }
        }
        drop(tx);
        patch_at(&dir, json!({"karaoke":true}))
            .expect("parent must unlock before the forked child exits");
        unsafe { libc::waitpid(child, std::ptr::null_mut(), 0); }
        fs::remove_dir_all(dir).unwrap();
    }

    #[test]
    fn provider_preference_rollback_preserves_exact_bytes_and_retains_file_lease() {
        let dir=std::env::temp_dir().join(format!("singz-provider-transaction-{}",std::process::id()));fs::create_dir_all(&dir).unwrap();
        let original=b"{ \"nativeAudioProvider\": \"wasapi\", \"outputUid\": \"wasapi:kept\", \"inputUid\": \"raw-input\" }\n";
        fs::write(dir.join("audio.json"),original).unwrap();
        let mut tx=ProviderPreference::prepare_at(&dir,Provider::Asio).unwrap();tx.publish().unwrap();
        assert_eq!(load_at(&dir).unwrap()["nativeAudioProvider"],"asio");
        assert!(patch_at(&dir,json!({"karaoke":true})).is_err());
        tx.rollback().unwrap();assert_eq!(fs::read(dir.join("audio.json")).unwrap(),original);
        drop(tx);patch_at(&dir,json!({"karaoke":true})).unwrap();fs::remove_dir_all(dir).unwrap();
    }
    #[test]
    fn windows_capture_and_monitor_roles_only_come_from_the_independent_wasapi_probe() {
        let inventory=|default:&str,input:&str,rows:Value|Inventory::parse(&json!({"protocol":1,"ok":true,"defaultOutputUid":default,"defaultInputUid":input,"devices":rows})).unwrap();
        let row=|uid:&str,inputs:usize,outputs:usize|json!({"uid":uid,"label":uid,"inputChannels":inputs,"outputChannels":outputs});
        let wasapi=inventory("wasapi:default-device","mic",json!([row("other",1,0),row("wasapi:other",0,2),row("mic",2,0),row("wasapi:default-device",0,4)]));
        let asio=inventory("asio:driver-output","asio-input",json!([row("asio-input",8,0),row("asio:driver-output",0,16)]));
        let merged=windows_roles(&wasapi,Some(&asio)).unwrap();
        assert_eq!(merged.default_input,"mic");assert_eq!(merged.default_output,"asio:driver-output");
        assert_eq!(merged.role_outputs(true,true).map(|d|d.uid.as_str()).collect::<Vec<_>>(),vec!["asio:driver-output"]);
        assert_eq!(merged.role_outputs(false,true).map(|d|d.uid.as_str()).collect::<Vec<_>>(),vec!["default-device","other"]);
        assert!(!merged.devices.iter().any(|d|d.uid=="asio-input"));
        let duplex=merged.devices.iter().find(|d|d.uid=="other").unwrap();assert_eq!((duplex.inputs,duplex.outputs),(1,2));
        assert_eq!(merged.devices.iter().map(|d|&d.uid).collect::<std::collections::HashSet<_>>().len(),merged.devices.len());
        let unavailable=windows_roles(&wasapi,None).unwrap();
        assert!(unavailable.default_output.is_empty());assert_eq!(unavailable.role_outputs(true,true).count(),0);
        assert_eq!(unavailable.default_input,"mic");assert_eq!(unavailable.role_outputs(false,true).count(),2);
        let wasapi_playback=windows_roles(&wasapi,Some(&wasapi)).unwrap();
        assert_eq!(wasapi_playback.role_outputs(true,true).count(),2);assert_eq!(wasapi_playback.role_outputs(false,true).count(),2);
    }
    #[test]
    fn provider_commit_preserves_independent_capture_and_unknown_preferences() {
        let dir=std::env::temp_dir().join(format!("singz-provider-prefs-{}",std::process::id()));
        fs::create_dir_all(&dir).unwrap();
        fs::write(dir.join("audio.json"),br#"{"outputUid":"wasapi:speakers","inputUid":"raw-mic","monitorOutputUid":"raw-monitor","karaoke":true,"future":{"value":17}}"#).unwrap();
        let saved=save_provider_at(&dir,Provider::Asio).unwrap();
        assert_eq!(load_at(&dir).unwrap(),saved);
        assert_eq!(saved["nativeAudioProvider"],"asio");assert_eq!(saved["outputUid"],"");
        assert_eq!(saved["inputUid"],"raw-mic");assert_eq!(saved["monitorOutputUid"],"raw-monitor");
        assert_eq!(saved["future"]["value"],17);assert!(karaoke(&saved));
        let before=fs::read(dir.join("audio.json")).unwrap();
        assert!(save_provider_at(&dir,Provider::CoreAudio).is_err());
        assert_eq!(fs::read(dir.join("audio.json")).unwrap(),before);
        fs::remove_dir_all(dir).unwrap();
    }
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
        let uid=if cfg!(windows){"wasapi:uid with space —"}else{"uid with space —"};
        let raw = json!({"protocol":1,"ok":true,"defaultOutputUid":uid,"devices":[{"uid":uid,"label":"Speakers","inputChannels":0,"outputChannels":2},{"uid":"mic","label":"Input","inputChannels":2,"outputChannels":0}]});
        let inventory = Inventory::parse(&raw).unwrap();
        assert_eq!(inventory.default_output,uid);assert_eq!(inventory.output("").unwrap().uid,uid);
        assert_eq!(inventory.output("").unwrap().label, "Speakers");
        assert!(inventory.output("mic").is_err());assert!(inventory.output("missing").is_err());
        assert_eq!(encode_uid(" A"), "2041");assert_eq!(encode_uid(""), "default");
    }
    #[cfg(windows)]
    #[test]
    fn windows_playback_requires_scoped_outputs_while_raw_rows_remain_monitor_facts() {
        let inventory=Inventory::parse(&json!({"protocol":1,"ok":true,"defaultOutputUid":"wasapi:output","devices":[
            {"uid":"output","label":"Independent monitor","inputChannels":0,"outputChannels":2},
            {"uid":"wasapi:output","label":"Playback","inputChannels":0,"outputChannels":2}]})).unwrap();
        assert_eq!(inventory.output("").unwrap().uid,"wasapi:output");
        assert!(inventory.output("output").is_err());
        assert!(inventory.output("asio:output").is_err());
        assert_eq!(inventory.monitor_output("output").unwrap().uid,"output");
    }
    #[test]
    fn busy_linux_inventory_uses_proven_facts_without_resurrecting_endpoints() {
        // Exercise Linux capability retention on every test host.
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
        assert_eq!(busy.default_output,"opaque owner UID —");
        assert_eq!(busy.devices.iter().find(|d|d.uid==busy.default_output).unwrap().outputs,2);
        let mut ambiguous = inventory(json!([endpoint("opaque owner UID —",0,0,true,true),endpoint("opaque other UID",0,2,false,false)]));
        retain_linux_capabilities(&mut ambiguous,&mut cache);
        assert!(ambiguous.default_output.is_empty());
        assert!(!ambiguous.devices.iter().any(|d|d.uid==ambiguous.default_output&&d.outputs>0));
        assert_eq!(ambiguous.devices.iter().find(|d|d.uid=="opaque owner UID —").unwrap().outputs,2);
        let mut not_busy = inventory(json!([endpoint("opaque owner UID —",0,0,false,false)]));
        retain_linux_capabilities(&mut not_busy,&mut cache);
        assert!(!not_busy.devices.iter().any(|d|d.uid=="opaque owner UID —"&&d.outputs>0));
        let mut removed = inventory(json!([]));
        retain_linux_capabilities(&mut removed,&mut cache);
        assert!(cache.is_empty());
        let mut reconnected_busy = inventory(json!([endpoint("opaque owner UID —",0,0,true,true)]));
        retain_linux_capabilities(&mut reconnected_busy,&mut cache);
        assert!(!reconnected_busy.devices.iter().any(|d|d.uid=="opaque owner UID —"&&d.outputs>0));
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

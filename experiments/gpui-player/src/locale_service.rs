//! Worker-owned native language preference. Session picks override launch env,
//! including on a durable-write failure, matching desktop's best-effort settings.
use crate::i18n::{Language, Locale, LocaleState, resolve_locale};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    fs::{self, File, OpenOptions},
    io::{Read, Write},
    path::{Path, PathBuf},
    sync::{
        Arc, Mutex,
        atomic::{AtomicU64, Ordering},
        mpsc::{self, SyncSender},
    },
    thread,
    time::{Duration, Instant},
};
const NAME: &str = "language.json";
const LIMIT: u64 = 64 * 1024;
static NEXT: AtomicU64 = AtomicU64::new(1);
#[derive(Clone, Debug, Default)]
pub struct Snapshot {
    pub loaded: bool,
    pub state: LocaleState,
    pub error: Option<String>,
    pub revision: u64,
    pub pending: bool,
    pub sequence: u64,
}
struct Pick {
    sequence: u64,
    language: Language,
}
pub struct Service {
    requests: Option<SyncSender<Pick>>,
    view: Arc<Mutex<Snapshot>>,
    latest: Arc<AtomicU64>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Service {
    pub fn new(directory: PathBuf) -> Self {
        let env = std::env::var("SINGZ_LANG").ok();
        let hidden = gated_env!("SINGZ_E2E_HIDDEN").as_deref() == Some(std::ffi::OsStr::new("1"))
            || std::env::var("SINGZ_GPUI_BACKGROUND").as_deref() == Ok("1");
        // Hidden restart coverage must exercise the real saved preference,
        // without changing window visibility or the normal binary's policy.
        #[cfg(feature = "ui-tests")]
        let hidden = hidden
            && std::env::var("SINGZ_GPUI_LOCALE_TEST_PERSIST").as_deref() != Ok("1");
        let forced = forced_language(env.as_deref(), hidden);
        Self::start(directory, forced, system_tags)
    }
    fn start(
        directory: PathBuf,
        forced: Option<Language>,
        tags: impl FnOnce() -> Vec<String> + Send + 'static,
    ) -> Self {
        let (requests, received) = mpsc::sync_channel::<Pick>(16);
        let view = Arc::new(Mutex::new(Snapshot::default()));
        let output = view.clone();
        let latest = Arc::new(AtomicU64::new(0));
        let current = latest.clone();
        let worker = thread::spawn(move || {
            let tags = tags();
            let system_locale = resolve_locale(Language::System, &tags);
            let loaded = load(&directory);
            let language =
                forced.unwrap_or_else(|| loaded.as_ref().copied().unwrap_or(Language::System));
            {
                let mut snapshot = output.lock().unwrap_or_else(|e| e.into_inner());
                if current.load(Ordering::Acquire) == 0 {
                    snapshot.loaded = true;
                    snapshot.state = LocaleState {
                        language,
                        locale: resolve_locale(language, &tags),
                        system_locale,
                    };
                    snapshot.error = loaded.err().map(|e| format!("{e:#}"));
                    snapshot.revision += 1;
                }
            }
            while let Ok(pick) = received.recv() {
                {
                    let _admission = output.lock().unwrap_or_else(|e| e.into_inner());
                    if current.load(Ordering::Acquire) != pick.sequence {
                        continue;
                    }
                }
                let result = retain(&directory, pick.language, &|| {
                    current.load(Ordering::Acquire) != pick.sequence
                });
                let mut snapshot = output.lock().unwrap_or_else(|e| e.into_inner());
                // Never publish an older receipt while a newer accepted pick
                // is waiting. The queue and snapshot share this admission lock.
                if current.load(Ordering::Acquire) != pick.sequence {
                    continue;
                }
                snapshot.loaded = true;
                snapshot.pending = false;
                snapshot.sequence = pick.sequence;
                snapshot.state = LocaleState {
                    language: pick.language,
                    locale: resolve_locale(pick.language, &tags),
                    system_locale,
                };
                snapshot.error = result.err().map(|e| {
                    format!("Language changed for this session, but could not be saved: {e:#}")
                });
                snapshot.revision += 1;
            }
        });
        Self {
            requests: Some(requests),
            view,
            latest,
            worker: Some(worker),
        }
    }
    pub fn snapshot(&self) -> Snapshot {
        self.view.lock().unwrap_or_else(|e| e.into_inner()).clone()
    }
    pub fn pick(&self, language: Language) -> Result<u64> {
        let mut snapshot = self.view.lock().unwrap_or_else(|e| e.into_inner());
        let previous = self.latest.load(Ordering::Acquire);
        let sequence = previous
            .checked_add(1)
            .context("Language request identifiers exhausted")?;
        if self
            .requests
            .as_ref()
            .context("Language worker stopped")?
            .try_send(Pick { sequence, language })
            .is_err()
        {
            anyhow::bail!("Language request queue is full");
        }
        self.latest.store(sequence, Ordering::Release);
        snapshot.pending = true;
        snapshot.revision += 1;
        Ok(sequence)
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        drop(self.requests.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
fn forced_language(env: Option<&str>, hidden: bool) -> Option<Language> {
    env.and_then(Language::parse)
        .or_else(|| hidden.then_some(Language::Locale(Locale::En)))
}
struct Document {
    raw: Value,
    bytes: Vec<u8>,
}
fn same(a: &fs::Metadata, b: &fs::Metadata) -> bool {
    let same = a.is_file()
        && b.is_file()
        && !a.file_type().is_symlink()
        && !b.file_type().is_symlink()
        && a.len() == b.len()
        && a.modified().ok() == b.modified().ok();
    #[cfg(unix)]
    {
        use std::os::unix::fs::MetadataExt;
        same && a.dev() == b.dev() && a.ino() == b.ino()
    }
    #[cfg(not(unix))]
    {
        same
    }
}
fn open(path: &Path, write: bool, create_new: bool) -> Result<File> {
    let mut options = OpenOptions::new();
    options
        .read(!create_new)
        .write(write)
        .create_new(create_new);
    #[cfg(unix)]
    {
        use std::os::unix::fs::OpenOptionsExt;
        options
            .mode(0o600)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK);
    }
    Ok(options.open(path)?)
}
fn read(directory: &Path) -> Result<Option<Document>> {
    let path = directory.join(NAME);
    let meta = match fs::symlink_metadata(&path) {
        Ok(meta) => meta,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(None),
        Err(e) => return Err(e.into()),
    };
    ensure!(
        meta.is_file() && !meta.file_type().is_symlink() && meta.len() > 0 && meta.len() <= LIMIT,
        "Language preferences must be an ordinary bounded file"
    );
    let file = open(&path, false, false)?;
    ensure!(
        same(&meta, &file.metadata()?),
        "Language preferences changed while opening"
    );
    let mut bytes = vec![];
    file.take(LIMIT + 1).read_to_end(&mut bytes)?;
    ensure!(
        !bytes.is_empty()
            && bytes.len() as u64 <= LIMIT
            && same(&meta, &fs::symlink_metadata(&path)?),
        "Language preferences changed while reading"
    );
    let raw: Value = serde_json::from_slice(&bytes).context("Invalid language preference JSON")?;
    ensure!(
        raw.is_object() && raw.get("version").is_none_or(|v| v.as_u64() == Some(1)),
        "Unsupported language preferences"
    );
    Ok(Some(Document { raw, bytes }))
}
pub fn load(directory: &Path) -> Result<Language> {
    Ok(read(directory)?
        .and_then(|d| d.raw["language"].as_str().and_then(Language::parse))
        .unwrap_or_default())
}
fn lease(directory: &Path) -> Result<crate::file_lease::Lease> {
    let path = directory.join(".language.lock");
    let file = match open(&path, true, true) {
        Ok(file) => file,
        Err(error)
            if error
                .downcast_ref::<std::io::Error>()
                .is_some_and(|e| e.kind() == std::io::ErrorKind::AlreadyExists) =>
        {
            let meta = fs::symlink_metadata(&path)?;
            ensure!(
                meta.is_file() && !meta.file_type().is_symlink(),
                "Linked or invalid language preference lock"
            );
            let file = open(&path, true, false)?;
            ensure!(
                same(&meta, &file.metadata()?) && same(&meta, &fs::symlink_metadata(&path)?),
                "Language preference lock changed"
            );
            file
        }
        Err(error) => return Err(error),
    };
    crate::file_lease::Lease::acquire(file).context("Language preferences are being updated")
}
fn retain(directory: &Path, language: Language, cancel: &impl Fn() -> bool) -> Result<()> {
    retain_before_publish(directory, language, cancel, || Ok(()))
}
fn retain_before_publish(
    directory: &Path,
    language: Language,
    cancel: &impl Fn() -> bool,
    before: impl FnOnce() -> Result<()>,
) -> Result<()> {
    fs::create_dir_all(directory)?;
    let meta = fs::symlink_metadata(directory)?;
    ensure!(
        meta.is_dir() && !meta.file_type().is_symlink(),
        "Linked language preference directory"
    );
    let deadline = Instant::now() + Duration::from_secs(2);
    let _lease = loop {
        ensure!(!cancel(), "Language choice superseded");
        match lease(directory) {
            Ok(lease) => break lease,
            Err(error) => {
                let busy = error.chain().any(|e| {
                    e.downcast_ref::<std::io::Error>()
                        .is_some_and(|e| e.kind() == std::io::ErrorKind::WouldBlock)
                });
                if !busy || Instant::now() >= deadline {
                    return Err(error);
                }
                thread::sleep(Duration::from_millis(10));
            }
        }
    };
    let existing = read(directory)?;
    let mut raw = existing
        .as_ref()
        .map_or_else(|| json!({"version":1}), |d| d.raw.clone());
    raw["language"] = json!(language);
    let bytes = serde_json::to_vec_pretty(&raw)?;
    ensure!(
        bytes.len() as u64 <= LIMIT,
        "Language preferences exceed bound"
    );
    let path = directory.join(format!(
        ".language-{}-{}.part",
        std::process::id(),
        NEXT.fetch_add(1, Ordering::Relaxed)
    ));
    let mut file = open(&path, true, true)?;
    struct Temp(PathBuf);
    impl Drop for Temp {
        fn drop(&mut self) {
            let _ = fs::remove_file(&self.0);
        }
    }
    let temporary = Temp(path);
    file.write_all(&bytes)?;
    file.sync_all()?;
    drop(file);
    before()?;
    ensure!(!cancel(), "Language choice superseded");
    let current = read(directory)?;
    ensure!(
        current.as_ref().map(|d| &d.bytes) == existing.as_ref().map(|d| &d.bytes),
        "Language preferences changed outside this app"
    );
    if existing.is_some() {
        crate::project_store::replace(&temporary.0, &directory.join(NAME))?;
    } else {
        fs::hard_link(&temporary.0, directory.join(NAME))
            .context("Language preferences appeared during publication")?;
    }
    #[cfg(unix)]
    File::open(directory)?.sync_all()?;
    Ok(())
}
/// Called on the locale worker, never while painting or processing UI input.
pub fn system_tags() -> Vec<String> {
    #[cfg(target_os = "macos")]
    {
        return mac_tags();
    }
    #[cfg(target_os = "windows")]
    {
        return windows_tags();
    }
    #[cfg(not(any(target_os = "macos", target_os = "windows")))]
    {
        let mut tags = vec![];
        if let Ok(value) = std::env::var("LANGUAGE") {
            tags.extend(
                value
                    .split(':')
                    .filter(|s| !s.is_empty())
                    .map(str::to_owned),
            );
        }
        for key in ["LC_ALL", "LC_MESSAGES", "LANG"] {
            if let Ok(value) = std::env::var(key) {
                if !value.is_empty() {
                    tags.push(value);
                    break;
                }
            }
        }
        tags.into_iter()
            .map(|value| {
                value
                    .split(['.', '@'])
                    .next()
                    .unwrap_or_default()
                    .to_owned()
            })
            .collect()
    }
}
#[cfg(target_os = "macos")]
fn mac_tags() -> Vec<String> {
    use std::ffi::{c_char, c_void};
    #[link(name = "CoreFoundation", kind = "framework")]
    unsafe extern "C" {
        fn CFLocaleCopyPreferredLanguages() -> *const c_void;
        fn CFArrayGetCount(array: *const c_void) -> isize;
        fn CFArrayGetValueAtIndex(array: *const c_void, index: isize) -> *const c_void;
        fn CFStringGetCString(
            string: *const c_void,
            buffer: *mut c_char,
            size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(value: *const c_void);
    }
    let mut tags = vec![];
    unsafe {
        let array = CFLocaleCopyPreferredLanguages();
        if array.is_null() {
            return tags;
        }
        for index in 0..CFArrayGetCount(array).clamp(0, 64) {
            let string = CFArrayGetValueAtIndex(array, index);
            let mut buffer = [0u8; 4096];
            if !string.is_null()
                && CFStringGetCString(
                    string,
                    buffer.as_mut_ptr().cast(),
                    buffer.len() as isize,
                    0x08000100,
                ) != 0
            {
                if let Ok(value) = std::ffi::CStr::from_ptr(buffer.as_ptr().cast()).to_str() {
                    tags.push(value.to_owned());
                }
            }
        }
        CFRelease(array);
    }
    tags
}
#[cfg(target_os = "windows")]
fn windows_tags() -> Vec<String> {
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn GetUserPreferredUILanguages(
            flags: u32,
            count: *mut u32,
            buffer: *mut u16,
            size: *mut u32,
        ) -> i32;
        fn GetUserDefaultLocaleName(buffer: *mut u16, size: i32) -> i32;
    }
    let mut tags = vec![];
    unsafe {
        let mut count = 0;
        let mut size = 0;
        if GetUserPreferredUILanguages(8, &mut count, std::ptr::null_mut(), &mut size) != 0
            && size > 0
            && size <= 16384
        {
            let mut buffer = vec![0u16; size as usize];
            if GetUserPreferredUILanguages(8, &mut count, buffer.as_mut_ptr(), &mut size) != 0 {
                for tag in buffer
                    .split(|ch| *ch == 0)
                    .filter(|tag| !tag.is_empty())
                    .take(64)
                {
                    if let Ok(tag) = String::from_utf16(tag) {
                        tags.push(tag);
                    }
                }
            }
        }
        if tags.is_empty() {
            let mut buffer = [0u16; 85];
            let count = GetUserDefaultLocaleName(buffer.as_mut_ptr(), 85);
            if count > 1 {
                if let Ok(tag) = String::from_utf16(&buffer[..count as usize - 1]) {
                    tags.push(tag);
                }
            }
        }
    }
    tags
}
#[cfg(test)]
#[path = "locale_service_tests.rs"]
mod tests;

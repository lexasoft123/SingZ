//! Long-lived helper registration. Keep a registration until, but never past,
//! the operation that reaps its child, preventing PID reuse while registered.
use std::{
    process::{Child, ExitStatus},
    sync::{Mutex, OnceLock},
};

struct Entry {
    id: u32,
    #[cfg(windows)]
    handle: usize,
}
static CHILDREN: OnceLock<Mutex<Vec<Entry>>> = OnceLock::new();
fn children() -> &'static Mutex<Vec<Entry>> {
    CHILDREN.get_or_init(|| Mutex::new(Vec::new()))
}

pub struct Registration {
    id: u32,
}
impl Registration {
    pub fn new(child: &Child) -> std::io::Result<Self> {
        let id = child.id();
        let mut entries = children().lock().unwrap_or_else(|e| e.into_inner());
        #[cfg(windows)]
        let handle = windows::register(child)?;
        entries.push(Entry {
            id,
            #[cfg(windows)]
            handle,
        });
        Ok(Self { id })
    }
    pub fn try_wait(&mut self, child: &mut Child) -> std::io::Result<Option<ExitStatus>> {
        let mut entries = children().lock().unwrap_or_else(|e| e.into_inner());
        let status = child.try_wait()?;
        if status.is_some() {
            remove(&mut entries, self.id);
        }
        Ok(status)
    }
    pub fn wait(&mut self, child: &mut Child) -> std::io::Result<ExitStatus> {
        // Remove before reaping; no recycled PID can remain in the registry.
        let mut entries = children().lock().unwrap_or_else(|e| e.into_inner());
        remove(&mut entries, self.id);
        drop(entries);
        child.wait()
    }
}
fn remove(entries: &mut Vec<Entry>, id: u32) {
    if let Some(index) = entries.iter().position(|e| e.id == id) {
        let entry = entries.swap_remove(index);
        #[cfg(windows)]
        windows::close(entry.handle);
        #[cfg(not(windows))]
        let _ = entry;
    }
}
impl Drop for Registration {
    fn drop(&mut self) {
        remove(
            &mut children().lock().unwrap_or_else(|e| e.into_inner()),
            self.id,
        );
    }
}
/// Best effort in a panic hook: never wait for a possibly poisoned/held mutex.
pub fn kill_all() {
    let entries = match children().try_lock() {
        Ok(entries) => entries,
        Err(std::sync::TryLockError::Poisoned(error)) => error.into_inner(),
        Err(std::sync::TryLockError::WouldBlock) => return,
    };
    for entry in entries.iter() {
        #[cfg(unix)]
        unsafe {
            libc::kill(entry.id as libc::pid_t, libc::SIGKILL);
        }
        #[cfg(windows)]
        windows::kill(entry.handle);
    }
}

#[cfg(windows)]
mod windows {
    use std::{ffi::c_void, os::windows::io::AsRawHandle, process::Child, sync::OnceLock};
    type Handle = *mut c_void;
    #[repr(C)]
    struct Basic {
        per_process: i64,
        per_job: i64,
        limit: u32,
        min: usize,
        max: usize,
        active: u32,
        affinity: usize,
        priority: u32,
        scheduling: u32,
    }
    #[repr(C)]
    struct Io {
        read_ops: u64,
        write_ops: u64,
        other_ops: u64,
        read_bytes: u64,
        write_bytes: u64,
        other_bytes: u64,
    }
    #[repr(C)]
    struct Extended {
        basic: Basic,
        io: Io,
        process_memory: usize,
        job_memory: usize,
        peak_process: usize,
        peak_job: usize,
    }
    #[link(name = "kernel32")]
    unsafe extern "system" {
        fn CreateJobObjectW(attributes: Handle, name: *const u16) -> Handle;
        fn SetInformationJobObject(job: Handle, class: i32, info: *const c_void, len: u32) -> i32;
        fn AssignProcessToJobObject(job: Handle, process: Handle) -> i32;
        fn GetCurrentProcess() -> Handle;
        fn DuplicateHandle(
            source: Handle,
            handle: Handle,
            target: Handle,
            result: *mut Handle,
            access: u32,
            inherit: i32,
            options: u32,
        ) -> i32;
        fn TerminateProcess(process: Handle, exit: u32) -> i32;
        fn CloseHandle(handle: Handle) -> i32;
    }
    static JOB: OnceLock<Result<usize, String>> = OnceLock::new();
    fn job() -> std::io::Result<Handle> {
        let value = JOB.get_or_init(|| unsafe {
            let job = CreateJobObjectW(std::ptr::null_mut(), std::ptr::null());
            if job.is_null() {
                return Err(std::io::Error::last_os_error().to_string());
            }
            let mut info: Extended = std::mem::zeroed();
            info.basic.limit = 0x2000; // JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
            if SetInformationJobObject(
                job,
                9,
                &info as *const _ as _,
                std::mem::size_of::<Extended>() as u32,
            ) == 0
            {
                CloseHandle(job);
                return Err(std::io::Error::last_os_error().to_string());
            }
            Ok(job as usize)
        });
        value
            .as_ref()
            .map(|v| *v as Handle)
            .map_err(|e| std::io::Error::other(e.clone()))
    }
    pub fn register(child: &Child) -> std::io::Result<usize> {
        unsafe {
            let raw = child.as_raw_handle() as Handle;
            let mut copy = std::ptr::null_mut();
            let current = GetCurrentProcess();
            if DuplicateHandle(current, raw, current, &mut copy, 0, 0, 2) == 0 {
                return Err(std::io::Error::last_os_error());
            }
            let job = match job() {
                Ok(job) => job,
                Err(error) => {
                    CloseHandle(copy);
                    return Err(error);
                }
            };
            if AssignProcessToJobObject(job, copy) == 0 {
                CloseHandle(copy);
                return Err(std::io::Error::last_os_error());
            }
            Ok(copy as usize)
        }
    }
    pub fn close(handle: usize) {
        unsafe {
            CloseHandle(handle as Handle);
        }
    }
    pub fn kill(handle: usize) {
        unsafe {
            TerminateProcess(handle as Handle, 1);
        }
    }
}

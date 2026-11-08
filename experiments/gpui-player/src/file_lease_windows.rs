//! Windows leases mirror Unix advisory ownership. Data readers are not locked
//! out; every cooperating writer still acquires the same exclusive lease.
use std::{ffi::c_void, fs::File, io, os::windows::io::AsRawHandle, sync::mpsc, thread};
#[repr(C)]
struct Overlapped {
    internal: usize,
    internal_high: usize,
    offset: u32,
    offset_high: u32,
    event: *mut c_void,
}
fn range() -> Overlapped {
    // One byte beyond any supported application file, still within signed i64.
    Overlapped {
        internal: 0,
        internal_high: 0,
        offset: 0xffff_fffe,
        offset_high: 0x7fff_ffff,
        event: std::ptr::null_mut(),
    }
}
#[repr(C)]
struct Information {
    attributes: u32,
    created: [u32; 2],
    accessed: [u32; 2],
    written: [u32; 2],
    volume: u32,
    size_high: u32,
    size_low: u32,
    links: u32,
    index_high: u32,
    index_low: u32,
}
#[link(name = "kernel32")]
unsafe extern "system" {
    fn LockFileEx(
        handle: *mut c_void,
        flags: u32,
        reserved: u32,
        low: u32,
        high: u32,
        overlap: *mut Overlapped,
    ) -> i32;
    fn UnlockFileEx(
        handle: *mut c_void,
        reserved: u32,
        low: u32,
        high: u32,
        overlap: *mut Overlapped,
    ) -> i32;
    fn GetFileInformationByHandle(handle: *mut c_void, info: *mut Information) -> i32;
    fn CreateMutexW(attributes: *mut c_void, owner: i32, name: *const u16) -> *mut c_void;
    fn WaitForSingleObject(handle: *mut c_void, milliseconds: u32) -> u32;
    fn ReleaseMutex(handle: *mut c_void) -> i32;
    fn CloseHandle(handle: *mut c_void) -> i32;
}
pub enum Lease {
    File(File),
    Movable(Movable),
}
impl Lease {
    pub fn acquire(file: File) -> io::Result<Self> {
        let mut overlap = range();
        if unsafe { LockFileEx(file.as_raw_handle(), 3, 0, 1, 0, &mut overlap) } == 0 {
            let error = io::Error::last_os_error();
            return Err(if error.raw_os_error() == Some(33) {
                io::ErrorKind::WouldBlock.into()
            } else {
                error
            });
        }
        Ok(Self::File(file))
    }
    pub fn movable(file: File) -> io::Result<Self> {
        let mut info: Information = unsafe { std::mem::zeroed() };
        if unsafe { GetFileInformationByHandle(file.as_raw_handle(), &mut info) } == 0 {
            return Err(io::Error::last_os_error());
        }
        let name: Vec<u16> = format!(
            "Global\\SingZ.Native.ProjectWriter.v1.{:08x}.{:08x}{:08x}\0",
            info.volume, info.index_high, info.index_low
        )
        .encode_utf16()
        .collect();
        let (ready_tx, ready_rx) = mpsc::sync_channel(1);
        let (stop_tx, stop_rx) = mpsc::channel::<()>();
        // A Win32 mutex belongs to its acquiring thread. A dedicated owner
        // allows the public guard to move between Rust worker threads safely.
        let worker = thread::Builder::new()
            .name("project-writer-lease".into())
            .spawn(move || {
                let mutex = KernelMutex::acquire(&name);
                drop(file); // Never pin a child handle across the directory move.
                match mutex {
                    Err(error) => {
                        let _ = ready_tx.send(Err(error));
                    }
                    Ok(_mutex) => {
                        if ready_tx.send(Ok(())).is_ok() {
                            let _ = stop_rx.recv();
                        }
                    }
                }
            })?;
        match ready_rx.recv() {
            Ok(Ok(())) => Ok(Self::Movable(Movable {
                stop: Some(stop_tx),
                worker: Some(worker),
            })),
            result => {
                drop(stop_tx);
                let _ = worker.join();
                Err(match result {
                    Ok(Err(error)) => error,
                    _ => io::Error::other("Project writer lease owner stopped"),
                })
            }
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        if let Self::File(file) = self {
            let mut overlap = range();
            unsafe {
                UnlockFileEx(file.as_raw_handle(), 0, 1, 0, &mut overlap);
            }
        }
    }
}
pub struct Movable {
    stop: Option<mpsc::Sender<()>>,
    worker: Option<thread::JoinHandle<()>>,
}
impl Drop for Movable {
    fn drop(&mut self) {
        drop(self.stop.take());
        if let Some(worker) = self.worker.take() {
            let _ = worker.join();
        }
    }
}
struct KernelMutex {
    handle: *mut c_void,
    held: bool,
}
impl KernelMutex {
    fn acquire(name: &[u16]) -> io::Result<Self> {
        let handle = unsafe { CreateMutexW(std::ptr::null_mut(), 0, name.as_ptr()) };
        if handle.is_null() {
            return Err(io::Error::last_os_error());
        }
        let mut mutex = Self {
            handle,
            held: false,
        };
        match unsafe { WaitForSingleObject(handle, 0) } {
            0 | 0x80 => {
                mutex.held = true;
                Ok(mutex)
            } // Acquired, including an abandoned owner.
            258 => Err(io::ErrorKind::WouldBlock.into()),
            _ => Err(io::Error::last_os_error()),
        }
    }
}
impl Drop for KernelMutex {
    fn drop(&mut self) {
        unsafe {
            if self.held {
                ReleaseMutex(self.handle);
            }
            CloseHandle(self.handle);
        }
    }
}

//! OS-level exclusive leases: one for "this install's running app" and one for
//! "an apply/rollback is in progress". Released automatically when the holder
//! exits or dies, so a crash never leaves a stale lock.
use anyhow::{Result, bail};
use std::{
    fs::{File, OpenOptions},
    path::Path,
    time::{Duration, Instant},
};

pub struct Lock {
    _file: File,
}
/// `Ok(None)` when another process holds it.
pub fn try_acquire(path: &Path) -> Result<Option<Lock>> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    #[cfg(unix)]
    {
        use std::os::unix::io::AsRawFd;
        let file = crate::updater_state::no_follow(OpenOptions::new().create(true).truncate(false).read(true).write(true)).open(path)?;
        // SAFETY: the descriptor is valid for the lifetime of `file`.
        let rc = unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) };
        if rc == 0 {
            return Ok(Some(Lock { _file: file }));
        }
        let error = std::io::Error::last_os_error();
        if error.kind() == std::io::ErrorKind::WouldBlock {
            return Ok(None);
        }
        Err(error.into())
    }
    #[cfg(windows)]
    {
        use std::os::windows::fs::OpenOptionsExt;
        // Share mode 0: a second open fails with a sharing violation.
        match crate::updater_state::no_follow(OpenOptions::new().create(true).truncate(false).read(true).write(true).share_mode(0)).open(path) {
            Ok(file) => Ok(Some(Lock { _file: file })),
            Err(error) if error.raw_os_error() == Some(32) || error.raw_os_error() == Some(33) => Ok(None),
            Err(error) => Err(error.into()),
        }
    }
}
pub fn acquire_wait(path: &Path, timeout: Duration) -> Result<Lock> {
    let deadline = Instant::now() + timeout;
    loop {
        if let Some(lock) = try_acquire(path)? {
            return Ok(lock);
        }
        if Instant::now() >= deadline {
            bail!("timed out waiting for {}", path.display());
        }
        std::thread::sleep(Duration::from_millis(100));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn a_second_holder_is_refused_until_the_first_releases() {
        let dir = std::env::temp_dir().join(format!("singz-lock-{}", std::process::id()));
        let path = dir.join("instance.lock");
        let first = try_acquire(&path).unwrap().expect("first holder");
        assert!(try_acquire(&path).unwrap().is_none(), "a second holder must be refused");
        assert!(acquire_wait(&path, Duration::from_millis(300)).is_err());
        drop(first);
        assert!(try_acquire(&path).unwrap().is_some(), "released locks can be taken again");
        std::fs::remove_dir_all(dir).unwrap();
    }
}

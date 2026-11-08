//! Explicit unlock is needed when another thread forks while a lease is held:
//! close-on-exec prevents a permanent leak, but close alone can leave the fork's
//! reference holding flock briefly after the parent's File is dropped.
use std::fs::File;
#[cfg(windows)]
#[path = "file_lease_windows.rs"]
mod windows;
pub struct Lease {
    #[cfg(not(windows))]
    file: File,
    #[cfg(windows)]
    inner: windows::Lease,
}
impl Lease {
    pub fn acquire(file: File) -> std::io::Result<Self> {
        #[cfg(not(windows))]
        {
            file.try_lock()?;
            Ok(Self { file })
        }
        #[cfg(windows)]
        {
            windows::Lease::acquire(file).map(|inner| Self { inner })
        }
    }
    /// Keep a project writer excluded across an atomic directory move. Windows
    /// cannot move a directory while a child file handle remains open.
    pub fn movable(file: File) -> std::io::Result<Self> {
        #[cfg(not(windows))]
        {
            Self::acquire(file)
        }
        #[cfg(windows)]
        {
            windows::Lease::movable(file).map(|inner| Self { inner })
        }
    }
}
impl Drop for Lease {
    fn drop(&mut self) {
        #[cfg(not(windows))]
        let _ = self.file.unlock();
        // The Windows guard owns its exact-range unlock or mutex-owner thread.
    }
}
#[cfg(all(test, unix))]
mod tests {
    use super::*;
    use std::fs::OpenOptions;
    #[test]
    fn drop_unlocks_even_while_a_fork_style_descriptor_reference_survives() {
        let path = std::env::temp_dir().join(format!("singz-lease-{}", std::process::id()));
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create_new(true)
            .open(&path)
            .unwrap();
        let inherited = file.try_clone().unwrap();
        let lease = Lease::acquire(file).unwrap();
        let other = OpenOptions::new()
            .read(true)
            .write(true)
            .open(&path)
            .unwrap();
        assert!(other.try_lock().is_err());
        drop(lease);
        other
            .try_lock()
            .expect("A fork-style reference retained ownership after lease Drop");
        other.unlock().unwrap();
        drop(inherited);
        drop(other);
        std::fs::remove_file(path).unwrap();
    }
}

#[cfg(test)]
mod portable_tests {
    use super::*;
    use std::{
        fs::{self, OpenOptions},
        io::Read,
        path::PathBuf,
    };
    struct Fixture(PathBuf);
    impl Fixture {
        fn new() -> Self {
            static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
            let path = std::env::temp_dir().join(format!(
                "singz-lease-portable-{}-{}",
                std::process::id(),
                NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
            ));
            fs::create_dir(&path).unwrap();
            Self(path)
        }
        fn file(&self) -> File {
            OpenOptions::new()
                .read(true)
                .write(true)
                .create(true)
                .truncate(false)
                .open(self.0.join("writer.lock"))
                .unwrap()
        }
    }
    impl Drop for Fixture {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.0);
        }
    }
    #[test]
    fn advisory_lease_excludes_writers_without_blocking_validation_reads() {
        let f = Fixture::new();
        let path = f.0.join("writer.lock");
        let lease = Lease::acquire(f.file()).unwrap();
        fs::write(&path, b"completed WAV bytes").unwrap();
        let mut bytes = vec![];
        File::open(&path).unwrap().read_to_end(&mut bytes).unwrap();
        assert_eq!(bytes, b"completed WAV bytes");
        assert_eq!(
            Lease::acquire(f.file()).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(lease);
        Lease::acquire(f.file()).unwrap();
    }
    #[test]
    fn movable_lease_survives_directory_rename_and_blocks_the_new_path() {
        let f = Fixture::new();
        let old = f.0.join("old");
        let new = f.0.join("new");
        fs::create_dir(&old).unwrap();
        let path = old.join("writer.lock");
        fs::write(&path, b"").unwrap();
        let open = |path: &std::path::Path| {
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(path)
                .unwrap()
        };
        let lease = Lease::movable(open(&path)).unwrap();
        fs::rename(&old, &new).unwrap();
        assert_eq!(
            Lease::movable(open(&new.join("writer.lock")))
                .err()
                .unwrap()
                .kind(),
            std::io::ErrorKind::WouldBlock
        );
        drop(lease);
        Lease::movable(open(&new.join("writer.lock"))).unwrap();
    }
    #[test]
    fn unrelated_project_files_with_the_same_name_do_not_share_a_movable_lease() {
        let a = Fixture::new();
        let b = Fixture::new();
        let _a = Lease::movable(a.file()).unwrap();
        let _b = Lease::movable(b.file()).unwrap();
    }
    #[test]
    fn movable_lease_child() {
        let Some(path) = std::env::var_os("SINGZ_FILE_LEASE_CHILD_PATH") else {
            return;
        };
        let path = PathBuf::from(path);
        let _lease = Lease::movable(
            OpenOptions::new()
                .read(true)
                .write(true)
                .open(&path)
                .unwrap(),
        )
        .unwrap();
        fs::write(path.with_extension("ready"), b"owned").unwrap();
        std::thread::sleep(std::time::Duration::from_secs(10));
    }
    #[test]
    fn movable_lease_excludes_another_process_and_recovers_after_owner_exit() {
        use std::process::{Command, Stdio};
        let f = Fixture::new();
        drop(f.file());
        let path = f.0.join("writer.lock");
        let mut command = Command::new(std::env::current_exe().unwrap());
        command
            .args(["--exact", "file_lease::portable_tests::movable_lease_child"])
            .env("SINGZ_FILE_LEASE_CHILD_PATH", &path)
            .stdout(Stdio::null())
            .stderr(Stdio::null());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x08000000);
        }
        struct Child(std::process::Child);
        impl Drop for Child {
            fn drop(&mut self) {
                let _ = self.0.kill();
                let _ = self.0.wait();
            }
        }
        let mut child = Child(command.spawn().unwrap());
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(8);
        while !path.with_extension("ready").exists() {
            assert!(
                child.0.try_wait().unwrap().is_none(),
                "Lease child exited before admission"
            );
            assert!(
                std::time::Instant::now() < deadline,
                "Lease child did not acquire ownership"
            );
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(
            Lease::movable(f.file()).err().unwrap().kind(),
            std::io::ErrorKind::WouldBlock
        );
        child.0.kill().unwrap();
        child.0.wait().unwrap();
        Lease::movable(f.file()).expect("Exited owner left the project writer locked");
    }
}

//! Own one audio process until it has been reaped. No supervisor thread or idle timer.
use crate::process_registry::Registration;
use std::{
    io::{self, Write},
    process::{Child, ChildStdin, ChildStdout, Command, Stdio},
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
    thread,
    time::{Duration, Instant},
};

pub(super) const QUIT_BOUND: Duration = Duration::from_millis(750);
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(super) enum Retirement {
    Clean,
    Unclean,
    Killed,
}

pub(super) struct Helper {
    child: Option<Child>,
    input: Option<ChildStdin>,
    registration: Option<Registration>,
    retired: Arc<AtomicU64>,
}
impl Helper {
    pub(super) fn spawn(
        command: &mut Command,
        retired: Arc<AtomicU64>,
    ) -> io::Result<(Self, ChildStdout)> {
        let child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit())
            .spawn()?;
        Self::adopt(child, retired)
    }
    pub(super) fn adopt(
        mut child: Child,
        retired: Arc<AtomicU64>,
    ) -> io::Result<(Self, ChildStdout)> {
        retired.fetch_add(1, Ordering::AcqRel);
        let input = child.stdin.take();
        let output = child.stdout.take();
        // Construct the owner before any fallible registration/pipe validation.
        let mut helper = Self {
            child: Some(child),
            input,
            registration: None,
            retired,
        };
        helper.registration = Some(Registration::new(helper.child.as_ref().unwrap())?);
        let output = output.ok_or_else(|| io::Error::other("Missing native helper pipes"))?;
        if helper.input.is_none() {
            return Err(io::Error::other("Missing native helper pipes"));
        }
        Ok((helper, output))
    }
    pub(super) fn is_live(&self) -> bool {
        self.child.is_some()
    }
    pub(super) fn id(&self) -> io::Result<u32> {
        self.child.as_ref().map(Child::id)
            .ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))
    }
    pub(super) fn kill(&mut self) -> io::Result<()> {
        self.child.as_mut().ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))?.kill()
    }
    pub(super) fn input(&mut self) -> io::Result<&mut ChildStdin> {
        self.input.as_mut().ok_or_else(|| io::Error::from(io::ErrorKind::BrokenPipe))
    }
    fn reaped(&mut self) {
        self.registration.take();
        self.child.take();
        self.retired.fetch_sub(1, Ordering::AcqRel);
    }
    pub(super) fn kill_and_wait(&mut self) -> io::Result<()> {
        self.input.take();
        if let Some(child) = self.child.as_mut() {
            let _ = child.kill();
            if let Some(registration) = self.registration.as_mut() {
                registration.wait(child)?;
            } else {
                child.wait()?;
            }
            self.reaped();
        }
        Ok(())
    }
    pub(super) fn retire(&mut self) -> io::Result<Retirement> {
        if self.child.is_none() {
            return Err(io::Error::from(io::ErrorKind::BrokenPipe));
        }
        let started = Instant::now();
        let written = self
            .input
            .as_mut()
            .is_some_and(|input| writeln!(input, "quit").and_then(|_| input.flush()).is_ok());
        self.input.take(); // EOF also requests cleanup, even if quit could not be written.
        if written {
            loop {
                let status = self
                    .registration
                    .as_mut()
                    .unwrap()
                    .try_wait(self.child.as_mut().unwrap())?;
                if let Some(status) = status {
                    self.reaped();
                    return Ok(if status.success() {
                        Retirement::Clean
                    } else {
                        Retirement::Unclean
                    });
                }
                let remaining = QUIT_BOUND.saturating_sub(started.elapsed());
                if remaining.is_zero() {
                    break;
                }
                thread::sleep(remaining.min(Duration::from_millis(5)));
            }
        }
        self.kill_and_wait()?;
        Ok(Retirement::Killed)
    }
}
impl Drop for Helper {
    fn drop(&mut self) {
        let _ = self.kill_and_wait();
    }
}

//! UI ownership for a take attached to the existing native training microphone.
//! Audio and files remain in the native capture/export workers.
use std::{
    path::PathBuf,
    time::{Duration, Instant},
};

#[derive(Clone, Debug, PartialEq)]
pub struct Take {
    pub id: u64,
    pub path: PathBuf,
    pub filename: String,
    pub seconds: f64,
    pub sample_rate: u32,
    pub recovery: Option<super::recording_recovery::Recovery>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Command {
    pub generation: u64,
    pub take_id: u64,
}
struct Pending {
    command: Command,
    context: String,
    started: Option<Instant>,
    finishing: bool,
    attached: bool,
}
#[derive(Default)]
pub struct Recorder {
    context: Option<String>,
    next: u64,
    pending: Option<Pending>,
    pub take: Option<Take>,
    pub message: Option<String>,
}
impl Recorder {
    #[cfg(feature = "ui-tests")]
    pub fn pending_command(&self) -> Option<Command> {
        self.pending.as_ref().map(|p| p.command)
    }
    pub fn context(&self) -> Option<&str> {
        self.context.as_deref()
    }
    pub fn set_context(&mut self, context: Option<String>) {
        if self.context != context {
            if let Some(pending) = &mut self.pending { pending.attached = false; }
            self.context = context;
            self.take = None;
            self.message = None;
        }
    }
    pub fn begin(&mut self, generation: u64) -> Option<Command> {
        if self.pending.is_some() || generation == 0 {
            return None;
        }
        let context = self.context.clone()?;
        self.next = self.next.checked_add(1)?;
        let command = Command {
            generation,
            take_id: self.next,
        };
        self.pending = Some(Pending {
            command,
            context,
            started: None,
            finishing: false,
            attached: true,
        });
        Some(command)
    }
    pub fn started(&mut self, command: Command, now: Instant) {
        let Some(pending) = self.pending.as_mut().filter(|p| p.command == command) else {
            return;
        };
        if pending.started.is_none() {
            pending.started = Some(now);
        }
        if pending.attached && self.context.as_deref() == Some(&pending.context) {
            self.take = None;
            self.message = Some("Recording microphone audio for up to 30 seconds.".into());
        }
    }
    pub fn finish_if_needed(&mut self, active: bool, now: Instant) -> Option<Command> {
        let pending = self.pending.as_mut()?;
        let detached = !pending.attached || self.context.as_deref() != Some(&pending.context);
        if !pending.finishing
            && (!active
                || detached
                || pending
                    .started
                    .is_some_and(|at| now.saturating_duration_since(at) >= Duration::from_secs(30)))
        {
            pending.finishing = true;
            return Some(pending.command);
        }
        None
    }
    pub fn finish(&mut self) -> Option<Command> {
        let pending = self.pending.as_mut()?;
        if pending.finishing {
            return None;
        }
        pending.finishing = true;
        Some(pending.command)
    }
    pub fn finished(&mut self, command: Command, take: Result<Take, String>) {
        if !self.pending.as_ref().is_some_and(|p| p.command == command) {
            return;
        }
        let pending = self.pending.take().unwrap();
        if !pending.attached || self.context.as_deref() != Some(&pending.context) {
            return;
        }
        match take {
            Ok(take) => {
                self.message = Some(if take.recovery.is_some() {
                    "The recording could not be saved. Its audio is retained. Choose Save training WAV to retry.".into()
                } else { format!(
                    "Saved {} · {:.1} seconds",
                    take.filename, take.seconds
                ) });
                self.take = Some(take);
            }
            Err(error) => self.message = Some(error),
        }
    }
    pub fn finish_queue_failed(&mut self, command: Command, error: String) {
        if let Some(pending) = self.pending.as_mut().filter(|p| p.command == command) {
            pending.finishing = false;
            if pending.attached && self.context.as_deref() == Some(&pending.context) {
                self.message = Some(error);
            }
        }
    }
    pub fn recording(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| p.attached && p.started.is_some() && self.context.as_deref() == Some(&p.context))
    }
    pub fn busy(&self) -> bool {
        self.pending
            .as_ref()
            .is_some_and(|p| p.started.is_none() || p.finishing)
    }
    pub fn can_begin(&self) -> bool {
        self.context.is_some() && self.pending.is_none()
    }
    pub fn export_error(&mut self, context: &str, take_id: u64, error: String) {
        if self.context.as_deref() == Some(context)
            && self.take.as_ref().is_some_and(|t| t.id == take_id)
        {
            self.message = Some(error);
        }
    }
    pub fn exported(&mut self, context: &str, take_id: u64) {
        if self.context.as_deref() == Some(context) {
            if let Some(take) = self.take.as_ref().filter(|t| t.id == take_id) {
                self.message = Some(if take.recovery.is_some() {
                    "Recording recovered and exported.".into()
                } else { format!("Saved {} · {:.1} seconds", take.filename, take.seconds) });
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn take(id: u64) -> Take {
        Take {
            id,
            path: "retained.wav".into(),
            filename: "retained.wav".into(),
            seconds: 1.,
            sample_rate: 48000,
            recovery: None,
        }
    }
    #[test]
    fn navigation_during_start_finishes_once_and_never_attaches_the_old_take() {
        let mut r = Recorder::default();
        r.set_context(Some("first".into()));
        let first = r.begin(7).unwrap();
        r.set_context(Some("second".into()));
        assert_eq!(r.finish_if_needed(true, Instant::now()), Some(first));
        assert!(r.finish().is_none());
        r.finish_queue_failed(first, "Command queue is full".into());
        assert_eq!(r.finish_if_needed(true, Instant::now()), Some(first));
        assert!(r.message.is_none());
        assert!(!r.can_begin());
        r.started(first, Instant::now());
        assert!(r.message.is_none());
        r.finished(first, Ok(take(first.take_id)));
        assert!(r.take.is_none());
        assert!(r.can_begin());
        let second = r.begin(9).unwrap();
        assert_ne!(first.take_id, second.take_id);
        r.finished(first, Err("old failure".into()));
        assert!(r.busy());
        assert!(r.message.is_none());
    }
    #[test]
    fn active_take_has_thirty_second_deadline_and_retains_export_after_finish() {
        let mut r = Recorder::default();
        r.set_context(Some("practice".into()));
        let command = r.begin(4).unwrap();
        let now = Instant::now();
        r.started(command, now);
        assert!(r.recording());
        assert!(!r.busy());
        assert!(
            r.finish_if_needed(true, now + Duration::from_secs(29))
                .is_none()
        );
        assert_eq!(
            r.finish_if_needed(true, now + Duration::from_secs(30)),
            Some(command)
        );
        assert!(r.busy());
        r.finished(command, Ok(take(command.take_id)));
        assert!(r.can_begin());
        assert!(!r.recording());
        r.export_error("other", command.take_id, "stale".into());
        assert!(r.message.as_deref().unwrap().starts_with("Saved "));
        r.export_error(
            "practice",
            command.take_id,
            "Destination unavailable".into(),
        );
        assert_eq!(r.message.as_deref(), Some("Destination unavailable"));
        assert!(r.take.is_some());
    }
    #[test]
    fn returning_to_same_practice_never_reattaches_a_detached_receipt() {
        for success in [false,true] {
            let mut r=Recorder::default();r.set_context(Some("same-practice".into()));
            let command=r.begin(4).unwrap();
            r.set_context(None);r.set_context(Some("same-practice".into()));
            r.started(command,Instant::now());
            assert!(!r.recording());assert!(r.message.is_none());
            assert_eq!(r.finish_if_needed(true,Instant::now()),Some(command));
            r.finish_queue_failed(command,"stale queue failure".into());
            assert!(r.message.is_none());
            r.finished(command,if success {Ok(take(command.take_id))} else {Err("old failure".into())});
            assert!(r.take.is_none());assert!(r.message.is_none());assert!(r.can_begin());
        }
    }
    #[test]
    fn export_completion_clears_only_its_attached_take_error() {
        let mut r = Recorder::default();
        r.set_context(Some("practice".into()));
        let first = r.begin(1).unwrap();
        r.finished(first, Ok(take(first.take_id)));
        r.export_error("practice", first.take_id, "Destination unavailable".into());
        r.exported("other", first.take_id);
        r.exported("practice", first.take_id + 1);
        assert_eq!(r.message.as_deref(), Some("Destination unavailable"));
        r.exported("practice", first.take_id);
        assert!(r.message.as_deref().unwrap().starts_with("Saved "));
        let second = r.begin(2).unwrap();
        r.started(second, Instant::now());
        r.exported("practice", first.take_id);
        assert_eq!(r.message.as_deref(), Some("Recording microphone audio for up to 30 seconds."));
        assert!(r.recording());
    }
    #[test]
    fn inactive_or_failed_capture_releases_pending_without_losing_previous_take() {
        let mut r = Recorder::default();
        assert!(r.begin(1).is_none());
        r.set_context(Some("practice".into()));
        assert!(r.begin(0).is_none());
        let first = r.begin(1).unwrap();
        r.finished(first, Ok(take(first.take_id)));
        let second = r.begin(1).unwrap();
        assert!(r.begin(1).is_none());
        assert_eq!(r.finish_if_needed(false, Instant::now()), Some(second));
        r.finished(second, Err("Microphone unavailable".into()));
        assert_eq!(r.take.as_ref().unwrap().id, first.take_id);
        assert!(r.can_begin());
    }
}

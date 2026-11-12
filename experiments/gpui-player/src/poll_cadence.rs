//! How often the player drains its backend. A paused or idle player has
//! nothing to drain, so the loop runs at `FAST` only while something is moving
//! and drops to `IDLE` once a whole `WINDOW` has passed without activity.
//! Activity is a drained event, a playing or loading player, or a root render
//! (every input that changes what is shown renders the root), which kicks a
//! sleeping loop awake at once instead of waiting out the idle sleep.
use std::sync::Mutex;
use std::time::{Duration, Instant};

pub const FAST: Duration = Duration::from_millis(16);
pub const IDLE: Duration = Duration::from_millis(200);
pub const WINDOW: Duration = Duration::from_millis(1500);

#[derive(Debug)]
pub struct Cadence {
    fast_until: Instant,
}
impl Cadence {
    pub fn new(now: Instant) -> Self {
        Self { fast_until: now + WINDOW }
    }
    /// Something moved: stay at the fast rate for a full window from `now`.
    pub fn activity(&mut self, now: Instant) {
        self.fast_until = self.fast_until.max(now + WINDOW);
    }
    /// How long to sleep before the next poll.
    pub fn wait(&self, now: Instant) -> Duration {
        if now < self.fast_until { FAST } else { IDLE }
    }
}

static KICK: Mutex<Option<async_channel::Sender<()>>> = Mutex::new(None);

/// A fresh wake channel for the poll loop; the last one registered receives
/// kicks.
pub fn channel() -> async_channel::Receiver<()> {
    let (tx, rx) = async_channel::bounded(1);
    *KICK.lock().unwrap_or_else(|e| e.into_inner()) = Some(tx);
    rx
}
/// Wake a sleeping poll loop. Cheap: a full channel already holds a wake.
pub fn kick() {
    if let Some(tx) = KICK.lock().unwrap_or_else(|e| e.into_inner()).as_ref() {
        let _ = tx.try_send(());
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn polls_fast_while_active_and_idles_after_a_quiet_window() {
        let t0 = Instant::now();
        let mut cadence = Cadence::new(t0);
        assert_eq!(cadence.wait(t0), FAST);
        assert_eq!(cadence.wait(t0 + WINDOW - Duration::from_millis(1)), FAST);
        assert_eq!(cadence.wait(t0 + WINDOW), IDLE, "a quiet player must back off");
        assert!(IDLE >= Duration::from_millis(200) && IDLE > FAST * 4);
        // Activity (an event, a kick) restarts the window and never shortens it.
        let later = t0 + Duration::from_secs(60);
        cadence.activity(later);
        assert_eq!(cadence.wait(later + WINDOW - Duration::from_millis(1)), FAST);
        assert_eq!(cadence.wait(later + WINDOW), IDLE);
        cadence.activity(t0);
        assert_eq!(cadence.wait(later + WINDOW), IDLE, "stale activity must not extend the window");
    }
}

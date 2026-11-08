//! Pure clock-driven mirror of the desktop sync scheduler. The worker owns
//! execution, durable ledger cleanup and remark suppression; this type does no IO.
use serde::Serialize;

pub const DEBOUNCE_MS: u64 = 4_000;
pub const MAX_WAIT_MS: u64 = 60_000;
pub const SWEEP_MS: u64 = 30 * 60_000;
pub const CLEAN_SWEEP_MS: u64 = 6 * 3_600_000;
pub const LAUNCH_DELAY_MS: u64 = 8_000;
const BACKOFF_MS: [u64; 6] = [30_000, 60_000, 120_000, 300_000, 900_000, 1_800_000];

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum Phase {
    Off,
    Idle,
    Pending,
    Syncing,
    Retrying,
    Blocked,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize)]
#[serde(rename_all = "lowercase")]
pub enum ErrorKind {
    Auth,
    Offline,
    Transient,
    Config,
    Fatal,
}
#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Status {
    pub phase: Phase,
    pub dirty: i32,
    pub run_at: Option<u64>,
    pub attempt: u32,
    pub last_error: Option<String>,
    pub last_error_kind: Option<ErrorKind>,
    pub last_sync: Option<u64>,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Run {
    pub id: u64,
    pub captured_seq: u64,
}
#[derive(Clone, Debug)]
pub enum Outcome {
    Success {
        warnings: Vec<String>,
        last_sync: Option<u64>,
    },
    Cancelled,
    Failure {
        error: String,
    },
}

pub fn classify_error(error: &str) -> ErrorKind {
    let e = error.to_lowercase();
    if e.contains("not configured") {
        return ErrorKind::Config;
    }
    if e.contains("sign in again") || e.contains("not signed in") {
        return ErrorKind::Auth;
    }
    if [
        "fetch failed",
        "network",
        "enotfound",
        "econnrefused",
        "etimedout",
        "timeout",
        "socket",
    ]
    .iter()
    .any(|s| e.contains(s))
    {
        return ErrorKind::Offline;
    }
    static RETRY: std::sync::OnceLock<regex::Regex> = std::sync::OnceLock::new();
    if e.contains("drive download integrity")
        || e.contains("already running")
        || e.contains("library changed during sync")
        || RETRY
            .get_or_init(|| {
                regex::Regex::new(
                    r"drive (?:api|upload(?: init)?|download(?: http)?) (5\d\d|429|403)",
                )
                .unwrap()
            })
            .is_match(&e)
    {
        ErrorKind::Transient
    } else {
        ErrorKind::Fatal
    }
}
pub fn backoff_ms(attempt: u32, jitter: f64) -> u64 {
    let jitter = if jitter.is_finite() {
        jitter.clamp(0., 1.)
    } else {
        0.5
    };
    (BACKOFF_MS[(attempt as usize).min(BACKOFF_MS.len() - 1)] as f64 * (0.8 + 0.4 * jitter)).round()
        as u64
}

pub struct Scheduler {
    enabled: bool,
    stopped: bool,
    phase: Phase,
    run_at: Option<u64>,
    sweep_at: Option<u64>,
    first_mark_at: Option<u64>,
    current: Option<Run>,
    next_id: u64,
    follow_up: bool,
    seq: u64,
    dirty: i32,
    attempt: u32,
    last_error: Option<String>,
    last_error_kind: Option<ErrorKind>,
    last_sync: Option<u64>,
}
impl Default for Scheduler {
    fn default() -> Self {
        Self::new()
    }
}
impl Scheduler {
    pub fn new() -> Self {
        Self {
            enabled: false,
            stopped: true,
            phase: Phase::Idle,
            run_at: None,
            sweep_at: None,
            first_mark_at: None,
            current: None,
            next_id: 0,
            follow_up: false,
            seq: 0,
            dirty: 0,
            attempt: 0,
            last_error: None,
            last_error_kind: None,
            last_sync: None,
        }
    }
    pub fn owns(&self, run: Run) -> bool {
        self.enabled && !self.stopped && self.current == Some(run)
    }
    pub fn status(&self) -> Status {
        Status {
            phase: if self.enabled { self.phase } else { Phase::Off },
            dirty: self.dirty,
            run_at: self.run_at,
            attempt: self.attempt,
            last_error: self.last_error.clone(),
            last_error_kind: self.last_error_kind,
            last_sync: self.last_sync,
        }
    }
    pub fn start(&mut self, now: u64, enabled: bool, last_sync: Option<u64>) {
        self.stopped = false;
        self.enabled = enabled;
        self.last_sync = last_sync;
        if !enabled {
            self.phase = Phase::Off;
            self.run_at = None;
            self.sweep_at = None;
            return;
        }
        self.arm(now, LAUNCH_DELAY_MS, Phase::Pending);
        self.sweep_at.get_or_insert(now.saturating_add(SWEEP_MS));
    }
    /// Sign-out invalidates completions from the old worker, even after restart.
    pub fn stop(&mut self) {
        self.stopped = true;
        self.enabled = false;
        self.run_at = None;
        self.sweep_at = None;
        self.current = None;
        self.follow_up = false;
        self.first_mark_at = None;
    }
    fn arm(&mut self, now: u64, delay: u64, phase: Phase) {
        if self.stopped || !self.enabled {
            return;
        }
        let at = now.saturating_add(delay);
        if self.phase == phase && self.run_at.is_some_and(|old| at >= old) {
            return;
        }
        self.run_at = Some(at);
        self.phase = phase;
    }
    fn mark(&mut self, now: u64) {
        if self.stopped || !self.enabled {
            return;
        }
        if self.current.is_some() {
            self.follow_up = true;
            return;
        }
        let first = *self.first_mark_at.get_or_insert(now);
        self.arm(
            now,
            DEBOUNCE_MS.min(first.saturating_add(MAX_WAIT_MS).saturating_sub(now)),
            Phase::Pending,
        );
    }
    /// Polling the same snapshot must never create a follow-up. Call after every
    /// durable mutation; finish() installs the post-clear/post-remark baseline.
    pub fn observe_dirty(&mut self, now: u64, seq: u64, count: i32) {
        let changed = seq > self.seq;
        self.seq = seq;
        self.dirty = count;
        if changed && count != 0 {
            self.mark(now);
        }
    }
    pub fn wake(&mut self, now: u64) {
        if matches!(self.phase, Phase::Retrying | Phase::Blocked) {
            self.arm(now, 2_000, Phase::Pending);
        }
    }
    pub fn request_now(&mut self, _now: u64) -> Option<Run> {
        if self.stopped || !self.enabled || self.current.is_some() {
            return None;
        }
        self.run_at = None;
        self.follow_up = false;
        self.phase = Phase::Syncing;
        self.next_id = self.next_id.checked_add(1).expect("sync run ID exhausted");
        let run = Run {
            id: self.next_id,
            captured_seq: self.seq,
        };
        self.current = Some(run);
        Some(run)
    }
    pub fn poll(&mut self, now: u64) -> Option<Run> {
        if self.stopped || !self.enabled {
            return None;
        }
        if self.sweep_at.is_some_and(|at| now >= at) {
            self.sweep_at = Some(now.saturating_add(SWEEP_MS));
            // Literal desktop semantics: blocked is eligible, retrying is not.
            let stale = now.saturating_sub(self.last_sync.unwrap_or(0)) > CLEAN_SWEEP_MS;
            if (self.dirty != 0 || stale) && self.phase != Phase::Retrying && self.current.is_none()
            {
                return self.request_now(now);
            }
        }
        if self.run_at.is_some_and(|at| now >= at) {
            self.request_now(now)
        } else {
            None
        }
    }
    /// The host still cancels and joins its IO worker. Late receipts cannot
    /// clear dirty state or rearm this scheduler after manual cancellation.
    pub fn cancel(&mut self) {
        self.current = None;
        self.run_at = None;
        self.follow_up = false;
        self.first_mark_at = None;
        self.last_error = None;
        self.last_error_kind = None;
        self.phase = if self.enabled {
            Phase::Idle
        } else {
            Phase::Off
        };
    }
    /// A failed local-state read has no trustworthy dirty count or completion.
    /// The worker must validate local state before permitting another run.
    pub fn block_local(&mut self, error: String) {
        self.cancel();
        self.dirty = -1;
        self.last_error = Some(error);
        self.last_error_kind = Some(ErrorKind::Fatal);
        self.phase = Phase::Blocked;
    }
    /// new_marks is measured BEFORE clear(captured) and outside-library remark;
    /// post_seq/count are measured AFTER both, under the service's serialization.
    pub fn finish(
        &mut self,
        id: u64,
        outcome: Outcome,
        now: u64,
        jitter: f64,
        new_marks: bool,
        post_seq: u64,
        post_count: i32,
    ) -> bool {
        if self.stopped || self.current.is_none_or(|r| r.id != id) {
            return false;
        }
        self.current = None;
        self.run_at = None;
        self.seq = post_seq;
        self.dirty = post_count;
        self.first_mark_at = None;
        match outcome {
            Outcome::Cancelled => self.cancel(),
            Outcome::Success {
                warnings,
                last_sync,
            } => {
                self.attempt = 0;
                self.last_error = if warnings.is_empty() {
                    None
                } else {
                    Some(warnings.join(" · "))
                };
                self.last_error_kind = None;
                self.last_sync = last_sync;
                self.phase = Phase::Idle;
                let follow = self.follow_up || new_marks;
                self.follow_up = false;
                if follow {
                    self.mark(now);
                }
            }
            Outcome::Failure { error } => {
                let kind = classify_error(&error);
                self.last_error = Some(error);
                self.last_error_kind = Some(kind);
                self.attempt = self.attempt.saturating_add(1);
                self.follow_up = false;
                match kind {
                    ErrorKind::Auth | ErrorKind::Fatal => self.phase = Phase::Blocked,
                    ErrorKind::Config => self.phase = Phase::Off,
                    ErrorKind::Offline | ErrorKind::Transient => {
                        self.arm(now, backoff_ms(self.attempt - 1, jitter), Phase::Retrying)
                    }
                }
            }
        }
        true
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn enabled() -> Scheduler {
        let mut s = Scheduler::new();
        s.start(100, true, Some(100));
        s
    }
    fn ok() -> Outcome {
        Outcome::Success {
            warnings: vec![],
            last_sync: Some(9_000),
        }
    }
    #[test]
    fn launch_and_burst_never_postpone_earlier_deadline() {
        let mut s = enabled();
        assert_eq!(s.status().run_at, Some(8_100));
        s.observe_dirty(200, 1, 1);
        s.observe_dirty(3_000, 2, 1);
        assert_eq!(s.status().run_at, Some(4_200));
        assert!(s.poll(4_199).is_none());
        assert_eq!(s.poll(4_200).unwrap().captured_seq, 2);
    }
    #[test]
    fn overdue_dirty_deadline_is_capped_without_waiting_another_debounce() {
        let mut s = enabled();
        s.observe_dirty(200, 1, 1);
        s.observe_dirty(60_201, 2, 1);
        assert_eq!(s.status().run_at, Some(4_200));
        assert_eq!(s.poll(60_201).unwrap().captured_seq, 2);
    }
    #[test]
    fn clear_and_outside_remark_do_not_loop_but_actual_midrun_marks_do() {
        let mut s = enabled();
        s.observe_dirty(200, 1, 1);
        let a = s.request_now(300).unwrap();
        assert!(s.request_now(400).is_none());
        assert!(s.finish(a.id, ok(), 500, 0.5, false, 2, 1)); // own outside remark
        s.observe_dirty(600, 2, 1);
        assert_eq!(s.status().phase, Phase::Idle);
        let b = s.request_now(700).unwrap();
        s.observe_dirty(800, 3, 1);
        s.finish(b.id, ok(), 900, 0.5, true, 4, 1);
        assert_eq!(s.status().run_at, Some(4_900));
    }
    #[test]
    fn missed_poll_mark_before_cleanup_still_follows_up() {
        let mut s = enabled();
        let r = s.request_now(200).unwrap();
        s.finish(r.id, ok(), 300, 0.5, true, 9, 1);
        assert_eq!(s.status().run_at, Some(4_300));
    }
    #[test]
    fn cancellation_and_signout_fence_late_receipts() {
        let mut s = enabled();
        let a = s.request_now(200).unwrap();
        s.cancel();
        assert!(!s.finish(a.id, ok(), 300, 0.5, false, 1, 0));
        let b = s.request_now(400).unwrap();
        s.stop();
        s.start(500, true, None);
        let c = s.request_now(600).unwrap();
        assert!(c.id > b.id);
        assert!(!s.finish(b.id, ok(), 700, 0.5, false, 2, 0));
        s.finish(c.id, Outcome::Cancelled, 800, 0.5, true, 3, 1);
        assert_eq!(s.status().phase, Phase::Idle);
        assert_eq!(s.status().run_at, None);
    }
    #[test]
    fn local_failure_revokes_run_without_reusing_its_identity_or_claiming_clean() {
        let mut s = enabled();
        s.observe_dirty(150, 3, 1);
        let old = s.request_now(200).unwrap();
        s.block_local("Unreadable local ledger".into());
        assert!(!s.owns(old));
        assert_eq!(s.status().phase, Phase::Blocked);
        assert_eq!(s.status().dirty, -1);
        assert_eq!(s.status().last_error_kind, Some(ErrorKind::Fatal));
        assert_eq!(s.status().last_sync, Some(100));
        assert!(s.status().run_at.is_none());
        assert!(!s.finish(old.id, ok(), 300, 0.5, false, 3, 0));
        s.cancel(); // The worker has now validated the repaired ledger.
        s.observe_dirty(400, 4, 1);
        let next = s.request_now(500).unwrap();
        assert!(next.id > old.id);
        assert_eq!(next.captured_seq, 4);
        assert!(!s.finish(old.id, ok(), 600, 0.5, false, 3, 0));
        assert!(s.owns(next));
    }
    #[test]
    fn retries_jitter_wake_and_new_mark_reset_failed_cap() {
        let mut s = enabled();
        s.observe_dirty(200, 1, 1);
        let r = s.request_now(70_000).unwrap();
        s.finish(
            r.id,
            Outcome::Failure {
                error: "network down".into(),
            },
            70_001,
            0.,
            false,
            1,
            1,
        );
        assert_eq!(s.status().run_at, Some(94_001));
        assert_eq!(s.status().phase, Phase::Retrying);
        s.observe_dirty(70_002, 2, 1);
        assert_eq!(s.status().run_at, Some(74_002));
        let r = s.request_now(80_000).unwrap();
        s.finish(
            r.id,
            Outcome::Failure {
                error: "Drive API 503".into(),
            },
            80_001,
            1.,
            false,
            2,
            1,
        );
        assert_eq!(s.status().run_at, Some(152_001));
        s.wake(80_002);
        assert_eq!(s.status().run_at, Some(82_002));
        assert_eq!(backoff_ms(99, 0.), 1_440_000);
        assert_eq!(backoff_ms(99, 1.), 2_160_000);
    }
    #[test]
    fn auth_blocked_has_no_retry_timer_but_source_sweep_retries_dirty() {
        let mut s = enabled();
        s.observe_dirty(200, 1, 1);
        let r = s.request_now(300).unwrap();
        s.finish(
            r.id,
            Outcome::Failure {
                error: "Sign in again".into(),
            },
            400,
            0.5,
            false,
            1,
            1,
        );
        assert_eq!(s.status().phase, Phase::Blocked);
        assert_eq!(s.status().run_at, None);
        assert!(s.poll(SWEEP_MS + 100).is_some());
    }
    #[test]
    fn clean_sweep_only_after_six_hours_and_skips_active_or_backoff() {
        let mut s = enabled();
        let r = s.poll(8_100).unwrap();
        s.finish(r.id, ok(), 9_000, 0.5, false, 0, 0);
        for n in 1..=12 {
            assert!(s.poll(100 + n * SWEEP_MS).is_none());
        }
        assert!(s.poll(100 + 13 * SWEEP_MS).is_some());
        assert!(s.poll(100 + 14 * SWEEP_MS).is_none());
    }
    #[test]
    fn exact_error_categories() {
        for (e, k) in [
            ("not configured", ErrorKind::Config),
            ("not signed in", ErrorKind::Auth),
            ("fetch failed", ErrorKind::Offline),
            ("Drive upload init 403", ErrorKind::Transient),
            ("Drive download integrity mismatch", ErrorKind::Transient),
            ("Drive download HTTP 503", ErrorKind::Transient),
            ("Drive download HTTP 429", ErrorKind::Transient),
            ("Drive download HTTP 404", ErrorKind::Fatal),
            ("bad manifest", ErrorKind::Fatal),
        ] {
            assert_eq!(classify_error(e), k);
        }
    }
}

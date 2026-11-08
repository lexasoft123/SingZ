//! Scalar pitch continuity and live target lock from the shared training domain.
//! The caller supplies fresh capture timestamps, never UI animation time.
use anyhow::{Result, ensure};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Waiting,
    Adjust,
    Holding,
    Locked,
}
#[derive(Clone, Copy, Debug)]
pub struct LockView {
    pub state: State,
    pub progress: f64,
    pub progress_ms: f64,
    pub centered: bool,
    pub locked: bool,
    pub median_cents: Option<f64>,
    pub display_midi: Option<f64>,
}
impl Default for LockView {
    fn default() -> Self {
        Self {
            state: State::Waiting,
            progress: 0.,
            progress_ms: 0.,
            centered: false,
            locked: false,
            median_cents: None,
            display_midi: None,
        }
    }
}
pub const HOLD_MS: f64 = 1500.;
pub const MIN_CONFIDENCE: f64 = 0.75;
pub fn pitch_window(value: f64) -> f64 {
    if !value.is_finite() {
        return 10.;
    }
    [5., 10., 15., 20.]
        .into_iter()
        .reduce(|nearest, option| {
            if (option - value).abs() < (nearest - value).abs() {
                option
            } else {
                nearest
            }
        })
        .unwrap()
}
pub struct Lock {
    window: f64,
    readings: Vec<(f64, f64)>,
    last_update: Option<f64>,
    outside_since: Option<f64>,
    progress: f64,
    display: Option<f64>,
    last_voiced: Option<f64>,
}
impl Lock {
    pub fn new(window: f64) -> Self {
        Self {
            window: pitch_window(window),
            readings: vec![],
            last_update: None,
            outside_since: None,
            progress: 0.,
            display: None,
            last_voiced: None,
        }
    }
    pub fn reset(&mut self) {
        *self = Self::new(self.window);
    }
    pub fn set_window(&mut self, window: f64) {
        *self = Self::new(window);
    }
    pub fn update(
        &mut self,
        now: f64,
        midi: Option<f64>,
        confidence: f64,
        target: f64,
        min_confidence: f64,
    ) -> Result<LockView> {
        ensure!(
            now.is_finite()
                && target.is_finite()
                && min_confidence.is_finite()
                && (0.0..=1.).contains(&min_confidence),
            "Invalid pitch lock clock/target/confidence threshold"
        );
        let elapsed = self
            .last_update
            .map_or(0., |last| (now - last).clamp(0., 160.));
        self.last_update = Some(now);
        let voiced = midi.is_some_and(f64::is_finite) && confidence >= min_confidence;
        let cents = if voiced {
            midi.map(|m| (m - target) * 100.)
        } else {
            None
        };
        if let Some(cents) = cents {
            self.last_voiced = Some(now);
            self.readings.push((now, cents));
        }
        self.readings.retain(|(at, _)| *at >= now - 400.);
        let median = if self.readings.len() >= 3 {
            let mut values: Vec<_> = self.readings.iter().map(|(_, cents)| *cents).collect();
            values.sort_by(f64::total_cmp);
            let middle = values.len() / 2;
            Some(if values.len() % 2 == 0 {
                (values[middle - 1] + values[middle]) / 2.
            } else {
                values[middle]
            })
        } else {
            None
        };
        if let Some(median) = median {
            self.display = Some(match self.display {
                Some(old) if (median - old).abs() < 700. => {
                    let smoothing_elapsed = if elapsed == 0. { 80. } else { elapsed };
                    let alpha = 1. - (-smoothing_elapsed / 80.).exp();
                    old + (median - old) * alpha
                }
                _ => median,
            });
        }
        let display_midi = self
            .display
            .filter(|_| self.last_voiced.is_some_and(|last| now - last <= 280.))
            .map(|cents| target + cents / 100.);
        let centered = cents.is_some_and(|cents| cents.abs() <= self.window + 7.)
            && median.is_some_and(|median| median.abs() <= self.window);
        if centered {
            self.outside_since = None;
            self.progress = (self.progress + elapsed).min(HOLD_MS);
        } else {
            let outside = *self.outside_since.get_or_insert(now);
            if now - outside > 420. {
                self.progress = (self.progress - elapsed * 0.25).max(0.);
            }
        }
        let locked = centered && self.progress >= HOLD_MS;
        Ok(LockView {
            state: if locked {
                State::Locked
            } else if centered {
                State::Holding
            } else if voiced {
                State::Adjust
            } else {
                State::Waiting
            },
            progress: self.progress / HOLD_MS,
            progress_ms: self.progress,
            centered,
            locked,
            median_cents: median,
            display_midi,
        })
    }
}
#[derive(Default)]
pub struct Continuity {
    previous_hz: Option<f64>,
    last_accepted: Option<f64>,
    previous_at: Option<f64>,
    candidate: Option<(f64, f64, u32)>,
}
impl Continuity {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn update(
        &mut self,
        at: f64,
        hz: f64,
        confidence: f64,
        min_confidence: f64,
    ) -> Option<f64> {
        if !at.is_finite() {
            self.reset();
            return None;
        }
        if self
            .previous_at
            .is_some_and(|last| at <= last || at - last > 300.)
        {
            self.reset();
        }
        self.previous_at = Some(at);
        if !hz.is_finite() || hz <= 0. || !confidence.is_finite() || confidence < min_confidence {
            self.candidate = None;
            if self.last_accepted.is_some_and(|last| at - last > 300.) {
                self.previous_hz = None;
            }
            return None;
        }
        let jump = self.previous_hz.is_some_and(|previous| {
            (2..=6).any(|harmonic| {
                ((1200. * (hz / previous).log2()).abs() - 1200. * (harmonic as f64).log2()).abs()
                    <= 80.
            })
        });
        if jump {
            match &mut self.candidate {
                Some((candidate, _, frames)) if (1200. * (hz / *candidate).log2()).abs() <= 80. => {
                    *frames = frames.saturating_add(1)
                }
                _ => self.candidate = Some((hz, at, 1)),
            };
            let (_, since, frames) = self.candidate.unwrap();
            if at - since < 180. || frames < 4 {
                return None;
            }
        }
        self.previous_hz = Some(hz);
        self.last_accepted = Some(at);
        self.candidate = None;
        Some(hz)
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn vibrato_margin_and_signal_loss_do_not_fake_a_lock() {
        let mut tracker = Lock::new(10.);
        let mut view = LockView::default();
        for time in (0..=1800).step_by(20) {
            view = tracker
                .update(
                    time as f64,
                    Some(60. + if time % 40 == 0 { 0.04 } else { -0.04 }),
                    0.99,
                    60.,
                    MIN_CONFIDENCE,
                )
                .unwrap();
        }
        assert!(view.locked);
        let lost = tracker
            .update(1820., None, 0., 60., MIN_CONFIDENCE)
            .unwrap();
        assert!(!lost.locked && !lost.centered && lost.progress == 1.);
        tracker.set_window(20.);
        assert_eq!(
            tracker
                .update(0., Some(60.), 0.99, 60., MIN_CONFIDENCE)
                .unwrap()
                .progress,
            0.
        );
        assert_eq!(pitch_window(12.5), 10.);
        assert_eq!(pitch_window(f64::NAN), 10.);
    }
    #[test]
    fn lock_needs_full_hold_and_does_not_fold_octaves() {
        let mut tracker = Lock::new(10.);
        let mut view = LockView::default();
        for time in (0..=1400).step_by(20) {
            view = tracker
                .update(time as f64, Some(60.), 0.95, 60., MIN_CONFIDENCE)
                .unwrap();
            assert!(!view.locked);
        }
        for time in (1420..=1600).step_by(20) {
            view = tracker
                .update(time as f64, Some(60.), 0.95, 60., MIN_CONFIDENCE)
                .unwrap();
        }
        assert!(view.locked);
        tracker.reset();
        for time in (0..=3000).step_by(20) {
            view = tracker
                .update(time as f64, Some(72.), 0.99, 60., MIN_CONFIDENCE)
                .unwrap();
        }
        assert!(!view.locked && view.progress == 0.);
        assert_eq!(view.median_cents, Some(1200.));
    }
    #[test]
    fn short_drift_pauses_then_drains_without_erasing_hold() {
        let mut tracker = Lock::new(10.);
        let mut before = LockView::default();
        for time in (0..=800).step_by(20) {
            before = tracker
                .update(time as f64, Some(60.), 0.95, 60., MIN_CONFIDENCE)
                .unwrap();
        }
        let short = tracker.update(900., None, 0., 60., MIN_CONFIDENCE).unwrap();
        assert_eq!(short.progress_ms, before.progress_ms);
        tracker
            .update(1300., None, 0., 60., MIN_CONFIDENCE)
            .unwrap();
        let long = tracker
            .update(1400., None, 0., 60., MIN_CONFIDENCE)
            .unwrap();
        assert!(long.progress_ms > 0. && long.progress_ms < before.progress_ms);
        assert!(long.display_midi.is_none());
    }
    #[test]
    fn stalled_ticks_cannot_award_seconds_of_progress() {
        let mut tracker = Lock::new(10.);
        for now in [0., 20., 40.] {
            tracker
                .update(now, Some(60.), 1., 60., MIN_CONFIDENCE)
                .unwrap();
        }
        let view = tracker
            .update(5000., Some(60.), 1., 60., MIN_CONFIDENCE)
            .unwrap();
        assert!(!view.locked && view.progress_ms < 200.);
    }
    #[test]
    fn continuity_requires_consecutive_time_and_frames_for_alias_jump() {
        let mut continuity = Continuity::default();
        assert_eq!(continuity.update(0., 220., 1., MIN_CONFIDENCE), Some(220.));
        for time in [20., 80., 140.] {
            assert_eq!(continuity.update(time, 440., 1., MIN_CONFIDENCE), None);
        }
        assert_eq!(
            continuity.update(200., 440., 1., MIN_CONFIDENCE),
            Some(440.)
        );
        assert_eq!(continuity.update(220., 220., 1., MIN_CONFIDENCE), None);
        assert_eq!(continuity.update(240., 220., 0.2, MIN_CONFIDENCE), None);
        assert_eq!(continuity.update(260., 220., 1., MIN_CONFIDENCE), None);
        assert_eq!(
            continuity.update(1000., 880., 1., MIN_CONFIDENCE),
            Some(880.)
        );
    }
}

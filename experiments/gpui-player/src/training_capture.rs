//! Evidence admission boundary for an exclusive training input owner. Repeated
//! UI polls cannot create new capture observations or reuse a previous target.
use super::{
    microphone::{Phase, View},
    training_scoring::Observation,
};
pub const TRAINING_OWNER: u8 = 4;
pub struct Gate {
    generation: u64,
    origin: u64,
    sequence: u64,
    last_host: u64,
    resets: Option<u64>,
}
pub struct Frame {
    pub observation: Observation,
    pub detector_reset: bool,
}
impl Gate {
    pub fn new(generation: u64, response_start_host_ns: u64) -> Self {
        Self {
            generation,
            origin: response_start_host_ns,
            sequence: 0,
            last_host: 0,
            resets: None,
        }
    }
    pub fn ingest(&mut self, view: &View) -> Option<Frame> {
        if self.generation == 0
            || self.origin == 0
            || view.owner != TRAINING_OWNER
            || view.generation != self.generation
            || view.phase != Phase::Live
            || !view.fresh()
            || view.capture_host_ns < self.origin
            || view.capture_host_ns <= self.last_host
            || view.sequence <= self.sequence
        {
            return None;
        }
        // Subtract integer clocks before conversion so long machine uptimes never
        // round nanoseconds through the floating-point UI clock.
        let at = (view.capture_host_ns - self.origin) as f64 / 1_000_000.;
        let frequency = view.frequency as f64;
        let confidence = view.clarity as f64;
        if !frequency.is_finite()
            || frequency < 0.
            || !confidence.is_finite()
            || !(0.0..=1.).contains(&confidence)
        {
            return None;
        }
        let detector_reset = self.resets.is_some_and(|old| old != view.detector_resets);
        self.sequence = view.sequence;
        self.last_host = view.capture_host_ns;
        self.resets = Some(view.detector_resets);
        Some(Frame {
            observation: Observation {
                at,
                frequency,
                midi: super::training_scoring::fractional_midi(frequency),
                confidence,
            },
            detector_reset,
        })
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{Duration, Instant};
    #[test]
    fn only_fresh_current_owner_sequence_and_response_clock_can_enter() {
        let origin = 9_007_199_254_740_993;
        let mut gate = Gate::new(7, origin);
        let mut view = View {
            phase: Phase::Live,
            owner: TRAINING_OWNER,
            generation: 7,
            sequence: 1,
            capture_host_ns: origin + 20_000_000,
            frequency: 440.,
            clarity: 0.95,
            ..Default::default()
        };
        let first = gate.ingest(&view).unwrap();
        assert_eq!(first.observation.at, 20.);
        assert_eq!(first.observation.midi, Some(69.));
        assert!(!first.detector_reset);
        assert!(gate.ingest(&view).is_none());
        view.sequence = 2;
        view.capture_host_ns += 20_000_000;
        view.owner = 2;
        assert!(gate.ingest(&view).is_none());
        view.owner = TRAINING_OWNER;
        view.generation = 6;
        assert!(gate.ingest(&view).is_none());
        view.generation = 7;
        view.sampled_at = Instant::now() - Duration::from_secs(1);
        assert!(gate.ingest(&view).is_none());
        view.sampled_at = Instant::now();
        view.capture_host_ns = origin - 1;
        assert!(gate.ingest(&view).is_none());
        view.capture_host_ns = origin + 40_000_000;
        view.detector_resets = 1;
        assert!(gate.ingest(&view).unwrap().detector_reset);
    }
    #[test]
    fn physical_monitoring_and_unknown_clocks_never_score() {
        let mut gate = Gate::new(1, 100);
        let mut view = View {
            phase: Phase::Monitoring,
            owner: TRAINING_OWNER,
            generation: 1,
            sequence: 1,
            capture_host_ns: 200,
            frequency: 440.,
            clarity: 0.95,
            ..Default::default()
        };
        assert!(gate.ingest(&view).is_none());
        view.phase = Phase::Live;
        view.capture_host_ns = 0;
        assert!(gate.ingest(&view).is_none());
    }
}

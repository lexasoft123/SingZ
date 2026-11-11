//! Presentation-only clock for the source's modal-open RAF suspension. Native
//! playback and accepted transport positions continue independently.
#[derive(Default)]
pub(crate) struct Clock {
    frozen: Option<(u64, f64)>,
    last_painted: Option<(u64, f64)>,
}
impl Clock {
    pub fn is_open(&self) -> bool {
        self.frozen.is_some()
    }
    pub fn observe(&mut self, open: bool, epoch: u64, actual: f64) {
        if !open {
            self.frozen = None;
        } else if !self.frozen.is_some_and(|(old, _)| old == epoch) {
            self.frozen = Some(
                self.last_painted
                    .filter(|(old, _)| *old == epoch)
                    .unwrap_or((epoch, actual)),
            );
        }
    }
    pub fn position(&self, epoch: u64, actual: f64) -> f64 {
        self.frozen
            .filter(|(old, _)| *old == epoch)
            .map_or(actual, |(_, position)| position)
    }
    pub fn painted(&mut self, epoch: u64, actual: f64) {
        if self.frozen.is_none() {
            self.last_painted = Some((epoch, actual));
        }
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn resizing_or_typing_keeps_last_painted_clock_without_rewinding_actual_playback() {
        let mut clock = Clock::default();
        clock.painted(4, 10.);
        clock.observe(true, 4, 10.1);
        assert_eq!(clock.position(4, 22.), 10.);
        clock.observe(true, 4, 25.);
        clock.painted(4, 25.);
        assert_eq!(clock.position(4, 25.), 10.);
        clock.observe(false, 4, 25.);
        assert_eq!(clock.position(4, 25.), 25.);
    }
    #[test]
    fn new_project_never_inherits_previous_projects_frozen_position() {
        let mut clock = Clock::default();
        clock.painted(4, 30.);
        clock.observe(true, 4, 31.);
        clock.observe(true, 5, 0.);
        assert_eq!(clock.position(5, 2.), 0.);
        assert_eq!(clock.position(6, 7.), 7.);
    }
}

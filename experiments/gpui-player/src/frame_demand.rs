//! Closed set of app-owned animation sources that may request another frame.
#[derive(Clone, Copy, Debug, Default, Eq, PartialEq)]
pub(crate) struct FrameDemand(u16);

#[derive(Clone, Copy, Debug)]
#[repr(u16)]
pub(crate) enum Source {
    Startup = 1 << 0,
    LaneEnter = 1 << 1,
    LaneFade = 1 << 2,
    Playback = 1 << 3,
    PendingSeek = 1 << 4,
    DemoPlayback = 1 << 5,
    Capture = 1 << 6,
    Timeline = 1 << 7,
    LyricsScroll = 1 << 8,
    CountIn = 1 << 9,
}

impl FrameDemand {
    pub(crate) fn set(&mut self, source: Source, active: bool) {
        if active {
            self.0 |= source as u16;
        } else {
            self.0 &= !(source as u16);
        }
    }

    pub(crate) fn is_empty(self) -> bool {
        self.0 == 0
    }

    #[cfg(feature = "ui-tests")]
    pub(crate) fn bits(self) -> u16 {
        self.0
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn demand_is_empty_until_a_visible_animation_source_is_active() {
        let mut demand = FrameDemand::default();
        assert!(demand.is_empty());
        demand.set(Source::Playback, true);
        assert!(!demand.is_empty());
        demand.set(Source::Playback, false);
        assert!(demand.is_empty());
    }

    #[test]
    fn paused_idle_state_has_no_frame_demand() {
        let mut demand = FrameDemand::default();
        demand.set(Source::Playback, false);
        demand.set(Source::PendingSeek, false);
        demand.set(Source::LaneFade, false);
        demand.set(Source::LaneEnter, false);
        demand.set(Source::LyricsScroll, false);
        demand.set(Source::CountIn, false);
        assert!(demand.is_empty());
    }
}

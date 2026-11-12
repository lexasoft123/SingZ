//! The lyric panel's pre-line cue, independent of the approved glyph sweep.
use std::time::{Duration, Instant};

pub const CUE_HEIGHT: f32 = 15.; // 11px line box + source 4px bottom margin.

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Dots(u8),
    Seconds(u32),
}
/// "N s" captions for every second count a song can show, built once so the
/// lyric paint never formats one per frame.
const SECONDS_LABELS: usize = 3600;

fn seconds_labels() -> &'static [String] {
    static LABELS: std::sync::OnceLock<Vec<String>> = std::sync::OnceLock::new();
    LABELS.get_or_init(|| (0..SECONDS_LABELS).map(|n| format!("{n} s")).collect())
}

/// Build the caption table now (project load) rather than in the first paint.
pub fn warm() {
    let _ = seconds_labels();
}

impl Kind {
    /// The caption; borrowed for every cue a song can produce.
    pub fn text(self) -> std::borrow::Cow<'static, str> {
        use std::borrow::Cow::{Borrowed, Owned};
        match self {
            Self::Dots(1) => Borrowed("●"),
            Self::Dots(2) => Borrowed("● ●"),
            Self::Dots(_) => Borrowed("● ● ●"),
            Self::Seconds(value) => match seconds_labels().get(value as usize) {
                Some(label) => Borrowed(label.as_str()),
                None => Owned(format!("{value} s")),
            },
        }
    }
    pub fn tracking(self) -> f32 {
        if matches!(self, Self::Seconds(_)) {
            1.
        } else {
            5.
        }
    }
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Cue {
    pub line: usize,
    pub kind: Kind,
}

/// Input position already includes the panel's existing 150ms anticipation.
pub fn at_target(
    index: usize,
    start: f64,
    previous_end: Option<f64>,
    position: f64,
    playing: bool,
) -> Option<Cue> {
    if !playing || !position.is_finite() || !start.is_finite() || start <= position {
        return None;
    }
    let previous_end = previous_end.unwrap_or(0.);
    if !previous_end.is_finite() {
        return None;
    }
    let remaining = start - position;
    let gap = if index == 0 {
        start
    } else {
        start - previous_end
    };
    let gap_ok = if index == 0 { start >= 1.2 } else { gap >= 3. };
    let kind = if gap_ok && remaining <= 3. {
        Kind::Dots((remaining.ceil() as u8).min(3))
    } else if gap > 5. && remaining > 3. && (index == 0 || position >= previous_end) {
        Kind::Seconds(remaining.ceil().min(u32::MAX as f64) as u32)
    } else {
        return None;
    };
    Some(Cue { line: index, kind })
}

#[cfg(test)]
fn at(lines: impl AsRef<[(f64, f64)]>, position: f64, playing: bool) -> Option<Cue> {
    let lines = lines.as_ref();
    let next = lines.partition_point(|line| line.0 <= position);
    let start = lines.get(next)?.0;
    at_target(
        next,
        start,
        next.checked_sub(1).map(|i| lines[i].1),
        position,
        playing,
    )
}

/// CSS pulse has two half-second intervals, each quantized to eight steps.
/// Index zero is opaque, index eight is the 45% trough.
pub fn pulse_level(elapsed: Duration) -> u8 {
    let step = (elapsed.as_secs_f64().rem_euclid(1.) * 16.).floor() as u8;
    if step <= 8 { step } else { 16 - step }
}

#[derive(Default, Debug)]
pub struct PulseClock {
    epoch: Option<u64>,
    cue: Option<Cue>,
    elapsed: Duration,
    last: Option<Instant>,
    suspended: bool,
    pub bounds: Option<(f32, f32, f32, f32)>,
    pub sprite_ready: bool,
}
impl PulseClock {
    pub fn clear(&mut self) {
        *self = Self::default();
    }
    pub fn observe(
        &mut self,
        cue: Option<Cue>,
        now: Instant,
        suspended: bool,
        epoch: u64,
    ) -> Option<(Cue, u8)> {
        // Renderer diagnostics describe this frame, never a previous row's cue.
        self.bounds = None;
        self.sprite_ready = false;
        if self.epoch != Some(epoch) {
            self.clear();
            self.epoch = Some(epoch);
        }
        if !self.suspended {
            self.elapsed += self
                .last
                .map_or(Duration::ZERO, |last| now.saturating_duration_since(last));
        }
        self.last = Some(now);
        self.suspended = suspended;
        if !suspended {
            if self.cue.map(|c| c.line) != cue.map(|c| c.line) {
                self.elapsed = Duration::ZERO;
            }
            self.cue = cue;
            if cue.is_none() {
                self.elapsed = Duration::ZERO;
                self.bounds = None;
                self.sprite_ready = false;
            }
        }
        self.current()
    }
    pub fn current(&self) -> Option<(Cue, u8)> {
        self.cue.map(|cue| (cue, pulse_level(self.elapsed)))
    }
}

#[cfg(test)]
mod tests {
    use super::{Cue, Kind, PulseClock, at, pulse_level};
    use std::borrow::Cow;

    #[test]
    fn every_caption_a_song_can_show_is_borrowed_not_formatted_per_frame() {
        // Lyric paint asks for the caption every frame; an owned String there was an
        // allocation per frame. Dots and every second count up to an hour borrow.
        for kind in [Kind::Dots(1), Kind::Dots(2), Kind::Dots(3), Kind::Seconds(0), Kind::Seconds(4), Kind::Seconds(3599)] {
            assert!(matches!(kind.text(), Cow::Borrowed(_)), "{kind:?} formats its caption");
        }
        assert_eq!(Kind::Seconds(12).text(), "12 s");
        assert_eq!(Kind::Dots(2).text(), "● ●");
        // Beyond the table the caption is still right, just formatted.
        assert_eq!(Kind::Seconds(4000).text(), "4000 s");
    }
    use std::time::{Duration, Instant};
    #[test]
    fn lyric_countdown_first_line_runway_and_exact_last_three_seconds() {
        let lines = [(6., 7.), (11., 12.)];
        for (position, kind) in [
            (0., Kind::Seconds(6)),
            (2.999, Kind::Seconds(4)),
            (3., Kind::Dots(3)),
            (4., Kind::Dots(2)),
            (5., Kind::Dots(1)),
        ] {
            assert_eq!(at(lines, position, true), Some(Cue { line: 0, kind }));
        }
        assert_eq!(at(lines, 6., true), None);
        assert_eq!(
            at([(1.2, 2.)], 0., true),
            Some(Cue {
                line: 0,
                kind: Kind::Dots(2)
            })
        );
        assert_eq!(at([(1.199, 2.)], 0., true), None);
        assert_eq!(at([(0., 2.)], 0., true), None);
    }
    #[test]
    fn lyric_countdown_long_gaps_wait_for_previous_end_and_short_gaps_stay_clear() {
        let lines = [(0., 2.), (10., 11.)];
        assert_eq!(at(lines, 1., true), None);
        assert_eq!(
            at(lines, 2., true),
            Some(Cue {
                line: 1,
                kind: Kind::Seconds(8)
            })
        );
        assert_eq!(
            at(lines, 6., true),
            Some(Cue {
                line: 1,
                kind: Kind::Seconds(4)
            })
        );
        assert_eq!(
            at(lines, 7., true),
            Some(Cue {
                line: 1,
                kind: Kind::Dots(3)
            })
        );
        assert_eq!(
            at([(0., 2.), (5., 6.)], 2., true),
            Some(Cue {
                line: 1,
                kind: Kind::Dots(3)
            })
        );
        assert_eq!(at([(0., 2.), (4.99, 6.)], 2., true), None);
        assert_eq!(at([(0., 2.), (7., 8.)], 2., true), None); // exactly five is not a long pause.
    }
    #[test]
    fn lyric_countdown_paused_final_and_invalid_positions_have_no_cue() {
        assert_eq!(at([(6., 7.)], 0., false), None);
        assert_eq!(at([(6., 7.)], 7., true), None);
        assert_eq!(at([], 0., true), None);
        assert_eq!(at([(6., 7.)], f64::NAN, true), None);
    }
    #[test]
    fn lyric_countdown_pulse_steps_and_modal_pause_keep_css_phase() {
        assert_eq!(pulse_level(Duration::ZERO), 0);
        assert_eq!(pulse_level(Duration::from_millis(62)), 0);
        assert_eq!(pulse_level(Duration::from_micros(62_500)), 1);
        assert_eq!(pulse_level(Duration::from_millis(500)), 8);
        assert_eq!(pulse_level(Duration::from_millis(750)), 4);
        assert_eq!(pulse_level(Duration::from_secs(1)), 0);
        let mut clock = PulseClock::default();
        let now = Instant::now();
        let seconds = Cue {
            line: 0,
            kind: Kind::Seconds(6),
        };
        assert_eq!(
            clock.observe(Some(seconds), now, false, 1),
            Some((seconds, 0))
        );
        assert_eq!(
            clock.observe(Some(seconds), now + Duration::from_millis(250), true, 1),
            Some((seconds, 4))
        );
        // Covered app: label and animation phase both freeze, not just opacity.
        let dots = Cue {
            line: 0,
            kind: Kind::Dots(3),
        };
        assert_eq!(
            clock.observe(Some(dots), now + Duration::from_secs(4), true, 1),
            Some((seconds, 4))
        );
        assert_eq!(
            clock.observe(Some(dots), now + Duration::from_secs(5), false, 1),
            Some((dots, 4))
        );
        assert_eq!(
            clock.observe(None, now + Duration::from_secs(6), false, 1),
            None
        );
        assert_eq!(
            clock.observe(Some(dots), now + Duration::from_secs(7), false, 1),
            Some((dots, 0))
        );
        assert_eq!(
            clock.observe(Some(dots), now + Duration::from_millis(7250), false, 2),
            Some((dots, 0))
        );
    }
}

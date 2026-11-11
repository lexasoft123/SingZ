//! Shared lanes/pitch viewport policy, in song seconds. No rendering or audio work.
use std::time::{Duration, Instant};

pub const FOLLOW_DURATION: Duration = Duration::from_millis(750);

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct View {
    pub start: f64,
    pub end: f64,
}
impl View {
    pub fn full(duration: f64) -> Self {
        Self {
            start: 0.,
            end: duration.max(0.),
        }
    }
    pub fn span(self) -> f64 {
        self.end - self.start
    }
    pub fn zoomed(self, duration: f64) -> bool {
        self.span() < duration - 0.000001
    }
    pub fn clamp(duration: f64, start: f64, end: f64) -> Self {
        if !duration.is_finite() || duration <= 0. || !start.is_finite() || !end.is_finite() {
            return Self::full(duration);
        }
        let span = (end - start).clamp(duration.min(2.), duration);
        let start = start.clamp(0., duration - span);
        Self {
            start,
            end: start + span,
        }
    }
}

#[derive(Clone, Copy, Debug)]
pub enum Input {
    Zoom {
        factor: f64,
        anchor_fraction: Option<f64>,
    },
    Pan(f64),
    Fit,
}

/// Arguments use browser wheel signs: right/down are positive. GPUI's pixel
/// deltas have the opposite sign and are converted once at the UI boundary.
pub fn wheel_input(
    dx: f64,
    dy: f64,
    zoom: bool,
    anchor_fraction: Option<f64>,
    width: f64,
) -> Option<Input> {
    if !dx.is_finite()
        || !dy.is_finite()
        || !width.is_finite()
        || width <= 0.
        || (dx == 0. && dy == 0.)
    {
        return None;
    }
    if zoom {
        Some(Input::Zoom {
            factor: (dy * 0.008).exp().clamp(0.7, 1.4),
            anchor_fraction,
        })
    } else {
        Some(Input::Pan(
            if dx.abs() > dy.abs() { dx } else { dy } / width,
        ))
    }
}

pub fn pinch_input(delta: f64, anchor_fraction: Option<f64>) -> Option<Input> {
    (delta.is_finite() && delta != 0.).then(|| Input::Zoom {
        factor: (1. + delta).max(0.001).recip().clamp(0.7, 1.4),
        anchor_fraction,
    })
}

#[derive(Clone, Copy, Debug)]
struct Follow {
    from: f64,
    to: f64,
    span: f64,
    started: Instant,
}
#[derive(Clone, Copy, Debug)]
struct Sample {
    position: f64,
    at: Instant,
}

#[derive(Default, Debug)]
pub struct Navigation {
    epoch: Option<u64>,
    presented: Option<View>,
    notification_pending: bool,
    follow: Option<Follow>,
    last: Option<Sample>,
    inputs: u64,
}
impl Navigation {
    pub fn reset(&mut self) {
        *self = Self::default();
    }
    pub fn reconcile_epoch(&mut self, epoch: u64) {
        if self.epoch != Some(epoch) {
            self.reset();
            self.epoch = Some(epoch);
        }
    }
    pub fn animating(&self) -> bool {
        self.follow.is_some()
    }
    pub fn applied_inputs(&self) -> u64 {
        self.inputs
    }
    pub fn present(&mut self, view: View) {
        self.presented = Some(view);
        self.notification_pending = false;
    }

    /// Update authoritative bounds immediately so Save in the same dispatch sees
    /// every wheel delta. Only the first input before the next rendered frame
    /// notifies GPUI: a high-rate wheel burst does not repaint each lane per event.
    pub fn input(
        &mut self,
        input: Input,
        view: View,
        duration: f64,
        position: f64,
    ) -> Option<(View, bool)> {
        if !duration.is_finite() || duration <= 0. {
            return None;
        }
        if matches!(input, Input::Pan(_)) && !view.zoomed(duration) {
            return None;
        }
        self.follow = None;
        let presented = self.presented.unwrap_or(view);
        let next = match input {
            Input::Fit => View::full(duration),
            Input::Pan(fraction) => {
                if !fraction.is_finite() {
                    return None;
                }
                let delta = fraction * presented.span();
                View::clamp(duration, view.start + delta, view.end + delta)
            }
            Input::Zoom {
                factor,
                anchor_fraction,
            } => {
                if !factor.is_finite() || factor <= 0. {
                    return None;
                }
                let center = anchor_fraction
                    .filter(|n| n.is_finite())
                    .map_or(position.clamp(view.start, view.end), |fraction| {
                        presented.start + fraction.clamp(0., 1.) * presented.span()
                    });
                let ratio = if view.span() > 0. {
                    (center - view.start) / view.span()
                } else {
                    0.5
                };
                // Source zoomBy computes the requested left edge before
                // clampView applies its two-second minimum span.
                let span = view.span() * factor;
                View::clamp(
                    duration,
                    center - span * ratio,
                    center - span * ratio + span,
                )
            }
        };
        self.inputs = self.inputs.wrapping_add(1);
        let notify = !self.notification_pending;
        self.notification_pending = true;
        Some((next, notify))
    }

    /// Source TrackStack recognizes a seek from movement the playback clock
    /// cannot explain. Manual scrolling changes only the viewport, so it never
    /// fetches a deliberately offscreen playhead back into view.
    pub fn advance(
        &mut self,
        mut view: View,
        duration: f64,
        position: f64,
        playing: bool,
        tempo: f64,
        now: Instant,
        enabled: bool,
    ) -> View {
        if !enabled || !duration.is_finite() || duration <= 0. {
            self.follow = None;
            self.last = None;
            return view;
        }
        let seeked = self.last.is_some_and(|last| {
            let rolled = if playing {
                now.saturating_duration_since(last.at).as_secs_f64() * tempo
            } else {
                0.
            };
            (position - last.position - rolled).abs() > 0.35
        });
        self.last = Some(Sample { position, at: now });
        if let Some(follow) = self.follow {
            let k = (now.saturating_duration_since(follow.started).as_secs_f64()
                / FOLLOW_DURATION.as_secs_f64())
            .clamp(0., 1.);
            let eased = (1. - (std::f64::consts::PI * k).cos()) / 2.;
            let start = follow.from + (follow.to - follow.from) * eased;
            view = View::clamp(duration, start, start + follow.span);
            if k >= 1. {
                self.follow = None;
            }
        }
        if view.zoomed(duration) && view.span() > 0. {
            let on_screen = position >= view.start && position <= view.end;
            let leaving = playing && on_screen && position > view.end - view.span() * 0.08;
            if seeked && !on_screen {
                self.follow = None;
                view = View::clamp(
                    duration,
                    position - view.span() * 0.25,
                    position + view.span() * 0.75,
                );
            } else if leaving && self.follow.is_none() {
                let requested_start = position - view.span() * 0.25;
                let target = View::clamp(duration, requested_start, position + view.span() * 0.75);
                if (target.start - view.start).abs() > 0.000001 {
                    self.follow = Some(Follow {
                        from: view.start,
                        // App.followView eases toward the requested start and
                        // clamps each intermediate frame. Clamping the target
                        // first slows the final page's visible arrival.
                        to: requested_start,
                        span: view.span(),
                        started: now,
                    });
                }
            }
        }
        view
    }
}

#[cfg(test)]
mod tests {
    use super::{FOLLOW_DURATION, Input, Navigation, View, pinch_input, wheel_input};
    use std::time::{Duration, Instant};
    fn near(a: f64, b: f64) {
        assert!((a - b).abs() < 0.00001, "{a} != {b}");
    }
    #[test]
    fn timeline_wheel_zoom_anchors_cursor_and_pinch_uses_native_direction() {
        let mut nav = Navigation::default();
        let view = View {
            start: 10.,
            end: 30.,
        };
        nav.present(view);
        let (zoom, notify) = nav
            .input(
                wheel_input(0., -50., true, Some(0.75), 800.).unwrap(),
                view,
                100.,
                0.,
            )
            .unwrap();
        assert!(notify);
        near(zoom.start + zoom.span() * 0.75, 25.);
        assert!(zoom.span() < view.span());
        assert!(matches!(pinch_input(0.1,Some(0.5)),Some(Input::Zoom{factor,..}) if factor<1.));
        assert!(matches!(pinch_input(-0.1,Some(0.5)),Some(Input::Zoom{factor,..}) if factor>1.));
    }
    #[test]
    fn timeline_pan_bursts_accumulate_without_repeated_frame_notifications() {
        let mut nav = Navigation::default();
        let original = View {
            start: 10.,
            end: 30.,
        };
        nav.present(original);
        let mut view = original;
        for index in 0..10 {
            let (next, notify) = nav
                .input(
                    wheel_input(100., 2., false, None, 1000.).unwrap(),
                    view,
                    100.,
                    0.,
                )
                .unwrap();
            assert_eq!(notify, index == 0);
            view = next;
        }
        near(view.start, 30.);
        near(view.end, 50.);
        assert_eq!(nav.applied_inputs(), 10);
        nav.present(view);
        assert!(nav.input(Input::Pan(0.1), view, 100., 0.).unwrap().1);
        assert!(
            nav.input(Input::Pan(0.1), View::full(100.), 100., 0.)
                .is_none()
        );
    }
    #[test]
    fn timeline_follow_is_a_750ms_sine_page_turn_and_does_not_dirty_manual_counter() {
        let mut nav = Navigation::default();
        let start = Instant::now();
        let view = View {
            start: 0.,
            end: 10.,
        };
        nav.advance(view, 100., 9.1, true, 1., start, true);
        let first = nav.advance(
            view,
            100.,
            9.3,
            true,
            1.,
            start + Duration::from_millis(200),
            true,
        );
        assert_eq!(first, view);
        assert!(nav.animating());
        let halfway = nav.advance(
            first,
            100.,
            9.675,
            true,
            1.,
            start + Duration::from_millis(575),
            true,
        );
        near(halfway.start, 3.4);
        let end = nav.advance(
            halfway,
            100.,
            10.05,
            true,
            1.,
            start + Duration::from_millis(200) + FOLLOW_DURATION,
            true,
        );
        near(end.start, 6.8);
        assert!(!nav.animating());
        assert_eq!(nav.applied_inputs(), 0);
    }
    #[test]
    fn timeline_final_page_clamps_each_eased_frame_instead_of_the_target() {
        let mut nav = Navigation::default();
        let now = Instant::now();
        let view = View {
            start: 70.,
            end: 90.,
        };
        let start = nav.advance(view, 100., 88.5, true, 1., now, true);
        assert_eq!(start, view);
        assert!(nav.animating());
        // The requested start is 83.5; halfway there is 76.75. Easing
        // toward the prematurely clamped target 80 would instead yield 75.
        let middle = nav.advance(
            start,
            100.,
            88.875,
            true,
            1.,
            now + Duration::from_millis(375),
            true,
        );
        near(middle.start, 76.75);
        let last_page = nav.advance(
            middle,
            100.,
            89.,
            true,
            1.,
            now + Duration::from_millis(500),
            true,
        );
        near(last_page.start, 80.);
        assert!(nav.animating());
        let settled = nav.advance(
            last_page,
            100.,
            89.25,
            true,
            1.,
            now + FOLLOW_DURATION,
            true,
        );
        near(settled.start, 80.);
        assert!(!nav.animating());
    }
    #[test]
    fn timeline_scrolling_away_does_not_snap_back_but_an_offscreen_seek_cuts() {
        let mut nav = Navigation::default();
        let now = Instant::now();
        let view = View {
            start: 0.,
            end: 10.,
        };
        nav.present(view);
        nav.advance(view, 100., 5., false, 1., now, true);
        let (away, _) = nav.input(Input::Pan(3.), view, 100., 5.).unwrap();
        let unchanged = nav.advance(
            away,
            100.,
            5.,
            false,
            1.,
            now + Duration::from_millis(10),
            true,
        );
        assert_eq!(unchanged, away);
        let sought = nav.advance(
            away,
            100.,
            70.,
            false,
            1.,
            now + Duration::from_millis(20),
            true,
        );
        near(sought.start, 67.5);
        assert!(!nav.animating());
    }
    #[test]
    fn timeline_manual_input_and_epoch_change_cancel_follow_and_short_songs_stay_full() {
        let mut nav = Navigation::default();
        let now = Instant::now();
        let view = View {
            start: 0.,
            end: 10.,
        };
        nav.reconcile_epoch(1);
        nav.present(view);
        nav.advance(view, 100., 9.3, true, 1., now, true);
        assert!(nav.animating());
        let _ = nav.input(Input::Pan(0.1), view, 100., 9.3);
        assert!(!nav.animating());
        nav.advance(
            view,
            100.,
            9.4,
            true,
            1.,
            now + Duration::from_millis(100),
            true,
        );
        assert!(nav.animating());
        nav.reconcile_epoch(2);
        assert!(!nav.animating());
        assert_eq!(
            nav.input(
                Input::Zoom {
                    factor: 0.5,
                    anchor_fraction: None
                },
                View::full(1.),
                1.,
                0.
            )
            .unwrap()
            .0,
            View::full(1.)
        );
    }
}

use super::*;
use crate::{
    beat::{Beats, Metronome},
    integration::Status,
};
fn met(bars: u32) -> Metronome {
    Metronome {
        count_in_bars: bars,
        ..Default::default()
    }
}
fn grid() -> Beats {
    let mut g = Beats::constant(120., 0., 10., 4).unwrap();
    g.beats = (0..25).map(|i| 0.3 + i as f64 * 0.5).collect();
    g
}
fn status(seconds: f64, total: usize, per_bar: usize, pre: f64) -> Status {
    Status {
        output_peak:0.,
        output_clipped_blocks:0,
        explicit_graph: false,
        graph_nodes: 0,
        graph_connections: 0,
        graph_snapshot: None,
        graph_error: None,
        state: 3,
        transport_state: 2,
        #[cfg(feature="ui-tests")]
        observed_lanes: serde_json::Value::Null,
        #[cfg(feature="ui-tests")]
        observed_master_gain: None,
        #[cfg(feature="ui-tests")]
        observed_provider: None,
        #[cfg(feature="ui-tests")]
        observed_backend_provider: None,
        #[cfg(feature="ui-tests")]
        observed_fixture: None,
        counting_in: true,
        count_in_heard: Some(Heard {
            seconds_to_landing: seconds,
            landing_seconds: 0.,
            total,
            per_bar,
            pre_roll_seconds: pre,
        }),
        rendered_frame: -100,
        training_only: false,
        empty_project: false,
        lane_revision: 1,
        carry_revision: 1,
        cue: crate::training_audio::Status {
            generation: 0,
            start_host_ns: 0,
            end_host_ns: 0,
            now_host_ns: 0,
            active: false,
            output_latency_ms: 0.,
            notes: vec![],
        },
        graph_generation: 1,
        parked: false,
        physical_output_released: false,
        sampled_at: std::time::Instant::now(),
        output_uid: "fake".into(),
        output_label: "Fake".into(),
        rate: 1.,
        transpose: 0,
        seek_count: 0,
        loop_count: 0,
        loop_range: None,
        region_range: None,
        audible_current: true,
        position: 0.,
        duration: 10.,
        playing: true,
    }
}
#[test]
fn source_pickup_offsets_follow_real_beats_not_runway_divisions() {
    let offsets = offsets(0., Some(&grid()), &met(1), 1.);
    assert_eq!(offsets, vec![-1.7, -1.2, -0.7, -0.2]);
    let s = status(-0.21, 4, 4, 1.7);
    assert_eq!(
        count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::ZERO),
        Some(CountIn {
            total: 4,
            done: 3,
            per_bar: 4
        })
    );
    assert_eq!(
        count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_millis(15))
            .unwrap()
            .done,
        4
    );
}
#[test]
fn variable_meter_uses_bar_at_entry_and_extrapolates_before_track() {
    let mut g = grid();
    g.downbeats = Some(vec![0, 4, 6, 10, 14]);
    let v = offsets(2.8, Some(&g), &met(1), 1.);
    assert_eq!(v.len(), 2);
    assert!((v[0] + 1.).abs() < 1e-12 && (v[1] + 0.5).abs() < 1e-12);
    assert_eq!(offsets(0., Some(&g), &met(2), 1.).len(), 8);
    assert_eq!(offsets(100., Some(&g), &met(1), 1.).len(), 4);
}
#[test]
fn gridless_ticks_are_three_per_bar_scaled_in_project_time() {
    assert_eq!(
        offsets(4., None, &met(2), 1.5),
        vec![-9., -7.5, -6., -4.5, -3., -1.5]
    );
    let mut s = status(-2.01, 3, 3, 6.);
    s.rate = 2.;
    assert_eq!(
        count_in_at_elapsed(&s, None, &met(1), Duration::from_millis(10))
            .unwrap()
            .done,
        3
    );
}
#[test]
fn mismatched_edited_grid_uses_source_even_runway_fallback() {
    let s = status(-2., 5, 5, 5.);
    assert_eq!(
        count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::ZERO),
        Some(CountIn {
            total: 5,
            done: 4,
            per_bar: 5
        })
    );
}
#[test]
fn reported_preroll_stays_full_until_native_reports_landing() {
    let s = status(-0.01, 4, 4, 1.7);
    assert_eq!(
        count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_secs(20))
            .unwrap()
            .done,
        4
    );
    let mut landed = s;
    landed.rendered_frame = 0;
    assert!(
        count_in_at_elapsed(&landed, Some(&grid()), &met(1), Duration::from_millis(11)).is_none()
    );
}
#[test]
fn projection_freezes_after_four_fast_polls() {
    let s = status(-0.45, 4, 4, 1.7);
    let at200 = count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_millis(200));
    assert_eq!(at200.unwrap().done, 3);
    assert_eq!(
        at200,
        count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_secs(10))
    );
}
#[test]
fn heard_tail_retains_negative_clock_after_nonzero_landing() {
    let mut s = status(-0.15, 4, 4, 1.7);
    s.rendered_frame = 5 * 48000;
    s.count_in_heard.as_mut().unwrap().landing_seconds = 5.;
    assert!(count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_millis(100)).is_some());
    assert!(count_in_at_elapsed(&s, Some(&grid()), &met(1), Duration::from_millis(151)).is_none());
}
#[test]
fn paused_empty_training_and_missing_clocks_never_show_dots() {
    let mut s = status(-1., 3, 3, 3.);
    s.playing = false;
    assert!(count_in(&s, None, &met(1)).is_none());
    s.playing = true;
    s.empty_project = true;
    assert!(count_in(&s, None, &met(1)).is_none());
    s.empty_project = false;
    s.training_only = true;
    assert!(count_in(&s, None, &met(1)).is_none());
    s.training_only = false;
    s.count_in_heard = None;
    assert!(count_in(&s, None, &met(1)).is_none());
}
#[test]
fn malformed_native_clock_is_refused_instead_of_inventing_counts() {
    let good = serde_json::json!({"secondsToLanding":-1.,"landingSeconds":2.,"total":4,"perBar":4,"preRollSeconds":2.});
    assert!(Heard::parse(Some(&good)).unwrap().is_some());
    for (key, value) in [
        ("secondsToLanding", serde_json::json!(1.)),
        ("total", serde_json::json!(0)),
        ("total", serde_json::json!(40001)),
        ("perBar", serde_json::json!(5)),
        ("preRollSeconds", serde_json::json!(0)),
        ("landingSeconds", serde_json::json!(-1.)),
    ] {
        let mut bad = good.clone();
        bad[key] = value;
        assert!(Heard::parse(Some(&bad)).is_err(), "{key}");
    }
    assert!(Heard::parse(None).unwrap().is_none());
    assert!(
        Heard::parse(Some(&serde_json::Value::Null))
            .unwrap()
            .is_none()
    );
}
#[test]
fn cached_offsets_match_full_derivation_at_click_boundaries_and_stalled_polls() {
    let g = grid();
    let m = met(1);
    let prepared = offsets(0., Some(&g), &m, 1.);
    for seconds in [-1.71, -1.7, -1.21, -1.2, -0.71, -0.7, -0.21, -0.2, -0.01] {
        let s = status(seconds, 4, 4, 1.7);
        for elapsed in [
            Duration::ZERO,
            Duration::from_millis(16),
            Duration::from_millis(200),
            Duration::from_secs(5),
        ] {
            assert_eq!(
                count_in_from_offsets_at_elapsed(&s, &prepared, elapsed),
                count_in_at_elapsed(&s, Some(&g), &m, elapsed)
            );
        }
    }
    let s = status(-2., 5, 5, 5.);
    assert_eq!(
        count_in_from_offsets_at_elapsed(&s, &prepared, Duration::ZERO),
        Some(CountIn {
            total: 5,
            done: 4,
            per_bar: 5
        })
    );
}

// BEGIN PLAYHEAD SAMPLING TESTS
// Replay callback/poll boundaries in project seconds, stepping the display at
// 250 us. Immature `position` is the helper's render-head-minus-latency value,
// not the unavailable audible frame (which is zero in the native protocol).
fn clock_sample(at: Instant, position: f64) -> PlayheadSample {
    PlayheadSample {
        position,
        sampled_at: at,
        playing: true,
        audible_current: true,
        seek_count: 0,
        loop_count: 0,
        loop_range: None,
        rate: 1.,
        counting_in: false,
        rendered_frame: 480_000,
        duration: 120.,
        graph_generation: 1,
        lane_revision: 1,
        completed: false,
    }
}
fn step_clock(p: &mut Playhead, start: Instant, micros: u64, previous: &mut f64) {
    for us in (0..micros).step_by(250) {
        let value = p.shown(start + Duration::from_micros(us));
        assert!(
            value + 1e-12 >= *previous,
            "clock went back: {previous:.9} -> {value:.9} at {us} us"
        );
        *previous = value;
    }
}
#[test]
fn playhead_pause_holds_a_playing_sample_delivered_after_pause() {
    let t = Instant::now();
    let mut p = Playhead::default();
    p.admit(clock_sample(t, 10.), t);
    let press = t + Duration::from_millis(24);
    let held = p.shown(press);
    p.pause_intent(press);
    // The 20 ms poll was sampled before the press, delivered 6 ms after it.
    p.admit(
        clock_sample(t + Duration::from_millis(20), 10.019),
        press + Duration::from_millis(6),
    );
    let mut previous = held;
    step_clock(
        &mut p,
        press + Duration::from_millis(6),
        20_000,
        &mut previous,
    );
    assert_eq!(p.position(), held);
    let mut park = clock_sample(press + Duration::from_millis(30), 10.021);
    park.playing = false;
    park.audible_current = false;
    p.admit(park, park.sampled_at);
    step_clock(&mut p, park.sampled_at, 20_000, &mut previous);
    assert_eq!(
        p.position(),
        held,
        "a parked point cannot undo the pause floor"
    );
    let mut rebuilt = park;
    rebuilt.sampled_at += Duration::from_millis(30);
    rebuilt.graph_generation += 1;
    rebuilt.position = held - 0.001;
    rebuilt.playing = true;
    p.admit(rebuilt, rebuilt.sampled_at);
    step_clock(&mut p, rebuilt.sampled_at, 20_000, &mut previous);
    assert_eq!(
        p.position(),
        held,
        "a rate receipt must preserve the latest Pause"
    );
}
#[test]
fn playhead_immature_projection_holds_until_the_ear_reaches_the_run_start() {
    for latency_us in [11_000, 150_000] {
        let t = Instant::now();
        let mut p = Playhead::new(10.);
        p.play_intent(t);
        let mut previous = 10.;
        // Callback snapshots around Play, including one callback of jitter at
        // the first current projection. Test plain and time-pitch/output delay.
        for us in (0..latency_us + 50_000).step_by(1000) {
            let now = t + Duration::from_micros(us);
            let mut s = clock_sample(
                now,
                (10. + us as f64 / 1e6 - latency_us as f64 / 1e6).max(0.),
            );
            s.audible_current = us >= latency_us;
            p.admit(s, now);
            if us < latency_us {
                assert_eq!(
                    p.position(),
                    10.,
                    "bar moved before the ear at latency {latency_us}"
                );
            }
            step_clock(&mut p, now, 1000, &mut previous);
        }
        assert!(p.position() > 10.04);
    }
    let t = Instant::now();
    let mut p = Playhead::new(5.);
    let mut parked = clock_sample(t, 5.); parked.playing = false;
    p.admit(parked, t);
    p.play_intent(t);
    let mut runway = clock_sample(t + Duration::from_millis(1), 0.);
    runway.graph_generation = 2; runway.counting_in = true; runway.rendered_frame = -4800;
    p.admit(runway, runway.sampled_at);
    let mut previous = 5.;
    step_clock(&mut p, runway.sampled_at, 20_000, &mut previous);
    assert_eq!(p.position(), 5., "a count-in graph must keep its mid-song landing");
    let press = runway.sampled_at + Duration::from_millis(21);
    p.pause_intent(press);
    let mut cancelled = runway;
    cancelled.sampled_at = press + Duration::from_millis(1);
    cancelled.counting_in = false; cancelled.playing = false;
    p.admit(cancelled, cancelled.sampled_at);
    step_clock(&mut p, cancelled.sampled_at, 20_000, &mut previous);
    assert_eq!(p.position(), 5.);
}
#[test]
fn playhead_seek_holds_two_queued_targets_and_a_seek_behind_rate() {
    let t = Instant::now();
    let mut p = Playhead::default();
    p.admit(clock_sample(t, 10.), t);
    p.seek(4.);
    p.seek_queued(t);
    p.seek(7.);
    p.seek_queued(t);
    assert_eq!(p.pending_seek(), Some((2, 7.)));
    let mut first = clock_sample(t + Duration::from_millis(1), 4.001);
    first.seek_count = 1;
    p.admit(first, first.sampled_at);
    let mut previous = 7.;
    step_clock(&mut p, first.sampled_at, 20_000, &mut previous);
    assert_eq!(
        p.position(),
        7.,
        "the first seek receipt must not release the second target"
    );
    let mut second = clock_sample(t + Duration::from_millis(22), 7.002);
    second.seek_count = 2;
    p.admit(second, second.sampled_at);
    step_clock(&mut p, second.sampled_at, 20_000, &mut previous);
    p.seek(2.);
    p.seek_queued(t);
    // A rate receipt installs a new graph before its queued seek is applied.
    let mut rate = clock_sample(t + Duration::from_millis(43), 7.020);
    rate.seek_count = 2;
    rate.graph_generation = 2;
    rate.rate = 0.8;
    p.admit(rate, rate.sampled_at);
    previous = 2.;
    step_clock(&mut p, rate.sampled_at, 20_000, &mut previous);
    assert_eq!(p.position(), 2.);
    assert_eq!(p.pending_seek(), Some((3, 2.)));
    let mut receipt = clock_sample(t + Duration::from_millis(65), 1.99);
    receipt.graph_generation = 2;
    receipt.rate = 0.8;
    receipt.seek_count = 3;
    receipt.audible_current = false;
    p.admit(receipt, receipt.sampled_at);
    step_clock(&mut p, receipt.sampled_at, 20_000, &mut previous);
    assert!(p.pending_seek().is_none());
    let mut current = receipt;
    current.sampled_at += Duration::from_millis(20);
    current.position = 2.01;
    current.audible_current = true;
    p.admit(current, current.sampled_at);
    step_clock(&mut p, current.sampled_at, 20_000, &mut previous);
    // The first new-graph receipt may already acknowledge its queued seek.
    p.seek(9.); p.seek_queued(t);
    let mut rebuilt = current;
    rebuilt.sampled_at += Duration::from_millis(30);
    rebuilt.graph_generation = 3; rebuilt.seek_count = 4;
    rebuilt.position = 8.99; rebuilt.audible_current = false;
    p.admit(rebuilt, rebuilt.sampled_at);
    assert_eq!(p.position(), 9.);
    assert!(p.pending_seek().is_none());
    previous = 9.;
    step_clock(&mut p, rebuilt.sampled_at, 20_000, &mut previous);
}
#[test]
fn playhead_quarter_second_loop_never_returns_to_a_lap_already_shown_across_80_wraps() {
    let t = Instant::now();
    let mut p = Playhead::new(2.);
    let mut previous = 2.;
    let mut wraps = 0;
    for tick in 0..=80_020u64 {
        let now = t + Duration::from_micros(tick * 250);
        let elapsed = tick as f64 * 0.00025;
        if tick % 20 == 0 {
            // A callback-stale status follows a projection across a seam. Its
            // latency stand-in briefly still names the previous loop's tail.
            let heard = (elapsed - 0.00075).max(0.);
            let mut s = clock_sample(now, 2. + heard % 0.25);
            s.loop_count = (elapsed / 0.25).floor() as u64;
            s.loop_range = Some((2., 2.25));
            s.audible_current = elapsed % 0.25 >= 0.002;
            p.admit(s, now);
        }
        let value = p.shown(now);
        let delta = value - previous;
        if delta < -0.125 {
            wraps += 1;
            assert!(
                previous > 2.24 && value < 2.01,
                "false wrap: {previous} -> {value}"
            );
        } else {
            assert!(
                delta >= -1e-12 && delta <= 0.125,
                "lap bounced: {previous:.9} -> {value:.9} at {elapsed:.6}"
            );
        }
        previous = value;
    }
    assert_eq!(wraps, 80);
    assert!(p.position() < 2.01);
}
#[test]
fn playhead_reordered_and_duplicate_samples_cannot_rewind_the_display() {
    let t = Instant::now();
    let mut p = Playhead::default();
    p.admit(clock_sample(t, 10.), t);
    let mut previous = p.shown(t + Duration::from_millis(30));
    assert!(!p.admit(
        clock_sample(t - Duration::from_millis(1), 1.),
        t + Duration::from_millis(31)
    ));
    assert!(!p.admit(clock_sample(t, 9.999), t + Duration::from_millis(32)));
    step_clock(&mut p, t + Duration::from_millis(32), 20_000, &mut previous);
    let mut parked = clock_sample(t + Duration::from_millis(60), previous + 0.002);
    parked.playing = false;
    p.admit(parked, parked.sampled_at);
    let anchor = p.anchor();
    assert!(anchor.is_some());
    for us in (0..20_000).step_by(250) {
        p.shown(parked.sampled_at + Duration::from_micros(us));
        assert_eq!(p.anchor(), anchor, "an idle frame would notify the editor again");
    }
    let mut stalled = Playhead::default();
    stalled.admit(clock_sample(t, 10.), t);
    stalled.shown(t + Duration::from_millis(150));
    let (source, sampled_at) = stalled.anchor().unwrap();
    assert_eq!(sampled_at, t, "rendering must not renew native clock authority");
    let editor = source + (t + Duration::from_millis(300))
        .saturating_duration_since(sampled_at).as_secs_f64().min(0.1);
    assert_eq!(editor, stalled.position(), "the editor must share the 100ms cap");
}
#[test]
fn playhead_graph_generation_resets_the_clock_and_rejects_retired_graphs() {
    let t = Instant::now();
    let mut p = Playhead::default();
    p.admit(clock_sample(t, 10.), t);
    let mut changed = clock_sample(t + Duration::from_millis(10), 3.);
    changed.graph_generation = 2;
    p.admit(changed, changed.sampled_at);
    assert_eq!(p.position(), 3., "new graph starts a fresh clock");
    let mut previous = 3.;
    step_clock(&mut p, changed.sampled_at, 5000, &mut previous);
    let mut retired = clock_sample(t + Duration::from_millis(20), 1.);
    retired.graph_generation = 1;
    assert!(!p.admit(retired, retired.sampled_at));
    step_clock(&mut p, retired.sampled_at, 5000, &mut previous);
}
#[test]
fn playhead_lane_revision_resets_the_clock_and_rejects_retired_lanes() {
    let t = Instant::now();
    let mut p = Playhead::default();
    p.admit(clock_sample(t, 10.), t);
    let mut changed = clock_sample(t + Duration::from_millis(10), 4.);
    changed.lane_revision = 2;
    p.admit(changed, changed.sampled_at);
    assert_eq!(p.position(), 4.);
    let mut previous = 4.;
    step_clock(&mut p, changed.sampled_at, 5000, &mut previous);
    let mut retired = clock_sample(t + Duration::from_millis(20), 1.);
    retired.lane_revision = 1;
    assert!(!p.admit(retired, retired.sampled_at));
    step_clock(&mut p, retired.sampled_at, 5000, &mut previous);
}

#[test]
fn playhead_refused_seek_rejoins_native_clock_and_preserves_earlier_queued_seek() {
    let t = Instant::now();
    let mut p = Playhead::new(10.);
    p.admit(clock_sample(t, 10.), t);
    p.seek(40.); // The transport refused this command; no seek counter was earned.
    p.seek_refused();
    assert_eq!(p.position(), 10.);
    let old = clock_sample(t + Duration::from_millis(20), 10.02);
    p.admit(old, old.sampled_at);
    assert_eq!(p.position(), 10.02, "a refused forward target must not become a floor");

    p.seek(20.); p.seek_queued(t + Duration::from_millis(21));
    p.pause_intent(t + Duration::from_millis(22));
    p.seek(50.); p.seek_refused();
    assert_eq!(p.pending_seek(), Some((1, 20.)));
    assert_eq!(p.shown(t + Duration::from_millis(30)), 20.);
    let mut ack = clock_sample(t + Duration::from_millis(40), 20.);
    ack.seek_count = 1;
    p.admit(ack, ack.sampled_at);
    assert_eq!(p.shown(t + Duration::from_millis(60)), 20., "refusal must preserve Pause");

    let mut no_clock = Playhead::new(7.);
    no_clock.seek(40.); no_clock.seek_refused();
    assert_eq!(no_clock.position(), 7., "no native clock must keep the pre-seek drawing");
}
#[test]
fn playhead_queued_seek_later_refused_by_the_helper_rejoins_the_native_clock_at_once() {
    let t = Instant::now();
    let mut p = Playhead::new(10.);
    p.admit(clock_sample(t, 10.), t);
    // The transport accepted the command, so the playhead holds the target ...
    p.seek(40.);
    p.seek_queued(t + Duration::from_millis(1));
    assert_eq!(p.shown(t + Duration::from_millis(5)), 40.);
    // ... until the helper refuses it; no acknowledgement will ever come.
    p.seek_rejected(40.);
    assert_eq!(p.pending_seek(), None);
    let next = clock_sample(t + Duration::from_millis(20), 10.02);
    p.admit(next, next.sampled_at);
    assert_eq!(
        p.position(),
        10.02,
        "a refused queued seek must not hold the bar at its target until expiry"
    );
}
#[test]
fn playhead_seek_hold_expires_after_one_second_even_across_a_graph_receipt() {
    let t = Instant::now();
    let mut p = Playhead::new(10.);
    p.admit(clock_sample(t, 10.), t);
    p.seek(40.); p.seek_queued(t);
    let mut late = clock_sample(t + Duration::from_millis(900), 10.9);
    late.graph_generation = 2;
    p.admit(late, late.sampled_at);
    assert_eq!(p.shown(t + Duration::from_micros(999_750)), 40.);
    assert_eq!(p.shown(t + Duration::from_secs(1)), 11.);
    assert!(p.pending_seek().is_none());

    p.seek(40.); p.seek_queued(t + Duration::from_secs(2));
    p.seek(50.); p.seek_queued(t + Duration::from_millis(2500));
    let mut first_ack = clock_sample(t + Duration::from_millis(2900), 40.01);
    first_ack.graph_generation = 2; first_ack.seek_count = 1;
    p.admit(first_ack, first_ack.sampled_at);
    assert_eq!(p.shown(t + Duration::from_millis(3000)), 50., "the latest queued seek gets its own second");
    assert_eq!(p.shown(t + Duration::from_micros(3_499_750)), 50.);
    assert!((p.shown(t + Duration::from_millis(3500)) - 40.11).abs() < 1e-12);
    assert!(p.pending_seek().is_none());
    // A late native acknowledgement still establishes the real seek boundary.
    let mut second_ack = first_ack;
    second_ack.sampled_at = t + Duration::from_millis(3600);
    second_ack.seek_count = 2; second_ack.position = 50.02;
    p.admit(second_ack, second_ack.sampled_at);
    assert_eq!(p.position(), 50.02);

    let mut no_sample = Playhead::new(7.);
    no_sample.seek(40.); no_sample.seek_queued(t);
    assert_eq!(no_sample.shown(t + Duration::from_secs(1)), 7.);
    assert!(no_sample.pending_seek().is_none());
    let mut first = clock_sample(t + Duration::from_millis(1001), 3.);
    first.playing = false;
    no_sample.admit(first, first.sampled_at);
    assert_eq!(no_sample.position(), 3.);

    let mut count_in = Playhead::new(5.);
    let mut parked = clock_sample(t, 5.); parked.playing = false;
    count_in.admit(parked, t);
    let mut runway = clock_sample(t + Duration::from_millis(1), 0.);
    runway.graph_generation = 2; runway.counting_in = true; runway.rendered_frame = -4800;
    count_in.admit(runway, runway.sampled_at);
    count_in.seek(40.); count_in.seek_queued(runway.sampled_at);
    runway.sampled_at += Duration::from_millis(100);
    runway.graph_generation = 3;
    count_in.admit(runway, runway.sampled_at);
    assert_eq!(count_in.shown(t + Duration::from_millis(1001)), 5.,
        "expiry during count-in must restore its real landing, not the lost target");
    assert!(count_in.pending_seek().is_none());
}
#[test]
fn playhead_invalid_duration_does_not_panic_or_publish_a_negative_position() {
    let t = Instant::now();
    for duration in [f64::NAN, -1., f64::INFINITY, f64::NEG_INFINITY] {
        let mut p = Playhead::default();
        let mut sample = clock_sample(t, 12.);
        sample.duration = duration;
        p.admit(sample, t);
        assert_eq!(p.position(), if duration.is_finite() {0.} else {12.});
        assert!(p.position().is_finite());
    }
}
#[test]
fn playhead_local_seek_cannot_disable_the_retired_clock_reset() {
    let t = Instant::now();
    let mut p = Playhead::new(10.);
    let mut old = clock_sample(t, 10.); old.seek_count = 5;
    p.admit(old, t);
    p.stop_projection();
    p.seek(40.);
    let mut replacement = clock_sample(t + Duration::from_millis(20), 3.);
    replacement.playing = false;
    p.admit(replacement, replacement.sampled_at);
    assert_eq!(p.position(), 3., "local placement must not revive the retired clock floor");
    assert_eq!(p.seek_count(), 0);
}

// END PLAYHEAD SAMPLING TESTS

#[test]
fn play_at_the_end_of_the_song_rewinds_it_only_when_completed_or_within_10ms() {
    assert!(play_rewinds_finished_song(true, 30., 30.));
    assert!(play_rewinds_finished_song(true, 12., 30.), "a Completed transport rewinds");
    assert!(play_rewinds_finished_song(false, 30., 30.));
    assert!(play_rewinds_finished_song(false, 29.995, 30.));
    assert!(!play_rewinds_finished_song(false, 29.97, 30.), "a paused or sought spot near the end resumes there");
    assert!(!play_rewinds_finished_song(false, 29.5, 30.));
    assert!(!play_rewinds_finished_song(false, 0., 0.));
}

#[test]
fn a_completed_transport_counts_only_until_the_singer_seeks() {
    let now = Instant::now();
    let mut playhead = Playhead::new(0.);
    assert!(!playhead.transport_completed(), "no sample yet");
    let mut sample = clock_sample(now, 120.);
    sample.completed = true;
    sample.playing = false;
    playhead.admit(sample, now);
    assert!(playhead.transport_completed());
    playhead.seek(60.);
    assert!(!playhead.transport_completed(), "a sought spot is the singer's choice, not a finished song");
}

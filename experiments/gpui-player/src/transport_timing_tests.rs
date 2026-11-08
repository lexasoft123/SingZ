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
        explicit_graph: false,
        graph_nodes: 0,
        graph_connections: 0,
        #[cfg(feature="ui-tests")]
        observed_lanes: serde_json::Value::Null,
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

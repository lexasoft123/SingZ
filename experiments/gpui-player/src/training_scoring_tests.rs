use super::*;
use crate::training_domain::{Config, Role, Task, generate};
fn prompt(kind: Kind) -> Prompt {
    generate(&Config {
        kind,
        task: Task::Find,
        low: 60,
        high: 72,
        chord_degrees: vec![1],
        length: 30,
        ..Default::default()
    })
    .unwrap()
    .into_iter()
    .find(|p| p.targets[0].midi == 60 && (kind != Kind::Chord || p.role == Some(Role::Root)))
    .unwrap()
}
fn observation(at: f64, midi: Option<f64>, confidence: f64) -> Observation {
    Observation {
        at,
        midi,
        confidence,
        frequency: midi.map_or(0., |m| 440. * 2f64.powf((m - 69.) / 12.)),
    }
}
fn samples(midi: f64) -> Vec<Observation> {
    [200., 300., 400., 500., 600., 700., 800.]
        .into_iter()
        .map(|at| observation(at, Some(midi), 0.95))
        .collect()
}
fn run(observations: &[Observation]) -> TargetResult {
    score(
        &prompt(Kind::Note),
        &[Window {
            index: 0,
            start: 0.,
            end: 1000.,
        }],
        observations,
        None,
        Options::default(),
    )
    .unwrap()
    .remove(0)
}
#[test]
fn onset_and_release_are_excluded_from_octave_sensitive_scoring() {
    let mut observations = vec![
        observation(20., Some(67.), 0.95),
        observation(100., Some(67.), 0.95),
    ];
    observations.extend(samples(60.02));
    observations.extend([
        observation(930., Some(65.), 0.95),
        observation(990., Some(65.), 0.95),
    ]);
    let result = run(&observations);
    assert_eq!(result.classification, Classification::OnTarget);
    assert!((result.metrics.median_cents_error.unwrap() - 2.).abs() < 1e-8);
    assert!(result.metrics.voiced_coverage.unwrap() > 0.9);
}
#[test]
fn dense_burst_cannot_outvote_duration_weighted_pitch() {
    let mut observations = vec![
        observation(180., Some(59.92), 0.95),
        observation(300., Some(60.08), 0.95),
        observation(430., Some(59.95), 0.95),
        observation(560., Some(60.05), 0.95),
        observation(680., Some(60.), 0.95),
    ];
    observations.extend(
        (730..=820)
            .step_by(10)
            .map(|at| observation(at as f64, Some(if at == 780 { 72. } else { 60.8 }), 0.95)),
    );
    let result = run(&observations);
    assert_eq!(result.classification, Classification::OnTarget);
    assert!(result.metrics.median_cents_error.unwrap().abs() < 10.);
}
#[test]
fn silence_weak_confidence_and_repeated_single_instant_do_not_create_coverage() {
    assert_eq!(run(&[]).classification, Classification::Unvoiced);
    assert_eq!(
        run(&[observation(500., None, 0.95)]).classification,
        Classification::Unvoiced
    );
    let weak: Vec<_> = samples(60.)
        .into_iter()
        .map(|mut s| {
            s.confidence = 0.4;
            s
        })
        .collect();
    assert_eq!(run(&weak).classification, Classification::Unvoiced);
    let duplicates = vec![observation(500., Some(60.), 0.95); 100];
    let result = run(&duplicates);
    assert_eq!(result.classification, Classification::Unvoiced);
    assert!(result.metrics.voiced_coverage.unwrap() < 0.3);
}
#[test]
fn signed_bias_and_settling_time_keep_the_measured_octave() {
    let sharp = run(&samples(60.7));
    assert_eq!(sharp.classification, Classification::Close);
    assert!((sharp.metrics.median_cents_error.unwrap() - 70.).abs() < 1e-8);
    assert!(sharp.metrics.time_to_settle_ms.unwrap() >= 150.);
    let flat = run(&samples(59.8));
    assert_eq!(flat.classification, Classification::OnTarget);
    assert!((flat.metrics.median_cents_error.unwrap() + 20.).abs() < 1e-8);
    assert_eq!(
        run(&samples(72.)).classification,
        Classification::WrongOctave
    );
    assert_eq!(
        run(&samples(48.)).classification,
        Classification::WrongOctave
    );
    assert_eq!(run(&samples(63.)).classification, Classification::WrongNote);
    let unstable: Vec<_> = [180., 270., 360., 450., 540., 630., 720., 810.]
        .into_iter()
        .enumerate()
        .map(|(i, t)| observation(t, Some(if i % 2 == 0 { 59.2 } else { 60.8 }), 0.95))
        .collect();
    assert_eq!(run(&unstable).classification, Classification::Unstable);
}
#[test]
fn chord_errors_and_close_tones_follow_source_precedence() {
    let prompt = prompt(Kind::Chord);
    let windows = [Window {
        index: 0,
        start: 0.,
        end: 1000.,
    }];
    for (midi, class) in [
        (64., Classification::OtherChordTone),
        (62., Classification::NonChordTone),
        (60.7, Classification::Close),
    ] {
        let result = score(&prompt, &windows, &samples(midi), None, Default::default()).unwrap();
        assert_eq!(result[0].classification, class);
    }
    let range = score(
        &prompt,
        &windows,
        &samples(72.),
        Some((48, 67)),
        Default::default(),
    )
    .unwrap();
    assert_eq!(range[0].classification, Classification::OutOfRange);
}
#[test]
fn each_ordered_target_uses_its_own_elapsed_window() {
    let prompt = prompt(Kind::Arpeggio);
    let windows: Vec<_> = (0..3)
        .map(|i| Window {
            index: i,
            start: i as f64 * 1000.,
            end: (i + 1) as f64 * 1000.,
        })
        .collect();
    let observations: Vec<_> = prompt
        .targets
        .iter()
        .enumerate()
        .flat_map(|(i, target)| {
            samples(target.midi as f64 + 0.7)
                .into_iter()
                .map(move |mut s| {
                    s.at += i as f64 * 1000.;
                    s
                })
        })
        .collect();
    let results = score(&prompt, &windows, &observations, None, Default::default()).unwrap();
    assert_eq!(results.len(), 3);
    for (i, result) in results.iter().enumerate() {
        assert_eq!(result.index, i);
        assert_eq!(result.classification, Classification::Close);
        assert!((result.metrics.median_cents_error.unwrap() - 70.).abs() < 1e-8);
    }
}
#[test]
fn invalid_observations_windows_and_options_fail() {
    let prompt = prompt(Kind::Note);
    let windows = [Window {
        index: 0,
        start: 0.,
        end: 1000.,
    }];
    let mut bad = observation(500., Some(60.), 0.95);
    bad.frequency = 880.;
    assert!(score(&prompt, &windows, &[bad], None, Default::default()).is_err());
    bad = observation(500., None, 0.95);
    bad.frequency = 440.;
    assert!(score(&prompt, &windows, &[bad], None, Default::default()).is_err());
    assert!(
        score(
            &prompt,
            &[Window {
                index: 1,
                start: 0.,
                end: 1000.
            }],
            &[],
            None,
            Default::default()
        )
        .is_err()
    );
    assert!(
        score(
            &prompt,
            &windows,
            &[],
            None,
            Options {
                maximum_gap: 0.,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert!(
        score(
            &prompt,
            &windows,
            &[],
            None,
            Options {
                confidence: 1.1,
                ..Default::default()
            }
        )
        .is_err()
    );
    assert_eq!(fractional_midi(440.), Some(69.));
    assert_eq!(fractional_midi(880.), Some(81.));
    assert_eq!(fractional_midi(0.), None);
    let mut damaged = self::prompt(Kind::Chord);
    damaged.chord = None;
    assert!(score(&damaged, &windows, &samples(60.), None, Default::default()).is_err());
}
#[test]
fn completed_lock_uses_final_hold_and_recent_capture() {
    let prompt = prompt(Kind::Note);
    let windows = [Window {
        index: 0,
        start: 0.,
        end: 5000.,
    }];
    let observations: Vec<_> = (3000..=5000)
        .step_by(20)
        .map(|t| observation(t as f64, Some(if t < 3500 { 63. } else { 60.02 }), 0.95))
        .collect();
    let result = completed_target(
        &prompt,
        &windows,
        &observations,
        None,
        Default::default(),
        Some(1500.),
    )
    .unwrap();
    assert_eq!(result.classification, Classification::OnTarget);
    assert!((result.metrics.median_cents_error.unwrap() - 2.).abs() < 1e-8);
    assert!(result.metrics.voiced_coverage.unwrap() > 0.99);
    assert!(
        completed_target(
            &prompt,
            &windows,
            &observations,
            None,
            Default::default(),
            Some(0.)
        )
        .is_err()
    );
}

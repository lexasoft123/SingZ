use super::*;
use std::collections::BTreeSet;
#[test]
fn guided_references_reveal_only_the_current_target() {
    for kind in [Kind::Note, Kind::Interval, Kind::Chord, Kind::Scale] {
        let prompt = generate(&Config {
            kind,
            length: 1,
            ..Default::default()
        })
        .unwrap()
        .remove(0);
        let refs = prompt.references(true);
        match kind {
            Kind::Note => {
                assert_eq!(refs.len(), 1);
                assert_eq!(refs[0].duration_seconds, 2.75);
                assert_eq!(refs[0].cue.notes, vec![prompt.targets[0].midi]);
            }
            Kind::Interval => {
                assert_eq!(refs[0].duration_seconds, 4.);
                assert_eq!(refs[0].cue.notes.len(), 1);
                assert!(prompt.needs_target_reference(true));
            }
            Kind::Chord => {
                assert_eq!(refs.len(), 2);
                assert!(refs[0].cue.together);
                assert_eq!(refs[0].cue.purpose, Purpose::Question);
            }
            Kind::Scale => {
                assert_eq!(refs[0].cue.notes.len(), 1);
                assert_eq!(prompt.references(false)[0].cue.notes.len(), 8);
                assert!(!prompt.needs_target_reference(false));
            }
            _ => unreachable!(),
        }
    }
    let prompt = generate(&Config {
        kind: Kind::Interval,
        task: Task::Identify,
        length: 1,
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(prompt.references(true)[0].cue.notes.len(), 2);
    assert!(!prompt.needs_target_reference(true));
}
#[test]
fn source_instructions_use_musical_spelling_and_direction() {
    let prompts = generate(&Config {
        kind: Kind::Interval,
        task: Task::Find,
        tonic: 0,
        intervals: vec![3],
        direction: DirectionChoice::Ascending,
        length: 16,
        ..Default::default()
    })
    .unwrap();
    let c = prompts
        .iter()
        .find(|p| p.targets.iter().map(|t| t.midi).collect::<Vec<_>>() == vec![60, 64])
        .unwrap();
    assert_eq!(c.instruction(), "Sing major third ascending — C4 to E4.");
    let identify = generate(&Config {
        kind: Kind::Chord,
        task: Task::Identify,
        length: 1,
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(identify.instruction(), "Identify the chord tone.");
}
fn pitches(prompts: &[Prompt]) -> Vec<Vec<u8>> {
    prompts
        .iter()
        .map(|p| p.targets.iter().map(|t| t.midi).collect())
        .collect()
}
#[test]
fn seeded_rng_preserves_utf16_and_wrapping_math() {
    // Vectors calculated independently with unsigned 32-bit arithmetic over
    // UTF-16LE code units, including the surrogate pair in the final seed.
    for (seed, expected) in [
        ("", [2625274932u32, 2119670693, 3324411561, 1770755366]),
        ("lesson-1", [3487017757, 2065923246, 3676899260, 2222191450]),
        ("42", [1321692771, 1578880846, 993578597, 75544504]),
        ("голос🎶", [2148474580, 2833856486, 4245966739, 1723950008]),
    ] {
        let mut rng = Rng::new(seed);
        for value in expected {
            assert_eq!((rng.next() * 4294967296.) as u32, value);
        }
    }
}
#[test]
fn every_eligible_note_before_repeating_and_no_round_boundary_repeat() {
    let eligible = vec![48, 50, 52, 53, 55, 57, 59, 60, 62, 64, 65, 67, 69, 71, 72];
    for kind in [Kind::Note, Kind::Degree] {
        for seed in 0..50 {
            let config = Config {
                kind,
                seed: seed.to_string(),
                length: 45,
                ..Default::default()
            };
            let prompts = generate(&config).unwrap();
            let notes: Vec<_> = prompts.iter().map(|p| p.targets[0].midi).collect();
            for round in notes.chunks(15) {
                let mut round = round.to_vec();
                round.sort();
                assert_eq!(round, eligible);
            }
            assert!(notes.windows(2).all(|pair| pair[0] != pair[1]));
            assert_eq!(prompts, generate(&config).unwrap());
        }
    }
}
#[test]
fn mixed_rounds_preserve_each_kind_and_harmonic_minor() {
    let prompts = generate(&Config {
        kind: Kind::Mixed,
        tonic: 9,
        minor: true,
        harmonic_scale: true,
        low: 57,
        high: 69,
        mixed_kinds: vec![Kind::Degree, Kind::Note],
        length: 32,
        ..Default::default()
    })
    .unwrap();
    for kind in [Kind::Note, Kind::Degree] {
        let notes: Vec<_> = prompts
            .iter()
            .filter(|p| p.kind == kind)
            .map(|p| p.targets[0].midi)
            .collect();
        for round in notes.chunks(8) {
            let mut round = round.to_vec();
            round.sort();
            assert_eq!(round, [57, 59, 60, 62, 64, 65, 68, 69]);
        }
    }
}
#[test]
fn all_chord_placements_and_balanced_roles() {
    for seed in 0..30 {
        let mut config = Config {
            kind: Kind::Chord,
            task: Task::Find,
            low: 48,
            high: 79,
            chord_degrees: vec![1],
            length: 18,
            seed: seed.to_string(),
            ..Default::default()
        };
        let prompts = generate(&config).unwrap();
        let unique: BTreeSet<_> = prompts[..9].iter().map(|p| p.targets[0].midi).collect();
        assert_eq!(unique, BTreeSet::from([48, 52, 55, 60, 64, 67, 72, 76, 79]));
        for triple in prompts.chunks(3) {
            assert_eq!(
                triple
                    .iter()
                    .map(|p| p.role.unwrap() as u8)
                    .collect::<BTreeSet<_>>()
                    .len(),
                3
            );
        }
        config.kind = Kind::Arpeggio;
        config.length = 6;
        assert_eq!(
            pitches(&generate(&config).unwrap())
                .into_iter()
                .collect::<BTreeSet<_>>(),
            BTreeSet::from([
                vec![48, 52, 55],
                vec![55, 52, 48],
                vec![60, 64, 67],
                vec![67, 64, 60],
                vec![72, 76, 79],
                vec![79, 76, 72]
            ])
        );
    }
}
#[test]
fn interval_placements_and_categories() {
    let mut config = Config {
        kind: Kind::Interval,
        task: Task::Find,
        intervals: vec![8],
        direction: DirectionChoice::Ascending,
        length: 8,
        ..Default::default()
    };
    assert_eq!(
        pitches(&generate(&config).unwrap())
            .into_iter()
            .collect::<BTreeSet<_>>(),
        BTreeSet::from([
            vec![48, 60],
            vec![50, 62],
            vec![52, 64],
            vec![53, 65],
            vec![55, 67],
            vec![57, 69],
            vec![59, 71],
            vec![60, 72]
        ])
    );
    config.intervals = vec![2, 3, 8];
    config.direction = DirectionChoice::Both;
    config.length = 6;
    let prompts = generate(&config).unwrap();
    assert_eq!(
        prompts
            .iter()
            .map(|p| p.category())
            .collect::<BTreeSet<_>>()
            .len(),
        6
    );
}
#[test]
fn imitation_intervals_repeat_three_times_and_grow_by_distance() {
    let config = Config {
        kind: Kind::Interval,
        length: 30,
        ..Default::default()
    };
    let prompts = generate(&config).unwrap();
    let mut last = 0;
    for triple in prompts.chunks(3) {
        assert!(triple.windows(2).all(|p| p[0].targets == p[1].targets));
        let distance = triple[0].targets[0]
            .midi
            .abs_diff(triple[0].targets[1].midi);
        assert!(distance >= last);
        last = distance;
    }
    let focused = generate(&Config {
        interval_semitones: Some(4),
        ..config
    })
    .unwrap();
    assert!(
        focused
            .iter()
            .all(|p| p.targets[0].midi.abs_diff(p.targets[1].midi) == 4)
    );
}
#[test]
fn dominant_harmony_is_independent_of_scale_form() {
    let config = Config {
        kind: Kind::Arpeggio,
        tonic: 9,
        minor: true,
        harmonic_scale: true,
        chord_degrees: vec![5],
        length: 6,
        ..Default::default()
    };
    for prompt in generate(&config).unwrap() {
        let chord = prompt.chord.unwrap();
        assert_eq!(chord.root_name, "E");
        assert_eq!(chord.quality, Quality::Major);
        assert_eq!(
            chord.tones.iter().map(|t| t.midi % 12).collect::<Vec<_>>(),
            [4, 8, 11]
        );
        assert!(chord.tones[1].note_name.starts_with("G♯"));
    }
    for prompt in generate(&Config {
        chord_degrees: vec![3],
        ..config
    })
    .unwrap()
    {
        let chord = prompt.chord.unwrap();
        assert_eq!(chord.quality, Quality::Major);
        assert_eq!(
            chord.tones.iter().map(|t| t.midi % 12).collect::<Vec<_>>(),
            [0, 4, 7]
        );
    }
}
#[test]
fn cue_purposes_and_context_survive_narrow_singing_range() {
    let config = Config {
        low: 60,
        high: 61,
        length: 10,
        task: Task::Find,
        ..Default::default()
    };
    for p in generate(&config).unwrap() {
        assert_eq!(p.targets[0].midi, 60);
        assert_eq!(p.cues.len(), 1);
        assert_eq!(p.cues[0], cue(Purpose::Context, true, vec![60, 64, 67]));
    }
    let find = generate(&Config {
        kind: Kind::Chord,
        task: Task::Find,
        length: 1,
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(find.cues.len(), 2);
    assert!(find.cues[1].together);
    assert_eq!(find.cues[1].purpose, Purpose::Question);
    let identify = generate(&Config {
        kind: Kind::Interval,
        task: Task::Identify,
        length: 1,
        ..Default::default()
    })
    .unwrap()
    .remove(0);
    assert_eq!(identify.cues[1].notes.len(), 2);
    assert_eq!(identify.cues[1].purpose, Purpose::Question);
}
#[test]
fn scales_use_full_octave_and_selected_direction() {
    for direction in [DirectionChoice::Ascending, DirectionChoice::Descending] {
        let prompts = generate(&Config {
            kind: Kind::Scale,
            direction,
            length: 4,
            ..Default::default()
        })
        .unwrap();
        for p in prompts {
            assert_eq!(p.targets.len(), 8);
            assert_eq!(p.targets[0].midi.abs_diff(p.targets[7].midi), 12);
            assert!(
                p.targets
                    .windows(2)
                    .all(|pair| if direction == DirectionChoice::Ascending {
                        pair[0].midi < pair[1].midi
                    } else {
                        pair[0].midi > pair[1].midi
                    })
            );
        }
    }
    assert!(
        generate(&Config {
            kind: Kind::Scale,
            task: Task::Identify,
            ..Default::default()
        })
        .is_err()
    );
}
#[test]
fn all_keys_families_and_tasks_keep_targets_legal() {
    for tonic in 0..12 {
        for minor in [false, true] {
            for kind in [
                Kind::Note,
                Kind::Degree,
                Kind::Interval,
                Kind::Chord,
                Kind::Arpeggio,
                Kind::Scale,
                Kind::Mixed,
            ] {
                for task in [Task::Imitate, Task::Find, Task::Identify] {
                    if kind == Kind::Scale && task != Task::Imitate {
                        continue;
                    }
                    let config = Config {
                        tonic,
                        minor,
                        kind,
                        task,
                        length: 12,
                        ..Default::default()
                    };
                    let prompts = generate(&config).unwrap();
                    assert_eq!(prompts.len(), 12);
                    for (index, p) in prompts.iter().enumerate() {
                        assert_eq!(p.index, index + 1);
                        assert!(p.targets.iter().all(|t|(48..=72).contains(&t.midi)&&(1..=7).contains(&t.degree)));
                        assert!(
                            p.cues
                                .iter()
                                .all(|c| !c.notes.is_empty() && c.notes.iter().all(|m| *m <= 127))
                        );
                    }
                }
            }
        }
    }
}
#[test]
fn invalid_config_and_impossible_range_fail_before_a_session_exists() {
    for config in [
        Config {
            tonic: 12,
            ..Default::default()
        },
        Config {
            low: 72,
            high: 48,
            ..Default::default()
        },
        Config {
            high: 128,
            ..Default::default()
        },
        Config {
            length: 1001,
            ..Default::default()
        },
        Config {
            length: 0,
            ..Default::default()
        },
        Config {
            kind: Kind::Interval,
            intervals: vec![],
            ..Default::default()
        },
        Config {
            intervals: vec![3, 3],
            ..Default::default()
        },
        Config {
            mixed_kinds: vec![Kind::Scale],
            ..Default::default()
        },
        Config {
            kind: Kind::Arpeggio,
            low: 60,
            high: 61,
            ..Default::default()
        },
    ] {
        assert!(generate(&config).is_err());
    }
}

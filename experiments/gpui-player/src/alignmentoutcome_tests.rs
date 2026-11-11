use super::*;
#[test]
fn ctc_grouping_matches_source_unknown_line_denominator_and_cancels_large_inputs() {
    let r = song();
    let words = ctc(&r, 2., 0.8);
    let count = std::cell::Cell::new(0usize);
    let cancel = || {
        count.set(count.get() + 1);
        count.get() > 3
    };
    let many = vec![words[0].clone(); 100000];
    assert!(ctc_outcome_cancellable(&r, &many, 60., &cancel).is_err());
    assert!(
        count.get() < 10,
        "Cancellation was not polled while grouping words"
    );
    let mut unknown = words.clone();
    for word in &mut unknown {
        if word.li < 3 {
            word.score = 0.005;
        }
    }
    for li in 99..102 {
        unknown.push(CtcWord {
            li,
            wi: 0,
            s: 1.,
            e: 2.,
            score: 0.8,
            voiced: None,
        });
    }
    assert_eq!(
        forced_lines_cancellable(&r, &unknown, 0.02, &|| false).unwrap(),
        BTreeSet::from([0, 1, 2])
    );
}
#[test]
fn long_saved_words_remain_supported_and_pathological_work_is_refused_or_cancelled() {
    let text = "a".repeat(1024);
    let r = reference(&[&text]);
    let hyp = sung(&r, 1.);
    assert_eq!(global_anchors(&r, &hyp).unwrap().len(), 1);
    let many = reference(&vec![text.as_str(); 100]);
    assert!(
        global_anchors(&many, &sung(&many, 0.))
            .unwrap_err()
            .to_string()
            .contains("work budget")
    );
    assert!(
        global_anchors_cancellable(
            &r,
            &[Word {
                w: "b".repeat(1024),
                s: 1.,
                e: 2.
            }],
            &|| true
        )
        .is_err()
    );
}
fn reference(texts: &[&str]) -> Vec<Line> {
    let mut at = 0.;
    texts
        .iter()
        .map(|text| {
            let start = at;
            let words = text
                .split(' ')
                .map(|w| {
                    let s = at;
                    at += (utf16_len(w) + 1) as f64 / 12.;
                    Word {
                        w: w.into(),
                        s,
                        e: at,
                    }
                })
                .collect();
            let line = Line {
                start,
                end: at,
                text: (*text).into(),
                words,
            };
            at += 1.;
            line
        })
        .collect()
}
fn song() -> Vec<Line> {
    reference(&[
        "take a breath and find your sound",
        "come and sing along with me",
        "every voice can learn to fly",
        "you were born to make this sound",
    ])
}
fn sung(lines: &[Line], shift: f64) -> Vec<Word> {
    lines
        .iter()
        .flat_map(|l| {
            l.words.iter().map(move |w| Word {
                w: w.w.clone(),
                s: w.s + shift,
                e: w.e + shift,
            })
        })
        .collect()
}
fn ctc(lines: &[Line], shift: f64, score: f64) -> Vec<CtcWord> {
    lines
        .iter()
        .enumerate()
        .flat_map(|(li, l)| {
            l.words.iter().enumerate().map(move |(wi, w)| CtcWord {
                li,
                wi,
                s: w.s + shift,
                e: w.e + shift,
                score,
                voiced: None,
            })
        })
        .collect()
}
#[test]
fn source_global_alignment_recovers_shift_and_preserves_actual_match() {
    let r = song();
    let o = align_to_transcription(&r, &sung(&r, 3.1), 60., "qwen").unwrap();
    assert_eq!(o.check.verdict, "retimed");
    assert_eq!(o.check.matched_pct, 100.);
    assert_eq!(o.check.median_shift, 3.1);
    for (l, original) in o.lines.iter().zip(&r) {
        for (w, old) in l.words.iter().zip(&original.words) {
            assert!((w.s - old.s - 3.1).abs() < 1e-9);
        }
    }
    assert_eq!(
        align_to_transcription(&r, &sung(&r, 0.05), 60., "qwen")
            .unwrap()
            .check
            .verdict,
        "match"
    );
}
#[test]
fn wrong_song_returns_original_without_claiming_retiming() {
    let r = song();
    let other = reference(&[
        "the wheels on the bus go round and round",
        "london bridge is falling down my fair lady",
        "twinkle twinkle little star how i wonder",
    ]);
    let o = align_to_transcription(&r, &sung(&other, 0.), 60., "qwen").unwrap();
    assert_eq!(o.check.verdict, "mismatch");
    assert_eq!(o.lines, r);
}
#[test]
fn noisy_transcription_and_missing_line_do_not_destroy_order() {
    let r = song();
    let mut hyp = sung(&r, 1.5);
    hyp.iter_mut().enumerate().for_each(|(i, w)| {
        if (13..19).contains(&i) {
            w.w = "na".into();
        } else if w.w == "breath" {
            w.w = "breathe".into();
        }
    });
    let o = align_to_transcription(&r, &hyp, 60., "qwen").unwrap();
    assert!(o.check.bad_lines.contains(&2));
    let flat: Vec<_> = o.lines.iter().flat_map(|l| l.words.iter()).collect();
    assert!(flat.windows(2).all(|w| w[1].s >= w[0].s));
}
#[test]
fn hypothesis_sanitizer_rejects_music_rewinds_and_collapsed_segments() {
    let hyp = vec![
        Word {
            w: "♪".into(),
            s: 0.,
            e: 1.,
        },
        Word {
            w: "one".into(),
            s: 1.,
            e: 1.,
        },
        Word {
            w: "two".into(),
            s: 2.,
            e: 2.3,
        },
        Word {
            w: "back".into(),
            s: 0.2,
            e: 0.4,
        },
        Word {
            w: "three".into(),
            s: 3.,
            e: 3.2,
        },
    ];
    let out = sanitize_hyp(&hyp);
    assert_eq!(
        out.iter().map(|w| w.w.as_str()).collect::<Vec<_>>(),
        ["one", "two", "three"]
    );
    assert_eq!(out[0].e, 1.15);
    let collapse = vec![
        Word {
            w: "But".into(),
            s: 1.,
            e: 2.,
        },
        Word {
            w: "I".into(),
            s: 1.,
            e: 2.,
        },
        Word {
            w: "know".into(),
            s: 1.,
            e: 2.,
        },
    ];
    assert_eq!(sanitize_hyp(&collapse).len(), 1);
}
#[test]
fn pronunciation_matching_handles_split_and_joined_words() {
    assert_eq!(word_sim("breath", "breathe"), 0.85);
    assert_eq!(word_sim("short", "unrelated"), 0.);
    let r = reference(&["outta time"]);
    let h = vec![
        Word {
            w: "out".into(),
            s: 2.,
            e: 2.3,
        },
        Word {
            w: "ta".into(),
            s: 2.3,
            e: 2.5,
        },
        Word {
            w: "time".into(),
            s: 2.5,
            e: 3.,
        },
    ];
    let a = global_anchors(&r, &h).unwrap();
    assert_eq!(a.len(), 2);
    assert_eq!((a[0].s, a[0].e), (2., 2.5));
}
#[test]
fn language_romanization_and_hallucination_rules_match_source() {
    assert_eq!(
        guess_language(&reference(&[
            "the wind and the rain",
            "all that you wanted was this"
        ])),
        Some("en")
    );
    assert_eq!(
        guess_language(&reference(&[
            "wenn ich nicht schlafen kann",
            "und du bist nicht ein traum"
        ])),
        Some("de")
    );
    assert_eq!(
        guess_language(&reference(&["Журавли летят над полем"])),
        Some("ru")
    );
    assert_eq!(
        guess_language(&reference(&["lorem ipsum dolor sit amet"])),
        None
    );
    assert_eq!(romanize("Журавли"), "zhuravli");
    assert_eq!(romanize("café Ändern don't …"), "cafeanderndon't");
    let loops: Vec<_> = (0..20)
        .map(|i| Word {
            w: if i % 2 == 0 {
                "следует..."
            } else {
                "Продолжение"
            }
            .into(),
            s: i as f64 * 3.,
            e: i as f64 * 3. + 1.,
        })
        .collect();
    assert!(!transcription_usable(&loops, 150));
    assert!(transcription_usable(&sung(&song(), 0.), 27));
}
#[test]
fn ctc_confident_and_uniformly_low_scores_retime_but_catastrophe_does_not() {
    let r = song();
    for score in [0.8, 0.04] {
        let o = ctc_outcome(&r, &ctc(&r, 2., score), 60.);
        assert_eq!(o.check.verdict, "retimed");
        assert_eq!(o.check.matched_pct, 100.);
        assert!((o.lines[0].start - r[0].start - 2.).abs() < 1e-9);
    }
    let o = ctc_outcome(&r, &ctc(&r, 2., 0.001), 60.);
    assert_eq!(o.check.verdict, "mismatch");
    assert_eq!(o.lines, r);
}
#[test]
fn ctc_silent_tail_and_slipped_stretch_cannot_anchor() {
    let r = song();
    let mut words = ctc(&r, 2., 0.8);
    for w in &mut words {
        if w.li >= 2 {
            w.s = 55. + w.li as f64 * 0.5 + w.wi as f64 * 0.1;
            w.e = w.s + 0.1;
            w.score = 0.02;
            w.voiced = Some(0.);
        }
    }
    let o = ctc_outcome(&r, &words, 60.);
    for li in 2..4 {
        assert!((o.lines[li].start - r[li].start - 2.).abs() < 1e-8);
    }
    let mut words = ctc(&r, 2., 0.8);
    for w in &mut words {
        if (1..=2).contains(&w.li) {
            w.s += 7.;
            w.e += 7.;
            w.score = 0.012;
            w.voiced = Some(0.8);
        }
    }
    let o = ctc_outcome(&r, &words, 60.);
    assert_eq!(o.slipped, [1, 2]);
    for li in 1..=2 {
        assert!((o.lines[li].start - r[li].start - 2.).abs() < 1.);
    }
}
#[test]
fn forced_run_bridges_only_one_confident_line_and_uses_lower_even_median() {
    let texts = vec!["take a breath and find your sound"; 8];
    let r = reference(&texts);
    let scores = [0.8, 0.01, 0.05, 0.01, 0.8, 0.8, 0.8, 0.8];
    let mut words = ctc(&r, 0., 0.8);
    for w in &mut words {
        w.score = scores[w.li];
    }
    assert_eq!(forced_lines(&r, &words, 0.02), BTreeSet::from([1, 2, 3]));
    for w in &mut words {
        w.score = 0.005;
    }
    assert!(forced_lines(&r, &words, 0.02).is_empty());
    let r = reference(&[
        "hold on",
        "and sing it out",
        "one more time",
        "all together now",
    ]);
    let mut words = ctc(&r, 0., 0.8);
    for w in &mut words {
        if w.li == 0 {
            w.score = if w.wi == 0 { 0.005 } else { 0.9 };
        }
    }
    assert!(forced_lines(&r, &words, 0.02).contains(&0));
}
#[test]
fn chunk_assignment_loop_detection_and_text_grouping_match_source() {
    assert_eq!(
        assign_words_to_chunks(5, &HashMap::from([(0, 2), (4, 3)])),
        [2, 2, 2, 2, 3]
    );
    assert_eq!(
        assign_words_to_chunks(4, &HashMap::from([(2, 5)])),
        [5, 5, 5, 5]
    );
    assert!(looks_looped(&["oh"; 12].join(", "), Some("stop")));
    assert!(!looks_looped(
        "du hast, du hast, du hast, du hast",
        Some("stop")
    ));
    let c = ChunkText {
        start: 0.,
        end: 12.,
        text: vec!["la"; 25].join(" "),
        label: Some("English".into()),
    };
    let lines = lines_from_chunks(&[c]);
    assert_eq!(
        lines.iter().map(|l| l.words.len()).collect::<Vec<_>>(),
        [10, 10, 5]
    );
    assert!((lines[2].end - 12.).abs() < 1e-9);
}

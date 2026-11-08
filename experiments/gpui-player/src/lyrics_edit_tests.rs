use super::*;

fn line(start: f64, end: f64, text: &str) -> Line {
    Line {
        start,
        end,
        text: text.into(),
        words: distribute_row_words(text, start, end),
    }
}
fn row(start: Option<f64>, text: &str, end: Option<f64>) -> DraftRow {
    DraftRow {
        id: fresh_row_id(),
        start,
        end,
        text: text.into(),
        words: None,
    }
}
fn close(a: f64, b: f64) {
    assert!((a - b).abs() < 1e-9, "{a} differs from {b}");
}

#[test]
fn timed_source_lines_and_word_spans_round_trip_exactly() {
    let source = vec![
        line(10., 13., "hello world"),
        line(20., 24., "second line here"),
    ];
    let rows = rows_from_lines(&source);
    assert_eq!(lines_from_rows(&rows, 300.), source);
    assert_ne!(rows[0].id, rows[1].id);
    let again = rows_from_lines(&source);
    assert_ne!(rows[0].id, again[0].id);
}

#[test]
fn an_untimed_run_uses_centered_singing_pace_inside_its_gap() {
    let rows = vec![
        row(Some(10.), "first", Some(12.)),
        row(None, "middle words", None),
        row(Some(30.), "last", Some(33.)),
    ];
    let output = lines_from_rows(&rows, 300.);
    close(output[1].start, 20.4);
    close(output[1].end, 21.6);
    assert_eq!(output[0].start, 10.);
    assert_eq!(output[2].start, 30.);
}

#[test]
fn fully_untimed_and_unknown_duration_follow_source_centering() {
    let rows = vec![
        row(None, "one one one one", None),
        row(None, "two two two two", None),
        row(None, "three", None),
    ];
    let output = lines_from_rows(&rows, 60.);
    close(output[0].start, 28.15);
    close(output[0].end, 29.4);
    close(output[2].end, 31.85);
    let unknown = lines_from_rows(&[row(None, "new", None)], 0.);
    close(unknown[0].start, 1.4);
    close(unknown[0].end, 2.6);
}

#[test]
fn runs_compress_into_short_gaps_and_stamps_stay_monotonic_capped() {
    let output = lines_from_rows(
        &[
            row(Some(0.), "first", Some(2.)),
            row(None, "one", None),
            row(None, "two", None),
            row(Some(3.), "last", Some(5.)),
        ],
        4.,
    );
    close(output[1].start, 2.);
    close(output[1].end, 2.5);
    close(output[2].start, 2.5);
    close(output[2].end, 3.);
    close(output[3].end, 4.);
    let bad = lines_from_rows(
        &[
            row(Some(20.), "later first", Some(24.)),
            row(Some(5.), "stamped earlier", None),
            row(None, "  ", None),
        ],
        22.,
    );
    assert_eq!(bad.len(), 2);
    assert_eq!((bad[0].start, bad[0].end), (20., 22.));
    assert_eq!((bad[1].start, bad[1].end), (22., 22.));
}

#[test]
fn changed_text_redistributes_words_while_exact_text_preserves_them() {
    let mut rows = rows_from_lines(&[line(10., 14., "the old words here")]);
    rows[0].text = "entirely new text".into();
    assert!(!words_match_text(&rows[0]));
    let out = lines_from_rows(&rows, 300.);
    assert_eq!(
        out[0]
            .words
            .iter()
            .map(|w| w.w.as_str())
            .collect::<Vec<_>>(),
        ["entirely", "new", "text"]
    );
    close(out[0].words[0].s, 10.);
    close(out[0].words[2].e, 14.);
}

#[test]
fn utf16_character_weights_and_ecmascript_whitespace_are_preserved() {
    assert_eq!(utf16_len("a😀"), 3);
    let words = distribute_row_words("😀 a", 0., 5.);
    close(words[0].e, 3.);
    close(words[1].s, 3.);
    close(words[1].e, 5.);
    close(estimate_line_end(&"😀".repeat(60), 0.), 9.);
    let words = distribute_row_words("\u{feff}one\u{00a0}two\u{0085}three\u{feff}", 0., 3.);
    assert_eq!(
        words.iter().map(|w| w.w.as_str()).collect::<Vec<_>>(),
        ["one", "two\u{0085}three"]
    );
    assert_eq!(lines_from_rows(&[row(None, "\u{feff}", None)], 3.), []);
}

#[test]
fn replacement_lcs_carries_surviving_times_and_allocates_fresh_identities() {
    let rows = rows_from_lines(&[
        line(10., 13., "In the summertime"),
        line(20., 23., "Thank you."),
        line(30., 33., "my frozen pain comes back"),
    ]);
    let next = replace_all_text(
        &rows,
        "In the summertime\nmy frozen pain comes back\na brand new verse",
    )
    .unwrap();
    assert_eq!(
        next.iter().map(|r| r.start).collect::<Vec<_>>(),
        [Some(10.), Some(30.), None]
    );
    assert_eq!(next[0].words, rows[0].words);
    assert!(next.iter().all(|r| rows.iter().all(|old| old.id != r.id)));
}

#[test]
fn replacement_keeps_unicode_letters_numbers_apostrophe_but_not_marks() {
    let rows = rows_from_lines(&[
        line(10., 13., "reading in, reading in"),
        line(20., 22., "İ ΣΟΣ café e\u{301} ٣ 'time'😀"),
    ]);
    let next = replace_all_text(&rows, "Reading in reading in\r\nİ ΣΟΣ café e ٣ 'time'").unwrap();
    assert_eq!(next[0].start, Some(10.));
    assert_eq!(next[0].words, None);
    assert_eq!(next[1].start, Some(20.));
    assert_eq!(next[1].words, None);
    assert_eq!(
        normalized_line("İ ΣΟΣ café e\u{301} ٣ 'time'😀"),
        "i σος café e ٣ 'time'"
    );
    // Non-space whitespace is removed before collapsing, exactly as source.
    assert_eq!(normalized_line("a\tb"), "ab");
}

#[test]
fn lcs_ties_drop_the_old_line_first_and_punctuation_only_never_matches() {
    let rows = vec![row(Some(1.), "A", Some(2.)), row(Some(3.), "B", Some(4.))];
    let next = replace_all_text(&rows, "B\nA").unwrap();
    assert_eq!(next[0].start, Some(3.));
    assert_eq!(next[1].start, None);
    let punctuation = replace_all_text(&[row(Some(5.), "!!!", Some(6.))], "???").unwrap();
    assert_eq!(punctuation[0].start, None);
}

#[test]
fn replacement_refuses_table_before_unbounded_allocation_without_truncating() {
    let mut rows = Vec::new();
    for _ in 0..4096 {
        rows.push(row(None, "kept", None));
    }
    assert!(replace_all_text(&rows, &"kept\n".repeat(4096)).is_err());
    let small = replace_all_text(&rows[..2], "kept\nkept\nnew").unwrap();
    assert_eq!(small.len(), 3);
}

#[test]
fn split_merge_and_stamping_keep_identity_timing_and_focus_contracts() {
    let first = row(Some(2.), "😀 hello world", Some(8.));
    let second = row(Some(10.), "second", Some(12.));
    let rows = vec![first.clone(), second.clone()];
    let split = split_row(&rows, first.id, 8).unwrap();
    assert_eq!(split.rows[0].text, "😀 hello");
    assert_eq!(split.rows[1].text, "world");
    assert_eq!(split.rows[0].id, first.id);
    assert_eq!(split.rows[0].start, Some(2.));
    assert_eq!(split.rows[0].end, None);
    assert_eq!(split.rows[1].start, None);
    assert_eq!(
        split.focus,
        Some(FocusTarget {
            id: split.rows[1].id,
            caret_utf16: Some(0)
        })
    );
    let merged = merge_up(&split.rows, split.rows[1].id).unwrap();
    assert_eq!(merged.rows[0].id, first.id);
    assert_eq!(merged.rows[0].text, first.text);
    assert_eq!(merged.rows[0].end, None);
    assert_eq!(merged.focus.unwrap().caret_utf16, Some(9));
    let stamp = stamp_row(&rows, first.id, 3.456).unwrap();
    assert_eq!(stamp.rows[0].start, Some(3.46));
    assert_eq!(stamp.rows[0].end, None);
    assert_eq!(stamp.rows[0].words, None);
    assert_eq!(
        stamp.focus,
        Some(FocusTarget {
            id: second.id,
            caret_utf16: None
        })
    );
    assert_eq!(
        stamp_row(&rows, first.id, -1.).unwrap().rows[0].start,
        Some(0.)
    );
    assert!(merge_up(&rows, first.id).is_none());
    assert!(stamp_row(&rows, first.id, f64::NAN).is_none());
}

#[test]
fn native_caret_conversion_never_splits_utf8_scalars() {
    let text = "a😀b";
    assert_eq!(byte_at_utf16(text, 0), 0);
    assert_eq!(byte_at_utf16(text, 1), 1);
    assert_eq!(byte_at_utf16(text, 2), 1);
    assert_eq!(byte_at_utf16(text, 3), 5);
    assert_eq!(byte_at_utf16(text, 99), 6);
    assert_eq!(utf16_at_byte(text, 5), 3);
}

#[test]
fn add_delete_and_multiline_paste_retain_empty_row_and_source_timing_policy() {
    let empty = row(Some(8.), " ", Some(10.));
    let pasted = insert_pasted(&[empty.clone()], empty.id, " first \r\n\n second ").unwrap();
    assert_eq!(pasted.rows.len(), 2);
    assert_eq!(pasted.rows[0].start, Some(8.));
    assert_eq!(pasted.rows[0].end, Some(10.));
    assert_ne!(pasted.rows[0].id, empty.id);
    assert_eq!(pasted.rows[1].start, None);
    let nonempty = row(Some(1.), "existing", Some(2.));
    let pasted = insert_pasted(&[nonempty.clone()], nonempty.id, "new\nnewer").unwrap();
    assert_eq!(pasted.rows[0], nonempty);
    assert_eq!(pasted.rows.len(), 3);
    let added = add_row_after(&[nonempty.clone()], nonempty.id).unwrap();
    assert_eq!(added.rows.len(), 2);
    assert_eq!(added.focus.unwrap().id, added.rows[1].id);
    let deleted = delete_row(&[nonempty.clone()], nonempty.id).unwrap();
    assert_eq!(deleted.rows.len(), 1);
    assert!(deleted.rows[0].text.is_empty());
    assert_ne!(deleted.rows[0].id, nonempty.id);
    assert!(insert_pasted(&[empty.clone()], empty.id, "\n \n").is_none());
}

#[test]
fn text_edit_keeps_start_end_but_invalidates_word_alignment() {
    let rows = rows_from_lines(&[line(2., 4., "hello world")]);
    let edit = set_text(&rows, rows[0].id, "changed".into()).unwrap();
    assert_eq!(edit.rows[0].start, Some(2.));
    assert_eq!(edit.rows[0].end, Some(4.));
    assert_eq!(edit.rows[0].words, None);
    assert_eq!(edit.rows[0].id, rows[0].id);
}

#[test]
fn history_bounds_snapshots_and_clears_redo_after_new_action() {
    let mut h = History::default();
    let mut rows = vec![empty_row()];
    for i in 0..101 {
        h.snapshot(&rows);
        rows[0].text = i.to_string();
    }
    let mut count = 0;
    while let Some(old) = h.undo(&rows) {
        rows = old;
        count += 1;
    }
    assert_eq!(count, 100);
    assert!(h.can_redo());
    let next = h.redo(&rows).unwrap();
    assert_ne!(next[0].text, rows[0].text);
    h.snapshot(&next);
    assert!(!h.can_redo());
    h.clear();
    assert!(!h.can_undo());
}

#[test]
fn vocal_energy_matches_source_silence_vectors() {
    let mut data = vec![0.; 20_000];
    data[5000..10000].fill(0.5);
    let envelope = compute_envelope(&data, 1000.);
    assert_eq!(span_level(&envelope, 6., 9.), 1.);
    assert_eq!(span_level(&envelope, 12., 18.), 0.);
    let rows = vec![
        row(Some(6.), "sung", Some(9.)),
        row(Some(12.), "Thank you.", Some(14.)),
        row(None, "untimed", None),
    ];
    let silent = silent_row_ids(&rows, Some(&envelope));
    assert_eq!(silent, HashSet::from([rows[1].id]));
    assert!(silent_row_ids(&rows, None).is_empty());
    assert_eq!(span_level(&envelope, 40., 50.), 0.);
    let dropped = drop_silent(&rows, &silent).unwrap();
    assert_eq!(dropped.rows.len(), 2);
    let all = rows.iter().map(|r| r.id).collect();
    let dropped = drop_silent(&rows, &all).unwrap();
    assert_eq!(dropped.rows.len(), 1);
    assert!(dropped.rows[0].text.is_empty());
}

#[test]
fn moving_middle_word_trims_previous_end_without_touching_later_neighbor() {
    let words = distribute_row_words("aaa aaa aaa", 10., 13.);
    let moved = move_word_start(&words, 1, 10.5, 8., 20.);
    close(moved[1].s, 10.5);
    assert!(moved[0].e <= moved[1].s);
    assert_eq!(moved[2], words[2]);
    let bounds = word_drag_bounds(&words, 1, 8., 20.);
    close(bounds.lo, 10.05);
    close(bounds.hi, 11.95);
    close(move_word_start(&words, 1, 0., 8., 20.)[1].s, bounds.lo);
}

#[test]
fn word_duration_survives_where_possible_and_tail_cannot_push_next_line() {
    let spread = vec![
        Word {
            w: "a".into(),
            s: 10.,
            e: 10.4,
        },
        Word {
            w: "b".into(),
            s: 14.,
            e: 14.5,
        },
    ];
    close(move_word_start(&spread, 0, 12., 8., 20.)[0].e, 12.4);
    assert!(move_word_start(&spread, 0, 13.9, 8., 20.)[0].e <= 14.);
    let words = distribute_row_words("aaa aaa aaa", 10., 13.);
    let moved = move_word_start(&words, 2, 25., 8., 13.);
    assert!(moved[2].s <= 12.95 + 1e-9);
    assert!(moved[2].e <= 13. + 1e-9);
    let r = row(Some(10.), "aaa aaa aaa", Some(13.));
    let saved = lines_from_rows(
        &[
            with_words(&r, moved),
            row(Some(13.), "untouched next", Some(15.)),
        ],
        300.,
    );
    assert_eq!(saved[1].start, 13.);
    close(move_word_start(&words, 0, 0., 9.5, 20.)[0].s, 9.5);
}

#[test]
fn with_words_keeps_line_span_and_preserves_alignment_through_save() {
    let words = distribute_row_words("aaa aaa aaa", 10., 13.);
    let r = row(Some(10.), "aaa aaa aaa", Some(13.));
    let moved = with_words(&r, move_word_start(&words, 0, 9.2, 8., 20.));
    assert_eq!((moved.start, moved.end), (Some(9.2), Some(13.)));
    assert_eq!(lines_from_rows(&[moved.clone()], 300.)[0].words[0].s, 9.2);
    let cleared = with_words(&moved, vec![]);
    assert_eq!(cleared.start, moved.start);
    assert_eq!(cleared.end, moved.end);
    assert_eq!(cleared.words, None);
}

#[test]
fn sub_five_ms_drag_is_not_an_edit_and_js_rounding_ties_go_positive() {
    let words = vec![Word {
        w: "aligned".into(),
        s: 1.23456,
        e: 2.,
    }];
    assert!(commit_word_drag(&words, 0, 1.23456, 0., 5.).is_none());
    assert!(commit_word_drag(&words, 0, 1.238, 0., 5.).is_none());
    assert_eq!(
        commit_word_drag(&words, 0, 1.25, 0., 5.).unwrap()[0].s,
        1.25
    );
    assert_eq!(round_js(-1.5), -1.);
    assert_eq!(round_js(1.5), 2.);
    assert_eq!(move_word_start(&words, 99, 2., 0., 5.), words);
}

#[test]
fn expanded_strip_freezes_neighbor_fences_and_ignores_untimed_rows() {
    let rows = vec![
        row(Some(5.), "previous", Some(9.)),
        row(None, "untimed", None),
        row(Some(10.), "line", Some(13.)),
        row(None, "untimed too", None),
        row(Some(13.), "next", Some(14.)),
    ];
    let win = strip_window(&rows, rows[2].id, 300.).unwrap();
    assert_eq!((win.t0, win.t1, win.lo, win.hi), (8.5, 14.5, 9., 13.));
    assert!(strip_window(&rows, rows[1].id, 300.).is_none());
    assert_eq!(active_row(&rows, 4.), None);
    assert_eq!(active_row(&rows, 10.5), Some(2));
    let unchanged = win;
    let mut later = rows.clone();
    later[2].start = Some(11.);
    assert_ne!(strip_window(&later, later[2].id, 300.).unwrap(), win);
    assert_eq!(unchanged, win);
}

#[test]
fn verdict_copy_does_not_overclaim_or_offer_a_missing_precise_button() {
    let mut check = AlignCheck {
        method: "whisper".into(),
        verdict: "retimed".into(),
        matched_pct: 92.,
        bad_lines: vec![],
        extra_sung: false,
    };
    let clean = describe_check(&check, true);
    assert!(clean.text.contains("every line snapped"));
    assert!(!clean.warn);
    check.bad_lines = vec![3, 7];
    let bad = describe_check(&check, true);
    assert!(
        bad.text
            .contains("2 lines couldn't be made out and kept estimated timing")
    );
    assert!(!bad.text.contains("every line snapped"));
    check.bad_lines.clear();
    check.extra_sung = true;
    assert!(
        describe_check(&check, true)
            .text
            .contains("parts these lyrics don't cover")
    );
    check.extra_sung = false;
    check.verdict = "mismatch".into();
    check.matched_pct = 12.;
    assert!(describe_check(&check, true).text.contains("try Precise"));
    assert!(!describe_check(&check, false).text.contains("Precise"));
    assert!(describe_check(&check, false).warn);
    check.verdict = "match".into();
    check.method = "ctc".into();
    assert!(describe_check(&check, true).text.ends_with(" · precise"));
}

#[test]
fn row_clock_is_floored_not_rounded_and_handles_negative_or_invalid_values() {
    assert_eq!(fmt_stamp(None), "—");
    assert_eq!(fmt_stamp(Some(f64::NAN)), "—");
    assert_eq!(fmt_stamp(Some(0.)), "0:00.0");
    assert_eq!(fmt_stamp(Some(9.99)), "0:09.9");
    assert_eq!(fmt_stamp(Some(61.25)), "1:01.2");
    assert_eq!(fmt_stamp(Some(-61.25)), "-1:01.2");
}

#[test]
fn localized_check_preserves_verdict_and_russian_plural_and_capability_rules() {
    let mut check=AlignCheck {method:"ctc".into(),verdict:"retimed".into(),matched_pct:92.,bad_lines:vec![1,2],extra_sung:true};
    let ru=crate::i18n::Locale::Ru;
    let description=describe_check_in(&check,true,ru);
    assert_eq!(description.text,"92% слов услышано · 2 строки не распознаны, время оставлено примерным · точно");
    assert!(!description.warn);
    check.verdict="mismatch".into();
    assert!(describe_check_in(&check,true,ru).text.contains("«Точно»"));
    assert!(!describe_check_in(&check,false,ru).text.contains("«Точно»"));
    assert!(describe_check_in(&check,false,ru).warn);
    assert_eq!(describe_check_in(&check,false,crate::i18n::Locale::En).text,describe_check(&check,false).text);
}

//! Exercise GPUI's actual production segmenter without compiling its unrelated
//! upstream font-fixture tests. No font metrics or native window is required.
use gpui_kit::LineWrapper;

#[test]
fn native_line_breaks_use_thai_dictionary_word_boundaries() {
    assert_eq!(
        LineWrapper::break_indices("ภาษาไทยภาษาไทย").collect::<Vec<_>>(),
        [0, 12, 21, 33, 42]
    );
}
#[test]
fn native_line_breaks_preserve_combining_clusters_in_mixed_thai_text() {
    for text in [
        "abc ภาษาไทย xyz",
        "เก้าเก้า ภาษาไทย e\u{301} 👩\u{200d}💻 你好！",
    ] {
        let breaks = LineWrapper::break_indices(text).collect::<Vec<_>>();
        assert_eq!(breaks.first(), Some(&0));
        assert_eq!(breaks.last(), Some(&text.len()));
        assert!(breaks.windows(2).all(|pair| pair[0] < pair[1]));
        assert!(breaks.iter().all(|index| text.is_char_boundary(*index)));
        let word_end = text.find("ภาษา").unwrap() + "ภาษา".len();
        assert!(
            breaks.contains(&word_end),
            "Lost Thai dictionary boundary: {text:?} {breaks:?}"
        );
        // These known clusters span combining/ZWJ scalars. The iterator must
        // never expose any interior scalar as an allowed line break.
        for cluster in ["ก้", "e\u{301}", "👩\u{200d}💻"] {
            for (start, _) in text.match_indices(cluster) {
                for (offset, _) in cluster.char_indices().skip(1) {
                    assert!(
                        !breaks.contains(&(start + offset)),
                        "Split cluster {cluster:?}: {text:?} {breaks:?}"
                    );
                }
            }
        }
    }
}
#[test]
fn native_line_breaks_keep_existing_latin_cjk_and_nonbreaking_glue_rules() {
    for (text, expected) in [
        ("aaa required!", vec![0, 4, 13]),
        ("aaa foo/bar", vec![0, 4, 8, 11]),
        ("(hello)", vec![0, 7]),
        ("aaa 你好！", vec![0, 4, 7, 13]),
        ("a\u{a0}b", vec![0, 4]),
    ] {
        assert_eq!(
            LineWrapper::break_indices(text).collect::<Vec<_>>(),
            expected,
            "{text:?}"
        );
    }
}

use super::*;
#[path = "../build_i18n.rs"]
mod extraction;
#[test]
fn source_tags_and_chinese_script_precedence_match_desktop_rules() {
    for tag in ["en", "en-US", "en_GB", "en-IN"] {
        assert_eq!(from_tag(tag), Some(Locale::En));
    }
    for tag in ["ru", "ru-RU", "ru_UA", "ru-KZ"] {
        assert_eq!(from_tag(tag), Some(Locale::Ru));
    }
    for tag in [
        "zh",
        "zh-CN",
        "zh_CN",
        "zh-Hans",
        "zh-Hans-CN",
        "zh-Hans-SG",
        "zh-SG",
        "zh-Hans-TW",
    ] {
        assert_eq!(from_tag(tag), Some(Locale::ZhCn), "{tag}");
    }
    for tag in [
        "zh-TW",
        "zh-Hant",
        "zh-Hant-TW",
        "zh-HK",
        "zh-MO",
        "zh-Hans-Hant-CN",
    ] {
        assert_eq!(from_tag(tag), Some(Locale::ZhTw), "{tag}");
    }
    for (tag, locale) in [
        ("tr-CY", Locale::Tr),
        ("hi_Latn_IN", Locale::Hi),
        ("ja-JP", Locale::Ja),
        ("ko-KR", Locale::Ko),
        ("th-TH", Locale::Th),
        ("in-ID", Locale::Id),
        ("id-ID", Locale::Id),
        ("vi-VN", Locale::Vi),
        ("tl-PH", Locale::Fil),
        ("fil-PH", Locale::Fil),
        ("ms-MY", Locale::Ms),
        ("es-419", Locale::Es419),
        ("es-PE", Locale::Es419),
        ("es-ES", Locale::Es419),
        ("pt-BR", Locale::PtBr),
        ("pt-PT", Locale::PtBr),
    ] {
        assert_eq!(from_tag(tag), Some(locale));
    }
    for tag in ["de-DE", "uk-UA", "", "zh-US", " en", "zh-XY"] {
        assert_eq!(from_tag(tag), None, "{tag}");
    }
}
#[test]
fn system_resolution_walks_preferred_tags_and_explicit_pick_wins() {
    let tags = vec!["de-DE".into(), "ru-RU".into(), "en-US".into()];
    assert_eq!(resolve_locale(Language::System, &tags), Locale::Ru);
    assert_eq!(
        resolve_locale(Language::Locale(Locale::Ja), &tags),
        Locale::Ja
    );
    assert_eq!(resolve_locale(Language::System, &[]), Locale::En);
}
#[test]
fn language_string_serde_and_source_menu_metadata_are_complete() {
    assert_eq!(&Locale::ALL[..3], &[Locale::En, Locale::Tr, Locale::Ru]);
    for language in Language::ALL {
        assert_eq!(Language::parse(language.as_str()), Some(language));
        let json = serde_json::to_string(&language).unwrap();
        assert_eq!(serde_json::from_str::<Language>(&json).unwrap(), language);
    }
    for locale in Locale::ALL {
        assert!(!locale.endonym().is_empty());
        assert!(!locale.code().is_empty());
    }
    assert!(Language::parse("EN").is_none());
    assert!(Language::parse("zh-Hans").is_none());
    assert!(serde_json::from_str::<Language>("3").is_err());
}
#[test]
fn interpolation_retains_unknown_and_only_ascii_word_names() {
    let vars = vec![
        ("n", "1".into()),
        ("n", "2".into()),
        ("total", "3".into()),
        ("name", "{n}".into()),
    ];
    assert_eq!(
        fill(
            "{n} of {total}; {missing}; {bad-name}; {é}; {{n}} {name}",
            &vars
        ),
        "2 of 3; {missing}; {bad-name}; {é}; {2} {n}"
    );
}
#[test]
fn cardinal_rules_match_source_vectors_including_fractions() {
    for (n, want) in [
        (1., "one"),
        (2., "few"),
        (5., "many"),
        (11., "many"),
        (21., "one"),
        (22., "few"),
        (112., "many"),
        (-22., "few"),
        (1.2, "other"),
    ] {
        assert_eq!(plural_form(Locale::Ru, n), want);
    }
    for locale in [
        Locale::ZhCn,
        Locale::ZhTw,
        Locale::Ja,
        Locale::Ko,
        Locale::Th,
        Locale::Id,
        Locale::Vi,
        Locale::Ms,
    ] {
        for n in [0., 1., 2., 1.2] {
            assert_eq!(plural_form(locale, n), "other");
        }
    }
    for (n, want) in [
        (0., "one"),
        (0.6, "one"),
        (1., "one"),
        (1.1, "other"),
        (2., "other"),
    ] {
        assert_eq!(plural_form(Locale::Hi, n), want);
    }
    for (n, want) in [
        (0., "one"),
        (1., "one"),
        (4., "other"),
        (6., "other"),
        (9., "other"),
        (14., "other"),
        (1.1234, "one"),
        (1.4, "other"),
        (1.6, "other"),
        (1.9, "other"),
    ] {
        assert_eq!(plural_form(Locale::Fil, n), want, "{n}");
    }
    // Values captured from the source runtime's Intl.PluralRules.
    for (n, spanish, portuguese) in [
        (0., "other", "one"),
        (0.6, "other", "one"),
        (1., "one", "one"),
        (1.2, "other", "one"),
        (-1.9, "other", "one"),
        (2., "other", "other"),
        (1_000_000., "many", "many"),
        (1_000_000.1, "other", "other"),
    ] {
        assert_eq!(plural_form(Locale::Es419, n), spanish, "es-419 {n}");
        assert_eq!(plural_form(Locale::PtBr, n), portuguese, "pt-BR {n}");
    }
    assert_eq!(plural_form(Locale::En, 1.), "one");
    assert_eq!(plural_form(Locale::Tr, 1.), "one");
    assert_eq!(plural_form(Locale::Ru, f64::NAN), "other");
}
#[test]
fn every_bundled_dictionary_equals_current_source_extraction() {
    let source = extraction::extract(
        &std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../../src/shared/i18n"),
    )
    .unwrap();
    assert_eq!(&source, dictionaries());
    assert_eq!(source.len(), Locale::ALL.len());
    let english = &source["en"];
    assert!(english.len() > 500);
    for locale in Locale::ALL {
        let dict = &source[locale.as_str()];
        for key in english.keys() {
            assert!(
                dict.get(key).is_some_and(|v| !v.is_empty()),
                "{} {key}",
                locale.as_str()
            );
        }
        assert_ne!(lookup(locale, "lang.label", &[]), "lang.label");
        assert_eq!(
            lookup(locale, "native.unknown.key", &[]),
            "native.unknown.key"
        );
    }
}
#[test]
fn plural_dictionary_lookup_uses_forms_and_explicit_n_variable_override() {
    let dict = &dictionaries()["ru"];
    let stem = dict
        .keys()
        .find_map(|key| key.strip_suffix("_few"))
        .unwrap();
    for (n, form) in [(2., "few"), (5., "many")] {
        assert_eq!(
            lookup_plural(Locale::Ru, stem, n, &[]),
            fill(&dict[&format!("{stem}_{form}")], &[("n", number(n))])
        );
    }
    assert_eq!(
        lookup_plural(Locale::Ru, stem, 2., &[("n", "OVERRIDE".into())]),
        fill(&dict[&format!("{stem}_few")], &[("n", "OVERRIDE".into())])
    );
    assert_eq!(
        lookup_plural(Locale::En, "unknown.stem", 2., &[]),
        "unknown.stem"
    );
    assert_eq!(number(-0.), "0");
    assert_eq!(number(1e21), "1e+21");
    assert_eq!(number(1e-7), "1e-7");
}
#[test]
fn extractor_decodes_ts_literals_comments_and_unicode_without_executing_code() {
    let raw = r#"/* comment */ export const dict: Record<string,string> = {
      'one': 'a\n\t\'b', // comment
      "two": "\uD83E\uDD80 \u{1F600} \x41",
      'template': `literal
multiline`,
    } satisfies Dict"#;
    assert_eq!(
        extraction::merge_order("const base = {...common, ...app}; export const en = base as typeof base & typeof box").unwrap(),
        vec!["common", "app"]
    );
    assert!(extraction::merge_order("const base = run(); export const en = base as typeof base").is_err());
    let parsed = extraction::parse(raw).unwrap();
    assert_eq!(parsed["one"], "a\n\t'b");
    assert_eq!(parsed["two"], "🦀 😀 A");
    assert_eq!(parsed["template"], "literal\nmultiline");
    for raw in [
        "export const d = {'a': fn()}",
        "export const d = {'a':'b' + 'c'}",
        "export const d = {'a': `${run()}`} ",
        "export const d = {'a':'x','a':'y'}",
        "export const d = {'a':'\\uD800'}",
    ] {
        assert!(extraction::parse(raw).is_err(), "{raw}");
    }
    assert_eq!(
        extraction::merge_order("export const en = {...common, ...app, ...main}").unwrap(),
        vec!["common", "app", "main"]
    );
}

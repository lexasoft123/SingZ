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

/// Every string the native shell used to type in Rust. Each must resolve in all
/// 15 locales; a missing key would come back as the key itself.
const NATIVE_ONLY_KEYS: &[&str] = &[
    "main.menu.settings",
    "main.menu.quit",
    "main.menu.window",
    "main.menu.closeWindow",
    "main.dialog.addAudioTracks",
    "main.model.checking",
    "main.source.preparing",
    "diagnostics.notice.savePrototype",
    "diagnostics.notice.sessionGone",
    "settings.output.loadingDevices",
    "settings.mic.noChannels",
    "settings.mic.waiting",
    "settings.mic.permissionRequired",
    "settings.mic.unavailable",
    "settings.mic.off",
    "settings.mic.captureUnavailable",
    "settings.mic.previewOff",
    "settings.mic.enable",
    "settings.mic.retry",
    "settings.monitor.startPausesPlayback",
    "settings.route.applying",
    "settings.dsp.alwaysOn",
    "microphone.recording.noActive",
    "microphone.error.nativeInput",
    "microphone.error.recordingFailed",
    "player.pitch.micStopping",
    "player.pitch.micUnavailableShort",
    "player.pitch.micMonitoringOwns",
    "player.pitch.warning.invalid",
    "player.pitch.warning.invalidDuration",
    "player.pitch.warning.differentDuration",
    "player.pitch.warning.needsUpdating",
    "carryLine.queuedSaveDidNotRun",
    "library.progress.updatingLyrics",
    "library.progress.readingAudio",
    "library.progress.decodingAudio",
    "library.progress.savingProject",
    "library.splitWorkflow.checkingSplitter",
    "library.splitWorkflow.preparingAudio",
    "library.drive.updatingCatalog",
    "library.drive.alreadyDownloaded",
    "library.drive.downloaded",
    "library.drive.downloadCancelled",
    "library.drive.notConfigured",
    "library.drive.checking",
    "library.drive.finishingSync",
    "library.picker.noPlayable",
    "library.recovery.renamedFolderWarning",
    "drive.auth.callbackInvalid",
    "lyrics.align.cancelled",
    "lyrics.align.modelsMissing",
    "lyrics.editor.earlierDraftSaved",
    "lyrics.editor.noLines",
    "quickStart.title",
    "quickStart.welcome",
    "quickStart.start",
    "quickStart.later",
    "quickStart.skip",
    "quickStart.back",
    "quickStart.next",
    "quickStart.done",
    "quickStart.intro",
    "quickStart.tempo",
    "quickStart.loop",
    "quickStart.step.library.title",
    "quickStart.step.library.body",
    "quickStart.step.split.title",
    "quickStart.step.split.body",
    "quickStart.step.stems.title",
    "quickStart.step.stems.body",
    "quickStart.step.lyrics.title",
    "quickStart.step.lyrics.body",
    "quickStart.step.practice.title",
    "quickStart.step.practice.body",
    "quickStart.step.training.title",
    "quickStart.step.training.body",
    "quickStart.step.sync.title",
    "quickStart.step.sync.body",
    "quickStart.step.settings.title",
    "quickStart.step.settings.body",
    "quickStart.saved.title",
    "quickStart.saved.body",
    "quickStart.karaoke.title",
    "quickStart.karaoke.body",
    // D-06 / C-60: accessible names and announcements added for assistive technology.
    "a11y.monitor.stop",
    "a11y.announce.splitDone",
    "a11y.announce.analysisDone",
    "a11y.announce.driveSignedIn",
    "a11y.announce.driveSignedOut",
    "a11y.announce.driveSyncDone",
    "a11y.announce.driveSyncFailed",
    "a11y.announce.recordingStarted",
    "a11y.announce.recordingStopped",
    "a11y.announce.recordingFailed",
    "a11y.announce.modelInstalling",
    "a11y.announce.modelInstalled",
    "a11y.announce.modelFailed",
];
/// English is a deliberate answer for these (the word is the same in that language).
const SAME_AS_ENGLISH: &[(&str, &str)] = &[("fil", "main.menu.window")];
#[test]
fn native_only_strings_exist_in_every_locale_and_are_translated() {
    for key in NATIVE_ONLY_KEYS {
        let english = lookup(Locale::En, key, &[]);
        assert!(!english.is_empty() && english != *key, "English is missing {key}");
        for locale in Locale::ALL {
            let text = lookup(locale, key, &[]);
            assert!(!text.is_empty() && text != *key, "{} is missing {key}", locale.as_str());
            if locale != Locale::En && !SAME_AS_ENGLISH.contains(&(locale.as_str(), *key)) {
                assert_ne!(text, english, "{} left {key} in English", locale.as_str());
            }
        }
    }
}
#[test]
fn quick_start_tour_copy_is_complete_and_matches_the_generated_en_ru_copy() {
    let json: serde_json::Value = serde_json::from_str(include_str!("quick_start_copy.json")).unwrap();
    for locale in [Locale::En, Locale::Ru] {
        let copy = &json[locale.as_str()];
        let key = |name: &str| lookup(locale, &format!("quickStart.{name}"), &[]);
        for name in ["title", "welcome", "start", "later", "skip", "back", "next", "done", "intro", "tempo", "loop"] {
            assert_eq!(key(name), copy[name].as_str().unwrap(), "{} {name}", locale.as_str());
        }
        for (step, source) in [
            ("step.library", &copy["steps"]["library"]),
            ("step.split", &copy["steps"]["split"]),
            ("step.stems", &copy["steps"]["stems"]),
            ("step.lyrics", &copy["steps"]["lyrics"]),
            ("step.practice", &copy["steps"]["practice"]),
            ("step.training", &copy["steps"]["training"]),
            ("step.sync", &copy["steps"]["sync"]),
            ("step.settings", &copy["steps"]["settings"]),
            ("saved", &copy["saved"]),
            ("karaoke", &copy["karaoke"]),
        ] {
            assert_eq!(key(&format!("{step}.title")), source[0].as_str().unwrap(), "{} {step}", locale.as_str());
            assert_eq!(key(&format!("{step}.body")), source[1].as_str().unwrap(), "{} {step}", locale.as_str());
        }
    }
}
/// The part of a source file that ships: everything before its test module.
fn shipped(source: &str) -> &str {
    let mut offset = 0;
    let mut pending: Option<usize> = None;
    for line in source.split_inclusive('\n') {
        let trimmed = line.trim_start();
        if trimmed.starts_with("#[cfg(test)]") {
            pending = Some(offset);
        } else if let Some(start) = pending {
            if trimmed.starts_with("mod ") || trimmed.starts_with("pub mod ") {
                return &source[..start];
            }
            if !trimmed.starts_with("#[") {
                pending = None;
            }
        }
        offset += line.len();
    }
    source
}
/// R-04's grep, kept as a test: these literals were typed in Rust and now live in i18n.
#[test]
fn converted_native_strings_stay_out_of_shipped_rust_source() {
    let sources: &[(&str, &str, &[&str])] = &[
        ("desktop_lifecycle.rs", include_str!("desktop_lifecycle.rs"), &["Settings…", "Quit SingZ", "Close Window", "Menu::new(\"Window\")"]),
        ("custom_tracks_host.rs", include_str!("custom_tracks_host.rs"), &["Add audio tracks"]),
        ("diagnostics_host.rs", include_str!("diagnostics_host.rs"), &["That session log is no longer kept", "Saving log files is not connected"]),
        ("library.rs", include_str!("library.rs"), &["Search projects…", "No playable projects in this folder", "starts_with(\"Sync paused.\")", "\"Signed out of Google Drive.\"", "\"Finishing Drive sync…\""]),
        ("settings.rs", include_str!("settings.rs"), &[
            "Loading native devices…", "\"No channels\"", "Waiting for microphone…", "Microphone permission required",
            "\"Microphone unavailable\"", "Microphone is off", "Microphone capture unavailable", "Microphone preview is off",
            "Enable microphone", "Retry microphone", "Buffer pending", "Starting monitoring pauses",
            "Applying output route", "Native DSP playback is always", "Choose playback device…", "\"System default\""]),
        ("pitch_strip.rs", include_str!("pitch_strip.rs"), &["\"Stopping…\"", "\"Mic unavailable\"", "Monitoring owns microphone", "\"Microphone unavailable\"", "Analyzing vocals…"]),
        ("project_pitch.rs", include_str!("project_pitch.rs"), &["Saved pitch data is invalid", "Saved pitch has an invalid", "Saved pitch belongs to", "Saved pitch needs updating"]),
        ("source_jobs.rs", include_str!("source_jobs.rs"), &[
            "Updating lyrics…", "Reading audio…", "Decoding audio…", "Saving project…", "Checking splitter…",
            "Preparing audio…", "\"Preparing…\".into()", "The stem splitter has not been downloaded yet"]),
        ("drive_sync.rs", include_str!("drive_sync.rs"), &["Updating catalog…"]),
        ("drive_restore.rs", include_str!("drive_restore.rs"), &["\"Already downloaded\"", "progress(\"Downloaded\""]),
        ("drive_restore_service.rs", include_str!("drive_restore_service.rs"), &["Download cancelled. Completed files are kept."]),
        ("drive_service.rs", include_str!("drive_service.rs"), &[
            "Google Drive is not configured", "\"Signed out of Google Drive.\"", "Sync paused. Completed files are kept",
            "Finish signing in to Google in your browser", "Checking Google Drive…", "\"Finishing Drive sync…\""]),
        ("drive_local_ops.rs", include_str!("drive_local_ops.rs"), &["Recovered the actual renamed folder"]),
        ("drive_auth.rs", include_str!("drive_auth.rs"), &["Invalid sign-in callback. Return to SingZ"]),
        ("models.rs", include_str!("models.rs"), &["Checking installed models…"]),
        ("engine_status.rs", include_str!("engine_status.rs"), &["The stem splitter has not been downloaded yet"]),
        ("microphone.rs", include_str!("microphone.rs"), &["No matching microphone recording is active", "\"Native input failed\"", "Native microphone recording failed"]),
        ("lyrics_align.rs", include_str!("lyrics_align.rs"), &["write!(f, \"Alignment cancelled\")", "Alignment models are not installed"]),
        ("lyrics_editor.rs", include_str!("lyrics_editor.rs"), &["The earlier draft was saved", "No lines to save."]),
        ("carry_line_host.rs", include_str!("carry_line_host.rs"), &["\" Queued Save did not run.\""]),
        ("quick_start.rs", include_str!("quick_start.rs"), &["quick_start_copy.json"]),
    ];
    let mut found = vec![];
    for (file, source, literals) in sources {
        let source = shipped(source);
        for literal in *literals {
            if source.contains(literal) {
                found.push(format!("{file}: {literal}"));
            }
        }
    }
    assert!(found.is_empty(), "user-visible text is typed in Rust again:\n{}", found.join("\n"));
}

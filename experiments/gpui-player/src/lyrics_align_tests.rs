use super::*;
#[test]
fn forced_word_packet_cannot_inject_huge_or_effectively_outside_anchors() {
    let chunk = Chunk {
        start: 10.,
        end: 20.,
    };
    assert!(placement_span(chunk, 1e100, 0., 30.).is_err());
    assert!(placement_span(chunk, f64::INFINITY, 0., 30.).is_err());
    assert!(placement_span(chunk, 12., 11., 30.).is_err());
    assert!(placement_span(chunk, 0., f64::NAN, 30.).is_err());
    assert_eq!(placement_span(chunk, 2., 2.3, 30.).unwrap(), (12., 12.3));
    assert_eq!(placement_span(chunk, 2., 1.5, 30.).unwrap(), (12., 12.05));
}
#[test]
fn admission_preserves_saved_long_words_and_refuses_excess_before_expansion() {
    assert_eq!(text_word_count(&"𐐀".repeat(1024)).unwrap(), 1);
    assert!(text_word_count(&"x".repeat(1025)).is_err());
    assert!(text_word_count(&"x ".repeat(100001)).is_err());
    let root = Scratch::new().unwrap();
    let too_big = root.write("large.json", b"123456789").unwrap();
    assert!(bounded_read(&too_big, 8).is_err());
    assert!(float_wav(&too_big, &root.0.join("never.wav"), u64::MAX).is_err());
    assert!(!root.0.join("never.wav").exists());
}
fn inputs(root: &Scratch) -> Inputs {
    let vocals = root.write("vocals.wav", b"source identity").unwrap();
    let stamp = stamp(&vocals).unwrap();
    Inputs {
        root: root.0.clone(),
        vocals,
        stamp,
        original: None,
        legacy_heard: None,
        duration: 10.,
        draft: vec![],
        tier: Tier::Align,
        config: Config::source(),
    }
}
fn env(runs: &[(usize, f32)]) -> Vec<f32> {
    runs.iter()
        .flat_map(|(seconds, value)| std::iter::repeat_n(*value, seconds * 20))
        .collect()
}
#[test]
fn source_chunker_drops_long_silence_and_blips_but_preserves_contiguous_voice() {
    assert_eq!(
        plan_chunks(&env(&[(10, 1.)]), 1.),
        [Chunk {
            start: 0.,
            end: 10.
        }]
    );
    let out = plan_chunks(&env(&[(10, 1.), (20, 0.), (10, 1.)]), 1.);
    assert_eq!(out.len(), 2);
    assert!(out.iter().map(|c| c.end - c.start).sum::<f64>() < 22.);
    assert!(out[1].start > 29.);
    let out = plan_chunks(&env(&[(1, 1.), (20, 0.), (10, 1.)]), 1.);
    assert_eq!(out.len(), 1);
    assert!(out[0].start > 20.);
    assert!(plan_chunks(&env(&[(30, 0.)]), 0.).is_empty());
    assert!(plan_chunks(&[], 1.).is_empty());
}
#[test]
fn source_chunker_caps_calls_and_prefers_quiet_gaps_over_midword_limit() {
    let out = plan_chunks(&env(&[(95, 1.)]), 1.);
    assert_eq!(out.len(), 4);
    assert!(out.iter().all(|c| c.end - c.start <= 30.));
    assert_eq!(out[0].start, 0.);
    assert_eq!(out[3].end, 95.);
    assert!(out.windows(2).all(|p| p[1].start == p[0].end));
    let out = plan_chunks(&env(&[(24, 1.), (1, 0.), (25, 1.)]), 1.);
    assert!(out[0].end > 24. && out[0].end < 25.5);
    let out = plan_chunks(&env(&[(10, 0.06), (20, 0.), (10, 1.)]), 1.);
    assert_eq!(out.len(), 1);
    assert!(out[0].start > 20.);
}
#[test]
fn pcm_wav_serialization_and_base64_match_runtime_contract() {
    let root = Scratch::new().unwrap();
    let pcm = root
        .write("input.f32", &vec![0.5f32.to_le_bytes(); 16000].concat())
        .unwrap();
    let wav = chunk_wav(
        &pcm,
        16000,
        Chunk {
            start: 0.5,
            end: 9.,
        },
    )
    .unwrap();
    assert_eq!(&wav[..4], b"RIFF");
    assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), 16000);
    assert_eq!(u16::from_le_bytes(wav[34..36].try_into().unwrap()), 16);
    assert_eq!(u32::from_le_bytes(wav[40..44].try_into().unwrap()), 16000);
    assert_eq!(i16::from_le_bytes(wav[44..46].try_into().unwrap()), 16384);
    assert_eq!(b64(b""), "");
    assert_eq!(b64(b"f"), "Zg==");
    assert_eq!(b64(b"fo"), "Zm8=");
    assert_eq!(b64(b"foo"), "Zm9v");
    let float = root.0.join("float.wav");
    float_wav(&pcm, &float, 16000).unwrap();
    let bytes = fs::read(float).unwrap();
    assert_eq!(u16::from_le_bytes(bytes[20..22].try_into().unwrap()), 3);
    assert_eq!(f32::from_le_bytes(bytes[44..48].try_into().unwrap()), 0.5);
}
#[test]
fn source_mms_scripts_are_embedded_exactly_and_model_preflight_is_platform_specific() {
    let torch = source_script(false).unwrap();
    let onnx = source_script(true).unwrap();
    assert!(torch.contains("torchaudio.functional.forced_align"));
    assert!(onnx.contains("ort.InferenceSession"));
    assert!(onnx.contains("providers=[\"CPUExecutionProvider\"]"));
    let root = Scratch::new().unwrap();
    let mut config = Config::source();
    config.models = root.0.join("models");
    config.pack = root.0.join("pack");
    config.flavor = Flavor::AppleSilicon;
    let fast = needed(&config, Tier::Align);
    assert_eq!(fast.len(), 1);
    assert_eq!(fast[0].id, "qwen-asr");
    assert_eq!(fast[0].size_mb, 3511);
    assert_eq!(fast[0].required_files.len(), 3);
    fs::create_dir_all(config.pack.join("python")).unwrap();
    fs::write(
        config.pack.join("python/pack.json"),
        b"{\"target\":\"darwin-x64\"}",
    )
    .unwrap();
    let precise = needed(&config, Tier::Precise);
    assert_eq!(precise[0].size_mb, 1263);
    assert_eq!(precise[0].required_files, ["mms-fa.onnx"]);
    assert_eq!(precise[0].flavor, Flavor::IntelMac);
}
#[test]
fn heard_cache_requires_exact_engine_vocals_language_and_preserves_future_data() {
    let root = Scratch::new().unwrap();
    let mut input = inputs(&root);
    let chunks = vec![domain::ChunkText {
        start: 0.,
        end: 10.,
        text: "A real cached listen".into(),
        label: Some("English".into()),
    }];
    let mut warnings = vec![];
    write_heard(&input, Some("English"), &chunks, &mut warnings, &|| false);
    assert!(warnings.is_empty());
    assert_eq!(
        read_heard(&input, Some(Some("English"))),
        Some(chunks.clone())
    );
    assert!(read_heard(&input, Some(Some("German"))).is_none());
    assert!(read_heard(&input, None).is_some());
    let primary = root.0.join("heard-words.json");
    let legacy = root.0.join("legacy.json");
    fs::rename(&primary, &legacy).unwrap();
    input.legacy_heard = Some(legacy);
    assert_eq!(
        read_heard(&input, Some(Some("English"))),
        Some(chunks.clone())
    );
    fs::write(
        &primary,
        b"{\"version\":2,\"engine\":\"future\",\"foreign\":true}",
    )
    .unwrap();
    let before = fs::read(&primary).unwrap();
    write_heard(&input, None, &chunks, &mut warnings, &|| false);
    assert_eq!(fs::read(&primary).unwrap(), before);
    assert!(!warnings.is_empty());
    fs::write(&input.vocals, b"changed source identity").unwrap();
    assert!(input.check(&|| false).is_err());
}
#[test]
fn bounded_json_and_source_stamp_refusals_do_not_masquerade_as_results() {
    assert_eq!(
        last_json(b"runtime log\n{\"words\":[]}\n").unwrap()["words"],
        json!([])
    );
    assert!(last_json(b"runtime failed\n").is_err());
    let root = Scratch::new().unwrap();
    let input = inputs(&root);
    assert!(input.check(&|| true).is_err());
    assert!(input.check(&|| false).is_ok());
}
#[cfg(unix)]
#[test]
fn cancellation_reaps_child_group_including_pipe_holding_descendant() {
    let start = Instant::now();
    let mut cmd = Command::new("/bin/sh");
    cmd.args(["-c", "sleep 30 & wait"]);
    let result = command(
        cmd,
        Duration::from_secs(40),
        &|| start.elapsed() > Duration::from_millis(80),
        &|_| {},
    );
    assert!(result.is_err());
    assert!(start.elapsed() < Duration::from_secs(3));
}

/// Real inference is deliberately opt-in: this starts only the explicitly named
/// native runtimes and never downloads models or publishes editor lyrics.
#[test]
#[ignore = "requires explicit real project, output, duration, helper, runtimes and installed models"]
fn real_native_alignment_cold_warm_and_optional_precise_receipt() -> Result<()> {
    fn required(name: &str) -> Result<PathBuf> {
        let path = PathBuf::from(std::env::var_os(name).with_context(|| format!("Set {name}"))?);
        ensure!(
            path.is_absolute(),
            "{name} must be an explicit absolute path"
        );
        Ok(path)
    }
    fn identity(path: &Path) -> Result<Value> {
        let mut file = File::open(path)?;
        let size = file.metadata()?.len();
        let mut hash = sha1::Sha1::new();
        let mut buf = vec![0u8; 512 * 1024];
        loop {
            let n = file.read(&mut buf)?;
            if n == 0 {
                break;
            }
            hash.update(&buf[..n]);
        }
        Ok(json!({"path":path,"bytes":size,"sha1":format!("{:x}",hash.finalize())}))
    }
    fn saved(path: &Path) -> Result<Option<Vec<u8>>> {
        match fs::symlink_metadata(path) {
            Ok(_) => Ok(Some(bounded_read(path, 8 * 1024 * 1024)?)),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
            Err(e) => Err(e.into()),
        }
    }
    fn valid(output: &Output, duration: f64) -> bool {
        !output.lines.is_empty()
            && output.check.matched_pct.is_finite()
            && output.check.median_shift.is_finite()
            && output.lines.iter().all(|l| {
                l.start.is_finite()
                    && l.end.is_finite()
                    && l.start >= 0.
                    && l.end >= l.start
                    && l.end <= duration + 2.
                    && l.words.iter().all(|w| {
                        w.s.is_finite()
                            && w.e.is_finite()
                            && w.s >= 0.
                            && w.e >= w.s
                            && w.e <= duration + 2.
                    })
            })
    }
    let project_path = required("SINGZ_GPUI_LYRICS_REAL_PROJECT")?;
    let out = required("SINGZ_GPUI_LYRICS_REAL_OUT")?;
    let helper = required("SINGZ_GPUI_AUDIO_HELPER")?;
    let llama = required("SINGZ_LLAMA_SERVER")?;
    let crisp = required("SINGZ_CRISPASR")?;
    let models = required("SINGZ_MODELS_DIR")?;
    let pack = required("SINGZ_PACK_DIR")?;
    let duration = std::env::var("SINGZ_GPUI_LYRICS_REAL_DURATION")?.parse::<f64>()?;
    fs::create_dir_all(&out)?;
    let project = crate::integration::read_project(&project_path)?;
    ensure!(
        !out.canonicalize()?.starts_with(&project.dir),
        "Receipt output must be outside source project"
    );
    let original_lyrics = saved(&project.dir.join("lyrics.json"))?;
    let original_heard = saved(&project.dir.join("heard-words.json"))?;
    // read_project inventories paths; the backend normally loads lyrics later.
    let fixture_lyrics = crate::project_lyrics::read(&project.dir)?;
    let doc = fixture_lyrics
        .as_ref()
        .context("Fixture needs lyrics.json with spoken draft")?;
    let draft: Vec<Line> = doc
        .lines
        .iter()
        .map(|l| Line {
            start: l.start as f64,
            end: l.end as f64,
            text: l.text.clone(),
            words: l
                .words
                .iter()
                .map(|w| Word {
                    w: w.text.clone(),
                    s: w.start as f64,
                    e: w.end as f64,
                })
                .collect(),
        })
        .collect();
    let mut input = capture(&project, draft, duration, Tier::Align)?;
    input.config.models = models.clone();
    input.config.pack = pack.clone();
    // Keep all derived caches private; even a fixture with an original song
    // must not accidentally inherit the Electron SHA1 cache and fake a cold run.
    let scratch = Scratch::new()?;
    input.root = scratch.0.clone();
    input.original = None;
    input.legacy_heard = None;
    let sentinel = b"preview-only: lyrics publication is forbidden";
    let sentinel_path = scratch.write("lyrics.json", sentinel)?;
    ensure!(
        needed(&input.config, Tier::Align).is_empty(),
        "Actual Qwen GGUF weights required"
    );
    let pcm = scratch.0.join("receipt-input.f32");
    let mut decode = Command::new(&helper);
    decode
        .arg("--render-lyrics-input")
        .arg(&input.vocals)
        .arg(&pcm);
    let decode = last_json(&command(
        decode,
        Duration::from_secs(180),
        &|| false,
        &|_| {},
    )?)?;
    ensure!(
        decode["ok"] == true && decode["sampleRate"] == 16000 && decode["channels"] == 1,
        "Actual helper input preparation failed"
    );
    let mut artifacts = vec![
        identity(&helper)?,
        identity(&llama)?,
        identity(&crisp)?,
        identity(&input.vocals)?,
        identity(&pcm)?,
    ];
    for name in [ASR, MMPROJ, ALIGNER] {
        artifacts.push(identity(&models.join(name))?);
    }
    let progress = Mutex::new(Vec::<Value>::new());
    let started = Instant::now();
    let cold = run(&input, &|| false, &|p| {
        progress
            .lock()
            .unwrap()
            .push(json!({"run":"cold","event":p}))
    });
    let cold_seconds = started.elapsed().as_secs_f64();
    let heard = read_heard(&input, None);
    let speech = heard
        .as_ref()
        .is_some_and(|chunks| chunks.iter().any(|c| !trim_text(&c.text).is_empty()));
    let source_cache = saved(&scratch.0.join("heard-words.json"))?;
    let cache_raw: Option<Value> = source_cache
        .as_ref()
        .map(|b| serde_json::from_slice(b))
        .transpose()?;
    let cache_source_format = cache_raw.as_ref().is_some_and(|v| {
        v["version"] == 1
            && v["engine"] == "qwen3-asr-1.7b"
            && v["vocals"]["size"] == input.stamp.0
            && v["chunks"].is_array()
    });
    let started = Instant::now();
    let warm = run(&input, &|| false, &|p| {
        progress
            .lock()
            .unwrap()
            .push(json!({"run":"warm","event":p}))
    });
    let warm_seconds = started.elapsed().as_secs_f64();
    let mut transcription_input = input.clone();
    transcription_input.draft.clear();
    let started = Instant::now();
    let transcription = run_transcription(&transcription_input, &|| false, &|p| {
        progress
            .lock()
            .unwrap()
            .push(json!({"run":"transcription","event":p}))
    });
    let transcription_seconds = started.elapsed().as_secs_f64();
    let transcription_ok = transcription.as_ref().is_ok_and(|output| {
        !output.lines.is_empty()
            && output.lines.iter().all(|line| {
                line.start.is_finite()
                    && line.end.is_finite()
                    && line.start >= 0.
                    && line.end >= line.start
                    && line.end <= duration + 2.
                    && !line.words.is_empty()
                    && line.words.iter().all(|word| {
                        word.s.is_finite()
                            && word.e.is_finite()
                            && word.s >= 0.
                            && word.e >= word.s
                            && word.e <= duration + 2.
                    })
            })
    });
    let transcription_json = match &transcription {
        Ok(output) => json!({"status":"executed","output":output}),
        Err(error) => json!({"status":"failed","error":error.to_string()}),
    };
    if let Some(bytes) = saved(&scratch.0.join("heard-words.json"))? {
        fs::write(out.join("transcription-heard-words.json"), bytes)?;
    }
    input.tier = Tier::Precise;
    let missing = needed(&input.config, Tier::Precise);
    let runtime = python(&input.config);
    let mut precise_ok = true;
    let precise = if !missing.is_empty() || !regular(&runtime) {
        json!({"status":"blocked","passed":false,"reason":"Installed precise weights or pack Python unavailable","needsModels":missing,"python":runtime})
    } else {
        artifacts.push(identity(&runtime)?);
        let model = if matches!(
            precise_flavor(&input.config),
            Flavor::IntelMac | Flavor::Windows
        ) {
            models.join("mms-fa.onnx")
        } else {
            models.join("torch-home/hub/checkpoints/model.pt")
        };
        artifacts.push(identity(&model)?);
        let started = Instant::now();
        match run(&input, &|| false, &|p| {
            progress
                .lock()
                .unwrap()
                .push(json!({"run":"precise","event":p}))
        }) {
            Ok(output) => {
                precise_ok = valid(&output, duration);
                json!({"status":"executed","passed":precise_ok,"seconds":started.elapsed().as_secs_f64(),"output":output})
            }
            Err(error) => {
                precise_ok = false;
                json!({"status":"failed","passed":false,"seconds":started.elapsed().as_secs_f64(),"error":error.to_string()})
            }
        }
    };
    let no_lyrics_write = saved(&sentinel_path)?.as_deref() == Some(sentinel.as_slice())
        && saved(&project.dir.join("lyrics.json"))? == original_lyrics
        && saved(&project.dir.join("heard-words.json"))? == original_heard;
    let cold_ok = cold
        .as_ref()
        .is_ok_and(|v| valid(v, duration) && !v.cached_heard);
    let warm_ok = warm
        .as_ref()
        .is_ok_and(|v| valid(v, duration) && v.cached_heard);
    let result_json = |result: &std::result::Result<Output, Failure>| match result {
        Ok(output) => json!({"status":"executed","output":output}),
        Err(error) => json!({"status":"failed","error":error.to_string()}),
    };
    let receipt = json!({"protocol":1,"kind":"actual-native-lyrics-runner","duration":duration,
        "cacheIsolation":"private scratch; original song legacy cache disabled for cold run",
        "artifacts":artifacts,"pcm":decode,"cold":result_json(&cold),"coldSeconds":cold_seconds,
        "warm":result_json(&warm),"warmSeconds":warm_seconds,"precise":precise,
        "transcription":transcription_json,"transcriptionSeconds":transcription_seconds,"transcriptionPassed":transcription_ok,
        "heardSpeechNonempty":speech,"sourceFormatCache":cache_source_format,
        "noLyricsWrite":no_lyrics_write,"progress":*progress.lock().unwrap(),
        "fastPassed":cold_ok && warm_ok && speech && cache_source_format && no_lyrics_write});
    fs::write(
        out.join("lyrics-alignment-real-receipt.json"),
        serde_json::to_vec_pretty(&receipt)?,
    )?;
    if let Some(bytes) = source_cache {
        fs::write(out.join("heard-words.json"), bytes)?;
    }
    ensure!(cold_ok, "Cold actual runner failed; inspect receipt");
    ensure!(
        warm_ok,
        "Warm actual runner did not use heard cache; inspect receipt"
    );
    ensure!(
        speech && cache_source_format,
        "No actual speech/source-format cache; inspect receipt"
    );
    ensure!(no_lyrics_write, "Preview changed project files");
    ensure!(
        transcription_ok,
        "Actual transcription did not return usable timed words; inspect receipt"
    );
    ensure!(
        precise_ok,
        "Installed precise runner failed; inspect receipt"
    );
    Ok(())
}

fn transcribed_reference() -> Vec<Line> {
    domain::lines_from_chunks(&[domain::ChunkText {
        start: 0.,
        end: 3.,
        text: "hello world".into(),
        label: Some("English".into()),
    }])
}
fn transcribed_anchors() -> Vec<domain::Anchor> {
    vec![
        domain::Anchor {
            li: 0,
            wi: 0,
            s: 0.25,
            e: 0.6,
            sim: 1.,
        },
        domain::Anchor {
            li: 0,
            wi: 1,
            s: 1.1,
            e: 1.5,
            sim: 1.,
        },
    ]
}
#[test]
fn transcription_capture_is_explicit_empty_draft_admission_and_keeps_source_checks() -> Result<()> {
    let root = Scratch::new()?;
    fs::create_dir(root.0.join("stems"))?;
    root.write("stems/vocals.wav", b"ordinary vocal source")?;
    root.write(
        "project.json",
        br#"{"version":2,"name":"Transcription capture","settings":{}}"#,
    )?;
    let mut project = crate::integration::read_project(&root.0)?;
    assert!(capture(&project, vec![], 10., Tier::Align).is_err());
    let input = capture_transcription(&project, 10.)?;
    assert!(input.draft.is_empty());
    assert!(input.check(&|| false).is_ok());
    assert!(capture_transcription(&project, f64::NAN).is_err());
    fs::write(
        root.0.join("stems/vocals.wav"),
        b"a replaced vocal source with different length",
    )?;
    assert!(input.check(&|| false).is_err());
    assert!(capture_transcription(&project, 10.).is_err());
    project.lanes.clear();
    assert!(capture_transcription(&project, 10.).is_err());
    assert!(matches!(
        transcribe(&project, 10., &|| true, &|_| {}),
        Err(Failure::Cancelled)
    ));
    Ok(())
}
#[test]
fn transcription_known_chunk_assignment_preserves_exact_source_epsilon() {
    let mut lines = transcribed_reference();
    lines[0].words = vec![
        Word {
            w: "before".into(),
            s: 0.,
            e: 0.1,
        },
        Word {
            w: "edge".into(),
            s: 0.9999995,
            e: 1.1,
        },
        Word {
            w: "middle".into(),
            s: 2.,
            e: 2.1,
        },
        Word {
            w: "next".into(),
            s: 3.,
            e: 3.2,
        },
    ];
    assert_eq!(
        chunk_of_each_word(
            &lines,
            &[
                Chunk { start: 0., end: 1. },
                Chunk { start: 1., end: 3. },
                Chunk { start: 3., end: 4. }
            ]
        ),
        [0, 1, 1, 2]
    );
}
#[test]
fn transcription_prefers_usable_ctc_and_does_not_start_qwen_fallback() -> Result<()> {
    let reference = transcribed_reference();
    let anchors = transcribed_anchors();
    let words: Vec<_> = anchors
        .iter()
        .map(|a| domain::CtcWord {
            li: a.li,
            wi: a.wi,
            s: a.s,
            e: a.e,
            score: 0.9,
            voiced: Some(1.),
        })
        .collect();
    let outcome = domain::ctc_outcome(&reference, &words, 10.);
    assert_ne!(outcome.check.verdict, "mismatch");
    let expected = outcome.lines.clone();
    let mut warnings = vec![];
    let lines = time_transcription(
        &reference,
        10.,
        &|| false,
        Some(|| Ok(outcome)),
        || panic!("usable CTC must not invoke Qwen"),
        &mut warnings,
    )?;
    assert_eq!(lines, expected);
    assert_ne!(lines, reference);
    assert!(warnings.is_empty());
    Ok(())
}
#[test]
fn transcription_ctc_mismatch_and_runtime_failure_both_fall_back_to_timed_words() -> Result<()> {
    let reference = transcribed_reference();
    for failed in [false, true] {
        let mut warnings = vec![];
        let lines = time_transcription(
            &reference,
            10.,
            &|| false,
            Some(|| {
                if failed {
                    anyhow::bail!("fixture CTC runtime failure");
                }
                Ok(domain::ctc_outcome(&reference, &[], 10.))
            }),
            || Ok((transcribed_anchors(), vec!["fixture chunk warning".into()])),
            &mut warnings,
        )?;
        assert_ne!(lines, reference);
        assert!((lines[0].words[0].s - 0.25).abs() < 1e-9);
        assert_eq!(warnings.len(), 2);
        assert_eq!(warnings[1], "fixture chunk warning");
    }
    Ok(())
}
#[test]
fn transcription_cancel_never_enters_fallback_and_untimed_words_are_never_success() {
    let reference = transcribed_reference();
    let cancelled = std::cell::Cell::new(false);
    let mut warnings = vec![];
    let result = time_transcription(
        &reference,
        10.,
        &|| cancelled.get(),
        Some(|| {
            cancelled.set(true);
            anyhow::bail!("interrupted CTC")
        }),
        || panic!("cancelled CTC must not invoke Qwen"),
        &mut warnings,
    );
    assert!(result.unwrap_err().to_string().contains("cancelled"));
    let result = time_transcription(
        &reference,
        10.,
        &|| false,
        None::<fn() -> Result<domain::Outcome>>,
        || Ok((vec![], vec![])),
        &mut warnings,
    );
    assert!(result.unwrap_err().to_string().contains("Could not time"));
    assert!(
        time_transcription(
            &reference,
            10.,
            &|| true,
            Some(|| panic!("cancelled before CTC")),
            || panic!("cancelled before Qwen"),
            &mut warnings
        )
        .is_err()
    );
}
#[test]
fn transcription_heard_cache_requires_unforced_language_and_reports_seventy_percent() -> Result<()>
{
    let root = Scratch::new()?;
    let input = inputs(&root);
    let chunks = [Chunk {
        start: 0.,
        end: 10.,
    }];
    let heard = [domain::ChunkText {
        start: 0.,
        end: 10.,
        text: "actual cached words".into(),
        label: Some("English".into()),
    }];
    let mut warnings = vec![];
    write_heard(&input, Some("English"), &heard, &mut warnings, &|| false);
    assert!(read_heard(&input, Some(None)).is_none());
    write_heard(&input, None, &heard, &mut warnings, &|| false);
    let progress = std::cell::RefCell::new(vec![]);
    let (text, cached) = hear_chunks(
        &input,
        &root,
        &root.0.join("unused.f32"),
        0,
        &chunks,
        None,
        70.,
        &mut warnings,
        &|| false,
        &|p| progress.borrow_mut().push(p.percent),
    )?;
    assert!(cached);
    assert_eq!(text, heard);
    assert_eq!(*progress.borrow(), [70.]);
    assert!(warnings.is_empty());
    Ok(())
}
#[cfg(unix)]
#[test]
fn transcription_forced_aligner_protocol_returns_real_anchors_or_refuses_bad_packets() -> Result<()>
{
    use std::os::unix::fs::PermissionsExt;
    for (packet, expected) in [
        (r#"[{"start":0.25,"end":0.6},{"start":1.1,"end":1.5}]"#, 0),
        ("[]", 1),
        (r#"[{"start":1e100,"end":0},{"start":1.1,"end":1.5}]"#, 2),
    ] {
        let root = Scratch::new()?;
        let mut input = inputs(&root);
        input.draft = transcribed_reference();
        let sentinel = root.write("lyrics.json", b"publication forbidden")?;
        let pcm = root.write("pcm.f32", &vec![0.25f32.to_le_bytes(); 48000].concat())?;
        let script = format!(
            "#!/bin/sh\nout=\nwhile [ \"$#\" -gt 0 ]; do\n if [ \"$1\" = --align-output ]; then shift; out=$1; fi\n shift\ndone\nprintf '%s' '{}' > \"$out\"\n",
            packet
        );
        let executable = root.write("fixture-aligner", script.as_bytes())?;
        fs::set_permissions(&executable, fs::Permissions::from_mode(0o700))?;
        let mut warnings = vec![];
        let progress = std::cell::RefCell::new(vec![]);
        let placed = place_chunks(
            &input,
            &root,
            &pcm,
            48000,
            &[Chunk { start: 0., end: 3. }],
            &flat_words(&input.draft),
            &[0, 0],
            &HashSet::new(),
            Some("en"),
            70.,
            30.,
            &executable,
            &mut warnings,
            &|| false,
            &|p| progress.borrow_mut().push(p.percent),
        );
        match expected {
            0 => {
                let placed = placed?;
                assert_eq!(placed.len(), 2);
                assert_eq!(placed[0].s, 0.25);
                assert_eq!(placed[1].e, 1.5);
                assert!(warnings.is_empty());
            }
            1 => {
                assert!(placed?.is_empty());
                assert_eq!(warnings.len(), 1);
            }
            _ => assert!(placed.is_err()),
        }
        assert_eq!(*progress.borrow(), [100.]);
        assert_eq!(fs::read(sentinel)?, b"publication forbidden");
    }
    Ok(())
}

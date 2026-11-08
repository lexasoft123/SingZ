//! Source resolver policy vectors. Inference/network are injectable boundaries;
//! proposals and source identities remain the production implementations.
use super::*;
use crate::{alignmentoutcome_domain::Check, lyrics_edit::Word};
use std::{
    cell::{Cell, RefCell},
    collections::VecDeque,
    fs,
    path::PathBuf,
    rc::Rc,
    sync::{
        Arc,
        atomic::{AtomicU64, Ordering},
    },
};

struct Fixture(PathBuf);
impl Fixture {
    fn new() -> Result<Self> {
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let root = std::env::temp_dir().join(format!(
            "singz-lyrics-resolution-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&root)?;
        let frames = 160u32;
        let rate = 8000u32;
        let mut wav = Vec::new();
        wav.extend(b"RIFF");
        wav.extend((36 + frames * 2).to_le_bytes());
        wav.extend(b"WAVEfmt ");
        wav.extend(16u32.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(1u16.to_le_bytes());
        wav.extend(rate.to_le_bytes());
        wav.extend((rate * 2).to_le_bytes());
        wav.extend(2u16.to_le_bytes());
        wav.extend(16u16.to_le_bytes());
        wav.extend(b"data");
        wav.extend((frames * 2).to_le_bytes());
        wav.resize(44 + frames as usize * 2, 0);
        fs::write(root.join("song.wav"), wav)?;
        fs::write(
            root.join("project.json"),
            serde_json::to_vec(
                &json!({"version":2,"name":"Artist - Song","songFile":"song.wav","settings":{},"foreignProject":{"keep":true}}),
            )?,
        )?;
        Ok(Self(root))
    }
    fn project(&self) -> Result<Project> {
        let mut project = crate::integration::read_project(&self.0)?;
        let mut pitch = crate::project_pitch::Pitch::default();
        pitch.duration = 30.;
        project.pitch = Arc::new(pitch);
        Ok(project)
    }
}
impl Drop for Fixture {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}
#[derive(Clone, Debug, PartialEq)]
enum Call {
    Lookup(Option<String>, String, Option<String>),
    Candidate(u64, f64),
    Align(Tier, Vec<Line>),
    Transcribe,
}
#[derive(Default)]
struct FakeOps {
    calls: RefCell<Vec<Call>>,
    lookups: RefCell<VecDeque<std::result::Result<lrclib::Lookup, Failure>>>,
    candidates: RefCell<VecDeque<std::result::Result<Option<lrclib::Hit>, Failure>>>,
    aligned: RefCell<VecDeque<std::result::Result<lyrics_align::Output, Failure>>>,
    transcribed: RefCell<VecDeque<std::result::Result<lyrics_align::Transcription, Failure>>>,
    cancel_after: Option<Rc<Cell<bool>>>,
}
impl FakeOps {
    fn after(&self) {
        if let Some(cancel) = &self.cancel_after {
            cancel.set(true);
        }
    }
    fn lookup_answer(&self, answer: lrclib::Lookup) {
        self.lookups.borrow_mut().push_back(Ok(answer));
    }
    fn align_answer(&self, answer: lyrics_align::Output) {
        self.aligned.borrow_mut().push_back(Ok(answer));
    }
    fn transcribe_answer(&self) {
        self.transcribed
            .borrow_mut()
            .push_back(Ok(lyrics_align::Transcription {
                lines: lines("New heard words", 4.),
                cached_heard: false,
                warnings: vec!["native timing warning".into()],
            }));
    }
}
impl Operations for FakeOps {
    fn lookup(
        &self,
        meta: &lrclib::TrackMeta,
        _: &dyn Fn() -> bool,
    ) -> std::result::Result<lrclib::Lookup, Failure> {
        self.calls.borrow_mut().push(Call::Lookup(
            meta.artist.clone(),
            meta.title.clone(),
            meta.album.clone(),
        ));
        let answer = self
            .lookups
            .borrow_mut()
            .pop_front()
            .expect("unexpected online lookup");
        self.after();
        answer
    }
    fn candidate(
        &self,
        id: u64,
        duration: f64,
        _: &dyn Fn() -> bool,
    ) -> std::result::Result<Option<lrclib::Hit>, Failure> {
        self.calls.borrow_mut().push(Call::Candidate(id, duration));
        let answer = self
            .candidates
            .borrow_mut()
            .pop_front()
            .expect("unexpected candidate fetch");
        self.after();
        answer
    }
    fn align(
        &self,
        _: &Project,
        lines: Vec<Line>,
        tier: Tier,
        _: &dyn Fn() -> bool,
        _: &dyn Fn(Progress),
    ) -> std::result::Result<lyrics_align::Output, Failure> {
        self.calls.borrow_mut().push(Call::Align(tier, lines));
        let answer = self
            .aligned
            .borrow_mut()
            .pop_front()
            .expect("unexpected model alignment");
        self.after();
        answer
    }
    fn transcribe(
        &self,
        _: &Project,
        _: &dyn Fn() -> bool,
        _: &dyn Fn(Progress),
    ) -> std::result::Result<lyrics_align::Transcription, Failure> {
        self.calls.borrow_mut().push(Call::Transcribe);
        let answer = self
            .transcribed
            .borrow_mut()
            .pop_front()
            .expect("unexpected model transcription");
        self.after();
        answer
    }
}
fn lines(text: &str, start: f64) -> Vec<Line> {
    let words: Vec<_> = text
        .split_whitespace()
        .enumerate()
        .map(|(i, w)| Word {
            w: w.into(),
            s: start + i as f64 * 0.5,
            e: start + (i + 1) as f64 * 0.5,
        })
        .collect();
    vec![Line {
        start,
        end: words.last().unwrap().e,
        text: text.into(),
        words,
    }]
}
fn check(method: &str, verdict: &str) -> Check {
    Check {
        method: method.into(),
        verdict: verdict.into(),
        matched_pct: if verdict == "mismatch" { 12. } else { 91. },
        median_shift: 1.25,
        bad_lines: vec![0],
        extra_sung: false,
    }
}
fn saved(source: &str) -> Value {
    json!({"source":source,"credit":"Artist — original version","lines":lines("Original sung words",10.),"foreign":{"keep":[1,2,3]}})
}
fn meta(title: &str, artist: &str) -> lrclib::TrackMeta {
    lrclib::TrackMeta {
        title: title.into(),
        artist: Some(artist.into()),
        album: None,
        alt_title: None,
        duration_sec: 30.,
    }
}
fn run_policy(
    project: &Project,
    previous: Option<&Value>,
    intent: Intent,
    ops: &FakeOps,
) -> std::result::Result<Proposal, Failure> {
    let meta = meta("Song", "Artist");
    resolve(
        project,
        previous,
        intent,
        &meta,
        &meta,
        ops,
        &|| false,
        &|_| {},
    )
}
fn online_hit() -> lrclib::Lookup {
    lrclib::Lookup::Hit {
        lines: lines("Matched online lyrics", 2.),
        credit: "Online artist — Song".into(),
    }
}
fn aligned(method: &str, verdict: &str, start: f64) -> lyrics_align::Output {
    lyrics_align::Output {
        lines: lines("Original sung words", start),
        check: check(method, verdict),
        aligned: verdict != "mismatch",
        cached_heard: true,
        warnings: vec!["placement warning".into()],
    }
}
fn derived_fields_absent(raw: &Value) {
    for name in [
        "aligned",
        "check",
        "base",
        "engine",
        "lrclibPending",
        "lookup",
    ] {
        assert!(raw.get(name).is_none(), "stale field {name}: {raw}");
    }
}

#[test]
fn automatic_online_and_edited_caches_are_sticky_without_network_or_models() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    for source in ["edited", "lrclib"] {
        let mut original = saved(source);
        original["lrclibPending"] = json!(true);
        original["lookup"] = json!(0);
        original["aligned"] = json!(true);
        original["check"] = json!(check("qwen", "match"));
        let ops = FakeOps::default();
        let proposal = run_policy(&project, Some(&original), Intent::Auto, &ops)?;
        assert_eq!(proposal.raw, original);
        assert!(!proposal.write && proposal.cached);
        assert_eq!(proposal.check.unwrap().median_shift, 1.25);
        assert!(ops.calls.borrow().is_empty());
    }
    Ok(())
}
#[test]
fn outage_born_and_legacy_whisper_caches_keep_their_pending_state_on_network_down() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    for pending in [None, Some(true)] {
        let mut original = saved("whisper");
        if let Some(pending) = pending {
            original["lrclibPending"] = json!(pending);
        }
        let ops = FakeOps::default();
        ops.lookup_answer(lrclib::Lookup::Down);
        let proposal = run_policy(&project, Some(&original), Intent::Auto, &ops)?;
        assert_eq!(proposal.raw, original);
        assert!(!proposal.write && proposal.cached);
        assert_eq!(ops.calls.borrow().len(), 1);
    }
    Ok(())
}
#[test]
fn definitive_miss_settles_the_current_ladder_once_and_preserves_transcription() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut original = saved("whisper");
    original["engine"] = json!("legacy-transcriber");
    original["lrclibPending"] = json!(true);
    let ops = FakeOps::default();
    ops.lookup_answer(lrclib::Lookup::Miss);
    let settled = run_policy(&project, Some(&original), Intent::Auto, &ops)?;
    assert!(settled.write && settled.cached);
    assert_eq!(settled.raw["lrclibPending"], false);
    assert_eq!(settled.raw["lookup"], LOOKUP_VERSION);
    assert_eq!(settled.raw["engine"], "legacy-transcriber");
    assert_eq!(settled.raw["lines"], original["lines"]);
    assert_eq!(settled.raw["foreign"], original["foreign"]);
    let quiet = FakeOps::default();
    let next = run_policy(&project, Some(&settled.raw), Intent::Auto, &quiet)?;
    assert!(!next.write && next.cached);
    assert!(quiet.calls.borrow().is_empty());
    Ok(())
}
#[test]
fn improved_lookup_ladder_reasks_only_older_settled_whisper_versions() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    for version in [None, Some(1), Some(2), Some(3), Some(4)] {
        let mut original = saved("whisper");
        original["lrclibPending"] = json!(false);
        if let Some(version) = version {
            original["lookup"] = json!(version);
        }
        let ops = FakeOps::default();
        let outdated = version.is_none_or(|v| v < LOOKUP_VERSION);
        if outdated {
            ops.lookup_answer(online_hit());
        }
        let proposal = run_policy(&project, Some(&original), Intent::Auto, &ops)?;
        assert_eq!(proposal.write, outdated);
        assert_eq!(
            proposal.raw["source"],
            if outdated { "lrclib" } else { "whisper" }
        );
        assert_eq!(ops.calls.borrow().len(), usize::from(outdated));
    }
    Ok(())
}
#[test]
fn explicit_transcribe_reuses_whisper_even_when_provisional_without_network_or_model() -> Result<()>
{
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut original = saved("whisper");
    original["lrclibPending"] = json!(true);
    original["lookup"] = json!(1);
    let ops = FakeOps::default();
    let result = run_policy(&project, Some(&original), Intent::Transcribe, &ops)?;
    assert_eq!(result.raw, original);
    assert!(!result.write && result.cached);
    assert!(ops.calls.borrow().is_empty());
    Ok(())
}
#[test]
fn explicit_transcribe_replaces_edited_words_and_clears_old_alignment_metadata() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut original = saved("edited");
    original["aligned"] = json!(true);
    original["base"] = original["lines"].clone();
    original["check"] = json!(check("ctc", "match"));
    let ops = FakeOps::default();
    ops.transcribe_answer();
    let proposal = run_policy(&project, Some(&original), Intent::Transcribe, &ops)?;
    assert_eq!(*ops.calls.borrow(), [Call::Transcribe]);
    assert!(proposal.write && !proposal.cached);
    assert_eq!(proposal.raw["source"], "whisper");
    assert_eq!(proposal.raw["lines"], json!(lines("New heard words", 4.)));
    assert_eq!(proposal.raw["engine"], ENGINE);
    assert_eq!(proposal.raw["lookup"], LOOKUP_VERSION);
    assert_eq!(proposal.raw["lrclibPending"], false);
    assert_eq!(proposal.raw["foreign"], original["foreign"]);
    for field in ["aligned", "check", "base", "credit"] {
        assert!(proposal.raw.get(field).is_none());
    }
    assert_eq!(proposal.warnings, ["native timing warning"]);
    Ok(())
}
#[test]
fn repeated_fast_and_precise_alignment_always_start_from_original_phrasing() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut original = saved("lrclib");
    let base = lines("Original sung words", 1.);
    original["base"] = json!(base);
    let first_ops = FakeOps::default();
    first_ops.align_answer(aligned("qwen", "retimed", 5.));
    let first = run_policy(&project, Some(&original), Intent::Align, &first_ops)?;
    assert_eq!(
        *first_ops.calls.borrow(),
        [Call::Align(Tier::Align, base.clone())]
    );
    assert_eq!(first.raw["base"], json!(base));
    assert_eq!(first.raw["source"], "lrclib");
    assert_eq!(first.raw["credit"], original["credit"]);
    assert_eq!(first.raw["foreign"], original["foreign"]);
    assert_eq!(first.raw["engine"], ENGINE);
    for (intent, tier, method) in [
        (Intent::Align, Tier::Align, "qwen"),
        (Intent::Precise, Tier::Precise, "ctc"),
    ] {
        let ops = FakeOps::default();
        ops.align_answer(aligned(method, "match", 7.));
        let next = run_policy(&project, Some(&first.raw), intent, &ops)?;
        assert_eq!(*ops.calls.borrow(), [Call::Align(tier, base.clone())]);
        assert_eq!(next.raw["base"], json!(base));
        assert!(next.write);
        assert_eq!(next.raw["aligned"], true);
        assert_eq!(next.raw["check"]["method"], method);
        if method == "ctc" {
            assert!(next.raw.get("engine").is_none());
        }
    }
    Ok(())
}
#[test]
fn stale_base_text_shape_or_malformed_rows_are_refused_as_alignment_reference() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let bases = [
        json!(lines("Other words entirely", 1.)),
        json!([]),
        json!([{"text":"Original sung words","start":1}]),
        json!(
            lines("Original sung words", 1.)
                .into_iter()
                .map(|mut l| {
                    l.words.pop();
                    l
                })
                .collect::<Vec<_>>()
        ),
    ];
    for base in bases {
        let mut original = saved("edited");
        original["base"] = base;
        let current: Vec<Line> = serde_json::from_value(original["lines"].clone())?;
        let ops = FakeOps::default();
        ops.align_answer(aligned("qwen", "match", 8.));
        let result = run_policy(&project, Some(&original), Intent::Align, &ops)?;
        assert_eq!(
            *ops.calls.borrow(),
            [Call::Align(Tier::Align, current.clone())]
        );
        assert_eq!(result.raw["base"], json!(current));
    }
    Ok(())
}
#[test]
fn mismatch_keeps_current_saved_words_and_alignment_flag_with_transient_check_only() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    for (intent, method) in [(Intent::Align, "qwen"), (Intent::Precise, "ctc")] {
        let mut original = saved("edited");
        original["aligned"] = json!(true);
        original["base"] = json!(lines("Original sung words", 1.));
        original["check"] = json!(check("qwen", "match"));
        let ops = FakeOps::default();
        ops.align_answer(aligned(method, "mismatch", 2.));
        let result = run_policy(&project, Some(&original), intent, &ops)?;
        assert!(!result.write && !result.cached);
        assert_eq!(result.raw, original);
        let transient = result.check.unwrap();
        assert_eq!(transient.verdict, "mismatch");
        assert_eq!(transient.method, method);
        assert_eq!(result.raw["check"]["verdict"], "match");
    }
    Ok(())
}
#[test]
fn selecting_candidate_clears_known_metadata_but_preserves_foreign_members() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut original = saved("whisper");
    for (field, value) in [
        ("aligned", json!(true)),
        ("check", json!(check("ctc", "match"))),
        ("base", original["lines"].clone()),
        ("engine", json!(ENGINE)),
        ("lrclibPending", json!(true)),
        ("lookup", json!(1)),
    ] {
        original[field] = value;
    }
    let ops = FakeOps::default();
    ops.candidates.borrow_mut().push_back(Ok(Some(lrclib::Hit {
        lines: lines("Selected version", 3.),
        credit: "Selected artist — version".into(),
    })));
    let selected = run_policy(&project, Some(&original), Intent::Candidate(123), &ops)?;
    assert_eq!(*ops.calls.borrow(), [Call::Candidate(123, 30.)]);
    assert!(selected.write && !selected.cached && selected.check.is_none());
    assert_eq!(selected.raw["source"], "lrclib");
    assert_eq!(selected.raw["credit"], "Selected artist — version");
    assert_eq!(selected.raw["foreign"], original["foreign"]);
    derived_fields_absent(&selected.raw);
    Ok(())
}
#[test]
fn cancellation_after_candidate_fetch_returns_no_publishable_proposal() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let original = saved("edited");
    let cancelled = Rc::new(Cell::new(false));
    let ops = FakeOps {
        cancel_after: Some(cancelled.clone()),
        ..Default::default()
    };
    ops.candidates.borrow_mut().push_back(Ok(Some(lrclib::Hit {
        lines: lines("Selected version", 3.),
        credit: "new".into(),
    })));
    let metadata = meta("Song", "Artist");
    let result = resolve(
        &project,
        Some(&original),
        Intent::Candidate(9),
        &metadata,
        &metadata,
        &ops,
        &|| cancelled.get(),
        &|_| {},
    );
    assert!(matches!(result, Err(Failure::Cancelled)));
    assert_eq!(original, saved("edited"));
    assert!(!fixture.0.join("lyrics.json").exists());
    Ok(())
}
#[test]
fn automatic_online_hit_needs_no_vocal_stems_or_local_model() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    assert!(!project.lanes.iter().any(|(i, _)| *i == 0));
    let ops = FakeOps::default();
    ops.lookup_answer(online_hit());
    let result = run_policy(&project, None, Intent::Auto, &ops)?;
    assert_eq!(result.raw["source"], "lrclib");
    assert!(result.write);
    assert_eq!(ops.calls.borrow().len(), 1);
    assert!(!fixture.0.join("lyrics.json").exists());
    Ok(())
}
#[test]
fn filename_metadata_is_a_retry_only_for_miss_and_transcription_records_network_outages()
-> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let tags = meta("Incorrect tag title", "Incorrect tag artist");
    let filename = meta("Song", "Artist");
    let retry = FakeOps::default();
    retry.lookup_answer(lrclib::Lookup::Miss);
    retry.lookup_answer(online_hit());
    let result = resolve(
        &project,
        None,
        Intent::Auto,
        &tags,
        &filename,
        &retry,
        &|| false,
        &|_| {},
    )?;
    assert_eq!(result.raw["source"], "lrclib");
    assert_eq!(
        *retry.calls.borrow(),
        [
            Call::Lookup(tags.artist.clone(), tags.title.clone(), None),
            Call::Lookup(filename.artist.clone(), filename.title.clone(), None)
        ]
    );
    let down = FakeOps::default();
    down.lookup_answer(lrclib::Lookup::Down);
    down.transcribe_answer();
    let result = resolve(
        &project,
        None,
        Intent::Auto,
        &tags,
        &filename,
        &down,
        &|| false,
        &|_| {},
    )?;
    assert_eq!(result.raw["source"], "whisper");
    assert_eq!(result.raw["lrclibPending"], true);
    assert_eq!(result.raw["lookup"], LOOKUP_VERSION);
    assert_eq!(result.raw["engine"], ENGINE);
    assert_eq!(
        *down.calls.borrow(),
        [
            Call::Lookup(tags.artist.clone(), tags.title.clone(), None),
            Call::Transcribe
        ]
    );
    let miss = FakeOps::default();
    miss.lookup_answer(lrclib::Lookup::Miss);
    miss.transcribe_answer();
    let mut album_only = filename.clone();
    album_only.album = Some("Different album".into());
    let result = resolve(
        &project,
        None,
        Intent::Auto,
        &album_only,
        &filename,
        &miss,
        &|| false,
        &|_| {},
    )?;
    assert_eq!(result.raw["lrclibPending"], false);
    assert_eq!(miss.calls.borrow().len(), 2);
    Ok(())
}
#[test]
fn unavailable_models_propagate_exact_consent_information_without_replacing_lyrics() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let original = saved("edited");
    let ops = FakeOps::default();
    ops.aligned
        .borrow_mut()
        .push_back(Err(Failure::NeedsModel(vec![lyrics_align::NeedModel {
            id: "aligner".into(),
            size_mb: 1263,
            required_files: vec!["mms-fa.onnx".into()],
            flavor: crate::model_catalog::Flavor::IntelMac,
        }])));
    match run_policy(&project, Some(&original), Intent::Precise, &ops) {
        Err(Failure::NeedsModel(needs)) => {
            assert_eq!(needs.len(), 1);
            assert_eq!(needs[0].id, "aligner");
            assert_eq!(needs[0].size_mb, 1263);
            assert_eq!(needs[0].required_files, ["mms-fa.onnx"]);
        }
        other => panic!("Expected model consent, got {other:?}"),
    }
    let transcribe = FakeOps::default();
    transcribe.lookup_answer(lrclib::Lookup::Miss);
    transcribe
        .transcribed
        .borrow_mut()
        .push_back(Err(Failure::NeedsEngine(vec!["llama-server".into()])));
    assert!(
        matches!(run_policy(&project,None,Intent::Auto,&transcribe),Err(Failure::NeedsEngine(engines)) if engines==["llama-server"])
    );
    assert!(!fixture.0.join("lyrics.json").exists());
    Ok(())
}
#[test]
fn cancellation_before_work_or_after_inference_never_returns_a_write_proposal() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let metadata = meta("Song", "Artist");
    let empty = FakeOps::default();
    assert!(matches!(
        resolve(
            &project,
            None,
            Intent::Auto,
            &metadata,
            &metadata,
            &empty,
            &|| true,
            &|_| {}
        ),
        Err(Failure::Cancelled)
    ));
    assert!(empty.calls.borrow().is_empty());
    for intent in [Intent::Align, Intent::Transcribe] {
        let cancelled = Rc::new(Cell::new(false));
        let ops = FakeOps {
            cancel_after: Some(cancelled.clone()),
            ..Default::default()
        };
        ops.align_answer(aligned("qwen", "match", 3.));
        ops.transcribe_answer();
        let result = resolve(
            &project,
            Some(&saved("edited")),
            intent,
            &metadata,
            &metadata,
            &ops,
            &|| cancelled.get(),
            &|_| {},
        );
        assert!(matches!(result, Err(Failure::Cancelled)));
    }
    Ok(())
}

#[test]
fn align_intents_without_a_reference_use_auto_instead_of_requesting_alignment_models() -> Result<()>
{
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    for intent in [Intent::Align, Intent::Precise] {
        let online = FakeOps::default();
        online.lookup_answer(online_hit());
        let proposal = run_policy(&project, None, intent, &online)?;
        assert_eq!(proposal.raw["source"], "lrclib");
        assert_eq!(online.calls.borrow().len(), 1);
        let mut whisper = saved("whisper");
        whisper["lrclibPending"] = json!(false);
        whisper["lookup"] = json!(LOOKUP_VERSION);
        let cached = FakeOps::default();
        let proposal = run_policy(&project, Some(&whisper), intent, &cached)?;
        assert_eq!(proposal.raw, whisper);
        assert!(cached.calls.borrow().is_empty());
    }
    Ok(())
}
#[test]
fn transcription_propagates_speech_model_consent_after_online_miss() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let ops = FakeOps::default();
    ops.lookup_answer(lrclib::Lookup::Miss);
    ops.transcribed
        .borrow_mut()
        .push_back(Err(Failure::NeedsModel(vec![lyrics_align::NeedModel {
            id: "qwen-asr".into(),
            size_mb: 1346,
            required_files: vec!["missing-mmproj.gguf".into(), "missing-aligner.gguf".into()],
            flavor: crate::model_catalog::Flavor::host(),
        }])));
    match run_policy(&project, None, Intent::Auto, &ops) {
        Err(Failure::NeedsModel(needs)) => {
            assert_eq!(needs[0].id, "qwen-asr");
            assert_eq!(needs[0].size_mb, 1346);
            assert_eq!(
                needs[0].required_files,
                ["missing-mmproj.gguf", "missing-aligner.gguf"]
            );
        }
        other => panic!("Expected missing speech model parts, got {other:?}"),
    }
    assert_eq!(
        *ops.calls.borrow(),
        [
            Call::Lookup(Some("Artist".into()), "Song".into(), None),
            Call::Transcribe
        ]
    );
    Ok(())
}
#[test]
fn aborted_network_error_is_cancellation_and_cannot_replace_previous_words_with_error() -> Result<()>
{
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let metadata = meta("Song", "Artist");
    for intent in [Intent::Auto, Intent::Candidate(7)] {
        let cancelled = Rc::new(Cell::new(false));
        let ops = FakeOps {
            cancel_after: Some(cancelled.clone()),
            ..Default::default()
        };
        ops.lookups
            .borrow_mut()
            .push_back(Err(Failure::Error("fixture HTTP read interrupted".into())));
        ops.candidates
            .borrow_mut()
            .push_back(Err(Failure::Error("fixture HTTP read interrupted".into())));
        let result = resolve(
            &project,
            None,
            intent,
            &metadata,
            &metadata,
            &ops,
            &|| cancelled.get(),
            &|_| {},
        );
        assert!(
            matches!(result, Err(Failure::Cancelled)),
            "Aborted network operation became an ordinary failure: {result:?}"
        );
    }
    Ok(())
}

#[test]
fn source_less_legacy_transcription_rechecks_online_without_losing_outage_memory() -> Result<()> {
    let fixture = Fixture::new()?;
    let project = fixture.project()?;
    let mut legacy = saved("whisper");
    legacy.as_object_mut().unwrap().remove("source");
    legacy["lrclibPending"] = json!(true);
    assert!(needs_online_recheck(&legacy));

    let unavailable = FakeOps::default();
    unavailable.lookup_answer(lrclib::Lookup::Down);
    let retained = run_policy(&project, Some(&legacy), Intent::Auto, &unavailable)?;
    assert!(!retained.write && retained.cached);
    assert_eq!(retained.raw["source"], "whisper");
    assert_eq!(retained.raw["lrclibPending"], true);
    assert_eq!(retained.raw["lines"], legacy["lines"]);
    assert!(retained.raw.get("lookup").is_none());
    assert_eq!(unavailable.calls.borrow().len(), 1);

    let recovered = FakeOps::default();
    recovered.lookup_answer(online_hit());
    let upgraded = run_policy(&project, Some(&legacy), Intent::Auto, &recovered)?;
    assert!(upgraded.write && !upgraded.cached);
    assert_eq!(upgraded.raw["source"], "lrclib");
    assert_eq!(upgraded.raw["foreign"], legacy["foreign"]);
    assert!(
        legacy.get("source").is_none(),
        "Reading a legacy cache mutated it"
    );
    assert!(!fixture.0.join("lyrics.json").exists());
    Ok(())
}

#[test]
fn online_recheck_tracks_lookup_upgrades_without_reopening_future_settled_verdicts() {
    // These are source cache vectors: absence/null are not a definitive miss;
    // a newer recorded ladder stays settled when the application downgrades.
    let cases = [
        (json!({}), true),
        (json!({"lrclibPending":false}), true),
        (json!({"lrclibPending":false,"lookup":2}), true),
        (json!({"lrclibPending":false,"lookup":3}), false),
        (json!({"lrclibPending":false,"lookup":4}), false),
        (json!({"lrclibPending":true,"lookup":4}), true),
        (json!({"lrclibPending":null,"lookup":4}), true),
        (json!({"lookup":4}), true),
        (
            json!({"source":"edited","lrclibPending":true,"lookup":0}),
            false,
        ),
        (
            json!({"source":"lrclib","lrclibPending":true,"lookup":0}),
            false,
        ),
    ];
    for (raw, expected) in cases {
        assert_eq!(needs_online_recheck(&raw), expected, "cache: {raw}");
        if raw.get("source").is_none() {
            let mut explicit = raw.clone();
            explicit["source"] = json!("whisper");
            assert_eq!(
                needs_online_recheck(&explicit),
                expected,
                "explicit cache: {explicit}"
            );
        }
    }
}

#[test]
fn original_source_filename_keeps_lookup_identity_after_project_display_rename() -> Result<()> {
    let fixture = Fixture::new()?;
    let mut project = fixture.project()?;
    let original_filename = "08. Ария - Беспечный ангел [Am +2st].mp3";
    project.raw["sourceFileName"] = json!(original_filename);
    project.name = "My renamed practice session".into();
    project.raw["name"] = json!(project.name);
    assert_eq!(metadata_filename(&project), original_filename);
    let filename = lrclib::meta_from_filename(metadata_filename(&project), 30.);
    assert_eq!(filename.artist.as_deref(), Some("Ария"));
    assert_eq!(filename.title, "Беспечный ангел");
    assert_eq!(filename.duration_sec, 30.);
    assert_eq!(project.raw["songFile"], "song.wav");

    project
        .raw
        .as_object_mut()
        .unwrap()
        .remove("sourceFileName");
    assert_eq!(metadata_filename(&project), "My renamed practice session");
    project.raw["sourceFileName"] = json!("");
    assert_eq!(metadata_filename(&project), "My renamed practice session");
    Ok(())
}

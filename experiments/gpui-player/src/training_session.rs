//! Private native session state: only validated current-prompt receipts advance
//! progress. Capture/scoring and persistence are deliberately separate owners.
use super::training_domain::*;
use anyhow::{Result, ensure};
use serde_json::{Value, json};
// Shared generator identity version, not a native on-disk persistence schema.
pub const FORMAT_VERSION: u32 = 7;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum State {
    Ready,
    Active,
    Completed,
    Abandoned,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Answer {
    Note(u8),
    Degree(u8),
    Interval(u8, Direction),
    Chord(Role),
    Arpeggio(u8, Quality),
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Classification {
    OnTarget,
    Close,
    WrongNote,
    WrongOctave,
    OtherChordTone,
    NonChordTone,
    Unstable,
    Unvoiced,
    OutOfRange,
}
#[derive(Clone, Debug, Default)]
pub struct Metrics {
    pub median_cents_error: Option<f64>,
    pub stable_hold_ratio: Option<f64>,
    pub time_to_settle_ms: Option<f64>,
    pub voiced_coverage: Option<f64>,
    pub detected_midi: Option<f64>,
}
#[derive(Clone, Debug)]
pub struct TargetResult {
    pub index: usize,
    pub classification: Classification,
    pub metrics: Metrics,
}
#[derive(Clone, Debug)]
pub enum Response {
    Vocal(Vec<TargetResult>),
    Identify(Answer),
    Skipped,
}
#[derive(Clone, Debug)]
pub struct Receipt {
    pub prompt_index: usize,
    pub response: Response,
    pub correct: Option<bool>,
    pub completed_at: Option<u64>,
}
#[derive(Clone, Debug)]
pub struct Session {
    id: String,
    config: Config,
    prompts: Vec<Prompt>,
    index: usize,
    state: State,
    results: Vec<Receipt>,
}
impl Session {
    pub fn new(mut config: Config) -> Result<Self> {
        config.intervals.sort();
        config.chord_degrees.sort();
        config.mixed_kinds.sort();
        let prompts = generate(&config)?;
        let id = session_id(&config);
        Ok(Self {
            id,
            config,
            prompts,
            index: 0,
            state: State::Ready,
            results: vec![],
        })
    }
    pub fn id(&self) -> &str {
        &self.id
    }
    pub fn config(&self) -> &Config {
        &self.config
    }
    pub fn prompts(&self) -> &[Prompt] {
        &self.prompts
    }
    pub fn results(&self) -> &[Receipt] {
        &self.results
    }
    pub fn state(&self) -> State {
        self.state
    }
    pub fn current(&self) -> Option<&Prompt> {
        self.prompts.get(self.index)
    }
    pub fn start(&mut self) {
        if self.state == State::Ready {
            self.state = State::Active;
        }
    }
    pub fn abandon(&mut self) {
        if matches!(self.state, State::Ready | State::Active) {
            self.state = State::Abandoned;
        }
    }
    pub fn record(
        &mut self,
        prompt_index: usize,
        response: Response,
        completed_at: Option<u64>,
    ) -> Result<()> {
        ensure!(
            self.state == State::Active,
            "Only an active training session accepts results"
        );
        let prompt = self.current().expect("Active session has a prompt");
        ensure!(
            prompt.index == prompt_index,
            "Training result does not match the current prompt"
        );
        let correct = match &response {
            Response::Skipped => None,
            Response::Identify(answer) => {
                ensure!(
                    prompt.task == Task::Identify,
                    "Vocal prompts require a vocal response"
                );
                Some(identify(prompt, answer)?)
            }
            Response::Vocal(targets) => {
                ensure!(
                    prompt.task != Task::Identify,
                    "Identify prompts require an identify response"
                );
                ensure!(
                    targets.len() == prompt.targets.len(),
                    "A vocal response needs one result per target"
                );
                let mut indexes = vec![];
                for target in targets {
                    ensure!(
                        target.index < targets.len() && !indexes.contains(&target.index),
                        "Invalid/duplicate vocal target index"
                    );
                    indexes.push(target.index);
                    validate_metrics(&target.metrics)?;
                }
                None
            }
        };
        self.results.push(Receipt {
            prompt_index,
            response,
            correct,
            completed_at,
        });
        self.index += 1;
        if self.index == self.prompts.len() {
            self.state = State::Completed;
        }
        Ok(())
    }
}
fn validate_metrics(metrics: &Metrics) -> Result<()> {
    for value in [metrics.median_cents_error, metrics.detected_midi]
        .into_iter()
        .flatten()
    {
        ensure!(value.is_finite(), "Non-finite training metric");
    }
    for value in [metrics.stable_hold_ratio, metrics.voiced_coverage]
        .into_iter()
        .flatten()
    {
        ensure!(
            value.is_finite() && (0.0..=1.0).contains(&value),
            "Invalid training metric ratio"
        );
    }
    if let Some(value) = metrics.time_to_settle_ms {
        ensure!(
            value.is_finite() && value >= 0.,
            "Invalid training settle time"
        );
    }
    Ok(())
}
fn identify(prompt: &Prompt, answer: &Answer) -> Result<bool> {
    Ok(match (prompt.kind, answer) {
        (Kind::Note, Answer::Note(pc)) => {
            ensure!(*pc < 12, "Invalid identified pitch class");
            *pc == prompt.targets[0].midi % 12
        }
        (Kind::Degree, Answer::Degree(degree)) => {
            ensure!((1..=7).contains(degree), "Invalid identified scale degree");
            *degree == prompt.targets[0].degree
        }
        (Kind::Interval, Answer::Interval(number, direction)) => {
            ensure!((2..=8).contains(number), "Invalid identified interval");
            Some(*number) == prompt.interval && Some(*direction) == prompt.direction
        }
        (Kind::Chord, Answer::Chord(role)) => Some(*role) == prompt.role,
        (Kind::Arpeggio, Answer::Arpeggio(degree, quality)) => {
            ensure!((1..=7).contains(degree), "Invalid identified chord degree");
            let chord = prompt.chord.as_ref().unwrap();
            *degree == chord.degree && *quality == chord.quality
        }
        _ => anyhow::bail!("Identify answer kind does not match the prompt"),
    })
}
fn kind_name(kind: Kind) -> &'static str {
    match kind {
        Kind::Note => "note",
        Kind::Degree => "scale-degree",
        Kind::Interval => "interval",
        Kind::Chord => "chord-tone",
        Kind::Arpeggio => "arpeggio",
        Kind::Scale => "scale",
        Kind::Mixed => "mixed",
    }
}
fn stable_config(config: &Config) -> String {
    let mut intervals = config.intervals.clone();
    intervals.sort();
    let mut degrees = config.chord_degrees.clone();
    degrees.sort();
    let mut kinds = config.mixed_kinds.clone();
    kinds.sort();
    let mut value = json!({"key":{"tonicPc":config.tonic,"mode":if config.minor{"minor"}else{"major"}},"range":{"lowMidi":config.low,"highMidi":config.high},
  "exercise":kind_name(config.kind),"taskMode":match config.task{Task::Imitate=>"imitate",Task::Find=>"find",Task::Identify=>"identify"},"length":config.length,"seed":config.seed,
  "direction":match config.direction{DirectionChoice::Both=>"both",DirectionChoice::Ascending=>"ascending",DirectionChoice::Descending=>"descending"},
  "minorScaleForm":if config.harmonic_scale{"harmonic"}else{"natural"},"minorHarmony":if config.harmonic_dominant{"harmonic-dominant"}else{"natural"},
  "intervalSizes":intervals,"chordDegrees":degrees,"mixedKinds":kinds.into_iter().map(kind_name).collect::<Vec<_>>(),"scalePresentation":if config.guided_scale{"guided"}else{"phrase"}});
    if let Some(distance) = config.interval_semitones {
        value["intervalSemitones"] = distance.into();
    }
    canonical(&value)
}
fn canonical(value: &Value) -> String {
    match value {
        Value::Object(map) => {
            let mut keys: Vec<_> = map.keys().collect();
            keys.sort();
            format!(
                "{{{}}}",
                keys.into_iter()
                    .map(|key| format!(
                        "{}:{}",
                        serde_json::to_string(key).unwrap(),
                        canonical(&map[key])
                    ))
                    .collect::<Vec<_>>()
                    .join(",")
            )
        }
        Value::Array(values) => format!(
            "[{}]",
            values.iter().map(canonical).collect::<Vec<_>>().join(",")
        ),
        _ => value.to_string(),
    }
}
fn hash128(value: &str) -> String {
    let mut hash = 0x6c62272e07bb014262b821756295c58du128;
    for code in value.encode_utf16() {
        for byte in [code as u8, (code >> 8) as u8] {
            hash ^= byte as u128;
            hash = hash.wrapping_mul(0x0000000001000000000000000000013b);
        }
    }
    format!("{hash:032x}")
}
fn session_id(config: &Config) -> String {
    format!(
        "training-{}",
        hash128(&format!("{FORMAT_VERSION}:{}", stable_config(config)))
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn identify_correctness_is_derived_for_every_family() {
        for kind in [
            Kind::Note,
            Kind::Degree,
            Kind::Interval,
            Kind::Chord,
            Kind::Arpeggio,
        ] {
            let mut session = Session::new(Config {
                kind,
                task: Task::Identify,
                length: 2,
                ..Default::default()
            })
            .unwrap();
            session.start();
            let p = session.current().unwrap();
            let answer = match kind {
                Kind::Note => Answer::Note(p.targets[0].midi % 12),
                Kind::Degree => Answer::Degree(p.targets[0].degree),
                Kind::Interval => Answer::Interval(p.interval.unwrap(), p.direction.unwrap()),
                Kind::Chord => Answer::Chord(p.role.unwrap()),
                Kind::Arpeggio => {
                    let c = p.chord.as_ref().unwrap();
                    Answer::Arpeggio(c.degree, c.quality)
                }
                _ => unreachable!(),
            };
            session.record(1, Response::Identify(answer), None).unwrap();
            assert_eq!(session.results()[0].correct, Some(true));
            let p = session.current().unwrap();
            let wrong = match kind {
                Kind::Note => Answer::Note((p.targets[0].midi % 12 + 1) % 12),
                Kind::Degree => Answer::Degree(p.targets[0].degree % 7 + 1),
                Kind::Interval => Answer::Interval(
                    p.interval.unwrap(),
                    if p.direction == Some(Direction::Ascending) {
                        Direction::Descending
                    } else {
                        Direction::Ascending
                    },
                ),
                Kind::Chord => Answer::Chord(if p.role == Some(Role::Root) {
                    Role::Third
                } else {
                    Role::Root
                }),
                Kind::Arpeggio => Answer::Arpeggio(
                    p.chord.as_ref().unwrap().degree % 7 + 1,
                    p.chord.as_ref().unwrap().quality,
                ),
                _ => unreachable!(),
            };
            session.record(2, Response::Identify(wrong), None).unwrap();
            assert_eq!(session.results()[1].correct, Some(false));
        }
    }
    #[test]
    fn only_matching_valid_results_advance() {
        let mut session = Session::new(Config {
            length: 2,
            task: Task::Identify,
            ..Default::default()
        })
        .unwrap();
        assert!(session.record(1, Response::Skipped, None).is_err());
        session.start();
        assert!(session.record(2, Response::Skipped, None).is_err());
        assert!(
            session
                .record(1, Response::Identify(Answer::Note(12)), None)
                .is_err()
        );
        assert!(session.results().is_empty());
        let pc = session.current().unwrap().targets[0].midi % 12;
        session
            .record(1, Response::Identify(Answer::Note(pc)), Some(42))
            .unwrap();
        assert_eq!(session.results()[0].correct, Some(true));
        assert!(session.record(1, Response::Skipped, None).is_err());
        session.record(2, Response::Skipped, None).unwrap();
        assert_eq!(session.state(), State::Completed);
        assert!(session.current().is_none());
        assert!(session.record(2, Response::Skipped, None).is_err());
        session.abandon();
        session.start();
        assert_eq!(session.state(), State::Completed);
    }
    #[test]
    fn bad_vocal_metrics_leave_session_unchanged() {
        let mut session = Session::new(Config {
            kind: Kind::Interval,
            length: 1,
            ..Default::default()
        })
        .unwrap();
        session.start();
        let mut targets = vec![
            TargetResult {
                index: 0,
                classification: Classification::OnTarget,
                metrics: Metrics::default(),
            },
            TargetResult {
                index: 1,
                classification: Classification::OnTarget,
                metrics: Metrics::default(),
            },
        ];
        targets[1].metrics.voiced_coverage = Some(f64::NAN);
        assert!(
            session
                .record(1, Response::Vocal(targets.clone()), None)
                .is_err()
        );
        targets[1].metrics.voiced_coverage = Some(1.);
        targets[1].index = 0;
        assert!(
            session
                .record(1, Response::Vocal(targets.clone()), None)
                .is_err()
        );
        assert_eq!(session.current().unwrap().index, 1);
        assert!(session.results().is_empty());
        targets[1].index = 1;
        session.record(1, Response::Vocal(targets), None).unwrap();
        assert_eq!(session.state(), State::Completed);
    }
    #[test]
    fn abandoned_session_cannot_restart_or_award_a_result() {
        let mut session = Session::new(Default::default()).unwrap();
        session.abandon();
        session.start();
        assert_eq!(session.state(), State::Abandoned);
        assert!(session.record(1, Response::Skipped, None).is_err());
    }
    #[test]
    fn stable_identity_normalizes_selector_order_and_preserves_unicode() {
        assert_eq!(
            session_id(&Config::default()),
            "training-eec3cecd9b690b8e1de07f659ce66254"
        );
        let config = Config {
            seed: "голос🎶".into(),
            ..Default::default()
        };
        assert_eq!(
            session_id(&config),
            "training-82f63668d57fe296050612a92f92e1fa"
        );
        let mut reordered = config.clone();
        reordered.intervals.reverse();
        reordered.chord_degrees.reverse();
        reordered.mixed_kinds.reverse();
        assert_eq!(session_id(&config), session_id(&reordered));
        reordered.seed = "another".into();
        assert_ne!(session_id(&config), session_id(&reordered));
        assert_ne!(hash128("costarring"), hash128("liquid"));
    }
}

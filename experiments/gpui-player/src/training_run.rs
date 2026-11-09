//! Native exercise lifecycle. Hardware/process ownership remains in Player;
//! this controller accepts typed cue receipts and fresh native capture only.
use super::{
    microphone, training_audio as audio, training_capture, training_domain as domain,
    training_lock as lock, training_scoring as scoring, training_session as session,
};
use anyhow::{Result, ensure};
use std::time::{Duration, Instant};
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Phase {
    Preparing,
    Cue,
    Respond,
    Completing,
    Feedback,
    Paused,
    Summary,
}
pub struct CuePlan {
    pub cues: Vec<audio::Cue>,
    pub timing: audio::Timing,
    pub countdown: f64,
    pub initial: bool,
}
/// Immutable presentation of a completed receipt. It never contains an answer
/// or observations for a future/current unanswered prompt.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ResultResponse {
    Skipped,
    Identify { correct: bool },
    Vocal(Vec<session::Classification>),
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Acknowledgement {
    pub prompt: domain::Prompt,
    pub response: ResultResponse,
}
#[derive(Clone, Debug, PartialEq)]
pub struct Snapshot {
    pub phase: Phase,
    pub prompt: domain::Prompt,
    pub key: String,
    pub current: usize,
    pub total: usize,
    pub target: usize,
    pub progress: f32,
    pub display_midi: Option<f64>,
    pub countdown: Option<u32>,
    pub tolerance: f64,
    pub error: Option<String>,
    pub outcomes: Vec<String>,
    pub outcome_labels: Vec<String>,
    pub outcome_prompts: Vec<domain::Prompt>,
    pub acknowledgement: Option<Acknowledgement>,
    pub average_signed_cents: Option<f64>,
    pub average_absolute_cents: Option<f64>,
    pub voiced_ratio: Option<f64>,
    pub stable_ratio: Option<f64>,
    pub correct: usize,
    pub close: usize,
    pub attempts: usize,
}
pub struct Run {
    pub session: session::Session,
    pub phase: Phase,
    pub target: usize,
    pub live: lock::LockView,
    pub error: Option<String>,
    pub sound: usize,
    pub volume: f32,
    pub tolerance: f64,
    gate: Option<training_capture::Gate>,
    continuity: lock::Continuity,
    tracker: lock::Lock,
    observations: Vec<scoring::Observation>,
    windows: Vec<scoring::Window>,
    results: Vec<session::TargetResult>,
    capture_generation: u64,
    origin: u64,
    target_start: u64,
    last_capture: u64,
    cue: Option<(u64, bool, f64)>,
    deadline: Option<Instant>,
    waiting: Option<(Vec<domain::Reference>, bool)>,
    preparing_since: Instant,
}
impl Run {
    #[cfg(feature = "ui-tests")]
    pub fn results_for_test(&self) -> usize {
        self.results.len()
    }
    pub fn snapshot(&self) -> Snapshot {
        let config = self.session.config();
        let tonic = super::training_music::note_name(
            60 + config.tonic as i32,
            config.tonic as usize,
            config.minor,
        );
        let key = format!(
            "{} {}",
            tonic.trim_end_matches(|c: char| c.is_ascii_digit() || c == '-'),
            if config.minor { "minor" } else { "major" }
        );
        let mut correct = 0;
        let mut close = 0;
        let mut attempts = 0;
        let outcomes = self
            .session
            .results()
            .iter()
            .map(|r| match &r.response {
                session::Response::Skipped => "Skipped".into(),
                session::Response::Identify(_) => {
                    attempts += 1;
                    if r.correct == Some(true) {
                        correct += 1;
                        "Correct".into()
                    } else {
                        "Try again".into()
                    }
                }
                session::Response::Vocal(targets) => {
                    attempts += 1;
                    if targets.is_empty() { return "No result".into(); }
                    if targets
                        .iter()
                        .all(|t| t.classification == session::Classification::OnTarget)
                    {
                        correct += 1;
                        "On target".into()
                    } else if targets.iter().all(|t| {
                        matches!(
                            t.classification,
                            session::Classification::OnTarget | session::Classification::Close
                        )
                    }) {
                        close += 1;
                        "Close".into()
                    } else {
                        match targets.iter().find(|target|target.classification != session::Classification::OnTarget).map(|target|target.classification) {
                            Some(session::Classification::Close) => "Close",
                            Some(session::Classification::WrongNote) => "Wrong note",
                            Some(session::Classification::WrongOctave) => "Wrong octave",
                            Some(session::Classification::OtherChordTone) => "Other chord tone",
                            Some(session::Classification::NonChordTone) => "Non chord tone",
                            Some(session::Classification::Unstable) => "Unstable",
                            Some(session::Classification::Unvoiced) => "Unvoiced",
                            Some(session::Classification::OutOfRange) => "Out of range",
                            _ => "No result",
                        }.into()
                    }
                }
            })
            .collect();
        let mut cents = vec![];
        let mut voiced = vec![];
        let mut stable = vec![];
        for receipt in self.session.results() {
            if let session::Response::Vocal(targets) = &receipt.response {
                for target in targets {
                    if matches!(
                        target.classification,
                        session::Classification::OnTarget | session::Classification::Close
                    ) {
                        cents.extend(target.metrics.median_cents_error);
                    }
                    voiced.extend(target.metrics.voiced_coverage);
                    stable.extend(target.metrics.stable_hold_ratio);
                }
            }
        }
        let average = |values: &[f64]| {
            (!values.is_empty()).then(|| values.iter().sum::<f64>() / values.len() as f64)
        };
        Snapshot {
            phase: self.phase,
            prompt: self.displayed_prompt().clone(),
            key,
            current: self.displayed_prompt().index,
            total: self.session.prompts().len(),
            target: self.target,
            progress: self.live.progress as f32,
            display_midi: self.live.display_midi,
            countdown: self.countdown(),
            tolerance: self.tolerance,
            error: self.error.clone(),
            outcomes,
            outcome_prompts: self
                .session
                .results()
                .iter()
                .map(|r| self.session.prompts()[r.prompt_index - 1].clone())
                .collect(),
            outcome_labels: self
                .session
                .results()
                .iter()
                .map(|r| self.session.prompts()[r.prompt_index - 1].instruction())
                .collect(),
            acknowledgement: self.session.results().last().map(|receipt|Acknowledgement {
                prompt: self.session.prompts()[receipt.prompt_index - 1].clone(),
                response: match &receipt.response {
                    session::Response::Skipped => ResultResponse::Skipped,
                    session::Response::Identify(_) => ResultResponse::Identify {correct: receipt.correct == Some(true)},
                    session::Response::Vocal(targets) => ResultResponse::Vocal(targets.iter().map(|target|target.classification).collect()),
                },
            }),
            average_signed_cents: average(&cents),
            average_absolute_cents: average(&cents.iter().map(|value|value.abs()).collect::<Vec<_>>()),
            voiced_ratio: average(&voiced),
            stable_ratio: average(&stable),
            correct,
            close,
            attempts,
        }
    }
    pub fn new(config: domain::Config, sound: usize, volume: f32, tolerance: f64) -> Result<Self> {
        let mut session = session::Session::new(config)?;
        session.start();
        Ok(Self {
            session,
            phase: Phase::Preparing,
            target: 0,
            live: Default::default(),
            error: None,
            sound,
            volume,
            tolerance,
            gate: None,
            continuity: Default::default(),
            tracker: lock::Lock::new(tolerance),
            observations: vec![],
            windows: vec![],
            results: vec![],
            capture_generation: 0,
            origin: 0,
            target_start: 0,
            last_capture: 0,
            cue: None,
            deadline: None,
            waiting: None,
            preparing_since: Instant::now(),
        })
    }
    pub fn needs_microphone(&self) -> bool {
        self.session.config().task != domain::Task::Identify
            && self.session.state() == session::State::Active
            && !matches!(self.phase, Phase::Paused | Phase::Summary)
    }
    pub fn displayed_prompt(&self) -> &domain::Prompt {
        if matches!(self.phase, Phase::Feedback | Phase::Summary) {
            let receipt = self.session.results().last().unwrap();
            &self.session.prompts()[receipt.prompt_index - 1]
        } else {
            self.session.current().unwrap()
        }
    }
    pub fn fail(&mut self, error: String) {
        self.phase = if self.session.state() == session::State::Completed {
            Phase::Summary
        } else {
            Phase::Paused
        };
        self.error = Some(error);
        self.waiting = None;
        self.cue = None;
        self.gate = None;
        self.live = Default::default();
    }
    pub fn pause(&mut self) {
        if self.session.state() == session::State::Completed {
            self.phase = Phase::Summary;
        } else {
            self.phase = Phase::Paused;
        }
        self.error = None;
        self.waiting = None;
        self.cue = None;
        self.gate = None;
        self.live = Default::default();
    }
    pub fn resume(&mut self) -> bool {
        if self.phase == Phase::Paused && self.session.state() == session::State::Active {
            self.reset_prompt();
            return true;
        }
        false
    }
    fn reset_prompt(&mut self) {
        self.phase = Phase::Preparing;
        self.target = 0;
        self.live = Default::default();
        self.error = None;
        self.gate = None;
        self.cue = None;
        self.deadline = None;
        self.waiting = None;
        self.observations.clear();
        self.windows.clear();
        self.results.clear();
        self.origin = 0;
        self.target_start = 0;
        self.last_capture = 0;
        self.continuity.reset();
        self.tracker.reset();
        self.preparing_since = Instant::now();
    }
    pub fn replay(&mut self) {
        if self.phase == Phase::Respond {
            self.reset_prompt();
        }
    }
    pub fn skip(&mut self) -> Result<()> {
        if self.phase == Phase::Respond {
            let index = self.session.current().unwrap().index;
            self.session
                .record(index, session::Response::Skipped, None)?;
            self.feedback();
        }
        Ok(())
    }
    pub fn answer(&mut self, answer: session::Answer) -> Result<()> {
        // An already queued click may arrive after the first answer advanced
        // the view. It must not pause or alter the completed receipt.
        if self.phase != Phase::Respond {
            return Ok(());
        }
        ensure!(
            self.phase == Phase::Respond && self.session.config().task == domain::Task::Identify,
            "No identification answer is expected"
        );
        let index = self.session.current().unwrap().index;
        self.session
            .record(index, session::Response::Identify(answer), None)?;
        self.feedback();
        Ok(())
    }
    fn feedback(&mut self) {
        self.phase = Phase::Feedback;
        self.cue = None;
        self.gate = None;
        self.deadline = Some(
            Instant::now()
                + Duration::from_millis(if self.session.state() == session::State::Completed {
                    1400
                } else {
                    350
                }),
        );
    }
    pub fn cue_requested(&mut self, generation: u64, plan: &CuePlan) {
        self.phase = Phase::Cue;
        self.cue = Some((generation, plan.initial, plan.countdown));
        self.deadline = None;
    }
    pub fn cue_receipt(&mut self, status: &audio::Status) {
        let Some((generation, initial, countdown)) = self.cue else {
            return;
        };
        if status.generation != generation || status.end_host_ns == 0 {
            return;
        }
        let audible_end = status
            .end_host_ns
            .saturating_add((status.output_latency_ms * 1_000_000.) as u64);
        if self.deadline.is_none() {
            let remaining = audible_end.saturating_sub(status.now_host_ns) as f64 / 1e9;
            let wait = if initial {
                remaining.max(countdown)
            } else {
                remaining + 0.15
            };
            self.deadline = Some(Instant::now() + Duration::from_secs_f64(wait));
            self.target_start =
                audible_end.saturating_add(((wait - remaining).max(0.) * 1e9) as u64);
        }
        if !status.active
            && self
                .deadline
                .is_some_and(|deadline| Instant::now() >= deadline)
            && status.now_host_ns >= self.target_start
        {
            self.phase = Phase::Respond;
            self.cue = None;
            self.deadline = None;
            if self.origin == 0 {
                self.origin = self.target_start;
            }
            if self.session.config().task != domain::Task::Identify {
                self.gate = Some(training_capture::Gate::new(
                    self.capture_generation,
                    self.origin,
                ));
            }
        }
    }
    pub fn countdown(&self) -> Option<u32> {
        if self.phase == Phase::Cue {
            Some(self.deadline.map_or(1, |d| {
                d.saturating_duration_since(Instant::now())
                    .as_secs_f64()
                    .ceil()
                    .max(1.) as u32
            }))
        } else {
            None
        }
    }
    pub fn tick(&mut self, mic: &microphone::View) -> Result<Option<CuePlan>> {
        // Input remains owned throughout cue playback and the completion hold.
        // Validate it before advancing either phase or committing a receipt.
        if self.session.config().task != domain::Task::Identify
            && matches!(self.phase, Phase::Cue | Phase::Respond | Phase::Completing)
            && (mic.generation != self.capture_generation
                || mic.owner != training_capture::TRAINING_OWNER
                || mic.phase != microphone::Phase::Live
                || !mic.fresh())
        {
            self.fail(mic.error.clone().unwrap_or_else(|| {
                "Microphone capture changed or stopped providing fresh pitch frames. Continue to retry this exercise.".into()
            }));
            return Ok(None);
        }
        if self.phase == Phase::Preparing {
            if self.session.config().task != domain::Task::Identify {
                if matches!(
                    mic.phase,
                    microphone::Phase::Error | microphone::Phase::Permission
                ) {
                    self.fail(
                        mic.error
                            .clone()
                            .unwrap_or_else(|| "The microphone is unavailable.".into()),
                    );
                    return Ok(None);
                }
                if mic.owner != training_capture::TRAINING_OWNER
                    || !mic.fresh()
                    || mic.capture_host_ns == 0
                {
                    if self.preparing_since.elapsed() > Duration::from_secs(15) {
                        self.fail("The microphone did not provide fresh native pitch frames. Review its device and permission in Settings.".into());
                    }
                    return Ok(None);
                }
                self.capture_generation = mic.generation;
            }
            self.waiting = Some((
                self.session
                    .current()
                    .unwrap()
                    .references(self.session.config().guided_scale),
                true,
            ));
        }
        if self.phase == Phase::Feedback && self.deadline.is_some_and(|d| Instant::now() >= d) {
            if self.session.state() == session::State::Completed {
                self.phase = Phase::Summary;
            } else {
                self.reset_prompt();
            }
            return Ok(None);
        }
        if self.phase == Phase::Completing && self.deadline.is_some_and(|d| Instant::now() >= d) {
            let prompt = self.session.current().unwrap();
            if self.target + 1 == prompt.targets.len() {
                let index = prompt.index;
                self.session.record(
                    index,
                    session::Response::Vocal(std::mem::take(&mut self.results)),
                    None,
                )?;
                self.feedback();
                return Ok(None);
            }
            self.target += 1;
            self.tracker.reset();
            self.live = Default::default();
            if prompt.needs_target_reference(self.session.config().guided_scale) {
                self.waiting = Some((
                    vec![domain::target_reference(
                        prompt.kind,
                        prompt.targets[self.target].midi,
                    )],
                    false,
                ));
            } else {
                self.target_start = self.last_capture + 350_000_000;
                self.phase = Phase::Respond;
                self.gate = Some(training_capture::Gate::new(
                    self.capture_generation,
                    self.origin,
                ));
            }
        }
        if let Some((references, initial)) = self.waiting.take() {
            ensure!(!references.is_empty(), "The exercise has no reference cues");
            let events: usize = references
                .iter()
                .map(|r| if r.cue.together { 1 } else { r.cue.notes.len() })
                .sum();
            let duration: f64 = references
                .iter()
                .map(|r| {
                    r.duration_seconds as f64
                        * if r.cue.together {
                            1.
                        } else {
                            r.cue.notes.len() as f64
                        }
                })
                .sum();
            let seconds = references[0].duration_seconds;
            self.phase = Phase::Cue;
            return Ok(Some(CuePlan {
                cues: references.into_iter().map(|r| r.cue).collect(),
                timing: audio::Timing {
                    note_duration: seconds,
                    sequence_gap: 0.1,
                    context_gap: 0.18,
                    question_gap: 0.18,
                    answer_gap: 0.18,
                    attack: 0.032,
                    release: 0.22f32.min(seconds * 0.36),
                    peak_gain: 1.,
                },
                countdown: if initial {
                    (if events > 1 { events as f64 * 2. } else { 3. }).max(duration.ceil())
                } else {
                    seconds.ceil() as f64
                },
                initial,
            }));
        }
        if self.phase == Phase::Respond && self.session.config().task != domain::Task::Identify {
            if mic.capture_host_ns < self.target_start {
                return Ok(None);
            }
            if let Some(frame) = self.gate.as_mut().and_then(|g| g.ingest(mic)) {
                if frame.detector_reset {
                    self.continuity.reset();
                    self.tracker.reset();
                }
                let mut observation = frame.observation;
                if let Some(hz) = self.continuity.update(
                    observation.at,
                    observation.frequency,
                    observation.confidence,
                    lock::MIN_CONFIDENCE,
                ) {
                    observation.frequency = hz;
                    observation.midi = scoring::fractional_midi(hz);
                } else {
                    observation.frequency = 0.;
                    observation.midi = None;
                }
                let prompt = self.session.current().unwrap();
                self.live = self.tracker.update(
                    observation.at,
                    observation.midi,
                    observation.confidence,
                    prompt.targets[self.target].midi as f64,
                    lock::MIN_CONFIDENCE,
                )?;
                self.observations.push(observation);
                if self.observations.len() > 512 {
                    self.observations.remove(0);
                }
                if self.live.locked {
                    self.last_capture = mic.capture_host_ns;
                    self.windows.push(scoring::Window {
                        index: self.target,
                        start: (self.target_start - self.origin) as f64 / 1e6,
                        end: observation
                            .at
                            .max((self.target_start - self.origin) as f64 / 1e6 + 1.),
                    });
                    self.results.push(scoring::completed_target(
                        prompt,
                        &self.windows,
                        &self.observations,
                        Some((self.session.config().low, self.session.config().high)),
                        Default::default(),
                        Some(lock::HOLD_MS),
                    )?);
                    self.phase = Phase::Completing;
                    self.deadline = Some(Instant::now() + Duration::from_millis(250));
                }
            }
        }
        Ok(None)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    fn identify() -> Run {
        Run::new(
            domain::Config {
                task: domain::Task::Identify,
                length: 1,
                low: 57,
                high: 58,
                ..Default::default()
            },
            0,
            0.65,
            10.,
        )
        .unwrap()
    }
    #[test]
    fn identify_waits_for_matching_audible_completion_and_never_needs_capture() {
        let mut run = identify();
        assert!(!run.needs_microphone());
        let plan = run.tick(&Default::default()).unwrap().unwrap();
        run.cue_requested(7, &plan);
        let mut status = audio::Status {
            generation: 6,
            start_host_ns: 100,
            end_host_ns: 200,
            now_host_ns: 1000,
            active: false,
            output_latency_ms: 0.,
            notes: vec![],
        };
        run.cue_receipt(&status);
        assert_eq!(run.phase, Phase::Cue);
        assert!(run.deadline.is_none());
        status.generation = 7;
        run.cue_receipt(&status);
        assert_eq!(run.phase, Phase::Cue);
        run.deadline = Some(Instant::now());
        status.now_host_ns = run.target_start;
        status.active = true;
        run.cue_receipt(&status);
        assert_eq!(run.phase, Phase::Cue);
        status.active = false;
        run.cue_receipt(&status);
        assert_eq!(run.phase, Phase::Respond);
    }
    #[test]
    fn duplicate_answers_cannot_change_a_receipt_or_reopen_a_completed_session() {
        let mut run = identify();
        run.phase = Phase::Respond;
        let answer = session::Answer::Note(run.displayed_prompt().targets[0].midi % 12);
        run.answer(answer).unwrap();
        run.answer(session::Answer::Note(0)).unwrap();
        assert_eq!(run.session.results().len(), 1);
        assert_eq!(run.snapshot().correct, 1);
        run.fail("Late output error".into());
        run.resume();
        assert_eq!(run.phase, Phase::Summary);
    }
    #[test]
    fn pause_discards_pending_audio_and_partial_hold_but_keeps_current_prompt() {
        let mut run = identify();
        let plan = run.tick(&Default::default()).unwrap().unwrap();
        run.cue_requested(3, &plan);
        run.pause();
        assert!(run.cue.is_none());
        assert!(run.tick(&Default::default()).unwrap().is_none());
        assert!(run.session.results().is_empty());
        run.resume();
        assert_eq!(run.phase, Phase::Preparing);
        assert!(run.tick(&Default::default()).unwrap().is_some());
    }
    #[test]
    fn failure_retry_keeps_completed_receipt_and_rejects_old_cue() {
        let mut config = identify().session.config().clone();
        config.length = 2;
        let mut run = Run::new(config, 0, 0.65, 10.).unwrap();
        run.phase = Phase::Respond;
        let answer = session::Answer::Note(run.displayed_prompt().targets[0].midi % 12);
        run.answer(answer).unwrap();
        run.deadline = Some(Instant::now());
        run.tick(&Default::default()).unwrap();
        let plan = run.tick(&Default::default()).unwrap().unwrap();
        run.cue_requested(9, &plan);
        let id = run.session.id().to_owned();
        let index = run.session.current().unwrap().index;
        let receipt = format!("{:?}", run.session.results());
        run.fail("Owned native output disconnected".into());
        assert_eq!(run.phase, Phase::Paused);
        assert!(run.gate.is_none() && run.cue.is_none());
        run.resume();
        assert_eq!(run.session.id(), id);
        assert_eq!(run.session.current().unwrap().index, index);
        assert_eq!(format!("{:?}", run.session.results()), receipt);
        assert_eq!(run.snapshot().correct, 1);
        let fresh = run.tick(&Default::default()).unwrap().unwrap();
        run.cue_requested(10, &fresh);
        run.cue_receipt(&audio::Status {
            generation: 9, start_host_ns: 100, end_host_ns: 200,
            now_host_ns: 1000, active: false, output_latency_ms: 0., notes: vec![],
        });
        assert_eq!(run.phase, Phase::Cue);
        assert!(run.deadline.is_none());
        assert_eq!(format!("{:?}", run.session.results()), receipt);
    }
    #[test]
    fn skipped_prompts_are_not_counted_as_attempts_and_feedback_holds_before_summary() {
        let mut run = identify();
        run.phase = Phase::Respond;
        run.skip().unwrap();
        assert_eq!(run.phase, Phase::Feedback);
        assert_eq!(run.snapshot().attempts, 0);
        run.tick(&Default::default()).unwrap();
        assert_eq!(run.phase, Phase::Feedback);
        run.deadline = Some(Instant::now());
        run.tick(&Default::default()).unwrap();
        assert_eq!(run.phase, Phase::Summary);
    }
    #[test]
    fn vocal_input_loss_precedes_cue_and_completion_advancement() {
        for phase in [Phase::Cue, Phase::Respond, Phase::Completing] {
            for fault in 0..6 {
                let mut run = Run::new(domain::Config {
                    length: 2, low: 57, high: 58, ..Default::default()
                }, 0, 0.65, 10.).unwrap();
                let mut mic = microphone::View {
                    phase: microphone::Phase::Live, owner: training_capture::TRAINING_OWNER,
                    generation: 17, sequence: 1, capture_host_ns: 10_000_000_000,
                    clarity: 1., ..Default::default()
                };
                let plan = run.tick(&mic).unwrap().unwrap();
                run.cue_requested(7, &plan);
                // Reach the completion hold through the real pitch lock/scorer,
                // rather than inserting a synthetic completed target result.
                if phase != Phase::Cue {
                    let status = audio::Status {
                        generation: 7, start_host_ns: 1, end_host_ns: 2,
                        now_host_ns: mic.capture_host_ns, active: false,
                        output_latency_ms: 0., notes: vec![],
                    };
                    run.cue_receipt(&status);
                    run.deadline = Some(Instant::now());
                    run.cue_receipt(&status);
                    let target = run.displayed_prompt().targets[0].midi;
                    mic.frequency = (440. * 2_f64.powf((target as f64 - 69.) / 12.)) as f32;
                    for _ in 0..150 {
                        mic.sequence += 1;
                        mic.capture_host_ns += 20_000_000;
                        run.tick(&mic).unwrap();
                        if run.phase == Phase::Completing { break; }
                    }
                    assert_eq!(run.phase, Phase::Completing);
                    assert_eq!(run.results.len(), 1);
                    if phase == Phase::Respond { run.phase = Phase::Respond; }
                }
                let id = run.session.id().to_owned();
                // An expired hold must never outrank a failed/changed capture.
                run.deadline = Some(Instant::now());
                match fault {
                    0 => { mic.phase = microphone::Phase::Error; mic.error = Some("Input disconnected".into()); }
                    1 => mic.phase = microphone::Phase::Permission,
                    2 => mic.phase = microphone::Phase::Off,
                    3 => mic.generation += 1,
                    4 => mic.owner = 1,
                    _ => mic.sampled_at = Instant::now() - Duration::from_secs(1),
                }
                assert!(run.tick(&mic).unwrap().is_none());
                assert_eq!(run.phase, Phase::Paused, "{phase:?} / {fault}");
                assert!(run.session.results().is_empty());
                assert_eq!(run.session.id(), id);
                assert!(!run.needs_microphone());
                assert!(run.gate.is_none() && run.cue.is_none() && run.waiting.is_none());
                if fault == 0 { assert_eq!(run.error.as_deref(), Some("Input disconnected")); }
                run.resume();
                assert_eq!(run.session.id(), id);
                assert!(run.results.is_empty() && run.observations.is_empty());
                assert_eq!(run.phase, Phase::Preparing);
            }
        }
    }
    #[test]
    fn continue_changes_capture_intent_only_for_an_active_paused_run() {
        let mut run = identify();
        let id = run.session.id().to_owned();
        for phase in [Phase::Preparing, Phase::Cue, Phase::Respond, Phase::Completing, Phase::Feedback] {
            run.phase = phase;
            run.target = 1;
            assert!(!run.resume(), "stale Continue accepted during {phase:?}");
            assert_eq!(run.phase, phase);
            assert_eq!(run.target, 1);
        }
        run.pause();
        assert!(run.resume());
        assert_eq!(run.phase, Phase::Preparing);
        assert_eq!(run.target, 0);
        assert_eq!(run.session.id(), id);
        assert!(!run.resume());
        run.phase = Phase::Respond;
        let answer = session::Answer::Note(run.displayed_prompt().targets[0].midi % 12);
        run.answer(answer).unwrap();
        run.phase = Phase::Summary;
        assert!(!run.resume());
        assert_eq!(run.snapshot().correct, 1);
    }
    #[test]
    fn microphone_permission_failure_pauses_before_scheduling_a_cue() {
        let mut run = Run::new(Default::default(), 0, 0.65, 10.).unwrap();
        assert!(run.needs_microphone());
        let mic = microphone::View {
            phase: microphone::Phase::Permission,
            error: Some("Permission denied".into()),
            ..Default::default()
        };
        assert!(run.tick(&mic).unwrap().is_none());
        assert_eq!(run.phase, Phase::Paused);
        assert_eq!(run.error.as_deref(), Some("Permission denied"));
        assert!(!run.needs_microphone());
    }
    #[test]
    fn acknowledgement_projects_only_the_last_completed_prompt_and_survives_the_next_cue() {
        let mut config=identify().session.config().clone();config.length=2;
        let mut run=Run::new(config,0,0.65,10.).unwrap();
        assert!(run.snapshot().acknowledgement.is_none());
        run.phase=Phase::Respond;
        let pc=run.displayed_prompt().targets[0].midi%12;
        run.answer(session::Answer::Note((pc+1)%12)).unwrap();
        let acknowledgement=run.snapshot().acknowledgement.unwrap();
        assert_eq!(acknowledgement.prompt.index,1);
        assert_eq!(acknowledgement.response,ResultResponse::Identify{correct:false});
        run.deadline=Some(Instant::now());run.tick(&Default::default()).unwrap();
        let preparing=run.snapshot();assert_eq!(preparing.prompt.index,2);assert_eq!(preparing.acknowledgement,Some(acknowledgement.clone()));
        let plan=run.tick(&Default::default()).unwrap().unwrap();run.cue_requested(9,&plan);
        assert_eq!(run.phase,Phase::Cue);assert_eq!(run.snapshot().acknowledgement,Some(acknowledgement.clone()));
        run.phase=Phase::Respond;assert_eq!(run.snapshot().acknowledgement,Some(acknowledgement));
        let answer=session::Answer::Note(run.displayed_prompt().targets[0].midi%12);run.answer(answer).unwrap();
        let final_ack=run.snapshot().acknowledgement.unwrap();assert_eq!(final_ack.prompt.index,2);assert_eq!(final_ack.response,ResultResponse::Identify{correct:true});
    }
    #[test]
    fn signed_pitch_projection_excludes_note_choice_errors_and_preserves_absolute_error() {
        let mut run=Run::new(domain::Config{length:3,low:57,high:58,..Default::default()},0,0.65,10.).unwrap();
        for (index,(classification,cents)) in [(session::Classification::OnTarget,8.),(session::Classification::Close,-18.),(session::Classification::WrongOctave,1200.)].into_iter().enumerate() {
            run.session.record(index+1,session::Response::Vocal(vec![session::TargetResult{index:0,classification,metrics:session::Metrics{median_cents_error:Some(cents),..Default::default()}}]),None).unwrap();
        }
        run.phase=Phase::Summary;
        let snapshot=run.snapshot();assert_eq!(snapshot.average_signed_cents,Some(-5.));assert_eq!(snapshot.average_absolute_cents,Some(13.));
        assert_eq!((snapshot.correct,snapshot.close,snapshot.attempts),(1,1,3));
        assert_eq!(snapshot.outcomes,["On target","Close","Wrong octave"]);
        assert_eq!(snapshot.acknowledgement.unwrap().response,ResultResponse::Vocal(vec![session::Classification::WrongOctave]));
    }

}

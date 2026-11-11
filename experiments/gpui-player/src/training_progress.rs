//! Source-compatible normalized training preferences and completion facts.
//! Completed sessions only; no PCM, active capture or raw observations on disk.
use super::{training_domain as domain, training_session as session};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use std::collections::BTreeMap;
const MAX_SAFE: u64 = 9_007_199_254_740_991;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Key {
    pub tonic_pc: u8,
    pub mode: String,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Range {
    pub low_midi: u8,
    pub high_midi: u8,
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Preferences {
    pub format_version: u8,
    pub tonic_pc: u8,
    pub key_mode: String,
    pub exercise: domain::Kind,
    pub length: usize,
    pub range: Range,
    pub notation: String,
    pub task_mode: domain::Task,
    pub direction: domain::DirectionChoice,
    pub interval_sizes: Vec<u8>,
    pub chord_degrees: Vec<u8>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub scale_presentation: Option<String>,
}
impl Default for Preferences {
    fn default() -> Self {
        Self {
            format_version: 2,
            tonic_pc: 0,
            key_mode: "major".into(),
            exercise: domain::Kind::Note,
            length: 20,
            range: Range {
                low_midi: 48,
                high_midi: 72,
            },
            notation: "note-names".into(),
            task_mode: domain::Task::Imitate,
            direction: domain::DirectionChoice::Both,
            interval_sizes: (2..=8).collect(),
            chord_degrees: (1..=7).collect(),
            scale_presentation: None,
        }
    }
}
impl Preferences {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.format_version == 2
                && self.tonic_pc < 12
                && matches!(self.key_mode.as_str(), "major" | "minor"),
            "Unsupported training preferences"
        );
        ensure!(
            (1..=1000).contains(&self.length)
                && self.range.low_midi >= 36
                && self.range.low_midi <= self.range.high_midi
                && self.range.high_midi <= 84,
            "Invalid training range or length"
        );
        ensure!(
            matches!(
                self.notation.as_str(),
                "note-names" | "scale-degrees" | "movable-do"
            ) && self
                .scale_presentation
                .as_ref()
                .is_none_or(|s| matches!(s.as_str(), "guided" | "phrase")),
            "Invalid training presentation"
        );
        for (values, lo, hi) in [(&self.interval_sizes, 2, 8), (&self.chord_degrees, 1, 7)] {
            let mut sorted = values.clone();
            sorted.sort();
            sorted.dedup();
            ensure!(
                sorted.len() == values.len() && values.iter().all(|n| (lo..=hi).contains(n)),
                "Invalid training selections"
            );
        }
        Ok(())
    }
}
#[derive(Clone, Copy, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Counter {
    pub attempts: u64,
    pub on_target: u64,
    pub close: u64,
}
impl Counter {
    fn add(&mut self, outcome: Option<bool>) {
        self.attempts += 1;
        match outcome {
            Some(true) => self.on_target += 1,
            Some(false) => self.close += 1,
            None => {}
        }
    }
    fn merge(&mut self, other: &Self) {
        self.attempts += other.attempts;
        self.on_target += other.on_target;
        self.close += other.close;
    }
    fn valid(&self) -> bool {
        self.attempts <= MAX_SAFE
            && self.on_target <= self.attempts
            && self.close <= self.attempts - self.on_target
    }
}
#[derive(Clone, Debug, Default, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Aggregate {
    pub sessions: u64,
    pub attempts: u64,
    pub on_target: u64,
    pub close: u64,
    pub centered_cents_sum: f64,
    pub centered_cents_count: u64,
    pub stable_ratio_sum: f64,
    pub stable_ratio_count: u64,
    pub voiced_ratio_sum: f64,
    pub voiced_ratio_count: u64,
    pub scale_degree_occurrences: u64,
    pub scale_degree_on_target_occurrences: u64,
    pub scale_degree_close_occurrences: u64,
    pub interval_occurrences: u64,
    pub interval_on_target_occurrences: u64,
    pub interval_close_occurrences: u64,
    pub chord_role_occurrences: u64,
    pub chord_role_on_target_occurrences: u64,
    pub chord_role_close_occurrences: u64,
    pub by_exercise: BTreeMap<String, Counter>,
    pub by_scale_degree: BTreeMap<String, Counter>,
    pub by_interval: BTreeMap<String, Counter>,
    pub by_chord_role: BTreeMap<String, Counter>,
}
fn total(map: &BTreeMap<String, Counter>) -> Counter {
    let mut c = Counter::default();
    for x in map.values() {
        c.merge(x)
    }
    c
}
fn outcome(class: session::Classification) -> Option<bool> {
    match class {
        session::Classification::OnTarget => Some(true),
        session::Classification::Close => Some(false),
        _ => None,
    }
}
fn combined(values: impl Iterator<Item = Option<bool>>) -> Option<bool> {
    let v: Vec<_> = values.collect();
    if !v.is_empty() && v.iter().all(|x| *x == Some(true)) {
        Some(true)
    } else if !v.is_empty() && v.iter().all(Option::is_some) {
        Some(false)
    } else {
        None
    }
}
pub fn name(kind: domain::Kind) -> &'static str {
    match kind {
        domain::Kind::Note => "note",
        domain::Kind::Degree => "scale-degree",
        domain::Kind::Interval => "interval",
        domain::Kind::Chord => "chord-tone",
        domain::Kind::Arpeggio => "arpeggio",
        domain::Kind::Scale => "scale",
        domain::Kind::Mixed => "mixed",
    }
}
impl Aggregate {
    pub fn merge(&mut self, other: &Self) {
        self.sessions += other.sessions;
        self.attempts += other.attempts;
        self.on_target += other.on_target;
        self.close += other.close;
        self.centered_cents_sum += other.centered_cents_sum;
        self.centered_cents_count += other.centered_cents_count;
        self.stable_ratio_sum += other.stable_ratio_sum;
        self.stable_ratio_count += other.stable_ratio_count;
        self.voiced_ratio_sum += other.voiced_ratio_sum;
        self.voiced_ratio_count += other.voiced_ratio_count;
        for (into, add) in [
            (&mut self.by_exercise, &other.by_exercise),
            (&mut self.by_scale_degree, &other.by_scale_degree),
            (&mut self.by_interval, &other.by_interval),
            (&mut self.by_chord_role, &other.by_chord_role),
        ] {
            for (key, value) in add {
                into.entry(key.clone()).or_default().merge(value);
            }
        }
        self.occurrences();
    }
    fn occurrences(&mut self) {
        let d = total(&self.by_scale_degree);
        self.scale_degree_occurrences = d.attempts;
        self.scale_degree_on_target_occurrences = d.on_target;
        self.scale_degree_close_occurrences = d.close;
        let d = total(&self.by_interval);
        self.interval_occurrences = d.attempts;
        self.interval_on_target_occurrences = d.on_target;
        self.interval_close_occurrences = d.close;
        let d = total(&self.by_chord_role);
        self.chord_role_occurrences = d.attempts;
        self.chord_role_on_target_occurrences = d.on_target;
        self.chord_role_close_occurrences = d.close;
    }
    pub fn average(sum: f64, count: u64) -> Option<f64> {
        (count > 0).then(|| sum / count as f64)
    }
    pub fn weakest(map: &BTreeMap<String, Counter>) -> Vec<String> {
        let mut values: Vec<_> = map.iter().filter(|(_, v)| v.attempts >= 2).collect();
        values.sort_by(|(ka, a), (kb, b)| {
            let ar = (a.on_target + a.close) as f64 / a.attempts as f64;
            let br = (b.on_target + b.close) as f64 / b.attempts as f64;
            ar.total_cmp(&br)
                .then(b.attempts.cmp(&a.attempts))
                .then(ka.cmp(kb))
        });
        values.into_iter().take(3).map(|(k, _)| k.clone()).collect()
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Completion {
    pub format_version: u8,
    pub session_id: String,
    pub completed_at: u64,
    pub key: Key,
    pub exercise: domain::Kind,
    pub task_mode: domain::Task,
    pub aggregate: Aggregate,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub interval_semitones: Option<u8>,
}
impl Completion {
    pub fn create(session: &session::Session, completed_at: u64) -> Result<Self> {
        ensure!(
            session.state() == session::State::Completed
                && session.results().len() == session.prompts().len(),
            "Only completed training can be recorded"
        );
        let mut a = Aggregate {
            sessions: 1,
            ..Default::default()
        };
        for result in session.results() {
            let prompt = session
                .prompts()
                .get(result.prompt_index - 1)
                .context("Training result has no prompt")?;
            if matches!(result.response, session::Response::Skipped) {
                continue;
            }
            let landed = match &result.response {
                session::Response::Identify(_) => result.correct.filter(|v| *v),
                session::Response::Vocal(targets) => {
                    for t in targets {
                        let m = &t.metrics;
                        if outcome(t.classification).is_some() {
                            if let Some(v) = m.median_cents_error {
                                a.centered_cents_sum += v;
                                a.centered_cents_count += 1;
                            }
                        }
                        if let Some(v) = m.stable_hold_ratio {
                            a.stable_ratio_sum += v;
                            a.stable_ratio_count += 1;
                        }
                        if let Some(v) = m.voiced_coverage {
                            a.voiced_ratio_sum += v;
                            a.voiced_ratio_count += 1;
                        }
                    }
                    combined(targets.iter().map(|t| outcome(t.classification)))
                }
                session::Response::Skipped => unreachable!(),
            };
            let mut counts = Counter {
                attempts: a.attempts,
                on_target: a.on_target,
                close: a.close,
            };
            counts.add(landed);
            a.attempts = counts.attempts;
            a.on_target = counts.on_target;
            a.close = counts.close;
            a.by_exercise
                .entry(name(prompt.kind).into())
                .or_default()
                .add(landed);
            let mut degrees: BTreeMap<u8, Vec<Option<bool>>> = BTreeMap::new();
            for (index, target) in prompt.targets.iter().enumerate() {
                let value = if let session::Response::Vocal(targets) = &result.response {
                    targets
                        .iter()
                        .find(|t| t.index == index)
                        .and_then(|t| outcome(t.classification))
                } else {
                    landed
                };
                degrees.entry(target.degree).or_default().push(value);
            }
            for (degree, values) in degrees {
                a.by_scale_degree
                    .entry(degree.to_string())
                    .or_default()
                    .add(combined(values.into_iter()));
            }
            if prompt.kind == domain::Kind::Interval {
                a.by_interval
                    .entry(format!(
                        "{}-{}",
                        prompt.interval.unwrap(),
                        if prompt.direction == Some(domain::Direction::Descending) {
                            "descending"
                        } else {
                            "ascending"
                        }
                    ))
                    .or_default()
                    .add(landed);
            }
            if let Some(role) = prompt.role {
                a.by_chord_role
                    .entry(
                        match role {
                            domain::Role::Root => "root",
                            domain::Role::Third => "third",
                            domain::Role::Fifth => "fifth",
                        }
                        .into(),
                    )
                    .or_default()
                    .add(landed);
            }
        }
        a.occurrences();
        let config = session.config();
        let receipt = Self {
            format_version: 1,
            session_id: session.id().into(),
            completed_at,
            key: Key {
                tonic_pc: config.tonic,
                mode: if config.minor { "minor" } else { "major" }.into(),
            },
            exercise: config.kind,
            task_mode: config.task,
            aggregate: a,
            interval_semitones: config.interval_semitones,
        };
        receipt.validate()?;
        Ok(receipt)
    }
    pub fn validate(&self) -> Result<()> {
        let a = &self.aggregate;
        ensure!(
            self.format_version == 1
                && !self.session_id.is_empty()
                && self.session_id.len() <= 640
                && self.session_id.encode_utf16().count() <= 160
                && self.completed_at <= MAX_SAFE
                && self.key.tonic_pc < 12
                && matches!(self.key.mode.as_str(), "major" | "minor")
                && self
                    .interval_semitones
                    .is_none_or(|n| (1..=12).contains(&n)),
            "Invalid training receipt identity"
        );
        ensure!(
            a.sessions == 1
                && a.attempts <= 1000
                && Counter {
                    attempts: a.attempts,
                    on_target: a.on_target,
                    close: a.close
                }
                .valid(),
            "Invalid training receipt counts"
        );
        for (map, allowed) in [
            (
                &a.by_exercise,
                vec![
                    "note",
                    "scale-degree",
                    "interval",
                    "chord-tone",
                    "arpeggio",
                    "scale",
                ],
            ),
            (&a.by_scale_degree, vec!["1", "2", "3", "4", "5", "6", "7"]),
            (&a.by_chord_role, vec!["root", "third", "fifth"]),
        ] {
            ensure!(
                map.len() <= 16
                    && map.iter().all(|(k, c)| allowed.contains(&k.as_str())
                        && c.valid()
                        && c.attempts <= a.attempts),
                "Invalid training outcome map"
            );
        }
        ensure!(
            a.by_interval.len() <= 14
                && a.by_interval.iter().all(|(k, c)| {
                    let Some((n, d)) = k.split_once('-') else {
                        return false;
                    };
                    n.len() == 1
                        && n.parse::<u8>().is_ok_and(|n| (2..=8).contains(&n))
                        && matches!(d, "ascending" | "descending")
                        && c.valid()
                        && c.attempts <= a.attempts
                }),
            "Invalid interval outcomes"
        );
        ensure!(
            total(&a.by_exercise)
                == Counter {
                    attempts: a.attempts,
                    on_target: a.on_target,
                    close: a.close
                },
            "Inconsistent exercise totals"
        );
        for (map, attempts, on_target, close) in [
            (
                &a.by_scale_degree,
                a.scale_degree_occurrences,
                a.scale_degree_on_target_occurrences,
                a.scale_degree_close_occurrences,
            ),
            (
                &a.by_interval,
                a.interval_occurrences,
                a.interval_on_target_occurrences,
                a.interval_close_occurrences,
            ),
            (
                &a.by_chord_role,
                a.chord_role_occurrences,
                a.chord_role_on_target_occurrences,
                a.chord_role_close_occurrences,
            ),
        ] {
            ensure!(
                total(map)
                    == Counter {
                        attempts,
                        on_target,
                        close
                    },
                "Inconsistent occurrence totals"
            );
        }
        let count = |key: &str| a.by_exercise.get(key).map_or(0, |c| c.attempts);
        let limit = count("note")
            + count("scale-degree")
            + count("chord-tone")
            + count("interval") * 2
            + count("arpeggio") * 3
            + count("scale") * 8;
        ensure!(
            a.centered_cents_count <= limit
                && a.centered_cents_sum.is_finite()
                && a.centered_cents_sum.abs() <= a.centered_cents_count as f64 * 1200.,
            "Invalid pitch metrics"
        );
        for (sum, count) in [
            (a.stable_ratio_sum, a.stable_ratio_count),
            (a.voiced_ratio_sum, a.voiced_ratio_count),
        ] {
            ensure!(
                count <= limit && sum.is_finite() && sum >= 0. && sum <= count as f64,
                "Invalid evidence ratios"
            );
        }
        if self.task_mode == domain::Task::Identify {
            ensure!(
                a.centered_cents_count == 0
                    && a.stable_ratio_count == 0
                    && a.voiced_ratio_count == 0,
                "Identify receipt contains pitch evidence"
            );
        }
        if self.exercise != domain::Kind::Mixed && a.attempts > 0 {
            ensure!(
                a.by_exercise.len() == 1 && a.by_exercise.contains_key(name(self.exercise)),
                "Receipt exercise differs"
            );
        }
        ensure!(
            total(&a.by_interval) == a.by_exercise.get("interval").copied().unwrap_or_default()
                && total(&a.by_chord_role)
                    == a.by_exercise.get("chord-tone").copied().unwrap_or_default(),
            "Inconsistent skill totals"
        );
        let minimum = count("note")
            + count("scale-degree")
            + count("chord-tone")
            + count("arpeggio") * 3
            + count("interval")
            + count("scale") * 7;
        ensure!(
            (minimum..=minimum + count("interval")).contains(&a.scale_degree_occurrences),
            "Invalid degree occurrence count"
        );
        Ok(())
    }
    pub fn qualifies_day(&self) -> bool {
        self.aggregate.attempts
            >= if self.exercise == domain::Kind::Interval && self.task_mode == domain::Task::Imitate
            {
                18
            } else {
                6
            }
            && self.aggregate.voiced_ratio_sum > 0.
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    pub fn complete(
        kind: domain::Kind,
        task: domain::Task,
        length: usize,
        seed: &str,
        skip_first: bool,
    ) -> Completion {
        let mut s = session::Session::new(domain::Config {
            kind,
            task,
            length,
            seed: seed.into(),
            ..Default::default()
        })
        .unwrap();
        s.start();
        while let Some(p) = s.current().cloned() {
            let response = if skip_first && p.index == 1 {
                session::Response::Skipped
            } else if task == domain::Task::Identify {
                session::Response::Identify(session::Answer::Note(p.targets[0].midi % 12))
            } else {
                session::Response::Vocal(
                    p.targets
                        .iter()
                        .enumerate()
                        .map(|(index, _)| session::TargetResult {
                            index,
                            classification: session::Classification::OnTarget,
                            metrics: session::Metrics {
                                median_cents_error: Some(20.),
                                stable_hold_ratio: Some(0.8),
                                voiced_coverage: Some(0.6),
                                ..Default::default()
                            },
                        })
                        .collect(),
                )
            };
            s.record(p.index, response, None).unwrap();
        }
        Completion::create(&s, 1234).unwrap()
    }
    #[test]
    fn source_receipt_counts_skips_and_distinct_degrees_and_only_normalized_facts() {
        let receipt = complete(domain::Kind::Note, domain::Task::Imitate, 2, "skip", true);
        let a = &receipt.aggregate;
        assert_eq!((a.sessions, a.attempts, a.on_target, a.close), (1, 1, 1, 0));
        assert_eq!(a.centered_cents_sum, 20.);
        assert_eq!(a.centered_cents_count, 1);
        assert_eq!(a.voiced_ratio_sum, 0.6);
        assert_eq!(
            a.by_exercise["note"],
            Counter {
                attempts: 1,
                on_target: 1,
                close: 0
            }
        );
        let encoded = serde_json::to_string(&receipt).unwrap();
        for forbidden in [
            "observations",
            "rawAudio",
            "microphone",
            "cues",
            "prompts",
            "targets",
            "project.json",
        ] {
            assert!(!encoded.contains(forbidden));
        }
        let scale = complete(
            domain::Kind::Scale,
            domain::Task::Imitate,
            1,
            "degrees",
            false,
        );
        assert_eq!(scale.aggregate.scale_degree_occurrences, 7);
        assert_eq!(scale.aggregate.centered_cents_count, 8);
        let arpeggio = complete(
            domain::Kind::Arpeggio,
            domain::Task::Imitate,
            1,
            "arp",
            false,
        );
        assert_eq!(arpeggio.aggregate.scale_degree_occurrences, 3);
    }
    #[test]
    fn partial_session_cannot_be_recorded_and_identify_has_no_pitch_or_practice_day() {
        let mut active = session::Session::new(Default::default()).unwrap();
        active.start();
        assert!(Completion::create(&active, 1).is_err());
        let r = complete(
            domain::Kind::Note,
            domain::Task::Identify,
            18,
            "identify",
            false,
        );
        assert_eq!(r.aggregate.attempts, 18);
        assert_eq!(r.aggregate.on_target, 18);
        assert_eq!(r.aggregate.centered_cents_count, 0);
        assert!(!r.qualifies_day());
        assert!(
            !complete(domain::Kind::Note, domain::Task::Imitate, 5, "short", false).qualifies_day()
        );
        assert!(
            complete(domain::Kind::Note, domain::Task::Imitate, 6, "day", false).qualifies_day()
        );
        assert!(
            !complete(
                domain::Kind::Interval,
                domain::Task::Imitate,
                15,
                "five sets",
                false
            )
            .qualifies_day()
        );
        assert!(
            complete(
                domain::Kind::Interval,
                domain::Task::Imitate,
                18,
                "six sets",
                false
            )
            .qualifies_day()
        );
    }
    #[test]
    fn wrong_octave_metrics_do_not_become_an_intonation_tendency() {
        let mut s = session::Session::new(domain::Config {
            length: 1,
            ..Default::default()
        })
        .unwrap();
        s.start();
        s.record(
            1,
            session::Response::Vocal(vec![session::TargetResult {
                index: 0,
                classification: session::Classification::WrongOctave,
                metrics: session::Metrics {
                    median_cents_error: Some(1200.),
                    voiced_coverage: Some(1.),
                    ..Default::default()
                },
            }]),
            None,
        )
        .unwrap();
        let a = Completion::create(&s, 1).unwrap().aggregate;
        assert_eq!(a.centered_cents_count, 0);
        assert_eq!(a.centered_cents_sum, 0.);
        assert_eq!(a.voiced_ratio_count, 1);
        assert_eq!(a.on_target, 0);
    }
    #[test]
    fn strict_restore_rejects_unknown_fields_inconsistent_counts_and_missing_evidence() {
        let r = complete(
            domain::Kind::Note,
            domain::Task::Imitate,
            1,
            "strict",
            false,
        );
        let raw = serde_json::to_value(&r).unwrap();
        assert_eq!(
            serde_json::from_value::<Completion>(raw.clone()).unwrap(),
            r
        );
        let mut unknown = raw;
        unknown["rawAudio"] = serde_json::json!([]);
        assert!(serde_json::from_value::<Completion>(unknown).is_err());
        let mut bad = r.clone();
        bad.aggregate.attempts += 1;
        assert!(bad.validate().is_err());
        let mut bad = r.clone();
        bad.aggregate.stable_ratio_sum = -1.;
        assert!(bad.validate().is_err());
        let mut bad = r.clone();
        bad.aggregate.by_scale_degree.clear();
        assert!(bad.validate().is_err());
        let mut bad = r;
        bad.task_mode = domain::Task::Identify;
        assert!(bad.validate().is_err());
    }
}

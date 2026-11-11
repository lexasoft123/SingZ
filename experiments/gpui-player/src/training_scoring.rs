//! Source-backed scoring of scalar detector evidence. No PCM/inference here.
use super::{
    training_domain::{Kind, Prompt},
    training_session::{Classification, Metrics, TargetResult},
};
use anyhow::{Result, ensure};
#[derive(Clone, Copy, Debug)]
pub struct Observation {
    pub at: f64,
    pub frequency: f64,
    pub midi: Option<f64>,
    pub confidence: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Window {
    pub index: usize,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Copy, Debug)]
pub struct Options {
    pub attack: f64,
    pub release: f64,
    pub confidence: f64,
    pub maximum_gap: f64,
    pub minimum_coverage: f64,
    pub stability_band: f64,
    pub minimum_stable: f64,
    pub settle_hold: f64,
    pub on_target: f64,
    pub close: f64,
    pub pitch_class_match: f64,
    pub range_tolerance: f64,
}
impl Default for Options {
    fn default() -> Self {
        Self {
            attack: 150.,
            release: 120.,
            confidence: 0.75,
            maximum_gap: 180.,
            minimum_coverage: 0.35,
            stability_band: 35.,
            minimum_stable: 0.6,
            settle_hold: 180.,
            on_target: 50.,
            close: 100.,
            pitch_class_match: 50.,
            range_tolerance: 50.,
        }
    }
}
impl Options {
    fn validate(&self) -> Result<()> {
        ensure!(
            [
                self.attack,
                self.release,
                self.confidence,
                self.maximum_gap,
                self.minimum_coverage,
                self.stability_band,
                self.minimum_stable,
                self.settle_hold,
                self.on_target,
                self.close,
                self.pitch_class_match,
                self.range_tolerance
            ]
            .iter()
            .all(|v| v.is_finite() && *v >= 0.),
            "Invalid negative/non-finite scoring option"
        );
        ensure!(
            self.confidence <= 1.
                && self.minimum_coverage <= 1.
                && self.minimum_stable <= 1.
                && self.close >= self.on_target
                && self.maximum_gap > 0.,
            "Invalid scoring thresholds"
        );
        Ok(())
    }
}
pub fn fractional_midi(frequency: f64) -> Option<f64> {
    (frequency.is_finite() && frequency > 0.).then(|| 69. + 12. * (frequency / 440.).log2())
}
fn valid_observation(observation: &Observation) -> Result<()> {
    ensure!(
        observation.at.is_finite()
            && observation.frequency.is_finite()
            && observation.frequency >= 0.
            && observation.confidence.is_finite()
            && (0.0..=1.).contains(&observation.confidence)
            && observation.midi.is_none_or(f64::is_finite),
        "Invalid training observation"
    );
    let converted = fractional_midi(observation.frequency);
    ensure!(
        match (converted, observation.midi) {
            (None, None) => true,
            (Some(a), Some(b)) => (a - b).abs() <= 0.05,
            _ => false,
        },
        "Pitch observation frequency and MIDI do not agree"
    );
    Ok(())
}
#[derive(Clone, Copy)]
struct Weighted {
    start: f64,
    end: f64,
    midi: Option<f64>,
    voiced: bool,
}
impl Weighted {
    fn duration(&self) -> f64 {
        self.end - self.start
    }
}
pub fn score(
    prompt: &Prompt,
    windows: &[Window],
    observations: &[Observation],
    range: Option<(u8, u8)>,
    options: Options,
) -> Result<Vec<TargetResult>> {
    options.validate()?;
    ensure!(
        !matches!(prompt.kind, Kind::Chord | Kind::Arpeggio) || prompt.chord.is_some(),
        "Chord scoring requires the generated chord metadata"
    );
    ensure!(
        windows.len() == prompt.targets.len(),
        "Scoring needs one window per prompt target"
    );
    let mut indexes = vec![];
    for window in windows {
        ensure!(
            window.index < prompt.targets.len()
                && window.start.is_finite()
                && window.end.is_finite()
                && window.end > window.start
                && !indexes.contains(&window.index),
            "Invalid/duplicate target window"
        );
        indexes.push(window.index);
    }
    ensure!(
        range.is_none_or(|(low, high)| low <= high),
        "Invalid training range"
    );
    for observation in observations {
        valid_observation(observation)?;
    }
    let mut observations = observations.to_vec();
    observations.sort_by(|a, b| a.at.total_cmp(&b.at));
    Ok(prompt
        .targets
        .iter()
        .enumerate()
        .map(|(index, target)| {
            let window = windows.iter().find(|window| window.index == index).unwrap();
            let duration = window.end - window.start;
            let start = window.start + options.attack.min(duration * 0.2);
            let end = window.end - options.release.min(duration * 0.2);
            let weighted: Vec<Weighted> = observations
                .iter()
                .enumerate()
                .filter_map(|(i, observation)| {
                    let half = options.maximum_gap / 2.;
                    let left = if i > 0 {
                        (observation.at - half).max((observations[i - 1].at + observation.at) / 2.)
                    } else {
                        observation.at - half
                    };
                    let right = if i + 1 < observations.len() {
                        (observation.at + half).min((observation.at + observations[i + 1].at) / 2.)
                    } else {
                        observation.at + half
                    };
                    let start = start.max(left);
                    let end = end.min(right);
                    if end <= start {
                        return None;
                    }
                    Some(Weighted {
                        start,
                        end,
                        midi: observation.midi,
                        voiced: observation.confidence >= options.confidence
                            && observation.midi.is_some()
                            && observation.frequency > 0.,
                    })
                })
                .collect();
            let voiced: Vec<_> = weighted
                .iter()
                .copied()
                .filter(|item| item.voiced)
                .collect();
            let voiced_duration: f64 = voiced.iter().map(Weighted::duration).sum();
            let coverage = (voiced_duration / (end - start)).clamp(0., 1.);
            let mut metrics = Metrics {
                voiced_coverage: Some(coverage),
                ..Default::default()
            };
            if coverage < options.minimum_coverage || voiced_duration <= 0. {
                return TargetResult {
                    index,
                    classification: Classification::Unvoiced,
                    metrics,
                };
            }
            let mut ordered = voiced.clone();
            ordered.sort_by(|a, b| a.midi.unwrap().total_cmp(&b.midi.unwrap()));
            let mut cumulative = 0.;
            let mut detected = ordered.last().unwrap().midi.unwrap();
            for item in &ordered {
                cumulative += item.duration();
                if cumulative >= voiced_duration / 2. {
                    detected = item.midi.unwrap();
                    break;
                }
            }
            let cents = (detected - target.midi as f64) * 100.;
            let stable = voiced
                .iter()
                .filter(|item| {
                    ((item.midi.unwrap() - detected) * 100.).abs() <= options.stability_band
                })
                .map(Weighted::duration)
                .sum::<f64>()
                / voiced_duration;
            metrics.median_cents_error = Some(cents);
            metrics.detected_midi = Some(detected);
            metrics.stable_hold_ratio = Some(stable.clamp(0., 1.));
            let mut run_start = None;
            let mut run_end = 0.;
            for item in &voiced {
                let contiguous = run_start.is_some() && item.start <= run_end + 0.001;
                if ((item.midi.unwrap() - detected) * 100.).abs() > options.stability_band {
                    run_start = None;
                    run_end = item.end;
                    continue;
                }
                if !contiguous {
                    run_start = Some(item.start);
                }
                run_end = item.end;
                if let Some(start) = run_start {
                    if run_end - start >= options.settle_hold {
                        metrics.time_to_settle_ms = Some((start - window.start).max(0.));
                        break;
                    }
                }
            }
            TargetResult {
                index,
                classification: classify(prompt, index, detected, cents, stable, range, &options),
                metrics,
            }
        })
        .collect())
}
fn classify(
    prompt: &Prompt,
    index: usize,
    midi: f64,
    cents: f64,
    stable: f64,
    range: Option<(u8, u8)>,
    options: &Options,
) -> Classification {
    use Classification::*;
    if range.is_some_and(|(low, high)| {
        midi < low as f64 - options.range_tolerance / 100.
            || midi > high as f64 + options.range_tolerance / 100.
    }) {
        return OutOfRange;
    }
    if stable < options.minimum_stable {
        return Unstable;
    }
    // JS Math.round rounds half toward +infinity (Rust round differs for negatives).
    let octave = (cents / 1200. + 0.5).floor();
    if octave != 0. && (cents - octave * 1200.).abs() <= options.pitch_class_match {
        return WrongOctave;
    }
    if cents.abs() <= options.on_target {
        return OnTarget;
    }
    if cents.abs() <= options.close {
        return Close;
    }
    if matches!(prompt.kind, Kind::Chord | Kind::Arpeggio) {
        let chord = prompt.chord.as_ref().expect("Generated chord prompt");
        let matches = |pc: u8| {
            let raw = (midi - pc as f64) * 100.;
            ((raw % 1200. + 1800.) % 1200. - 600.).abs() <= options.pitch_class_match
        };
        if chord.tones.iter().any(|tone| {
            tone.midi % 12 != prompt.targets[index].midi % 12 && matches(tone.midi % 12)
        }) {
            return OtherChordTone;
        }
        if !chord.tones.iter().any(|tone| matches(tone.midi % 12)) {
            return NonChordTone;
        }
    }
    WrongNote
}
/// Scores a completed target before capture eviction. A successful live lock
/// uses only the final hold and cannot be contradicted by the offline scorer's
/// independent categorical tolerance, as in training-completed-target.ts.
pub fn completed_target(
    prompt: &Prompt,
    windows: &[Window],
    observations: &[Observation],
    range: Option<(u8, u8)>,
    options: Options,
    successful_hold: Option<f64>,
) -> Result<TargetResult> {
    ensure!(
        !windows.is_empty() && windows.len() <= prompt.targets.len(),
        "No valid completed target window"
    );
    let completed = *windows.last().unwrap();
    let mut windows = windows.to_vec();
    let scored = windows.last_mut().unwrap();
    if let Some(hold) = successful_hold {
        ensure!(
            hold.is_finite() && hold > 0.,
            "Invalid successful hold duration"
        );
        scored.start = scored.start.max(scored.end - hold);
    }
    if let Some(first) = observations.first() {
        if first.at > scored.start && first.at < scored.end {
            scored.start = first.at;
        }
    }
    let mut next = completed.end + 1.;
    while windows.len() < prompt.targets.len() {
        windows.push(Window {
            index: windows.len(),
            start: next,
            end: next + 1.,
        });
        next += 2.;
    }
    let mut results = score(prompt, &windows, observations, range, options)?;
    ensure!(
        completed.index < results.len(),
        "Completed target index is invalid"
    );
    let mut result = results.remove(completed.index);
    if successful_hold.is_some() {
        result.classification = Classification::OnTarget;
    }
    Ok(result)
}
#[cfg(test)]
#[path = "training_scoring_tests.rs"]
mod tests;

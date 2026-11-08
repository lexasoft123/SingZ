//! Typed control/telemetry for the native training renderer and shared output.
//! Timing stays in the native host-clock domain; callback completion and physical
//! output latency are separate facts. This module performs no synthesis or DSP.
use anyhow::{Context, Result, ensure};
use serde_json::Value;

#[derive(Clone, Copy, Debug)]
pub enum Instrument {
    Piano,
    Electric,
    Guitar,
    Organ,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Purpose {
    Context,
    Question,
    Answer,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Cue {
    pub purpose: Purpose,
    pub together: bool,
    pub notes: Vec<u8>,
}
#[derive(Clone, Debug)]
pub struct Phrase {
    pub generation: u64,
    pub instrument: Instrument,
    pub gain: f32,
    pub cues: Vec<Cue>,
    pub timing: Option<Timing>,
}
#[derive(Clone, Copy, Debug)]
pub struct Timing {
    pub note_duration: f32,
    pub sequence_gap: f32,
    pub context_gap: f32,
    pub question_gap: f32,
    pub answer_gap: f32,
    pub attack: f32,
    pub release: f32,
    pub peak_gain: f32,
}
impl Default for Timing {
    fn default() -> Self {
        Self {
            note_duration: 0.55,
            sequence_gap: 0.1,
            context_gap: 0.35,
            question_gap: 0.45,
            answer_gap: 0.25,
            attack: 0.045,
            release: 0.12,
            peak_gain: 1.,
        }
    }
}
impl Phrase {
    pub fn command(&self) -> Result<String> {
        ensure!(
            self.generation > 0 && self.gain.is_finite() && (0.0..=2.0).contains(&self.gain),
            "Invalid native training phrase"
        );
        ensure!(
            !self.cues.is_empty() && self.cues.len() <= 128,
            "Invalid training cue count"
        );
        let mut total = 0;
        let mut command = format!(
            "{} {} {} {}",
            if self.timing.is_some() {
                "cue-timed"
            } else {
                "cue"
            },
            self.generation,
            self.instrument as u8,
            self.gain,
        );
        if let Some(t) = self.timing {
            ensure!(
                t.note_duration.is_finite() && (0.01..=10.).contains(&t.note_duration),
                "Invalid training note duration"
            );
            let settle = 0.18f32.min(t.note_duration * 0.55);
            ensure!(
                [t.sequence_gap, t.context_gap, t.question_gap, t.answer_gap]
                    .iter()
                    .all(|v| v.is_finite() && (0.0..=10.).contains(v))
                    && t.attack.is_finite()
                    && (0.0..=settle).contains(&t.attack)
                    && t.release.is_finite()
                    && (0.0..=t.note_duration - settle).contains(&t.release)
                    && t.peak_gain.is_finite()
                    && (0.0..=8.).contains(&t.peak_gain),
                "Invalid training cue timing"
            );
            command.push_str(&format!(
                " {} {} {} {} {} {} {} {}",
                t.note_duration,
                t.sequence_gap,
                t.context_gap,
                t.question_gap,
                t.answer_gap,
                t.attack,
                t.release,
                t.peak_gain
            ));
        }
        command.push_str(&format!(" {}", self.cues.len()));
        for cue in &self.cues {
            total += cue.notes.len();
            ensure!(
                !cue.notes.is_empty()
                    && cue.notes.len() <= 32
                    && total <= 256
                    && cue.notes.iter().all(|note| *note <= 127),
                "Invalid training notes"
            );
            command.push_str(&format!(
                " {} {} {}",
                cue.purpose as u8,
                u8::from(cue.together),
                cue.notes.len()
            ));
            for note in &cue.notes {
                command.push_str(&format!(" {note}"));
            }
        }
        ensure!(
            command.len() < 4096,
            "Native training command exceeds protocol limit"
        );
        Ok(command)
    }
}
#[derive(Clone, Debug)]
pub struct Note {
    pub midi: u8,
    pub cue_index: usize,
    pub start: f64,
    pub end: f64,
}
#[derive(Clone, Debug)]
pub struct Status {
    pub generation: u64,
    pub start_host_ns: u64,
    pub end_host_ns: u64,
    pub now_host_ns: u64,
    pub active: bool,
    pub output_latency_ms: f64,
    pub notes: Vec<Note>,
}
impl Status {
    pub fn parse(value: &Value) -> Result<Self> {
        let clock = |key: &str| -> Result<u64> {
            let text = value[key].as_str().context("Missing native cue clock")?;
            ensure!(
                !text.is_empty() && text.len() <= 20 && text.bytes().all(|c| c.is_ascii_digit()),
                "Invalid native cue clock"
            );
            Ok(text.parse()?)
        };
        let generation = value["cueGeneration"]
            .as_u64()
            .context("Missing native cue generation")?;
        let start_host_ns = clock("cueStartHostNs")?;
        let end_host_ns = clock("cueEndHostNs")?;
        let now_host_ns = clock("cueNowHostNs")?;
        let active = value["cueActive"]
            .as_bool()
            .context("Missing native cue activity")?;
        let output_latency_ms = value["cueOutputLatencyMs"]
            .as_f64()
            .context("Missing cue output latency")?;
        ensure!(
            output_latency_ms.is_finite() && (0.0..=120000.0).contains(&output_latency_ms),
            "Invalid cue output latency"
        );
        let raw_notes = value["cueNotes"]
            .as_array()
            .context("Missing native cue timeline")?;
        ensure!(raw_notes.len() <= 256, "Native cue timeline exceeds bound");
        let notes: Vec<Note> = raw_notes
            .iter()
            .map(|note| {
                let midi = note["midi"].as_u64().context("Invalid cue MIDI")?;
                let cue_index = note["cueIndex"].as_u64().context("Invalid cue index")?;
                let start = note["start"].as_f64().context("Invalid cue start")?;
                let end = note["end"].as_f64().context("Invalid cue end")?;
                ensure!(
                    midi <= 127
                        && cue_index < 128
                        && start.is_finite()
                        && end.is_finite()
                        && start >= 0.0
                        && end > start
                        && end <= 120.0,
                    "Invalid native cue note"
                );
                Ok(Note {
                    midi: midi as u8,
                    cue_index: cue_index as usize,
                    start,
                    end,
                })
            })
            .collect::<Result<_>>()?;
        ensure!(
            (start_host_ns == 0 && end_host_ns == 0 && !active && notes.is_empty())
                || (generation > 0
                    && start_host_ns > 0
                    && end_host_ns > start_host_ns
                    && end_host_ns - start_host_ns <= 120_000_000_000
                    && !notes.is_empty()),
            "Inconsistent native cue receipt"
        );
        Ok(Self {
            generation,
            start_host_ns,
            end_host_ns,
            now_host_ns,
            active,
            output_latency_ms,
            notes,
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn bounded_typed_phrase() {
        let mut phrase = Phrase {
            timing: None,
            generation: 1,
            instrument: Instrument::Piano,
            gain: 0.65,
            cues: vec![Cue {
                purpose: Purpose::Question,
                together: false,
                notes: vec![60],
            }],
        };
        assert_eq!(phrase.command().unwrap(), "cue 1 0 0.65 1 1 0 1 60");
        phrase.gain = f32::NAN;
        assert!(phrase.command().is_err());
        phrase.gain = 1.;
        phrase.generation = 0;
        assert!(phrase.command().is_err());
        phrase.generation = 1;
        phrase.cues[0].notes = vec![128];
        assert!(phrase.command().is_err());
        phrase.cues[0].notes = vec![60; 33];
        assert!(phrase.command().is_err());
        phrase.cues = vec![
            Cue {
                purpose: Purpose::Answer,
                together: true,
                notes: vec![60, 64, 67]
            };
            86
        ];
        assert!(phrase.command().is_err());
    }
    #[test]
    fn source_reference_test_timing() {
        let mut phrase = Phrase {
            generation: 9,
            instrument: Instrument::Piano,
            gain: 0.65,
            timing: Some(Timing {
                note_duration: 2.75,
                attack: 0.032,
                release: 0.22,
                ..Default::default()
            }),
            cues: vec![Cue {
                purpose: Purpose::Answer,
                together: false,
                notes: vec![60],
            }],
        };
        assert_eq!(
            phrase.command().unwrap(),
            "cue-timed 9 0 0.65 2.75 0.1 0.35 0.45 0.25 0.032 0.22 1 1 2 0 1 60"
        );
        phrase.timing.as_mut().unwrap().release = 3.;
        assert!(phrase.command().is_err());
        phrase.timing.as_mut().unwrap().release = f32::NAN;
        assert!(phrase.command().is_err());
    }
    #[test]
    fn lossless_clock_and_stale_receipt_validation() {
        let mut raw = serde_json::json!({"cueGeneration":7,"cueStartHostNs":"9007199254740993","cueEndHostNs":"9007199804740993","cueNowHostNs":"9007199204740993","cueActive":true,"cueOutputLatencyMs":12.0,"cueNotes":[{"midi":60,"cueIndex":0,"start":0.0,"end":0.55}]});
        let status = Status::parse(&raw).unwrap();
        assert_eq!(status.start_host_ns, 9007199254740993);
        raw["cueEndHostNs"] = raw["cueStartHostNs"].clone();
        assert!(Status::parse(&raw).is_err());
        raw["cueStartHostNs"] = "0".into();
        raw["cueEndHostNs"] = "0".into();
        assert!(Status::parse(&raw).is_err());
        raw["cueActive"] = false.into();
        raw["cueNotes"] = serde_json::json!([]);
        assert!(Status::parse(&raw).is_ok());
        raw["cueNowHostNs"] = "-1".into();
        assert!(Status::parse(&raw).is_err());
    }
}

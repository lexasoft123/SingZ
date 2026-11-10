//! Saved analysis format shared with desktop/mobile. Reading does not re-stamp it.
use serde_json::Value;
include!(concat!(env!("OUT_DIR"), "/pitch_detector_version.rs"));
#[derive(Clone, Debug)]
pub struct Note {
    pub start: f64,
    pub end: f64,
    pub midi: f32,
}
#[derive(Clone, Debug, Default)]
pub struct Pitch {
    pub f0: Vec<f32>,
    pub hop: f64,
    pub notes: Vec<Note>,
    pub frame_notes: Vec<Note>,
    pub key: String,
    pub tempo: String,
    /// Full playback timeline, including longer custom lanes.
    pub duration: f64,
    /// Independently measured vocal source coverage; never an inferred f0 length.
    source_duration: Option<f64>,
    pub warning: Option<String>,
    pub det_version: f64,
    cached_range: Option<(i32, i32)>,
    key_inferred: bool,
}
pub fn midi(hz: f32) -> f32 {
    69. + 12. * (hz / 440.).log2()
}
pub fn note_name(midi: i32) -> String {
    let names = [
        "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
    ];
    format!(
        "{}{}",
        names[midi.rem_euclid(12) as usize],
        midi.div_euclid(12) - 1
    )
}
impl Pitch {
    pub fn read(settings: &Value) -> Self {
        let mut data = Self {
            key: "—".into(),
            tempo: "—".into(),
            ..Default::default()
        };
        data.key_inferred = !crate::project_key::stored_current(&settings["key"]);
        if !data.key_inferred {
            data.key = key_name(
                settings["key"]["pc"].as_u64().unwrap() as usize,
                settings["key"]["minor"].as_bool().unwrap(),
            );
        }
        if let Some(bpm) = settings["beat"]["bpm"]
            .as_f64()
            .filter(|v| v.is_finite() && *v > 0. && *v < 1000.)
        {
            data.tempo = format!("{bpm:.0}");
        }
        let raw = &settings["melody"];
        data.det_version = raw["detVersion"].as_f64().filter(|v| v.is_finite()).unwrap_or(0.);
        let result = (|| -> Option<(Vec<f32>, f64)> {
            let hop = raw["hopSec"].as_f64()?;
            if !(0.001..0.5).contains(&hop) {
                return None;
            }
            let mut frames = vec![];
            for token in raw["f0"].as_str()?.split_whitespace() {
                if let Some(count) = token.strip_prefix('x') {
                    let n = if count.is_empty() {
                        1
                    } else {
                        count.parse::<usize>().ok()?
                    };
                    if n == 0 || frames.len().checked_add(n)? > 200000 {
                        return None;
                    }
                    frames.resize(frames.len() + n, 0.);
                } else {
                    let cents = token.parse::<f32>().ok()?;
                    if !cents.is_finite()
                        || !(0. ..=8000.).contains(&cents)
                        || frames.len() >= 200000
                    {
                        return None;
                    }
                    frames.push(55. * 2_f32.powf(cents / 1200.));
                }
            }
            (!frames.is_empty()).then_some((frames, hop))
        })();
        if let Some((f0, hop)) = result {
            data.f0 = f0;
            data.hop = hop;
        } else if raw.is_object() {
            data.warning = Some("Saved pitch data is invalid.".into());
        }
        data.refresh_inferred_key();
        data
    }
    fn refresh_inferred_key(&mut self) {
        if self.key_inferred {
            self.key = melody_key(&self.f0)
                .map(|(pc, minor)| key_name(pc, minor))
                .unwrap_or_else(|| "—".into());
        }
    }
    pub fn key_label(&self, transpose: i32) -> String {
        let names = [
            "C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B",
        ];
        let minor = self.key.ends_with('m');
        let root = self.key.trim_end_matches('m');
        names
            .iter()
            .position(|n| *n == root)
            .map(|i| {
                format!(
                    "{}{}",
                    names[(i as i32 + transpose).rem_euclid(12) as usize],
                    if minor { "m" } else { "" }
                )
            })
            .unwrap_or_else(|| self.key.clone())
    }
    pub fn bind_duration(&mut self, duration: f64) {
        self.bind_duration_for_lane(duration, None);
    }
    /// Drawing uses the whole timeline, but a saved vocal line covers its own
    /// source. None retains the old strict timeline check; it never guesses a
    /// shorter source from the stored analysis it is supposed to validate.
    pub fn bind_duration_for_lane(&mut self, timeline: f64, source_duration: Option<f64>) {
        let valid_timeline = timeline.is_finite() && timeline > 0.;
        self.duration = if valid_timeline { timeline } else { 0. };
        let valid_source = source_duration.is_none_or(|duration| {
            duration.is_finite() && duration > 0. && valid_timeline && duration <= timeline + 0.01
        });
        self.source_duration = source_duration.filter(|_| valid_source);
        if !self.f0.is_empty() {
            if !valid_timeline || !valid_source {
                self.warning = Some("Saved pitch has an invalid source duration.".into());
                self.f0.clear();
            } else if (self.f0.len() as f64 * self.hop - self.analysis_duration()).abs() > 2. {
                self.warning = Some("Saved pitch belongs to a different song duration.".into());
                self.f0.clear();
            } else if self.det_version < VERSION as f64 {
                self.warning = Some("Saved pitch needs updating.".into());
                self.f0.clear();
            }
        }
        self.refresh_inferred_key();
        self.notes = segments(&self.f0, self.hop);
        self.frame_notes = frame_segments(&self.f0, self.hop);
        self.cached_range = self.calculate_range();
    }
    /// Offline vocal detection uses the same measured-source coverage check as
    /// cached adoption; a custom lane extending playback cannot relax it.
    pub fn analysis_duration(&self) -> f64 {
        self.source_duration.unwrap_or(self.duration)
    }
    pub fn range(&self) -> Option<(i32, i32)> {
        self.cached_range
    }
    fn calculate_range(&self) -> Option<(i32, i32)> {
        let mut midis = self
            .frame_notes
            .iter()
            .map(|n| n.midi as i32)
            .collect::<Vec<_>>();
        if midis.is_empty() {
            return None;
        }
        midis.sort();
        Some((
            midis[(midis.len() as f32 * 0.05).floor() as usize],
            midis[((midis.len() as f32 * 0.95).floor() as usize).min(midis.len() - 1)],
        ))
    }
    pub fn fit_range(&self) -> (f32, f32) {
        let Some((lo, hi)) = self.range() else {
            return (36., 84.);
        };
        let lo = lo as f32 - 3.;
        let hi = hi as f32 + 3.;
        let middle = (lo + hi) / 2.;
        let span = (hi - lo).max(12.);
        (
            (middle - span / 2.).round().max(24.),
            (middle + span / 2.).round().min(96.),
        )
    }
}
fn median(values: &[f32]) -> f32 {
    let mut values = values.to_vec();
    values.sort_by(f32::total_cmp);
    values[values.len() / 2]
}
/// Production score-like segmentation: 80 cents from a 12-frame upper median,
/// time-based gap bridge, contiguous micro-tail merging, and a 90ms note floor.
pub fn segments(f0: &[f32], hop: f64) -> Vec<Note> {
    if f0.is_empty() || hop <= 0. {
        return vec![];
    }
    #[derive(Clone)]
    struct Raw {
        start: usize,
        end: usize,
        cents: Vec<f32>,
    }
    let bridge = 0.06_f64.max(hop * 1.6);
    let bridge_frames = (bridge / hop).round() as usize;
    let mut raw: Vec<Raw> = vec![];
    let mut current: Option<Raw> = None;
    let mut window = vec![];
    let mut last = 0;
    for (index, hz) in f0.iter().copied().chain(std::iter::once(0.)).enumerate() {
        if hz <= 0. {
            if current.is_some() && index - last > bridge_frames {
                if let Some(mut note) = current.take() {
                    note.end = last + 1;
                    raw.push(note);
                }
                window.clear();
            }
            continue;
        }
        let cents = 1200. * hz.log2();
        if current.is_some() && (cents - median(&window)).abs() > 80. {
            if let Some(mut note) = current.take() {
                note.end = last + 1;
                raw.push(note);
            }
            window.clear();
        }
        let note = current.get_or_insert_with(|| Raw {
            start: index,
            end: index + 1,
            cents: vec![],
        });
        window.push(cents);
        if window.len() > 12 {
            window.remove(0);
        }
        note.cents.push(cents);
        last = index;
    }
    if let Some(mut note) = current {
        note.end = last + 1;
        raw.push(note);
    }
    let mut merged: Vec<Raw> = vec![];
    for note in raw {
        if let Some(previous) = merged.last_mut() {
            if (note.start - previous.end) as f64 * hop <= bridge
                && (note.end - note.start) as f64 * hop < 0.15
            {
                previous.end = note.end;
                previous.cents.extend(note.cents);
                continue;
            }
        }
        merged.push(note);
    }
    merged
        .into_iter()
        .filter(|n| (n.end - n.start) as f64 * hop >= 0.09)
        .map(|n| Note {
            start: n.start as f64 * hop,
            end: n.end as f64 * hop,
            midi: (69. + (median(&n.cents) - 1200. * 440_f32.log2()) / 100.).round(),
        })
        .collect()
}
// Source audio/analysis-contract.ts: display-only melody histogram. Never
// write this estimate into settings.key or authorize song-key training with it.
fn key_name(pc: usize, minor: bool) -> String {
    format!(
        "{}{}",
        ["C", "C#", "D", "D#", "E", "F", "F#", "G", "G#", "A", "A#", "B"][pc],
        if minor { "m" } else { "" }
    )
}
fn melody_key(f0: &[f32]) -> Option<(usize, bool)> {
    const MAJ: [f64; 12] = [
        6.35, 2.23, 3.48, 2.33, 4.38, 4.09, 2.52, 5.19, 2.39, 3.66, 2.29, 2.88,
    ];
    const MIN: [f64; 12] = [
        6.33, 2.68, 3.52, 5.38, 2.6, 3.53, 2.54, 4.75, 3.98, 2.69, 3.34, 3.17,
    ];
    let mut hist = [0.; 12];
    let mut voiced = 0;
    for &f in f0 {
        if f.is_finite() && f > 0. {
            let pc = (midi(f).round() as i32).rem_euclid(12) as usize;
            hist[pc] += 1.;
            voiced += 1;
        }
    }
    if voiced < 100 {
        return None;
    }
    let mh = hist.iter().sum::<f64>() / 12.;
    let mut best = (0, false);
    let mut score = f64::NEG_INFINITY;
    for pc in 0..12 {
        for (minor, profile) in [(false, &MAJ), (true, &MIN)] {
            let mp = profile.iter().sum::<f64>() / 12.;
            let (mut num, mut dh, mut dp) = (0., 0., 0.);
            for i in 0..12 {
                let a = hist[(i + pc) % 12] - mh;
                let b = profile[i] - mp;
                num += a * b;
                dh += a * a;
                dp += b * b;
            }
            let value = if dh > 0. && dp > 0. {
                num / (dh * dp).sqrt()
            } else {
                0.
            };
            if value > score {
                score = value;
                best = (pc, minor);
            }
        }
    }
    Some(best)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn saved_detector_stamp_retains_numeric_fractions_and_rejects_coercion() {
        for stamp in [serde_json::json!(4.0), serde_json::json!(4.5), serde_json::json!(99.5)] {
            let mut pitch = Pitch::read(&serde_json::json!({"melody": {
                "detVersion": stamp, "hopSec": 0.025, "f0": vec!["1200"; 200].join(" ")
            }}));
            assert_eq!(pitch.det_version, stamp.as_f64().unwrap());
            pitch.bind_duration(5.);
            assert_eq!(pitch.f0.len(), 200, "equal/newer stamps must be adopted");
        }
        for stamp in [serde_json::json!("4"), serde_json::json!(true), Value::Null, serde_json::json!(3.5)] {
            let mut pitch = Pitch::read(&serde_json::json!({"melody": {
                "detVersion": stamp, "hopSec": 0.025, "f0": vec!["1200"; 200].join(" ")
            }}));
            pitch.bind_duration(5.);
            assert!(pitch.f0.is_empty(), "nonnumeric/lower stamps must re-derive");
        }
    }
    #[test]
    fn key_stamps_and_display_only_histogram_follow_source_contract() {
        for version in [2, 99] {
            let raw = serde_json::json!({"key":{"pc":8,"minor":true,"detVersion":version}});
            assert_eq!(Pitch::read(&raw).key, "G#m");
        }
        for key in [
            serde_json::json!({"pc":8,"minor":true,"detVersion":1}),
            serde_json::json!({"pc":8,"minor":"false","detVersion":2}),
            serde_json::json!({"pc":8,"minor":true}),
        ] {
            assert_eq!(Pitch::read(&serde_json::json!({"key":key})).key, "—");
        }
        assert!(melody_key(&vec![261.6256; 99]).is_none());
        let frames = [vec![261.6256; 100], vec![329.6276; 60], vec![391.9954; 80]].concat();
        assert_eq!(melody_key(&frames), Some((0, false)));
        let raw = serde_json::json!({"melody":{"detVersion":4,"hopSec":0.025,"f0":vec!["2700";120].join(" ")},"key":{"pc":8,"minor":true,"detVersion":1}});
        let before = raw.clone();
        let mut pitch = Pitch::read(&raw);
        assert_ne!(pitch.key, "—");
        pitch.bind_duration(100.); // Rejected coverage cannot supply a key fallback.
        assert_eq!(pitch.key, "—");
        assert_eq!(raw, before);
    }
    #[test]
    fn saved_cents_gaps_and_coverage() {
        let mut p = Pitch::read(
            &serde_json::json!({"melody":{"detVersion":4,"hopSec":0.025,"f0":"x2 1200 1200 x"},"key":{"pc":8,"minor":true,"detVersion":2},"beat":{"bpm":96}}),
        );
        assert_eq!(p.f0, vec![0., 0., 110., 110., 0.]);
        assert_eq!(p.key, "G#m");
        assert_eq!(p.tempo, "96");
        p.bind_duration(20.);
        assert!(p.f0.is_empty());
        assert!(p.warning.is_some());
    }
    #[test]
    fn note_rest_and_micro_tail_semantics() {
        let mut frames = vec![110.; 20];
        frames.extend(vec![220.; 4]);
        frames.extend(vec![0.; 10]);
        frames.extend(vec![220.; 20]);
        let notes = segments(&frames, 0.025);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].midi, 45.);
        assert_eq!(notes[0].end, 24_f64 * 0.025);
        assert_eq!(notes[1].start, 34_f64 * 0.025);
        assert_eq!(notes[1].midi, 57.);
    }
    #[test]
    fn hostile_gap_lengths_are_bounded() {
        for f0 in [
            "x0",
            "x200001",
            "x99999999999999999999999999",
            "nan",
            "-1",
            "8001",
        ] {
            let p = Pitch::read(&serde_json::json!({"melody":{"hopSec":0.025,"f0":f0}}));
            assert!(p.f0.is_empty());
            assert!(p.warning.is_some());
        }
    }
    fn stored_vocal(version: u64) -> Pitch {
        Pitch::read(
            &serde_json::json!({"melody":{"detVersion":version,"hopSec":0.025,"f0":vec!["1200";200].join(" ")}}),
        )
    }
    #[test]
    fn longer_custom_timeline_preserves_valid_saved_vocal_frames_and_range() {
        let mut pitch = stored_vocal(4);
        let frames = pitch.f0.clone();
        pitch.bind_duration_for_lane(100., Some(5.));
        assert_eq!(pitch.duration, 100.);
        assert_eq!(pitch.analysis_duration(), 5.);
        assert_eq!(pitch.f0, frames);
        assert_eq!(pitch.det_version, 4.);
        assert!(pitch.warning.is_none());
        assert_eq!(pitch.range(), Some((45, 45)));
        assert!(!pitch.notes.is_empty());
        assert!(pitch.frame_notes.iter().all(|note| note.end <= 5.));
        pitch.bind_duration_for_lane(120., Some(5.));
        assert_eq!(pitch.f0, frames);
        assert_eq!(pitch.duration, 120.);
        pitch.bind_duration_for_lane(6., Some(5.));
        assert_eq!(pitch.f0, frames);
        assert_eq!(pitch.duration, 6.);
    }
    #[test]
    fn changed_vocal_coverage_is_invalid_even_when_custom_timeline_matches_saved_line() {
        let mut pitch = stored_vocal(4);
        pitch.bind_duration_for_lane(100., Some(8.01));
        assert!(pitch.f0.is_empty());
        assert!(pitch.notes.is_empty());
        assert!(pitch.frame_notes.is_empty());
        assert_eq!(pitch.range(), None);
        assert!(pitch
            .warning
            .as_deref()
            .unwrap()
            .contains("different song duration"));
        assert_eq!(pitch.det_version, 4.);
        let mut same_timeline = stored_vocal(4);
        same_timeline.bind_duration_for_lane(5., Some(1.));
        assert!(
            same_timeline.f0.is_empty(),
            "A matching timeline cannot hide a changed vocal source"
        );
    }
    #[test]
    fn custom_timeline_does_not_restamp_legacy_analysis_or_waive_missing_source_checks() {
        let mut old = stored_vocal(3);
        old.bind_duration_for_lane(100., Some(5.));
        assert!(old.f0.is_empty());
        assert_eq!(old.det_version, 3.);
        assert_eq!(old.warning.as_deref(), Some("Saved pitch needs updating."));
        let mut unknown = stored_vocal(4);
        unknown.bind_duration_for_lane(100., None);
        assert!(unknown.f0.is_empty());
        let mut single = stored_vocal(4);
        single.bind_duration(5.);
        assert_eq!(single.f0.len(), 200);
        assert_eq!(single.analysis_duration(), 5.);
    }
    #[test]
    fn invalid_source_measurements_cannot_bypass_coverage_checks() {
        for duration in [f64::NAN, f64::INFINITY, 0., -5., 101.] {
            let mut pitch = stored_vocal(4);
            pitch.bind_duration_for_lane(100., Some(duration));
            assert!(pitch.f0.is_empty(), "invalid measured duration {duration}");
            assert!(pitch.warning.is_some());
        }
        for timeline in [f64::NAN, f64::INFINITY, 0., -5.] {
            let mut pitch = stored_vocal(4);
            pitch.bind_duration_for_lane(timeline, Some(5.));
            assert!(pitch.f0.is_empty());
            assert_eq!(pitch.duration, 0.);
        }
    }
    #[test]
    fn measured_source_uses_existing_two_second_coverage_slack() {
        let mut boundary = stored_vocal(4);
        boundary.bind_duration_for_lane(100., Some(7.));
        assert_eq!(boundary.f0.len(), 200);
        let mut beyond = stored_vocal(4);
        beyond.bind_duration_for_lane(100., Some(7.01));
        assert!(beyond.f0.is_empty());
    }
}

fn frame_segments(f0: &[f32], hop: f64) -> Vec<Note> {
    let mut notes: Vec<Note> = vec![];
    let mut current = None;
    for (index, hz) in f0.iter().copied().enumerate() {
        if hz <= 0. {
            current = None;
            continue;
        }
        let time = index as f64 * hop;
        let midi = midi(hz).round();
        if let Some(i) = current {
            let n: &mut Note = &mut notes[i];
            if n.midi == midi && time - n.end <= 0.06_f64.max(hop * 1.6) {
                n.end = (index + 1) as f64 * hop;
                continue;
            }
        }
        current = Some(notes.len());
        notes.push(Note {
            start: time,
            end: (index + 1) as f64 * hop,
            midi,
        });
    }
    notes
        .into_iter()
        .filter(|n| n.end - n.start >= 0.09)
        .collect()
}

#[cfg(test)]
#[path="project_pitch_timeline_tests.rs"]
mod timeline_tests;

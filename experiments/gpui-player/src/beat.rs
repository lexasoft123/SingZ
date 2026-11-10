//! Source beat-track editing and the bounded native cue transaction.
//! Musical edits mirror renderer/audio/beat.ts; the C++ planner owns audio.
use anyhow::{Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;

pub const METERS: [usize; 4] = [2, 3, 4, 6];
pub const MAX_BEATS: usize = 20_000;
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Metronome {
    pub click: bool,
    pub count_in_bars: u32,
    pub volume: f64,
    pub accent: bool,
    pub grid: bool,
}
impl Default for Metronome {
    fn default() -> Self {
        Self {
            click: false,
            count_in_bars: 0,
            volume: 0.7,
            accent: true,
            grid: false,
        }
    }
}
// JSON equivalents of Number() used by the production saved-data sanitizers.
fn number(v: &Value) -> Option<f64> {
    match v {
        Value::Number(n) => n.as_f64(),
        Value::String(s) => {
            if s.trim().is_empty() {
                Some(0.)
            } else {
                s.trim().parse().ok()
            }
        }
        Value::Null => Some(0.),
        Value::Bool(b) => Some(if *b { 1. } else { 0. }),
        _ => None,
    }
    .filter(|v| v.is_finite())
}
impl Metronome {
    pub fn sanitize(raw: &Value) -> Self {
        Self {
            click: raw["click"] == true,
            count_in_bars: raw
                .get("countInBars")
                .and_then(number)
                .map_or(0, |v| (v + 0.5).floor().clamp(0., 2.) as u32),
            volume: raw
                .get("volume")
                .and_then(number)
                .unwrap_or(0.7)
                .clamp(0., 1.),
            accent: raw["accent"] != false,
            grid: raw["grid"] == true,
        }
    }
}
#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Beats {
    pub beats: Vec<f64>,
    pub bpm: f64,
    pub beats_per_bar: usize,
    pub downbeat: usize,
    pub source: String,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub downbeats: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub auto_downbeats: Option<Vec<usize>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub user_bars: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub suspect_at: Option<Vec<f64>>,
    #[serde(skip_serializing_if = "Option::is_none", serialize_with = "serialize_detector_version")]
    pub det_version: Option<f64>,
}
// Numeric stamps stay tolerant on read; integral stamps retain their JSON integer spelling.
fn serialize_detector_version<S: serde::Serializer>(
    stamp: &Option<f64>,
    serializer: S,
) -> std::result::Result<S::Ok, S::Error> {
    match *stamp {
        // u64::MAX rounds up to 2^64 in f64, so the upper bound must be strict.
        Some(value) if value.fract() == 0. && value >= 0. && value < u64::MAX as f64 =>
            serializer.serialize_some(&(value as u64)),
        Some(value) if value.fract() == 0. && value >= i64::MIN as f64 && value < 0. =>
            serializer.serialize_some(&(value as i64)),
        _ => stamp.serialize(serializer),
    }
}
impl Beats {
    pub fn sanitize(raw: &Value) -> Option<Self> {
        let a = raw["beats"].as_array()?;
        // Bound allocation before sorting untrusted saved metadata.
        if a.len() > MAX_BEATS {
            return None;
        }
        let mut sorted: Vec<_> = a.iter().filter_map(number).collect();
        sorted.sort_by(f64::total_cmp);
        // Source compares with the previous sorted member, not the retained member.
        let beats: Vec<_> = sorted
            .iter()
            .enumerate()
            .filter(|(i, t)| *i == 0 || **t - sorted[i - 1] > 0.05)
            .map(|(_, t)| *t)
            .collect();
        if beats.len() < 2 {
            return None;
        }
        let mut intervals: Vec<_> = beats.windows(2).map(|p| p[1] - p[0]).collect();
        intervals.sort_by(f64::total_cmp);
        let bpm = 60. / intervals[intervals.len() / 2];
        if !(30. ..=300.).contains(&bpm) {
            return None;
        }
        let meter = raw
            .get("beatsPerBar")
            .and_then(number)
            .filter(|n| METERS.iter().any(|m| *m as f64 == *n))
            .unwrap_or(4.) as usize;
        let indexes = |key: &str| -> Option<Vec<usize>> {
            let a = raw[key].as_array()?;
            if a.is_empty() || a.len() > beats.len() {
                return None;
            };
            let mut out = vec![];
            for item in a {
                let n = number(item)?;
                if n.fract() != 0.
                    || n < 0.
                    || n >= beats.len() as f64
                    || out.last().is_some_and(|p| *p >= n as usize)
                {
                    return None;
                }
                out.push(n as usize)
            }
            Some(out)
        };
        let times = |key: &str| -> Option<Vec<f64>> {
            let mut out: Vec<_> = raw[key]
                .as_array()?
                .iter()
                .filter_map(number)
                .filter(|t| *t >= 0. && *t <= beats[beats.len() - 1] + 1.)
                .collect();
            out.sort_by(f64::total_cmp);
            (!out.is_empty()).then_some(out)
        };
        Some(Self {
            bpm,
            beats_per_bar: meter,
            downbeat: raw
                .get("downbeat")
                .and_then(number)
                .map_or(0, |d| (d + 0.5).floor().rem_euclid(meter as f64) as usize),
            source: if raw["source"] == "auto" {
                "auto"
            } else {
                "manual"
            }
            .into(),
            downbeats: indexes("downbeats"),
            auto_downbeats: indexes("autoDownbeats"),
            user_bars: times("userBars"),
            suspect_at: times("suspectAt"),
            det_version: raw.get("detVersion").and_then(Value::as_f64).filter(|v| v.is_finite()),
            beats,
        })
    }
    pub fn constant(bpm: f64, anchor: f64, duration: f64, meter: usize) -> Result<Self> {
        ensure!(
            bpm.is_finite()
                && anchor.is_finite()
                && anchor >= 0.
                && duration.is_finite()
                && duration >= 0.
                && METERS.contains(&meter),
            "Invalid beat grid"
        );
        let p = 60. / bpm.clamp(30., 300.);
        let first = anchor - (anchor / p + 1e-9).floor() * p;
        ensure!(
            (duration.max(first) - first) / p < MAX_BEATS as f64,
            "Beat grid is too large"
        );
        let mut beats = vec![];
        let mut t = first;
        while t <= duration.max(first) {
            beats.push(t);
            t += p;
        }
        let downbeat = (((anchor - beats[0]) / p).round() as usize) % meter;
        Ok(Self {
            beats,
            bpm: 60. / p,
            beats_per_bar: meter,
            downbeat,
            source: "manual".into(),
            downbeats: None,
            auto_downbeats: None,
            user_bars: None,
            suspect_at: None,
            det_version: None,
        })
    }
    pub fn accent_index(&self, i: i64) -> i64 {
        if let Some(d) = self.downbeats.as_ref().filter(|d| !d.is_empty()) {
            let first = d[0] as i64;
            let last = *d.last().unwrap() as i64;
            let first_len = if d.len() > 1 {
                d[1] - d[0]
            } else {
                self.beats_per_bar
            } as i64;
            let last_len = if d.len() > 1 {
                d[d.len() - 1] - d[d.len() - 2]
            } else {
                self.beats_per_bar
            } as i64;
            if i < first {
                return (i - first).rem_euclid(first_len);
            }
            if i >= last {
                return (i - last) % last_len;
            }
            return i - d[d.partition_point(|n| *n as i64 <= i) - 1] as i64;
        }
        (i - self.downbeat as i64).rem_euclid(self.beats_per_bar as i64)
    }
    pub fn bar_number(&self, i: i64) -> i64 {
        if let Some(d) = self.downbeats.as_ref().filter(|d| !d.is_empty()) {
            let first = d[0] as i64;
            let last = *d.last().unwrap() as i64;
            let fl = if d.len() > 1 {
                d[1] - d[0]
            } else {
                self.beats_per_bar
            } as i64;
            let ll = if d.len() > 1 {
                d[d.len() - 1] - d[d.len() - 2]
            } else {
                self.beats_per_bar
            } as i64;
            if i < first {
                return 1 - (first - i + fl - 1) / fl;
            }
            if i >= last {
                return d.len() as i64 + (i - last) / ll;
            }
            return d.partition_point(|n| *n as i64 <= i) as i64;
        }
        (i - self.downbeat as i64).div_euclid(self.beats_per_bar as i64) + 1
    }
    /// Nearest stored beat, with equal-distance ties going to the earlier beat.
    /// Bar edits stay on real beat indexes, unlike virtual count-in indexes.
    pub fn nearest_beat(&self, time: f64) -> Option<usize> {
        if self.beats.is_empty() {
            return None;
        }
        let index = self
            .beats
            .partition_point(|beat| *beat < time)
            .min(self.beats.len() - 1);
        if index > 0 && (self.beats[index - 1] - time).abs() <= (self.beats[index] - time).abs() {
            Some(index - 1)
        } else {
            Some(index)
        }
    }

    /// Explicit bar starts, or the legacy uniform meter/downbeat projection.
    pub fn bar_indices(&self) -> Vec<usize> {
        if let Some(bars) = self.downbeats.as_ref().filter(|bars| !bars.is_empty()) {
            return bars.clone();
        }
        if self.beats_per_bar == 0 {
            return vec![];
        }
        (self.downbeat % self.beats_per_bar..self.beats.len())
            .step_by(self.beats_per_bar)
            .collect()
    }

    /// Re-fold the singer's time-based corrections onto the detector's base.
    /// The base stays separate from the derived map so repeating a fold or
    /// removing an edit cannot accumulate stale bar lines. A moved line changes
    /// downstream phase while retaining the detector's own variable bar lengths.
    pub fn apply_user_bars(&self) -> Self {
        if self.beats_per_bar == 0 {
            return self.clone();
        }
        let auto = self
            .auto_downbeats
            .clone()
            .unwrap_or_else(|| self.bar_indices());
        let mut result = self.clone();
        result.auto_downbeats = Some(auto.clone());
        let user_bars = self.user_bars.as_deref().unwrap_or_default();
        if user_bars.is_empty() {
            result.downbeat = auto.first().copied().unwrap_or(0) % self.beats_per_bar;
            result.downbeats = Some(auto);
            return result;
        }
        let mut forced: Vec<_> = user_bars
            .iter()
            .filter_map(|time| self.nearest_beat(*time))
            .collect();
        forced.sort_unstable();
        forced.dedup();
        if forced.is_empty() {
            return result;
        }
        let mut out = Vec::new();
        let mut push = |value: i64| {
            if value >= 0
                && value < self.beats.len() as i64
                && out.last().is_none_or(|last| value as usize > *last)
            {
                out.push(value as usize);
            }
        };
        let mut shift = 0_i64;
        let mut auto_index = 0;
        for forced in forced {
            // Only unconsumed detector lines participate. When the final one
            // was already consumed, later hand marks still survive by themselves.
            let mut best = auto_index;
            for index in auto_index..auto.len() {
                if (auto[index] as i64 + shift - forced as i64).abs()
                    < (auto[best] as i64 + shift - forced as i64).abs()
                {
                    best = index;
                }
                if auto[index] as i64 + shift > (forced + self.beats_per_bar) as i64 {
                    break;
                }
            }
            for bar in &auto[auto_index..best] {
                push(*bar as i64 + shift);
            }
            push(forced as i64);
            if let Some(original) = auto.get(best) {
                shift = forced as i64 - *original as i64;
                auto_index = best + 1;
            }
        }
        for bar in &auto[auto_index..] {
            push(*bar as i64 + shift);
        }
        let downbeats = if out.is_empty() { auto } else { out };
        result.downbeat = downbeats.first().copied().unwrap_or(0) % self.beats_per_bar;
        result.downbeats = Some(downbeats);
        result
    }

    /// Move (or add) a time-based correction, replacing the old drag target.
    pub fn set_user_bar(&self, to_time: f64, from_time: Option<f64>) -> Self {
        let Some(index) = self.nearest_beat(to_time) else {
            return self.clone();
        };
        let time = self.beats[index];
        let tolerance = 60. / self.bpm * 0.6;
        let mut user_bars: Vec<_> = self
            .user_bars
            .as_deref()
            .unwrap_or_default()
            .iter()
            .copied()
            .filter(|old| {
                (*old - time).abs() > 1e-6
                    && from_time.is_none_or(|from| (*old - from).abs() > tolerance)
            })
            .collect();
        user_bars.push(time);
        user_bars.sort_by(f64::total_cmp);
        let mut result = self.clone();
        result.user_bars = Some(user_bars);
        result.apply_user_bars()
    }

    /// Undo the correction near this time; re-fold from the immutable base.
    pub fn clear_user_bar(&self, time: f64) -> Self {
        let existing = self.user_bars.as_deref().unwrap_or_default();
        let tolerance = 60. / self.bpm * 0.6;
        let user_bars: Vec<_> = existing
            .iter()
            .copied()
            .filter(|old| (*old - time).abs() > tolerance)
            .collect();
        if user_bars.len() == existing.len() {
            return self.clone();
        }
        let mut result = self.clone();
        result.user_bars = Some(user_bars);
        result.apply_user_bars()
    }

    pub fn shift(&self, dt: f64) -> Self {
        let mut out = self.clone();
        out.beats.iter_mut().for_each(|t| *t += dt);
        out.source = "manual".into();
        out
    }
    pub fn half(&self) -> Self {
        if self.beats.len() < 3 {
            return self.clone();
        }
        let mut out = self.clone();
        let keep = self.downbeat % 2;
        out.beats = self.beats.iter().skip(keep).step_by(2).copied().collect();
        out.bpm /= 2.;
        out.downbeat = (self.downbeat - keep) / 2;
        out.source = "manual".into();
        if let Some(d) = &self.downbeats {
            let mut next: Vec<_> = d
                .iter()
                .map(|n| {
                    ((*n as i64 - keep as i64).div_euclid(2)).clamp(0, out.beats.len() as i64 - 1)
                        as usize
                })
                .collect();
            next.dedup();
            out.downbeats = Some(next);
        }
        out
    }
    pub fn double(&self) -> Self {
        let mut out = self.clone();
        out.beats.clear();
        for (i, t) in self.beats.iter().enumerate() {
            out.beats.push(*t);
            if let Some(next) = self.beats.get(i + 1) {
                out.beats.push((t + next) / 2.);
            }
        }
        out.bpm *= 2.;
        out.downbeat *= 2;
        out.downbeats = self
            .downbeats
            .as_ref()
            .map(|d| d.iter().map(|n| n * 2).collect());
        out.source = "manual".into();
        out
    }
    pub fn uniform_meter(&self, meter: usize, rotate: bool) -> Result<Self> {
        ensure!(METERS.contains(&meter), "Invalid meter");
        let mut out = self.clone();
        out.downbeats = None;
        out.beats_per_bar = meter;
        out.downbeat = (self.downbeat + usize::from(rotate)) % meter;
        out.source = "manual".into();
        Ok(out)
    }
    /// Source native bridge restrictions are stricter than the saved-data sanitizer.
    pub fn validate_audio(&self) -> Result<()> {
        ensure!(
            (2..=MAX_BEATS).contains(&self.beats.len())
                && METERS.contains(&self.beats_per_bar)
                && self.downbeat < self.beats_per_bar,
            "Invalid beat grid size or meter"
        );
        ensure!(
            self.beats
                .iter()
                .all(|b| b.is_finite() && (0. ..=43200.).contains(b))
                && self.beats.windows(2).all(|p| p[1] - p[0] > 0.05),
            "Invalid beat timeline"
        );
        let mut iv: Vec<_> = self.beats.windows(2).map(|p| p[1] - p[0]).collect();
        iv.sort_by(f64::total_cmp);
        ensure!(
            (30. ..=300.).contains(&(60. / iv[iv.len() / 2])),
            "Beat tempo is outside supported range"
        );
        if let Some(d) = &self.downbeats {
            ensure!(
                d.len() <= self.beats.len()
                    && d.iter().all(|i| *i < self.beats.len())
                    && d.windows(2).all(|p| p[1] > p[0]),
                "Invalid bar map"
            );
        }
        Ok(())
    }
}
pub fn tap_bpm(taps: &[f64]) -> Option<f64> {
    if taps.is_empty() || taps.iter().any(|t| !t.is_finite()) {
        return None;
    }
    let mut start = taps.len() - 1;
    while start > 0 && taps[start] - taps[start - 1] < 2.5 {
        start -= 1;
    }
    let run = &taps[start..];
    if run.len() < 3 {
        return None;
    }
    let mut iv: Vec<_> = run.windows(2).map(|p| p[1] - p[0]).collect();
    iv.sort_by(f64::total_cmp);
    let n = iv.len();
    let mid = if n % 2 == 1 {
        iv[n / 2]
    } else {
        (iv[n / 2 - 1] + iv[n / 2]) / 2.
    };
    (mid > 0.).then(|| (60. / mid).clamp(30., 300.))
}
/// Each message stays well below the helper's 4096-byte ASCII line limit.
/// The worker must send this transaction without interleaving another update.
pub fn commands(met: &Metronome, grid: Option<&Beats>) -> Result<Vec<String>> {
    ensure!(
        met.volume.is_finite() && (0. ..=1.).contains(&met.volume) && met.count_in_bars <= 2,
        "Invalid metronome preferences"
    );
    if let Some(g) = grid {
        g.validate_audio()?;
    }
    // Saved click intent can precede detection. Match the source facade: no
    // audible song clicks without a grid; gridless count-in still works.
    let click = met.click && grid.is_some();
    let max_bar = grid.map_or(3, |g| {
        g.downbeats.as_ref().map_or(g.beats_per_bar, |d| {
            d.windows(2)
                .map(|p| p[1] - p[0])
                .max()
                .unwrap_or(0)
                .max(g.beats_per_bar)
        })
    });
    let count_potential = met.count_in_bars as usize * max_bar;
    ensure!(
        count_potential <= 40_000
            && (!click || grid.unwrap().beats.len() + 2 + count_potential <= 40_000),
        "Metronome count-in exceeds the cue event limit"
    );
    let empty = vec![];
    let beats = grid.map_or(&empty, |g| &g.beats);
    let bars = grid.and_then(|g| g.downbeats.as_ref());
    let mut out = vec![format!(
        "met-begin {} {} {} {} {} {} {} {}",
        u8::from(click),
        met.count_in_bars,
        met.volume,
        u8::from(met.accent),
        grid.map_or(4, |g| g.beats_per_bar),
        grid.map_or(0, |g| g.downbeat),
        beats.len(),
        bars.map_or(0, Vec::len)
    )];
    for (index, chunk) in beats.chunks(96).enumerate() {
        out.push(format!(
            "met-beats {} {} {}",
            index * 96,
            chunk.len(),
            chunk
                .iter()
                .map(ToString::to_string)
                .collect::<Vec<_>>()
                .join(" ")
        ));
    }
    if let Some(bars) = bars {
        for (index, chunk) in bars.chunks(96).enumerate() {
            out.push(format!(
                "met-bars {} {} {}",
                index * 96,
                chunk.len(),
                chunk
                    .iter()
                    .map(ToString::to_string)
                    .collect::<Vec<_>>()
                    .join(" ")
            ));
        }
    }
    out.push("met-apply".into());
    ensure!(
        out.iter().all(|s| s.len() < 4096),
        "Oversized cue transaction"
    );
    Ok(out)
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn saved_project_detector_stamp_round_trips_byte_identically() {
        let mix = crate::project_store::Mix {
            carry: Default::default(), metronome: Default::default(),
            beat: Some(Beats::constant(120., 0., 3., 4).unwrap()),
            original: false, lanes: vec![0], custom: vec![],
            gain: [0.4; crate::tracks::LANE_SLOTS],
            muted: [false; crate::tracks::LANE_SLOTS], solo: [false; crate::tracks::LANE_SLOTS],
            master: 0.7, transpose: 0, tempo: 1., looping: false,
            selection: None, view: (0., 3.),
        };
        for stamp in [json!(23), json!(4.5), json!(-2),
            json!(18446744073709549568u64), json!(i64::MIN), json!(18446744073709551616.0)] {
            let mut raw = crate::project_store::update_mix(json!({"version":2}), &mix).unwrap();
            raw["settings"]["beat"]["detVersion"] = stamp;
            let original = serde_json::to_vec(&raw).unwrap();
            let raw: Value = serde_json::from_slice(&original).unwrap();
            let mut reopened = mix.clone();
            reopened.beat = Beats::sanitize(&raw["settings"]["beat"]);
            let saved = crate::project_store::update_mix(raw, &reopened).unwrap();
            assert_eq!(serde_json::to_vec(&saved).unwrap(), original,
                "saving a reopened project must preserve its detector stamp bytes");
        }
    }
    fn detector_track(user_bars: Vec<f64>, auto: Vec<usize>) -> Beats {
        let mut grid = Beats::constant(60., 0., 63., 4).unwrap();
        grid.source = "auto".into();
        grid.det_version = Some(23.);
        grid.auto_downbeats = Some(auto);
        grid.user_bars = Some(user_bars);
        grid
    }
    fn uniform_bars() -> Vec<usize> {
        (0..16).map(|index| index * 4).collect()
    }
    fn bar_lengths(grid: &Beats) -> Vec<usize> {
        grid.downbeats
            .as_ref()
            .unwrap()
            .windows(2)
            .map(|pair| pair[1] - pair[0])
            .collect()
    }
    #[test]
    fn nearest_beat_ties_and_uniform_or_explicit_bar_indexes_match_source() {
        let mut grid = Beats::constant(120., 0., 5., 4).unwrap();
        assert_eq!(grid.nearest_beat(-1.), Some(0));
        assert_eq!(grid.nearest_beat(0.25), Some(0));
        assert_eq!(grid.nearest_beat(0.26), Some(1));
        assert_eq!(grid.nearest_beat(999.), Some(grid.beats.len() - 1));
        grid.downbeat = 2;
        assert_eq!(grid.bar_indices(), vec![2, 6, 10]);
        grid.downbeats = Some(vec![1, 4, 6, 10]);
        assert_eq!(grid.bar_indices(), vec![1, 4, 6, 10]);
        grid.beats.clear();
        assert_eq!(grid.nearest_beat(1.), None);
    }
    #[test]
    fn source_hand_marks_rephase_only_until_the_next_mark() {
        let unchanged = detector_track(vec![], uniform_bars()).apply_user_bars();
        assert_eq!(unchanged.downbeats, Some(uniform_bars()));
        let longer = detector_track(vec![21.], uniform_bars()).apply_user_bars();
        assert_eq!(
            &longer.downbeats.as_ref().unwrap()[..7],
            &[0, 4, 8, 12, 16, 21, 25]
        );
        assert_eq!(
            bar_lengths(&longer)
                .into_iter()
                .filter(|length| *length != 4)
                .collect::<Vec<_>>(),
            vec![5]
        );
        let shorter = detector_track(vec![19.], uniform_bars()).apply_user_bars();
        assert_eq!(
            bar_lengths(&shorter)
                .into_iter()
                .filter(|length| *length != 4)
                .collect::<Vec<_>>(),
            vec![3]
        );
        let two_marks = detector_track(vec![21., 38.], uniform_bars()).apply_user_bars();
        assert_eq!(
            bar_lengths(&two_marks)
                .into_iter()
                .filter(|length| *length != 4)
                .collect::<Vec<_>>(),
            vec![5, 5]
        );
    }
    #[test]
    fn repeat_folding_preserves_detector_base_and_odd_bars() {
        let auto = vec![0, 4, 8, 12, 16, 20, 24, 26, 30, 34, 38];
        let original = detector_track(vec![21.], auto.clone());
        let once = original.apply_user_bars();
        assert!(bar_lengths(&once).contains(&2));
        assert_eq!(once.auto_downbeats, Some(auto));
        assert_eq!(once.apply_user_bars(), once);
        assert_eq!(once.source, "auto");
        assert_eq!(once.det_version, Some(23.));
        assert_eq!(once.user_bars, original.user_bars);
        assert_eq!(original.downbeats, None);
        let mut triple = detector_track(vec![8.], vec![1, 4, 7, 9, 12, 15]);
        triple.beats_per_bar = 3;
        let triple = triple.apply_user_bars();
        assert_eq!(triple.downbeats, Some(vec![1, 4, 8, 10, 13, 16]));
        assert_eq!(triple.downbeat, 1);
        assert!(bar_lengths(&triple).contains(&2));
    }
    #[test]
    fn moving_a_hand_mark_replaces_its_time_and_undo_restores_the_base() {
        let mut base = detector_track(vec![], uniform_bars());
        // With no saved base yet, the first edit snapshots the explicit map.
        base.auto_downbeats = None;
        base.downbeats = Some(uniform_bars());
        let first = base.set_user_bar(21.2, Some(20.));
        assert_eq!(first.user_bars, Some(vec![21.]));
        assert_eq!(first.auto_downbeats, Some(uniform_bars()));
        let moved = first.set_user_bar(22., Some(21.));
        assert_eq!(moved.user_bars, Some(vec![22.]));
        assert_eq!(moved.set_user_bar(22., Some(22.)), moved);
        assert_eq!(moved.clear_user_bar(3.), moved);
        let undone = moved.clear_user_bar(22.3);
        assert_eq!(undone.user_bars, Some(vec![]));
        assert_eq!(undone.downbeats, Some(uniform_bars()));
        assert_eq!(undone.auto_downbeats, Some(uniform_bars()));
        assert_eq!(undone.source, "auto");
        assert_eq!(undone.det_version, base.det_version);
    }
    #[test]
    fn fresh_detection_resnaps_stored_seconds_instead_of_reusing_old_indexes() {
        let corrected = detector_track(vec![21.], uniform_bars()).apply_user_bars();
        let mut fresh = detector_track(
            corrected.user_bars.unwrap(),
            (0..15).map(|i| i * 4).collect(),
        );
        fresh.beats = (0..62).map(|i| i as f64 + 2.2).collect();
        fresh.det_version = Some(24.);
        fresh.suspect_at = Some(vec![32.]);
        let folded = fresh.apply_user_bars();
        let marked: Vec<_> = folded
            .downbeats
            .as_ref()
            .unwrap()
            .iter()
            .map(|index| folded.beats[*index])
            .collect();
        assert!(marked.iter().any(|time| (*time - 21.2).abs() < 1e-9));
        assert!(!marked.iter().any(|time| (*time - 23.2).abs() < 1e-9));
        assert_eq!(folded.auto_downbeats, fresh.auto_downbeats);
        assert_eq!(folded.user_bars, Some(vec![21.]));
        assert_eq!(folded.suspect_at, fresh.suspect_at);
        assert_eq!(folded.source, "auto");
        assert_eq!(folded.det_version, Some(24.));
    }
    #[test]
    fn corrections_at_the_tail_or_without_automatic_bars_stay_in_range() {
        let tail = detector_track(vec![62., 63.], uniform_bars()).apply_user_bars();
        assert_eq!(&tail.downbeats.as_ref().unwrap()[14..], &[56, 62, 63]);
        assert!(
            tail.downbeats
                .as_ref()
                .unwrap()
                .iter()
                .all(|index| *index < 64)
        );
        let hand_only = detector_track(vec![21.1, 21.2, 38.], vec![]).apply_user_bars();
        assert_eq!(hand_only.downbeats, Some(vec![21, 38]));
        assert_eq!(hand_only.auto_downbeats, Some(vec![]));
        let mut empty = detector_track(vec![1.], vec![]);
        empty.beats.clear();
        assert_eq!(empty.set_user_bar(1., None), empty);
        let folded = empty.apply_user_bars();
        assert_eq!(folded.downbeats, None);
        assert_eq!(folded.auto_downbeats, Some(vec![]));
    }
    #[test]
    fn stored_source_sanitization_and_atomic_bar_map() {
        let g=Beats::sanitize(&json!({"beats":[1.,0.5,1.5,2.],"beatsPerBar":3,"downbeat":7,"source":"auto","downbeats":[0,3,2],"userBars":[0.4,999]})).unwrap();
        assert_eq!(g.beats, vec![0.5, 1., 1.5, 2.]);
        assert_eq!((g.bpm, g.beats_per_bar, g.downbeat), (120., 3, 1));
        assert!(g.downbeats.is_none());
        assert_eq!(g.user_bars, Some(vec![0.4]));
        assert!(Beats::sanitize(&json!({"beats":[0,0.001,0.002]})).is_none());
    }
    #[test]
    fn metronome_defaults_and_clamps_match_source() {
        assert_eq!(Metronome::sanitize(&json!({})), Metronome::default());
        assert_eq!(
            Metronome::sanitize(
                &json!({"click":true,"countInBars":9,"volume":3,"accent":false,"grid":true})
            ),
            Metronome {
                click: true,
                count_in_bars: 2,
                volume: 1.,
                accent: false,
                grid: true
            }
        );
    }
    #[test]
    fn mid_song_anchor_and_meter_transforms_preserve_musical_time() {
        let g = Beats::constant(100., 47.3, 100., 4).unwrap();
        let i = g
            .beats
            .iter()
            .position(|t| (*t - 47.3).abs() < 1e-8)
            .unwrap();
        assert_eq!(g.accent_index(i as i64), 0);
        let mut g = Beats::constant(120., 0., 5.5, 4).unwrap();
        g.downbeats = Some(vec![0, 4, 6, 10]);
        assert_eq!(g.half().downbeats, Some(vec![0, 2, 3, 5]));
        assert_eq!(g.double().downbeats, Some(vec![0, 8, 12, 20]));
        assert_eq!(g.shift(0.01).downbeats, g.downbeats);
        g.downbeat = 1;
        g.downbeats = Some(vec![0, 5, 9]);
        assert_eq!(g.half().downbeats, Some(vec![0, 2, 4]));
        assert!(g.uniform_meter(3, false).unwrap().downbeats.is_none());
    }
    #[test]
    fn variable_bars_and_pickup_numbering_match_source() {
        let mut g = Beats::constant(120., 0., 9.5, 4).unwrap();
        g.downbeat = 2;
        g.downbeats = Some(vec![2, 6, 9, 13]);
        for (i, n) in [
            (2, 1),
            (5, 1),
            (6, 2),
            (9, 3),
            (13, 4),
            (17, 5),
            (1, 0),
            (-2, 0),
            (-3, -1),
        ] {
            assert_eq!(g.bar_number(i), n);
        }
        assert_eq!(g.accent_index(8), 2);
        assert_eq!(g.accent_index(-2), 0);
    }
    #[test]
    fn tap_requires_three_and_resets_after_pause() {
        assert_eq!(tap_bpm(&[0., 0.5]), None);
        assert_eq!(tap_bpm(&[0., 0.5, 1., 1.5]), Some(120.));
        assert_eq!(tap_bpm(&[0., 0.25, 10., 10.5, 11., 11.5]), Some(120.));
        assert_eq!(tap_bpm(&[0., 0., 0.]), None);
    }
    #[test]
    fn large_grid_transaction_is_bounded_and_ordered() {
        let g = Beats::constant(120., 0., 9999.5, 4).unwrap();
        let met = Metronome {
            click: true,
            ..Default::default()
        };
        let c = commands(&met, Some(&g)).unwrap();
        assert!(c[0].ends_with("20000 0"));
        assert_eq!(c.last().unwrap(), "met-apply");
        assert!(c.iter().all(|s| s.len() < 4096));
        assert!(commands(&met, None).unwrap()[0].starts_with("met-begin 0 "));
        assert!(commands(&met, Some(&g.shift(-0.01))).is_err());
        let mut huge_bar = g.clone();
        huge_bar.downbeats = Some(vec![0, 19_999]);
        assert!(
            commands(
                &Metronome {
                    count_in_bars: 2,
                    ..met.clone()
                },
                Some(&huge_bar)
            )
            .is_err()
        );
        assert!(Beats::constant(300., 0., 43200., 4).is_err());
    }
}

//! Source count-in dots derived from accepted native render/latency telemetry.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::Duration;
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct CountIn {
    pub total: usize,
    pub done: usize,
    pub per_bar: usize,
}
#[derive(Clone, Copy, Debug, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct Heard {
    pub seconds_to_landing: f64,
    pub landing_seconds: f64,
    pub total: usize,
    pub per_bar: usize,
    pub pre_roll_seconds: f64,
}
impl Heard {
    pub fn parse(value: Option<&Value>) -> Result<Option<Self>> {
        let Some(value) = value.filter(|v| !v.is_null()) else {
            return Ok(None);
        };
        let heard: Self =
            serde_json::from_value(value.clone()).context("Malformed native count-in clock")?;
        ensure!(
            heard.total > 0
                && heard.total <= 40_000
                && heard.per_bar > 0
                && heard.per_bar <= heard.total
                && heard.seconds_to_landing.is_finite()
                && heard.seconds_to_landing <= 0.
                && heard.landing_seconds.is_finite()
                && heard.landing_seconds >= 0.
                && heard.pre_roll_seconds.is_finite()
                && heard.pre_roll_seconds > 0.
                && heard.pre_roll_seconds <= 86400. * 365.,
            "Invalid native count-in clock"
        );
        Ok(Some(heard))
    }
}
fn local_period(grid: &crate::beat::Beats, index: i64) -> f64 {
    let beats = &grid.beats;
    if beats.len() < 2 {
        return 60. / grid.bpm;
    }
    let start = (index - 4).clamp(0, beats.len() as i64 - 2) as usize;
    let end = (start + 8).min(beats.len() - 1);
    let mut intervals: Vec<_> = (start..end).map(|i| beats[i + 1] - beats[i]).collect();
    intervals.sort_by(f64::total_cmp);
    intervals[intervals.len() / 2]
}
fn beat_time(grid: &crate::beat::Beats, index: i64) -> f64 {
    let beats = &grid.beats;
    if index < 0 {
        return beats[0] + index as f64 * local_period(grid, 0);
    }
    if index >= beats.len() as i64 {
        return beats[beats.len() - 1]
            + (index - (beats.len() as i64 - 1)) as f64
                * local_period(grid, beats.len() as i64 - 1);
    }
    beats[index as usize]
}
fn entry_index(grid: &crate::beat::Beats, time: f64) -> i64 {
    let beats = &grid.beats;
    if time <= beats[0] {
        let k = ((beats[0] - time) / local_period(grid, 0) + 1e-9).floor() as i64;
        return if k > 0 { -k } else { 0 };
    }
    if time > beats[beats.len() - 1] {
        return beats.len() as i64 - 1
            + ((time - beats[beats.len() - 1]) / local_period(grid, beats.len() as i64 - 1) - 1e-9)
                .ceil() as i64;
    }
    beats.partition_point(|beat| *beat < time - 1e-9) as i64
}
fn bar_length(grid: &crate::beat::Beats, index: i64) -> usize {
    let Some(d) = grid.downbeats.as_ref().filter(|d| d.len() >= 2) else {
        return grid.beats_per_bar;
    };
    if index < d[0] as i64 {
        return d[1] - d[0];
    }
    if index >= d[d.len() - 1] as i64 {
        return d[d.len() - 1] - d[d.len() - 2];
    }
    let j = d.partition_point(|d| *d as i64 <= index) - 1;
    d[j + 1] - d[j]
}
/// The source facade's preceding beat offsets, not evenly divided runway.
pub fn offsets(
    landing: f64,
    grid: Option<&crate::beat::Beats>,
    met: &crate::beat::Metronome,
    rate: f64,
) -> Vec<f64> {
    if met.count_in_bars == 0 || !landing.is_finite() || !rate.is_finite() || rate <= 0. {
        return vec![];
    }
    let bars = met.count_in_bars as usize;
    if let Some(grid) = grid {
        if grid.beats.is_empty()
            || grid.beats.len() > 20_000
            || !grid.bpm.is_finite()
            || grid.bpm <= 0.
            || grid.beats.iter().any(|n| !n.is_finite())
            || grid.beats.windows(2).any(|p| p[1] <= p[0])
            || grid
                .downbeats
                .as_ref()
                .is_some_and(|d| d.windows(2).any(|p| p[1] <= p[0]))
        {
            return vec![];
        }
        let entry = entry_index(grid, landing);
        let count = bars.saturating_mul(bar_length(grid, entry));
        if count > 40_000 {
            return vec![];
        }
        (0..count)
            .map(|k| beat_time(grid, entry - count as i64 + k as i64) - landing)
            .collect()
    } else {
        let ticks = bars * 3;
        (0..ticks).map(|k| -((ticks - k) as f64) * rate).collect()
    }
}
pub fn count_in(
    status: &crate::integration::Status,
    grid: Option<&crate::beat::Beats>,
    met: &crate::beat::Metronome,
) -> Option<CountIn> {
    count_in_at_elapsed(status, grid, met, status.sampled_at.elapsed())
}
/// A stalled poll freezes after four source fast-poll intervals (200 ms).
pub fn count_in_at_elapsed(
    status: &crate::integration::Status,
    grid: Option<&crate::beat::Beats>,
    met: &crate::beat::Metronome,
    elapsed: Duration,
) -> Option<CountIn> {
    let heard = status.count_in_heard?;
    let prepared = offsets(heard.landing_seconds, grid, met, status.rate as f64);
    count_in_from_offsets_at_elapsed(status, &prepared, elapsed)
}
/// Use sorted offsets captured once for the accepted native graph, landing,
/// metronome and rate. No beat-grid validation or allocation occurs per frame.
pub fn count_in_from_offsets(
    status: &crate::integration::Status,
    offsets: &[f64],
) -> Option<CountIn> {
    count_in_from_offsets_at_elapsed(status, offsets, status.sampled_at.elapsed())
}
pub fn count_in_from_offsets_at_elapsed(
    status: &crate::integration::Status,
    offsets: &[f64],
    elapsed: Duration,
) -> Option<CountIn> {
    let heard = status.count_in_heard?;
    if !status.playing || status.empty_project || status.training_only {
        return None;
    }
    let advance = elapsed.as_secs_f64().min(0.2) * status.rate as f64;
    let projected = heard.seconds_to_landing + advance;
    if status.rendered_frame >= 0 && projected >= 0. {
        return None;
    }
    let seconds = projected.min(0.);
    let done = if offsets.len() == heard.total {
        offsets.partition_point(|offset| seconds >= *offset)
    } else if heard.pre_roll_seconds > 0. {
        let elapsed = (heard.pre_roll_seconds + seconds).max(0.);
        ((elapsed * heard.total as f64 / heard.pre_roll_seconds).floor() + 1.)
            .max(0.)
            .min(heard.total as f64) as usize
    } else {
        0
    };
    Some(CountIn {
        total: heard.total,
        done: done.min(heard.total),
        per_bar: heard.per_bar,
    })
}
#[cfg(test)]
#[path = "transport_timing_tests.rs"]
mod tests;

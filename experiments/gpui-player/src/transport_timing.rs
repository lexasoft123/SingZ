//! Source count-in dots derived from accepted native render/latency telemetry.
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::time::{Duration, Instant};
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

// BEGIN PLAYHEAD (also compiled by the dependency-free sampling harness).
/// A copy of clock telemetry only: admission and projection never clone a status.
/// The helper has already subtracted presentation latency from an immature
/// position. Subtracting cue latency here would compensate the clock twice.
#[derive(Clone, Copy, Debug)]
pub struct PlayheadSample {
    pub position: f64,
    pub sampled_at: Instant,
    pub playing: bool,
    pub audible_current: bool,
    pub seek_count: u64,
    pub loop_count: u64,
    pub loop_range: Option<(f64, f64)>,
    pub rate: f64,
    pub counting_in: bool,
    pub rendered_frame: i64,
    pub duration: f64,
    pub graph_generation: u64,
    pub lane_revision: u64,
}

/// The sole owner of displayed song time, including local seeks and test/demo
/// clocks. No timer, heap storage or status ownership is needed per frame.
#[derive(Debug)]
pub struct Playhead {
    position: f64,
    sample: Option<PlayheadSample>,
    anchor: Option<(f64, Instant)>,
    pending_seek: Option<(u64, f64)>,
    pending_seek_at: Option<Instant>,
    seek_origin: Option<(f64, bool)>,
    seek_count: u64,
    loop_count: u64,
    loop_range: Option<(f64, f64)>,
    paused: bool,
    unwrapped: f64,
    anchor_unwrapped: f64,
    can_project: bool,
    // An epoch retirement holds its last drawing until the new receipt arrives.
    reset_on_admission: bool,
}
impl Default for Playhead {
    fn default() -> Self {
        Self::new(0.)
    }
}
impl Playhead {
    pub fn new(position: f64) -> Self {
        Self {
            position,
            sample: None,
            anchor: None,
            pending_seek: None,
            pending_seek_at: None,
            seek_origin: None,
            seek_count: 0,
            loop_count: 0,
            loop_range: None,
            paused: false,
            unwrapped: position,
            anchor_unwrapped: position,
            can_project: false,
            reset_on_admission: false,
        }
    }
    pub fn position(&self) -> f64 {
        self.position
    }
    pub fn pending_seek(&self) -> Option<(u64, f64)> {
        self.pending_seek
    }
    pub fn seek_count(&self) -> u64 {
        self.seek_count
    }
    pub fn loop_count(&self) -> u64 {
        self.loop_count
    }
    pub fn loop_range(&self) -> Option<(f64, f64)> {
        self.loop_range
    }
    /// A consumer must not extrapolate a held seek/pause/count-in independently.
    pub fn anchor(&self) -> Option<(f64, Instant)> {
        if self.anchor.is_none()
            || self.pending_seek.is_some()
            || self.sample.is_some_and(|s| {
                s.playing
                    && (self.paused
                        || !self.can_project
                        || !s.audible_current
                        || s.counting_in
                        || s.rendered_frame < 0)
            })
        {
            None
        } else {
            // Keep the native authority timestamp. Re-anchoring a projected
            // value at a render would give an independent editor another 100ms
            // after the host's stalled-clock deadline has already expired.
            self.anchor.map(|(source, at)| {
                (
                    if self.sample.is_some_and(|s| s.playing) {
                        source
                    } else {
                        self.position
                    },
                    at,
                )
            })
        }
    }
    pub fn reset(&mut self, position: f64) {
        *self = Self::new(position);
    }
    pub fn stop_projection(&mut self) {
        self.anchor = None;
        self.sample = None;
        self.pending_seek = None;
        self.pending_seek_at = None;
        self.seek_origin = None;
        self.can_project = false;
        self.paused = false;
        self.reset_on_admission = true;
    }
    pub fn seek(&mut self, target: f64) {
        // Keep the native anchor and epoch fence available for refusal/expiry.
        let origin = self.seek_origin.map_or(self.position, |(position, _)| position);
        self.seek_origin = Some((origin, self.paused));
        self.position = target;
        self.unwrapped = target;
        self.anchor = None;
        self.paused = false;
    }
    /// The UI placed a target, but the transport did not accept that command.
    pub fn seek_refused(&mut self) {
        if let Some((_, paused)) = self.seek_origin {
            self.paused = paused;
        }
        self.resume_native_position();
    }
    /// The transport accepted a seek to `target` and later refused it (a
    /// survivable helper refusal). Its pending acknowledgement will never
    /// arrive, so release that hold now instead of waiting for the expiry.
    pub fn seek_rejected(&mut self, target: f64) {
        if self
            .pending_seek
            .is_some_and(|(_, pending)| (pending - target).abs() < 1e-6)
        {
            self.pending_seek = None;
            self.pending_seek_at = None;
        }
        self.seek_refused();
    }
    fn resume_native_position(&mut self) {
        if let Some((_, target)) = self.pending_seek {
            // Refusing a second seek must not cancel the first accepted one.
            self.position = target;
            self.unwrapped = target;
        } else {
            let origin = self.seek_origin.take().map(|(position, _)| position);
            if let Some(sample) = self.sample {
                if sample.counting_in || sample.rendered_frame < 0 {
                    self.position = origin.unwrap_or(self.position);
                    self.unwrapped = self.position;
                } else {
                    self.position = sample.position;
                    self.unwrapped = self.anchor_unwrapped;
                }
            } else {
                if let Some(position) = origin {
                    self.position = position;
                    self.unwrapped = position;
                }
                // There is no raw clock yet; the next receipt supplies it.
                self.reset_on_admission = true;
            }
        }
        self.anchor = self.sample.map(|sample| (sample.position, sample.sampled_at));
        self.can_project = false;
    }
    /// Only a successfully queued command earns an expected native counter.
    /// Two queued seeks each require their own receipt, even across a rate graph.
    pub fn seek_queued(&mut self, now: Instant) {
        let expected = self
            .pending_seek
            .map_or(self.seek_count + 1, |(count, _)| count + 1);
        self.pending_seek = Some((expected, self.position));
        self.pending_seek_at = Some(now);
    }
    pub fn play_intent(&mut self, now: Instant) {
        self.shown(now);
        self.reset_on_admission = false;
        self.paused = false;
    }
    pub fn pause_intent(&mut self, now: Instant) {
        self.shown(now);
        self.paused = true;
    }
    pub fn admit(&mut self, sample: PlayheadSample, now: Instant) -> bool {
        if self.reset_on_admission {
            self.reset(sample.position);
        }
        if let Some(old) = self.sample {
            // Equal timestamps are duplicate telemetry, not fresh authority.
            // Rejection also makes playback_status skip settings/timing snapshot
            // updates: neither view may adopt different data for the same clock.
            if sample.sampled_at <= old.sampled_at
                || sample.graph_generation < old.graph_generation
                || sample.lane_revision < old.lane_revision
            {
                return false;
            }
            let identity_changed = sample.graph_generation != old.graph_generation
                || sample.lane_revision != old.lane_revision;
            if identity_changed {
                // A graph receipt is not a receipt for a seek queued behind a
                // rate. Preserve both its counter and target across the reset.
                let queued = self.pending_seek;
                let queued_at = self.pending_seek_at;
                let seek_origin = self.seek_origin;
                let paused = self.paused;
                let held = self.position;
                let pause_floor = paused && (sample.playing || sample.loop_count == old.loop_count);
                self.reset(queued.map_or_else(
                    || {
                        if sample.counting_in || sample.rendered_frame < 0 {
                            // Count-in preparation replaces the graph, whose
                            // negative runway is published as position zero.
                            held
                        } else if pause_floor {
                            held.max(sample.position)
                        } else {
                            sample.position
                        }
                    },
                    |(_, target)| target,
                ));
                self.paused = paused;
                self.pending_seek = queued.filter(|(expected, _)| sample.seek_count < *expected);
                self.pending_seek_at = queued_at.filter(|_| self.pending_seek.is_some());
                self.seek_origin = seek_origin.filter(|_| self.pending_seek.is_some());
            } else if sample.seek_count > old.seek_count && self.pending_seek.is_none() {
                // A native seek not issued by this UI is an explicit clock edge.
                self.seek(sample.position);
            }
        }
        if self.loop_range != sample.loop_range {
            self.unwrapped = self.position;
        }
        if self
            .pending_seek
            .is_some_and(|(expected, _)| sample.seek_count >= expected)
        {
            self.pending_seek = None;
            self.pending_seek_at = None;
        }
        // Use the *raw* compensated anchor. Flooring before extrapolation
        // would move the bar immediately after Play, then rewind at maturity.
        let mut unwrapped = sample.position;
        if let Some((start, end)) = sample.loop_range.filter(|(s, e)| e > s) {
            if sample.loop_count > 0 && sample.position >= start && sample.position < end {
                let length = end - start;
                // The helper's lap counter describes the render head. A stale
                // stand-in can still describe the ear in its previous lap.
                // Pick the nearest audible lap, bounded by the native count;
                // max in shown() prevents going back into a lap already drawn.
                let lap = ((self.unwrapped - sample.position) / length)
                    .round()
                    .max(0.)
                    .min(sample.loop_count as f64);
                unwrapped += lap * length;
            }
        }
        self.anchor_unwrapped = unwrapped;
        self.anchor = Some((sample.position, sample.sampled_at));
        self.seek_count = sample.seek_count;
        self.loop_count = sample.loop_count;
        self.loop_range = sample.loop_range;
        self.sample = Some(sample);
        if self.pending_seek.is_none() { self.seek_origin = None; }
        self.shown(now);
        true
    }
    pub fn shown(&mut self, now: Instant) -> f64 {
        if self.pending_seek.is_some()
            && self.pending_seek_at.is_some_and(|queued| {
                now.saturating_duration_since(queued) >= Duration::from_secs(1)
            })
        {
            self.pending_seek = None;
            self.pending_seek_at = None;
            // A lost receipt cannot freeze the UI indefinitely. Keep the latest
            // Pause intent, and rejoin the latest raw sample rather than target.
            self.resume_native_position();
        }
        let (Some(sample), Some((_, at))) = (self.sample, self.anchor) else {
            return self.position;
        };
        if self.pending_seek.is_some()
            || sample.counting_in
            || sample.rendered_frame < 0
            || (self.paused && sample.playing)
        {
            return self.position;
        }
        let advance = if sample.playing && !self.paused {
            now.saturating_duration_since(at).as_secs_f64().min(0.1) * sample.rate
        } else {
            0.
        };
        let proposed = self.anchor_unwrapped + advance;
        self.can_project = proposed >= self.unwrapped;
        self.unwrapped = self.unwrapped.max(proposed);
        let mut position = self.unwrapped;
        if let Some((start, end)) = self.loop_range.filter(|(s, e)| e > s) {
            if position >= end {
                position = start + (position - start).rem_euclid(end - start);
            }
        }
        let position = position.max(0.);
        self.position = if sample.duration.is_finite() {
            position.min(sample.duration.max(0.))
        } else {
            position
        };
        self.position
    }
    /// The fixture clock follows the same owner; a demo wrap is an explicit seek.
    pub fn advance_demo(&mut self, seconds: f64, duration: f64, looping: bool) {
        let mut position = self.position + seconds;
        if looping && duration > 0. && position >= duration {
            position %= duration;
        }
        self.seek(position.min(duration));
        self.seek_origin = None; // The demo clock is already committed locally.
    }
}
// END PLAYHEAD

impl From<&crate::integration::Status> for PlayheadSample {
    fn from(s: &crate::integration::Status) -> Self {
        Self {
            position: s.position,
            sampled_at: s.sampled_at,
            playing: s.playing,
            audible_current: s.audible_current,
            seek_count: s.seek_count,
            loop_count: s.loop_count,
            loop_range: s.loop_range,
            rate: s.rate as f64,
            counting_in: s.counting_in,
            rendered_frame: s.rendered_frame,
            duration: s.duration,
            graph_generation: s.graph_generation,
            lane_revision: s.lane_revision,
        }
    }
}

#[cfg(test)]
#[path = "transport_timing_tests.rs"]
mod tests;

//! Presented-frame log (C-07, D-02 section 5): a preallocated ring of presented
//! drawables, the statistics over it, and the JSON the perf harness merges.
//!
//! Compiled under `ui-tests` only. The present observer runs on a system
//! thread and only copies numbers into the ring; nothing allocates after
//! construction.
use std::sync::{
    Mutex,
    atomic::{AtomicBool, Ordering},
};

/// 3 minutes at 120 Hz plus margin (D-02 4.3).
pub const RING_CAPACITY: usize = 32_768;
const MARK_CAPACITY: usize = 256;
/// Frames after a late gap in which early gaps may repay it (callback-clock jitter).
const JITTER_LOOKAHEAD: usize = 3;

pub const HIDDEN_REASON: &str = "hidden window presents no frames";

/// One presented (or skipped) drawable with the app state of the frame that produced it.
#[derive(Clone, Copy, Debug, Default, PartialEq)]
pub struct Sample {
    /// Host seconds the drawable reached the display; `0.0` = skipped.
    pub presented: f64,
    /// Host seconds the present was queued.
    pub commit: f64,
    /// Host seconds the presented handler ran (the callback arrives at presentation).
    pub handled: f64,
    /// An animation source was demanding frames when this frame was built.
    pub demand: bool,
    /// Projected song position of the frame, seconds.
    pub position: f32,
}

/// Fixed-capacity ring; pushing past capacity overwrites the oldest sample.
pub struct Ring {
    slots: Box<[Sample]>,
    head: usize,
    len: usize,
}

impl Ring {
    pub fn new(capacity: usize) -> Self {
        assert!(capacity > 0);
        Self { slots: vec![Sample::default(); capacity].into_boxed_slice(), head: 0, len: 0 }
    }
    pub fn capacity(&self) -> usize { self.slots.len() }
    pub fn len(&self) -> usize { self.len }
    pub fn clear(&mut self) { self.head = 0; self.len = 0; }
    pub fn push(&mut self, sample: Sample) {
        let capacity = self.slots.len();
        let index = (self.head + self.len) % capacity;
        self.slots[index] = sample;
        if self.len == capacity { self.head = (self.head + 1) % capacity; } else { self.len += 1; }
    }
    /// Oldest to newest.
    pub fn iter(&self) -> impl Iterator<Item = &Sample> + '_ {
        (0..self.len).map(move |i| &self.slots[(self.head + i) % self.slots.len()])
    }
    pub fn to_vec(&self) -> Vec<Sample> { self.iter().copied().collect() }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Stats {
    /// Samples recorded, including skipped drawables.
    pub samples: usize,
    pub skipped: usize,
    pub fps: Option<f64>,
    pub period_ms: Option<f64>,
    pub p50_ms: Option<f64>,
    pub p99_ms: Option<f64>,
    pub max_ms: Option<f64>,
    pub dropped: Option<u64>,
    pub window_s: Option<f64>,
}

fn percentile(sorted: &[f64], p: f64) -> f64 {
    sorted[((sorted.len() as f64 * p).ceil() as usize).clamp(1, sorted.len()) - 1]
}

/// Statistics over samples in presentation order. `period_s` is the expected frame
/// period; `None` uses the median presented delta. See D-02 5.2.
pub fn stats(samples: &[Sample], period_s: Option<f64>) -> Stats {
    let skipped = samples.iter().filter(|s| s.presented <= 0.).count();
    let mut out = Stats { samples: samples.len(), skipped, fps: None, period_ms: None, p50_ms: None,
        p99_ms: None, max_ms: None, dropped: None, window_s: None };
    // Valid samples with the number of skipped ones between them and the previous valid one.
    let mut valid: Vec<(&Sample, usize)> = Vec::with_capacity(samples.len());
    let mut zeros = 0;
    for sample in samples {
        if sample.presented <= 0. { zeros += 1; } else { valid.push((sample, zeros)); zeros = 0; }
    }
    // Skipped drawables count as dropped whether or not frames surround them.
    let mut dropped = skipped as u64;
    if valid.len() < 2 {
        out.dropped = Some(dropped).filter(|_| !samples.is_empty());
        return out;
    }
    let deltas: Vec<f64> = valid.windows(2).map(|w| w[1].0.presented - w[0].0.presented).collect();
    let span = valid[valid.len() - 1].0.presented - valid[0].0.presented;
    out.window_s = Some(span);
    out.fps = (span > 0.).then(|| (valid.len() - 1) as f64 / span);
    let mut sorted = deltas.clone();
    sorted.sort_by(f64::total_cmp);
    let period = period_s.filter(|p| p.is_finite() && *p > 0.).unwrap_or_else(|| percentile(&sorted, 0.5));
    out.period_ms = Some(period * 1000.);
    out.p50_ms = Some(percentile(&sorted, 0.5) * 1000.);
    out.p99_ms = Some(percentile(&sorted, 0.99) * 1000.);
    out.max_ms = Some(sorted[sorted.len() - 1] * 1000.);
    // Slots a gap spans, minus skipped drawables inside it (already counted above).
    let slots = |delta: f64| ((delta / period).round() as i64).max(1);
    let demanded = |i: usize| valid[i].0.demand && valid[i + 1].0.demand;
    let mut i = 0;
    while i < deltas.len() {
        // A gap that spans a period with no demand is not a drop.
        if !demanded(i) { i += 1; continue; }
        let skipped_between = valid[i + 1].1 as i64;
        // A late callback repaid by early ones within the next few frames (timestamp jitter, not
        // a lost frame): the run of gaps spans fewer slots together than apart. The vsync grid
        // kept its phase, so only the net missing slots count.
        let mut jitter = None;
        if slots(deltas[i]) > 1 {
            let (mut total, mut apart) = (deltas[i], slots(deltas[i]));
            for j in 1..=JITTER_LOOKAHEAD {
                if i + j >= deltas.len() || !demanded(i + j) || valid[i + j + 1].1 != 0 || valid[i + 1].1 != 0 { break; }
                total += deltas[i + j];
                apart += slots(deltas[i + j]);
                if slots(total) < apart { jitter = Some((j, (slots(total) - (j as i64 + 1)).max(0) as u64)); break; }
            }
        }
        if let Some((j, missed)) = jitter {
            dropped += missed;
            i += j + 1;
            continue;
        }
        dropped += (slots(deltas[i]) - 1 - skipped_between).max(0) as u64;
        i += 1;
    }
    out.dropped = Some(dropped);
    out
}

pub const SOURCE_PRESENTED: &str = "presentedTime";
pub const SOURCE_HANDLER: &str = "handler-callback-time";

/// Some displays (seen on a Mac mini 1080p panel) return `presentedTime == 0` for
/// every drawable. A run where all of at least 10 samples are zero has no usable
/// presented times: use the handler's callback time (the callback fires at
/// presentation) and say so. Otherwise zero still means a skipped drawable.
pub fn resolve_times(samples: &[Sample]) -> (Vec<Sample>, &'static str) {
    if samples.len() >= 10 && samples.iter().all(|s| s.presented <= 0. && s.handled > 0.) {
        (samples.iter().map(|s| Sample { presented: s.handled, ..*s }).collect(), SOURCE_HANDLER)
    } else {
        (samples.to_vec(), SOURCE_PRESENTED)
    }
}

/// Frame slots for the C-06 schema. A hidden window, or a log without enough samples,
/// reports null with a reason, never zero.
pub fn report(samples: &[Sample], period_s: Option<f64>, hidden: bool) -> serde_json::Value {
    let (samples, source) = resolve_times(samples);
    let samples = &samples[..];
    let st = stats(samples, period_s);
    let null_reason = if hidden { Some(HIDDEN_REASON) } else if st.fps.is_none() { Some("fewer than two presented frames") } else { None };
    let (fps, frame_time, dropped) = if hidden || st.fps.is_none() {
        (None, None, None)
    } else {
        (st.fps, st.p50_ms.map(|p50| serde_json::json!({"p50": p50, "p99": st.p99_ms, "max": st.max_ms, "periodMs": st.period_ms})), st.dropped)
    };
    // Presents per whole second from the first sample: shows steady versus bursty sources.
    let mut per_second: Vec<u32> = Vec::new();
    if let Some(first) = samples.iter().find(|s| s.presented > 0.).map(|s| s.presented) {
        for s in samples.iter().filter(|s| s.presented > 0.) {
            let bucket = ((s.presented - first) as usize).min(3_600);
            if per_second.len() <= bucket { per_second.resize(bucket + 1, 0); }
            per_second[bucket] += 1;
        }
    }
    serde_json::json!({
        "perSecond": per_second,
        "fps": fps, "frameTimeMs": frame_time, "dropped": dropped, "reason": null_reason,
        "presentedSamples": st.samples, "timeSource": source,
        "skipped": st.skipped, "windowS": st.window_s,
        "demandSamples": samples.iter().filter(|s| s.demand).count(),
    })
}

// ---- Process-wide recorder ------------------------------------------------

#[derive(Clone, Copy, Default)]
struct Mark { at: f64, demand: bool, position: f32 }

struct Recorder {
    ring: Ring,
    marks: [Mark; MARK_CAPACITY],
    mark_head: usize,
    mark_len: usize,
    /// Capture generation: presents queued under an earlier capture are ignored.
    capture: u64,
}

impl Recorder {
    fn new(capture: u64) -> Self {
        Self { ring: Ring::new(RING_CAPACITY), marks: [Mark::default(); MARK_CAPACITY], mark_head: 0, mark_len: 0, capture }
    }
    fn restart(&mut self, capture: u64) { self.ring.clear(); self.mark_len = 0; self.mark_head = 0; self.capture = capture; }
    /// Store one present if it belongs to the current capture. Returns whether it was stored.
    fn accept(&mut self, capture: u64, presented: f64, commit: f64, handled: f64) -> bool {
        if capture != self.capture { return false; }
        // The newest frame mark at or before the commit belongs to this present.
        let mark = (0..self.mark_len).rev().map(|i| self.marks[(self.mark_head + i) % MARK_CAPACITY])
            .find(|m| m.at <= commit).unwrap_or_default();
        self.ring.push(Sample { presented, commit, handled, demand: mark.demand, position: mark.position });
        true
    }
}

static CAPTURE: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
static ENABLED: AtomicBool = AtomicBool::new(false);
static FORCED_DEMAND: AtomicBool = AtomicBool::new(false);
static RECORDER: Mutex<Option<Recorder>> = Mutex::new(None);

/// Host seconds on the clock the present observer uses. `0.0` where there is no observer.
pub fn host_time() -> f64 {
    #[cfg(target_os = "macos")]
    { gpui_apple::host_time() }
    #[cfg(not(target_os = "macos"))]
    { 0. }
}

/// Called once per rendered frame. One relaxed load when recording is off.
#[inline]
pub fn note_frame(demand: bool, position: f64) {
    if !ENABLED.load(Ordering::Relaxed) { return; }
    let demand = demand || FORCED_DEMAND.load(Ordering::Relaxed);
    let at = host_time();
    if let Ok(mut guard) = RECORDER.lock() {
        if let Some(rec) = guard.as_mut() {
            let index = (rec.mark_head + rec.mark_len) % MARK_CAPACITY;
            rec.marks[index] = Mark { at, demand, position: position as f32 };
            if rec.mark_len == MARK_CAPACITY { rec.mark_head = (rec.mark_head + 1) % MARK_CAPACITY; } else { rec.mark_len += 1; }
        }
    }
}

/// A test animation source demanding frames (counts as demand for drop accounting).
pub fn force_demand(on: bool) { FORCED_DEMAND.store(on, Ordering::Relaxed); }

fn record_present(capture: u64, presented: f64, commit: f64, handled: f64) {
    if let Ok(mut guard) = RECORDER.lock() {
        if let Some(rec) = guard.as_mut() { rec.accept(capture, presented, commit, handled); }
    }
}

/// Start recording presents. Errors where the platform has no present observer.
pub fn start() -> anyhow::Result<()> {
    #[cfg(target_os = "macos")]
    {
        let mut guard = RECORDER.lock().map_err(|_| anyhow::anyhow!("frame log poisoned"))?;
        let capture = CAPTURE.fetch_add(1, Ordering::SeqCst) + 1;
        match guard.as_mut() {
            Some(rec) => rec.restart(capture),
            None => *guard = Some(Recorder::new(capture)),
        }
        drop(guard);
        ENABLED.store(true, Ordering::SeqCst);
        gpui_apple::set_present_observer(Some(std::sync::Arc::new(move |sample: gpui_apple::PresentSample| {
            record_present(capture, sample.presented_time, sample.commit_time, sample.handler_time);
        })));
        Ok(())
    }
    #[cfg(not(target_os = "macos"))]
    anyhow::bail!("no present observer on this platform")
}

/// Stop recording and return what was captured.
pub fn stop() -> Vec<Sample> {
    #[cfg(target_os = "macos")]
    gpui_apple::set_present_observer(None);
    ENABLED.store(false, Ordering::SeqCst);
    FORCED_DEMAND.store(false, Ordering::SeqCst);
    RECORDER.lock().ok().and_then(|g| g.as_ref().map(|r| r.ring.to_vec())).unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    fn run(hz: f64, count: usize, remove: &[usize], demand: bool) -> Vec<Sample> {
        (0..count).filter(|i| !remove.contains(i)).map(|i| Sample {
            presented: 1000. + i as f64 / hz, commit: 999.99 + i as f64 / hz, handled: 1000.001 + i as f64 / hz, demand, position: 0.,
        }).collect()
    }

    #[test]
    fn rate_within_a_tenth_of_a_percent_at_60_and_120() {
        for hz in [60., 120.] {
            let st = stats(&run(hz, 3601, &[], true), None);
            assert!((st.fps.unwrap() - hz).abs() / hz < 0.001, "{hz}: {:?}", st.fps);
            assert_eq!(st.dropped, Some(0));
            assert!((st.p50_ms.unwrap() - 1000. / hz).abs() < 0.01);
        }
    }

    #[test]
    fn one_removed_sample_is_one_drop() {
        assert_eq!(stats(&run(60., 600, &[300], true), None).dropped, Some(1));
        assert_eq!(stats(&run(60., 600, &[300, 301], true), None).dropped, Some(2));
    }

    #[test]
    fn a_gap_without_demand_is_not_a_drop() {
        assert_eq!(stats(&run(60., 600, &[300, 301, 302], false), None).dropped, Some(0));
        // Demand ending before the gap: the frame after the gap has none.
        let mut samples = run(60., 600, &[300, 301], true);
        let after = samples.iter().position(|s| s.presented > 1000. + 300. / 60.).unwrap();
        samples[after].demand = false;
        assert_eq!(stats(&samples, None).dropped, Some(0));
    }

    #[test]
    fn a_zero_presented_time_is_a_drop() {
        let mut samples = run(60., 600, &[], true);
        samples[200].presented = 0.;
        let st = stats(&samples, None);
        // The skipped drawable is one drop; the gap it leaves is not counted twice.
        assert_eq!(st.dropped, Some(1));
        assert_eq!(st.skipped, 1);
        // Even with no demand a skipped drawable counts.
        samples.iter_mut().for_each(|s| s.demand = false);
        assert_eq!(stats(&samples, None).dropped, Some(1));
    }

    #[test]
    fn ring_never_allocates_after_construction() {
        let mut ring = Ring::new(64);
        let (ptr, capacity) = (ring.slots.as_ptr(), ring.slots.len());
        for i in 0..64 * 5 + 3 { ring.push(Sample { presented: 1. + i as f64, ..Default::default() }); }
        assert_eq!((ring.slots.as_ptr(), ring.slots.len(), ring.len()), (ptr, capacity, 64));
        // Oldest dropped, newest kept, in order.
        let kept: Vec<f64> = ring.iter().map(|s| s.presented).collect();
        assert_eq!(kept.first(), Some(&(1. + (64 * 5 + 3 - 64) as f64)));
        assert!(kept.windows(2).all(|w| w[1] > w[0]));
    }

    #[test]
    fn hidden_and_empty_report_null_with_a_reason_never_zero() {
        let hidden = report(&[], None, true);
        assert!(hidden["fps"].is_null() && hidden["frameTimeMs"].is_null() && hidden["dropped"].is_null());
        assert_eq!(hidden["reason"], HIDDEN_REASON);
        let one = report(&run(60., 1, &[], true), None, false);
        assert!(one["fps"].is_null() && one["dropped"].is_null() && one["presentedSamples"] == 1, "{one}");
        let visible_empty = report(&[], None, false);
        assert!(visible_empty["fps"].is_null() && visible_empty["dropped"].is_null());
        assert_eq!(visible_empty["presentedSamples"], 0);
        let good = report(&run(60., 120, &[], true), None, false);
        assert!(good["reason"].is_null() && good["fps"].as_f64().unwrap() > 59.9);
    }

    #[test]
    fn all_zero_presented_times_fall_back_to_the_handler_clock_and_say_so() {
        // A display that never fills presentedTime: the 60 Hz handler cadence is the rate.
        let mut samples = run(60., 600, &[], true);
        samples.iter_mut().for_each(|s| s.presented = 0.);
        let fallback = report(&samples, None, false);
        assert_eq!(fallback["timeSource"], SOURCE_HANDLER);
        assert!((fallback["fps"].as_f64().unwrap() - 60.).abs() < 0.06, "{fallback}");
        assert_eq!(fallback["dropped"], 0);
        // One zero among real times is a skipped drawable, not a missing clock.
        let mut mixed = run(60., 600, &[], true);
        mixed[100].presented = 0.;
        let mixed = report(&mixed, None, false);
        assert_eq!(mixed["timeSource"], SOURCE_PRESENTED);
        assert_eq!(mixed["skipped"], 1);
        // Too few samples to conclude the clock is missing.
        let few: Vec<Sample> = run(60., 5, &[], true).into_iter().map(|s| Sample { presented: 0., ..s }).collect();
        assert_eq!(report(&few, None, false)["timeSource"], SOURCE_PRESENTED);
    }

    #[test]
    fn timestamp_jitter_is_not_a_drop_but_a_lost_frame_next_to_it_is() {
        // Late then early callback: 27.9 ms then 5.5 ms around a 16.67 ms period.
        let mut times = vec![1000.];
        for gap in [16.67, 16.67, 27.9, 5.5, 16.67, 16.67] { times.push(times.last().unwrap() + gap / 1000.); }
        let samples: Vec<Sample> = times.iter().map(|&t| Sample { presented: t, commit: t - 0.01, handled: t, demand: true, position: 0. }).collect();
        assert_eq!(stats(&samples, Some(1. / 60.)).dropped, Some(0));
        // Repaid over three frames: 29 ms, 9 ms, 9 ms around a 16.67 ms period.
        let mut times = vec![1000.];
        for gap in [16.67, 29.0, 9.0, 9.0, 16.67, 16.67] { times.push(times.last().unwrap() + gap / 1000.); }
        let samples: Vec<Sample> = times.iter().map(|&t| Sample { presented: t, commit: t - 0.01, handled: t, demand: true, position: 0. }).collect();
        assert_eq!(stats(&samples, Some(1. / 60.)).dropped, Some(0));
        // The same shape with a real loss in the middle: 33.3 ms then 16.67 ms.
        let mut times = vec![1000.];
        for gap in [16.67, 33.34, 16.67, 27.9, 5.5, 16.67] { times.push(times.last().unwrap() + gap / 1000.); }
        let samples: Vec<Sample> = times.iter().map(|&t| Sample { presented: t, commit: t - 0.01, handled: t, demand: true, position: 0. }).collect();
        assert_eq!(stats(&samples, Some(1. / 60.)).dropped, Some(1));
    }

    #[test]
    fn presents_from_an_earlier_capture_are_ignored() {
        let mut rec = Recorder::new(1);
        assert!(rec.accept(1, 10., 9.99, 10.));
        rec.restart(2);
        // An old drawable's callback arrives after stop/start.
        assert!(!rec.accept(1, 11., 10.99, 11.));
        assert_eq!(rec.ring.len(), 0);
        assert!(rec.accept(2, 12., 11.99, 12.));
        assert_eq!(rec.ring.len(), 1);
    }

    #[test]
    fn a_stall_every_sixtieth_frame_is_counted_per_second() {
        // 25 ms stall = frame 60 arrives two periods late, shifting later frames.
        let mut t = 1000.; let mut samples = vec![];
        for i in 0..600 { t += if i % 60 == 59 { 2. / 60. } else { 1. / 60. }; samples.push(Sample { presented: t, commit: t - 0.01, handled: t, demand: true, position: 0. }); }
        let st = stats(&samples, Some(1. / 60.));
        assert!(st.dropped.unwrap() >= 10, "{:?}", st);
    }
}

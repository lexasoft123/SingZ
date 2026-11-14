//! Hidden, muted native transport legs (Q-03): Play pressed early and twice,
//! a loop ahead of the playhead, a quarter-second loop, playing out then Play
//! again, a scrub out of the last seconds, and streamed-lane starvation.
//! Every press is a real click or key through the window; helper status is the
//! authority for loop and feeder counters.
use super::*;
use crate::ui_training_run::draw;
use crate::ui_transport_timing::{key, press, shot};
use std::{path::PathBuf, time::Duration};

fn project_identity(path: PathBuf) -> std::io::Result<PathBuf> {
    path.canonicalize()
}

#[cfg(test)]
mod path_tests {
    use super::project_identity;

    #[test]
    fn driver_identity_matches_loaded_project() {
        let dir = std::env::current_dir().unwrap();
        let raw = dir.join("src").join("..");
        let loaded = dir.canonicalize().unwrap();
        assert_eq!(project_identity(raw.clone()).unwrap(), loaded);
        assert_ne!(raw, loaded, "the uncanonicalized driver path is the negative control");
        #[cfg(windows)]
        assert!(loaded.to_string_lossy().starts_with(r"\\?\"));
    }
}

/// Judges 10 ms samples `(position, native loop_count)` of the quarter-second
/// loop. Wraps are accounted against the native lap counter: every backward
/// fold of the position must be matched by a counted lap, in either order, and
/// the two may disagree by one wrap for at most 100 ms (the status that carries
/// the count and the projected position do not arrive together). Inside a lap
/// the position may not step back by more than 5 ms, nor forward by more than
/// half a loop, so a start-to-tail-to-start glitch cannot hide in the interval.
///
/// The first sample can land inside such a disagreement that began before it:
/// the count already ticked while the position is still in the last 100 ms of
/// the loop (a fold is owed), or the position already folded while it is still
/// in the first 100 ms (a lap is owed). Those are the only extra baselines the
/// judge entertains, each gated by where the first sample sits and each held to
/// the same 100 ms and one-wrap limits as any later disagreement; a baseline
/// that breaks a rule is dropped, and the judge fails when none is left.
pub(crate) struct QuarterLoopJudge { start: f64, end: f64, prior: (f64, u64), baselines: Vec<Baseline> }
#[derive(Clone, Copy)]
struct Baseline { skew: i64, disagreeing: u32 }
impl QuarterLoopJudge {
    pub(crate) fn new(start: f64, end: f64, first: (f64, u64)) -> Self {
        let mut baselines = vec![Baseline { skew: 0, disagreeing: 0 }];
        if first.0 >= end - 0.1 { baselines.push(Baseline { skew: 1, disagreeing: 0 }); }
        if first.0 <= start + 0.1 { baselines.push(Baseline { skew: -1, disagreeing: 0 }); }
        Self { start, end, prior: first, baselines }
    }
    /// True when some live baseline has every counted lap matched by a fold and vice versa.
    pub(crate) fn settled(&self) -> bool { self.baselines.iter().any(|baseline| baseline.skew == 0) }
    pub(crate) fn step(&mut self, now: (f64, u64)) -> Result<(), String> {
        let half = (self.end - self.start) / 2.;
        let (before, laps_before) = self.prior;
        let (after, laps_after) = now;
        if after < self.start - 0.08 || after > self.end + 0.08 {
            return Err(format!("escaped the loop interval: {after} not in [{}, {}]", self.start, self.end));
        }
        let laps = match laps_after.checked_sub(laps_before) {
            Some(laps) if laps <= 1 => laps as i64,
            _ => return Err(format!("native loop count went {laps_before} -> {laps_after}")),
        };
        let folded = after < before - 0.005;
        if !folded && after - before > half {
            return Err(format!("jumped forward by more than half a loop: {before} -> {after}"));
        }
        if folded && after > self.start + half {
            return Err(format!("fold did not return to the loop start: {before} -> {after}"));
        }
        self.prior = now;
        let mut why = String::new();
        self.baselines.retain_mut(|baseline| {
            baseline.skew += laps - folded as i64;
            baseline.disagreeing = if baseline.skew == 0 { 0 } else { baseline.disagreeing + 1 };
            let keep = baseline.skew.abs() <= 1 && baseline.disagreeing <= 10;
            if !keep { why = format!("loop folds and native laps disagree (skew {}, {} samples): at {before} -> {after}", baseline.skew, baseline.disagreeing); }
            keep
        });
        if self.baselines.is_empty() { Err(why) } else { Ok(()) }
    }
}

pub fn run(handle: AnyWindowHandle, view: Entity<Player>, out: PathBuf, cx: &mut App) {
    cx.spawn(async move |cx| {
        let result: anyhow::Result<()> = async {
            std::fs::create_dir_all(&out)?;
            let project = project_identity(PathBuf::from(std::env::var_os("SINGZ_GPUI_TEST_PROJECT").unwrap()))?;
            macro_rules! wait {($p:ident,$app:ident=>$test:expr)=>{{
                let deadline = Instant::now() + Duration::from_secs(25);
                loop {
                    cx.background_executor().timer(Duration::from_millis(20)).await;
                    if handle.update(cx, |_, _, $app| { let $p = view.read($app); $test })? { break; }
                    anyhow::ensure!(Instant::now() < deadline, "Transport legs timeout: {}", stringify!($test));
                }
            }};}
            macro_rules! click_play {() => { handle.update(cx, |_, w, cx| press(&view, w, cx, "transport-play"))??; };}
            macro_rules! snap {($name:expr) => { handle.update(cx, |_, w, cx| shot(&view, w, cx, &out, $name))??; };}
            macro_rules! streaming {() => {
                handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().observed_lane_streaming())?
            };}
            macro_rules! paused {() => { wait!(p, cx => !p.playing && p.last_playback_status.as_ref().is_some_and(|s| !s.playing)); };}
            macro_rules! no_starvation {($before:expr, $after:expr, $what:expr) => {
                for lane in &$before {
                    let later = $after.iter().find(|item| item.id == lane.id)
                        .ok_or_else(|| anyhow::anyhow!("{} lane disappeared: {}", $what, lane.id))?;
                    anyhow::ensure!(later.starved_blocks == lane.starved_blocks,
                        "{} starved {}: {:?} -> {:?}", $what, lane.id, lane.starved_blocks, later.starved_blocks);
                }
            };}

            handle.update(cx, |_, w, _| w.resize(size(px(1280.), px(800.))))?;
            let deadline = Instant::now() + Duration::from_secs(3);
            loop {
                cx.background_executor().timer(Duration::from_millis(10)).await;
                let actual = handle.update(cx, |_, w, cx| { draw(w, cx); (f32::from(w.viewport_size().width), f32::from(w.viewport_size().height)) })?;
                if actual == (1280., 800.) { break; }
                anyhow::ensure!(Instant::now() < deadline, "Native viewport did not settle: {actual:?}");
            }

            // 1. Early Play. A fresh app is on the Library screen with no project, where the
            // Player's input route does not exist, so a first song is loaded and Space is
            // proven to drive it. While the next song then opens, the Player screen, its
            // transport and its Space route are live, and the loading refusal is reachable.
            let warmup = project_identity(PathBuf::from(std::env::var_os("SINGZ_GPUI_LEGS_WARMUP_PROJECT").unwrap()))?;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.open_project(warmup.clone(), cx)))?;
            wait!(p, cx => !p.loading && p.project.as_ref().is_some_and(|p| p.dir == warmup));
            wait!(p, cx => p.release_startup_ready && p.model_auto_checked);
            // The first loaded project of a fresh profile opens What's New, whose
            // backdrop swallows clicks and keys: close it as a singer would.
            if handle.update(cx, |_, _, cx| view.read(cx).whats_new.read(cx).is_open())? {
                handle.update(cx, |_, _, cx| { let notes = view.read(cx).whats_new.clone(); notes.update(cx, |notes, cx| notes.close(cx)); })?;
                wait!(p, cx => !p.whats_new.read(cx).is_open());
            }
            wait!(p, cx => p.analysis_progress.is_none() && !p.saving && !p.beat_auto_save);
            macro_rules! space {() => {
                handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                    let focus = view.read(cx).focus_handle.clone();
                    focus.focus(w, cx);
                    draw(w, cx);
                    anyhow::ensure!(focus.is_focused(w), "Space has no actual app-local player focus");
                    key(w, cx, "space");
                    Ok(())
                })??;
            };}
            // The route control: on the loaded song, real Space plays and pauses it.
            space!();
            wait!(p, cx => p.playing && p.last_playback_status.as_ref().is_some_and(|s| s.playing));
            space!();
            paused!();
            // Now the next song opens; a real click and a real Space land while it loads.
            let refusals_before = handle.update(cx, |_, _, cx| view.read(cx).loading_play_refusals)?;
            handle.update(cx, |_, w, cx| -> anyhow::Result<()> {
                view.update(cx, |p, cx| p.open_project(project.clone(), cx));
                let p = view.read(cx);
                anyhow::ensure!(p.loading && p.screen == Screen::Player && p.backend.is_some() && p.notice.is_none() && p.project.is_some(),
                    "The Player input route was not live during the open: loading={} screen={:?} notice={:?}", p.loading, p.screen == Screen::Player, p.notice);
                let focus = view.read(cx).focus_handle.clone();
                focus.focus(w, cx);
                draw(w, cx);
                anyhow::ensure!(focus.is_focused(w), "Space has no actual app-local player focus during the open");
                key(w, cx, "space");
                // A key is handled synchronously: its refusal must already be counted.
                anyhow::ensure!(view.read(cx).loading_play_refusals == refusals_before + 1,
                    "Space during the open did not reach the loading refusal: {} -> {}", refusals_before, view.read(cx).loading_play_refusals);
                // A click's Play event is delivered once this update ends.
                press(&view, w, cx, "transport-play")?;
                Ok(())
            })??;
            // The click's Play event, if the control let it through, is delivered by now.
            let refusals = handle.update(cx, |_, _, cx| -> anyhow::Result<u64> {
                let p = view.read(cx);
                anyhow::ensure!(!p.playing && p.transport_flight.native_play.is_none(), "A Play issued while loading was not refused: playing={}", p.playing);
                Ok(p.loading_play_refusals - refusals_before)
            })??;
            // Space reached native_transport's loading guard (counted synchronously above). The
            // click either reached it too or was refused earlier by the disabled control.
            anyhow::ensure!(refusals == 1 || refusals == 2, "Unexpected number of loading refusals: {refusals}");
            let click_reached_guard = refusals == 2;
            wait!(p, cx => !p.loading && p.project.as_ref().is_some_and(|p| p.dir == project));
            cx.background_executor().timer(Duration::from_millis(400)).await;
            handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                let p = view.read(cx);
                anyhow::ensure!(!p.playing && p.transport_flight.native_play.is_none(), "Play pressed while loading started the song once it loaded");
                let status = p.last_playback_status.as_ref().ok_or_else(|| anyhow::anyhow!("No helper status after the song loaded"))?;
                anyhow::ensure!(!status.playing && !status.counting_in && !matches!(status.transport_state, 1 | 2), "The helper is not stopped after the refused early press: {:?}", status.transport_state);
                Ok(())
            })??;
            // Now the singer's early Play: as soon as the song is on screen, while
            // analysis is still settling, with no wait for full readiness.
            click_play!();
            wait!(p, cx => p.playing && p.last_playback_status.as_ref().is_some_and(|s| s.playing));
            let graph = handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().graph_generation)?;
            snap!("early-play");

            // 2. Streamed lanes report their feeder counters, and steady playback never starves.
            let first = streaming!();
            anyhow::ensure!(first.len() >= 2 && first.iter().all(|lane| lane.streamed == Some(true) && lane.starved_blocks.is_some() && lane.staged_jumps.is_some()),
                "GPUI native prepare did not expose streamed lane counters: {first:?}");
            cx.background_executor().timer(Duration::from_millis(700)).await;
            let later = streaming!();
            no_starvation!(first, later, "Steady playback");
            anyhow::ensure!(handle.update(cx, |_, _, cx| view.read(cx).last_playback_status.as_ref().unwrap().graph_generation)? == graph,
                "Early Play rebuilt the native graph");
            click_play!(); paused!();

            // 3. A loop ahead of the playhead, armed while playing (Electron
            // loop-ahead-e2e): the bar plays on into it, never jumps into its tail.
            click_play!();
            wait!(p, cx => p.playing && !p.transport_flight.counting_in && p.last_playback_status.as_ref().is_some_and(|s| s.playing) && p.playhead.position() > 0.1);
            let start = handle.update(cx, |_, _, cx| view.read(cx).playhead.position())? + 3.;
            let end = start + 1.;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: Some((start, end)), looping: true }, cx)))?;
            wait!(p, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_some_and(|(a, b)| (a - start).abs() < 0.002 && (b - end).abs() < 0.002)));
            let ahead_deadline = Instant::now() + Duration::from_secs(8);
            let mut prior = handle.update(cx, |_, _, cx| view.read(cx).playhead.position())?;
            let mut short_of_start = false;
            anyhow::ensure!(prior < start - 0.5, "Ahead loop armed too late to judge: playhead {prior} start {start}");
            loop {
                cx.background_executor().timer(Duration::from_millis(25)).await;
                let (position, laps) = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.playhead.position(), p.playhead.loop_count()) })?;
                if laps > 0 { break; }
                anyhow::ensure!(position + 0.005 >= prior, "Ahead loop playhead stepped backwards before its wrap: {prior} -> {position}");
                anyhow::ensure!(position <= prior + 0.35, "Ahead loop playhead jumped into the loop before reaching its start: {prior} -> {position} (start {start})");
                if position < start - 0.2 { short_of_start = true; }
                prior = position;
                anyhow::ensure!(Instant::now() < ahead_deadline, "Loop ahead never wrapped at its end");
            }
            anyhow::ensure!(short_of_start, "Ahead loop playhead was never observed short of the loop start");
            click_play!(); paused!();
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: None, looping: false }, cx)))?;
            wait!(p, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_none()));

            // 4. Play out to the end, then Play again; scrub out of the last seconds.
            let duration = handle.update(cx, |_, _, cx| view.read(cx).duration)?;
            handle.update(cx, |_, _, cx| { let _ = view.update(cx, |p, cx| { p.playhead.seek(duration - 1.); p.seek_native(cx); }); })?;
            wait!(p, cx => p.playhead.pending_seek().is_none() && (p.playhead.position() - (duration - 1.)).abs() < 0.1);
            click_play!();
            let end_deadline = Instant::now() + Duration::from_secs(5);
            loop {
                cx.background_executor().timer(Duration::from_millis(20)).await;
                let ended = handle.update(cx, |_, _, cx| { let p = view.read(cx); !p.playing && p.last_playback_status.as_ref().is_some_and(|s| !s.playing && s.transport_state == 4 && s.position >= s.duration - 0.2) })?;
                if ended { break; }
                anyhow::ensure!(Instant::now() < end_deadline, "Native playback did not complete at the song end");
            }
            snap!("played-out");
            click_play!();
            wait!(p, cx => p.playing && p.last_playback_status.as_ref().is_some_and(|s| s.playing && s.position < duration - 0.5));
            let restarted = streaming!();
            cx.background_executor().timer(Duration::from_millis(500)).await;
            let restarted_after = streaming!();
            no_starvation!(restarted, restarted_after, "Play after the end");
            click_play!(); paused!();

            // 5. Play twice in a row: the button and the transport stay coherent.
            click_play!();
            click_play!();
            cx.background_executor().timer(Duration::from_millis(250)).await;
            handle.update(cx, |_, _, cx| -> anyhow::Result<()> {
                let p = view.read(cx);
                anyhow::ensure!(p.playing == p.last_playback_status.as_ref().is_some_and(|s| s.playing), "Two fast Play presses desynchronized UI and native transport");
                Ok(())
            })??;
            if handle.update(cx, |_, _, cx| view.read(cx).playing)? { click_play!(); paused!(); }

            // 6. A scrub back out of the last seconds, while playing: the feeder answers it and does not starve.
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.playhead.seek(duration - 2.); p.seek_native(cx); }))?;
            wait!(p, cx => p.playhead.pending_seek().is_none() && (p.playhead.position() - (duration - 2.)).abs() < 0.1);
            click_play!();
            wait!(p, cx => p.playing);
            let before_scrub = streaming!();
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| { p.playhead.seek(4.); p.seek_native(cx); }))?;
            wait!(p, cx => p.playing && p.playhead.pending_seek().is_none() && (p.playhead.position() - 4.).abs() < 0.15 && p.last_playback_status.as_ref().is_some_and(|s| s.playing));
            cx.background_executor().timer(Duration::from_millis(500)).await;
            let after_scrub = streaming!();
            for lane in &before_scrub {
                let later = after_scrub.iter().find(|item| item.id == lane.id).ok_or_else(|| anyhow::anyhow!("Scrub lane disappeared: {}", lane.id))?;
                anyhow::ensure!(later.staged_jumps.zip(lane.staged_jumps).is_some_and(|(new, old)| new > old),
                    "The feeder did not answer the tail scrub for {}: {:?} -> {:?}", lane.id, lane.staged_jumps, later.staged_jumps);
            }
            no_starvation!(before_scrub, after_scrub, "Tail scrub");
            click_play!(); paused!();

            // 7. A quarter-second loop wraps three times, judged against the native lap count.
            // The helper refuses sub-second loops while time/pitch processing is active
            // (it cannot prime in time), so the fixture's transpose is cleared first.
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_transpose(0, cx)))?;
            wait!(p, cx => p.transport_flight.native_rate_pending.is_none() && p.last_playback_status.as_ref().is_some_and(|s| s.transpose == 0));
            let quarter_start = handle.update(cx, |_, _, cx| view.read(cx).playhead.position())? + 0.2;
            let quarter_end = quarter_start + 0.25;
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: Some((quarter_start, quarter_end)), looping: true }, cx)))?;
            wait!(p, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_some_and(|(a, b)| (a - quarter_start).abs() < 0.002 && (b - quarter_end).abs() < 0.002)));
            click_play!();
            // Status arrives at a few Hz, so the first playing status can already hold a
            // whole 0.25 s lap of audio: judge from the moment the transport is reported
            // playing, and keep the strict step rules for the running loop.
            wait!(p, cx => p.playing && p.last_playback_status.as_ref().is_some_and(|s| s.playing) && p.playhead.pending_seek().is_none());
            let first = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.playhead.position(), p.playhead.loop_count()) })?;
            let mut judge = QuarterLoopJudge::new(quarter_start, quarter_end, first);
            let (quarter_deadline, mut latest, began) = (Instant::now() + Duration::from_secs(4), first, Instant::now());
            let mut trace = vec![serde_json::json!([0, first.0, first.1])];
            let outcome = loop {
                if latest.1 >= first.1 + 3 && judge.settled() { break Ok(()); }
                cx.background_executor().timer(Duration::from_millis(10)).await;
                latest = handle.update(cx, |_, _, cx| { let p = view.read(cx); (p.playhead.position(), p.playhead.loop_count()) })?;
                trace.push(serde_json::json!([began.elapsed().as_millis() as u64, latest.0, latest.1]));
                if let Err(why) = judge.step(latest) { break Err(anyhow::anyhow!("Quarter-second loop playhead {why}")); }
                if Instant::now() >= quarter_deadline { break Err(anyhow::anyhow!("Quarter-second loop did not wrap three times")); }
            };
            std::fs::write(out.join("quarter-loop-trace.json"), serde_json::to_vec(&serde_json::json!({"start": quarter_start, "end": quarter_end, "samples": trace}))?)?;
            outcome?;
            click_play!(); paused!();
            handle.update(cx, |_, _, cx| view.update(cx, |p, cx| p.request_region(crate::region_gesture::Target { selection: None, looping: false }, cx)))?;
            wait!(p, cx => !p.region_busy() && p.last_playback_status.as_ref().is_some_and(|s| s.loop_range.is_none()));

            std::fs::write(out.join("result.json"), serde_json::to_vec_pretty(&serde_json::json!({
                "hidden": true, "muted": true, "pressedWhileLoadingRefusedCoherently": true, "spaceReachedLoadingRefusal": true, "clickReachedLoadingRefusal": click_reached_guard, "spaceRouteLiveBeforeOpen": true,
                "earlyPlayRealControl": true, "doublePlayStateCoherent": true, "loopAheadReachedStart": true,
                "quarterSecondLoopWrapped": true, "playAfterEnd": true, "scrubFromTail": true,
                "streamedLaneCounters": true, "steadyStarvedBlocksZero": true, "liveFps": "unmeasured"}))?)?;
            Ok(())
        }.await;
        if let Err(error) = result {
            eprintln!("NATIVE_TRANSPORT_LEGS failed: {error:#}");
            let _ = handle.update(cx, |_, w, cx| shot(&view, w, cx, &out, "failure"));
            let _ = std::fs::write(out.join("failure.txt"), format!("{error:#}"));
        }
        let _ = cx.update(|cx| cx.quit());
    }).detach();
}

#[cfg(test)]
mod tests {
    use super::QuarterLoopJudge;
    const START: f64 = 10.2;
    const END: f64 = 10.45;
    fn run(samples: &[(f64, u64)]) -> Result<bool, String> {
        let mut judge = QuarterLoopJudge::new(START, END, samples[0]);
        for sample in &samples[1..] { judge.step(*sample)?; }
        Ok(judge.settled())
    }
    /// The predicate this replaces: any backward step below the end passed, with no forward bound.
    fn old_predicate(samples: &[(f64, u64)]) -> bool {
        samples.windows(2).all(|pair| pair[1].0 + 0.005 >= pair[0].0 || pair[1].0 < END)
    }
    /// 10 ms forward steps from `from`, all at one lap count.
    fn steps(from: f64, count: u64, n: usize) -> Vec<(f64, u64)> {
        (1..=n).map(|step| (from + 0.01 * step as f64, count)).collect()
    }
    #[test]
    fn a_clean_run_with_counted_wraps_passes() {
        let mut samples = vec![];
        for lap in 0..3u64 { for step in 0..25 { samples.push((START + 0.01 * step as f64, lap)); } }
        samples.push((START, 3));
        assert_eq!(run(&samples), Ok(true));
    }
    #[test]
    fn a_count_and_a_fold_may_arrive_in_either_order_within_one_lap() {
        assert_eq!(run(&[(START + 0.24, 0), (START + 0.25, 1), (START + 0.27, 1), (START + 0.02, 1)]), Ok(true), "count first");
        assert_eq!(run(&[(START + 0.24, 0), (START + 0.01, 0), (START + 0.02, 1)]), Ok(true), "fold first");
        assert_eq!(run(&[(START + 0.24, 0), (START + 0.25, 1)]), Ok(false), "count first, fold still owed");
    }
    #[test]
    fn a_disagreement_already_outstanding_at_the_first_sample_is_synchronised() {
        // The count ticked before the first sample; the fold is still owed.
        let mut count_ahead = vec![(START + 0.24, 1), (START, 1)];
        count_ahead.extend(steps(START, 1, 20));
        assert_eq!(run(&count_ahead), Ok(true), "count already ahead, clean suffix");
        // The fold happened before the first sample; the count is still owed.
        let mut fold_ahead = vec![(START + 0.01, 0), (START + 0.02, 1)];
        fold_ahead.extend(steps(START + 0.02, 1, 20));
        assert_eq!(run(&fold_ahead), Ok(true), "fold already done, clean suffix");
        // ... and a later lap still has to be matched by its own fold.
        let mut then_a_lap = count_ahead.clone();
        then_a_lap.push((START + 0.26, 2));
        then_a_lap.push((START + 0.01, 2));
        assert_eq!(run(&then_a_lap), Ok(true));
    }
    #[test]
    fn an_initial_disagreement_is_held_to_the_same_limits_as_a_later_one() {
        // A fold owed from a first sample mid-lap is not an initial disagreement.
        let mut mid_lap_fold = vec![(START + 0.12, 0), (START + 0.2, 0), (START + 0.22, 0), (START + 0.03, 0)];
        mid_lap_fold.extend(steps(START + 0.03, 0, 12));
        assert!(run(&mid_lap_fold).unwrap_err().contains("disagree"));
        // A lap owed from a first sample mid-lap likewise.
        let mut mid_lap_count = vec![(START + 0.12, 0), (START + 0.13, 1)];
        mid_lap_count.extend(steps(START + 0.13, 1, 12));
        assert!(run(&mid_lap_count).unwrap_err().contains("disagree"));
    }
    #[test]
    fn the_start_to_tail_to_start_glitch_is_rejected_where_the_old_predicate_passed_it() {
        let forward = [(START + 0.04, 0), (START + 0.22, 0), (START + 0.05, 0)];
        assert!(old_predicate(&forward), "negative control: the old predicate accepted the glitch");
        assert!(run(&forward).unwrap_err().contains("forward"));
        // Tail to start with no counted lap, and the position then keeps playing from the start.
        let mut isolated = vec![(START + 0.04, 0), (START + 0.1, 0), (START + 0.2, 0), (START + 0.22, 0), (START + 0.03, 0)];
        isolated.extend(steps(START + 0.03, 0, 12));
        assert!(old_predicate(&isolated), "negative control: the old predicate accepted the isolated fold");
        assert!(run(&isolated).unwrap_err().contains("disagree"));
    }
    #[test]
    fn bad_laps_and_escapes_are_rejected() {
        assert!(run(&[(START + 0.01, 3), (START + 0.02, 2)]).is_err(), "a lap count going backwards");
        assert!(run(&[(START + 0.01, 0), (START + 0.1, 5)]).is_err(), "a skipped lap count");
        assert!(run(&[(START + 0.01, 0), (START + 0.1, 2)]).is_err(), "two laps at once");
        assert!(run(&[(START + 0.24, 0), (START + 0.2, 1)]).is_err(), "a counted wrap and a fold that lands in the tail");
        assert_eq!(run(&[(START + 0.1, 0), (START + 0.096, 0)]), Ok(true), "5 ms backward tolerance inside a lap");
        assert!(run(&[(START + 0.1, 0), (END + 0.2, 0)]).is_err(), "escaping the interval");
    }
}

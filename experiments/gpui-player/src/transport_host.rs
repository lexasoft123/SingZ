//! Requested tempo stays responsive; persistence follows accepted native audio.
use super::*;

pub(super) struct CountInCache {
    graph: u64,
    landing: u64,
    rate: u32,
    bars: u32,
    grid: Option<Rc<beat::Beats>>,
    offsets: Vec<f64>,
}

fn normalized_rate(value: f32) -> Option<f32> {
    value
        .is_finite()
        .then(|| (value.clamp(0.5, 1.5) * 10000.).round() / 10000.)
}
impl Player {
    pub(super) fn rate_busy(&self) -> bool {
        self.native_rate_pending.is_some() || self.native_rate_queued.is_some() || self.native_rate_deferred.is_some()
    }
    pub(super) fn requested_rate(&self) -> (f32, i32) {
        self.native_rate_deferred.or(self.native_rate_queued)
            .or_else(|| {
                self.native_rate_pending
                    .map(|(_, _, rate, transpose)| (rate, transpose))
            })
            .unwrap_or((self.tempo, self.transpose))
    }
    pub(super) fn reset_transport_timing(&mut self, cx: &mut Context<Self>) {
        self.reset_region();
        self.transport.update(cx, |t, cx| t.reset_timing(cx));
        self.metronome_ui.update(cx, |s, cx| s.reset_taps(cx));
        self.native_rate_pending = None;
        self.native_rate_queued = None;
        self.native_rate_deferred = None;
        self.native_play_intent = None;
        self.monitor_actions.retain(|action| !matches!(action, DeferredAudio::Rate(_, _)));
        self.native_rate_save_requested = false;
        self.native_rate_navigation = None;
        self.native_rate_generation_floor = 0;
        self.timing_status = None;
        self.count_in_cache = None;
        self.analysis_progress = None;
        self.analysis_job = None;
    }
    pub(super) fn request_tempo(&mut self, value: f32, cx: &mut Context<Self>) {
        let Some(rate) = normalized_rate(value) else {
            return;
        };
        self.request_rate_pair(rate, self.requested_rate().1, cx);
    }
    pub(super) fn request_transpose(&mut self, value: i32, cx: &mut Context<Self>) {
        self.request_rate_pair(self.requested_rate().0, value.clamp(-12, 12), cx);
    }
    fn request_rate_pair(&mut self, rate: f32, transpose: i32, cx: &mut Context<Self>) {
        if self.backend.is_none()
            || self.project.is_none()
            || self.loading
            || self.saving
            || self.source_blocks_except_rate()
            || self.metronome_pending.is_some()
            || self.delete_pending.is_some()
            || self.project_delete.read(cx).is_open()
        {
            return;
        }
        if self.requested_rate() == (rate, transpose) {
            return;
        }
        if self.monitor_busy() || self.native_rate_deferred.is_some() {
            // One latest target is a barrier ahead of commands awaiting output
            // release. The accepted document remains unchanged until Rate.
            self.monitor_requested = false;
            self.monitor_actions.retain(|action| !matches!(action, DeferredAudio::Rate(_, _)));
            if self.monitor_actions.len() >= 128 {
                self.cancel_deferred_rate("Native handoff command queue is full".into(), cx);
                return;
            }
            self.native_rate_deferred = Some((rate, transpose));
            self.monitor_actions.push_front(DeferredAudio::Rate(rate, transpose));
        } else if self.native_rate_pending.is_some() {
            self.native_rate_queued = Some((rate, transpose));
        } else {
            self.dispatch_rate(rate, transpose, cx);
        }
        // As in production, the readout shows the requested target while the
        // native graph prepares. Accepted project state remains separate.
        let requested = self.requested_rate().0;
        self.transport
            .update(cx, |t, cx| t.set_tempo(requested, cx));
        cx.notify();
    }
    pub(super) fn dispatch_deferred_rate(&mut self, rate: f32, transpose: i32, cx: &mut Context<Self>) {
        if self.native_rate_deferred != Some((rate, transpose)) {return;}
        self.native_rate_deferred = None;
        if self.loading || self.project.is_none() || self.monitor_busy() {
            self.cancel_deferred_rate("Playback speed could not follow microphone cleanup".into(), cx);
            return;
        }
        self.dispatch_rate(rate, transpose, cx);
    }
    pub(super) fn cancel_deferred_rate(&mut self, error: String, cx: &mut Context<Self>) {
        self.cancel_deferred_region();
        self.native_rate_deferred = None;
        self.monitor_actions.retain(|action| !matches!(action, DeferredAudio::Rate(_, _)));
        let save = std::mem::take(&mut self.native_rate_save_requested);
        self.notice = Some(format!("{error}{}",if save {" Queued Save did not run."} else {""}));
        cx.notify();
    }
    fn dispatch_rate(&mut self, rate: f32, transpose: i32, cx: &mut Context<Self>) {
        self.native_rate_serial += 1;
        let serial = self.native_rate_serial;
        if let Some(backend) = &self.backend {
            match backend.rate(self.native_epoch, serial, rate, transpose) {
                Ok(()) => {
                    self.native_rate_pending = Some((self.native_epoch, serial, rate, transpose))
                }
                Err(error) => {
                    let save=std::mem::take(&mut self.native_rate_save_requested);
                    self.notice = Some(format!("Could not apply playback speed: {error}{}",if save {" Queued Save did not run."} else {""}));
                }
            }
        }
        cx.notify();
    }
    pub(super) fn rate_changed(
        &mut self,
        epoch: u64,
        serial: u64,
        result: Result<integration::Status, String>,
        cx: &mut Context<Self>,
    ) {
        if !self
            .native_rate_pending
            .is_some_and(|(e, s, _, _)| e == epoch && s == serial && e == self.native_epoch)
        {
            return;
        }
        self.native_rate_pending = None;
        match result {
            Ok(status) => {
                let queued = self.native_rate_queued.take();
                let changed = self.tempo != status.rate || self.transpose != status.transpose;
                self.tempo = status.rate;
                self.transpose = status.transpose;
                self.native_rate_generation_floor = self
                    .native_rate_generation_floor
                    .max(status.graph_generation);
                self.playback_status(epoch, status, cx);
                if changed {
                    self.edit_seq += 1;
                }
                if let Some((rate, transpose)) = queued {
                    if (rate, transpose) != (self.tempo, self.transpose) {
                        self.dispatch_rate(rate, transpose, cx);
                    }
                }
            }
            Err(error) => {
                self.native_rate_queued = None;
                let save = std::mem::take(&mut self.native_rate_save_requested);
                self.notice = Some(format!(
                    "Playback speed was not applied: {error}{}",
                    if save {
                        " Queued Save did not run."
                    } else {
                        ""
                    }
                ));
            }
        }
        cx.notify();
    }
    pub(super) fn rate_transport_failed(
        &mut self,
        epoch: u64,
        serial: u64,
        error: String,
        cx: &mut Context<Self>,
    ) {
        if !self
            .native_rate_pending
            .is_some_and(|(e, s, _, _)| e == epoch && s == serial && e == self.native_epoch)
        {
            return;
        }
        self.native_rate_pending = None;
        self.native_rate_queued = None;
        self.native_rate_deferred = None;
        self.native_play_intent = None;
        self.monitor_actions.retain(|action| !matches!(action, DeferredAudio::Rate(_, _)));
        let queued_save = std::mem::take(&mut self.native_rate_save_requested);
        self.analysis_progress = None;
        self.analysis_job = None;
        self.timing_status = None;
        self.playing = false;
        self.counting_in = false;
        self.count_in_anchor = None;
        self.native_anchor = None;
        self.pending_seek = None;
        self.tracks_audio_failed = true;
        self.notice = Some(format!(
            "{error}{} Retry the output route in Settings before resuming playback.",
            if queued_save { " Queued Save did not run." } else { "" }
        ));
        cx.notify();
    }
    pub(super) fn defer_rate_navigation(
        &mut self,
        path: std::path::PathBuf,
        source: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.rate_busy()
            || self.region_busy()
            || self.native_rate_save_requested
            || self.native_rate_navigation.is_some()
        {
            // New navigation supersedes older destinations still waiting for
            // microphone release; they must not overwrite this newer intent.
            if let Some(index)=self.monitor_actions.iter().position(|action|matches!(action,DeferredAudio::Open(_))) {
                // Commands after that Open belong to its arriving project.
                // Cancel the superseded segment rather than rebinding it here.
                let cancels_play=self.monitor_actions.iter().skip(index).any(|action|matches!(action,DeferredAudio::Command(command) if matches!(command.as_str(),"play"|"pause"|"play-flat")));
                self.monitor_actions.truncate(index);
                if cancels_play {
                    // The removed command has no future native receipt.
                    self.native_play_intent=None;
                    if self.monitor_parked {self.playing=false;}
                }
            }
            self.native_rate_navigation = Some((path, source));
            self.carry_open = false;
            self.metronome_open = false;
            self.transport.update(cx, |t, cx| {
                t.dismiss_popovers(cx);
            });
            cx.notify();
            true
        } else {
            false
        }
    }
    pub(super) fn flush_rate_intents(&mut self, cx: &mut Context<Self>) {
        if self.audio_recovery.is_some() || self.source_publication.is_some() { return; }
        if self.rate_busy() || self.region_busy() || !self.monitor_actions.is_empty() || self.loading || self.saving || self.notice.is_some() {
            return;
        }
        if std::mem::take(&mut self.native_rate_save_requested) {
            self.metronome_save_requested = true;
            if let Some(path) = self.native_rate_navigation.take() {
                self.metronome_navigation = Some(path);
            }
        } else if let Some((path, source)) = self.native_rate_navigation.take() {
            if source {
                self.open_source(path, cx);
            } else {
                self.open_project(path, cx);
            }
        }
    }
    pub(super) fn refresh_transport_timing(&mut self, cx: &mut Context<Self>) {
        if self.backend.is_none() {
            return;
        }
        let bpm = self
            .project
            .as_ref()
            .and_then(|_| self.beats.as_ref())
            .map(|grid| grid.bpm as f32);
        let mut analysis = self
            .analysis_progress
            .map(|p| ("Reading the melody".to_owned(), p))
            .or_else(|| {
                self.beat_job
                    .map(|_| ("Finding the beat".to_owned(), self.beat_progress))
            });
        #[cfg(feature = "ui-tests")]
        if let Some(value) = &self.timing_analysis_override {
            analysis = Some(value.clone());
        }
        let count_in = if let Some((status, heard)) = self
            .timing_status
            .as_ref()
            .filter(|_| self.playing)
            .and_then(|status| status.count_in_heard.map(|heard| (status, heard)))
        {
            let matches = self.count_in_cache.as_ref().is_some_and(|cache| {
                cache.graph == status.graph_generation
                    && cache.landing == heard.landing_seconds.to_bits()
                    && cache.rate == status.rate.to_bits()
                    && cache.bars == self.metronome.count_in_bars
                    && match (&cache.grid, &self.paint_beats) {
                        (None, None) => true,
                        (Some(old), Some(now)) => Rc::ptr_eq(old, now),
                        _ => false,
                    }
            });
            if !matches {
                self.count_in_cache = Some(CountInCache {
                    graph: status.graph_generation,
                    landing: heard.landing_seconds.to_bits(),
                    rate: status.rate.to_bits(),
                    bars: self.metronome.count_in_bars,
                    grid: self.paint_beats.clone(),
                    offsets: transport_timing::offsets(
                        heard.landing_seconds,
                        self.beats.as_ref(),
                        &self.metronome,
                        status.rate as f64,
                    ),
                });
            }
            transport_timing::count_in_from_offsets(
                status,
                &self.count_in_cache.as_ref().unwrap().offsets,
            )
        } else {
            self.count_in_cache = None;
            None
        };
        let tempo = self.requested_rate().0;
        self.transport.update(cx, |t, cx| {
            t.set_tempo(tempo, cx);
            t.set_timing(bpm, analysis, count_in, cx);
        });
    }
}

#[cfg(test)]
mod tests {
    use super::normalized_rate;
    #[test]
    fn production_tempo_range_and_four_decimal_rounding() {
        assert_eq!(normalized_rate(0.25), Some(0.5));
        assert_eq!(normalized_rate(2.), Some(1.5));
        assert_eq!(normalized_rate(1.234567), Some(1.2346));
        assert_eq!(normalized_rate(f32::NAN), None);
        assert_eq!(normalized_rate(f32::INFINITY), None);
    }
}

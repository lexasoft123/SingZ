//! Empty documents retain identity while their native graph owns no song audio.
use super::*;
impl Player {
    pub(super) fn audio_available(&self) -> bool {
        self.backend.is_none()
            || (!self.tracks_audio_failed
                && self
                    .project
                    .as_ref()
                    .is_some_and(integration::Project::has_audio))
    }
    pub(super) fn empty_timeline(&mut self, cx: &mut Context<Self>) {
        self.transport_flight.native_play.cancel();
        self.transport_flight.timing_status=None;
        self.transport_flight.count_in_cache=None;
        self.transport_flight.native_rate_generation_floor=0;
        self.analysis_progress=None;
        self.analysis_job=None;
        self.duration = 0.;
        self.playhead.reset(0.);
        self.playing = false;
        self.looping = false;
        self.view_start = 0.;
        self.view_end = 1.;

        self.transport_flight.counting_in = false;
        self.transport_flight.count_in_anchor = None;
        self.carry_open=false;self.carry.enabled=false;self.carry_flight.carry_plan=None;self.carry_document=None;self.carry_mask=None;self.carry_flight.carry_stamp=None;self.carry_flight.carry_attempt_stamp=None;
        self.metronome_open = false;
        self.karaoke = false;
        self.transport.update(cx, |t, cx| {
            t.set_duration(0., cx);
            t.set_karaoke(false, cx);
            t.set_audio_available(false, cx);
        });
    }
    pub(super) fn playback_status(
        &mut self,
        epoch: u64,
        status: integration::Status,
        cx: &mut Context<Self>,
    ) {
        if epoch != self.native_epoch {
            return;
        }
        self.training_status(&status.cue, cx);
        if self.tracks_audio_failed || self.project.is_none() || status.training_only {
            return;
        }
        if self.transport_flight.native_rate_pending.is_some() || status.graph_generation<self.transport_flight.native_rate_generation_floor {return;}
        // A lane commit receipt adopts inventory and revision together. Neither
        // old telemetry nor early telemetry for a pending inventory may cross it.
        if status.carry_revision!=self.native_carry_revision{return;}
        if status.lane_revision != self.native_lane_revision {
            return;
        }
        if status.empty_project != self.project.as_ref().is_some_and(|p| p.empty_tracks) {
            return;
        }
        if let Some(project) = self.project.as_ref() {
            let expected: Option<Vec<String>> = project.lanes.iter()
                .map(|(slot, _)| project.lane_id(*slot).map(str::to_owned))
                .collect();
            if !expected.as_deref().is_some_and(|ids| integration::lane_ids_match(ids, &status.lane_ids)) {
                return;
            }
        }
        if !self.playhead.admit((&status).into(), Instant::now()) { return; }
        let peak_token = waveform::ProjectPeakToken {
            epoch,
            graph_generation: status.graph_generation,
        };
        if waveform::admit_project_peak_generation(peak_token) {
            if let Some(project) = self.project.as_ref() {
                waveform::update_project_peaks(peak_token, project.lanes.iter().enumerate().filter_map(
                    |(lane, (slot, _))| {
                        status
                            .waveform_peaks
                            .get(lane)
                            .filter(|peaks| !peaks.is_empty())
                            .map(|peaks| (*slot, peaks.clone()))
                    },
                ));
            }
        }
        self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
        self.transport_flight.timing_status=Some(status.clone());
        #[cfg(feature = "ui-tests")]
        {
            self.last_playback_status = Some(status.clone());
        }
        if status.empty_project {
            self.native_graph = status.graph_generation;
            self.native_rate = status.rate;
            self.empty_timeline(cx);
            return;
        }
        self.native_graph = status.graph_generation;
        self.transport_flight.counting_in = status.counting_in;
        if status.playing && !status.counting_in && status.rendered_frame >= 0 {
            self.transport_flight.count_in_anchor = None;
        }
        self.duration = status.duration;
        let playing=self.transport_flight.native_play.payload().map_or(status.playing,|target|*target);
        if self.playing!=playing {self.restart_cycle.reset();}
        self.playing = playing;
        self.native_rate = status.rate;

        self.pitch_strip.update(cx, |pitch, cx| {
            pitch.set_effects(status.rate, status.transpose, cx)
        });
    }
}

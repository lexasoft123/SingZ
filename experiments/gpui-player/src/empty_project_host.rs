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
        self.native_play_intent=None;
        self.timing_status=None;
        self.count_in_cache=None;
        self.native_rate_generation_floor=0;
        self.analysis_progress=None;
        self.analysis_job=None;
        self.duration = 0.;
        self.position = 0.;
        self.playing = false;
        self.looping = false;
        self.view_start = 0.;
        self.view_end = 1.;
        self.native_anchor = None;
        self.pending_seek = None;
        self.native_floor = None;
        self.native_loop = None;
        self.native_seek_count = 0;
        self.native_loop_count = 0;
        self.counting_in = false;
        self.count_in_anchor = None;
        self.carry_open=false;self.carry.enabled=false;self.carry_plan=None;self.carry_document=None;self.carry_mask=None;self.carry_stamp=None;self.carry_attempt_stamp=None;
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
        if self.native_rate_pending.is_some() || status.graph_generation<self.native_rate_generation_floor {return;}
        // A lane commit receipt adopts inventory and revision together. Neither
        // old telemetry nor early telemetry for a pending inventory may cross it.
        if status.carry_revision!=self.native_carry_revision{return;}
        if status.lane_revision != self.native_lane_revision {
            return;
        }
        if status.empty_project != self.project.as_ref().is_some_and(|p| p.empty_tracks) {
            return;
        }
        if self
            .native_anchor
            .is_some_and(|(_, at)| status.sampled_at < at)
        {
            return;
        }
        self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
        self.timing_status=Some(status.clone());
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
        if self.native_graph != status.graph_generation {
            self.native_graph = status.graph_generation;
            // A seek queued behind a rate is still outstanding. Its own native
            // counter, rather than graph preparation, acknowledges the intent.
            if !self.pending_seek.is_some_and(|(expected,_)| status.seek_count < expected) {
                self.pending_seek = None;
                self.native_floor = None;
            }
        }
        self.counting_in = status.counting_in;
        let mut position = if status.counting_in || status.rendered_frame < 0 {
            self.count_in_anchor.unwrap_or(self.position)
        } else {
            status.position
        };
        if status.playing && !status.counting_in && status.rendered_frame >= 0 {
            self.count_in_anchor = None;
        }
        if let Some((expected, target)) = self.pending_seek {
            if status.seek_count < expected {
                position = target;
            } else {
                self.pending_seek = None;
            }
        }
        if status.playing && !status.audible_current {
            if let Some((floor, lap)) = self.native_floor {
                if lap == status.loop_count {
                    position = position.max(floor);
                }
            }
        }
        if status.playing && status.audible_current && self.pending_seek.is_none() {
            self.native_floor = None;
        }
        self.position = position;
        self.duration = status.duration;
        let playing=self.native_play_intent.map_or(status.playing,|(target,_)|target);
        if self.playing!=playing {self.restart_cycle.reset();}
        self.playing = playing;
        self.native_rate = status.rate;
        self.native_seek_count = status.seek_count;
        self.native_loop_count = status.loop_count;
        self.native_loop = status.loop_range;
        self.pitch_strip.update(cx, |pitch, cx| {
            pitch.set_effects(status.rate, status.transpose, cx)
        });
        self.native_anchor = Some((position, status.sampled_at));
    }
}

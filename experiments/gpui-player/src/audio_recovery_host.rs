//! Audio ownership can fail while the document and editor remain valid.
use super::*;

pub(super) struct PendingRecovery {
    epoch: u64,
    serial: u64,
    notice: Option<String>,
}
pub(super) struct PendingPublication {
    epoch: u64,
    serial: u64,
    publication: integration::Publication,
    save_seq: u64,
    recover: bool,
    route: Option<String>,
    reading: bool,
}

impl Player {
    pub(super) fn transport_failed(&mut self, epoch: u64, error: String, cx: &mut Context<Self>) {
        if epoch != self.native_epoch || self.loading {
            return;
        }
        // Retain the error before cue cancellation revokes its generation. The
        // worker sends TransportFailed before its generation-specific error.
        let exercise_failed = self.practice.as_ref().is_some_and(|run| run.phase != training_run::Phase::Summary)
            && (self.screen == Screen::Training
                || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
                    && self.previous_screen == Screen::Training);
        self.monitor_flight.monitor_publication_epoch = None;
        let queued_save = self.transport_flight.native_rate_save_requested
            || self.metronome_flight.metronome_save_requested
            || self.carry_flight.carry_save_requested;
        let navigation = self.transport_flight.native_rate_navigation.take();
        let analysis = (self.analysis_job, self.analysis_progress);
        self.reset_transport_timing(cx);
        self.transport_flight.native_rate_navigation = navigation;
        self.analysis_job = analysis.0;
        self.analysis_progress = analysis.1;
        self.tracks_audio_failed = self.project.is_some();
        self.playing = false;
        self.playhead.stop_projection();

        self.transport_flight.counting_in = false;
        self.transport_flight.count_in_anchor = None;
        self.metronome_flight.metronome.cancel();
        self.metronome_flight.metronome_requested = None;
        self.metronome_flight.metronome_save_requested = false;
        self.metronome_ui.update(cx, |s, cx| {
            s.adopt(self.metronome.clone(), self.beats.clone(), cx)
        });
        self.carry_flight.carry.cancel();
        self.carry_flight.carry_save_requested = false;
        self.carry_flight.carry_plan = None;
        self.carry_flight.carry_stamp = None;
        self.carry_flight.carry_attempt_stamp = None;
        self.pause_practice(cx);
        if exercise_failed {
            if let Some(run) = &mut self.practice {
                run.fail(error.clone());
                self.training.update(cx, |screen, cx| screen.set_run(Some(run.snapshot()), cx));
            }
            self.practice_reached = None;
        }
        #[cfg(feature = "ui-tests")]
        {
            self.last_playback_status = None;
        }
        self.settings.update(cx, |settings, cx| settings.set_playback_status(None, cx));
        diagnostics::event("audio", error.clone(), diagnostics::Level::Error);
        let message = if exercise_failed {
            if self.project.is_some() {
                format!("Training audio failed: {error}. Your exercise and song edits are retained. Retry the song output in Settings, then choose Continue.")
            } else {
                format!("Training audio failed: {error}. Your exercise is retained and paused. Close this message and choose Continue to retry its current prompt.")
            }
        } else { format!(
            "{error}{} Your project and edits are retained. Retry the output route in Settings.",
            if queued_save {
                " The queued Save did not run because the pending audio change was not accepted."
            } else {
                ""
            }
        ) };
        // An older failure receipt must not unlock a newer recovery transaction.
        if self.audio_recovery.is_none()
            && !self
                .source_publication
                .as_ref()
                .is_some_and(|p| p.route.is_some())
        {
            self.settings
                .update(cx, |s, cx| s.route_failed(message.clone(), cx));
        }
        self.notice = Some(message);
        cx.notify();
    }

    pub(super) fn begin_audio_recovery(&mut self, uid: String, cx: &mut Context<Self>) {
        if self.audio_recovery.is_some() {
            return;
        }
        if self.saving
            || self.source_job.is_some()
            || self.tracks_flight.tracks_pending.is_some()
            || self.carry_flight.carry.is_some()
            || self.metronome_flight.metronome.is_some()
            || self.rate_busy()
            || self.loading
        {
            self.settings.update(cx, |s, cx| {
                s.route_failed(
                    "Wait for the current project operation before retrying output.".into(),
                    cx,
                )
            });
            return;
        }
        let (Some(project), Some(backend)) = (&self.project, &self.backend) else {
            return;
        };
        self.audio_recovery_serial += 1;
        let serial = self.audio_recovery_serial;
        let request = integration::AudioRecovery {
            replace: self.tracks_audio_failed,
            project: project.clone(),
            mix: self.current_mix(project),
            position: self.playhead.position(),
        };
        match backend.recover_output(self.native_epoch, serial, request, uid) {
            Ok(()) => {
                self.audio_recovery = Some(PendingRecovery {
                    epoch: self.native_epoch,
                    serial,
                    notice: self.notice.clone(),
                });
                self.settings.update(cx, |s, cx| s.route_applying(cx));
            }
            Err(error) => self
                .settings
                .update(cx, |s, cx| s.route_failed(error.to_string(), cx)),
        }
        cx.notify();
    }

    pub(super) fn output_recovered(
        &mut self,
        epoch: u64,
        serial: u64,
        uid: String,
        result: Result<integration::RecoveredAudio, String>,
        cx: &mut Context<Self>,
    ) {
        if !self
            .audio_recovery
            .as_ref()
            .is_some_and(|p| p.epoch == epoch && p.serial == serial)
        {
            return;
        }
        let pending = self.audio_recovery.take().unwrap();
        match result {
            Ok(recovered) => {
                let status = recovered.status;
                self.settings.update(cx, |s, cx| {
                    s.set_route(
                        uid,
                        Some(status.output_label.clone()),
                        recovered.preference_error.clone(),
                        cx,
                    )
                });
                // Preference receipts are global; document adoption is epoch-bound.
                if epoch != self.native_epoch || self.loading || self.project.is_none() {
                    return;
                }
                let project = self.project.as_ref().unwrap();
                let expected_lane_ids: Option<Vec<String>> = project.lanes.iter()
                    .map(|(slot, _)| project.lane_id(*slot).map(str::to_owned))
                    .collect();
                if !expected_lane_ids.as_deref().is_some_and(|ids| integration::lane_ids_match(ids, &status.lane_ids)) {
                    let error = format!("Recovered playback lane IDs did not match the loaded project (expected {}, received {})", expected_lane_ids.as_ref().map_or(0, Vec::len), status.lane_ids.len());
                    self.settings.update(cx, |s, cx| s.route_failed(error.clone(), cx));
                    self.transport_failed(epoch, error, cx);
                    return;
                }
                self.playhead.reset(status.position);
                if !self.playhead.admit((&status).into(), Instant::now()) { return; }
                self.tracks_audio_failed = false;
                self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
                self.native_graph = status.graph_generation;
                self.native_lane_revision = status.lane_revision;
                self.native_carry_revision = status.carry_revision;
                self.transport_flight.native_rate_generation_floor = 0;
                self.native_rate = status.rate;

                self.transport_flight.native_play.cancel();

                self.duration = status.duration;
                self.playing = false;
                if let Some(media) = recovered.media {
                    let project = self.project.as_mut().unwrap();
                    project.vocal_duration = media.vocal_duration;
                    Arc::make_mut(&mut project.pitch)
                        .bind_duration_for_lane(status.duration, project.vocal_duration);
                    let mut envelopes = std::array::from_fn(|_| vec![0.]);
                    for (lane, (slot, _)) in project.lanes.iter().enumerate() {
                        if let Some(peaks) = media.peaks.get(lane).filter(|p| !p.is_empty()) {
                            envelopes[*slot] = peaks.clone();
                        }
                    }
                    waveform::set_project_peaks(envelopes, waveform::ProjectPeakToken {
                        epoch: self.native_epoch,
                        graph_generation: status.graph_generation,
                    });
                    self.pitch_strip
                        .update(cx, |p, cx| p.set_native(project.pitch.clone(), cx));
                }
                self.transport_flight.timing_status = Some(status.clone());
                self.transport_flight.counting_in = false;
                self.transport_flight.count_in_anchor = None;
                // An editor Save can finish while audio is preparing. Do not
                // stamp the captured native plan as using those newer words.
                // The existing receipt-gated Carry worker refreshes it next.
                self.carry_flight.carry_plan = None;
                self.carry_document = None;
                self.carry_flight.carry_stamp = None;
                self.carry_flight.carry_attempt_stamp = None;
                self.header.update(cx, |h, cx| {
                    h.set_output_label(status.output_label.clone(), cx)
                });
                self.transport.update(cx, |t, cx| {
                    t.set_audio_available(self.project.as_ref().unwrap().has_audio(), cx);
                    t.set_tempo(self.tempo, cx);
                });
                self.pitch_strip
                    .update(cx, |s, cx| s.set_effects(status.rate, status.transpose, cx));
                #[cfg(feature = "ui-tests")]
                {
                    self.last_playback_status = Some(status);
                }
                if self.notice == pending.notice {
                    self.notice = recovered.preference_error;
                }
            }
            Err(error) => {
                self.settings
                    .update(cx, |s, cx| s.set_route(uid, None, Some(error.clone()), cx));
                if epoch == self.native_epoch && !self.loading && self.tracks_audio_failed {
                    self.notice = Some(format!(
                        "Output recovery failed: {error}. Your project and edits are retained."
                    ));
                }
            }
        }
        cx.notify();
    }

    pub(super) fn cancel_source_publication(&mut self, cx: &mut Context<Self>) {
        self.monitor_flight.monitor_publication_epoch = None;
        if self
            .source_publication
            .take()
            .is_some_and(|pending| pending.route.is_some())
            && self.audio_recovery.is_none()
        {
            self.settings.update(cx, |s, cx| {
                s.route_failed(
                    "Saved-project output retry was superseded by navigation.".into(),
                    cx,
                )
            });
        }
    }
    pub(super) fn adopt_source_publication(
        &mut self,
        output: &source_jobs::Output,
        recover: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(hash) = output.publication_hash.clone() else {
            return;
        };
        self.source_publication = Some(PendingPublication {
            epoch: self.native_epoch,
            serial: 0,
            publication: integration::Publication {
                path: output.path.clone(),
                metadata_hash: hash,
            },
            save_seq: self.source_save_seq,
            recover,
            route: None,
            reading: false,
        });
        self.tracks_audio_failed = true;
        self.playing = false;
        self.playhead.stop_projection();
        #[cfg(feature = "ui-tests")]
        if let Some(receipt) = self.source_publication_fault.take() {
            ui_audio_recovery::quarantine_publication(output, &receipt)
                .expect("Isolated publication fault could not quarantine metadata");
        }
        self.read_source_publication(cx);
    }
    pub(super) fn retry_source_publication(&mut self, uid: String, cx: &mut Context<Self>) {
        if let Some(pending) = &mut self.source_publication {
            pending.route = Some(uid);
        }
        self.read_source_publication(cx);
    }
    fn read_source_publication(&mut self, cx: &mut Context<Self>) {
        let Some(pending) = &mut self.source_publication else {
            return;
        };
        if pending.reading {
            return;
        }
        self.audio_recovery_serial += 1;
        pending.serial = self.audio_recovery_serial;
        if let Some(backend) = &self.backend {
            match backend.read_publication(
                pending.epoch,
                pending.serial,
                pending.publication.clone(),
            ) {
                Ok(()) => pending.reading = true,
                Err(error) => self
                    .settings
                    .update(cx, |s, cx| s.route_failed(error.to_string(), cx)),
            }
        }
    }
    pub(super) fn source_publication_read(
        &mut self,
        epoch: u64,
        serial: u64,
        result: Result<integration::Project, String>,
        cx: &mut Context<Self>,
    ) {
        if !self
            .source_publication
            .as_ref()
            .is_some_and(|p| p.epoch == epoch && p.serial == serial)
        {
            return;
        }
        let mut pending = self.source_publication.take().unwrap();
        if epoch != self.native_epoch || self.project.is_none() {
            if pending.route.is_some() && self.audio_recovery.is_none() {
                self.settings.update(cx, |s, cx| {
                    s.route_failed(
                        "Saved-project output retry was superseded by navigation.".into(),
                        cx,
                    )
                });
            }
            return;
        }
        match result {
            Ok(mut published) => {
                let previous = self.project.as_ref().unwrap();
                let mut raw = previous.raw.clone();
                for key in ["name", "version", "songFile", "savedAt", "stemHashes"] {
                    raw[key] = published.raw[key].clone();
                }
                raw["settings"]["custom"] = published.raw["settings"]["custom"].clone();
                published.raw = raw;
                published.pitch = previous.pitch.clone();
                published.vocal_duration = previous.vocal_duration;
                published.lyrics = previous.lyrics.clone();
                published.lyrics_raw = previous.lyrics_raw.clone();
                published.lyrics_fingerprint = previous.lyrics_fingerprint.clone();
                published.lyrics_error = previous.lyrics_error.clone();
                published.has_lyrics = previous.has_lyrics;
                let sidebar_retained = self.lyrics_sidebar.update(cx, |sidebar, cx| {
                    sidebar.relocate_owned(
                        &previous.dir.display().to_string(),
                        published.dir.display().to_string(),
                        published.name.clone(),
                        cx,
                    )
                });
                self.song_title = published.name.clone().into();
                self.project = Some(published);
                self.saved_seq = pending.save_seq;
                self.source_working = false;
                self.source_target = None;
                self.library.update(cx, |l, cx| {
                    l.set_open_song(Some(self.song_title.clone()), cx)
                });
                if let Some(backend) = &self.backend {
                    backend.catalog();
                }
                self.sidebar_context(cx);
                if !sidebar_retained && !self.lyric_document.lines.is_empty() {
                    self.sidebar_ready(None, cx);
                }
                if let Some(uid) = pending
                    .route
                    .or_else(|| pending.recover.then(|| self.settings.read(cx).output_uid()))
                {
                    if self.monitor_busy() {
                        // Reading/adopting storage does not own monitoring.
                        // Keep its generation alive and prepare published media
                        // only after the matching clean release acknowledgment.
                        self.monitor_flight.monitor_publication_epoch = Some(self.native_epoch);
                    } else {
                        self.begin_audio_recovery(uid, cx);
                    }
                }
            }
            Err(error) => {
                pending.reading = false;
                let message = format!(
                    "Project was saved to {}, but its publication could not be adopted: {error}. Retry the output route in Settings; the working document is retained.",
                    pending.publication.path.display()
                );
                self.settings
                    .update(cx, |s, cx| s.route_failed(message.clone(), cx));
                pending.route = None;
                self.source_publication = Some(pending);
                self.notice = Some(message);
            }
        }
        cx.notify();
    }

    pub(super) fn restore_monitor_publication(&mut self, cx: &mut Context<Self>) {
        if self.monitor_busy() {
            return;
        }
        let Some(epoch) = self.monitor_flight.monitor_publication_epoch else { return; };
        if epoch != self.native_epoch || self.project.is_none() || !self.tracks_audio_failed {
            self.monitor_flight.monitor_publication_epoch = None;
            return;
        }
        // A second storage Save may still be writing when Stop completes.
        // Keep this intent (and the command queue) until that writer settles,
        // including when an explicit queued route will own the preparation.
        if self.saving || self.source_job.is_some() || self.tracks_flight.tracks_pending.is_some()
            || self.carry_flight.carry.is_some() || self.metronome_flight.metronome.is_some()
            || self.rate_busy() || self.loading || self.audio_recovery.is_some()
        { return; }
        // Only the next queued owner can supersede this preparation. A later
        // route/Open must not cause an earlier Play to be silently discarded.
        let replacement = self.monitor_flight.monitor_actions.front().is_some_and(|action| matches!(
            action, DeferredAudio::Open(_) | DeferredAudio::SourceOutput(_, _, _) | DeferredAudio::Output(_)
        ));
        if replacement {
            self.monitor_flight.monitor_publication_epoch = None;
            return;
        }
        self.monitor_flight.monitor_publication_epoch = None;
        let uid = self.settings.read(cx).output_uid();
        self.begin_audio_recovery(uid, cx);
    }
}

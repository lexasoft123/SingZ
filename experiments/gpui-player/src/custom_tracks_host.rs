//! User-added lane controls. Filesystem inspection and decoding stay backend-owned.
use super::*;
use std::path::PathBuf;

impl Player {
    pub(super) fn track_probe(&self, id: String, d: Stateful<Div>) -> Stateful<Div> {
        // These are the mounted lane controls' stable action IDs. Their names
        // use the same localized source copy and current track title as the UI.
        let mut d = d;
        if let Some((action, slot)) = id.rsplit_once('-') {
            if let Ok(slot) = slot.parse::<usize>() {
                if slot < self.gain.len() {
                    let track = self.lane_label(slot);
                    let name = match action {
                        "mute" => Some(format!("{} · {track}", i18n::t(if self.muted[slot] { "player.lane.unmute" } else { "player.lane.mute" }))),
                        "solo" => Some(format!("{} · {track}", i18n::t(if self.solo[slot] { "player.lane.unsolo" } else { "player.lane.solo" }))),
                        "gain" => Some(format!("{} · {track}", i18n::t("player.lane.volume"))),
                        "edit" => Some(i18n::tv("player.lane.rename", &[("track", track.to_string())])),
                        "remove" => Some(i18n::tv("player.lane.remove", &[("track", track.to_string())])),
                        _ => None,
                    };
                    if let Some(name) = name { d = d.aria_label(name); }
                    if matches!(action, "mute" | "solo") {
                        let on = if action == "mute" { self.muted[slot] } else { self.solo[slot] };
                        d = d.aria_toggled(if on { Toggled::True } else { Toggled::False });
                    }
                }
            }
        }
        #[cfg(feature = "ui-tests")]
        {
            let bounds = self.track_bounds.clone();
            return d.relative().child(
                canvas(
                    move |b, _, _| {
                        bounds.borrow_mut().insert(id.clone(), b);
                        b
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            );
        }
        #[cfg(not(feature = "ui-tests"))]
        {
            let _ = id;
            d
        }
    }
    pub(super) fn disconnected_custom_lanes(
        &mut self,
        epoch: u64,
        serial: u64,
        error: String,
        cx: &mut Context<Self>,
    ) {
        if self.tracks_pending != Some((epoch, serial)) || self.native_epoch != epoch {
            return;
        }
        self.tracks_pending = None;
        self.tracks_audio_failed = true;
        self.track_rename = None;
        self.playing = false;
        self.native_anchor = None;
        self.pending_seek = None;
        self.notice = Some(format!(
            "{error} Your previous tracks are retained. Retry the output route in Settings to resume playback."
        ));
        cx.notify();
    }
    pub(super) fn failed_custom_lanes(
        &mut self,
        epoch: u64,
        serial: u64,
        project: integration::Project,
        error: String,
        cx: &mut Context<Self>,
    ) {
        if self.tracks_pending != Some((epoch, serial)) || self.native_epoch != epoch {
            return;
        }
        self.tracks_pending = None;
        self.tracks_audio_failed = true;
        self.track_rename = None;
        self.playing = false;
        self.native_anchor = None;
        self.pending_seek = None;
        self.muted = project.muted;
        self.solo = project.solo;
        self.gain = project.gain.map(|v| (v * 100.).round() as u8);
        let empty = project.empty_tracks;
        self.project = Some(project);
        if empty {
            self.empty_timeline(cx);
        }
        #[cfg(feature = "ui-tests")]
        {
            self.last_playback_status = None;
        }
        self.settings.update(cx, |settings, cx| settings.set_playback_status(None, cx));
        self.edit_seq += 1;
        waveform::set_project_peaks(std::array::from_fn(|_| vec![0.]));
        self.notice = Some(format!(
            "{error} Your requested tracks are retained. Save the project or retry the output route in Settings to resume playback."
        ));
        cx.notify();
    }
    pub(super) fn lane_color(&self, slot: usize) -> u32 {
        self.project
            .as_ref()
            .and_then(|p| p.lane_specs.iter().find(|l| l.slot == slot))
            .filter(|l| l.custom)
            .and_then(|l| u32::from_str_radix(l.color.trim_start_matches('#'), 16).ok())
            .unwrap_or_else(|| COLORS.get(slot).copied().unwrap_or(0xc7e06a))
    }
    pub(super) fn lane_label(&self, slot: usize) -> SharedString {
        if slot == 5 && self.project.as_ref().is_some_and(|p| p.original) {
            return crate::i18n::t("stem.original").into();
        }
        if let Some(lane)=self.project.as_ref().and_then(|p|p.lane_specs.iter().find(|lane|lane.slot==slot)) {
            return match lane.id.as_str() {
                "vocals"|"drums"|"bass"|"guitar"|"piano"|"other"=>crate::i18n::t(&format!("stem.{}",lane.id)).into(),
                _=>lane.label.clone().into(), // A custom track name is user content.
            };
        }
        ["vocals","drums","bass","guitar","piano","other"].get(slot)
            .map(|id|crate::i18n::t(&format!("stem.{id}")))
            .unwrap_or_else(||crate::i18n::t(if slot==6{"app.split.backingVocalsLabel"}else{"player.track.untitled"})).into()
    }
    fn custom_tracks_busy(&self) -> bool {
        self.rate_busy() || self.project.is_none()
            || self.tracks_audio_failed
            || self.loading
            || self.saving
            || self.carry_pending.is_some()
            || self.tracks_pending.is_some()
            || self.source_job.is_some()
            || self.rename_pending.is_some()
            || self.import_pending.is_some()
            || self.project_library_moving
            || self.monitor_busy()
            || self.counting_in
            || self.metronome_pending.is_some()
            || self.metronome_save_requested
            || self.metronome_save_waiting
            || self.delete_pending.is_some()
            || self.lyrics_editor_pending.is_some()
            || self.lyrics_editor_open
            || self.lyrics_alignment_pending.is_some()
            || self.lyrics_sidebar_pending.is_some()
            || self.lyrics_sidebar_download_waiting
            || !self.lyrics_sidebar_needs.is_empty()
            || self.lyrics_sidebar_next.is_some()
    }
    pub(super) fn begin_track_name(
        &mut self,
        slot: usize,
        window: &mut Window,
        cx: &mut Context<Self>,
    ) {
        if self.custom_tracks_busy() {
            return;
        }
        let Some(lane) = self
            .project
            .as_ref()
            .and_then(|p| p.lane_specs.iter().find(|l| l.slot == slot && l.custom))
        else {
            return;
        };
        let (id, label) = (lane.id.clone(), lane.label.clone());
        self.track_rename = Some((self.native_epoch, id));
        self.track_name_input.update(cx, |input, cx| {
            input.set_value(label, window, cx);
            input.focus(window, cx);
            input.select_all(window, cx);
        });
        cx.notify();
    }
    pub(super) fn commit_track_name(&mut self, cx: &mut Context<Self>) {
        let Some((epoch, id)) = self.track_rename.take() else {
            return;
        };
        if epoch != self.native_epoch {
            return;
        }
        self.track_focus_after_name = true;
        let name = self.track_name_input.read(cx).value().trim().to_owned();
        if !name.is_empty() {
            if let Some(lane) = self
                .project
                .as_mut()
                .and_then(|p| p.lane_specs.iter_mut().find(|l| l.id == id && l.custom))
            {
                if lane.label != name {
                    lane.label = name;
                    self.edit_seq += 1;
                }
            }
        }
        cx.notify();
    }
    pub(super) fn browse_custom_tracks(&mut self, cx: &mut Context<Self>) {
        if self.backend.is_none() {
            return;
        }
        if self.custom_tracks_busy() {
            self.notice =
                Some("Wait for the current project operation before changing tracks.".into());
            cx.notify();
            return;
        }
        let epoch = self.native_epoch;
        #[cfg(feature = "ui-tests")]
        if std::env::var_os("SINGZ_GPUI_EMPTY_PROJECT_TEST").is_some() {
            if let Some(paths) = self.empty_picker_paths.pop_front() {
                self.add_custom_tracks(paths, cx);
                return;
            }
        }
        #[cfg(feature = "ui-tests")]
        if std::env::var_os("SINGZ_GPUI_CUSTOM_TRACK_TEST").is_some() {
            if let Ok(files) = std::env::var("SINGZ_GPUI_CUSTOM_TRACK_FILES") {
                if let Ok(paths) = serde_json::from_str::<Vec<PathBuf>>(&files) {
                    self.add_custom_tracks(paths, cx);
                    return;
                }
            }
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: false,
            multiple: true,
            prompt: Some(crate::i18n::t("main.dialog.addAudioTracks").into()),
        });
        cx.spawn(async move |this, cx| match prompt.await {
            Ok(Ok(Some(paths))) => {
                let _ = this.update(cx, |this, cx| {
                    if this.native_epoch == epoch {
                        this.add_custom_tracks(paths, cx);
                    }
                });
            }
            Ok(Err(error)) => {
                let _ = this.update(cx, |this, cx| {
                    if this.native_epoch == epoch {
                        this.notice = Some(error.to_string());
                        cx.notify();
                    }
                });
            }
            _ => {}
        })
        .detach();
    }
    pub(super) fn add_custom_tracks(&mut self, paths: Vec<PathBuf>, cx: &mut Context<Self>) {
        if self.custom_tracks_busy() {
            return;
        }
        let Some(candidate) = self.project.clone() else {
            return;
        };
        if paths.is_empty() {
            return;
        }
        self.replace_custom_lanes_with_paths(candidate, paths, cx);
    }

    pub(super) fn remove_custom_track(&mut self, slot: usize, cx: &mut Context<Self>) {
        if self.custom_tracks_busy() {
            return;
        }
        let Some(mut candidate) = self.project.clone() else {
            return;
        };
        if !candidate
            .lane_specs
            .iter()
            .any(|l| l.slot == slot && l.custom)
        {
            return;
        }
        candidate.lane_specs.retain(|l| l.slot != slot);
        candidate.lanes.retain(|(i, _)| *i != slot);
        candidate.empty_tracks = candidate.lanes.is_empty();
        if candidate.empty_tracks {
            candidate.original = false;
            candidate.looping = false;
            candidate.selection = None;
            candidate.view = None;
        }
        candidate.gain[slot] = 1.;
        candidate.muted[slot] = false;
        candidate.solo[slot] = false;
        self.replace_custom_lanes(candidate, cx);
    }
    fn replace_custom_lanes(&mut self, candidate: integration::Project, cx: &mut Context<Self>) {
        self.replace_custom_lanes_with_paths(candidate, vec![], cx);
    }
    fn replace_custom_lanes_with_paths(
        &mut self,
        mut candidate: integration::Project,
        paths: Vec<PathBuf>,
        cx: &mut Context<Self>,
    ) {
        // The UI remains on the accepted graph until the native replacement succeeds.
        for &(slot, _) in &self.project.as_ref().unwrap().lanes {
            if candidate.lanes.iter().any(|(i, _)| *i == slot) {
                candidate.gain[slot] = self.gain[slot] as f32 / 100.;
                candidate.muted[slot] = self.muted[slot];
                candidate.solo[slot] = self.solo[slot];
            }
        }
        self.cancel_lyrics_alignment(cx);
        if let Some(backend) = &self.backend {
            backend.cancel_beat_detection();
            backend.cancel_lyrics_search();
            self.tracks_serial += 1;
            let request = if paths.is_empty() {
                backend.replace_lanes(self.native_epoch, self.tracks_serial, candidate)
            } else {
                backend.add_tracks(self.native_epoch, self.tracks_serial, candidate, paths)
            };
            match request {
                Ok(()) => {
                    self.tracks_pending = Some((self.native_epoch, self.tracks_serial));
                    self.track_rename = None;
                }
                Err(error) => self.notice = Some(error.to_string()),
            }
        }
        cx.notify();
    }
    pub(super) fn replaced_custom_lanes(
        &mut self,
        epoch: u64,
        serial: u64,
        result: Result<(integration::Project, integration::Status, Vec<Vec<f32>>), String>,
        cx: &mut Context<Self>,
    ) {
        if self.tracks_pending != Some((epoch, serial)) || self.native_epoch != epoch {
            return;
        }
        self.tracks_pending = None;
        match result {
            Ok((mut project, status, peaks)) => {
                let previous = self.duration;
                self.lane_entered
                    .retain(|id, _| project.lane_specs.iter().any(|lane| &lane.id == id));
                for lane in &project.lane_specs {
                    self.lane_entered
                        .entry(lane.id.clone())
                        .or_insert_with(Instant::now);
                }
                self.track_focus_removed = self
                    .project
                    .as_ref()
                    .map(|old| {
                        old.lane_specs
                            .iter()
                            .filter(|lane| {
                                !project.lane_specs.iter().any(|next| next.id == lane.id)
                            })
                            .map(|lane| lane.slot)
                            .collect()
                    })
                    .unwrap_or_default();
                let added: Vec<_> = project
                    .lane_specs
                    .iter()
                    .filter(|l| {
                        l.custom
                            && !self
                                .project
                                .as_ref()
                                .is_some_and(|old| old.lane_specs.iter().any(|o| o.id == l.id))
                    })
                    .map(|l| l.label.clone())
                    .collect();
                let full = self.view_start == 0. && self.view_end == 1.;
                if !full && status.duration > 0. {
                    self.view_start =
                        (self.view_start * previous / status.duration).clamp(0., 0.999);
                    self.view_end = (self.view_end * previous / status.duration)
                        .clamp(self.view_start + 0.001, 1.);
                }

                self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
                self.native_graph = status.graph_generation;
                self.native_lane_revision = status.lane_revision;
                self.native_carry_revision=status.carry_revision;
                #[cfg(feature = "ui-tests")]
                {
                    self.last_playback_status = Some(status.clone());
                }
                self.position = status.position;
                self.duration = status.duration;
                self.playing = status.playing;
                self.native_anchor = Some((status.position, status.sampled_at));
                self.native_rate = status.rate;
                self.native_seek_count = status.seek_count;
                self.native_loop = status.loop_range;
                self.native_loop_count = status.loop_count;
                self.looping = status.loop_range.is_some();
                project.looping = self.looping;
                project.selection = project.selection.and_then(|(start, end)| {
                    let end = end.min(status.duration);
                    (start < end).then_some((start, end))
                });
                self.pending_seek = None;
                self.native_floor = None;
                self.muted = project.muted;
                self.solo = project.solo;
                self.gain = project.gain.map(|v| (v * 100.).round() as u8);
                let mut envelopes = std::array::from_fn(|_| vec![0.]);
                for (lane, (slot, _)) in project.lanes.iter().enumerate() {
                    if let Some(p) = peaks.get(lane).filter(|p| !p.is_empty()) {
                        envelopes[*slot] = p.clone();
                    }
                }
                waveform::set_project_peaks(envelopes);
                self.transport
                    .update(cx, |t, cx| t.set_duration(status.duration, cx));
                if !added.is_empty() {
                    let names = added.join(", ");
                    self.notice = Some(if status.duration > previous + 0.05 {
                        format!(
                            "Added {names}. The song now ends at {}:{:02}.",
                            (status.duration / 60.) as u32,
                            status.duration as u32 % 60
                        )
                    } else {
                        format!("Added {names}, aligned from the start of the song.")
                    });
                }
                self.pitch_strip.update(cx, |strip, cx| {
                    strip.update_native_timeline(project.pitch.clone(), cx)
                });
                if !project.track_warnings.is_empty() {
                    let warning = project.track_warnings.join("\n");
                    self.notice = Some(
                        self.notice
                            .take()
                            .map(|notice| format!("{notice}\n{warning}"))
                            .unwrap_or(warning),
                    );
                }
                let empty = project.empty_tracks;
                self.project = Some(project);
                if empty {
                    self.empty_timeline(cx);
                } else {
                    self.transport
                        .update(cx, |t, cx| t.set_audio_available(true, cx));
                }
                self.edit_seq += 1;
            }
            Err(error) => self.notice = Some(format!("Could not change tracks: {error}")),
        }
        cx.notify();
    }
}

//! Accepted Carry settings, serialized rescheduling and native receipt fences.
use super::*;
pub(super) type Stamp = (u64, u64, usize, u64);
pub(super) struct Pending {
    pub epoch: u64,
    pub serial: u64,
    pub plan: carry_line::Plan,
    pub document: Arc<project_lyrics::Document>,
    pub stamp: Stamp,
}
impl Player {
    fn carry_stamp_now(&self) -> Stamp {
        (
            self.native_epoch,
            self.native_lane_revision,
            Arc::as_ptr(&self.lyric_document) as usize,
            self.duration.to_bits(),
        )
    }
    fn carry_plan_for(&self, desired: carry_line::Desired) -> Result<carry_line::Plan> {
        let project = self
            .project
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Open a song first"))?;
        carry_line::Plan::capture(
            desired,
            &project.lane_specs,
            (!self.lyric_document.lines.is_empty()).then_some(self.lyric_document.lines.as_slice()),
            self.duration as f64,
            !project.original && project.has_audio(),
        )
    }
    pub(super) fn defer_carry_navigation(
        &mut self,
        path: std::path::PathBuf,
        source: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.carry_pending.is_some()
            || self.carry_save_requested
            || self.carry_navigation.is_some()
        {
            self.carry_navigation = Some((path, source));
            self.carry_open = false;
            cx.notify();
            true
        } else {
            false
        }
    }
    pub(super) fn flush_carry_navigation(&mut self, cx: &mut Context<Self>) {
        if self.audio_recovery.is_some() || self.source_publication.is_some() { return; }
        if self.carry_pending.is_some()
            || self.carry_save_requested
            || self.saving
            || self.loading
            || self.notice.is_some()
        {
            return;
        }
        if let Some((path, source)) = self.carry_navigation.take() {
            if source {
                self.open_source(path, cx);
            } else {
                self.open_project(path, cx);
            }
        }
    }
    pub(super) fn reset_carry(&mut self, cx: &mut Context<Self>) {
        self.carry_open = false;
        self.carry_navigation = None;
        self.carry_save_requested = false;
        self.carry_pending = None;
        self.carry_plan = None;
        self.carry_document = None;
        self.carry_mask = None;
        self.carry_stamp = None;
        self.carry_attempt_stamp = None;
        self.native_carry_revision = 0;
        self.carry.enabled = false;
        self.transport
            .update(cx, |t, cx| t.set_carry_state(false, false, cx));
    }
    pub(super) fn opened_carry(&mut self, status: &integration::Status, cx: &mut Context<Self>) {
        self.carry_open = false;
        self.carry_navigation = None;
        self.carry_save_requested = false;
        self.carry_pending = None;
        self.native_carry_revision = status.carry_revision;
        self.carry = self
            .project
            .as_ref()
            .map(|p| p.carry.clone())
            .unwrap_or_default();
        self.carry_plan = self.carry_plan_for(self.carry.clone()).ok();
        self.carry_document = Some(self.lyric_document.clone());
        self.carry_mask = carry_line::sing_mask(
            self.carry.enabled,
            &self.carry.config,
            self.lyric_document.lines.len(),
        )
        .map(Arc::new);
        self.carry_stamp = Some(self.carry_stamp_now());
        self.carry_attempt_stamp = self.carry_stamp;
        self.adopt_carry_preferences(cx);
    }
    pub(super) fn adopt_carry_preferences(&mut self, cx: &mut Context<Self>) {
        if let Some(backend) = &self.backend {
            if let Err(error) =
                backend.adopt_carry_preferences(self.native_epoch, self.carry.config.clone())
            {
                diagnostics::event("carry", error.to_string(), diagnostics::Level::Error);
                self.notice = Some(error.to_string());
                cx.notify();
            }
        }
    }
    pub(super) fn toggle_carry_popover(&mut self, cx: &mut Context<Self>) {
        if self.carry_open {
            self.carry_open = false;
            cx.notify();
            return;
        }
        if !self.audio_available()
            || self.loading
            || self.source_blocks_player()
            || self.screen != Screen::Player
            || self.stem_export_open
            || self.project_picker_open
            || self.library_import_open
            || self.lyrics_editor_open
            || self.notice.is_some()
        {
            return;
        }
        self.carry_open = !self.carry_open;
        if self.carry_open {
            self.metronome_open = false;
            self.transport.update(cx, |t, cx| t.dismiss_popovers(cx));
            self.carry_popover.update(cx, |p, cx| p.on_open(cx));
        }
        cx.notify();
    }
    pub(super) fn change_carry(&mut self, desired: carry_line::Desired, cx: &mut Context<Self>) {
        if self.carry_pending.is_some()
            || self.loading
            || self.saving
            || self.source_blocks_player()
            || self.monitor_busy()
            || self.metronome_pending.is_some()
            || self.rename_pending.is_some()
            || self.import_pending.is_some()
        {
            return;
        }
        if desired == self.carry {
            return;
        }
        if desired.config.mode == carry_line::Mode::Lines
            && self.lyric_document.lines.is_empty()
            && self.lyrics_sidebar_pending.is_none()
            && self.lyrics_sidebar_needs.is_empty()
            && !self.lyrics_sidebar_download_waiting
        {
            self.start_sidebar_lyrics(self.lyrics_sidebar_intent, cx);
        }
        self.submit_carry(desired, cx);
    }
    fn submit_carry(&mut self, desired: carry_line::Desired, cx: &mut Context<Self>) {
        let plan = match self.carry_plan_for(desired) {
            Ok(plan) => plan,
            Err(e) => {
                self.notice = Some(format!("Could not apply Carry the line: {e}"));
                cx.notify();
                return;
            }
        };
        if let Some(backend) = &self.backend {
            self.carry_serial += 1;
            let serial = self.carry_serial;
            match backend.carry(self.native_epoch, serial, plan.clone()) {
                Ok(()) => {
                    self.carry_attempt_stamp = Some(self.carry_stamp_now());
                    self.carry_pending = Some(Pending {
                        epoch: self.native_epoch,
                        serial,
                        plan,
                        document: self.lyric_document.clone(),
                        stamp: self.carry_stamp_now(),
                    });
                }
                Err(error) => {
                    self.notice = Some(format!("Could not apply Carry the line: {error}"))
                }
            }
        }
        cx.notify();
    }
    pub(super) fn carried(
        &mut self,
        epoch: u64,
        serial: u64,
        result: Result<(carry_line::Desired, integration::Status), String>,
        cx: &mut Context<Self>,
    ) {
        if epoch != self.native_epoch
            || !self
                .carry_pending
                .as_ref()
                .is_some_and(|p| p.epoch == epoch && p.serial == serial)
        {
            return;
        }
        let pending = self.carry_pending.take().unwrap();
        match result {
            Ok((desired, status)) => {
                let changed = self.carry != desired;
                if !self.carry.enabled && desired.enabled && pending.plan.on {
                    for lane in self
                        .project
                        .as_ref()
                        .into_iter()
                        .flat_map(|p| p.lane_specs.iter())
                    {
                        if pending.plan.lane_ids.contains(&lane.id) {
                            self.muted[lane.slot] = false;
                        }
                    }
                }
                self.carry = desired;
                self.carry_stamp = Some(pending.stamp);
                self.carry_plan = Some(pending.plan);
                self.carry_mask = carry_line::sing_mask(
                    self.carry.enabled,
                    &self.carry.config,
                    pending.document.lines.len(),
                )
                .map(Arc::new);
                self.carry_document = Some(pending.document);
                self.native_carry_revision = status.carry_revision;
                if let Some(project) = &mut self.project {
                    project.carry = self.carry.clone();
                    project.muted = self.muted;
                }
                self.playback_status(epoch, status, cx);
                if changed {
                    self.edit_seq += 1;
                    self.adopt_carry_preferences(cx);
                }
                if self.carry_save_requested {
                    self.carry_save_requested = false;
                    // Share the existing publication lifecycle: a working-copy
                    // Save finishes by reopening its published destination.
                    // Its queued navigation must survive that internal Open.
                    self.metronome_save_requested = true;
                    if let Some(navigation) = self.carry_navigation.take() {
                        self.metronome_navigation = Some(navigation);
                    }
                }
            }
            Err(error) => {
                let queued = std::mem::take(&mut self.carry_save_requested);
                self.notice = Some(format!(
                    "Carry the line was not applied: {error}{}",
                    if queued {
                        format!(" {}", crate::i18n::t("carryLine.queuedSaveDidNotRun"))
                    } else {
                        String::new()
                    }
                ));
            }
        }
        cx.notify();
    }
    pub(super) fn failed_carry(
        &mut self,
        epoch: u64,
        serial: u64,
        desired: Option<carry_line::Desired>,
        error: String,
        cx: &mut Context<Self>,
    ) {
        if epoch != self.native_epoch
            || !self
                .carry_pending
                .as_ref()
                .is_some_and(|p| p.epoch == epoch && p.serial == serial)
        {
            return;
        }
        let pending = self.carry_pending.take().unwrap();
        self.carry_save_requested = false;
        self.carry_open = false;
        self.carry_plan = None;
        self.carry_document = None;
        self.carry_mask = None;
        self.carry_stamp = None;
        self.carry_attempt_stamp = None;
        self.tracks_audio_failed = true;
        self.playing = false;
        self.playhead.stop_projection();

        if let Some(desired) = desired {
            if !self.carry.enabled && desired.enabled && pending.plan.on {
                for lane in self
                    .project
                    .as_ref()
                    .into_iter()
                    .flat_map(|p| p.lane_specs.iter())
                {
                    if pending.plan.lane_ids.contains(&lane.id) {
                        self.muted[lane.slot] = false;
                    }
                }
            }
            self.carry = desired;
            if let Some(project) = &mut self.project {
                project.carry = self.carry.clone();
                project.muted = self.muted;
            }
            self.edit_seq += 1;
        }
        self.notice = Some(format!(
            "{error} Retry the output route in Settings before resuming playback."
        ));
        cx.notify();
    }
    pub(super) fn flush_carry(&mut self, cx: &mut Context<Self>) {
        if !self.carry.enabled
            || self.carry_pending.is_some()
            || self.loading
            || self.saving
            || self.source_blocks_player()
            || self.metronome_pending.is_some()
            || self.monitor_busy()
            || self.rename_pending.is_some()
            || self.import_pending.is_some()
        {
            return;
        }
        if self.carry_stamp != Some(self.carry_stamp_now())
            && self.carry_attempt_stamp != Some(self.carry_stamp_now())
        {
            self.submit_carry(self.carry.clone(), cx);
        }
    }
    pub(super) fn carry_paint_mask(&self) -> Option<Arc<Vec<bool>>> {
        if !self.carry.enabled
            || !self
                .carry_document
                .as_ref()
                .is_some_and(|document| Arc::ptr_eq(document, &self.lyric_document))
        {
            return None;
        }
        self.carry_mask.clone()
    }
    #[cfg(feature = "ui-tests")]
    pub(super) fn carry_sing_mask(&self) -> Option<Vec<bool>> {
        self.carry_paint_mask().map(|mask| mask.as_ref().clone())
    }
    pub(super) fn refresh_carry_widget(&mut self, cx: &mut Context<Self>) {
        let ducking = self.carry_plan.as_ref().is_some_and(|p| {
            p.on && !p.lane_ids.is_empty()
                && !self.counting_in
                && if p.mode == 0 {
                    (self.playhead.position() as f64 / p.period_sec).floor() as u64 % 2 == 1
                } else {
                    let i = p.windows.partition_point(|w| w.s <= self.playhead.position() as f64);
                    i > 0 && (self.playhead.position() as f64) < p.windows[i - 1].e
                }
        });
        self.transport.update(cx, |t, cx| {
            t.set_carry_state(self.carry.enabled, ducking, cx)
        });
        if self.carry_open {
            let mut lanes = self
                .project
                .as_ref()
                .map(|p| p.lane_specs.clone())
                .unwrap_or_default();
            // Display labels only: stable lane IDs, custom names and accepted
            // scheduling state remain owned by the project/backend.
            for lane in &mut lanes {
                lane.label = self.lane_label(lane.slot).to_string();
            }
            let trigger = self.transport.read(cx).guides.get("carry");
            let busy = self.carry_pending.is_some()
                || self.loading
                || self.saving
                || self.source_blocks_player()
                || self.monitor_busy()
                || self.metronome_pending.is_some()
                || self.rename_pending.is_some()
                || self.import_pending.is_some();
            self.carry_popover.update(cx, |p, cx| {
                p.context(
                    self.carry.clone(),
                    lanes,
                    !self.lyric_document.lines.is_empty(),
                    busy,
                    cx,
                );
                p.set_trigger(trigger, cx);
            });
        }
    }
}

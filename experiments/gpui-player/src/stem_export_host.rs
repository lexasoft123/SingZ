//! Host-owned chooser/session fences for offline source-audio export.
use super::*;

impl Player {
    pub(super) fn open_stem_export(&mut self, cx: &mut Context<Self>) {
        if self.stem_export_open || self.backend.is_none() || !self.audio_available()
            || self.loading || self.tracks_flight.tracks_pending.is_some() || self.source_blocks_player()
            || self.lyrics_editor_open || self.project_picker_open || self.library_import_open
            || self.project_delete.read(cx).is_open() || self.notice.is_some()
        { return; }
        let Some(project) = &self.project else { return; };
        self.stem_export_lanes = project.lane_specs.clone();
        self.stem_export_session = self.stem_export_session.wrapping_add(1);
        self.stem_export_close_pending = false;
        self.stem_export_open = true;
        self.metronome_open = false;
        self.header.update(cx, |h,cx| h.cancel_title(cx));
        self.transport.update(cx, |t,cx| t.dismiss_popovers(cx));
        self.stem_export_dialog.update(cx, |d,cx| d.open(self.stem_export_lanes.clone(),cx));
        cx.notify();
    }

    pub(super) fn close_stem_export(&mut self, cx: &mut Context<Self>) {
        if !self.stem_export_open { return; }
        if let Some(id) = self.stem_export_job {
            if let Some(service) = &self.stem_export_service { service.cancel(id); }
        }
        if self.stem_export_prompt || self.stem_export_job.is_some() {
            self.stem_export_close_pending = true;
        } else {
            self.detach_stem_export(cx);
        }
        cx.notify();
    }

    /// Navigation destroys the old modal, while its owned worker still cleans up.
    pub(super) fn detach_stem_export(&mut self, cx: &mut Context<Self>) {
        if let Some(id) = self.stem_export_job.take() {
            if let Some(service) = &self.stem_export_service { service.cancel(id); }
        }
        self.stem_export_open = false;
        self.stem_export_session = self.stem_export_session.wrapping_add(1);
        self.stem_export_prompt = false;
        self.stem_export_close_pending = false;
        self.stem_export_lanes.clear();
        cx.notify();
    }

    pub(super) fn start_stem_export(&mut self, mode: stem_export::Mode, format: stem_export::Format,
                         selected: Vec<String>, cx: &mut Context<Self>) {
        if !self.stem_export_open || self.stem_export_prompt || self.stem_export_job.is_some() { return; }
        // Capture before the chooser; neither a later song nor new mix settings
        // may replace the sources belonging to this request.
        let plan = match stem_export::Plan::capture_with_karaoke_label(&self.stem_export_lanes,&selected,mode,format,&i18n::t("player.stack.exportKaraoke")) {
            Ok(plan) => plan,
            Err(error) => {
                self.stem_export_dialog.update(cx, |d,cx| { d.set_busy(false,cx); d.set_status(format!("{}: {error}",i18n::t("player.stack.exportError")),cx); });
                return;
            }
        };
        let session = self.stem_export_session;
        self.stem_export_prompt = true;
        self.stem_export_dialog.update(cx, |d,cx| { d.set_status(String::new(),cx); d.set_busy(true,cx); });
        #[cfg(feature="ui-tests")]
        if std::env::var_os("SINGZ_GPUI_STEM_EXPORT_TEST").is_some() {
            if let Some(path) = self.stem_export_picker_paths.pop_front() {
                self.finish_stem_export_prompt(session,plan,Ok(path),cx);
                return;
            }
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files:false, directories:true, multiple:false,
            prompt:Some("Choose export folder".into()),
        });
        cx.spawn(async move |this,cx| {
            let result = match prompt.await {
                Ok(Ok(paths)) => Ok(paths.and_then(|paths|paths.into_iter().next())),
                Ok(Err(error)) => Err(error.to_string()),
                Err(error) => Err(error.to_string()),
            };
            let _ = this.update(cx, |s,cx| s.finish_stem_export_prompt(session,plan,result,cx));
        }).detach();
        cx.notify();
    }

    pub(super) fn finish_stem_export_prompt(&mut self,session:u64,plan:stem_export::Plan,
        result:Result<Option<std::path::PathBuf>,String>,cx:&mut Context<Self>) {
        if !self.stem_export_open || self.stem_export_session != session { return; }
        self.stem_export_prompt = false;
        if self.stem_export_close_pending { self.detach_stem_export(cx); return; }
        match result {
            Ok(Some(destination)) => {
                let result = self.stem_export_service.as_ref()
                    .ok_or_else(|| anyhow::anyhow!("Native audio export is unavailable"))
                    .and_then(|service| service.start(plan,destination));
                match result {
                    Ok(id) => { self.stem_export_job = Some(id); cx.notify(); return; }
                    Err(error) => self.stem_export_dialog.update(cx, |d,cx| d.set_status(format!("{}: {error}",i18n::t("player.stack.exportError")),cx)),
                }
            }
            Err(error) => self.stem_export_dialog.update(cx, |d,cx| d.set_status(format!("{}: {error}",i18n::t("player.stack.exportError")),cx)),
            Ok(None) => {}
        }
        self.stem_export_dialog.update(cx, |d,cx| d.set_busy(false,cx));
        cx.notify();
    }

    pub(super) fn poll_stem_export(&mut self, cx: &mut Context<Self>) {
        let events = self.stem_export_service.as_ref().map(|s| s.drain()).unwrap_or_default();
        for event in events {
            if !self.stem_export_open || self.stem_export_job != Some(event.id) { continue; }
            match event.kind {
                stem_export::EventKind::Progress{index,total,label} => {
                    self.stem_export_dialog.update(cx, |d,cx| d.set_status(format!("{} {index}/{total}: {label}",i18n::t("player.stack.exportProgress")),cx));
                }
                stem_export::EventKind::Finished{files:_,cancelled:_,error} => {
                    #[cfg(feature="ui-tests")]
                    self.stem_export_finished_ids.push(event.id);
                    self.stem_export_job = None;
                    if self.stem_export_close_pending { self.detach_stem_export(cx); }
                    else {
                        let status = error.map(|e|format!("{}: {e}",i18n::t("player.stack.exportError"))).unwrap_or_else(||i18n::t("player.stack.exportDone"));
                        crate::a11y::announce(status.clone());
                        self.stem_export_dialog.update(cx, |d,cx| {
                            d.set_busy(false,cx);
                            d.set_status(status,cx);
                        });
                    }
                }
            }
        }
    }
}

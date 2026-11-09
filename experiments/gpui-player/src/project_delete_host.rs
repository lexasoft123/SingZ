//! Library confirmation and native project retirement. All filesystem work is
//! dispatched to the backend; a loaded-project failure reopens paused audio.
use super::*;
use std::time::Duration;

impl Player {
    pub(super) fn cancel_delete_inspection(&mut self) {
        if self.delete_inspect_pending.take().is_some() {
            self.delete_serial += 1;
        }
    }
    fn delete_project_operation_busy(&self) -> bool {
        self.rate_busy() || self.carry_pending.is_some() || self.tracks_pending.is_some()
            || self.loading
            || self.saving
            || self.source_job.is_some()
            || self.audio_recovery.is_some()
            || self.source_publication.is_some()
            || self.rename_pending.is_some()
            || self.import_pending.is_some()
            || self.project_library_moving
            || self.metronome_pending.is_some()
            || self.metronome_save_requested
            || self.metronome_save_waiting
    }
    fn delete_error(&mut self, error: String, cx: &mut Context<Self>) {
        diagnostics::event(
            "projects",
            format!("Deletion failed: {error}"),
            diagnostics::Level::Warn,
        );
        self.library.update(cx, |library, cx| {
            library.set_delete_error(Some(format!("Could not delete it: {error}")), cx)
        });
    }
    fn delete_target_loaded(&self, dir: &std::path::Path) -> bool {
        self.project.as_ref().is_some_and(|p| p.dir == dir)
            || self
                .source_target
                .as_ref()
                .is_some_and(|target| target.dir == dir)
    }
    pub(super) fn begin_project_delete(&mut self, dir: std::path::PathBuf, cx: &mut Context<Self>) {
        if self.screen != Screen::Library
            || self.project_delete.read(cx).is_open()
            || self.delete_pending.is_some()
            || self.notice.is_some()
            || self.project_picker_open
            || self.library_import_open
            || self.lyrics_editor_open
            || self.quick_start.read(cx).is_open()
            || self.whats_new.read(cx).is_open()
            || self.engine_setup.read(cx).is_open()
        {
            return;
        }
        if self.delete_project_operation_busy() {
            self.delete_error(
                "Wait for the current project operation to finish before deleting.".into(),
                cx,
            );
            return;
        }
        self.delete_serial += 1;
        let serial = self.delete_serial;
        self.library
            .update(cx, |library, cx| library.set_delete_error(None, cx));
        let root = self.catalog_root.clone();
        if let Some(backend) = &self.backend {
            match backend.inspect_delete(root.clone(), dir, serial) {
                Ok(()) => self.delete_inspect_pending = Some((serial, root)),
                Err(error) => self.delete_error(error.to_string(), cx),
            }
        }
        cx.notify();
    }
    pub(super) fn close_project_delete(&mut self, cx: &mut Context<Self>) {
        if self.delete_pending.is_some() || self.delete_waiting_monitor.is_some() {
            return;
        }
        self.cancel_delete_inspection();
        self.delete_target = None;
        self.project_delete
            .update(cx, |dialog, cx| dialog.close(cx));
        cx.notify();
    }
    pub(super) fn inspected_project_delete(
        &mut self,
        serial: u64,
        result: Result<project_delete::Target, String>,
        cx: &mut Context<Self>,
    ) {
        let Some((id, root)) = self.delete_inspect_pending.as_ref() else {
            return;
        };
        if *id != serial {
            return;
        }
        let root = root.clone();
        self.delete_inspect_pending = None;
        if self.screen != Screen::Library
            || root != self.catalog_root
            || self.notice.is_some()
            || self.project_picker_open
            || self.library_import_open
            || self.quick_start.read(cx).is_open()
            || self.whats_new.read(cx).is_open()
            || self.engine_setup.read(cx).is_open()
        {
            return;
        }
        match result {
            Ok(target) => {
                let details = project_delete_dialog::Details {
                    name: target.name.clone(),
                    stem_count: target.stem_count,
                    has_lyrics: target.has_lyrics,
                    bytes: target.bytes,
                    opened: self.delete_target_loaded(&target.dir),
                };
                self.delete_target = Some(target);
                self.header.update(cx, |header, cx| header.cancel_title(cx));
                self.project_delete
                    .update(cx, |dialog, cx| dialog.open(details, cx));
            }
            Err(error) => self.delete_error(error, cx),
        }
        cx.notify();
    }
    pub(super) fn confirm_project_delete(&mut self, cx: &mut Context<Self>) {
        if self.delete_pending.is_some() || self.delete_waiting_monitor.is_some() {
            return;
        }
        let Some(target) = self.delete_target.as_ref() else {
            self.project_delete
                .update(cx, |d, cx| d.set_busy(false, cx));
            return;
        };
        if !self.project_delete.read(cx).is_open() {
            return;
        }
        if self.delete_project_operation_busy() {
            self.project_delete
                .update(cx, |d, cx| d.set_busy(false, cx));
            self.close_project_delete(cx);
            self.delete_error(
                "The project is busy. Finish its current operation and review deletion again."
                    .into(),
                cx,
            );
            return;
        }
        self.project_delete.update(cx, |d, cx| d.set_busy(true, cx));
        if self.delete_target_loaded(&target.dir) && self.monitor_busy() {
            self.monitor_requested = false;
            self.delete_waiting_monitor = Some(Instant::now());
            cx.notify();
            return;
        }
        self.dispatch_project_delete(cx);
    }
    fn dispatch_project_delete(&mut self, cx: &mut Context<Self>) {
        let Some(target) = self.delete_target.clone() else {
            return;
        };
        let loaded = self.delete_target_loaded(&target.dir);
        let restore = if loaded {
            self.project.as_ref().map(|project| DeleteRestore {
                active_dir: project.dir.clone(),
                working: self.source_working,
                target: self.source_target.clone(),
                resume: SourceResume {
                    restart_cycle:self.restart_cycle.snapshot(self.region_target().selection,false),
                    play_serial:self.native_play_serial,
                    position: self.position,
                    playing: false,
                    mode: None,
                    title: Some(self.song_title.to_string()),
                    dirty: self.edit_seq != self.saved_seq,
                    mix: self.current_mix(project),
                },
            })
        } else {
            None
        };
        let result = self
            .backend
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Native project deletion is unavailable."))
            .and_then(|backend| backend.delete(target, self.delete_serial, loaded));
        match result {
            Ok((epoch, loaded)) => {
                self.delete_pending = Some(DeletePending {
                    serial: self.delete_serial,
                    epoch,
                    loaded,
                    restore,
                });
                if loaded {
                    self.native_epoch = epoch;
                    self.loading = true;
                    self.playing = false;
                    self.native_anchor = None;
                    self.pending_seek = None;
                    self.native_floor = None;
                    self.counting_in = false;
                    self.count_in_anchor = None;
                    self.cancel_sidebar_lyrics(cx);
                    self.lyrics_sidebar_pending = None;
                    self.lyrics_search_pending = None;
                    self.lyrics_sidebar_editor_after = false;
                    self.lyrics_sidebar_import_after = None;
                    self.lyrics_sidebar_rename_after = None;
                    self.cancel_lyrics_alignment(cx);
                    self.beat_job = None;
                    self.beat_result = None;
                    self.beat_auto_serials.clear();
                    self.beat_auto_save = false;
                    self.stop_training(cx);
                }
            }
            Err(error) => {
                self.project_delete
                    .update(cx, |d, cx| d.set_busy(false, cx));
                self.close_project_delete(cx);
                self.delete_error(error.to_string(), cx);
            }
        }
        cx.notify();
    }
    pub(super) fn poll_project_delete(&mut self, cx: &mut Context<Self>) {
        if let Some(started) = self.delete_waiting_monitor {
            if !self.monitor_busy() {
                self.delete_waiting_monitor = None;
                self.dispatch_project_delete(cx);
            } else if started.elapsed() > Duration::from_secs(8) {
                self.delete_waiting_monitor = None;
                self.project_delete
                    .update(cx, |d, cx| d.set_busy(false, cx));
                self.close_project_delete(cx);
                self.delete_error(
                    "Could not finish microphone monitoring cleanup. The project was not deleted."
                        .into(),
                    cx,
                );
            }
        }
    }
    pub(super) fn deleted_project(
        &mut self,
        serial: u64,
        epoch: u64,
        loaded: bool,
        result: Result<project_delete::Outcome, String>,
        cx: &mut Context<Self>,
    ) {
        if !self.delete_pending.as_ref().is_some_and(|pending| {
            pending.serial == serial && pending.epoch == epoch && pending.loaded == loaded
        }) {
            return;
        }
        let pending = self.delete_pending.take().unwrap();
        let confirmed = self.delete_target.take();
        self.project_delete
            .update(cx, |d, cx| d.set_busy(false, cx));
        self.close_project_delete(cx);
        match result {
            Ok(outcome) => {
                diagnostics::event(
                    "projects",
                    format!("Project deleted: {}", outcome.dir.display()),
                    diagnostics::Level::Info,
                );
                if loaded && self.native_epoch == epoch {
                    self.clear_deleted_project(cx);
                }
                if let Some(warning) = outcome.warning {
                    self.library.update(cx, |library, cx| {
                        library.set_delete_error(Some(warning), cx)
                    });
                }
            }
            Err(error) => {
                if loaded && self.native_epoch == epoch {
                    self.loading = false;
                    if let Some(restore) = pending.restore {
                        let before = self.native_epoch;
                        let guard = confirmed.filter(|target| target.dir == restore.active_dir);
                        let overlay=self.project.as_ref().map(|project|integration::OpenCustomOverlay{source_dir:project.dir.clone(),mix:restore.resume.mix.clone(),preserve_generated:false});
                        self.open_project_with_overlay(restore.active_dir,guard,overlay,cx);
                        if self.native_epoch != before {
                            self.source_pending = Some((
                                self.native_epoch,
                                restore.working,
                                restore.target,
                                Some(restore.resume),
                            ));
                        } else {
                            // Deletion already released the audio connection. A rejected
                            // recovery request must not leave its old song marked loaded.
                            self.clear_deleted_project(cx);
                        }
                    } else {
                        self.clear_deleted_project(cx);
                    }
                }
                self.delete_error(error, cx);
            }
        }
        if let Some(backend) = &self.backend {
            backend.catalog();
        }
        cx.notify();
    }
    pub(super) fn clear_deleted_project(&mut self, cx: &mut Context<Self>) {
        self.cancel_source_publication(cx);
        self.reset_transport_timing(cx);
        self.loading = false;
        self.saving = false;
        self.playing = false;
        self.native_anchor = None;
        self.loaded_song = false;
        self.project = None;
        self.settings.update(cx, |settings, cx| settings.set_playback_status(None, cx));
        self.lane_entered.clear();
        self.song_title = "".into();
        self.song_artist = "".into();
        self.source_working = false;
        self.source_target = None;
        self.source_pending = None;
        self.rename_pending = None;
        self.edit_seq = 0;
        self.saved_seq = 0;
        self.position = 0.;
        self.karaoke = false;
        self.looping = false;
        self.pending_seek = None;
        self.native_floor = None;
        self.native_loop = None;
        self.counting_in = false;
        self.count_in_anchor = None;
        self.beats = None;
        self.paint_beats = None;
        self.beat_job = None;
        self.beat_result = None;
        self.beat_auto_serials.clear();
        self.beat_auto_save = false;
        self.metronome_pending = None;
        self.metronome_requested = None;
        self.metronome_save_requested = false;
        self.metronome_save_waiting = false;
        self.metronome_navigation = None;
        self.metronome_open = false;
        self.lyric_document = Arc::default();
        self.native_glows.borrow_mut().clear();
        self.shape_cache.borrow_mut().clear();
        *self.layout_cache.borrow_mut() = None;
        self.lyric_hits.borrow_mut().clear();
        self.lyric_scroll.set(0.);
        self.lyric_scroll_target.set(0.);
        self.lyric_active.set(usize::MAX);
        self.lyrics_editor_open = false;
        self.lyrics_editor_pending = None;
        self.lyrics_alignment_pending = None;
        self.stop_training(cx);
        self.training.update(cx, |screen, cx| screen.clear_song(cx));
        self.library
            .update(cx, |library, cx| library.set_open_song(None, cx));
        self.lyrics_sidebar
            .update(cx, |sidebar, cx| sidebar.idle(cx));
        self.transport.update(cx, |t, cx| t.set_karaoke(false, cx));
        waveform::set_project_peaks(std::array::from_fn(|_| vec![0.]));
        self.screen = Screen::Library;
        self.previous_screen = Screen::Library;
    }
}

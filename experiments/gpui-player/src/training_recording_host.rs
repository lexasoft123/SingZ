//! Training controls -> existing capture owner -> retained WAV -> native Save.
use super::*;

impl Player {
    fn training_recording_active(&self) -> bool {
        self.screen == Screen::Training
            && self.notice.is_none()
            && !self.loading
            && !self.monitor_busy()
            && self.practice.as_ref().is_some_and(|run| {
                run.session.config().task != training_domain::Task::Identify
                    && matches!(
                        run.phase,
                        training_run::Phase::Cue
                            | training_run::Phase::Respond
                            | training_run::Phase::Feedback
                    )
            })
    }
    fn recording_context(&self) -> Option<String> {
        self.practice
            .as_ref()
            .filter(|run| {
                self.screen == Screen::Training
                    && run.session.config().task != training_domain::Task::Identify
                    && run.phase != training_run::Phase::Summary
            })
            .map(|run| run.session.id().to_owned())
    }
    pub(super) fn start_training_recording(&mut self, cx: &mut Context<Self>) {
        self.training_recorder.set_context(self.recording_context());
        if !self.training_recording_active()
            || self.mic_view.owner != training_capture::TRAINING_OWNER
            || self.mic_view.phase != microphone::Phase::Live
        {
            return;
        }
        let Some(command) = self.training_recorder.begin(self.mic_view.generation) else {
            return;
        };
        let result = self
            .microphone
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The microphone is unavailable."))
            .and_then(|service| {
                service.record(
                    command.generation,
                    command.take_id,
                    audio_devices::directory().join("training-recordings"),
                )
            });
        if let Err(error) = result {
            self.training_recorder
                .finished(command, Err(error.to_string()));
        }
        self.update_training_recording_view(cx);
    }
    fn send_recording_finish(&mut self, command: training_recording::Command) {
        let result = self
            .microphone
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("The microphone is unavailable."))
            .and_then(|service| service.finish_recording(command.generation, command.take_id));
        if let Err(error) = result {
            self.training_recorder
                .finish_queue_failed(command, error.to_string());
        }
    }
    pub(super) fn finish_training_recording(&mut self, cx: &mut Context<Self>) {
        if let Some(command) = self.training_recorder.finish() {
            self.send_recording_finish(command);
        }
        self.update_training_recording_view(cx);
    }
    pub(super) fn detach_training_recording(&mut self, cx: &mut Context<Self>) {
        self.training_recorder.set_context(None);
        self.finish_training_recording(cx);
    }
    fn update_training_recording_view(&mut self, cx: &mut Context<Self>) {
        let view = training::RecordingView {
            recording: self.training_recorder.recording(),
            busy: self.training_recorder.busy(),
            can_record: self.training_recording_active()
                && self.training_recorder.can_begin()
                && self.mic_view.owner == training_capture::TRAINING_OWNER
                && self.mic_view.phase == microphone::Phase::Live,
            has_take: self.training_recorder.take.is_some(),
            message: self.training_recorder.message.clone(),
        };
        self.training
            .update(cx, |training, cx| training.set_recording(view, cx));
    }
    pub(super) fn poll_training_recording(&mut self, cx: &mut Context<Self>) {
        self.training_recorder.set_context(self.recording_context());
        let events = self
            .microphone
            .as_ref()
            .map(|s| s.drain_recordings())
            .unwrap_or_default();
        for event in events {
            let command = training_recording::Command {
                generation: event.generation,
                take_id: event.take_id,
            };
            match event.state {
                microphone::RecordingState::Started => {
                    crate::a11y::announce_recording(crate::a11y::Recording::Started);
                    self.training_recorder.started(command, Instant::now())
                }
                microphone::RecordingState::Finished {
                    path,
                    filename,
                    seconds,
                    sample_rate,
                } => {
                    crate::a11y::announce_recording(crate::a11y::Recording::Stopped);
                    self.training_recorder.finished(
                        command,
                        Ok(training_recording::Take {
                            id: event.take_id,
                            path,
                            filename,
                            seconds,
                            sample_rate,
                            recovery: None,
                        }),
                    );
                }
                microphone::RecordingState::Error { message } => {
                    crate::a11y::announce_recording(crate::a11y::Recording::Failed);
                    diagnostics::event(
                        "training-recording",
                        message.clone(),
                        diagnostics::Level::Warn,
                    );
                    self.training_recorder.finished(command, Err(message));
                }
                microphone::RecordingState::Recoverable { recovery, message } => {
                    diagnostics::event("training-recording", message, diagnostics::Level::Warn);
                    let take = training_recording::Take {
                        id: event.take_id,
                        path: recovery.path().to_owned(),
                        filename: recovery.filename().to_owned(),
                        seconds: recovery.seconds(),
                        sample_rate: recovery.sample_rate(),
                        recovery: Some(recovery),
                    };
                    self.training_recorder.finished(command, Ok(take));
                }
            }
        }
        let active = self.training_recording_active()
            && self.mic_view.owner == training_capture::TRAINING_OWNER
            && self.mic_view.phase == microphone::Phase::Live;
        if let Some(command) = self
            .training_recorder
            .finish_if_needed(active, Instant::now())
        {
            self.send_recording_finish(command);
        }
        let exports = self
            .training_recording_store
            .as_ref()
            .map(|s| s.drain())
            .unwrap_or_default();
        for event in exports {
            let Some((context, take_id)) = self.training_recording_exports.remove(&event.id) else {
                continue;
            };
            match event.result {
                Ok(path) => { diagnostics::event(
                    "training-recording",
                    format!("Exported training WAV to {}", path.display()),
                    diagnostics::Level::Info,
                ); self.training_recorder.exported(&context, take_id); },
                Err(error) => {
                    diagnostics::event(
                        "training-recording",
                        format!("Could not export WAV: {error}"),
                        diagnostics::Level::Error,
                    );
                    self.training_recorder
                        .export_error(&context, take_id, error);
                }
            }
        }
        self.update_training_recording_view(cx);
    }
    pub(super) fn save_training_recording(&mut self, cx: &mut Context<Self>) {
        let (Some(context), Some(take)) = (
            self.training_recorder.context().map(str::to_owned),
            self.training_recorder.take.clone(),
        ) else {
            return;
        };
        #[cfg(feature = "ui-tests")]
        if std::env::var_os("SINGZ_GPUI_TRAINING_RECORDING_TEST").is_some()
            || std::env::var_os("SINGZ_GPUI_TRAINING_RECORDING_RECOVERY_TEST").is_some()
            || std::env::var_os("SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_TEST").is_some()
        {
            let choice = self.training_recording_prompt_paths.pop_front().flatten();
            self.accept_training_recording_path(context, take, choice, false, cx);
            return;
        }
        let directory = dirs::desktop_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(audio_devices::directory);
        let prompt = cx.prompt_for_new_path(&directory, Some(&take.filename));
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(Ok(choice)) => {
                    this.accept_training_recording_path(context, take, choice, true, cx)
                }
                Ok(Err(error)) => {
                    this.training_recorder
                        .export_error(&context, take.id, error.to_string());
                    this.update_training_recording_view(cx);
                }
                Err(_) => {}
            });
        })
        .detach();
    }
    fn accept_training_recording_path(
        &mut self,
        context: String,
        take: training_recording::Take,
        choice: Option<std::path::PathBuf>,
        overwrite: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = choice else {
            return;
        };
        let result = self
            .training_recording_store
            .as_ref()
            .ok_or_else(|| anyhow::anyhow!("Recording export is unavailable."))
            .and_then(|service| match take.recovery {
                Some(recovery) => service.export_recovery(recovery, path, overwrite),
                None => service.export(take.path, path, overwrite),
            });
        match result {
            Ok(id) => {
                self.training_recording_exports
                    .insert(id, (context, take.id));
            }
            Err(error) => self
                .training_recorder
                .export_error(&context, take.id, error.to_string()),
        }
        self.update_training_recording_view(cx);
    }
}

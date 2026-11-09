//! Shared native desktop actions for window controls, menus and application exit.
use super::*;

impl Player {
    pub(super) fn enter_desktop_catalog(&mut self, cx:&mut Context<Self>) {
        self.restart_cycle.observe_component(false);
        self.transport.update(cx,|transport,cx|transport.set_output_mounted(false,self.master_volume,cx));
        if self.project.is_some() {self.native_command("pause".into(),cx);}
        if self.backend.is_none() {self.playing=false;}
        self.songs_catalog=true;
        self.screen=Screen::Library;
        // Retain the current rows until the authoritative worker scan arrives.
        if let Some(backend)=&self.backend {backend.catalog();}
        cx.notify();
    }
    pub(super) fn desktop_woke(&mut self, _cx: &mut Context<Self>) {
        if self.desktop_shutdown_done {
            return;
        }
        if let Some(service) = &self.drive_service {
            if let Err(error) = service.notify_wake() {
                diagnostics::event(
                    "drive",
                    format!("Could not queue wake recovery: {error}"),
                    diagnostics::Level::Warn,
                );
            }
        }
    }

    pub(super) fn open_desktop_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.screen != Screen::Settings {
            self.toggle_desktop_settings(window, cx);
        }
    }

    /// Use the same route for the header gear and the desktop Settings command.
    /// A menu command must not navigate behind an overlay that owns user input.
    pub(super) fn toggle_desktop_settings(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.desktop_shutdown_done
            || self.loading
            || (self.source_job.is_some() && self.source_split.is_none())
            || self.notice.is_some()
            || self.project_delete.read(cx).is_open()
            || self.lyrics_editor_open
            || self.project_picker_open
            || self.drive_projects_open
            || self.library_import_open
            || self.stem_export_open
            || self.engine_setup.read(cx).is_open()
            || self.whats_new.read(cx).is_open()
            || self.quick_start.read(cx).is_open()
            || self.track_rename.is_some()
            || self.header.read(cx).is_editing()
            || matches!(self.screen, Screen::Log | Screen::Models)
        {
            return;
        }

        self.cancel_delete_inspection();
        self.language_menu
            .update(cx, |menu, cx| menu.close(window, cx));
        if let Some(backend) = &self.backend {
            backend.inventory();
        }
        if self.screen == Screen::Settings {
            self.screen = self.previous_screen;
        } else {
            // Active monitoring retains its explicit headphone consent while the
            // persistent header continues to own Stop outside Settings.
            if !self.monitor_busy() {
                self.mic_prefs.headphones = false;
            }
            self.settings
                .update(cx, |settings, cx| settings.on_open(cx));
            self.previous_screen = self.screen;
            self.screen = Screen::Settings;
        }
        if self.screen != Screen::Training {
            self.pause_practice(cx);
        }
        self.last = Instant::now();
        cx.notify();
    }

    /// Application Quit and final window release share one graceful teardown.
    /// Each owned worker drains through its existing Drop implementation.
    pub(super) fn shutdown_desktop(&mut self, cx: &mut App) {
        if self.desktop_shutdown_done {
            return;
        }
        self.desktop_shutdown_done = true;
        if let Some(store) = &mut self.desktop_window_state {
            store.flush();
        }

        self.record_completed_practice();
        if self.training_profile_sent.is_some() {
            if let Some(store) = &self.training_store {
                let (preferences, controls) = self.training.read(cx).profile();
                store.preferences(preferences, controls);
            }
        }
        self.microphone.take();
        self.training_recording_store.take();
        self.stem_export_service.take();
        self.backend.take();
        self.training_store.take();
        self.model_service.take();
        self.source_service.take();
        self.engine_setup_checker.take();
        self.drive_restore_service.take();
        self.drive_service.take();
        self.project_library_service.take();
        self.release_service.take();
        diagnostics::event("app", "Native desktop stopped.", diagnostics::Level::Info);
        self.diagnostics.take();
    }
}

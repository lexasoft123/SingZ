//! Adopt a complete locale receipt without rebuilding the audio session.
use super::*;

impl Player {
    pub(super) fn open_language_menu(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.notice.is_some() || self.loading || self.project_picker_open || self.drive_projects_open
            || self.lyrics_editor_open || self.library_import_open || self.stem_export_open
            || self.whats_new.read(cx).is_open() || self.quick_start.read(cx).is_open()
            || self.engine_setup.read(cx).is_open()
            || matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models) { return; }
        if self.language_menu.read(cx).is_open() {
            self.language_menu.update(cx, |menu, cx| menu.close(window, cx));
            return;
        }
        let Some(state) = self.language_state else { return; };
        let header = self.header.read(cx);
        let Some(bounds) = header.guides.get("language") else { return; };
        let focus = header.language_focus();
        self.language_menu.update(cx, |menu, cx| {
            menu.open(state.language, state.locale, state.system_locale, bounds, Some(focus), window, cx);
        });
    }

    pub(super) fn poll_locale(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if self.language_menu.read(cx).is_open() {
            if let Some(bounds)=self.header.read(cx).guides.get("language") {
                self.language_menu.update(cx,|menu,cx|menu.set_anchor(bounds,cx));
            }
        }
        let snapshot = self.locale_service.snapshot();
        if !snapshot.loaded || snapshot.pending { window.request_animation_frame(); }
        if snapshot.revision == self.locale_revision { return; }
        self.locale_revision = snapshot.revision;
        if !snapshot.loaded { return; }
        let changed = self.language_state != Some(snapshot.state);
        self.language_state = Some(snapshot.state);
        if changed {
            i18n::set_current(snapshot.state.locale);
            desktop_lifecycle::install_menus(cx);
            self.language_menu.update(cx, |menu, cx| menu.set_locale(snapshot.state.language, snapshot.state.locale, snapshot.state.system_locale, cx));
            self.library.update(cx, |library, cx| library.refresh_locale(window, cx));
            self.drive_projects.update(cx,|dialog,cx|dialog.refresh_locale(window,cx));
            self.lyrics_sidebar.update(cx, |sidebar, cx| sidebar.refresh_locale(window, cx));
            // Dictionary registration is build-time and locale selection is a
            // single atomic update. Invalidate all cached views together rather
            // than recreating controls, resetting drafts or reopening playback.
            cx.refresh_windows();
            cx.notify();
        }
        if let Some(error) = snapshot.error {
            diagnostics::event("locale", error, diagnostics::Level::Error);
        }
    }
}

//! Manual engine instructions and independent, cancellable execution probes.
use super::*;

impl Player {
    pub(super) fn open_engine_setup(&mut self, cx: &mut Context<Self>) {
        if self.engine_setup.read(cx).is_open()
            || self.lyrics_editor_open
            || self.project_picker_open
            || self.library_import_open
            || self.whats_new.read(cx).is_open()
            || self.quick_start.read(cx).is_open()
            || self.notice.is_some()
            || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
        {
            return;
        }
        self.engine_setup_session += 1;
        self.metronome_open = false;
        self.header.update(cx, |h, cx| h.cancel_title(cx));
        self.transport.update(cx, |t, cx| t.dismiss_popovers(cx));
        let status = self.engine_status.as_ref().map(|s| engine_setup::Status {
            ok: s.ok,
            message: s.message.clone().unwrap_or_default(),
        });
        self.engine_setup.update(cx, |s, cx| s.open(status, cx));
        cx.notify();
    }
    pub(super) fn close_engine_setup(&mut self, cx: &mut Context<Self>) {
        // Closing the source dialog leaves the accepted probe running. Its
        // completion may refresh global readiness, but cannot reopen the dialog
        // or dismiss a newer instance.
        self.engine_setup.update(cx, |s, cx| s.close(cx));
        cx.notify();
    }
    pub(super) fn recheck_engine_setup(&mut self, cx: &mut Context<Self>) {
        if !self.engine_setup.read(cx).is_open() {
            return;
        }
        if self.engine_setup_checker.is_none() {
            self.engine_setup_checker = Some(source_jobs::Service::new_unchecked());
        }
        let started = Instant::now();
        match self.engine_setup_checker.as_ref().unwrap().check() {
            Ok(generation) => {
                self.engine_status_started = Some(started);
                self.engine_setup_check = Some((generation, self.engine_setup_session));
                self.engine_setup
                    .update(cx, |s, cx| s.set_checking(true, cx));
            }
            Err(error) => {
                self.engine_setup_check = None;
                self.engine_setup.update(cx, |s, cx| {
                    s.set_status(
                        Some(engine_setup::Status {
                            ok: false,
                            message: error.to_string(),
                        }),
                        cx,
                    )
                });
            }
        }
        cx.notify();
    }
    pub(super) fn poll_engine_setup(&mut self, cx: &mut Context<Self>) {
        let Some((generation, session)) = self.engine_setup_check else {
            return;
        };
        let Some(checker) = &self.engine_setup_checker else {
            return;
        };
        let snapshot = checker.snapshot();
        if snapshot.generation != generation || snapshot.engine_revision == 0 {
            return;
        }
        self.engine_setup_check = None;
        let mut status = snapshot.engine_status.clone();
        let fresh = snapshot.engine_probe_started.is_some_and(|started| {
            self.engine_status_started
                .is_none_or(|floor| started >= floor)
        });
        if fresh {
            self.engine_status_started = snapshot.engine_probe_started;
            self.header.update(cx, |h, cx| h.set_engine(status.ok, cx));
            self.engine_status = Some(status.clone());
        } else if let Some(current) = &self.engine_status {
            // The source worker may have completed a newer probe while this
            // dialog's request was running. Finish Checking using that newer
            // result; an older success must not dismiss a newer failure.
            status = current.clone();
        }
        if session == self.engine_setup_session && self.engine_setup.read(cx).is_open() {
            self.engine_setup.update(cx, |s, cx| {
                s.set_status(
                    Some(engine_setup::Status {
                        ok: status.ok,
                        message: status.message.unwrap_or_default(),
                    }),
                    cx,
                )
            });
            if status.ok {
                self.close_engine_setup(cx);
            }
        }
        cx.notify();
    }
}

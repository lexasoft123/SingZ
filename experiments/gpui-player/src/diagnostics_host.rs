//! Native diagnostic panel ownership, selection receipts and Save destinations.
use super::*;

fn row(entry: &diagnostics::Entry) -> log_panel::LogRow {
    log_panel::LogRow {
        time: diagnostics::format_local(entry.timestamp_ms),
        source: entry.source.clone(),
        message: entry.line.clone(),
        level: entry.level.as_str(),
    }
}
fn session_label(session: &diagnostics::Session) -> String {
    use chrono::{Local, TimeZone};
    let when = Local
        .timestamp_millis_opt(session.started_at)
        .single()
        .map(|d| d.format("%b %-d, %Y, %-I:%M %p").to_string())
        .unwrap_or_default();
    let kb = ((session.bytes.saturating_add(512)) / 1024).max(1);
    format!(
        "{when} · {}",
        if kb >= 1024 {
            format!("{:.1} MB", kb as f64 / 1024.)
        } else {
            format!("{kb} KB")
        }
    )
}
impl Player {
    pub(super) fn open_diagnostics(&mut self, cx: &mut Context<Self>) {
        if self.screen == Screen::Log
            || self.engine_setup.read(cx).is_open()
            || self.lyrics_editor_open
            || self.project_picker_open
            || self.library_import_open
            || self.whats_new.read(cx).is_open()
            || self.quick_start.read(cx).is_open()
            || self.notice.is_some()
        {
            return;
        }
        self.diagnostics_session += 1;
        self.previous_screen = self.screen;
        self.screen = Screen::Log;
        self.metronome_open = false;
        self.header.update(cx, |h, cx| h.cancel_title(cx));
        self.transport.update(cx, |t, cx| t.dismiss_popovers(cx));
        self.log_panel.update(cx, |log, cx| log.on_open(cx));
        if let Some(service) = &self.diagnostics {
            let revision = service.revision();
            let snapshot = service.snapshot();
            self.diagnostics_revision = revision;
            self.log_panel.update(cx, |log, cx| {
                log.set_live_rows(snapshot.entries.iter().map(row).collect(), cx)
            });
            match service.list() {
                Ok(id) => self.diagnostics_list_pending = Some((id, self.diagnostics_session)),
                Err(error) => diagnostics::event(
                    "app",
                    format!("Could not list log sessions: {error}"),
                    diagnostics::Level::Warn,
                ),
            }
        }
        cx.notify();
    }
    pub(super) fn close_diagnostics(&mut self, cx: &mut Context<Self>) {
        if let Some(service) = &self.diagnostics {
            if let Some((id, _)) = self.diagnostics_list_pending.take() {
                service.cancel(id);
            }
            if let Some((id, _, _, _)) = self.diagnostics_read_pending.take() {
                service.cancel(id);
            }
        }
        self.log_panel.update(cx, |log, cx| log.close(cx));
        if self.screen == Screen::Log {
            self.screen = self.previous_screen;
        }
        // An accepted export still fulfils the chosen Save after dismissal.
        cx.notify();
    }
    pub(super) fn select_diagnostics(&mut self, selected: Option<String>, cx: &mut Context<Self>) {
        let Some(service) = &self.diagnostics else {
            return;
        };
        if let Some((id, _, _, _)) = self.diagnostics_read_pending.take() {
            service.cancel(id);
        }
        let Some(name) = selected else {
            return;
        };
        let generation = self.log_panel.read(cx).selection_request();
        match service.read(name.clone()) {
            Ok(id) => {
                self.diagnostics_read_pending =
                    Some((id, self.diagnostics_session, generation, name))
            }
            Err(_) => self.log_panel.update(cx, |log, cx| {
                let past = diagnostics::parse_session(&crate::i18n::t("diagnostics.notice.sessionGone"));
                log.set_session_rows(
                    &name,
                    generation,
                    past.entries.iter().map(row).collect(),
                    past.total,
                    cx,
                );
            }),
        }
    }
    pub(super) fn save_diagnostics(&mut self, selected: Option<String>, cx: &mut Context<Self>) {
        if self.diagnostics.is_none() {
            self.notice = Some(crate::i18n::t("diagnostics.notice.savePrototype"));
            cx.notify();
            return;
        }
        self.diagnostics_save_serial += 1;
        let serial = self.diagnostics_save_serial;
        let session = self.diagnostics_session;
        #[cfg(feature = "ui-tests")]
        if std::env::var_os("SINGZ_GPUI_DIAGNOSTICS_TEST").is_some() {
            self.diagnostics_prompt_requests.push(selected.clone());
            let choice = self.diagnostics_prompt_paths.pop_front().flatten();
            self.accept_diagnostics_path(serial, session, selected, choice, false, cx);
            return;
        }
        let directory = dirs::desktop_dir()
            .or_else(dirs::home_dir)
            .unwrap_or_else(audio_devices::directory);
        let suggested = format!(
            "SingZ-log-{}.txt",
            chrono::Utc::now().format("%Y-%m-%d-%H-%M-%S")
        );
        let prompt = cx.prompt_for_new_path(&directory, Some(&suggested));
        cx.spawn(async move |this, cx| {
            let result = prompt.await;
            let _ = this.update(cx, |this, cx| match result {
                Ok(Ok(choice)) => {
                    this.accept_diagnostics_path(serial, session, selected, choice, true, cx)
                }
                Ok(Err(error)) => diagnostics::event(
                    "app",
                    format!("Could not choose a log destination: {error}"),
                    diagnostics::Level::Error,
                ),
                Err(_) => {}
            });
        })
        .detach();
    }
    pub(super) fn accept_diagnostics_path(
        &mut self,
        serial: u64,
        session: u64,
        selected: Option<String>,
        choice: Option<std::path::PathBuf>,
        overwrite: bool,
        cx: &mut Context<Self>,
    ) {
        let Some(path) = choice else {
            return;
        };
        let Some(service) = &self.diagnostics else {
            return;
        };
        match service.export(path, selected.clone(), overwrite) {
            Ok(id) => {
                self.diagnostics_save_receipts.insert(id,(session,serial,selected.clone()));
                if serial>self.diagnostics_save_accepted_serial{
                    self.diagnostics_save_accepted_serial=serial;
                    self.diagnostics_save_pending=Some((id,session,serial,selected));
                }
            },
            Err(error) => diagnostics::event(
                "app",
                format!("Could not save log: {error}"),
                diagnostics::Level::Error,
            ),
        }
        cx.notify();
    }
    pub(super) fn poll_diagnostics(&mut self, cx: &mut Context<Self>) {
        let Some(service) = &self.diagnostics else {
            return;
        };
        if self.screen == Screen::Log {
            let revision = service.revision();
            if revision != self.diagnostics_revision {
                let snapshot = service.snapshot();
                self.diagnostics_revision = revision;
                self.log_panel.update(cx, |log, cx| {
                    log.set_live_rows(snapshot.entries.iter().map(row).collect(), cx)
                });
            }
        }
        let events = service.drain();
        for event in events {
            if self
                .diagnostics_list_pending
                .is_some_and(|(id, _)| id == event.id)
            {
                let (_, session) = self.diagnostics_list_pending.take().unwrap();
                if session == self.diagnostics_session && self.screen == Screen::Log {
                    if let Ok(diagnostics::Reply::Sessions(sessions)) = event.result {
                        let sessions = sessions
                            .into_iter()
                            .filter(|s| !s.current)
                            .map(|s| log_panel::Session {
                                id: s.name.clone(),
                                label: session_label(&s),
                            })
                            .collect();
                        self.log_panel
                            .update(cx, |log, cx| log.set_sessions(sessions, cx));
                    }
                }
                continue;
            }
            if self
                .diagnostics_read_pending
                .as_ref()
                .is_some_and(|(id, _, _, _)| *id == event.id)
            {
                let (_, session, generation, name) = self.diagnostics_read_pending.take().unwrap();
                if session == self.diagnostics_session && self.screen == Screen::Log {
                    let past = match event.result {
                        Ok(diagnostics::Reply::Read(past)) => past,
                        _ => diagnostics::parse_session(&crate::i18n::t("diagnostics.notice.sessionGone")),
                    };
                    self.log_panel.update(cx, |log, cx| {
                        log.set_session_rows(
                            &name,
                            generation,
                            past.entries.iter().map(row).collect(),
                            past.total,
                            cx,
                        );
                    });
                }
                continue;
            }
            if let Some((session,serial,_))=self.diagnostics_save_receipts.remove(&event.id){
                if self.diagnostics_save_pending.as_ref().is_some_and(|(id,_,_,_)|*id==event.id){self.diagnostics_save_pending=None;}
                match event.result {
                    Ok(diagnostics::Reply::Exported(path))
                        if session == self.diagnostics_session
                            && serial == self.diagnostics_save_accepted_serial
                            && self.screen == Screen::Log =>
                    {
                        self.log_panel
                            .update(cx, |log, cx| log.saved_to(path.display().to_string(), cx))
                    }
                    Err(error) => diagnostics::event(
                        "app",
                        format!("Could not save log: {error}"),
                        diagnostics::Level::Error,
                    ),
                    _ => {}
                }
            }
        }
    }
}

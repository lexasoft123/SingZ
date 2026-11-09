//! Native account actions and worker state adoption; no filesystem/network IO here.
use super::*;
impl Player {
    pub(super) fn drive_capture_busy(&self) -> bool {
        self.drive_service.as_ref().is_some_and(|service| {
            self.project
                .as_ref()
                .is_some_and(|project| service.capture_project().as_ref() == Some(&project.dir))
        })
    }
    pub(super) fn drive_action(&mut self, action: drive_state::Action, cx: &mut Context<Self>) {
        #[cfg(feature = "ui-tests")]
        if std::env::var_os("SINGZ_GPUI_DRIVE_TEST").is_some() {
            eprintln!("DRIVE_UI actual action {action:?}; storage moving={}", self.project_library_moving);
        }
        if action == drive_state::Action::ShowLog {
            self.open_diagnostics(cx);
            return;
        }
        if matches!(action,drive_state::Action::SignOut|drive_state::Action::SignIn) {
            if let Some(service)=&self.drive_restore_service {let _=service.cancel();}
            self.drive_projects_open=false;
        }
        if self.project_library_moving {
            return;
        }
        if let Some(service) = &self.drive_service {
            if let Err(error) = service.action(action) {
                self.notice = Some(error.to_string());
            }
        }
        cx.notify();
    }
    pub(super) fn poll_drive(&mut self, cx: &mut Context<Self>) {
        self.poll_drive_restore(cx);
        let Some(service) = &self.drive_service else {
            return;
        };
        let events = service.drain();
        let snapshot = service.snapshot_since(self.drive_snapshot.revision);
        for event in events {
            match event {
                drive_service::Event::OpenUrl(_, url) => {
                    #[cfg(feature = "ui-tests")]
                    if std::env::var_os("SINGZ_GPUI_DRIVE_TEST").is_some()
                        || std::env::var_os("SINGZ_GPUI_DRIVE_RESTORE_TEST").is_some()
                        || std::env::var_os("SINGZ_GPUI_EMPTY_DRIVE_TEST").is_some()
                        || std::env::var_os("SINGZ_GPUI_DRIVE_RETIREMENT_TEST").is_some()
                    {
                        self.drive_test_urls.push(url);
                        continue;
                    }
                    cx.open_url(&url);
                }
                drive_service::Event::LibraryChanged(_) => {
                    if let Some(backend) = &self.backend {
                        backend.catalog();
                    }
                    if self.project_picker_open
                        && !self.project_library_moving
                        && self.project_library_pending.is_none()
                    {
                        if let Some(service) = &self.project_library_service {
                            if let Ok(id) = service.refresh() {
                                self.project_library_pending = Some(id);
                            }
                        }
                    }
                }
            }
        }
        if let Some(snapshot) = snapshot {
            self.drive_snapshot = snapshot.clone();
            self.library
                .update(cx, |s, cx| s.set_drive(snapshot.clone(), cx));
            self.project_picker
                .update(cx, |s, cx| s.set_drive(snapshot.clone(), cx));
            cx.notify();
        }
        if self.drive_root_waiting.is_some()
            && self.drive_snapshot.suspended
            && !self.drive_snapshot.busy
            && !self.drive_snapshot.signing_in
        {
            let path = self.drive_root_waiting.take().unwrap();
            if let Some(service) = &self.project_library_service {
                match service.set_root(path) {
                    Ok(id) => self.project_library_pending = Some(id),
                    Err(error) => {
                        self.project_library_moving = false;
                        self.project_picker.update(cx, |s, cx| {
                            s.set_moving(false, cx);
                            s.failure(error.to_string(), cx);
                        });
                        if let Some(service) = &self.drive_service {
                            let _ = service.set_root(self.catalog_root.clone());
                        }
                    }
                }
            }
            cx.notify();
        }
    }
}

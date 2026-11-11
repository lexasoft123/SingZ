//! Native Drive download dialog coordination; network/filesystem work stays off UI.
use super::*;
impl Player {
    pub(super) fn open_drive_projects(&mut self, window:&mut Window, cx:&mut Context<Self>) {
        if self.drive_projects_open || self.project_library_moving || self.loading || self.notice.is_some()
            || self.library_import_open || self.stem_export_open || self.lyrics_editor_open
            || matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models) {return;}
        self.header.update(cx,|header,cx|header.cancel_title(cx));
        self.transport.update(cx,|transport,cx|transport.dismiss_popovers(cx));
        self.metronome_open=false;
        self.drive_projects_open=true;
        self.drive_projects.update(cx,|dialog,cx|dialog.open(window,cx));
        cx.notify();
    }
    pub(super) fn close_drive_projects(&mut self, window:&mut Window, cx:&mut Context<Self>) {
        let owned=self.drive_projects.read(cx).focus_inside(window,cx);
        self.drive_projects_open=false;
        if let Some(service)=&self.drive_restore_service {let _=service.cancel();}
        if owned {
            let restored=if self.project_picker_open {
                self.project_picker.update(cx,|picker,cx|picker.focus_drive_browse(window,cx))
            } else {self.library.update(cx,|library,cx|library.focus_drive_browse(window,cx))};
            if !restored {self.focus_handle.focus(window,cx);}
        }
        cx.notify();
    }
    pub(super) fn drive_projects_event(&mut self,event:&drive_projects::Event,window:&mut Window,cx:&mut Context<Self>) {
        if !self.drive_projects_open {return;}
        let result=match event {
            drive_projects::Event::Refresh=>self.drive_restore_service.as_ref().map(|service|service.refresh()),
            drive_projects::Event::Download(id)=>self.drive_restore_service.as_ref().map(|service|service.download(id.clone())),
            drive_projects::Event::Cancel=>self.drive_restore_service.as_ref().map(|service|service.cancel()),
            drive_projects::Event::Close=>{self.close_drive_projects(window,cx);return;},
            drive_projects::Event::Open(path)=>{
                self.close_drive_projects(window,cx);
                self.close_project_picker(cx);
                self.open_project(path.clone(),cx);
                return;
            },
        };
        match result {
            Some(Ok(()))=>{},
            other=>{
                let message=match other {Some(Err(error))=>format!("{error:#}"),_=>"Drive downloads are unavailable".into()};
                let rows=self.drive_restore_snapshot.rows.clone().or(Some(Vec::new()));
                self.drive_projects.update(cx,|dialog,cx|dialog.set_state(drive_projects::State{rows,busy:false,message,progress:0.},cx));
            }
        }
        cx.notify();
    }
    pub(super) fn poll_drive_restore(&mut self,cx:&mut Context<Self>) {
        let Some(snapshot)=self.drive_restore_service.as_ref().and_then(|service|service.snapshot_since(self.drive_restore_snapshot.revision)) else{return;};
        self.drive_restore_snapshot=snapshot.clone();
        if !self.drive_projects_open {return;}
        self.drive_projects.update(cx,|dialog,cx|dialog.set_state(drive_projects::State{
            rows:snapshot.rows,busy:snapshot.busy,message:snapshot.message,progress:snapshot.progress,
        },cx));
        if let Some(path)=snapshot.completed {
            self.drive_projects_open=false;
            self.close_project_picker(cx);
            self.open_project(path,cx);
        }
        cx.notify();
    }
}

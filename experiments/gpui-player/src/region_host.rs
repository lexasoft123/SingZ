//! Selection UI follows accepted native region receipts; Save waits for them.
use super::*;
use anyhow::Context as _;
use region_gesture::{Gesture, Target};

#[derive(Default)]
pub(super) struct State {
    pub gesture: Option<Gesture>,
    pub bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    pub resize_hover: bool,
    requested: Option<Target>,
    pending: Option<(u64, u64, Target)>,
    serial: u64,
    deferred: bool,
    save_requested: bool,
    pub play_requested: bool,
}
impl Player {
    pub(super) fn reset_region(&mut self) {
        // Keep request identities monotonic even when recovery reuses an epoch.
        let serial=self.region.serial;
        self.region=State{serial,..Default::default()};
    }
    pub(super) fn region_target(&self) -> Target {
        self.region.requested.unwrap_or(Target {
            selection: self.project.as_ref().and_then(|p|p.selection),
            looping: self.looping,
        })
    }
    pub(super) fn region_busy(&self) -> bool { self.region.requested.is_some() }
    pub(super) fn hover_region(&mut self, position:Point<Pixels>, cx:&mut Context<Self>) {
        let resize=self.region.bounds.get().filter(|b|b.contains(&position)).and_then(|bounds|
            Gesture::begin(self.native_epoch,f32::from(position.x),f32::from(bounds.left()),f32::from(bounds.size.width),self.view_start*self.duration,self.view_end*self.duration,self.region_target().selection)
        ).is_some_and(|gesture|gesture.resizing());
        if resize!=self.region.resize_hover {self.region.resize_hover=resize;cx.notify();}
    }
    pub(super) fn begin_region(&mut self, x:f32, bounds:Bounds<Pixels>, cx:&mut Context<Self>) {
        if self.loading || self.source_blocks_player() || !self.audio_available() || self.screen!=Screen::Player {return;}
        self.region.gesture=Gesture::begin(self.native_epoch,x,f32::from(bounds.left()),f32::from(bounds.size.width),self.view_start*self.duration,self.view_end*self.duration,self.region_target().selection);
        cx.notify();
    }
    pub(super) fn move_region(&mut self, x:f32, cx:&mut Context<Self>) {
        if self.loading || self.source_blocks_player() || self.screen!=Screen::Player {
            self.region.gesture=None;return;
        }
        let Some(gesture)=self.region.gesture.as_mut() else{return;};
        if gesture.epoch!=self.native_epoch {self.region.gesture=None;return;}
        if let Some(selection)=gesture.moved(x) {
            self.request_region(Target{selection:Some(selection),..self.region_target()},cx);
        }
    }
    pub(super) fn cancel_deferred_region(&mut self) {
        if self.region.deferred {
            self.region.requested=None;self.region.deferred=false;
            self.region.save_requested=false;self.region.play_requested=false;
        }
    }
    pub(super) fn end_region(&mut self, cx:&mut Context<Self>) {
        let Some(gesture)=self.region.gesture.take() else{return;};
        if gesture.epoch!=self.native_epoch || self.loading || self.source_blocks_player() || self.screen!=Screen::Player {return;}
        if let Some(position)=gesture.clicked() {
            if self.region_target().selection.is_none() {self.edit_seq+=1;}
            self.request_region(Target{selection:None,..self.region_target()},cx);
            self.position=position;self.seek_native(cx);
        }
        cx.notify();
    }
    pub(super) fn request_region(&mut self, target:Target, cx:&mut Context<Self>) {
        if self.loading || self.source_blocks_player() || !self.audio_available() || self.project.is_none() {return;}
        if target==self.region_target() {return;}
        self.region.requested=Some(target);
        if self.region.pending.is_none() && !self.region.deferred {self.dispatch_region(cx);}
        cx.notify();
    }
    pub(super) fn dispatch_region(&mut self, cx:&mut Context<Self>) {
        let Some(target)=self.region.requested else{return;};
        if self.defer_monitor(DeferredAudio::Region(self.native_epoch),cx) {
            self.region.deferred=true;
            if self.notice.is_some() {self.cancel_deferred_region();}
            return;
        }
        self.region.deferred=false;
        self.region.serial+=1;
        let serial=self.region.serial;
        match self.backend.as_ref().context("Native project is unavailable")
            .and_then(|backend|backend.region(self.native_epoch,serial,target,self.duration)) {
            Ok(())=>self.region.pending=Some((self.native_epoch,serial,target)),
            Err(error)=>{
                self.region.requested=None;self.region.save_requested=false;self.region.play_requested=false;
                self.notice=Some(format!("Could not apply playback region: {error:#}"));
            }
        }
        cx.notify();
    }
    pub(super) fn region_applied(&mut self, epoch:u64, serial:u64, result:Result<integration::Status,String>, cx:&mut Context<Self>) {
        let Some((pending_epoch,pending_serial,target))=self.region.pending else{return;};
        if epoch!=self.native_epoch || epoch!=pending_epoch || serial!=pending_serial {return;}
        self.region.pending=None;
        match result {
            Ok(_)=>{
                if let Some(project)=&mut self.project {project.selection=target.selection;}
                self.looping=target.looping;self.edit_seq+=1;
            }
            Err(error)=>{
                // A newer pointer target supersedes an older clean refusal.
                if self.region.requested==Some(target) {
                    self.region.requested=None;self.region.save_requested=false;
                    self.notice=Some(format!("Could not apply playback region: {error}"));
                }
            }
        }
        if self.region.requested==Some(target) {self.region.requested=None;}
        if self.region.requested.is_some() {self.dispatch_region(cx);}
        else {
            if std::mem::take(&mut self.region.save_requested) {self.save_project(cx);}
            if std::mem::take(&mut self.region.play_requested) && self.screen==Screen::Player && self.notice.is_none() {self.native_transport(transport::TransportEvent::Play,cx);}
        }
        cx.notify();
    }
    pub(super) fn defer_region_save(&mut self)->bool {
        if !self.region_busy(){return false;}
        self.region.save_requested=true;true
    }
}

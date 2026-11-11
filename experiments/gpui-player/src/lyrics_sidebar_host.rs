//! Project-scoped sidebar job ownership; the editor's draft intent stays separate.
use super::*;
use lyrics_resolution::Intent;

impl Player {
    pub(super) fn sidebar_context(&mut self,cx:&mut Context<Self>){
        let Some(p)=&self.project else{return;};
        self.lyrics_sidebar.update(cx,|s,cx|s.context(p.dir.display().to_string(),p.name.clone(),self.duration as f64,self.lyrics_precise_cap,cx));
    }
    pub(super) fn sidebar_ready(&mut self,check:Option<alignmentoutcome_domain::Check>,cx:&mut Context<Self>){
        let Some(project)=&self.project else{return;};
        let raw=project.lyrics_raw.as_ref();
        self.lyrics_sidebar.update(cx,|s,cx|s.ready(
            self.lyric_document.source.clone(),
            raw.and_then(|r|r["credit"].as_str()).map(str::to_owned),
            raw.is_some_and(|r|r["aligned"]==true),
            check.or_else(||raw.and_then(|r|r.get("check")).and_then(|c|serde_json::from_value(c.clone()).ok())),cx));
    }
    /// Pending ownership survives Cancel until final disposition, but only a
    /// currently loading sidebar may consume progress from that operation.
    pub(super) fn sidebar_progress(&mut self,epoch:u64,serial:u64,progress:lyrics_align::Progress,cx:&mut Context<Self>){
        if epoch!=self.native_epoch||self.lyrics_flight.lyrics_sidebar.key()!=Some((epoch,serial))
            ||!self.lyrics_sidebar.read(cx).is_loading()||matches!(self.lyrics_sidebar_job,Intent::Candidate(_)){
            return;
        }
        self.lyrics_sidebar.update(cx,|s,cx|s.loading(Some(lyrics_sidebar::Progress{stage:progress.stage,percent:progress.percent}),cx));
    }
    pub(super) fn cancel_sidebar_lyrics(&mut self,cx:&mut Context<Self>){
        let active=self.lyrics_flight.lyrics_sidebar.is_some()||self.lyrics_sidebar_download_waiting||!self.lyrics_sidebar_needs.is_empty();
        self.lyrics_sidebar_next=None;
        self.lyrics_sidebar_download_waiting=false;self.lyrics_sidebar_needs.clear();
        if let Some(service)=&self.lyrics_sidebar_download{if service.is_running(){service.cancel();}}
        if active {
            if let Some(backend)=&self.backend{backend.cancel_lyrics_alignment();}
            self.lyrics_sidebar.update(cx,|s,cx|s.cancel(cx));
        }
        cx.notify();
    }
    pub(super) fn open_sidebar_search(&mut self,query:String,cx:&mut Context<Self>){
        let Some(backend)=&self.backend else{return;};
        if self.loading||self.project.is_none(){return;}
        self.lyrics_flight.lyrics_search_pending.cancel();backend.cancel_lyrics_search();
        let serial=self.lyrics_flight.lyrics_search_pending.begin(self.native_epoch, ());
        match backend.search_lyrics(self.native_epoch,serial,query,self.duration as f64){
            Ok(())=>{},
            Err(e)=>{self.lyrics_flight.lyrics_search_pending.cancel();eprintln!("Lyrics search: {e}");self.lyrics_sidebar.update(cx,|s,cx|s.search_results(vec![],cx));}
        }
        cx.notify();
    }
    pub(super) fn start_sidebar_lyrics(&mut self,intent:Intent,cx:&mut Context<Self>){
        if self.backend.is_none()||self.project.is_none()||!self.audio_available()||self.loading||self.source_blocks_player()||self.lyrics_editor_open||self.lyrics_flight.lyrics_editor_pending.is_some()||self.import_pending.is_some(){
            if matches!(intent,Intent::Candidate(_)){self.lyrics_sidebar.update(cx,|s,cx|s.abandon_apply(cx));}
            return;
        }
        if self.lyrics_flight.lyrics_sidebar.is_some(){
            self.lyrics_sidebar_next=Some(intent);
            self.backend.as_ref().unwrap().cancel_lyrics_alignment();
            if !matches!(intent,Intent::Candidate(_)){self.lyrics_sidebar.update(cx,|s,cx|s.loading(None,cx));}
            cx.notify();return;
        }
        if let Some(service)=&self.lyrics_sidebar_download{if service.is_running(){service.cancel();}}
        self.lyrics_sidebar_download_waiting=false;self.lyrics_sidebar_needs.clear();
        self.lyrics_flight.lyrics_sidebar.cancel();
        self.backend.as_ref().unwrap().cancel_lyrics_alignment();
        self.lyrics_sidebar_job=intent;
        if !matches!(intent,Intent::Candidate(_)){self.lyrics_sidebar_intent=intent;}
        let serial=self.lyrics_flight.lyrics_alignment.reserve();
        match self.backend.as_ref().unwrap().resolve_lyrics(self.native_epoch,serial,self.project.as_ref().unwrap(),intent){
            Ok(())=>{
                self.lyrics_flight.lyrics_sidebar.activate(self.native_epoch,serial,());
                if !matches!(intent,Intent::Candidate(_)){self.lyrics_sidebar.update(cx,|s,cx|s.loading(None,cx));}
            },
            Err(error)=>self.lyrics_sidebar.update(cx,|s,cx|if matches!(intent,Intent::Candidate(_)){s.apply_failure(error.to_string(),cx)}else{s.failure(error.to_string(),cx)}),
        }
        cx.notify();
    }
    pub(super) fn download_sidebar_lyrics(&mut self,cx:&mut Context<Self>){
        if self.lyrics_sidebar_needs.is_empty()||self.loading||self.project.is_none(){return;}
        let mut config=model_service::configuration();if !config.fixture{config.flavor=self.lyrics_sidebar_needs[0].flavor;config.entries=model_catalog::registry(config.flavor,release_highlights::CURRENT_VERSION);}
        let ids:Vec<_>=self.lyrics_sidebar_needs.iter().map(|n|n.id.clone()).collect();config.entries.retain(|e|ids.contains(&e.id));
        self.lyrics_sidebar_download=Some(model_service::Service::from_config(config));
        self.lyrics_sidebar_download_waiting=true;self.lyrics_sidebar_download_started=false;self.lyrics_sidebar_download_epoch=self.native_epoch;
        self.lyrics_sidebar.update(cx,|s,cx|s.loading(Some(lyrics_sidebar::Progress{stage:"downloading-model".into(),percent:0.}),cx));cx.notify();
    }
    pub(super) fn poll_sidebar_download(&mut self,cx:&mut Context<Self>){
        if !self.lyrics_sidebar_download_waiting{return;}
        if self.lyrics_sidebar_download_epoch!=self.native_epoch{self.cancel_sidebar_lyrics(cx);return;}
        let Some(service)=&self.lyrics_sidebar_download else{return;};let status=service.snapshot();
        if !self.lyrics_sidebar_download_started {
            if !status.loaded{return;}
            let ids=self.lyrics_sidebar_needs.iter().map(|n|n.id.clone()).collect();
            match service.download(Some(ids)){
                Ok(())=>self.lyrics_sidebar_download_started=true,
                Err(e)=>{self.lyrics_sidebar_download_waiting=false;self.lyrics_sidebar.update(cx,|s,cx|s.failure(e.to_string(),cx));},
            }
            return;
        }
        if service.is_running()||status.busy||!status.loaded{
            let percent=if status.progress.is_empty(){0.}else{status.progress.values().sum::<f32>()/status.progress.len()as f32};
            self.lyrics_sidebar.update(cx,|s,cx|s.loading(Some(lyrics_sidebar::Progress{stage:"downloading-model".into(),percent}),cx));return;
        }
        self.lyrics_sidebar_download_waiting=false;
        if let Some(error)=&status.error{self.lyrics_sidebar.update(cx,|s,cx|s.failure(error.clone(),cx));}
        else{self.start_sidebar_lyrics(self.lyrics_sidebar_intent,cx);}
    }
    pub(super) fn flush_sidebar_after(&mut self,cx:&mut Context<Self>){
        if self.lyrics_flight.lyrics_sidebar.is_some()||self.lyrics_sidebar_download_waiting||self.loading{return;}
        if self.lyrics_sidebar_editor_after {
            self.lyrics_sidebar_editor_after=false;self.open_lyrics_editor_intent(cx);return;
        }
        if let Some(intent)=self.lyrics_sidebar_next.take(){self.start_sidebar_lyrics(intent,cx);return;}
        if let Some(mode)=self.lyrics_sidebar_import_after.take(){self.start_library_import(mode,cx);return;}
        if self.lyrics_sidebar_rename_after.is_some()&&!self.saving&&self.source_job.is_none()&&self.rename_pending.is_none()&&self.metronome_flight.metronome.is_none()&&!self.metronome_flight.metronome_save_waiting&&!self.transport_flight.counting_in {
            let name=self.lyrics_sidebar_rename_after.take().unwrap();
            let save=self.metronome_flight.metronome_save_requested;self.metronome_flight.metronome_save_requested=false;
            self.rename_title(name,cx);self.metronome_flight.metronome_save_requested|=save;
        }
    }
    pub(super) fn sidebar_resolved(&mut self,result:std::result::Result<integration::ResolvedLyrics,lyrics_align::Failure>,cx:&mut Context<Self>){
        self.lyrics_flight.lyrics_sidebar.cancel();
        match result {
            Ok(result)=>{
                let changed=self.project.as_ref().and_then(|p|p.lyrics_raw.as_ref()).is_none_or(|old|old["lines"]!=result.raw["lines"]);
                for warning in &result.warnings{eprintln!("Lyrics: {warning}");if warning.starts_with("Lyrics were saved, but")||warning==&i18n::t("lyrics.panel.autoPreservedEdited"){self.notice=Some(warning.clone());}}
                if let Some(project)=&mut self.project{project.lyrics=Some(result.document.clone());project.lyrics_raw=Some(result.raw);project.lyrics_fingerprint=result.fingerprint;project.lyrics_error=None;project.has_lyrics=true;}
                self.lyric_document=result.document;
                if changed{
                    self.lyric_ai_note_top.set(-1.);
                    self.native_glows.borrow_mut().clear();self.shape_cache.borrow_mut().clear();*self.layout_cache.borrow_mut()=None;
                    self.lyric_active.set(usize::MAX);self.lyric_scroll.set(0.);self.lyric_scroll_target.set(0.);self.lyric_scroll_handle.set_offset(point(px(0.),px(0.)));
                    self.beat_mutation+=1;self.beat_job=None;self.beat_result=None;
                    if let Some(backend)=&self.backend{backend.cancel_beat_detection();}
                }
                self.sidebar_ready(result.check,cx);
                if changed{self.start_beat_detection(false,cx);}
            },
            Err(lyrics_align::Failure::Cancelled)=>self.lyrics_sidebar.update(cx,|s,cx|s.cancel(cx)),
            Err(lyrics_align::Failure::NeedsModel(needs))=>{
                let size=needs.iter().map(|n|n.size_mb).sum();let precise=needs.iter().any(|n|n.id=="aligner");self.lyrics_sidebar_needs=needs;
                self.lyrics_sidebar.update(cx,|s,cx|s.consent(if precise{"aligner"}else{"speech"}.into(),size,cx));
            },
            Err(e)=>self.lyrics_sidebar.update(cx,|s,cx|if matches!(self.lyrics_sidebar_job,Intent::Candidate(_)){s.apply_failure(e.to_string(),cx)}else{s.failure(e.to_string(),cx)}),
        }
        cx.notify();
    }
}

#[derive(Default)]
pub(super) struct LyricsFlight {
    pub(super) lyrics_sidebar: inflight::Inflight<()>,
    pub(super) lyrics_search_pending: inflight::Inflight<()>,
    pub(super) lyrics_editor_pending: inflight::Inflight<()>,
    /// Owns the serial counter the sidebar resolution shares; payload is
    /// `(editor generation, draft revision)`.
    pub(super) lyrics_alignment: inflight::Inflight<(u64,u64)>,
    pub(super) lyrics_download_pending: Option<(u64,u64,u64,lyrics_align::Tier)>,
}

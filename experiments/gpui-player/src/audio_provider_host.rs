//! Playback-provider intent crosses only a confirmed unloaded ownership boundary.
use super::*;

impl Player {
    fn audio_provider_renderer_busy(&self)->bool {
        self.backend.is_none()||self.loading||self.project.is_some()
            ||self.source_working||self.source_job.is_some()
            ||self.audio_recovery.is_some()||self.source_publication.is_some()
            ||self.monitor_busy()||!self.monitor_actions.is_empty()
            ||self.practice.is_some()||self.training_test.is_some()
            ||self.training_recorder.busy()||self.training_recorder.recording()
            ||self.rate_busy()||self.tracks_pending.is_some()||self.delete_pending.is_some()
    }

    pub(super) fn sync_audio_provider(&mut self,cx:&mut Context<Self>) {
        let busy=self.audio_provider_renderer_busy();
        let revision=self.backend.as_ref().map(|b|b.provider_renderer_busy(busy)).unwrap_or(0);
        let stale=self.audio_provider.as_ref().is_none_or(|s|s.epoch!=self.native_epoch);
        self.settings.update(cx,|s,cx|s.set_provider_state(self.audio_provider.as_ref(),revision,busy||stale,self.audio_provider_pending.is_some(),cx));
    }

    pub(super) fn select_audio_provider(&mut self,provider:audio_devices::Provider,cx:&mut Context<Self>) {
        let busy=self.audio_provider_renderer_busy();
        let result=(||->anyhow::Result<()> {
            anyhow::ensure!(!busy&&self.audio_provider_pending.is_none(),"Release the current audio session before changing its provider");
            let backend=self.backend.as_ref().ok_or_else(||anyhow::anyhow!("Native playback is unavailable"))?;
            let revision=backend.provider_renderer_busy(busy);
            let snapshot=self.audio_provider.as_ref().ok_or_else(||anyhow::anyhow!("Audio provider availability is not confirmed"))?;
            anyhow::ensure!(snapshot.can_change&&snapshot.epoch==self.native_epoch&&snapshot.renderer_revision==revision,"Audio ownership changed; provider selection is unavailable");
            let available=snapshot.availability.as_ref().and_then(|a|a.providers.iter().find(|p|p.id==provider));
            anyhow::ensure!(available.is_some_and(|p|p.available),"{}",available.map(|p|p.detail.as_str()).unwrap_or("Audio provider is unavailable"));
            if provider==snapshot.selected {return Ok(());}
            self.audio_provider_serial+=1;
            backend.provider(self.audio_provider_serial,snapshot.revision,snapshot.epoch,provider)?;
            self.audio_provider_pending=Some(self.audio_provider_serial);
            Ok(())
        })();
        self.sync_audio_provider(cx);
        if let Err(error)=result {self.settings.update(cx,|s,cx|s.provider_failed(error.to_string(),cx));}
    }

    pub(super) fn adopt_audio_provider(&mut self,snapshot:integration::ProviderSnapshot,cx:&mut Context<Self>) {
        if self.audio_provider.as_ref().is_some_and(|s|s.revision>=snapshot.revision) {return;}
        if self.audio_provider_pending==Some(snapshot.request) {self.audio_provider_pending=None;}
        self.audio_provider=Some(snapshot);
        self.sync_audio_provider(cx);
    }
}

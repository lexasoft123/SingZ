//! Playback-provider intent crosses only a confirmed unloaded ownership boundary.
use super::*;

impl Player {
    fn audio_provider_renderer_busy(&self)->bool {
        self.backend.is_none()||self.loading||self.project.is_some()
            ||self.source_working||self.source_job.is_some()
            ||self.audio_recovery.is_some()||self.source_publication.is_some()
            ||self.monitor_busy()||!self.monitor_flight.monitor_actions.is_empty()
            ||self.practice.is_some()||self.training_test.is_some()
            ||self.training_recorder.busy()||self.training_recorder.recording()
            ||self.rate_busy()||self.tracks_flight.tracks_pending.is_some()||self.delete_flight.delete.is_some()
    }

    pub(super) fn sync_audio_provider(&mut self,cx:&mut Context<Self>) {
        let busy=self.audio_provider_renderer_busy();
        let revision=self.backend.as_ref().map(|b|b.provider_renderer_busy(busy)).unwrap_or(0);
        let stale=self.audio_provider.as_ref().is_none_or(|s|s.epoch!=self.native_epoch);
        self.settings.update(cx,|s,cx|s.set_provider_state(self.audio_provider.as_ref(),revision,busy||stale,self.provider_flight.audio_provider.is_some(),cx));
    }

    pub(super) fn select_audio_provider(&mut self,provider:audio_devices::Provider,cx:&mut Context<Self>) {
        let busy=self.audio_provider_renderer_busy();
        let result=(||->anyhow::Result<()> {
            anyhow::ensure!(!busy&&self.provider_flight.audio_provider.is_none(),"Release the current audio session before changing its provider");
            let backend=self.backend.as_ref().ok_or_else(||anyhow::anyhow!("Native playback is unavailable"))?;
            let revision=backend.provider_renderer_busy(busy);
            let snapshot=self.audio_provider.as_ref().ok_or_else(||anyhow::anyhow!("Audio provider availability is not confirmed"))?;
            anyhow::ensure!(snapshot.can_change&&snapshot.epoch==self.native_epoch&&snapshot.renderer_revision==revision,"Audio ownership changed; provider selection is unavailable");
            let available=snapshot.availability.as_ref().and_then(|a|a.providers.iter().find(|p|p.id==provider));
            anyhow::ensure!(available.is_some_and(|p|p.available),"{}",available.map(|p|p.detail.as_str()).unwrap_or("Audio provider is unavailable"));
            if provider==snapshot.selected {return Ok(());}
            let serial=self.provider_flight.audio_provider.reserve();
            backend.provider(serial,snapshot.revision,snapshot.epoch,provider)?;
            self.provider_flight.audio_provider.activate(snapshot.epoch,serial,());
            Ok(())
        })();
        self.sync_audio_provider(cx);
        if let Err(error)=result {self.settings.update(cx,|s,cx|s.provider_failed(error.to_string(),cx));}
    }

    pub(super) fn adopt_audio_provider(&mut self,snapshot:integration::ProviderSnapshot,cx:&mut Context<Self>) {
        if self.audio_provider.as_ref().is_some_and(|s|s.revision>=snapshot.revision) {return;}
        self.provider_flight.audio_provider.settle_serial(snapshot.request);
        self.audio_provider=Some(snapshot);
        self.sync_audio_provider(cx);
    }
}

#[derive(Default)]
pub(super) struct ProviderFlight {
    pub(super) audio_provider: inflight::Inflight<()>,
}

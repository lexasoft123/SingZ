//! Provider mutation is admitted only by the worker's retired-owner proof.
use super::*;
pub use crate::audio_devices::ProviderSnapshot;

pub(super) struct PendingWork(pub Arc<AtomicU64>);
impl Drop for PendingWork {fn drop(&mut self){let _=self.0.fetch_update(Ordering::AcqRel,Ordering::Acquire,|n|Some(n.saturating_sub(1)));}}
pub(super) fn ownership_request(request:&Request)->bool {
    matches!(request,Request::Open(..)|Request::Training(..)|Request::CancelTraining(..)|Request::Park(..)|Request::RecoverOutput(..)|Request::Rename(..)|Request::ImportLibrary(..)|Request::Delete(..))
}
pub(super) fn can_change(windows:bool,connection:bool,monitor:bool,training:bool,training_intent:u64,pending:u64,retired:bool,renderer:u64)->bool {
    windows&&!connection&&!monitor&&!training&&training_intent==0&&pending==0&&retired&&renderer&1==0
}
pub(super) fn owner_admission(reserved:&AtomicBool)->Result<()> {
    anyhow::ensure!(!reserved.load(Ordering::Acquire),"Audio provider preferences are being committed; retry after Settings finishes");Ok(())
}
trait PreferenceIo {fn publish(&mut self)->Result<()>;fn rollback(&mut self)->Result<()>;}
impl PreferenceIo for Option<crate::audio_devices::ProviderPreference> {
    fn publish(&mut self)->Result<()> {if let Some(io)=self {io.publish()}else{Ok(())}}
    fn rollback(&mut self)->Result<()> {if let Some(io)=self {io.rollback()}else{Ok(())}}
}
fn commit_preferences(io:&mut impl PreferenceIo,gate:&Mutex<()>,reserved:&AtomicBool,valid:impl Fn()->bool,commit:impl FnOnce())->Result<()> {
    {let _guard=gate.lock().unwrap_or_else(|e|e.into_inner());
        anyhow::ensure!(!reserved.load(Ordering::Acquire)&&valid(),"Audio provider eligibility changed before preference publication");
        reserved.store(true,Ordering::Release);
    }
    let published=io.publish();
    let failure={let _guard=gate.lock().unwrap_or_else(|e|e.into_inner());
        match published {
            Ok(()) if valid()=>{commit();reserved.store(false,Ordering::Release);return Ok(());},
            Ok(())=>anyhow::anyhow!("Audio provider eligibility changed during preference publication"),
            Err(error)=>error,
        }
    };
    // Never release admission while disk intent could differ from live intent.
    // A failed rollback remains quarantined until restart, without blocking UI.
    io.rollback().with_context(||format!("{failure:#}; could not restore previous audio preferences; playback remains blocked"))?;
    {let _guard=gate.lock().unwrap_or_else(|e|e.into_inner());reserved.store(false,Ordering::Release);}
    Err(failure)
}
pub(super) struct ProviderState {
    pub snapshot:ProviderSnapshot,
    pub renderer:Arc<AtomicU64>,pub pending:Arc<AtomicU64>,pub retired:Arc<AtomicU64>,pub gate:Arc<Mutex<()>>,pub reserved:Arc<AtomicBool>,
}
impl ProviderState {
    pub fn publish(&mut self,events:&mpsc::Sender<Event>,epoch:u64,connection:bool,monitor:bool,training:bool,intent:u64) {
        let renderer=self.renderer.load(Ordering::Acquire);
        let change=can_change(cfg!(windows),connection,monitor,training,intent,self.pending.load(Ordering::Acquire),self.retired.load(Ordering::Acquire)==0,renderer)
            &&self.snapshot.availability.is_some()&&!self.reserved.load(Ordering::Acquire);
        if self.snapshot.epoch!=epoch||self.snapshot.renderer_revision!=renderer||self.snapshot.can_change!=change||self.snapshot.revision==0 {
            self.snapshot.epoch=epoch;self.snapshot.renderer_revision=renderer;self.snapshot.can_change=change;
            self.snapshot.revision+=1;let _=events.send(Event::Provider(self.snapshot.clone()));
        }
    }
    pub fn choose(&mut self,events:&mpsc::Sender<Event>,latest:&AtomicU64,alive:&Arc<AtomicBool>,selected:&AtomicU64,
        request:u64,revision:u64,epoch:u64,renderer:u64,provider:crate::audio_devices::Provider,
        connection:bool,monitor:bool,training:bool,intent:&AtomicU64,output_uid:&mut String) {
        let result=(||->Result<()> {
            anyhow::ensure!(cfg!(windows),"Windows playback providers cannot be selected on this platform");
            anyhow::ensure!(revision==self.snapshot.revision&&epoch==latest.load(Ordering::Acquire),"Audio provider eligibility changed; refresh Settings");
            let availability=crate::audio_devices::providers(alive)?;
            availability.require_available(provider)?;
            // Discovery may wait for a native probe. Do it before the short
            // commit gate, then recheck every owner and generation at commit.
            let inventory=crate::audio_devices::inventory_with_provider(alive,provider).map_err(|e|format!("{e:#}"));
            let renderer_fence=self.renderer.clone();let pending=self.pending.clone();let retired=self.retired.clone();
            let valid=||alive.load(Ordering::Acquire)&&epoch==latest.load(Ordering::Acquire)&&renderer==renderer_fence.load(Ordering::Acquire)
                &&can_change(true,connection,monitor,training,intent.load(Ordering::Acquire),pending.load(Ordering::Acquire),retired.load(Ordering::Acquire)==0,renderer);
            let changed=provider!=self.snapshot.selected;
            // File lease, preparation, fsync and rollback never own the UI gate.
            let mut prefs=if changed{Some(crate::audio_devices::ProviderPreference::prepare(provider)?)}else{None};
            let inventory_error=inventory.as_ref().err().cloned();
            let gate=self.gate.clone();let reservation=self.reserved.clone();
            commit_preferences(&mut prefs,&gate,&reservation,valid,||{
                let token=selected.load(Ordering::Acquire);
                selected.store(provider.next_inventory_token(token),Ordering::Release);
                if changed {
                    *output_uid=String::new();self.snapshot.selected=provider;
                    let _=events.send(Event::AudioPrefs(String::new(),None));
                }
                let _=events.send(Event::Inventory(inventory));
                self.snapshot.availability=Some(availability);
            })?;
            if let Some(error)=inventory_error {anyhow::bail!("Audio provider selected, but device refresh failed: {error}");}
            Ok(())
        })();
        self.snapshot.request=request;self.snapshot.error=result.err().map(|e|format!("{e:#}"));
        self.snapshot.epoch=latest.load(Ordering::Acquire);self.snapshot.renderer_revision=self.renderer.load(Ordering::Acquire);
        self.snapshot.can_change=can_change(cfg!(windows),connection,monitor,training,intent.load(Ordering::Acquire),self.pending.load(Ordering::Acquire),self.retired.load(Ordering::Acquire)==0,self.snapshot.renderer_revision)&&self.snapshot.availability.is_some()&&!self.reserved.load(Ordering::Acquire);
        self.snapshot.revision+=1;let _=events.send(Event::Provider(self.snapshot.clone()));
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn slow_durable_preferences_leave_ui_gate_free_and_reject_a_stale_renderer() {
        struct Slow {entered:mpsc::SyncSender<()>,release:mpsc::Receiver<()>,rolled:Arc<AtomicBool>}
        impl PreferenceIo for Slow {
            fn publish(&mut self)->Result<()> {self.entered.send(())?;self.release.recv()?;Ok(())}
            fn rollback(&mut self)->Result<()> {self.rolled.store(true,Ordering::Release);Ok(())}
        }
        let gate=Arc::new(Mutex::new(()));let reserved=Arc::new(AtomicBool::new(false));
        let renderer=Arc::new(AtomicU64::new(2));let committed=Arc::new(AtomicBool::new(false));let rolled=Arc::new(AtomicBool::new(false));
        let (entered,wait)=mpsc::sync_channel(0);let (release,resume)=mpsc::sync_channel(0);
        let args=(gate.clone(),reserved.clone(),renderer.clone(),committed.clone(),rolled.clone());
        let worker=thread::spawn(move||{let (gate,reserved,renderer,committed,rolled)=args;
            commit_preferences(&mut Slow{entered,release:resume,rolled},&gate,&reserved,||renderer.load(Ordering::Acquire)==2,||committed.store(true,Ordering::Release))
        });
        wait.recv_timeout(Duration::from_secs(5)).unwrap();
        {let _ui=gate.try_lock().expect("UI admission gate held during durable preference I/O");
            assert!(owner_admission(&reserved).is_err());
            renderer.store(3,Ordering::Release);
        }
        release.send(()).unwrap();assert!(worker.join().unwrap().is_err());
        assert!(rolled.load(Ordering::Acquire));assert!(!committed.load(Ordering::Acquire));
        assert!(!reserved.load(Ordering::Acquire));assert!(owner_admission(&reserved).is_ok());
    }
    #[test] fn failed_preference_rollback_quarantines_owner_admission_without_locking_ui() {
        struct Broken;impl PreferenceIo for Broken {
            fn publish(&mut self)->Result<()> {anyhow::bail!("publication failed")}
            fn rollback(&mut self)->Result<()> {anyhow::bail!("rollback failed")}
        }
        let gate=Mutex::new(());let reserved=AtomicBool::new(false);
        assert!(commit_preferences(&mut Broken,&gate,&reserved,||true,||panic!("must not commit")).is_err());
        assert!(gate.try_lock().is_ok());assert!(owner_admission(&reserved).is_err());
    }
    #[test] fn changing_provider_requires_an_explicit_retired_owner_and_every_lease_free() {
        assert!(can_change(true,false,false,false,0,0,true,2));
        for blocked in [can_change(false,false,false,false,0,0,true,2),can_change(true,true,false,false,0,0,true,2),
            can_change(true,false,true,false,0,0,true,2),can_change(true,false,false,true,0,0,true,2),
            can_change(true,false,false,false,7,0,true,2),can_change(true,false,false,false,0,1,true,2),
            can_change(true,false,false,false,0,0,false,2),can_change(true,false,false,false,0,0,true,3)] {assert!(!blocked);}
    }
    #[test] fn completed_work_restores_pending_eligibility_without_resetting_renderer_fence() {
        let count=Arc::new(AtomicU64::new(1));{let _work=PendingWork(count.clone());assert!(!can_change(true,false,false,false,0,count.load(Ordering::Acquire),true,4));}
        assert_eq!(count.load(Ordering::Acquire),0);assert!(can_change(true,false,false,false,0,0,true,4));
    }
}

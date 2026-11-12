//! Read-only Drive browsing has its own cancellable worker and isolated cache.
use crate::{drive_auth::{AuthClient,Config,TokenStore},drive_remote::Remote,drive_restore::{self,Row}};
use anyhow::{Context,Result};
use std::{path::PathBuf,sync::{Arc,Mutex,atomic::{AtomicBool,AtomicU64,Ordering},mpsc::{self,SyncSender}},thread,time::Duration};

#[derive(Clone,Debug,Default)]
pub struct Snapshot {
    pub revision:u64,
    pub request:u64,
    pub rows:Option<Vec<Row>>,
    pub busy:bool,
    pub message:String,
    pub progress:f32,
    pub completed:Option<PathBuf>,
}
enum Kind { List, Download(String), Cancel }
struct Request { serial:u64,kind:Kind }
pub struct Service {
    /// Dropped before joining the worker, which waits on it without a timer.
    commands:Option<SyncSender<Request>>,
    snapshot:Arc<Mutex<Snapshot>>,
    serial:Arc<AtomicU64>,
    alive:Arc<AtomicBool>,
    worker:Option<thread::JoinHandle<()>>,
}
fn publish(shared:&Mutex<Snapshot>,serial:u64,edit:impl FnOnce(&mut Snapshot)) {
    let mut state=shared.lock().unwrap_or_else(|e|e.into_inner());
    if state.request!=serial {return;}
    edit(&mut state);
    state.revision=state.revision.wrapping_add(1);
}
impl Service {
    pub fn new(config_dir:PathBuf)->Self {
        let (commands,receive)=mpsc::sync_channel::<Request>(8);
        let snapshot=Arc::new(Mutex::new(Snapshot::default()));
        let serial=Arc::new(AtomicU64::new(0));
        let alive=Arc::new(AtomicBool::new(true));
        let shared=snapshot.clone();let current=serial.clone();let live=alive.clone();
        let worker=thread::Builder::new().name("gpui-drive-reader".into()).spawn(move|| {
            let cache=config_dir.join("gdrive/downloads");
            // Sleeps until a request arrives or Drop closes the channel.
            while live.load(Ordering::Acquire) {
                let Ok(request)=receive.recv() else {break};
                let id=request.serial;
                if id!=current.load(Ordering::Acquire) {continue;}
                if matches!(request.kind,Kind::Cancel) {
                    publish(&shared,id,|s|{s.busy=false;s.message=crate::i18n::t("library.drive.downloadCancelled");s.completed=None;});
                    continue;
                }
                let cancelled=||!live.load(Ordering::Acquire)||current.load(Ordering::Acquire)!=id;
                let result=(||->Result<()> {
                    let store=TokenStore::new(&config_dir)?;
                    let token_generation=store.generation();
                    let cancel=||cancelled()||store.generation()!=token_generation;
                    if matches!(request.kind,Kind::List) {
                        let rows=drive_restore::cached(&cache)?;
                        if !rows.is_empty() {publish(&shared,id,|s|s.rows=Some(rows));}
                    }
                    let config=Config::from_env_or(include_str!(concat!(env!("OUT_DIR"),"/drive-config.json")))?;
                    let remote=Remote::new(AuthClient::new(config,store.clone()));
                    match request.kind {
                        Kind::List=>{
                            let rows=drive_restore::list(&remote,&cache,&cancel)?;
                            if cancel(){anyhow::bail!("Drive download cancelled");}
                            publish(&shared,id,|s|{s.rows=Some(rows);s.busy=false;s.message.clear();s.progress=0.;});
                        }
                        Kind::Download(project)=>{
                            let path=drive_restore::download(&remote,&project,&cache,&cancel,&|message,fraction| {
                                if !cancel() {publish(&shared,id,|s|{s.message=message;s.progress=if fraction.is_finite(){fraction.clamp(0.,1.)}else{0.};});}
                            })?;
                            if cancel(){anyhow::bail!("Drive download cancelled");}
                            publish(&shared,id,|s|{s.busy=false;s.progress=1.;s.message.clear();s.completed=Some(path);});
                        }
                        Kind::Cancel=>unreachable!(),
                    }
                    Ok(())
                })();
                if let Err(error)=result {
                    if !cancelled() {publish(&shared,id,|s|{s.busy=false;s.completed=None;s.rows.get_or_insert_with(Vec::new);s.message=format!("{error:#}");});}
                }
            }
        });
        let worker=match worker {
            Ok(worker)=>Some(worker),
            Err(error)=>{publish(&snapshot,0,|s|s.message=format!("Drive downloads unavailable: {error}"));None},
        };
        Self{commands:Some(commands),snapshot,serial,alive,worker}
    }
    fn enqueue(&self,kind:Kind)->Result<()> {
        anyhow::ensure!(self.worker.is_some(),"Drive download worker is unavailable");
        let id=self.serial.fetch_add(1,Ordering::AcqRel)+1;
        {
            let mut state=self.snapshot.lock().unwrap_or_else(|e|e.into_inner());
            state.request=id;state.revision=state.revision.wrapping_add(1);state.completed=None;
            if !matches!(kind,Kind::Cancel) {
                state.busy=matches!(kind,Kind::Download(_));state.message.clear();state.progress=0.;
                if matches!(kind,Kind::List) {state.rows=None;}
            }
        }
        if let Err(error)=self.commands.as_ref().context("Drive download queue is unavailable")?.try_send(Request{serial:id,kind}) {
            publish(&self.snapshot,id,|s|{s.busy=false;s.message="Drive download queue is full; try again.".into();});
            return Err(error).context("Drive download queue is unavailable");
        }
        Ok(())
    }
    pub fn refresh(&self)->Result<()> {self.enqueue(Kind::List)}
    pub fn download(&self,id:String)->Result<()> {self.enqueue(Kind::Download(id))}
    pub fn cancel(&self)->Result<()> {self.enqueue(Kind::Cancel)}
    pub fn snapshot_since(&self,revision:u64)->Option<Snapshot> {
        let state=self.snapshot.lock().unwrap_or_else(|e|e.into_inner());
        (state.revision!=revision).then(||state.clone())
    }
}
impl Drop for Service {
    fn drop(&mut self) {
        self.alive.store(false,Ordering::Release);
        self.serial.fetch_add(1,Ordering::AcqRel);
        drop(self.commands.take());
        if let Some(worker)=self.worker.take(){let _=worker.join();}
    }
}

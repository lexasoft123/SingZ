//! Durable ordinary project publication. Accepted captured bytes finish before
//! later local generations retire or replace their exact remote lineage.
use crate::{drive_plan::{self,Location,ProjectPlan,RemoteEntry},drive_remote::{Metadata,Remote,FOLDER},drive_retirement::{self,Binding,LocalCapture,PublicationLineage,PublicationPlan,ExpectedPublication},drive_snapshot::Capture};
use anyhow::{Context,Result,ensure};
use md5::{Digest,Md5};
use serde::{Deserialize,Serialize};
use serde_json::{Value,json};
use std::{collections::{BTreeMap,BTreeSet},fs::{self,File,OpenOptions},io::{Read,Write},path::{Component,Path,PathBuf}};
const LIMIT:u64=16*1024*1024;
#[derive(Clone,Debug,Default)]
pub struct DestinationAdmission {pub folder:Option<RemoteEntry>,pub stems:Option<RemoteEntry>,pub top:Vec<RemoteEntry>,pub stem_files:Vec<RemoteEntry>}
#[derive(Clone,Debug)]
pub struct PublicationHandle {storage:PathBuf,path:PathBuf}
impl PublicationHandle {pub fn path(&self)->&Path{&self.path}}
#[derive(Clone,Debug)]
pub struct PublicationOutcome {
    pub publication:PublicationPlan,pub lineage:Option<PublicationLineage>,pub lineage_id:Option<String>,pub eligibility_warning:Option<String>,
    pub changed:bool,pub uploaded:usize,pub unchanged:usize,pub trashed:usize,
}
#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
enum Phase {Prepared,Writing,PayloadsVerified,CatalogCommitted,Complete}
#[derive(Clone,Debug,Serialize,Deserialize)]
struct Upload {before:Option<Metadata>,desired:Metadata,payload:PathBuf}
#[derive(Clone,Debug,Serialize,Deserialize)]
struct CatalogAttempt {before:Option<Metadata>,desired:Metadata,payload:PathBuf}
#[derive(Clone,Debug,Serialize,Deserialize)]
struct Journal {
    version:u32,transaction:String,binding:Binding,capture:LocalCapture,project:String,phase:Phase,
    folder:Metadata,create_folder:bool,stems:Option<Metadata>,create_stems:bool,
    members:Vec<Metadata>,uploads:Vec<Upload>,trash:Vec<Metadata>,row:Value,
    #[serde(default)] baseline_top:Vec<Metadata>,#[serde(default)] baseline_stems:Vec<Metadata>,#[serde(default)] pruned:Vec<Metadata>,
    catalog_baseline_row:Option<Value>,catalog_reserved:String,catalog_attempt:Option<CatalogAttempt>,
    unchanged:usize,
}
fn md5(bytes:&[u8])->String{format!("{:x}",Md5::digest(bytes))}
fn ordinary_dir(path:&Path)->Result<()> {let meta=fs::symlink_metadata(path)?;ensure!(meta.is_dir()&&!meta.file_type().is_symlink(),"Linked publication directory refused");
    #[cfg(unix)]{use std::os::unix::fs::PermissionsExt;ensure!(meta.permissions().mode()&0o077==0,"Publication transaction must be private");}Ok(())}
fn private_dir(path:&Path)->Result<()> {if !path.exists(){if let Some(parent)=path.parent(){if !parent.exists(){private_dir(parent)?;}}let mut builder=fs::DirBuilder::new();#[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}builder.create(path)?;}ordinary_dir(path)}
fn bounded(path:&Path)->Result<Vec<u8>> {let meta=fs::symlink_metadata(path)?;ensure!(meta.is_file()&&!meta.file_type().is_symlink()&&meta.len()<=LIMIT,"Unsafe publication record");let mut bytes=vec![];File::open(path)?.take(LIMIT+1).read_to_end(&mut bytes)?;ensure!(bytes.len()as u64<=LIMIT,"Publication record exceeds limit");Ok(bytes)}
fn write(path:&Path,bytes:&[u8])->Result<()> {ensure!(bytes.len()as u64<=LIMIT,"Publication record exceeds limit");let parent=path.parent().context("Publication has no parent")?;ordinary_dir(parent)?;
    if path.exists(){bounded(path)?;}let temporary=parent.join(format!(".publication-{}.part",crate::drive_http::random_id()?));
    let result=(||->Result<()>{let mut f=crate::drive_http::private_file(&temporary)?;f.write_all(bytes)?;f.sync_all()?;crate::project_store::replace(&temporary,path)?;#[cfg(not(windows))]File::open(parent)?.sync_all()?;Ok(())})();let _=fs::remove_file(temporary);result}
fn lease(path:&Path)->Result<crate::file_lease::Lease> {ordinary_dir(path)?;let file=path.join(".lock");if file.exists(){bounded(&file)?;}let mut options=OpenOptions::new();options.create(true).truncate(false).read(true).write(true);#[cfg(unix)]{use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}crate::file_lease::Lease::acquire(options.open(file)?).context("Publication transaction is busy")}
fn save(handle:&PublicationHandle,j:&Journal)->Result<()> {write(&handle.path.join("journal.json"),&serde_json::to_vec(j)?)}
fn read(handle:&PublicationHandle)->Result<Journal> {let j:Journal=serde_json::from_slice(&bounded(&handle.path.join("journal.json"))?)?;
    ensure!(j.version==1&&drive_plan::plain_name(&j.project)&&j.members.len()<=4096&&j.uploads.len()<=4096&&j.trash.len()<=4096&&j.capture.root_identity==j.binding.root_identity,"Invalid publication journal");Ok(j)}
fn handles(storage:&Path)->Result<Vec<PublicationHandle>> {let directory=storage.join("publication-transactions");if !directory.exists(){return Ok(vec![]);}ordinary_dir(&directory)?;let mut out=vec![];
    for entry in fs::read_dir(&directory)? {let entry=entry?;if entry.file_name()==".lock"{continue;}ordinary_dir(&entry.path())?;if entry.path().join("journal.json").exists(){out.push(PublicationHandle{storage:storage.into(),path:entry.path()});}}Ok(out)}
/// One bounded read of each journal for quiet admission and pending resume.
/// Write admission still rereads journals under its existing lease, so a new
/// generation accepted by another process cannot be hidden by this index.
#[derive(Default)]
pub struct JournalIndex { projects: BTreeMap<String, Vec<(PublicationHandle, Journal)>> }
impl JournalIndex {
    pub fn load(storage: &Path) -> Result<Self> {
        let mut index = Self::default();
        for handle in handles(storage)? {
            let journal = read(&handle)?;
            index.projects.entry(journal.project.clone()).or_default().push((handle, journal));
        }
        Ok(index)
    }
}

/// This gate has no remote capability and can never grant new retirement
/// authority. Any uncertainty returns to the existing live protocol.
pub(crate) fn quiet(index: &JournalIndex, storage: &Path, binding: &Binding, capture: &Capture,
    plan: &ProjectPlan, admission: &DestinationAdmission, root: &[RemoteEntry],
    catalog: &CatalogView) -> Option<PublicationOutcome> {
    if !plan.upload.is_empty() || !plan.trash.is_empty() || !capture.snapshot.doc_readable
        || !capture.snapshot.stems_readable { return None; }
    let origin = capture.publication_capture();
    let folder = admission.folder.as_ref()?;
    if !crate::drive_retire_transaction::quiet_destination(storage, binding, &plan.dir,
        &origin, folder, root).ok()? { return None; }
    let catalog_meta = catalog.metadata.as_ref()?;
    let catalog_row = catalog_project_row(&catalog.document, &plan.dir).ok()??;
    for (_, journal) in index.projects.get(&plan.dir)? {
        if journal.binding != *binding || journal.phase != Phase::Complete || journal.capture != origin
            || journal.folder.trashed || journal.folder.entry != *folder || journal.row != catalog_row
            || journal.catalog_reserved != catalog_meta.entry.id { continue; }
        let members = journal.members.iter().map(|m| m.entry.clone()).collect::<Vec<_>>();
        if journal.members.iter().any(|m| m.trashed)
            || !drive_plan::quiet_members(&members, &admission.top, &admission.stem_files) { continue; }
        // The planner leaves an unchanged file's existing MIME alone. Compare
        // MIME to the journal via quiet_members, not to a newly inferred local
        // MIME (legacy writers may have used application/octet-stream).
        let same = |local: &crate::drive_plan::LocalEntry, parent: &str| {
            members.iter().any(|m| m.name == local.name && m.parents == vec![parent.to_owned()]
                && m.md5_checksum.as_deref() == Some(local.md5.as_str())
                && m.size.as_deref().and_then(|s| s.parse::<u64>().ok()) == Some(local.size))
        };
        if !capture.snapshot.top.iter().all(|m| same(m, &folder.id))
            || !capture.snapshot.stems.iter().all(|m| admission.stems.as_ref().is_some_and(|s| same(m, &s.id)))
            || members.iter().filter(|m| m.mime_type.as_deref() != Some(FOLDER)).count()
                != capture.snapshot.top.len() + capture.snapshot.stems.len() { continue; }
        let persistent = origin.root_identity.persistent_eligible() && origin.local_identity.persistent_eligible();
        let (lineage_id, lineage, eligibility_warning) = if persistent {
            let (id, recorded) = drive_retirement::recorded_publication(storage, binding, &plan.dir, &origin).ok()??;
            let recorded_members = recorded.members.iter().map(|m| m.entry.clone()).collect::<Vec<_>>();
            if recorded.folder != journal.folder || recorded.catalog_row != catalog_row
                || !drive_plan::quiet_members(&recorded_members, &admission.top, &admission.stem_files) { continue; }
            (Some(id), Some(recorded), None)
        } else {
            let warning = origin.root_identity.require_persistent()
                .and_then(|_| origin.local_identity.require_persistent()).unwrap_err().to_string();
            (None, None, Some(warning))
        };
        return Some(PublicationOutcome {
            publication: PublicationPlan { capture: origin, expected: ExpectedPublication {
                folder: folder.clone(), members, catalog_row, catalog: catalog_meta.entry.clone() } },
            lineage, lineage_id, eligibility_warning, changed: false, uploaded: 0,
            unchanged: journal.unchanged, trashed: 0,
        });
    }
    None
}

fn observed(remote:&Remote,expected:&Metadata,cancel:&impl Fn()->bool)->Result<()> {ensure!(remote.metadata(&expected.entry.id,cancel)?==*expected,"Publication identity/content/parent changed remotely");Ok(())}
fn namespace(remote:&Remote,j:&Journal,allow_missing:bool,cancel:&impl Fn()->bool)->Result<()> {let root=remote.children(&j.binding.singz_root,cancel)?;let rows=root.iter().filter(|m|m.name==j.project).collect::<Vec<_>>();ensure!(rows.len()<=1&&rows.first().is_none_or(|m|m.id==j.folder.entry.id),"Foreign or duplicate destination folder; publication preserved");ensure!(allow_missing||rows.len()==1,"Publication destination is not visible yet");
    if let Some(stems)=&j.stems {if !j.create_folder||!allow_missing {let top=remote.children(&j.folder.entry.id,cancel)?;let rows=top.iter().filter(|m|m.name=="stems").collect::<Vec<_>>();ensure!(rows.len()<=1&&rows.first().is_none_or(|m|m.id==stems.entry.id),"Foreign or duplicate stems destination; publication preserved");if !allow_missing{ensure!(rows.len()==1,"Publication stems destination is not visible yet");}}}Ok(())}
#[derive(Clone,Debug)]
pub(crate) struct CatalogView {pub metadata:Option<Metadata>,pub document:Value}
pub(crate) fn catalog_project_row(doc:&Value,project:&str)->Result<Option<Value>> {ensure!(doc["format"]==2,"Unsupported Drive catalog");let mut names=BTreeSet::new();let mut own=None;for row in doc["projects"].as_array().context("Invalid Drive catalog projects")? {let name=row["dir"].as_str().context("Invalid catalog project name")?;ensure!(drive_plan::plain_name(name)&&names.insert(name),"Ambiguous catalog project");if name==project{own=Some(row.clone());}}Ok(own)}
pub(crate) fn catalog_row_equal(a:&Value,b:&Value)->Result<bool> {let facts=|row:&Value|->Result<BTreeMap<String,(String,String,u64)>>{let mut out=BTreeMap::new();for item in row["files"].as_array().context("Invalid catalog row")?{let name=item["name"].as_str().context("Invalid catalog file name")?;let id=item["id"].as_str().context("Missing catalog file ID")?;let hash=item["md5Checksum"].as_str().filter(|s|crate::drive_snapshot::valid_md5(s)).context("Invalid catalog hash")?;let size=item["size"].as_u64().or_else(||item["size"].as_str().and_then(|s|s.parse().ok())).context("Invalid catalog file size")?;ensure!(out.insert(name.into(),(id.into(),hash.into(),size)).is_none(),"Duplicate catalog file");}Ok(out)};Ok(a["dir"]==b["dir"]&&facts(a)?==facts(b)?)}
pub(crate) fn read_catalog(remote:&Remote,singz:&str,scratch:&Path,cancel:&impl Fn()->bool)->Result<CatalogView> {let root=remote.children(singz,cancel)?;let rows=root.iter().filter(|m|m.name=="catalog.json").collect::<Vec<_>>();ensure!(rows.len()<=1,"Ambiguous Drive catalog identities");let Some(row)=rows.first()else{return Ok(CatalogView{metadata:None,document:json!({"format":2,"capabilities":{"adopt":1},"projects":[]})})};
    let meta=remote.metadata(&row.id,cancel)?;ensure!(!meta.trashed&&meta.entry.parents==vec![singz.to_owned()]&&meta.entry.mime_type.as_deref()!=Some(FOLDER),"Invalid Drive catalog location");let size=meta.entry.size.as_deref().context("Catalog lacks size")?.parse::<u64>()?;ensure!(size<=LIMIT,"Catalog exceeds limit");let temporary=scratch.join(format!(".catalog-read-{}.part",crate::drive_http::random_id()?));
    let result=(||->Result<Value>{remote.download(&row.id,&temporary,LIMIT,cancel)?;let bytes=bounded(&temporary)?;ensure!(bytes.len()as u64==size&&meta.entry.md5_checksum.as_deref()==Some(md5(&bytes).as_str()),"Catalog integrity changed");let doc:Value=serde_json::from_slice(&bytes)?;catalog_project_row(&doc,"")?;Ok(doc)})();let _=fs::remove_file(temporary);Ok(CatalogView{metadata:Some(meta),document:result?})}
/// Private optimization only. The checksum validates the exact cached bytes;
/// it is compared to the live root listing on every run, never to a token or a
/// persisted claim about remote currency.
pub struct CatalogCache { path: PathBuf }
#[derive(Serialize, Deserialize)]
struct CachedCatalog { checksum: String, body: String }
impl CatalogCache {
    pub fn new(config: &Path, binding: &Binding) -> Self {
        Self { path: config.join("gdrive/catalog-cache").join(format!("{}.json", binding.key)) }
    }
    pub fn store(&self, bytes: &[u8]) {
        let save = (|| -> Result<()> {
            let parent = self.path.parent().context("Catalog cache has no parent")?;
            private_dir(parent)?;
            if self.path.symlink_metadata().is_ok() {
                let meta = fs::symlink_metadata(&self.path)?;
                ensure!(meta.is_file() && !meta.file_type().is_symlink(), "Unsafe catalog cache");
            }
            let record = CachedCatalog { checksum: md5(bytes), body: String::from_utf8(bytes.to_vec())? };
            let encoded = serde_json::to_vec(&record)?;
            ensure!(encoded.len() as u64 <= 2 * LIMIT + 1024, "Catalog cache exceeds limit");
            let temporary = parent.join(format!(".catalog-{}.part", crate::drive_http::random_id()?));
            let result = (|| -> Result<()> {
                let mut file = crate::drive_http::private_file(&temporary)?;
                file.write_all(&encoded)?; file.sync_all()?;
                crate::project_store::replace(&temporary, &self.path)?;
                #[cfg(not(windows))] File::open(parent)?.sync_all()?;
                Ok(())
            })();
            let _ = fs::remove_file(temporary); result
        })();
        if let Err(error) = save {
            crate::diagnostics::event("sync", format!("Catalog cache not saved: {error:#}"), crate::diagnostics::Level::Warn);
        }
    }
    fn load(&self) -> Result<Option<CachedCatalog>> {
        if !self.path.try_exists()? { return Ok(None); }
        ordinary_dir(self.path.parent().context("Catalog cache has no parent")?)?;
        let meta = fs::symlink_metadata(&self.path)?;
        ensure!(meta.is_file() && !meta.file_type().is_symlink() && meta.len() <= 2 * LIMIT + 1024, "Unsafe catalog cache");
        let mut bytes = Vec::new();
        File::open(&self.path)?.take(2 * LIMIT + 1025).read_to_end(&mut bytes)?;
        ensure!(bytes.len() as u64 <= 2 * LIMIT + 1024, "Catalog cache exceeds limit");
        let cached: CachedCatalog = serde_json::from_slice(&bytes)?;
        ensure!(cached.body.len() as u64 <= LIMIT && cached.checksum == md5(cached.body.as_bytes()), "Catalog cache integrity changed");
        Ok(Some(cached))
    }
}

/// Uses precisely the root observation already fetched by this run. Listing
/// metadata and downloaded bytes carry the same integrity checks as the live
/// slow-path read; no exact-ID GET is needed on this read-only boundary.
/// A corrupt existing cache disables quiet admission for this run.
pub(crate) fn read_catalog_listed(remote: &Remote, singz: &str, root: &[RemoteEntry],
    cache: &CatalogCache, scratch: &Path, cancel: &impl Fn()->bool) -> Result<(CatalogView, bool)> {
    let rows = root.iter().filter(|m| m.name == "catalog.json").collect::<Vec<_>>();
    ensure!(rows.len() <= 1, "Ambiguous Drive catalog identities");
    let Some(row) = rows.first() else { return Ok((CatalogView { metadata: None,
        document: json!({"format":2,"capabilities":{"adopt":1},"projects":[]}) }, true)); };
    let meta = Metadata { entry: (*row).clone(), trashed: false };
    meta.validate(&row.id)?;
    ensure!(meta.entry.parents == vec![singz.to_owned()] && meta.entry.mime_type.as_deref() != Some(FOLDER), "Invalid Drive catalog location");
    let size = meta.entry.size.as_deref().context("Catalog lacks size")?.parse::<u64>()?;
    ensure!(size <= LIMIT, "Catalog exceeds limit");
    let cached = cache.load();
    let healthy = cached.is_ok();
    let bytes = match cached.ok().flatten().filter(|c| Some(&c.checksum) == meta.entry.md5_checksum.as_ref()) {
        Some(cached) => cached.body.into_bytes(),
        None => {
            let temporary = scratch.join(format!(".catalog-read-{}.part",crate::drive_http::random_id()?));
            let read = (|| -> Result<Vec<u8>> { remote.download(&row.id, &temporary, LIMIT, cancel)?; bounded(&temporary) })();
            let _ = fs::remove_file(temporary); read?
        }
    };
    ensure!(bytes.len() as u64 == size && meta.entry.md5_checksum.as_deref() == Some(md5(&bytes).as_str()), "Catalog integrity changed");
    let document: Value = serde_json::from_slice(&bytes)?;
    catalog_project_row(&document, "")?;
    cache.store(&bytes);
    Ok((CatalogView { metadata: Some(meta), document }, healthy))
}

fn payload(handle:&PublicationHandle,relative:&Path)->Result<PathBuf> {ensure!(relative.is_relative()&&relative.components().all(|c|matches!(c,Component::Normal(_))),"Unsafe publication payload path");Ok(handle.path.join(relative))}
fn folder_properties(binding:&Binding,transaction:&str,role:&str)->BTreeMap<String,String> {BTreeMap::from([("singzPublication".into(),"1".into()),("singzBinding".into(),binding.key.clone()),("singzTransaction".into(),transaction.into()),("singzRole".into(),role.into())])}
fn desired_folder(id:String,name:&str,parent:&str,properties:BTreeMap<String,String>)->Metadata {Metadata{entry:RemoteEntry{id,name:name.into(),mime_type:Some(FOLDER.into()),parents:vec![parent.into()],app_properties:properties,..Default::default()},trashed:false}}
fn choose(remote:&Remote,local:&crate::drive_plan::LocalEntry,location:Location,parent:&str,theirs:&[RemoteEntry],plan:&ProjectPlan,cancel:&impl Fn()->bool)->Result<(Metadata,Option<Upload>)> {let old=theirs.iter().filter(|m|m.name==local.name&&m.mime_type.as_deref()!=Some(FOLDER)).collect::<Vec<_>>();ensure!(old.len()<=1,"Ambiguous remote publication member");let old=old.first().map(|m|(*m).clone());let step=plan.upload.iter().find(|s|s.where_==location&&s.name==local.name);
    if let Some(step)=step {ensure!(step.existing_id.as_deref()==old.as_ref().map(|m|m.id.as_str()),"Publication plan identity changed");let id=if let Some(old)=&old{old.id.clone()}else{remote.generate_id(cancel)?};
        let mut entry=old.clone().unwrap_or_default();entry.id=id;entry.name=local.name.clone();entry.parents=vec![parent.into()];entry.mime_type=Some(local.mime.clone());entry.md5_checksum=Some(local.md5.clone());entry.size=Some(local.size.to_string());let desired=Metadata{entry,trashed:false};
        Ok((desired.clone(),Some(Upload{before:old.map(|entry|Metadata{entry,trashed:false}),desired,payload:step.path.clone()})))
    }else{let old=old.context("Unchanged publication member has no remote identity")?;ensure!(old.parents==vec![parent.to_owned()]&&old.md5_checksum.as_deref()==Some(local.md5.as_str())&&old.size.as_deref().and_then(|s|s.parse::<u64>().ok())==Some(local.size),"Unchanged publication differs from captured bytes");Ok((Metadata{entry:old,trashed:false},None))}}

pub fn prepare(remote:&Remote,storage:&Path,binding:&Binding,capture:&mut Capture,plan:&mut ProjectPlan,destination:DestinationAdmission,cancel:&impl Fn()->bool)->Result<PublicationHandle> {
    ensure!(!cancel(),"Drive sync cancelled");
    ensure!(capture.snapshot.doc_readable&&capture.snapshot.stems_readable&&capture.snapshot.dir==plan.dir,"Incoherent publication capture");
    let origin=capture.publication_capture();
    ensure!(origin.root_identity==binding.root_identity,"Publication root changed");
    crate::drive_retire_transaction::admit_destination(remote,storage,binding,&plan.dir,&origin,destination.folder.as_ref().map(|m|m.id.as_str()),cancel)?;
    let base=storage.join("publication-transactions");private_dir(&base)?;let _guard=lease(&base)?;
    for handle in handles(storage)? {let j=read(&handle)?;if j.binding.key==binding.key&&j.project==plan.dir {
        ensure!(j.phase==Phase::Complete,"Finish the accepted publication before preparing another generation");
        if plan.upload.is_empty()&&plan.trash.is_empty()&&j.capture==origin&&destination.folder.as_ref().is_some_and(|m|m.id==j.folder.entry.id) {
            let same=capture.snapshot.top.iter().chain(&capture.snapshot.stems).all(|local|j.members.iter().any(|m|m.entry.name==local.name&&m.entry.md5_checksum.as_deref()==Some(local.md5.as_str())&&m.entry.size.as_deref().and_then(|s|s.parse::<u64>().ok())==Some(local.size)));
            if same{return Ok(handle);}
        }
    }}
    let transaction=crate::drive_http::random_id()?;
    let folder=match &destination.folder {Some(m)=>Metadata{entry:m.clone(),trashed:false},None=>desired_folder(remote.generate_id(cancel)?,&plan.dir,&binding.singz_root,folder_properties(binding,&transaction,"project"))};
    let needs_stems=!capture.snapshot.stems.is_empty()||destination.stems.is_some();
    let stems=if needs_stems {Some(match &destination.stems {Some(m)=>Metadata{entry:m.clone(),trashed:false},None=>desired_folder(remote.generate_id(cancel)?,"stems",&folder.entry.id,folder_properties(binding,&transaction,"stems"))})}else{None};
    let mut members=vec![];let mut uploads=vec![];
    for local in &capture.snapshot.top {let (m,u)=choose(remote,local,Location::Top,&folder.entry.id,&destination.top,plan,cancel)?;members.push(m);if let Some(u)=u{uploads.push(u);}}
    if let Some(stems)=&stems {members.push(stems.clone());for local in &capture.snapshot.stems {let(m,u)=choose(remote,local,Location::Stems,&stems.entry.id,&destination.stem_files,plan,cancel)?;members.push(m);if let Some(u)=u{uploads.push(u);}}}
    uploads.sort_by_key(|u|u.desired.entry.name=="project.json");
    let mut files=vec![];for row in &plan.rows {let m=members.iter().find(|m|m.entry.parents==vec![folder.entry.id.clone()]&&m.entry.name==row.name).context("Catalog row lacks captured file")?;ensure!(m.entry.md5_checksum.as_deref()==Some(row.md5_checksum.as_str())&&m.entry.size.as_deref()==Some(row.size.as_str()),"Catalog plan differs from capture");files.push(json!({"name":row.name,"id":m.entry.id,"md5Checksum":row.md5_checksum,"size":row.size}));}
    let row=json!({"dir":plan.dir,"files":files});let catalog=read_catalog(remote,&binding.singz_root,&base,cancel)?;
    let reserved=match &catalog.metadata{Some(m)=>m.entry.id.clone(),None=>remote.generate_id(cancel)?};
    let handle=PublicationHandle{storage:storage.into(),path:base.join(&transaction)};private_dir(&handle.path)?;
    let old_paths=plan.upload.iter().map(|s|s.path.clone()).collect::<Vec<_>>();
    capture.promote_uploads(plan,&handle.path.join("payloads"))?;
    for upload in &mut uploads {let index=old_paths.iter().position(|p|p==&upload.payload).context("Upload is not captured")?;upload.payload=plan.upload[index].path.strip_prefix(&handle.path)?.into();}
    let j=Journal{version:1,transaction,binding:binding.clone(),capture:origin,project:plan.dir.clone(),phase:Phase::Prepared,folder,create_folder:destination.folder.is_none(),stems,create_stems:needs_stems&&destination.stems.is_none(),members,uploads,trash:plan.trash.iter().map(|s|Metadata{entry:s.entry.clone(),trashed:false}).collect(),row,catalog_baseline_row:catalog_project_row(&catalog.document,&plan.dir)?,catalog_reserved:reserved,catalog_attempt:None,unchanged:plan.unchanged,pruned:vec![],baseline_top:destination.top.iter().cloned().map(|entry|Metadata{entry,trashed:false}).collect(),baseline_stems:destination.stem_files.iter().cloned().map(|entry|Metadata{entry,trashed:false}).collect()};
    ensure!(!cancel(),"Drive sync cancelled");
    let config=storage.parent().and_then(Path::parent).context("Publication storage has no configuration root")?;
    let local_operations=crate::drive_local_ops::Store::new(config.into());let epoch=local_operations.snapshot(&binding.local_root)?.epoch;
    crate::drive_retire_transaction::admit_destination(remote,storage,binding,&j.project,&j.capture,destination.folder.as_ref().map(|m|m.id.as_str()),cancel)?;
    let source=binding.local_root.join(&j.project);let _publication_lease=crate::project_publish::lock(&source)?;
    ensure!(!cancel()&&!crate::project_publish::write_pending(&source),"Publication yielded to a local operation");
    ensure!(crate::directory_identity::read(&binding.local_root)?==j.capture.root_identity&&crate::directory_identity::read(&source)?==j.capture.local_identity&&crate::project_store::fingerprint(&bounded(&source.join("project.json"))?)==j.capture.local_document,"Captured source changed before publication acceptance");
    ensure!(local_operations.snapshot(&binding.local_root)?.epoch==epoch,"Local operation changed before publication acceptance");
    save(&handle,&j)?;Ok(handle)
}
// Only members present at acceptance, and exact reserved output IDs, can be
// present on resume. Retained baseline extras remain unowned; new extras stop
// all writes rather than completing a document around a foreign payload.
fn accepted_roster(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    if remote.metadata_if_exists(&j.folder.entry.id,cancel)?.is_none(){ensure!(j.create_folder,"Captured folder disappeared");return Ok(());}
    let allowed=j.baseline_top.iter().chain(&j.baseline_stems).chain(&j.members).chain(&j.trash).map(|m|m.entry.id.as_str()).collect::<BTreeSet<_>>();
    let mut current=remote.children(&j.folder.entry.id,cancel)?;
    if let Some(stems)=&j.stems {if remote.metadata_if_exists(&stems.entry.id,cancel)?.is_some(){current.extend(remote.children(&stems.entry.id,cancel)?);}}
    ensure!(current.iter().all(|m|allowed.contains(m.id.as_str())),"A foreign member appeared after publication acceptance; no resumed writes are authorized");
    for m in current {let expected=j.members.iter().find(|e|e.entry.id==m.id);let old=j.baseline_top.iter().chain(&j.baseline_stems).find(|e|e.entry.id==m.id);let actual=remote.metadata(&m.id,cancel)?;ensure!(expected.is_some_and(|e|*e==actual)||old.is_some_and(|e|*e==actual),"Accepted publication member changed remotely");}
    Ok(())
}
fn put(remote:&Remote,before:Option<&Metadata>,desired:&Metadata,path:&Path,cancel:&impl Fn()->bool)->Result<()> {if let Some(before)=before{remote.replace_file_verified(before,desired,path,cancel)?;}else{remote.upload_reserved_file(&desired.entry.id,path,&desired.entry.name,&desired.entry.parents[0],desired.entry.mime_type.as_deref().context("Missing publication MIME")?,desired.entry.md5_checksum.as_deref().context("Missing publication hash")?,desired.entry.size.as_deref().context("Missing publication size")?.parse()?,cancel)?;}Ok(())}
fn own_equal(a:Option<&Value>,b:Option<&Value>)->Result<bool>{match(a,b){(None,None)=>Ok(true),(Some(a),Some(b))=>catalog_row_equal(a,b),_=>Ok(false)}}
fn catalog_commit(remote:&Remote,handle:&PublicationHandle,j:&mut Journal,cancel:&impl Fn()->bool)->Result<Metadata>{
    for _ in 0..4 {
        namespace(remote,j,false,cancel)?;
        accepted_roster(remote,j,cancel)?;let current=read_catalog(remote,&j.binding.singz_root,&handle.path,cancel)?;let own=catalog_project_row(&current.document,&j.project)?;
        if own_equal(own.as_ref(),Some(&j.row))? {return current.metadata.context("Published catalog is missing");}
        ensure!(own_equal(own.as_ref(),j.catalog_baseline_row.as_ref())?,"Cloud project catalog row changed independently; publication retained");
        // An attempt is durable before HTTP. Retry its exact boundary first;
        // an unrelated catalog update may then require a newly merged payload.
        if let Some(attempt)=j.catalog_attempt.clone(){
            if current.metadata.as_ref()==Some(&attempt.desired){continue;}
            if current.metadata==attempt.before {put(remote,attempt.before.as_ref(),&attempt.desired,&payload(handle,&attempt.payload)?,cancel)?;continue;}
        }
        let mut doc=current.document;let projects=doc["projects"].as_array_mut().context("Invalid catalog")?;let mut replacement=projects.iter().find(|r|r["dir"]==j.project).cloned().unwrap_or_else(||j.row.clone());replacement["files"]=j.row["files"].clone();projects.retain(|r|r["dir"]!=j.project);projects.push(replacement);
        let bytes=serde_json::to_vec(&doc)?;let relative=PathBuf::from(format!("catalog-{}.json",crate::drive_http::random_id()?));write(&handle.path.join(&relative),&bytes)?;
        let mut entry=current.metadata.as_ref().map(|m|m.entry.clone()).unwrap_or_default();entry.id=current.metadata.as_ref().map(|m|m.entry.id.clone()).unwrap_or_else(||j.catalog_reserved.clone());entry.name="catalog.json".into();entry.parents=vec![j.binding.singz_root.clone()];entry.mime_type=Some("application/json".into());entry.md5_checksum=Some(md5(&bytes));entry.size=Some(bytes.len().to_string());
        let attempt=CatalogAttempt{before:current.metadata,desired:Metadata{entry,trashed:false},payload:relative};j.catalog_attempt=Some(attempt.clone());save(handle,j)?;
        put(remote,attempt.before.as_ref(),&attempt.desired,&payload(handle,&attempt.payload)?,cancel)?;
    }
    anyhow::bail!("Catalog changed repeatedly; accepted publication remains resumable")
}
pub fn finish(remote:&Remote,handle:&PublicationHandle,cancel:&impl Fn()->bool,progress:&impl Fn(String,f32))->Result<PublicationOutcome>{
    let _lease=lease(&handle.path)?;let mut j=read(handle)?;
    let generation=remote.auth.store.generation();let cancel=&||cancel()||remote.auth.store.generation()!=generation;
    ensure!(!cancel(),"Drive sync cancelled");
    let binding=drive_retirement::bind(remote,&handle.storage,&j.binding.local_root,&j.binding.singz_root,cancel)?;ensure!(binding==j.binding,"Publication account or root binding changed");
    let already_complete=j.phase==Phase::Complete;
    if !already_complete {
        namespace(remote,&j,true,cancel)?;accepted_roster(remote,&j,cancel)?;j.phase=Phase::Writing;save(handle,&j)?;
        if j.create_folder {remote.owned_folder_with_id(&j.folder.entry.id,&j.project,&j.binding.singz_root,&j.folder.entry.app_properties,cancel)?;}else{observed(remote,&j.folder,cancel)?;}
        if let Some(stems)=&j.stems {if j.create_stems{remote.owned_folder_with_id(&stems.entry.id,"stems",&j.folder.entry.id,&stems.entry.app_properties,cancel)?;}else{observed(remote,stems,cancel)?;}}
        namespace(remote,&j,false,cancel)?;
        for (index,upload) in j.uploads.iter().enumerate(){if upload.desired.entry.name=="project.json"{accepted_roster(remote,&j,cancel)?;}progress(format!("Uploading {}",upload.desired.entry.name),index as f32/(j.uploads.len().max(1)as f32));put(remote,upload.before.as_ref(),&upload.desired,&payload(handle,&upload.payload)?,cancel)?;}
        for old in j.trash.clone() {let mut expected=old.clone();expected.trashed=true;let current=remote.metadata(&old.entry.id,cancel)?;if !current.trashed{ensure!(current==old,"Remote trash candidate changed; preserving it");remote.trash(&old.entry.id,cancel)?;}let positive=remote.metadata(&old.entry.id,cancel)?;ensure!(positive==expected,"Exact planned prune has not been positively observed");if !j.pruned.contains(&positive){j.pruned.push(positive);save(handle,&j)?;}}
        j.phase=Phase::PayloadsVerified;save(handle,&j)?;
    }
    namespace(remote,&j,false,cancel)?;observed(remote,&j.folder,cancel)?;for m in &j.members{observed(remote,m,cancel)?;}
    let catalog=if already_complete {let current=read_catalog(remote,&j.binding.singz_root,&handle.path,cancel)?;ensure!(own_equal(catalog_project_row(&current.document,&j.project)?.as_ref(),Some(&j.row))?,"Completed publication changed remotely");current.metadata.context("Completed publication catalog missing")?}else{catalog_commit(remote,handle,&mut j,cancel)?};
    if !already_complete {j.phase=Phase::CatalogCommitted;save(handle,&j)?;}
    let publication=PublicationPlan{capture:j.capture.clone(),expected:ExpectedPublication{folder:j.folder.entry.clone(),members:j.members.iter().map(|m|m.entry.clone()).collect(),catalog_row:j.row.clone(),catalog:catalog.entry}};
    let (lineage,lineage_id,mut eligibility_warning)=match drive_retirement::capture_verify_publication(remote,&j.binding,&j.capture,&publication.expected,cancel){Ok(lineage)=>{let id=drive_retirement::record_publication(&handle.storage,&lineage)?;(Some(lineage),Some(id),None)},Err(error) if error.is::<drive_retirement::IneligibleLineage>()||crate::directory_identity::is_persistent_unavailable(&error)=>(None,None,Some(error.to_string())),Err(error)=>return Err(error)};
    j.phase=Phase::Complete;save(handle,&j)?;
    let spool=handle.path.join("payloads");if spool.exists(){let cleanup=(||->Result<()>{let meta=fs::symlink_metadata(&spool)?;ensure!(meta.is_dir()&&!meta.file_type().is_symlink(),"Unsafe completed payload spool");fs::remove_dir_all(&spool)?;#[cfg(not(windows))]File::open(&handle.path)?.sync_all()?;Ok(())})();if let Err(error)=cleanup{let warning=format!("Published successfully; completed payload cleanup pending: {error:#}");eligibility_warning=Some(eligibility_warning.map_or(warning.clone(),|prior|format!("{prior}; {warning}")));}}
    Ok(PublicationOutcome{publication,lineage,lineage_id,eligibility_warning,changed:!already_complete,uploaded:if already_complete{0}else{j.uploads.len()},unchanged:j.unchanged,trashed:if already_complete{0}else{j.trash.len()}})
}
pub fn resume_pending(remote:&Remote,storage:&Path,binding:&Binding,cancel:&impl Fn()->bool,progress:&impl Fn(String,f32))->Result<Vec<PublicationOutcome>>{
    let index=JournalIndex::load(storage)?;resume_indexed(remote,&index,binding,cancel,progress)
}
pub fn resume_indexed(remote:&Remote,index:&JournalIndex,binding:&Binding,cancel:&impl Fn()->bool,progress:&impl Fn(String,f32))->Result<Vec<PublicationOutcome>>{
    let mut outcomes=vec![];for (handle,j) in index.projects.values().flatten(){if j.binding==*binding&&j.phase!=Phase::Complete{outcomes.push(finish(remote,handle,cancel,progress)?);}}Ok(outcomes)
}

/// Positive prune history belongs to one captured local directory generation.
/// The caller still verifies these exact metadata remotely before retirement.
pub fn owned_pruned_members(storage:&Path,source:&PublicationLineage)->Result<Vec<Metadata>> {
    let mut out:BTreeMap<String,Metadata>=BTreeMap::new();
    for handle in handles(storage)? {let j=read(&handle)?;if j.phase==Phase::Complete&&j.binding==source.binding&&j.project==source.project&&j.folder==source.folder&&j.capture.root_identity==source.capture.root_identity&&j.capture.local_identity==source.capture.local_identity {
        for positive in j.pruned {ensure!(positive.trashed&&j.trash.iter().any(|old|old.entry==positive.entry&&!old.trashed),"Invalid positive prune history");if let Some(prior)=out.insert(positive.entry.id.clone(),positive.clone()){ensure!(prior==positive,"Conflicting prune history");}}
    }}Ok(out.into_values().collect())
}

#[cfg(test)]
mod tests {
use super::*;
use crate::drive_auth::{AuthClient,Config,OAuthSession,TokenStore};
use std::{io::{BufRead,BufReader},process::{Child,Command,Stdio}};
    struct Fixture {base:PathBuf,root:PathBuf,storage:PathBuf,remote:Remote,server:Child}
    impl Fixture {
        fn new()->Self {
            let base=std::env::temp_dir().join(format!("singz-publication-http-{}",crate::drive_http::random_id().unwrap()));
            fs::create_dir_all(base.join("library/Song")).unwrap();let base=base.canonicalize().unwrap();let root=base.join("library");let storage=base.join("preferences/gdrive/retirements");
            let mut server=Command::new("python3").arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py")).arg(base.join("remote")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::null()).spawn().unwrap();
            let mut line=String::new();BufReader::new(server.stdout.take().unwrap()).read_line(&mut line).unwrap();let url=serde_json::from_str::<Value>(&line).unwrap()["base"].as_str().unwrap().to_owned();
            let config=Config::from_json(&json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":url,"apiBase":url,"uploadBase":url}).to_string()).unwrap();
            let store=TokenStore::new(&base.join("preferences")).unwrap();let session=OAuthSession::start(config.clone(),store.clone()).unwrap();
            let response=crate::drive_http::request(crate::drive_http::Request{method:"GET",url:session.authorization_url(),headers:&[],body:crate::drive_http::Body::Empty,destination:crate::drive_http::Destination::Bytes(4096),upload:false,allow_loopback_http:true},&||false).unwrap();
            assert_eq!(response.status,302);let callback=response.header("location").unwrap().to_owned();let finish=std::thread::spawn(move||session.finish(&||false));
            let response=crate::drive_http::request(crate::drive_http::Request{method:"GET",url:&callback,headers:&[],body:crate::drive_http::Body::Empty,destination:crate::drive_http::Destination::Bytes(4096),upload:false,allow_loopback_http:true},&||false).unwrap();
            assert_eq!(response.status,200);finish.join().unwrap().unwrap();let auth=AuthClient::new(config,store);
            Self{base,root,storage,remote:Remote::new(auth),server}
        }
        fn binding(&self)->Binding {let singz=self.remote.folder("SingZ",None,&||false).unwrap();drive_retirement::bind(&self.remote,&self.storage,&self.root,&singz,&||false).unwrap()}
        fn document(&self,title:&str){let audio=self.root.join("Song/original.wav");if !audio.exists(){fs::write(&audio,b"RIFF\x24\x00\x00\x00WAVEfmt \x10\x00\x00\x00\x01\x00\x01\x00\x40\x1f\x00\x00\x80\x3e\x00\x00\x02\x00\x10\x00data\x00\x00\x00\x00").unwrap();}let hash=crate::drive_snapshot::digest(&audio,&||false).unwrap();fs::write(self.root.join("Song/project.json"),serde_json::to_vec(&json!({"version":2,"name":title,"songFile":"original.wav","songHash":{"md5":hash.md5,"size":hash.size,"mtimeMs":0},"settings":{"custom":[]},"stemHashes":{}})).unwrap()).unwrap();}
        fn prepare(&self,binding:&Binding)->PublicationHandle {
            let mut capture=crate::drive_snapshot::capture(&self.root,"Song",&self.base.join("spool"),&||false).unwrap();
            let folder=self.remote.children(&binding.singz_root,&||false).unwrap().into_iter().find(|m|m.name=="Song");
            let top=folder.as_ref().map(|m|self.remote.children(&m.id,&||false).unwrap()).unwrap_or_default();let stems=top.iter().find(|m|m.name=="stems").cloned();
            let stem_files=stems.as_ref().map(|m|self.remote.children(&m.id,&||false).unwrap()).unwrap_or_default();
            let theirs=crate::drive_plan::RemoteProject{folder_id:folder.as_ref().map(|m|m.id.clone()),stems_id:stems.as_ref().map(|m|m.id.clone()),top:top.clone(),stems:stem_files.clone()};
            let mut plan=drive_plan::plan_project(&capture.snapshot,&theirs).unwrap();capture.spool_uploads(&mut plan,&||false).unwrap();
            prepare(&self.remote,&self.storage,binding,&mut capture,&mut plan,DestinationAdmission{folder,stems,top,stem_files},&||false).unwrap()
        }
        fn control(&self,value:Value){let bytes=serde_json::to_vec(&value).unwrap();let url=format!("{}/control",self.remote.auth.config.api_base);let r=crate::drive_http::request(crate::drive_http::Request{method:"POST",url:&url,headers:&[("Content-Type","application/json")],body:crate::drive_http::Body::Bytes(&bytes),destination:crate::drive_http::Destination::Bytes(4096),upload:false,allow_loopback_http:true},&||false).unwrap();assert_eq!(r.status,200);}
        fn finish(&self,h:&PublicationHandle)->PublicationOutcome {finish(&self.remote,h,&||false,&|_,_|{}).unwrap()}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=self.server.kill();let _=self.server.wait();let _=fs::remove_dir_all(&self.base);}}
    #[test]
    fn accepted_bytes_finish_after_delete_and_same_name_recreation(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);let origin=read(&h).unwrap().capture;fs::rename(f.root.join("Song"),f.root.join("old-Song")).unwrap();fs::create_dir(f.root.join("Song")).unwrap();f.document("B");let outcomes=resume_pending(&f.remote,&f.storage,&b,&||false,&|_,_|{}).unwrap();assert_eq!(outcomes.len(),1);assert_eq!(outcomes[0].publication.capture,origin);assert_ne!(crate::directory_identity::read(&f.root.join("Song")).unwrap(),origin.local_identity);assert_eq!(read(&h).unwrap().phase,Phase::Complete);}
    #[test]
    fn interrupted_upload_resumes_without_any_local_project(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);f.control(json!({"failNext":[{"method":"PUT","path":"/upload-session","status":503}]}));assert!(finish(&f.remote,&h,&||false,&|_,_|{}).is_err());fs::remove_dir_all(f.root.join("Song")).unwrap();let out=f.finish(&h);assert!(out.lineage.is_some());}
    #[test]
    fn lost_create_and_upload_acknowledgements_keep_reserved_ids(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);let reserved=read(&h).unwrap();f.control(json!({"failNext":[{"method":"POST","path":"/drive/v3/files","afterApply":true,"disconnect":true},{"method":"PUT","path":"/upload-session","afterApply":true,"disconnect":true}]}));let out=f.finish(&h);assert_eq!(out.publication.expected.folder.id,reserved.folder.entry.id);for m in reserved.members{assert!(out.publication.expected.members.iter().any(|e|e.id==m.entry.id));}}
    #[test]
    fn racing_foreign_folder_is_preserved_before_any_project_write(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);let foreign=f.remote.folder("Song",Some(&b.singz_root),&||false).unwrap();assert!(finish(&f.remote,&h,&||false,&|_,_|{}).is_err());assert!(f.remote.children(&foreign,&||false).unwrap().is_empty());assert!(f.remote.metadata_if_exists(&read(&h).unwrap().folder.entry.id,&||false).unwrap().is_none());}
    #[test]
    fn catalog_merge_preserves_unrelated_row_and_unknown_fields(){let f=Fixture::new();f.document("A");let b=f.binding();let bytes=serde_json::to_vec(&json!({"format":2,"unknown":{"keep":true},"projects":[{"dir":"Other","files":[]},{"dir":"Song","future":{"keep":42},"files":[]}]})).unwrap();f.remote.upload_bytes(&bytes,"catalog.json",&b.singz_root,None,"application/json",&||false).unwrap();let h=f.prepare(&b);f.finish(&h);let catalog=read_catalog(&f.remote,&b.singz_root,&h.path,&||false).unwrap();assert_eq!(catalog.document["unknown"]["keep"],true);assert!(catalog_project_row(&catalog.document,"Other").unwrap().is_some());assert_eq!(catalog_project_row(&catalog.document,"Song").unwrap().unwrap()["future"]["keep"],42);}
    #[test]
    fn third_hash_on_accepted_existing_file_is_never_overwritten(){let f=Fixture::new();f.document("A");let b=f.binding();let first=f.prepare(&b);let first=f.finish(&first);f.document("B");let h=f.prepare(&b);let file=first.publication.expected.members.iter().find(|m|m.name=="project.json").unwrap();f.remote.upload_bytes(b"foreign","project.json",&first.publication.expected.folder.id,Some(&file.id),"application/json",&||false).unwrap();assert!(finish(&f.remote,&h,&||false,&|_,_|{}).is_err());let meta=f.remote.metadata(&file.id,&||false).unwrap();assert_eq!(meta.entry.md5_checksum.as_deref(),Some(md5(b"foreign").as_str()));}
    #[test]
    fn explicit_cancel_keeps_prepared_transaction_and_performs_no_project_write(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);assert!(finish(&f.remote,&h,&||true,&|_,_|{}).is_err());assert_eq!(read(&h).unwrap().phase,Phase::Prepared);assert!(f.remote.children(&b.singz_root,&||false).unwrap().is_empty());assert!(f.finish(&h).lineage.is_some());}
    #[test]
    fn quiet_sync_reuses_complete_boundary_without_allocating_another_transaction(){let f=Fixture::new();f.document("A");let b=f.binding();let first=f.prepare(&b);f.finish(&first);let next=f.prepare(&b);assert_eq!(first.path,next.path);assert!(!first.path.join("payloads").exists());assert_eq!(handles(&f.storage).unwrap().len(),1);assert!(!f.finish(&next).changed);}
    #[test]
    fn unchanged_audio_is_not_copied_into_another_durable_payload_spool(){let f=Fixture::new();f.document("A");let b=f.binding();let first=f.prepare(&b);f.finish(&first);f.document("B");let next=f.prepare(&b);let j=read(&next).unwrap();assert!(j.uploads.iter().all(|u|u.desired.entry.name!="original.wav"));assert!(!next.path.join("payloads/original.wav").exists());assert!(j.members.iter().any(|m|m.entry.name=="original.wav"));f.finish(&next);}
    #[test]
    fn foreign_member_after_acceptance_blocks_all_document_and_catalog_writes(){let f=Fixture::new();f.document("A");let b=f.binding();let h=f.prepare(&b);f.control(json!({"failNext":[{"method":"PUT","path":"/upload-session","status":503}]}));assert!(finish(&f.remote,&h,&||false,&|_,_|{}).is_err());let j=read(&h).unwrap();let foreign=f.remote.upload_bytes(b"foreign","foreign.txt",&j.folder.entry.id,None,"text/plain",&||false).unwrap();let before=f.remote.children(&j.folder.entry.id,&||false).unwrap();assert!(finish(&f.remote,&h,&||false,&|_,_|{}).is_err());assert_eq!(f.remote.children(&j.folder.entry.id,&||false).unwrap(),before);assert_eq!(f.remote.metadata(&foreign,&||false).unwrap().entry.md5_checksum.as_deref(),Some(md5(b"foreign").as_str()));assert!(f.remote.children(&b.singz_root,&||false).unwrap().iter().all(|e|e.name!="catalog.json"));}

    #[test]
    fn affirmative_pruned_members_are_bound_to_completed_folder_and_local_generation(){let f=Fixture::new();f.document("A");fs::create_dir_all(f.root.join("Song/stems")).unwrap();fs::write(f.root.join("Song/stems/vocals.wav"),b"A").unwrap();fs::write(f.root.join("Song/stems/drums.wav"),b"B").unwrap();let b=f.binding();let first=f.prepare(&b);let original=f.finish(&first);let drums=original.publication.expected.members.iter().find(|m|m.name=="drums.wav").unwrap().clone();fs::remove_file(f.root.join("Song/stems/drums.wav")).unwrap();f.document("B");let next=f.prepare(&b);let out=f.finish(&next);let source=out.lineage.unwrap();let owned=owned_pruned_members(&f.storage,&source).unwrap();assert_eq!(owned.len(),1);assert_eq!(owned[0].entry,drums);assert!(owned[0].trashed);assert_eq!(f.remote.metadata(&drums.id,&||false).unwrap(),owned[0]);let mut foreign=source.clone();foreign.folder.entry.id="foreign-folder".into();assert!(owned_pruned_members(&f.storage,&foreign).unwrap().is_empty());}

    #[test]
    fn completed_journal_history_over_4096_does_not_block_lookup_or_new_acceptance(){
        let f=Fixture::new();f.document("A");let binding=f.binding();let first=f.prepare(&binding);f.finish(&first);let original=read(&first).unwrap();let base=f.storage.join("publication-transactions");
        // Direct bounded fixtures avoid 4097 durable write/flush cycles.
        for index in 0..4097 {let mut historical=original.clone();historical.transaction=format!("historical-{index}");historical.capture.local_document=crate::project_store::fingerprint(historical.transaction.as_bytes());let directory=base.join(&historical.transaction);private_dir(&directory).unwrap();fs::write(directory.join("journal.json"),serde_json::to_vec(&historical).unwrap()).unwrap();}
        assert_eq!(handles(&f.storage).unwrap().len(),4098);assert!(resume_pending(&f.remote,&f.storage,&binding,&||false,&|_,_|{}).unwrap().is_empty());
        f.document("B");let next=f.prepare(&binding);assert_ne!(next.path,first.path);let out=f.finish(&next);assert!(out.changed);assert!(out.lineage.is_some());assert_eq!(handles(&f.storage).unwrap().len(),4099);assert!(first.path.join("journal.json").exists());
        // Traversal still validates each entry instead of skipping a suffix.
        fs::write(base.join("invalid-directory-entry"),b"not a directory").unwrap();assert!(handles(&f.storage).is_err());
    }

}

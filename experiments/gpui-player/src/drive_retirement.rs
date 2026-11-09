//! Positively verified publication lineage. Local removals never infer ownership
//! from a name or from an empty library. Cloud retirement is a separate step.
use crate::{directory_identity::{self, DirectoryIdentity}, drive_plan::{self, RemoteEntry}, drive_remote::{Metadata, Remote, FOLDER}};
use anyhow::{Context, Result, ensure};
use md5::{Digest, Md5};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::{collections::{BTreeMap, BTreeSet}, fs::{self, File, OpenOptions}, io::{Read, Write}, path::{Path, PathBuf}};
const LIMIT: u64 = 2 * 1024 * 1024;

#[derive(Debug)]
pub struct IneligibleLineage { pub extra_member_ids: Vec<String> }
impl std::fmt::Display for IneligibleLineage {
    fn fmt(&self,f:&mut std::fmt::Formatter<'_>)->std::fmt::Result {
        write!(f,"Unmanaged Drive members were retained; retirement authority was not cached ({} extra members)",self.extra_member_ids.len())
    }
}
impl std::error::Error for IneligibleLineage {}
pub fn is_ineligible_lineage(error:&anyhow::Error)->bool {error.downcast_ref::<IneligibleLineage>().is_some()}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Binding {
    pub key: String,
    pub local_root: PathBuf,
    pub singz_root: String,
    pub root_identity: DirectoryIdentity,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct LocalCapture {
    pub root_identity: DirectoryIdentity,
    pub local_identity: DirectoryIdentity,
    pub local_document: String,
}
#[derive(Clone, Debug)]
pub struct ExpectedPublication {
    pub folder: RemoteEntry,
    /// Includes the stems folder, when present, and its positively published files.
    pub members: Vec<RemoteEntry>,
    pub catalog_row: Value,
    pub catalog: RemoteEntry,
}
#[derive(Clone, Debug)]
pub struct PublicationPlan { pub capture: LocalCapture, pub expected: ExpectedPublication }
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct PublicationLineage {
    version: u32,
    pub binding: Binding,
    pub project: String,
    pub capture: LocalCapture,
    pub folder: Metadata,
    pub members: Vec<Metadata>,
    pub catalog_row: Value,
}
fn fingerprint(bytes: &[u8]) -> String { crate::project_store::fingerprint(bytes) }
fn md5(bytes: &[u8]) -> String { format!("{:x}", Md5::digest(bytes)) }
fn ordinary_dir(path: &Path) -> Result<()> {
    let meta=fs::symlink_metadata(path)?;
    ensure!(meta.is_dir()&&!meta.file_type().is_symlink(),"Linked lineage directory refused");
    #[cfg(unix)] { use std::os::unix::fs::PermissionsExt; ensure!(meta.permissions().mode()&0o077==0,"Lineage directory must be private"); }
    Ok(())
}
fn private_dir(path: &Path) -> Result<()> {
    if !path.exists() {
        if let Some(parent)=path.parent() { if !parent.exists() { private_dir(parent)?; } }
        let mut builder=fs::DirBuilder::new();
        #[cfg(unix)] { use std::os::unix::fs::DirBuilderExt; builder.mode(0o700); }
        builder.create(path)?;
    }
    ordinary_dir(path)
}
fn bounded(path: &Path) -> Result<Vec<u8>> {
    let meta=fs::symlink_metadata(path)?;
    ensure!(meta.is_file()&&!meta.file_type().is_symlink()&&meta.len()<=LIMIT,"Unsafe lineage record");
    let mut bytes=vec![];File::open(path)?.take(LIMIT+1).read_to_end(&mut bytes)?;
    ensure!(bytes.len() as u64<=LIMIT,"Lineage record exceeds limit");Ok(bytes)
}
fn write_record(path: &Path, bytes: &[u8], immutable: bool) -> Result<()> {
    ensure!(bytes.len() as u64<=LIMIT,"Lineage record exceeds limit");
    let parent=path.parent().context("Lineage record has no parent")?;ordinary_dir(parent)?;
    if path.exists() && immutable { ensure!(bounded(path)?==bytes,"Immutable lineage record changed");return Ok(()); }
    if path.exists() { bounded(path)?; }
    let temporary=parent.join(format!(".lineage-{}.part",crate::drive_http::random_id()?));
    let result=(||->Result<()> {
        let mut file=crate::drive_http::private_file(&temporary)?;file.write_all(bytes)?;file.sync_all()?;
        crate::project_store::replace(&temporary,path)?;
        #[cfg(not(windows))] File::open(parent)?.sync_all()?;
        Ok(())
    })();let _=fs::remove_file(temporary);result
}
fn storage_lease(storage: &Path) -> Result<crate::file_lease::Lease> {
    private_dir(storage)?;let path=storage.join(".lock");
    if path.exists() { bounded(&path)?; }
    let mut options=OpenOptions::new();options.create(true).truncate(false).read(true).write(true);
    #[cfg(unix)] { use std::os::unix::fs::OpenOptionsExt; options.mode(0o600); }
    crate::file_lease::Lease::acquire(options.open(path)?).context("Publication lineage is being changed")
}
fn remote_binding(remote: &Remote, root: &Path, singz: &str, cancel: &impl Fn()->bool) -> Result<String> {
    Ok(fingerprint(&serde_json::to_vec(&(remote.account_key(cancel)?,&remote.auth.config.api_base,&remote.auth.config.client_id,singz,root))?))
}
/// Persist account context before capturing/uploading the first project. No local
/// directory is looked up after publication to manufacture a capture identity.
pub fn bind(remote: &Remote, storage: &Path, root: &Path, singz: &str, cancel: &impl Fn()->bool) -> Result<Binding> {
    let root=root.canonicalize()?;let root_identity=directory_identity::read(&root)?;
    let generation=remote.auth.store.generation();let stop=||cancel()||remote.auth.store.generation()!=generation;
    let key=remote_binding(remote,&root,singz,&stop)?;ensure!(!stop(),"Lineage account changed");
    ensure!(directory_identity::read(&root)?==root_identity,"Library root changed while binding Drive");
    let binding=Binding{key,local_root:root,singz_root:singz.into(),root_identity};
    let _lease=storage_lease(storage)?;let directory=storage.join("bindings");private_dir(&directory)?;
    let path=directory.join(format!("{}.json",fingerprint(&serde_json::to_vec(&binding.local_root)?)));
    write_record(&path,&serde_json::to_vec(&binding)?,false)?;Ok(binding)
}
/// Missing/stale context grants no authority. Unsafe existing state is an error.
pub fn active_binding(storage: &Path, root: &Path) -> Result<Option<String>> {
    if !storage.exists() {return Ok(None);}ordinary_dir(storage)?;
    let root=root.canonicalize()?;let directory=storage.join("bindings");if !directory.exists(){return Ok(None);}ordinary_dir(&directory)?;
    let path=directory.join(format!("{}.json",fingerprint(&serde_json::to_vec(&root)?)));if !path.exists(){return Ok(None);}
    let binding:Binding=serde_json::from_slice(&bounded(&path)?)?;
    ensure!(binding.local_root==root&&binding.key.len()==64&&!binding.singz_root.is_empty(),"Invalid cached lineage binding");
    let current=directory_identity::read(&root)?;
    Ok((current.persistent_eligible()&&binding.root_identity.persistent_eligible()&&current==binding.root_identity).then_some(binding.key))
}
fn actual(remote: &Remote, expected: &RemoteEntry, cancel: &impl Fn()->bool) -> Result<Metadata> {
    let value=remote.metadata(&expected.id,cancel)?;
    ensure!(!value.trashed&&value.entry.id==expected.id&&value.entry.name==expected.name&&value.entry.parents==expected.parents
        &&value.entry.md5_checksum==expected.md5_checksum&&value.entry.size==expected.size
        &&expected.mime_type.as_ref().is_none_or(|mime|value.entry.mime_type.as_ref()==Some(mime))
        &&value.entry.app_properties==expected.app_properties,"Published lineage member differs from planned identity/content/parent");
    Ok(value)
}
fn file_facts(row: &Value) -> Result<BTreeMap<String,(String,String,u64)>> {
    let mut facts=BTreeMap::new();
    for file in row["files"].as_array().context("Invalid publication catalog row")? {
        let name=file["name"].as_str().context("Missing catalog member name")?;
        ensure!(drive_plan::plain_name(name),"Unsafe catalog member name");
        let id=file["id"].as_str().filter(|v|!v.is_empty()).context("Missing catalog member identity")?;
        let checksum=file["md5Checksum"].as_str().filter(|v|crate::drive_snapshot::valid_md5(v)).context("Missing catalog member checksum")?;
        let size=file["size"].as_u64().or_else(||file["size"].as_str().and_then(|v|v.parse().ok())).context("Missing catalog member size")?;
        ensure!(facts.insert(name.into(),(id.into(),checksum.into(),size)).is_none(),"Ambiguous publication catalog member");
    }Ok(facts)
}
fn verify_row(row: &Value, project: &str, top: &[Metadata]) -> Result<()> {
    ensure!(row["dir"]==project,"Catalog row names a different project");let facts=file_facts(row)?;
    let mut positive=BTreeMap::new();
    for meta in top.iter().filter(|meta|meta.entry.mime_type.as_deref()!=Some(FOLDER)) {
        positive.insert(meta.entry.name.clone(),(meta.entry.id.clone(),meta.entry.md5_checksum.clone().context("Published member lacks checksum")?,meta.entry.size.as_deref().context("Published member lacks size")?.parse::<u64>()?));
    }
    ensure!(facts==positive,"Catalog row does not match positively published top members");
    ensure!(facts.contains_key("project.json"),"Publication has no project document");Ok(())
}
fn verify_roster(remote:&Remote,folder:&Metadata,members:&[Metadata],cancel:&impl Fn()->bool)->Result<BTreeSet<String>> {
    let mut extras=BTreeSet::new();
    for parent in std::iter::once(folder.entry.id.as_str()).chain(members.iter().filter(|m|m.entry.mime_type.as_deref()==Some(FOLDER)).map(|m|m.entry.id.as_str())) {
        let listed=remote.children(parent,cancel)?;let actual=listed.iter().map(|m|m.id.clone()).collect::<BTreeSet<_>>();
        ensure!(actual.len()==listed.len(),"Ambiguous remote publication listing");
        let positive=members.iter().filter(|m|m.entry.parents==vec![parent.to_owned()]).map(|m|m.entry.id.clone()).collect::<BTreeSet<_>>();
        ensure!(positive.is_subset(&actual),"Missing positively published member makes lineage invalid");
        extras.extend(actual.difference(&positive).cloned());
    }Ok(extras)
}
/// Only caller-supplied planned identities/fingerprints confer ownership. Actual
/// listings are compared to that complete roster, never promoted into the plan.
pub fn capture_verify_publication(remote: &Remote, binding: &Binding, capture: &LocalCapture, expected: &ExpectedPublication, cancel: &impl Fn()->bool) -> Result<PublicationLineage> {
    ensure!(capture.root_identity==binding.root_identity,"Publication captured a different library root");
    ensure!(capture.local_document.len()==64&&drive_plan::plain_name(&expected.folder.name)&&expected.members.len()<=4096,"Invalid captured publication");
    ensure!(expected.folder.mime_type.as_deref()==Some(FOLDER)&&expected.folder.parents==vec![binding.singz_root.clone()],"Publication folder is outside its bound namespace");
    let generation=remote.auth.store.generation();let stop=||cancel()||remote.auth.store.generation()!=generation;
    ensure!(remote_binding(remote,&binding.local_root,&binding.singz_root,&stop)?==binding.key,"Publication account binding changed");
    let folder=actual(remote,&expected.folder,&stop)?;
    let mut ids=BTreeSet::from([folder.entry.id.clone()]);let mut names=BTreeSet::new();let mut members=vec![];
    for member in &expected.members {
        ensure!(ids.insert(member.id.clone())&&member.parents.len()==1&&names.insert((member.parents[0].clone(),member.name.clone())),"Ambiguous planned publication member");
        ensure!(drive_plan::plain_name(&member.name),"Unsafe publication member name");members.push(actual(remote,member,&stop)?);
    }
    let top=members.iter().filter(|m|m.entry.parents==vec![folder.entry.id.clone()]).cloned().collect::<Vec<_>>();
    let stems=top.iter().filter(|m|m.entry.mime_type.as_deref()==Some(FOLDER)).collect::<Vec<_>>();
    ensure!(stems.len()<=1&&stems.iter().all(|m|m.entry.name=="stems"),"Publication contains an unknown folder");
    for member in &members {
        ensure!(member.entry.parents==vec![folder.entry.id.clone()]||stems.iter().any(|stem|member.entry.parents==vec![stem.entry.id.clone()]&&member.entry.mime_type.as_deref()!=Some(FOLDER)),"Publication contains a nested or foreign member");
    }
    let mut extras=verify_roster(remote,&folder,&members,&stop)?;
    verify_row(&expected.catalog_row,&folder.entry.name,&top)?;
    ensure!(expected.catalog.name=="catalog.json"&&expected.catalog.parents==vec![binding.singz_root.clone()],"Publication catalog is outside its bound namespace");
    let catalog=actual(remote,&expected.catalog,&stop)?;ensure!(catalog.entry.mime_type.as_deref()!=Some(FOLDER),"Publication catalog is a folder");
    let limit=catalog.entry.size.as_deref().context("Catalog lacks size")?.parse::<u64>()?;ensure!(limit<=16*1024*1024,"Publication catalog exceeds limit");
    let temporary=std::env::temp_dir().join(format!("singz-lineage-{}.json",crate::drive_http::random_id()?));
    let read=(||->Result<Value>{remote.download(&catalog.entry.id,&temporary,16*1024*1024,&stop)?;let bytes=fs::read(&temporary)?;
        ensure!(bytes.len()as u64==limit&&catalog.entry.md5_checksum.as_deref()==Some(md5(&bytes).as_str()),"Publication catalog integrity changed");Ok(serde_json::from_slice(&bytes)?)} )();let _=fs::remove_file(temporary);let document=read?;
    ensure!(document["format"]==2,"Unsupported publication catalog");let mut seen=BTreeSet::new();let mut row=None;
    for item in document["projects"].as_array().context("Invalid publication catalog")? {
        let name=item["dir"].as_str().context("Missing catalog project name")?;ensure!(seen.insert(name),"Ambiguous catalog project");if name==folder.entry.name{row=Some(item.clone());}
    }
    let row=row.context("Publication catalog omitted project")?;verify_row(&row,&folder.entry.name,&top)?;
    ensure!(file_facts(&row)?==file_facts(&expected.catalog_row)?,"Publication catalog differs from planned row");
    ensure!(!stop(),"Publication account retired before lineage acknowledgement");
    // Reobserve exact identity/content after the catalog read, without reopening
    // mutable local paths or calling their current inode the captured one.
    actual(remote,&expected.folder,&stop)?;for member in &expected.members {actual(remote,member,&stop)?;}actual(remote,&expected.catalog,&stop)?;
    extras.extend(verify_roster(remote,&folder,&members,&stop)?);
    ensure!(!stop(),"Publication account retired before lineage acknowledgement");
    capture.root_identity.require_persistent()?;capture.local_identity.require_persistent()?;
    if !extras.is_empty(){return Err(IneligibleLineage{extra_member_ids:extras.into_iter().collect()}.into());}
    members.sort_by(|a,b|(&a.entry.parents,&a.entry.name,&a.entry.id).cmp(&(&b.entry.parents,&b.entry.name,&b.entry.id)));
    Ok(PublicationLineage{version:1,binding:binding.clone(),project:folder.entry.name.clone(),capture:capture.clone(),folder,members,catalog_row:row})
}
pub fn record_publication(storage: &Path, lineage: &PublicationLineage) -> Result<String> {
    ensure!(lineage.version==1&&lineage.capture.root_identity==lineage.binding.root_identity&&drive_plan::plain_name(&lineage.project)&&lineage.members.len()<=4096,"Invalid publication lineage");
    lineage.capture.root_identity.require_persistent()?;lineage.capture.local_identity.require_persistent()?;
    let bytes=serde_json::to_vec(lineage)?;let id=fingerprint(&bytes);let _lease=storage_lease(storage)?;let directory=storage.join("publications");private_dir(&directory)?;
    write_record(&directory.join(format!("{id}.json")),&bytes,true)?;
    let latest=storage.join("latest");private_dir(&latest)?;
    let key=identity_key(&lineage.binding.key,&lineage.capture.root_identity,&lineage.project,&lineage.capture.local_identity)?;
    write_record(&latest.join(format!("{key}.json")),&serde_json::to_vec(&id)?,false)?;Ok(id)
}
fn identity_key(binding: &str, root: &DirectoryIdentity, project: &str, local: &DirectoryIdentity) -> Result<String> {
    ensure!(drive_plan::plain_name(project),"Unsafe lineage project identity");
    Ok(fingerprint(&serde_json::to_vec(&(binding,root,project,local))?))
}
/// A durable payload can precede its latest-pointer update after interruption.
/// Callers resolving retirement must verify candidates against the exact current
/// remote generation; neither pointer order nor a filename grants deletion.
pub fn publication_candidates(storage:&Path,binding:&str,root:&DirectoryIdentity,project:&str,local:&DirectoryIdentity)->Result<Vec<(String,PublicationLineage)>> {
    root.require_persistent()?;local.require_persistent()?;
    if !storage.exists(){return Ok(vec![]);}ordinary_dir(storage)?;
    let directory=storage.join("publications");if !directory.exists(){return Ok(vec![]);}ordinary_dir(&directory)?;
    let mut out=vec![];for entry in fs::read_dir(&directory)? {let path=entry?.path();if path.extension().and_then(|v|v.to_str())!=Some("json"){continue;}
        let bytes=bounded(&path)?;let id=fingerprint(&bytes);ensure!(path.file_stem().and_then(|v|v.to_str())==Some(id.as_str()),"Publication lineage filename/content mismatch");let value:PublicationLineage=serde_json::from_slice(&bytes)?;
        ensure!(value.version==1&&value.members.len()<=4096&&value.capture.root_identity==value.binding.root_identity,"Invalid publication lineage record");
        if !value.capture.root_identity.persistent_eligible()||!value.capture.local_identity.persistent_eligible(){continue;}
        if value.binding.key==binding&&value.capture.root_identity==*root&&value.project==project&&value.capture.local_identity==*local {out.push((id,value));}
    }
    let latest=storage.join("latest");if latest.exists(){ordinary_dir(&latest)?;let path=latest.join(format!("{}.json",identity_key(binding,root,project,local)?));
        if path.exists(){let id:String=serde_json::from_slice(&bounded(&path)?)?;ensure!(out.iter().any(|row|row.0==id),"Latest publication points at a missing or foreign lineage");out.sort_by_key(|row|row.0!=id);}}
    Ok(out)
}
pub fn latest_publication(storage:&Path,binding:&str,root:&DirectoryIdentity,project:&str,local:&DirectoryIdentity)->Result<Option<(String,PublicationLineage)>> {
    let latest=storage.join("latest");if !latest.exists(){return Ok(None);}ordinary_dir(&latest)?;
    let path=latest.join(format!("{}.json",identity_key(binding,root,project,local)?));if !path.exists(){return Ok(None);}
    let id:String=serde_json::from_slice(&bounded(&path)?)?;
    Ok(publication_candidates(storage,binding,root,project,local)?.into_iter().find(|row|row.0==id))
}
pub fn publications(storage: &Path, binding: &Binding) -> Result<Vec<PublicationLineage>> {
    if !storage.exists(){return Ok(vec![]);}ordinary_dir(storage)?;let directory=storage.join("publications");if !directory.exists(){return Ok(vec![]);}ordinary_dir(&directory)?;
    let mut out=vec![];for entry in fs::read_dir(&directory)? {let path=entry?.path();if path.extension().and_then(|v|v.to_str())!=Some("json"){continue;}
        let bytes=bounded(&path)?;ensure!(path.file_stem().and_then(|v|v.to_str())==Some(fingerprint(&bytes).as_str()),"Publication lineage filename/content mismatch");let value:PublicationLineage=serde_json::from_slice(&bytes)?;
        ensure!(value.version==1&&value.members.len()<=4096&&value.capture.root_identity==value.binding.root_identity,"Invalid publication lineage record");
        if !value.capture.root_identity.persistent_eligible()||!value.capture.local_identity.persistent_eligible(){continue;}
        if value.binding==*binding {out.push(value);}
    }Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::drive_auth::{AuthClient,Config,OAuthSession,TokenStore};
    use serde_json::json;
    use std::{io::{BufRead,BufReader},process::{Child,Command,Stdio}};
    struct Fixture {base:PathBuf,root:PathBuf,storage:PathBuf,remote:Remote,server:Child}
    impl Fixture {
        fn new()->Self {
            let base=std::env::temp_dir().join(format!("singz-lineage-http-{}",crate::drive_http::random_id().unwrap()));
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
        fn publish(&self)->(Binding,LocalCapture,ExpectedPublication) {
            let singz=self.remote.folder("SingZ",None,&||false).unwrap();let binding=bind(&self.remote,&self.storage,&self.root,&singz,&||false).unwrap();
            let bytes=br#"{"version":2,"name":"Song","settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]},"stemHashes":{}}"#;
            fs::write(self.root.join("Song/project.json"),bytes).unwrap();let capture=crate::drive_snapshot::capture_empty(&self.root,"Song",&self.base.join("spool"),&||false).unwrap();let local=capture.publication_capture();let transported=fs::read(&capture.snapshot.top[0].path).unwrap();drop(capture);
            let folder_id=self.remote.folder("Song",Some(&singz),&||false).unwrap();let document_id=self.remote.upload_bytes(&transported,"project.json",&folder_id,None,"application/json",&||false).unwrap();
            let member=RemoteEntry{id:document_id.clone(),name:"project.json".into(),mime_type:Some("application/json".into()),parents:vec![folder_id.clone()],md5_checksum:Some(md5(&transported)),size:Some(transported.len().to_string()),..Default::default()};
            let row=json!({"dir":"Song","files":[{"id":document_id,"name":"project.json","md5Checksum":md5(&transported),"size":transported.len()}]});let catalog=serde_json::to_vec(&json!({"format":2,"projects":[row.clone()]})).unwrap();
            let catalog_id=self.remote.upload_bytes(&catalog,"catalog.json",&singz,None,"application/json",&||false).unwrap();
            let expected=ExpectedPublication{folder:RemoteEntry{id:folder_id,name:"Song".into(),mime_type:Some(FOLDER.into()),parents:vec![singz.clone()],..Default::default()},members:vec![member],catalog_row:row,catalog:RemoteEntry{id:catalog_id,name:"catalog.json".into(),mime_type:Some("application/json".into()),parents:vec![singz],md5_checksum:Some(md5(&catalog)),size:Some(catalog.len().to_string()),..Default::default()}};
            (binding,local,expected)
        }
    }
    impl Drop for Fixture {fn drop(&mut self){let _=self.server.kill();let _=self.server.wait();let _=fs::remove_dir_all(&self.base);}}
    #[test]
    fn publication_receipt_keeps_the_pre_upload_directory_identity_after_same_name_recreation() {
        let f=Fixture::new();let (binding,capture,expected)=f.publish();
        fs::rename(f.root.join("Song"),f.root.join("Aside")).unwrap();fs::create_dir(f.root.join("Song")).unwrap();let replacement=directory_identity::read(&f.root.join("Song")).unwrap();assert_ne!(replacement,capture.local_identity);
        let receipt=capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap();assert_eq!(receipt.capture.local_identity,capture.local_identity);
        let id=record_publication(&f.storage,&receipt).unwrap();assert_eq!(record_publication(&f.storage,&receipt).unwrap(),id);
        assert!(latest_publication(&f.storage,&binding.key,&capture.root_identity,"Song",&capture.local_identity).unwrap().is_some());
        assert!(latest_publication(&f.storage,&binding.key,&capture.root_identity,"Song",&replacement).unwrap().is_none());
        assert!(latest_publication(&f.storage,&binding.key,&capture.root_identity,"Renamed",&capture.local_identity).unwrap().is_none());
        assert_eq!(active_binding(&f.storage,&f.root).unwrap(),Some(binding.key.clone()));
        let old_root=f.base.join("retired-library");fs::rename(&f.root,old_root).unwrap();fs::create_dir(&f.root).unwrap();assert_eq!(active_binding(&f.storage,&f.root).unwrap(),None);
    }
    #[test]
    fn foreign_retained_files_and_changed_planned_bytes_cannot_gain_retirement_authority() {
        let f=Fixture::new();let (binding,capture,expected)=f.publish();
        f.remote.upload_bytes(b"foreign","notes.bin",&expected.folder.id,None,"application/octet-stream",&||false).unwrap();
        assert!(is_ineligible_lineage(&capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap_err()));
        assert!(publications(&f.storage,&binding).unwrap().is_empty());
        f.remote.upload_bytes(b"changed","project.json",&expected.folder.id,Some(&expected.members[0].id),"application/json",&||false).unwrap();
        let error=capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap_err();assert!(!is_ineligible_lineage(&error));
        assert!(publications(&f.storage,&binding).unwrap().is_empty());
    }
    #[test]
    fn missing_birth_identity_never_becomes_persistent_retirement_authority_or_masks_content_failure() {
        let f=Fixture::new();let (binding,capture,expected)=f.publish();
        let receipt=capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap();
        let mut document=serde_json::to_value(&capture.local_identity).unwrap();document["created"]=Value::Null;
        let mut weak=capture.clone();weak.local_identity=serde_json::from_value(document).unwrap();
        let error=capture_verify_publication(&f.remote,&binding,&weak,&expected,&||false).unwrap_err();
        assert!(directory_identity::is_persistent_unavailable(&error));
        let mut weak_receipt=receipt;weak_receipt.capture=weak.clone();
        assert!(directory_identity::is_persistent_unavailable(&record_publication(&f.storage,&weak_receipt).unwrap_err()));
        // An older on-disk record also remains ineligible after upgrade. Reading
        // it must not turn a reusable inode number into durable ownership.
        let bytes=serde_json::to_vec(&weak_receipt).unwrap();let directory=f.storage.join("publications");private_dir(&directory).unwrap();
        write_record(&directory.join(format!("{}.json",fingerprint(&bytes))),&bytes,true).unwrap();
        assert!(publications(&f.storage,&binding).unwrap().is_empty());
        assert!(publication_candidates(&f.storage,&binding.key,&capture.root_identity,"Song",&capture.local_identity).unwrap().is_empty());
        f.remote.upload_bytes(b"changed","project.json",&expected.folder.id,Some(&expected.members[0].id),"application/json",&||false).unwrap();
        let error=capture_verify_publication(&f.remote,&binding,&weak,&expected,&||false).unwrap_err();
        assert!(!directory_identity::is_persistent_unavailable(&error),"Missing birth identity cannot mask a changed published payload");
    }
    #[test]
    fn unindexed_but_durable_publication_payload_is_available_for_verified_retry() {
        let f=Fixture::new();let (binding,capture,expected)=f.publish();let receipt=capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap();
        let id=record_publication(&f.storage,&receipt).unwrap();fs::remove_dir_all(f.storage.join("latest")).unwrap();
        let candidates=publication_candidates(&f.storage,&binding.key,&capture.root_identity,"Song",&capture.local_identity).unwrap();assert_eq!(candidates.len(),1);assert_eq!(candidates[0].0,id);
        assert_eq!(record_publication(&f.storage,&receipt).unwrap(),id);
    }
    #[test]
    fn complete_receipt_history_over_4096_remains_queryable_and_accepts_new_receipts() {
        let f=Fixture::new();let(binding,capture,expected)=f.publish();let lineage=capture_verify_publication(&f.remote,&binding,&capture,&expected,&||false).unwrap();record_publication(&f.storage,&lineage).unwrap();
        let directory=f.storage.join("publications");
        // Populate historical immutable records directly: exercising thousands
        // of disk fsyncs would test the OS rather than this lifetime boundary.
        for index in 0..4097 {let mut historical=lineage.clone();historical.capture.local_document=fingerprint(format!("historical-{index}").as_bytes());let bytes=serde_json::to_vec(&historical).unwrap();fs::write(directory.join(format!("{}.json",fingerprint(&bytes))),bytes).unwrap();}
        assert_eq!(publication_candidates(&f.storage,&binding.key,&capture.root_identity,"Song",&capture.local_identity).unwrap().len(),4098);
        assert_eq!(publications(&f.storage,&binding).unwrap().len(),4098);
        let mut next=lineage.clone();next.capture.local_document=fingerprint(b"new publication after lifetime boundary");let id=record_publication(&f.storage,&next).unwrap();let newest=latest_publication(&f.storage,&binding.key,&capture.root_identity,"Song",&capture.local_identity).unwrap().unwrap();assert_eq!(newest.0,id);assert_eq!(newest.1,next);
        assert_eq!(publications(&f.storage,&binding).unwrap().len(),4099);
        // Every record is still individually validated; no prefix truncation
        // or quota relaxation may make corrupt history invisible.
        fs::write(directory.join("not-the-content-hash.json"),b"{}").unwrap();assert!(publications(&f.storage,&binding).is_err());
    }

}

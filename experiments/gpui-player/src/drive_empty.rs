//! Explicit-empty publication: preserve the prior generation, catalog last.
//! The ordinary writer remains guarded until its coordinator qualifies this path.
use crate::{drive_remote::{Remote,Metadata,FOLDER},drive_plan::RemoteEntry,drive_snapshot};
use anyhow::{Context,Result,ensure,bail};
use md5::{Digest,Md5};
use serde_json::{Value,json};
use std::{collections::{BTreeMap,BTreeSet},fs,path::{Path,PathBuf}};
#[path="drive_empty_journal.rs"]
pub mod journal;
use journal::{Journal,Payload,Phase,Store,OrdinaryIntent};
const LIMIT:u64=16*1024*1024;
#[derive(Clone,Debug)]
pub struct Request {pub binding:String,pub library_root:PathBuf,pub journal_root:PathBuf,pub singz_root:String,pub project:String}
#[derive(Clone,Debug)]
pub struct Receipt {pub project:String,pub local_document:String,pub folder_id:String,pub document_id:String,pub catalog:Value,pub transaction:String,pub repair:bool,pub publication:Option<crate::drive_retirement::PublicationPlan>}
fn check(cancel:&impl Fn()->bool)->Result<()> {ensure!(!cancel(),"Empty publication cancelled; recoverable transaction retained");Ok(())}
fn md5(bytes:&[u8])->String {format!("{:x}",Md5::digest(bytes))}
fn same_content(a:&Metadata,b:&Metadata)->bool {a.entry.id==b.entry.id&&a.entry.name==b.entry.name&&a.entry.mime_type==b.entry.mime_type&&a.entry.md5_checksum==b.entry.md5_checksum&&a.entry.size==b.entry.size&&a.entry.app_properties==b.entry.app_properties&&!b.trashed}
fn exact(a:&Metadata,b:&Metadata)->bool {same_content(a,b)&&a.entry.parents==b.entry.parents}
fn unique<'a>(rows:&'a[RemoteEntry],name:&str)->Result<Option<&'a RemoteEntry>> {let found=rows.iter().filter(|r|r.name==name).collect::<Vec<_>>();ensure!(found.len()<=1,"Ambiguous remote member {name}");Ok(found.first().copied())}
fn observed(remote:&Remote,id:&str,cancel:&impl Fn()->bool)->Result<Metadata>{let m=remote.metadata(id,cancel)?;ensure!(!m.trashed&&m.entry.parents.len()==1,"Missing, trashed or multiply-parented transaction member");Ok(m)}
fn read_remote(remote:&Remote,store:&Store,entry:&Metadata,cancel:&impl Fn()->bool)->Result<Vec<u8>> {
    let expected=entry.entry.md5_checksum.as_deref().filter(|s|drive_snapshot::valid_md5(s)).context("Remote document has no checksum")?;
    let size=entry.entry.size.as_deref().and_then(|n|n.parse::<u64>().ok()).filter(|n|*n<=LIMIT).context("Remote document has no bounded size")?;
    let path=store.path.join(format!(".read-{}.part",crate::drive_http::random_id()?));
    let result=(||->Result<Vec<u8>>{remote.download(&entry.entry.id,&path,LIMIT,cancel)?;let bytes=journal::bounded(&path,LIMIT)?;ensure!(bytes.len()as u64==size&&md5(&bytes)==expected,"Remote transaction document integrity mismatch");Ok(bytes)})();let _=fs::remove_file(path);result
}
fn assert_binding(j:&Journal,r:&Request,root:&Path)->Result<()> {ensure!(j.binding==r.binding&&j.local_root==root&&j.singz_root==r.singz_root&&j.project==r.project,"Empty transaction belongs to a different account/root/project");Ok(())}
fn local_current(j:&Journal)->Result<()> {let bytes=journal::bounded(&j.local_root.join(&j.project).join("project.json"),LIMIT)?;ensure!(crate::project_store::fingerprint(&bytes)==j.local_document,"Local Save changed; empty transaction requires recovery before publishing newer state");
    if let Some(capture)=&j.capture {ensure!(crate::directory_identity::read(&j.local_root)?==capture.root_identity&&crate::directory_identity::read(&j.local_root.join(&j.project))?==capture.local_identity,"Local directory changed; empty transaction requires recovery before publishing a replacement");}Ok(())}
fn account_binding(remote:&Remote,root:&Path,singz:&str,cancel:&impl Fn()->bool)->Result<String> {
    let account=remote.account_key(cancel)?;
    Ok(crate::project_store::fingerprint(&serde_json::to_vec(&(account,&remote.auth.config.api_base,&remote.auth.config.client_id,singz,root))?))
}
fn local_authority(j:&Journal)->Result<()> {if j.repair {Ok(())}else{local_current(j)}}
fn owned_properties(r:&Request,tx:&str)->BTreeMap<String,String> {BTreeMap::from([("singzEmptyProtocol".into(),"1".into()),("singzEmptyBinding".into(),crate::project_store::fingerprint(r.binding.as_bytes())),("singzEmptyRoot".into(),r.singz_root.clone()),("singzEmptyTransaction".into(),tx.into())])}
fn catalog_before(remote:&Remote,store:&Store,root:&str,cancel:&impl Fn()->bool)->Result<(Option<Metadata>,Value)> {
    let children=remote.children(root,cancel)?;
    if let Some(row)=unique(&children,"catalog.json")? {
        let meta=observed(remote,&row.id,cancel)?;let bytes=read_remote(remote,store,&meta,cancel)?;
        let doc:Value=serde_json::from_slice(&bytes)?;ensure!(doc["format"]==2&&doc["projects"].is_array(),"Existing catalog cannot be safely merged");store.write("catalog-before.json",&bytes)?;return Ok((Some(meta),doc));
    }
    let doc=json!({"format":2,"capabilities":{"adopt":1},"projects":[]});
    store.write("catalog-before.json",&serde_json::to_vec(&doc)?)?;Ok((None,doc))
}
fn catalog_file(meta:&Metadata)->Result<Value> {
    let hash=meta.entry.md5_checksum.as_deref().filter(|h|drive_snapshot::valid_md5(h)).context("Catalog document has no valid fingerprint")?;
    let size=meta.entry.size.as_deref().and_then(|s|s.parse::<u64>().ok()).context("Catalog document has no valid size")?;
    Ok(json!({"id":meta.entry.id,"name":meta.entry.name,"size":size,"md5Checksum":hash}))
}
fn merged_catalog(before:&Value,project:&str,installed:&[Metadata])->Result<Value> {
    let mut next=before.clone();let rows=next["projects"].as_array_mut().context("Invalid catalog project list")?;let mut found=None;let mut dirs=BTreeSet::new();
    for (index,row) in rows.iter().enumerate(){let dir=row["dir"].as_str().context("Invalid catalog project name")?;ensure!(dirs.insert(dir.to_owned()),"Duplicate catalog project");if dir==project {found=Some(index);}}
    let files=installed.iter().map(catalog_file).collect::<Result<Vec<_>>>()?;
    if let Some(index)=found {rows[index]["files"]=json!(files);}else{rows.push(json!({"dir":project,"files":files}));}
    Ok(next)
}
fn validate_catalog_baseline(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    let rows=remote.children(&j.singz_root,cancel)?;let current=unique(&rows,"catalog.json")?;
    match (&j.old_catalog,current) {(Some(old),Some(now))=>ensure!(exact(old,&observed(remote,&now.id,cancel)?),"Catalog changed during empty publication"),(None,None)=>{},_=>bail!("Catalog identity changed during empty publication")};Ok(())
}
fn verify_payload(meta:&Metadata,p:&Payload)->Result<()> {ensure!(meta.entry.md5_checksum.as_deref()==Some(p.md5.as_str())&&meta.entry.size.as_deref().and_then(|s|s.parse::<u64>().ok())==Some(p.size),"Staged empty payload differs from captured bytes");Ok(())}
fn stage_name(name:&str)->String {format!("empty-{name}")}
fn stage(remote:&Remote,store:&Store,j:&mut Journal,cancel:&impl Fn()->bool,stats:&mut Stats)->Result<()> {
    let history=j.history.as_ref().context("Missing owned recovery generation")?.entry.id.clone();
    for p in j.payloads.clone() {
        let name=stage_name(&p.name);let id=j.staged_ids.get(&p.name).context("Staged payload has no durable reserved identity")?;
        let before=remote.metadata_if_exists(id,cancel)?;
        let bytes=store.payload(&p.name)?;ensure!(md5(&bytes)==p.md5&&bytes.len()as u64==p.size,"Captured empty payload changed");
        let meta=remote.upload_reserved_bytes(id,&bytes,&name,&history,"application/json",cancel)?;
        if before.is_some(){stats.unchanged+=1;}else{stats.uploaded+=1;}
        ensure!(meta.entry.id==*id&&meta.entry.name==name&&meta.entry.parents==vec![history.clone()],"Staged empty payload name or parent changed before retirement");
        verify_payload(&meta,&p)?;let observed=read_remote(remote,store,&meta,cancel)?;ensure!(observed==bytes,"Staged empty body failed verification");
        if !j.staged.iter().any(|m|m.entry.id==meta.entry.id){j.staged.push(meta);store.save(j)?;}
    }
    j.phase=Phase::Staged;store.save(j)
}
fn expected_location(original:&Metadata,parent:&str,name:Option<&str>)->Metadata {let mut expected=original.clone();expected.entry.parents=vec![parent.into()];if let Some(name)=name {expected.entry.name=name.into();}expected}
fn recovery_roster(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    ensure!(exact(&j.folder,&observed(remote,&j.folder.entry.id,cancel)?),"Active project folder identity changed");
    if let Some(history)=&j.history {ensure!(exact(history,&observed(remote,&history.entry.id,cancel)?),"Recovery generation ownership changed");}
    let allowed=j.moves.iter().chain(j.staged.iter()).map(|m|m.entry.id.as_str()).collect::<BTreeSet<_>>();
    ensure!(remote.children(&j.folder.entry.id,cancel)?.iter().all(|m|allowed.contains(m.id.as_str())),"Foreign active member conflicts with empty publication");
    for folder in j.baseline.iter().filter(|m|m.entry.mime_type.as_deref()==Some(FOLDER)) {
        let expected=j.baseline.iter().filter(|m|m.entry.parents.contains(&folder.entry.id)).map(|m|m.entry.id.clone()).collect::<BTreeSet<_>>();
        let actual=remote.children(&folder.entry.id,cancel)?.into_iter().map(|m|m.id).collect::<BTreeSet<_>>();
        ensure!(expected==actual,"Retained generation member roster changed");
    }
    Ok(())
}
fn archive_proof(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    recovery_roster(remote,j,cancel)?;
    let history=&j.history.as_ref().context("Missing recovery generation")?.entry.id;
    for old in &j.baseline {
        let expected=if j.moves.iter().any(|m|m.entry.id==old.entry.id){expected_location(old,history,None)}else{old.clone()};
        ensure!(exact(&expected,&observed(remote,&old.entry.id,cancel)?),"Retired generation identity/content/parent changed");
    }
    Ok(())
}
fn audio_free(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool,installed:bool)->Result<()> {
    let members=remote.children(&j.folder.entry.id,cancel)?;
    let allowed=if installed{j.staged.iter().map(|m|m.entry.id.as_str()).collect::<BTreeSet<_>>()}else{BTreeSet::new()};
    ensure!(members.iter().all(|m|allowed.contains(m.id.as_str())),"Unexpected active member prevents an audio-free publication");
    if installed {for p in &j.payloads {let row=unique(&members,&p.name)?.context("Installed empty payload is missing")?;let meta=observed(remote,&row.id,cancel)?;verify_payload(&meta,p)?;}}
    Ok(())
}
struct CaptureNotice<'a>(&'a dyn Fn(Option<PathBuf>));
impl Drop for CaptureNotice<'_> {fn drop(&mut self){(self.0)(None);}}
fn new_journal(remote:&Remote,store:&Store,r:&Request,root:&Path,cancel:&impl Fn()->bool,capturing:&impl Fn(Option<PathBuf>))->Result<Journal> {
    let transaction=crate::drive_http::random_id()?;let generation=store.new_generation(&transaction)?;let store=&generation;
    capturing(Some(root.join(&r.project)));let notice=CaptureNotice(capturing);
    let capture_dir=store.path.join(format!("capture-{}",crate::drive_http::random_id()?));let mut builder=fs::DirBuilder::new();#[cfg(unix)] {use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}builder.create(&capture_dir)?;
    let capture=drive_snapshot::capture_empty(root,&r.project,&capture_dir,cancel)?;
    let mut payloads=vec![];for f in &capture.snapshot.top {let bytes=journal::bounded(&f.path,LIMIT)?;store.write(&f.name,&bytes)?;payloads.push(Payload{name:f.name.clone(),md5:md5(&bytes),size:bytes.len()as u64});}
    let local_document=capture.local_document.clone();let captured=capture.publication_capture();drop(capture);drop(notice);let _=fs::remove_dir(capture_dir);
    let existing=remote.children(&r.singz_root,cancel)?;let admitted=unique(&existing,&r.project)?.map(|row|row.id.clone());
    let binding=crate::drive_retirement::Binding{key:r.binding.clone(),local_root:root.into(),singz_root:r.singz_root.clone(),root_identity:captured.root_identity.clone()};
    crate::drive_retire_transaction::admit_destination(remote,&r.journal_root.parent().context("Empty journal has no private namespace")?.join("retirements"),&binding,&r.project,&captured,admitted.as_deref(),cancel)?;
    let mut journal=journal_from_payloads(remote,store,r,root,cancel,local_document,payloads,false,&transaction,&[],admitted.as_deref())?;
    journal.capture=Some(captured);Ok(journal)
}
fn journal_from_payloads(remote:&Remote,store:&Store,r:&Request,root:&Path,cancel:&impl Fn()->bool,local_document:String,payloads:Vec<Payload>,repair:bool,transaction:&str,additional_top:&[String],admitted_id:Option<&str>)->Result<Journal> {
    let children=remote.children(&r.singz_root,cancel)?;
    ensure!(unique(&children,&r.project)?.map(|row|row.id.as_str())==admitted_id,"Empty destination changed after admission; foreign replacement was preserved");
    let active_properties=BTreeMap::from([("singzEmptyProtocol".into(),"1".into()),("singzEmptyBinding".into(),crate::project_store::fingerprint(r.binding.as_bytes())),("singzEmptyRoot".into(),r.singz_root.clone()),("singzEmptyActive".into(),crate::project_store::fingerprint(r.project.as_bytes()))]);
    let folder_pending=unique(&children,&r.project)?.is_none();
    let folder=if let Some(row)=unique(&children,&r.project)? {ensure!(row.mime_type.as_deref()==Some(FOLDER),"Active project is not a folder");observed(remote,&row.id,cancel)?}
        else {Metadata{entry:RemoteEntry{id:remote.generate_id(cancel)?,name:r.project.clone(),mime_type:Some(FOLDER.into()),parents:vec![r.singz_root.clone()],app_properties:active_properties.clone(),..Default::default()},trashed:false}};
    let top=if folder_pending{vec![]}else{remote.children(&folder.entry.id,cancel)?};
    let mut allowed_top=BTreeSet::from(["project.json".to_owned(),"lyrics.json".to_owned(),"graph.json".to_owned(),"stems".to_owned()]);
    allowed_top.extend(additional_top.iter().cloned());
    if let Some(document)=unique(&top,"project.json")? {
        ensure!(document.mime_type.as_deref()!=Some(FOLDER),"Current document is a folder");
        let old=observed(remote,&document.id,cancel)?;let bytes=read_remote(remote,store,&old,cancel)?;
        let doc:Value=serde_json::from_slice(&bytes)?;ensure!(doc.is_object(),"Old generation document is unreadable");
        if let Some(song)=doc["songFile"].as_str(){ensure!(crate::drive_plan::plain_name(song),"Old source audio path is unsafe");allowed_top.insert(song.into());}
        store.write("document-before.json",&bytes)?;
    } else {ensure!(top.is_empty()&&active_properties.iter().all(|(k,v)|folder.entry.app_properties.get(k)==Some(v)),"Existing generation has no unique document");}
    ensure!(top.iter().all(|m|allowed_top.contains(&m.name)),"Unexpected active file prevents bounded empty publication");
    let mut baseline=vec![];let mut moves=vec![];let mut names=BTreeSet::new();
    for item in &top {ensure!(names.insert(item.name.clone()),"Ambiguous active project member");
        let meta=observed(remote,&item.id,cancel)?;ensure!(meta.entry.parents==vec![folder.entry.id.clone()],"Remote member has unexpected parent");
        if item.mime_type.as_deref()==Some(FOLDER) {ensure!(item.name=="stems","Unknown project folder prevents bounded recovery");
            for child in remote.children(&item.id,cancel)? {ensure!(child.mime_type.as_deref()!=Some(FOLDER),"Nested stems prevent bounded recovery");let child=observed(remote,&child.id,cancel)?;ensure!(child.entry.parents==vec![item.id.clone()],"Stem parent changed");baseline.push(child);}
        }
        moves.push(meta.clone());baseline.push(meta);
    }
    ensure!(baseline.len()<=4096,"Remote recovery generation too large");
    moves.sort_by_key(|m|m.entry.name!="project.json"); // Old document FIRST.
    let (old_catalog,_)=catalog_before(remote,store,&r.singz_root,cancel)?;
    store.write("catalog-after.json",b"null")?;
    let singz=observed(remote,&r.singz_root,cancel)?;ensure!(singz.entry.mime_type.as_deref()==Some(FOLDER),"Library root is not a folder");
    let history_parent=singz.entry.parents[0].clone();let history_id=remote.generate_id(cancel)?;
    let staged_ids=payloads.iter().map(|p|Ok((p.name.clone(),remote.generate_id(cancel)?))).collect::<Result<BTreeMap<_,_>>>()?;
    let catalog_id=if old_catalog.is_none(){Some(remote.generate_id(cancel)?)}else{None};
    // GET-only ID allocation is safe before this journal is saved. Every POST
    // later consumes one of these durable identities, never a fresh retry ID.
    Ok(Journal{version:1,binding:r.binding.clone(),local_root:root.into(),singz_root:r.singz_root.clone(),project:r.project.clone(),transaction:transaction.into(),local_document,phase:Phase::Captured,folder,folder_pending,history_id,history_parent,staged_ids,catalog_id,baseline,moves,old_catalog,history:None,payloads,staged:vec![],installed_catalog:None,ordinary:None,repair,storage_generation:true,capture:None})
}
fn receipt(j:&Journal,catalog:Value)->Result<Receipt> {
    let doc=j.staged.iter().find(|m|m.entry.name==stage_name("project.json")).context("Missing staged document receipt")?;
    let publication=if let Some(capture)=&j.capture {
        let row=catalog["projects"].as_array().and_then(|rows|rows.iter().find(|row|row["dir"]==j.project)).context("Verified empty catalog omitted project")?.clone();
        Some(crate::drive_retirement::PublicationPlan{capture:capture.clone(),expected:crate::drive_retirement::ExpectedPublication{
            folder:j.folder.entry.clone(),members:installed_entries(j)?.into_iter().map(|m|m.entry).collect(),catalog_row:row,
            catalog:j.installed_catalog.as_ref().context("Missing verified empty catalog identity")?.entry.clone(),
        }})
    }else{None};
    Ok(Receipt{project:j.project.clone(),local_document:j.local_document.clone(),folder_id:j.folder.entry.id.clone(),document_id:doc.entry.id.clone(),catalog,transaction:j.transaction.clone(),repair:j.repair,publication})
}
fn installed_entries(j:&Journal)->Result<Vec<Metadata>> {
    j.payloads.iter().map(|p|{let old=j.staged.iter().find(|m|m.entry.name==stage_name(&p.name)).context("Missing staged payload identity")?;Ok(expected_location(old,&j.folder.entry.id,Some(&p.name)))}).collect()
}
fn catalog_row_matches(current:&Value,intended:&Value,project:&str)->Result<bool> {
    let select=|doc:&Value|->Result<Value>{let rows=doc["projects"].as_array().context("Invalid terminal catalog")?;
        let mut names=BTreeSet::new();let mut own=None;
        for row in rows {let name=row["dir"].as_str().context("Invalid catalog project")?;ensure!(names.insert(name),"Ambiguous catalog rows");if name==project {own=Some(row["files"].clone());}}
        Ok(own.unwrap_or(Value::Null))};
    let current=select(current)?;let intended=select(intended)?;
    if !current.is_array()||!intended.is_array(){return Ok(false);}
    let keys=|rows:&Value|->Result<BTreeMap<String,(String,String,u64)>> {let mut facts=BTreeMap::new();
        for file in rows.as_array().unwrap(){let name=file["name"].as_str().context("Missing catalog file name")?.to_owned();let fact=(file["id"].as_str().context("Missing catalog file ID")?.to_owned(),file["md5Checksum"].as_str().context("Missing catalog file checksum")?.to_owned(),file["size"].as_u64().or_else(||file["size"].as_str().and_then(|s|s.parse().ok())).context("Missing catalog file size")?);ensure!(facts.insert(name,fact).is_none(),"Duplicate catalog file");}Ok(facts)};
    Ok(keys(&current)?==keys(&intended)?)
}
fn catalog_matches(remote:&Remote,store:&Store,j:&Journal,cancel:&impl Fn()->bool)->Result<Option<Metadata>> {
    let path=store.path.join("catalog-after.json");if !path.exists(){return Ok(None);}
    let intended=store.payload("catalog-after.json")?;let rows=remote.children(&j.singz_root,cancel)?;
    let Some(row)=unique(&rows,"catalog.json")? else{return Ok(None)};
    let meta=observed(remote,&row.id,cancel)?;
    let bytes=read_remote(remote,store,&meta,cancel)?;
    let current:Value=serde_json::from_slice(&bytes)?;let intended_doc:Value=serde_json::from_slice(&intended)?;
    if intended_doc["format"]!=2{return Ok(None);}
    if current["format"]!=2||!catalog_row_matches(&current,&intended_doc,&j.project)? {return Ok(None);}
    Ok(Some(meta))
}
fn active_namespace(remote:&Remote,j:&Journal,allow_missing:bool,cancel:&impl Fn()->bool)->Result<()> {
    let root=remote.children(&j.singz_root,cancel)?;let folder=unique(&root,&j.project)?;
    ensure!(folder.as_ref().is_none_or(|f|f.id==j.folder.entry.id),"A foreign same-name project prevents empty publication");
    ensure!(allow_missing||folder.is_some(),"Empty publication folder disappeared");Ok(())
}
fn complete_proof(remote:&Remote,store:&Store,j:&Journal,cancel:&impl Fn()->bool)->Result<Option<Metadata>> {
    let Some(catalog)=catalog_matches(remote,store,j,cancel)? else{return Ok(None)};
    audio_free(remote,j,cancel,true)?;archive_proof(remote,j,cancel)?;
    for installed in installed_entries(j)? {ensure!(exact(&installed,&observed(remote,&installed.entry.id,cancel)?),"Installed empty document identity changed");}
    Ok(Some(catalog))
}
#[derive(Clone,Debug,Default)]
struct Stats {uploaded:usize,unchanged:usize}
fn capture_legacy_origin(store:&Store,j:&mut Journal,root:&Path,cancel:&impl Fn()->bool,capturing:&impl Fn(Option<PathBuf>))->Result<()> {
    if j.capture.is_some()||j.repair||j.ordinary.is_some()||matches!(j.phase,Phase::RolledBack|Phase::Superseded|Phase::RollingBack|Phase::Retired){return Ok(());}
    capturing(Some(root.join(&j.project)));let notice=CaptureNotice(capturing);
    let scratch=store.path.join(format!("capture-origin-{}",crate::drive_http::random_id()?));let mut builder=fs::DirBuilder::new();
    #[cfg(unix)]{use std::os::unix::fs::DirBuilderExt;builder.mode(0o700);}builder.create(&scratch)?;
    let result=(||->Result<()> {
        let capture=drive_snapshot::capture_empty(root,&j.project,&scratch,cancel).context("Legacy empty publication needs a coherent explicit-empty local capture before lineage can be acknowledged")?;
        if capture.local_document==j.local_document {
            let expected=j.payloads.iter().map(|p|(p.name.clone(),(p.md5.clone(),p.size))).collect::<BTreeMap<_,_>>();
            let current=capture.snapshot.top.iter().map(|p|(p.name.clone(),(p.md5.clone(),p.size))).collect::<BTreeMap<_,_>>();
            ensure!(current==expected,"Legacy empty payloads changed; save the current arrangement before retrying Drive");
            j.capture=Some(capture.publication_capture());store.save(j)?;
        }
        Ok(())
    })();drop(notice);let _=fs::remove_dir_all(scratch);result
}
fn publish_one(remote:&Remote,r:&Request,cancel:&impl Fn()->bool,progress:&impl Fn(String,f32),capturing:&impl Fn(Option<PathBuf>))->Result<(Receipt,bool,Stats)> {
    let mut stats=Stats::default();
    let root=r.library_root.canonicalize()?;let store=Store::open(&r.journal_root,&r.binding,&root,&r.singz_root,&r.project)?;
    let mut j=match store.read()? {Some(j)=>{assert_binding(&j,r,&root)?;j},None=>{let j=new_journal(remote,&store,r,&root,cancel,capturing)?;store.save(&j)?;j}};
    let mut store=store.for_journal(&j)?;
    if j.phase==Phase::Retired {store.write(&format!("retired-{}.json",j.transaction),&serde_json::to_vec(&j)?)?;j=new_journal(remote,&store,r,&root,cancel,capturing)?;store.save(&j)?;store=store.for_journal(&j)?;}
    capture_legacy_origin(&store,&mut j,&root,cancel,capturing)?;
    if j.phase==Phase::Committed&&j.repair {j.repair=false;store.save(&j)?;}
    if let Some(catalog)=complete_proof(remote,&store,&j,cancel)? {
        j.installed_catalog=Some(catalog);let was_committed=j.phase==Phase::Committed;j.phase=Phase::Committed;store.save(&j)?;
        // A verified terminal effect stays committed even if a newer Save exists.
        // The coordinator must compare the captured fingerprint before clearing it.
        let same_local=journal::bounded(&root.join(&r.project).join("project.json"),LIMIT).ok().is_some_and(|bytes|crate::project_store::fingerprint(&bytes)==j.local_document);
        if same_local||!was_committed||j.repair {stats.unchanged=j.payloads.len();let current=read_remote(remote,&store,j.installed_catalog.as_ref().unwrap(),cancel)?;return Ok((receipt(&j,serde_json::from_slice(&current)?)?,!was_committed,stats));}
        store.write(&format!("committed-{}.json",j.transaction),&serde_json::to_vec(&j)?)?;
        j=new_journal(remote,&store,r,&root,cancel,capturing)?;store.save(&j)?;store=store.for_journal(&j)?;
    } else {ensure!(j.phase!=Phase::Committed,"Committed empty publication was changed remotely; refresh before writing");}
    if matches!(j.phase,Phase::RolledBack|Phase::Superseded) {store.write(&format!("{}-{}.json",if j.phase==Phase::Superseded{"superseded"}else{"rolledback"},j.transaction),&serde_json::to_vec(&j)?)?;j=new_journal(remote,&store,r,&root,cancel,capturing)?;store.save(&j)?;store=store.for_journal(&j)?;}
    ensure!(j.phase!=Phase::RollingBack,"Empty publication requires explicit recovery resolution");
    local_authority(&j)?;check(cancel)?;active_namespace(remote,&j,j.folder_pending,cancel)?;
    if j.folder_pending {
        let folder=remote.owned_folder_with_id(&j.folder.entry.id,&j.folder.entry.name,&j.singz_root,&j.folder.entry.app_properties,cancel)?;
        ensure!(exact(&j.folder,&folder),"Reserved active folder identity changed");j.folder_pending=false;store.save(&j)?;
    }
    active_namespace(remote,&j,false,cancel)?;
    if j.history.is_none() {
        let properties=owned_properties(r,&j.transaction);
        // This generation is outside SingZ, so ordinary folder reconciliation
        // can never delete the sole recoverable media after a title rename.
        let history=remote.owned_folder_with_id(&j.history_id,&format!("SingZ recovery {}",j.transaction),&j.history_parent,&properties,cancel)?;
        ensure!(!history.entry.parents.contains(&j.singz_root),"Recovery generation lies inside the active library");j.history=Some(history);store.save(&j)?;
    }
    if j.phase==Phase::Captured {progress(format!("Preparing empty {}…",j.project),0.1);stage(remote,&store,&mut j,cancel,&mut stats)?;}
    let history=j.history.as_ref().unwrap().entry.id.clone();
    if matches!(j.phase,Phase::Staged|Phase::Archiving) {
        local_authority(&j)?;validate_catalog_baseline(remote,&j,cancel)?;
        // Check the entire baseline before first retirement. Later prefixes are
        // proved by each exact ID, allowing an acknowledged/lost move to resume.
        if j.phase==Phase::Staged {for m in &j.baseline {ensure!(exact(m,&observed(remote,&m.entry.id,cancel)?),"Remote baseline changed before archiving");}}
        j.phase=Phase::Archiving;store.save(&j)?;
        for old in &j.moves {check(cancel)?;local_authority(&j)?;recovery_roster(remote,&j,cancel)?;remote.move_verified(old,&history,None,cancel)?;}
        archive_proof(remote,&j,cancel)?;audio_free(remote,&j,cancel,false)?;j.phase=Phase::Archived;store.save(&j)?;
    }
    if j.phase==Phase::Archived {
        local_authority(&j)?;validate_catalog_baseline(remote,&j,cancel)?;archive_proof(remote,&j,cancel)?;
        // Install lyrics before the document; there is never a current document
        // referencing a missing member, including interrupted installation.
        let mut payloads=j.payloads.clone();payloads.sort_by_key(|p|p.name=="project.json");
        for p in payloads {check(cancel)?;local_authority(&j)?;recovery_roster(remote,&j,cancel)?;
            let staged=j.staged.iter().find(|m|m.entry.name==stage_name(&p.name)).context("Missing staged empty member")?;
            remote.move_verified(staged,&j.folder.entry.id,Some(&p.name),cancel)?;
        }
        audio_free(remote,&j,cancel,true)?;j.phase=Phase::Installed;store.save(&j)?;
    }
    ensure!(j.phase==Phase::Installed,"Unsupported pending empty publication state");
    check(cancel)?;local_authority(&j)?;validate_catalog_baseline(remote,&j,cancel)?;archive_proof(remote,&j,cancel)?;audio_free(remote,&j,cancel,true)?;
    let before:Value=serde_json::from_slice(&store.payload("catalog-before.json")?)?;
    active_namespace(remote,&j,false,cancel)?;
    let catalog=merged_catalog(&before,&j.project,&installed_entries(&j)?)?;let bytes=serde_json::to_vec(&catalog)?;ensure!(bytes.len()as u64<=LIMIT,"Merged catalog exceeds supported size");
    store.write("catalog-after.json",&bytes)?;store.save(&j)?; // Durable intent BEFORE HTTP.
    progress(format!("Publishing empty {}…",j.project),0.9);
    let sent=if let Some(old)=&j.old_catalog {remote.upload_bytes(&bytes,"catalog.json",&j.singz_root,Some(&old.entry.id),"application/json",cancel).map(|_|())}
        else {remote.upload_reserved_bytes(j.catalog_id.as_deref().context("Catalog has no durable reserved identity")?,&bytes,"catalog.json",&j.singz_root,"application/json",cancel).map(|_|())};
    if let Err(error)=sent {check(cancel)?;if catalog_matches(remote,&store,&j,cancel)?.is_none(){return Err(error);}}
    let terminal=complete_proof(remote,&store,&j,cancel)?.context("Empty publication has no verified terminal catalog")?;
    stats.uploaded+=1;
    j.installed_catalog=Some(terminal);j.phase=Phase::Committed;store.save(&j)?;
    Ok((receipt(&j,catalog)?,true,stats))
}

/// Roll back only an uncommitted, still-owned prefix. Media return before the
/// old document. A verified terminal publication is never silently reversed.
pub fn rollback(remote:&Remote,r:&Request,cancel:&impl Fn()->bool)->Result<()> {
    let root=r.library_root.canonicalize()?;let generation=remote.auth.store.generation();let user_cancel=cancel;let cancel=&||user_cancel()||remote.auth.store.generation()!=generation;
    ensure!(account_binding(remote,&root,&r.singz_root,cancel)?==r.binding,"Recovery account binding changed");
    let store=Store::open(&r.journal_root,&r.binding,&root,&r.singz_root,&r.project)?;
    let mut j=store.read()?.context("No recoverable empty transaction")?;assert_binding(&j,r,&root)?;let store=store.for_journal(&j)?;
    ensure!(!j.repair,"An interrupted ordinary repair must finish its known empty target, not reactivate a partial baseline");
    ensure!(complete_proof(remote,&store,&j,cancel)?.is_none()&&j.phase!=Phase::Committed,"Empty publication is committed; restoring it requires a new explicit arrangement");
    validate_catalog_baseline(remote,&j,cancel)?;
    let Some(history)=j.history.as_ref().map(|m|m.entry.id.clone()) else {j.phase=Phase::RolledBack;return store.save(&j)};
    // Do not remove a foreign or newer active generation to make rollback fit.
    recovery_roster(remote,&j,cancel)?;
    let top=remote.children(&j.folder.entry.id,cancel)?;
    let allowed=j.moves.iter().chain(j.staged.iter()).map(|m|m.entry.id.as_str()).collect::<BTreeSet<_>>();
    ensure!(top.iter().all(|m|allowed.contains(m.id.as_str())),"Active folder changed; rollback refused");
    j.phase=Phase::RollingBack;store.save(&j)?;
    // Withdraw our new document FIRST, before reactivating any old media.
    let mut staged=j.staged.clone();staged.sort_by_key(|m|m.entry.name!=stage_name("project.json"));
    for m in &staged {check(cancel)?;let active=expected_location(m,&j.folder.entry.id,Some(m.entry.name.strip_prefix("empty-").context("Invalid staged name")?));
        let now=observed(remote,&m.entry.id,cancel)?;
        if exact(&active,&now){remote.move_verified(&active,&history,Some(&m.entry.name),cancel)?;}else{ensure!(exact(m,&now),"Staged recovery member changed");}
    }
    let mut moves=j.moves.clone();moves.sort_by_key(|m|m.entry.name=="project.json");
    for old in &moves {check(cancel)?;let archived=expected_location(old,&history,None);let now=observed(remote,&old.entry.id,cancel)?;
        if old.entry.name=="project.json" {for member in j.baseline.iter().filter(|m|m.entry.id!=old.entry.id) {ensure!(exact(member,&observed(remote,&member.entry.id,cancel)?),"Old document cannot activate incomplete media");}}
        if exact(&archived,&now){remote.move_verified(&archived,&j.folder.entry.id,None,cancel)?;}else{ensure!(exact(old,&now),"Original recovery member changed");}
    }
    // Catalog was never overwritten unless terminal publication applied. That
    // case is detected above; never blindly restore an old whole-library file.
    validate_catalog_baseline(remote,&j,cancel)?;j.phase=Phase::RolledBack;store.save(&j)
}
fn nonempty_document(bytes:&[u8])->Result<Value> {
    let doc:Value=serde_json::from_slice(bytes)?;ensure!(doc.is_object()&&doc["settings"]["nativeEmptyTracks"]!=true,"Ordinary supersession requires a nonempty project");
    let stems=doc["stemHashes"].as_object().context("Ordinary document has no explicit audio roster")?;
    ensure!(!stems.is_empty()||doc["songFile"].as_str().is_some_and(crate::drive_plan::plain_name),"Ordinary document declares no audio");Ok(doc)
}
fn hash_payload(name:&str,hash:&Value)->Result<Payload> {
    ensure!(crate::drive_plan::plain_name(name),"Unsafe authorized publication name");
    Ok(Payload{name:name.into(),md5:hash["md5"].as_str().filter(|s|drive_snapshot::valid_md5(s)).context("Invalid authorized payload checksum")?.into(),size:hash["size"].as_u64().context("Invalid authorized payload size")?})
}
fn ordinary_rosters(doc:&Value,document_md5:&str,document_size:u64)->Result<(Vec<Payload>,Vec<Payload>)> {
    let hashes=doc["stemHashes"].as_object().context("Missing authorized audio roster")?;ensure!(hashes.len()<=1024,"Authorized audio roster exceeds limit");
    let stems=hashes.iter().map(|(name,hash)|hash_payload(name,hash)).collect::<Result<Vec<_>>>()?;
    let mut top=vec![Payload{name:"project.json".into(),md5:document_md5.into(),size:document_size}];
    if stems.is_empty(){top.push(hash_payload(doc["songFile"].as_str().context("Missing authorized source audio")?,&doc["songHash"])?);}
    for (name,key) in [("graph.json","graphHash"),("lyrics.json","lyricsHash")] {if doc.get(key).is_some(){top.push(hash_payload(name,&doc[key])?);}}
    let mut names=BTreeSet::new();ensure!(top.iter().all(|p|names.insert(&p.name)),"Authorized top members alias one another");Ok((top,stems))
}
fn immutable_payload(store:&Store,name:&str,bytes:&[u8])->Result<()> {
    if store.path.join(name).exists(){ensure!(store.payload(name)?==bytes,"Immutable ordinary payload differs from durable intent");Ok(())}
    else {store.write(name,bytes)}
}
fn ordinary_payload_name(j:&Journal,intent:&OrdinaryIntent)->Result<String> {
    let name=intent.payload_file.clone().unwrap_or_else(||format!("ordinary-{}.json",j.transaction));
    ensure!(crate::drive_plan::plain_name(&name),"Unsafe ordinary intent payload reference");Ok(name)
}
fn ordinary_bytes(store:&Store,j:&Journal,intent:&OrdinaryIntent)->Result<Vec<u8>> {
    let bytes=store.payload(&ordinary_payload_name(j,intent)?)?;
    ensure!(md5(&bytes)==intent.md5&&bytes.len()as u64==intent.size,"Durable ordinary intent bytes changed");
    if let Some(name)=&intent.payload_file {ensure!(*name==format!("ordinary-{}.json",crate::project_store::fingerprint(&bytes)),"Ordinary content-addressed payload reference differs from bytes");}
    Ok(bytes)
}
fn archive_ordinary_intent(store:&Store,j:&Journal)->Result<()> {
    let intent=j.ordinary.as_ref().context("Missing ordinary intent to preserve")?;let bytes=ordinary_bytes(store,j,intent)?;
    immutable_payload(store,&format!("ordinary-{}.json",crate::project_store::fingerprint(&bytes)),&bytes)?;
    let record=serde_json::to_vec(j)?;immutable_payload(store,&format!("intent-{}.json",crate::project_store::fingerprint(&record)),&record)
}
fn hydrate_ordinary(store:&Store,j:&mut Journal)->Result<()> {
    let Some(intent)=&j.ordinary else{return Ok(())};let bytes=ordinary_bytes(store,j,intent)?;let doc=nonempty_document(&bytes)?;
    let (top,stems)=ordinary_rosters(&doc,&intent.md5,intent.size)?;let mut changed=false;
    if intent.expected_top.is_empty(){let intent=j.ordinary.as_mut().unwrap();intent.expected_top=top;intent.expected_stems=stems;changed=true;}
    else {ensure!(intent.expected_top==top&&intent.expected_stems==stems,"Durable ordinary roster differs from authorized document");}
    if j.ordinary.as_ref().unwrap().payload_file.is_none(){
        // Upgrade legacy transaction-only files by adding an immutable copy.
        // An interrupted journal save leaves the old reference and bytes valid.
        let name=format!("ordinary-{}.json",crate::project_store::fingerprint(&bytes));immutable_payload(store,&name,&bytes)?;
        j.ordinary.as_mut().unwrap().payload_file=Some(name);changed=true;
    }
    if changed{store.save(j)?;}Ok(())
}
fn preserved_history(remote:&Remote,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    let history=j.history.as_ref().context("Missing previous recovery history")?;
    ensure!(exact(history,&observed(remote,&history.entry.id,cancel)?),"Previous recovery history changed");
    for old in &j.baseline {let expected=if j.moves.iter().any(|m|m.entry.id==old.entry.id){expected_location(old,&history.entry.id,None)}else{old.clone()};ensure!(exact(&expected,&observed(remote,&old.entry.id,cancel)?),"Previous recovery payload changed");}
    for folder in j.baseline.iter().filter(|m|m.entry.mime_type.as_deref()==Some(FOLDER)) {
        let expected=j.baseline.iter().filter(|m|m.entry.parents.contains(&folder.entry.id)).map(|m|m.entry.id.clone()).collect::<BTreeSet<_>>();
        ensure!(remote.children(&folder.entry.id,cancel)?.into_iter().map(|m|m.id).collect::<BTreeSet<_>>()==expected,"Previous recovery payload roster changed");
    }Ok(())
}
#[derive(Clone)]
struct OwnedSubset {members:Vec<Metadata>,catalog:Metadata}
fn owned_ordinary_subset(remote:&Remote,store:&Store,j:&Journal,cancel:&impl Fn()->bool)->Result<OwnedSubset> {
    let intent=j.ordinary.as_ref().context("Missing authorized ordinary intent")?;preserved_history(remote,j,cancel)?;
    ensure!(exact(&j.folder,&observed(remote,&j.folder.entry.id,cancel)?),"Ordinary active folder changed");
    let root=remote.children(&j.singz_root,cancel)?;let catalog=unique(&root,"catalog.json")?.context("Prior empty catalog disappeared")?;let catalog=observed(remote,&catalog.id,cancel)?;
    let current:Value=serde_json::from_slice(&read_remote(remote,store,&catalog,cancel)?)?;let expected:Value=serde_json::from_slice(&store.payload("catalog-after.json")?)?;
    ensure!(current["format"]==2&&catalog_row_matches(&current,&expected,&j.project)?,"Project catalog row changed outside the authorized partial publication");
    let top=remote.children(&j.folder.entry.id,cancel)?;ensure!(top.len()<=1026,"Partial ordinary top roster exceeds limit");
    let empty=installed_entries(j)?;let mut members=vec![];let mut names=BTreeSet::new();
    for row in &top {ensure!(names.insert(row.name.clone()),"Ambiguous partial ordinary member");let actual=observed(remote,&row.id,cancel)?;
        ensure!(actual.entry.parents==vec![j.folder.entry.id.clone()],"Partial ordinary member parent changed");
        if row.name=="stems" {
            ensure!(!intent.expected_stems.is_empty()&&actual.entry.mime_type.as_deref()==Some(FOLDER)&&actual.entry.app_properties.is_empty(),"Unknown partial ordinary folder");
            let children=remote.children(&row.id,cancel)?;ensure!(children.len()<=intent.expected_stems.len(),"Foreign partial ordinary stem");let mut seen=BTreeSet::new();
            for child in children {ensure!(seen.insert(child.name.clone()),"Ambiguous partial ordinary stem");let expected=intent.expected_stems.iter().find(|p|p.name==child.name).context("Unknown partial ordinary stem")?;
                let child=observed(remote,&child.id,cancel)?;ensure!(child.entry.parents==vec![row.id.clone()]&&child.entry.mime_type.as_deref()!=Some(FOLDER)&&child.entry.app_properties.is_empty(),"Partial ordinary stem identity changed");verify_payload(&child,expected)?;members.push(child);
            }
        } else {
            let prior=empty.iter().find(|m|m.entry.name==row.name);
            let planned=intent.expected_top.iter().find(|p|p.name==row.name);
            if prior.is_some_and(|m|exact(m,&actual)) {} else {
                let planned=planned.context("Foreign top member in partial ordinary publication")?;
                if let Some(prior)=prior {ensure!(prior.entry.id==actual.entry.id&&prior.entry.app_properties==actual.entry.app_properties,"Partial publication replaced a known document identity");}
                else {ensure!(actual.entry.app_properties.is_empty(),"Foreign partial ordinary metadata");}
                ensure!(actual.entry.mime_type.as_deref()!=Some(FOLDER),"Partial ordinary payload is a folder");verify_payload(&actual,planned)?;
            }
            if row.name=="project.json" {ensure!(actual.entry.id==intent.document_id,"Foreign current project document");let bytes=read_remote(remote,store,&actual,cancel)?;ensure!(bytes==store.payload("project.json")?||bytes==ordinary_bytes(store,j,intent)?,"Current document is neither prior empty nor authorized ordinary bytes");}
        }
        members.push(actual);
    }
    for prior in &empty {ensure!(names.contains(&prior.entry.name),"Prior empty member disappeared during ordinary publication");}
    members.sort_by(|a,b|a.entry.id.cmp(&b.entry.id));Ok(OwnedSubset{members,catalog})
}
fn begin_ordinary_repair(remote:&Remote,store:&Store,r:&Request,root:&Path,j:&Journal,cancel:&impl Fn()->bool)->Result<()> {
    let proof=owned_ordinary_subset(remote,store,j,cancel)?;
    for payload in &j.payloads {let bytes=store.payload(&payload.name)?;ensure!(md5(&bytes)==payload.md5&&bytes.len()as u64==payload.size,"Prior empty recovery payload changed");}
    // Save predecessor and its terminal catalog before replacing current intent.
    // No remote mutation has occurred; the new journal persists all reserved IDs.
    store.write(&format!("predecessor-{}.json",j.transaction),&serde_json::to_vec(j)?)?;
    store.write(&format!("catalog-{}.json",j.transaction),&store.payload("catalog-after.json")?)?;
    let transaction=crate::drive_http::random_id()?;let generation=store.new_generation(&transaction)?;
    for payload in &j.payloads {generation.write(&payload.name,&store.payload(&payload.name)?)?;}
    let allowed=j.ordinary.as_ref().unwrap().expected_top.iter().map(|p|p.name.clone()).collect::<Vec<_>>();
    let mut next=journal_from_payloads(remote,&generation,r,root,cancel,j.local_document.clone(),j.payloads.clone(),true,&transaction,&allowed,Some(&j.folder.entry.id))?;
    let mut baseline=next.baseline.clone();baseline.sort_by(|a,b|a.entry.id.cmp(&b.entry.id));
    ensure!(baseline==proof.members&&next.old_catalog.as_ref()==Some(&proof.catalog),"Authorized partial publication changed while preparing repair");
    // Recheck exact captured IDs/bytes/catalog before authorizing any retirement.
    for old in &proof.members {ensure!(exact(old,&observed(remote,&old.entry.id,cancel)?),"Partial publication changed before repair intent");}
    ensure!(exact(&proof.catalog,&observed(remote,&proof.catalog.entry.id,cancel)?),"Catalog changed before repair intent");
    next.repair=true;next.capture=j.capture.clone();generation.save(&next)
}
fn declared_member(remote:&Remote,rows:&[RemoteEntry],name:&str,hash:&Value,parent:&str,cancel:&impl Fn()->bool)->Result<Metadata> {
    ensure!(crate::drive_plan::plain_name(name),"Unsafe declared publication member");let row=unique(rows,name)?.context("Declared ordinary payload is missing")?;
    let actual=observed(remote,&row.id,cancel)?;
    ensure!(actual.entry.parents==vec![parent.to_owned()]&&hash["md5"].as_str().is_some_and(drive_snapshot::valid_md5)&&actual.entry.md5_checksum.as_deref()==hash["md5"].as_str()&&actual.entry.size.as_deref().and_then(|s|s.parse::<u64>().ok())==hash["size"].as_u64(),"Ordinary published payload differs from captured document");Ok(actual)
}
/// Prove a specifically authorized ordinary generation, including the catalog
/// row and every declared audio/graph dependency; changed document alone is not
/// authority to retire the old empty-generation journal.
fn ordinary_terminal(remote:&Remote,store:&Store,j:&Journal,cancel:&impl Fn()->bool)->Result<Option<Value>> {
    let intent=j.ordinary.as_ref().context("Missing durable ordinary publication intent")?;
    let Some(document)=remote.metadata_if_exists(&intent.document_id,cancel)? else{return Ok(None)};
    if document.trashed||document.entry.parents!=vec![j.folder.entry.id.clone()]||document.entry.name!="project.json"||document.entry.md5_checksum.as_deref()!=Some(intent.md5.as_str())||document.entry.size.as_deref().and_then(|s|s.parse::<u64>().ok())!=Some(intent.size){return Ok(None);}
    let expected=ordinary_bytes(store,j,intent)?;ensure!(md5(&expected)==intent.md5&&expected.len()as u64==intent.size,"Durable ordinary intent payload changed");
    let bytes=read_remote(remote,store,&document,cancel)?;ensure!(bytes==expected,"Ordinary remote document differs from authorized bytes");let doc=nonempty_document(&bytes)?;
    let root=remote.children(&j.singz_root,cancel)?;let Some(catalog)=unique(&root,"catalog.json")? else{return Ok(None)};
    let catalog_meta=observed(remote,&catalog.id,cancel)?;let catalog:Value=serde_json::from_slice(&read_remote(remote,store,&catalog_meta,cancel)?)?;
    if catalog["format"]!=2{return Ok(None);}
    let row=catalog["projects"].as_array().and_then(|rows|rows.iter().find(|r|r["dir"]==j.project));
    let promised=row.and_then(|r|r["files"].as_array()).and_then(|files|files.iter().find(|f|f["name"]=="project.json"));
    if !promised.is_some_and(|f|f["id"]==intent.document_id&&f["md5Checksum"]==intent.md5&&(f["size"].as_u64().or_else(||f["size"].as_str().and_then(|s|s.parse().ok())))==Some(intent.size)){return Ok(None);}
    let top=remote.children(&j.folder.entry.id,cancel)?;let mut files=vec![catalog_file(&document)?];
    let hashes=doc["stemHashes"].as_object().unwrap();
    if !hashes.is_empty(){let stem_folder=unique(&top,"stems")?.context("Ordinary stem folder is missing")?;ensure!(stem_folder.mime_type.as_deref()==Some(FOLDER),"Ordinary stems destination is not a folder");let stems=remote.children(&stem_folder.id,cancel)?;
        ensure!(stems.len()==hashes.len(),"Ordinary audio roster differs from declared generation");
        for (name,hash) in hashes {declared_member(remote,&stems,name,hash,&stem_folder.id,cancel)?;}
    } else {let song=doc["songFile"].as_str().context("Missing ordinary source audio")?;files.push(catalog_file(&declared_member(remote,&top,song,&doc["songHash"],&j.folder.entry.id,cancel)?)?);}
    for (name,key) in [("graph.json","graphHash"),("lyrics.json","lyricsHash")] {
        if doc.get(key).is_some(){files.push(catalog_file(&declared_member(remote,&top,name,&doc[key],&j.folder.entry.id,cancel)?)?);}
        else if name=="graph.json" {ensure!(unique(&top,name)?.is_none(),"Unreferenced graph remains in ordinary generation");}
    }
    let intended=json!({"projects":[{"dir":j.project,"files":files}]});
    if !catalog_row_matches(&catalog,&intended,&j.project)? {return Ok(None);}
    // Old history remains untouched even though its formerly active document
    // ID now legitimately contains the new generation after an ordinary PATCH.
    preserved_history(remote,j,cancel)?;
    Ok(Some(catalog))
}
fn mark_superseded(store:&Store,j:&mut Journal)->Result<()> {
    store.write(&format!("committed-{}.json",j.transaction),&serde_json::to_vec(j)?)?;
    j.phase=Phase::Superseded;store.save(j)
}
/// Record exact planned ordinary document bytes before any generic upload/trash.
/// A missing old journal is a no-op and performs no account lookup.
pub fn prepare_ordinary_publication(remote:&Remote,root:&Path,journal_root:&Path,singz:&str,project:&str,local_document:&str,captured:&crate::drive_retirement::LocalCapture,planned_doc:Option<&crate::drive_plan::LocalEntry>,existing_doc_id:Option<&str>,cancel:&impl Fn()->bool)->Result<()> {
    let root=root.canonicalize()?;let prior=journal::journals(journal_root)?.into_iter().find(|j|j.local_root==root&&j.singz_root==singz&&j.project==project&&j.phase==Phase::Committed);
    let Some(prior)=prior else{return Ok(())};let generation=remote.auth.store.generation();let original_cancel=cancel;let cancel=&||original_cancel()||remote.auth.store.generation()!=generation;let binding=account_binding(remote,&root,singz,cancel)?;ensure!(binding==prior.binding,"Ordinary supersession account changed");
    let store=Store::open(journal_root,&binding,&root,singz,project)?;let mut j=store.read()?.context("Missing prior empty journal")?;let store=store.for_journal(&j)?;
    ensure!(captured.local_document==local_document,"Ordinary publication capture fingerprint differs from planned source");
    if let Some(prior)=&j.capture {
        ensure!(prior.root_identity==captured.root_identity&&prior.local_identity==captured.local_identity,
            "Committed empty publication belongs to another local directory; retire its lineage before name reuse");
    }else{
        // The caller captured these identities under the publication lease before
        // network; preserve the old empty document fingerprint for repair receipts.
        // Never call the current same-name directory the origin after an upload.
        j.capture=Some(crate::drive_retirement::LocalCapture{root_identity:captured.root_identity.clone(),local_identity:captured.local_identity.clone(),local_document:j.local_document.clone()});
        store.save(&j)?;
    }
    let id=existing_doc_id.context("Existing committed empty document cannot be replaced by an unreserved new identity")?;
    ensure!(j.staged.iter().any(|m|m.entry.name==stage_name("project.json")&&m.entry.id==id),"Ordinary plan targets a foreign document identity");
    let planned_doc=planned_doc.context("Repair unreadable project metadata before replacing a committed empty generation")?;
    let bytes=journal::bounded(&planned_doc.path,LIMIT)?;ensure!(planned_doc.name=="project.json"&&md5(&bytes)==planned_doc.md5&&bytes.len()as u64==planned_doc.size,"Ordinary plan document differs from verified capture");nonempty_document(&bytes)?;
    let doc=nonempty_document(&bytes)?;let (expected_top,expected_stems)=ordinary_rosters(&doc,&planned_doc.md5,planned_doc.size)?;
    hydrate_ordinary(&store,&mut j)?;
    let payload_file=format!("ordinary-{}.json",crate::project_store::fingerprint(&bytes));
    let intent=OrdinaryIntent{local_document:local_document.into(),document_id:id.into(),md5:planned_doc.md5.clone(),size:planned_doc.size,payload_file:Some(payload_file.clone()),expected_top,expected_stems};
    if let Some(old)=&j.ordinary {
        if *old==intent{return Ok(());}
        ensure!(complete_proof(remote,&store,&j,cancel)?.is_some(),"A partially applied ordinary publication requires verified recovery before replacing its intent");
        archive_ordinary_intent(&store,&j)?;
    }
    ensure!(complete_proof(remote,&store,&j,cancel)?.is_some(),"Prior empty generation changed without authorized supersession");
    immutable_payload(&store,&payload_file,&bytes)?;j.ordinary=Some(intent);store.save(&j)
}
/// Called only with the generic writer's planned row and independently verified
/// planned catalog identity. Never derive expected hashes from server metadata.
pub fn acknowledge_ordinary_publication(remote:&Remote,root:&Path,journal_root:&Path,singz:&str,rows:&BTreeMap<String,(String,Value)>,expected_catalog:&RemoteEntry,cancel:&impl Fn()->bool)->Result<()> {
    let root=root.canonicalize()?;let all=journal::journals(journal_root)?;
    let relevant=all.into_iter().filter(|j|j.local_root==root&&j.singz_root==singz&&j.phase==Phase::Committed&&j.ordinary.is_some()&&rows.contains_key(&j.project)).collect::<Vec<_>>();if relevant.is_empty(){return Ok(());}
    let generation=remote.auth.store.generation();let original_cancel=cancel;let cancel=&||original_cancel()||remote.auth.store.generation()!=generation;
    let binding=account_binding(remote,&root,singz,cancel)?;let current=observed(remote,&expected_catalog.id,cancel)?;
    ensure!(current.entry.name=="catalog.json"&&current.entry.parents==vec![singz.to_owned()]&&current.entry.md5_checksum==expected_catalog.md5_checksum&&current.entry.size==expected_catalog.size,"Ordinary terminal catalog differs from planned receipt");
    for prior in relevant {ensure!(prior.binding==binding,"Ordinary terminal account changed");let store=Store::open(journal_root,&binding,&root,singz,&prior.project)?;let mut j=store.read()?.context("Missing supersession journal")?;let store=store.for_journal(&j)?;
        let (local,row)=&rows[&j.project];ensure!(j.ordinary.as_ref().is_some_and(|i|i.local_document==*local),"Ordinary terminal fingerprint differs from durable intent");
        let catalog=ordinary_terminal(remote,&store,&j,cancel)?.context("Ordinary generation is not fully published")?;
        ensure!(catalog_row_matches(&catalog,&json!({"projects":[row]}),&j.project)?,"Ordinary catalog row differs from writer plan");mark_superseded(&store,&mut j)?;
    }Ok(())
}

#[derive(Clone,Debug,Default)]
pub struct Report {pub synced:BTreeMap<PathBuf,String>,pub rows:BTreeMap<String,Value>,pub changed:bool,pub deferred:Vec<PathBuf>,pub uploaded:usize,pub unchanged:usize,pub publications:Vec<crate::drive_retirement::PublicationPlan>}
pub fn has_pending(journal_root:&Path)->Result<bool> {Ok(journal::journals(journal_root)?.iter().any(|j|!matches!(j.phase,Phase::Committed|Phase::Superseded|Phase::RolledBack|Phase::Retired)))}
/// The caller has already verified terminal retirement of this exact positive
/// lineage. This only closes its local empty-history pointer; archives remain.
pub fn retire_verified(journal_root:&Path,source:&crate::drive_retirement::PublicationLineage)->Result<bool> {
    let prior=journal::journals(journal_root)?.into_iter().find(|j|j.binding==source.binding.key&&j.local_root==source.binding.local_root&&j.singz_root==source.binding.singz_root&&j.project==source.project&&j.folder.entry.id==source.folder.entry.id);
    let Some(prior)=prior else{return Ok(false)};
    let base=Store::open(journal_root,&source.binding.key,&source.binding.local_root,&source.binding.singz_root,&source.project)?;let mut j=base.read()?.context("Retired empty history disappeared")?;
    if j.folder.entry.id!=prior.folder.entry.id{return Ok(false);}
    ensure!(j.binding==source.binding.key,"Retired empty history changed binding");
    if j.phase==Phase::Retired{return Ok(false);}let store=base.for_journal(&j)?;
    j.phase=Phase::Retired;store.write(&format!("retired-{}.json",j.transaction),&serde_json::to_vec(&j)?)?;store.save(&j)?;Ok(true)
}
/// Called before adoption/orphan reconciliation. No empty intent and no pending
/// journal performs no account/Drive request. A changed pass ends reconciliation.
pub fn run(remote:&Remote,library_root:&Path,journal_root:&Path,singz_id:&str,root_listing:&[RemoteEntry],cancel:&impl Fn()->bool,progress:&impl Fn(String,f32),capturing:&impl Fn(Option<PathBuf>))->Result<Report> {
    let root=library_root.canonicalize()?;let journals=journal::journals(journal_root)?;
    let mut candidates=BTreeSet::new();
    for name in drive_snapshot::scan(&root,cancel)? {let bytes=journal::bounded(&root.join(&name).join("project.json"),LIMIT)?;
        if serde_json::from_slice::<Value>(&bytes).ok().is_some_and(|v|v["settings"]["nativeEmptyTracks"]==true){candidates.insert(name);}
    }
    let matching=journals.iter().filter(|j|j.singz_root==singz_id&&j.local_root==root&&!matches!(j.phase,Phase::Committed|Phase::Superseded|Phase::RolledBack|Phase::Retired)).collect::<Vec<_>>();
    let ordinary=journals.iter().filter(|j|j.singz_root==singz_id&&j.local_root==root&&j.phase==Phase::Committed&&j.ordinary.is_some()).collect::<Vec<_>>();
    if candidates.is_empty()&&matching.is_empty()&&ordinary.is_empty(){return Ok(Report::default());}
    let generation=remote.auth.store.generation();let user_cancel=cancel;
    let cancel=&||user_cancel()||remote.auth.store.generation()!=generation;
    let binding=account_binding(remote,&root,singz_id,cancel)?;
    for j in &matching {ensure!(j.binding==binding,"Unresolved empty transaction belongs to another account; ordinary reconciliation blocked");}
    let mut report=Report::default();
    for prior in ordinary {
        ensure!(prior.binding==binding,"Unresolved ordinary supersession belongs to another account");
        let request=Request{binding:binding.clone(),library_root:root.clone(),journal_root:journal_root.into(),singz_root:singz_id.into(),project:prior.project.clone()};
        let repairing={
            let base=Store::open(journal_root,&binding,&root,singz_id,&prior.project)?;let mut j=base.read()?.context("Missing ordinary supersession journal")?;let store=base.for_journal(&j)?;
            hydrate_ordinary(&store,&mut j)?;
            if ordinary_terminal(remote,&store,&j,cancel)?.is_some(){mark_superseded(&store,&mut j)?;false}
            else {
                // The current saved source can be edited or pruned independently
                // of A. Its fingerprint chooses retry versus recovery; it never
                // grants ownership over unknown remote objects.
                let local=journal::bounded(&root.join(&j.project).join("project.json"),LIMIT).ok().map(|bytes|crate::project_store::fingerprint(&bytes));
                let newer=local.as_deref()!=Some(j.ordinary.as_ref().unwrap().local_document.as_str());
                let untouched=complete_proof(remote,&store,&j,cancel).is_ok_and(|proof|proof.is_some());
                if !untouched {owned_ordinary_subset(remote,&store,&j,cancel)?;}
                if !newer {false}
                else if untouched {
                    archive_ordinary_intent(&store,&j)?;
                    j.ordinary=None;store.save(&j)?;false
                } else {begin_ordinary_repair(remote,&store,&request,&root,&j,cancel)?;true}
            }
        };
        if repairing {
            progress(format!("Recovering interrupted publication of {}…",prior.project),0.05);
            let (receipt,_,stats)=publish_one(remote,&request,cancel,progress,capturing)?;
            if let Some(publication)=&receipt.publication {report.publications.push(publication.clone());}
            report.uploaded+=stats.uploaded;report.unchanged+=stats.unchanged;report.changed=true;report.deferred.push(root.join(&prior.project));
            if let Some(row)=receipt.catalog["projects"].as_array().and_then(|rows|rows.iter().find(|r|r["dir"]==prior.project)){report.rows.insert(prior.project.clone(),row.clone());}
            return Ok(report);
        }
    }
    // Pending state always precedes a newly requested publication. A renamed or
    // deleted local project cannot strand an already-started retirement.
    for j in matching {
        let request=Request{binding:binding.clone(),library_root:root.clone(),journal_root:journal_root.into(),singz_root:singz_id.into(),project:j.project.clone()};
        let terminal={let base=Store::open(journal_root,&binding,&root,singz_id,&j.project)?;let store=base.for_journal(j)?;complete_proof(remote,&store,j,cancel)?.is_some()};
        if !j.repair&&!terminal&&(j.phase==Phase::RollingBack||local_current(j).is_err()){rollback(remote,&request,cancel)?;report.changed=true;report.deferred.push(root.join(&j.project));return Ok(report);}
        candidates.insert(j.project.clone());
    }
    // Caller already observed the root. Refuse duplicate candidate folder names
    // before any mutation; per-project operations revalidate identities again.
    for name in &candidates {let _=unique(root_listing,name)?;}
    for name in candidates {
        let request=Request{binding:binding.clone(),library_root:root.clone(),journal_root:journal_root.into(),singz_root:singz_id.into(),project:name.clone()};
        let (receipt,changed,stats)=publish_one(remote,&request,cancel,progress,capturing)?;
        if let Some(publication)=&receipt.publication {report.publications.push(publication.clone());}
        report.uploaded+=stats.uploaded;report.unchanged+=stats.unchanged;
        let row=receipt.catalog["projects"].as_array().and_then(|rows|rows.iter().find(|r|r["dir"]==name)).context("Verified catalog omitted empty project")?.clone();
        let local_path=root.join(&name);
        let matches=journal::bounded(&local_path.join("project.json"),LIMIT).ok().is_some_and(|bytes|crate::project_store::fingerprint(&bytes)==receipt.local_document)
            &&receipt.publication.as_ref().is_some_and(|p|crate::directory_identity::read(&local_path).ok().as_ref()==Some(&p.capture.local_identity)
                &&crate::directory_identity::read(&root).ok().as_ref()==Some(&p.capture.root_identity));
        if matches&&!(receipt.repair&&changed) {report.synced.insert(local_path,receipt.local_document);}else{report.deferred.push(local_path);}
        report.rows.insert(name,row);report.changed|=changed;
        if changed {return Ok(report);}
    }
    Ok(report)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn catalog_merge_preserves_unknown_and_unrelated_rows_and_detects_old_payload_ids() {
        let before=json!({"format":2,"foreign":{"keep":9},"capabilities":{"adopt":1,"future":7},"projects":[{"dir":"Other","files":[],"future":"keep"},{"dir":"Song","files":[{"id":"old","name":"project.json","size":2,"md5Checksum":"old"}],"display":"keep"}]});
        let doc=Metadata{entry:RemoteEntry{id:"new".into(),name:"project.json".into(),md5_checksum:Some(md5(b"{}")),size:Some("2".into()),..Default::default()},trashed:false};
        let next=merged_catalog(&before,"Song",&[doc]).unwrap();assert_eq!(next["foreign"],before["foreign"]);assert_eq!(next["capabilities"],before["capabilities"]);assert_eq!(next["projects"][0],before["projects"][0]);assert_eq!(next["projects"][1]["display"],"keep");
        assert!(!catalog_row_matches(&before,&next,"Song").unwrap());let mut unrelated=next.clone();unrelated["foreign"]["keep"]=11.into();unrelated["projects"][0]["future"]="changed elsewhere".into();assert!(catalog_row_matches(&unrelated,&next,"Song").unwrap());
        let mut duplicate=next.clone();duplicate["projects"].as_array_mut().unwrap().push(next["projects"][1].clone());assert!(catalog_row_matches(&duplicate,&next,"Song").is_err());
    }
    struct Fixture {base:PathBuf,root:PathBuf,url:String,server:std::process::Child,remote:Remote,local:Vec<u8>}
    impl Fixture {
        fn http(&self,method:&str,path:&str,body:Option<Value>)->Value {http(&self.url,method,path,body)}
        fn new()->Self {
            use std::io::{BufRead,BufReader,Read};use std::process::{Command,Stdio};use crate::drive_auth::{Config,TokenStore,OAuthSession,AuthClient};
            let base=std::env::temp_dir().join(format!("singz-empty-http-{}",crate::drive_http::random_id().unwrap()));let root=base.join("library");fs::create_dir_all(root.join("Song/stems")).unwrap();
            let base=base.canonicalize().unwrap();let root=root.canonicalize().unwrap();
            let local=serde_json::to_vec(&json!({"version":2,"name":"Song","songFile":"original.wav","songHash":{"old":true},"stemHashes":{"custom-a.wav":{"old":true}},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}})).unwrap();
            fs::write(root.join("Song/project.json"),&local).unwrap();fs::write(root.join("Song/stems/custom-a.wav"),b"retained audio").unwrap();fs::write(root.join("Song/original.wav"),b"retained original").unwrap();
            let mut server=Command::new("python3").arg(Path::new(env!("CARGO_MANIFEST_DIR")).join("tests/drive_fixture.py")).arg(base.join("remote")).stdin(Stdio::null()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().unwrap();
            let mut line=String::new();BufReader::new(server.stdout.take().unwrap()).take(4096).read_line(&mut line).unwrap();let url=serde_json::from_str::<Value>(&line).unwrap()["base"].as_str().unwrap().to_owned();
            let config=Config::from_json(&json!({"clientId":"fixture-client","clientSecret":"fixture-secret","authBase":url,"apiBase":url,"uploadBase":url}).to_string()).unwrap();let store=TokenStore::new(&base.join("prefs")).unwrap();
            let session=OAuthSession::start(config.clone(),store.clone()).unwrap();let auth=http_response(&url,"GET",session.authorization_url(),None);assert_eq!(auth.status,302);let callback=auth.header("location").unwrap().to_owned();
            let finish=std::thread::spawn(move||session.finish(&||false));assert_eq!(http_response(&url,"GET",&callback,None).status,200);finish.join().unwrap().unwrap();
            let remote=Remote::new(AuthClient::new(config,store));let f=Self{base,root,url,server,remote,local};
            let old=serde_json::to_vec(&json!({"version":2,"name":"Song","stemHashes":{"custom-a.wav":{"md5":md5(b"retained audio"),"size":14}},"settings":{"custom":[{"id":"custom-a","file":"stems/custom-a.wav"}]}})).unwrap();
            let other=b"{\"version\":2,\"name\":\"Other\"}";
            let catalog=serde_json::to_vec(&json!({"format":2,"foreign":{"keep":17},"projects":[{"dir":"Other","files":[{"id":"other-doc","name":"project.json","size":other.len(),"md5Checksum":md5(other)}],"unknown":"keep"},{"dir":"Song","files":[{"id":"old-doc","name":"project.json","size":old.len(),"md5Checksum":md5(&old)}]}]})).unwrap();
            f.http("POST","/control",Some(json!({"files":[folder("singz","SingZ","root"),folder("project","Song","singz"),folder("stems","stems","project"),file("old-doc","project.json","project",&old),file("old-audio","custom-a.wav","stems",b"retained audio"),folder("other","Other","singz"),file("other-doc","project.json","other",other),file("catalog","catalog.json","singz",&catalog)]})));f
        }
        fn sync(&self)->Result<crate::drive_sync::Report> {crate::drive_sync::run(&self.remote,&self.root,&self.base.join("prefs/gdrive/spool"),&||false,&|_,_|{},&|_|{})}
        fn sync_journal(&self)->Journal {journal::journals(&self.base.join("prefs/gdrive/empty-transactions")).unwrap().remove(0)}
        fn custom_save(&self,id:&str,bytes:&[u8]) {
            for entry in fs::read_dir(self.root.join("Song/stems")).unwrap(){let path=entry.unwrap().path();if path.is_file(){fs::remove_file(path).unwrap();}}
            fs::write(self.root.join("Song/stems").join(format!("{id}.wav")),bytes).unwrap();
            fs::write(self.root.join("Song/project.json"),serde_json::to_vec(&json!({"version":2,"name":"Song","stemHashes":{},"settings":{"nativeOriginalDisabled":true,"custom":[{"id":id,"file":format!("stems/{id}.wav")}]}})).unwrap()).unwrap();
        }
        fn other_local(&self) {fs::create_dir_all(self.root.join("Other")).unwrap();fs::write(self.root.join("Other/original.wav"),b"other local audio").unwrap();fs::write(self.root.join("Other/project.json"),br#"{"version":2,"name":"Other","songFile":"original.wav","settings":{}}"#).unwrap();}
        fn run(&self)->Result<Report> {run(&self.remote,&self.root,&self.base.join("journals"),"singz",&self.remote.children("singz",&||false)?,&||false,&|_,_|{},&|_|{})}
        fn state(&self)->Value {self.http("GET","/state",None)}
    }
    impl Drop for Fixture {fn drop(&mut self){let _=self.server.kill();let _=self.server.wait();let _=fs::remove_dir_all(&self.base);}}
    fn http_response(base:&str,method:&str,path:&str,body:Option<Value>)->crate::drive_http::Response {
        use crate::drive_http::{self,Request,Body,Destination};let url=if path.starts_with("http://"){path.to_owned()}else{format!("{base}{path}")};let bytes=body.map(|v|serde_json::to_vec(&v).unwrap());
        drive_http::request(Request{method,url:&url,headers:&[("Content-Type","application/json")],body:bytes.as_deref().map_or(Body::Empty,Body::Bytes),destination:Destination::Bytes(16*1024*1024),upload:false,allow_loopback_http:true},&||false).unwrap()
    }
    fn http(base:&str,method:&str,path:&str,body:Option<Value>)->Value {let r=http_response(base,method,path,body);assert!((200..300).contains(&r.status));r.json().unwrap()}
    fn folder(id:&str,name:&str,parent:&str)->Value {json!({"id":id,"name":name,"mimeType":FOLDER,"parents":[parent]})}
    fn file(id:&str,name:&str,parent:&str,bytes:&[u8])->Value {use base64::Engine;json!({"id":id,"name":name,"mimeType":"application/octet-stream","parents":[parent],"contentBase64":base64::engine::general_purpose::STANDARD.encode(bytes)})}
    fn state_file<'a>(state:&'a Value,id:&str)->&'a Value {state["files"].as_array().unwrap().iter().find(|f|f["id"]==id).unwrap()}
    #[test] fn real_http_empty_publication_archives_ids_and_updates_catalog_last_then_reuses_row() {
        let f=Fixture::new();let before=f.state();let report=f.run().unwrap();assert!(report.changed);assert_eq!(report.uploaded,2);assert_eq!(report.synced[&f.root.join("Song")],crate::project_store::fingerprint(&f.local));
        let active=f.remote.children("project",&||false).unwrap();assert_eq!(active.len(),1);assert_eq!(active[0].name,"project.json");assert_ne!(active[0].id,"old-doc");
        let after=f.state();for id in ["old-doc","old-audio","stems","other-doc"] {let original=state_file(&before,id);let now=state_file(&after,id);assert_eq!(original["contentBase64"],now["contentBase64"]);assert_eq!(original["md5Checksum"],now["md5Checksum"]);assert_eq!(now["trashed"],false);}
        assert_ne!(state_file(&after,"old-doc")["parents"],json!(["project"]));assert_eq!(state_file(&after,"old-audio")["parents"],json!(["stems"]));
        let catalog=&report.rows["Song"];assert_eq!(catalog["files"][0]["id"],active[0].id);assert_eq!(fs::read(f.root.join("Song/project.json")).unwrap(),f.local);assert_eq!(fs::read(f.root.join("Song/stems/custom-a.wav")).unwrap(),b"retained audio");
        let second=f.run().unwrap();assert!(!second.changed);assert_eq!(second.uploaded,0);assert_eq!(second.rows,report.rows);assert_eq!(second.unchanged,1);
        // Source mobile manifest and forced walk must both have no expected
        // audio, whereas a leftover active built-in is a resurrection hazard.
        let state=f.state();let doc=state_file(&state,&active[0].id);use base64::Engine;let bytes=base64::engine::general_purpose::STANDARD.decode(doc["contentBase64"].as_str().unwrap()).unwrap();let doc:Value=serde_json::from_slice(&bytes).unwrap();
        assert_eq!(doc["stemHashes"],json!({}));assert!(doc.get("songFile").is_none());assert_eq!(doc["settings"]["custom"],json!([]));assert!(!active.iter().any(|m|m.name=="stems"));
    }
    #[test] fn applied_lost_document_move_and_partial_archive_resume_without_losing_audio() {
        let f=Fixture::new();f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":"/drive/v3/files/old-doc","afterApply":true,"disconnect":true},{"method":"PATCH","path":"/drive/v3/files/stems","status":503}]})));
        assert!(f.run().is_err());let partial=f.state();assert!(has_pending(&f.base.join("journals")).unwrap());assert_ne!(state_file(&partial,"old-doc")["parents"],json!(["project"]));assert_eq!(state_file(&partial,"stems")["parents"],json!(["project"]));assert_eq!(state_file(&partial,"old-audio")["trashed"],false);
        let report=f.run().unwrap();assert!(report.changed);assert!(!has_pending(&f.base.join("journals")).unwrap());assert_eq!(f.remote.children("project",&||false).unwrap().len(),1);
    }
    #[test] fn newer_local_save_after_partial_archive_restores_media_before_old_document_and_defers_intent() {
        let f=Fixture::new();f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":"/drive/v3/files/stems","status":503}]})));assert!(f.run().is_err());
        let mut newer:Value=serde_json::from_slice(&f.local).unwrap();newer["name"]="Newer local Save".into();fs::write(f.root.join("Song/project.json"),serde_json::to_vec(&newer).unwrap()).unwrap();
        let report=f.run().unwrap();assert!(report.changed);assert!(report.synced.is_empty());assert_eq!(report.deferred,vec![f.root.join("Song")]);let state=f.state();assert_eq!(state_file(&state,"old-doc")["parents"],json!(["project"]));assert_eq!(state_file(&state,"stems")["parents"],json!(["project"]));assert!(!has_pending(&f.base.join("journals")).unwrap());
    }
    #[test] fn lost_staged_and_catalog_acknowledgements_are_observed_without_duplicate_publication() {
        let f=Fixture::new();f.http("POST","/control",Some(json!({"failNext":[{"method":"PUT","path":"/upload-session","afterApply":true,"disconnect":true,"count":2}]})));
        let report=f.run().unwrap();assert!(report.changed);assert_eq!(report.uploaded,2);assert_eq!(f.remote.children("project",&||false).unwrap().len(),1);
        assert!(!has_pending(&f.base.join("journals")).unwrap());assert!(!f.run().unwrap().changed);
    }
    #[test] fn changed_account_or_catalog_cannot_authorize_finishing_a_partial_archive() {
        let f=Fixture::new();f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":"/drive/v3/files/stems","status":503}]})));assert!(f.run().is_err());let partial=f.state();
        f.http("POST","/control",Some(json!({"permissionId":"different-account"})));assert!(f.run().unwrap_err().to_string().contains("another account"));
        let foreign=f.state();for id in ["old-doc","stems","old-audio"] {assert_eq!(state_file(&foreign,id),state_file(&partial,id));}
        f.http("POST","/control",Some(json!({"permissionId":"fixture-stable-account-1"})));
        let mut catalog=state_file(&partial,"catalog").clone();use base64::Engine;let bytes=base64::engine::general_purpose::STANDARD.decode(catalog["contentBase64"].as_str().unwrap()).unwrap();let mut doc:Value=serde_json::from_slice(&bytes).unwrap();doc["foreign"]["keep"]=99.into();catalog["contentBase64"]=base64::engine::general_purpose::STANDARD.encode(serde_json::to_vec(&doc).unwrap()).into();f.http("POST","/control",Some(json!({"files":[catalog]})));
        assert!(f.run().is_err());let conflict=f.state();for id in ["old-doc","stems","old-audio"] {assert_eq!(state_file(&conflict,id),state_file(&partial,id));}assert!(has_pending(&f.base.join("journals")).unwrap());
    }

    #[test] fn coordinator_changed_pass_requests_followup_and_fresh_continuation_preserves_empty_row() {
        let f=Fixture::new();let spool=f.base.join("prefs/gdrive/spool");let before=f.state();
        let first=crate::drive_sync::run(&f.remote,&f.root,&spool,&||false,&|_,_|{},&|_|{}).unwrap();
        assert!(first.follow_up);assert_eq!(first.uploaded,2);assert_eq!(first.trashed,0);
        assert_eq!(first.synced.len(),1);assert!(first.synced.contains_key(&f.root.join("Song")));assert!(!first.synced.contains_key(&f.root.join("Other")));
        let changed=f.state();assert_eq!(state_file(&changed,"other-doc"),state_file(&before,"other-doc"));
        use base64::Engine;let catalog:Value=serde_json::from_slice(&base64::engine::general_purpose::STANDARD.decode(state_file(&changed,"catalog")["contentBase64"].as_str().unwrap()).unwrap()).unwrap();
        assert_eq!(catalog["foreign"]["keep"],17);assert_eq!(catalog["projects"].as_array().unwrap().iter().find(|r|r["dir"]=="Other").unwrap()["unknown"],"keep");
        let empty_id=f.remote.children("project",&||false).unwrap()[0].id.clone();
        // This local project is introduced before the explicitly fresh next
        // coordinator pass. It must use the ordinary nonempty writer while the
        // already committed empty row bypasses physical retained-audio capture.
        fs::create_dir(f.root.join("Other")).unwrap();fs::write(f.root.join("Other/original.wav"),b"other local audio").unwrap();
        fs::write(f.root.join("Other/project.json"),br#"{"version":2,"name":"Other","songFile":"original.wav","settings":{}}"#).unwrap();
        let next=crate::drive_sync::run(&f.remote,&f.root,&spool,&||false,&|_,_|{},&|_|{}).unwrap();
        assert!(!next.follow_up);assert!(next.skipped.is_empty());assert_eq!(next.trashed,0);assert_eq!(next.synced.len(),2);
        assert!(next.synced.contains_key(&f.root.join("Song")));assert!(next.synced.contains_key(&f.root.join("Other")));
        let active=f.remote.children("project",&||false).unwrap();assert_eq!(active.len(),1);assert_eq!(active[0].id,empty_id);assert_eq!(active[0].name,"project.json");
        let other=f.remote.children("other",&||false).unwrap();assert!(other.iter().any(|m|m.name=="original.wav"));
        assert_eq!(fs::read(f.root.join("Song/project.json")).unwrap(),f.local);assert_eq!(fs::read(f.root.join("Song/stems/custom-a.wav")).unwrap(),b"retained audio");
    }

    fn fixture_origin(f:&Fixture,local_document:&str)->crate::drive_retirement::LocalCapture {
        let _lease=crate::project_publish::lock(&f.root.join("Song")).unwrap();
        crate::drive_retirement::LocalCapture{root_identity:crate::directory_identity::read(&f.root).unwrap(),local_identity:crate::directory_identity::read(&f.root.join("Song")).unwrap(),local_document:local_document.into()}
    }
    fn reserved_fixture(f:&Fixture)->Journal {let all=journal::journals(&f.base.join("journals")).unwrap();assert_eq!(all.len(),1);all.into_iter().next().unwrap()}
    #[test] fn legacy_committed_empty_origin_is_recaptured_coherently_before_terminal_remote_proof() {
        let f=Fixture::new();f.run().unwrap();let mut old=reserved_fixture(&f);old.capture=None;
        {let base=Store::open(&f.base.join("journals"),&old.binding,&f.root,"singz","Song").unwrap();base.save(&old).unwrap();}
        let report=f.run().unwrap();assert!(!report.changed);assert_eq!(report.publications.len(),1);
        let captured=&report.publications[0].capture;assert_eq!(captured.local_document,old.local_document);
        assert_eq!(captured.local_identity,crate::directory_identity::read(&f.root.join("Song")).unwrap());
        assert_eq!(reserved_fixture(&f).capture.as_ref(),Some(captured));
    }
    #[test] fn stable_empty_lineage_uses_current_verified_catalog_after_unrelated_row_changes() {
        use base64::Engine;
        let f=Fixture::new();f.run().unwrap();let state=f.state();
        let bytes=base64::engine::general_purpose::STANDARD.decode(state_file(&state,"catalog")["contentBase64"].as_str().unwrap()).unwrap();
        let mut document:Value=serde_json::from_slice(&bytes).unwrap();document["foreign"]["keep"]=91.into();document["projects"][0]["unknown"]="unrelated update".into();let bytes=serde_json::to_vec(&document).unwrap();
        f.remote.upload_bytes(&bytes,"catalog.json","singz",Some("catalog"),"application/json",&||false).unwrap();
        let report=f.run().unwrap();assert!(!report.changed);let plan=&report.publications[0];
        assert_eq!(plan.expected.catalog.md5_checksum.as_deref(),Some(md5(&bytes).as_str()));
        let binding=crate::drive_retirement::bind(&f.remote,&f.base.join("retirements"),&f.root,"singz",&||false).unwrap();
        crate::drive_retirement::capture_verify_publication(&f.remote,&binding,&plan.capture,&plan.expected,&||false).unwrap();
    }
    #[test] fn legacy_empty_ordinary_prepare_saves_the_leased_origin_before_network_publication() {
        let f=Fixture::new();f.run().unwrap();let mut old=reserved_fixture(&f);old.capture=None;
        let journals=f.base.join("journals");
        {let base=Store::open(&journals,&old.binding,&f.root,"singz","Song").unwrap();base.save(&old).unwrap();}
        f.custom_save("custom-next",b"ordinary saved audio");
        let mut capture=drive_snapshot::capture(&f.root,"Song",&f.base.join("ordinary-spool"),&||false).unwrap();
        let origin=capture.publication_capture();let mut plan=crate::drive_plan::plan_project(&capture.snapshot,&crate::drive_plan::RemoteProject::default()).unwrap();capture.spool_uploads(&mut plan,&||false).unwrap();
        let document=old.staged.iter().find(|m|m.entry.name==stage_name("project.json")).unwrap();
        prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song",&capture.local_document,&origin,capture.snapshot.top.iter().find(|m|m.name=="project.json"),Some(&document.entry.id),&||false).unwrap();
        let next=reserved_fixture(&f);let captured=next.capture.unwrap();
        assert_eq!(captured.root_identity,origin.root_identity);assert_eq!(captured.local_identity,origin.local_identity);
        assert_eq!(captured.local_document,old.local_document);assert_eq!(next.ordinary.unwrap().local_document,capture.local_document);
    }
    #[test] fn cancellation_before_new_folder_post_persists_all_creation_ids_for_retry() {
        let f=Fixture::new();fs::rename(f.root.join("Song"),f.root.join("New")).unwrap();let journals=f.base.join("journals");
        let cancel=||journal::journals(&journals).unwrap().iter().any(|j|j.folder_pending);
        assert!(run(&f.remote,&f.root,&journals,"singz",&f.remote.children("singz",&||false).unwrap(),&cancel,&|_,_|{},&|_|{}).is_err());
        let pending=reserved_fixture(&f);assert!(pending.folder_pending);let generated=f.state()["counts"]["GET /drive/v3/files/generateIds"].clone();assert!(f.remote.metadata_if_exists(&pending.folder.entry.id,&||false).unwrap().is_none());
        let report=f.run().unwrap();assert!(report.changed);let current=reserved_fixture(&f);assert_eq!(current.folder.entry.id,pending.folder.entry.id);assert_eq!(current.history_id,pending.history_id);assert_eq!(current.staged_ids,pending.staged_ids);assert_eq!(f.state()["counts"]["GET /drive/v3/files/generateIds"],generated);
        let active=f.remote.children(&pending.folder.entry.id,&||false).unwrap();assert_eq!(active.len(),1);assert_eq!(active[0].id,pending.staged_ids["project.json"]);
    }
    #[test] fn lost_create_ack_with_invisible_history_and_staged_payload_reuses_reserved_ids() {
        let f=Fixture::new();let journals=f.base.join("journals");let cancel=||!journal::journals(&journals).unwrap().is_empty();
        assert!(run(&f.remote,&f.root,&journals,"singz",&f.remote.children("singz",&||false).unwrap(),&cancel,&|_,_|{},&|_|{}).is_err());
        let intent=reserved_fixture(&f);let generated=f.state()["counts"]["GET /drive/v3/files/generateIds"].clone();
        f.http("POST","/control",Some(json!({"failNext":[{"method":"POST","path":"/drive/v3/files","afterApply":true,"disconnect":true}],"hideNext":{(intent.history_id.clone()):{"metadata":2,"listing":2}}})));
        assert!(f.run().is_err());assert!(reserved_fixture(&f).history.is_none());
        f.http("POST","/control",Some(json!({"failNext":[{"method":"PUT","path":"/upload-session","afterApply":true,"disconnect":true}],"hideNext":{(intent.staged_ids["project.json"].clone()):{"metadata":3,"listing":2}}})));
        assert!(f.run().is_err());assert_eq!(reserved_fixture(&f).history.as_ref().unwrap().entry.id,intent.history_id);
        assert!(f.run().unwrap().changed);let state=f.state();assert_eq!(state["counts"]["GET /drive/v3/files/generateIds"],generated);
        for id in [&intent.history_id,&intent.staged_ids["project.json"]] {assert_eq!(state["files"].as_array().unwrap().iter().filter(|f|f["id"]==*id).count(),1);}
        assert_eq!(f.remote.children("project",&||false).unwrap()[0].id,intent.staged_ids["project.json"]);
    }
    #[test] fn authorized_empty_nonempty_empty_cycle_supersedes_journal_without_losing_recovery_media() {
        let f=Fixture::new();let spool=f.base.join("prefs/gdrive/spool");let journals=f.base.join("prefs/gdrive/empty-transactions");
        let first=crate::drive_sync::run(&f.remote,&f.root,&spool,&||false,&|_,_|{},&|_|{}).unwrap();assert!(first.follow_up);
        let archived=f.state();let first_journal=journal::journals(&journals).unwrap().remove(0);assert_eq!(first_journal.phase,Phase::Committed);
        // Emulate the saved authoritative custom roster, including ordinary
        // Save pruning the old owned custom member. This is writer acceptance,
        // not a claim that a fixture mutation qualifies native UI controls.
        fs::remove_file(f.root.join("Song/stems/custom-a.wav")).unwrap();fs::write(f.root.join("Song/stems/custom-b.wav"),b"new authorized audio").unwrap();
        fs::write(f.root.join("Song/project.json"),br#"{"version":2,"name":"Song","stemHashes":{},"settings":{"nativeOriginalDisabled":true,"custom":[{"id":"custom-b","file":"stems/custom-b.wav"}]}}"#).unwrap();
        fs::create_dir(f.root.join("Other")).unwrap();fs::write(f.root.join("Other/original.wav"),b"other local audio").unwrap();fs::write(f.root.join("Other/project.json"),br#"{"version":2,"name":"Other","songFile":"original.wav","settings":{}}"#).unwrap();
        let ordinary=crate::drive_sync::run(&f.remote,&f.root,&spool,&||false,&|_,_|{},&|_|{}).unwrap();assert!(!ordinary.follow_up);assert_eq!(ordinary.synced.len(),2);
        let superseded=journal::journals(&journals).unwrap().remove(0);assert_eq!(superseded.phase,Phase::Superseded);assert!(superseded.ordinary.is_some());
        fs::write(f.root.join("Song/project.json"),br#"{"version":2,"name":"Song empty again","stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}}"#).unwrap();
        let again=crate::drive_sync::run(&f.remote,&f.root,&spool,&||false,&|_,_|{},&|_|{}).unwrap();assert!(again.follow_up);assert!(again.synced.contains_key(&f.root.join("Song")));
        let second=journal::journals(&journals).unwrap().remove(0);assert_eq!(second.phase,Phase::Committed);assert_ne!(second.transaction,first_journal.transaction);assert_ne!(second.history_id,first_journal.history_id);
        let after=f.state();for id in ["old-doc","old-audio","stems",&first_journal.history_id] {assert_eq!(state_file(&after,id),state_file(&archived,id));}
        let active=f.remote.children("project",&||false).unwrap();assert_eq!(active.len(),1);assert_eq!(active[0].name,"project.json");assert_ne!(active[0].id,first_journal.staged_ids["project.json"]);
    }

    #[test] fn unreadable_or_superseding_unapplied_ordinary_intent_cannot_bypass_prior_empty_proof() {
        let f=Fixture::new();assert!(f.run().unwrap().changed);let journals=f.base.join("journals");let committed=reserved_fixture(&f);let id=&committed.staged_ids["project.json"];
        let before=f.state();assert!(prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song","unused",&fixture_origin(&f,"unused"),None,Some(id),&||false).is_err());
        assert_eq!(f.state()["files"],before["files"]);
        let make=|suffix:&str|{let bytes=serde_json::to_vec(&json!({"version":2,"stemHashes":{(format!("custom-{suffix}.wav")): {"md5":md5(suffix.as_bytes()),"size":suffix.len()}},"settings":{"custom":[{"id":format!("custom-{suffix}"),"file":format!("stems/custom-{suffix}.wav")}],"nativeOriginalDisabled":true}})).unwrap();let path=f.base.join(format!("planned-{suffix}.json"));fs::write(&path,&bytes).unwrap();crate::drive_plan::LocalEntry{name:"project.json".into(),path,mime:"application/json".into(),md5:md5(&bytes),size:bytes.len()as u64}};
        let a=make("a");let b=make("b");let save_a=crate::project_store::fingerprint(b"Save A");let save_b=crate::project_store::fingerprint(b"Save B");
        prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song",&save_a,&fixture_origin(&f,&save_a),Some(&a),Some(id),&||false).unwrap();
        prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song",&save_b,&fixture_origin(&f,&save_b),Some(&b),Some(id),&||false).unwrap();
        let replaced=reserved_fixture(&f);assert_eq!(replaced.ordinary.unwrap().md5,b.md5);assert_eq!(replaced.history_id,committed.history_id);assert_eq!(f.state()["files"],before["files"]);
        // A newer empty Save is also safe when neither prepared ordinary intent
        // wrote anything. It must not be stuck on obsolete A/B fingerprints.
        fs::write(f.root.join("Song/project.json"),br#"{"version":2,"name":"new empty Save","stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}}"#).unwrap();assert!(f.run().unwrap().changed);
        let finished=reserved_fixture(&f);assert_eq!(finished.phase,Phase::Committed);assert!(finished.ordinary.is_none());
        for key in ["old-doc","old-audio","stems"] {assert_eq!(state_file(&f.state(),key),state_file(&before,key));}
    }

    #[test] fn failed_new_generation_constructor_preserves_current_journal_payloads_for_retry() {
        let f=Fixture::new();assert!(f.run().unwrap().changed);let original=reserved_fixture(&f);let before=f.state();
        let base=Store::open(&f.base.join("journals"),&original.binding,&f.root,"singz","Song").unwrap();let old=base.for_journal(&original).unwrap();let doc=old.payload("project.json").unwrap();let catalog=old.payload("catalog-after.json").unwrap();drop(old);drop(base);
        fs::write(f.root.join("Song/project.json"),br#"{"version":2,"name":"new empty generation","stemHashes":{},"settings":{"nativeEmptyTracks":true,"nativeOriginalDisabled":true,"custom":[]}}"#).unwrap();
        let captured=std::cell::Cell::new(false);let callback=|path:Option<PathBuf>|{if path.is_some(){captured.set(true);}else if captured.replace(false){f.http("POST","/control",Some(json!({"failNext":[{"method":"GET","path":"/drive/v3/files/project","status":503}]})));}};
        assert!(run(&f.remote,&f.root,&f.base.join("journals"),"singz",&f.remote.children("singz",&||false).unwrap(),&||false,&|_,_|{},&callback).is_err());
        let current=reserved_fixture(&f);assert_eq!(current.transaction,original.transaction);let base=Store::open(&f.base.join("journals"),&current.binding,&f.root,"singz","Song").unwrap();let current_store=base.for_journal(&current).unwrap();assert_eq!(current_store.payload("project.json").unwrap(),doc);assert_eq!(current_store.payload("catalog-after.json").unwrap(),catalog);drop(current_store);drop(base);assert_eq!(f.state()["files"],before["files"]);
        assert!(f.run().unwrap().changed);
    }
    #[test] fn accepted_partial_ordinary_media_finishes_before_latest_save_without_pruned_a() {
        let f=Fixture::new();assert!(f.sync().unwrap().follow_up);let first=f.sync_journal();let first_archive=f.state();let empty_id=first.staged_ids["project.json"].clone();
        f.custom_save("custom-pending-a",b"A media will be pruned locally");
        f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":format!("/upload/drive/v3/files/{empty_id}"),"status":503}]})));assert!(f.sync().is_err());
        let active=f.remote.children("project",&||false).unwrap();let stems=active.iter().find(|m|m.name=="stems").unwrap().id.clone();let a=f.remote.children(&stems,&||false).unwrap().remove(0);let a_before=f.state();
        f.custom_save("custom-latest-b",b"latest B audio");assert!(!f.root.join("Song/stems/custom-pending-a.wav").exists());
        let repair=f.sync().unwrap();assert!(repair.follow_up);assert!(!repair.synced.contains_key(&f.root.join("Song")));assert!(repair.skipped.contains(&f.root.join("Song")));
        let recovered=f.sync_journal();assert!(!recovered.repair);assert_eq!(recovered.phase,Phase::Superseded);assert_eq!(recovered.history_id,first.history_id);
        let state=f.state();assert_eq!(state_file(&state,&a.id)["contentBase64"],state_file(&a_before,&a.id)["contentBase64"]);assert_eq!(state_file(&state,&a.id)["parents"],json!([stems]));
        assert_eq!(f.remote.children("project",&||false).unwrap().len(),2);
        let completed=f.remote.children("project",&||false).unwrap();let document=completed.iter().find(|m|m.name=="project.json").unwrap();assert_eq!(document.md5_checksum.as_deref(),Some(recovered.ordinary.as_ref().unwrap().md5.as_str()));for id in ["old-doc","old-audio","stems",&first.history_id]{assert_eq!(state_file(&state,id),state_file(&first_archive,id));}
        f.other_local();let latest=f.sync().unwrap();assert!(!latest.follow_up);assert!(latest.synced.contains_key(&f.root.join("Song")));assert_eq!(f.sync_journal().phase,Phase::Superseded);
        let now=f.remote.children("project",&||false).unwrap();let fresh=now.iter().find(|m|m.name=="stems").unwrap();let audio=f.remote.children(&fresh.id,&||false).unwrap();assert_eq!(audio.len(),1);assert_eq!(audio[0].name,"custom-latest-b.wav");
    }
    #[test] fn accepted_ordinary_catalog_retry_finishes_before_newer_save_without_local_a() {
        let f=Fixture::new();assert!(f.sync().unwrap().follow_up);let first=f.sync_journal();let original=f.state();
        f.custom_save("custom-a",b"A document and audio");f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":"/upload/drive/v3/files/catalog","status":503}]})));assert!(f.sync().is_err());
        let pending=f.sync_journal();let accepted=pending.ordinary.as_ref().unwrap();let a_doc=accepted.document_id.clone();assert_eq!(f.remote.metadata(&a_doc,&||false).unwrap().entry.md5_checksum.as_deref(),Some(accepted.md5.as_str()));let a_state=f.state();
        let stem=f.remote.children("project",&||false).unwrap().into_iter().find(|m|m.name=="stems").unwrap().id;
        let a=f.remote.children(&stem,&||false).unwrap().into_iter().find(|m|m.name=="custom-a.wav").unwrap();
        f.custom_save("custom-c",b"newer C after interrupted A catalog");assert!(!f.root.join("Song/stems/custom-a.wav").exists());
        let complete=f.sync().unwrap();assert!(complete.follow_up);assert!(!complete.synced.contains_key(&f.root.join("Song")));let completed=f.sync_journal();assert_eq!(completed.phase,Phase::Superseded);assert!(!completed.repair);
        let after=f.state();for id in [&a_doc,&a.id]{assert_eq!(state_file(&after,id)["contentBase64"],state_file(&a_state,id)["contentBase64"]);assert_eq!(state_file(&after,id)["trashed"],false);}assert_eq!(state_file(&after,&a_doc)["parents"],json!(["project"]));assert_eq!(state_file(&after,&a.id)["parents"],json!([stem]));
        for id in ["old-doc","old-audio","stems",&first.history_id]{assert_eq!(state_file(&after,id),state_file(&original,id));}
        // The terminal A receipt proves its accepted catalog boundary even
        // though C already replaced the source before recovery began.
        let storage=f.base.join("prefs/gdrive/retirements");let binding=crate::drive_retirement::bind(&f.remote,&storage,&f.root,"singz",&||false).unwrap();let proofs=crate::drive_retirement::publications(&storage,&binding).unwrap();assert!(proofs.iter().any(|p|p.project=="Song"&&p.capture.local_document==accepted.local_document&&p.members.iter().any(|m|m.entry.id==a.id)));
        f.other_local();let latest=f.sync().unwrap();assert!(!latest.follow_up);assert!(latest.synced.contains_key(&f.root.join("Song")));let active=f.remote.children("project",&||false).unwrap();let stems=active.iter().find(|m|m.name=="stems").unwrap();assert_eq!(f.remote.children(&stems.id,&||false).unwrap()[0].name,"custom-c.wav");
    }
    #[test] fn foreign_partial_ordinary_member_refuses_recovery_without_mutating_present_payloads() {
        let f=Fixture::new();assert!(f.sync().unwrap().follow_up);let first=f.sync_journal();f.custom_save("custom-a",b"authorized A");
        f.http("POST","/control",Some(json!({"failNext":[{"method":"PATCH","path":format!("/upload/drive/v3/files/{}",first.staged_ids["project.json"]),"status":503}]})));assert!(f.sync().is_err());
        let top=f.remote.children("project",&||false).unwrap();let stems=top.iter().find(|m|m.name=="stems").unwrap();f.http("POST","/control",Some(json!({"files":[file("foreign-audio","foreign.wav",&stems.id,b"foreign bytes")]})));let before=f.state();
        f.custom_save("custom-b",b"new B");assert!(f.sync().is_err());assert_eq!(f.state()["files"],before["files"]);assert!(!f.sync_journal().repair);
    }

    #[test] fn interrupted_ordinary_payload_write_preserves_legacy_journal_and_retry_reference() {
        let f=Fixture::new();assert!(f.run().unwrap().changed);let journals=f.base.join("journals");let committed=reserved_fixture(&f);let document=committed.staged_ids["project.json"].clone();
        let planned=|name:&str|{let bytes=serde_json::to_vec(&json!({"version":2,"stemHashes":{(format!("custom-{name}.wav")):{"md5":md5(name.as_bytes()),"size":name.len()}},"settings":{"nativeOriginalDisabled":true,"custom":[{"id":format!("custom-{name}"),"file":format!("stems/custom-{name}.wav")}]}})).unwrap();let path=f.base.join(format!("intent-{name}.json"));fs::write(&path,&bytes).unwrap();crate::drive_plan::LocalEntry{name:"project.json".into(),path,mime:"application/json".into(),md5:md5(&bytes),size:bytes.len()as u64}};
        let a=planned("a");let b=planned("b");let save_a=crate::project_store::fingerprint(b"save A");let save_b=crate::project_store::fingerprint(b"save B");
        prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song",&save_a,&fixture_origin(&f,&save_a),Some(&a),Some(&document),&||false).unwrap();
        let mut legacy=reserved_fixture(&f);let base=Store::open(&journals,&legacy.binding,&f.root,"singz","Song").unwrap();let store=base.for_journal(&legacy).unwrap();let a_bytes=ordinary_bytes(&store,&legacy,legacy.ordinary.as_ref().unwrap()).unwrap();
        // Emulate a valid pre-upgrade persisted journal. It must remain readable
        // even if the next process stops after fsyncing B but before switching
        // the durable journal reference.
        let legacy_name=format!("ordinary-{}.json",legacy.transaction);store.write(&legacy_name,&a_bytes).unwrap();legacy.ordinary.as_mut().unwrap().payload_file=None;store.save(&legacy).unwrap();
        let b_bytes=fs::read(&b.path).unwrap();let b_name=format!("ordinary-{}.json",crate::project_store::fingerprint(&b_bytes));immutable_payload(&store,&b_name,&b_bytes).unwrap();drop(store);drop(base);
        let still_a=reserved_fixture(&f);assert_eq!(still_a.ordinary.as_ref().unwrap().md5,a.md5);assert!(still_a.ordinary.as_ref().unwrap().payload_file.is_none());
        let base=Store::open(&journals,&still_a.binding,&f.root,"singz","Song").unwrap();let store=base.for_journal(&still_a).unwrap();assert_eq!(ordinary_bytes(&store,&still_a,still_a.ordinary.as_ref().unwrap()).unwrap(),a_bytes);assert_eq!(store.payload(&legacy_name).unwrap(),a_bytes);assert_eq!(store.payload(&b_name).unwrap(),b_bytes);drop(store);drop(base);
        prepare_ordinary_publication(&f.remote,&f.root,&journals,"singz","Song",&save_b,&fixture_origin(&f,&save_b),Some(&b),Some(&document),&||false).unwrap();
        let current=reserved_fixture(&f);let intent=current.ordinary.as_ref().unwrap();assert_eq!(intent.md5,b.md5);assert_eq!(intent.payload_file.as_deref(),Some(b_name.as_str()));
        let base=Store::open(&journals,&current.binding,&f.root,"singz","Song").unwrap();let store=base.for_journal(&current).unwrap();assert_eq!(ordinary_bytes(&store,&current,intent).unwrap(),b_bytes);assert_eq!(store.payload(&legacy_name).unwrap(),a_bytes);
    }

}

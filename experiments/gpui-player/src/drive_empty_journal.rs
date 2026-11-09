//! Durable private state for one explicit-empty publication; never a sync spool.
use crate::drive_remote::Metadata;
use anyhow::{Context,Result,ensure};
use serde::{Deserialize,Serialize};
use std::{fs::{self,File,OpenOptions},io::{Read,Write},path::{Path,PathBuf},sync::Arc};

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub enum Phase {Captured,Staged,Archiving,Archived,Installed,Committed,Superseded,RollingBack,RolledBack}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
pub struct Payload {pub name:String,pub md5:String,pub size:u64}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
pub struct OrdinaryIntent {pub local_document:String,pub document_id:String,pub md5:String,pub size:u64,
    #[serde(default)] pub payload_file:Option<String>,
    #[serde(default)] pub expected_top:Vec<Payload>,#[serde(default)] pub expected_stems:Vec<Payload>,
}
#[derive(Clone,Debug,Serialize,Deserialize)]
pub struct Journal {
    pub version:u32,pub binding:String,pub local_root:PathBuf,pub singz_root:String,pub project:String,pub transaction:String,
    pub local_document:String,pub phase:Phase,pub folder:Metadata,
    #[serde(default)] pub folder_pending:bool,
    #[serde(default)] pub history_id:String,
    #[serde(default)] pub history_parent:String,
    #[serde(default)] pub staged_ids:std::collections::BTreeMap<String,String>,
    #[serde(default)] pub catalog_id:Option<String>,
    pub baseline:Vec<Metadata>,pub moves:Vec<Metadata>,
    pub old_catalog:Option<Metadata>,pub history:Option<Metadata>,pub payloads:Vec<Payload>,pub staged:Vec<Metadata>,
    pub installed_catalog:Option<Metadata>,
    #[serde(default)] pub ordinary:Option<OrdinaryIntent>,
    /// Restore durable prior-empty bytes, never acknowledge the newer local Save
    /// or roll back to the incomplete ordinary baseline on a local edit.
    #[serde(default)] pub repair:bool,
    #[serde(default)] pub storage_generation:bool,
}
pub struct Store {pub path:PathBuf,base:PathBuf,_lease:Arc<crate::file_lease::Lease>}
fn ordinary_directory(path:&Path)->Result<()> {
    let m=fs::symlink_metadata(path)?;ensure!(m.is_dir()&&!m.file_type().is_symlink(),"Linked transaction directory refused");
    #[cfg(unix)] {use std::os::unix::fs::PermissionsExt;ensure!(m.permissions().mode()&0o077==0,"Transaction directory must be private");}
    Ok(())
}
fn private_directory(path:&Path)->Result<()> {
    if !path.exists(){let mut b=fs::DirBuilder::new();#[cfg(unix)] {use std::os::unix::fs::DirBuilderExt;b.mode(0o700);}b.create(path)?;}
    ordinary_directory(path)
}
fn sync_dir(path:&Path)->Result<()> {#[cfg(not(windows))] File::open(path)?.sync_all()?;let _=path;Ok(())}
pub fn bounded(path:&Path,limit:u64)->Result<Vec<u8>> {
    let meta=fs::symlink_metadata(path)?;ensure!(meta.is_file()&&!meta.file_type().is_symlink()&&meta.len()<=limit,"Invalid transaction file");
    let mut bytes=vec![];File::open(path)?.take(limit+1).read_to_end(&mut bytes)?;ensure!(bytes.len()as u64<=limit,"Transaction file too large");Ok(bytes)
}
impl Store {
    pub fn open(root:&Path,binding:&str,local_root:&Path,singz:&str,project:&str)->Result<Self> {
        ensure!(!binding.is_empty()&&binding.len()<=512&&crate::drive_plan::plain_name(project),"Invalid transaction binding");
        // Parent is supplied by the coordinator under its verified private
        // config root. Do not recursively traverse/create untrusted parents.
        private_directory(root)?;
        let key=crate::project_store::fingerprint(&serde_json::to_vec(&(binding,local_root,singz,project))?);
        let path=root.join(key);private_directory(&path)?;
        let lock_path=path.join(".lock");if lock_path.exists(){let m=fs::symlink_metadata(&lock_path)?;ensure!(m.is_file()&&!m.file_type().is_symlink(),"Linked transaction lease refused");}
        let mut options=OpenOptions::new();options.create(true).truncate(false).read(true).write(true);
        #[cfg(unix)] {use std::os::unix::fs::OpenOptionsExt;options.mode(0o600);}
        let lock=options.open(lock_path)?;
        let lease=crate::file_lease::Lease::acquire(lock).context("Empty publication is already being changed")?;
        Ok(Self{base:path.clone(),path,_lease:Arc::new(lease)})
    }
    pub fn read(&self)->Result<Option<Journal>> {
        let path=self.base.join("journal.json");if !path.exists(){return Ok(None);}
        let journal:Journal=serde_json::from_slice(&bounded(&path,2*1024*1024)?)?;
        ensure!(journal.version==1&&journal.baseline.len()<=4096&&journal.moves.len()<=4096&&journal.payloads.len()<=2&&journal.staged.len()<=2,"Unsupported empty transaction journal");Ok(Some(journal))
    }
    pub fn new_generation(&self,transaction:&str)->Result<Self> {
        ensure!(crate::drive_plan::plain_name(transaction),"Unsafe transaction storage identity");let path=self.base.join(format!("generation-{transaction}"));private_directory(&path)?;
        Ok(Self{path,base:self.base.clone(),_lease:self._lease.clone()})
    }
    pub fn for_journal(&self,j:&Journal)->Result<Self> {
        let path=if j.storage_generation {self.base.join(format!("generation-{}",j.transaction))}else{self.base.clone()};ordinary_directory(&path)?;
        Ok(Self{path,base:self.base.clone(),_lease:self._lease.clone()})
    }
    pub fn write(&self,name:&str,bytes:&[u8])->Result<()> {
        ensure!(crate::drive_plan::plain_name(name),"Unsafe transaction payload name");ordinary_directory(&self.path)?;
        let temp=self.path.join(format!(".{}-{}.part",name,crate::drive_http::random_id()?));
        let result=(||->Result<()> {let mut f=crate::drive_http::private_file(&temp)?;f.write_all(bytes)?;f.sync_all()?;
            let dest=self.path.join(name);if dest.exists(){let m=fs::symlink_metadata(&dest)?;ensure!(m.is_file()&&!m.file_type().is_symlink(),"Linked transaction payload refused");}
            crate::project_store::replace(&temp,&dest)?;sync_dir(&self.path)
        })();let _=fs::remove_file(temp);result
    }
    pub fn save(&self,journal:&Journal)->Result<()> {let bytes=serde_json::to_vec(journal)?;ensure!(bytes.len()<=2*1024*1024,"Empty transaction journal too large");let base=Self{path:self.base.clone(),base:self.base.clone(),_lease:self._lease.clone()};base.write("journal.json",&bytes)}
    pub fn payload(&self,name:&str)->Result<Vec<u8>> {ensure!(crate::drive_plan::plain_name(name),"Unsafe transaction payload name");bounded(&self.path.join(name),16*1024*1024)}
}
/// Local-only discovery, before any account/network work. Foreign/linked state
/// is an error, never authority to bypass the library's ordinary deletion guard.
pub fn journals(root:&Path)->Result<Vec<Journal>> {
    if !root.exists(){return Ok(vec![]);}ordinary_directory(root)?;
    let mut found=vec![];let entries=fs::read_dir(root)?.take(1025).collect::<std::io::Result<Vec<_>>>()?;ensure!(entries.len()<=1024,"Too many empty publication journals");
    for entry in entries {ordinary_directory(&entry.path())?;let path=entry.path().join("journal.json");if !path.exists(){continue;}
        let j:Journal=serde_json::from_slice(&bounded(&path,2*1024*1024)?)?;ensure!(j.version==1&&crate::drive_plan::plain_name(&j.project)&&j.binding.len()<=512&&j.baseline.len()<=4096&&j.moves.len()<=4096,"Unsupported empty publication journal");found.push(j);
    }Ok(found)
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test] fn durable_journal_payload_is_private_bounded_and_lease_excluded() {
        let root=std::env::temp_dir().join(format!("singz-empty-journal-{}-{}",std::process::id(),crate::drive_http::random_id().unwrap()));
        let local=std::env::temp_dir();let store=Store::open(&root,"account",&local,"root","Song").unwrap();
        store.write("project.json",b"{}").unwrap();assert_eq!(store.payload("project.json").unwrap(),b"{}");
        assert!(Store::open(&root,"account",&local,"root","Song").is_err());assert!(store.write("../outside",b"x").is_err());
        #[cfg(unix)] {use std::os::unix::fs::{symlink,PermissionsExt};assert_eq!(fs::metadata(&store.path).unwrap().permissions().mode()&0o077,0);
            symlink(store.path.join("project.json"),store.path.join("linked.json")).unwrap();assert!(store.payload("linked.json").is_err());}
        drop(store);fs::remove_dir_all(root).unwrap();
    }
}

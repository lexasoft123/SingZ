//! Read-only, bounded native audio metadata for the production lyrics lookup ladder.
use anyhow::{Result, ensure};
use lofty::{config::{GlobalOptions, ParseOptions, apply_global_options}, file::TaggedFileExt, prelude::Accessor, probe::Probe};
use serde::{Deserialize, Serialize};
use std::{fs::File, io::{self, Read, Seek, SeekFrom}, path::Path};

#[derive(Clone, Debug, Default, Serialize, Deserialize, PartialEq)]
pub struct Tags {pub artist:Option<String>,pub title:Option<String>,pub album:Option<String>}
struct Budget<'a> {file:File,left:usize,cancel:&'a dyn Fn()->bool}
impl Read for Budget<'_>{fn read(&mut self,buf:&mut [u8])->io::Result<usize>{
    if (self.cancel)(){return Err(io::Error::other("Metadata reading cancelled"));}
    if buf.is_empty(){return Ok(0);}
    if self.left==0{return Err(io::Error::other("Audio metadata read budget exceeded"));}
    let length=buf.len().min(self.left);let read=self.file.read(&mut buf[..length])?;self.left-=read;Ok(read)
}}
impl Seek for Budget<'_>{fn seek(&mut self,from:SeekFrom)->io::Result<u64>{if (self.cancel)(){return Err(io::Error::other("Metadata reading cancelled"));}self.file.seek(from)}}
pub fn read(path:&Path,cancel:&impl Fn()->bool)->Result<Tags>{
    ensure!(!cancel(),"Metadata reading cancelled");
    let file=File::open(path)?;let before=file.metadata()?;ensure!(before.is_file(),"Audio metadata source is not a file");
    // Lofty's options are thread-local. No global application preference or
    // audio metadata is modified, and pictures/properties are never decoded.
    apply_global_options(GlobalOptions::new().allocation_limit(2*1024*1024).preserve_format_specific_items(false));
    let input=Budget{file,left:16*1024*1024,cancel};
    let tagged=Probe::new(input).options(ParseOptions::new().read_properties(false).read_cover_art(false)).guess_file_type()?.read()?;
    let after=path.metadata()?;ensure!(!cancel()&&before.len()==after.len()&&before.modified()?==after.modified()?,"Audio source changed during metadata reading");
    let Some(tag)=tagged.primary_tag().or_else(||tagged.first_tag())else{return Ok(Tags::default());};
    let clean=|s:Option<std::borrow::Cow<'_,str>>|s.map(|s|s.trim().to_owned()).filter(|s|!s.is_empty()&&s.len()<=8192);
    Ok(Tags{artist:clean(tag.artist()),title:clean(tag.title()),album:clean(tag.album())})
}

#[cfg(test)]
mod tests{
    use super::*;use std::{fs,sync::atomic::{AtomicU64,Ordering}};
    fn riff()->Vec<u8>{
        fn chunk(id:&[u8;4],data:&[u8])->Vec<u8>{let mut out=id.to_vec();out.extend((data.len()as u32).to_le_bytes());out.extend(data);if data.len()%2==1{out.push(0);}out}
        let mut body=b"WAVE".to_vec();let mut fmt=vec![];fmt.extend(1u16.to_le_bytes());fmt.extend(1u16.to_le_bytes());fmt.extend(16000u32.to_le_bytes());fmt.extend(32000u32.to_le_bytes());fmt.extend(2u16.to_le_bytes());fmt.extend(16u16.to_le_bytes());body.extend(chunk(b"fmt ",&fmt));
        let mut info=b"INFO".to_vec();for (id,text)in [(b"IART",b"Real artist\0".as_slice()),(b"INAM",b"Tagged song\0".as_slice()),(b"IPRD",b"Album\0".as_slice())]{info.extend(chunk(id,text));}body.extend(chunk(b"LIST",&info));body.extend(chunk(b"data",&[0;32]));let mut out=b"RIFF".to_vec();out.extend((body.len()as u32).to_le_bytes());out.extend(body);out
    }
    #[test]fn reads_actual_riff_tags_without_touching_audio_and_honors_cancellation(){
        static NEXT:AtomicU64=AtomicU64::new(0);let p=std::env::temp_dir().join(format!("singz-tags-{}-{}.wav",std::process::id(),NEXT.fetch_add(1,Ordering::Relaxed)));let data=riff();fs::write(&p,&data).unwrap();
        let tags=read(&p,&||false).unwrap();assert_eq!(tags,Tags{artist:Some("Real artist".into()),title:Some("Tagged song".into()),album:Some("Album".into())});assert_eq!(fs::read(&p).unwrap(),data);assert!(read(&p,&||true).is_err());fs::remove_file(p).unwrap();
    }
    #[test]fn metadata_reader_enforces_total_io_budget_and_checks_cancel_on_seeks(){let p=std::env::temp_dir().join(format!("singz-tag-budget-{}",std::process::id()));fs::write(&p,b"123456789").unwrap();let mut b=Budget{file:File::open(&p).unwrap(),left:4,cancel:&||false};let mut buf=[0;8];assert_eq!(b.read(&mut buf).unwrap(),4);assert!(b.read(&mut buf).is_err());let mut cancelled=Budget{file:File::open(&p).unwrap(),left:9,cancel:&||true};assert!(cancelled.seek(SeekFrom::Start(0)).is_err());fs::remove_file(p).unwrap();}
}

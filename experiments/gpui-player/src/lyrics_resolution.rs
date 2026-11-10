//! Sidebar lyrics intent and publication proposals. Editor alignment remains a preview.
use crate::{alignmentoutcome_domain::Check, integration::Project, lyrics_align::{self, Failure, Progress, Tier}, lyrics_edit::Line, lrclib};
use anyhow::{Context, Result, ensure};
use serde::{Deserialize, Serialize};
use serde_json::{Value, json};

pub const LOOKUP_VERSION: u64 = 3;
pub const ENGINE: &str = "qwen3-asr-1.7b";
pub fn needs_online_recheck(raw:&Value)->bool {
    raw["source"].as_str().unwrap_or("whisper")=="whisper"&&(raw["lrclibPending"]!=false||raw["lookup"].as_u64().unwrap_or(0)<LOOKUP_VERSION)
}
fn metadata_filename(project:&Project)->&str{
    project.raw["sourceFileName"].as_str().filter(|s|!s.is_empty()&&s.len()<=8192).unwrap_or(&project.name)
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all="kebab-case")]
pub enum Intent { Auto, Transcribe, Align, Precise, Candidate(u64) }
#[derive(Clone, Debug)]
pub struct Proposal {
    pub raw: Value,
    pub write: bool,
    pub cached: bool,
    pub check: Option<Check>,
    pub warnings: Vec<String>,
}
fn failed(e: impl std::fmt::Display) -> Failure { Failure::Error(e.to_string()) }
fn active(cancel:&dyn Fn()->bool)->std::result::Result<(),Failure>{if cancel(){Err(Failure::Cancelled)}else{Ok(())}}

/// Injectable inference/network boundary. The policy tests exercise the same
/// decisions as native jobs without replacing publication or UI receipts.
trait Operations {
    fn lookup(&self, meta:&lrclib::TrackMeta, cancel:&dyn Fn()->bool)->std::result::Result<lrclib::Lookup,Failure>;
    fn candidate(&self,id:u64,duration:f64,cancel:&dyn Fn()->bool)->std::result::Result<Option<lrclib::Hit>,Failure>;
    fn align(&self,project:&Project,lines:Vec<Line>,tier:Tier,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<lyrics_align::Output,Failure>;
    fn transcribe(&self,project:&Project,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<lyrics_align::Transcription,Failure>;
}
struct Native<'a>(&'a lrclib::Client);
impl Operations for Native<'_> {
    fn lookup(&self,meta:&lrclib::TrackMeta,cancel:&dyn Fn()->bool)->std::result::Result<lrclib::Lookup,Failure>{self.0.lookup(meta,&||cancel()).map_err(failed)}
    fn candidate(&self,id:u64,duration:f64,cancel:&dyn Fn()->bool)->std::result::Result<Option<lrclib::Hit>,Failure>{self.0.by_id(id,duration,&||cancel()).map_err(failed)}
    fn align(&self,p:&Project,lines:Vec<Line>,tier:Tier,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<lyrics_align::Output,Failure>{
        let input=lyrics_align::capture(p,lines,p.pitch.duration as f64,tier).map_err(failed)?;
        lyrics_align::run(&input,&||cancel(),&|p|progress(p))
    }
    fn transcribe(&self,p:&Project,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<lyrics_align::Transcription,Failure>{lyrics_align::transcribe(p,p.pitch.duration as f64,&||cancel(),&|p|progress(p))}
}
fn valid_cache(raw:&Value)->Option<Value>{
    let document=crate::project_lyrics::from_value(raw).ok()??;
    if document.lines.is_empty(){return None;}
    let mut raw=raw.clone();
    if raw["source"].as_str().is_none(){raw["source"]=json!("whisper");}
    Some(raw)
}
fn rows(raw:&Value)->Result<Vec<Line>>{serde_json::from_value(raw["lines"].clone()).context("Invalid saved lyric lines")}
fn reference(raw:&Value)->Result<Vec<Line>>{
    let lines=rows(raw)?;
    let base=raw.get("base").and_then(|v|serde_json::from_value::<Vec<Line>>(v.clone()).ok());
    Ok(base.filter(|b|b.len()==lines.len()&&b.iter().zip(&lines).all(|(a,b)|a.text==b.text&&a.words.len()==b.words.len())).unwrap_or(lines))
}
fn fresh(previous:Option<&Value>,source:&str,lines:Vec<Line>)->Value{
    let mut raw=previous.filter(|v|v.is_object()).cloned().unwrap_or_else(||json!({}));
    for field in ["source","credit","aligned","check","base","engine","lrclibPending","lookup","lines"]{raw.as_object_mut().unwrap().remove(field);}
    raw["source"]=json!(source);raw["lines"]=json!(lines);raw
}
fn proposal(raw:Value,write:bool,cached:bool,check:Option<Check>,warnings:Vec<String>)->std::result::Result<Proposal,Failure>{
    let document=crate::project_lyrics::from_value(&raw).map_err(failed)?;
    if document.is_none_or(|d|d.lines.is_empty()){return Err(failed("No words detected. Try a different lyrics version or write your own."));}
    if serde_json::to_vec(&raw).map_err(failed)?.len()>8*1024*1024{return Err(failed("Lyrics file is too large"));}
    Ok(Proposal{raw,write,cached,check,warnings})
}
fn hit(previous:Option<&Value>,hit:lrclib::Hit)->std::result::Result<Proposal,Failure>{
    let mut raw=fresh(previous,"lrclib",hit.lines);raw["credit"]=json!(hit.credit);proposal(raw,true,false,None,vec![])
}
fn cached(raw:Value)->std::result::Result<Proposal,Failure>{let check=raw.get("check").and_then(|v|serde_json::from_value(v.clone()).ok());proposal(raw,false,true,check,vec![])}

pub fn run(project:&Project,intent:Intent,client:&lrclib::Client,cancel:&impl Fn()->bool,progress:&impl Fn(Progress))->std::result::Result<Proposal,Failure>{
    active(cancel)?;
    let result=(||{
        let raw=read_raw(project).map_err(failed)?;
        let cache=raw.as_ref().and_then(valid_cache);
        let effective=if matches!(intent,Intent::Align|Intent::Precise)&&cache.as_ref().is_none_or(|r|r["source"]=="whisper"){Intent::Auto}else{intent};
        let needs_online=effective==Intent::Auto&&cache.as_ref().is_none_or(needs_online_recheck);
        let (meta,filename)=if needs_online {track_meta(project,cancel).map_err(failed)?}else{let f=lrclib::meta_from_filename(metadata_filename(project),project.pitch.duration as f64);(f.clone(),f)};
        resolve(project,raw.as_ref(),intent,&meta,&filename,&Native(client),cancel,progress)
    })();
    if cancel(){Err(Failure::Cancelled)}else{result}
}
fn resolve(project:&Project,previous:Option<&Value>,intent:Intent,meta:&lrclib::TrackMeta,filename:&lrclib::TrackMeta,ops:&impl Operations,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<Proposal,Failure>{
    let result=resolve_inner(project,previous,intent,meta,filename,ops,cancel,progress);
    if cancel(){Err(Failure::Cancelled)}else{result}
}
fn resolve_inner(project:&Project,previous:Option<&Value>,mut intent:Intent,meta:&lrclib::TrackMeta,filename:&lrclib::TrackMeta,ops:&impl Operations,cancel:&dyn Fn()->bool,progress:&dyn Fn(Progress))->std::result::Result<Proposal,Failure>{
    active(cancel)?;progress(Progress{stage:"preparing".into(),percent:0.});
    let cache=previous.and_then(valid_cache);
    // An invalid cache is still an existing file. Only an explicit action may
    // replace it; source=edited is protected even when all its rows are invalid.
    if intent==Intent::Auto || (matches!(intent,Intent::Align|Intent::Precise)&&cache.is_none()) {
        if previous.is_some_and(|raw|raw["source"]=="edited") {
            if let Some(raw)=cache.as_ref() {
                let mut proposal=cached(raw.clone())?;
                proposal.warnings.push(crate::i18n::t("lyrics.panel.autoPreservedEdited"));
                return Ok(proposal);
            }
            return Err(failed(crate::i18n::t("lyrics.panel.autoPreservedUnreadable")));
        }
        if cache.is_none()&&(previous.is_some()||project.lyrics_fingerprint.is_some()) {
            return Err(failed(crate::i18n::t("lyrics.panel.autoPreservedUnreadable")));
        }
    }
    if let Intent::Candidate(id)=intent{
        let selected=ops.candidate(id,project.pitch.duration as f64,cancel)?;active(cancel)?;
        return hit(previous,selected.ok_or_else(||failed("This entry has no usable synced lyrics."))?);
    }
    let align=matches!(intent,Intent::Align|Intent::Precise)&&cache.as_ref().is_some_and(|r|r["source"]!="whisper");
    if matches!(intent,Intent::Align|Intent::Precise)&&!align{intent=Intent::Auto;}
    let online=|progress:&dyn Fn(Progress)|->std::result::Result<lrclib::Lookup,Failure>{
        active(cancel)?;progress(Progress{stage:"searching".into(),percent:10.});
        let mut found=ops.lookup(meta,cancel)?;
        if matches!(found,lrclib::Lookup::Miss)&&(meta.artist!=filename.artist||meta.title!=filename.title){active(cancel)?;found=ops.lookup(filename,cancel)?;}
        active(cancel)?;Ok(found)
    };
    if let Some(raw)=cache.as_ref().filter(|_|!align){
        if intent==Intent::Auto||(intent==Intent::Transcribe&&raw["source"]=="whisper"){
            let reask=intent==Intent::Auto&&needs_online_recheck(raw);
            if reask {
                match online(progress)?{
                    lrclib::Lookup::Hit{lines,credit}=>return hit(previous,lrclib::Hit{lines,credit}),
                    lrclib::Lookup::Miss=>{let mut settled=raw.clone();settled["lrclibPending"]=json!(false);settled["lookup"]=json!(LOOKUP_VERSION);let check=settled.get("check").and_then(|v|serde_json::from_value(v.clone()).ok());return proposal(settled,true,true,check,vec![]);},
                    lrclib::Lookup::Down=>{},
                }
            }
            active(cancel)?;return cached(raw.clone());
        }
    }
    if align {
        let saved=cache.as_ref().unwrap();let base=reference(saved).map_err(failed)?;
        let output=ops.align(project,base.clone(),if intent==Intent::Precise{Tier::Precise}else{Tier::Align},cancel,progress)?;active(cancel)?;
        if output.check.verdict=="mismatch" {return proposal(saved.clone(),false,false,Some(output.check),output.warnings);}
        let mut raw=fresh(previous,saved["source"].as_str().unwrap_or("whisper"),output.lines);
        if let Some(credit)=saved.get("credit"){raw["credit"]=credit.clone();}
        raw["aligned"]=json!(true);raw["base"]=json!(base);raw["check"]=json!(output.check);
        if output.check.method=="qwen"{raw["engine"]=json!(ENGINE);}
        return proposal(raw,true,false,Some(output.check),output.warnings);
    }
    let mut down=false;
    if intent==Intent::Auto {match online(progress)?{lrclib::Lookup::Hit{lines,credit}=>return hit(previous,lrclib::Hit{lines,credit}),lrclib::Lookup::Miss=>{},lrclib::Lookup::Down=>down=true}}
    active(cancel)?;let output=ops.transcribe(project,cancel,progress)?;active(cancel)?;
    let mut raw=fresh(previous,"whisper",output.lines);raw["engine"]=json!(ENGINE);raw["lrclibPending"]=json!(down);raw["lookup"]=json!(LOOKUP_VERSION);
    proposal(raw,true,false,None,output.warnings)
}
pub fn read_raw(project:&Project)->Result<Option<Value>>{
    let bytes=crate::project_store::member_bytes(&project.dir,"lyrics.json")?;
    let identity=bytes.as_ref().map(|b|crate::project_store::fingerprint(b));
    ensure!(identity==project.lyrics_fingerprint,"Lyrics changed outside this app. Reopen the song before continuing.");
    // Preserve presence even for malformed JSON. Explicit user actions can
    // repair it; Auto must never interpret these bytes as a missing file.
    Ok(bytes.map(|b|serde_json::from_slice::<Value>(&b).unwrap_or(Value::Null)))
}
fn track_meta(project:&Project,cancel:&impl Fn()->bool)->Result<(lrclib::TrackMeta,lrclib::TrackMeta)>{
    ensure!(!cancel(),"Lyrics lookup cancelled");
    let file=project.raw["songFile"].as_str().and_then(|p|project.dir.join(p).canonicalize().ok()).filter(|p|p.starts_with(&project.dir));
    let filename=lrclib::meta_from_filename(metadata_filename(project),project.pitch.duration as f64);
    let Some(file)=file else{return Ok((filename.clone(),filename));};
    let tags=crate::audio_tags::read(&file,cancel).unwrap_or_default();
    ensure!(!cancel(),"Lyrics lookup cancelled");
    let (meta,_)=lrclib::metadata(metadata_filename(project),tags.artist.as_deref(),tags.title.as_deref(),tags.album.as_deref(),project.pitch.duration as f64);
    Ok((meta,filename))
}

#[cfg(test)]
#[path="lyrics_resolution_tests.rs"]
mod tests;

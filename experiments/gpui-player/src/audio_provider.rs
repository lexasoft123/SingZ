//! Typed provider intent and native identity. Capture device IDs are independent.
use anyhow::{Context,Result,ensure};
use serde::{Deserialize,Serialize};
use serde_json::Value;

#[derive(Clone,Copy,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="lowercase")]
pub enum Provider {Wasapi,Asio,CoreAudio,Alsa,Unsupported}
impl Provider {
    pub fn as_str(self)->&'static str {match self {Self::Wasapi=>"wasapi",Self::Asio=>"asio",Self::CoreAudio=>"coreaudio",Self::Alsa=>"alsa",Self::Unsupported=>"unsupported"}}
    pub fn parse(value:&str)->Result<Self>{Ok(match value {"wasapi"=>Self::Wasapi,"asio"=>Self::Asio,"coreaudio"=>Self::CoreAudio,"alsa"=>Self::Alsa,"unsupported"=>Self::Unsupported,_=>anyhow::bail!("Unknown native audio provider")})}
    pub fn platform_default()->Self {if cfg!(windows){Self::Wasapi}else if cfg!(target_os="macos"){Self::CoreAudio}else if cfg!(target_os="linux"){Self::Alsa}else{Self::Unsupported}}
    pub(crate) fn code(self)->u64 {match self {Self::Wasapi=>0,Self::Asio=>1,Self::CoreAudio=>2,Self::Alsa=>3,Self::Unsupported=>4}}
    pub(crate) fn next_inventory_token(self,previous:u64)->u64 {((previous>>3)+1)*8+self.code()}
    pub(crate) fn from_code(code:u64)->Self {match code&7 {0=>Self::Wasapi,1=>Self::Asio,2=>Self::CoreAudio,3=>Self::Alsa,_=>Self::Unsupported}}
}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct ProviderAvailability {pub id:Provider,pub label:String,pub compiled:bool,pub available:bool,pub detail:String,pub error_code:String}
#[derive(Clone,Debug,PartialEq,Eq,Serialize,Deserialize)]
#[serde(rename_all="camelCase")]
pub struct Providers {pub platform:String,pub default_provider:Provider,pub providers:Vec<ProviderAvailability>}
impl Providers {
    pub fn parse(raw:&Value)->Result<Self> {
        ensure!(raw["protocol"]==1&&raw["ok"]==true,"Native provider probe failed");
        let platform=raw["platform"].as_str().context("Missing native provider platform")?;
        ensure!(matches!(platform,"win32"|"darwin"|"linux"|"other"),"Unknown native provider platform");
        let default_provider=Provider::parse(raw["defaultProvider"].as_str().context("Missing default audio provider")?)?;
        let rows=raw["providers"].as_array().context("Missing audio provider availability")?;
        ensure!(!rows.is_empty()&&rows.len()<=8,"Invalid native provider count");
        let mut providers=vec![];
        for row in rows {
            let id=Provider::parse(row["id"].as_str().context("Missing audio provider ID")?)?;
            ensure!(!providers.iter().any(|r:&ProviderAvailability|r.id==id),"Duplicate native provider ID");
            let label=row["label"].as_str().filter(|s|!s.is_empty()&&s.len()<=256).context("Invalid provider label")?.to_owned();
            let detail=row["detail"].as_str().filter(|s|s.len()<=4096).context("Invalid provider detail")?.to_owned();
            let error_code=row["errorCode"].as_str().filter(|s|s.len()<=128).context("Invalid provider error code")?.to_owned();
            let compiled=row["compiled"].as_bool().context("Missing provider compilation fact")?;
            let available=row["available"].as_bool().context("Missing provider availability fact")?;
            ensure!(!available||compiled,"Uncompiled audio provider cannot be available");
            providers.push(ProviderAvailability{id,label,compiled,available,detail,error_code});
        }
        ensure!(providers.iter().any(|r|r.id==default_provider),"Default provider has no availability fact");
        Ok(Self{platform:platform.into(),default_provider,providers})
    }
    pub fn require_available(&self,provider:Provider)->Result<()> {
        let row=self.providers.iter().find(|r|r.id==provider).context("Requested audio provider is not reported by native code")?;
        ensure!(row.available,"{}",if row.detail.is_empty(){"Requested audio provider is unavailable"}else{&row.detail});Ok(())
    }
}
#[derive(Clone,Debug,PartialEq,Eq,Serialize)]
#[serde(rename_all="camelCase")]
pub struct ProviderSnapshot {
    pub revision:u64,pub request:u64,pub epoch:u64,pub selected:Provider,pub availability:Option<Providers>,
    pub can_change:bool,pub renderer_revision:u64,pub error:Option<String>,
}
impl Default for ProviderSnapshot {
    fn default()->Self {Self{revision:0,request:0,epoch:0,selected:Provider::platform_default(),availability:None,can_change:false,renderer_revision:1,error:None}}
}
pub fn windows_provider(raw:&Value)->Result<Provider> {
    match raw.get("nativeAudioProvider") {
        None|Some(Value::Null)=>Ok(Provider::Wasapi),
        Some(value)=>{let provider=Provider::parse(value.as_str().context("Invalid saved Windows audio provider")?)?;
            ensure!(matches!(provider,Provider::Wasapi|Provider::Asio),"Invalid saved Windows audio provider");Ok(provider)}
    }
}
pub fn restored_provider(raw:&Value)->Result<Provider> {if cfg!(windows){windows_provider(raw)}else{Ok(Provider::platform_default())}}
pub fn validate_output_uid(provider:Provider,uid:&str,windows:bool)->Result<()> {
    ensure!(uid.len()<=2000&&!uid.contains('\0'),"Invalid output device");
    if windows&&!uid.is_empty() {
        ensure!(matches!(provider,Provider::Wasapi|Provider::Asio),"Invalid Windows output provider");
        let suffix=uid.strip_prefix(&format!("{}:",provider.as_str())).context("Output device belongs to a different audio provider")?;
        ensure!(!suffix.is_empty(),"Missing provider-scoped output device");
    }Ok(())
}
pub fn scoped_output_uid(raw:&Value,provider:Provider,windows:bool)->Result<String> {
    let mut uid=super::output_uid(raw)?;
    // Only the old absent-provider preference proves a WASAPI legacy choice.
    // Explicit ASIO or an explicitly mismatched ID must never be reinterpreted.
    if windows&&provider==Provider::Wasapi&&raw.get("nativeAudioProvider").is_none()&&!uid.is_empty()&&!uid.starts_with("wasapi:")&&!uid.starts_with("asio:") {uid=format!("wasapi:{uid}");}
    validate_output_uid(provider,&uid,windows)?;Ok(uid)
}
pub fn verify_provider_receipt(raw:&Value,expected:Provider)->Result<()> {
    let provider=Provider::parse(raw["provider"].as_str().context("Native reply omitted its audio provider identity")?)?;
    ensure!(provider==expected,"Native audio provider differs from the accepted selection");
    let fixture=raw["fixture"].as_bool().context("Native reply omitted backend provenance")?;
    if raw["ok"]==false&&raw["backendProvider"].is_null(){return Ok(());}
    let backend=raw["backendProvider"].as_str().context("Native reply omitted its backend identity")?;
    ensure!(backend==if fixture{"fake"}else{expected.as_str()},"Native backend identity/provenance differs from the accepted provider");Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test] fn inventory_generation_distinguishes_same_provider_refresh_and_aba() {
        let initial=Provider::Wasapi.code();
        let asio=Provider::Asio.next_inventory_token(initial);
        let wasapi=Provider::Wasapi.next_inventory_token(asio);
        let refresh=Provider::Wasapi.next_inventory_token(wasapi);
        assert_ne!(initial,wasapi);assert_ne!(wasapi,refresh);
        assert_eq!(Provider::from_code(wasapi),Provider::Wasapi);
        assert_eq!(Provider::from_code(asio),Provider::Asio);
        // Equality is against the whole request token, not provider identity.
        assert!([initial,asio,wasapi].into_iter().all(|old|old!=refresh));
    }
    #[test] fn windows_intent_is_explicit_and_legacy_uid_migration_is_narrow() {
        assert_eq!(windows_provider(&json!({})).unwrap(),Provider::Wasapi);
        assert_eq!(windows_provider(&json!({"nativeAudioProvider":"asio"})).unwrap(),Provider::Asio);
        assert!(windows_provider(&json!({"nativeAudioProvider":"alsa"})).is_err());
        assert_eq!(scoped_output_uid(&json!({"outputUid":"legacy"}),Provider::Wasapi,true).unwrap(),"wasapi:legacy");
        assert!(scoped_output_uid(&json!({"nativeAudioProvider":"asio","outputUid":"wasapi:legacy"}),Provider::Asio,true).is_err());
        assert!(scoped_output_uid(&json!({"nativeAudioProvider":"wasapi","outputUid":"legacy"}),Provider::Wasapi,true).is_err());
        assert_eq!(scoped_output_uid(&json!({"outputUid":"raw-input-output"}),Provider::CoreAudio,false).unwrap(),"raw-input-output");
    }
    #[test] fn native_identity_cannot_silently_fall_back_or_mislabel_fake_hardware() {
        let mut reply=json!({"ok":true,"provider":"wasapi","backendProvider":"wasapi","fixture":false});
        assert!(verify_provider_receipt(&reply,Provider::Wasapi).is_ok());
        assert!(verify_provider_receipt(&reply,Provider::Asio).is_err());
        reply["fixture"]=true.into();assert!(verify_provider_receipt(&reply,Provider::Wasapi).is_err());
        reply["backendProvider"]="fake".into();assert!(verify_provider_receipt(&reply,Provider::Wasapi).is_ok());
        reply.as_object_mut().unwrap().remove("provider");assert!(verify_provider_receipt(&reply,Provider::Wasapi).is_err());
    }
    #[test] fn unavailable_provider_reason_and_compilation_fact_are_preserved() {
        let raw=json!({"protocol":1,"ok":true,"platform":"win32","defaultProvider":"wasapi","providers":[
            {"id":"wasapi","label":"WASAPI","compiled":true,"available":true,"detail":"Windows audio","errorCode":""},
            {"id":"asio","label":"ASIO","compiled":false,"available":false,"detail":"ASIO is not compiled","errorCode":"not-compiled"}]});
        let providers=Providers::parse(&raw).unwrap();assert!(providers.require_available(Provider::Wasapi).is_ok());
        assert!(providers.require_available(Provider::Asio).unwrap_err().to_string().contains("not compiled"));
        let mut invalid=raw;invalid["providers"][1]["available"]=true.into();assert!(Providers::parse(&invalid).is_err());
    }
}

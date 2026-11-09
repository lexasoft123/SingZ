//! Drive REST operations. All callers run on the independent sync worker.
use crate::{
    drive_auth::AuthClient,
    drive_http::{Body, Destination, Request, Response},
    drive_plan::{self, RemoteEntry},
};
use anyhow::{Context, Result, ensure};
use serde_json::{Value, json};
use std::{
    collections::{BTreeMap, BTreeSet},
    path::Path,
};

pub const FOLDER: &str = "application/vnd.google-apps.folder";
const JSON_LIMIT: usize = 16 * 1024 * 1024;
const FILE_LIMIT: usize = 100_000;
const METADATA_FIELDS: &str = "id,name,mimeType,md5Checksum,size,parents,appProperties,trashed";

/// Exact-ID observation, including trash state that a folder listing omits.
/// This is an observed baseline, never a server compare-and-set guarantee.
#[derive(Clone, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct Metadata {
    #[serde(flatten)]
    pub entry: RemoteEntry,
    pub trashed: bool,
}

impl Metadata {
    fn validate(&self, id: &str) -> Result<()> {
        validate_id(&self.entry.id)?;
        ensure!(
            self.entry.id == id,
            "Drive metadata returned a different ID"
        );
        ensure!(
            !self.entry.name.is_empty() && self.entry.name.len() <= 16_384,
            "Invalid Drive metadata name"
        );
        ensure!(
            self.entry.parents.len() <= 1,
            "Drive metadata has ambiguous parents"
        );
        for parent in &self.entry.parents {
            validate_id(parent)?;
        }
        if self.entry.mime_type.as_deref() != Some(FOLDER) {
            ensure!(
                self.entry
                    .md5_checksum
                    .as_ref()
                    .is_some_and(|s| s.len() == 32 && s.bytes().all(|b| b.is_ascii_hexdigit()))
                    && self.entry.size.as_ref().is_some_and(|s| !s.is_empty()
                        && s.bytes().all(|b| b.is_ascii_digit())
                        && s.parse::<u64>().is_ok()),
                "Drive metadata has no bounded content fingerprint"
            );
        }
        ensure!(
            self.entry
                .mime_type
                .as_ref()
                .is_some_and(|s| !s.is_empty() && s.len() <= 1024),
            "Drive metadata has no MIME type"
        );
        Ok(())
    }
}

pub struct Remote {
    pub auth: AuthClient,
}
impl Remote {
    pub fn new(auth: AuthClient) -> Self {
        Self { auth }
    }
    /// Durable account binding without writing the raw Drive permission ID to
    /// journals. Used only by transactions that need cross-process recovery.
    pub fn account_key(&self, cancel: &impl Fn() -> bool) -> Result<String> {
        use sha2::{Digest, Sha256};
        let value = self.json(
            "GET",
            "/drive/v3/about?fields=user(permissionId)",
            None,
            cancel,
        )?;
        let permission = value["user"]["permissionId"]
            .as_str()
            .context("Drive account identity is unavailable")?;
        ensure!(
            !permission.is_empty()
                && permission.len() <= 1024
                && !permission.chars().any(char::is_control),
            "Invalid Drive account identity"
        );
        let digest = Sha256::digest(permission.as_bytes())
            .iter()
            .map(|b| format!("{b:02x}"))
            .collect::<String>();
        Ok(format!("drive-permission-sha256:{digest}"))
    }
    fn endpoint(&self, path: &str) -> Result<url::Url> {
        ensure!(
            path.starts_with('/') && !path.starts_with("//"),
            "Invalid Drive API path"
        );
        Ok(url::Url::parse(&format!(
            "{}{}",
            self.auth.config.api_base.trim_end_matches('/'),
            path
        ))?)
    }
    fn send(
        &self,
        method: &str,
        url: &str,
        body: Body<'_>,
        headers: &[(&str, &str)],
        upload: bool,
        cancel: &impl Fn() -> bool,
    ) -> Result<Response> {
        let response = self.auth.request(
            Request {
                method,
                url,
                headers,
                body,
                destination: Destination::Bytes(JSON_LIMIT),
                upload,
                allow_loopback_http: self.auth.config.allow_loopback_http(),
            },
            cancel,
        )?;
        ensure!(
            (200..300).contains(&response.status),
            "Drive API {}",
            response.status
        );
        Ok(response)
    }
    fn json(
        &self,
        method: &str,
        path: &str,
        body: Option<&Value>,
        cancel: &impl Fn() -> bool,
    ) -> Result<Value> {
        let url = self.endpoint(path)?;
        let bytes = body.map(serde_json::to_vec).transpose()?;
        let headers = [("Content-Type", "application/json")];
        let response = self.send(
            method,
            url.as_str(),
            bytes.as_deref().map_or(Body::Empty, Body::Bytes),
            &headers,
            false,
            cancel,
        )?;
        if response.body.is_empty() {
            Ok(Value::Null)
        } else {
            response.json()
        }
    }
    pub fn list(&self, query: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        let mut files = Vec::new();
        let mut page = String::new();
        let mut seen_pages = BTreeSet::new();
        loop {
            ensure!(!cancel(), "Drive sync cancelled");
            let mut url = self.endpoint("/drive/v3/files")?;
            url.query_pairs_mut()
                .append_pair("q", query)
                .append_pair(
                    "fields",
                    "nextPageToken,files(id,name,mimeType,md5Checksum,size,parents,appProperties)",
                )
                .append_pair("pageSize", "1000");
            if !page.is_empty() {
                url.query_pairs_mut().append_pair("pageToken", &page);
            }
            let value = self
                .send("GET", url.as_str(), Body::Empty, &[], false, cancel)?
                .json()?;
            let batch: Vec<RemoteEntry> = serde_json::from_value(
                value
                    .get("files")
                    .cloned()
                    .context("Drive listing has no files")?,
            )?;
            ensure!(
                files.len().saturating_add(batch.len()) <= FILE_LIMIT,
                "Drive listing exceeds supported size"
            );
            for file in &batch {
                validate_id(&file.id)?;
                ensure!(file.name.len() <= 16_384, "Drive file name exceeds limit");
                for parent in &file.parents {
                    validate_id(parent)?;
                }
            }
            files.extend(batch);
            page = match value.get("nextPageToken") {
                None | Some(Value::Null) => String::new(),
                Some(v) => v.as_str().context("Invalid Drive page token")?.to_owned(),
            };
            if page.is_empty() {
                break;
            }
            ensure!(
                page.len() <= 8192 && seen_pages.insert(page.clone()),
                "Drive returned repeated or oversized page token"
            );
        }
        let mut ids = BTreeSet::new();
        ensure!(
            files.iter().all(|entry| ids.insert(entry.id.clone())),
            "Drive listing contains duplicate file IDs"
        );
        Ok(files)
    }
    pub fn children(&self, parent: &str, cancel: &impl Fn() -> bool) -> Result<Vec<RemoteEntry>> {
        validate_id(parent)?;
        self.list(
            &format!(
                "'{}' in parents and trashed=false",
                drive_plan::escape_query_string(parent)
            ),
            cancel,
        )
    }
    pub fn children_of(
        &self,
        parents: &[String],
        cancel: &impl Fn() -> bool,
    ) -> Result<BTreeMap<String, Vec<RemoteEntry>>> {
        let mut result: BTreeMap<_, Vec<_>> =
            parents.iter().cloned().map(|id| (id, Vec::new())).collect();
        for chunk in drive_plan::chunk_parents(parents)? {
            for file in self.list(&drive_plan::parents_query(&chunk)?, cancel)? {
                for parent in &file.parents {
                    if let Some(children) = result.get_mut(parent) {
                        children.push(file.clone());
                    }
                }
            }
        }
        Ok(result)
    }
    pub fn folder(
        &self,
        name: &str,
        parent: Option<&str>,
        cancel: &impl Fn() -> bool,
    ) -> Result<String> {
        ensure!(drive_plan::plain_name(name), "Unsafe Drive folder name");
        let mut query = format!(
            "name='{}' and mimeType='{FOLDER}' and trashed=false",
            drive_plan::escape_query_string(name)
        );
        if let Some(parent) = parent {
            validate_id(parent)?;
            query.push_str(&format!(
                " and '{}' in parents",
                drive_plan::escape_query_string(parent)
            ));
        }
        let found = self.list(&query, cancel)?;
        let usable: Vec<_> = found
            .iter()
            .filter(|f| {
                f.mime_type.as_deref() == Some(FOLDER)
                    && f.name == name
                    && !drive_plan::is_published(f)
            })
            .collect();
        ensure!(
            usable.len() <= 1,
            "Drive has duplicate folders named {name}; sync refused"
        );
        if let Some(file) = usable.first() {
            return Ok(file.id.clone());
        }
        let mut body = json!({"name":name,"mimeType":FOLDER});
        if let Some(parent) = parent {
            body["parents"] = json!([parent]);
        }
        let result = self.json("POST", "/drive/v3/files?fields=id", Some(&body), cancel)?;
        let id = result["id"]
            .as_str()
            .context("Drive folder creation returned no ID")?;
        validate_id(id)?;
        Ok(id.into())
    }
    pub fn patch(&self, id: &str, properties: &Value, cancel: &impl Fn() -> bool) -> Result<()> {
        validate_id(id)?;
        self.json(
            "PATCH",
            &format!("/drive/v3/files/{id}"),
            Some(properties),
            cancel,
        )?;
        Ok(())
    }
    pub fn metadata(&self, id: &str, cancel: &impl Fn() -> bool) -> Result<Metadata> {
        self.metadata_if_exists(id, cancel)?
            .context("Drive file metadata is missing")
    }
    /// None means exactly HTTP 404. Authorization, transport and malformed
    /// metadata are errors, never permission to allocate another object ID.
    pub fn metadata_if_exists(
        &self,
        id: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<Option<Metadata>> {
        validate_id(id)?;
        let mut url = self.endpoint(&format!("/drive/v3/files/{id}"))?;
        url.query_pairs_mut().append_pair("fields", METADATA_FIELDS);
        let response = self.auth.request(
            Request {
                method: "GET",
                url: url.as_str(),
                headers: &[],
                body: Body::Empty,
                destination: Destination::Bytes(JSON_LIMIT),
                upload: false,
                allow_loopback_http: self.auth.config.allow_loopback_http(),
            },
            cancel,
        )?;
        if response.status == 404 {
            return Ok(None);
        }
        ensure!(
            (200..300).contains(&response.status),
            "Drive metadata HTTP {}",
            response.status
        );
        let observed: Metadata = serde_json::from_value(response.json()?)?;
        observed.validate(id)?;
        Ok(Some(observed))
    }
    /// Persist this reserved identity BEFORE any create request. A lost create
    /// acknowledgement can then only be retried with this same Drive ID.
    pub fn generate_id(&self, cancel: &impl Fn() -> bool) -> Result<String> {
        let value = self.json(
            "GET",
            "/drive/v3/files/generateIds?count=1&space=drive&type=files",
            None,
            cancel,
        )?;
        let ids = value["ids"]
            .as_array()
            .context("Drive did not return generated IDs")?;
        ensure!(
            ids.len() == 1,
            "Drive returned an unexpected generated-ID count"
        );
        let id = ids[0]
            .as_str()
            .context("Drive returned an invalid generated ID")?;
        validate_id(id)?;
        Ok(id.into())
    }
    fn create_reserved(
        &self,
        expected: &Metadata,
        cancel: &impl Fn() -> bool,
        create: impl FnOnce() -> Result<()>,
    ) -> Result<Metadata> {
        expected.validate(&expected.entry.id)?;
        ensure!(
            !expected.trashed && expected.entry.parents.len() == 1,
            "Reserved create requires an exact live parent"
        );
        if let Some(current) = self.metadata_if_exists(&expected.entry.id, cancel)? {
            ensure!(
                current == *expected,
                "Reserved Drive ID belongs to different metadata or content"
            );
            return Ok(current);
        }
        ensure!(!cancel(), "Drive sync cancelled");
        let acknowledgement = create();
        ensure!(
            !cancel(),
            "Reserved Drive create acknowledgement unknown after cancellation; retain the same ID"
        );
        // A successful create, 409, timeout or lost response is resolved by the
        // same exact-ID observation. A temporary 404 is pending, never a new ID.
        let current = self
            .metadata_if_exists(&expected.entry.id, cancel)
            .context("Reserved Drive create outcome unknown; retain the same ID")?;
        if let Some(current) = current {
            ensure!(
                current == *expected,
                "Reserved Drive create conflicted; retain transaction intent"
            );
            return Ok(current);
        }
        match acknowledgement {
            Err(error) => {
                Err(error.context("Reserved Drive create not observable; retain the same ID"))
            }
            Ok(()) => anyhow::bail!("Reserved Drive create not observable; retain the same ID"),
        }
    }
    pub fn owned_folder_with_id(
        &self,
        id: &str,
        name: &str,
        parent: &str,
        properties: &BTreeMap<String, String>,
        cancel: &impl Fn() -> bool,
    ) -> Result<Metadata> {
        let generation = self.auth.store.generation();
        let original_cancel = cancel;
        let cancel = &|| original_cancel() || self.auth.store.generation() != generation;
        validate_id(id)?;
        validate_id(parent)?;
        validate_owned_properties(properties)?;
        ensure!(
            id != parent && drive_plan::plain_name(name),
            "Unsafe reserved Drive folder"
        );
        let expected = Metadata {
            entry: RemoteEntry {
                id: id.into(),
                name: name.into(),
                mime_type: Some(FOLDER.into()),
                parents: vec![parent.into()],
                app_properties: properties.clone(),
                ..Default::default()
            },
            trashed: false,
        };
        self.create_reserved(&expected,cancel,||{
            self.json("POST","/drive/v3/files?fields=id",Some(&json!({"id":id,"name":name,"parents":[parent],"mimeType":FOLDER,"appProperties":properties})),cancel)?;Ok(())
        })
    }
    pub fn upload_reserved_bytes(
        &self,
        id: &str,
        bytes: &[u8],
        name: &str,
        parent: &str,
        mime: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<Metadata> {
        use md5::{Digest, Md5};
        let generation = self.auth.store.generation();
        let original_cancel = cancel;
        let cancel = &|| original_cancel() || self.auth.store.generation() != generation;
        validate_id(id)?;
        validate_id(parent)?;
        ensure!(
            id != parent
                && drive_plan::plain_name(name)
                && !mime.is_empty()
                && mime.len() <= 1024
                && !mime.chars().any(char::is_control),
            "Unsafe reserved Drive upload"
        );
        let expected = Metadata {
            entry: RemoteEntry {
                id: id.into(),
                name: name.into(),
                mime_type: Some(mime.into()),
                parents: vec![parent.into()],
                md5_checksum: Some(format!("{:x}", Md5::digest(bytes))),
                size: Some(bytes.len().to_string()),
                ..Default::default()
            },
            trashed: false,
        };
        self.create_reserved(&expected, cancel, || {
            let mut url = url::Url::parse(&format!(
                "{}/upload/drive/v3/files",
                self.auth.config.upload_base.trim_end_matches('/')
            ))?;
            url.query_pairs_mut().append_pair("uploadType", "resumable");
            let metadata = serde_json::to_vec(
                &json!({"id":id,"name":name,"parents":[parent],"mimeType":mime}),
            )?;
            let init = self.send(
                "POST",
                url.as_str(),
                Body::Bytes(&metadata),
                &[("Content-Type", "application/json")],
                false,
                cancel,
            )?;
            let location = init
                .header("location")
                .context("Drive gave no reserved upload session")?;
            // AuthClient checks the origin before adding credentials.
            self.send(
                "PUT",
                location,
                Body::Bytes(bytes),
                &[("Content-Type", mime)],
                true,
                cancel,
            )?;
            Ok(())
        })
    }
    /// Stream a durable captured payload into a preallocated identity. The
    /// exact intended object can acknowledge a lost PUT without reopening a
    /// deleted live source or allocating another file ID.
    pub fn upload_reserved_file(
        &self, id:&str, path:&Path, name:&str, parent:&str, mime:&str,
        expected_md5:&str, expected_size:u64, cancel:&impl Fn()->bool,
    ) -> Result<Metadata> {
        let generation=self.auth.store.generation();let original_cancel=cancel;
        let cancel=&||original_cancel()||self.auth.store.generation()!=generation;
        validate_id(id)?;validate_id(parent)?;
        ensure!(id!=parent&&drive_plan::plain_name(name)&&crate::drive_snapshot::valid_md5(expected_md5)
            &&!mime.is_empty()&&mime.len()<=1024&&!mime.chars().any(char::is_control),"Unsafe reserved streamed upload");
        let expected=Metadata{entry:RemoteEntry{id:id.into(),name:name.into(),mime_type:Some(mime.into()),parents:vec![parent.into()],md5_checksum:Some(expected_md5.into()),size:Some(expected_size.to_string()),..Default::default()},trashed:false};
        self.create_reserved(&expected,cancel,||{
            let digest=crate::drive_snapshot::digest(path,cancel)?;
            ensure!(digest.md5==expected_md5&&digest.size==expected_size,"Durable streamed publication payload changed");
            let mut url=url::Url::parse(&format!("{}/upload/drive/v3/files",self.auth.config.upload_base.trim_end_matches('/')))?;
            url.query_pairs_mut().append_pair("uploadType","resumable");
            let metadata=serde_json::to_vec(&json!({"id":id,"name":name,"parents":[parent],"mimeType":mime}))?;
            let init=self.send("POST",url.as_str(),Body::Bytes(&metadata),&[("Content-Type","application/json")],false,cancel)?;
            let location=init.header("location").context("Drive gave no reserved streamed upload session")?;
            self.send("PUT",location,Body::File(path),&[("Content-Type",mime)],true,cancel)?;
            Ok(())
        })
    }
    /// Replace only the observed captured baseline, or recognize its exact
    /// intended result after an unknown acknowledgement. This is an
    /// observation fence, not a server-side cross-file compare-and-set.
    pub fn replace_file_verified(&self,before:&Metadata,desired:&Metadata,path:&Path,cancel:&impl Fn()->bool)->Result<Metadata> {
        before.validate(&before.entry.id)?;desired.validate(&desired.entry.id)?;
        ensure!(!before.trashed&&!desired.trashed&&before.entry.id==desired.entry.id
            &&before.entry.name==desired.entry.name&&before.entry.parents==desired.entry.parents
            &&before.entry.app_properties==desired.entry.app_properties&&before.entry.parents.len()==1
            &&before.entry.mime_type.as_deref()!=Some(FOLDER)&&desired.entry.mime_type.as_deref()!=Some(FOLDER),"Unsafe captured Drive replacement");
        let generation=self.auth.store.generation();let original_cancel=cancel;let cancel=&||original_cancel()||self.auth.store.generation()!=generation;
        let observed=self.metadata(&before.entry.id,cancel)?;if observed==*desired{return Ok(observed);}
        ensure!(observed==*before,"Drive replacement baseline changed; preserve publication intent");
        let digest=crate::drive_snapshot::digest(path,cancel)?;
        ensure!(desired.entry.md5_checksum.as_deref()==Some(digest.md5.as_str())&&desired.entry.size.as_deref().and_then(|n|n.parse::<u64>().ok())==Some(digest.size),"Durable replacement payload changed");
        let mime=desired.entry.mime_type.as_deref().context("Replacement has no MIME type")?;
        let sent=(||->Result<()> {
            let mut url=url::Url::parse(&format!("{}/upload/drive/v3/files/{}",self.auth.config.upload_base.trim_end_matches('/'),before.entry.id))?;
            url.query_pairs_mut().append_pair("uploadType","resumable");let metadata=serde_json::to_vec(&json!({"mimeType":mime}))?;
            let init=self.send("PATCH",url.as_str(),Body::Bytes(&metadata),&[("Content-Type","application/json")],false,cancel)?;
            let location=init.header("location").context("Drive gave no replacement session")?;
            self.send("PUT",location,Body::File(path),&[("Content-Type",mime)],true,cancel)?;Ok(())
        })();
        ensure!(!cancel(),"Drive replacement acknowledgement unknown after cancellation; retain publication intent");
        let observed=self.metadata(&desired.entry.id,cancel).context("Drive replacement outcome unknown; retain publication intent")?;
        if observed==*desired{return Ok(observed);}
        if let Err(error)=sent{return Err(error.context(if observed==*before{"Drive replacement not observed; retain publication intent"}else{"Drive replacement conflicted; retain publication intent"}));}
        anyhow::bail!("Drive replacement verification failed; retain publication intent")
    }
    /// An idempotent single-parent move of the exact captured object. Unknown
    /// PATCH acknowledgement is resolved by GET, never by uploading another copy.
    /// Callers must journal intent first and revalidate their complete roster;
    /// Drive supplies no atomic compare-and-set across this read and mutation.
    pub fn move_verified(
        &self,
        expected: &Metadata,
        destination: &str,
        name: Option<&str>,
        cancel: &impl Fn() -> bool,
    ) -> Result<Metadata> {
        let generation = self.auth.store.generation();
        let original_cancel = cancel;
        let cancel = &|| original_cancel() || self.auth.store.generation() != generation;
        expected.validate(&expected.entry.id)?;
        validate_id(destination)?;
        ensure!(
            !expected.trashed && expected.entry.parents.len() == 1,
            "Drive move requires a live single-parent baseline"
        );
        let original = &expected.entry.parents[0];
        ensure!(
            original != destination && expected.entry.id != destination,
            "Drive move destination aliases its source"
        );
        if let Some(name) = name {
            ensure!(drive_plan::plain_name(name), "Unsafe Drive move name");
        }
        let mut desired = expected.clone();
        desired.entry.parents = vec![destination.into()];
        if let Some(name) = name {
            desired.entry.name = name.into();
        }
        let current = self.metadata(&expected.entry.id, cancel)?;
        if current == desired {
            return Ok(current);
        }
        ensure!(
            current == *expected,
            "Drive move baseline changed; no mutation performed"
        );
        ensure!(!cancel(), "Drive sync cancelled");
        let mut url = self.endpoint(&format!("/drive/v3/files/{}", expected.entry.id))?;
        url.query_pairs_mut()
            .append_pair("addParents", destination)
            .append_pair("removeParents", original)
            .append_pair("fields", METADATA_FIELDS);
        let body =
            serde_json::to_vec(&name.map_or_else(|| json!({}), |name| json!({"name":name})))?;
        let acknowledgement = self
            .send(
                "PATCH",
                url.as_str(),
                Body::Bytes(&body),
                &[("Content-Type", "application/json")],
                false,
                cancel,
            )
            .and_then(|response| response.json());
        // A cancelled/auth-retired operation may have applied. Preserve the
        // caller's durable intent and do not issue cleanup in a cancelled epoch.
        ensure!(
            !cancel(),
            "Drive move acknowledgement unknown after cancellation; retain transaction intent"
        );
        let observed = self
            .metadata(&expected.entry.id, cancel)
            .context("Drive move outcome unknown; retain transaction intent")?;
        if observed == desired {
            return Ok(observed);
        }
        if let Err(error) = acknowledgement {
            return Err(error.context(if observed == *expected {
                "Drive move was not observed; retain transaction intent"
            } else {
                "Drive move conflicted after unknown acknowledgement; retain transaction intent"
            }));
        }
        anyhow::bail!("Drive move verification failed; retain transaction intent")
    }
    /// Look up private app-owned storage, never claim an untagged same-name folder.
    pub fn find_owned_folder(
        &self,
        parent: Option<&str>,
        properties: &BTreeMap<String, String>,
        cancel: &impl Fn() -> bool,
    ) -> Result<Option<Metadata>> {
        let generation = self.auth.store.generation();
        let original_cancel = cancel;
        let cancel = &|| original_cancel() || self.auth.store.generation() != generation;
        validate_owned_properties(properties)?;
        let mut query = format!("mimeType='{FOLDER}' and trashed=false");
        if let Some(parent) = parent {
            validate_id(parent)?;
            query.push_str(&format!(
                " and '{}' in parents",
                drive_plan::escape_query_string(parent)
            ));
        }
        for (key, value) in properties {
            query.push_str(&format!(
                " and appProperties has {{ key='{}' and value='{}' }}",
                drive_plan::escape_query_string(key),
                drive_plan::escape_query_string(value)
            ));
        }
        let candidates = self.list(&query, cancel)?;
        ensure!(
            candidates.len() <= 1,
            "Drive owned folder identity is ambiguous"
        );
        let Some(candidate) = candidates.first() else {
            return Ok(None);
        };
        let observed = self.metadata(&candidate.id, cancel)?;
        ensure!(
            !observed.trashed
                && observed.entry.mime_type.as_deref() == Some(FOLDER)
                && parent.is_none_or(|p| observed.entry.parents == [p])
                && properties
                    .iter()
                    .all(|(k, v)| observed.entry.app_properties.get(k) == Some(v)),
            "Drive owned folder changed during observation"
        );
        Ok(Some(observed))
    }
    pub fn owned_folder(
        &self,
        name: &str,
        parent: Option<&str>,
        properties: &BTreeMap<String, String>,
        cancel: &impl Fn() -> bool,
    ) -> Result<Metadata> {
        let generation = self.auth.store.generation();
        let original_cancel = cancel;
        let cancel = &|| original_cancel() || self.auth.store.generation() != generation;
        ensure!(
            drive_plan::plain_name(name),
            "Unsafe Drive owned folder name"
        );
        if let Some(existing) = self.find_owned_folder(parent, properties, cancel)? {
            ensure!(
                existing.entry.name == name,
                "Drive owned folder name changed"
            );
            return Ok(existing);
        }
        let mut body = json!({"name":name,"mimeType":FOLDER,"appProperties":properties});
        if let Some(parent) = parent {
            body["parents"] = json!([parent]);
        }
        let acknowledgement = self.json("POST", "/drive/v3/files?fields=id", Some(&body), cancel);
        ensure!(
            !cancel(),
            "Drive owned folder acknowledgement unknown after cancellation; retain transaction intent"
        );
        // Even a successful POST must be discovered uniquely by its private
        // ownership markers; malformed/lost responses never trigger another POST.
        let observed = self
            .find_owned_folder(parent, properties, cancel)
            .context("Drive owned folder outcome unknown; retain transaction intent")?;
        if let Some(observed) = observed {
            ensure!(
                observed.entry.name == name,
                "Drive owned folder name changed after creation"
            );
            if let Ok(reply) = acknowledgement {
                if let Some(id) = reply["id"].as_str() {
                    ensure!(
                        id == observed.entry.id,
                        "Drive folder receipt differs from owned identity"
                    );
                }
            }
            return Ok(observed);
        }
        match acknowledgement {
            Err(error) => {
                Err(error.context("Drive owned folder was not observed; retain transaction intent"))
            }
            Ok(_) => anyhow::bail!(
                "Drive owned folder was not observed after creation; retain transaction intent"
            ),
        }
    }
    pub fn trash(&self, id: &str, cancel: &impl Fn() -> bool) -> Result<()> {
        self.patch(id, &json!({"trashed":true}), cancel)
    }
    pub fn upload_file(
        &self,
        path: &Path,
        name: &str,
        parent: &str,
        existing: Option<&str>,
        mime: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<String> {
        self.upload(Body::File(path), name, parent, existing, mime, cancel)
    }
    pub fn upload_bytes(
        &self,
        bytes: &[u8],
        name: &str,
        parent: &str,
        existing: Option<&str>,
        mime: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<String> {
        self.upload(Body::Bytes(bytes), name, parent, existing, mime, cancel)
    }
    fn upload(
        &self,
        body: Body<'_>,
        name: &str,
        parent: &str,
        existing: Option<&str>,
        mime: &str,
        cancel: &impl Fn() -> bool,
    ) -> Result<String> {
        ensure!(drive_plan::plain_name(name), "Unsafe Drive upload name");
        validate_id(parent)?;
        if let Some(id) = existing {
            validate_id(id)?;
        }
        let mut base = format!(
            "{}/upload/drive/v3/files",
            self.auth.config.upload_base.trim_end_matches('/')
        );
        if let Some(id) = existing {
            base.push('/');
            base.push_str(id);
        }
        let mut url = url::Url::parse(&base)?;
        url.query_pairs_mut().append_pair("uploadType", "resumable");
        let metadata = serde_json::to_vec(&if existing.is_some() {
            json!({})
        } else {
            json!({"name":name,"parents":[parent]})
        })?;
        let init = self.send(
            if existing.is_some() { "PATCH" } else { "POST" },
            url.as_str(),
            Body::Bytes(&metadata),
            &[("Content-Type", "application/json")],
            false,
            cancel,
        )?;
        let location = init
            .header("location")
            .context("Drive gave no upload session")?;
        // AuthClient validates the session origin before adding credentials.
        let done = self
            .send(
                "PUT",
                location,
                body,
                &[("Content-Type", mime)],
                true,
                cancel,
            )?
            .json()?;
        let id = done["id"]
            .as_str()
            .or(existing)
            .context("Drive upload returned no file ID")?;
        validate_id(id)?;
        Ok(id.into())
    }
    /// Downloads one attempt into a new private path. Integrity/retry/publication
    /// policy is owned by the adoption worker, never HTTP status alone.
    pub fn download(
        &self,
        id: &str,
        path: &Path,
        limit: u64,
        cancel: &impl Fn() -> bool,
    ) -> Result<u64> {
        self.download_with_progress(id, path, limit, cancel, &|_| {})
    }
    pub fn download_with_progress(
        &self,
        id: &str,
        path: &Path,
        limit: u64,
        cancel: &impl Fn() -> bool,
        progress: &impl Fn(u64),
    ) -> Result<u64> {
        validate_id(id)?;
        let url = self.endpoint(&format!("/drive/v3/files/{id}?alt=media"))?;
        let response = self.auth.request_with_progress(
            Request {
                method: "GET",
                url: url.as_str(),
                headers: &[],
                body: Body::Empty,
                destination: Destination::File(path, limit),
                upload: true,
                allow_loopback_http: self.auth.config.allow_loopback_http(),
            },
            cancel,
            progress,
        )?;
        if !(200..300).contains(&response.status) {
            let _ = std::fs::remove_file(path);
        }
        ensure!(
            (200..300).contains(&response.status),
            "Drive download HTTP {}",
            response.status
        );
        Ok(response.bytes)
    }
}
pub fn validate_id(id: &str) -> Result<()> {
    ensure!(
        !id.is_empty()
            && id.len() <= 1024
            && id
                .bytes()
                .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-'),
        "Invalid Drive file ID"
    );
    Ok(())
}
fn validate_owned_properties(properties: &BTreeMap<String, String>) -> Result<()> {
    ensure!(
        !properties.is_empty() && properties.len() <= 30,
        "Drive owned folder requires bounded private ownership properties"
    );
    for (key, value) in properties {
        ensure!(
            !key.is_empty()
                && !value.is_empty()
                && key.len() + value.len() <= 124
                && !key.chars().chain(value.chars()).any(char::is_control),
            "Invalid private Drive ownership property"
        );
    }
    Ok(())
}

#[cfg(test)]
#[path = "drive_remote_tests.rs"]
mod tests;

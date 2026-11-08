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

pub struct Remote {
    pub auth: AuthClient,
}
impl Remote {
    pub fn new(auth: AuthClient) -> Self {
        Self { auth }
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

#[cfg(test)]
#[path = "drive_remote_tests.rs"]
mod tests;

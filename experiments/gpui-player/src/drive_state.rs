//! Credential-free state shared by the sync worker and native controls.
use serde::{Deserialize, Serialize};
use std::{collections::BTreeMap, path::PathBuf};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Action {
    SignIn,
    SignOut,
    SyncNow,
    Cancel,
    ShowLog,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ProjectState {
    Pending,
    Syncing,
    Synced,
    Blocked,
}

#[derive(Clone, Debug, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Snapshot {
    pub revision: u64,
    pub configured: bool,
    pub signed_in: bool,
    pub signing_in: bool,
    pub busy: bool,
    pub suspended: bool,
    pub capture_project: Option<PathBuf>,
    pub scheduler: crate::sync_scheduler::Status,
    pub progress: String,
    pub fraction: f32,
    pub error: Option<String>,
    pub projects: BTreeMap<PathBuf, ProjectState>,
}
impl Default for Snapshot {
    fn default() -> Self {
        Self {
            revision: 0,
            configured: false,
            signed_in: false,
            signing_in: false,
            busy: false,
            suspended: false,
            capture_project: None,
            scheduler: crate::sync_scheduler::Scheduler::new().status(),
            progress: String::new(),
            fraction: 0.,
            error: None,
            projects: BTreeMap::new(),
        }
    }
}

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

/// Which kept status line `Snapshot::progress` holds. The UI keys on this,
/// never on the (translated) progress text.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ProgressKind {
    #[default]
    None,
    SignedOut,
    Paused,
    Finishing,
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
    pub progress_kind: ProgressKind,
    pub fraction: f32,
    pub error: Option<String>,
    pub projects: BTreeMap<PathBuf, ProjectState>,
}
impl Snapshot {
    pub fn is_up_to_date(&self) -> bool {
        self.configured && self.signed_in && !self.signing_in && !self.busy
            && !self.suspended && self.error.is_none()
            && self.scheduler.phase == crate::sync_scheduler::Phase::Idle
            && self.scheduler.dirty == 0 && self.scheduler.last_sync.is_some()
            && self.scheduler.last_error.is_none()
    }
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
            progress_kind: ProgressKind::None,
            fraction: 0.,
            error: None,
            projects: BTreeMap::new(),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::sync_scheduler::Phase;

    #[test]
    fn completed_receipt_with_no_dirty_marks_is_not_up_to_date_until_idle() {
        let mut state = Snapshot { configured: true, signed_in: true, ..Default::default() };
        state.scheduler.last_sync = Some(100);
        for phase in [Phase::Off, Phase::Pending, Phase::Syncing, Phase::Retrying, Phase::Blocked] {
            state.scheduler.phase = phase;
            assert!(!state.is_up_to_date(), "{phase:?} is still unresolved");
        }
        state.scheduler.phase = Phase::Idle;
        assert!(state.is_up_to_date());
        state.busy = true;
        assert!(!state.is_up_to_date(), "Worker receipt publication is unfinished");
        state.busy = false;
        state.scheduler.dirty = 1;
        assert!(!state.is_up_to_date(), "Newer edits remain unsynced");
        state.scheduler.dirty = 0;
        state.error = Some("Publication failed".into());
        assert!(!state.is_up_to_date());
    }
}

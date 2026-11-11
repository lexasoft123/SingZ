//! Per-item policy, deliberately independent of filesystem and host environment.
use serde::{Deserialize, Serialize};
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub(super) enum Outcome {
    Import,
    KeptNative,
    SkipInvalid,
    RetryLater,
}
#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub(super) struct Entry {
    pub outcome: Outcome,
    pub reason: String,
}
impl Entry {
    pub fn new(outcome: Outcome, reason: &str) -> Self {
        Self {
            outcome,
            reason: reason.into(),
        }
    }
    pub fn terminal(&self) -> bool {
        #[cfg(test)]
        if std::env::var_os("C40_IGNORE_RECORDED").is_some() {
            return false;
        }
        self.outcome != Outcome::RetryLater
    }
}
pub(super) fn decide(
    recorded: Option<&Entry>,
    native_nondefault: bool,
    source_valid: Option<bool>,
) -> Option<Entry> {
    if recorded.is_some_and(Entry::terminal) {
        return None;
    }
    Some(if native_nondefault {
        Entry::new(Outcome::KeptNative, "native-value")
    } else {
        match source_valid {
            Some(true) => Entry::new(Outcome::Import, "validated-source"),
            Some(false) => Entry::new(Outcome::SkipInvalid, "missing-or-invalid-value"),
            None => Entry::new(Outcome::RetryLater, "source-unreadable-or-changing"),
        }
    })
}

use super::*;

#[derive(Default)]
pub(super) struct MonitorFlight {
    pub(super) monitor_requested: bool,
    pub(super) monitor_parked: bool,
    pub(super) monitor: inflight::Inflight<bool>,
    pub(super) monitor_publication_epoch: Option<u64>,
    pub(super) monitor_actions: std::collections::VecDeque<DeferredAudio>,
}

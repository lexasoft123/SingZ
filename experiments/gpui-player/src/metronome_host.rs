use super::*;

#[derive(Default)]
pub(super) struct MetronomeFlight {
    pub(super) metronome: inflight::Inflight<()>,
    pub(super) metronome_accepted: u64,
    pub(super) metronome_requested: Option<(u64, beat::Metronome, Option<beat::Beats>)>,
    pub(super) metronome_save_requested: bool,
    pub(super) metronome_save_waiting: bool,
    pub(super) metronome_navigation: Option<(std::path::PathBuf, bool)>,
}

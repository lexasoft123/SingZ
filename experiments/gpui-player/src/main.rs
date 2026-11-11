#![cfg_attr(target_os = "windows", windows_subsystem = "windows")]
// Drop gate names at compile time from the distributable build.
macro_rules! gated_env {
    ($name:expr) => {{
        #[cfg(feature = "ui-tests")]
        { crate::gated_env::get($name) }
        #[cfg(not(feature = "ui-tests"))]
        { None::<std::ffi::OsString> }
    }};
}
mod gated_env;
#[cfg(feature = "ui-tests")]
#[used]
static SINGZ_GPUI_UI_TESTS_BUILD_MARKER: &[u8] = b"SINGZ_GPUI_UI_TESTS_BUILD_MARKER";
#[cfg(all(feature="ui-tests",target_os="macos"))]
mod ui_desktop_lifecycle;
#[cfg(feature="ui-tests")]
mod ui_project_key;
#[cfg(feature="ui-tests")]
mod ui_region;
#[cfg(feature="ui-tests")]
mod ui_catalog;
#[cfg(feature="ui-tests")]
mod ui_song_output;
#[cfg(feature="ui-tests")]
mod ui_timeline;
mod timeline_viewport;
mod alloc_probe;
mod frame_demand;
mod playhead_overlay;
mod timeline_host;
mod ruler_clearance;
mod restart_cycle;
mod lyrics_countdown;
mod lyric_scroll_geometry;
#[cfg(feature="ui-tests")]
mod ui_lyrics_countdown;
mod region_gesture;
mod region_host;
mod karaoke_host;
mod analysis_host;
mod backdrop_clock;
#[cfg(feature = "ui-tests")]
static UI_FRAME_REQUESTS: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
#[cfg(feature = "ui-tests")]
static UI_FRAME_DEMAND_BITS: std::sync::atomic::AtomicU16 = std::sync::atomic::AtomicU16::new(0);
#[cfg(feature="ui-tests")]
mod ui_modal_backdrop;
mod analyze_provenance;
mod project_key;
mod desktop_actions;
mod desktop_keyboard;
#[cfg(feature="ui-tests")]
mod ui_desktop_keyboard;
#[cfg(feature="ui-tests")]
mod ui_metronome_keyboard;
mod desktop_window_state;
mod desktop_lifecycle;
mod native_build_info;
#[cfg(test)]
#[path="../build_config.rs"]
mod build_config;
mod audio_devices;
mod audio_provider_host;
mod audio_tags;
mod diagnostics;
mod process_registry;
#[cfg(feature="ui-tests")]
mod ui_crash;
mod diagnostics_host;
mod engine_status;
mod engine_setup;
mod engine_setup_host;
mod sync_dirty;
mod drive_auth;
mod drive_http;
mod drive_plan;
mod drive_remote;
mod drive_hash_cache;
mod drive_snapshot;
mod drive_empty;
mod directory_identity;
mod drive_local_ops;
mod drive_retirement;
mod drive_retire_transaction;
mod drive_publication;
mod drive_graph;
mod native_graph;
mod playback_graph;
mod drive_state;
mod drive_sync;
#[cfg(test)]
mod drive_sync_tests;
mod drive_adopt;
mod drive_service;
mod drive_host;
mod drive_restore;
mod drive_restore_service;
mod drive_restore_host;
mod drive_projects;
#[cfg(feature="ui-tests")]
mod ui_drive_restore;
#[cfg(feature = "ui-tests")]
mod ui_audio_provider;
#[cfg(feature = "ui-tests")]
mod ui_empty_drive;
#[cfg(feature = "ui-tests")]
mod ui_drive_retirement;
mod sync_scheduler;
mod lrclib;
mod lyrics_resolution;
mod lyrics_sidebar;
mod lyrics_sidebar_host;
mod background;
mod beat;
mod beat_grid;
mod beat_analysis;
mod lyrics_edit;
mod lyrics_editor;
mod lyrics_store;
mod lyrics_envelope;
mod lyrics_align;
mod alignmentoutcome_domain;
mod file_lease;
mod guide_layout;
mod header;
mod i18n;
mod locale_service;
mod locale_host;
mod language_menu;
#[cfg(test)]
mod native_line_break_tests;
#[cfg(test)]
mod core_case_tables_tests;
mod integration;
mod tracks;
mod custom_tracks_host;
mod audio_recovery_host;
mod empty_project_host;
mod carry_line;
mod carry_line_host;
mod carry_line_popover;
mod stem_export;
mod stem_export_dialog;
mod stem_export_host;
mod library;
mod log_panel;
mod lyric_glow;
mod metronome;
mod metronome_store;
mod microphone;
mod model_catalog;
mod model_install;
mod model_service;
mod models;
mod pitch_strip;
mod project_analysis;
mod project_lyrics;
mod project_library;
mod project_import;
mod library_import;
mod project_picker;
mod project_pitch;
mod project_publish;
mod project_rename;
mod project_delete;
mod project_delete_dialog;
mod project_delete_host;
mod project_store;
mod quick_start;
mod quick_start_store;
mod release_highlights;
mod whats_new;
mod settings;
mod migrate;
mod source_jobs;
mod text_rendering;
mod training;
mod training_audio;
mod training_capture;
mod training_domain;
mod training_lock;
mod training_music;
mod training_preparation;
mod training_program;
mod training_progress;
mod training_recording;
mod training_recording_host;
mod training_recording_store;
mod recording_recovery;
mod training_run;
mod training_scoring;
mod training_session;
mod training_store;
mod transport;
mod transport_timing;
mod transport_host;
mod metronome_host;
mod monitor_host;
mod inflight;
#[cfg(test)]
mod inflight_tests;
#[cfg(feature = "ui-tests")]
mod ui_audio_settings;
#[cfg(feature = "ui-tests")]
mod ui_audio_recovery;
#[cfg(feature = "ui-tests")]
mod ui_benchmark;
#[cfg(feature = "ui-tests")]
mod ui_grain;
#[cfg(feature = "ui-tests")]
mod ui_integration;
#[cfg(feature = "ui-tests")]
mod ui_perf_scenario;
#[cfg(feature = "ui-tests")]
mod ui_library_review;
#[cfg(feature = "ui-tests")]
mod ui_log_review;
#[cfg(feature = "ui-tests")]
mod ui_lyrics_review;
#[cfg(feature = "ui-tests")]
mod ui_lyrics_scroll;
#[cfg(feature = "ui-tests")]
mod ui_lyrics_editor;
#[cfg(feature = "ui-tests")]
mod ui_lyrics_align;
#[cfg(feature = "ui-tests")]
mod ui_analysis_lyrics_races;
#[cfg(feature="ui-tests")]
mod ui_lyrics_sidebar;
#[cfg(feature = "ui-tests")]
mod ui_project_picker;
#[cfg(feature = "ui-tests")]
mod ui_library_import;
#[cfg(feature = "ui-tests")]
mod ui_whats_new;
#[cfg(feature="ui-tests")]
mod ui_engine_setup;
#[cfg(feature="ui-tests")]
mod ui_diagnostics;
#[cfg(feature = "ui-tests")]
mod ui_metronome;
#[cfg(feature = "ui-tests")]
mod ui_beat_detection;
#[cfg(feature = "ui-tests")]
mod ui_microphone;
#[cfg(feature = "ui-tests")]
mod ui_models;
#[cfg(feature = "ui-tests")]
mod ui_monitor;
#[cfg(feature = "ui-tests")]
mod ui_monitor_publication;
#[cfg(feature="ui-tests")]
mod ui_drive;
#[cfg(feature="ui-tests")]
mod ui_locale;
#[cfg(feature = "ui-tests")]
mod ui_native_lyrics;
#[cfg(feature = "ui-tests")]
mod ui_quick_start;
#[cfg(all(feature = "ui-tests", target_os = "macos"))]
mod ui_accessibility;
#[cfg(all(feature = "ui-tests", target_os = "macos"))]
mod ui_accessibility_routes;
#[cfg(feature = "ui-tests")]
mod ui_review;
#[cfg(feature = "ui-tests")]
mod ui_smoke;
#[cfg(feature = "ui-tests")]
mod ui_source;
#[cfg(feature = "ui-tests")]
mod ui_migration;
#[cfg(feature = "ui-tests")]
mod ui_text_phase;
#[cfg(feature = "ui-tests")]
mod ui_title;
#[cfg(feature = "ui-tests")]
mod ui_training;
#[cfg(feature = "ui-tests")]
mod ui_training_audio;
#[cfg(feature = "ui-tests")]
mod ui_training_capture;
#[cfg(feature = "ui-tests")]
mod ui_training_history;
#[cfg(feature = "ui-tests")]
mod ui_training_preparation;
#[cfg(feature = "ui-tests")]
mod ui_training_run;
#[cfg(feature = "ui-tests")]
mod ui_training_keyboard;
#[cfg(feature = "ui-tests")]
mod ui_training_running_keyboard;
#[cfg(feature = "ui-tests")]
mod ui_training_song_keyboard;
#[cfg(feature = "ui-tests")]
mod ui_training_feedback;
#[cfg(feature="ui-tests")]
mod ui_playback_graph;
#[cfg(feature = "ui-tests")]
mod ui_training_recovery;
#[cfg(feature = "ui-tests")]
mod ui_training_input_recovery;
#[cfg(feature = "ui-tests")]
mod ui_training_recording;
#[cfg(feature = "ui-tests")]
mod ui_training_recording_recovery;
#[cfg(feature = "ui-tests")]
mod ui_recording_publication_recovery;
#[cfg(feature = "ui-tests")]
mod ui_project_delete;
#[cfg(feature="ui-tests")]
mod ui_custom_tracks;
#[cfg(feature="ui-tests")]
mod ui_empty_project;
#[cfg(feature="ui-tests")]
mod ui_carry_line;
#[cfg(feature = "ui-tests")]
mod ui_transport_timing;
#[cfg(feature="ui-tests")]
mod ui_transport_legs;
#[cfg(feature="ui-tests")]
mod ui_stem_export;
#[cfg(feature = "ui-tests")]
mod ui_open_steps;
#[cfg(feature = "ui-tests")]
mod ui_bar_edit;
#[cfg(feature = "ui-tests")]
mod ui_first_run;
#[cfg(feature = "ui-tests")]
mod ui_space_focus;
#[cfg(feature = "ui-tests")]
mod ui_played_edge;
#[cfg(feature = "ui-tests")]
mod ui_settings_relaunch;
mod waveform;
mod window_chrome;
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::collections::HashMap;
use std::sync::Arc;
use std::{
    borrow::Cow,
    cell::{Cell, RefCell},
    rc::Rc,
    time::Instant,
};

use singz_uikit::{
    glow, pill,
    tokens::{ACCENT, BG, DIM, FAINT, TEXT},
};
const COLORS: [u32; 7] = [
    0xff5c65, 0xffc53d, 0x527dff, 0xf98424, 0xda81da, 0x27e7bb, 0xc7e06a,
];
const LYRICS: [&str; 6] = [
    "Let the city fade away",
    "Find a little room to breathe",
    "Every note will light the way",
    "Sing the song you carry underneath",
    "Let the moment find its place",
    "And begin again with me",
];
const DURATION: f64 = 192.;
fn clock(s: f64) -> String {
    format!("{}:{:02}", s as u32 / 60, s as u32 % 60)
}
#[derive(Default)]
struct FrameStats {
    last: Option<Instant>,
    advancing_glow_draws: usize,
    intervals: Vec<f64>,
    paint: Vec<f64>,
}
struct PaintTimer {
    start: Instant,
    stats: Rc<RefCell<FrameStats>>,
}
impl Drop for PaintTimer {
    fn drop(&mut self) {
        let now = Instant::now();
        let mut s = self.stats.borrow_mut();
        if let Some(last) = s.last {
            s.intervals
                .push(self.start.duration_since(last).as_secs_f64() * 1000.);
        }
        s.last = Some(self.start);
        s.paint
            .push(now.duration_since(self.start).as_secs_f64() * 1000.);
        if s.paint.len() == 180 {
            let count = s.intervals.len();
            let avg = s.intervals.iter().sum::<f64>() / count as f64;
            s.intervals.sort_by(f64::total_cmp);
            s.paint.sort_by(f64::total_cmp);
            eprintln!(
                "PERF draw cadence {:.1} fps, interval p95 {:.2} ms, lyrics CPU p95 {:.2} ms",
                1000. / avg,
                s.intervals[count * 95 / 100],
                s.paint[171]
            );
            eprintln!(
                "PERF_JSON {{\"draw_fps\":{:.4},\"window_ms\":{:.4},\"frame_interval_p95_ms\":{:.4},\"frame_interval_p99_ms\":{:.4},\"lyrics_cpu_p95_ms\":{:.4},\"frames\":{}}}",
                1000. / avg,
                s.intervals.iter().sum::<f64>(),
                s.intervals[count * 95 / 100],
                s.intervals[count * 99 / 100],
                s.paint[171],
                count
            );
            eprintln!(
                "EFFECT_JSON {{\"advancing_glow_draws\":{}}}",
                s.advancing_glow_draws
            );
            s.advancing_glow_draws = 0;
            s.intervals.clear();
            s.paint.clear();
        }
    }
}
type ShapeKey = (String, [u32; 4], u32);
type LyricLayout = Vec<(f32, f32, Vec<(String, f32, f32, f32)>)>;
#[derive(Clone, Copy, PartialEq)]
enum Screen {
    Training,
    Player,
    Library,
    Settings,
    Log,
    Models,
}

enum DeferredAudio {
    Region(u64),
    Rate(f32, i32),
    Command(String),
    Seek(f64),
    Output(String),
    Open(std::path::PathBuf),
    SourceOutput(source_jobs::Output, Option<SourceResume>, u64),
}
#[derive(Clone)]
struct SourceResume {
    restart_cycle: restart_cycle::RestartCycle,
    play_serial: u64,
    position: f64,
    playing: bool,
    mode: Option<source_jobs::Mode>,
    title: Option<String>,
    dirty: bool,
    mix: project_store::Mix,
}
struct RenamePending {
    epoch: u64,
    resume: SourceResume,
    working: bool,
    active_dir: std::path::PathBuf,
    target: Option<source_jobs::Target>,
}
struct ImportPending {
    epoch:u64,
    resume:SourceResume,
    mode:project_import::Mode,
}
struct DeleteRestore {
    active_dir: std::path::PathBuf,
    working: bool,
    target: Option<source_jobs::Target>,
    resume: SourceResume,
}
struct DeletePending {
    loaded: bool,
    restore: Option<DeleteRestore>,
}
struct Player {
    desktop_shutdown_done: bool,
    desktop_window_state: Option<desktop_window_state::StateStore>,
    practice: Option<training_run::Run>,
    practice_reached: Option<(usize, usize)>,
    training_serial: u64,
    training_test: Option<u64>,
    training_last: Option<training_audio::Status>,
    training_stopped: u64,
    microphone: Option<microphone::Service>,
    mic_prefs: microphone::Prefs,
    mic_prefs_valid: bool,
    mic_pref_seq: u64,
    mic_pref_error: Option<String>,
    mic_view: microphone::View,
    mic_requested: bool,
    mic_permission_requested: bool,
    mic_serial: u64,
    mic_intent: Option<microphone::Intent>,

    native_graph: u64,
    native_lane_revision: u64,
    native_carry_revision: u64,
    carry: carry_line::Desired,
    carry_open: bool,

    carry_popover: Entity<carry_line_popover::Popover>,

    carry_document: Option<Arc<project_lyrics::Document>>,
    carry_mask: Option<Arc<Vec<bool>>>,

    #[cfg(feature="ui-tests")]
    last_playback_status: Option<integration::Status>,
    #[cfg(feature="ui-tests")]
    loading_play_refusals: u64,
    #[cfg(feature="ui-tests")]
    source_resume_probe: Option<ui_source::ResumeProbe>,
    #[cfg(feature="ui-tests")]
    source_seek_receipt: Option<integration::Status>,
    #[cfg(feature="ui-tests")]
    source_publication_fault: Option<std::path::PathBuf>,
    #[cfg(feature="ui-tests")]
    notice_close_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    backend: Option<integration::Backend>,
    audio_provider: Option<integration::ProviderSnapshot>,

    native_epoch: u64,
    native_rate: f32,
    edit_seq: u64,
    saved_seq: u64,
    saving: bool,
    focus_player: bool,
    lyric_document: Arc<project_lyrics::Document>,
    success_toast: Entity<singz_uikit::Toast>,
    stem_export_dialog: Entity<stem_export_dialog::Dialog>,
    stem_export_service: Option<stem_export::Service>,
    stem_export_open: bool,
    stem_export_lanes: Vec<tracks::Lane>,
    stem_export_session: u64,
    stem_export_prompt: bool,
    stem_export_close_pending: bool,
    stem_export_job: Option<u64>,
    #[cfg(feature="ui-tests")]
    stem_export_picker_paths: std::collections::VecDeque<Option<std::path::PathBuf>>,
    #[cfg(feature="ui-tests")]
    stem_export_finished_ids: Vec<u64>,
    library_import: Entity<library_import::ImportDialog>,
    library_import_open:bool,
    library_import_root:Option<std::path::PathBuf>,
    library_import_epoch:u64,
    import_pending:Option<ImportPending>,
    project_picker: Entity<project_picker::Picker>,
    project_picker_open: bool,
    project_picker_session: u64,
    project_picker_prompt_serial: u64,
    project_picker_prompt: Option<(u64,u64)>,
    project_library_service: Option<project_library::Service>,
    project_library_pending: Option<u64>,
    project_library_moving: bool,
    project_library_snapshot: Option<project_library::Snapshot>,
    catalog_root: std::path::PathBuf,
    locale_service: locale_service::Service,
    locale_revision: u64,
    language_state: Option<i18n::LocaleState>,
    language_menu: Entity<language_menu::LanguageMenu>,
    drive_service: Option<drive_service::Service>,
    drive_restore_service: Option<drive_restore_service::Service>,
    drive_restore_snapshot: drive_restore_service::Snapshot,
    drive_projects: Entity<drive_projects::Dialog>,
    drive_projects_open: bool,
    drive_snapshot: drive_state::Snapshot,
    drive_root_waiting: Option<Option<std::path::PathBuf>>,
    #[cfg(feature="ui-tests")]
    drive_test_urls: Vec<String>,
    project_delete: Entity<project_delete_dialog::DeleteDialog>,

    delete_target: Option<project_delete::Target>,

    lyrics_editor: Entity<lyrics_editor::Editor>,
    lyrics_sidebar:Entity<lyrics_sidebar::Sidebar>,

    lyrics_sidebar_intent:lyrics_resolution::Intent,
    lyrics_sidebar_job:lyrics_resolution::Intent,
    lyrics_sidebar_next:Option<lyrics_resolution::Intent>,
    lyrics_sidebar_editor_after:bool,
    lyrics_sidebar_import_after:Option<project_import::Mode>,
    lyrics_sidebar_rename_after:Option<String>,
    lyrics_sidebar_needs:Vec<lyrics_align::NeedModel>,
    lyrics_sidebar_download:Option<model_service::Service>,
    lyrics_sidebar_download_waiting:bool,
    lyrics_sidebar_download_started:bool,
    lyrics_sidebar_download_epoch:u64,
    #[cfg(feature="ui-tests")]
    lyrics_sidebar_settled:Vec<(u64,u64)>,
    lyrics_editor_open: bool,

    lyrics_editor_generation: u64,
    lyrics_editor_epoch: u64,

    lyrics_editor_save_revision: u64,
    lyrics_editor_credit:Option<String>,
    lyrics_edit_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    lyrics_precise_cap: bool,

    lyrics_needs: Vec<lyrics_align::NeedModel>,
    lyrics_download_service: Option<model_service::Service>,

    lyrics_download_started: bool,
    lyrics_envelope_cache: Option<Arc<lyrics_envelope::Envelopes>>,
    native_glows: Rc<RefCell<project_lyrics::GlowCache>>,
    project: Option<integration::Project>,
    loading: bool,
    duration: f64,
    screen: Screen,
    #[cfg(feature = "ui-tests")]
    text_phase_check: bool,
    loaded_song: bool,
    notice: Option<String>,
    previous_screen: Screen,
    songs_catalog: bool,
    header: Entity<header::Header>,
    backdrop: Rc<RefCell<singz_uikit::ModalBackdropCache>>,
    backdrop_clock: backdrop_clock::Clock,
    background: background::Background,
    transport: Entity<transport::Transport>,
    pitch_strip: Entity<pitch_strip::PitchStrip>,
    karaoke: bool,
    karaoke_preferred: bool,
    karaoke_pref_seq: u64,
    karaoke_pref_saved_seq: u64,
    tempo: f32,
    paint_beats: Option<Rc<beat::Beats>>,
    beat_cache: Rc<RefCell<beat_grid::Cache>>,
    beat_handles: Entity<beat_grid::Handles>,
    beat_job_serial: u64,
    beat_mutation: u64,
    beat_job: Option<(u64, u64, bool)>,
    beat_progress: f32,
    beat_result: Option<beat_analysis::Output>,
    beat_auto_serials: std::collections::HashSet<u64>,
    beat_auto_save: bool,
    metronome_ui: Entity<metronome::MetPopover>,
    metronome_open: bool,
    metronome: beat::Metronome,
    beats: Option<beat::Beats>,

    met_prefs_ready: bool,

    analysis_progress: Option<f32>,
    analysis_job: Option<u64>,

    #[cfg(feature = "ui-tests")]
    timing_analysis_override: Option<(String,f32)>,
    master_volume: f32,
    library: Entity<library::LibraryScreen>,
    training: Entity<training::TrainingScreen>,
    training_store: Option<training_store::Service>,
    training_store_revision: u64,
    training_profile_sent: Option<(training_progress::Preferences, training_store::Controls)>,
    training_recorded: Option<String>,
    training_recorder: training_recording::Recorder,
    training_recording_store: Option<training_recording_store::Service>,
    training_recording_exports: HashMap<u64,(String,u64)>,
    #[cfg(feature="ui-tests")]
    training_recording_prompt_paths: std::collections::VecDeque<Option<std::path::PathBuf>>,
    settings: Entity<settings::SettingsScreen>,
    models: Entity<models::ModelsScreen>,
    model_service: Option<model_service::Service>,
    model_revision: u64,
    model_auto_checked: bool,
    source_service: Option<source_jobs::Service>,
    source_status: Arc<source_jobs::Snapshot>,
    engine_status:Option<engine_status::EngineStatus>,
    engine_status_started:Option<Instant>,
    source_engine_revision:u64,
    engine_setup:Entity<engine_setup::EngineSetup>,
    engine_setup_checker:Option<source_jobs::Service>,
    engine_setup_check:Option<(u64,u64)>,
    engine_setup_session:u64,
    #[cfg(feature="ui-tests")]
    engine_setup_external_urls:Vec<String>,
    source_job: Option<u64>,
    source_saving: bool,
    source_split: Option<source_jobs::Mode>,
    source_split_combined: bool,
    source_combined_next: Option<(u64, u64)>,
    source_cancelling: Option<u64>,
    source_split_handoff: Option<source_jobs::SplitHandoff<(source_jobs::Output, SourceResume)>>,
    source_lyrics_fingerprint: Option<Option<String>>,
    rename_pending: Option<RenamePending>,
    focus_after_title: bool,
    source_working: bool,
    source_target: Option<source_jobs::Target>,
    source_pending: Option<(u64, bool, Option<source_jobs::Target>, Option<SourceResume>, std::path::PathBuf)>,
    log_panel: Entity<log_panel::LogPanel>,
    diagnostics:Option<diagnostics::Service>,
    diagnostics_revision:u64,
    diagnostics_session:u64,

    #[cfg(feature="ui-tests")]
    diagnostics_prompt_paths:std::collections::VecDeque<Option<std::path::PathBuf>>,
    #[cfg(feature="ui-tests")]
    diagnostics_prompt_requests:Vec<Option<String>>,
    _subscriptions: Vec<Subscription>,
    song_title: SharedString,
    song_artist: SharedString,
    glow_textures: Rc<HashMap<&'static str, Arc<RenderImage>>>,
    glow_bands: Rc<HashMap<&'static str, Vec<Arc<RenderImage>>>>,
    frame_stats: Rc<RefCell<FrameStats>>,
    shape_cache: Rc<RefCell<HashMap<ShapeKey, ShapedLine>>>,
    layout_cache: Rc<RefCell<Option<(i32, LyricLayout)>>>,
    lyric_scroll: Rc<Cell<f32>>,
    lyric_scroll_target: Rc<Cell<f32>>,
    lyric_active: Rc<Cell<usize>>,
    lyric_countdown_clock: Rc<RefCell<lyrics_countdown::PulseClock>>,
    lyric_extent: Rc<Cell<f32>>,
    lyric_ai_note_top:Rc<Cell<f32>>,
    lyric_view_height: Rc<Cell<f32>>,
    lyric_horizontal: Rc<Cell<bool>>,
    lyric_scroll_geometry: Rc<Cell<lyric_scroll_geometry::Geometry>>,
    lyric_scroll_handle: ScrollHandle,
    stem_scroll_handle: ScrollHandle,
    lyric_scroll_active: Rc<Cell<bool>>,
    lyric_hits: Rc<RefCell<Vec<(usize, Bounds<Pixels>)>>>,
    playing: bool,
    playhead: transport_timing::Playhead,
    track_name_input: Entity<gpui_kit::component::input::InputState>,
    track_rename: Option<(u64,String)>,

    tracks_audio_failed: bool,
    audio_recovery: Option<audio_recovery_host::PendingRecovery>,
    audio_recovery_serial: u64,
    source_publication: Option<audio_recovery_host::PendingPublication>,
    source_save_seq: u64,
    lane_entered: HashMap<String,Instant>,
    track_focus_removed: Vec<usize>,
    track_focus_after_name: bool,
    track_action_focus: [[FocusHandle;2];tracks::LANE_SLOTS],
    track_mix_focus: [[FocusHandle;2];tracks::LANE_SLOTS],
    track_reset_focus: [FocusHandle;2],
    track_header_focus: [FocusHandle;2],
    track_gain_focus: [FocusHandle;tracks::LANE_SLOTS],
    #[cfg(feature="ui-tests")]
    track_bounds: Rc<RefCell<HashMap<String,Bounds<Pixels>>>>,
    #[cfg(feature="ui-tests")]
    ruler_frame: Rc<ruler_clearance::Frame>,
    #[cfg(feature="ui-tests")]
    empty_picker_paths: std::collections::VecDeque<Vec<std::path::PathBuf>>,
    muted: [bool; tracks::LANE_SLOTS],
    solo: [bool; tracks::LANE_SLOTS],
    gain: [u8; tracks::LANE_SLOTS],
    fade: [f32; tracks::LANE_SLOTS],
    looping: bool,
    region: region_host::State,
    restart_cycle: restart_cycle::RestartCycle,
    view_start: f64,
    view_end: f64,
    timeline: timeline_viewport::Navigation,
    transpose: i32,
    header_drag: Rc<Cell<bool>>,
    focus_handle: FocusHandle,
    previous_focus: Option<FocusHandle>,
    modal_was_open: bool,
    notice_was_open: bool,
    notice_previous_focus: Option<(u64,FocusHandle)>,
    quick_start: Entity<quick_start::QuickStart>,
    whats_new: Entity<whats_new::WhatsNew>,
    release_service: Option<release_highlights::Service>,
    release_startup_ready: bool,
    release_pending: Option<release_highlights::ReleaseNotes>,
    #[cfg(feature = "ui-tests")]
    release_external_urls: Vec<String>,
    #[cfg(feature = "ui-tests")]
    release_unexpected_browse: usize,
    capture_file: Option<std::path::PathBuf>,
    started: Instant,
    last: Instant,
    transport_flight: transport_host::TransportFlight,
    metronome_flight: metronome_host::MetronomeFlight,
    carry_flight: carry_line_host::CarryFlight,
    monitor_flight: monitor_host::MonitorFlight,
    lyrics_flight: lyrics_sidebar_host::LyricsFlight,
    tracks_flight: custom_tracks_host::TracksFlight,
    delete_flight: project_delete_host::DeleteFlight,
    diagnostics_flight: diagnostics_host::DiagnosticsFlight,
    provider_flight: audio_provider_host::ProviderFlight,
}
impl Player {
    fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let diagnostics=(!integration::fixture_mode()).then(||{
            let service=diagnostics::Service::new(diagnostics::Config::native(audio_devices::directory().join("logs"),release_highlights::CURRENT_VERSION));
            diagnostics::install_global_sink(&service.sink());
            diagnostics::event("app","Native desktop started.",diagnostics::Level::Info);
            service
        });
        let track_name_input=cx.new(|cx|gpui_kit::component::input::InputState::new(window,cx));
        let track_name_subscription=cx.subscribe_in(&track_name_input,window,|this,_,event,_,cx|{
            if matches!(event,gpui_kit::component::input::InputEvent::PressEnter{..}|gpui_kit::component::input::InputEvent::Blur){this.commit_track_name(cx);}
        });
        let language_menu=cx.new(|cx|language_menu::LanguageMenu::new(window,cx));
        let language_subscription=cx.subscribe_in(&language_menu,window,|this,_,event,_,cx|{
            if let language_menu::Event::Pick(language)=event {if let Err(error)=this.locale_service.pick(*language){this.notice=Some(error.to_string());}}
            cx.notify();
        });
        let quick_start = cx.new(|cx| quick_start::QuickStart::new(window, cx));
        let guide_anchors = quick_start.read(cx).anchors.clone();
        let quick_subscription = cx.subscribe(&quick_start, |this, _, event, cx| {
            match event {
                quick_start::Event::Target(id) => {
                    if let Some(bounds) = this.quick_start.read(cx).anchors.get(id) {
                        if matches!(*id, "browse" | "saved" | "sync") {
                            this.library.read(cx).reveal_guide(bounds);
                        } else if *id == "stems" {
                            this.stem_scroll_handle.set_offset(point(px(0.), px(0.)));
                        }
                    }
                }
                quick_start::Event::Closed => {}
            }
            cx.notify();
        });
        let whats_new=cx.new(|cx|whats_new::WhatsNew::new(window,cx));
        let release_service=(!integration::fixture_mode()).then(||release_highlights::Service::new(audio_devices::directory()));
        let release_startup_ready=release_service.is_none();
        let release_subscription=cx.subscribe(&whats_new,|this,_,event,cx|{
            match event {
                whats_new::Event::Closed=>{
                    if let Some(service)=&this.release_service {let _=service.acknowledge();}
                    this.whats_new.update(cx,|s,cx|s.close(cx));
                },
                whats_new::Event::External(url)=>{
                    #[cfg(feature="ui-tests")]
                    if std::env::var_os("SINGZ_GPUI_WHATS_NEW_TEST").is_some()
            || std::env::var_os("SINGZ_GPUI_SETTINGS_KEYBOARD_TEST").is_some(){
                        this.release_external_urls.push(url.clone());cx.notify();return;
                    }
                    cx.open_url(url);
                },
            }
            cx.notify();
        });
        let success_toast=cx.new(singz_uikit::Toast::new);
        let engine_setup=cx.new(|cx|engine_setup::EngineSetup::new(window,cx));
        let engine_setup_subscription=cx.subscribe(&engine_setup,|this,_,event,cx|{
            match event {
                engine_setup::Event::Close=>this.close_engine_setup(cx),
                engine_setup::Event::Recheck=>this.recheck_engine_setup(cx),
                engine_setup::Event::GitHub=>{
                    const URL:&str="https://github.com/adefossez/demucs";
                    #[cfg(feature="ui-tests")]
                    if std::env::var_os("SINGZ_GPUI_ENGINE_SETUP_TEST").is_some(){
                        this.engine_setup_external_urls.push(URL.into());cx.notify();return;
                    }
                    cx.open_url(URL);
                },
            }
        });
        let stem_export_dialog=cx.new(|cx|stem_export_dialog::Dialog::new(window,cx));
        let stem_export_subscription=cx.subscribe(&stem_export_dialog,|this,_,event,cx|{
            match event {
                stem_export_dialog::Event::Close=>this.close_stem_export(cx),
                stem_export_dialog::Event::Run{mode,format,selected}=>this.start_stem_export(*mode,*format,selected.clone(),cx),
            }
        });
        let carry_popover=cx.new(|cx|carry_line_popover::Popover::new(window,cx));
        let carry_subscription=cx.subscribe(&carry_popover,|this,_,event,cx|{
            match event {
                carry_line_popover::Event::Change(desired)=>this.change_carry(desired.clone(),cx),
                carry_line_popover::Event::Save=>this.save_project(cx),
                carry_line_popover::Event::Close=>{this.carry_open=false;cx.notify();},
                carry_line_popover::Event::CloseKeyboard=>{this.carry_open=false;this.focus_player=true;cx.notify();},
            }
        });
        let library_import=cx.new(|cx|library_import::ImportDialog::new(window,cx));
        let library_import_subscription=cx.subscribe(&library_import,|this,_,event,cx|{
            match event {
                library_import::Event::Copy=>this.start_library_import(project_import::Mode::Copy,cx),
                library_import::Event::Move=>this.start_library_import(project_import::Mode::Move,cx),
                library_import::Event::Close=>{if this.import_pending.is_none(){this.library_import_open=false;cx.notify();}},
            }
        });
        let project_picker = cx.new(|cx|project_picker::Picker::new(window,cx));
        let project_picker_subscription=cx.subscribe_in(&project_picker,window,|this,_,event,w,cx|{
            match event {
                project_picker::Event::Open(path)=>{this.close_project_picker(cx);this.open_project(path.clone(),cx);},
                project_picker::Event::Browse=>{this.close_project_picker(cx);this.browse(cx);},
                project_picker::Event::Close=>this.close_project_picker(cx),
                project_picker::Event::ChooseRoot=>this.prompt_project_root(cx),
                project_picker::Event::SetRoot(path)=>this.choose_project_root(path.clone(),cx),
                project_picker::Event::Drive(action)=>this.drive_action(*action,cx),
                project_picker::Event::DriveBrowse=>this.open_drive_projects(w,cx),
            }
            cx.notify();
        });
        let drive_projects=cx.new(|cx|drive_projects::Dialog::new(window,cx));
        let drive_projects_subscription=cx.subscribe_in(&drive_projects,window,|this,_,event,w,cx|this.drive_projects_event(event,w,cx));
        let lyrics_sidebar=cx.new(|cx|lyrics_sidebar::Sidebar::new(window,cx));
        let sidebar_subscription=cx.subscribe_in(&lyrics_sidebar,window,|this,_,event,w,cx|{
            use lyrics_sidebar::Event::*;
            match event{
                Search(query)=>this.open_sidebar_search(query.clone(),cx),
                Apply(id)=>this.start_sidebar_lyrics(lyrics_resolution::Intent::Candidate(*id),cx),
                Transcribe=>this.start_sidebar_lyrics(lyrics_resolution::Intent::Transcribe,cx),
                Align=>this.start_sidebar_lyrics(lyrics_resolution::Intent::Align,cx),
                Precise=>this.start_sidebar_lyrics(lyrics_resolution::Intent::Precise,cx),
                Edit=>this.open_lyrics_editor(w,cx),
                Download=>this.download_sidebar_lyrics(cx),
                Retry=>{if let Some(backend)=&this.backend{if let Err(e)=backend.retry_lrclib(){eprintln!("LRCLIB retry: {e}");}}this.start_sidebar_lyrics(this.lyrics_sidebar_intent,cx)},
                Cancel=>this.cancel_sidebar_lyrics(cx),
                Changed=>{},
            }cx.notify();
        });
        let lyrics_editor = cx.new(|cx|lyrics_editor::Editor::new(window,cx));
        let lyrics_editor_subscription = cx.subscribe(&lyrics_editor, |this,_,event,cx|{
            match event {
                lyrics_editor::Event::Save(lines,revision)=>{
                    if !this.lyrics_editor_open||this.loading||this.lyrics_editor_epoch!=this.native_epoch{
                        this.lyrics_editor.update(cx,|s,cx|s.saved(Some("The song changed. Reopen the editor before saving.".into()),cx));return;
                    }
                    if let (Some(backend),Some(project))=(&this.backend,&this.project) {
                        let serial=this.lyrics_flight.lyrics_editor_pending.reserve();
                        let result=serde_json::to_value(lines).map_err(|e|e.to_string()).and_then(|lines|backend.save_lyrics(this.native_epoch,serial,project,lines,this.lyrics_editor_credit.clone()).map_err(|e|e.to_string()));
                        match result {Ok(())=>{this.lyrics_flight.lyrics_editor_pending.activate(this.native_epoch,serial,());this.lyrics_editor_save_revision=*revision;},Err(e)=>this.lyrics_editor.update(cx,|s,cx|s.saved(Some(e),cx))}
                    } else {this.lyrics_editor.update(cx,|s,cx|s.saved(Some("Open a project before saving lyrics.".into()),cx));}
                }
                lyrics_editor::Event::Close=>{this.lyrics_editor_open=false;this.focus_player=true;this.cancel_lyrics_alignment(cx);if let Some(backend)=&this.backend{backend.cancel_lyrics_preview();}},
                lyrics_editor::Event::Play=>{if !this.loading&&this.lyrics_editor_epoch==this.native_epoch{this.native_command(if this.playing{"pause"}else{"play-flat"}.into(),cx);}},
                lyrics_editor::Event::Seek{position,play}=>{
                    if this.loading||this.lyrics_editor_epoch!=this.native_epoch{return;}
                    this.playhead.seek(*position);this.seek_native(cx);if *play&&!this.playing{this.native_command("play-flat".into(),cx);}
                }
                lyrics_editor::Event::Align(precise,download)=>this.start_lyrics_alignment(*precise,*download,cx),
                lyrics_editor::Event::CancelAlign=>this.cancel_lyrics_alignment(cx),
            }
            cx.notify();
        });
        let metronome_ui = cx.new(|cx| metronome::MetPopover::new(window, cx));
        let beat_cache = Rc::new(RefCell::new(beat_grid::Cache::default()));
        let beat_handles = cx.new(|_| beat_grid::Handles::new(beat_cache.clone()));
        let beat_handle_subscription = cx.subscribe(&beat_handles, |this, _, event, cx| {
            let grid = match event {
                beat_grid::Event::Move { from, to } => this.beats.as_ref().map(|g| g.set_user_bar(*to, Some(*from))),
                beat_grid::Event::Clear { time } => this.beats.as_ref().map(|g| g.clear_user_bar(*time)),
                beat_grid::Event::Preview => {cx.notify();return;}
            };
            if let Some(grid) = grid {this.apply_beat_grid(grid, true, cx);}
        });
        let metronome_subscription = cx.subscribe(&metronome_ui, |this, _, event, cx| {
            match event {
                metronome::Event::Change(met, grid) => {
                    if grid != &this.beats && grid.as_ref().is_some_and(|g|g.source != "auto") {
                        this.beat_mutation += 1;
                        this.beat_job = None;
                        this.beat_result = None;
                        if let Some(backend) = &this.backend {backend.cancel_beat_detection();}
                    }
                    this.apply_metronome(met.clone(), grid.clone(), cx)
                }
                metronome::Event::Redetect => this.start_beat_detection(true, cx),
                metronome::Event::Preview(accent) => {
                    if this.backend.is_some() && !this.monitor_flight.monitor_requested && this.project.is_some() {
                        this.native_command(format!("met-preview {}", u8::from(*accent)), cx);
                    }
                }
                metronome::Event::FocusPlayer => this.focus_player = true,
                metronome::Event::Close => {
                    this.metronome_open = false;
                    this.focus_player = true;
                }
            }
            cx.notify();
        });
        let pitch_strip = cx.new(|cx| pitch_strip::PitchStrip::new(64., cx));
        let transport = cx.new(|cx| transport::Transport::new(window, cx));
        let pitch_subscription =
            cx.subscribe(&pitch_strip, |this, _, event: &pitch_strip::PitchEvent, cx| {
                match event {
                    pitch_strip::PitchEvent::Viewport(input) => this.timeline_input(*input,cx),
                    pitch_strip::PitchEvent::ToggleMic if this.microphone.is_some() => {
                        this.mic_requested = !(this.mic_requested && this.mic_view.phase == microphone::Phase::Live);
                        this.mic_serial += 1;cx.notify();
                    }
                    _ => {},
                }
            });
        let header = cx.new(|cx| header::Header::new(window, cx));
        let library = cx.new(|cx| library::LibraryScreen::new(window, cx));
        let project_delete = cx.new(|cx| project_delete_dialog::DeleteDialog::new(window,cx));
        let delete_subscription = cx.subscribe(&project_delete,|this,_,event,cx|match event {
            project_delete_dialog::Event::Keep => this.close_project_delete(cx),
            project_delete_dialog::Event::Confirm => this.confirm_project_delete(cx),
        });
        header.update(cx, |h, _| h.guides = guide_anchors.clone());
        transport.update(cx, |t, _| t.guides = guide_anchors.clone());
        library.update(cx, |l, _| l.guides = guide_anchors.clone());
        let training = cx.new(|cx| training::TrainingScreen::new(window, cx));
        let training_subscription = cx.subscribe(&training, |this, _, event, cx| match event {
            training::TrainingEvent::BackToSong => {
                let valid = this
                    .training
                    .read(cx)
                    .preparation_matches(this.project.as_ref().map(|_| this.native_epoch));
                this.stop_training(cx);
                this.training.update(cx, |s, cx| s.end_run(cx));
                if valid && this.project.is_some() {
                    this.screen = Screen::Player;
                    this.playing = false;
                    this.focus_player = true;
                }
            }
            training::TrainingEvent::RetrySave => {
                if let Some(store) = &this.training_store {
                    store.retry();
                }
            }
            training::TrainingEvent::Start => this.start_practice(None, cx),
            training::TrainingEvent::RecordSample => this.start_training_recording(cx),
            training::TrainingEvent::FinishRecording => this.finish_training_recording(cx),
            training::TrainingEvent::SaveRecording => this.save_training_recording(cx),
            training::TrainingEvent::Restart => {
                let config = this.practice.as_ref().map(|r| r.session.config().clone());
                this.start_practice(config, cx);
            }
            training::TrainingEvent::Continue => {
                this.continue_practice(cx);
            }
            training::TrainingEvent::Replay => {
                this.cancel_training_cue(cx);
                if let Some(run) = &mut this.practice {
                    run.replay();
                }
                this.practice_reached = None;
            }
            training::TrainingEvent::Skip => {
                this.cancel_training_cue(cx);
                if let Some(run) = &mut this.practice {
                    if let Err(e) = run.skip() {
                        run.fail(e.to_string());
                    }
                }
            }
            training::TrainingEvent::Answer(answer) => {
                if let Some(run) = &mut this.practice {
                    if let Err(e) = run.answer(answer.clone()) {
                        run.fail(e.to_string());
                    }
                }
            }
            training::TrainingEvent::End => {
                this.stop_training(cx);
                this.training.update(cx, |s, cx| s.end_run(cx));
            }
            training::TrainingEvent::Test { sound, volume } => {
                this.test_training(*sound, *volume, cx)
            }
            training::TrainingEvent::Stop => this.stop_training(cx),
            training::TrainingEvent::Volume(gain) => {
                if let (Some(backend), Some(generation)) = (&this.backend, this.training_test) {
                    if let Err(error) =
                        backend.control(this.native_epoch, format!("cue-gain {generation} {gain}"))
                    {
                        this.notice = Some(error.to_string());
                    }
                }
            }
        });
        let settings = cx.new(|cx| settings::SettingsScreen::new(window, cx));
        let models = cx.new(|cx| models::ModelsScreen::new(cx));
        let models_subscription = cx.subscribe(&models, |this, _, event, cx| {
            match event {
                models::Event::Close => this.close_models(cx),
                models::Event::Download(ids) => {
                    this.models.update(cx, |m, _| m.requested(ids.clone()));
                    let result = this
                        .model_service
                        .as_ref()
                        .ok_or_else(|| {
                            anyhow::anyhow!("Model downloads are unavailable in the review fixture")
                        })
                        .and_then(|s| s.download(ids.clone()));
                    if let Err(error) = result {
                        this.models
                            .update(cx, |m, cx| m.failure(error.to_string(), cx));
                    }
                }
                models::Event::Mode(cpu) => {
                    if let Some(service) = &this.model_service {
                        if let Err(error) = service.mode(*cpu) {
                            this.models
                                .update(cx, |m, cx| m.failure(error.to_string(), cx));
                        }
                    }
                }
            }
            cx.notify();
        });
        let log_panel = cx.new(|_| log_panel::LogPanel::new());
        let log_subscription = cx.subscribe(&log_panel, |this, _, event, cx| {
            match event {
                log_panel::LogEvent::Close => this.close_diagnostics(cx),
                log_panel::LogEvent::Save(selected) => this.save_diagnostics(selected.clone(),cx),
                log_panel::LogEvent::Select(selected)=>this.select_diagnostics(selected.clone(),cx),
            }
            cx.notify();
        });
        let library_subscription = cx.subscribe_in(&library,window, |this, _, event, w, cx| match event {
            library::LibraryEvent::Drive(action)=>this.drive_action(*action,cx),
            library::LibraryEvent::DriveBrowse=>this.open_drive_projects(w,cx),
            library::LibraryEvent::OpenProject(path) => this.open_project(path.clone(), cx),
            library::LibraryEvent::OpenSong { title, artist } => {
                this.loaded_song = true;
                this.library.update(cx, |library,cx| library.set_open_song(Some(title.clone()),cx));
                this.song_title = title.clone();
                this.song_artist = artist.clone();
                this.playhead.seek(0.);
                this.view_start=0.;this.view_end=1.;this.timeline.reset();
                this.started = Instant::now();
                this.playing = false;
                this.screen = Screen::Player;
                this.last = Instant::now();
                cx.notify();
            }
            library::LibraryEvent::Browse if this.backend.is_some() => this.browse(cx),
            library::LibraryEvent::Browse => { this.notice = Some("Choose a catalog card to preview the player. File loading is not connected in this prototype.".into()); cx.notify(); }
            library::LibraryEvent::ManageStorage if this.backend.is_some() => this.open_project_picker(cx),
            library::LibraryEvent::ManageStorage => { this.notice = Some("Projects are shown from the review fixture. Storage changes are not connected in this prototype.".into()); cx.notify(); }
            library::LibraryEvent::DeleteProject(dir) => this.begin_project_delete(dir.clone(),cx),
            library::LibraryEvent::DeleteSong { title } => { this.notice = Some(format!("{title} is a review fixture. No project has been deleted.")); cx.notify(); }
        });
        let settings_subscription = cx.subscribe(&settings, |this, _, event, cx| {
            match event {
                settings::SettingsEvent::InputPrefs(prefs) => {
                    let mut prefs = prefs.clone();
                    let old = &this.mic_prefs;
                    if prefs.input != old.input
                        || prefs.channel != old.channel
                        || prefs.monitor_output != old.monitor_output
                        || prefs.outputs != old.outputs
                    {
                        prefs.headphones = false;
                        this.monitor_flight.monitor_requested = false;
                    }
                    if !prefs.headphones {
                        this.monitor_flight.monitor_requested = false;
                    }
                    this.mic_pref_seq += 1;
                    this.mic_prefs = prefs.clone();
                    this.mic_prefs_valid = true;
                    this.mic_pref_error = None;
                    this.settings.update(cx, |settings, cx| {
                        settings.set_input_prefs(prefs.clone(), cx)
                    });
                    if let Some(backend) = &this.backend {
                        if let Err(error) = backend.input_prefs(this.mic_pref_seq, prefs) {
                            this.notice = Some(error.to_string());
                        }
                    }
                }
                settings::SettingsEvent::EnableMicrophone => {
                    this.mic_permission_requested = true;
                    this.mic_serial += 1;
                }
                settings::SettingsEvent::Monitor => {
                    if this.provider_flight.audio_provider.is_some() {return;}
                    if this.monitor_busy() {
                        this.monitor_flight.monitor_requested = false;
                    } else if !this.loading && !this.rate_busy() && this.mic_prefs_valid {
                        match this.settings.read(cx).monitor_route() {
                            Ok(()) => {
                                this.monitor_flight.monitor_requested = true;
                                this.mic_serial += 1;
                            }
                            Err(error) => this
                                .settings
                                .update(cx, |s, cx| s.set_monitor_state(false, Some(error), cx)),
                        }
                    }
                }
                settings::SettingsEvent::Output(uid) => this.select_output(uid.clone(), cx),
                settings::SettingsEvent::Provider(provider) => this.select_audio_provider(*provider, cx),
                settings::SettingsEvent::Close => this.screen = this.previous_screen,
                settings::SettingsEvent::QuickStart => {
                    this.screen = this.previous_screen;
                    this.open_quick_start(false, cx);
                }
            }
            this.sync_audio_provider(cx);
            this.last = Instant::now();
            cx.notify();
        });
        let header_subscription = cx.subscribe_in(&header, window, |this,_,event,window,cx| {
            if this.project_delete.read(cx).is_open() { return; }
            this.cancel_delete_inspection();
            if !matches!(event,header::HeaderEvent::Language){this.language_menu.update(cx,|s,cx|s.close(window,cx));}
            match event {
                header::HeaderEvent::StopMonitor=>{
                    this.monitor_flight.monitor_requested=false;this.mic_prefs.headphones=false;
                    this.settings.update(cx,|s,cx|s.set_input_prefs(this.mic_prefs.clone(),cx));
                    if this.screen==Screen::Player{this.focus_player=true;}
                },
                header::HeaderEvent::TitleClosed => this.focus_after_title=true,
                header::HeaderEvent::Rename(name) => this.rename_title(name.clone(), cx),
                header::HeaderEvent::Songs => {
                    if this.screen==Screen::Training && (this.songs_catalog||!this.loaded_song) {
                        this.enter_desktop_catalog(cx);
                    } else {
                        if this.project.is_some() {this.native_command("pause".into(),cx);}
                        if this.backend.is_none() {this.playing=false;}
                        if this.screen==Screen::Training {this.screen=Screen::Player;}
                    }
                }
                header::HeaderEvent::Catalog => {
                    if this.loaded_song {
                        let opening=this.screen!=Screen::Library;
                        if opening {
                            this.enter_desktop_catalog(cx);
                        } else {
                            this.songs_catalog=false;
                            this.screen=Screen::Player;
                        }
                    }
                }
                header::HeaderEvent::Settings => this.toggle_desktop_settings(window,cx),
                header::HeaderEvent::Training => {if this.screen!=Screen::Training{this.songs_catalog=this.screen==Screen::Library;}this.restart_cycle.observe_component(false);this.transport.update(cx,|transport,cx|transport.set_output_mounted(false,this.master_volume,cx));this.training.update(cx,|training,cx|training.on_open(cx));this.screen=Screen::Training;if this.project.is_some()||this.playing{this.native_command("pause".into(),cx);}},
                header::HeaderEvent::Log => this.open_diagnostics(cx),
                header::HeaderEvent::Engine => {
                    if this.engine_status.as_ref().is_some_and(|s|!s.ok&&!s.needs_models){this.open_engine_setup(cx);}
                    else{this.open_models(models::Origin::Manual,cx);}
                },
                header::HeaderEvent::Language => this.open_language_menu(window,cx),
                header::HeaderEvent::Help => this.open_quick_start(false,cx),
                header::HeaderEvent::WhatsNew=>this.open_release_highlights(cx),
                header::HeaderEvent::Save if this.backend.is_some() => this.save_project(cx),
                header::HeaderEvent::Save => this.notice=Some("Mix changes remain local to this prototype.".into()),
                header::HeaderEvent::AddToLibrary if this.backend.is_some()=>this.open_library_import(cx),
                header::HeaderEvent::AddToLibrary => this.notice=Some("The review fixture stays in place. Library import is not connected in this prototype.".into()),
                header::HeaderEvent::Projects if this.backend.is_some() => this.open_project_picker(cx),
                header::HeaderEvent::Projects => this.notice=Some("Open a song from the catalog to preview it.".into()),
            }
            if this.screen!=Screen::Training{this.pause_practice(cx);}
            this.last=Instant::now(); cx.notify();
        });
        let transport_subscription = cx.subscribe_in(&transport, window, |this, _, event, window, cx| {
            use transport::TransportEvent::*;
            if matches!(*event,BpmClosed){this.focus_handle.focus(window,cx);this.focus_player=false;cx.notify();return;}
            if matches!(*event,CarryLine){this.toggle_carry_popover(cx);return;}
            if matches!(*event, Metronome) {
                if this.loaded_song && this.audio_available()
                    && this.screen == Screen::Player
                    && !this.loading
                    && !this.source_blocks_player()
                {
                    this.carry_open=false;
                    this.metronome_open = !this.metronome_open;
                if this.metronome_open {
                        this.metronome_ui.update(cx, |s, cx| s.reset_taps(cx));
                        this.transport.update(cx, |t, cx| {
                            t.dismiss_popovers(cx);
                        });
                        this.restore_metronome_widget(cx);
                    }
                    cx.notify();
                }
                return;
            }

            if this.backend.is_some() {
                this.native_transport(*event, cx);
                return;
            }
            match *event {
                Play => this.toggle(cx),
                Restart => this.playhead.seek(0.),
                Loop => this.looping = !this.looping,
                Transpose(value) => this.transpose = value,
                Karaoke => {
                    this.karaoke = !this.karaoke;
                    this.muted[0] = this.karaoke;
                    this.lyric_horizontal.set(false);
                    this.lyric_scroll_geometry.set(Default::default());
                    this.lyric_active.set(usize::MAX);
                    this.lyric_scroll.set(0.);
                    this.lyric_scroll_target.set(0.);
                    this.lyric_scroll_handle.set_offset(point(px(0.), px(0.)));
                }
                Tempo(value) => this.tempo = value,
                Volume(value) => this.master_volume = value,
                Metronome | BpmClosed => unreachable!(),
                CarryLine => {
                    this.notice =
                        Some("Line continuation is not connected in this prototype.".into())
                }
                StemFiles => {
                    this.notice = Some("Stem files are supplied by the review fixture.".into())
                }
                CancelSplit => {}
                Split(_) => {
                    this.notice = Some(
                        "Model inference is available in the native app, outside demo mode.".into(),
                    )
                }
            }
            cx.notify();
        });
        let focus_handle = cx.focus_handle();
        focus_handle.focus(window, cx);
        let quit_subscription = cx.on_app_quit(|this, cx| {
            this.retain_source_edits();
            this.shutdown_desktop(cx);
            if let Some((_, _, _, _, path)) = this.source_pending.take() { source_jobs::discard_working_copy(&path); }
            if this.source_working { if let Some(project) = &this.project { source_jobs::discard_working_copy(&project.dir); } }
            if let Some(output) = this.source_status.result.as_ref().filter(|output| output.working) { source_jobs::discard_working_copy(&output.path); }
            std::future::ready(())
        });
        let desktop_release_subscription = cx.on_release(|this, cx| {
            this.retain_source_edits();
            this.shutdown_desktop(cx);
            if let Some((_, _, _, _, path)) = this.source_pending.take() { source_jobs::discard_working_copy(&path); }
            if this.source_working { if let Some(project) = &this.project { source_jobs::discard_working_copy(&project.dir); } }
            if let Some(output) = this.source_status.result.as_ref().filter(|output| output.working) { source_jobs::discard_working_copy(&output.path); }
        });
        let wake_player=cx.weak_entity();
        let system_wake_subscription=cx.on_system_wake(move |cx| {
            let _=wake_player.update(cx, |player,cx| player.desktop_woke(cx));
        });
        let bounds_subscription = cx.observe_window_bounds(window, |this, window, cx| {
            if let Some(store) = &mut this.desktop_window_state {
                desktop_lifecycle::observe(store, window, cx);
            }
        });
        let backend = (!integration::fixture_mode())
            .then(|| integration::Backend::new(cx.text_system().clone()));
        let stem_export_service=backend.as_ref().map(|_|stem_export::Service::new(
            gated_env!("SINGZ_GPUI_AUDIO_HELPER").map(std::path::PathBuf::from)
                .unwrap_or_else(||std::env::current_exe().unwrap_or_default().with_file_name(if cfg!(windows){"singz-gpui-audio.exe"}else{"singz-gpui-audio"}))));
        let microphone = backend.as_ref().map(|_| microphone::Service::new());
        let training_store = backend.as_ref().map(|_| training_store::Service::new());
        let training_recording_store = backend.as_ref().map(|_| training_recording_store::Service::new(audio_devices::directory().join("training-recordings")));
        let model_service = backend.as_ref().map(|_| model_service::Service::new());
        let source_service = backend.as_ref().map(|_| source_jobs::Service::new());
        let project_library_service=backend.as_ref().map(|_|project_library::Service::new(project_library::Config::default()));
        let drive_service=backend.as_ref().map(|_|drive_service::Service::new(audio_devices::directory(),integration::library_root()));
        let drive_restore_service=backend.as_ref().map(|_|drive_restore_service::Service::new(audio_devices::directory()));
        if let Some(backend) = &backend {
            backend.catalog();
            backend.inventory();
        }
        if backend.is_some() {
            cx.spawn(async move |this, cx| {
                loop {
                    cx.background_executor()
                        .timer(std::time::Duration::from_millis(16))
                        .await;
                    if this.update(cx, |this, cx| this.poll_backend(cx)).is_err() {
                        break;
                    }
                }
            })
            .detach();
            let mut args = desktop_lifecycle::startup_args();
            while let Some(arg) = args.next() {
                if arg == "--project" {
                    if let Some(path) = args.next() {
                        cx.spawn(async move |this, cx| {
                            let _ = this.update(cx, |this, cx| this.open_source(path.into(), cx));
                        })
                        .detach();
                    }
                    break;
                }
            }
        }
        Self {
            transport_flight: Default::default(),
            metronome_flight: Default::default(),
            carry_flight: Default::default(),
            monitor_flight: Default::default(),
            lyrics_flight: Default::default(),
            tracks_flight: Default::default(),
            delete_flight: Default::default(),
            diagnostics_flight: Default::default(),
            provider_flight: Default::default(),
            desktop_shutdown_done:false,desktop_window_state:None,
            locale_service:locale_service::Service::new(audio_devices::directory()),locale_revision:0,language_state:None,language_menu,
            drive_service,drive_snapshot:Default::default(),drive_root_waiting:None,
            drive_restore_service,drive_restore_snapshot:Default::default(),drive_projects,drive_projects_open:false,
            #[cfg(feature="ui-tests")]
            drive_test_urls:vec![],
            #[cfg(feature="ui-tests")]
            stem_export_picker_paths:Default::default(),
            #[cfg(feature="ui-tests")]
            stem_export_finished_ids:vec![],
            stem_export_dialog,stem_export_service,stem_export_open:false,stem_export_lanes:vec![],stem_export_session:0,stem_export_prompt:false,stem_export_close_pending:false,stem_export_job:None,
            native_carry_revision:0,carry:Default::default(),carry_open:false,carry_popover,carry_document:None,carry_mask:None,
            success_toast,library_import,library_import_open:false,library_import_root:None,library_import_epoch:0,import_pending:None,
            project_picker,project_picker_open:false,project_picker_session:0,project_picker_prompt_serial:0,project_picker_prompt:None,project_library_service,project_library_pending:None,project_library_moving:false,project_library_snapshot:None,catalog_root:integration::library_root(),
            project_delete,delete_target:None,
            microphone,
            mic_prefs: Default::default(),
            mic_prefs_valid: false,
            mic_pref_seq: 0,
            mic_pref_error: None,
            mic_view: Default::default(),
            mic_requested: false,
            mic_permission_requested: false,
            mic_serial: 0,
            mic_intent: None,






            native_graph: 0,
            native_lane_revision: 0,
            #[cfg(feature="ui-tests")]
            last_playback_status: None,
            #[cfg(feature="ui-tests")]
            loading_play_refusals: 0,
            #[cfg(feature="ui-tests")]
            source_resume_probe: None,
            #[cfg(feature="ui-tests")]
            source_seek_receipt: None,
            #[cfg(feature="ui-tests")]
            source_publication_fault: None,
            #[cfg(feature="ui-tests")]
            notice_close_bounds: Default::default(),
            lyric_document: Arc::new(project_lyrics::fixture()),
            lyrics_sidebar,
            lyrics_sidebar_intent:lyrics_resolution::Intent::Auto,lyrics_sidebar_job:lyrics_resolution::Intent::Auto,lyrics_sidebar_next:None,lyrics_sidebar_editor_after:false,lyrics_sidebar_import_after:None,lyrics_sidebar_rename_after:None,lyrics_sidebar_needs:vec![],lyrics_sidebar_download:None,
            lyrics_sidebar_download_waiting:false,lyrics_sidebar_download_started:false,lyrics_sidebar_download_epoch:0,
            #[cfg(feature="ui-tests")]
            lyrics_sidebar_settled:vec![],
            lyrics_editor,
            lyrics_editor_open:false,

            lyrics_editor_generation:0,
            lyrics_editor_epoch:0,

            lyrics_editor_save_revision:0,
            lyrics_editor_credit:None,
            lyrics_edit_bounds:Default::default(),
            lyrics_precise_cap:false,


            lyrics_needs:vec![],
            lyrics_download_service:None,

            lyrics_download_started:false,
            lyrics_envelope_cache:None,
            native_glows: Rc::new(RefCell::new(project_lyrics::GlowCache::default())),
            edit_seq: 0,
            saved_seq: 0,
            saving: false,
            focus_player: false,
            native_rate: 1.,
            backend,
            audio_provider: None,


            native_epoch: 0,
            practice: None,
            practice_reached: None,
            training_serial: 0,
            training_test: None,
            training_last: None,
            training_stopped: 0,
            project: None,
            loading: false,
            duration: DURATION,
            screen: if gated_env!("SINGZ_GPUI_PROFILE").is_some() {
                Screen::Player
            } else {
                Screen::Library
            },
            #[cfg(feature = "ui-tests")]
            text_phase_check: false,
            loaded_song: gated_env!("SINGZ_GPUI_PROFILE").is_some(),
            notice: None,
            previous_screen: Screen::Library,
            songs_catalog: true,
            header,
            backdrop: Default::default(),
            backdrop_clock: Default::default(),
            background: background::Background::new(),
            transport,
            pitch_strip,
            karaoke: integration::fixture_mode(),
            karaoke_preferred: false,
            karaoke_pref_seq: 0,
            karaoke_pref_saved_seq: 0,
            tempo: 1.,
            paint_beats: None,
            beat_cache,
            beat_handles,
            beat_job_serial: 0,
            beat_mutation: 0,
            beat_job: None,
            beat_progress: 0.02,
            beat_result: None,
            beat_auto_serials: Default::default(),
            beat_auto_save: false,
            metronome_ui,
            metronome_open: false,
            metronome: Default::default(),
            beats: None,





            met_prefs_ready: false,






            analysis_progress: None,
            analysis_job: None,









            #[cfg(feature = "ui-tests")]
            timing_analysis_override: None,
            master_volume: 1.,
            library,
            training,
            training_store,
            training_store_revision: 0,
            training_profile_sent: None,
            training_recorded: None,
            training_recorder: Default::default(),
            training_recording_store,
            training_recording_exports: HashMap::new(),
            #[cfg(feature="ui-tests")]
            training_recording_prompt_paths: Default::default(),
            settings,
            models,
            model_service,
            model_revision: 0,
            model_auto_checked: false,
            source_service,
            engine_status:None,engine_status_started:None,source_engine_revision:0,engine_setup,engine_setup_checker:None,engine_setup_check:None,engine_setup_session:0,
            #[cfg(feature="ui-tests")]
            engine_setup_external_urls:vec![],
            source_status: Default::default(),
            source_job: None,
            source_saving: false,
            source_split: None,
            source_split_combined: false,
            source_combined_next: None,
            source_cancelling: None,
            source_split_handoff: None,
            source_lyrics_fingerprint: None,
            rename_pending: None,
            focus_after_title: false,
            source_working: false,
            source_target: None,
            source_pending: None,
            log_panel,
            diagnostics,diagnostics_revision:0,diagnostics_session:0,
            #[cfg(feature="ui-tests")]
            diagnostics_prompt_paths:Default::default(),
            #[cfg(feature="ui-tests")]
            diagnostics_prompt_requests:vec![],
            _subscriptions: vec![
                language_subscription,
                engine_setup_subscription,
                track_name_subscription,
                quick_subscription,
                release_subscription,
                metronome_subscription,
                lyrics_editor_subscription,
                sidebar_subscription,
                project_picker_subscription,
                drive_projects_subscription,
                stem_export_subscription,
                carry_subscription,
                library_import_subscription,
                beat_handle_subscription,
                training_subscription,
                quit_subscription,
                desktop_release_subscription,
                system_wake_subscription,
                bounds_subscription,
                pitch_subscription,
                library_subscription,
                settings_subscription,
                log_subscription,
                models_subscription,
                header_subscription,
                delete_subscription,
                transport_subscription,
            ],
            song_title: "Room to breathe".into(),
            song_artist: "Demo session".into(),
            glow_textures: Rc::new(lyric_glow::load()),
            glow_bands: Rc::new(lyric_glow::load_bands()),
            frame_stats: Rc::new(RefCell::new(FrameStats::default())),
            shape_cache: Rc::new(RefCell::new(HashMap::new())),
            layout_cache: Rc::new(RefCell::new(None)),
            lyric_scroll: Rc::new(Cell::new(0.)),
            lyric_scroll_target: Rc::new(Cell::new(0.)),
            lyric_active: Rc::new(Cell::new(usize::MAX)),
            lyric_countdown_clock: Rc::new(RefCell::new(lyrics_countdown::PulseClock::default())),
            lyric_extent: Rc::new(Cell::new(1280.)),
            lyric_ai_note_top:Rc::new(Cell::new(-1.)),
            lyric_view_height: Rc::new(Cell::new(0.)),
            lyric_horizontal: Rc::new(Cell::new(false)),
            lyric_scroll_geometry: Rc::new(Cell::new(Default::default())),
            lyric_scroll_handle: ScrollHandle::new(),
            stem_scroll_handle: ScrollHandle::new(),
            lyric_scroll_active: Rc::new(Cell::new(false)),
            lyric_hits: Rc::new(RefCell::new(vec![])),
            playing: gated_env!("SINGZ_GPUI_PROFILE").is_some(),
            playhead: transport_timing::Playhead::new(64.),
            track_name_input,
            track_rename: None,


            tracks_audio_failed: false,
            audio_recovery: None,
            audio_recovery_serial: 0,
            source_publication: None,
            source_save_seq: 0,
            lane_entered: HashMap::new(),
            track_focus_removed: vec![],
            track_focus_after_name: false,
            track_action_focus: std::array::from_fn(|_|std::array::from_fn(|_|cx.focus_handle())),
            track_mix_focus: std::array::from_fn(|_|std::array::from_fn(|_|cx.focus_handle().tab_stop(true))),
            track_reset_focus: std::array::from_fn(|_|cx.focus_handle().tab_stop(true)),
            track_header_focus: std::array::from_fn(|_|cx.focus_handle().tab_stop(true)),
            track_gain_focus: std::array::from_fn(|_|cx.focus_handle().tab_stop(true)),
            #[cfg(feature="ui-tests")]
            track_bounds: Default::default(),
            #[cfg(feature="ui-tests")]
            ruler_frame: Default::default(),
            #[cfg(feature="ui-tests")]
            empty_picker_paths: Default::default(),
            muted: [false; tracks::LANE_SLOTS],
            solo: [false; tracks::LANE_SLOTS],
            gain: [80; tracks::LANE_SLOTS],
            fade: [1.; tracks::LANE_SLOTS],
            looping: false,
            region: region_host::State::default(),
            restart_cycle: restart_cycle::RestartCycle::default(),
            view_start: 0.,
            view_end: 1.,
            timeline: timeline_viewport::Navigation::default(),
            transpose: 0,
            header_drag: Rc::new(Cell::new(false)),
            focus_handle,
            previous_focus: None,
            modal_was_open: false,
            notice_was_open: false,
            notice_previous_focus: None,
            quick_start,
            whats_new,release_service,release_startup_ready,release_pending:None,
            #[cfg(feature="ui-tests")]
            release_external_urls:vec![],
            #[cfg(feature="ui-tests")]
            release_unexpected_browse:0,
            capture_file: gated_env!("SINGZ_GPUI_CAPTURE_FILE").map(Into::into),
            started: Instant::now(),
            last: Instant::now(),
        }
    }
    fn release_surface_available(&self,cx:&App)->bool {
        if self.project_delete.read(cx).is_open() || self.delete_flight.delete_inspect.is_some() { return false; }
        !self.engine_setup.read(cx).is_open() && !matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models)
            && self.notice.is_none() && !self.lyrics_editor_open && !self.project_picker_open && !self.drive_projects_open
            && !self.library_import_open && !self.stem_export_open && !self.loading
            && !(self.source_job.is_some() && self.source_split.is_none())
            && !self.quick_start.read(cx).is_open()
    }
    fn open_release_highlights(&mut self,cx:&mut Context<Self>){
        if !self.release_surface_available(cx){return;}
        if let Some(notes)=release_highlights::notes(release_highlights::CURRENT_VERSION,None,i18n::current().as_str()) {
            self.release_startup_ready=true;self.release_pending=None;
            self.metronome_open=false;
            self.header.update(cx,|h,cx|h.cancel_title(cx));
            self.transport.update(cx,|t,cx|t.dismiss_popovers(cx));
            self.whats_new.update(cx,|s,cx|s.open(notes,cx));
        }
        cx.notify();
    }
    fn poll_release_highlights(&mut self,cx:&mut Context<Self>){
        if !self.release_startup_ready {
            if let Some(service)=&self.release_service {
                let snapshot=service.snapshot();
                if snapshot.loaded {
                    self.release_startup_ready=true;
                    let mut automatic=!cfg!(debug_assertions);
                    #[cfg(feature="ui-tests")]
                    {automatic|=std::env::var_os("SINGZ_GPUI_RELEASE_AUTOMATIC").is_some();}
                    if automatic && snapshot.error.is_none(){
                        self.release_pending=release_highlights::notes(release_highlights::CURRENT_VERSION,snapshot.state.seen.as_deref(),i18n::current().as_str());
                    }
                }
            }
        }
        if self.model_auto_checked && self.release_surface_available(cx) && !self.whats_new.read(cx).is_open() {
            if let Some(notes)=self.release_pending.take(){
                self.metronome_open=false;
                self.header.update(cx,|h,cx|h.cancel_title(cx));
                self.transport.update(cx,|t,cx|t.dismiss_popovers(cx));
                self.whats_new.update(cx,|s,cx|s.open(notes,cx));cx.notify();
            }
        }
    }
    fn open_quick_start(&mut self, welcome: bool, cx: &mut Context<Self>) {
        if self.whats_new.read(cx).is_open()||self.engine_setup.read(cx).is_open(){return;}
        self.metronome_open = false;
        self.header.update(cx, |h, cx| h.cancel_title(cx));
        self.transport.update(cx, |t, cx| {
            t.dismiss_popovers(cx);
        });
        let targets = match self.screen {
            Screen::Library => {
                let mut ids = vec!["browse", "saved", "training"];
                if self.library.read(cx).sync_guide_available() {
                    ids.push("sync");
                }
                ids.push("settings");
                ids
            }
            Screen::Player => {
                let mut ids = vec![];
                if self.source_split.is_none() {
                    ids.push("split");
                }
                ids.push("stems");
                if self.karaoke {
                    ids.push("lyrics");
                }
                if self.source_split.is_none() {
                    ids.push("karaoke");
                }
                ids.extend(["loop", "tempo", "training", "settings"]);
                ids
            }
            _ => vec!["training", "settings"],
        };
        self.quick_start
            .update(cx, |g, cx| g.open(welcome, &targets, cx));
        cx.notify();
    }
    fn start_source(&mut self, job: source_jobs::Job, cx: &mut Context<Self>) {
        // A newer Open supersedes a pending split load immediately. Restoring
        // its original epoch first prevents the old load from being adopted
        // while the new source's private decode is still running.
        if matches!(&job, source_jobs::Job::Open(_)) && self.source_split_loading() {
            self.cancel_source(cx);
        }
        let combined = matches!(&job, source_jobs::Job::RefreshLyrics { .. }) && self.source_split_combined;
        let saving=matches!(&job,source_jobs::Job::Save{..});
        self.pause_practice(cx);
        let split = match &job {
            source_jobs::Job::Split { mode, .. } => Some(*mode),
            source_jobs::Job::RefreshLyrics { .. } => self.source_split,
            _ => None,
        };
        // A storage-only Save must leave the independent monitor lease alone.
        // Its playback graph is already parked, or is being parked by that
        // handoff. Publication restoration waits for an explicit monitor Stop.
        if split.is_none() && self.project.is_some() && !(saving && self.monitor_busy()) {
            self.native_command("pause".into(), cx);
        }
        if let Some(service) = &self.source_service {
            match service.start(job) {
                Ok(id) => {
                    self.source_lyrics_fingerprint = self.project.as_ref().map(|p|p.lyrics_fingerprint.clone());
                    self.source_job = Some(id);
                    self.source_saving=saving;
                    if saving { self.source_save_seq=self.edit_seq; }
                    self.source_split = split;
                    self.source_split_combined = combined;
                    self.source_combined_next = None;
                    self.source_cancelling = None;
                    self.source_split_handoff = None;
                    self.notice = None;
                    self.source_status = Arc::new(source_jobs::Snapshot {
                        generation: id,
                        label: "Preparing…".into(),
                        busy: true,
                        ready: self.source_status.ready,
                        ..Default::default()
                    });
                }
                Err(e) => self.notice = Some(e.to_string()),
            }
        }
        cx.notify();
    }
    fn open_source(&mut self, path: std::path::PathBuf, cx: &mut Context<Self>) {
        if self.defer_rate_navigation(path.clone(),true,cx){return;}
        if self.defer_carry_navigation(path.clone(),true,cx){return;}
        if self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some() { return; }
        if self.defer_metronome_navigation(path.clone(), true, cx) {
            return;
        }
        self.cancel_delete_inspection();
        self.reset_carry(cx);
        self.detach_stem_export(cx);
        self.library_import_open=false;self.import_pending=None;
        self.cancel_sidebar_lyrics(cx);self.lyrics_sidebar_editor_after=false;self.lyrics_sidebar_import_after=None;self.lyrics_sidebar_rename_after=None;
        self.lyrics_flight.lyrics_search_pending.cancel();if let Some(backend)=&self.backend{backend.cancel_lyrics_search();}
        self.cancel_lyrics_alignment(cx);self.lyrics_editor_open=false;
        self.reset_transport_timing(cx);
        self.start_source(source_jobs::Job::Open(path), cx);
    }
    fn source_split_loading(&self) -> bool {
        self.source_split_handoff.as_ref().is_some_and(|handoff| handoff.epoch == self.native_epoch)
    }
    fn cancel_source(&mut self, cx: &mut Context<Self>) {
        if self.source_combined_next.is_some_and(|(epoch, _)| epoch == self.native_epoch) {
            self.source_combined_next = None;
            self.source_job = None;
            self.source_split = None;
            self.source_split_combined = false;
            self.transport.update(cx, |t, cx| t.set_progress(None, cx));
            self.start_beat_detection(false, cx);
            cx.notify();
            return;
        }
        if self.source_split_loading() {
            let mut handoff = self.source_split_handoff.take().unwrap();
            let Some((output, resume)) = handoff.cancel(self.native_epoch) else {
                self.source_split_handoff = Some(handoff);
                return;
            };
            self.monitor_flight.monitor_actions.retain(|a| { if let DeferredAudio::SourceOutput(output, _, _) = a { if output.working && self.project.as_ref().is_none_or(|project| project.dir != output.path) { source_jobs::discard_working_copy(&output.path); } false } else { true } });
            // Reopening the retained original revokes the pending candidate's
            // native epoch. Its late Opened/Error cannot replace this rollback.
            self.open_source_output(output, Some(resume), cx);
            handoff.epoch = self.native_epoch;
            self.source_split_handoff = Some(handoff);
            cx.notify();
            return;
        }
        if let (Some(id), Some(_)) = (self.source_job, self.source_split) {
            if self.source_cancelling == Some(id) { return; }
            diagnostics::event("projects", "Project operation cancellation requested.", diagnostics::Level::Warn);
            if let Some(service) = &self.source_service { service.cancel(); }
            self.source_cancelling = Some(id);
            // Keep the pill and owner until the worker has actually retired
            // its child tree. The result remains disowned even if it won a race.
            cx.notify();
            return;
        }
        self.disown_source(cx);
    }
    fn disown_source(&mut self, cx: &mut Context<Self>) {
        if self.source_job.is_some(){diagnostics::event("projects","Project operation cancelled.",diagnostics::Level::Warn);}
        if self.metronome_flight.metronome_save_waiting && self.source_job.is_some() {
            self.metronome_flight.metronome_save_waiting = false;
            self.notice = Some("Queued Save was cancelled before it completed.".into());
        }
        if let Some(service) = &self.source_service {
            service.cancel();
        }
        self.source_job = None;
        self.cancel_source_publication(cx);
        self.source_saving=false;
        self.source_split = None;
        self.source_split_combined = false;
        self.source_combined_next = None;
        self.source_cancelling = None;
        self.source_split_handoff = None;
        self.transport.update(cx, |t, cx| t.set_progress(None, cx));
        self.monitor_flight.monitor_actions
            .retain(|a| { if let DeferredAudio::SourceOutput(output, _, _) = a { if output.working && self.project.as_ref().is_none_or(|project| project.dir != output.path) { source_jobs::discard_working_copy(&output.path); } false } else { true } });
        cx.notify();
    }
    fn source_blocks_player(&self) -> bool { self.rate_busy() || self.source_blocks_except_rate() }
    fn source_blocks_except_rate(&self) -> bool {
        (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()) || self.audio_recovery.is_some() || self.source_publication.is_some() || self.tracks_audio_failed || self.import_pending.is_some() || self.rename_pending.is_some() || (self.source_job.is_some() && self.source_split.is_none())
    }
    fn current_mix(&self, project: &integration::Project) -> project_store::Mix {
        project_store::Mix {
            carry: self.carry.clone(),
            metronome: self.metronome.clone(),
            beat: self.beats.clone(),
            original: project.original,
            lanes: project.lanes.iter().map(|(i, _)| *i).collect(),
            custom: project.lane_specs.iter().filter(|lane|lane.custom).cloned().collect(),
            gain: self.gain.map(|v| v as f32 / 100.),
            muted: self.muted,
            solo: self.solo,
            master: self.master_volume,
            transpose: self.transpose,
            tempo: self.tempo,
            looping: self.looping,
            selection: project.selection,
            view: (
                self.view_start * self.duration,
                self.view_end * self.duration,
            ),
        }
    }
    fn split_source(&mut self, mode: source_jobs::Mode, cx: &mut Context<Self>) {
        self.start_split_stage(mode, false, cx);
    }
    fn start_split_stage(&mut self, mode: source_jobs::Mode, continuation: bool, cx: &mut Context<Self>) {
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy())||!self.audio_available(){return;}
        if self.lyrics_sidebar_editor_after||self.lyrics_sidebar_rename_after.is_some()||self.lyrics_sidebar_import_after.is_some(){return;}
        if self.metronome_flight.metronome.is_some()
            || (!continuation && (self.metronome_flight.metronome_save_requested || self.metronome_flight.metronome_save_waiting))
            || self.transport_flight.counting_in
        {
            if continuation { return; }
            self.notice = Some(
                "Wait for count-in and the pending metronome changes or Save to finish.".into(),
            );
            cx.notify();
            return;
        }

        if self.loading || self.source_job.is_some() {
            return;
        }
        let Some(project) = &self.project else {
            return;
        };
        let raw = match project_store::update_mix(project.raw.clone(), &self.current_mix(project)) {
            Ok(raw) => raw,
            Err(e) => {
                self.notice = Some(e.to_string());
                return;
            }
        };
        let target = if self.source_working {
            self.source_target.clone()
        } else {
            Some(source_jobs::Target {
                dir: project.dir.clone(),
                fingerprint: project.metadata_hash.clone(),
                lyrics_fingerprint: project.lyrics_fingerprint.clone(),
            })
        };
        let combined = mode == source_jobs::Mode::Combined || continuation;
        let execution_mode = if mode == source_jobs::Mode::Combined { source_jobs::Mode::Stems } else { mode };
        self.start_source(
            source_jobs::Job::Split {
                dir: project.dir.clone(),
                custom: project.lane_specs.iter().filter(|lane|lane.custom).cloned().collect(),
                raw,
                mode: execution_mode,
                require_vocals: mode != source_jobs::Mode::Stems,
                target,
            },
            cx,
        );
        if self.source_job.is_some() && self.source_split == Some(execution_mode) {
            self.source_split_combined = combined;
        }
    }
    fn source_writer_busy(&self) -> bool {
        self.source_job.is_some() || self.source_service.as_ref().is_some_and(|service| service.snapshot().busy)
    }
    fn retain_source_edits(&self) {
        // A new loose-song working copy starts at edit_seq 1; that initial
        // dirty dot alone does not make a disposable audio copy valuable.
        if self.source_working && self.edit_seq > 1 {
            if let Some(project) = &self.project { source_jobs::retain_edited_working_copy(&project.dir); }
        }
    }
    fn poll_sources(&mut self, cx: &mut Context<Self>) {
        self.retain_source_edits();
        if !self.source_writer_busy() {
            let mut keep = Vec::new();
            if let Some(project) = &self.project { keep.push(project.dir.clone()); }
            if let Some((_, _, _, _, path)) = &self.source_pending { keep.push(path.clone()); }
            if let Some(handoff) = &self.source_split_handoff { keep.push(handoff.rollback.0.path.clone()); }
            for action in &self.monitor_flight.monitor_actions { if let DeferredAudio::SourceOutput(output, _, _) = action { keep.push(output.path.clone()); } }
            source_jobs::release_unowned_working_copies(&keep);
        }
        if !self.source_writer_busy() && !self.loading && self.project.is_none() {
            if let Some((_, _, _, _, path)) = self.source_pending.take() { source_jobs::discard_working_copy(&path); }
        }
        if let Some((epoch, retired_job)) = self.source_combined_next {
            if epoch != self.native_epoch {
                self.source_combined_next = None;
                if self.source_job == Some(retired_job) {
                    self.source_job = None;
                    self.source_split = None;
                    self.source_split_combined = false;
                }
            } else if self.source_job == Some(retired_job) {
                // The first stage is accepted. Keep its composite request while
                // native restore/control acknowledgements temporarily defer UVR.
                self.source_job = None;
                self.start_split_stage(source_jobs::Mode::Vocals, true, cx);
                if self.source_job.is_some() {
                    self.source_split_combined = true;
                    self.source_combined_next = None;
                } else if self.notice.is_some() {
                    self.source_combined_next = None;
                    self.source_split = None;
                    self.source_split_combined = false;
                } else {
                    self.source_job = Some(retired_job);
                }
            }
        }
        if self.source_job.is_some_and(|id| self.source_cancelling == Some(id)
            && self.source_service.as_ref().is_some_and(|service| service.retired(id)))
        {
            if let Some(output) = self.source_service.as_ref().and_then(|service| service.snapshot().result.clone()).filter(|output| output.working && self.project.as_ref().is_none_or(|project| project.dir != output.path)) { source_jobs::discard_working_copy(&output.path); }
            let accepted_stems = self.source_split_combined && self.source_split == Some(source_jobs::Mode::Vocals);
            self.source_job = None;
            self.source_split = None;
            self.source_split_combined = false;
            self.source_cancelling = None;
            self.source_saving = false;
            self.transport.update(cx, |t, cx| t.set_progress(None, cx));
            if accepted_stems { self.start_beat_detection(false, cx); }
            cx.notify();
            return;
        }
        let Some(service) = &self.source_service else {
            return;
        };
        let snapshot = service.snapshot();
        if self.source_job.is_none() && self.source_pending.is_none() {
            if let Some(output) = snapshot.result.as_ref().filter(|output| output.working
                && self.project.as_ref().is_none_or(|project| project.dir != output.path)
                && !self.monitor_flight.monitor_actions.iter().any(|action| matches!(action, DeferredAudio::SourceOutput(candidate, _, _) if candidate.path == output.path)))
            { source_jobs::discard_working_copy(&output.path); }
        }
        if self.source_job.is_some_and(|id| id != snapshot.generation) {
            return;
        }
        // Completion must not consume its revision until the current accepted
        // metronome state and active audible pre-roll are ready for handoff.
        if self.source_job.is_some()
            && !snapshot.busy
            && (self.rate_busy() || self.metronome_flight.metronome.is_some()
                || self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some()
                || self.library_import_open || self.stem_export_open
                || self.import_pending.is_some()
                || self.lyrics_editor_open
                || self.lyrics_flight.lyrics_editor_pending.is_some()
                || self.lyrics_sidebar_editor_after
                || self.lyrics_flight.lyrics_sidebar.is_some()
                || self.lyrics_sidebar_download_waiting
                || self.transport_flight.counting_in
                || (self.metronome_flight.metronome_navigation.is_some() && self.notice.is_some()))
        {
            return;
        }
        if snapshot.revision == self.source_status.revision {
            return;
        }
        self.source_status = snapshot.clone();
        if snapshot.engine_revision!=self.source_engine_revision {
            self.source_engine_revision=snapshot.engine_revision;
            if snapshot.engine_probe_started.is_some_and(|started|self.engine_status_started.is_none_or(|floor|started>=floor)){
                self.engine_status_started=snapshot.engine_probe_started;
                self.engine_status=Some(snapshot.engine_status.clone());
                self.header.update(cx,|h,cx|h.set_engine(snapshot.engine_status.ok,cx));
            }
        }
        if self.source_job == Some(snapshot.generation) && !snapshot.busy {
            if self.source_cancelling == Some(snapshot.generation) {
                if let Some(output) = snapshot.result.as_ref().filter(|output| output.working && self.project.as_ref().is_none_or(|project| project.dir != output.path)) { source_jobs::discard_working_copy(&output.path); }
                let accepted_stems = self.source_split_combined && self.source_split == Some(source_jobs::Mode::Vocals);
                self.source_job = None;
                self.source_split = None;
                self.source_split_combined = false;
                self.source_cancelling = None;
                self.source_saving = false;
                self.transport.update(cx, |t, cx| t.set_progress(None, cx));
                if accepted_stems { self.start_beat_detection(false, cx); }
                cx.notify();
                return;
            }
            if let (Some(output),Some(project))=(&snapshot.result,&self.project) {
                if output.working && self.source_split.is_some() && Some(project.lyrics_fingerprint.clone())!=self.source_lyrics_fingerprint {
                    let job=source_jobs::Job::RefreshLyrics {source_dir:project.dir.clone(),expected:project.lyrics_fingerprint.clone(),output:output.clone()};
                    self.source_job=None;
                    self.start_source(job,cx);
                    return;
                }
            }
            let was_splitting=self.source_split.is_some();
            let accepted_stems = self.source_split_combined && self.source_split == Some(source_jobs::Mode::Vocals);
            let resume = self.source_split.and_then(|mode| {
                self.project.as_ref().map(|project| SourceResume {
                    restart_cycle:self.restart_cycle.snapshot(self.region_target().selection,self.playing),
                    play_serial:self.transport_flight.native_play.serial(),
                    position: self.playhead.position(),
                    playing: self.playing,
                    mode: Some(mode),
                    title: None,
                    dirty: true,
                    mix: self.current_mix(project),
                })
            });
            self.source_job = None;
        self.source_saving=false;
            self.source_split = None;
            self.source_cancelling = None;
            if snapshot.result.is_none() { self.source_split_combined = false; }
            if let Some(output) = &snapshot.result {
                if output.publication_hash.is_some() {
                    self.adopt_source_publication(output, !self.tracks_audio_failed, cx);
                } else {
                    self.open_source_output(output.clone(), resume, cx);
                }
                if let Some(backend) = &self.backend {
                    backend.catalog();
                }
            } else if let Some(error) = &snapshot.error {
                if self.metronome_flight.metronome_save_waiting {
                    self.metronome_flight.metronome_save_waiting = false;
                    self.notice = Some(format!("Queued Save failed: {error}"));
                } else if error.contains("AI models") || (was_splitting&&!snapshot.engine_status.ok&&snapshot.engine_status.needs_models) {
                    self.open_models(models::Origin::Manual, cx);
                    self.models.update(cx, |m, cx| m.failure(error.clone(), cx));
                } else if was_splitting&&!snapshot.engine_status.ok&&!snapshot.engine_status.needs_models {
                    self.open_engine_setup(cx);
                } else {
                    self.notice = Some(error.clone());
                }
                if accepted_stems {
                    let notice = self.notice.clone();
                    self.start_beat_detection(false, cx);
                    if notice.is_some() { self.notice = notice; }
                }
            }
            if snapshot.engine_revision==0&&self.source_job.is_none(){
                // Both successful and failed Open can supersede the startup
                // probe. Resume discovery only once its source worker is idle.
                if let Some(service)=&self.source_service{let _=service.check();}
            }
        }
        cx.notify();
    }
    fn open_source_output(
        &mut self,
        output: source_jobs::Output,
        resume: Option<SourceResume>,
        cx: &mut Context<Self>,
    ) {
        let handoff = if let Some(mode) = resume.as_ref().and_then(|resume| resume.mode) {
            self.project.as_ref().map(|project| {
                let rollback = source_jobs::Output {
                    publication_hash: None,
                    path: project.dir.clone(),
                    working: self.source_working,
                    target: self.source_target.clone(),
                };
                let rollback_resume = SourceResume {
                    restart_cycle: self.restart_cycle.snapshot(self.region_target().selection, self.playing),
                    play_serial: self.transport_flight.native_play.serial(),
                    position: self.playhead.position(),
                    playing: self.playing,
                    mode: None,
                    title: None,
                    dirty: self.edit_seq > self.saved_seq,
                    mix: self.current_mix(project),
                };
                source_jobs::SplitHandoff::new(self.native_epoch, self.source_status.generation,
                    mode, self.source_split_combined, (rollback, rollback_resume))
            })
        } else {
            // A delayed monitor-cleanup rollback retains its cancellation owner.
            self.source_split_handoff.clone().filter(|handoff| handoff.cancelling && handoff.epoch == self.native_epoch)
        };
        if let Some(handoff) = handoff.clone() { self.source_split_handoff = Some(handoff); }
        if self.defer_monitor(
            DeferredAudio::SourceOutput(output.clone(), resume.clone(), self.native_epoch),
            cx,
        ) {
            return;
        }
        let epoch = self.native_epoch;
        // This is the completion of an owned Save/split/rename, not a new
        // user navigation. Preserve any destination waiting behind that Save.
        let overlay=resume.as_ref().and_then(|resume|self.project.as_ref().map(|project|integration::OpenCustomOverlay{source_dir:project.dir.clone(),mix:resume.mix.clone(),preserve_generated:resume.mode.is_some()}));
        let rate_navigation=self.transport_flight.native_rate_navigation.take();
        let rate_save=std::mem::take(&mut self.transport_flight.native_rate_save_requested);
        let pending_path = output.path.clone();
        let attempt = self.open_project_with_overlay(output.path.clone(),None,overlay,cx);
        self.transport_flight.native_rate_navigation=rate_navigation;
        self.transport_flight.native_rate_save_requested=rate_save;
        if self.native_epoch != epoch {
            self.source_pending = Some((self.native_epoch, output.working, output.target, resume, pending_path));
            if let Some(mut handoff) = handoff {
                handoff.epoch = self.native_epoch;
                self.source_split_handoff = Some(handoff);
            }
        } else if attempt == source_jobs::OpenAttempt::Deferred {
            // No backend request was issued. Keep the output for a later poll.
            self.monitor_flight.monitor_actions.push_back(DeferredAudio::SourceOutput(output, resume, self.native_epoch));
        } else {
            source_jobs::discard_failed_source_open(&pending_path, attempt, self.source_pending.as_ref().map(|(_, _, _, _, path)| path.as_path()), self.project.as_ref().map(|project| project.dir.as_path()));
        }
    }
    fn resume_project_audio(&mut self, resume: SourceResume, cx: &mut Context<Self>) {
        self.playhead.seek(resume.position.clamp(0., self.duration));
        #[cfg(feature="ui-tests")]
        { self.source_seek_receipt=None; self.source_resume_probe=Some(ui_source::ResumeProbe {
            epoch:self.native_epoch, position:self.playhead.position(), at:Instant::now(),
            initial_loop_count:self.playhead.loop_count(), expected_seek_count:self.playhead.seek_count()+1,
        }); }
        self.master_volume = resume.mix.master;
        self.transpose = resume.mix.transpose;
        self.tempo = resume.mix.tempo;
        self.looping = resume.mix.looping;
        if self.duration>0.{self.view_start=(resume.mix.view.0/self.duration).clamp(0.,0.999);self.view_end=(resume.mix.view.1/self.duration).clamp(self.view_start+0.001,1.);}else{self.empty_timeline(cx);}
        if let Some(project) = &mut self.project {
            project.selection=project.has_audio().then_some(resume.mix.selection).flatten();
        }
        // Backing-only keeps all existing lanes; a stem re-split creates fresh
        // standard lanes and retains every user-added lane by stable ID.
        let lanes: Vec<_> = self
            .project
            .as_ref()
            .unwrap()
            .lanes
            .iter()
            .map(|(i, _)| *i)
            .collect();
        for i in lanes {
            let custom=self.project.as_ref().and_then(|p|p.lane_specs.iter().find(|lane|lane.slot==i&&lane.custom)).and_then(|lane|resume.mix.custom.iter().find(|old|old.id==lane.id));
            if let Some(lane)=custom{
                self.gain[i]=(resume.mix.gain[lane.slot]*100.).round() as u8;
                self.muted[i]=resume.mix.muted[lane.slot];self.solo[i]=resume.mix.solo[lane.slot];
            }else if resume.mix.lanes.contains(&i)
                && (resume.mode.is_none()||(!resume.mix.original&&resume.mode==Some(source_jobs::Mode::Vocals))) {
                self.gain[i]=(resume.mix.gain[i]*100.).round() as u8;
                self.muted[i]=resume.mix.muted[i];self.solo[i]=resume.mix.solo[i];
            }else{
                self.gain[i]=100;self.muted[i]=false;self.solo[i]=false;
            }
            self.sync_lane(i, cx);
        }
        if self.metronome != resume.mix.metronome || self.beats != resume.mix.beat {
            self.apply_metronome(resume.mix.metronome.clone(), resume.mix.beat.clone(), cx);
        }
        self.native_command(format!("master {}", self.master_volume), cx);
        self.native_command(format!("rate {} {}", self.tempo, self.transpose), cx);
        // Restore the non-looping stop boundary as well as repeating regions,
        // before the final seek is fenced ahead of Play.
        self.native_command(self.region_target().command(self.duration),cx);
        let mut seek_queued=false;
        if self.audio_available() {
            if let Some(backend)=&self.backend {
                match backend.restore_seek(self.native_epoch,self.playhead.position()) {
                    Ok(())=>{seek_queued=true;self.playhead.seek_queued(Instant::now());},
                    Err(error)=>self.notice=Some(error.to_string()),
                }
            }
        }
        if !seek_queued { self.playhead.seek_refused(); }
        // A newer explicit Pause (for example opening Catalog during Rename)
        // supersedes the playing intent captured before this native handoff.
        if resume.playing && seek_queued && resume.play_serial==self.transport_flight.native_play.serial() {
            self.native_command("play-flat".into(), cx);
        }
        if resume.mode.is_none() {
            // Internal rename/import recovery pauses/reopens the native graph,
            // while React keeps the same engine, selection and playing state.
            self.restart_cycle.restore_same_song(resume.restart_cycle,self.region_target().selection,self.playing);
        } else {
            self.restart_cycle.reset();
        }
        self.transport.update(cx, |t, cx| {
            t.set_native_mix(self.master_volume, cx);
            t.set_tempo(self.tempo, cx);
        });
        if let Some(name) = resume.title {
            self.song_title = name.clone().into();
            if let Some(project) = &mut self.project {
                project.name = name.clone();
                project.raw["name"] = serde_json::json!(name);
            }
            self.library.update(cx, |l, cx| {
                l.set_open_song(Some(self.song_title.clone()), cx)
            });
        }
        if resume.mode.is_none() {
            self.saved_seq = 0;
            self.edit_seq = u64::from(resume.dirty);
        }
    }
    fn rename_title(&mut self, name: String, cx: &mut Context<Self>) {
        if let Err(error) = source_jobs::checked_name(&name) {
            self.notice = Some(error.to_string());
            cx.notify();
            return;
        }
        let name = name.trim().to_owned();
        if name.is_empty()
            || name == self.song_title.as_str()
            || (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy())
            || self.tracks_audio_failed
            || self.loading
            || self.saving
            || self.source_job.is_some()
            || self.rename_pending.is_some()
            || self.metronome_flight.metronome.is_some()
            || self.metronome_flight.metronome_save_requested
            || self.metronome_flight.metronome_save_waiting
            || self.transport_flight.counting_in
        {
            return;
        }
        if self.lyrics_flight.lyrics_sidebar.is_some(){self.cancel_sidebar_lyrics(cx);self.lyrics_sidebar_rename_after=Some(name);cx.notify();return;}
        self.cancel_sidebar_lyrics(cx);self.lyrics_flight.lyrics_search_pending.cancel();
        if let Some(backend)=&self.backend{backend.cancel_lyrics_search();}
        let Some(project) = &mut self.project else {
            self.song_title = name.into();
            cx.notify();
            return;
        };
        if self.source_working && self.source_target.is_none() {
            project.name = name.clone();
            project.raw["name"] = serde_json::json!(name);
            self.song_title = name.into();
            self.sidebar_context(cx);
            self.edit_seq += 1;
            cx.notify();
            return;
        }
        let project = self.project.as_ref().unwrap();
        let Some(backend) = &self.backend else {
            return;
        };
        let target = self.source_target.clone();
        let (dir, expected) = target
            .as_ref()
            .map(|t| (t.dir.clone(), t.fingerprint.clone()))
            .unwrap_or((project.dir.clone(), project.metadata_hash.clone()));
        let active_dir = project.dir.clone();
        let resume = SourceResume {
            restart_cycle:self.restart_cycle.snapshot(self.region_target().selection,self.playing),
            play_serial:self.transport_flight.native_play.serial(),
            position: self.playhead.position(),
            playing: self.playing,
            mode: None,
            title: None,
            dirty: self.edit_seq != self.saved_seq,
            mix: self.current_mix(project),
        };
        match backend.rename(dir, expected, name) {
            Ok(epoch) => {
                self.native_epoch = epoch;
                self.rename_pending = Some(RenamePending {
                    epoch,
                    resume,
                    working: self.source_working,
                    active_dir,
                    target,
                })
            }
            Err(error) => self.notice = Some(error.to_string()),
        }
        cx.notify();
    }
    fn open_library_import(&mut self,cx:&mut Context<Self>){
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy())||self.tracks_audio_failed{return;}
        if self.backend.is_none()||self.project_picker_open||self.lyrics_editor_open||self.library_import_open||self.stem_export_open
            ||self.notice.is_some()||self.source_working||self.loading||self.import_pending.is_some()
            ||self.project_library_pending.is_some()||matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models|Screen::Training)
            ||self.quick_start.read(cx).is_open()||self.whats_new.read(cx).is_open(){return;}
        let Some(project)=&self.project else{return;};
        if project.dir.starts_with(&self.catalog_root){return;}
        self.library_import_epoch=self.native_epoch;
        self.library_import_root=Some(self.catalog_root.clone());
        self.library_import.update(cx,|s,cx|s.open(project.dir.clone(),self.catalog_root.clone(),cx));
        self.library_import_open=true;self.metronome_open=false;
        self.transport.update(cx,|s,cx|s.dismiss_popovers(cx));cx.notify();
    }
    fn start_library_import(&mut self,mode:project_import::Mode,cx:&mut Context<Self>){
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy())||self.tracks_audio_failed{return;}
        if !self.library_import_open||self.import_pending.is_some(){return;}
        let error=if self.native_epoch!=self.library_import_epoch||self.loading||self.source_working {
            Some("The project changed. Reopen Add to library before continuing.")
        }else if self.monitor_busy(){
            Some("Stop microphone monitoring before adding this project to your library.")
        }else if self.saving||self.source_job.is_some()||self.rename_pending.is_some()
            ||self.metronome_flight.metronome.is_some()||self.metronome_flight.metronome_save_requested||self.metronome_flight.metronome_save_waiting
            ||self.transport_flight.counting_in||self.project_library_pending.is_some(){
            Some("Wait for the current project operation to finish before adding it to your library.")
        }else{None};
        if let Some(error)=error {self.library_import_open=false;self.library_import.update(cx,|s,cx|s.set_busy(false,cx));self.notice=Some(error.into());cx.notify();return;}
        if self.lyrics_flight.lyrics_sidebar.is_some(){self.cancel_sidebar_lyrics(cx);self.lyrics_sidebar_import_after=Some(mode);self.library_import.update(cx,|s,cx|s.set_busy(true,cx));cx.notify();return;}
        self.cancel_sidebar_lyrics(cx);self.lyrics_flight.lyrics_search_pending.cancel();
        if let Some(backend)=&self.backend{backend.cancel_lyrics_search();}
        let (Some(backend),Some(project),Some(root))=(&self.backend,&self.project,self.library_import_root.clone())else{return;};
        let resume=SourceResume{restart_cycle:self.restart_cycle.snapshot(self.region_target().selection,self.playing),play_serial:self.transport_flight.native_play.serial(),position:self.playhead.position(),playing:self.playing,mode:None,title:None,dirty:self.edit_seq!=self.saved_seq,mix:self.current_mix(project)};
        match backend.import_library(project,root,mode){
            Ok(epoch)=>{self.native_epoch=epoch;self.import_pending=Some(ImportPending{epoch,resume,mode});
                self.beat_job=None;self.beat_result=None;
                self.library_import.update(cx,|s,cx|s.set_busy(true,cx));
                if mode==project_import::Mode::Move{self.playing=false;self.playhead.stop_projection();}
            },
            Err(error)=>{self.library_import_open=false;self.library_import.update(cx,|s,cx|s.set_busy(false,cx));self.notice=Some(error.to_string());},
        }
        cx.notify();
    }
    fn open_project_picker(&mut self,cx:&mut Context<Self>) {
        if self.backend.is_none()||self.lyrics_editor_open||self.library_import_open||self.stem_export_open||self.import_pending.is_some()||self.notice.is_some()||self.project_delete.read(cx).is_open()
            ||matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models)
            ||self.quick_start.read(cx).is_open()||self.whats_new.read(cx).is_open(){return;}
        self.cancel_delete_inspection();
        self.project_picker_session+=1;
        self.project_picker_prompt=None;
        self.project_picker_open=true;
        self.metronome_open=false;
        self.transport.update(cx,|s,cx|s.dismiss_popovers(cx));
        if self.project_library_pending.is_some() {
            self.project_picker.update(cx,|s,cx|{s.open(self.project_library_snapshot.clone(),cx);s.set_moving(self.project_library_moving,cx);});
        }else{
            self.project_picker.update(cx,|s,cx|s.open(None,cx));
            if let Some(service)=&self.project_library_service {
                match service.refresh(){
                    Ok(generation)=>self.project_library_pending=Some(generation),
                    Err(error)=>self.project_picker.update(cx,|s,cx|s.failure(error.to_string(),cx)),
                }
            }
        }
        cx.notify();
    }
    fn close_project_picker(&mut self,cx:&mut Context<Self>){
        self.project_picker_open=false;
        self.project_picker_session+=1;self.project_picker_prompt=None;
        // A chosen folder keeps copying after dismissal, just like the source.
        // Files stay in the original library until the complete copy is accepted.
        cx.notify();
    }
    fn prompt_project_root(&mut self,cx:&mut Context<Self>){
        if self.project_library_moving||self.project_picker_prompt.is_some(){return;}
        #[cfg(feature="ui-tests")]
        if let Some(path)=std::env::var_os("SINGZ_GPUI_PICKER_CHOOSE_ROOT"){
            self.choose_project_root(Some(path.into()),cx);return;
        }
        self.project_picker_prompt_serial+=1;
        let token=(self.project_picker_session,self.project_picker_prompt_serial);
        self.project_picker_prompt=Some(token);
        self.project_picker.update(cx,|p,cx|p.set_moving(true,cx));
        let prompt=cx.prompt_for_paths(PathPromptOptions{files:false,directories:true,multiple:false,prompt:Some("Choose a folder for your project library".into())});
        cx.spawn(async move|this,cx|{
            let result=prompt.await;
            let _=this.update(cx,|s,cx|{
                if !s.project_picker_open||s.project_picker_session!=token.0||s.project_picker_prompt!=Some(token){return;}
                s.project_picker_prompt=None;
                s.project_picker.update(cx,|p,cx|p.set_moving(false,cx));
                match result {
                    Ok(Ok(Some(paths)))=>if let Some(path)=paths.into_iter().next(){s.choose_project_root(Some(path),cx);},
                    Ok(Err(error))=>s.project_picker.update(cx,|p,cx|p.failure(error.to_string(),cx)),
                    _=>{}
                }
            });
        }).detach();
    }
    fn choose_project_root(&mut self,path:Option<std::path::PathBuf>,cx:&mut Context<Self>){
        if !self.project_picker_open||self.drive_projects_open||self.project_library_moving||self.project_picker_prompt.is_some(){return;}
        if self.saving||self.loading||self.source_job.is_some()||self.rename_pending.is_some()
            ||self.metronome_flight.metronome.is_some()||self.metronome_flight.metronome_save_requested||self.metronome_flight.metronome_save_waiting{
            self.project_picker.update(cx,|s,cx|s.failure("Wait for the current project operation to finish before changing the library folder.".into(),cx));return;
        }
        if let Some(service)=&self.drive_service {
            match service.suspend() {
                Ok(())=>{self.drive_root_waiting=Some(path);self.project_library_moving=true;self.project_picker.update(cx,|s,cx|s.set_moving(true,cx));},
                Err(error)=>self.project_picker.update(cx,|s,cx|s.failure(error.to_string(),cx)),
            }
            cx.notify();return;
        }
        if let Some(service)=&self.project_library_service{
            match service.set_root(path){
                Ok(generation)=>{self.project_library_pending=Some(generation);self.project_library_moving=true;self.project_picker.update(cx,|s,cx|s.set_moving(true,cx));},
                Err(error)=>self.project_picker.update(cx,|s,cx|s.failure(error.to_string(),cx)),
            }
        }
        cx.notify();
    }
    fn poll_project_library(&mut self,cx:&mut Context<Self>){
        let events=self.project_library_service.as_ref().map(|s|s.drain()).unwrap_or_default();
        for event in events {
            if self.project_library_pending!=Some(event.generation){continue;}
            self.project_library_pending=None;
            let moved=self.project_library_moving;
            self.project_library_moving=false;
            match event.result {
                Ok(change)=>{
                    let root_changed=self.catalog_root!=change.snapshot.root;
                    self.catalog_root=change.snapshot.root.clone();
                    // A picker refresh only updates rows. Restarting Drive for
                    // that same root invalidates account actions and creates a
                    // sync -> refresh -> sync loop. Resume its storage fence
                    // only after an actual move, or adopt a genuinely new root.
                    if moved||root_changed {if let Some(service)=&self.drive_service {if let Err(error)=service.set_root(self.catalog_root.clone()){self.notice=Some(error.to_string());}}}
                    self.project_library_snapshot=Some(change.snapshot.clone());
                    self.project_picker.update(cx,|s,cx|{s.update(change.snapshot,cx);s.set_moving(false,cx);if moved{s.storage_result(change.copied,None,cx);}if self.project_picker_prompt.is_some(){s.set_moving(true,cx);}});
                    if let Some(backend)=&self.backend{backend.catalog();}
                }
                Err(error)=>{if moved {if let Some(service)=&self.drive_service{let _=service.set_root(self.catalog_root.clone());}}self.project_picker.update(cx,|s,cx|{s.set_moving(false,cx);s.failure(error,cx);});},
            }
            cx.notify();
        }
    }
    fn browse(&mut self, cx: &mut Context<Self>) {
        if self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some() { return; }
        self.cancel_delete_inspection();
        #[cfg(feature="ui-tests")]
        if std::env::var_os("SINGZ_GPUI_WHATS_NEW_TEST").is_some(){
            // Detect leaked shortcuts without presenting a system chooser.
            self.release_unexpected_browse+=1;cx.notify();return;
        }
        let prompt = cx.prompt_for_paths(PathPromptOptions {
            files: true,
            directories: true,
            multiple: false,
            prompt: Some("Open audio, a SingZ project folder or project.json".into()),
        });
        cx.spawn(async move |this, cx| match prompt.await {
            Ok(Ok(Some(paths))) => {
                if let Some(path) = paths.into_iter().next() {
                    let _ = this.update(cx, |this, cx| this.open_source(path, cx));
                }
            }
            Ok(Err(error)) => {
                let _ = this.update(cx, |this, cx| {
                    this.notice = Some(error.to_string());
                    cx.notify();
                });
            }
            _ => {}
        })
        .detach();
    }
    fn monitor_busy(&self) -> bool {
        self.monitor_flight.monitor_requested
            || self.monitor_flight.monitor_parked
            || self.monitor_flight.monitor.is_some()
            || self.mic_intent.as_ref().is_some_and(|i| i.monitor)
    }
    fn defer_monitor(&mut self, action: DeferredAudio, cx: &mut Context<Self>) -> bool {
        if !self.monitor_busy() {
            return false;
        }
        self.monitor_flight.monitor_requested = false;
        if self.monitor_flight.monitor_actions.len() < 128 {
            self.monitor_flight.monitor_actions.push_back(action);
        } else {
            self.notice = Some("Native handoff command queue is full".into());
        }
        cx.notify();
        true
    }
    fn select_output(&mut self, uid: String, cx: &mut Context<Self>) {
        self.pause_practice(cx);
        self.mic_prefs.headphones = false;
        self.settings.update(cx, |settings, cx| {
            settings.set_input_prefs(self.mic_prefs.clone(), cx)
        });
        if self.defer_monitor(DeferredAudio::Output(uid.clone()), cx) {
            return;
        }
        if self.source_publication.is_some() {
            self.retry_source_publication(uid, cx);
            return;
        }
        if self.project.is_some() {
            self.begin_audio_recovery(uid, cx);
            return;
        }
        if let Some(backend) = &self.backend {
            if let Err(error) = backend.output(uid) {
                self.settings
                    .update(cx, |s, cx| s.route_failed(error.to_string(), cx));
            }
        }
    }
    fn defer_metronome_navigation(
        &mut self,
        path: std::path::PathBuf,
        source: bool,
        cx: &mut Context<Self>,
    ) -> bool {
        if self.saving||self.source_saving {self.metronome_flight.metronome_save_waiting=true;}
        if self.metronome_flight.metronome.is_some()
            || self.metronome_flight.metronome_save_requested
            || self.metronome_flight.metronome_save_waiting
            || (self.metronome_flight.metronome_navigation.is_some() && self.notice.is_some())
        {
            self.metronome_flight.metronome_navigation = Some((path, source));
            cx.notify();
            return true;
        }
        false
    }
    fn open_project(&mut self, path: std::path::PathBuf, cx: &mut Context<Self>) {
        if self.defer_rate_navigation(path.clone(),false,cx){return;}
        if self.defer_carry_navigation(path.clone(),false,cx){return;}
        if self.defer_metronome_navigation(path.clone(), false, cx) {
            return;
        }
        let previous_epoch=self.native_epoch;
        self.open_project_now(path, cx);
        if self.native_epoch!=previous_epoch {
            self.transport.update(cx,|transport,cx|transport.reset_song_output(cx));
        }
    }
    fn open_project_now(&mut self, path: std::path::PathBuf, cx: &mut Context<Self>) {
        self.open_project_verified(path,None,cx);
    }
    fn open_project_verified(&mut self, path: std::path::PathBuf, confirmed:Option<project_delete::Target>,cx:&mut Context<Self>) {
        self.open_project_with_overlay(path,confirmed,None,cx);
    }
    fn open_project_with_overlay(&mut self,path:std::path::PathBuf,confirmed:Option<project_delete::Target>,overlay:Option<integration::OpenCustomOverlay>,cx:&mut Context<Self>) -> source_jobs::OpenAttempt {
        if self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some() { return source_jobs::OpenAttempt::Deferred; }
        if (confirmed.is_some()||overlay.is_some()) && self.monitor_busy() {
            return source_jobs::OpenAttempt::Deferred;
        }
        self.retain_source_edits();
        self.cancel_delete_inspection();
        diagnostics::event("projects",format!("Opening saved project {}",path.display()),diagnostics::Level::Info);
        self.reset_transport_timing(cx);
        self.reset_carry(cx);
        self.detach_stem_export(cx);
        self.library_import_open=false;self.import_pending=None;
        self.cancel_sidebar_lyrics(cx);self.lyrics_flight.lyrics_sidebar.cancel();self.lyrics_sidebar_next=None;self.lyrics_sidebar_editor_after=false;self.lyrics_sidebar_import_after=None;self.lyrics_sidebar_rename_after=None;self.lyrics_flight.lyrics_search_pending.cancel();self.lyrics_sidebar_intent=lyrics_resolution::Intent::Auto;
        if let Some(backend)=&self.backend{backend.cancel_lyrics_search();}
        self.cancel_lyrics_alignment(cx);
        self.header.update(cx, |h, cx| h.cancel_title(cx));
        self.disown_source(cx);
        self.rename_pending = None;
        self.stop_training(cx);
        self.training.update(cx, |s, cx| s.clear_song(cx));
        if self.defer_monitor(DeferredAudio::Open(path.clone()), cx) {
            return source_jobs::OpenAttempt::Deferred;
        }
        if let Some(backend) = &self.backend {
            let fallback=self.met_prefs_ready.then(|| self.metronome.clone());
            let request=backend.open_with_overlay(path.clone(),fallback,confirmed,overlay);
            let attempt = match request {
                Ok(epoch) => {
                    if let Some((_, _, _, _, pending_path)) = self.source_pending.take() {
                        source_jobs::discard_pending_working_copy(&pending_path, Some(&path), self.project.as_ref().map(|project| project.dir.as_path()));
                    }
                    self.native_epoch = epoch;
                    self.karaoke=false;
                    self.transport.update(cx,|transport,cx|transport.set_karaoke(false,cx));
                    self.settings.update(cx, |settings, cx| settings.set_playback_status(None, cx));
                    self.loading = true;
                    self.playing = false;
                    self.playhead.stop_projection();
                    self.notice = None;
                    source_jobs::OpenAttempt::Issued
                }
                Err(error) => {
                    self.notice = Some(error.to_string());
                    source_jobs::OpenAttempt::Failed
                }
            };
            cx.notify();
            attempt
        } else { source_jobs::OpenAttempt::Failed }
    }
    /// A modal or full-screen overlay covers the player; the output meter freezes.
    fn output_covered(&self, cx: &App) -> bool {
        (self.loading && !self.source_split_loading()) || (self.source_job.is_some() && self.source_split.is_none())
            || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
            || self.project_delete.read(cx).is_open()
            || self.lyrics_editor_open
            || self.project_picker_open || self.drive_projects_open
            || self.library_import_open || self.stem_export_open
            || self.notice.is_some()
            || self.engine_setup.read(cx).is_open()
            || self.whats_new.read(cx).is_open()
            || self.quick_start.read(cx).is_open()
    }
    /// Output meter telemetry runs off the poll loop, not root render, so a
    /// paused player still lets the held level decay and clip counts land. It
    /// only notifies while the held level or clip flag actually changes, which
    /// ends once the level snaps to rest.
    fn pump_output_meter(&mut self, cx: &mut Context<Self>) {
        let covered = self.output_covered(cx);
        let (peak, clips) = self.transport_flight.timing_status.as_ref().map(|status|
            (if self.playing && status.playing { status.output_peak } else { 0. }, status.output_clipped_blocks)).unwrap_or((0., 0));
        self.transport.update(cx, |transport, cx| transport.set_native_peak(peak, clips, covered, cx));
    }
    /// Root-visible transport state a status event can change.
    fn telemetry_signature(&self) -> (bool, bool, bool, bool, u64, u32, u64, u64, bool) {
        (
            self.playing,
            self.loading,
            self.loaded_song,
            self.transport_flight.counting_in,
            self.duration.to_bits(),
            self.native_rate.to_bits(),
            self.native_graph as u64,
            f64::from(self.playhead.position()).to_bits(),
            self.playhead.pending_seek().is_some(),
        )
    }
    fn poll_backend(&mut self, cx: &mut Context<Self>) {
        self.sync_audio_provider(cx);
        if let Some(store)=&mut self.desktop_window_state{store.save_if_due(Instant::now());}
        let events = self.backend.as_ref().map(|b| b.drain()).unwrap_or_default();
        for event in events {
            // Telemetry arrives ~25 Hz even while paused; it only repaints the
            // root when something the root shows actually changed.
            let telemetry_before = matches!(event, integration::Event::Status(..) | integration::Event::Playback(..))
                .then(|| self.telemetry_signature());
            match event {
                integration::Event::Provider(snapshot)=>self.adopt_audio_provider(snapshot,cx),
                integration::Event::Training(epoch, generation, result)
                    if epoch == self.native_epoch =>
                {
                    if matches!(&result, Ok(None))
                        || matches!(&result,Ok(Some(s)) if s.cue.generation==generation && !s.cue.active && s.cue.start_host_ns==0)
                    {
                        self.training_stopped = self.training_stopped.max(generation);
                    }
                    if self.training_test != Some(generation) {
                        continue;
                    }
                    match result {
                        Ok(Some(status)) => {
                            self.header.update(cx, |h, cx| {
                                h.set_output_label(status.output_label.clone(), cx)
                            });
                            self.training_status(&status.cue, cx);
                        }
                        Ok(None) => {
                            self.training_test = None;
                            self.training
                                .update(cx, |s, cx| s.test_state(false, None, cx));
                        }
                        Err(error) => {
                            self.training_test = None;
                            if let Some(run) = &mut self.practice {
                                run.fail(error.clone());
                            }
                            self.playing = false;
                            self.playhead.stop_projection();
                            self.training
                                .update(cx, |s, cx| s.test_state(false, Some(error), cx));
                        }
                    }
                }
                integration::Event::Parked(epoch, serial, parked, result)
                    if epoch == self.native_epoch
                        && self.monitor_flight.monitor.is_current(serial)
                        && self.monitor_flight.monitor.payload() == Some(&parked) =>
                {
                    self.monitor_flight.monitor.settle(epoch, serial);
                    match result {
                        Ok(status) => {
                            self.monitor_flight.monitor_parked = parked;
                            if !parked {
                                self.mic_prefs.headphones = false;
                                self.settings.update(cx, |settings, cx| {
                                    settings.set_input_prefs(self.mic_prefs.clone(), cx)
                                });
                            }
                            if let Some(status) = status {
                                self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
                                self.native_graph=status.graph_generation;
                                self.native_lane_revision=status.lane_revision;
                                #[cfg(feature="ui-tests")]
                                {self.last_playback_status=Some(status.clone());}

                                self.playing = false;
                                self.playhead.reset(status.position);
                                self.playhead.admit((&status).into(), Instant::now());
                            }
                            if !parked {
                                self.restore_monitor_publication(cx);
                            }
                        }
                        Err(error) => {
                            self.monitor_flight.monitor_publication_epoch = None;
                            self.monitor_flight.monitor_requested = false;
                            self.monitor_flight.monitor_parked = false;
                            self.monitor_flight.monitor_actions.clear();
                            self.cancel_deferred_rate(error, cx);
                        }
                    }
                }
                integration::Event::InputPrefsSaved(sequence, error) => {
                    if sequence == self.mic_pref_seq {
                        self.settings.update(cx, |settings, cx| {
                            if let Some(error) = error {
                                settings.input_pref_error(error, cx)
                            } else {
                                settings.clear_input_pref_error(cx)
                            }
                        });
                    }
                }
                integration::Event::InputPrefs(result) if self.mic_pref_seq == 0 => match result {
                    Ok(prefs) => {
                        self.mic_prefs = prefs.clone();
                        self.mic_prefs_valid = true;
                        self.mic_pref_error = None;
                        self.settings
                            .update(cx, |settings, cx| settings.set_input_prefs(prefs, cx));
                    }
                    Err(error) => {
                        self.mic_prefs_valid = false;
                        self.mic_pref_error = Some(error.clone());
                        self.settings.update(cx, |settings, cx| {
                            settings.set_microphone(
                                microphone::View {
                                    phase: microphone::Phase::Error,
                                    error: Some(error),
                                    ..Default::default()
                                },
                                cx,
                            )
                        });
                    }
                },
                integration::Event::Inventory(result) => self
                    .settings
                    .update(cx, |settings, cx| settings.set_inventory(result, cx)),
                integration::Event::KaraokePref(enabled) => {
                    if self.karaoke_pref_seq==0 {self.karaoke_preferred=enabled;}
                }
                integration::Event::KaraokePrefSaved(sequence,error) => {
                    if let Some(error)=error {
                        if sequence==self.karaoke_pref_seq {self.notice=Some(error);}
                    } else {self.karaoke_pref_saved_seq=self.karaoke_pref_saved_seq.max(sequence);}
                }
                integration::Event::AudioPrefs(uid, error) => self
                    .settings
                    .update(cx, |settings, cx| settings.set_route(uid, None, error, cx)),
                #[cfg(feature="ui-tests")]
                integration::Event::SourceSeekRestored(epoch,status) if epoch==self.native_epoch => { self.source_seek_receipt=Some(status); },
                integration::Event::Region(epoch,serial,result) => self.region_applied(epoch,serial,result,cx),
                integration::Event::TransportFailed(epoch,error) => self.transport_failed(epoch,error,cx),
                integration::Event::OutputRecovered(epoch,serial,uid,result) => self.output_recovered(epoch,serial,uid,result,cx),
                integration::Event::PublicationRead(epoch,serial,result) => self.source_publication_read(epoch,serial,result,cx),
                integration::Event::OutputChanged(epoch, uid, status, error) => {
                    if error.is_none() {
                        self.training
                            .update(cx, |s, cx| s.test_state(false, None, cx));
                    }
                    let label = status.as_ref().map(|s| s.output_label.clone());
                    self.settings
                        .update(cx, |settings, cx| settings.set_route(uid, label, error, cx));
                    if epoch == self.native_epoch {
                        if let Some(status) = status {

                            self.playing = status.playing;

                            self.playhead.reset(status.position);
                            self.playhead.admit((&status).into(), Instant::now());
                            self.header.update(cx, |header, cx| {
                                header.set_output_label(status.output_label, cx)
                            });
                        }
                    }
                }
                integration::Event::MetronomePrefs(result) => {
                    self.met_prefs_ready = true;
                    match result {
                        Ok(met) => {
                            if self.project.is_none() {
                                self.metronome = met;
                                self.metronome_ui.update(cx, |s, cx| {
                                    s.adopt(self.metronome.clone(), self.beats.clone(), cx)
                                });
                            }
                        }
                        Err(e) => self.notice = Some(e),
                    }
                }
                integration::Event::MetronomePrefsSaved(epoch, serial, error)
                    if epoch == self.native_epoch
                        && (serial == 0 || serial == self.metronome_flight.metronome_accepted) =>
                {
                    if let Some(e) = error {
                        self.notice = Some(e);
                    }
                }
                integration::Event::DeleteInspected(serial,result) => self.inspected_project_delete(serial,result,cx),
                integration::Event::Deleted(serial,epoch,loaded,result) => self.deleted_project(serial,epoch,loaded,result,cx),
                integration::Event::Catalog(serial,root,projects) if root==self.catalog_root&&self.backend.as_ref().is_some_and(|b|b.catalog_current(serial)) => self
                    .library
                    .update(cx, |library, cx| {library.set_root(root.display().to_string(),cx);library.set_projects(projects,cx);}),
                integration::Event::LanesTransportFailed(epoch,serial,error)=>self.disconnected_custom_lanes(epoch,serial,error,cx),
                integration::Event::LanesCommittedFailed(epoch,serial,project,error)=>self.failed_custom_lanes(epoch,serial,project,error,cx),
                integration::Event::Carry(epoch,serial,result)=>self.carried(epoch,serial,result,cx),
                integration::Event::CarryCommittedFailed(epoch,serial,desired,error)=>self.failed_carry(epoch,serial,Some(desired),error,cx),
                integration::Event::CarryTransportFailed(epoch,serial,error)=>self.failed_carry(epoch,serial,None,error,cx),
                integration::Event::CarryPrefs(result)=>match result{
                    Ok(config)=>if self.project.is_none(){self.carry.config=config;},
                    Err(error)=>diagnostics::event("carry",error,diagnostics::Level::Warn),
                },
                integration::Event::CarryPrefsSaved(epoch,_,error)=>if epoch==self.native_epoch{if let Some(error)=error{self.notice=Some(error);cx.notify();}},
                integration::Event::LanesReplaced(epoch,serial,result)=>self.replaced_custom_lanes(epoch,serial,result,cx),
                integration::Event::Opened(epoch, project, status, peaks)
                    if epoch == self.native_epoch =>
                {
                    let split_handoff = if self.source_split_handoff.as_ref().is_some_and(|handoff| handoff.epoch == epoch) {
                        self.source_split_handoff.take()
                    } else { None };
                    diagnostics::event("projects",format!("Loaded {}",project.name),diagnostics::Level::Info);
                    self.track_rename=None;self.tracks_flight.tracks_pending.cancel();self.tracks_audio_failed=false;
                    self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
                    self.native_graph=status.graph_generation;self.native_lane_revision=status.lane_revision;
                    #[cfg(feature="ui-tests")]
                    {self.last_playback_status=Some(status.clone());}
                    self.lyrics_editor_open=false;
                    self.lyrics_flight.lyrics_editor_pending.cancel();
                    self.loading = false;
                    self.loaded_song = true;
                    self.header.update(cx, |header, cx| {
                        header.set_output_label(status.output_label.clone(), cx)
                    });
                    self.settings.update(cx, |settings, cx| {
                        settings.confirm_route(status.output_label.clone(), cx)
                    });
                    self.playhead.reset(0.);
                    self.playhead.admit((&status).into(), Instant::now());
                    self.duration = status.duration;
                    self.playing = false;
                    self.song_title = project.name.clone().into();
                    self.song_artist = "".into();
                    self.muted = project.muted;
                    self.solo = project.solo;
                    self.gain = project.gain.map(|v| (v * 100.).round() as u8);
                    self.retain_source_edits();
                    self.edit_seq = 0;
                    self.saved_seq = 0;
                    if self.source_working {
                        if let Some(previous) = self.project.as_ref().filter(|previous| previous.dir != project.dir) { source_jobs::discard_inactive_working_copy(&previous.dir, self.source_writer_busy()); }
                    }
                    if let Some((_, _, _, _, pending_path)) = self.source_pending.as_ref() {
                        source_jobs::discard_pending_working_copy(pending_path, Some(&project.dir), None);
                    }
                    self.source_working = false;
                    self.source_target = None;
                    let mut resume = None;
                    if let Some((pending, working, target, handoff, _)) = self
                        .source_pending
                        .take()
                        .filter(|(pending, _, _, _, _)| *pending == epoch)
                    {
                        let _ = pending;
                        self.source_working = working;
                        self.source_target = target;
                        resume = handoff;
                        if working {
                            self.edit_seq = 1;
                        }
                    }
                    if self.source_working {
                        let split = resume.as_ref().is_some_and(|resume| resume.mode.is_some());
                        source_jobs::adopt_working_copy_with_value(&project.dir, split);
                    }
                    self.saving = false;
                    // A replacement of this song is not navigation. In particular,
                    // leave library search or an open settings field focused.
                    self.focus_player = resume.is_none()
                        || (self.screen == Screen::Player && !self.quick_start.read(cx).is_open());
                    self.library.update(cx, |library, cx| {
                        library.set_open_song(Some(project.name.clone().into()), cx)
                    });
                    let grid_view = self.metronome.grid;
                    self.metronome = project.metronome.clone();
                    self.metronome.grid = grid_view;
                    if let Some(backend) = &self.backend {
                        if let Err(error) =
                            backend.adopt_metronome_preferences(epoch, self.metronome.clone())
                        {
                            // Audio already accepted this project. A preference
                            // queue/storage warning must not roll that audio back.
                            self.notice =
                                Some(format!("Could not retain metronome preferences: {error}"));
                        }
                    }
                    self.beats = project.beat.clone();
                    self.paint_beats = self.beats.as_ref().map(|g| Rc::new(g.clone()));
                    self.metronome_flight.metronome.cancel();
                    self.metronome_flight.metronome_accepted = 0;
                    self.metronome_flight.metronome_requested = None;
                    self.beat_job = None;
                    self.beat_result = None;
                    self.beat_auto_serials.clear();
                    self.beat_auto_save = false;
                    self.beat_mutation = 0;
                    self.transport_flight.count_in_anchor = None;
                    self.transport_flight.counting_in = false;
                    self.transport_flight.timing_status = Some(status.clone());
                    self.analysis_progress = project.pitch.warning.as_deref().filter(|warning|*warning=="Analyzing song…").map(|_|0.);
                    self.metronome_ui.update(cx, |s, cx| {
                        s.adopt(self.metronome.clone(), self.beats.clone(), cx)
                    });
                    self.metronome_open = false;
                    self.master_volume = project.master;
                    self.looping = project.looping;
                    self.transpose = project.transpose;
                    self.tempo = project.tempo;
                    self.header.update(cx, |header, cx| {
                        header.set_output_label(status.output_label.clone(), cx)
                    });
                    self.native_rate = status.rate;

                    let (s, e) = project.view.unwrap_or((0., status.duration));
                    if status.duration>0.{self.view_start=(s/status.duration).clamp(0.,0.999);self.view_end=(e/status.duration).clamp(self.view_start+0.001,1.);}else{self.view_start=0.;self.view_end=1.;}
                    self.karaoke = false;
                    self.lyric_document = project.lyrics.clone().unwrap_or_default();
                    self.lyric_ai_note_top.set(-1.);
                    self.native_glows.borrow_mut().clear();
                    *self.layout_cache.borrow_mut() = None;
                    self.shape_cache.borrow_mut().clear();
                    self.lyric_active.set(usize::MAX);
                    self.lyric_scroll.set(0.);
                    self.lyric_scroll_target.set(0.);
                    self.lyric_horizontal.set(false);
                    self.lyric_scroll_geometry.set(Default::default());
                    self.lyric_scroll_handle.set_offset(point(px(0.), px(0.)));
                    let mut envelopes: [Vec<f32>; tracks::LANE_SLOTS] = std::array::from_fn(|_| vec![0.]);
                    for (lane, (i, _)) in project.lanes.iter().enumerate() {
                        if let Some(peaks) = peaks.get(lane).filter(|p| !p.is_empty()) {
                            envelopes[*i] = peaks.clone();
                        }
                    }
                    waveform::set_project_peaks(envelopes);
                    self.transport.update(cx, |transport, cx| {
                        transport.set_duration(status.duration, cx);
                        transport.set_audio_available(project.has_audio(),cx);
                        transport.set_native_mix(project.master, cx);
                        transport.set_karaoke(self.karaoke, cx);
                        transport.set_split_state(
                            !project.original,
                            project.raw["songFile"].is_string(),
                            !project.original
                                && project.lanes.iter().any(|(i, _)| *i == 0)
                                && project.raw["settings"]["leadVocalSeparated"] != true,
                            cx,
                        );
                    });
                    self.pitch_strip.update(cx, |pitch, cx| {
                        pitch.set_native(project.pitch.clone(), cx);
                        pitch.set_effects(status.rate, status.transpose, cx);
                    });
                    self.project = Some(project);
                    self.opened_carry(&status,cx);
                    self.sidebar_context(cx);
                    if !self.lyric_document.lines.is_empty(){self.sidebar_ready(None,cx);}
                    else if let Some(error)=self.project.as_ref().and_then(|p|p.lyrics_error.clone()){self.lyrics_sidebar.update(cx,|s,cx|s.failure(error,cx));}
                    else{self.lyrics_sidebar.update(cx,|s,cx|s.idle(cx));}
                    if resume.is_none() {
                        // Source loadPath clears selection before restoring it,
                        // even when the new song has identical saved bounds.
                        self.restart_cycle.reset();
                        self.screen = Screen::Player;
                        self.songs_catalog = false;
                    }
                    self.started = Instant::now();
                    self.lane_entered=self.project.as_ref().unwrap().lane_specs.iter().map(|lane|(lane.id.clone(),self.started)).collect();
                    let mute_karaoke_guide=resume.as_ref().is_none_or(|handoff|handoff.mode.is_some());
                    if let Some(resume) = resume {
                        self.resume_project_audio(resume, cx);
                    }
                    // Fresh loads/splits enter Karaoke. Same-song rename/import/
                    // deletion recovery keeps its restored mixer, including a
                    // guide the user deliberately unmuted while Karaoke was on.
                    self.restore_karaoke(mute_karaoke_guide,cx);
                    if let Some(handoff) = split_handoff.filter(|handoff| handoff.continue_after_acceptance(epoch))
                    {
                        // The six lanes are now accepted and remain useful even
                        // if the subsequent vocal separation fails or is cancelled.
                        self.source_job = Some(handoff.retired_job);
                        self.source_split = Some(source_jobs::Mode::Stems);
                        self.source_split_combined = true;
                        self.source_combined_next = Some((epoch, handoff.retired_job));
                    } else {
                        self.start_beat_detection(false, cx);
                    }
                }
                integration::Event::Status(epoch,status)=>self.playback_status(epoch,status,cx),
                integration::Event::Metronome(epoch, serial, met, beat, result)
                    if epoch == self.native_epoch =>
                {
                    let latest = self.metronome_flight.metronome.is_current(serial);
                    let auto_save = self.beat_auto_serials.remove(&serial);
                    match result {
                        Ok(_) if serial > self.metronome_flight.metronome_accepted => {
                            self.beat_auto_save |= auto_save;
                            self.metronome_flight.metronome_accepted = serial;
                            if self.metronome != met || self.beats != beat {
                                self.edit_seq += 1;
                            }
                            self.metronome = met;
                            self.beats = beat;
                            self.paint_beats = self.beats.as_ref().map(|g| Rc::new(g.clone()));
                        }
                        Err(e) if latest => self.notice = Some(e),
                        _ => {}
                    }
                    // Older successes are still the engine's accepted state. Only
                    // the latest response settles or rolls back optimistic controls.
                    if latest {
                        self.metronome_flight.metronome.settle_serial(serial);
                        self.metronome_flight.metronome_requested = None;
                        self.metronome_ui.update(cx, |s, cx| {
                            s.adopt(self.metronome.clone(), self.beats.clone(), cx)
                        });
                    }
                }
                integration::Event::ImportedLibrary(epoch,outcome,status) if epoch==self.native_epoch=>{
                    if let Some(mut pending)=self.import_pending.take().filter(|p|p.epoch==epoch){
                        self.library_import_open=false;
                        self.library_import.update(cx,|s,cx|s.set_busy(false,cx));
                        if let Some(status)=&status{pending.resume.position=status.position;pending.resume.playing=status.playing;}
                        if !outcome.imported&&pending.mode==project_import::Mode::Copy&&status.is_some(){
                            let status=status.unwrap();self.playing=status.playing;
                            self.playhead.reset(status.position);
                            self.playhead.admit((&status).into(), Instant::now());
                            self.settings.update(cx, |settings, cx| settings.set_playback_status(Some(&status), cx));
                            self.native_graph=status.graph_generation;

                        }else{
                            // Source handleImport reanchors song.path; its keyed
                            // SongOutput remounts before adopting the new mix.
                            if self.project.as_ref().is_some_and(|project|project.dir!=outcome.dir) {
                                self.transport.update(cx,|transport,cx|transport.reset_song_output(cx));
                            }
                            self.open_source_output(source_jobs::Output{publication_hash:None,path:outcome.dir.clone(),working:false,target:None},Some(pending.resume),cx);
                        }
                        if let Some(warning)=outcome.warning {self.notice=Some(warning);}
                        else if outcome.imported {
                            let message=if outcome.moved {format!("Moved into your library — the project now lives in {}",outcome.dir.display())}
                                else {format!("Copied into your library — {}. The original folder is untouched.",outcome.dir.display())};
                            self.success_toast.update(cx,|s,cx|s.show(message,cx));
                        }
                        if let Some(backend)=&self.backend{backend.catalog();}
                        cx.notify();
                    }
                }
                integration::Event::Renamed(epoch, dir, warning, identity)
                    if epoch == self.native_epoch =>
                {
                    if let Some(mut pending) =
                        self.rename_pending.take().filter(|p| p.epoch == epoch)
                    {
                        if let Some((name, hash)) = identity {
                            pending.resume.title = Some(name);
                            if pending.working {
                                pending.target = Some(source_jobs::Target {
                                    dir: dir.clone(),
                                    fingerprint: hash,
                                    lyrics_fingerprint: pending.target.as_ref().and_then(|t|t.lyrics_fingerprint.clone()),
                                });
                            }
                        } else if pending.working {
                            if let Some(target) = &mut pending.target {
                                target.dir = dir.clone();
                            }
                        }
                        let path = if pending.working {
                            pending.active_dir
                        } else {
                            dir
                        };
                        // A metadata-only working rename leaves song.path
                        // intact; a successful directory move reanchors it.
                        if self.project.as_ref().is_some_and(|project|project.dir!=path) {
                            self.transport.update(cx,|transport,cx|transport.reset_song_output(cx));
                        }
                        self.open_source_output(
                            source_jobs::Output {
                                publication_hash: None,
                                path,
                                working: pending.working,
                                target: pending.target,
                            },
                            Some(pending.resume),
                            cx,
                        );
                        self.notice = warning;
                        if let Some(backend) = &self.backend {
                            backend.catalog();
                        }
                    }
                }
                integration::Event::LyricsEnvelope(epoch,serial,result) if epoch==self.native_epoch && self.lyrics_editor_open && serial==self.lyrics_editor_generation => {
                    match result {
                        Ok(envelopes)=>{self.lyrics_editor.update(cx,|s,cx|s.envelopes(envelopes.coarse.clone(),envelopes.fine.clone(),cx));self.lyrics_envelope_cache=Some(envelopes);},
                        Err(e)=>self.lyrics_editor.update(cx,|s,cx|{s.error=Some(format!("Could not read the vocal waveform: {e}"));cx.notify();}),
                    }
                }
                integration::Event::LyricsCapabilities(caps)=>{self.lyrics_precise_cap=caps.can_precise;self.lyrics_editor.update(cx,|s,cx|s.precise_cap(caps.can_precise,cx));self.sidebar_context(cx);},
                #[cfg(feature="ui-tests")]
                integration::Event::LyricsJobSettled(epoch,serial)=>{self.lyrics_sidebar_settled.push((epoch,serial));if self.lyrics_sidebar_settled.len()>128{self.lyrics_sidebar_settled.remove(0);}},
                integration::Event::LyricsSearch(epoch,serial,result) if epoch==self.native_epoch&&self.lyrics_flight.lyrics_search_pending.settle(epoch,serial).is_some()=>{
                    self.lyrics_flight.lyrics_search_pending.cancel();self.lyrics_sidebar.update(cx,|s,cx|s.search_results(result.unwrap_or_else(|e|{eprintln!("Lyrics search: {e}");vec![]}),cx));
                },
                integration::Event::LyricsResolved(epoch,serial,result) if epoch==self.native_epoch&&self.lyrics_flight.lyrics_sidebar.key()==Some((epoch,serial))=>self.sidebar_resolved(result,cx),
                integration::Event::LyricsAlignmentProgress(epoch,serial,progress) if self.lyrics_flight.lyrics_sidebar.key()==Some((epoch,serial))=>self.sidebar_progress(epoch,serial,progress,cx),
                integration::Event::LyricsAlignmentProgress(epoch,serial,progress) if self.lyrics_flight.lyrics_alignment.current().is_some_and(|(e,s,&(g,_))|e==epoch&&s==serial&&g==self.lyrics_editor_generation)&&epoch==self.native_epoch&&self.lyrics_editor_open=>{
                    let label=lyrics_editor::copy(match progress.stage.as_str(){"downloading-model"=>"stage.downloadingModel","transcribing"=>"stage.transcribing","searching"=>"stage.searching",_=>"stage.preparing"});
                    self.lyrics_editor.update(cx,|s,cx|s.alignment_progress(label,progress.percent,cx));
                }
                integration::Event::LyricsAligned(epoch,serial,result) if self.lyrics_flight.lyrics_alignment.current().is_some_and(|(e,s,&(g,_))|e==epoch&&s==serial&&g==self.lyrics_editor_generation)&&epoch==self.native_epoch&&self.lyrics_editor_open=>{
                    let (_,_,(_,revision))=self.lyrics_flight.lyrics_alignment.take().unwrap();
                    match result {
                        Ok(output)=>{
                            for warning in &output.warnings{eprintln!("Lyrics alignment: {warning}");}
                            if self.lyrics_editor.read(cx).revision()!=revision {
                                self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some("The draft changed while alignment was running. Align again to use your latest words.".into()),cx));
                            } else {
                                let check=lyrics_edit::AlignCheck{method:output.check.method,verdict:output.check.verdict.clone(),matched_pct:output.check.matched_pct,bad_lines:output.check.bad_lines,extra_sung:output.check.extra_sung};
                                self.lyrics_editor.update(cx,|s,cx|s.aligned((check.verdict!="mismatch").then_some(output.lines),Some(check),None,cx));
                            }
                        }
                        Err(lyrics_align::Failure::NeedsModel(needs))=>{
                            let mb=needs.iter().map(|n|n.size_mb).sum();let precise=needs.iter().any(|n|n.id=="aligner");self.lyrics_needs=needs;
                            self.lyrics_editor.update(cx,|s,cx|s.needs_model(precise,mb,precise,cx));
                        }
                        Err(lyrics_align::Failure::Cancelled)=>self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,None,cx)),
                        Err(e)=>self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some(e.to_string()),cx)),
                    }
                }
                integration::Event::LyricsSaved(epoch,serial,result) if epoch==self.native_epoch && self.lyrics_flight.lyrics_editor_pending.settle(epoch,serial).is_some() => {
                    self.lyrics_flight.lyrics_editor_pending.cancel();
                    match result {
                        Ok(saved)=>{
                            let document=saved.document;let fingerprint=saved.fingerprint;
                            if let Some(project)=&mut self.project{project.lyrics_raw=Some(saved.raw);project.has_lyrics=true;}
                            for warning in saved.warnings{eprintln!("Lyrics: {warning}");self.notice=Some(warning);}
                            self.beat_mutation+=1;self.beat_job=None;self.beat_result=None;
                            if let Some(backend)=&self.backend{backend.cancel_beat_detection();}
                            if let Some(project)=&mut self.project {project.lyrics=Some(document.clone());project.lyrics_error=None;project.lyrics_fingerprint=fingerprint;}
                            self.lyric_document=document;
                            self.lyric_horizontal.set(false);
                            self.lyric_scroll_geometry.set(Default::default());
                            self.native_glows.borrow_mut().clear();self.shape_cache.borrow_mut().clear();*self.layout_cache.borrow_mut()=None;
                            self.lyric_active.set(0);self.lyric_scroll.set(0.);self.lyric_scroll_target.set(0.);self.lyric_scroll_handle.set_offset(point(px(0.),px(0.)));
                            self.lyrics_editor.update(cx,|s,cx|s.saved_revision(self.lyrics_editor_save_revision,None,cx));
                            self.sidebar_ready(None,cx);
                            self.start_beat_detection(false,cx);
                        }
                        Err(e)=>self.lyrics_editor.update(cx,|s,cx|s.saved(Some(e),cx)),
                    }
                }
                integration::Event::Saved(epoch, seq, raw, hash, custom, warnings, stamps) if epoch == self.native_epoch => {
                    diagnostics::event("projects","Project mix saved.",diagnostics::Level::Info);
                    self.saving = false;
                    self.saved_seq = seq;
                    if let Some(project) = &mut self.project {
                        if self.edit_seq == seq {
                            project.raw = raw;
                        } else {
                            // An unchanged save keeps the old savedAt, which may be absent:
                            // never replace a known value with null.
                            if !raw["savedAt"].is_null() {
                                project.raw["savedAt"] = raw["savedAt"].clone();
                            }
                            project.raw["stemHashes"] = raw["stemHashes"].clone();
                            project.raw["settings"]["custom"] = raw["settings"]["custom"].clone();
                        }
                        project.metadata_hash = hash;
                        for stored in custom {
                            if let Some(lane)=project.lane_specs.iter_mut().find(|l|l.id==stored.id&&l.custom){
                                lane.file=stored.file;
                                if let Some((_,path))=project.lanes.iter_mut().find(|(slot,_)|*slot==lane.slot){*path=lane.file.clone();}
                            }
                        }
                    }
                    if let Some(project)=&mut self.project{
                        for (id,stamp) in stamps{
                            if let Some(slot)=project.lane_specs.iter().find(|l|l.id==id).map(|l|l.slot){
                                if let Some(ordinal)=project.lanes.iter().position(|(s,_)|*s==slot){if let Some(current)=project.lane_stamps.get_mut(ordinal){*current=stamp;}}
                            }
                        }
                    }
                    if !warnings.is_empty(){self.notice=Some(warnings.join("\n"));}
                }
                integration::Event::Playback(epoch, serial, status) if epoch == self.native_epoch => {
                    if self.transport_flight.native_play.is_current(serial) {
                        self.transport_flight.native_play.cancel();
                    }
                    self.playback_status(epoch,status,cx);
                }
                integration::Event::Rate(epoch,serial,result) => self.rate_changed(epoch,serial,result,cx),
                integration::Event::RateTransportFailed(epoch,serial,error) => self.rate_transport_failed(epoch,serial,error,cx),
                integration::Event::AnalysisStopped(epoch) if epoch==self.native_epoch => {self.analysis_job=None;self.analysis_progress=None;}
                integration::Event::AnalysisStarted(epoch,job) if epoch==self.native_epoch && self.project.is_some() => { self.analysis_job=Some(job);self.analysis_progress=Some(0.); }
                integration::Event::AnalysisProgress(epoch,job,progress) if epoch==self.native_epoch && self.analysis_job==Some(job) && self.analysis_progress.is_some() && progress.is_finite()=> {self.analysis_progress=Some(self.analysis_progress.unwrap_or(0.).max(progress.clamp(0.,1.)));}
                integration::Event::Analyzed(epoch, job, result) if epoch == self.native_epoch && self.analysis_job==Some(job) && self.tracks_flight.tracks_pending.is_none() => {
                    self.analysis_progress=None;
                    self.analysis_job=None;
                    self.accept_project_analysis(result,cx);
                }

                integration::Event::BeatsDetected(epoch, serial, result) if epoch == self.native_epoch => {
                    if self.beat_job.is_some_and(|(id,_,_)|id == serial) {
                        match result {
                            Ok(output) => self.beat_result = Some(output),
                            Err(error) => {
                                self.beat_job = None;
                                self.notice = Some(format!("Beat detection failed: {error}"));
                            }
                        }
                    }
                }
                integration::Event::BeatsProgress(epoch, serial, progress) if epoch == self.native_epoch => {
                    if self.beat_job.is_some_and(|(id,_,_)|id == serial) && progress.is_finite() {self.beat_progress = progress.clamp(0.,1.);}
                }
                integration::Event::SaveFailed(epoch, error) if epoch == self.native_epoch => {
                    diagnostics::event("projects",format!("Save failed: {error}"),diagnostics::Level::Error);
                    self.saving = false;
                    self.notice = Some(if self.metronome_flight.metronome_save_waiting {
                        self.metronome_flight.metronome_save_waiting = false;
                        format!("Queued Save failed: {error}")
                    } else {
                        error
                    });
                }
                integration::Event::Error(epoch, error, severity) if epoch == self.native_epoch => {
                    if let integration::Severity::Refused(command) = &severity {
                        if let integration::RefusedCommand::Seek { target } = command {
                            self.playhead.seek_rejected(*target);
                        }
                        diagnostics::event("audio", error.clone(), diagnostics::Level::Error);
                        self.notice = Some(error);
                        cx.notify();
                        continue;
                    }
                    if self.source_split_handoff.as_ref().is_some_and(|handoff| handoff.epoch == epoch && !handoff.cancelling) {
                        diagnostics::event("audio", error.clone(), diagnostics::Level::Error);
                        self.cancel_source(cx);
                        self.notice = Some(error);
                        cx.notify();
                        continue;
                    }
                    if self.source_split_handoff.as_ref().is_some_and(|handoff| handoff.epoch == epoch) {
                        self.source_split_handoff = None;
                    }
                    if self.source_combined_next.is_some_and(|(owner, _)| owner == epoch) { self.source_combined_next = None; }
                    let rate_save_failed=self.transport_flight.native_rate_save_requested;
                    let rate_navigation=self.transport_flight.native_rate_navigation.take();
                    self.reset_transport_timing(cx);
                    self.transport_flight.native_rate_navigation=rate_navigation;
                    diagnostics::event("audio",error.clone(),diagnostics::Level::Error);
                    self.beat_job = None;
                    self.beat_result = None;
                    self.beat_auto_serials.clear();
                    self.beat_auto_save = false;
                    self.metronome_flight.metronome_requested = None;
                    if let Some(backend) = &self.backend {backend.cancel_beat_detection();}
                    let error = if rate_save_failed {
                        format!("Queued Save did not run because native audio failed before the requested speed was accepted: {error}")
                    } else if self.metronome_flight.metronome_save_requested {
                        format!("Queued Save could not run because native audio failed: {error}")
                    } else if self.metronome_flight.metronome_save_waiting {
                        format!(
                            "Queued Save could not be confirmed after native audio failed: {error}"
                        )
                    } else {
                        error
                    };
                    self.metronome_flight.metronome.cancel();
                    self.metronome_flight.metronome_save_requested = false;
                    self.metronome_flight.metronome_save_waiting = false;
                    self.transport_flight.counting_in = false;
                    self.transport_flight.count_in_anchor = None;
                    self.metronome_open = false;
                    // Keep deferred navigation until this failure is acknowledged.
                    if let Some(backend) = &self.backend {
                        self.native_epoch = backend.current_epoch();
                    }
                    self.loading = false;
                    self.saving = false;
                    self.playing = false;
                    self.playhead.stop_projection();
                    self.reset_carry(cx);
                    self.loaded_song = false;
                    self.stop_training(cx);
                    self.retain_source_edits();
                    if let Some((_, _, _, _, path)) = self.source_pending.take() {
                        source_jobs::discard_pending_working_copy(&path, None,
                            self.project.as_ref().filter(|_| self.source_writer_busy()).map(|project| project.dir.as_path()));
                    }
                    if self.source_working {
                        if let Some(project) = &self.project {
                            if self.source_writer_busy() {
                                // Keep a writer's source until that job retires.
                                self.source_pending = Some((epoch, true, self.source_target.clone(), None, project.dir.clone()));
                            } else { source_jobs::discard_working_copy(&project.dir); }
                        }
                    }
                    self.project = None;
                    self.settings.update(cx, |settings, cx| settings.set_playback_status(None, cx));
                    self.lyric_document = Arc::default();
                    self.native_glows.borrow_mut().clear();
                    self.shape_cache.borrow_mut().clear();
                    *self.layout_cache.borrow_mut() = None;
                    self.lyric_hits.borrow_mut().clear();
                    self.enter_desktop_catalog(cx);
                    self.notice = Some(error);
                }
                _ => {}
            }
            if telemetry_before.is_none_or(|before| before != self.telemetry_signature()) {
                cx.notify();
            }
        }
        let song = self
            .project
            .as_ref()
            .filter(|project| !self.loading&&project.has_audio()&&!self.tracks_audio_failed)
            .map(|project| training_preparation::Song {
                source: self.native_epoch,
                name: project.name.clone(),
                key: training_preparation::effective_key(
                    &project.raw["settings"]["key"],
                    self.transpose,
                ),
                transpose: self.transpose,
            });
        self.training
            .update(cx, |screen, cx| screen.set_song(song, cx));
        self.sync_microphone(cx);
        self.sync_audio_provider(cx);
        self.poll_practice(cx);
        self.poll_training_recording(cx);
        self.poll_training_store(cx);
        self.poll_models(cx);
        self.poll_lyrics_download(cx);
        self.poll_sidebar_download(cx);
        self.flush_sidebar_after(cx);
        self.poll_drive(cx);
        self.poll_project_library(cx);
        self.poll_sources(cx);
        self.poll_stem_export(cx);
        self.poll_engine_setup(cx);
        self.poll_diagnostics(cx);
        self.poll_project_delete(cx);
        self.flush_beat_detection(cx);
        self.flush_rate_intents(cx);
        self.flush_metronome_intents(cx);
        self.flush_carry(cx);
        self.flush_carry_navigation(cx);
        self.pump_output_meter(cx);
    }
    fn open_models(&mut self, origin: models::Origin, cx: &mut Context<Self>) {
        if self.engine_setup.read(cx).is_open(){self.close_engine_setup(cx);}
        if self.screen != Screen::Models {
            self.previous_screen = if matches!(self.screen, Screen::Settings | Screen::Log) {
                self.previous_screen
            } else {
                self.screen
            };
            self.screen = Screen::Models;
            self.pause_practice(cx);
            self.models.update(cx, |m, cx| m.on_open(origin, cx));
        }
        if let Some(service) = &self.model_service {
            let snapshot = service.snapshot();
            self.models
                .update(cx, |m, cx| m.update_status(snapshot, cx));
            if origin == models::Origin::Auto {
                self.models.update(cx, |m, _| m.requested(None));
                if let Err(error) = service.download(None) {
                    self.models
                        .update(cx, |m, cx| m.failure(error.to_string(), cx));
                }
            } else {
                service.refresh();
            }
        }
        cx.notify();
    }
    fn close_models(&mut self, cx: &mut Context<Self>) {
        if models::cancel_on_close(
            self.models.read(cx).origin,
            self.model_service.as_ref().is_some_and(|s| s.is_running()),
        ) {
            if let Some(service) = &self.model_service {
                service.cancel();
            }
        }
        self.screen = self.previous_screen;
        if self.source_job.is_none() {
            if let Some(service) = &self.source_service {
                let _=service.check();
            }
        }
        cx.notify();
    }
    fn poll_models(&mut self, cx: &mut Context<Self>) {
        let Some(service) = &self.model_service else {
            return;
        };
        let snapshot = service.snapshot();
        if snapshot.revision != self.model_revision {
            self.model_revision = snapshot.revision;
            self.models
                .update(cx, |m, cx| m.update_status(snapshot.clone(), cx));
            if !snapshot.busy
                && snapshot.error.is_none()
                && snapshot
                    .rows
                    .iter()
                    .any(|r| r.entry.id == "gpu-splitter" && r.present)
                && self.source_job.is_none()
            {
                if let Some(service) = &self.source_service {
                    let _=service.check();
                }
                if let Some(backend)=&self.backend{backend.lyrics_capabilities();}
            }
        }
        if snapshot.loaded && !self.model_auto_checked && !self.engine_setup.read(cx).is_open() {
            self.model_auto_checked = true;
            if std::env::var_os("SINGZ_GPUI_BACKGROUND").is_none()
                && snapshot.error.is_none()
                && !snapshot.required_done()
            {
                self.open_models(models::Origin::Auto, cx);
            }
        }
        if self.screen == Screen::Models && self.models.read(cx).auto_done() {
            self.close_models(cx);
        }
        self.poll_release_highlights(cx);
        self.maybe_open_quick_start(std::env::var_os("SINGZ_GPUI_BACKGROUND").is_none(), cx);
    }
    fn maybe_open_quick_start(&mut self, allowed: bool, cx: &mut Context<Self>) {
        if allowed
            && !self.project_delete.read(cx).is_open()
            && self.delete_flight.delete_inspect.is_none()
            && self.release_startup_ready && self.release_pending.is_none() && !self.whats_new.read(cx).is_open()
            && self.model_auto_checked
            && !matches!(self.screen, Screen::Models | Screen::Settings | Screen::Log)
            && self.notice.is_none()
            && !self.lyrics_editor_open
            && !self.project_picker_open && !self.drive_projects_open
            && !self.library_import_open && !self.stem_export_open
            && !self.engine_setup.read(cx).is_open()
            && !self.loading
            && self.source_job.is_none()
            && self.quick_start.read(cx).pending_welcome()
            && self.quick_start.read(cx).anchors.get("settings").is_some()
        {
            self.open_quick_start(true, cx);
        }
    }
    fn sync_microphone(&mut self, cx: &mut Context<Self>) {
        let available = self.backend.is_some()
            && !self.loading
            && !self.monitor_busy()
            && self.training_output_ready()
            && self.notice.is_none();
        self.training
            .update(cx, |s, cx| s.set_audio_available(available, cx));
        if self.screen != Screen::Training || !available {
            self.pause_practice(cx);
        }
        if self.screen != Screen::Settings {
            self.mic_permission_requested = false;
        }
        // Confirmed monitoring owns its route independently of the Settings
        // preview; its persistent header Stop stays available on other screens.
        if self.notice.is_some() || self.loading {
            self.monitor_flight.monitor_requested = false;
        }
        let Some(service) = &self.microphone else {
            return;
        };
        let settings = self.screen == Screen::Settings
            && gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").is_none();
        let player = self.screen == Screen::Player
            && self.project.is_some()
            && !self.loading
            && self.karaoke
            && self.mic_requested;
        let snapshot = service.snapshot();
        let was_monitor = self.mic_intent.as_ref().is_some_and(|i| i.monitor);
        if self.monitor_flight.monitor_requested
            && was_monitor
            && matches!(
                snapshot.phase,
                microphone::Phase::Error | microphone::Phase::Permission | microphone::Phase::Off
            )
        {
            self.monitor_flight.monitor_requested = false;
            self.settings.update(cx, |s, cx| {
                s.set_monitor_state(true, snapshot.error.clone(), cx)
            });
        }
        let busy = self.monitor_busy();
        let intent = if busy {
            if self.monitor_flight.monitor_requested
                && self.monitor_flight.monitor_parked
                && self.monitor_flight.monitor.is_none()
                && (was_monitor
                    || (self.mic_intent.is_none() && snapshot.phase == microphone::Phase::Off))
            {
                Some(microphone::Intent {
                    prefs: self.mic_prefs.clone(),
                    request_permission: true,
                    owner: 3,
                    serial: self.mic_serial,
                    monitor: true,
                })
            } else {
                None
            }
        } else if self.mic_prefs_valid
            && self.notice.is_none()
            && (settings
                || player
                || self.screen == Screen::Training
                    && self.practice.as_ref().is_some_and(|r| r.needs_microphone()))
        {
            let mut prefs = self.mic_prefs.clone();
            prefs.monitor_output.clear();
            prefs.outputs = [0, 1];
            prefs.gain = -18.;
            prefs.headphones = false;
            Some(microphone::Intent {
                prefs,
                request_permission: if settings {
                    self.mic_permission_requested
                } else {
                    true
                },
                owner: if settings {
                    1
                } else if player {
                    2
                } else {
                    training_capture::TRAINING_OWNER
                },
                serial: self.mic_serial,
                monitor: false,
            })
        } else {
            None
        };
        if let (Some(previous), Some(next)) = (&self.mic_intent, &intent) {
            if previous.monitor && next.monitor {
                let mut equalized = previous.clone();
                equalized.prefs.gain = next.prefs.gain;
                if equalized == *next && previous.prefs.gain != next.prefs.gain {
                    if let Err(error) = service.gain(next.prefs.gain) {
                        self.notice = Some(error.to_string());
                    } else {
                        self.mic_intent = intent.clone();
                    }
                }
            }
        }
        let mut cleanup_error = None;
        if self.mic_intent != intent {
            let result = if let Some(intent) = &intent {
                service.start(intent.clone())
            } else {
                service.stop()
            };
            match result {
                Ok(()) => self.mic_intent = intent,
                Err(error) => {
                    if was_monitor && intent.is_none() {
                        self.monitor_flight.monitor_actions.clear();
                        cleanup_error = Some(error.to_string());
                    } else {
                        self.notice = Some(error.to_string());
                    }
                }
            }
        }
        let mut view = service.snapshot();
        if let Some(error) = cleanup_error {
            self.cancel_deferred_rate(error, cx);
        }
        if busy
            && self.mic_intent.is_none()
            && view.phase == microphone::Phase::Off
            && self.monitor_flight.monitor.is_none()
        {
            let target = self.monitor_flight.monitor_requested;
            if target != self.monitor_flight.monitor_parked {
                let serial = self.monitor_flight.monitor.reserve();
                match self
                    .backend
                    .as_ref()
                    .unwrap()
                    .park(self.native_epoch, serial, target)
                {
                    Ok(()) => self.monitor_flight.monitor.activate(self.native_epoch, serial, target),
                    Err(error) => {
                        self.monitor_flight.monitor_requested = false;
                        self.monitor_flight.monitor_actions.clear();
                        self.cancel_deferred_rate(error.to_string(), cx);
                    }
                }
            }
        }
        self.settings.update(cx, |s, cx| {
            s.set_monitor_state(self.monitor_busy(), None, cx)
        });
        if !self.monitor_busy() {
            self.restore_monitor_publication(cx);
            while let Some(action) = self.monitor_flight.monitor_actions.front() {
                // Open and typed rate preparation complete asynchronously. Keep
                // later commands until the new connection or accepted rate is
                // ready instead of popping them into dispatch guards.
                if self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some() { break; }
                if self.loading || self.audio_recovery.is_some() || self.monitor_flight.monitor_publication_epoch.is_some() || self.notice.is_some() {
                    break;
                }
                let ready_rate = matches!(action, DeferredAudio::Rate(_, _))
                    && self.transport_flight.native_rate_pending.is_none()
                    && self.transport_flight.native_rate_queued.is_none();
                if self.rate_busy() && !ready_rate {
                    break;
                }
                let action = self.monitor_flight.monitor_actions.pop_front().unwrap();
                match action {
                    DeferredAudio::Rate(rate, transpose) => {
                        self.dispatch_deferred_rate(rate, transpose, cx)
                    }
                    DeferredAudio::Region(epoch) => {
                        if epoch==self.native_epoch {self.dispatch_region(cx);}
                    }
                    DeferredAudio::Command(command) => self.native_command(command, cx),
                    DeferredAudio::Seek(position) => {
                        self.playhead.seek(position);
                        self.seek_native(cx);
                    }
                    DeferredAudio::Output(uid) => self.select_output(uid, cx),
                    DeferredAudio::Open(path) => self.open_project(path, cx),
                    DeferredAudio::SourceOutput(output, mut resume, epoch) => {
                        if epoch == self.native_epoch {
                            if let (Some(resume), Some(project)) = (&mut resume, &self.project) {
                                // Cleanup can take long enough for accepted mix
                                // edits to supersede the source-job snapshot.
                                resume.mix = self.current_mix(project);
                                resume.position = self.playhead.position();
                                resume.dirty |= self.edit_seq != self.saved_seq;
                            }
                        }
                        self.open_source_output(output, resume, cx)
                    }
                }
            }
        }
        if let Some(error) = &self.mic_pref_error {
            view.phase = microphone::Phase::Error;
            view.error = Some(error.clone());
        }
        if view.revision != self.mic_view.revision
            || view.phase != self.mic_view.phase
            || view.error != self.mic_view.error
        {
            self.mic_view = view.clone();
            self.settings
                .update(cx, |settings, cx| settings.set_microphone(view.clone(), cx));
            let pitch_view = if self.screen == Screen::Player {
                view
            } else {
                Default::default()
            };
            self.pitch_strip.update(cx, |pitch, cx| {
                pitch.set_microphone(pitch_view, self.playhead.position(), self.playing, cx)
            });
            cx.notify();
        }
    }
    fn native_command(&mut self, command: String, cx: &mut Context<Self>) {
        let play_intent = match command.as_str() {"play"|"play-flat"=>Some(true),"pause"=>Some(false),_=>None};
        if play_intent==Some(false) {self.region.play_requested=false;}
        let serial=self.transport_flight.native_play.serial()+1;
        if play_intent==Some(false) && (self.rename_pending.is_some()
            || self.import_pending.as_ref().is_some_and(|pending|pending.mode==project_import::Mode::Move)) {
            // These operations already retire the old helper. Their new epoch
            // has no playback connection yet, so retain the user's Pause as
            // semantic intent rather than sending it to an unavailable graph.
            self.transport_flight.native_play.retire_at(serial);
            if self.playing {self.restart_cycle.reset();}
            self.playing=false;self.playhead.stop_projection();cx.notify();return;
        }
        if self.defer_monitor(DeferredAudio::Command(command.clone()), cx) {
            if self.notice.is_none() {if let Some(target)=play_intent {self.transport_flight.native_play.begin_at(self.native_epoch,serial,target);if self.playing!=target {self.restart_cycle.reset();}if target {self.playhead.play_intent(Instant::now());} else {self.playhead.pause_intent(Instant::now());}self.playing=target;}}
            return;
        }
        if !self.audio_available()&&!command.starts_with("master ")&&!command.starts_with("rate "){return;}
        if (command != "pause" && (self.loading || self.source_blocks_except_rate())) || self.project.is_none() {
            return;
        }
        if let Some(backend) = &self.backend {
            let edited = command.starts_with("lane ")
                || command.starts_with("master ")
                || command.starts_with("loop ")
                || command.starts_with("rate ")
                || command == "unloop";
            let result=if play_intent.is_some(){backend.playback(self.native_epoch,serial,command)}else{backend.control(self.native_epoch,command)};
            match result {
                Ok(()) => {
                    if let Some(target)=play_intent {self.transport_flight.native_play.begin_at(self.native_epoch,serial,target);if self.playing!=target {self.restart_cycle.reset();}if target {self.playhead.play_intent(Instant::now());} else {self.playhead.pause_intent(Instant::now());}self.playing=target;}
                    if edited {
                        self.edit_seq += 1;
                    }
                }
                Err(error) => {
                    self.notice = Some(error.to_string());
                    cx.notify();
                }
            }
        }
    }
    fn test_training(&mut self, sound: usize, volume: f32, cx: &mut Context<Self>) {
        if self.screen != Screen::Training
            || self.loading
            || self.monitor_busy()
            || self.notice.is_some()
            || !self.training_output_ready()
        {
            return;
        }
        self.stop_training(cx);
        let Some(backend) = &self.backend else {
            return;
        };
        self.training_serial += 1;
        let instrument = match sound {
            0 => training_audio::Instrument::Piano,
            1 => training_audio::Instrument::Electric,
            2 => training_audio::Instrument::Guitar,
            _ => training_audio::Instrument::Organ,
        };
        let phrase = training_audio::Phrase {
            generation: self.training_serial,
            instrument,
            gain: volume,
            timing: Some(training_audio::Timing {
                note_duration: 2.75,
                attack: 0.032,
                release: 0.22,
                ..Default::default()
            }),
            cues: vec![training_audio::Cue {
                purpose: training_audio::Purpose::Answer,
                together: false,
                notes: vec![60],
            }],
        };
        match backend.training_phrase(self.native_epoch, &phrase) {
            Ok(()) => {
                self.training_test = Some(phrase.generation);
                self.training
                    .update(cx, |s, cx| s.test_state(true, None, cx));
            }
            Err(error) => self
                .training
                .update(cx, |s, cx| s.test_state(false, Some(error.to_string()), cx)),
        }
    }
    fn start_practice(&mut self, config: Option<training_domain::Config>, cx: &mut Context<Self>) {
        if self
            .training_store
            .as_ref()
            .is_some_and(|store| !store.snapshot().loaded)
        {
            self.training.update(cx, |screen, cx| {
                screen.test_state(
                    false,
                    Some("Saved training settings are still loading. Try Start again.".into()),
                    cx,
                )
            });
            return;
        }
        if self.screen != Screen::Training
            || self.backend.is_none()
            || self.loading
            || self.monitor_busy()
            || !self.training_output_ready()
        {
            return;
        }
        let seed = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .unwrap_or_default()
            .as_nanos()
            .to_string();
        let mut config = config.unwrap_or_else(|| self.training.read(cx).config(seed.clone()));
        config.seed = seed;
        let (sound, volume, tolerance) = self.training.read(cx).practice_settings();
        self.stop_training(cx);
        self.training
            .update(cx, |screen, cx| screen.test_state(false, None, cx));
        self.mic_serial += 1;
        match training_run::Run::new(config, sound, volume, tolerance) {
            Ok(mut run) => {
                if run.needs_microphone() && !self.mic_prefs_valid {
                    run.fail(self.mic_pref_error.clone().unwrap_or_else(|| {
                        "Review the saved microphone device in Settings.".into()
                    }));
                }
                self.training
                    .update(cx, |s, cx| s.set_run(Some(run.snapshot()), cx));
                self.practice = Some(run);
            }
            Err(error) => self
                .training
                .update(cx, |s, cx| s.test_state(false, Some(error.to_string()), cx)),
        }
    }
    fn record_completed_practice(&mut self) {
        let (Some(run), Some(store)) = (&self.practice, &self.training_store) else {
            return;
        };
        if run.session.state() == training_session::State::Completed
            && self.training_recorded.as_deref() != Some(run.session.id())
        {
            match training_progress::Completion::create(&run.session, training_store::now()) {
                Ok(receipt) => {
                    store.completion(receipt);
                    self.training_recorded = Some(run.session.id().into());
                }
                Err(error) => {
                    eprintln!("Could not normalize completed practice: {error:#}");
                }
            }
        }
    }
    fn poll_training_store(&mut self, cx: &mut Context<Self>) {
        self.record_completed_practice();
        let Some(store) = &self.training_store else {
            return;
        };
        let snapshot = store.snapshot();
        if !snapshot.loaded {
            return;
        }
        if self.training_store_revision != snapshot.revision {
            let initial = self.training_profile_sent.is_none();
            if initial {
                self.training.update(cx, |screen, cx| {
                    screen.restore_profile(&snapshot.preferences, &snapshot.controls, cx)
                });
                self.training_profile_sent =
                    Some((snapshot.preferences.clone(), snapshot.controls.clone()));
            }
            self.training_store_revision = snapshot.revision;
            self.training
                .update(cx, |screen, cx| screen.set_history(snapshot.clone(), cx));
        }
        let profile = self.training.read(cx).profile();
        if self.training_profile_sent.as_ref() != Some(&profile) {
            store.preferences(profile.0.clone(), profile.1.clone());
            self.training_profile_sent = Some(profile);
        }
    }
    fn pause_practice(&mut self, cx: &mut Context<Self>) {
        if self.screen != Screen::Training { self.detach_training_recording(cx); }
        if let Some(run) = &mut self.practice {
            if !matches!(
                run.phase,
                training_run::Phase::Paused | training_run::Phase::Summary
            ) {
                run.pause();
            }
            self.training
                .update(cx, |s, cx| s.set_run(Some(run.snapshot()), cx));
        }
        self.cancel_training_cue(cx);
    }
    fn training_output_ready(&self) -> bool {
        self.project.is_none() || (!self.tracks_audio_failed && self.audio_recovery.is_none()
            && self.source_publication.is_none())
    }
    fn continue_practice(&mut self, cx: &mut Context<Self>) {
        if !self.training_output_ready() || self.monitor_busy() || self.loading || self.notice.is_some() {
            return;
        }
        if let Some(run) = &mut self.practice {
            if run.resume() {
                self.mic_serial += 1;
            }
        }
        cx.notify();
    }
    fn poll_practice(&mut self, cx: &mut Context<Self>) {
        let Some(mut run) = self.practice.take() else {
            return;
        };
        if self.screen == Screen::Training
            && self.notice.is_none()
            && !self.loading
            && !self.monitor_busy()
            && self.training_output_ready()
        {
            match run.tick(&self.mic_view) {
                Ok(Some(plan)) => {
                    self.training_serial += 1;
                    let generation = self.training_serial;
                    let instrument = match run.sound {
                        0 => training_audio::Instrument::Piano,
                        1 => training_audio::Instrument::Electric,
                        2 => training_audio::Instrument::Guitar,
                        _ => training_audio::Instrument::Organ,
                    };
                    let phrase = training_audio::Phrase {
                        generation,
                        instrument,
                        gain: run.volume,
                        cues: plan.cues.clone(),
                        timing: Some(plan.timing),
                    };
                    match self
                        .backend
                        .as_ref()
                        .unwrap()
                        .training_phrase(self.native_epoch, &phrase)
                    {
                        Ok(()) => {
                            self.training_test = Some(generation);
                            run.cue_requested(generation, &plan);
                            self.practice_reached = None;
                        }
                        Err(error) => run.fail(error.to_string()),
                    }
                }
                Ok(None) => {}
                Err(error) => run.fail(error.to_string()),
            }
            if matches!(
                run.phase,
                training_run::Phase::Respond | training_run::Phase::Completing
            ) && run.session.config().task != training_domain::Task::Identify
            {
                let token = (run.displayed_prompt().index, run.target);
                if self.practice_reached != Some(token)
                    && run.live.display_midi.is_some_and(|m| {
                        (m - run.displayed_prompt().targets[run.target].midi as f64).abs() * 100.
                            <= run.tolerance
                    })
                    && self.mic_view.clarity >= 0.75
                {
                    if let (Some(backend), Some(generation)) = (&self.backend, self.training_test) {
                        let _ = backend.control(
                            self.native_epoch,
                            format!("cue-confirm {generation} {}", run.volume),
                        );
                        self.practice_reached = Some(token);
                    }
                }
            }
        }
        if matches!(
            run.phase,
            training_run::Phase::Paused | training_run::Phase::Summary
        ) {
            self.cancel_training_cue(cx);
        }
        self.training
            .update(cx, |s, cx| s.set_run(Some(run.snapshot()), cx));
        self.practice = Some(run);
    }
    fn stop_training(&mut self, cx: &mut Context<Self>) {
        self.detach_training_recording(cx);
        self.record_completed_practice();
        self.practice = None;
        self.practice_reached = None;
        self.training.update(cx, |s, cx| s.set_run(None, cx));
        self.cancel_training_cue(cx);
    }
    fn cancel_training_cue(&mut self, cx: &mut Context<Self>) {
        if let Some(generation) = self.training_test.take() {
            if let Some(backend) = &self.backend {
                if let Err(error) = backend.cancel_training(self.native_epoch, generation) {
                    self.notice = Some(error.to_string());
                }
            }
            self.training
                .update(cx, |s, cx| s.test_state(false, None, cx));
        }
    }
    fn training_status(&mut self, status: &training_audio::Status, cx: &mut Context<Self>) {
        if self.training_test == Some(status.generation) {
            self.training_last = Some(status.clone());
        }
        if let Some(run) = &mut self.practice {
            run.cue_receipt(status);
            return;
        }
        if self.training_test == Some(status.generation)
            && !status.active
            && status.end_host_ns > 0
            && status.now_host_ns
                >= status
                    .end_host_ns
                    .saturating_add((status.output_latency_ms * 1_000_000.) as u64)
        {
            self.stop_training(cx);
        }
    }
    fn open_lyrics_editor(&mut self, _window:&mut Window, cx:&mut Context<Self>){self.open_lyrics_editor_intent(cx);}
    fn open_lyrics_editor_intent(&mut self,cx:&mut Context<Self>){
        if self.loading||self.source_blocks_player()||!self.audio_available()||self.project.is_none(){return;}
        if self.lyrics_flight.lyrics_sidebar.is_some(){self.cancel_sidebar_lyrics(cx);self.lyrics_sidebar_editor_after=true;cx.notify();return;}
        self.cancel_sidebar_lyrics(cx);self.cancel_lyrics_alignment(cx);self.lyrics_editor_generation+=1;
        self.lyrics_editor_epoch=self.native_epoch;
        let project=self.project.as_ref().unwrap();
        // Saved content belongs to the project, independently of sidebar status.
        self.lyrics_editor_credit=project.lyrics_raw.as_ref().and_then(|r|r["credit"].as_str()).map(str::to_owned);
        let lines=if let Some(raw)=project.lyrics_raw.as_ref() {
            match project_lyrics::editor_lines(raw) {
                Ok(lines)=>lines,
                Err(error)=>{self.notice=Some(format!("Could not open saved lyrics: {error}"));cx.notify();return;}
            }
        } else {
            self.lyric_document.lines.iter().map(|l|lyrics_edit::Line{start:l.start as f64,end:l.end as f64,text:l.text.clone(),words:l.words.iter().map(|w|lyrics_edit::Word{w:w.text.clone(),s:w.start as f64,e:w.end as f64}).collect()}).collect()
        };
        let skipped=project.lyrics_raw.as_ref().and_then(|r|r["lines"].as_array()).map_or(0,|rows|rows.len().saturating_sub(lines.len()));
        let notice=(skipped>0).then(||i18n::tv("lyrics.editor.skippedRows",&[("n",skipped.to_string())]));
        self.lyrics_editor.update(cx,|s,cx|{s.open(project.name.clone(),lines,self.duration as f64,self.lyrics_precise_cap,cx);s.set_notice(notice,cx);s.context_playback(self.playhead.position() as f64,self.duration as f64,self.playing,if self.backend.is_some()&&!self.transport_flight.counting_in&&self.playhead.pending_seek().is_none()&&self.capture_file.is_none(){self.playhead.anchor().map(|(p,t)|(p as f64,t))}else{None},self.native_rate as f64,self.playhead.loop_range().map(|(s,e)|(s as f64,e as f64)),cx);});
        self.lyrics_editor_open=true;self.metronome_open=false;self.transport.update(cx,|t,cx|{t.dismiss_popovers(cx);});
        if let Some((_,source))=project.lanes.iter().find(|(i,_)|*i==0){
            if let Some(cache)=self.lyrics_envelope_cache.as_ref().filter(|c|c.source==*source&&Some(c.stamp)==project.vocal_stamp) {
                self.lyrics_editor.update(cx,|s,cx|s.envelopes(cache.coarse.clone(),cache.fine.clone(),cx));
            }else if let Some(backend)=&self.backend {if let Err(e)=backend.lyrics_envelope(self.native_epoch,self.lyrics_editor_generation,project){self.lyrics_editor.update(cx,|s,cx|{s.error=Some(e.to_string());cx.notify();});}}
        }
        if let Some(backend)=&self.backend{backend.lyrics_capabilities();}
        cx.notify();
    }
    fn cancel_lyrics_alignment(&mut self,cx:&mut Context<Self>){
        if let Some(backend)=&self.backend{backend.cancel_lyrics_alignment();}
        if let Some(service)=&self.lyrics_download_service{if service.is_running(){service.cancel();}}
        self.lyrics_flight.lyrics_alignment.cancel();self.lyrics_flight.lyrics_download_pending=None;self.lyrics_needs.clear();
        self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,None,cx));
    }
    fn start_lyrics_alignment(&mut self,precise:bool,download:bool,cx:&mut Context<Self>){
        let tier=if precise{lyrics_align::Tier::Precise}else{lyrics_align::Tier::Align};
        if !self.lyrics_editor_open||self.loading||self.lyrics_editor_epoch!=self.native_epoch||self.lyrics_flight.lyrics_editor_pending.is_some(){return;}
        let revision=self.lyrics_editor.read(cx).revision();
        if download&&!self.lyrics_needs.is_empty(){
            let mut config=model_service::configuration();if !config.fixture{config.flavor=self.lyrics_needs[0].flavor;}
            let ids:Vec<String>=self.lyrics_needs.iter().map(|n|n.id.clone()).collect();
            if !config.fixture{config.entries=model_catalog::registry(config.flavor,env!("CARGO_PKG_VERSION"));}
            config.entries.retain(|e|ids.contains(&e.id));
            let service=model_service::Service::from_config(config);
            // Inventory is asynchronous. Retain the explicit download intent
            // until this service has completed its initial model check.
            self.lyrics_download_service=Some(service);
            self.lyrics_flight.lyrics_download_pending=Some((self.native_epoch,self.lyrics_editor_generation,revision,tier));
            self.lyrics_download_started=false;
            self.lyrics_editor.update(cx,|s,cx|s.alignment_progress(lyrics_editor::copy("stage.downloadingModel"),0.,cx));
            return;
        }
        let draft=lyrics_edit::lines_from_rows(self.lyrics_editor.read(cx).rows(),self.duration as f64);
        if let (Some(backend),Some(project))=(&self.backend,&self.project){
            let serial=self.lyrics_flight.lyrics_alignment.reserve();
            match backend.align_lyrics(self.native_epoch,serial,project,draft,tier){
                Ok(())=>{self.lyrics_flight.lyrics_alignment.activate(self.native_epoch,serial,(self.lyrics_editor_generation,revision));self.lyrics_editor.update(cx,|s,cx|s.alignment_progress(lyrics_editor::copy("stage.preparing"),0.,cx));}
                Err(e)=>self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some(e.to_string()),cx)),
            }
        }
    }
    fn poll_lyrics_download(&mut self,cx:&mut Context<Self>){
        let Some((epoch,generation,revision,tier))=self.lyrics_flight.lyrics_download_pending else{return;};
        if epoch!=self.native_epoch||generation!=self.lyrics_editor_generation||!self.lyrics_editor_open{self.cancel_lyrics_alignment(cx);return;}
        let Some(service)=&self.lyrics_download_service else{return;};let status=service.snapshot();
        if !self.lyrics_download_started {
            if !status.loaded {return;}
            let ids=self.lyrics_needs.iter().map(|n|n.id.clone()).collect();
            match service.download(Some(ids)) {
                Ok(())=>self.lyrics_download_started=true,
                Err(error)=>{
                    self.lyrics_flight.lyrics_download_pending=None;
                    self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some(error.to_string()),cx));
                }
            }
            return;
        }
        if service.is_running()||!status.loaded {
            let progress=if status.progress.is_empty(){0.}else{status.progress.values().sum::<f32>()/status.progress.len() as f32};
            self.lyrics_editor.update(cx,|s,cx|s.alignment_progress(lyrics_editor::copy("stage.downloadingModel"),progress,cx));return;
        }
        self.lyrics_flight.lyrics_download_pending=None;
        if let Some(error)=&status.error {self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some(error.clone()),cx));}
        else if self.lyrics_editor.read(cx).revision()!=revision {self.lyrics_editor.update(cx,|s,cx|s.aligned(None,None,Some("The draft changed during the download. Align again to use your latest words.".into()),cx));}
        else {self.start_lyrics_alignment(tier==lyrics_align::Tier::Precise,false,cx);}
    }
    fn restore_metronome_widget(&mut self, cx: &mut Context<Self>) {
        let (met, grid) = self.metronome_flight.metronome_requested.as_ref().map(|(_,m,g)|(m.clone(),g.clone())).unwrap_or_else(||(self.metronome.clone(),self.beats.clone()));
        self.metronome_ui.update(cx, |s,cx|s.adopt(met,grid,cx));
    }
    fn start_beat_detection(&mut self, explicit: bool, cx: &mut Context<Self>) {
        if !self.audio_available(){return;}
        let Some(project) = &self.project else {return;};
        if self.loading || self.source_blocks_player() || !project.lanes.iter().any(|(i,_)|*i == 1) {return;}
        let desired = if self.metronome_flight.metronome.is_some() {self.metronome_ui.read(cx).grid.as_ref()} else {self.beats.as_ref()};
        if !explicit && !beat_analysis::needed(desired) {return;}
        if let Some(backend) = &self.backend {
            self.beat_job_serial += 1;
            let serial = self.beat_job_serial;
            match backend.detect_beats(self.native_epoch, serial, project) {
                Ok(()) => {self.beat_job = Some((serial, self.beat_mutation, explicit));self.beat_result = None;self.beat_progress = 0.02;}
                Err(e) => self.notice = Some(format!("Cannot start beat detection: {e}")),
            }
        }
        cx.notify();
    }
    fn apply_beat_grid(&mut self, grid: beat::Beats, auto_save: bool, cx: &mut Context<Self>) {
        let before = self.metronome_flight.metronome.serial();
        self.apply_metronome(self.metronome.clone(), Some(grid), cx);
        if auto_save && self.metronome_flight.metronome.serial() > before && self.metronome_flight.metronome.is_current(self.metronome_flight.metronome.serial()) {
            self.beat_auto_serials.insert(self.metronome_flight.metronome.serial());
        }
    }
    fn flush_beat_detection(&mut self, cx: &mut Context<Self>) {
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy()||self.region_busy()){return;}
        if self.metronome_flight.metronome.is_some() || self.loading {return;}
        if let Some(output) = self.beat_result.take() {
            if let Some((serial, mutation, explicit)) = self.beat_job.take() {
                if output.epoch == self.native_epoch && output.revision == serial && mutation == self.beat_mutation
                    && (explicit || beat_analysis::needed(self.beats.as_ref())) {
                    for warning in &output.warnings {eprintln!("Beat analysis: {warning}");}
                    if let Some(mut grid) = output.grid {
                        grid.user_bars = self.beats.as_ref().and_then(|g|g.user_bars.clone());
                        grid = grid.apply_user_bars();
                        self.apply_beat_grid(grid, !explicit, cx);
                    } else if explicit {self.notice = Some("No steady beat found in the drums.".into());}
                }
            }
        }
        if self.beat_auto_save && self.metronome_flight.metronome.is_none() && !self.saving && !self.source_working
            && self.source_job.is_none() && self.rename_pending.is_none() && !self.metronome_flight.metronome_save_requested && !self.metronome_flight.metronome_save_waiting {
            self.save_project(cx);
            if self.saving {self.beat_auto_save = false;self.metronome_flight.metronome_save_waiting = true;}
        }
    }
    fn apply_metronome(
        &mut self,
        met: beat::Metronome,
        beats: Option<beat::Beats>,
        cx: &mut Context<Self>,
    ) {
        if !self.audio_available(){return;}
        if self.backend.is_some()
            && (self.loading
                || self.source_blocks_player()
                || self.monitor_flight.monitor_requested
                || self.project.is_none())
        {
            self.notice =
                Some("Metronome audio cannot change while the current audio owner is busy.".into());
            self.restore_metronome_widget(cx);
            return;
        }
        if self.metronome_flight.metronome.is_none() && self.metronome == met && self.beats == beats {
            return;
        }
        if let Some(backend) = &self.backend {
            let serial = self.metronome_flight.metronome.reserve();
            match backend.metronome(self.native_epoch, serial, met.clone(), beats.clone()) {
                Ok(()) => {
                    self.metronome_flight.metronome.activate(self.native_epoch, serial, ());
                    self.metronome_flight.metronome_requested = Some((serial, met, beats));
                    self.restore_metronome_widget(cx);
                }
                Err(e) => {self.notice = Some(e.to_string());self.restore_metronome_widget(cx);}
            }
        } else {
            self.metronome = met;
            self.beats = beats;
            self.paint_beats = self.beats.as_ref().map(|g| Rc::new(g.clone()));
        }
        cx.notify();
    }
    fn flush_metronome_intents(&mut self, cx: &mut Context<Self>) {
        if self.audio_recovery.is_some() || self.source_publication.is_some() { return; }
        if self.drive_capture_busy(){return;}
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some()||self.rate_busy()){return;}
        if self.metronome_flight.metronome.is_some() {
            return;
        }
        if self.metronome_flight.metronome_save_requested {
            if self.lyrics_flight.lyrics_sidebar.is_some()||self.lyrics_sidebar_download_waiting||self.lyrics_sidebar_editor_after{return;}
            if self.loading
                || self.saving
                || self.library_import_open || self.stem_export_open
                || self.import_pending.is_some()
                || self.lyrics_editor_open
                || self.lyrics_flight.lyrics_editor_pending.is_some()
                || self.source_job.is_some()
                || self.rename_pending.is_some()
            {
                return;
            }
            if self.backend.is_none() || self.project.is_none() {
                self.metronome_flight.metronome_save_requested = false;
                self.notice = Some(
                    "Queued Save could not run because its project is no longer available.".into(),
                );
                cx.notify();
                return;
            }
            self.metronome_flight.metronome_save_requested = false;
            self.save_project(cx);
            if self.saving || self.source_job.is_some() {
                // Wait for completion as well as dispatch. This protects the
                // asynchronous working-copy Save from Open's cancellation path.
                self.metronome_flight.metronome_save_waiting = true;
            } else {
                let error = self
                    .notice
                    .take()
                    .unwrap_or_else(|| "The Save could not be started.".into());
                self.notice = Some(format!("Queued Save failed: {error}"));
            }
            cx.notify();
        }
        if self.metronome_flight.metronome_save_waiting {
            if self.loading
                || self.saving
                || self.source_job.is_some()
                || self.rename_pending.is_some()
            {
                return;
            }
            self.metronome_flight.metronome_save_waiting = false;
        }
        // A second correction may have been accepted during the previous Save.
        // Let the next poll dispatch its Save before releasing queued navigation.
        if self.beat_auto_save && !self.source_working {return;}
        if self.notice.is_some() {
            return;
        }
        if let Some((path, source)) = self.metronome_flight.metronome_navigation.take() {
            if source {
                self.open_source(path, cx);
            } else {
                self.open_project(path, cx);
            }
        }
    }
    fn save_project(&mut self, cx: &mut Context<Self>) {
        if self.audio_recovery.is_some() || self.source_publication.is_some() { return; }
        if self.drive_capture_busy(){self.metronome_flight.metronome_save_requested=true;cx.notify();return;}
        if self.rate_busy(){self.transport_flight.native_rate_save_requested=true;cx.notify();return;}
        if self.carry_flight.carry.is_some(){self.carry_flight.carry_save_requested=true;cx.notify();return;}
        if self.tracks_flight.tracks_pending.is_some(){self.notice=Some("Wait for the track changes before saving.".into());cx.notify();return;}
        if self.project_delete.read(cx).is_open() || self.delete_flight.delete.is_some() { return; }
        // Only an otherwise valid Save can become a deferred intent. A click
        // during an existing load/Save/source operation must not save a later song.
        if self.loading
            || self.saving
            || self.library_import_open || self.stem_export_open
            || self.import_pending.is_some()
            || self.lyrics_editor_open
            || self.lyrics_flight.lyrics_editor_pending.is_some()
            || self.source_job.is_some()
            || self.rename_pending.is_some()
            || self.backend.is_none()
            || self.project.is_none()
        {
            return;
        }
        if self.defer_region_save() {cx.notify();return;}
        if self.source_working&&(self.lyrics_flight.lyrics_sidebar.is_some()||self.lyrics_sidebar_download_waiting){
            self.metronome_flight.metronome_save_requested=true;cx.notify();return;
        }
        if self.metronome_flight.metronome.is_some() {
            self.metronome_flight.metronome_save_requested = true;
            cx.notify();
            return;
        }
        if let (Some(backend), Some(project)) = (&self.backend, &self.project) {
            let mix = self.current_mix(project);
            if self.source_working {
                match project_store::update_mix(project.raw.clone(), &mix) {
                    Ok(raw) => self.start_source(
                        source_jobs::Job::Save {
                            dir: project.dir.clone(),
                            custom: mix.custom.clone(),
                            raw,
                            target: self.source_target.clone(),
                        },
                        cx,
                    ),
                    Err(e) => self.notice = Some(e.to_string()),
                }
                return;
            }
            match backend.save(self.native_epoch, self.edit_seq, project, mix) {
                Ok(()) => self.saving = true,
                Err(error) => self.notice = Some(error.to_string()),
            }
            cx.notify();
        }
    }
    fn seek_native(&mut self, cx: &mut Context<Self>) {
        if !self.audio_available() { self.playhead.seek_refused(); return; }
        let requested = self.playhead.position();
        if self.defer_monitor(DeferredAudio::Seek(requested), cx) {
            // The deferred action retains the target. Draw the real clock until
            // the transport can actually queue it, including a full handoff queue.
            self.playhead.seek_refused();
            return;
        }
        if self.loading || self.source_blocks_except_rate() || self.project.is_none() {
            self.playhead.seek_refused();
            return;
        }
        self.transport_flight.count_in_anchor = None;
        let target = requested.clamp(0., self.duration);
        if let Some(backend) = &self.backend {
            match backend.control(self.native_epoch, format!("seek {target}")) {
                Ok(()) => {
                    self.playhead.seek(target);
                    self.playhead.seek_queued(Instant::now());
                }
                Err(error) => {
                    self.playhead.seek_refused();
                    self.notice = Some(error.to_string());
                }
            }
        } else {
            self.playhead.seek_refused();
        }
        cx.notify();
    }
    fn sync_lane(&mut self, i: usize, cx: &mut Context<Self>) {
        if (self.tracks_flight.tracks_pending.is_some()||self.carry_flight.carry.is_some())||self.tracks_audio_failed{return;}
        if let Some(lane) = self
            .project
            .as_ref()
            .and_then(|p| p.lanes.iter().position(|(index, _)| *index == i))
        {
            self.native_command(
                format!(
                    "lane {lane} {} {} {}",
                    self.gain[i] as f32 / 100.,
                    u8::from(self.muted[i]),
                    u8::from(self.solo[i])
                ),
                cx,
            );
        }
    }
    fn mute_native_karaoke_guide(&mut self, cx: &mut Context<Self>) -> bool {
        // Source openKaraoke leaves the guide under Carry's schedule when armed.
        if self.carry.enabled || self.muted[0] {
            return true;
        }
        let Some(lane) = self.project.as_ref().filter(|project| project.lane_id(0) == Some("vocals"))
            .and_then(|project| project.lanes.iter().position(|(slot, _)| *slot == 0)) else {
                return true;
            };
        let command = format!("lane {lane} {} 1 {}", self.gain[0] as f32 / 100., u8::from(self.solo[0]));
        let queued = self.monitor_flight.monitor_actions.len();
        if self.defer_monitor(DeferredAudio::Command(command.clone()), cx) {
            if self.monitor_flight.monitor_actions.len() == queued {
                return false;
            }
            // Deferred commands receive their dirty stamp when the restored
            // native graph admits them, as with the ordinary mixer controls.
        } else if let Some(backend) = &self.backend {
            if let Err(error) = backend.control(self.native_epoch, command) {
                self.notice = Some(error.to_string());
                return false;
            }
            self.edit_seq += 1;
        } else {
            return false;
        }
        self.muted[0] = true;
        true
    }
    fn native_transport(&mut self, event: transport::TransportEvent, cx: &mut Context<Self>) {
        use transport::TransportEvent::*;
        if let Tempo(value)=event {self.request_tempo(value,cx);return;}
        if let Transpose(value)=event {self.request_transpose(value,cx);return;}
        if matches!(event, StemFiles) {
            // This footer action is source onReveal, distinct from mixer Export.
            if !self.loading {
                if let Some(path) = self.project.as_ref().filter(|project| project.lane_id(0) == Some("vocals"))
                    .and_then(|project| project.lanes.iter().find(|(slot, _)| *slot == 0).map(|(_, path)| path.clone())) {
                    cx.reveal_path(&path);
                }
            }
            return;
        }
        if !self.audio_available()&&!matches!(event,Volume(_)|Tempo(_)|Transpose(_)|CancelSplit){return;}
        if matches!(event, CancelSplit) {
            self.cancel_source(cx);
            return;
        }
        if self.loading || self.source_blocks_except_rate() || self.project.is_none() {
            // The refusal itself, countable by the transport legs driver.
            #[cfg(feature="ui-tests")]
            if self.loading && matches!(event, Play) {
                self.loading_play_refusals += 1;
            }
            return;
        }
        match event {
            CancelSplit => unreachable!(),
            Split(mode) => self.split_source(mode, cx),
            Play => {
                let playing=self.transport_flight.native_play.payload().map_or(self.playing,|target|*target);
                if !playing {
                    if self.region_busy() {self.region.play_requested=!self.region.play_requested;return;}
                    if let Some((start,end))=self.region_target().selection {
                        if self.playhead.position()<start-0.05 || self.playhead.position()>=end-0.05 {
                            self.playhead.seek(start);self.seek_native(cx);
                        }
                    }
                    if self.region_target().selection.is_none()&&transport_timing::play_rewinds_finished_song(self.playhead.transport_completed(),self.playhead.position(),self.duration) {
                        self.playhead.seek(0.);self.seek_native(cx);
                    }
                    if self.metronome.count_in_bars > 0 {
                        self.transport_flight.count_in_anchor = Some(self.playhead.position());
                    }
                }
                self.native_command(if playing { "pause" } else { "play" }.into(), cx);
            }
            Restart => {
                self.playhead.seek(self.restart_cycle.next(self.region_target().selection,self.playing));
                self.seek_native(cx);
            }
            Loop => {
                let target=self.region_target();
                if self.rate_busy() {
                    self.transport_flight.queued_loop.toggle(target);
                } else {
                    self.request_region(region_gesture::Target{looping:!target.looping,..target},cx);
                }
            }
            Volume(value) => {
                self.master_volume = value;
                self.native_command(format!("master {value}"), cx);
            }
            Karaoke => {
                if !self.karaoke && !self.mute_native_karaoke_guide(cx) {
                    self.transport.update(cx, |transport, cx| transport.set_karaoke(self.karaoke, cx));
                    cx.notify();
                    return;
                }
                self.karaoke = !self.karaoke;
                self.remember_karaoke(self.karaoke,cx);
                self.prepare_karaoke_lyrics(cx);
                self.transport
                    .update(cx, |transport, cx| transport.set_karaoke(self.karaoke, cx));
            }
            Transpose(_) | Tempo(_) => unreachable!(),
            _ => self.notice = Some("This control is not available in this version yet.".into()),
        }
        cx.notify();
    }
    fn zoom_by(&mut self, factor: f32, cx: &mut Context<Self>) {
        self.timeline_input(timeline_viewport::Input::Zoom{factor:factor as f64,anchor_fraction:None},cx);
    }

    fn toggle(&mut self, cx: &mut Context<Self>) {
        if self.playhead.position() >= self.duration {
            self.playhead.seek(0.);
        }
        if self.backend.is_some() {
            self.native_transport(transport::TransportEvent::Play, cx);
            return;
        }
        self.playing = !self.playing;
        self.last = Instant::now();
        cx.notify();
    }
    fn lyric_countdown_cue(&self,playing:bool)->Option<lyrics_countdown::Cue> {
        let position=self.display_position()+0.15;
        let next=self.lyric_document.lines.partition_point(|line|line.start as f64<=position);
        let start=self.lyric_document.lines.get(next)?.start;
        lyrics_countdown::at_target(next,start as f64,next.checked_sub(1).map(|i|self.lyric_document.lines[i].end as f64),position as f64,playing)
    }
    fn lyric_countdown_preload(&self)->Option<lyrics_countdown::Cue> {
        let position=self.display_position()+0.15;
        let next=self.lyric_document.lines.partition_point(|line|line.start as f64<=position);
        let start=self.lyric_document.lines.get(next)?.start;
        let previous_end=next.checked_sub(1).map(|i|self.lyric_document.lines[i].end);
        // Prepare a gap's first label before the previous line ends. This is
        // only an asset key: the visible cue still uses the exact source policy.
        let at=previous_end.map_or(position,|end|position.max(end as f64));
        lyrics_countdown::at_target(next,start as f64,previous_end.map(|end|end as f64),at as f64,true)
            .or_else(||(if next==0{start>=1.2}else{start-previous_end.unwrap_or(0.)>=3.})
                .then_some(lyrics_countdown::Cue{line:next,kind:lyrics_countdown::Kind::Dots(3)}))
    }
    #[cfg(feature="ui-tests")]
    fn lyric_countdown_review_state(&self)->serde_json::Value {
        let clock=self.lyric_countdown_clock.borrow();
        let cue=clock.current().map(|(cue,level)|serde_json::json!({"line":cue.line,
            "kind":if matches!(cue.kind,lyrics_countdown::Kind::Seconds(_)){"seconds"}else{"dots"},
            "count":match cue.kind{lyrics_countdown::Kind::Seconds(n)=>n,lyrics_countdown::Kind::Dots(n)=>n as u32},
            "text":cue.kind.text(),"pulseLevel":if cfg!(target_os="windows"){0}else{level}}));
        serde_json::json!({"cue":cue,"bounds":clock.bounds,"spriteReady":clock.sprite_ready,
            "position":self.playhead.position(),"anticipatedPosition":self.playhead.position()+0.15,"playing":self.playing,"karaoke":self.karaoke,
            "windowsFrozenPulse":cfg!(target_os="windows")})
    }
    fn lyrics(&self, cx: &mut Context<Self>) -> AnyElement {
        if self.lyric_document.lines.is_empty() {
            self.lyric_countdown_clock.borrow_mut().clear();
            self.lyric_horizontal.set(false);
            self.lyric_scroll_geometry.set(Default::default());
            self.lyric_scroll_handle.set_offset(point(px(0.), self.lyric_scroll_handle.offset().y));
            let message = self
                .project
                .as_ref()
                .and_then(|p| p.lyrics_error.clone())
                .map(|e| format!("Could not load saved lyrics: {e}"))
                .unwrap_or_else(|| "No synced lyrics in this project.".into());
            return div()
                .flex_1()
                .p(px(22.))
                .text_size(px(13.))
                .text_color(rgb(DIM))
                .child(message)
                .into_any_element();
        }
        // Lyric documents and their paint interpolation retain their existing f32 API.
        let position = (self.display_position() + 0.15) as f32;
        let document = self.lyric_document.clone();
        let active = document.active(position);
        let line_started = position >= document.lines[0].start;
        let native_glows = self.native_glows.clone();
        let suspended = self.notice.is_some()
            || self.engine_setup.read(cx).is_open()
            || self.whats_new.read(cx).is_open()
            || self.quick_start.read(cx).is_open()
            || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models);
        let countdown_clock=self.lyric_countdown_clock.clone();
        let countdown_suspended=suspended||self.modal_was_open;
        let countdown=countdown_clock.borrow_mut().observe(self.lyric_countdown_cue(self.playing),Instant::now(),countdown_suspended,self.native_epoch);
        let countdown_line=countdown.map(|(cue,_)|cue.line);
        let countdown_preload=if countdown_suspended{countdown.map(|(cue,_)|cue)}else{self.lyric_countdown_preload()};
        let glow_textures = self.glow_textures.clone();
        let glow_bands = self.glow_bands.clone();
        let stats = self.frame_stats.clone();
        let profile = gated_env!("SINGZ_GPUI_PROFILE").is_some()
            || gated_env!("SINGZ_GPUI_OFFSCREEN_BENCHMARK").is_some();
        let shapes = self.shape_cache.clone();
        let layouts = self.layout_cache.clone();
        let scrolling = self.lyric_scroll.clone();
        let scroll_active = self.lyric_scroll_active.clone();
        let scroll_target = self.lyric_scroll_target.clone();
        let carry_mask=self.carry_paint_mask();
        let active_line = self.lyric_active.clone();
        let extent = self.lyric_extent.clone();
        let ai_note_top=self.lyric_ai_note_top.clone();
        let show_ai_note=self.backend.is_some()&&self.lyrics_sidebar.read(cx).is_whisper();
        let view_height = self.lyric_view_height.clone();
        let scroll_handle = self.lyric_scroll_handle.clone();
        let horizontal = self.lyric_horizontal.get();
        let horizontal_state = self.lyric_horizontal.clone();
        let horizontal_geometry = self.lyric_scroll_geometry.clone();
        let owner = cx.entity().downgrade();
        let layout = self.lyric_hits.clone();
        let hits = layout.clone();
        div()
            .id("lyrics-body")
            .relative()
            .flex_1()
            .min_h_0()
            .overflow_hidden()
            .cursor_pointer()
            .on_scroll(cx.listener(|this, event: &ScrollEvent, _, cx| {
                let mut delta = match event.delta {
                    ScrollDelta::Pixels(point) => point,
                    ScrollDelta::Lines(point) => point.map(|value| px(value * 25.375)),
                };
                if event.modifiers.shift && delta.x == px(0.) {
                    delta = point(delta.y, px(0.));
                }
                let max = (this.lyric_extent.get() - this.lyric_view_height.get()).max(0.);
                let offset = (this.lyric_scroll.get() - f32::from(delta.y)).clamp(0., max);
                let x = px(this.lyric_scroll_geometry.get().clamp_offset(
                    f32::from(this.lyric_scroll_handle.offset().x + delta.x),
                ));
                this.lyric_scroll.set(offset);
                this.lyric_scroll_target.set(offset);
                this.lyric_scroll_handle.set_offset(point(x, px(-offset)));
                this.lyric_scroll_active.set(false);
                cx.notify();
                cx.stop_propagation();
            }))
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                    for (index, bounds) in hits.borrow().iter() {
                        if bounds.contains(&e.position) {
                            this.playhead.seek((this.lyric_document.start(*index) as f64).clamp(0., this.duration));
                            this.seek_native(cx);
                            cx.notify();
                            break;
                        }
                    }
                }),
            )
            .child(
                div()
                    .id("lyrics-scroll-extent")
                    .absolute()
                    .top_0()
                    .left_0()
                    .right(px(10.))
                    .bottom(px(if horizontal { 10. } else { 0. }))
                    // The parent owns wheel deltas. Track geometry without
                    // GPUI applying the same bubbling wheel event a second time.
                    .overflow_hidden()
                    .track_scroll(&self.lyric_scroll_handle)
                    .child(div().h(px(self.lyric_extent.get()))
                        .w(px(self.lyric_scroll_geometry.get().content_width))),
            )
            .child(
                canvas(
                    |b, _, _| b,
                    move |_, b, w, cx| {
                        let _timer = profile.then(|| PaintTimer {
                            start: Instant::now(),
                            stats: stats.clone(),
                        });
                        // Warm the next caption and the finite dot vocabulary
                        // while paused too. UIKit prepares masks off-thread.
                        if let Some(cue)=countdown_preload {
                            let _=singz_uikit::request_lyric_countdown_sprite(&cue.kind.text(),cue.kind.tracking(),w,cx);
                            if let lyrics_countdown::Kind::Seconds(seconds)=cue.kind {
                                if seconds>4 {let _=singz_uikit::request_lyric_countdown_sprite(&format!("{} s",seconds-1),1.,w,cx);}
                            }
                            for text in ["● ● ●","● ●","●"] {let _=singz_uikit::request_lyric_countdown_sprite(text,5.,w,cx);}
                        }
                        let font = Font {
                            family: "SingZ Display 650".into(),
                            ..Default::default()
                        };
                        let mut cached_shapes = shapes.borrow_mut();
                        let mut shape = |text: &str, color: Hsla, scale: f32, window: &Window| {
                            let key = (
                                text.to_owned(),
                                [
                                    color.h.to_bits(),
                                    color.s.to_bits(),
                                    color.l.to_bits(),
                                    color.a.to_bits(),
                                ],
                                scale.to_bits(),
                            );
                            cached_shapes
                                .entry(key)
                                .or_insert_with(|| {
                                    window.text_system().shape_line(
                                        text.to_string().into(),
                                        px(17.5 * scale),
                                        &[TextRun {
                                            len: text.len(),
                                            font: font.clone(),
                                            color,
                                            background_color: None,
                                            underline: None,
                                            strikethrough: None,
                                        }],
                                        None,
                                    )
                                })
                                .clone()
                        };
                        let mut cached_layout = layouts.borrow_mut();
                        let width_key = f32::from(b.size.width).round() as i32;
                        if cached_layout.as_ref().map(|entry| entry.0) != Some(width_key) {
                            let space = f32::from(shape(" ", rgb(TEXT).into(), 1., w).width);
                            let available = f32::from(b.size.width) - 40.;
                            let mut lines = Vec::new();
                            let mut top = 18.;
                            for lyric_line in &document.lines {
                                let mut x = 0.;
                                let mut row = 0.;
                                let mut words = Vec::new();
                                for word in &lyric_line.words {
                                    let text = word.text.as_str();
                                    let width =
                                        f32::from(shape(text, rgb(TEXT).into(), 1., w).width);
                                    if x > 0. && x + width > available {
                                        x = 0.;
                                        row += 1.;
                                    }
                                    words.push((text.to_owned(), x, row * 25.375, width));
                                    x += width + space;
                                }
                                let height = (row + 1.) * 25.375 + 14.;
                                lines.push((top, height, words));
                                top += height;
                            }
                            *cached_layout = Some((width_key, lines));
                        }
                        let lines = &cached_layout.as_ref().unwrap().1;
                        let base_metrics = shape(" ", rgb(TEXT).into(), 1., w);
                        let base_baseline =
                            w.text_baseline(base_metrics.ascent, base_metrics.descent, px(25.375));
                        let (active_top, active_height, _) = &lines[active];
                        let active_top=active_top+if countdown_line.is_some_and(|line|line<active){lyrics_countdown::CUE_HEIGHT}else{0.};
                        let active_height=active_height+if countdown_line==Some(active){lyrics_countdown::CUE_HEIGHT}else{0.};
                        // Measure the same shaped rows and active paragraph transform
                        // used below; the scroll extent must include offscreen long words.
                        let mut geometry = lyric_scroll_geometry::Geometry::new(f32::from(b.size.width));
                        for (i, (_, _, words)) in lines.iter().enumerate() {
                            let scale = if i == active && line_started { 1.03 } else { 1. };
                            geometry.add_paragraph(scale, words.iter().map(|(_, x, _, width)| (*x, *width)));
                        }
                        let geometry_changed = horizontal_geometry.replace(geometry) != geometry;
                        let horizontal_changed = horizontal_state.replace(geometry.overflows()) != geometry.overflows();
                        let old_offset = scroll_handle.offset();
                        scroll_handle.set_offset(point(px(geometry.clamp_offset(f32::from(old_offset.x))), old_offset.y));
                        if geometry_changed || horizontal_changed {
                            let owner = owner.clone();
                            w.on_next_frame(move |_, cx| {
                                let _ = owner.update(cx, |_, cx| cx.notify());
                            });
                        }
                        if show_ai_note {
                            let top=lines.last().map(|(top,height,_)|top+height).unwrap_or(0.)+if countdown.is_some(){lyrics_countdown::CUE_HEIGHT}else{0.};
                            if (ai_note_top.replace(top)-top).abs()>0.5 {
                                let owner=owner.clone();w.on_next_frame(move|_,cx|{let _=owner.update(cx,|_,cx|cx.notify());});
                            }
                        }
                        view_height.set(f32::from(b.size.height));
                        extent.set(
                            lines
                                .last()
                                .map(|(top, height, _)| top + height)
                                .unwrap_or(0.)
                                + if countdown.is_some(){lyrics_countdown::CUE_HEIGHT}else{0.}
                                + f32::from(w.viewport_size().height) * 0.4,
                        );
                        let mut previous = scrolling.get();
                        let external_offset = -f32::from(scroll_handle.offset().y);
                        if (external_offset - previous).abs() > 0.5 {
                            previous = external_offset;
                            scroll_target.set(external_offset);
                        }
                        if active_line.replace(active) != active {
                            let target = (active_top + active_height / 2.
                                - f32::from(b.size.height) / 2.)
                                .max(0.);
                            scroll_target
                                .set((target * w.scale_factor()).round() / w.scale_factor());
                        }
                        let target = scroll_target
                            .get()
                            .min((extent.get() - f32::from(b.size.height)).max(0.));
                        scroll_active.set((target - previous).abs() > 0.2);
                        if scroll_active.get() && !suspended {
                            w.request_animation_frame();
                        }
                        let offset = if scroll_active.get() {
                            previous + (target - previous) * 0.16
                        } else {
                            target
                        };
                        scrolling.set(offset);
                        scroll_handle.set_offset(point(scroll_handle.offset().x, px(-offset)));
                        layout.borrow_mut().clear();
                        w.with_content_mask(Some(ContentMask { bounds: b }), |w| {
                            for (i, (top, height, words)) in lines.iter().enumerate() {
                                let before=if countdown_line.is_some_and(|line|line<i){lyrics_countdown::CUE_HEIGHT}else{0.};
                                let cue_height=if countdown_line==Some(i){lyrics_countdown::CUE_HEIGHT}else{0.};
                                let y = b.origin.y + px(top + before - offset);
                                layout.borrow_mut().push((
                                    i,
                                    Bounds::new(
                                        point(b.origin.x, y),
                                        size(b.size.width, px(*height+cue_height)),
                                    ),
                                ));
                                if f32::from(y - b.origin.y) + height + cue_height < 0. || y > b.bottom() {
                                    continue;
                                }
                                if carry_mask.as_ref().is_some_and(|mask|mask.get(i)==Some(&true)) {
                                    let bounds=Bounds::new(point(b.left()+scroll_handle.offset().x+px(6.),y),size(b.size.width-px(12.),px(*height+cue_height)));
                                    w.paint_quad(fill(bounds,rgba(if i==active&&line_started{0xffa02821}else{0xffa0280d})));
                                    w.paint_quad(fill(Bounds::new(bounds.origin,size(px(3.),bounds.size.height)),rgba(if i==active&&line_started{0xffa028ff}else{0xffa02873})));
                                }
                                if let Some((cue,level))=countdown.filter(|(cue,_)|cue.line==i) {
                                    let origin=point(b.left()+scroll_handle.offset().x+px(20.),y+px(7.));
                                    let sprite=singz_uikit::request_lyric_countdown_sprite(&cue.kind.text(),cue.kind.tracking(),w,cx);
                                    let ready=sprite.is_some_and(|sprite|singz_uikit::paint_lyric_countdown(sprite,origin,if cfg!(target_os="windows"){0}else{level},w));
                                    {let mut clock=countdown_clock.borrow_mut();clock.bounds=Some((f32::from(origin.x),f32::from(origin.y),f32::from(b.size.width)-40.,11.));clock.sprite_ready=ready;}
                                    if !countdown_suspended&&!cfg!(target_os="windows"){w.request_animation_frame();}
                                }
                                let y=y+px(cue_height);
                                let scale = if i == active && line_started { 1.03 } else { 1. };
                                let baseline_adjustment = if i == active && line_started {
                                    let metrics = shape(" ", rgb(TEXT).into(), scale, w);
                                    base_baseline * scale
                                        - w.text_baseline(
                                            metrics.ascent,
                                            metrics.descent,
                                            px(25.375 * scale),
                                        )
                                } else {
                                    px(0.)
                                };
                                let color = rgb(if i == active && line_started {
                                    TEXT
                                } else if i < active {
                                    DIM
                                } else {
                                    FAINT
                                });
                                for (j, (text, x, row, width)) in words.iter().enumerate() {
                                    let origin = point(
                                        b.origin.x
                                            + scroll_handle.offset().x
                                            + px(6. + (14. + x) * scale),
                                        y + px((7. + row) * scale - height * (scale - 1.) / 2.)
                                            + baseline_adjustment,
                                    );
                                    // CSS applies the fixed 14px text shadow to the active word only.
                                    // GPUI caches this filtered outline in its sprite atlas; no blur runs per frame.
                                    let timing = &document.lines[i].words[j];
                                    let word_start = timing.start;
                                    let word_end = timing.end;
                                    let native_bands = if i == active && line_started
                                        && position >= word_start
                                        && position < word_end
                                    {
                                        document
                                            .masks
                                            .get(text)
                                            .map(|mask| native_glows.borrow_mut().get(text, mask))
                                    } else {
                                        None
                                    };
                                    if i == active && line_started && position >= word_start && position < word_end
                                    {
                                        if let Some(texture) = native_bands
                                            .as_ref()
                                            .and_then(|b| b.last())
                                            .or_else(|| glow_textures.get(text.as_str()))
                                        {
                                            let bounds = Bounds::new(
                                                origin - point(px(21.), px(21.)),
                                                size(
                                                    px(width * scale + 42.),
                                                    px(25.375 * scale + 42.),
                                                ),
                                            );
                                            let _ = w.paint_image(
                                                bounds,
                                                bounds,
                                                Corners::default(),
                                                texture.clone(),
                                                0,
                                                false,
                                            );
                                        }
                                    }
                                    if i != active || !line_started {
                                        let _ = shape(text, color.into(), scale, w).paint(
                                            origin,
                                            px(25.375 * scale),
                                            TextAlign::Left,
                                            None,
                                            w,
                                            cx,
                                        );
                                        continue;
                                    }
                                    let p = ((if word_end <= word_start {
                                        if position >= word_end { 1. } else { 0. }
                                    } else {
                                        (position - word_start) / (word_end - word_start)
                                    })
                                    .clamp(0., 1.)
                                        * 200.)
                                        .round()
                                        / 200.;
                                    let dpr = w.scale_factor();
                                    // Snap the transformed line's paint offset separately from
                                    // its local baseline, as Blink does for vector text. Word
                                    // advances retain their fractional positions inside the line.
                                    let metrics = shape(" ", color.into(), scale, w);
                                    let line_left = b.left() + scroll_handle.offset().x + px(6.);
                                    let local_baseline =
                                        px((7. + row) * scale - height * (scale - 1.) / 2.)
                                            + base_baseline * scale;
                                    let paint_origin = point(
                                        px((f32::from(line_left) * dpr).round() / dpr)
                                            + px((14. + x) * scale),
                                        px((f32::from(y) * dpr).round() / dpr)
                                            + px((f32::from(local_baseline) * dpr).round() / dpr)
                                            - w.text_baseline(
                                                metrics.ascent,
                                                metrics.descent,
                                                px(25.375 * scale),
                                            ),
                                    );
                                    let feather = 17.5 * 0.4 * scale;
                                    let edge = p * (width * scale + 2. * feather) - feather;
                                    // Approved native paint: readable base, amber feather, then
                                    // a continuous bright core and cached halo. Preserve these
                                    // alpha layers; Electron's flatter paint is not this baseline.
                                    let _ = shape(text, color.into(), scale, w).paint(
                                        paint_origin,
                                        px(25.375 * scale),
                                        TextAlign::Left,
                                        None,
                                        w,
                                        cx,
                                    );
                                    let amber = shape(text, rgb(ACCENT).into(), scale, w);
                                    let solid = (edge - feather).clamp(0., width * scale);
                                    if solid > 0. {
                                        w.with_content_mask(
                                            Some(ContentMask {
                                                bounds: Bounds::new(
                                                    point(paint_origin.x, b.top()),
                                                    size(px(solid), b.size.height),
                                                ),
                                            }),
                                            |w| {
                                                let _ = amber.paint(
                                                    paint_origin,
                                                    px(25.375 * scale),
                                                    TextAlign::Left,
                                                    None,
                                                    w,
                                                    cx,
                                                );
                                            },
                                        );
                                    }
                                    for slice in 0..12 {
                                        let left = (edge - feather
                                            + slice as f32 * 2. * feather / 12.)
                                            .max(0.);
                                        let right = (edge - feather
                                            + (slice + 1) as f32 * 2. * feather / 12.)
                                            .min(width * scale);
                                        if right <= left {
                                            continue;
                                        }
                                        let alpha = 1. - (slice as f32 + 0.5) / 12.;
                                        let ink =
                                            shape(text, rgb(ACCENT).alpha(alpha).into(), scale, w);
                                        w.with_content_mask(
                                            Some(ContentMask {
                                                bounds: Bounds::new(
                                                    point(paint_origin.x + px(left), b.top()),
                                                    size(px(right - left), b.size.height),
                                                ),
                                            }),
                                            |w| {
                                                let _ = ink.paint(
                                                    paint_origin,
                                                    px(25.375 * scale),
                                                    TextAlign::Left,
                                                    None,
                                                    w,
                                                    cx,
                                                );
                                            },
                                        );
                                    }
                                    // 18px feathered band moves through glyphs, never selects a letter.
                                    if position >= word_start && position < word_end && p > 0. {
                                        let pen = p * width * scale;
                                        let light_width = 18.;
                                        let texture_bounds = Bounds::new(
                                            paint_origin - point(px(21.), px(21.)),
                                            size(px(width * scale + 42.), px(25.375 * scale + 42.)),
                                        );
                                        for slice in 0..12 {
                                            let u = (slice as f32 + 0.5) / 12.;
                                            let intensity = (1. - (u * 2. - 1.).abs()).powf(1.5);
                                            let left = pen - light_width / 2.
                                                + slice as f32 * light_width / 12.;
                                            let clip = Bounds::new(
                                                point(paint_origin.x + px(left), b.top()),
                                                size(px(light_width / 12.), b.size.height),
                                            );
                                            w.with_content_mask(
                                                Some(ContentMask { bounds: clip }),
                                                |w| {
                                                    if let Some(bands) = native_bands
                                                        .as_ref()
                                                        .or_else(|| glow_bands.get(text.as_str()))
                                                    {
                                                        let index =
                                                            (intensity * 8.).ceil().clamp(1., 8.)
                                                                as usize
                                                                - 1;
                                                        if w.paint_image(
                                                            texture_bounds,
                                                            texture_bounds,
                                                            Corners::default(),
                                                            bands[index].clone(),
                                                            0,
                                                            false,
                                                        )
                                                        .is_ok()
                                                        {
                                                            stats
                                                                .borrow_mut()
                                                                .advancing_glow_draws += 1;
                                                        }
                                                    }
                                                    let leading = shape(
                                                        text,
                                                        rgb(0xffdf9c).alpha(intensity).into(),
                                                        scale,
                                                        w,
                                                    );
                                                    let _ = leading.paint(
                                                        paint_origin,
                                                        px(25.375 * scale),
                                                        TextAlign::Left,
                                                        None,
                                                        w,
                                                        cx,
                                                    );
                                                },
                                            );
                                        }
                                    }
                                }
                            }
                        });
                    },
                )
                .absolute()
                .top_0()
                .left_0()
                .right(px(10.))
                .bottom(px(if horizontal { 10. } else { 0. })),
            )
            .when(show_ai_note&&self.lyric_ai_note_top.get()>=0.,|body|body.child(
                singz_uikit::lyrics_sidebar_note().absolute().left(px(6.)).right(px(16.))
                    .top(px(self.lyric_ai_note_top.get()-self.lyric_scroll.get()))
                    .child(singz_uikit::lyrics_sidebar_note_link("lyrics-ai-fix").on_mouse_down(MouseButton::Left,|_,_,cx|cx.stop_propagation())
                        .on_click(cx.listener(|this,_,w,cx|this.open_lyrics_editor(w,cx))))
            ))
            .child(
                div()
                    .absolute()
                    .top_0()
                    .right_0()
                    .bottom(px(if horizontal { 10. } else { 0. }))
                    .w(px(10.))
                    .child(singz_uikit::production_scrollbar(&self.lyric_scroll_handle)),
            )
            .when(horizontal, |body| {
                body.child(
                    div()
                        .absolute()
                        .left_0()
                        .right(px(10.))
                        .bottom_0()
                        .h(px(10.))
                        .child(singz_uikit::production_scrollbar_horizontal(
                            &self.lyric_scroll_handle,
                        )),
                )
                .child(
                    div()
                        .absolute()
                        .right_0()
                        .bottom_0()
                        .size(px(10.))
                        .bg(rgb(0xffffff)),
                )
            })
            .into_any_element()
    }
    fn lane(&self, i: usize, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let color=self.lane_color(i);
        let lane_spec=self.project.as_ref().and_then(|p|p.lane_specs.iter().find(|s|s.slot==i));
        let custom=lane_spec.is_some_and(|s|s.custom);
        let editing=lane_spec.is_some_and(|s|self.track_rename.as_ref().is_some_and(|(epoch,id)|*epoch==self.native_epoch&&*id==s.id));
        let label=self.lane_label(i);
        let grid = self.paint_beats.clone().filter(|_| self.metronome.grid);
        let beat_cache = self.beat_cache.clone();
        let position = self.display_position();
        let duration = self.duration;
        let view_start = self.view_start;
        let view_end = self.view_end;
        let fade = self.fade[i];
        let waveform_owner = cx.entity().downgrade();
        let ordinal=self.project.as_ref().and_then(|p|p.lanes.iter().position(|(slot,_)|*slot==i)).unwrap_or(i);
        let elapsed=lane_spec.and_then(|lane|self.lane_entered.get(&lane.id)).unwrap_or(&self.started).elapsed().as_secs_f32();
        let enter = ((elapsed - ordinal as f32 * 0.07) / 0.55).clamp(0., 1.);
        let enter = 1. - (1. - enter).powi(3);
        let geometry = Rc::new(Cell::new(None::<Bounds<Pixels>>));
        let hit = geometry.clone();
        let gain = self.gain[i] as f32 / 100.;
        div()
            .flex()
            .flex_1()
            .min_h(px(64.))
            .opacity(enter)
            .border_b_1()
            .border_color(rgba(0xfff0d614))
            .child(
                div()
                    .w(px(228.))
                    .flex_shrink_0()
                    .pl(px(14.))
                    .pr(px(18.))
                    .flex()
                    .flex_col()
                    .justify_center()
                    .gap(px(9.))
                    .when(
                        i == self
                            .project
                            .as_ref()
                            .and_then(|p| p.lanes.first().map(|(i, _)| *i))
                            .unwrap_or(0),
                        |d| self.quick_start.read(cx).anchors.track(d, "stems"),
                    )
                    .child(
                        div().id(("lane-title",i))
                            .flex()
                            .items_center()
                            .gap(px(9.))
                            .group("custom-track-title")
                            .when(custom,|row|self.track_probe(format!("title-{i}"),row))
                            .when(custom,|row|row.tab_group())
                            .child(
                                div()
                                    .size(px(9.))
                                    .rounded_full()
                                    .bg(rgb(color).alpha(if fade < 0.5 { 0.4 } else { 1. }))
                                    .shadow(if fade < 0.5 {
                                        vec![]
                                    } else {
                                        vec![glow(color, 0.7, 10.)]
                                    }),
                            )
                            .when(editing,|row|row.child(singz_uikit::track_name_input(&self.track_name_input,color)))
                            .when(!editing,|row|row.child(
                                singz_uikit::track_name_label(("lane-name",i),label,if fade>0.5{TEXT}else{FAINT})
                                    .when(custom,|d|d.cursor_text().on_click(cx.listener(move|this,event:&ClickEvent,w,cx|{
                                        if event.click_count()==2{this.begin_track_name(i,w,cx);}
                                    }))),
                            ))
                            .when(custom&&!editing,|row|row
                                .child(self.track_probe(format!("edit-{i}"),singz_uikit::track_action(("lane-edit",i),"✎",false))
                                    .track_focus(&self.track_action_focus[i][0]).tab_index(0)
                                    .on_key_down(cx.listener(move|this,event:&KeyDownEvent,w,cx|{
                                        if matches!(event.keystroke.key.as_str(),"enter"|"space"){this.begin_track_name(i,w,cx);cx.stop_propagation();}
                                    }))
                                    .on_click(cx.listener(move|this,_,w,cx|this.begin_track_name(i,w,cx))))
                                .child(self.track_probe(format!("remove-{i}"),singz_uikit::track_action(("lane-remove",i),"✕",true))
                                    .track_focus(&self.track_action_focus[i][1]).tab_index(1)
                                    .on_key_down(cx.listener(move|this,event:&KeyDownEvent,_,cx|{
                                        if matches!(event.keystroke.key.as_str(),"enter"|"space"){this.remove_custom_track(i,cx);cx.stop_propagation();}
                                    }))
                                    .on_click(cx.listener(move|this,_,_,cx|this.remove_custom_track(i,cx)))))
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(6.))
                            .items_center()
                            .child(
                                self.track_probe(format!("mute-{i}"),singz_uikit::stem_chip_with_focus(("m", i), "M", self.muted[i], color, self.track_mix_focus[i][0].clone(), {
                                    let entity=cx.entity().downgrade();
                                    move |_,cx| {let _=entity.update(cx,|this,cx| {
                                        if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some()){return;}
                                        this.muted[i] = !this.muted[i];
                                        this.sync_lane(i, cx);
                                        cx.notify();
                                    });}
                                })),
                            )
                            .child(
                                self.track_probe(format!("solo-{i}"),singz_uikit::stem_chip_with_focus(("s", i), "S", self.solo[i], ACCENT, self.track_mix_focus[i][1].clone(), {
                                    let entity=cx.entity().downgrade();
                                    move |_,cx| {let _=entity.update(cx,|this,cx| {
                                        if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some()){return;}
                                        this.solo[i] = !this.solo[i];
                                        this.sync_lane(i, cx);
                                        cx.notify();
                                    });}
                                })),
                            )
                            .child(self.track_probe(format!("gain-{i}"),singz_uikit::stem_volume_with_focus(("gain", i), gain, color, self.track_gain_focus[i].clone(), {
                                let entity = cx.entity().downgrade();
                                move |value, _, cx| {
                                    let _ = entity.update(cx, |this, cx| {
                                        if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some()){return;}
                                        this.gain[i] = (value * 100.).round() as u8;
                                        this.sync_lane(i, cx);
                                        cx.notify();
                                    });
                                }
                            }))),
                    ),
            )
            .child(
                div()
                    .id(("wave", i))
                    .on_scroll(cx.listener(|this,event:&ScrollEvent,window,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_scroll(event,bounds,window,cx);}}))
                    .on_pinch(cx.listener(|this,event:&PinchEvent,_,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_pinch(event,bounds,cx);}}))
                    .flex_1()
                    .relative()
                    .cursor(if self.region.resize_hover {CursorStyle::ResizeLeftRight}else{CursorStyle::IBeam})
                    .on_mouse_down(
                        MouseButton::Left,
                        cx.listener(move |this, e: &MouseDownEvent, _, cx| {
                            if let Some(b) = hit.get() {
                                this.begin_region(f32::from(e.position.x),this.region.bounds.get().unwrap_or(b),cx);
                            }
                        }),
                    )
                    .child(waveform::lane(waveform::Lane {
                        index: i,
                        color,
                        position,
                        duration,
                        fade,
                        enter,
                        view_start,
                        view_end,
                        owner: waveform_owner,
                    }))
                    .child(
                        canvas(
                            move |b, _, _| {
                                geometry.set(Some(b));
                                b
                            },
                            move |_, b, w, cx| {
                                if let Some(g) = &grid {
                                    beat_grid::paint(
                                        &mut beat_cache.borrow_mut(),
                                        g,
                                        view_start * duration,
                                        view_end * duration,
                                        b,
                                        false,
                                        w,
                                        cx,
                                    );
                                }
                            },
                        )
                        .size_full(),
                    ),
            )
    }
    fn notice_close(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let button=pill("notice-close", "Close", false)
            .on_click(cx.listener(|this,_,_,cx|{this.notice=None;cx.notify();}));
        #[cfg(feature="ui-tests")]
        {
            let measured=self.notice_close_bounds.clone();
            return button.relative().child(canvas(move|b,_,_|{measured.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0());
        }
        #[cfg(not(feature="ui-tests"))]
        button
    }
    fn cancel_source_from_escape(&mut self, cx: &mut Context<Self>) {
        // Escape has no Save-cancel action in the current interface. A writer
        // may already have committed before its result reaches the next frame.
        if (self.source_job.is_some() && !self.source_saving) || self.source_split_loading() {
            self.cancel_source(cx);
        }
    }
    /// Closing a screen never cancels an unrelated audio/document transaction.
    fn dismiss_screen_on_escape(&mut self, cx: &mut Context<Self>) -> bool {
        match self.screen {
            Screen::Training => {
                if !self.training.update(cx, |training, cx| training.dismiss_popup(cx)) {
                    self.screen=if self.loaded_song {Screen::Player}else{Screen::Library};
                    self.focus_player=true;
                }
            }
            Screen::Log => {
                if !self.log_panel.update(cx, |log, cx| log.dismiss_popup(cx)) {
                    self.close_diagnostics(cx);
                }
            }
            Screen::Library if self.backend.is_some() && self.loaded_song => {
                self.screen=Screen::Player;self.focus_player=true;
            }
            Screen::Settings => {
                if !self.settings.update(cx, |settings, cx| settings.dismiss_popup(cx)) {
                    self.screen=self.previous_screen;
                }
            }
            _=>return false,
        }
        cx.notify();true
    }

}
impl Player {
    fn blurred_modal_open(&self, cx: &App) -> bool {
        matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
            || self.project_delete.read(cx).is_open() || self.lyrics_editor_open
            || self.project_picker_open || self.drive_projects_open
            || self.library_import_open || self.stem_export_open
            || self.engine_setup.read(cx).is_open() || self.whats_new.read(cx).is_open()
    }
    fn display_position(&self) -> f64 {
        self.backdrop_clock.position(self.native_epoch, self.playhead.position())
    }
    fn backdrop_content_revision(&self, cx: &App) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut hash = std::collections::hash_map::DefaultHasher::new();
        let base = if matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models) {
            self.previous_screen
        } else { self.screen };
        (base as u8, self.native_epoch, self.native_lane_revision, self.native_carry_revision,
            self.locale_revision, self.edit_seq, self.saved_seq).hash(&mut hash);
        if base == Screen::Training {
            // Loaded history/profile and persistence error changes share this
            // store revision, including updates accepted behind a modal.
            self.training_store_revision.hash(&mut hash);
        }
        self.library.read(cx).backdrop_revision().hash(&mut hash);
        self.header.read(cx).backdrop_fingerprint(cx).hash(&mut hash);
        (self.loaded_song, self.karaoke, self.duration.to_bits(),
            self.view_start.to_bits(), self.view_end.to_bits()).hash(&mut hash);
        self.gain.hash(&mut hash); self.muted.hash(&mut hash); self.solo.hash(&mut hash);
        self.song_title.hash(&mut hash);
        (Arc::as_ptr(&self.lyric_document) as usize).hash(&mut hash);
        if let Some(project) = &self.project {
            project.dir.hash(&mut hash); project.metadata_hash.hash(&mut hash);
            (Arc::as_ptr(&project.pitch) as usize).hash(&mut hash);
        }
        if let Some(grid) = &self.paint_beats { (Rc::as_ptr(grid) as usize).hash(&mut hash); }
        hash.finish()
    }
}

impl Render for Player {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.sync_audio_provider(cx);
        #[cfg(feature="ui-tests")]
        self.notice_close_bounds.set(None);
        self.poll_locale(window,cx);
        self.sync_microphone(cx);
        self.sync_audio_provider(cx);
        if self.screen!=Screen::Player {self.carry_open=false;}
        self.refresh_carry_widget(cx);
        let progress = self.source_split_handoff.as_ref()
            .and_then(|handoff| handoff.progress(self.native_epoch))
            .or_else(|| self.source_combined_next.filter(|(epoch, _)| *epoch == self.native_epoch)
                .map(|_| source_jobs::SplitProgress::stage("Loading stems…", 99., source_jobs::Mode::Stems, true, false)))
            .or_else(|| self.source_split.filter(|_| self.source_job.is_some()).map(|mode|
                source_jobs::SplitProgress::stage(&self.source_status.label, self.source_status.percent,
                    mode, self.source_split_combined, self.source_cancelling == self.source_job)));
        self.transport
            .update(cx, |t, cx| t.set_split_progress(progress, cx));
        let audio_available=self.audio_available();
        let can_reveal_stems=self.backend.is_none() || self.project.as_ref().is_some_and(|p|
            p.lane_id(0)==Some("vocals") && p.lanes.iter().any(|(slot,_)|*slot==0));
        self.transport.update(cx,|t,cx|{t.set_audio_available(audio_available,cx);t.set_stem_reveal(can_reveal_stems,cx);});
        if self.transport.update(cx,|t,_|t.take_focus_player(window)) && self.screen==Screen::Player {
            self.focus_player=true;
        }
        if self.focus_after_title {
            self.focus_after_title = false;
            if window.focused(cx).is_none() || self.header.read(cx).title_input_focused(window, cx)
            {
                self.focus_player = true;
            }
        }
        if self.track_focus_after_name{
            self.track_focus_after_name=false;
            if self.track_name_input.read(cx).focus_handle(cx).is_focused(window){self.focus_player=true;}
        }
        if self.track_focus_removed.drain(..).any(|slot|self.track_gain_focus[slot].is_focused(window)||self.track_mix_focus[slot].iter().any(|focus|focus.is_focused(window))||self.track_action_focus[slot].iter().any(|focus|focus.is_focused(window))){self.focus_player=true;}
        for (index,enabled) in [self.muted.iter().any(|value|*value),self.solo.iter().any(|value|*value)].into_iter().enumerate() {
            if !enabled&&self.track_reset_focus[index].is_focused(window){self.focus_player=true;}
        }
        if self.backend.is_some()&&!self.audio_available()&&self.track_header_focus[1].is_focused(window){self.focus_player=true;}
        let save_enabled=!self.loading && !self.saving && !self.source_saving
            && self.source_publication.is_none() && self.audio_recovery.is_none();
        if !save_enabled && self.header.read(cx).save_control_focused(window) {
            self.focus_player=true;
        }
        let explicit_player_focus=self.focus_player && !self.language_menu.read(cx).is_open();
        if explicit_player_focus {
            self.focus_handle.focus(window, cx);
            self.focus_player = false;
        }
        let notice_open=self.notice.is_some();
        // Capture before the outer modal transition moves focus to the root.
        // A notice can also appear above an already-open editor or Settings.
        let notice_focus=if notice_open&&!self.notice_was_open {window.focused(cx)}else{None};
        let modal_open = self.output_covered(cx);
        let backdrop_open = self.blurred_modal_open(cx);
        if backdrop_open && !self.backdrop_clock.is_open() {
            // Underlay popovers are deferred by GPUI and paint after the root.
            // Close them before a dialog opens rather than capture them late or
            // let an underlay menu paint above its modal.
            self.carry_open = false;
            self.metronome_open = false;
            self.transport.update(cx, |transport, cx| { transport.dismiss_popovers(cx); });
            self.language_menu.update(cx, |menu, cx| menu.close(window, cx));
            self.training.update(cx, |training, cx| { training.dismiss_popup(cx); });
        }
        self.backdrop_clock.observe(backdrop_open, self.native_epoch, self.playhead.position());
        if modal_open != self.modal_was_open {
            // Resume from now, excluding time spent behind a modal.
            self.last = Instant::now();
            if modal_open {
                self.previous_focus = window.focused(cx);
                if !self.quick_start.read(cx).is_open()
                    || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
                    || self.notice.is_some()
                {
                    self.focus_handle.focus(window, cx);
                }
            } else if let Some(previous) = self.previous_focus.take() {
                // Navigation/import may remove the control that opened this
                // modal. Its explicit focus handoff wins over restoring that
                // stale handle, or subsequent shortcuts have no mounted route.
                if !explicit_player_focus {
                    if self.focus_handle.contains(&previous,window) { previous.focus(window,cx); }
                    else { self.focus_handle.focus(window,cx); }
                }
            }
            self.modal_was_open = modal_open;
        }
        if notice_open!=self.notice_was_open {
            if notice_open {
                self.notice_previous_focus=notice_focus.map(|focus|(self.native_epoch,focus));
                self.focus_handle.focus(window,cx);
            } else if let Some((epoch,previous))=self.notice_previous_focus.take() {
                // Do not restore a superseded/unmounted control after navigation.
                // The outer modal owns restoration when the notice was alone.
                if modal_open && !explicit_player_focus && epoch==self.native_epoch
                    && self.focus_handle.contains(&previous,window) {
                    previous.focus(window,cx);
                }
            }
            self.notice_was_open=notice_open;
        }
        self.library.update(cx, |library, cx| {
            library.set_suspended(
                matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
                    || self.project_delete.read(cx).is_open()
                    || self.notice.is_some()
                    || self.project_picker_open || self.drive_projects_open
                    || self.library_import_open || self.stem_export_open
                    || self.lyrics_editor_open
                    || self.engine_setup.read(cx).is_open()
                    || self.whats_new.read(cx).is_open()
                    || self.quick_start.read(cx).is_open(),
                cx,
            )
        });
        let transport_mounted=self.screen==Screen::Player || matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models)&&self.previous_screen==Screen::Player;
        if !self.karaoke||!transport_mounted {self.lyric_countdown_clock.borrow_mut().clear();}
        self.restart_cycle.observe_component(transport_mounted);
        self.restart_cycle.observe(self.region_target().selection,self.playing);
        let transport_rate = self.requested_rate();
        let region_looping=self.region_target().looping;
        let output_mounted=(self.screen==Screen::Player
            ||(matches!(self.screen,Screen::Settings|Screen::Log|Screen::Models)&&self.previous_screen==Screen::Player))
            &&(!self.loading||self.source_pending.is_some()||self.audio_recovery.is_some());
        self.transport.update(cx, |transport, cx| {
            transport.set_output_mounted(output_mounted,self.master_volume,cx);
            transport.set_state(
                self.display_position(),
                self.playing,
                transport_rate.1,
                region_looping,
                cx,
            );
            transport.set_karaoke(self.karaoke, cx);
            transport.set_tempo(transport_rate.0, cx);
        });
        let base_catalog = self.screen == Screen::Library
            || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
                && self.previous_screen == Screen::Library;
        let monitor_owned=self.monitor_busy();
        let monitor_attention=monitor_owned&&self.mic_view.error.is_some();
        let monitor_stopping=monitor_owned&&!self.monitor_flight.monitor_requested&&!monitor_attention;
        let monitor_label=monitor_owned.then(||if monitor_attention {"Monitor needs attention"}
            else if monitor_stopping {"Stopping monitor"}
            else if self.mic_view.phase==microphone::Phase::Monitoring {"Mic monitoring"}
            else {"Starting monitor"}.to_owned());
        self.header.update(cx, |header, cx| {
            header.set_monitor_state(monitor_label,monitor_stopping,monitor_attention,cx);
            header.set_import_available(!self.rate_busy()&&self.tracks_flight.tracks_pending.is_none()&&!self.tracks_audio_failed&&self.project.as_ref().is_some_and(|p|!self.source_working&&!p.dir.starts_with(&self.catalog_root)),cx);
            header.set_rename_enabled(
                !self.rate_busy() && !self.loading
                    && self.tracks_flight.tracks_pending.is_none() && !self.tracks_audio_failed
                    && !self.saving
                    && self.source_job.is_none()
                    && self.rename_pending.is_none()
                    && self.metronome_flight.metronome.is_none()
                    && !self.metronome_flight.metronome_save_requested
                    && !self.metronome_flight.metronome_save_waiting
                    && !self.transport_flight.counting_in,
                cx,
            );
            header.set_save_enabled(save_enabled,cx);
            header.set_save_status(
                if self.saving || self.source_saving || self.transport_flight.native_rate_save_requested || self.metronome_flight.metronome_save_requested || self.metronome_flight.metronome_save_waiting {
                    1
                } else if self.edit_seq == self.saved_seq && !self.rate_busy() {
                    2
                } else {
                    0
                },
                cx,
            );
            header.set_native_status(
                self.project.is_some()
                    || self.training_test.is_some()
                        && self
                            .training_last
                            .as_ref()
                            .is_some_and(|s| s.generation == self.training_test.unwrap_or(0)),
                cx,
            );
            let training = self.screen == Screen::Training
                || matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
                    && self.previous_screen == Screen::Training;
            header.set_training(training, cx);
            header.set_state(
                self.loaded_song && !training,
                base_catalog,
                self.song_title.clone(),
                cx,
            )
        });
        if !backdrop_open { self.backdrop.borrow_mut().clear(window, cx); }
        let now = Instant::now();
        let dt = now.duration_since(self.last).as_secs_f32();
        self.last = now;
        let mut demand = frame_demand::FrameDemand::default();
        demand.set(frame_demand::Source::Startup, self.started.elapsed().as_secs_f32() < 1.1);
        demand.set(frame_demand::Source::LyricsScroll, self.lyric_scroll_active.get());
        demand.set(frame_demand::Source::LaneEnter,
            self.project.as_ref().is_some_and(|project|project.lane_specs.iter().enumerate().any(|(ordinal,lane)|self.lane_entered.get(&lane.id).is_some_and(|entered|entered.elapsed().as_secs_f32()<0.55+ordinal as f32*0.07))));
        let solo = self.solo.iter().any(|s| *s);
        for i in 0..tracks::LANE_SLOTS {
            let target = if !self.muted[i] && (!solo || self.solo[i]) {
                1.
            } else {
                0.14
            };
            if (self.fade[i] - target).abs() > 0.002 {
                self.fade[i] += (target - self.fade[i]) * (dt / 0.15).min(1.);
                demand.set(frame_demand::Source::LaneFade, true);
            }
        }
        if self.backend.is_some() {
            self.playhead.shown(now);
            // A pending receipt gets at most one second on the existing frame
            // clock, even while paused; ordinary idle schedules no extra frames.
            demand.set(frame_demand::Source::Playback, self.playing && !self.transport_flight.counting_in);
            demand.set(frame_demand::Source::PendingSeek, self.playhead.pending_seek().is_some());
        }
        if self.playing && self.backend.is_none() && self.screen == Screen::Player && !modal_open {
            self.playhead.advance_demo(dt as f64 * self.tempo as f64, self.duration, self.looping);
            if self.playhead.position() >= self.duration { self.playing = false; }
            demand.set(frame_demand::Source::DemoPlayback, true);
        }
        // Deterministic capture only: external runner advances song time one display-frame at a time.
        if let Some(path) = self.capture_file.clone() {
            if let Ok(value) = std::fs::read_to_string(&path) {
                if let Ok(position) = value.trim().parse::<f64>() {
                    self.playhead.seek(position.clamp(0., self.duration));
                    self.playing = false;
                    window.on_next_frame(move |_, _| {
                        let _ = std::fs::write(path.with_extension("ack"), value);
                    });
                }
            }
            demand.set(frame_demand::Source::Capture, true);
        }
        demand.set(frame_demand::Source::Timeline, self.advance_timeline(now,self.screen==Screen::Player&&!modal_open));
        self.pitch_strip.update(cx, |strip, cx| {
            strip.set_position(self.display_position(), cx);
            strip.set_view(self.view_start, self.view_end, cx);
        });
        demand.set(frame_demand::Source::CountIn, self.playing && self.transport_flight.timing_status.as_ref().is_some_and(|status|status.count_in_heard.is_some()));
        #[cfg(feature = "ui-tests")]
        UI_FRAME_DEMAND_BITS.store(demand.bits(), std::sync::atomic::Ordering::Relaxed);
        if !demand.is_empty() && self.screen == Screen::Player && !modal_open {
            #[cfg(feature = "ui-tests")]
            UI_FRAME_REQUESTS.fetch_add(1, std::sync::atomic::Ordering::Relaxed);
            window.request_animation_frame();
        }

        let base_screen = if matches!(self.screen, Screen::Settings | Screen::Log | Screen::Models)
        {
            self.previous_screen
        } else {
            self.screen
        };
        let timeline_width =
            (f32::from(window.viewport_size().width) - if self.karaoke { 360. } else { 0. } - 260.)
                .max(1.);
        let span = (self.view_end - self.view_start) * self.duration;
        let step = [
            0.1, 0.2, 0.5, 1., 2., 5., 10., 15., 30., 60., 120., 300., 600.,
        ]
        .into_iter()
        .find(|step| span>0.&&timeline_width as f64 * step / span >= 74.)
        .unwrap_or(600.);
        let ticks = timeline_host::ruler_ticks(timeline_viewport::View {
            start: self.view_start * self.duration,
            end: self.view_end * self.duration,
        }, step);
        let scrub_bounds = self.region.bounds.clone();
        let scrub_hit = scrub_bounds.clone();
        let head =
            if self.duration>0.&&self.view_end>self.view_start{(self.display_position()/self.duration-self.view_start)/(self.view_end-self.view_start)}else{-1.};
        let region_owner=cx.entity().downgrade();
        let selection=self.region_target().selection.and_then(|(s,e)| {
            let span=(self.view_end-self.view_start)*self.duration;
            if span<=0. {return None;}
            let left=(s-self.view_start*self.duration)/span;
            let right=(e-self.view_start*self.duration)/span;
            (right>0. && left<1.).then_some((left.max(0.),right.min(1.)))
        });
        let playhead = div()
            .absolute()
            .left(px(238.))
            .right(px(22.))
            .top(px(4.))
            .bottom(px(10.))
            .min_h(px(414.))
            .on_scroll(cx.listener(|this,event:&ScrollEvent,window,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_scroll(event,bounds,window,cx);}}))
            .on_pinch(cx.listener(|this,event:&PinchEvent,_,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_pinch(event,bounds,cx);}}))
            .child(
                canvas(
                    move |bounds, _, _| {
                        scrub_bounds.set(Some(bounds));
                        bounds
                    },
                    move |_, _, window, _| {
                        let moving=region_owner.clone();
                        window.on_mouse_event(move |event:&MouseMoveEvent,phase,_,cx| {
                            if phase!=DispatchPhase::Capture {return;}
                            let _=moving.update(cx,|this,cx| {
                                if this.region.gesture.is_some() {
                                    if event.pressed_button==Some(MouseButton::Left) {
                                        this.move_region(f32::from(event.position.x),cx);
                                    } else {this.region.gesture=None;}
                                } else {this.hover_region(event.position,cx);}
                            });
                        });
                        let ending=region_owner.clone();
                        window.on_mouse_event(move |event:&MouseUpEvent,phase,_,cx| {
                            if phase!=DispatchPhase::Capture || event.button!=MouseButton::Left {return;}
                            let _=ending.update(cx,|this,cx|this.end_region(cx));
                        });
                    },
                )
                .absolute()
                .inset_0(),
            )
            .when_some(selection,|overlay,(left,right)|overlay.child(div().absolute().top_0().bottom_0()
                .left(relative(left as f32)).w(relative((right-left).max(0.) as f32))
                .bg(rgba(0xffa02817)).border_l_1().border_r_1().border_color(rgba(0xffa02899))))
            .when((0. ..=1.).contains(&head), |overlay| {
                overlay.child(canvas(
                    |b, _, _| b,
                    move |_, b, w, _| alloc_probe::scope(|| playhead_overlay::paint(w, b, head)),
                ).absolute().inset_0())
            });
        if self.screen != Screen::Player || modal_open {
            self.metronome_open = false;
        }
        self.metronome_ui.update(cx, |s, cx| {
            s.context(self.playhead.position(), self.duration);
            s.set_can_detect(self.project.as_ref().is_some_and(|p|p.lanes.iter().any(|(i,_)|*i == 1)),cx);
        });
        if self.lyrics_editor_open {
            self.lyrics_editor.update(cx,|s,cx|s.context_playback(self.playhead.position() as f64,self.duration as f64,self.playing,if self.backend.is_some()&&!self.transport_flight.counting_in&&self.playhead.pending_seek().is_none()&&self.capture_file.is_none(){self.playhead.anchor().map(|(p,t)|(p as f64,t))}else{None},self.native_rate as f64,self.playhead.loop_range().map(|(s,e)|(s as f64,e as f64)),cx));
        }
        self.pitch_strip.update(cx, |s, cx| {
            s.set_beat_tempo(self.beats.as_ref().map(|g| g.bpm), cx)
        });
        self.pitch_strip.update(cx, |s,cx|s.set_beat_progress(self.beat_job.map(|_|self.beat_progress),cx));
        self.transport.update(cx, |t, cx| {
            let enabled = self.metronome.click || self.metronome.grid;
            if t.met_enabled != enabled {
                t.met_enabled = enabled;
                cx.notify();
            }
        });
        if !backdrop_open { self.refresh_transport_timing(cx); }
        self.transport.update(cx,|t,cx|t.reconcile_focus(window,cx));
        let ruler_grid = self.paint_beats.clone().filter(|_| self.metronome.grid);
        let ruler_grid_cache = self.beat_cache.clone();
        let ruler_view = (
            self.view_start * self.duration,
            self.view_end * self.duration,
        );
        self.beat_handles.update(cx, |handles, cx| handles.set_context(
            ruler_grid.clone().filter(|_| !modal_open && self.metronome_flight.metronome.is_none() && !self.source_blocks_player()),
            ruler_view.0, ruler_view.1, self.duration, cx));
        // The source zoom cluster is z=6, above the z=5 scrub/playhead layer.
        // Keep the ruler-relative geometry (4px stack inset + 3px top) while
        // painting this opaque control group after that layer.
        let ruler_frame=Rc::new(ruler_clearance::Frame::default());
        #[cfg(feature="ui-tests")]
        { self.ruler_frame=ruler_frame.clone(); }
        let ruler_column_right=window.viewport_size().width-if self.karaoke {px(360.)}else{px(0.)};
        let zoom_controls=ruler_frame.zoom(div().absolute().right(px(22.)).top(px(7.)).pl(px(10.)).bg(rgb(BG)).occlude()
            .child(singz_uikit::zoom_segment(vec![
                self.track_probe("zoom-out".into(),singz_uikit::zoom_button("zoom-out","−",false)).on_click(cx.listener(|this,_,_,cx|this.zoom_by(1.4,cx))),
                self.track_probe("zoom-in".into(),singz_uikit::zoom_button("zoom-in","+",false)).on_click(cx.listener(|this,_,_,cx|this.zoom_by(0.65,cx))),
                self.track_probe("zoom-fit".into(),singz_uikit::zoom_button("zoom-fit",i18n::t("player.stack.full"),self.view_start==0.&&self.view_end==1.)).on_click(cx.listener(|this,_,_,cx|this.timeline_input(timeline_viewport::Input::Fit,cx))),
            ])));
        self.backdrop_clock.painted(self.native_epoch, self.playhead.position());
        let backdrop_key = singz_uikit::ModalBackdropKey::new(
            window.viewport_size(), window.scale_factor(), self.backdrop_content_revision(cx));
        let backdrop = self.backdrop.clone();
        let content = match base_screen {
            Screen::Training => self.training.clone().into_any_element(),
            Screen::Library => self.library.clone().into_any_element(),
            Screen::Settings | Screen::Log | Screen::Models => unreachable!(),
            Screen::Player => div().flex().flex_col().flex_1().min_h_0()
                .child(div().flex().flex_1().min_h_0()
                    .child(div().flex_1().min_w_0().min_h_0().flex().flex_col()
                        .child(div().relative().flex_1().min_h_0().overflow_hidden().pl(px(10.)).pr(px(22.)).pt(px(4.)).pb(px(10.)).flex().flex_col()
                            .child(div().h(px(30.)).flex_shrink_0().flex()
                                .child(div().w(px(228.)).pl(px(14.)).flex().gap(px(5.)).items_center()
                                    .child(singz_uikit::song_button_with_focus(self.track_probe("add".into(),singz_uikit::ruler_button("add-track",i18n::t("player.stack.addTrack"),false,false)),self.track_header_focus[0].clone(),true,{
                                        let entity=cx.entity().downgrade();
                                        move|w,cx| {let _=entity.update(cx,|this,cx| {
                                            // Source Add blurs before invoking its chooser.
                                            this.focus_handle.focus(w,cx);this.browse_custom_tracks(cx);
                                        });}
                                    }))
                                    .children(["M","S","↓"].into_iter().enumerate().map(|(i,label)| {
                                        let disabled=match i {0=>!self.muted.iter().any(|value|*value),1=>!self.solo.iter().any(|value|*value),_=>self.backend.is_some()&&!self.audio_available()};
                                        let button=self.track_probe(if i==2{"export".into()}else{format!("all-track-{i}")},singz_uikit::ruler_button(("all-track",i),label,true,disabled));
                                        if i<2 {
                                            let entity=cx.entity().downgrade();
                                            singz_uikit::song_button_with_focus(button,self.track_reset_focus[i].clone(),!disabled,move|_,cx| {
                                                let _=entity.update(cx,|this,cx| {
                                                    if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some())||this.tracks_audio_failed{return;}
                                                    if i==0 {this.muted=[false;tracks::LANE_SLOTS];}else{this.solo=[false;tracks::LANE_SLOTS];}
                                                    for lane in 0..tracks::LANE_SLOTS{this.sync_lane(lane,cx);}cx.notify();
                                                });
                                            })
                                        }else{
                                            let entity=cx.entity().downgrade();
                                            singz_uikit::song_button_with_focus(button,self.track_header_focus[1].clone(),!disabled,move|_,cx| {
                                                let _=entity.update(cx,|this,cx| {
                                                    if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some())||this.tracks_audio_failed{return;}
                                                    this.open_stem_export(cx);cx.notify();
                                                });
                                            })
                                        }
                                    }))
                                )
                                .child(div().id("time-ruler").relative().flex_1()
                                    .on_scroll(cx.listener(|this,event:&ScrollEvent,window,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_scroll(event,bounds,window,cx);}}))
                                    .on_pinch(cx.listener(|this,event:&PinchEvent,_,cx| {if let Some(bounds)=this.region.bounds.get(){this.timeline_pinch(event,bounds,cx);}}))
                                    .cursor(if self.region.resize_hover {CursorStyle::ResizeLeftRight}else{CursorStyle::IBeam}).border_b_1().border_color(rgba(0xfff0d614))
                                    .on_mouse_down(MouseButton::Left,cx.listener(move |this,event:&MouseDownEvent,_,cx| {
                                        if let Some(bounds)=scrub_hit.get() {
                                            if event.position.x>bounds.right()-px(130.) {return;}
                                            this.begin_region(f32::from(event.position.x),bounds,cx);
                                        }
                                    }))
                                    .child(canvas(|b,_,_|b,move|_,b,w,cx|{if let Some(g)=&ruler_grid{beat_grid::paint(&mut ruler_grid_cache.borrow_mut(),g,ruler_view.0,ruler_view.1,b,true,w,cx);}}).absolute().top_0().left_0().size_full())
                                    .children(ticks.into_iter().map(|(tick,fraction)| {
                                        let text=timeline_host::ruler_label(tick,step);
                                        div().absolute().left(relative(fraction as f32)).ml(px(-30.)).w(px(60.)).top(px(8.)).flex().justify_center()
                                            .child(ruler_frame.label(text.clone(),singz_uikit::tracked_text(text,"SingZ Mono 400",9.,0.54,FAINT),ruler_column_right))
                                    }))
                                    .child(self.beat_handles.clone())
                                ))
                            .child(div().id("stem-lane-scroll").track_scroll(&self.stem_scroll_handle).flex().flex_col().flex_1().min_h_0().overflow_y_scroll().children(self.project.as_ref().map(|p|p.lanes.iter().map(|(slot,_)|*slot).collect::<Vec<_>>()).unwrap_or_else(||(0..6).collect()).into_iter().map(|i|self.lane(i,cx)))).when(self.audio_available(),|d|d.child(playhead)).child(zoom_controls))
                        .when(self.karaoke, |column| column.child(self.pitch_strip.clone())))
                    .when(self.karaoke,|row|row.child(div().w(px(360.)).flex_shrink_0().border_l_1().border_color(rgba(0xfff0d614)).bg(rgba(0x1b181466)).flex().flex_col()
                        .child(div().h(px(53.)).flex_shrink_0().when(true,|d|self.quick_start.read(cx).anchors.track_box(d,"lyrics",[0.,0.,0.,1.])).px(px(18.)).pt(px(14.)).pb(px(12.)).flex().items_center().justify_between().border_b_1().border_color(rgba(0xfff0d614))
                            .child(singz_uikit::tracked_text(i18n::t("lyrics.panel.title"),"SingZ Display 800",15.,0.3,TEXT))
                            .child(pill("guide",i18n::t("lyrics.panel.guide.label"),!self.muted[0]).h(px(26.)).rounded(px(7.)).px(px(10.)).text_size(px(11.)).shadow(vec![]).bg(if self.muted[0]{rgba(0)}else{rgba(0xffa02821)}).border_color(if self.muted[0]{rgba(0xfff0d614)}else{rgba(0xffa0288c)}).on_click(cx.listener(|this,_,_,cx| { if (this.tracks_flight.tracks_pending.is_some()||this.carry_flight.carry.is_some())||this.tracks_audio_failed{return;}this.muted[0]=!this.muted[0];this.sync_lane(0,cx);cx.notify(); }))))
                        .when(self.backend.is_none(),|sidebar|sidebar.child(div().h(px(59.)).flex_shrink_0().px(px(18.)).py(px(9.)).border_b_1().border_color(rgba(0xfff0d614)).flex().flex_col().gap(px(4.))
                            .child(div().flex().items_center().gap(px(8.)).child(singz_uikit::source_badge(if self.project.is_none(){"Edited"}else{match self.lyric_document.source.as_str(){"lrclib"=>"Synced","whisper"=>"AI transcribed",_=>"Edited"}},true)).child(div().flex_1().text_size(px(11.5)).text_color(rgb(DIM)).child(if self.project.is_none(){"Demo lyrics".to_owned()}else if self.lyric_document.credit.is_empty(){"Saved lyrics".to_owned()}else{self.lyric_document.credit.clone()})).child(singz_uikit::lyrics_action("lyric-check",i18n::t("lyrics.panel.checkAlign.label"))))
                            .child(div().flex().gap(px(8.)).children([i18n::t("lyrics.panel.precise.label"),i18n::t("lyrics.panel.edit.label"),i18n::t("lyrics.panel.change.label")].into_iter().enumerate().map(|(i,label)| {
                                let bounds=self.lyrics_edit_bounds.clone();
                                singz_uikit::lyrics_action(("lyric-action",i),label).on_click(cx.listener(move|this,_,w,cx| {
                                    if i==1 {this.open_lyrics_editor(w,cx);}else{this.notice=Some("This lyrics action is not connected yet.".into());cx.notify();}
                                })).when(i==1,|d|d.relative().child(canvas(move|b,_,_|{bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0()))
                            })))))
                        .when(self.backend.is_some(),|sidebar|sidebar.child(self.lyrics_sidebar.clone()))
                        .when(self.backend.is_none()||self.lyrics_sidebar.read(cx).shows_lyrics(),|sidebar|sidebar.child(self.lyrics(cx))))))
                .child(self.transport.clone()).into_any_element(),
        };
        let root = div()
            .id("app")
            .on_drop::<ExternalPaths>(cx.listener(|this, paths: &ExternalPaths, _, cx| {
                if this.backend.is_some() && !this.quick_start.read(cx).is_open() && !this.project_delete.read(cx).is_open() {
                    if let Some(path) = paths.paths().first() {
                        this.open_source(path.clone(), cx);
                    }
                }
            }))
            .track_focus(&self.focus_handle)
            .capture_key_down(cx.listener(|this,event:&KeyDownEvent,window,cx|desktop_keyboard::capture(this,event,window,cx)))
            .on_key_down(cx.listener(|this, event: &KeyDownEvent, window, cx| {
                #[cfg(feature="ui-tests")]
                if std::env::var_os("SINGZ_GPUI_EMPTY_PROJECT_TEST").is_some()&&event.keystroke.key=="s"&&(event.keystroke.modifiers.platform||event.keystroke.modifiers.control){
                    eprintln!("EMPTY_PROJECT actual CmdS root admission: rootFocus={} headerFocus={:?} import={} rename={} source={:?} saving={} rate={} met={} metSave={} waiting={}",this.focus_handle.is_focused(window),this.header.read(cx).focused_control(window),this.library_import_open,this.track_rename.is_some(),this.source_job,this.saving,this.rate_busy(),this.metronome_flight.metronome.is_some(),this.metronome_flight.metronome_save_requested,this.metronome_flight.metronome_save_waiting);
                }
                let desktop_command=(cfg!(target_os="macos")&&event.keystroke.modifiers.platform)
                    ||(!cfg!(target_os="macos")&&event.keystroke.modifiers.control);
                if desktop_command&&event.keystroke.key=="," {
                    this.open_desktop_settings(window,cx);cx.stop_propagation();return;
                }
                // The topmost notice owns keys, even above an editor or a
                // failed Source publication. Escape must not cancel that work.
                if this.notice.is_some() {
                    if event.keystroke.key=="escape" { this.notice=None;cx.notify(); }
                    cx.stop_propagation();return;
                }
                if this.language_menu.read(cx).is_open(){return;}
                if this.transport.read(cx).bpm_focused(window,cx)&&!(event.keystroke.key=="s"&&((cfg!(target_os="macos")&&event.keystroke.modifiers.platform)||(!cfg!(target_os="macos")&&event.keystroke.modifiers.control))){return;}
                if this.track_rename.is_some(){
                    if event.keystroke.key=="escape"{this.track_rename=None;this.focus_player=true;cx.notify();}
                    cx.stop_propagation();return;
                }
                if this.project_delete.read(cx).is_open() { cx.stop_propagation();return; }
                if event.keystroke.key=="escape" { this.cancel_delete_inspection(); }
                if this.backend.is_some()&&this.karaoke&&this.lyrics_sidebar.read(cx).input_focused(window,cx){return;}
                if this.lyrics_editor_open&&this.lyrics_editor.read(cx).text_input_focused(window,cx){return;}
                if this.drive_projects_open&&this.drive_projects.read(cx).text_input_focused(window,cx){return;}
                if this.lyrics_editor_open||this.project_picker_open||this.drive_projects_open||this.library_import_open||this.stem_export_open||this.engine_setup.read(cx).is_open()||this.whats_new.read(cx).is_open() {cx.stop_propagation();return;}
                if this.carry_open {cx.stop_propagation();return;}
                if this.metronome_open {
                    if event.keystroke.key == "escape" {
                        this.metronome_ui.update(cx, |s, cx| s.cancel(window, cx));
                        this.metronome_open = false;
                        this.focus_player = true;
                        cx.notify();
                        cx.stop_propagation();
                        return;
                    }
                    if this.metronome_ui.read(cx).focused(window, cx) {
                        return;
                    }
                }
                if this.quick_start.read(cx).is_open() {
                    cx.stop_propagation();
                    return;
                }
                if this.header.read(cx).is_editing() {
                    // Leave ordinary text keys available to the platform IME.
                    // The capture guard already excludes title-entry focus.
                    return;
                }
                if this.screen == Screen::Models {
                    cx.stop_propagation();
                    return;
                }
                if this.screen == Screen::Settings {
                    // Settings owns input even while focus is transitioning or
                    // a field disappears; application song/file keys stay behind it.
                    if event.keystroke.key == "escape" { this.dismiss_screen_on_escape(cx); }
                    cx.stop_propagation();
                    return;
                }
                if (this.carry_flight.carry.is_some()||this.rate_busy())&&event.keystroke.key=="s"&&((cfg!(target_os="macos")&&event.keystroke.modifiers.platform)||(!cfg!(target_os="macos")&&event.keystroke.modifiers.control)) {
                    this.save_project(cx);cx.stop_propagation();return;
                }
                if event.keystroke.key == "escape"
                    && this.transport.update(cx, |t, cx| t.dismiss_popovers(cx))
                {
                    cx.stop_propagation();
                    return;
                }
                if this.transport.read(cx).has_popover() {
                    // Owned transport menus keep song/file commands behind
                    // them, including while a menu item loses eligibility.
                    cx.stop_propagation();
                    return;
                }
                let command = (cfg!(target_os = "macos") && event.keystroke.modifiers.platform)
                    || (!cfg!(target_os = "macos") && event.keystroke.modifiers.control);
                if event.keystroke.key=="escape" && this.dismiss_screen_on_escape(cx) {
                    cx.stop_propagation();return;
                }
                if this.source_blocks_except_rate() {
                    if event.keystroke.key == "escape" {
                        this.cancel_source_from_escape(cx);
                    }
                    cx.stop_propagation();
                    return;
                }
                if this.backend.is_some() && this.screen==Screen::Player && event.keystroke.key=="escape" {
                    this.region.gesture=None;
                    let target=this.region_target();
                    if target.selection.is_some() {
                        this.request_region(region_gesture::Target{selection:None,..target},cx);
                    } else {
                        this.karaoke=false;
                        this.remember_karaoke(false,cx);
                        this.transport.update(cx,|transport,cx|transport.set_karaoke(false,cx));
                    }
                    cx.notify();cx.stop_propagation();return;
                }
                if this.backend.is_some() && command && event.keystroke.key == "o" {
                    this.browse(cx);
                    cx.stop_propagation();
                    return;
                }
                if this.backend.is_some() && command && event.keystroke.key == "f" {
                    this.enter_desktop_catalog(cx);
                    this.library
                        .update(cx, |library, cx| library.focus_search(window, cx));
                    cx.notify();
                    cx.stop_propagation();
                    return;
                }
                if this.backend.is_some()
                    && event.keystroke.key == "s"
                    && ((cfg!(target_os = "macos") && event.keystroke.modifiers.platform)
                        || (!cfg!(target_os = "macos") && event.keystroke.modifiers.control))
                {
                    this.save_project(cx);
                    cx.stop_propagation();
                    return;
                }
                if this.backend.is_some()
                    && this.screen == Screen::Player
                    && this.notice.is_none()
                    && this.focus_handle.is_focused(window)
                {
                    match event.keystroke.key.as_str() {
                        "space" => {
                            this.native_transport(transport::TransportEvent::Play, cx);
                            cx.stop_propagation();
                            return;
                        }
                        "home" => {
                            this.native_transport(transport::TransportEvent::Restart, cx);
                            cx.stop_propagation();
                            return;
                        }
                        "left" | "right" => {
                            let direction = if event.keystroke.key == "left" {
                                -1.
                            } else {
                                1.
                            };
                            this.playhead.seek((this.playhead.position() + direction * 5.).clamp(0., this.duration));
                            this.seek_native(cx);
                            cx.stop_propagation();
                            return;
                        }
                        _ => {}
                    }
                }

            }))
            .relative()
            .size_full()
            .flex()
            .flex_col()
            .when(cfg!(not(target_os = "macos")), |root| root.bg(rgb(BG)))
            .child(
                self.background
                    .render(window.viewport_size(), window.scale_factor()),
            )
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_color(rgb(TEXT))
            .text_size(px(14.))
            .child(
                window_chrome::header(self.header_drag.clone(), window.is_fullscreen())
                    .child(self.header.clone()),
            )
            .child(content)
            .when(self.carry_open,|root|root.child(self.carry_popover.clone()))
            .when(self.metronome_open, |root| {
                if let Some(anchor) = self.transport.read(cx).guides.get("metronome") {
                    self.metronome_ui
                        .update(cx, |s, _| s.trigger = Some(anchor));
                    root.child(
                        div()
                            .absolute()
                            .left(px((f32::from(anchor.left()) - 8.)
                                .clamp(8., f32::from(window.viewport_size().width) - 332.)))
                            .bottom(window.viewport_size().height - anchor.top() + px(12.))
                            .child(self.metronome_ui.clone()),
                    )
                } else {
                    root
                }
            })
            .when(self.notice.is_none(),|root|root.child(self.success_toast.clone()))
            .when(backdrop_open, |root| root.child(
                canvas(|bounds, _, _| bounds, move |bounds, _, window, cx| {
                    if let Err(error) = backdrop.borrow_mut().paint(
                        backdrop_key, bounds, window, cx,
                        |window| window.render_painted_prefix_to_image(),
                    ) {
                        diagnostics::log("ui", &format!("Modal backdrop capture failed: {error:#}"), diagnostics::Level::Warn);
                    }
                }).absolute().inset_0()
            ))
            .when(self.whats_new.read(cx).is_open() && self.release_surface_available(cx),|root|{
                root.child(self.whats_new.clone())
            })
            .when(self.engine_setup.read(cx).is_open(),|root|{
                root.child(self.engine_setup.clone())
            })
            .when(self.stem_export_open, |root| {
                root.child(self.stem_export_dialog.clone())
            })
            .when(self.library_import_open, |root| {
                root.child(self.library_import.clone())
            })
            .when(self.project_picker_open, |root| {
                root.child(self.project_picker.clone())
            })
            .when(self.drive_projects_open, |root| {
                root.child(self.drive_projects.clone())
            })
            .when(self.project_delete.read(cx).is_open(), |root| {
                root.child(self.project_delete.clone())
            })
            .when(self.lyrics_editor_open, |root| {
                root.child(singz_uikit::modal_scrim().absolute().inset_0().on_mouse_down(MouseButton::Left,cx.listener(|s,_,_,cx|{
                        s.lyrics_editor.update(cx,|editor,cx|editor.request_close(cx));cx.stop_propagation();
                    })).child(self.lyrics_editor.clone()))
            })
            .when(self.screen == Screen::Settings, |root| {
                root.child(
                    singz_uikit::modal_scrim()
                        .id("settings-scrim")
                        .on_mouse_down(
                            MouseButton::Left,
                            cx.listener(|this, event: &MouseDownEvent, window, cx| {
                                let viewport = window.viewport_size();
                                let width = (f32::from(viewport.width) - 48.).min(960.);
                                let left = (f32::from(viewport.width) - width) / 2.;
                                if f32::from(event.position.x) < left
                                    || f32::from(event.position.x) > left + width
                                    || f32::from(event.position.y) < 24.
                                    || f32::from(event.position.y)
                                        > f32::from(viewport.height) - 24.
                                {
                                    this.screen = this.previous_screen;
                                    cx.notify();
                                    cx.stop_propagation();
                                }
                            }),
                        )
                        .child(self.settings.clone()),
                )
            })
            .when(self.screen == Screen::Log, |root| {
                root.child(self.log_panel.clone())
            })
            .when(self.screen == Screen::Models, |root| {
                root.child(self.models.clone())
            });
        #[cfg(feature = "ui-tests")]
        let root = root.when(self.text_phase_check, |root| {
            root.child(ui_text_phase::overlay())
        });
        let root = root.when(self.loading && !self.source_split_loading(), |root| {
            root.child(
                singz_uikit::modal_scrim().child(
                    singz_uikit::modal_card()
                        .w(px(360.))
                        .child("Opening project…"),
                ),
            )
        });
        let root = root.when(
            self.source_job.is_some() && self.source_split.is_none(),
            |root| {
                root.child(
                    singz_uikit::modal_scrim().child(
                        singz_uikit::modal_card()
                            .w(px(440.))
                            .flex()
                            .flex_col()
                            .gap(px(14.))
                            .child(
                                div()
                                    .text_size(px(16.))
                                    .font_family(singz_uikit::tokens::DISPLAY_700)
                                    .child(if self.source_status.label.is_empty() {
                                        "Preparing…".to_owned()
                                    } else {
                                        self.source_status.label.clone()
                                    }),
                            )
                            .child(singz_uikit::model_progress(self.source_status.percent))
                            .child(
                                div().flex().justify_end().when(!self.source_saving, |row| row.child(
                                    singz_uikit::ghost_pill("source-cancel", "Cancel")
                                        .on_click(cx.listener(|s, _, _, cx| s.cancel_source(cx))),
                                )),
                            ),
                    ),
                )
            },
        );
        let root = root.when(
            self.quick_start.read(cx).is_open()
                && !matches!(self.screen, Screen::Settings | Screen::Models | Screen::Log)
                && self.notice.is_none()
                && !self.loading,
            |root| root.child(self.quick_start.clone()),
        );
        let root=root.when(self.language_menu.read(cx).is_open(),|root|root.child(self.language_menu.clone()));
        let root = root.when(self.screen == Screen::Log || self.engine_setup.read(cx).is_open(), |root| {
            root.child(gpui_kit::base::TextSelectionLayer)
        });
        let root = root.when_some(self.notice.clone(), |root, text| {
                root.child(
                    singz_uikit::modal_scrim().child(
                        singz_uikit::modal_card()
                            .w(px(480.))
                            .gap(px(20.))
                            .child(text)
                            .child(self.notice_close(cx)),
                    ),
                )
            });
        let root = root.when(
                cfg!(any(target_os = "windows", target_os = "linux")),
                |root| root.child(singz_uikit::window_buttons(window.is_maximized())),
            )
            .when(
                cfg!(target_os = "linux") && !window.is_maximized() && !window.is_fullscreen(),
                |root| root.children(singz_uikit::window_resize_edges(window.viewport_size())),
            );
        root
    }
}

struct Assets;
impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(Some(Cow::Borrowed(match path {
            "transport-met" => include_bytes!("../assets/icons/transport-met.svg"),
            "transport-carry" => include_bytes!("../assets/icons/transport-carry.svg"),
            "transport-mic" => include_bytes!("../assets/icons/transport-mic.svg"),
            "transport-speaker" => include_bytes!("../assets/icons/transport-speaker.svg"),
            "transport-chevron" => include_bytes!("../assets/icons/transport-chevron.svg"),
            "header-logo-z" => include_bytes!("../assets/icons/header-logo-z.svg"),
            "header-gear" => include_bytes!("../assets/icons/header-gear.svg"),
            "header-catalog" => include_bytes!("../assets/icons/header-catalog.svg"),
            "play" => include_bytes!("../assets/icons/play.svg"),
            "pause" => include_bytes!("../assets/icons/pause.svg"),
            "restart" => include_bytes!("../assets/icons/restart.svg"),
            "loop" => include_bytes!("../assets/icons/loop.svg"),
            _ => return Ok(None),
        })))
    }
    fn list(&self, _: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(vec![])
    }
}

fn main() {
    let crash_events = diagnostics::install_panic_hook(audio_devices::directory().join("logs"), release_highlights::CURRENT_VERSION);
    let previous_crashes = diagnostics::pending_crashes(&audio_devices::directory().join("logs"));
    #[cfg(feature="ui-tests")]
    ui_crash::before_start();
    // Keep the ui-tests marker referenced so ELF/MSVC linkers cannot discard it.
    #[cfg(feature = "ui-tests")]
    std::hint::black_box(SINGZ_GPUI_UI_TESTS_BUILD_MARKER);
    if std::env::args_os().nth(1).as_deref()==Some(std::ffi::OsStr::new("--native-build-info")) {
        if native_build_info::print().is_err() {
            eprintln!("Cannot read native build metadata");std::process::exit(1);
        }
        return;
    }
    migrate::startup();
    text_rendering::configure();
    let application=gpui_kit::application().with_assets(Assets);
    application.on_reopen(desktop_lifecycle::reopen);
    application.run(|cx| {
        gpui_kit::init(cx);
        quick_start::init(cx);
        singz_uikit::init(cx);
        #[cfg(target_os = "linux")]
        cx.set_global(gpui_kit::component::WindowFrameStyle {
            shadow_size: px(0.),
            border_size: px(0.),
        });
        #[cfg(target_os = "macos")]
        {
            gpui_kit::component::Theme::global_mut(cx).tokens.background =
                Hsla::from(rgba(0)).into();
        }
        let background = std::env::var_os("SINGZ_GPUI_BACKGROUND").is_some();
        desktop_lifecycle::install_actions(cx);
        let (window_handle, view) = desktop_lifecycle::open_player_window(cx).expect("open player");
        let _ = window_handle.update(cx, |_, window, _| window.on_next_frame(|_, _| migrate::after_first_frame()));
        let crash_view = view.clone();
        let startup_pending = std::cell::Cell::new(!previous_crashes.is_empty());
        let deliver_crash = std::rc::Rc::new(move |view: &Entity<Player>, cx: &mut App| {
            if !startup_pending.get() && !diagnostics::background_panic_pending() { return; }
            let player = view.read(cx);
            if player.language_state.is_none() || player.notice.is_some() { return; }
            let sink = player.diagnostics.as_ref().map(|service| service.sink());
            if startup_pending.get() {
                if let Some(sink) = sink {
                    startup_pending.set(false);
                    if diagnostics::report_crashes(&previous_crashes, &sink) {
                        view.update(cx, |player, cx| { player.notice = Some(i18n::t("app.crash.previous")); cx.notify(); });
                        return;
                    }
                }
            }
            if diagnostics::take_background_panic() {
                view.update(cx, |player, cx| { player.notice = Some(i18n::t("app.crash.internal")); cx.notify(); });
            }
        });
        let on_player_change = deliver_crash.clone();
        cx.observe(&view, move |view, cx| on_player_change(&view, cx)).detach();
        deliver_crash(&view, cx);
        cx.spawn(async move |cx| {
            while crash_events.recv().await.is_ok() {
                cx.update(|cx| deliver_crash(&crash_view, cx));
            }
        }).detach();
        #[cfg(feature="ui-tests")]
        ui_crash::run(window_handle, view.clone(), cx);

        #[cfg(all(feature="ui-tests",target_os="macos"))]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_DESKTOP_LIFECYCLE_TEST") {
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_desktop_lifecycle::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_PROJECT_KEY_TEST") {
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_project_key::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_DIAGNOSTICS_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_diagnostics::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_ENGINE_SETUP_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_engine_setup::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(all(feature = "ui-tests", target_os = "macos"))]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_ACCESSIBILITY_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_accessibility::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(all(feature = "ui-tests", target_os = "macos"))]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_ACCESSIBILITY_ROUTES_TEST") { assert!(background && std::env::var_os("SINGZ_MUTE").is_some()); ui_accessibility_routes::run(window_handle, view.clone(), directory.into(), cx); }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_GUIDE_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_quick_start::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_METRONOME_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_metronome::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_LYRICS_EDITOR_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_lyrics_editor::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_LIBRARY_IMPORT_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_library_import::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_PROJECT_PICKER_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_project_picker::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_Q04_TEST"){ assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"), "Q-04 requires background and SINGZ_MUTE=1"); ui_analysis_lyrics_races::run(window_handle,view.clone(),directory.into(),cx); }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_LYRICS_ALIGN_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_lyrics_align::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_OPEN_STEPS_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_open_steps::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_BAR_EDIT_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_bar_edit::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_FIRST_RUN_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_first_run::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_SPACE_FOCUS_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_space_focus::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_PLAYED_EDGE_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_played_edge::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_SETTINGS_RELAUNCH_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_settings_relaunch::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_BEAT_DETECTION_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_beat_detection::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_LYRICS_SIDEBAR_TEST"){
            assert!(background&&std::env::var_os("SINGZ_MUTE").is_some());
            ui_lyrics_sidebar::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_WHATS_NEW_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_whats_new::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TITLE_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_title::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MIGRATION_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_migration::run(window_handle, view.clone(), directory.into(), cx);
        } else if let Some(directory) = std::env::var_os("SINGZ_GPUI_SOURCE_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_source::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MODELS_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_models::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_REVIEW") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_DRIVE_RESTORE_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Some(std::ffi::OsStr::new("1")));
            ui_drive_restore::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_AUDIO_PROVIDER_TEST") {
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Some(std::ffi::OsStr::new("1")));
            ui_audio_provider::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_EMPTY_DRIVE_TEST") {
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Some(std::ffi::OsStr::new("1")));
            ui_empty_drive::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_DRIVE_RETIREMENT_TEST") {
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                &&gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Some(std::ffi::OsStr::new("1")));
            ui_drive_retirement::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_PLAYBACK_GRAPH_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && gated_env!("SINGZ_GPUI_TEST_NO_CAPTURE").as_deref()==Some(std::ffi::OsStr::new("1")));
            ui_playback_graph::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_FEEDBACK_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some());
            ui_training_feedback::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_SONG_KEYBOARD_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some());
            ui_training_song_keyboard::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_PREPARATION_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training_preparation::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_HISTORY_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training_history::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_KEYBOARD_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some());
            ui_training_keyboard::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_RUNNING_KEYBOARD_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some());
            ui_training_running_keyboard::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_RUN_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training_run::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_RECOVERY_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1"));
            ui_training_recovery::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_INPUT_RECOVERY_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some());
            ui_training_input_recovery::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_RECORDING_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some() && !integration::fixture_mode());
            ui_training_recording::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_RECORDING_RECOVERY_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some()
                && !integration::fixture_mode());
            ui_training_recording_recovery::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_RECORDING_PUBLICATION_RECOVERY_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1")
                && std::env::var_os("SINGZ_GPUI_CAPTURE_FIXTURE").is_some()
                && !integration::fixture_mode());
            ui_recording_publication_recovery::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_TRANSPORT_LEGS_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_transport_legs::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_TRANSPORT_TIMING_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_transport_timing::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_CARRY_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_carry_line::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_STEM_EXPORT_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_stem_export::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_EMPTY_PROJECT_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_empty_project::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_CUSTOM_TRACK_TEST"){
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_custom_tracks::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_PROJECT_DELETE_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1") && !integration::fixture_mode());
            ui_project_delete::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_AUDIO_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training_audio::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_TRAINING_CAPTURE_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_training_capture::run(directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_LOCALE_TEST") {
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_locale::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory)=std::env::var_os("SINGZ_GPUI_DRIVE_TEST") {
            assert!(background&&std::env::var("SINGZ_MUTE").as_deref()==Ok("1")&&!integration::fixture_mode());
            ui_drive::run(window_handle,view.clone(),directory.into(),cx);
        }
        #[cfg(feature="ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MONITOR_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_monitor::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MONITOR_PUBLICATION_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1"));
            ui_monitor_publication::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MICROPHONE_TEST") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_microphone::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_AUDIO_RECOVERY") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1") && !integration::fixture_mode());
            ui_audio_recovery::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_AUDIO_SETTINGS") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_audio_settings::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_NATIVE_LYRICS") {
            assert!(background && std::env::var_os("SINGZ_MUTE").is_some());
            ui_native_lyrics::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_MODAL_BACKDROP_REVIEW") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref()==Ok("1"));
            ui_modal_backdrop::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_INTEGRATION_TEST") {
            assert!(background, "Native integration requires background mode");
            ui_integration::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_PERF_SCENARIO") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1"));
            ui_perf_scenario::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_UI_SMOKE") {
            assert!(background, "UI smoke requires background mode");
            ui_smoke::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_REVIEW_CAPTURE") {
            assert!(background, "UI review requires background mode");
            ui_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LOG_REVIEW") {
            assert!(background);
            ui_log_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LYRICS_REVIEW") {
            assert!(background, "Lyrics review requires background mode");
            ui_lyrics_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LYRICS_SCROLL_TEST") {
            assert!(background && std::env::var("SINGZ_MUTE").as_deref() == Ok("1") && integration::fixture_mode());
            ui_lyrics_scroll::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(directory) = std::env::var_os("SINGZ_GPUI_LIBRARY_REVIEW") {
            assert!(background, "Library review requires background mode");
            ui_library_review::run(window_handle, view.clone(), directory.into(), cx);
        }
        #[cfg(feature = "ui-tests")]
        if let Some(output) = gated_env!("SINGZ_GPUI_OFFSCREEN_BENCHMARK") {
            assert!(background, "Offscreen benchmark requires background mode");
            ui_benchmark::run(window_handle, view.clone(), output.into(), cx);
        }
        #[cfg(not(feature = "ui-tests"))]
        let _ = (window_handle, view);
        if !background {
            cx.activate(true);
        }
    });
}

//! Native training routes, composed from current VocalTraining.tsx and UIKit controls.
use crate::i18n::{t, tn, tv};
use crate::a11y::ButtonSurface;
#[path = "training_labels.rs"]
mod labels;
use gpui_kit::prelude::*;
use gpui_kit::*;
use labels::{capitalize, instruction, key_label, outcome};
use singz_uikit::{tokens::*, *};
#[path = "training_history.rs"]
mod history;
#[path = "training_running.rs"]
mod running;
#[path = "training_song.rs"]
mod song;
actions!(singz_training_setup, [NextSelectorFocus, PreviousSelectorFocus]);
#[derive(Clone, Debug, Default, PartialEq, Eq, serde::Serialize)]
pub struct RecordingView {
    pub recording: bool,
    pub busy: bool,
    pub can_record: bool,
    pub has_take: bool,
    pub message: Option<String>,
}
#[derive(Clone)]
pub enum TrainingEvent {
    RecordSample,
    FinishRecording,
    SaveRecording,
    End,
    RetrySave,
    BackToSong,
    Start,
    Replay,
    Skip,
    Continue,
    Restart,
    Answer(crate::training_session::Answer),
    Test { sound: usize, volume: f32 },
    Stop,
    Volume(f32),
}
impl EventEmitter<TrainingEvent> for TrainingScreen {}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Route {
    Home,
    Setup,
    Progress,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Exercise {
    Note,
    Degree,
    Interval,
    Chord,
    Arpeggio,
    Scale,
    Mixed,
}
const EXERCISES: [Exercise; 7] = [
    Exercise::Note,
    Exercise::Degree,
    Exercise::Interval,
    Exercise::Chord,
    Exercise::Arpeggio,
    Exercise::Scale,
    Exercise::Mixed,
];
impl Exercise {
    fn title(self) -> String {
        match self {
            Self::Note => t("training.exercise.note.label"),
            Self::Degree => t("training.exercise.scaleDegree.label"),
            Self::Interval => t("training.exercise.interval.label"),
            Self::Chord => t("training.exercise.chordTone.label"),
            Self::Arpeggio => t("training.exercise.arpeggio.label"),
            Self::Scale => t("training.program.scaleLabel"),
            Self::Mixed => t("training.exercise.mixed.label"),
        }
    }
    fn description(self) -> String {
        match self {
            Self::Note => t("training.exercise.note.description"),
            Self::Degree => t("training.exercise.scaleDegree.description"),
            Self::Interval => t("training.exercise.interval.description"),
            Self::Chord => t("training.exercise.chordTone.description"),
            Self::Arpeggio => t("training.exercise.arpeggio.description"),
            Self::Scale => t("training.program.scaleDescription"),
            Self::Mixed => t("training.exercise.mixed.description"),
        }
    }
    fn icon(self) -> TransportIcon {
        match self {
            Self::Note => TransportIcon::TrainingNote,
            Self::Degree | Self::Scale => TransportIcon::TrainingScale,
            Self::Interval => TransportIcon::TrainingInterval,
            Self::Chord => TransportIcon::TrainingChord,
            Self::Arpeggio => TransportIcon::TrainingArpeggio,
            Self::Mixed => TransportIcon::TrainingSettings,
        }
    }
}
pub struct TrainingScreen {
    pub run: Option<crate::training_run::Snapshot>,
    recording: RecordingView,
    audio_available: bool,
    pub testing: bool,
    audio_error: Option<String>,
    pub route: Route,
    pub exercise: Exercise,
    tonic: usize,
    minor: bool,
    task: usize,
    direction: usize,
    low: f32,
    high: f32,
    volume: f32,
    tolerance: usize,
    length: usize,
    sound: usize,
    intervals: [bool; 7],
    degrees: [bool; 7],
    focus: usize,
    level: Option<usize>,
    path_open: bool,
    scroll: ScrollHandle,
    summary_scroll: ScrollHandle,
    open: Option<&'static str>,
    keyboard_scope: FocusHandle,
    keyboard_focus: std::cell::RefCell<std::collections::HashMap<String,FocusHandle>>,
    keyboard_order: std::cell::RefCell<Vec<String>>,
    keyboard_bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String,Bounds<Pixels>>>>,
    selector_options: std::cell::RefCell<std::collections::HashMap<&'static str,Vec<String>>>,
    menu_index: Option<usize>,
    menu_scroll: ScrollHandle,
    typeahead: String,
    typeahead_at: Option<std::time::Instant>,
    keyboard_focus_pending: bool,
    review: bool,
    history: std::sync::Arc<crate::training_store::Snapshot>,
    notation: String,
    guided_scale: bool,
    program_started: Option<u64>,
    song: Option<crate::training_preparation::Song>,
    preparation: Option<crate::training_preparation::Context>,
    mixed_kinds: Option<Vec<crate::training_domain::Kind>>,
    preparation_notice: Option<String>,
    #[cfg(feature = "ui-tests")]
    bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>,
}
impl TrainingScreen {
    #[cfg(feature = "ui-tests")]
    pub fn practice_fixture(&mut self, identify: bool, cx: &mut Context<Self>) {
        self.route = Route::Setup;
        self.exercise = Exercise::Note;
        self.low = 57.;
        self.high = 58.;
        self.length = 1;
        self.task = if identify { 2 } else { 0 };
        self.scroll.set_offset(point(px(0.), px(-2500.)));
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn recovery_fixture(&mut self, cx: &mut Context<Self>) {
        self.practice_fixture(true, cx);
        self.length = 2;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn input_recovery_fixture(&mut self, cx: &mut Context<Self>) {
        self.practice_fixture(false, cx);
        self.length = 2;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn audio_available_for_test(&self) -> bool { self.audio_available }
    #[cfg(feature = "ui-tests")]
    pub fn short_preparation_fixture(&mut self, cx: &mut Context<Self>) {
        self.length = 1;
        self.low = 57.;
        self.high = 58.;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn shutdown_fixture(&mut self, cx: &mut Context<Self>) {
        self.sound = 2;
        self.volume = 0.8;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn guided_fixture(&mut self, cx: &mut Context<Self>) {
        self.practice_fixture(false, cx);
        self.exercise = Exercise::Interval;
        self.high = 59.;
        self.direction = 0;
        self.intervals = [true, false, false, false, false, false, false];
    }
    pub fn new(_: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab",NextSelectorFocus,Some("SingZTrainingSetup")),
            KeyBinding::new("shift-tab",PreviousSelectorFocus,Some("SingZTrainingSetup")),
            KeyBinding::new("tab",NextSelectorFocus,Some("SingZTrainingSelector")),
            KeyBinding::new("shift-tab",PreviousSelectorFocus,Some("SingZTrainingSelector")),
        ]);
        Self {
            run: None,
            recording: RecordingView::default(),
            audio_available: false,
            testing: false,
            audio_error: None,
            route: Route::Home,
            exercise: Exercise::Note,
            tonic: 0,
            minor: false,
            task: 0,
            direction: 2,
            low: 48.,
            high: 72.,
            volume: 0.65,
            tolerance: 1,
            length: 20,
            sound: 0,
            intervals: [true; 7],
            degrees: [true; 7],
            focus: 0,
            level: None,
            path_open: false,
            scroll: ScrollHandle::new(),
            summary_scroll: ScrollHandle::new(),
            open: None,
            keyboard_scope:cx.focus_handle(),keyboard_focus:Default::default(),keyboard_order:Default::default(),keyboard_bounds:Default::default(),selector_options:Default::default(),menu_index:None,menu_scroll:ScrollHandle::new(),typeahead:String::new(),typeahead_at:None,keyboard_focus_pending:false,
            review: false,
            history: Default::default(),
            notation: "note-names".into(),
            guided_scale: true,
            program_started: None,
            song: None,
            preparation: None,
            mixed_kinds: None,
            preparation_notice: None,
            #[cfg(feature = "ui-tests")]
            bounds: Default::default(),
        }
    }
    pub fn on_open(&mut self, cx: &mut Context<Self>) {
        self.keyboard_focus_pending=true;
        self.open = None;
        cx.notify();
    }
    pub fn config(&self, seed: String) -> crate::training_domain::Config {
        use crate::training_domain::{Config, DirectionChoice, Kind, Task};
        Config {
            tonic: self.tonic as u8,
            minor: self.minor,
            low: self.low as u8,
            high: self.high as u8,
            kind: match self.exercise {
                Exercise::Note => Kind::Note,
                Exercise::Degree => Kind::Degree,
                Exercise::Interval => Kind::Interval,
                Exercise::Chord => Kind::Chord,
                Exercise::Arpeggio => Kind::Arpeggio,
                Exercise::Scale => Kind::Scale,
                Exercise::Mixed => Kind::Mixed,
            },
            task: match self.task {
                0 => Task::Imitate,
                1 => Task::Find,
                _ => Task::Identify,
            },
            length: self.length
                * if self.exercise == Exercise::Interval && self.task == 0 {
                    3
                } else {
                    1
                },
            seed,
            direction: match self.direction {
                0 => DirectionChoice::Ascending,
                1 => DirectionChoice::Descending,
                _ => DirectionChoice::Both,
            },
            intervals: self
                .intervals
                .iter()
                .enumerate()
                .filter_map(|(i, on)| on.then_some(i as u8 + 2))
                .collect(),
            interval_semitones: (self.exercise == Exercise::Interval && self.focus > 0)
                .then_some(self.focus as u8),
            chord_degrees: self
                .degrees
                .iter()
                .enumerate()
                .filter_map(|(i, on)| on.then_some(i as u8 + 1))
                .collect(),
            guided_scale: self.guided_scale,
            mixed_kinds: self
                .mixed_kinds
                .clone()
                .unwrap_or_else(|| Config::default().mixed_kinds),
            ..Default::default()
        }
    }
    pub fn profile(
        &self,
    ) -> (
        crate::training_progress::Preferences,
        crate::training_store::Controls,
    ) {
        let config = self.config(String::new());
        (
            crate::training_progress::Preferences {
                format_version: 2,
                tonic_pc: config.tonic,
                key_mode: if config.minor { "minor" } else { "major" }.into(),
                exercise: config.kind,
                length: self.length,
                range: crate::training_progress::Range {
                    low_midi: config.low,
                    high_midi: config.high,
                },
                notation: self.notation.clone(),
                task_mode: config.task,
                direction: config.direction,
                interval_sizes: config.intervals,
                chord_degrees: config.chord_degrees,
                scale_presentation: Some(
                    if self.guided_scale {
                        "guided"
                    } else {
                        "phrase"
                    }
                    .into(),
                ),
            },
            crate::training_store::Controls {
                format_version: 1,
                sound: self.sound,
                volume: self.volume,
                tolerance: self.tolerance,
                focus: self.focus,
                program: self.level.map(|level| crate::training_store::Program {
                    level,
                    started_at: self.program_started.unwrap_or(0),
                }),
            },
        )
    }
    pub fn restore_profile(
        &mut self,
        p: &crate::training_progress::Preferences,
        controls: &crate::training_store::Controls,
        cx: &mut Context<Self>,
    ) {
        use crate::training_domain::{DirectionChoice, Kind, Task};
        self.tonic = p.tonic_pc as usize;
        self.minor = p.key_mode == "minor";
        self.exercise = match p.exercise {
            Kind::Note => Exercise::Note,
            Kind::Degree => Exercise::Degree,
            Kind::Interval => Exercise::Interval,
            Kind::Chord => Exercise::Chord,
            Kind::Arpeggio => Exercise::Arpeggio,
            Kind::Scale => Exercise::Scale,
            Kind::Mixed => Exercise::Mixed,
        };
        self.task = match p.task_mode {
            Task::Imitate => 0,
            Task::Find => 1,
            Task::Identify => 2,
        };
        self.direction = match p.direction {
            DirectionChoice::Ascending => 0,
            DirectionChoice::Descending => 1,
            DirectionChoice::Both => 2,
        };
        self.low = p.range.low_midi as f32;
        self.high = p.range.high_midi as f32;
        self.length = p.length;
        for (i, value) in self.intervals.iter_mut().enumerate() {
            *value = p.interval_sizes.contains(&(i as u8 + 2));
        }
        for (i, value) in self.degrees.iter_mut().enumerate() {
            *value = p.chord_degrees.contains(&(i as u8 + 1));
        }
        self.notation = p.notation.clone();
        self.guided_scale = p.scale_presentation.as_deref() != Some("phrase");
        self.sound = controls.sound;
        self.volume = controls.volume;
        self.tolerance = controls.tolerance;
        self.focus = controls.focus;
        self.level = controls.program.as_ref().map(|p| p.level);
        self.program_started = controls.program.as_ref().map(|p| p.started_at);
        cx.notify();
    }
    pub fn set_history(
        &mut self,
        snapshot: std::sync::Arc<crate::training_store::Snapshot>,
        cx: &mut Context<Self>,
    ) {
        self.history = snapshot;
        cx.notify();
    }
    fn history_banner(&self, cx: &mut Context<Self>) -> Option<Div> {
        self.history.error().map(|error| {
            training_banner()
                .mb(px(18.))
                .flex()
                .items_center()
                .gap(px(12.))
                .child(Self::text(error.to_string(), 14., DIM).flex_1())
                .child(
                    self.probe(
                        "training-save-retry",
                        training_primary("training-save-retry", t("training.route.retry"))
                            .when(true,|d|self.setup_control("training-save-retry",d,true,cx)),
                    ),
                )
        })
    }
    pub fn set_song(
        &mut self,
        song: Option<crate::training_preparation::Song>,
        cx: &mut Context<Self>,
    ) {
        if self.song != song {
            if self
                .preparation
                .as_ref()
                .is_some_and(|p| song.as_ref().is_none_or(|s| p.source != s.source))
            {
                self.preparation = None;
                self.preparation_notice = None;
                self.mixed_kinds = None;
                self.run = None;
                self.route = Route::Home;
            }
            self.song = song;
            cx.notify();
        }
    }
    pub fn clear_song(&mut self, cx: &mut Context<Self>) {
        self.song = None;
        self.preparation = None;
        self.preparation_notice = None;
        self.mixed_kinds = None;
        self.end_run(cx);
    }
    pub fn preparation_matches(&self, source: Option<u64>) -> bool {
        self.preparation
            .as_ref()
            .is_some_and(|p| Some(p.source) == source)
    }
    fn prepare_song(
        &mut self,
        choice: crate::training_preparation::Choice,
        cx: &mut Context<Self>,
    ) {
        let Some(song) = self.song.clone() else {
            return;
        };
        let key = song.key.unwrap_or(crate::training_preparation::Key {
            tonic: self.tonic as u8,
            minor: self.minor,
        });
        let recipe = crate::training_preparation::recipe(&self.config(String::new()), key, choice);
        let mut preferences = self.profile().0;
        preferences.tonic_pc = recipe.tonic;
        preferences.key_mode = if recipe.minor { "minor" } else { "major" }.into();
        preferences.exercise = recipe.kind;
        preferences.length = recipe.length;
        preferences.interval_sizes = recipe.intervals;
        let controls = self.profile().1;
        self.restore_profile(&preferences, &controls, cx);
        self.mixed_kinds = Some(recipe.mixed_kinds);
        self.preparation = Some(crate::training_preparation::Context {
            source: song.source,
            name: song.name,
            choice,
        });
        self.preparation_notice = song
            .key
            .is_none()
            .then(|| "training.session.error.confirmKeyThenReview".into());
        self.navigate(Route::Setup, cx);
    }
    pub fn practice_settings(&self) -> (usize, f32, f64) {
        (self.sound, self.volume, [5., 10., 15., 20.][self.tolerance])
    }
    pub fn set_run(&mut self, view: Option<crate::training_run::Snapshot>, cx: &mut Context<Self>) {
        if self.run != view {
            if self.run.as_ref().map(|run|run.phase) != view.as_ref().map(|run|run.phase) {
                if let Some(run)=view.as_ref().filter(|run|run.phase==crate::training_run::Phase::Summary){
                    crate::a11y::announce_training_result(run.correct+run.close,run.attempts);
                }
                self.summary_scroll.set_offset(point(px(0.),px(0.)));
            }
            self.run = view;
            cx.notify();
        }
    }
    pub fn set_recording(&mut self, view: RecordingView, cx: &mut Context<Self>) {
        if self.recording != view {
            self.recording = view;
            cx.notify();
        }
    }
    pub fn recording_state(&self) -> &RecordingView {
        &self.recording
    }
    fn recording_visible(&self) -> bool {
        self.run.as_ref().is_some_and(|run| {
            run.prompt.task != crate::training_domain::Task::Identify
                && run.phase != crate::training_run::Phase::Summary
        })
    }
    fn recording_enabled(&self) -> bool {
        use crate::training_run::Phase;
        !self.recording.busy
            && (self.recording.recording
                || (self.recording.can_record
                    && self.run.as_ref().is_some_and(|run| {
                        matches!(run.phase, Phase::Cue | Phase::Respond | Phase::Feedback)
                    })))
    }
    fn recording_action(&self, save: bool, cx: &mut Context<Self>) {
        if !self.recording_visible() {
            return;
        }
        if save {
            if self.recording.has_take {
                cx.emit(TrainingEvent::SaveRecording);
            }
        } else if self.recording_enabled() {
            cx.emit(if self.recording.recording {
                TrainingEvent::FinishRecording
            } else {
                TrainingEvent::RecordSample
            });
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn recording_ui_state(&self, w: &Window) -> serde_json::Value {
        serde_json::json!({"view":self.recording,"visible":self.recording_visible(),
            "recordEnabled":self.recording_visible()&&self.recording_enabled(),
            "saveVisible":self.recording_visible()&&self.recording.has_take,
            "focusedControl":self.focused_control(w).filter(|id|id.starts_with("training-recording-"))})
    }
    pub fn end_run(&mut self, cx: &mut Context<Self>) {
        self.run = None;
        self.route = Route::Home;
        self.open = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn set_audio_available(&mut self, available: bool, cx: &mut Context<Self>) {
        let available = available && !self.review;
        if self.audio_available != available {
            self.audio_available = available;
            cx.notify();
        }
    }
    pub fn test_state(&mut self, testing: bool, error: Option<String>, cx: &mut Context<Self>) {
        if self.testing != testing || self.audio_error != error {
            self.testing = testing;
            self.audio_error = error;
            cx.notify();
        }
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.open.take().is_some();
        if open {
            cx.notify();
        }
        open
    }
    fn navigate(&mut self, route: Route, cx: &mut Context<Self>) {
        cx.emit(TrainingEvent::Stop);
        self.route = route;
        self.keyboard_focus_pending=true;
        self.open = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn review(&mut self, route: Route, cx: &mut Context<Self>) {
        self.review = true;
        self.level = None;
        self.exercise = Exercise::Note;
        self.navigate(route, cx);
    }
    #[cfg(feature = "ui-tests")]
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied().or_else(||self.keyboard_bounds.borrow().get(id).copied())
    }
    #[cfg(feature = "ui-tests")]
    pub fn snapshot(&self) -> (Route, Exercise, usize, bool, f32, f32, usize, usize) {
        (
            self.route,
            self.exercise,
            self.tonic,
            self.minor,
            self.low,
            self.high,
            self.task,
            self.length,
        )
    }
    fn probe(&self, id: impl Into<String>, element: Stateful<Div>) -> Stateful<Div> {
        #[cfg(feature = "ui-tests")]
        let element = {
            let id = id.into();
            let probe = self.bounds.clone();
            element.relative().child(
                canvas(
                    move |bounds, _, _| {
                        probe.borrow_mut().insert(id.clone(), bounds);
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
        };
        #[cfg(not(feature = "ui-tests"))]
        let _ = id;
        element
    }
    fn text(text: impl Into<SharedString>, size: f32, color: u32) -> Div {
        div()
            .text_size(px(size))
            .line_height(px(size * 1.5))
            .text_color(rgb(color))
            .child(text.into())
    }
    fn heading(text: impl Into<SharedString>, size: f32) -> Div {
        div()
            .font_family(DISPLAY_800)
            .text_size(px(size))
            .line_height(px(size * 1.2))
            .child(text.into())
    }
    fn hint(text: impl Into<SharedString>) -> Div {
        Self::text(text, 12., DIM).mt(px(8.))
    }
    fn label(text: impl Into<SharedString>) -> Div {
        div()
            .text_size(px(12.))
            .line_height(px(14.5))
            .text_color(rgb(DIM))
            .font_family(DISPLAY_650)
            .mb(px(8.))
            .child(tracked_label(text, 0.04))
    }
    fn register_keyboard(&self,id:&str,enabled:bool,cx:&mut Context<Self>)->FocusHandle{
        let focus=self.keyboard_focus.borrow_mut().entry(id.to_owned()).or_insert_with(||cx.focus_handle().tab_stop(true)).clone();
        if enabled{self.keyboard_order.borrow_mut().push(id.to_owned());}focus
    }
    fn keyboard_probe(&self,id:&str,element:Stateful<Div>)->Stateful<Div>{
        let id=id.to_owned();let bounds=self.keyboard_bounds.clone();
        element.relative().child(canvas(move|b,_,_|{bounds.borrow_mut().insert(id.clone(),b);b},|_,_,_,_|{}).absolute().inset_0())
    }
    /// Accessible name of a setup control that is not named at its call site (D-06 rule 1).
    fn control_name(&self,id:&str)->Option<String>{
        let index=|prefix:&str|id.strip_prefix(prefix).and_then(|v|v.parse::<usize>().ok());
        Some(match id {
            "training-save-retry"=>t("training.route.retry"),
            "training-back"=>t("training.nav.backToTraining"),
            "training-program-start"=>t("training.program.start"),
            "training-program-path"=>t("training.program.path"),
            "training-progress"=>t("training.progress.heading"),
            "training-start"=>t("training.setup.startPractice"),
            "training-test"=>t(if self.testing {"training.setup.testNote.playing"} else {"training.setup.testNote.idle"}),
            "training-progress-start"=>t("training.progress.empty.cta"),
            "training-key"=>t("training.setup.label.key"),
            "training-interval-focus"=>t("training.program.intervalFocus"),
            "training-length"=>t("training.setup.label.exercises"),
            "training-sound"=>t("training.setup.soundType"),
            _ if index("training-path-").is_some()=>self.lessons().get(index("training-path-")?).map(|l|Self::lesson_label(*l))?,
            _ if index("training-exercise-").is_some()=>{let e=EXERCISES.get(index("training-exercise-")?)?;format!("{} — {}",e.title(),e.description())},
            _ if index("training-interval-").is_some()&&id!="training-interval-focus"=>capitalize(t(["training.word.second","training.word.third","training.word.fourth","training.word.fifth","training.word.sixth","training.word.seventh","training.word.octave"].get(index("training-interval-")?)?)),
            _ if index("training-degree-").is_some()=>tv("training.setup.chordDegreeLabel",&[("n",(index("training-degree-")?+1).to_string())]),
            _=>return None,
        })
    }
    fn setup_control(&self,id:impl Into<String>,element:Stateful<Div>,enabled:bool,cx:&mut Context<Self>)->Stateful<Div>{
        let id=id.into();let focus=self.register_keyboard(&id,enabled,cx);let weak=cx.entity().downgrade();let action=id.clone();
        // Roles first, so a call site's own role (radio, combo box, toggle) still wins below.
        let element=match self.control_name(&id){Some(name)=>element.a11y_button(name),None=>element};
        self.keyboard_probe(&id,settings_control_with_focus(element,focus,enabled,move|w,cx|{let _=weak.update(cx,|s,cx|s.activate_setup(&action,w,cx));}))
    }
    fn activate_setup(&mut self,id:&str,w:&mut Window,cx:&mut Context<Self>){
        if !self.keyboard_order.borrow().iter().any(|item|item==id){return;}
        if let Some(choice) = match id {
            "training-prepare-notes" => Some(crate::training_preparation::Choice::Notes),
            "training-prepare-intervals" => Some(crate::training_preparation::Choice::Intervals),
            "training-prepare-chords" => Some(crate::training_preparation::Choice::Chords),
            "training-prepare-mixed" => Some(crate::training_preparation::Choice::Mixed),
            _ => None,
        } {
            // A queued pointer/key event must still belong to the mounted Home
            // card and satisfy the current song/audio eligibility. Choosing a
            // recipe opens setup only; capture/cues require explicit Start.
            if self.run.is_none() && self.route == Route::Home
                && self.song.as_ref().is_some_and(|song|self.audio_available || song.key.is_none()) {
                self.prepare_song(choice,cx);
            }
            return;
        }
        if let Some(index)=id.strip_prefix("training-exercise-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<EXERCISES.len()){
            self.preparation=None;self.preparation_notice=None;self.mixed_kinds=None;self.exercise=EXERCISES[index];if matches!(self.exercise,Exercise::Note|Exercise::Scale){self.task=0;}self.navigate(Route::Setup,cx);return;
        }
        if let Some(index)=id.strip_prefix("training-level-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<3){self.level=Some(index);self.program_started.get_or_insert_with(crate::training_store::now);}
        else if let Some(index)=id.strip_prefix("training-path-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<self.lessons().len()){self.open_lesson(self.lessons()[index],cx);return;}
        else if let Some(index)=id.strip_prefix("training-task-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<3){if self.exercise!=Exercise::Scale{self.task=index;}}
        else if let Some(index)=id.strip_prefix("training-direction-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<3){self.direction=index;}
        else if let Some(index)=id.strip_prefix("training-interval-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<7){self.intervals[index]=!self.intervals[index];}
        else if let Some(index)=id.strip_prefix("training-degree-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<7){self.degrees[index]=!self.degrees[index];}
        else if let Some(index)=id.strip_prefix("training-tolerance-").and_then(|v|v.parse::<usize>().ok()).filter(|i|*i<4){self.tolerance=index;}
        else{match id{
            "training-back"|"training-progress-start"=>{self.navigate(Route::Home,cx);return;},
            "training-progress"=>{self.navigate(Route::Progress,cx);return;},
            "training-program-path"=>self.path_open=!self.path_open,
            "training-program-start"=>{if let Some(index)=self.program_stages().iter().position(|s|!s.done){self.open_lesson(self.lessons()[index],cx);}return;},
            "training-save-retry"=>{if self.history.error().is_some(){cx.emit(TrainingEvent::RetrySave);}},
            "training-start"=>{if self.audio_available{cx.emit(TrainingEvent::Start);}},
            "training-test"=>{if self.audio_available{cx.emit(TrainingEvent::Test{sound:self.sound,volume:self.volume});}},
            "training-volume-minus"|"training-volume-plus"=>{self.volume=(self.volume+if id=="training-volume-minus"{-0.1}else{0.1}).clamp(0.2,2.);cx.emit(TrainingEvent::Volume(self.volume));},
            _=>{let selector=self.selector_options.borrow().keys().copied().find(|key|*key==id);if let Some(selector)=selector{self.activate_selector(selector,w.last_input_was_keyboard(),cx);}},
        }}cx.notify();
    }
    fn selector_selected(&self,id:&str)->usize{match id{"training-key"=>self.tonic,"training-mode"=>usize::from(self.minor),"training-sound"=>self.sound,"training-length"=>self.length_options().iter().position(|n|*n==self.length).unwrap_or(0),"training-interval-focus"=>self.focus,_=>0}}
    fn activate_selector(&mut self,id:&'static str,keyboard:bool,cx:&mut Context<Self>){
        if self.open==Some(id){if keyboard{if let Some(index)=self.menu_index{self.choose_selector(id,index,cx);}}else{self.open=None;self.menu_index=None;self.typeahead.clear();}}
        else{self.open=Some(id);self.menu_index=Some(self.selector_selected(id));self.menu_scroll.set_offset(point(px(0.),px(0.)));self.menu_scroll.scroll_to_item(self.menu_index.unwrap_or(0));self.typeahead.clear();}cx.notify();
    }
    fn choose_selector(&mut self,id:&'static str,index:usize,cx:&mut Context<Self>){
        if !self.selector_options.borrow().get(id).is_some_and(|o|index<o.len()){return;}
        match id{"training-key"=>self.tonic=index,"training-mode"=>self.minor=index==1,"training-sound"=>{self.sound=index;cx.emit(TrainingEvent::Stop);},"training-length"=>self.length=self.length_options()[index],"training-interval-focus"=>{self.focus=index;if index>0{self.intervals=[true;7];}},_=>{}}
        self.open=None;self.menu_index=None;self.typeahead.clear();cx.notify();
    }
    fn selector_next(&mut self,backwards:bool,w:&mut Window,cx:&mut Context<Self>){self.open=None;self.menu_index=None;self.typeahead.clear();self.move_setup_focus(backwards,w,cx);}
    fn move_setup_focus(&mut self,backwards:bool,w:&mut Window,cx:&mut Context<Self>){
        let order=self.keyboard_order.borrow().clone();let focused=self.focused_control(w);let current=focused.as_ref().and_then(|id|order.iter().position(|item|item==id));
        let next=match current{Some(i)if backwards=>i.checked_sub(1),Some(i)=>(i+1<order.len()).then_some(i+1),None if self.keyboard_scope.is_focused(w)=>if backwards{order.len().checked_sub(1)}else{(!order.is_empty()).then_some(0)},None=>None};
        if let Some(index)=next{if let Some(focus)=self.keyboard_focus.borrow().get(&order[index]){focus.focus(w,cx);}}
        else if backwards{w.focus_prev(cx);}else{w.focus_next(cx);}
        cx.notify();
    }
    fn selector_key(&mut self,id:&'static str,e:&KeyDownEvent,w:&mut Window,cx:&mut Context<Self>){
        let key=e.keystroke.key.as_str();let options=self.selector_options.borrow().get(id).cloned().unwrap_or_default();
        if key=="tab"{self.selector_next(e.keystroke.modifiers.shift,w,cx);}
        else if key=="escape"{if self.open!=Some(id){return;}self.open=None;self.menu_index=None;self.typeahead.clear();}
        else if matches!(key,"enter"|"space"){return;}
        else if matches!(key,"up"|"down"|"left"|"right"|"home"|"end"){
            if self.open!=Some(id){self.open=Some(id);self.menu_index=Some(self.selector_selected(id));}
            if !options.is_empty(){let current=self.menu_index.unwrap_or(0).min(options.len()-1);self.menu_index=Some(match key{"home"=>0,"end"=>options.len()-1,"up"|"left"=>current.saturating_sub(1),_=>(current+1).min(options.len()-1)});}
        }else if key.chars().count()==1&&!e.keystroke.modifiers.control&&!e.keystroke.modifiers.platform&&!e.keystroke.modifiers.alt{
            let now=std::time::Instant::now();if self.typeahead_at.is_none_or(|at|now.duration_since(at)>std::time::Duration::from_millis(700)){self.typeahead.clear();}self.typeahead_at=Some(now);self.typeahead.push_str(&key.to_lowercase());self.open=Some(id);if let Some(index)=options.iter().position(|label|label.to_lowercase().starts_with(&self.typeahead)){self.menu_index=Some(index);}
        }else{return;}
        if let Some(index)=self.menu_index{self.menu_scroll.scroll_to_item(index);}w.prevent_default();cx.stop_propagation();cx.notify();
    }
    pub fn focused_control(&self,w:&Window)->Option<String>{self.keyboard_focus.borrow().iter().find(|(_,focus)|focus.is_focused(w)).map(|(id,_)|id.clone())}
    pub fn keyboard_state(&self,w:&Window,cx:&App)->serde_json::Value{
        let focused=self.focused_control(w);let bounds=focused.as_ref().and_then(|id|self.keyboard_bounds.borrow().get(id).copied());let viewport=self.keyboard_viewport();let sticky=self.keyboard_bounds.borrow().get("training-footer").copied().filter(|_|self.run.is_none()&&self.route==Route::Setup);let body_bottom=sticky.map_or(viewport.bottom(),|footer|footer.top()-px(8.));let popup_bounds=self.open.and_then(|id|self.keyboard_bounds.borrow().get(&format!("training-popup-{id}")).copied());
        serde_json::json!({"route":format!("{:?}",self.route),"exercise":format!("{:?}",self.exercise),"focusOrder":self.keyboard_order.borrow().clone(),"focusedControl":focused,"focusInside":self.keyboard_scope.contains_focused(w,cx),"focusedBounds":bounds.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),"viewportBounds":[f32::from(viewport.left()),f32::from(viewport.top()),f32::from(viewport.size.width),f32::from((body_bottom-viewport.top()).max(px(0.)))],"scrollViewportBounds":[f32::from(viewport.left()),f32::from(viewport.top()),f32::from(viewport.size.width),f32::from(viewport.size.height)],"stickyFooterBounds":sticky.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),"popupBounds":popup_bounds.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),"scrollOffset":[f32::from(self.keyboard_scroll().offset().x),f32::from(self.keyboard_scroll().offset().y)],"scrollMaxOffset":[f32::from(self.keyboard_scroll().max_offset().x),f32::from(self.keyboard_scroll().max_offset().y)],"runPhase":self.run.as_ref().map(|run|format!("{:?}",run.phase)),"popup":self.open,"menuIndex":self.menu_index,"selectorOptions":self.selector_options.borrow().clone(),"menuScrollOffset":[f32::from(self.menu_scroll.offset().x),f32::from(self.menu_scroll.offset().y)],"config":{"tonic":self.tonic,"minor":self.minor,"task":self.task,"direction":self.direction,"low":self.low,"high":self.high,"length":self.length,"sound":self.sound,"volume":self.volume,"tolerance":self.tolerance,"intervals":self.intervals,"degrees":self.degrees,"intervalFocus":self.focus,"level":self.level,"pathOpen":self.path_open},"audioAvailable":self.audio_available,"testing":self.testing,"song":self.song.as_ref().map(|song|serde_json::json!({"source":song.source,"name":song.name,"effectiveKey":song.key.map(|key|serde_json::json!({"tonic":key.tonic,"minor":key.minor})),"transpose":song.transpose})),"preparation":self.preparation.as_ref().map(|preparation|serde_json::json!({"source":preparation.source,"name":preparation.name,"choice":format!("{:?}",preparation.choice)})),"preparationNotice":self.preparation_notice,"mixedKinds":self.mixed_kinds})
    }
    fn back(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        self.probe(
            "training-back",
            training_back_label("training-back", t("training.nav.backToTraining"))
                .mb(px(18.))
                .when(true,|d|self.setup_control("training-back",d,true,cx)),
        )
    }
    fn lessons(&self) -> Vec<(Exercise, usize, usize)> {
        crate::training_program::lessons(self.level.unwrap_or(0))
            .into_iter()
            .map(|l| {
                (
                    match l.kind {
                        crate::training_domain::Kind::Note => Exercise::Note,
                        crate::training_domain::Kind::Degree => Exercise::Degree,
                        crate::training_domain::Kind::Interval => Exercise::Interval,
                        crate::training_domain::Kind::Chord => Exercise::Chord,
                        crate::training_domain::Kind::Arpeggio => Exercise::Arpeggio,
                        crate::training_domain::Kind::Scale => Exercise::Scale,
                        crate::training_domain::Kind::Mixed => Exercise::Mixed,
                    },
                    if l.task == crate::training_domain::Task::Imitate {
                        0
                    } else {
                        1
                    },
                    l.semitones.unwrap_or(0) as usize,
                )
            })
            .collect()
    }
    fn lesson_label(lesson: (Exercise, usize, usize)) -> String {
        if lesson.0 == Exercise::Interval {
            [
                capitalize(t("training.word.unison")),
                capitalize(t("interval.minor.second")),
                capitalize(t("interval.major.second")),
                capitalize(t("interval.minor.third")),
                capitalize(t("interval.major.third")),
                capitalize(t("interval.perfect.fourth")),
                capitalize(t("interval.diminished.fifth")),
                capitalize(t("interval.perfect.fifth")),
                capitalize(t("interval.minor.sixth")),
                capitalize(t("interval.major.sixth")),
                capitalize(t("interval.minor.seventh")),
                capitalize(t("interval.major.seventh")),
                capitalize(t("interval.perfect.octave")),
            ][lesson.2]
                .clone()
        } else {
            lesson.0.title()
        }
    }
    fn open_lesson(&mut self, lesson: (Exercise, usize, usize), cx: &mut Context<Self>) {
        self.preparation = None;
        self.preparation_notice = None;
        self.mixed_kinds = None;
        let current = self.config("program-setup".into());
        let lesson = crate::training_program::Lesson {
            kind: match lesson.0 {
                Exercise::Note => crate::training_domain::Kind::Note,
                Exercise::Degree => crate::training_domain::Kind::Degree,
                Exercise::Interval => crate::training_domain::Kind::Interval,
                Exercise::Chord => crate::training_domain::Kind::Chord,
                Exercise::Arpeggio => crate::training_domain::Kind::Arpeggio,
                Exercise::Scale => crate::training_domain::Kind::Scale,
                Exercise::Mixed => crate::training_domain::Kind::Mixed,
            },
            task: if lesson.1 == 0 {
                crate::training_domain::Task::Imitate
            } else {
                crate::training_domain::Task::Find
            },
            semitones: (lesson.2 > 0).then_some(lesson.2 as u8),
        };
        let day = self
            .program_stages()
            .iter()
            .find(|s| s.lesson == lesson)
            .map_or(0, |s| s.day_index);
        let next = crate::training_program::setup(
            lesson,
            day,
            &current,
            &self.history.receipts,
            crate::training_store::now(),
        );
        let mut preferences = self.profile().0;
        preferences.exercise = next.kind;
        preferences.task_mode = next.task;
        preferences.length = next.length;
        preferences.direction = next.direction;
        preferences.tonic_pc = next.tonic;
        preferences.interval_sizes = next.intervals;
        preferences.chord_degrees = next.chord_degrees;
        preferences.scale_presentation = Some("guided".into());
        let mut controls = self.profile().1;
        controls.focus = next.interval_semitones.unwrap_or(0) as usize;
        self.restore_profile(&preferences, &controls, cx);
        self.navigate(Route::Setup, cx);
    }
    #[cfg(feature = "ui-tests")]
    pub fn popup_open(&self) -> bool {
        self.open.is_some()
    }
    #[cfg(feature = "ui-tests")]
    pub fn program_snapshot(&self) -> (Option<usize>, usize) {
        (self.level, self.lessons().len())
    }
    fn program_stages(&self) -> Vec<crate::training_program::Stage> {
        self.level
            .map(|level| {
                crate::training_program::stages(
                    &crate::training_store::Program {
                        level,
                        started_at: self.program_started.unwrap_or(0),
                    },
                    &self.history.receipts,
                    crate::training_store::now(),
                )
            })
            .unwrap_or_default()
    }
    fn program(&self, cx: &mut Context<Self>) -> Div {
        let stages = self.program_stages();
        let next = stages.iter().position(|s| !s.done);
        let index = next.unwrap_or(0);
        let days = stages.get(index).map_or(0, |s| s.days);
        let today = stages.get(index).is_some_and(|s| s.practiced_today);
        let day = stages.get(index).map_or(1, |s| s.day_index + 1);
        let streak = crate::training_program::streak(
            self.profile().1.program.as_ref(),
            &self.history.receipts,
            crate::training_store::now(),
        );
        training_program_card()
            .child(
                Self::heading(t("training.program.heading"), 24.)
                    .font_family(DISPLAY_700)
                    .mb(px(16.)),
            )
            .child(
                div().flex().flex_wrap().gap(px(8.)).mb(px(20.)).children(
                    [
                        t("training.program.foundation"),
                        t("training.program.developing"),
                        t("training.program.advanced"),
                    ]
                    .into_iter()
                    .enumerate()
                    .map(|(i, label)| {
                        self.probe(
                            format!("training-level-{i}"),
                            training_program_choice(("training-level", i), label)
                                .when(self.level == Some(i), |s| {
                                    s.text_color(rgb(ACCENT))
                                        .border_color(rgb(ACCENT))
                                        .bg(rgba(ACCENT_SOFT))
                                })
                                .when(true,|d|self.setup_control(format!("training-level-{i}"),d,true,cx)),
                        )
                    }),
                ),
            )
            .when(self.level.is_none(), |card| {
                card.child(
                    Self::text(t("training.program.choose"), 14., DIM)
                        .line_height(px(17.))
                        .my(px(12.)),
                )
            })
            .when(self.level.is_some() && next.is_none(), |card| {
                card.child(Self::text(t("training.program.finished"), 14., DIM))
            })
            .when(self.level.is_some() && next.is_some(), |card| {
                card.child(
                    training_eyebrow(if today {
                        t("training.program.complete").to_uppercase()
                    } else {
                        tv("training.program.day", &[("day", day.to_string())]).to_uppercase()
                    })
                    .mt(px(12.)),
                )
                .child(
                    Self::heading(Self::lesson_label(self.lessons()[index]), 30.)
                        .mt(px(8.))
                        .mb(px(16.)),
                )
                .child(div().flex().gap(px(6.)).children((1..=7).map(|day| {
                    div()
                        .size(px(40.))
                        .rounded(px(12.))
                        .bg(rgb(BG))
                        .flex()
                        .items_center()
                        .justify_center()
                        .font_family(DISPLAY_700)
                        .text_color(rgb(if day <= days { ACCENT } else { DIM }))
                        .child(if day <= days {
                            "✓".into()
                        } else {
                            day.to_string()
                        })
                })))
                .child(
                    Self::text(
                        format!(
                            "{}{}",
                            tv("training.program.days", &[("days", days.to_string())]),
                            if streak > 0 {
                                format!(
                                    " · {}",
                                    tv("training.program.streak", &[("days", streak.to_string())])
                                )
                            } else {
                                String::new()
                            }
                        ),
                        14.,
                        DIM,
                    )
                    .my(px(12.)),
                )
                .child(
                    training_primary(
                        "training-program-start",
                        if today {
                            t("training.program.again")
                        } else {
                            t("training.program.start")
                        },
                    )
                    .when(true,|d|self.setup_control("training-program-start",d,true,cx)),
                )
            })
            .when(self.level.is_some(), |card| {
                card.child(
                    div()
                        .id("training-program-path")
                        .mt(px(20.))
                        .cursor_pointer()
                        .font_family(DISPLAY_700)
                        .child(t("training.program.path"))
                        .when(true,|d|self.setup_control("training-program-path",d,true,cx)),
                )
                .when(self.path_open, |c| {
                    c.children(
                        self.lessons()
                            .into_iter()
                            .enumerate()
                            .map(|(index, lesson)| {
                                div()
                                    .id(format!("training-path-{index}"))
                                    .px(px(12.))
                                    .py(px(12.))
                                    .border_b_1()
                                    .border_color(rgba(LINE))
                                    .cursor_pointer()
                                    .child(Self::lesson_label(lesson))
                                    .child(Self::text(
                                        tv(
                                            "training.program.days",
                                            &[(
                                                "days",
                                                stages.get(index).map_or(0, |s| s.days).to_string(),
                                            )],
                                        ),
                                        12.,
                                        DIM,
                                    ))
                                    .when(true,|d|self.setup_control(format!("training-path-{index}"),d,true,cx))
                            }),
                    )
                })
            })
    }
    fn home(&self, width: f32, cx: &mut Context<Self>) -> Div {
        let heading = (width * 0.03).clamp(30., 40.);
        let program = div()
            .flex()
            .flex_col()
            .min_w_0()
            .w(px((width.min(1240.) - 64. - 10. - 32.) * 0.425))
            .flex_shrink_0()
            .when(width <= 880., |column| column.w_full())
            .child(self.program(cx))
            .child(
                self.probe(
                    "training-progress",
                    training_card()
                        .id("training-progress")
                        .rounded(px(16.))
                        .mt(px(20.))
                        .px(px(18.))
                        .py(px(16.))
                        .flex()
                        .items_center()
                        .justify_between()
                        .cursor_pointer()
                        .child(
                            div()
                                .flex()
                                .flex_col()
                                .gap(px(3.))
                                .child(
                                    div()
                                        .flex()
                                        .items_center()
                                        .gap(px(5.))
                                        .font_family(DISPLAY_700)
                                        .text_size(px(13.))
                                        .child(
                                            colored_icon(TransportIcon::TrainingProgress, TEXT)
                                                .with_size(22),
                                        )
                                        .child(t("training.progress.heading")),
                                )
                                .child(Self::text(
                                    if self.history.aggregate.sessions == 0 {
                                        t("training.home.progressEntry.empty")
                                    } else {
                                        tn(
                                            "training.home.progressEntry.summary",
                                            self.history.aggregate.sessions as f64,
                                            &[(
                                                "percent",
                                                if self.history.aggregate.attempts == 0 {
                                                    "—".into()
                                                } else {
                                                    format!(
                                                        "{:.0}%",
                                                        (self.history.aggregate.on_target
                                                            + self.history.aggregate.close)
                                                            as f64
                                                            / self.history.aggregate.attempts
                                                                as f64
                                                            * 100.
                                                    )
                                                },
                                            )],
                                        )
                                    },
                                    12.,
                                    DIM,
                                )),
                        )
                        .child(Self::text("→", 16., ACCENT))
                        .when(true,|d|self.setup_control("training-progress",d,true,cx)),
                ),
            );
        let practice = div()
            .flex_1()
            .min_w_0()
            .child(training_eyebrow(t("training.home.eyebrow").to_uppercase()))
            .child(
                Self::heading(t("training.home.heading"), heading)
                    .line_height(px(heading * 1.1))
                    .mt(px(9.))
                    .mb(px(10.)),
            )
            .child(
                Self::text(t("training.home.subheading"), 15., DIM)
                    .line_height(px(23.25))
                    .mb(px(24.)),
            )
            .child(div().flex().flex_col().gap(px(10.)).children(
                EXERCISES.into_iter().enumerate().map(|(i, exercise)| {
                    self.probe(
                        format!("training-exercise-{i}"),
                        training_card()
                            .id(("training-exercise", i))
                            .w_full()
                            .min_h(px(78.))
                            .px(px(16.))
                            .py(px(12.))
                            .flex()
                            .items_center()
                            .gap(px(14.))
                            .cursor_pointer()
                            .hover(|s| s.border_color(rgba(ACCENT_LINE)))
                            .child(
                                div()
                                    .size(px(48.))
                                    .flex_none()
                                    .rounded_full()
                                    .border_1()
                                    .border_color(rgba(0xffa02862))
                                    .bg(rgba(0xffa02814))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(colored_icon(exercise.icon(), ACCENT).with_size(30)),
                            )
                            .child(
                                div()
                                    .flex_1()
                                    .min_w_0()
                                    .child(
                                        Self::text(exercise.title(), 16., TEXT)
                                            .font_family(DISPLAY_700),
                                    )
                                    .child(
                                        Self::text(exercise.description(), 13., DIM)
                                            .line_height(px(18.85)),
                                    ),
                            )
                            .child(Self::text("→", 20., FAINT).w(px(20.)))
                            .when(true,|d|self.setup_control(format!("training-exercise-{i}"),d,true,cx)),
                    )
                }),
            ))
            .child(Self::text(t("training.home.micNote"), 12., DIM).mt(px(18.)));
        div()
            .flex()
            .when(width <= 880., |v| v.flex_col())
            .gap(px(32.))
            .items_start()
            .child(program)
            .child(practice)
    }
    fn selector(&self,id:&'static str,options:Vec<String>,selected:usize,cx:&mut Context<Self>)->Div{
        self.selector_options.borrow_mut().insert(id,options.clone());let open=self.open==Some(id);
        let menu_height=px((options.len() as f32*27.5+10.).min(280.));
        let above=self.keyboard_bounds.borrow().get(id).is_some_and(|b|b.bottom()+menu_height>self.scroll.bounds().bottom()&&b.top()-self.scroll.bounds().top()>self.scroll.bounds().bottom()-b.bottom());
        div().relative().min_w_0().flex_1().child(self.probe(id,
            self.setup_control(id,training_select(id,options.get(selected).cloned().unwrap_or_default())
                .role(gpui_kit::accesskit::Role::ComboBox).aria_expanded(open)
                .aria_label(self.control_name(id).unwrap_or_else(||options.get(selected).cloned().unwrap_or_default()))
                .aria_value(options.get(selected).cloned().unwrap_or_default()),true,cx)
                .key_context("SingZTrainingSelector")
                .on_action(cx.listener(|s,_:&NextSelectorFocus,w,cx|{s.selector_next(false,w,cx);w.prevent_default();cx.stop_propagation();}))
                .on_action(cx.listener(|s,_:&PreviousSelectorFocus,w,cx|{s.selector_next(true,w,cx);w.prevent_default();cx.stop_propagation();}))
                .capture_key_down(cx.listener(move|s,e:&KeyDownEvent,w,cx|s.selector_key(id,e,w,cx)))
        )).when(open,|d|d.child(deferred(self.keyboard_probe(&format!("training-popup-{id}"),scrolling_select_popup(format!("{id}-options")).track_scroll(&self.menu_scroll)
            .when(above,|popup|popup.top(Length::Auto).bottom_full().mt(px(0.)).mb(px(2.)))
            .on_mouse_down_out(cx.listener(move|s,event:&MouseDownEvent,_,cx|{if !s.keyboard_bounds.borrow().get(id).is_some_and(|b|b.contains(&event.position)){s.open=None;s.menu_index=None;cx.notify();}}))
            .children(options.into_iter().enumerate().map(|(index,label)|select_option((id,index),label,index==self.menu_index.unwrap_or(selected)).flex_none()
                .on_click(cx.listener(move|s,_,w,cx|{s.choose_selector(id,index,cx);if let Some(focus)=s.keyboard_focus.borrow().get(id){focus.focus(w,cx);}}))
            ))).absolute()).with_priority(100)))
    }
    fn segment(
        &self,
        id: &'static str,
        labels: &[String],
        selected: usize,
        cx: &mut Context<Self>,
    ) -> Div {
        training_segment().children(labels.iter().enumerate().map(|(i, label)| {
            let disabled = id == "training-task" && self.exercise == Exercise::Scale && i > 0;
            self.probe(
                format!("{id}-{i}"),
                training_choice((id, i), label.clone(), i == selected)
                    .when(disabled, |choice| choice.opacity(0.35).cursor_default())
                    .when(i > 0, |d| d.border_l_1().border_color(rgba(LINE)))
                    .role(gpui_kit::accesskit::Role::RadioButton).aria_label(label.clone()).aria_selected(i == selected)
                    .when(true,|d|self.setup_control(format!("{id}-{i}"),d,!disabled,cx)),
            )
        }))
    }
    fn fieldset(title: impl Into<SharedString>) -> Div {
        let title: SharedString = title.into();
        training_card().relative().p(px(20.)).child(
            div()
                .absolute()
                .top(px(-9.))
                .left(px(20.))
                .px(px(7.))
                .bg(rgb(BG))
                .font_family("SingZ Display 720")
                .text_size(px(13.))
                .line_height(px(18.))
                .child(title),
        )
    }
    fn setup(&self, cx: &mut Context<Self>) -> Div {
        let (intervals_required, chords_required, direction) =
            crate::training_preparation::requirements(&self.config(String::new()));
        let musical = Self::fieldset(t("training.setup.legend.musicalContext"))
            .pt(px(27.))
            .flex_1()
            .min_w_0()
            .child(Self::label(t("training.setup.label.key").to_uppercase()))
            .child(
                div()
                    .flex()
                    .gap(px(8.))
                    .child(
                        self.selector(
                            "training-key",
                            [
                                "C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
                            ]
                            .map(str::to_owned)
                            .to_vec(),
                            self.tonic,
                            cx,
                        ),
                    )
                    .child(self.selector(
                        "training-mode",
                        vec![
                            t("training.setup.option.major"),
                            t("training.setup.option.minor"),
                        ],
                        usize::from(self.minor),
                        cx,
                    )),
            )
            .child(Self::label(t("training.setup.label.task").to_uppercase()).mt(px(18.)))
            .child(self.segment(
                "training-task",
                &[
                    t("training.setup.task.imitate"),
                    t("training.setup.task.find"),
                    t("training.setup.task.identify"),
                ],
                self.task,
                cx,
            ))
            .child(Self::hint(
                [
                    t("training.setup.taskHelp.imitate"),
                    t("training.setup.taskHelp.find"),
                    t("training.setup.taskHelp.identify"),
                ][self.task]
                    .clone(),
            ))
            .when(direction, |d| {
                d.child(Self::label(t("training.setup.label.direction").to_uppercase()).mt(px(18.)))
                    .child(self.segment(
                        "training-direction",
                        &[
                            capitalize(t("training.word.ascending")),
                            capitalize(t("training.word.descending")),
                            capitalize(t("training.word.both")),
                        ],
                        self.direction,
                        cx,
                    ))
            });
        let weak = cx.entity().downgrade();
        let low = training_range_with_focus(
            "training-low",
            self.low,
            36.,
            self.high - 1.,
            1.,self.register_keyboard("training-low",true,cx),true,
            move |v, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.low = v.round().clamp(36., s.high - 1.);
                    cx.notify();
                });
            },
        );
        let weak = cx.entity().downgrade();
        let high = training_range_with_focus(
            "training-high",
            self.high,
            self.low + 1.,
            84.,
            1.,self.register_keyboard("training-high",true,cx),true,
            move |v, _, cx| {
                let _ = weak.update(cx, |s, cx| {
                    s.high = v.round().clamp(s.low + 1., 84.);
                    cx.notify();
                });
            },
        );
        let low = self.probe("training-low", self.keyboard_probe("training-low",low.aria_label(t("training.setup.label.lowestNote"))));
        let high = self.probe("training-high", self.keyboard_probe("training-high",high.aria_label(t("training.setup.label.highestNote"))));
        let range = Self::fieldset(t("training.setup.legend.range"))
            .flex_basis(relative(0.425))
            .min_w(px(280.))
            .child(Self::hint(t("training.setup.rangeHelp")).mt(px(16.)))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .mt(px(18.))
                    .child(Self::text(t("training.setup.label.lowestNote"), 12., DIM))
                    .child(
                        Self::text(
                            crate::training_music::note_name(
                                self.low as i32,
                                self.tonic,
                                self.minor,
                            ),
                            12.,
                            ACCENT,
                        )
                        .font_family("SingZ Mono 600"),
                    ),
            )
            .child(low.mt(px(9.)))
            .child(
                div()
                    .flex()
                    .justify_between()
                    .mt(px(18.))
                    .child(Self::text(t("training.setup.label.highestNote"), 12., DIM))
                    .child(
                        Self::text(
                            crate::training_music::note_name(
                                self.high as i32,
                                self.tonic,
                                self.minor,
                            ),
                            12.,
                            ACCENT,
                        )
                        .font_family("SingZ Mono 600"),
                    ),
            )
            .child(high.mt(px(9.)));
        div()
            .child(self.back(cx))
            .children(self.preparation_notice.as_ref().map(|notice| {
                training_banner()
                    .mb(px(18.))
                    .child(Self::text(t(notice), 14., DIM))
            }))
            .child(training_eyebrow(t("training.setup.eyebrow").to_uppercase()))
            .child(
                Self::heading(self.exercise.title(), 34.)
                    .mt(px(5.))
                    .mb(px(34.)),
            )
            .child(
                div()
                    .flex()
                    .gap(px(14.))
                    .items_stretch()
                    .child(musical)
                    .child(range),
            )
            .when(intervals_required, |d| {
                d.child(
                    Self::fieldset(t("training.exercise.interval.label"))
                        .mt(px(22.))
                        .when(self.exercise == Exercise::Interval, |d| {
                            d.child(Self::label(
                                t("training.program.intervalFocus").to_uppercase(),
                            ))
                            .child(
                                self.selector(
                                    "training-interval-focus",
                                    [
                                        t("training.program.growing"),
                                        capitalize(t("interval.minor.second")),
                                        capitalize(t("interval.major.second")),
                                        capitalize(t("interval.minor.third")),
                                        capitalize(t("interval.major.third")),
                                        capitalize(t("interval.perfect.fourth")),
                                        capitalize(t("interval.diminished.fifth")),
                                        capitalize(t("interval.perfect.fifth")),
                                        capitalize(t("interval.minor.sixth")),
                                        capitalize(t("interval.major.sixth")),
                                        capitalize(t("interval.minor.seventh")),
                                        capitalize(t("interval.major.seventh")),
                                        capitalize(t("training.word.octave")),
                                    ]
                                    .to_vec(),
                                    self.focus,
                                    cx,
                                ),
                            )
                        })
                        .when(
                            self.exercise != Exercise::Interval || self.focus == 0,
                            |d| {
                                d.child(div().flex().gap(px(8.)).mt(px(12.)).children((0..7).map(
                                    |i| {
                                        training_toggle(
                                            ("training-interval", i),
                                            (i + 2).to_string(),
                                            [
                                                capitalize(t("training.word.second")),
                                                capitalize(t("training.word.third")),
                                                capitalize(t("training.word.fourth")),
                                                capitalize(t("training.word.fifth")),
                                                capitalize(t("training.word.sixth")),
                                                capitalize(t("training.word.seventh")),
                                                capitalize(t("training.word.octave")),
                                            ][i]
                                                .clone(),
                                            self.intervals[i],
                                        )
                                        .when(true,|d|self.setup_control(format!("training-interval-{i}"),d,true,cx))
                                        .aria_toggled(if self.intervals[i] { gpui_kit::accesskit::Toggled::True } else { gpui_kit::accesskit::Toggled::False })
                                    },
                                )))
                            },
                        ),
                )
            })
            .when(chords_required, |d| {
                d.child(
                    Self::fieldset(t("training.setup.legend.chordDegrees"))
                        .mt(px(22.))
                        .child(div().flex().gap(px(8.)).children((0..7).map(|i| {
                            training_toggle(
                                ("training-degree", i),
                                (i + 1).to_string(),
                                tv(
                                    "training.setup.chordDegreeLabel",
                                    &[("n", (i + 1).to_string())],
                                ),
                                self.degrees[i],
                            )
                            .when(true,|d|self.setup_control(format!("training-degree-{i}"),d,true,cx))
                            .aria_toggled(if self.degrees[i] { gpui_kit::accesskit::Toggled::True } else { gpui_kit::accesskit::Toggled::False })
                        }))),
                )
            })
            .child(self.practice(cx).mt(px(22.)))
            .when(
                (intervals_required
                    && (self.exercise != Exercise::Interval || self.focus == 0)
                    && !self.intervals.iter().any(|v| *v))
                    || (chords_required && !self.degrees.iter().any(|v| *v)),
                |d| {
                    d.child(training_banner().mt(px(16.)).child(Self::text(
                        t("training.setup.error.chooseOne"),
                        14.,
                        DANGER,
                    )))
                },
            )
    }
    fn length_options(&self) -> Vec<usize> {
        let mut options = vec![10, 20, 30, 50, self.length];
        options.sort_unstable();
        options.dedup();
        options
    }
    fn footer(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let footer = div()
            .px(px(16.))
            .py(px(14.))
            .border_1()
            .border_color(rgba(LINE_STRONG))
            .rounded(px(18.))
            .bg(rgb(PANEL_DEEP))
            .flex()
            .justify_end()
            .items_center()
            .gap(px(18.))
            .child(Self::text(
                if self.exercise == Exercise::Interval && self.task == 0 {
                    t("training.program.sets")
                } else {
                    t("training.setup.label.exercises")
                },
                12.,
                DIM,
            ))
            .child(
                self.selector(
                    "training-length",
                    self.length_options()
                        .iter()
                        .map(ToString::to_string)
                        .collect(),
                    self.length_options()
                        .iter()
                        .position(|n| *n == self.length)
                        .unwrap_or(1),
                    cx,
                )
                .max_w(px(78.)),
            )
            .child(
                self.probe(
                    "training-start",
                    training_primary("training-start", t("training.setup.startPractice"))
                        .opacity(if self.audio_available { 1. } else { 0.45 })
                        .when(true,|d|self.setup_control("training-start",d,self.audio_available,cx)),
                ),
            );
        self.probe("training-footer", self.keyboard_probe("training-footer",div().id("training-footer").child(footer)))
    }
    fn practice(&self, cx: &mut Context<Self>) -> Div {
        let weak = cx.entity().downgrade();
        let volume = training_range_with_focus("training-volume", self.volume, 0.2, 2.,0.05,self.register_keyboard("training-volume",true,cx),true, move |v, _, cx| {
            let _ = weak.update(cx, |s, cx| {
                s.volume = (v * 20.).round() / 20.;
                cx.emit(TrainingEvent::Volume(s.volume));
                cx.notify();
            });
        });
        let volume=self.probe("training-volume",self.keyboard_probe("training-volume",volume.aria_label(t("training.setup.ariaLabel.notePlaybackVolume"))));
        Self::fieldset(t("training.setup.legend.practiceSettings"))
            .child(
                div()
                    .flex()
                    .gap(px(20.))
                    .child(
                        div()
                            .flex_1()
                            .child(Self::label(t("training.setup.soundType").to_uppercase()))
                            .child(
                                self.selector(
                                    "training-sound",
                                    [
                                        t("training.sound.piano"),
                                        t("training.sound.electric"),
                                        t("training.sound.guitar"),
                                        t("training.sound.organ"),
                                    ]
                                    .to_vec(),
                                    self.sound,
                                    cx,
                                )
                                .max_w(px(142.)),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .child(
                                div()
                                    .flex()
                                    .justify_between()
                                    .items_center()
                                    .child(
                                        div()
                                            .child(
                                                training_eyebrow(
                                                    t("training.setup.label.notePlaybackVolume")
                                                        .to_uppercase(),
                                                )
                                                .text_color(rgb(DIM)),
                                            )
                                            .child(
                                                Self::text(
                                                    format!(
                                                        "{}%",
                                                        (self.volume * 100.).round() as u32
                                                    ),
                                                    25.,
                                                    TEXT,
                                                )
                                                .font_family("SingZ Mono 720"),
                                            ),
                                    )
                                    .child(
                                        self.probe(
                                            "training-test",
                                            training_primary(
                                                "training-test",
                                                if self.testing {
                                                    t("training.setup.testNote.playing")
                                                } else {
                                                    t("training.setup.testNote.idle")
                                                },
                                            )
                                            .min_w(px(116.))
                                            .opacity(if self.audio_available { 1. } else { 0.45 })
                                            .when(true,|d|self.setup_control("training-test",d,self.audio_available,cx)),
                                        ),
                                    ),
                            )
                            .child(
                                div()
                                    .flex()
                                    .items_center()
                                    .gap(px(10.))
                                    .mt(px(12.))
                                    .child(
                                        self.probe(
                                            "training-volume-minus",
                                            training_round_button("training-volume-minus", "−")
                                                .aria_label(t("training.setup.ariaLabel.lowerVolume"))
                                                .when(true,|d|self.setup_control("training-volume-minus",d,true,cx)),
                                        ),
                                    )
                                    .child(volume.flex_1())
                                    .child(
                                        self.probe(
                                            "training-volume-plus",
                                            training_round_button("training-volume-plus", "+")
                                                .aria_label(t("training.setup.ariaLabel.raiseVolume"))
                                                .when(true,|d|self.setup_control("training-volume-plus",d,true,cx)),
                                        ),
                                    ),
                            )
                            .child(Self::hint(t("training.setup.help.volumeRange"))),
                    ),
            )
            .child(
                div()
                    .w(relative(0.5))
                    .mt(px(24.))
                    .child(
                        training_eyebrow(t("training.setup.label.pitchTolerance").to_uppercase())
                            .text_color(rgb(DIM)),
                    )
                    .child(
                        Self::text(format!("±{}¢", [5, 10, 15, 20][self.tolerance]), 25., TEXT)
                            .font_family("SingZ Mono 720"),
                    )
                    .child(div().flex().gap(px(8.)).mt(px(12.)).children(
                        [5, 10, 15, 20].into_iter().enumerate().map(|(i, n)| {
                            training_choice(
                                ("training-tolerance", i),
                                format!("±{n}¢"),
                                self.tolerance == i,
                            )
                            .font_family("SingZ Mono 650")
                            .border_1()
                            .border_color(if self.tolerance == i {
                                rgb(ACCENT)
                            } else {
                                rgba(LINE_STRONG)
                            })
                            .rounded(px(10.))
                            .role(gpui_kit::accesskit::Role::RadioButton).aria_label(format!("±{n}¢")).aria_selected(self.tolerance == i)
                            .when(true,|d|self.setup_control(format!("training-tolerance-{i}"),d,true,cx))
                        }),
                    ))
                    .child(Self::hint(tv(
                        "training.setup.help.pitchTolerance",
                        &[("seconds", "1.5".into())],
                    ))),
            )
    }
    fn progress(&self, cx: &mut Context<Self>) -> Div {
        div()
            .child(self.back(cx))
            .child(training_eyebrow(
                t("training.progress.eyebrow").to_uppercase(),
            ))
            .child(
                Self::heading(t("training.progress.heading"), 34.)
                    .mt(px(5.))
                    .mb(px(6.)),
            )
            .child(Self::text(t("training.progress.subheading"), 15., DIM).mb(px(26.)))
            .child(self.program(cx).mb(px(24.)))
            .when(self.history.aggregate.sessions > 0, |d| {
                d.child(self.saved_history())
            })
            .when(self.history.aggregate.sessions == 0, |d| {
                d.child(
                    training_card()
                        .rounded(px(12.))
                        .p(px(30.))
                        .text_center()
                        .child(
                            Self::heading(t("training.progress.empty.heading"), 21.)
                                .font_family(DISPLAY_700)
                                .mb(px(7.)),
                        )
                        .child(Self::text(t("training.progress.empty.body"), 14., DIM).mb(px(18.)))
                        .child(
                            div().flex().justify_center().child(
                                training_primary(
                                    "training-progress-start",
                                    t("training.progress.empty.cta"),
                                )
                                .when(true,|d|self.setup_control("training-progress-start",d,true,cx)),
                            ),
                        ),
                )
            })
    }
}
impl Render for TrainingScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.keyboard_order.borrow_mut().clear();self.selector_options.borrow_mut().clear();
        if self.keyboard_focus_pending {self.keyboard_focus_pending=false;self.keyboard_scope.focus(window,cx);}
        if self.run.is_some() {
            let banner = self.history_banner(cx);
            let running = self.running(window, cx);
            self.order_running_controls();
            self.recover_running_focus(window,cx);
            return div()
                .id("training-run-view")
                .when(true,|d|self.keyboard_probe("training-run-view",d))
                .track_focus(&self.keyboard_scope)
                .key_context("SingZTrainingSetup")
                .on_action(cx.listener(|s,_:&NextSelectorFocus,w,cx|{s.selector_next(false,w,cx);w.prevent_default();cx.stop_propagation();}))
                .on_action(cx.listener(|s,_:&PreviousSelectorFocus,w,cx|{s.selector_next(true,w,cx);w.prevent_default();cx.stop_propagation();}))
                .on_key_down(cx.listener(|s,event,w,cx|s.progress_scroll_key(event,w,cx)))
                .flex_1()
                .min_h_0()
                .flex()
                .flex_col()
                .children(banner)
                .child(running)
                .into_any_element();
        }
        let width = f32::from(window.viewport_size().width);
        let home = self.route == Route::Home;
        let content = match self.route {
            Route::Home => div()
                .children(self.song_card(cx))
                .child(self.home(width, cx)),
            Route::Setup => self.setup(cx),
            Route::Progress => self.progress(cx),
        };
        if self.route==Route::Setup {
            let mut preferred=vec!["training-back".to_owned(),"training-key".into(),"training-mode".into()];
            for group in ["training-task","training-direction"]{for i in 0..3{preferred.push(format!("{group}-{i}"));}}
            preferred.extend(["training-low","training-high","training-interval-focus"].into_iter().map(str::to_owned));
            for group in ["training-interval","training-degree"]{for i in 0..7{preferred.push(format!("{group}-{i}"));}}
            preferred.extend(["training-sound","training-test","training-volume-minus","training-volume","training-volume-plus"].into_iter().map(str::to_owned));
            for i in 0..4{preferred.push(format!("training-tolerance-{i}"));}
            preferred.extend(["training-length","training-start"].into_iter().map(str::to_owned));
            let mut order=self.keyboard_order.borrow_mut();order.sort_by_key(|id|preferred.iter().position(|item|item==id).unwrap_or(usize::MAX));
        }
        let banner = if self.review || self.audio_error.is_none() {
            tv(
                "settings.monitor.audioSafetyBlocked",
                &[("subject", t("settings.subject.trainingAudio"))],
            )
        } else {
            self.audio_error.clone().unwrap_or_default()
        };
        let scrolling = div()
            .id("training-scroll")
            .relative()
            .size_full()
            .overflow_y_scroll()
            .restrict_scroll_to_axis()
            .track_scroll(&self.scroll)
            .child(
                div()
                    .w_full()
                    .max_w(px(if home { 1240. } else { 1040. }))
                    .mx_auto()
                    .pl(px(if home { 32. } else { 42. }))
                    .pr(px(if home { 42. } else { 52. }))
                    .pt(px(if home {
                        (f32::from(window.viewport_size().height) * 0.04).clamp(28., 48.)
                    } else {
                        30.
                    }))
                    .pb(px(42.))
                    .when(
                        self.route != Route::Progress
                            && (!self.audio_available || self.audio_error.is_some()),
                        |d| {
                            d.child(
                                training_banner().mb(px(18.)).child(
                                    Self::text(banner, 14., DIM)
                                        .line_height(px(21.))
                                        .min_h(px(34.)),
                                ),
                            )
                        },
                    )
                    .children(self.history_banner(cx))
                    .child(content)
                    .when(self.route == Route::Setup, |inner| {
                        inner.child(div().h(px(82.)))
                    }),
            );
        // The banner is painted before page content although its control is
        // registered afterward. Keep logical boundaries aligned with GPUI's
        // rendered tab stops so the final action can hand focus to the header.
        self.keyboard_order.borrow_mut().sort_by_key(|id|match id.as_str(){
            "training-save-retry"=>0,
            "training-prepare-notes"=>1,
            "training-prepare-intervals"=>2,
            "training-prepare-chords"=>3,
            "training-prepare-mixed"=>4,
            _=>5,
        });
        let page_width = width.min(if home { 1240. } else { 1040. });
        let view=div()
            .track_focus(&self.keyboard_scope)
            .when(true,|d|d.key_context("SingZTrainingSetup")
                .on_action(cx.listener(|s,_:&NextSelectorFocus,w,cx|{s.selector_next(false,w,cx);w.prevent_default();cx.stop_propagation();}))
                .on_action(cx.listener(|s,_:&PreviousSelectorFocus,w,cx|{s.selector_next(true,w,cx);w.prevent_default();cx.stop_propagation();})))
            .on_key_down(cx.listener(|s,event,w,cx|s.progress_scroll_key(event,w,cx)))
            .relative()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(scrolling)
            .child(
                div()
                    .absolute()
                    .top_0()
                    .bottom_0()
                    .left(px((width - page_width) / 2.))
                    .w(px(page_width))
                    .child(production_scrollbar(&self.scroll)),
            )
            .when(self.route == Route::Setup, |d| {
                d.child(
                    div()
                        .absolute()
                        .bottom(px(42.))
                        .left(px((width - width.min(1040.)) / 2. + 42.))
                        .w(px(width.min(1040.) - 94.))
                        .child(self.footer(cx)),
                )
            })
            .into_any_element();
        if let Some(id)=self.focused_control(window){
            if !self.keyboard_order.borrow().contains(&id){
                self.open=None;self.menu_index=None;self.keyboard_scope.focus(window,cx);cx.notify();
            }else if !matches!(id.as_str(),"training-length"|"training-start"){
                if let Some(bounds)=self.keyboard_bounds.borrow().get(&id){
                    let viewport=self.scroll.bounds();let bottom=if self.route==Route::Setup{self.keyboard_bounds.borrow().get("training-footer").map_or(viewport.bottom()-px(4.),|footer|footer.top()-px(8.))}else{viewport.bottom()-px(4.)};
                    let correction=if bounds.top()<viewport.top()+px(4.){viewport.top()+px(4.)-bounds.top()}else if bounds.bottom()>bottom{bottom-bounds.bottom()}else{px(0.)};
                    if correction!=px(0.)&&viewport.size.height>px(0.){let offset=self.scroll.offset();self.scroll.set_offset(point(offset.x,offset.y+correction));cx.notify();}
                }
            }
        }
        view
    }
}

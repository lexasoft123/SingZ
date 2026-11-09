//! Production Transport.tsx composition. State is controlled by the host;
//! engine-only actions are events, never simulated successful native operations.
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DIM, FAINT, LINE, TEXT};
use singz_uikit::{TransportIcon, colored_icon, tracked_label, tracked_text};
use singz_uikit::{
    disabled_bpm_field, ghost_pill, karaoke_pill, metronome_button, play_button,
    round_button, split_pill, transport_badge, transport_chip,
};

fn song_db(gain:f32)->f32 {if gain>0. {20.*gain.log10()}else{f32::NEG_INFINITY}}
fn song_gain(db:f32)->f32 {if db<=-60. {0.}else{10_f32.powf(db/20.)}}
fn song_fader_db(gain:f32)->f32 {((song_db(gain).clamp(-60.,12.)*2.).round()/2.).clamp(-60.,12.)}
fn remember_song_gain(gain:f32,previous:&mut f32){if gain>0. {*previous=gain;}}
fn muted_song_gain(gain:f32,previous:f32)->f32 {if gain>0. {0.}else{previous}}
fn song_gain_label(gain:f32)->String {
    let db=song_db(gain);
    if !db.is_finite(){"−∞ dB".into()}
    else {format!("{}{:.1} dB",if db>0.05 {"+"}else{""},if db.abs()<0.05 {0.}else{db})}
}
#[derive(Default)]
struct OutputMeter {held:f32,clipped:bool,previous_count:u64}
impl OutputMeter {
    fn sample(&mut self,peak:f32,count:u64,decay:f32){
        self.held=peak.max(self.held*decay);
        self.clipped|=count!=self.previous_count&&count>0;
        self.previous_count=count;
    }
    fn reset_clip(&mut self,count:u64){self.clipped=false;self.previous_count=count;}
}
fn reset_song_output_memory(previous:&mut f32,meter:&mut OutputMeter){
    *previous=1.;*meter=OutputMeter::default();
}

#[derive(Clone, Copy)]
pub enum TransportEvent {
    Play,
    Restart,
    Loop,
    Transpose(i32),
    Karaoke,
    Tempo(f32),
    /// Keyboard Enter/Escape ended BPM editing; restore app-local shortcuts.
    BpmClosed,
    Volume(f32),
    Metronome,
    CarryLine,
    StemFiles,
    Split(crate::source_jobs::Mode),
    CancelSplit,
}
impl EventEmitter<TransportEvent> for Transport {}
pub struct Transport {
    pub guides: singz_uikit::GuideAnchors,
    pub met_enabled: bool,
    carry_enabled: bool,
    carry_ducking: bool,
    duration: f32,
    audio_available: bool,
    position: f32,
    playing: bool,
    transpose: i32,
    looping: bool,
    karaoke: bool,
    tempo: f32,
    bpm: Option<f32>,
    analysis: Option<(String, f32)>,
    count_in: Option<crate::transport_timing::CountIn>,
    bpm_input: Entity<InputState>,
    bpm_draft: Option<String>,
    bpm_refresh_input: bool,
    bpm_reset_focus: bool,
    bpm_cancel_blur: bool,
    bpm_pointer_first_focus: bool,
    bpm_last_focused: bool,
    _bpm_subscription: Subscription,
    _bpm_focus_subscription: Subscription,
    volume: f32,
    output_open: bool,
    output_pre_mute:f32,
    output_focus:FocusHandle,
    output_control_focus:[FocusHandle;4],
    output_focus_pending:bool,
    output_trigger:std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    output_meter:OutputMeter,
    output_latest_clips:u64,
    output_mounted:bool,
    output_meter_tick:std::time::Instant,
    split_open: bool,
    progress: Option<(String, f32)>,
    progress_started: std::time::Instant,
    #[cfg(feature = "ui-tests")]
    pub progress_phase: Option<f32>,
    split_trigger: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
    split: bool,
    can_resplit: bool,
    can_backing: bool,
    can_reveal_stems: bool,
    #[cfg(feature = "ui-tests")]
    bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<String, Bounds<Pixels>>>>,
}
impl Transport {
    pub fn new(w: &mut Window, cx: &mut Context<Self>) -> Self {
        let bpm_input = cx.new(|cx| InputState::new(w, cx));
        let subscription = cx.subscribe_in(&bpm_input, w, |s, _, event, w, cx| match event {
            InputEvent::Change => {
                if s.bpm_input.read(cx).focus_handle(cx).is_focused(w) && s.bpm_enabled() {
                    let raw = s.bpm_input.read(cx).value().to_string();
                    let clean: String = raw.chars().filter(char::is_ascii_digit).collect();
                    if clean != raw {
                        s.bpm_input
                            .update(cx, |input, cx| input.set_value(clean.clone(), w, cx));
                    }
                    s.bpm_draft = Some(clean);
                    s.bpm_last_focused = true;
                    cx.notify();
                }
            }
            InputEvent::Focus => {
                s.bpm_last_focused = true;
                s.bpm_cancel_blur = false;
                s.bpm_input.update(cx, |input, cx| input.select_all(w, cx));
            }
            InputEvent::Blur => s.finish_bpm_blur(cx),
            InputEvent::PressEnter { .. } => {
                // Raw Enter capture and Input's native action can both report
                // the key. Only the still-focused path closes/emits once.
                if s.bpm_focused(w, cx) {
                    s.commit_bpm(cx);
                    w.blur(cx);
                    cx.emit(TransportEvent::BpmClosed);
                }
            }
            _ => {}
        });
        let handle = bpm_input.read(cx).focus_handle(cx);
        let focus_subscription = cx.on_focus_out(&handle, w, |s, _, _, cx| s.finish_bpm_blur(cx));
        Self {
            guides: Default::default(),
            met_enabled: false,
            carry_enabled: false,
            carry_ducking: false,
            duration: 192.,
            audio_available: true,
            position: 64.,
            playing: false,
            transpose: 0,
            looping: false,
            karaoke: true,
            tempo: 1.,
            bpm: None,
            analysis: None,
            count_in: None,
            bpm_input,
            bpm_draft: None,
            bpm_refresh_input: true,
            bpm_reset_focus: false,
            bpm_cancel_blur: false,
            bpm_pointer_first_focus: false,
            bpm_last_focused: false,
            _bpm_subscription: subscription,
            _bpm_focus_subscription: focus_subscription,
            volume: 1.,
            output_open: false,
            output_pre_mute:1.,
            output_focus:cx.focus_handle().tab_stop(true),
            output_control_focus:std::array::from_fn(|_|cx.focus_handle().tab_stop(true)),
            output_focus_pending:false,
            output_trigger:Default::default(),
            output_meter:OutputMeter::default(),
            output_latest_clips:0,
            output_mounted:false,
            output_meter_tick:std::time::Instant::now(),
            split_open: false,
            progress: None,
            progress_started: std::time::Instant::now(),
            #[cfg(feature = "ui-tests")]
            progress_phase: None,
            split_trigger: Default::default(),
            split: true,
            can_resplit: true,
            can_backing: true,
            can_reveal_stems: true,
            #[cfg(feature = "ui-tests")]
            bounds: Default::default(),
        }
    }
    pub fn set_carry_state(&mut self, enabled: bool, ducking: bool, cx: &mut Context<Self>) {
        let ducking = enabled && ducking;
        if (self.carry_enabled, self.carry_ducking) != (enabled, ducking) {
            self.carry_enabled = enabled;
            self.carry_ducking = ducking;
            cx.notify();
        }
    }
    pub fn set_timing(
        &mut self,
        bpm: Option<f32>,
        analysis: Option<(String, f32)>,
        count_in: Option<crate::transport_timing::CountIn>,
        cx: &mut Context<Self>,
    ) {
        let bpm = bpm.filter(|v| v.is_finite() && *v > 0.);
        let analysis =
            analysis.map(|(label, p)| (label, if p.is_finite() { p.clamp(0., 1.) } else { 0. }));
        let count_in = count_in.filter(|s| s.total > 0 && s.total <= 40_000 && s.per_bar > 0);
        if self.bpm != bpm || self.analysis != analysis || self.count_in != count_in {
            if self.bpm != bpm {
                // React's draft survives ordinary base-BPM updates. Only the
                // explicit song reset below discards it.
                self.bpm_refresh_input = true;
            }
            self.bpm = bpm;
            self.analysis = analysis;
            self.count_in = count_in;
            cx.notify();
        }
    }
    /// Definite project replacement/fatal clear. The reset marker survives
    /// a new same-BPM feed before render, so an old editor cannot cross songs.
    pub fn reset_timing(&mut self, cx: &mut Context<Self>) {
        self.bpm = None;
        self.analysis = None;
        self.count_in = None;
        self.bpm_draft = None;
        self.bpm_pointer_first_focus = false;
        self.bpm_refresh_input = true;
        self.bpm_reset_focus = true;
        cx.notify();
    }
    pub fn bpm_input(&self) -> Entity<InputState> {
        self.bpm_input.clone()
    }
    pub fn bpm_focused(&self, w: &Window, cx: &App) -> bool {
        self.bpm_input.read(cx).focus_handle(cx).is_focused(w)
    }
    fn bpm_enabled(&self) -> bool {
        self.audio_available && self.bpm.is_some() && self.analysis.is_none()
    }
    fn effective_bpm(&self) -> Option<f32> {
        self.bpm.map(|b| (b * self.tempo).round())
    }
    fn count_in_text(&self) -> String {
        let Some(s) = self.count_in else {
            return String::new();
        };
        (0..s.total)
            .step_by(s.per_bar)
            .map(|b| {
                (b..b.saturating_add(s.per_bar).min(s.total))
                    .map(|i| if i < s.done { '●' } else { '○' })
                    .collect::<String>()
            })
            .collect::<Vec<_>>()
            .join(" ")
    }
    fn finish_bpm_blur(&mut self, cx: &mut Context<Self>) {
        // Both the input and direct FocusHandle can report the same transition.
        // Taking the draft in commit_bpm makes the native request single-shot.
        if !self.bpm_cancel_blur && self.bpm_enabled() && self.bpm_draft.is_some() {
            self.commit_bpm(cx);
        }
    }
    fn commit_bpm(&mut self, cx: &mut Context<Self>) {
        if let Some(draft) = self.bpm_draft.take() {
            if self.bpm_enabled() {
                if let (Some(base), Ok(target)) = (self.bpm, draft.parse::<f32>()) {
                    if target.is_finite() && target > 0. {
                        cx.emit(TransportEvent::Tempo(target / base));
                    }
                }
            }
        }
        self.bpm_refresh_input = true;
        cx.notify();
    }
    /// Reconcile app-local keyboard focus before a cached child is reused.
    /// The host calls this after feeding timing and before rendering transport.
    /// GPUI activation-oriented listeners intentionally skip inactive windows.
    pub fn reconcile_focus(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        let reset_focus = std::mem::take(&mut self.bpm_reset_focus);
        if (reset_focus || !self.bpm_enabled()) && self.bpm_focused(window, cx) {
            // Unmounted inputs lose only their own focus. Analysis suspends
            // the React-equivalent draft; explicit reset_timing discards it.
            // Neither path commits via the resulting native Blur event.
            self.bpm_cancel_blur = true;
            window.blur(cx);
        }
        let focused = self.bpm_focused(window, cx);
        if self.bpm_last_focused && !focused {
            self.finish_bpm_blur(cx);
        } else if !self.bpm_last_focused && focused {
            self.bpm_cancel_blur = false;
            self.bpm_input
                .update(cx, |input, cx| input.select_all(window, cx));
        }
        self.bpm_last_focused = focused;
        // GPUI suppresses activation-oriented FocusEvent paths for hidden
        // windows. Reconcile the actual local FocusHandle edge here as well:
        // this catches pointer, Tab and programmatic focus-out without raising
        // the window or touching the newly focused control.
    }
    pub fn timing_state(&self, w: &Window, cx: &App) -> serde_json::Value {
        serde_json::json!({"baseBpm":self.bpm,"effectiveBpm":self.effective_bpm(),"tempo":self.tempo,"analysis":self.analysis,"analysisPercent":self.analysis.as_ref().map(|(_,p)|(p*100.).round()),"countIn":self.count_in.map(|s|serde_json::json!({"total":s.total,"done":s.done,"perBar":s.per_bar})),"dots":self.count_in_text(),"draft":self.bpm_draft,"inputValue":self.bpm_input.read(cx).value().to_string(),"inputFocused":self.bpm_input.read(cx).focus_handle(cx).is_focused(w),"lastInputFocused":self.bpm_last_focused,"cancelBlur":self.bpm_cancel_blur,"resetFocusPending":self.bpm_reset_focus,"selectionRange":[self.bpm_input.read(cx).selected_range().start,self.bpm_input.read(cx).selected_range().end],"enabled":self.bpm_enabled()})
    }
    fn bpm_field(&self, w: &Window, cx: &mut Context<Self>) -> Stateful<Div> {
        let d = if let Some((label, p)) = &self.analysis {
            singz_uikit::transport_bpm_analysis("transport-bpm", label.clone(), *p)
        } else if self.bpm_enabled() {
            singz_uikit::transport_bpm_field("transport-bpm", &self.bpm_input, w)
                .on_mouse_down_out(cx.listener(|_, _, w, cx| {
                    // Default pointer focus runs later in this dispatch. Observe
                    // it after effects rather than committing on a guessed
                    // outside target or stealing that target's focus.
                    cx.defer_in(w, |s, w, cx| s.reconcile_focus(w, cx));
                }))
                .capture_any_mouse_down(cx.listener(|s, e: &MouseDownEvent, w, cx| {
                    if e.button == MouseButton::Left {
                        // Capture before the editor's own MouseDown focuses it
                        // and places its caret. A subsequent focused click must
                        // retain the user's ordinary caret/drag selection.
                        s.bpm_pointer_first_focus = !s.bpm_focused(w, cx);
                    }
                }))
                .on_click(cx.listener(|s, _, w, cx| {
                    let first_focus = std::mem::take(&mut s.bpm_pointer_first_focus);
                    if first_focus {
                        s.bpm_cancel_blur = false;
                    }
                    if !s.bpm_focused(w, cx) {
                        s.bpm_input.update(cx, |input, cx| input.focus(w, cx));
                    }
                    if first_focus {
                        // HTML's onFocus.select survives a plain first click.
                        // Native editor pointer handling may place its caret
                        // after the focus event, so repair only this first click
                        // after MouseUp/effects, never subsequent caret clicks.
                        cx.defer_in(w, |s, w, cx| {
                            if s.bpm_enabled()
                                && s.bpm_focused(w, cx)
                                && s.bpm_input.read(cx).selected_range().is_empty()
                            {
                                s.bpm_input.update(cx, |input, cx| input.select_all(w, cx));
                            }
                        });
                    }
                    cx.stop_propagation();
                }))
                .capture_key_down(cx.listener(|s, e: &KeyDownEvent, w, cx| {
                    if e.keystroke.key == "tab" {
                        cx.defer_in(w, |s, w, cx| s.reconcile_focus(w, cx));
                    }
                    if !s.bpm_input.read(cx).focus_handle(cx).is_focused(w) {
                        return;
                    }
                    match e.keystroke.key.as_str() {
                        "escape" => {
                            s.bpm_draft = None;
                            s.bpm_refresh_input = true;
                            w.blur(cx);
                            cx.emit(TransportEvent::BpmClosed);
                            cx.notify();
                            cx.stop_propagation();
                        }
                        "enter" => {
                            s.commit_bpm(cx);
                            w.blur(cx);
                            cx.emit(TransportEvent::BpmClosed);
                            cx.stop_propagation();
                        }
                        // Printable keys must propagate to GPUI's native text
                        // input handler. Consuming them in capture prevents IME
                        // delivery entirely; the host's bpm_focused guard owns
                        // transport shortcut containment without consuming text.
                        _ => {}
                    }
                }))
        } else {
            disabled_bpm_field("transport-bpm")
        };
        self.probe("transport-bpm", d)
    }
    fn bpm_step(
        &self,
        id: &'static str,
        label: &'static str,
        step: f32,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let enabled = self.bpm_enabled();
        self.probe(
            id,
            transport_chip(id, label)
                .when(!enabled, |d| d.opacity(0.35).cursor_default())
                .on_click(cx.listener(move |s, _, _, cx| {
                    if s.bpm_enabled() {
                        if let (Some(base), Some(shown)) = (s.bpm, s.effective_bpm()) {
                            cx.emit(TransportEvent::Tempo((shown + step) / base));
                        }
                    }
                })),
        )
    }
    pub fn set_progress(&mut self, progress: Option<(String, f32)>, cx: &mut Context<Self>) {
        if self.progress != progress {
            if self.progress.is_none() {
                self.progress_started = std::time::Instant::now();
            }
            self.progress = progress;
            if self.progress.is_some() {
                self.split_open = false;
            }
            cx.notify();
        }
    }
    fn progress_phase(&self) -> f32 {
        #[cfg(feature = "ui-tests")]
        if let Some(phase) = self.progress_phase {
            return phase;
        }
        (self.progress_started.elapsed().as_secs_f32() / 1.6).fract()
    }
    pub fn set_stem_reveal(&mut self, available: bool, cx: &mut Context<Self>) {
        if self.can_reveal_stems != available {
            self.can_reveal_stems = available;
            cx.notify();
        }
    }
    pub fn set_split_state(
        &mut self,
        split: bool,
        resplit: bool,
        backing: bool,
        cx: &mut Context<Self>,
    ) {
        if (self.split, self.can_resplit, self.can_backing) != (split, resplit, backing) {
            self.split = split;
            self.can_resplit = resplit;
            self.can_backing = backing;
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.bounds.borrow().get(id).copied()
    }
    pub fn dismiss_popovers(&mut self, cx: &mut Context<Self>) -> bool {
        let open = self.split_open || self.output_open;
        if open {
            self.split_open = false;
            self.output_open = false;
            cx.notify();
        }
        open
    }
    pub fn has_popover(&self) -> bool {
        self.split_open || self.output_open
    }
    fn probe(&self, id: &str, element: Stateful<Div>) -> Stateful<Div> {
        #[cfg(not(feature = "ui-tests"))]
        if id != "transport-split" {
            return element;
        }
        let id = id.to_owned();
        let trigger = self.split_trigger.clone();
        #[cfg(feature = "ui-tests")]
        let bounds = self.bounds.clone();
        element.relative().child(
            canvas(
                move |b, _, _| {
                    if id == "transport-split" {
                        trigger.set(Some(b));
                    }
                    #[cfg(feature = "ui-tests")]
                    bounds.borrow_mut().insert(id.clone(), b);
                    b
                },
                |_, _, _, _| {},
            )
            .absolute()
            .top_0()
            .left_0()
            .size_full(),
        )
    }
    pub fn set_state(
        &mut self,
        position: f32,
        playing: bool,
        transpose: i32,
        looping: bool,
        cx: &mut Context<Self>,
    ) {
        if (self.position, self.playing, self.transpose, self.looping)
            != (position, playing, transpose, looping)
        {
            self.position = position;
            self.playing = playing;
            self.transpose = transpose;
            self.looping = looping;
            cx.notify();
        }
    }
    pub fn set_tempo(&mut self, tempo: f32, cx: &mut Context<Self>) {
        if self.tempo != tempo {
            self.tempo = tempo;
            self.bpm_refresh_input = true;
            cx.notify();
        }
    }
    pub fn set_native_mix(&mut self, volume: f32, cx: &mut Context<Self>) {
        self.volume = volume;
        remember_song_gain(volume,&mut self.output_pre_mute);
        cx.notify();
    }
    pub fn set_audio_available(&mut self, available: bool, cx: &mut Context<Self>) {
        if self.audio_available != available {
            self.audio_available = available;
            if !available {
                self.split_open = false;
                self.playing = false;
                self.looping = false;
            }
            cx.notify();
        }
    }
    pub fn set_duration(&mut self, duration: f32, cx: &mut Context<Self>) {
        if self.duration != duration {
            self.duration = duration;
            cx.notify();
        }
    }
    pub fn set_karaoke(&mut self, on: bool, cx: &mut Context<Self>) {
        if self.karaoke != on {
            self.karaoke = on;
            cx.notify();
        }
    }
    fn icon(path: &'static str, size: f32) -> Div {
        let kind = match path {
            "restart" => TransportIcon::Restart,
            "play" => TransportIcon::Play,
            "pause" => TransportIcon::Pause,
            "loop" => TransportIcon::Loop,
            "transport-met" => TransportIcon::Metronome,
            "transport-carry" => TransportIcon::CarryLine,
            "transport-mic" => TransportIcon::Mic,
            "transport-speaker" => TransportIcon::Speaker,
            _ => TransportIcon::Chevron,
        };
        let color = match kind {
            TransportIcon::Play | TransportIcon::Pause => 0x241705,
            TransportIcon::Mic => ACCENT,
            _ => DIM,
        };
        div()
            .size(px(size))
            .flex_shrink_0()
            .child(colored_icon(kind, color))
    }
    fn mono(text: impl Into<SharedString>) -> Div {
        div()
            .font_family("SingZ Mono 400")
            .text_color(rgb(FAINT))
            .text_size(px(10.))
            .line_height(px(12.))
            .child(text.into())
    }
    fn clock(position: f32) -> String {
        let tenths = (position.max(0.) * 10.).floor() as u32;
        format!("{}:{:02}.{}", tenths / 600, (tenths / 10) % 60, tenths % 10)
    }
    /// A source Transport/SongOutput unmount discards its local refs. Native
    /// graph epochs alone do not identify that React component lifetime.
    pub fn reset_song_output(&mut self,cx:&mut Context<Self>){
        reset_song_output_memory(&mut self.output_pre_mute,&mut self.output_meter);
        self.volume=1.;self.output_latest_clips=0;self.output_open=false;
        self.output_focus_pending=false;self.output_mounted=false;
        self.output_meter_tick=std::time::Instant::now();cx.notify();
    }
    pub fn set_output_mounted(&mut self,mounted:bool,gain:f32,cx:&mut Context<Self>){
        if self.output_mounted!=mounted {
            self.reset_song_output(cx);self.output_mounted=mounted;
            if mounted {self.set_native_mix(gain,cx);}
        }
    }
    pub fn set_native_peak(&mut self,peak:f32,clips:u64,covered:bool,cx:&mut Context<Self>) {
        let now=std::time::Instant::now();
        self.output_latest_clips=clips;
        if covered||!self.output_mounted {self.output_meter_tick=now;return;}
        let elapsed=now.duration_since(self.output_meter_tick).as_secs_f32();
        if elapsed>=0.05 {
            let previous=(self.output_meter.held,self.output_meter.clipped);
            self.output_meter.sample(peak,clips,0.79_f32.powf(elapsed/0.05));
            self.output_meter_tick=now;
            if previous!=(self.output_meter.held,self.output_meter.clipped) {cx.notify();}
        }
    }
    fn output_gain(&mut self,gain:f32,cx:&mut Context<Self>){
        self.volume=gain;
        remember_song_gain(gain,&mut self.output_pre_mute);
        cx.emit(TransportEvent::Volume(gain));cx.notify();
    }
    fn output_db(&mut self,db:f32,cx:&mut Context<Self>){
        let db=((db*2.).round()/2.).clamp(-60.,12.);
        // A range input emits Change only when its stepped value changes.
        // In particular, touching +12 at saved native gain 4 must not narrow it.
        if db!=song_fader_db(self.volume) {self.output_gain(song_gain(db),cx);}
    }
    #[cfg(feature="ui-tests")]
    pub fn output_state(&self)->serde_json::Value {
        serde_json::json!({"open":self.output_open,"gain":self.volume,"previousGain":self.output_pre_mute,
            "label":song_gain_label(self.volume),"faderDb":song_fader_db(self.volume),
            "heldNativePeak":self.output_meter.held,"clipped":self.output_meter.clipped,"clipCount":self.output_latest_clips})
    }
    fn output(&self, compact: bool, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let weak=cx.entity().downgrade();
        let trigger=self.output_trigger.clone();
        let label=song_gain_label(self.volume);
        let trigger_hint=crate::i18n::tv("player.transport.volumeAt",&[("db",label.clone())]);
        let mute_hint=crate::i18n::t(if self.volume>0. {"player.volume.muteAll"}else{"player.volume.unmute"});
        let clip_hint=crate::i18n::t("player.volume.peakTitle");
        let fader=singz_uikit::song_output_fader("transport-output-slider",song_fader_db(self.volume),move|db,_,cx|{
            let _=weak.update(cx,|s,cx|s.output_db(db,cx));
        }).track_focus(&self.output_focus).tab_index(0)
            .on_key_down(cx.listener(|s,event:&KeyDownEvent,_,cx|{
                let current=song_fader_db(s.volume);
                let db=match event.keystroke.key.as_str(){"left"|"down"=>Some(current-0.5),"right"|"up"=>Some(current+0.5),"home"=>Some(-60.),"end"=>Some(12.),_=>None};
                if let Some(db)=db {s.output_db(db,cx);cx.stop_propagation();}
                else if matches!(event.keystroke.key.as_str(),"space"|"enter") {cx.stop_propagation();}
            }));
        let mute=self.probe("transport-output-mute",singz_uikit::song_output_mute("transport-output-mute",self.volume==0.)
            .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(mute_hint.clone()).build(w,cx))
            .track_focus(&self.output_control_focus[1]).tab_index(0)
            .on_key_down(cx.listener(|s,e:&KeyDownEvent,_,cx|{if matches!(e.keystroke.key.as_str(),"space"|"enter") {s.output_gain(muted_song_gain(s.volume,s.output_pre_mute),cx);cx.stop_propagation();}}))
            .on_click(cx.listener(|s,_,_,cx|s.output_gain(muted_song_gain(s.volume,s.output_pre_mute),cx))));
        let unity=self.probe("transport-output-unity",singz_uikit::song_output_action("transport-output-unity",crate::i18n::t("player.volume.reset"))
            .track_focus(&self.output_control_focus[2]).tab_index(0)
            .on_key_down(cx.listener(|s,e:&KeyDownEvent,_,cx|{if matches!(e.keystroke.key.as_str(),"space"|"enter") {s.output_gain(1.,cx);cx.stop_propagation();}}))
            .on_click(cx.listener(|s,_,_,cx|s.output_gain(1.,cx))));
        let clip=self.probe("transport-output-clip",singz_uikit::song_output_clip("transport-output-clip",crate::i18n::t("player.volume.clipped"),self.output_meter.clipped)
            .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(clip_hint.clone()).build(w,cx))
            .track_focus(&self.output_control_focus[3]).tab_index(0)
            .on_key_down(cx.listener(|s,e:&KeyDownEvent,_,cx|{if matches!(e.keystroke.key.as_str(),"space"|"enter") {s.output_meter.reset_clip(s.output_latest_clips);cx.notify();cx.stop_propagation();}}))
            .on_click(cx.listener(|s,_,_,cx|{s.output_meter.reset_clip(s.output_latest_clips);cx.notify();})));
        let panel=singz_uikit::song_output_panel(singz_uikit::SongOutputCopy{
            title:crate::i18n::t("player.volume.title"),saved:crate::i18n::t("player.volume.saved"),
            per_song:crate::i18n::t("player.volume.perSong"),peak:crate::i18n::t("player.volume.peak"),caption:crate::i18n::t("player.volume.caption")
        },label.trim_end_matches(" dB").to_owned(),self.output_meter.held,mute,unity,self.probe("transport-output-slider",fader),clip)
            .on_mouse_down_out(cx.listener(|s,event:&MouseDownEvent,_,cx|{
                if !s.output_trigger.get().is_some_and(|b|b.contains(&event.position)){s.output_open=false;cx.notify();}
            }));
        div().relative().flex_shrink_0()
            .child(self.probe("transport-output",singz_uikit::song_output_trigger_meter("transport-output",label,compact,self.volume==0.,self.output_open,self.output_meter.held,self.output_meter.clipped)
                .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(trigger_hint.clone()).build(w,cx))
                .track_focus(&self.output_control_focus[0]).tab_index(0)
                .on_key_down(cx.listener(|s,e:&KeyDownEvent,_,cx|{if matches!(e.keystroke.key.as_str(),"space"|"enter") {s.output_open=!s.output_open;s.output_focus_pending=s.output_open;cx.notify();cx.stop_propagation();}}))
                .on_click(cx.listener(|s,_,_,cx|{s.output_open=!s.output_open;s.output_focus_pending=s.output_open;cx.notify();})))
                .relative().child(canvas(move|b,_,_|{trigger.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0()))
            .when(self.output_open,|d|d.child(deferred(panel.absolute().bottom_full().mb(px(12.)).left(px(-8.))).with_priority(120)))
    }

}
impl Render for Transport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "ui-tests")]
        self.bounds.borrow_mut().clear();
        self.reconcile_focus(window, cx);
        if self.output_open&&self.output_focus_pending {self.output_focus_pending=false;self.output_focus.focus(window,cx);}
        if self.bpm_refresh_input {
            self.bpm_refresh_input = false;
            if self.bpm_draft.is_none() {
                let text = self
                    .effective_bpm()
                    .map(|b| format!("{b:.0}"))
                    .unwrap_or_else(|| "—".into());
                if self.bpm_input.read(cx).value().as_str() != text {
                    self.bpm_input
                        .update(cx, |s, cx| s.set_value(text, window, cx));
                }
            }
        }
        let compact = window.viewport_size().width <= px(1100.);
        let (_, clock_baseline) =
            singz_uikit::css_normal_line_metrics(window, "SingZ Mono 500", 21.);
        let (_, total_baseline) =
            singz_uikit::css_normal_line_metrics(window, "SingZ Mono 400", 11.);
        let transpose = self.transpose;
        let tempo = self.tempo;
        if self.progress.is_some() {
            window.request_animation_frame();
        }
        div()
            .w_full()
            .min_h(px(86.))
            .flex_shrink_0()
            .relative()
            .flex()
            .flex_wrap()
            .items_center()
            .gap_x(px(20.))
            .gap_y(px(10.))
            .px(px(24.))
            .py(px(12.))
            .border_t_1()
            .border_color(rgba(LINE))
            .bg(rgba(0x1b1814b8))
            .font_family("SingZ Display 400")
            .text_color(rgb(TEXT))
            .child(
                div()
                    .flex()
                    .items_center()
                    .gap(px(14.))
                    .min_w(px(if compact { 540.84375 } else { 576.84375 }))
                    .flex_shrink_0()
                    .child(
                        self.probe("transport-restart", singz_uikit::audio_control(round_button("transport-restart", false),self.audio_available)
                            .child(Self::icon("restart", 13.))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Restart)))),
                    )
                    .child(
                        self.probe("transport-play", singz_uikit::audio_control(play_button("transport-play", self.playing),self.audio_available)
                            .child(
                                Self::icon(if self.playing { "pause" } else { "play" }, 16.)
                                    .ml(px(if self.playing { 0. } else { 1. })),
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Play)))),
                    )
                    .child(
                        div()
                            .ml(px(6.))
                            .flex()
                            .items_start()
                            .gap(px(8.))
                            .child(
                                div()
                                    .min_w(px(96.))
                                    .font_family("SingZ Mono 500")
                                    .text_size(px(21.))
                                    .line_height(px(25.))
                                    .child(
                                        tracked_text(
                                            Self::clock(self.position),
                                            "SingZ Mono 500",
                                            21.,
                                            0.42,
                                            TEXT,
                                        )
                                        .line_height(25.),
                                    ),
                            )
                            .child(
                                div().pt(clock_baseline - total_baseline).child(
                                    tracked_text(
                                        format!(
                                            "/ {}:{:02}",
                                            self.duration as u32 / 60,
                                            self.duration as u32 % 60
                                        ),
                                        "SingZ Mono 400",
                                        11.,
                                        0.44,
                                        FAINT,
                                    )
                                    .line_height(13.),
                                ),
                            ),
                    )
                    .when(!self.count_in_text().is_empty(),|d|d.child(self.probe("countin-dots",singz_uikit::transport_count_in_dots("countin-dots",self.count_in_text()))))
                    .child(
                        singz_uikit::audio_control(round_button("transport-loop", self.looping),self.audio_available).when(true,|d|self.guides.track_box(d,"loop",[1.;4]))
                            .child(Self::icon("loop", 14.))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Loop))),
                    )
                    .child(self.output(compact, cx))
                    .child(
                        singz_uikit::audio_control(metronome_button("transport-met", self.met_enabled),self.audio_available).when(true,|d|self.guides.track_box(d,"metronome",[1.;4]))
                            .child(
                                div()
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .child(colored_icon(
                                        TransportIcon::Metronome,
                                        if self.met_enabled { ACCENT } else { DIM },
                                    )),
                            )
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(TransportEvent::Metronome)),
                            ),
                    )
                    .child(
                        singz_uikit::audio_control(singz_uikit::carry_line_trigger("transport-carry", self.carry_enabled, self.carry_ducking),self.audio_available)
                            .when(true,|d|self.guides.track_box(d,"carry",[1.;4]))
                            .child(if self.carry_enabled {div().size(px(14.)).flex_shrink_0().child(colored_icon(TransportIcon::CarryLine,if self.carry_ducking {singz_uikit::tokens::BG}else{ACCENT}))} else {Self::icon("transport-carry", 14.)})
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(TransportEvent::CarryLine)),
                            ),
                    ),
            )
            .child(
                div()
                    .ml_auto()
                    .when(true,|d|self.guides.track(d,"tempo"))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .h(px(36.))
                    .min_w(px(668.171875))
                    .flex_shrink_0()
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .child(transport_chip("transport-transpose-down", "−").on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(TransportEvent::Transpose(transpose - 1))
                                }),
                            ))
                            .child(
                                transport_badge(
                                    "transport-transpose-reset",
                                    if transpose > 0 {
                                        format!("+{transpose}")
                                    } else {
                                        transpose.to_string()
                                    },
                                    "st",
                                    transpose != 0,
                                )
                                .cursor_pointer()
                                .on_click(
                                    cx.listener(|_, _, _, cx| {
                                        cx.emit(TransportEvent::Transpose(0))
                                    }),
                                ),
                            )
                            .child(transport_chip("transport-transpose-up", "+").on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(TransportEvent::Transpose(transpose + 1))
                                }),
                            )),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .child(transport_chip("transport-tempo-down", "−").on_click(
                                cx.listener(move |_, _, _, cx| {
                                    cx.emit(TransportEvent::Tempo((tempo - 0.05).max(0.5)));
                                }),
                            ))
                            .child(
                                transport_badge(
                                    "transport-tempo-reset",
                                    format!("{}", (tempo * 100.).round() as u32),
                                    "%",
                                    (tempo - 1.).abs() > 0.001,
                                )
                                .cursor_pointer()
                                .on_click(cx.listener(
                                    |_, _, _, cx| {
                                        cx.emit(TransportEvent::Tempo(1.));
                                    },
                                )),
                            )
                            .child(
                                transport_chip("transport-tempo-up", "+").on_click(cx.listener(
                                    move |_, _, _, cx| {
                                        cx.emit(TransportEvent::Tempo((tempo + 0.05).min(1.5)));
                                    },
                                )),
                            )
                            .child(self.bpm_step("transport-bpm-down","−",-1.,cx))
                            .child(self.bpm_field(window,cx))
                            .child(self.bpm_step("transport-bpm-up","+",1.,cx)),
                    )
                    .when_some(self.progress.clone(), |d, (label, percent)| d.child(
                        self.probe("split-progress", singz_uikit::split_progress(label, percent, self.progress_phase()).id("split-progress")
                            .child(self.probe("split-cancel", singz_uikit::split_cancel("split-cancel").on_click(cx.listener(|_, _, _, cx| cx.emit(TransportEvent::CancelSplit))))))
                    ))
                    .when(self.progress.is_none(), |d| d
                    .when(self.split, |d| d.child(
                        self.probe("transport-karaoke", singz_uikit::audio_control(karaoke_pill("transport-karaoke", "", self.karaoke),self.audio_available).when(true,|d|self.guides.track_box(d,"karaoke",[1.;4]))
                            .child(Self::icon("transport-mic", 13.))
                            .child(tracked_label(crate::i18n::t("player.transport.karaoke"), 0.01))
                            .on_click(cx.listener(|this, _, _, cx| {
                                if !this.audio_available{return;}
                                this.karaoke = !this.karaoke;
                                cx.emit(TransportEvent::Karaoke);
                                cx.notify();
                            }))),
                    ))
                    .child(
                        div()
                            .relative()
                            .child(self.probe("transport-split",singz_uikit::audio_control(split_pill("transport-split", crate::i18n::t("player.split.button")),self.audio_available).when(true,|d|self.guides.track_box(d,"split",[1.;4]))
                                    .child(Self::icon("transport-chevron", 8.))
                                    .on_click(cx.listener(|this, _, _, cx| {if this.audio_available{this.split_open = !this.split_open;cx.notify();}}))))
                            .when(self.split_open, |v| {
                                v.child(deferred(singz_uikit::transport_popover().on_mouse_down_out(cx.listener(|s,event:&MouseDownEvent,_,cx|{if !s.split_trigger.get().is_some_and(|b|b.contains(&event.position)){s.split_open=false;cx.notify();}})).absolute().bottom_full().right_0().mb(px(12.)).w(px(320.))
                                    .child(div().mb(px(10.)).text_size(px(13.)).font_family(singz_uikit::tokens::DISPLAY_700).child(if self.split{crate::i18n::t("player.split.optionsTitle")}else{crate::i18n::t("player.split.title")}))
                                    .when(self.split,|d|d
                                        .child(self.probe("split-vocals",singz_uikit::split_action("split-vocals",crate::i18n::t("player.split.separateBacking"),self.can_backing).on_click(cx.listener(|s,_,_,cx|{if s.can_backing{s.split_open=false;cx.emit(TransportEvent::Split(crate::source_jobs::Mode::Vocals));cx.notify();}}))))
                                        .child(self.probe("split-stems",singz_uikit::split_action("split-stems",crate::i18n::t("player.split.resplitStems"),self.can_resplit).on_click(cx.listener(|s,_,_,cx|{if s.can_resplit{s.split_open=false;cx.emit(TransportEvent::Split(crate::source_jobs::Mode::Stems));cx.notify();}})))))
                                    .when(!self.split,|d|d
                                        .child(div().text_size(px(13.)).line_height(px(19.5)).text_color(rgb(DIM)).mb(px(14.)).child(crate::i18n::t("player.split.explain")))
                                        .child(div().text_size(px(12.)).line_height(px(18.)).text_color(rgb(DIM)).mt(px(8.)).mb(px(16.)).child(crate::i18n::t("player.split.hint")))
                                        .child(self.probe("split-combined",singz_uikit::pill("split-combined",crate::i18n::t("player.split.button"),true).on_click(cx.listener(|s,_,_,cx|{s.split_open=false;cx.emit(TransportEvent::Split(crate::source_jobs::Mode::Combined));cx.notify();}))))))
                                    .with_priority(120))
                            }),
                    )
                    .when(self.split && self.can_reveal_stems, |d| d.child(
                        self.probe("transport-stem-files", singz_uikit::audio_control(ghost_pill("transport-stem-files", crate::i18n::t("player.transport.stemFiles")),self.audio_available).on_click(
                            cx.listener(|_, _, _, cx| cx.emit(TransportEvent::StemFiles)),
                        )),
                    )),                    )
            )
    }
}

#[cfg(test)]
mod song_output_tests {
    use super::{song_gain,song_db,song_gain_label,song_fader_db,remember_song_gain,muted_song_gain,OutputMeter,reset_song_output_memory};
    #[test]
    fn db_fader_has_silent_minimum_half_db_steps_and_native_headroom() {
        assert_eq!(song_gain(-60.),0.);
        assert_eq!(song_gain(-70.),0.);
        assert_eq!(song_gain(0.),1.);
        assert!((song_gain(12.)-3.9810717).abs()<0.00001);
        for db in [-59.5,-36.,-12.,0.5,12.] {assert!((song_db(song_gain(db))-db).abs()<0.00001);}
        assert_eq!(song_gain_label(0.),"−∞ dB");
        assert_eq!(song_gain_label(1.),"0.0 dB");
        assert_eq!(song_gain_label(4.),"+12.0 dB");
        assert_eq!(song_fader_db(4.),12.);
        assert_eq!(song_fader_db(0.0000001),-60.);
        assert_eq!(song_gain_label(0.0000001),"-140.0 dB");
    }
    #[test]
    fn mute_restores_exact_saved_gain_including_four_and_below_fader_minimum() {
        for saved in [4.,1.,0.6,0.0000001] {
            let mut previous=1.;remember_song_gain(saved,&mut previous);
            assert_eq!(muted_song_gain(saved,previous),0.);
            remember_song_gain(0.,&mut previous);
            assert_eq!(muted_song_gain(0.,previous),saved);
        }
        let mut previous=0.6;remember_song_gain(1.,&mut previous);
        assert_eq!(muted_song_gain(0.,previous),1.);
    }
    #[test]
    fn remounted_muted_song_uses_unity_instead_of_previous_songs_gain() {
        let mut previous=0.6;
        let mut meter=OutputMeter::default();meter.sample(1.4,2,0.79);
        meter.sample(0.,0,0.79); // A native counter restart is not a component remount.
        assert!(meter.clipped);
        reset_song_output_memory(&mut previous,&mut meter);
        remember_song_gain(0.,&mut previous); // New song's accepted saved gain.
        assert_eq!(muted_song_gain(0.,previous),1.);
        assert_eq!(meter.held,0.);assert!(!meter.clipped);assert_eq!(meter.previous_count,0);
        remember_song_gain(4.,&mut previous); // Same component still restores 4.
        remember_song_gain(0.,&mut previous);
        assert_eq!(muted_song_gain(0.,previous),4.);
    }
    #[test]
    fn native_clip_count_latches_until_reset_and_only_new_clips_rearm() {
        let mut meter=OutputMeter::default();
        meter.sample(1.5,3,0.79);assert!(meter.clipped);assert_eq!(meter.held,1.5);
        meter.reset_clip(3);meter.sample(0.,3,0.79);
        assert!(!meter.clipped);assert!((meter.held-1.185).abs()<0.000001);
        meter.sample(0.,4,0.79);assert!(meter.clipped);
        meter.reset_clip(4);meter.sample(0.,0,0.79);assert!(!meter.clipped);
        meter.sample(0.,1,0.79);assert!(meter.clipped);
    }
}

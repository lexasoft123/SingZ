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

actions!(singz_transport_split, [NextSplitFocus, PreviousSplitFocus]);

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
    duration: f64,
    audio_available: bool,
    position: f64,
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
    footer_scope: FocusHandle,
    split_scope: FocusHandle,
    control_focus: std::collections::BTreeMap<&'static str,FocusHandle>,
    footer_order: std::cell::RefCell<Vec<&'static str>>,
    split_order: std::cell::RefCell<Vec<&'static str>>,
    control_bounds: std::rc::Rc<std::cell::RefCell<std::collections::BTreeMap<&'static str,Bounds<Pixels>>>>,
    split_focus_pending: bool,
    focus_player_pending: bool,
    #[cfg(feature = "ui-tests")]
    last_focus_recovery_scope_owned: Option<bool>,
    progress: Option<crate::source_jobs::SplitProgress>,
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
        cx.bind_keys([
            KeyBinding::new("tab",NextSplitFocus,Some("SingZTransportSplit")),
            KeyBinding::new("shift-tab",PreviousSplitFocus,Some("SingZTransportSplit")),
        ]);
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
            footer_scope: cx.focus_handle(),
            split_scope: cx.focus_handle(),
            control_focus: ["transport-restart","transport-play","transport-loop","transport-output","transport-met","transport-carry","transport-transpose-down","transport-transpose-reset","transport-transpose-up","transport-tempo-down","transport-tempo-reset","transport-tempo-up","transport-bpm-down","transport-bpm-up","transport-karaoke","transport-split","split-cancel","transport-stem-files","split-vocals","split-stems","split-combined"].into_iter().map(|id|(id,cx.focus_handle().tab_stop(true))).collect(),
            footer_order: Default::default(),split_order:Default::default(),control_bounds:Default::default(),
            split_focus_pending:false,focus_player_pending:false,
            #[cfg(feature = "ui-tests")]
            last_focus_recovery_scope_owned:None,
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
    fn control_enabled(&self,id:&str)->bool {
        match id {
            "transport-output"=>true,
            "transport-transpose-down"|"transport-transpose-reset"|"transport-transpose-up"|"transport-tempo-down"|"transport-tempo-reset"|"transport-tempo-up"=>self.audio_available&&self.duration>0.,
            "transport-bpm-down"|"transport-bpm-up"=>self.bpm_enabled(),
            "split-cancel"=>self.progress.as_ref().is_some_and(|progress|progress.cancellable),
            "transport-karaoke"=>self.audio_available&&self.split&&self.progress.is_none(),
            "transport-split"=>self.audio_available&&self.progress.is_none(),
            "transport-stem-files"=>self.audio_available&&self.split&&self.can_reveal_stems&&self.progress.is_none(),
            "split-vocals"=>self.audio_available&&self.split&&self.can_backing&&self.split_open,
            "split-stems"=>self.audio_available&&self.split&&self.can_resplit&&self.split_open,
            "split-combined"=>self.audio_available&&!self.split&&self.split_open,
            _=>self.audio_available,
        }
    }
    fn activate_control(&mut self,id:&'static str,w:&mut Window,cx:&mut Context<Self>){
        if !self.control_enabled(id){return;}
        let event=match id {
            "transport-restart"=>Some(TransportEvent::Restart),"transport-play"=>Some(TransportEvent::Play),"transport-loop"=>Some(TransportEvent::Loop),
            "transport-met"=>Some(TransportEvent::Metronome),"transport-carry"=>Some(TransportEvent::CarryLine),
            "transport-transpose-down"=>Some(TransportEvent::Transpose(self.transpose-1)),"transport-transpose-reset"=>Some(TransportEvent::Transpose(0)),"transport-transpose-up"=>Some(TransportEvent::Transpose(self.transpose+1)),
            "transport-tempo-down"=>Some(TransportEvent::Tempo((self.tempo-0.05).max(0.5))),"transport-tempo-reset"=>Some(TransportEvent::Tempo(1.)),"transport-tempo-up"=>Some(TransportEvent::Tempo((self.tempo+0.05).min(1.5))),
            "transport-bpm-down"|"transport-bpm-up"=>self.bpm.zip(self.effective_bpm()).map(|(base,shown)|TransportEvent::Tempo((shown+if id=="transport-bpm-down"{-1.}else{1.})/base)),
            "transport-karaoke"=>{self.karaoke=!self.karaoke;Some(TransportEvent::Karaoke)},
            "transport-stem-files"=>Some(TransportEvent::StemFiles),"split-cancel"=>Some(TransportEvent::CancelSplit),
            "transport-output"=>{self.split_open=false;self.output_open=!self.output_open;self.output_focus_pending=self.output_open;None},
            "transport-split"=>{self.output_open=false;self.split_open=!self.split_open;self.split_focus_pending=self.split_open;None},
            "split-vocals"|"split-stems"|"split-combined"=>{self.close_split(w,cx);Some(TransportEvent::Split(match id{"split-vocals"=>crate::source_jobs::Mode::Vocals,"split-stems"=>crate::source_jobs::Mode::Stems,_=>crate::source_jobs::Mode::Combined}))},
            _=>None,
        };if let Some(event)=event{cx.emit(event);}cx.notify();
    }
    fn footer_control(&self,id:&'static str,element:Stateful<Div>,cx:&mut Context<Self>)->Stateful<Div>{
        self.focus_control_element(id,element,false,cx)
    }
    fn split_control(&self,id:&'static str,element:Stateful<Div>,cx:&mut Context<Self>)->Stateful<Div>{
        self.focus_control_element(id,element,true,cx)
    }
    fn focus_control_element(&self,id:&'static str,element:Stateful<Div>,menu:bool,cx:&mut Context<Self>)->Stateful<Div>{
        let element = match id {
            "transport-restart" => element.aria_label(crate::i18n::t("player.transport.backToStart")),
            "transport-play" => element.aria_label(crate::i18n::t(if self.playing {"player.transport.pause"} else {"player.transport.play"})),
            "transport-loop" => element.aria_label(crate::i18n::t("player.transport.loopSong")),
            "transport-met" => element.aria_label(crate::i18n::t("player.transport.metronomeTitle")),
            "transport-carry" => element.aria_label(crate::i18n::t("player.transport.carryLine")),
            "transport-transpose-down" | "transport-transpose-up" => element.aria_label(format!("{} {}",crate::i18n::t("player.transport.transposeTitle"),if id.ends_with("down") {"−"} else {"+"})),
            "transport-transpose-reset" => element.aria_label(crate::i18n::t("player.transport.resetTranspose")),
            "transport-tempo-down" | "transport-tempo-up" => element.aria_label(format!("{} {}",crate::i18n::t("player.transport.speedTitle"),if id.ends_with("down") {"−"} else {"+"})),
            "transport-tempo-reset" => element.aria_label(crate::i18n::t("player.transport.resetSpeed")),
            "transport-bpm-down" | "transport-bpm-up" => element.aria_label(format!("{} {}",crate::i18n::t("player.bpm.setTitle"),if id.ends_with("down") {"−1"} else {"+1"})),
            "transport-output" => element.aria_label(crate::i18n::tv("player.transport.volumeAt",&[("db",song_gain_label(self.volume))])).aria_expanded(self.output_open),
            "split-cancel" => element.aria_label(crate::i18n::t("player.transport.cancelSplit")),
            _ => element,
        };
        let enabled=self.control_enabled(id);if enabled{if menu{self.split_order.borrow_mut().push(id);}else{self.footer_order.borrow_mut().push(id);}}
        let focus=self.control_focus[id].clone();let weak=cx.entity().downgrade();
        let callback=move|w:&mut Window,cx:&mut App|{let _=weak.update(cx,|s,cx|s.activate_control(id,w,cx));};
        let element=if menu{singz_uikit::settings_control_with_focus(element,focus,enabled,callback)}else{singz_uikit::song_button_with_focus(element,focus,enabled,callback)};
        let bounds=self.control_bounds.clone();element.relative().child(canvas(move|b,_,_|{bounds.borrow_mut().insert(id,b);b},|_,_,_,_|{}).absolute().inset_0())
    }
    fn close_split(&mut self,w:&mut Window,cx:&mut Context<Self>){
        self.split_open=false;self.split_focus_pending=false;
        if self.control_enabled("transport-split"){self.control_focus["transport-split"].focus(w,cx);}else{self.footer_scope.focus(w,cx);self.focus_player_pending=true;}cx.notify();
    }
    fn move_split_focus(&mut self,backwards:bool,edge:Option<bool>,w:&mut Window,cx:&mut Context<Self>){
        if !self.split_open{return;}
        let order=self.split_order.borrow().clone();
        if !order.is_empty(){
            let current=order.iter().position(|id|self.control_focus[id].is_focused(w));
            let index=match edge{
                Some(false)=>0,Some(true)=>order.len()-1,
                None=>match current{Some(i)if backwards=>(i+order.len()-1)%order.len(),Some(i)=>(i+1)%order.len(),None if backwards=>order.len()-1,None=>0},
            };
            self.control_focus[order[index]].focus(w,cx);
        }else{self.split_scope.focus(w,cx);}
        cx.notify();
    }
    fn split_key(&mut self,event:&KeyDownEvent,w:&mut Window,cx:&mut Context<Self>){
        if !self.split_open{return;}
        let key=event.keystroke.key.as_str();
        if key=="escape"{self.close_split(w,cx);}
        else if matches!(key,"tab"|"up"|"down"|"left"|"right"|"home"|"end"){
            let backwards=key=="up"||key=="left"||(key=="tab"&&event.keystroke.modifiers.shift);
            self.move_split_focus(backwards,match key{"home"=>Some(false),"end"=>Some(true),_=>None},w,cx);
        }else if matches!(key,"enter"|"space"){
            let order=self.split_order.borrow();if order.iter().any(|id|self.control_focus[id].is_focused(w)){return;}
            if let Some(id)=order.first(){self.control_focus[id].focus(w,cx);}
        }
        w.prevent_default();cx.stop_propagation();cx.notify();
    }
    pub fn focused_control(&self,w:&Window)->Option<String>{self.control_focus.iter().find(|(_,focus)|focus.is_focused(w)).map(|(id,_)|(*id).to_owned())}
    pub fn split_focused(&self,w:&Window,cx:&App)->bool{self.split_open&&self.split_scope.contains_focused(w,cx)}
    pub fn split_open(&self)->bool{self.split_open}
    pub fn take_focus_player(&mut self,w:&Window)->bool{
        if !std::mem::take(&mut self.focus_player_pending){return false;}
        let scope_owned=self.footer_scope.is_focused(w);
        #[cfg(feature = "ui-tests")]
        {self.last_focus_recovery_scope_owned=Some(scope_owned);}
        scope_owned
    }
    pub fn keyboard_state(&self,w:&Window,cx:&App)->serde_json::Value{
        #[cfg(feature = "ui-tests")]
        let last_focus_recovery_scope_owned=self.last_focus_recovery_scope_owned;
        #[cfg(not(feature = "ui-tests"))]
        let last_focus_recovery_scope_owned:Option<bool>=None;
        let focused=self.focused_control(w);let bounds=focused.as_deref().and_then(|id|self.control_bounds.borrow().get(id).copied());serde_json::json!({"focusOrder":self.footer_order.borrow().clone(),"focusedControl":focused,"splitOpen":self.split_open,"splitFocused":self.split_focused(w,cx),"splitFocusOrder":self.split_order.borrow().clone(),"focusedBounds":bounds.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),"outputOpen":self.output_open,"outputFocused":self.output_focus.is_focused(w),"outputControlFocused":self.output_control_focus.iter().map(|focus|focus.is_focused(w)).collect::<Vec<_>>(),"bpmFocused":self.bpm_focused(w,cx),"audioAvailable":self.audio_available,"recoveryPending":self.focus_player_pending,"lastFocusRecoveryScopeOwned":last_focus_recovery_scope_owned,"footerScopeFocused":self.footer_scope.is_focused(w),"controlFocusDebug":self.control_focus.iter().map(|(id,focus)|((*id).to_owned(),format!("{focus:?}"))).collect::<std::collections::BTreeMap<_,_>>(),"footerScopeDebug":format!("{:?}",self.footer_scope),"splitScopeDebug":format!("{:?}",self.split_scope),"outputFocusDebug":format!("{:?}",self.output_focus),"outputControlFocusDebug":self.output_control_focus.iter().map(|focus|format!("{focus:?}")).collect::<Vec<_>>()})}
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
        _step: f32,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let enabled = self.bpm_enabled();
        self.probe(id,self.footer_control(id,transport_chip(id,label).when(!enabled,|d|d.opacity(0.35).cursor_default()),cx))
    }

    pub fn set_progress(&mut self, progress: Option<(String, f32)>, cx: &mut Context<Self>) {
        self.set_split_progress(progress.map(|(label, percent)| crate::source_jobs::SplitProgress { label, percent, cancellable: true }), cx);
    }
    pub fn set_split_progress(&mut self, progress: Option<crate::source_jobs::SplitProgress>, cx: &mut Context<Self>) {
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
        position: f64,
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
    pub fn set_duration(&mut self, duration: f64, cx: &mut Context<Self>) {
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
    fn clock(position: f64) -> String {
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
        }).aria_label(crate::i18n::t("player.volume.title"))
            .aria_description(crate::i18n::t("player.volume.sliderTitle"))
            .track_focus(&self.output_focus).tab_index(0);
        let mute_owner=cx.entity().downgrade();
        let mute=self.probe("transport-output-mute",singz_uikit::settings_control_with_focus(
            singz_uikit::song_output_mute("transport-output-mute",self.volume==0.)
                .aria_label(mute_hint.clone())
                .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(mute_hint.clone()).build(w,cx)),
            self.output_control_focus[1].clone(),true,move|_,cx|{
                let _=mute_owner.update(cx,|s,cx|s.output_gain(muted_song_gain(s.volume,s.output_pre_mute),cx));
            }));
        let unity_owner=cx.entity().downgrade();
        let unity=self.probe("transport-output-unity",singz_uikit::settings_control_with_focus(
            singz_uikit::song_output_action("transport-output-unity",crate::i18n::t("player.volume.reset")),
            self.output_control_focus[2].clone(),true,move|_,cx|{
                let _=unity_owner.update(cx,|s,cx|s.output_gain(1.,cx));
            }));
        let clip_owner=cx.entity().downgrade();
        let clip=self.probe("transport-output-clip",singz_uikit::settings_control_with_focus(
            singz_uikit::song_output_clip("transport-output-clip",crate::i18n::t("player.volume.clipped"),self.output_meter.clipped)
                .aria_label(clip_hint.clone())
                .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(clip_hint.clone()).build(w,cx)),
            self.output_control_focus[3].clone(),true,move|_,cx|{
                let _=clip_owner.update(cx,|s,cx|{s.output_meter.reset_clip(s.output_latest_clips);cx.notify();});
            }));
        let panel=singz_uikit::song_output_panel(singz_uikit::SongOutputCopy{
            title:crate::i18n::t("player.volume.title"),saved:crate::i18n::t("player.volume.saved"),
            per_song:crate::i18n::t("player.volume.perSong"),peak:crate::i18n::t("player.volume.peak"),caption:crate::i18n::t("player.volume.caption")
        },label.trim_end_matches(" dB").to_owned(),self.output_meter.held,mute,unity,self.probe("transport-output-slider",fader),clip)
            .on_mouse_down_out(cx.listener(|s,event:&MouseDownEvent,_,cx|{
                if !s.output_trigger.get().is_some_and(|b|b.contains(&event.position)){s.output_open=false;cx.notify();}
            }));
        div().relative().flex_shrink_0()
            .child(self.probe("transport-output",self.footer_control("transport-output",singz_uikit::song_output_trigger_meter("transport-output",label,compact,self.volume==0.,self.output_open,self.output_meter.held,self.output_meter.clipped),cx)
                .tooltip(move|w,cx|gpui_kit::component::tooltip::Tooltip::new(trigger_hint.clone()).build(w,cx))
                )
                .relative().child(canvas(move|b,_,_|{trigger.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0()))
            .when(self.output_open,|d|d.child(deferred(panel.absolute().bottom_full().mb(px(12.)).left(px(-8.))).with_priority(120)))
    }

}
impl Render for Transport {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "ui-tests")]
        self.bounds.borrow_mut().clear();
        self.reconcile_focus(window, cx);
        // Escape/outside dismissal unmounts the popup's native controls. Keep
        // their old handle from stranding key dispatch outside the live tree.
        if !self.output_open && (self.output_focus.is_focused(window)
            || self.output_control_focus.iter().any(|focus|focus.is_focused(window))) {
            self.control_focus["transport-output"].focus(window,cx);
            self.output_focus_pending=false;
            cx.notify();
        }
        self.footer_order.borrow_mut().clear();self.split_order.borrow_mut().clear();self.control_bounds.borrow_mut().clear();
        let focus_split=self.split_focus_pending&&self.split_open;
        if focus_split{self.split_focus_pending=false;self.split_scope.focus(window,cx);}
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
        let view=div()
            .track_focus(&self.footer_scope)
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
                        self.probe("transport-restart", singz_uikit::audio_control(self.footer_control("transport-restart",round_button("transport-restart", false),cx),self.audio_available)
                            .child(Self::icon("restart", 13.))
                            ),
                    )
                    .child(
                        self.probe("transport-play", singz_uikit::audio_control(self.footer_control("transport-play",play_button("transport-play", self.playing),cx),self.audio_available)
                            .child(
                                Self::icon(if self.playing { "pause" } else { "play" }, 16.)
                                    .ml(px(if self.playing { 0. } else { 1. })),
                            )
                            ),
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
                        singz_uikit::audio_control(self.footer_control("transport-loop",round_button("transport-loop", self.looping),cx),self.audio_available).when(true,|d|self.guides.track_box(d,"loop",[1.;4]))
                            .child(Self::icon("loop", 14.))
                            ,
                    )
                    .child(self.output(compact, cx))
                    .child(
                        singz_uikit::audio_control(self.footer_control("transport-met",metronome_button("transport-met", self.met_enabled),cx),self.audio_available).when(true,|d|self.guides.track_box(d,"metronome",[1.;4]))
                            .child(
                                div()
                                    .size(px(14.))
                                    .flex_shrink_0()
                                    .child(colored_icon(
                                        TransportIcon::Metronome,
                                        if self.met_enabled { ACCENT } else { DIM },
                                    )),
                            )
                            ,
                    )
                    .child(
                        singz_uikit::audio_control(self.footer_control("transport-carry",singz_uikit::carry_line_trigger("transport-carry", self.carry_enabled, self.carry_ducking),cx),self.audio_available)
                            .when(true,|d|self.guides.track_box(d,"carry",[1.;4]))
                            .child(if self.carry_enabled {div().size(px(14.)).flex_shrink_0().child(colored_icon(TransportIcon::CarryLine,if self.carry_ducking {singz_uikit::tokens::BG}else{ACCENT}))} else {Self::icon("transport-carry", 14.)})
                            ,
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
                            .child(self.footer_control("transport-transpose-down",transport_chip("transport-transpose-down", "−"),cx))
                            .child(
                                self.footer_control("transport-transpose-reset",transport_badge("transport-transpose-reset",
                                    if transpose > 0 {
                                        format!("+{transpose}")
                                    } else {
                                        transpose.to_string()
                                    },
                                    "st",
                                    transpose != 0,
                                ),cx)
                                .cursor_pointer()
                                ,
                            )
                            .child(self.footer_control("transport-transpose-up",transport_chip("transport-transpose-up", "+"),cx)),
                    )
                    .child(
                        div()
                            .flex()
                            .items_center()
                            .gap(px(5.))
                            .child(self.footer_control("transport-tempo-down",transport_chip("transport-tempo-down", "−"),cx))
                            .child(
                                self.footer_control("transport-tempo-reset",transport_badge("transport-tempo-reset",
                                    format!("{}", (tempo * 100.).round() as u32),
                                    "%",
                                    (tempo - 1.).abs() > 0.001,
                                ),cx)
                                .cursor_pointer()
                                ,
                            )
                            .child(
                                self.footer_control("transport-tempo-up",transport_chip("transport-tempo-up", "+"),cx),
                            )
                            .child(self.bpm_step("transport-bpm-down","−",-1.,cx))
                            .child(self.bpm_field(window,cx))
                            .child(self.bpm_step("transport-bpm-up","+",1.,cx)),
                    )
                    .when_some(self.progress.clone(), |d, progress| d.child(
                        self.probe("split-progress", singz_uikit::split_progress(progress.label, progress.percent, self.progress_phase()).id("split-progress")
                            .when(progress.cancellable, |pill| pill.child(self.probe("split-cancel", self.footer_control("split-cancel",singz_uikit::split_cancel("split-cancel"),cx)))))
                    ))
                    .when(self.progress.is_none(), |d| d
                    .when(self.split, |d| d.child(
                        self.probe("transport-karaoke", singz_uikit::audio_control(self.footer_control("transport-karaoke",karaoke_pill("transport-karaoke", "", self.karaoke),cx),self.audio_available).when(true,|d|self.guides.track_box(d,"karaoke",[1.;4]))
                            .child(Self::icon("transport-mic", 13.))
                            .child(tracked_label(crate::i18n::t("player.transport.karaoke"), 0.01))
                            ),
                    ))
                    .child(
                        div()
                            .relative()
                            .child(self.probe("transport-split",singz_uikit::audio_control(self.footer_control("transport-split",split_pill("transport-split", crate::i18n::t("player.split.button")),cx),self.audio_available).when(true,|d|self.guides.track_box(d,"split",[1.;4]))
                                    .child(Self::icon("transport-chevron", 8.))
                                    ))
                            .when(self.split_open, |v| {
                                v.child(deferred(singz_uikit::transport_popover().track_focus(&self.split_scope).key_context("SingZTransportSplit")
                                    .on_action(cx.listener(|s,_:&NextSplitFocus,w,cx|{s.move_split_focus(false,None,w,cx);w.prevent_default();cx.stop_propagation();}))
                                    .on_action(cx.listener(|s,_:&PreviousSplitFocus,w,cx|{s.move_split_focus(true,None,w,cx);w.prevent_default();cx.stop_propagation();}))
                                    .capture_key_down(cx.listener(|s,event:&KeyDownEvent,w,cx|s.split_key(event,w,cx)))
                                    .on_key_up(|_,_,cx|cx.stop_propagation())
                                    .on_mouse_down_out(cx.listener(|s,event:&MouseDownEvent,_,cx|{if !s.split_trigger.get().is_some_and(|b|b.contains(&event.position)){s.split_open=false;cx.notify();}})).absolute().bottom_full().right_0().mb(px(12.)).w(px(320.))
                                    .child(div().mb(px(10.)).text_size(px(13.)).font_family(singz_uikit::tokens::DISPLAY_700).child(if self.split{crate::i18n::t("player.split.optionsTitle")}else{crate::i18n::t("player.split.title")}))
                                    .when(self.split,|d|d
                                        .child(self.probe("split-vocals",self.split_control("split-vocals",singz_uikit::split_action("split-vocals",crate::i18n::t("player.split.separateBacking"),self.can_backing),cx)))
                                        .child(self.probe("split-stems",self.split_control("split-stems",singz_uikit::split_action("split-stems",crate::i18n::t("player.split.resplitStems"),self.can_resplit),cx))))
                                    .when(!self.split,|d|d
                                        .child(div().text_size(px(13.)).line_height(px(19.5)).text_color(rgb(DIM)).mb(px(14.)).child(crate::i18n::t("player.split.explain")))
                                        .child(div().text_size(px(12.)).line_height(px(18.)).text_color(rgb(DIM)).mt(px(8.)).mb(px(16.)).child(crate::i18n::t("player.split.hint")))
                                        .child(self.probe("split-combined",self.split_control("split-combined",singz_uikit::pill("split-combined",crate::i18n::t("player.split.button"),true),cx)))))
                                    .with_priority(120))
                            }),
                    )
                    .when(self.split && self.can_reveal_stems, |d| d.child(
                        self.probe("transport-stem-files", singz_uikit::audio_control(self.footer_control("transport-stem-files",ghost_pill("transport-stem-files", crate::i18n::t("player.transport.stemFiles")),cx),self.audio_available)),
                    )),                    )
            );
        // Source SplitMenu focuses its first enabled action on opening.
        // Choose it after this render has registered the actual menu items.
        if focus_split {
            if let Some(id)=self.split_order.borrow().first() {
                self.control_focus[id].focus(window,cx);
            }
        }
        if let Some(id)=self.focused_control(window){
            let menu=matches!(id.as_str(),"split-vocals"|"split-stems"|"split-combined");
            let valid=if menu{self.split_open&&self.split_order.borrow().contains(&id.as_str())}else{self.footer_order.borrow().contains(&id.as_str())};
            if !valid {
                if menu&&self.split_open{self.split_scope.focus(window,cx);}
                else if menu&&self.control_enabled("transport-split"){self.control_focus["transport-split"].focus(window,cx);}
                else{self.footer_scope.focus(window,cx);self.focus_player_pending=true;}
                cx.notify();
            }
        }
        if !self.split_open&&self.split_scope.is_focused(window){
            if self.control_enabled("transport-split"){self.control_focus["transport-split"].focus(window,cx);}
            else{self.footer_scope.focus(window,cx);self.focus_player_pending=true;}
            cx.notify();
        }
        view
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

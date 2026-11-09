//! Settings composition mirrors SettingsModal.tsx; native routes are host-owned.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DANGER, DIM, FAINT, LINE, LINE_STRONG, PANEL, PANEL_DEEP, TEXT};
use singz_uikit::{
    checkbox, disabled_monitor_pill, ghost_pill, modal_card, monitor_badge, nav_tab,
    production_scrollbar, range_slider, scrolling_select_popup, select_field, select_option,
    select_popup,
};

pub enum SettingsEvent {
    Close,
    QuickStart,
    Output(String),
    InputPrefs(crate::microphone::Prefs),
    EnableMicrophone,
    Monitor,
}
impl EventEmitter<SettingsEvent> for SettingsScreen {}

pub struct SettingsScreen {
    #[cfg(feature = "ui-tests")]
    inventory_revision: u64,
    #[cfg(feature = "ui-tests")]
    field_bounds:
        std::rc::Rc<std::cell::RefCell<std::collections::HashMap<&'static str, Bounds<Pixels>>>>,
    #[cfg(feature = "ui-tests")]
    option_bounds: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<(&'static str, usize), Bounds<Pixels>>>>,
    #[cfg(feature = "ui-tests")]
    field_labels: std::rc::Rc<std::cell::RefCell<std::collections::HashMap<&'static str, String>>>,
    input_prefs: crate::microphone::Prefs,
    microphone: crate::microphone::View,
    input_pref_error: Option<String>,
    monitor_busy: bool,
    monitor_error: Option<String>,
    native: bool,
    inventory: Option<crate::audio_devices::Inventory>,
    output_uid: String,
    route_error: Option<String>,
    route_busy: bool,
    route_label: Option<String>,
    output: usize,
    input: usize,
    channel: usize,
    monitor_output: usize,
    output_channels: [usize; 2],
    native_playback: bool,
    headphones: bool,
    gain: f32,
    open_field: Option<&'static str>,
    review_fixture: bool,
    scroll: ScrollHandle,
    graph_scroll: ScrollHandle,
    #[cfg(feature = "ui-tests")]
    gain_bounds: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
}
const OUTPUTS: &[&str] = &["System default", "MacBook Pro speakers", "Studio interface"];
const INPUTS: &[&str] = &[
    "System default",
    "MacBook Pro microphone",
    "Studio interface · 2 ch",
];
const MONITOR_OUTPUTS: &[&str] = &["Choose playback device…", "Studio interface · 2 out · USB"];

/// A playback lane cannot be assigned to both sides of the monitor route.
fn monitor_channel_choice(mut current: [usize; 2], slot: usize, channel: usize) -> Option<[usize; 2]> {
    if slot >= current.len() || current[1 - slot] == channel {
        return None;
    }
    current[slot] = channel;
    Some(current)
}

impl SettingsScreen {
    pub fn new(_window: &mut Window, _cx: &mut Context<Self>) -> Self {
        Self {
            #[cfg(feature = "ui-tests")]
            inventory_revision: 0,
            #[cfg(feature = "ui-tests")]
            field_bounds: Default::default(),
            #[cfg(feature = "ui-tests")]
            option_bounds: Default::default(),
            #[cfg(feature = "ui-tests")]
            field_labels: Default::default(),
            input_prefs: Default::default(),
            microphone: Default::default(),
            input_pref_error: None,
            monitor_busy: false,
            monitor_error: None,
            native: !crate::integration::fixture_mode(),
            inventory: None,
            output_uid: String::new(),
            route_error: None,
            route_busy: false,
            route_label: None,
            output: 0,
            input: 0,
            channel: 0,
            monitor_output: 0,
            output_channels: [0, 1],
            native_playback: true,
            headphones: false,
            gain: -18.,
            open_field: None,
            review_fixture: false,
            scroll: ScrollHandle::new(),
            graph_scroll: ScrollHandle::new(),
            #[cfg(feature = "ui-tests")]
            gain_bounds: Default::default(),
        }
    }
    pub fn clear_input_pref_error(&mut self, cx: &mut Context<Self>) {
        self.input_pref_error = None;
        cx.notify();
    }
    pub fn input_pref_error(&mut self, error: String, cx: &mut Context<Self>) {
        self.input_pref_error = Some(error);
        cx.notify();
    }
    pub fn set_input_prefs(&mut self, prefs: crate::microphone::Prefs, cx: &mut Context<Self>) {
        self.channel = prefs.channel;
        self.gain = prefs.gain;
        self.headphones = prefs.headphones;
        self.output_channels = prefs.outputs;
        self.input_prefs = prefs;
        self.input_pref_error = None;
        cx.notify();
    }
    pub fn set_monitor_state(&mut self, busy: bool, error: Option<String>, cx: &mut Context<Self>) {
        if busy != self.monitor_busy
            || error
                .as_ref()
                .is_some_and(|e| self.monitor_error.as_ref() != Some(e))
        {
            if busy && !self.monitor_busy {
                self.monitor_error = None;
            }
            self.monitor_busy = busy;
            if error.is_some() {
                self.monitor_error = error;
            }
            cx.notify();
        }
    }
    pub fn monitor_route(&self) -> Result<(), String> {
        if cfg!(any(target_os = "windows", target_os = "linux")) {
            return Err(
                crate::i18n::t("settings.monitor.routePlatformUnavailable").into(),
            );
        }
        if !self.input_prefs.headphones {
            return Err("Connect wired headphones and confirm them below.".into());
        }
        let inventory = self
            .inventory
            .as_ref()
            .ok_or("Native device inventory is unavailable.")?;
        let uid = if self.input_prefs.input.is_empty() {
            &inventory.default_input
        } else {
            &self.input_prefs.input
        };
        let input = inventory
            .devices
            .iter()
            .find(|d| &d.uid == uid && d.inputs > self.input_prefs.channel)
            .ok_or("Selected microphone channel is unavailable.")?;
        let output = inventory
            .devices
            .iter()
            .find(|d| d.uid == self.input_prefs.monitor_output && d.outputs > 0)
            .ok_or("Choose a monitoring output device.")?;
        if input.uid != output.uid {
            return Err("Monitoring requires input and output on the same audio interface.".into());
        }
        if self.input_prefs.outputs[0] == self.input_prefs.outputs[1]
            || self
                .input_prefs
                .outputs
                .iter()
                .any(|c| *c >= output.outputs)
        {
            return Err("Choose two distinct available playback channels.".into());
        }
        Ok(())
    }
    pub fn set_microphone(&mut self, view: crate::microphone::View, cx: &mut Context<Self>) {
        self.microphone = view;
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn field_bounds(&self, id: &str) -> Option<Bounds<Pixels>> {
        self.field_bounds.borrow().get(id).copied()
    }
    #[cfg(feature = "ui-tests")]
    pub fn option_bounds(&self, id: &'static str, index: usize) -> Option<Bounds<Pixels>> {
        self.option_bounds.borrow().get(&(id, index)).copied()
    }
    #[cfg(feature = "ui-tests")]
    pub fn field_label(&self, id: &str) -> Option<String> {
        self.field_labels.borrow().get(id).cloned()
    }
    #[cfg(feature = "ui-tests")]
    pub fn input_preferences_snapshot(&self) -> (crate::microphone::Prefs, Option<String>) {
        (self.input_prefs.clone(), self.input_pref_error.clone())
    }
    #[cfg(feature = "ui-tests")]
    pub fn native_snapshot(
        &self,
    ) -> (
        Option<crate::audio_devices::Inventory>,
        String,
        bool,
        Option<String>,
    ) {
        (
            self.inventory.clone(),
            self.output_uid.clone(),
            self.route_busy,
            self.route_error.clone(),
        )
    }
    pub fn output_uid(&self) -> String { self.output_uid.clone() }
    pub fn route_applying(&mut self, cx: &mut Context<Self>) {
        self.route_busy = true;
        self.route_error = None;
        cx.notify();
    }
    pub fn route_failed(&mut self, error: String, cx: &mut Context<Self>) {
        self.route_error = Some(error);
        self.route_busy = false;
        cx.notify();
    }
    pub fn set_inventory(
        &mut self,
        result: Result<crate::audio_devices::Inventory, String>,
        cx: &mut Context<Self>,
    ) {
        #[cfg(feature = "ui-tests")]
        { self.inventory_revision += 1; }
        match result {
            Ok(inventory) => {
                if let Err(error) = inventory.output(&self.output_uid) {
                    self.route_error = Some(error.to_string());
                }
                self.inventory = Some(inventory)
            }
            Err(error) => self.route_error = Some(error),
        }
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn inventory_revision(&self) -> u64 { self.inventory_revision }
    pub fn confirm_route(&mut self, label: String, cx: &mut Context<Self>) {
        self.route_label = Some(label);
        cx.notify();
    }
    pub fn set_route(
        &mut self,
        uid: String,
        label: Option<String>,
        error: Option<String>,
        cx: &mut Context<Self>,
    ) {
        self.output_uid = uid;
        self.route_label = label.or_else(|| self.route_label.take());
        self.route_error = error;
        self.route_busy = false;
        cx.notify();
    }
    fn options(&self, id: &str, defaults: &[&str]) -> Vec<(String, String)> {
        if !self.native {
            return defaults
                .iter()
                .map(|s| (String::new(), s.to_string()))
                .collect();
        }
        let Some(inventory) = &self.inventory else {
            return vec![(String::new(), "Loading native devices…".into())];
        };
        let devices = match id {
            "settings-output" | "settings-monitor-output" => Some(false),
            "settings-input" => Some(true),
            _ => None,
        };
        if let Some(input) = devices {
            let mut options = vec![(
                String::new(),
                if id == "settings-monitor-output" {
                    "Choose playback device…".into()
                } else {
                    "System default".into()
                },
            )];
            options.extend(
                inventory
                    .devices
                    .iter()
                    .filter(|d| if input { d.inputs > 0 } else { d.outputs > 0 })
                    .map(|d| {
                        (
                            d.uid.clone(),
                            if input {
                                format!("{} · {} ch", d.label, d.inputs)
                            } else {
                                d.label.clone()
                            },
                        )
                    }),
            );
            if id == "settings-input"
                && !self.input_prefs.input.is_empty()
                && !options
                    .iter()
                    .any(|(uid, _)| uid == &self.input_prefs.input)
            {
                options.push((
                    self.input_prefs.input.clone(),
                    "Saved microphone · unavailable".into(),
                ));
            }
            if id == "settings-output"
                && !self.output_uid.is_empty()
                && !options.iter().any(|(uid, _)| uid == &self.output_uid)
            {
                options.push((self.output_uid.clone(), "Saved output · unavailable".into()));
            }
            if id == "settings-monitor-output"
                && !self.input_prefs.monitor_output.is_empty()
                && !options
                    .iter()
                    .any(|(uid, _)| uid == &self.input_prefs.monitor_output)
            {
                options.push((
                    self.input_prefs.monitor_output.clone(),
                    "Saved monitoring output · unavailable".into(),
                ));
            }
            return options;
        }
        let channels = if id == "settings-channel" {
            self.input_channels()
        } else {
            let outputs = self.options("settings-monitor-output", MONITOR_OUTPUTS);
            outputs
                .get(
                    outputs
                        .iter()
                        .position(|(uid, _)| uid == &self.input_prefs.monitor_output)
                        .unwrap_or(0),
                )
                .and_then(|(uid, _)| inventory.output(uid).ok())
                .map_or(0, |d| d.outputs)
        };
        (0..channels)
            .map(|i| {
                (
                    i.to_string(),
                    format!(
                        "{} {}",
                        if id == "settings-channel" {
                            "IN"
                        } else {
                            "OUT"
                        },
                        i + 1
                    ),
                )
            })
            .collect()
    }
    fn input_channels(&self) -> usize {
        if !self.native {
            return if self.input == 2 { 2 } else { 1 };
        }
        if self.microphone.fixture && self.microphone.phase == crate::microphone::Phase::Live {
            return self.microphone.channels.max(1);
        }
        let Some(inventory) = &self.inventory else {
            return 1;
        };
        let uid = if self.input_prefs.input.is_empty() {
            &inventory.default_input
        } else {
            &self.input_prefs.input
        };
        inventory
            .devices
            .iter()
            .find(|d| &d.uid == uid)
            .map_or(1, |d| d.inputs.max(1))
    }
    /// The capture runner supplies the same sample inventory and startup state to both apps.
    /// This changes display metadata only; it never starts hardware or an asynchronous job.
    #[cfg(feature = "ui-tests")]
    pub fn set_review_fixture(&mut self, enabled: bool) {
        self.review_fixture = enabled;
    }
    #[cfg(feature = "ui-tests")]
    pub fn smoke_snapshot(&self) -> (usize, bool, f32, f32, Option<&'static str>) {
        (
            self.output,
            self.native_playback,
            self.gain,
            f32::from(self.scroll.offset().y),
            self.open_field,
        )
    }
    #[cfg(feature = "ui-tests")]
    pub fn smoke_gain_bounds(&self) -> Option<Bounds<Pixels>> {
        self.gain_bounds.get()
    }
    /// A production modal mounts fresh when reopened: reset transient scroll/menu state,
    /// retaining the host-owned audio draft preferences.
    pub fn on_open(&mut self, cx: &mut Context<Self>) {
        if self.native {
            self.headphones = false;
            self.input_prefs.headphones = false;
        }
        self.open_field = None;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.graph_scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        if self.open_field.take().is_some() {
            cx.notify();
            true
        } else {
            false
        }
    }
    fn label(text: impl Into<SharedString>) -> Div {
        div()
            .mt(px(14.))
            .mb(px(6.))
            .text_size(px(12.))
            .line_height(px(14.))
            .text_color(rgb(DIM))
            .child(text.into())
    }
    fn hint(text: impl Into<SharedString>) -> Div {
        div()
            .mt(px(8.))
            .text_size(px(13.5))
            .line_height(px(22.275))
            .text_color(rgb(DIM))
            .child(text.into())
    }
    fn mono(text: impl Into<SharedString>) -> Div {
        div()
            .font_family("SingZ Mono 400")
            .text_size(px(10.))
            .line_height(px(14.))
            .text_color(rgb(FAINT))
            .child(text.into())
    }
    fn strip(padding: f32) -> Div {
        div()
            .mt(px(14.))
            .p(px(padding))
            .rounded(px(11.))
            .border_1()
            .border_color(rgba(LINE))
            .bg(rgb(PANEL_DEEP).alpha(if padding == 12. { 0.84 } else { 0.88 }))
    }
    fn field(
        &self,
        id: &'static str,
        options: &'static [&'static str],
        selected: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let options = self.options(id, options);
        let selected = if self.native && id == "settings-input" {
            options
                .iter()
                .position(|(uid, _)| uid == &self.input_prefs.input)
                .unwrap_or(0)
        } else if self.native && id == "settings-monitor-output" {
            options
                .iter()
                .position(|(uid, _)| uid == &self.input_prefs.monitor_output)
                .unwrap_or(0)
        } else if self.native && id == "settings-output" {
            options
                .iter()
                .position(|(uid, _)| uid == &self.output_uid)
                .unwrap_or(0)
        } else if self.native {
            // Do not paint the last available lane as if an unavailable saved
            // channel had already been applied. Only an explicit choice edits it.
            selected
        } else {
            selected.min(options.len().saturating_sub(1))
        };
        let expanded = self.open_field == Some(id);
        let popup = if self.native && options.len() > 8 {
            scrolling_select_popup(format!("{id}-popup"))
        } else {
            select_popup().id(format!("{id}-popup"))
        };
        #[cfg(feature = "ui-tests")]
        let bounds = self.field_bounds.clone();
        let label = options.get(selected).map(|(_, label)| label.clone()).unwrap_or_else(|| {
            if options.is_empty() {
                "No channels".into()
            } else {
                "Saved channel · unavailable".into()
            }
        });
        #[cfg(feature = "ui-tests")]
        self.field_labels.borrow_mut().insert(id, label.clone());
        let field = div()
            .relative()
            .w_full()
            .child(
                select_field(id, label)
                .on_click(cx.listener(move |this, _, _, cx| {
                    if this.native && id == "settings-output" && this.route_busy {
                        return;
                    }
                    this.open_field = if this.open_field == Some(id) {
                        None
                    } else {
                        Some(id)
                    };
                    cx.notify();
                })),
            )
            .when(expanded, |v| {
                v.child(
                    deferred(popup.children(options.into_iter().enumerate().map(
                        |(index, (uid, option))| {
                            let slot = match id {
                                "settings-output-left" => Some(0),
                                "settings-output-right" => Some(1),
                                _ => None,
                            };
                            let disabled = slot.is_some_and(|slot|
                                monitor_channel_choice(self.output_channels, slot, index).is_none());
                            let option = select_option((id, index), option, index == selected)
                                .flex_none()
                                .when(disabled, |option| option.opacity(0.45).cursor_default())
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if disabled {
                                        cx.stop_propagation();
                                        return;
                                    }
                                    match id {
                                        "settings-output" => {
                                            this.output = index;
                                            if this.native {
                                                this.route_busy = true;
                                                this.route_error = None;
                                                cx.emit(SettingsEvent::Output(uid.clone()));
                                            }
                                        }
                                        "settings-input" => {
                                            this.input = index;
                                            this.channel = 0;
                                            if this.native {
                                                this.input_prefs.input = uid.clone();
                                                this.input_prefs.channel = 0;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    this.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-channel" => {
                                            this.channel = index;
                                            if this.native {
                                                this.input_prefs.channel = index;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    this.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-monitor-output" => {
                                            let changed = if this.native {
                                                this.input_prefs.monitor_output != uid
                                            } else {
                                                this.monitor_output != index
                                            };
                                            this.monitor_output = index;
                                            if changed {
                                                this.output_channels = [0, 1];
                                            }
                                            if this.native {
                                                this.input_prefs.monitor_output = uid.clone();
                                                if changed {
                                                    this.input_prefs.outputs = [0, 1];
                                                }
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    this.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-output-left" | "settings-output-right" => {
                                            let slot = if id == "settings-output-left" { 0 } else { 1 };
                                            let Some(channels) = monitor_channel_choice(this.output_channels, slot, index) else {
                                                return;
                                            };
                                            this.output_channels = channels;
                                            if this.native {
                                                this.input_prefs.outputs = channels;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    this.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        _ => {}
                                    }
                                    this.open_field = None;
                                    cx.notify();
                                }));
                            #[cfg(feature = "ui-tests")]
                            let option = {
                                let bounds = self.option_bounds.clone();
                                option.relative().child(canvas(move |b, _, _| {
                                    bounds.borrow_mut().insert((id, index), b);
                                    b
                                }, |_, _, _, _| {}).absolute().inset_0())
                            };
                            option
                        },
                    )))
                    .with_priority(100),
                )
            });
        #[cfg(feature = "ui-tests")]
        let field = field.child(
            canvas(
                move |b, _, _| {
                    bounds.borrow_mut().insert(id, b);
                    b
                },
                |_, _, _, _| {},
            )
            .absolute()
            .inset_0(),
        );
        field
    }
    fn check_row(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        on: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let label:SharedString=label.into();
        div()
            .id(format!("{id}-row"))
            .mt(px(10.))
            .flex()
            .items_center()
            .gap(px(8.))
            .text_color(rgb(DIM))
            .text_size(px(12.))
            .line_height(px(15.))
            .cursor_pointer()
            .on_click(cx.listener(move |this, _, _, cx| {
                if this.native && id == "settings-native" {
                    return;
                }
                match id {
                    "settings-native" => this.native_playback = !this.native_playback,
                    _ => this.headphones = !this.headphones,
                }
                if this.native && id == "settings-headphones" {
                    this.input_prefs.headphones = this.headphones;
                    cx.emit(SettingsEvent::InputPrefs(this.input_prefs.clone()));
                }
                cx.notify();
            }))
            .child(
                checkbox(id, on).on_click(cx.listener(move |this, _, _, cx| {
                    if this.native && id == "settings-native" {
                        cx.stop_propagation();
                        return;
                    }
                    match id {
                        "settings-native" => this.native_playback = !this.native_playback,
                        _ => this.headphones = !this.headphones,
                    }
                    if this.native && id == "settings-headphones" {
                        this.input_prefs.headphones = this.headphones;
                        cx.emit(SettingsEvent::InputPrefs(this.input_prefs.clone()));
                    }
                    cx.notify();
                })),
            )
            .child(label)
            .when(cfg!(feature = "ui-tests"), |row| {
                #[cfg(feature = "ui-tests")]
                let row = {
                    let probe = self.field_bounds.clone();
                    row.relative().child(
                        canvas(
                            move |bounds, _, _| {
                                probe.borrow_mut().insert(id, bounds);
                                bounds
                            },
                            |_, _, _, _| {},
                        )
                        .absolute()
                        .inset_0(),
                    )
                };
                row
            })
    }
    #[cfg(feature = "ui-tests")]
    pub fn monitor_error(&self) -> Option<String> {
        self.monitor_error.clone()
    }
    fn mic(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let failed = self.native
            && matches!(
                self.microphone.phase,
                crate::microphone::Phase::Error | crate::microphone::Phase::Permission
            );
        let stereo = self.input_channels() > 1;
        let live = self.native && self.microphone.fresh();
        let db = if live && self.microphone.rms > 0. {
            20. * self.microphone.rms.log10()
        } else {
            -72.
        };
        let peak = if live && self.microphone.peak > 0. {
            20. * self.microphone.peak.log10()
        } else {
            -72.
        };
        let level = ((db + 72.) / 72.).clamp(0., 1.);
        let peak_level = ((peak + 72.) / 72.).clamp(0., 1.);
        let status = if self.native {
            match self.microphone.phase {
                crate::microphone::Phase::Live | crate::microphone::Phase::Monitoring => {
                    if live {
                        format!("{db:.1} dBFS")
                    } else {
                        "Waiting for microphone…".into()
                    }
                }
                crate::microphone::Phase::Starting | crate::microphone::Phase::Stopping => {
                    crate::i18n::t("settings.mic.startingPreview").into()
                }
                crate::microphone::Phase::Permission => "Microphone permission required".into(),
                crate::microphone::Phase::Error => "Microphone unavailable".into(),
                _ => "Microphone is off".into(),
            }
        } else if self.review_fixture {
            crate::i18n::t("settings.mic.startingPreview").into()
        } else {
            "Microphone capture unavailable".into()
        };
        Self::strip(12.)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_center()
                    .child(Self::label(crate::i18n::t("settings.mic.label")).mt(px(0.)).mb(px(7.)))
                    .when(
                        self.input > 0
                            || (self.native
                                && (!self.input_prefs.input.is_empty() || self.microphone.fresh())),
                        |v| {
                            v.child(
                                Self::mono(format!(
                                    "IN {}/{}",
                                    self.channel + 1,
                                    self.input_channels()
                                ))
                                .text_color(rgb(ACCENT)),
                            )
                        },
                    ),
            )
            .child(self.field("settings-input", INPUTS, self.input, cx))
            .child(
                div()
                    .mt(px(9.))
                    .min_h(px(32.))
                    .flex()
                    .items_center()
                    .justify_between()
                    .text_size(px(12.))
                    .text_color(rgb(if stereo { DIM } else { FAINT }))
                    .child(if stereo {
                        crate::i18n::t("settings.mic.channelLabel")
                    } else {
                        crate::i18n::t("settings.mic.monoInput")
                    })
                    .when(stereo, |v| {
                        v.child(div().w(px(142.)).child(self.field(
                            "settings-channel",
                            &["IN 1", "IN 2"],
                            self.channel,
                            cx,
                        )))
                    }),
            )
            .child(
                div()
                    .mt(px(13.))
                    .flex()
                    .justify_between()
                    .text_color(rgb(DIM))
                    .text_size(px(11.))
                    .line_height(px(13.))
                    .child(crate::i18n::t("settings.mic.levelLabel"))
                    .child(
                        Self::mono(status)
                            .line_height(px(12.))
                            .text_color(rgb(if failed { DANGER } else { FAINT })),
                    ),
            )
            .child(
                div()
                    .relative()
                    .mt(px(7.))
                    .h(px(22.))
                    .rounded(px(5.))
                    .overflow_hidden()
                    .bg(rgb(0x0c0b09))
                    .when(cfg!(feature = "ui-tests"), |meter| {
                        #[cfg(feature = "ui-tests")]
                        let meter = {
                            let probe = self.field_bounds.clone();
                            meter.child(
                                canvas(
                                    move |bounds, _, _| {
                                        probe.borrow_mut().insert("settings-meter", bounds);
                                        bounds
                                    },
                                    |_, _, _, _| {},
                                )
                                .absolute()
                                .inset_0(),
                            )
                        };
                        meter
                    })
                    .border_1()
                    .border_color(rgba(LINE_STRONG))
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(relative(0.6666))
                            .right(relative(0.1667))
                            .bg(rgb(0xffb44b).alpha(0.06)),
                    )
                    .child(
                        div()
                            .absolute()
                            .top_0()
                            .bottom_0()
                            .left(relative(0.8333))
                            .right_0()
                            .bg(rgb(0xff624c).alpha(0.08)),
                    )
                    .when(self.native, |meter| {
                        meter.child(
                            div()
                                .absolute()
                                .left_0()
                                .top_0()
                                .bottom_0()
                                .w(relative(level))
                                .bg(rgb(ACCENT).alpha(0.7)),
                        )
                    })
                    .children([(0.3333, "−48"), (0.6666, "−24"), (0.8333, "−12")].map(
                        |(x, label)| {
                            Self::mono(label)
                                .absolute()
                                .top(px(2.))
                                .bottom(px(2.))
                                .left(relative(x))
                                .pl(px(2.))
                                .text_size(px(8.))
                                .line_height(px(18.))
                                .text_color(rgba(0xf3e6cd61))
                                .border_l_1()
                                .border_color(rgba(0xffffff14))
                        },
                    ))
                    .child(
                        div()
                            .absolute()
                            .when(!self.native, |peak| peak.left_0())
                            .when(self.native, |peak| peak.left(relative(peak_level)))
                            .top(px(3.))
                            .bottom(px(3.))
                            .w(px(1.))
                            .bg(rgb(0xf6dca9).alpha(0.9)),
                    )
                    .child(
                        Self::mono("0")
                            .text_color(rgba(0xf3e6cd61))
                            .absolute()
                            .top(px(2.))
                            .right(px(2.))
                            .text_size(px(8.))
                            .line_height(px(18.)),
                    ),
            )
            .child(
                Self::mono(if self.native {
                    self.microphone.error.clone().unwrap_or_else(|| {
                        if self.microphone.label.is_empty() {
                            "Microphone preview is off.".into()
                        } else {
                            format!(
                                "{} · IN {}/{}{}",
                                self.microphone.label,
                                self.microphone.channel + 1,
                                self.microphone.channels,
                                if self.microphone.fixture {
                                    " · test fixture"
                                } else {
                                    ""
                                }
                            )
                        }
                    })
                } else if self.review_fixture {
                    crate::i18n::t("settings.mic.previewOpening").into()
                } else {
                    "Native microphone capture unavailable: desktop audio service is not connected."
                        .into()
                })
                .mt(px(6.))
                .min_h(px(16.)),
            )
            .when(
                self.native
                    && matches!(
                        self.microphone.phase,
                        crate::microphone::Phase::Permission | crate::microphone::Phase::Error
                    ),
                |view| {
                    view.child(
                        ghost_pill(
                            "settings-enable-microphone",
                            if self.microphone.phase == crate::microphone::Phase::Permission {
                                "Enable microphone"
                            } else {
                                "Retry microphone"
                            },
                        )
                        .mt(px(8.))
                        .on_click(
                            cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::EnableMicrophone)),
                        ),
                    )
                },
            )
    }
    fn graph(&self) -> impl IntoElement + use<> {
        let vertical_scroll = self.scroll.clone();
        let horizontal_scroll = self.graph_scroll.clone();
        let db = |rms: f32| {
            if rms > 0. && self.microphone.fresh() {
                format!("{:.1} dBFS", 20. * rms.log10())
            } else {
                "−∞ dBFS".into()
            }
        };
        let pre = if self.native {
            db(self.microphone.rms)
        } else {
            "−∞ dBFS".into()
        };
        let post = if self.native {
            db(self.microphone.post_rms)
        } else {
            "−∞ dBFS".into()
        };
        let active = self.native && self.microphone.phase == crate::microphone::Phase::Monitoring;
        let input_note = if active {
            self.microphone.label.as_str()
        } else {
            "Choose an input"
        };
        let route_note = if self.native {
            format!(
                "IN {} to OUT {}·{}",
                self.input_prefs.channel + 1,
                self.input_prefs.outputs[0] + 1,
                self.input_prefs.outputs[1] + 1
            )
        } else {
            "IN — to OUT —".into()
        };
        let output_note = if active {
            "Native duplex output"
        } else {
            "Choose an output"
        };
        let buffer = if active && self.microphone.buffer_frames > 0 {
            format!(
                "{} frames · {:.1} ms",
                self.microphone.buffer_frames,
                self.microphone.buffer_frames as f32 * 1000. / self.microphone.sample_rate.max(1.)
            )
        } else {
            "Buffer pending".into()
        };
        let nodes = [
            (
                "DEVICE",
                "Input",
                if self.native || self.input > 0 {
                    format!("IN {}", self.channel + 1)
                } else {
                    "IN —".into()
                },
                input_note,
            ),
            ("ANALYZER", "Pre", "RMS".into(), pre.as_str()),
            (
                "PROCESSOR",
                "Gain",
                format!("{}", self.gain as i32),
                "dB · ramped",
            ),
            (
                "ROUTER",
                "Map",
                if (self.native && !self.input_prefs.monitor_output.is_empty())
                    || (self.input > 0 && self.monitor_output > 0)
                {
                    "1→2".into()
                } else {
                    "— → —".into()
                },
                route_note.as_str(),
            ),
            (
                "PROCESSOR",
                "Limit",
                "−1 dB".into(),
                "Output ceiling · dBFS",
            ),
            ("ANALYZER", "Post", "RMS".into(), post.as_str()),
            (
                "DEVICE",
                "Output",
                if self.native && !self.input_prefs.monitor_output.is_empty() {
                    format!(
                        "OUT {}·{}",
                        self.input_prefs.outputs[0] + 1,
                        self.input_prefs.outputs[1] + 1
                    )
                } else if self.monitor_output > 0 {
                    "OUT 1·2".into()
                } else {
                    "OUT —".into()
                },
                output_note,
            ),
        ];
        div()
            .mt(px(12.))
            .rounded(px(9.))
            .overflow_hidden()
            .border_1()
            .border_color(rgba(LINE_STRONG))
            .bg(rgb(0x110f0c))
            .child(
                div()
                    .min_h(px(56.))
                    .px(px(10.))
                    .py(px(8.))
                    .border_b_1()
                    .border_color(rgba(LINE))
                    .child(
                        div()
                            .flex()
                            .justify_between()
                            .items_center()
                            .child(
                                div()
                                    .child(
                                        div()
                                            .font_family("SingZ Mono 400")
                                            .text_color(rgb(FAINT))
                                            .text_size(px(7.))
                                            .line_height(px(7.))
                                            .child(singz_uikit::tracked_label(
                                                "RUNTIME GRAPH",
                                                0.11,
                                            )),
                                    )
                                    .child(
                                        div()
                                            .mt(px(3.))
                                            .font_family("SingZ Display 700")
                                            .text_size(px(11.))
                                            .line_height(px(13.))
                                            .child(singz_uikit::tracked_label(
                                                "Native monitor chain",
                                                0.01,
                                            )),
                                    ),
                            )
                            .child(
                                Self::mono(
                                    if self.native
                                        && self.microphone.phase
                                            == crate::microphone::Phase::Monitoring
                                    {
                                        "●  Active"
                                    } else {
                                        "●  Route blocked"
                                    },
                                )
                                .text_size(px(8.)),
                            ),
                    )
                    .child(div().mt(px(12.)).flex().gap(px(4.)).children(
                        ["Float32 native path", buffer.as_str(), "32-bit float"].map(|text| {
                            div()
                                .font_family("SingZ Mono 400")
                                .text_color(rgb(FAINT))
                                .child(singz_uikit::tracked_label(text, 0.02))
                                .text_size(px(7.))
                                .line_height(px(7.))
                                .px(px(5.))
                                .py(px(3.))
                                .border_1()
                                .border_color(rgba(LINE))
                                .rounded(px(3.))
                                .bg(rgb(PANEL))
                        }),
                    )),
            )
            .child(
                div()
                    .id("settings-graph-scroll")
                    .overflow_x_scroll()
                    .restrict_scroll_to_axis()
                    .track_scroll(&self.graph_scroll)
                    .on_scroll(move |event, window, cx| {
                        let delta = event.delta.pixel_delta(window.line_height());
                        if delta.y.abs() > delta.x.abs() {
                            if event.modifiers.shift {
                                let offset = horizontal_scroll.offset();
                                horizontal_scroll.set_offset(point(offset.x + delta.y, offset.y));
                            } else {
                                let offset = vertical_scroll.offset();
                                vertical_scroll.set_offset(point(offset.x, offset.y + delta.y));
                            }
                            window.refresh();
                            cx.stop_propagation();
                        }
                    })
                    .p(px(12.))
                    .child(div().min_w(px(648.)).flex().gap(px(10.)).children(
                        nodes.into_iter().enumerate().map(
                            |(index, (kind, name, value, detail))| {
                                div()
                                    .relative()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .min_h(px(108.))
                                    .px(px(8.))
                                    .pt(px(10.))
                                    .pb(px(9.))
                                    .flex()
                                    .flex_col()
                                    .rounded(px(6.))
                                    .border_1()
                                    .border_color(rgba(LINE))
                                    .bg(rgb(PANEL))
                                    .child(
                                        div()
                                            .font_family("SingZ Mono 400")
                                            .text_color(rgb(FAINT))
                                            .text_size(px(7.))
                                            .line_height(px(7.))
                                            .child(singz_uikit::tracked_label(kind, 0.1)),
                                    )
                                    .child(
                                        div()
                                            .mt(px(5.))
                                            .text_size(px(10.))
                                            .line_height(px(11.5))
                                            .font_family("SingZ Display 700")
                                            .text_color(rgb(DIM))
                                            .child(name),
                                    )
                                    .child(
                                        Self::mono(value)
                                            .font_family("SingZ Mono 700")
                                            .mt(px(5.))
                                            .text_size(px(10.))
                                            .line_height(px(11.5))
                                            .text_color(rgb(TEXT)),
                                    )
                                    .child(
                                        Self::mono(detail)
                                            .mt_auto()
                                            .pt(px(7.))
                                            .text_size(px(7.))
                                            .line_height(px(9.1)),
                                    )
                                    .when(index < 6, |v| {
                                        v.child(
                                            div()
                                                .absolute()
                                                .left_full()
                                                .top(relative(0.5))
                                                .w(px(10.))
                                                .h(px(1.))
                                                .bg(rgba(LINE_STRONG)),
                                        )
                                    })
                            },
                        ),
                    )),
            )
    }
    fn monitor(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        let route_caption = if self.review_fixture {
            crate::i18n::t("settings.monitor.routePlatformUnavailable").into()
        } else {
            self.monitor_error
                .clone()
                .or_else(|| self.monitor_route().err())
                .unwrap_or_else(|| {
                    "Starting monitoring pauses song playback. Stop restores it paused.".into()
                })
        };
        let weak = cx.entity().downgrade();
        let gain_slider = range_slider(
            "settings-monitor-gain",
            self.gain,
            -60.,
            0.,
            move |value, _window, cx| {
                let _ = weak.update(cx, |this, cx| {
                    this.gain = value.round();
                    if this.native {
                        this.input_prefs.gain = this.gain;
                        cx.emit(SettingsEvent::InputPrefs(this.input_prefs.clone()));
                    }
                    cx.notify();
                });
            },
        )
        .flex_1()
        .min_w(px(100.));
        #[cfg(feature = "ui-tests")]
        let gain_slider = {
            let probe = self.gain_bounds.clone();
            gain_slider.child(
                canvas(
                    move |bounds, _, _| {
                        probe.set(Some(bounds));
                        bounds
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .inset_0(),
            )
        };
        Self::strip(14.)
            .child(
                div()
                    .flex()
                    .justify_between()
                    .items_start()
                    .gap(px(16.))
                    .child(
                        div()
                            .child(
                                div()
                                    .text_size(px(13.))
                                    .line_height(px(15.5))
                                    .font_family("SingZ Display 700")
                                    .child(
                                        singz_uikit::tracked_label(crate::i18n::t("settings.monitor.heading"), 0.01)
                                            .wrap(),
                                    ),
                            )
                            .child(
                                Self::hint(crate::i18n::t("settings.monitor.subheading"))
                                    .mt(px(3.))
                                    .text_size(px(11.))
                                    .line_height(px(13.))
                                    .text_color(rgb(FAINT)),
                            ),
                    )
                    .child(monitor_badge("EXPERIMENTAL")),
            )
            .child(Self::label(crate::i18n::t("settings.monitor.outputLabel")).mt(px(13.)))
            .child(self.field(
                "settings-monitor-output",
                MONITOR_OUTPUTS,
                self.monitor_output,
                cx,
            ))
            .when(
                if self.native {
                    self.input_channels() > 0
                } else {
                    self.input == 2
                },
                |v| {
                    v.child(
                        div()
                            .mt(px(12.))
                            .flex()
                            .gap(px(8.))
                            .child(
                                div()
                                    .flex_1()
                                    .p(px(8.))
                                    .rounded(px(8.))
                                    .border_1()
                                    .border_color(rgba(LINE))
                                    .bg(rgb(PANEL))
                                    .child(Self::mono("MIC CHANNEL").text_size(px(9.)))
                                    .child(
                                        Self::mono(format!("IN {}", self.channel + 1))
                                            .text_color(rgb(ACCENT))
                                            .line_height(px(28.)),
                                    ),
                            )
                            .when(
                                if self.native {
                                    !self.input_prefs.monitor_output.is_empty()
                                } else {
                                    self.monitor_output > 0
                                },
                                |v| {
                                    v.children(
                                        [
                                            (0, crate::i18n::t("settings.monitor.playbackLeft"), "settings-output-left"),
                                            (1, crate::i18n::t("settings.monitor.playbackRight"), "settings-output-right"),
                                        ]
                                        .map(
                                            |(slot, label, id)| {
                                                div()
                                                    .flex_1()
                                                    .min_w(px(0.))
                                                    .p(px(8.))
                                                    .rounded(px(8.))
                                                    .border_1()
                                                    .border_color(rgba(LINE))
                                                    .bg(rgb(PANEL))
                                                    .child(
                                                        Self::mono(label)
                                                            .text_size(px(9.))
                                                            .mb(px(5.)),
                                                    )
                                                    .child(self.field(
                                                        id,
                                                        &["OUT 1", "OUT 2"],
                                                        self.output_channels[slot],
                                                        cx,
                                                    ))
                                            },
                                        ),
                                    )
                                },
                            ),
                    )
                },
            )
            .child(self.graph())
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(10.))
                    .text_size(px(11.))
                    .line_height(px(13.))
                    .text_color(rgb(DIM))
                    .child(crate::i18n::t("settings.monitor.gainLabel"))
                    .child(gain_slider)
                    .child(
                        Self::mono(format!("{} dB", self.gain as i32))
                            .line_height(px(10.))
                            .w(px(56.))
                            .text_right()
                            .text_color(rgb(TEXT)),
                    ),
            )
            // .modal-card p wins specificity over .monitor-route-status.
            // Preserve its bottom margin; CSS collapses it with the next row's 10px margin.
            .child(
                Self::hint(route_caption)
                    .mt(px(10.))
                    .mb(px(14.))
                    .text_color(rgb(if self.review_fixture { DANGER } else { FAINT })),
            )
            .child(self.check_row(
                "settings-headphones",
                crate::i18n::t("settings.monitor.headphonesConfirmLabel"),
                self.headphones,
                cx,
            ))
            .child(
                div()
                    .mt(px(12.))
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .child({
                        let button = if self.native
                            && (self.monitor_busy || self.monitor_route().is_ok())
                        {
                            ghost_pill(
                                "settings-monitor-start",
                                if self.monitor_busy {
                                    crate::i18n::t("settings.monitor.stopButton")
                                } else {
                                    crate::i18n::t("settings.monitor.startButton")
                                },
                            )
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Monitor)))
                        } else {
                            disabled_monitor_pill("settings-monitor-start", crate::i18n::t("settings.monitor.startButton"))
                        };
                        #[cfg(feature = "ui-tests")]
                        let button = {
                            let probe = self.field_bounds.clone();
                            button.relative().child(
                                canvas(
                                    move |bounds, _, _| {
                                        probe.borrow_mut().insert("settings-monitor-start", bounds);
                                        bounds
                                    },
                                    |_, _, _, _| {},
                                )
                                .absolute()
                                .inset_0(),
                            )
                        };
                        button
                    })
                    .child(
                        Self::hint(if self.review_fixture {
                            crate::i18n::t("settings.monitorCoordinator.idle")
                        } else {
                            if self.monitor_busy {
                                if self.microphone.phase == crate::microphone::Phase::Monitoring {
                                    "Monitoring is active.".to_owned()
                                } else {
                                    "Switching native audio ownership…".to_owned()
                                }
                            } else {
                                crate::i18n::t("settings.monitorCoordinator.idle")
                            }
                        })
                        .mt(px(0.))
                        .mb(px(14.))
                        .text_color(rgb(FAINT)),
                    ),
            )
    }
    // CSS color-mix(in srgb, var(--danger) 52%, var(--line)).
    // The shared line token includes the browser's 8-bit alpha precision.
    fn recovery_border() -> Rgba {
        let danger = rgb(DANGER);
        let line = rgba(LINE);
        let line_weight = line.a * 0.48;
        let alpha = 0.52 + line_weight;
        Rgba {
            r: (danger.r * 0.52 + line.r * line_weight) / alpha,
            g: (danger.g * 0.52 + line.g * line_weight) / alpha,
            b: (danger.b * 0.52 + line.b * line_weight) / alpha,
            a: alpha,
        }
    }
    fn retry_route(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let control=ghost_pill("settings-retry",crate::i18n::t("settings.output.retryRoute"))
            .on_click(cx.listener(|this,_,_,cx| {
                if !this.route_busy {
                    this.route_busy=true;
                    cx.emit(SettingsEvent::Output(this.output_uid.clone()));
                    cx.notify();
                }
            }));
        #[cfg(feature="ui-tests")]
        {
            let bounds=self.field_bounds.clone();
            return control.relative().child(canvas(move |b,_,_| {
                bounds.borrow_mut().insert("settings-retry".into(),b); b
            },|_,_,_,_|{}).absolute().inset_0());
        }
        #[cfg(not(feature="ui-tests"))]
        control
    }
    fn audio(&self, cx: &mut Context<Self>) -> impl IntoElement + use<> {
        div().w_full().child(Self::label(crate::i18n::t("settings.output.label")).mt(px(2.)))
            .child(self.field("settings-output",OUTPUTS,self.output,cx))
            .when(!self.native,|view|view
                .child(div().mt(px(9.)).px(px(11.)).py(px(10.)).rounded(px(9.)).border_1().border_color(Self::recovery_border()).bg(Rgba { r:0.124706,g:0.080902,b:0.0617255,a:1. })
                .child(Self::hint(crate::i18n::t("settings.output.unconfirmedStatus")).mt(px(0.)).text_color(rgb(DANGER)))
                .child(div().mt(px(8.)).flex().items_center().gap(px(10.)).child(ghost_pill("settings-retry",crate::i18n::t("settings.output.retryRoute")).opacity(if self.review_fixture {1.}else{0.4}))))
                .child(self.check_row("settings-native",crate::i18n::t("settings.playback.useNativeLabel"),self.native_playback,cx))
                .child(Self::hint(crate::i18n::t("settings.playback.hint"))))
            .when(self.native,|view|view
                .when(self.route_error.is_some(),|view|view.child(div().mt(px(9.)).px(px(11.)).py(px(10.)).rounded(px(9.)).border_1().border_color(Self::recovery_border()).bg(Rgba {r:0.124706,g:0.080902,b:0.0617255,a:1.})
                    .child(Self::hint(self.route_error.clone().unwrap_or_default()).mt(px(0.)).text_color(rgb(DANGER)))
                    .child(div().mt(px(8.)).flex().items_center().gap(px(10.)).child(self.retry_route(cx)))))
                .when(self.route_busy,|view|view.child(Self::hint("Applying output route… Playback will stay paused.")))
                .child(div().opacity(0.45).child(self.check_row("settings-native",crate::i18n::t("settings.playback.useNativeLabel"),true,cx)))
                .child(Self::hint("Native DSP playback is always enabled.")))
            .child(self.mic(cx))
            .when_some(self.input_pref_error.clone(), |view, error| {
                let notice = Self::hint(error).text_color(rgb(DANGER)).id("settings-input-pref-error");
                #[cfg(feature = "ui-tests")]
                let notice = {
                    let bounds = self.field_bounds.clone();
                    notice.relative().child(canvas(move |b, _, _| {
                        bounds.borrow_mut().insert("settings-input-pref-error", b);
                        b
                    }, |_, _, _, _| {}).absolute().inset_0())
                };
                view.child(notice)
            })
            .child(self.monitor(cx))
    }
}
impl Render for SettingsScreen {
    fn render(&mut self, _window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "ui-tests")]
        {
            self.option_bounds.borrow_mut().clear();
            self.field_labels.borrow_mut().clear();
            self.field_bounds.borrow_mut().remove("settings-input-pref-error");
        }
        div()
            .size_full()
            .p(px(24.))
            .flex()
            .items_center()
            .justify_center()
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_size(px(13.))
            .text_color(rgb(TEXT))
            .child(
                modal_card()
                    .w_full()
                    .max_w(px(960.))
                    .h_full()
                    .min_h(px(0.))
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .flex_shrink_0()
                            .text_size(px(21.))
                            .line_height(px(25.))
                            .font_family("SingZ Display 800")
                            .mb(px(12.))
                            .child(crate::i18n::t("settings.title")),
                    )
                    .child(
                        ghost_pill("settings-quick-start", "Quick start")
                            .flex_shrink_0()
                            .w_full()
                            .justify_start()
                            .on_click(
                                cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::QuickStart)),
                            ),
                    )
                    .child(
                        div()
                            .flex_1()
                            .min_h(px(0.))
                            .flex()
                            .gap(px(20.))
                            .mt(px(6.))
                            .child(
                                div()
                                    .w(px(108.))
                                    .flex_shrink_0()
                                    .pr(px(14.))
                                    .border_r_1()
                                    .border_color(rgba(LINE))
                                    .flex()
                                    .flex_col()
                                    .gap(px(4.))
                                    .child(nav_tab("settings-tab-audio", crate::i18n::t("settings.tab.audio"), true)),
                            )
                            .child(
                                div()
                                    .relative()
                                    .flex_1()
                                    .min_w(px(0.))
                                    .h_full()
                                    .child(
                                        div()
                                            .id("settings-scroll")
                                            .size_full()
                                            .overflow_y_scroll()
                                            .track_scroll(&self.scroll)
                                            .pr(px(10.))
                                            .child(self.audio(cx)),
                                    )
                                    .child(production_scrollbar(&self.scroll)),
                            ),
                    )
                    .child(
                        div()
                            .mt(px(20.))
                            .flex_shrink_0()
                            .flex()
                            .gap(px(10.))
                            .child(ghost_pill("settings-close", crate::i18n::t("settings.action.close")).on_click(
                                cx.listener(|_, _, _, cx| cx.emit(SettingsEvent::Close)),
                            )),
                    ),
            )
    }
}

#[cfg(test)]
mod tests {
    use super::monitor_channel_choice;

    #[test]
    fn monitor_channel_choices_reject_duplicate_lanes_and_preserve_the_other_side() {
        assert_eq!(monitor_channel_choice([0, 1], 0, 1), None);
        assert_eq!(monitor_channel_choice([0, 1], 1, 0), None);
        assert_eq!(monitor_channel_choice([0, 1], 0, 2), Some([2, 1]));
        assert_eq!(monitor_channel_choice([2, 1], 1, 3), Some([2, 3]));
        assert_eq!(monitor_channel_choice([0, 1], 0, 0), Some([0, 1]));
        assert_eq!(monitor_channel_choice([0, 1], 2, 2), None);
    }
}

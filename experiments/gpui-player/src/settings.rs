//! Settings composition mirrors SettingsModal.tsx; native routes are host-owned.
use gpui_kit::prelude::FluentBuilder;
use gpui_kit::*;
use std::{cell::{Cell, RefCell}, collections::HashMap, rc::Rc, time::{Duration, Instant}};
actions!(singz_settings, [NextFocus, PreviousFocus]);
use singz_uikit::tokens::{ACCENT, DANGER, DIM, FAINT, LINE, LINE_STRONG, PANEL, PANEL_DEEP, TEXT};
use singz_uikit::{
    checkbox, disabled_monitor_pill, ghost_pill, modal_card, monitor_badge, nav_tab,
    production_scrollbar, scrolling_select_popup, select_field, select_option,
    select_popup,
};

pub enum SettingsEvent {
    Close,
    QuickStart,
    Output(String),
    Provider(crate::audio_devices::Provider),
    InputPrefs(crate::microphone::Prefs),
    EnableMicrophone,
    Monitor,
}
impl EventEmitter<SettingsEvent> for SettingsScreen {}

#[derive(Clone, Debug, PartialEq)]
struct PlaybackGraphView {
    generation: u64,
    state: u32,
    transport_state: u32,
    graph: Option<std::sync::Arc<crate::playback_graph::Snapshot>>,
    error: Option<String>,
}

pub struct SettingsScreen {
    scope: FocusHandle,
    controls: RefCell<HashMap<&'static str, FocusHandle>>,
    focus_order: RefCell<Vec<&'static str>>,
    control_bounds: Rc<RefCell<HashMap<&'static str, Bounds<Pixels>>>>,
    pending_focus: bool,
    menu_index: Option<usize>,
    menu_scroll: ScrollHandle,
    typeahead: String,
    typeahead_at: Option<Instant>,
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
    provider: Option<crate::integration::ProviderSnapshot>,
    provider_renderer_revision: u64,
    provider_renderer_busy: bool,
    provider_pending: bool,
    provider_error: Option<String>,
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
    playback_graph: Option<PlaybackGraphView>,
    graph_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    graph_viewport_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    graph_flow_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    graph_last_node_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    graph_last_connection_bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
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
    pub fn new(_window: &mut Window, cx: &mut Context<Self>) -> Self {
        cx.bind_keys([
            KeyBinding::new("tab", NextFocus, Some("SingZSettings")),
            KeyBinding::new("shift-tab", PreviousFocus, Some("SingZSettings")),
        ]);
        Self {
            scope: cx.focus_handle(), controls: Default::default(), focus_order: Default::default(),
            control_bounds: Default::default(), pending_focus: false, menu_index: None,
            menu_scroll: ScrollHandle::new(), typeahead: String::new(), typeahead_at: None,
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
            provider: None,
            provider_renderer_revision: 0,
            provider_renderer_busy: true,
            provider_pending: false,
            provider_error: None,
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
            playback_graph: None,
            graph_bounds: Default::default(),
            graph_viewport_bounds: Default::default(),
            graph_flow_bounds: Default::default(),
            graph_last_node_bounds: Default::default(),
            graph_last_connection_bounds: Default::default(),
            #[cfg(feature = "ui-tests")]
            gain_bounds: Default::default(),
        }
    }
    /// Keep only immutable native graph presentation. A rejected/absent graph
    /// stays unavailable on the playback route, never a fabricated monitor chain.
    pub fn set_playback_status(&mut self, status: Option<&crate::integration::Status>, cx: &mut Context<Self>) {
        let next = status.filter(|s| !s.training_only && !s.empty_project && s.graph_generation != 0 && s.state != 0)
            .map(|s| PlaybackGraphView { generation: s.graph_generation, state: s.state,
                transport_state: s.transport_state, graph: s.graph_snapshot.clone(), error: s.graph_error.clone() });
        if self.playback_graph != next {
            if self.playback_graph.as_ref().map(|s|s.generation) != next.as_ref().map(|s|s.generation) {
                self.graph_scroll.set_offset(point(px(0.),px(0.)));
            }
            self.playback_graph = next;
            cx.notify();
        }
    }
    fn playback_node_copy(node: &crate::playback_graph::Node) -> (String, String) {
        let buses = |channels: &[u32]| if channels.is_empty() { "none".into() } else {
            channels.iter().map(|channels|format!("{channels} ch")).collect::<Vec<_>>().join(" · ")
        };
        (format!("{} in ({}) · {} out ({})",node.input_bus_count,buses(&node.input_bus_channels),node.output_bus_count,buses(&node.output_bus_channels)),
         format!("{} · type {}:{} v{} · latency {} + {} = {} frames",node.role,node.type_high,node.type_low,node.schema_version,node.arrival_latency_frames,node.intrinsic_latency_frames,node.output_latency_frames))
    }
    fn playback_connection_copy(graph: &crate::playback_graph::Snapshot, connection: &crate::playback_graph::Connection) -> (String, String) {
        let label = |id| graph.nodes.iter().find(|node|node.id==id).expect("validated native graph connection").label.as_str();
        (format!("{} OUT {} ({} ch) → {} IN {} ({} ch)",label(connection.source_node_id),connection.source_bus+1,connection.source_channels,
            label(connection.destination_node_id),connection.destination_bus+1,connection.destination_channels),
         format!("{} → {} FRAMES · {} COMPENSATION FRAME{}",connection.source_output_latency_frames,connection.destination_arrival_latency_frames,
            connection.compensation_frames,if connection.compensation_frames==1{""}else{"S"}))
    }
    /// The visible node-row region uses measured flow and viewport bounds;
    /// connection rows can extend below it without pulling Tab focus past nodes.
    fn graph_node_viewport(&self) -> Option<Bounds<Pixels>> {
        let viewport=self.graph_viewport_bounds.get()?;
        let flow=self.graph_flow_bounds.get()?;
        Some(Bounds::new(point(viewport.left(),flow.top()),size(viewport.size.width,flow.size.height)))
    }
    #[cfg(feature="ui-tests")]
    pub fn graph_ui_state(&self) -> serde_json::Value {
        let bounds=|b:Option<Bounds<Pixels>>|b.map(|b|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]);
        let view=self.playback_graph.as_ref();
        let graph=view.and_then(|v|v.graph.as_deref());
        let rendered_nodes:Vec<_>=graph.into_iter().flat_map(|g|&g.nodes).map(|node| {
            let (value,detail)=Self::playback_node_copy(node);
            serde_json::json!({"id":node.id.to_string(),"kind":node.kind,"label":node.label,"value":value,"detail":detail})
        }).collect();
        let rendered_connections:Vec<_>=graph.into_iter().flat_map(|g|&g.connections).map(|connection| {
            let (route,latency)=Self::playback_connection_copy(graph.unwrap(),connection);
            serde_json::json!({"sourceNodeId":connection.source_node_id.to_string(),"destinationNodeId":connection.destination_node_id.to_string(),
                "sourceBus":connection.source_bus,"destinationBus":connection.destination_bus,"route":route,"latency":latency})
        }).collect();
        serde_json::json!({"mode":if view.is_some(){"playback"}else{"monitor"},"available":graph.is_some(),
            "generation":view.map(|v|v.generation.to_string()),"state":view.map(|v|v.state),"transportState":view.map(|v|v.transport_state),
            "graph":graph,"error":view.and_then(|v|v.error.as_deref()),"renderedNodes":rendered_nodes,"renderedConnections":rendered_connections,
            "graphBounds":bounds(self.graph_bounds.get()),"viewportBounds":bounds(self.graph_node_viewport()),
            "fullViewportBounds":bounds(self.graph_viewport_bounds.get()),"flowBounds":bounds(self.graph_flow_bounds.get()),"lastNodeBounds":bounds(self.graph_last_node_bounds.get()),
            "lastConnectionBounds":bounds(self.graph_last_connection_bounds.get()),"settingsModalViewportBounds":bounds(Some(self.scroll.bounds())),
            "graphScrollOffset":[f32::from(self.graph_scroll.offset().x),f32::from(self.graph_scroll.offset().y)],
            "verticalScrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)]})
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
    pub fn set_provider_state(&mut self, snapshot: Option<&crate::integration::ProviderSnapshot>, renderer_revision:u64, renderer_busy:bool, pending:bool, cx:&mut Context<Self>) {
        let changed=self.provider.as_ref().map(|s|s.revision)!=snapshot.map(|s|s.revision)
            ||self.provider_renderer_revision!=renderer_revision||self.provider_renderer_busy!=renderer_busy||self.provider_pending!=pending;
        if changed {
            if self.provider.as_ref().map(|s|s.revision)!=snapshot.map(|s|s.revision) {
                self.provider_error=snapshot.and_then(|s|s.error.clone());
            }
            self.provider=snapshot.cloned();self.provider_renderer_revision=renderer_revision;
            self.provider_renderer_busy=renderer_busy;self.provider_pending=pending;
            if !self.field_enabled("settings-provider")&&self.open_field==Some("settings-provider") {
                self.open_field=None;self.menu_index=None;self.typeahead.clear();
            }
            cx.notify();
        }
    }
    pub fn provider_failed(&mut self,error:String,cx:&mut Context<Self>) {self.provider_error=Some(error);self.provider_pending=false;cx.notify();}
    fn windows_provider(&self)->bool {
        cfg!(windows)||self.provider.as_ref().and_then(|s|s.availability.as_ref()).is_some_and(|p|p.platform=="win32")
    }
    #[cfg(feature="ui-tests")]
    pub fn provider_ui_state(&self,window:&Window)->serde_json::Value {
        let snapshot=self.provider.as_ref();
        let availability=snapshot.and_then(|s|s.availability.as_ref()).map(|a|serde_json::json!({
            "platform":a.platform,"defaultProvider":a.default_provider.as_str(),
            "providers":a.providers.iter().map(|p|serde_json::json!({"id":p.id.as_str(),"label":p.label,"compiled":p.compiled,"available":p.available,"detail":p.detail,"errorCode":p.error_code})).collect::<Vec<_>>()
        }));
        let bounds=|b:Bounds<Pixels>|[f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)];
        let focused=self.focus_order.borrow().iter().copied().find(|id|self.controls.borrow().get(id).is_some_and(|f|f.is_focused(window)));
        serde_json::json!({"visible":self.windows_provider(),"selected":snapshot.map(|s|s.selected.as_str()),"availability":availability,
            "enabled":self.field_enabled("settings-provider"),"pending":self.provider_pending,"error":self.provider_error,
            "canChange":snapshot.is_some_and(|s|s.can_change),"rendererBusy":self.provider_renderer_busy,
            "rendererRevision":self.provider_renderer_revision,"snapshotRendererRevision":snapshot.map(|s|s.renderer_revision),
            "revision":snapshot.map(|s|s.revision),"epoch":snapshot.map(|s|s.epoch),"request":snapshot.map(|s|s.request),
            "openField":self.open_field,"menuIndex":self.menu_index,"focusedControl":focused,
            "bounds":self.control_bounds.borrow().get("settings-provider").copied().map(bounds),
            "options":(0..2).map(|i|serde_json::json!({"index":i,"disabled":self.option_disabled("settings-provider",i),"bounds":self.option_bounds("settings-provider",i).map(bounds)})).collect::<Vec<_>>()})
    }
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
            Err(error) => {
                if self.windows_provider() {self.inventory=None;}
                self.route_error=Some(error);
            },
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
        if id=="settings-provider" {return vec![("wasapi".into(),crate::i18n::t("settings.windows.wasapiOption")),("asio".into(),"ASIO".into())];}
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
            let devices:Vec<_>=if input {inventory.devices.iter().filter(|d|d.inputs>0).collect()}
                else if id=="settings-monitor-output" {inventory.monitor_outputs().collect()}
                else {inventory.playback_outputs().collect()};
            options.extend(
                devices.into_iter()
                    .map(|d| {
                        (
                            if id=="settings-monitor-output" {crate::audio_devices::raw_monitor_uid(&d.uid)}else{d.uid.clone()},
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
                .and_then(|(uid, _)| inventory.monitor_output(uid).ok())
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
        self.menu_index = None;
        self.typeahead.clear();
        self.pending_focus = true;
        self.scroll.set_offset(point(px(0.), px(0.)));
        self.graph_scroll.set_offset(point(px(0.), px(0.)));
        cx.notify();
    }
    pub fn dismiss_popup(&mut self, cx: &mut Context<Self>) -> bool {
        if self.open_field.take().is_some() {
            self.menu_index = None;
            self.typeahead.clear();
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
    fn field_options(&self, id: &'static str) -> Vec<(String, String)> {
        self.options(id, match id {
            "settings-output" => OUTPUTS,
            "settings-input" => INPUTS,
            "settings-monitor-output" => MONITOR_OUTPUTS,
            "settings-channel" => &["IN 1", "IN 2"],
            _ => &["OUT 1", "OUT 2"],
        })
    }
    fn field_enabled(&self, id: &str) -> bool {
        match id {
            "settings-provider"=>self.windows_provider()&&!self.provider_pending&&!self.provider_renderer_busy
                &&self.provider.as_ref().is_some_and(|s|s.can_change&&s.renderer_revision==self.provider_renderer_revision),
            "settings-output" => (!self.native || !self.route_busy)&&!self.provider_pending,
            "settings-monitor-output" | "settings-output-left" | "settings-output-right" => !self.native || !self.monitor_busy,
            _ => true,
        }
    }
    fn option_disabled(&self, id: &str, index: usize) -> bool {
        match id {
            "settings-provider"=>{
                let id=match index {0=>"wasapi",1=>"asio",_=>return true};
                !self.provider.as_ref().and_then(|s|s.availability.as_ref())
                    .and_then(|p|p.providers.iter().find(|p|p.id.as_str()==id)).is_some_and(|p|p.available)
            },
            "settings-output-left" => monitor_channel_choice(self.output_channels, 0, index).is_none(),
            "settings-output-right" => monitor_channel_choice(self.output_channels, 1, index).is_none(),
            _ => false,
        }
    }
    fn selected_option(&self, id: &str, options: &[(String, String)]) -> usize {
        if id=="settings-provider" {
            return self.provider.as_ref().map(|s|options.iter().position(|(id,_)|s.selected.as_str()==id).unwrap_or(options.len())).unwrap_or(0);
        }
        if self.native {
            let uid = match id {
                "settings-output" => Some(&self.output_uid),
                "settings-input" => Some(&self.input_prefs.input),
                "settings-monitor-output" => Some(&self.input_prefs.monitor_output),
                _ => None,
            };
            if let Some(uid) = uid { return options.iter().position(|(key, _)| key == uid).unwrap_or(0); }
        }
        match id {
            "settings-output" => self.output,
            "settings-input" => self.input,
            "settings-monitor-output" => self.monitor_output,
            "settings-channel" => self.channel,
            "settings-output-left" => self.output_channels[0],
            "settings-output-right" => self.output_channels[1],
            _ => 0,
        }
    }
    fn register_control(&self, id: &'static str, enabled: bool, cx: &mut Context<Self>) -> FocusHandle {
        let focus = self.controls.borrow_mut().entry(id).or_insert_with(|| cx.focus_handle()).clone();
        if enabled { self.focus_order.borrow_mut().push(id); }
        focus
    }
    fn probe_control(&self, id: &'static str, control: Stateful<Div>) -> Stateful<Div> {
        let bounds = self.control_bounds.clone();
        #[cfg(feature = "ui-tests")]
        let fields = self.field_bounds.clone();
        #[cfg(feature = "ui-tests")]
        let gain = self.gain_bounds.clone();
        control.relative().child(canvas(move |b, _, _| {
            #[cfg(feature = "ui-tests")]
            { fields.borrow_mut().insert(id, b); if id == "settings-monitor-gain" { gain.set(Some(b)); } }
            bounds.borrow_mut().insert(id, b); b
        }, |_, _, _, _| {}).absolute().inset_0())
    }
    fn control(&self, id: &'static str, control: Stateful<Div>, enabled: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        let enabled=enabled&&(id!="settings-monitor-start"||!self.provider_pending);
        let focus = self.register_control(id, enabled, cx);
        let weak = cx.entity().downgrade();
        self.probe_control(id, singz_uikit::settings_control_with_focus(control, focus, enabled, move |w, cx| {
            let _ = weak.update(cx, |s, cx| s.activate(id, w, cx));
        }))
    }
    pub fn focused_control(&self, window: &Window, _cx: &App) -> Option<&'static str> {
        self.focus_order.borrow().iter().copied().find(|id| self.controls.borrow().get(id).is_some_and(|focus| focus.is_focused(window)))
    }
    fn focus_control(&self, id: &'static str, window: &mut Window, cx: &mut Context<Self>) {
        if let Some(focus) = self.controls.borrow().get(id) { focus.focus(window, cx); }
        if !matches!(id, "settings-quick-start" | "settings-tab-audio" | "settings-close") {
            let bounds = if id == "settings-playback-graph" { self.graph_node_viewport() } else { self.control_bounds.borrow().get(id).copied() };
            if let Some(bounds) = bounds {
                let viewport = self.scroll.bounds();
                let correction = if bounds.top() < viewport.top() + px(4.) {
                    viewport.top() + px(4.) - bounds.top()
                } else if bounds.bottom() > viewport.bottom() - px(4.) {
                    viewport.bottom() - px(4.) - bounds.bottom()
                } else { px(0.) };
                let offset = self.scroll.offset();
                self.scroll.set_offset(point(offset.x, offset.y + correction));
            }
        }
    }
    fn move_focus(&mut self, backwards: bool, window: &mut Window, cx: &mut Context<Self>) {
        self.open_field = None; self.menu_index = None; self.typeahead.clear();
        let order = self.focus_order.borrow().clone();
        if !order.is_empty() {
            let current = self.focused_control(window, cx).and_then(|id| order.iter().position(|item| *item == id));
            let next = match current {
                Some(i) if backwards => (i + order.len() - 1) % order.len(),
                Some(i) => (i + 1) % order.len(),
                None if backwards => order.len() - 1,
                None => 0,
            };
            self.focus_control(order[next], window, cx);
        }
        cx.notify();
    }
    fn activate(&mut self, id: &'static str, _window: &mut Window, cx: &mut Context<Self>) {
        if !self.focus_order.borrow().contains(&id) { return; }
        match id {
            "settings-close" => cx.emit(SettingsEvent::Close),
            "settings-quick-start" => cx.emit(SettingsEvent::QuickStart),
            "settings-enable-microphone" => cx.emit(SettingsEvent::EnableMicrophone),
            "settings-monitor-start" => if !self.provider_pending {cx.emit(SettingsEvent::Monitor)},
            "settings-retry" => {
                if !self.route_busy { self.route_busy = true; cx.emit(SettingsEvent::Output(self.output_uid.clone())); }
            }
            "settings-native" => self.native_playback = !self.native_playback,
            "settings-headphones" => {
                self.headphones = !self.headphones;
                if self.native { self.input_prefs.headphones = self.headphones; cx.emit(SettingsEvent::InputPrefs(self.input_prefs.clone())); }
            }
            "settings-tab-audio" => {}
            _ => {
                if self.open_field == Some(id) { self.open_field = None; self.menu_index = None; }
                else {
                    let options = self.field_options(id);
                    self.open_field = Some(id);
                    let selected = self.selected_option(id, &options);
                    self.menu_index = (selected < options.len() && !self.option_disabled(id, selected)).then_some(selected)
                        .or_else(|| (0..options.len()).find(|i| !self.option_disabled(id, *i)));
                    self.menu_scroll.scroll_to_item(self.menu_index.unwrap_or(0));
                    self.typeahead.clear();
                }
            }
        }
        cx.notify();
    }
    fn capture_key(&mut self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        let key = event.keystroke.key.as_str();
        if key == "tab" { self.move_focus(event.keystroke.modifiers.shift, window, cx); window.prevent_default(); cx.stop_propagation(); return; }
        if key == "escape" {
            if !self.dismiss_popup(cx) { cx.emit(SettingsEvent::Close); }
            self.menu_index = None; window.prevent_default(); cx.stop_propagation(); return;
        }
        let Some(id) = self.focused_control(window, cx) else { return; };
        if id == "settings-playback-graph" {
            let vertical_delta=match key {
                "up"=>Some(px(40.)),"down"=>Some(px(-40.)),
                "pageup"=>Some(self.scroll.bounds().size.height*0.9),
                "pagedown"=>Some(self.scroll.bounds().size.height*-0.9),_=>None,
            };
            if let Some(delta)=vertical_delta {
                let offset=self.scroll.offset();
                self.scroll.set_offset(point(offset.x,(offset.y+delta).clamp(-self.scroll.max_offset().y,px(0.))));
                window.prevent_default();cx.stop_propagation();cx.notify();return;
            }
            let offset=self.graph_scroll.offset();
            let end=f32::from(self.graph_scroll.max_offset().x);
            let next=match key {
                "left"=>Some((f32::from(offset.x)+40.).min(0.)),
                "right"=>Some((f32::from(offset.x)-40.).max(-end)),
                "home"=>Some(0.),"end"=>Some(-end),_=>None,
            };
            if let Some(x)=next { self.graph_scroll.set_offset(point(px(x),offset.y)); window.prevent_default(); cx.stop_propagation(); cx.notify(); }
            return;
        }
        if !matches!(id, "settings-provider" | "settings-output" | "settings-input" | "settings-channel" | "settings-monitor-output" | "settings-output-left" | "settings-output-right") { return; }
        if !self.field_enabled(id) { return; }
        let options = self.field_options(id);
        let indices: Vec<_> = (0..options.len()).filter(|i| !self.option_disabled(id, *i)).collect();
        if matches!(key, "enter" | "space") {
            if event.is_held { window.prevent_default(); cx.stop_propagation(); return; }
            if self.open_field == Some(id) {
                if let Some(index) = self.menu_index { self.choose_option(id, index, cx); }
            } else { self.activate(id, window, cx); }
        } else if matches!(key, "up" | "down" | "left" | "right" | "home" | "end") {
            if self.open_field != Some(id) { self.activate(id, window, cx); }
            if !indices.is_empty() {
                let current = self.menu_index.and_then(|selected| indices.iter().position(|i| *i == selected)).unwrap_or(0);
                let next = match key {
                    "home" => 0, "end" => indices.len() - 1,
                    "up" | "left" => current.saturating_sub(1),
                    _ => (current + 1).min(indices.len() - 1),
                };
                self.menu_index = Some(indices[next]);
                self.menu_scroll.scroll_to_item(indices[next]);
            }
        } else if key.chars().count() == 1 && !event.keystroke.modifiers.control && !event.keystroke.modifiers.platform && !event.keystroke.modifiers.alt {
            if self.open_field != Some(id) { self.activate(id, window, cx); }
            let now = Instant::now();
            if self.typeahead_at.is_none_or(|at| now.duration_since(at) > Duration::from_millis(700)) { self.typeahead.clear(); }
            self.typeahead.push_str(&key.to_lowercase()); self.typeahead_at = Some(now);
            if let Some(index) = indices.iter().find(|i| options[**i].1.to_lowercase().starts_with(&self.typeahead)) {
                self.menu_index = Some(*index); self.menu_scroll.scroll_to_item(*index);
            }
        } else { return; }
        window.prevent_default(); cx.stop_propagation(); cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn keyboard_snapshot(&self, window: &Window, cx: &App) -> serde_json::Value {
        let focused = self.focused_control(window, cx);
        let bounds = focused.and_then(|id| if id == "settings-playback-graph" {
            self.graph_node_viewport()
        } else {
            self.control_bounds.borrow().get(id).copied()
        });
        serde_json::json!({"focusOrder":self.focus_order.borrow().clone(),"focusedControl":focused,
            "openField":self.open_field,"menuIndex":self.menu_index,"focusInside":self.scope.contains_focused(window,cx),
            "scrollOffset":[f32::from(self.scroll.offset().x),f32::from(self.scroll.offset().y)],
            "focusedBounds":bounds.map(|b| [f32::from(b.left()),f32::from(b.top()),f32::from(b.size.width),f32::from(b.size.height)]),
            "viewportBounds":[f32::from(self.scroll.bounds().left()),f32::from(self.scroll.bounds().top()),f32::from(self.scroll.bounds().size.width),f32::from(self.scroll.bounds().size.height)]})
    }
    fn choose_option(&mut self, id: &'static str, index: usize, cx: &mut Context<Self>) {
        if !self.field_enabled(id) || self.option_disabled(id, index) { return; }
        let options = self.field_options(id);
        let Some((uid, _)) = options.get(index) else { return; };
        let uid = uid.clone();
                                    match id {
                                        "settings-provider"=>{
                                            let provider=match uid.as_str(){"wasapi"=>crate::audio_devices::Provider::Wasapi,"asio"=>crate::audio_devices::Provider::Asio,_=>return};
                                            self.provider_pending=true;self.provider_error=None;cx.emit(SettingsEvent::Provider(provider));
                                        },
                                        "settings-output" => {
                                            self.output = index;
                                            if self.native {
                                                self.route_busy = true;
                                                self.route_error = None;
                                                cx.emit(SettingsEvent::Output(uid.clone()));
                                            }
                                        }
                                        "settings-input" => {
                                            self.input = index;
                                            self.channel = 0;
                                            if self.native {
                                                self.input_prefs.input = uid.clone();
                                                self.input_prefs.channel = 0;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    self.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-channel" => {
                                            self.channel = index;
                                            if self.native {
                                                self.input_prefs.channel = index;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    self.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-monitor-output" => {
                                            let changed = if self.native {
                                                self.input_prefs.monitor_output != uid
                                            } else {
                                                self.monitor_output != index
                                            };
                                            self.monitor_output = index;
                                            if changed {
                                                self.output_channels = [0, 1];
                                            }
                                            if self.native {
                                                self.input_prefs.monitor_output = uid.clone();
                                                if changed {
                                                    self.input_prefs.outputs = [0, 1];
                                                }
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    self.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        "settings-output-left" | "settings-output-right" => {
                                            let slot = if id == "settings-output-left" { 0 } else { 1 };
                                            let Some(channels) = monitor_channel_choice(self.output_channels, slot, index) else {
                                                return;
                                            };
                                            self.output_channels = channels;
                                            if self.native {
                                                self.input_prefs.outputs = channels;
                                                cx.emit(SettingsEvent::InputPrefs(
                                                    self.input_prefs.clone(),
                                                ));
                                            }
                                        }
                                        _ => {}
                                    }
        self.open_field = None;
        self.menu_index = None;
        self.typeahead.clear();
        cx.notify();
    }
    fn field(
        &self,
        id: &'static str,
        options: &'static [&'static str],
        selected: usize,
        cx: &mut Context<Self>,
    ) -> impl IntoElement + use<> {
        let options = self.options(id, options);
        let selected = if id=="settings-provider" {
            self.selected_option(id,&options)
        } else if self.native && id == "settings-input" {
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
            scrolling_select_popup(format!("{id}-popup")).track_scroll(&self.menu_scroll)
        } else {
            select_popup().id(format!("{id}-popup"))
        };
        #[cfg(feature = "ui-tests")]
        let bounds = self.field_bounds.clone();
        let label = options.get(selected).map(|(_, label)| label.clone()).unwrap_or_else(|| {
            if id=="settings-provider" {
                "Saved audio provider · unavailable".into()
            } else if options.is_empty() {
                "No channels".into()
            } else {
                "Saved channel · unavailable".into()
            }
        });
        #[cfg(feature = "ui-tests")]
        self.field_labels.borrow_mut().insert(id, label.clone());
        let accessible_label = match id {
            "settings-output" => Some("settings.output.label"),
            "settings-provider" => Some("settings.windows.providerLabel"),
            "settings-input" => Some("settings.mic.label"),
            "settings-channel" => Some("settings.mic.channelLabel"),
            "settings-monitor-output" => Some("settings.monitor.outputLabel"),
            "settings-output-left" => Some("settings.monitor.playbackLeft"),
            "settings-output-right" => Some("settings.monitor.playbackRight"),
            _ => None,
        }.map(crate::i18n::t).unwrap_or_else(|| label.clone());
        let field = div()
            .relative()
            .w_full()
            .child(
                self.control(id, select_field(id, label.clone())
                    .aria_label(accessible_label)
                    .aria_value(label)
                    .aria_expanded(expanded), self.field_enabled(id), cx),
            )
            .when(expanded, |v| {
                v.child(
                    deferred(popup.children(options.into_iter().enumerate().map(
                        |(index, (_uid, option))| {
                            let disabled=self.option_disabled(id,index);
                            let option = singz_uikit::disabled_control(select_option((id, index), option, if expanded { self.menu_index == Some(index) } else { index == selected })
                                .flex_none()
                                .when(disabled, |option| option.opacity(0.45).cursor_default()), !disabled)
                                .on_click(cx.listener(move |this, _, _, cx| {
                                    if disabled {
                                        cx.stop_propagation();
                                        return;
                                    }
                                    this.choose_option(id, index, cx);
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
        &self, id: &'static str, label: impl Into<SharedString>, on: bool, cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let label: SharedString = label.into();
        let row = div().id(format!("{id}-row")).role(Role::CheckBox).accessibility_id(id)
            .aria_label(label.clone()).aria_toggled(if on {Toggled::True} else {Toggled::False})
            .mt(px(10.)).flex().items_center().gap(px(8.))
            .text_color(rgb(DIM)).text_size(px(12.)).line_height(px(15.)).cursor_pointer()
            .child(checkbox(id, on).a11y_synthetic_children(|builder| builder.parent_node().set_hidden()).on_click(cx.listener(move |s, _, w, cx| {
                s.activate(id, w, cx); cx.stop_propagation();
            }))).child(label);
        let enabled = !(self.native && (id == "settings-native" || self.monitor_busy));
        self.control(id, row, enabled, cx)
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
                        self.control("settings-enable-microphone", ghost_pill(
                            "settings-enable-microphone",
                            if self.microphone.phase == crate::microphone::Phase::Permission { "Enable microphone" } else { "Retry microphone" },
                        ).mt(px(8.)), true, cx),
                    )
                },
            )
    }
    fn graph(&self, cx: &mut Context<Self>) -> AnyElement {
        if let Some(view)=&self.playback_graph { return self.playback_graph(view,cx); }
        self.monitor_graph().into_any_element()
    }
    fn playback_graph(&self, view: &PlaybackGraphView, cx: &mut Context<Self>) -> AnyElement {
        let graph=view.graph.as_deref();
        let facts=graph.map_or_else(||vec![crate::i18n::t("player.dspGraph.structuredUnavailable")],|graph|vec![
            if graph.sample_rate%1000.==0. { format!("{} kHz",graph.sample_rate/1000.) } else { format!("{:.1} kHz",graph.sample_rate/1000.) },
            crate::i18n::tv("player.dspGraph.framesMaximum",&[("n",graph.maximum_frames.to_string())]),
            crate::i18n::tv("player.dspGraph.nodesLinks",&[("nodes",graph.nodes.len().to_string()),("links",graph.connections.len().to_string())]),
        ]);
        let transport=match view.transport_state {0=>Some("stopped"),1=>Some("pre-roll"),2=>Some("playing"),3=>Some("paused"),4=>Some("completed"),_=>None};
        let state_label=transport.map_or_else(||crate::i18n::t("player.dspGraph.structuredUnavailable"),|transport|crate::i18n::t(&format!("player.dspGraph.transport.{transport}")));
        let card=singz_uikit::runtime_graph_card(crate::i18n::t("player.dspGraph.runtimeGraph"),crate::i18n::t("player.dspGraph.songAndReference"),facts,
            state_label,view.state==4,matches!(view.state,6|7)||view.state>7||transport.is_none());
        let card=if let Some(graph)=graph {
            let last_bounds=self.graph_last_node_bounds.clone();
            let nodes=graph.nodes.iter().enumerate().map(|(index,node)| {
                let (value,detail)=Self::playback_node_copy(node);
                let face=singz_uikit::runtime_graph_node(node.kind.clone(),node.label.clone(),value,detail,view.state==4);
                if index+1==graph.nodes.len() {
                    let bounds=last_bounds.clone();
                    face.child(canvas(move|b,_,_|{bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0())
                } else {face}
            });
            let flow_bounds=self.graph_flow_bounds.clone();
            let flow=div().relative().min_w(px(graph.nodes.len() as f32*114.)).flex().gap(px(10.)).items_stretch().children(nodes)
                .child(canvas(move|b,_,_|{flow_bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0());
            let connections=singz_uikit::runtime_graph_connections().children(graph.connections.iter().enumerate().map(|(index,connection)|{
                let (route,latency)=Self::playback_connection_copy(graph,connection);
                let row=singz_uikit::runtime_graph_connection(route,latency,index>0);
                if index+1==graph.connections.len() {
                    let bounds=self.graph_last_connection_bounds.clone();
                    row.relative().child(canvas(move|b,_,_|{bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0())
                } else {row}
            }));
            let vertical=self.scroll.clone();let horizontal=self.graph_scroll.clone();
            let viewport_bounds=self.graph_viewport_bounds.clone();
            // Scroll transforms every child, including absolute overlays.
            // Keep the actual viewport measurement and focus outline on a
            // stationary parent, outside that scrolling content coordinate space.
            let scroller=div().id("settings-playback-graph-scroll").relative().overflow_x_scroll().restrict_scroll_to_axis().track_scroll(&self.graph_scroll).p(px(12.))
                .on_scroll(move|event,window,cx|{
                    let delta=event.delta.pixel_delta(window.line_height());
                    if delta.y.abs()>delta.x.abs(){
                        if event.modifiers.shift {let offset=horizontal.offset();horizontal.set_offset(point(offset.x+delta.y,offset.y));}
                        else {let offset=vertical.offset();vertical.set_offset(point(offset.x,offset.y+delta.y));}
                        window.refresh();cx.stop_propagation();
                    }
                })
                .child(flow).child(connections);
            let viewport=div().id("settings-playback-graph").relative().min_w_0()
                .child(scroller)
                .child(canvas(move|b,_,_|{viewport_bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0());
            let focus=self.register_control("settings-playback-graph",true,cx);
            card.child(singz_uikit::runtime_graph_viewport_focus(viewport,focus))
        } else {
            card.child(div().relative().mt(px(10.)).text_color(rgb(DANGER)).text_size(px(11.)).line_height(px(15.4)).child(crate::i18n::t("player.dspGraph.unavailableExplain")))
        };
        let bounds=self.graph_bounds.clone();
        card.child(canvas(move|b,_,_|{bounds.set(Some(b));b},|_,_,_,_|{}).absolute().inset_0()).into_any_element()
    }
    fn monitor_graph(&self) -> impl IntoElement + use<> {
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
        let gain_slider = |cx: &mut Context<Self>| {
            let weak = cx.entity().downgrade();
            let enabled = !self.native || !self.monitor_busy || self.microphone.phase == crate::microphone::Phase::Monitoring;
            let focus = self.register_control("settings-monitor-gain", enabled, cx);
            self.probe_control("settings-monitor-gain", singz_uikit::settings_range_slider_with_focus(
                "settings-monitor-gain", self.gain, -60., 0., 1., focus, enabled,
                move |value, _window, cx| {
                    let _ = weak.update(cx, |this, cx| {
                        this.gain = value.round();
                        if this.native { this.input_prefs.gain = this.gain; cx.emit(SettingsEvent::InputPrefs(this.input_prefs.clone())); }
                        cx.notify();
                    });
                },
            ).aria_label(crate::i18n::t("settings.monitor.gainLabel")).flex_1().min_w(px(100.)))
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
            .child(self.graph(cx))
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
                    .child(gain_slider(cx))
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
                        self.control("settings-monitor-start", button, self.native && (self.monitor_busy || self.monitor_route().is_ok()), cx)
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
        self.control("settings-retry", ghost_pill("settings-retry", crate::i18n::t("settings.output.retryRoute")), !self.route_busy, cx)
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
            .when(self.windows_provider(),|view|view
                .child(Self::label(crate::i18n::t("settings.windows.providerLabel")))
                .child(self.field("settings-provider",&["System audio (WASAPI)","ASIO"],0,cx))
                .when_some(self.provider.as_ref().and_then(|s|s.availability.as_ref().and_then(|a|a.providers.iter().find(|p|p.id==s.selected))).map(|p|(p.detail.clone(),p.available)),|view,(detail,available)|
                    view.child(Self::hint(detail).when(!available,|hint|hint.text_color(rgb(DANGER)))))
                .when_some(self.provider_error.clone(),|view,error|view.child(Self::hint(error).text_color(rgb(DANGER)))))
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
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        self.focus_order.borrow_mut().clear();
        self.graph_bounds.set(None);
        self.graph_viewport_bounds.set(None);
        self.graph_flow_bounds.set(None);
        self.graph_last_node_bounds.set(None);
        self.graph_last_connection_bounds.set(None);
        if self.pending_focus { self.pending_focus = false; self.scope.focus(window, cx); }
        #[cfg(feature = "ui-tests")]
        {
            self.option_bounds.borrow_mut().clear();
            self.field_labels.borrow_mut().clear();
            self.field_bounds.borrow_mut().remove("settings-input-pref-error");
        }
        let content = div()
            .id("settings-keyboard-scope")
            .key_context("SingZSettings")
            .track_focus(&self.scope)
            .on_action(cx.listener(|s, _: &NextFocus, w, cx| { s.move_focus(false, w, cx); cx.stop_propagation(); }))
            .on_action(cx.listener(|s, _: &PreviousFocus, w, cx| { s.move_focus(true, w, cx); cx.stop_propagation(); }))
            .capture_key_down(cx.listener(|s, e: &KeyDownEvent, w, cx| s.capture_key(e, w, cx)))
            .on_key_down(|_, _, cx| cx.stop_propagation())
            .on_key_up(|_, _, cx| cx.stop_propagation())
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
                        self.control("settings-quick-start", ghost_pill("settings-quick-start", "Quick start")
                            .flex_shrink_0().w_full().justify_start(), true, cx),
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
                                    .child(self.control("settings-tab-audio", nav_tab("settings-tab-audio", crate::i18n::t("settings.tab.audio"), true), true, cx)),
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
                                            .child(self.audio(cx))
                                            .when(crate::migrate::imported_count() > 0, |view| view.child(div().mt(px(16.)).text_size(px(11.)).text_color(rgb(DIM)).child(crate::i18n::tv("settings.migration.summary", &[("count", crate::migrate::imported_count().to_string())])))),
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
                            .child(self.control("settings-close", ghost_pill("settings-close", crate::i18n::t("settings.action.close")), true, cx)),
                    ),
            );
        // A route apply can disable a select, or a refreshed mono inventory can
        // remove its channel picker. Recover before its old focus node leaves
        // the tree, so the modal keeps receiving Tab and Escape. This is local
        // to the current render and cannot override a later user focus choice.
        let lost_control = self.controls.borrow().iter().any(|(id, focus)| {
            focus.is_focused(window) && !self.focus_order.borrow().contains(id)
        });
        if lost_control {
            if self.open_field.take().is_some() { cx.notify(); }
            self.menu_index = None;
            self.typeahead.clear();
            self.scope.focus(window, cx);
        }
        content
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

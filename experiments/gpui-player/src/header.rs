//! App.tsx titlebar content; the host owns the native drag surface and reservation.
use crate::i18n::t;
use crate::a11y::ButtonSurface;
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DIM, FAINT, TEXT};
use singz_uikit::{
    glow, persistent_monitor_control, persistent_monitor_status, segmented_nav, segmented_tab,
    settings_control_with_focus, small_ghost_pill_enabled, status_chip, text_link,
};

#[derive(Clone)]
pub enum HeaderEvent {
    Songs,
    Catalog,
    Settings,
    StopMonitor,
    Training,
    Log,
    Update,
    Engine,
    Language,
    Help,
    WhatsNew,
    Save,
    Projects,
    AddToLibrary,
    Rename(String),
    TitleClosed,
}

/// Electron's title-bar update chip: `ready` and `available` act, `downloading`
/// only reports (src/renderer/src/App.tsx).
#[derive(Clone, Debug, PartialEq, Eq, Hash)]
pub enum UpdateChip {
    Ready,
    Available(String),
    Downloading(u8),
}

pub struct Header {
    pub guides: singz_uikit::GuideAnchors,
    /// Labels of the compact right-hand pills from the last render (ui-tests probe).
    #[cfg(feature = "ui-tests")]
    pill_labels: std::cell::RefCell<Vec<(&'static str, SharedString, bool)>>,
    output_label: String,
    controls: std::collections::BTreeMap<&'static str, FocusHandle>,
    monitor_label: Option<String>,
    monitor_stopping: bool,
    monitor_attention: bool,
    monitor_status_focus: FocusHandle,
    monitor_stop_focus: FocusHandle,
    save_status: u8,
    save_enabled: bool,
    native_audio_ready: bool,
    training: bool,
    loaded: bool,
    catalog: bool,
    title: SharedString,
    review_fixture: bool,
    import_available: bool,
    engine_ready: bool,
    editing: bool,
    rename_enabled: bool,
    update: Option<UpdateChip>,
    title_input: Entity<InputState>,
    _title_subscription: Subscription,
    #[cfg(feature = "ui-tests")]
    pub rename_bounds: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
}
impl EventEmitter<HeaderEvent> for Header {}

impl Header {
    /// Visible values only: redundant host setters, hover and modal typing do
    /// not cause a full-window backdrop readback.
    pub fn backdrop_fingerprint(&self, cx: &App) -> u64 {
        use std::hash::{Hash, Hasher};
        let mut state = std::collections::hash_map::DefaultHasher::new();
        self.output_label.hash(&mut state);
        self.monitor_label.hash(&mut state);
        (self.monitor_stopping, self.monitor_attention, self.save_status,
            self.save_enabled, self.native_audio_ready, self.training,
            self.loaded, self.catalog, self.import_available, self.engine_ready,
            self.editing, self.rename_enabled).hash(&mut state);
        self.update.hash(&mut state);
        self.title.hash(&mut state);
        if self.editing { self.title_input.read(cx).value().hash(&mut state); }
        state.finish()
    }
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit_title(cx);
            }
        });
        Self {
            guides: Default::default(),
            #[cfg(feature = "ui-tests")]
            pill_labels: Default::default(),
            controls: ["header-language","header-help","header-settings","header-log","header-save","header-import","header-projects","header-catalog","header-songs","header-training","header-version","header-engine","header-rename","header-update"].into_iter().map(|id|(id,cx.focus_handle().tab_stop(true))).collect(),
            output_label: "System default output".into(),
            monitor_label: None,
            monitor_stopping: false,
            monitor_attention: false,
            monitor_status_focus: cx.focus_handle().tab_stop(true),
            monitor_stop_focus: cx.focus_handle().tab_stop(true),
            native_audio_ready: false,
            save_status: 0,
            save_enabled: true,
            training: false,
            loaded: false,
            catalog: true,
            title: "".into(),
            review_fixture: false,
            import_available: false,
            engine_ready: false,
            editing: false,
            rename_enabled: true,
            update: None,
            title_input: input,
            _title_subscription: subscription,
            #[cfg(feature = "ui-tests")]
            rename_bounds: Default::default(),
        }
    }

    pub fn cancel_title(&mut self, cx: &mut Context<Self>) {
        if self.editing {
            self.editing = false;
            cx.notify();
        }
    }
    pub fn title_input_focused(&self, window: &Window, cx: &App) -> bool {
        self.title_input
            .read(cx)
            .focus_handle(cx)
            .is_focused(window)
    }
    pub fn is_editing(&self) -> bool {
        self.editing
    }
    pub fn set_rename_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.rename_enabled != enabled {
            self.rename_enabled = enabled;
            cx.notify();
        }
    }
    fn begin_title(&mut self, window: &mut Window, cx: &mut Context<Self>) {
        if !self.rename_enabled {
            return;
        }
        self.editing = true;
        let value = self.title.clone();
        self.title_input.update(cx, |input, cx| {
            input.set_value(value, window, cx);
            input.focus(window, cx);
        });
        cx.notify();
    }
    fn commit_title(&mut self, cx: &mut Context<Self>) {
        if !self.editing {
            return;
        }
        self.editing = false;
        cx.emit(HeaderEvent::TitleClosed);
        // Preserve trailing spaces until rename_title validates the typed name.
        let value = self.title_input.read(cx).value().to_string();
        if !value.trim().is_empty() && value != self.title.as_str() {
            cx.emit(HeaderEvent::Rename(value));
        }
        cx.notify();
    }
    #[cfg(feature = "ui-tests")]
    pub fn title_state(&self) -> Entity<InputState> {
        self.title_input.clone()
    }
    fn rename_button(&self, cx: &mut Context<Self>) -> Stateful<Div> {
        let weak=cx.entity().downgrade();
        let button = settings_control_with_focus(text_link("header-rename", "✎")
            .text_size(px(13.))
            .font_family("SingZ Display 400")
            .line_height(px(13.))
            .px(px(5.))
            .py(px(3.))
            .rounded(px(7.))
            .text_color(rgb(FAINT)),
            self.controls["header-rename"].clone(),
            self.loaded && !self.editing && self.rename_enabled,
            move|window,cx| {
                let _=weak.update(cx,|header,cx| {
                    if header.loaded && !header.editing && header.rename_enabled {
                        header.begin_title(window,cx);
                    }
                });
            },
        );
        #[cfg(feature = "ui-tests")]
        {
            let hit = self.rename_bounds.clone();
            return button.relative().child(
                canvas(
                    move |b, _, _| {
                        hit.set(Some(b));
                        b
                    },
                    |_, _, _, _| {},
                )
                .absolute()
                .top_0()
                .left_0()
                .size_full(),
            );
        }
        #[cfg(not(feature = "ui-tests"))]
        button
    }
    pub fn language_focus(&self)->FocusHandle {self.controls["header-language"].clone()}
    #[cfg(feature="ui-tests")]
    pub fn focused_control(&self, window:&Window)->Option<String> {
        self.controls.iter().find_map(|(id,focus)|focus.is_focused(window).then(||(*id).to_owned()))
            .or_else(||self.monitor_status_focus.is_focused(window).then(||"header-monitor-status".into()))
            .or_else(||self.monitor_stop_focus.is_focused(window).then(||"header-monitor-stop".into()))
    }
    pub fn set_update(&mut self, update: Option<UpdateChip>, cx: &mut Context<Self>) {
        if self.update != update {
            self.update = update;
            cx.notify();
        }
    }
    pub fn set_engine(&mut self, ready: bool, cx: &mut Context<Self>) {
        if self.engine_ready != ready {
            self.engine_ready = ready;
            cx.notify();
        }
    }
    #[cfg(feature="ui-tests")]
    pub fn engine_ready(&self)->bool{self.engine_ready}
    pub fn set_training(&mut self, training: bool, cx: &mut Context<Self>) {
        if self.training != training {
            self.training = training;
            cx.notify();
        }
    }
    pub fn set_save_status(&mut self, status: u8, cx: &mut Context<Self>) {
        if self.save_status != status {
            self.save_status = status;
            cx.notify();
        }
    }
    pub fn set_save_enabled(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.save_enabled != enabled {
            self.save_enabled = enabled;
            cx.notify();
        }
    }
    pub fn save_control_focused(&self, window: &Window) -> bool {
        self.controls["header-save"].is_focused(window)
    }
    #[cfg(feature = "ui-tests")]
    pub fn save_control_focus(&self) -> FocusHandle {
        self.controls["header-save"].clone()
    }
    #[cfg(feature = "ui-tests")]
    pub fn save_enabled(&self) -> bool {
        self.save_enabled
    }
    pub fn set_output_label(&mut self, label: String, cx: &mut Context<Self>) {
        if self.output_label != label {
            self.output_label = label;
            cx.notify();
        }
    }
    pub fn set_monitor_state(
        &mut self,
        label: Option<String>,
        stopping: bool,
        attention: bool,
        cx: &mut Context<Self>,
    ) {
        if self.monitor_label != label
            || self.monitor_stopping != stopping
            || self.monitor_attention != attention
        {
            self.monitor_label = label;
            self.monitor_stopping = stopping;
            self.monitor_attention = attention;
            cx.notify();
        }
    }
    #[cfg(feature = "ui-tests")]
    pub fn monitor_state(&self) -> serde_json::Value {
        serde_json::json!({"visible":crate::integration::fixture_mode()||self.review_fixture||self.monitor_label.is_some(),
            "label":self.monitor_label,"stopping":self.monitor_stopping,"attention":self.monitor_attention})
    }
    fn monitor_control(&self, label: &str, cx: &mut Context<Self>) -> Stateful<Div> {
        let control = persistent_monitor_control(
            "header-monitor",
            label.to_owned(),
            self.monitor_attention,
            !self.monitor_stopping,
        );
        let status = self.action_control("header-monitor-status",control.status.a11y_button(label.to_owned()),HeaderEvent::Settings,cx);
        let stop = self.action_control("header-monitor-stop",control.stop.a11y_button(t("a11y.monitor.stop")),HeaderEvent::StopMonitor,cx)
            .when(true, |d| self.guides.track_box(d,"monitor-stop",[1.,0.,0.,0.]));
        control
            .shell
            .tab_group()
            .tab_stop(false)
            .child(status)
            .child(stop)
    }
    pub fn set_native_status(&mut self, ready: bool, cx: &mut Context<Self>) {
        if self.native_audio_ready != ready {
            self.native_audio_ready = ready;
            cx.notify();
        }
    }
    pub fn set_import_available(&mut self, available: bool, cx: &mut Context<Self>) {
        if self.import_available != available {
            self.import_available = available;
            cx.notify();
        }
    }
    pub fn set_review_fixture(&mut self, enabled: bool, cx: &mut Context<Self>) {
        if self.review_fixture != enabled {
            self.review_fixture = enabled;
            cx.notify();
        }
    }

    pub fn set_state(
        &mut self,
        loaded: bool,
        catalog: bool,
        title: SharedString,
        cx: &mut Context<Self>,
    ) {
        if self.loaded != loaded || self.catalog != catalog || self.title != title {
            self.loaded = loaded;
            self.catalog = catalog;
            self.title = title;
            cx.notify();
        }
    }

    /// Every right-hand pill's label width against the width it was given. A
    /// pill narrower than its label is ellipsized (a clipped control).
    #[cfg(feature = "ui-tests")]
    pub fn pill_fit(&self, window: &Window) -> serde_json::Value {
        let guide = |id: &str| match id {
            "header-save" => "save",
            "header-import" => "import",
            "header-projects" => "projects",
            "header-log" => "log",
            "header-help" => "help",
            _ => "",
        };
        let rows: Vec<_> = self
            .pill_labels
            .borrow()
            .iter()
            .map(|(id, label, ellipsizes)| {
                let run = TextRun {
                    len: label.len(),
                    font: Font { family: singz_uikit::tokens::DISPLAY_600.into(), ..Default::default() },
                    color: rgb(TEXT).into(),
                    background_color: None,
                    underline: None,
                    strikethrough: None,
                };
                // The pill's label is a tracked label (0.01 em after every character).
                let text = f32::from(window.text_system().shape_line(label.clone(), px(12.), &[run], None).width)
                    + 0.12 * label.chars().count() as f32;
                // Horizontal padding (12 px, 9 px when tight) and a 1 px border on each side.
                let padding = if window.viewport_size().width <= px(1000.) { 9. } else { 12. };
                let needed = text + 2. * (padding + 1.);
                let bounds = self.guides.get(guide(id));
                let actual = bounds.map(|b| f32::from(b.size.width));
                serde_json::json!({"id": id, "label": label.as_ref(), "text": text, "needed": needed, "actual": actual, "ellipsis": ellipsizes,
                    "left": bounds.map(|b| f32::from(b.left())), "right": bounds.map(|b| f32::from(b.right()))})
            })
            .collect();
        serde_json::Value::Array(rows)
    }
    fn button(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        action: HeaderEvent,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.action_control(
            id,
            small_ghost_pill_enabled(id,label,self.action_enabled(id))
                .line_height(px(14.)).flex_shrink_0(),
            action,
            cx,
        )
    }
    fn action_enabled(&self,id:&str)->bool {
        match id {
            "header-save"=>self.loaded && self.save_enabled,
            "header-import"=>self.loaded && (self.review_fixture || self.import_available),
            "header-projects"=>self.loaded && !self.catalog,
            "header-catalog"=>self.loaded && !self.training,
            "header-monitor-status"=>crate::integration::fixture_mode() || self.review_fixture || self.monitor_label.is_some(),
            "header-monitor-stop"=>!crate::integration::fixture_mode() && !self.review_fixture && self.monitor_label.is_some() && !self.monitor_stopping,
            _=>true,
        }
    }
    /// Persistent focus and exactly one pointer/keyboard activation path for
    /// every header action, including its specialized painters.
    fn action_control(&self,id:&'static str,control:Stateful<Div>,action:HeaderEvent,cx:&mut Context<Self>)->Stateful<Div> {
        let focus=match id {
            "header-monitor-status"=>self.monitor_status_focus.clone(),
            "header-monitor-stop"=>self.monitor_stop_focus.clone(),
            _=>self.controls[id].clone(),
        };
        let weak=cx.entity().downgrade();
        settings_control_with_focus(control,focus,self.action_enabled(id),move|_,cx| {
            let _=weak.update(cx,|header,cx| {
                if header.action_enabled(id) { cx.emit(action.clone()); }
                if matches!(id,"header-monitor-status"|"header-monitor-stop") { cx.stop_propagation(); }
            });
        })
    }

    fn right_button(
        &self,
        id: &'static str,
        label: impl Into<SharedString>,
        action: HeaderEvent,
        tight: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        let label: SharedString = label.into();
        // App.tsx's `.header-right > .pill` ellipsizes below 1100 px, but only once the
        // song title (flex 1 1 0, min-width 0) has given up all its width. The title slot
        // here does the same, and at 1060 px every locale leaves the title editor its
        // 96 px floor (the locale driver asserts both), so a pill never has to shrink.
        // An ellipsizing pill is worse
        // than none: the tracked label's measured width is quantized down to 1/64 px in
        // layout, which is smaller than the shaped width it compares against when it
        // paints, so a pill with room to spare painted "Saved ..." and "Regist...".
        #[allow(unused_mut)]
        let mut pill = self.button(id, label.clone(), action, cx).text_center();
        if tight {
            // App.tsx tightens the header again at max-width 1000px (engine chip down to
            // its dot). The 940 px minimum cannot hold Spanish's longest labels and the
            // title editor's 96 px floor otherwise, so the pills give up 3 px of padding
            // on each side there.
            pill = pill.px(px(9.));
        }
        #[cfg(feature = "ui-tests")]
        self.pill_labels
            .borrow_mut()
            .push((id, label, pill.style().text.text_overflow.is_some()));
        pill
    }

    /// Exact UK mark from Flags.tsx, keeping its independent fill colors.
    fn flag() -> Div {
        div()
            .w(px(20.))
            .h(px(14.))
            .rounded(px(3.))
            .overflow_hidden()
            .flex_none()
            .child(
                canvas(
                    |b, _, _| b,
                    |_, b, w, _| {
                        let x = b.left();
                        let y = b.top();
                        let scale = b.size.width / px(30.);
                        w.paint_quad(fill(b, rgb(0x012169)));
                        let mut stroke =
                            |segments: &[([f32; 2], [f32; 2])], thickness: f32, color: u32| {
                                let mut path = PathBuilder::stroke(px(thickness * scale));
                                for (a, z) in segments {
                                    path.move_to(point(x + px(a[0] * scale), y + px(a[1] * scale)));
                                    path.line_to(point(x + px(z[0] * scale), y + px(z[1] * scale)));
                                }
                                if let Ok(path) = path.build() {
                                    w.paint_path(path, rgb(color));
                                }
                            };
                        let diagonals = [([0., 0.], [30., 21.]), ([30., 0.], [0., 21.])];
                        stroke(&diagonals, 4., 0xffffff);
                        stroke(&diagonals, 1.6, 0xc8102e);
                        let cross = [([15., 0.], [15., 21.]), ([0., 10.5], [30., 10.5])];
                        stroke(&cross, 6., 0xffffff);
                        stroke(&cross, 3.4, 0xc8102e);
                    },
                )
                .size_full(),
            )
    }
}

impl Render for Header {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        #[cfg(feature = "ui-tests")]
        self.pill_labels.borrow_mut().clear();
        // Stop may become disabled or the entire monitor control may unmount
        // on any route. Recover only while that exact disappearing handle
        // still owns focus; never replace a later pointer/keyboard focus.
        if self.monitor_stop_focus.is_focused(window) && !self.action_enabled("header-monitor-stop")
            || self.monitor_status_focus.is_focused(window) && !self.action_enabled("header-monitor-status") {
            self.controls["header-settings"].focus(window,cx);
            cx.notify();
        }
        let available = window.viewport_size().width
            - px(if cfg!(any(target_os = "windows", target_os = "linux")) {
                134.
            } else {
                0.
            });
        let compact = available
            <= px(if cfg!(any(target_os = "windows", target_os = "linux")) {
                1200.
            } else {
                1100.
            });
        let tight = window.viewport_size().width <= px(1000.);
        let catalog = self.catalog;
        // Blink rounds this bundled face's hhea ascent/descent (930/-270,
        // UPEM1000) in device-scaled layout units before normal line spacing.
        // Align the two actual font baselines rather than custom box bottoms.
        let dpr = window.scale_factor();
        let metrics = |size: f32| {
            (
                (size * 0.93 * dpr).round() / dpr,
                (size * 0.27 * dpr).round() / dpr,
            )
        };
        let (logo_ascent, logo_descent) = metrics(17.);
        let (version_ascent, version_descent) = metrics(10.5);
        let logo_line = logo_ascent + logo_descent;
        let version_line = version_ascent + version_descent;
        let version_top = logo_ascent - version_ascent;
        div()
            .flex_1()
            .min_w_0()
            .h_full()
            .flex()
            .items_center()
            .gap(px(if compact { 8. } else { 14. }))
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_color(rgb(TEXT))
            .child(
                div()
                    .flex()
                    .items_start()
                    .flex_shrink_0()
                    .text_size(px(17.))
                    .line_height(px(logo_line))
                    .font_family("SingZ Display 800")
                    .child(singz_uikit::tracked_label("Sing", 0.02))
                    .child(
                        div()
                            .ml(px(1.))
                            .italic()
                            .text_color(rgb(ACCENT))
                            // GPUI selects our upright static face for Italic.
                            // Keep CSS's unchanged advance, but draw its exact
                            // bundled Z outline with Chromium's -.25 skew.
                            .relative()
                            .w(px(10.132))
                            .h(px(logo_line))
                            .child(
                                svg()
                                    .path("header-logo-z")
                                    .absolute()
                                    .left_0()
                                    .top_0()
                                    .w(px(13.))
                                    .h(px(20.5))
                                    .text_color(rgb(ACCENT)),
                            ),
                    )
                    .child(
                        self.guides.track(text_link("header-version", ""),"version")
                            .aria_label(format!("{} {}", crate::i18n::t("app.whatsNew.title"), if self.review_fixture {"dev"} else {crate::release_highlights::CURRENT_VERSION}))
                            .ml(px(7.))
                            .mt(px(version_top))
                            .text_size(px(10.5))
                            .line_height(px(version_line))
                            .font_family("SingZ Display 500")
                            .text_color(rgb(FAINT))
                            .child(singz_uikit::tracked_label(if self.review_fixture {"dev"} else {crate::release_highlights::CURRENT_VERSION}, 0.04))
                            .when(true,|d|self.action_control("header-version",d,HeaderEvent::WhatsNew,cx)),
                    ),
            )
            .child(
                segmented_nav()
                    .child(
                        segmented_tab("header-songs", t("app.titlebar.songs"), !self.training)
                            .when(true,|d|self.guides.track(d,"songs"))
                            .when(true,|d|self.action_control("header-songs",d,HeaderEvent::Songs,cx)),
                    )
                    .child(
                        segmented_tab("header-training", t("app.titlebar.training"), self.training)
                            .when(true, |d| self.guides.track(d, "training"))
                            .when(true,|d|self.action_control("header-training",d,HeaderEvent::Training,cx)),
                    ),
            )
            .when(self.loaded && !self.training, |d| {
                d.child(
                    self.button("header-catalog", "", HeaderEvent::Catalog, cx)
                        .when(true, |d| self.guides.track(d, "catalog"))
                        .ml(px(-4.))
                        .gap(px(7.))
                        .text_color(rgb(if catalog { ACCENT } else { TEXT }))
                        .when(catalog, |s| {
                            s.bg(rgba(0xffa02821)).border_color(rgba(0xffa0288c))
                        })
                        .child(svg().path("header-catalog").size(px(12.)).text_color(
                            rgb(if catalog { ACCENT } else { TEXT }).alpha(if catalog {
                                1.
                            } else {
                                0.75
                            }),
                        ))
                        .when(!compact, |s| {
                            s.child(singz_uikit::tracked_label(t("app.titlebar.catalog"), 0.01))
                        }),
                )
            })
            .when(self.loaded, |d| {
                d.child(
                    div()
                        .flex_1()
                        .min_w_0()
                        .overflow_hidden()
                        .flex()
                        .items_center()
                        .justify_center()
                        .gap(px(6.))
                        .text_color(rgb(DIM))
                        .text_size(px(13.))
                        .font_family("SingZ Display 500")
                        .when(self.editing, |d| {
                            d.child(
                                div()
                                    .id("header-title-editor")
                                    .w_full()
                                    .max_w(px(360_f32.min(f32::from(window.viewport_size().width) * 0.4)))
                                    .min_w_0()
                                    .on_mouse_down_out(
                                        cx.listener(|s, _, _, cx| s.commit_title(cx)),
                                    )
                                    .on_key_down(cx.listener(|s, e: &KeyDownEvent, _, cx| {
                                        if e.keystroke.key == "escape" {
                                            s.editing = false;
                                            cx.emit(HeaderEvent::TitleClosed);
                                            cx.notify();
                                            cx.stop_propagation();
                                        }
                                    }))
                                    .child(singz_uikit::title_input(
                                        &self.title_input,
                                        f32::from(window.viewport_size().width),
                                    ).accessibility_id("header-title").aria_label(t("app.titlebar.renameSong")).w_full())
                                    .when(cfg!(feature = "ui-tests"), |editor| {
                                        self.guides.track(editor, "title-editor")
                                    }),
                            )
                        })
                        .when(!self.editing, |d| {
                            d.child(div().truncate().min_w_0().child(self.title.clone()))
                                .child(self.rename_button(cx))
                        }),
                )
            })
            .child(
                div()
                    .ml_auto()
                    .flex()
                    .items_center()
                    .gap(px(if compact { 6. } else { 10. }))
                    .flex_shrink_0()
                    .when(compact, |right| right.min_w_0().flex_shrink_1())
                    .when(
                        crate::integration::fixture_mode() || self.review_fixture,
                        |right| {
                            let status_label = if crate::integration::fixture_mode() {
                                "Audio route needs attention"
                            } else if self.native_audio_ready {
                                self.output_label.as_str()
                            } else {
                                "Audio not opened"
                            };
                            right.child(
                                persistent_monitor_status(
                                    "header-monitor",
                                    status_label,
                                    crate::integration::fixture_mode(),
                                )
                                .a11y_button(status_label)
                                .when(true,|d|self.action_control("header-monitor-status",d,HeaderEvent::Settings,cx)),
                            )
                        },
                    )
                    .when(
                        !crate::integration::fixture_mode() && !self.review_fixture,
                        |right| {
                            right.when_some(self.monitor_label.clone(), |right, label| {
                                right.child(self.monitor_control(&label, cx))
                            })
                        },
                    )
                    .when(self.loaded, |d| {
                        d.child(
                            self.right_button(
                                "header-save",
                                if self.review_fixture
                                    || (!crate::integration::fixture_mode()
                                        && self.save_status == 2)
                                {
                                    t("app.save.saved")
                                } else if !crate::integration::fixture_mode()
                                    && self.save_status == 1
                                {
                                    t("app.save.saving")
                                } else {
                                    t("app.save.save")
                                },
                                HeaderEvent::Save,
                                tight,
                                cx,
                            )
                            .when(true, |button| {
                                self.guides.track_box(button, "save", [1.; 4])
                            }),
                        )
                    })
                    .when(
                        self.loaded && (self.review_fixture || self.import_available),
                        |d| {
                            d.child(
                                self.right_button(
                                    "header-import",
                                    t("app.library.add"),
                                    HeaderEvent::AddToLibrary,
                                    tight,
                                    cx,
                                )
                                .when(true, |button| {
                                    self.guides.track_box(button, "import", [1.; 4])
                                }),
                            )
                        },
                    )
                    .when(self.loaded && !self.catalog, |d| {
                        d.child(
                            self.right_button(
                                "header-projects",
                                t("app.library.open"),
                                HeaderEvent::Projects,
                                tight,
                                cx,
                            )
                            .when(true, |button| {
                                self.guides.track_box(button, "projects", [1.; 4])
                            }),
                        )
                    })
                    .when_some(self.update.clone(), |d, chip| match chip {
                        UpdateChip::Ready => d.child(
                            self.right_button("header-update", t("app.update.restart"), HeaderEvent::Update, tight, cx)
                                .aria_label(t("app.update.restartTitle")),
                        ),
                        UpdateChip::Available(version) => d.child(
                            self.right_button(
                                "header-update",
                                crate::i18n::tv("app.update.get", &[("version", version)]),
                                HeaderEvent::Update,
                                tight,
                                cx,
                            )
                            .aria_label(t("app.update.availableTitle")),
                        ),
                        UpdateChip::Downloading(percent) => d.child(
                            div()
                                .id("header-update-progress")
                                .flex_none()
                                .text_size(px(11.))
                                .text_color(rgb(FAINT))
                                .aria_label(t("app.update.downloadingTitle"))
                                .child(crate::i18n::tv("app.update.downloading", &[("percent", percent.to_string())])),
                        ),
                    })
                    .child(self.right_button(
                        "header-log",
                        t("app.titlebar.log"),
                        HeaderEvent::Log,
                        tight,
                        cx,
                    ).when(true,|d|self.guides.track_box(d,"log",[1.;4])))
                    .child(
                        status_chip("header-engine", "")
                            .aria_label(t(if crate::integration::fixture_mode() || self.engine_ready { "app.engine.ready" } else { "app.engine.setup" }))
                            .when(true, |d| self.guides.track_box(d,"engine",[1.;4]))
                            .when(compact, |chip| chip.min_w_0().flex_shrink_1())
                            .child(
                                div()
                                    .size(px(7.))
                                    .flex_none()
                                    .rounded_full()
                                    .bg(rgb(
                                        if crate::integration::fixture_mode() || self.engine_ready {
                                            0x58d68a
                                        } else {
                                            FAINT
                                        },
                                    ))
                                    .shadow(
                                        if crate::integration::fixture_mode() || self.engine_ready {
                                            vec![glow(0x58d68a, 0.7, 8.)]
                                        } else {
                                            vec![]
                                        },
                                    ),
                            )
                            .when(!compact, |d| {
                                d.child(
                                    div().child(singz_uikit::tracked_label(
                                            if crate::integration::fixture_mode()
                                                || self.engine_ready
                                            {
                                                t("app.engine.ready")
                                            } else {
                                                t("app.engine.setup")
                                            },
                                            0.02,
                                        )),
                                )
                            })
                            .when(true,|d|self.action_control("header-engine",d,HeaderEvent::Engine,cx)),
                    )
                    .child(
                        self.button("header-language", "", HeaderEvent::Language, cx)
                            .aria_label(crate::i18n::t("lang.label"))
                            .px(px(8.))
                            .when(true,|d|self.guides.track_box(d,"language",[1.;4]))
                            .child(singz_uikit::language_header_flag(crate::i18n::current().as_str())),
                    )
                    .child(self.right_button(
                        "header-help",
                        "?",
                        HeaderEvent::Help,
                        tight,
                        cx,
                    ).aria_label(crate::i18n::t("quickStart.title")).when(true,|d|self.guides.track_box(d,"help",[1.;4])))
                    .child(
                        self.button("header-settings", "", HeaderEvent::Settings, cx)
                            .aria_label(crate::i18n::t("app.titlebar.settings"))
                            .when(true, |d| self.guides.track_box(d, "settings", [1.; 4]))
                            .px(px(8.))
                            .child(
                                svg()
                                    .path("header-gear")
                                    .size(px(13.))
                                    .text_color(rgb(TEXT)),
                            ),
                    ),
            )
    }
}

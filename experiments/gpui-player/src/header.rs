//! App.tsx titlebar content; the host owns the native drag surface and reservation.
use crate::i18n::t;
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

pub struct Header {
    pub guides: singz_uikit::GuideAnchors,
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
    title_input: Entity<InputState>,
    _title_subscription: Subscription,
    #[cfg(feature = "ui-tests")]
    pub rename_bounds: std::rc::Rc<std::cell::Cell<Option<Bounds<Pixels>>>>,
}
impl EventEmitter<HeaderEvent> for Header {}

impl Header {
    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let input = cx.new(|cx| InputState::new(window, cx));
        let subscription = cx.subscribe_in(&input, window, |this, _, event, _, cx| {
            if matches!(event, InputEvent::PressEnter { .. } | InputEvent::Blur) {
                this.commit_title(cx);
            }
        });
        Self {
            guides: Default::default(),
            controls: ["header-language","header-help","header-settings","header-log","header-save","header-import","header-projects","header-catalog","header-songs","header-training","header-version","header-engine","header-rename"].into_iter().map(|id|(id,cx.focus_handle().tab_stop(true))).collect(),
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
        let value = self.title_input.read(cx).value().trim().to_owned();
        if !value.is_empty() && value != self.title.as_str() {
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
        let status = self.action_control("header-monitor-status",control.status,HeaderEvent::Settings,cx);
        let stop = self.action_control("header-monitor-stop",control.stop,HeaderEvent::StopMonitor,cx)
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
        compact: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.button(id, label, action, cx).when(compact, |button| {
            button
                .block()
                .min_w_0()
                .flex_shrink_1()
                .when(id == "header-projects", |button| button.flex_shrink_0())
                .when(id != "header-projects", |button| button.truncate())
                .text_center()
        })
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
        let tiny = available <= px(1000.);
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
                                    ).w_full())
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
                            right.child(
                                persistent_monitor_status(
                                    "header-monitor",
                                    if crate::integration::fixture_mode() {
                                        "Audio route needs attention"
                                    } else if self.native_audio_ready {
                                        self.output_label.as_str()
                                    } else {
                                        "Audio not opened"
                                    },
                                    crate::integration::fixture_mode(),
                                )
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
                                compact,
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
                                    compact,
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
                                compact,
                                cx,
                            )
                            .when(true, |button| {
                                self.guides.track_box(button, "projects", [1.; 4])
                            }),
                        )
                    })
                    .child(self.right_button(
                        "header-log",
                        t("app.titlebar.log"),
                        HeaderEvent::Log,
                        compact,
                        cx,
                    ).when(true,|d|self.guides.track_box(d,"log",[1.;4])))
                    .child(
                        status_chip("header-engine", "")
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
                            .when(!tiny, |d| {
                                d.child(
                                    div()
                                        .when(compact, |label| label.min_w_0().truncate())
                                        .child(singz_uikit::tracked_label(
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
                            .px(px(8.))
                            .when(true,|d|self.guides.track_box(d,"language",[1.;4]))
                            .child(singz_uikit::language_header_flag(crate::i18n::current().as_str())),
                    )
                    .child(self.right_button(
                        "header-help",
                        "?",
                        HeaderEvent::Help,
                        compact,
                        cx,
                    ).when(true,|d|self.guides.track_box(d,"help",[1.;4])))
                    .child(
                        self.button("header-settings", "", HeaderEvent::Settings, cx)
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

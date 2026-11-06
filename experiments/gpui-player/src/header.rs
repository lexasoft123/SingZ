//! App.tsx titlebar content; the host owns the native drag surface and reservation.
use gpui_kit::prelude::*;
use gpui_kit::*;
use singz_uikit::tokens::{ACCENT, DIM, FAINT, TEXT};
use singz_uikit::{
    glow, persistent_monitor_status, segmented_nav, segmented_tab, small_ghost_pill, status_chip,
    text_link,
};

#[derive(Clone, Copy)]
pub enum HeaderEvent {
    Catalog,
    Settings,
    Training,
    Log,
    Engine,
    Language,
    Help,
    Save,
    Projects,
    AddToLibrary,
}

pub struct Header {
    loaded: bool,
    catalog: bool,
    title: SharedString,
    review_fixture: bool,
}
impl EventEmitter<HeaderEvent> for Header {}

impl Header {
    pub fn new(_: &mut Window, _: &mut Context<Self>) -> Self {
        Self {
            loaded: false,
            catalog: true,
            title: "".into(),
            review_fixture: false,
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
        id: &'static str,
        label: &'static str,
        action: HeaderEvent,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        small_ghost_pill(id, label)
            .line_height(px(14.))
            .flex_shrink_0()
            .on_click(cx.listener(move |_, _, _, cx| cx.emit(action)))
    }

    fn right_button(
        id: &'static str,
        label: &'static str,
        action: HeaderEvent,
        compact: bool,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        Self::button(id, label, action, cx).when(compact, |button| {
            button
                .block()
                .min_w_0()
                .flex_shrink_1()
                .truncate()
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
        let available = window.viewport_size().width - px(if cfg!(any(target_os = "windows", target_os = "linux")) {134.} else {0.});
        let compact = available <= px(if cfg!(any(target_os = "windows", target_os = "linux")) {1200.} else {1100.});
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
                        text_link("header-version", "")
                            .ml(px(7.))
                            .mt(px(version_top))
                            .text_size(px(10.5))
                            .line_height(px(version_line))
                            .font_family("SingZ Display 500")
                            .text_color(rgb(FAINT))
                            .child(singz_uikit::tracked_label("dev", 0.04))
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Help))),
                    ),
            )
            .child(
                segmented_nav()
                    .child(
                        segmented_tab("header-songs", "Songs", true)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Catalog))),
                    )
                    .child(
                        segmented_tab("header-training", "Vocal training", false)
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Training))),
                    ),
            )
            .when(self.loaded, |d| {
                d.child(
                    Self::button("header-catalog", "", HeaderEvent::Catalog, cx)
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
                            s.child(singz_uikit::tracked_label("Catalog", 0.01))
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
                        .child(div().truncate().min_w_0().child(self.title.clone()))
                        .child(
                            text_link("header-rename", "✎")
                                .text_size(px(13.))
                                .font_family("SingZ Display 400")
                                .line_height(px(13.))
                                .px(px(5.))
                                .py(px(3.))
                                .rounded(px(7.))
                                .text_color(rgb(FAINT))
                                .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Save))),
                        ),
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
                    .child(
                        persistent_monitor_status(
                            "header-monitor",
                            "Audio route needs attention",
                            true,
                        )
                        .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Settings))),
                    )
                    .when(self.loaded, |d| {
                        d.child(Self::right_button(
                            "header-save",
                            if self.review_fixture {
                                "Saved ✓"
                            } else {
                                "Save"
                            },
                            HeaderEvent::Save,
                            compact,
                            cx,
                        ))
                    })
                    .when(self.loaded && self.review_fixture, |d| {
                        d.child(Self::right_button(
                            "header-import",
                            "Add to library…",
                            HeaderEvent::AddToLibrary,
                            compact,
                            cx,
                        ))
                    })
                    .when(self.loaded && !self.catalog, |d| {
                        d.child(Self::right_button(
                            "header-projects",
                            "Open…",
                            HeaderEvent::Projects,
                            compact,
                            cx,
                        ))
                    })
                    .child(Self::right_button(
                        "header-log",
                        "Log",
                        HeaderEvent::Log,
                        compact,
                        cx,
                    ))
                    .child(
                        status_chip("header-engine", "")
                            .when(compact, |chip| chip.min_w_0().flex_shrink_1())
                            .child(
                                div()
                                    .size(px(7.))
                                    .flex_none()
                                    .rounded_full()
                                    .bg(rgb(0x58d68a))
                                    .shadow(vec![glow(0x58d68a, 0.7, 8.)]),
                            )
                            .when(!tiny, |d| {
                                d.child(
                                    div()
                                        .when(compact, |label| label.min_w_0().truncate())
                                        .child(singz_uikit::tracked_label("splitter ready", 0.02)),
                                )
                            })
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(HeaderEvent::Engine))),
                    )
                    .child(
                        Self::button("header-language", "", HeaderEvent::Language, cx)
                            .px(px(8.))
                            .child(Self::flag()),
                    )
                    .child(Self::right_button(
                        "header-help",
                        "?",
                        HeaderEvent::Help,
                        compact,
                        cx,
                    ))
                    .child(
                        Self::button("header-settings", "", HeaderEvent::Settings, cx)
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

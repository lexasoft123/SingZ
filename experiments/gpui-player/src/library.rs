//! Production DropScreen composition over an isolated, read-only sample collection.
use gpui_kit::component::input::{InputEvent, InputState};
use gpui_kit::prelude::*;
use gpui_kit::*;
use singz_uikit::tokens::{DIM, FAINT, TEXT};
use singz_uikit::{catalog_delete, catalog_search, ghost_pill, production_scrollbar, text_link};
use std::{
    sync::{Arc, OnceLock},
    time::Instant,
};

/// Source-browser rounded bars plus their shadows, before the CSS scaleY.
/// Kept separately so animation transforms the complete primitive, including
/// vertical corner curvature and shadow blur, rather than resizing its box.
fn equalizer_primitives() -> &'static [Arc<RenderImage>] {
    static IMAGES: OnceLock<Vec<Arc<RenderImage>>> = OnceLock::new();
    IMAGES.get_or_init(|| {
        let atlas = image::load_from_memory(include_bytes!("../assets/equalizer-primitives.png"))
            .expect("compiled equalizer primitive atlas")
            .to_rgba8();
        (0..56)
            .map(|index| {
                let mut bar =
                    image::imageops::crop_imm(&atlas, (index % 8) * 88, (index / 8) * 268, 88, 268)
                        .to_image();
                // GPUI RenderImage expects BGRA bytes.
                for pixel in bar.pixels_mut() {
                    pixel.0.swap(0, 2);
                }
                Arc::new(RenderImage::new(vec![image::Frame::new(bar)]))
            })
            .collect()
    })
}

pub enum LibraryEvent {
    OpenSong {
        title: SharedString,
        artist: SharedString,
    },
    Browse,
    ManageStorage,
    DeleteSong {
        title: SharedString,
    },
}

struct DemoSong {
    title: &'static str,
    artist: &'static str,
    saved: &'static str,
    lyrics: bool,
}

// Original, fictional song names; never project paths or live service records.
const SONGS: [DemoSong; 12] = [
    DemoSong {
        title: "Room to breathe",
        artist: "SingZ studio",
        saved: "Nov 6",
        lyrics: true,
    },
    DemoSong {
        title: "Paper lanterns",
        artist: "Mira Vale",
        saved: "Nov 5",
        lyrics: true,
    },
    DemoSong {
        title: "A little closer",
        artist: "The morning room",
        saved: "Nov 5",
        lyrics: true,
    },
    DemoSong {
        title: "After the rain",
        artist: "June Harbour",
        saved: "Nov 4",
        lyrics: false,
    },
    DemoSong {
        title: "Golden hour",
        artist: "Mira Vale",
        saved: "Nov 3",
        lyrics: true,
    },
    DemoSong {
        title: "Slow river",
        artist: "Ellis North",
        saved: "Nov 2",
        lyrics: false,
    },
    DemoSong {
        title: "Under the same sky",
        artist: "June Harbour",
        saved: "Nov 1",
        lyrics: true,
    },
    DemoSong {
        title: "Stay for the sunrise",
        artist: "The morning room",
        saved: "Oct 30",
        lyrics: true,
    },
    DemoSong {
        title: "Quiet streets",
        artist: "Ellis North",
        saved: "Oct 28",
        lyrics: false,
    },
    DemoSong {
        title: "Find your way home",
        artist: "SingZ studio",
        saved: "Oct 26",
        lyrics: true,
    },
    DemoSong {
        title: "Small beginnings",
        artist: "Mira Vale",
        saved: "Oct 24",
        lyrics: true,
    },
    DemoSong {
        title: "Light in the window",
        artist: "June Harbour",
        saved: "Oct 20",
        lyrics: true,
    },
];

pub struct LibraryScreen {
    search: Entity<InputState>,
    query: String,
    open_song: Option<SharedString>,
    animation_epoch: Instant,
    animation_time: Option<f32>,
    scroll: ScrollHandle,
    suspended_at: Option<Instant>,
    _search_subscription: Subscription,
}

impl EventEmitter<LibraryEvent> for LibraryScreen {}

impl LibraryScreen {
    #[cfg(feature = "ui-tests")]
    pub fn review_snapshot(&self) -> serde_json::Value {
        let query = self.query.trim().to_lowercase();
        let bounds = self.scroll.bounds();
        let row = self.scroll.bounds_for_item(0);
        serde_json::json!({
            "query": self.query,
            "matches": SONGS.iter().filter(|song| query.is_empty() || song.title.to_lowercase().contains(&query)).map(|song|song.title).collect::<Vec<_>>(),
            "fixture": SONGS.iter().map(|song|serde_json::json!({"title":song.title,"artist":song.artist,"saved":song.saved,"lyrics":song.lyrics})).collect::<Vec<_>>(),
            "grid": {"x":f32::from(bounds.left()),"y":f32::from(bounds.top()),"width":f32::from(bounds.size.width),"height":f32::from(bounds.size.height),"scrollTop":-f32::from(self.scroll.offset().y),"maxScroll":f32::from(self.scroll.max_offset().y)},
            "firstRow": row.map(|r|serde_json::json!({"x":f32::from(r.left()),"y":f32::from(r.top()),"width":f32::from(r.size.width),"height":f32::from(r.size.height)}))
        })
    }

    pub fn new(window: &mut Window, cx: &mut Context<Self>) -> Self {
        let search = cx.new(|cx| InputState::new(window, cx).placeholder("Search projects…"));
        let subscription = cx.subscribe_in(&search, window, |this, state, event, _, cx| {
            if matches!(event, InputEvent::Change) {
                this.query = state.read(cx).value().to_string();
                cx.notify();
            }
        });
        Self {
            search,
            query: String::new(),
            open_song: None,
            animation_epoch: Instant::now(),
            animation_time: None,
            scroll: ScrollHandle::new(),
            suspended_at: None,
            _search_subscription: subscription,
        }
    }

    pub fn set_open_song(&mut self, title: Option<SharedString>, cx: &mut Context<Self>) {
        self.open_song = title;
        cx.notify();
    }

    /// Match the reference's paused CSS animation clock in hidden captures.
    pub fn set_animation_time(&mut self, seconds: f32, cx: &mut Context<Self>) {
        self.animation_time = Some(seconds.max(0.));
        cx.notify();
    }

    pub fn set_suspended(&mut self, suspended: bool, cx: &mut Context<Self>) {
        if self.suspended_at.is_some() != suspended {
            if suspended {
                self.suspended_at = Some(Instant::now());
            } else if let Some(paused) = self.suspended_at.take() {
                self.animation_epoch += paused.elapsed();
            }
            cx.notify();
        }
    }

    fn song_card(index: usize, palette: usize, cx: &mut Context<Self>) -> AnyElement {
        let song = &SONGS[index];
        let hues = [
            [0xf66d5c, 0xf2a83d, 0x58d68a],
            [0x5ba8f5, 0xf2a83d, 0xb58cf2],
            [0x58d68a, 0xffd97a, 0xf66d5c],
        ];
        let (month, day) = song.saved.split_once(' ').unwrap_or(("", ""));
        let meta = format!(
            "6 stems{} · {day} {month}",
            if song.lyrics { " · lyrics" } else { "" }
        );
        div()
            .relative()
            .flex_1()
            .min_w_0()
            .h(px(68.))
            .flex_shrink_0()
            .child(
                div()
                    .id(("library-song", index))
                    .size_full()
                    .flex()
                    .items_center()
                    .gap(px(12.))
                    .pl(px(11.))
                    .pr(px(38.))
                    .py(px(11.))
                    .rounded(px(15.))
                    .border_1()
                    .border_color(rgba(0xffffff0d))
                    .bg(rgba(0xffffff0b))
                    .cursor_pointer()
                    .hover(|s| s.border_color(rgb(0xffa028)))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        let song = &SONGS[index];
                        cx.emit(LibraryEvent::OpenSong {
                            title: song.title.into(),
                            artist: song.artist.into(),
                        });
                    }))
                    .child(
                        div()
                            .flex_none()
                            .size(px(44.))
                            .rounded(px(11.))
                            .bg(rgb(0x171310))
                            .flex()
                            .flex_col()
                            .justify_center()
                            .gap(px(3.5))
                            .p(px(9.))
                            .children(hues[palette % 3].into_iter().map(|color| {
                                div()
                                    .h(px(4.5))
                                    .flex_shrink_0()
                                    .w_full()
                                    .rounded(px(2.5))
                                    .bg(rgb(color))
                            })),
                    )
                    .child(
                        div()
                            .min_w_0()
                            .flex_1()
                            .flex()
                            .flex_col()
                            .gap(px(2.))
                            .child(
                                div()
                                    .truncate()
                                    .text_size(px(14.5))
                                    .line_height(px(17.5))
                                    .font_family("SingZ Display 700")
                                    .child(singz_uikit::tracked_label(song.title, -0.2 / 14.5)),
                            )
                            .child(
                                div()
                                    .text_size(px(11.5))
                                    .line_height(px(14.))
                                    .text_color(rgb(DIM))
                                    .child(meta),
                            ),
                    ),
            )
            .child(
                catalog_delete(("library-delete", index))
                    .absolute()
                    .right(px(7.))
                    .top(px(22.5))
                    .on_click(cx.listener(move |_, _, _, cx| {
                        cx.emit(LibraryEvent::DeleteSong {
                            title: SONGS[index].title.into(),
                        });
                    })),
            )
            .into_any_element()
    }

    fn equalizer(time: f32) -> Div {
        div()
            .h(px(110.))
            .flex_shrink_0()
            .flex()
            .items_center()
            .justify_center()
            .gap(px(3.))
            .children((0..56).map(|i| {
                let delay = (i as f32 * 0.137) % 1.4;
                let elapsed = (time - delay).max(0.) / 1.5;
                let phase = if elapsed as usize % 2 == 0 {
                    elapsed.fract()
                } else {
                    1. - elapsed.fract()
                };
                // CSS ease-in-out = cubic-bezier(.42,0,.58,1).
                let mut lo = 0.;
                let mut hi = 1.;
                for _ in 0..16 {
                    let t = (lo + hi) * 0.5;
                    let x = 3. * (1. - t) * (1. - t) * t * 0.42
                        + 3. * (1. - t) * t * t * 0.58
                        + t * t * t;
                    if x < phase {
                        lo = t;
                    } else {
                        hi = t;
                    }
                }
                let t = (lo + hi) * 0.5;
                // The CSS animation has no backwards fill: before a bar's
                // positive delay it keeps its untransformed full height.
                let scale = if time < delay {
                    1.
                } else {
                    0.3 + 0.7 * (3. * t * t - 2. * t * t * t)
                };
                div().w(px(4.)).h(px(110.)).flex_none().child(
                    canvas(
                        |bounds, _, _| bounds,
                        move |bounds, _, window, _| {
                            let texture = equalizer_primitives()[i].clone();
                            let image_bounds = Bounds::new(
                                point(bounds.left() - px(20.), bounds.center().y - px(67. * scale)),
                                size(px(44.), px(134. * scale)),
                            );
                            let _ = window.paint_image(
                                image_bounds,
                                image_bounds,
                                Corners::default(),
                                texture,
                                0,
                                false,
                            );
                        },
                    )
                    .size_full(),
                )
            }))
    }
}

impl Render for LibraryScreen {
    fn render(&mut self, window: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let query = self.query.trim().to_lowercase();
        let indices: Vec<usize> = SONGS
            .iter()
            .enumerate()
            .filter(|(_, song)| query.is_empty() || song.title.to_lowercase().contains(&query))
            .map(|(index, _)| index)
            .collect();
        let width = (f32::from(window.viewport_size().width) - 80.)
            .min(880.)
            .max(240.);
        let columns = ((width - 14. + 12.) / 252.).floor().max(1.) as usize;
        let rows: Vec<AnyElement> = indices
            .chunks(columns)
            .enumerate()
            .map(|(row_index, chunk)| {
                let mut row = div().flex().gap(px(12.)).h(px(68.)).flex_shrink_0();
                for (column, &index) in chunk.iter().enumerate() {
                    row = row.child(Self::song_card(index, row_index * columns + column, cx));
                }
                for _ in chunk.len()..columns {
                    row = row.child(div().flex_1().min_w_0());
                }
                row.into_any_element()
            })
            .collect();
        // Chromium reserves its 10px vertical scrollbar only when content
        // overflows; a single search result keeps only .lib-grid's 4px padding.
        let content_height = if indices.is_empty() {
            12. * 1.6 + 28. // .drop-screen p.fine: line-height1.6 + margin-bottom28.
        } else {
            rows.len() as f32 * 68. + rows.len().saturating_sub(1) as f32 * 12.
        };
        let gutter = if content_height > f32::from(self.scroll.bounds().size.height) {
            10.
        } else {
            0.
        };
        let time = self.animation_time.unwrap_or_else(|| {
            self.suspended_at
                .unwrap_or_else(Instant::now)
                .duration_since(self.animation_epoch)
                .as_secs_f32()
        });
        if self.animation_time.is_none() && self.suspended_at.is_none() {
            window.request_animation_frame();
        }
        let description = match self.open_song.as_ref() {
            Some(song) => format!("Pick a project below, or drop another song anywhere in this window — “{song}” stays loaded until you do."),
            None => "MP3, WAV, FLAC or M4A — SingZ splits it into vocals, drums, bass & instruments you can mute while you sing.".to_owned(),
        };
        let description_height = if self.open_song.is_some() { 72. } else { 48. };
        // Match DropScreen's min-height:0 flex negotiation, including its
        // zero-height card viewport at 1060×640. The outer page stays scrollable.
        div()
            .id("library-screen")
            .w_full()
            .flex_1()
            .min_h_0()
            .overflow_y_scroll()
            .font_family("SingZ Display 400")
            .font_weight(FontWeight::NORMAL)
            .text_color(rgb(TEXT))
            .flex()
            .flex_col()
            .items_center()
            .p(px(40.))
            .child(
                div()
                    .w(px(520.))
                    .max_w_full()
                    .h(px(321.5 + description_height))
                    .flex_shrink_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .child(Self::equalizer(time).w_full().mb(px(40.)))
                    .child(
                        div()
                            .w_full()
                            .h(px(62.5))
                            .flex()
                            .items_center()
                            .justify_center()
                            .text_center()
                            .text_size(px(52.))
                            .line_height(px(62.5))
                            .font_family("SingZ Display 800")
                            .mb(px(14.))
                            .child(singz_uikit::tracked_text(
                                if self.open_song.is_some() {
                                    "Your catalog."
                                } else {
                                    "Drop a song."
                                },
                                "SingZ Display 800",
                                52.,
                                -0.52,
                                TEXT,
                            )),
                    )
                    .child(
                        div()
                            .w_full()
                            .h(px(description_height))
                            .text_center()
                            .text_size(px(15.))
                            .line_height(px(24.))
                            .text_color(rgb(DIM))
                            .mb(px(28.))
                            .child(singz_uikit::tracked_label(description, 0.).wrap()),
                    )
                    .child(
                        ghost_pill("library-browse", "Browse files…")
                            .text_size(px(14.))
                            .line_height(px(16.5))
                            .h(px(36.5))
                            .flex_shrink_0()
                            .on_click(cx.listener(|_, _, _, cx| cx.emit(LibraryEvent::Browse))),
                    )
                    .child(
                        div()
                            .mt(px(16.))
                            .text_size(px(12.))
                            .line_height(px(14.5))
                            .text_color(rgb(FAINT))
                            .child(if self.open_song.is_some() {
                                "or press Esc to go back to your song"
                            } else {
                                "or drag it anywhere into this window"
                            }),
                    ),
            )
            .child(
                div()
                    .w(px(width))
                    .mt(px(30.))
                    .pt(px(20.))
                    .border_t_1()
                    .border_color(rgba(0xfff0d614))
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .child(
                        div()
                            .h(px(29.))
                            .flex_shrink_0()
                            .flex()
                            .items_center()
                            .justify_between()
                            .gap(px(14.))
                            .mb(px(6.))
                            .child(
                                div()
                                    .mb(px(2.))
                                    .text_size(px(10.5))
                                    .line_height(px(13.))
                                    .font_family("SingZ Display 700")
                                    .text_color(rgb(FAINT))
                                    .child(singz_uikit::tracked_text(
                                        "YOUR PROJECTS",
                                        "SingZ Display 700",
                                        10.5,
                                        1.47,
                                        FAINT,
                                    )),
                            )
                            // The production title is width:100%; flex-shrink
                            // resolves its nominal 200px input to this DOM width.
                            .child(catalog_search(&self.search).w(px(164.671875)).h(px(29.))),
                    )
                    .child(
                        div()
                            .flex_shrink_0()
                            .h(px(53.5))
                            .w_full()
                            .rounded(px(13.))
                            .border_1()
                            .border_color(rgba(0xffffff0d))
                            .bg(rgba(0xffffff09))
                            .mb(px(14.))
                            .flex()
                            .items_center()
                            .gap(px(12.))
                            .px(px(14.))
                            .py(px(10.))
                            .child(
                                div()
                                    .min_w_0()
                                    .flex_1()
                                    .flex()
                                    .flex_col()
                                    .gap(px(2.))
                                    .child(
                                        div()
                                            .flex()
                                            .items_center()
                                            .gap(px(6.))
                                            .overflow_hidden()
                                            .whitespace_nowrap()
                                            .h(px(16.5))
                                            .text_size(px(12.5))
                                            .line_height(px(15.))
                                            .text_color(rgb(TEXT))
                                            .opacity(0.9)
                                            // Chromium's emoji fallback advance is exactly one em
                                            // (12.5px); CoreText's color-glyph advance is wider.
                                            // Preserve the source flex-item width without scaling ink.
                                            .child(div().w(px(12.5)).flex_none().child("📁"))
                                            .child("Demo › SingZ"),
                                    )
                                    .child(
                                        div()
                                            .text_size(px(11.))
                                            .line_height(px(13.))
                                            .text_color(rgb(DIM))
                                            .child(
                                                "Your library lives here · On this computer only",
                                            ),
                                    ),
                            )
                            .child(text_link("library-storage", "Change…").on_click(
                                cx.listener(|_, _, _, cx| cx.emit(LibraryEvent::ManageStorage)),
                            )),
                    )
                    .child(
                        div()
                            .relative()
                            .flex_1()
                            .min_h_0()
                            .child(
                                div()
                                    .id("library-grid")
                                    .size_full()
                                    .overflow_y_scroll()
                                    .track_scroll(&self.scroll)
                                    .pr(px(gutter + 4.))
                                    .flex()
                                    .flex_col()
                                    .gap(px(12.))
                                    .children(rows)
                                    .when(indices.is_empty(), |d| {
                                        d.child(
                                            div()
                                                .flex_shrink_0()
                                                .w(px((width
                                                    - gutter
                                                    - 4.
                                                    - (columns - 1) as f32 * 12.)
                                                    / columns as f32))
                                                .text_size(px(12.))
                                                .line_height(px(19.2))
                                                .mb(px(28.))
                                                .text_color(rgb(FAINT))
                                                .child(format!(
                                                    "Nothing matches “{}”.",
                                                    self.query.trim()
                                                )),
                                        )
                                    }),
                            )
                            .child(production_scrollbar(&self.scroll)),
                    ),
            )
    }
}

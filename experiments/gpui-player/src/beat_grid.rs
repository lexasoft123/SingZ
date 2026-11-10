//! Static source beat-grid paint. Shared cached marks keep the playback clock
//! from resampling the beat document in every lane on every animation frame.
use crate::beat::Beats;
use gpui_kit::*;
use gpui_kit::prelude::FluentBuilder;
use std::{
    cell::{Cell, RefCell},
    rc::Rc,
};
struct Mark {
    x: f32,
    time: f64,
    bar: Option<i64>,
    mine: bool,
    odd: bool,
    label: bool,
    text: Option<ShapedLine>,
}
#[derive(Default)]
pub struct Cache {
    grid: Option<Rc<Beats>>,
    geometry: Option<[u64; 4]>,
    marks: Vec<Mark>,
    ghost: Option<f64>,
}
impl Cache {
    fn marks(
        &mut self,
        g: &Rc<Beats>,
        start: f64,
        end: f64,
        width: f32,
        scale: f32,
    ) -> &mut [Mark] {
        let geometry = [
            start.to_bits(),
            end.to_bits(),
            width.to_bits() as u64,
            scale.to_bits() as u64,
        ];
        if self.grid.as_ref().is_some_and(|old| Rc::ptr_eq(old, g))
            && self.geometry == Some(geometry)
        {
            return &mut self.marks;
        }
        self.grid = Some(g.clone());
        self.geometry = Some(geometry);
        self.marks.clear();
        let span = (end - start) as f64;
        if span <= 0. || width < 2. {
            return &mut self.marks;
        }
        let per_beat = width as f64 / span * 60. / g.bpm;
        let beats = per_beat >= 5.;
        let mut stride = 1;
        while per_beat * g.beats_per_bar as f64 * (stride as f64) < 16. && stride < 64 {
            stride *= 2;
        }
        let tol = 60. / g.bpm * 0.5;
        let near = |list: &Option<Vec<f64>>, time: f64| {
            list.as_ref().is_some_and(|v| {
                let i = v.partition_point(|t| *t < time - tol);
                v.get(i).is_some_and(|t| *t <= time + tol)
            })
        };
        let mut label_x = -1e9;
        for i in g.beats.partition_point(|t| *t < start as f64)..g.beats.len() {
            let t = g.beats[i];
            if t > end as f64 {
                break;
            }
            let down = g.accent_index(i as i64) == 0;
            if !down && !beats {
                continue;
            }
            let mine = down && near(&g.user_bars, t);
            let odd = down && near(&g.suspect_at, t);
            let bar = down.then(|| g.bar_number(i as i64));
            if let Some(bar) = bar {
                if !mine && !odd && stride > 1 && (bar - 1).rem_euclid(stride) != 0 {
                    continue;
                }
            }
            let x = (((t - start as f64) / span * width as f64 * scale as f64).round()
                / scale as f64) as f32;
            let label = down && x - label_x >= 34.;
            if label {
                label_x = x;
            }
            self.marks.push(Mark {
                x,
                time: t,
                bar,
                mine,
                odd,
                label,
                text: None,
            });
        }
        &mut self.marks
    }

    fn handles(
        &mut self,
        g: &Rc<Beats>,
        start: f64,
        end: f64,
        width: f32,
        scale: f32,
    ) -> Vec<Handle> {
        self.marks(g, start, end, width, scale)
            .iter()
            .filter_map(|mark| {
                Some(Handle {
                    time: mark.time,
                    x: mark.x,
                    bar: mark.bar?,
                })
            })
            .collect()
    }
}
pub fn paint(
    cache: &mut Cache,
    g: &Rc<Beats>,
    start: f64,
    end: f64,
    b: Bounds<Pixels>,
    ruler: bool,
    w: &mut Window,
    cx: &mut App,
) {
    let scale = w.scale_factor().min(2.);
    let hair = px(1. / scale);
    for m in cache.marks(g, start, end, f32::from(b.size.width), scale) {
        let x = b.left() + px(m.x);
        if !ruler {
            w.paint_quad(fill(
                Bounds::new(
                    point(x, b.top()),
                    size(
                        if m.bar.is_some() { hair * 2. } else { hair },
                        b.size.height,
                    ),
                ),
                singz_uikit::canvas_color(
                    rgba(if m.mine {
                        0x78dc96bf
                    } else if m.bar.is_some() {
                        0xffa02847
                    } else {
                        0xfff0d61a
                    })
                    .into(),
                ),
            ));
            continue;
        }
        if m.odd && !m.mine {
            let mut p = PathBuilder::fill();
            p.move_to(point(x - px(3.5), b.top() + px(2.)));
            p.line_to(point(x + px(3.5), b.top() + px(2.)));
            p.line_to(point(x, b.top() + px(8.)));
            p.close();
            if let Ok(path) = p.build() {
                w.paint_path(path, rgba(0xe84a4ae6));
            }
        }
        if let Some(bar) = m.bar.filter(|_| m.label) {
            let label = bar.to_string();
            let line = m.text.get_or_insert_with(|| {
                w.text_system().shape_line(
                    label.clone().into(),
                    px(9.),
                    &[TextRun {
                        len: label.len(),
                        font: Font {
                            family: singz_uikit::tokens::MONO_400.into(),
                            ..Default::default()
                        },
                        color: rgba(if m.mine { 0x78dc96d9 } else { 0xffa0286b }).into(),
                        background_color: None,
                        underline: None,
                        strikethrough: None,
                    }],
                    None,
                )
            });
            let h = line.ascent + line.descent;
            let y = b.bottom() - px(5.) - w.text_baseline(line.ascent, line.descent, h);
            let _ = line.paint(point(x + px(3.), y), h, TextAlign::Left, None, w, cx);
        }
    }
    if let Some(time) = cache.ghost.filter(|_| end > start) {
        let x = (((time - start as f64) / (end - start) as f64
            * f64::from(f32::from(b.size.width))
            * scale as f64)
            .round()
            / scale as f64) as f32;
        w.paint_quad(fill(
            Bounds::new(
                point(b.left() + px(x), b.top()),
                size(hair * 2., b.size.height),
            ),
            singz_uikit::canvas_color(rgba(0x78dc96f2).into()),
        ));
    }
}

/// Exactly the bar lines surviving the paint cache's thinning rules. Hit testing
/// uses this same projection, so a hidden/thinned line can never be grabbed.
#[derive(Clone, Copy, Debug)]
pub struct Handle {
    pub time: f64,
    pub x: f32,
    pub bar: i64,
}

#[derive(Clone, Copy, Debug)]
pub enum Event {
    Move { from: f64, to: f64 },
    Clear { time: f64 },
    Preview,
}

#[derive(Clone, Copy)]
struct Drag {
    from: f64,
    to: f64,
}

fn hit_handle(handles: &[Handle], x: f32) -> Option<Handle> {
    handles
        .iter()
        .copied()
        .filter(|h| (h.x - x).abs() <= 9.)
        .min_by(|a, b| (a.x - x).abs().total_cmp(&(b.x - x).abs()))
}

fn snapped_time(grid: &Beats, start: f64, end: f64, width: f32, x: f32) -> Option<f64> {
    if width <= 0. || end <= start || !x.is_finite() {
        return None;
    }
    let time = start as f64 + (x as f64 / width as f64).clamp(0., 1.) * (end - start) as f64;
    grid.nearest_beat(time).map(|i| grid.beats[i])
}

/// Transparent, ruler-only editing strip. Waveform lanes keep their own scrub
/// handlers; only an actual bar grab consumes the ruler's mouse down. Window-
/// local capture listeners keep a drag alive outside the 30px ruler strip.
pub struct Handles {
    grid: Option<Rc<Beats>>,
    start: f64,
    end: f64,
    cache: Rc<RefCell<Cache>>,
    bounds: Rc<Cell<Option<Bounds<Pixels>>>>,
    drawn: Rc<RefCell<Vec<Handle>>>,
    drag: Option<Drag>,
}
impl EventEmitter<Event> for Handles {}
impl Handles {
    pub fn new(cache: Rc<RefCell<Cache>>) -> Self {
        Self {
            grid: None,
            start: 0.,
            end: 0.,
            cache,
            bounds: Default::default(),
            drawn: Default::default(),
            drag: None,
        }
    }

    pub fn set_context(
        &mut self,
        grid: Option<Rc<Beats>>,
        start: f64,
        end: f64,
        _duration: f64,
        cx: &mut Context<Self>,
    ) {
        let same = match (&self.grid, &grid) {
            (Some(old), Some(new)) => Rc::ptr_eq(old, new),
            (None, None) => true,
            _ => false,
        } && self.start == start
            && self.end == end;
        if same {
            return;
        }
        self.grid = grid;
        self.start = start;
        self.end = end;
        self.drag = None;
        self.cache.borrow_mut().ghost = None;
        self.bounds.set(None);
        self.drawn.borrow_mut().clear();
        cx.notify();
    }

    #[cfg(feature = "ui-tests")]
    pub fn bounds(&self) -> Option<Bounds<Pixels>> {
        self.bounds.get()
    }
    #[cfg(feature = "ui-tests")]
    pub fn drawn(&self) -> Vec<Handle> {
        self.drawn.borrow().clone()
    }
    #[cfg(feature = "ui-tests")]
    pub fn snapshot(&self) -> (Option<Bounds<Pixels>>, Vec<Handle>) {
        (self.bounds(), self.drawn())
    }
    #[cfg(feature = "ui-tests")]
    pub fn ghost(&self) -> Option<f64> {
        self.cache.borrow().ghost
    }

    fn update_drag(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) {
        let (Some(drag), Some(grid), Some(bounds)) =
            (self.drag.as_mut(), self.grid.as_ref(), self.bounds.get())
        else {
            return;
        };
        let Some(time) = snapped_time(
            grid,
            self.start,
            self.end,
            f32::from(bounds.size.width),
            f32::from(position.x - bounds.left()),
        ) else {
            return;
        };
        if drag.to == time {
            return;
        }
        drag.to = time;
        self.cache.borrow_mut().ghost = Some(time);
        cx.emit(Event::Preview);
        cx.notify();
    }

    fn finish(&mut self, position: Point<Pixels>, cx: &mut Context<Self>) -> bool {
        if self.drag.is_none() {
            return false;
        }
        self.update_drag(position, cx);
        let drag = self.drag.take().unwrap();
        self.cache.borrow_mut().ghost = None;
        if (drag.from - drag.to).abs() > 1e-6 {
            cx.emit(Event::Move {
                from: drag.from,
                to: drag.to,
            });
        }
        cx.emit(Event::Preview);
        cx.notify();
        true
    }
}

impl Render for Handles {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let bounds = self.bounds.clone();
        let drawn = self.drawn.clone();
        let cache = self.cache.clone();
        let grid = self.grid.clone();
        let start = self.start;
        let end = self.end;
        let weak = cx.entity().downgrade();
        div()
            .id("beat-bar-handles")
            .absolute()
            .top_0()
            .left_0()
            .size_full()
            .when(self.grid.is_none(), |strip| strip.hidden())
            .cursor(if self.drag.is_some() {
                CursorStyle::ClosedHand
            } else {
                CursorStyle::ResizeLeftRight
            })
            .on_mouse_down(
                MouseButton::Left,
                cx.listener(|this, event: &MouseDownEvent, _, cx| {
                    let Some(bounds) = this.bounds.get() else {
                        return;
                    };
                    let Some(handle) = hit_handle(
                        &this.drawn.borrow(),
                        f32::from(event.position.x - bounds.left()),
                    ) else {
                        return;
                    };
                    cx.stop_propagation();
                    if event.modifiers.alt {
                        cx.emit(Event::Clear { time: handle.time });
                        return;
                    }
                    this.drag = Some(Drag {
                        from: handle.time,
                        to: handle.time,
                    });
                    this.cache.borrow_mut().ghost = Some(handle.time);
                    cx.emit(Event::Preview);
                    cx.notify();
                }),
            )
            .child(
                canvas(
                    move |b, _, _| {
                        bounds.set(Some(b));
                        b
                    },
                    move |_, b, w, cx| {
                        *drawn.borrow_mut() = grid
                            .as_ref()
                            .map(|g| {
                                cache.borrow_mut().handles(
                                    g,
                                    start,
                                    end,
                                    f32::from(b.size.width),
                                    w.scale_factor().min(2.),
                                )
                            })
                            .unwrap_or_default();
                        let moving = weak.clone();
                        w.on_mouse_event(move |event: &MouseMoveEvent, phase, _, cx| {
                            if phase != DispatchPhase::Capture {
                                return;
                            }
                            let _ = moving.update(cx, |this, cx| {
                                if this.drag.is_none() {
                                    return;
                                }
                                this.update_drag(event.position, cx);
                                cx.stop_propagation();
                            });
                        });
                        let ending = weak.clone();
                        w.on_mouse_event(move |event: &MouseUpEvent, phase, _, cx| {
                            if phase != DispatchPhase::Capture || event.button != MouseButton::Left
                            {
                                return;
                            }
                            let _ = ending.update(cx, |this, cx| {
                                if this.finish(event.position, cx) {
                                    cx.stop_propagation();
                                }
                            });
                        });
                    },
                )
                .size_full(),
            )
    }
}

#[cfg(test)]
mod handle_tests {
    use super::*;
    #[::core::prelude::v1::test]
    fn ruler_grabs_only_visible_nearest_bar_within_nine_pixels() {
        let handles = [
            Handle {
                time: 1.,
                x: 20.,
                bar: 1,
            },
            Handle {
                time: 2.,
                x: 36.,
                bar: 2,
            },
        ];
        assert_eq!(hit_handle(&handles, 11.).unwrap().time, 1.);
        assert!(hit_handle(&handles, 10.99).is_none());
        assert_eq!(hit_handle(&handles, 30.).unwrap().time, 2.);
    }
    #[::core::prelude::v1::test]
    fn ghost_snaps_to_beats_and_clamps_outside_ruler() {
        let grid = Beats::sanitize(
            &serde_json::json!({"beats":[0.,0.5,1.,1.5,2.],"bpm":120,"beatsPerBar":4,"downbeat":0}),
        )
        .unwrap();
        assert_eq!(snapped_time(&grid, 0., 2., 200., -50.), Some(0.));
        assert_eq!(snapped_time(&grid, 0., 2., 200., 75.), Some(0.5));
        assert_eq!(snapped_time(&grid, 0., 2., 200., 999.), Some(2.));
        assert_eq!(snapped_time(&grid, 0., 2., 0., 75.), None);
    }
}

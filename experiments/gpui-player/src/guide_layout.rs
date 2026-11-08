//! Native counterpart of shared/quick-start/placement.ts.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Rect {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub height: f32,
}
#[derive(Clone, Copy, Debug)]
pub struct Viewport {
    pub width: f32,
    pub height: f32,
    pub top: f32,
    pub bottom: f32,
}
#[derive(Clone, Copy, Debug, PartialEq)]
pub enum Side {
    None,
    Top,
    Bottom,
    Left,
    Right,
}
#[derive(Clone, Copy, Debug)]
pub struct Placement {
    pub left: f32,
    pub top: f32,
    pub width: f32,
    pub max_height: f32,
    pub side: Side,
    pub arrow: f32,
}
pub fn place(rect: Option<Rect>, v: Viewport, measured: f32) -> Placement {
    let gap = 14.;
    let min_y = v.top + gap;
    let max_y = v.height - v.bottom - gap;
    let width = 360_f32.min(v.width - gap * 2.);
    let height = measured.min(max_y - min_y);
    let clamp_x = |x: f32| gap.max(x.min(v.width - width - gap));
    let Some(r) = rect else {
        return Placement {
            left: clamp_x((v.width - width) / 2.),
            top: min_y.max((max_y + min_y - height) / 2.),
            width,
            max_height: max_y - min_y,
            side: Side::None,
            arrow: 0.,
        };
    };
    let center_x = r.left + r.width / 2.;
    let center_y = r.top + r.height / 2.;
    let mut side = Side::Top;
    let mut left = clamp_x(center_x - width / 2.);
    let mut top = r.top + r.height + gap;
    if top + height > max_y {
        if r.top - gap - height >= min_y {
            top = r.top - gap - height;
            side = Side::Bottom;
        } else if r.left + r.width + gap + width <= v.width - gap {
            left = r.left + r.width + gap;
            top = min_y.max((center_y - height / 2.).min(max_y - height));
            side = Side::Left;
        } else if r.left - gap - width >= gap {
            left = r.left - gap - width;
            top = min_y.max((center_y - height / 2.).min(max_y - height));
            side = Side::Right;
        } else {
            let below = max_y - r.top - r.height - gap;
            let above = r.top - gap - min_y;
            side = if below >= above {
                Side::Top
            } else {
                Side::Bottom
            };
            let room = 48_f32.max(if below >= above { below } else { above });
            top = if side == Side::Top {
                r.top + r.height + gap
            } else {
                min_y.max(r.top - gap - height.min(room))
            };
            return Placement {
                left,
                top,
                width,
                max_height: room,
                side,
                arrow: 20_f32.max((center_x - left).min(width - 20.)),
            };
        }
    }
    Placement {
        left,
        top,
        width,
        max_height: max_y - top,
        side,
        arrow: 20_f32.max(
            (if matches!(side, Side::Top | Side::Bottom) {
                center_x - left
            } else {
                center_y - top
            })
            .min(
                (if matches!(side, Side::Top | Side::Bottom) {
                    width
                } else {
                    height
                }) - 20.,
            ),
        ),
    }
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn source_placement_cases_keep_balloon_visible_without_covering_target() {
        for (w, h, top, bottom, r, height) in [
            (
                1240.,
                800.,
                0.,
                0.,
                Rect {
                    left: 550.,
                    top: 385.,
                    width: 140.,
                    height: 45.,
                },
                250.,
            ),
            (
                1240.,
                800.,
                0.,
                0.,
                Rect {
                    left: 20.,
                    top: 740.,
                    width: 44.,
                    height: 44.,
                },
                250.,
            ),
            (
                390.,
                844.,
                59.,
                34.,
                Rect {
                    left: 20.,
                    top: 120.,
                    width: 350.,
                    height: 44.,
                },
                270.,
            ),
            (
                390.,
                844.,
                59.,
                34.,
                Rect {
                    left: 200.,
                    top: 720.,
                    width: 170.,
                    height: 60.,
                },
                290.,
            ),
            (
                390.,
                844.,
                59.,
                34.,
                Rect {
                    left: 30.,
                    top: 310.,
                    width: 330.,
                    height: 110.,
                },
                440.,
            ),
            (
                844.,
                390.,
                0.,
                21.,
                Rect {
                    left: 14.,
                    top: 100.,
                    width: 44.,
                    height: 44.,
                },
                280.,
            ),
        ] {
            let p = place(
                Some(r),
                Viewport {
                    width: w,
                    height: h,
                    top,
                    bottom,
                },
                height,
            );
            let vh = height.min(p.max_height);
            assert!(
                p.left >= 0. && p.top >= top && p.left + p.width <= w && p.top + vh <= h - bottom
            );
            let overlap_x = (p.left + p.width).min(r.left + r.width) > p.left.max(r.left);
            let overlap_y = (p.top + vh).min(r.top + r.height) > p.top.max(r.top);
            assert!(!(overlap_x && overlap_y), "{p:?} {r:?}");
            assert_ne!(p.side, Side::None);
        }
    }
    #[test]
    fn welcome_centers_and_bottom_transport_uses_upward_arrow() {
        let v = Viewport {
            width: 1280.,
            height: 800.,
            top: 0.,
            bottom: 0.,
        };
        let p = place(None, v, 260.);
        assert_eq!((p.left, p.top, p.width), (460., 270., 360.));
        let p = place(
            Some(Rect {
                left: 20.,
                top: 740.,
                width: 44.,
                height: 44.,
            }),
            v,
            250.,
        );
        assert_eq!(p.side, Side::Bottom);
        assert_eq!(p.top, 476.);
        assert_eq!(p.arrow, 28.);
    }
}

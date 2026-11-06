//! Native Mac traffic lights over the app's 52px header. No separate AppKit title strip.
use gpui_kit::*;
use std::{cell::Cell, rc::Rc};

pub fn options() -> WindowOptions {
    let mut options = WindowOptions::default();
    #[cfg(target_os = "macos")]
    {
        options.titlebar = Some(TitlebarOptions {
            title: Some("SingZ · GPUI player".into()),
            appears_transparent: true,
            // Native buttons are 14px high: 19 + 14 + 19 = our 52px header.
            traffic_light_position: Some(point(px(18.), px(19.))),
        });
        // One owner for dragging/double clicks; don't let AppKit repeat our action.
        options.app_owns_titlebar_drag = true;
    }
    options
}

pub fn header(armed: Rc<Cell<bool>>, fullscreen: bool) -> Stateful<Div> {
    let down = armed.clone();
    let up = armed.clone();
    let outside = armed.clone();
    div()
        .id("window-header")
        .h(px(52.))
        .flex_shrink_0()
        .px(px(16.))
        .pl(px(if cfg!(target_os = "macos") && !fullscreen {
            92.
        } else {
            16.
        }))
        .flex()
        .gap(px(14.))
        .items_center()
        .border_b_1()
        .border_color(rgba(0xfff0d614))
        .on_mouse_down(MouseButton::Left, move |_, _, _| down.set(true))
        .on_mouse_up(MouseButton::Left, move |_, _, _| up.set(false))
        .on_mouse_down_out(move |_, _, _| outside.set(false))
        .on_mouse_move(move |event, window, _| {
            if armed.replace(false) && event.pressed_button == Some(MouseButton::Left) {
                window.start_window_move();
            }
        })
        .on_click(|event, window, _| {
            if event.click_count() == 2 {
                #[cfg(target_os = "macos")]
                window.titlebar_double_click();
                #[cfg(not(target_os = "macos"))]
                window.zoom_window();
            }
        })
}

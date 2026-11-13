//! Song shortcut ownership mirrors renderer/keyboard.ts, independently of focus styling.
use super::*;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Owner {
    Song,
    TextEntry,
    Slider,
    Dialog,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Shortcut {
    Toggle,
    Seek(i8),
}

pub fn shortcut(key: &str, owner: Owner) -> Option<Shortcut> {
    if matches!(owner, Owner::TextEntry | Owner::Dialog) {
        return None;
    }
    match key {
        "space" => Some(Shortcut::Toggle),
        "left" if owner != Owner::Slider => Some(Shortcut::Seek(-5)),
        "right" if owner != Owner::Slider => Some(Shortcut::Seek(5)),
        _ => None,
    }
}

/// Capture before ordinary button handlers can treat Space as activation. Text
/// actions may dispatch before raw keys; the explicit ownership checks also
/// protect controls whose editing keys are handled directly.
pub(super) fn capture(
    p: &mut Player,
    event: &KeyDownEvent,
    w: &mut Window,
    cx: &mut Context<Player>,
) {
    if p.backend.is_none() || p.screen != Screen::Player || p.source_blocks_except_rate() {
        return;
    }
    // The owner list is `Player::active_layers` (paint order, `overlay_gate`); a page keeps its own keys.
    let dialog = !p.active_layers(cx).without(crate::overlay_gate::Layer::Page).is_empty()
        || p.quick_start.read(cx).is_open()
        || p.carry_open
        || p.transport.read(cx).has_popover();
    let text = p.track_rename.is_some()
        || p.header.read(cx).is_editing()
        || p.header.read(cx).title_input_focused(w, cx)
        || p.track_name_input.read(cx).focus_handle(cx).is_focused(w)
        || p.transport.read(cx).bpm_focused(w, cx)
        || p.metronome_open && p.metronome_ui.read(cx).focused(w, cx)
        || p.karaoke && p.lyrics_sidebar.read(cx).input_focused(w, cx);
    let owner = if dialog {
        Owner::Dialog
    } else if text {
        Owner::TextEntry
    } else if p.track_gain_focus.iter().any(|focus| focus.is_focused(w))
        || p.metronome_open && p.metronome_ui.read(cx).volume_focused(w) {
        Owner::Slider
    } else {
        Owner::Song
    };
    let Some(action) = shortcut(&event.keystroke.key, owner) else {
        return;
    };
    w.prevent_default();
    if action == Shortcut::Toggle {
        // Browser source blurs an activatable ancestor so its keyup cannot
        // click it. Moving app-local focus to the song root has that effect
        // without activating the native window or changing global focus.
        if owner != Owner::Slider {
            p.focus_handle.focus(w, cx);
        }
        p.native_transport(transport::TransportEvent::Play, cx);
    } else if let Shortcut::Seek(delta) = action {
        p.playhead.seek((p.playhead.position() + delta as f64).clamp(0., p.duration));
        p.seek_native(cx);
    }
    cx.stop_propagation();
}

#[cfg(test)]
mod tests {
    use super::{Owner, Shortcut, shortcut};
    #[test]
    fn desktop_keyboard_buttons_and_root_share_space_and_arrow_transport() {
        assert_eq!(shortcut("space", Owner::Song), Some(Shortcut::Toggle));
        assert_eq!(shortcut("left", Owner::Song), Some(Shortcut::Seek(-5)));
        assert_eq!(shortcut("right", Owner::Song), Some(Shortcut::Seek(5)));
        // Enter belongs to the focused button, not to the song.
        assert_eq!(shortcut("enter", Owner::Song), None);
    }
    #[test]
    fn desktop_keyboard_text_and_dialog_own_all_song_keys() {
        for owner in [Owner::TextEntry, Owner::Dialog] {
            for key in ["space", "left", "right", "enter"] {
                assert_eq!(shortcut(key, owner), None);
            }
        }
    }
    #[test]
    fn desktop_keyboard_slider_keeps_arrows_but_space_is_transport_outside_dialogs() {
        assert_eq!(shortcut("left", Owner::Slider), None);
        assert_eq!(shortcut("right", Owner::Slider), None);
        assert_eq!(shortcut("space", Owner::Slider), Some(Shortcut::Toggle));
        assert_eq!(shortcut("space", Owner::Dialog), None);
    }
}

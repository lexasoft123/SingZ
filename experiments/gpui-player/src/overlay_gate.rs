//! Who owns input right now: the topmost thing the player root paints. `PAINT_ORDER` lists every layer bottom to top
//! in the order `Player::render` adds them, and `topmost` is the only place that order is turned into an owner; a unit
//! test pins the list against the render source, so a layer cannot be painted above another without the owner order
//! following.
//!
//! The player root writes the active layers on every render, before its child screens render. Pages, dialogs and the
//! quick start ask `may_focus(layer)` before they take focus, consume a pending focus request, run a deferred focus
//! callback or act on a focus key: they defer while a layer above them is active, and run again when the root renders
//! without one. Input handlers inside the focused surface of the owner itself (a click, a key on its own control) are
//! the owner's by construction and need no gate.
use gpui_kit::{App, Context, Window};
use std::sync::atomic::{AtomicU16, Ordering};

/// A layer that manages its own focus says where focus goes by default. The player root asks it when focus saved
/// before a notice or a scrim can not come back (the control was unmounted with the layer), so a visible dialog is
/// never left without focus. The request is served by the layer's own render once it is the topmost owner.
pub trait DefaultFocus: Sized {
    fn request_default_focus(&mut self, cx: &mut Context<Self>);
    /// Focus is mounted inside this layer's own focus scope.
    fn focus_inside(&self, window: &Window, cx: &App) -> bool;
}
/// Test control: the named layer's default-focus hook is treated as absent (see the generic overlay walk, which
/// runs each layer with its own hook disabled and requires the walk to fail).
#[cfg(feature = "ui-tests")]
static HOOK_DISABLED: AtomicU16 = AtomicU16::new(0);
#[cfg(feature = "ui-tests")]
pub fn disable_default_focus(layer: Option<Layer>) {
    HOOK_DISABLED.store(layer.map_or(0, Layer::bit), Ordering::Relaxed);
}
pub fn default_focus_disabled(layer: Layer) -> bool {
    #[cfg(feature = "ui-tests")]
    { HOOK_DISABLED.load(Ordering::Relaxed) & layer.bit() != 0 }
    #[cfg(not(feature = "ui-tests"))]
    { let _ = layer; false }
}

/// Bottom to top, in paint order.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Layer {
    WhatsNew,
    EngineSetup,
    StemExport,
    LibraryImport,
    ProjectPicker,
    DriveProjects,
    ProjectDelete,
    LyricsEditor,
    /// Settings, Log and Models: full-screen pages, painted above the dialogs.
    Page,
    LoadingScrim,
    SourceScrim,
    QuickStart,
    LanguageMenu,
    Notice,
}

pub const PAINT_ORDER: [Layer; 14] = [
    Layer::WhatsNew,
    Layer::EngineSetup,
    Layer::StemExport,
    Layer::LibraryImport,
    Layer::ProjectPicker,
    Layer::DriveProjects,
    Layer::ProjectDelete,
    Layer::LyricsEditor,
    Layer::Page,
    Layer::LoadingScrim,
    Layer::SourceScrim,
    Layer::QuickStart,
    Layer::LanguageMenu,
    Layer::Notice,
];

impl Layer {
    fn bit(self) -> u16 {
        1 << PAINT_ORDER.iter().position(|l| *l == self).expect("every layer is in PAINT_ORDER")
    }
    /// A scrim has no focusable owner: the player root holds focus (and its keys) while it is up.
    pub fn is_scrim(self) -> bool {
        matches!(self, Layer::LoadingScrim | Layer::SourceScrim)
    }
}

/// The set of active layers.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct Active(u16);

impl Active {
    pub fn with(mut self, layer: Layer, active: bool) -> Self {
        if active {
            self.0 |= layer.bit();
        }
        self
    }
    pub fn contains(self, layer: Layer) -> bool {
        self.0 & layer.bit() != 0
    }
    pub fn without(self, layer: Layer) -> Self {
        Active(self.0 & !layer.bit())
    }
    pub fn is_empty(self) -> bool {
        self.0 == 0
    }
}

/// The topmost active layer: the one painted last.
pub fn topmost_of(active: Active) -> Option<Layer> {
    PAINT_ORDER.iter().rev().copied().find(|layer| active.contains(*layer))
}

static ACTIVE: AtomicU16 = AtomicU16::new(0);

pub fn set(active: Active) {
    ACTIVE.store(active.0, Ordering::Relaxed);
}
pub fn topmost() -> Option<Layer> {
    topmost_of(Active(ACTIVE.load(Ordering::Relaxed)))
}
/// `layer` is the topmost active layer: it may take focus, consume a pending focus request and act on focus keys.
pub fn may_focus(layer: Layer) -> bool {
    topmost() == Some(layer)
}
/// Something is painted above the pages (a scrim, the quick start, a menu, a notice): pages must not take focus or
/// act on keys. A dialog under a page is covered by it and does not count.
pub fn owns_input() -> bool {
    topmost().is_some_and(|layer| layer > Layer::Page)
}
/// The player screen itself (the transport, its popovers) may take focus: nothing at all is painted above it.
pub fn may_focus_player() -> bool {
    topmost().is_none()
}
/// Pages and the player screen may take focus: nothing is painted above them.
pub fn may_focus_page() -> bool {
    !owns_input()
}

impl PartialOrd for Layer {
    fn partial_cmp(&self, other: &Self) -> Option<std::cmp::Ordering> {
        Some(self.cmp(other))
    }
}
impl Ord for Layer {
    fn cmp(&self, other: &Self) -> std::cmp::Ordering {
        let at = |layer: &Layer| PAINT_ORDER.iter().position(|l| l == layer).unwrap_or(usize::MAX);
        at(self).cmp(&at(other))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The source text each layer is added by in `Player::render`; every marker is unique in `main.rs`, and the
    /// layers must appear in exactly `PAINT_ORDER`.
    const MARKERS: [(Layer, &[&str]); 14] = [
        (Layer::WhatsNew, &["root.child(self.whats_new.clone())"]),
        (Layer::EngineSetup, &["root.child(self.engine_setup.clone())"]),
        (Layer::StemExport, &["root.child(self.stem_export_dialog.clone())"]),
        (Layer::LibraryImport, &["root.child(self.library_import.clone())"]),
        (Layer::ProjectPicker, &["root.child(self.project_picker.clone())"]),
        (Layer::DriveProjects, &["root.child(self.drive_projects.clone())"]),
        (Layer::ProjectDelete, &["root.child(self.project_delete.clone())"]),
        (Layer::LyricsEditor, &[".child(self.lyrics_editor.clone())"]),
        (Layer::Page, &[".child(self.settings.clone())", "root.child(self.log_panel.clone())", "root.child(self.models.clone())"]),
        (Layer::LoadingScrim, &["id(\"loading-scrim\")"]),
        (Layer::SourceScrim, &["id(\"source-job-scrim\")"]),
        (Layer::QuickStart, &["root.child(self.quick_start.clone())"]),
        (Layer::LanguageMenu, &["root.child(self.language_menu.clone())"]),
        (Layer::Notice, &["key_context(\"SingZNotice\")"]),
    ];

    #[test]
    fn paint_order_matches_the_render_order() {
        let source = include_str!("main.rs");
        let mut last = 0;
        let mut seen = Vec::new();
        for (layer, markers) in MARKERS {
            for marker in markers {
                assert_eq!(source.matches(marker).count(), 1, "marker for {layer:?} must be unique in main.rs: {marker}");
                let at = source.find(marker).unwrap();
                assert!(at > last, "{layer:?} ({marker}) is painted before the layer below it in PAINT_ORDER");
                last = at;
            }
            seen.push(layer);
        }
        assert_eq!(seen, PAINT_ORDER, "MARKERS must list the layers in PAINT_ORDER");
    }

    #[test]
    fn topmost_is_the_last_painted_active_layer() {
        let all = PAINT_ORDER.iter().fold(Active::default(), |a, l| a.with(*l, true));
        assert_eq!(topmost_of(all), Some(Layer::Notice));
        assert_eq!(topmost_of(Active::default()), None);
        // The regression: a source scrim is painted above every dialog, so it owns input.
        for dialog in [Layer::ProjectPicker, Layer::DriveProjects, Layer::ProjectDelete, Layer::LibraryImport] {
            let a = Active::default().with(dialog, true).with(Layer::SourceScrim, true);
            assert_eq!(topmost_of(a), Some(Layer::SourceScrim), "{dialog:?} under a source scrim");
        }
        // A notice is above the quick start and everything else.
        let a = Active::default().with(Layer::QuickStart, true).with(Layer::Notice, true).with(Layer::ProjectDelete, true);
        assert_eq!(topmost_of(a), Some(Layer::Notice));
        // Every pair: the later layer in PAINT_ORDER wins.
        for (i, lower) in PAINT_ORDER.iter().enumerate() {
            for upper in &PAINT_ORDER[i + 1..] {
                let a = Active::default().with(*lower, true).with(*upper, true);
                assert_eq!(topmost_of(a), Some(*upper));
            }
        }
    }
}


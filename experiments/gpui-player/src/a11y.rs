//! Accessibility helpers for D-06 (floor L2). The only module that touches raw
//! AccessKit nodes: everything else asks for a dialog or a live region by name.
//!
//! Two rules from D-06 section 5 shape these helpers. A name or value never
//! changes on a timer or per frame, and an announcement never schedules a frame:
//! a live region only carries text that the state change already draws.
use crate::{Player, Screen};
use gpui_kit::accesskit::{Live, Role};
use gpui_kit::*;
use std::cell::RefCell;

/// A modal surface: dialog role, a name, and the platform modal flag.
pub trait DialogSurface: Sized {
    /// `name` is the localized title the screen reader speaks on entry.
    fn a11y_dialog(self, name: impl Into<SharedString>) -> Self;
    /// As above for a dialog that interrupts, such as a notice: alert-dialog role.
    fn a11y_alert_dialog(self, name: impl Into<SharedString>) -> Self;
}

/// Publishes the element's own id to clients (`AXIdentifier` on macOS, `AutomationId`
/// on Windows), so the tree, the platform readback and the tests name a control alike.
/// UIKit builders do this for their controls; elements built in the app need it too.
pub fn expose_id(mut element: Stateful<Div>) -> Stateful<Div> {
    if let Some(ElementId::Name(name)) = element.interactivity().element_id.clone() {
        element = element.accessibility_id(name);
    }
    element
}

/// A control a keyboard user reaches: button role, a localized name, and its id.
pub trait ButtonSurface: Sized {
    fn a11y_button(self, name: impl Into<SharedString>) -> Self;
}
impl ButtonSurface for Stateful<Div> {
    fn a11y_button(self, name: impl Into<SharedString>) -> Self {
        expose_id(self.role(Role::Button).aria_label(name))
    }
}

/// A control built in the app from an element that has no role of its own: names it as a
/// button. The element id must be a plain name; a counted one (`("all-track", 0)`) is named
/// but not published as an identifier.
pub fn button(control: Stateful<Div>, name: impl Into<SharedString>) -> Stateful<Div> {
    ButtonSurface::a11y_button(control, name)
}

/// The selected state of a radio or menu radio. AccessKit's Windows adapter builds the UIA SelectionItem
/// pattern (IsSelected, Select) for these roles only from the *toggled* state, and without it a radio is a
/// button with no state that Narrator cannot say is selected. macOS reads `selected`, so both are set on
/// Windows; elsewhere the node is unchanged.
pub fn chosen<E: AccessibleChoice>(option: E, selected: bool) -> E {
    let option = option.choice_selected(selected);
    #[cfg(target_os = "windows")]
    let option = option.choice_toggled(selected);
    option
}
pub trait AccessibleChoice: Sized {
    fn choice_selected(self, selected: bool) -> Self;
    #[cfg(target_os = "windows")]
    fn choice_toggled(self, on: bool) -> Self;
}
impl AccessibleChoice for Stateful<Div> {
    fn choice_selected(self, selected: bool) -> Self { self.aria_selected(selected) }
    #[cfg(target_os = "windows")]
    fn choice_toggled(self, on: bool) -> Self {
        self.aria_toggled(if on { gpui_kit::accesskit::Toggled::True } else { gpui_kit::accesskit::Toggled::False })
    }
}

/// One option of a choice group (segmented control, radio row): radio role, name and selection.
pub fn radio(option: Stateful<Div>, name: impl Into<SharedString>, selected: bool) -> Stateful<Div> {
    chosen(expose_id(option.role(Role::RadioButton).aria_label(name)), selected)
}

fn modal(node: &mut gpui_kit::accesskit::Node) {
    node.set_modal();
}

impl DialogSurface for Stateful<Div> {
    fn a11y_dialog(self, name: impl Into<SharedString>) -> Self {
        expose_id(self.role(Role::Dialog).aria_label(name).a11y_synthetic_children(|b| modal(b.parent_node())))
    }
    fn a11y_alert_dialog(self, name: impl Into<SharedString>) -> Self {
        expose_id(self.role(Role::AlertDialog).aria_label(name).a11y_synthetic_children(|b| modal(b.parent_node())))
    }
}

/// An off-screen live region. It holds `text` as its value, so the platform
/// announces it when it first appears and whenever it changes. With no text the
/// node carries no value and announces nothing.
///
/// `assertive` interrupts speech (notices, errors); otherwise the text waits its
/// turn (toasts, job and sync state). The node is one pixel and invisible: it is
/// in the accessibility tree only, so no pixel on screen changes.
pub fn live_region(id: &'static str, text: Option<SharedString>, assertive: bool) -> Stateful<Div> {
    let live = if assertive { Live::Assertive } else { Live::Polite };
    let region = div().id(id).absolute().size(px(1.)).role(if assertive { Role::Alert } else { Role::Status })
        .accessibility_id(id)
        .a11y_synthetic_children(move |b| b.parent_node().set_live(live));
    match text {
        Some(text) => region.aria_label(text.clone()).aria_value(text),
        None => region,
    }
}

/// Text that a screen reader should be able to read: a labelled static region
/// (D-06 L2: screen heading, empty states, dialog bodies, error text). Plain
/// strings are not in the tree, so a parent carries them.
pub fn text_region(id: impl Into<ElementId>, text: impl Into<SharedString>) -> Stateful<Div> {
    let text: SharedString = text.into();
    expose_id(div().id(id).role(Role::Label).aria_label(text.clone()).aria_value(text))
}

/// A heading: the screen's name, for a reader that navigates by heading.
pub fn heading(id: impl Into<ElementId>, text: impl Into<SharedString>, level: usize) -> Stateful<Div> {
    text_region(id, text).role(Role::Heading).aria_level(level)
}

/// Appends a zero-width mark on alternate sequences, so two consecutive
/// announcements of the same words still differ and are both spoken.
pub fn announcement_text(text: &str, sequence: u64) -> SharedString {
    if sequence % 2 == 0 { text.to_owned().into() } else { format!("{text}\u{200b}").into() }
}

actions!(singz_a11y, [TrapFocus]);

/// Binds Tab and Shift+Tab to `TrapFocus` inside the `SingZNotice` key context. The notice is a
/// modal alert with one button; handling the action there keeps focus on that button instead
/// of letting the default Tab navigation walk the page behind it.
pub fn bind_keys(cx: &mut App) {
    cx.bind_keys([
        KeyBinding::new("tab", TrapFocus, Some("SingZNotice")),
        KeyBinding::new("shift-tab", TrapFocus, Some("SingZNotice")),
    ]);
}

thread_local! {
    /// The last polite status announcement and how many have been made.
    static STATUS: RefCell<(String, u64)> = const { RefCell::new((String::new(), 0)) };
}

/// Queues a polite announcement: a job finished or failed, Drive state changed, a
/// recording started or stopped, a training result arrived (D-06 4.2 rule 7).
/// It is carried by the next frame the state change already draws; it never
/// requests one. Never call this for playback position, meters or progress ticks.
pub fn announce(text: impl Into<String>) {
    STATUS.with(|s| {
        let mut s = s.borrow_mut();
        s.0 = text.into();
        s.1 += 1;
    });
}

/// What a training-microphone recording did (D-06 rule 7: started, stopped).
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Recording {
    Started,
    Stopped,
    Failed,
}
pub fn announce_recording(event: Recording) {
    announce(crate::i18n::t(match event {
        Recording::Started => "a11y.announce.recordingStarted",
        Recording::Stopped => "a11y.announce.recordingStopped",
        Recording::Failed => "a11y.announce.recordingFailed",
    }));
}

/// The training result, spoken when a session reaches its summary: "Session complete. 5 of 7 landed".
/// An ear-only session has no attempts, so only the first sentence is spoken.
pub fn announce_training_result(landed: usize, attempts: usize) {
    use crate::i18n::{t, tv};
    let mut text = t("training.summary.eyebrow");
    if attempts > 0 {
        text = format!("{text}. {}", tv("training.summary.headingTemplate", &[("landed", landed.to_string()), ("attempts", attempts.to_string())]));
    }
    announce(text);
}

/// What a model-install snapshot change says, in order: which installs began, which finished, and
/// whether one failed. Percentages are never announced; progress is the start and the end.
pub fn model_install_messages(old: &crate::model_service::Snapshot, new: &crate::model_service::Snapshot) -> Vec<String> {
    use crate::i18n::{t, tv};
    let name = |id: &str| new.rows.iter().find(|r| r.entry.id == id).map_or_else(|| id.to_owned(), |r| crate::models::model_label(&r.entry));
    let mut messages = vec![];
    for id in new.running.iter().filter(|id| !old.running.contains(id)) {
        messages.push(tv("a11y.announce.modelInstalling", &[("name", name(id))]));
    }
    for row in new.rows.iter().filter(|r| r.present) {
        if old.rows.iter().any(|o| o.entry.id == row.entry.id && !o.present) {
            messages.push(tv("a11y.announce.modelInstalled", &[("name", name(&row.entry.id))]));
        }
    }
    if new.error.is_some() && new.error != old.error {
        messages.push(t("a11y.announce.modelFailed"));
    }
    messages
}
pub fn announce_model_install(old: &crate::model_service::Snapshot, new: &crate::model_service::Snapshot) {
    let messages = model_install_messages(old, new);
    if !messages.is_empty() {
        announce(messages.join(". "));
    }
}

fn latest_status() -> Option<SharedString> {
    STATUS.with(|s| {
        let s = s.borrow();
        (s.1 > 0).then(|| announcement_text(&s.0, s.1))
    })
}

impl Player {
    /// The text and live regions that exist only for assistive technology: the
    /// screen's heading, the notice (assertive), the toast and status (polite).
    pub(crate) fn a11y_semantics(&self, cx: &App) -> impl IntoElement {
        use crate::i18n::t;
        let heading = match self.screen {
            Screen::Library => t("app.titlebar.songs"),
            Screen::Player if !self.song_title.is_empty() => self.song_title.to_string(),
            Screen::Player => t("app.titlebar.songs"),
            Screen::Training => t("app.titlebar.training"),
            Screen::Settings => t("settings.title"),
            Screen::Log => t("library.logPanel.title"),
            Screen::Models => t("settings.wizard.aiModelsTitle"),
        };
        let toast = self.success_toast.read(cx).state();
        div()
            .absolute()
            .size(px(1.))
            .child(self::heading("route-heading", heading, 1))
            .child(live_region("live-notice", self.notice.as_ref().map(|n| n.clone().into()), true))
            .child(live_region("live-toast", toast.text.map(|text| announcement_text(&text, toast.sequence)), false))
            .child(live_region("live-status", latest_status(), false))
    }
}

#[cfg(test)]
mod tests {
    use super::{announcement_text, model_install_messages};
    use crate::{model_catalog::Entry, model_service::{Row, Snapshot}};
    fn entry(id: &str) -> Entry {
        Entry { id: id.into(), label: id.into(), description: String::new(), optional: false, parts: vec![], archive: false }
    }
    fn snapshot(present: bool, running: &[&str], error: Option<&str>) -> Snapshot {
        Snapshot { loaded: true, rows: vec![Row { entry: entry("aligner"), present, download_mb: 0 }],
            running: running.iter().map(|s| s.to_string()).collect(), error: error.map(Into::into), ..Default::default() }
    }
    #[test]
    fn model_install_announces_start_finish_and_failure_but_not_steady_progress() {
        let idle = snapshot(false, &[], None);
        assert_eq!(model_install_messages(&idle, &snapshot(false, &["aligner"], None)).len(), 1);
        assert!(model_install_messages(&snapshot(false, &["aligner"], None), &snapshot(false, &["aligner"], None)).is_empty());
        assert_eq!(model_install_messages(&snapshot(false, &["aligner"], None), &snapshot(true, &[], None)).len(), 1);
        assert_eq!(model_install_messages(&idle, &snapshot(false, &[], Some("disk full"))), vec![crate::i18n::t("a11y.announce.modelFailed")]);
        assert!(model_install_messages(&snapshot(true, &[], None), &snapshot(true, &[], None)).is_empty());
    }
    #[test]
    fn repeated_announcements_differ_on_alternate_sequences() {
        assert_ne!(announcement_text("Import finished", 1), announcement_text("Import finished", 2));
        assert_eq!(announcement_text("Import finished", 2), announcement_text("Import finished", 4));
    }
}

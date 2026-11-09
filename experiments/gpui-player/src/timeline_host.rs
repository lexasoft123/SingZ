//! Window-input boundary for the shared lanes and pitch timeline.
use super::*;
use timeline_viewport::{Input, View};

impl Player {
    fn timeline_view(&self) -> View {
        View {
            start: self.view_start as f64 * self.duration as f64,
            end: self.view_end as f64 * self.duration as f64,
        }
    }
    fn apply_timeline_view(&mut self, view: View) {
        if self.duration > 0. {
            self.view_start = (view.start / self.duration as f64) as f32;
            self.view_end = (view.end / self.duration as f64) as f32;
        }
    }
    pub(super) fn timeline_input(&mut self, input: Input, cx: &mut Context<Self>) {
        if !self.audio_available()
            || self.screen != Screen::Player
            || self.loading
            || self.modal_was_open
        {
            return;
        }
        self.timeline.reconcile_epoch(self.native_epoch);
        let view = self.timeline_view();
        if let Some((next, notify)) =
            self.timeline
                .input(input, view, self.duration as f64, self.position as f64)
        {
            self.region.gesture = None;
            self.apply_timeline_view(next);
            if self.backend.is_some() {
                self.edit_seq += 1;
            }
            if notify {
                cx.notify();
            }
        }
    }
    pub(super) fn timeline_scroll(
        &mut self,
        event: &ScrollEvent,
        bounds: Bounds<Pixels>,
        window: &Window,
        cx: &mut Context<Self>,
    ) {
        let delta = event.delta.pixel_delta(window.line_height());
        let width = f32::from(bounds.size.width) as f64;
        let anchor = ((f32::from(event.position.x - bounds.left()) as f64) / width).clamp(0., 1.);
        if let Some(input) = timeline_viewport::wheel_input(
            -f32::from(delta.x) as f64,
            -f32::from(delta.y) as f64,
            event.modifiers.control || event.modifiers.platform,
            Some(anchor),
            width,
        ) {
            self.timeline_input(input, cx);
        }
        // As in the source overlay, wheel input over the timeline belongs to
        // navigation rather than also scrolling the containing lane list.
        cx.stop_propagation();
    }
    pub(super) fn timeline_pinch(
        &mut self,
        event: &PinchEvent,
        bounds: Bounds<Pixels>,
        cx: &mut Context<Self>,
    ) {
        let width = f32::from(bounds.size.width) as f64;
        if width > 0. {
            let anchor =
                ((f32::from(event.position.x - bounds.left()) as f64) / width).clamp(0., 1.);
            if let Some(input) = timeline_viewport::pinch_input(event.delta as f64, Some(anchor)) {
                self.timeline_input(input, cx);
            }
        }
        cx.stop_propagation();
    }
    pub(super) fn advance_timeline(&mut self, now: Instant, enabled: bool) -> bool {
        self.timeline.reconcile_epoch(self.native_epoch);
        let next = self.timeline.advance(
            self.timeline_view(),
            self.duration as f64,
            self.position as f64,
            self.playing && !self.counting_in,
            if self.backend.is_some() {
                self.native_rate
            } else {
                self.tempo
            } as f64,
            now,
            enabled,
        );
        self.apply_timeline_view(next);
        self.timeline.present(next);
        self.timeline.animating()
    }
    #[cfg(feature = "ui-tests")]
    pub(super) fn timeline_review_state(&self) -> serde_json::Value {
        serde_json::json!({"view":[self.view_start*self.duration,self.view_end*self.duration],
            "followActive":self.timeline.animating(),"manualInputs":self.timeline.applied_inputs(),
            "position":self.position,"playing":self.playing,"epoch":self.native_epoch})
    }
}

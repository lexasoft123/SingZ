//! Native composition of VocalTraining's session and summary surfaces.
use super::*;
use crate::{
    training_domain::{Direction, Kind, Quality, Role, Task},
    training_run::{Phase, Snapshot},
    training_session::Answer,
};
impl TrainingScreen {
    fn run_control_enabled(&self, id: &str) -> bool {
        let Some(run) = &self.run else { return false; };
        match id {
            "training-run-exit" => run.phase != Phase::Summary,
            "training-run-replay" | "training-run-skip" => run.phase == Phase::Respond && run.prompt.task != Task::Identify,
            "training-run-continue" => run.phase == Phase::Paused && self.audio_available,
            "training-run-restart" | "training-run-back" => run.phase == Phase::Summary,
            "training-run-song" => run.phase == Phase::Summary && self.preparation_matches(self.song.as_ref().map(|song|song.source)),
            "training-recording-record" => self.recording_visible() && self.recording_enabled(),
            "training-recording-save" => self.recording_visible() && self.recording.has_take,
            _ => id.starts_with("training-answer-") && run.phase == Phase::Respond && run.prompt.task == Task::Identify,
        }
    }
    fn run_control(&self, id: impl Into<String>, element: Stateful<Div>, action: TrainingEvent, cx: &mut Context<Self>) -> Stateful<Div> {
        let id = id.into();
        let enabled = self.run_control_enabled(&id);
        let focus = self.register_keyboard(&id, enabled, cx);
        let weak = cx.entity().downgrade();
        let action_id = id.clone();
        self.keyboard_probe(&id, settings_control_with_focus(element, focus, enabled, move |_,cx| {
            let _ = weak.update(cx, |s,cx| {
                // Admission is rechecked against the current phase. A queued
                // click/key from an unmounted or newly disabled control cannot
                // replay, cancel a cue, or answer after the phase advanced.
                if !s.keyboard_order.borrow().contains(&action_id) || !s.run_control_enabled(&action_id) { return; }
                match action_id.as_str() {
                    "training-recording-record" => s.recording_action(false,cx),
                    "training-recording-save" => s.recording_action(true,cx),
                    _ => cx.emit(action.clone()),
                }
            });
        }))
    }
    pub(super) fn order_running_controls(&self) {
        let mut order = self.keyboard_order.borrow_mut();
        order.sort_by_key(|id| (id != "training-save-retry", match id.as_str() {
            "training-recording-record" => 0,
            "training-recording-save" => 1,
            "training-run-exit" => 2,
            "training-run-continue" => 3,
            "training-run-replay" => 30,
            "training-run-skip" => 31,
            "training-run-restart" => 32,
            "training-run-back" => 33,
            "training-run-song" => 34,
            _ => id.strip_prefix("training-answer-").and_then(|index|index.parse::<usize>().ok()).map_or(100,|index|4+index),
        }));
    }
    pub(super) fn keyboard_scroll(&self) -> &ScrollHandle {
        if self.run.as_ref().is_some_and(|run|run.phase == Phase::Summary) { &self.summary_scroll } else { &self.scroll }
    }
    pub(super) fn keyboard_viewport(&self) -> Bounds<Pixels> {
        if self.run.as_ref().is_some_and(|run|run.phase != Phase::Summary) {
            self.keyboard_bounds.borrow().get("training-run-view").copied().unwrap_or_else(||self.scroll.bounds())
        } else { self.keyboard_scroll().bounds() }
    }
    pub(super) fn recover_running_focus(&self, window: &mut Window, cx: &mut Context<Self>) {
        let Some(id) = self.focused_control(window) else { return; };
        if !self.keyboard_order.borrow().contains(&id) {
            self.keyboard_scope.focus(window,cx);
            cx.notify();
        } else if self.run.as_ref().is_some_and(|run|run.phase == Phase::Summary) {
            if let Some(bounds) = self.keyboard_bounds.borrow().get(&id) {
                let viewport = self.summary_scroll.bounds();
                let correction = if bounds.top() < viewport.top()+px(4.) { viewport.top()+px(4.)-bounds.top() }
                    else if bounds.bottom() > viewport.bottom()-px(4.) { viewport.bottom()-px(4.)-bounds.bottom() } else { px(0.) };
                if viewport.size.height > px(0.) && correction != px(0.) {
                    let offset = self.summary_scroll.offset();
                    self.summary_scroll.set_offset(point(offset.x,offset.y+correction));
                    cx.notify();
                }
            }
        }
    }
    pub(super) fn progress_scroll_key(&self, event: &KeyDownEvent, window: &mut Window, cx: &mut Context<Self>) {
        if event.keystroke.modifiers.modified() || !(self.run.as_ref().is_some_and(|run|run.phase == Phase::Summary) || self.run.is_none() && self.route == Route::Progress) { return; }
        let scroll = self.keyboard_scroll();
        let y = match event.keystroke.key.as_str() {
            "pageup" => scroll.offset().y + scroll.bounds().size.height * 0.85,
            "pagedown" => scroll.offset().y - scroll.bounds().size.height * 0.85,
            "home" => px(0.),
            "end" => -scroll.max_offset().y,
            _ => return,
        };
        // Passive history/result rows are read by scrolling, not invented
        // buttons. Move within the existing app-local scope so autoscroll does
        // not immediately pull a focused action back into view.
        self.keyboard_scope.focus(window,cx);
        scroll.set_offset(point(scroll.offset().x,y.clamp(-scroll.max_offset().y,px(0.))));
        window.prevent_default();
        cx.stop_propagation();
        cx.notify();
    }
    fn recording_controls(&self, window: &Window, cx: &mut Context<Self>) -> Div {
        let mut bar = training_recording_bar().child(self.recording_button(
            "training-recording-record",
            if self.recording.recording {
                "Stop recording"
            } else {
                "Record training sample (30 seconds)"
            },
            false,
            window,
            cx,
        ));
        if self.recording.has_take {
            bar = bar.child(self.recording_button(
                "training-recording-save",
                "Save training WAV",
                true,
                window,
                cx,
            ));
        }
        if let Some(message) = self.recording.message.as_ref().filter(|m| !m.is_empty()) {
            bar = bar.child(self.probe(
                "training-recording-status",
                training_recording_status(message.clone(), window),
            ));
        }
        bar
    }
    fn recording_button(
        &self,
        id: &str,
        label: &str,
        save: bool,
        window: &Window,
        cx: &mut Context<Self>,
    ) -> Stateful<Div> {
        self.probe(
            id,
            self.run_control(
                id,
                training_recording_button(id.to_owned(),label.to_owned(),None,window),
                if save { TrainingEvent::SaveRecording } else { TrainingEvent::RecordSample },
                cx,
            ),
        )
    }

    fn running_dock(&self, compact: bool, cx: &mut Context<Self>) -> Stateful<Div> {
        self.probe(
            "training-run-dock",
            training_session_responsive_dock(compact)
                .id("training-run-dock")
                .child(
                    self.probe(
                        "training-run-replay",
                        training_session_transport_action("training-run-replay", compact)
                            .child(
                                div()
                                    .size(px(34.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        colored_icon(TransportIcon::TrainingReplay, ACCENT)
                                            .with_size(25),
                                    ),
                            )
                            .child(training_session_transport_label(
                                t("training.transport.label.replay"),
                                DIM,
                            ))
                            .when(true,|d|self.run_control("training-run-replay",d,TrainingEvent::Replay,cx)),
                    ),
                )
                .child(
                    training_session_transport_status(compact)
                        .child(
                            div()
                                .size(px(if compact { 42. } else { 46. }))
                                .rounded_full()
                                .bg(rgb(ACCENT))
                                .flex()
                                .items_center()
                                .justify_center()
                                .child(colored_icon(TransportIcon::Mic, PANEL_DEEP).with_size(23)),
                        )
                        .child(training_session_transport_label(
                            t("training.transport.listening"),
                            ACCENT,
                        )),
                )
                .child(
                    self.probe(
                        "training-run-skip",
                        training_session_transport_action("training-run-skip", compact)
                            .child(
                                div()
                                    .size(px(34.))
                                    .flex()
                                    .items_center()
                                    .justify_center()
                                    .child(
                                        colored_icon(TransportIcon::TrainingSkip, ACCENT)
                                            .with_size(25),
                                    ),
                            )
                            .child(training_session_transport_label(
                                t("training.transport.label.skip"),
                                DIM,
                            ))
                            .when(true,|d|self.run_control("training-run-skip",d,TrainingEvent::Skip,cx)),
                    ),
                ),
        )
    }
    pub(super) fn running(&self, window: &mut Window, cx: &mut Context<Self>) -> AnyElement {
        let run = self.run.as_ref().unwrap();
        let height = f32::from(window.viewport_size().height);
        let compact = height <= 680.;
        let session_gap = if compact {
            4.
        } else {
            (height * 0.013).clamp(6., 12.)
        };
        if run.phase == Phase::Summary {
            return self.summary(run, cx);
        }
        let interval_sets = run.prompt.kind == Kind::Interval && run.prompt.task == Task::Imitate;
        let progress = if interval_sets {
            format!(
                "{} / {} · {}",
                (run.current - 1) / 3 + 1,
                run.total.div_ceil(3),
                tv(
                    "training.program.repetition",
                    &[("attempt", ((run.current - 1) % 3 + 1).to_string())]
                )
            )
        } else {
            format!("{} / {}", run.current, run.total)
        };
        let reveal = run.prompt.task != Task::Identify || run.phase == Phase::Feedback;
        let target = &run.prompt.targets[run.target.min(run.prompt.targets.len() - 1)];
        let size = if compact {
            (height * 0.12).clamp(68., 86.)
        } else {
            (height * 0.13).clamp(80., 144.)
        };
        let heading = training_session_responsive_head(window.viewport_size())
            .child(
                self.probe(
                    "training-run-exit",
                    training_round_button("training-run-exit", "←")
                        .size(px(44.))
                        .when(true,|d|self.run_control("training-run-exit",d,TrainingEvent::End,cx)),
                ),
            )
            .child(Self::text(progress, 12., DIM).font_family(MONO_400));
        let sequence = div()
            .h(px(if compact { 26. } else { 34. }))
            .flex()
            .justify_center()
            .gap(px(8.))
            .children(
                run.prompt
                    .targets
                    .iter()
                    .enumerate()
                    .filter(|_| run.prompt.targets.len() > 1)
                    .map(|(i, t)| {
                        div()
                            .min_w(px(36.))
                            .px(px(8.))
                            .py(px(4.))
                            .rounded_full()
                            .font_family("SingZ Mono 600")
                            .text_size(px(12.))
                            .line_height(px(18.))
                            .text_color(rgb(if i == run.target { ACCENT } else { DIM }))
                            .when(i == run.target, |d| d.bg(rgba(ACCENT_SOFT)))
                            .child(if reveal {
                                t.note_name.clone()
                            } else {
                                "?".into()
                            })
                    }),
            );
        let label = if run.prompt.task == Task::Identify && !reveal {
            match run.prompt.kind {
                Kind::Note => t("training.kindLabel.identifyNote"),
                Kind::Degree => t("training.kindLabel.identifyNumber"),
                Kind::Interval => t("training.kindLabel.identifyInterval"),
                Kind::Chord => t("training.kindLabel.identifyChordNote"),
                _ => t("training.kindLabel.identifyChord"),
            }
            .to_owned()
        } else {
            match run.prompt.kind {
                Kind::Note => t("training.exercise.note.label"),
                Kind::Degree | Kind::Scale => t("training.exercise.scaleDegree.label"),
                Kind::Interval => t("training.exercise.interval.label"),
                Kind::Chord | Kind::Arpeggio => {
                    let chord = run.prompt.chord.as_ref().unwrap();
                    let name = format!("{} {}", chord.root_name, quality(chord.quality));
                    if run.prompt.kind == Kind::Arpeggio {
                        tv("training.label.arpeggioOf", &[("chord", name)])
                    } else {
                        name
                    }
                }
                Kind::Mixed => unreachable!(),
            }
        };
        let target_stage =
            div()
                .flex_none()
                .h(px(if compact {
                    138.
                } else {
                    (height * 0.28).clamp(176., 226.)
                }))
                .flex()
                .flex_col()
                .items_center()
                .child(
                    training_eyebrow(format!("{} · {label}", key_label(&run.key)))
                        .h(px(if compact { 18. } else { 24. })),
                )
                .child(sequence)
                .child(
                    div().flex_1().flex().items_center().child(
                        tracked_text(
                            if reveal {
                                target.note_name.clone()
                            } else {
                                "?".into()
                            },
                            DISPLAY_800,
                            size,
                            -size * 0.07,
                            TEXT,
                        )
                        .line_height(size * 0.86),
                    ),
                );
        let mut stage = div()
            .flex_1()
            .min_h_0()
            .w_full()
            .max_w(px(1040.))
            .mx_auto()
            .px(px(if compact { 18. } else { 24. }))
            .pt(px(if compact {
                0.
            } else {
                (height * 0.012).clamp(4., 10.)
            }))
            .pb(px(if compact { 0. } else { 2. }))
            .text_center()
            .flex()
            .flex_col()
            .child(target_stage);
        stage = match run.phase {
            Phase::Preparing | Phase::Paused => stage.child(
                div()
                    .flex_1()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(18.))
                    .child(self.probe("training-run-paused-error", Self::text(
                        run.error.clone().unwrap_or_else(|| {
                            if run.phase == Phase::Paused {
                                t("training.session.ready.paused")
                            } else {
                                t("training.session.ready.preparing")
                            }
                        }),
                        16.,
                        DIM,
                    ).id("training-run-paused-error")))
                    .when(run.phase == Phase::Paused, |d| {
                        d.child(
                            self.probe(
                                "training-run-continue",
                                training_primary_enabled(
                                    "training-run-continue",
                                    t("training.session.readyAction.continue"),
                                    self.audio_available,
                                )
                                .when(true,|d|self.run_control("training-run-continue",d,TrainingEvent::Continue,cx)),
                            ),
                        )
                    }),
            ),
            Phase::Cue => stage.child(
                div()
                    .flex_1()
                    .min_h_0()
                    .flex()
                    .flex_col()
                    .items_center()
                    .justify_center()
                    .gap(px(12.))
                    .child(
                        Self::text(run.countdown.unwrap_or(1).to_string(), 76., ACCENT)
                            .font_family("SingZ Mono 760")
                            .line_height(px(76.)),
                    )
                    .child(Self::text(
                        match run.prompt.task {
                            Task::Identify => t("training.cue.identify"),
                            Task::Imitate => t("training.cue.imitate"),
                            Task::Find => t("training.cue.find"),
                        },
                        16.,
                        TEXT,
                    )),
            ),
            Phase::Respond if run.prompt.task == Task::Identify => {
                stage.child(self.answers(run, cx))
            }
            Phase::Respond | Phase::Completing => {
                let cents = run
                    .display_midi
                    .map(|m| ((m - target.midi as f64) * 100.) as f32);
                let detected = run
                    .display_midi
                    .map(|m| {
                        crate::training_music::note_name(m.round() as i32, self.tonic, self.minor)
                    })
                    .unwrap_or_else(|| "—".into());
                let guidance = match cents {
                    None => tv(
                        "training.session.runway.holdInstruction",
                        &[
                            ("cents", run.tolerance.to_string()),
                            ("seconds", "1.5".into()),
                        ],
                    ),
                    Some(c) if c.abs() <= run.tolerance as f32 => {
                        t("training.session.runway.inTune")
                    }
                    Some(c) if c > 0. => t("training.session.runway.lower"),
                    _ => t("training.session.runway.higher"),
                };
                let guidance_size = if compact { 17. } else { 20. };
                stage.child(
                    div()
                        .w_full()
                        .max_w(px(880.))
                        .mx_auto()
                        .flex_none()
                        .child(
                            div()
                                .flex()
                                .items_center()
                                .justify_between()
                                .mb(px(if compact { 4. } else { 8. }))
                                .child(training_session_text(
                                    t("training.word.flat").to_uppercase(),
                                    "SingZ Mono 650",
                                    12.,
                                    DIM,
                                    window,
                                ))
                                .child(training_session_text(
                                    format!("±{}¢", run.tolerance),
                                    "SingZ Mono 650",
                                    12.,
                                    ACCENT,
                                    window,
                                ))
                                .child(training_session_text(
                                    t("training.word.sharp").to_uppercase(),
                                    "SingZ Mono 650",
                                    12.,
                                    DIM,
                                    window,
                                )),
                        )
                        .child(
                            training_runway(
                                cents,
                                run.tolerance as f32,
                                if compact {
                                    72.
                                } else {
                                    (height * 0.14).clamp(88., 112.)
                                },
                            )
                            .when(compact, |d| d.rounded(px(20.))),
                        )
                        .child(
                            div()
                                .min_h(px(if compact {
                                    40.
                                } else {
                                    (height * 0.08).clamp(48., 62.)
                                }))
                                .mt(px(4.))
                                .flex()
                                .justify_between()
                                .items_center()
                                .child(
                                    div()
                                        .px(px(if compact { 10. } else { 12. }))
                                        .py(px(if compact { 3. } else { 8. }))
                                        .flex()
                                        .flex_col()
                                        .gap(px(5.))
                                        .text_left()
                                        .child(training_session_text(
                                            t("training.session.runway.youAreSinging")
                                                .to_uppercase(),
                                            MONO_400,
                                            12.,
                                            DIM,
                                            window,
                                        ))
                                        .child(training_session_text(
                                            detected,
                                            "SingZ Mono 760",
                                            if compact { 26. } else { 32. },
                                            TEXT,
                                            window,
                                        )),
                                )
                                .child(
                                    training_session_text(
                                        cents
                                            .map(|c| {
                                                format!(
                                                    "{}¢ {}",
                                                    c.abs().round(),
                                                    if c.abs() <= run.tolerance as f32 {
                                                        t("training.session.pitch.onTarget")
                                                            .to_lowercase()
                                                    } else if c > 0. {
                                                        t("training.word.sharp")
                                                    } else {
                                                        t("training.word.flat")
                                                    }
                                                )
                                            })
                                            .unwrap_or_default(),
                                        DISPLAY_650,
                                        22.,
                                        TEXT,
                                        window,
                                    )
                                    .px(px(if compact {
                                        10.
                                    } else {
                                        12.
                                    })),
                                ),
                        )
                        .child(training_hold_meter(run.progress))
                        .child(
                            self.probe(
                                "training-run-guidance",
                                training_session_text(
                                    guidance,
                                    DISPLAY_400,
                                    guidance_size,
                                    TEXT,
                                    window,
                                )
                                .mt(px(if compact { 6. } else { 12. }))
                                .id("training-run-guidance"),
                            ),
                        ),
                )
            }
            Phase::Feedback => stage.child(
                training_banner()
                    .mt(px(24.))
                    .child(Self::heading(
                        run.outcomes
                            .last()
                            .map(|value| outcome(value))
                            .unwrap_or_default(),
                        24.,
                    ))
                    .child(Self::text(
                        match run.outcomes.last().map(String::as_str) {
                            Some("Skipped") => t("training.feedback.skipped.detail"),
                            Some("Correct") => t("training.feedback.identifyCorrect.detail"),
                            Some("On target") => t("training.feedback.onTarget.detail"),
                            Some("Close") => t("training.feedback.close.detail"),
                            _ if run.prompt.task == Task::Identify => {
                                t("training.feedback.identifyWrong.detail")
                            }
                            _ => t("training.feedback.wrong.detail"),
                        },
                        14.,
                        DIM,
                    )),
            ),
            Phase::Summary => unreachable!(),
        };
        div()
            .flex_1()
            .min_h_0()
            .w_full()
            .flex()
            .flex_col()
            .gap(px(session_gap))
            .py(px(session_gap))
            .when(self.recording_visible(), |d| {
                d.child(
                    self.probe(
                        "training-recording-bar",
                        self.recording_controls(window, cx)
                            .id("training-recording-bar"),
                    ),
                )
            })
            .child(heading)
            .child(stage)
            .when(
                matches!(run.phase, Phase::Respond | Phase::Completing)
                    && run.prompt.task != Task::Identify,
                |d| d.child(self.running_dock(compact, cx)),
            )
            .into_any_element()
    }
    fn answers(&self, run: &Snapshot, cx: &mut Context<Self>) -> Div {
        let mut answers: Vec<(String, String, Answer)> = vec![];
        match run.prompt.kind {
            Kind::Note => {
                for pc in 0..12 {
                    let name =
                        crate::training_music::note_name(60 + pc as i32, self.tonic, self.minor);
                    answers.push((
                        name.trim_end_matches(|c: char| c.is_ascii_digit()).into(),
                        "".into(),
                        Answer::Note(pc),
                    ));
                }
            }
            Kind::Degree => {
                for degree in 1..=7 {
                    answers.push((
                        degree.to_string(),
                        tv(
                            "training.identify.scaleDegreeDetail",
                            &[("n", degree.to_string())],
                        ),
                        Answer::Degree(degree),
                    ));
                }
            }
            Kind::Interval => {
                for number in 2..=8 {
                    for direction in [Direction::Ascending, Direction::Descending] {
                        answers.push((
                            [
                                capitalize(t("training.word.second")),
                                capitalize(t("training.word.third")),
                                capitalize(t("training.word.fourth")),
                                capitalize(t("training.word.fifth")),
                                capitalize(t("training.word.sixth")),
                                capitalize(t("training.word.seventh")),
                                capitalize(t("training.word.octave")),
                            ][number as usize - 2]
                                .clone(),
                            if direction == Direction::Ascending {
                                capitalize(t("training.word.ascending")).into()
                            } else {
                                capitalize(t("training.word.descending")).into()
                            },
                            Answer::Interval(number, direction),
                        ));
                    }
                }
            }
            Kind::Chord => {
                for role in [Role::Root, Role::Third, Role::Fifth] {
                    answers.push((
                        match role {
                            Role::Root => capitalize(t("training.word.root")),
                            Role::Third => capitalize(t("training.word.third")),
                            Role::Fifth => capitalize(t("training.word.fifth")),
                        }
                        .into(),
                        "".into(),
                        Answer::Chord(role),
                    ));
                }
            }
            Kind::Arpeggio => {
                for degree in 1..=7 {
                    let quality = if self.minor {
                        [
                            Quality::Minor,
                            Quality::Diminished,
                            Quality::Major,
                            Quality::Minor,
                            Quality::Major,
                            Quality::Major,
                            Quality::Major,
                        ][degree - 1]
                    } else {
                        [
                            Quality::Major,
                            Quality::Minor,
                            Quality::Minor,
                            Quality::Major,
                            Quality::Major,
                            Quality::Minor,
                            Quality::Diminished,
                        ][degree - 1]
                    };
                    answers.push((
                        tv(
                            "training.identify.degreeLabel",
                            &[("n", degree.to_string())],
                        ),
                        self::quality(quality).into(),
                        Answer::Arpeggio(degree as u8, quality),
                    ));
                }
            }
            _ => {}
        }
        let buttons = answers
            .into_iter()
            .enumerate()
            .map(|(index, (label, detail, answer))| {
                let button = training_answer(("training-answer", index))
                    .min_w(px(100.))
                    .flex_1()
                    .child(Self::text(label, 16., TEXT).font_family(DISPLAY_700))
                    .when(!detail.is_empty(), |d| {
                        d.child(Self::text(detail, 12., DIM))
                    })
                    .when(true,|d|self.run_control(format!("training-answer-{index}"),d,TrainingEvent::Answer(answer),cx));
                self.probe(format!("training-answer-{index}"), button)
            });
        div()
            .w_full()
            .max_w(px(720.))
            .mx_auto()
            .p(px(18.))
            .border_1()
            .border_color(rgba(LINE_STRONG))
            .rounded(px(12.))
            .bg(rgba(0x1b1814b8))
            .child(Self::text(t("training.session.identify.legend"), 14., DIM).mb(px(12.)))
            .child(div().flex().flex_wrap().gap(px(7.)).children(buttons))
    }
    fn summary(&self, run: &Snapshot, cx: &mut Context<Self>) -> AnyElement {
        div()
            .id("training-summary-scroll")
            .track_scroll(&self.summary_scroll)
            .overflow_y_scroll()
            .flex_1()
            .min_h_0()
            .w_full()
            .child(
                div()
                    .max_w(px(1040.))
                    .mx_auto()
                    .p(px(32.))
                    .child(training_eyebrow(t("training.summary.eyebrow")))
                    .child(
                        Self::heading(
                            tv(
                                "training.summary.headingTemplate",
                                &[
                                    ("landed", (run.correct + run.close).to_string()),
                                    ("attempts", run.attempts.to_string()),
                                ],
                            ),
                            42.,
                        )
                        .mt(px(12.)),
                    )
                    .child(Self::text("Your completed exercise results", 16., DIM).mt(px(12.)))
                    .child(
                        training_summary_strip().mt(px(28.)).children(
                            [
                                (
                                    t("training.session.pitch.onTarget"),
                                    run.correct.to_string(),
                                ),
                                (t("training.metric.close"), run.close.to_string()),
                                (
                                    t("training.metric.averageError"),
                                    run.average_absolute_cents
                                        .map(|v| format!("{v:.0}¢"))
                                        .unwrap_or_else(|| "—".into()),
                                ),
                                (
                                    t("training.metric.voiceDetected"),
                                    run.voiced_ratio
                                        .map(|v| format!("{:.0}%", v * 100.))
                                        .unwrap_or_else(|| "—".into()),
                                ),
                                (
                                    t("training.metric.pitchHeldSteady"),
                                    run.stable_ratio
                                        .map(|v| format!("{:.0}%", v * 100.))
                                        .unwrap_or_else(|| "—".into()),
                                ),
                            ]
                            .into_iter()
                            .enumerate()
                            .map(|(index, (label, value))| {
                                training_metric(label.to_uppercase(), value, index == 0)
                            }),
                        ),
                    )
                    .child(
                        div()
                            .mt(px(24.))
                            .children(run.outcomes.iter().enumerate().map(|(i, outcome)| {
                                div()
                                    .flex()
                                    .gap(px(16.))
                                    .py(px(12.))
                                    .border_b_1()
                                    .border_color(rgba(LINE))
                                    .child(Self::text((i + 1).to_string(), 14., DIM))
                                    .child(
                                        Self::text(
                                            run.outcome_prompts
                                                .get(i)
                                                .map(instruction)
                                                .unwrap_or_else(|| {
                                                    tv(
                                                        "training.outcome.exerciseFallback",
                                                        &[("n", (i + 1).to_string())],
                                                    )
                                                }),
                                            14.,
                                            TEXT,
                                        )
                                        .flex_1(),
                                    )
                                    .child(Self::text(super::outcome(outcome), 14., ACCENT))
                            })),
                    )
                    .child(
                        div()
                            .flex()
                            .gap(px(12.))
                            .mt(px(28.))
                            .child(
                                self.probe(
                                    "training-run-restart",
                                    training_primary(
                                        "training-run-restart",
                                        t("training.summary.restart"),
                                    )
                                    .when(true,|d|self.run_control("training-run-restart",d,TrainingEvent::Restart,cx)),
                                ),
                            )
                            .child(
                                self.probe(
                                    "training-run-back",
                                    ghost_pill(
                                        "training-run-back",
                                        t("training.summary.backToTraining"),
                                    )
                                    .when(true,|d|self.run_control("training-run-back",d,TrainingEvent::End,cx)),
                                ),
                            )
                            .when(
                                self.preparation_matches(self.song.as_ref().map(|s| s.source)),
                                |d| {
                                    d.child(
                                        self.probe(
                                            "training-run-song",
                                            ghost_pill(
                                                "training-run-song",
                                                t("training.session.aria.backToSong"),
                                            )
                                            .when(true,|d|self.run_control("training-run-song",d,TrainingEvent::BackToSong,cx)),
                                        ),
                                    )
                                },
                            ),
                    ),
            )
            .into_any_element()
    }
}
fn quality(quality: Quality) -> String {
    match quality {
        Quality::Major => t("training.word.major"),
        Quality::Minor => t("training.word.minor"),
        Quality::Diminished => t("training.word.diminished"),
        Quality::Augmented => t("training.word.augmented"),
    }
}

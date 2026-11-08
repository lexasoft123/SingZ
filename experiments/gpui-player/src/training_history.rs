//! Filled progress composition from production VocalTraining's TrainingProgress.
use super::*;
use crate::training_progress::{Aggregate, Counter};
use std::collections::BTreeMap;
impl TrainingScreen {
    pub(super) fn saved_history(&self) -> Div {
        let a = &self.history.aggregate;
        let cents = Aggregate::average(a.centered_cents_sum, a.centered_cents_count);
        let tendency = match cents {
            None => t("training.tendency.notEnough"),
            Some(c) if c > 10. => tv(
                "training.tendency.usually",
                &[("word", t("training.word.sharp"))],
            ),
            Some(c) if c < -10. => tv(
                "training.tendency.usually",
                &[("word", t("training.word.flat"))],
            ),
            _ => t("training.tendency.centered"),
        };
        let metrics = [
            (
                t("training.progress.metric.completedSessions").to_uppercase(),
                a.sessions.to_string(),
            ),
            (
                t("training.progress.metric.onTargetOrClose").to_uppercase(),
                ratio((a.on_target + a.close) as f64, a.attempts),
            ),
            (
                t("training.progress.metric.pitchTendency").to_uppercase(),
                tendency.into(),
            ),
            (
                t("training.metric.voiceDetected").to_uppercase(),
                ratio(a.voiced_ratio_sum, a.voiced_ratio_count),
            ),
            (
                t("training.metric.pitchHeldSteady").to_uppercase(),
                ratio(a.stable_ratio_sum, a.stable_ratio_count),
            ),
        ];
        let mut focus = training_history_section()
            .child(Self::heading(t("training.progress.focus.heading"), 18.).mb(px(10.)));
        for (label, map) in [
            (t("training.progress.focus.exerciseTypes"), &a.by_exercise),
            (
                t("training.progress.focus.scaleDegrees"),
                &a.by_scale_degree,
            ),
            (t("training.exercise.interval.label"), &a.by_interval),
            (t("training.progress.focus.chordRoles"), &a.by_chord_role),
        ] {
            focus = focus.child(
                div()
                    .flex()
                    .gap(px(12.))
                    .py(px(10.))
                    .border_b_1()
                    .border_color(rgba(LINE))
                    .child(Self::text(label, 12., DIM).w(px(140.)).flex_none())
                    .child(
                        Self::text(weaknesses(map), 12.5, TEXT)
                            .font_family(DISPLAY_700)
                            .flex_1(),
                    ),
            );
        }
        let recent = training_history_section()
            .child(Self::heading(t("training.progress.recent.heading"), 18.).mb(px(10.)))
            .child(div().border_t_1().border_color(rgba(LINE_STRONG)).children(
                self.history.receipts.iter().take(100).map(|r| {
                    let key = crate::training_music::note_name(
                        60 + r.key.tonic_pc as i32,
                        r.key.tonic_pc as usize,
                        r.key.mode == "minor",
                    );
                    let key = key.trim_end_matches(|c: char| c.is_ascii_digit());
                    let date = chrono::DateTime::from_timestamp_millis(r.completed_at as i64)
                        .map(|d| {
                            d.with_timezone(&chrono::Local)
                                .format("%-m/%-d/%Y")
                                .to_string()
                        })
                        .unwrap_or_else(|| "—".into());
                    div()
                        .flex()
                        .items_baseline()
                        .gap(px(14.))
                        .py(px(11.))
                        .border_b_1()
                        .border_color(rgba(LINE))
                        .child(Self::text(date, 12., DIM).w(px(110.)).flex_none())
                        .child(
                            Self::text(
                                format!(
                                    "{} · {}",
                                    key_label(&format!("{key} {}", r.key.mode)),
                                    readable(crate::training_progress::name(r.exercise))
                                ),
                                12.5,
                                TEXT,
                            )
                            .font_family(DISPLAY_700)
                            .flex_1(),
                        )
                        .child(Self::text(
                            tv(
                                "training.progress.recent.landed",
                                &[
                                    (
                                        "landed",
                                        (r.aggregate.on_target + r.aggregate.close).to_string(),
                                    ),
                                    ("attempts", r.aggregate.attempts.to_string()),
                                ],
                            ),
                            12.,
                            DIM,
                        ))
                }),
            ));
        div()
            .child(
                training_summary_strip().children(
                    metrics
                        .into_iter()
                        .enumerate()
                        .map(|(i, (label, value))| training_metric(label, value, i == 0)),
                ),
            )
            .child(focus)
            .child(recent)
    }
}
fn ratio(sum: f64, count: u64) -> String {
    Aggregate::average(sum, count).map_or_else(|| "—".into(), |v| format!("{:.0}%", v * 100.))
}
fn weaknesses(map: &BTreeMap<String, Counter>) -> String {
    let values = Aggregate::weakest(map);
    if values.is_empty() {
        t("training.progress.weakness.needMore")
    } else {
        values
            .iter()
            .map(|v| readable(v))
            .collect::<Vec<_>>()
            .join(" · ")
    }
}
fn readable(value: &str) -> String {
    match value {
        "note" => t("training.exercise.note.label"),
        "scale-degree" => t("training.exercise.scaleDegree.label"),
        "interval" => t("training.exercise.interval.label"),
        "chord-tone" => t("training.exercise.chordTone.label"),
        "arpeggio" => t("training.exercise.arpeggio.label"),
        "scale" => t("training.program.scaleLabel"),
        "mixed" => t("training.exercise.mixed.label"),
        "root" => capitalize(t("training.word.root")).into(),
        "third" => capitalize(t("training.word.third")).into(),
        "fifth" => capitalize(t("training.word.fifth")).into(),
        v if v.len() == 1 => tv("training.progress.focus.degree", &[("n", v.into())]),
        v if v.ends_with("ascending") || v.ends_with("descending") => {
            let (n, d) = v.split_once('-').unwrap();
            format!(
                "{} · {}",
                match n {
                    "2" => capitalize(t("training.word.second")),
                    "3" => capitalize(t("training.word.third")),
                    "4" => capitalize(t("training.word.fourth")),
                    "5" => capitalize(t("training.word.fifth")),
                    "6" => capitalize(t("training.word.sixth")),
                    "7" => capitalize(t("training.word.seventh")),
                    _ => capitalize(t("training.word.octave")),
                },
                t(if d == "ascending" {
                    "training.word.ascending"
                } else {
                    "training.word.descending"
                })
            )
        }
        v => v.into(),
    }
}

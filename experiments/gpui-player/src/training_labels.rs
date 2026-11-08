//! Presentation-only names. Prompt fields and stored training identities stay
//! in the source domain; locale is resolved again for every displayed view.
use crate::{
    i18n::{t, tv},
    training_domain::{Direction, Kind, Prompt, Quality, Role, Task},
};

pub(super) fn capitalize(value: String) -> String {
    let mut chars = value.chars();
    chars.next().map_or_else(String::new, |first| {
        first.to_uppercase().collect::<String>() + chars.as_str()
    })
}
pub(super) fn key_label(value: &str) -> String {
    if let Some(tonic) = value.strip_suffix(" major") {
        tv("key.major", &[("tonic", tonic.into())])
    } else if let Some(tonic) = value.strip_suffix(" minor") {
        tv("key.minor", &[("tonic", tonic.into())])
    } else {
        value.into()
    }
}
fn direction(value: Option<Direction>) -> String {
    t(if value == Some(Direction::Descending) {
        "training.word.descending"
    } else {
        "training.word.ascending"
    })
}
fn quality(value: Quality) -> String {
    t(match value {
        Quality::Major => "training.word.major",
        Quality::Minor => "training.word.minor",
        Quality::Diminished => "training.word.diminished",
        Quality::Augmented => "training.word.augmented",
    })
}
fn chord(prompt: &Prompt) -> String {
    prompt
        .chord
        .as_ref()
        .map(|c| format!("{} {}", c.root_name, quality(c.quality)))
        .unwrap_or_default()
}
fn interval(prompt: &Prompt) -> String {
    let number = prompt.interval.unwrap_or(1) as usize;
    let semitones = prompt.targets[0].midi.abs_diff(prompt.targets[1].midi) as i32;
    let delta = semitones - [0, 2, 4, 5, 7, 9, 11, 12][number - 1];
    let quality = if [1, 4, 5, 8].contains(&number) {
        if delta == 0 {
            "perfect"
        } else if delta == 1 {
            "augmented"
        } else {
            "diminished"
        }
    } else if delta == 0 {
        "major"
    } else if delta == -1 {
        "minor"
    } else if delta > 0 {
        "augmented"
    } else {
        "diminished"
    };
    let ordinal = [
        "unison", "second", "third", "fourth", "fifth", "sixth", "seventh", "octave",
    ][number - 1];
    t(&format!("interval.{quality}.{ordinal}"))
}
pub(super) fn instruction(prompt: &Prompt) -> String {
    if prompt.task == Task::Identify {
        return t(match prompt.kind {
            Kind::Note => "training.session.instruction.identifyNote",
            Kind::Degree => "training.session.instruction.identifyScaleDegree",
            Kind::Interval => "training.session.instruction.identifyInterval",
            Kind::Chord => "training.session.instruction.identifyChordTone",
            Kind::Arpeggio => "training.session.instruction.identifyArpeggio",
            _ => "training.program.scaleLabel",
        });
    }
    let target = &prompt.targets[0];
    match prompt.kind {
        Kind::Note => tv(
            "training.session.instruction.matchNote",
            &[("note", target.note_name.clone())],
        ),
        Kind::Degree => tv(
            "training.session.instruction.singScaleDegree",
            &[
                ("degree", target.degree.to_string()),
                ("note", target.note_name.clone()),
            ],
        ),
        Kind::Interval => tv(
            "training.session.instruction.singInterval",
            &[
                ("interval", interval(prompt)),
                ("direction", direction(prompt.direction)),
                ("from", target.note_name.clone()),
                ("to", prompt.targets[1].note_name.clone()),
            ],
        ),
        Kind::Chord => tv(
            "training.session.instruction.singChordTone",
            &[
                (
                    "role",
                    t(match prompt.role.unwrap_or(Role::Root) {
                        Role::Root => "training.word.root",
                        Role::Third => "training.word.third",
                        Role::Fifth => "training.word.fifth",
                    }),
                ),
                ("chord", chord(prompt)),
                ("note", target.note_name.clone()),
            ],
        ),
        Kind::Arpeggio => tv(
            "training.session.instruction.arpeggiate",
            &[
                ("chord", chord(prompt)),
                ("direction", direction(prompt.direction)),
            ],
        ),
        Kind::Scale => format!(
            "{} · {}",
            target
                .note_name
                .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-'),
            direction(prompt.direction)
        ),
        Kind::Mixed => String::new(),
    }
}
/// The current native snapshot serializes these result statuses as strings.
/// Map that closed domain at the display boundary, without rewriting receipts.
pub(super) fn outcome(value: &str) -> String {
    let key = match value {
        "Skipped" => "training.outcome.skipped",
        "Correct" => "training.outcome.correct",
        "On target" => "training.session.pitch.onTarget",
        "Close" => "training.metric.close",
        "Try again" => "training.outcome.tryAgain",
        _ => return value.into(),
    };
    t(key)
}

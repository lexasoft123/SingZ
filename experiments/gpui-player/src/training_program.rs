//! Calendar-based program credit. Silence/skips/repeated same-day sessions do
//! not manufacture practice days; identification has no voiced-day evidence.
use super::{
    training_domain::{Config, DirectionChoice, Kind, Task, generate},
    training_progress::Completion,
    training_store::Program,
};
use chrono::{DateTime, Days, Local, NaiveDate};
use std::collections::BTreeSet;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Lesson {
    pub kind: Kind,
    pub task: Task,
    pub semitones: Option<u8>,
}
#[derive(Clone, Debug)]
pub struct Stage {
    pub lesson: Lesson,
    pub days: usize,
    pub day_index: usize,
    pub practiced_today: bool,
    pub done: bool,
}
pub fn lessons(level: usize) -> Vec<Lesson> {
    use Kind::*;
    use Task::*;
    let items = match level {
        0 => vec![
            (Note, Imitate, 0),
            (Interval, Imitate, 2),
            (Interval, Imitate, 3),
            (Interval, Imitate, 4),
            (Interval, Imitate, 7),
            (Scale, Imitate, 0),
            (Chord, Imitate, 0),
        ],
        1 => vec![
            (Interval, Imitate, 1),
            (Interval, Imitate, 5),
            (Interval, Imitate, 8),
            (Interval, Imitate, 9),
            (Interval, Imitate, 12),
            (Arpeggio, Imitate, 0),
        ],
        _ => vec![
            (Interval, Imitate, 6),
            (Interval, Imitate, 10),
            (Interval, Imitate, 11),
            (Degree, Find, 0),
            (Chord, Find, 0),
            (Mixed, Find, 0),
        ],
    };
    items
        .into_iter()
        .map(|(kind, task, n)| Lesson {
            kind,
            task,
            semitones: (n > 0).then_some(n),
        })
        .collect()
}
fn date(ms: u64) -> Option<NaiveDate> {
    DateTime::from_timestamp_millis(i64::try_from(ms).ok()?)
        .map(|d| d.with_timezone(&Local).date_naive())
}
pub fn stages(program: &Program, receipts: &[Completion], now: u64) -> Vec<Stage> {
    let today = date(now);
    lessons(program.level)
        .into_iter()
        .map(|lesson| {
            let dates: BTreeSet<_> = receipts
                .iter()
                .filter(|r| {
                    r.completed_at >= program.started_at
                        && r.completed_at <= now
                        && r.exercise == lesson.kind
                        && r.task_mode == lesson.task
                        && r.interval_semitones == lesson.semitones
                        && r.qualifies_day()
                })
                .filter_map(|r| date(r.completed_at))
                .collect();
            let practiced_today = today.is_some_and(|d| dates.contains(&d));
            Stage {
                lesson,
                days: dates.len().min(7),
                day_index: dates
                    .len()
                    .saturating_sub(usize::from(practiced_today))
                    .min(6),
                practiced_today,
                done: dates.len() >= 7,
            }
        })
        .collect()
}
pub fn streak(program: Option<&Program>, receipts: &[Completion], now: u64) -> usize {
    let Some(today) = date(now) else { return 0 };
    let dates: BTreeSet<_> = receipts
        .iter()
        .filter(|r| {
            r.completed_at <= now
                && r.completed_at >= program.map_or(0, |p| p.started_at)
                && r.qualifies_day()
        })
        .filter_map(|r| date(r.completed_at))
        .collect();
    let mut cursor = if dates.contains(&today) {
        today
    } else {
        let Some(yesterday) = today.checked_sub_days(Days::new(1)) else {
            return 0;
        };
        yesterday
    };
    let mut result = 0;
    while dates.contains(&cursor) {
        result += 1;
        let Some(previous) = cursor.checked_sub_days(Days::new(1)) else {
            break;
        };
        cursor = previous;
    }
    result
}
pub fn setup(
    lesson: Lesson,
    day: usize,
    config: &Config,
    receipts: &[Completion],
    now: u64,
) -> Config {
    let mut next = config.clone();
    next.kind = lesson.kind;
    next.task = lesson.task;
    next.interval_semitones = lesson.semitones;
    next.intervals = (2..=8).collect();
    next.chord_degrees = if lesson.kind == Kind::Chord && lesson.task == Task::Imitate {
        vec![1]
    } else {
        vec![1, 4, 5]
    };
    next.direction = if day < 3 {
        DirectionChoice::Ascending
    } else if day < 6 {
        DirectionChoice::Descending
    } else {
        DirectionChoice::Both
    };
    next.tonic = [0, 2, 4, 5, 7, 9, 11][day.min(6)];
    next.guided_scale = true;
    next.length = if matches!(lesson.kind, Kind::Scale | Kind::Interval) {
        6
    } else {
        18
    };
    let last = receipts
        .iter()
        .filter(|r| {
            r.completed_at <= now
                && date(r.completed_at) == date(now)
                && r.exercise == lesson.kind
                && r.task_mode == lesson.task
                && r.interval_semitones == lesson.semitones
                && r.aggregate.attempts > 0
        })
        .max_by_key(|r| r.completed_at);
    let preferred = last.map_or(next.tonic, |r| (r.key.tonic_pc + 1) % 12);
    for offset in 0..12 {
        let tonic = (preferred + offset) % 12;
        let mut check = next.clone();
        check.tonic = tonic;
        check.length = 1;
        check.seed = "program-range-check".into();
        if generate(&check).is_ok() {
            next.tonic = tonic;
            break;
        }
    }
    next
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::training_progress::tests::complete;
    use chrono::TimeZone;
    fn at(day: u32) -> u64 {
        Local
            .with_ymd_and_hms(2026, 11, day, 12, 0, 0)
            .single()
            .unwrap()
            .timestamp_millis() as u64
    }
    #[test]
    fn repeated_sessions_and_silent_or_future_receipts_do_not_manufacture_program_days() {
        let mut r = complete(Kind::Note, Task::Imitate, 6, "calendar", false);
        r.completed_at = at(2);
        let mut repeat = r.clone();
        repeat.session_id = "repeat".into();
        let mut silent = r.clone();
        silent.completed_at = at(3);
        silent.aggregate.voiced_ratio_sum = 0.;
        let mut future = r.clone();
        future.completed_at = at(9);
        let program = Program {
            level: 0,
            started_at: at(1),
        };
        let progress = stages(&program, &[r, repeat, silent, future], at(3));
        assert_eq!(progress[0].days, 1);
        assert_eq!(progress[0].day_index, 1);
        assert!(!progress[0].practiced_today);
        assert!(!progress[0].done);
        assert_eq!(progress[1].days, 0);
    }
    #[test]
    fn seven_distinct_voiced_days_finish_a_lesson_and_yesterday_keeps_streak_alive() {
        let base = complete(Kind::Note, Task::Imitate, 6, "seven", false);
        let receipts: Vec<_> = (1..=7)
            .map(|day| Completion {
                completed_at: at(day),
                session_id: format!("day-{day}"),
                ..base.clone()
            })
            .collect();
        let program = Program {
            level: 0,
            started_at: at(1),
        };
        let p = stages(&program, &receipts, at(7));
        assert!(p[0].done);
        assert_eq!(p[0].days, 7);
        assert!(p[0].practiced_today);
        assert_eq!(p[0].day_index, 6);
        assert_eq!(streak(Some(&program), &receipts, at(8)), 7);
        assert_eq!(streak(Some(&program), &receipts, at(9)), 0);
    }
    #[test]
    fn interval_day_requires_eighteen_attempts_and_matching_focus() {
        let mut r = complete(Kind::Interval, Task::Imitate, 18, "interval-day", false);
        r.completed_at = at(2);
        r.interval_semitones = Some(2);
        let program = Program {
            level: 0,
            started_at: at(1),
        };
        assert!(stages(&program, &[r.clone()], at(2))[1].practiced_today);
        r.interval_semitones = Some(3);
        let p = stages(&program, &[r], at(2));
        assert_eq!(p[1].days, 0);
        assert_eq!(p[2].days, 1);
    }
    #[test]
    fn lesson_setup_rotates_playable_keys_without_expanding_the_singers_range() {
        let config = Config {
            low: 57,
            high: 59,
            ..Default::default()
        };
        let next = setup(lessons(0)[0], 4, &config, &[], at(2));
        assert_eq!((next.low, next.high), (57, 59));
        assert_eq!(next.direction, DirectionChoice::Descending);
        assert_eq!(next.length, 18);
        assert!(generate(&next).is_ok());
        let mut receipt = complete(Kind::Note, Task::Imitate, 1, "rotation", false);
        receipt.completed_at = at(2);
        receipt.key.tonic_pc = next.tonic;
        let another = setup(lessons(0)[0], 4, &config, &[receipt], at(2));
        assert_ne!(another.tonic, next.tonic);
        assert_eq!((another.low, another.high), (57, 59));
    }
}

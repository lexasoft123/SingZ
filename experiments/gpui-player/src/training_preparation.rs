//! Song preparation recipes and load identity. Keys need their own current
//! detector stamp; the melody detector stamp cannot authorize a saved key.
use super::training_domain::{Config, Kind};
use serde_json::Value;
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Choice {
    Notes,
    Intervals,
    Chords,
    Mixed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Key {
    pub tonic: u8,
    pub minor: bool,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Song {
    pub source: u64,
    pub name: String,
    pub key: Option<Key>,
    pub transpose: i32,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Context {
    pub source: u64,
    pub name: String,
    pub choice: Choice,
}
pub fn effective_key(raw: &Value, transpose: i32) -> Option<Key> {
    if !crate::project_key::stored_current(raw) {
        return None;
    }
    let pc = raw["pc"].as_u64()?;
    if pc >= 12 {
        return None;
    }
    Some(Key {
        tonic: (pc as i64 + transpose as i64).rem_euclid(12) as u8,
        minor: raw["minor"].as_bool()?,
    })
}
pub fn recipe(current: &Config, key: Key, choice: Choice) -> Config {
    let mut result = current.clone();
    result.tonic = key.tonic;
    result.minor = key.minor;
    result.intervals = (2..=8).collect();
    result.length = if choice == Choice::Mixed { 8 } else { 6 };
    result.kind = match choice {
        Choice::Notes => Kind::Degree,
        Choice::Intervals => Kind::Interval,
        Choice::Chords | Choice::Mixed => Kind::Mixed,
    };
    result.mixed_kinds = match choice {
        Choice::Chords => vec![Kind::Chord, Kind::Arpeggio],
        Choice::Mixed => vec![Kind::Degree, Kind::Interval, Kind::Chord, Kind::Arpeggio],
        _ => vec![
            Kind::Note,
            Kind::Degree,
            Kind::Interval,
            Kind::Chord,
            Kind::Arpeggio,
        ],
    };
    result
}
pub fn requirements(config: &Config) -> (bool, bool, bool) {
    let kinds = if config.kind == Kind::Mixed {
        config.mixed_kinds.clone()
    } else {
        vec![config.kind]
    };
    (
        kinds.contains(&Kind::Interval),
        kinds
            .iter()
            .any(|k| matches!(k, Kind::Chord | Kind::Arpeggio)),
        kinds
            .iter()
            .any(|k| matches!(k, Kind::Interval | Kind::Arpeggio | Kind::Scale)),
    )
}
#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;
    #[test]
    fn floating_current_and_newer_key_stamps_authorize_training() {
        let actual: Vec<_> = [2.0, 2.5].into_iter().map(|stamp| {
            effective_key(&json!({"pc":11,"minor":true,"detVersion":stamp}), 2)
        }).collect();
        assert_eq!(actual, vec![Some(Key { tonic: 1, minor: true }); 2]);
    }
    #[test]
    fn only_a_valid_current_key_stamp_can_authorize_transposition() {
        let key = json!({"pc":11,"minor":true,"detVersion":2});
        assert_eq!(
            effective_key(&key, 2),
            Some(Key {
                tonic: 1,
                minor: true
            })
        );
        assert_eq!(
            effective_key(&key, -24),
            Some(Key {
                tonic: 11,
                minor: true
            })
        );
        for bad in [
            json!({"pc":0,"minor":false,"detVersion":1}),
            json!({"pc":12,"minor":false,"detVersion":2}),
            json!({"pc":0,"detVersion":2}),
            json!({"pc":0,"minor":"minor","detVersion":2}),
        ] {
            assert!(effective_key(&bad, 0).is_none());
        }
        assert_eq!(key["pc"], 11);
    }
    #[test]
    fn controls_follow_only_the_concrete_recipe_kinds() {
        let config = Config::default();
        let key = Key {
            tonic: 0,
            minor: false,
        };
        assert_eq!(
            requirements(&recipe(&config, key, Choice::Notes)),
            (false, false, false)
        );
        assert_eq!(
            requirements(&recipe(&config, key, Choice::Intervals)),
            (true, false, true)
        );
        assert_eq!(
            requirements(&recipe(&config, key, Choice::Chords)),
            (false, true, true)
        );
        assert_eq!(
            requirements(&recipe(&config, key, Choice::Mixed)),
            (true, true, true)
        );
    }
    #[test]
    fn recipes_keep_the_chosen_range_and_task_and_restrict_generated_kinds() {
        let config = Config {
            low: 57,
            high: 72,
            task: super::super::training_domain::Task::Find,
            ..Default::default()
        };
        for choice in [
            Choice::Notes,
            Choice::Intervals,
            Choice::Chords,
            Choice::Mixed,
        ] {
            let setup = recipe(
                &config,
                Key {
                    tonic: 2,
                    minor: true,
                },
                choice,
            );
            assert_eq!((setup.low, setup.high, setup.task), (57, 72, config.task));
            assert_eq!(setup.length, if choice == Choice::Mixed { 8 } else { 6 });
            assert_eq!((setup.tonic, setup.minor), (2, true));
            let prompts = super::super::training_domain::generate(&setup).unwrap();
            if choice == Choice::Chords {
                assert!(
                    prompts
                        .iter()
                        .all(|p| matches!(p.kind, Kind::Chord | Kind::Arpeggio))
                );
            }
            if choice == Choice::Mixed {
                assert!(prompts.iter().all(|p| p.kind != Kind::Note));
            }
        }
    }
}

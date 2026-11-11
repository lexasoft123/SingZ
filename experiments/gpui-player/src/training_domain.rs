//! Native port of shared/training-session.ts prompt generation. No audio/DSP.
//! Candidate order, seeded UTF-16 RNG and balanced rounds are intentional:
//! changing any of them changes the reproducible lesson.
use super::training_audio::{Cue, Purpose};
#[cfg(test)]
#[path = "training_domain_tests.rs"]
mod tests;
use anyhow::{Result, ensure};

#[derive(
    Clone, Copy, Debug, PartialEq, Eq, PartialOrd, Ord, serde::Serialize, serde::Deserialize,
)]
#[serde(rename_all = "kebab-case")]
pub enum Kind {
    Note,
    #[serde(rename = "scale-degree")]
    Degree,
    Interval,
    #[serde(rename = "chord-tone")]
    Chord,
    Arpeggio,
    Scale,
    Mixed,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Task {
    Imitate,
    Find,
    Identify,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Direction {
    Ascending,
    Descending,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DirectionChoice {
    Ascending,
    Descending,
    Both,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Quality {
    Major,
    Minor,
    Diminished,
    Augmented,
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Role {
    Root,
    Third,
    Fifth,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Target {
    pub midi: u8,
    pub degree: u8,
    pub note_name: String,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Chord {
    pub degree: u8,
    pub root_name: String,
    pub quality: Quality,
    pub tones: Vec<Target>,
}
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Prompt {
    pub index: usize,
    pub kind: Kind,
    pub task: Task,
    pub targets: Vec<Target>,
    pub cues: Vec<Cue>,
    pub direction: Option<Direction>,
    pub interval: Option<u8>,
    pub chord: Option<Chord>,
    pub role: Option<Role>,
}
#[derive(Clone, Debug)]
pub struct Config {
    pub tonic: u8,
    pub minor: bool,
    pub low: u8,
    pub high: u8,
    pub kind: Kind,
    pub task: Task,
    pub length: usize,
    pub seed: String,
    pub direction: DirectionChoice,
    pub harmonic_scale: bool,
    pub harmonic_dominant: bool,
    pub intervals: Vec<u8>,
    pub interval_semitones: Option<u8>,
    pub chord_degrees: Vec<u8>,
    pub mixed_kinds: Vec<Kind>,
    pub guided_scale: bool,
}
const MIXED: [Kind; 5] = [
    Kind::Note,
    Kind::Degree,
    Kind::Interval,
    Kind::Chord,
    Kind::Arpeggio,
];
impl Default for Config {
    fn default() -> Self {
        Self {
            tonic: 0,
            minor: false,
            low: 48,
            high: 72,
            kind: Kind::Note,
            task: Task::Imitate,
            length: 20,
            seed: "lesson-1".into(),
            direction: DirectionChoice::Both,
            harmonic_scale: false,
            harmonic_dominant: true,
            intervals: (2..=8).collect(),
            interval_semitones: None,
            chord_degrees: (1..=7).collect(),
            mixed_kinds: MIXED.to_vec(),
            guided_scale: true,
        }
    }
}
impl Config {
    pub fn validate(&self) -> Result<()> {
        ensure!(
            self.tonic < 12 && self.low <= self.high && self.high <= 127,
            "Invalid training key/range"
        );
        ensure!((1..=1000).contains(&self.length), "Invalid training length");
        ensure!(
            self.kind != Kind::Scale || self.task == Task::Imitate,
            "Scales require singing"
        );
        ensure!(
            self.interval_semitones
                .is_none_or(|n| (1..=12).contains(&n)),
            "Invalid focused interval distance"
        );
        ensure!(
            !self.mixed_kinds.is_empty()
                && self.mixed_kinds.len() <= 5
                && self.mixed_kinds.iter().all(|k| MIXED.contains(k))
                && unique(&self.mixed_kinds),
            "Invalid mixed exercise selection"
        );
        let kinds = if self.kind == Kind::Mixed {
            self.mixed_kinds.clone()
        } else {
            vec![self.kind]
        };
        ensure!(
            self.intervals.len() <= 7
                && self.intervals.iter().all(|n| (2..=8).contains(n))
                && unique(&self.intervals)
                && (!kinds.contains(&Kind::Interval) || !self.intervals.is_empty()),
            "Invalid interval sizes"
        );
        ensure!(
            self.chord_degrees.len() <= 7
                && self.chord_degrees.iter().all(|n| (1..=7).contains(n))
                && unique(&self.chord_degrees)
                && (!(kinds.contains(&Kind::Chord) || kinds.contains(&Kind::Arpeggio))
                    || !self.chord_degrees.is_empty()),
            "Invalid chord degrees"
        );
        Ok(())
    }
    fn directions(&self) -> Vec<Direction> {
        match self.direction {
            DirectionChoice::Both => vec![Direction::Ascending, Direction::Descending],
            DirectionChoice::Ascending => vec![Direction::Ascending],
            DirectionChoice::Descending => vec![Direction::Descending],
        }
    }
    fn steps(&self, harmonic: bool) -> [i32; 7] {
        if !self.minor {
            [0, 2, 4, 5, 7, 9, 11]
        } else if harmonic {
            [0, 2, 3, 5, 7, 8, 11]
        } else {
            [0, 2, 3, 5, 7, 8, 10]
        }
    }
    fn target(&self, midi: i32, degree: u8, harmonic: bool) -> Target {
        Target {
            midi: midi as u8,
            degree,
            note_name: super::training_music::note_name_form(
                midi,
                self.tonic as usize,
                self.minor,
                harmonic,
            ),
        }
    }
    fn placements(&self, offsets: &[i32]) -> Vec<Vec<i32>> {
        placements(offsets, self.low as i32, self.high as i32)
    }
    fn context(&self) -> Cue {
        let steps = self.steps(false);
        let offsets = [0, 2, 4].map(|i| self.tonic as i32 + steps[i]);
        let all = placements(&offsets, 48, 72);
        let chosen = all
            .into_iter()
            .min_by_key(|notes| ((notes[0] + notes[2]) - 120).abs())
            .expect("Tonic context always fits C3-C5");
        cue(
            Purpose::Context,
            true,
            chosen.iter().map(|m| *m as u8).collect(),
        )
    }
    fn chords(&self, degree: u8) -> Vec<Chord> {
        let harmonic = self.minor && self.harmonic_dominant && degree == 5;
        let steps = self.steps(harmonic);
        let root = degree as usize - 1;
        let offsets = [0, 2, 4].map(|thirds| {
            let i = root + thirds;
            self.tonic as i32 + steps[i % 7] + (i / 7) as i32 * 12
        });
        let quality = match (offsets[1] - offsets[0], offsets[2] - offsets[0]) {
            (4, 7) => Quality::Major,
            (3, 7) => Quality::Minor,
            (3, 6) => Quality::Diminished,
            (4, 8) => Quality::Augmented,
            _ => unreachable!("Diatonic triad"),
        };
        self.placements(&offsets)
            .into_iter()
            .map(|notes| {
                let tones: Vec<_> = notes
                    .iter()
                    .enumerate()
                    .map(|(i, m)| self.target(*m, ((root + i * 2) % 7 + 1) as u8, harmonic))
                    .collect();
                let root_name = tones[0]
                    .note_name
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-')
                    .to_owned();
                Chord {
                    degree,
                    root_name,
                    quality,
                    tones,
                }
            })
            .collect()
    }
    fn candidates(&self, kind: Kind) -> Vec<Prompt> {
        let mut output = vec![];
        let steps = self.steps(self.harmonic_scale);
        let base = |targets: Vec<Target>, cues: Vec<Cue>| Prompt {
            index: 0,
            kind,
            task: self.task,
            targets,
            cues,
            direction: None,
            interval: None,
            chord: None,
            role: None,
        };
        match kind {
            Kind::Note | Kind::Degree => {
                for (i, step) in steps.iter().enumerate() {
                    for midi in self.low..=self.high {
                        if midi as i32 % 12 != (self.tonic as i32 + step) % 12 {
                            continue;
                        }
                        let mut cues = vec![self.context()];
                        if self.task != Task::Find {
                            cues.push(cue(
                                if self.task == Task::Imitate {
                                    Purpose::Answer
                                } else {
                                    Purpose::Question
                                },
                                false,
                                vec![midi],
                            ));
                        }
                        output.push(base(
                            vec![self.target(midi as i32, i as u8 + 1, self.harmonic_scale)],
                            cues,
                        ));
                    }
                }
            }
            Kind::Interval => {
                for from in 0..7 {
                    for number in &self.intervals {
                        for direction in self.directions() {
                            let to = from
                                + if direction == Direction::Ascending {
                                    *number as i32 - 1
                                } else {
                                    1 - *number as i32
                                };
                            let semitones = steps[to.rem_euclid(7) as usize]
                                + to.div_euclid(7) * 12
                                - steps[from as usize];
                            if self
                                .interval_semitones
                                .is_some_and(|distance| distance as i32 != semitones.abs())
                            {
                                continue;
                            }
                            let offset = self.tonic as i32 + steps[from as usize];
                            for notes in self.placements(&[offset, offset + semitones]) {
                                let targets = vec![
                                    self.target(notes[0], from as u8 + 1, self.harmonic_scale),
                                    self.target(
                                        notes[1],
                                        to.rem_euclid(7) as u8 + 1,
                                        self.harmonic_scale,
                                    ),
                                ];
                                let played = if self.task == Task::Find {
                                    vec![notes[0] as u8]
                                } else {
                                    notes.iter().map(|m| *m as u8).collect()
                                };
                                let mut prompt = base(
                                    targets,
                                    vec![
                                        self.context(),
                                        cue(
                                            if self.task == Task::Imitate {
                                                Purpose::Answer
                                            } else {
                                                Purpose::Question
                                            },
                                            false,
                                            played,
                                        ),
                                    ],
                                );
                                prompt.direction = Some(direction);
                                prompt.interval = Some(*number);
                                output.push(prompt);
                            }
                        }
                    }
                }
            }
            Kind::Chord | Kind::Arpeggio => {
                for degree in &self.chord_degrees {
                    for chord in self.chords(*degree) {
                        let notes: Vec<_> = chord.tones.iter().map(|t| t.midi).collect();
                        if kind == Kind::Chord {
                            for (index, role) in [Role::Root, Role::Third, Role::Fifth]
                                .into_iter()
                                .enumerate()
                            {
                                let mut cues = vec![
                                    self.context(),
                                    cue(Purpose::Question, true, notes.clone()),
                                ];
                                if self.task != Task::Find {
                                    cues.push(cue(
                                        if self.task == Task::Imitate {
                                            Purpose::Answer
                                        } else {
                                            Purpose::Question
                                        },
                                        false,
                                        vec![notes[index]],
                                    ));
                                }
                                let mut prompt = base(vec![chord.tones[index].clone()], cues);
                                prompt.chord = Some(chord.clone());
                                prompt.role = Some(role);
                                output.push(prompt);
                            }
                        } else {
                            for direction in self.directions() {
                                let mut targets = chord.tones.clone();
                                if direction == Direction::Descending {
                                    targets.reverse();
                                }
                                let played = if self.task == Task::Find {
                                    notes.clone()
                                } else {
                                    targets.iter().map(|t| t.midi).collect()
                                };
                                let mut prompt = base(
                                    targets,
                                    vec![
                                        self.context(),
                                        cue(
                                            if self.task == Task::Imitate {
                                                Purpose::Answer
                                            } else {
                                                Purpose::Question
                                            },
                                            self.task == Task::Find,
                                            played,
                                        ),
                                    ],
                                );
                                prompt.chord = Some(chord.clone());
                                prompt.direction = Some(direction);
                                output.push(prompt);
                            }
                        }
                    }
                }
            }
            Kind::Scale => {
                for tonic in self.low..=self.high {
                    if tonic % 12 != self.tonic || tonic as u16 + 12 > self.high as u16 {
                        continue;
                    }
                    for direction in self.directions() {
                        let mut targets: Vec<_> = (0..8)
                            .map(|i| {
                                self.target(
                                    tonic as i32 + if i == 7 { 12 } else { steps[i] },
                                    (i % 7 + 1) as u8,
                                    self.harmonic_scale,
                                )
                            })
                            .collect();
                        if direction == Direction::Descending {
                            targets.reverse();
                        }
                        let notes = targets.iter().map(|t| t.midi).collect();
                        let mut prompt = base(targets, vec![cue(Purpose::Answer, false, notes)]);
                        prompt.direction = Some(direction);
                        output.push(prompt);
                    }
                }
            }
            Kind::Mixed => unreachable!("Mixed is a recipe, not a prompt"),
        }
        output
    }
}
fn unique<T: PartialEq>(items: &[T]) -> bool {
    items
        .iter()
        .enumerate()
        .all(|(i, item)| !items[..i].contains(item))
}
fn placements(offsets: &[i32], low: i32, high: i32) -> Vec<Vec<i32>> {
    let first = (low - offsets.iter().min().unwrap() + 11).div_euclid(12) * 12;
    let last = (high - offsets.iter().max().unwrap()).div_euclid(12) * 12;
    if first > last {
        return vec![];
    }
    (first..=last)
        .step_by(12)
        .map(|root| offsets.iter().map(|offset| root + offset).collect())
        .collect()
}
fn cue(purpose: Purpose, together: bool, notes: Vec<u8>) -> Cue {
    Cue {
        purpose,
        together,
        notes,
    }
}
impl Prompt {
    /// Current English source wording; locale dictionaries remain a separate
    /// port task. Musical names are data and keep their source spelling.
    pub fn instruction(&self) -> String {
        if self.task == Task::Identify {
            return match self.kind {
                Kind::Note => "Identify the note.",
                Kind::Degree => "Identify the scale degree.",
                Kind::Interval => "Identify the interval.",
                Kind::Chord => "Identify the chord tone.",
                Kind::Arpeggio => "Identify the arpeggiated chord.",
                _ => unreachable!("Scale identification is invalid"),
            }
            .into();
        }
        let direction = if self.direction == Some(Direction::Descending) {
            "descending"
        } else {
            "ascending"
        };
        let chord_name = || {
            let c = self.chord.as_ref().unwrap();
            format!(
                "{} {}",
                c.root_name,
                match c.quality {
                    Quality::Major => "major",
                    Quality::Minor => "minor",
                    Quality::Diminished => "diminished",
                    Quality::Augmented => "augmented",
                }
            )
        };
        match self.kind {
            Kind::Note => format!("Match {}.", self.targets[0].note_name),
            Kind::Degree => format!(
                "Sing scale degree {} — {}.",
                self.targets[0].degree, self.targets[0].note_name
            ),
            Kind::Interval => {
                let number = self.interval.unwrap() as usize;
                let semitones = self.targets[0].midi.abs_diff(self.targets[1].midi) as i32;
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
                format!(
                    "Sing {quality} {ordinal} {direction} — {} to {}.",
                    self.targets[0].note_name, self.targets[1].note_name
                )
            }
            Kind::Chord => format!(
                "Sing the {} of {} — {}.",
                match self.role.unwrap() {
                    Role::Root => "root",
                    Role::Third => "third",
                    Role::Fifth => "fifth",
                },
                chord_name(),
                self.targets[0].note_name
            ),
            Kind::Arpeggio => format!("Arpeggiate {} {direction}.", chord_name()),
            Kind::Scale => format!(
                "{} · {direction}",
                self.targets[0]
                    .note_name
                    .trim_end_matches(|c: char| c.is_ascii_digit() || c == '-')
            ),
            Kind::Mixed => unreachable!("Mixed is not a prompt"),
        }
    }
    /// Port of shared/training-reference.ts. Guided imitation presents the
    /// next target separately; it must not play the whole answer in advance.
    pub fn references(&self, guided_scale: bool) -> Vec<Reference> {
        let purpose = if self.task == Task::Imitate {
            Purpose::Answer
        } else {
            Purpose::Question
        };
        if self.kind == Kind::Note && self.task == Task::Imitate {
            return vec![Reference {
                cue: cue(purpose, false, vec![self.targets[0].midi]),
                duration_seconds: 2.75,
            }];
        }
        if self.kind == Kind::Scale && guided_scale {
            return vec![target_reference(Kind::Scale, self.targets[0].midi)];
        }
        if self.kind == Kind::Interval {
            return vec![Reference {
                cue: cue(
                    purpose,
                    false,
                    self.targets
                        .iter()
                        .take(if self.task == Task::Identify { 2 } else { 1 })
                        .map(|t| t.midi)
                        .collect(),
                ),
                duration_seconds: 4.,
            }];
        }
        let start = if self.kind == Kind::Chord && self.task == Task::Imitate {
            self.cues.len().saturating_sub(2)
        } else {
            0
        };
        self.cues[start..]
            .iter()
            .map(|cue| Reference {
                cue: cue.clone(),
                duration_seconds: 1.82,
            })
            .collect()
    }
    pub fn needs_target_reference(&self, guided_scale: bool) -> bool {
        self.task == Task::Imitate
            && (self.kind == Kind::Interval || self.kind == Kind::Scale && guided_scale)
    }
    fn signature(&self) -> (Kind, Vec<u8>) {
        (self.kind, self.targets.iter().map(|t| t.midi).collect())
    }
    fn category(&self) -> String {
        match self.kind {
            Kind::Interval => format!("{:?}:{:?}", self.interval, self.direction),
            Kind::Chord => format!("{:?}", self.role),
            Kind::Arpeggio => format!(
                "{}:{:?}",
                self.chord.as_ref().unwrap().degree,
                self.direction
            ),
            _ => "notes".into(),
        }
    }
}
#[derive(Clone, Debug)]
pub struct Reference {
    pub cue: Cue,
    pub duration_seconds: f32,
}
pub fn target_reference(kind: Kind, midi: u8) -> Reference {
    Reference {
        cue: cue(Purpose::Answer, false, vec![midi]),
        duration_seconds: if kind == Kind::Interval { 4. } else { 1.82 },
    }
}
// The shared generator uses FNV32 over JS UTF-16 code units then Mulberry32.
struct Rng(u32);
impl Rng {
    fn new(seed: &str) -> Self {
        Self(seed.encode_utf16().fold(2166136261u32, |hash, code| {
            (hash ^ code as u32).wrapping_mul(16777619)
        }))
    }
    fn next(&mut self) -> f64 {
        self.0 = self.0.wrapping_add(0x6d2b79f5);
        let mut value = (self.0 ^ (self.0 >> 15)).wrapping_mul(1 | self.0);
        value = value.wrapping_add((value ^ (value >> 7)).wrapping_mul(61 | value)) ^ value;
        (value ^ (value >> 14)) as f64 / 4294967296.
    }
    fn index(&mut self, length: usize) -> usize {
        (self.next() * length as f64).floor() as usize
    }
    fn shuffle<T>(&mut self, items: &mut [T]) {
        for i in (1..items.len()).rev() {
            let j = self.index(i + 1);
            items.swap(i, j);
        }
    }
}
fn balanced(pool: &[Prompt], rng: &mut Rng) -> Vec<Prompt> {
    let mut groups: Vec<(String, Vec<Prompt>)> = vec![];
    for prompt in pool {
        let category = prompt.category();
        if let Some((_, queue)) = groups.iter_mut().find(|g| g.0 == category) {
            queue.push(prompt.clone());
        } else {
            groups.push((category, vec![prompt.clone()]));
        }
    }
    for (_, queue) in &mut groups {
        rng.shuffle(queue);
    }
    let mut round = vec![];
    loop {
        let mut indexes: Vec<_> = (0..groups.len())
            .filter(|i| !groups[*i].1.is_empty())
            .collect();
        if indexes.is_empty() {
            break;
        }
        rng.shuffle(&mut indexes);
        for index in indexes {
            round.push(groups[index].1.pop().unwrap());
        }
    }
    round.reverse();
    round
}
pub fn generate(config: &Config) -> Result<Vec<Prompt>> {
    config.validate()?;
    let mut config = config.clone();
    config.intervals.sort();
    config.chord_degrees.sort();
    config.mixed_kinds.sort();
    let mut rng = Rng::new(&config.seed);
    let kinds = if config.kind == Kind::Mixed {
        config.mixed_kinds.clone()
    } else {
        vec![config.kind]
    };
    let available: Vec<_> = kinds
        .into_iter()
        .map(|kind| (kind, config.candidates(kind)))
        .filter(|(_, pool)| !pool.is_empty())
        .collect();
    ensure!(
        !available.is_empty(),
        "No requested exercises fit the comfortable working range."
    );
    if config.kind == Kind::Interval && config.task == Task::Imitate {
        return interval_lesson(&config, &available[0].1, &mut rng);
    }
    let offset = if config.kind == Kind::Mixed {
        rng.index(available.len())
    } else {
        0
    };
    let mut rounds: Vec<Vec<Prompt>> = vec![vec![]; available.len()];
    let mut prompts: Vec<Prompt> = vec![];
    for index in 0..config.length {
        let selected = if config.kind == Kind::Mixed {
            (index + offset) % available.len()
        } else {
            0
        };
        let pool = &available[selected].1;
        let round = &mut rounds[selected];
        if round.is_empty() {
            *round = balanced(pool, &mut rng);
            if round.len() > 1
                && prompts.last().is_some_and(|previous| {
                    previous.signature() == round.last().unwrap().signature()
                })
            {
                let mut categories: Vec<String> = vec![];
                for prompt in pool {
                    let category = prompt.category();
                    if !categories.contains(&category) {
                        categories.push(category);
                    }
                }
                let last = round.len() - 1;
                let category = round[last].category();
                let previous = prompts.last().unwrap().signature();
                if let Some(j) = round.iter().enumerate().position(|(i, candidate)| {
                    candidate.signature() != previous
                        && (candidate.category() == category || i >= round.len() - categories.len())
                }) {
                    round.swap(j, last);
                }
            }
        }
        let mut prompt = round.pop().unwrap();
        prompt.index = index + 1;
        prompts.push(prompt);
    }
    Ok(prompts)
}
fn interval_lesson(config: &Config, pool: &[Prompt], rng: &mut Rng) -> Result<Vec<Prompt>> {
    let distance = |p: &Prompt| p.targets[0].midi.abs_diff(p.targets[1].midi);
    let mut groups: Vec<Vec<Prompt>> = vec![];
    for p in pool {
        if let Some(group) = groups
            .iter_mut()
            .find(|group| group[0].direction == p.direction && distance(&group[0]) == distance(p))
        {
            group.push(p.clone());
        } else {
            groups.push(vec![p.clone()]);
        }
    }
    groups.sort_by_key(|group| {
        (
            distance(&group[0]),
            group[0].direction == Some(Direction::Descending),
        )
    });
    for group in &mut groups {
        // Map preserves first insertion position and replaces its value with the
        // last candidate having this starting note, as in the shared Map constructor.
        let mut queue: Vec<Prompt> = vec![];
        for p in group.iter() {
            if let Some(existing) = queue
                .iter_mut()
                .find(|old| old.targets[0].midi == p.targets[0].midi)
            {
                *existing = p.clone();
            } else {
                queue.push(p.clone());
            }
        }
        queue.sort_by_key(|p| p.targets[0].midi);
        *group = queue;
    }
    let mut lesson = vec![];
    if config.interval_semitones.is_none() {
        let mut distances = vec![];
        for group in &groups {
            let d = distance(&group[0]);
            if !distances.contains(&d) {
                distances.push(d);
            }
        }
        let blocks = config.length.div_ceil(3);
        for block in 0..blocks {
            let d = distances[if blocks == 1 {
                rng.index(distances.len())
            } else {
                (block as f64 * (distances.len() - 1) as f64 / (blocks - 1) as f64).round() as usize
            }];
            let matching: Vec<_> = groups.iter().filter(|q| distance(&q[0]) == d).collect();
            let queue = matching[rng.index(matching.len())];
            let p = &queue[rng.index(queue.len())];
            for _ in 0..3 {
                if lesson.len() == config.length {
                    break;
                }
                let mut p = p.clone();
                p.index = lesson.len() + 1;
                lesson.push(p);
            }
        }
    } else {
        let mut round = 0;
        while lesson.len() < config.length {
            for queue in &groups {
                for position in 0..3.min(queue.len()) {
                    let p = &queue[(round * 3 + position) % queue.len()];
                    for _ in 0..3 {
                        if lesson.len() == config.length {
                            break;
                        }
                        let mut p = p.clone();
                        p.index = lesson.len() + 1;
                        lesson.push(p);
                    }
                    if lesson.len() == config.length {
                        break;
                    }
                }
                if lesson.len() == config.length {
                    break;
                }
            }
            round += 1;
        }
    }
    Ok(lesson)
}

//! Note spelling from shared/music-theory.ts, including written octave boundaries.
const LETTERS: [&str; 7] = ["C", "D", "E", "F", "G", "A", "B"];
const PCS: [i32; 7] = [0, 2, 4, 5, 7, 9, 11];
const MAJOR: [&str; 12] = [
    "C", "D♭", "D", "E♭", "E", "F", "F♯", "G", "A♭", "A", "B♭", "B",
];
const MINOR: [&str; 12] = [
    "C", "C♯", "D", "E♭", "E", "F", "F♯", "G", "G♯", "A", "B♭", "B",
];
const FLATS: [&str; 12] = [
    "C", "D♭", "D", "E♭", "E", "F", "G♭", "G", "A♭", "A", "B♭", "B",
];
const SHARPS: [&str; 12] = [
    "C", "C♯", "D", "D♯", "E", "F", "F♯", "G", "G♯", "A", "A♯", "B",
];
pub fn note_name(midi: i32, tonic: usize, minor: bool) -> String {
    note_name_form(midi, tonic, minor, false)
}
pub fn note_name_form(midi: i32, tonic: usize, minor: bool, harmonic: bool) -> String {
    // Setup selectors guarantee a pitch class; external saved-state parsing must
    // validate the same domain before constructing a setup.
    assert!(tonic < 12);
    let name = if minor { MINOR[tonic] } else { MAJOR[tonic] };
    let first = LETTERS
        .iter()
        .position(|letter| name.starts_with(letter))
        .unwrap();
    let steps = if minor && harmonic {
        [0, 2, 3, 5, 7, 8, 11]
    } else if minor {
        [0, 2, 3, 5, 7, 8, 10]
    } else {
        [0, 2, 4, 5, 7, 9, 11]
    };
    let pc = midi.rem_euclid(12);
    let (spelling, accidental) = if let Some(degree) = steps
        .iter()
        .position(|step| (tonic as i32 + step).rem_euclid(12) == pc)
    {
        let letter = (first + degree) % 7;
        let mut delta = (pc - PCS[letter]).rem_euclid(12);
        if delta > 6 {
            delta -= 12;
        }
        let suffix = match delta {
            -2 => "♭♭",
            -1 => "♭",
            1 => "♯",
            2 => "♯♯",
            _ => "",
        };
        (format!("{}{suffix}", LETTERS[letter]), delta)
    } else {
        let fallback = if name.contains('♭') {
            FLATS[pc as usize]
        } else {
            SHARPS[pc as usize]
        };
        (
            fallback.to_string(),
            if fallback.contains('♭') {
                -1
            } else if fallback.contains('♯') {
                1
            } else {
                0
            },
        )
    };
    format!("{spelling}{}", (midi - accidental).div_euclid(12) - 1)
}
#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn training_range_uses_key_spelling_and_written_octave() {
        assert_eq!(note_name(61, 0, false), "C♯4");
        assert_eq!(note_name(61, 1, false), "D♭4");
        assert_eq!(note_name(61, 1, true), "C♯4");
        assert_eq!(note_name(65, 6, false), "E♯4");
        assert_eq!(note_name(59, 3, true), "C♭4");
        assert_eq!(note_name(48, 0, false), "C3");
        assert_eq!(note_name(72, 0, false), "C5");
    }
}

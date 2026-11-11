use super::*;
#[test]
fn long_song_pitch_duration_binding_preserves_seconds() {
    for minutes in [8, 9, 12, 60] {
        let duration = minutes as f64 * 60. + 0.123456;
        let source = duration - 0.234567;
        let mut pitch = Pitch::default();
        pitch.bind_duration_for_lane(duration, Some(source));
        assert!(
            (pitch.duration - duration).abs() < 1e-9,
            "{minutes} minute timeline narrowed"
        );
        assert!((pitch.analysis_duration() - source).abs() < 1e-9);
    }
}
#[test]
fn long_song_pitch_hop_and_note_times_preserve_frame_precision() {
    for minutes in [8, 9, 12, 60] {
        let hop = 0.025125_f64;
        let frames = (minutes as f64 * 60. / hop).ceil() as usize;
        let raw = serde_json::json!({"melody":{"hopSec":hop,"detVersion":4,"f0":format!("x{} 2400 2400 2400 2400 2400 2400 2400 2400", frames-8)}});
        let mut pitch = Pitch::read(&raw);
        pitch.bind_duration(frames as f64 * hop);
        assert!(
            (pitch.hop - hop).abs() < 1e-12,
            "{minutes} minute hop narrowed"
        );
        for notes in [&pitch.notes, &pitch.frame_notes] {
            let note = notes.last().unwrap();
            assert!((note.start - (frames - 8) as f64 * hop).abs() < 1e-9);
            assert!((note.end - frames as f64 * hop).abs() < 1e-9);
        }
    }
}

use super::*;
#[test]
fn long_song_zoomed_gesture_keeps_seconds_until_pixel_conversion() {
    for minutes in [8, 9, 12, 60] {
        let start = minutes as f64 * 60. - 0.123456;
        let end = start + 2.;
        let mut gesture = Gesture::begin(1, 25., 0., 100., start, end, None).unwrap();
        assert!(
            (gesture.clicked().unwrap() - (start + 0.5)).abs() < 1e-9,
            "{minutes} minute seek lost precision"
        );
        let (a, b) = gesture.moved(75.).unwrap();
        assert!((a - (start + 0.5)).abs() < 1e-9 && (b - (start + 1.5)).abs() < 1e-9);
        let command = Target {
            selection: Some((a, b)),
            looping: true,
        }
        .command(end + 1.);
        let values: Vec<_> = command.split_whitespace().collect();
        assert!((values[1].parse::<f64>().unwrap() - (start + 0.5)).abs() < 1e-9);
        assert!((values[2].parse::<f64>().unwrap() - (start + 1.5)).abs() < 1e-9);
    }
}

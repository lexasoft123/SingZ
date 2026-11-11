use super::{ruler_label, ruler_ticks};
use crate::timeline_viewport::View;
#[test]
fn ruler_tenth_second_labels_do_not_accumulate_rounding() {
    let labels: Vec<_> = ruler_ticks(
        View {
            start: 0.,
            end: 1.1,
        },
        0.1,
    )
    .into_iter()
    .map(|(tick, _)| ruler_label(tick, 0.1))
    .collect();
    assert_eq!(
        labels,
        [
            "0:00.1", "0:00.2", "0:00.3", "0:00.4", "0:00.5", "0:00.6", "0:00.7", "0:00.8",
            "0:00.9", "0:01.0"
        ]
    );
}
#[test]
fn ruler_tenth_second_labels_cross_the_minute_at_long_positions() {
    let labels: Vec<_> = ruler_ticks(
        View {
            start: 3599.5,
            end: 3601.1,
        },
        0.1,
    )
    .into_iter()
    .map(|(tick, _)| ruler_label(tick, 0.1))
    .collect();
    assert_eq!(
        labels,
        [
            "59:59.5", "59:59.6", "59:59.7", "59:59.8", "59:59.9", "60:00.0", "60:00.1", "60:00.2",
            "60:00.3", "60:00.4", "60:00.5", "60:00.6", "60:00.7", "60:00.8", "60:00.9", "60:01.0"
        ]
    );
}

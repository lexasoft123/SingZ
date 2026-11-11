use super::inflight::Inflight;

#[test]
fn stale_epoch_keeps_current_request() {
    let mut flight = Inflight::default();
    let serial = flight.begin(2, "current");
    assert_eq!(flight.settle(1, serial), None);
    assert!(flight.busy());
    assert_eq!(flight.settle(2, serial), Some("current"));
}
#[test]
fn stale_serial_keeps_current_request() {
    let mut flight = Inflight::default();
    let old = flight.begin(1, "old");
    let current = flight.begin(1, "current");
    assert_eq!(flight.settle(1, old), None);
    assert!(flight.busy());
    assert_eq!(flight.settle(1, current), Some("current"));
}
#[test]
fn cancel_rejects_receipt() {
    let mut flight = Inflight::default();
    let serial = flight.begin(1, "cancelled");
    flight.cancel();
    assert!(!flight.busy());
    assert_eq!(flight.settle(1, serial), None);
}
#[test]
fn reuse_after_settle_rejects_old_receipt() {
    let mut flight = Inflight::default();
    let old = flight.begin(1, "first");
    assert_eq!(flight.settle(1, old), Some("first"));
    assert!(!flight.busy());
    let current = flight.begin(1, "second");
    assert_ne!(old, current);
    assert_eq!(flight.settle(1, old), None);
    assert_eq!(flight.settle(1, current), Some("second"));
}

#[test]
fn loop_request_waits_for_rate_and_uses_latest_toggle() {
    let mut queue = super::inflight::QueuedLoop::default();
    let current = super::region_gesture::Target { selection: Some((2., 4.)), looping: false };
    queue.toggle(current);
    assert_eq!(queue.take(), Some(super::region_gesture::Target { looping: true, ..current }));
    queue.toggle(current);
    queue.toggle(current);
    assert_eq!(queue.take(), Some(current));
}

#[test]
fn settle_serial_ignores_epoch_but_not_stale_serial() {
    let mut flight = Inflight::default();
    let old = flight.begin(1, "old");
    let current = flight.begin(2, "current");
    assert_eq!(flight.settle_serial(old), None);
    assert!(flight.is_current(current));
    assert_eq!(flight.settle_serial(current), Some("current"));
    assert_eq!(flight.serial(), current);
}

#[test]
fn caller_chosen_serial_is_committed_and_retired() {
    let mut flight = Inflight::default();
    flight.begin_at(1, 7, "intent");
    assert_eq!(flight.serial(), 7);
    assert_eq!(flight.key(), Some((1, 7)));
    flight.retire_at(8);
    assert!(!flight.busy());
    assert_eq!(flight.settle(1, 7), None);
    assert_eq!(flight.begin(1, "next"), 9);
}

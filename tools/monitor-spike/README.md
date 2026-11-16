# Monitor spike clock policy

The harness explicitly enables `SampleClockPhaseConfig{2, 8}` through
`monitorPhaseConfig`: up to two samples, capped at 0.1 ms, and up to eight
unverified corrections in a rolling second. Default zCore histories continue
to reject those intervals. Resetting a history starts a fresh correction budget;
its diagnostic counters remain cumulative.

`clockHoleTest` exercises both policies with the actual capture/history/render
path and a 1024-frame queue: default rejection loses exactly 33/65/129 frames at
periods 32/64/128, and enabling tolerance loses zero with zero generation resets.
Raw timestamp anomaly diagnostics still flag the input slope anomaly even when
history corrects it; `rejectedIntervals` is the count of actual rejected clock
intervals. The final harness summary also prints the applied phase counters.

Where supported, capture installs `Capture::pushWithPosition` using the optional
backend `setPositionPush` API and passes genuine `sourcePosition` validity into
history. The legacy push supplies no hardware position; it never substitutes
callback counts. A hardware-counter gap still resets history. Host timestamps
and the take-writer path are preserved.

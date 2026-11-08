# HDMI-CEC remote input

The Linux Box UI owns a supervised Python 3 CEC follower. It uses the Linux CEC
UAPI directly; it does not parse CLI logs, inject global OS input, or control the
audio service. Desktop and the headless audio host never start it. Missing or
inaccessible adapters leave Box usable with keyboard/HID and phone controls.

## Input contract

| CEC user control | Box key |
| --- | --- |
| Select | Enter |
| Up, Down, Left, Right | Arrow keys |
| Exit / TV Back | Escape |
| Play, Pause | MediaPlayPause |
| Forward, Backward | MediaTrackNext, MediaTrackPrevious |

These are existing Box key semantics, including the current previous/next
behavior. TV volume, mute, power, standby and Stop are not translated. All input
passes through the normal remote focus and wake guard. A wake press and its
repeats must only reveal controls; a later distinct press may act. Native range
inputs retain their browser arrow-key defaults.

The helper accepts only TV-initiated user-control messages addressed to its own
logical address. It registers a Playback address and disables RC passthrough so
kernel-global keyboard input cannot duplicate app input. It never changes the
physical address or sends TV power, standby or active-source commands. Kernel
logical-address negotiation and core identity replies remain kernel responsibilities.
The helper answers only a valid TV-addressed Give Device Power Status query
with Report Power Status: On, describing this running appliance.

## Configuration and recovery

`SINGZ_BOX_CEC=0` disables the app bridge. Otherwise visible Linux Box launches
start it automatically; hidden automated app runs disable hardware input.
`SINGZ_BOX_CEC_DEVICE=/dev/cecN` optionally selects an adapter. By default exactly
one connected HDMI **transmitter** is required. Receiver adapters such as
`snps_hdmirx` are rejected even when explicitly configured; an HDMI input cannot
receive the remote for the TV's HDMI output.

The appliance launcher must opt in and expose the CEC character device to its
unprivileged UI container, with appropriate video-group access. New USB devices
may require recreating that container. The standard Debian Box package depends
on Python 3 and ships `resources/box-audio/cec-input.py`. Infrastructure device
exposure and kernel backport instructions belong in the `singz-box` repository.

Settings → Diagnostics reports disabled/starting/connected/unavailable/error
and the latest recognized input time. Discovery/receive failures retry with a
bounded delay. Reload, focus loss and disconnect release browser-held keys;
held repeats are blocked until a real release. A missing release is recovered
without allowing a delayed held wake press to act. No buffered input is replayed
into a reloaded or replacement window. Shutdown terminates the child with a
bounded fallback and releases only the helper's own logical-address claim.
Address registrations can survive a killed process. On restart, after acquiring
both exclusive roles, the helper may clear and reclaim only a matching SingZ
Box playback registration. Active owners and foreign or mismatched registrations
remain untouched; recovery does not require a display-driver reload or reboot.

The diagnostics API also exposes `lastReceiveToMainMs` and `lastPressAt` when
Linux supplies a valid receive timestamp. The interval compares the kernel's
`CLOCK_MONOTONIC` timestamp with Electron main's monotonic clock, preserving
nanoseconds as a decimal string across the helper pipe. It measures kernel
receive to main only; TV remote forwarding, CEC wire time, renderer work and
projector processing are outside this interval. Invalid or future timestamps do
not block input. TV focus colours and glow update without UIKit's desktop button
transitions on both focus entry and exit.

## Verification

- `npx vitest run tests/unit/box-cec.test.ts tests/unit/box-remote.test.ts` checks
  wake/repeats, focus, reconnect, bounded parsing and lifecycle with fake input.
- `node --test tests/tooling/box-cec-input.test.cjs` checks the real helper against
  injected UAPI operations and a foreign-initiator negative control, without
  opening hardware. The Unix-only fixture is skipped on Windows.
- `electron tests/e2e/box-cec-input-smoke.cjs` verifies real DOM key names,
  repeat flags and native slider behavior in a hidden isolated window. On Linux,
  run under `xvfb-run -a` with `--ozone-platform=x11 --disable-gpu`; use the
  supported virtual display for this BrowserWindow gate, separately from the
  headless audio-host gate. Both macOS and Linux ARM64 paths are verified.

Physical qualification remains separate: confirm the HDMI **output** adapter,
CEC enabled on the TV, its Box input selected, then use the actual TV handset for
Arrows/OK/Back/media and held wake sequences. Test disconnect/reconnect, UI
restart, display and audio stability. Synthetic tests cannot prove TV forwarding
or remote compatibility. On RK3588 the HDMI-QP output driver must implement CEC;
the mere presence of an HDMI-input `/dev/cec0` does not establish support.

### Power-cycle input diagnostics

The existing helper reports bounded counters at readiness and every five seconds:
received frames, accepted press/release frames, and rejected format, initiator or
destination. It reports current physical address/logical mask and only the last
frame header metadata (initiator, destination, opcode, length and receive status),
plus the last state-change address/mask. No key arguments or raw payloads are logged.
Helper counters restart with the helper; main records telemetry receipt wall time
and keeps app-lifetime delivered-event, not-ready-press and blocked-press counters.
Delivery counts mean Electron accepted injection, not that the renderer acted.
The snapshot is available through the existing diagnostics API. Ready means the
local address is registered; it does not establish that the display forwards keys.
Compare counters around a remote press after power-on to separate absent bus
traffic, filtering and main delivery. This adds no source announcement, power
command, address retry, global input or second CEC client.

### Solicited power-status reply

A received TV logical-address 0 query (`0x8f`, exactly two bytes) directed to
our claimed playback address gets a directed `0x90 0x00` reply (On). It uses
`CEC_TRANSMIT` on the existing nonblocking descriptor, at most one attempt per
second and one pending completion, expiring after two seconds. No retry queue
is created. Busy/disconnected transmit errors are counted without stopping keys.
No reply is sent during startup or for foreign, broadcast, malformed or other
requests. This neither powers another device nor selects/announces a source.

Optional diagnostics distinguish `powerReplyQueued` (kernel accepted enqueue),
`powerReplyErrors`, `powerReplySuppressed`, `powerReplyCompleted` (successful
kernel TX result), `powerReplyFailed`, `powerReplyExpired`, and the last kernel
TX status. Enqueue does not prove delivery; a successful TX result does not prove
that the TV resumes forwarding remote keys. New fields are optional for older
helper/main combinations. Physical recovery still requires qualification.

References: [v4l-utils follower power-status handling](https://github.com/gjasny/v4l-utils/blob/master/utils/cec-follower/cec-processing.cpp),
[Linux CEC transmit/receive API](https://docs.kernel.org/userspace-api/media/cec/cec-ioc-receive.html).

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
logical-address negotiation and protocol replies remain kernel responsibilities.

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

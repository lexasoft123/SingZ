# Voice strip: manual test, live monitoring (macOS, M2)

For a person with a Mac and a USB audio interface. Spec: [spec.md](spec.md);
design: [ADR 0014](../../adr/0014-voice-strip.md). Statements marked
**[inferred]** are expected behaviour not yet confirmed with a real microphone.

## Before you start

- Plug in the interface. Connect a microphone to one input and headphones to the
  interface's own output. Do not use speakers.
- Turn the interface's input trim and its direct-monitor knob down to minimum.
- Use a song with stems, a wired or USB route only. Bluetooth and a separate
  built-in mic plus other output are unavailable for monitoring in v1 (the strip
  shows the reason).

## Steps

1. Open a song. In the Voice strip's input selector, pick the interface and the
   channel your mic is on. Expect every channel of the device to be listed.
   The Voice lane is the bottom row of the stem stack: zoom or scroll the
   timeline and the lane and its playhead move with the stems.
2. Press the Record-arm button (red circle) to arm the input (selecting an input
   does not arm it). Speak. Expect the meter to move and nothing audible yet
   (the Speaker button is off by default). There is no "Mon" chip and no
   headphones button.
3. Optional: with the Speaker off, hover the fader: it reads "Voice level" (the
   take playback level). Turn the Speaker on: the fader now reads "Monitor
   level" and sits at the remembered monitor gain (-12 dB by default). Move it
   if you like.
4. Play the song. Turn the Speaker button on (it works with or without the song
   playing). Expect: a quiet start at -12 dB, the song keeps playing, no
   confirmation dialog, a one-time hint "Use headphones to avoid feedback", a
   latency badge of a few ms (an estimate, about 5 ms at the smallest buffer on
   the verification interface).
5. Sing or speak. You should hear yourself with the song. Raise the interface
   output level slowly if too quiet. **[inferred]** (not yet verified with a real
   microphone).
6. Adjust the monitor level with the fader while monitoring. Expect your voice
   level to change and the song level not to.
7. Toggle monitoring off and on a few times. Expect one tiny click or gap at the
   first on of this song only; later toggles should be inaudible or nearly so
   (about 2.8 ms residual measured).
8. Press the transport Record button while monitoring (one press starts the take; arming first is not needed). Sing for 30 s or more. During the take, toggle
   monitoring off and on once. Expect the song never to stop and the meter to stay
   live; the input must not be released by the toggle.
9. Press Record again to stop. Expect a waveform in the take clip (it grew while you
   sang). Press Record once more with the take unkept: it keeps the old take and starts a new one.
   Play the take back with the song. Listen for the take being aligned with
   the song by ear (a clap or a sung start on the beat). Note any early or late
   feel; the mid-take monitor toggle should add at most a ~30 ms silence once.
10. Switch to another song, then stop playback. Expect the monitor (Speaker on)
    to keep running across the song change, unload and playback end; it stops
    only when you turn the Speaker off, the device or route is lost, you change
    the input, or the app quits. It is still never persisted as on across restart.
11. Quit the app. Expect the interface's buffer to be back at its previous
    setting afterwards (check in Audio MIDI Setup or the interface's panel).
    **[inferred]** this follows from the zCore ledger restore.

## If you hear feedback (howl or loud echo)

Turn monitoring off immediately, lower the monitor level, turn the interface's
input trim down, and wear headphones that isolate you from the microphone.

## What to report

- Interface model, macOS version, song, which step failed, and what you heard
  (click, gap, delay, silence, distortion).
- For latency or alignment doubts: whether a loopback cable test was possible
  (Zen out 1 to in 1 is the planned measurement; none exists yet).
- The app log: use the Log panel's Copy or Save to file… export (see
  [DEVELOPMENT.md](../../DEVELOPMENT.md), "Diagnostic log wording"). Do not
  attach take audio.

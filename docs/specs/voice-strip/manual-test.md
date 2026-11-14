# Voice strip: manual test, live monitoring (macOS, M2)

For a person with a Mac and a USB audio interface. Spec: [spec.md](spec.md);
design: [ADR 0016](../../adr/0016-take-as-playback-lane.md) and
[ADR 0017](../../adr/0017-monitoring-through-the-common-mixer.md). Statements marked
**[inferred]** are expected behaviour not yet confirmed with a real microphone.

## Before you start

- Plug in the interface. Connect a microphone to one input and headphones to the
  interface's own output. Do not use speakers.
- Turn the interface's input trim and its direct-monitor knob down to minimum.
- Use a song with stems, a wired or USB route only. Bluetooth and wireless are refused with a visible reason. Also repeat
  with a built-in or wired mic and a different wired output; it must be allowed
  and show the estimated delay.

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
   level" and sits at the remembered monitor gain (-6 dB by default; range -60..+36 dB, 0 dB at the middle). Move it
   if you like.
3b. Open the gear (Track settings) on the Voice track: Esc closes it and focus returns to
   the gear. Check the monitor level, the take level and the route line. There is NO
   monitor output picker: the route line names the one common output ("Output: <device>
   (Settings › Audio route)"); to change it use Settings > Audio route. With the Speaker
   on, the line adds the buffer and delay. Separate wired devices work. A
   running take is not interrupted. A `singz.voice.monitorOutput` left by an older build
   is ignored and removed.
4. Play the song. Turn the Speaker button on (it works with or without the song
   playing). Expect: a moderate start at -6 dB, the song keeps playing, no
   confirmation dialog, a one-time hint "Use headphones to avoid feedback", an
   estimated latency badge, with a delayed marker above 10 ms.
5. Sing or speak. You should hear yourself with the song. Raise the interface
   output level slowly if too quiet. **[inferred]** (not yet verified with a real
   microphone).
5b. Monitor gain range (by ear, headphones at LOW volume first): with the real mic, raise
   Monitor level in Track settings to +24, then +36. Expect your voice to get clearly
   louder with no sudden jump, never harsh digital wrap; peaks flatten at the -1 dBFS
   safety ceiling (hard clip, no added latency). Above +12 dB the note "High gain:
   feedback risk" appears; 0 dB is marked on the slider. Return to -6 dB.
6. Adjust the monitor level with the fader while monitoring. Expect your voice
   level to change and the song level not to.
7. Toggle monitoring off and on a few times. Expect the existing song period to stay unchanged and the song
   to continue without a monitor-induced output reopen.
8. Press the transport Record button while monitoring (one press starts the take; arming first is not needed). Sing for 30 s or more. During the take, toggle
   monitoring off and on once. Expect the song never to stop and the meter to stay
   live; the input must not be released by the toggle.
9. Press Record again to stop. Expect a waveform in the take clip (it grew while you
   sang). Press Record once more with the take unkept: it keeps the old take and starts a new one.
   Play the take back with the song. Listen for the take being aligned with
   the song by ear (a clap or a sung start on the beat). Note any early or late
   feel; the mid-take monitor toggle must preserve capture continuity.
9b. Hover every Voice button (arm, speaker, gear, take actions, Record): each shows a tooltip, Record
    and Discard with their shortcut. The take clip shows a real waveform (also after quitting and
    reopening the app); a silent take is a flat line. Click the clip: it is selected (outline, focus
    ring); click an empty part of the lane or press Esc: deselected, and the click still seeks the stems.
    Drag the selected clip left/right (ghost and readout, Esc cancels), or use the arrow keys (Shift =
    larger); normal transport Play starts where you moved it, also after restart; Reset position puts it
    back. Delete (or the trash button) removes it and clears the selection. A take that is still
    recording cannot be selected.
10. Switch to another song (while it loads), open the library and come back, then stop playback. Expect the monitor (Speaker on)
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

### Take playback lane

1. Record a take, press normal Play: it plays with the song ("Plays with the song" in the lane header). M mutes only the take, S solos only the take (live monitor unaffected), the fader changes the take level while monitoring is off and the monitor level while it is on.
2. Change the song key. The "Pitch follow ±N st" chip updates, is dim at 0, and the tag shows "Voice shifted" beyond 3 st. Click the chip: it reads "Pitch follow off" and the voice is no longer shifted offline (the song key still moves every lane).
3. Track settings > Effects: toggle Pitch follow, move the manual offset, toggle Preserve formants; each change re-prepares the take ("Preparing take for playback" with a spinner on the clip). Controls are disabled while recording.
4. Force failures (very long take, low memory, many tracks, cancel the song during preparation): each shows its own message, M and S are disabled with "No playable take", and only error states show Retry; after Retry focus lands on the status text.
5. Only the normal transport plays the take; there is no standalone replay group. Tooltips appear on every new control; Tab reaches chip, Retry, M, S in order; check at narrow and wide windows (lane header must not overflow or cover the clip).

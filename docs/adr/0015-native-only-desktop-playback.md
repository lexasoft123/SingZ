# ADR 0015: Native-only song playback on desktop and Box

Status: accepted; implementation sequenced below, not started<br>
Date: 2026-11-13<br>
Supersedes: the dual-path parts of [ADR 0008](0008-legacy-native-session-handoff.md)
on desktop and Box (the `LegacyActive` / `LegacyRestoring` states and "failure
restores legacy"). ADR 0008 stays in force for iOS and Android.

## Context

Desktop song playback has two engines. `MultitrackEngine`
(`src/renderer/src/audio/engine.ts`) always builds a Web Audio graph and asks
the native facade (`audio/desktop-native-playback.ts`) at every Play. When
`selectDesktopPlaybackBackend` answers `legacy`, or the capability call throws,
or the graph is over the node bound, the engine decodes the lanes again and
plays through Chromium (`engine.ts` ~1890-1930). Only Box on Linux refuses this
(`requireNative`, `box/playback-policy.ts`).

Facts checked in this checkout:

- Native is the default on macOS and Windows since September; Linux desktop is
  opt-in (`audio/native-playback-preference.ts`).
- The preference lives in two places: `localStorage['singz.desktop.native-playback']`
  ('1'/'0') and `AudioPrefs.nativePlayback` inside `singz.audio`
  (`model.ts` `sanitizeAudioPrefs`, written back by an effect in `App.tsx`).
- Reasons the selector declines today: toggle off, no provider, runtime
  capability missing, tempo outside 0.5-1.5, transpose not an integer in ±12,
  lane count outside 1-16, a lane whose extension the runtime does not list,
  synthesized graph over `MAX_NATIVE_GRAPH_NODES`.
- Desktop training cues already play through the shared native host
  (`DesktopTrainingCueController` in `audio/training-audio.ts` calls
  `window.singz.*DesktopTrainingCues`). The engine's `trainingGain` node is
  vestigial there.
- The phones do not share the desktop engine. `mobile/src/engine.ts` is a
  separate port on `react-native-audio-api`; `mobile/` imports only
  `src/shared/*` and `@singz/ui`. (The inventory's "mobile webview uses the
  renderer engine" is wrong.)
- 39 of 237 unit suites mention `AudioContext`, legacy or Web Audio.

Two engines cost a second clock, a second output owner, a sink-id route model
beside native UIDs, and a silent fallback that hides native failures from the
singer and from us.

## Decision

1. On Electron (macOS, Windows, Linux) and Box, a song is played only by the
   native core. The Web Audio song path, its Settings toggle and its routing
   code are deleted, not hidden.
2. When native playback cannot start, the app shows a blocking error with the
   reason and Retry / Choose device. Nothing falls back.
3. Audio settings become one route section. See "Settings" below.
4. iOS and Android are out of scope and unchanged until they have a native-only
   player of their own. That needs its own ADR.

### Phone boundary

Not touched: everything under `mobile/`, `react-native-audio-api`, the phone
handoff states of ADR 0008, the phone harness's legacy-vs-native comparison.

Must stay compilable and behaviour-identical for the phones, because they import
it: `src/shared/**` (notably `song-volume`, `waveform-envelope-cache`, i18n) and
`packages` behind `@singz/ui`. Work packages may delete desktop-only keys from
shared i18n; they may not change a shared module's exports without running
`cd mobile && npm test` and the mobile typecheck.

`mobile/src/engine.ts`, `beat.ts` and `model.ts` are hand-synced ports that cite
desktop files. Their comments will go stale; fix the comments only in WP5.

## Removed, kept, moved

| Item (desktop/Box) | Decision | Why |
|---|---|---|
| Lane `AudioBufferSourceNode` playback, GainNode mix, Web Audio loop/seek/tempo/transpose, render-clock position | Removed (WP3-4) | It is the song path. Native has all of it. |
| `ctx.setSinkId`, browser sink ids, `native:` id prefix, `releaseLegacyOutput` / `restoreLegacyOutput` lease, `setDesktopPlaybackNativeOutputCurrent(false)` | Removed (WP3) | With no Chromium output there is nothing to route or hand over. Routes are native UIDs. |
| Web Audio metronome and count-in during a song | Removed (WP3) | Native already plays them whenever native plays. |
| Idle click preview (`previewClick`: metronome popover, tap confirm) | Must move native first (WP1) | The only Web Audio sound left that a singer hears with no song running. |
| Training cues and reference tones | Already native; delete the vestigial `ctx` / `trainingGain` arguments (WP4) | No move needed. |
| Training phrase render (`training-render.ts`, `OfflineAudioContext`), sample decode | Stays | Offline render to PCM that native plays. No device. |
| Training latency read from `context.outputLatency` / `baseLatency` (`training-ui-state.ts`) | Must move native first (WP1) | The value must come from the native route snapshot (ADR 0004), not a silent Chromium context. |
| Analysis (`analysis.ts`, `App.tsx` offline decodes) | Stays | `OfflineAudioContext` only. Not playback. |
| `ensureTrackBuffer` / `decodeAudioData` for the lyrics editor and analyses | Stays, as decode only | Samples for drawing and DSP. Moves to an `OfflineAudioContext` decode so the engine holds no realtime context. |
| Mic capture for pitch and training (`mic.ts`, `training-mic.ts`, `pitch-strip-mic.ts`) | Stays | Input only, via `getUserMedia`. Owns one capture-only `AudioContext` created with `sinkId: { type: 'none' }`. Replacing it with native capture is ADR 0009/0014 work, not this ADR. |
| Settings mic preview (`mic-preview.ts`) | Meter only; any audible loop-back is removed (WP2) | Hearing yourself is the Voice strip monitor (ADR 0014). |
| Lane measure decode fallback (`lane-measure.ts`) | Removed for playback; a lane native cannot read is a named error (WP1 closes the formats, WP3 removes the path) | "Open succeeds, Play cannot" is worse than a clear open-time message. |
| Voice take playback, Voice monitor | Unchanged | Already native (ADR 0014). |
| `singz.desktop.stream-lanes` | Stays as a hidden diagnostic key | It compares two native paths, not native against Web Audio. |

After WP4 the desktop renderer has no `AudioContext` connected to a device.

## Failure UX

A blocking panel replaces the transport area (Box: full screen). It is not a
toast and does not time out. The song stays open: lyrics, waveform, editing and
analysis keep working. Transport controls are disabled while it shows.

| Code | Shown reason | Actions |
|---|---|---|
| `addon-unavailable` | Audio engine could not load (load, ABI or capability failure) | Retry, Copy details |
| `provider-unavailable` | WASAPI / ASIO / CoreAudio / ALSA is not available | Retry, Choose device |
| `no-device` / `device-lost` | No output device, or it disappeared | Retry, Choose device |
| `route-rejected` | The device refused the format or buffer | Retry, Choose device |
| `graph-rejected` | This song cannot be played: names the lane and cause | Retry (after a fix), Copy details |
| `recovery-required` | The previous session did not close cleanly | Retry (runs `cleanupForRetry`) |

Rules: every decline carries a code and one translated sentence; "Choose device"
opens Settings at the audio route section; Retry re-runs the same prepare, never
another provider; a failure after native owns the device keeps today's
stop-then-report order. Box keeps its stop/recovery control and gains the same
codes in place of `box.nativeRequired`.

## Settings

- One **Audio route** section: Output device, Input device, and a read-only
  status line built from the native route snapshot, for example
  `Zen · 48 kHz · buffer 32 · ≈5 ms`. When nothing is open it says so.
- "Use native playback" is deleted. It is not moved to Advanced.
- Device lists come from the native provider inventory. Outputs are stored as
  native UIDs (`nativeOutputUid`, beside the existing `nativeInputUid`). A saved
  browser `outputId` is mapped once by the existing label translation; no match
  means system default plus a one-time notice.
- Windows provider (WASAPI / ASIO) stays, as an advanced choice inside the
  device section, for as long as ASIO is built. ADR 0014 says ASIO is not
  shipped; if that holds at WP2 the control is hidden when only WASAPI reports
  available.
- Voice monitor output follows the song output by default. The voice track popup
  holds a per-track override, stored as `monitorOutput: 'follow' | { uid, channels }`.
  It is offered only where the ADR 0014 latency gate qualifies the route and is
  otherwise disabled with the reason. The Voice strip keeps input channel, arm
  and speaker only.

## Preference migration

- `singz.desktop.native-playback`: ignored on read, never written, not deleted
  (an older build installed later still finds its own value).
- `AudioPrefs.nativePlayback`: dropped by `sanitizeAudioPrefs`; the write-back
  effect in `App.tsx` is removed.
- `DesktopNativePlaybackPolicy.playback` and `.requireNative` are deleted;
  `desktopNativePlaybackPreferred` is deleted with its callers
  (`App.tsx` x3, `lane-measure.ts`, the facade).
- v1 (WAV) projects always take the upgrade-before-open branch
  (`App.tsx` ~1723); the background branch (~1890) is deleted.

## Risks

1. **Selector declines become hard failures.** Tempo outside 0.5-1.5,
   non-integer transpose, more than 16 lanes, unlisted lane formats and the node
   bound play today through Web Audio. Each needs a UI clamp, a conversion or a
   native extension before WP3. We have no field count of how often they occur.
2. **Linux desktop.** ALSA is opt-in and has never passed the session harness on
   physical hardware. WP3 makes it the only path.
3. **Count-in and metronome parity.** The click with no beat grid, the count-in
   from a scrubbed position and the idle preview each had field bugs. The idle
   preview needs a device open with no song, which is a new native state.
4. **Training cue graph.** Cues run on the shared host, but latency compensation
   and master-gain follow still read Web Audio objects.
5. **Lane measure fallback.** Its contract was "can only make an open faster".
   Removing the decode makes format coverage a correctness matter.
6. **Box startup.** Box boots into playback with no user present; a blocking
   panel must be reachable by remote and must not loop on Retry.
7. **Test suite rewrite.** About 39 unit suites and the desktop harness's
   legacy-vs-native comparison lose their reference column. Parity rules must
   become absolute budgets before the legacy column goes.
8. **Phone code sharing.** Shared i18n and `src/shared` edits can break the
   phone build without any desktop test noticing.
9. **Saved output mapping.** A sink id that maps to no native UID silently moves
   a singer to the default device unless the notice ships with it.

## Work packages

Coordinator (Opus) plans, writes specs, reviews and owns Git. Every package ends
with `code-reviewer` on the staged diff. Risky Codex code is reviewed by Sonnet.
Any desktop behaviour change runs `e2e-verifier` on mac and windows-field
together. The app is releasable after each package; the fallback stays in place
through WP2 as the safety net.

**WP0. Decline and usage inventory (read-only).**
Research / Codex `gpt-6-luna` / effort medium. No edits.
Output: every `backend: 'legacy'` reason and `return null` in the decide path
with file:line; every desktop Web Audio node that reaches a device; every lane
format accepted at import against the runtime's `mediaCodec.extensions`; the UI
ranges for tempo and transpose. Evidence: the table, spot-checked by Haiku.
Depends on: nothing.

**WP1a. Close the selector gates.**
Risky (format conversion, project upgrade) / Codex `gpt-6.1-sol` / high;
Sonnet review.
Files: `audio/desktop-native-playback.ts`, `audio/lane-measure.ts`,
`App.tsx` (open and import paths), `src/main` import/upgrade modules,
`components/Transport.tsx`, `tests/unit/desktop-native-playback.test.ts`,
`lane-residency.test.ts`.
Evidence: for every WP0 reason, a test showing the song now plays native or
gets a named `graph-rejected` cause; an upgrade test on a v1 WAV project and on
each importable custom-track format; negative control with the clamp removed.
Depends on: WP0.

**WP1b. Native idle click preview and native latency for training.**
Risky (real-time, new idle device state) / Codex `gpt-6.1-sol` / high;
Sonnet review.
Files: `native/playback/*`, `native/electron/*` playback bridge,
`src/main` playback IPC, `src/preload/index.ts`, `src/shared/types.ts`,
`tests/shared/native-playback-bridge-manifest.json`, `audio/engine.ts`
(`previewClick`), `training-ui-state.ts`, `audio/training-audio.ts`.
Evidence: ctest for the preview under the sanitizer gates; `count-in-e2e.cjs`
and `shared-training-audio-smoke.cjs` green; a driver that clicks the preview
with no song open and with a song paused; training latency equals the route
snapshot in a unit test.
Depends on: nothing. Parallel with WP1a (disjoint files except `engine.ts`,
owned by WP1b).

**WP2. Audio route section.**
Convention-bound (i18n, settings tests) / Claude `sonnet` / medium.
Files: `components/SettingsModal.tsx`, `SettingsRoute.tsx`, `SongOutput.tsx`,
`VoiceStrip.tsx` and the voice track popup, `audio/output-routing.ts`,
`audio/devices.ts`, `audio/mic-preview.ts`, `model.ts`, `src/shared/voice-take.ts`,
`src/shared/i18n/*/settings`, `tests/unit/settings-microphone.test.ts`,
`voice-strip.test.ts`.
Scope: new section, status line, `nativeOutputUid` with one-time mapping and
notice, monitor-follows-song with popup override, toggle removed from the UI
(the stored value is ignored, platform default applies). Fallback untouched.
Evidence: unit tests for the status line, the mapping (match, no match) and the
override; i18n rules check; mobile jest and typecheck; screenshots on mac and
windows-field.
Depends on: WP1b (status line reads the same route snapshot).

**WP3. Failure UX, remove the fallback, remove sink-id routing.**
Risky (device ownership, timing) / Codex `gpt-6.1-sol` / high; Sonnet review;
Opus reads the final diff.
Files: `audio/engine.ts`, `audio/desktop-native-playback.ts`,
`audio/native-playback-preference.ts`, `audio/lane-measure.ts`,
`audio/output-routing.ts`, `box/playback-policy.ts`, `box/App.tsx`,
`box/transport.ts`, `App.tsx`, `playback-error-toast.ts`, a new blocking-error
component, `model.ts`, `src/shared/i18n/*`, `src/main` and preload entries for
`setDesktopPlaybackNativeOutputCurrent`.
Evidence: one test per failure code that the panel shows the reason and that no
`AudioBufferSourceNode` starts (assert on a throwing fake); a test that both old
preference stores are ignored and never written; `box-native-startup`,
`box-retained-transport`, `box-retained-recovery.cjs`; `player-session-e2e.cjs`,
`open-native-e2e.cjs`, `count-in-e2e.cjs`, `stems-after-end-e2e.cjs` on mac and
windows-field; the Linux session harness on physical ALSA hardware. Linux
desktop does not release from this package until that last run is green.
Depends on: WP1a, WP1b, WP2.

**WP4. Delete dead Web Audio paths and tests.**
Convention-bound (test harness) / Claude `sonnet` / medium; Haiku produces the
dead-string and dead-symbol inventory first.
Files: `audio/engine.ts` (source scheduling, gain graph, click scheduler,
realtime `AudioContext`), `audio/stem-rate.ts`, `audio/training-voices.ts`
callers, `audio/training-audio.ts` constructor arguments, `env.d.ts`,
`tests/unit/*` (training-audio, engine-seek-race, lane-residency, route/output
suites), desktop harness rules in `tests/e2e/mac`, unused i18n keys.
Scope: legacy-vs-native harness rules become absolute budgets taken from the
last three green native runs.
Evidence: `grep` shows no `createBufferSource`, `setSinkId` or realtime
`new AudioContext` in the desktop song path; full unit suite, renderer split
check, mobile jest; each deleted suite listed with the native test that now
covers its behaviour, or the reason none is needed.
Depends on: WP3 shipped in one release with no fallback-related field report.

**WP5. Documentation.**
Docs / Claude `sonnet` / low.
Files: `docs/PROJECT-RULES.md` (verification policy text on legacy vs native),
`docs/DESKTOP-LANE-RESIDENCY.md`, `docs/NATIVE-PLAYBACK-BRIDGE.md`,
`docs/specs/voice-strip/*`, `docs/DEVELOPMENT.md`, stale port comments in
`mobile/src/{engine,beat,model}.ts`.
Evidence: no remaining claim that desktop falls back to Web Audio; links
resolve. Depends on: WP4.

## Consequences

- One clock, one output owner and one route model on desktop and Box.
- A native defect is now visible to the singer as a stopped player. That is the
  intent, and it raises the bar for WP1a and for release verification on Windows
  and Linux hardware.
- Desktop and phone engines diverge further until the phones follow.

# ADR 0017: Live monitoring through the common mixer and output

Status: implemented baseline (WP6 removal complete; hardware qualification remains WP8)<br>
Date: 2026-11-13<br>
Supersedes: ADR 0014 "Design: a second small duplex host", its
monitor-output selection paragraph (`outputDeviceId`, `outputDevice`,
`outputCandidates`), the same-device-only rule and the two-host parts of "Buffer
policy" and "Idle monitoring"; spec VS-MON-002, -005, -016, -024 (output picker).
Revises: VS-MON-008 and AC-5 (see the removal list).
Kept from 0014: product rules, the -10874 silence block, take-gap padding.

## Owner decisions (final, input)

- "There must be no separate monitoring output, just a COMMON MIXER and OUTPUT
  for all the tracks." One output device, chosen in Settings > Audio route. No
  monitor-output picker; the "limited to the same device" restriction must go.
- Cross-device: "This is implemented in LoopZ, check their results."
- "Yes, master scales everything": the live voice sits under the app master
  volume and limiter like every other source.

## Question

Where does the live voice join the one output stream, how does the microphone
reach it from any input device, and what happens to the buffer, timing,
recording, master and permission rules built around the second host?

## Facts read (SingZ read at 3343f4c; LoopZ `main` 5ab5c99, read-only)

SingZ:

- One output stream with an additive mixer exists:
  `SharedAudioService::Impl::render` zero-fills, then runs the song graph, the
  training client and the microphone client
  (`native/playback/shared_audio_service.cpp:259-295`); it runs with no song
  (`:405-410`).
- The M2 monitor is outside it: `VoiceMonitorHost` owns a second duplex
  `AudioHost` (`voice_monitor.cpp:82-88`, `:175`); its leaf assigns the output
  (`voice_monitor.h:58-63`). `uid != output` is refused as
  `route-separate-devices` (`voice_monitor.cpp:22`).
- The zCore **duplex-host API** is same-device on macOS
  (`third_party/zcore/zcore/platform/macos/audio_host_macos.cpp:464-467`); on
  Windows and Linux it takes another capture endpoint through a FIFO without
  drift correction (`audio_host_windows.cpp:1273-1279`,
  `audio_host_linux.cpp:98`). This limits that API only, not split owners.
- zCore routing is already vendored: `zcore/routing/audio_history.h`,
  `audio_resampler.h`, `sample_clock.h`, `sinc_phase_table.h`, including the
  continuity-verified local clock correction (`audio_resampler.h:19-21`).
- `MicrophoneMixSession` (`native/playback/microphone_mix.*`) is a SingZ
  split-owner implementation: capture -> history -> resampler -> the service
  microphone client (`microphone_mix.cpp:473`). It is gated to Linux ALSA
  (`:319-321`, `:341`), 48 kHz stereo (`:352`), delay 256..8192 with default
  1024 (`:325`, `microphone_mix.h:20`), and opens its own capture backend.
- Take recording is fed on the capture **delivery sink**
  (`native/electron/capture_addon.cpp:663-665`), not in the hardware callback.
  The real-time backend push is mono on every platform
  (`audio_input_backend.h:12, 49`); a multi-channel `openBus` exists only on
  Linux (`platform/linux/audio_input_linux.cpp:37`).
- Song graph: lanes -> song mix -> song gain -> time-pitch -> (output mix) ->
  output gain -> limiter -> output (`native_playback_session.cpp:55-66`,
  `:4085-4109`). Master is an in-graph gain node (`:3466-3468`, `:4298-4299`,
  `setMasterGain` `:8331`). A zero-source prepare is refused (`:6215`); the graph
  is rebuilt per tempo/transpose generation; the training client joins after it.
- Two-host buffer special cases: `shared_audio_service.cpp:65-66, 322-327,
  344-362, 652-750`. A route-changing reopen fails the song gate (`:333-339`).

LoopZ (macOS product only; no Windows/Linux backend or result):

- **Buffered path**: capture and output are separate owners; the output host is
  opened output-only (`native/platform/macos/engine/connections.mm:132-145`,
  `docs/architecture.md:1376-1378`). The output callback reads a timestamped
  `AudioHistory` at its presentation time minus an explicit queue, at its own
  measured rate (`architecture.md:1327-1334`, `native/core/monitor.cpp:168-231`,
  `native/core/audio_history.cpp:326-431`,
  `native/platform/macos/monitor_outputs.cpp:346-355`). Queue floor: the larger
  of the lookback and two output periods plus a 256-frame quantum
  (`architecture.md:1386-1393`). Cross-device and cross-rate work by design.
- **Direct path**: when every audible source of a monitor is an input of the
  monitor's own output device, `MonitorOutputs` opens that output host with the
  device's input channels (existing consent only) and renders from
  `block.input` (`monitor_outputs.cpp:35-38, 59-69, 265-273`,
  `native/core/direct_monitor.cpp:26-83`).
- Measured (Zen Quadro, 48 kHz, internal return, excludes air and analog):

| Path | Result | Source (`docs/latency-comparison.md`) |
|---|---|---|
| Direct, same device, 32 / 64 frames | 3.875 / 5.208 ms, 60 s, zero missing frames, timestamp errors, xruns | `:1090-1125`, `:1129-1139` ("one duplex hardware clock and avoids asynchronous histories", `:1193-1195`) |
| Buffered, same device, default queues (1024 history + 1088 queue) | 44.708 ms | `:1226-1245` |
| Buffered, shrunk (32 hw / 448 source / 192 monitor) | 14.042 ms, **rejected**: missing source frames in longer runs | `:1199-1207` |
| Buffered, cross-device | **no result exists** | audit, 2026-11-13 |

The 3.875 / 5.208 ms figures therefore belong to the direct path, not to the
history mechanism. No CPU or jitter figure is recorded for either path.

## Options

| Option | For | Against |
|---|---|---|
| (A) Common host always duplex, live input as a graph node | One mixer and master | Microphone indicator and prompt at every song start; impossible across devices on macOS; a zero-source graph is refused; the node is rebuilt per generation. **Rejected** |
| (B) Common host reopened duplex on first monitor use | Direct-path latency | A reopen while a song plays: output gap, clock discontinuity, and today terminal for the graph. Same device only. **Rejected as the default**; kept as F below without the reopen while playing |
| (C) Separate monitor host mixed by the OS | No reopen | It is M2: no common master or limiter, impossible on ALSA `hw:`, WASAPI exclusive, ASIO. The model the owner removed. **Rejected** |
| (D) Split owners + timestamped history, for every topology | One mechanism for same-device, cross-device and cross-rate; the song host stays output-only and is never reopened; LoopZ and `MicrophoneMixSession` prove the design | LoopZ's only accepted latency on it is 44.7 ms; its 14 ms attempt failed continuity. Low latency on this path is unproven. **Recommended baseline** |
| (F) Direct fast path on top of D (LoopZ `DirectMonitor`) | The only measured 4-5 ms route | In SingZ the one output host must carry the input, so it applies to input == output only and needs a duplex open. **Optional, gated by WP0**, opened only when no song is playing |

## Decision

1. **The common mixer is the shared service callback.** The monitor is an
   additive client of `SharedAudioService::Impl::render` after the song graph:
   never stretched, shifted or delayed by graph latency. `VoiceMonitorHost` and
   its second `AudioHost` are deleted; `VoiceMonitorRender` stays as the gain,
   ramp and meter leaf, changed to add.
2. **One mechanism for all topologies: option D.** The capture transport
   publishes the selected channel into a zCore `AudioHistory`; the common output
   callback reads it at `outputHostTimeNs - queue` through the resampler at the
   measured output rate. Same device, another device and another rate are the
   same code. **The song host stays output-only and is never reopened for
   monitoring, except the optional WP5 duplex open at non-playing moments
   (decision 6).** Settings owns the per-device buffer preference (default 128 frames); the
   current capture and output periods decide the queue floor. Monitoring never
   retunes an existing song output; the two-host buffer bookkeeping goes.
3. **Reuse and port.** Reuse: zCore routing (history, resampler, sample clock)
   and the read side of `MicrophoneMixSession`, extracted into a shared core.
   Port from LoopZ: the measured output-rate estimator
   (`native/core/output_clock.cpp`), the queue-floor rule, missing history as
   counted silence instead of a host failure (`architecture.md:1336-1339`), and
   the split of callbacks above the DSP quantum. SingZ lacks: history
   publication from the macOS and Windows capture callbacks (only Linux is
   wired), any rate other than 48 kHz, and a direct path.
4. **One capture transport for takes and monitor.** One physical capture owner
   per input device. The history is published from the real-time capture
   callback; the take writer stays on the delivery sink with unchanged
   timestamps, so `C - I - O - G` and the anchors are untouched. Whether zCore
   `AudioInput` can expose that real-time tap beside its delivery queue is not
   read yet (WP0). Fallback: a second capture backend on the same device, as
   `MicrophoneMixSession` does today.
5. **Latency is unknown until WP0 measures it.** No number is promised. The
   badge shows the measured or stated round trip; any route above the
   small-buffer case shows "delayed, N ms". Proposed gates, to confirm from the
   numbers:
   - G1 continuity (all routes): 10 minutes with zero missing history frames,
     timestamp errors and xruns after warm-up, with the song playing. A profile
     that fails G1 is failed evidence whatever its delay (LoopZ rule).
   - G2 same device: if D passes G1 at or below 10 ms with a 32 or 64 frame
     period, D ships alone. Otherwise WP5 (direct path) is required before the
     second host is deleted, so M2's latency is never regressed.
   - G3 cross-device: G1 on two independent clocks for 10 minutes, at equal and
     at different rates. The refusal ceiling (`route-latency`) is set by the
     owner from the measured table, not here.
   - Bluetooth and wireless stay refused (`route-bluetooth`, `route-wireless`)
     as policy to confirm; WP0 may measure one route to revisit it.
6. **Direct fast path (optional, WP5; the one exception to decision 2).** Input
   == output device only. The common
   host is opened with the input channel and the leaf reads `block.input`, as
   LoopZ `DirectMonitor`. The duplex open happens only when no song is playing
   (idle, paused, song load); while a song plays or a take records the history
   path is used and the upgrade waits. Same badge, same leaf.
7. **Under the master.** The service gets a master stage after all clients:
   master gain, then the safety limiter, over song, cues and voice. The renderer
   publishes master volume to the service, also with no song. The leaf keeps its
   own level and ramp; its private ceiling stays until WP3 proves the service
   limiter (VS-MON-008), then goes. The in-graph master gain and
   limiter are bypassed once the service stage is proven equal (WP3); the limiter
   must add no latency, or `G` in the placement math changes.
8. **Not a lane, not a graph node.** 0 of 16 lanes, 0 of 128 nodes; it survives
   generation swaps and song unload. Mute, Solo and the recording rule of ADR
   0016 cannot reach it; only the Speaker button and the master do.
9. **Idle monitoring.** The service host runs with no song; the monitor is the
   only source. A song joins and leaves without a reopen (VS-MON-023 unchanged).
10. **Output migration and device loss (Mac e2e correction).** A successful
    song prepare, host period change, or deliberate app output selection retains
    the capture user and re-registers the history client on the new output
    generation. Keep an idle monitor audible while the song graph is prepared
    but has not started. Gate the new sink against Bluetooth/wireless policy
    before callbacks resume. Genuine input/output removal, permission loss,
    refusal or an unrecoverable backend error turns monitoring off with a typed
    reason and a main-process log; a fallback after removal never auto-restarts it.
    The common Settings output context must actually configure the service,
    including when there is no native song or training cue.
    Period negotiation is order-dependent: monitoring first may acquire a
    input-device buffer from Settings and the same physical output then uses it;
    opening the song first keeps its existing period (for example 512). Never
    shrink a song period for monitoring. Both the history read queue and the
    reported estimate use the current host period, even across reopens and
    callbacks smaller than that period. Input and output device delays are
    read from their respective capture/output owners, with their own rates.
    History routes ignore legacy duplex `monitoringSuitability`: built-in,
    wired, virtual and aggregate devices are allowed; virtual/unclassified
    routes carry an estimated-latency warning, and unknown transport is delayed.
    Aggregate same-device routes remain allowed with that warning. Only a
    recognized same-UID virtual loopback (BlackHole/Soundflower family label) is refused
    as `route-feedback`; physical device pairs and remote adapters are not
    blanket-refused. Inventory has labels/transport/channel counts, not driver
    identity, manufacturer, topology or aggregate membership. Unclassified
    same-UID virtual routes are allowed with a localized feedback warning and
    gain at -40 dB or lower on begin or entry during output migration. A later
    deliberate fader move is allowed and survives period-only reopens. This is
    the minimal low-gain fallback, without an additional confirmation flow.
    [BlackHole documents output-to-corresponding-input loopback](https://github.com/ExistentialAudio/BlackHole#readme).
    [NoMachine documents independent microphone forwarding](https://kb.nomachine.com/DT08U00292).
    These labels are policy hints, never proof that an arbitrary renamed driver
    is safe; unknown routes retain the warning and low-gain entry policy.
11. **Permission.** Nothing opens an input or prompts at app or song start.
    Speaker-on is a user gesture and asks through `src/main/mic-access.ts` like
    recording; a refusal is the typed `permission` reason.
12. **Box and phones.** Box keeps its mic mix; the Voice monitor stays refused
    while Box owns capture or the mic mix is active. iOS and Android later map
    onto the same history mechanism. Phone and Box native builds stay green.

## Removal list

- Types (`src/shared/voice-take.ts:294-302, 317-329`): `VoiceMonitorOutputDevice`,
  `VoiceMonitorOutputCandidate`, `outputDevice`, `outputCandidates`, both
  `outputDeviceId` fields, reason `route-separate-devices`. Added: queue and
  measured-latency fields. `output-not-native` is removed (no producer, no
  locale string); `VoiceMonitorPlaybackContext` goes once ADR 0015 lands.
- Main (`voice-monitor.ts:4-12, 43-47`): `OutputDetails`, `outputs()`, the
  output part of `activeSelection`, the matching IPC and preload arguments.
- Renderer: the picker and its note (`VoiceTrackSettings.tsx:32-36, 77-98`),
  `setMonitorOutput`, `monitorOutput(s)`, `monitorOutputDevice`,
  `monitorOutputMissing`, `monitorSwitching`; i18n keys `player.voice.output*`
  in all 15 locales. The route line names the app output.
- Native: `VoiceMonitorHost`, the duplex and same-device checks in
  `classifyVoiceMonitorRoute` (`voice_monitor.cpp:22-29`),
  `VoiceMonitorOutputChoices`, `voiceMonitorOutputChoices`,
  `voiceMonitorSongRoute`, `voiceMonitorSameOutput`,
  `voiceMonitorBrowserOutputCompatible`; bridge state `monitorOutput`,
  `selectedOutput`, `monitoredOutput`, `outputs()`; service
  `retainVoiceMonitorOutput`, `voiceMonitorOutputConfig`, the `monitorOutput`
  token and the retry at `:347-358`. `monitorBufferHeld`,
  `retainedPlaybackCapacity` and `prepareVoiceMonitor` collapse into one
  service-owned buffer hold. In WP3 only: the leaf's private ceiling and the
  in-graph master gain and limiter.
- Docs, removed or rewritten: spec VS-MON-002, -005, -016, -024;
  `manual-test.md` lines 13, 31, 34; ADR 0014 pointers.
- Docs, revised (kept): VS-MON-008: the non-defeatable limiter, -1 dBFS ceiling
  and bounded gain move from the monitor leaf to the service master stage. The
  leaf keeps its ceiling until WP3 lands, so the requirement is never unmet;
  WP3 removes the private ceiling in the same change that proves the service
  limiter. AC-5: the 256-frame criterion goes; the Bluetooth and wireless
  refusal with a visible reason stays.

## Risks

1. **Latency of the history path** (riskiest). LoopZ accepted it only at
   44.7 ms; its 14 ms profile lost source frames and small periods showed
   timestamp-anchor jumps (`latency-comparison.md:1140-1160, 1199-1207`). If G2
   fails, the direct path is mandatory and option F's duplex open returns,
   limited to non-playing moments.
2. Resampler CPU inside the one output callback at 32-64 frames, beside the song
   graph, is unmeasured anywhere.
3. A real-time capture tap in zCore is a change to a shared library pinned by
   SingZ, LoopZ and Box; takes depend on the same owner.
4. Moving master and limiter to the service touches every song's output and the
   graph latency used by take placement.
5. macOS and Windows capture have never published into the history in SingZ.
6. Built-in microphone with speakers becomes monitorable: feedback. Only the
   quiet headphone hint guards it (ADR 0014 open item).

## Work packages

Coordinator: Claude `opus` (specs, result review, commit gate, `code-reviewer` on
each staged diff). Codex real-time code is reviewed by Claude `sonnet`; Opus
reads the WP2 and WP3 final diffs. Workers share the feature tree with disjoint
files and unique build directories.

**WP0a. Inventory (read-only).** Research / Codex `gpt-6-luna` / medium; table
spot-checked by Claude `haiku`. With file:line: can zCore `AudioInput` tap the
real-time push beside delivery; what `MicrophoneMixSession` hard-codes; whether
the zdsp limiter adds latency; where training cues sit relative to master; every
caller of the removal list. Depends: none.

**WP0b. Measurement spike.** Risky (real-time harness) / Codex `gpt-6.1-sol` /
high, dev flag only; Sonnet review; run by `e2e-verifier` on mac and
windows-field in a reserved device window. A harness of history path in the
service callback, with a feedback-safe loopback (internal return or cable,
gain 0.5, muted control). Matrix: same device, and input device A -> output
device B on independent clocks at equal and different rates; periods 32 / 64 /
128; queue sizes down to the floor; song playing. Per cell: waveform delay,
callback jitter, missing frames, timestamp errors, xruns, audio-process CPU,
10-minute continuity. Evidence: the table in `singz-dev`, compared with LoopZ's
3.875 / 5.208 ms, and gates G1-G3 with their verdicts. Depends: WP0a.

**WP1. Capture publication.** Risky (shared capture, takes) / Codex
`gpt-6.1-sol` / high; Sonnet review. Files: zCore capture and its pin, or
`native/playback/voice_monitor_source.*` for the fallback; tests. Evidence: one
physical capture feeds history and take writer; a take recorded with the
monitor on is sample-identical to one with it off on a fake backend; ASan/TSan;
LoopZ and Box build against the pin. Depends: WP0a, and the WP0b verdict.

**WP2. Monitor client in the service.** Risky (real-time, drift) / Codex
`gpt-6.1-sol` / high; Sonnet review. Files: `shared_audio_service.{h,cpp}`,
`voice_monitor.{h,cpp}`, `microphone_mix.{h,cpp}` (shared core extracted), tests,
`CMakeLists.txt`. Scope: decisions 1-3, 9, 10. Evidence: fake clocks at +0.3%
and -0.3% for 10 minutes with zero missing frames and a bounded queue; 48 to
44.1 kHz; a pulse within 1 ms of the stated queue; disabled drift tracking fails
(negative control); idle start, song join and unload with zero host reopens; the
song block survives bit-exact under a silent monitor; Box mic-mix tests
unchanged. Depends: WP1.

**WP3. Service master stage.** Risky (every song's output, placement latency) /
Codex `gpt-6.1-sol` / high; Sonnet review. Files: `shared_audio_service.{h,cpp}`,
`native_playback_session.cpp` (master and limiter nodes), playback bridge, tests.
Evidence: song-only output equal to the in-graph result within 1e-6 at master
0.25 / 1 / 2; graph latency unchanged; master scales the voice; a full-scale sum
never exceeds the ceiling; removing the service limiter fails that test.
Depends: WP2.

**WP4. Bridge, main, types, UI.** Routine from a pinned interface / Codex
`gpt-6.1-terra` / medium; Sonnet review (i18n rules). Files:
`native/electron/voice_monitor_bridge.cpp`, `src/main/voice-monitor*.ts`,
`src/preload/index.ts`, `src/shared/voice-take.ts`, `VoiceTrackSettings.tsx`,
`audio/voice-take.ts`, `voice-format.ts`, `src/shared/i18n/*/voice.ts`, unit
tests. Evidence: no picker; a request carrying `outputDeviceId` is ignored; the
"delayed, N ms" badge; permission prompt only on Speaker-on; i18n check with no
orphan keys; mobile typecheck and jest; screenshots on mac and windows-field.
Depends: WP2.

**WP5. Direct fast path (only if G2 fails).** Risky (device lifecycle) / Codex
`gpt-6.1-sol` / high; Sonnet review. Files: `shared_audio_service.{h,cpp}`,
`voice_monitor.{h,cpp}`, `native_playback_session.cpp:7298`, tests. Evidence:
zero duplex opens while a song plays or a take records; upgrade at the next
non-playing moment; hardware result within LoopZ's 3.875 / 5.208 ms class.
Depends: WP2 and the G2 verdict.

**WP6. Delete the second host.** Risky (shared service) / Codex `gpt-6.1-sol` /
medium; Sonnet review. Files: the native removal list. Evidence: grep finds no
`VoiceMonitorHost`, `retainVoiceMonitorOutput`, `outputCandidates`,
`route-separate-devices`; ctest ASan/TSan; each deleted fake-duplex case mapped
to its replacement. Depends: WP4, and WP5 when G2 failed.

**WP7. Spec and docs.** Docs / Claude `sonnet` / low. Files: voice-strip
`spec.md`, `manual-test.md`, ADR 0014 pointers. Depends: WP6.

**WP8. Verification.** `e2e-verifier` on mac and windows-field together after
WP4 and WP6: same device, cross-device, idle, song join, route pull, master
scaling the voice, a take recorded with the monitor on (VS-REC-004).

## What this unblocks

Monitoring with any wired input and output pair, on Windows shared mode and
Linux for the first time; one master, limiter and meter for everything; live
voice effects before the master; the phone ports on the same mechanism; removal
of the two-host buffer and lifetime special cases.

## Open

- Owner, after WP0b: the cross-device refusal ceiling in ms, and confirmation
  that Bluetooth and wireless stay refused.
- WP0b decides whether WP5 exists.

## WP6 removal and regression mapping

The legacy duplex host, escape switch, output picker fields, same-device-only
refusal, weak monitor-output token and song-output 32..256 retune are deleted.
Common monitor types and helpers live in `voice_monitor_client.h`. The service
retains the common host capacity only while the additive monitor is attached.
Output display metadata is `commonOutputName`; Settings owns the only output.

| Deleted fake-duplex group | Replacement evidence |
| --- | --- |
| `renderTests`, `channelTests` | `voice_monitor_source_tests` selected capture/history and silence, `voice_monitor_client_tests` additive gain/ramp/meter/non-finite/allocation cases, `service_master_tests` final ceiling |
| `routeTests` | `voice_monitor_client_tests` common-route admission, separate devices, virtual feedback, aggregate and transport policy |
| `hostTests` | Common client/source ownership, permission, stale generation, stop/drain and capture-loss cases; no second host or callback-settle contract remains |
| `outputPickerTests` | Picker behavior removed; `voice-monitor.test.ts` common-output display/migration and `voice-strip.test.ts` no-selector route UI |
| `idleMonitorTests`, `songTests`, `currentOutputAndGapTests` | Common client idle/song join/unload/migration tests; shared service master and callback diagnostics; capture writer gap tests remain |
| `sharedMonitorLeaseTests`, `externalLeaseTests`, `repeatedSharedBufferTests` | Two-host lease/retune behavior removed; common client asserts no period writes, retained host capacity, cue handback; native session capacity regression uses a common monitor and preserves the existing 512-frame song period |
| Legacy render/host/lease mutation targets | Common source/client/clock/waveform/master mutation and realtime policy gates remain, including queue floor, admission, master order, cue handback, period and telemetry failures |

Portable evidence does not claim new hardware continuity or round-trip results.

## Final strip UI (release)

The monitor pill shows milliseconds only (`{ms} ms`); its tooltip carries the
estimated or measured round trip in ms and frames plus the negotiated buffer,
and names "different devices" only when input and output names differ and
"larger buffer" only from 256 frames. Takes keep a per-take colour (six hues,
atelier variants) that tints the clip, its waveform and selection.

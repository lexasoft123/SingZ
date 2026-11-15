# ADR 0014: Voice strip — recording and monitoring in the song player

Status: proposed (not implemented)
Date: 2026-11-12
Origin: issue #136 (input monitoring and recording)

0011–0013 are used by the unmerged DAW branch; this number avoids a clash.

## Decision

Add one **Voice strip** to the song player, beside the stems. It is the first
step toward the DAW session engine (the destination), built from small reviewed
pieces lifted from the DAW branch, never by merging it.

Strip controls: input selector (device, mono channel), mute (= monitoring off,
default), solo, level, record, and a take clip played against the song.
"Lessons" means singing along to a song, not the Train tab.

Backend: **extend SingZ's shared audio service.** The microphone becomes a
first-class client beside song playback. LoopZ stays the Box router. Reasons:

- The shared service already owns the device on desktop and both phones
  (`native/playback/shared_audio_service.*`) and `MicrophoneMixSession`
  (`native/playback/microphone_mix.cpp`) already runs a capture client beside
  the output; it is gated to Linux ALSA today.
- "LoopZ DSP" is zCore, which SingZ already links. LoopZ adds route documents,
  macOS driver/engine and (unmerged, LoopZ PR #5) a Windows virtual-driver
  preview; it has no iOS/Android code and no time/pitch stage.
- Windows low-latency code (WASAPI IAudioClient3 shared, exclusive,
  latency/suitability reporting) is already in zCore `main`; byte-identical to
  what LoopZ 0.2.1 vendored.

## Product rules (owner decisions, 2026-11-12)

- Latency: target 32 frames, maximum accepted 256 frames. A route that cannot
  stay within 256 frames disables the monitor control and shows why. Recording
  and playback work on any route.
- No headphone confirmation; monitoring is the user's choice (supersedes the
  ADR 0010 checkbox).
- Recording is allowed at any tempo and transpose. A take is recorded against
  the song as heard and plays back as sung, with the settings it was recorded
  under (tempo, transpose). Following later changes is out of scope.
- Takes are local only for now. Mono only in v1.
- ASIO is not in scope; Windows monitoring uses zCore's WASAPI host.

## Milestones

1. **Record and listen back (no live monitoring).** Record on the capture
   delivery sink with raw timestamps. Place takes by capture time minus input
   latency, output latency and graph latency. Play the take joined at the
   output mix with a rate-1 read mode. Local take storage with a sidecar (song,
   start position, latencies, transpose, tempo, match %). Only real-time change:
   one lock-free journal append. Works on all desktop routes.
2. **Monitoring while the song plays, macOS first.** Lift the ALSA gate, add
   rate handling, ramped gain and limiter (from ADR 0010), shorten the delay,
   remove monitor exclusivity (`parkOutput`, `native_audio_ownership.h`), delete
   the Settings preview. Touches zCore (capture buffer-size request); Box must
   re-pin LoopZ to the same zCore. Then Windows via zCore's host.
3. Takes list per song with match %, "Add to song as track", phones.

## Lifted from the DAW tree (read-only, `daw-native-presentation-20261006`)

| Item | Action |
|---|---|
| `native/playback/presentation_history.*` + test | cherry-pick; wire at `native_playback_session.cpp` slice hook |
| `native/engine/record_clock.*` + test | cherry-pick; add graph latency |
| loopback/drift tools (`singz-audio-host.cpp`) | cherry-pick with measurement spike |
| input beside running output (zCore `audio_input_unit`) | cherry-pick into zCore when needed |
| take writer / recovery / FLAC encoder | re-implement small, reuse format |
| On/Auto/Off gate, record UI | re-implement; lift meter, options, strings |
| input bridge, session engine, recovery adapters | discard |

## Work packages (proposed)

| # | Package | Agent / model | Files | Done when |
|---|---|---|---|---|
| 0 | Spike: macOS + Windows field laptop, legal buffer ranges and round trip at 32/64/128/256 frames with a song playing | e2e-verifier; Codex `gpt-6.1-sol` for harness | dev-flag only | measured table recorded in singz-dev |
| 1a | Port presentation history + record clock + tests | Codex `gpt-6.1-sol` (timing-critical), Sonnet review | `native/playback/*`, tests | tests fail against a deliberate offset control |
| 1b | Take recorder + sidecar + local storage | Codex `gpt-reserve` medium, Sonnet review | `native/electron/*`, `src/main/*` | take longer than 30 s survives restart |
| 1c | Voice strip UI, i18n (EN, RU, zh-CN) | Claude Sonnet | `src/renderer/src/*`, `src/shared/i18n/*` | strip records/plays back in app |
| 2 | Monitoring client | Codex `gpt-6.1-sol`, Sonnet review | `native/playback/microphone_mix.*`, zCore pin | spike thresholds met on macOS |

## Open items

- Rate-1 take playback needs a read mode that does not exist; macOS capture
  reports no input latency (zCore fact or measured trim).
- Buffer size change is a route change (short dropout when monitoring starts).
- Windows: 32 frames depends on the driver's legal minimum; unverified.
- Built-in mic with speakers: warn or refuse? Owner has not decided.
